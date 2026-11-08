/**
 * Tests for the rev8 pareto budget-attainment reward (plan §6.1 P2).
 *
 * The golden case is the upstream dream-rsi numerical test
 * tests/test_learning.py:213-248 (test_pareto_reward_penalizes_serial_replay):
 * two traces with equal attainment/work curves must score the same AUC, the
 * worker-friendly one a 0.5 sequential penalty, the serial one 1.0, and the
 * weighted reward must order them correctly. Boundary cases pin the
 * normalization and the skip rules against upstream eval.py:463-595.
 */

import { describe, expect, it } from 'vitest';

import {
  batchesToSequentialRounds,
  computeParetoReward,
  DEFAULT_SEQUENTIAL_PENALTY_WEIGHT,
  MIN_EVALUATED_NODES_FOR_AUC,
  resolveSequentialPenaltyWeight,
  traceBudgetAttainmentAuc,
  type ParetoPointInput,
  type ParetoTraceInput
} from '../../../src/dream-rsi/pareto-reward';

/** Upstream golden grid: one toy trace probed at two betas. */
function goldenGrid(
  rounds: readonly [number, number]
): readonly ParetoPointInput[] {
  return [
    { rho: 0, budget: 2, best: 0.5, effectiveSequentialRounds: rounds[0] },
    { rho: 1, budget: 4, best: 1.0, effectiveSequentialRounds: rounds[1] }
  ];
}

function goldenTrace(rounds: readonly [number, number]): ParetoTraceInput {
  return {
    treeId: 'toy',
    runBest: 1.0,
    evaluatedNodes: 4,
    points: goldenGrid(rounds)
  };
}

describe('traceBudgetAttainmentAuc (upstream _trace_auc port)', () => {
  it('scores the early-ceiling curve high and the exhaustive curve zero', () => {
    // Reaching the ceiling with 1 of 4 probes dominates 3/4 of the reference
    // rectangle -> 0.75; spending the full exhaustive budget -> 0.
    const early = traceBudgetAttainmentAuc(
      [{ rho: 0.5, budget: 1, best: 1.0 }],
      1.0,
      4
    );
    expect(early.auc).toBeCloseTo(0.75, 12);
    const exhaustive = traceBudgetAttainmentAuc(
      [{ rho: 0.5, budget: 4, best: 1.0 }],
      1.0,
      4
    );
    expect(exhaustive.auc).toBeCloseTo(0, 12);
  });

  it('keeps only the non-dominated frontier (cheapest budget per attainment)', () => {
    const { auc, frontier } = traceBudgetAttainmentAuc(
      [
        { rho: 0, budget: 2, best: 0.5 },
        { rho: 0.5, budget: 2, best: 0.25 },
        { rho: 1, budget: 4, best: 1.0 }
      ],
      1.0,
      4
    );
    expect(frontier).toEqual([
      { rho: 0, budget: 2, attain: 0.5 },
      { rho: 1, budget: 4, attain: 1 }
    ]);
    // (0.5-0)*(4-2) + (1-0.5)*(4-4) = 1 -> /4 = 0.25
    expect(auc).toBeCloseTo(0.25, 12);
  });

  it('normalizes attainment by the trace own ceiling and clamps to [0, 1]', () => {
    // best above runBest clamps to 1; negative best clamps to 0.
    const { frontier } = traceBudgetAttainmentAuc(
      [
        { rho: 0, budget: 1, best: 5 },
        { rho: 1, budget: 2, best: -1 }
      ],
      0.8,
      4
    );
    expect(frontier).toEqual([{ rho: 0, budget: 1, attain: 1 }]);
  });

  it('returns zero for a zero reference, a non-positive ceiling or no points', () => {
    expect(traceBudgetAttainmentAuc([{ rho: 0, budget: 1, best: 1 }], 1, 0).auc).toBe(0);
    expect(traceBudgetAttainmentAuc([{ rho: 0, budget: 1, best: 1 }], 0, 4).auc).toBe(0);
    expect(traceBudgetAttainmentAuc([], 1, 4).auc).toBe(0);
  });

  it('never lets a late worse point erase an earlier frontier point', () => {
    // budget 3 reaches 0.25 after budget 1 reached 0.5: the frontier keeps
    // (1, 0.5) and drops (3, 0.25).
    const { frontier } = traceBudgetAttainmentAuc(
      [
        { rho: 0, budget: 1, best: 0.5 },
        { rho: 0.5, budget: 3, best: 0.25 }
      ],
      1.0,
      4
    );
    expect(frontier).toEqual([{ rho: 0, budget: 1, attain: 0.5 }]);
  });
});

