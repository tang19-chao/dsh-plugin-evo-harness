/**
 * JitRL L1 meta-scheduling decorator (plan sections 3.1, 6.4 and 8 Phase 2).
 *
 * Ownership: src/jitrl/** (Phase 2, L1).
 *
 * ActivePolicy.selectBatch() is the L1 decision point: it apportions one round's
 * search capacity over the four slot kinds. This module wraps an existing policy
 * in the decorator pattern - src/dream-rsi/active-policy.ts is never modified -
 * and corrects the slot weights with the JitRL closed form:
 *
 *   1. the inner policy produces the unadjusted batch plan (the baseline);
 *   2. the decision point is abstracted into a MetaState and the four slot kinds
 *      become candidates whose prior logit z is policyPriorLogit();
 *   3. composeDecision() returns z' = center(z) + beta * A-tilde with the
 *      diagnostic KL(pi' || pi_prior);
 *   4. softmax(z') becomes the adjusted slot weight vector, which a short-lived
 *      derived policy (built through the public createActivePolicy factory)
 *      feeds into exactly the same apportionment.
 *
 * Hard invariants:
 * - planGrid/update/policy delegate unchanged, and BatchPlan.policyId stays the
 *   BASE policy id: tree lineage and the offline dreamer key on it.
 * - inner.update() is never called for a Jit decision. The derived policy is a
 *   throw-away instance cached by policy id@version + weight signature.
 * - A derived policy that fails validation falls back to the baseline plan with
 *   metadata.jit.degraded = true and a recorded reason.
 * - When the correction is a no-op (cold start, beta = 0, every A-tilde = 0, so
 *   KL is exactly 0) the baseline plan is returned untouched apart from the
 *   additive metadata.jit diagnostics; slots are then byte-identical.
 * - Only slot weights move: width, budget, the recovery cap, invariant
 *   guidance_free and focus surfaces all come from the unchanged inner policy.
 * - Jit diagnostics live in BatchPlan.metadata.jit and never in a composer
 *   prompt (plan section 7.4).
 */

import {
  BATCH_SLOT_KINDS,
  HARNESS_COMPONENT_KEYS,
  type AbstractState,
  type BatchPlan,
  type BatchSlotKind,
  type BatchSlotPlan,
  type ExperienceRecord,
  type HarnessComponentKey,
  type IActivePolicy,
  type JitCandidate,
  type JitDecision,
  type MetaSearchPolicy,
  type PlanGridRequest,
  type ScoredExperience,
  type SearchGridPlan,
  type SelectBatchRequest
} from '../types/contracts';
import { DEFAULT_EVO_HARNESS_CONFIG } from '../config';
import {
  createActivePolicy,
  DEFAULT_FOCUS_SURFACES,
  normalizeSlotWeights,
  type ActivePolicy
} from '../dream-rsi/active-policy';
import { normalizeMetaAction } from './action-normalizer';
import { policyPriorLogit } from './logit-sources';
import {
  learningFacingFilterOptions,
  projectNeighborsBySlotKind,
  runDecisionKernel,
  slotWeightsFromDecision,
  type EffectivePolicyConfigProvider,
  type LayerDecisionConfig,
  type DualTrackConsumptionOptions,
  type AtomicTrackSelectionVerdict
} from './decision-kernel';
import { isOnLearningTrack, PRODUCTION_LEARNING_TRACK } from './experience-store';
import {
  abstractMetaState,
  type JitReferenceStatus,
  type MetaStateInput,
  type ParentFailureLike
} from './state-abstraction';

/** Metadata key carrying the L1 diagnostics inside BatchPlan.metadata. */
export const JIT_BATCH_METADATA_KEY = 'jit';

/** Prefix every normalized L1 action key starts with. */
const META_ACTION_PREFIX = 'slot:';
const SURFACE_SUFFIX = '/surf:';

const REFERENCE_STATUSES: readonly JitReferenceStatus[] = [
  'succeeded',
  'failed',
  'timeout',
  'aborted',
  'missing'
];

/** Frozen defaults mirrored from config.jitrl; callers should pass config values. */
const JIT = DEFAULT_EVO_HARNESS_CONFIG.jitrl;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isReferenceStatus(value: unknown): value is JitReferenceStatus {
  return (
    typeof value === 'string' &&
    (REFERENCE_STATUSES as readonly string[]).includes(value)
  );
}

function isHarnessSurface(value: unknown): value is HarnessComponentKey {
  return (
    typeof value === 'string' &&
    (HARNESS_COMPONENT_KEYS as readonly string[]).includes(value)
  );
}

function isKnownCategory(value: unknown): value is ParentFailureLike['category'] {
  return typeof value === 'string' && value.length > 0;
}

/** One meta action: the slot kind plus the focus surfaces it would touch. */
export interface MetaActionPayload {
  readonly slotKind: BatchSlotKind;
  readonly focusSurfaces: readonly HarnessComponentKey[];
}

/** JSON-safe L1 diagnostics attached to BatchPlan.metadata.jit. */
export interface JitBatchDiagnostics {
  readonly level: 'meta';
  readonly stateValue: number;
  readonly neighborCount: number;
  readonly klToPrior: number;
  readonly adjustments: readonly JitBatchAdjustment[];
  readonly rationale: string;
  readonly trackSelection?: AtomicTrackSelectionVerdict<unknown>;
  readonly degraded?: boolean;
  readonly degradedReason?: string;
  /**
   * P6 PR5 (plan section 7.3): version tag of the EffectivePolicyConfig this
   * decision actually consumed (`<policyId>@v<version>`). Present on every
   * decision the decorator takes, so a log line can be traced to the exact
   * configuration that produced it; absent only on legacy degraded paths that
   * never got as far as resolving a configuration.
   */
  readonly policyVersion?: string;
  /** Dimensions deliberately left out of this round's search grid (§7.2). */
  readonly ignoredDimensions?: readonly string[];
  /** Server-side filter trace: how many records survived and why. */
  readonly filter?: {
    readonly records: number;
    readonly kept: number;
    /** True when legacy evidence was excluded from the neighbourhood (§6.5). */
    readonly excludeLegacy?: boolean;
    /** True when non-learning evidence was excluded (§6.2). */
    readonly learningEligibleOnly?: boolean;
  };
}

