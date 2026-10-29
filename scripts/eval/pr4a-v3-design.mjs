#!/usr/bin/env node
/**
 * P2-A (p2-a-b-kernel): the V3 task & schedule design for a DISCRIMINABLE
 * offline evaluation.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The V2 suite (EVAL_TASKS in ./jitrl-eval-lib.ts) can not discriminate a
 * policy from its own prior, and the reason is structural rather than
 * statistical:
 *
 *   - every V2 task's required surface set is a subset of prefs[:3], and the
 *     suite only knows three proposable surfaces, so prefs[:3] IS the whole
 *     surface vocabulary;
 *   - the prior (argmax-confidence candidate at every decision) therefore
 *     accumulates exactly prefs[:rounds], and with rounds >= 3 that lineage
 *     covers every surface any candidate can offer;
 *   - consequently the table oracle is 1 for every task, and so is the prior:
 *     "baseline reaches the ceiling" is a property of the TABLE, not of a
 *     policy that was measured. That is why oracleCoverage: 1 could be
 *     hard-coded in the PR-4A engine without anyone noticing (it happened to
 *     equal the computed value) and why arm-to-arm differences had nowhere to
 *     appear.
 *
 * V3 fixes the DESIGN, not the numbers:
 *
 *   1. the surface vocabulary grows to five REAL harness component keys
 *      (HARNESS_COMPONENT_KEYS in src/types/contracts.ts) so a preference
 *      order can have a tail: prefs[:3] is no longer the whole domain;
 *   2. some tasks REQUIRE a surface the proposer ranks 4th/5th - the prior
 *      cannot reach it by following its own preference order, so a policy must
 *      LEARN to deviate. "required not subset of prefs[:3]" is a property of
 *      the table and is asserted, not hoped for;
 *   3. some tasks are FAMILY-BLIND: they require a surface the candidate family
 *      never offers, so the oracle is < 1 BY DESIGN. The ceiling is measured
 *      per task instead of being assumed to be 1 (P2-A: constrain baseline AND
 *      oracle discriminability space);
 *   4. the oracle is COMPUTED from the table (task prefs/required/blind + the
 *      documented pool schedule), never configured. A hard-coded ceiling is a
 *      contradiction in terms: it can not fall when the table changes.
 *
 * WHAT THIS MODULE DOES NOT DO
 * ----------------------------
 * It does not run the kernel, it does not score trajectories and it produces no
 * evaluation RESULT. It is the frozen design object that a pre-registration can
 * bind (see designDigest()) and that the production-aligned replay
 * (./pr4a-v3-replay.mjs) consumes. Design-time self-checks are labelled as
 * such; no V3 metric may be published before the pre-registration records the
 * digest (P2-C owns that record).
 *
 * DETERMINISM: this module is pure data + pure functions of that data. No
 * clock, no PRNG, no filesystem, no environment reads. Importing it has no
 * side effects; the CLI entry point runs only under "node".
 */

/**
 * The five surfaces V3 lets the synthetic proposer edit.
 *
 * All five are real HARNESS_COMPONENT_KEYS, which keeps the fixture inside the
 * harness's own editable domain. The first three are V2's vocabulary, kept so a
 * V2-vs-V3 contrast is about the DESIGN and not about a renamed surface.
 */
export const V3_SURFACES = Object.freeze([
  'guardrails',
  'tool_guidance',
  'skills',
  'memory',
  'scripts'
]);

/**
 * Real harness component keys the fixture's candidate FAMILY never edits.
 *
 * They are what a "family-blind" task requires: the task's ground truth is a
 * real surface (HARNESS_COMPONENT_KEYS), but the synthetic proposer family only
 * edits V3_SURFACES, so no candidate can ever cover it and the oracle is
 * bounded below 1 BY DESIGN. Keeping them in the vocabulary (instead of
 * inventing a fake surface name) is what makes the capability gap honest.
 */
export const V3_UNPROPOSABLE_SURFACES = Object.freeze(['subagents', 'plugins']);

/** Rounds per episode (V3 default; the pre-registration pins it). */
export const V3_ROUNDS = 3;

/** Version of the pool/schedule rule below; a change requires a new digest. */
export const V3_POOL_RULE_VERSION = 'v3/narrow+pair/fixed-lineage';
export const V3_SCHEDULE_VERSION = 'v3/schedule-20261029';
export const V3_DESIGN_VERSION = 'v3/tasks-20261029';

/** The four production L1 slot kinds (decision-kind multiplicity at every point). */
export const V3_SLOT_KINDS = Object.freeze(['exploit', 'explore_domain', 'explore_invariant', 'recover']);

/**
 * Candidate-pool rule at one decision point.
 *
 * V2's rule is kept verbatim in shape - narrow-next, narrow-following, merged
 * pair - because the point of V3 is not to invent a new proposer but to stop
 * the table from handing the prior every surface. The parent lineage is the
 * FIXED schedule prefs[:round] (identical for every arm and run, so the
 * stimulus can not depend on what an arm chose), exactly like
 * fairFixedPoolParent.
 */
