/**
 * R2 integration wiring: host-tool experience production (H2) and the
 * `/evo jit off` runtime gate for L3 + mirror (F1).
 *
 * The point of this file is to close the exact hole the T9 review found: the
 * previous P5 tests injected an advisor with its own retriever, so the default
 * `kernel.createHostAdvisor()` branch was never exercised and the missing
 * `host_tool` producer stayed invisible. Everything below goes through
 * `createEvoHarnessPlugin` + the real DSH hook listeners with **no injected
 * advisor and no injected retriever**.
 */
import { describe, expect, it } from 'vitest';

import { createHookFixture } from '../cordis-seams/hook-fixtures';
import type { HookFixture } from '../cordis-seams/hook-fixtures';
import { buildE2E } from '../../e2e/fixtures';

/** Minimal DSH hook context: on() + one service for real hook detection. */
function dshContext(): HookFixture {
  const fixture = createHookFixture();
  const ctx = fixture.ctx as Record<string, unknown>;
  ctx['tools'] = { execute: () => undefined };
  ctx['systemPrompt'] = { assemble: () => ({ sections: [] }) };
  return fixture;
}

const GATE_ADVISOR = {
  enabled: true,
  mode: 'gate',
  adviseThreshold: -0.2,
  gateThreshold: -0.2,
  minSupport: 1
};

const ADVISORY_ADVISOR = {
  enabled: true,
  mode: 'advisory',
  adviseThreshold: -0.2,
  gateThreshold: -0.2,
  minSupport: 1
};

const SILENT_ADVISOR = {
  enabled: false,
  mode: 'advisory',
  adviseThreshold: -0.5,
  gateThreshold: -0.8,
  minSupport: 5
};

const accept = async () => ({ kind: 'accept' });
const allow = async () => ({ kind: 'allow' });
const enter = async () => ({ kind: 'enter', messages: [] });

type Listener = (...args: unknown[]) => Promise<unknown>;

/**
 * Feed the real post-execute listener: three failing `bash` calls (the 2nd/3rd
 * repeat the same error) and two successful `edit` calls. The canary in `input`
 * and in the raw error text must never reach experience.
 */
async function accumulateHostToolExperience(fixture: HookFixture): Promise<void> {
  const postExecute = fixture.listener('tools/post-execute') as unknown as Listener;
  const failed = {
    isError: true,
    exitCode: 127,
    errorClass: 'exit_127',
    stderr: 'bash: ghp_CANARY_TOKEN_SECRET failed'
  };
  for (let index = 0; index < 3; index += 1) {
    await postExecute(
      {
        name: 'bash',
        input: { command: 'curl -H "Authorization: Bearer CANARY-COMMAND-SECRET"' }
      },
      failed,
      accept
    );
  }
  for (let index = 0; index < 2; index += 1) {
    await postExecute({ name: 'edit', input: { path: 'src/index.ts' } }, { isError: false }, accept);
  }
}

function fakeMirrorClient() {
  const calls = { listTools: 0, callTool: 0, tools: [] as string[] };
  const client = {
    serverId: 'fake-memory',
    async listTools() {
      calls.listTools += 1;
      return [
        {
          name: 'write_note',
          inputSchema: { properties: { text: {}, path: {}, tags: {}, metadata: {} } }
        }
      ];
    },
    async callTool(name: string, args: Record<string, unknown>) {
      calls.callTool += 1;
      calls.tools.push(JSON.stringify(args));
      return { ok: true };
    }
  };
  return { client, calls };
}

async function runOnce(plugin: ReturnType<typeof buildE2E>['plugin'], id: string) {
  return plugin.run({
    sessionId: 'sess-' + id,
    task: plugin.makeTask({ id, prompt: 'Fix the failing build.' }),
    trigger: 'always'
  });
}

