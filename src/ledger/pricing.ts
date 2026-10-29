/**
 * Pricing and Usage Cost Adapter.
 *
 * Implements ADR-0003 §7.3:
 * - Anti-double counting for cacheRead / cacheWrite and reasoning tokens.
 * - Explicit counting semantics enforcement (undeclared semantics => unknown provenance).
 * - Three-state measurement precision tracking (measured, estimated, unknown).
 * - Strictly non-zero conservative cost ceiling for unknown usage.
 */

import {
  CostCalculation,
  CountingSemantics,
  MeasurementPrecision,
  ModelRateCard,
  ProviderUsagePayload,
  TokenMetric,
  UsageMetricName
} from './types.js';

/**
 * Determine overall precision across a set of metrics and semantic declaration.
 */
export function aggregatePrecision(
  metrics: Array<TokenMetric | undefined>,
  semanticsDeclared: boolean
): MeasurementPrecision {
  if (!semanticsDeclared) {
    return 'unknown';
  }

  let hasEstimated = false;
  for (const m of metrics) {
    if (!m) continue;
    if (m.precision === 'unknown') {
      return 'unknown';
    }
    if (m.precision === 'estimated') {
      hasEstimated = true;
    }
  }

  return hasEstimated ? 'estimated' : 'measured';
}

/**
 * Calculate cost for a provider usage payload given a model rate card.
 *
 * Guarantees:
 * 1. If countingSemantics is missing, provenance is 'unknown' and conservative fallback is applied.
 * 2. If inputIncludesCacheRead is true, net uncached input tokens = inputTokens - cacheReadTokens.
 *    cacheRead is never double-charged with input!
 * 3. If outputIncludesReasoning is true and reasoning is not separately billed, reasoning is NOT added again.
 *    If reasoning IS separately billed, net output tokens = outputTokens - reasoningTokens.
 *    reasoning is never double-charged with output!
 * 4. If any metric is unknown, or if the calculation results in 0 cost when unknown/conservative,
 *    conservativeFallbackCostMicros (> 0) is applied.
 */
