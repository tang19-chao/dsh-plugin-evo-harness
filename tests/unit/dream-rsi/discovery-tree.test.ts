import { describe, expect, it } from 'vitest';

import {
  FutureNodeVisibilityError,
  UnknownDiscoveryNodeError,
  bestNodeOf,
  createDiscoveryTree,
  createDiscoveryTreePool,
  createReplayPrefixView,
  isTerminalNodeStatus,
  rootNodeOf,
  treeFromSnapshot
} from '../../../src/dream-rsi/discovery-tree';
import { childInput, fixedClock, makeDiagnosis, nodeInput } from './fixtures';

function buildTree(): ReturnType<typeof createDiscoveryTree> {
  const tree = createDiscoveryTree({
    id: 'tree-1',
    sessionId: 'session-1',
    taskId: 'task-1',
    rootPatchId: 'patch-root',
    clock: fixedClock()
  });
  const root = tree.rootId;
  tree.addNode(childInput(root, { id: 'a', origin: 'domain', purpose: 'explore' }));
  tree.addNode(childInput(root, { id: 'b', origin: 'invariant', guidance: 'guidance_free' }));
  tree.addNode(childInput('a', { id: 'a1', purpose: 'deepen' }));
  tree.addNode(childInput('a', { id: 'a2', purpose: 'repair' }));
  return tree;
}

describe('discovery tree structure', () => {
  it('creates a root node with depth 0 and no parent', () => {
    const tree = buildTree();
    const root = tree.getNode(tree.rootId);
    expect(root).toBeDefined();
    expect(root?.depth).toBe(0);
    expect(root?.parentId).toBeNull();
    expect(root?.status).toBe('proposed');
    expect(root?.treeId).toBe('tree-1');
    expect(tree.id).toBe('tree-1');
    expect(tree.sessionId).toBe('session-1');
    expect(tree.taskId).toBe('task-1');
  });

  it('links children, assigns depth and keeps insertion order', () => {
    const tree = buildTree();
    expect(tree.allNodes().map((node) => node.id)).toEqual([
      tree.rootId,
      'a',
      'b',
      'a1',
      'a2'
    ]);
    expect(tree.childrenOf(tree.rootId).map((node) => node.id)).toEqual(['a', 'b']);
    expect(tree.getNode('a1')?.depth).toBe(2);
    expect(tree.getNode(tree.rootId)?.childIds).toEqual(['a', 'b']);
  });

  it('rejects duplicate ids and unknown parents', () => {
    const tree = buildTree();
    expect(() => tree.addNode(nodeInput({ id: 'a' }))).toThrow(/Duplicate/);
    expect(() => tree.addNode(childInput('missing', { id: 'c' }))).toThrow(
      UnknownDiscoveryNodeError
    );
    expect(() => tree.getNode('missing')).not.toThrow();
    expect(tree.getNode('missing')).toBeUndefined();
    expect(() => tree.childrenOf('missing')).toThrow(UnknownDiscoveryNodeError);
    expect(() => tree.causalPrefix('missing')).toThrow(UnknownDiscoveryNodeError);
  });

  it('exposes ancestors and the causal prefix in root-to-node order', () => {
    const tree = buildTree();
    expect(tree.ancestorsOf(tree.rootId)).toEqual([]);
    expect(tree.ancestorsOf('a1').map((node) => node.id)).toEqual([tree.rootId, 'a']);
    expect(tree.causalPrefix('a1').map((node) => node.id)).toEqual([
      tree.rootId,
      'a',
      'a1'
    ]);
    expect(tree.causalPrefix(tree.rootId).map((node) => node.id)).toEqual([tree.rootId]);
  });

  it('records probe results and computes snapshot stats', () => {
    const tree = buildTree();
    tree.recordProbe('a', { trajectoryId: 'traj-a', score: 0.6, adoptionRatio: 0.5 });
    tree.recordProbe('b', {
      trajectoryId: 'traj-b',
      status: 'failed',
      score: 0.1,
      failure: makeDiagnosis('repairable_implementation')
    });
    tree.setStatus('a2', 'pruned');
    const stats = tree.getStats();
    expect(stats.nodeCount).toBe(5);
    expect(stats.maxDepth).toBe(2);
    expect(stats.maxWidth).toBe(2);
    expect(stats.scoredNodes).toBe(2);
    expect(stats.completedNodes).toBe(2);
    expect(tree.getNode('a')?.status).toBe('succeeded');
    expect(tree.getNode('a')?.trajectoryId).toBe('traj-a');
    expect(tree.getNode('a')?.adoptionRatio).toBe(0.5);
    expect(tree.getNode('a2')?.status).toBe('pruned');
    expect(isTerminalNodeStatus('pruned')).toBe(true);
    expect(isTerminalNodeStatus('proposed')).toBe(false);
  });

  it('returns snapshots that do not observe later mutations', () => {
    const tree = buildTree();
    const snapshot = tree.snapshot();
    tree.addNode(childInput('b', { id: 'late' }));
    expect(Object.keys(snapshot.nodes)).toHaveLength(5);
    expect(snapshot.stats.nodeCount).toBe(5);
    expect(tree.snapshot().stats.nodeCount).toBe(6);
    expect(snapshot.rootId).toBe(tree.rootId);
    expect(snapshot.sessionId).toBe('session-1');
    expect(snapshot.completed).toBe(false);
  });

  it('round-trips through treeFromSnapshot', () => {
    const tree = buildTree();
    tree.recordProbe('a', { trajectoryId: 'traj-a', score: 0.4 });
    tree.setCompleted(true);
    tree.setPolicyId('pi-0');
    const snapshot = tree.snapshot();
    const rebuilt = treeFromSnapshot(snapshot);
    expect(rebuilt.id).toBe('tree-1');
    expect(rebuilt.isCompleted()).toBe(true);
    expect(rebuilt.getStats()).toEqual(snapshot.stats);
    expect(rebuilt.snapshot().policyId).toBe('pi-0');
    expect(rebuilt.causalPrefix('a1').map((node) => node.id)).toEqual([
      snapshot.rootId,
      'a',
      'a1'
    ]);
    expect(rebuilt.getNode('a')?.score).toBe(0.4);
  });

  it('finds the best scored node and the root', () => {
    const tree = buildTree();
    tree.recordProbe('a', { trajectoryId: 'traj-a', score: 0.3 });
    tree.recordProbe('b', { trajectoryId: 'traj-b', score: 0.9, status: 'failed' });
    expect(bestNodeOf(tree)?.id).toBe('b');
    expect(rootNodeOf(tree)?.id).toBe(tree.rootId);
    const empty = createDiscoveryTree({
      id: 'tree-empty',
      sessionId: 's',
      taskId: 't',
      rootPatchId: 'p',
      clock: fixedClock()
    });
    expect(bestNodeOf(empty)).toBeUndefined();
    expect(rootNodeOf(empty)?.id).toBe(empty.rootId);
  });

  it('throws when rebuilding from a snapshot whose root is missing', () => {
    const tree = buildTree();
    const snapshot = tree.snapshot();
    const broken = { ...snapshot, rootId: 'ghost' };
    expect(() => treeFromSnapshot(broken)).toThrow(UnknownDiscoveryNodeError);
  });
});

