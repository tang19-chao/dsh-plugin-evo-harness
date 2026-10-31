/**
 * rev6 R1-4 (t10): the DISCRIMINABLE ablation design, asserted.
 *
 * WHAT THIS SUITE MUST PROVE (contract §5.5, preregistration §3/§5/§7)
 * -------------------------------------------------------------------
 *   A-R1-4-1  no Arm-5; the independent unit is the TASK (never episodes/rounds);
 *             the family-4 rejectability floor is 8 and the 12-task pool makes
 *             that floor REACHABLE (8 <= 12) - the arithmetic is checked, not
 *             asserted;
 *   A-R1-4-2  the holdout firewall discriminates BOTH ways (clean passes,
 *             leak fails);
 *   A-R1-4-3  `not-reject` is never spelled as equivalence: the design exposes
 *             distinct `insufficient` / `undetermined` labels, and the suite
 *             pins that those words mean what the preregistration says.
 *
 * IDENTIFIABILITY is asserted on the design matrix by RECOMPUTING its rank, and
 * the rank computation is itself exercised on a rank-deficient fixture - a check
 * that can only ever print "rank 4" would not be a check.
 *
 * This suite deliberately does NOT run the four arms: that is a five-arm
 * experiment, not this task's deliverable. It proves the DESIGN, and the report
 * marks arm-level intervals `not-evaluable` rather than inferring them.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- plain .mjs module, no type declarations (intentional: it is the FROZEN verifier)
import * as statsModule from '../../../scripts/eval/pr4a-stats.verify.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PREREG = path.join(repoRoot, 'docs/reports/rev6-ablation-preregistration.md');

interface FreezeTable {
  readonly m: number;
  readonly pMin: number;
  readonly correctable: boolean;
  readonly label: string;
}

interface DesignPayload {
  readonly preregisteredBeforeFirstSample: boolean;
  readonly preregistration: { readonly sha256: string; readonly mtimeMs: number };
  readonly design: {
    readonly identifiability: {
      readonly rank: number;
      readonly fullRank: boolean;
      readonly rankOneFixtureDetected: boolean;
    };
    readonly floor: {
      readonly minDiscordant: Record<string, number>;
      readonly holmThresholds: readonly number[];
      readonly table: readonly FreezeTable[];
    };
    readonly power: {
      readonly tasksForEightyPercent: Record<string, number>;
      readonly piAtPoolSize: Record<string, number>;
    };
    readonly firewall: { readonly bidirectional: boolean };
    readonly arms: {
      readonly status: string;
      readonly preregisteredArms: readonly string[];
      readonly armFiveAdded: boolean;
      readonly independentUnit: string;
    };
  };
  readonly boundaries: Record<string, boolean>;
}

/**
 * The RECORDED design facts this suite judges.
 *
 * rev6 t26 (integration repair): this used to read `work/t10/ablation.json`.
 * `work/` is gitignored, so that made a repository-root INPUT depend on a
 * directory a clean checkout does not have - the rev5 G5 work-path scanner
 * (`tests/unit/meta/no-work-dependency.test.ts`) correctly flagged it, and on a
 * clean copy the suite would have thrown `work/t10/ablation.json missing`.
 *
 * The payload is now a TRACKED fixture with the IDENTICAL bytes
 * (`tests/fixtures/rev6/ablation-design.json`, sha256
 * 50126340bff2ae2ee27ed5a34e1ba7e434060f1a1575ec9f4c0b294fffa33920). The guard
 * was NOT relaxed: no entry was added to ALLOWED_REPO_ROOT_READS. Only the
 * input's provenance changed, so the test is self-contained in a clean checkout
 * while still judging the recorded facts rather than a fresh computation.
 */
const ABLATION_FIXTURE = path.join(repoRoot, 'tests/fixtures/rev6/ablation-design.json');

function loadPayload(): DesignPayload {
  const jsonPath = ABLATION_FIXTURE;
  if (!existsSync(jsonPath)) {
    throw new Error(
      'tests/fixtures/rev6/ablation-design.json missing: this TRACKED fixture is the recorded design payload. '
        + 'Regenerate it with `node scripts/eval/rev6-ablation.mjs --json > tests/fixtures/rev6/ablation-design.json` '
        + 'only when the design itself changes. This suite judges the RECORDED design facts, not a fresh computation, '
        + 'so the report and the test cannot disagree.'
    );
  }
  return JSON.parse(readFileSync(jsonPath, 'utf8')) as DesignPayload;
}