/** One per-slot diagnostic line; mirrors JitAdjustment with the action key inlined. */
export interface JitBatchAdjustment {
  readonly actionKey: string;
  readonly slotKind: BatchSlotKind;
  /**
   * Candidate source from the logit source (plan section 13.1 '来源' column):
   * llm | policy_prior | memory_augmented. Optional for backward compatibility
   * with diagnostics produced before P3-E2.
   */
  readonly source?: 'llm' | 'policy_prior' | 'memory_augmented';
  /**
   * Focus surfaces this action stands for. Present only when the surface action
   * space is enabled; the chosen entry drives the write-back onto the plan.
   */
  readonly focusSurfaces?: readonly HarnessComponentKey[];
  readonly q: number | null;
  readonly advantage: number;
  readonly normalizedAdvantage: number;
  readonly adjustedLogit: number;
  readonly probability: number;
  readonly support: number;
  /**
   * P6.2 C0 (ADR 0002 R5): Kish effective sample size behind this action's Q,
   * carried into the L1 diagnostics so the ledger co-reports support and nEff
   * on every L1 decision.
   */
  readonly nEff?: number;
  readonly explored: boolean;
}

/** Live counters for the derived-policy cache (payload free, JSON-safe). */
export interface DerivedCacheStats {
  /** Entries currently retained; never exceeds maxEntries. */
  readonly size: number;
  /** Hard upper bound on retained derived policies. */
  readonly maxEntries: number;
  /** Lookups that found a live entry. */
  readonly hits: number;
  /** Lookups that had to build a derived policy. */
  readonly misses: number;
  /** Entries dropped because the bound was reached. */
  readonly evictions: number;
}

/** The decorator handle: an IActivePolicy plus its L1 diagnostics surface. */
export interface JitActivePolicy extends IActivePolicy {
  /** L1 decisions taken so far, oldest first (payload free). */
  readonly decisions: readonly JitBatchDiagnostics[];
  /** Human-readable notices produced by the decorator (payload free). */
  diagnostics(): readonly string[];
  /**
   * Live derived-policy cache counters. The cache is bounded (LRU) because a
   * running host keeps producing new weight vectors; this is the surface a
   * /evo jit status command reads.
   */
  cacheStats(): DerivedCacheStats;
  /** The wrapped policy; unchanged surfaces are delegated to it. */
  readonly inner: IActivePolicy;
}

/** Experience snapshot source: a provider, a plain array or a store handle. */
export type ExperienceSnapshotSource =
  | readonly ExperienceRecord[]
  | (() => readonly ExperienceRecord[])
  | { readonly snapshot?: () => readonly ExperienceRecord[] };

/** L1 tunables mirrored from config.jitrl. */
export interface JitActivePolicyConfig {
  /** KL temperature multiplying the normalized advantage (config jitrl.beta). */
  readonly beta?: number;
  /** Neighbour count (config jitrl.k). */
  readonly k?: number;
  /** Minimum Jaccard similarity (config jitrl.similarityThreshold). */
  readonly similarityThreshold?: number;
  /** Candidate selection rule (config jitrl.selection). */
  readonly selection?: 'argmax' | 'sample';
  /** Exploration probability (config jitrl.exploration.lambda). */
  readonly lambda?: number;
  /** Exploration bonus scale (config jitrl.exploration.alpha). */
  readonly alpha?: number;
  /** Unseen-action value (config jitrl.unseenFallback). */
  readonly unseenFallback?: 'zero' | 'baseline';
  /** Retrieval half-life in ms (config jitrl.store.halfLifeDays). */
  readonly halfLifeMs?: number;
  /** Causal cutoff applied to the experience snapshot (plan section 7.3). */
  readonly before?: number;
  /** Restrict candidates to the bare slot kinds (no surface suffix). */
  readonly useSurfaces?: boolean;
  /**
   * Plan section 3.1 action space: when true the candidate set becomes
   * slotKind x focusSurface (up to 4 x 8 = 32 actions) instead of one candidate
   * per slot kind, and the chosen action's surfaces are written back onto the
   * batch plan. Defaults to false, which reproduces the pre-G2-1 behaviour
   * byte for byte.
   */
  readonly surfaceActions?: boolean;
  /**
   * Maximum derived policies retained by the LRU cache. A derived policy is
   * cheap to rebuild, so a small bound keeps memory flat while still covering
   * the handful of weight vectors a stable history actually repeats.
   */
  readonly derivedCacheEntries?: number;
}