export function v3PoolForDecision(task, round) {
  const prefs = task.prefs;
  const at = (index) => prefs[Math.min(index, prefs.length - 1)];
  const first = at(round);
  const second = at(round + 1);
  // Confidences are the proposer's own prior (highest first), and they are what
  // the "prior" lineage follows. They are fixed data, not tuned per run.
  const shapes = [
    { surfaces: [first], confidence: 0.7 },
    { surfaces: [second], confidence: 0.55 },
    { surfaces: [first, second], confidence: 0.4 }
  ];
  return shapes.map((shape, index) => ({
    index,
    surfaces: Object.freeze([...new Set(shape.surfaces)]),
    confidence: shape.confidence,
    className: surfaceClassName(shape.surfaces),
    // The action key uses the canonical surface-set form, so the design table
    // and the aligned replay (pr4a-v3-replay.mjs) share ONE action vocabulary.
    actionKey: 'surfaces:' + surfaceClassName(shape.surfaces)
  }));
}

/** Canonical label of a surface set: sorted, joined, empty -> 'noop'. */
export function surfaceClassName(surfaces) {
  const unique = [...new Set(surfaces)].sort();
  return unique.length === 0 ? 'noop' : unique.join('+');
}

/** Required-surface coverage of one edited surface set, in [0, 1]. */
export function coverageOf(task, surfaces) {
  if (task.required.length === 0) return 0;
  const edited = new Set(surfaces);
  let covered = 0;
  for (const surface of task.required) {
    if (edited.has(surface)) covered += 1;
  }
  return covered / task.required.length;
}

/** True when every required surface is one the proposer tries within 3 prefs. */
export function requiredWithinTop3Prefs(task) {
  const top3 = new Set(task.prefs.slice(0, 3));
  return task.required.every((surface) => top3.has(surface));
}

/**
 * Surfaces the candidate FAMILY can ever offer for this task.
 *
 * A "blind" surface is one the task requires but the fixture's candidate family
 * never edits (a capability gap, not a preference gap). It bounds the oracle
 * below 1 and is the reason a per-task ceiling has to be measured.
 */
export function reachableSurfaces(task) {
  const offered = new Set();
  for (let round = 0; round < V3_ROUNDS; round += 1) {
    for (const candidate of v3PoolForDecision(task, round)) {
      for (const surface of candidate.surfaces) offered.add(surface);
    }
  }
  for (const surface of task.blind) offered.delete(surface);
  return Object.freeze([...offered].sort());
}

/**
 * THE ORACLE: best coverage reachable by ANY choice sequence through the
 * documented schedule, computed by exhaustive enumeration over the table.
 *
 * "rounds" is a parameter (not a constant read from the module) so a caller can
 * ask what an episode-length change would do, which is exactly the knob V3 must
 * be able to vary without editing the table. The search is exact: every decision
 * point offers at most three candidates and rounds are small, so enumerating
 * 3^rounds lineages is cheaper than any cleverness and can not miss the maximum.
 */
export function oracleCoverage(task, rounds = V3_ROUNDS) {
  const best = enumerateLineages(task, rounds).reduce((max, lineage) => {
    // A blind surface is one the candidate FAMILY never edits. A pool entry that
    // names it (possible when the surface is proposable but the task declares
    // the family blind to it) must not be counted as coverage: the oracle is
    // what the family can actually achieve.
    const usable = lineage.surfaces.filter((surface) => !task.blind.includes(surface));
    return Math.max(max, coverageOf(task, usable));
  }, 0);
  return best;
}

/**
 * THE PRIOR: coverage of the lineage a policy that always takes the
 * highest-confidence candidate would execute.
 *
 * This is the exact baseline the fair engine's argmax-confidence rule
 * accumulates, computed from the same table and the same pool rule - not a
 * second model of it.
 */
export function priorCoverage(task, rounds = V3_ROUNDS) {
  const surfaces = new Set();
  for (let round = 0; round < rounds; round += 1) {
    const pool = v3PoolForDecision(task, round);
    const chosen = pool.reduce(
      (best, entry) => (entry.confidence > (pool[best]?.confidence ?? -Infinity) ? entry.index : best),
      0
    );
    for (const surface of pool[chosen]?.surfaces ?? []) {
      if (!task.blind.includes(surface)) surfaces.add(surface);
    }
  }
  return coverageOf(task, [...surfaces]);
}

/**
 * Every distinct lineage the schedule can produce, with the composed surface set
 * and the choice sequence that produced it.
 *
 * A lineage's coverage is the union of the deltas it executed (the engine
 * composes inherited coverage + the chosen candidate's surfaces, so the union is
 * the faithful model).
 */
export function enumerateLineages(task, rounds = V3_ROUNDS) {
  let frontier = [{ choices: [], surfaces: [] }];
  for (let round = 0; round < rounds; round += 1) {
    const pool = v3PoolForDecision(task, round);
    const next = [];
    for (const partial of frontier) {
      for (const candidate of pool) {
        const surfaces = new Set(partial.surfaces);
        for (const surface of candidate.surfaces) surfaces.add(surface);
        next.push({ choices: [...partial.choices, candidate.index], surfaces: [...surfaces] });
      }
    }
    frontier = next;
  }
  return frontier;
}

