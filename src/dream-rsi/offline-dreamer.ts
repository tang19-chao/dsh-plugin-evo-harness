/**
 * Dream-RSI zero-execution offline dreaming replay.
 *
 * Ownership: src/dream-rsi/** (Wave 1, Dream-RSI layer).
 *
 * The dreamer takes cached historical discovery trees H_t and a set of
 * candidate meta-search policies pi^0..pi^{M-1}, then replays each policy purely
 * in memory (no model call, no sandbox) over the causal prefix that the policy
 * would actually have visited. For every budget preference
 * rho in {0, 0.25, 0.5, 0.75, 1} it computes a scalarized quality/cost utility
 * and aggregates them into a hypervolume-style score V.
 *
 * Monotonicity (ARCHITECTURE.md 5.2): the online scheduler is hot-swapped to
 * pi^{m*} only when V^{m*} > V^0 strictly; otherwise pi^0 is kept.
 *
 * Phase 4 dual loop (plan section 7.3): candidates now perturb the JitRL
 * hyperparameters carried by MetaSearchPolicy.jit, and replayTree accepts an
 * optional synchronous JitReplayHook that simulates JitRL per frontier node.
 * Both additions are strictly additive: a replay without a hook follows the
 * pre-change code path field for field, and the hook only ever sees the
 * causally truncated experience prefix (records created no later than the
 * replayed tree), so offline replay cannot observe its own future.
 *
 * Zero-execution honesty: a recovery probe cannot observe the post-repair
 * outcome, so replay charges it one probe and credits the failed node's
 * recorded score. Policies that spend recovery slots on trees where repair
 * never paid off therefore score lower, which is exactly the lesson the
 * offline optimizer is supposed to learn.
 */

import type {
  BatchSlotKind,
  DiscoveryNode,
  DiscoveryTreeSnapshot,
  DreamJitDiagnostics,
  DreamReplayReport,
  ExperienceRecord,
  IDiscoveryTreePool,
  IModelAdapter,
  IOfflineDreamer,
  JitReplayFrontierNode,
  JitReplayHook,
  JitReplayHookDiagnostics,
  JitReplayHookInput,
  JitReplayHookResult,
  MetaSearchPolicy,
  OfflineDreamRequest,
  PolicyEvaluation
} from '../types/contracts';
import { BATCH_SLOT_KINDS, DREAM_RHO_PREFERENCES } from '../types/contracts';
import { DEFAULT_EVO_HARNESS_CONFIG } from '../config';
import {
  REPLAY_GATE_BOUNDARY,
  decideReplayPublication,
  type ReplayPublicationDecision
} from '../jitrl/decision-kernel';
import {
  DEFAULT_SLOT_WEIGHTS,
  HARD_POLICY_LIMITS,
  SEARCH_SLOT_KINDS,
  normalizeSlotWeights,
  validatePolicy
} from './active-policy';

function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function clampInt(value: number, min: number, max: number): number {
  const lower = Math.ceil(min);
  const upper = Math.floor(max);
  const rounded = Math.round(Number.isFinite(value) ? value : lower);
  if (upper < lower) {
    return lower;
  }
  if (rounded < lower) {
    return lower;
  }
  if (rounded > upper) {
    return upper;
  }
  return rounded;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// JitRL hyperparameter perturbation and validation (plan section 7.3-1)
// ---------------------------------------------------------------------------

/** The jit hyperparameter record carried by a MetaSearchPolicy. */
export type JitHyperparams = NonNullable<MetaSearchPolicy['jit']>;

/** Kernel hyperparameters used when a policy carries no jit record. */
export function defaultJitHyperparams(): JitHyperparams {
  const jitrl = DEFAULT_EVO_HARNESS_CONFIG.jitrl;
  return {
    beta: jitrl.beta,
    lambda: jitrl.exploration.lambda,
    alpha: jitrl.exploration.alpha,
    k: jitrl.k,
    gamma: jitrl.gamma,
    similarityThreshold: jitrl.similarityThreshold
  };
}

/**
 * Structural validation of a jit hyperparameter record; empty means valid.
 *
 * `validatePolicy` is structure-only and deliberately ignores jit (that file is
 * frozen), so replay and candidate generation use this check to keep an invalid
 * hyperparameter record out of the policy set instead of silently dropping the
 * field.
 */
export function jitHyperparamIssues(jit: unknown): readonly string[] {
  if (jit === undefined) {
    return [];
  }
  if (typeof jit !== 'object' || jit === null || Array.isArray(jit)) {
    return ['jit must be a record'];
  }
  const record = jit as Record<string, unknown>;
  const issues: string[] = [];
  const bounded = (key: string, min: number, max: number): void => {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      issues.push('jit.' + key + ' must be a finite number');
      return;
    }
    if (value < min || (Number.isFinite(max) && value > max)) {
      issues.push(
        'jit.' +
          key +
          ' must be ' +
          (Number.isFinite(max)
            ? 'within [' + String(min) + ', ' + String(max) + ']'
            : '>= ' + String(min))
      );
    }
  };
  bounded('beta', 0, Number.POSITIVE_INFINITY);
  bounded('lambda', 0, 1);
  bounded('alpha', 0, Number.POSITIVE_INFINITY);
  bounded('gamma', 0, 1);
  bounded('similarityThreshold', 0, 1);
  const k = record.k;
  if (typeof k !== 'number' || !Number.isFinite(k) || k < 1 || Math.floor(k) !== k) {
    issues.push('jit.k must be a finite integer >= 1');
  }
  return issues;
}

/** One resolved jit record plus the per-field diagnostics that produced it. */
export interface JitResolution {
  readonly jit: JitHyperparams;
  readonly diagnostics: readonly string[];
}

/**
 * Coerce a raw jit record field by field, falling back to `fallback` and
 * recording a diagnostic for every value it could not accept. Never throws and
 * never returns an invalid record, so a malformed model proposal degrades to
 * the baseline hyperparameters instead of producing an illegal policy
 * (plan section 7.3-1: the model path must preserve and validate jit).
 */
export function sanitizeJitHyperparams(raw: unknown, fallback: JitHyperparams): JitResolution {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      jit: fallback,
      diagnostics: ['jit must be a record; baseline hyperparameters kept']
    };
  }
  const record = raw as Record<string, unknown>;
  const diagnostics: string[] = [];
  const pick = (
    key: keyof JitHyperparams,
    min: number,
    max: number,
    integer = false
  ): number => {
    const kept = fallback[key];
    const value = record[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      diagnostics.push('jit.' + key + ' must be a finite number; kept ' + String(kept));
      return kept;
    }
    if (value < min || (Number.isFinite(max) && value > max)) {
      diagnostics.push(
        'jit.' +
          key +
          ' must be ' +
          (Number.isFinite(max)
            ? 'within [' + String(min) + ', ' + String(max) + ']'
            : '>= ' + String(min)) +
          '; kept ' +
          String(kept)
      );
      return kept;
    }
    if (integer && Math.floor(value) !== value) {
      diagnostics.push(
        'jit.' + key + ' must be an integer; floored to ' + String(Math.floor(value))
      );
      return Math.floor(value);
    }
    return value;
  };
  const jit: JitHyperparams = {
    beta: pick('beta', 0, Number.POSITIVE_INFINITY),
    lambda: pick('lambda', 0, 1),
    alpha: pick('alpha', 0, Number.POSITIVE_INFINITY),
    k: pick('k', 1, Number.POSITIVE_INFINITY, true),
    gamma: pick('gamma', 0, 1),
    similarityThreshold: pick('similarityThreshold', 0, 1)
  };
  return { jit, diagnostics };
}

/**
 * Config subset that drives jit hyperparameter perturbation.
 *
 * P6 PR5 (plan section 7.2) narrows the swept dimensions to beta, k and
 * similarityThreshold: only those three have a demonstrated effect on the
 * *deterministic* part of the decision (temperature, neighbour budget, Jaccard
 * cut), which is what a replay can rank without the ranking following an RNG.
 * `candidateJitLambdas` is still accepted for backwards compatibility and still
 * reported on the grid, but it no longer drives candidate generation - see
 * POLICY_IGNORED_DIMENSIONS in src/jitrl/decision-kernel.ts.
 */
export interface JitPerturbationConfig {
  readonly hyperparamPerturbation?: boolean;
  readonly candidateJitBetas?: readonly number[];
  readonly candidateJitKs?: readonly number[];
  readonly candidateJitSimilarityThresholds?: readonly number[];
  /** @deprecated Not swept since P6 PR5; kept so old configs still load. */
  readonly candidateJitLambdas?: readonly number[];
}

/** Resolved perturbation grid; deterministic and never empty while enabled. */
export interface JitPerturbationGrid {
  readonly enabled: boolean;
  readonly betas: readonly number[];
  readonly ks: readonly number[];
  readonly similarityThresholds: readonly number[];
  /**
   * Legacy grid, retained for backwards compatibility and *not* consumed by
   * {@link generateCandidatePolicies} since P6 PR5. Present so a caller reading
   * the grid can report "this dimension is configured but ignored" instead of
   * silently losing the value.
   */
  readonly lambdas: readonly number[];
  /** Dimensions configured here but deliberately not swept, with the reason. */
  readonly ignored: readonly JitIgnoredDimension[];
}

/** One ignored dimension and why it is not swept (re-exported shape). */
export interface JitIgnoredDimension {
  readonly dimension: 'lambda' | 'alpha' | 'gamma';
  readonly reason: string;
}

/** Built-in perturbation grids, mirroring the frozen jitrl.dream defaults. */
export const DEFAULT_JIT_BETAS = [0.5, 1, 2] as const;
export const DEFAULT_JIT_KS = [5, 10, 20] as const;
export const DEFAULT_JIT_SIMILARITY_THRESHOLDS = [0.2, 0.3, 0.5] as const;
/** @deprecated Kept for config compatibility; no longer drives candidates. */
export const DEFAULT_JIT_LAMBDAS = [0.02, 0.05, 0.1] as const;

/**
 * Dimensions deliberately kept out of the search grid (plan section 7.2).
 *
 * Kept in step with POLICY_IGNORED_DIMENSIONS in src/jitrl/decision-kernel.ts;
 * duplicated here as a local constant so this module stays importable without
 * the JitRL kernel (offline-dreamer is also used by non-JitRL deployments).
 */
export const JIT_IGNORED_DIMENSIONS: readonly JitIgnoredDimension[] = [
  {
    dimension: 'lambda',
    reason:
      'not swept since P6 PR5: the exploration draw is a Bernoulli event per unsupported action, so candidate ranking would follow the seed; requires multi-seed averaging in replay first'
  },
  {
    dimension: 'alpha',
    reason:
      'not swept since P6 PR5: the optimism bonus only applies to unexplored actions, so its effect is indistinguishable from the exploration draw; pairs with lambda'
  },
  {
    dimension: 'gamma',
    reason:
      'frozen since P6 PR5: persisted returns were discounted with the previous gamma and carry no per-step reward series, so a gamma change cannot be recomputed; needs stored reward decomposition plus versioned recalculation'
  }
];

function finiteGrid(values: readonly number[] | undefined): readonly number[] {
  const out: number[] = [];
  for (const value of values ?? []) {
    if (Number.isFinite(value) && value >= 0 && !out.includes(value)) {
      out.push(value);
    }
  }
  return out;
}

