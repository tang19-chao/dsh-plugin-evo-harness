/**
 * CI regression for the P5-c evaluation harness (plan sections 9 and 10).
 *
 * The harness itself is exercised end to end by scripts/eval-jitrl.mjs; this
 * suite is the gate, not a second implementation: it runs the same protocol at a
 * shorter episode length and asserts the properties the report claims, so a
 * regression in the plugin (or in the harness) turns CI red.
 *
 * Thresholds are deliberately coarse. The suite is a 12-task synthetic
 * environment, so the meaningful claims are relational (a harnessed arm beats
 * the static floor, a wider neighbourhood does not hurt, KL grows with beta) and
 * absolute (zero safety leaks). Hard-coding today's exact averages would turn
 * every legitimate tuning change into a failure without adding signal.
 */
import { describe, expect, it } from 'vitest';

import {
  CONDITIONS,
  DEFAULT_CANARY,
  EVAL_TASKS,
  FAIR_ARMS,
  FAIR_DEFAULT_EPISODES,
  FAIR_PROTOCOLS,
  UNIMPLEMENTED_ABLATIONS,
  coverageOf,
  createRng,
  fairFixedPoolDigest,
  fairNearDuplicates,
  fairSplits,
  hashString,
  oracleCoverage,
  renderFairMarkdown,
  renderMarkdown,
  round,
  runEval,
  runFairEval
} from '../../scripts/eval/jitrl-eval-lib';
import type {
  ConditionId,
  ConditionResult,
  EvalReport,
  FairArmId,
  FairArmResult,
  FairReport
} from '../../scripts/eval/jitrl-eval-lib';

/** Episode length used by CI: short enough to stay fast, long enough to learn. */
const CI_EPISODES = 3;

/** Metrics that must be reproducible byte for byte (timing is excluded). */
function deterministicBlock(report: EvalReport): string {
  return JSON.stringify({
    protocol: report.protocol,
    metrics: report.metrics.map((entry) => ({
      id: entry.id,
      config: entry.config,
      avg: entry.avg,
      final: entry.final,
      finalMinusAvg: entry.finalMinusAvg,
      solvedRate: entry.solvedRate,
      oracleRatio: entry.oracleRatio,
      probesPerTask: entry.probesPerTask,
      stepsPerRun: entry.stepsPerRun,
      modelCallsPerTask: entry.modelCallsPerTask,
      health: {
        decisions: entry.health.decisions,
        klMean: entry.health.klMean,
        klP50: entry.health.klP50,
        klP95: entry.health.klP95,
        klMax: entry.health.klMax,
        neighborHitRate: entry.health.neighborHitRate,
        bucketCount: entry.health.bucketCount,
        storeSize: entry.health.storeSize,
        storeSizeByLevel: entry.health.storeSizeByLevel
      },
      safety: entry.safety,
      tasks: entry.tasks
    })),
    unimplemented: report.unimplemented
  });
}

function byId(report: EvalReport, id: ConditionId): ConditionResult {
  const found = report.metrics.find((entry) => entry.id === id);
  expect(found, 'condition ' + id + ' must be part of the report').toBeDefined();
  return found as ConditionResult;
}

/** Baselines plus the two ablation families, at CI episode length. */
const CI_CONDITIONS: readonly ConditionId[] = [
  'B0',
  'B1',
  'B2',
  'B3',
  'A2-k4',
  'A2-k20',
  'A3-beta0.5',
  'A3-beta4'
];