/** Per-task design row: the table facts plus the two computed bounds. */
export function taskDesignRow(task, rounds = V3_ROUNDS) {
  const oracle = oracleCoverage(task, rounds);
  const prior = priorCoverage(task, rounds);
  return {
    id: task.id,
    family: task.family,
    required: [...task.required].sort(),
    prefs: [...task.prefs],
    blind: [...task.blind],
    taskClass: task.taskClass,
    requiredWithinTop3Prefs: requiredWithinTop3Prefs(task),
    reachable: [...reachableSurfaces(task)],
    actionsPerDecisionPoint: decisionPointActionCounts(task, rounds),
    oracle,
    prior,
    headroom: round6(oracle - prior),
    // The ceiling is measured: a task whose oracle is < 1 can never be
    // "verified" by any action of the family, so a pass-rate read against 1.0
    // would silently call the fixture unsolvable instead of the policy weak.
    ceilingIsOne: Math.abs(oracle - 1) < 1e-9
  };
}

/**
 * DISTINCT action count at every decision point.
 *
 * "every key decision point must offer more than one action" is a hard design
 * invariant: a decision point that offers one action (or several candidates that
 * normalize to one action key) has no choice to learn, so its q equals its V by
 * construction and the measured advantage is structurally zero (the P2-D
 * diagnostic). Counted from the canonical surface-set class, which is what
 * normalizePatchSignature would collapse duplicate-shaped patches to.
 */
export function decisionPointActionCounts(task, rounds = V3_ROUNDS) {
  const rows = [];
  for (let round = 0; round < rounds; round += 1) {
    const classes = new Set(v3PoolForDecision(task, round).map((entry) => entry.className));
    rows.push({ round, actions: classes.size, classes: [...classes].sort() });
  }
  return rows;
}

/**
 * SUPPORT MATRIX over decision points x candidate action classes.
 *
 * Row = one decision point (task, round); column = one canonical action class
 * (a surface set the schedule can offer anywhere in the suite); cell = 1 when
 * that action is AVAILABLE at that decision point, else 0. Availability is the
 * design-side support notion: a decision that can not offer an action can not
 * give it support either, whatever the store contains.
 *
 * Rank matters because a rank-1 matrix is exactly the degenerate case the plan
 * calls out: every row is a scalar multiple of one row, i.e. every decision
 * point offers the same support profile and the support dimension collapses to
 * one number. rankOfMatrix(degenerateRankOneFixture().cells) is asserted to be
 * 1 in the tests, so the checker itself is verified with a counterexample
 * before the real table is asserted to be > 1.
 */
export function buildSupportMatrix(tasks = V3_TASKS, rounds = V3_ROUNDS) {
  const actionClasses = [...new Set(tasks.flatMap((task) =>
    Array.from({ length: rounds }, (_, round) =>
      v3PoolForDecision(task, round).map((entry) => entry.className)
    ).flat()
  ))].sort();
  const decisionPoints = [];
  const cells = [];
  for (const task of tasks) {
    for (let round = 0; round < rounds; round += 1) {
      const offered = new Set(v3PoolForDecision(task, round).map((entry) => entry.className));
      decisionPoints.push(task.id + '|r' + String(round));
      cells.push(actionClasses.map((className) => (offered.has(className) ? 1 : 0)));
    }
  }
  return {
    decisionPoints,
    actionClasses,
    cells,
    rank: rankOfMatrix(cells),
    minActionsPerDecisionPoint: Math.min(
      ...cells.map((row) => row.reduce((sum, value) => sum + value, 0))
    )
  };
}

/**
 * Numeric rank of a matrix by Gaussian elimination with partial pivoting.
 *
 * Deliberately small and exact enough for the 0/1 matrices here: a pivot below
 * "tolerance" is treated as structural zero. Pure: the input is never mutated
 * (a copy is eliminated).
 */
export function rankOfMatrix(cells, tolerance = 1e-9) {
  if (!Array.isArray(cells) || cells.length === 0) return 0;
  const width = Math.max(...cells.map((row) => row.length));
  const matrix = cells.map((row) => {
    const copy = row.map((value) => (Number.isFinite(value) ? value : 0));
    while (copy.length < width) copy.push(0);
    return copy;
  });
  let rank = 0;
  for (let column = 0; column < width && rank < matrix.length; column += 1) {
    let pivot = -1;
    let best = tolerance;
    for (let row = rank; row < matrix.length; row += 1) {
      const magnitude = Math.abs(matrix[row][column]);
      if (magnitude > best) {
        best = magnitude;
        pivot = row;
      }
    }
    if (pivot < 0) continue;
    const swap = matrix[rank];
    matrix[rank] = matrix[pivot];
    matrix[pivot] = swap;
    const pivotValue = matrix[rank][column];
    for (let inner = column; inner < width; inner += 1) {
      matrix[rank][inner] /= pivotValue;
    }
    for (let row = 0; row < matrix.length; row += 1) {
      if (row === rank) continue;
      const factor = matrix[row][column];
      if (Math.abs(factor) <= tolerance) continue;
      for (let inner = column; inner < width; inner += 1) {
        matrix[row][inner] -= factor * matrix[rank][inner];
      }
    }
    rank += 1;
  }
  return rank;
}

