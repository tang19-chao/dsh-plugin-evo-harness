/**
 * PR-3B acceptance tests — ADR-0004 §10.2 matrix (3B-L1 … 3B-L5) plus the edge
 * cases this task calls out explicitly: over-reservation, unknown cost, price
 * update (time-freeze), cancellation with no response, crash, duplicate events,
 * and the requirement that incurred cost is never truncated.
 *
 * WHAT THESE TESTS PROTECT
 * ------------------------
 * ADR-0004 §7.1 exists because three things look like a spending cap and are not:
 * `reserve(estimated)` is only an admission check, `conservativeFallbackCostMicros`
 * is a LOWER bound (floor), and a `Promise.race` timeout only abandons the local
 * wait. The only control that bounds the bill is a physical cap on generation plus
 * a bounded input, both priced. So the assertions here are deliberately about
 * REJECTION and PHYSICAL CEILINGS, not about estimates.
 *
 * Everything is offline: no network, no model, no paid call.
 */
import { describe, expect, it } from 'vitest';

import { LedgerReservationManager } from '../../../src/ledger/reservation-manager.js';
import {
  DEFAULT_WATERMARKS,
  computeCallCostUpperBound,
  computeWatermarkTier,
  criticalTierSeatCap,
  decideAdmission,
  poolLimitStatus,
  rateCardDigest,
  seatUnits,
  currencyMicros,
  assertDimensionSeparated,
  DimensionMismatchError,
  type RouteCostBound
} from '../../../src/ledger/limits.js';
import {
  DEFAULT_RECONCILIATION_TOLERANCE_MICROS,
  applyManualResolution,
  proposeAdjustment,
  reconcileWithExternalBill
} from '../../../src/ledger/reconciliation.js';
import type { ModelRateCard } from '../../../src/ledger/types.js';

/** 1µ per input token, 2µ per output token. */
const RATE: ModelRateCard = {
  modelId: 't7-card',
  inputRatePerMillion: 1_000_000,
  outputRatePerMillion: 2_000_000,
  reasoningSeparatelyBilled: false,
  conservativeFallbackCostMicros: 10_000
};

/** A route satisfying all three §7.2 preconditions. */
const BOUNDED: RouteCostBound = {
  routeId: 'bounded',
  maxOutputTokens: 100,
  maxInputTokens: 1_000,
  maxReasoningTokens: 0,
  maxNetworkAttempts: 1,
  tokenizerVerified: true,
  providerEnforcesMaxTokens: true,
  allBillableDimensionsPriced: true
};

function makeManager(overrides: {
  general?: number;
  verification?: number;
  seats?: number;
  policy?: { mode: 'hard' | 'observation'; allowUnboundedRiskOverride: boolean; unboundedRiskStopLossMicros?: number };
  routes?: RouteCostBound[];
} = {}) {
  return new LedgerReservationManager({
    generalBudgetMicros: overrides.general ?? 1_000_000,
    verificationReserveMicros: overrides.verification ?? 200_000,
    maxConcurrencySeats: overrides.seats ?? 4,
    defaultRateCard: RATE,
    ...(overrides.policy === undefined ? {} : { admissionPolicy: overrides.policy }),
    ...(overrides.routes === undefined ? {} : { routeBounds: overrides.routes })
  });
}

