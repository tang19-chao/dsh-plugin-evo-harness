/**
 * TEST-2 (cross-audit §6): the composition the automated suite never ran —
 * a REAL agent-loop executor as the branch executor, behind the REAL seam
 * manager and the REAL orchestrator.
 *
 * Every other e2e injects `createScriptedRunner` (tests/e2e/fixtures.ts:214), so
 * a `ProbeExecutionResult` is canned by the runner and the seam between "patch
 * selected" and "probe observed" is never executed: the seam manager's mounts and
 * the orchestrator's wiring could rot green behind it. This file closes that seam:
 *
 *   1. the plugin builds its OWN `createCordisSeamManager` over a real hook host
 *      (the contract-smoke waterfall fixture) with the structured in-memory host
 *      as its fallback, so every surface mount is a real mount;
 *   2. the branch executor is `createAgentLoopExecutor` (scripted planner +
 *      in-memory tool runtime), so each probe is a real model -> tool -> result
 *      loop inside the branch the manager forked;
 *   3. the branch patch's `tool_guidance` really reaches the tool call (the tool
 *      reports what it observed), and the composed winner is really MOUNTED
 *      (guarded-active + applyWinningPatch) as a live host effect.
 *
 * In-process only: no DSH runtime, no network, no model call, no real sandbox.
 */
import { describe, expect, it } from 'vitest';
import { createDshHookHostAdapter, createInMemoryCordisHost } from '../../src/cordis-seams';
import {
  createAgentLoopExecutor,
  type AgentLoopDecision,
  type AgentPlanRequest,
  type AgentToolCallOutcome,
  type AgentToolCallRequest,
  type AgentToolRuntime
} from '../../src/dsh-bridge/agent-loop-executor';
import { createEvoHarnessPlugin } from '../../src/index';
import type { BranchExecutor, IsolatedBranchContext, ProbeExecutionResult } from '../../src/types/contracts';
import { createHookFixture } from '../unit/cordis-seams/hook-fixtures';
import {
  createScriptedModel,
  e2eConfig,
  makeClock,
  makeIdFactory,
  mem0LikeServer
} from './fixtures';

/** The tool the probe may call, and the guidance text the patch must deliver. */
const PROBE_TOOL = 'shell';
const PATCHED_GUIDANCE = 'run the project test suite before answering';

/** Proposal payload that edits the tool_guidance surface (the observable one). */
function toolGuidanceProposal(): Record<string, unknown> {
  return {
    rationale: 'Tell the probe which tool to prefer and how to use it.',
    focusSurfaces: ['tool_guidance'],
    confidence: 0.75,
    expectedStepsDelta: -1,
    edits: {
      tool_guidance: {
        kind: 'tool_guidance',
        descriptions: { [PROBE_TOOL]: PATCHED_GUIDANCE },
        priorityOrder: [PROBE_TOOL]
      }
    }
  };
}

interface RecordedToolCall {
  readonly toolName: string;
  readonly guidanceSource: string;
  readonly description: string | undefined;
}

/** An in-memory tool runtime that records the guidance each call observed. */
function recordingTools(): AgentToolRuntime & { readonly calls: RecordedToolCall[] } {
  const calls: RecordedToolCall[] = [];
  return {
    calls,
    listTools(): readonly string[] {
      return [PROBE_TOOL];
    },
    async execute(request: AgentToolCallRequest): Promise<AgentToolCallOutcome> {
      calls.push({
        toolName: request.toolName,
        guidanceSource: request.guidance.source,
        description: request.guidance.descriptions[request.toolName]
      });
      return {
        result: { exitCode: 0 },
        text: 'tests pass',
        guidanceApplied: request.guidance
      };
    }
  };
}

/**
 * A planner whose behaviour depends on what the branch actually mounted: an
 * UNPATCHED branch (the reference run, whose patch carries no edits) finishes
 * with an empty answer; a PATCHED branch runs one real tool call, then answers.
 */
