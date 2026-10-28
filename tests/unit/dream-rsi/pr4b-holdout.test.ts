/**
 * PR-4B (ADR 0004 §4): Dreamer independent holdout validation.
 *
 * Covers the four properties the PR is accountable for:
 *   1. `holdoutTreeCount` is an EXPLICIT opt-in that is threaded through every
 *      door (plain dreamer, Jit-wired dreamer, orchestrator/idle maintenance
 *      entry) and never grants a permission;
 *   2. the split happens BEFORE generation, so the generator and the Jit replay
 *      hook cannot see the held-out trees;
 *   3. group and temporal isolation are enforced, not assumed;
 *   4. an unusable pool is an `insufficient-evidence` verdict that keeps refusing
 *      publication;
 *   5. the configured `holdoutTreeCount` is a FLOOR, not a hint: a pool that
 *      cannot supply it fails closed as `insufficient-holdout-trees` instead of
 *      silently validating on whatever smaller holdout the pool happens to offer.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  MIN_HOLDOUT_GROUPS,
  MIN_HOLDOUT_TREES,
  RECOMMENDED_MIN_SELECTION_TREES,
  createOfflineDreamer,
  holdoutGroupKey,
  splitDreamerHoldout,
  type DreamReplayReportWithShadow
} from '../../../src/dream-rsi';
import { createJitWiredDreamer } from '../../../src/index';
import { createDiscoveryTree } from '../../../src/dream-rsi/discovery-tree';
import { createDefaultPolicy } from '../../../src/dream-rsi/active-policy';
import { parseEvoHarnessConfig, validateEvoHarnessConfig } from '../../../src/config';
import { resolveExecutionProfile } from '../../../src/runtime/execution-profile';
import { createJitRl } from '../../../src/jitrl';
import { childInput, fixedClock, makePolicy } from './fixtures';
import type {
  DiscoveryTreeSnapshot,
  MetaSearchPolicy,
  OfflineDreamRequest
} from '../../../src/types/contracts';

/**
 * A tree with four shallow siblings plus a deeper branch holding the best
 * recorded outcome: a wide-shallow policy and a narrow-deep one score differently,
 * which is what makes a candidate strictly improve.
 *
 * PR-4B §4.3-1: `taskId` is a parameter. Two trees of ONE task are one group and
 * the split refuses to cut a group, so a selection/holdout pair MUST be two tasks.
 *
 * `createdAt` defaults to a monotonically increasing stamp per call, so a tree
 * created later in a test is genuinely newer. The split orders groups by the tree
 * snapshot's own stamp, so a shared fixed clock would make every group tie and
 * turn the ordering assertions into accidents. Tests that assert the temporal
 * rule pass explicit stamps.
 */
let stampSeed = 1_700_000_000_000;
function nextStamp(): number {
  stampSeed += 1_000;
  return stampSeed;
}

function deepTree(id: string, taskId: string, createdAt = nextStamp()): DiscoveryTreeSnapshot {
  const tree = createDiscoveryTree({
    id,
    sessionId: 'sess-' + id,
    taskId,
    rootPatchId: 'root-' + id,
    createdAt,
    clock: fixedClock(createdAt)
  });
  tree.addNode(childInput(tree.rootId, { id: id + '-s1', origin: 'domain', purpose: 'explore' }));
  tree.recordProbe(id + '-s1', { trajectoryId: 'traj-' + id + '-s1', score: 0.1 });
  tree.addNode(childInput(tree.rootId, { id: id + '-s2', origin: 'domain', purpose: 'explore' }));
  tree.recordProbe(id + '-s2', { trajectoryId: 'traj-' + id + '-s2', score: 0.3 });
  tree.addNode(childInput(tree.rootId, { id: id + '-s3', origin: 'domain', purpose: 'explore' }));
  tree.recordProbe(id + '-s3', { trajectoryId: 'traj-' + id + '-s3', score: 0.2 });
  tree.addNode(childInput(tree.rootId, { id: id + '-s4', origin: 'domain', purpose: 'explore' }));
  tree.recordProbe(id + '-s4', { trajectoryId: 'traj-' + id + '-s4', score: 0.15 });
  tree.addNode(childInput(id + '-s2', { id: id + '-d1', purpose: 'deepen' }));
  tree.recordProbe(id + '-d1', { trajectoryId: 'traj-' + id + '-d1', score: 0.35 });
  tree.addNode(childInput(id + '-d1', { id: id + '-d2', purpose: 'deepen' }));
  tree.recordProbe(id + '-d2', { trajectoryId: 'traj-' + id + '-d2', score: 0.4 });
  tree.addNode(childInput(id + '-d2', { id: id + '-d3', purpose: 'deepen' }));
  tree.recordProbe(id + '-d3', { trajectoryId: 'traj-' + id + '-d3', score: 0.55 });
  return tree.snapshot();
}

/** A shallow single-node tree: far fewer probes than `deepTree`. */
function shallowTree(id: string, taskId: string, createdAt = nextStamp()): DiscoveryTreeSnapshot {
  const tree = createDiscoveryTree({
    id,
    sessionId: 'sess-' + id,
    taskId,
    rootPatchId: 'root-' + id,
    createdAt,
    clock: fixedClock(createdAt)
  });
  tree.addNode(childInput(tree.rootId, { id: id + '-only', purpose: 'deepen' }));
  tree.recordProbe(id + '-only', { trajectoryId: 'traj-' + id + '-only', score: 0.5 });
  return tree.snapshot();
}

