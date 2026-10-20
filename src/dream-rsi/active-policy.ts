/**
 * Dream-RSI online active policy: plan_grid plus three-way batch portfolio.
 *
 * Ownership: src/dream-rsi/** (Wave 1, Dream-RSI layer).
 *
 * plan_grid (ARCHITECTURE.md 5.1.1) sizes the search tree for one task from
 * task complexity, recalled-memory confidence and the remaining budget. Hard
 * policy caps are upper bounds: a plan may only shrink them.
 *
 * selectBatch (ARCHITECTURE.md 5.1.2) mixes three slot families plus at most one
 * recovery slot:
 * - exploit           : deepen the best known candidate (origin 'reference');
 * - explore_domain    : fork a new direction guided by recalled memory;
 * - explore_invariant : fork a first-principles direction, always guidance_free;
 * - recover           : repair a repairable implementation failure (<= 1 slot).
 */

import type {
  BatchPlan,
  BatchSlotKind,
  BatchSlotPlan,
  ContractMetadata,
  DiscoveryNode,
  DiscoveryTreeSnapshot,
  FailureDiagnosis,
  HarnessComponentKey,
  IActivePolicy,
  MetaSearchPolicy,
  PatchOrigin,
  PlanGridRequest,
  SearchGridPlan,
  SelectBatchRequest,
  StopCondition,
  TaskComplexity
} from '../types/contracts';
import { BATCH_SLOT_KINDS, HARNESS_COMPONENT_KEYS } from '../types/contracts';
import { DEFAULT_EVO_HARNESS_CONFIG } from '../config';

/** Complexity multiplier applied to the width/depth caps. */
export const COMPLEXITY_FACTORS: Readonly<Record<TaskComplexity, number>> = {
  trivial: 0.25,
  simple: 0.5,
  moderate: 0.75,
  complex: 1,
  unknown: 0.85
};

/** Default portfolio weights over the four slot kinds (sum = 1). */
export const DEFAULT_SLOT_WEIGHTS: Readonly<Record<BatchSlotKind, number>> = {
  exploit: 0.4,
  explore_domain: 0.3,
  explore_invariant: 0.2,
  recover: 0.1
};

/** The three search tracks that share the non-recovery width. */
export const SEARCH_SLOT_KINDS: readonly BatchSlotKind[] = [
  'exploit',
  'explore_domain',
  'explore_invariant'
];

/** Surfaces a slot touches when the tree carries no surface hint. */
export const DEFAULT_FOCUS_SURFACES: readonly HarnessComponentKey[] =
  HARNESS_COMPONENT_KEYS.slice();

/** Absolute hard caps; configuration already validates within these. */
export const HARD_POLICY_LIMITS = { maxWidth: 8, maxDepth: 8 } as const;

