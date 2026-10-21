/**
 * Cordis plugin entrypoint and host-adapter wrapper tests.
 *
 * Self-contained by design: this file builds its own host contexts instead of
 * extending tests/e2e/fixtures.ts (owned by another task). Everything is
 * in-process and deterministic - no host runtime, network or real LLM.
 */
import { describe, expect, it, vi } from 'vitest';
import pluginDefault, {
  EVO_COMMAND_NAME,
  PLUGIN_NAME,
  apply,
  buildOrchestratorDeps,
  createCordisHostFromContext,
  createEvoHarnessPlugin,
  hostAdapterSeamCount
} from '../../src/index';
import { parseEvoHarnessConfig } from '../../src/config';
import type { DiscoveryNode, DiscoveryTreeSnapshot, EvoHarnessRunResult } from '../../src/types/contracts';
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

/** Minimal valid tree snapshot for direct offline-dreamer replay assertions. */
function makeTreeSnapshot(): DiscoveryTreeSnapshot {
  const node: DiscoveryNode = {
    id: 'node-1',
    treeId: 'tree-1',
    parentId: null,
    depth: 0,
    branchId: 'branch-1',
    patchId: 'patch-1',
    patchOrigin: 'reference',
    purpose: 'initial',
    guidance: 'guidance_free',
    status: 'succeeded',
    score: 0.8,
    adoptionRatio: 0.5,
    childIds: [],
    createdAt: 1,
    updatedAt: 2
  };
  return {
    id: 'tree-1',
    sessionId: 'sess-tree',
    taskId: 'task-tree',
    rootId: node.id,
    nodes: { [node.id]: node },
    stats: {
      nodeCount: 1,
      maxDepth: 0,
      maxWidth: 1,
      scoredNodes: 1,
      completedNodes: 1
    },
    completed: true,
    createdAt: 1,
    updatedAt: 2
  };
}

