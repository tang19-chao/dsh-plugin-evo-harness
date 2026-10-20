import { describe, expect, it } from 'vitest';

import {
  COMPLEXITY_FACTORS,
  DEFAULT_FOCUS_SURFACES,
  DEFAULT_SLOT_WEIGHTS,
  HARD_POLICY_LIMITS,
  PolicyValidationError,
  apportionSearchSlots,
  createActivePolicy,
  createActivePolicyFromDefaults,
  createDefaultPolicy,
  originForSlot,
  validatePolicy
} from '../../../src/dream-rsi/active-policy';
import { createDiscoveryTree } from '../../../src/dream-rsi/discovery-tree';
import type {
  BatchSlotKind,
  MetaSearchPolicy,
  PlanGridRequest,
  ProbeTask,
  SearchGridPlan,
  SelectBatchRequest
} from '../../../src/types/contracts';
import { childInput, fixedClock, makeDiagnosis, makePolicy } from './fixtures';

function task(complexity: ProbeTask['complexity']): ProbeTask {
  return { id: 'task-1', prompt: 'optimize the harness', complexity, taskSignature: 'sig' };
}

function planRequest(overrides: Partial<PlanGridRequest> = {}): PlanGridRequest {
  return {
    task: overrides.task ?? task('complex'),
    memoryConfidence: overrides.memoryConfidence ?? 0,
    budgetRemaining: overrides.budgetRemaining ?? 20,
    currentDepth: overrides.currentDepth ?? 0,
    exploredNodes: overrides.exploredNodes ?? 0,
    policy: overrides.policy ?? makePolicy(),
    ...(overrides.previousFailures === undefined
      ? {}
      : { previousFailures: overrides.previousFailures })
  };
}

function grid(overrides: Partial<SearchGridPlan> = {}): SearchGridPlan {
  return {
    maxWidth: overrides.maxWidth ?? 4,
    maxDepth: overrides.maxDepth ?? 3,
    budget: overrides.budget ?? 12,
    skipProbing: overrides.skipProbing ?? false,
    stopCondition: overrides.stopCondition ?? 'budget_exhausted',
    complexity: overrides.complexity ?? 'complex',
    rationale: overrides.rationale ?? 'test grid',
    policyId: overrides.policyId ?? 'pi-0'
  };
}

function buildTree() {
  const tree = createDiscoveryTree({
    id: 'tree-1',
    sessionId: 'session-1',
    taskId: 'task-1',
    rootPatchId: 'patch-root',
    clock: fixedClock()
  });
  tree.recordProbe(tree.rootId, { trajectoryId: 'traj-root', score: 0.5 });
  tree.addNode(childInput(tree.rootId, { id: 'a', origin: 'domain', purpose: 'explore' }));
  tree.recordProbe('a', { trajectoryId: 'traj-a', score: 0.9 });
  tree.addNode(
    childInput(tree.rootId, { id: 'b', origin: 'invariant', guidance: 'guidance_free' })
  );
  tree.recordProbe('b', {
    trajectoryId: 'traj-b',
    status: 'failed',
    score: 0.1,
    failure: makeDiagnosis('repairable_implementation', {
      repairHint: 'Repair mount_plugin then re-probe.'
    })
  });
  return tree;
}

function batchRequest(overrides: Partial<SelectBatchRequest> = {}): SelectBatchRequest {
  return {
    task: overrides.task ?? task('complex'),
    sessionId: overrides.sessionId ?? 'session-1',
    tree: overrides.tree ?? buildTree().snapshot(),
    grid: overrides.grid ?? grid(),
    memoryConfidence: overrides.memoryConfidence ?? 0.3,
    round: overrides.round ?? 1,
    ...(overrides.previousBestNodeId === undefined
      ? {}
      : { previousBestNodeId: overrides.previousBestNodeId }),
    ...(overrides.previousFailure === undefined
      ? {}
      : { previousFailure: overrides.previousFailure }),
    ...(overrides.metadata === undefined ? {} : { metadata: overrides.metadata })
  };
}

/** Fresh tree plus a batch request bound to that tree's snapshot. */
function withTree(overrides: Partial<SelectBatchRequest> = {}) {
  const tree = buildTree();
  const request = batchRequest({ tree: tree.snapshot(), ...overrides });
  return { tree, request };
}

const REPAIRABLE = makeDiagnosis('repairable_implementation', {
  repairHint: 'Repair mount_plugin then re-probe.'
});