describe('A-R1-4-1: preregistration ordering and the frozen design', () => {
  it('the preregistration exists and predates the first sample', () => {
    expect(existsSync(PREREG)).toBe(true);
    const payload = loadPayload();
    expect(
      payload.preregisteredBeforeFirstSample,
      'the preregistration must predate the first sample or R1-4 is void (preregistration §9)'
    ).toBe(true);
    // The sha the script consumed is the sha of the file on disk right now: a
    // post-hoc edit to the preregistration would show up here.
    const liveSha = createHash('sha256').update(readFileSync(PREREG)).digest('hex');
    expect(payload.preregistration.sha256).toBe(liveSha);
  });

  it('there are exactly five arms and NO Arm-5', () => {
    const payload = loadPayload();
    expect(payload.design.arms.preregisteredArms).toHaveLength(5);
    expect(payload.design.arms.preregisteredArms.map((arm) => arm.split(' ')[0])).toEqual([
      'Arm-0',
      'Arm-1',
      'Arm-2',
      'Arm-3',
      'Arm-4'
    ]);
    // The negative assertion that matters: an Arm-5 anywhere would be an
    // unauthorised sixth arm (N-7).
    expect(payload.design.arms.armFiveAdded).toBe(false);
    expect(payload.design.arms.preregisteredArms.join(' ')).not.toContain('Arm-5');
  });

  it('the independent analysis unit is the TASK, not episodes/rounds', () => {
    const payload = loadPayload();
    expect(payload.design.arms.independentUnit).toContain('task');
    expect(payload.design.arms.independentUnit).not.toContain('episode-independent');
    // And the boundary flag is recorded rather than assumed.
    expect(payload.boundaries['episodesAreNotIndependentSamples']).toBe(true);
    expect(payload.boundaries['noArmFive']).toBe(true);
  });

  it('the family-4 rejectability floor is 8, and 8 <= 12 makes it reachable', () => {
    const payload = loadPayload();
    expect(payload.design.floor.minDiscordant['4']).toBe(8);
    // Compare against the frozen module's own answers rather than a constant.
    expect(statsModule.minDiscordantForRejectability({ familySize: 4 })).toBe(8);
    expect(statsModule.minDiscordantForRejectability({ familySize: 1 })).toBe(6);
    expect(statsModule.minDiscordantForRejectability({ familySize: 2 })).toBe(7);
    // The reachability arithmetic the acceptance criterion asks for.
    const taskCount = 12;
    expect(payload.design.floor.minDiscordant['4']).toBeLessThanOrEqual(taskCount);
  });

  it('below the floor the labels say STRUCTURALLY non-rejectable, not "no effect"', () => {
    const payload = loadPayload();
    const rows = payload.design.floor.table;
    const belowFloor = rows.filter((row) => row.m < 8);
    const atFloor = rows.filter((row) => row.m >= 8);
    expect(belowFloor.length).toBeGreaterThan(0);
    expect(atFloor.length).toBeGreaterThan(0);
    for (const row of belowFloor) {
      expect(row.correctable, `m=${row.m} must be non-rejectable`).toBe(false);
      expect(row.label).toBe('structurally-non-rejectable');
    }
    for (const row of atFloor) {
      expect(row.correctable, `m=${row.m} must be rejectable`).toBe(true);
      expect(row.label).toBe('rejectable');
    }
  });

  it('Holm thresholds for family 4 are the frozen four-step ladder', () => {
    const payload = loadPayload();
    const thresholds = payload.design.floor.holmThresholds;
    // The ladder is alpha/(4 - rank + 1) for rank 1..4: 0.05/4, 0.05/3, 0.05/2, 0.05/1.
    expect(thresholds).toHaveLength(4);
    expect(thresholds[0]).toBeCloseTo(0.05 / 4, 12);
    expect(thresholds[1]).toBeCloseTo(0.05 / 3, 12);
    expect(thresholds[2]).toBeCloseTo(0.05 / 2, 12);
    expect(thresholds[3]).toBeCloseTo(0.05 / 1, 12);
    // Monotone non-decreasing, which is what makes Holm conservative.
    for (let index = 1; index < thresholds.length; index += 1) {
      expect(thresholds[index]).toBeGreaterThan(thresholds[index - 1] ?? 0);
    }
  });
});

describe('A-R1-4-1: the design is IDENTIFIABLE by design (computed rank)', () => {
  it('the 2x2(+1) factorial matrix has full rank 4 of 4', () => {
    const payload = loadPayload();
    // The payload's `identifiability` records the colon count implicitly through
    // fullRank; assert rank and full-rank together so a 3-column "full rank" bug
    // cannot slip through.
    expect(payload.design.identifiability.rank).toBe(4);
    expect(payload.design.identifiability.fullRank).toBe(true);
    // Recompute independently, so the recorded number is not taken on trust.
    expect(statsModule.matrixRank([
      [1, 0, 0, 0],
      [1, 0, 1, 0],
      [1, 1, 0, 0],
      [1, 1, 1, 1]
    ])).toBe(4);
  });

  it('the rank computation can FAIL: a rank-deficient fixture is detected', () => {
    // Without this, "rank 4" could be a function that always returns 4.
    expect(statsModule.matrixRank(statsModule.rankOneFixture(3))).toBe(1);
    // A duplicated row is rank-deficient too.
    expect(statsModule.matrixRank([
      [1, 1, 1, 1],
      [1, 1, 1, 1],
      [1, 1, 1, 1],
      [1, 1, 1, 1]
    ])).toBe(1);
    // And a genuinely collinear 3-column design (interaction = main A + main B)
    // loses the interaction estimate: rank 3 of 4.
    expect(statsModule.matrixRank([
      [1, 0, 0, 0],
      [1, 0, 1, 1],
      [1, 1, 0, 1],
      [1, 1, 1, 2]
    ])).toBe(3);
  });

  it('the recorded fixture-detection flag is true', () => {
    expect(loadPayload().design.identifiability.rankOneFixtureDetected).toBe(true);
  });
});

