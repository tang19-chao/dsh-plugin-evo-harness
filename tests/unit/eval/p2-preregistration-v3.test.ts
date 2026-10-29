/**
 * P2-C: V3 pre-registration consistency tests.
 *
 * Protocol: docs/reports/p2-preregistration-v3.md
 *           (P2-V3-EVAL-PREREG-20261029-V3, a NEW registration alongside V2).
 * Stats:    scripts/eval/pr4a-stats.verify.mjs (the V3 layer + V2 self-checks).
 *
 * WHAT IS PINNED HERE, all before any V3 data exists:
 *   1. the STRUCTURAL REJECTABILITY FLOOR (pMin = 2^(1-m); the family-4 floor
 *      at m_disc = 8) and the label rule "structurally-non-rejectable";
 *   2. the exact power of the paired randomization (sign-flip) test, including
 *      the consistency identity with the binary sign test;
 *   3. the exact (binomial-weighted) coverage of the Clopper-Pearson interval;
 *   4. the FROZEN development/holdout split of the V3 task table: deterministic,
 *      metrics-blind, family-integral, fail-closed on insufficiency, with a
 *      holdout firewall that catches a holdout id inside a selection artifact;
 *   5. the binding to the V3 task-table digest (P2-A, v3/tasks-20261029);
 *   6. the document itself: every required marker must be present in
 *      docs/reports/p2-preregistration-v3.md, so doc and code cannot drift.
 *
 * HOW THE MODULE IS LOADED: the verify script is a CLI that also exports the
 * V3 layer; it is imported through a runtime-computed file URL (typed locally
 * below) exactly once before any test runs. Importing it has no side effects:
 * the checks only run under direct execution (isDirectExecution guard), which
 * this import also proves.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

interface FloorRow {
  readonly mDisc: number;
  readonly pMin: number;
  readonly label: string;
  readonly rawRejectable: boolean;
  readonly correctedRejectable: boolean;
  readonly alphaStrictest: number;
}

interface FloorTableEntry {
  readonly familySize: number;
  readonly alphaStrictest: number;
  readonly minDiscordantForRejectability: number;
  readonly rows: readonly FloorRow[];
}

interface VerifyModule {
  V3_PROTOCOL_ID: string;
  V3_FROZEN_TASK_TABLE_DIGEST: string;
  V3_SPLIT_SALT: string;
  V3_REQUIRED_DOC_MARKERS: readonly string[];
  V3_REQUIRED_REPORT_SECTIONS: readonly { section: string; fields: readonly string[] }[];
  holmThresholds(familySize: number, alpha?: number): readonly number[];
  structuralRejectability(mDisc: number, options?: { alpha?: number; familySize?: number }): FloorRow & {
    pMinFormula: string;
    structurallyNonRejectable: boolean;
    label: string;
  };
  rejectabilityFloorTable(maxM: number, options?: { familySizes?: number[] }): FloorTableEntry[];
  minDiscordantForRejectability(options?: { alpha?: number; familySize?: number }): number;
  minTasksForPower(pi: number, options?: { alpha?: number; target?: number }): number;
  exactSignFlipPower(
    magnitudes: readonly number[],
    pi: number,
    options?: { alpha?: number }
  ): { n: number; pi: number; alpha: number; threshold: number | null; power: number; patterns: number };
  piStarForSignFlip(magnitudes: readonly number[], options?: { alpha?: number; target?: number }): number;
  exactIntervalCoverage(m: number, pi: number, options?: { alpha?: number }): {
    m: number;
    pi: number;
    coverage: number;
    uncoveredOutcomes: { wins: number; probability: number }[];
  };
  pairedEffectSizes(observations: readonly { taskId: string; left: number; right: number }[]): {
    pairs: number;
    meanDelta: number;
    sdDelta: number;
    dz: number | null;
    wins: number;
    ties: number;
    losses: number;
    mDisc: number;
    piHat: number | null;
  };
  computeV3Split(
    table: readonly { id: string; family: string }[],
    options?: { salt?: string; minShare?: number; maxShare?: number }
  ): {
    salt: string;
    development: { families: string[]; taskIds: string[] };
    holdout: { families: string[]; taskIds: string[] };
    tasks: { id: string; family: string; side: string }[];
    shares: { development: number; holdout: number };
  };
  splitManifestDigest(manifest: unknown): string;
  verifySplitManifest(manifest: unknown, table?: readonly { id: string; family: string }[]): {
    ok: boolean;
    violations: { kind: string; detail: string }[];
  };
  checkHoldoutFirewall(
    manifest: unknown,
    artifacts: readonly { path: string; content: string }[],
    table?: readonly { id: string; family: string }[]
  ): { ok: boolean; violations: { kind: string; detail: string }[] };
  matrixRank(matrix: readonly (readonly number[])[]): number;
  rankOneFixture(rows?: number): number[][];
  verifyV3TaskTableGate(
    design: unknown,
    digest: string,
    resolvers?: { oracleCoverage?: (task: unknown) => number; priorCoverage?: (task: unknown) => number }
  ): {
    ok: boolean;
    findings: { check: string; detail: string }[];
    taskCount: number;
    outsideTop3Tasks: number;
    outsideTop3Share: number;
    oracleBelowOne: number;
    headroomTasks: number;
    minActionsPerDecisionPoint: number;
    supportMatrixRank: number;
    supportMatrixColumns: number;
  };
  checkReportCompleteness(report: unknown): { ok: boolean; missing: unknown[] };
  canonicalJson(value: unknown): string;
}

const verify = (await import(
  pathToFileURL(path.join(repoRoot, 'scripts/eval/pr4a-stats.verify.mjs')).href
)) as unknown as VerifyModule;

/**
 * The V3 task table module (P2-A deliverable, plain .mjs, dependency-free).
 * Typed locally with the fields the tests read; importing stays side-effect
 * free (the module is pure data + pure functions).
 */
