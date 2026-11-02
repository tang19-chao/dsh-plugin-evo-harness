/**
 * LEDGER-10 (audit round 1, confirmed in round 2): a payload with measured
 * input/output but no reasoning tokens was priced as `provenance: 'measured'`
 * with `reasoningCostMicros = 0` even when the rate card bills reasoning
 * separately, and an unreported cacheWrite dimension had no flag at all. Only
 * cacheRead carried a compensating flag (`cacheReadUnavailable`), so the usage
 * report understated what the provider never reported.
 *
 * WHAT THIS PINS (the fix contract):
 *
 *   - `cacheWriteUnavailable` is set when cacheWrite was never reported (not a
 *     measured zero), and cleared when the provider did report it;
 *   - `reasoningUnavailable` is set ONLY when the card bills reasoning separately
 *     and the metric is absent — a card that folds reasoning into output keeps
 *     the dimension covered by the output figure, so it is not flagged;
 *   - the audit note names each gap (never a silent 'measured' label);
 *   - the usage report counts both dimensions per call
 *     (`cacheWriteUnknownCalls` / `reasoningUnknownCalls`) and keeps the
 *     closure rules intact.
 *
 * The flags are additive labels on purpose: the overall provenance bucket
 * stays 'measured' for the dimensions that WERE measured (the report shape
 * consumers read), while the unknown dimensions stay visible per call.
 */
import { describe, expect, it } from 'vitest';
import {
  calculateUsageCost,
  createUsageLedgerEvent,
  createUsagePayload,
  summarizeCostProvenance,
  summarizeUsageAccounting,
  validateUsageAccountingReport,
  type ModelRateCard
} from '../../../src/ledger';

/** Reasonings are billed separately at 5x the output rate (the audit's shape). */
const SEPARATE_REASONING_CARD: ModelRateCard = {
  modelId: 'ledger-10/separate-reasoning',
  inputRatePerMillion: 1_000_000,
  outputRatePerMillion: 2_000_000,
  reasoningRatePerMillion: 10_000_000,
  cacheWriteRatePerMillion: 3_000_000,
  reasoningSeparatelyBilled: true,
  conservativeFallbackCostMicros: 500
};

/** Reasonings folded into output: no separate reasoning dimension to miss. */
const FOLDED_REASONING_CARD: ModelRateCard = {
  ...SEPARATE_REASONING_CARD,
  reasoningSeparatelyBilled: false
};

const SEMANTICS = { inputIncludesCacheRead: true, outputIncludesReasoning: true } as const;

describe('LEDGER-10: unreported separately-priced dimensions are flagged, not called measured', () => {
  it('flags separately-billed reasoning the provider never reported', () => {
    // The audited payload: measured input/output, NO reasoningTokens.
    const usage = createUsagePayload({ input: 1_000, output: 500, cacheRead: 10, cacheWrite: 5, semantics: SEMANTICS });
    const cost = calculateUsageCost(usage, SEPARATE_REASONING_CARD);

    expect(cost.dimensionProvenance?.reasoning).toBe('unknown');
    expect(cost.reasoningUnavailable).toBe(true);
    expect(cost.auditNote).toContain('reasoning is separately billed but unreported');
    expect(cost.auditNote).toContain('not a measured zero');
    // The dimension genuinely measured is NOT over-flagged.
    expect(cost.dimensionProvenance?.output).toBe('measured');
    expect(cost.cacheReadUnavailable).toBe(false);
    expect(cost.cacheWriteUnavailable).toBe(false);
  });

  it('does not flag reasoning when the provider reported it', () => {
    const usage = createUsagePayload({
      input: 1_000,
      output: 500,
      reasoning: 200,
      cacheWrite: 5,
      semantics: SEMANTICS
    });
    const cost = calculateUsageCost(usage, SEPARATE_REASONING_CARD);
    expect(cost.dimensionProvenance?.reasoning).toBe('measured');
    expect(cost.reasoningUnavailable).toBe(false);
    expect(cost.breakdown.reasoningCostMicros).toBe(2_000); // 200 * 10
  });

  it('does not flag reasoning when the card folds it into output', () => {
    // Not separately billed: absent reasoning means the output figure already
    // covers it (or the card prices it at the output rate), so there is no
    // unknown separately-priced dimension to report.
    const usage = createUsagePayload({ input: 1_000, output: 500, cacheRead: 10, cacheWrite: 5, semantics: SEMANTICS });
    const cost = calculateUsageCost(usage, FOLDED_REASONING_CARD);
    expect(cost.reasoningUnavailable).toBe(false);
    expect(cost.auditNote ?? '').not.toContain('reasoning is separately billed');
  });

  it('flags an unreported cacheWrite dimension in both directions', () => {
    const withoutCacheWrite = createUsagePayload({ input: 100, output: 50, cacheRead: 5, semantics: SEMANTICS });
    const without = calculateUsageCost(withoutCacheWrite, SEPARATE_REASONING_CARD);
    expect(without.dimensionProvenance?.cacheWrite).toBe('unknown');
    expect(without.cacheWriteUnavailable).toBe(true);
    expect(without.auditNote).toContain('cacheWrite unavailable');
    // The priced 0 is not evidence that cache writes were free.
    expect(without.breakdown.cacheWriteCostMicros).toBe(0);

    const withCacheWrite = createUsagePayload({ input: 100, output: 50, cacheRead: 5, cacheWrite: 7, semantics: SEMANTICS });
    const withReported = calculateUsageCost(withCacheWrite, SEPARATE_REASONING_CARD);
    expect(withReported.dimensionProvenance?.cacheWrite).toBe('measured');
    expect(withReported.cacheWriteUnavailable).toBe(false);
    expect(withReported.breakdown.cacheWriteCostMicros).toBe(21); // 7 * 3
  });

  it('counts the gaps per call in the report (and keeps the closure rules)', () => {
    const gapUsage = createUsagePayload({ input: 100, output: 50, semantics: SEMANTICS });
    const reportedUsage = createUsagePayload({
      input: 100,
      output: 50,
      cacheWrite: 5,
      reasoning: 20,
      semantics: SEMANTICS
    });
    const gapCost = calculateUsageCost(gapUsage, SEPARATE_REASONING_CARD);
    const reportedCost = calculateUsageCost(reportedUsage, SEPARATE_REASONING_CARD);

    const report = summarizeCostProvenance([gapCost, reportedCost]);
    expect(report.totalCalls).toBe(2);
    expect(report.cacheWriteUnknownCalls).toBe(1);
    expect(report.reasoningUnknownCalls).toBe(1);
    // Neither payload reported cacheRead, so that pre-existing counter (which
    // LEDGER-10 extends, not replaces) counts both calls.
    expect(report.cacheReadUnknownCalls).toBe(2);
    expect(validateUsageAccountingReport(report)).toEqual([]);

    // The production report path (settled events) counts the same way.
    const event = (eventId: number, cost: typeof gapCost) =>
      createUsageLedgerEvent({
        callId: 'call-' + String(eventId),
        reservationId: 'res_' + String(eventId),
        phase: 'probe',
        outcome: 'succeeded',
        incurredCostMicros: cost.totalCostMicros,
        usage: gapUsage,
        cost,
        timestamp: 1_772_000_000_000 + eventId
      });
    const fromEvents = summarizeUsageAccounting([event(1, gapCost), event(2, gapCost)]);
    expect(fromEvents.cacheWriteUnknownCalls).toBe(2);
    expect(fromEvents.reasoningUnknownCalls).toBe(2);
    expect(validateUsageAccountingReport(fromEvents)).toEqual([]);
  });
});
