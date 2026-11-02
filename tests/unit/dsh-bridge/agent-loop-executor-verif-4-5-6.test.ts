/**
 * VERIF-4 / VERIF-5 / VERIF-6 regression: the agent-loop executor's own
 * contracts, each of which the audit found violated.
 *
 * VERIF-4 — "never a rejection". The catch block says a planner or tool that
 * threw still yields a trajectory "the seam manager must never receive a
 * rejection", but the host-supplied `buildMessages`/`systemPrompt` (and
 * `extractToolGuidance`) used to run BEFORE the try, so their throw rejected
 * `runBranch`.
 *
 * VERIF-5 — a throwing `settleCall` abandoned the reservation identity. The
 * `ledgerCallRefs.push` sat inside the try, so a settle throw skipped it and
 * `metadata.ledgerCalls` lost the only sanctioned handle for reconciling (or
 * releasing) a still-open reservation.
 *
 * VERIF-6 — a metadata budget override that is present but unusable fell back
 * SILENTLY to the adapter default (0 = timer disabled when none was configured),
 * turning a bounded probe into an unbounded one with no trace.
 *
 * MUST BE RED before the fixes: a throwing builder rejects runBranch; the
 * ledgerCalls list is empty (or unregistered) after a settle failure; and the
 * rejected override leaves no diagnostic.
 */
import { describe, expect, it } from 'vitest';

import {
  asAgentLoopModel,
  createAgentLoopExecutor,
  DEFAULT_MAX_STEPS_PER_PROBE,
  type AgentToolCallRequest,
  type AgentToolCallOutcome,
  type AgentToolRuntime,
} from '../../../src/dsh-bridge/agent-loop-executor';
import type {
  IModelAdapter,
  IsolatedBranchContext,
  ModelRequest,
  ModelResponse,
  ProbeExecutionResult
} from '../../../src/types/contracts';
import type {
  LedgerCallIdentity,
  ReserveRequest,
  ReserveResult,
  SettleRequest,
  TwoPhaseSettlement,
  TwoPhaseSettleOutcome
} from '../../../src/ledger';
import { makeClock, makePatch, makeTask } from '../cordis-seams/fixtures';