/**
 * A deliberate RANK-1 fixture: every decision point offers the SAME single
 * action class.
 *
 * This is the negative control for the rank assertion. If the checker can not
 * report rank 1 here, "rank > 1 on the real table" proves nothing.
 */
export function degenerateRankOneFixture() {
  const decisionPoints = ['degenerate|r0', 'degenerate|r1', 'degenerate|r2'];
  const actionClasses = ['guardrails', 'skills'];
  return {
    decisionPoints,
    actionClasses,
    // Every row is the same vector, so every row is a multiple of every other.
    cells: decisionPoints.map(() => actionClasses.map((_, index) => (index === 0 ? 1 : 0))),
    rank: 1,
    minActionsPerDecisionPoint: 1
  };
}

/** True when a support matrix collapses to a single support dimension. */
export function isRankDeficient(matrix) {
  return matrix.rank <= 1;
}

/**
 * The design gate: every hard V3 property, as data.
 *
 * "findings" is empty when the table satisfies the design. The gate is a pure
 * function of the table, so it can be unit-tested against a MUTATED copy (the
 * tests do exactly that: a table with a saturated ceiling or a single-action
 * decision point must produce a finding).
 */
export function designGateFindings(tasks = V3_TASKS, rounds = V3_ROUNDS) {
  const findings = [];
  const rows = tasks.map((task) => taskDesignRow(task, rounds));
  const matrix = buildSupportMatrix(tasks, rounds);

  if (!rows.some((row) => !row.requiredWithinTop3Prefs)) {
    findings.push('no task has required outside prefs[:3]: the suite can not distinguish a learner from its prior');
  }
  if (!rows.some((row) => row.headroom > 1e-9)) {
    findings.push('no task has oracle > prior: prior and oracle are degenerate (ceiling == baseline)');
  }
  if (!rows.some((row) => !row.ceilingIsOne)) {
    findings.push('every oracle is 1: the table assumes the family can solve every task, so the ceiling is not measured');
  }
  if (rows.some((row) => row.oracle + 1e-9 < row.prior)) {
    findings.push('a task has oracle < prior: the prior lineage exceeds the exhaustive maximum (impossible)');
  }
  for (const row of rows) {
    if (row.actionsPerDecisionPoint.some((entry) => entry.actions <= 1)) {
      findings.push(row.id + ': a decision point offers <= 1 distinct action (support is structurally rank 1 there)');
    }
  }
  if (isRankDeficient(matrix)) {
    findings.push('support matrix rank <= 1: every decision point has the same support profile');
  }
  return findings;
}

/**
 * Aggregate design metrics (a DESIGN self-check, not an evaluation result).
 *
 * priorMeanCoverage is the number the plan's 30-70% band refers to. The band is
 * a DESIGN TARGET: it says the baseline must neither already solve the suite nor
 * sit at the floor, and it is reported here so a reviewer can see whether the
 * design reached it. It is NOT a tuning knob over measured data - this module
 * never sees a measured outcome.
 */
export function designSummary(tasks = V3_TASKS, rounds = V3_ROUNDS) {
  const rows = tasks.map((task) => taskDesignRow(task, rounds));
  const matrix = buildSupportMatrix(tasks, rounds);
  const mean = (values) => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);
  const priorMean = mean(rows.map((row) => row.prior));
  const oracleMean = mean(rows.map((row) => row.oracle));
  return {
    version: V3_DESIGN_VERSION,
    poolRuleVersion: V3_POOL_RULE_VERSION,
    scheduleVersion: V3_SCHEDULE_VERSION,
    rounds,
    taskCount: tasks.length,
    surfaces: [...V3_SURFACES],
    unproposableSurfaces: [...V3_UNPROPOSABLE_SURFACES],
    slotKinds: [...V3_SLOT_KINDS],
    // Band membership is reported, never asserted as "pass": see the comment
    // above and the report's design-target section.
    baselineBand: { low: 0.3, high: 0.7, inBand: priorMean >= 0.3 - 1e-9 && priorMean <= 0.7 + 1e-9 },
    priorMeanCoverage: round6(priorMean),
    oracleMeanCoverage: round6(oracleMean),
    meanHeadroom: round6(mean(rows.map((row) => row.headroom))),
    requiredOutsideTop3Share: round6(rows.filter((row) => !row.requiredWithinTop3Prefs).length / Math.max(1, rows.length)),
    tasksWithRequiredOutsideTop3: rows.filter((row) => !row.requiredWithinTop3Prefs).length,
    tasksWithConstrainedCeiling: rows.filter((row) => !row.ceilingIsOne).length,
    tasksWithHeadroom: rows.filter((row) => row.headroom > 1e-9).length,
    minActionsPerDecisionPoint: Math.min(
      ...rows.flatMap((row) => row.actionsPerDecisionPoint.map((entry) => entry.actions))
    ),
    supportMatrix: {
      decisionPoints: matrix.decisionPoints.length,
      actionClasses: matrix.actionClasses,
      rank: matrix.rank,
      minActionsPerDecisionPoint: matrix.minActionsPerDecisionPoint
    },
    rows,
    findings: designGateFindings(tasks, rounds)
  };
}

