/**
 * P0-3 (audit LEDGER-1, repro'd in both audit rounds): `bookNewAttempt` had no
 * redelivery idempotency — the attempt callId was minted from
 * `newAttempts().length + 1`, so every redelivery of the same at-least-once
 * late-usage event opened ANOTHER call whose reserve/settle dedupe (keyed per
 * callId) could not fire, and the same spend was booked twice.
 *
 * WHAT THIS PINS (the fix contract):
 *
 *   - the attempt callId is derived DETERMINISTICALLY from the event (origin,
 *     reason, providerCallId, receivedAt), so the same event derives the same
 *     callId on every delivery and different events derive different ones;
 *   - a redelivery of an already-settled event returns the EXISTING settlement —
 *     `previouslyReconciled` on this surface, the analogue of `idempotentReplay`
 *     on settleCall's `TwoPhaseSettleOutcome` (the same contract as the pinned
 *     reconcileLateUsage re-delivery) — and books nothing a second time;
 *   - the idempotency holds across a restart + `recoverFromWal()` too, because
 *     the settledCalls cache is refilled from the replayed WAL events.
 *
 * Everything runs on the REAL factory and settlement (no mocks); only
 * callId/usage values are constructed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  calculateUsageCost,
  createLedgerReservationManager,
  createUsagePayload,
  twoPhaseSettlementFor,
  type LateUsageEvent,
  type LedgerReservationManager,
  type ModelRateCard,
  type ProviderUsagePayload
} from '../../../src/ledger';

const RATE_CARD: ModelRateCard = {
  modelId: 'p0-3/new-attempt-model',
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

/** Observation time carried by the late-usage event (part of the derived callId). */
const RECEIVED_AT = 1_772_000_000_000;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0).reverse()) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'p0-3-new-attempt-'));
  tempDirs.push(dir);
  return dir;
}

function makeManager(storageDir?: string): LedgerReservationManager {
  return createLedgerReservationManager({
    enabled: true,
    enforceHardBounds: true,
    generalBudgetMicros: 10_000_000,
    verificationReserveMicros: 1_000_000,
    maxConcurrencySeats: 4,
    defaultRateCard: RATE_CARD,
    ...(storageDir === undefined ? {} : { storageDir })
  });
}

/** A marked new-attempt event; every override mints a genuinely DIFFERENT event. */
function markedEvent(overrides: {
  readonly reason?: string;
  readonly providerCallId?: string;
  readonly receivedAt?: number;
}): LateUsageEvent {
  return {
    originCallId: 'call-unreachable',
    ...(overrides.providerCallId === undefined ? {} : { providerCallId: overrides.providerCallId }),
    ...(overrides.receivedAt === undefined ? {} : { receivedAt: overrides.receivedAt }),
    usage: LATE_USAGE,
    newAttemptMarker: 'new-attempt',
    newAttemptReason: overrides.reason ?? 'cross-process restart; the original mapping was not persisted'
  };
}

