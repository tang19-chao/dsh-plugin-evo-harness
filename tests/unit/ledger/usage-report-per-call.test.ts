/**
 * LEDGER-4 (audit rounds 1+2): the usage accounting report used to SUM events.
 * `ledgerEvents` holds one event per settle/reconcile and a reconciliation event
 * carries the FULL new total (replacement semantics), so an interim settle plus
 * its reconcile reported interim + reconciled against a pool that had only ever
 * booked the reconciled figure (repro: report 4,000u vs pool 3,000u, and
 * `totalCalls: 2` for ONE call). The report flowed into `getMeteringStatus()`
 * and the real-benefit-controller canary evidence.
 *
 * WHAT THIS PINS (the fix contract):
 *   - the report aggregates by callId keeping only the LATEST event per call
 *     (the metered adapter's `bookedByCall` idea), so the report EQUALS what the
 *     pools booked and `totalCalls` counts CALLS, never events;
 *   - provenance buckets are per call: the latest event's provenance wins;
 *   - distinct calls stay distinct; the closure rules still hold.
 *
 * Everything runs on the REAL manager and settlement (no mocks); only
 * callId/usage values are constructed.
 */
import { describe, expect, it } from 'vitest';
import {
  calculateUsageCost,
  createLedgerReservationManager,
  createUsageLedgerEvent,
  createUsagePayload,
  summarizeUsageAccounting,
  twoPhaseSettlementFor,
  validateUsageAccountingReport,
  type LedgerReservationManager,
  type ModelRateCard,
  type ProviderUsagePayload
} from '../../../src/ledger';

const RATE_CARD: ModelRateCard = {
  modelId: 'ledger-4/report-model',
  inputRatePerMillion: 1_000_000,
  outputRatePerMillion: 2_000_000,
  reasoningSeparatelyBilled: false,
  conservativeFallbackCostMicros: 500
};

const SEMANTICS = { inputIncludesCacheRead: true, outputIncludesReasoning: true } as const;

const SMALL_USAGE: ProviderUsagePayload = createUsagePayload({
  input: 1_000,
  output: 200,
  semantics: SEMANTICS
});

const LATE_USAGE: ProviderUsagePayload = createUsagePayload({
  input: 2_000,
  output: 500,
  cacheRead: 100,
  semantics: SEMANTICS
});

function makeManager(): LedgerReservationManager {
  return createLedgerReservationManager({
    enabled: true,
    enforceHardBounds: true,
    generalBudgetMicros: 10_000_000,
    verificationReserveMicros: 1_000_000,
    maxConcurrencySeats: 4,
    defaultRateCard: RATE_CARD
  });
}