interface V3DesignTask {
  readonly id: string;
  readonly family: string;
  readonly required: readonly string[];
  readonly prefs: readonly string[];
  readonly blind: readonly string[];
  readonly oracleCoverage: number;
  readonly priorCoverage: number;
}

interface V3DesignModule {
  readonly V3_TASKS: readonly V3DesignTask[];
  designDigest(): Promise<string>;
}

const design = (await import(
  pathToFileURL(path.join(repoRoot, 'scripts/eval/pr4a-v3-design.mjs')).href
)) as unknown as V3DesignModule;

const SPLIT_MANIFEST_PATH = path.join(repoRoot, 'tests/fixtures/p2-l1/p2-v3-split-manifest.json');
const V3_DOC_PATH = path.join(repoRoot, 'docs/reports/p2-preregistration-v3.md');

describe('P2-C: the structural rejectability floor (pre-registered label rule)', () => {
  it('pMin = 2^(1-m) for every m, at both family sizes', () => {
    for (let m = 1; m <= 12; m += 1) {
      for (const familySize of [1, 4]) {
        const floor = verify.structuralRejectability(m, { familySize });
        expect(floor.pMin).toBeCloseTo(Math.pow(2, 1 - m), 15);
      }
    }
  });

  it('at family size 4 the floor is m_disc = 8: m <= 7 is structurally non-rejectable', () => {
    for (let m = 1; m <= 7; m += 1) {
      const floor = verify.structuralRejectability(m, { familySize: 4 });
      expect(floor.structurallyNonRejectable).toBe(true);
      expect(floor.label).toBe('structurally-non-rejectable');
    }
    for (let m = 8; m <= 12; m += 1) {
      const floor = verify.structuralRejectability(m, { familySize: 4 });
      expect(floor.structurallyNonRejectable).toBe(false);
      expect(floor.label).toBe('rejectable');
    }
    expect(verify.minDiscordantForRejectability({ familySize: 4 })).toBe(8);
  });

  it('at family size 1 the floor is m_disc = 6 (raw alpha)', () => {
    expect(verify.minDiscordantForRejectability({ familySize: 1 })).toBe(6);
    expect(verify.minDiscordantForRejectability({ familySize: 2 })).toBe(7);
  });

  it('the worked example (m=6, family 4) is structurally non-rejectable, not a mere not-reject', () => {
    const worked = verify.structuralRejectability(6, { familySize: 4 });
    expect(worked.pMin).toBeCloseTo(0.03125, 12);
    expect(worked.rawRejectable).toBe(true);
    expect(worked.correctedRejectable).toBe(false);
    expect(worked.structurallyNonRejectable).toBe(true);
    expect(worked.label).toBe('structurally-non-rejectable');
  });

  it('the floor agrees with minWinsForRejection on the corrected threshold', () => {
    for (let m = 1; m <= 12; m += 1) {
      const floor = verify.structuralRejectability(m, { familySize: 4 });
      expect(floor.rawRejectable).toBe(m >= 6);
      expect(floor.correctedRejectable).toBe(m >= 8);
    }
  });

  it('Holm thresholds are monotone and correct', () => {
    expect(verify.holmThresholds(4).map((t) => Number(t.toFixed(6)))).toEqual([0.0125, 0.016667, 0.025, 0.05]);
    const thresholds = verify.holmThresholds(6);
    for (let index = 1; index < thresholds.length; index += 1) {
      expect(thresholds[index]!).toBeGreaterThan(thresholds[index - 1]!);
    }
  });
});