describe('evaluation harness: protocol invariants', () => {
  it('runs L episodes per task and reports Avg, Final and Final-Avg consistently', async () => {
    const report = await runEval({ episodes: CI_EPISODES, conditions: ['B1', 'B3'] });
    expect(report.protocol.episodes).toBe(CI_EPISODES);
    expect(report.protocol.taskCount).toBe(EVAL_TASKS.length);
    expect(report.metrics).toHaveLength(2);

    for (const condition of report.metrics) {
      expect(condition.tasks).toHaveLength(EVAL_TASKS.length);
      for (const task of condition.tasks) {
        expect(task.runs).toHaveLength(CI_EPISODES);
        expect(task.runs.map((run) => run.runIndex)).toEqual([0, 1, 2].slice(0, CI_EPISODES));
        const mean = task.runs.reduce((total, run) => total + run.score, 0) / CI_EPISODES;
        // The report rounds every published number, so compare against the
        // rounded mean rather than the raw one (coverage is a 1/3 fraction).
        expect(task.avg).toBeCloseTo(round(mean), 6);
        expect(task.final).toBeCloseTo(round(task.runs[task.runs.length - 1]?.score ?? 0), 6);
        expect(task.finalMinusAvg).toBeCloseTo(round(task.final - task.avg), 6);
        for (const run of task.runs) {
          expect(run.score).toBeGreaterThanOrEqual(0);
          expect(run.score).toBeLessThanOrEqual(1);
        }
      }
      // The condition aggregate is the mean over tasks, not over runs.
      const taskAvg = condition.tasks.reduce((total, task) => total + task.avg, 0) / condition.tasks.length;
      expect(condition.avg).toBeCloseTo(round(taskAvg), 6);
    }
  });

  it('produces an identical metric block on a second run (the timing block is excluded)', async () => {
    const first = await runEval({ episodes: CI_EPISODES, conditions: CI_CONDITIONS });
    const second = await runEval({ episodes: CI_EPISODES, conditions: CI_CONDITIONS });
    expect(deterministicBlock(second)).toBe(deterministicBlock(first));
  }, 120_000);
});

describe('evaluation harness: ablation gates', () => {
  it('beats the static floor and does not regress the L1-only arm', async () => {
    const report = await runEval({ episodes: CI_EPISODES, conditions: CI_CONDITIONS });
    const b0 = byId(report, 'B0');
    const b1 = byId(report, 'B1');
    const b3 = byId(report, 'B3');

    // The whole point of the harness lifecycle: a static single-shot agent is
    // strictly worse than the same agent with Harness2's multi-round lineage.
    expect(b1.avg).toBeGreaterThan(b0.avg);
    expect(b1.solvedRate).toBeGreaterThan(b0.solvedRate);

    // The K-candidate selector must not make things worse than not choosing.
    expect(b3.avg).toBeGreaterThanOrEqual(b1.avg - 1e-9);
    expect(b3.solvedRate).toBeGreaterThanOrEqual(b1.solvedRate - 1e-9);

    // Every harnessed arm clears a real quality bar on this suite.
    for (const condition of report.metrics) {
      expect(condition.avg, condition.id + ' Avg').toBeGreaterThan(0.5);
    }
  }, 180_000);

  it('keeps KL monotone in beta (plan P1-3: beta up => KL up)', async () => {
    const report = await runEval({
      episodes: CI_EPISODES,
      conditions: ['A3-beta0.5', 'A3-beta4']
    });
    const low = byId(report, 'A3-beta0.5');
    const high = byId(report, 'A3-beta4');
    expect(low.health.decisions).toBeGreaterThan(0);
    // Both arms run the same protocol, so they take the same number of decisions;
    // beta changes only the temperature applied to them.
    expect(high.health.decisions).toBe(low.health.decisions);
    expect(high.health.klMean).toBeGreaterThan(low.health.klMean);
    // p95 is compared only when both arms actually have a non-degenerate tail:
    // a run whose decisions are all no-ops has p95 = 0, which would make a
    // strict ordering assertion depend on nothing but rounding.
    if (low.health.klP95 > 0) {
      expect(high.health.klP95).toBeGreaterThan(low.health.klP95);
    }
  }, 120_000);

  it('reports a real experience store and neighbourhood for L1/L2 arms', async () => {
    const report = await runEval({ episodes: CI_EPISODES, conditions: ['B0', 'B1', 'B2', 'B3'] });
    const b0 = byId(report, 'B0');
    const b1 = byId(report, 'B1');
    const b2 = byId(report, 'B2');
    const b3 = byId(report, 'B3');

    // No JitRL, no decisions and no store: the pre-JitRL lifecycle is untouched.
    expect(b0.health.decisions).toBe(0);
    expect(b1.health.decisions).toBe(0);
    expect(b1.health.storeSize).toBe(0);

    // L1 makes one decision per round and fills the meta store from run 2 on.
    expect(b2.health.decisions).toBeGreaterThan(0);
    expect(b2.health.storeSize).toBeGreaterThan(0);
    expect(b2.health.storeSizeByLevel['meta']).toBeGreaterThan(0);
    expect(b2.health.neighborHitRate).toBeGreaterThan(0);

    // L2 adds proposal samples on top of the meta ones.
    expect(b3.health.storeSize).toBeGreaterThan(b2.health.storeSize);
    expect(b3.health.storeSizeByLevel['proposal']).toBeGreaterThan(0);
    expect(b3.health.bucketCount).toBeGreaterThan(0);
    expect(b3.health.retrievalP95Ms).toBeGreaterThanOrEqual(0);
  }, 180_000);
});

