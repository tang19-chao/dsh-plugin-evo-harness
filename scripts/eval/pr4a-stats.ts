/**
 * PR-4A five-arm orthogonal experiment — statistics layer.
 *
 * Implements the pre-registered analysis of
 * `docs/reports/pr4a-five-arm-experiment-preregistration.md`
 * (protocol `PR4A-EVAL-PREREG-20261027-V2`, §8). Pure functions only: no I/O,
 * no clock, no randomness. That is what makes "the report is reproducible"
 * checkable instead of asserted.
 *
 * Section map:
 *   §8.2  paired deltas, wins/ties/losses, discordant pairs m_disc
 *   §8.3.1 exact McNemar (two-sided) + rejection boundary + exact interval
 *   §8.3.2 exact paired randomization (sign-flip) + inversion interval
 *   §8.4  width budget as a function of sigma
 *   §8.5  decision bands + the FOUR-DIMENSION tuple (dimensions never overlap)
 *   §8.7  closed-form d_min (labelled approximate) + exact power
 *
 * Hard rules encoded here, not just documented:
 *   - rounds are never treated as independent samples (analysis unit = task);
 *   - Wilcoxon is NOT available for binary data (it is not exported at all);
 *   - the two `m`s stay distinguishable: `discordantPairs` vs `familySize`;
 *   - "not significant" never implies "not degraded" (independent dimensions).
 */

// ---------------------------------------------------------------------------
// §8.2 paired description
// ---------------------------------------------------------------------------

/** One paired observation: the same task measured under two arms. */
export interface PairedObservation {
  readonly taskId: string;
  readonly left: number;
  readonly right: number;
}

/** Descriptive summary of a paired comparison. */
export interface PairedSummary {
  readonly pairs: number;
  readonly meanDelta: number;
  readonly sd: number;
  readonly wins: number;
  readonly ties: number;
  readonly losses: number;
  /** §8.2: m_disc = w + l. The real information content of every exact test. */
  readonly discordantPairs: number;
  /** Signed task-level deltas, in task-id order (for the per-task table). */
  readonly deltas: readonly { readonly taskId: string; readonly delta: number }[];
}

/** Round to `digits` decimals without introducing -0. */
export function roundTo(value: number, digits = 6): number {
  if (!Number.isFinite(value)) return 0;
  const factor = Math.pow(10, digits);
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** §8.2: paired difference summary over the TASK axis only. */
export function summarisePaired(observations: readonly PairedObservation[]): PairedSummary {
  const deltas = observations.map((entry) => ({
    taskId: entry.taskId,
    delta: entry.left - entry.right
  }));
  const n = deltas.length;
  const meanDelta = n === 0 ? 0 : deltas.reduce((sum, entry) => sum + entry.delta, 0) / n;
  const sd =
    n < 2
      ? 0
      : Math.sqrt(deltas.reduce((sum, entry) => sum + (entry.delta - meanDelta) ** 2, 0) / (n - 1));
  const wins = deltas.filter((entry) => entry.delta > 1e-9).length;
  const losses = deltas.filter((entry) => entry.delta < -1e-9).length;
  return {
    pairs: n,
    meanDelta: roundTo(meanDelta),
    sd: roundTo(sd),
    wins,
    ties: n - wins - losses,
    losses,
    discordantPairs: wins + losses,
    deltas: deltas.map((entry) => ({ taskId: entry.taskId, delta: roundTo(entry.delta) }))
  };
}

// ---------------------------------------------------------------------------
// §8.3.1 exact McNemar (binary primary)
// ---------------------------------------------------------------------------

/** Binomial coefficient with exact integer arithmetic (n <= 60 is plenty here). */
function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  const kk = Math.min(k, n - k);
  let result = 1;
  for (let i = 0; i < kk; i += 1) {
    result = (result * (n - i)) / (i + 1);
  }
  return Math.round(result);
}

/**
 * Exact two-sided McNemar p-value = exact two-sided sign test on the
 * discordant pairs.
 *
 *     p(w) = min(1, 2 * sum_{u=w..m} C(m,u) 2^-m,  2 * sum_{u=0..w} C(m,u) 2^-m)
 *
 * BOTH tails are enumerated. Enumerating only the upper tail silently drops the
 * {0,1,2} region at m=12 and understates power — the exact defect fixed during
 * the pre-registration review, kept as a regression here.
 */
