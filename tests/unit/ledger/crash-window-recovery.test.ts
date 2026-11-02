/**
 * P1-5 / R2-1 / LEDGER-7 (audit rounds 1+2): the crash windows around the
 * durable call index, and its fail-closed load rule.
 *
 * WHAT THIS PINS:
 *
 *   P1-5 — the settle→index window: `manager.settle` fsyncs EVENT_SETTLED before
 *   `index.recordInterim/recordFinal` fsyncs the index. After a crash a settle
 *   retry used to hit the manager's idempotency cache (`isIdempotentReplay=true`)
 *   and SKIP the index write again, so the identity stayed 'reserved' forever and
 *   the reserved buffer was locked. Now the replay still records the missing
 *   line (the index ops are idempotent appends), a lost identity is rebuilt from
 *   the manager's reservation, and the recovery scan syncs the index from the
 *   WAL payloads — no double booking on any of these paths.
 *
 *   R2-1 — a crash-recovered in-flight call (manager `pending_reconciliation`,
 *   index 'reserved') could not be booked through ANY sanctioned lifecycle exit:
 *   settleCall threw INVALID_SETTLEMENT_STATE and reconcileLateUsage threw
 *   LATE_USAGE_BEFORE_TERMINATION. Now the recovered state reconciles through
 *   the manager's resolvingPending path — and never books a silent 0.
 *
 *   LEDGER-7 — `LedgerCallIndex.load()` used to `continue` on a parse failure at
 *   ANY position (silently dropping a real fsynced mapping). It now mirrors the
 *   WAL reader: only the LAST non-empty line may be torn; anything else throws
 *   INDEX_CORRUPT.
 *
 * Everything runs on REAL files in a REAL temp directory with the REAL factory
 * and REAL `recoverFromWal()` replay; only callId/usage values are constructed.
 * The P1-5 window itself is produced exactly as the audit repro did: the test
 * holds the manager and settles directly, so the fsynced WAL event lands while
 * the index line does not.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  calculateUsageCost,
  createLedgerReservationManager,
  createUsagePayload,
  DEFAULT_CALL_INDEX_FILE,
  LedgerCallIndex,
  LedgerError,
  twoPhaseSettlementFor,
  TwoPhaseLedgerError,
  type LedgerReservationManager,
  type ModelRateCard,
  type ProviderUsagePayload,
  type ReserveRequest
} from '../../../src/ledger';

const RATE_CARD: ModelRateCard = {
  modelId: 'p1-5/crash-window-model',
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

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0).reverse()) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'p1-5-crash-window-'));
  tempDirs.push(dir);
  return dir;
}

function makeManager(
  storageDir?: string,
  overrides: { readonly defaultRateCard?: ModelRateCard } = {}
): LedgerReservationManager {
  return createLedgerReservationManager({
    enabled: true,
    enforceHardBounds: true,
    generalBudgetMicros: 10_000_000,
    verificationReserveMicros: 1_000_000,
    maxConcurrencySeats: 4,
    ...overrides,
    ...(storageDir === undefined ? {} : { storageDir })
  });
}

/** Reserve DIRECTLY on the manager, bypassing the settlement (and its index write). */
function rawReserve(manager: LedgerReservationManager, callId: string, rateCard?: ModelRateCard): string {
  const request: ReserveRequest = {
    callId,
    phase: 'probe',
    pool: 'general',
    estimatedCostMicros: ESTIMATE,
    requiresSeat: false,
    ...(rateCard === undefined ? {} : { rateCard })
  };
  const reserved = manager.reserve(request);
  expect(reserved.granted).toBe(true);
  return reserved.reservationId as string;
}

function codeOf(thrown: unknown): string | undefined {
  if (thrown instanceof TwoPhaseLedgerError) {
    return thrown.code;
  }
  if (thrown instanceof LedgerError) {
    return thrown.code;
  }
  return undefined;
}

