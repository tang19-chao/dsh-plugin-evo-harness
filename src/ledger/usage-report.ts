/**
 * P3-C: usage accounting report with measured / estimated / unknown SEPARATED.
 *
 * The cost contract has three provenance states (ADR-0003 §7.3). Collapsing them
 * into one number is the defect this module exists to prevent: an "estimated"
 * token count presented as a measured cost is a false financial claim, and a
 * "measured" zero that actually means "the provider never reported cacheRead" is
 * the cacheRead hole called out in P3-C.
 *
 * PRODUCTION USE
 *   - `summarizeUsageAccounting(ledgerEvents)` is the run-level report a host can
 *     print or persist; every bucket carries its own call count and cost.
 *   - `validateUsageAccountingReport` encodes the closure rules a report must
 *     satisfy (counts sum to total, shares sum to 1, costs sum to total). The
 *     PR-4A provenance gate uses the same shape: a declared measurement
 *     capability may produce measured data, but the counts/shares must still
 *     close.
 */

import type { CostCalculation, MeasurementPrecision, UsageLedgerEvent } from './types.js';

/** One provenance bucket. `share` is the share of CALLS, never of cost. */
export interface CostProvenanceBucket {
  readonly calls: number;
  readonly costMicros: number;
  readonly share: number;
}

/** Run-level usage accounting with the three states kept separate. */
export interface UsageAccountingReport {
  readonly totalCalls: number;
  readonly totalCostMicros: number;
  readonly measured: CostProvenanceBucket;
  readonly estimated: CostProvenanceBucket;
  readonly unknown: CostProvenanceBucket;
  /** Calls whose cacheRead dimension is unknown (not a measured zero). */
  readonly cacheReadUnknownCalls: number;
  /** Convenience totals: identical to the buckets' costMicros, kept explicit. */
  readonly measuredCostMicros: number;
  readonly estimatedCostMicros: number;
  readonly unknownCostMicros: number;
}

function emptyBucket(): { calls: number; costMicros: number } {
  return { calls: 0, costMicros: 0 };
}

function summarize(costs: readonly CostCalculation[], cacheReadUnknown: number): UsageAccountingReport {
  const buckets: Record<MeasurementPrecision, { calls: number; costMicros: number }> = {
    measured: emptyBucket(),
    estimated: emptyBucket(),
    unknown: emptyBucket()
  };
  for (const cost of costs) {
    const bucket = buckets[cost.provenance];
    bucket.calls += 1;
    bucket.costMicros += cost.totalCostMicros;
  }
  const totalCalls = costs.length;
  const totalCostMicros = costs.reduce((sum, cost) => sum + cost.totalCostMicros, 0);
  const withShare = (bucket: { calls: number; costMicros: number }): CostProvenanceBucket => ({
    calls: bucket.calls,
    costMicros: bucket.costMicros,
    share: totalCalls === 0 ? 0 : bucket.calls / totalCalls
  });
  return {
    totalCalls,
    totalCostMicros,
    measured: withShare(buckets.measured),
    estimated: withShare(buckets.estimated),
    unknown: withShare(buckets.unknown),
    cacheReadUnknownCalls: cacheReadUnknown,
    measuredCostMicros: buckets.measured.costMicros,
    estimatedCostMicros: buckets.estimated.costMicros,
    unknownCostMicros: buckets.unknown.costMicros
  };
}

/** Build the report from settled ledger events (the production report path). */
export function summarizeUsageAccounting(
  events: readonly UsageLedgerEvent[]
): UsageAccountingReport {
  const costs = events.map((event) => event.cost);
  const cacheReadUnknownCalls = events.filter(
    (event) => event.cost.cacheReadUnavailable === true
  ).length;
  return summarize(costs, cacheReadUnknownCalls);
}

/** Build the report directly from cost calculations (tests / non-event paths). */
export function summarizeCostProvenance(
  costs: readonly CostCalculation[]
): UsageAccountingReport {
  const cacheReadUnknownCalls = costs.filter((cost) => cost.cacheReadUnavailable === true).length;
  return summarize(costs, cacheReadUnknownCalls);
}

/**
 * Closure rules for a provenance report. Returns human-readable issues; an empty
 * array means the report is internally consistent.
 *
 * These are ORDERING-FREE rules: they do not require measured to be 0 or > 0.
 * That is the point — the old PR-4A "measured must be 0" gate conflated a
 * capability fact with a permanent rule.
 */
export function validateUsageAccountingReport(
  report: UsageAccountingReport
): readonly string[] {
  const issues: string[] = [];
  const sumCalls = report.measured.calls + report.estimated.calls + report.unknown.calls;
  if (sumCalls !== report.totalCalls) {
    issues.push('counts do not sum to totalCalls: ' + String(sumCalls) + ' vs ' + String(report.totalCalls));
  }
  const shareSum = report.measured.share + report.estimated.share + report.unknown.share;
  if (report.totalCalls === 0 ? shareSum !== 0 : Math.abs(shareSum - 1) > 1e-9) {
    issues.push('shares do not sum to 1: ' + String(shareSum));
  }
  const sumCost =
    report.measured.costMicros + report.estimated.costMicros + report.unknown.costMicros;
  if (sumCost !== report.totalCostMicros) {
    issues.push('bucket costs do not sum to totalCostMicros: ' + String(sumCost) + ' vs ' + String(report.totalCostMicros));
  }
  for (const bucket of [report.measured, report.estimated, report.unknown]) {
    if (bucket.calls < 0 || bucket.costMicros < 0) {
      issues.push('negative bucket value');
    }
  }
  if (report.cacheReadUnknownCalls < 0 || report.cacheReadUnknownCalls > report.totalCalls) {
    issues.push('cacheReadUnknownCalls out of range');
  }
  return issues;
}