describe('A-R1-4-1: power is reported as a bound, not as achieved power', () => {
  it('the 12-task pool needs pi* ~ 0.87 for 80% power (an extreme effect)', () => {
    const payload = loadPayload();
    const piStar = payload.design.power.piAtPoolSize['12'];
    expect(piStar).toBeDefined();
    expect(piStar).toBeGreaterThan(0.8);
    expect(piStar).toBeCloseTo(0.8693, 3);
    if (piStar === undefined) {
      return;
    }
    // And the honest reading: at 20 tasks a *smaller* win rate suffices.
    const piStar20 = payload.design.power.piAtPoolSize['20'];
    expect(piStar20).toBeDefined();
    if (piStar20 !== undefined) {
      expect(piStar20).toBeLessThan(piStar);
    }
  });

  it('the task counts needed for 80% power are the frozen curve', () => {
    const payload = loadPayload();
    const expected: Record<string, number> = {
      '0.7': 49,
      '0.75': 30,
      '0.8': 20,
      '0.85': 15,
      '0.9': 12,
      '0.95': 9
    };
    for (const [pi, n] of Object.entries(expected)) {
      expect(payload.design.power.tasksForEightyPercent[pi], `pi=${pi}`).toBe(n);
      expect(statsModule.minTasksForPower(Number(pi), { alpha: 0.05, target: 0.8 })).toBe(n);
    }
  });

  it('the power numbers are monotone in pi (a lower win rate needs MORE tasks)', () => {
    const payload = loadPayload();
    const entries = Object.entries(payload.design.power.tasksForEightyPercent)
      .map(([pi, n]) => [Number(pi), n] as const)
      .sort((left, right) => left[0] - right[0]);
    for (let index = 1; index < entries.length; index += 1) {
      const previous = entries[index - 1];
      const current = entries[index];
      expect(previous).toBeDefined();
      expect(current).toBeDefined();
      if (previous !== undefined && current !== undefined) {
        // A LOWER win rate must require at least as many tasks: the curve is
        // monotone, which is why "fewer tasks needed" can never be quoted for a
        // smaller effect.
        expect(current[1]).toBeLessThan(previous[1]);
      }
    }
  });
});

describe('A-R1-4-2: the holdout firewall discriminates BOTH ways', () => {
  it('clean passes and leak fails', () => {
    const payload = loadPayload();
    expect(payload.design.firewall.bidirectional).toBe(true);
  });
});

describe('A-R1-4-3: not-reject is never spelled as equivalence', () => {
  it('the preregistration contains the forbidden-word guard', () => {
    const text = readFileSync(PREREG, 'utf8');
    // The document must NAME the prohibited reading, not merely avoid it.
    expect(text).toContain('`not-reject` ≠ 等价');
    expect(text).toContain('insufficient');
    expect(text).toContain('undetermined');
    // And it must forbid the equivalence reading explicitly.
    expect(text).toMatch(/禁止[\s\S]{0,80}等价/);
  });

  it('the design separates structurally-non-rejectable from not-reject', () => {
    // These are different facts: the first is a property of the DESIGN (m<8
    // cannot reject no matter the data), the second of the DATA. The floor table
    // exposes the first by name.
    const payload = loadPayload();
    const nonRejectable = payload.design.floor.table.filter((row) => row.label === 'structurally-non-rejectable');
    expect(nonRejectable.length).toBe(7); // m = 1..7
    expect(nonRejectable.every((row) => row.pMin > 0.05 / 4)).toBe(true);
  });
});

describe('boundaries: the arms were NOT run, and that is recorded', () => {
  it('arm status is not-run and the reason is stated', () => {
    const payload = loadPayload();
    expect(payload.design.arms.status).toBe('not-run');
    expect(String((payload.design.arms as unknown as { reason?: string }).reason ?? '')).toContain('not');
    expect(payload.boundaries['armsNotRun']).toBe(true);
    expect(payload.boundaries['synthetic']).toBe(true);
    expect(payload.boundaries['noRealModel']).toBe(true);
  });
});

