import { describe, expect, it } from 'vitest';
import { EVO_HARNESS_STAGES, autoFallbackRequested } from '../../src/orchestrator';
import { buildE2E, createScriptedRunner, mem0LikeServer } from './fixtures';

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
});