/**
 * The frozen design object.
 *
 * Each task pins: required (ground truth), prefs (the proposer's OWN order,
 * which it never compares against required), and blind (surfaces the fixture's
 * candidate family can not edit - the capability gap that bounds the ceiling).
 *
 * The four task classes are deliberate and documented per task:
 *   prior-saturates  required within prefs[:3]      -> prior = oracle = 1 (control)
 *   preference-blind required outside prefs[:3]     -> prior < oracle = 1 (learnable)
 *   family-blind     a required surface is blind    -> oracle < 1 (measured ceiling)
 *   mixed            both of the above              -> prior <= oracle < 1
 */
export const V3_TASKS = Object.freeze([
  // ---- control: the prior already solves it (the ceiling is reachable) ------
  v3Task({
    id: 'v3-ci-01',
    family: 'ci-fix',
    prompt: 'Fix the failing CI build for the release branch and restore the publish job.',
    signature: 'ci-fix-publish',
    tags: ['ci', 'release'],
    complexity: 'moderate',
    required: ['guardrails', 'skills'],
    prefs: ['guardrails', 'skills', 'tool_guidance', 'memory', 'scripts'],
    blind: [],
    klass: 'prior-saturates'
  }),
  v3Task({
    id: 'v3-mig-01',
    family: 'schema-migration',
    prompt: 'Migrate the account schema and keep the audit trail intact.',
    signature: 'migration-account',
    tags: ['db', 'migration'],
    complexity: 'complex',
    required: ['tool_guidance'],
    prefs: ['tool_guidance', 'guardrails', 'skills', 'memory', 'scripts'],
    blind: [],
    klass: 'prior-saturates'
  }),

  // ---- preference-blind: the required surface is ranked 4th/5th ------------
  v3Task({
    id: 'v3-ci-02',
    family: 'ci-fix',
    prompt: 'Repair the flaky integration job without touching the pass criteria.',
    signature: 'ci-fix-flaky',
    tags: ['ci', 'flaky'],
    complexity: 'moderate',
    required: ['guardrails', 'memory'],
    prefs: ['guardrails', 'skills', 'tool_guidance', 'memory', 'scripts'],
    blind: [],
    klass: 'preference-blind'
  }),
  v3Task({
    id: 'v3-ci-03',
    family: 'ci-fix',
    prompt: 'Make the nightly cache rebuild reproducible after the toolchain bump.',
    signature: 'ci-fix-cache',
    tags: ['ci', 'cache'],
    complexity: 'complex',
    required: ['tool_guidance', 'scripts'],
    prefs: ['tool_guidance', 'skills', 'guardrails', 'scripts', 'memory'],
    blind: [],
    klass: 'preference-blind'
  }),
  v3Task({
    id: 'v3-test-01',
    family: 'test-authoring',
    prompt: 'Write regression tests for the retry policy and wire them into CI.',
    signature: 'tests-retry',
    tags: ['tests'],
    complexity: 'moderate',
    required: ['skills', 'memory'],
    prefs: ['skills', 'guardrails', 'tool_guidance', 'memory', 'scripts'],
    blind: [],
    klass: 'preference-blind'
  }),
  v3Task({
    id: 'v3-test-02',
    family: 'test-authoring',
    prompt: 'Turn the manual smoke checklist into an automated gate.',
    signature: 'tests-smoke',
    tags: ['tests', 'ci'],
    complexity: 'complex',
    required: ['guardrails', 'skills', 'scripts'],
    prefs: ['guardrails', 'skills', 'tool_guidance', 'scripts', 'memory'],
    blind: [],
    klass: 'preference-blind'
  }),
  v3Task({
    id: 'v3-mig-02',
    family: 'schema-migration',
    prompt: 'Add the backfill migration for the session table and document the rollback.',
    signature: 'migration-session',
    tags: ['db', 'migration'],
    complexity: 'complex',
    required: ['tool_guidance', 'memory', 'scripts'],
    prefs: ['tool_guidance', 'guardrails', 'skills', 'scripts', 'memory'],
    blind: [],
    klass: 'preference-blind'
  }),

  // ---- family-blind: a required surface is never offered -------------------
  v3Task({
    id: 'v3-rel-01',
    family: 'release-gating',
    prompt: 'Gate the release on the signed provenance check.',
    signature: 'release-provenance',
    tags: ['release', 'gate'],
    complexity: 'complex',
    required: ['guardrails', 'subagents'],
    prefs: ['guardrails', 'skills', 'tool_guidance', 'memory', 'scripts'],
    blind: ['subagents'],
    klass: 'family-blind'
  }),
  v3Task({
    id: 'v3-rel-02',
    family: 'release-gating',
    prompt: 'Freeze the rollback plan before the release train leaves.',
    signature: 'release-rollback',
    tags: ['release', 'rollback'],
    complexity: 'moderate',
    required: ['skills', 'plugins'],
    prefs: ['skills', 'tool_guidance', 'guardrails', 'memory', 'scripts'],
    blind: ['plugins'],
    klass: 'family-blind'
  }),
  v3Task({
    id: 'v3-mig-03',
    family: 'schema-migration',
    prompt: 'Make the schema change reversible and prove it on a restored snapshot.',
    signature: 'migration-reversible',
    tags: ['db', 'migration', 'rollback'],
    complexity: 'complex',
    required: ['tool_guidance', 'skills', 'subagents'],
    prefs: ['tool_guidance', 'skills', 'guardrails', 'memory', 'scripts'],
    blind: ['subagents'],
    klass: 'family-blind'
  }),

  // ---- mixed: preference-blind AND a bounded ceiling ----------------------
  v3Task({
    id: 'v3-rel-03',
    family: 'release-gating',
    prompt: 'Attach the audit bundle to the release evidence and keep it replayable.',
    signature: 'release-audit',
    tags: ['release', 'audit'],
    complexity: 'complex',
    required: ['guardrails', 'scripts', 'plugins'],
    prefs: ['guardrails', 'tool_guidance', 'skills', 'scripts', 'memory'],
    blind: ['plugins'],
    klass: 'mixed'
  }),
  v3Task({
    id: 'v3-test-03',
    family: 'test-authoring',
    prompt: 'Wire the memory bridge integration test into the release gate.',
    signature: 'tests-memory-bridge',
    tags: ['tests', 'release'],
    complexity: 'complex',
    required: ['skills', 'memory', 'subagents'],
    prefs: ['skills', 'guardrails', 'tool_guidance', 'memory', 'scripts'],
    blind: ['subagents'],
    klass: 'mixed'
  })
]);

