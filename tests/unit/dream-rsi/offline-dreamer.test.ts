import { describe, expect, it, vi } from 'vitest';

import {
  createModelPolicyGenerator,
  createOfflineDreamer,
  evaluatePolicy,
  generateCandidatePolicies,
  normalizeRhoPreferences,
  replayNodeScore,
  replayPolicy,
  replayTree,
  scalarizedUtility,
  toPolicyEvaluation
} from '../../../src/dream-rsi/offline-dreamer';
import { createDiscoveryTree, createDiscoveryTreePool, createReplayPrefixView } from '../../../src/dream-rsi/discovery-tree';
import type {
  DiscoveryTreeSnapshot,
  IModelAdapter,
  MetaSearchPolicy,
  OfflineDreamRequest
} from '../../../src/types/contracts';
import { childInput, fixedClock, makeDiagnosis, makePolicy } from './fixtures';

function richTree(): DiscoveryTreeSnapshot {
  const tree = createDiscoveryTree({
    id: 'tree-1',
    sessionId: 'session-1',
    taskId: 'task-1',
    rootPatchId: 'patch-root',
    clock: fixedClock()
  });
  tree.addNode(childInput(tree.rootId, { id: 'good', origin: 'domain', purpose: 'explore' }));
  tree.recordProbe('good', { trajectoryId: 'traj-good', score: 1, adoptionRatio: 1 });
  tree.addNode(
    childInput(tree.rootId, { id: 'meh', origin: 'invariant', guidance: 'guidance_free' })
  );
  tree.recordProbe('meh', { trajectoryId: 'traj-meh', score: 0.4 });
  tree.addNode(childInput('good', { id: 'deep', purpose: 'deepen' }));
  tree.recordProbe('deep', { trajectoryId: 'traj-deep', score: 0.95 });
  return tree.snapshot();
}

function narrowPolicy(overrides: Partial<MetaSearchPolicy> = {}): MetaSearchPolicy {
  return makePolicy({ id: 'pi-narrow', maxWidth: 1, maxDepth: 1, ...overrides });
}

/**
 * Four shallow siblings plus a deeper branch that holds the best recorded
 * outcome (every score stays below the default early-stop threshold): this
 * distinguishes a wide-shallow policy from a narrow-deep one.
 */
function deepTree(): DiscoveryTreeSnapshot {
  const tree = createDiscoveryTree({
    id: 'tree-deep',
    sessionId: 'session-1',
    taskId: 'task-1',
    rootPatchId: 'patch-root',
    clock: fixedClock()
  });
  tree.addNode(childInput(tree.rootId, { id: 's1', origin: 'domain', purpose: 'explore' }));
  tree.recordProbe('s1', { trajectoryId: 'traj-s1', score: 0.1 });
  tree.addNode(childInput(tree.rootId, { id: 's2', origin: 'domain', purpose: 'explore' }));
  tree.recordProbe('s2', { trajectoryId: 'traj-s2', score: 0.3 });
  tree.addNode(childInput(tree.rootId, { id: 's3', origin: 'domain', purpose: 'explore' }));
  tree.recordProbe('s3', { trajectoryId: 'traj-s3', score: 0.2 });
  tree.addNode(childInput(tree.rootId, { id: 's4', origin: 'domain', purpose: 'explore' }));
  tree.recordProbe('s4', { trajectoryId: 'traj-s4', score: 0.15 });
  tree.addNode(childInput('s2', { id: 'd1', purpose: 'deepen' }));
  tree.recordProbe('d1', { trajectoryId: 'traj-d1', score: 0.35 });
  tree.addNode(childInput('d1', { id: 'd2', purpose: 'deepen' }));
  tree.recordProbe('d2', { trajectoryId: 'traj-d2', score: 0.4 });
  tree.addNode(childInput('d2', { id: 'd3', purpose: 'deepen' }));
  tree.recordProbe('d3', { trajectoryId: 'traj-d3', score: 0.55 });
  return tree.snapshot();
}

/** Wide-but-shallow (4x1) policy over deepTree. */
function shallowPolicy(): MetaSearchPolicy {
  return makePolicy({ id: 'pi-shallow', maxWidth: 4, maxDepth: 1 });
}

/** Narrow-but-deep (1x4) policy over deepTree. */
function deepPolicy(): MetaSearchPolicy {
  return makePolicy({ id: 'pi-deep', maxWidth: 1, maxDepth: 4 });
}