describe('P2-C: exact power of the paired randomization (sign-flip) test', () => {
  const equal = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
  const hetero = [0.25, 0.25, 0.5, 0.5, 1, 1, 1, 1, 1.5, 1.5, 2, 2];

  it('with all magnitudes equal the sign-flip test IS the sign test (consistency)', () => {
    for (const pi of [0.7, 0.8, 0.9]) {
      const flip = verify.exactSignFlipPower(equal, pi);
      // the V2 table publishes 4 decimal places; 4 dp is the right tolerance
      expect(flip.power).toBeCloseTo(SIGN_TEST_POWER[pi]!, 4);
    }
  });

  it('heterogeneous magnitudes: pre-registered power values reproduce', () => {
    expect(verify.exactSignFlipPower(hetero, 0.7).power).toBeCloseTo(0.2139, 6);
    expect(verify.exactSignFlipPower(hetero, 0.8).power).toBeCloseTo(0.464145, 6);
    expect(verify.exactSignFlipPower(hetero, 0.9).power).toBeCloseTo(0.796537, 6);
  });

  it('pi* for the heterogeneous magnitude set is 0.9011', () => {
    expect(verify.piStarForSignFlip(hetero)).toBeCloseTo(0.9011, 4);
  });

  it('minimal sample sizes for 80% power reproduce (raw and Holm worst case)', () => {
    expect(verify.minTasksForPower(0.7)).toBe(49);
    expect(verify.minTasksForPower(0.75)).toBe(30);
    expect(verify.minTasksForPower(0.8)).toBe(20);
    expect(verify.minTasksForPower(0.85)).toBe(15);
    expect(verify.minTasksForPower(0.9)).toBe(12);
    expect(verify.minTasksForPower(0.85, { alpha: 0.0125 })).toBe(20);
    expect(verify.minTasksForPower(0.9, { alpha: 0.0125 })).toBe(15);
    expect(verify.minTasksForPower(0.8, { alpha: 0.0125 })).toBe(31);
  });
});

// The V2 §8.7 published exact sign-test power curve. Hard-coded ON PURPOSE:
// these are the numbers printed in the sealed V2 protocol, so tying the
// sign-flip consistency identity to them also re-checks that V2 did not move.
const SIGN_TEST_POWER: Readonly<Record<number, number>> = {
  0.7: 0.253,
  0.8: 0.5584,
  0.9: 0.8891
};

describe('P2-C: exact coverage of the Clopper-Pearson interval', () => {
  it('pre-registered coverage values reproduce and stay at or above nominal 0.95', () => {
    const cases = [
      { m: 12, pi: 0.5, coverage: 0.961426 },
      { m: 12, pi: 0.7, coverage: 0.976669 },
      { m: 12, pi: 0.9, coverage: 0.995671 },
      { m: 8, pi: 0.5, coverage: 0.992188 },
      { m: 6, pi: 0.5, coverage: 0.96875 }
    ];
    for (const entry of cases) {
      const coverage = verify.exactIntervalCoverage(entry.m, entry.pi);
      expect(coverage.coverage).toBeCloseTo(entry.coverage, 6);
      expect(coverage.coverage).toBeGreaterThanOrEqual(0.95 - 1e-9);
    }
  });

  it('the uncovered outcomes at m=12, pi=0.5 are exactly the extreme ones', () => {
    const coverage = verify.exactIntervalCoverage(12, 0.5);
    expect(coverage.uncoveredOutcomes.map((outcome) => outcome.wins)).toEqual([0, 1, 2, 10, 11, 12]);
  });
});