/** Thrown when a policy is structurally invalid or regresses in version. */
export class PolicyValidationError extends Error {
  readonly code = 'INVALID_POLICY';
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super('Invalid meta-search policy: ' + issues.join('; '));
    this.name = 'PolicyValidationError';
    this.issues = [...issues];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural validation of a meta-search policy. Empty array means valid. */
export function validatePolicy(policy: MetaSearchPolicy): readonly string[] {
  const issues: string[] = [];
  if (typeof policy.id !== 'string' || policy.id.length === 0) {
    issues.push('id must be a non-empty string');
  }
  if (!Number.isFinite(policy.version) || policy.version < 1) {
    issues.push('version must be a finite number >= 1');
  }
  if (!Number.isFinite(policy.maxWidth) || policy.maxWidth < 0) {
    issues.push('maxWidth must be a finite number >= 0');
  }
  if (!Number.isFinite(policy.maxDepth) || policy.maxDepth < 0) {
    issues.push('maxDepth must be a finite number >= 0');
  }
  if (!Number.isFinite(policy.earlyStopThreshold)) {
    issues.push('earlyStopThreshold must be finite');
  } else if (policy.earlyStopThreshold < 0 || policy.earlyStopThreshold > 1) {
    issues.push('earlyStopThreshold must be within [0, 1]');
  }
  if (!Number.isFinite(policy.minMemoryConfidenceForSkip)) {
    issues.push('minMemoryConfidenceForSkip must be finite');
  } else if (policy.minMemoryConfidenceForSkip < 0 || policy.minMemoryConfidenceForSkip > 1) {
    issues.push('minMemoryConfidenceForSkip must be within [0, 1]');
  }
  if (!isRecord(policy.slotWeights)) {
    issues.push('slotWeights must be a record over the four slot kinds');
    return issues;
  }
  for (const kind of BATCH_SLOT_KINDS) {
    const weight = policy.slotWeights[kind];
    if (!Number.isFinite(weight) || weight < 0) {
      issues.push('slotWeights.' + kind + ' must be a finite number >= 0');
    }
  }
  return issues;
}

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

/** Coerce slot weights into a valid, non-negative, non-zero-sum vector. */
export function normalizeSlotWeights(
  weights: Readonly<Record<BatchSlotKind, number>> | undefined
): Readonly<Record<BatchSlotKind, number>> {
  const out: Record<BatchSlotKind, number> = {
    exploit: 0,
    explore_domain: 0,
    explore_invariant: 0,
    recover: 0
  };
  let sum = 0;
  for (const kind of BATCH_SLOT_KINDS) {
    const raw = weights === undefined ? Number.NaN : weights[kind];
    const value = Number.isFinite(raw) && raw > 0 ? raw : 0;
    out[kind] = value;
    sum += value;
  }
  if (sum <= 0) {
    return DEFAULT_SLOT_WEIGHTS;
  }
  return out;
}

function isHarnessSurface(value: unknown): value is HarnessComponentKey {
  return (
    typeof value === 'string' &&
    (HARNESS_COMPONENT_KEYS as readonly string[]).includes(value)
  );
}

function surfacesFromMetadata(node: DiscoveryNode | undefined): readonly HarnessComponentKey[] {
  if (node === undefined || node.metadata === undefined) {
    return [];
  }
  const raw = node.metadata.surfaceKeys;
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: HarnessComponentKey[] = [];
  for (const entry of raw) {
    if (isHarnessSurface(entry) && !out.includes(entry)) {
      out.push(entry);
    }
  }
  return out;
}

function stringArrayFromMetadata(
  metadata: ContractMetadata | undefined,
  key: string
): readonly string[] {
  if (metadata === undefined) {
    return [];
  }
  const raw = metadata[key];
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.length > 0 && !out.includes(entry)) {
      out.push(entry);
    }
  }
  return out;
}

/**
 * Apportion a positive capacity over the search tracks.
 *
 * Every track with a non-zero weight receives at least one slot when the
 * capacity allows, then the remaining slots follow the largest-remainder
 * method. Ties break in SEARCH_SLOT_KINDS order so batching is deterministic.
 */
export function apportionSearchSlots(
  capacity: number,
  weights: Readonly<Record<BatchSlotKind, number>>,
  kinds: readonly BatchSlotKind[] = SEARCH_SLOT_KINDS
): Readonly<Record<BatchSlotKind, number>> {
  const counts: Record<BatchSlotKind, number> = {
    exploit: 0,
    explore_domain: 0,
    explore_invariant: 0,
    recover: 0
  };
  const seats = Math.max(0, Math.floor(capacity));
  if (seats === 0 || kinds.length === 0) {
    return counts;
  }
  const active = kinds.filter((kind) => (weights[kind] ?? 0) > 0);
  const pool = active.length > 0 ? active : [kinds[0] as BatchSlotKind];
  if (seats < pool.length) {
    const ranked = [...pool].sort((a, b) => {
      const delta = (weights[b] ?? 0) - (weights[a] ?? 0);
      return delta !== 0 ? delta : kinds.indexOf(a) - kinds.indexOf(b);
    });
    for (let index = 0; index < seats; index += 1) {
      const kind = ranked[index];
      if (kind !== undefined) {
        counts[kind] += 1;
      }
    }
    return counts;
  }
  let totalWeight = 0;
  for (const kind of pool) {
    totalWeight += weights[kind] ?? 0;
  }
  for (const kind of pool) {
    counts[kind] = 1;
  }
  const extra = seats - pool.length;
  if (extra <= 0) {
    return counts;
  }
  if (totalWeight <= 0) {
    const first = pool[0];
    if (first !== undefined) {
      counts[first] += extra;
    }
    return counts;
  }
  const remainders: { kind: BatchSlotKind; remainder: number; order: number }[] = [];
  let used = 0;
  for (const kind of pool) {
    const exact = (extra * (weights[kind] ?? 0)) / totalWeight;
    const base = Math.floor(exact);
    counts[kind] += base;
    used += base;
    remainders.push({ kind, remainder: exact - base, order: kinds.indexOf(kind) });
  }
  remainders.sort((a, b) =>
    b.remainder !== a.remainder ? b.remainder - a.remainder : a.order - b.order
  );
  let left = extra - used;
  let cursor = 0;
  while (left > 0 && remainders.length > 0) {
    const entry = remainders[cursor % remainders.length];
    if (entry !== undefined) {
      counts[entry.kind] += 1;
    }
    left -= 1;
    cursor += 1;
  }
  return counts;
}