function patchedBranchPlanner(): {
  planNext(request: AgentPlanRequest): Promise<AgentLoopDecision>;
  readonly requests: AgentPlanRequest[];
  readonly toolDecisions: number;
} {
  const requests: AgentPlanRequest[] = [];
  const state = { toolDecisions: 0 };
  return {
    requests,
    get toolDecisions(): number {
      return state.toolDecisions;
    },
    async planNext(request: AgentPlanRequest): Promise<AgentLoopDecision> {
      requests.push(request);
      if (request.toolGuidance.source !== 'branch_patch') {
        // Reference branch: no patch => no deliverable (recorded as model_refusal).
        return { kind: 'final', text: '   ' };
      }
      if (request.transcript.some((entry) => entry.kind === 'result')) {
        return { kind: 'final', text: 'the patched guidance was followed: tests pass' };
      }
      state.toolDecisions += 1;
      return { kind: 'tool', toolName: PROBE_TOOL, toolArguments: { cmd: 'pnpm test' } };
    }
  };
}

/**
 * The REAL executor, wrapped only to record what it returned per branch.
 *
 * The recorder is observation, not substitution: the returned object is the
 * executor's own `ProbeExecutionResult`, and no field is altered.
 */
function recordingExecutor(base: BranchExecutor): {
  runBranch: BranchExecutor;
  readonly results: Array<{ branchId: string; patchId: string; result: ProbeExecutionResult }>;
} {
  const results: Array<{ branchId: string; patchId: string; result: ProbeExecutionResult }> = [];
  return {
    results,
    runBranch: async (context: IsolatedBranchContext): Promise<ProbeExecutionResult> => {
      const result = await base(context);
      results.push({ branchId: context.branchId, patchId: context.patch.id, result });
      return result;
    }
  };
}

