/**
 * P3-C wiring (integration tail A): the durable call index + two-phase settlement.
 *
 * WHAT THIS PINS (the four wiring contracts registered in
 * docs/reports/p3-c-usage.md §7.1, plus the negative case that matters):
 *
 *   1. the callId -> reservationId mapping is persisted BEFORE the provider call
 *      and still joins AFTER a restart;
 *   2. a cancellation/timeout settles INTERIM on the ORIGINAL callId;
 *   3. late usage merges by the ORIGINAL callId and NEVER opens a new reservation
 *      (an unknown origin is refused, with nothing reserved and nothing settled);
 *   4. only the explicitly marked `new-attempt` path may open a new callId.
 *
 * Everything runs on REAL files in a REAL temp directory with the REAL factory
 * (`createLedgerReservationManager`) and REAL `recoverFromWal()` replay; there is
 * no mock and no fake ledger. Only callId/usage values are constructed.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  calculateUsageCost,
  createLedgerReservationManager,
  createUsagePayload,
  DEFAULT_CALL_INDEX_FILE,
  LedgerCallIndex,
  requiresInterimSettlement,
  twoPhaseSettlementFor,
  TwoPhaseLedgerError,
  type LedgerReservationManager,
  type ModelRateCard,
  type ProviderUsagePayload
} from '../../../src/ledger';

const RATE_CARD: ModelRateCard = {
  modelId: 'p3c/two-phase-model',
  inputRatePerMillion: 1_000_000,
  outputRatePerMillion: 2_000_000,
  reasoningSeparatelyBilled: false,
  conservativeFallbackCostMicros: 500
};

/** A 10x more expensive card, used to prove late usage is NOT repriced. */
const EXPENSIVE_CARD: ModelRateCard = {
  modelId: 'p3c/expensive-model',
  inputRatePerMillion: 10_000_000,
  outputRatePerMillion: 20_000_000,
  reasoningSeparatelyBilled: false,
  conservativeFallbackCostMicros: 5_000
};

const SEMANTICS = { inputIncludesCacheRead: true, outputIncludesReasoning: true } as const;

const LATE_USAGE: ProviderUsagePayload = createUsagePayload({
  input: 2_000,
  output: 500,
  cacheRead: 100,
  semantics: SEMANTICS
});

const FIRST_USAGE: ProviderUsagePayload = createUsagePayload({
  input: 1_000,
  output: 200,
  semantics: SEMANTICS
});

const ESTIMATE = 10_000;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0).reverse()) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'p3c-two-phase-'));
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

function openCall(
  settlement: ReturnType<typeof twoPhaseSettlementFor>,
  callId: string,
  rateCard: ModelRateCard = RATE_CARD
): string {
  const reserved = settlement.beginCall({
    callId,
    phase: 'probe',
    pool: 'general',
    estimatedCostMicros: ESTIMATE,
    requiresSeat: false,
    rateCard
  });
  expect(reserved.granted).toBe(true);
  return reserved.reservationId as string;
}

function codeOf(thrown: unknown): string | undefined {
  return thrown instanceof TwoPhaseLedgerError ? thrown.code : undefined;
}

