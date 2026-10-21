/**
 * DSH trigger + volatile model-settings tests.
 *
 * Every event name and payload shape asserted here was read out of the shipped
 * runtime (resources/app.asar):
 *   - dsh-tool-cordis/lib/types/api-catalog.js  (event signatures)
 *   - dsh-session/lib/types/known-event-types.js (session event type vocabulary)
 *   - dsh-session/lib/types/index.js            (SessionEventMap: turn/end.reason)
 *   - dsh-agent-loop/lib/index.js               (agent/status emits {status} only;
 *                                                runMaintenance throws off-idle)
 * The tests therefore pin the CONTRACT, not an invented one: the previous
 * defaults 'task:failed' / 'tool:error' appear nowhere in that runtime.
 */
import { describe, expect, it, vi } from 'vitest';
import pluginDefault, {
  Config,
  DEFAULT_AUTO_FALLBACK_EVENTS,
  LEGACY_AUTO_FALLBACK_EVENTS,
  PLUGIN_NAME,
  createEvoHarnessPlugin,
  inject,
  modelRouteDefaults,
  type EvoHarnessPlugin
} from '../../src/index';
import {
  classifyAgentError,
  classifySessionEvent,
  DSH_TRIGGER_EVENTS,
  readAgentStatus,
  readSessionEventArgs,
  registerDshTriggers,
  splitModelRoute,
  unwrapConfigValues
} from '../../src/host-triggers';
import {
  createScriptedModel,
  createScriptedRunner,
  e2eConfig,
  makeClock,
  makeIdFactory,
  mem0LikeServer
} from '../e2e/fixtures';

/** A tool/result failure exactly as DSH records it. */
function toolErrorEvent(text = 'exit 1') {
  return {
    type: 'tool/result',
    data: {
      turn: 3,
      step: 2,
      message: {
        role: 'tool',
        toolCallId: 'call-1',
        isError: true,
        content: [{ type: 'text', text }]
      }
    }
  };
}

/** A turn/end with a verified TurnEndReason kind. */
function turnEndEvent(kind: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'turn/end',
    data: { turn: 3, reason: { kind, ...extra } }
  };
}

/** Recording host context with just the capabilities these tests need. */
function makeContext(agent?: Record<string, unknown>) {
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const ctx: Record<string, unknown> = {
    on: (name: string, handler: (...args: unknown[]) => unknown) => {
      listeners.set(name, handler);
      return () => listeners.delete(name);
    },
    ...(agent === undefined ? {} : { agents: { list: () => [agent] } })
  };
  return { ctx, listeners };
}

function buildPlugin(
  ctx: unknown,
  config: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): EvoHarnessPlugin {
  const now = makeClock();
  return createEvoHarnessPlugin(
    {
      config,
      model: createScriptedModel(),
      clients: [mem0LikeServer().client],
      runBranch: createScriptedRunner(now),
      now,
      newId: makeIdFactory('trig'),
      ...extra
    },
    ctx
  );
}

describe('fabricated event names are gone', () => {
  it('never lists task:failed or tool:error as a default', () => {
    expect([...DEFAULT_AUTO_FALLBACK_EVENTS]).toEqual([
      'session/event',
      'agent/error',
      'agent/status'
    ]);
    expect([...DSH_TRIGGER_EVENTS]).not.toContain('task:failed');
    expect([...DSH_TRIGGER_EVENTS]).not.toContain('tool:error');
    // exported for the explicit opt-in path only
    expect([...LEGACY_AUTO_FALLBACK_EVENTS]).toEqual(['task:failed', 'tool:error']);
  });

  it('registers nothing but verified events on a capable host', () => {
    const { ctx, listeners } = makeContext();
    buildPlugin(ctx, e2eConfig());
    expect([...listeners.keys()].sort()).toEqual(['agent/error', 'agent/status', 'session/event']);
  });

  it('leaves the fabricated names unregistered unless explicitly requested', () => {
    const { ctx, listeners } = makeContext();
    const plugin = buildPlugin(ctx, e2eConfig(), {
      autoFallbackEvents: ['task:failed']
    });
    // the explicit list is the whole legacy surface, and it is additive
    expect(listeners.has('task:failed')).toBe(true);
    expect(plugin.registeredEvents).toContain('task:failed');
    expect(plugin.diagnostics.join(' ')).toContain('not verified DSH events');
  });
});

