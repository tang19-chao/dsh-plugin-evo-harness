/**
 * P3-A2: default observe has ZERO behavioural side effects, and hard limits are
 * an INDEPENDENT explicit opt-in.
 *
 * Four independent guarantees (each fails alone):
 *   1. no denial because the budget is exhausted;
 *   2. no truncation of the tool result;
 *   3. no rewriting of the tool result;
 *   4. no change to the probe status versus a run without any ledger.
 * Plus: the enforcement counterpart (same fixture, explicit opt-in) still
 * denies BEFORE any model/tool work; the ledger status distinguishes
 * 'no ledger', 'ledger with zero calls' and 'unknown semantics'; and the ledger
 * source never reads an execution/permission profile.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  assembleAgentLoopLedger,
  createLedgerReservationManager,
  createUsagePayload,
  describeLedgerAssembly,
  resolveLedgerAssemblyOptions,
  type LedgerAssemblyOptions
} from '../../../src/ledger';
import {
  createAgentLoopExecutor,
  type AgentLoopDecision,
  type AgentPlanRequest,
  type AgentToolCallOutcome,
  type AgentToolCallRequest,
  type AgentToolRuntime
} from '../../../src/dsh-bridge';
import type {
  FailureSignal,
  IsolatedBranchContext,
  ProbeExecutionResult
} from '../../../src/types/contracts';
import { makeClock, makePatch, makeTask } from '../cordis-seams/fixtures';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const LONG_RESULT = 'x'.repeat(50_000);

function scriptedPlanner(decisions: readonly AgentLoopDecision[]): {
  planNext: (request: AgentPlanRequest) => Promise<AgentLoopDecision>;
  readonly requests: AgentPlanRequest[];
} {
  const requests: AgentPlanRequest[] = [];
  let cursor = 0;
  return {
    requests,
    async planNext(request: AgentPlanRequest): Promise<AgentLoopDecision> {
      requests.push(request);
      const decision = decisions[cursor];
      cursor += 1;
      if (decision === undefined) {
        throw new Error('scripted planner ran out of decisions');
      }
      return decision;
    }
  };
}

function toolsReturning(outcome: AgentToolCallOutcome): AgentToolRuntime & { readonly calls: AgentToolCallRequest[] } {
  const calls: AgentToolCallRequest[] = [];
  return {
    calls,
    listTools: () => ['shell'],
    async execute(request: AgentToolCallRequest): Promise<AgentToolCallOutcome> {
      calls.push(request);
      return outcome;
    }
  };
}

function makeContext(): IsolatedBranchContext {
  return {
    branchId: 'br-p3a2',
    sessionId: 'sess-p3a2',
    namespace: 'harness2:probe_br-p3a2',
    task: makeTask(),
    patch: makePatch(),
    mountedSurfaces: ['system_prompt'],
    signal: new AbortController().signal
  };
}

const TWO_ITERATIONS: readonly AgentLoopDecision[] = [
  { kind: 'tool', toolName: 'shell', toolArguments: { cmd: 'ls' } },
  { kind: 'final', text: 'done' }
];

function buildExecutor(options: {
  readonly ledger?: LedgerAssemblyOptions;
  readonly toolOutcome?: AgentToolCallOutcome;
}): {
  executor: ReturnType<typeof createAgentLoopExecutor>;
  planner: ReturnType<typeof scriptedPlanner>;
  tools: ReturnType<typeof toolsReturning>;
} {
  const planner = scriptedPlanner(TWO_ITERATIONS);
  const tools = toolsReturning(options.toolOutcome ?? { result: 'ok', text: 'ok' });
  const executor = createAgentLoopExecutor(
    {
      model: planner,
      tools,
      ...(options.ledger === undefined ? {} : { ledger: options.ledger })
    },
    makeClock(1_000, 10)
  );
  return { executor, planner, tools };
}

function signalKinds(result: ProbeExecutionResult): readonly string[] {
  return (result.failureSignals ?? []).map((signal: FailureSignal) => signal.kind);
}

function toolResultStep(result: ProbeExecutionResult) {
  return (result.steps ?? []).find((step) => step.kind === 'result' && step.toolName === 'shell');
}

describe('observe: four independent zero-side-effect guarantees', () => {
  it('GUARANTEE 1: does not deny a call because the budget is exhausted', async () => {
    const { executor, planner, tools } = buildExecutor({
      ledger: { enabled: true, generalBudgetMicros: 0 }
    });
    const result = await executor.runBranch(makeContext());

    expect(result.status).toBe('succeeded');
    expect(planner.requests.length).toBeGreaterThan(0);
    expect(tools.calls.length).toBeGreaterThan(0);
    // The would-be denial is OBSERVABLE on the dedicated channel…
    expect(result.observations?.some((entry) => entry.kind === 'budget_exhausted')).toBe(true);
    // …and does NOT pollute the failure channel that scoring/taxonomy consume.
    expect(signalKinds(result)).not.toContain('budget_exhausted');
  });

  it('GUARANTEE 2: does not truncate the tool result', async () => {
    const { executor } = buildExecutor({
      ledger: { enabled: true, generalBudgetMicros: 0 },
      toolOutcome: { result: LONG_RESULT, text: LONG_RESULT }
    });
    const result = await executor.runBranch(makeContext());
    const step = toolResultStep(result);
    expect(step?.toolResult).toBe(LONG_RESULT);
    expect(String(step?.toolResult).length).toBe(50_000);
    expect(step?.text).toBe(LONG_RESULT);
  });

  it('GUARANTEE 3: does not rewrite the tool result', async () => {
    const payload = { stdout: 'build failed', exitCode: 1, nested: { keep: true } };
    const { executor } = buildExecutor({
      ledger: { enabled: true, generalBudgetMicros: 0 },
      toolOutcome: { result: payload, text: 'build failed' }
    });
    const result = await executor.runBranch(makeContext());
    const step = toolResultStep(result);
    expect(step?.toolResult).toEqual(payload);
    expect(step?.toolResult).toBe(payload);
  });

  it('GUARANTEE 4: does not change the probe status versus no ledger', async () => {
    const baseline = buildExecutor({});
    const observed = buildExecutor({ ledger: { enabled: true, generalBudgetMicros: 0 } });
    const baselineResult = await baseline.executor.runBranch(makeContext());
    const observedResult = await observed.executor.runBranch(makeContext());

    expect(observedResult.status).toBe(baselineResult.status);
    expect((observedResult.steps ?? []).map((step) => step.kind)).toEqual(
      (baselineResult.steps ?? []).map((step) => step.kind)
    );
    expect(observedResult.deliverable?.content).toBe(baselineResult.deliverable?.content);
    expect([...signalKinds(observedResult)].sort()).toEqual([...signalKinds(baselineResult)].sort());
    // The only difference is the observation channel.
    expect(observedResult.observations?.length ?? 0).toBeGreaterThan(0);
    expect(baselineResult.observations).toBeUndefined();
  });
});

describe('enforce: the same fixture denies before any model/tool work', () => {
  it('fails the probe and reports budget_exhausted as a failure signal', async () => {
    const { executor, planner, tools } = buildExecutor({
      ledger: { enabled: true, enforceHardBounds: true, generalBudgetMicros: 0 }
    });
    const result = await executor.runBranch(makeContext());

    expect(result.status).toBe('failed');
    expect(result.error?.name).toBe('EvoHarnessLedgerError');
    expect(signalKinds(result)).toContain('budget_exhausted');
    expect(planner.requests).toHaveLength(0);
    expect(tools.calls).toHaveLength(0);
  });
});

describe('status: no-ledger / zero-calls / unknown-semantics are distinguishable', () => {
  it('has no assembly at all when the ledger is not enabled', () => {
    expect(assembleAgentLoopLedger(undefined)).toBeUndefined();
    expect(assembleAgentLoopLedger({ enabled: false })).toBeUndefined();
  });

  it('reports metered=true with zero calls once the ledger is assembled', () => {
    const assembly = assembleAgentLoopLedger({ enabled: true });
    expect(assembly).toBeDefined();
    const status = assembly?.manager.getMeteringStatus();
    expect(status).toEqual({
      mode: 'observe',
      metered: true,
      reserveAttempts: 0,
      reserveGranted: 0,
      observedDenials: 0,
      settleCount: 0,
      measuredCalls: 0,
      estimatedCalls: 0,
      unknownCalls: 0,
      totalCostMicros: 0
    });
    expect(describeLedgerAssembly(assembly!)).toContain('mode=observe');
  });

  it('keeps unknown semantics UNKNOWN in the status (never measured)', () => {
    const manager = createLedgerReservationManager({ enabled: true });
    const reserved = manager.reserve({
      callId: 'unknown-call',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 10_000,
      requiresSeat: false
    });
    manager.settle({
      callId: 'unknown-call',
      reservationId: reserved.reservationId as string,
      outcome: 'succeeded',
      usage: createUsagePayload({ input: 100, output: 50 })
    });
    const status = manager.getMeteringStatus();
    expect(status.measuredCalls).toBe(0);
    expect(status.unknownCalls).toBe(1);
    expect(manager.getUsageAccounting().unknown.calls).toBe(1);
  });

  it('reports observed denials and takes no seat in observe mode', () => {
    const manager = createLedgerReservationManager({ enabled: true, maxConcurrencySeats: 0 });
    const reserved = manager.reserve({
      callId: 'seatless-call',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 10_000,
      requiresSeat: true
    });
    expect(reserved.granted).toBe(true);
    expect(reserved.observed).toBe(true);
    expect(reserved.seatAcquired).toBe(false);
    expect(reserved.observedRejection).toBe('insufficient_seats');
    expect(manager.occupiedSeatCount).toBe(0);
    const status = manager.getMeteringStatus();
    expect(status.observedDenials).toBe(1);
    expect(status.reserveGranted).toBe(1);
    expect(manager.getAlertsOfKind('observe-seat-exceeded').length).toBeGreaterThan(0);
  });

  it('records observed budget exhaustion as a named alert, never as a failure', () => {
    const manager = createLedgerReservationManager({ enabled: true, generalBudgetMicros: 0 });
    const reserved = manager.reserve({
      callId: 'observe-budget-call',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 10_000,
      requiresSeat: false
    });
    expect(reserved.granted).toBe(true);
    expect(reserved.observedRejection).toBe('insufficient_budget');
    expect(manager.getAlertsOfKind('observe-budget-exceeded')).toHaveLength(1);
  });
});

describe('hard limits are independent of every other permission switch', () => {
  it('is driven ONLY by enforceHardBounds, regardless of an execution profile', () => {
    const withoutEnforcement = {
      enabled: true,
      enforceHardBounds: false,
      execution: { mode: 'guarded-active' }
    } as unknown as LedgerAssemblyOptions;
    const withEnforcement = {
      enabled: true,
      enforceHardBounds: true,
      execution: { mode: 'shadow' }
    } as unknown as LedgerAssemblyOptions;

    expect(resolveLedgerAssemblyOptions(withoutEnforcement).meteringMode).toBe('observe');
    expect(resolveLedgerAssemblyOptions(withEnforcement).meteringMode).toBe('enforce');
  });

  it('never reads an execution/permission profile in the ledger source', () => {
    const dir = join(REPO_ROOT, 'src', 'ledger');
    const sources = readdirSync(dir)
      .filter((file) => file.endsWith('.ts'))
      .map((file) => readFileSync(join(dir, file), 'utf8'))
      .join('\n')
      // Strip comments: prose may MENTION guarded-active; code must not read it.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(sources).not.toContain('guarded-active');
    expect(sources).not.toContain('executionProfile');
    expect(sources).not.toContain('applyWinningPatch');
    expect(sources).not.toMatch(/permissions\s*\./);
  });
});
