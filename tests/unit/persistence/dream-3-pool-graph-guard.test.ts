/**
 * DREAM-3 (pool side): isDiscoveryTreeSnapshot must reject a snapshot whose
 * parent graph is cyclic or has dangling parent/child references. The pool log
 * is the offline dreamer's data source; a record that loops would hang a later
 * ancestorsOf/causalPrefix walk, so it fails the schema check and the JSONL
 * recovery quarantines it like any other corrupt record.
 */
import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';

import {
  PersistentTreePool,
  TREE_POOL_LOG_FILE,
  TreePoolStore,
  isDiscoveryTreeSnapshot
} from '../../../src/persistence/tree-pool.store';
import {
  encodeJsonlRecord,
  readTextIfExists,
  writeFileAtomic
} from '../../../src/persistence/data-dir';
import type { DiscoveryNode, DiscoveryTreeSnapshot } from '../../../src/types/contracts';
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

function nodeOf(snapshot: DiscoveryTreeSnapshot, id: string): DiscoveryNode {
  const node = snapshot.nodes[id];
  if (node === undefined) {
    throw new Error('missing node ' + id);
  }
  return node;
}

describe('discovery tree snapshot graph validation (DREAM-3)', () => {
  it('accepts the intact sample tree', () => {
    expect(isDiscoveryTreeSnapshot(sampleTree({ id: 'tree-a' }))).toBe(true);
  });

  it('rejects a parent cycle among persisted nodes', () => {
    const tree = sampleTree({ id: 'tree-a' });
    // Linear chain root -> n2 -> n3; pointing n2 back at n3 makes a 2-cycle.
    const cyclic: DiscoveryTreeSnapshot = {
      ...tree,
      nodes: {
        ...tree.nodes,
        'tree-a-n2': { ...nodeOf(tree, 'tree-a-n2'), parentId: 'tree-a-n3' }
      }
    };
    expect(isDiscoveryTreeSnapshot(cyclic)).toBe(false);
  });

  it('rejects a dangling parent reference', () => {
    const tree = sampleTree({ id: 'tree-a' });
    const dangling: DiscoveryTreeSnapshot = {
      ...tree,
      nodes: {
        ...tree.nodes,
        'tree-a-n2': { ...nodeOf(tree, 'tree-a-n2'), parentId: 'ghost' }
      }
    };
    expect(isDiscoveryTreeSnapshot(dangling)).toBe(false);
  });

  it('rejects a dangling child reference', () => {
    const tree = sampleTree({ id: 'tree-a' });
    const root = nodeOf(tree, tree.rootId);
    const dangling: DiscoveryTreeSnapshot = {
      ...tree,
      nodes: {
        ...tree.nodes,
        [tree.rootId]: { ...root, childIds: [...root.childIds, 'ghost'] }
      }
    };
    expect(isDiscoveryTreeSnapshot(dangling)).toBe(false);
  });

  it('quarantines a log record whose tree snapshot is cyclic instead of loading it', async () => {
    const dir = await tempDir('dream-3-cyclic-log');
    const tree = sampleTree({ id: 'tree-a' });
    const cyclic: DiscoveryTreeSnapshot = {
      ...tree,
      nodes: {
        ...tree.nodes,
        'tree-a-n2': { ...nodeOf(tree, 'tree-a-n2'), parentId: 'tree-a-n3' }
      }
    };
    await writeFileAtomic(
      path.join(dir, TREE_POOL_LOG_FILE),
      encodeJsonlRecord({ kind: 'tree', tree: cyclic, at: 1 })
    );

    const store = await TreePoolStore.open({ dataDir: dir });
    expect(store.loadedRecords).toBe(0);
    expect(store.repairedOnLoad).toBe(true);
    expect(store.quarantinedPaths).toEqual([path.join(dir, TREE_POOL_LOG_FILE) + '.corrupt']);
    expect(store.diagnostics.length).toBeGreaterThan(0);
    // The original bytes survive in the quarantine for postmortem analysis.
    const quarantined = await readTextIfExists(path.join(dir, TREE_POOL_LOG_FILE) + '.corrupt');
    expect(quarantined).toContain('"tree-a"');

    const pool = await PersistentTreePool.fromStore(store);
    expect(pool.size()).toBe(0);
  });
});