describe('TEST-2: real agent-loop executor behind a real seam manager and orchestrator', () => {
  it('mounts the branch patch, its tool call observes it, and the composed winner is really mounted', async () => {
    const now = makeClock();
    const fixture = createHookFixture();
    const fallback = createInMemoryCordisHost();
    // A REAL hook host: the four harness waterfalls are live (contract-smoke),
    // and every surface it cannot serve itself is forwarded to the structured
    // in-memory host, whose effects stay observable after the branch is gone.
    const host = createDshHookHostAdapter(fixture.ctx, { fallback });
    const tools = recordingTools();
    const planner = patchedBranchPlanner();

    // The real multi-step loop: model decision -> tool call -> result, inside
    // the isolated branch the seam manager already forked.
    const executor = createAgentLoopExecutor(
      { model: planner, tools, maxStepsPerProbe: 3, createTrajectoryId: makeIdFactory('real-traj') },
      now
    );
    const recorder = recordingExecutor(executor.runBranch);

    const plugin = createEvoHarnessPlugin({
      config: e2eConfig({ config: { execution: { mode: 'guarded-active', applyWinningPatch: true } } }),
      model: createScriptedModel({ proposals: [toolGuidanceProposal()] }),
      clients: [mem0LikeServer().client],
      // The plugin builds its own real seam manager over the injected host;
      // only the executor is injected, exactly as a host integrator would.
      host,
      runBranch: recorder.runBranch,
      now,
      newId: makeIdFactory('real')
    });

    expect(plugin.hostAdapterSource).toBe('injected');
    expect(plugin.diagnostics.join(' ')).toContain('branch executor supplied by the caller');

    const task = plugin.makeTask({
      id: 'task-real-exec',
      prompt: 'Fix the failing build and prove the patched guidance is followed.'
    });
    const result = await plugin.run({ sessionId: 'sess-real-exec', task, trigger: 'always' });

    expect(result.outcome).toBe('composed');
    // Reference anchor + at least one candidate actually ran through the executor.
    expect(result.probesRun).toBeGreaterThanOrEqual(2);
    expect(recorder.results.length).toBe(result.probesRun);
    // The candidate probe really alternated model -> tool -> result...
    expect(planner.toolDecisions).toBeGreaterThanOrEqual(1);
    // ...and EVERY candidate tool call observed the BRANCH patch, never a
    // canned result and never the unpatched default.
    const patchedCalls = tools.calls.filter((call) => call.guidanceSource === 'branch_patch');
    expect(patchedCalls.length).toBe(planner.toolDecisions);
    expect(patchedCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of patchedCalls) {
      expect(call.toolName).toBe(PROBE_TOOL);
      expect(call.description).toBe(PATCHED_GUIDANCE);
    }
    // No probe saw the unpatched view: the reference run never reaches a tool.
    expect(tools.calls.filter((call) => call.guidanceSource !== 'branch_patch')).toEqual([]);
    // The reference probe ran the SAME executor but its patch carries no edits,
    // so its planner saw no branch guidance: no tool call, one model step and
    // the empty-answer refusal. That contrast is caused by the mount.
    const referenceProbe = recorder.results.find((entry) => entry.result.status === 'failed');
    expect(referenceProbe).toBeDefined();
    // One model step, one result step: the refusal is carried by the trajectory
    // error / failureSignal, not by an extra step.
    expect(referenceProbe?.result.steps?.map((step) => step.kind)).toEqual(['model', 'result']);
    expect(referenceProbe?.result.error?.name).toBe('EvoHarnessAgentModelError');
    // The collector additionally derives an 'unknown' signal from the recorded
    // trajectory error, so the refusal is the FIRST signal and never absent.
    expect(referenceProbe?.result.failureSignals?.map((signal) => signal.kind)).toContain('model_refusal');

    // The composed winner is MOUNTED for real (guarded-active path): the
    // orchestrator reports it and the host carries a live effect for it.
    expect(result.composedPatchId).toBeDefined();
    expect(plugin.orchestrator.activePatchIds()).toEqual([result.composedPatchId]);
    const live = fallback.effects.filter(
      (effect) =>
        effect.active &&
        effect.operation === 'tool_guidance' &&
        effect.namespace.indexOf(String(result.composedPatchId)) >= 0
    );
    expect(live).toHaveLength(1);
    expect((live[0]?.spec as { descriptions?: Record<string, string> }).descriptions?.[PROBE_TOOL]).toBe(
      PATCHED_GUIDANCE
    );
    // The mount is host-class (ADR 0006 D-P4-4): only a permanent patch may.
    expect((live[0]?.spec as { mountScope?: string }).mountScope).toBe('host');

    // Nothing probe-scoped survives the run: the permanent winner is the only
    // live effect left on the structured host.
    expect(plugin.orchestrator.treePool.size()).toBe(1);
    expect(fallback.activeEffects().length).toBe(1);

    await plugin.dispose();
  });

  it('the orchestrator consumes the executor-owned trajectory instead of a fabricated one', async () => {
    const now = makeClock();
    const fixture = createHookFixture();
    const fallback = createInMemoryCordisHost();
    const host = createDshHookHostAdapter(fixture.ctx, { fallback });
    const tools = recordingTools();
    const planner = patchedBranchPlanner();

    const executor = createAgentLoopExecutor(
      { model: planner, tools, maxStepsPerProbe: 3, createTrajectoryId: makeIdFactory('real-traj-2') },
      now
    );
    const recorder = recordingExecutor(executor.runBranch);

    const plugin = createEvoHarnessPlugin({
      config: e2eConfig({ config: { execution: { mode: 'guarded-active', applyWinningPatch: true } } }),
      model: createScriptedModel({ proposals: [toolGuidanceProposal()] }),
      clients: [mem0LikeServer().client],
      host,
      runBranch: recorder.runBranch,
      now,
      newId: makeIdFactory('real2')
    });

    const task = plugin.makeTask({ id: 'task-real-shape', prompt: 'Show the probe trace the executor produced.' });
    const result = await plugin.run({ sessionId: 'sess-real-shape', task, trigger: 'always' });
    expect(result.outcome).toBe('composed');

    // The winning probe's result is the executor's own model -> tool -> result
    // alternation, and its trajectory metadata proves the guidance reached the
    // tool (the orchestrator never fabricates either fact).
    const candidate = recorder.results.find((entry) => entry.result.status === 'succeeded');
    expect(candidate).toBeDefined();
    expect(candidate?.result.steps?.map((step) => step.kind)).toEqual([
      'model',
      'tool',
      'result',
      'model',
      'result'
    ]);
    const resultStep = candidate?.result.steps?.find((step) => step.kind === 'result' && step.toolName === PROBE_TOOL);
    expect(resultStep?.metadata?.['guidanceSource']).toBe('branch_patch');
    expect(candidate?.result.metadata?.['mode']).toBe('agent_loop');

    const composition = plugin.orchestrator.lastComposition();
    expect(composition).not.toBeNull();
    expect(composition?.assessments.some((assessment) => assessment.selected)).toBe(true);
    expect(Object.values(plugin.orchestrator.treePool.list()[0]?.nodes ?? {}).some((node) => node.status === 'succeeded'))
      .toBe(true);

    await plugin.dispose();
  });
});