describe('P1-5: the settle→index crash window self-heals', () => {
  it('a FINAL settle replay after recovery advances the identity and books nothing twice', () => {
    const dir = tempDir();
    const callId = 'call-window-final';
    const before = makeManager(dir);
    const settlementBefore = twoPhaseSettlementFor(before, { consumer: 'test', storageDir: dir });
    const reserved = settlementBefore.beginCall({
      callId,
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: ESTIMATE,
      requiresSeat: false,
      rateCard: RATE_CARD
    });
    expect(reserved.granted).toBe(true);
    // The window: the manager's settle reaches the fsynced WAL while the index
    // line never lands (the settlement API is bypassed, exactly the audited gap).
    const booked = before.settle({ callId, reservationId: reserved.reservationId as string, outcome: 'succeeded', usage: USAGE });
    expect(booked.isIdempotentReplay).toBe(false);
    expect(settlementBefore.identityOf(callId)?.state).toBe('reserved');
    const expectedCost = calculateUsageCost(USAGE, RATE_CARD).totalCostMicros;
    expect(before.getBudgetStatus().generalPool.settledMicros).toBe(expectedCost);

    // ---- restart: a NEW manager + settlement over the same directory ----
    const after = makeManager(dir);
    const settlementAfter = twoPhaseSettlementFor(after, { consumer: 'test', storageDir: dir });
    after.recoverFromWal();
    expect(settlementAfter.identityOf(callId)?.state).toBe('reserved');

    const retried = settlementAfter.settleCall({
      callId,
      reservationId: reserved.reservationId as string,
      outcome: 'succeeded',
      usage: USAGE
    });
    expect(retried.idempotentReplay).toBe(true);
    // THE fix: the replay still records the missing index line — the identity
    // advances instead of being stuck at 'reserved' forever.
    expect(settlementAfter.identityOf(callId)?.state).toBe('settled');
    expect(settlementAfter.identityOf(callId)?.outcome).toBe('succeeded');
    // No double booking: exactly the originally settled figure, no re-reserve.
    expect(after.getBudgetStatus().generalPool.settledMicros).toBe(expectedCost);
    expect(after.getBudgetStatus().generalPool.reservedMicros).toBe(0);
    expect(after.getMeteringStatus().reserveAttempts).toBe(0);
    expect(after.verifyConservationLaw().balanced).toBe(true);

    // And the healed identity joins late usage again (the locked-funds symptom).
    const merged = settlementAfter.reconcileLateUsage({ originCallId: callId, usage: LATE_USAGE });
    expect(merged.previouslyReconciled).toBe(false);
    expect(after.getBudgetStatus().generalPool.settledMicros).toBe(
      calculateUsageCost(LATE_USAGE, RATE_CARD).totalCostMicros
    );
  });

  it('an INTERIM settle replay after recovery advances to interim and the buffer stays joinable', () => {
    const dir = tempDir();
    const callId = 'call-window-interim';
    const before = makeManager(dir);
    const settlementBefore = twoPhaseSettlementFor(before, { consumer: 'test', storageDir: dir });
    const reserved = settlementBefore.beginCall({
      callId,
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: ESTIMATE,
      requiresSeat: false,
      rateCard: RATE_CARD
    });
    before.settle({ callId, reservationId: reserved.reservationId as string, outcome: 'cancelled', interim: true });
    expect(settlementBefore.identityOf(callId)?.state).toBe('reserved');

    const after = makeManager(dir);
    const settlementAfter = twoPhaseSettlementFor(after, { consumer: 'test', storageDir: dir });
    after.recoverFromWal();

    const retried = settlementAfter.settleCall({
      callId,
      reservationId: reserved.reservationId as string,
      outcome: 'cancelled'
    });
    expect(retried.idempotentReplay).toBe(true);
    expect(settlementAfter.identityOf(callId)?.state).toBe('interim_settled');
    // The interim hold is intact: money held, nothing booked.
    expect(after.getBudgetStatus().generalPool.reservedMicros).toBe(ESTIMATE);
    expect(after.getBudgetStatus().generalPool.settledMicros).toBe(0);
    expect(after.verifyConservationLaw().balanced).toBe(true);

    // The held buffer is joinable again — the exact reconcile the old window
    // refused with LATE_USAGE_BEFORE_TERMINATION forever.
    const merged = settlementAfter.reconcileLateUsage({ originCallId: callId, usage: LATE_USAGE });
    expect(merged.incurredCostMicros).toBe(calculateUsageCost(LATE_USAGE, RATE_CARD).totalCostMicros);
    expect(after.getBudgetStatus().generalPool.reservedMicros).toBe(0);
    expect(after.getBudgetStatus().generalPool.settledMicros).toBe(merged.incurredCostMicros);
  });

  it('a settle whose index mapping was lost is rebuilt from the manager (same-process window)', () => {
    const manager = makeManager();
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'test' });
    const callId = 'call-lost-mapping';
    const reservationId = rawReserve(manager, callId, RATE_CARD);

    const settled = settlement.settleCall({ callId, reservationId, outcome: 'succeeded', usage: USAGE });
    expect(settled.settlement).toBe('final');
    const identity = settlement.identityOf(callId);
    expect(identity?.state).toBe('settled');
    expect(identity?.reservationId).toBe(reservationId);
    // The rebuilt identity is honestly labelled: the WAL does not carry the
    // consumer, so a rebuilt mapping is never passed off as a wired one.
    expect(identity?.consumer).toBe('wal-recovery');
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(
      calculateUsageCost(USAGE, RATE_CARD).totalCostMicros
    );
  });

  it('the recovery scan syncs the index from the WAL payloads (both windows, proactively)', () => {
    const dir = tempDir();
    const before = makeManager(dir);
    const settlementBefore = twoPhaseSettlementFor(before, { consumer: 'test', storageDir: dir });
    // Window 1: settle fsynced, index line lost.
    const finalCall = 'call-scan-final';
    const finalRes = settlementBefore.beginCall({
      callId: finalCall,
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: ESTIMATE,
      requiresSeat: false,
      rateCard: RATE_CARD
    });
    before.settle({ callId: finalCall, reservationId: finalRes.reservationId as string, outcome: 'succeeded', usage: USAGE });
    // Window 2: reserve fsynced, index line never written (raw manager reserve).
    const reservedCall = 'call-scan-raw-reserve';
    rawReserve(before, reservedCall, RATE_CARD);

    const after = makeManager(dir);
    const settlementAfter = twoPhaseSettlementFor(after, { consumer: 'test', storageDir: dir });
    const report = settlementAfter.recoverFromWal();
    expect(report.manager.balanceBalanced).toBe(true);
    expect(report.indexReservationsBackfilled).toBeGreaterThanOrEqual(1);
    expect(report.indexSettlementsAdvanced).toBeGreaterThanOrEqual(1);

    // Both identities are now consistent — no settle retry needed.
    expect(settlementAfter.identityOf(finalCall)?.state).toBe('settled');
    expect(settlementAfter.identityOf(finalCall)?.incurredCostMicros).toBe(
      calculateUsageCost(USAGE, RATE_CARD).totalCostMicros
    );
    expect(settlementAfter.identityOf(reservedCall)?.state).toBe('reserved');
    expect(settlementAfter.identityOf(reservedCall)?.reservationId).toBeDefined();
    expect(settlementAfter.identityOf(reservedCall)?.rateCard?.modelId).toBe(RATE_CARD.modelId);
    // Re-running the recovery is a no-op on the index (nothing left to back-fill).
    const again = settlementAfter.recoverFromWal();
    expect(again.indexReservationsBackfilled).toBe(0);
    expect(again.indexSettlementsAdvanced).toBe(0);
  });
});