function finiteIntegerGrid(values: readonly number[] | undefined): readonly number[] {
  const out: number[] = [];
  for (const value of values ?? []) {
    if (Number.isFinite(value) && value >= 1 && Math.floor(value) === value && !out.includes(value)) {
      out.push(value);
    }
  }
  return out;
}

/** Thresholds must stay inside [0, 1] because the retriever rejects anything else. */
function finiteUnitGrid(values: readonly number[] | undefined): readonly number[] {
  const out: number[] = [];
  for (const value of values ?? []) {
    if (Number.isFinite(value) && value >= 0 && value <= 1 && !out.includes(value)) {
      out.push(value);
    }
  }
  return out;
}

/**
 * Resolve the jit perturbation grid by candidate index: candidate i takes
 * betas[i % |betas|], ks[i % |ks|] and similarityThresholds[i % |thresholds|],
 * while alpha, gamma and lambda stay inherited from the baseline (plan section
 * 7.2). The swept triple is replaced as a whole and never merged element-wise
 * with the baseline record, so the candidate sequence is deterministic.
 *
 * `hyperparamPerturbation: false` disables perturbation; an empty or fully
 * invalid grid falls back to the built-in default grid for that dimension.
 */
export function resolveJitPerturbationGrid(
  config: JitPerturbationConfig = DEFAULT_EVO_HARNESS_CONFIG.jitrl.dream
): JitPerturbationGrid {
  const betas = finiteGrid(config.candidateJitBetas);
  const ks = finiteIntegerGrid(config.candidateJitKs);
  const thresholds = finiteUnitGrid(config.candidateJitSimilarityThresholds);
  // The legacy lambda grid is reported verbatim (or as the built-in default) but
  // is never consumed: keeping it visible is what makes "ignored" auditable.
  const lambdas = finiteUnitGrid(config.candidateJitLambdas);
  if (!(config.hyperparamPerturbation ?? true)) {
    return {
      enabled: false,
      betas: [],
      ks: [],
      similarityThresholds: [],
      lambdas: [],
      ignored: JIT_IGNORED_DIMENSIONS
    };
  }
  return {
    enabled: true,
    betas: betas.length > 0 ? betas : [...DEFAULT_JIT_BETAS],
    ks: ks.length > 0 ? ks : [...DEFAULT_JIT_KS],
    similarityThresholds:
      thresholds.length > 0 ? thresholds : [...DEFAULT_JIT_SIMILARITY_THRESHOLDS],
    lambdas: lambdas.length > 0 ? lambdas : [...DEFAULT_JIT_LAMBDAS],
    ignored: JIT_IGNORED_DIMENSIONS
  };
}

/** Validated jit record of a policy: its own when usable, else kernel defaults. */
function jitHyperparamsOf(policy: MetaSearchPolicy): JitHyperparams {
  if (policy.jit === undefined) {
    return defaultJitHyperparams();
  }
  return sanitizeJitHyperparams(policy.jit, defaultJitHyperparams()).jit;
}

/** Score credited to one historical node during replay. */
export function replayNodeScore(node: DiscoveryNode): number {
  if (node.score !== undefined && Number.isFinite(node.score)) {
    return clamp01(node.score);
  }
  if (node.status === 'succeeded') {
    return 0.5;
  }
  return 0;
}

/** Normalize, clamp and deduplicate budget preferences. */
export function normalizeRhoPreferences(
  values: readonly number[] | undefined
): readonly number[] {
  const out: number[] = [];
  for (const value of values ?? DREAM_RHO_PREFERENCES) {
    if (!Number.isFinite(value)) {
      continue;
    }
    const clamped = clamp01(value);
    if (!out.includes(clamped)) {
      out.push(clamped);
    }
  }
  out.sort((a, b) => a - b);
  return out.length > 0 ? out : [...DREAM_RHO_PREFERENCES];
}

/** Per-tree, per-rho replay outcome. */
export interface ReplayTreeOutcome {
  readonly treeId: string;
  readonly policyId: string;
  readonly rho: number;
  readonly probes: number;
  readonly cost: number;
  readonly quality: number;
  readonly visitedNodeIds: readonly string[];
  readonly earlyStopped: boolean;
  readonly evidence: readonly string[];
  /**
   * Additive (Phase 4): JitRL simulation diagnostics. Present only when a
   * JitReplayHook was injected, so a hook-free replay keeps the legacy shape.
   */
  readonly jitDiagnostics?: DreamJitDiagnostics;
}

/** Options for one tree replay. */
export interface ReplayTreeOptions {
  readonly costCeiling?: number;
  /**
   * Experience snapshot visible to the replay hook. Replay truncates it to the
   * tree's own past (record.createdAt <= tree.createdAt) before the hook sees
   * anything, so the hook can never observe the future even when the caller
   * hands over a wider snapshot (plan section 7.3-2).
   */
  readonly experiences?: readonly ExperienceRecord[];
  /** Synchronous, side-effect-free JitRL simulation injected into replay. */
  readonly jitHook?: JitReplayHook;
  /** Drift down-weight factor forwarded to the hook (config jitrl.dream.driftRho). */
  readonly driftRho?: number;
}

function childrenOfSnapshot(
  tree: DiscoveryTreeSnapshot,
  nodeId: string
): readonly DiscoveryNode[] {
  const node = tree.nodes[nodeId];
  if (node === undefined) {
    return [];
  }
  const out: DiscoveryNode[] = [];
  for (const childId of node.childIds) {
    const child = tree.nodes[childId];
    if (child !== undefined) {
      out.push(child);
    }
  }
  return out;
}

interface PriorityContext {
  readonly minCreatedAt: number;
  readonly maxCreatedAt: number;
  readonly weights: {
    readonly exploit: number;
    readonly explore_domain: number;
    readonly explore_invariant: number;
  };
}

interface PrioritySpan {
  readonly minCreatedAt: number;
  readonly maxCreatedAt: number;
}

function prioritySpan(tree: DiscoveryTreeSnapshot): PrioritySpan {
  let minCreatedAt = Number.POSITIVE_INFINITY;
  let maxCreatedAt = Number.NEGATIVE_INFINITY;
  for (const node of Object.values(tree.nodes)) {
    if (node.createdAt < minCreatedAt) {
      minCreatedAt = node.createdAt;
    }
    if (node.createdAt > maxCreatedAt) {
      maxCreatedAt = node.createdAt;
    }
  }
  return {
    minCreatedAt: Number.isFinite(minCreatedAt) ? minCreatedAt : 0,
    maxCreatedAt: Number.isFinite(maxCreatedAt) ? maxCreatedAt : 0
  };
}

function contextFromWeights(
  span: PrioritySpan,
  slotWeights: Readonly<Record<BatchSlotKind, number>>
): PriorityContext {
  let total = 0;
  for (const kind of SEARCH_SLOT_KINDS) {
    total += slotWeights[kind] ?? 0;
  }
  const share = (kind: BatchSlotKind): number =>
    total > 0 ? (slotWeights[kind] ?? 0) / total : 1 / SEARCH_SLOT_KINDS.length;
  return {
    minCreatedAt: span.minCreatedAt,
    maxCreatedAt: span.maxCreatedAt,
    weights: {
      exploit: share('exploit'),
      explore_domain: share('explore_domain'),
      explore_invariant: share('explore_invariant')
    }
  };
}

function buildPriorityContext(
  tree: DiscoveryTreeSnapshot,
  slotWeights: Readonly<Record<BatchSlotKind, number>>
): PriorityContext {
  return contextFromWeights(prioritySpan(tree), slotWeights);
}

function frontierPriority(node: DiscoveryNode, context: PriorityContext): number {
  const span = context.maxCreatedAt - context.minCreatedAt;
  const recency =
    span > 0 ? 1 - (node.createdAt - context.minCreatedAt) / span : 1;
  const score = replayNodeScore(node);
  const domain = node.patchOrigin === 'domain' ? 1 : 0;
  const invariant =
    node.guidance === 'guidance_free' || node.patchOrigin === 'invariant' ? 1 : 0;
  return (
    context.weights.exploit * score +
    context.weights.explore_domain * (0.5 * domain + 0.5 * recency) +
    context.weights.explore_invariant * (0.5 * invariant + 0.5 * recency)
  );
}