describe('planGrid budget planning', () => {
  const policyApi = createActivePolicyFromDefaults();

  it('produces a plan bounded by the policy caps and the remaining budget', () => {
    const plan = policyApi.planGrid(planRequest());
    expect(plan.maxWidth).toBe(4);
    expect(plan.maxDepth).toBe(3);
    expect(plan.maxWidth).toBeLessThanOrEqual(policyApi.policy.maxWidth);
    expect(plan.maxDepth).toBeLessThanOrEqual(policyApi.policy.maxDepth);
    expect(plan.budget).toBeLessThanOrEqual(plan.maxWidth * plan.maxDepth);
    expect(plan.budget).toBeLessThanOrEqual(20);
    expect(plan.skipProbing).toBe(false);
    expect(plan.complexity).toBe('complex');
    expect(plan.policyId).toBe(policyApi.policy.id);
    expect(plan.rationale.length).toBeGreaterThan(0);
  });

  it('skips probing for simple tasks with high memory confidence', () => {
    const plan = policyApi.planGrid(
      planRequest({ task: task('simple'), memoryConfidence: 0.9 })
    );
    expect(plan.skipProbing).toBe(true);
    expect(plan.maxWidth).toBe(0);
    expect(plan.maxDepth).toBe(0);
    expect(plan.budget).toBe(0);
    expect(plan.stopCondition).toBe('first_success');
  });

  it('never skips an unknown-complexity task even with confident memory', () => {
    const plan = policyApi.planGrid(
      planRequest({ task: task('unknown'), memoryConfidence: 0.99 })
    );
    expect(plan.skipProbing).toBe(false);
    expect(plan.maxWidth).toBeGreaterThanOrEqual(1);
    expect(plan.stopCondition).toBe('first_success');
  });

  it('scales width with task complexity', () => {
    const widths = (['trivial', 'simple', 'moderate', 'complex'] as const).map(
      (complexity) => policyApi.planGrid(planRequest({ task: task(complexity) })).maxWidth
    );
    expect(widths).toEqual([1, 2, 3, 4]);
    expect(COMPLEXITY_FACTORS.trivial).toBeLessThan(COMPLEXITY_FACTORS.complex);
  });

  it('narrows the grid when memory confidence is high', () => {
    const low = policyApi.planGrid(planRequest({ memoryConfidence: 0 }));
    const high = policyApi.planGrid(planRequest({ memoryConfidence: 0.8 }));
    expect(high.maxWidth).toBeLessThan(low.maxWidth);
    expect(high.maxDepth).toBe(low.maxDepth);
  });

  it('shrinks width and depth to fit the remaining budget', () => {
    const plan = policyApi.planGrid(planRequest({ budgetRemaining: 1 }));
    expect(plan.budget).toBe(1);
    expect(plan.maxWidth).toBe(1);
    expect(plan.maxDepth).toBe(1);
    expect(plan.maxWidth * plan.maxDepth).toBeGreaterThanOrEqual(plan.budget);
  });

  it('reports an exhausted budget without probing', () => {
    const plan = policyApi.planGrid(planRequest({ budgetRemaining: 0 }));
    expect(plan.maxWidth).toBe(0);
    expect(plan.budget).toBe(0);
    expect(plan.skipProbing).toBe(false);
    expect(plan.stopCondition).toBe('budget_exhausted');
  });

  it('selects the documented stop condition', () => {
    expect(policyApi.planGrid(planRequest({ currentDepth: 3 })).stopCondition).toBe('max_depth');
    expect(
      policyApi.planGrid(planRequest({ memoryConfidence: 0.9 })).stopCondition
    ).toBe('first_success');
    const diminishing = policyApi.planGrid(
      planRequest({
        previousFailures: [
          makeDiagnosis('repeatedly_unpromising'),
          makeDiagnosis('repeatedly_unpromising')
        ]
      })
    );
    expect(diminishing.stopCondition).toBe('diminishing_returns');
    expect(policyApi.planGrid(planRequest()).stopCondition).toBe('budget_exhausted');
  });

  it('respects a narrower policy', () => {
    const narrow = makePolicy({ maxWidth: 2, maxDepth: 1 });
    const plan = policyApi.planGrid(planRequest({ policy: narrow }));
    expect(plan.maxWidth).toBeLessThanOrEqual(2);
    expect(plan.maxDepth).toBe(1);
    expect(plan.policyId).toBe('pi-0');
  });
});

