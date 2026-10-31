/**
 * P3-C bridge wiring: the two-phase settlement contract as the PRODUCTION
 * consumers actually use it.
 *
 * The gap this closes is documented in docs/reports/p3-c-usage.md §7.1: the
 * ledger already supported reserve -> settle(interim) -> reconcileLateUsage, but
 * agent-loop-executor and metered-model-adapter settled in one step and had no
 * late-usage entry point at all. Each acceptance item below is one deterministic
 * test over a REAL ledger manager (real WAL file, real call index) driven through
 * the REAL bridge code; no host, no network, no paid call.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  asAgentLoopModel,
  createAgentLoopExecutor,
  createMeteredModelAdapter,
  type AgentLoopDecision,
  type AgentToolCallOutcome,
  type AgentToolCallRequest,
  type AgentToolRuntime
} from '../../../src/dsh-bridge';
import {
  createLedgerReservationManager,
  createUsagePayload,
  twoPhaseSettlementFor,
  type LedgerCallIdentity,
  type LedgerReservationManager,
  type ModelRateCard
} from '../../../src/ledger';
import type {
  FailureSignal,
  IModelAdapter,
  IsolatedBranchContext,
  ModelRequest,
  ModelResponse,
  ProbeExecutionResult,
  TrajectoryStep
} from '../../../src/types/contracts';
import { makeClock, makePatch, makeTask } from '../cordis-seams/fixtures';

const RATE_CARD: ModelRateCard = {
  modelId: 'p3c/bridge-model',
  inputRatePerMillion: 1_000_000,
  outputRatePerMillion: 2_000_000,
  reasoningSeparatelyBilled: false,
  conservativeFallbackCostMicros: 500
};

const SEMANTICS = { inputIncludesCacheRead: true, outputIncludesReasoning: true } as const;

const ESTIMATE = 10_000;

const LATE_USAGE = createUsagePayload({
  input: 2_000,
  output: 500,
  cacheRead: 100,
  semantics: SEMANTICS
});

const REVISED_USAGE = createUsagePayload({
  input: 4_000,
  output: 900,
  cacheRead: 100,
  semantics: SEMANTICS
});

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0).reverse()) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'p3c-bridge-'));
  tempDirs.push(dir);
  return dir;
}

function makeManager(storageDir?: string, generalBudgetMicros = 1_000_000): LedgerReservationManager {
  return createLedgerReservationManager({
    enabled: true,
    // The bridge accounting path is what these tests exercise; observe semantics
    // have their own suite (tests/unit/ledger/p3a2-observe.test.ts).
    enforceHardBounds: true,
    generalBudgetMicros,
    verificationReserveMicros: 100_000,
    maxConcurrencySeats: 4,
    defaultRateCard: RATE_CARD,
    ...(storageDir === undefined ? {} : { storageDir })
  });
}

/** A model whose complete() never settles: only the caller abort or the budget ends it. */
function hangingModel(): IModelAdapter {
  return {
    complete: (): Promise<ModelResponse> => new Promise<never>(() => undefined)
  };
}

/** A model whose complete() throws an AbortError: the real cancellation shape. */
function abortingModel(): IModelAdapter {
  return {
    async complete(): Promise<ModelResponse> {
      const error = new Error('the caller aborted the model call');
      error.name = 'AbortError';
      throw error;
    }
  };
}

/** A model that answers with provider-declared usage and counting semantics. */
function measuredModel(): IModelAdapter {
  return {
    async complete(): Promise<ModelResponse> {
      return {
        text: 'ok',
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        metadata: {
          rawUsage: { inputTokens: 2_000, outputTokens: 500, cacheReadTokens: 100 },
          countingSemantics: SEMANTICS
        }
      };
    }
  };
}

function recordingTools(): AgentToolRuntime & { readonly calls: AgentToolCallRequest[] } {
  const calls: AgentToolCallRequest[] = [];
  return {
    calls,
    listTools: () => ['shell'],
    async execute(request: AgentToolCallRequest): Promise<AgentToolCallOutcome> {
      calls.push(request);
      return { result: 'ok', text: 'ok' };
    }
  };
}

