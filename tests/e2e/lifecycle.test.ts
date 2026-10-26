import { describe, expect, it } from 'vitest';
import {
  EVO_HARNESS_STAGES,
  autoFallbackRequested,
  resolvePreviousFailure
} from '../../src/orchestrator';
import type {
  FailureCategory,
  FailureDiagnosis,
  ISurrogateScorer,
  SurrogateScore,
  SurrogateScoreRequest
} from '../../src/types/contracts';
import { createCordisSeamManager, createInMemoryCordisHost } from '../../src/cordis-seams';
import { createEvoHarnessPlugin } from '../../src/index';
import { resolveExecutionProfile } from '../../src/runtime/execution-profile';
import {
  buildE2E,
  createDefaultRecordingTaxonomy,
  createRecordingPolicy,
  createScriptedModel,
  createScriptedRunner,
  createSequencedTaxonomy,
  createThrowingRollbackSeams,
  e2eConfig,
  makeClock,
  makeIdFactory,
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
    // t10/R2 + t12/R2-residual: this suite asserts the governed-commit machinery
    // end to end (lessonsCommitted against the in-memory mock backend), so the
    // assembly explicitly opts in on the memory PERMISSION half. The default
    // assembly never calls the memory bridge at all (the denial is enforced at
    // the call site) and is pinned by the t12/R2-residual negative regression in
    // tests/unit/p62/release-contract.test.ts.
    const { plugin, runner } = buildE2E({
      extra: { deps: { executionProfile: resolveExecutionProfile({ memoryRealWrites: true }) } }
    });
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

    // P6.2 C1 (ADR 0002 R2/t6): the default assembly does NOT permanently
    // mount the winning scaffold (patch layer denied). The composition still
    // selects and reports the winner (see the shadow no-mount regression
    // below); here we assert the documented stage order survives unchanged.
    expect(result.metadata?.appliedPatchId).toBeUndefined();
    expect(plugin.orchestrator.activePatchIds()).toEqual([]);
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

  it('keeps a repairable failure schedulable after a later non-repairable sibling', async () => {
    const options = { maxWidth: 2, maxDepth: 2, rolloutBudget: 6, dreamEveryNTasks: 100 } as const;
    const policy = createRecordingPolicy(options, { stopCondition: 'max_depth' });
    const { plugin } = buildE2E({
      ...options,
      // slot 0 fails repairably (tool_error), slot 1 fails weakly (timeout)
      candidateOutcomes: ['fail', 'weak'],
      extra: { deps: { policy } }
    });

    const result = await plugin.run({
      sessionId: 'sess-precedence',
      task: plugin.makeTask({ id: 'task-precedence', prompt: 'Repair the broken pipeline.' }),
      trigger: 'always'
    });

    expect(result.probesRun).toBeGreaterThanOrEqual(2);
    expect(policy.selectBatchRequests.length).toBeGreaterThanOrEqual(2);
    const second = policy.selectBatchRequests[1];
    // the later weak_underexplored diagnosis must not hide the repairable failure
    expect(second?.previousFailure?.category).toBe('repairable_implementation');
    expect(second?.previousFailure?.repairable).toBe(true);

    const recoverSlot = policy.batchPlans[1]?.slots.find((slot) => slot.slot === 'recover');
    expect(recoverSlot).toBeDefined();
    expect(recoverSlot?.repairOfNodeId).toBeDefined();
  });

  it('still stops on a terminal diagnosis when a repairable sibling failed first', async () => {
    const options = { maxWidth: 2, maxDepth: 2, rolloutBudget: 6, dreamEveryNTasks: 100 } as const;
    const policy = createRecordingPolicy(options, { stopCondition: 'max_depth' });
    const { plugin } = buildE2E({
      ...options,
      // slot 0 repairable, slot 1 terminal (model refusal -> hard_unrecoverable)
      candidateOutcomes: ['fail', 'hard'],
      extra: { deps: { policy } }
    });

    const result = await plugin.run({
      sessionId: 'sess-terminal',
      task: plugin.makeTask({ id: 'task-terminal', prompt: 'Repair the broken pipeline.' }),
      trigger: 'always'
    });

    expect(result.metadata?.stopReason).toBe('failure_taxonomy:hard_unrecoverable');
    expect(policy.batchPlans).toHaveLength(1);
  });

  it('replaces the permanent scaffold instead of stacking it across runs (opt-in patch layer)', async () => {
    // P6.2 C1 (ADR 0002 R2/t6): the permanent mount now requires the patch
    // permission - guarded-active + execution.applyWinningPatch. This suite
    // exercises the rollback/replace machinery on the EXPLICIT opt-in, while
    // the default assembly is covered by the no-mount regression below.
    const host = createInMemoryCordisHost();
    const { plugin } = buildE2E({
      host,
      dreamEveryNTasks: 100,
      config: { execution: { mode: 'guarded-active', applyWinningPatch: true } }
    });
    const task = plugin.makeTask({ id: 'task-replace', prompt: 'Fix the failing build.' });

    const first = await plugin.run({ sessionId: 'sess-replace', task, trigger: 'always' });
    expect(first.outcome).toBe('composed');
    expect(first.composedPatchId).toBeDefined();
    expect(plugin.orchestrator.activePatchIds()).toEqual([first.composedPatchId]);
    const activeAfterFirst = host.activeEffects().length;
    expect(activeAfterFirst).toBe(1);

    const second = await plugin.run({ sessionId: 'sess-replace', task, trigger: 'always' });
    expect(second.outcome).toBe('composed');
    expect(second.composedPatchId).not.toBe(first.composedPatchId);

    // exactly one live scaffold, and the previous run's mounts are gone
    expect(plugin.orchestrator.activePatchIds()).toEqual([second.composedPatchId]);
    expect(host.activeEffects().length).toBe(1);
    expect(
      host.effects.filter(
        (effect) => effect.active && effect.namespace.indexOf(first.composedPatchId ?? '') >= 0
      )
    ).toEqual([]);
  });

  it('default assembly never permanently mounts the winning patch (shadow, C1)', async () => {
    // ADR 0002 R1/R2 (t6): the default assembly is baseline execution + shadow
    // records with ZERO side effects - no applyPatch, no publish, no real
    // memory write. The composed winner is still selected and reported; it is
    // simply not mounted.
    const host = createInMemoryCordisHost();
    const { plugin } = buildE2E({ host, dreamEveryNTasks: 100 });
    const task = plugin.makeTask({ id: 'task-shadow-nomount', prompt: 'Fix the failing build.' });

    const result = await plugin.run({ sessionId: 'sess-nomount', task, trigger: 'always' });
    expect(result.outcome).toBe('composed');
    // P6.2 C1: without the patch permission the winner is NOT mounted, so no
    // applied/composed patch id is reported as applied.
    expect(result.composedPatchId).toBeUndefined();
    expect(result.metadata?.appliedPatchId).toBeUndefined();
    // NOTHING is permanently mounted, nothing rolled back, no host effects.
    expect(plugin.orchestrator.activePatchIds()).toEqual([]);
    expect(host.activeEffects().length).toBe(0);
    // The profile reports the fail-closed permission set.
    const profile = (plugin.orchestrator as unknown as {
      executionProfileSnapshot?: () => {
        mode: string;
        permissions: Record<string, { allowed: boolean }>;
      };
    }).executionProfileSnapshot?.();
    expect(profile).toBeDefined();
    expect(profile?.mode).toBe('shadow');
    expect(profile?.permissions['patch']?.allowed).toBe(false);
    expect(profile?.permissions['publish']?.allowed).toBe(false);
    expect(profile?.permissions['memory']?.allowed).toBe(false);
  });

  it('records a throwing patch rollback as a diagnostic without aborting the run (opt-in patch layer)', async () => {
    const host = createInMemoryCordisHost();
    const now = makeClock();
    const seams = createCordisSeamManager({
      host,
      namespacePrefix: 'harness2',
      now,
      createBranchId: makeIdFactory('br-throw')
    });
    const throwing = createThrowingRollbackSeams(seams);
    const { plugin } = buildE2E({
      host,
      dreamEveryNTasks: 100,
      extra: { deps: { seams: throwing } },
      config: { execution: { mode: 'guarded-active', applyWinningPatch: true } }
    });
    const task = plugin.makeTask({ id: 'task-throwing', prompt: 'Fix the failing build.' });

    const first = await plugin.run({ sessionId: 'sess-throwing', task, trigger: 'always' });
    expect(first.outcome).toBe('composed');
    expect(first.composedPatchId).toBeDefined();

    const second = await plugin.run({ sessionId: 'sess-throwing', task, trigger: 'always' });
    expect(second.outcome).toBe('composed');
    expect(throwing.rollbackFailures).toEqual([first.composedPatchId]);
    expect(second.diagnostics.join(' ')).toContain('failed to roll back permanent patch');
    expect(plugin.orchestrator.activePatchIds()).toEqual([second.composedPatchId]);
  });

  it('resolves sibling failures by category rank regardless of arrival order', () => {
    const ranked: readonly FailureCategory[] = [
      'hard_unrecoverable',
      'repeatedly_unpromising',
      'repairable_implementation',
      'weak_underexplored',
      'none'
    ];
    const diagnosisOf = (category: FailureCategory): FailureDiagnosis => ({
      category,
      confidence: 0.5,
      repairable: category === 'repairable_implementation',
      recommendedAction: category === 'hard_unrecoverable' ? 'stop' : 'explore_elsewhere',
      evidence: ['rank probe for ' + category],
      signals: []
    });

    for (const first of ranked) {
      for (const second of ranked) {
        const expected =
          ranked.indexOf(first) <= ranked.indexOf(second) ? first : second;
        // symmetric: the higher-ranked category wins whichever side it arrives on
        expect(resolvePreviousFailure(diagnosisOf(first), diagnosisOf(second)).category).toBe(
          expected
        );
        expect(resolvePreviousFailure(diagnosisOf(second), diagnosisOf(first)).category).toBe(
          expected
        );
      }
    }
  });

  it('stops on an earlier hard failure even when a later sibling reports repeatedly_unpromising', async () => {
    const options = { maxWidth: 2, maxDepth: 3, rolloutBudget: 12, dreamEveryNTasks: 100 } as const;
    const policy = createRecordingPolicy(options, { stopCondition: 'max_depth' });
    const { plugin } = buildE2E({
      ...options,
      candidateOutcomes: ['fail', 'fail', 'fail', 'fail'],
      extra: {
        deps: {
          policy,
          // slot 0 -> hard_unrecoverable, slot 1 -> repeatedly_unpromising
          taxonomy: createSequencedTaxonomy([
            { category: 'hard_unrecoverable' },
            { category: 'repeatedly_unpromising' }
          ])
        }
      }
    });

    const result = await plugin.run({
      sessionId: 'sess-hard-first',
      task: plugin.makeTask({ id: 'task-hard-first', prompt: 'Repair the broken pipeline.' }),
      trigger: 'always'
    });

    expect(result.metadata?.stopReason).toBe('failure_taxonomy:hard_unrecoverable');
    expect(policy.batchPlans).toHaveLength(1);
  });

  it('stops on a later hard failure after an earlier repeatedly_unpromising sibling', async () => {
    const options = { maxWidth: 2, maxDepth: 3, rolloutBudget: 12, dreamEveryNTasks: 100 } as const;
    const policy = createRecordingPolicy(options, { stopCondition: 'max_depth' });
    const { plugin } = buildE2E({
      ...options,
      candidateOutcomes: ['fail', 'fail', 'fail', 'fail'],
      extra: {
        deps: {
          policy,
          // slot 0 -> repeatedly_unpromising, slot 1 -> hard_unrecoverable
          taxonomy: createSequencedTaxonomy([
            { category: 'repeatedly_unpromising' },
            { category: 'hard_unrecoverable' }
          ])
        }
      }
    });

    const result = await plugin.run({
      sessionId: 'sess-hard-last',
      task: plugin.makeTask({ id: 'task-hard-last', prompt: 'Repair the broken pipeline.' }),
      trigger: 'always'
    });

    expect(result.metadata?.stopReason).toBe('failure_taxonomy:hard_unrecoverable');
    expect(policy.batchPlans).toHaveLength(1);
  });

  it('does not let a repairable sibling mask an earlier hard failure', async () => {
    const options = { maxWidth: 2, maxDepth: 3, rolloutBudget: 12, dreamEveryNTasks: 100 } as const;
    const policy = createRecordingPolicy(options, { stopCondition: 'max_depth' });
    const { plugin } = buildE2E({
      ...options,
      candidateOutcomes: ['fail', 'fail', 'fail', 'fail'],
      extra: {
        deps: {
          policy,
          // slot 0 -> hard_unrecoverable, slot 1 -> repairable_implementation
          taxonomy: createSequencedTaxonomy([
            { category: 'hard_unrecoverable' },
            { category: 'repairable_implementation', repairable: true }
          ])
        }
      }
    });

    const result = await plugin.run({
      sessionId: 'sess-hard-then-repairable',
      task: plugin.makeTask({ id: 'task-hard-then-repairable', prompt: 'Repair the broken pipeline.' }),
      trigger: 'always'
    });

    expect(result.metadata?.stopReason).toBe('failure_taxonomy:hard_unrecoverable');
    expect(policy.batchPlans).toHaveLength(1);
  });

  it('recomputes the post-compose best node instead of keeping a phantom pre-compose score', async () => {
    const options = { maxWidth: 2, maxDepth: 2, rolloutBudget: 8, dreamEveryNTasks: 100 } as const;
    const policy = createRecordingPolicy(options, { stopCondition: 'max_depth' });
    const now = makeClock();
    // Injected scorer: without a composition the FIRST scored candidate carries the
    // phantom +0.4 selection bonus (0.9 vs 0.2); with the composition the SECOND one
    // holds the best final score (0.8 vs 0.1). The phantom 0.9 stays above every
    // final score, so the in-round best and the final best point at different nodes.
    const scoredOrder: string[] = [];
    const fakeScorer: ISurrogateScorer = {
      score(request: SurrogateScoreRequest): SurrogateScore {
        if (!scoredOrder.includes(request.node.id)) {
          scoredOrder.push(request.node.id);
        }
        const position = scoredOrder.indexOf(request.node.id);
        const composed = request.composition !== undefined;
        const score = composed ? (position === 0 ? 0.1 : 0.8) : position === 0 ? 0.9 : 0.2;
        return {
          nodeId: request.node.id,
          score,
          signals: {
            selected: composed,
            adoptionRatio: composed ? score : 0,
            stepEfficiency: 1,
            toolErrorRate: 0
          },
          weights: request.weights,
          computedAt: now(),
          evidence: ['fake scorer composed=' + String(composed)]
        };
      }
    };
    const { plugin } = buildE2E({ ...options, extra: { deps: { policy, scorer: fakeScorer } } });

    const result = await plugin.run({
      sessionId: 'sess-phantom',
      task: plugin.makeTask({ id: 'task-phantom', prompt: 'Improve the failing build.' }),
      trigger: 'always'
    });

    expect(scoredOrder.length).toBeGreaterThanOrEqual(2);
    const phantomBest = scoredOrder[0];
    const trueFinalBest = scoredOrder[1];
    expect(phantomBest).not.toBe(trueFinalBest);
    expect(policy.selectBatchRequests.length).toBeGreaterThanOrEqual(2);
    // the exploitation pointer must reflect the best FINAL score, not the phantom
    expect(policy.selectBatchRequests[1]?.previousBestNodeId).toBe(trueFinalBest);
    expect(result.probesRun).toBeGreaterThanOrEqual(2);
  });
});