describe('causal prefix replay view', () => {
  it('exposes only the anchor causal prefix', () => {
    const tree = buildTree();
    const view = createReplayPrefixView(tree, 'a1');
    expect(view.anchorNodeId).toBe('a1');
    expect(view.visibleNodeIds()).toEqual([tree.rootId, 'a', 'a1']);
    expect(view.allNodes().map((node) => node.id)).toEqual([tree.rootId, 'a', 'a1']);
    expect(view.isVisible('a1')).toBe(true);
    expect(view.isVisible('a2')).toBe(false);
    expect(view.isVisible('b')).toBe(false);
    expect([...view.hiddenNodeIds].sort()).toEqual(['a2', 'b']);
  });

  it('hides future and sibling nodes from queries', () => {
    const tree = buildTree();
    const view = createReplayPrefixView(tree, 'a1');
    expect(view.getNode('a2')).toBeUndefined();
    expect(view.getNode('b')).toBeUndefined();
    expect(view.getNode('a1')?.id).toBe('a1');
    expect(view.childrenOf('a1')).toEqual([]);
    expect(view.childrenOf(tree.rootId).map((node) => node.id)).toEqual(['a']);
    expect(view.ancestorsOf('a1').map((node) => node.id)).toEqual([tree.rootId, 'a']);
  });

  it('rejects invisible nodes hard when asked for a prefix', () => {
    const tree = buildTree();
    const view = createReplayPrefixView(tree, 'a1');
    expect(() => view.causalPrefix('a2')).toThrow(FutureNodeVisibilityError);
    expect(() => view.ancestorsOf('b')).toThrow(FutureNodeVisibilityError);
    expect(() => view.childrenOf('b')).toThrow(FutureNodeVisibilityError);
    expect(() => view.assertVisible('b')).toThrow(FutureNodeVisibilityError);
    expect(view.assertVisible('a').id).toBe('a');
  });

  it('can throw instead of returning undefined in strict mode', () => {
    const tree = buildTree();
    const view = createReplayPrefixView(tree, 'a1', { strict: true });
    expect(() => view.getNode('b')).toThrow(FutureNodeVisibilityError);
    expect(view.getNode('a')?.id).toBe('a');
    try {
      view.getNode('b');
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(FutureNodeVisibilityError);
      const typed = error as FutureNodeVisibilityError;
      expect(typed.code).toBe('FUTURE_NODE_NOT_VISIBLE');
      expect(typed.nodeId).toBe('b');
      expect(typed.anchorNodeId).toBe('a1');
      expect(typed.treeId).toBe('tree-1');
    }
  });

  it('snapshots only the prefix and marks itself prefix-only', () => {
    const tree = buildTree();
    tree.recordProbe('a', { trajectoryId: 'traj-a', score: 0.7 });
    const view = createReplayPrefixView(tree, 'a1');
    const snapshot = view.snapshot();
    expect(Object.keys(snapshot.nodes).sort()).toEqual(['a', 'a1', tree.rootId].sort());
    expect(snapshot.stats.nodeCount).toBe(3);
    expect(snapshot.stats.maxDepth).toBe(2);
    expect(snapshot.stats.scoredNodes).toBe(1);
    expect(snapshot.rootId).toBe(tree.rootId);
    expect(snapshot.metadata?.prefixOnly).toBe(true);
    expect(snapshot.id).toContain('::prefix::a1');
  });

  it('rejects an unknown anchor', () => {
    const tree = buildTree();
    expect(() => createReplayPrefixView(tree, 'ghost')).toThrow(UnknownDiscoveryNodeError);
  });

  it('keeps the prefix frozen after later mutations', () => {
    const tree = buildTree();
    const view = createReplayPrefixView(tree, 'a');
    tree.addNode(childInput('a', { id: 'a-late' }));
    expect(tree.getNode('a-late')).toBeDefined();
    expect(view.isVisible('a-late')).toBe(false);
    expect(view.visibleNodeIds()).toEqual([tree.rootId, 'a']);
    expect(view.snapshot().stats.nodeCount).toBe(2);
  });
});

