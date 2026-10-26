/**
 * JitRL pure decision kernel (P6 PR5, plan sections 7.1-7.4).
 *
 * Ownership: src/jitrl/** (P6 PR5).
 *
 * Before this module there were two algorithms: the online path ran
 * retrieveNeighbors() + composeDecision(), while the Dream replay hook
 * aggregated the causal window itself (weighted means per slot, its own
 * exp(beta * A) re-apportioning, and no nearest-neighbour retrieval at all).
 * Offline replay therefore evaluated a different policy than the one that ran
 * online. This module is the single pipeline both sides now call:
 *
 *   DecisionContext
 *   -> same state abstraction        (the caller supplies the AbstractState)
 *   -> same scope/guidance/version/time filter   (filterExperienceSnapshot)
 *   -> same bucket + similarity + decay + top-k  (retriever.retrieveNeighbors)
 *   -> same Q / V / exploration / advantage       (value-estimator)
 *   -> same logit correction                      (logit-adjuster.composeDecision)
 *   -> same allocation and diagnostics            (JitDecision + slotWeightsFromDecision)
 *
 * The online path supplies the *current* snapshot; replay supplies the snapshot
 * already truncated to the replayed tree's causal past. Nothing else differs,
 * and `runDecisionKernel` is a pure function of its context: the only
 * randomness is the injectable `rng`/`seed`, and the only clock is `now`.
 *
 * Section 7.2 (search scope) and 7.3 (hot-swap scope) are also encoded here:
 *
 * - POLICY_SEARCH_DIMENSIONS is the only set of dimensions that may be swept by
 *   the offline candidate grid (beta, k, similarityThreshold). Everything else
 *   is listed in POLICY_IGNORED_DIMENSIONS with the reason it is not swept, so
 *   "ignored" is an auditable fact rather than a silently dropped field.
 * - POLICY_DIMENSION_LAYERS states which layer owns each tunable, so L1/L2/L3
 *   never silently share one temperature.
 * - createEffectivePolicyConfigProvider() is the versioned provider every
 *   consumer reads once per decision; publishing swaps the version tag and the
 *   configuration in one assignment (atomic), and each read is logged, so a
 *   decision can always be traced to the config version it consumed.
 *
 * Section 7.4 (drift accounting) lives here too: freshPolicySupport() counts
 * current-policy records per (level, bucket) *after* filtering, which is the
 * denominator the drift down-weight is defined against. Counting per level
 * instead of per bucket made the penalty stop early and did not count support
 * for the bucket the decision is actually in.
 */

import { DEFAULT_EVO_HARNESS_CONFIG } from '../config';
import {
  EXPERIENCE_SCHEMA_VERSION
} from './experience-store';
import { CURRENT_REWARD_VERSION } from './experience-store';
import { isLearningEligibleRecord } from './reward-contract';
import type {
  AbstractState,
  BatchSlotKind,
  ExperienceRecord,
  GuidanceMode,
  JitCandidate,
  JitDecision,
  JitLevel,
  MetaSearchPolicy,
  ScoredExperience
} from '../types/contracts';
import { retrieveNeighbors } from './retriever';
import { composeDecision } from './logit-adjuster';

/** Frozen kernel defaults, used only when a caller supplies no config at all. */
const JIT = DEFAULT_EVO_HARNESS_CONFIG.jitrl;

// ---------------------------------------------------------------------------
// Section 7.2: the searchable dimensions and the explicitly ignored ones
// ---------------------------------------------------------------------------

/**
 * Dimensions the offline candidate grid is allowed to sweep this round.
 *
 * The criterion is a *counterexample*: changing the dimension on a constructed
 * input must visibly change the neighbourhood, the decision or the evaluation.
 * beta (KL temperature), k (neighbour budget) and similarityThreshold (Jaccard
 * cut) all pass that test in the kernel: they change z' / |N(s)| / which records
 * are neighbours at all.
 */
export const POLICY_SEARCH_DIMENSIONS = ['beta', 'k', 'similarityThreshold'] as const;
export type PolicySearchDimension = (typeof POLICY_SEARCH_DIMENSIONS)[number];

/** One dimension deliberately kept out of this round's search grid. */
export interface JitIgnoredDimension {
  /** Dimension name as it appears in {@link MetaSearchPolicy} jit blocks. */
  readonly dimension: 'lambda' | 'alpha' | 'gamma';
  /** Why it is not swept, and what would have to change first. */
  readonly reason: string;
}

/**
 * Dimensions that are inherited but never perturbed (plan section 7.2).
 *
 * They are still *consumed*: replay and online both run the same exploration
 * draw with the same lambda/alpha, which is what makes the online and offline
 * semantics comparable. They are only excluded from *ranking* candidates,
 * because a stochastic exploration outcome is not a stable ranking signal:
 *
 * - lambda / alpha: entering the grid before replay faithfully simulates the
 *   same exploration mechanism would rank candidates by RNG noise. Replay now
 *   does run the same mechanism (same kernel), but the mechanism is a Bernoulli
 *   draw per unsupported action, so a small candidate set cannot separate the
 *   effect from the seed. They become searchable once replay averages over
 *   several fixed seeds per candidate.
 * - gamma: already-persisted returns were discounted with the old gamma, and
 *   records carry no per-step reward series, so changing policy.gamma cannot
 *   recompute them. Optimising gamma requires storing a reward decomposition
 *   and versioned recomputation first (plan section 7.2).
 */
