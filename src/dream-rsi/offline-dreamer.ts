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
  DreamReplayReport,
  IDiscoveryTreePool,
  IModelAdapter,
  IOfflineDreamer,
  MetaSearchPolicy,
  OfflineDreamRequest,
  PolicyEvaluation
} from '../types/contracts';
import { DREAM_RHO_PREFERENCES } from '../types/contracts';
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
}

/** Options for one tree replay. */
export interface ReplayTreeOptions {
  readonly costCeiling?: number;
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

function buildPriorityContext(
  tree: DiscoveryTreeSnapshot,
  slotWeights: Readonly<Record<BatchSlotKind, number>>
): PriorityContext {
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
  let total = 0;
  for (const kind of SEARCH_SLOT_KINDS) {
    total += slotWeights[kind] ?? 0;
  }
  const share = (kind: BatchSlotKind): number =>
    total > 0 ? (slotWeights[kind] ?? 0) / total : 1 / SEARCH_SLOT_KINDS.length;
  return {
    minCreatedAt: Number.isFinite(minCreatedAt) ? minCreatedAt : 0,
    maxCreatedAt: Number.isFinite(maxCreatedAt) ? maxCreatedAt : 0,
    weights: {
      exploit: share('exploit'),
      explore_domain: share('explore_domain'),
      explore_invariant: share('explore_invariant')
    }
  };
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

/**
 * Replay one historical tree under one policy at one budget preference rho.
 * Pure in-memory: only recorded node scores/statuses are consulted.
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
  let frontier: readonly DiscoveryNode[] = [root];

  for (let level = 0; level < depth && frontier.length > 0; level += 1) {
    const ordered = orderFrontier(frontier, context);
    for (const node of ordered) {
      if (visited.length >= budget) {
        break;
      }
      if (seen.has(node.id)) {
        continue;
      }
      seen.add(node.id);
      visited.push(node.id);
      const score = replayNodeScore(node);
      if (score > quality) {
        quality = score;
      }
      if (quality >= stopThreshold) {
        earlyStopped = true;
        break;
      }
    }
    if (earlyStopped || visited.length >= budget) {
      break;
    }
    const next: DiscoveryNode[] = [];
    for (const node of ordered) {
      if (visited.length >= budget) {
        break;
      }
      for (const child of childrenOfSnapshot(tree, node.id)) {
        if (!seen.has(child.id)) {
          next.push(child);
        }
      }
    }
    frontier = next;
  }

  const recoveryWeight = slotWeights.recover;
  if (recoveryWeight > 0 && visited.length < budget) {
    const failed = firstRepairableFailedNode(tree);
    if (failed !== undefined && !seen.has(failed.id)) {
      seen.add(failed.id);
      visited.push(failed.id);
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

  const cost = visited.length;
  evidence.push(
    'rho=' +
      preference.toFixed(2) +
      ' width=' +
      String(width) +
      ' depth=' +
      String(depth) +
      ' budget=' +
      String(budget) +
      ' probes=' +
      String(cost) +
      ' quality=' +
      quality.toFixed(4) +
      (earlyStopped ? ' early_stopped=true' : '')
  );
  const ceiling = Math.max(1, finiteOr(options.costCeiling ?? 1, 1));
  evidence.push('normalizedCost=' + Math.min(1, cost / ceiling).toFixed(4));

  return {
    treeId: tree.id,
    policyId: policy.id,
    rho: preference,
    probes: cost,
    cost,
    quality,
    visitedNodeIds: visited,
    earlyStopped,
    evidence
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
  rhoPreferences: readonly number[]
): PolicyReplayRun {
  const rhos = normalizeRhoPreferences(rhoPreferences);
  const usable = trees.filter((tree) => Object.keys(tree.nodes).length > 0);
  const outcomes: Record<string, ReplayTreeOutcome[]> = {};
  let maxProbes = 1;
  for (const rho of rhos) {
    const bucket: ReplayTreeOutcome[] = [];
    for (const tree of usable) {
      const outcome = replayTree(tree, policy, rho);
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
}

/**
 * Deterministic candidate meta-schedulers around a baseline: varying width/depth
 * ratios, early-stop thresholds and slot allocations.
 */
export function generateCandidatePolicies(
  baseline: MetaSearchPolicy,
  count: number,
  options: CandidatePolicyOptions = {}
): readonly MetaSearchPolicy[] {
  const now = options.now ?? ((): number => Date.now());
  const total = clampInt(finiteOr(count, 0), 0, 32);
  const prefix = options.idPrefix ?? baseline.id + '::dream-';
  const out: MetaSearchPolicy[] = [];
  const used = new Set<string>();
  for (let index = 0; index < total; index += 1) {
    const widthFactor = WIDTH_FACTORS[index % WIDTH_FACTORS.length] ?? 1;
    const depthFactor = DEPTH_FACTORS[index % DEPTH_FACTORS.length] ?? 1;
    const threshold = THRESHOLDS[index % THRESHOLDS.length] ?? baseline.earlyStopThreshold;
    const profile = WEIGHT_PROFILES[index % WEIGHT_PROFILES.length] ?? DEFAULT_SLOT_WEIGHTS;
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
      metadata: { generator: 'deterministic', variant: index + 1 }
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
    metadata: { generator: 'model' }
  };
  return validatePolicy(candidate).length === 0 ? candidate : null;
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
      'earlyStopThreshold (0-1), minMemoryConfidenceForSkip (0-1) and slotWeights ' +
      'with exploit/explore_domain/explore_invariant/recover shares. ' +
      'Current baseline: ' +
      JSON.stringify({
        maxWidth: baseline.maxWidth,
        maxDepth: baseline.maxDepth,
        earlyStopThreshold: baseline.earlyStopThreshold,
        minMemoryConfidenceForSkip: baseline.minMemoryConfidenceForSkip,
        slotWeights: baseline.slotWeights
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

  constructor(options: OfflineDreamerOptions) {
    this.now = options.now ?? ((): number => Date.now());
    this.treePool = options.treePool;
    this.policyCount = clampInt(finiteOr(options.policyCount ?? 6, 6), 1, 32);
    this.minReplayTrees = Math.max(1, Math.floor(finiteOr(options.minReplayTrees ?? 1, 1)));
    this.rhoPreferences = normalizeRhoPreferences(options.rhoPreferences);
    this.epsilon = Math.max(1e-12, finiteOr(options.hypervolumeEpsilon ?? 1e-9, 1e-9));
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
      if (seenIds.has(candidate.id) || validatePolicy(candidate).length > 0) {
        continue;
      }
      seenIds.add(candidate.id);
      candidates.push(candidate);
    }

    const baselineRun = replayPolicy(trees, baseline, rhos);
    const candidateRuns = candidates.map((candidate) =>
      replayPolicy(trees, candidate, rhos)
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