describe('1. durable callId -> reservationId mapping', () => {
  it('writes the mapping beside the WAL BEFORE any settlement, and reloads it', () => {
    const dir = tempDir();
    const manager = makeManager(dir);
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'test', storageDir: dir });
    const reservationId = openCall(settlement, 'call-durable');

    const indexPath = join(dir, DEFAULT_CALL_INDEX_FILE);
    expect(settlement.index.persistencePath).toBe(indexPath);
    expect(existsSync(indexPath)).toBe(true);
    const lines = readFileSync(indexPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(record['op']).toBe('reserve');
    expect(record['callId']).toBe('call-durable');
    expect(record['reservationId']).toBe(reservationId);
    expect(record['consumer']).toBe('test');
    // The rate card frozen at reserve time is durable too (ADR-0004 §8.1).
    expect((record['rateCard'] as Record<string, unknown>)['modelId']).toBe(RATE_CARD.modelId);

    // A fresh index over the same directory sees the same mapping.
    const reloaded = new LedgerCallIndex({ storageDir: dir });
    expect(reloaded.lookup('call-durable')?.reservationId).toBe(reservationId);
    expect(reloaded.lookup('call-durable')?.state).toBe('reserved');
    expect(reloaded.persistent).toBe(true);
    expect(settlement.describe()).toContain('persistent (');
  });

  it('is a visible degradation (not a silent one) when no storageDir is given', () => {
    const manager = makeManager();
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'test' });
    expect(settlement.index.persistent).toBe(false);
    expect(settlement.describe()).toContain('in-memory');
  });

  it('refuses to keep its mapping inside the team collaboration directory', () => {
    let thrown: unknown;
    try {
      new LedgerCallIndex({ storageDir: join(tempDir(), '.agent-teams') });
    } catch (error) {
      thrown = error;
    }
    expect(codeOf(thrown)).toBe('INDEX_STORAGE_FORBIDDEN');
  });

  it('refuses two different index locations for one ledger manager', () => {
    const dirA = tempDir();
    const dirB = tempDir();
    const manager = makeManager(dirA);
    twoPhaseSettlementFor(manager, { consumer: 'test', storageDir: dirA });
    let thrown: unknown;
    try {
      twoPhaseSettlementFor(manager, { consumer: 'test', storageDir: dirB });
    } catch (error) {
      thrown = error;
    }
    expect(codeOf(thrown)).toBe('INDEX_CONFIG_CONFLICT');
  });
});

describe('2. cancellation/timeout settles INTERIM on the original callId', () => {
  it('holds the money for cancelled/timed_out and books nothing yet', () => {
    for (const outcome of ['cancelled', 'timed_out'] as const) {
      const manager = makeManager();
      const settlement = twoPhaseSettlementFor(manager, { consumer: 'test' });
      const callId = 'call-' + outcome;
      const reservationId = openCall(settlement, callId);

      const settled = settlement.settleCall({ callId, reservationId, outcome });
      expect(settled.settlement).toBe('interim');
      expect(settled.result.state).toBe('interim_settled');
      expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(0);
      expect(manager.getBudgetStatus().generalPool.reservedMicros).toBe(ESTIMATE);
      expect(settlement.identityOf(callId)?.state).toBe('interim_settled');
      expect(settlement.identityOf(callId)?.outcome).toBe(outcome);
    }
  });

  it('books FINAL for an outcome that proves the remote terminated', () => {
    const manager = makeManager();
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'test' });
    const reservationId = openCall(settlement, 'call-succeeded');
    const settled = settlement.settleCall({
      callId: 'call-succeeded',
      reservationId,
      outcome: 'succeeded',
      usage: LATE_USAGE
    });
    expect(settled.settlement).toBe('final');
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(settled.result.incurredCostMicros);
    expect(manager.getBudgetStatus().generalPool.reservedMicros).toBe(0);
    expect(settlement.identityOf('call-succeeded')?.state).toBe('settled');
  });

  it('maps every outcome to the ADR-0004 §5.1 side of the line', () => {
    // Anything that does not PROVE the remote stopped keeps the money held. An
    // infrastructure_error is in this set on purpose: our own transport failing is
    // not the provider stopping.
    for (const outcome of [
      'cancelled',
      'timed_out',
      'aborted_local',
      'timed_out_local',
      'stream_interrupted',
      'interrupted_by_crash',
      'infrastructure_error'
    ] as const) {
      expect(requiresInterimSettlement(outcome)).toBe(true);
    }
    for (const outcome of ['succeeded', 'failed', 'aborted_confirmed', 'timed_out_confirmed'] as const) {
      expect(requiresInterimSettlement(outcome)).toBe(false);
    }
  });

  it('repeated settle on the same callId is a replay: one settlement, no re-booking', () => {
    const manager = makeManager();
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'test' });
    const reservationId = openCall(settlement, 'call-twice');

    const first = settlement.settleCall({ callId: 'call-twice', reservationId, outcome: 'cancelled' });
    expect(first.idempotentReplay).toBe(false);
    const second = settlement.settleCall({ callId: 'call-twice', reservationId, outcome: 'cancelled' });
    expect(second.idempotentReplay).toBe(true);
    expect(second.settlement).toBe('interim');

    expect(manager.getMeteringStatus().settleCount).toBe(1);
    expect(manager.getBudgetStatus().generalPool.reservedMicros).toBe(ESTIMATE);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(0);
    // The index keeps one identity, still in the interim state.
    expect(settlement.identityOf('call-twice')?.state).toBe('interim_settled');
    expect(settlement.identityOf('call-twice')?.reconciliations).toBe(0);
  });
});