describe('triggerMode is genuinely distinct', () => {
  it('slash_command registers no listeners at all', () => {
    const { ctx, listeners } = makeContext();
    const plugin = buildPlugin(ctx, e2eConfig({ config: { triggerMode: 'slash_command' } }));
    expect(listeners.size).toBe(0);
    expect(plugin.registeredEvents).toEqual([]);
    expect(plugin.diagnostics.join(' ')).toContain('slash_command');
  });

  it('auto_fallback reacts to failures but ignores a completed turn', async () => {
    const { ctx, listeners } = makeContext();
    const plugin = buildPlugin(ctx, e2eConfig({ config: { triggerMode: 'auto_fallback' } }));

    listeners.get('session/event')?.({ id: 'sess-a' }, turnEndEvent('completed'));
    expect(await plugin.settle()).toEqual([]);

    listeners.get('session/event')?.({ id: 'sess-a' }, toolErrorEvent());
    const results = await plugin.settle();
    expect(results).toHaveLength(1);
    expect(results[0]?.trigger).toBe('auto_fallback');
    expect(results[0]?.outcome).toBe('composed');
  });

  it('always additionally reacts to a completed turn', async () => {
    const { ctx, listeners } = makeContext();
    const plugin = buildPlugin(ctx, e2eConfig({ config: { triggerMode: 'always' } }));

    listeners.get('session/event')?.({ id: 'sess-b' }, turnEndEvent('completed'));
    const results = await plugin.settle();
    expect(results).toHaveLength(1);
    expect(results[0]?.trigger).toBe('always');
    expect(results[0]?.outcome).toBe('composed');
  });

  it('treats agent/error as a failure under both automatic modes', async () => {
    for (const triggerMode of ['auto_fallback', 'always'] as const) {
      const { ctx, listeners } = makeContext();
      const plugin = buildPlugin(ctx, e2eConfig({ config: { triggerMode } }));
      listeners.get('agent/error')?.({
        agent: { id: 'agent-1' },
        turn: 2,
        step: 1,
        error: new Error('provider exploded')
      });
      const results = await plugin.settle();
      expect(results).toHaveLength(1);
      expect(results[0]?.trigger).toBe('auto_fallback');
    }
  });
});

describe('session/event classification', () => {
  it('reads a tool/result error and ignores a successful one', () => {
    const failed = classifySessionEvent({ id: 's' }, toolErrorEvent('permission denied'));
    expect(failed.failure?.kind).toBe('tool_error');
    expect(failed.failure?.sessionId).toBe('s');
    expect(failed.failure?.summary).toContain('permission denied');
    expect(failed.failure?.failureSignals[0]?.kind).toBe('tool_error');

    const ok = classifySessionEvent({ id: 's' }, {
      type: 'tool/result',
      data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c', content: [] } }
    });
    expect(ok.failure).toBeUndefined();
    expect(ok.ignored).toContain('isError');
  });

  it('reads turn/end error and completed, and ignores every other reason kind', () => {
    const errored = classifySessionEvent({ id: 's' }, turnEndEvent('error', {
      error: { message: 'rate limited', code: 'rate_limit' }
    }));
    expect(errored.failure?.kind).toBe('turn_error');
    expect(errored.failure?.failureSignals[0]?.code).toBe('rate_limit');

    expect(classifySessionEvent({ id: 's' }, turnEndEvent('completed')).completed?.reasonKind).toBe(
      'completed'
    );
    for (const kind of ['aborted', 'blocked', 'max-tokens', 'interrupted', 'forked']) {
      const classified = classifySessionEvent({ id: 's' }, turnEndEvent(kind));
      expect(classified.failure).toBeUndefined();
      expect(classified.completed).toBeUndefined();
      expect(classified.ignored).toContain(kind);
    }
  });

  it('never invents a session id when the Session argument is absent', () => {
    const args = readSessionEventArgs({ type: 'turn/end', data: { reason: { kind: 'error' } } }, undefined);
    expect(args?.event?.type).toBe('turn/end');
    const classified = classifySessionEvent(args?.session, args?.event);
    expect(classified.failure?.sessionId).toBeUndefined();
  });

  it('accepts the (session, event) dispatch order DSH uses', () => {
    const args = readSessionEventArgs({ id: 'sess-x' }, toolErrorEvent());
    expect(args?.session).toEqual({ id: 'sess-x' });
    expect(args?.event?.type).toBe('tool/result');
  });
});

