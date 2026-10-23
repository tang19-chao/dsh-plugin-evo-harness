/**
 * JitRL two-stage nearest-neighbour retriever (plan section 6.3).
 *
 * Ownership: src/jitrl/** (Phase 1 kernel, P1-3).
 *
 * Stage 1 - exact filtering: records of the same level and the same abstract
 * state bucket are preferred. When fewer than k/2 records match the bucket the
 * pool relaxes to every record of the same level, mirroring the paper's
 * cross-task memory (paper table 6: about 47% of retrievals are cross-task).
 * Stage 2 - Jaccard ranking: records below similarityThreshold are dropped and
 * the top-k survive, ordered by similarity.
 *
 * The retrieval weight used by the value estimator is
 *
 *   w_i = J(s, s_i) * 2 ^ (-(now - t_i) / halfLife)
 *
 * with an injected wall clock (now) and half-life (halfLifeMs), so results are
 * deterministic and the module performs no I/O. Records created after `now`
 * are clamped to age 0 and are never amplified by future timestamps.
 *
 * This module is a pure function over a snapshot of ExperienceRecords. It
 * deliberately does not import src/jitrl/experience-store.ts (that module owns
 * persistence and the inverted index). Two thin bridges are offered instead:
 * retrieve() accepts an object with a `records` array, and toExperienceQuery()
 * builds the contract query for IExperienceStore.query.
 */

import type {
  AbstractState,
  ExperienceQuery,
  ExperienceRecord,
  GuidanceMode,
  JitLevel,
  ScoredExperience
} from '../types/contracts';

/** Retrieval options; k and similarityThreshold come from the frozen config. */
export interface RetrieveOptions {
  /** Maximum number of neighbours to keep (config `jitrl.k`). */
  readonly k: number;
  /** Minimum Jaccard similarity, inclusive (config `jitrl.similarityThreshold`). */
  readonly similarityThreshold: number;
  /** Level override; defaults to state.level. */
  readonly level?: JitLevel;
  /** Restrict to one guidance mode; invariant slots force 'guidance_free'. */
  readonly guidanceFilter?: GuidanceMode;
  /** Causal cutoff on record.createdAt, inclusive. */
  readonly before?: number;
  /** Injected wall clock (ms since epoch). Absent disables time decay. */
  readonly now?: number;
  /** Half-life of the time decay in ms; <= 0 disables the decay. */
  readonly halfLifeMs?: number;
  /**
   * Current policy id (plan section 7.3-4). When set together with driftRho,
   * records written by a superseded policy are down-weighted so a hot-swapped
   * policy does not inherit evidence about the policy it replaced.
   */
  readonly policyId?: string;
  /**
   * Drift down-weight factor in [0, 1] (config `jitrl.dream.driftRho`, default
   * 0.7). Ignored unless `policyId` is also present.
   */
  readonly driftRho?: number;
}

/**
 * Drift context for one retrieval: which policy is current, the down-weight
 * factor and how much same-bucket evidence it has already produced.
 *
 * Section 7.3-4 stops the down-weighting once the current policy owns k records
 * in the same (level, bucket): from then on the neighbourhood is dominated by
 * fresh evidence, so the old-policy penalty is no longer needed.
 */
export interface DriftContext {
  readonly policyId: string;
  readonly driftRho: number;
  /** Number of current-policy records visible in the same (level, bucket). */
  readonly currentBucketCount: number;
  /** Neighbour budget; once currentBucketCount reaches it, drift stops. */
  readonly k: number;
}

/**
 * Drift factor for one record under a drift context: 1 when the record already
 * belongs to the current policy, when enough same-bucket current-policy
 * evidence exists, or when the factor would not change anything; `driftRho`
 * otherwise. Pure function of its arguments, so offline replay reproduces it.
 */
export function driftFactorFor(
  recordPolicyId: string,
  context: DriftContext
): number {
  if (recordPolicyId === context.policyId) {
    return 1;
  }
  if (context.currentBucketCount >= context.k) {
    return 1;
  }
  return context.driftRho;
}