describe('plugin entrypoint', () => {
  it('exports the standard Cordis plugin shape', () => {
    expect(pluginDefault.name).toBe(PLUGIN_NAME);
    expect(typeof pluginDefault.apply).toBe('function');
    expect(typeof apply).toBe('function');
    expect(EVO_COMMAND_NAME).toBe('evo');
  });

  it('registers /evo and the verified DSH triggers on a capable host context', async () => {
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
    // ONLY verified DSH events: 'task:failed' / 'tool:error' do not exist.
    expect([...events.keys()].sort()).toEqual(['agent/error', 'agent/status', 'session/event']);
    expect(plugin.registeredEvents).toEqual(['session/event', 'agent/error', 'agent/status']);
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

    // A verified tool/result error: session/event(session, {type,data}).
    const onSessionEvent = events.get('session/event');
    expect(onSessionEvent).toBeDefined();
    // DSH dispatches session/event as a contained fire-and-forget emit, so the
    // listener returns void; settle() is the join point for its run.
    onSessionEvent?.(  { id: 'sess-evt' },
      {
        type: 'tool/result',
        data: {
          turn: 1,
          step: 2,
          message: {
            role: 'tool',
            toolCallId: 'call-1',
            isError: true,
            content: [{ type: 'text', text: 'exit 1' }]
          }
        }
      }
    );
    const [fallbackResult] = await plugin.settle();
    expect(fallbackResult?.outcome).toBe('composed');
    expect(fallbackResult?.trigger).toBe('auto_fallback');
    expect(fallbackResult?.sessionId).toBe('sess-evt');
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

describe('host adapter wrapper disposal state', () => {
  it('tracks forkBranch disposal state: false before, true after, disposer called once', async () => {
    const disposeCalls: string[] = [];
    const ctx = {
      forkBranch: vi.fn(() => ({
        contextId: 'child-ctx',
        dispose: vi.fn(async () => {
          disposeCalls.push('fork');
        })
      })),
      registerCommand: vi.fn()
    };

    const adapter = createCordisHostFromContext(ctx);
    expect(adapter.forkBranch).toBeDefined();

    const branch = await adapter.forkBranch?.({
      branchId: 'br-test-1',
      sessionId: 'sess-dispose',
      namespace: 'test:ns'
    });

    expect(branch?.isDisposed).toBe(false);
    expect(branch?.contextId).toBe('child-ctx');
    expect(disposeCalls).toEqual([]);

    await branch?.dispose();
    expect(branch?.isDisposed).toBe(true);
    expect(disposeCalls).toEqual(['fork']);

    // idempotent: a second dispose must not call the underlying disposer again
    await branch?.dispose();
    await branch?.dispose();
    expect(branch?.isDisposed).toBe(true);
    expect(disposeCalls).toEqual(['fork']);
  });

  it('tracks acquireSandbox disposal state: false before, true after, disposer called once', async () => {
    const disposeCalls: string[] = [];
    const ctx = {
      sandbox: {
        acquireWorkspace: vi.fn(() => ({
          id: 'sandbox-ws-1',
          path: '/tmp/work',
          dispose: vi.fn(async () => {
            disposeCalls.push('sandbox');
          })
        }))
      },
      registerCommand: vi.fn()
    };

    const adapter = createCordisHostFromContext(ctx);
    expect(adapter.acquireSandbox).toBeDefined();

    const sandbox = await adapter.acquireSandbox?.({
      branchId: 'br-sandbox-1',
      sessionId: 'sess-dispose',
      namespace: 'test:ns',
      patchId: 'patch-1'
    });

    expect(sandbox?.isDisposed).toBe(false);
    expect(sandbox?.id).toBe('sandbox-ws-1');
    expect(sandbox?.path).toBe('/tmp/work');

    await sandbox?.dispose();
    expect(sandbox?.isDisposed).toBe(true);
    expect(disposeCalls).toEqual(['sandbox']);

    await sandbox?.dispose();
    expect(sandbox?.isDisposed).toBe(true);
    expect(disposeCalls).toEqual(['sandbox']);
  });

  it('keeps disposal state per branch instance and never shares it between branches', async () => {
    const disposed: string[] = [];
    const ctx = {
      forkBranch: vi.fn((request: { branchId: string }) => ({
        contextId: 'ctx-' + request.branchId,
        dispose: vi.fn(async () => {
          disposed.push(request.branchId);
        })
      })),
      registerCommand: vi.fn()
    };

    const adapter = createCordisHostFromContext(ctx);
    const first = await adapter.forkBranch?.({
      branchId: 'br-a',
      sessionId: 'sess-a',
      namespace: 'test:a'
    });
    const second = await adapter.forkBranch?.({
      branchId: 'br-b',
      sessionId: 'sess-b',
      namespace: 'test:b'
    });

    expect(first?.isDisposed).toBe(false);
    expect(second?.isDisposed).toBe(false);

    await first?.dispose();
    expect(first?.isDisposed).toBe(true);
    // disposing branch A must not mark branch B disposed
    expect(second?.isDisposed).toBe(false);
    expect(disposed).toEqual(['br-a']);

    await second?.dispose();
    expect(second?.isDisposed).toBe(true);
    expect(disposed).toEqual(['br-a', 'br-b']);

    // a third branch created after the others is still live
    const third = await adapter.forkBranch?.({
      branchId: 'br-c',
      sessionId: 'sess-c',
      namespace: 'test:c'
    });
    expect(third?.isDisposed).toBe(false);
    await third?.dispose();
    expect(third?.isDisposed).toBe(true);
    expect(disposed).toEqual(['br-a', 'br-b', 'br-c']);
  });

  it('records a consistent disposed state when the underlying disposer fails', async () => {
    const disposeCalls: string[] = [];
    const ctx = {
      forkBranch: vi.fn(() => ({
        contextId: 'child-error',
        dispose: vi.fn(async () => {
          disposeCalls.push('fork');
          throw new Error('underlying dispose error');
        })
      })),
      registerCommand: vi.fn()
    };

    const adapter = createCordisHostFromContext(ctx);
    const branch = await adapter.forkBranch?.({
      branchId: 'br-error',
      sessionId: 'sess-error',
      namespace: 'test:ns'
    });
    expect(branch?.isDisposed).toBe(false);

    // the wrapper may surface or absorb the failure, but it must never report a
    // live resource afterwards and must never call the disposer twice
    try {
      await branch?.dispose();
    } catch {
      // tolerated: propagating the host failure is acceptable behaviour
    }
    expect(branch?.isDisposed).toBe(true);
    expect(disposeCalls).toHaveLength(1);

    try {
      await branch?.dispose();
    } catch {
      // tolerated
    }
    expect(branch?.isDisposed).toBe(true);
    expect(disposeCalls).toHaveLength(1);
  });
});

describe('offline dreamer model wiring', () => {
  it('passes modelAdapter to createOfflineDreamer when a model is configured', async () => {
    const config = parseEvoHarnessConfig(e2eConfig());
    const model = createScriptedModel();
    const diagnostics: string[] = [];

    const { deps } = buildOrchestratorDeps(config, { model, now: makeClock() }, {}, diagnostics);

    const report = await deps.dreamer.replay({
      trees: [makeTreeSnapshot()],
      baselinePolicy: deps.policy.policy,
      candidatePolicies: []
    });

    // the model-backed PolicyGenerator is the selected generator, so the model
    // receives exactly one dream_policy completion request
    const dreamRequests = model.requests.filter((request) => request.purpose === 'dream_policy');
    expect(dreamRequests).toHaveLength(1);
    expect(dreamRequests[0]?.responseFormat).toBe('json');
    expect(report.ranAt).toBeGreaterThan(0);
  });

  it('keeps the deterministic generator when no model adapter is configured', async () => {
    const config = parseEvoHarnessConfig(e2eConfig());
    const diagnostics: string[] = [];

    const { deps } = buildOrchestratorDeps(config, { now: makeClock() }, {}, diagnostics);

    const report = await deps.dreamer.replay({
      trees: [makeTreeSnapshot()],
      baselinePolicy: deps.policy.policy,
      candidatePolicies: []
    });

    // no model is available, so the deterministic generator drives the dream and
    // every candidate policy carries its deterministic id prefix
    expect(report.candidateEvaluations.length).toBeGreaterThan(0);
    expect(
      report.candidateEvaluations.every((evaluation) => evaluation.policyId.startsWith('pi-0::dream-'))
    ).toBe(true);
  });

  it('lets the model-backed generator fall back to the deterministic generator', async () => {
    const config = parseEvoHarnessConfig(e2eConfig());
    const model = createScriptedModel();
    const diagnostics: string[] = [];

    const { deps } = buildOrchestratorDeps(config, { model, now: makeClock() }, {}, diagnostics);

    const report = await deps.dreamer.replay({
      trees: [makeTreeSnapshot()],
      baselinePolicy: deps.policy.policy,
      candidatePolicies: []
    });

    // the scripted model answers { "policies": [] }, which the generator cannot
    // use, so it must fall back instead of failing the dream cycle
    expect(model.requests.some((request) => request.purpose === 'dream_policy')).toBe(true);
    expect(report.candidateEvaluations.length).toBeGreaterThan(0);
    expect(
      report.candidateEvaluations.every((evaluation) => evaluation.policyId.startsWith('pi-0::dream-'))
    ).toBe(true);
  });
});

describe('config enforcement', () => {
  it('skips every run when config.enabled is false', async () => {
    const { ctx } = createFakeContext();
    const plugin = buildPlugin(ctx, { config: e2eConfig({ config: { enabled: false } }) });

    const result = await plugin.run({
      sessionId: 'sess-disabled',
      task: plugin.makeTask({ id: 'task-disabled', prompt: 'Do nothing.' }),
      trigger: 'always'
    });

    expect(result.outcome).toBe('skipped');
    expect(result.probesRun).toBe(0);
    expect(result.diagnostics.join(' ')).toContain('config.enabled=false');
  });

  it('does not wire or honour auto_fallback under triggerMode slash_command', async () => {
    const { ctx, events } = createFakeContext();
    const plugin = buildPlugin(ctx, {
      config: e2eConfig({ config: { triggerMode: 'slash_command' } })
    });

    // listeners are never registered, and an event call is refused outright
    expect(events.size).toBe(0);
    expect(plugin.registeredEvents).toEqual([]);
    expect(plugin.diagnostics.join(' ')).toContain('slash_command');
    expect(
      await plugin.handleFallbackEvent({
        sessionId: 'sess-slash',
        task: { id: 'task-slash', prompt: 'x' },
        failureSignals: [{ kind: 'tool_error', message: 'exit 1' }]
      })
    ).toBeNull();

    // auto_fallback runs are skipped while the explicit /evo path still works
    const auto = await plugin.run({
      sessionId: 'sess-slash',
      task: plugin.makeTask({ id: 'task-slash', prompt: 'Fix it.' }),
      trigger: 'auto_fallback',
      metadata: { failureSignals: [{ kind: 'tool_error', message: 'exit 1' }] }
    });
    expect(auto.outcome).toBe('skipped');
    expect(auto.probesRun).toBe(0);
    expect(auto.diagnostics.join(' ')).toContain('slash_command');

    const explicit = await plugin.runFromCommand('Fix the failing build.');
    expect(explicit.outcome).toBe('composed');
  });
});