// ---------------------------------------------------------------------------
// 3B-L1 — a bounded route is admitted at its PHYSICAL ceiling
// ---------------------------------------------------------------------------
describe('3B-L1 a provably bounded route is admitted at the physical ceiling', () => {
  it('computes the upper bound from every priced dimension', () => {
    const verdict = computeCallCostUpperBound(BOUNDED, RATE);
    expect(verdict.bounded).toBe(true);
    if (!verdict.bounded) {
      return;
    }
    // 1000 input × 1µ/1M = 1000µ ; 100 output × 2µ/1M = 200µ ; 1 attempt.
    expect(verdict.breakdown.inputCostMicros).toBe(1_000);
    expect(verdict.breakdown.outputCostMicros).toBe(200);
    expect(verdict.upperBoundMicros).toBe(1_200);
  });

  it('multiplies by the attempt ceiling so retries cannot hide spend', () => {
    const verdict = computeCallCostUpperBound({ ...BOUNDED, maxNetworkAttempts: 3 }, RATE);
    expect(verdict.bounded).toBe(true);
    if (verdict.bounded) {
      expect(verdict.upperBoundMicros).toBe(3_600);
    }
  });

  it('ceils each term so a fractional rate never under-states the bound', () => {
    const oddRate: ModelRateCard = { ...RATE, inputRatePerMillion: 1, outputRatePerMillion: 1 };
    const verdict = computeCallCostUpperBound(
      { ...BOUNDED, maxInputTokens: 1, maxOutputTokens: 1 },
      oddRate
    );
    expect(verdict.bounded).toBe(true);
    if (verdict.bounded) {
      // 1 token at 1µ per million = 0.000001µ -> must ceil to 1µ, not round to 0.
      expect(verdict.breakdown.inputCostMicros).toBe(1);
      expect(verdict.breakdown.outputCostMicros).toBe(1);
    }
  });

  it('reserves the CEILING, not the caller estimate', () => {
    const manager = makeManager({
      policy: { mode: 'hard', allowUnboundedRiskOverride: false },
      routes: [BOUNDED]
    });
    const result = manager.reserve({
      callId: 'l1',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 10, // wildly optimistic caller
      routeId: 'bounded'
    });
    expect(result.granted).toBe(true);
    expect(result.reservedCostMicros).toBe(1_200);
  });

  it('fails closed when the ceiling exceeds the remaining pool', () => {
    const manager = makeManager({
      general: 1_000,
      policy: { mode: 'hard', allowUnboundedRiskOverride: false },
      routes: [BOUNDED]
    });
    const result = manager.reserve({
      callId: 'l1-poor',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 1,
      routeId: 'bounded'
    });
    expect(result.granted).toBe(false);
    expect(result.rejectionReason).toBe('insufficient_budget');
    // The refusal must not have consumed anything.
    expect(manager.getBudgetStatus().generalPool.reservedMicros).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3B-L2 — an unbounded route is refused in hard mode
// ---------------------------------------------------------------------------
describe('3B-L2 an unbounded route is refused in hard mode', () => {
  it('rejects a route with no max_tokens', () => {
    const verdict = computeCallCostUpperBound({ routeId: 'r', maxInputTokens: 1_000 }, RATE);
    expect(verdict.bounded).toBe(false);
    if (!verdict.bounded) {
      expect(verdict.reasons).toContain('missing-max-output-tokens');
    }
  });

  it('rejects a route whose provider does not enforce max_tokens physically', () => {
    const verdict = computeCallCostUpperBound({ ...BOUNDED, providerEnforcesMaxTokens: false }, RATE);
    expect(verdict.bounded).toBe(false);
    if (!verdict.bounded) {
      expect(verdict.reasons).toContain('provider-does-not-enforce-max-tokens');
    }
  });

  it('rejects a route whose input bound rests on an unverified tokenizer', () => {
    const verdict = computeCallCostUpperBound({ ...BOUNDED, tokenizerVerified: false }, RATE);
    expect(verdict.bounded).toBe(false);
    if (!verdict.bounded) {
      expect(verdict.reasons).toContain('input-tokenizer-unverified');
    }
  });

  it('rejects a route that leaves reasoning or retries unbounded', () => {
    const noReasoning = computeCallCostUpperBound({ ...BOUNDED, maxReasoningTokens: undefined }, RATE);
    expect(noReasoning.bounded).toBe(false);
    if (!noReasoning.bounded) {
      expect(noReasoning.reasons).toContain('reasoning-not-bounded');
    }
    const noRetries = computeCallCostUpperBound({ ...BOUNDED, maxNetworkAttempts: undefined }, RATE);
    expect(noRetries.bounded).toBe(false);
    if (!noRetries.bounded) {
      expect(noRetries.reasons).toContain('retries-not-bounded');
    }
  });

  it('refuses the call end-to-end and records an audit alert', () => {
    const manager = makeManager({
      policy: { mode: 'hard', allowUnboundedRiskOverride: false },
      routes: [{ routeId: 'loose', maxInputTokens: 100 }]
    });
    const result = manager.reserve({
      callId: 'l2',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 5,
      routeId: 'loose'
    });
    expect(result.granted).toBe(false);
    expect(result.rejectionReason).toBe('unbounded_route_rejected');
    expect(manager.getAlertsOfKind('unbounded-route-rejected')).toHaveLength(1);
  });

  it('refuses a call that names no route at all', () => {
    const manager = makeManager({ policy: { mode: 'hard', allowUnboundedRiskOverride: false } });
    const result = manager.reserve({
      callId: 'l2-noroute',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 5
    });
    expect(result.granted).toBe(false);
    expect(result.rejectionReason).toBe('unbounded_route_rejected');
  });

  it('observation mode refuses nothing (the pre-PR-3B behaviour)', () => {
    const manager = makeManager({ policy: { mode: 'observation', allowUnboundedRiskOverride: false } });
    const result = manager.reserve({
      callId: 'l2-obs',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 777
    });
    expect(result.granted).toBe(true);
    expect(result.reservedCostMicros).toBe(777);
  });
});

// ---------------------------------------------------------------------------
// 3B-L3 — explicit risk override
// ---------------------------------------------------------------------------
describe('3B-L3 an explicit override is admitted only with a stop-loss', () => {
  it('refuses an override that has no stop-loss', () => {
    const manager = makeManager({
      policy: { mode: 'hard', allowUnboundedRiskOverride: true },
      routes: [{ routeId: 'loose' }]
    });
    const result = manager.reserve({
      callId: 'l3-nostop',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 5,
      routeId: 'loose'
    });
    expect(result.granted).toBe(false);
    expect(result.rejectionReason).toBe('risk_override_without_stop_loss');
  });

  it('admits with a stop-loss and ring-fences exactly that stop-loss', () => {
    const manager = makeManager({
      policy: { mode: 'hard', allowUnboundedRiskOverride: true, unboundedRiskStopLossMicros: 5_000 },
      routes: [{ routeId: 'loose' }]
    });
    const result = manager.reserve({
      callId: 'l3-ok',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 5,
      routeId: 'loose'
    });
    expect(result.granted).toBe(true);
    expect(result.reservedCostMicros).toBe(5_000);
  });

  it('marks the override as unbounded risk in the audit trail', () => {
    const manager = makeManager({
      policy: { mode: 'hard', allowUnboundedRiskOverride: true, unboundedRiskStopLossMicros: 5_000 },
      routes: [{ routeId: 'loose' }]
    });
    manager.reserve({
      callId: 'l3-audit',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 5,
      routeId: 'loose'
    });
    const alerts = manager.getAlertsOfKind('unbounded-route-granted');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.detail).toContain('5000u');
  });
});

// ---------------------------------------------------------------------------
// 3B-L4 — seat and money dimensions never mix
// ---------------------------------------------------------------------------
describe('3B-L4 exploration seats and currency never share arithmetic', () => {
  it('rejects a non-integer or negative seat count', () => {
    expect(() => seatUnits(1.5)).toThrow(DimensionMismatchError);
    expect(() => seatUnits(-1)).toThrow(DimensionMismatchError);
    expect(() => seatUnits(3)).not.toThrow();
  });

  it('rejects a negative money amount', () => {
    expect(() => currencyMicros(-1)).toThrow(DimensionMismatchError);
    expect(() => currencyMicros(1_000)).not.toThrow();
  });

  it('rejects a report that would merge the two dimensions into one field', () => {
    const merged = {
      seats: { total: 4, occupied: 0, available: 4 },
      currency: {
        generalTotalMicros: 1,
        generalSettledMicros: 0,
        generalRemainingMicros: 1,
        verificationTotalMicros: 1,
        verificationSettledMicros: 0,
        verificationRemainingMicros: 1
      },
      // The forbidden line: "10 explorations + $5".
      total: 5
    };
    expect(() => assertDimensionSeparated(merged as never)).toThrow(DimensionMismatchError);
  });

  it('accepts a properly separated report', () => {
    const ok = {
      seats: { total: 4, occupied: 1, available: 3 },
      currency: {
        generalTotalMicros: 100,
        generalSettledMicros: 10,
        generalRemainingMicros: 90,
        verificationTotalMicros: 50,
        verificationSettledMicros: 0,
        verificationRemainingMicros: 50
      }
    };
    expect(() => assertDimensionSeparated(ok as never)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3B-L5 — rate card time-freeze
// ---------------------------------------------------------------------------
describe('3B-L5 a rate-card update cannot rewrite settled history', () => {
  it('settles at the rate snapshotted at reserve time', () => {
    const manager = makeManager();
    const reserved = manager.reserve({
      callId: 'l5',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 10_000,
      rateCard: RATE
    });
    expect(reserved.granted).toBe(true);

    // The "hot update": a brand-new rate card arrives after the call started.
    const doubled: ModelRateCard = {
      ...RATE,
      inputRatePerMillion: 2_000_000,
      outputRatePerMillion: 4_000_000
    };
    manager.registerRouteBound(BOUNDED);
    const settled = manager.settle({
      callId: 'l5',
      reservationId: reserved.reservationId!,
      outcome: 'succeeded',
      usage: {
        inputTokens: { tokens: 1_000, precision: 'measured' },
        outputTokens: { tokens: 100, precision: 'measured' },
        countingSemantics: { inputIncludesCacheRead: true, outputIncludesReasoning: true }
      },
      // Deliberately pass the NEW card: the frozen snapshot must win.
      rateCard: doubled
    });

    // At the ORIGINAL rate: 1000×1µ + 100×2µ = 1,200µ (not 2,400µ).
    expect(settled.incurredCostMicros).toBe(1_200);
  });

  it('produces a stable digest for the same card and different digests for different cards', () => {
    expect(rateCardDigest(RATE)).toBe(rateCardDigest({ ...RATE }));
    expect(rateCardDigest(RATE)).not.toBe(rateCardDigest({ ...RATE, inputRatePerMillion: 2_000_000 }));
  });
});

// ---------------------------------------------------------------------------
// Watermarks / freeze (ADR §7.4)
// ---------------------------------------------------------------------------
describe('ADR-0004 §7.4 tiered watermarks and hard freeze', () => {
  it('maps ratios to tiers, treating an overdraft as frozen', () => {
    expect(computeWatermarkTier({ totalMicros: 100, committedMicros: 10 })).toBe('normal');
    expect(computeWatermarkTier({ totalMicros: 100, committedMicros: 80 })).toBe('warning');
    expect(computeWatermarkTier({ totalMicros: 100, committedMicros: 95 })).toBe('critical');
    expect(computeWatermarkTier({ totalMicros: 100, committedMicros: 100 })).toBe('frozen');
    // Ratio arithmetic on a negative remainder would report "under budget" at the
    // worst possible moment, so an overdraft short-circuits to frozen.
    expect(computeWatermarkTier({ totalMicros: 100, committedMicros: 50, overdraftMicros: 1 })).toBe('frozen');
    expect(computeWatermarkTier({ totalMicros: 0, committedMicros: 0 })).toBe('frozen');
  });

  it('uses 80/95 defaults and halves the seat cap at critical', () => {
    expect(DEFAULT_WATERMARKS.warningRatio).toBe(0.8);
    expect(DEFAULT_WATERMARKS.criticalRatio).toBe(0.95);
    expect(criticalTierSeatCap(4)).toBe(2);
    expect(criticalTierSeatCap(1)).toBe(1); // never zero: a live system needs a slot
  });

  it('walks warning -> critical -> frozen as the general pool drains', () => {
    const manager = makeManager({ general: 100_000, seats: 4 });
    expect(manager.getGeneralTier()).toBe('normal');

    let r = manager.reserve({ callId: 'w1', phase: 'probe', pool: 'general', estimatedCostMicros: 82_000, requiresSeat: true });
    manager.settle({ callId: 'w1', reservationId: r.reservationId!, outcome: 'succeeded', actualCostMicros: 82_000 });
    expect(manager.getGeneralTier()).toBe('warning');
    expect(manager.getAlertsOfKind('watermark-warning').length).toBeGreaterThanOrEqual(1);

    r = manager.reserve({ callId: 'w2', phase: 'probe', pool: 'general', estimatedCostMicros: 14_000 });
    manager.settle({ callId: 'w2', reservationId: r.reservationId!, outcome: 'succeeded', actualCostMicros: 14_000 });
    expect(manager.getGeneralTier()).toBe('critical');
    expect(manager.getEffectiveSeatCap()).toBe(2);

    r = manager.reserve({ callId: 'w3', phase: 'probe', pool: 'general', estimatedCostMicros: 4_000 });
    manager.settle({ callId: 'w3', reservationId: r.reservationId!, outcome: 'succeeded', actualCostMicros: 4_000 });
    expect(manager.getGeneralTier()).toBe('frozen');
    expect(manager.getAlertsOfKind('pool-frozen').length).toBeGreaterThanOrEqual(1);

    const blocked = manager.reserve({ callId: 'w4', phase: 'probe', pool: 'general', estimatedCostMicros: 1 });
    expect(blocked.granted).toBe(false);
  });

  it('keeps the verification pool usable when the general pool is frozen', () => {
    const manager = makeManager({ general: 1_000, verification: 50_000 });
    const drain = manager.reserve({ callId: 'drain', phase: 'probe', pool: 'general', estimatedCostMicros: 1_000 });
    manager.settle({ callId: 'drain', reservationId: drain.reservationId!, outcome: 'succeeded', actualCostMicros: 1_000 });
    expect(manager.getGeneralTier()).toBe('frozen');

    // The judge must still be able to rule on the run that just exhausted the budget.
    const judge = manager.reserve({ callId: 'judge', phase: 'judge', pool: 'verification', estimatedCostMicros: 5_000 });
    expect(judge.granted).toBe(true);
  });

  it('does not throttle the verification pool at a general critical watermark', () => {
    const status = poolLimitStatus({
      totalMicros: 100,
      reservedMicros: 0,
      settledMicros: 96,
      overdraftMicros: 0
    });
    expect(status.tier).toBe('critical');
    expect(status.admissionOpen).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge cases the task names explicitly
// ---------------------------------------------------------------------------
describe('PR-3B edge cases: over-reserve, unknown cost, no truncation', () => {
  it('keeps an incurred cost that EXCEEDS the reservation (never truncates)', () => {
    const manager = makeManager({ general: 1_000_000 });
    const reserved = manager.reserve({
      callId: 'over',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 100
    });
    // Actual spend is 50x the reservation.
    const settled = manager.settle({
      callId: 'over',
      reservationId: reserved.reservationId!,
      outcome: 'succeeded',
      usage: {
        inputTokens: { tokens: 50_000, precision: 'measured' },
        outputTokens: { tokens: 0, precision: 'measured' },
        countingSemantics: { inputIncludesCacheRead: true, outputIncludesReasoning: true }
      },
      rateCard: RATE
    });
    expect(settled.incurredCostMicros).toBe(50_000);
    // Truncating to the reservation would have hidden 49,900µ of real spend.
    expect(settled.incurredCostMicros).toBeGreaterThan(reserved.reservedCostMicros);
    // Refund is zero, never negative.
    expect(settled.amountRefundedMicros).toBe(0);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(50_000);
  });

  it('never settles an unknown cost as zero', () => {
    const manager = makeManager();
    const reserved = manager.reserve({
      callId: 'unknown',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 50_000
    });
    const settled = manager.settle({
      callId: 'unknown',
      reservationId: reserved.reservationId!,
      outcome: 'succeeded'
      // no usage, no actualCostMicros, no rate card override
    });
    expect(settled.incurredCostMicros).toBeGreaterThan(0);
    expect(settled.ledgerEvent?.cost.provenance).toBe('unknown');
    expect(settled.ledgerEvent?.cost.conservative).toBe(true);
    // Conservative spend is NOT quality evidence.
    expect(settled.qualityEvidence).toBe(false);
  });

  it('treats a cancellation with no remote response as a retained seat, not a leak', () => {
    const manager = makeManager({ seats: 2 });
    const reserved = manager.reserve({
      callId: 'no-response',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 1_000,
      requiresSeat: true
    });
    const settled = manager.settle({
      callId: 'no-response',
      reservationId: reserved.reservationId!,
      outcome: 'aborted_local',
      actualCostMicros: 300,
      releaseSeat: true
    });

    // The seat is HELD: local abandonment is not proof the provider stopped.
    expect(settled.seatReleased).toBe(false);
    expect(settled.seatRetainedPendingRemote).toBe(true);
    expect(manager.getBudgetStatus().seats.occupied).toBe(1);
    expect(manager.isSeatRetainedPendingRemote('no-response')).toBe(true);
    // The spend is still booked.
    expect(settled.incurredCostMicros).toBeGreaterThan(0);

    // ...and it is RECOVERABLE once termination is confirmed (the t7 repair:
    // without this handle the seat was permanently lost and the pool deadlocked).
    expect(manager.releaseSeat('no-response')).toBe(true);
    expect(manager.getBudgetStatus().seats.occupied).toBe(0);
  });

  it('releases a retained seat when late usage proves the remote call ended', () => {
    const manager = makeManager({ seats: 1 });
    const reserved = manager.reserve({
      callId: 'late-seat',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 1_000,
      requiresSeat: true
    });
    manager.settle({
      callId: 'late-seat',
      reservationId: reserved.reservationId!,
      outcome: 'timed_out_local',
      actualCostMicros: 0,
      releaseSeat: true
    });
    expect(manager.getBudgetStatus().seats.occupied).toBe(1);

    const reconciled = manager.reconcileLateUsage({ callId: 'late-seat', actualCostMicros: 2_000, rateCard: RATE });
    expect(reconciled.seatReleased).toBe(true);
    expect(manager.getBudgetStatus().seats.occupied).toBe(0);
    expect(manager.isSeatRetainedPendingRemote('late-seat')).toBe(false);
  });

  it('does not double-charge on duplicate settle (idempotent replay)', () => {
    const manager = makeManager();
    const reserved = manager.reserve({
      callId: 'dup',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 10_000
    });
    const first = manager.settle({
      callId: 'dup',
      reservationId: reserved.reservationId!,
      outcome: 'succeeded',
      usage: {
        inputTokens: { tokens: 1_000, precision: 'measured' },
        outputTokens: { tokens: 0, precision: 'measured' },
        countingSemantics: { inputIncludesCacheRead: true, outputIncludesReasoning: true }
      },
      rateCard: RATE
    });
    const second = manager.settle({
      callId: 'dup',
      reservationId: reserved.reservationId!,
      outcome: 'succeeded',
      usage: {
        inputTokens: { tokens: 1_000, precision: 'measured' },
        outputTokens: { tokens: 0, precision: 'measured' },
        countingSemantics: { inputIncludesCacheRead: true, outputIncludesReasoning: true }
      },
      rateCard: RATE
    });
    expect(second.isIdempotentReplay).toBe(true);
    expect(second.incurredCostMicros).toBe(first.incurredCostMicros);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(first.incurredCostMicros);
  });

  it('rejects re-reserving a settled call instead of leaking budget or a seat', () => {
    const manager = makeManager();
    const reserved = manager.reserve({
      callId: 're-reserve',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 1_000,
      requiresSeat: true
    });
    manager.settle({ callId: 're-reserve', reservationId: reserved.reservationId!, outcome: 'succeeded', actualCostMicros: 500 });
    const again = manager.reserve({
      callId: 're-reserve',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 1_000,
      requiresSeat: true
    });
    expect(again.granted).toBe(false);
    expect(again.rejectionReason).toBe('call_already_settled');
    expect(manager.getBudgetStatus().seats.occupied).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §8.3 external reconciliation
// ---------------------------------------------------------------------------
describe('ADR-0004 §8.3 external bill reconciliation', () => {
  it('classifies exact, within-tolerance, disputed and unresolved lines', () => {
    const report = reconcileWithExternalBill({
      internal: [
        { callId: 'exact', incurredCostMicros: 1_000 },
        { callId: 'close', incurredCostMicros: 2_000 },
        { callId: 'far', incurredCostMicros: 3_000 },
        { callId: 'missing', incurredCostMicros: 4_000 }
      ],
      external: [
        { callId: 'exact', chargedMicros: 1_000 },
        { callId: 'close', chargedMicros: 2_100 }, // +100, inside the 500µ tolerance
        { callId: 'far', chargedMicros: 9_000 } // +6000, disputed
      ]
    });

    expect(report.exact).toBe(1);
    expect(report.withinTolerance).toBe(1);
    expect(report.disputed).toBe(1);
    expect(report.unresolved).toBe(1);
    expect(report.missingFromBill).toEqual(['missing']);
    expect(report.allSettled).toBe(false);
    // Net difference covers MATCHED lines only.
    expect(report.netDifferenceMicros).toBe(100 + 6_000);

    const missingVerdict = report.verdicts.find((v) => v.callId === 'missing')!;
    // Absence of a bill line must never be read as "zero spend".
    expect(missingVerdict.state).toBe('unresolved');
    expect(missingVerdict.externalMicros).toBeUndefined();
  });

  it('surfaces bill lines with no internal call instead of dropping them', () => {
    const report = reconcileWithExternalBill({
      internal: [{ callId: 'a', incurredCostMicros: 100 }],
      external: [
        { callId: 'a', chargedMicros: 100 },
        { callId: 'ghost', chargedMicros: 999 }
      ]
    });
    expect(report.unknownToLedger).toHaveLength(1);
    expect(report.unknownToLedger[0]!.callId).toBe('ghost');
    expect(report.allSettled).toBe(false);
  });

  it('uses a 500µ default tolerance and allows an explicit override', () => {
    expect(DEFAULT_RECONCILIATION_TOLERANCE_MICROS).toBe(500);
    const loose = reconcileWithExternalBill({
      internal: [{ callId: 'a', incurredCostMicros: 1_000 }],
      external: [{ callId: 'a', chargedMicros: 3_000 }],
      toleranceMicros: 5_000
    });
    expect(loose.withinTolerance).toBe(1);
    expect(loose.disputed).toBe(0);
  });

  it('proposes an adjustment for a disputed line but never mutates the ledger figure', () => {
    const report = reconcileWithExternalBill({
      internal: [{ callId: 'a', incurredCostMicros: 1_000 }],
      external: [{ callId: 'a', chargedMicros: 4_000 }]
    });
    const verdict = report.verdicts[0]!;
    expect(verdict.internalMicros).toBe(1_000); // untouched
    const proposal = proposeAdjustment(verdict);
    expect(proposal?.deltaMicros).toBe(3_000);
  });

  it('resolves a disputed line through an explicit manual ruling', () => {
    const report = reconcileWithExternalBill({
      internal: [{ callId: 'a', incurredCostMicros: 1_000 }],
      external: [{ callId: 'a', chargedMicros: 4_000 }]
    });
    const resolved = applyManualResolution(report.verdicts[0]!, {
      callId: 'a',
      decision: 'accept-external',
      note: 'provider bill verified against the invoice PDF',
      resolvedAt: 1
    });
    expect(resolved.state).toBe('manual_resolved');
    expect(resolved.differenceMicros).toBe(3_000);
    expect(resolved.reason).toContain('accept-external');
  });

  it('refuses a manual resolution on a line that is not disputed', () => {
    const report = reconcileWithExternalBill({
      internal: [{ callId: 'a', incurredCostMicros: 1_000 }],
      external: [{ callId: 'a', chargedMicros: 1_000 }]
    });
    expect(() =>
      applyManualResolution(report.verdicts[0]!, {
        callId: 'a',
        decision: 'accept-internal',
        note: 'n/a',
        resolvedAt: 1
      })
    ).toThrow(/only a disputed line/);
  });

  it('reports a fully settled bill when everything matches', () => {
    const report = reconcileWithExternalBill({
      internal: [
        { callId: 'a', incurredCostMicros: 100 },
        { callId: 'b', incurredCostMicros: 200 }
      ],
      external: [
        { callId: 'a', chargedMicros: 100 },
        { callId: 'b', chargedMicros: 200 }
      ]
    });
    expect(report.allSettled).toBe(true);
    expect(report.netDifferenceMicros).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Default-safe degradation (ADR §9.2)
// ---------------------------------------------------------------------------
describe('ADR-0004 §9.2 the PR-3B machinery is inert unless configured', () => {
  it('a manager with no admission policy keeps the pre-PR-3B behaviour', () => {
    const manager = makeManager();
    // No route, no policy: the old estimate-based reservation still applies.
    const result = manager.reserve({
      callId: 'legacy',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 12_345
    });
    expect(result.granted).toBe(true);
    expect(result.reservedCostMicros).toBe(12_345);
    expect(manager.getAlerts()).toHaveLength(0);
  });

  it('exposes the admission decision without reserving anything', () => {
    const manager = makeManager({
      policy: { mode: 'hard', allowUnboundedRiskOverride: false },
      routes: [BOUNDED]
    });
    const decision = manager.decideAdmissionFor({ routeId: 'bounded', estimatedCostMicros: 1 });
    expect(decision.admitted).toBe(true);
    // Nothing was reserved by asking.
    expect(manager.getBudgetStatus().generalPool.reservedMicros).toBe(0);
  });
});