export function exactMcNemarTwoSided(oneDirectionalWins: number, discordantPairs: number): number {
  const m = discordantPairs;
  const w = oneDirectionalWins;
  if (!Number.isInteger(m) || m < 0) throw new RangeError('discordantPairs must be a non-negative integer');
  if (!Number.isInteger(w) || w < 0 || w > m) throw new RangeError('wins must be an integer in [0, discordantPairs]');
  let upper = 0;
  for (let u = w; u <= m; u += 1) upper += choose(m, u);
  let lower = 0;
  for (let u = 0; u <= w; u += 1) lower += choose(m, u);
  const total = Math.pow(2, m);
  return Math.min(1, (2 * upper) / total, (2 * lower) / total);
}

/**
 * Smallest one-directional win count (in the majority direction) whose exact
 * two-sided p-value clears alpha. `null` when no count suffices.
 */
export function minWinsForRejection(discordantPairs: number, alpha = 0.05): number | null {
  for (let w = Math.ceil(discordantPairs / 2); w <= discordantPairs; w += 1) {
    if (exactMcNemarTwoSided(w, discordantPairs) <= alpha) return w;
  }
  return null;
}

/**
 * Exact two-sided rejection region of the sign test at `m` discordant pairs.
 * Both tails; used by the power declaration in §8.7.
 */
export function signTestRejectionRegion(m: number, alpha = 0.05): readonly number[] {
  const region: number[] = [];
  for (let w = 0; w <= m; w += 1) {
    if (exactMcNemarTwoSided(w, m) <= alpha) region.push(w);
  }
  return region;
}

/**
 * Exact 1-alpha confidence interval for the discordant-pair win probability
 * `pi` by inverting the exact two-sided binomial test.
 *
 * Returns `[lower, upper]`; `null` bounds mean the interval endpoint is 0 or 1
 * (the inversion never rejects there), reported as such rather than clamped to a
 * fake finite value.
 */
export function exactDiscordantInterval(
  wins: number,
  losses: number,
  alpha = 0.05
): { readonly lower: number; readonly upper: number; readonly method: string } {
  const m = wins + losses;
  if (m === 0) {
    return { lower: 0, upper: 1, method: 'undefined-no-discordant-pairs' };
  }
  const total = Math.pow(2, m);
  void total;
  const upperTail = (pi: number): number => {
    // P(X >= wins) under Binomial(m, pi). INCREASING in pi (the mass shifts right).
    let sum = 0;
    for (let u = wins; u <= m; u += 1) {
      sum += choose(m, u) * Math.pow(pi, u) * Math.pow(1 - pi, m - u);
    }
    return sum;
  };
  const lowerTail = (pi: number): number => {
    // P(X <= wins) under Binomial(m, pi). DECREASING in pi.
    let sum = 0;
    for (let u = 0; u <= wins; u += 1) {
      sum += choose(m, u) * Math.pow(pi, u) * Math.pow(1 - pi, m - u);
    }
    return sum;
  };
  /**
   * Bisect for the pi where a MONOTONE tail probability crosses `target`.
   * `increasing` describes the tail's direction in pi, and therefore which side
   * of the midpoint the solution lies on. Getting this flag backwards produces
   * an interval whose bounds are each other's mirror image - the bug this
   * function's own verification caught.
   */
  const solve = (fn: (pi: number) => number, target: number, increasing: boolean): number => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 200; i += 1) {
      const mid = (lo + hi) / 2;
      const value = fn(mid);
      if (increasing) {
        // value rises with pi: below target => the crossing is to the right
        if (value < target) lo = mid;
        else hi = mid;
      } else {
        // value falls with pi: above target => the crossing is to the right
        if (value > target) lo = mid;
        else hi = mid;
      }
    }
    return (lo + hi) / 2;
  };
  // Clopper-Pearson: lower solves P(X >= w | pi) = alpha/2 (increasing),
  // upper solves P(X <= w | pi) = alpha/2 (decreasing).
  const lower = wins === 0 ? 0 : solve(upperTail, alpha / 2, true);
  const upper = wins === m ? 1 : solve(lowerTail, alpha / 2, false);
  return {
    lower: roundTo(lower),
    upper: roundTo(upper),
    method: 'exact-binomial-inversion on discordant pairs'
  };
}

