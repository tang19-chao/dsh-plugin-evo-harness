/**
 * LEDGER-8 (audit rounds 1+2): the ledger used to mutate pools, seats, the
 * reservation records and the idempotency cache BEFORE appending to the WAL —
 * inverting the write-ahead discipline (ADR-0004 §6.1: the log record gates the
 * state change). An append failure (ENOSPC/EIO) left unlogged money movement,
 * and a retry hit the idempotency cache and returned `isIdempotentReplay=true`
 * WITHOUT ever re-appending: the settlement was permanently absent from the WAL
 * and a restart reverted it into a dangling reservation.
 *
 * WHAT THIS PINS (the fix contract, per the audited append-failure repro):
 *   - with an injected append failure, reserve/settle/reconcile throw BEFORE any
 *     in-memory state moves: no unlogged money, no orphaned reservation, no
 *     prematurely released seat or buffer;
 *   - the retry re-computes the same operation and re-appends: the WAL receives
 *     exactly ONE event of each kind and the pools book exactly once;
 *   - the conservation law holds across the failure and the retry.
 *
 * The WAL is real (an in-memory `LedgerWalWriter` subclass); only the append
 * failure itself is injected.
 */
import { describe, expect, it } from 'vitest';
import {
  calculateUsageCost,
  createUsagePayload,
  LedgerReservationManager,
  LedgerWalWriter,
  type LedgerWalEvent,
  type LedgerWalEventType,
  type ModelRateCard,
  type ProviderUsagePayload
} from '../../../src/ledger';

const RATE_CARD: ModelRateCard = {
  modelId: 'ledger-8/append-first-model',
  inputRatePerMillion: 1_000_000,
  outputRatePerMillion: 2_000_000,
  reasoningSeparatelyBilled: false,
  conservativeFallbackCostMicros: 500
};

const SEMANTICS = { inputIncludesCacheRead: true, outputIncludesReasoning: true } as const;

