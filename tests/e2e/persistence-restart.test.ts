import { afterEach, describe, expect, it } from 'vitest';

import { createActivePolicy, createActivePolicyFromDefaults } from '../../src/dream-rsi';
import { createPersistenceRuntime } from '../../src/persistence';
import type { MetaSearchPolicy } from '../../src/types/contracts';
import { buildE2E, makeClock } from './fixtures';
import { cleanupDir, makeTempDir, samplePolicy } from '../unit/persistence/fixtures';

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

/**
 * Multi-generation restart test: two independent runtime+plugin generations run
 * against the same profile data directory, exactly as two host processes would.
 * The second generation must see the first generation's completed probe tree,
 * evolved policy and task counter, and must keep writing through the same files.
 */
describe('persistence across a simulated host restart', () => {
  it('restores the tree pool, the evolved policy and the dream counter', async () => {
    const dataDir = await tempDir('e2e-restart');

    // ---- generation 1: run one evolution, evolve pi_t, complete one task ----
    const runtime1 = await createPersistenceRuntime({ dataDir, maxTrees: 200 });
    expect(runtime1.diagnostics).toEqual([]);
    const policy1 = runtime1.wrapPolicy(createActivePolicyFromDefaults({}, { now: makeClock() }));
    const generation1 = buildE2E({
      extra: { deps: { treePool: runtime1.treePool, policy: policy1 } }
    });
    // The plugin really consumed the injected persistent pool.
    expect(generation1.plugin.orchestrator.treePool).toBe(runtime1.treePool);

    const first = await generation1.plugin.run({
      runId: 'run-gen-1',
      sessionId: 'sess-restart',
      task: generation1.plugin.makeTask({
        prompt: 'Fix the failing build without breaking the release train.'
      }),
      trigger: 'always'
    });
    expect(first.outcome).toBe('composed');
    expect(runtime1.treePool.size()).toBe(1);

    // Simulate the offline-dream policy upgrade the orchestrator performs through
    // IActivePolicy.update, then record the dream and the completed task.
    const evolved: MetaSearchPolicy = {
      ...samplePolicy('pi-evolved', 2),
      parentPolicyId: policy1.policy.id
    };
    policy1.update(evolved);
    expect(policy1.policy.id).toBe('pi-evolved');
    expect(await runtime1.policyStore.recordCompletedTask()).toBe(1);
    expect(runtime1.policyStore.shouldDream(2)).toBe(false);
    expect(await runtime1.policyStore.recordDream()).toBe(1);
    await runtime1.flush();
    await generation1.plugin.dispose();

    // ---- generation 2: a fresh process over the same data directory ----
    const runtime2 = await createPersistenceRuntime({ dataDir, maxTrees: 200 });
    expect(runtime2.diagnostics).toEqual([]);
    expect(runtime2.treePool.size()).toBe(1);
    const restoredTree = runtime2.treePool.list()[0];
    expect(restoredTree?.sessionId).toBe('sess-restart');
    expect(Object.keys(restoredTree?.nodes ?? {}).length).toBeGreaterThanOrEqual(2);

    expect(runtime2.policyStore.counters.completedTasks).toBe(1);
    expect(runtime2.policyStore.counters.dreams).toBe(1);
    expect(runtime2.policyStore.shouldDream(2)).toBe(false);
    const restoredPolicy = await runtime2.policyStore.restore();
    expect(restoredPolicy.id).toBe('pi-evolved');

    // The cadence continues where generation 1 stopped: count 2 dreams at every 2.
    expect(await runtime2.policyStore.recordCompletedTask()).toBe(2);
    expect(runtime2.policyStore.shouldDream(2)).toBe(true);

    // ---- generation 2 also runs, and its tree is retained for generation 3 ----
    const policy2 = runtime2.wrapPolicy(
      createActivePolicy({ policy: restoredPolicy, now: makeClock() })
    );
    const generation2 = buildE2E({
      extra: { deps: { treePool: runtime2.treePool, policy: policy2 } }
    });
    const second = await generation2.plugin.run({
      runId: 'run-gen-2',
      sessionId: 'sess-restart',
      task: generation2.plugin.makeTask({ prompt: 'Fix the remaining release-train failure.' }),
      trigger: 'always'
    });
    expect(second.outcome).toBe('composed');
    await runtime2.flush();
    expect(runtime2.treePool.size()).toBe(2);
    await generation2.plugin.dispose();

    // ---- generation 3: both trees and the counter are restored ----
    const runtime3 = await createPersistenceRuntime({ dataDir, maxTrees: 200 });
    expect(runtime3.treePool.size()).toBe(2);
    expect(runtime3.treePool.list().map((tree) => tree.sessionId)).toEqual([
      'sess-restart',
      'sess-restart'
    ]);
    expect(runtime3.policyStore.current?.id).toBe('pi-evolved');
    expect(runtime3.policyStore.counters.completedTasks).toBe(2);
    await runtime3.dispose();
  });

  it('runs with the default (profile-resolved) data directory options', async () => {
    const dataDir = await tempDir('e2e-default-dir');
    const runtime = await createPersistenceRuntime({ dataDir });
    expect(runtime.dataDir).toBe(dataDir);
    const pool = runtime.treePool;
    expect(pool.size()).toBe(0);
    expect(await runtime.policyStore.restore()).toBeDefined();
    await runtime.flush();
    await runtime.dispose();
  });
});