describe('P2-C: paired effect sizes (pre-registered estimators)', () => {
  it('wins/ties/losses, d_z and piHat reproduce on a fixed observation set', () => {
    const observations = [
      { taskId: 't1', left: 1, right: 0 },
      { taskId: 't2', left: 1, right: 0 },
      { taskId: 't3', left: 1, right: 0 },
      { taskId: 't4', left: 1, right: 0 },
      { taskId: 't5', left: 0, right: 0 },
      { taskId: 't6', left: 0, right: 0 },
      { taskId: 't7', left: 0, right: 0 },
      { taskId: 't8', left: 0, right: 0 },
      { taskId: 't9', left: 0, right: 1 },
      { taskId: 't10', left: 0, right: 1 },
      { taskId: 't11', left: 0, right: 0 },
      { taskId: 't12', left: 0, right: 0 }
    ];
    const sizes = verify.pairedEffectSizes(observations);
    expect(sizes.wins).toBe(4);
    expect(sizes.losses).toBe(2);
    expect(sizes.ties).toBe(6);
    expect(sizes.mDisc).toBe(6);
    expect(sizes.piHat).toBeCloseTo(2 / 3, 12);
    expect(sizes.meanDelta).toBeCloseTo(1 / 6, 6);
    expect(sizes.dz).not.toBeNull();
  });

  it('the worked example is structurally non-rejectable at family size 4', () => {
    const sizes = verify.pairedEffectSizes(
      Array.from({ length: 12 }, (_, index) => ({
        taskId: 't' + String(index + 1),
        left: index < 4 ? 1 : 0,
        right: index < 4 ? 0 : index < 6 ? 1 : 0
      }))
    );
    const floor = verify.structuralRejectability(sizes.mDisc, { familySize: 4 });
    expect(sizes.mDisc).toBe(6);
    expect(floor.label).toBe('structurally-non-rejectable');
  });
});

describe('P2-C: the frozen development/holdout split', () => {
  const table = design.V3_TASKS.map((task) => ({
    id: task.id,
    family: task.family
  }));

  it('is deterministic and matches the frozen fixture manifest', () => {
    const manifestPath = SPLIT_MANIFEST_PATH;
    expect(fs.existsSync(manifestPath)).toBe(true);
    const fixture = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const live = verify.computeV3Split(table);
    expect(verify.splitManifestDigest(live)).toBe(verify.splitManifestDigest(fixture));
    expect(live.holdout.taskIds).toEqual(fixture.holdout.taskIds);
    expect(live.development.taskIds).toEqual(fixture.development.taskIds);
  });

  it('splits by task FAMILY with 25%-50% holdout and disjoint sides', () => {
    const split = verify.computeV3Split(table);
    expect(split.shares.holdout).toBeGreaterThanOrEqual(0.25 - 1e-9);
    expect(split.shares.holdout).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(split.holdout.taskIds.filter((id) => split.development.taskIds.includes(id))).toHaveLength(0);
    expect(split.development.taskIds.length + split.holdout.taskIds.length).toBe(table.length);
    const familySides = new Map<string, Set<string>>();
    for (const task of split.tasks) {
      if (!familySides.has(task.family)) familySides.set(task.family, new Set());
      familySides.get(task.family)!.add(task.side);
    }
    for (const sides of familySides.values()) {
      expect(sides.size).toBe(1);
    }
  });

  it('is metrics-blind: decoy metric fields cannot change the split', () => {
    const split = verify.computeV3Split(table);
    const decoy = table.map((entry, index) => ({
      ...entry,
      verifiedRate: index % 2 === 0 ? 1 : 0,
      reward: -index,
      policyChangeRate: 0.5,
      holdoutPeek: 'holdout'
    }));
    expect(verify.splitManifestDigest(verify.computeV3Split(decoy))).toBe(verify.splitManifestDigest(split));
  });

  it('the fixture manifest self-verifies; a tampered manifest fails closed', () => {
    const fixture = JSON.parse(fs.readFileSync(SPLIT_MANIFEST_PATH, 'utf8'));
    expect(verify.verifySplitManifest(fixture, table).ok).toBe(true);

    const tampered = JSON.parse(JSON.stringify(fixture));
    tampered.holdout.taskIds = [tampered.holdout.taskIds[0]];
    const tamperedCheck = verify.verifySplitManifest(tampered, table);
    expect(tamperedCheck.ok).toBe(false);
    expect(tamperedCheck.violations.some((v) => v.kind === 'digest-mismatch')).toBe(true);

    const noDigest = JSON.parse(JSON.stringify(fixture));
    delete noDigest.digest;
    const noDigestCheck = verify.verifySplitManifest(noDigest, table);
    expect(noDigestCheck.ok).toBe(false);
    expect(noDigestCheck.violations.some((v) => v.kind === 'digest-missing')).toBe(true);
  });

  it('fails closed when no family allocation can satisfy the holdout bounds', () => {
    const tiny = [{ id: 'a-1', family: 'only' }];
    expect(() => verify.computeV3Split(tiny)).toThrow();
    // a split that cannot be produced must not silently shrink (PR-4B rule)
    try {
      verify.computeV3Split(tiny);
      throw new Error('unreachable');
    } catch (error) {
      expect(String(error)).toContain('failing closed');
    }
  });

  it('the COMMITTED leak fixture is permanently caught (not a one-off probe)', () => {
    const split = verify.computeV3Split(table);
    const manifest = { ...split, digest: verify.splitManifestDigest(split) };
    const read = (name: string) =>
      fs.readFileSync(path.join(repoRoot, 'tests/fixtures/p2-l1', name), 'utf8');

    // These two files live in the repo ON PURPOSE: the leak fixture is the
    // regression witness that a future change cannot quietly stop catching a
    // holdout id inside a candidate-selection artifact.
    const leak = verify.checkHoldoutFirewall(
      manifest,
      [{ path: 'tests/fixtures/p2-l1/p2-v3-selection-holdout-leak.json', content: read('p2-v3-selection-holdout-leak.json') }],
      table
    );
    expect(leak.ok).toBe(false);
    expect(leak.violations.some((v) => v.kind === 'holdout-in-selection-artifact')).toBe(true);

    const clean = verify.checkHoldoutFirewall(
      manifest,
      [{ path: 'tests/fixtures/p2-l1/p2-v3-selection-clean.json', content: read('p2-v3-selection-clean.json') }],
      table
    );
    expect(clean.ok).toBe(true);
  });

  it('the holdout firewall catches a holdout id inside a selection artifact', () => {
    const split = verify.computeV3Split(table);
    const bad = checkHoldout(split, [{ path: 'work/v3-selection.json', content: JSON.stringify({ pool: split.holdout.taskIds }) }]);
    expect(bad.ok).toBe(false);
    expect(bad.violations.some((v) => v.kind === 'holdout-in-selection-artifact')).toBe(true);

    const clean = checkHoldout(split, [
      { path: 'work/v3-selection.json', content: JSON.stringify({ pool: split.development.taskIds }) },
      { path: 'work/v3-tuning.json', content: JSON.stringify({ grid: 'beta,k,similarityThreshold', pool: 'development' }) }
    ]);
    expect(clean.ok).toBe(true);
  });

  function checkHoldout(
    split: ReturnType<VerifyModule['computeV3Split']>,
    artifacts: readonly { path: string; content: string }[]
  ) {
    return verify.checkHoldoutFirewall(
      { ...split, digest: verify.splitManifestDigest(split) },
      artifacts,
      table
    );
  }
});

