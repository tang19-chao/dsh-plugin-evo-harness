/**
 * P3-1: independent recheck of the FROZEN PR4A V2 results (rev5 t12).
 *
 * WHAT THIS IS
 * ------------
 * C-6 bans new repeated sampling before a pre-registration amendment, so this
 * task does NOT re-run the eval and does NOT add an Arm-5. It re-derives the
 * frozen artifact's numbers FROM THE FROZEN PER-TASK DATA, independently of the
 * code that produced them:
 *
 *   1. the four 2×2(+1) estimator series are recomputed from the pairwise
 *      deltas (Arm-0 = reference), not read back from `controlledSeries`;
 *   2. per-estimator n / mean / sd / 胜平负 / m_disc, the exact sign-flip p
 *      (2^m enumeration over discordant pairs) and the Clopper–Pearson
 *      `exactInterval` are recomputed with self-contained math;
 *   3. Holm (controlled family, m=4) and BH (exploratory family, m=10) are
 *      recomputed and compared with the frozen `pAdjusted` / `q`;
 *   4. the holdout firewall is re-run against the FROZEN artifact itself
 *      (clean) and against a planted leak (must be caught);
 *   5. the same-budget property is checked: every arm shares one design
 *      (5 episodes × 3 rounds × 12 tasks = 180 ledger rows), the exploration
 *      allowance is pinned at 0, and `roundsAreNotSamples` is declared;
 *   6. the pre-registered power/precision figures are re-executed through the
 *      frozen CLI (`scripts/eval/pr4a-stats.verify.mjs`), whose §8.7 output is
 *      the ONLY power claim this report may cite.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is not a fresh experiment: no seed is drawn, no arm is re-sampled, and no
 * equivalence is claimed anywhere (`not-reject` + `insufficient` is the honest
 * verdict, and it is NOT compressible into "no effect" — see the tuple test).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURE_PATH = path.join(repoRoot, 'tests/fixtures/pr4a/pr4a-five-arm-eval.json');

// ---------------------------------------------------------------------------
// local, minimal types over the frozen artifact (no 365 KB JSON type inference)
// ---------------------------------------------------------------------------

interface ControlledEntry {
  readonly id: string;
  readonly label: string;
  readonly n: number;
  readonly meanDelta: number;
  readonly sd: number;
  readonly wins: number;
  readonly ties: number;
  readonly losses: number;
  readonly discordantPairs: number;
  readonly pPrimary: number;
  readonly pRaw: number;
  readonly pSignFlip: number;
  readonly signFlipPatterns: number;
  readonly primaryTest: string;
  readonly binarySeries: boolean;
  readonly exactInterval: { readonly lower: number; readonly upper: number; readonly method: string };
  readonly randomizationInterval: { readonly lower: number; readonly upper: number; readonly grid: number; readonly method: string };
  readonly intervalWidth: number;
  readonly band: string;
  readonly pAdjusted: number;
  readonly significantAfterCorrection: boolean;
  readonly degradation: { readonly dts: number; readonly degradedTasks: readonly string[] };
  readonly verdict: {
    readonly significance: string;
    readonly direction: string;
    readonly degradationStatus: string;
    readonly evidenceStatus: string;
  };
}

interface SeriesRow {
  readonly taskId: string;
  readonly cells: readonly number[];
}

interface ExploratoryEntry {
  readonly left: string;
  readonly right: string;
  readonly n: number;
  readonly meanDelta: number;
  readonly wins: number;
  readonly ties: number;
  readonly losses: number;
  readonly discordantPairs: number;
  readonly binarySeries: boolean;
  readonly pPrimary: number;
  readonly pRaw: number;
  readonly q: number;
  readonly perTask: readonly { readonly taskId: string; readonly left: number; readonly right: number; readonly delta: number }[];
}

interface Artifact {
  readonly protocol: string;
  readonly design: {
    readonly arms: readonly { readonly id: string; readonly role: string; readonly writesBack: boolean; readonly conservativeGate: boolean }[];
    readonly episodes: number;
    readonly rounds: number;
    readonly tasks: number;
    readonly explorationAllowance: number;
    readonly taskOrder: readonly string[];
  };
  readonly replication: { readonly episodes: number; readonly effectiveReplication: number };
  readonly comparisons: {
    readonly controlled: readonly ControlledEntry[];
    readonly controlledSeries: { readonly rows: readonly SeriesRow[] };
    readonly pairwiseTable: { readonly columns: readonly string[]; readonly rows: readonly { readonly taskId: string; readonly cells: readonly number[] }[] };
    readonly exploratory: readonly ExploratoryEntry[];
    readonly familySeparation: { readonly controlledFamily: string; readonly exploratoryFamily: string; readonly rule: string };
  };
  readonly declarations: {
    readonly analysisUnit: string;
    readonly roundsAreNotSamples: boolean;
    readonly powerIsClosedFormApproximation: string;
    readonly minDetectableD: number;
    readonly minDetectableWinRate: number;
    readonly exactPowerTable: readonly { readonly pi: number; readonly power: number }[];
  };
}

const artifact = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Artifact;
const controlled = artifact.comparisons.controlled;
const series = artifact.comparisons.controlledSeries.rows;
const pairwise = artifact.comparisons.pairwiseTable;

// ---------------------------------------------------------------------------
// independent math (deliberately NOT imported from scripts/eval/pr4a-stats.ts)
// ---------------------------------------------------------------------------

const EPS = 1e-9;
const MINUS = '\u2212';

function pairwiseColumnIndex(left: string, right: string): number {
  const wanted = left + MINUS + right;
  const index = pairwise.columns.findIndex((name) => name === wanted);
  if (index < 0) {
    throw new Error('missing pairwise column ' + wanted);
  }
  return index;
}

/** Arm values per task from the pairwise deltas, Arm-0 = 0 reference. */
function armValuesByTask(): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const row of pairwise.rows) {
    const values = [0];
    for (let arm = 1; arm <= 4; arm += 1) {
      const column = pairwiseColumnIndex('Arm-0', 'Arm-' + String(arm));
      const delta = row.cells[column];
      if (delta === undefined) {
        throw new Error('missing pairwise cell for ' + row.taskId);
      }
      values.push(-delta);
    }
    map.set(row.taskId, values);
  }
  return map;
}