/** Construction options for createJitActivePolicy. */
export interface JitActivePolicyOptions {
  /** Base policy; every unchanged decision is delegated to it. */
  readonly inner: IActivePolicy;
  /** Experience snapshot (L1 records); absent means a permanent cold start. */
  readonly experiences?: ExperienceSnapshotSource;
  readonly config?: JitActivePolicyConfig;
  /** Injected clock; defaults to Date.now. */
  readonly now?: () => number;
  /** Injected randomness for optimistic exploration; defaults to Math.random. */
  readonly rng?: () => number;
  /**
   * Runtime switch consulted on every selectBatch (plan section 13.1). While it
   * returns false the inner policy's plan is returned untouched: no metadata.jit,
   * no history entry, no diagnostics. Defaults to always-on.
   */
  readonly isRuntimeEnabled?: () => boolean;
  /**
   * t10/R1b (ADR 0002 §3 baseline 行, option ①): the EXECUTION-interception
   * switch. While it returns false the decorator behaves exactly like the
   * runtime-off path - the inner plan is returned byte-identical (no L1
   * adjustment, no metadata.jit, no history entry) even though the kernel is
   * configured and the volatile switch is on. The wiring point is the plugin
   * entry: only a guarded-active profile intercepts; baseline/shadow return
   * the unadjusted plan (shadow still records suggestions elsewhere, baseline
   * records audit-level only). Defaults to true (intercept) so the pre-t10
   * behaviour is unchanged for callers that do not wire the profile.
   */
  readonly interceptExecution?: () => boolean;
  /** Recovery slots the derived policy may schedule (config dreamRsi). */
  readonly maxRecoverySlots?: number;
  /** Surfaces the derived policy falls back to when the tree hints none. */
  readonly defaultFocusSurfaces?: readonly HarnessComponentKey[];
  /** Diagnostic sink; the same notices are also kept in diagnostics(). */
  readonly onDiagnostic?: (message: string) => void;
  /**
   * P6 PR5 (plan section 7.3): versioned effective-configuration provider. When
   * supplied it is read once per decision, so the decorator always consumes the
   * currently published L1 configuration and records its version tag. Absent
   * keeps the pre-PR5 behaviour (construction config merged with policy.jit).
   */
  readonly policyConfigProvider?: EffectivePolicyConfigProvider;
  /** C2b (ADR 0004 §8): Dual-track consumption options */
  readonly dualTrack?: DualTrackConsumptionOptions;
}

function resolveSnapshot(source: ExperienceSnapshotSource | undefined): readonly ExperienceRecord[] {
  if (source === undefined) {
    return [];
  }
  if (Array.isArray(source)) {
    return source as readonly ExperienceRecord[];
  }
  if (typeof source === 'function') {
    const records = (source as () => readonly ExperienceRecord[])();
    return Array.isArray(records) ? records : [];
  }
  const snapshot = (source as { snapshot?: () => readonly ExperienceRecord[] }).snapshot;
  if (typeof snapshot !== 'function') {
    return [];
  }
  const records = snapshot.call(source);
  return Array.isArray(records) ? records : [];
}

/** Focus surfaces recorded on the tree root, or the frozen defaults. */
function treeSurfaces(request: SelectBatchRequest): readonly HarnessComponentKey[] {
  const root = request.tree.nodes[request.tree.rootId];
  const raw = root?.metadata?.surfaceKeys;
  if (!Array.isArray(raw)) {
    return DEFAULT_FOCUS_SURFACES;
  }
  const out: HarnessComponentKey[] = [];
  for (const entry of raw) {
    if (isHarnessSurface(entry) && !out.includes(entry)) {
      out.push(entry);
    }
  }
  return out.length > 0 ? out : DEFAULT_FOCUS_SURFACES;
}

/** Focus surfaces the baseline plan already assigned to one slot kind. */
function surfacesForKind(
  slots: readonly BatchSlotPlan[],
  kind: BatchSlotKind,
  fallback: readonly HarnessComponentKey[]
): readonly HarnessComponentKey[] {
  for (const slot of slots) {
    if (slot.slot !== kind) {
      continue;
    }
    const filtered = slot.focusSurfaces.filter(isHarnessSurface);
    return filtered.length > 0 ? filtered : fallback;
  }
  return fallback;
}

/**
 * The slot kind encoded in a normalized L1 action key, if any. A key of the
 * shape 'slot:<kind>' or 'slot:<kind>/surf:<a>+<b>' resolves to its kind; any
 * other shape (including an L2/L3 key) yields undefined.
 */
export function slotKindOfActionKey(actionKey: string): BatchSlotKind | undefined {
  if (!actionKey.startsWith(META_ACTION_PREFIX)) {
    return undefined;
  }
  const rest = actionKey.slice(META_ACTION_PREFIX.length);
  const suffixAt = rest.indexOf(SURFACE_SUFFIX);
  const head = suffixAt < 0 ? rest : rest.slice(0, suffixAt);
  const candidate = BATCH_SLOT_KINDS.find((kind) => kind === head);
  return candidate;
}

/**
 * Build the L1 abstract state for one batch request. Every field degrades
 * deterministically when the orchestrator does not supply it: an absent
 * reference status means 'missing' and an absent tool-error rate means 0.
 */
export function buildMetaState(request: SelectBatchRequest): AbstractState {
  const metadata = isRecord(request.metadata) ? request.metadata : undefined;
  const parentId = request.previousBestNodeId;
  const parent =
    parentId === undefined ? undefined : request.tree.nodes[parentId];
  const category = parent?.failure?.category;
  const input: MetaStateInput = {
    task: request.task,
    round: finiteOr(request.round, 0),
    parentDepth: parent === undefined ? 0 : finiteOr(parent.depth, 0),
    ...(parent?.slot === undefined ? {} : { parentSlot: parent.slot }),
    ...(category === undefined || !isKnownCategory(category)
      ? {}
      : { parentFailure: { category } }),
    memoryConfidence: finiteOr(request.memoryConfidence, 0),
    referenceStatus: isReferenceStatus(metadata?.referenceStatus)
      ? metadata.referenceStatus
      : 'missing',
    ...(typeof metadata?.referenceToolErrorRate === 'number' &&
    Number.isFinite(metadata.referenceToolErrorRate)
      ? { referenceToolErrorRate: metadata.referenceToolErrorRate }
      : {})
  };
  return abstractMetaState(input);
}