describe('H2: the default advisor gets real host_tool evidence', () => {
  it('records post-execute results and makes the default gate produce ask', async () => {
    const fixture = dshContext();
    const harness = buildE2E({
      ctx: fixture.ctx as never,
      config: { jitrl: { hostAdvisor: GATE_ADVISOR } }
    });
    const plugin = harness.plugin;

    // No injected advisor / retriever: this is kernel.createHostAdvisor().
    expect(plugin.jitrl.hostAdvisor?.attached).toBe(true);
    expect(plugin.jitrl.hostToolExperiences).toBe(0);

    await accumulateHostToolExperience(fixture);

    // Records really landed in the kernel store at level 'host_tool'.
    expect(plugin.jitrl.hostToolExperiences).toBeGreaterThanOrEqual(5);

    // The turn/end listener is optional but reachable on this fixture.
    const turnEnd = fixture.listener('turn/end') as unknown as Listener;
    await turnEnd({ sessionId: 'sess-turn', reason: { kind: 'completed' } });
    expect(plugin.jitrl.hostToolExperiences).toBeGreaterThanOrEqual(6);

    const preExecute = fixture.listener('tools/pre-execute') as unknown as Listener;
    const decision = (await preExecute({ name: 'bash' }, allow)) as {
      kind: string;
      reason?: string;
    };
    expect(decision.kind).toBe('ask');
    expect(decision.kind).not.toBe('deny');
    expect(decision.reason).toContain('gateThreshold');
    expect(plugin.jitrl.hostAdvisor?.ask).toBe(1);
    expect(plugin.jitrl.hostAdvisor?.runtimeEnabled).toBe(true);

    await plugin.dispose();
  });

  it('records the same evidence for advisory mode and injects advice', async () => {
    const fixture = dshContext();
    const harness = buildE2E({
      ctx: fixture.ctx as never,
      config: { jitrl: { hostAdvisor: ADVISORY_ADVISOR } }
    });
    const plugin = harness.plugin;
    expect(plugin.jitrl.hostAdvisor?.attached).toBe(true);

    await accumulateHostToolExperience(fixture);
    expect(plugin.jitrl.hostToolExperiences).toBeGreaterThanOrEqual(5);

    const preStep = fixture.listener('agent/pre-step') as unknown as Listener;
    const decision = (await preStep({ sessionId: 'sess-adv' }, enter)) as {
      kind: string;
      additionalContexts?: string[];
    };
    expect(decision.additionalContexts).toHaveLength(1);
    expect(decision.additionalContexts?.[0]).toContain('<jitrl_advice');
    // Plan section 7.2: the negative evidence sits in the anti-pattern slot.
    expect(decision.additionalContexts?.[0]).toContain('anti_patterns_to_avoid');
    expect(plugin.jitrl.hostAdvisor?.advisory).toBe(1);

    await plugin.dispose();
  });

  it('never stores raw command text or secrets (aggregate mirror payload)', async () => {
    const fixture = dshContext();
    const fake = fakeMirrorClient();
    const harness = buildE2E({
      ctx: fixture.ctx as never,
      config: {
        jitrl: { hostAdvisor: GATE_ADVISOR, store: { mirrorToMemoryBridge: true } }
      },
      extra: { mirrorClient: fake.client }
    });
    const plugin = harness.plugin;

    await accumulateHostToolExperience(fixture);
    await runOnce(plugin, 'task-privacy');

    expect(fake.calls.callTool).toBeGreaterThan(0);
    const payload = fake.calls.tools.join('\n');
    expect(payload).not.toContain('CANARY-COMMAND-SECRET');
    expect(payload).not.toContain('ghp_CANARY_TOKEN_SECRET');
    expect(payload).not.toContain('curl -H');
    // The mirrored rows still contain the abstract statistics/keys.
    expect(payload).toContain('host_tool');
    expect(payload).toContain('tool:bash');

    await plugin.dispose();
  });
});

