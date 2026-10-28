/**
 * C3 ledger consistency — independent adversarial audit tests (t19).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The C3 ledger (ADR-0004 §4–§8) is the system's only claim about money and
 * concurrency. Its dangerous failure modes are not crashes but SILENT DRIFT:
 * a concurrency seat freed twice (or freed out from under a live call), a
 * reservation resurrected by WAL replay, a pool counter that disagrees with the
 * reservation table, a late reconciliation that writes a real charge off to zero,
 * or a repeated reconciliation that books the same money twice. Each test below
 * pins one of those failure modes with an assertion that cannot pass vacuously.
 *
 *   F1  interim settle → manual seat release → another call takes the slot →
 *       reconcile must NOT release a second seat, and must never free the other
 *       call's seat.
 *   F2  WAL replay of an interim reconcile must not resurrect the reservation
 *       record or its seat handle, and must reproduce the live reserved/settled
 *       pools exactly.
 *   F3  a crash-recovered `pending_reconciliation` reservation terminalizes via
 *       `reconcileLateUsage`: reserved → 0, record deleted, seat returned,
 *       conservation holds. A second recovery must reproduce that terminal state.
 *   F4  replay of a NON-interim reconcile keeps the settled figure correct (the
 *       delta is applied once, not twice, and not against a stale reservation).
 *   F5  `saveSnapshot` carries active reservations AND seat-owner identities;
 *       recovery must not lose either, and the restored record stays usable.
 *   F6  recovery never rewinds the WAL sequence; events appended after the first
 *       recovery still exist after a second recovery.
 *   F7  the conservation check detects a reservation-table / pool disagreement.
 *       The mismatch is constructed by forging the snapshot — the only external
 *       state input of recovery — with a consistent control to prove the throw is
 *       attributable to the mismatch and not to snapshot parsing.
 *   F8  `reconcile({actualCostMicros: 0})` without a usage payload cannot write
 *       the charge off (conservative floor), and the rate card frozen at
 *       `reserve()` time wins over a later, more expensive card.
 *   F9  a repeated reconcile is accounting-idempotent: no duplicate variance, no
 *       duplicate refund, no double-booked settled amount.
 *
 * Everything is offline and deterministic: no network, no model call, no paid
 * API (ADR-0004 R0). Filesystem use is confined to per-test temp directories;
 * nothing under the repository or `.agent-teams/` is written.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  LedgerError,
  LedgerReservationManager,
  type LedgerManagerOptions
} from '../../../src/ledger/reservation-manager.js';
import {
  DEFAULT_DSH_COUNTING_SEMANTICS,
  createUsagePayload
} from '../../../src/ledger/pricing.js';
import type { LedgerSnapshotData } from '../../../src/ledger/wal.js';
import type {
  ModelRateCard,
  PoolStatus,
  ProviderUsagePayload,
  ReservationRecord
} from '../../../src/ledger/types.js';

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

/**
 * 1µ per uncached input token, 2µ per output token, 1,000µ conservative floor.
 * The floor is deliberately SMALL and round so a floor bug cannot masquerade as
 * a rounding artefact: any unexpected `1_000` is visible in the assertions.
 */
const RATE: ModelRateCard = {
  modelId: 't19-audit-card',
  inputRatePerMillion: 1_000_000,
  outputRatePerMillion: 2_000_000,
  reasoningSeparatelyBilled: false,
  conservativeFallbackCostMicros: 1_000
};

/** The same shape as a later, 10x more expensive card (time-freeze probes). */
const LATER_EXPENSIVE_RATE: ModelRateCard = {
  modelId: 't19-later-expensive-card',
  inputRatePerMillion: 10_000_000,
  outputRatePerMillion: 20_000_000,
  reasoningSeparatelyBilled: false,
  conservativeFallbackCostMicros: 20_000
};

const CONFIG: LedgerManagerOptions = {
  generalBudgetMicros: 100_000,
  verificationReserveMicros: 50_000,
  maxConcurrencySeats: 2,
  defaultRateCard: RATE
};

/** A measured usage payload: `input` tokens at 1µ, `output` tokens at 2µ. */
function usage(input: number, output = 0): ProviderUsagePayload {
  return createUsagePayload({
    input,
    output,
    semantics: DEFAULT_DSH_COUNTING_SEMANTICS
  });
}

function createManager(overrides: Partial<LedgerManagerOptions> = {}): LedgerReservationManager {
  return new LedgerReservationManager({ ...CONFIG, ...overrides });
}

// ---- temporary directories (never the repo, never .agent-teams) ------------

const tempDirs: string[] = [];

function makeTempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `t19-audit-${label}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ---- durable artefact readers / writers ------------------------------------

interface WalEventLike {
  sequenceNumber: number;
  type: string;
  payload: unknown;
}

function readWal(dir: string): WalEventLike[] {
  const file = path.join(dir, 'ledger.events.jsonl');
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as WalEventLike);
}

function readSnapshot(dir: string): LedgerSnapshotData {
  return JSON.parse(
    fs.readFileSync(path.join(dir, 'ledger.snapshot.json'), 'utf8')
  ) as LedgerSnapshotData;
}

function writeSnapshot(dir: string, snapshot: LedgerSnapshotData): void {
  fs.writeFileSync(
    path.join(dir, 'ledger.snapshot.json'),
    JSON.stringify(snapshot, null, 2),
    'utf8'
  );
}

/** A structurally valid pool snapshot whose figures the caller controls. */
function poolStatus(totalMicros: number, reservedMicros: number, settledMicros: number): PoolStatus {
  return {
    totalMicros,
    reservedMicros,
    settledMicros,
    // recovery recomputes remaining from the three counters above; keep the
    // field internally consistent so a malformed-snapshot failure cannot be
    // mistaken for the mismatch under test.
    remainingMicros: Math.max(0, totalMicros - reservedMicros - settledMicros),
    overdraftMicros: Math.max(0, reservedMicros + settledMicros - totalMicros)
  };
}

function forgedSnapshot(params: {
  generalReservedMicros: number;
  generalSettledMicros?: number;
  activeReservations?: readonly ReservationRecord[];
  seatOwners?: readonly string[];
}): LedgerSnapshotData {
  return {
    snapshotVersion: 1,
    lastSequenceNumber: 0,
    timestamp: 1_700_000_000_000,
    generalPool: poolStatus(100_000, params.generalReservedMicros, params.generalSettledMicros ?? 0),
    verificationPool: poolStatus(50_000, 0, 0),
    occupiedSeats: (params.seatOwners ?? []).length,
    maxSeats: 2,
    activeReservations: params.activeReservations ?? [],
    seatOwners: params.seatOwners ?? []
  };
}

/** Capture the LedgerError a call must throw, failing loudly if it does not. */
function captureLedgerError(fn: () => unknown): LedgerError {
  try {
    fn();
  } catch (error) {
    if (error instanceof LedgerError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a LedgerError, but the call completed without throwing');
}

// ===========================================================================
// F1 — seat ownership must not be released twice, nor on someone else's behalf
// ===========================================================================

describe('F1 — reconcile after a manual seat release never frees another call seat', () => {
  it('keeps the live call seat when the interim call seat was already returned', () => {
    const manager = createManager({
      generalBudgetMicros: 100_000,
      maxConcurrencySeats: 1,
      storageDir: makeTempDir('f1')
    });

    const a = manager.reserve({
      callId: 'interim-a',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 10_000,
      requiresSeat: true
    });
    expect(a.granted).toBe(true);
    expect(manager.occupiedSeatCount).toBe(1);

    // Stage 1: local abandonment is NOT remote termination, so the §5.1 hold
    // keeps A's seat even though the local wait ended.
    const interim = manager.settle({
      callId: 'interim-a',
      reservationId: a.reservationId!,
      outcome: 'timed_out_local',
      actualCostMicros: 0,
      interim: true
    });
    expect(interim.state).toBe('interim_settled');
    expect(interim.seatReleased).toBe(false);
    expect(interim.seatRetainedPendingRemote).toBe(true);
    expect(manager.isSeatRetainedPendingRemote('interim-a')).toBe(true);
    expect(manager.occupiedSeatCount).toBe(1);

    // Independent evidence arrives: A's retained handle is released exactly once.
    expect(manager.releaseSeat('interim-a')).toBe(true);
    expect(manager.releaseSeat('interim-a')).toBe(false);
    expect(manager.occupiedSeatCount).toBe(0);
    expect(manager.isSeatRetainedPendingRemote('interim-a')).toBe(false);

    // Stage 2: a DIFFERENT call takes the only slot while A is still unresolved.
    const b = manager.reserve({
      callId: 'live-b',
      phase: 'compose',
      pool: 'general',
      estimatedCostMicros: 10_000,
      requiresSeat: true
    });
    expect(b.granted).toBe(true);
    expect(manager.occupiedSeatCount).toBe(1);
    const bReservationId = b.reservationId!;

    // The slot is provably B's: a third seat request is refused.
    const blocked = manager.reserve({
      callId: 'third-call',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 1_000,
      requiresSeat: true
    });
    expect(blocked.granted).toBe(false);
    expect(blocked.rejectionReason).toBe('insufficient_seats');

    // Stage 3: late usage terminalizes A.
    const reconciled = manager.reconcileLateUsage({
      callId: 'interim-a',
      usage: usage(5_000)
    });
    expect(reconciled.incurredCostMicros).toBe(5_000);
    expect(reconciled.state).toBe('settled');
    // A's seat was already returned above; reconcile must not claim a release.
    // (A refund is still legitimate: refund ≠ seat release.)
    expect(reconciled.seatReleased).toBe(false);
    expect(reconciled.amountRefundedMicros).toBe(5_000);

    // B's seat must be untouched: the only slot is still B's.
    expect(manager.occupiedSeatCount).toBe(1);
    expect(manager.getBudgetStatus().seats.occupied).toBe(1);
    expect(manager.getReservationByCallId('live-b')?.reservationId).toBe(bReservationId);

    // A stale release of A cannot decrement B's ownership.
    expect(manager.releaseSeat('interim-a')).toBe(false);
    expect(manager.occupiedSeatCount).toBe(1);

    // Reservation table and pool counters agree: only B's money is still held.
    expect(manager.getReservationByCallId('interim-a')).toBeUndefined();
    expect(manager.getBudgetStatus().generalPool.reservedMicros).toBe(10_000);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(5_000);
    expect(manager.getBudgetStatus().generalPool.remainingMicros).toBe(85_000);
    expect(manager.verifyConservationLaw().balanced).toBe(true);

    // Only B can free the slot, exactly once.
    expect(manager.releaseSeat('live-b')).toBe(true);
    expect(manager.releaseSeat('live-b')).toBe(false);
    expect(manager.occupiedSeatCount).toBe(0);
  });
});

// ===========================================================================
// F2 — WAL replay of an interim reconcile must be convergent
// ===========================================================================

describe('F2 — WAL replay of an interim reconcile converges to the live pools', () => {
  it('does not resurrect the reconciled record/handle and matches reserved/settled exactly', () => {
    const dir = makeTempDir('f2');
    const config: LedgerManagerOptions = {
      ...CONFIG,
      generalBudgetMicros: 100_000,
      maxConcurrencySeats: 2,
      storageDir: dir
    };
    const first = new LedgerReservationManager(config);

    const a = first.reserve({
      callId: 'interim-a',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 10_000,
      requiresSeat: true
    });
    first.settle({
      callId: 'interim-a',
      reservationId: a.reservationId!,
      outcome: 'timed_out_local',
      actualCostMicros: 0,
      interim: true
    });
    // The manual release happens BEFORE the reconcile; replay must reproduce
    // that ordering and must not rebuild a phantom pending-remote handle.
    expect(first.releaseSeat('interim-a')).toBe(true);

    const b = first.reserve({
      callId: 'live-b',
      phase: 'compose',
      pool: 'general',
      estimatedCostMicros: 10_000,
      requiresSeat: true
    });
    expect(b.granted).toBe(true);

    first.reconcileLateUsage({ callId: 'interim-a', usage: usage(4_000) });

    const live = first.getBudgetStatus();
    expect(live.generalPool.reservedMicros).toBe(10_000); // B only
    expect(live.generalPool.settledMicros).toBe(4_000);
    expect(live.seats.occupied).toBe(1); // B only

    // A brand-new manager over the same WAL is the crash-recovery path.
    const second = new LedgerReservationManager(config);
    const report = second.recoverFromWal();
    expect(report.balanceBalanced).toBe(true);
    // Only B was in flight at crash time; A must not reappear as dangling.
    expect(report.recoveredDanglingCount).toBe(1);
    expect(report.recoveredCallIds).toEqual(['live-b']);

    const recovered = second.getBudgetStatus();
    expect(recovered.generalPool.reservedMicros).toBe(live.generalPool.reservedMicros);
    expect(recovered.generalPool.settledMicros).toBe(live.generalPool.settledMicros);
    expect(recovered.generalPool.remainingMicros).toBe(live.generalPool.remainingMicros);
    expect(recovered.seats.occupied).toBe(live.seats.occupied);

    // No record, no handle resurrection.
    expect(second.getReservationByCallId('interim-a')).toBeUndefined();
    expect(second.isSeatRetainedPendingRemote('interim-a')).toBe(false);
    expect(second.getSeatsPendingRemote()).toEqual([]);

    // The terminal result survives replay intact (including the refund).
    const replayedSettlement = second.getSettledResult('interim-a');
    expect(replayedSettlement?.state).toBe('settled');
    expect(replayedSettlement?.incurredCostMicros).toBe(4_000);
    expect(replayedSettlement?.amountRefundedMicros).toBe(6_000);
    expect(second.getSettledResult('interim-a')?.reservationId).toBe(a.reservationId);

    // B is the single live hold, and the conservation identity still holds.
    expect(second.getReservationByCallId('live-b')?.state).toBe('pending_reconciliation');
    expect(second.getBudgetStatus().seats.occupied).toBe(1);
    expect(second.verifyConservationLaw().balanced).toBe(true);
  });
});

// ===========================================================================
// F3 — crash-recovered pending_reconciliation terminalizes
// ===========================================================================

describe('F3 — pending_reconciliation terminalizes through reconcileLateUsage', () => {
  it('clears reserved, deletes the record, releases the seat and conserves the pool', () => {
    const dir = makeTempDir('f3');
    const config: LedgerManagerOptions = {
      ...CONFIG,
      generalBudgetMicros: 100_000,
      maxConcurrencySeats: 1,
      storageDir: dir
    };
    const first = new LedgerReservationManager(config);
    const reserved = first.reserve({
      callId: 'crash-pending',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 10_000,
      requiresSeat: true
    });
    expect(reserved.granted).toBe(true);

    // Crash + restart: the reservation becomes a §6.2 dangling hold.
    const recovering = new LedgerReservationManager(config);
    const report = recovering.recoverFromWal();
    expect(report.recoveredDanglingCount).toBe(1);
    expect(report.recoveredCallIds).toEqual(['crash-pending']);

    const pending = recovering.getReservationByCallId('crash-pending');
    expect(pending?.state).toBe('pending_reconciliation');
    // Unknown is not zero: the crash must not invent an incurred cost.
    expect(pending?.incurredCostMicros).toBeNull();
    expect(recovering.getBudgetStatus().generalPool.reservedMicros).toBe(10_000);
    expect(recovering.getBudgetStatus().seats.occupied).toBe(1);

    // Late usage is the terminal truth.
    const reconciled = recovering.reconcileLateUsage({
      callId: 'crash-pending',
      usage: usage(3_000)
    });
    expect(reconciled.incurredCostMicros).toBe(3_000);
    expect(reconciled.state).toBe('settled');
    expect(reconciled.seatReleased).toBe(true);

    const status = recovering.getBudgetStatus();
    expect(status.generalPool.reservedMicros).toBe(0);
    expect(status.generalPool.settledMicros).toBe(3_000);
    expect(status.generalPool.remainingMicros).toBe(97_000);
    expect(status.seats.occupied).toBe(0);
    expect(recovering.getReservationByCallId('crash-pending')).toBeUndefined();
    expect(recovering.verifyConservationLaw()).toMatchObject({
      balanced: true,
      overdrawn: false,
      overdraftVarianceMicros: 0
    });

    // Terminal stays terminal: the call can never be reserved again.
    const reReserve = recovering.reserve({
      callId: 'crash-pending',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 1_000
    });
    expect(reReserve.granted).toBe(false);
    expect(reReserve.rejectionReason).toBe('call_already_settled');
    expect(recovering.getBudgetStatus().generalPool.reservedMicros).toBe(0);

    // The reconciliation is durably logged.
    const walTypes = readWal(dir).map((event) => event.type);
    expect(walTypes).toContain('EVENT_RECONCILED');
  });

  it('a second recovery reproduces the terminal pools without resurrecting the record', () => {
    const dir = makeTempDir('f3-replay');
    const config: LedgerManagerOptions = {
      ...CONFIG,
      generalBudgetMicros: 100_000,
      maxConcurrencySeats: 1,
      storageDir: dir
    };
    const first = new LedgerReservationManager(config);
    first.reserve({
      callId: 'crash-pending',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 10_000,
      requiresSeat: true
    });

    const recovering = new LedgerReservationManager(config);
    recovering.recoverFromWal();
    recovering.reconcileLateUsage({ callId: 'crash-pending', usage: usage(3_000) });

    const third = new LedgerReservationManager(config);
    const report = third.recoverFromWal();
    expect(report.balanceBalanced).toBe(true);
    expect(report.recoveredDanglingCount).toBe(0); // terminal: nothing left to crash-recover

    expect(third.getBudgetStatus().generalPool.reservedMicros).toBe(0);
    expect(third.getBudgetStatus().generalPool.settledMicros).toBe(3_000);
    expect(third.getBudgetStatus().generalPool.remainingMicros).toBe(97_000);
    expect(third.getBudgetStatus().seats.occupied).toBe(0);
    expect(third.getReservationByCallId('crash-pending')).toBeUndefined();
    expect(third.verifyConservationLaw().balanced).toBe(true);
  });

  });

// ===========================================================================
// F4 — replay of a NON-interim reconcile
// ===========================================================================

describe('F4 — WAL replay of a non-interim reconcile keeps the settled figure correct', () => {
  it('applies the delta once against the already-settled figure, not against the reservation', () => {
    const dir = makeTempDir('f4');
    const config: LedgerManagerOptions = {
      ...CONFIG,
      generalBudgetMicros: 100_000,
      maxConcurrencySeats: 2,
      storageDir: dir
    };
    const first = new LedgerReservationManager(config);

    const res = first.reserve({
      callId: 'settled-then-reconciled',
      phase: 'compose',
      pool: 'general',
      estimatedCostMicros: 10_000
    });
    const settled = first.settle({
      callId: 'settled-then-reconciled',
      reservationId: res.reservationId!,
      outcome: 'succeeded',
      usage: usage(4_000)
    });
    expect(settled.incurredCostMicros).toBe(4_000);
    expect(settled.amountRefundedMicros).toBe(6_000);
    expect(first.getBudgetStatus().generalPool.settledMicros).toBe(4_000);

    // Later telemetry raises the true charge to 6,000µ: +2,000µ delta.
    const reconciled = first.reconcileLateUsage({
      callId: 'settled-then-reconciled',
      usage: usage(6_000)
    });
    expect(reconciled.incurredCostMicros).toBe(6_000);
    expect(reconciled.state).toBe('settled');

    const live = first.getBudgetStatus();
    expect(live.generalPool.reservedMicros).toBe(0);
    expect(live.generalPool.settledMicros).toBe(6_000);
    expect(live.seats.occupied).toBe(0);

    const second = new LedgerReservationManager(config);
    const report = second.recoverFromWal();
    expect(report.balanceBalanced).toBe(true);
    expect(report.recoveredDanglingCount).toBe(0);

    const recovered = second.getBudgetStatus();
    expect(recovered.generalPool.reservedMicros).toBe(live.generalPool.reservedMicros);
    expect(recovered.generalPool.settledMicros).toBe(live.generalPool.settledMicros);
    expect(recovered.generalPool.remainingMicros).toBe(live.generalPool.remainingMicros);

    const replayed = second.getSettledResult('settled-then-reconciled');
    expect(replayed?.state).toBe('settled');
    expect(replayed?.incurredCostMicros).toBe(6_000);
    // The original refund is preserved, not re-derived from the new figure.
    expect(replayed?.amountRefundedMicros).toBe(6_000);
    expect(second.getReservationByCallId('settled-then-reconciled')).toBeUndefined();
    expect(second.verifyConservationLaw().balanced).toBe(true);
  });
});

// ===========================================================================
// F5 — snapshot must carry in-flight reservations and seat identities
// ===========================================================================

describe('F5 — saveSnapshot persists active reservations and seat owners', () => {
  it('restores both, and the restored reservation remains usable for reconciliation', () => {
    const dir = makeTempDir('f5');
    const config: LedgerManagerOptions = {
      ...CONFIG,
      generalBudgetMicros: 100_000,
      maxConcurrencySeats: 2,
      storageDir: dir
    };
    const first = new LedgerReservationManager(config);

    const a = first.reserve({
      callId: 'snap-a',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 6_000,
      requiresSeat: true
    });
    const b = first.reserve({
      callId: 'snap-b',
      phase: 'compose',
      pool: 'general',
      estimatedCostMicros: 7_000,
      requiresSeat: true
    });
    expect(a.granted && b.granted).toBe(true);

    const snapshot = first.saveSnapshot();
    expect(snapshot.lastSequenceNumber).toBe(2);
    expect(snapshot.generalPool.reservedMicros).toBe(13_000);
    expect(snapshot.occupiedSeats).toBe(2);
    expect((snapshot.activeReservations ?? []).map((record) => record.callId).sort()).toEqual([
      'snap-a',
      'snap-b'
    ]);
    expect([...(snapshot.seatOwners ?? [])].sort()).toEqual(['snap-a', 'snap-b']);

    // The on-disk artefact — not just the returned object — must carry them.
    const onDisk = readSnapshot(dir);
    expect(onDisk.lastSequenceNumber).toBe(2);
    expect((onDisk.activeReservations ?? []).map((record) => record.callId).sort()).toEqual([
      'snap-a',
      'snap-b'
    ]);
    expect([...(onDisk.seatOwners ?? [])].sort()).toEqual(['snap-a', 'snap-b']);
    expect(onDisk.generalPool.reservedMicros).toBe(13_000);

    // Restart from the snapshot alone (no events after it).
    const second = new LedgerReservationManager(config);
    const report = second.recoverFromWal();
    expect(report.recoveredDanglingCount).toBe(2);
    expect(second.getBudgetStatus().generalPool.reservedMicros).toBe(13_000);
    expect(second.getBudgetStatus().seats.occupied).toBe(2);

    const restoredA = second.getReservationByCallId('snap-a');
    expect(restoredA?.reservationId).toBe(a.reservationId);
    expect(restoredA?.reservedCostMicros).toBe(6_000);
    // Crash scan marks it pending, but the record (and its money) is not lost.
    expect(restoredA?.state).toBe('pending_reconciliation');

    // The restored record is usable: its exact reservation id settles the hold.
    const reconciled = second.reconcileLateUsage({ callId: 'snap-a', usage: usage(2_000) });
    expect(reconciled.reservationId).toBe(a.reservationId);
    expect(reconciled.incurredCostMicros).toBe(2_000);
    expect(second.getBudgetStatus().generalPool.reservedMicros).toBe(7_000); // B remains
    expect(second.getBudgetStatus().generalPool.settledMicros).toBe(2_000);
    expect(second.getBudgetStatus().seats.occupied).toBe(1); // B's seat remains
    expect(second.verifyConservationLaw().balanced).toBe(true);

    // And the post-snapshot reconcile is itself replay-safe.
    const third = new LedgerReservationManager(config);
    third.recoverFromWal();
    expect(third.getBudgetStatus().generalPool.reservedMicros).toBe(7_000);
    expect(third.getBudgetStatus().generalPool.settledMicros).toBe(2_000);
    expect(third.getBudgetStatus().seats.occupied).toBe(1);
    expect(third.getReservationByCallId('snap-a')).toBeUndefined();
    expect(third.getReservationByCallId('snap-b')?.state).toBe('pending_reconciliation');
    expect(third.verifyConservationLaw().balanced).toBe(true);
  });
});

// ===========================================================================
// F6 — WAL sequence monotonicity across (repeated) recovery
// ===========================================================================

describe('F6 — recovery never rewinds the WAL sequence', () => {
  it('floors the fresh writer to the high-water mark so post-recovery events survive', () => {
    const dir = makeTempDir('f6');
    const config: LedgerManagerOptions = {
      ...CONFIG,
      generalBudgetMicros: 200_000,
      maxConcurrencySeats: 4,
      storageDir: dir
    };
    const first = new LedgerReservationManager(config);

    first.reserve({
      callId: 'snap-hold-a',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 1_000,
      requiresSeat: true
    });
    const b = first.reserve({
      callId: 'snap-settled-b',
      phase: 'compose',
      pool: 'general',
      estimatedCostMicros: 1_000,
      requiresSeat: true
    });
    first.settle({
      callId: 'snap-settled-b',
      reservationId: b.reservationId!,
      outcome: 'succeeded',
      usage: usage(100)
    });
    const snapshot = first.saveSnapshot();
    expect(snapshot.lastSequenceNumber).toBe(3);

    // An event AFTER the snapshot: it must be replayed (sequence > snapshot seq).
    const c = first.reserve({
      callId: 'post-snapshot-c',
      phase: 'reflect',
      pool: 'general',
      estimatedCostMicros: 1_000
    });
    expect(c.granted).toBe(true);

    const beforeRecovery = readWal(dir);
    const highWaterBefore = Math.max(...beforeRecovery.map((event) => event.sequenceNumber));
    expect(highWaterBefore).toBe(4);

    const second = new LedgerReservationManager(config);
    second.recoverFromWal();
    // The fresh writer must not restart at 0: it is floored to the high-water mark.
    expect(second.getWalWriter().currentSequence).toBeGreaterThanOrEqual(highWaterBefore);
    expect(second.getReservationByCallId('post-snapshot-c')).toBeDefined();

    // Recovery itself appends crash markers; they must be newer than everything
    // that existed before, or a later replay would filter them (and subsequent
    // events) out as "older than the snapshot".
    const afterRecovery = readWal(dir);
    const highWaterAfter = Math.max(...afterRecovery.map((event) => event.sequenceNumber));
    expect(highWaterAfter).toBeGreaterThan(highWaterBefore);
    expect(second.getWalWriter().currentSequence).toBe(highWaterAfter);

    // A post-recovery reservation must also stay above the high-water mark.
    const d = second.reserve({
      callId: 'after-recovery-d',
      phase: 'dream',
      pool: 'general',
      estimatedCostMicros: 1_000
    });
    expect(d.granted).toBe(true);
    expect(second.getWalWriter().currentSequence).toBeGreaterThan(highWaterAfter);

    // A second full recovery must still see the post-recovery event.
    const third = new LedgerReservationManager(config);
    const report = third.recoverFromWal();
    expect(report.balanceBalanced).toBe(true);
    // D was still in flight when the second recovery ran, so it is the call the
    // second recovery saw as dangling. (A and C were already converged to
    // `pending_reconciliation` by the crash markers replayed above.)
    expect(report.recoveredCallIds).toContain('after-recovery-d');
    expect(third.getReservationByCallId('after-recovery-d')).toBeDefined();
    // All three holds survive as unresolved reservations: no record was dropped.
    for (const callId of ['snap-hold-a', 'post-snapshot-c', 'after-recovery-d']) {
      expect(third.getReservationByCallId(callId)?.state).toBe('pending_reconciliation');
    }
    expect(third.getBudgetStatus().generalPool.reservedMicros).toBe(3_000);
    expect(third.verifyConservationLaw().balanced).toBe(true);

    // No duplicated or backwards sequence numbers anywhere in the durable log.
    const sequences = readWal(dir).map((event) => event.sequenceNumber);
    expect(new Set(sequences).size).toBe(sequences.length);
    for (let index = 1; index < sequences.length; index += 1) {
      expect(sequences[index]!).toBeGreaterThan(sequences[index - 1]!);
    }
  });
});

// ===========================================================================
// F7 — conservation check detects reservation-table / pool disagreement
// ===========================================================================

describe('F7 — conservation rejects a pool that disagrees with the reservation table', () => {
  it('detects money reserved by the pool with no backing reservation record', () => {
    const dir = makeTempDir('f7-pool-only');
    // Forged state: the pool claims 5,000µ reserved, the table holds no record.
    writeSnapshot(dir, forgedSnapshot({ generalReservedMicros: 5_000 }));

    const manager = new LedgerReservationManager({ ...CONFIG, storageDir: dir });
    const error = captureLedgerError(() => manager.recoverFromWal());
    expect(error.code).toBe('LEDGER_BALANCE_MISMATCH');
    expect(error.message).toMatch(/reservation mismatch/i);
  });

  it('detects a reservation record with no money reserved by the pool', () => {
    const dir = makeTempDir('f7-record-only');
    const orphanRecord: ReservationRecord = {
      reservationId: 'res_forged_orphan',
      callId: 'forged-orphan',
      phase: 'probe',
      pool: 'general',
      reservedCostMicros: 5_000,
      seatAcquired: false,
      createdAt: 1_700_000_000_000,
      state: 'active'
    };
    // Forged state: the table holds a 5,000µ record, the pool reserved 0.
    writeSnapshot(
      dir,
      forgedSnapshot({ generalReservedMicros: 0, activeReservations: [orphanRecord] })
    );

    const manager = new LedgerReservationManager({ ...CONFIG, storageDir: dir });
    const error = captureLedgerError(() => manager.recoverFromWal());
    expect(error.code).toBe('LEDGER_BALANCE_MISMATCH');
    expect(error.message).toMatch(/reservation mismatch/i);
  });

  it('accepts a consistent snapshot, so the throw above is attributable to the mismatch', () => {
    const dir = makeTempDir('f7-control');
    const consistentRecord: ReservationRecord = {
      reservationId: 'res_forged_live',
      callId: 'forged-live',
      phase: 'probe',
      pool: 'general',
      reservedCostMicros: 5_000,
      seatAcquired: false,
      createdAt: 1_700_000_000_000,
      state: 'active'
    };
    writeSnapshot(
      dir,
      forgedSnapshot({ generalReservedMicros: 5_000, activeReservations: [consistentRecord] })
    );

    const manager = new LedgerReservationManager({ ...CONFIG, storageDir: dir });
    const report = manager.recoverFromWal();
    expect(report.balanceBalanced).toBe(true);
    expect(report.recoveredDanglingCount).toBe(1);
    expect(manager.getBudgetStatus().generalPool.reservedMicros).toBe(5_000);
    expect(manager.getReservationByCallId('forged-live')?.state).toBe('pending_reconciliation');
    expect(manager.verifyConservationLaw().balanced).toBe(true);
  });
});

// ===========================================================================
// F8 — no zero write-off; rate card time-freeze
// ===========================================================================

describe('F8 — reconcile cannot write a charge off to zero', () => {
  it('applies the conservative floor to actualCostMicros=0 without usage', () => {
    const manager = createManager({
      generalBudgetMicros: 100_000,
      storageDir: makeTempDir('f8-floor')
    });

    const res = manager.reserve({
      callId: 'zero-reconcile',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 20_000
    });
    manager.settle({
      callId: 'zero-reconcile',
      reservationId: res.reservationId!,
      outcome: 'timed_out_local',
      actualCostMicros: 0,
      interim: true
    });
    // Interim keeps the full reservation: nothing has been booked yet.
    expect(manager.getBudgetStatus().generalPool.reservedMicros).toBe(20_000);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(0);

    const reconciled = manager.reconcileLateUsage({
      callId: 'zero-reconcile',
      actualCostMicros: 0
      // no usage payload: 0 here is an absence of evidence, not a free call
    });

    expect(reconciled.incurredCostMicros).toBe(1_000); // conservative floor
    expect(reconciled.incurredCostMicros).toBeGreaterThan(0);
    expect(reconciled.ledgerEvent?.cost.provenance).toBe('unknown');
    expect(reconciled.ledgerEvent?.cost.conservative).toBe(true);
    expect(reconciled.ledgerEvent?.cost.breakdown.conservativeSurchargeMicros).toBe(1_000);

    const status = manager.getBudgetStatus();
    expect(status.generalPool.reservedMicros).toBe(0);
    expect(status.generalPool.settledMicros).toBe(1_000); // NOT 0
    expect(status.generalPool.remainingMicros).toBe(99_000);
    expect(manager.verifyConservationLaw().balanced).toBe(true);
  });

  it('freezes the reserve-time rate card: a later expensive card cannot reprice the call', () => {
    const manager = createManager({
      generalBudgetMicros: 100_000,
      // The manager's default is 10x more expensive than the card A froze.
      defaultRateCard: LATER_EXPENSIVE_RATE,
      storageDir: makeTempDir('f8-freeze')
    });

    const a = manager.reserve({
      callId: 'frozen-price',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 10_000,
      rateCard: RATE
    });
    manager.settle({
      callId: 'frozen-price',
      reservationId: a.reservationId!,
      outcome: 'timed_out_local',
      actualCostMicros: 0,
      interim: true
    });
    // No card is passed here: the frozen RATE (1µ/token) must win over the
    // manager default (10µ/token) and over its 20,000µ floor.
    const implicit = manager.reconcileLateUsage({ callId: 'frozen-price', usage: usage(500) });
    expect(implicit.incurredCostMicros).toBe(500);

    const b = manager.reserve({
      callId: 'frozen-price-explicit',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 10_000,
      rateCard: RATE
    });
    manager.settle({
      callId: 'frozen-price-explicit',
      reservationId: b.reservationId!,
      outcome: 'timed_out_local',
      actualCostMicros: 0,
      interim: true
    });
    // Even when the caller actively passes the new card, the snapshot wins.
    const explicit = manager.reconcileLateUsage({
      callId: 'frozen-price-explicit',
      usage: usage(500),
      rateCard: LATER_EXPENSIVE_RATE
    });
    expect(explicit.incurredCostMicros).toBe(500);

    const status = manager.getBudgetStatus();
    expect(status.generalPool.settledMicros).toBe(1_000); // 500 + 500
    expect(status.generalPool.reservedMicros).toBe(0);
    expect(manager.verifyConservationLaw().balanced).toBe(true);
  });
});

// ===========================================================================
// F9 — repeated reconcile is accounting-idempotent
// ===========================================================================

describe('F9 — a repeated reconcile books nothing twice', () => {
  it('does not re-book the settled delta or the refund on a repeated non-interim reconcile', () => {
    const manager = createManager({
      generalBudgetMicros: 100_000,
      storageDir: makeTempDir('f9-settled')
    });

    const res = manager.reserve({
      callId: 'repeat-reconcile',
      phase: 'compose',
      pool: 'general',
      estimatedCostMicros: 10_000
    });
    manager.settle({
      callId: 'repeat-reconcile',
      reservationId: res.reservationId!,
      outcome: 'succeeded',
      usage: usage(4_000)
    });

    const first = manager.reconcileLateUsage({ callId: 'repeat-reconcile', usage: usage(6_000) });
    expect(first.incurredCostMicros).toBe(6_000);
    const afterFirst = manager.getBudgetStatus();
    const eventsAfterFirst = manager.getLedgerEvents().length;
    expect(afterFirst.generalPool.settledMicros).toBe(6_000);
    expect(afterFirst.generalPool.remainingMicros).toBe(94_000);

    const second = manager.reconcileLateUsage({ callId: 'repeat-reconcile', usage: usage(6_000) });
    expect(second.incurredCostMicros).toBe(6_000);
    // Identical pool state: no second delta, no second refund.
    expect(manager.getBudgetStatus()).toEqual(afterFirst);
    expect(manager.getLedgerEvents().length).toBeGreaterThan(eventsAfterFirst); // audit trail grows
    expect(manager.verifyConservationLaw().balanced).toBe(true);
  });

  it('records an overdraft variance once, even when reconcile is repeated', () => {
    const manager = createManager({
      generalBudgetMicros: 100_000,
      storageDir: makeTempDir('f9-overdraft')
    });

    const res = manager.reserve({
      callId: 'overdraft-reconcile',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 1_000
    });
    manager.settle({
      callId: 'overdraft-reconcile',
      reservationId: res.reservationId!,
      outcome: 'timed_out_local',
      actualCostMicros: 0,
      interim: true
    });

    // Truth: 200,000µ spent against a 100,000µ pool → 100,000µ overdraft.
    const first = manager.reconcileLateUsage({
      callId: 'overdraft-reconcile',
      actualCostMicros: 200_000
    });
    expect(first.incurredCostMicros).toBe(200_000);
    const afterFirst = manager.getBudgetStatus();
    expect(afterFirst.generalPool.settledMicros).toBe(200_000);
    expect(afterFirst.generalPool.remainingMicros).toBe(0);
    expect(afterFirst.generalPool.overdraftMicros).toBe(100_000);
    expect(manager.getOverdraftVariances()).toHaveLength(1);

    const second = manager.reconcileLateUsage({
      callId: 'overdraft-reconcile',
      actualCostMicros: 200_000
    });
    expect(second.incurredCostMicros).toBe(200_000);
    // No duplicate variance, no duplicate booking.
    expect(manager.getOverdraftVariances()).toHaveLength(1);
    expect(manager.getBudgetStatus()).toEqual(afterFirst);
    expect(manager.verifyConservationLaw()).toMatchObject({
      balanced: true,
      overdrawn: true,
      overdraftVarianceMicros: 100_000
    });
  });
});