// ---------------------------------------------------------------------------
// §8.3.2 exact paired randomization (rate-type metrics)
// ---------------------------------------------------------------------------

/**
 * Exact paired randomization (sign-flip) test.
 *
 * Enumerates all 2^N sign assignments of the per-task deltas and reports the
 * share whose |sum| is at least the observed |sum|. Exact by construction; no
 * distributional assumption, robust to ties.
 *
 * SR-M4/§8.1: N is the number of TASKS (12), never the number of decisions.
 * The guard below refuses an N that could only come from counting rounds as
 * samples — an explicit, failing check instead of a silent performance cliff.
 */
export function exactSignFlipTest(
  deltas: readonly number[]
): { readonly n: number; readonly observedSum: number; readonly twoSidedP: number; readonly patterns: number } {
  const n = deltas.length;
  if (n === 0) {
    return { n: 0, observedSum: 0, twoSidedP: 1, patterns: 0 };
  }
  if (n > 20) {
    throw new RangeError(
      'exact sign-flip enumeration is limited to n <= 20 (got ' +
        String(n) +
        '); an n in the hundreds means rounds/decisions were counted as independent samples, which §8.1 forbids'
    );
  }
  const observedSum = deltas.reduce((sum, value) => sum + value, 0);
  const target = Math.abs(observedSum) - 1e-12;
  const patterns = Math.pow(2, n);
  let hits = 0;
  for (let mask = 0; mask < patterns; mask += 1) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      sum += (mask >> i) & 1 ? deltas[i]! : -deltas[i]!;
    }
    if (Math.abs(sum) >= target) hits += 1;
  }
  return { n, observedSum: roundTo(observedSum), twoSidedP: hits / patterns, patterns };
}

/**
 * Randomization inversion interval for the mean paired difference.
 *
 * Inverts the sign-flip test over a grid of null shifts mu: the accepted set is
 * { mu : test(d_i - mu) does not reject }. Coarse by construction (reported as
 * a grid, not a smooth bound) — that honesty is the point: it shows exactly what
 * the 12-task design can resolve.
 */
export function randomizationInversionInterval(
  deltas: readonly number[],
  options: { readonly alpha?: number; readonly step?: number; readonly halfWidth?: number } = {}
): { readonly lower: number; readonly upper: number; readonly grid: number; readonly method: string } {
  const alpha = options.alpha ?? 0.05;
  const step = options.step ?? 0.01;
  const observed = deltas.reduce((sum, value) => sum + value, 0) / Math.max(1, deltas.length);
  const halfWidth = options.halfWidth ?? Math.max(0.5, Math.abs(observed) * 3 + 0.3);
  const start = -halfWidth;
  const stop = halfWidth;
  const count = Math.round((stop - start) / step) + 1;
  let lower: number | null = null;
  let upper: number | null = null;
  let tested = 0;
  for (let i = 0; i < count; i += 1) {
    const mu = start + i * step;
    const shifted = deltas.map((value) => value - mu);
    const p = exactSignFlipTest(shifted).twoSidedP;
    tested += 1;
    if (p > alpha) {
      if (lower === null) lower = mu;
      upper = mu;
    }
  }
  return {
    lower: roundTo(lower ?? start),
    upper: roundTo(upper ?? stop),
    grid: tested,
    method: 'randomization inversion over a ' + String(step) + ' grid (coarse, reported as such)'
  };
}

// ---------------------------------------------------------------------------
// §8.4 width budget
// ---------------------------------------------------------------------------

/** Pre-declared 95% half-widths as multiples of sigma (see V2 §8.4). */
export function widthBudget(sigma: number): {
  readonly pairedDiff: number;
  readonly mainEffect: number;
  readonly interaction: number;
} {
  const z = 1.959963985;
  const n = 12;
  return {
    pairedDiff: roundTo((z * sigma) / Math.sqrt(n)),
    mainEffect: roundTo(z * Math.sqrt((sigma * sigma) / 2 / n)),
    interaction: roundTo(z * Math.sqrt((2 * sigma * sigma) / n))
  };
}