export const POLICY_IGNORED_DIMENSIONS: readonly JitIgnoredDimension[] = [
  {
    dimension: 'lambda',
    reason:
      'not swept this round: the exploration draw is a Bernoulli event per unsupported action, so candidate ranking would follow the seed rather than the policy; requires multi-seed averaging in replay first'
  },
  {
    dimension: 'alpha',
    reason:
      'not swept this round: the optimism bonus only applies to unexplored actions, so with the current support density its effect is indistinguishable from the exploration draw; pairs with lambda'
  },
  {
    dimension: 'gamma',
    reason:
      'frozen this round: persisted returns were discounted with the previous gamma and records carry no per-step reward series, so a gamma change cannot be recomputed; needs stored reward decomposition plus versioned recalculation'
  }
];

/** True when a dimension is part of this round's search grid. */
export function isSearchDimension(dimension: string): dimension is PolicySearchDimension {
  return (POLICY_SEARCH_DIMENSIONS as readonly string[]).includes(dimension);
}

/** The ignored-dimension record for a name, or undefined when it is searchable. */
export function ignoredDimension(
  dimension: string
): JitIgnoredDimension | undefined {
  return POLICY_IGNORED_DIMENSIONS.find((entry) => entry.dimension === dimension);
}

// ---------------------------------------------------------------------------
// Section 7.3: which layer owns which tunable
// ---------------------------------------------------------------------------

/** The three consumer layers of the effective configuration. */
export type PolicyConfigLayer = 'level1' | 'level2' | 'level3';

/** Jit level each layer decides at. */
export const POLICY_LAYER_LEVELS: Readonly<Record<PolicyConfigLayer, JitLevel>> = {
  level1: 'meta',
  level2: 'proposal',
  level3: 'host_tool'
};

/**
 * Layer ownership of every tunable (plan section 7.3: "明确哪些超参属于 L1，
 * 哪些属于 L2/L3；不默认三层共享一份温度").
 *
 * beta/k/similarityThreshold/lambda/alpha/unseenFallback are retrieval and
 * correction knobs, and L1 and L2 each run their own retrieval, so each layer
 * owns its own copy. gamma is a reward-discount knob for the dream/replay
 * pipeline, so it belongs to L2 only. The L3 advisor has no KL temperature at
 * all: it owns only its own thresholds and support floor.
 */
export const POLICY_DIMENSION_LAYERS: Readonly<Record<string, readonly PolicyConfigLayer[]>> = {
  beta: ['level1', 'level2'],
  k: ['level1', 'level2'],
  similarityThreshold: ['level1', 'level2'],
  selection: ['level1', 'level2'],
  lambda: ['level1', 'level2'],
  alpha: ['level1', 'level2'],
  unseenFallback: ['level1', 'level2'],
  halfLifeMs: ['level1', 'level2'],
  driftRho: ['level1', 'level2'],
  gamma: ['level2'],
  adviseThreshold: ['level3'],
  gateThreshold: ['level3'],
  minSupport: ['level3']
};

/** True when the layer is allowed to consume the dimension. */
export function layerOwnsDimension(
  layer: PolicyConfigLayer,
  dimension: string
): boolean {
  const owners = POLICY_DIMENSION_LAYERS[dimension];
  return owners !== undefined && owners.includes(layer);
}

/** Decision-time knobs shared by L1 and L2 (each layer holds its own copy). */
export interface LayerDecisionConfig {
  /** KL temperature multiplying the normalized advantage (config jitrl.beta). */
  readonly beta: number;
  /** Neighbour budget (config jitrl.k). */
  readonly k: number;
  /** Minimum Jaccard similarity, inclusive (config jitrl.similarityThreshold). */
  readonly similarityThreshold: number;
  /** argmax (deterministic default) or sample from softmax(z'). */
  readonly selection: 'argmax' | 'sample';
  /** Exploration probability for unsupported actions (config jitrl.exploration.lambda). */
  readonly lambda: number;
  /** Exploration bonus scale (config jitrl.exploration.alpha). */
  readonly alpha: number;
  /** Value of an unsupported action. */
  readonly unseenFallback: 'zero' | 'baseline';
  /** Half-life of the retrieval decay in ms; 0 disables it. */
  readonly halfLifeMs: number;
  /** Causal cutoff on record.createdAt, inclusive. */
  readonly before?: number;
  /** Drift down-weight factor; ignored unless policyId is also present. */
  readonly driftRho?: number;
  /** Current policy id used for drift down-weighting. */
  readonly policyId?: string;
}

/** L3 host-tool advisor knobs; deliberately carries no KL temperature. */
export interface HostToolLayerConfig {
  readonly adviseThreshold: number;
  readonly gateThreshold: number;
  readonly minSupport: number;
}

/** The effective, versioned configuration every consumer reads per decision. */
export interface EffectivePolicyConfig {
  readonly policyId: string;
  /** Monotonic configuration version; bumped by every publish(). */
  readonly policyVersion: number;
  /** `<policyId>@v<policyVersion>`; the identity a cache keys on. */
  readonly versionTag: string;
  readonly level1: LayerDecisionConfig;
  readonly level2: LayerDecisionConfig;
  readonly level3: HostToolLayerConfig;
  /** Reward discount of the dream pipeline; frozen this round (plan section 7.2). */
  readonly gamma: number;
  /** Dimensions this configuration participates in searching (plan section 7.2). */
  readonly searchDimensions: readonly PolicySearchDimension[];
  /** Dimensions inherited but explicitly not searched, with the reason. */
  readonly ignored: readonly JitIgnoredDimension[];
  /** Provenance: 'config' (frozen defaults), 'policy' (a policy's jit block). */
  readonly source: 'config' | 'policy';
  readonly publishedAt: number;
}

/** Which consumer read the configuration; logged per decision. */
export type PolicyConfigConsumer = PolicyConfigLayer | 'replay';

/** One "this consumer consumed this version" record. */
export interface PolicyConfigConsumption {
  readonly versionTag: string;
  readonly policyVersion: number;
  readonly consumer: PolicyConfigConsumer;
  readonly at: number;
}

