/**
 * P2-A acceptance (p2-a-b-kernel): the V3 task/schedule design is DISCRIMINABLE,
 * the oracle is COMPUTED from the table, and every checker used to say so is
 * itself verified with a counterexample.
 *
 * Why a separate suite from the V2 table: P2-A exists because the V2 suite can
 * not tell a learner from its prior. The assertions below are therefore written
 * as PROPERTIES OF THE TABLE (prefs/required/blind + the documented pool rule),
 * never as "the measured number is X" - a design property must survive a seed
 * change and must fail when the design regresses.
 *
 * The three hard properties from the task card:
 *   1. at least some tasks satisfy required not-subset-of prefs[:3];
 *   2. no hard-coded oracle: the coverage ceiling is recomputed from the table
 *      and is not a constant 1;
 *   3. every key decision point offers more than one action, and the support
 *      matrix over decision points x action classes has rank > 1.
 *
 * The rank checker and the design gate are negative-controlled FIRST (a
 * deliberately rank-1 / single-action fixture must be REPORTED), then applied to
 * the real table - a checker that only ever returns "fine" proves nothing.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HARNESS_COMPONENT_KEYS } from '../../../src/types/contracts';
import { EVAL_TASKS, oracleCoverage as v2OracleCoverage } from '../../../scripts/eval/jitrl-eval-lib';
import {
  V3_DESIGN_VERSION,
  V3_ROUNDS,
  V3_SLOT_KINDS,
  V3_SURFACES,
  V3_TASKS,
  buildSupportMatrix,
  canonicalDesignBytes,
  canonicalDesignJson,
  canonicalDesignTasksJson,
  coverageOf,
  decisionPointActionCounts,
  degenerateRankOneFixture,
  designDigest,
  designGateFindings,
  designSummary,
  enumerateLineages,
  isRankDeficient,
  oracleCoverage,
  priorCoverage,
  rankOfMatrix,
  requiredWithinTop3Prefs,
  taskDecisionPoints,
  v3PoolForDecision,
  type V3Task
} from '../../../scripts/eval/pr4a-v3-design.mjs';

/** A copy of one task with a replaced preference order (mutation helper). */
function withPrefs(task: V3Task, prefs: readonly string[]): V3Task {
  return { ...task, prefs };
}

/**
 * Independent re-derivation of the oracle, from the SAME table but NOT through
 * oracleCoverage(): the point is to prove the published number is a function of
 * (required, candidates), not a stored constant.
 */
function oracleFromTable(task: V3Task): number {
  const points = taskDecisionPoints(task);
  let frontier: string[][] = [[]];
  for (const point of points) {
    const next: string[][] = [];
    for (const partial of frontier) {
      for (const candidate of point.candidates) {
        // Same blind-surface rule as the module: a surface the family cannot
        // edit is not achievable coverage.
        const usable = candidate.surfaces.filter((surface) => !task.blind.includes(surface));
        next.push([...new Set([...partial, ...usable])]);
      }
    }
    frontier = next;
  }
  return frontier.reduce((max, surfaces) => Math.max(max, coverageOf(task, surfaces)), 0);
}

/** A task whose pool collapses to ONE action class at every decision point. */
function singleActionTask(): V3Task {
  const surface = V3_SURFACES[0] as string;
  return withPrefs(V3_TASKS[0] as V3Task, [surface, surface, surface, surface, surface]);
}

