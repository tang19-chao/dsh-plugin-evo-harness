/**
 * DREAM-3: parent-chain walks and snapshot rebuilds must be cycle-safe.
 *
 * addNode cannot mint a cycle (the parent must exist before the child and
 * cannot be the node itself), but treeFromSnapshot rebuilds from an arbitrary
 * DiscoveryTreeSnapshot — the exact shape tree-pool.jsonl persists — so a
 * hand-edited or damaged snapshot with a cyclic parent graph must be rejected
 * instead of hanging a later ancestorsOf/causalPrefix walk forever.
 *
 * DREAM-6: bestNodeOf must not let a non-finite score win. Encountered first, a
 * NaN node used to become `best` unconditionally and every later comparison
 * (NaN < x is false) kept it there, shadowing all finite scores.
 */
import { describe, expect, it } from 'vitest';

import {
  bestNodeOf,
  createDiscoveryTree,
  isDiscoveryTreeGraphValid,
  treeFromSnapshot
} from '../../../src/dream-rsi/discovery-tree';
import type { DiscoveryNode, DiscoveryTreeSnapshot } from '../../../src/types/contracts';
import { childInput, fixedClock } from './fixtures';

function buildTree(): ReturnType<typeof createDiscoveryTree> {
  const tree = createDiscoveryTree({
    id: 'tree-1',
    sessionId: 'session-1',
    taskId: 'task-1',
    rootPatchId: 'patch-root',
    clock: fixedClock()
  });
  tree.addNode(childInput(tree.rootId, { id: 'a', origin: 'domain', purpose: 'explore' }));
  tree.addNode(childInput('a', { id: 'a1', purpose: 'deepen' }));
  return tree;
}

function nodeOf(snapshot: DiscoveryTreeSnapshot, id: string): DiscoveryNode {
  const node = snapshot.nodes[id];
  if (node === undefined) {
    throw new Error('missing node ' + id);
  }
  return node;
}

/**
 * A snapshot the tests may damage: `DiscoveryTreeSnapshot.nodes` is a readonly
 * record, so the fixtures build a mutable copy rather than asserting on a
 * `as any` cast that would hide a real contract change. A mutable record stays
 * assignable to the readonly contract the validators take.
 */
type MutableSnapshot = Omit<DiscoveryTreeSnapshot, 'nodes'> & {
  nodes: Record<string, DiscoveryNode>;
};

function mutableSnapshot(tree: ReturnType<typeof createDiscoveryTree>): MutableSnapshot {
  const snapshot = tree.snapshot();
  return { ...snapshot, nodes: { ...snapshot.nodes } };
}

/** Copy of one node with overrides; snapshots are immutable records. */
function withOverrides(
  node: DiscoveryNode,
  overrides: Partial<DiscoveryNode>
): DiscoveryNode {
  return { ...node, ...overrides };
}

describe('snapshot graph validation (DREAM-3)', () => {
  it('accepts an intact snapshot and rebuilds a working prefix walk', () => {
    const tree = buildTree();
    const snapshot = tree.snapshot();
    expect(isDiscoveryTreeGraphValid(snapshot)).toBe(true);
    const rebuilt = treeFromSnapshot(snapshot);
    expect(rebuilt.causalPrefix('a1').map((node) => node.id)).toEqual([
      snapshot.rootId,
      'a',
      'a1'
    ]);
  });

  it('rejects a two-node parent cycle instead of hanging the rebuild', () => {
    const tree = buildTree();
    const snapshot = mutableSnapshot(tree);
    snapshot.nodes['a'] = withOverrides(nodeOf(snapshot, 'a'), { parentId: 'a1' }); // a -> a1 -> a
    expect(isDiscoveryTreeGraphValid(snapshot)).toBe(false);
    expect(() => treeFromSnapshot(snapshot)).toThrow(/malformed/);
  });

  it('rejects a self-looping parent link', () => {
    const tree = buildTree();
    const snapshot = mutableSnapshot(tree);
    snapshot.nodes['a'] = withOverrides(nodeOf(snapshot, 'a'), { parentId: 'a' });
    expect(isDiscoveryTreeGraphValid(snapshot)).toBe(false);
    expect(() => treeFromSnapshot(snapshot)).toThrow(/malformed/);
  });

  it('rejects a cycle disconnected from the root', () => {
    const tree = buildTree();
    const snapshot = mutableSnapshot(tree);
    const source = nodeOf(snapshot, 'a');
    // Two fresh nodes whose parent links form a private 2-cycle; the root chain
    // stays intact, so only a walk over every node can find this one.
    snapshot.nodes['x'] = withOverrides(source, {
      id: 'x',
      parentId: 'y',
      childIds: [],
      createdAt: source.createdAt + 1,
      updatedAt: source.updatedAt + 1
    });
    snapshot.nodes['y'] = withOverrides(source, {
      id: 'y',
      parentId: 'x',
      childIds: [],
      createdAt: source.createdAt + 2,
      updatedAt: source.updatedAt + 2
    });
    expect(isDiscoveryTreeGraphValid(snapshot)).toBe(false);
    expect(() => treeFromSnapshot(snapshot)).toThrow(/malformed/);
  });

  it('rejects a dangling parent reference and a dangling child reference', () => {
    const tree = buildTree();
    const danglingParent = mutableSnapshot(tree);
    danglingParent.nodes['a'] = withOverrides(nodeOf(danglingParent, 'a'), {
      parentId: 'ghost'
    });
    expect(isDiscoveryTreeGraphValid(danglingParent)).toBe(false);
    expect(() => treeFromSnapshot(danglingParent)).toThrow(/malformed/);

    const danglingChild = mutableSnapshot(tree);
    danglingChild.nodes['a'] = withOverrides(nodeOf(danglingChild, 'a'), {
      childIds: [...nodeOf(danglingChild, 'a').childIds, 'ghost']
    });
    expect(isDiscoveryTreeGraphValid(danglingChild)).toBe(false);
    expect(() => treeFromSnapshot(danglingChild)).toThrow(/malformed/);
  });
});

describe('bestNodeOf ignores non-finite scores (DREAM-6)', () => {
  it('skips a NaN score encountered first instead of letting it shadow finite scores', () => {
    const tree = buildTree();
    tree.recordProbe('a', { trajectoryId: 'traj-a', score: Number.NaN });
    tree.recordProbe('a1', { trajectoryId: 'traj-a1', score: 0.4 });
    expect(bestNodeOf(tree)?.id).toBe('a1');
  });

  it('keeps the finite winner when a NaN score arrives later', () => {
    const tree = buildTree();
    tree.recordProbe('a', { trajectoryId: 'traj-a', score: 0.4 });
    tree.recordProbe('a1', { trajectoryId: 'traj-a1', score: Number.NaN });
    expect(bestNodeOf(tree)?.id).toBe('a');
  });

  it('treats Infinity as no score and returns undefined when nothing finite remains', () => {
    const tree = buildTree();
    tree.recordProbe('a', { trajectoryId: 'traj-a', score: Number.POSITIVE_INFINITY });
    tree.recordProbe('a1', { trajectoryId: 'traj-a1', score: 0.4 });
    expect(bestNodeOf(tree)?.id).toBe('a1');

    const onlyPoison = buildTree();
    onlyPoison.recordProbe('a', { trajectoryId: 'traj-a', score: Number.NaN });
    expect(bestNodeOf(onlyPoison)).toBeUndefined();
  });
});