/** Overrides accepted by createDefaultPolicy. */
export interface DefaultPolicyOverrides {
  readonly id?: string;
  readonly version?: number;
  readonly parentPolicyId?: string;
  readonly createdAt?: number;
  readonly maxWidth?: number;
  readonly maxDepth?: number;
  readonly slotWeights?: Partial<Record<BatchSlotKind, number>>;
  readonly earlyStopThreshold?: number;
  readonly minMemoryConfidenceForSkip?: number;
  readonly explorationTemperature?: number;
  readonly metadata?: ContractMetadata;
}

/** Build the baseline policy pi^0 from the frozen configuration defaults. */
export function createDefaultPolicy(
  overrides: DefaultPolicyOverrides = {},
  now: () => number = (): number => Date.now()
): MetaSearchPolicy {
  const defaults = DEFAULT_EVO_HARNESS_CONFIG.dreamRsi;
  const weights: Record<BatchSlotKind, number> = {
    exploit: overrides.slotWeights?.exploit ?? DEFAULT_SLOT_WEIGHTS.exploit,
    explore_domain: overrides.slotWeights?.explore_domain ?? DEFAULT_SLOT_WEIGHTS.explore_domain,
    explore_invariant:
      overrides.slotWeights?.explore_invariant ?? DEFAULT_SLOT_WEIGHTS.explore_invariant,
    recover: overrides.slotWeights?.recover ?? DEFAULT_SLOT_WEIGHTS.recover
  };
  const base: MetaSearchPolicy = {
    id: overrides.id ?? 'pi-0',
    version: overrides.version ?? 1,
    createdAt: overrides.createdAt ?? now(),
    maxWidth: overrides.maxWidth ?? defaults.maxWidth,
    maxDepth: overrides.maxDepth ?? defaults.maxDepth,
    slotWeights: weights,
    earlyStopThreshold: overrides.earlyStopThreshold ?? defaults.earlyStopThreshold,
    minMemoryConfidenceForSkip:
      overrides.minMemoryConfidenceForSkip ?? defaults.minMemoryConfidenceForSkip
  };
  const withOptional: MetaSearchPolicy = {
    ...base,
    parentPolicyId: overrides.parentPolicyId,
    explorationTemperature: overrides.explorationTemperature,
    metadata: overrides.metadata
  };
  return withOptional;
}

/** Options for createActivePolicy. */
export interface ActivePolicyOptions {
  readonly policy?: MetaSearchPolicy;
  readonly now?: () => number;
  /** Recovery slots allowed per batch; hard-capped at 1 by the contract. */
  readonly maxRecoverySlots?: number;
  readonly defaultFocusSurfaces?: readonly HarnessComponentKey[];
  readonly policyCount?: number;
}

/** Active policy handle with an audit trail of applied policy ids. */
export interface ActivePolicy extends IActivePolicy {
  readonly appliedPolicyIds: readonly string[];
}

/**
 * True when a repair was already derived from this failed node: it has a child
 * probed from a recover slot or a child whose purpose is 'repair'. A failed node
 * keeps its 'failed' status afterwards, so without this check round 3 would
 * dispatch a second recovery for the same node.
 */
