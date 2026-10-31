/**
 * rev6 R2-3: cacheRead observation with a precision-preserving ledger and a
 * three-way optimisation gate.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The harness has no tokenizer: every figure the research path produces is
 * `chars/4` labelled `estimated`, and `cacheReadTokens` is 0 (estimated) in all
 * five frozen PR-4A arms with 0 measured cost calls out of 900. That means the
 * cacheRead question ("is prefix caching actually saving reads?") has never been
 * MEASURED here, and a module that quietly folded `estimated` into `measured`
 * would turn "we cannot see it" into "we measured a saving" - the exact false
 * financial claim `src/ledger/usage-report.ts` exists to prevent.
 *
 * So this module does three things and refuses a fourth:
 *   1. it derives a sample's precision from WHAT THE PROVIDER ACTUALLY REPORTED,
 *      mirroring `dshUsageToProviderPayload`'s P3-C rule that counting semantics
 *      come only from explicit provider metadata;
 *   2. it keeps `measured` / `estimated` / `unknown` in separate buckets and can
 *      never upgrade a sample (see `downgradeSample` - upgrades are a type error
 *      by construction, not a runtime check that could be forgotten);
 *   3. it judges a Tail Injection proposal through a THREE-WAY gate that needs
 *      measured, paired, statistically significant reduction;
 *   4. it never proposes the optimisation itself. Even `applicable` only means
 *      "an A/B is now justified" - implementing it is a separate, authorised act.
 */
import type { CountingSemantics, MeasurementPrecision } from '../ledger/types';

/**
 * The raw DSH usage telemetry shape this module reads.
 *
 * Declared structurally (not imported from `ledger/pricing`) so an observation
 * can be taken from the host bypass carrier without this module depending on the
 * pricing implementation.
 */
export interface ObservedDshUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
}

/** Which of the six raw telemetry fields the provider actually reported. */
export const RAW_USAGE_FIELDS = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens'
] as const;
export type RawUsageField = (typeof RAW_USAGE_FIELDS)[number];

/** The precision of every dimension, kept apart so cacheRead cannot hide behind input. */
export interface CacheDimensionPrecision {
  readonly input: MeasurementPrecision;
  readonly output: MeasurementPrecision;
  readonly cacheRead: MeasurementPrecision;
  readonly cacheWrite: MeasurementPrecision;
  readonly reasoning: MeasurementPrecision;
}

/** One observed model call, with its provenance chain intact. */
export interface CacheReadSample {
  /** Stable call identity (the host's callId). */
  readonly callId: string;
  /** Task the call belongs to; paired analysis joins on this. */
  readonly taskId: string;
  /** `'baseline'` (cache off) or `'treatment'` (cache on). */
  readonly arm: 'baseline' | 'treatment';
  /** Stage/purpose label, carried for audit; never used to infer precision. */
  readonly purpose: string;
  /** Raw token figures EXACTLY as reported (0 when unreported - see precision). */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly dimensionPrecision: CacheDimensionPrecision;
  /** The cacheRead precision, mirrored for callers that only care about it. */
  readonly cacheReadPrecision: MeasurementPrecision;
  /** True when the provider did not report cacheRead (NOT a measured zero). */
  readonly cacheReadUnavailable: boolean;
  /** Raw fields the provider actually reported, in `RAW_USAGE_FIELDS` order. */
  readonly reportedFields: readonly RawUsageField[];
  /** Raw fields the provider omitted. */
  readonly unreportedFields: readonly RawUsageField[];
  /** Where the precision judgement came from, for auditability. */
  readonly provenanceSource: string;
}

/**
 * One paired observation: the same task measured with cache off and cache on.
 *
 * `precision` is the WEAKER of the two sides: a pair cannot be more precise than
 * its least precise half, so a measured baseline against an estimated treatment
 * is an estimated pair (and therefore cannot open the gate).
 */
export interface PairedCacheReadSample {
  readonly taskId: string;
  readonly baselineCacheRead: number;
  readonly treatmentCacheRead: number;
  readonly precision: MeasurementPrecision;
  readonly baselineCallIds: readonly string[];
  readonly treatmentCallIds: readonly string[];
  /** Tasks whose cacheRead was unavailable on either side cannot be paired. */
  readonly complete: boolean;
}

