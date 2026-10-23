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

/** Config subset that drives jit hyperparameter perturbation. */
export interface JitPerturbationConfig {
  readonly hyperparamPerturbation?: boolean;
  readonly candidateJitBetas?: readonly number[];
  readonly candidateJitLambdas?: readonly number[];
}

/** Resolved perturbation grid; deterministic and never empty while enabled. */
export interface JitPerturbationGrid {
  readonly enabled: boolean;
  readonly betas: readonly number[];
  readonly lambdas: readonly number[];
}

/** Built-in perturbation grids, mirroring the frozen jitrl.dream defaults. */
export const DEFAULT_JIT_BETAS = [0.5, 1, 2] as const;
export const DEFAULT_JIT_LAMBDAS = [0.02, 0.05, 0.1] as const;

function finiteGrid(values: readonly number[] | undefined): readonly number[] {
  const out: number[] = [];
  for (const value of values ?? []) {
    if (Number.isFinite(value) && value >= 0 && !out.includes(value)) {
      out.push(value);
    }
  }
  return out;
}

/**
 * Resolve the jit perturbation grid by candidate index: candidate i takes
 * betas[i % betas.length] together with lambdas[i % lambdas.length], while
 * alpha/k/gamma/similarityThreshold stay inherited from the baseline. The
 * (beta, lambda) pair is replaced as a whole and never merged element-wise with
 * the baseline record, so the candidate sequence is deterministic and
 * reproducible (plan section 7.3-1).
 *
 * `hyperparamPerturbation: false` disables perturbation; an empty or fully
 * invalid grid falls back to the built-in default grids.
 */
export function resolveJitPerturbationGrid(
  config: JitPerturbationConfig = DEFAULT_EVO_HARNESS_CONFIG.jitrl.dream
): JitPerturbationGrid {
  if (!(config.hyperparamPerturbation ?? true)) {
    return { enabled: false, betas: [], lambdas: [] };
  }
  const betas = finiteGrid(config.candidateJitBetas);
  const lambdas = finiteGrid(config.candidateJitLambdas);
  return {
    enabled: true,
    betas: betas.length > 0 ? betas : [...DEFAULT_JIT_BETAS],
    lambdas: lambdas.length > 0 ? lambdas : [...DEFAULT_JIT_LAMBDAS]
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
// Dream replay x JitRL: causal truncation and the synchronous replay hook
// ---------------------------------------------------------------------------

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
 * The jit record of candidate i is the baseline record with (beta, lambda)
 * replaced by the grid pair at index i modulo the grid length; alpha, k, gamma
 * and similarityThreshold are inherited unchanged. When the baseline carries no
 * jit record the frozen kernel defaults are the inheritance base, so the
 * perturbation grid is always usable. Perturbation switched off leaves each
 * candidate with the baseline's own jit record (or none).
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
          lambda: grid.lambdas[index % grid.lambdas.length] ?? baseJit.lambda,
          alpha: baseJit.alpha,
          k: baseJit.k,
          gamma: baseJit.gamma,
          similarityThreshold: baseJit.similarityThreshold
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
              jitLambda: jit.lambda
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

  constructor(options: OfflineDreamerOptions) {
    this.now = options.now ?? ((): number => Date.now());
    this.treePool = options.treePool;
    this.policyCount = clampInt(finiteOr(options.policyCount ?? 6, 6), 1, 32);
    this.minReplayTrees = Math.max(1, Math.floor(finiteOr(options.minReplayTrees ?? 1, 1)));
    this.rhoPreferences = normalizeRhoPreferences(options.rhoPreferences);
    this.epsilon = Math.max(1e-12, finiteOr(options.hypervolumeEpsilon ?? 1e-9, 1e-9));
    this.experiences = options.experiences;
    this.jitHook = options.jitHook;
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

  async replay(request: OfflineDreamRequest): Promise<DreamReplayReport> {
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
      return {
        ranAt,
        baseline: emptyBaseline,
        candidateEvaluations: [],
        best: emptyBaseline,
        improved: false,
        selectedPolicyId: baseline.id,
        replayedTreeIds: [],
        rhoPreferences: rhos
      };
    }

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
        : await this.generator(baseline, this.policyCount, request);

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

    const baselineRun = replayPolicy(trees, baseline, rhos, replayOptions);
    const candidateRuns = candidates.map((candidate) =>
      replayPolicy(trees, candidate, rhos, replayOptions)
    );
    let ceiling = baselineRun.maxProbes;
    for (const run of candidateRuns) {
      if (run.maxProbes > ceiling) {
        ceiling = run.maxProbes;
      }
    }
    const baselineEvaluation = toPolicyEvaluation(baselineRun, ceiling);
    const candidateEvaluations = candidateRuns.map((run) =>
      toPolicyEvaluation(run, ceiling)
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

    const improved =
      bestCandidate !== undefined &&
      bestCandidate.evaluation.hypervolume > baselineEvaluation.hypervolume + this.epsilon;

    // Hot-swap stays monotone: only a strictly better candidate replaces the
    // incumbent, and the winner carries pi *and* its jit hyperparameters.
    if (improved && bestCandidate !== undefined && this.applyPolicy !== undefined) {
      await this.applyPolicy(bestCandidate.policy);
    }

    return {
      ranAt,
      baseline: baselineEvaluation,
      candidateEvaluations,
      best: improved && bestCandidate !== undefined ? bestCandidate.evaluation : baselineEvaluation,
      improved,
      selectedPolicyId:
        improved && bestCandidate !== undefined ? bestCandidate.evaluation.policyId : baseline.id,
      replayedTreeIds: baselineRun.treeIds,
      rhoPreferences: rhos
    };
  }
}

/** Create the zero-execution offline dreamer. */
export function createOfflineDreamer(
  options: OfflineDreamerOptions = {}
): IOfflineDreamer {
  return new OfflineDreamerImpl(options);
}