function baselinePolicy(id = 'pi-base'): MetaSearchPolicy {
  return makePolicy({ id, maxWidth: 4, maxDepth: 1 });
}

function deepCandidate(id = 'pi-deep'): MetaSearchPolicy {
  return makePolicy({ id, maxWidth: 1, maxDepth: 4, version: 2 });
}

function request(trees: readonly DiscoveryTreeSnapshot[]): OfflineDreamRequest {
  return { trees, baselinePolicy: baselinePolicy(), candidatePolicies: [deepCandidate()] };
}

describe('PR-4B config: holdoutTreeCount is an explicit, strictly validated opt-in', () => {
  it('defaults to 0 so the default assembly keeps the pre-PR-4B path', () => {
    const config = parseEvoHarnessConfig({});
    expect(config.dreamRsi.holdoutTreeCount).toBe(0);
    // The opt-in cannot be derived from any other default: a deploy that says
    // nothing gets no split, hence holdout-missing, hence no publication.
    expect(config.dreamRsi.holdoutTreeCount).toBe(0);
  });

  it('accepts an explicit positive integer', () => {
    const config = parseEvoHarnessConfig({ dreamRsi: { holdoutTreeCount: 3 } });
    expect(config.dreamRsi.holdoutTreeCount).toBe(3);
  });

  it('rejects a holdout that would consume the whole pool', () => {
    // Cross-field: the split must always leave selection material, so a
    // configuration can never describe a split its own pool bound cannot satisfy.
    const result = validateEvoHarnessConfig({
      dreamRsi: { maxTreePoolSize: 5, holdoutTreeCount: 5 }
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'dreamRsi.holdoutTreeCount', code: 'invalid_value' })
      ])
    );
  });

  it('rejects a negative, fractional or non-numeric holdout', () => {
    for (const bad of [-1, 1.5, '3', Number.NaN]) {
      const result = validateEvoHarnessConfig({
        dreamRsi: { holdoutTreeCount: bad as never }
      });
      expect(result.ok).toBe(false);
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'dreamRsi.holdoutTreeCount' })
        ])
      );
    }
  });

  it('is a declared key, not smuggled past the unknown-key guard', () => {
    const result = validateEvoHarnessConfig({ dreamRsi: { holdoutTreeCounts: 1 } });
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'dreamRsi.holdoutTreeCounts', code: 'unknown_key' })
      ])
    );
  });

  it('does not widen any permission: publish/patch/memory stay denied', () => {
    // The holdout is a VALIDATION-SET widening. It must not touch the permission
    // surface, or `holdoutTreeCount` would become a publish switch by the back door.
    const config = parseEvoHarnessConfig({ dreamRsi: { holdoutTreeCount: 3 } });
    const profile = resolveExecutionProfile({ mode: config.execution.mode });
    expect(profile.permissions.publish.allowed).toBe(false);
    expect(profile.permissions.patch.allowed).toBe(false);
    expect(profile.permissions.memory.allowed).toBe(false);
  });
});

describe('PR-4B split primitive: group and temporal isolation', () => {
  it('keeps one task wholly on one side of the split', () => {
    // Caller order is [newest B, older A, older-still A]. A naive "last N by
    // caller order" split would take only a2 and leave a1 behind, cutting task A
    // in half. Grouping must instead move all of A together, and the timestamps
    // here permit exactly that (A spans 1000..2000, all of it older than B@3000).
    const pool = [
      shallowTree('b-1', 'task-B', 3_000),
      shallowTree('a-1', 'task-A', 1_000),
      shallowTree('a-2', 'task-A', 2_000)
    ];
    const split = splitDreamerHoldout(pool, 1);
    expect(split.status).toBe('ok');
    // The whole A group stayed in selection; the newest task became the holdout.
    expect(split.selectionTrees.map((tree) => tree.id).sort()).toEqual(['a-1', 'a-2']);
    expect(split.holdoutTrees.map((tree) => tree.id)).toEqual(['b-1']);
    const holdoutGroups = new Set(split.holdoutTrees.map(holdoutGroupKey));
    const selectionGroups = new Set(split.selectionTrees.map(holdoutGroupKey));
    for (const group of holdoutGroups) {
      expect(selectionGroups.has(group)).toBe(false);
    }
    expect(split.diagnostics.selectionGroups).toBe(1);
    expect(split.diagnostics.holdoutGroups).toBe(1);
  });

  it('never puts a newer tree in selection than in the holdout', () => {
    const pool = [
      deepTree('old-1', 'task-old-1'),
      deepTree('old-2', 'task-old-2'),
      deepTree('new-1', 'task-new-1')
    ];
    const split = splitDreamerHoldout(pool, 1);
    expect(split.status).toBe('ok');
    const selectionNewest = Math.max(...split.selectionTrees.map((tree) => tree.createdAt));
    const holdoutOldest = Math.min(...split.holdoutTrees.map((tree) => tree.createdAt));
    expect(selectionNewest).toBeLessThanOrEqual(holdoutOldest);
  });

  it('fails closed when a task window straddles every possible cut', () => {
    // The group window is the span of its trees' SNAPSHOT stamps. Task A owns a
    // very old tree and a very new one; task B sits between them. Whichever side
    // A lands on, a future tree would end up in the selection set - so no cut is
    // admissible and the split must refuse rather than train on the future.
    const straddled = [
      shallowTree('a-old', 'task-A', 1_000),
      shallowTree('a-new', 'task-A', 9_000),
      shallowTree('b-mid', 'task-B', 5_000)
    ];
    const split = splitDreamerHoldout(straddled, 1);
    expect(split.status).toBe('insufficient-temporal-isolation');
    expect(split.hasSufficientEvidence).toBe(false);
    expect(split.holdoutTrees).toHaveLength(0);
  });

  it('reports a group shortfall when the pool is one task', () => {
    const pool = [deepTree('x1', 'task-only'), shallowTree('x2', 'task-only')];
    const split = splitDreamerHoldout(pool, 1);
    expect(split.status).toBe('insufficient-holdout-groups');
    expect(split.hasSufficientEvidence).toBe(false);
  });

  it('reports no-holdout-configured for a zero request without failing', () => {
    const split = splitDreamerHoldout([deepTree('y1', 'task-y1'), deepTree('y2', 'task-y2')], 0);
    expect(split.status).toBe('no-holdout-configured');
    expect(split.selectionTrees).toHaveLength(2);
    expect(split.holdoutTrees).toHaveLength(0);
  });

  it('is deterministic and independent of the caller order', () => {
    const pool = [
      deepTree('d1', 'task-d1'),
      deepTree('d2', 'task-d2'),
      deepTree('d3', 'task-d3')
    ];
    const forward = splitDreamerHoldout(pool, 1);
    const reversed = splitDreamerHoldout([...pool].reverse(), 1);
    expect(forward.selectionTrees.map((tree) => tree.id).sort()).toEqual(
      reversed.selectionTrees.map((tree) => tree.id).sort()
    );
    expect(forward.holdoutTrees.map((tree) => tree.id)).toEqual(
      reversed.holdoutTrees.map((tree) => tree.id)
    );
  });

  it('exposes the ADR thresholds as declared constants', () => {
    expect(MIN_HOLDOUT_TREES).toBe(1);
    expect(MIN_HOLDOUT_GROUPS).toBe(1);
    expect(RECOMMENDED_MIN_SELECTION_TREES).toBe(2);
  });
});