interface ResolvedConfig {
  readonly beta: number;
  readonly k: number;
  readonly similarityThreshold: number;
  readonly selection: 'argmax' | 'sample';
  readonly lambda: number;
  readonly alpha: number;
  readonly unseenFallback: 'zero' | 'baseline';
  readonly halfLifeMs: number;
  readonly before: number | undefined;
  readonly useSurfaces: boolean;
  readonly surfaceActions: boolean;
}

/** Project the layer config the kernel consumes back onto the decorator knobs. */
function layerFromResolved(config: ResolvedConfig): LayerDecisionConfig {
  return {
    beta: config.beta,
    k: config.k,
    similarityThreshold: config.similarityThreshold,
    selection: config.selection,
    lambda: config.lambda,
    alpha: config.alpha,
    unseenFallback: config.unseenFallback,
    halfLifeMs: config.halfLifeMs,
    ...(config.before === undefined ? {} : { before: config.before })
  };
}

function resolveConfig(config: JitActivePolicyConfig): ResolvedConfig {
  return {
    beta: finiteOr(config.beta, JIT.beta),
    k: Math.max(1, Math.floor(finiteOr(config.k, JIT.k))),
    similarityThreshold: finiteOr(config.similarityThreshold, JIT.similarityThreshold),
    selection: config.selection ?? JIT.selection,
    lambda: finiteOr(config.lambda, JIT.exploration.lambda),
    alpha: finiteOr(config.alpha, JIT.exploration.alpha),
    unseenFallback: config.unseenFallback ?? JIT.unseenFallback,
    halfLifeMs: Math.max(
      0,
      finiteOr(config.halfLifeMs, JIT.store.halfLifeDays * 24 * 60 * 60 * 1000)
    ),
    before: config.before,
    useSurfaces: config.useSurfaces ?? true,
    surfaceActions: config.surfaceActions ?? false
  };
}

/** Weight signature used as the derived-policy cache key. */
function weightSignature(weights: Readonly<Record<BatchSlotKind, number>>): string {
  return BATCH_SLOT_KINDS.map((kind) => (weights[kind] ?? 0).toPrecision(12)).join(',');
}

/** Default number of derived policies retained (config jitrl, override per policy). */
export const DEFAULT_DERIVED_CACHE_ENTRIES = 32;

/** Hard bounds for the configured cache size. */
export const MIN_DERIVED_CACHE_ENTRIES = 1;
export const MAX_DERIVED_CACHE_ENTRIES = 256;

function resolveCacheEntries(configured: number | undefined): number {
  const raw = Number.isFinite(configured)
    ? Math.floor(configured as number)
    : DEFAULT_DERIVED_CACHE_ENTRIES;
  return Math.min(
    MAX_DERIVED_CACHE_ENTRIES,
    Math.max(MIN_DERIVED_CACHE_ENTRIES, raw)
  );
}

/**
 * Bounded LRU over derived policies (repair B3).
 *
 * A running host keeps producing fresh weight vectors - `selection: 'sample'`
 * and a continuously growing experience store both make that the steady state -
 * so an unbounded map would retain one ActivePolicy per distinct vector for the
 * lifetime of the plugin. A derived policy costs one validatePolicy() plus a
 * constructor call, so evicting the least recently used entry is always cheaper
 * than the memory it frees.
 *
 * Recency is tracked by Map insertion order: a hit re-inserts the entry, so the
 * first key is always the least recently used one.
 */
class DerivedPolicyCache {
  private readonly entries = new Map<string, ActivePolicy>();
  private readonly maxEntries: number;
  private hitCount = 0;
  private missCount = 0;
  private evictionCount = 0;

  constructor(maxEntries: number) {
    this.maxEntries = resolveCacheEntries(maxEntries);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Read a retained policy without affecting recency or the hit counter. */
  peek(key: string): ActivePolicy | undefined {
    return this.entries.get(key);
  }

  /** Mark a retained policy as the most recently used and return it. */
  touch(key: string, policy: ActivePolicy): ActivePolicy {
    this.hitCount += 1;
    this.entries.delete(key);
    this.entries.set(key, policy);
    return policy;
  }

  /** Insert a freshly built policy, evicting the LRU entry beyond the bound. */
  insert(key: string, policy: ActivePolicy): void {
    this.missCount += 1;
    this.entries.delete(key);
    this.entries.set(key, policy);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.entries.delete(oldest.value);
      this.evictionCount += 1;
    }
  }

  /** Drop everything (a policy update invalidates every derived identity). */
  reset(): void {
    this.entries.clear();
    this.hitCount = 0;
    this.missCount = 0;
    this.evictionCount = 0;
  }

  stats(): DerivedCacheStats {
    return {
      size: this.entries.size,
      maxEntries: this.maxEntries,
      hits: this.hitCount,
      misses: this.missCount,
      evictions: this.evictionCount
    };
  }
}

class JitActivePolicyImpl implements JitActivePolicy {
  private readonly base: IActivePolicy;
  private readonly options: JitActivePolicyOptions;
  private readonly config: ResolvedConfig;
  private readonly now: () => number;
  private readonly rng: () => number;
  private readonly history: JitBatchDiagnostics[] = [];
  private readonly notices: string[] = [];
  private readonly derivedCache: DerivedPolicyCache;