/** Task constructor: keeps the frozen shape in one place. */
function v3Task(input) {
  validateTask(input);
  return Object.freeze({
    id: input.id,
    family: input.family,
    prompt: input.prompt,
    signature: input.signature,
    contextTags: Object.freeze([...input.tags]),
    complexity: input.complexity,
    required: Object.freeze([...input.required]),
    prefs: Object.freeze([...input.prefs]),
    blind: Object.freeze([...input.blind]),
    taskClass: input.klass
  });
}

/** Fail-closed validation of one frozen task row. */
function validateTask(input) {
  const where = 'v3 task ' + String(input.id);
  if (input.required.length === 0) throw new Error(where + ': required must be non-empty');
  if (input.prefs.length !== V3_SURFACES.length) {
    throw new Error(where + ': prefs must be a full ordering of V3_SURFACES');
  }
  if (new Set(input.prefs).size !== V3_SURFACES.length) {
    throw new Error(where + ': prefs contains a duplicate surface');
  }
  const known = new Set([...V3_SURFACES, ...V3_UNPROPOSABLE_SURFACES]);
  for (const surface of [...input.required, ...input.prefs, ...input.blind]) {
    if (!known.has(surface)) {
      // A typo here would silently create an unreachable "surface" and inflate
      // every rate, so it is a construction error, not a warning.
      throw new Error(where + ': unknown surface ' + String(surface));
    }
  }
  for (const surface of input.prefs) {
    // The proposer can only prefer surfaces it could edit.
    if (!V3_SURFACES.includes(surface)) {
      throw new Error(where + ': prefs names an unproposable surface ' + String(surface));
    }
  }
}

/**
 * The decision points of one task, exactly as the replay consumes them.
 *
 * "slotKind" names the L2 proposal-level decision; the L1 slot kinds are listed
 * per point because the L1 decision must also have more than one candidate
 * (four production slot kinds), otherwise the support matrix could be rank 1
 * on the L1 side even with a rich L2 pool.
 */
export function taskDecisionPoints(task, rounds = V3_ROUNDS) {
  const points = [];
  for (let round = 0; round < rounds; round += 1) {
    const pool = v3PoolForDecision(task, round);
    const classes = new Set(pool.map((entry) => entry.className));
    points.push({
      id: task.id + '|r' + String(round),
      task: task.id,
      round,
      slotKind: 'proposal',
      l1SlotKinds: [...V3_SLOT_KINDS],
      candidates: pool.map((entry) => ({
        actionKey: entry.actionKey,
        surfaces: [...entry.surfaces],
        confidence: entry.confidence,
        className: entry.className
      })),
      distinctActionCount: classes.size
    });
  }
  return points;
}

/** How the oracle is derived, in one machine-readable line. */
export const ORACLE_DERIVATION =
  'max coverage over every lineage (choices^rounds sequences) through v3PoolForDecision; coverageOf(required, union of chosen candidate surfaces); blind surfaces are deleted from reachable sets first';

/** How the prior is derived, in one machine-readable line. */
export const PRIOR_DERIVATION =
  'coverage of the lineage that always takes the argmax-confidence candidate at every decision point (union of its surfaces)';

/**
 * Per-task JSON shape consumed by the pre-registration gate and the replay.
 * Same content as the canonical array, kept as a named function so the machine
 * payload and the digest can never drift apart.
 */