/** Run-level accounting with the three precisions kept separate. */
export interface CacheObservationAccounting {
  readonly totalSamples: number;
  readonly measuredCalls: number;
  readonly estimatedCalls: number;
  readonly unknownCalls: number;
  /** Calls whose cacheRead dimension is unknown (not a measured zero). */
  readonly cacheReadUnknownCalls: number;
  readonly measuredCacheReadTokens: number;
  readonly estimatedCacheReadTokens: number;
  readonly unknownCacheReadTokens: number;
}

/** Precision ranking: a pair takes the MINIMUM, so `downgrade` is the only direction. */
const PRECISION_RANK: Readonly<Record<MeasurementPrecision, number>> = {
  measured: 2,
  estimated: 1,
  unknown: 0
};

/** The weaker of two precisions. Used for pairs and for downgrades. */
export function weakerPrecision(left: MeasurementPrecision, right: MeasurementPrecision): MeasurementPrecision {
  return PRECISION_RANK[left] <= PRECISION_RANK[right] ? left : right;
}

/**
 * Downgrade a sample's precision.
 *
 * UPGRADING IS NOT REPRESENTABLE: there is no `upgradeSample`, and this function
 * applies `weakerPrecision`, so `downgradeSample(sample, 'measured')` on an
 * estimated sample returns it unchanged. That is deliberate - a later caller
 * cannot relabel estimated/unknown data as measured even by passing 'measured'.
 */
export function downgradeSample(sample: CacheReadSample, to: MeasurementPrecision): CacheReadSample {
  const cacheReadPrecision = weakerPrecision(sample.cacheReadPrecision, to);
  if (cacheReadPrecision === sample.cacheReadPrecision) {
    return sample;
  }
  return {
    ...sample,
    cacheReadPrecision,
    dimensionPrecision: {
      ...sample.dimensionPrecision,
      cacheRead: cacheReadPrecision
    },
    provenanceSource: sample.provenanceSource + '; downgraded to ' + cacheReadPrecision
  };
}

function finitePositiveOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function reportedFieldsOf(usage: ObservedDshUsage): { reported: RawUsageField[]; unreported: RawUsageField[] } {
  const reported: RawUsageField[] = [];
  const unreported: RawUsageField[] = [];
  for (const field of RAW_USAGE_FIELDS) {
    if (finitePositiveOrUndefined(usage[field]) === undefined) {
      unreported.push(field);
    } else {
      reported.push(field);
    }
  }
  return { reported, unreported };
}

/** Input for one `observeCacheUsage` call. */
export interface ObserveCacheUsageInput {
  readonly callId: string;
  readonly taskId: string;
  readonly arm: 'baseline' | 'treatment';
  readonly purpose: string;
  /** Raw host telemetry; `undefined` when the host reported no usage at all. */
  readonly rawUsage: ObservedDshUsage | undefined;
  /**
   * Counting semantics declared BY THE PROVIDER/HOST. Absent means the raw
   * numbers cannot be interpreted, so cacheRead stays `unknown` - a cacheRead
   * figure whose meaning is unknown is not a measurement.
   */
  readonly semantics: CountingSemantics | undefined;
}

/**
 * Observe one call's cacheRead usage.
 *
 * PRECISION RULES (each is a test case):
 *   - no rawUsage at all                    -> every dimension unknown;
 *   - cacheReadTokens absent                -> cacheRead `unknown`, `unavailable`;
 *   - cacheReadTokens present, no semantics -> cacheRead `unknown` (meaning is not
 *     knowable: `inputIncludesCacheRead` decides whether this double-counts);
 *   - cacheReadTokens present + semantics   -> cacheRead `measured`.
 *
 * A reported `cacheReadTokens: 0` with semantics is a MEASURED ZERO (the provider
 * really said zero); an omitted field is `unavailable` and must never be read as
 * a zero saving.
 */