describe('historical discovery tree pool', () => {
  it('stores, retrieves and lists snapshots', () => {
    const pool = createDiscoveryTreePool();
    const tree = buildTree();
    const snapshot = tree.snapshot();
    pool.add(snapshot);
    expect(pool.size()).toBe(1);
    expect(pool.get('tree-1')?.id).toBe('tree-1');
    expect(pool.list().map((entry) => entry.id)).toEqual(['tree-1']);
    expect(pool.get('missing')).toBeUndefined();
  });

  it('moves re-added trees to the most-recent position', () => {
    const pool = createDiscoveryTreePool();
    const first = buildTree().snapshot();
    const second = { ...first, id: 'tree-2' };
    pool.add(first);
    pool.add(second);
    pool.add(first);
    expect(pool.list().map((entry) => entry.id)).toEqual(['tree-2', 'tree-1']);
    expect(pool.size()).toBe(2);
  });

  it('prunes oldest trees and reports removed ids', () => {
    const pool = createDiscoveryTreePool();
    for (const id of ['t1', 't2', 't3', 't4']) {
      pool.add({ ...buildTree().snapshot(), id });
    }
    expect(pool.pruneTo(2)).toEqual(['t1', 't2']);
    expect(pool.list().map((entry) => entry.id)).toEqual(['t3', 't4']);
    expect(pool.pruneTo(0)).toEqual([]);
    expect(pool.pruneTo(10)).toEqual([]);
    pool.clear();
    expect(pool.size()).toBe(0);
    expect(pool.list()).toEqual([]);
  });

  it('auto-prunes when a maxTrees bound is configured', () => {
    const pool = createDiscoveryTreePool({ maxTrees: 2 });
    for (const id of ['t1', 't2', 't3']) {
      pool.add({ ...buildTree().snapshot(), id });
    }
    expect(pool.list().map((entry) => entry.id)).toEqual(['t2', 't3']);
    expect(pool.size()).toBe(2);
  });
});
