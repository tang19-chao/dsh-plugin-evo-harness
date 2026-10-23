import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';

import {
  DEFAULT_COMPACT_AFTER_RECORDS,
  PersistentTreePool,
  TREE_POOL_LOG_FILE,
  TreePoolStore,
  isDiscoveryTreeSnapshot,
  isTreePoolRecord,
  minimizeTreePoolRecords,
  restoreTreePool
} from '../../../src/persistence/tree-pool.store';
import {
  encodeJsonlRecord,
  DIAGNOSTICS_FILE,
  pathExists,
  readTextIfExists,
  writeFileAtomic
} from '../../../src/persistence/data-dir';
import { cleanupDir, makeTempDir, sampleTree } from './fixtures';

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

function logPath(dataDir: string): string {
  return path.join(dataDir, TREE_POOL_LOG_FILE);
}

async function logLineCount(dataDir: string): Promise<number> {
  const text = (await readTextIfExists(logPath(dataDir))) ?? '';
  return text.split('\n').filter((line) => line.trim().length > 0).length;
}

describe('TreePoolStore', () => {
  it('persists appended trees and restores them after a restart', async () => {
    const dir = await tempDir('treepool-restart');
    const first = await TreePoolStore.open({ dataDir: dir });
    await first.append(sampleTree({ id: 'tree-a' }));
    await first.append(sampleTree({ id: 'tree-b' }));
    await first.flush();

    expect(first.loadedRecords).toBe(0);
    expect(await logLineCount(dir)).toBe(2);

    const restarted = await TreePoolStore.open({ dataDir: dir });
    expect(restarted.loadedRecords).toBe(2);
    expect(restarted.repairedOnLoad).toBe(false);

    const pool = await PersistentTreePool.fromStore(restarted);
    expect(pool.size()).toBe(2);
    expect(pool.list().map((tree) => tree.id)).toEqual(['tree-a', 'tree-b']);
    expect(pool.get('tree-a')).toEqual(sampleTree({ id: 'tree-a' }));
  });

  it('creates the data directory on first open', async () => {
    const dir = path.join(await tempDir('treepool-create'), 'nested', 'data');
    const store = await TreePoolStore.open({ dataDir: dir });
    expect(await pathExists(dir)).toBe(true);
    expect(store.logPath).toBe(path.join(dir, TREE_POOL_LOG_FILE));
    expect(store.loadedRecords).toBe(0);
    expect(DEFAULT_COMPACT_AFTER_RECORDS).toBeGreaterThan(0);
  });

  it('persists pruning so the bound survives a restart', async () => {
    const dir = await tempDir('treepool-prune');
    const store = await TreePoolStore.open({ dataDir: dir });
    const pool = await PersistentTreePool.fromStore(store, 2);
    pool.add(sampleTree({ id: 'tree-a' }));
    pool.add(sampleTree({ id: 'tree-b' }));
    pool.add(sampleTree({ id: 'tree-c' }));
    expect(pool.size()).toBe(2);
    expect(pool.get('tree-a')).toBeUndefined();
    await pool.flush();

    const restarted = await PersistentTreePool.restore({ dataDir: dir, maxTrees: 2 });
    expect(restarted.size()).toBe(2);
    expect(restarted.list().map((tree) => tree.id)).toEqual(['tree-b', 'tree-c']);
  });

  it('persists clear', async () => {
    const dir = await tempDir('treepool-clear');
    const store = await TreePoolStore.open({ dataDir: dir });
    const pool = await PersistentTreePool.fromStore(store, 10);
    pool.add(sampleTree({ id: 'tree-a' }));
    await pool.flush();
    pool.clear();
    expect(pool.size()).toBe(0);
    await pool.flush();

    const restarted = await PersistentTreePool.restore({ dataDir: dir, maxTrees: 10 });
    expect(restarted.size()).toBe(0);
  });

  it('compacts the log atomically while preserving every retained tree', async () => {
    const dir = await tempDir('treepool-compact');
    const store = await TreePoolStore.open({ dataDir: dir, compactAfterRecords: 4 });
    const pool = await PersistentTreePool.fromStore(store, 3);
    for (let index = 1; index <= 6; index += 1) {
      pool.add(sampleTree({ id: 'tree-' + String(index) }));
    }
    await pool.flush();
    // Six adds with a bound of three leave at most a handful of lines, not twelve.
    expect(await logLineCount(dir)).toBeLessThanOrEqual(8);

    const restarted = await PersistentTreePool.restore({ dataDir: dir, maxTrees: 3 });
    expect(restarted.size()).toBe(3);
    expect(restarted.list().map((tree) => tree.id)).toEqual(['tree-4', 'tree-5', 'tree-6']);
  });

  it('recovers the healthy prefix of a torn log and quarantines the original', async () => {
    const dir = await tempDir('treepool-torn');
    const record = { kind: 'tree', tree: sampleTree({ id: 'tree-a' }), at: 1 };
    await writeFileAtomic(
      logPath(dir),
      encodeJsonlRecord(record) + '{"kind":"tree","tree":{"id":"bro'
    );

    const store = await TreePoolStore.open({ dataDir: dir });
    expect(store.loadedRecords).toBe(1);
    expect(store.repairedOnLoad).toBe(true);
    expect(store.quarantinedPaths).toEqual([logPath(dir) + '.corrupt']);
    expect(store.diagnostics.length).toBeGreaterThan(0);
    const diagnosticsLog = (await readTextIfExists(path.join(dir, DIAGNOSTICS_FILE))) ?? '';
    expect(diagnosticsLog).toContain('partially written trailing record');

    const pool = await PersistentTreePool.fromStore(store);
    expect(pool.size()).toBe(1);

    const second = await TreePoolStore.open({ dataDir: dir });
    expect(second.loadedRecords).toBe(1);
    expect(second.quarantinedPaths).toEqual([]);
    expect(second.diagnostics).toEqual([]);
  });

  it('keeps the prefix and quarantines an interior corrupt record', async () => {
    const dir = await tempDir('treepool-interior');
    const goodA = { kind: 'tree', tree: sampleTree({ id: 'tree-a' }), at: 1 };
    const goodB = { kind: 'tree', tree: sampleTree({ id: 'tree-b' }), at: 2 };
    await writeFileAtomic(
      logPath(dir),
      encodeJsonlRecord(goodA) + 'not-a-record\n' + encodeJsonlRecord(goodB)
    );

    const store = await TreePoolStore.open({ dataDir: dir });
    expect(store.loadedRecords).toBe(1);
    expect(store.quarantinedPaths).toEqual([logPath(dir) + '.corrupt']);
    const restarted = await readTextIfExists(logPath(dir));
    expect(restarted).toBe(encodeJsonlRecord(goodA));
  });

  it('treats a schema-invalid record as corruption', async () => {
    const dir = await tempDir('treepool-schema');
    const good = { kind: 'tree', tree: sampleTree({ id: 'tree-a' }), at: 1 };
    await writeFileAtomic(
      logPath(dir),
      encodeJsonlRecord(good) + encodeJsonlRecord({ kind: 'unknown', at: 2 }) + encodeJsonlRecord({ kind: 'unknown', at: 3 })
    );
    const store = await TreePoolStore.open({ dataDir: dir });
    expect(store.loadedRecords).toBe(1);
    expect(store.quarantinedPaths).toHaveLength(1);
  });

  it('reports an id collision instead of silently dropping a persisted tree', async () => {
    const dir = await tempDir('treepool-collision');
    const store = await TreePoolStore.open({ dataDir: dir });
    const pool = await PersistentTreePool.fromStore(store, 10);
    pool.add(sampleTree({ id: 'tree-a', childCount: 1 }));
    // A restarted host whose id factory restarts at 1 can reuse a tree id; the
    // contract upserts, so the overwrite must at least be observable.
    pool.add(sampleTree({ id: 'tree-a', childCount: 3 }));
    expect(pool.size()).toBe(1);
    expect(pool.diagnostics.some((line) => line.includes('collision'))).toBe(true);
    await pool.flush();
    const diagnosticsLog = (await readTextIfExists(path.join(dir, DIAGNOSTICS_FILE))) ?? '';
    expect(diagnosticsLog).toContain('collision');

    const restarted = await PersistentTreePool.restore({ dataDir: dir, maxTrees: 10 });
    expect(Object.keys(restarted.get('tree-a')?.nodes ?? {})).toHaveLength(4);
  });

  it('restores through the injection seam with a persistent pool', async () => {
    const dir = await tempDir('treepool-seam');
    const store = await TreePoolStore.open({ dataDir: dir });
    const pool = await PersistentTreePool.fromStore(store, 10);
    pool.add(sampleTree({ id: 'tree-a' }));
    await pool.flush();

    const restored = await restoreTreePool({ dataDir: dir, maxTrees: 10 });
    expect(restored.pool).toBeInstanceOf(PersistentTreePool);
    expect(restored.pool.size()).toBe(1);
    expect(restored.added).toBe(1);
    expect(restored.removed).toEqual([]);
    expect(restored.diagnostics).toEqual([]);

    // The restored pool keeps writing through to the same log.
    restored.pool.add(sampleTree({ id: 'tree-b' }));
    await restored.pool.flush();
    const third = await restoreTreePool({ dataDir: dir, maxTrees: 10 });
    expect(third.pool.list().map((tree) => tree.id)).toEqual(['tree-a', 'tree-b']);
  });
});