export function calculateUsageCost(
  usage: ProviderUsagePayload,
  rateCard: ModelRateCard
): CostCalculation {
  const semantics = usage.countingSemantics;
  const semanticsDeclared = semantics !== undefined && semantics !== null;

  const rawInput = usage.inputTokens?.tokens ?? 0;
  const rawCacheRead = usage.cacheReadTokens?.tokens ?? 0;
  const rawCacheWrite = usage.cacheWriteTokens?.tokens ?? 0;
  const rawOutput = usage.outputTokens?.tokens ?? 0;
  const rawReasoning = usage.reasoningTokens?.tokens ?? 0;

  const metrics: Array<TokenMetric | undefined> = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    usage.reasoningTokens
  ];

  const provenance = aggregatePrecision(metrics, semanticsDeclared);
  const isUnknown = provenance === 'unknown';
  let conservative = isUnknown;

  // 1. Input & Cache Deduplication
  let netInputTokens = Math.max(0, rawInput);
  const cacheReadTokens = Math.max(0, rawCacheRead);
  const cacheWriteTokens = Math.max(0, rawCacheWrite);

  if (semanticsDeclared && semantics.inputIncludesCacheRead) {
    // If input already includes cache read, subtract it to prevent double charging
    netInputTokens = Math.max(0, rawInput - cacheReadTokens);
  }

  const cacheReadRate = rateCard.cacheReadRatePerMillion ?? rateCard.inputRatePerMillion;
  const cacheWriteRate = rateCard.cacheWriteRatePerMillion ?? rateCard.inputRatePerMillion;

  const inputCostMicros = Math.round((netInputTokens * rateCard.inputRatePerMillion) / 1_000_000);
  const cacheReadCostMicros = Math.round((cacheReadTokens * cacheReadRate) / 1_000_000);
  const cacheWriteCostMicros = Math.round((cacheWriteTokens * cacheWriteRate) / 1_000_000);

  // 2. Output & Reasoning Deduplication
  let netOutputTokens = Math.max(0, rawOutput);
  let reasoningTokens = Math.max(0, rawReasoning);
  let reasoningCostMicros = 0;

  if (rateCard.reasoningSeparatelyBilled && (rateCard.reasoningRatePerMillion ?? 0) > 0) {
    const reasoningRate = rateCard.reasoningRatePerMillion!;
    if (semanticsDeclared && semantics.outputIncludesReasoning) {
      // Raw output contains reasoning; deduct reasoning to price each separately
      netOutputTokens = Math.max(0, rawOutput - reasoningTokens);
    }
    reasoningCostMicros = Math.round((reasoningTokens * reasoningRate) / 1_000_000);
  } else {
    // Reasoning is not separately billed
    if (semanticsDeclared && semantics.outputIncludesReasoning) {
      // Already included in outputTokens; reasoning cost is 0 and no extra tokens added
      reasoningCostMicros = 0;
    } else {
      // Not included in outputTokens; add reasoning tokens to net output at standard output rate
      netOutputTokens = rawOutput + reasoningTokens;
      reasoningCostMicros = 0;
    }
  }

  const outputCostMicros = Math.round((netOutputTokens * rateCard.outputRatePerMillion) / 1_000_000);

  const baseCalculatedCost =
    inputCostMicros +
    cacheReadCostMicros +
    cacheWriteCostMicros +
    outputCostMicros +
    reasoningCostMicros;

  // 3. Conservative Non-Zero Upper Bound for Unknown Usage (ADR-0003 §7.3.5)
  // unknown 必须落到保守上界金额，绝不允许静默记 0
  let conservativeSurchargeMicros = 0;
  let totalCostMicros = baseCalculatedCost;

  const fallbackFloor = Math.max(1, rateCard.conservativeFallbackCostMicros);

  if (conservative) {
    if (totalCostMicros < fallbackFloor) {
      conservativeSurchargeMicros = fallbackFloor - totalCostMicros;
      totalCostMicros = fallbackFloor;
    }
  }

  let auditNote: string | undefined;
  if (!semanticsDeclared) {
    auditNote = 'countingSemantics undeclared; provenance forced to unknown with conservative floor';
  } else if (conservativeSurchargeMicros > 0) {
    auditNote = `conservative fallback floor applied: base=${baseCalculatedCost}u, floor=${fallbackFloor}u`;
  }
  // P3-C: provenance is per dimension. cacheRead that the provider never
  // reported stays 'unknown'; it is NOT a measured zero and the conservative
  // floor is a floor, never evidence that cache reads were free.
  const dimensionProvenance = {
    input: usage.inputTokens?.precision ?? 'unknown',
    output: usage.outputTokens?.precision ?? 'unknown',
    cacheRead: usage.cacheReadTokens?.precision ?? 'unknown',
    cacheWrite: usage.cacheWriteTokens?.precision ?? 'unknown',
    reasoning: usage.reasoningTokens?.precision ?? 'unknown'
  } as const;
  const cacheReadUnavailable =
    usage.cacheReadTokens === undefined || usage.cacheReadTokens.precision !== 'measured';
  if (cacheReadUnavailable) {
    // An unreported cacheRead dimension is NOT a measured zero. The floor (if
    // any) is a cost floor, not evidence that cache reads were free.
    const cacheNote = 'cacheRead unavailable; cacheRead cost is unknown, not a measured zero';
    auditNote = auditNote === undefined ? cacheNote : auditNote + '; ' + cacheNote;
  }

  return {
    totalCostMicros,
    breakdown: {
      netInputTokens,
      inputCostMicros,
      cacheReadTokens,
      cacheReadCostMicros,
      cacheWriteTokens,
      cacheWriteCostMicros,
      netOutputTokens,
      outputCostMicros,
      reasoningTokens,
      reasoningCostMicros,
      conservativeSurchargeMicros: conservativeSurchargeMicros > 0 ? conservativeSurchargeMicros : undefined
    },
    provenance,
    dimensionProvenance,
    cacheReadUnavailable,
    conservative,
    auditNote
  };
}