describe('PR-4B plain dreamer: pre-generation split and refusal to publish', () => {
  it('generates candidates from the selection set only (holdout never reaches the generator)', async () => {
    const seenPools: string[][] = [];
    const generator = vi.fn(
      (baseline: MetaSearchPolicy, count: number, req: OfflineDreamRequest) => {
        seenPools.push(req.trees.map((tree) => tree.id));
        return [deepCandidate()];
      }
    );
    const dreamer = createOfflineDreamer({
      now: () => 100,
      holdoutTreeCount: 1,
      generatePolicies: generator,
      policyCount: 1
    });
    const selection = [deepTree('sel-1', 'task-sel-1'), deepTree('sel-2', 'task-sel-2')];
    const holdout = [shallowTree('held-1', 'task-held-1')];
    // candidatePolicies: [] so the dreamer MUST call the generator - that is the
    // only way to observe what pool the generator was handed.
    const report = await dreamer.replay({
      trees: [...selection, ...holdout],
      baselinePolicy: baselinePolicy(),
      candidatePolicies: []
    });

    expect(generator).toHaveBeenCalledTimes(1);
    // The generator's request pool must be exactly the selection set: no holdout
    // id may appear.
    expect(seenPools[0]).not.toContain('held-1');
    expect(seenPools[0]?.length).toBe(report.shadow.selectionTreeIds.length);
    // The split is reported, and the two sides are disjoint.
    expect(report.shadow.split.status).toBe('ok');
    expect(report.shadow.split.hasSufficientEvidence).toBe(true);
    expect(report.shadow.holdoutTreeIds).toEqual(['held-1']);
    for (const id of report.shadow.holdoutTreeIds) {
      expect(report.shadow.selectionTreeIds).not.toContain(id);
    }
  });

  it('refuses publication by default even with a healthy split', async () => {
    const applied: MetaSearchPolicy[] = [];
    const dreamer = createOfflineDreamer({
      now: () => 100,
      holdoutTreeCount: 1,
      applyPolicy: (policy) => {
        applied.push(policy);
      }
    });
    const report = await dreamer.replay(
      request([
        deepTree('p1', 'task-p1'),
        deepTree('p2', 'task-p2'),
        shallowTree('p3', 'task-p3')
      ])
    );
    expect(report.improved).toBe(true);
    expect(report.publication.publish).toBe(false);
    expect(report.shadow.published).toBe(false);
    expect(applied).toHaveLength(0);
    // The holdout WAS satisfied, so the refusal is the honest one: the winner did
    // not beat the baseline on the held-out trees (G3's held-out-underperformed
    // shelf), not a missing-holdout artefact.
    expect(report.shadow.split.status).toBe('ok');
    expect(report.shadow.holdoutHypervolume).toBeDefined();
    expect(report.publication.reason).toContain('held-out trees');
  });

  it('applies only when explicitly authorized AND the holdout passes', async () => {
    const applied: MetaSearchPolicy[] = [];
    const dreamer = createOfflineDreamer({
      now: () => 100,
      holdoutTreeCount: 1,
      publishAuthorized: true,
      applyPolicy: (policy) => {
        applied.push(policy);
      }
    });
    const report = await dreamer.replay(
      request([deepTree('q1', 'task-q1'), deepTree('q2', 'task-q2')])
    );
    expect(report.improved).toBe(true);
    expect(report.shadow.split.status).toBe('ok');
    expect(report.publication.publish).toBe(true);
    expect(applied.map((policy) => policy.id)).toEqual(['pi-deep']);
  });

  it('keeps refusing publication when the pool cannot supply a holdout', async () => {
    // Authorization is present, the candidate improves, but the pool is ONE task:
    // the split is unusable, so no holdout validation happened and G3 must refuse.
    const applied: MetaSearchPolicy[] = [];
    const dreamer = createOfflineDreamer({
      now: () => 100,
      holdoutTreeCount: 1,
      publishAuthorized: true,
      applyPolicy: (policy) => {
        applied.push(policy);
      }
    });
    const report = await dreamer.replay(
      request([deepTree('r1', 'task-same'), deepTree('r2', 'task-same')])
    );
    expect(report.improved).toBe(true);
    expect(report.shadow.split.status).toBe('insufficient-holdout-groups');
    expect(report.shadow.split.hasSufficientEvidence).toBe(false);
    expect(report.publication.publish).toBe(false);
    expect(report.shadow.published).toBe(false);
    expect(applied).toHaveLength(0);
    expect(report.publication.reason).toContain('holdout-missing');
    // Nothing is attributed to the holdout, so the record cannot be misread as
    // "validated and lost".
    expect(report.shadow.holdoutHypervolume).toBeUndefined();
    expect(report.shadow.holdoutTreeIds).toHaveLength(0);
  });

  it('does not let holdout probe counts move the selection numbers', async () => {
    // Information-visibility (ADR 0004 §4.1-2): the cost ceiling that normalizes
    // the SELECTION scores must derive from selection runs only. Swapping the
    // holdout for a tree that needs many more probes must leave the selection
    // evaluation untouched - otherwise a holdout statistic reaches selection.
    //
    // Explicit ascending stamps pin the split identically in both runs: the only
    // variable is how many probes the HELD-OUT tree needs.
    const selection = [
      deepTree('m1', 'task-m1', 1_000),
      deepTree('m2', 'task-m2', 2_000)
    ];

    const cheapHoldout = [shallowTree('cheap-h', 'task-cheap-h', 9_000)];
    const expensiveHoldout = [deepTree('exp-h', 'task-exp-h', 9_000)];

    const cheapReport = await createOfflineDreamer({
      now: () => 100,
      holdoutTreeCount: 1,
      publishAuthorized: true
    }).replay(request([...selection, ...cheapHoldout]));

    const expensiveReport = await createOfflineDreamer({
      now: () => 100,
      holdoutTreeCount: 1,
      publishAuthorized: true
    }).replay(request([...selection, ...expensiveHoldout]));

    // Same split on both sides...
    expect(cheapReport.shadow.selectionTreeIds).toEqual(['m1', 'm2']);
    expect(expensiveReport.shadow.selectionTreeIds).toEqual(['m1', 'm2']);
    expect(cheapReport.shadow.holdoutTreeIds).toEqual(['cheap-h']);
    expect(expensiveReport.shadow.holdoutTreeIds).toEqual(['exp-h']);
    // ...and identical selection numbers despite a 7x bigger holdout.
    expect(cheapReport.baseline).toEqual(expensiveReport.baseline);
    expect(cheapReport.candidateEvaluations).toEqual(expensiveReport.candidateEvaluations);
    expect(cheapReport.best).toEqual(expensiveReport.best);
    expect(cheapReport.improved).toBe(expensiveReport.improved);
  });
});

