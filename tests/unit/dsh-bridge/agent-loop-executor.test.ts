/**
 * Deterministic tests for the multi-step agent probe executor (P0-2).
 *
 * EVERY collaborator here is a structural fake: no DSH host, no network, no LLM,
 * no sandbox. The clock, the trajectory-id factory and the tool runtime are all
 * injected, so every assertion below is reproducible.
 *
 * The load-bearing assertions are:
 *   1. the recorded trajectory really is a model -> tool -> result alternation;
 *   2. the SECOND iteration observes the branch's tool_guidance patch (the patch
 *      reaches both the planner and the tool call, and the tool reports back what
 *      it saw);
 *   3. maxStepsPerProbe and AbortSignal / wall-clock budgets all bound the loop;
 *   4. the single_call degradation path still works for a plain IModelAdapter.
 */
import { describe, expect, it } from 'vitest';
import {
  asAgentLoopModel,
  createAgentLoopExecutor,
  DEFAULT_MAX_STEPS_PER_PROBE,
  extractToolGuidance,
  type AgentLoopDecision,
  type AgentPlanRequest,
  type AgentToolCallRequest,
  type AgentToolCallOutcome,
  type AgentToolRuntime,
  type AgentStepEvent
} from '../../../src/dsh-bridge/agent-loop-executor';
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

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A planner that replays a fixed decision list and records every request. */
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
        throw new Error('the scripted planner ran out of decisions');
      }
      return decision;
    }
  };
}

/** A planner that never settles; used to prove abort and timeout really bound it. */
function hangingPlanner(): { planNext: (request: AgentPlanRequest) => Promise<AgentLoopDecision> } {
  return {
    planNext: (): Promise<AgentLoopDecision> => new Promise<never>(() => undefined)
  };
}

/** A tool runtime that records what it was asked to do and what it observed. */
function recordingTools(
  handler: (request: AgentToolCallRequest) => AgentToolCallOutcome = () => ({ result: 'ok', text: 'ok' })
): AgentToolRuntime & { readonly calls: AgentToolCallRequest[] } {
  const calls: AgentToolCallRequest[] = [];
  return {
    calls,
    listTools: () => ['shell', 'read_file'],
    async execute(request: AgentToolCallRequest): Promise<AgentToolCallOutcome> {
      calls.push(request);
      return handler(request);
    }
  };
}