describe('configuration enforcement', () => {
  /** Minimal host context: command + event registrars and a 10-seam adapter. */
  function makeHostContext(): {
    readonly ctx: Record<string, unknown>;
    readonly events: Map<string, (payload: unknown) => unknown>;
    readonly commands: Map<string, unknown>;
  } {
    const events = new Map<string, (payload: unknown) => unknown>();
    const commands = new Map<string, unknown>();
    const ctx: Record<string, unknown> = {
      registerCommand: (name: string, handler: unknown) => {
        commands.set(name, handler);
        return () => commands.delete(name);
      },
      on: (event: string, handler: (payload: unknown) => unknown) => {
        events.set(event, handler);
        return () => events.delete(event);
      },
      // a single seam is enough to make the adapter 'context'-derived
      prompt: { registerSegment: () => undefined },
      permissions: { register: () => undefined },
      tools: { patchDescriptions: () => undefined },
      skills: { mountDynamic: () => undefined },
      subagents: { register: () => undefined },
      middleware: { use: () => undefined },
      sandbox: { mountScript: () => undefined },
      evoMemory: { createScopedView: () => undefined },
      fork: () => ({ contextId: 'child' })
    };
    return { ctx, events, commands };
  }

  it('skips a run before planning when config.enabled is false', async () => {
    const now = makeClock();
    const plugin = createEvoHarnessPlugin(
      {
        config: e2eConfig({ config: { enabled: false } }),
        model: createScriptedModel(),
        clients: [mem0LikeServer().client],
        runBranch: createScriptedRunner(now),
        now,
        newId: makeIdFactory('disabled')
      },
      {}
    );

    const result = await plugin.run({
      sessionId: 'sess-disabled',
      task: plugin.makeTask({ id: 'task-disabled', prompt: 'Do nothing.' }),
      trigger: 'always'
    });

    expect(result.outcome).toBe('skipped');
    expect(result.probesRun).toBe(0);
    expect(result.lessonsCommitted).toBe(0);
    expect(result.diagnostics.join(' ')).toContain('config.enabled=false');
    // skipped before planning: no batch was ever planned
    expect(plugin.orchestrator.lastPlan()).toBeNull();
    expect(plugin.orchestrator.lastTrace()).toEqual(['finalize']);
  });

  it('skips an auto_fallback trigger under slash_command while /evo still runs', async () => {
    const { ctx, events, commands } = makeHostContext();
    const now = makeClock();
    const plugin = createEvoHarnessPlugin(
      {
        config: e2eConfig({ config: { triggerMode: 'slash_command' } }),
        model: createScriptedModel(),
        clients: [mem0LikeServer().client],
        runBranch: createScriptedRunner(now),
        now,
        newId: makeIdFactory('slash')
      },
      ctx
    );

    // auto-fallback listeners are never wired under slash_command
    expect(events.size).toBe(0);
    expect(plugin.registeredEvents).toEqual([]);
    expect(plugin.diagnostics.join(' ')).toContain('slash_command');
    // the manual /evo command is still registered and works
    expect([...commands.keys()]).toEqual(['evo']);

    const auto = await plugin.run({
      sessionId: 'sess-slash',
      task: plugin.makeTask({ id: 'task-slash', prompt: 'Fix it.' }),
      trigger: 'auto_fallback',
      metadata: { failureSignals: [{ kind: 'tool_error', message: 'exit 1' }] }
    });
    expect(auto.outcome).toBe('skipped');
    expect(auto.probesRun).toBe(0);
    expect(auto.diagnostics.join(' ')).toContain('slash_command');

    const explicit = await plugin.runFromCommand('Fix the failing build.');
    expect(explicit.outcome).toBe('composed');
    expect(explicit.trigger).toBe('slash_command');
  });

  it('still runs an auto_fallback trigger under triggerMode auto_fallback when blocked', async () => {
    const now = makeClock();
    const plugin = createEvoHarnessPlugin(
      {
        config: e2eConfig({ config: { triggerMode: 'auto_fallback' } }),
        model: createScriptedModel(),
        clients: [mem0LikeServer().client],
        runBranch: createScriptedRunner(now),
        now,
        newId: makeIdFactory('fallback')
      },
      {}
    );

    const blocked = await plugin.run({
      sessionId: 'sess-fallback',
      task: plugin.makeTask({ id: 'task-fallback', prompt: 'Recover the blocked task.' }),
      trigger: 'auto_fallback',
      metadata: { failureSignals: [{ kind: 'tool_error', message: 'exit 1' }] }
    });
    expect(blocked.outcome).toBe('composed');
    expect(blocked.probesRun).toBeGreaterThanOrEqual(2);

    // and an auto_fallback trigger with no blocking signal is still skipped
    const quiet = await plugin.run({
      sessionId: 'sess-fallback',
      task: plugin.makeTask({ id: 'task-fallback-quiet', prompt: 'Nothing failed.' }),
      trigger: 'auto_fallback'
    });
    expect(quiet.outcome).toBe('skipped');
    expect(quiet.probesRun).toBe(0);
    expect(quiet.diagnostics.join(' ')).toContain('no blocking signal');
  });
});