describe('tree pool record helpers', () => {
  it('minimizes an event log to last-write-wins state', () => {
    const a = sampleTree({ id: 'tree-a' });
    const b = sampleTree({ id: 'tree-b' });
    const minimized = minimizeTreePoolRecords([
      { kind: 'tree', tree: a, at: 1 },
      { kind: 'tree', tree: b, at: 2 },
      { kind: 'remove', treeIds: ['tree-a'], at: 3 },
      { kind: 'tree', tree: a, at: 4 }
    ]);
    expect(minimized.map((record) => (record.kind === 'tree' ? record.tree.id : record.kind))).toEqual([
      'tree-b',
      'tree-a'
    ]);

    expect(minimizeTreePoolRecords([{ kind: 'clear', at: 5 }, { kind: 'tree', tree: b, at: 6 }])).toHaveLength(1);
  });

  it('validates snapshots and records structurally', () => {
    const tree = sampleTree({ id: 'tree-a' });
    expect(isDiscoveryTreeSnapshot(tree)).toBe(true);
    expect(isDiscoveryTreeSnapshot({ ...tree, rootId: 'missing-root' })).toBe(false);
    expect(isDiscoveryTreeSnapshot({ ...tree, nodes: { root: { id: 'root' } } })).toBe(false);
    expect(isTreePoolRecord({ kind: 'tree', tree, at: 1 })).toBe(true);
    expect(isTreePoolRecord({ kind: 'tree', tree: { id: 'broken' }, at: 1 })).toBe(false);
    expect(isTreePoolRecord({ kind: 'remove', treeIds: [], at: 1 })).toBe(false);
    expect(isTreePoolRecord({ kind: 'clear', at: 1 })).toBe(true);
    expect(isTreePoolRecord({ kind: 'clear' })).toBe(false);
  });
});