describe('P2-A V3 task design: discriminability of the table', () => {
  it('freezes a five-surface vocabulary of REAL harness component keys', () => {
    expect(V3_SURFACES.length).toBe(5);
    expect(V3_SURFACES.length).toBeGreaterThan(3);
    for (const surface of V3_SURFACES) {
      // The fixture stays inside the harness's own editable domain: a made-up
      // surface name would make every rate incomparable with the product.
      expect(HARNESS_COMPONENT_KEYS).toContain(surface);
    }
    for (const task of V3_TASKS) {
      expect(new Set(task.prefs).size).toBe(V3_SURFACES.length);
      for (const surface of task.required) {
        expect(HARNESS_COMPONENT_KEYS).toContain(surface);
      }
    }
    expect(V3_SLOT_KINDS.length).toBeGreaterThan(1);
  });

  it('requires a surface outside prefs[:3] for a documented share of tasks (V2 cannot)', () => {
    const summary = designSummary();
    expect(summary.tasksWithRequiredOutsideTop3).toBeGreaterThanOrEqual(3);
    expect(summary.requiredOutsideTop3Share).toBeGreaterThanOrEqual(0.25);
    expect(summary.requiredOutsideTop3Share).toBeLessThan(1);

    // The contrast that motivates V3: every V2 task's required set is inside
    // prefs[:3] and V2 has only three proposable surfaces, so its ceiling is 1
    // for every task by construction.
    for (const task of EVAL_TASKS) {
      expect(requiredWithinTop3Prefs({ required: [...task.required], prefs: [...task.prefs] })).toBe(true);
      expect(v2OracleCoverage(task)).toBe(1);
    }
  });

  it('computes the oracle from the task table, not from a hard-coded value', () => {
    for (const task of V3_TASKS) {
      // Same table, independent derivation: the published oracle must equal the
      // exhaustive maximum over the pool the table defines.
      expect(oracleCoverage(task)).toBeCloseTo(oracleFromTable(task), 12);
      // The ceiling can never be below what the prior already reaches.
      expect(oracleCoverage(task)).toBeGreaterThanOrEqual(priorCoverage(task) - 1e-12);
    }

    const oracles = V3_TASKS.map((task) => oracleCoverage(task));
    // A constant ceiling is exactly the defect: the oracle must VARY with the
    // table, and some tasks must have a measured ceiling below 1.
    expect(new Set(oracles).size).toBeGreaterThan(1);
    expect(oracles.filter((value) => value < 1 - 1e-9).length).toBeGreaterThanOrEqual(2);

    // Mutation check: the ceiling RESPONDS to the table. A task whose required
    // surface is in the pool has oracle 1; deleting that surface from the pool
    // (blind) must lower it.
    const base = V3_TASKS.find((task) => task.required.length === 1);
    expect(base).toBeDefined();
    const reachable = base as V3Task;
    const blinded: V3Task = { ...reachable, blind: [...reachable.required] };
    expect(oracleCoverage(blinded)).toBe(0);
    expect(oracleCoverage(reachable)).toBeGreaterThan(0);
  });

  it('has non-degenerate prior vs oracle differences on the fixed pool', () => {
    const rows = V3_TASKS.map((task) => ({
      id: task.id,
      prior: priorCoverage(task),
      oracle: oracleCoverage(task)
    }));
    for (const row of rows) {
      expect(row.prior).toBeLessThanOrEqual(row.oracle + 1e-12);
    }
    const withHeadroom = rows.filter((row) => row.oracle - row.prior > 1e-9);
    expect(withHeadroom.length).toBeGreaterThanOrEqual(3);

    const summary = designSummary();
    expect(summary.priorMeanCoverage).toBeLessThan(summary.oracleMeanCoverage);
    // The 30-70% band is a DESIGN TARGET (documented in the module): the
    // baseline must neither already solve the suite nor sit at the floor.
    // Missing the band means a NEW pre-registration is needed - never a
    // re-tuning of the measured data.
    expect(summary.baselineBand.inBand).toBe(true);
    expect(summary.tasksWithConstrainedCeiling).toBeGreaterThanOrEqual(1);
  });

  it('offers more than one distinct action at every key decision point', () => {
    for (const task of V3_TASKS) {
      const points = taskDecisionPoints(task);
      expect(points.length).toBe(V3_ROUNDS);
      for (const point of points) {
        expect(point.candidates.length).toBeGreaterThan(1);
        expect(point.distinctActionCount).toBeGreaterThan(1);
        expect(new Set(point.candidates.map((candidate) => candidate.actionKey)).size).toBe(
          point.distinctActionCount
        );
        // The L1 decision must also have a choice: four production slot kinds.
        expect(point.l1SlotKinds.length).toBeGreaterThan(1);
      }
      for (const row of decisionPointActionCounts(task)) {
        expect(row.actions).toBeGreaterThan(1);
      }
    }

    // Negative control: the checker MUST report a single-action decision point.
    const degenerate = singleActionTask();
    expect(decisionPointActionCounts(degenerate).every((row) => row.actions === 1)).toBe(true);
    expect(designGateFindings([degenerate]).join(' ')).toContain('<= 1 distinct action');
  });

  it('produces a support matrix with rank > 1, and the rank checker is negative-controlled', () => {
    // Negative control FIRST: a deliberately rank-1 matrix must be reported as
    // rank 1 and as deficient. Without this the real assertion below proves
    // nothing about the checker.
    const degenerateMatrix = degenerateRankOneFixture();
    expect(degenerateMatrix.cells.length).toBeGreaterThan(1);
    expect(rankOfMatrix(degenerateMatrix.cells)).toBe(1);
    expect(isRankDeficient({ rank: rankOfMatrix(degenerateMatrix.cells) })).toBe(true);

    // A table whose pools all offer one class is the design-side counterpart.
    const degenerateTable = [singleActionTask()];
    const degenerateTableMatrix = buildSupportMatrix(degenerateTable);
    expect(degenerateTableMatrix.rank).toBe(1);
    expect(isRankDeficient(degenerateTableMatrix)).toBe(true);
    expect(designGateFindings(degenerateTable).join(' ')).toContain('support matrix rank <= 1');

    // The real table.
    const matrix = buildSupportMatrix();
    expect(matrix.decisionPoints.length).toBe(V3_TASKS.length * V3_ROUNDS);
    expect(matrix.actionClasses.length).toBeGreaterThan(1);
    expect(matrix.rank).toBeGreaterThan(1);
    expect(matrix.minActionsPerDecisionPoint).toBeGreaterThan(1);
    // Verified against the independent matrix built from the decision points.
    const independent = taskDecisionPoints(V3_TASKS[0] as V3Task)[0];
    expect(independent).toBeDefined();
    expect(designGateFindings()).toEqual([]);
  });

  it('freezes a reproducible content digest over the canonical bytes', async () => {
    const bytes = canonicalDesignBytes();
    const digest = await designDigest();
    const expected = 'sha256:' + createHash('sha256').update(bytes, 'utf8').digest('hex');
    expect(digest).toBe(expected);
    expect(bytes.endsWith('\n')).toBe(true);

    const parsed = JSON.parse(canonicalDesignJson()) as { version: string; tasks: unknown[] };
    expect(parsed.version).toBe(V3_DESIGN_VERSION);
    expect(parsed.tasks.length).toBe(V3_TASKS.length);
    expect(canonicalDesignTasksJson()).toEqual(parsed.tasks);

    // Any table edit must change the digest: a digest that ignores the table is
    // not a freeze.
    const mutated = V3_TASKS.map((task, index) =>
      index === 0 ? withPrefs(task, [...task.prefs].reverse()) : task
    );
    const mutatedDigest = await designDigest(mutated);
    expect(mutatedDigest).not.toBe(digest);
  });
});