/**
 * Count the current policy's records in one (level, bucket) of the already
 * filtered snapshot. Null when drift is not requested, so callers can keep the
 * legacy code path byte-identical.
 */
export function resolveDriftContext(
  bucketRecords: readonly ExperienceRecord[],
  options: RetrieveOptions
): DriftContext | null {
  const { policyId, driftRho } = options;
  if (policyId === undefined || driftRho === undefined) {
    return null;
  }
  let currentBucketCount = 0;
  for (const record of bucketRecords) {
    if (record.policyId === policyId) {
      currentBucketCount += 1;
    }
  }
  return { policyId, driftRho, currentBucketCount, k: options.k };
}

/** Anything exposing an experience snapshot; keeps this module store-agnostic. */
export interface ExperienceSource {
  readonly records: readonly ExperienceRecord[];
}

/** Union accepted by the retrieve() adapter. */
export type RetrievableExperiences = readonly ExperienceRecord[] | ExperienceSource;

/**
 * Jaccard similarity between two token sets:
 * |A intersect B| / |A union B|. Duplicate tokens are ignored. An empty set
 * has no defined union with anything, so any empty side yields 0.
 */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function validateOptions(state: AbstractState, options: RetrieveOptions): void {
  if (!Number.isInteger(options.k) || options.k < 1) {
    throw new RangeError('retrieve: k must be a positive integer');
  }
  const threshold = options.similarityThreshold;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new RangeError('retrieve: similarityThreshold must be a finite number in [0, 1]');
  }
  for (const [name, value] of [
    ['now', options.now],
    ['halfLifeMs', options.halfLifeMs],
    ['before', options.before]
  ] as const) {
    if (value !== undefined && !Number.isFinite(value)) {
      throw new RangeError('retrieve: ' + name + ' must be finite when provided');
    }
  }
  if (options.halfLifeMs !== undefined && options.halfLifeMs < 0) {
    throw new RangeError('retrieve: halfLifeMs must be >= 0');
  }
  if (options.driftRho !== undefined) {
    if (!Number.isFinite(options.driftRho)) {
      throw new RangeError('retrieve: driftRho must be finite when provided');
    }
    if (options.driftRho < 0 || options.driftRho > 1) {
      throw new RangeError('retrieve: driftRho must be in [0, 1]');
    }
  }
  if (options.policyId !== undefined && typeof options.policyId !== 'string') {
    throw new TypeError('retrieve: policyId must be a string when provided');
  }
  if (!Array.isArray(state.tokens)) {
    throw new TypeError('retrieve: state.tokens must be an array');
  }
}

function matchesBaseFilters(
  record: ExperienceRecord,
  level: JitLevel,
  options: RetrieveOptions
): boolean {
  if (record.level !== level) {
    return false;
  }
  if (options.guidanceFilter !== undefined && record.guidance !== options.guidanceFilter) {
    return false;
  }
  // A non-finite timestamp cannot be ordered or decayed, so it is not a neighbour.
  if (!Number.isFinite(record.createdAt)) {
    return false;
  }
  if (options.before !== undefined && record.createdAt > options.before) {
    return false;
  }
  return true;
}

function retrievalWeight(
  similarity: number,
  createdAt: number,
  options: RetrieveOptions,
  driftFactor: number = 1
): number {
  const { now, halfLifeMs } = options;
  let base = similarity;
  if (now !== undefined && halfLifeMs !== undefined && halfLifeMs > 0) {
    const age = now - createdAt;
    const clampedAge = age > 0 ? age : 0;
    base = similarity * Math.pow(2, -clampedAge / halfLifeMs);
  }
  // Drift composes with the half-life decay instead of replacing it: a stale
  // policy's record keeps its decayed weight and is additionally scaled by
  // rho_drift (plan section 7.3-4).
  return base * driftFactor;
}

