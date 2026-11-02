/**
 * P1-7a (DREAM-1, id-seeding part): the plugin's default newId sequence is
 * seeded from the persisted task counter when persistence is injected.
 *
 * Without the seed, a restarted host mints `evo-1` again, the first completed
 * run recreates the same tree id, and PersistentTreePool's upsert overwrites
 * the persisted generation-1 tree - deterministic replay-corpus loss. Both
 * generations here mount through options.persistence and use the PRODUCTION
 * default id factory (no options.newId), exactly like the documented durable
 * mount; the second mount must not collide with the first generation's tree.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { createEvoHarnessPlugin } from '../../../src/index';
import { createPersistenceRuntime } from '../../../src/persistence';
import type { PersistenceRuntime } from '../../../src/persistence';
import {
  createScriptedModel,
  createScriptedRunner,
  e2eConfig,
  makeClock,
  mem0LikeServer
} from '../../e2e/fixtures';
import { cleanupDir, makeTempDir } from './fixtures';

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

/** Mount a plugin over a persistence runtime with the production id factory. */
function mountPlugin(runtime: PersistenceRuntime) {
  return createEvoHarnessPlugin({
    config: e2eConfig(),
    model: createScriptedModel(),
    clients: [mem0LikeServer().client],
    runBranch: createScriptedRunner(makeClock()),
    now: makeClock(),
    persistence: runtime
  });
}

describe('P1-7a: the default newId sequence is seeded from the persisted task counter', () => {
  it('a second mount over the same data dir never mints the first generation tree id again', async () => {
    const dataDir = await tempDir('id-seeding');

    // ---- generation 1: one completed run persists tree #1 and the counter ----
    const runtime1 = await createPersistenceRuntime({ dataDir, maxTrees: 200 });
    const plugin1 = mountPlugin(runtime1);
    const first = await plugin1.run({
      sessionId: 'sess-seed',
      task: plugin1.makeTask({ prompt: 'Fix the failing build.' }),
      trigger: 'always'
    });
    expect(first.outcome).toBe('composed');
    expect(runtime1.treePool.size()).toBe(1);
    const firstTreeId = runtime1.treePool.list()[0]?.id;
    expect(firstTreeId).toBeDefined();
    await runtime1.flush();
    await plugin1.dispose();

    // ---- generation 2: a fresh process over the same data directory ----
    const runtime2 = await createPersistenceRuntime({ dataDir, maxTrees: 200 });
    expect(runtime2.policyStore.counters.completedTasks).toBe(1);
    expect(runtime2.treePool.size()).toBe(1);
    const plugin2 = mountPlugin(runtime2);
    const second = await plugin2.run({
      sessionId: 'sess-seed',
      task: plugin2.makeTask({ prompt: 'Fix the remaining release-train failure.' }),
      trigger: 'always'
    });
    expect(second.outcome).toBe('composed');
    await runtime2.flush();

    // Without the seeded sequence this run would recreate the generation-1 tree
    // id and the upsert would overwrite it, leaving the pool at 1 tree.
    expect(runtime2.treePool.size()).toBe(2);
    const ids = runtime2.treePool.list().map((tree) => tree.id);
    expect(new Set(ids).size).toBe(2);
    expect(second.treeId).toBeDefined();
    expect(second.treeId).not.toBe(firstTreeId);
    expect(runtime2.policyStore.counters.completedTasks).toBe(2);
    await runtime2.dispose();
  });
});