function dreamRequest(overrides: Partial<OfflineDreamRequest> = {}): OfflineDreamRequest {
  return {
    trees: overrides.trees ?? [richTree()],
    baselinePolicy: overrides.baselinePolicy ?? narrowPolicy(),
    candidatePolicies: overrides.candidatePolicies ?? [],
    ...(overrides.rhoPreferences === undefined
      ? {}
      : { rhoPreferences: overrides.rhoPreferences }),
    ...(overrides.minReplayTrees === undefined ? {} : { minReplayTrees: overrides.minReplayTrees })
  };
}

describe('replay primitives', () => {
  it('scores recorded nodes from score, success or failure', () => {
    const tree = richTree();
    const good = tree.nodes.good;
    const root = tree.nodes[tree.rootId];
    expect(good).toBeDefined();
    expect(root).toBeDefined();
    if (good === undefined || root === undefined) {
      throw new Error('fixture missing');
    }
    expect(replayNodeScore(good)).toBe(1);
    expect(replayNodeScore(root)).toBe(0);
    expect(
      replayNodeScore({ ...root, status: 'succeeded', score: undefined })
    ).toBe(0.5);
    expect(replayNodeScore({ ...good, score: 5 })).toBe(1);
    expect(replayNodeScore({ ...good, score: -2 })).toBe(0);
  });

  it('normalizes, clamps, dedupes and sorts rho preferences', () => {
    expect(normalizeRhoPreferences(undefined)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(normalizeRhoPreferences([1, 0, 0.5, 0.5, -1, 2, Number.NaN])).toEqual([
      0,
      0.5,
      1
    ]);
    expect(normalizeRhoPreferences([])).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it('scalarizes quality and cost into [0, 1]', () => {
    expect(scalarizedUtility(1, 4, 0, 4)).toBe(1);
    expect(scalarizedUtility(0, 4, 1, 4)).toBe(0);
    expect(scalarizedUtility(0.5, 2, 0.5, 4)).toBeCloseTo(0.5, 10);
    expect(scalarizedUtility(10, 0, 0.5, 4)).toBe(1);
    expect(scalarizedUtility(-5, 100, 1, 0)).toBe(0);
  });

  it('scales the probe budget with the rho preference', () => {
    const tree = createDiscoveryTree({
      id: 'tree-budget',
      sessionId: 'session-1',
      taskId: 'task-1',
      rootPatchId: 'patch-root',
      clock: fixedClock()
    });
    tree.recordProbe(tree.rootId, { trajectoryId: 'traj-root', score: 0.05 });
    tree.addNode(childInput(tree.rootId, { id: 'b1' }));
    tree.recordProbe('b1', { trajectoryId: 'traj-b1', score: 0.1 });
    tree.addNode(childInput(tree.rootId, { id: 'b2' }));
    tree.recordProbe('b2', { trajectoryId: 'traj-b2', score: 0.4 });
    tree.addNode(childInput('b1', { id: 'b1a' }));
    tree.recordProbe('b1a', { trajectoryId: 'traj-b1a', score: 0.3 });
    tree.addNode(childInput('b2', { id: 'b2a' }));
    tree.recordProbe('b2a', { trajectoryId: 'traj-b2a', score: 0.65 });
    tree.addNode(childInput('b2', { id: 'b2b' }));
    tree.recordProbe('b2b', { trajectoryId: 'traj-b2b', score: 0.7 });
    tree.addNode(childInput('b2a', { id: 'b2a1' }));
    tree.recordProbe('b2a1', { trajectoryId: 'traj-b2a1', score: 0.85 });
    const snapshot = tree.snapshot();
    const exhaustive = makePolicy({
      id: 'pi-exhaustive',
      maxWidth: 4,
      maxDepth: 4,
      earlyStopThreshold: 1
    });
    const atZero = replayTree(snapshot, exhaustive, 0);
    const atOne = replayTree(snapshot, exhaustive, 1);
    // rho=0 => width 2, depth 2, budget 4; rho=1 => width 4, depth 4, budget 16.
    expect(atZero.probes).toBe(4);
    expect(atOne.probes).toBe(6);
    expect(atZero.probes).toBeLessThan(atOne.probes);
    expect(atZero.probes).toBeLessThanOrEqual(2 * 2);
    expect(atOne.probes).toBeLessThanOrEqual(4 * 4);
    expect(atZero.quality).toBe(0.7);
    expect(atOne.quality).toBe(0.85);
    expect(atOne.visitedNodeIds[0]).toBe(snapshot.rootId);
    expect(atOne.evidence.join(' ')).toContain('candidateProbes=');
  });

  it('stops early once the quality threshold is reached', () => {
    const tree = richTree();
    const stopping = replayTree(tree, makePolicy({ id: 'pi-stop', maxWidth: 4, maxDepth: 4 }), 1);
    expect(stopping.earlyStopped).toBe(true);
    expect(stopping.quality).toBe(1);
    expect(stopping.probes).toBe(1);
    expect(stopping.visitedNodeIds).toEqual([tree.rootId, 'good']);
  });

  it('only visits recorded nodes reachable from the root', () => {
    const fresh = createDiscoveryTree({
      id: 'tree-view',
      sessionId: 'session-1',
      taskId: 'task-1',
      rootPatchId: 'patch-root',
      clock: fixedClock()
    });
    fresh.addNode(childInput(fresh.rootId, { id: 'only' }));
    const view = createReplayPrefixView(fresh, fresh.rootId);
    expect(view.visibleNodeIds()).toEqual([fresh.rootId]);
    expect(view.getNode('only')).toBeUndefined();

    const snapshot = richTree();
    const outcome = replayTree(snapshot, narrowPolicy(), 1);
    expect(outcome.visitedNodeIds).toEqual([snapshot.rootId, 'good']);
    expect(outcome.probes).toBe(1);
  });

  it('does not charge a recovery probe after an early stop', () => {
    const tree = createDiscoveryTree({
      id: 'tree-early',
      sessionId: 'session-1',
      taskId: 'task-1',
      rootPatchId: 'patch-root',
      clock: fixedClock()
    });
    tree.addNode(childInput(tree.rootId, { id: 'good', origin: 'domain', purpose: 'explore' }));
    tree.recordProbe('good', { trajectoryId: 'traj-good', score: 0.9 });
    tree.addNode(childInput(tree.rootId, { id: 'broken', origin: 'reference', purpose: 'repair' }));
    tree.recordProbe('broken', {
      trajectoryId: 'traj-broken',
      status: 'failed',
      score: 0,
      failure: makeDiagnosis('repairable_implementation')
    });
    const snapshot = tree.snapshot();

    // Layer 1 reaches the early-stop threshold (0.8) while a repairable failure
    // and budget remain: stopping must not be charged an extra phantom probe.
    const stopped = replayTree(
      snapshot,
      makePolicy({ id: 'pi-early-stop', maxWidth: 2, maxDepth: 2 }),
      1
    );
    expect(stopped.earlyStopped).toBe(true);
    expect(stopped.quality).toBe(0.9);
    expect(stopped.visitedNodeIds).toEqual([snapshot.rootId, 'good']);
    expect(stopped.visitedNodeIds).not.toContain('broken');
    expect(stopped.probes).toBe(1);
    expect(stopped.probes).toBe(stopped.visitedNodeIds.length - 1);

    // Control: without reaching the threshold the recovery probe still runs.
    const control = replayTree(
      snapshot,
      makePolicy({ id: 'pi-no-early-stop', maxWidth: 1, maxDepth: 3, earlyStopThreshold: 1 }),
      1
    );
    expect(control.earlyStopped).toBe(false);
    expect(control.probes).toBe(2);
    expect(control.visitedNodeIds).toEqual([snapshot.rootId, 'good', 'broken']);
    expect(control.evidence.join(' ')).toContain('recovery probe charged');
  });

  it('charges a recovery probe without inventing a post-repair outcome', () => {
    const tree = createDiscoveryTree({
      id: 'tree-r',
      sessionId: 'session-1',
      taskId: 'task-1',
      rootPatchId: 'patch-root',
      clock: fixedClock()
    });
    tree.recordProbe(tree.rootId, { trajectoryId: 'traj-root', score: 0.2 });
    tree.addNode(childInput(tree.rootId, { id: 'good', purpose: 'deepen' }));
    tree.recordProbe('good', { trajectoryId: 'traj-good', score: 0.5 });
    tree.addNode(childInput('good', { id: 'deeper', purpose: 'deepen' }));
    tree.recordProbe('deeper', { trajectoryId: 'traj-deeper', score: 0.9 });
    tree.addNode(childInput(tree.rootId, { id: 'broken', purpose: 'repair' }));
    tree.recordProbe('broken', {
      trajectoryId: 'traj-broken',
      status: 'failed',
      score: 0,
      failure: makeDiagnosis('repairable_implementation')
    });
    const snapshot = tree.snapshot();
    // width 1 / depth 3 => budget 3, but the best branch dies out after 2 probes,
    // so the recovery injection is what spends the remaining budget.
    const withoutRecovery = replayTree(
      snapshot,
      makePolicy({ id: 'pi-no-recover', maxWidth: 1, maxDepth: 3, earlyStopThreshold: 1, slotWeights: { exploit: 0.6, explore_domain: 0.2, explore_invariant: 0.2, recover: 0 } }),
      1
    );
    const withRecovery = replayTree(
      snapshot,
      makePolicy({ id: 'pi-recover', maxWidth: 1, maxDepth: 3, earlyStopThreshold: 1 }),
      1
    );
    expect(withoutRecovery.visitedNodeIds).toEqual([snapshot.rootId, 'good', 'deeper']);
    expect(withoutRecovery.probes).toBe(2);
    expect(withRecovery.probes).toBe(3);
    expect(withRecovery.probes).toBeLessThanOrEqual(1 * 3);
    expect(withRecovery.quality).toBe(withoutRecovery.quality);
    expect(withRecovery.visitedNodeIds).toContain('broken');
    expect(withoutRecovery.visitedNodeIds).not.toContain('broken');
    expect(withRecovery.evidence.join(' ')).toContain('recovery probe charged');
  });

  it('aggregates a replay run into a bounded evaluation', () => {
    const tree = richTree();
    const policy = makePolicy({ id: 'pi-wide', maxWidth: 4, maxDepth: 4 });
    const run = replayPolicy([tree], policy, [0, 0.5, 1]);
    expect(run.policyId).toBe('pi-wide');
    expect(run.treeIds).toEqual(['tree-1']);
    expect(Object.keys(run.outcomes).sort()).toEqual(['0', '0.5', '1']);
    expect(run.maxProbes).toBeGreaterThanOrEqual(1);
    const evaluation = toPolicyEvaluation(run, run.maxProbes);
    expect(evaluation.policyId).toBe('pi-wide');
    expect(evaluation.hypervolume).toBeGreaterThanOrEqual(0);
    expect(evaluation.hypervolume).toBeLessThanOrEqual(1);
    expect(evaluation.meanCost).toBeGreaterThanOrEqual(0);
    expect(evaluation.meanCost).toBeLessThanOrEqual(1);
    expect(evaluation.meanQuality).toBeGreaterThan(0);
    expect(evaluation.treesEvaluated).toBe(1);
    expect(Object.keys(evaluation.perRho).sort()).toEqual(['0', '0.5', '1']);
  });

  it('evaluates a policy with its own ceiling for ad-hoc comparisons', () => {
    const trees = [deepTree()];
    const deep = evaluatePolicy(trees, deepPolicy(), [0, 1]);
    const shallow = evaluatePolicy(trees, shallowPolicy(), [0, 1]);
    expect(deep.hypervolume).toBeGreaterThan(shallow.hypervolume);
  });

  it('visits the root and then exactly depth candidate layers', () => {
    const snapshot = deepTree();
    const depthOne = replayTree(
      snapshot,
      makePolicy({ id: 'pi-1x1', maxWidth: 1, maxDepth: 1 }),
      1
    );
    expect(depthOne.visitedNodeIds).toEqual([snapshot.rootId, 's2']);
    expect(depthOne.probes).toBe(1);
    expect(depthOne.quality).toBe(0.3);
    expect(depthOne.evidence.join(' ')).toContain('depth=1');

    const depthTwo = replayTree(
      snapshot,
      makePolicy({ id: 'pi-1x2', maxWidth: 1, maxDepth: 2 }),
      1
    );
    expect(depthTwo.visitedNodeIds).toEqual([snapshot.rootId, 's2', 'd1']);
    expect(depthTwo.probes).toBe(2);
    expect(depthTwo.quality).toBe(0.35);
  });

  it('caps each candidate layer at width so a narrow-deep policy follows one branch', () => {
    const snapshot = deepTree();
    const outcome = replayTree(snapshot, deepPolicy(), 1);
    expect(outcome.visitedNodeIds).toEqual([snapshot.rootId, 's2', 'd1', 'd2', 'd3']);
    expect(outcome.probes).toBe(4);
    expect(outcome.quality).toBe(0.55);
    for (const sibling of ['s1', 's3', 's4']) {
      expect(outcome.visitedNodeIds).not.toContain(sibling);
    }
    expect(outcome.probes).toBeLessThanOrEqual(1 * 4);
  });

  it('distinguishes a narrow-deep policy from a wide-shallow one', () => {
    const snapshot = deepTree();
    const narrowDeep = replayTree(snapshot, deepPolicy(), 1);
    const wideShallow = replayTree(snapshot, shallowPolicy(), 1);
    expect(narrowDeep.probes).toBe(4);
    expect(wideShallow.probes).toBe(4);
    expect(narrowDeep.quality).toBe(0.55);
    expect(wideShallow.quality).toBe(0.3);
    expect(narrowDeep.visitedNodeIds).not.toEqual(wideShallow.visitedNodeIds);
    expect(wideShallow.visitedNodeIds).toEqual([snapshot.rootId, 's2', 's1', 's3', 's4']);
  });

  it('replays deterministically for identical inputs', () => {
    const snapshot = deepTree();
    const first = replayTree(snapshot, deepPolicy(), 1);
    const second = replayTree(snapshot, deepPolicy(), 1);
    expect(second.visitedNodeIds).toEqual(first.visitedNodeIds);
    expect(second.probes).toBe(first.probes);
    expect(second.quality).toBe(first.quality);
    expect(second.evidence).toEqual(first.evidence);
  });

  it('never spends more than width * depth candidate probes', () => {
    const snapshot = deepTree();
    for (const rho of [0, 0.25, 0.5, 0.75, 1]) {
      for (const policy of [deepPolicy(), shallowPolicy(), narrowPolicy({ maxWidth: 2, maxDepth: 3 })]) {
        const outcome = replayTree(snapshot, policy, rho);
        const width = Math.max(1, Math.round(policy.maxWidth * (0.5 + 0.5 * rho)));
        const depth = Math.max(1, Math.round(policy.maxDepth * (0.5 + 0.5 * rho)));
        expect(outcome.probes).toBeLessThanOrEqual(width * depth);
      }
    }
  });
});

describe('deterministic candidate generation', () => {
  it('produces bounded, uniquely identified variants', () => {
    const baseline = narrowPolicy();
    const candidates = generateCandidatePolicies(baseline, 6, { now: () => 11 });
    expect(candidates).toHaveLength(6);
    expect(new Set(candidates.map((policy) => policy.id)).size).toBe(6);
    for (const policy of candidates) {
      expect(policy.parentPolicyId).toBe(baseline.id);
      expect(policy.version).toBe(baseline.version + 1);
      expect(policy.maxWidth).toBeGreaterThanOrEqual(1);
      expect(policy.maxWidth).toBeLessThanOrEqual(8);
      expect(policy.maxDepth).toBeGreaterThanOrEqual(1);
      expect(policy.maxDepth).toBeLessThanOrEqual(8);
      expect(policy.earlyStopThreshold).toBeGreaterThanOrEqual(0);
      expect(policy.earlyStopThreshold).toBeLessThanOrEqual(1);
      expect(policy.createdAt).toBe(11);
    }
    expect(generateCandidatePolicies(baseline, 0)).toEqual([]);
  });

  it('clamps the variant count', () => {
    expect(generateCandidatePolicies(narrowPolicy(), 1000)).toHaveLength(32);
  });
});

describe('model-backed policy generation', () => {
  const baseline = narrowPolicy();

  it('parses, sanitizes and labels model proposals', async () => {
    const adapter: IModelAdapter = {
      complete: async () => ({
        text:
          'Here you go: [{"maxWidth": 99, "maxDepth": 2, "earlyStopThreshold": 4, "slotWeights": {"exploit": 0.5, "explore_domain": 0.3, "explore_invariant": 0.1, "recover": 0.1}}]'
      })
    };
    const generator = createModelPolicyGenerator(adapter, { now: () => 21 });
    const policies = await generator(baseline, 3, dreamRequest());
    expect(policies).toHaveLength(1);
    expect(policies[0]?.id).toBe('pi-narrow::dream-m1');
    expect(policies[0]?.metadata?.generator).toBe('model');
    expect(policies[0]?.maxWidth).toBe(8);
    expect(policies[0]?.maxDepth).toBe(2);
    expect(policies[0]?.earlyStopThreshold).toBe(1);
    expect(policies[0]?.createdAt).toBe(21);
  });

  it('falls back to the deterministic generator on junk output', async () => {
    const adapter: IModelAdapter = { complete: async () => ({ text: 'not json at all' }) };
    const generator = createModelPolicyGenerator(adapter, { now: () => 21 });
    const policies = await generator(baseline, 2, dreamRequest());
    expect(policies).toHaveLength(2);
    expect(policies[0]?.metadata?.generator).toBe('deterministic');
  });

  it('falls back when the adapter throws', async () => {
    const adapter: IModelAdapter = {
      complete: async () => {
        throw new Error('provider down');
      }
    };
    const generator = createModelPolicyGenerator(adapter, { now: () => 21 });
    const policies = await generator(baseline, 2, dreamRequest());
    expect(policies).toHaveLength(2);
    expect(policies[0]?.id).toContain('::dream-');
  });

  it('accepts a custom fallback generator', async () => {
    const adapter: IModelAdapter = { complete: async () => ({ text: '[]' }) };
    const generator = createModelPolicyGenerator(adapter, {
      fallback: () => [makePolicy({ id: 'custom-fallback' })]
    });
    const policies = await generator(baseline, 2, dreamRequest());
    expect(policies.map((policy) => policy.id)).toEqual(['custom-fallback']);
  });
});

describe('offline dreamer monotonic replay', () => {
  it('keeps the baseline when no candidate strictly improves', async () => {
    const applyPolicy = vi.fn();
    const dreamer = createOfflineDreamer({ now: () => 99, applyPolicy });
    const baseline = narrowPolicy();
    const report = await dreamer.replay(
      dreamRequest({
        baselinePolicy: baseline,
        candidatePolicies: [makePolicy({ id: 'pi-same', maxWidth: 1, maxDepth: 1, version: 2 })]
      })
    );
    expect(report.improved).toBe(false);
    expect(report.selectedPolicyId).toBe('pi-narrow');
    expect(report.best.policyId).toBe('pi-narrow');
    expect(report.best).toEqual(report.baseline);
    expect(report.candidateEvaluations).toHaveLength(1);
    expect(applyPolicy).not.toHaveBeenCalled();
    expect(report.ranAt).toBe(99);
    expect(report.replayedTreeIds).toEqual(['tree-1']);
    expect(report.rhoPreferences).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it('hot-swaps to the strictly better candidate', async () => {
    const applied: MetaSearchPolicy[] = [];
    const dreamer = createOfflineDreamer({
      now: () => 100,
      applyPolicy: (policy) => {
        applied.push(policy);
      }
    });
    const report = await dreamer.replay(
      dreamRequest({
        trees: [deepTree()],
        baselinePolicy: shallowPolicy(),
        candidatePolicies: [makePolicy({ id: 'pi-deep', maxWidth: 1, maxDepth: 4, version: 2 })]
      })
    );
    expect(report.improved).toBe(true);
    expect(report.selectedPolicyId).toBe('pi-deep');
    expect(report.best.policyId).toBe('pi-deep');
    expect(report.best.hypervolume).toBeGreaterThan(report.baseline.hypervolume);
    expect(report.baseline.hypervolume).toBeCloseTo(0.1875, 6);
    expect(report.best.hypervolume).toBeCloseTo(0.235, 6);
    expect(applied.map((policy) => policy.id)).toEqual(['pi-deep']);
  });

  it('applies the winner through an injected active policy', async () => {
    const updates: MetaSearchPolicy[] = [];
    const dreamer = createOfflineDreamer({
      now: () => 100,
      activePolicy: {
        update: (policy) => {
          updates.push(policy);
        }
      }
    });
    const report = await dreamer.replay(
      dreamRequest({
        trees: [deepTree()],
        baselinePolicy: shallowPolicy(),
        candidatePolicies: [makePolicy({ id: 'pi-deep', maxWidth: 1, maxDepth: 4, version: 2 })]
      })
    );
    expect(report.improved).toBe(true);
    expect(updates.map((policy) => policy.id)).toEqual(['pi-deep']);
  });

  it('picks the best of several candidates deterministically', async () => {
    const dreamer = createOfflineDreamer({ now: () => 100 });
    const report = await dreamer.replay(
      dreamRequest({
        trees: [deepTree()],
        baselinePolicy: shallowPolicy(),
        candidatePolicies: [
          makePolicy({ id: 'pi-wide', maxWidth: 4, maxDepth: 1, version: 2 }),
          makePolicy({ id: 'pi-deep-b', maxWidth: 1, maxDepth: 4, version: 2 }),
          makePolicy({ id: 'pi-deep-a', maxWidth: 1, maxDepth: 4, version: 2 })
        ]
      })
    );
    expect(report.candidateEvaluations).toHaveLength(3);
    expect(report.improved).toBe(true);
    expect(report.selectedPolicyId).toBe('pi-deep-a');
  });

  it('generates candidates when the request carries none', async () => {
    const generator = vi.fn((baseline: MetaSearchPolicy, count: number) =>
      generateCandidatePolicies(baseline, count, { now: () => 5 })
    );
    const dreamer = createOfflineDreamer({ now: () => 100, generatePolicies: generator, policyCount: 3 });
    const report = await dreamer.replay(dreamRequest({ candidatePolicies: [] }));
    expect(generator).toHaveBeenCalledTimes(1);
    expect(generator.mock.calls[0]?.[1]).toBe(3);
    expect(report.candidateEvaluations).toHaveLength(3);
  });

  it('uses the deterministic generator by default', async () => {
    const dreamer = createOfflineDreamer({ now: () => 100, policyCount: 2 });
    const report = await dreamer.replay(dreamRequest({ candidatePolicies: [] }));
    expect(report.candidateEvaluations).toHaveLength(2);
    expect(report.selectedPolicyId).toBe('pi-narrow');
  });

  it('filters duplicate and structurally invalid candidates', async () => {
    const dreamer = createOfflineDreamer({ now: () => 100 });
    const report = await dreamer.replay(
      dreamRequest({
        candidatePolicies: [
          makePolicy({ id: 'pi-narrow', maxWidth: 4, maxDepth: 4 }),
          makePolicy({ id: 'pi-broken', maxWidth: -3 }),
          makePolicy({ id: 'pi-wide', maxWidth: 4, maxDepth: 4, version: 2 })
        ]
      })
    );
    expect(report.candidateEvaluations.map((entry) => entry.policyId)).toEqual(['pi-wide']);
  });

  it('refuses to dream without enough replay trees', async () => {
    const dreamer = createOfflineDreamer({ now: () => 100, minReplayTrees: 2 });
    const report = await dreamer.replay(
      dreamRequest({
        minReplayTrees: 2,
        candidatePolicies: [
          makePolicy({ id: 'pi-wide', maxWidth: 4, maxDepth: 4, version: 2 })
        ]
      })
    );
    expect(report.improved).toBe(false);
    expect(report.candidateEvaluations).toEqual([]);
    expect(report.replayedTreeIds).toEqual([]);
    expect(report.best.policyId).toBe('pi-narrow');
    expect(report.best.treesEvaluated).toBe(0);
  });

  it('skips empty trees and reports them as not replayed', async () => {
    const empty: DiscoveryTreeSnapshot = {
      id: 'tree-empty',
      sessionId: 'session-1',
      taskId: 'task-1',
      rootId: 'ghost',
      nodes: {},
      stats: { nodeCount: 0, maxDepth: 0, maxWidth: 0, scoredNodes: 0, completedNodes: 0 },
      completed: false,
      createdAt: 1,
      updatedAt: 1
    };
    const dreamer = createOfflineDreamer({ now: () => 100 });
    const report = await dreamer.replay(
      dreamRequest({
        trees: [empty],
        candidatePolicies: [
          makePolicy({ id: 'pi-wide', maxWidth: 4, maxDepth: 4, version: 2 })
        ]
      })
    );
    expect(report.replayedTreeIds).toEqual([]);
    expect(report.improved).toBe(false);
  });

  it('ranks a cheap policy above an expensive one at high rho', () => {
    const trees = [deepTree()];
    const shared = { costCeiling: 4 };
    const cheap = evaluatePolicy(trees, narrowPolicy(), [0, 1], shared);
    const expensive = evaluatePolicy(trees, deepPolicy(), [0, 1], shared);
    expect(cheap.perRho['1']).toBeGreaterThan(expensive.perRho['1'] as number);
    expect(expensive.perRho['0']).toBeGreaterThan(cheap.perRho['0'] as number);
  });

  it('caches replayed trees into the historical pool', async () => {
    const pool = createDiscoveryTreePool({ maxTrees: 4 });
    const dreamer = createOfflineDreamer({ now: () => 100, treePool: pool });
    await dreamer.replay(dreamRequest({ candidatePolicies: [] }));
    expect(pool.size()).toBe(1);
    expect(pool.get('tree-1')?.id).toBe('tree-1');
  });

  it('runs zero execution: a tree of proposed nodes yields no quality', async () => {
    const tree = createDiscoveryTree({
      id: 'tree-unprobed',
      sessionId: 'session-1',
      taskId: 'task-1',
      rootPatchId: 'patch-root',
      clock: fixedClock()
    });
    tree.addNode(childInput(tree.rootId, { id: 'child' }));
    const dreamer = createOfflineDreamer({ now: () => 100 });
    const report = await dreamer.replay(
      dreamRequest({
        trees: [tree.snapshot()],
        candidatePolicies: [
          makePolicy({ id: 'pi-wide', maxWidth: 4, maxDepth: 4, version: 2 })
        ]
      })
    );
    expect(report.baseline.meanQuality).toBe(0);
    expect(report.improved).toBe(false);
  });

  it('mixes a model adapter into candidate generation without real LLM calls', async () => {
    const adapter: IModelAdapter = {
      complete: async () => ({
        text:
          '[{"maxWidth": 1, "maxDepth": 4, "earlyStopThreshold": 0.8, "slotWeights": {"exploit": 0.4, "explore_domain": 0.3, "explore_invariant": 0.2, "recover": 0.1}}]'
      })
    };
    const dreamer = createOfflineDreamer({ now: () => 100, modelAdapter: adapter });
    const report = await dreamer.replay(
      dreamRequest({
        trees: [deepTree()],
        baselinePolicy: shallowPolicy(),
        candidatePolicies: []
      })
    );
    expect(report.candidateEvaluations).toHaveLength(1);
    expect(report.selectedPolicyId).toBe('pi-shallow::dream-m1');
    expect(report.improved).toBe(true);
  });
});

describe('early-stop probe accounting', () => {
  it('does not charge a recovery probe once the policy early-stopped', () => {
    const tree = createDiscoveryTree({
      id: 'tree-early-stop',
      sessionId: 'session-early',
      taskId: 'task-early',
      rootPatchId: 'patch-root',
      clock: fixedClock()
    });
    tree.recordProbe(tree.rootId, { trajectoryId: 'traj-root', score: 0.1 });
    // top of layer 1: reaches the early-stop threshold on the first charged probe
    tree.addNode(childInput(tree.rootId, { id: 'hot', origin: 'domain', purpose: 'explore' }));
    tree.recordProbe('hot', { trajectoryId: 'traj-hot', score: 1 });
    // a repairable failure the recovery injection would otherwise charge a phantom
    // probe for, even though the policy already decided to stop
    tree.addNode(
      childInput(tree.rootId, { id: 'broken', origin: 'reference', purpose: 'repair' })
    );
    tree.recordProbe('broken', {
      trajectoryId: 'traj-broken',
      status: 'failed',
      score: 0,
      failure: makeDiagnosis('repairable_implementation', { repairHint: 'repair it' })
    });

    const policy = makePolicy({
      maxWidth: 2,
      maxDepth: 2,
      earlyStopThreshold: 0.8,
      slotWeights: { exploit: 0.4, explore_domain: 0.3, explore_invariant: 0.2, recover: 0.1 }
    });

    const outcome = replayTree(tree.snapshot(), policy, 1);

    expect(outcome.earlyStopped).toBe(true);
    // exactly the one charged probe that triggered the stop: the recovery injection
    // must not add a phantom probe beyond the early-stop decision
    expect(outcome.probes).toBe(1);
    expect(outcome.visitedNodeIds).toEqual([tree.rootId, 'hot']);
    expect(outcome.evidence.some((line) => line.startsWith('recovery probe charged'))).toBe(false);
  });
});