function plainModel(reply = 'done', finishReason: ModelResponse['finishReason'] = 'stop'): IModelAdapter {
  return {
    async complete(_request: ModelRequest): Promise<ModelResponse> {
      return { text: reply, finishReason, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
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
    branchId: 'br-verif',
    sessionId: 'sess-verif',
    namespace: 'harness2:probe_br-verif',
    task: makeTask(),
    patch: makePatch(),
    mountedSurfaces: ['system_prompt', 'tool_guidance'],
    signal: new AbortController().signal,
    ...overrides
  };
}

/**
 * Collector + executor diagnostics recorded on a result.
 *
 * `toProbeExecutionResult` nests the collector's trajectory metadata under
 * `metadata.trajectory`, and the collector stores its `diagnostics` array there
 * (trajectory-collector.ts:343).
 */
function diagnosticsOf(result: ProbeExecutionResult): readonly string[] {
  const diagnostics = (result.metadata?.trajectory as { diagnostics?: unknown } | undefined)?.diagnostics;
  return Array.isArray(diagnostics) ? (diagnostics as string[]) : [];
}

// ---------------------------------------------------------------------------
// VERIF-4: runBranch never rejects, even when host prompt assembly throws
// ---------------------------------------------------------------------------

describe('VERIF-4: a throwing buildMessages/systemPrompt still yields a trajectory', () => {
  it('settles a failed trajectory (not a rejection) when buildMessages throws', async () => {
    const executor = createAgentLoopExecutor(
      {
        model: asAgentLoopModel(plainModel()),
        tools: recordingTools(),
        buildMessages: (): readonly never[] => {
          throw new Error('the host prompt builder exploded');
        }
      },
      makeClock()
    );

    const result = await executor.runBranch(makeContext());

    // The load-bearing assertion: runBranch RESOLVED (the await above would
    // reject otherwise) and produced the executor's own structured failure.
    expect(result.status).toBe('failed');
    expect((result.steps ?? []).some((step) => step.kind === 'error')).toBe(true);
    expect((result.failureSignals ?? []).map((signal) => signal.kind)).toContain('unknown');
    expect(result.error?.message).toContain('the host prompt builder exploded');
  });

  it('settles a failed trajectory (not a rejection) when systemPrompt throws', async () => {
    const executor = createAgentLoopExecutor(
      {
        model: asAgentLoopModel(plainModel()),
        tools: recordingTools(),
        systemPrompt: (): string => {
          throw new Error('the host system prompt exploded');
        }
      },
      makeClock()
    );

    const result = await executor.runBranch(makeContext());

    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('the host system prompt exploded');
  });

  it('settles a failed trajectory when the branch patch has no usable edits surface', async () => {
    const executor = createAgentLoopExecutor({ model: asAgentLoopModel(plainModel()), tools: recordingTools() }, makeClock());
    // A patch whose `edits` is absent (a host built it outside the type contract):
    // extractToolGuidance used to read it before the try.
    const context = makeContext();
    const brokenPatch = { ...context.patch, edits: undefined as unknown as typeof context.patch.edits };

    const result = await executor.runBranch(makeContext({ patch: brokenPatch }));

    expect(result.status).toBe('failed');
    expect((result.failureSignals ?? []).map((signal) => signal.kind)).toContain('unknown');
  });

  it('finalizes through the executor (mode + bounds recorded), not a bare seam-manager trajectory', async () => {
    const executor = createAgentLoopExecutor(
      {
        model: asAgentLoopModel(plainModel()),
        tools: recordingTools(),
        buildMessages: (): readonly never[] => {
          throw new Error('builder boom');
        }
      },
      makeClock()
    );

    const result = await executor.runBranch(makeContext());

    // The guarantee is that the executor's OWN settle ran, so the trajectory
    // carries the executor's metadata (a bare reject would let the seam manager
    // finalize its own collector with none of these fields).
    expect(result.metadata?.mode).toBe('single_call');
    expect(result.metadata?.branchId).toBe('br-verif');
    expect(result.metadata?.maxStepsPerProbe).toBe(DEFAULT_MAX_STEPS_PER_PROBE);
  });
});

// ---------------------------------------------------------------------------
// VERIF-5: a throwing settleCall still registers the call identity
// ---------------------------------------------------------------------------

/** A settlement double whose settleCall throws AFTER beginCall recorded the call. */
function throwingSettlement(options: {
  readonly throwOnSettle: boolean;
  readonly keepIdentityInIndex: boolean;
}): {
  beginCall: (request: ReserveRequest) => ReserveResult;
  settleCall: (request: SettleRequest) => TwoPhaseSettleOutcome;
  identities: () => readonly LedgerCallIdentity[];
  describe: () => string;
} {
  const identities: LedgerCallIdentity[] = [];
  let sequence = 0;
  return {
    beginCall(request: ReserveRequest): ReserveResult {
      sequence += 1;
      const reservationId = 'res-' + String(sequence);
      if (options.keepIdentityInIndex) {
        identities.push({
          callId: request.callId,
          reservationId,
          pool: request.pool,
          phase: request.phase,
          consumer: 'agent-loop-executor',
          reservedCostMicros: request.estimatedCostMicros,
          state: 'reserved',
          createdAt: 1,
          updatedAt: 1,
          reconciliations: 0
        });
      }
      return {
        granted: true,
        reservationId,
        pool: request.pool,
        reservedCostMicros: request.estimatedCostMicros,
        observedRejection: undefined
      } as unknown as ReserveResult;
    },
    settleCall(request: SettleRequest): TwoPhaseSettleOutcome {
      if (options.throwOnSettle) {
        const error = new Error('the ledger settle path failed') as Error & { code: string };
        error.name = 'TwoPhaseLedgerError';
        error.code = 'CALL_NOT_TRACKED';
        throw error;
      }
      const identity = identities.find((entry) => entry.callId === request.callId);
      if (identity === undefined) {
        throw Object.assign(new Error('not tracked'), { name: 'TwoPhaseLedgerError' });
      }
      return {
        settlement: 'final',
        identity,
        idempotentReplay: false
      } as unknown as TwoPhaseSettleOutcome;
    },
    identities: (): readonly LedgerCallIdentity[] => [...identities],
    describe: (): string => 'test settlement double'
  };
}

function ledgerCallsOf(result: ProbeExecutionResult): readonly LedgerCallIdentity[] {
  return (result.metadata?.ledgerCalls ?? []) as readonly LedgerCallIdentity[];
}

describe('VERIF-5: a throwing settleCall still registers the call identity', () => {
  it('registers the callId -> reservationId identity from the ledger index after a settle throw', async () => {
    const settlement = throwingSettlement({ throwOnSettle: true, keepIdentityInIndex: true });
    const diagnostics: string[] = [];
    const executor = createAgentLoopExecutor(
      {
        model: asAgentLoopModel(plainModel()),
        tools: recordingTools(),
        // The double is structurally a TwoPhaseSettlement's public surface.
        ledgerSettlement: settlement as unknown as TwoPhaseSettlement,
        ledgerRateCard: undefined,
        onDiagnostic: (message): void => {
          diagnostics.push(message);
        }
      },
      makeClock()
    );

    const result = await executor.runBranch(makeContext());

    // The probe outcome is unchanged (metering is observational) ...
    expect(result.status).toBe('succeeded');
    // ... but the identity survived, on the sanctioned reconciliation surface.
    expect(ledgerCallsOf(result)).toHaveLength(1);
    expect(ledgerCallsOf(result)[0]?.callId).toMatch(/^call_/);
    expect(ledgerCallsOf(result)[0]?.reservationId).toBe('res-1');
    // And the failure itself was reported, never swallowed.
    expect(diagnosticsOf(result).some((line) => line.includes('ledger settlement failed'))).toBe(true);
  });

  it('reports (never silently drops) an identity the ledger could not recover', async () => {
    // beginCall recorded nothing, and settleCall throws: the executor cannot
    // invent an identity, so it must say the reconciliation handle is missing
    // rather than produce an empty list that looks like "no calls were made".
    const settlement = throwingSettlement({ throwOnSettle: true, keepIdentityInIndex: false });
    const executor = createAgentLoopExecutor(
      {
        model: asAgentLoopModel(plainModel()),
        tools: recordingTools(),
        ledgerSettlement: settlement as unknown as TwoPhaseSettlement
      },
      makeClock()
    );

    const result = await executor.runBranch(makeContext());

    expect(ledgerCallsOf(result)).toHaveLength(0);
    expect(
      diagnosticsOf(result).some((line) => line.includes('identity for call') && line.includes('could not be registered'))
    ).toBe(true);
  });

  it('registers exactly one identity per wired call on the healthy path', async () => {
    const settlement = throwingSettlement({ throwOnSettle: false, keepIdentityInIndex: true });
    const executor = createAgentLoopExecutor(
      {
        model: asAgentLoopModel(plainModel()),
        tools: recordingTools(),
        ledgerSettlement: settlement as unknown as TwoPhaseSettlement
      },
      makeClock()
    );

    const result = await executor.runBranch(makeContext());

    expect(ledgerCallsOf(result)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// VERIF-6: an unusable metadata budget override is reported, not silent
// ---------------------------------------------------------------------------

describe('VERIF-6: metadata budget overrides fail loudly instead of silently disabling the bound', () => {
  it('accepts a FRACTIONAL metadata probeTimeoutMs (the adapter rule, not an integer rule)', async () => {
    const hanging: IModelAdapter = { complete: (): Promise<ModelResponse> => new Promise<ModelResponse>(() => undefined) };
    const executor = createAgentLoopExecutor(
      { model: asAgentLoopModel(hanging), tools: recordingTools() },
      makeClock()
    );

    const result = await executor.runBranch(makeContext({ metadata: { probeTimeoutMs: 25.5 } }));

    // The requested budget really bounded the probe (pre-fix it fell back to the
    // adapter default 0 = no timer, and the probe never settled).
    expect(result.status).toBe('timeout');
    const signals = (result.failureSignals ?? []).map((signal) => signal.kind);
    expect(signals).toContain('timeout');
  });

  it('reports a non-positive metadata probeTimeoutMs override explicitly', async () => {
    const executor = createAgentLoopExecutor(
      { model: asAgentLoopModel(plainModel()), tools: recordingTools() },
      makeClock()
    );

    const result = await executor.runBranch(makeContext({ metadata: { probeTimeoutMs: -5 } }));

    const reported = diagnosticsOf(result).join('\n');
    expect(reported).toContain('metadata.probeTimeoutMs override "-5" is not a positive finite number');
    // The consequence is named, not hidden: the default 0 means NO timer at all.
    expect(reported).toContain('the probe runs with NO wall-clock budget');
    // The probe itself still ran (metering/config problems never change the outcome).
    expect(result.status).toBe('succeeded');
  });

  it('reports a non-integer metadata maxStepsPerProbe override explicitly', async () => {
    const executor = createAgentLoopExecutor(
      { model: asAgentLoopModel(plainModel()), tools: recordingTools() },
      makeClock()
    );

    const result = await executor.runBranch(makeContext({ metadata: { maxStepsPerProbe: 2.5 } }));

    expect(diagnosticsOf(result).join('\n')).toContain(
      'metadata.maxStepsPerProbe override "2.5" is not a positive integer; the adapter default ' +
        String(DEFAULT_MAX_STEPS_PER_PROBE) + ' applies'
    );
  });

  it('stays silent when no metadata override was supplied (no false alarms)', async () => {
    const executor = createAgentLoopExecutor(
      { model: asAgentLoopModel(plainModel()), tools: recordingTools() },
      makeClock()
    );

    const result = await executor.runBranch(makeContext());

    expect(diagnosticsOf(result).some((line) => line.includes('metadata.probeTimeoutMs override'))).toBe(false);
    expect(diagnosticsOf(result).some((line) => line.includes('metadata.maxStepsPerProbe override'))).toBe(false);
  });
});