describe('P2-C: the V3 task-table gate (P2-A discriminability)', () => {
  it('passes on the real table with the frozen digest and the pre-registered numbers', async () => {
    const digest = await design.designDigest();
    const gate = verify.verifyV3TaskTableGate({ V3_TASKS: design.V3_TASKS }, digest);
    expect(gate.ok).toBe(true);
    expect(gate.findings).toEqual([]);
    expect(gate.taskCount).toBe(12);
    expect(gate.outsideTop3Tasks).toBe(10);
    expect(gate.outsideTop3Share).toBeCloseTo(0.833333, 6);
    expect(gate.oracleBelowOne).toBe(6);
    expect(gate.headroomTasks).toBe(7);
    expect(gate.minActionsPerDecisionPoint).toBe(3);
    expect(gate.supportMatrixRank).toBe(9);
    expect(gate.supportMatrixColumns).toBe(14);
    expect(digest).toBe(verify.V3_FROZEN_TASK_TABLE_DIGEST);
  });

  it('fails on an empty table', () => {
    const gate = verify.verifyV3TaskTableGate({ V3_TASKS: [] }, 'sha256:x');
    expect(gate.ok).toBe(false);
  });

  it('fails when every task keeps required inside prefs[:3]', async () => {
    const digest = await design.designDigest();
    const inside = design.V3_TASKS.map((task) => ({
      ...task,
      required: task.required.filter((surface) => task.prefs.slice(0, 3).includes(surface))
    }));
    const gate = verify.verifyV3TaskTableGate({ V3_TASKS: inside }, digest);
    expect(gate.ok).toBe(false);
    expect(gate.findings.some((f) => f.check === 'required-outside-prefs3')).toBe(true);
  });

  it('fails when the oracle is declared 1 for every task (a hard-coded ceiling)', async () => {
    const digest = await design.designDigest();
    const fakeOracle = () => 1;
    const gate = verify.verifyV3TaskTableGate({ V3_TASKS: design.V3_TASKS }, digest, {
      oracleCoverage: fakeOracle,
      priorCoverage: () => 0.5
    });
    expect(gate.ok).toBe(false);
    expect(gate.findings.some((f) => f.check === 'oracle-non-degenerate')).toBe(true);
  });

  it('fails when the recomputed oracle disagrees with the declared oracle', async () => {
    const digest = await design.designDigest();
    const gate = verify.verifyV3TaskTableGate({ V3_TASKS: design.V3_TASKS }, digest, {
      oracleCoverage: () => 0.5,
      priorCoverage: () => 0.5
    });
    expect(gate.ok).toBe(false);
    expect(gate.findings.some((f) => f.check === 'oracle-recomputation')).toBe(true);
  });

  it('fails on a digest mismatch (table changed without a re-freeze)', async () => {
    const gate = verify.verifyV3TaskTableGate({ V3_TASKS: design.V3_TASKS }, 'sha256:not-the-frozen-digest');
    expect(gate.ok).toBe(false);
    expect(gate.findings.some((f) => f.check === 'task-table-digest')).toBe(true);
  });

  it('the rank helper flags a deliberately rank-1 matrix', () => {
    expect(verify.matrixRank(verify.rankOneFixture())).toBe(1);
    expect(verify.matrixRank([[1, 0], [0, 1]])).toBe(2);
  });
});