const armsByTask = armValuesByTask();

/** The four pre-registered 2×2(+1) estimators (frozen labels, report §3). */
function estimatorValue(kind: 'write' | 'track' | 'gate' | 'interaction', taskId: string): number {
  const a = armsByTask.get(taskId);
  if (a === undefined) {
    throw new Error('missing arm values for ' + taskId);
  }
  const [a0, a1, a2, a3, a4] = a;
  if (a0 === undefined || a1 === undefined || a2 === undefined || a3 === undefined || a4 === undefined) {
    throw new Error('incomplete arm values for ' + taskId);
  }
  switch (kind) {
    case 'write':
      return a1 - a0;
    case 'track':
      return 0.5 * (a3 - a1 + (a4 - a2));
    case 'gate':
      return 0.5 * (a2 - a1 + (a4 - a3));
    case 'interaction':
      return a4 - a3 - (a2 - a1);
  }
}

interface SeriesSummary {
  readonly n: number;
  readonly mean: number;
  readonly sd: number;
  readonly wins: number;
  readonly ties: number;
  readonly losses: number;
  readonly mDisc: number;
}

function summarise(values: readonly number[]): SeriesSummary {
  const n = values.length;
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1);
  const wins = values.filter((value) => value > EPS).length;
  const losses = values.filter((value) => value < -EPS).length;
  return { n, mean, sd: Math.sqrt(variance), wins, ties: n - wins - losses, losses, mDisc: wins + losses };
}

/** Exact two-sided sign test on the discordant pairs by enumerating 2^m. */
function exactSignFlipP(values: readonly number[]): number {
  const discordant = values.filter((value) => Math.abs(value) > EPS);
  const m = discordant.length;
  if (m === 0) {
    return 1;
  }
  const observed = Math.abs(discordant.reduce((sum, value) => sum + value, 0));
  let hits = 0;
  const total = Math.pow(2, m);
  for (let mask = 0; mask < total; mask += 1) {
    let flipped = 0;
    for (let i = 0; i < m; i += 1) {
      const value = discordant[i];
      if (value === undefined) {
        throw new Error('unreachable');
      }
      flipped += (mask >> i) % 2 === 1 ? -value : value;
    }
    if (Math.abs(flipped) >= observed - EPS) {
      hits += 1;
    }
  }
  return hits / total;
}

