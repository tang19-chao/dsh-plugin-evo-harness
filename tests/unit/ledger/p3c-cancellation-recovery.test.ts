/**
 * P3-C: two-phase settlement, late usage reconciliation and WAL recovery.
 *
 * Load-bearing properties:
 *   - a cancelled/timed-out call settles INTERIM (money held), and the late usage
 *     settles exactly once; a repeated reconcile is a no-op, not a second charge;
 *   - a WAL restart reconstructs the single settled figure and a second reconcile
 *     after recovery cannot double-book;
 *   - a crash-dangling reservation is recovered as pending_reconciliation and can
 *     be reconciled once;
 *   - unknown counting semantics propagate to the usage report as UNKNOWN, never
 *     silently measured.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLedgerReservationManager,
  createUsagePayload,
  summarizeUsageAccounting,
  validateUsageAccountingReport,
  type LedgerReservationManager,
  type ModelRateCard
} from '../../../src/ledger';

const RATE_CARD: ModelRateCard = {
  modelId: 'p3c/recovery-model',
  inputRatePerMillion: 1_000_000,
  outputRatePerMillion: 2_000_000,
  reasoningSeparatelyBilled: false,
  conservativeFallbackCostMicros: 500
};

const SEMANTICS = { inputIncludesCacheRead: true, outputIncludesReasoning: true } as const;

const LATE_USAGE = createUsagePayload({
  input: 2_000,
  output: 500,
  cacheRead: 100,
  semantics: SEMANTICS
});

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0).reverse()) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeManager(storageDir?: string): LedgerReservationManager {
  return createLedgerReservationManager({
    enabled: true,
    // These tests exercise the settlement/recovery accounting path; the observe
    // semantics have their own suite (p3a2-observe.test.ts).
    enforceHardBounds: true,
    generalBudgetMicros: 10_000_000,
    verificationReserveMicros: 1_000_000,
    maxConcurrencySeats: 4,
    defaultRateCard: RATE_CARD,
    ...(storageDir === undefined ? {} : { storageDir })
  });
}

function reserveCall(manager: LedgerReservationManager, callId: string): string {
  const reserved = manager.reserve({
    callId,
    phase: 'probe',
    pool: 'general',
    estimatedCostMicros: 10_000,
    requiresSeat: false,
    rateCard: RATE_CARD
  });
  expect(reserved.granted).toBe(true);
  return reserved.reservationId as string;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'p3c-recovery-'));
  tempDirs.push(dir);
  return dir;
}

describe('cancellation/timeout: two-phase settlement', () => {
  for (const outcome of ['cancelled', 'timed_out'] as const) {
    it('settles ' + outcome + ' interim, then late usage exactly once', () => {
      const manager = makeManager();
      const callId = 'call-' + outcome;
      const reservationId = reserveCall(manager, callId);

      const interim = manager.settle({
        callId,
        reservationId,
        outcome,
        interim: true,
        rateCard: RATE_CARD
      });
      expect(interim.state).toBe('interim_settled');
      expect(interim.auditOnly).toBe(true);
      expect(interim.qualityEvidence).toBe(false);
      // Interim settlement holds the money: nothing is booked yet.
      expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(0);
      expect(manager.getBudgetStatus().generalPool.reservedMicros).toBe(10_000);

      const first = manager.reconcileLateUsage({ callId, usage: LATE_USAGE, rateCard: RATE_CARD });
      const settledAfterFirst = manager.getBudgetStatus().generalPool.settledMicros;
      expect(first.incurredCostMicros).toBeGreaterThan(0);
      expect(settledAfterFirst).toBe(first.incurredCostMicros);
      expect(manager.getBudgetStatus().generalPool.reservedMicros).toBe(0);
      expect(manager.verifyConservationLaw().balanced).toBe(true);

      // The SAME late usage arriving again must not charge twice.
      const second = manager.reconcileLateUsage({ callId, usage: LATE_USAGE, rateCard: RATE_CARD });
      expect(second.incurredCostMicros).toBe(first.incurredCostMicros);
      expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(settledAfterFirst);
      expect(manager.getSettledResult(callId)?.incurredCostMicros).toBe(first.incurredCostMicros);
      expect(manager.verifyConservationLaw().balanced).toBe(true);
    });
  }
});

describe('WAL recovery: no duplicate settlement', () => {
  it('reconstructs the single settled figure and a later reconcile stays a no-op', () => {
    const dir = tempDir();
    const callId = 'call-wal';
    const first = makeManager(dir);
    const reservationId = reserveCall(first, callId);
    first.settle({ callId, reservationId, outcome: 'cancelled', interim: true, rateCard: RATE_CARD });
    const reconciled = first.reconcileLateUsage({ callId, usage: LATE_USAGE, rateCard: RATE_CARD });
    const settledBefore = first.getBudgetStatus().generalPool.settledMicros;
    expect(settledBefore).toBe(reconciled.incurredCostMicros);

    const recovered = makeManager(dir);
    const report = recovered.recoverFromWal();
    expect(report.replayedEventsCount).toBeGreaterThan(0);
    expect(recovered.getBudgetStatus().generalPool.settledMicros).toBe(settledBefore);
    expect(recovered.getSettledResult(callId)?.incurredCostMicros).toBe(reconciled.incurredCostMicros);
    expect(recovered.verifyConservationLaw().balanced).toBe(true);

    // Replaying the late usage after recovery must not book the cost again.
    recovered.reconcileLateUsage({ callId, usage: LATE_USAGE, rateCard: RATE_CARD });
    expect(recovered.getBudgetStatus().generalPool.settledMicros).toBe(settledBefore);
    expect(recovered.verifyConservationLaw().balanced).toBe(true);
  });

  it('recovers a crash-dangling reservation and reconciles it exactly once', () => {
    const dir = tempDir();
    const callId = 'call-crash';
    const before = makeManager(dir);
    reserveCall(before, callId);
    // Simulate a crash: no settle event is written.

    const recovered = makeManager(dir);
    const report = recovered.recoverFromWal();
    expect(report.recoveredDanglingCount).toBe(1);
    expect(report.recoveredCallIds).toContain(callId);
    expect(recovered.getReservationByCallId(callId)?.state).toBe('pending_reconciliation');

    const settled = recovered.reconcileLateUsage({ callId, usage: LATE_USAGE, rateCard: RATE_CARD });
    const settledMicros = recovered.getBudgetStatus().generalPool.settledMicros;
    expect(settledMicros).toBe(settled.incurredCostMicros);
    expect(recovered.getBudgetStatus().generalPool.reservedMicros).toBe(0);

    recovered.reconcileLateUsage({ callId, usage: LATE_USAGE, rateCard: RATE_CARD });
    expect(recovered.getBudgetStatus().generalPool.settledMicros).toBe(settledMicros);
    expect(recovered.verifyConservationLaw().balanced).toBe(true);
  });
});

describe('unknown semantics propagate to the usage report', () => {
  it('books a settlement without semantics as UNKNOWN, not measured', () => {
    const manager = makeManager();
    const callId = 'call-unknown-semantics';
    const reservationId = reserveCall(manager, callId);
    const usageWithoutSemantics = createUsagePayload({ input: 1_000, output: 500, cacheRead: 10 });
    manager.settle({ callId, reservationId, outcome: 'succeeded', usage: usageWithoutSemantics });

    const report = summarizeUsageAccounting(manager.getLedgerEvents());
    expect(report.unknown.calls).toBe(1);
    expect(report.measured.calls).toBe(0);
    expect(report.estimated.calls).toBe(0);
    expect(report.cacheReadUnknownCalls).toBe(0);
    expect(validateUsageAccountingReport(report)).toEqual([]);
  });

  it('books provider-declared semantics as measured and keeps cacheRead visible', () => {
    const manager = makeManager();
    const callId = 'call-measured';
    const reservationId = reserveCall(manager, callId);
    manager.settle({
      callId,
      reservationId,
      outcome: 'succeeded',
      usage: createUsagePayload({ input: 1_000, output: 500, cacheRead: 10, semantics: SEMANTICS })
    });

    const report = summarizeUsageAccounting(manager.getLedgerEvents());
    expect(report.measured.calls).toBe(1);
    expect(report.unknown.calls).toBe(0);
    expect(report.measured.costMicros).toBeGreaterThan(0);
    expect(validateUsageAccountingReport(report)).toEqual([]);
  });
});