describe('three-way batch portfolio', () => {
  const policyApi = createActivePolicyFromDefaults();

  it('mixes exploit, domain and invariant tracks with one recovery slot', () => {
    const { request } = withTree({ previousBestNodeId: 'a', previousFailure: REPAIRABLE });
    const batch = policyApi.selectBatch(request);
    expect(batch.round).toBe(1);
    expect(batch.width).toBe(4);
    expect(batch.slots).toHaveLength(4);
    expect(batch.policyId).toBe('pi-0');
    expect(batch.grid.maxWidth).toBe(4);
    const kinds = batch.slots.map((slot) => slot.slot);
    expect(kinds).toContain('exploit');
    expect(kinds).toContain('explore_domain');
    expect(kinds).toContain('explore_invariant');
    expect(kinds.filter((kind) => kind === 'recover')).toHaveLength(1);
    expect(batch.slots.map((slot) => slot.slotIndex)).toEqual([0, 1, 2, 3]);
    expect(new Set(batch.slots.map((slot) => slot.branchId)).size).toBe(4);
  });

  it('keeps the invariant track guidance-free and roots exploration at the root', () => {
    const { tree, request } = withTree({ previousFailure: REPAIRABLE });
    const batch = policyApi.selectBatch(request);
    const invariant = batch.slots.filter((slot) => slot.slot === 'explore_invariant');
    expect(invariant.length).toBeGreaterThan(0);
    for (const slot of invariant) {
      expect(slot.guidance).toBe('guidance_free');
      expect(slot.origin).toBe('invariant');
      expect(slot.parentNodeId).toBe(tree.rootId);
      expect(slot.memoryHintIds ?? []).toEqual([]);
    }
    const domain = batch.slots.find((slot) => slot.slot === 'explore_domain');
    expect(domain?.guidance).toBe('memory');
    expect(domain?.origin).toBe('domain');
    expect(domain?.parentNodeId).toBe(tree.rootId);
  });

  it('targets the repairing node and inherits its guidance', () => {
    const { request } = withTree({ previousBestNodeId: 'a', previousFailure: REPAIRABLE });
    const batch = policyApi.selectBatch(request);
    const recovery = batch.slots.find((slot) => slot.slot === 'recover');
    expect(recovery?.repairOfNodeId).toBe('b');
    expect(recovery?.parentNodeId).toBe('b');
    expect(recovery?.guidance).toBe('guidance_free');
    expect(recovery?.origin).toBe('invariant');
    expect(recovery?.rationale).toContain('repair');
  });

  it('deepens the best known node in exploit slots', () => {
    const { request } = withTree({ previousBestNodeId: 'a', previousFailure: REPAIRABLE });
    const batch = policyApi.selectBatch(request);
    const exploit = batch.slots.find((slot) => slot.slot === 'exploit');
    expect(exploit?.parentNodeId).toBe('a');
    expect(exploit?.origin).toBe('reference');
    expect(exploit?.guidance).toBe('memory');
    expect(exploit?.seedPatchIds).toEqual(['patch-a']);
  });

  it('still scans the tree when the supplied failure is not repairable', () => {
    const { request } = withTree({
      previousFailure: makeDiagnosis('weak_underexplored', { repairable: false })
    });
    const batch = policyApi.selectBatch(request);
    const recovery = batch.slots.find((slot) => slot.slot === 'recover');
    expect(recovery?.parentNodeId).toBe('b');
    expect(recovery?.repairOfNodeId).toBe('b');
    expect(batch.slots.filter((slot) => slot.slot === 'recover')).toHaveLength(1);
    expect(batch.width).toBeLessThanOrEqual(4);
  });

  it('never emits more than one recovery slot for wide batches', () => {
    const { request } = withTree({
      grid: grid({ maxWidth: 6, budget: 24 }),
      previousFailure: REPAIRABLE
    });
    const batch = policyApi.selectBatch(request);
    expect(batch.slots.filter((slot) => slot.slot === 'recover')).toHaveLength(1);
    expect(batch.slots).toHaveLength(6);
    expect(batch.width).toBe(6);
  });

  it('returns an empty batch when probing is skipped', () => {
    const batch = policyApi.selectBatch(
      batchRequest({ grid: grid({ maxWidth: 0, maxDepth: 0, budget: 0, skipProbing: true }) })
    );
    expect(batch.width).toBe(0);
    expect(batch.slots).toEqual([]);
    expect(batch.metadata?.reason).toBe('skip_probing');
  });

  it('bounds the batch by the grid budget', () => {
    const { request } = withTree({ grid: grid({ maxWidth: 4, budget: 2 }) });
    const batch = policyApi.selectBatch(request);
    expect(batch.width).toBeLessThanOrEqual(2);
    expect(batch.slots).toHaveLength(2);
  });

  it('fills every slot with valid surfaces and utility estimates', () => {
    const { request } = withTree({ previousFailure: REPAIRABLE });
    const batch = policyApi.selectBatch(request);
    for (const slot of batch.slots) {
      expect(slot.focusSurfaces.length).toBeGreaterThan(0);
      for (const surface of slot.focusSurfaces) {
        expect(DEFAULT_FOCUS_SURFACES).toContain(surface);
      }
      expect(slot.expectedUtility).toBeGreaterThanOrEqual(0);
      expect(slot.expectedUtility).toBeLessThanOrEqual(1);
      expect(slot.branchId).toContain('session-1');
      expect(slot.rationale.length).toBeGreaterThan(0);
    }
  });

  it('propagates memory hints to the domain track only', () => {
    const { request } = withTree({ previousFailure: REPAIRABLE });
    const batch = policyApi.selectBatch({
      ...request,
      metadata: { memoryHintIds: ['lesson-1', 'lesson-2'] }
    });
    const domain = batch.slots.find((slot) => slot.slot === 'explore_domain');
    expect(domain?.memoryHintIds).toEqual(['lesson-1', 'lesson-2']);
    const invariant = batch.slots.find((slot) => slot.slot === 'explore_invariant');
    expect(invariant?.memoryHintIds).toBeUndefined();
  });
});