describe('agent payloads', () => {
  it('reads only the verified idle|running status', () => {
    expect(readAgentStatus({ status: 'idle' })).toBe('idle');
    expect(readAgentStatus({ status: 'running' })).toBe('running');
    expect(readAgentStatus({ status: 'busy' })).toBeUndefined();
    expect(readAgentStatus(undefined)).toBeUndefined();
  });

  it('normalizes agent/error without requiring an agent on the payload', () => {
    const failure = classifyAgentError({ turn: 4, step: 2, error: 'plain string failure' });
    expect(failure.kind).toBe('agent_error');
    expect(failure.failureSignals[0]?.message).toContain('plain string failure');
    expect(failure.evidence.turn).toBe(4);
  });
});

describe('idle dream', () => {
  it('runs runMaintenance when idle and stays silent when there is no material', async () => {
    const maintenance = vi.fn(async (job: () => Promise<void>) => job());
    const { ctx, listeners } = makeContext({ runMaintenance: maintenance });
    const dream = vi.fn(async () => undefined);
    buildPlugin(ctx, e2eConfig({ config: { triggerMode: 'auto_fallback' } }), { dream });

    // no retained trees yet: the gate keeps the dream from running
    listeners.get('agent/status')?.({ status: 'idle' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dream).not.toHaveBeenCalled();

    // 'running' is never a trigger
    listeners.get('agent/status')?.({ status: 'running' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dream).not.toHaveBeenCalled();
    expect(maintenance).not.toHaveBeenCalled();
  });

  it('contains a runMaintenance throw instead of failing the listener', () => {
    const maintenance = vi.fn(() => {
      throw new Error('agent "a" already has active work');
    });
    const agent = { id: 'a', runMaintenance: maintenance };
    const { ctx, listeners } = makeContext(agent);
    const diagnostics: string[] = [];
    const registration = registerDshTriggers(ctx, {
      triggerMode: 'auto_fallback',
      onFailure: vi.fn(),
      dream: { hasMaterial: () => true, run: vi.fn() },
      // the verified payload carries only {status}; the agent comes from ctx.agents
      agents: () => [agent],
      onDiagnostic: (message) => diagnostics.push(message)
    });
    expect(registration.events).toContain('agent/status');
    // a throwing maintenance call must not propagate out of the listener
    expect(() => listeners.get('agent/status')?.({ status: 'idle' })).not.toThrow();
    expect(maintenance).toHaveBeenCalled();
    expect(diagnostics.join(' ')).toContain('idle dream skipped');
  });
});

describe('volatile model settings', () => {
  it('marks every modelRoute leaf volatile and mirrors the verified defaults', () => {
    expect(modelRouteDefaults).toEqual({
      provider: 'qodercn',
      model: 'dfmodel',
      reasoningEffort: 'max'
    });
    const json = (Config as unknown as { toJSON(): unknown }).toJSON();
    const refs = (json as { refs: Record<string, { meta?: { volatile?: boolean }; dict?: Record<string, number> }> }).refs;
    const root = json as unknown as { uid: number; refs: Record<string, unknown> };
    const rootNode = refs[String(root.uid)] as { dict?: Record<string, number> };
    const group = refs[String(rootNode.dict?.['modelRoute'])] as {
      dict?: Record<string, number>;
    };
    expect(Object.keys(group.dict ?? {}).sort()).toEqual([
      'model',
      'provider',
      'reasoningEffort'
    ]);
    for (const key of Object.keys(group.dict ?? {})) {
      const leaf = refs[String(group.dict?.[key])] as { meta?: { volatile?: boolean } };
      expect(leaf.meta?.volatile).toBe(true);
    }
  });

  it('validates a settings-page payload into volatile references with defaults', () => {
    const result = (Config as unknown as {
      '~standard': { validate(value: unknown): { value?: unknown; issues?: unknown } };
    })['~standard'].validate({ modelRoute: { provider: 'qodercn', model: 'dfmodel' } });
    expect(result.issues).toBeUndefined();
    const group = (result.value as { modelRoute: Record<string, { get(): unknown }> }).modelRoute;
    expect(group.provider?.get()).toBe('qodercn');
    expect(group.reasoningEffort?.get()).toBe('max');
  });

  it('preserves unrelated config keys when DSH persists the entry', () => {
    // DSH's loader calls Config.simplify(validated) before writing the entry;
    // the default schemastery simplify would drop every undeclared key.
    const simplify = (Config as unknown as { simplify(value: unknown): unknown }).simplify;
    const raw = {
      schemaVersion: 1,
      triggerMode: 'always',
      enabledSurfaces: ['system_prompt'],
      memoryBridge: { mcpServerTarget: 'auto' },
      dreamRsi: { maxWidth: 4 },
      logging: { level: 'info' },
      modelRoute: { provider: 'qodercn', model: 'dfmodel', reasoningEffort: 'max' }
    };
    const validated = (Config as unknown as {
      '~standard': { validate(value: unknown): { value: unknown } };
    })['~standard'].validate(raw).value;
    // values identical; only key order may differ (deepEqual is order-insensitive)
    expect(simplify.call(Config, validated)).toEqual(raw);
    expect(JSON.parse(JSON.stringify(simplify.call(Config, validated)))).toEqual(raw);
  });

  it('splits modelRoute out so the frozen config schema still validates', () => {
    const split = splitModelRoute({
      triggerMode: 'always',
      modelRoute: { provider: 'qodercn', model: 'dfmodel', reasoningEffort: 'max' }
    });
    expect(split.modelRoute).toEqual({
      provider: 'qodercn',
      model: 'dfmodel',
      reasoningEffort: 'max'
    });
    expect(split.config).toEqual({ triggerMode: 'always' });
    // no modelRoute means no unknown-key rejection downstream
    expect(splitModelRoute({ triggerMode: 'always' }).config).toEqual({ triggerMode: 'always' });
  });

  it('unwraps schemastery volatile references into plain values', () => {
    const reference = { get: () => 'resolved' };
    expect(unwrapConfigValues({ a: reference, b: [reference], c: 1 })).toEqual({
      a: 'resolved',
      b: ['resolved'],
      c: 1
    });
  });

  it('exposes the fragment and the minimal required inject list on the plugin export', () => {
    expect(pluginDefault.name).toBe(PLUGIN_NAME);
    expect(pluginDefault.Config).toBe(Config);
    expect([...inject]).toEqual(['commands']);
    // llm/tools/agents are optional: declaring them would stall the fiber
    expect([...inject]).not.toContain('llm');
    expect([...inject]).not.toContain('tools');
    expect([...inject]).not.toContain('agents');
  });

  it('reads the configured route into the plugin handle', () => {
    const { ctx } = makeContext();
    const plugin = buildPlugin(ctx, e2eConfig({
      config: { triggerMode: 'always', modelRoute: { provider: 'p', model: 'm', reasoningEffort: 'high' } }
    }));
    expect(plugin.modelRoute).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'high' });
    // the frozen schema never sees the host-only group
    expect(plugin.config.triggerMode).toBe('always');
  });
});