function choose(n: number, k: number): number {
  let result = 1;
  for (let i = 0; i < k; i += 1) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}

function binomialTailAtLeast(wins: number, m: number, pi: number): number {
  let sum = 0;
  for (let u = wins; u <= m; u += 1) {
    sum += choose(m, u) * Math.pow(pi, u) * Math.pow(1 - pi, m - u);
  }
  return sum;
}

function binomialTailAtMost(wins: number, m: number, pi: number): number {
  let sum = 0;
  for (let u = 0; u <= wins; u += 1) {
    sum += choose(m, u) * Math.pow(pi, u) * Math.pow(1 - pi, m - u);
  }
  return sum;
}

/** Clopper–Pearson 95% interval on the win probability over discordant pairs. */
function clopperPearson(wins: number, m: number): { lower: number; upper: number } {
  if (m === 0) {
    return { lower: 0, upper: 1 };
  }
  const bisect = (tail: (pi: number) => number, target: number, increasing: boolean): number => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 200; i += 1) {
      const mid = (lo + hi) / 2;
      const value = tail(mid);
      if (increasing ? value < target : value > target) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return (lo + hi) / 2;
  };
  return {
    lower: wins === 0 ? 0 : bisect((pi) => binomialTailAtLeast(wins, m, pi), 0.025, true),
    upper: wins === m ? 1 : bisect((pi) => binomialTailAtMost(wins, m, pi), 0.025, false)
  };
}

/** Holm–Bonferroni step-down with monotonicity, returns adjusted p in input order. */
function holm(pValues: readonly number[]): number[] {
  const m = pValues.length;
  const order = pValues.map((p, index) => ({ p, index })).sort((a, b) => a.p - b.p);
  const adjusted = new Array<number>(m).fill(1);
  let runningMax = 0;
  for (let rank = 0; rank < m; rank += 1) {
    const entry = order[rank];
    if (entry === undefined) {
      throw new Error('unreachable');
    }
    runningMax = Math.max(runningMax, (m - rank) * entry.p);
    adjusted[entry.index] = Math.min(1, runningMax);
  }
  return adjusted;
}

/** Benjamini–Hochberg FDR q-values in input order. */
function benjaminiHochberg(pValues: readonly number[]): number[] {
  const m = pValues.length;
  const order = pValues.map((p, index) => ({ p, index })).sort((a, b) => a.p - b.p);
  const q = new Array<number>(m).fill(1);
  let runningMin = 1;
  for (let rank = m - 1; rank >= 0; rank -= 1) {
    const entry = order[rank];
    if (entry === undefined) {
      throw new Error('unreachable');
    }
    runningMin = Math.min(runningMin, (m * entry.p) / (rank + 1));
    q[entry.index] = Math.min(1, runningMin);
  }
  return q;
}

// ---------------------------------------------------------------------------
// 1. the estimator series reproduce from the pairwise deltas
// ---------------------------------------------------------------------------

