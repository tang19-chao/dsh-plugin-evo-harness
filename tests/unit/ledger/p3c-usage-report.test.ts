/**
 * P3-C: usage accounting separates measured / estimated / unknown.
 *
 * Also pins the semantics source rule: counting semantics come ONLY from the
 * explicit provider/host argument. Omitting them means unknown, never a guessed
 * shape; and an unreported cacheRead dimension is surfaced as unknown instead of
 * passing the conservative floor off as measured data.
 */
import { describe, expect, it } from 'vitest';
import {
  calculateUsageCost,
  createUsagePayload,
  dshUsageToProviderPayload,
  summarizeCostProvenance,
  summarizeUsageAccounting,
  validateUsageAccountingReport,
  type ModelRateCard
} from '../../../src/ledger';

const RATE_CARD: ModelRateCard = {
  modelId: 'p3c/test-model',
  inputRatePerMillion: 1_000_000,
  outputRatePerMillion: 2_000_000,
  reasoningSeparatelyBilled: false,
  conservativeFallbackCostMicros: 500
};

const SEMANTICS = { inputIncludesCacheRead: true, outputIncludesReasoning: true } as const;

describe('counting semantics: explicit only, never guessed', () => {
  it('omits countingSemantics when the caller supplied none', () => {
    const payload = dshUsageToProviderPayload({ inputTokens: 10, outputTokens: 5 });
    expect(payload.countingSemantics).toBeUndefined();
    // Absent dimensions are declared unreported, not silently zeroed.
    expect(payload.unreportedMetrics).toContain('cacheReadTokens');
    expect(payload.unreportedMetrics).toContain('cacheWriteTokens');
    expect(payload.unreportedMetrics).toContain('reasoningTokens');
  });

  it('carries explicit provider semantics verbatim', () => {
    const payload = dshUsageToProviderPayload({ inputTokens: 10 }, SEMANTICS);
    expect(payload.countingSemantics).toEqual(SEMANTICS);
  });

  it('a payload without semantics is provenance unknown (not measured)', () => {
    const usage = createUsagePayload({ input: 500, output: 200, cacheRead: 50 });
    const cost = calculateUsageCost(usage, RATE_CARD);
    expect(cost.provenance).toBe('unknown');
    expect(cost.conservative).toBe(true);
  });
});

describe('cacheRead unavailable stays unknown, never a measured zero', () => {
  it('marks the cacheRead dimension unknown and surfaces the gap', () => {
    const usage = createUsagePayload({ input: 500, output: 200, semantics: SEMANTICS });
    const cost = calculateUsageCost(usage, RATE_CARD);
    expect(cost.dimensionProvenance?.cacheRead).toBe('unknown');
    expect(cost.cacheReadUnavailable).toBe(true);
    expect(cost.auditNote).toContain('cacheRead unavailable');
    expect(cost.auditNote).toContain('not a measured zero');
  });

  it('marks cacheRead measured only when the provider really reported it', () => {
    const usage = createUsagePayload({ input: 500, output: 200, cacheRead: 50, semantics: SEMANTICS });
    const cost = calculateUsageCost(usage, RATE_CARD);
    expect(cost.dimensionProvenance?.cacheRead).toBe('measured');
    expect(cost.cacheReadUnavailable).toBe(false);
  });
});

describe('usage report: the three states are separate buckets', () => {
  function threeStateCosts() {
    const measuredUsage = createUsagePayload({
      input: 1_000,
      output: 500,
      cacheRead: 100,
      semantics: SEMANTICS,
      precision: 'measured'
    });
    const estimatedUsage = createUsagePayload({
      input: 1_000,
      output: 500,
      cacheRead: 100,
      semantics: SEMANTICS,
      precision: 'estimated'
    });
    const unknownUsage = createUsagePayload({ input: 1_000, output: 500, cacheRead: 100 });
    return [
      calculateUsageCost(measuredUsage, RATE_CARD),
      calculateUsageCost(estimatedUsage, RATE_CARD),
      calculateUsageCost(unknownUsage, RATE_CARD)
    ] as const;
  }

  it('keeps measured, estimated and unknown counts/costs disjoint', () => {
    const report = summarizeCostProvenance(threeStateCosts());
    expect(report.measured.calls).toBe(1);
    expect(report.estimated.calls).toBe(1);
    expect(report.unknown.calls).toBe(1);
    expect(report.totalCalls).toBe(3);
    expect(report.measured.share).toBeCloseTo(1 / 3, 10);
    expect(report.estimated.share).toBeCloseTo(1 / 3, 10);
    expect(report.unknown.share).toBeCloseTo(1 / 3, 10);
    // Costs are reported separately per bucket and sum to the total.
    expect(report.measuredCostMicros).toBe(report.measured.costMicros);
    expect(report.estimatedCostMicros).toBe(report.estimated.costMicros);
    expect(report.unknownCostMicros).toBe(report.unknown.costMicros);
    expect(report.measured.costMicros + report.estimated.costMicros + report.unknown.costMicros).toBe(
      report.totalCostMicros
    );
    // measured and estimated are NEVER merged: the measured bucket is the only
    // one that may be read as actual spend.
    expect(report.measured.costMicros).toBeGreaterThan(0);
    expect(report.estimated.costMicros).toBeGreaterThan(0);
  });

  it('satisfies the closure rules', () => {
    const report = summarizeCostProvenance(threeStateCosts());
    expect(validateUsageAccountingReport(report)).toEqual([]);
  });

  it('counts calls whose cacheRead dimension is unknown', () => {
    const withCacheRead = createUsagePayload({
      input: 100,
      output: 50,
      cacheRead: 10,
      semantics: SEMANTICS
    });
    const withoutCacheRead = createUsagePayload({ input: 100, output: 50, semantics: SEMANTICS });
    const report = summarizeCostProvenance([
      calculateUsageCost(withCacheRead, RATE_CARD),
      calculateUsageCost(withoutCacheRead, RATE_CARD)
    ]);
    expect(report.cacheReadUnknownCalls).toBe(1);
    expect(report.totalCalls).toBe(2);
  });

  it('summarizes settled ledger events (the production report path)', () => {
    const report = summarizeUsageAccounting([]);
    expect(report.totalCalls).toBe(0);
    expect(report.totalCostMicros).toBe(0);
    expect(report.measured.share).toBe(0);
    expect(validateUsageAccountingReport(report)).toEqual([]);
  });

  it('validates a corrupted report instead of hiding it', () => {
    const report = summarizeCostProvenance(threeStateCosts());
    const corrupted = {
      ...report,
      measured: { ...report.measured, calls: 2 }
    };
    const issues = validateUsageAccountingReport(corrupted);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.join('|')).toContain('counts do not sum');
  });
});