export function canonicalDesignTasksJson(tasks = V3_TASKS, rounds = V3_ROUNDS) {
  return tasks.map((task) => ({
    id: task.id,
    family: task.family,
    signature: task.signature,
    complexity: task.complexity,
    taskClass: task.taskClass,
    required: [...task.required].sort(),
    prefs: [...task.prefs],
    blind: [...task.blind].sort(),
    requiredWithinTop3Prefs: requiredWithinTop3Prefs(task),
    oracleCoverage: oracleCoverage(task, rounds),
    priorCoverage: priorCoverage(task, rounds),
    reachableSurfaces: [...reachableSurfaces(task)],
    decisionPoints: taskDecisionPoints(task, rounds)
  }));
}

/**
 * Canonical, byte-stable serialisation of the design.
 *
 * Field order is fixed and lists are sorted where the order is not meaningful,
 * so two checkouts of the same design produce the same bytes (and therefore the
 * same digest). The hash is what the pre-registration freezes; it is
 * recomputable with: node scripts/eval/pr4a-v3-design.mjs --canonical | sha256sum
 */
export function canonicalDesignJson(tasks = V3_TASKS, rounds = V3_ROUNDS) {
  const canonical = {
    version: V3_DESIGN_VERSION,
    poolRuleVersion: V3_POOL_RULE_VERSION,
    scheduleVersion: V3_SCHEDULE_VERSION,
    rounds,
    surfaces: [...V3_SURFACES],
    unproposableSurfaces: [...V3_UNPROPOSABLE_SURFACES],
    slotKinds: [...V3_SLOT_KINDS],
    oracleDerivation: ORACLE_DERIVATION,
    priorDerivation: PRIOR_DERIVATION,
    tasks: canonicalDesignTasksJson(tasks, rounds)
  };
  return JSON.stringify(canonical, null, 2);
}

/**
 * SHA-256 of the CANONICAL BYTES - the value the pre-registration records.
 *
 * The hashed bytes are exactly what --canonical writes (the JSON plus one
 * LF terminator), so a reviewer reproduces the digest byte-for-byte with:
 *   node scripts/eval/pr4a-v3-design.mjs --canonical | sha256sum
 * Computing the hash over a different byte string than the published one is the
 * classic way a "frozen" digest turns out to be unreproducible, so the two are
 * defined in one place here.
 */
export async function designDigest(tasks = V3_TASKS, rounds = V3_ROUNDS) {
  const { createHash } = await import('node:crypto');
  return 'sha256:' + createHash('sha256').update(canonicalDesignBytes(tasks, rounds), 'utf8').digest('hex');
}

/** The exact bytes designDigest hashes and --canonical prints. */
export function canonicalDesignBytes(tasks = V3_TASKS, rounds = V3_ROUNDS) {
  return canonicalDesignJson(tasks, rounds) + '\n';
}

function round6(value) {
  return Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : 0;
}

// ---------------------------------------------------------------------------
// CLI: design-time self-check (NOT an evaluation result)
// ---------------------------------------------------------------------------

const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /pr4a-v3-design\.mjs$/.test(process.argv[1].replace(/\\/g, '/'));