describe('LEDGER-4: the usage report aggregates per call, not per event', () => {
  it('interim + reconcile: the report equals what the pool booked (one call, two events)', () => {
    const manager = makeManager();
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'test' });
    const reserved = settlement.beginCall({
      callId: 'call-interim-reconciled',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 10_000,
      requiresSeat: false
    });
    settlement.settleCall({ callId: 'call-interim-reconciled', reservationId: reserved.reservationId as string, outcome: 'cancelled' });
    const merged = settlement.reconcileLateUsage({ originCallId: 'call-interim-reconciled', usage: LATE_USAGE });

    // Two events exist (one per settle/reconcile) but ONE call.
    expect(manager.getLedgerEvents()).toHaveLength(2);
    const report = manager.getUsageAccounting();
    // The audited defect reported 4,000u (interim + reconciled) against a pool
    // that booked 3,000u, and totalCalls: 2 for one call.
    expect(report.totalCostMicros).toBe(manager.getBudgetStatus().generalPool.settledMicros);
    expect(report.totalCostMicros).toBe(merged.incurredCostMicros);
    expect(report.totalCalls).toBe(1);
    // The LATEST event decides the bucket: the reconcile is measured, so the
    // earlier unknown interim event no longer inflates the unknown bucket.
    expect(report.unknown.calls).toBe(0);
    expect(report.measured.calls).toBe(1);
    expect(report.measured.costMicros).toBe(merged.incurredCostMicros);
    expect(report.cacheReadUnknownCalls).toBe(0);
    expect(validateUsageAccountingReport(report)).toEqual([]);

    // The metering status (the canary evidence path) agrees with the pool.
    const status = manager.getMeteringStatus();
    expect(status.totalCostMicros).toBe(manager.getBudgetStatus().generalPool.settledMicros);
    expect(status.measuredCalls).toBe(1);
    expect(status.unknownCalls).toBe(0);
  });

  it('reconcile after final: the replacement total wins, not old + new', () => {
    const manager = makeManager();
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'test' });
    const reserved = settlement.beginCall({
      callId: 'call-final-reconciled',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 10_000,
      requiresSeat: false
    });
    settlement.settleCall({
      callId: 'call-final-reconciled',
      reservationId: reserved.reservationId as string,
      outcome: 'succeeded',
      usage: SMALL_USAGE
    });
    settlement.reconcileLateUsage({ originCallId: 'call-final-reconciled', usage: LATE_USAGE });

    const report = manager.getUsageAccounting();
    expect(report.totalCostMicros).toBe(calculateUsageCost(LATE_USAGE, RATE_CARD).totalCostMicros);
    expect(report.totalCostMicros).toBe(manager.getBudgetStatus().generalPool.settledMicros);
    expect(report.totalCalls).toBe(1);
    expect(validateUsageAccountingReport(report)).toEqual([]);
  });

  it('distinct calls stay distinct: totalCalls counts calls and the buckets stay disjoint', () => {
    const manager = makeManager();
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'test' });
    for (const callId of ['call-a', 'call-b']) {
      const reserved = settlement.beginCall({
        callId,
        phase: 'probe',
        pool: 'general',
        estimatedCostMicros: 10_000,
        requiresSeat: false
      });
      settlement.settleCall({ callId, reservationId: reserved.reservationId as string, outcome: 'succeeded', usage: SMALL_USAGE });
    }

    const report = manager.getUsageAccounting();
    expect(report.totalCalls).toBe(2);
    expect(report.totalCostMicros).toBe(
      2 * calculateUsageCost(SMALL_USAGE, RATE_CARD).totalCostMicros
    );
    expect(report.totalCostMicros).toBe(manager.getBudgetStatus().generalPool.settledMicros);
    expect(report.measured.calls).toBe(2);
    expect(validateUsageAccountingReport(report)).toEqual([]);
  });

  it('the latest event per call decides cacheReadUnknownCalls too', () => {
    // Hand-built pair (same callId): the earlier event flags cacheRead as
    // unavailable, the later (reconcile-shaped) event measured it — the call is
    // no longer counted as cacheRead-unknown. Reversing the order flips it.
    const unknownCost = calculateUsageCost(
      createUsagePayload({ input: 100, output: 50, semantics: SEMANTICS }),
      RATE_CARD
    );
    expect(unknownCost.cacheReadUnavailable).toBe(true);
    const measuredCost = calculateUsageCost(
      createUsagePayload({ input: 100, output: 50, cacheRead: 10, semantics: SEMANTICS }),
      RATE_CARD
    );
    expect(measuredCost.cacheReadUnavailable).toBe(false);
    const event = (eventId: number, cost: typeof unknownCost) =>
      createUsageLedgerEvent({
        callId: 'call-cache-read',
        reservationId: 'res_cache-read',
        phase: 'probe',
        outcome: 'succeeded',
        incurredCostMicros: cost.totalCostMicros,
        usage: createUsagePayload({ input: 100, output: 50, semantics: SEMANTICS }),
        cost,
        timestamp: 1_772_000_000_000 + eventId
      });

    const healed = summarizeUsageAccounting([event(1, unknownCost), event(2, measuredCost)]);
    expect(healed.totalCalls).toBe(1);
    expect(healed.cacheReadUnknownCalls).toBe(0);
    const regressed = summarizeUsageAccounting([event(1, measuredCost), event(2, unknownCost)]);
    expect(regressed.totalCalls).toBe(1);
    expect(regressed.cacheReadUnknownCalls).toBe(1);
  });
});