  constructor(options: JitActivePolicyOptions) {
    this.base = options.inner;
    this.options = options;
    this.config = resolveConfig(options.config ?? {});
    this.now = options.now ?? ((): number => Date.now());
    this.rng = options.rng ?? ((): number => Math.random());
    this.derivedCache = new DerivedPolicyCache(
      resolveCacheEntries(options.config?.derivedCacheEntries)
    );
  }

  get inner(): IActivePolicy {
    return this.base;
  }

  get policy(): MetaSearchPolicy {
    return this.base.policy;
  }

  get decisions(): readonly JitBatchDiagnostics[] {
    return [...this.history];
  }

  diagnostics(): readonly string[] {
    return [...this.notices];
  }

  cacheStats(): DerivedCacheStats {
    return this.derivedCache.stats();
  }

  planGrid(request: PlanGridRequest): SearchGridPlan {
    return this.base.planGrid(request);
  }

  /** Monotonic upgrade delegates to the base policy; Jit never owns versions. */
  update(policy: MetaSearchPolicy): void {
    this.base.update(policy);
    this.derivedCache.reset();
  }

  /**
   * Resolve the L1 configuration this decision consumes (repair H1 + P6 PR5).
   *
   * Two sources, in order of authority:
   *
   * 1. P6 PR5: when a `policyConfigProvider` is injected, it is read once per
   *    decision. The provider holds the currently published configuration and its
   *    version tag, so an `update()`-driven hot swap is visible on this very
   *    decision *and* the decision records which version it consumed. That is
   *    the plan section 7.3 contract; the provider is the single authority.
   * 2. Without a provider (pre-PR5 wiring, hand-built decorators, unit tests),
   *    fall back to merging the live policy's `jit` block over the construction
   *    config field by field. This preserves repair H1 exactly.
   *
   * `gamma` is deliberately not mapped: it scales the return discount used by
   * the offline dreamer and the step evaluator, neither of which this decorator
   * calls, so it has no online counterpart here (plan section 7.2 keeps gamma
   * frozen this round; see POLICY_IGNORED_DIMENSIONS).
   */
  private effectiveConfig(policy: MetaSearchPolicy): {
    readonly config: ResolvedConfig;
    readonly policyVersion: string | undefined;
  } {
    const provider = this.options.policyConfigProvider;
    if (provider !== undefined) {
      const effective = provider.current('level1');
      const layer = effective.level1;
      return {
        config: {
          ...this.config,
          beta: layer.beta,
          k: layer.k,
          similarityThreshold: layer.similarityThreshold,
          selection: layer.selection,
          lambda: layer.lambda,
          alpha: layer.alpha,
          unseenFallback: layer.unseenFallback,
          halfLifeMs: layer.halfLifeMs,
          before: layer.before ?? this.config.before
        },
        policyVersion: effective.versionTag
      };
    }
    const jit = policy.jit;
    if (jit === undefined) {
      return { config: this.config, policyVersion: undefined };
    }
    return {
      config: {
        ...this.config,
        beta: finiteOr(jit.beta, this.config.beta),
        k: Math.max(1, Math.floor(finiteOr(jit.k, this.config.k))),
        similarityThreshold: finiteOr(jit.similarityThreshold, this.config.similarityThreshold),
        lambda: finiteOr(jit.lambda, this.config.lambda),
        alpha: finiteOr(jit.alpha, this.config.alpha)
      },
      policyVersion: undefined
    };
  }

  /** Plan section 13.1 runtime switch; defaults to enabled on any doubt. */
  private runtimeEnabled(): boolean {
    const check = this.options.isRuntimeEnabled;
    if (check === undefined) {
      return true;
    }
    try {
      return check() !== false;
    } catch {
      return true;
    }
  }

  /**
   * t10/R1b: the execution-interception switch (see JitActivePolicyOptions).
   * A throwing check fails OPEN? No - it fails CLOSED to no-interception, so a
   * broken wiring can never re-enable an execution-side effect (the same
   * failure direction as orchestrator.surfaceEnabled).
   */
  private interceptsExecution(): boolean {
    const check = this.options.interceptExecution;
    if (check === undefined) {
      return true;
    }
    try {
      return check() !== false;
    } catch {
      return false;
    }
  }

  selectBatch(request: SelectBatchRequest): BatchPlan {
    const baseline = this.base.selectBatch(request);
    // Runtime off (/evo jit off): return the baseline untouched, with no
    // metadata.jit and no history entry, so /evo jit on restores immediately.
    if (!this.runtimeEnabled()) {
      return baseline;
    }
    // t10/R1b (ADR 0002 §3 baseline 行): a declared baseline/shadow-free
    // assembly must NOT adjust the plan either - the inner policy's plan is
    // returned byte-identical (no L1 correction, no metadata.jit). Only
    // guarded-active intercepts.
    if (!this.interceptsExecution()) {
      return baseline;
    }
    if (baseline.width <= 0 || baseline.slots.length === 0) {
      return baseline;
    }
    try {
      return this.adjust(request, baseline);
    } catch (error) {
      const reason =
        error instanceof Error ? error.name + ': ' + error.message : String(error);
      this.notice('jit_meta_adjust: degraded to the unadjusted plan (' + reason + ')');
      return this.degraded(baseline, reason);
    }
  }