describe('3. late usage merges by the ORIGINAL callId (never a new reservation)', () => {
  it('books the late usage once and a re-delivery changes nothing', () => {
    const manager = makeManager();
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'test' });
    const reservationId = openCall(settlement, 'call-late');
    settlement.settleCall({ callId: 'call-late', reservationId, outcome: 'cancelled' });

    const merged = settlement.reconcileLateUsage({ originCallId: 'call-late', usage: LATE_USAGE });
    const booked = manager.getBudgetStatus().generalPool.settledMicros;
    expect(merged.mode).toBe('reconciled');
    expect(merged.callId).toBe('call-late');
    expect(merged.reservationId).toBe(reservationId);
    expect(merged.previouslyReconciled).toBe(false);
    expect(booked).toBe(merged.incurredCostMicros);
    expect(manager.getBudgetStatus().generalPool.reservedMicros).toBe(0);
    expect(manager.verifyConservationLaw().balanced).toBe(true);
    // One reserve attempt in total: the merge did NOT open a second call.
    expect(manager.getMeteringStatus().reserveAttempts).toBe(1);
    expect(manager.getMeteringStatus().settleCount).toBe(1);

    const again = settlement.reconcileLateUsage({ originCallId: 'call-late', usage: LATE_USAGE });
    expect(again.previouslyReconciled).toBe(true);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(booked);
    expect(manager.getMeteringStatus().reserveAttempts).toBe(1);
    expect(settlement.identityOf('call-late')?.reconciliations).toBe(2);
  });

  it('prices late usage with the card FROZEN at reserve time (never a later card)', () => {
    const manager = makeManager();
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'test' });
    const reservationId = openCall(settlement, 'call-frozen');
    settlement.settleCall({
      callId: 'call-frozen',
      reservationId,
      outcome: 'succeeded',
      usage: FIRST_USAGE
    });
    // The call is FINAL settled, so the manager no longer holds the reservation
    // record. Only the durable identity can still freeze the price.
    const merged = settlement.reconcileLateUsage({
      originCallId: 'call-frozen',
      usage: LATE_USAGE,
      rateCard: EXPENSIVE_CARD
    });
    expect(merged.incurredCostMicros).toBe(calculateUsageCost(LATE_USAGE, RATE_CARD).totalCostMicros);
    expect(merged.incurredCostMicros).not.toBe(calculateUsageCost(LATE_USAGE, EXPENSIVE_CARD).totalCostMicros);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(merged.incurredCostMicros);
  });

  it('REFUSES late usage for an unknown origin and reserves nothing (path 乙 closed)', () => {
    const manager = makeManager();
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'test' });
    const poolsBefore = manager.getBudgetStatus();

    let thrown: unknown;
    try {
      settlement.reconcileLateUsage({ originCallId: 'call-never-reserved', usage: LATE_USAGE });
    } catch (error) {
      thrown = error;
    }
    expect(codeOf(thrown)).toBe('LATE_USAGE_UNKNOWN_CALL');
    expect(manager.getMeteringStatus().reserveAttempts).toBe(0);
    expect(manager.getMeteringStatus().settleCount).toBe(0);
    expect(manager.getBudgetStatus().generalPool).toEqual(poolsBefore.generalPool);
    expect(settlement.identities()).toHaveLength(0);
  });

  it('REFUSES late usage for a call that has not terminated yet', () => {
    const manager = makeManager();
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'test' });
    openCall(settlement, 'call-live');
    let thrown: unknown;
    try {
      settlement.reconcileLateUsage({ originCallId: 'call-live', usage: LATE_USAGE });
    } catch (error) {
      thrown = error;
    }
    expect(codeOf(thrown)).toBe('LATE_USAGE_BEFORE_TERMINATION');
    // The reservation is untouched: nothing was booked while it is still held.
    expect(manager.getBudgetStatus().generalPool.reservedMicros).toBe(ESTIMATE);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(0);
  });

  it('REFUSES settling a callId that was never opened through beginCall', () => {
    const manager = makeManager();
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'test' });
    let thrown: unknown;
    try {
      settlement.settleCall({ callId: 'call-untracked', reservationId: 'res_x', outcome: 'succeeded' });
    } catch (error) {
      thrown = error;
    }
    expect(codeOf(thrown)).toBe('CALL_NOT_TRACKED');
  });
});