function hasRepairChild(tree: DiscoveryTreeSnapshot, node: DiscoveryNode): boolean {
  for (const childId of node.childIds) {
    const child = tree.nodes[childId];
    if (child === undefined) {
      continue;
    }
    if (child.slot === 'recover' || child.purpose === 'repair') {
      return true;
    }
  }
  return false;
}

class ActivePolicyImpl implements ActivePolicy {
  private current: MetaSearchPolicy;
  private readonly now: () => number;
  private readonly maxRecoverySlots: number;
  private readonly defaultFocusSurfaces: readonly HarnessComponentKey[];
  private readonly applied: string[] = [];

  constructor(options: ActivePolicyOptions) {
    this.current = options.policy ?? createDefaultPolicy({}, options.now);
    const issues = validatePolicy(this.current);
    if (issues.length > 0) {
      throw new PolicyValidationError(issues);
    }
    this.now = options.now ?? ((): number => Date.now());
    const recovery = options.maxRecoverySlots ?? DEFAULT_EVO_HARNESS_CONFIG.dreamRsi.maxRecoverySlots;
    this.maxRecoverySlots = Math.max(0, Math.min(1, Math.floor(finiteOr(recovery, 1))));
    this.defaultFocusSurfaces =
      options.defaultFocusSurfaces ?? DEFAULT_FOCUS_SURFACES;
    this.applied.push(this.current.id + '@' + String(this.current.version));
  }

  get policy(): MetaSearchPolicy {
    return this.current;
  }

  get appliedPolicyIds(): readonly string[] {
    return this.applied;
  }

  /**
   * Size the search grid for one task. Bounded by the policy caps and by the
   * remaining budget; never widens what the policy allows.
   */
  planGrid(request: PlanGridRequest): SearchGridPlan {
    const policy = request.policy;
    const complexity = request.task.complexity ?? 'unknown';
    const factor = COMPLEXITY_FACTORS[complexity];
    const confidence = clamp01(request.memoryConfidence);
    const budgetRemaining = Math.max(0, Math.floor(finiteOr(request.budgetRemaining, 0)));
    const policyWidth = Math.max(0, Math.floor(finiteOr(policy.maxWidth, 0)));
    const policyDepth = Math.max(0, Math.floor(finiteOr(policy.maxDepth, 0)));
    const minConfidence = clamp01(policy.minMemoryConfidenceForSkip);
    const earlyStop = clamp01(policy.earlyStopThreshold);
    const simpleTask = complexity === 'trivial' || complexity === 'simple';
    const skipProbing =
      budgetRemaining > 0 && policyWidth > 0 && simpleTask && confidence >= minConfidence;

    if (skipProbing) {
      return {
        maxWidth: 0,
        maxDepth: 0,
        budget: 0,
        skipProbing: true,
        stopCondition: 'first_success',
        complexity,
        rationale:
          'skip probing: ' +
          complexity +
          ' task with memory confidence ' +
          confidence.toFixed(2) +
          ' >= ' +
          minConfidence.toFixed(2) +
          ' and budget ' +
          String(budgetRemaining),
        policyId: policy.id
      };
    }

    if (budgetRemaining <= 0 || policyWidth <= 0 || policyDepth <= 0) {
      return {
        maxWidth: 0,
        maxDepth: 0,
        budget: 0,
        skipProbing: false,
        stopCondition: 'budget_exhausted',
        complexity,
        rationale:
          'no searchable capacity: budgetRemaining=' +
          String(budgetRemaining) +
          ' policyWidth=' +
          String(policyWidth) +
          ' policyDepth=' +
          String(policyDepth),
        policyId: policy.id
      };
    }

    const confidenceDiscount = 1 - 0.5 * confidence;
    let width = clampInt(policyWidth * factor * confidenceDiscount, 1, policyWidth);
    let depth = clampInt(policyDepth * factor, 1, policyDepth);
    const capacity = Math.max(1, width * depth);
    let budget = Math.max(1, Math.min(capacity, budgetRemaining));
    if (budget < width) {
      width = budget;
    }
    if (budget < depth) {
      depth = budget;
    }
    budget = Math.min(budget, width * depth);

    let stopCondition: StopCondition = 'budget_exhausted';
    if (request.currentDepth >= depth) {
      stopCondition = 'max_depth';
    } else if (confidence >= earlyStop) {
      stopCondition = 'first_success';
    } else if (this.isDiminishing(request, width)) {
      stopCondition = 'diminishing_returns';
    }

    return {
      maxWidth: width,
      maxDepth: depth,
      budget,
      skipProbing: false,
      stopCondition,
      complexity,
      rationale:
        'complexity=' +
        complexity +
        ' factor=' +
        factor.toFixed(2) +
        ' memoryConfidence=' +
        confidence.toFixed(2) +
        ' discount=' +
        confidenceDiscount.toFixed(2) +
        ' -> width=' +
        String(width) +
        ' (cap ' +
        String(policyWidth) +
        ') depth=' +
        String(depth) +
        ' (cap ' +
        String(policyDepth) +
        ') budget=' +
        String(budget) +
        ' remaining=' +
        String(budgetRemaining),
      policyId: policy.id
    };
  }