/** A plain IModelAdapter: only complete(), so the executor must degrade. */
function plainAdapter(reply: string, finishReason: ModelResponse['finishReason'] = 'stop'): {
  adapter: IModelAdapter;
  readonly requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  return {
    requests,
    adapter: {
      async complete(request: ModelRequest): Promise<ModelResponse> {
        requests.push(request);
        return { text: reply, finishReason, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
      }
    }
  };
}

/** Branch context handed to the executor by the seam manager. */
function makeContext(overrides: Partial<IsolatedBranchContext> = {}): IsolatedBranchContext {
  return {
    branchId: 'br-7',
    sessionId: 'sess-1',
    namespace: 'harness2:probe_br-7',
    task: makeTask(),
    patch: makePatch(),
    mountedSurfaces: ['system_prompt', 'tool_guidance'],
    signal: new AbortController().signal,
    ...overrides
  };
}

/** Step kinds of a result, in recorded order. */
function stepKinds(result: ProbeExecutionResult): readonly string[] {
  return (result.steps ?? []).map((step: TrajectoryStep) => step.kind);
}

/** Failure-signal kinds of a result. */
function signalKinds(result: ProbeExecutionResult): readonly string[] {
  return (result.failureSignals ?? []).map((signal: FailureSignal) => signal.kind);
}

/** The scripted two-iteration probe used by several tests. */
function twoIterationDecisions(): readonly AgentLoopDecision[] {
  return [
    { kind: 'tool', toolName: 'shell', toolArguments: { cmd: 'ls' }, text: 'inspect the tree' },
    { kind: 'final', text: 'the build now passes', finishReason: 'stop' }
  ];
}

// ---------------------------------------------------------------------------
// tool_guidance projection
// ---------------------------------------------------------------------------

describe('extractToolGuidance', () => {
  it('projects the branch patch tool_guidance surface and marks its source', () => {
    const view = extractToolGuidance(makePatch());
    expect(view.source).toBe('branch_patch');
    expect(view.descriptions.shell).toBe('run a shell command');
    expect(view.priorityOrder).toEqual(['shell']);
    expect(view.examples).toEqual([{ toolName: 'shell', example: 'ls -la' }]);
  });

  it('reports source "none" for a patch that carries no tool_guidance edit', () => {
    const patch = makePatch();
    const withoutGuidance = { ...patch, edits: { system_prompt: patch.edits.system_prompt } };
    const view = extractToolGuidance(withoutGuidance);
    expect(view.source).toBe('none');
    expect(view.descriptions).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// trace shape: model -> tool -> result alternation
// ---------------------------------------------------------------------------

describe('agent loop trajectory shape', () => {
  it('records an alternating model/tool/result trace across two iterations', async () => {
    const planner = scriptedPlanner(twoIterationDecisions());
    const tools = recordingTools();
    const executor = createAgentLoopExecutor(
      { model: planner, tools },
      makeClock(1_000, 10)
    );

    const result = await executor.runBranch(makeContext());

    expect(result.status).toBe('succeeded');
    // iteration 0: model decision, tool call, tool result; iteration 1: model, result
    expect(stepKinds(result)).toEqual(['model', 'tool', 'result', 'model', 'result']);
    expect(result.deliverable?.content).toBe('the build now passes');
    expect(result.metadata?.mode).toBe('agent_loop');
    expect(result.metadata?.maxStepsPerProbe).toBe(DEFAULT_MAX_STEPS_PER_PROBE);

    // Every model call in a probe branch is tagged with purpose 'probe'.
    expect(planner.requests).toHaveLength(2);
    for (const request of planner.requests) {
      expect(request.purpose).toBe('probe');
    }
    // Step indexes are collector-assigned and dense.
    expect((result.steps ?? []).map((step) => step.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('handles several tool calls in one probe with dense alternating indexes', async () => {
    const planner = scriptedPlanner([
      { kind: 'tool', toolName: 'shell', toolArguments: { cmd: 'a' } },
      { kind: 'tool', toolName: 'read_file', toolArguments: { path: 'b' } },
      { kind: 'final', text: 'done' }
    ]);
    const tools = recordingTools();
    const executor = createAgentLoopExecutor({ model: planner, tools }, makeClock());

    const result = await executor.runBranch(makeContext());

    expect(stepKinds(result)).toEqual(['model', 'tool', 'result', 'model', 'tool', 'result', 'model', 'result']);
    expect(result.status).toBe('succeeded');
    expect(tools.calls.map((call) => call.toolName)).toEqual(['shell', 'read_file']);
  });
});

// ---------------------------------------------------------------------------
// the second step observes the tool_guidance patch
// ---------------------------------------------------------------------------

describe('tool_guidance patch visibility', () => {
  it('exposes the branch tool_guidance patch to the planner on the second iteration', async () => {
    const planner = scriptedPlanner(twoIterationDecisions());
    const tools = recordingTools((request) => ({
      result: request.guidance.source === 'branch_patch' ? 'patched-guidance-observed' : 'unpatched',
      text: 'tool ran with branch guidance'
    }));
    const executor = createAgentLoopExecutor({ model: planner, tools }, makeClock());

    await executor.runBranch(makeContext());

    expect(planner.requests).toHaveLength(2);
    for (const request of planner.requests) {
      expect(request.toolGuidance.source).toBe('branch_patch');
      expect(request.toolGuidance.descriptions.shell).toBe('run a shell command');
    }

    // The SECOND iteration must also see the outcome of the first tool call: that
    // is what makes the loop multi-step rather than repeated single calls.
    const second = planner.requests[1];
    expect(second).toBeDefined();
    expect(second?.iteration).toBe(1);
    expect(second?.transcript.map((entry) => entry.kind)).toEqual(['model', 'result']);
    expect(second?.transcript[0]?.toolName).toBe('shell');
    expect(second?.transcript[1]?.toolResult).toBe('patched-guidance-observed');
  });

  it('delivers the patched guidance to the tool call and records what the tool observed', async () => {
    const planner = scriptedPlanner(twoIterationDecisions());
    // A tool that reports back the guidance it actually observed.
    const tools = recordingTools((request) => ({
      result: request.guidance.source === 'branch_patch' ? 'patched-guidance-observed' : 'unpatched',
      text: 'tool ran with branch guidance'
    }));
    const executor = createAgentLoopExecutor({ model: planner, tools }, makeClock());

    const result = await executor.runBranch(makeContext());

    // The tool saw the patch, on iteration 0 of this probe.
    expect(tools.calls).toHaveLength(1);
    const call = tools.calls[0];
    expect(call?.guidance.source).toBe('branch_patch');
    expect(call?.guidance.descriptions.shell).toBe('run a shell command');

    // The recorded result step preserves that observation, so a reviewer can tell a
    // patched run from an unpatched one by reading the trajectory alone.
    const resultStep = (result.steps ?? []).find((step) => step.kind === 'result' && step.toolName === 'shell');
    expect(resultStep).toBeDefined();
    expect(resultStep?.toolResult).toBe('patched-guidance-observed');
    const applied = resultStep?.metadata?.guidanceApplied as { source?: string } | undefined;
    expect(applied?.source).toBe('branch_patch');
  });
});

// ---------------------------------------------------------------------------
// maxStepsPerProbe
// ---------------------------------------------------------------------------

describe('maxStepsPerProbe', () => {
  it('stops a planner that never finishes and reports budget_exhausted', async () => {
    const decisions: AgentLoopDecision[] = Array.from({ length: 10 }, (_unused, index) => ({
      kind: 'tool' as const,
      toolName: 'shell',
      toolArguments: { cmd: 'step-' + String(index) }
    }));
    const planner = scriptedPlanner(decisions);
    const tools = recordingTools();
    const executor = createAgentLoopExecutor({ model: planner, tools, maxStepsPerProbe: 2 }, makeClock());

    const result = await executor.runBranch(makeContext());

    expect(result.status).toBe('failed');
    expect(planner.requests).toHaveLength(2);
    expect(tools.calls).toHaveLength(2);
    expect(signalKinds(result)).toContain('budget_exhausted');
    expect(result.error?.name).toBe('EvoHarnessAgentLoopError');
    // A 'system' step records why the loop stopped.
    expect(stepKinds(result)).toContain('system');
  });

  it('honours a per-probe maxStepsPerProbe override on the branch context metadata', async () => {
    const decisions: AgentLoopDecision[] = Array.from({ length: 10 }, () => ({
      kind: 'tool' as const,
      toolName: 'shell'
    }));
    const planner = scriptedPlanner(decisions);
    const tools = recordingTools();
    const executor = createAgentLoopExecutor({ model: planner, tools, maxStepsPerProbe: 8 }, makeClock());

    const result = await executor.runBranch(makeContext({ metadata: { maxStepsPerProbe: 1 } }));

    expect(planner.requests).toHaveLength(1);
    expect(result.status).toBe('failed');
    expect(result.metadata?.maxStepsPerProbe).toBe(1);
  });

  it('rejects a non-integer maxStepsPerProbe instead of silently coercing it', () => {
    expect(() => createAgentLoopExecutor({ maxStepsPerProbe: 0 })).toThrow(/positive integer/);
    expect(() => createAgentLoopExecutor({ maxStepsPerProbe: 2.5 })).toThrow(/positive integer/);
  });
});

// ---------------------------------------------------------------------------
// AbortSignal and wall-clock budget
// ---------------------------------------------------------------------------

describe('abort and timeout bounds', () => {
  it('settles an aborted probe as aborted without claiming a timeout', async () => {
    const controller = new AbortController();
    const planner = hangingPlanner();
    const tools = recordingTools();
    const executor = createAgentLoopExecutor({ model: planner, tools, probeTimeoutMs: 0 }, makeClock());

    const running = executor.runBranch(makeContext({ signal: controller.signal }));
    setTimeout(() => controller.abort(new Error('caller cancelled')), 5);
    const result = await running;

    expect(result.status).toBe('aborted');
    expect(signalKinds(result)).not.toContain('timeout');
  });

  it('settles an overrun probe as timeout when the planner ignores the signal', async () => {
    const planner = hangingPlanner();
    const tools = recordingTools();
    const executor = createAgentLoopExecutor(
      { model: planner, tools, probeTimeoutMs: 5 },
      makeClock()
    );

    const result = await executor.runBranch(makeContext());

    expect(result.status).toBe('timeout');
    expect(signalKinds(result)).toContain('timeout');
  });

  it('returns an aborted trajectory without dispatching when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const planner = scriptedPlanner(twoIterationDecisions());
    const tools = recordingTools();
    const executor = createAgentLoopExecutor({ model: planner, tools }, makeClock());

    const result = await executor.runBranch(makeContext({ signal: controller.signal }));

    expect(result.status).toBe('aborted');
    expect(planner.requests).toHaveLength(0);
    expect(tools.calls).toHaveLength(0);
    expect(stepKinds(result)).toContain('system');
  });
});

// ---------------------------------------------------------------------------
// single_call degradation
// ---------------------------------------------------------------------------

describe('single_call degradation', () => {
  it('degrades to one model call for a plain IModelAdapter', async () => {
    const { adapter, requests } = plainAdapter('plain reply');
    const tools = recordingTools();
    const executor = createAgentLoopExecutor({ model: asAgentLoopModel(adapter), tools }, makeClock());

    const result = await executor.runBranch(makeContext());

    expect(result.status).toBe('succeeded');
    expect(result.metadata?.mode).toBe('single_call');
    expect(stepKinds(result)).toEqual(['model', 'result']);
    expect(result.deliverable?.content).toBe('plain reply');
    expect(tools.calls).toHaveLength(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.purpose).toBe('probe');
  });

  it('degrades to one model call when no tool runtime is injected', async () => {
    const { adapter, requests } = plainAdapter('no tools here');
    const executor = createAgentLoopExecutor({ model: adapter }, makeClock());

    const result = await executor.runBranch(makeContext());

    expect(result.status).toBe('succeeded');
    expect(result.metadata?.mode).toBe('single_call');
    expect(stepKinds(result)).toEqual(['model', 'result']);
    expect(requests).toHaveLength(1);
  });

  it('records a failed trajectory when no model is injected at all', async () => {
    const tools = recordingTools();
    const executor = createAgentLoopExecutor({ tools }, makeClock());

    const result = await executor.runBranch(makeContext());

    expect(result.status).toBe('failed');
    expect(stepKinds(result)).toContain('error');
    expect(result.error?.name).toBe('EvoHarnessAgentLoopError');
    expect(tools.calls).toHaveLength(0);
  });

  it('flags model_refusal when the single call returns empty text', async () => {
    const { adapter } = plainAdapter('   ');
    const executor = createAgentLoopExecutor({ model: adapter }, makeClock());

    const result = await executor.runBranch(makeContext());

    expect(result.status).toBe('failed');
    expect(signalKinds(result)).toContain('model_refusal');
  });
});

// ---------------------------------------------------------------------------
// tool failures
// ---------------------------------------------------------------------------

describe('tool failures', () => {
  it('records a throwing tool as a ToolErrorRecord and a single tool_error signal', async () => {
    const planner = scriptedPlanner([
      { kind: 'tool', toolName: 'shell', toolArguments: { cmd: 'false' } },
      { kind: 'final', text: 'recovered' }
    ]);
    const tools = recordingTools(() => {
      throw new Error('exit code 1');
    });
    const executor = createAgentLoopExecutor({ model: planner, tools }, makeClock());

    const result = await executor.runBranch(makeContext());

    expect(result.status).toBe('succeeded');
    expect(stepKinds(result)).toContain('error');
    expect(result.toolErrors).toHaveLength(1);
    expect(result.toolErrors?.[0]?.toolName).toBe('shell');
    expect(result.toolErrors?.[0]?.message).toContain('exit code 1');

    // A ToolErrorRecord already becomes a 'tool_error' signal during finalize;
    // pushing one explicitly as well would double-count the failure.
    const toolErrorSignals = (result.failureSignals ?? []).filter((signal) => signal.kind === 'tool_error');
    expect(toolErrorSignals).toHaveLength(1);
  });

  it('treats an isError outcome as a tool error but still lets the loop continue', async () => {
    const planner = scriptedPlanner([
      { kind: 'tool', toolName: 'shell' },
      { kind: 'final', text: 'handled the tool error' }
    ]);
    const tools = recordingTools(() => ({ result: null, text: 'denied', isError: true }));
    const executor = createAgentLoopExecutor({ model: planner, tools }, makeClock());

    const result = await executor.runBranch(makeContext());

    expect(result.status).toBe('succeeded');
    expect(result.toolErrors).toHaveLength(1);
    expect(planner.requests).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// session/event collection
// ---------------------------------------------------------------------------

describe('session/event step collection', () => {
  it('publishes one event per recorded step, in order, with matching indexes', async () => {
    const planner = scriptedPlanner(twoIterationDecisions());
    const tools = recordingTools();
    const events: AgentStepEvent[] = [];
    const executor = createAgentLoopExecutor(
      { model: planner, tools, onStep: (event) => events.push(event) },
      makeClock()
    );

    const result = await executor.runBranch(makeContext());

    expect(result.steps).toBeDefined();
    expect(events.map((event) => event.stepIndex)).toEqual(
      (result.steps ?? []).map((step) => step.index)
    );
    expect(events.map((event) => event.kind)).toEqual(['model', 'tool', 'result', 'model', 'result']);
    for (const event of events) {
      expect(event.channel).toBe('session/event');
      expect(event.sessionId).toBe('sess-1');
      expect(event.branchId).toBe('br-7');
      expect(event.namespace).toBe('harness2:probe_br-7');
      expect(event.mode).toBe('agent_loop');
    }
    // The tool event carries the arguments the planner chose.
    const toolEvent = events.find((event) => event.kind === 'tool');
    expect(toolEvent?.toolName).toBe('shell');
    expect(toolEvent?.toolArguments).toEqual({ cmd: 'ls' });
  });

  it('does not let a throwing event sink break the probe', async () => {
    const planner = scriptedPlanner(twoIterationDecisions());
    const tools = recordingTools();
    const executor = createAgentLoopExecutor(
      {
        model: planner,
        tools,
        onStep: () => {
          throw new Error('sink exploded');
        }
      },
      makeClock()
    );

    const result = await executor.runBranch(makeContext());

    expect(result.status).toBe('succeeded');
    const diagnostics = result.metadata?.trajectory as { diagnostics?: readonly string[] } | undefined;
    expect(diagnostics?.diagnostics?.some((line) => line.includes('sink exploded'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// capability reporting
// ---------------------------------------------------------------------------

describe('describe()', () => {
  it('reports the loop, the budgets and the degradation state', () => {
    const tools = recordingTools();
    const full = createAgentLoopExecutor(
      { model: scriptedPlanner(twoIterationDecisions()), tools, maxStepsPerProbe: 3, probeTimeoutMs: 50 },
      makeClock()
    );
    const capabilities = full.describe().join('\n');
    expect(capabilities).toContain('agent loop');
    expect(capabilities).toContain('max steps per probe: 3');
    expect(capabilities).toContain('50ms wall-clock budget');
    expect(capabilities).toContain('2 tool(s)');

    const degraded = createAgentLoopExecutor(
      { model: asAgentLoopModel(plainAdapter('x').adapter), tools },
      makeClock()
    );
    expect(degraded.describe().join('\n')).toContain('degrades to a single model call');
  });
});