export function observeCacheUsage(input: ObserveCacheUsageInput): CacheReadSample {
  const usage = input.rawUsage;
  if (usage === undefined) {
    return {
      callId: input.callId,
      taskId: input.taskId,
      arm: input.arm,
      purpose: input.purpose,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      dimensionPrecision: {
        input: 'unknown',
        output: 'unknown',
        cacheRead: 'unknown',
        cacheWrite: 'unknown',
        reasoning: 'unknown'
      },
      cacheReadPrecision: 'unknown',
      cacheReadUnavailable: true,
      reportedFields: [],
      unreportedFields: [...RAW_USAGE_FIELDS],
      provenanceSource: 'host reported no usage for this call'
    };
  }

  const { reported, unreported } = reportedFieldsOf(usage);
  const hasSemantics = input.semantics !== undefined;
  const precisionOf = (field: RawUsageField): MeasurementPrecision => {
    const value = finitePositiveOrUndefined(usage[field]);
    if (value === undefined) {
      return 'unknown';
    }
    // A raw number is only MEASURED when its counting semantics were declared;
    // otherwise we know a number exists but not what it counts.
    return hasSemantics ? 'measured' : 'unknown';
  };

  const dimensionPrecision: CacheDimensionPrecision = {
    input: precisionOf('inputTokens'),
    output: precisionOf('outputTokens'),
    cacheRead: precisionOf('cacheReadTokens'),
    cacheWrite: precisionOf('cacheWriteTokens'),
    reasoning: precisionOf('reasoningTokens')
  };
  const cacheReadReported = finitePositiveOrUndefined(usage.cacheReadTokens) !== undefined;

  return {
    callId: input.callId,
    taskId: input.taskId,
    arm: input.arm,
    purpose: input.purpose,
    inputTokens: finitePositiveOrUndefined(usage.inputTokens) ?? 0,
    outputTokens: finitePositiveOrUndefined(usage.outputTokens) ?? 0,
    cacheReadTokens: finitePositiveOrUndefined(usage.cacheReadTokens) ?? 0,
    cacheWriteTokens: finitePositiveOrUndefined(usage.cacheWriteTokens) ?? 0,
    reasoningTokens: finitePositiveOrUndefined(usage.reasoningTokens) ?? 0,
    dimensionPrecision,
    cacheReadPrecision: dimensionPrecision.cacheRead,
    cacheReadUnavailable: !cacheReadReported,
    reportedFields: reported,
    unreportedFields: unreported,
    provenanceSource: cacheReadReported
      ? hasSemantics
        ? 'provider reported cacheReadTokens with declared counting semantics'
        : 'provider reported cacheReadTokens but declared no counting semantics, so the figure is not interpretable'
      : 'provider did not report cacheReadTokens (this is not a measured zero)'
  };
}

/**
 * Observe one call whose token figures came from a HEURISTIC (e.g. `chars/4`).
 *
 * This exists so the estimated path is first-class and can be fed to the gate as
 * a NEGATIVE CONTROL: an estimated sample can never open the gate. Every
 * dimension is `estimated` regardless of what the heuristic produced.
 */
export function observeEstimatedCacheUsage(input: {
  callId: string;
  taskId: string;
  arm: 'baseline' | 'treatment';
  purpose: string;
  cacheReadTokens: number;
  inputTokens: number;
  outputTokens: number;
  estimator: string;
}): CacheReadSample {
  const clamp = (value: number): number => (Number.isFinite(value) && value >= 0 ? value : 0);
  return {
    callId: input.callId,
    taskId: input.taskId,
    arm: input.arm,
    purpose: input.purpose,
    inputTokens: clamp(input.inputTokens),
    outputTokens: clamp(input.outputTokens),
    cacheReadTokens: clamp(input.cacheReadTokens),
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    dimensionPrecision: {
      input: 'estimated',
      output: 'estimated',
      cacheRead: 'estimated',
      cacheWrite: 'unknown',
      reasoning: 'unknown'
    },
    cacheReadPrecision: 'estimated',
    cacheReadUnavailable: false,
    reportedFields: ['inputTokens', 'outputTokens', 'cacheReadTokens'],
    unreportedFields: ['totalTokens', 'cacheWriteTokens', 'reasoningTokens'],
    provenanceSource: 'heuristic estimator: ' + input.estimator + ' (never a measurement)'
  };
}