function makeContext(overrides: Partial<IsolatedBranchContext> = {}): IsolatedBranchContext {
  return {
    branchId: 'br-two-phase',
    sessionId: 'sess-two-phase',
    namespace: 'harness2:probe_br-two-phase',
    task: makeTask(),
    patch: makePatch(),
    mountedSurfaces: ['system_prompt'],
    signal: new AbortController().signal,
    ...overrides
  };
}

function stepKinds(result: ProbeExecutionResult): readonly string[] {
  return (result.steps ?? []).map((step: TrajectoryStep) => step.kind);
}

function signalKinds(result: ProbeExecutionResult): readonly string[] {
  return (result.failureSignals ?? []).map((signal: FailureSignal) => signal.kind);
}

function ledgerCallsOf(result: ProbeExecutionResult): readonly LedgerCallIdentity[] {
  return (result.metadata?.ledgerCalls ?? []) as readonly LedgerCallIdentity[];
}

function makeExecutor(
  manager: LedgerReservationManager | undefined,
  model: IModelAdapter,
  options: { readonly probeTimeoutMs?: number } = {}
): ReturnType<typeof createAgentLoopExecutor> {
  // P3-4 (rev5 t12): the bridge receives a PRE-BUILT settlement; the manager is
  // only used here, at the test's assembly point.
  const settlement = manager === undefined
    ? undefined
    : twoPhaseSettlementFor(manager, { consumer: 'agent-loop-executor' });
  return createAgentLoopExecutor(
    {
      model: asAgentLoopModel(model),
      tools: recordingTools(),
      ...(settlement === undefined
        ? {}
        : { ledgerSettlement: settlement, ledgerPhase: 'probe', ledgerRateCard: RATE_CARD }),
      ...(options.probeTimeoutMs === undefined ? {} : { probeTimeoutMs: options.probeTimeoutMs })
    },
    makeClock()
  );
}

/** Drive one single_call probe that is cancelled by its caller. */
async function cancelledProbe(
  executor: ReturnType<typeof createAgentLoopExecutor>,
  branchId: string
): Promise<ProbeExecutionResult> {
  const controller = new AbortController();
  const running = executor.runBranch(makeContext({ branchId, signal: controller.signal }));
  setTimeout(() => controller.abort(new Error('caller cancelled')), 5);
  return await running;
}

function requestFor(purpose: ModelRequest['purpose']): ModelRequest {
  return { purpose, messages: [{ role: 'user', content: 'hi' }] };
}

// ---------------------------------------------------------------------------
// 1. cancellation -> interim, late usage -> ONE reconcile on the original callId
// ---------------------------------------------------------------------------

