/**
 * R2-3 (audit round 2, observed while reproducing LEDGER-1): `bookNewAttempt`
 * ring-fenced `origin?.reservedCostMicros ?? 0`, so with no rate card reachable
 * the reservation held 0 and the settle fell to the reserved-upper-bound branch
 * — real usage booked as 0, unbounded and invisible.
 *
 * WHAT THIS PINS (the fix contract):
 *
 *   - with NO reachable rate card, a marked new attempt books the SAME
 *     conservative floor settle() uses (`CONSERVATIVE_FALLBACK_FLOOR_MICROS`),
 *     with provenance 'unknown' and conservative=true — never a silent 0
 *     (ADR-0003 §7.3.5);
 *   - when a card IS reachable nothing changes: the card prices the usage as
 *     before (the floor is a floor, not a cap — the origin's own estimate wins
 *     when it is larger);
 *   - the same floor applies on `settle()` when usage arrives and neither a
 *     frozen nor a request card exists, while a usage-LESS settle keeps its
 *     documented reserved-upper-bound semantics;
 *   - the conservation law and the usage report agree with what was booked.
 */
import { describe, expect, it } from 'vitest';
import {
  calculateUsageCost,
  CONSERVATIVE_FALLBACK_FLOOR_MICROS,
  createLedgerReservationManager,
  createUsagePayload,
  twoPhaseSettlementFor,
  type LedgerReservationManager,
  type ModelRateCard,
  type ProviderUsagePayload
} from '../../../src/ledger';

const RATE_CARD: ModelRateCard = {
  modelId: 'r2-3/new-attempt-model',
  inputRatePerMillion: 1_000_000,
  outputRatePerMillion: 2_000_000,
  reasoningSeparatelyBilled: false,
  conservativeFallbackCostMicros: 500
};

const SEMANTICS = { inputIncludesCacheRead: true, outputIncludesReasoning: true } as const;

const LATE_USAGE: ProviderUsagePayload = createUsagePayload({
  input: 2_000,
  output: 500,
  cacheRead: 100,
  semantics: SEMANTICS
});

function makeManager(options: { defaultRateCard?: ModelRateCard } = {}): LedgerReservationManager {
  return createLedgerReservationManager({
    enabled: true,
    enforceHardBounds: true,
    generalBudgetMicros: 10_000_000,
    verificationReserveMicros: 1_000_000,
    maxConcurrencySeats: 4,
    ...(options.defaultRateCard === undefined ? {} : { defaultRateCard: options.defaultRateCard })
  });
}

describe('R2-3: no reachable rate card books the conservative floor, never 0', () => {
  it('a marked new attempt with no card books the floor with unknown provenance', () => {
    const manager = makeManager();
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'test' });
    const booked = settlement.bookNewAttempt({
      originCallId: 'origin-without-card',
      usage: LATE_USAGE,
      newAttemptMarker: 'new-attempt',
      newAttemptReason: 'the origin mapping was lost and no card is configured'
    });

    // The audited 0 is gone: the floor is booked, and it is labelled unknown.
    expect(booked.incurredCostMicros).toBe(CONSERVATIVE_FALLBACK_FLOOR_MICROS);
    expect(booked.incurredCostMicros).toBeGreaterThan(0);
    expect(booked.ledgerEvent?.cost.provenance).toBe('unknown');
    expect(booked.ledgerEvent?.cost.conservative).toBe(true);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(CONSERVATIVE_FALLBACK_FLOOR_MICROS);
    expect(manager.getBudgetStatus().generalPool.reservedMicros).toBe(0);
    expect(manager.verifyConservationLaw().balanced).toBe(true);
    // The report books the same figure the pool did.
    expect(manager.getUsageAccounting().totalCostMicros).toBe(CONSERVATIVE_FALLBACK_FLOOR_MICROS);
    expect(manager.getUsageAccounting().unknown.calls).toBe(1);
  });

  it('a reachable card still prices the usage exactly as before', () => {
    const manager = makeManager({ defaultRateCard: RATE_CARD });
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'test' });
    const booked = settlement.bookNewAttempt({
      originCallId: 'origin-with-card',
      usage: LATE_USAGE,
      newAttemptMarker: 'new-attempt',
      newAttemptReason: 'cross-process restart'
    });
    const priced = calculateUsageCost(LATE_USAGE, RATE_CARD).totalCostMicros;
    // A measured price is NOT inflated to the floor: 3,000u of measured usage
    // stays 3,000u even though the no-card floor is 10,000u.
    expect(booked.incurredCostMicros).toBe(priced);
    expect(booked.incurredCostMicros).toBeLessThan(CONSERVATIVE_FALLBACK_FLOOR_MICROS);
    expect(booked.ledgerEvent?.cost.provenance).toBe('measured');
    expect(booked.ledgerEvent?.cost.conservative).toBe(false);
  });

  it('a reachable origin’s frozen card keeps pricing the late usage (the floor is not a cap)', () => {
    const manager = makeManager();
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'test' });
    settlement.beginCall({
      callId: 'origin-with-frozen-card',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 25_000,
      requiresSeat: false,
      rateCard: RATE_CARD
    });

    const booked = settlement.bookNewAttempt({
      originCallId: 'origin-with-frozen-card',
      usage: LATE_USAGE,
      newAttemptMarker: 'new-attempt',
      newAttemptReason: 'the origin must be re-booked under a fresh callId'
    });
    // The card froze at reserve time (ADR-0004 §8.1) and still wins.
    expect(booked.incurredCostMicros).toBe(calculateUsageCost(LATE_USAGE, RATE_CARD).totalCostMicros);
    expect(booked.ledgerEvent?.cost.provenance).toBe('measured');
  });

  it('settle() with usage and no reachable card lands on the floor, not 0', () => {
    const manager = makeManager();
    const reserved = manager.reserve({
      callId: 'call-usage-no-card',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 0,
      requiresSeat: false
    });
    expect(reserved.granted).toBe(true);
    expect(reserved.reservedCostMicros).toBe(0);
    const settled = manager.settle({
      callId: 'call-usage-no-card',
      reservationId: reserved.reservationId as string,
      outcome: 'succeeded',
      usage: LATE_USAGE
    });
    expect(settled.incurredCostMicros).toBe(CONSERVATIVE_FALLBACK_FLOOR_MICROS);
    expect(settled.ledgerEvent?.cost.provenance).toBe('unknown');
    expect(settled.ledgerEvent?.cost.conservative).toBe(true);
    expect(settled.ledgerEvent?.cost.auditNote).toContain('conservative fallback floor');
  });

  it('settle() with NO usage keeps its documented reserved-upper-bound semantics', () => {
    const manager = makeManager();
    const reserved = manager.reserve({
      callId: 'call-no-usage-no-card',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 4_000,
      requiresSeat: false
    });
    const settled = manager.settle({
      callId: 'call-no-usage-no-card',
      reservationId: reserved.reservationId as string,
      outcome: 'failed'
    });
    // No usage supplied: the reserved bound IS the evidence available, so the
    // floor must not inflate it (this is the pre-existing contract).
    expect(settled.incurredCostMicros).toBe(4_000);
    expect(settled.ledgerEvent?.cost.auditNote).toContain('reserved upper bound');
  });
});
