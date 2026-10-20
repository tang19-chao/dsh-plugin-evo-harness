import { describe, expect, it, vi } from 'vitest';
import pluginDefault, {
  EVO_COMMAND_NAME,
  PLUGIN_NAME,
  apply,
  createCordisHostFromContext,
  createEvoHarnessPlugin,
  hostAdapterSeamCount
} from '../../src/index';
import type { EvoHarnessRunResult } from '../../src/types/contracts';
import {
  createBareContext,
  createFakeContext,
  createScriptedModel,
  createScriptedRunner,
  e2eConfig,
  makeClock,
  makeIdFactory,
  mem0LikeServer
} from './fixtures';

function buildPlugin(ctx: unknown, options: Record<string, unknown> = {}) {
  const server = mem0LikeServer();
  const now = makeClock();
  return createEvoHarnessPlugin(
    {
      config: e2eConfig(),
      model: createScriptedModel(),
      clients: [server.client],
      runBranch: createScriptedRunner(now),
      now,
      newId: makeIdFactory('plugin'),
      ...options
    },
    ctx
  );
}

describe('plugin entrypoint', () => {
  it('exports the standard Cordis plugin shape', () => {
    expect(pluginDefault.name).toBe(PLUGIN_NAME);
    expect(typeof pluginDefault.apply).toBe('function');
    expect(typeof apply).toBe('function');
    expect(EVO_COMMAND_NAME).toBe('evo');
  });

  it('registers /evo and auto_fallback on a capable host context', async () => {
    const { ctx, commands, events, info } = createFakeContext();
    const plugin = apply(ctx, {
      config: e2eConfig(),
      model: createScriptedModel(),
      clients: [mem0LikeServer().client],
      runBranch: createScriptedRunner(makeClock()),
      now: makeClock(),
      newId: makeIdFactory('entry')
    });

    expect(plugin.registeredCommands).toEqual(['evo']);
    expect(commands.has('evo')).toBe(true);
    expect([...events.keys()].sort()).toEqual(['task:failed', 'tool:error']);
    expect(plugin.registeredEvents).toEqual(['task:failed', 'tool:error']);
    expect(info).toHaveBeenCalled();
    expect((ctx as Record<string, unknown>).evoHarness).toBe(plugin);
    expect(plugin.hostAdapterSource).toBe('in-memory');

    const handler = commands.get('evo');
    expect(handler).toBeDefined();
    const commandResult = (await handler?.(
      { prompt: 'Fix the failing build.', sessionId: 'sess-cmd', taskId: 'task-cmd' },
      { sessionId: 'sess-cmd' }
    )) as EvoHarnessRunResult;
    expect(commandResult.outcome).toBe('composed');
    expect(commandResult.sessionId).toBe('sess-cmd');
    expect(commandResult.taskId).toBe('task-cmd');
    expect(commandResult.trigger).toBe('slash_command');

    const onFailure = events.get('task:failed');
    expect(onFailure).toBeDefined();
    const fallbackResult = (await onFailure?.({
      sessionId: 'sess-evt',
      task: { id: 'task-evt', prompt: 'recover the failed build' },
      failureSignals: [{ kind: 'tool_error', message: 'exit 1' }]
    })) as EvoHarnessRunResult | null;
    expect(fallbackResult?.outcome).toBe('composed');
    expect(fallbackResult?.trigger).toBe('auto_fallback');
  });

  it('derives the eight capability seams from a Cordis-style context and uses them', async () => {
    const calls: string[] = [];
    const fork = vi.fn(() => ({ contextId: 'child-ctx' }));
    const ctx = {
      prompt: {
        registerSegment: (kind: string) => {
          calls.push('prompt:' + kind);
          return () => {
            calls.push('prompt:dispose');
          };
        }
      },
      permissions: {
        register: () => {
          calls.push('permissions');
          return { dispose: () => calls.push('permissions:dispose') };
        }
      },
      evoMemory: {
        createScopedView: () => {
          calls.push('memory');
          return () => calls.push('memory:dispose');
        }
      },
      tools: { patchDescriptions: () => undefined },
      skills: { mountDynamic: () => undefined },
      sandbox: {
        mountScript: () => undefined,
        acquireWorkspace: () => ({ id: 'ws-1', dispose: () => calls.push('sandbox:dispose') })
      },
      subagents: { register: () => undefined },
      middleware: { use: () => undefined },
      fork,
      registerCommand: vi.fn(),
      on: vi.fn()
    };

    const adapter = createCordisHostFromContext(ctx);
    expect(hostAdapterSeamCount(adapter)).toBe(10);

    const plugin = buildPlugin(ctx);
    expect(plugin.hostAdapterSource).toBe('context');

    const result = await plugin.run({
      sessionId: 'sess-ctx',
      task: plugin.makeTask({ id: 'task-ctx', prompt: 'Fix the failing build.' }),
      trigger: 'always'
    });

    expect(result.outcome).toBe('composed');
    expect(fork).toHaveBeenCalled();
    // the winning guardrail patch was mounted through the host's permissions seam
    expect(calls).toContain('permissions');
    expect(calls).toContain('sandbox:dispose');
    expect(plugin.diagnostics.join(' ')).not.toContain('no Cordis capability seams');
  });

  it('stays usable on a bare context and documents the fallback entrypoints', async () => {
    const bare = createBareContext();
    const plugin = createEvoHarnessPlugin(
      {
        config: e2eConfig(),
        model: createScriptedModel(),
        clients: [mem0LikeServer().client],
        runBranch: createScriptedRunner(makeClock()),
        now: makeClock(),
        newId: makeIdFactory('bare')
      },
      bare
    );

    expect(plugin.registeredCommands).toEqual([]);
    expect(plugin.registeredEvents).toEqual([]);
    expect(plugin.hostAdapterSource).toBe('in-memory');
    expect(plugin.diagnostics.join(' ')).toContain('no Cordis capability seams');
    expect(plugin.diagnostics.join(' ')).toContain('/evo');

    const result = await plugin.runFromCommand('Fix the failing build.');
    expect(result.outcome).toBe('composed');
    expect(result.trigger).toBe('slash_command');
    expect(result.sessionId).toBe('session-unknown');
  });

  it('survives a host that refuses registrations', async () => {
    const hostile = {
      registerCommand: () => {
        throw new Error('command registration denied');
      },
      on: () => {
        throw new Error('event subscription denied');
      }
    };
    const plugin = buildPlugin(hostile);

    expect(plugin.registeredCommands).toEqual([]);
    expect(plugin.registeredEvents).toEqual([]);
    expect(plugin.diagnostics.join(' ')).toContain('failed to register the /evo command');
    expect(plugin.diagnostics.join(' ')).toContain('failed to subscribe');

    const result = await plugin.run({
      sessionId: 'sess-hostile',
      task: plugin.makeTask({ id: 'task-hostile', prompt: 'Fix the failing build.' }),
      trigger: 'always'
    });
    expect(result.outcome).toBe('composed');
  });

  it('exposes the orchestrator through the plugin handle and disposes cleanly', async () => {
    const bare = createBareContext();
    const plugin = buildPlugin(bare);

    const result = await plugin.run({
      sessionId: 'sess-dispose',
      task: plugin.makeTask({ id: 'task-dispose', prompt: 'Fix the failing build.' }),
      trigger: 'always'
    });
    expect(result.composedPatchId).toBeDefined();
    expect(plugin.orchestrator.activePatchIds()).toEqual([result.composedPatchId]);

    await plugin.dispose();
    expect(plugin.orchestrator.isDisposed()).toBe(true);
    expect(plugin.orchestrator.activePatchIds()).toEqual([]);

    const afterDispose = await plugin.run({
      sessionId: 'sess-dispose',
      task: plugin.makeTask({ id: 'task-dispose-2', prompt: 'Fix it again.' }),
      trigger: 'always'
    });
    expect(afterDispose.outcome).toBe('failed');
    await plugin.dispose();
  });
});