/** Bound on the consumption log so a long-running host stays flat. */
export const POLICY_CONFIG_CONSUMPTION_LIMIT = 256;

/** Options for the base (policy-free) effective configuration. */
export interface EffectivePolicyConfigSeed {
  readonly jitrl: {
    readonly beta: number;
    readonly k: number;
    readonly similarityThreshold: number;
    readonly selection: 'argmax' | 'sample';
    readonly exploration: { readonly lambda: number; readonly alpha: number };
    readonly unseenFallback: 'zero' | 'baseline';
    readonly gamma: number;
    readonly store: { readonly halfLifeDays: number };
    readonly hostAdvisor: {
      readonly adviseThreshold: number;
      readonly gateThreshold: number;
      readonly minSupport: number;
    };
  };
  /** Derived half-life; computed from jitrl.store.halfLifeDays when absent. */
  readonly halfLifeMs?: number;
}

/** Half-life in ms derived from config; 0 days disables the decay. */
export function halfLifeMsFromJitRl(jitrl: {
  readonly store: { readonly halfLifeDays: number };
}): number {
  const days = jitrl.store.halfLifeDays;
  if (!Number.isFinite(days) || days <= 0) {
    return 0;
  }
  return days * 24 * 60 * 60 * 1000;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Validate and normalize one layer's decision knobs; throws on unusable input. */
export function normalizeLayerDecisionConfig(
  config: Partial<LayerDecisionConfig> & { readonly beta?: number }
): LayerDecisionConfig {
  const beta = finiteOr(config.beta, JIT.beta);
  if (beta < 0) {
    throw new RangeError('decision kernel: beta must be >= 0');
  }
  const k = Math.max(1, Math.floor(finiteOr(config.k, JIT.k)));
  const threshold = finiteOr(config.similarityThreshold, JIT.similarityThreshold);
  if (threshold < 0 || threshold > 1) {
    throw new RangeError('decision kernel: similarityThreshold must be in [0, 1]');
  }
  const lambda = finiteOr(config.lambda, JIT.exploration.lambda);
  if (lambda < 0 || lambda > 1) {
    throw new RangeError('decision kernel: lambda must be in [0, 1]');
  }
  const alpha = finiteOr(config.alpha, JIT.exploration.alpha);
  if (alpha < 0) {
    throw new RangeError('decision kernel: alpha must be >= 0');
  }
  const halfLifeMs = Math.max(0, finiteOr(config.halfLifeMs, halfLifeMsFromJitRl(JIT)));
  const selection = config.selection ?? JIT.selection;
  if (selection !== 'argmax' && selection !== 'sample') {
    throw new RangeError("decision kernel: selection must be 'argmax' or 'sample'");
  }
  const unseenFallback = config.unseenFallback ?? JIT.unseenFallback;
  if (unseenFallback !== 'zero' && unseenFallback !== 'baseline') {
    throw new RangeError("decision kernel: unseenFallback must be 'zero' or 'baseline'");
  }
  const driftRho =
    config.driftRho === undefined ? undefined : clamp01(finiteOr(config.driftRho, 0.7));
  return {
    beta,
    k,
    similarityThreshold: threshold,
    selection,
    lambda,
    alpha,
    unseenFallback,
    halfLifeMs,
    ...(config.before === undefined ? {} : { before: config.before }),
    ...(driftRho === undefined ? {} : { driftRho }),
    ...(config.policyId === undefined ? {} : { policyId: config.policyId })
  };
}

/**
 * Build the base effective configuration from the frozen plugin config.
 *
 * L1 and L2 start from the same configured numbers but are separate objects, so
 * a later publish can raise L2's temperature without touching L1 (plan section
 * 7.3: no implicit three-layer temperature sharing).
 */
export function baseEffectivePolicyConfig(
  seed: EffectivePolicyConfigSeed
): EffectivePolicyConfig {
  const halfLifeMs = seed.halfLifeMs ?? halfLifeMsFromJitRl(seed.jitrl);
  const layer = normalizeLayerDecisionConfig({
    beta: seed.jitrl.beta,
    k: seed.jitrl.k,
    similarityThreshold: seed.jitrl.similarityThreshold,
    selection: seed.jitrl.selection,
    lambda: seed.jitrl.exploration.lambda,
    alpha: seed.jitrl.exploration.alpha,
    unseenFallback: seed.jitrl.unseenFallback,
    halfLifeMs
    // driftRho is deliberately NOT enabled here: drift down-weighting is
    // opt-in per decision context (replay sets it explicitly), so a consumer
    // that never asked for it keeps the pre-PR5 online behaviour byte for byte.
  });
  return {
    policyId: 'config',
    policyVersion: 0,
    versionTag: 'config@v0',
    level1: layer,
    level2: layer,
    level3: {
      adviseThreshold: seed.jitrl.hostAdvisor.adviseThreshold,
      gateThreshold: seed.jitrl.hostAdvisor.gateThreshold,
      minSupport: seed.jitrl.hostAdvisor.minSupport
    },
    gamma: seed.jitrl.gamma,
    searchDimensions: [...POLICY_SEARCH_DIMENSIONS],
    ignored: POLICY_IGNORED_DIMENSIONS,
    source: 'config',
    publishedAt: 0
  };
}

/** The minimum a policy must expose to resolve its effective configuration. */
export interface PolicyConfigTarget {
  readonly id: string;
  readonly version: number;
  readonly jit?: {
    readonly beta: number;
    readonly lambda: number;
    readonly alpha: number;
    readonly k: number;
    readonly gamma: number;
    readonly similarityThreshold: number;
  };
}

/**
 * Merge one policy's `jit` block over a base configuration.
 *
 * A dream hot swap replaces the policy *and* its jit block together, so the
 * policy's block is the newest truth for the dimensions it carries. Missing or
 * unusable fields fall back field by field, which keeps a policy without a jit
 * block identical to the base configuration.
 */
export function effectiveConfigForPolicyTarget(
  target: PolicyConfigTarget,
  base: EffectivePolicyConfig,
  options: { readonly publishedAt?: number } = {}
): EffectivePolicyConfig {
  const jit = target.jit;
  const merge = (layer: LayerDecisionConfig): LayerDecisionConfig => {
    if (jit === undefined) {
      return { ...layer, policyId: target.id };
    }
    return normalizeLayerDecisionConfig({
      beta: finiteOr(jit.beta, layer.beta),
      k: Math.max(1, Math.floor(finiteOr(jit.k, layer.k))),
      similarityThreshold: finiteOr(jit.similarityThreshold, layer.similarityThreshold),
      lambda: finiteOr(jit.lambda, layer.lambda),
      alpha: finiteOr(jit.alpha, layer.alpha),
      selection: layer.selection,
      unseenFallback: layer.unseenFallback,
      halfLifeMs: layer.halfLifeMs,
      ...(layer.before === undefined ? {} : { before: layer.before }),
      ...(layer.driftRho === undefined ? {} : { driftRho: layer.driftRho }),
      policyId: target.id
    });
  };
  const gamma = jit === undefined ? base.gamma : finiteOr(jit.gamma, base.gamma);
  return {
    ...base,
    policyId: target.id,
    policyVersion: target.version,
    versionTag: target.id + '@v' + String(target.version),
    level1: merge(base.level1),
    level2: merge(base.level2),
    gamma,
    source: 'policy',
    publishedAt: options.publishedAt ?? base.publishedAt
  };
}

/** Convenience overload for a real MetaSearchPolicy. */
export function effectiveConfigForPolicy(
  policy: MetaSearchPolicy,
  base: EffectivePolicyConfig,
  options: { readonly publishedAt?: number } = {}
): EffectivePolicyConfig {
  return effectiveConfigForPolicyTarget(policy, base, options);
}

/**
 * Versioned provider (plan section 7.3).
 *
 * `current()` is what every consumer calls immediately before deciding, so a
 * hot swap takes effect on the next decision without a second cache. Publishing
 * builds the complete next configuration first and then swaps the two fields
 * (config + version) in a single assignment, so no reader can ever observe a new
 * version with the old numbers. Each read is logged with the version it saw.
 */
export interface EffectivePolicyConfigProvider {
  /** Read the currently published configuration (and log the consumption). */
  current(consumer: PolicyConfigConsumer): EffectivePolicyConfig;
  /** Current version tag without logging. */
  versionTag(): string;
  /** Versioned configs published so far, oldest first. */
  history(): readonly EffectivePolicyConfig[];
  /** Consumption records, oldest first (bounded). */
  consumptionLog(): readonly PolicyConfigConsumption[];
  /** Publish a new configuration atomically; returns what was published. */
  publish(next: EffectivePolicyConfigInput): EffectivePolicyConfig;
}

/** Input for one publish: a full policy or explicit layer overrides. */
export interface EffectivePolicyConfigInput {
  readonly policy?: MetaSearchPolicy;
  readonly level1?: Partial<LayerDecisionConfig>;
  readonly level2?: Partial<LayerDecisionConfig>;
  readonly level3?: Partial<HostToolLayerConfig>;
  readonly gamma?: number;
  /** Id to use when no policy is supplied; defaults to the current id. */
  readonly policyId?: string;
}

/** Options for {@link createEffectivePolicyConfigProvider}. */
export interface EffectivePolicyConfigProviderOptions {
  readonly initial: EffectivePolicyConfig;
  /** Injected clock shared with the kernel. */
  readonly now?: () => number;
  /** Bound on the consumption log (min 1). */
  readonly consumptionLimit?: number;
}

export function createEffectivePolicyConfigProvider(
  options: EffectivePolicyConfigProviderOptions
): EffectivePolicyConfigProvider {
  const now = options.now ?? ((): number => Date.now());
  const limit = Math.max(
    1,
    Math.floor(finiteOr(options.consumptionLimit, POLICY_CONFIG_CONSUMPTION_LIMIT))
  );
  let currentConfig: EffectivePolicyConfig = options.initial;
  const published: EffectivePolicyConfig[] = [options.initial];
  const consumption: PolicyConfigConsumption[] = [];

  return {
    current(consumer: PolicyConfigConsumer): EffectivePolicyConfig {
      const snapshot = currentConfig;
      consumption.push({
        versionTag: snapshot.versionTag,
        policyVersion: snapshot.policyVersion,
        consumer,
        at: now()
      });
      if (consumption.length > limit) {
        consumption.splice(0, consumption.length - limit);
      }
      return snapshot;
    },
    versionTag(): string {
      return currentConfig.versionTag;
    },
    history(): readonly EffectivePolicyConfig[] {
      return [...published];
    },
    consumptionLog(): readonly PolicyConfigConsumption[] {
      return [...consumption];
    },
    publish(next: EffectivePolicyConfigInput): EffectivePolicyConfig {
      const previous = currentConfig;
      const publishedAt = now();
      const base: EffectivePolicyConfig =
        next.policy === undefined
          ? {
              ...previous,
              policyId: next.policyId ?? previous.policyId,
              policyVersion: previous.policyVersion + 1,
              level1: { ...previous.level1 },
              level2: { ...previous.level2 },
              level3: { ...previous.level3 },
              publishedAt
            }
          : effectiveConfigForPolicy(next.policy, previous, { publishedAt });
      const merged: EffectivePolicyConfig = {
        ...base,
        policyVersion:
          next.policy === undefined ? previous.policyVersion + 1 : next.policy.version,
        level1:
          next.level1 === undefined
            ? base.level1
            : normalizeLayerDecisionConfig({ ...base.level1, ...next.level1 }),
        level2:
          next.level2 === undefined
            ? base.level2
            : normalizeLayerDecisionConfig({ ...base.level2, ...next.level2 }),
        level3:
          next.level3 === undefined ? base.level3 : { ...base.level3, ...next.level3 },
        gamma: next.gamma === undefined ? base.gamma : next.gamma
      };
      // Atomic switch: one assignment publishes version and configuration.
      currentConfig = {
        ...merged,
        versionTag: merged.policyId + '@v' + String(merged.policyVersion)
      };
      published.push(currentConfig);
      return currentConfig;
    }
  };
}

// ---------------------------------------------------------------------------
// Deterministic randomness (plan section 7.1: injectable seed)
// ---------------------------------------------------------------------------

/** FNV-1a over the string form of every part; stable across runs and platforms. */
export function seedFromParts(...parts: readonly (string | number)[]): number {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    const text = String(part);
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0x2f;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32: small, fast, fully deterministic from a 32-bit seed. */
export function createSeededRandom(seed: number): () => number {
  let state = (Number.isFinite(seed) ? Math.floor(seed) : 0) >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Shared filtering (scope / guidance / version / time)
// ---------------------------------------------------------------------------

/** One filter decision per record, so callers can explain every exclusion. */
export const EXPERIENCE_FILTER_REASONS = [
  'kept',
  'level',
  'bucket',
  'guidance',
  'time',
  'timestamp',
  'legacy',
  'learning_ineligible'
] as const;
export type ExperienceFilterReason = (typeof EXPERIENCE_FILTER_REASONS)[number];

/** Filter inputs shared by retrieval and by the support counters. */
export interface ExperienceFilterOptions {
  readonly level: JitLevel;
  /** Restrict to one bucket; absent keeps every bucket of the level. */
  readonly bucket?: string;
  /** Restrict to one guidance mode (invariant slots force 'guidance_free'). */
  readonly guidance?: GuidanceMode;
  /** Causal cutoff on record.createdAt, inclusive. */
  readonly before?: number;
  /**
   * Drop records written before the current experience schema (PR4, plan
   * section 6.5). Every LEARNING-facing caller must pass true; see
   * {@link LEARNING_CONSUMER_FILTER} and `learningFacingFilterOptions()`.
   */
  readonly excludeLegacy?: boolean;
  /** Lowest accepted schema version when excludeLegacy is set. */
  readonly minimumExperienceSchemaVersion?: number;
  /**
   * Drop cancelled / infrastructure records that must never train (plan section
   * 6.2). Every LEARNING-facing caller must pass true.
   */
  readonly learningEligibleOnly?: boolean;
}

/**
 * The filter a *learning* consumer must apply (plan sections 6.2 and 6.5,
 * P6.2 PR-A / F1).
 *
 * A learning consumer is anything whose output trains the policy or decides
 * which policy to publish: the online L1 neighbourhood, the replay
 * neighbourhood, the L2 selector, the L3 advisor query, the M3 fresh-policy
 * support count and the store's `learningEligibleOnly` query. For those,
 * evidence produced under an older reward/provenance model (legacy), evidence
 * that was never a quality signal (user cancellation, infrastructure failure),
 * and - P6.2 PR-A - evidence whose rewardVersion is not the EXACT current
 * contract id (or a certified compatible id) must not enter the estimate at
 * all. A record with a missing version field is NOT trusted by default: it
 * fails closed.
 *
 * The defaults on {@link ExperienceFilterOptions} stay permissive because the
 * store, the audit path and pre-PR5 callers legitimately read the whole level;
 * this constant is what makes "a learning consumer opted in" a visible decision
 * rather than an omission.
 */
export const LEARNING_CONSUMER_FILTER = {
  excludeLegacy: true,
  learningEligibleOnly: true
} as const;

/**
 * Build the strict learning filter for a decision context.
 *
 * Spread into a {@link DecisionKernelContext} to make the exclusion explicit at
 * the call site (and therefore greppable and mutation-testable), while keeping
 * the two flags independently overridable for the audit path.
 */
export function learningFacingFilterOptions(
  overrides: {
    readonly excludeLegacy?: boolean;
    readonly learningEligibleOnly?: boolean;
    readonly minimumExperienceSchemaVersion?: number;
  } = {}
): {
  readonly excludeLegacy: boolean;
  readonly learningEligibleOnly: boolean;
  readonly minimumExperienceSchemaVersion?: number;
} {
  return {
    excludeLegacy: overrides.excludeLegacy ?? LEARNING_CONSUMER_FILTER.excludeLegacy,
    learningEligibleOnly:
      overrides.learningEligibleOnly ?? LEARNING_CONSUMER_FILTER.learningEligibleOnly,
    ...(overrides.minimumExperienceSchemaVersion === undefined
      ? {}
      : { minimumExperienceSchemaVersion: overrides.minimumExperienceSchemaVersion })
  };
}

/** True when a record predates the per-execution attribution schema. */
export function isLegacyExperienceRecord(
  record: ExperienceRecord,
  minimum: number = EXPERIENCE_SCHEMA_VERSION
): boolean {
  const version = record.experienceSchemaVersion;
  return version === undefined || !Number.isFinite(version) || version < minimum;
}

/**
 * THE single learning-eligibility predicate (P6.2 PR-A / F1).
 *
 * This name is what every learning consumer imports; the implementation lives
 * in the leaf contract module (`isLearningEligibleRecord` in
 * ./reward-contract.ts) so the store and the kernel share ONE rule without an
 * import cycle. The store's `isLearningEligible(StoredExperience)`, the
 * partition/migration planners, L1/L2/L3, replay and the M3 fresh count all
 * delegate here (see the implementation doc for the three checks):
 *   1. `learningEligible !== false`;
 *   2. schema version >= current (missing = legacy, fail-closed);
 *   3. rewardVersion is the EXACT current contract id or a certified
 *      compatible id (missing fails closed; surrogate backfill is not
 *      compatible).
 *
 * Before P6.2 this function skipped check 3 entirely (the store kept its own
 * copy), so the L1/replay snapshot path mixed old-r2 and surrogate-r3 records
 * into estimates the strict store.query path already excluded.
 */
export function isLearningEligibleExperience(record: ExperienceRecord): boolean {
  return isLearningEligibleRecord(record, CURRENT_REWARD_VERSION);
}

/** The single filter predicate: every kernel consumer shares it. */
export function experienceFilterReason(
  record: ExperienceRecord,
  options: ExperienceFilterOptions
): ExperienceFilterReason {
  if (record === null || typeof record !== 'object') {
    return 'timestamp';
  }
  if (record.level !== options.level) {
    return 'level';
  }
  if (!Number.isFinite(record.createdAt)) {
    return 'timestamp';
  }
  if (options.bucket !== undefined && record.state?.bucket !== options.bucket) {
    return 'bucket';
  }
  if (options.guidance !== undefined && record.guidance !== options.guidance) {
    return 'guidance';
  }
  if (options.before !== undefined && record.createdAt > options.before) {
    return 'time';
  }
  if (
    options.excludeLegacy === true &&
    isLegacyExperienceRecord(
      record,
      options.minimumExperienceSchemaVersion ?? EXPERIENCE_SCHEMA_VERSION
    )
  ) {
    return 'legacy';
  }
  if (options.learningEligibleOnly === true && !isLearningEligibleExperience(record)) {
    return 'learning_ineligible';
  }
  return 'kept';
}

/** Apply the shared filter, preserving the caller's order. */
export function filterExperienceSnapshot(
  records: readonly ExperienceRecord[],
  options: ExperienceFilterOptions
): readonly ExperienceRecord[] {
  if (!Array.isArray(records)) {
    return [];
  }
  const kept: ExperienceRecord[] = [];
  for (const record of records) {
    if (experienceFilterReason(record, options) === 'kept') {
      kept.push(record);
    }
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Section 7.4: fresh-policy support per (level, bucket)
// ---------------------------------------------------------------------------

/** Options for the fresh-policy support count. */
export interface FreshPolicySupportOptions extends ExperienceFilterOptions {
  readonly bucket: string;
  readonly policyId: string;
  /** Neighbour budget; from `fresh >= k` the drift penalty stops. */
  readonly k: number;
}

/** Support of one (level, bucket) for one policy, after filtering. */
export interface FreshPolicySupport {
  readonly level: JitLevel;
  readonly bucket: string;
  readonly policyId: string;
  readonly k: number;
  /** Filtered records in this exact (level, bucket). */
  readonly usable: number;
  /** Usable records written by `policyId`. */
  readonly fresh: number;
  /** Usable records written by any superseded policy. */
  readonly stale: number;
  /** True once the bucket holds k fresh records, which ends the down-weight. */
  readonly saturated: boolean;
}

/**
 * Count the current policy's usable records in one (level, bucket).
 *
 * This is the M3 repair (plan section 7.4). Two properties matter and are
 * asserted by tests:
 *
 * 1. the count is per bucket, so a burst of fresh experience in a *different*
 *    bucket never counts as support for the bucket being decided; and
 * 2. only records that survive the shared filter count, so legacy,
 *    learning-ineligible or out-of-window records cannot saturate the bucket.
 */
export function freshPolicySupport(
  records: readonly ExperienceRecord[],
  options: FreshPolicySupportOptions
): FreshPolicySupport {
  const k = Math.max(1, Math.floor(finiteOr(options.k, JIT.k)));
  let usable = 0;
  let fresh = 0;
  for (const record of records ?? []) {
    if (experienceFilterReason(record, options) !== 'kept') {
      continue;
    }
    usable += 1;
    if (record.policyId === options.policyId) {
      fresh += 1;
    }
  }
  return {
    level: options.level,
    bucket: options.bucket,
    policyId: options.policyId,
    k,
    usable,
    fresh,
    stale: usable - fresh,
    saturated: fresh >= k
  };
}

// ---------------------------------------------------------------------------
// The kernel
// ---------------------------------------------------------------------------

/** Neighbour projection between retrieval and valuation (L1 surface folding). */
export type NeighborProjection<T> = (
  neighbors: readonly ScoredExperience[],
  candidates: readonly JitCandidate<T>[]
) => readonly ScoredExperience[];

/**
 * One decision, fully specified. Online and replay differ only in `records`
 * (current snapshot vs causally truncated snapshot) and in the seed they pass.
 */
export interface DecisionKernelContext<T> {
  readonly level: JitLevel;
  /** State abstraction of the decision point; the caller builds it. */
  readonly state: AbstractState;
  readonly candidates: readonly JitCandidate<T>[];
  /** Experience snapshot visible to this decision. */
  readonly records: readonly ExperienceRecord[];
  /** Effective layer configuration consumed by this decision. */
  readonly config: LayerDecisionConfig;
  /** Version tag of the configuration, copied into the result for audit. */
  readonly policyVersion?: string;
  /** Restrict neighbours to one guidance mode (invariant -> 'guidance_free'). */
  readonly guidance?: GuidanceMode;
  /** Drop legacy records from the neighbourhood (plan section 6.5). */
  readonly excludeLegacy?: boolean;
  readonly minimumExperienceSchemaVersion?: number;
  readonly learningEligibleOnly?: boolean;
  /** Injected clock; absent disables the decay and leaves `before` unused. */
  readonly now?: number;
  /** Deterministic seed; ignored when `rng` is supplied. */
  readonly seed?: number;
  /** Injected randomness (overrides `seed`). */
  readonly rng?: () => number;
  /** Documented extension point used by L1 for surface-qualified folding. */
  readonly projectNeighbors?: NeighborProjection<T>;
}

/** Trace of the filter stage, so a decision can explain its neighbourhood. */
export interface DecisionFilterTrace {
  readonly records: number;
  readonly kept: number;
  readonly level: JitLevel;
  readonly bucket: string;
  readonly guidance: GuidanceMode | null;
  readonly before: number | null;
  readonly excludeLegacy: boolean;
  readonly learningEligibleOnly: boolean;
}

/** Result of the pure kernel: the decision plus everything parity compares. */
export interface DecisionKernelResult<T> {
  readonly level: JitLevel;
  readonly stateValue: number;
  readonly neighborCount: number;
  /** Retrieved neighbours, in rank order (the weights parity compares). */
  readonly neighbors: readonly ScoredExperience[];
  /** Adjustments aligned with the candidate order. */
  readonly decision: JitDecision<T>;
  readonly filters: DecisionFilterTrace;
  /** Slots whose share moved, keyed by `slot:<kind>` action key. */
  readonly slotWeights: Readonly<Record<BatchSlotKind, number>> | null;
  /** Version of the effective configuration this decision consumed. */
  readonly policyVersion: string | null;
  readonly seed: number | null;
  /** Dimensions deliberately not searched, restated on every decision. */
  readonly ignored: readonly JitIgnoredDimension[];
}

/**
 * Run the one decision pipeline (plan section 7.1).
 *
 * Pure: same context in, same result out. The exploration draw is the only
 * randomness and it comes from `rng`/`seed`; no clock is read unless `now` was
 * supplied by the caller.
 */
export function runDecisionKernel<T>(
  context: DecisionKernelContext<T>
): DecisionKernelResult<T> {
  const { level, state, candidates, config } = context;
  if (state.level !== level) {
    throw new RangeError('decision kernel: level must match state.level');
  }
  const records = Array.isArray(context.records) ? context.records : [];
  const filterOptions: ExperienceFilterOptions = {
    level,
    guidance: context.guidance,
    before: config.before,
    ...(context.excludeLegacy === undefined ? {} : { excludeLegacy: context.excludeLegacy }),
    ...(context.minimumExperienceSchemaVersion === undefined
      ? {}
      : { minimumExperienceSchemaVersion: context.minimumExperienceSchemaVersion }),
    ...(context.learningEligibleOnly === undefined
      ? {}
      : { learningEligibleOnly: context.learningEligibleOnly })
  };
  const visible = filterExperienceSnapshot(records, filterOptions);

  const neighbors = retrieveNeighbors(visible, state, {
    k: config.k,
    similarityThreshold: config.similarityThreshold,
    level,
    ...(context.guidance === undefined ? {} : { guidanceFilter: context.guidance }),
    ...(config.before === undefined ? {} : { before: config.before }),
    ...(context.now === undefined ? {} : { now: context.now }),
    halfLifeMs: config.halfLifeMs,
    ...(config.policyId === undefined ? {} : { policyId: config.policyId }),
    ...(config.driftRho === undefined ? {} : { driftRho: config.driftRho })
  });
  const projected =
    context.projectNeighbors === undefined
      ? neighbors
      : context.projectNeighbors(neighbors, candidates);

  const seed = context.seed === undefined || !Number.isFinite(context.seed)
    ? null
    : Math.floor(context.seed) >>> 0;
  const rng = context.rng ?? (seed === null ? Math.random : createSeededRandom(seed));

  const decision = composeDecision(level, state, projected, candidates, {
    beta: config.beta,
    selection: config.selection,
    lambda: config.lambda,
    alpha: config.alpha,
    unseenFallback: config.unseenFallback,
    rng
  });

  return {
    level,
    stateValue: decision.stateValue,
    neighborCount: decision.neighborCount,
    neighbors: projected,
    decision,
    filters: {
      records: records.length,
      kept: visible.length,
      level,
      bucket: state.bucket,
      guidance: context.guidance ?? null,
      before: config.before ?? null,
      excludeLegacy: context.excludeLegacy === true,
      learningEligibleOnly: context.learningEligibleOnly === true
    },
    slotWeights: slotWeightsFromDecision(decision, candidates),
    policyVersion: context.policyVersion ?? null,
    seed,
    ignored: POLICY_IGNORED_DIMENSIONS
  };
}

/**
 * softmax(z') aggregated per slot kind (the allocation half of the pipeline).
 *
 * Shared by the online L1 decorator and the replay hook so both allocate the
 * same way; returns null when the candidates are not L1 slot actions, which is
 * how a non-meta decision keeps its own action-space semantics.
 */
export function slotWeightsFromDecision<T>(
  decision: JitDecision<T>,
  candidates: readonly JitCandidate<T>[]
): Readonly<Record<BatchSlotKind, number>> | null {
  const weights: Record<BatchSlotKind, number> = {
    exploit: 0,
    explore_domain: 0,
    explore_invariant: 0,
    recover: 0
  };
  if (candidates.length === 0 || decision.adjustments.length === 0) {
    return null;
  }
  let seen = false;
  for (let index = 0; index < candidates.length; index += 1) {
    const entry = decision.adjustments[index];
    const candidate = candidates[index];
    if (entry === undefined || candidate === undefined) {
      continue;
    }
    const kind = slotKindOfMetaActionKey(candidate.actionKey);
    if (kind === undefined) {
      return null;
    }
    seen = true;
    const probability = entry.probability;
    if (Number.isFinite(probability) && probability > 0) {
      weights[kind] += probability;
    }
  }
  if (!seen) {
    return null;
  }
  let total = 0;
  for (const kind of ['exploit', 'explore_domain', 'explore_invariant', 'recover'] as const) {
    total += weights[kind];
  }
  if (!(total > 0)) {
    return null;
  }
  for (const kind of ['exploit', 'explore_domain', 'explore_invariant', 'recover'] as const) {
    weights[kind] = weights[kind] / total;
  }
  return weights;
}

/**
 * Slot kind encoded in a normalized L1 action key ('slot:<kind>' or
 * 'slot:<kind>/surf:<...>'). Re-declared here so this module stays free of the
 * decorator import graph; `slotKindOfActionKey` in jit-active-policy.ts is the
 * canonical implementation and is asserted equal by tests.
 */
export function slotKindOfMetaActionKey(actionKey: string): BatchSlotKind | undefined {
  if (typeof actionKey !== 'string' || !actionKey.startsWith('slot:')) {
    return undefined;
  }
  const rest = actionKey.slice('slot:'.length);
  const suffixAt = rest.indexOf('/surf:');
  const head = suffixAt < 0 ? rest : rest.slice(0, suffixAt);
  return (
    ['exploit', 'explore_domain', 'explore_invariant', 'recover'] as BatchSlotKind[]
  ).find((kind) => kind === head);
}

/**
 * Slot-kind neighbour projection shared by L1 and replay (plan section 7.1).
 *
 * Exact action key first: with the surface action space enabled a slot kind owns
 * several candidates, and folding them all onto one key would hand every surface
 * the whole kind's support and destroy the very discrimination the surface
 * dimension exists for. Only when no candidate carries the exact key does a
 * record fall back to its slot-kind representative, which is what keeps a
 * backfilled `slot:<kind>/surf:<...>` record attributable to the live candidate
 * of that kind (support is per action, never per exact spelling).
 *
 * Lives in the kernel so the online decorator and the replay hook call the SAME
 * projection instead of each owning a copy.
 */
export function projectNeighborsBySlotKind<T>(
  neighbors: readonly ScoredExperience[],
  candidates: readonly JitCandidate<T>[]
): readonly ScoredExperience[] {
  const keys = new Set(candidates.map((candidate) => candidate.actionKey));
  const byKind = new Map<BatchSlotKind, string>();
  for (const candidate of candidates) {
    const kind = slotKindOfMetaActionKey(candidate.actionKey);
    if (kind === undefined || byKind.has(kind)) {
      continue;
    }
    byKind.set(kind, candidate.actionKey);
  }
  const out: ScoredExperience[] = [];
  for (const neighbor of neighbors) {
    if (keys.has(neighbor.record.actionKey)) {
      out.push(neighbor);
      continue;
    }
    const kind = slotKindOfMetaActionKey(neighbor.record.actionKey);
    const actionKey = kind === undefined ? undefined : byKind.get(kind);
    if (actionKey === undefined) {
      continue;
    }
    out.push({ ...neighbor, record: { ...neighbor.record, actionKey } });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Section 7.4: the replay publication gate and its boundary
// ---------------------------------------------------------------------------

/**
 * Declaration attached to every offline publication decision (plan section 7.4).
 *
 * The gate is a *proxy*: it compares hypervolume on a fixed historical replay.
 * It is not a guarantee that a future live task will not regress, and it cannot
 * see any task the recorded trees did not cover. Callers that need a live
 * guarantee must use a canary with a real budget and human confirmation.
 */
export const REPLAY_GATE_BOUNDARY =
  'hypervolume > baseline + epsilon is a proxy metric (a publication gate, not a promise): it holds only on the fixed historical replay set, and it is not a monotone non-regression guarantee for future live tasks';

/**
 * Verdict of the offline gate: publish, keep the incumbent, or shadow only.
 *
 * `shadow` records the difference between the suggested and the incumbent
 * policy without publishing it (plan section 7.4). Shadowed verdicts are the
 * default whenever a holdout split is configured and the candidate does not
 * still win there.
 */
export interface ReplayPublicationDecision {
  /** Strictly better on the replayed set (hypervolume > baseline + epsilon). */
  readonly improved: boolean;
  /** Actually publish (never true in shadow mode or after a failed holdout). */
  readonly publish: boolean;
  /** Why the verdict is what it is. */
  readonly reason: string;
  /** Bound declaration string copied into reports/logs. */
  readonly boundary: string;
}

/** Decide whether a replay evaluation may publish (plan section 7.4). */
export function decideReplayPublication(
  input: {
    readonly improved: boolean;
    readonly shadowMode?: boolean;
    /** Validation outcome; false means the candidate lost on held-out trees. */
    readonly validatedOnHoldout?: boolean;
    readonly candidatePolicyId?: string;
  }
): ReplayPublicationDecision {
  const boundary = REPLAY_GATE_BOUNDARY;
  if (!input.improved) {
    return {
      improved: false,
      publish: false,
      reason: 'the candidate did not beat baseline + epsilon on the replayed set',
      boundary
    };
  }
  if (input.shadowMode === true) {
    return {
      improved: true,
      publish: false,
      reason:
        'shadow mode: the suggestion was recorded but not published (no canary budget or human confirmation yet)',
      boundary
    };
  }
  if (input.validatedOnHoldout === false) {
    return {
      improved: true,
      publish: false,
      reason:
        'the candidate won on the selection trees but not on the held-out trees; publication withheld',
      boundary
    };
  }
  if (input.validatedOnHoldout !== true) {
    return {
      improved: true,
      publish: false,
      reason:
        'holdout-missing: held-out validation was not performed; publication withheld',
      boundary
    };
  }
  return {
    improved: true,
    publish: true,
    reason: 'the candidate strictly improved the replayed hypervolume',
    boundary
  };
}