  /**
   * Compose one round's portfolio: exploit/domain/invariant tracks plus at most
   * one recovery slot. Invariant slots are always guidance_free.
   */
  selectBatch(request: SelectBatchRequest): BatchPlan {
    const policy = this.current;
    const grid = request.grid;
    const createdAt = this.now();
    const policyId = grid.policyId.length > 0 ? grid.policyId : policy.id;
    const widthLimit = Math.max(0, Math.floor(finiteOr(grid.maxWidth, 0)));
    const budget = Math.max(0, Math.floor(finiteOr(grid.budget, 0)));
    const width =
      grid.skipProbing || widthLimit <= 0 || budget <= 0
        ? 0
        : Math.max(0, Math.min(widthLimit, budget));

    if (width <= 0) {
      return {
        round: request.round,
        grid,
        policyId,
        width: 0,
        slots: [],
        createdAt,
        metadata: { reason: grid.skipProbing ? 'skip_probing' : 'no_budget' }
      };
    }

    const recoveryTarget = this.findRecoveryTarget(request);
    const recoveryCount =
      recoveryTarget !== null && width >= 2 ? Math.min(1, this.maxRecoverySlots) : 0;
    const searchCapacity = Math.max(0, width - recoveryCount);
    const weights = normalizeSlotWeights(policy.slotWeights);
    const counts = apportionSearchSlots(searchCapacity, weights);
    const rootId = request.tree.rootId;
    const root = request.tree.nodes[rootId];
    const bestNode = this.resolveBestNode(request, rootId);
    const slots: BatchSlotPlan[] = [];
    let slotIndex = 0;

    for (let index = 0; index < (counts.exploit ?? 0); index += 1) {
      const parent = bestNode ?? root;
      slots.push({
        slot: 'exploit',
        slotIndex,
        branchId: this.branchId(request, slotIndex),
        parentNodeId: parent?.id ?? rootId,
        origin: 'reference',
        guidance: 'memory',
        focusSurfaces: this.focusSurfacesFor(parent),
        rationale:
          'deepen the best known candidate ' +
          String(parent?.id ?? rootId) +
          ' (score ' +
          String(parent?.score ?? 'unscored') +
          ')',
        expectedUtility: this.utilityOf('exploit', weights, request.memoryConfidence),
        seedPatchIds: parent === undefined ? [] : [parent.patchId]
      });
      slotIndex += 1;
    }

    for (let index = 0; index < (counts.explore_domain ?? 0); index += 1) {
      slots.push({
        slot: 'explore_domain',
        slotIndex,
        branchId: this.branchId(request, slotIndex),
        parentNodeId: rootId,
        origin: 'domain',
        guidance: 'memory',
        focusSurfaces: this.focusSurfacesFor(root),
        rationale:
          'fork a memory-guided direction from the root (memoryConfidence ' +
          request.memoryConfidence.toFixed(2) +
          ')',
        expectedUtility: this.utilityOf('explore_domain', weights, request.memoryConfidence),
        memoryHintIds: this.memoryHints(request)
      });
      slotIndex += 1;
    }

    for (let index = 0; index < (counts.explore_invariant ?? 0); index += 1) {
      slots.push({
        slot: 'explore_invariant',
        slotIndex,
        branchId: this.branchId(request, slotIndex),
        parentNodeId: rootId,
        origin: 'invariant',
        guidance: 'guidance_free',
        focusSurfaces: this.focusSurfacesFor(root),
        rationale:
          'first-principles fork from the root with external memory disabled (guidance_free)',
        expectedUtility: this.utilityOf('explore_invariant', weights, request.memoryConfidence)
      });
      slotIndex += 1;
    }

    if (recoveryCount > 0 && recoveryTarget !== null) {
      slots.push({
        slot: 'recover',
        slotIndex,
        branchId: this.branchId(request, slotIndex),
        parentNodeId: recoveryTarget.id,
        origin: recoveryTarget.patchOrigin,
        guidance: recoveryTarget.guidance,
        focusSurfaces: this.focusSurfacesFor(recoveryTarget),
        rationale:
          'targeted repair of ' +
          recoveryTarget.id +
          ' (' +
          String(recoveryTarget.failure?.category ?? 'repairable_implementation') +
          '): ' +
          String(recoveryTarget.failure?.repairHint ?? 'repair the failing artifact'),
        expectedUtility: this.utilityOf('recover', weights, request.memoryConfidence),
        repairOfNodeId: recoveryTarget.id,
        seedPatchIds: [recoveryTarget.patchId]
      });
      slotIndex += 1;
    }

    return {
      round: request.round,
      grid,
      policyId,
      width: slots.length,
      slots,
      createdAt,
      metadata: {
        recoveryCount,
        searchCapacity,
        slotWeights: weights,
        bestNodeId: bestNode?.id ?? rootId
      }
    };
  }

