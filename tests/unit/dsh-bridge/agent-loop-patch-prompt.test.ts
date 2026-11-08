/**
 * A1-b contract (rev6 audit): the multi-step agent probe must see the patch
 * BODY, not only its id/rationale. The default builder is patch-aware in BOTH
 * execution shapes; a host-supplied builder/systemPrompt keeps precedence.
 */
import { describe, expect, it } from 'vitest';

import {
  asAgentLoopModel,
  createAgentLoopExecutor,
  defaultAgentProbeMessages,
  type AgentLoopDecision,
  type AgentLoopModel,
  type AgentPlanRequest,
  type AgentToolCallOutcome,
  type AgentToolCallRequest,
  type AgentToolRuntime
} from '../../../src/dsh-bridge/agent-loop-executor';
import { PATCH_PROMPT_PREFIX } from '../../../src/dsh-bridge/patch-prompt';
import type {
  EightSurfaceEdits,
  IModelAdapter,
  IsolatedBranchContext,
  ModelMessage,
  ModelRequest,
  ModelResponse
} from '../../../src/types/contracts';
import { makeClock, makePatch, makeTask } from '../cordis-seams/fixtures';

const MARK_SYS = 'AGENT_MARK_SYS_5129';
const MARK_GUARD = 'AGENT_MARK_GUARD_3374';

/** The two edited surfaces both modes must render. */
function markerEdits(): EightSurfaceEdits {
  return {
    system_prompt: { kind: 'system_prompt', mode: 'append', content: MARK_SYS },
    guardrails: { kind: 'guardrails', formatContract: MARK_GUARD }
  };
}

function contextWith(edits: EightSurfaceEdits): IsolatedBranchContext {
  return {
    branchId: 'br-agent-a1',
    sessionId: 'sess-agent-a1',
    namespace: 'harness2:probe_br-agent-a1',
    task: makeTask({ prompt: 'Fix the failing build.' }),
    patch: makePatch({ edits }),
    mountedSurfaces: ['system_prompt', 'guardrails'],
    signal: new AbortController().signal
  };
}

/** A tool runtime is required for agent_loop mode selection. */
function recordingTools(): AgentToolRuntime {
  return {
    listTools: () => ['shell'],
    async execute(_request: AgentToolCallRequest): Promise<AgentToolCallOutcome> {
      return { result: 'ok', text: 'ok' };
    }
  };
}

/** One planner that records the messages of every decision and finishes at once. */
function recordingPlanner(): AgentLoopModel & { readonly messages: readonly ModelMessage[][] } {
  const messages: ModelMessage[][] = [];
  return {
    messages,
    async planNext(request: AgentPlanRequest): Promise<AgentLoopDecision> {
      messages.push([...request.messages]);
      return { kind: 'final', text: 'the build now passes' };
    }
  };
}

/** One plain adapter that records the messages of the single model call. */
function recordingCompleter(): {
  readonly adapter: IModelAdapter;
  readonly messages: readonly ModelMessage[][];
} {
  const messages: ModelMessage[][] = [];
  return {
    messages,
    adapter: {
      async complete(request: ModelRequest): Promise<ModelResponse> {
        messages.push([...request.messages]);
        return { text: 'the build now passes', finishReason: 'stop' };
      }
    }
  };
}

function messageTexts(messages: readonly ModelMessage[]): string {
  return messages.map((message) => message.content).join('\n');
}

describe('agent-loop default prompt is patch-aware in both execution shapes', () => {
  it('agent_loop: the planner sees header -> patch -> task', async () => {
    const planner = recordingPlanner();
    const executor = createAgentLoopExecutor(
      { model: planner, tools: recordingTools() },
      makeClock()
    );
    const context = contextWith(markerEdits());
    await executor.runBranch(context);

    const messages = planner.messages[0] ?? [];
    const base = defaultAgentProbeMessages(context);
    expect(messages).toHaveLength(base.length + 1);
    expect(messages[0]).toEqual(base[0]);
    expect(messages[1]?.role).toBe('system');
    expect(messages[1]?.content.startsWith(PATCH_PROMPT_PREFIX + '\n')).toBe(true);
    expect(messageTexts(messages)).toContain(MARK_SYS);
    expect(messageTexts(messages)).toContain(MARK_GUARD);
    expect(messages.at(-1)).toEqual(base.at(-1));
  });

  it('single_call: the completion request sees the same patched messages', async () => {
    const completer = recordingCompleter();
    const executor = createAgentLoopExecutor(
      { model: asAgentLoopModel(completer.adapter) },
      makeClock()
    );
    const context = contextWith(markerEdits());
    const result = await executor.runBranch(context);

    expect(result.metadata?.mode).toBe('single_call');
    const messages = completer.messages[0] ?? [];
    const base = defaultAgentProbeMessages(context);
    expect(messages).toHaveLength(base.length + 1);
    expect(messages[0]).toEqual(base[0]);
    expect(messageTexts(messages)).toContain(MARK_SYS);
    expect(messageTexts(messages)).toContain(MARK_GUARD);
    expect(messages.at(-1)).toEqual(base.at(-1));
  });

  it('an empty patch reproduces defaultAgentProbeMessages byte-for-byte', async () => {
    const planner = recordingPlanner();
    const executor = createAgentLoopExecutor(
      { model: planner, tools: recordingTools() },
      makeClock()
    );
    const context = contextWith({});
    await executor.runBranch(context);
    expect(planner.messages[0]).toEqual(defaultAgentProbeMessages(context));
  });

  it('a host buildMessages stays authoritative and is never augmented with the patch', async () => {
    const planner = recordingPlanner();
    const executor = createAgentLoopExecutor(
      {
        model: planner,
        tools: recordingTools(),
        buildMessages: () => [{ role: 'system' as const, content: 'CUSTOM' }]
      },
      makeClock()
    );
    await executor.runBranch(contextWith(markerEdits()));

    const messages = planner.messages[0] ?? [];
    expect(messages).toEqual([{ role: 'system', content: 'CUSTOM' }]);
    expect(messageTexts(messages)).not.toContain(MARK_SYS);
    expect(messageTexts(messages)).not.toContain(PATCH_PROMPT_PREFIX);
  });

  it('a host systemPrompt is prepended while the patch block remains', async () => {
    const planner = recordingPlanner();
    const executor = createAgentLoopExecutor(
      {
        model: planner,
        tools: recordingTools(),
        systemPrompt: () => 'SYS'
      },
      makeClock()
    );
    await executor.runBranch(contextWith(markerEdits()));

    const messages = planner.messages[0] ?? [];
    expect(messages[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(messages[1]).toEqual(defaultAgentProbeMessages(contextWith(markerEdits()))[0]);
    expect(messages[2]?.content.startsWith(PATCH_PROMPT_PREFIX + '\n')).toBe(true);
    expect(messageTexts(messages)).toContain(MARK_SYS);
  });

  it('never renders non-evaluable surface bodies inside the agent prompt', async () => {
    const planner = recordingPlanner();
    const executor = createAgentLoopExecutor(
      { model: planner, tools: recordingTools() },
      makeClock()
    );
    const context: IsolatedBranchContext = { ...contextWith(markerEdits()), patch: makePatch() };
    await executor.runBranch(context);

    const text = messageTexts(planner.messages[0] ?? []);
    expect(text).toContain('## not evaluable in a text probe: scripts, subagents, plugins');
    expect(text).not.toContain('print(1)');
    expect(text).not.toContain('explore the repo');
    expect(text).not.toContain('export default () => undefined;');
  });
});
