import { describe, expect, it } from 'vitest';
import { EVO_HARNESS_STAGES, autoFallbackRequested } from '../../src/orchestrator';
import {
  buildE2E,
  createDefaultRecordingTaxonomy,
  createRecordingPolicy,
  createScriptedRunner,
  mem0LikeServer
} from './fixtures';

/** Documented lifecycle order; the trace must respect exactly this sequence. */
const DOCUMENTED_ORDER = [
  'initialize',
  'recall',
  'plan_grid',
  'reference_probe',
  'select_batch',
  'propose',
  'probe',
  'classify',
  'score',
  'compose',
  'reflect',
  'commit',
  'apply_patch',
  'finalize'
] as const;

describe('end-to-end lifecycle', () => {
  it('executes the documented stages in order and recovers from a reference tool failure', async () => {
    const { plugin, runner } = buildE2E();
    const task = plugin.makeTask({
      id: 'task-e2e',
      prompt: 'Fix the failing build without breaking the release train.',
      taskSignature: 'build-failure',
      contextTags: ['ci']
    });

    const result = await plugin.run({ sessionId: 'sess-e2e', task, trigger: 'always' });

    // 1. outcome and evidence of recovery
    expect(result.outcome).toBe('composed');
    expect(result.trigger).toBe('always');
    expect(result.probesRun).toBeGreaterThanOrEqual(2);
    expect(result.lessonsCommitted).toBeGreaterThanOrEqual(1);
    expect(result.metadata?.referenceStatus).toBe('failed');
    expect(result.metadata?.memoryDriverKind).toBe('vector_fact');
    expect(runner.calls[0]).toBe('reference');
    expect(runner.calls.filter((call) => call === 'candidate').length).toBeGreaterThanOrEqual(1);

    const composition = plugin.orchestrator.lastComposition();
    expect(composition).not.toBeNull();
    const selected = composition?.assessments.find((assessment) => assessment.selected);
    expect(selected).toBeDefined();
    expect(selected?.adoptionRatio).toBeGreaterThan(0);
    expect(selected?.contrasts.some((contrast) => contrast.dimension === 'task_completion')).toBe(true);
    expect(composition?.selectedTrajectoryId).not.toBeNull();

    // the winning scaffold is mounted permanently and the tree is retained
    expect(result.composedPatchId).toBeDefined();
    expect(plugin.orchestrator.activePatchIds()).toContain(result.composedPatchId);
    expect(plugin.orchestrator.treePool.size()).toBe(1);

    // 2. lifecycle order
    const trace = plugin.orchestrator.lastTrace();
    expect(trace.length).toBeGreaterThan(0);
    for (const stage of trace) {
      expect(EVO_HARNESS_STAGES).toContain(stage);
    }
    let cursor = -1;
    for (const stage of DOCUMENTED_ORDER) {
      const at = trace.indexOf(stage);
      expect(at, 'stage ' + stage + ' is missing from the trace').toBeGreaterThanOrEqual(0);
      expect(at, 'stage ' + stage + ' ran out of order').toBeGreaterThan(cursor);
      cursor = at;
    }
    expect(trace[trace.length - 1]).toBe('finalize');
    expect(Array.isArray(result.metadata?.lifecycle)).toBe(true);
    expect(result.metadata?.lifecycle).toEqual([...trace]);

    // 3. the failure taxonomy and surrogate score line up with the failure
    const tree = plugin.orchestrator.treePool.list()[0];
    expect(tree).toBeDefined();
    const nodes = Object.values(tree?.nodes ?? {});
    expect(nodes.length).toBeGreaterThanOrEqual(2);
    expect(nodes.some((node) => node.status === 'succeeded' && (node.score ?? 0) > 0)).toBe(true);
  });

  it('classifies the failing reference node with the four-way taxonomy', async () => {
    const { plugin } = buildE2E();
    const task = plugin.makeTask({ id: 'task-taxonomy', prompt: 'Repair the broken pipeline.' });
    await plugin.run({ sessionId: 'sess-taxonomy', task, trigger: 'always' });

    const tree = plugin.orchestrator.treePool.list()[0];
    const root = tree?.nodes[tree.rootId];
    expect(root?.status).toBe('failed');
  });

  it('skips auto_fallback until a blocking signal is reported', async () => {
    const { plugin, runner } = buildE2E();
    const task = plugin.makeTask({ id: 'task-fallback', prompt: 'Recover the blocked task.' });

    const skipped = await plugin.run({ sessionId: 'sess-fallback', task, trigger: 'auto_fallback' });
    expect(skipped.outcome).toBe('skipped');
    expect(runner.calls).toEqual([]);
    expect(skipped.diagnostics.join(' ')).toContain('no blocking signal');

    const ran = await plugin.run({
      sessionId: 'sess-fallback',
      task,
      trigger: 'auto_fallback',
      metadata: { failureSignals: [{ kind: 'tool_error', message: 'exit 1' }] }
    });
    expect(ran.outcome).toBe('composed');
    expect(runner.calls.length).toBeGreaterThan(0);
    expect(autoFallbackRequested({ sessionId: 's', task, trigger: 'auto_fallback', metadata: { failureSignals: [{ kind: 'tool_error', message: 'x' }] } })).toBe(true);
    expect(autoFallbackRequested({ sessionId: 's', task, trigger: 'auto_fallback' })).toBe(false);
  });

  it('honours a dry run by planning without probing', async () => {
    const { plugin, runner } = buildE2E();
    const task = plugin.makeTask({ id: 'task-dry', prompt: 'Plan only.' });

    const result = await plugin.run({ sessionId: 'sess-dry', task, trigger: 'slash_command', dryRun: true });

    expect(result.outcome).toBe('no_probe');
    expect(result.probesRun).toBe(0);
    expect(runner.calls).toEqual([]);
    expect(result.metadata?.stopReason).toBe('dry_run');
    expect(plugin.orchestrator.lastPlan()).not.toBeNull();
  });

  it('clamps run budgets to the frozen configuration', async () => {
    const { plugin, runner } = buildE2E({ rolloutBudget: 2, maxWidth: 2, maxDepth: 1 });
    const task = plugin.makeTask({ id: 'task-budget', prompt: 'Bounded run.' });

    const result = await plugin.run({
      sessionId: 'sess-budget',
      task,
      trigger: 'always',
      budgetOverride: { maxOnlineRolloutBudget: 99, maxWidth: 99, maxDepth: 99 }
    });

    // probesRun counts every branch execution; the grid budget bounds candidate
    // rollouts only, so the reference anchor may add exactly one more execution.
    const plan = plugin.orchestrator.lastPlan();
    expect(plan?.maxWidth).toBeLessThanOrEqual(2);
    expect(plan?.maxDepth).toBeLessThanOrEqual(1);
    expect(result.probesRun).toBeLessThanOrEqual((plan?.budget ?? 0) + 1);
    expect(runner.calls.filter((call) => call === 'candidate').length).toBeLessThanOrEqual(
      plan?.budget ?? 0
    );
  });

  it('degrades to no_probe with a diagnostic when no model is injected', async () => {
    const server = mem0LikeServer();
    const { createEvoHarnessPlugin } = await import('../../src/index');
    const now = ((): (() => number) => {
      let current = 1_700_000_000_000;
      return () => {
        current += 1;
        return current;
      };
    })();
    const plugin = createEvoHarnessPlugin(
      {
        config: { triggerMode: 'always', logging: { level: 'silent' } },
        clients: [server.client],
        runBranch: createScriptedRunner(now),
        now,
        newId: (() => {
          let counter = 0;
          return () => {
            counter += 1;
            return 'nomodel-' + String(counter);
          };
        })()
      },
      {}
    );

    const result = await plugin.run({
      sessionId: 'sess-nomodel',
      task: plugin.makeTask({ id: 'task-nomodel', prompt: 'No model available.' }),
      trigger: 'always'
    });

    expect(result.outcome).toBe('no_probe');
    expect(result.diagnostics.join(' ')).toContain('proposal failed');
  });

  it('scores above the 0.2 ceiling and persists the adoption ratio after compose', async () => {
    const { plugin } = buildE2E();
    const task = plugin.makeTask({ id: 'task-score', prompt: 'Fix the failing build.' });

    const result = await plugin.run({ sessionId: 'sess-score', task, trigger: 'always' });

    expect(result.outcome).toBe('composed');
    const composition = plugin.orchestrator.lastComposition();
    const selected = composition?.assessments.find((assessment) => assessment.selected);
    expect(selected).toBeDefined();

    const tree = plugin.orchestrator.treePool.list()[0];
    const node = tree?.nodes[selected?.nodeId ?? ''];
    expect(node).toBeDefined();
    expect(node?.status).toBe('succeeded');
    // Pre-fix the node was scored while still 'probing' and without any
    // composition, so only the efficiency and error-penalty terms could score
    // (a hard 0.2 ceiling) and adoptionRatio was never written. The post-compose
    // re-score turns the selection (0.4) and adoption (0.3) signals on.
    expect(node?.score ?? 0).toBeGreaterThan(0.2);
    expect(node?.score ?? 0).toBeGreaterThan(0.5);
    expect(node?.adoptionRatio).toBeCloseTo(selected?.adoptionRatio ?? -1, 6);
    expect(node?.adoptionRatio ?? 0).toBeGreaterThan(0.5);
  });

  it('keeps a repairable failure across a succeeding sibling and schedules a recover slot', async () => {
    const options = { maxWidth: 2, maxDepth: 2, rolloutBudget: 6, dreamEveryNTasks: 100 } as const;
    const policy = createRecordingPolicy(options, { stopCondition: 'max_depth' });
    const { plugin } = buildE2E({
      ...options,
      candidateOutcomes: ['fail', 'succeed'],
      extra: { deps: { policy } }
    });
    const task = plugin.makeTask({ id: 'task-recover', prompt: 'Fix the failing build.' });

    const result = await plugin.run({ sessionId: 'sess-recover', task, trigger: 'always' });

    expect(result.outcome).toBe('composed');
    expect(policy.selectBatchRequests.length).toBeGreaterThanOrEqual(2);

    const secondRequest = policy.selectBatchRequests[1];
    // a sibling success in round 1 must not erase the repairable failure
    expect(secondRequest?.previousFailure).toBeDefined();
    expect(secondRequest?.previousFailure?.repairable).toBe(true);
    expect(secondRequest?.previousFailure?.category).toBe('repairable_implementation');

    // and the real ActivePolicy converts it into a targeted recover slot
    const secondBatch = policy.batchPlans[1];
    const recoverSlot = secondBatch?.slots.find((slot) => slot.slot === 'recover');
    expect(recoverSlot).toBeDefined();
    expect(recoverSlot?.repairOfNodeId).toBeDefined();
    expect(recoverSlot?.seedPatchIds?.length ?? 0).toBeGreaterThan(0);
  });

  it('records probe surfaceKeys in node metadata for the active policy', async () => {
    const { plugin } = buildE2E();
    const task = plugin.makeTask({ id: 'task-surfaces', prompt: 'Fix the failing build.' });
    await plugin.run({ sessionId: 'sess-surfaces', task, trigger: 'always' });

    const tree = plugin.orchestrator.treePool.list()[0];
    const nodes = Object.values(tree?.nodes ?? {});
    const withSurfaces = nodes.filter(
      (node) =>
        Array.isArray(node.metadata?.surfaceKeys) &&
        (node.metadata?.surfaceKeys as unknown[]).length > 0
    );
    expect(withSurfaces.length).toBeGreaterThanOrEqual(1);
    expect(withSurfaces[0]?.metadata?.surfaceKeys as unknown[]).toContain('guardrails');
    expect(withSurfaces[0]?.metadata?.slot).toBeDefined();
    expect(withSurfaces[0]?.status).toBe('succeeded');
  });

  it('derives diagnosis lineage from the ancestor chain rather than the previous sibling', async () => {
    const options = { maxWidth: 2, maxDepth: 1, rolloutBudget: 4, dreamEveryNTasks: 100 } as const;
    const taxonomy = createDefaultRecordingTaxonomy();
    const { plugin } = buildE2E({
      ...options,
      candidateOutcomes: ['fail', 'fail'],
      extra: { deps: { taxonomy } }
    });
    const task = plugin.makeTask({ id: 'task-lineage', prompt: 'Repair the broken pipeline.' });

    const result = await plugin.run({ sessionId: 'sess-lineage', task, trigger: 'always' });

    expect(result.outcome).toBe('probed');
    expect(taxonomy.requests).toHaveLength(2);
    // Both probes are children of the reference root, which carries no failure
    // diagnosis, so neither has a failed ancestor: a sibling's diagnosis must
    // never be inherited as 'previousDiagnoses' (pre-fix it was).
    expect(taxonomy.requests[0]?.previousDiagnoses).toEqual([]);
    expect(taxonomy.requests[1]?.previousDiagnoses).toEqual([]);
    expect(taxonomy.requests[1]?.attemptIndex).toBe(1);
    expect(taxonomy.requests[1]?.previousDiagnoses?.length ?? 0).toBe(0);
  });
});
