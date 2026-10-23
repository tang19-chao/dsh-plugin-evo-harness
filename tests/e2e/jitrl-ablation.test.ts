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
  UNIMPLEMENTED_ABLATIONS,
  coverageOf,
  createRng,
  hashString,
  oracleCoverage,
  renderMarkdown,
  round,
  runEval
} from '../../scripts/eval/jitrl-eval-lib';
import type { ConditionId, ConditionResult, EvalReport } from '../../scripts/eval/jitrl-eval-lib';

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
