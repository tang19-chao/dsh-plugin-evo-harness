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
import { composeDecision, softmax } from './logit-adjuster';
import { policyPriorLogit } from './logit-sources';
import { retrieveNeighbors } from './retriever';
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
  readonly degraded?: boolean;
  readonly degradedReason?: string;
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
  /** Recovery slots the derived policy may schedule (config dreamRsi). */
  readonly maxRecoverySlots?: number;
  /** Surfaces the derived policy falls back to when the tree hints none. */
  readonly defaultFocusSurfaces?: readonly HarnessComponentKey[];
  /** Diagnostic sink; the same notices are also kept in diagnostics(). */
  readonly onDiagnostic?: (message: string) => void;
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
   * Merge the current policy's JitRL hyperparameters over the construction-time
   * config (repair H1).
   *
   * `update()` swaps the base policy, and a dream hot swap replaces the policy
   * together with its `jit` block (plan section 7.3-3), so beta/lambda/alpha/k
   * and the similarity threshold must be read *per decision* instead of being
   * frozen in the constructor. Reading `this.base.policy` on every call is what
   * makes an `update()` take effect immediately without a second cache to keep
   * in sync.
   *
   * A field is taken from `policy.jit` only when it is a usable finite value;
   * anything missing (policy never hot swapped, older policy, or a malformed
   * block) falls back to the resolved construction config field by field, which
   * preserves the pre-repair behaviour exactly.
   *
   * `gamma` is deliberately not mapped: it scales the return discount used by
   * the offline dreamer and the step evaluator, neither of which this decorator
   * calls, so it has no online counterpart here.
   */
  private effectiveConfig(policy: MetaSearchPolicy): ResolvedConfig {
    const jit = policy.jit;
    if (jit === undefined) {
      return this.config;
    }
    return {
      ...this.config,
      beta: finiteOr(jit.beta, this.config.beta),
      k: Math.max(1, Math.floor(finiteOr(jit.k, this.config.k))),
      similarityThreshold: finiteOr(jit.similarityThreshold, this.config.similarityThreshold),
      lambda: finiteOr(jit.lambda, this.config.lambda),
      alpha: finiteOr(jit.alpha, this.config.alpha)
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

  selectBatch(request: SelectBatchRequest): BatchPlan {
    const baseline = this.base.selectBatch(request);
    // Runtime off (/evo jit off): return the baseline untouched, with no
    // metadata.jit and no history entry, so /evo jit on restores immediately.
    if (!this.runtimeEnabled()) {
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
    // Repair H1: resolve the hyperparameters from the *current* policy so a hot
    // swap (update() with a new jit block) takes effect on this very decision.
    const config = this.effectiveConfig(policy);
    const state = buildMetaState(request);
    const candidates = this.candidates(baseline, request, policy, config);
    const neighbors = this.alignNeighbors(this.retrieve(state, config), candidates);
    const decision = composeDecision('meta', state, neighbors, candidates, {
      beta: config.beta,
      selection: config.selection,
      lambda: config.lambda,
      alpha: config.alpha,
      unseenFallback: config.unseenFallback,
      rng: this.rng
    });
    const diagnostics = toDiagnostics(decision, candidates, config.surfaceActions);

    // A no-op correction must leave the plan byte-identical: with every
    // advantage zero the softmax of z' is the prior itself, so KL is exactly 0.
    if (diagnostics.klToPrior === 0) {
      this.history.push(diagnostics);
      return withJitMetadata(baseline, diagnostics);
    }

    const weights = weightsFromDecision(decision, candidates);
    const plan = this.reapportion(request, weights);
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

  /** Weighted neighbourhood for the abstract state, from the injected snapshot. */
  private retrieve(
    state: AbstractState,
    config: ResolvedConfig
  ): readonly ScoredExperience[] {
    return retrieveNeighbors(resolveSnapshot(this.options.experiences), state, {
      k: config.k,
      similarityThreshold: config.similarityThreshold,
      level: 'meta',
      now: this.now(),
      halfLifeMs: config.halfLifeMs,
      ...(config.before === undefined ? {} : { before: config.before })
    });
  }

  /**
   * Map every retrieved L1 record onto the candidate that represents it.
   *
   * Exact action key first: with the surface action space enabled a kind owns
   * several candidates, and folding them all onto one key would hand every
   * surface the whole kind's support and destroy the very discrimination the
   * surface dimension exists for. Only when no candidate carries the exact key
   * does the record fall back to its slot-kind representative, which is what
   * keeps a backfilled 'slot:<kind>/surf:<...>' record attributable to the live
   * candidate of that kind (support semantics documented in the verifier report
   * A2: support is per action, never per exact spelling).
   */
  private alignNeighbors(
    neighbors: readonly ScoredExperience[],
    candidates: readonly JitCandidate<MetaActionPayload>[]
  ): readonly ScoredExperience[] {
    const keys = new Set(candidates.map((candidate) => candidate.actionKey));
    const byKind = new Map<BatchSlotKind, string>();
    for (const candidate of candidates) {
      if (!byKind.has(candidate.payload.slotKind)) {
        byKind.set(candidate.payload.slotKind, candidate.actionKey);
      }
    }
    const out: ScoredExperience[] = [];
    for (const neighbor of neighbors) {
      if (keys.has(neighbor.record.actionKey)) {
        out.push(neighbor);
        continue;
      }
      const kind = slotKindOfActionKey(neighbor.record.actionKey);
      const actionKey = kind === undefined ? undefined : byKind.get(kind);
      if (actionKey === undefined) {
        continue;
      }
      out.push({ ...neighbor, record: { ...neighbor.record, actionKey } });
    }
    return out;
  }

  /** Re-apportion through a validated, throw-away derived policy. */
  private reapportion(
    request: SelectBatchRequest,
    weights: Readonly<Record<BatchSlotKind, number>>
  ): BatchPlan | undefined {
    const policy = this.base.policy;
    const key =
      policy.id + '@' + String(policy.version) + '#' + weightSignature(weights);
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

/** Per-candidate diagnostics, in candidate (BATCH_SLOT_KINDS) order. */
function toDiagnostics(
  decision: JitDecision<MetaActionPayload>,
  candidates: readonly JitCandidate<MetaActionPayload>[],
  includeSurfaces = false
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
      explored: entry.explored
    });
  }
  return {
    level: 'meta',
    stateValue: decision.stateValue,
    neighborCount: decision.neighborCount,
    klToPrior: decision.klToPrior,
    adjustments,
    rationale: decision.rationale
  };
}

/**
 * softmax(z') aggregated per slot kind. Candidates are one-per-kind, so the
 * aggregation is a direct copy; the sum over kinds is 1 by construction of
 * softmax, which keeps apportionSearchSlots scale-free.
 */
function weightsFromDecision(
  decision: JitDecision<MetaActionPayload>,
  candidates: readonly JitCandidate<MetaActionPayload>[]
): Readonly<Record<BatchSlotKind, number>> {
  const probabilities = softmax(decision.adjustments.map((entry) => entry.adjustedLogit));
  const weights: Record<BatchSlotKind, number> = {
    exploit: 0,
    explore_domain: 0,
    explore_invariant: 0,
    recover: 0
  };
  for (let index = 0; index < candidates.length; index += 1) {
    const kind = (candidates[index] as JitCandidate<MetaActionPayload>).payload.slotKind;
    const probability = probabilities[index];
    if (probability === undefined || !Number.isFinite(probability)) {
      continue;
    }
    weights[kind] += probability;
  }
  return weights;
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