describe('recovery slot from tree evidence', () => {
  const policyApi = createActivePolicyFromDefaults();

  function treeWithFailures() {
    const tree = createDiscoveryTree({
      id: 'tree-recover',
      sessionId: 'session-1',
      taskId: 'task-1',
      rootPatchId: 'patch-root',
      clock: fixedClock()
    });
    tree.addNode(childInput(tree.rootId, { id: 'b1', origin: 'domain', purpose: 'repair' }));
    tree.recordProbe('b1', {
      trajectoryId: 'traj-b1',
      status: 'failed',
      score: 0.1,
      failure: makeDiagnosis('repairable_implementation')
    });
    tree.addNode(
      childInput(tree.rootId, {
        id: 'b2',
        origin: 'invariant',
        guidance: 'guidance_free',
        purpose: 'repair'
      })
    );
    tree.recordProbe('b2', {
      trajectoryId: 'traj-b2',
      status: 'failed',
      score: 0.2,
      failure: makeDiagnosis('repairable_implementation', {
        repairHint: 'Repair mount_script then re-probe.'
      })
    });
    tree.updateNode('b1', { updatedAt: 5_000 });
    tree.updateNode('b2', { updatedAt: 9_000 });
    return tree;
  }

  it('targets the most recently updated repairable failure without previousFailure', () => {
    const tree = treeWithFailures();
    const batch = policyApi.selectBatch(
      batchRequest({ tree: tree.snapshot(), memoryConfidence: 0.2, round: 3 })
    );
    const recoveries = batch.slots.filter((slot) => slot.slot === 'recover');
    expect(recoveries).toHaveLength(1);
    const recovery = recoveries[0];
    expect(recovery?.parentNodeId).toBe('b2');
    expect(recovery?.repairOfNodeId).toBe('b2');
    expect(recovery?.origin).toBe('invariant');
    expect(recovery?.guidance).toBe('guidance_free');
    expect(recovery?.seedPatchIds).toEqual(['patch-b2']);
    expect(recovery?.rationale).toContain('mount_script');
    expect(batch.slots.filter((slot) => slot.slot === 'recover')).toHaveLength(1);
  });

  it('produces no recovery slot for non-repairable or absent failures', () => {
    const nonRepairable = createDiscoveryTree({
      id: 'tree-weak',
      sessionId: 'session-1',
      taskId: 'task-1',
      rootPatchId: 'patch-root',
      clock: fixedClock()
    });
    nonRepairable.addNode(childInput(nonRepairable.rootId, { id: 'w1' }));
    nonRepairable.recordProbe('w1', {
      trajectoryId: 'traj-w1',
      status: 'failed',
      score: 0.1,
      failure: makeDiagnosis('weak_underexplored', {
        repairable: false,
        recommendedAction: 'deepen'
      })
    });
    nonRepairable.addNode(childInput(nonRepairable.rootId, { id: 'h1' }));
    nonRepairable.recordProbe('h1', {
      trajectoryId: 'traj-h1',
      status: 'failed',
      score: 0,
      failure: makeDiagnosis('hard_unrecoverable', {
        repairable: false,
        recommendedAction: 'discard'
      })
    });
    const weakBatch = policyApi.selectBatch(
      batchRequest({ tree: nonRepairable.snapshot(), round: 4 })
    );
    expect(weakBatch.slots.some((slot) => slot.slot === 'recover')).toBe(false);

    const clean = createDiscoveryTree({
      id: 'tree-clean',
      sessionId: 'session-1',
      taskId: 'task-1',
      rootPatchId: 'patch-root',
      clock: fixedClock()
    });
    clean.recordProbe(clean.rootId, { trajectoryId: 'traj-root', score: 0.5 });
    clean.addNode(childInput(clean.rootId, { id: 'ok' }));
    clean.recordProbe('ok', { trajectoryId: 'traj-ok', score: 0.8 });
    const cleanBatch = policyApi.selectBatch(batchRequest({ tree: clean.snapshot(), round: 5 }));
    expect(cleanBatch.slots.some((slot) => slot.slot === 'recover')).toBe(false);
    expect(cleanBatch.width).toBeGreaterThan(0);
  });

  it('lets an explicit repair node id win over the tree scan', () => {
    const tree = treeWithFailures();
    const byRepairNodeId = policyApi.selectBatch(
      batchRequest({ tree: tree.snapshot(), metadata: { repairNodeId: 'b1' }, round: 6 })
    );
    expect(byRepairNodeId.slots.filter((slot) => slot.slot === 'recover')).toHaveLength(1);
    expect(
      byRepairNodeId.slots.find((slot) => slot.slot === 'recover')?.parentNodeId
    ).toBe('b1');

    const byAlias = policyApi.selectBatch(
      batchRequest({
        tree: tree.snapshot(),
        metadata: { previousFailureNodeId: 'b1' },
        round: 7
      })
    );
    expect(byAlias.slots.find((slot) => slot.slot === 'recover')?.parentNodeId).toBe('b1');

    const unknownExplicit = policyApi.selectBatch(
      batchRequest({ tree: tree.snapshot(), metadata: { repairNodeId: 'ghost' }, round: 8 })
    );
    expect(unknownExplicit.slots.find((slot) => slot.slot === 'recover')?.parentNodeId).toBe('b2');
  });

  it('keeps repairable previousFailure targeting and ignores an unhelpful diagnosis', () => {
    const tree = treeWithFailures();
    const repairable = policyApi.selectBatch(
      batchRequest({
        tree: tree.snapshot(),
        previousFailure: makeDiagnosis('repairable_implementation', {
          repairHint: 'Repair mount_script then re-probe.'
        }),
        round: 9
      })
    );
    expect(repairable.slots.find((slot) => slot.slot === 'recover')?.parentNodeId).toBe('b2');

    const siblingDiagnosis = policyApi.selectBatch(
      batchRequest({
        tree: tree.snapshot(),
        previousFailure: makeDiagnosis('weak_underexplored', { repairable: false }),
        round: 10
      })
    );
    expect(siblingDiagnosis.slots.filter((slot) => slot.slot === 'recover')).toHaveLength(1);
    expect(
      siblingDiagnosis.slots.find((slot) => slot.slot === 'recover')?.parentNodeId
    ).toBe('b2');

    const emptyTree = createDiscoveryTree({
      id: 'tree-only-success',
      sessionId: 'session-1',
      taskId: 'task-1',
      rootPatchId: 'patch-root',
      clock: fixedClock()
    });
    emptyTree.recordProbe(emptyTree.rootId, { trajectoryId: 'traj-root', score: 0.6 });
    const withoutCandidates = policyApi.selectBatch(
      batchRequest({
        tree: emptyTree.snapshot(),
        previousFailure: makeDiagnosis('repairable_implementation'),
        round: 11
      })
    );
    expect(withoutCandidates.slots.some((slot) => slot.slot === 'recover')).toBe(false);
  });

  it('never exceeds one recovery slot even with several repairable failures', () => {
    const tree = treeWithFailures();
    tree.addNode(childInput(tree.rootId, { id: 'b3', origin: 'reference', purpose: 'repair' }));
    tree.recordProbe('b3', {
      trajectoryId: 'traj-b3',
      status: 'failed',
      score: 0.3,
      failure: makeDiagnosis('repairable_implementation')
    });
    tree.updateNode('b3', { updatedAt: 12_000 });
    const batch = policyApi.selectBatch(
      batchRequest({ tree: tree.snapshot(), grid: grid({ maxWidth: 6, budget: 24 }), round: 12 })
    );
    expect(batch.slots.filter((slot) => slot.slot === 'recover')).toHaveLength(1);
    expect(batch.slots.find((slot) => slot.slot === 'recover')?.parentNodeId).toBe('b3');
    expect(batch.slots).toHaveLength(6);
  });
});