describe('batchesToSequentialRounds (upstream worker-capped rounds)', () => {
  it('sums ceil(batch / maxParallelism) over batches', () => {
    // Upstream test_learning.py:258-261 identity with workers=2.
    expect(batchesToSequentialRounds([4, 3], 2)).toBe(4);
    expect(batchesToSequentialRounds([4, 3], 1)).toBe(7);
    expect(batchesToSequentialRounds([1, 1, 1], 10)).toBe(3);
  });

  it('treats non-positive parallelism as serial and skips empty batches', () => {
    expect(batchesToSequentialRounds([4, 3], 0)).toBe(7);
    expect(batchesToSequentialRounds([4, 0, -2], 2)).toBe(2);
    expect(batchesToSequentialRounds([], 4)).toBe(0);
  });
});

describe('computeParetoReward (upstream _pareto_summary port)', () => {
  it('golden case: equal AUC, penalty 0.5 vs 1.0, reward orders the parallel policy first', () => {
    // Numbers from tests/test_learning.py:239-247, recomputed by hand:
    // auc = (0.5-0)*(4-2)/4 = 0.25 for both; penalties 0.5 and 1.0 at lambda 0.2.
    const parallel = computeParetoReward([goldenTrace([1, 2])], {
      sequentialPenaltyWeight: 0.2
    });
    const serial = computeParetoReward([goldenTrace([2, 4])], {
      sequentialPenaltyWeight: 0.2
    });
    expect(parallel.auc).toBeCloseTo(0.25, 12);
    expect(serial.auc).toBeCloseTo(0.25, 12);
    expect(parallel.sequentialPenalty).toBeCloseTo(0.5, 12);
    expect(serial.sequentialPenalty).toBeCloseTo(1.0, 12);
    expect(parallel.reward).toBeCloseTo(0.25 - 0.2 * 0.5, 12);
    expect(typeof parallel.reward === 'number' && typeof serial.reward === 'number').toBe(true);
    if (typeof parallel.reward === 'number' && typeof serial.reward === 'number') {
      expect(parallel.reward).toBeGreaterThan(serial.reward);
    }
    expect(parallel.scoredTraces[0]?.frontier).toEqual([
      { rho: 0, budget: 2, attain: 0.5 },
      { rho: 1, budget: 4, attain: 1 }
    ]);
  });

  it('mean over traces of the AUC and of the penalty', () => {
    const summary = computeParetoReward(
      [goldenTrace([1, 2]), goldenTrace([2, 4])],
      { sequentialPenaltyWeight: 0.2 }
    );
    expect(summary.auc).toBeCloseTo(0.25, 12);
    expect(summary.sequentialPenalty).toBeCloseTo(0.75, 12);
  });

  it('skips traces with no measurable trade-off instead of scoring them 0', () => {
    const degenerate: ParetoTraceInput = {
      treeId: 'all-fail',
      runBest: 0,
      evaluatedNodes: 4,
      points: [{ rho: 0, budget: 2, best: 0 }]
    };
    const tiny: ParetoTraceInput = {
      treeId: 'one-node',
      runBest: 1,
      evaluatedNodes: MIN_EVALUATED_NODES_FOR_AUC - 1,
      points: [{ rho: 0, budget: 1, best: 1 }]
    };
    const summary = computeParetoReward([degenerate, tiny], {
      sequentialPenaltyWeight: 0.05
    });
    expect(summary.scoredTraces).toEqual([]);
    expect(summary.reward).toBe('unknown');
    expect(summary.auc).toBe(0);
    expect(summary.note).toContain('no trace');
    expect(summary.skippedTraces.map((entry) => entry.treeId)).toEqual(['all-fail', 'one-node']);
  });

  it('unknown rounds yield an unknown penalty and reward, never a fabricated 0/1', () => {
    const unmeasured: ParetoTraceInput = {
      treeId: 'legacy',
      runBest: 1,
      evaluatedNodes: 4,
      points: [
        { rho: 0, budget: 2, best: 0.5 },
        { rho: 1, budget: 4, best: 1.0 }
      ]
    };
    const summary = computeParetoReward([unmeasured], { sequentialPenaltyWeight: 0.05 });
    expect(summary.sequentialPenalty).toBe('unknown');
    expect(summary.reward).toBe('unknown');
    // The AUC is still scored from the budget-attainment curve.
    expect(summary.auc).toBeCloseTo(0.25, 12);
    expect(summary.note).toBeUndefined();
  });

  it('a partially instrumented set reports an unknown summary penalty', () => {
    const measured = goldenTrace([1, 2]);
    const unmeasured: ParetoTraceInput = {
      treeId: 'legacy',
      runBest: 1,
      evaluatedNodes: 4,
      points: [{ rho: 0, budget: 4, best: 1.0 }]
    };
    const summary = computeParetoReward([measured, unmeasured], {
      sequentialPenaltyWeight: 0.2
    });
    expect(summary.scoredTraces).toHaveLength(2);
    expect(typeof summary.scoredTraces[0]?.sequentialPenalty).toBe('number');
    expect(summary.scoredTraces[1]?.sequentialPenalty).toBe('unknown');
    // A mean over the instrumented subset would present its cost as the whole
    // policy's cost - refused.
    expect(summary.sequentialPenalty).toBe('unknown');
    expect(summary.reward).toBe('unknown');
    expect(summary.auc).toBeCloseTo((0.25 + 0) / 2, 12);
  });

  it('penalty ignores rounds on zero-budget points but keeps the AUC', () => {
    const odd: ParetoTraceInput = {
      treeId: 'odd',
      runBest: 1,
      evaluatedNodes: 4,
      points: [
        { rho: 0, budget: 0, best: 0.5, effectiveSequentialRounds: 1 },
        { rho: 1, budget: 4, best: 1.0, effectiveSequentialRounds: 2 }
      ]
    };
    const summary = computeParetoReward([odd], { sequentialPenaltyWeight: 0.1 });
    // ratio only from the second point: 2/4 = 0.5
    expect(summary.sequentialPenalty).toBeCloseTo(0.5, 12);
  });

  it('weights: injected lambda is echoed; invalid values fall back to the default', () => {
    expect(resolveSequentialPenaltyWeight(0.3)).toBe(0.3);
    expect(resolveSequentialPenaltyWeight(undefined)).toBe(DEFAULT_SEQUENTIAL_PENALTY_WEIGHT);
    expect(resolveSequentialPenaltyWeight(Number.NaN)).toBe(DEFAULT_SEQUENTIAL_PENALTY_WEIGHT);
    expect(resolveSequentialPenaltyWeight(-1)).toBe(DEFAULT_SEQUENTIAL_PENALTY_WEIGHT);
    const summary = computeParetoReward([goldenTrace([1, 2])], {
      sequentialPenaltyWeight: 0.3
    });
    expect(summary.sequentialPenaltyWeight).toBe(0.3);
  });

  it('zero lambda makes the reward the pure mean AUC', () => {
    const summary = computeParetoReward([goldenTrace([2, 4])], {
      sequentialPenaltyWeight: 0
    });
    expect(summary.sequentialPenalty).toBeCloseTo(1, 12);
    expect(summary.reward).toBeCloseTo(0.25, 12);
  });
});