// ---------------------------------------------------------------------------
// §8.7 power
// ---------------------------------------------------------------------------

/**
 * Closed-form normal-approximation minimum detectable effect.
 * LABELLED an approximation at the call site — it is NOT an executed power
 * analysis, and the report must never read as one.
 */
export function closedFormMinDetectableD(
  n = 12,
  alpha = 0.05,
  power = 0.8
): { readonly d: number; readonly note: string } {
  const zAlpha = alpha === 0.05 ? 1.959963985 : 1.959963985;
  const zBeta = 0.841621234;
  const d = (zAlpha + zBeta) / Math.sqrt(n);
  return {
    d: roundTo(d, 4),
    note:
      'closed-form normal approximation ((z_1-a/2 + z_1-b) / sqrt(N)), NOT an executed power analysis; ' +
      'the N=10 value is ' +
      roundTo((zAlpha + zBeta) / Math.sqrt(10), 4) +
      ' (the superseded V1 figure 0.886)'
  };
}

/** Exact power of the exact sign test when the true win probability is `pi`. */
export function exactSignTestPower(pi: number, m = 12, alpha = 0.05): number {
  const region = signTestRejectionRegion(m, alpha);
  let power = 0;
  for (const w of region) {
    power += choose(m, w) * Math.pow(pi, w) * Math.pow(1 - pi, m - w);
  }
  return roundTo(power);
}

/** Smallest win probability reaching `target` power (bisection on exact power). */
export function minDetectableWinRate(m = 12, alpha = 0.05, target = 0.8): number {
  let lo = 0.5;
  let hi = 1;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (exactSignTestPower(mid, m, alpha) < target) lo = mid;
    else hi = mid;
  }
  return roundTo(hi, 4);
}

// ---------------------------------------------------------------------------
// §8.5 decision bands and the four-dimension verdict tuple
// ---------------------------------------------------------------------------

/** Pre-registered bands (V2 §8.5). Bands are READ, never targets to hit. */
export const MMI = 0.1;
export const NIM = -0.05;
export const DTS_MAX = 0.25;
/** Interval width above which evidence is declared insufficient (V2 §8.5 ④). */
export const WIDTH_INSUFFICIENT = 0.5;
/** Discordant-pair floor below which evidence is declared insufficient. */
export const DISCORDANT_INSUFFICIENT = 8;

export type Significance = 'reject' | 'not-reject';
export type Direction = '+' | '0' | '-';
export type DegradationStatus = 'degraded' | 'not-degraded' | 'undetermined';
export type EvidenceStatus = 'sufficient' | 'insufficient';

/**
 * The four independent dimensions. They are deliberately NOT collapsed into one
 * label: `degraded` + `insufficient` must be expressible simultaneously, and a
 * `not-reject` must never be read as `not-degraded`.
 */
export interface VerdictTuple {
  readonly significance: Significance;
  readonly direction: Direction;
  readonly degradationStatus: DegradationStatus;
  readonly evidenceStatus: EvidenceStatus;
}

/** Why the tuple came out the way it did (auditable, not decorative). */
export interface VerdictReasoning {
  readonly meanDelta: number;
  readonly interval: readonly [number, number];
  readonly intervalWidth: number;
  readonly discordantPairs: number;
  readonly dts: number;
  readonly pValue: number;
  readonly pAdjusted: number | null;
  readonly significantAfterCorrection: boolean;
  readonly notes: readonly string[];
}

/**
 * §7.2 DTS for an ARM against a reference arm: the share of tasks whose
 * arm-level rate is strictly below the reference's (descriptive).
 */
export function dtsOf(
  perTask: readonly { readonly taskId: string; readonly arm: number; readonly reference: number }[]
): { readonly dts: number; readonly degradedTasks: readonly string[] } {
  if (perTask.length === 0) return { dts: 0, degradedTasks: [] };
  const degraded = perTask.filter((entry) => entry.arm < entry.reference - 1e-9).map((entry) => entry.taskId);
  return { dts: roundTo(degraded.length / perTask.length), degradedTasks: degraded };
}