describe('P0-3: bookNewAttempt redelivery idempotency (audit LEDGER-1)', () => {
  it('the same event delivered twice books ONE entry and the amount is not doubled', () => {
    const manager = makeManager();
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'test' });
    const event = markedEvent({});

    const first = settlement.bookNewAttempt(event);
    const second = settlement.bookNewAttempt(event);

    expect(first.previouslyReconciled).toBe(false);
    expect(second.callId).toBe(first.callId);
    expect(second.previouslyReconciled).toBe(true);
    expect(second.incurredCostMicros).toBe(first.incurredCostMicros);
    // Exactly one booking: one reserve, one settle, one marked identity, and the
    // pool holds the single usage cost — never 2x.
    expect(manager.getMeteringStatus().reserveAttempts).toBe(1);
    expect(manager.getMeteringStatus().settleCount).toBe(1);
    expect(settlement.index.newAttempts()).toHaveLength(1);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(
      calculateUsageCost(LATE_USAGE, RATE_CARD).totalCostMicros
    );
    expect(manager.verifyConservationLaw().balanced).toBe(true);
  });

  it('a redelivery after settlement returns the EXISTING settlement (the replay flag of this surface)', () => {
    const manager = makeManager();
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'test' });
    const event = markedEvent({ providerCallId: 'resp_late_1' });

    const first = settlement.bookNewAttempt(event);
    const booked = manager.getBudgetStatus().generalPool.settledMicros;
    const second = settlement.bookNewAttempt(event);

    // `previouslyReconciled` is the late-usage analogue of `idempotentReplay`:
    // the returned settlement is the one already recorded in the settledCalls
    // cache, not a fresh booking.
    expect(second.previouslyReconciled).toBe(true);
    expect(second.mode).toBe('new-attempt');
    expect(second.callId).toBe(first.callId);
    expect(second.reservationId).toBe(first.reservationId);
    expect(second.incurredCostMicros).toBe(first.incurredCostMicros);
    expect(second.originCallId).toBe('call-unreachable');
    expect(second.newAttemptMarker).toBe('new-attempt');
    expect(second.newAttemptReason).toBe(first.newAttemptReason);
    expect(second.ledgerEvent?.auditOnly).toBe(true);
    expect(second.ledgerEvent?.qualityEvidence).toBe(false);
    // The cache still holds that one settlement and no money moved again.
    expect(manager.getSettledResult(first.callId)?.incurredCostMicros).toBe(first.incurredCostMicros);
    expect(manager.getMeteringStatus().settleCount).toBe(1);
    expect(manager.getMeteringStatus().reserveAttempts).toBe(1);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(booked);
  });

  it('genuinely different events still derive distinct callIds and each books its own entry', () => {
    const manager = makeManager();
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'test' });

    const booked = [
      settlement.bookNewAttempt(markedEvent({})),
      // A different reason, a different providerCallId and a different observation
      // time are three DIFFERENT events: each gets its own callId and booking.
      settlement.bookNewAttempt(markedEvent({ reason: 'provider re-sent a distinct late report' })),
      settlement.bookNewAttempt(markedEvent({ providerCallId: 'resp_late_2' })),
      settlement.bookNewAttempt(markedEvent({ receivedAt: RECEIVED_AT + 60_000 }))
    ];

    const callIds = new Set(booked.map((entry) => entry.callId));
    expect(callIds.size).toBe(booked.length);
    for (const entry of booked) {
      expect(entry.previouslyReconciled).toBe(false);
      expect(entry.callId.startsWith('call-unreachable#new-attempt-')).toBe(true);
    }
    expect(settlement.index.newAttempts()).toHaveLength(booked.length);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(
      booked.length * calculateUsageCost(LATE_USAGE, RATE_CARD).totalCostMicros
    );
    expect(manager.getMeteringStatus().reserveAttempts).toBe(booked.length);
    expect(manager.verifyConservationLaw().balanced).toBe(true);
  });

  it('a redelivery after a restart (WAL replay) still dedupes to the original settlement', () => {
    const dir = tempDir();
    const before = makeManager(dir);
    const settlementBefore = twoPhaseSettlementFor(before, { consumer: 'test', storageDir: dir });
    const first = settlementBefore.bookNewAttempt(markedEvent({}));
    const bookedBefore = before.getBudgetStatus().generalPool.settledMicros;
    expect(bookedBefore).toBe(first.incurredCostMicros);

    // ---- restart: a NEW manager + a NEW settlement over the same directory ----
    const after = makeManager(dir);
    const settlementAfter = twoPhaseSettlementFor(after, { consumer: 'test', storageDir: dir });
    expect(settlementAfter.identityOf(first.callId)?.newAttemptMarker).toBe('new-attempt');
    expect(after.recoverFromWal().balanceBalanced).toBe(true);
    expect(after.getBudgetStatus().generalPool.settledMicros).toBe(bookedBefore);

    const replayed = settlementAfter.bookNewAttempt(markedEvent({}));
    expect(replayed.callId).toBe(first.callId);
    expect(replayed.previouslyReconciled).toBe(true);
    expect(replayed.incurredCostMicros).toBe(first.incurredCostMicros);
    expect(after.getBudgetStatus().generalPool.settledMicros).toBe(bookedBefore);
    expect(after.getMeteringStatus().reserveAttempts).toBe(0);
    expect(settlementAfter.index.newAttempts()).toHaveLength(1);
    expect(after.verifyConservationLaw().balanced).toBe(true);
  });
});
