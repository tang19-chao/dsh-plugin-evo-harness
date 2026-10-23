/**
 * P5 integration wiring: L3 host advisor (advisory / gate) and the aggregate
 * statistics mirror through the REAL plugin entrypoint (plan sections 3.3, 7.2,
 * §8 Phase 5).
 *
 * These tests mount the plugin over a fake DSH hook context and dispatch the
 * actual `agent/pre-step` and `tools/pre-execute` listeners. That is the only way
 * to prove "the advisor/mirror is reachable in production"; instantiating the
 * modules directly would repeat their own unit tests.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { createHostAdvisor } from '../../../src/jitrl';
import type { HostAdvisor } from '../../../src/jitrl';
import { parseEvoHarnessConfig } from '../../../src/config';
import { createHookFixture } from '../cordis-seams/hook-fixtures';
import { buildE2E, e2eConfig } from '../../e2e/fixtures';
import type { ExperienceRecord } from '../../../src/types/contracts';

afterEach(() => {
  // Each test owns an isolated fixture/plugin; nothing global to reset.
});

const GATE_CONFIG = {
  jitrl: {
    hostAdvisor: {
      enabled: true,
      mode: 'gate',
      adviseThreshold: -0.5,
      gateThreshold: -0.8,
      minSupport: 1
    }
  }
} as const;

const ADVISORY_CONFIG = {
  jitrl: {
    hostAdvisor: {
      enabled: true,
      mode: 'advisory',
      adviseThreshold: -0.5,
      gateThreshold: -0.8,
      minSupport: 1
    }
  }
} as const;

/** One host_tool experience; only statistics are used by the advisor. */
function hostToolRecord(
  id: string,
  actionKey: string,
  value: number
): ExperienceRecord {
  return {
    id,
    level: 'host_tool',
    state: {
      level: 'host_tool',
      bucket: 'host|tools:bash+edit|err:none',
      tokens: ['tool:bash', 'tool:edit', 'err:none'],
      summary: 'bash+edit err:none'
    },
    actionKey,
    reward: value,
    return: value,
    rewardSources: { tool: value },
    guidance: 'memory',
    policyId: 'pi-0',
    sessionId: 'sess-p5',
    createdAt: 1_700_000_000_000,
    redacted: true
  };
}

/** Two evidenced actions: bash is clearly worse than edit. */
function seededRetriever() {
  const scored = [
    { record: hostToolRecord('bash-1', 'bash', -1), similarity: 1, weight: 1 },
    { record: hostToolRecord('bash-2', 'bash', -1), similarity: 1, weight: 1 },
    { record: hostToolRecord('edit-1', 'edit', 1), similarity: 1, weight: 1 },
    { record: hostToolRecord('edit-2', 'edit', 1), similarity: 1, weight: 1 }
  ];
  return () => scored;
}

function gateAdvisor(): HostAdvisor {
  const config = parseEvoHarnessConfig(e2eConfig({ config: GATE_CONFIG }));
  return createHostAdvisor({ config: config.jitrl, retriever: seededRetriever() });
}

function advisoryAdvisor(): HostAdvisor {
  const config = parseEvoHarnessConfig(e2eConfig({ config: ADVISORY_CONFIG }));
  return createHostAdvisor({ config: config.jitrl, retriever: seededRetriever() });
}

/** DSH hook context with just enough services for real hook detection. */
function dshContext() {
  const fixture = createHookFixture();
  const ctx = fixture.ctx as Record<string, unknown>;
  ctx['tools'] = { execute: () => undefined };
  ctx['systemPrompt'] = { assemble: () => ({ sections: [] }) };
  return fixture;
}

async function allow() {
  return { kind: 'allow' } as const;
}

async function enter() {
  return { kind: 'enter', messages: [] } as const;
}