/** Accounting over a sample set, three ways and never collapsed. */
export function summarizeCacheObservations(samples: readonly CacheReadSample[]): CacheObservationAccounting {
  let measuredCalls = 0;
  let estimatedCalls = 0;
  let unknownCalls = 0;
  let cacheReadUnknownCalls = 0;
  let measuredCacheReadTokens = 0;
  let estimatedCacheReadTokens = 0;
  let unknownCacheReadTokens = 0;
  for (const sample of samples) {
    switch (sample.cacheReadPrecision) {
      case 'measured':
        measuredCalls += 1;
        measuredCacheReadTokens += sample.cacheReadTokens;
        break;
      case 'estimated':
        estimatedCalls += 1;
        estimatedCacheReadTokens += sample.cacheReadTokens;
        break;
      default:
        unknownCalls += 1;
        unknownCacheReadTokens += sample.cacheReadTokens;
        break;
    }
    if (sample.cacheReadUnavailable || sample.cacheReadPrecision === 'unknown') {
      cacheReadUnknownCalls += 1;
    }
  }
  return {
    totalSamples: samples.length,
    measuredCalls,
    estimatedCalls,
    unknownCalls,
    cacheReadUnknownCalls,
    measuredCacheReadTokens,
    estimatedCacheReadTokens,
    unknownCacheReadTokens
  };
}

/** Sum one arm's cacheRead tokens for a task, or `undefined` if any call was unusable. */
function sumArm(samples: readonly CacheReadSample[]): { tokens: number; precision: MeasurementPrecision; callIds: string[]; complete: boolean } {
  let tokens = 0;
  let precision: MeasurementPrecision = 'measured';
  const callIds: string[] = [];
  let complete = samples.length > 0;
  for (const sample of samples) {
    callIds.push(sample.callId);
    tokens += sample.cacheReadTokens;
    precision = weakerPrecision(precision, sample.cacheReadPrecision);
    if (sample.cacheReadUnavailable) {
      complete = false;
    }
  }
  return { tokens, precision, callIds, complete };
}

/**
 * Pair baseline and treatment calls by task.
 *
 * A task contributes a pair only when BOTH arms produced at least one call. The
 * pair's precision is the weaker of the two arms (see `PairedCacheReadSample`).
 * Tasks with an unusable cacheRead on either side are still reported, marked
 * `complete: false`, so the analysis can say HOW MANY pairs it lost rather than
 * silently analysing a favourable subset.
 */
export function pairByTask(samples: readonly CacheReadSample[]): readonly PairedCacheReadSample[] {
  const byTask = new Map<string, { baseline: CacheReadSample[]; treatment: CacheReadSample[] }>();
  for (const sample of samples) {
    let bucket = byTask.get(sample.taskId);
    if (bucket === undefined) {
      bucket = { baseline: [], treatment: [] };
      byTask.set(sample.taskId, bucket);
    }
    bucket[sample.arm].push(sample);
  }
  const pairs: PairedCacheReadSample[] = [];
  for (const [taskId, bucket] of [...byTask.entries()].sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))) {
    if (bucket.baseline.length === 0 || bucket.treatment.length === 0) {
      continue;
    }
    const baseline = sumArm(bucket.baseline);
    const treatment = sumArm(bucket.treatment);
    pairs.push({
      taskId,
      baselineCacheRead: baseline.tokens,
      treatmentCacheRead: treatment.tokens,
      precision: weakerPrecision(baseline.precision, treatment.precision),
      baselineCallIds: baseline.callIds,
      treatmentCallIds: treatment.callIds,
      complete: baseline.complete && treatment.complete
    });
  }
  return pairs;
}

/** The optimisation decision. `applicable` means "an A/B is justified", nothing more. */
export type CacheOptimizationGate =
  | { readonly status: 'gated-not-applicable'; readonly reason: string }
  | { readonly status: 'measured-no-significant-reduction'; readonly reason: string; readonly meanReduction: number }
  | {
      readonly status: 'applicable';
      readonly reason: string;
      readonly meanReduction: number;
      readonly discordantPairs: number;
      readonly signTestP: number;
      readonly recommendation: string;
    };

/** Exact two-sided sign test over the discordant pairs. */
function exactSignTestP(reduced: number, increased: number): number {
  const discordant = reduced + increased;
  if (discordant === 0) {
    return 1;
  }
  const k = Math.min(reduced, increased);
  let tail = 0;
  let combination = 1;
  for (let i = 0; i <= k; i += 1) {
    tail += combination;
    combination = (combination * (discordant - i)) / (i + 1);
  }
  return Math.min(1, (2 * tail) / Math.pow(2, discordant));
}