const USAGE: ProviderUsagePayload = createUsagePayload({
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

const ESTIMATE = 10_000;

/**
 * A real in-memory WAL writer whose append throws ONCE for each configured event
 * type (the audited ENOSPC/EIO shape), then behaves normally.
 */
class InjectedFailureWalWriter extends LedgerWalWriter {
  private readonly failedTypes = new Set<string>();

  constructor(private readonly failOnceFor: readonly LedgerWalEventType[]) {
    super();
  }

  override append(type: LedgerWalEventType, payload: unknown, timestamp?: number): LedgerWalEvent {
    if (this.failOnceFor.includes(type) && !this.failedTypes.has(type)) {
      this.failedTypes.add(type);
      throw new Error('injected EIO: the ' + type + ' append failed');
    }
    return super.append(type, payload, timestamp);
  }
}

function makeManager(walWriter: LedgerWalWriter, seats = 2): LedgerReservationManager {
  return new LedgerReservationManager({
    generalBudgetMicros: 1_000_000,
    verificationReserveMicros: 100_000,
    maxConcurrencySeats: seats,
    defaultRateCard: RATE_CARD,
    walWriter
  });
}

function eventTypes(writer: LedgerWalWriter): readonly string[] {
  return writer.readAllEvents().map((event) => event.type);
}

describe('LEDGER-8: a failed WAL append leaves no unlogged money movement', () => {
  it('reserve: the failed append leaks no live reservation and a retry appends exactly once', () => {
    const writer = new InjectedFailureWalWriter(['EVENT_RESERVED']);
    const manager = makeManager(writer);
    const request = {
      callId: 'c-reserve',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: ESTIMATE,
      requiresSeat: true
    } as const;

    expect(() => manager.reserve(request)).toThrowError(/injected EIO/);
    // Nothing moved: no ring-fenced money, no seat, no live reservation record.
    expect(manager.getBudgetStatus().generalPool.reservedMicros).toBe(0);
    expect(manager.occupiedSeatCount).toBe(0);
    expect(manager.getReservationByCallId('c-reserve')).toBeUndefined();
    expect(eventTypes(writer)).not.toContain('EVENT_RESERVED');

    // The retry simply reserves again — the WAL receives exactly one event.
    const reserved = manager.reserve(request);
    expect(reserved.granted).toBe(true);
    expect(eventTypes(writer).filter((type) => type === 'EVENT_RESERVED')).toHaveLength(1);
    expect(manager.getBudgetStatus().generalPool.reservedMicros).toBe(ESTIMATE);
    expect(manager.occupiedSeatCount).toBe(1);
    expect(manager.verifyConservationLaw().balanced).toBe(true);
  });

  it('settle: the failed append books nothing and a retry settles exactly once', () => {
    const writer = new InjectedFailureWalWriter(['EVENT_SETTLED']);
    const manager = makeManager(writer);
    const reserved = manager.reserve({
      callId: 'c-settle',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: ESTIMATE,
      requiresSeat: false
    });
    const settleRequest = {
      callId: 'c-settle',
      reservationId: reserved.reservationId as string,
      outcome: 'succeeded',
      usage: USAGE
    } as const;

    expect(() => manager.settle(settleRequest)).toThrowError(/injected EIO/);
    // Nothing moved: the reservation is still active and holding its money, and
    // the idempotency cache is EMPTY (a retry re-attempts the append instead of
    // returning a phantom `isIdempotentReplay=true`).
    expect(manager.getBudgetStatus().generalPool.reservedMicros).toBe(ESTIMATE);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(0);
    expect(manager.getReservationByCallId('c-settle')?.state).toBe('active');
    expect(manager.getSettledResult('c-settle')).toBeUndefined();
    expect(eventTypes(writer)).not.toContain('EVENT_SETTLED');

    const settled = manager.settle(settleRequest);
    expect(settled.isIdempotentReplay).toBe(false);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(
      calculateUsageCost(USAGE, RATE_CARD).totalCostMicros
    );
    expect(manager.getBudgetStatus().generalPool.reservedMicros).toBe(0);
    expect(eventTypes(writer).filter((type) => type === 'EVENT_SETTLED')).toHaveLength(1);
    expect(manager.verifyConservationLaw().balanced).toBe(true);
  });

  it('reconcile: the failed append releases no buffer and a retry reconciles exactly once', () => {
    const writer = new InjectedFailureWalWriter(['EVENT_RECONCILED']);
    const manager = makeManager(writer);
    const reserved = manager.reserve({
      callId: 'c-reconcile',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: ESTIMATE,
      requiresSeat: false
    });
    manager.settle({
      callId: 'c-reconcile',
      reservationId: reserved.reservationId as string,
      outcome: 'cancelled',
      interim: true
    });

    const reconcileRequest = { callId: 'c-reconcile', usage: LATE_USAGE } as const;
    expect(() => manager.reconcileLateUsage(reconcileRequest)).toThrowError(/injected EIO/);
    // The interim hold is untouched: the buffer was NOT released and nothing
    // was booked against it.
    expect(manager.getBudgetStatus().generalPool.reservedMicros).toBe(ESTIMATE);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(0);
    expect(manager.getReservationByCallId('c-reconcile')?.state).toBe('interim_settled');
    expect(manager.getSettledResult('c-reconcile')?.state).toBe('interim_settled');
    expect(eventTypes(writer)).not.toContain('EVENT_RECONCILED');

    const reconciled = manager.reconcileLateUsage(reconcileRequest);
    expect(reconciled.incurredCostMicros).toBe(calculateUsageCost(LATE_USAGE, RATE_CARD).totalCostMicros);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(reconciled.incurredCostMicros);
    expect(manager.getBudgetStatus().generalPool.reservedMicros).toBe(0);
    expect(eventTypes(writer).filter((type) => type === 'EVENT_RECONCILED')).toHaveLength(1);
    expect(manager.verifyConservationLaw().balanced).toBe(true);
  });

  it('seat release on reconcile: the failed append leaks no seat and a retry releases it exactly once', () => {
    const writer = new InjectedFailureWalWriter(['EVENT_SEAT_RELEASED']);
    const manager = makeManager(writer);
    const reserved = manager.reserve({
      callId: 'c-seat',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: ESTIMATE,
      requiresSeat: true
    });
    manager.settle({
      callId: 'c-seat',
      reservationId: reserved.reservationId as string,
      outcome: 'cancelled',
      interim: true
    });
    // The §5.1 hold: the seat is retained because the remote termination is
    // unconfirmed, and late usage is what proves it.
    expect(manager.isSeatRetainedPendingRemote('c-seat')).toBe(true);
    expect(manager.occupiedSeatCount).toBe(1);

    expect(() => manager.reconcileLateUsage({ callId: 'c-seat', usage: LATE_USAGE })).toThrowError(/injected EIO/);
    // The seat is STILL held: the release never happened, so a competing call
    // cannot take a slot that the provider may still occupy.
    expect(manager.isSeatRetainedPendingRemote('c-seat')).toBe(true);
    expect(manager.occupiedSeatCount).toBe(1);
    expect(manager.getBudgetStatus().generalPool.reservedMicros).toBe(ESTIMATE);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(0);
    expect(eventTypes(writer)).not.toContain('EVENT_SEAT_RELEASED');

    manager.reconcileLateUsage({ callId: 'c-seat', usage: LATE_USAGE });
    expect(manager.occupiedSeatCount).toBe(0);
    expect(manager.isSeatRetainedPendingRemote('c-seat')).toBe(false);
    expect(eventTypes(writer).filter((type) => type === 'EVENT_SEAT_RELEASED')).toHaveLength(1);
    expect(eventTypes(writer).filter((type) => type === 'EVENT_RECONCILED')).toHaveLength(1);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(
      calculateUsageCost(LATE_USAGE, RATE_CARD).totalCostMicros
    );
    expect(manager.verifyConservationLaw().balanced).toBe(true);
  });
});