describe('L3 advisor wiring (gate)', () => {
  it('attaches to the real hook adapter and forwards ask, never deny', async () => {
    const fixture = dshContext();
    const harness = buildE2E({
      ctx: fixture.ctx as never,
      config: GATE_CONFIG,
      extra: {
        hostAdvisor: gateAdvisor(),
        hostAdvisorScope: { branchId: 'br-p5' }
      }
    });
    const plugin = harness.plugin;

    expect(plugin.hostAdapterSource).toBe('dsh-hooks');
    expect(plugin.jitrl.hostAdvisor?.enabled).toBe(true);
    expect(plugin.jitrl.hostAdvisor?.mode).toBe('gate');
    expect(plugin.jitrl.hostAdvisor?.attached).toBe(true);

    const preExecute = fixture.listener('tools/pre-execute');
    const decision = (await preExecute(
      { name: 'bash', branchId: 'br-p5' },
      allow
    )) as { kind: string; reason?: string };

    expect(decision.kind).toBe('ask');
    expect(decision.kind).not.toBe('deny');
    expect(decision.reason).toContain('gateThreshold');
    expect(plugin.jitrl.hostAdvisor?.ask).toBe(1);

    // Out of scope: another probe branch is left untouched.
    const other = (await preExecute(
      { name: 'bash', branchId: 'br-somewhere-else' },
      allow
    )) as { kind: string };
    expect(other.kind).toBe('allow');
    expect(plugin.jitrl.hostAdvisor?.ask).toBe(1);
    expect(plugin.jitrl.hostAdvisor?.skipped).toBeGreaterThanOrEqual(1);

    // dispose() removes the listeners AND detaches the advisor.
    const captured = preExecute;
    await plugin.dispose();
    expect(fixture.listenerNames()).not.toContain('tools/pre-execute');
    const afterDispose = (await captured(
      { name: 'bash', branchId: 'br-p5' },
      allow
    )) as { kind: string };
    expect(afterDispose.kind).toBe('allow');
  });

  it('never upgrades even a foreign deny decision; only ask is forwarded', async () => {
    const fixture = dshContext();
    const rogue = {
      async evaluate() {
        return { kind: 'deny', reason: 'rogue advisor tried to deny' };
      },
      diagnostics: () => []
    } as unknown as HostAdvisor;
    const harness = buildE2E({
      ctx: fixture.ctx as never,
      config: GATE_CONFIG,
      extra: { hostAdvisor: rogue }
    });
    const preExecute = fixture.listener('tools/pre-execute');
    const decision = (await preExecute({ name: 'bash' }, allow)) as { kind: string };
    expect(decision.kind).toBe('allow');
    expect(decision.kind).not.toBe('deny');
    await harness.plugin.dispose();
  });

  it('stays silent with the switch off (no advisor attached, no ask)', async () => {
    const fixture = dshContext();
    const harness = buildE2E({ ctx: fixture.ctx as never });
    const preExecute = fixture.listener('tools/pre-execute');
    const decision = (await preExecute({ name: 'bash' }, allow)) as { kind: string };
    expect(decision.kind).toBe('allow');
    expect(harness.plugin.jitrl.hostAdvisor?.enabled).toBe(false);
    expect(harness.plugin.jitrl.hostAdvisor?.attached).toBe(false);
    await harness.plugin.dispose();
  });
});