/**
 * §8.5 ③ DTS for an ESTIMATOR: the share of tasks on which the estimator's own
 * per-task combination Δ_i is strictly below the null (Δ_i < 0).
 *
 * This is the §7.2 "strictly worse" rule applied to a contrast instead of an
 * arm: an arm-level DTS answers "does this arm lose tasks against the frozen
 * reference?", while a contrast-level DTS must answer "on how many tasks does
 * THIS estimator's own per-task value point the wrong way?". Feeding the arm
 * series of one arm into the verdict (the draft's defect) silently substitutes
 * an arm comparison for the estimator under test.
 *
 * `dtsBelowNim` is reported alongside as a sensitivity reading (tasks at or
 * below the NIM). The pre-registered verdict uses `dts`; the two are printed
 * side by side so a reader can see that the verdict is not an artifact of the
 * strictness choice.
 */
export function estimatorDegradation(
  perTask: readonly { readonly taskId: string; readonly value: number }[],
  nim = NIM
): {
  readonly dts: number;
  readonly degradedTasks: readonly string[];
  readonly dtsBelowNim: number;
  readonly belowNimTasks: readonly string[];
  readonly definition: string;
} {
  if (perTask.length === 0) {
    return {
      dts: 0,
      degradedTasks: [],
      dtsBelowNim: 0,
      belowNimTasks: [],
      definition: 'no tasks'
    };
  }
  const degraded = perTask.filter((entry) => entry.value < -1e-9).map((entry) => entry.taskId);
  const belowNim = perTask.filter((entry) => entry.value <= nim + 1e-12).map((entry) => entry.taskId);
  return {
    dts: roundTo(degraded.length / perTask.length),
    degradedTasks: degraded,
    dtsBelowNim: roundTo(belowNim.length / perTask.length),
    belowNimTasks: belowNim,
    definition: 'DTS = #{i : estimator per-task value d_i < 0} / N (strictly below the null, mirroring the §7.2 strict comparison)'
  };
}

/**
 * True when every value is 0 or 1 (within 1e-9).
 *
 * §8.3.1's exact McNemar is the pre-registered test for a BINARY primary
 * metric; a rate-type series (Y ∈ {0, 0.2, ..., 1}) must use §8.3.2's exact
 * paired randomization. Reporting both without this predicate is exactly how a
 * rate-type contrast ends up labelled with a binary test.
 */
export function isBinarySeries(values: readonly number[]): boolean {
  return values.every((value) => Math.abs(value) <= 1e-9 || Math.abs(value - 1) <= 1e-9);
}

/**
 * Pearson correlation between two equal-length series (null when undefined).
 *
 * Used ONLY for the θ_track / θ_write collinearity disclosure (V2 §8.4 order:
 * the interaction must be read before any main effect). It is a descriptive
 * diagnostic, never a test.
 */
export function pearsonCorrelation(left: readonly number[], right: readonly number[]): number | null {
  const n = Math.min(left.length, right.length);
  if (n < 2) return null;
  const meanLeft = left.slice(0, n).reduce((sum, value) => sum + value, 0) / n;
  const meanRight = right.slice(0, n).reduce((sum, value) => sum + value, 0) / n;
  let covariance = 0;
  let varianceLeft = 0;
  let varianceRight = 0;
  for (let i = 0; i < n; i += 1) {
    const dl = left[i]! - meanLeft;
    const dr = right[i]! - meanRight;
    covariance += dl * dr;
    varianceLeft += dl * dl;
    varianceRight += dr * dr;
  }
  if (varianceLeft <= 0 || varianceRight <= 0) return null;
  return roundTo(covariance / Math.sqrt(varianceLeft * varianceRight), 6);
}

/**
 * Build the four-dimension tuple from the measured quantities.
 *
 * Pre-registered order (V2 §8.5): the verdict is computed from the BANDS and the
 * INTERVAL, and the significance dimension is carried separately. Nothing here
 * lets one dimension overwrite another.
 *
 * The `interval` argument MUST be the interval of the ESTIMATOR under test (the
 * randomization inversion of mean Δ, §8.3.2). Handing it a Clopper-Pearson
 * interval of the discordant-pair win probability π answers a different
 * question ("how sure are we that the sign is consistent?") and would let a
 * contrast whose effect interval crosses NIM be labelled `not-degraded`.
 */
