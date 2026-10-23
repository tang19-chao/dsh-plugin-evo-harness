/**
 * P0 integration wiring tests (t8).
 *
 * P0-2 and P0-4 shipped complete, tested modules that were never reachable from
 * the plugin entrypoint: `src/index.ts` had no import of `src/persistence` or
 * `src/dsh-bridge`, so `deps.treePool` still defaulted to the in-memory pool,
 * `deps.runBranch` still defaulted to the loud-failure runner, and the dream
 * cadence still used the private in-process counter. These tests pin the wiring
 * so a future refactor cannot silently drop it again.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  createAgentLoopExecutor,
  createEvoHarnessPlugin,
  createPersistenceRuntime,
  resolvePersistenceDataDir
} from '../../../src/index';
import type { AgentLoopAdapters, AgentLoopModel } from '../../../src/index';
import { createActivePolicyFromDefaults } from '../../../src/dream-rsi';
import type { IsolatedBranchContext, ProbeExecutionResult } from '../../../src/types/contracts';
import { buildE2E } from '../../e2e/fixtures';
import { cleanupDir, makeTempDir } from '../persistence/fixtures';

const tempDirs: string[] = [];

async function tempDir(label: string): Promise<string> {
  const dir = await makeTempDir(label);
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await cleanupDir(dir);
  }
});

/** A planner that answers immediately, so the probe needs no tool calls. */
const finalOnlyPlanner: AgentLoopModel = {
  async planNext() {
    return { kind: 'final', text: 'probe complete' };
  }
};

/** Minimal branch context for direct executor assertions. */
function branchContext(overrides: Partial<IsolatedBranchContext> = {}): IsolatedBranchContext {
  return {
    branchId: 'br-single',
    sessionId: 'sess-single',
    namespace: 'harness2:probe_br-single',
    task: { id: 'task-single', prompt: 'Fix the failing build.' },
    patch: {
      id: 'patch-single',
      sessionId: 'sess-single',
      branchId: 'br-single',
      origin: 'reference',
      purpose: 'initial',
      guidance: 'guidance_free',
      label: 'single',
      rationale: 'single-call degradation',
      createdAt: 1,
      edits: {}
    },
    mountedSurfaces: [],
    signal: new AbortController().signal,
    ...overrides
  };
}

describe('module entrypoint exports', () => {
  it('exposes the persistence and agent-bridge layers from the package root', () => {
    expect(typeof createPersistenceRuntime).toBe('function');
    expect(typeof resolvePersistenceDataDir).toBe('function');
    expect(typeof createAgentLoopExecutor).toBe('function');
  });
});

