/**
 * PR-3A acceptance tests — ADR-0004 §10.2 matrix (3A-M1 … 3A-M5).
 *
 * These cover the four PR-3A capabilities that previously had NO test at all
 * despite being implemented:
 *   - the lossless raw-usage bypass through the model bridge (3A-M1);
 *   - real cancellation with truthful incurred spend and audit-only marking (3A-M3);
 *   - two-stage late-usage reconciliation (3A-M4);
 *   - WAL crash recovery of dangling reservations + conservation law (3A-M5).
 *
 * Gaps these tests were written to close (found by a coverage audit on
 * 2026-10-27): `reconcileLateUsage`, `recoverFromWal`, `verifyConservationLaw`,
 * `RawUsageCarrier`/`onRawUsage`, `LedgerWalWriter`, `interrupted_by_crash` and
 * `pending_reconciliation` had ZERO references anywhere under `tests/`.
 *
 * Everything is offline and deterministic: no network, no real model call, no
 * paid API (ADR-0004 R0). Filesystem use is confined to a temp directory.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LedgerReservationManager } from '../../../src/ledger/reservation-manager.js';
import { LedgerWalWriter } from '../../../src/ledger/wal.js';
import {
  dshUsageToProviderPayload,
  createUsagePayload,
  DEFAULT_DSH_COUNTING_SEMANTICS
} from '../../../src/ledger/pricing.js';
import type { ModelRateCard } from '../../../src/ledger/types.js';
import {
  DEFAULT_DSH_COUNTING_SEMANTICS as BRIDGE_SEMANTICS,
  DEFAULT_DSH_ROUTE,
  RawUsageCarrier,
  createLlmModelAdapter,
  drainDshStream
} from '../../../src/dsh-bridge/model.js';

const RATE_CARD: ModelRateCard = {
  modelId: 't6-acceptance-card',
  inputRatePerMillion: 1_000_000, // 1u per token
  outputRatePerMillion: 2_000_000, // 2u per token
  reasoningSeparatelyBilled: false,
  conservativeFallbackCostMicros: 10_000
};

function makeManager(overrides: Partial<{ general: number; verification: number; seats: number }> = {}) {
  return new LedgerReservationManager({
    generalBudgetMicros: overrides.general ?? 1_000_000,
    verificationReserveMicros: overrides.verification ?? 500_000,
    maxConcurrencySeats: overrides.seats ?? 4,
    defaultRateCard: RATE_CARD
  });
}

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't6-ledger-'));
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

// ---------------------------------------------------------------------------
// 3A-M1 — lossless raw usage bypass
// ---------------------------------------------------------------------------
describe('3A-M1 raw-usage bypass preserves 6 fields while TokenUsage stays 3', () => {
  it('captures cacheRead/cacheWrite/reasoning that the frozen TokenUsage discards', () => {
    // A usage record with the three "extra" fields the frozen shape cannot hold.
    const raw = {
      inputTokens: 1_000,
      outputTokens: 400,
      totalTokens: 1_900,
      cacheReadTokens: 500,
      cacheWriteTokens: 100,
      reasoningTokens: 200
    };

    const payload = dshUsageToProviderPayload(raw, DEFAULT_DSH_COUNTING_SEMANTICS);

    // All six fields survive the bypass (the frozen TokenUsage would keep only 3).
    expect(payload.inputTokens?.tokens).toBe(1_000);
    expect(payload.outputTokens?.tokens).toBe(400);
    expect(payload.cacheReadTokens?.tokens).toBe(500);
    expect(payload.cacheWriteTokens?.tokens).toBe(100);
    expect(payload.reasoningTokens?.tokens).toBe(200);
    expect(payload.totalTokens?.tokens).toBe(1_900);
    // Semantics are carried explicitly, never inferred.
    expect(payload.countingSemantics?.inputIncludesCacheRead).toBe(true);
    expect(payload.countingSemantics?.outputIncludesReasoning).toBe(true);
  });

  it('does not synthesise fields that the provider did not report', () => {
    const payload = dshUsageToProviderPayload({ inputTokens: 10, outputTokens: 5 });
    expect(payload.cacheReadTokens).toBeUndefined();
    expect(payload.cacheWriteTokens).toBeUndefined();
    expect(payload.reasoningTokens).toBeUndefined();
    expect(payload.totalTokens).toBeUndefined();
  });

  it('marks missing input/output as unknown rather than assuming zero measurements', () => {
    const payload = dshUsageToProviderPayload({ cacheReadTokens: 7 });
    expect(payload.inputTokens?.precision).toBe('unknown');
    expect(payload.outputTokens?.precision).toBe('unknown');
    expect(payload.cacheReadTokens?.precision).toBe('measured');
  });

  it('invokes the bypass listener with the carrier and callId on a usage chunk', async () => {
    const received: Array<{ carrier: RawUsageCarrier; callId: string }> = [];

    // The bypass is wired in `createLlmModelAdapter.complete()`, not in
    // `drainDshStream` (which only *returns* the raw usage). So drive the
    // adapter with a fake host ctx whose `llm.stream` is our chunk source.
    const ctx = {
      llm: {
        stream: async function* () {
          yield { type: 'text-delta', index: 0, text: 'hello' };
          yield {
            type: 'usage',
            usage: {
              inputTokens: 1_000,
              outputTokens: 400,
              totalTokens: 1_900,
              cacheReadTokens: 500,
              reasoningTokens: 200
            }
          };
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      }
    };

    const adapter = createLlmModelAdapter(ctx, DEFAULT_DSH_ROUTE, {
      onRawUsage: (carrier: RawUsageCarrier, callId: string) => {
        received.push({ carrier, callId });
      }
    });

    const response = await adapter.complete({
      purpose: 'probe',
      messages: [{ role: 'user', content: 'hi' }],
      metadata: { callId: 'bypass-call-1' }
    });

    expect(received).toHaveLength(1);
    const { carrier, callId } = received[0]!;
    expect(callId).toBe('bypass-call-1');
    // The carrier preserves the un-truncated telemetry.
    expect(carrier.rawUsage?.cacheReadTokens).toBe(500);
    expect(carrier.rawUsage?.reasoningTokens).toBe(200);
    expect(carrier.countingSemantics).toEqual(BRIDGE_SEMANTICS);
    expect(typeof carrier.completedAtMs).toBe('number');

    // Meanwhile the legacy surface still exposes only the frozen 3-field shape.
    expect(response.usage).toBeDefined();
    expect(Object.keys(response.usage!).sort()).toEqual(['inputTokens', 'outputTokens', 'totalTokens']);
    expect(response.usage!.inputTokens).toBe(1_000);
  });

  it('a listener that throws does not break the model call', async () => {
    const ctx = {
      llm: {
        stream: async function* () {
          yield { type: 'text-delta', index: 0, text: 'ok' };
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      }
    };

    const adapter = createLlmModelAdapter(ctx, DEFAULT_DSH_ROUTE, {
      onRawUsage: () => {
        throw new Error('listener exploded');
      }
    });

    const response = await adapter.complete({ purpose: 'probe', messages: [{ role: 'user', content: 'hi' }] });
    expect(response.text).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// 3A-M2 — counting-semantics de-duplication
// ---------------------------------------------------------------------------
describe('3A-M2 counting semantics prevent double billing', () => {
  it('deducts cacheRead from input when inputIncludesCacheRead is true', () => {
    const usage = createUsagePayload({
      input: 1_000,
      output: 0,
      cacheRead: 400,
      semantics: { inputIncludesCacheRead: true, outputIncludesReasoning: false }
    });
    // net input = 1000 - 400 = 600 tokens at 1u each
    expect(usage.inputTokens?.tokens).toBe(1_000);
    expect(usage.cacheReadTokens?.tokens).toBe(400);
  });

  it('does not deduct cacheRead when inputIncludesCacheRead is false', () => {
    const usage = createUsagePayload({
      input: 1_000,
      output: 0,
      cacheRead: 400,
      semantics: { inputIncludesCacheRead: false, outputIncludesReasoning: false }
    });
    expect(usage.inputTokens?.tokens).toBe(1_000);
    expect(usage.countingSemantics?.inputIncludesCacheRead).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3A-M3 — real cancellation with incurred spend, audit-only
// ---------------------------------------------------------------------------
describe('3A-M3 cancellation records real spend but is audit-only', () => {
  it('charges the tokens produced before the abort and marks auditOnly/qualityEvidence=false', () => {
    const manager = makeManager({ general: 1_000_000 });
    const res = manager.reserve({
      callId: 'cancel-mid-flight',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 50_000,
      requiresSeat: true
    });
    expect(res.granted).toBe(true);

    // The model produced 3,000 output tokens before the cancel landed.
    const settle = manager.settle({
      callId: 'cancel-mid-flight',
      reservationId: res.reservationId!,
      outcome: 'aborted_confirmed',
      usage: createUsagePayload({ input: 0, output: 3_000, semantics: DEFAULT_DSH_COUNTING_SEMANTICS }),
      rateCard: RATE_CARD
    });

    // Money is charged truthfully: 3,000 x 2u = 6,000u incurred.
    expect(settle.incurredCostMicros).toBeGreaterThan(0);
    expect(settle.incurredCostMicros).toBe(6_000);
    // ... but spend is NOT quality evidence.
    expect(settle.auditOnly).toBe(true);
    expect(settle.qualityEvidence).toBe(false);
    expect(settle.ledgerEvent?.outcome).toBe('aborted_confirmed');
    expect(settle.ledgerEvent?.auditOnly).toBe(true);
  });

  it('distinguishes local abandonment from confirmed remote termination', () => {
    const manager = makeManager();
    const res = manager.reserve({
      callId: 'local-abandon',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 10_000
    });
    const settle = manager.settle({
      callId: 'local-abandon',
      reservationId: res.reservationId!,
      outcome: 'aborted_local',
      actualCostMicros: 2_000
    });
    expect(settle.ledgerEvent?.outcome).toBe('aborted_local');
    expect(settle.auditOnly).toBe(true);
    expect(settle.qualityEvidence).toBe(false);
  });

  it('a successful call IS quality evidence, proving auditOnly is not hardcoded', () => {
    const manager = makeManager();
    const res = manager.reserve({
      callId: 'success-call',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 10_000
    });
    const settle = manager.settle({
      callId: 'success-call',
      reservationId: res.reservationId!,
      outcome: 'succeeded',
      usage: createUsagePayload({ input: 100, output: 100, semantics: DEFAULT_DSH_COUNTING_SEMANTICS }),
      rateCard: RATE_CARD
    });
    expect(settle.auditOnly).toBe(false);
    expect(settle.qualityEvidence).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3A-M4 — late-arriving usage, two-stage reconciliation
// ---------------------------------------------------------------------------
describe('3A-M4 late-arriving usage is reconciled without double deduction', () => {
  it('tops up the pool by the delta when real cost exceeds the reservation', () => {
    const manager = makeManager({ general: 1_000_000 });
    const res = manager.reserve({
      callId: 'late-usage',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 5_000,
      requiresSeat: true
    });

    // Stage 1: local timeout. Interim settlement keeps the reservation locked.
    const interim = manager.settle({
      callId: 'late-usage',
      reservationId: res.reservationId!,
      outcome: 'timed_out_local',
      actualCostMicros: 0,
      interim: true,
      releaseSeat: false
    });
    expect(interim.state).toBe('interim_settled');
    // The reserved amount is NOT released while reconciliation is pending.
    expect(manager.getBudgetStatus().generalPool.reservedMicros).toBe(5_000);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(0);

    // Stage 2: the truth arrives late — actual spend was 10,000u (5,000 over).
    // `reconcileLateUsage` takes a precomputed `actualCostMicros` directly (it
    // does not apply the conservative floor that a usage-less `settle` would).
    const reconciled = manager.reconcileLateUsage({
      callId: 'late-usage',
      actualCostMicros: 10_000,
      rateCard: RATE_CARD
    });
    expect(reconciled.incurredCostMicros).toBe(10_000);
    expect(reconciled.state).toBe('settled');

    const status = manager.getBudgetStatus();
    // Settled by the TRUE amount, reservation released, no double charge.
    expect(status.generalPool.settledMicros).toBe(10_000);
    expect(status.generalPool.reservedMicros).toBe(0);
    expect(status.generalPool.remainingMicros).toBe(1_000_000 - 10_000);

    // The reconciliation is durably recorded.
    const walTypes = manager.getWalWriter().readAllEvents().map((e) => e.type);
    expect(walTypes).toContain('EVENT_RECONCILED');
  });

  it('refunds the difference when real cost is lower than the reservation', () => {
    const manager = makeManager({ general: 1_000_000 });
    const res = manager.reserve({
      callId: 'late-cheap',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 50_000
    });
    manager.settle({
      callId: 'late-cheap',
      reservationId: res.reservationId!,
      outcome: 'timed_out_local',
      actualCostMicros: 0,
      interim: true
    });

    const reconciled = manager.reconcileLateUsage({
      callId: 'late-cheap',
      actualCostMicros: 20_000,
      rateCard: RATE_CARD
    });

    expect(reconciled.incurredCostMicros).toBe(20_000);
    expect(reconciled.amountRefundedMicros).toBe(30_000);
    expect(manager.getBudgetStatus().generalPool.remainingMicros).toBe(1_000_000 - 20_000);
  });

  it('rejects reconciliation for a callId that was never reserved', () => {
    const manager = makeManager();
    expect(() => manager.reconcileLateUsage({ callId: 'ghost-call', actualCostMicros: 1 })).toThrow(
      /CALL_NOT_FOUND/
    );
  });

  it('records an overdraft variance instead of locking when late usage exceeds the whole budget', () => {
    // Regression guard for the t6 repair: `generalRemainingMicros` is clamped at
    // 0, so the old `if (rem < 0)` overdraft branch was unreachable and a real
    // overspend tripped the conservation law, hard-locking the ledger.
    const manager = makeManager({ general: 100_000 });
    const res = manager.reserve({
      callId: 'overspend',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 1_000
    });
    manager.settle({
      callId: 'overspend',
      reservationId: res.reservationId!,
      outcome: 'timed_out_local',
      actualCostMicros: 0,
      interim: true
    });

    // Truth: 200,000u spent against a 100,000u budget.
    manager.reconcileLateUsage({ callId: 'overspend', actualCostMicros: 200_000, rateCard: RATE_CARD });

    const status = manager.getBudgetStatus();
    expect(status.generalPool.settledMicros).toBe(200_000);
    // The overspend is preserved and visible, not floored away.
    expect(status.generalPool.remainingMicros).toBe(0);
    expect(status.generalPool.overdraftMicros).toBe(100_000);
    expect(manager.overdraftVarianceMicros).toBe(100_000);
    expect(manager.isOverdrawn).toBe(true);
    expect(manager.getOverdraftVariances()).toHaveLength(1);
    expect(manager.getOverdraftVariances()[0]!.pool).toBe('general');

    // The ledger stays operational: the identity holds rather than throwing.
    const law = manager.verifyConservationLaw();
    expect(law.balanced).toBe(true);
    expect(law.overdrawn).toBe(true);
    expect(law.overdraftVarianceMicros).toBe(100_000);

    // But new spending is still fail-closed.
    const blocked = manager.reserve({
      callId: 'after-overspend',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 1
    });
    expect(blocked.granted).toBe(false);
    expect(blocked.rejectionReason).toBe('insufficient_budget');
  });
});

// ---------------------------------------------------------------------------
// 3A-M5 — WAL crash recovery and dangling reservations
// ---------------------------------------------------------------------------
describe('3A-M5 WAL crash recovery', () => {
  it('appends an append-only, sequence-numbered event log', () => {
    const dir = makeTempDir();
    const manager = new LedgerReservationManager({
      generalBudgetMicros: 1_000_000,
      verificationReserveMicros: 100_000,
      maxConcurrencySeats: 2,
      defaultRateCard: RATE_CARD,
      storageDir: dir
    });
    const res = manager.reserve({
      callId: 'wal-call',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 1_000,
      requiresSeat: true
    });
    manager.settle({
      callId: 'wal-call',
      reservationId: res.reservationId!,
      outcome: 'succeeded',
      actualCostMicros: 500
    });

    const eventsPath = manager.getWalWriter().eventsPath!;
    expect(fs.existsSync(eventsPath)).toBe(true);
    const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);

    const seqs = lines.map((line) => JSON.parse(line).sequenceNumber);
    // Monotonically increasing sequence numbers.
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
    const types = lines.map((line) => JSON.parse(line).type);
    expect(types).toContain('EVENT_RESERVED');
    expect(types).toContain('EVENT_SETTLED');
  });

  it('replays settled state from the WAL and conserves the budget', () => {
    const dir = makeTempDir();
    const config = {
      generalBudgetMicros: 1_000_000,
      verificationReserveMicros: 100_000,
      maxConcurrencySeats: 2,
      defaultRateCard: RATE_CARD,
      storageDir: dir
    };

    // NOTE: `actualCostMicros` WITHOUT a usage payload is deliberately floored to
    // the conservative ceiling (ADR-0004 §3.4 S5). To assert exact replay of a
    // specific amount we must settle through the rate card with real usage.
    const first = new LedgerReservationManager(config);
    const a = first.reserve({ callId: 'c-a', phase: 'probe', pool: 'general', estimatedCostMicros: 10_000, requiresSeat: true });
    first.settle({
      callId: 'c-a',
      reservationId: a.reservationId!,
      outcome: 'succeeded',
      usage: createUsagePayload({ input: 4_000, output: 0, semantics: DEFAULT_DSH_COUNTING_SEMANTICS }),
      rateCard: RATE_CARD
    }); // 4,000 tokens x 1u = 4,000u
    const b = first.reserve({ callId: 'c-b', phase: 'judge', pool: 'verification', estimatedCostMicros: 10_000, requiresSeat: true });
    first.settle({
      callId: 'c-b',
      reservationId: b.reservationId!,
      outcome: 'succeeded',
      usage: createUsagePayload({ input: 6_000, output: 0, semantics: DEFAULT_DSH_COUNTING_SEMANTICS }),
      rateCard: RATE_CARD
    }); // 6,000 tokens x 1u = 6,000u

    expect(first.getBudgetStatus().generalPool.settledMicros).toBe(4_000);

    // Simulate a restart: a brand-new manager over the same storage dir.
    const second = new LedgerReservationManager(config);
    const report = second.recoverFromWal();

    expect(report.replayedEventsCount).toBeGreaterThan(0);
    expect(report.balanceBalanced).toBe(true);

    const status = second.getBudgetStatus();
    expect(status.generalPool.settledMicros).toBe(4_000);
    expect(status.verificationPool.settledMicros).toBe(6_000);
    expect(status.seats.occupied).toBe(0);
    // Idempotent settle survived the restart.
    expect(second.getSettledResult('c-a')?.incurredCostMicros).toBe(4_000);
  });

  it('marks dangling reservations as interrupted_by_crash without inventing a cost', () => {
    const dir = makeTempDir();
    const config = {
      generalBudgetMicros: 1_000_000,
      verificationReserveMicros: 100_000,
      maxConcurrencySeats: 4,
      defaultRateCard: RATE_CARD,
      storageDir: dir
    };

    const first = new LedgerReservationManager(config);
    // 10 completed settlements of 500u each.
    for (let i = 0; i < 10; i += 1) {
      const r = first.reserve({
        callId: `done-${i}`,
        phase: 'probe',
        pool: 'general',
        estimatedCostMicros: 1_000,
        requiresSeat: true
      });
      first.settle({
        callId: `done-${i}`,
        reservationId: r.reservationId!,
        outcome: 'succeeded',
        usage: createUsagePayload({ input: 500, output: 0, semantics: DEFAULT_DSH_COUNTING_SEMANTICS }),
        rateCard: RATE_CARD
      }); // 500u each
    }
    // 2 reservations that never settled (the crash victims).
    first.reserve({ callId: 'hanging-1', phase: 'probe', pool: 'general', estimatedCostMicros: 7_000, requiresSeat: true });
    first.reserve({ callId: 'hanging-2', phase: 'probe', pool: 'general', estimatedCostMicros: 9_000, requiresSeat: true });

    const second = new LedgerReservationManager(config);
    const report = second.recoverFromWal();

    expect(report.recoveredDanglingCount).toBe(2);
    expect([...report.recoveredCallIds].sort()).toEqual(['hanging-1', 'hanging-2']);
    // ADR-0004 §5.1/§6.2: a crash is not proof the provider stopped. The two
    // risk seats stay held (and recoverable), never silently returned.
    expect(report.occupiedSeats).toBe(2);

    for (const callId of ['hanging-1', 'hanging-2']) {
      const record = second.getReservationByCallId(callId);
      expect(record?.state).toBe('pending_reconciliation');
      // ADR-0004 §6.2: actual cost is UNKNOWN, never assumed to be 0.
      expect(record?.incurredCostMicros).toBeNull();
    }

    // The money stays held pending the true terminal state.
    const status = second.getBudgetStatus();
    expect(status.generalPool.settledMicros).toBe(5_000); // 10 x 500
    expect(status.generalPool.reservedMicros).toBe(16_000); // 7_000 + 9_000 still held
    expect(status.seats.occupied).toBe(2);

    // A later confirmed termination can release each retained risk seat once.
    expect(second.releaseSeat('hanging-1')).toBe(true);
    expect(second.releaseSeat('hanging-2')).toBe(true);
    expect(second.releaseSeat('hanging-2')).toBe(false);
    expect(second.getBudgetStatus().seats.occupied).toBe(0);

    // The recovery is recorded durably.
    const types = second.getWalWriter().readAllEvents().map((e) => e.type);
    expect(types).toContain('EVENT_CRASH_RECOVERED');
  });

  it('is idempotent: recovering twice does not double-charge or leak seats', () => {
    const dir = makeTempDir();
    const config = {
      generalBudgetMicros: 1_000_000,
      verificationReserveMicros: 100_000,
      maxConcurrencySeats: 4,
      defaultRateCard: RATE_CARD,
      storageDir: dir
    };

    const first = new LedgerReservationManager(config);
    const r = first.reserve({ callId: 'dangling', phase: 'probe', pool: 'general', estimatedCostMicros: 5_000, requiresSeat: true });
    expect(r.granted).toBe(true);

    const second = new LedgerReservationManager(config);
    const report1 = second.recoverFromWal();
    const after1 = JSON.stringify(second.getBudgetStatus());

    // The first recovery already converged the dangling reservation to
    // `pending_reconciliation` and appended EVENT_CRASH_RECOVERED. Replaying that
    // event again must NOT produce a second "newly recovered" reservation, and
    // must not double-charge or leak a seat.
    const report2 = second.recoverFromWal();
    const after2 = JSON.stringify(second.getBudgetStatus());

    expect(report1.recoveredDanglingCount).toBe(1);
    expect(report2.recoveredDanglingCount).toBe(0); // already converged, idempotent
    // No drift: the second recovery reproduces identical pool state, including
    // the retained risk seat (not 0: crash is not remote-termination proof).
    expect(after2).toBe(after1);
    expect(second.getBudgetStatus().generalPool.settledMicros).toBe(0);
    expect(second.getBudgetStatus().seats.occupied).toBe(1);
    // The reservation is still unresolved (not silently written off).
    expect(second.getReservationByCallId('dangling')?.state).toBe('pending_reconciliation');
    expect(second.verifyConservationLaw().balanced).toBe(true);
  });

  it('late usage clears the interim retained-seat handle and cannot free another call seat', () => {
    const dir = makeTempDir();
    const manager = new LedgerReservationManager({
      generalBudgetMicros: 1_000_000,
      verificationReserveMicros: 100_000,
      maxConcurrencySeats: 1,
      defaultRateCard: RATE_CARD,
      storageDir: dir
    });

    const a = manager.reserve({
      callId: 'interim-a',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 1_000,
      requiresSeat: true
    });
    expect(a.reservationId).toBeDefined();
    manager.settle({
      callId: 'interim-a',
      reservationId: a.reservationId!,
      outcome: 'timed_out_local',
      actualCostMicros: 0,
      interim: true
    });
    expect(manager.getSeatsPendingRemote()).toEqual(['interim-a']);

    const reconciled = manager.reconcileLateUsage({ callId: 'interim-a', actualCostMicros: 1_000 });
    expect(reconciled.seatReleased).toBe(true);
    // The handle MUST be gone with the seat. Otherwise releaseSeat('interim-a')
    // later decrements occupiedSeats a second time and frees another live call.
    expect(manager.getSeatsPendingRemote()).toEqual([]);
    expect(manager.getBudgetStatus().seats.occupied).toBe(0);

    const b = manager.reserve({
      callId: 'live-b',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 1_000,
      requiresSeat: true
    });
    expect(b.granted).toBe(true);
    expect(manager.getBudgetStatus().seats.occupied).toBe(1);

    expect(manager.releaseSeat('interim-a')).toBe(false);
    expect(manager.getBudgetStatus().seats.occupied).toBe(1);
    const c = manager.reserve({
      callId: 'live-c',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 1_000,
      requiresSeat: true
    });
    expect(c.granted).toBe(false);
    expect(c.rejectionReason).toBe('insufficient_seats');
  });

  it('an interim seat released before reconcile is not released a second time', () => {
    const dir = makeTempDir();
    const manager = new LedgerReservationManager({
      generalBudgetMicros: 100_000,
      verificationReserveMicros: 100_000,
      maxConcurrencySeats: 2,
      defaultRateCard: RATE_CARD,
      storageDir: dir
    });
    const a = manager.reserve({
      callId: 'early-release-a',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 1_000,
      requiresSeat: true
    });
    manager.settle({
      callId: 'early-release-a',
      reservationId: a.reservationId!,
      outcome: 'timed_out_local',
      actualCostMicros: 0,
      interim: true
    });
    expect(manager.getBudgetStatus().seats.occupied).toBe(1);
    expect(manager.releaseSeat('early-release-a')).toBe(true);
    expect(manager.getBudgetStatus().seats.occupied).toBe(0);

    const b = manager.reserve({
      callId: 'live-b-early',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 1_000,
      requiresSeat: true
    });
    expect(b.granted).toBe(true);
    expect(manager.getBudgetStatus().seats.occupied).toBe(1);

    const reconciled = manager.reconcileLateUsage({ callId: 'early-release-a', actualCostMicros: 1_000 });
    expect(reconciled.seatReleased).toBe(false);
    // B's seat must still be occupied; A's earlier release is final.
    expect(manager.getBudgetStatus().seats.occupied).toBe(1);
    expect(manager.releaseSeat('early-release-a')).toBe(false);
  });

  it('replays a non-interim reconciliation with the corrected settled amount', () => {
    const dir = makeTempDir();
    const config = {
      generalBudgetMicros: 100_000,
      verificationReserveMicros: 100_000,
      maxConcurrencySeats: 1,
      defaultRateCard: RATE_CARD,
      storageDir: dir
    };
    const first = new LedgerReservationManager(config);
    const res = first.reserve({
      callId: 'final-reconcile',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 1_000,
      requiresSeat: true
    });
    first.settle({
      callId: 'final-reconcile',
      reservationId: res.reservationId!,
      outcome: 'succeeded',
      usage: createUsagePayload({ input: 800, output: 0, semantics: DEFAULT_DSH_COUNTING_SEMANTICS })
    });
    first.reconcileLateUsage({
      callId: 'final-reconcile',
      usage: createUsagePayload({ input: 1_200, output: 0, semantics: DEFAULT_DSH_COUNTING_SEMANTICS })
    });

    const second = new LedgerReservationManager(config);
    second.recoverFromWal();
    expect(second.getBudgetStatus().generalPool.settledMicros).toBe(1_200);
    expect(second.getSettledResult('final-reconcile')?.incurredCostMicros).toBe(1_200);
    expect(second.getBudgetStatus().seats.occupied).toBe(0);
  });

  it('preserves audit/quality flags across WAL replay', () => {
    const dir = makeTempDir();
    const config = {
      generalBudgetMicros: 100_000,
      verificationReserveMicros: 100_000,
      maxConcurrencySeats: 1,
      defaultRateCard: RATE_CARD,
      storageDir: dir
    };
    const first = new LedgerReservationManager(config);
    const res = first.reserve({
      callId: 'audit-flags',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 1_000,
      requiresSeat: true
    });
    first.settle({
      callId: 'audit-flags',
      reservationId: res.reservationId!,
      outcome: 'succeeded',
      usage: createUsagePayload({ input: 100, output: 0, semantics: DEFAULT_DSH_COUNTING_SEMANTICS })
    });
    expect(first.getSettledResult('audit-flags')?.auditOnly).toBe(false);
    expect(first.getSettledResult('audit-flags')?.qualityEvidence).toBe(true);

    const second = new LedgerReservationManager(config);
    second.recoverFromWal();
    expect(second.getSettledResult('audit-flags')?.auditOnly).toBe(false);
    expect(second.getSettledResult('audit-flags')?.qualityEvidence).toBe(true);
  });

it('a caller-deferred seat (releaseSeat:false) remains recoverable after settlement', () => {
    const dir = makeTempDir();
    const manager = new LedgerReservationManager({
      generalBudgetMicros: 1_000_000,
      verificationReserveMicros: 100_000,
      maxConcurrencySeats: 1,
      defaultRateCard: RATE_CARD,
      storageDir: dir
    });
    const res = manager.reserve({
      callId: 'deferred',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 1_000,
      requiresSeat: true
    });
    const settled = manager.settle({
      callId: 'deferred',
      reservationId: res.reservationId!,
      outcome: 'succeeded',
      actualCostMicros: 100,
      releaseSeat: false
    });
    expect(settled.seatReleased).toBe(false);
    expect(settled.seatRetainedByCaller).toBe(true);
    expect(manager.getBudgetStatus().seats.occupied).toBe(1);

    // The reservation record was deleted, but the handle must survive.
    expect(manager.releaseSeat('deferred')).toBe(true);
    expect(manager.releaseSeat('deferred')).toBe(false);
    expect(manager.getBudgetStatus().seats.occupied).toBe(0);
  });

  it('replays caller-deferred and unconfirmed-remote seat handles as releasable, not leaked', () => {
    const dir = makeTempDir();
    const config = {
      generalBudgetMicros: 1_000_000,
      verificationReserveMicros: 100_000,
      maxConcurrencySeats: 2,
      defaultRateCard: RATE_CARD,
      storageDir: dir
    };
    const first = new LedgerReservationManager(config);
    const deferred = first.reserve({
      callId: 'deferred-replay',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 1_000,
      requiresSeat: true
    });
    first.settle({
      callId: 'deferred-replay',
      reservationId: deferred.reservationId!,
      outcome: 'succeeded',
      actualCostMicros: 100,
      releaseSeat: false
    });
    const pending = first.reserve({
      callId: 'pending-replay',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 1_000,
      requiresSeat: true
    });
    first.settle({
      callId: 'pending-replay',
      reservationId: pending.reservationId!,
      outcome: 'aborted_local',
      actualCostMicros: 100
    });
    expect(first.getBudgetStatus().seats.occupied).toBe(2);

    const second = new LedgerReservationManager(config);
    second.recoverFromWal();
    expect(second.getBudgetStatus().seats.occupied).toBe(2);
    expect(second.isSeatRetainedPendingRemote('pending-replay')).toBe(true);
    // Both handles survive replay and release exactly once.
    expect(second.releaseSeat('deferred-replay')).toBe(true);
    expect(second.releaseSeat('pending-replay')).toBe(true);
    expect(second.releaseSeat('pending-replay')).toBe(false);
    expect(second.getBudgetStatus().seats.occupied).toBe(0);
  });

  it('reconciles a crash-recovered pending reservation instead of locking its budget', () => {
    const dir = makeTempDir();
    const config = {
      generalBudgetMicros: 10_000,
      verificationReserveMicros: 100_000,
      maxConcurrencySeats: 1,
      defaultRateCard: RATE_CARD,
      storageDir: dir
    };
    const first = new LedgerReservationManager(config);
    first.reserve({
      callId: 'pending-usage',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 1_000,
      requiresSeat: true
    });

    const second = new LedgerReservationManager(config);
    second.recoverFromWal();
    expect(second.getReservationByCallId('pending-usage')?.state).toBe('pending_reconciliation');
    expect(second.getBudgetStatus().generalPool.reservedMicros).toBe(1_000);
    expect(second.getBudgetStatus().seats.occupied).toBe(1);

    const reconciled = second.reconcileLateUsage({
      callId: 'pending-usage',
      usage: createUsagePayload({ input: 400, output: 0, semantics: DEFAULT_DSH_COUNTING_SEMANTICS })
    });
    expect(reconciled.incurredCostMicros).toBe(400);
    expect(reconciled.seatReleased).toBe(true);
    expect(second.getBudgetStatus().generalPool.reservedMicros).toBe(0);
    expect(second.getBudgetStatus().generalPool.settledMicros).toBe(400);
    expect(second.getBudgetStatus().seats.occupied).toBe(0);
    expect(second.getReservationByCallId('pending-usage')).toBeUndefined();
    expect(second.verifyConservationLaw().balanced).toBe(true);

    // Replaying the reconciliation must not resurrect the reservation or double-charge.
    const third = new LedgerReservationManager(config);
    third.recoverFromWal();
    expect(third.getBudgetStatus().generalPool.reservedMicros).toBe(0);
    expect(third.getBudgetStatus().generalPool.settledMicros).toBe(400);
    expect(third.getBudgetStatus().seats.occupied).toBe(0);
    expect(third.getReservationByCallId('pending-usage')).toBeUndefined();
  });

  it('replays interim late reconciliation without resurrecting the reservation', () => {
    const dir = makeTempDir();
    const config = {
      generalBudgetMicros: 10_000,
      verificationReserveMicros: 100_000,
      maxConcurrencySeats: 1,
      defaultRateCard: RATE_CARD,
      storageDir: dir
    };
    const first = new LedgerReservationManager(config);
    const res = first.reserve({
      callId: 'interim-replay',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 1_000,
      requiresSeat: true
    });
    first.settle({
      callId: 'interim-replay',
      reservationId: res.reservationId!,
      outcome: 'timed_out_local',
      actualCostMicros: 0,
      interim: true
    });
    first.reconcileLateUsage({
      callId: 'interim-replay',
      usage: createUsagePayload({ input: 300, output: 0, semantics: DEFAULT_DSH_COUNTING_SEMANTICS })
    });

    const second = new LedgerReservationManager(config);
    second.recoverFromWal();
    expect(second.getBudgetStatus().generalPool.reservedMicros).toBe(0);
    expect(second.getBudgetStatus().generalPool.settledMicros).toBe(300);
    expect(second.getBudgetStatus().seats.occupied).toBe(0);
    expect(second.getReservationByCallId('interim-replay')).toBeUndefined();
    expect(second.verifyConservationLaw().balanced).toBe(true);
  });

  it('persists in-flight reservations in snapshots and advances the WAL sequence', () => {
    const dir = makeTempDir();
    const config = {
      generalBudgetMicros: 100_000,
      verificationReserveMicros: 100_000,
      maxConcurrencySeats: 2,
      defaultRateCard: RATE_CARD,
      storageDir: dir
    };
    const first = new LedgerReservationManager(config);
    const res = first.reserve({
      callId: 'snapshot-inflight',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 1_000,
      requiresSeat: true
    });
    first.saveSnapshot();
    first.settle({
      callId: 'snapshot-inflight',
      reservationId: res.reservationId!,
      outcome: 'succeeded',
      actualCostMicros: 100
    });

    const second = new LedgerReservationManager(config);
    second.recoverFromWal();
    // Snapshot carried the active reservation, and the post-snapshot settle was
    // replayed (not filtered out by a stale/duplicate sequence number).
    expect(second.getBudgetStatus().generalPool.reservedMicros).toBe(0);
    expect(second.getBudgetStatus().generalPool.settledMicros).toBeGreaterThan(0);
    expect(second.getBudgetStatus().seats.occupied).toBe(0);
    expect(second.getSettledResult('snapshot-inflight')).toBeDefined();

    const beforeSeq = second.getWalWriter().currentSequence;
    const b = second.reserve({
      callId: 'after-recovery',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 500,
      requiresSeat: false
    });
    expect(b.granted).toBe(true);
    expect(second.getWalWriter().currentSequence).toBeGreaterThan(beforeSeq);

    const third = new LedgerReservationManager(config);
    third.recoverFromWal();
    expect(third.getReservationByCallId('after-recovery')).toBeDefined();
  });

  it('applies the conservative floor and the frozen rate card during reconcile', () => {
    const dir = makeTempDir();
    const manager = new LedgerReservationManager({
      generalBudgetMicros: 100_000,
      verificationReserveMicros: 100_000,
      maxConcurrencySeats: 1,
      defaultRateCard: RATE_CARD,
      storageDir: dir
    });
    const a = manager.reserve({
      callId: 'floor-reconcile',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 1_000,
      requiresSeat: true
    });
    manager.settle({
      callId: 'floor-reconcile',
      reservationId: a.reservationId!,
      outcome: 'timed_out_local',
      actualCostMicros: 0,
      interim: true
    });
    // No usage => an actualCost of 0 is not evidence of a free call.
    const floor = manager.reconcileLateUsage({ callId: 'floor-reconcile', actualCostMicros: 0 });
    expect(floor.incurredCostMicros).toBe(10_000);
    expect(floor.ledgerEvent?.cost.provenance).toBe('unknown');

    const b = manager.reserve({
      callId: 'frozen-card',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 1_000,
      requiresSeat: true
    });
    manager.settle({
      callId: 'frozen-card',
      reservationId: b.reservationId!,
      outcome: 'timed_out_local',
      actualCostMicros: 0,
      interim: true
    });
    const expensiveCard = { ...RATE_CARD, modelId: 'later-expensive-card', inputRatePerMillion: 10_000_000 };
    const reconciled = manager.reconcileLateUsage({
      callId: 'frozen-card',
      usage: createUsagePayload({ input: 100, output: 0, semantics: DEFAULT_DSH_COUNTING_SEMANTICS }),
      rateCard: expensiveCard
    });
    // Frozen card is 1u/token, so 100 tokens = 100u; the later card must not win.
    expect(reconciled.incurredCostMicros).toBe(100);
  });

  it('refuses to write the WAL into team collaboration internals', () => {
    const forbidden = path.join(os.tmpdir(), '.agent-teams', 'ledger');
    expect(() => new LedgerWalWriter({ storageDir: forbidden })).toThrow(/Security violation/);
  });

  it('round-trips a snapshot and replays only subsequent events', () => {
    const dir = makeTempDir();
    const writer = new LedgerWalWriter({ storageDir: dir });
    writer.append('EVENT_RESERVED', { reservationId: 'r1', callId: 'c1', pool: 'general', reservedCostMicros: 100, seatAcquired: false });
    const snapshot = writer.writeSnapshot({
      generalPool: { totalMicros: 1_000, reservedMicros: 100, settledMicros: 0, remainingMicros: 900 },
      verificationPool: { totalMicros: 500, reservedMicros: 0, settledMicros: 0, remainingMicros: 500 },
      occupiedSeats: 0,
      maxSeats: 4
    });
    expect(snapshot.lastSequenceNumber).toBe(1);

    // A fresh writer re-reads the same durable artefacts.
    const reread = new LedgerWalWriter({ storageDir: dir });
    const loaded = reread.loadSnapshot();
    expect(loaded?.snapshotVersion).toBe(1);
    expect(loaded?.generalPool.reservedMicros).toBe(100);
    expect(reread.readAllEvents()).toHaveLength(1);
  });
});