/**
 * Decide whether prefix caching has measurably reduced cacheRead tokens, which
 * is the ONLY condition that justifies proposing Tail Injection.
 *
 * The gate opens on ALL of:
 *   1. the pairs are `measured` (an estimated or unknown pair cannot open it -
 *      this is the negative control, exercised in both directions in the tests);
 *   2. at least one pair is complete and shows a real reduction (not a tie);
 *   3. the exact two-sided sign test is significant at alpha = 0.05.
 *
 * Otherwise it says WHY it is closed. It never returns a fabricated effect, and
 * `applicable` deliberately recommends an A/B rather than the optimisation.
 */
export function cacheOptimizationGate(
  pairs: readonly PairedCacheReadSample[],
  options: { readonly alpha?: number } = {}
): CacheOptimizationGate {
  const alpha = options.alpha ?? 0.05;
  if (pairs.length === 0) {
    return { status: 'gated-not-applicable', reason: 'no paired cacheRead observations exist' };
  }
  const complete = pairs.filter((pair) => pair.complete);
  if (complete.length === 0) {
    return {
      status: 'gated-not-applicable',
      reason: 'every pair has an unavailable cacheRead on at least one side, so no reduction can be computed'
    };
  }

  // Rule 1: precision. Checked BEFORE any arithmetic so an estimated data set can
  // never produce a number that looks like an effect.
  const weak = complete.filter((pair) => pair.precision !== 'measured');
  if (weak.length > 0) {
    const kinds = [...new Set(weak.map((pair) => pair.precision))].sort().join('/');
    return {
      status: 'gated-not-applicable',
      reason:
        'cacheRead tokens are ' + kinds + ' (not measured) in ' + String(weak.length) + ' of ' +
        String(complete.length) + ' complete pairs, so no reduction can be claimed; estimated and unknown data are never relabelled as measured'
    };
  }

  let reduction = 0;
  let reduced = 0;
  let increased = 0;
  for (const pair of complete) {
    reduction += pair.baselineCacheRead - pair.treatmentCacheRead;
    if (pair.treatmentCacheRead < pair.baselineCacheRead) {
      reduced += 1;
    } else if (pair.treatmentCacheRead > pair.baselineCacheRead) {
      increased += 1;
    }
  }
  const meanReduction = reduction / complete.length;

  // Rule 2: a real reduction must exist somewhere.
  if (reduced === 0) {
    return {
      status: 'measured-no-significant-reduction',
      reason: 'measured, but not one task shows a cacheRead reduction',
      meanReduction
    };
  }

  // Rule 3: significance over the discordant pairs.
  const p = exactSignTestP(reduced, increased);
  if (p > alpha) {
    return {
      status: 'measured-no-significant-reduction',
      reason: 'measured, but the sign test is not significant (p=' + p.toFixed(6) + ' > alpha=' + String(alpha) + ')',
      meanReduction
    };
  }
  return {
    status: 'applicable',
    reason:
      'measured cacheRead reduction is significant (p=' + p.toFixed(6) + ' <= alpha=' + String(alpha) + ')',
    meanReduction,
    discordantPairs: reduced + increased,
    signTestP: p,
    recommendation:
      'a same-task / same-budget / same-seed Tail Injection A/B is now justified; implementing the optimisation is a separate authorised act and is NOT performed by this module'
  };
}

/**
 * Serialise an observation set for the report/CLI.
 *
 * Deliberately shallow and lossless: no derived yes/no, so downstream cannot
 * read a conclusion the module did not draw.
 */
export function describeCacheObservations(input: {
  readonly samples: readonly CacheReadSample[];
  readonly pairs: readonly PairedCacheReadSample[];
  readonly gate: CacheOptimizationGate;
}): Record<string, unknown> {
  return {
    accounting: summarizeCacheObservations(input.samples),
    pairs: input.pairs.map((pair) => ({
      taskId: pair.taskId,
      baselineCacheRead: pair.baselineCacheRead,
      treatmentCacheRead: pair.treatmentCacheRead,
      precision: pair.precision,
      complete: pair.complete,
      baselineCallIds: pair.baselineCallIds,
      treatmentCallIds: pair.treatmentCallIds
    })),
    gate: input.gate
  };
}