describe('teardown', () => {
  it('removes every listener and the /evo command on dispose', async () => {
    const listeners = new Map<string, (...args: unknown[]) => unknown>();
    const commands = new Map<string, unknown>();
    const ctx = {
      on: (name: string, handler: (...args: unknown[]) => unknown) => {
        listeners.set(name, handler);
        return () => listeners.delete(name);
      },
      commands: {
        register: (definition: { name: string }) => {
          commands.set(definition.name, definition);
          return () => commands.delete(definition.name);
        }
      }
    };
    const plugin = buildPlugin(ctx, e2eConfig());
    expect(listeners.size).toBe(3);
    expect(commands.has('evo')).toBe(true);

    await plugin.dispose();
    expect(listeners.size).toBe(0);
    expect(commands.size).toBe(0);
    expect(plugin.orchestrator.isDisposed()).toBe(true);
  });

  it('registers a fiber effect so Cordis unload tears the plugin down', () => {
    const { ctx } = makeContext();
    const effect = vi.fn();
    const plugin = buildPlugin({ ...ctx, effect }, e2eConfig());
    expect(effect).toHaveBeenCalledTimes(1);
    expect(plugin.orchestrator.isDisposed()).toBe(false);
  });
});

describe('host-neutral defaults', () => {
  it('keeps working with no host context at all', async () => {
    const plugin = createEvoHarnessPlugin({
      config: e2eConfig(),
      model: createScriptedModel(),
      clients: [mem0LikeServer().client],
      runBranch: createScriptedRunner(makeClock()),
      now: makeClock(),
      newId: makeIdFactory('bare2')
    });
    expect(plugin.registeredEvents).toEqual([]);
    const result = await plugin.runFromCommand('Fix it.');
    expect(result.outcome).toBe('composed');
    await plugin.dispose();
  });
});