  /** Monotonic upgrade: policy versions may never decrease. */
  update(policy: MetaSearchPolicy): void {
    const issues = validatePolicy(policy);
    if (issues.length > 0) {
      throw new PolicyValidationError(issues);
    }
    if (policy.version < this.current.version) {
      throw new PolicyValidationError([
        'policy version regressed from ' +
          String(this.current.version) +
          ' to ' +
          String(policy.version)
      ]);
    }
    this.current = policy;
    this.applied.push(policy.id + '@' + String(policy.version));
  }

  private isDiminishing(request: PlanGridRequest, width: number): boolean {
    const failures = request.previousFailures ?? [];
    const unpromising = failures.filter(
      (failure) => failure.category === 'repeatedly_unpromising'
    ).length;
    const capacity = Math.max(1, width * Math.max(1, Math.floor(request.policy.maxDepth)));
    return (
      unpromising >= 2 ||
      (failures.length >= 3 && unpromising >= 1 && request.exploredNodes >= capacity)
    );
  }

  private branchId(request: SelectBatchRequest, slotIndex: number): string {
    return (
      request.sessionId +
      '::' +
      request.tree.id +
      '::r' +
      String(request.round) +
      '-s' +
      String(slotIndex)
    );
  }

  private utilityOf(
    kind: BatchSlotKind,
    weights: Readonly<Record<BatchSlotKind, number>>,
    memoryConfidence: number
  ): number {
    let sum = 0;
    for (const slotKind of BATCH_SLOT_KINDS) {
      sum += weights[slotKind] ?? 0;
    }
    const share = sum > 0 ? (weights[kind] ?? 0) / sum : 0;
    const confidence = clamp01(memoryConfidence);
    if (kind === 'explore_domain') {
      return clamp01(share * (0.5 + 0.5 * confidence));
    }
    if (kind === 'explore_invariant') {
      return clamp01(share * (0.5 + 0.5 * (1 - confidence)));
    }
    return clamp01(share);
  }

  private focusSurfacesFor(node: DiscoveryNode | undefined): readonly HarnessComponentKey[] {
    const hinted = surfacesFromMetadata(node);
    return hinted.length > 0 ? hinted : this.defaultFocusSurfaces;
  }

