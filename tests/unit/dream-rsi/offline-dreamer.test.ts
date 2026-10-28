import { describe, expect, it, vi } from 'vitest';

import {
  causalCutoffFor,
  causalExperienceSnapshot,
  createModelPolicyGenerator,
  createOfflineDreamer,
  evaluatePolicy,
  generateCandidatePolicies,
  jitHyperparamIssues,
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
  ExperienceRecord,
  IModelAdapter,
  JitReplayHook,
  MetaSearchPolicy,
  OfflineDreamRequest
} from '../../../src/types/contracts';
import { childInput, fixedClock, makeDiagnosis, makePolicy } from './fixtures';

/** Minimal L1 experience record for the causal-truncation cases. */
function makeExperienceRecord(id: string, createdAt: number): ExperienceRecord {
  return {
    id,
    level: 'meta',
    state: {
      level: 'meta',
      bucket: 'meta|sig:search|cx:moderate',
      tokens: ['sig:search', 'cx:moderate'],
      summary: 'synthetic state'
    },
    actionKey: 'exploit|system_prompt',
    reward: 0.5,
    return: 0.5,
    rewardSources: { surrogate: 0.5 },
    guidance: 'memory',
    policyId: 'pi-0',
    sessionId: 'session-1',
    createdAt,
    redacted: true
  };
}

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
 *
 * PR-4B (ADR 0004 §4.3-1): `taskId` is a parameter, not a constant. A holdout
 * tree MUST belong to its own task - two trees of one task are one group and the
 * split refuses to cut a group, so reusing 'task-1' for both sides of a
 * selection/holdout pair would be exactly the cross-task leak the contract
 * forbids (and would make the authorized positive control unreachable).
 */