describe('4. the new-callId escape hatch is explicit, marked and auditable', () => {
  it('refuses to open a new call without the new-attempt marker and reason', () => {
    const manager = makeManager();
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'test' });

    let thrown: unknown;
    try {
      settlement.bookNewAttempt({ originCallId: 'call-unreachable', usage: LATE_USAGE });
    } catch (error) {
      thrown = error;
    }
    expect(codeOf(thrown)).toBe('NEW_ATTEMPT_MARKER_REQUIRED');

    thrown = undefined;
    try {
      settlement.bookNewAttempt({
        originCallId: 'call-unreachable',
        usage: LATE_USAGE,
        newAttemptMarker: 'new-attempt',
        newAttemptReason: '   '
      });
    } catch (error) {
      thrown = error;
    }
    expect(codeOf(thrown)).toBe('NEW_ATTEMPT_MARKER_REQUIRED');
    expect(manager.getMeteringStatus().reserveAttempts).toBe(0);
    expect(settlement.identities()).toHaveLength(0);
  });

  it('books a MARKED new attempt under a derived callId and keeps the origin for audit', () => {
    const manager = makeManager();
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'test' });
    const booked = settlement.bookNewAttempt({
      originCallId: 'call-unreachable',
      usage: LATE_USAGE,
      newAttemptMarker: 'new-attempt',
      newAttemptReason: 'cross-process restart; the original mapping was not persisted'
    });

    expect(booked.mode).toBe('new-attempt');
    expect(booked.callId).not.toBe('call-unreachable');
    expect(booked.callId.startsWith('call-unreachable#new-attempt-')).toBe(true);
    expect(booked.originCallId).toBe('call-unreachable');
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(booked.incurredCostMicros);
    // The unjoined usage can never pass as quality evidence ...
    expect(booked.ledgerEvent?.auditOnly).toBe(true);
    expect(booked.ledgerEvent?.qualityEvidence).toBe(false);
    // ... and it stays separable from the joined calls in every report.
    const marked = settlement.index.newAttempts();
    expect(marked).toHaveLength(1);
    expect(marked[0]?.newAttemptReason).toContain('not persisted');
    expect(marked[0]?.originCallId).toBe('call-unreachable');
    expect(manager.getMeteringStatus().reserveAttempts).toBe(1);
  });
});