describe('executor: cancel settles interim, late usage merges by the original callId', () => {
  it('holds the money at cancellation and books it exactly once from the late usage', async () => {
    const manager = makeManager();
    const executor = makeExecutor(manager, hangingModel());
    expect(executor.describe().join('\n')).toContain('two-phase settlement');

    const result = await cancelledProbe(executor, 'br-tp-1');
    expect(result.status).toBe('aborted');

    const calls = ledgerCallsOf(result);
    expect(calls).toHaveLength(1);
    const callId = calls[0]?.callId as string;
    const reservationId = calls[0]?.reservationId as string;
    expect(callId.length).toBeGreaterThan(0);
    expect(calls[0]?.state).toBe('interim_settled');

    // Interim: nothing is booked, the money AND the concurrency seat are held.
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(0);
    expect(manager.getBudgetStatus().generalPool.reservedMicros).toBe(ESTIMATE);
    expect(manager.occupiedSeatCount).toBe(1);
    expect(manager.getSeatsPendingRemote()).toEqual([callId]);
    expect(manager.getMeteringStatus().settleCount).toBe(1);
    expect(manager.getMeteringStatus().reserveAttempts).toBe(1);

    // The late usage joins the ORIGINAL callId.
    const merged = executor.reconcileLateUsage({ originCallId: callId, usage: LATE_USAGE });
    expect(merged.mode).toBe('reconciled');
    expect(merged.callId).toBe(callId);
    expect(merged.reservationId).toBe(reservationId);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(merged.incurredCostMicros);
    expect(manager.getBudgetStatus().generalPool.reservedMicros).toBe(0);
    // Late usage IS the proof that the remote ended, so the seat comes back.
    expect(manager.occupiedSeatCount).toBe(0);
    expect(manager.getSeatsPendingRemote()).toEqual([]);
    // NO new accounting: no extra reservation, no extra settlement.
    expect(manager.getMeteringStatus().reserveAttempts).toBe(1);
    expect(manager.getMeteringStatus().settleCount).toBe(1);
    expect(manager.verifyConservationLaw().balanced).toBe(true);

    // A re-delivery of the same event is a no-op, not a second charge.
    const again = executor.reconcileLateUsage({ originCallId: callId, usage: LATE_USAGE });
    expect(again.previouslyReconciled).toBe(true);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(merged.incurredCostMicros);
    expect(manager.getMeteringStatus().settleCount).toBe(1);
    expect(manager.getMeteringStatus().reserveAttempts).toBe(1);
    expect(executor.callIdentities()).toHaveLength(1);
    expect(executor.callIdentities()[0]?.reconciliations).toBe(2);
  });

  it('treats a timeout the same way (interim, then one reconcile)', async () => {
    const manager = makeManager();
    const executor = makeExecutor(manager, hangingModel(), { probeTimeoutMs: 5 });

    const result = await executor.runBranch(makeContext({ branchId: 'br-tp-timeout' }));
    expect(result.status).toBe('timeout');
    const callId = ledgerCallsOf(result)[0]?.callId as string;
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(0);
    expect(manager.getSeatsPendingRemote()).toEqual([callId]);

    const merged = executor.reconcileLateUsage({ originCallId: callId, usage: LATE_USAGE });
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(merged.incurredCostMicros);
    expect(manager.getMeteringStatus().reserveAttempts).toBe(1);
  });

  it('keeps the call index persistent next to the WAL when configured with storageDir', async () => {
    const dir = tempDir();
    const executor = createAgentLoopExecutor(
      {
        model: asAgentLoopModel(hangingModel()),
        tools: recordingTools(),
        ledger: {
          enabled: true,
          enforceHardBounds: true,
          storageDir: dir,
          generalBudgetMicros: 1_000_000,
          maxConcurrencySeats: 4,
          defaultRateCard: RATE_CARD
        }
      },
      makeClock()
    );

    const result = await cancelledProbe(executor, 'br-tp-store');
    const callId = ledgerCallsOf(result)[0]?.callId as string;
    expect(existsSync(join(dir, 'ledger.events.jsonl'))).toBe(true);
    expect(existsSync(join(dir, 'ledger.calls.jsonl'))).toBe(true);
    expect(executor.describe().join('\n')).toContain('call index=persistent');
    expect(executor.reconcileLateUsage({ originCallId: callId, usage: LATE_USAGE }).callId).toBe(callId);
  });
});

// ---------------------------------------------------------------------------
// 2. the cross-callId path is REFUSED at the bridge level
// ---------------------------------------------------------------------------

describe('executor: the "open a new callId" path is closed', () => {
  it('refuses an unknown origin (even WITH a marker) and books nothing', async () => {
    const manager = makeManager();
    const executor = makeExecutor(manager, hangingModel());
    await cancelledProbe(executor, 'br-tp-neg');

    const before = manager.getBudgetStatus();
    const attemptsBefore = manager.getMeteringStatus().reserveAttempts;

    let thrown: unknown;
    try {
      executor.reconcileLateUsage({ originCallId: 'call_never_reserved', usage: LATE_USAGE });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { code?: string }).code).toBe('LATE_USAGE_UNKNOWN_CALL');

    // The marker alone is not a licence: reconcile NEVER reserves, so it refuses
    // again rather than quietly becoming the double-booking path.
    thrown = undefined;
    try {
      executor.reconcileLateUsage({
        originCallId: 'call_never_reserved',
        usage: LATE_USAGE,
        newAttemptMarker: 'new-attempt',
        newAttemptReason: 'should not matter here'
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { code?: string }).code).toBe('LATE_USAGE_UNKNOWN_CALL');

    // Nothing at all moved: no reservation, no settlement, no pool change.
    expect(manager.getMeteringStatus().reserveAttempts).toBe(attemptsBefore);
    expect(manager.getMeteringStatus().settleCount).toBe(1);
    expect(manager.getBudgetStatus().generalPool).toEqual(before.generalPool);
  });

  it('books a marked new attempt only through bookNewAttempt, and labels it', () => {
    const manager = makeManager();
    const executor = makeExecutor(manager, hangingModel());

    let thrown: unknown;
    try {
      executor.bookNewAttempt({ originCallId: 'call_gone', usage: LATE_USAGE });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { code?: string }).code).toBe('NEW_ATTEMPT_MARKER_REQUIRED');

    const booked = executor.bookNewAttempt({
      originCallId: 'call_gone',
      usage: LATE_USAGE,
      newAttemptMarker: 'new-attempt',
      newAttemptReason: 'the mapping was not persisted by an older process'
    });
    expect(booked.mode).toBe('new-attempt');
    expect(booked.callId).not.toBe('call_gone');
    expect(booked.ledgerEvent?.auditOnly).toBe(true);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(booked.incurredCostMicros);
    expect(executor.callIdentities().some((identity) => identity.callId === booked.callId)).toBe(true);
  });

  it('says "unmetered" instead of silently doing nothing when the ledger is off', async () => {
    const executor = makeExecutor(undefined, hangingModel());
    expect(executor.describe().join('\n')).toContain('two-phase settlement: OFF');
    expect(executor.callIdentities()).toEqual([]);

    let thrown: unknown;
    try {
      executor.reconcileLateUsage({ originCallId: 'anything', usage: LATE_USAGE });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { code?: string }).code).toBe('LATE_USAGE_UNMETERED');
  });
});