describe('P3-1: the four 2×2(+1) estimator series recompute from the frozen per-task deltas', () => {
  const KINDS = ['write', 'track', 'gate', 'interaction'] as const;

  it('every controlledSeries cell matches the independently recomputed estimator', () => {
    expect(series).toHaveLength(12);
    let maxResidual = 0;
    for (const row of series) {
      KINDS.forEach((kind, column) => {
        const recomputed = estimatorValue(kind, row.taskId);
        const frozen = row.cells[column];
        if (frozen === undefined) {
          throw new Error('missing series cell for ' + row.taskId);
        }
        maxResidual = Math.max(maxResidual, Math.abs(recomputed - frozen));
      });
    }
    expect(maxResidual).toBeLessThanOrEqual(1e-12);
  });

  it('the collinearity identity θ_track = −(θ_write + θ_gate) holds with residual 0', () => {
    // Frozen report §3.3: the identity is the EXECUTABLE PROOF that θ_track is
    // rank-deficient w.r.t. the track factor — its above-MMI band is NOT
    // positive track evidence. The recheck must reproduce the residual.
    let maxResidual = 0;
    for (const row of series) {
      const write = estimatorValue('write', row.taskId);
      const gate = estimatorValue('gate', row.taskId);
      const track = estimatorValue('track', row.taskId);
      maxResidual = Math.max(maxResidual, Math.abs(track + write + gate));
    }
    expect(maxResidual).toBeLessThanOrEqual(1e-12);
  });

  it('the quality arms are frozen on every task (interaction unidentifiable)', () => {
    // Arm-3 ≡ Arm-4 ≡ Arm-0 per task ⇒ θ_track/θ_int carry no quality-row term.
    for (const row of pairwise.rows) {
      const a3 = row.cells[pairwiseColumnIndex('Arm-0', 'Arm-3')];
      const a4 = row.cells[pairwiseColumnIndex('Arm-0', 'Arm-4')];
      const a34 = row.cells[pairwiseColumnIndex('Arm-3', 'Arm-4')];
      expect(a3).toBe(0);
      expect(a4).toBe(0);
      expect(a34).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. per-estimator stats, exact p, and intervals recompute
// ---------------------------------------------------------------------------

describe('P3-1: per-estimator stats, exact p and CIs recompute from the series', () => {
  const KINDS = ['write', 'track', 'gate', 'interaction'] as const;

  it('n / mean / sd / 胜平负 / m_disc match the frozen controlled table', () => {
    expect(controlled).toHaveLength(4);
    for (const [column, kind] of KINDS.entries()) {
      const values = series.map((row) => estimatorValue(kind, row.taskId));
      const summary = summarise(values);
      const frozen = controlled[column];
      if (frozen === undefined) {
        throw new Error('missing controlled entry ' + String(column));
      }
      expect(frozen.id).toBe(['write-back', 'track', 'gate', 'interaction'][column]);
      expect(summary.n).toBe(frozen.n);
      expect(summary.mean).toBeCloseTo(frozen.meanDelta, 12);
      expect(summary.sd).toBeCloseTo(frozen.sd, 6);
      expect(summary.wins).toBe(frozen.wins);
      expect(summary.ties).toBe(frozen.ties);
      expect(summary.losses).toBe(frozen.losses);
      expect(summary.mDisc).toBe(frozen.discordantPairs);
    }
  });

  it('the primary p is the exact sign-flip test enumerated over 2^m discordant pairs', () => {
    for (const [column, kind] of KINDS.entries()) {
      const values = series.map((row) => estimatorValue(kind, row.taskId));
      const recomputed = exactSignFlipP(values);
      const frozen = controlled[column];
      if (frozen === undefined) {
        throw new Error('missing controlled entry ' + String(column));
      }
      expect(recomputed).toBeCloseTo(frozen.pPrimary, 12);
      expect(frozen.pRaw).toBeCloseTo(frozen.pPrimary, 12);
      expect(frozen.pSignFlip).toBeCloseTo(frozen.pPrimary, 12);
      // 2^m enumeration: the frozen pattern space is 2^N = 4096; ties fold in
      // symmetrically, so the p over the discordant subset is identical.
      expect(Math.log2(frozen.signFlipPatterns)).toBe(12);
      expect(frozen.primaryTest).toContain('exact-paired-randomization-sign-flip');
    }
  });

  it('the exactInterval is Clopper–Pearson on the win share over discordant pairs', () => {
    for (const [column, kind] of KINDS.entries()) {
      const values = series.map((row) => estimatorValue(kind, row.taskId));
      const summary = summarise(values);
      const interval = clopperPearson(summary.wins, summary.mDisc);
      const frozen = controlled[column];
      if (frozen === undefined) {
        throw new Error('missing controlled entry ' + String(column));
      }
      expect(frozen.exactInterval.method).toBe('exact-binomial-inversion on discordant pairs');
      expect(interval.lower).toBeCloseTo(frozen.exactInterval.lower, 6);
      expect(interval.upper).toBeCloseTo(frozen.exactInterval.upper, 6);
    }
  });

  it('the randomizationInterval re-runs from the frozen rerun commands', async () => {
    const stats = (await import(
      pathToFileURL(path.join(repoRoot, 'scripts/eval/pr4a-stats.ts')).href
    )) as {
      randomizationInversionInterval(
        deltas: readonly number[],
        options?: { readonly alpha?: number; readonly step?: number }
      ): { readonly lower: number; readonly upper: number; readonly grid: number; readonly method: string };
    };
    for (const [column, kind] of KINDS.entries()) {
      const values = series.map((row) => estimatorValue(kind, row.taskId));
      const interval = stats.randomizationInversionInterval(values, { alpha: 0.05, step: 0.005 });
      const frozen = controlled[column];
      if (frozen === undefined) {
        throw new Error('missing controlled entry ' + String(column));
      }
      expect(interval.lower).toBeCloseTo(frozen.randomizationInterval.lower, 6);
      expect(interval.upper).toBeCloseTo(frozen.randomizationInterval.upper, 6);
      expect(interval.grid).toBe(frozen.randomizationInterval.grid);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. multiplicity: Holm (controlled, m=4) and BH (exploratory, m=10)
// ---------------------------------------------------------------------------

describe('P3-1: multiplicity control recomputes exactly', () => {
  const KINDS = ['write', 'track', 'gate', 'interaction'] as const;

  it('Holm over the 4 controlled pPrimary reproduces pAdjusted (and nothing is significant)', () => {
    const primary = KINDS.map((kind) => exactSignFlipP(series.map((row) => estimatorValue(kind, row.taskId))));
    const adjusted = holm(primary);
    adjusted.forEach((value, index) => {
      const frozen = controlled[index];
      if (frozen === undefined) {
        throw new Error('missing controlled entry ' + String(index));
      }
      expect(value).toBeCloseTo(frozen.pAdjusted, 12);
      expect(frozen.significantAfterCorrection).toBe(false);
    });
  });

  it('BH over the 10 exploratory pRaw reproduces q, and the families stay separate', () => {
    const exploratory = artifact.comparisons.exploratory;
    expect(exploratory).toHaveLength(10);
    const q = benjaminiHochberg(exploratory.map((entry) => entry.pRaw));
    q.forEach((value, index) => {
      const frozen = exploratory[index];
      if (frozen === undefined) {
        throw new Error('missing exploratory entry ' + String(index));
      }
      expect(value).toBeCloseTo(frozen.q, 6);
      // a q-value never falls below its raw p (FDR up-adjustment)
      expect(frozen.q).toBeGreaterThanOrEqual(frozen.pRaw - EPS);
    });
    const separation = artifact.comparisons.familySeparation;
    expect(separation.controlledFamily).toContain('Holm-Bonferroni');
    expect(separation.exploratoryFamily).toContain('BH FDR');
    expect(separation.rule).toContain('never merged');
  });

  it('the exploratory pairwise stats recompute from their own per-task data', () => {
    for (const entry of artifact.comparisons.exploratory) {
      const deltas = entry.perTask.map((task) => task.delta);
      const summary = summarise(deltas);
      expect(summary.n).toBe(entry.n);
      expect(summary.mean).toBeCloseTo(entry.meanDelta, 12);
      expect(summary.wins).toBe(entry.wins);
      expect(summary.ties).toBe(entry.ties);
      expect(summary.losses).toBe(entry.losses);
      expect(summary.mDisc).toBe(entry.discordantPairs);
      expect(exactSignFlipP(deltas)).toBeCloseTo(entry.pPrimary, 12);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. same-budget sampling + holdout firewall
// ---------------------------------------------------------------------------

describe('P3-1: same-budget multi-sampling and the metrics-blind holdout', () => {
  it('every arm shares one budget: 5 episodes × 3 rounds × 12 tasks, allowance 0', () => {
    const design = artifact.design;
    expect(design.episodes).toBe(5);
    expect(design.rounds).toBe(3);
    expect(design.tasks).toBe(12);
    expect(design.taskOrder).toHaveLength(12);
    expect(design.explorationAllowance).toBe(0);
    // one design object, shared by all five arms (no per-arm budget drift):
    // exactly the frozen reference never writes back, the other four do, and
    // the gate factor is exactly two arms on / two arms off.
    expect(design.arms).toHaveLength(5);
    const reference = design.arms.filter((arm) => arm.role === 'reference');
    expect(reference).toHaveLength(1);
    expect(reference[0]?.writesBack).toBe(false);
    expect(design.arms.filter((arm) => arm.role !== 'reference').every((arm) => arm.writesBack)).toBe(true);
    expect(design.arms.filter((arm) => arm.conservativeGate)).toHaveLength(2);
    // the replication block says the same thing honestly: episodes ≠ samples
    expect(artifact.replication.episodes).toBe(5);
    expect(artifact.replication.effectiveReplication).toBeLessThan(5);
    expect(artifact.declarations.roundsAreNotSamples).toBe(true);
    expect(artifact.declarations.analysisUnit).toContain('task');
  });

  it('each frozen arm ledger holds the same 180 rows (12 × 5 × 3)', () => {
    for (let arm = 0; arm <= 4; arm += 1) {
      const ledger = readFileSync(
        path.join(repoRoot, 'tests/fixtures/pr4a/pr4a-ledger-Arm-' + String(arm) + '.jsonl'),
        'utf8'
      );
      const rows = ledger.split('\n').filter((line) => line.trim().length > 0);
      expect(rows).toHaveLength(180);
    }
  });

  it('the frozen split manifest has holdout share 0.25 and dev/holdout are disjoint', async () => {
    const verify = (await import(
      pathToFileURL(path.join(repoRoot, 'scripts/eval/pr4a-stats.verify.mjs')).href
    )) as {
      V3_FROZEN_TASK_TABLE_DIGEST: string;
      computeV3Split(
        table: readonly { readonly id: string; readonly family: string }[]
      ): {
        development: { readonly families: readonly string[]; readonly taskIds: readonly string[] };
        holdout: { readonly families: readonly string[]; readonly taskIds: readonly string[] };
        shares: { readonly development: number; readonly holdout: number };
      };
      splitManifestDigest(manifest: unknown): string;
      checkHoldoutFirewall(
        manifest: unknown,
        artifacts: readonly { readonly path: string; readonly content: string }[]
      ): { readonly ok: boolean; readonly violations: readonly { readonly kind: string; readonly detail: string }[] };
    };
    const designModule = (await import(
      pathToFileURL(path.join(repoRoot, 'scripts/eval/pr4a-v3-design.mjs')).href
    )) as { readonly V3_TASKS: readonly { readonly id: string; readonly family: string }[] };
    const table = designModule.V3_TASKS;
    const split = verify.computeV3Split(table);
    expect(split.shares.holdout).toBeCloseTo(0.25, 6);
    expect(split.shares.development).toBeCloseTo(0.75, 6);
    const holdoutSet = new Set(split.holdout.taskIds);
    for (const id of split.development.taskIds) {
      expect(holdoutSet.has(id)).toBe(false);
    }
    expect(split.development.taskIds.length + split.holdout.taskIds.length).toBe(table.length);
    // the frozen split digest is reproducible from the committed table
    const digest = verify.splitManifestDigest({ ...split, digest: verify.splitManifestDigest(split) });
    expect(digest).toBe(verify.splitManifestDigest({ ...split, digest }));
  });

  it('the holdout firewall passes on the FROZEN artifact and catches a planted leak', async () => {
    const verify = (await import(
      pathToFileURL(path.join(repoRoot, 'scripts/eval/pr4a-stats.verify.mjs')).href
    )) as {
      computeV3Split(
        table: readonly { readonly id: string; readonly family: string }[]
      ): {
        holdout: { readonly taskIds: readonly string[] };
        development: { readonly taskIds: readonly string[] };
      };
      splitManifestDigest(manifest: unknown): string;
      checkHoldoutFirewall(
        manifest: unknown,
        artifacts: readonly { readonly path: string; readonly content: string }[]
      ): { readonly ok: boolean; readonly violations: readonly { readonly kind: string; readonly detail: string }[] };
    };
    const designModule = (await import(
      pathToFileURL(path.join(repoRoot, 'scripts/eval/pr4a-v3-design.mjs')).href
    )) as { readonly V3_TASKS: readonly { readonly id: string; readonly family: string }[] };
    const split = verify.computeV3Split(designModule.V3_TASKS);
    const manifest = { ...split, digest: verify.splitManifestDigest(split) };

    // clean: the frozen artifact itself contains no holdout id
    const clean = verify.checkHoldoutFirewall(manifest, [
      { path: 'tests/fixtures/pr4a/pr4a-five-arm-eval.json', content: readFileSync(FIXTURE_PATH, 'utf8') }
    ]);
    expect(clean.ok).toBe(true);
    expect(clean.violations).toEqual([]);

    // leak: a selection artifact that names a holdout id must be caught
    const leak = verify.checkHoldoutFirewall(manifest, [
      { path: 'work/leaked-selection.json', content: JSON.stringify({ pool: split.holdout.taskIds }) }
    ]);
    expect(leak.ok).toBe(false);
    expect(leak.violations.some((violation) => violation.kind === 'holdout-in-selection-artifact')).toBe(true);
    expect(leak.violations.some((violation) => violation.detail.includes('v3-ci-01'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. pre-registered power/precision + the honest-verdict rule
// ---------------------------------------------------------------------------

describe('P3-1: the pre-registered power and the honest verdict reproduce', () => {
  it('the frozen stats-verify CLI reproduces every pre-registered table (exit 0)', () => {
    const run = spawnSync(process.execPath, ['scripts/eval/pr4a-stats.verify.mjs'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120_000
    });
    expect(run.status).toBe(0);
    const output = (run.stdout ?? '') + (run.stderr ?? '');
    expect(output).toContain('SUCCESS');
    // §8.7 closed-form approximation power curve + the pre-registered figures
    expect(output).toContain('pi*=0.869');
    expect(output).toContain('d_min=0.809');
    // V3 rejectability floor and the exact sign-flip power
    expect(output).toContain('m_disc>=8');
    expect(output).toContain('pi*=0.9011');
    // the frozen metrics-blind split
    expect(output).toContain('holdout=ci-fix share=0.25');
  });

  it('the artifact pins the power figures it declares (no silent re-derivation)', () => {
    const declarations = artifact.declarations;
    expect(declarations.powerIsClosedFormApproximation).toContain('NOT an executed power analysis');
    expect(declarations.minDetectableD).toBeCloseTo(0.8087, 4);
    expect(declarations.minDetectableWinRate).toBeCloseTo(0.8693, 4);
    expect(declarations.exactPowerTable).toHaveLength(5);
    for (const row of declarations.exactPowerTable) {
      expect(row.power).toBeGreaterThan(0);
      expect(row.power).toBeLessThan(1);
    }
  });

  it('no equivalence is claimed: not-reject stays with insufficient (never compressed)', () => {
    for (const entry of controlled) {
      expect(entry.verdict.significance).toBe('not-reject');
      expect(entry.verdict.evidenceStatus).toBe('insufficient');
      expect(entry.significantAfterCorrection).toBe(false);
      // the 4-tuple is preserved: degradation and insufficiency CAN coexist
      expect(entry.verdict.degradationStatus === 'degraded' || entry.verdict.evidenceStatus === 'insufficient').toBe(true);
      const verdictJson = JSON.stringify(entry.verdict);
      expect(verdictJson).not.toMatch(/equivalent/i);
      expect(verdictJson).not.toMatch(/no[-_]?effect/i);
    }
    // and the write-back row really does carry BOTH flags at once (V2 §8.5)
    const writeBack = controlled[0];
    if (writeBack === undefined) {
      throw new Error('missing write-back row');
    }
    expect(writeBack.verdict.degradationStatus).toBe('degraded');
    expect(writeBack.verdict.evidenceStatus).toBe('insufficient');
  });

  it('Arm-5 does not exist and the controlled family is exactly the pre-registered 4', () => {
    expect(artifact.design.arms.map((arm) => arm.id)).toEqual(['Arm-0', 'Arm-1', 'Arm-2', 'Arm-3', 'Arm-4']);
    expect(controlled.map((entry) => entry.id)).toEqual(['write-back', 'track', 'gate', 'interaction']);
    const raw = readFileSync(FIXTURE_PATH, 'utf8');
    expect(raw).not.toContain('Arm-5');
    expect(raw.toLowerCase()).not.toContain('"arm5"');
  });
});