/** Deterministic ranking: similarity desc, then newest first, then id asc. */
function compareScored(left: ScoredExperience, right: ScoredExperience): number {
  if (left.similarity !== right.similarity) {
    return right.similarity - left.similarity;
  }
  if (left.record.createdAt !== right.record.createdAt) {
    return right.record.createdAt - left.record.createdAt;
  }
  if (left.record.id < right.record.id) {
    return -1;
  }
  if (left.record.id > right.record.id) {
    return 1;
  }
  return 0;
}

/**
 * Pure two-stage retrieval over an in-memory experience snapshot.
 *
 * The returned ScoredExperience entries always carry an explicit `weight`
 * (similarity times half-life decay). Zero-weight records are dropped: they
 * add support without information and would bias state-value averages.
 */
export function retrieveNeighbors(
  records: readonly ExperienceRecord[],
  state: AbstractState,
  options: RetrieveOptions
): readonly ScoredExperience[] {
  validateOptions(state, options);
  const level = options.level ?? state.level;

  const levelRecords: ExperienceRecord[] = [];
  for (const record of records) {
    if (matchesBaseFilters(record, level, options)) {
      levelRecords.push(record);
    }
  }

  const bucketRecords = levelRecords.filter(
    (record) => record.state.bucket === state.bucket
  );
  // "If exact hits are fewer than k/2, relax to the whole level" (section 6.3).
  const exactEnough = bucketRecords.length >= options.k / 2;
  const pool = exactEnough ? bucketRecords : levelRecords;

  // Drift context is derived from the same (level, bucket) postings the exact
  // stage already selected. `null` means "no drift requested", which keeps the
  // legacy path byte-identical (no driftWeight field, unchanged weights).
  const drift = resolveDriftContext(bucketRecords, options);

  const scored: ScoredExperience[] = [];
  for (const record of pool) {
    const similarity = jaccard(state.tokens, record.state.tokens);
    // A zero-similarity record is not a neighbour even when the configured
    // threshold is 0: it carries no evidence and would inflate support counts.
    if (similarity <= 0 || similarity < options.similarityThreshold) {
      continue;
    }
    const factor = drift === null ? 1 : driftFactorFor(record.policyId, drift);
    const weight = retrievalWeight(similarity, record.createdAt, options, factor);
    if (!Number.isFinite(weight) || weight <= 0) {
      continue;
    }
    // The factor is reported only when it actually changed the weight, so an
    // untuned retrieval returns the exact pre-Phase-4 objects.
    if (factor === 1) {
      scored.push({ record, similarity, weight });
    } else {
      scored.push({ record, similarity, weight, driftWeight: factor });
    }
  }

  scored.sort(compareScored);
  return scored.slice(0, options.k);
}

/**
 * Thin adapter: accepts either a raw record array or `{ records }` so callers
 * can pass an in-memory snapshot without depending on a concrete store type.
 */
export function retrieve(
  source: RetrievableExperiences,
  state: AbstractState,
  options: RetrieveOptions
): readonly ScoredExperience[] {
  const records = Array.isArray(source)
    ? source
    : (source as ExperienceSource).records;
  return retrieveNeighbors(records, state, options);
}

/**
 * Build the store-facing ExperienceQuery for the same retrieval parameters.
 * Half-life decay is intentionally not part of the query contract: the store
 * filters, this module re-weights the returned snapshot. The drift inputs are
 * forwarded, because the store applies the same section 7.3-4 factor itself.
 */
export function toExperienceQuery(
  state: AbstractState,
  options: RetrieveOptions
): ExperienceQuery {
  validateOptions(state, options);
  return {
    level: options.level ?? state.level,
    state,
    k: options.k,
    similarityThreshold: options.similarityThreshold,
    ...(options.guidanceFilter === undefined
      ? {}
      : { guidanceFilter: options.guidanceFilter }),
    ...(options.before === undefined ? {} : { before: options.before }),
    ...(options.policyId === undefined ? {} : { policyId: options.policyId }),
    ...(options.driftRho === undefined ? {} : { driftRho: options.driftRho })
  };
}