describe('recovery targeting across rounds', () => {
  const policyApi = createActivePolicyFromDefaults();

  function roundTree() {
    const tree = createDiscoveryTree({
      id: 'tree-rounds',
      sessionId: 'session-1',
      taskId: 'task-1',
      rootPatchId: 'patch-root',
      clock: fixedClock()
    });
    tree.addNode(childInput(tree.rootId, { id: 'f1', origin: 'domain', purpose: 'repair' }));
    tree.recordProbe('f1', {
      trajectoryId: 'traj-f1',
      status: 'failed',
      score: 0.1,
      failure: makeDiagnosis('repairable_implementation')
    });
    tree.addNode(
      childInput(tree.rootId, {
        id: 'f2',
        origin: 'invariant',
        guidance: 'guidance_free',
        purpose: 'repair'
      })
    );
    tree.recordProbe('f2', {
      trajectoryId: 'traj-f2',
      status: 'failed',
      score: 0.2,
      failure: makeDiagnosis('repairable_implementation', {
        repairHint: 'Repair mount_script then re-probe.'
      })
    });
    tree.updateNode('f1', { updatedAt: 9_000 });
    tree.updateNode('f2', { updatedAt: 5_000 });
    return tree;
  }

  /** Attach a child that marks the parent as already repaired. */
  function addChild(
    tree: ReturnType<typeof roundTree>,
    parentId: string,
    childId: string,
    options: { readonly slot?: 'recover'; readonly purpose?: 'repair' | 'deepen' } = {}
  ): void {
    tree.addNode({
      ...childInput(parentId, {
        id: childId,
        origin: 'reference',
        purpose: options.purpose ?? 'repair'
      }),
      ...(options.slot === undefined ? {} : { slot: options.slot }),
      createdAt: 9_500
    });
  }

  it('ignores a sibling-level non-repairable diagnosis and repairs the failed node', () => {
    const tree = roundTree();
    const withSiblingDiagnosis = policyApi.selectBatch(
      batchRequest({
        tree: tree.snapshot(),
        previousFailure: makeDiagnosis('weak_underexplored', { repairable: false }),
        round: 1
      })
    );
    const recovery = withSiblingDiagnosis.slots.find((slot) => slot.slot === 'recover');
    expect(recovery?.parentNodeId).toBe('f1');
    expect(recovery?.repairOfNodeId).toBe('f1');
    expect(withSiblingDiagnosis.slots.filter((slot) => slot.slot === 'recover')).toHaveLength(1);

    const withoutDiagnosis = policyApi.selectBatch(
      batchRequest({ tree: tree.snapshot(), round: 2 })
    );
    expect(withoutDiagnosis.slots.find((slot) => slot.slot === 'recover')?.parentNodeId).toBe(
      'f1'
    );
  });

  it('produces no recovery slot when no repairable failure exists anywhere', () => {
    const tree = createDiscoveryTree({
      id: 'tree-unrepairable',
      sessionId: 'session-1',
      taskId: 'task-1',
      rootPatchId: 'patch-root',
      clock: fixedClock()
    });
    tree.addNode(childInput(tree.rootId, { id: 'w1' }));
    tree.recordProbe('w1', {
      trajectoryId: 'traj-w1',
      status: 'failed',
      score: 0.1,
      failure: makeDiagnosis('weak_underexplored', {
        repairable: false,
        recommendedAction: 'deepen'
      })
    });
    tree.addNode(childInput(tree.rootId, { id: 'h1' }));
    tree.recordProbe('h1', {
      trajectoryId: 'traj-h1',
      status: 'failed',
      score: 0,
      failure: makeDiagnosis('hard_unrecoverable', {
        repairable: false,
        recommendedAction: 'discard'
      })
    });

    const withoutFailure = policyApi.selectBatch(
      batchRequest({ tree: tree.snapshot(), round: 3 })
    );
    expect(withoutFailure.slots.some((slot) => slot.slot === 'recover')).toBe(false);
    expect(withoutFailure.width).toBeGreaterThan(0);

    const repairableDiagnosisButEmptyTree = policyApi.selectBatch(
      batchRequest({
        tree: tree.snapshot(),
        previousFailure: makeDiagnosis('repairable_implementation'),
        round: 3
      })
    );
    expect(repairableDiagnosisButEmptyTree.slots.some((slot) => slot.slot === 'recover')).toBe(
      false
    );
  });

  it('skips a failed node that already has a recover-slot child', () => {
    const tree = roundTree();
    addChild(tree, 'f1', 'f1-recover', { slot: 'recover', purpose: 'deepen' });
    const batch = policyApi.selectBatch(batchRequest({ tree: tree.snapshot(), round: 4 }));
    const recovery = batch.slots.find((slot) => slot.slot === 'recover');
    expect(recovery?.parentNodeId).toBe('f2');
    expect(batch.slots.filter((slot) => slot.slot === 'recover')).toHaveLength(1);
  });

  it('skips a failed node that already has a repair-purpose child', () => {
    const tree = roundTree();
    addChild(tree, 'f1', 'f1-repair', { purpose: 'repair' });
    const batch = policyApi.selectBatch(batchRequest({ tree: tree.snapshot(), round: 5 }));
    expect(batch.slots.filter((slot) => slot.slot === 'recover')).toHaveLength(1);
    expect(batch.slots.find((slot) => slot.slot === 'recover')?.parentNodeId).toBe('f2');
  });

  it('produces no recovery slot once every repairable failure was already repaired', () => {
    const tree = roundTree();
    addChild(tree, 'f1', 'f1-recover', { slot: 'recover', purpose: 'deepen' });
    addChild(tree, 'f2', 'f2-repair', { purpose: 'repair' });
    const batch = policyApi.selectBatch(batchRequest({ tree: tree.snapshot(), round: 6 }));
    expect(batch.slots.some((slot) => slot.slot === 'recover')).toBe(false);
    expect(batch.width).toBeGreaterThan(0);
  });

  it('lets an explicit id win over the scan, including an already repaired node', () => {
    const tree = roundTree();
    tree.addNode(childInput(tree.rootId, { id: 'f3', origin: 'reference', purpose: 'repair' }));
    tree.recordProbe('f3', {
      trajectoryId: 'traj-f3',
      status: 'failed',
      score: 0.3,
      failure: makeDiagnosis('repairable_implementation')
    });
    tree.updateNode('f3', { updatedAt: 12_000 });
    addChild(tree, 'f1', 'f1-recover', { slot: 'recover', purpose: 'deepen' });

    const scanned = policyApi.selectBatch(batchRequest({ tree: tree.snapshot(), round: 7 }));
    expect(scanned.slots.find((slot) => slot.slot === 'recover')?.parentNodeId).toBe('f3');

    const explicit = policyApi.selectBatch(
      batchRequest({ tree: tree.snapshot(), metadata: { repairNodeId: 'f2' }, round: 8 })
    );
    expect(explicit.slots.find((slot) => slot.slot === 'recover')?.parentNodeId).toBe('f2');

    const explicitAlias = policyApi.selectBatch(
      batchRequest({
        tree: tree.snapshot(),
        metadata: { previousFailureNodeId: 'f2' },
        round: 9
      })
    );
    expect(explicitAlias.slots.find((slot) => slot.slot === 'recover')?.parentNodeId).toBe('f2');

    const explicitRepaired = policyApi.selectBatch(
      batchRequest({ tree: tree.snapshot(), metadata: { repairNodeId: 'f1' }, round: 10 })
    );
    expect(explicitRepaired.slots.find((slot) => slot.slot === 'recover')?.parentNodeId).toBe(
      'f1'
    );
  });

  it('preserves the single-slot width requirement and guidance inheritance', () => {
    const tree = roundTree();
    const wide = policyApi.selectBatch(
      batchRequest({ tree: tree.snapshot(), grid: grid({ maxWidth: 6, budget: 24 }), round: 11 })
    );
    expect(wide.slots.filter((slot) => slot.slot === 'recover')).toHaveLength(1);
    expect(wide.slots).toHaveLength(6);

    const narrow = policyApi.selectBatch(
      batchRequest({ tree: tree.snapshot(), grid: grid({ maxWidth: 1, budget: 1 }), round: 12 })
    );
    expect(narrow.width).toBe(1);
    expect(narrow.slots.some((slot) => slot.slot === 'recover')).toBe(false);

    const targeted = policyApi.selectBatch(
      batchRequest({ tree: tree.snapshot(), metadata: { repairNodeId: 'f2' }, round: 13 })
    );
    const recovery = targeted.slots.find((slot) => slot.slot === 'recover');
    expect(recovery?.origin).toBe('invariant');
    expect(recovery?.guidance).toBe('guidance_free');
    expect(recovery?.seedPatchIds).toEqual(['patch-f2']);
    expect(recovery?.rationale).toContain('mount_script');
  });
});

