/**
 * Self-verification of the PR-4A statistics layer against the pre-registered
 * tables in `docs/reports/pr4a-five-arm-experiment-preregistration.md` (V2).
 *
 * The pre-registration publishes three tables BEFORE data exists:
 *   §8.3.1 exact McNemar rejection boundary
 *   §8.4   interval width budget
 *   §8.7   d_min (closed form) + exact power curve + pi*
 *
 * If this script disagrees with the document, one of them is wrong and the
 * experiment must not run. Exit 0 only when every published value reproduces.
 */

import {
  benjaminiHochberg,
  closedFormMinDetectableD,
  exactDiscordantInterval,
  exactMcNemarTwoSided,
  exactSignFlipTest,
  exactSignTestPower,
  holmBonferroni,
  minDetectableWinRate,
  minWinsForRejection,
  signTestRejectionRegion,
  summarisePaired,
  verdictTuple,
  widthBudget
} from './pr4a-stats.ts';

const problems = [];
function check(label, actual, expected, tolerance = 0) {
  const ok = typeof expected === 'number' && tolerance > 0
    ? Math.abs(actual - expected) <= tolerance
    : actual === expected;
  if (!ok) problems.push(label + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  return ok;
}

// ---------------------------------------------------------------------------
// §8.3.1 exact McNemar rejection boundary (published table)
// ---------------------------------------------------------------------------
const MC_CARLO = [
  { m: 6, minWins: 6, p: 0.0313 },
  { m: 7, minWins: 7, p: 0.0156 },
  { m: 8, minWins: 8, p: 0.0078 },
  { m: 9, minWins: 8, p: 0.0391 },
  { m: 10, minWins: 9, p: 0.0215 },
  { m: 11, minWins: 10, p: 0.0117 },
  { m: 12, minWins: 10, p: 0.0386 }
];
for (const row of MC_CARLO) {
  check('mcnemar m=' + row.m + ' minWins', minWinsForRejection(row.m), row.minWins);
  check('mcnemar m=' + row.m + ' p', Number(exactMcNemarTwoSided(row.minWins, row.m).toFixed(4)), row.p, 5e-5);
}

// the two-tail property that was the actual review defect: {0,1,2} must be in
// the region at m=12, otherwise power is understated.
const region12 = signTestRejectionRegion(12);
check('rejection region at m=12', JSON.stringify(region12), JSON.stringify([0, 1, 2, 10, 11, 12]));

// ---------------------------------------------------------------------------
// §8.7 power curve (published table)
// ---------------------------------------------------------------------------
const POWER_TABLE = [
  { pi: 0.7, power: 0.253 },
  { pi: 0.75, power: 0.3907 },
  { pi: 0.8, power: 0.5584 },
  { pi: 0.85, power: 0.7358 },
  { pi: 0.9, power: 0.8891 }
];
for (const row of POWER_TABLE) {
  check('power pi=' + row.pi, Number(exactSignTestPower(row.pi).toFixed(4)), row.power, 5e-5);
}
check('pi* (min detectable win rate)', Number(minDetectableWinRate().toFixed(3)), 0.869, 1e-3);

const d = closedFormMinDetectableD();
check('d_min for N=12', Number(d.d.toFixed(3)), 0.809, 1e-3);
if (!/closed-form/i.test(d.note) || !/NOT an executed power analysis/i.test(d.note)) {
  problems.push('d_min note must label itself a closed-form approximation, not an executed power analysis');
}

// ---------------------------------------------------------------------------
// §8.4 width budget (published ratios)
// ---------------------------------------------------------------------------
const budget = widthBudget(1);
check('width pairedDiff ratio', Number(budget.pairedDiff.toFixed(3)), 0.566, 5e-4);
check('width mainEffect ratio', Number(budget.mainEffect.toFixed(3)), 0.4, 5e-4);
check('width interaction ratio', Number(budget.interaction.toFixed(3)), 0.8, 5e-4);
const at05 = widthBudget(0.5);
check('width sigma=0.5 paired', Number(at05.pairedDiff.toFixed(3)), 0.283, 1e-3);
check('width sigma=0.5 main', Number(at05.mainEffect.toFixed(3)), 0.2, 1e-3);
check('width sigma=0.5 interaction', Number(at05.interaction.toFixed(3)), 0.4, 1e-3);

// ---------------------------------------------------------------------------
// summary: the paired unit is the TASK
// ---------------------------------------------------------------------------
const summary = summarisePaired([
  { taskId: 'ci-01', left: 1, right: 1 },
  { taskId: 'ci-02', left: 1, right: 0 },
  { taskId: 'ci-03', left: 0, right: 1 },
  { taskId: 'ci-04', left: 1, right: 1 }
]);
check('summary pairs', summary.pairs, 4);
check('summary wins', summary.wins, 1);
check('summary losses', summary.losses, 1);
check('summary ties', summary.ties, 2);
check('summary discordantPairs = w+l', summary.discordantPairs, 2);
check('summary meanDelta', summary.meanDelta, 0);

// ---------------------------------------------------------------------------
// §8.3.1 exact interval sanity: it must bracket the point estimate and be
// monotone in the win share. A backwards bisection shows up immediately here.
// ---------------------------------------------------------------------------
const cases = [
  { w: 12, m: 12 },
  { w: 10, m: 12 },
  { w: 9, m: 12 },
  { w: 6, m: 12 },
  { w: 3, m: 12 },
  { w: 0, m: 12 },
  { w: 8, m: 8 },
  { w: 1, m: 9 }
];
let previousLower = -1;
let previousUpper = 2;
for (const entry of cases) {
  const interval = exactDiscordantInterval(entry.w, entry.m - entry.w);
  const point = entry.w / entry.m;
  if (!(interval.lower <= point + 1e-9)) {
    problems.push(
      'interval lower must be <= point estimate for w=' + entry.w + '/' + entry.m +
        ' (lower=' + interval.lower + ', point=' + point + ')'
    );
  }
  if (!(interval.upper >= point - 1e-9)) {
    problems.push(
      'interval upper must be >= point estimate for w=' + entry.w + '/' + entry.m +
        ' (upper=' + interval.upper + ', point=' + point + ')'
    );
  }
  if (!(interval.lower >= -1e-9 && interval.upper <= 1 + 1e-9)) {
    problems.push('interval must stay inside [0,1] for w=' + entry.w + '/' + entry.m);
  }
  if (!(interval.lower <= interval.upper)) {
    problems.push('interval must not be inverted for w=' + entry.w + '/' + entry.m);
  }
}
// monotonicity: fewer wins must give a lower bound no greater than more wins
const high = exactDiscordantInterval(12, 0);
const mid = exactDiscordantInterval(6, 6);
const low = exactDiscordantInterval(0, 12);
if (!(high.lower > mid.lower && mid.lower > low.lower)) {
  problems.push(
    'interval lower bound must increase with the win share: ' +
      JSON.stringify({ high: high.lower, mid: mid.lower, low: low.lower })
  );
}
if (!(high.upper > mid.upper && mid.upper > low.upper)) {
  problems.push(
    'interval upper bound must increase with the win share: ' +
      JSON.stringify({ high: high.upper, mid: mid.upper, low: low.upper })
  );
}
// Known reference: for 12/12 the two-sided exact (Clopper-Pearson) lower bound
// is (alpha/2)^(1/n) = 0.025^(1/12) = 0.7354. An earlier version of this check
// asserted 0.779, which is (alpha)^(1/12) - the ONE-sided figure. The interval is
// two-sided, so 0.735 is the correct number and the expectation was the defect.
const twelveOfTwelve = exactDiscordantInterval(12, 0);
const expectedLower = Math.pow(0.025, 1 / 12);
check('12/12 lower bound = (alpha/2)^(1/12)', Number(twelveOfTwelve.lower.toFixed(4)), Number(expectedLower.toFixed(4)), 1e-4);
// 6/12 must straddle 0.5
const exactHalf = exactDiscordantInterval(6, 6);
if (!(exactHalf.lower < 0.5 && exactHalf.upper > 0.5)) {
  problems.push('6/12 interval must straddle 0.5, got ' + JSON.stringify(exactHalf));
}

// ---------------------------------------------------------------------------
// §8.5 four-dimension tuple: the properties V1 got wrong
// ---------------------------------------------------------------------------
const degradedAndInsufficient = verdictTuple({
  meanDelta: -0.05,
  interval: [-0.6, 0.5],
  discordantPairs: 3,
  dts: 0.4,
  significantAfterCorrection: false
});
check('degraded + insufficient coexist: degradation', degradedAndInsufficient.degradationStatus, 'degraded');
check('degraded + insufficient coexist: evidence', degradedAndInsufficient.evidenceStatus, 'insufficient');
check('degraded + insufficient coexist: significance', degradedAndInsufficient.significance, 'not-reject');
check('degraded + insufficient coexist: direction', degradedAndInsufficient.direction, '-');

const cleanSafe = verdictTuple({
  meanDelta: 0.2,
  interval: [0.05, 0.35],
  discordantPairs: 10,
  dts: 0,
  significantAfterCorrection: true
});
check('clean win: degradation', cleanSafe.degradationStatus, 'not-degraded');
check('clean win: direction', cleanSafe.direction, '+');
check('clean win: evidence', cleanSafe.evidenceStatus, 'sufficient');

// the V1 failure mode: "1 degraded task + 11 improved" is NOT a failure.
// NOTE the interval width: 0.6 exceeds the pre-registered 0.50 insufficiency
// threshold, so evidence is CORRECTLY `insufficient` here. That is exactly the
// independence property - a clear positive point estimate can still rest on wide
// evidence, and the two facts are reported side by side instead of being
// collapsed into a single verdict.
const oneDegraded = verdictTuple({
  meanDelta: 0.4,
  interval: [0.1, 0.7],
  discordantPairs: 12,
  dts: 1 / 12,
  significantAfterCorrection: true
});
check('1/12 degraded is not degraded', oneDegraded.degradationStatus, 'not-degraded');
check('wide interval (0.6 > 0.50) => insufficient', oneDegraded.evidenceStatus, 'insufficient');
check('1/12 degraded keeps significance separate', oneDegraded.significance, 'reject');

// a genuinely tight interval with the same 1 degraded task is sufficient
const oneDegradedTight = verdictTuple({
  meanDelta: 0.4,
  interval: [0.2, 0.6],
  discordantPairs: 12,
  dts: 1 / 12,
  significantAfterCorrection: true
});
check('1/12 degraded tight: degradation', oneDegradedTight.degradationStatus, 'not-degraded');
check('1/12 degraded tight: evidence', oneDegradedTight.evidenceStatus, 'sufficient');

// ---------------------------------------------------------------------------
// §8.6 multiplicity
// ---------------------------------------------------------------------------
const holm = holmBonferroni([0.001, 0.01, 0.04, 0.2], 0.05);
check('holm rejects the first two', JSON.stringify(holm.rejected), JSON.stringify([true, true, false, false]));
check('holm adjusted[0] = 4*p', holm.adjusted[0], Number(Math.min(1, 0.001 * 4).toFixed(6)));
const bh = benjaminiHochberg([0.01, 0.04, 0.03, 0.2]);
if (!(bh.every((value) => value >= 0 && value <= 1))) problems.push('BH q-values must be in [0,1]');
const sortedBh = [...bh].sort((a, b) => a - b);
if (!(sortedBh[0] <= sortedBh[1] && sortedBh[1] <= sortedBh[2] && sortedBh[2] <= sortedBh[3])) {
  problems.push('BH q-values must be monotone in the sorted p order: ' + JSON.stringify(bh));
}

// ---------------------------------------------------------------------------
// the exact-sign-flip guard must refuse an n that implies rounds-as-samples.
// NOTE: call the imported binding, not a fresh dynamic import - Node caches the
// module, so a re-import would return the same namespace and any SyntaxError in
// the import itself would masquerade as "the guard did not fire".
// ---------------------------------------------------------------------------
let refused = false;
let refusalMessage = '';
try {
  exactSignFlipTest(new Array(180).fill(0.1));
} catch (error) {
  refusalMessage = String(error);
  refused = /rounds\/decisions were counted as independent samples/.test(refusalMessage);
}
if (!refused) {
  problems.push('exactSignFlipTest must refuse n=180 (rounds-as-samples guard); got: ' + refusalMessage.slice(0, 200));
}

// a legitimate task-level n must still work (the guard must not be a blanket ban)
const legit = exactSignFlipTest([1, 1, -1, 0, 0.5, -0.5, 1, 0, -1, 0, 0, 1]);
if (!(legit.n === 12 && legit.twoSidedP > 0 && legit.twoSidedP <= 1 && legit.patterns === 4096)) {
  problems.push('exactSignFlipTest must accept n=12 with 4096 patterns, got ' + JSON.stringify(legit));
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
if (problems.length === 0) {
  console.log('[pr4a-stats] SUCCESS: every pre-registered table and invariant reproduces');
  console.log('[pr4a-stats]   §8.3.1 McNemar boundary  : 7/7 rows');
  console.log('[pr4a-stats]   §8.7   power curve       : 5/5 rows, pi*=' + minDetectableWinRate().toFixed(3) + ', d_min=' + d.d.toFixed(3));
  console.log('[pr4a-stats]   §8.4   width budget      : 6/6 ratios');
  console.log('[pr4a-stats]   §8.5   tuple dimensions  : coexist / independence / band edge');
  console.log('[pr4a-stats]   §8.3.1 exact interval    : bracket + monotone + 12/12 lower=' + twelveOfTwelve.lower.toFixed(4));
} else {
  console.error('[pr4a-stats] FAIL: ' + String(problems.length) + ' problem(s)');
  for (const problem of problems) console.error('  - ' + problem);
  process.exitCode = 1;
}