  /** One L1 correction: abstract, decide, re-apportion, attach diagnostics. */
  private adjust(request: SelectBatchRequest, baseline: BatchPlan): BatchPlan {
    const policy = this.base.policy;
    // Repair H1 + P6 PR5: resolve the configuration from the *current* published
    // version so a hot swap takes effect on this very decision, and keep the
    // version tag so the diagnostics can record what was actually consumed.
    const resolved = this.effectiveConfig(policy);
    const config = resolved.config;
    const state = buildMetaState(request);
    const candidates = this.candidates(baseline, request, policy, config);
    // P6 PR5 / plan section 7.1: the SAME pure kernel Dream replay calls. Online
    // supplies the current snapshot; replay supplies a causally truncated one.
    // The neighbour projection (exact action key first, then slot kind) is the
    // only L1-specific step, and it is passed in as a documented extension
    // point instead of being a second retrieval algorithm.
    const kernel = runDecisionKernel({
      level: 'meta',
      state,
      candidates,
      // P6.2 t7/V3 (ADR 0002 5.2a-4): the L1 neighbourhood is a PROCESS
      // estimate. The snapshot is pre-filtered HERE (the kernel's shared
      // filter stays untouched - R6: the frozen research path calls the same
      // kernel directly and must not change behaviour): undeclared records
      // keep flowing (the pre-existing eligibility path) but a task-quality
      // record never enters an online L1 estimate.
      records:
        this.options.dualTrack?.enableQualityTrackConsumption === true
          ? resolveSnapshot(this.options.experiences)
          : resolveSnapshot(this.options.experiences).filter((entry) =>
              isOnLearningTrack(entry, PRODUCTION_LEARNING_TRACK)
            ),
      config: layerFromResolved(config),
      ...(resolved.policyVersion === undefined
        ? {}
        : { policyVersion: resolved.policyVersion }),
      now: this.now(),
      rng: this.rng,
      // Learning-facing decision (plan sections 6.2, 6.5 and 7.5): the L1
      // neighbourhood must not contain legacy evidence (written under an older
      // reward/provenance model) or records that were never a quality signal
      // (user cancellation, infrastructure failure). Dream replay applies the
      // same filter, which is what keeps offline and online on one evidence set.
      ...learningFacingFilterOptions(),
      projectNeighbors: (neighbors, projected) =>
        this.alignNeighbors(neighbors, projected),
      ...(this.options.dualTrack === undefined ? {} : { dualTrack: this.options.dualTrack })
    });
    const decision = kernel.decision;
    const diagnostics = toDiagnostics(decision, candidates, config.surfaceActions, {
      ...(resolved.policyVersion === undefined
        ? {}
        : { policyVersion: resolved.policyVersion }),
      ignoredDimensions: kernel.ignored.map((entry) => entry.dimension),
      ...(kernel.trackSelection === undefined ? {} : { trackSelection: kernel.trackSelection }),
      filter: {
        records: kernel.filters.records,
        kept: kernel.filters.kept,
        excludeLegacy: kernel.filters.excludeLegacy,
        learningEligibleOnly: kernel.filters.learningEligibleOnly
      }
    });

    // A no-op correction must leave the plan byte-identical: with every
    // advantage zero the softmax of z' is the prior itself, so KL is exactly 0.
    if (diagnostics.klToPrior === 0) {
      this.history.push(diagnostics);
      return withJitMetadata(baseline, diagnostics);
    }

    const weights = weightsFromDecision(decision, candidates);
    const plan = this.reapportion(request, weights, resolved.policyVersion);
    if (plan === undefined) {
      const reason =
        'the adjusted slot weights failed validation; kept the unadjusted plan';
      this.notice('jit_meta_adjust: ' + reason);
      return this.degraded(baseline, reason, diagnostics);
    }
    this.history.push(diagnostics);
    // Plan section 3.1: the adjusted distribution also covers focus surfaces,
    // so the chosen action's surfaces land on the produced slots - clipped to
    // what the baseline offered (never fabricating an unsupported surface).
    if (!config.surfaceActions) {
      return withJitMetadata(plan, diagnostics);
    }
    const chosenKey = decision.chosen.candidate.actionKey;
    const chosen = diagnostics.adjustments.find((entry) => entry.actionKey === chosenKey);
    const surfaceReady =
      chosen === undefined
        ? plan
        : withChosenSurfaces(plan, chosen, offeredSurfaces(baseline));
    return withJitMetadata(surfaceReady, diagnostics);
  }

  /**
   * L1 candidates with their policy-prior logits.
   *
   * Default (surfaceActions = false): one candidate per slot kind, carrying the
   * surfaces the baseline plan already focused - the pre-G2-1 action space.
   *
   * Plan section 3.1 (surfaceActions = true): one candidate per
   * slotKind x focusSurface, up to 4 x 8 = 32 actions. The kind's prior logit is
   * split across its surfaces by subtracting ln(|surfaces|), which leaves the
   * kind's total probability mass equal to its prior whenever every advantage is
   * zero (the split is uniform because L1 has no explicit surface prior yet, and
   * the subtraction is distribution-preserving rather than normalising).
   */
  private candidates(
    baseline: BatchPlan,
    request: SelectBatchRequest,
    policy: MetaSearchPolicy,
    config: ResolvedConfig
  ): readonly JitCandidate<MetaActionPayload>[] {
    const fallback = treeSurfaces(request);
    const weights = normalizeSlotWeights(policy.slotWeights);
    const out: JitCandidate<MetaActionPayload>[] = [];
    for (const kind of BATCH_SLOT_KINDS) {
      const surfaces = config.useSurfaces
        ? surfacesForKind(baseline.slots, kind, fallback)
        : [];
      const kindPrior = policyPriorLogit(
        weights,
        kind,
        policy.explorationTemperature,
        request.memoryConfidence
      );
      if (!config.surfaceActions || surfaces.length === 0) {
        out.push({
          actionKey: normalizeMetaAction(kind, surfaces),
          baseLogit: kindPrior,
          source: 'policy_prior',
          payload: { slotKind: kind, focusSurfaces: surfaces }
        });
        continue;
      }
      // Uniform split of the kind's prior over its surfaces.
      const surfacePrior = kindPrior - Math.log(surfaces.length);
      for (const surface of surfaces) {
        out.push({
          actionKey: normalizeMetaAction(kind, [surface]),
          baseLogit: surfacePrior,
          source: 'policy_prior',
          payload: { slotKind: kind, focusSurfaces: [surface] }
        });
      }
    }
    return out;
  }