describe('slot apportionment', () => {
  it('awards every active track a slot when capacity allows', () => {
    const counts = apportionSearchSlots(3, DEFAULT_SLOT_WEIGHTS);
    expect(counts.exploit).toBe(1);
    expect(counts.explore_domain).toBe(1);
    expect(counts.explore_invariant).toBe(1);
    expect(counts.recover).toBe(0);
  });

  it('returns zeros for zero capacity', () => {
    expect(apportionSearchSlots(0, DEFAULT_SLOT_WEIGHTS)).toEqual({
      exploit: 0,
      explore_domain: 0,
      explore_invariant: 0,
      recover: 0
    });
  });

  it('spends extra capacity by largest remainder', () => {
    const counts = apportionSearchSlots(5, DEFAULT_SLOT_WEIGHTS);
    expect(counts.exploit + counts.explore_domain + counts.explore_invariant).toBe(5);
    expect(counts.exploit).toBe(2);
    expect(counts.explore_domain).toBe(2);
    expect(counts.explore_invariant).toBe(1);
  });

  it('truncates to the highest-weighted tracks when capacity is tight', () => {
    const counts = apportionSearchSlots(2, DEFAULT_SLOT_WEIGHTS);
    expect(counts.exploit).toBe(1);
    expect(counts.explore_domain).toBe(1);
    expect(counts.explore_invariant).toBe(0);
  });

  it('falls back to the first track when every weight is zero', () => {
    const counts = apportionSearchSlots(3, {
      exploit: 0,
      explore_domain: 0,
      explore_invariant: 0,
      recover: 0
    });
    expect(counts.exploit).toBe(3);
  });
});