// ---------------------------------------------------------------------------
// 3. WAL restart: the durable mapping joins, and nothing is booked twice
// ---------------------------------------------------------------------------

describe('executor: restart joins late usage without re-booking', () => {
  it('recovers the ledger, finds the persisted identity and stays a no-op', async () => {
    const dir = tempDir();
    const before = makeManager(dir);
    const executorBefore = makeExecutor(before, hangingModel());
    const result = await cancelledProbe(executorBefore, 'br-tp-restart');
    const callId = ledgerCallsOf(result)[0]?.callId as string;
    const merged = executorBefore.reconcileLateUsage({ originCallId: callId, usage: LATE_USAGE });
    const booked = before.getBudgetStatus().generalPool.settledMicros;
    expect(booked).toBe(merged.incurredCostMicros);
    expect(booked).toBeGreaterThan(0);

    // ---- restart: new manager, new executor, same directory ----
    const after = makeManager(dir);
    const executorAfter = makeExecutor(after, hangingModel());
    const recovered = after.recoverFromWal();
    expect(recovered.balanceBalanced).toBe(true);
    expect(after.getBudgetStatus().generalPool.settledMicros).toBe(booked);

    // The identity survived on disk and is visible through the bridge surface.
    const identity = executorAfter.callIdentities().find((entry) => entry.callId === callId);
    expect(identity?.reservationId).toBe(merged.reservationId);
    expect(identity?.state).toBe('reconciled');

    const replayed = executorAfter.reconcileLateUsage({ originCallId: callId, usage: LATE_USAGE });
    expect(replayed.previouslyReconciled).toBe(true);
    expect(replayed.incurredCostMicros).toBe(merged.incurredCostMicros);
    expect(after.getBudgetStatus().generalPool.settledMicros).toBe(booked);
    expect(after.getMeteringStatus().reserveAttempts).toBe(0);
    expect(after.verifyConservationLaw().balanced).toBe(true);
  });

  it('still CLOSES the ledger call when the planner returns a malformed decision', async () => {
    const manager = makeManager();
    const executor = createAgentLoopExecutor(
      {
        model: {
          async planNext(): Promise<AgentLoopDecision> {
            // A decision the executor must reject (no toolName, no text).
            return { kind: 'tool' } as unknown as AgentLoopDecision;
          }
        },
        tools: recordingTools(),
        ledgerSettlement: twoPhaseSettlementFor(manager, { consumer: 'agent-loop-executor' }),
        ledgerPhase: 'probe',
        ledgerRateCard: RATE_CARD
      },
      makeClock()
    );

    const result = await executor.runBranch(makeContext({ branchId: 'br-tp-malformed' }));
    expect(result.status).toBe('failed');

    // The model call is not left dangling: it reached a terminal ledger state, so
    // it can never hold a reservation (or a seat) forever.
    const identity = executor.callIdentities()[0];
    expect(identity).toBeDefined();
    expect(identity?.state).toBe('settled');
    expect(manager.getReservationByCallId(identity?.callId as string)).toBeUndefined();
    expect(manager.getMeteringStatus().settleCount).toBe(1);
    expect(manager.getMeteringStatus().reserveAttempts).toBe(1);
    expect(manager.occupiedSeatCount).toBe(0);
    expect(manager.getBudgetStatus().generalPool.reservedMicros).toBe(0);
    expect(manager.verifyConservationLaw().balanced).toBe(true);
  });

  it('reconciles a CHANGED late usage (delta semantics) on the SAME callId', async () => {
    const manager = makeManager();
    const executor = makeExecutor(manager, measuredModel());
    // A confirmed call settles FINAL immediately (no interim round).
    const result = await executor.runBranch(makeContext({ branchId: 'br-tp-delta' }));
    expect(result.status).toBe('succeeded');
    const callId = ledgerCallsOf(result)[0]?.callId as string;
    expect(ledgerCallsOf(result)[0]?.state).toBe('settled');
    const bookedAtSettle = manager.getBudgetStatus().generalPool.settledMicros;
    expect(bookedAtSettle).toBeGreaterThan(0);

    const revised = executor.reconcileLateUsage({ originCallId: callId, usage: REVISED_USAGE });
    expect(revised.callId).toBe(callId);
    expect(revised.incurredCostMicros).toBeGreaterThan(bookedAtSettle);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(revised.incurredCostMicros);
    expect(manager.getMeteringStatus().reserveAttempts).toBe(1);
    expect(manager.getMeteringStatus().settleCount).toBe(1);
    expect(manager.verifyConservationLaw().balanced).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. observe mode: identical behaviour, and the same money booked
// ---------------------------------------------------------------------------

describe('observe mode: identical behaviour, identical booked money', () => {
  it('changes nothing observable in the trajectory versus no ledger at all', async () => {
    const baseline = makeExecutor(undefined, hangingModel());
    const baselineResult = await cancelledProbe(baseline, 'br-tp-observe');

    // Observe is the factory default; a zero budget would deny in enforce mode.
    const observedManager = createLedgerReservationManager({
      enabled: true,
      generalBudgetMicros: 0,
      maxConcurrencySeats: 4,
      defaultRateCard: RATE_CARD
    });
    const observed = makeExecutor(observedManager, hangingModel());
    const observedResult = await cancelledProbe(observed, 'br-tp-observe');

    expect(observedResult.status).toBe(baselineResult.status);
    expect(stepKinds(observedResult)).toEqual(stepKinds(baselineResult));
    expect([...signalKinds(observedResult)].sort()).toEqual([...signalKinds(baselineResult)].sort());
    // The would-be denial is observed, never enforced.
    expect(signalKinds(observedResult)).not.toContain('budget_exhausted');
    expect(observedResult.observations?.some((entry) => entry.kind === 'budget_exhausted')).toBe(true);

    const callId = ledgerCallsOf(observedResult)[0]?.callId as string;
    expect(callId.length).toBeGreaterThan(0);
    expect(observedManager.getBudgetStatus().generalPool.reservedMicros).toBe(0);
    expect(observedManager.getBudgetStatus().generalPool.settledMicros).toBe(0);

    // Interim + reconcile books EXACTLY what a one-step settle would have booked on
    // the same usage/rate card: observe accounting is unchanged, only its timing is
    // now two-phase.
    const merged = observed.reconcileLateUsage({ originCallId: callId, usage: LATE_USAGE });
    const reference = createLedgerReservationManager({
      enabled: true,
      generalBudgetMicros: 0,
      maxConcurrencySeats: 4,
      defaultRateCard: RATE_CARD
    });
    const referenceReserve = reference.reserve({
      callId: 'reference-call',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: ESTIMATE,
      requiresSeat: false,
      rateCard: RATE_CARD
    });
    const referenceSettle = reference.settle({
      callId: 'reference-call',
      reservationId: referenceReserve.reservationId as string,
      outcome: 'cancelled',
      usage: LATE_USAGE,
      rateCard: RATE_CARD
    });
    expect(merged.incurredCostMicros).toBe(referenceSettle.incurredCostMicros);
    expect(observedManager.getBudgetStatus().generalPool.settledMicros).toBe(referenceSettle.incurredCostMicros);
  });
});

// ---------------------------------------------------------------------------
// 5. the metered adapter: same contract on the stage boundary
// ---------------------------------------------------------------------------

describe('metered adapter: cancellation is interim, late usage books once', () => {
  it('holds the cost on an AbortError and books it from the late usage', async () => {
    const manager = makeManager();
    const adapter = createMeteredModelAdapter(abortingModel(), 'compose', {
      ledgerSettlement: twoPhaseSettlementFor(manager, { consumer: 'metered-model-adapter:compose' }),
      idFactory: () => 'mcall_cancel_1'
    });

    await expect(adapter.call(requestFor('compose'))).rejects.toThrow('the caller aborted the model call');

    const record = adapter.records()[0];
    expect(record?.outcome).toBe('cancelled');
    expect(record?.settlement).toBe('interim');
    expect(record?.reservationId).toBeDefined();
    expect(record?.incurredCostMicros).toBeUndefined();
    expect(record?.heldCostMicros).toBeGreaterThan(0);
    expect(adapter.stats().costMicros).toBe(0);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(0);
    expect(manager.getMeteringStatus().settleCount).toBe(1);

    const merged = adapter.reconcileLateUsage({ originCallId: 'mcall_cancel_1', usage: LATE_USAGE });
    expect(merged.callId).toBe('mcall_cancel_1');
    expect(merged.reservationId).toBe(record?.reservationId);
    expect(adapter.stats().costMicros).toBe(merged.incurredCostMicros);
    expect(adapter.stats().lateUsageSettlements).toBe(1);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(merged.incurredCostMicros);
    expect(manager.getMeteringStatus().settleCount).toBe(1);
    expect(manager.getMeteringStatus().reserveAttempts).toBe(1);

    const redelivered = adapter.reconcileLateUsage({ originCallId: 'mcall_cancel_1', usage: LATE_USAGE });
    expect(redelivered.previouslyReconciled).toBe(true);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(merged.incurredCostMicros);
    expect(adapter.stats().costMicros).toBe(merged.incurredCostMicros);
    expect(adapter.lateUsageSettlements()).toHaveLength(2);
  });

  it('does not settle the same callId twice when the id factory repeats it', async () => {
    const manager = makeManager();
    const adapter = createMeteredModelAdapter(measuredModel(), 'compose', {
      ledgerSettlement: twoPhaseSettlementFor(manager, { consumer: 'metered-model-adapter:compose' }),
      idFactory: () => 'mcall_fixed'
    });

    await adapter.call(requestFor('compose'));
    const bookedOnce = manager.getBudgetStatus().generalPool.settledMicros;
    expect(bookedOnce).toBeGreaterThan(0);
    expect(manager.getMeteringStatus().settleCount).toBe(1);

    // The SAME callId comes round again: it is refused before the model is called,
    // so there is no second settlement and no second charge.
    await expect(adapter.call(requestFor('compose'))).rejects.toMatchObject({
      code: 'METERED_MODEL_BUDGET_DENIED'
    });
    expect(manager.getMeteringStatus().settleCount).toBe(1);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(bookedOnce);
    expect(adapter.records()[1]?.error).toBe('budget_denied');
    expect(adapter.records()[1]?.settlement).toBe('none');
    expect(adapter.stats().costMicros).toBe(bookedOnce);
  });

  it('says "unmetered" instead of silently doing nothing when the ledger is off', () => {
    const adapter = createMeteredModelAdapter(measuredModel(), 'probe');
    expect(adapter.callIdentities()).toEqual([]);
    let thrown: unknown;
    try {
      adapter.reconcileLateUsage({ originCallId: 'anything', usage: LATE_USAGE });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { code?: string }).code).toBe('LATE_USAGE_UNMETERED');
  });

  it('keeps the confirmed-call path final (no interim round for a normal answer)', async () => {
    const manager = makeManager();
    const adapter = createMeteredModelAdapter(measuredModel(), 'compose', {
      ledgerSettlement: twoPhaseSettlementFor(manager, { consumer: 'metered-model-adapter:compose' }),
      idFactory: () => 'mcall_final'
    });
    await adapter.call(requestFor('compose'));
    const record = adapter.records()[0];
    expect(record?.settlement).toBe('final');
    expect(record?.outcome).toBe('succeeded');
    expect(record?.incurredCostMicros).toBe(manager.getBudgetStatus().generalPool.settledMicros);
    expect(manager.getMeteringStatus().reserveAttempts).toBe(1);
    expect(manager.getMeteringStatus().settleCount).toBe(1);
  });
});