describe('persistence wiring', () => {
  it('uses the injected persistent TreePool instead of the in-memory default', async () => {
    const dataDir = await tempDir('integration-pool');
    const runtime = await createPersistenceRuntime({ dataDir, maxTrees: 100 });
    const { plugin } = buildE2E({ extra: { persistence: runtime } });

    expect(plugin.orchestrator.treePool).toBe(runtime.treePool);
    await plugin.dispose();
    await runtime.dispose();
  });

  it('resumes a persisted policy instead of resetting to pi^0', async () => {
    const dataDir = await tempDir('integration-policy');
    const runtime = await createPersistenceRuntime({ dataDir, maxTrees: 100 });
    const evolved = {
      ...createActivePolicyFromDefaults({}, { now: () => 1 }).policy,
      id: 'pi-restored-integration',
      version: 7
    };
    await runtime.policyStore.saveCurrent(evolved);
    await runtime.flush();

    const reopened = await createPersistenceRuntime({ dataDir, maxTrees: 100 });
    const { plugin } = buildE2E({ extra: { persistence: reopened } });

    // The plugin consumed the recovered stores rather than fresh in-memory ones.
    expect(plugin.orchestrator.treePool).toBe(reopened.treePool);
    // Mounting must not overwrite the recovered snapshot with a fresh pi^0: the
    // only policy write that can happen here is the wrapper's, and it preserves
    // the resumed base policy.
    expect((await reopened.policyStore.restore()).id).toBe('pi-restored-integration');

    const result = await plugin.run({
      runId: 'policy-resume',
      sessionId: 'sess-policy',
      task: plugin.makeTask({ prompt: 'Fix the failing build.' }),
      trigger: 'always'
    });
    expect(result.outcome).toBe('composed');
    // A run without a dream leaves the recovered policy untouched.
    expect(reopened.policyStore.current?.id).toBe('pi-restored-integration');

    await plugin.dispose();
    await reopened.dispose();
  });

  it('continues the durable dream cadence across a restart', async () => {
    const dataDir = await tempDir('integration-cadence');

    // Generation 1: two completed runs with the cadence set to every 2 tasks.
    const runtime1 = await createPersistenceRuntime({ dataDir, maxTrees: 100 });
    const gen1 = buildE2E({ dreamEveryNTasks: 2, extra: { persistence: runtime1 } });
    for (const runId of ['cad-1', 'cad-2']) {
      const result = await gen1.plugin.run({
        runId,
        sessionId: 'sess-cadence',
        task: gen1.plugin.makeTask({ prompt: 'Fix the failing build.' }),
        trigger: 'always'
      });
      expect(result.outcome).toBe('composed');
    }
    expect(runtime1.policyStore.counters.completedTasks).toBe(2);
    // The cadence fired on the second completed task.
    expect(runtime1.policyStore.counters.dreams).toBe(1);
    expect(gen1.plugin.orchestrator.dreamReports()).toHaveLength(1);
    await runtime1.flush();
    await gen1.plugin.dispose();

    // Generation 2: a fresh process must not reset the counter, so task 3 does
    // not dream and task 4 dreams again.
    const runtime2 = await createPersistenceRuntime({ dataDir, maxTrees: 100 });
    expect(runtime2.policyStore.counters.completedTasks).toBe(2);
    const gen2 = buildE2E({ dreamEveryNTasks: 2, extra: { persistence: runtime2 } });
    await gen2.plugin.run({
      runId: 'cad-3',
      sessionId: 'sess-cadence',
      task: gen2.plugin.makeTask({ prompt: 'Fix it again.' }),
      trigger: 'always'
    });
    expect(runtime2.policyStore.counters.completedTasks).toBe(3);
    expect(runtime2.policyStore.counters.dreams).toBe(1);
    expect(gen2.plugin.orchestrator.dreamReports()).toHaveLength(0);

    await gen2.plugin.run({
      runId: 'cad-4',
      sessionId: 'sess-cadence',
      task: gen2.plugin.makeTask({ prompt: 'Fix the remaining failure.' }),
      trigger: 'always'
    });
    expect(runtime2.policyStore.counters.completedTasks).toBe(4);
    expect(runtime2.policyStore.counters.dreams).toBe(2);
    expect(gen2.plugin.orchestrator.dreamReports()).toHaveLength(1);

    await runtime2.flush();
    await gen2.plugin.dispose();
    await runtime2.dispose();
  });

  it('flushes queued persistence writes on plugin dispose', async () => {
    const dataDir = await tempDir('integration-flush');
    const runtime = await createPersistenceRuntime({ dataDir, maxTrees: 100 });
    const { plugin } = buildE2E({ extra: { persistence: runtime } });

    await plugin.run({
      runId: 'flush-1',
      sessionId: 'sess-flush',
      task: plugin.makeTask({ prompt: 'Fix the failing build.' }),
      trigger: 'always'
    });
    // plugin.dispose() must flush the counter and tree writes.
    await plugin.dispose();

    const reopened = await createPersistenceRuntime({ dataDir, maxTrees: 100 });
    expect(reopened.treePool.size()).toBe(1);
    expect(reopened.policyStore.counters.completedTasks).toBe(1);
    await reopened.dispose();
  });
});

describe('agent-loop executor wiring', () => {
  it('activates the agent-loop executor when no runBranch is injected', () => {
    const plugin = createEvoHarnessPlugin({
      config: { logging: { level: 'silent' }, triggerMode: 'always' },
      agentLoop: { model: finalOnlyPlanner }
    });
    const diagnostics = plugin.diagnostics.join(' ');
    expect(diagnostics).toContain('multi-step agent probe executor is active');
    // describe() names the loop shape and the missing tool runtime honestly
    expect(diagnostics).toContain('agent loop (model -> tool -> result)');
    expect(diagnostics).toContain('no tool runtime');
    expect(diagnostics).toContain('max steps per probe: 4');
  });

  it('keeps an explicit runBranch ahead of the agent-loop executor', async () => {
    const loop: AgentLoopAdapters = { model: finalOnlyPlanner };
    const { plugin, runner } = buildE2E({ extra: { agentLoop: loop } });
    expect(plugin.diagnostics.join(' ')).not.toContain('multi-step agent probe executor is active');

    await plugin.run({
      runId: 'explicit-runner',
      sessionId: 'sess-explicit',
      task: plugin.makeTask({ prompt: 'Fix the failing build.' }),
      trigger: 'always'
    });
    // The injected runner did the probing, not the agent loop.
    expect(runner.calls.length).toBeGreaterThan(0);
  });

  it('degrades to a single call when the adapter has no planner', async () => {
    let completions = 0;
    const executor = createAgentLoopExecutor({
      model: {
        async complete(): Promise<{ text: string }> {
          completions += 1;
          return { text: 'single-call reply' };
        }
      }
    });
    const result: ProbeExecutionResult = await executor.runBranch(branchContext());
    expect(result.status).toBe('succeeded');
    expect(completions).toBe(1);
    expect(result.metadata?.['mode']).toBe('single_call');
  });

  it('describes the mode it will use so the plugin can report it', () => {
    const withPlanner = createAgentLoopExecutor({
      model: finalOnlyPlanner,
      tools: {
        listTools() {
          return [{ name: 'shell', description: 'run a command' }];
        },
        async callTool() {
          return { content: 'ok' };
        }
      } as never
    });
    const single = createAgentLoopExecutor({});
    expect(withPlanner.describe().join(' ')).toContain('model exposes planNext()');
    expect(withPlanner.describe().join(' ')).toContain('tool runtime: 1 tool(s)');
    expect(single.describe().join(' ')).toContain('no tool runtime');
  });
});