describe('policy lifecycle', () => {
  it('builds pi-0 from the frozen configuration defaults', () => {
    const policy = createDefaultPolicy({ id: 'pi-0' }, () => 42);
    expect(policy.id).toBe('pi-0');
    expect(policy.version).toBe(1);
    expect(policy.createdAt).toBe(42);
    expect(policy.maxWidth).toBe(4);
    expect(policy.maxDepth).toBe(3);
    expect(policy.earlyStopThreshold).toBe(0.8);
    expect(policy.minMemoryConfidenceForSkip).toBe(0.75);
    expect(policy.slotWeights).toEqual(DEFAULT_SLOT_WEIGHTS);
    expect(validatePolicy(policy)).toEqual([]);
  });

  it('applies overrides and honours hard limits', () => {
    const policy = createDefaultPolicy(
      {
        id: 'pi-1',
        version: 3,
        parentPolicyId: 'pi-0',
        maxWidth: 2,
        maxDepth: 1,
        slotWeights: { recover: 0.5 },
        earlyStopThreshold: 0.5,
        minMemoryConfidenceForSkip: 0.2
      },
      () => 7
    );
    expect(policy.version).toBe(3);
    expect(policy.parentPolicyId).toBe('pi-0');
    expect(policy.maxWidth).toBe(2);
    expect(policy.maxDepth).toBe(1);
    expect(policy.slotWeights?.recover).toBe(0.5);
    expect(policy.earlyStopThreshold).toBe(0.5);
    expect(policy.minMemoryConfidenceForSkip).toBe(0.2);
    expect(HARD_POLICY_LIMITS.maxWidth).toBe(8);
  });

  it('validates policy structure', () => {
    expect(validatePolicy(makePolicy({ maxWidth: -1 }))).toContain(
      'maxWidth must be a finite number >= 0'
    );
    expect(validatePolicy(makePolicy({ earlyStopThreshold: 2 }))).toContain(
      'earlyStopThreshold must be within [0, 1]'
    );
    expect(validatePolicy(makePolicy({ version: 0 }))).toContain(
      'version must be a finite number >= 1'
    );
    const broken = {
      ...makePolicy(),
      slotWeights: { exploit: 0.5, explore_domain: 0.5 } as MetaSearchPolicy['slotWeights']
    };
    expect(validatePolicy(broken).length).toBeGreaterThan(0);
  });

  it('upgrades monotonically and keeps an audit trail', () => {
    const api = createActivePolicyFromDefaults();
    expect(api.appliedPolicyIds).toEqual(['pi-0@1']);
    const upgrade = createDefaultPolicy({ id: 'pi-1', version: 2 }, () => 9);
    api.update(upgrade);
    expect(api.policy.id).toBe('pi-1');
    expect(api.policy.version).toBe(2);
    expect(api.appliedPolicyIds).toEqual(['pi-0@1', 'pi-1@2']);
  });

  it('rejects regressions and invalid policies', () => {
    const api = createActivePolicyFromDefaults();
    const regression = createDefaultPolicy({ id: 'pi-old', version: 1 }, () => 9);
    expect(() => api.update({ ...regression, version: 0 })).toThrow(PolicyValidationError);
    expect(() =>
      api.update({ ...createDefaultPolicy({ id: 'ok', version: 1 }), maxWidth: -2 })
    ).toThrow(/maxWidth/);
    expect(api.policy.id).toBe('pi-0');
  });

  it('rejects an invalid initial policy and honours recovery caps', () => {
    expect(() => createActivePolicy({ policy: { ...makePolicy(), maxWidth: -5 } })).toThrow(
      PolicyValidationError
    );
    const noRecovery = createActivePolicyFromDefaults({}, { maxRecoverySlots: 0 });
    const { request } = withTree({ previousFailure: REPAIRABLE });
    const batch = noRecovery.selectBatch(request);
    expect(batch.slots.some((slot) => slot.slot === 'recover')).toBe(false);
    const capped = createActivePolicyFromDefaults({}, { maxRecoverySlots: 5 });
    const cappedBatch = capped.selectBatch(request);
    expect(cappedBatch.slots.filter((slot) => slot.slot === 'recover')).toHaveLength(1);
  });

  it('maps slot families onto patch origins', () => {
    const kinds: BatchSlotKind[] = [
      'exploit',
      'explore_domain',
      'explore_invariant',
      'recover'
    ];
    expect(kinds.map((kind) => originForSlot(kind))).toEqual([
      'reference',
      'domain',
      'invariant',
      'reference'
    ]);
  });
});