if (invokedDirectly) {
  if (process.argv.includes('--oracle-proof')) {
    /**
     * Recompute the oracle in front of the reader: enumerate EVERY lineage the
     * documented pool admits, score it against required/blind, and compare the
     * exhaustive maximum with the published oracleCoverage. This is the
     * "computed from the table, not hard-coded" claim as a runnable proof: a
     * constant would disagree with the enumeration on the tasks whose ceiling is
     * below 1.
     */
    const json = process.argv.includes('--json');
    const rows = V3_TASKS.map((task) => {
      const lineages = enumerateLineages(task);
      let best = { coverage: -1, choices: [], surfaces: [] };
      for (const lineage of lineages) {
        const usable = lineage.surfaces.filter((surface) => !task.blind.includes(surface));
        const coverage = coverageOf(task, usable);
        if (coverage > best.coverage) {
          best = { coverage, choices: [...lineage.choices], surfaces: usable };
        }
      }
      const published = oracleCoverage(task);
      return {
        id: task.id,
        required: [...task.required].sort(),
        blind: [...task.blind].sort(),
        lineagesEnumerated: lineages.length,
        bestChoices: best.choices,
        bestSurfaces: [...best.surfaces].sort(),
        bestCoverage: best.coverage,
        oracleCoverage: published,
        agrees: Math.abs(best.coverage - published) < 1e-12
      };
    });
    const allAgree = rows.every((row) => row.agrees);
    if (json) {
      console.log(
        JSON.stringify(
          { rounds: V3_ROUNDS, derivation: ORACLE_DERIVATION, priorDerivation: PRIOR_DERIVATION, rows, allAgree },
          null,
          2
        )
      );
    } else {
      console.log('[v3-oracle] derivation: ' + ORACLE_DERIVATION);
      console.log('[v3-oracle] rounds: ' + String(V3_ROUNDS) + ' -> ' + String(Math.pow(3, V3_ROUNDS)) + ' lineages enumerated per task');
      console.log('');
      console.log('task        lineages  bestChoices  bestSurfaces                  coverage  oracle  agrees');
      for (const row of rows) {
        console.log(
          row.id.padEnd(11) +
            ' ' +
            String(row.lineagesEnumerated).padEnd(9) +
            ' ' +
            row.bestChoices.join('').padEnd(12) +
            ' ' +
            row.bestSurfaces.join('+').padEnd(30) +
            ' ' +
            row.bestCoverage.toFixed(2).padEnd(9) +
            ' ' +
            row.oracleCoverage.toFixed(2).padEnd(7) +
            ' ' +
            String(row.agrees)
        );
      }
      console.log('');
      console.log('[v3-oracle] exhaustive maximum agrees with the published oracle on every task: ' + String(allAgree));
    }
    if (!allAgree) {
      process.exitCode = 1;
    }
  } else if (process.argv.includes('--canonical')) {
    process.stdout.write(canonicalDesignJson() + '\n');
  } else {
    const json = process.argv.includes('--json');
    const summary = designSummary();
    const digest = await designDigest();
    if (json) {
      // The machine shape the pre-registration gate consumes (p2-prereg, t3).
      // Stable key order, LF endings, UTF-8 on stdout.
      const payload = {
        version: summary.version,
        poolRuleVersion: summary.poolRuleVersion,
        scheduleVersion: summary.scheduleVersion,
        rounds: summary.rounds,
        surfaces: summary.surfaces,
        unproposableSurfaces: summary.unproposableSurfaces,
        slotKinds: summary.slotKinds,
        digest,
        digestScope: 'sha256 over canonicalDesignBytes() = canonicalDesignJson() + one LF; recomputable via --canonical | sha256sum',
        oracleDerivation: ORACLE_DERIVATION,
        priorDerivation: PRIOR_DERIVATION,
        taskCount: summary.taskCount,
        requiredOutsideTop3Share: summary.requiredOutsideTop3Share,
        tasksWithRequiredOutsideTop3: summary.tasksWithRequiredOutsideTop3,
        tasksWithConstrainedCeiling: summary.tasksWithConstrainedCeiling,
        tasksWithHeadroom: summary.tasksWithHeadroom,
        priorMeanCoverage: summary.priorMeanCoverage,
        oracleMeanCoverage: summary.oracleMeanCoverage,
        baselineBand: summary.baselineBand,
        supportMatrix: summary.supportMatrix,
        minActionsPerDecisionPoint: summary.minActionsPerDecisionPoint,
        findings: summary.findings,
        tasks: canonicalDesignTasksJson()
      };
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log('[v3-design] ' + summary.version + ' (' + summary.poolRuleVersion + ')');
      console.log('[v3-design] digest: ' + digest);
      console.log('[v3-design] tasks: ' + String(summary.taskCount) + ', rounds: ' + String(summary.rounds));
      console.log('');
      console.log('task        class             required               top3  oracle  prior  headroom  actions/round');
      for (const row of summary.rows) {
        console.log(
          row.id.padEnd(11) +
            ' ' +
            String(row.taskClass).padEnd(17) +
            ' ' +
            row.required.join('+').padEnd(22) +
            ' ' +
            String(row.requiredWithinTop3Prefs).padEnd(5) +
            ' ' +
            row.oracle.toFixed(2).padEnd(6) +
            ' ' +
            row.prior.toFixed(2).padEnd(6) +
            ' ' +
            row.headroom.toFixed(2).padEnd(9) +
            ' ' +
            row.actionsPerDecisionPoint.map((entry) => String(entry.actions)).join('/')
        );
      }
      console.log('');
      console.log('[v3-design] prior mean coverage:  ' + summary.priorMeanCoverage.toFixed(3));
      console.log('[v3-design] oracle mean coverage: ' + summary.oracleMeanCoverage.toFixed(3));
      console.log('[v3-design] mean headroom:        ' + summary.meanHeadroom.toFixed(3));
      console.log(
        '[v3-design] baseline band [0.30, 0.70]: ' +
          (summary.baselineBand.inBand ? 'IN BAND (design target met)' : 'OUT OF BAND (design-target miss; requires a new pre-registration, NOT tuning)')
      );
      console.log('[v3-design] tasks with required outside prefs[:3]: ' + String(summary.tasksWithRequiredOutsideTop3) + '/' + String(summary.taskCount) + ' (share ' + summary.requiredOutsideTop3Share.toFixed(2) + ')');
      console.log('[v3-design] tasks with constrained ceiling: ' + String(summary.tasksWithConstrainedCeiling) + '/' + String(summary.taskCount));
      console.log('[v3-design] min actions per decision point: ' + String(summary.minActionsPerDecisionPoint) + ' (must be > 1)');
      const matrix = buildSupportMatrix();
      console.log('[v3-design] support matrix: ' + String(matrix.decisionPoints.length) + ' decision points x ' + String(matrix.actionClasses.length) + ' action classes, rank=' + String(matrix.rank) + ' (must be > 1)');
      console.log('[v3-design] rank-1 negative control: rank=' + String(rankOfMatrix(degenerateRankOneFixture().cells)) + ' (must be 1)');
      if (summary.findings.length > 0) {
        console.error('[v3-design] DESIGN GATE FAILED:');
        for (const finding of summary.findings) console.error('  - ' + finding);
        process.exitCode = 1;
      } else {
        console.log('[v3-design] design gate: PASS (design-time self-check only; no V3 result may be published before the pre-registration records the digest)');
      }
    }
  }
}