describe('L3 advisor wiring (advisory)', () => {
  it('appends the rendered advice to additionalContexts on agent/pre-step', async () => {
    const fixture = dshContext();
    const harness = buildE2E({
      ctx: fixture.ctx as never,
      config: ADVISORY_CONFIG,
      extra: {
        hostAdvisor: advisoryAdvisor(),
        hostAdvisorScope: { sessionId: 'sess-p5' }
      }
    });
    const plugin = harness.plugin;
    const preStep = fixture.listener('agent/pre-step');

    const decision = (await preStep(
      { sessionId: 'sess-p5', agent: { id: 'sess-p5' } },
      enter
    )) as { kind: string; messages: unknown[]; additionalContexts?: string[] };

    expect(decision.kind).toBe('enter');
    expect(decision.messages).toEqual([]);
    expect(decision.additionalContexts).toHaveLength(1);
    expect(decision.additionalContexts?.[0]).toContain('<jitrl_advice');
    expect(plugin.jitrl.hostAdvisor?.advisory).toBe(1);

    // Out of scope: a sibling session sees no injected text.
    const scopedOut = (await preStep(
      { sessionId: 'sess-other' },
      enter
    )) as { additionalContexts?: string[] };
    expect(scopedOut.additionalContexts).toBeUndefined();

    await plugin.dispose();
    const afterDispose = (await preStep(
      { sessionId: 'sess-p5', agent: { id: 'sess-p5' } },
      enter
    )) as { additionalContexts?: string[] };
    expect(afterDispose.additionalContexts).toBeUndefined();
  });
});

describe('aggregate statistics mirror wiring', () => {
  function fakeMirrorClient() {
    const calls = { listTools: 0, callTool: 0, tools: [] as string[] };
    const client = {
      serverId: 'fake-memory',
      async listTools() {
        calls.listTools += 1;
        return [
          {
            name: 'write_note',
            inputSchema: {
              properties: { text: {}, path: {}, tags: {}, metadata: {} }
            }
          }
        ];
      },
      async callTool(name: string) {
        calls.callTool += 1;
        calls.tools.push(name);
        return { ok: true };
      }
    };
    return { client, calls };
  }

  it('writes aggregate rows after a run when the mirror is enabled', async () => {
    const fake = fakeMirrorClient();
    const harness = buildE2E({
      config: { jitrl: { store: { mirrorToMemoryBridge: true } } },
      extra: { mirrorClient: fake.client }
    });
    const plugin = harness.plugin;
    await runOnce(plugin);

    expect(plugin.jitrl.storeSize).toBeGreaterThan(0);
    expect(fake.calls.listTools).toBeGreaterThan(0);
    expect(fake.calls.callTool).toBeGreaterThan(0);
    expect(fake.calls.tools.every((tool) => tool === 'write_note')).toBe(true);

    const mirror = plugin.jitrl.mirror;
    expect(mirror?.enabled).toBe(true);
    expect(mirror?.calls).toBeGreaterThan(0);
    expect(mirror?.writes).toBeGreaterThan(0);
    expect(mirror?.lastWritten).toBeGreaterThan(0);
    await plugin.dispose();
  });

  it('touches the backend zero times while the switch is off', async () => {
    const fake = fakeMirrorClient();
    const harness = buildE2E({ extra: { mirrorClient: fake.client } });
    const plugin = harness.plugin;
    await runOnce(plugin);

    expect(plugin.jitrl.storeSize).toBeGreaterThan(0);
    expect(fake.calls.listTools).toBe(0);
    expect(fake.calls.callTool).toBe(0);
    expect(plugin.jitrl.mirror?.enabled).toBe(false);
    expect(plugin.jitrl.mirror?.calls).toBe(0);
    expect(plugin.jitrl.mirror?.writes).toBe(0);
    await plugin.dispose();
  });

  it('degrades to zero writes without a client but never throws', async () => {
    const harness = buildE2E({
      config: { jitrl: { store: { mirrorToMemoryBridge: true } } }
    });
    const plugin = harness.plugin;
    const result = await runOnce(plugin);
    expect(result.outcome).toBe('composed');
    expect(plugin.jitrl.mirror?.degraded).toBe(true);
    expect(plugin.jitrl.mirror?.writes).toBe(0);
    await plugin.dispose();
  });
});

function runOnce(plugin: ReturnType<typeof buildE2E>['plugin']) {
  return plugin.run({
    sessionId: 'sess-p5-run',
    task: plugin.makeTask({ id: 'task-p5-run', prompt: 'Fix the failing build.' }),
    trigger: 'always'
  });
}