describe('PR-4B request floor: a short holdout fails closed instead of shrinking', () => {
  // The review finding behind this repair: `splitDreamerHoldout(pool, 5)` on a
  // 4-tree pool whose newest group owns 3 trees returned `status: 'ok'`,
  // `hasSufficientEvidence: true`, `holdoutCount: 3`. That is a 40% shrink of the
  // validation set, performed silently, which the dreamer would then have treated
  // as evidence. `holdoutTreeCount` is an explicit opt-in; a request the pool
  // cannot meet is a fail-closed verdict, never a smaller holdout.

  it('refuses a 5-tree request when the newest group only offers 3', () => {
    const pool = [
      deepTree('floor-a1', 'task-floor-A', 1_000),
      deepTree('floor-b1', 'task-floor-B', 2_000),
      deepTree('floor-b2', 'task-floor-B', 3_000),
      deepTree('floor-b3', 'task-floor-B', 4_000)
    ];
    const split = splitDreamerHoldout(pool, 5);
    // The shelf is the existing sample-size failure: the pool could not supply the
    // configured count. Not 'ok', and the boolean states the same thing.
    expect(split.status).toBe('insufficient-holdout-trees');
    expect(split.hasSufficientEvidence).toBe(false);
    // Nothing is reserved: a withheld set may never be mistaken for a usable one.
    expect(split.holdoutTrees).toHaveLength(0);
    // The refusal is auditable: supply, request and gap are all on the record.
    expect(split.diagnostics.totalTrees).toBe(4);
    expect(split.diagnostics.requestedHoldoutCount).toBe(5);
    expect(split.diagnostics.holdoutCount).toBe(3);
    expect(split.diagnostics.holdoutShortfall).toBe(2);
    // The selection set is the head that was never reserved; the 3 withheld trees
    // stay out of it (group isolation is untouched by the refusal).
    expect(split.selectionTrees.map((tree) => tree.id)).toEqual(['floor-a1']);
    expect(split.diagnostics.selectionCount).toBe(1);
    expect(split.diagnostics.selectionGroups).toBe(1);
    expect(split.diagnostics.holdoutGroups).toBe(1);
  });

  it('accepts a request the pool can meet exactly', () => {
    const pool = [
      deepTree('exact-a1', 'task-exact-A', 1_000),
      deepTree('exact-a2', 'task-exact-A', 2_000),
      deepTree('exact-b1', 'task-exact-B', 3_000),
      deepTree('exact-b2', 'task-exact-B', 4_000)
    ];
    const split = splitDreamerHoldout(pool, 2);
    expect(split.status).toBe('ok');
    expect(split.hasSufficientEvidence).toBe(true);
    expect(split.holdoutTrees.map((tree) => tree.id)).toEqual(['exact-b1', 'exact-b2']);
    expect(split.selectionTrees.map((tree) => tree.id)).toEqual(['exact-a1', 'exact-a2']);
    expect(split.diagnostics.holdoutCount).toBe(2);
    expect(split.diagnostics.holdoutShortfall).toBe(0);
  });

  it('treats the request as a floor: a bigger newest group is not a shrink', () => {
    const pool = [
      deepTree('over-a1', 'task-over-A', 1_000),
      deepTree('over-b1', 'task-over-B', 2_000),
      deepTree('over-b2', 'task-over-B', 3_000)
    ];
    const split = splitDreamerHoldout(pool, 1);
    expect(split.status).toBe('ok');
    // Whole groups move together, so the newest group contributes both trees.
    // Overshoot still satisfies the request; only undershoot is refused.
    expect(split.holdoutTrees).toHaveLength(2);
    expect(split.diagnostics.holdoutCount).toBeGreaterThanOrEqual(1);
    expect(split.diagnostics.holdoutShortfall).toBe(0);
  });

  it('refuses a request larger than the pool can divide at all', () => {
    const pool = [
      deepTree('small-a1', 'task-small-A', 1_000),
      deepTree('small-b1', 'task-small-B', 2_000)
    ];
    const split = splitDreamerHoldout(pool, 3);
    expect(split.status).toBe('insufficient-holdout-trees');
    expect(split.hasSufficientEvidence).toBe(false);
    expect(split.holdoutTrees).toHaveLength(0);
    expect(split.diagnostics.holdoutCount).toBe(1);
    expect(split.diagnostics.requestedHoldoutCount).toBe(3);
    expect(split.diagnostics.holdoutShortfall).toBe(2);
  });

  it('never reports ok with fewer holdout trees than requested (sweep)', () => {
    // One pool, every plausible request: the invariant is `ok` <=> the cut really
    // supplied at least `requested`. Stated independently of any single fixture.
    const pool = [
      deepTree('sweep-a1', 'task-sweep-A', 1_000),
      deepTree('sweep-b1', 'task-sweep-B', 2_000),
      deepTree('sweep-b2', 'task-sweep-B', 3_000),
      deepTree('sweep-b3', 'task-sweep-B', 4_000)
    ];
    for (let requested = 1; requested <= 6; requested += 1) {
      const split = splitDreamerHoldout(pool, requested);
      expect(split.diagnostics.requestedHoldoutCount).toBe(requested);
      if (split.status === 'ok') {
        expect(split.hasSufficientEvidence).toBe(true);
        expect(split.holdoutTrees.length).toBeGreaterThanOrEqual(requested);
        expect(split.diagnostics.holdoutShortfall).toBe(0);
      } else {
        // 'insufficient-holdout-trees' is the only admissible refusal here: the
        // pool has two groups and an admissible cut, it is simply too small.
        expect(split.status).toBe('insufficient-holdout-trees');
        expect(split.hasSufficientEvidence).toBe(false);
        expect(split.holdoutTrees).toHaveLength(0);
        expect(split.diagnostics.holdoutShortfall).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the zero request exactly on the pre-PR-4B path', () => {
    // No holdout configured: the whole pool is the selection set, nothing is
    // reserved and nothing is "short". This guards the repair against turning the
    // default 0 into a fail-closed dream.
    const pool = [
      deepTree('zero-a1', 'task-zero-A', 1_000),
      deepTree('zero-b1', 'task-zero-B', 2_000)
    ];
    const split = splitDreamerHoldout(pool, 0);
    expect(split.status).toBe('no-holdout-configured');
    expect(split.hasSufficientEvidence).toBe(false);
    expect(split.selectionTrees.map((tree) => tree.id)).toEqual(['zero-a1', 'zero-b1']);
    expect(split.holdoutTrees).toHaveLength(0);
    expect(split.diagnostics.requestedHoldoutCount).toBe(0);
    expect(split.diagnostics.holdoutShortfall).toBe(0);
  });

  it('keeps the withheld tail out of the generator when the request cannot be met', async () => {
    // Fail-closed must not become "the tail was reserved, so hand it to the
    // generator anyway". The generator sees the selection head only.
    const seenPools: string[][] = [];
    const dreamer = createOfflineDreamer({
      now: () => 100,
      holdoutTreeCount: 5,
      generatePolicies: (baseline, count, req) => {
        seenPools.push(req.trees.map((tree) => tree.id));
        return [deepCandidate()];
      },
      policyCount: 1
    });
    await dreamer.replay({
      trees: [
        deepTree('gen-a1', 'task-gen-A', 1_000),
        deepTree('gen-a2', 'task-gen-A', 2_000),
        deepTree('gen-b1', 'task-gen-B', 3_000),
        deepTree('gen-b2', 'task-gen-B', 4_000),
        deepTree('gen-b3', 'task-gen-B', 5_000)
      ],
      baselinePolicy: baselinePolicy(),
      candidatePolicies: []
    });
    expect(seenPools).toHaveLength(1);
    expect(seenPools[0]).toEqual(['gen-a1', 'gen-a2']);
    for (const id of ['gen-b1', 'gen-b2', 'gen-b3']) {
      expect(seenPools[0]).not.toContain(id);
    }
  });

  it('refuses publication when the pool cannot supply the requested holdout', async () => {
    // The review scenario at the gate: authorized, and the candidate strictly wins
    // on the selection trees. The ONLY reason publication is withheld is that the
    // holdout the operator configured does not exist (3 of 5 supplied).
    const applied: MetaSearchPolicy[] = [];
    const dreamer = createOfflineDreamer({
      now: () => 100,
      holdoutTreeCount: 5,
      publishAuthorized: true,
      applyPolicy: (policy) => {
        applied.push(policy);
      }
    });
    const report = await dreamer.replay(
      request([
        deepTree('gate-a1', 'task-gate-A', 1_000),
        deepTree('gate-a2', 'task-gate-A', 2_000),
        deepTree('gate-b1', 'task-gate-B', 3_000),
        deepTree('gate-b2', 'task-gate-B', 4_000),
        deepTree('gate-b3', 'task-gate-B', 5_000)
      ])
    );
    // The selection replay still runs (and still improves): this is NOT the
    // "holdout failed" shelf, it is "the configured holdout was never constituted".
    expect(report.improved).toBe(true);
    const split = report.shadow.split;
    expect(split.status).toBe('insufficient-holdout-trees');
    expect(split.hasSufficientEvidence).toBe(false);
    expect(split.diagnostics.requestedHoldoutCount).toBe(5);
    expect(split.diagnostics.holdoutCount).toBe(3);
    expect(split.diagnostics.holdoutShortfall).toBe(2);
    // The head (2 trees) is what was replayed; the withheld tail is not attributed.
    expect(report.shadow.selectionTreeIds).toEqual(['gate-a1', 'gate-a2']);
    expect(report.shadow.holdoutTreeIds).toHaveLength(0);
    // validatedOnHoldout is never set, so G3 reports the missing-holdout shelf and
    // no candidate is applied even though publishing IS authorized.
    expect(report.shadow.holdoutHypervolume).toBeUndefined();
    expect(report.shadow.baselineHypervolume).toBeUndefined();
    expect(report.publication.publish).toBe(false);
    expect(report.publication.reason).toContain('holdout-missing');
    expect(report.shadow.published).toBe(false);
    expect(applied).toHaveLength(0);
  });

  it('keeps an unconfigured dreamer on holdout-missing even when authorized', async () => {
    // holdoutTreeCount omitted === 0: the pre-PR-4B path. Nothing is split, so
    // nothing is validated, so the gate still refuses.
    const applied: MetaSearchPolicy[] = [];
    const dreamer = createOfflineDreamer({
      now: () => 100,
      publishAuthorized: true,
      applyPolicy: (policy) => {
        applied.push(policy);
      }
    });
    const report = await dreamer.replay(
      request([deepTree('unset-1', 'task-unset-1'), deepTree('unset-2', 'task-unset-2')])
    );
    expect(report.improved).toBe(true);
    expect(report.shadow.split.status).toBe('no-holdout-configured');
    expect(report.shadow.split.hasSufficientEvidence).toBe(false);
    expect(report.shadow.split.diagnostics.requestedHoldoutCount).toBe(0);
    expect(report.shadow.split.diagnostics.holdoutShortfall).toBe(0);
    expect(report.shadow.holdoutTreeIds).toHaveLength(0);
    expect(report.shadow.holdoutHypervolume).toBeUndefined();
    expect(report.publication.publish).toBe(false);
    expect(report.publication.reason).toContain('holdout-missing');
    expect(applied).toHaveLength(0);
  });
});

describe('PR-4B Jit-wired dreamer: the same holdout contract', () => {
  function wired(options: {
    readonly holdoutTreeCount?: number;
    readonly publishAuthorized?: boolean;
    readonly hooks?: string[];
    readonly applied?: MetaSearchPolicy[];
  }) {
    const now = (): number => 1_700_000_000_000;
    const config = parseEvoHarnessConfig({
      jitrl: { enabled: true, levels: ['meta'] }
    });
    const kernel = createJitRl({ config, now });
    let incumbent = baselinePolicy();
    const holder = {
      get policy() {
        return incumbent;
      },
      update(policy: MetaSearchPolicy) {
        options.applied?.push(policy);
        incumbent = policy;
      }
    };
    const dreamer = createJitWiredDreamer({
      kernel,
      config,
      recorder: { hookAttached: true },
      isJitRuntimeEnabled: () => true,
      executionProfile: options.publishAuthorized === true
        ? {
            mode: 'shadow',
            permissions: {
              patch: { allowed: false, reason: '' },
              memory: { allowed: false, reason: '' },
              publish: { allowed: true, reason: 'test explicit authorization' }
            },
            shadowRecords: true,
            off: false
          }
        : resolveExecutionProfile({ mode: 'shadow' }),
      base: {
        now,
        activePolicy: holder,
        ...(options.holdoutTreeCount === undefined
          ? {}
          : { holdoutTreeCount: options.holdoutTreeCount }),
        ...(options.publishAuthorized === undefined
          ? {}
          : { publishAuthorized: options.publishAuthorized, shadowMode: false }),
        applyPolicy: (policy) => {
          options.applied?.push(policy);
          incumbent = policy;
        }
      }
    });
    return dreamer;
  }

  it('honours holdoutTreeCount through the Jit-wired path and refuses by default', async () => {
    const applied: MetaSearchPolicy[] = [];
    const dreamer = wired({ holdoutTreeCount: 1, applied });
    const report = await dreamer.replay(
      request([deepTree('w1', 'task-w1'), deepTree('w2', 'task-w2')])
    );
    expect(report.shadow.split.status).toBe('ok');
    expect(report.improved).toBe(true);
    expect(report.publication.publish).toBe(false);
    expect(report.shadow.published).toBe(false);
    expect(applied).toHaveLength(0);
  });

  it('publishes through the Jit-wired path only under explicit authorization + passed holdout', async () => {
    const applied: MetaSearchPolicy[] = [];
    const dreamer = wired({ holdoutTreeCount: 1, publishAuthorized: true, applied });
    const report = await dreamer.replay(
      request([deepTree('v1', 'task-v1'), deepTree('v2', 'task-v2')])
    );
    expect(report.shadow.split.status).toBe('ok');
    expect(report.publication.publish).toBe(true);
    expect(report.shadow.published).toBe(true);
    expect(applied.map((policy) => policy.id)).toEqual(['pi-deep']);
  });

  it('refuses on an unusable pool even when authorized and Jit-wired', async () => {
    const applied: MetaSearchPolicy[] = [];
    const dreamer = wired({ holdoutTreeCount: 1, publishAuthorized: true, applied });
    const report = await dreamer.replay(
      request([deepTree('u1', 'task-one'), deepTree('u2', 'task-one')])
    );
    expect(report.shadow.split.hasSufficientEvidence).toBe(false);
    expect(report.publication.publish).toBe(false);
    expect(applied).toHaveLength(0);
  });

  it('refuses an undersized holdout through the Jit-wired path', async () => {
    // The same request-floor defect through the Jit door: 5 requested, the newest
    // group holds 3. Authorized and Jit-wired, so only the holdout evidence (G3)
    // can withhold publication.
    const applied: MetaSearchPolicy[] = [];
    const dreamer = wired({ holdoutTreeCount: 5, publishAuthorized: true, applied });
    const report = await dreamer.replay(
      request([
        deepTree('jw-a1', 'task-jw-A', 1_000),
        deepTree('jw-a2', 'task-jw-A', 2_000),
        deepTree('jw-b1', 'task-jw-B', 3_000),
        deepTree('jw-b2', 'task-jw-B', 4_000),
        deepTree('jw-b3', 'task-jw-B', 5_000)
      ])
    );
    expect(report.improved).toBe(true);
    expect(report.shadow.split.status).toBe('insufficient-holdout-trees');
    expect(report.shadow.split.hasSufficientEvidence).toBe(false);
    expect(report.shadow.split.diagnostics.holdoutShortfall).toBe(2);
    expect(report.shadow.selectionTreeIds).toEqual(['jw-a1', 'jw-a2']);
    expect(report.shadow.holdoutTreeIds).toHaveLength(0);
    expect(report.shadow.holdoutHypervolume).toBeUndefined();
    expect(report.publication.publish).toBe(false);
    expect(report.publication.reason).toContain('holdout-missing');
    expect(report.shadow.published).toBe(false);
    expect(applied).toHaveLength(0);
  });

  it('keeps the Jit hook from seeing the holdout during selection', async () => {
    // The hook is called once per replayed policy per tree. If the split ran
    // AFTER generation/selection, the hook would have been driven over the whole
    // pool. Assert the replay never even visits a holdout tree for selection:
    // the selection ids reported are disjoint from the holdout ids, and the
    // replay id list is the selection set.
    const dreamer = wired({ holdoutTreeCount: 1 });
    const report = await dreamer.replay(
      request([deepTree('h1', 'task-h1'), deepTree('h2', 'task-h2'), deepTree('h3', 'task-h3')])
    );
    expect(report.shadow.split.status).toBe('ok');
    expect(report.replayedTreeIds).toEqual(report.shadow.selectionTreeIds);
    for (const id of report.replayedTreeIds) {
      expect(report.shadow.holdoutTreeIds).not.toContain(id);
    }
  });
});

describe('PR-4B maintenance (idle) entry: only through the orchestrator', () => {
  it('keeps no direct deps.dreamer.replay fallback in the plugin entrypoint', async () => {
    // Structural removal (captain ruling R3): the idle entrance must not be able
    // to bypass dreamReports()/recordDream()/the publication gate chain. Read the
    // REAL entrypoint bytes so a reintroduced fallback fails this test.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src', 'index.ts'),
      'utf8'
    );
    // Scan code only: strip line comments and block comments so the explanatory
    // text that mentions the removed fallback cannot satisfy or defeat this test.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(code).not.toContain('deps.dreamer.replay');
    expect(code).not.toContain('deps?.dreamer?.replay');
    // And the orchestrator-owning trigger is still the idle path.
    expect(code).toContain('orchestrator.triggerDream');
  });

  it('reports a skipped idle dream instead of replaying behind the gate', async () => {
    // When a dreamer cannot be reached through the orchestrator, the idle path
    // must decline and SAY SO rather than fall back to a direct replay.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src', 'index.ts'),
      'utf8'
    );
    expect(source).toContain('would bypass the dreamReports/publication gate chain');
  });
});