describe('R2-1: a crash-recovered in-flight call books through the reconcile path', () => {
  it('reconciles a pending_reconciliation reservation exactly once and releases the buffer', () => {
    const dir = tempDir();
    const callId = 'call-recovered';
    const before = makeManager(dir);
    const settlementBefore = twoPhaseSettlementFor(before, { consumer: 'test', storageDir: dir });
    settlementBefore.beginCall({
      callId,
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: ESTIMATE,
      requiresSeat: false,
      rateCard: RATE_CARD
    });
    // Simulated crash: no settle event is written at all.

    const after = makeManager(dir);
    const settlementAfter = twoPhaseSettlementFor(after, { consumer: 'test', storageDir: dir });
    const report = settlementAfter.recoverFromWal();
    expect(report.manager.recoveredDanglingCount).toBe(1);
    expect(after.getReservationByCallId(callId)?.state).toBe('pending_reconciliation');
    expect(settlementAfter.identityOf(callId)?.state).toBe('reserved');

    // The ONLY exit the old code had was bookNewAttempt (a fresh callId plus a
    // permanently locked buffer). The reconcile path is now the sanctioned exit.
    const merged = settlementAfter.reconcileLateUsage({ originCallId: callId, usage: LATE_USAGE });
    expect(merged.mode).toBe('reconciled');
    expect(merged.callId).toBe(callId);
    expect(merged.incurredCostMicros).toBe(calculateUsageCost(LATE_USAGE, RATE_CARD).totalCostMicros);
    expect(after.getBudgetStatus().generalPool.settledMicros).toBe(merged.incurredCostMicros);
    expect(after.getBudgetStatus().generalPool.reservedMicros).toBe(0);
    expect(settlementAfter.identityOf(callId)?.state).toBe('reconciled');
    expect(after.verifyConservationLaw().balanced).toBe(true);

    // A re-delivery of the same late usage stays a no-op.
    const again = settlementAfter.reconcileLateUsage({ originCallId: callId, usage: LATE_USAGE });
    expect(again.previouslyReconciled).toBe(true);
    expect(after.getBudgetStatus().generalPool.settledMicros).toBe(merged.incurredCostMicros);
  });

  it('still refuses a genuinely ACTIVE reservation (the guard is crash-recovery only)', () => {
    const manager = makeManager();
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'test' });
    settlement.beginCall({
      callId: 'call-live',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: ESTIMATE,
      requiresSeat: false,
      rateCard: RATE_CARD
    });
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

  it('never books a silent 0: a recovered reconcile without a usable card or actualCost refuses', () => {
    const dir = tempDir();
    const callId = 'call-silent-zero';
    // No default card and no card on the reservation: the manager's no-data
    // branch would book previousIncurred (0) and release the buffer.
    const before = makeManager(dir, { defaultRateCard: undefined });
    const settlementBefore = twoPhaseSettlementFor(before, { consumer: 'test', storageDir: dir });
    const reserved = settlementBefore.beginCall({
      callId,
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: ESTIMATE,
      requiresSeat: false
    });
    expect(reserved.granted).toBe(true);

    const after = makeManager(dir, { defaultRateCard: undefined });
    const settlementAfter = twoPhaseSettlementFor(after, { consumer: 'test', storageDir: dir });
    settlementAfter.recoverFromWal();

    for (const event of [
      { originCallId: callId },
      // Usage without ANY reachable card is the same silent-0 shape.
      { originCallId: callId, usage: LATE_USAGE }
    ]) {
      let thrown: unknown;
      try {
        settlementAfter.reconcileLateUsage(event);
      } catch (error) {
        thrown = error;
      }
      expect(codeOf(thrown)).toBe('LATE_USAGE_BEFORE_TERMINATION');
    }
    // The reserved buffer is NOT released against a zero booking.
    expect(after.getBudgetStatus().generalPool.reservedMicros).toBe(ESTIMATE);
    expect(after.getBudgetStatus().generalPool.settledMicros).toBe(0);
    expect(settlementAfter.identityOf(callId)?.state).toBe('reserved');
  });

  it('settleCall still refuses the recovered state; reconcile is the sanctioned exit', () => {
    const dir = tempDir();
    const callId = 'call-recovered-settle';
    const before = makeManager(dir);
    const settlementBefore = twoPhaseSettlementFor(before, { consumer: 'test', storageDir: dir });
    const reserved = settlementBefore.beginCall({
      callId,
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: ESTIMATE,
      requiresSeat: false,
      rateCard: RATE_CARD
    });

    const after = makeManager(dir);
    const settlementAfter = twoPhaseSettlementFor(after, { consumer: 'test', storageDir: dir });
    settlementAfter.recoverFromWal();

    let thrown: unknown;
    try {
      settlementAfter.settleCall({ callId, reservationId: reserved.reservationId as string, outcome: 'succeeded', usage: USAGE });
    } catch (error) {
      thrown = error;
    }
    // `pending_reconciliation` is not a settleable state; the manager's own
    // fail-closed refusal stands and nothing is booked.
    expect(codeOf(thrown)).toBe('INVALID_SETTLEMENT_STATE');
    expect(after.getBudgetStatus().generalPool.settledMicros).toBe(0);

    const merged = settlementAfter.reconcileLateUsage({ originCallId: callId, usage: LATE_USAGE });
    expect(after.getBudgetStatus().generalPool.settledMicros).toBe(merged.incurredCostMicros);
    expect(after.getBudgetStatus().generalPool.reservedMicros).toBe(0);
  });
});