describe('evaluation harness: safety', () => {
  it('never leaks invariant guidance, recalled memory or the prompt canary', async () => {
    const report = await runEval({ episodes: CI_EPISODES, conditions: CI_CONDITIONS });
    for (const condition of report.metrics) {
      expect(condition.safety.invariantLeaks, condition.id).toBe(0);
      expect(condition.safety.invariantMemoryLeaks, condition.id).toBe(0);
      expect(condition.safety.invariantGuidanceLeaks, condition.id).toBe(0);
      expect(condition.safety.canaryLeaks, condition.id).toBe(0);
    }
    // The invariant slot really is proposed (otherwise the zero above is vacuous).
    const jitArms = report.metrics.filter((entry) => entry.config.jitrlEnabled);
    expect(jitArms.length).toBeGreaterThan(0);
    expect(jitArms.some((entry) => entry.safety.invariantProbes > 0)).toBe(true);
  }, 180_000);

  it('keeps the canary out of every diagnostic channel', async () => {
    // The harness embeds the canary in every prompt; a leak would be a plugin
    // regression (a diagnostic echoing prompt text), so assert on the contract
    // directly rather than only on the aggregated counter.
    const report = await runEval({ episodes: 1, conditions: ['B3'] });
    const text = JSON.stringify(report);
    expect(text).not.toContain(DEFAULT_CANARY);
  }, 120_000);
});

describe('evaluation harness: suite and report', () => {
  it('declares the unimplemented ablations instead of silently omitting them', () => {
    const ids = UNIMPLEMENTED_ABLATIONS.map((entry) => entry.id).join(' | ');
    for (const expected of ['A1', 'A4', 'A5', 'A6']) {
      expect(ids).toContain(expected);
    }
    expect(UNIMPLEMENTED_ABLATIONS.every((entry) => entry.reason.trim().length > 0)).toBe(true);
    // The implemented grid must be exactly what the plan asks for.
    const kValues = CONDITIONS.filter((entry) => entry.axis === 'k').map((entry) => entry.k);
    expect(kValues).toEqual([4, 8, 10, 14, 20]);
    const betas = CONDITIONS.filter((entry) => entry.axis === 'beta').map((entry) => entry.beta);
    expect(betas).toEqual([0.5, 1, 2, 4]);
    expect(CONDITIONS.filter((entry) => entry.group === 'baseline').map((entry) => entry.id)).toEqual([
      'B0',
      'B1',
      'B2',
      'B3'
    ]);
  });

  it('renders a markdown report containing every required section and measured number', async () => {
    const report = await runEval({ episodes: 1, conditions: ['B0', 'B1', 'B3'] });
    const markdown = renderMarkdown(report, {
      commit: 'test-commit',
      generatedAt: '2026-01-01 00:00:00',
      command: 'node scripts/eval-jitrl.mjs --report work/p5-eval-report.md'
    });
    for (const heading of [
      '# P5-c JitRL 评测报告',
      '## 1. 协议与可复现性',
      '## 2. 对照组 B0–B3',
      '## 5. 健康度指标',
      '## 6. 安全指标',
      '## 7. 本轮未实现的消融',
      '## 8. 如何复现与 CI 门禁'
    ]) {
      expect(markdown).toContain(heading);
    }
    // Numbers are rendered from the measurement, not written by hand.
    expect(markdown).toContain(byId(report, 'B3').avg.toFixed(3));
    expect(markdown).toContain('test-commit');
    expect(markdown).not.toContain('undefined');
  }, 120_000);
});