/**
 * Helper to construct a standard token metric.
 */
export function metric(
  tokens: number,
  precision: MeasurementPrecision = 'measured'
): TokenMetric {
  return { tokens: Math.max(0, tokens), precision };
}

/**
 * Helper to construct a ProviderUsagePayload with specified counting semantics.
 */
export function createUsagePayload(params: {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  semantics?: CountingSemantics;
  precision?: MeasurementPrecision;
}): ProviderUsagePayload {
  const p = params.precision ?? 'measured';
  return {
    inputTokens: metric(params.input, p),
    outputTokens: metric(params.output, p),
    ...(params.cacheRead !== undefined ? { cacheReadTokens: metric(params.cacheRead, p) } : {}),
    ...(params.cacheWrite !== undefined ? { cacheWriteTokens: metric(params.cacheWrite, p) } : {}),
    ...(params.reasoning !== undefined ? { reasoningTokens: metric(params.reasoning, p) } : {}),
    countingSemantics: params.semantics
  };
}

/**
 * Standard counting semantics for DSH / DeepSeek models (ADR-0004 §3.3).
 */
export const DEFAULT_DSH_COUNTING_SEMANTICS: CountingSemantics = Object.freeze({
  inputIncludesCacheRead: true,
  outputIncludesReasoning: true,
  semanticTag: 'dsh-deepseek-v1'
});

export interface RawDshUsageLike {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
}

/**
 * Convert raw DSH usage telemetry into a ProviderUsagePayload without discarding
 * cacheRead, cacheWrite, or reasoning tokens (ADR-0004 §3.2).
 */
export function dshUsageToProviderPayload(
  usage: RawDshUsageLike | undefined,
  semantics?: CountingSemantics
): ProviderUsagePayload {
  // P3-C: counting semantics come ONLY from the explicit argument (provider or
  // host metadata). There is no default: omitting them means "unknown", never a
  // guessed DSH/DeepSeek shape inferred from field names or a model id.
  const unreported: UsageMetricName[] = [];
  if (!usage) {
    return {
      inputTokens: { tokens: 0, precision: 'unknown' },
      outputTokens: { tokens: 0, precision: 'unknown' },
      ...(semantics === undefined ? {} : { countingSemantics: semantics }),
      unreportedMetrics: [
        'inputTokens',
        'outputTokens',
        'cacheReadTokens',
        'cacheWriteTokens',
        'reasoningTokens'
      ]
    };
  }
  if (usage.inputTokens === undefined) unreported.push('inputTokens');
  if (usage.outputTokens === undefined) unreported.push('outputTokens');
  if (usage.cacheReadTokens === undefined) unreported.push('cacheReadTokens');
  if (usage.cacheWriteTokens === undefined) unreported.push('cacheWriteTokens');
  if (usage.reasoningTokens === undefined) unreported.push('reasoningTokens');
  return {
    inputTokens: {
      tokens: usage.inputTokens ?? 0,
      precision: usage.inputTokens !== undefined ? 'measured' : 'unknown'
    },
    outputTokens: {
      tokens: usage.outputTokens ?? 0,
      precision: usage.outputTokens !== undefined ? 'measured' : 'unknown'
    },
    ...(usage.cacheReadTokens !== undefined
      ? { cacheReadTokens: { tokens: usage.cacheReadTokens, precision: 'measured' as const } }
      : {}),
    ...(usage.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: { tokens: usage.cacheWriteTokens, precision: 'measured' as const } }
      : {}),
    ...(usage.reasoningTokens !== undefined
      ? { reasoningTokens: { tokens: usage.reasoningTokens, precision: 'measured' as const } }
      : {}),
    ...(usage.totalTokens !== undefined
      ? { totalTokens: { tokens: usage.totalTokens, precision: 'measured' as const } }
      : {}),
    ...(semantics === undefined ? {} : { countingSemantics: semantics }),
    ...(unreported.length === 0 ? {} : { unreportedMetrics: unreported })
  };
}