export function verdictTuple(input: {
  readonly meanDelta: number;
  readonly interval: readonly [number, number];
  readonly discordantPairs: number;
  readonly dts: number;
  readonly significantAfterCorrection: boolean;
}): VerdictTuple {
  const width = input.interval[1] - input.interval[0];
  const direction: Direction =
    Math.abs(input.meanDelta) < 1e-9 ? '0' : input.meanDelta > 0 ? '+' : '-';
  // A band edge is a boundary, not a direction: compare with a tolerance so a
  // grid point that lands exactly on NIM (e.g. -0.05 from a 0.005 inversion
  // grid) is not flipped to `undetermined` by binary floating-point noise.
  const epsilon = 1e-9;
  let degradationStatus: DegradationStatus;
  if (input.dts > DTS_MAX + epsilon || input.interval[1] < NIM - epsilon) {
    degradationStatus = 'degraded';
  } else if (input.dts <= DTS_MAX + epsilon && input.interval[0] >= NIM - epsilon) {
    degradationStatus = 'not-degraded';
  } else {
    degradationStatus = 'undetermined';
  }

  const evidenceStatus: EvidenceStatus =
    input.discordantPairs < DISCORDANT_INSUFFICIENT || width > WIDTH_INSUFFICIENT
      ? 'insufficient'
      : 'sufficient';

  return {
    significance: input.significantAfterCorrection ? 'reject' : 'not-reject',
    direction,
    degradationStatus,
    evidenceStatus
  };
}

/** Read the band an estimate falls into (descriptive only, not a verdict). */
export function bandOf(meanDelta: number): 'above-MMI' | 'within-band' | 'below-NIM' {
  if (meanDelta >= MMI) return 'above-MMI';
  if (meanDelta <= NIM) return 'below-NIM';
  return 'within-band';
}

// ---------------------------------------------------------------------------
// §8.6 multiplicity
// ---------------------------------------------------------------------------

/**
 * Holm-Bonferroni step-down. Returns adjusted p-values in INPUT order plus the
 * rejection decisions at `alpha`.
 */
export function holmBonferroni(
  pValues: readonly number[],
  alpha = 0.05
): { readonly adjusted: readonly number[]; readonly rejected: readonly boolean[] } {
  const m = pValues.length;
  const order = pValues
    .map((p, index) => ({ p, index }))
    .sort((left, right) => (left.p === right.p ? left.index - right.index : left.p - right.p));
  const adjusted = new Array<number>(m).fill(0);
  let running = 0;
  let stopped = false;
  for (let rank = 0; rank < m; rank += 1) {
    const entry = order[rank]!;
    const scaled = Math.min(1, entry.p * (m - rank));
    running = Math.max(running, scaled);
    adjusted[entry.index] = roundTo(running);
  }
  const rejected = new Array<boolean>(m).fill(false);
  for (let rank = 0; rank < m; rank += 1) {
    const entry = order[rank]!;
    if (stopped) break;
    if (entry.p <= alpha / (m - rank)) rejected[entry.index] = true;
    else stopped = true;
  }
  return { adjusted: adjusted.map((value) => roundTo(value)), rejected };
}

/** Benjamini-Hochberg adjusted q-values (exploratory family only). */
export function benjaminiHochberg(pValues: readonly number[]): readonly number[] {
  const m = pValues.length;
  if (m === 0) return [];
  const order = pValues
    .map((p, index) => ({ p, index }))
    .sort((left, right) => (left.p === right.p ? left.index - right.index : left.p - right.p));
  const adjusted = new Array<number>(m).fill(0);
  let running = 1;
  for (let rank = m - 1; rank >= 0; rank -= 1) {
    const entry = order[rank]!;
    const scaled = (entry.p * m) / (rank + 1);
    running = Math.min(running, scaled);
    adjusted[entry.index] = roundTo(Math.min(1, running));
  }
  return adjusted;
}