  /**
   * Map every retrieved L1 record onto the candidate that represents it.
   *
   * Delegates to the kernel's shared projection so online and replay fold the
   * neighbourhood identically (plan section 7.1); the semantics are documented
   * on `projectNeighborsBySlotKind`.
   */
  private alignNeighbors(
    neighbors: readonly ScoredExperience[],
    candidates: readonly JitCandidate<MetaActionPayload>[]
  ): readonly ScoredExperience[] {
    return projectNeighborsBySlotKind(neighbors, candidates);
  }

  /**
   * Re-apportion through a validated, throw-away derived policy.
   *
   * P6 PR5 (plan section 7.3): the cache key carries the effective-configuration
   * version, so a hot swap cannot be served a derived policy built from the
   * previous version's weights even when the weight vector happens to repeat.
   */
  private reapportion(
    request: SelectBatchRequest,
    weights: Readonly<Record<BatchSlotKind, number>>,
    policyVersion: string | undefined
  ): BatchPlan | undefined {
    const policy = this.base.policy;
    const key =
      policy.id +
      '@' +
      String(policy.version) +
      (policyVersion === undefined ? '' : '~' + policyVersion) +
      '#' +
      weightSignature(weights);
    const derived = this.derivedFor(key, weights);
    if (derived === undefined) {
      return undefined;
    }
    const plan = derived.selectBatch(request);
    if (plan.width <= 0 || plan.slots.length === 0) {
      return undefined;
    }
    return plan;
  }

  /** Cached derived policy, or undefined when its weights cannot be validated. */
  private derivedFor(
    key: string,
    weights: Readonly<Record<BatchSlotKind, number>>
  ): ActivePolicy | undefined {
    const cached = this.derivedCache.peek(key);
    if (cached !== undefined) {
      return this.derivedCache.touch(key, cached);
    }
    const slotWeights: Record<BatchSlotKind, number> = {
      exploit: weights.exploit,
      explore_domain: weights.explore_domain,
      explore_invariant: weights.explore_invariant,
      recover: weights.recover
    };
    for (const kind of BATCH_SLOT_KINDS) {
      const value = slotWeights[kind];
      if (!Number.isFinite(value) || value < 0) {
        return undefined;
      }
    }
    if (!BATCH_SLOT_KINDS.some((kind) => slotWeights[kind] > 0)) {
      return undefined;
    }
    const policy = this.base.policy;
    try {
      const derived = createActivePolicy({
        // Keep the BASE identity: tree lineage and offline replay key on it.
        policy: { ...policy, id: policy.id, version: policy.version, slotWeights },
        now: this.now,
        maxRecoverySlots:
          this.options.maxRecoverySlots ?? DEFAULT_EVO_HARNESS_CONFIG.dreamRsi.maxRecoverySlots,
        ...(this.options.defaultFocusSurfaces === undefined
          ? {}
          : { defaultFocusSurfaces: this.options.defaultFocusSurfaces })
      });
      this.derivedCache.insert(key, derived);
      return derived;
    } catch (error) {
      this.notice(
        'jit_meta_adjust: the derived policy rejected the adjusted weights (' +
          (error instanceof Error ? error.name : 'unknown error') +
          ')'
      );
      return undefined;
    }
  }

  /** Baseline plan plus a degraded diagnostics block; never throws. */
  private degraded(
    baseline: BatchPlan,
    reason: string,
    previous?: JitBatchDiagnostics
  ): BatchPlan {
    const diagnostics: JitBatchDiagnostics = {
      level: 'meta',
      stateValue: previous?.stateValue ?? 0,
      neighborCount: previous?.neighborCount ?? 0,
      klToPrior: previous?.klToPrior ?? 0,
      adjustments: previous?.adjustments ?? [],
      rationale: 'jit meta: degraded to the unadjusted plan',
      degraded: true,
      degradedReason: reason
    };
    this.history.push(diagnostics);
    return withJitMetadata(baseline, diagnostics);
  }

  private notice(message: string): void {
    this.notices.push(message);
    this.options.onDiagnostic?.(message);
  }
}

/** Attach L1 diagnostics without mutating the plan's own metadata object. */
function withJitMetadata(plan: BatchPlan, diagnostics: JitBatchDiagnostics): BatchPlan {
  return {
    ...plan,
    metadata: {
      ...(isRecord(plan.metadata) ? plan.metadata : {}),
      [JIT_BATCH_METADATA_KEY]: diagnostics
    }
  };
}

/** Extra audit fields attached to one decision's diagnostics. */
interface DiagnosticsAudit {
  readonly trackSelection?: AtomicTrackSelectionVerdict<unknown>;
  readonly policyVersion?: string;
  readonly ignoredDimensions?: readonly string[];
  readonly filter?: {
    readonly records: number;
    readonly kept: number;
    readonly excludeLegacy?: boolean;
    readonly learningEligibleOnly?: boolean;
  };
}