describe('5. restart: the durable mapping joins late usage without re-booking', () => {
  it('replays one settled figure and a second reconcile stays a no-op', () => {
    const dir = tempDir();
    const callId = 'call-restart';
    const before = makeManager(dir);
    const settlementBefore = twoPhaseSettlementFor(before, { consumer: 'test', storageDir: dir });
    const reservationId = openCall(settlementBefore, callId);
    settlementBefore.settleCall({ callId, reservationId, outcome: 'cancelled' });
    const merged = settlementBefore.reconcileLateUsage({ originCallId: callId, usage: LATE_USAGE });
    const bookedBefore = before.getBudgetStatus().generalPool.settledMicros;
    expect(bookedBefore).toBe(merged.incurredCostMicros);

    // ---- restart: a NEW manager + a NEW settlement over the same directory ----
    const after = makeManager(dir);
    const settlementAfter = twoPhaseSettlementFor(after, { consumer: 'test', storageDir: dir });
    expect(settlementAfter.identityOf(callId)?.reservationId).toBe(reservationId);
    expect(settlementAfter.identityOf(callId)?.state).toBe('reconciled');

    const report = after.recoverFromWal();
    expect(report.replayedEventsCount).toBeGreaterThan(0);
    expect(report.balanceBalanced).toBe(true);
    expect(after.getBudgetStatus().generalPool.settledMicros).toBe(bookedBefore);
    expect(after.getSettledResult(callId)?.incurredCostMicros).toBe(merged.incurredCostMicros);

    const replayed = settlementAfter.reconcileLateUsage({ originCallId: callId, usage: LATE_USAGE });
    expect(replayed.previouslyReconciled).toBe(true);
    expect(replayed.incurredCostMicros).toBe(merged.incurredCostMicros);
    expect(after.getBudgetStatus().generalPool.settledMicros).toBe(bookedBefore);
    expect(after.getMeteringStatus().reserveAttempts).toBe(0);
    expect(after.verifyConservationLaw().balanced).toBe(true);
  });

  it('refuses to fork an identity when the ledger state was NOT recovered', () => {
    const dir = tempDir();
    const callId = 'call-orphan';
    const before = makeManager(dir);
    const settlementBefore = twoPhaseSettlementFor(before, { consumer: 'test', storageDir: dir });
    const reservationId = openCall(settlementBefore, callId);
    settlementBefore.settleCall({ callId, reservationId, outcome: 'succeeded', usage: FIRST_USAGE });

    // A fresh manager that SKIPPED recoverFromWal(): the index knows the call, the
    // ledger does not. Re-reserving would silently fork one identity in two.
    const after = makeManager(dir);
    const settlementAfter = twoPhaseSettlementFor(after, { consumer: 'test', storageDir: dir });
    expect(settlementAfter.identityOf(callId)).toBeDefined();

    for (const action of [
      (): unknown => settlementAfter.beginCall({
        callId,
        phase: 'probe',
        pool: 'general',
        estimatedCostMicros: ESTIMATE,
        requiresSeat: false
      }),
      (): unknown => settlementAfter.reconcileLateUsage({ originCallId: callId, usage: LATE_USAGE })
    ]) {
      let thrown: unknown;
      try {
        action();
      } catch (error) {
        thrown = error;
      }
      expect(codeOf(thrown)).toBe('CALL_STATE_UNAVAILABLE');
    }
    expect(after.getMeteringStatus().reserveAttempts).toBe(0);

    // ... and the documented remedy works: recover, then merge.
    after.recoverFromWal();
    const merged = settlementAfter.reconcileLateUsage({ originCallId: callId, usage: LATE_USAGE });
    expect(merged.previouslyReconciled).toBe(false);
    expect(after.getBudgetStatus().generalPool.settledMicros).toBe(merged.incurredCostMicros);
  });

  it('reuses a terminal callId through the ledger\'s own idempotent refusal', () => {
    const manager = makeManager();
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'test' });
    const reservationId = openCall(settlement, 'call-terminal');
    settlement.settleCall({ callId: 'call-terminal', reservationId, outcome: 'succeeded', usage: FIRST_USAGE });
    const settledMicros = manager.getBudgetStatus().generalPool.settledMicros;

    const reReserved = settlement.beginCall({
      callId: 'call-terminal',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: ESTIMATE,
      requiresSeat: false
    });
    expect(reReserved.granted).toBe(false);
    expect(reReserved.rejectionReason).toBe('call_already_settled');
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(settledMicros);
    expect(manager.getMeteringStatus().reserveAttempts).toBe(1);
  });
});