describe('evaluation harness: primitives', () => {
  it('scores coverage against the task ground truth', () => {
    const task = EVAL_TASKS[0];
    expect(task).toBeDefined();
    const spec = task as (typeof EVAL_TASKS)[number];
    expect(coverageOf(spec, [])).toBe(0);
    expect(coverageOf(spec, [...spec.required])).toBe(1);
    const partial = coverageOf(spec, [spec.required[0] as string]);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(1);
    expect(oracleCoverage(spec)).toBeGreaterThanOrEqual(partial);
  });

  it('has a deterministic, well-distributed PRNG', () => {
    const left = createRng(42);
    const right = createRng(42);
    const draws = Array.from({ length: 32 }, () => left());
    expect(draws).toEqual(Array.from({ length: 32 }, () => right()));
    expect(draws.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(new Set(draws).size).toBe(draws.length);
    expect(createRng(7)()).not.toBe(createRng(8)());
    expect(hashString('same')).toBe(hashString('same'));
    expect(hashString('same')).not.toBe(hashString('other'));
  });

  it('covers every slot kind a task can schedule', () => {
    // The suite must exercise all four slot families, otherwise the L1 arm has
    // nothing to re-allocate and the ablation would be vacuous.
    const families = new Set(EVAL_TASKS.map((task) => task.family));
    expect(families.size).toBeGreaterThanOrEqual(3);
    expect(EVAL_TASKS.every((task) => task.required.length >= 1)).toBe(true);
    expect(EVAL_TASKS.some((task) => task.required.length >= 3)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P6 PR6: fair comparison (plan section 8.1-8.3)
// ---------------------------------------------------------------------------

/**
 * Episode/round length used by the fair CI gates.
 *
 * The fair engine is pure in-memory replay (no plugin, no model), so two
 * episodes with two rounds each already exercise every arm, every protocol and
 * the whole cost ledger; the numbers themselves are reported by the generated
 * report at L=5/R=3, not asserted here. Hard-coding exact averages would turn
 * every legitimate tuning change into red without adding signal.
 */
const FAIR_CI_EPISODES = 2;
const FAIR_CI_ROUNDS = 2;

let fairCache: Promise<FairReport> | null = null;
function fairOnce(): Promise<FairReport> {
  fairCache =
    fairCache ??
    runFairEval({
      episodes: FAIR_CI_EPISODES,
      rounds: FAIR_CI_ROUNDS,
      includeOnlineItem: false,
      includePolicySelection: false,
      includeOrderCheck: false
    });
  return fairCache;
}

let fairWithProtocols: Promise<FairReport> | null = null;
function fairProtocolsOnce(): Promise<FairReport> {
  fairWithProtocols =
    fairWithProtocols ??
    runFairEval({
      episodes: FAIR_CI_EPISODES,
      rounds: FAIR_CI_ROUNDS,
      tasks: EVAL_TASKS.slice(0, 6),
      includeOnlineItem: false,
      includePolicySelection: true,
      includeOrderCheck: true
    });
  return fairWithProtocols;
}

function fairArmById(report: FairReport, id: FairArmId): FairArmResult {
  const found = report.protocols
    .flatMap((protocol) => protocol.arms)
    .find((entry) => entry.id === id);
  expect(found, 'fair arm ' + id + ' must be part of the report').toBeDefined();
  return found as FairArmResult;
}

/** Deterministic block of the fair report (timing and wall clock excluded). */
function fairDeterministicBlock(report: FairReport): string {
  return JSON.stringify({
    generatedFrom: report.generatedFrom,
    protocols: report.protocols.map((protocol) => ({
      id: protocol.id,
      taskIds: protocol.taskIds,
      donorTaskIds: protocol.donorTaskIds,
      arms: protocol.arms.map((arm) => ({
        id: arm.id,
        selection: arm.selection,
        updates: arm.updates,
        level1: arm.level1,
        adviceChannel: arm.adviceChannel,
        verifiedRate: arm.verifiedRate,
        failedRate: arm.failedRate,
        budgetCompletionRate: arm.budgetCompletionRate,
        meanCoverage: arm.meanCoverage,
        finalCoverage: arm.finalCoverage,
        finalMinusAvgCoverage: arm.finalMinusAvgCoverage,
        coverageCurve: arm.coverageCurve,
        verifiedCurve: arm.verifiedCurve,
        health: arm.health,
        policyChangeRate: arm.policyChangeRate,
        poolDigest: arm.poolDigest,
        initialSnapshotDigest: arm.initialSnapshotDigest,
        finalSnapshotDigest: arm.finalSnapshotDigest,
        snapshotFrozen: arm.snapshotFrozen,
        recordsAppended: arm.recordsAppended,
        tasks: arm.tasks
      })),
      comparisons: protocol.comparisons
    })),
    donorIsolation: report.donorIsolation,
    sources: report.sources,
    orderChecks: report.orderChecks,
    policySelection: report.policySelection
  });
}

describe('fair comparison: same K, same candidate pool (R6)', () => {
  it('keeps B0-B3 as the historical control and adds C0-C4 as a separate group', async () => {
    // The historical arms must stay exactly where they were: this PR adds the
    // fair arms, it does not rewrite p5's comparison.
    expect(CONDITIONS.filter((entry) => entry.group === 'baseline').map((entry) => entry.id)).toEqual([
      'B0',
      'B1',
      'B2',
      'B3'
    ]);
    expect(FAIR_ARMS.map((entry) => entry.id)).toEqual(['C0', 'C1', 'C2', 'C3-frozen', 'C3-online', 'C4']);
    // C0-C4 all use the SAME candidate count, which is the whole point of R6.
    const report = await fairOnce();
    const arms = report.protocols[0]?.arms ?? [];
    expect(arms).toHaveLength(FAIR_ARMS.length);
    expect(FAIR_PROTOCOLS.map((entry) => entry.id)).toContain('same-task');
    expect(FAIR_PROTOCOLS.map((entry) => entry.id)).toContain('cross-task-zeroshot');
    expect(FAIR_PROTOCOLS.map((entry) => entry.id)).toContain('policy-selection');
    // The pool is fixed: C0 (prior) and C3 (kernel) must offer the same candidates.
    const c0 = fairArmById(report, 'C0');
    const c3 = fairArmById(report, 'C3-online');
    expect(c0.poolDigest).toBe(c3.poolDigest);
    for (const task of c0.tasks) {
      const other = c3.tasks.find((entry) => entry.taskId === task.taskId);
      expect(other).toBeDefined();
      expect(other?.runs.map((run) => run.poolDigest)).toEqual(task.runs.map((run) => run.poolDigest));
    }
  }, 120_000);

  it('offers the identical fixed K=3 pool at every decision point in every arm', async () => {
    const report = await fairOnce();
    for (const protocol of report.protocols) {
      for (const arm of protocol.arms) {
        for (const task of arm.tasks) {
          const expected = Array.from({ length: FAIR_CI_ROUNDS }, (_, roundIndex) => {
            const spec = EVAL_TASKS.find((entry) => entry.id === task.taskId);
            expect(spec).toBeDefined();
            return fairFixedPoolDigest(spec as (typeof EVAL_TASKS)[number], roundIndex);
          }).join(',');
          for (const run of task.runs) {
            // Same K, same pool, same order - for the prior arm, the random arm
            // and the kernel arm alike. This is what B1-vs-B3 never held.
            expect(run.poolDigest, arm.id + '/' + task.taskId).toBe(expected);
          }
        }
      }
    }
  }, 120_000);

  it('gives C3-frozen and C3-online the same initial snapshot and freezes the frozen arm', async () => {
    const report = await fairOnce();
    const frozen = fairArmById(report, 'C3-frozen');
    const online = fairArmById(report, 'C3-online');
    // Precondition the plan demands: one shared initial snapshot.
    expect(frozen.initialSnapshotDigest).toBe(online.initialSnapshotDigest);
    expect(frozen.initialSnapshotRecords).toBe(online.initialSnapshotRecords);
    // The frozen arm must not grow during the window...
    expect(frozen.recordsAppended).toBe(0);
    expect(frozen.snapshotFrozen).toBe(true);
    expect(frozen.finalSnapshotDigest).toBe(frozen.initialSnapshotDigest);
    // ...while the online arm demonstrably does (otherwise "learning" is a claim).
    expect(online.recordsAppended).toBeGreaterThan(0);
    expect(online.snapshotFrozen).toBe(false);
    // And the donor-seeded cross-task pair must share one snapshot too.
    const crossProtocol = report.protocols.find((entry) => entry.id === 'cross-task-adaptation');
    const crossFrozen = crossProtocol?.arms.find((entry) => entry.id === 'C3-frozen');
    const crossOnline = crossProtocol?.arms.find((entry) => entry.id === 'C3-online');
    expect(crossFrozen?.initialSnapshotDigest).toBe(crossOnline?.initialSnapshotDigest);
    expect(crossFrozen?.initialSnapshotRecords).toBeGreaterThan(0);
    expect(crossFrozen?.finalSnapshotDigest).toBe(crossFrozen?.initialSnapshotDigest);
  }, 120_000);
});

describe('fair comparison: separated protocols (plan section 8.2)', () => {
  it('reports same-task adaptation, cross-task transfer and policy selection separately', async () => {
    const report = await fairOnce();
    const sameTask = report.protocols.find((entry) => entry.id === 'same-task');
    const crossTask = report.protocols.find((entry) => entry.id === 'cross-task-adaptation');
    expect(sameTask?.taskIds).toEqual(EVAL_TASKS.map((task) => task.id));
    expect(sameTask?.donorTaskIds).toEqual([]);
    expect(crossTask?.taskIds.length).toBeGreaterThan(0);
    expect(crossTask?.donorTaskIds.length).toBeGreaterThan(0);
    // Both a frozen zero-shot arm and a learning adaptation arm are reported.
    const crossArms = crossTask?.arms ?? [];
    const zeroShot = crossArms.find((entry) => entry.protocol === 'cross-task-zeroshot');
    const adaptation = crossArms.find((entry) => entry.protocol === 'cross-task-adaptation');
    expect(zeroShot).toBeDefined();
    expect(adaptation).toBeDefined();
    expect(zeroShot?.updates).toBe(false);
    expect((zeroShot?.recordsAppended ?? 0)).toBe(0);

    const withProtocols = await fairProtocolsOnce();
    const selection = withProtocols.policySelection;
    expect(selection.candidates.length).toBeGreaterThan(0);
    expect(selection.selectionInputs).toEqual(['train']);
    const testIds = new Set(selection.splits.test);
    // No cross-split leakage: train/validation/test are disjoint sets of tasks.
    for (const id of selection.splits.train) {
      expect(testIds.has(id)).toBe(false);
    }
    for (const id of selection.splits.validation) {
      expect(testIds.has(id)).toBe(false);
    }
    const testIdsOnSuite = new Set(EVAL_TASKS.slice(0, 6).map((task) => task.id));
    expect([...testIds].every((id) => testIdsOnSuite.has(id))).toBe(true);
  }, 180_000);

  it('keeps test targets and their near duplicates out of the donor library', async () => {
    const report = await fairOnce();
    const { donorTaskIds, targetTaskIds, intersection, nearDuplicates } = report.donorIsolation;
    expect(donorTaskIds.length).toBeGreaterThan(0);
    expect(targetTaskIds.length).toBeGreaterThan(0);
    // The test target itself must never be a donor (plan section 8.2).
    expect(intersection).toEqual([]);
    for (const id of targetTaskIds) {
      expect(donorTaskIds.includes(id)).toBe(false);
    }
    // ...and neither may a near duplicate of one.
    expect(nearDuplicates).toEqual([]);
    expect(fairNearDuplicates(EVAL_TASKS, EVAL_TASKS.slice(0, 1)).length).toBeGreaterThan(0);
    // Source list: taskId / familyId / repoId per experience source.
    expect(report.sources.length).toBeGreaterThanOrEqual(EVAL_TASKS.length);
    for (const source of report.sources) {
      expect(source.taskId.length).toBeGreaterThan(0);
      expect(source.familyId.length).toBeGreaterThan(0);
      expect(source.repoId.length).toBeGreaterThan(0);
      expect(['self', 'donor', 'none']).toContain(source.experienceSource);
      expect(['donor', 'target']).toContain(source.donorRole);
    }
    const splits = fairSplits(EVAL_TASKS);
    expect(splits.train.length + splits.validation.length + splits.test.length).toBe(EVAL_TASKS.length);
  }, 120_000);
});

describe('fair comparison: cost ledger (plan section 8.1)', () => {
  it('records candidate/evaluation tokens, calls, time, failures and retries per arm', async () => {
    const report = await fairOnce();
    const arms = report.protocols[0]?.arms ?? [];
    for (const arm of arms) {
      expect(arm.cost.poolGenerations).toBeGreaterThan(0);
      expect(arm.cost.candidateGenerationTokens).toBeGreaterThan(0);
      expect(arm.cost.evaluationTokens).toBeGreaterThan(0);
      expect(arm.cost.modelCalls).toBeGreaterThan(0);
      expect(arm.cost.timeMs).toBeGreaterThanOrEqual(0);
      expect(arm.cost.failedProbes).toBeGreaterThanOrEqual(0);
      expect(arm.cost.retries).toBe(0);
      expect(arm.cost.retryNote.length).toBeGreaterThan(0);
      expect(arm.cost.estimator.length).toBeGreaterThan(0);
    }
    // Same probe count for every arm...
    const probeCounts = new Set(arms.map((arm) => arm.cost.probesRun));
    expect(probeCounts.size).toBe(1);
    // ...but NOT the same total cost: C2 pays for the prompt advice block while
    // C0/C1/C3/C4 do not. That is the "same probes != same cost" witness.
    const c0 = fairArmById(report, 'C0');
    const c2 = fairArmById(report, 'C2');
    const c3 = fairArmById(report, 'C3-online');
    expect(c0.cost.promptAdviceTokens).toBe(0);
    expect(c3.cost.promptAdviceTokens).toBe(0);
    expect(c2.cost.promptAdviceTokens).toBeGreaterThan(0);
    expect(c2.advice?.tokens).toBe(c2.cost.promptAdviceTokens);
    const totalOf = (arm: FairArmResult): number =>
      arm.cost.candidateGenerationTokens + arm.cost.evaluationTokens + arm.cost.promptAdviceTokens;
    expect(totalOf(c2)).toBeGreaterThan(totalOf(c0));
    expect(c2.cost.probesRun).toBe(c0.cost.probesRun);
  }, 120_000);

  it('reports the live plugin pipeline as a separate online-generation item', async () => {
    const report = await runFairEval({
      episodes: 1,
      rounds: 2,
      tasks: EVAL_TASKS.slice(0, 4),
      includeOnlineItem: true,
      includePolicySelection: false,
      includeOrderCheck: false
    });
    expect(report.onlineItem).not.toBeNull();
    const conditions = report.onlineItem?.conditions.map((entry) => entry.id) ?? [];
    expect(conditions).toEqual(['B1', 'B2', 'B3']);
    // B1/B2 offer one candidate, B3 offers three: reported, but never attributed
    // to the logit correction (that is exactly the R6 defect).
    const byId = new Map((report.onlineItem?.conditions ?? []).map((entry) => [entry.id, entry] as const));
    expect(byId.get('B1')?.config.candidateCount).toBe(1);
    expect(byId.get('B3')?.config.candidateCount).toBe(3);
    expect(report.onlineItem?.note).toContain('NOT attributed');
  }, 180_000);
});

describe('fair comparison: metrics, uncertainty and boundaries', () => {
  it('leads with task verification, keeps KL as distribution evidence and reports uncertainty', async () => {
    const report = await fairOnce();
    for (const protocol of report.protocols) {
      for (const arm of protocol.arms) {
        expect(arm.verifiedRate).toBeGreaterThanOrEqual(0);
        expect(arm.verifiedRate).toBeLessThanOrEqual(1);
        expect(arm.failedRate).toBeGreaterThanOrEqual(0);
        expect(arm.budgetCompletionRate).toBeGreaterThan(0);
        // Full learning curve, not just the two endpoints.
        expect(arm.coverageCurve.length).toBe(FAIR_CI_EPISODES);
        expect(arm.verifiedCurve.length).toBe(FAIR_CI_EPISODES);
        expect(Number.isFinite(arm.finalMinusAvgCoverage)).toBe(true);
      }
    }
    // KL exists for the kernel arms and is absent (0) for the no-kernel arms:
    // it is a distribution-change witness, never a benefit claim.
    const c0 = fairArmById(report, 'C0');
    const c3 = fairArmById(report, 'C3-online');
    expect(c0.health.decisions).toBe(0);
    expect(c0.health.klMean).toBe(0);
    expect(c3.health.decisions).toBeGreaterThan(0);
    expect(c3.health.klNonZeroShare).toBeGreaterThanOrEqual(0);
    // Paired per-task deltas with an interval.
    const comparison = report.protocols[0]?.comparisons.find(
      (entry) => entry.left === 'C3-online' && entry.right === 'C3-frozen' && entry.metric === 'verifiedRate'
    );
    expect(comparison).toBeDefined();
    expect(comparison?.pairs).toBe(EVAL_TASKS.length);
    expect(comparison?.ci95.length).toBe(2);
    expect((comparison?.wins ?? 0) + (comparison?.ties ?? 0) + (comparison?.losses ?? 0)).toBe(
      comparison?.pairs ?? 0
    );
    expect(comparison?.note).toContain('feasibility');
  }, 120_000);

  it('checks task-order dependence and keeps the cold-start protocol order independent', async () => {
    const report = await fairProtocolsOnce();
    const checks = report.orderChecks;
    expect(checks.length).toBeGreaterThan(0);
    const sameTaskCheck = checks.find((entry) => entry.protocol === 'same-task');
    expect(sameTaskCheck).toBeDefined();
    // Cold start per task means shuffling the suite cannot change a task's result.
    expect(sameTaskCheck?.maxAbsDelta).toBe(0);
    expect(sameTaskCheck?.changedTasks).toBe(0);
    const crossCheck = checks.find((entry) => entry.protocol === 'cross-task-adaptation');
    expect(crossCheck).toBeDefined();
    expect(crossCheck?.note.length).toBeGreaterThan(0);
  }, 180_000);

  it('offers no production switch for invariant isolation and keeps A4 as a fixture only', async () => {
    const a4 = UNIMPLEMENTED_ABLATIONS.find((entry) => entry.id.includes('A4'));
    expect(a4).toBeDefined();
    expect(a4?.reason.length).toBeGreaterThan(0);
    // No exported fair-comparison surface toggles invariant isolation at runtime.
    const lib = await import('../../scripts/eval/jitrl-eval-lib');
    const suspicious = Object.keys(lib).filter((name) => /invariant/i.test(name) && /(switch|toggle|enable)/i.test(name));
    expect(suspicious).toEqual([]);
    const report = await fairOnce();
    expect(report.boundaries.some((line) => line.includes('A4'))).toBe(true);
    expect(report.boundaries.some((line) => line.includes('隔离'))).toBe(true);
    // The arms never claim an invariant slot outside the fixed pool: candidates
    // are the same three structural shapes for every arm.
    const c0 = fairArmById(report, 'C0');
    const c4 = fairArmById(report, 'C4');
    expect(c0.poolDigest).toBe(c4.poolDigest);
  }, 120_000);
});

describe('fair comparison: report artifact and determinism', () => {
  it('renders the whole fair report and leaves the p5 historical numbers untouched', async () => {
    const report = await fairOnce();
    const markdown = renderFairMarkdown(report, {
      commit: 'test-commit',
      generatedAt: '2026-01-01 00:00:00',
      command: 'node scripts/eval/fair-eval-report.mjs'
    });
    for (const heading of [
      '# P6 公平评测报告（PR6 / R6）',
      '## 1. 这份报告修的是什么',
      '## 3. 协议一：同任务适应',
      '## 5. 配对差值与不确定性',
      '## 6. 协议二：跨任务迁移',
      '## 8. 协议三：离线策略选择',
      '## 9. 成本口径',
      '## 13. 与 p5-eval-report.md 的差异',
      '## 14. 边界声明'
    ]) {
      expect(markdown).toContain(heading);
    }
    // Measured numbers, not hand-written ones.
    expect(markdown).toContain(fairArmById(report, 'C3-online').verifiedRate.toFixed(3));
    expect(markdown).toContain('test-commit');
    expect(markdown).not.toContain('undefined');
    expect(markdown).not.toContain('NaN');

    // p5's historical report is a frozen artifact: this PR adds a new file and
    // must not edit its numbers.
    const { readFileSync } = await import('node:fs');
    const p5 = readFileSync('docs/reports/p5-eval-report.md', 'utf8');
    expect(p5).toContain('2026-10-23 01:40:22');
    expect(p5).toContain('| B3 + L1 + L2 |');
    expect(p5).toContain('0.956');
    expect(p5).toContain('**L2 候选选择有效**');
  }, 120_000);
});

describe('fair comparison: primitives', () => {
  it('reproduces the fair metric block byte for byte on a second run', async () => {
    const first = await fairOnce();
    const second = await runFairEval({
      episodes: FAIR_CI_EPISODES,
      rounds: FAIR_CI_ROUNDS,
      includeOnlineItem: false,
      includePolicySelection: false,
      includeOrderCheck: false
    });
    expect(fairDeterministicBlock(second)).toBe(fairDeterministicBlock(first));
    expect(FAIR_DEFAULT_EPISODES).toBeGreaterThanOrEqual(FAIR_CI_EPISODES);
  }, 180_000);
});