describe('F1: /evo jit off gates L3 advice, gate asks, mirror and collection', () => {
  it('stops and restores gate asks plus mirror calls', async () => {
    const fixture = dshContext();
    const fake = fakeMirrorClient();
    const harness = buildE2E({
      ctx: fixture.ctx as never,
      config: {
        jitrl: { hostAdvisor: GATE_ADVISOR, store: { mirrorToMemoryBridge: true } }
      },
      extra: { mirrorClient: fake.client }
    });
    const plugin = harness.plugin;
    await accumulateHostToolExperience(fixture);

    // Baseline: a run mirrors, a gate dispatch asks.
    await runOnce(plugin, 'task-f1-before');
    const callsBefore = plugin.jitrl.mirror?.calls ?? 0;
    expect(callsBefore).toBeGreaterThan(0);
    const preExecute = fixture.listener('tools/pre-execute') as unknown as Listener;
    const postExecute = fixture.listener('tools/post-execute') as unknown as Listener;
    expect(((await preExecute({ name: 'bash' }, allow)) as { kind: string }).kind).toBe('ask');
    const askBefore = plugin.jitrl.hostAdvisor?.ask ?? 0;

    // OFF: runtime gate closes every L3 surface at once.
    const off = await plugin.runFromCommand('jit off');
    expect(off.jitCommand?.ok).toBe(true);
    expect((off.jitCommand?.json as Record<string, unknown>)['enabled']).toBe(false);
    expect(plugin.jitrl.hostAdvisor?.runtimeEnabled).toBe(false);

    expect(((await preExecute({ name: 'bash' }, allow)) as { kind: string }).kind).toBe('allow');
    expect(plugin.jitrl.hostAdvisor?.ask).toBe(askBefore);

    const experiencesWhileOff = plugin.jitrl.hostToolExperiences ?? 0;
    await postExecute({ name: 'bash' }, { isError: true, exitCode: 1 }, accept);
    expect(plugin.jitrl.hostToolExperiences).toBe(experiencesWhileOff);

    await runOnce(plugin, 'task-f1-off');
    expect(plugin.jitrl.mirror?.calls).toBe(callsBefore);

    // ON: everything comes back.
    const on = await plugin.runFromCommand('jit on');
    expect(on.jitCommand?.ok).toBe(true);
    expect((on.jitCommand?.json as Record<string, unknown>)['enabled']).toBe(true);
    expect(plugin.jitrl.hostAdvisor?.runtimeEnabled).toBe(true);

    expect(((await preExecute({ name: 'bash' }, allow)) as { kind: string }).kind).toBe('ask');
    expect(plugin.jitrl.hostAdvisor?.ask).toBe(askBefore + 1);

    await runOnce(plugin, 'task-f1-on');
    expect(plugin.jitrl.mirror?.calls).toBeGreaterThan(callsBefore);

    await postExecute({ name: 'bash' }, { isError: true, exitCode: 1 }, accept);
    expect(plugin.jitrl.hostToolExperiences).toBeGreaterThan(experiencesWhileOff);

    await plugin.dispose();
  });

  it('stops and restores advisory injection', async () => {
    const fixture = dshContext();
    const harness = buildE2E({
      ctx: fixture.ctx as never,
      config: { jitrl: { hostAdvisor: ADVISORY_ADVISOR } }
    });
    const plugin = harness.plugin;
    await accumulateHostToolExperience(fixture);
    const preStep = fixture.listener('agent/pre-step') as unknown as Listener;

    // ON by default: advice appears.
    const before = (await preStep({ sessionId: 'sess-view' }, enter)) as {
      additionalContexts?: string[];
    };
    expect(before.additionalContexts?.[0]).toContain('<jitrl_advice');

    await plugin.runFromCommand('jit off');
    const whileOff = (await preStep({ sessionId: 'sess-view' }, enter)) as {
      additionalContexts?: string[];
    };
    expect(whileOff.additionalContexts).toBeUndefined();

    await plugin.runFromCommand('jit on');
    const restored = (await preStep({ sessionId: 'sess-view' }, enter)) as {
      additionalContexts?: string[];
    };
    expect(restored.additionalContexts?.[0]).toContain('<jitrl_advice');

    await plugin.dispose();
  });
});

describe('default silence: hostAdvisor.enabled=false stays inert', () => {
  it('collects nothing, asks nothing and injects nothing', async () => {
    const fixture = dshContext();
    const harness = buildE2E({
      ctx: fixture.ctx as never,
      config: { jitrl: { hostAdvisor: SILENT_ADVISOR } }
    });
    const plugin = harness.plugin;

    expect(plugin.jitrl.hostAdvisor?.enabled).toBe(false);
    expect(plugin.jitrl.hostAdvisor?.attached).toBe(false);
    // The producer itself is gated by the L3 switch: default is zero writes.
    expect(plugin.jitrl.hostToolExperiences).toBe(0);

    const postExecute = fixture.listener('tools/post-execute') as unknown as Listener;
    await postExecute({ name: 'bash' }, { isError: true, exitCode: 1 }, accept);
    expect(plugin.jitrl.hostToolExperiences).toBe(0);

    const preExecute = fixture.listener('tools/pre-execute') as unknown as Listener;
    expect(((await preExecute({ name: 'bash' }, allow)) as { kind: string }).kind).toBe('allow');
    const preStep = fixture.listener('agent/pre-step') as unknown as Listener;
    const decision = (await preStep({ sessionId: 'sess-silent' }, enter)) as {
      additionalContexts?: string[];
    };
    expect(decision.additionalContexts).toBeUndefined();

    const counters = plugin.jitrl.hostAdvisor;
    expect(counters?.advisory).toBe(0);
    expect(counters?.ask).toBe(0);
    expect(counters?.noop).toBe(0);

    await plugin.dispose();
  });
});