/** Per-candidate diagnostics, in candidate (BATCH_SLOT_KINDS) order. */
function toDiagnostics(
  decision: JitDecision<MetaActionPayload>,
  candidates: readonly JitCandidate<MetaActionPayload>[],
  includeSurfaces = false,
  audit: DiagnosticsAudit = {}
): JitBatchDiagnostics {
  const adjustments: JitBatchAdjustment[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index] as JitCandidate<MetaActionPayload>;
    const entry = decision.adjustments[index];
    if (entry === undefined) {
      continue;
    }
    adjustments.push({
      actionKey: candidate.actionKey,
      slotKind: candidate.payload.slotKind,
      source: candidate.source,
      ...(includeSurfaces
        ? { focusSurfaces: [...candidate.payload.focusSurfaces] }
        : {}),
      q: entry.q,
      advantage: entry.advantage,
      normalizedAdvantage: entry.normalizedAdvantage,
      adjustedLogit: entry.adjustedLogit,
      probability: entry.probability,
      support: entry.support,
      ...(entry.nEff === undefined ? {} : { nEff: entry.nEff }),
      explored: entry.explored
    });
  }
  return {
    level: 'meta',
    stateValue: decision.stateValue,
    neighborCount: decision.neighborCount,
    klToPrior: decision.klToPrior,
    adjustments,
    rationale: decision.rationale,
    ...(audit.trackSelection === undefined ? {} : { trackSelection: audit.trackSelection }),
    ...(audit.policyVersion === undefined ? {} : { policyVersion: audit.policyVersion }),
    ...(audit.ignoredDimensions === undefined
      ? {}
      : { ignoredDimensions: audit.ignoredDimensions }),
    ...(audit.filter === undefined ? {} : { filter: audit.filter })
  };
}

/**
 * softmax(z') aggregated per slot kind (plan section 7.1: same allocation as
 * replay). Delegates to the kernel's allocator so the two paths cannot drift;
 * the kernel returns null only for a non-slot action space, which cannot happen
 * here (every L1 candidate is a `slot:<kind>` key).
 */
function weightsFromDecision(
  decision: JitDecision<MetaActionPayload>,
  candidates: readonly JitCandidate<MetaActionPayload>[]
): Readonly<Record<BatchSlotKind, number>> {
  const weights = slotWeightsFromDecision(decision, candidates);
  if (weights !== null) {
    return weights;
  }
  return { exploit: 0, explore_domain: 0, explore_invariant: 0, recover: 0 };
}

/**
 * Surfaces each slot kind may legitimately focus, taken from the baseline plan.
 * A kind with no scheduled slot offers nothing, so its chosen action can never
 * rewrite a surface (its slots do not exist to rewrite).
 */
function offeredSurfaces(
  baseline: BatchPlan
): ReadonlyMap<BatchSlotKind, readonly HarnessComponentKey[]> {
  const offered = new Map<BatchSlotKind, HarnessComponentKey[]>();
  for (const slot of baseline.slots) {
    const surfaces = slot.focusSurfaces.filter(isHarnessSurface);
    const existing = offered.get(slot.slot);
    if (existing === undefined) {
      offered.set(slot.slot, [...surfaces]);
      continue;
    }
    for (const surface of surfaces) {
      if (!existing.includes(surface)) {
        existing.push(surface);
      }
    }
  }
  return offered;
}

/**
 * Write the chosen action's focus surfaces back onto the plan (plan section 3.1:
 * the adjusted distribution covers slot weights AND focus surfaces).
 *
 * Only the surfaces the baseline actually offered are eligible: the chosen set is
 * intersected with the surfaces the plan already carried for that kind, so a
 * surface can never be fabricated for a patch/prober that does not support it.
 * An empty intersection leaves the plan untouched, which is also the safety net
 * for the disabled action space and for the no-op path.
 */
function withChosenSurfaces(
  plan: BatchPlan,
  chosen: JitBatchAdjustment,
  offered: ReadonlyMap<BatchSlotKind, readonly HarnessComponentKey[]>
): BatchPlan {
  const allowed = offered.get(chosen.slotKind) ?? [];
  const wanted = (chosen.focusSurfaces ?? []).filter(
    (surface) => isHarnessSurface(surface) && allowed.includes(surface)
  );
  if (wanted.length === 0) {
    return plan;
  }
  const selected = new Set(wanted);
  const others = allowed.filter((surface) => !selected.has(surface));
  // Keep the chosen surface first, then the rest of the offered set: the patch
  // is unchanged, only its focus order moves.
  const focusSurfaces: readonly HarnessComponentKey[] = [...wanted, ...others];
  let changed = false;
  const slots = plan.slots.map((slot) => {
    if (slot.slot !== chosen.slotKind) {
      return slot;
    }
    // The plan already focuses exactly this set: nothing to rewrite.
    if (
      slot.focusSurfaces.length === focusSurfaces.length &&
      slot.focusSurfaces.every((surface, index) => surface === focusSurfaces[index])
    ) {
      return slot;
    }
    changed = true;
    return { ...slot, focusSurfaces };
  });
  return changed ? { ...plan, slots } : plan;
}

/** Create the L1 meta-scheduling decorator around an existing active policy. */
export function createJitActivePolicy(options: JitActivePolicyOptions): JitActivePolicy {
  return new JitActivePolicyImpl(options);
}

/** True when a batch plan carries L1 diagnostics (drives the jit_meta_adjust stage). */
export function hasJitDiagnostics(plan: BatchPlan): boolean {
  return isRecord(plan.metadata) && isRecord(plan.metadata[JIT_BATCH_METADATA_KEY]);
}

/** Read the L1 diagnostics out of a batch plan, or undefined when absent. */
export function readJitDiagnostics(plan: BatchPlan): JitBatchDiagnostics | undefined {
  if (!isRecord(plan.metadata)) {
    return undefined;
  }
  const value = plan.metadata[JIT_BATCH_METADATA_KEY];
  return isRecord(value) ? (value as unknown as JitBatchDiagnostics) : undefined;
}