describe('PR-4B assembly: the config opt-in reaches every dreamer door', () => {
  // The holdout is data on `dreamBase`, the ONE object both dreamers are built
  // from. These three tests drive the REAL assemblies (not a hand-built dreamer)
  // so a refactor that drops the field from one door fails here.
  function mkTree(id: string, taskId: string, createdAt: number): DiscoveryTreeSnapshot {
    const tree = createDiscoveryTree({
      id,
      sessionId: 'sess-' + id,
      taskId,
      rootPatchId: 'root-' + id,
      createdAt,
      clock: fixedClock(createdAt)
    });
    tree.addNode(childInput(tree.rootId, { id: id + '-s1', origin: 'domain', purpose: 'explore' }));
    tree.recordProbe(id + '-s1', { trajectoryId: 't-' + id + '-s1', score: 0.1 });
    tree.addNode(childInput(tree.rootId, { id: id + '-s2', origin: 'domain', purpose: 'explore' }));
    tree.recordProbe(id + '-s2', { trajectoryId: 't-' + id + '-s2', score: 0.3 });
    tree.addNode(childInput(id + '-s2', { id: id + '-d1', purpose: 'deepen' }));
    tree.recordProbe(id + '-d1', { trajectoryId: 't-' + id + '-d1', score: 0.35 });
    tree.addNode(childInput(id + '-d1', { id: id + '-d2', purpose: 'deepen' }));
    tree.recordProbe(id + '-d2', { trajectoryId: 't-' + id + '-d2', score: 0.4 });
    return tree.snapshot();
  }

  it('threads holdoutTreeCount into the Jit-wired dreamer assembly', async () => {
    const { buildOrchestratorDeps } = await import('../../../src/index');
    const config = parseEvoHarnessConfig({
      dreamRsi: { holdoutTreeCount: 1 },
      jitrl: { enabled: true, levels: ['meta'] }
    });
    const T0 = 1_700_000_000_000;
    const built = buildOrchestratorDeps(config, { now: () => T0 }, {}, []);
    // `deps.dreamer` is typed as the narrow IOfflineDreamer contract; the widened
    // report type is the documented additive surface (src/dream-rsi), so narrow
    // through it rather than loosening the contract.
    const report = (await built.deps.dreamer.replay({
      trees: [mkTree('w1', 'task-w1', 1_000), mkTree('w2', 'task-w2', 2_000)],
      baselinePolicy: built.deps.policy.policy,
      candidatePolicies: []
    })) as DreamReplayReportWithShadow;
    expect(report.shadow.split.status).toBe('ok');
    expect(report.shadow.holdoutTreeIds).toEqual(['w2']);
  });

  it('threads holdoutTreeCount into the plain (non-Jit) dreamer assembly', async () => {
    const { buildOrchestratorDeps } = await import('../../../src/index');
    const config = parseEvoHarnessConfig({
      dreamRsi: { holdoutTreeCount: 1 },
      jitrl: { enabled: false }
    });
    const T0 = 1_700_000_000_000;
    const built = buildOrchestratorDeps(config, { now: () => T0 }, {}, []);
    const report = (await built.deps.dreamer.replay({
      trees: [mkTree('x1', 'task-x1', 1_000), mkTree('x2', 'task-x2', 2_000)],
      baselinePolicy: built.deps.policy.policy,
      candidatePolicies: []
    })) as DreamReplayReportWithShadow;
    expect(report.shadow.split.status).toBe('ok');
    expect(report.shadow.holdoutTreeIds).toEqual(['x2']);
  });

  it('fails closed through the production assembly when the pool cannot supply the configured count', async () => {
    // The defect is a RUNTIME one, not a config one: `holdoutTreeCount: 5` passes
    // validation against `maxTreePoolSize` (default 200) while the actual pool has
    // 4 trees. The assembly must therefore still fail closed at split time.
    const { buildOrchestratorDeps } = await import('../../../src/index');
    const config = parseEvoHarnessConfig({
      dreamRsi: { holdoutTreeCount: 5 },
      jitrl: { enabled: false }
    });
    const T0 = 1_700_000_000_000;
    const built = buildOrchestratorDeps(config, { now: () => T0 }, {}, []);
    const report = (await built.deps.dreamer.replay({
      trees: [
        mkTree('z1', 'task-z1', 1_000),
        mkTree('z2', 'task-z2', 2_000),
        mkTree('z3', 'task-z3', 3_000),
        mkTree('z4', 'task-z4', 4_000)
      ],
      baselinePolicy: built.deps.policy.policy,
      candidatePolicies: []
    })) as DreamReplayReportWithShadow;
    expect(report.shadow.split.status).toBe('insufficient-holdout-trees');
    expect(report.shadow.split.hasSufficientEvidence).toBe(false);
    expect(report.shadow.split.diagnostics.requestedHoldoutCount).toBe(5);
    expect(report.shadow.split.diagnostics.holdoutCount).toBe(3);
    expect(report.shadow.split.diagnostics.holdoutShortfall).toBe(2);
    expect(report.shadow.holdoutTreeIds).toHaveLength(0);
    expect(report.shadow.holdoutHypervolume).toBeUndefined();
    expect(report.publication.publish).toBe(false);
  });

  it('threads holdoutTreeCount into the maintenance (orchestrator) entry', async () => {
    const { createEvoHarnessPlugin } = await import('../../../src/index');
    const config = parseEvoHarnessConfig({
      dreamRsi: { holdoutTreeCount: 1 },
      jitrl: { enabled: true, levels: ['meta'] }
    });
    const T0 = 1_700_000_000_000;
    const plugin = createEvoHarnessPlugin({ config, now: () => T0 });
    plugin.orchestrator.treePool.add(mkTree('m1', 'task-m1', 1_000));
    plugin.orchestrator.treePool.add(mkTree('m2', 'task-m2', 2_000));
    const diagnostics: string[] = [];
    const report = await plugin.orchestrator.triggerDream(diagnostics);
    expect(report).not.toBeNull();
    expect(report!.shadow.split.status).toBe('ok');
    expect(report!.shadow.holdoutTreeIds).toEqual(['m2']);
    // The publication gate is unchanged by the opt-in: still refused.
    expect(report!.publication.publish).toBe(false);
  });
});