describe('LEDGER-7: the call index fails closed on corruption', () => {
  function indexLine(callId: string): string {
    return JSON.stringify({ v: 1, op: 'reserve', at: 1_772_000_000_000, callId, reservationId: 'res_' + callId });
  }

  function writeIndexFile(dir: string, lines: readonly string[]): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, DEFAULT_CALL_INDEX_FILE), lines.join('\n') + '\n', 'utf8');
  }

  it('throws INDEX_CORRUPT when a NON-final line cannot be parsed', () => {
    const dir = tempDir();
    writeIndexFile(dir, [indexLine('k1'), '{"op":"reserve","callId":', indexLine('k2')]);
    let thrown: unknown;
    try {
      new LedgerCallIndex({ storageDir: dir });
    } catch (error) {
      thrown = error;
    }
    expect(codeOf(thrown)).toBe('INDEX_CORRUPT');
    expect(thrown instanceof Error && thrown.message.includes('line 2')).toBe(true);
  });

  it('throws INDEX_CORRUPT when a NON-final line is parseable but missing callId/op', () => {
    const dir = tempDir();
    // `append()` always writes both fields; a parseable line without them is
    // corruption too, not a legal entry.
    writeIndexFile(dir, [indexLine('k1'), JSON.stringify({ v: 1, at: 1_772_000_000_000, callId: 'k-orphan' }), indexLine('k2')]);
    let thrown: unknown;
    try {
      new LedgerCallIndex({ storageDir: dir });
    } catch (error) {
      thrown = error;
    }
    expect(codeOf(thrown)).toBe('INDEX_CORRUPT');
  });

  it('still tolerates exactly a truncated FINAL line (the crash-tail rule)', () => {
    const dir = tempDir();
    writeIndexFile(dir, [indexLine('k1'), indexLine('k2'), '{"op":"reserve","callId":"k3"']);
    const index = new LedgerCallIndex({ storageDir: dir });
    expect(index.lookup('k1')?.reservationId).toBe('res_k1');
    expect(index.lookup('k2')?.reservationId).toBe('res_k2');
    expect(index.lookup('k3')).toBeUndefined();
    expect(index.replayedLines).toBe(2);
  });

  it('still tolerates a garbage FINAL line the same way', () => {
    const dir = tempDir();
    writeIndexFile(dir, [indexLine('k1'), 'not json at all']);
    const index = new LedgerCallIndex({ storageDir: dir });
    expect(index.lookup('k1')?.reservationId).toBe('res_k1');
    expect(index.replayedLines).toBe(1);
  });
});