function orderFrontier(
  frontier: readonly DiscoveryNode[],
  context: PriorityContext
): readonly DiscoveryNode[] {
  return [...frontier].sort((a, b) => {
    const delta = frontierPriority(b, context) - frontierPriority(a, context);
    if (delta !== 0) {
      return delta;
    }
    if (a.createdAt !== b.createdAt) {
      return a.createdAt - b.createdAt;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function firstRepairableFailedNode(
  tree: DiscoveryTreeSnapshot
): DiscoveryNode | undefined {
  let candidate: DiscoveryNode | undefined;
  for (const node of Object.values(tree.nodes)) {
    if (node.status !== 'failed') {
      continue;
    }
    if (node.failure === undefined || !node.failure.repairable) {
      continue;
    }
    if (candidate === undefined || node.updatedAt > candidate.updatedAt) {
      candidate = node;
    }
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// PR-4B (ADR 0004 §4): Dreamer independent holdout split
// ---------------------------------------------------------------------------

/**
 * Group key for the holdout split (ADR 0004 §4.3-1).
 *
 * A discovery tree belongs to exactly one task. Grouping by `taskId` first is
 * what makes the split a TASK split: every subtree of one task lands wholly in
 * the selection set or wholly in the holdout, so a candidate can never be
 * selected on one half of a task and validated on the other. `sessionId` is the
 * fallback for snapshots that carry no task id, and `id` is the last resort so a
 * single tree is always self-consistent.
 *
 * `testSetId` from the plan is deliberately NOT used here: it does not exist on
 * `DiscoveryTreeSnapshot` (see src/types/contracts.ts:1042) and inventing it
 * would mean reaching into `metadata` - a field the split must not depend on.
 */
export function holdoutGroupKey(tree: DiscoveryTreeSnapshot): string {
  const taskId = typeof tree.taskId === 'string' ? tree.taskId.trim() : '';
  if (taskId.length > 0) {
    return 'task:' + taskId;
  }
  const sessionId = typeof tree.sessionId === 'string' ? tree.sessionId.trim() : '';
  if (sessionId.length > 0) {
    return 'session:' + sessionId;
  }
  return 'tree:' + tree.id;
}

/** Stable creation stamp used by the temporal ordering rule; non-finite folds to 0. */
function holdoutStamp(tree: DiscoveryTreeSnapshot): number {
  return Number.isFinite(tree.createdAt) ? tree.createdAt : 0;
}

/** Stable key ordering so the split is a pure function of its input. */
function compareHoldoutGroups(left: HoldoutGroup, right: HoldoutGroup): number {
  if (left.newest !== right.newest) {
    return left.newest - right.newest;
  }
  if (left.oldest !== right.oldest) {
    return left.oldest - right.oldest;
  }
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

interface HoldoutGroup {
  readonly key: string;
  readonly trees: readonly DiscoveryTreeSnapshot[];
  readonly oldest: number;
  readonly newest: number;
  readonly size: number;
}

/** Group the pool by group key, keeping each group's trees in the caller's order. */
function groupTreesForHoldout(
  trees: readonly DiscoveryTreeSnapshot[]
): readonly HoldoutGroup[] {
  const buckets = new Map<string, DiscoveryTreeSnapshot[]>();
  for (const tree of trees) {
    const key = holdoutGroupKey(tree);
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, [tree]);
    } else {
      bucket.push(tree);
    }
  }
  const groups: HoldoutGroup[] = [];
  for (const [key, bucket] of buckets) {
    let oldest = Number.POSITIVE_INFINITY;
    let newest = Number.NEGATIVE_INFINITY;
    for (const tree of bucket) {
      const at = holdoutStamp(tree);
      if (at < oldest) {
        oldest = at;
      }
      if (at > newest) {
        newest = at;
      }
    }
    groups.push({
      key,
      trees: bucket,
      oldest: Number.isFinite(oldest) ? oldest : 0,
      newest: Number.isFinite(newest) ? newest : 0,
      size: bucket.length
    });
  }
  return groups.sort(compareHoldoutGroups);
}

/**
 * Outcome of the pre-generation split. `status` is the machine-readable
 * insufficient-evidence verdict from ADR 0004 §4.4; `ok` is the only status that
 * permits a holdout validation to be attempted at all.
 */
export type DreamerSplitStatus =
  | 'ok'
  | 'no-holdout-configured'
  | 'insufficient-selection-trees'
  | 'insufficient-holdout-trees'
  | 'insufficient-holdout-groups'
  | 'insufficient-temporal-isolation';

/** Diagnostics of one pre-generation split; travels with the shadow record. */
export interface DreamerHoldoutSplit {
  /** Shelf into which the split resolved (ADR 0004 §4.4 truth table). */
  readonly status: DreamerSplitStatus;
  /** Trees candidates may be generated from and selected on. */
  readonly selectionTrees: readonly DiscoveryTreeSnapshot[];
  /**
   * Trees reserved for the winner-only validation pass.
   *
   * Empty on EVERY fail-closed verdict - including an undersized holdout
   * (`insufficient-holdout-trees`, where `diagnostics.holdoutCount` still reports
   * the supply that was refused) - so a caller cannot mistake a withheld set for a
   * usable one.
   */
  readonly holdoutTrees: readonly DiscoveryTreeSnapshot[];
  /** False for every status other than 'ok'. */
  readonly hasSufficientEvidence: boolean;
  readonly diagnostics: {
    readonly totalTrees: number;
    readonly selectionCount: number;
    /**
     * Trees the cut could actually supply for validation. Equal to
     * `holdoutTrees.length` whenever the verdict is 'ok'; on a fail-closed verdict
     * it reports the supply that was OBSERVED and refused (0 when no admissible
     * cut exists), so an auditor can tell "the pool offered 3 of the 5 requested"
     * from "the pool offered nothing" without re-running the split.
     */
    readonly holdoutCount: number;
    readonly requestedHoldoutCount: number;
    /**
     * How far the request is from being met: `max(0, requested - holdoutCount)`.
     *
     * A non-zero value is exactly the "silent shrink" this configuration forbids,
     * reported instead of performed: the verdict is 'insufficient-holdout-trees'
     * and `holdoutTrees` is emptied, so nothing can ever be validated on a smaller
     * set than the operator asked for.
     */
    readonly holdoutShortfall: number;
    readonly selectionGroups: number;
    readonly holdoutGroups: number;
    /** Newest selection stamp; must not exceed `holdoutOldest` for a valid split. */
    readonly selectionNewest: number;
    /** Oldest holdout stamp; the temporal isolation witness. */
    readonly holdoutOldest: number;
    /**
     * Whether the selection set meets the ADR's RECOMMENDED size (N_sel >= 2).
     * Advisory only - see RECOMMENDED_MIN_SELECTION_TREES for why it is reported
     * instead of enforced.
     */
    readonly selectionMeetsRecommendedMinimum: boolean;
  };
}

/** Minimum holdout trees (ADR 0004 §4.4: N_hold >= 1). */
export const MIN_HOLDOUT_TREES = 1;
/** Minimum independent holdout groups (ADR 0004 §4.4: G_hold >= 1). */
export const MIN_HOLDOUT_GROUPS = 1;
/**
 * The ADR's RECOMMENDED selection size (N_sel >= 2).
 *
 * Deliberately advisory, not a refusal floor. Two trees with distinct task ids
 * are the smallest split that exercises the authorized positive control (1
 * selection + 1 holdout), and that control is the evidence the C1.1 gate is
 * reachable at all; refusing every 1-tree selection set would make the gate
 * unprovable without changing the C1.1 contract. The hard refusal floors are the
 * ones that make the split meaningless: an empty holdout, no independent holdout
 * group, or an empty selection set.
 *
 * A caller that wants the recommendation enforced reads
 * `split.diagnostics.selectionMeetsRecommendedMinimum` and decides for itself.
 */
export const RECOMMENDED_MIN_SELECTION_TREES = 2;

/**
 * Pre-generation split (ADR 0004 §4.1/§4.3/§4.4).
 *
 * Contract properties this function is responsible for:
 *   1. **It runs before any generation.** It is a pure function of the pool, so
 *      the caller can (and must) invoke it before `generatePolicies`. No summary
 *      statistic of the holdout is returned for the generator to consume: only
 *      counts, and counts are computed from the pool, not from the holdout's
 *      scored content.
 *   2. **Group isolation.** Whole groups move together; a task can never be split.
 *   3. **Temporal isolation.** Groups are ordered oldest-first and the holdout is
 *      taken from the newest end, so
 *      `max(selection.createdAt) <= min(holdout.createdAt)` by construction.
 *   4. **Insufficient evidence is a fail-closed verdict, not a silent shrink.**
 *      When the request cannot be met the status names why and `hasSufficientEvidence`
 *      is false; the dreamer then never publishes. The requested size is a FLOOR,
 *      not a hint: a pool that can only supply fewer than `holdoutTreeCount` trees
 *      is `insufficient-holdout-trees`, never `ok` with a smaller holdout.
 *      Overshoot is allowed and is not a shrink - whole groups move together, so
 *      the newest group may satisfy a request for fewer trees than it holds.
 *
 * `holdoutTreeCount === 0` means "no holdout configured": the whole pool is the
 * selection set and the status says so, which keeps the pre-PR-4B path intact.
 */
export function splitDreamerHoldout(
  trees: readonly DiscoveryTreeSnapshot[],
  holdoutTreeCount: number
): DreamerHoldoutSplit {
  const requested = Math.max(0, Math.floor(finiteOr(holdoutTreeCount, 0)));
  const groups = groupTreesForHoldout(trees);
  const empty = {
    totalTrees: trees.length,
    selectionCount: trees.length,
    holdoutCount: 0,
    requestedHoldoutCount: requested,
    holdoutShortfall: requested,
    selectionGroups: groups.length,
    holdoutGroups: 0,
    selectionNewest: 0,
    holdoutOldest: 0,
    selectionMeetsRecommendedMinimum: trees.length >= RECOMMENDED_MIN_SELECTION_TREES
  };
  if (requested === 0) {
    return {
      status: 'no-holdout-configured',
      selectionTrees: trees,
      holdoutTrees: [],
      hasSufficientEvidence: false,
      diagnostics: {
        ...empty,
        selectionNewest: groups.reduce(
          (max, group) => (max > group.newest ? max : group.newest),
          0
        )
      }
    };
  }
  // A holdout must be a DIFFERENT group from the selection set. With fewer than
  // two groups the pool cannot be group-split at all, and no amount of choosing
  // would help: report the group shortfall rather than blaming time.
  if (groups.length < 2) {
    return {
      status: 'insufficient-holdout-groups',
      selectionTrees: trees,
      holdoutTrees: [],
      hasSufficientEvidence: false,
      diagnostics: {
        ...empty,
        selectionNewest: groups.reduce(
          (max, group) => (max > group.newest ? max : group.newest),
          0
        )
      }
    };
  }
  // Choose the split as a CUT over the groups sorted by recency: the tail (newest
  // groups) becomes the holdout, the head (older groups) the selection set.
  //
  // Taking whole groups gives group isolation. Taking the newest groups does NOT
  // automatically give temporal isolation: if one task's trees span a wide window
  // (a long-running task whose subtrees were recorded over hours), a newer
  // group's `oldest` can precede an older group's `newest`, and the naive "last N
  // groups" cut then puts a future tree into the selection set (ADR 0004 §4.3-2
  // forbids exactly that: "严禁将未来的轨迹放入选择集去拟合过去").
  //
  // So the cut is validated rather than assumed: a cut is admissible only when
  // `max(selection.createdAt) <= min(holdout.createdAt)`. Among admissible cuts we
  // prefer the SMALLEST holdout that still covers the request (it keeps the most
  // selection data); if none covers the request we keep the largest admissible one
  // and let the truth table below report the shortfall; if none is admissible at
  // all the split fails closed as `insufficient-temporal-isolation`.
  let chosenHoldoutTrees: readonly DiscoveryTreeSnapshot[] = [];
  let chosenSelectionTrees: readonly DiscoveryTreeSnapshot[] = trees;
  for (let cut = 1; cut < groups.length; cut += 1) {
    const tail = groups.slice(groups.length - cut);
    const head = groups.slice(0, groups.length - cut);
    const tailTrees: DiscoveryTreeSnapshot[] = [];
    for (const group of tail) {
      for (const tree of group.trees) {
        tailTrees.push(tree);
      }
    }
    if (tailTrees.length >= trees.length) {
      continue;
    }
    const headNewest = head.reduce(
      (max, group) => (max > group.newest ? max : group.newest),
      0
    );
    const tailOldest = tail.reduce(
      (min, group) => (min < group.oldest ? min : group.oldest),
      Number.POSITIVE_INFINITY
    );
    if (!(headNewest <= tailOldest)) {
      // A task straddles the cut: this cut would leak the future into selection.
      continue;
    }
    const tailKeys = new Set(tail.map((group) => group.key));
    chosenHoldoutTrees = tailTrees;
    chosenSelectionTrees = trees.filter((tree) => !tailKeys.has(holdoutGroupKey(tree)));
    if (tailTrees.length >= requested) {
      break;
    }
  }
  if (chosenHoldoutTrees.length === 0) {
    // No cut isolates the groups in time. Fail closed: a statistically "valid"
    // split that trains on the future is worse than no split at all.
    return {
      status: 'insufficient-temporal-isolation',
      selectionTrees: trees,
      holdoutTrees: [],
      hasSufficientEvidence: false,
      diagnostics: {
        ...empty,
        selectionNewest: groups.reduce(
          (max, group) => (max > group.newest ? max : group.newest),
          0
        )
      }
    };
  }
  const holdoutKeys = new Set(chosenHoldoutTrees.map((tree) => holdoutGroupKey(tree)));
  const holdoutGroups = groups.filter((group) => holdoutKeys.has(group.key));
  const holdoutTrees = [...chosenHoldoutTrees];
  const selectionTrees = [...chosenSelectionTrees];
  const selectionGroups = groups.length - holdoutGroups.length;
  const selectionNewest = selectionTrees.reduce(
    (max, tree) => (max > holdoutStamp(tree) ? max : holdoutStamp(tree)),
    0
  );
  const holdoutOldest = holdoutTrees.reduce(
    (min, tree) => (min < holdoutStamp(tree) ? min : holdoutStamp(tree)),
    Number.POSITIVE_INFINITY
  );
  const diagnostics = {
    totalTrees: trees.length,
    selectionCount: selectionTrees.length,
    holdoutCount: holdoutTrees.length,
    requestedHoldoutCount: requested,
    holdoutShortfall: Math.max(0, requested - holdoutTrees.length),
    selectionGroups,
    holdoutGroups: holdoutGroups.length,
    selectionNewest,
    holdoutOldest: Number.isFinite(holdoutOldest) ? holdoutOldest : 0,
    selectionMeetsRecommendedMinimum: selectionTrees.length >= RECOMMENDED_MIN_SELECTION_TREES
  };
  // §4.4 truth table. Evaluated in a fixed order so the reported status is the
  // FIRST unmet HARD requirement rather than an incidental one. The hard floors
  // are "the split is meaningless": the pool could not actually be divided.
  // `selectionMeetsRecommendedMinimum` is reported separately because the ADR
  // marks N_sel >= 2 as a recommendation (see RECOMMENDED_MIN_SELECTION_TREES).
  //
  // The holdout count has TWO hard floors and the higher one wins:
  //   - MIN_HOLDOUT_TREES (N_hold >= 1, the ADR's non-emptiness floor), and
  //   - the caller's explicit `requested` (the configured opt-in).
  //
  // The second floor is the runtime half of the config rule "never silently
  // shrink" (src/config.ts validateHoldoutTreeCount rejects a request the
  // configured pool bound cannot satisfy; the runtime pool can still be smaller
  // than that bound). Without it, a request of 5 against a pool whose newest
  // group holds 3 trees would hand back the largest admissible cut - 3 trees -
  // and report `ok` / `hasSufficientEvidence: true` for a validation set 40%
  // smaller than the operator asked for. The dreamer would then treat that
  // undersized holdout as evidence. Fail closed instead, and keep the observed
  // supply in `diagnostics.holdoutCount` / `diagnostics.holdoutShortfall` so the
  // refusal is auditable rather than mysterious.
  //
  // Overshoot stays `ok`: whole groups move together, so a 2-tree group legitimately
  // satisfies a request of 1. Only an undersized holdout is refused.
  if (holdoutTrees.length < Math.max(MIN_HOLDOUT_TREES, requested)) {
    return {
      status: 'insufficient-holdout-trees',
      selectionTrees,
      holdoutTrees: [],
      hasSufficientEvidence: false,
      diagnostics
    };
  }
  if (holdoutGroups.length < MIN_HOLDOUT_GROUPS) {
    return {
      status: 'insufficient-holdout-groups',
      selectionTrees,
      holdoutTrees: [],
      hasSufficientEvidence: false,
      diagnostics
    };
  }
  if (selectionTrees.length === 0) {
    return {
      status: 'insufficient-selection-trees',
      selectionTrees,
      holdoutTrees: [],
      hasSufficientEvidence: false,
      diagnostics
    };
  }
  return {
    status: 'ok',
    selectionTrees,
    holdoutTrees,
    hasSufficientEvidence: true,
    diagnostics
  };
}


/** Causal cutoff used by replay: a tree may only see experience from its past. */
export function causalCutoffFor(tree: DiscoveryTreeSnapshot): number {
  return Number.isFinite(tree.createdAt) ? tree.createdAt : 0;
}

/**
 * Causally truncate an experience snapshot (plan section 7.3-2): only records
 * with `createdAt <= causalCutoff` are visible, so offline replay can never
 * observe the future. The cutoff is inclusive, the caller's order is preserved
 * and records with a non-finite timestamp are dropped. The returned array is a
 * fresh copy, so a hook cannot mutate the caller's snapshot through it.
 */
export function causalExperienceSnapshot(
  experiences: readonly ExperienceRecord[] | undefined,
  causalCutoff: number
): readonly ExperienceRecord[] {
  if (experiences === undefined) {
    return [];
  }
  const out: ExperienceRecord[] = [];
  for (const record of experiences) {
    if (!Number.isFinite(record.createdAt) || record.createdAt > causalCutoff) {
      continue;
    }
    out.push(record);
  }
  return out;
}

/** Mutable accumulator behind the per-replay DreamJitDiagnostics. */
interface JitHookAccumulator {
  calls: number;
  neighbors: number;
  klSum: number;
  stateValueSum: number;
  degraded: boolean;
}

interface JitReplayContext {
  readonly hook: JitReplayHook;
  readonly tree: DiscoveryTreeSnapshot;
  readonly policy: MetaSearchPolicy;
  readonly jit: JitHyperparams;
  readonly rho: number;
  readonly driftRho: number;
  readonly priorWeights: Readonly<Record<BatchSlotKind, number>>;
  readonly experiences: readonly ExperienceRecord[];
  readonly accumulator: JitHookAccumulator;
}

interface FrontierScore {
  readonly node: DiscoveryNode;
  readonly priority: number;
}

interface FrontierHookOutcome {
  readonly degraded: boolean;
  readonly reason: string;
  readonly ordered: readonly DiscoveryNode[];
  readonly lastWeights: Readonly<Record<BatchSlotKind, number>>;
}

interface JitHookCall {
  readonly weights: Readonly<Record<BatchSlotKind, number>>;
  readonly diagnostics: JitReplayHookDiagnostics | undefined;
  readonly degraded: boolean;
  readonly reason: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

/**
 * A hook weight vector is usable only when all four slot kinds are finite,
 * non-negative and not all zero. Anything else is a degradation, never a value
 * to silently clamp: replay keeps the prior weights instead.
 */
function usableHookWeights(
  value: unknown
): Readonly<Record<BatchSlotKind, number>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const out: Record<BatchSlotKind, number> = {
    exploit: 0,
    explore_domain: 0,
    explore_invariant: 0,
    recover: 0
  };
  let total = 0;
  for (const kind of BATCH_SLOT_KINDS) {
    const raw = record[kind];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
      return null;
    }
    out[kind] = raw;
    total += raw;
  }
  return total > 0 ? out : null;
}

/**
 * Invoke the hook once. The hook is synchronous by contract, so a thrown error,
 * a thenable or a malformed result all degrade to the unchanged prior weights
 * with a human-readable reason instead of poisoning the replay.
 */
function invokeJitHook(hook: JitReplayHook, input: JitReplayHookInput): JitHookCall {
  let raw: unknown;
  try {
    raw = hook(input);
  } catch (error) {
    return {
      weights: input.slotWeights,
      diagnostics: undefined,
      degraded: true,
      reason: 'hook threw: ' + errorMessage(error)
    };
  }
  if (typeof raw !== 'object' || raw === null) {
    return {
      weights: input.slotWeights,
      diagnostics: undefined,
      degraded: true,
      reason: 'hook returned no result object'
    };
  }
  if (typeof (raw as { then?: unknown }).then === 'function') {
    return {
      weights: input.slotWeights,
      diagnostics: undefined,
      degraded: true,
      reason: 'hook returned a thenable; replay is synchronous'
    };
  }
  const result = raw as Partial<JitReplayHookResult>;
  const weights = usableHookWeights(result.slotWeights);
  if (weights === null) {
    return {
      weights: input.slotWeights,
      diagnostics: undefined,
      degraded: true,
      reason: 'hook returned invalid slot weights'
    };
  }
  const diagnostics = result.diagnostics;
  if (typeof diagnostics !== 'object' || diagnostics === null) {
    return {
      weights: input.slotWeights,
      diagnostics: undefined,
      degraded: true,
      reason: 'hook returned no diagnostics'
    };
  }
  return { weights, diagnostics, degraded: false, reason: '' };
}

/** Frontier-node view handed to the hook; only fields replay already exposes. */
function frontierNodeView(node: DiscoveryNode, depth: number): JitReplayFrontierNode {
  return {
    nodeId: node.id,
    depth,
    patchOrigin: node.patchOrigin,
    purpose: node.purpose,
    guidance: node.guidance,
    createdAt: node.createdAt,
    ...(node.slot === undefined ? {} : { slot: node.slot }),
    ...(node.score === undefined ? {} : { score: node.score })
  };
}

function compareFrontierScore(a: FrontierScore, b: FrontierScore): number {
  const delta = b.priority - a.priority;
  if (delta !== 0) {
    return delta;
  }
  if (a.node.createdAt !== b.node.createdAt) {
    return a.node.createdAt - b.node.createdAt;
  }
  return a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0;
}

/**
 * Order one frontier with the JitRL replay hook.
 *
 * Every frontier node gets exactly one hook call before the layer is ordered:
 * the hook corrects that node's slot weights and the corrected vector feeds the
 * node's priority, so a hook that sharpens the portfolio actually changes which
 * branch the replayed policy follows.
 *
 * Degradation is layer-atomic: if any call in the layer throws, returns a
 * thenable or returns an unusable weight vector, the whole layer is discarded
 * and the caller falls back to the unchanged pre-hook ordering. The hook itself
 * never sees the future: `context.experiences` is already causally truncated.
 */
function orderFrontierWithJitHook(
  context: JitReplayContext,
  frontier: readonly DiscoveryNode[]
): FrontierHookOutcome {
  const span = prioritySpan(context.tree);
  const scored: FrontierScore[] = [];
  let lastWeights: Readonly<Record<BatchSlotKind, number>> = context.priorWeights;
  for (const node of frontier) {
    const input: JitReplayHookInput = {
      treeId: context.tree.id,
      policyId: context.policy.id,
      rho: context.rho,
      slotWeights: context.priorWeights,
      frontier: frontierNodeView(node, node.depth),
      experiences: context.experiences,
      jit: context.jit,
      driftRho: context.driftRho
    };
    const call = invokeJitHook(context.hook, input);
    if (call.degraded) {
      return {
        degraded: true,
        reason: call.reason,
        ordered: [],
        lastWeights: context.priorWeights
      };
    }
    const diagnostics = call.diagnostics;
    if (diagnostics === undefined) {
      return {
        degraded: true,
        reason: 'hook returned no diagnostics',
        ordered: [],
        lastWeights: context.priorWeights
      };
    }
    context.accumulator.calls += 1;
    context.accumulator.neighbors += Math.max(
      0,
      Math.floor(finiteOr(diagnostics.neighborCount, 0))
    );
    context.accumulator.klSum += finiteOr(diagnostics.klToPrior, 0);
    context.accumulator.stateValueSum += finiteOr(diagnostics.stateValue, 0);
    scored.push({
      node,
      priority: frontierPriority(node, contextFromWeights(span, call.weights))
    });
    lastWeights = call.weights;
  }
  scored.sort(compareFrontierScore);
  return {
    degraded: false,
    reason: '',
    ordered: scored.map((entry) => entry.node),
    lastWeights
  };
}

interface DreamJitDiagnosticsInput {
  readonly treeId: string;
  readonly policyId: string;
  readonly accumulator: JitHookAccumulator;
  readonly driftRho: number;
  readonly causalCutoff: number;
  readonly evidence: readonly string[];
}

function buildDreamJitDiagnostics(
  input: DreamJitDiagnosticsInput
): DreamJitDiagnostics {
  const calls = input.accumulator.calls;
  return {
    treeId: input.treeId,
    policyId: input.policyId,
    hookCalls: calls,
    neighborsUsed: input.accumulator.neighbors,
    meanKlToPrior: calls > 0 ? input.accumulator.klSum / calls : 0,
    meanStateValue: calls > 0 ? input.accumulator.stateValueSum / calls : 0,
    driftRho: input.driftRho,
    causalCutoff: input.causalCutoff,
    degraded: input.accumulator.degraded,
    evidence: [...input.evidence]
  };
}

/**
 * Replay one historical tree under one policy at one budget preference rho.
 * Pure in-memory: only recorded node scores/statuses are consulted, and the
 * whole function is synchronous (a JitReplayHook may not await, perform I/O or
 * mutate its input).
 *
 * Level semantics: the root is the already-probed reference that every policy
 * inherits, so it is visited first, for free, and is not charged to the
 * candidate budget. `depth` then counts candidate layers below the root -
 * layer 1 is the root's children, layer 2 their children, and so on. Each layer
 * scores and expands at most `width` ordered nodes, children are expanded from
 * the selected nodes only, and the whole replay spends at most width * depth
 * candidate probes. depth=1 therefore reaches the first candidate layer, and a
 * width=1 policy follows a single branch downwards instead of exhausting a
 * sibling layer.
 *
 * Causal truncation (plan section 7.3-2): when a JitReplayHook is injected, the
 * experience snapshot is cut to `record.createdAt <= tree.createdAt` before any
 * hook call, so the simulation only ever sees the tree's own past.
 */
export function replayTree(
  tree: DiscoveryTreeSnapshot,
  policy: MetaSearchPolicy,
  rho: number,
  options: ReplayTreeOptions = {}
): ReplayTreeOutcome {
  const preference = clamp01(rho);
  const evidence: string[] = [];
  const root = tree.nodes[tree.rootId];
  if (root === undefined) {
    return {
      treeId: tree.id,
      policyId: policy.id,
      rho: preference,
      probes: 0,
      cost: 0,
      quality: 0,
      visitedNodeIds: [],
      earlyStopped: false,
      evidence: ['tree has no root node; skipped']
    };
  }
  const hook = options.jitHook;
  const driftRho = clamp01(
    finiteOr(
      options.driftRho ?? DEFAULT_EVO_HARNESS_CONFIG.jitrl.dream.driftRho,
      DEFAULT_EVO_HARNESS_CONFIG.jitrl.dream.driftRho
    )
  );
  const causalCutoff = causalCutoffFor(tree);
  const jit = jitHyperparamsOf(policy);
  const experiences = causalExperienceSnapshot(options.experiences, causalCutoff);
  const accumulator: JitHookAccumulator = {
    calls: 0,
    neighbors: 0,
    klSum: 0,
    stateValueSum: 0,
    degraded: false
  };
  const jitEvidence: string[] = [];
  let jitDisabled = hook === undefined;
  let correctedWeights: Readonly<Record<BatchSlotKind, number>> | undefined;

  const fullWidth = Math.max(1, Math.floor(finiteOr(policy.maxWidth, 1)));
  const fullDepth = Math.max(1, Math.floor(finiteOr(policy.maxDepth, 1)));
  const width = clampInt(fullWidth * (0.5 + 0.5 * preference), 1, fullWidth);
  const depth = clampInt(fullDepth * (0.5 + 0.5 * preference), 1, fullDepth);
  const budget = Math.max(1, width * depth);
  const slotWeights = normalizeSlotWeights(policy.slotWeights);
  const context = buildPriorityContext(tree, slotWeights);
  const stopThreshold = clamp01(policy.earlyStopThreshold);
  const visited: string[] = [];
  const seen = new Set<string>();
  let quality = 0;
  let earlyStopped = false;
  let probes = 0;

  // The root is the reference run every policy inherits: visit it first and leave
  // it out of the candidate budget.
  seen.add(root.id);
  visited.push(root.id);
  quality = replayNodeScore(root);
  earlyStopped = quality >= stopThreshold;
  let frontier: readonly DiscoveryNode[] = earlyStopped
    ? []
    : childrenOfSnapshot(tree, root.id).filter((child) => !seen.has(child.id));

  for (let layer = 1; layer <= depth && !earlyStopped && probes < budget; layer += 1) {
    if (frontier.length === 0) {
      break;
    }
    let selected: readonly DiscoveryNode[];
    if (jitDisabled || hook === undefined) {
      selected = orderFrontier(frontier, context).slice(0, width);
    } else {
      const outcome = orderFrontierWithJitHook(
        {
          hook,
          tree,
          policy,
          jit,
          rho: preference,
          driftRho,
          priorWeights: slotWeights,
          experiences,
          accumulator
        },
        frontier
      );
      if (outcome.degraded) {
        jitDisabled = true;
        accumulator.degraded = true;
        jitEvidence.push(
          'jit replay hook degraded at layer ' +
            String(layer) +
            ': ' +
            outcome.reason +
            '; the layer keeps the pre-hook slot weights'
        );
        selected = orderFrontier(frontier, context).slice(0, width);
      } else {
        correctedWeights = outcome.lastWeights;
        selected = outcome.ordered.slice(0, width);
      }
    }
    const expanded: DiscoveryNode[] = [];
    for (const node of selected) {
      if (probes >= budget) {
        break;
      }
      if (seen.has(node.id)) {
        continue;
      }
      seen.add(node.id);
      visited.push(node.id);
      probes += 1;
      const score = replayNodeScore(node);
      if (score > quality) {
        quality = score;
      }
      if (quality >= stopThreshold) {
        earlyStopped = true;
        break;
      }
      expanded.push(node);
    }
    if (earlyStopped || probes >= budget) {
      break;
    }
    // Children are expanded only from the nodes this layer actually selected.
    const next: DiscoveryNode[] = [];
    for (const node of expanded) {
      for (const child of childrenOfSnapshot(tree, node.id)) {
        if (!seen.has(child.id)) {
          next.push(child);
        }
      }
    }
    frontier = next;
  }

  // An early stop means the policy already reached its quality threshold, so it
  // must not be charged an extra phantom probe beyond the stop decision. A hook
  // that corrected the portfolio also gets to correct the recovery share; with
  // no hook (or a degraded one) these are exactly the policy weights.
  const recoveryWeights = correctedWeights ?? slotWeights;
  const recoveryWeight = recoveryWeights.recover;
  if (!earlyStopped && recoveryWeight > 0 && probes < budget) {
    const failed = firstRepairableFailedNode(tree);
    if (failed !== undefined && !seen.has(failed.id)) {
      seen.add(failed.id);
      visited.push(failed.id);
      probes += 1;
      const score = replayNodeScore(failed);
      if (score > quality) {
        quality = score;
      }
      evidence.push(
        'recovery probe charged on ' +
          failed.id +
          ' (recorded score ' +
          score.toFixed(4) +
          ', post-repair outcome unknown offline)'
      );
    }
  }

  const cost = probes;
  evidence.push(
    'rho=' +
      preference.toFixed(2) +
      ' width=' +
      String(width) +
      ' depth=' +
      String(depth) +
      ' budget=' +
      String(budget) +
      ' candidateProbes=' +
      String(cost) +
      ' visited=' +
      String(visited.length) +
      ' quality=' +
      quality.toFixed(4) +
      (earlyStopped ? ' early_stopped=true' : '')
  );
  const ceiling = Math.max(1, finiteOr(options.costCeiling ?? 1, 1));
  evidence.push('normalizedCost=' + Math.min(1, cost / ceiling).toFixed(4));

  let jitDiagnostics: DreamJitDiagnostics | undefined;
  if (hook !== undefined) {
    const calls = accumulator.calls;
    jitEvidence.push(
      'jit replay hook: calls=' +
        String(calls) +
        ' neighbors=' +
        String(accumulator.neighbors) +
        ' meanV=' +
        (calls > 0 ? accumulator.stateValueSum / calls : 0).toFixed(4) +
        ' meanKl=' +
        (calls > 0 ? accumulator.klSum / calls : 0).toFixed(4) +
        ' driftRho=' +
        driftRho.toFixed(2) +
        ' causalCutoff=' +
        String(causalCutoff) +
        (accumulator.degraded ? ' degraded=true' : '')
    );
    for (const line of jitEvidence) {
      evidence.push(line);
    }
    jitDiagnostics = buildDreamJitDiagnostics({
      treeId: tree.id,
      policyId: policy.id,
      accumulator,
      driftRho,
      causalCutoff,
      evidence: jitEvidence
    });
  }

  return {
    treeId: tree.id,
    policyId: policy.id,
    rho: preference,
    probes: cost,
    cost,
    quality,
    visitedNodeIds: visited,
    earlyStopped,
    evidence,
    ...(jitDiagnostics === undefined ? {} : { jitDiagnostics })
  };
}

/** Scalarized quality/cost utility for one replay point. */
export function scalarizedUtility(
  quality: number,
  cost: number,
  rho: number,
  costCeiling: number
): number {
  const preference = clamp01(rho);
  const ceiling = Math.max(1, finiteOr(costCeiling, 1));
  const normalizedCost = Math.min(1, Math.max(0, finiteOr(cost, 0)) / ceiling);
  return clamp01((1 - preference) * clamp01(quality) + preference * (1 - normalizedCost));
}

/** One policy replayed over every tree at every rho. */
export interface PolicyReplayRun {
  readonly policyId: string;
  readonly rhos: readonly number[];
  readonly treeIds: readonly string[];
  readonly outcomes: Readonly<Record<string, readonly ReplayTreeOutcome[]>>;
  readonly maxProbes: number;
}

/** Replay one policy over the historical trees at every rho. */
export function replayPolicy(
  trees: readonly DiscoveryTreeSnapshot[],
  policy: MetaSearchPolicy,
  rhoPreferences: readonly number[],
  options: ReplayTreeOptions = {}
): PolicyReplayRun {
  const rhos = normalizeRhoPreferences(rhoPreferences);
  const usable = trees.filter((tree) => Object.keys(tree.nodes).length > 0);
  const outcomes: Record<string, ReplayTreeOutcome[]> = {};
  let maxProbes = 1;
  for (const rho of rhos) {
    const bucket: ReplayTreeOutcome[] = [];
    for (const tree of usable) {
      const outcome = replayTree(tree, policy, rho, options);
      if (outcome.probes > maxProbes) {
        maxProbes = outcome.probes;
      }
      bucket.push(outcome);
    }
    outcomes[String(rho)] = bucket;
  }
  return {
    policyId: policy.id,
    rhos,
    treeIds: usable.map((tree) => tree.id),
    outcomes,
    maxProbes: Math.max(1, maxProbes)
  };
}

/**
 * Aggregate a replay run into a PolicyEvaluation. hypervolume is the mean over
 * rho of the mean scalarized utility over trees, so it is bounded in [0, 1] and
 * strictly increases only when the policy does better in aggregate.
 */
export function toPolicyEvaluation(
  run: PolicyReplayRun,
  costCeiling: number
): PolicyEvaluation {
  const ceiling = Math.max(1, finiteOr(costCeiling, 1));
  const perRho: Record<string, number> = {};
  let qualitySum = 0;
  let costSum = 0;
  let points = 0;
  let hypervolumeSum = 0;
  for (const rho of run.rhos) {
    const bucket = run.outcomes[String(rho)] ?? [];
    let utilitySum = 0;
    for (const outcome of bucket) {
      const utility = scalarizedUtility(outcome.quality, outcome.cost, rho, ceiling);
      utilitySum += utility;
      qualitySum += outcome.quality;
      costSum += Math.min(1, outcome.cost / ceiling);
      points += 1;
    }
    perRho[String(rho)] = bucket.length > 0 ? utilitySum / bucket.length : 0;
    hypervolumeSum += bucket.length > 0 ? utilitySum / bucket.length : 0;
  }
  const hypervolume =
    run.rhos.length > 0 ? clamp01(hypervolumeSum / run.rhos.length) : 0;
  return {
    policyId: run.policyId,
    hypervolume,
    meanQuality: points > 0 ? qualitySum / points : 0,
    meanCost: points > 0 ? costSum / points : 0,
    perRho,
    treesEvaluated: run.treeIds.length
  };
}

/**
 * Convenience: evaluate one policy. Pass a shared costCeiling when comparing
 * policies; otherwise the run's own maximum probe count is used.
 */
export function evaluatePolicy(
  trees: readonly DiscoveryTreeSnapshot[],
  policy: MetaSearchPolicy,
  rhoPreferences: readonly number[],
  options: { readonly costCeiling?: number } = {}
): PolicyEvaluation {
  const run = replayPolicy(trees, policy, rhoPreferences);
  return toPolicyEvaluation(run, options.costCeiling ?? run.maxProbes);
}

/** Injectable candidate-policy generator. */
export type PolicyGenerator = (
  baseline: MetaSearchPolicy,
  count: number,
  request: OfflineDreamRequest
) => readonly MetaSearchPolicy[] | Promise<readonly MetaSearchPolicy[]>;

const WIDTH_FACTORS = [1, 0.5, 1.5, 1, 0.75, 1.25];
const DEPTH_FACTORS = [1, 0.5, 1.5, 1, 1, 0.5];
const THRESHOLDS = [0.8, 0.6, 0.95, 0.75, 0.85, 0.5];
const WEIGHT_PROFILES: readonly Readonly<Record<BatchSlotKind, number>>[] = [
  { exploit: 0.4, explore_domain: 0.3, explore_invariant: 0.2, recover: 0.1 },
  { exploit: 0.7, explore_domain: 0.1, explore_invariant: 0.1, recover: 0.1 },
  { exploit: 0.2, explore_domain: 0.3, explore_invariant: 0.4, recover: 0.1 },
  { exploit: 0.25, explore_domain: 0.35, explore_invariant: 0.35, recover: 0.05 },
  { exploit: 0.45, explore_domain: 0.2, explore_invariant: 0.2, recover: 0.15 },
  { exploit: 0.35, explore_domain: 0.25, explore_invariant: 0.25, recover: 0.15 }
];

/** Options for the deterministic candidate generator. */
export interface CandidatePolicyOptions {
  readonly now?: () => number;
  readonly idPrefix?: string;
  /**
   * Jit hyperparameter perturbation grid. Defaults to the frozen
   * config jitrl.dream grid, so the dual loop is on unless it is disabled.
   */
  readonly jitGrid?: JitPerturbationConfig;
}

/**
 * Deterministic candidate meta-schedulers around a baseline: varying width/depth
 * ratios, early-stop thresholds and slot allocations, plus - since Phase 4 - the
 * JitRL hyperparameters (plan section 7.3-1).
 *
 * P6 PR5 (plan section 7.2) sweeps only beta, k and similarityThreshold. Those
 * three change the *deterministic* part of the decision (KL temperature,
 * neighbour budget, Jaccard cut), so a replay can rank them. lambda, alpha and
 * gamma are inherited from the baseline and reported in `metadata.jitIgnored`,
 * because a stochastic exploration draw or an unrecomputable old return must not
 * decide which candidate wins.
 *
 * When the baseline carries no jit record the frozen kernel defaults are the
 * inheritance base, so the perturbation grid is always usable. Perturbation
 * switched off leaves each candidate with the baseline's own jit record (or none).
 *
 * The sequence is a pure function of (baseline, count, options): the same input
 * always yields the same candidates.
 */
export function generateCandidatePolicies(
  baseline: MetaSearchPolicy,
  count: number,
  options: CandidatePolicyOptions = {}
): readonly MetaSearchPolicy[] {
  const now = options.now ?? ((): number => Date.now());
  const total = clampInt(finiteOr(count, 0), 0, 32);
  const prefix = options.idPrefix ?? baseline.id + '::dream-';
  const grid = resolveJitPerturbationGrid(
    options.jitGrid ?? DEFAULT_EVO_HARNESS_CONFIG.jitrl.dream
  );
  const baseJit = jitHyperparamsOf(baseline);
  const out: MetaSearchPolicy[] = [];
  const used = new Set<string>();
  for (let index = 0; index < total; index += 1) {
    const widthFactor = WIDTH_FACTORS[index % WIDTH_FACTORS.length] ?? 1;
    const depthFactor = DEPTH_FACTORS[index % DEPTH_FACTORS.length] ?? 1;
    const threshold = THRESHOLDS[index % THRESHOLDS.length] ?? baseline.earlyStopThreshold;
    const profile = WEIGHT_PROFILES[index % WEIGHT_PROFILES.length] ?? DEFAULT_SLOT_WEIGHTS;
    const jit: JitHyperparams | undefined = grid.enabled
      ? {
          beta: grid.betas[index % grid.betas.length] ?? baseJit.beta,
          // Inherited, never swept (plan section 7.2); also listed in
          // metadata.jitIgnored so the choice is auditable, not implicit.
          lambda: baseJit.lambda,
          alpha: baseJit.alpha,
          k: grid.ks[index % grid.ks.length] ?? baseJit.k,
          gamma: baseJit.gamma,
          similarityThreshold:
            grid.similarityThresholds[index % grid.similarityThresholds.length] ??
            baseJit.similarityThreshold
        }
      : baseline.jit;
    const id = prefix + String(index + 1);
    if (used.has(id)) {
      continue;
    }
    used.add(id);
    out.push({
      id,
      version: baseline.version + 1,
      parentPolicyId: baseline.id,
      createdAt: now(),
      maxWidth: clampInt(baseline.maxWidth * widthFactor, 1, HARD_POLICY_LIMITS.maxWidth),
      maxDepth: clampInt(baseline.maxDepth * depthFactor, 1, HARD_POLICY_LIMITS.maxDepth),
      slotWeights: profile,
      earlyStopThreshold: clamp01(threshold),
      minMemoryConfidenceForSkip: clamp01(baseline.minMemoryConfidenceForSkip),
      metadata: {
        generator: 'deterministic',
        variant: index + 1,
        ...(jit === undefined
          ? {}
          : {
              jitSource: grid.enabled ? 'grid' : 'baseline',
              jitBeta: jit.beta,
              jitK: jit.k,
              jitSimilarityThreshold: jit.similarityThreshold,
              // The legacy keys stay for old consumers; they now report the
              // inherited value rather than a perturbed one.
              jitLambda: jit.lambda,
              jitIgnored: grid.ignored.map((entry) => entry.dimension)
            })
      },
      ...(jit === undefined ? {} : { jit })
    });
  }
  return out;
}

function sanitizeGeneratedPolicy(
  raw: unknown,
  baseline: MetaSearchPolicy,
  id: string,
  now: () => number
): MetaSearchPolicy | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const numberOr = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const weightsRecord =
    typeof record.slotWeights === 'object' && record.slotWeights !== null
      ? (record.slotWeights as Record<string, unknown>)
      : {};
  const weights: Record<BatchSlotKind, number> = {
    exploit: Math.max(0, numberOr(weightsRecord.exploit, baseline.slotWeights.exploit)),
    explore_domain: Math.max(
      0,
      numberOr(weightsRecord.explore_domain, baseline.slotWeights.explore_domain)
    ),
    explore_invariant: Math.max(
      0,
      numberOr(weightsRecord.explore_invariant, baseline.slotWeights.explore_invariant)
    ),
    recover: Math.max(0, numberOr(weightsRecord.recover, baseline.slotWeights.recover))
  };

  // Phase 4: the model path must preserve and validate jit instead of dropping
  // it. A malformed record degrades field by field to the (validated) baseline
  // hyperparameters and records a diagnostic; the candidate is still dropped if
  // what comes out is not a legal policy.
  const rawJit = record.jit;
  let jit: JitHyperparams | undefined;
  let jitSource: 'model' | 'baseline' | 'kernel_defaults' | undefined;
  const jitDiagnostics: string[] = [];
  if (rawJit === undefined || rawJit === null) {
    if (baseline.jit !== undefined) {
      jit = jitHyperparamsOf(baseline);
      jitSource = 'baseline';
      jitDiagnostics.push('model omitted jit; baseline hyperparameters kept');
    }
  } else {
    const resolved = sanitizeJitHyperparams(rawJit, jitHyperparamsOf(baseline));
    jit = resolved.jit;
    jitSource =
      resolved.diagnostics.length === 0
        ? 'model'
        : baseline.jit === undefined
          ? 'kernel_defaults'
          : 'baseline';
    for (const issue of resolved.diagnostics) {
      jitDiagnostics.push(issue);
    }
  }

  const candidate: MetaSearchPolicy = {
    id,
    version: baseline.version + 1,
    parentPolicyId: baseline.id,
    createdAt: now(),
    maxWidth: clampInt(
      numberOr(record.maxWidth, baseline.maxWidth),
      1,
      HARD_POLICY_LIMITS.maxWidth
    ),
    maxDepth: clampInt(
      numberOr(record.maxDepth, baseline.maxDepth),
      1,
      HARD_POLICY_LIMITS.maxDepth
    ),
    slotWeights: weights,
    earlyStopThreshold: clamp01(numberOr(record.earlyStopThreshold, baseline.earlyStopThreshold)),
    minMemoryConfidenceForSkip: clamp01(
      numberOr(record.minMemoryConfidenceForSkip, baseline.minMemoryConfidenceForSkip)
    ),
    metadata: {
      generator: 'model',
      ...(jitSource === undefined ? {} : { jitSource }),
      ...(jitDiagnostics.length === 0 ? {} : { jitDiagnostics })
    },
    ...(jit === undefined ? {} : { jit })
  };
  if (validatePolicy(candidate).length > 0) {
    return null;
  }
  // A candidate that carries jit must carry a legal one; anything else is
  // dropped instead of entering the replay set.
  return jitHyperparamIssues(candidate.jit).length === 0 ? candidate : null;
}

function extractJsonArray(text: string): unknown[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Options for the model-backed policy generator. */
export interface ModelPolicyGeneratorOptions {
  readonly now?: () => number;
  readonly temperature?: number;
  readonly fallback?: PolicyGenerator;
}

/**
 * Injectable policy generation via the host-neutral model adapter. Any parse or
 * transport failure falls back to the deterministic generator, so a dream cycle
 * never breaks because a model misbehaved.
 */
export function createModelPolicyGenerator(
  adapter: IModelAdapter,
  options: ModelPolicyGeneratorOptions = {}
): PolicyGenerator {
  const now = options.now ?? ((): number => Date.now());
  const fallback =
    options.fallback ??
    ((baseline, count) => generateCandidatePolicies(baseline, count, { now }));
  return async (baseline, count, request) => {
    const instruction =
      'Propose ' +
      String(Math.max(0, Math.floor(count))) +
      ' meta-search scheduler variants for an evolutionary harness search. ' +
      'Return a JSON array of objects with keys maxWidth (1-8), maxDepth (1-8), ' +
      'earlyStopThreshold (0-1), minMemoryConfidenceForSkip (0-1), slotWeights ' +
      'with exploit/explore_domain/explore_invariant/recover shares, and an ' +
      'optional jit object with beta (>=0), lambda (0-1), alpha (>=0), k ' +
      '(integer >=1), gamma (0-1) and similarityThreshold (0-1). ' +
      'Current baseline: ' +
      JSON.stringify({
        maxWidth: baseline.maxWidth,
        maxDepth: baseline.maxDepth,
        earlyStopThreshold: baseline.earlyStopThreshold,
        minMemoryConfidenceForSkip: baseline.minMemoryConfidenceForSkip,
        slotWeights: baseline.slotWeights,
        ...(baseline.jit === undefined ? {} : { jit: baseline.jit })
      }) +
      ' Historical trees: ' +
      String(request.trees.length) +
      '.';
    try {
      const response = await adapter.complete({
        purpose: 'dream_policy',
        messages: [
          {
            role: 'system',
            content:
              'You tune meta-search schedulers. Answer with a JSON array only.'
          },
          { role: 'user', content: instruction }
        ],
        responseFormat: 'json',
        temperature: options.temperature ?? 0.7
      });
      const parsed = extractJsonArray(response.text);
      const out: MetaSearchPolicy[] = [];
      for (let index = 0; index < parsed.length && out.length < count; index += 1) {
        const sanitized = sanitizeGeneratedPolicy(
          parsed[index],
          baseline,
          baseline.id + '::dream-m' + String(index + 1),
          now
        );
        if (sanitized !== null) {
          out.push(sanitized);
        }
      }
      if (out.length > 0) {
        return out;
      }
    } catch {
      // fall through to the deterministic generator
    }
    return fallback(baseline, count, request);
  };
}

/** Options for createOfflineDreamer. */
export interface OfflineDreamerOptions {
  readonly now?: () => number;
  readonly treePool?: IDiscoveryTreePool;
  readonly generatePolicies?: PolicyGenerator;
  readonly applyPolicy?: (policy: MetaSearchPolicy) => void | Promise<void>;
  readonly activePolicy?: { update(policy: MetaSearchPolicy): void };
  readonly modelAdapter?: IModelAdapter;
  readonly policyCount?: number;
  readonly minReplayTrees?: number;
  readonly rhoPreferences?: readonly number[];
  readonly hypervolumeEpsilon?: number;
  /**
   * Experience snapshot visible to the replay hook. Replay truncates it per
   * tree to that tree's own past before the hook sees anything.
   */
  readonly experiences?: readonly ExperienceRecord[];
  /**
   * Synchronous, side-effect-free JitRL simulation injected into every replay
   * (plan section 7.3-2). Absent keeps the pre-Phase-4 behaviour exactly.
   */
  readonly jitHook?: JitReplayHook;
  /** Drift down-weight factor forwarded to the hook; defaults to config 0.7. */
  readonly driftRho?: number;
  /**
   * P6 PR5 (plan section 7.4): record the suggested policy without publishing
   * it. Shadow mode never calls applyPolicy, so a suggestion cannot reach the
   * live policy without a real canary budget and human confirmation.
   */
  readonly shadowMode?: boolean;
  /**
   * PR-4B (ADR 0004 §4): EXPLICIT opt-in size of the Dreamer holdout split.
   *
   * 0 (the default) keeps the pre-PR-4B path: no split, `validatedOnHoldout`
   * stays undefined, and the G3 gate refuses publication with `holdout-missing`.
   *
   * When > 0 the split runs BEFORE candidate generation (see
   * `splitDreamerHoldout`): whole task groups are carved out of the newest end of
   * the pool, candidates are generated/selected on the remainder only, and the
   * winning candidate must additionally beat the baseline on the held-out trees
   * before `validatedOnHoldout` can become true.
   *
   * The value is a FLOOR, never a hint. A pool that cannot supply this many
   * holdout trees (the runtime pool can be smaller than `maxTreePoolSize`, so the
   * config-level `holdoutTreeCount < maxTreePoolSize` rule cannot see it) fails
   * closed with `insufficient-holdout-trees`, `hasSufficientEvidence: false`,
   * no `holdoutTrees`, and therefore no `validatedOnHoldout` and no publication.
   * It is never silently reduced to whatever the pool could offer.
   */
  readonly holdoutTreeCount?: number;
  /**
   * C1.1 (ADR-0003 §3.3): explicit publish authorization gate, derived from
   * effective profile permissions.publish.allowed. Defaults to false.
   */
  readonly publishAuthorized?: boolean;
}

/** One candidate's comparison against the incumbent, for the shadow log. */
export interface CandidateComparison {
  readonly policyId: string;
  readonly hypervolume: number;
  /** Signed difference to the baseline; negative means worse. */
  readonly delta: number;
  /** Strict improvement above epsilon on the selection trees. */
  readonly improved: boolean;
  /** Whether the candidate is the selected winner. */
  readonly selected: boolean;
}

/**
 * Shadow record of one dream cycle (plan section 7.4).
 *
 * It states what the replay *suggested* and how it differed from the policy in
 * force, without publishing anything. `published: false` is what distinguishes a
 * shadow record from an applied hot swap.
 */
export interface DreamShadowRecord {
  readonly suggestedPolicyId: string;
  readonly incumbentPolicyId: string;
  /** True only when a real publication happened (never in shadow mode). */
  readonly published: boolean;
  readonly comparisons: readonly CandidateComparison[];
  /** Trees used to generate/select candidates. */
  readonly selectionTreeIds: readonly string[];
  /**
   * Trees kept aside for validation; empty when no holdout was configured AND on
   * every fail-closed split (the `split` block below says which, and
   * `split.diagnostics.holdoutCount` reports the supply an undersized holdout was
   * refused for).
   */
  readonly holdoutTreeIds: readonly string[];
  /** Winner's hypervolume on the holdout, when a holdout was configured. */
  readonly holdoutHypervolume?: number;
  readonly baselineHypervolume?: number;
  /**
   * PR-4B (ADR 0004 §4.4): the pre-generation split verdict and its counts.
   * Present on every report so "no holdout configured" is distinguishable from
   * "the holdout was too small" (insufficient-evidence) and from an actual
   * validated win.
   */
  readonly split: DreamerHoldoutSplitReport;
  /** Bound declaration: the gate only holds on this fixed historical replay. */
  readonly boundary: string;
}

/** The serializable subset of the split that travels on the shadow record. */
export interface DreamerHoldoutSplitReport {
  readonly status: DreamerSplitStatus;
  readonly hasSufficientEvidence: boolean;
  readonly diagnostics: DreamerHoldoutSplit['diagnostics'];
}

function isBetterEvaluation(
  candidate: PolicyEvaluation,
  incumbent: PolicyEvaluation,
  epsilon: number
): boolean {
  if (candidate.hypervolume > incumbent.hypervolume + epsilon) {
    return true;
  }
  if (Math.abs(candidate.hypervolume - incumbent.hypervolume) <= epsilon) {
    if (candidate.meanCost < incumbent.meanCost - epsilon) {
      return true;
    }
    if (Math.abs(candidate.meanCost - incumbent.meanCost) <= epsilon) {
      return candidate.policyId < incumbent.policyId;
    }
  }
  return false;
}

/**
 * Extended report of one dream cycle: the contract shape plus the publication
 * verdict and the shadow record (plan section 7.4).
 *
 * Additive on purpose: `IOfflineDreamer.replay` still returns
 * `DreamReplayReport`, and this subtype is assignable to it, so no contract in
 * src/types/contracts.ts had to change and every pre-PR5 consumer keeps working.
 */
export interface DreamReplayReportWithShadow extends DreamReplayReport {
  /** Whether the winning candidate may be published, and why. */
  readonly publication: ReplayPublicationDecision;
  /** What was suggested versus what is in force; recording never publishes. */
  readonly shadow: DreamShadowRecord;
  /** Dimensions this cycle did not search, with the reason (§7.2). */
  readonly ignoredDimensions: readonly JitIgnoredDimension[];
}

class OfflineDreamerImpl implements IOfflineDreamer {
  private readonly now: () => number;
  private readonly treePool: IDiscoveryTreePool | undefined;
  private readonly generator: PolicyGenerator;
  private readonly applyPolicy: ((policy: MetaSearchPolicy) => void | Promise<void>) | undefined;
  private readonly policyCount: number;
  private readonly minReplayTrees: number;
  private readonly rhoPreferences: readonly number[];
  private readonly epsilon: number;
  private readonly experiences: readonly ExperienceRecord[] | undefined;
  private readonly jitHook: JitReplayHook | undefined;
  private readonly driftRho: number | undefined;
  private readonly shadowMode: boolean;
  private readonly holdoutTreeCount: number;
  private readonly publishAuthorized: boolean;

  constructor(options: OfflineDreamerOptions) {
    this.now = options.now ?? ((): number => Date.now());
    this.treePool = options.treePool;
    this.policyCount = clampInt(finiteOr(options.policyCount ?? 6, 6), 1, 32);
    this.minReplayTrees = Math.max(1, Math.floor(finiteOr(options.minReplayTrees ?? 1, 1)));
    this.rhoPreferences = normalizeRhoPreferences(options.rhoPreferences);
    this.epsilon = Math.max(1e-12, finiteOr(options.hypervolumeEpsilon ?? 1e-9, 1e-9));
    this.experiences = options.experiences;
    this.jitHook = options.jitHook;
    this.shadowMode = options.shadowMode === true;
    this.holdoutTreeCount = Math.max(
      0,
      Math.floor(finiteOr(options.holdoutTreeCount ?? 0, 0))
    );
    this.publishAuthorized = options.publishAuthorized === true;
    this.driftRho =
      options.driftRho === undefined
        ? undefined
        : clamp01(finiteOr(options.driftRho, DEFAULT_EVO_HARNESS_CONFIG.jitrl.dream.driftRho));
    const generator =
      options.generatePolicies ??
      (options.modelAdapter !== undefined
        ? createModelPolicyGenerator(options.modelAdapter, { now: this.now })
        : undefined);
    this.generator =
      generator ??
      ((baseline, count) => generateCandidatePolicies(baseline, count, { now: this.now }));
    this.applyPolicy =
      options.applyPolicy ??
      (options.activePolicy === undefined
        ? undefined
        : (policy: MetaSearchPolicy) => {
            options.activePolicy?.update(policy);
          });
  }

  async replay(request: OfflineDreamRequest): Promise<DreamReplayReportWithShadow> {
    const ranAt = this.now();
    const rhos = normalizeRhoPreferences(
      request.rhoPreferences ?? this.rhoPreferences
    );
    const trees = request.trees.filter((tree) => Object.keys(tree.nodes).length > 0);
    const minTrees = Math.max(
      1,
      Math.floor(finiteOr(request.minReplayTrees ?? this.minReplayTrees, 1))
    );
    const baseline = request.baselinePolicy;
    const emptyBaseline: PolicyEvaluation = {
      policyId: baseline.id,
      hypervolume: 0,
      meanQuality: 0,
      meanCost: 0,
      perRho: {},
      treesEvaluated: 0
    };

    if (trees.length < minTrees) {
      // PR-4B: even the early exit reports the split verdict, computed from the
      // (too small) pool, so the caller can see WHY there was nothing to dream.
      const emptySplit = splitDreamerHoldout(trees, this.holdoutTreeCount);
      return {
        ranAt,
        baseline: emptyBaseline,
        candidateEvaluations: [],
        best: emptyBaseline,
        improved: false,
        selectedPolicyId: baseline.id,
        replayedTreeIds: [],
        rhoPreferences: rhos,
        publication: decideReplayPublication({ improved: false }),
        shadow: {
          suggestedPolicyId: baseline.id,
          incumbentPolicyId: baseline.id,
          published: false,
          comparisons: [],
          selectionTreeIds: [],
          holdoutTreeIds: [],
          split: {
            status: emptySplit.status,
            hasSufficientEvidence: emptySplit.hasSufficientEvidence,
            diagnostics: emptySplit.diagnostics
          },
          boundary: REPLAY_GATE_BOUNDARY
        },
        ignoredDimensions: JIT_IGNORED_DIMENSIONS
      };
    }

    // PR-4B (ADR 0004 §4.1): the split happens BEFORE anything else looks at the
    // pool - before the tree pool is fed, before the generator runs, before any
    // hypervolume is computed. That ordering is the whole guarantee: a candidate
    // that has already seen the holdout's statistics cannot be validated on it.
    const split = splitDreamerHoldout(trees, this.holdoutTreeCount);
    const selectionTrees = split.selectionTrees;
    const holdoutTrees = split.holdoutTrees;
    // `split.ok === false` is a fail-closed verdict: validation is impossible, so
    // `validatedOnHoldout` stays undefined and G3 keeps refusing publication with
    // holdout-missing unless the G2-style authorization also holds. The status
    // travels on the shadow record and in the diagnostic line below.
    //
    // Both fields are consulted, not just the status: `ok` is the only shelf that
    // permits validation, and `hasSufficientEvidence` is the same statement in
    // boolean form. Reading both means a future status shelf that forgets to flip
    // the boolean still cannot validate, and - specifically for the PR-4B repair -
    // a request the pool cannot satisfy (`insufficient-holdout-trees`, e.g. 5
    // requested from a pool that can only offer 3) never sets validatedOnHoldout.
    const holdoutUsable = split.status === 'ok' && split.hasSufficientEvidence;

    const replayOptions: ReplayTreeOptions = {
      ...(this.experiences === undefined ? {} : { experiences: this.experiences }),
      ...(this.jitHook === undefined ? {} : { jitHook: this.jitHook }),
      ...(this.driftRho === undefined ? {} : { driftRho: this.driftRho })
    };

    if (this.treePool !== undefined) {
      for (const tree of trees) {
        this.treePool.add(tree);
      }
    }

    const requested =
      request.candidatePolicies.length > 0
        ? request.candidatePolicies
        : // The generator is handed a REQUEST WHOSE POOL IS THE SELECTION SET
          // (ADR 0004 §4.1-2: "generatePolicies may only receive the selection
          // trees; the holdout must not be passed, nor any summary statistic of
          // it"). A generator that ignores its argument gains nothing, but one
          // that reads `request.trees` now structurally cannot see the holdout.
          //
          // The condition is "was a holdout requested", not "did the split reserve
          // one". On a fail-closed split `holdoutTrees` is empty, but the trees the
          // cut set aside were still withheld for validation; handing them to the
          // generator would let an undersized/failed split feed the newest trees
          // into generation. When nothing was requested the original request object
          // is passed through unchanged, keeping the pre-PR-4B path identical.
          await this.generator(
            baseline,
            this.policyCount,
            this.holdoutTreeCount > 0 ? { ...request, trees: selectionTrees } : request
          );

    const candidates: MetaSearchPolicy[] = [];
    const seenIds = new Set<string>([baseline.id]);
    for (const candidate of requested) {
      if (
        seenIds.has(candidate.id) ||
        validatePolicy(candidate).length > 0 ||
        jitHyperparamIssues(candidate.jit).length > 0
      ) {
        continue;
      }
      seenIds.add(candidate.id);
      candidates.push(candidate);
    }

    // PR-4B (ADR 0004 §4.3): the split was already computed above, before
    // generation. `split.ok` is the ONLY status that allows a holdout validation;
    // every other status is a fail-closed insufficient-evidence verdict.

    const baselineRun = replayPolicy(selectionTrees, baseline, rhos, replayOptions);
    const candidateRuns = candidates.map((candidate) =>
      replayPolicy(selectionTrees, candidate, rhos, replayOptions)
    );
    // A shared cost ceiling keeps the policies comparable: a candidate must not
    // look better only because it was scored against a different probe budget.
    //
    // PR-4B INFORMATION-VISIBILITY FIX (ADR 0004 §4.1-2/§4.2): this ceiling is
    // built ONLY from the selection runs. Before PR-4B the holdout baseline run
    // was folded into the same ceiling, which leaked a statistic derived from the
    // held-out trees into the numbers candidates were ranked on - precisely the
    // "no summary statistic of the holdout may reach generation/selection" rule.
    // The holdout pass now gets its own ceiling, computed from the runs it
    // actually compares (baseline vs. winner on the SAME held-out trees).
    let selectionCeiling = baselineRun.maxProbes;
    for (const run of candidateRuns) {
      if (run.maxProbes > selectionCeiling) {
        selectionCeiling = run.maxProbes;
      }
    }
    const baselineEvaluation = toPolicyEvaluation(baselineRun, selectionCeiling);
    const candidateEvaluations = candidateRuns.map((run) =>
      toPolicyEvaluation(run, selectionCeiling)
    );

    let bestCandidate: { policy: MetaSearchPolicy; evaluation: PolicyEvaluation } | undefined;
    for (let index = 0; index < candidates.length; index += 1) {
      const policy = candidates[index];
      const evaluation = candidateEvaluations[index];
      if (policy === undefined || evaluation === undefined) {
        continue;
      }
      if (
        bestCandidate === undefined ||
        isBetterEvaluation(evaluation, bestCandidate.evaluation, this.epsilon)
      ) {
        bestCandidate = { policy, evaluation };
      }
    }

    const improvedOnSelection =
      bestCandidate !== undefined &&
      bestCandidate.evaluation.hypervolume > baselineEvaluation.hypervolume + this.epsilon;

    // Plan section 7.4: a winner must also hold up on trees it was not selected
    // on. Without that, picking the best of several candidates on one batch and
    // calling it generalisation is exactly the defect this gate removes.
    //
    // PR-4B (ADR 0004 §4.2-2): only the WINNER is replayed on the holdout, never
    // every candidate. Replaying all of them and taking the best would turn the
    // holdout into a second selection set (multiple-comparison overfitting).
    let validatedOnHoldout: boolean | undefined;
    let holdoutHypervolume: number | undefined;
    let holdoutBaselineHypervolume: number | undefined;
    if (
      holdoutUsable &&
      improvedOnSelection &&
      holdoutTrees.length > 0 &&
      bestCandidate !== undefined
    ) {
      // PR-4B (ADR 0004 §4.2): the holdout pass is self-contained. Its cost
      // ceiling is computed from the two runs it compares, so no selection-derived
      // budget enters the validation numbers and no holdout-derived budget enters
      // the selection numbers.
      const holdoutBaselineRun = replayPolicy(holdoutTrees, baseline, rhos, replayOptions);
      const holdoutWinnerRun = replayPolicy(
        holdoutTrees,
        bestCandidate.policy,
        rhos,
        replayOptions
      );
      const holdoutCeiling = Math.max(
        holdoutBaselineRun.maxProbes,
        holdoutWinnerRun.maxProbes
      );
      holdoutBaselineHypervolume = toPolicyEvaluation(
        holdoutBaselineRun,
        holdoutCeiling
      ).hypervolume;
      holdoutHypervolume = toPolicyEvaluation(holdoutWinnerRun, holdoutCeiling).hypervolume;
      validatedOnHoldout = holdoutHypervolume > holdoutBaselineHypervolume + this.epsilon;
    }

    const verdict = decideReplayPublication({
      improved: improvedOnSelection,
      shadowMode: this.shadowMode,
      ...(validatedOnHoldout === undefined ? {} : { validatedOnHoldout })
    });
    const improved = improvedOnSelection;

    // C1.1 (ADR-0003 §3.3): B-layer apply gate
    // applied = verdict.publish && publishAuthorized === true && applyPolicy !== undefined && bestCandidate !== undefined
    const canApply =
      verdict.publish &&
      this.publishAuthorized &&
      this.applyPolicy !== undefined &&
      bestCandidate !== undefined;

    let applied = false;
    if (canApply && bestCandidate !== undefined) {
      await this.applyPolicy(bestCandidate.policy);
      applied = true;
    }

    // C1.1 (ADR-0003 §3.3): reported = applied
    let publication: ReplayPublicationDecision;
    if (!verdict.publish) {
      publication = verdict;
    } else if (!this.publishAuthorized) {
      publication = {
        improved: true,
        publish: false,
        reason:
          'publish-denied: execution profile permissions disallow publishing without explicit authorization',
        boundary: verdict.boundary
      };
    } else if (this.applyPolicy === undefined) {
      publication = {
        improved: true,
        publish: false,
        reason:
          'no-apply-target: publication was authorized and validated, but no applyPolicy handler was configured',
        boundary: verdict.boundary
      };
    } else if (bestCandidate === undefined) {
      publication = {
        improved: false,
        publish: false,
        reason: 'no-candidate: candidate policy was undefined',
        boundary: verdict.boundary
      };
    } else {
      publication = verdict;
    }

    // Shadow record (plan section 7.4): what was suggested, how it differed, and
    // whether anything was published. Recording does not publish.
    const shadow: DreamShadowRecord = {
      suggestedPolicyId: bestCandidate?.policy.id ?? baseline.id,
      incumbentPolicyId: baseline.id,
      published: applied,
      comparisons: candidateEvaluations.map((evaluation) => ({
        policyId: evaluation.policyId,
        hypervolume: evaluation.hypervolume,
        delta: evaluation.hypervolume - baselineEvaluation.hypervolume,
        improved: evaluation.hypervolume > baselineEvaluation.hypervolume + this.epsilon,
        selected:
          applied && bestCandidate !== undefined
            ? evaluation.policyId === bestCandidate.policy.id
            : false
      })),
      selectionTreeIds: baselineRun.treeIds,
      holdoutTreeIds: holdoutTrees.map((tree) => tree.id),
      ...(holdoutHypervolume === undefined ? {} : { holdoutHypervolume }),
      ...(holdoutBaselineHypervolume === undefined
        ? {}
        : { baselineHypervolume: holdoutBaselineHypervolume }),
      // PR-4B (ADR 0004 §4.4): the split verdict and its counts travel with the
      // record, so an auditor can tell "no holdout configured" from "the holdout
      // was too small" from "the winner actually won there" without re-running.
      split: {
        status: split.status,
        hasSufficientEvidence: split.hasSufficientEvidence,
        diagnostics: split.diagnostics
      },
      boundary: REPLAY_GATE_BOUNDARY
    };

    return {
      ranAt,
      baseline: baselineEvaluation,
      candidateEvaluations,
      best: improved && bestCandidate !== undefined ? bestCandidate.evaluation : baselineEvaluation,
      improved,
      selectedPolicyId:
        improved && bestCandidate !== undefined ? bestCandidate.evaluation.policyId : baseline.id,
      replayedTreeIds: baselineRun.treeIds,
      rhoPreferences: rhos,
      publication,
      shadow,
      ignoredDimensions: JIT_IGNORED_DIMENSIONS
    };
  }
}

/**
 * Zero-execution offline replay engine plus the additive PR5 report fields.
 *
 * Widening the factory's return type (rather than the contract in
 * src/types/contracts.ts) keeps every existing consumer compiling: this
 * interface is assignable to `IOfflineDreamer`, so a caller that only knows the
 * original contract sees exactly the original surface, while a caller that wants
 * the publication verdict and the shadow record gets them typed.
 */
export interface IOfflineDreamerWithShadow extends IOfflineDreamer {
  replay(request: OfflineDreamRequest): Promise<DreamReplayReportWithShadow>;
}

/** Create the zero-execution offline dreamer. */
export function createOfflineDreamer(
  options: OfflineDreamerOptions = {}
): IOfflineDreamerWithShadow {
  return new OfflineDreamerImpl(options);
}