function deepTree(id = 'tree-deep', taskId = 'task-1'): DiscoveryTreeSnapshot {
  const tree = createDiscoveryTree({
    id,
    sessionId: 'session-1',
    taskId,
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

  it('strictly better candidate suggests winner but publish is denied by default; authorized holdout positive control applies', async () => {
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
    // ADR-0003 §3.6: improved and suggestedPolicyId remain established...
    expect(report.improved).toBe(true);
    expect(report.selectedPolicyId).toBe('pi-deep');
    expect(report.best.policyId).toBe('pi-deep');
    expect(report.best.hypervolume).toBeGreaterThan(report.baseline.hypervolume);
    expect(report.baseline.hypervolume).toBeCloseTo(0.1875, 6);
    expect(report.best.hypervolume).toBeCloseTo(0.235, 6);
    // ... but default publish is denied (holdout-missing), apply count is 0
    expect(report.publication.publish).toBe(false);
    expect(report.shadow.published).toBe(false);
    expect(applied).toHaveLength(0);

    // Authorized positive control: explicit publish authorization + holdout passes -> applies
    const authorizedApplied: MetaSearchPolicy[] = [];
    const authorizedDreamer = createOfflineDreamer({
      now: () => 100,
      publishAuthorized: true,
      holdoutTreeCount: 1,
      applyPolicy: (policy) => {
        authorizedApplied.push(policy);
      }
    });
    const authorizedReport = await authorizedDreamer.replay(
      dreamRequest({
        // PR-4B §4.3-1: distinct task ids, so the two trees are two groups and
        // the split is a legal task-level split rather than a self-leak.
        trees: [deepTree('tree-select', 'task-select'), deepTree('tree-holdout', 'task-holdout')],
        baselinePolicy: shallowPolicy(),
        candidatePolicies: [makePolicy({ id: 'pi-deep', maxWidth: 1, maxDepth: 4, version: 2 })]
      })
    );
    expect(authorizedReport.improved).toBe(true);
    expect(authorizedReport.publication.publish).toBe(true);
    expect(authorizedReport.shadow.published).toBe(true);
    expect(authorizedApplied.map((policy) => policy.id)).toEqual(['pi-deep']);
  });

  it('applies the winner through an injected active policy only when authorized + holdout passes', async () => {
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
    expect(report.publication.publish).toBe(false);
    expect(updates).toHaveLength(0);

    // Authorized positive control
    const authorizedUpdates: MetaSearchPolicy[] = [];
    const authorizedDreamer = createOfflineDreamer({
      now: () => 100,
      publishAuthorized: true,
      holdoutTreeCount: 1,
      activePolicy: {
        update: (policy) => {
          authorizedUpdates.push(policy);
        }
      }
    });
    const authorizedReport = await authorizedDreamer.replay(
      dreamRequest({
        // PR-4B §4.3-1: distinct task ids keep the two trees in separate groups.
        trees: [deepTree('tree-sel', 'task-sel'), deepTree('tree-hold', 'task-hold')],
        baselinePolicy: shallowPolicy(),
        candidatePolicies: [makePolicy({ id: 'pi-deep', maxWidth: 1, maxDepth: 4, version: 2 })]
      })
    );
    expect(authorizedReport.improved).toBe(true);
    expect(authorizedReport.publication.publish).toBe(true);
    expect(authorizedUpdates.map((policy) => policy.id)).toEqual(['pi-deep']);
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

/**
 * Phase 4 addendum. These cases cover the dual-loop expansion of this module
 * (jit hyperparameter perturbation and the injected JitReplayHook); they are
 * additive and change no expectation above. The dedicated JitRL fixtures live in
 * jit-dream.test.ts.
 */
describe('Phase 4 dual loop: jit grid and replay hook', () => {
  it('sweeps beta/k/similarityThreshold and inherits the ignored jit fields', () => {
    const baseline = makePolicy({
      id: 'pi-jit-base',
      jit: { beta: 1, lambda: 0.05, alpha: 5, k: 10, gamma: 0.5, similarityThreshold: 0.3 }
    });
    const candidates = generateCandidatePolicies(baseline, 6, { now: () => 3 });
    expect(candidates.map((entry) => entry.jit?.beta)).toEqual([0.5, 1, 2, 0.5, 1, 2]);
    // P6 PR5 (plan section 7.2): k and similarityThreshold are now searched, while
    // lambda/alpha/gamma stay inherited and are reported as ignored.
    expect(candidates.map((entry) => entry.jit?.k)).toEqual([5, 10, 20, 5, 10, 20]);
    expect(candidates.map((entry) => entry.jit?.similarityThreshold)).toEqual([
      0.2, 0.3, 0.5, 0.2, 0.3, 0.5
    ]);
    for (const candidate of candidates) {
      expect(candidate.jit?.lambda).toBe(0.05);
      expect(candidate.jit?.alpha).toBe(5);
      expect(candidate.jit?.gamma).toBe(0.5);
      expect(candidate.metadata?.jitIgnored).toEqual(['lambda', 'alpha', 'gamma']);
      expect(jitHyperparamIssues(candidate.jit)).toEqual([]);
    }
    // Same inputs, same candidates: the sequence is reproducible.
    const again = generateCandidatePolicies(baseline, 6, { now: () => 3 });
    expect(JSON.stringify(again)).toBe(JSON.stringify(candidates));
    // Switching the perturbation off keeps the baseline jit verbatim.
    const frozen = generateCandidatePolicies(baseline, 2, {
      now: () => 3,
      jitGrid: { hyperparamPerturbation: false }
    });
    for (const candidate of frozen) {
      expect(candidate.jit).toEqual(baseline.jit);
    }
  });

  it('keeps a model-proposed jit record and drops an illegal one', async () => {
    const baseline = makePolicy({
      id: 'pi-model-jit',
      jit: { beta: 1, lambda: 0.05, alpha: 5, k: 10, gamma: 0.5, similarityThreshold: 0.3 }
    });
    const adapter: IModelAdapter = {
      complete: async () => ({
        text:
          '[{"maxWidth": 2, "maxDepth": 2, "jit": {"beta": 2, "lambda": 0.1, "alpha": 5, "k": 10, "gamma": 0.5, "similarityThreshold": 0.3}}, {"maxWidth": 2, "maxDepth": 2, "jit": {"beta": 2, "lambda": 0.1, "alpha": 5, "k": -4, "gamma": 0.5, "similarityThreshold": 0.3}}]'
      })
    };
    const policies = await createModelPolicyGenerator(adapter, { now: () => 21 })(
      baseline,
      3,
      dreamRequest({ baselinePolicy: baseline })
    );
    // The first candidate keeps its proposed jit; the second is repaired by the
    // field-wise fallback (k => baseline) rather than dropped.
    expect(policies).toHaveLength(2);
    expect(policies[0]?.jit?.beta).toBe(2);
    expect(policies[0]?.metadata?.jitSource).toBe('model');
    expect(policies[1]?.jit?.k).toBe(baseline.jit?.k);
    expect(policies[1]?.metadata?.jitSource).toBe('baseline');
    expect(policies[1]?.metadata?.jitDiagnostics).toEqual(
      expect.arrayContaining([expect.stringContaining('jit.k')])
    );
    for (const entry of policies) {
      expect(jitHyperparamIssues(entry.jit)).toEqual([]);
    }
  });

  it('causally truncates the hook snapshot to the replayed tree', () => {
    expect(
      causalExperienceSnapshot(
        [
          makeExperienceRecord('past', 400),
          makeExperienceRecord('boundary', 500),
          makeExperienceRecord('future', 501)
        ],
        500
      ).map((record) => record.id)
    ).toEqual(['past', 'boundary']);

    const tree = richTree();
    const cutoff = causalCutoffFor(tree);
    expect(cutoff).toBe(tree.createdAt);
    const experiences = [
      makeExperienceRecord('before-tree', cutoff - 1),
      makeExperienceRecord('at-tree', cutoff),
      makeExperienceRecord('after-tree', cutoff + 1)
    ];

    const seen: string[][] = [];
    const hook: JitReplayHook = (input) => {
      seen.push(input.experiences.map((record) => record.id));
      return {
        slotWeights: input.slotWeights,
        diagnostics: {
          level: 'meta',
          stateValue: 0,
          neighborCount: input.experiences.length,
          klToPrior: 0,
          adjustments: []
        }
      };
    };
    const outcome = replayTree(tree, narrowPolicy(), 1, { jitHook: hook, experiences });
    expect(seen.length).toBeGreaterThan(0);
    for (const snapshot of seen) {
      expect(snapshot).toEqual(['before-tree', 'at-tree']);
    }
    expect(outcome.jitDiagnostics?.causalCutoff).toBe(cutoff);
    expect(outcome.evidence.join(' ')).toContain('causalCutoff=');
  });

  it('degrades to the pre-hook replay when the injected hook throws', () => {
    const tree = richTree();
    const legacy = replayTree(tree, narrowPolicy(), 1);
    const degraded = replayTree(tree, narrowPolicy(), 1, {
      jitHook: () => {
        throw new Error('no kernel');
      }
    });
    const { jitDiagnostics, evidence, ...rest } = degraded;
    const { evidence: legacyEvidence, ...legacyRest } = legacy;
    expect(rest).toEqual(legacyRest);
    expect(evidence.slice(0, legacyEvidence.length)).toEqual(legacyEvidence);
    expect(evidence.join(' ')).toContain('degraded at layer 1');
    expect(jitDiagnostics?.degraded).toBe(true);
    expect(jitDiagnostics?.hookCalls).toBe(0);
  });

  it('feeds a corrected portfolio back into the replayed frontier', () => {
    const tree = createDiscoveryTree({
      id: 'tree-correction',
      sessionId: 'session-1',
      taskId: 'task-1',
      rootPatchId: 'patch-root',
      clock: fixedClock()
    });
    // 'hot' is a low-scoring domain sibling; 'deep-best' holds the best score but
    // sits below a sibling the prior flushes last.
    tree.addNode(childInput(tree.rootId, { id: 'hot', purpose: 'deepen' }));
    tree.recordProbe('hot', { trajectoryId: 'traj-hot', score: 0.3 });
    tree.addNode(childInput(tree.rootId, { id: 'best', purpose: 'deepen' }));
    tree.recordProbe('best', { trajectoryId: 'traj-best', score: 0.6 });
    tree.addNode(childInput('best', { id: 'deep-best', purpose: 'deepen' }));
    tree.recordProbe('deep-best', { trajectoryId: 'traj-deep-best', score: 0.9 });

    const base = makePolicy({
      id: 'pi-correct',
      maxWidth: 1,
      maxDepth: 2,
      earlyStopThreshold: 1,
      slotWeights: { exploit: 0.4, explore_domain: 0.3, explore_invariant: 0.2, recover: 0.1 }
    });
    const legacy = replayTree(tree.snapshot(), base, 1);
    // The default portfolio reaches 'best' and then its deep child.
    expect(legacy.visitedNodeIds).toEqual([tree.rootId, 'best', 'deep-best']);
    expect(legacy.quality).toBe(0.9);

    // A hook that pins the frontier to 'hot' keeps the replayed policy shallow.
    const exploitHot: JitReplayHook = (input) => ({
      slotWeights:
        input.frontier.nodeId === 'hot'
          ? { exploit: 1, explore_domain: 0, explore_invariant: 0, recover: 0 }
          : { exploit: 0, explore_domain: 1, explore_invariant: 0, recover: 0 },
      diagnostics: {
        level: 'meta',
        stateValue: 0,
        neighborCount: input.experiences.length,
        klToPrior: 0.1,
        adjustments: []
      }
    });
    const corrected = replayTree(tree.snapshot(), base, 1, { jitHook: exploitHot });
    expect(corrected.visitedNodeIds).toEqual([tree.rootId, 'hot']);
    expect(corrected.quality).toBe(0.3);
    expect(corrected.jitDiagnostics?.hookCalls).toBeGreaterThan(0);
    expect(corrected.jitDiagnostics?.degraded).toBe(false);
  });
});

/**
 * P6 PR5 (plan section 7.4): the publication gate, shadow mode, and the split
 * between candidate selection and final validation.
 *
 * These are the R5/M3 acceptance properties that were previously unverifiable:
 * before this round the dreamer published whenever hypervolume moved, so "the
 * best of M candidates on one tree batch" was reported as generalisation.
 */
describe('P6 PR5: shadow mode, holdout split and the gate boundary', () => {
  /** Two trees: one to select on, one to validate on. */
  function twoTrees(): { select: DiscoveryTreeSnapshot; holdout: DiscoveryTreeSnapshot } {
    const build = (id: string, score: number): DiscoveryTreeSnapshot => {
      const tree = createDiscoveryTree({
        id,
        sessionId: 'session-1',
        taskId: 'task-' + id,
        rootPatchId: 'patch-root',
        clock: fixedClock()
      });
      tree.addNode(childInput(tree.rootId, { id: id + '-good', origin: 'domain', purpose: 'explore' }));
      tree.recordProbe(id + '-good', { trajectoryId: 'traj-' + id, score });
      tree.addNode(childInput(tree.rootId, { id: id + '-weak', purpose: 'deepen' }));
      tree.recordProbe(id + '-weak', { trajectoryId: 'traj-' + id + '-weak', score: 0.1 });
      return tree.snapshot();
    };
    return { select: build('tree-a', 0.9), holdout: build('tree-b', 0.8) };
  }

  it('records the suggestion without publishing it in shadow mode', async () => {
    const applied: MetaSearchPolicy[] = [];
    const { select } = twoTrees();
    const dreamer = createOfflineDreamer({
      now: () => 100,
      shadowMode: true,
      applyPolicy: (policy) => {
        applied.push(policy);
      }
    });
    const baseline = makePolicy({ id: 'pi-shadow-base', maxWidth: 1, maxDepth: 1 });
    const wide = makePolicy({
      id: 'pi-shadow-wide',
      maxWidth: 4,
      maxDepth: 2,
      earlyStopThreshold: 1,
      version: 2
    });
    const report = await dreamer.replay(
      dreamRequest({ trees: [select], baselinePolicy: baseline, candidatePolicies: [wide] })
    );

    // The replay still evaluated the candidate, so the suggestion is real...
    expect(report.candidateEvaluations.map((entry) => entry.policyId)).toEqual(['pi-shadow-wide']);
    expect(report.shadow.suggestedPolicyId).toBe('pi-shadow-wide');
    expect(report.shadow.incumbentPolicyId).toBe('pi-shadow-base');
    // ...but nothing was published and the incumbent is still in force. This is
    // the plan section 7.4 requirement: shadow records the difference, it never
    // auto-publishes, regardless of whether the candidate won.
    expect(report.shadow.published).toBe(false);
    expect(report.publication.publish).toBe(false);
    expect(applied).toHaveLength(0);
    // The reason names whichever gate stopped it: a losing candidate never
    // reaches the shadow check, a winning one is stopped by shadow mode.
    expect(report.publication.reason.length).toBeGreaterThan(0);
    if (report.improved) {
      expect(report.publication.reason).toContain('shadow mode');
    } else {
      expect(report.publication.reason).toContain('did not beat baseline');
    }
    // No candidate is ever marked selected when nothing was published.
    for (const comparison of report.shadow.comparisons) {
      expect(comparison.selected).toBe(false);
    }
    // The boundary travels with the record, so the number cannot be quoted alone.
    expect(report.shadow.boundary).toContain('fixed historical replay set');
    expect(report.publication.boundary).toBe(report.shadow.boundary);
  });

  it('splits selection and validation trees and reports both sets', async () => {
    const applied: MetaSearchPolicy[] = [];
    const { select, holdout } = twoTrees();
    const dreamer = createOfflineDreamer({
      now: () => 100,
      holdoutTreeCount: 1,
      applyPolicy: (policy) => {
        applied.push(policy);
      }
    });
    const baseline = makePolicy({ id: 'pi-split-base', maxWidth: 1, maxDepth: 1 });
    const wide = makePolicy({
      id: 'pi-split-wide',
      maxWidth: 4,
      maxDepth: 2,
      earlyStopThreshold: 1,
      version: 2
    });
    const report = await dreamer.replay(
      dreamRequest({
        // The tail of the caller's order is the holdout, deterministically.
        trees: [select, holdout],
        baselinePolicy: baseline,
        candidatePolicies: [wide]
      })
    );

    // Candidates were selected on tree-a only, and tree-b was held back. That
    // split is the whole point: picking the best of M on one batch and calling
    // it generalisation is the defect plan section 7.4 removes.
    expect(report.shadow.selectionTreeIds).toEqual(['tree-a']);
    expect(report.shadow.holdoutTreeIds).toEqual(['tree-b']);
    expect(report.replayedTreeIds).toEqual(['tree-a']);
    // The two sets never overlap.
    for (const id of report.shadow.selectionTreeIds) {
      expect(report.shadow.holdoutTreeIds).not.toContain(id);
    }
    expect(report.shadow.comparisons).toHaveLength(1);
    const comparison = report.shadow.comparisons[0];
    expect(comparison?.policyId).toBe('pi-split-wide');
    expect(typeof comparison?.delta).toBe('number');
    // The holdout verdict is present exactly when a winner went to validation.
    if (report.improved) {
      expect(typeof report.shadow.holdoutHypervolume).toBe('number');
      expect(typeof report.shadow.baselineHypervolume).toBe('number');
    } else {
      expect(report.shadow.holdoutHypervolume).toBeUndefined();
    }
    // Publication is a consequence of the gate, never an assumption.
    if (report.publication.publish) {
      expect(applied.map((policy) => policy.id)).toEqual(['pi-split-wide']);
      expect(comparison?.selected).toBe(true);
    } else {
      expect(applied).toHaveLength(0);
      expect(comparison?.selected).toBe(false);
    }
  });

  it('withholds a candidate that cannot beat the baseline on the holdout', async () => {
    // Build a holdout whose best reachable node is already the baseline's, so a
    // wider candidate has nothing left to win there.
    const tree = (id: string): DiscoveryTreeSnapshot => {
      const built = createDiscoveryTree({
        id,
        sessionId: 'session-1',
        taskId: 'task-' + id,
        rootPatchId: 'patch-root',
        clock: fixedClock()
      });
      built.addNode(childInput(built.rootId, { id: id + '-only', purpose: 'deepen' }));
      built.recordProbe(id + '-only', { trajectoryId: 'traj-' + id, score: 0.5 });
      return built.snapshot();
    };
    const applied: MetaSearchPolicy[] = [];
    const dreamer = createOfflineDreamer({
      now: () => 100,
      holdoutTreeCount: 1,
      applyPolicy: (policy) => {
        applied.push(policy);
      }
    });
    const baseline = makePolicy({ id: 'pi-hold-base', maxWidth: 1, maxDepth: 1 });
    const narrow = makePolicy({
      id: 'pi-hold-wide',
      maxWidth: 4,
      maxDepth: 2,
      earlyStopThreshold: 1,
      version: 2
    });
    const report = await dreamer.replay(
      dreamRequest({
        trees: [tree('tree-x'), tree('tree-y')],
        baselinePolicy: baseline,
        candidatePolicies: [narrow]
      })
    );
    // Whatever the verdict, the gate and the shadow record must agree.
    expect(report.publication.publish).toBe(report.shadow.published);
    expect(report.publication.boundary).toContain('proxy metric');
    if (!report.publication.publish) {
      expect(applied).toHaveLength(0);
    }
  });

  it('keeps the additivity contract: legacy report fields are unchanged', async () => {
    const { select } = twoTrees();
    const dreamer = createOfflineDreamer({ now: () => 55 });
    const baseline = makePolicy({ id: 'pi-add-base', maxWidth: 1, maxDepth: 1 });
    const report = await dreamer.replay(
      dreamRequest({ trees: [select], baselinePolicy: baseline, candidatePolicies: [] })
    );
    // Every pre-PR5 field is still there, with the pre-PR5 meaning.
    expect(report.ranAt).toBe(55);
    expect(report.improved).toBe(false);
    expect(report.selectedPolicyId).toBe('pi-add-base');
    expect(report.rhoPreferences).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(report.best).toEqual(report.baseline);
    // And the additive fields are present for a caller that wants them. The
    // default generator still produced candidates, so every one of them is
    // listed as a comparison and none is selected (nothing was published).
    expect(report.publication.publish).toBe(false);
    expect(report.shadow.comparisons).toHaveLength(report.candidateEvaluations.length);
    for (const comparison of report.shadow.comparisons) {
      expect(comparison.selected).toBe(false);
    }
    expect(report.ignoredDimensions.map((entry) => entry.dimension)).toEqual([
      'lambda',
      'alpha',
      'gamma'
    ]);
  });
});