describe('P2-C: report completeness contract', () => {
  const complete = {
    confidenceIntervals: { meanDelta: 0, lower: 0, upper: 0, method: 'x', reproducibleCommand: 'node scripts/eval/pr4a-stats.verify.mjs' },
    coverage: { intervalCoverage: 1, surfaceCoverage: 0 },
    policyChangeRate: { value: 0, denominator: 'decision points' },
    winsTiesLosses: { wins: 0, ties: 12, losses: 0, discordantPairs: 0 },
    effectSizes: { meanDelta: 0, sdDelta: 0, dz: null },
    power: { signTestPower: 0, signFlipPower: 0, rejectabilityFloor: {} },
    structuralRejectability: { label: 'structurally-non-rejectable', pMin: 0.03125, alphaStrictest: 0.0125 },
    holdoutFirewall: { manifestDigest: 'x', checkedArtifacts: [], violations: [] }
  };

  it('requires every pre-registered section and subfield', () => {
    expect(verify.checkReportCompleteness(complete).ok).toBe(true);
  });

  it('fails when a section is dropped', () => {
    const incomplete: Record<string, unknown> = { ...complete };
    delete incomplete.power;
    const check = verify.checkReportCompleteness(incomplete);
    expect(check.ok).toBe(false);
  });

  it('fails when a required subfield is missing', () => {
    const check = verify.checkReportCompleteness({ ...complete, effectSizes: { meanDelta: 0 } });
    expect(check.ok).toBe(false);
  });

  it('declares the eight required sections', () => {
    expect(verify.V3_REQUIRED_REPORT_SECTIONS.map((entry) => entry.section)).toEqual([
      'confidenceIntervals',
      'coverage',
      'policyChangeRate',
      'winsTiesLosses',
      'effectSizes',
      'power',
      'structuralRejectability',
      'holdoutFirewall'
    ]);
  });
});

describe('P2-C: the pre-registration document is bound to the code', () => {
  it('contains every required marker (protocol id, digests, floor, power, coverage)', () => {
    expect(fs.existsSync(V3_DOC_PATH)).toBe(true);
    const content = fs.readFileSync(V3_DOC_PATH, 'utf8');
    const missing = verify.V3_REQUIRED_DOC_MARKERS.filter((marker) => !content.includes(marker));
    if (missing.length > 0) {
      throw new Error('p2-preregistration-v3.md is missing required markers: ' + JSON.stringify(missing));
    }
    expect(missing).toHaveLength(0);
  });

  it('does not reinterpret V2 numbers: the V2 protocol id stays the five-arm governing protocol', () => {
    const content = fs.readFileSync(V3_DOC_PATH, 'utf8');
    expect(content.includes('PR4A-EVAL-PREREG-20261027-V2')).toBe(true);
    expect(content.includes('V2 的门禁、阈值与标签一律不变')).toBe(true);
  });
});