  private memoryHints(request: SelectBatchRequest): readonly string[] {
    const fromRequest = stringArrayFromMetadata(request.metadata, 'memoryHintIds');
    if (fromRequest.length > 0) {
      return fromRequest;
    }
    return stringArrayFromMetadata(request.tree.metadata, 'memoryHintIds');
  }

  /**
   * Resolve the exploitation base for this batch. Only a node that actually
   * succeeded qualifies: a failed node is dead evidence and belongs to the
   * recovery track, so the explicit previousBestNodeId hint is honoured only
   * while it still qualifies and the scan falls back to the root when no
   * succeeded candidate exists.
   */
  private resolveBestNode(
    request: SelectBatchRequest,
    rootId: string
  ): DiscoveryNode | undefined {
    const explicitId = request.previousBestNodeId;
    if (explicitId !== undefined) {
      const explicit = request.tree.nodes[explicitId];
      if (explicit !== undefined && explicit.status === 'succeeded') {
        return explicit;
      }
    }
    let best: DiscoveryNode | undefined;
    for (const node of Object.values(request.tree.nodes)) {
      if (node.status !== 'succeeded') {
        continue;
      }
      if (best === undefined) {
        best = node;
        continue;
      }
      const score = node.score ?? 0;
      const bestScore = best.score ?? 0;
      if (score > bestScore) {
        best = node;
      } else if (score === bestScore && node.createdAt < best.createdAt) {
        best = node;
      }
    }
    return best ?? request.tree.nodes[rootId];
  }

  /**
   * Resolve the single node a recovery slot should repair.
   *
   * Targeting order:
   * 1. an explicit metadata.repairNodeId / previousFailureNodeId wins; it is an
   *    escape hatch and is honoured even for a node that was already repaired;
   * 2. otherwise the most recently updated failed node whose diagnosis is
   *    repairable and that has not been repaired yet (no child with slot
   *    'recover' and no child with purpose 'repair').
   *
   * request.previousFailure deliberately no longer gates the scan: the
   * orchestrator replaces it with whatever the latest sibling slot reported, and
   * a sibling's non-repairable diagnosis must not hide an older repairable
   * failure. When no node is eligible the method returns null anyway, so a tree
   * with only non-repairable failures still produces no recovery slot.
   */
  private findRecoveryTarget(request: SelectBatchRequest): DiscoveryNode | null {
    const explicitId =
      typeof request.metadata?.repairNodeId === 'string'
        ? request.metadata.repairNodeId
        : typeof request.metadata?.previousFailureNodeId === 'string'
          ? request.metadata.previousFailureNodeId
          : undefined;
    if (explicitId !== undefined) {
      const explicit = request.tree.nodes[explicitId];
      if (explicit !== undefined) {
        return explicit;
      }
    }
    let candidate: DiscoveryNode | undefined;
    for (const node of Object.values(request.tree.nodes)) {
      if (node.status !== 'failed') {
        continue;
      }
      const diagnosis: FailureDiagnosis | undefined = node.failure;
      if (diagnosis === undefined || !diagnosis.repairable) {
        continue;
      }
      if (hasRepairChild(request.tree, node)) {
        continue;
      }
      if (candidate === undefined || node.updatedAt > candidate.updatedAt) {
        candidate = node;
      }
    }
    return candidate ?? null;
  }
}

/** Create the online active policy pi_t. */
export function createActivePolicy(options: ActivePolicyOptions = {}): ActivePolicy {
  return new ActivePolicyImpl(options);
}

/** Convenience: build pi^0 and wrap it in an active policy. */
export function createActivePolicyFromDefaults(
  overrides: DefaultPolicyOverrides = {},
  options: Omit<ActivePolicyOptions, 'policy'> = {}
): ActivePolicy {
  return createActivePolicy({ ...options, policy: createDefaultPolicy(overrides, options.now) });
}

/** Origin that a slot family implies. */
export function originForSlot(kind: BatchSlotKind): PatchOrigin {
  switch (kind) {
    case 'exploit':
      return 'reference';
    case 'explore_domain':
      return 'domain';
    case 'explore_invariant':
      return 'invariant';
    case 'recover':
    default:
      return 'reference';
  }
}
