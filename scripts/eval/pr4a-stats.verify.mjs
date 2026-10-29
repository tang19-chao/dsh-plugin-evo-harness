/**
 * Self-verification of the PR-4A statistics layer against the pre-registered
 * tables in `docs/reports/pr4a-five-arm-experiment-preregistration.md` (V2),
 * PLUS the V3 pre-registration layer (P2-C):
 *   protocol P2-V3-EVAL-PREREG-20261029-V3,
 *   document docs/reports/p2-preregistration-v3.md.
 *
 * The V2 pre-registration publishes three tables BEFORE data exists:
 *   8.3.1 exact McNemar rejection boundary
 *   8.4   interval width budget
 *   8.7   d_min (closed form) + exact power curve + pi*
 *
 * The V3 pre-registration publishes, also BEFORE data exists:
 *   (a) the STRUCTURAL REJECTABILITY FLOOR: for a contrast with m discordant
 *       pairs, the smallest achievable exact two-sided p-value is 2^(1-m)
 *       (every discordant pair in one direction). If even that floor exceeds
 *       the Holm-adjusted alpha, NO outcome of the data can reject and the
 *       contrast must be reported as STRUCTURALLY NON-REJECTABLE - a property
 *       of the DESIGN - never as a mere "not-reject", which is a property of
 *       the data. V3 pre-registers that label rule and the floor table;
 *   (b) the exact power of the paired randomization (sign-flip) test for
 *       rate-type metrics under the fixed-magnitude Bernoulli-sign model;
 *   (c) the exact (enumerated) coverage of the Clopper-Pearson interval;
 *   (d) the frozen development/holdout SPLIT of the V3 task table, with a
 *       fail-closed holdout firewall;
 *   (e) the binding to the V3 task table digest (P2-A, pr4a-v3-design.mjs).
 *
 * If this script disagrees with either document, one of them is wrong and the
 * experiment must not run. Exit 0 only when every published value reproduces.
 *
 * CLI modes (each also runnable in CI):
 *   node scripts/eval/pr4a-stats.verify.mjs                 full check run
 *   node scripts/eval/pr4a-stats.verify.mjs --json          machine-readable
 *   node scripts/eval/pr4a-stats.verify.mjs --split         emit the frozen split manifest
 *   node scripts/eval/pr4a-stats.verify.mjs --firewall <manifest.json> [--artifact f]...
 *   node scripts/eval/pr4a-stats.verify.mjs --v3-table      V3 task-table gate + digest
 *   node scripts/eval/pr4a-stats.verify.mjs --check-doc docs/reports/p2-preregistration-v3.md
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

import {
  V3_TASKS,
  V3_DESIGN_VERSION,
  V3_ROUNDS,
  canonicalDesignBytes,
  designDigest,
  designGateFindings,
  designSummary,
  taskDecisionPoints,
  oracleCoverage,
  priorCoverage
} from './pr4a-v3-design.mjs';
// ===========================================================================
// V3 (P2-C) pre-registration layer - pure functions, appended below the V2
// self-verification. V3 owns NO thresholds of its own: MMI/NIM/DTS_max, the
// width budget and the V2 tables stay in pr4a-stats.ts and are re-verified
// above unchanged. V3 only ADDS a rejectability floor, an exact power for the
// randomization test, an exact coverage enumeration, the frozen split and the
// task-table binding.
// ===========================================================================

/** V3 protocol id (a NEW registration alongside V2; V2 stays sealed). */
export const V3_PROTOCOL_ID = 'P2-V3-EVAL-PREREG-20261029-V3';

/**
 * The frozen V3 task-table digest (P2-A, scripts/eval/pr4a-v3-design.mjs,
 * version v3/tasks-20261029). SHA-256 over canonicalDesignBytes() =
 * canonicalDesignJson() plus a single LF (47720 bytes). Recompute with:
 *   node scripts/eval/pr4a-v3-design.mjs --canonical | sha256sum
 * If the live module digest differs from this constant, the table changed
 * WITHOUT a re-freeze: this script MUST fail and no V3 number may be cited
 * until the pre-registration records the new digest BEFORE any data exists.
 */
export const V3_FROZEN_TASK_TABLE_DIGEST = 'sha256:585d030790072ba2fc096d00821e1a2a88bbb0866e91491962ae117fa15a2142';

/** Frozen split salt (registered BEFORE data generation; never reused). */
export const V3_SPLIT_SALT = 'P2-V3-SPLIT-SALT-V1';

/** Holm-corrected alpha thresholds for a family of size m: alpha/(m-rank+1). */
export function holmThresholds(familySize, alpha = 0.05) {
  const thresholds = [];
  for (let rank = 1; rank <= familySize; rank += 1) {
    thresholds.push(alpha / (familySize - rank + 1));
  }
  return thresholds;
}

/**
 * Structural rejectability of ONE contrast.
 *
 * The smallest p-value the exact two-sided McNemar (sign) test can EVER produce
 * at m discordant pairs is p(m, m) = 2 * 2^-m = 2^(1-m) (every discordant pair
 * in one direction). Under Holm with a family of size k, the strictest
 * threshold a hypothesis can face is alpha/k (rank 1). If 2^(1-m) > alpha/k,
 * rejection is arithmetically impossible REGARDLESS of the data: the contrast
 * is STRUCTURALLY NON-REJECTABLE and must be labelled as such (a design
 * property), not merely "not-reject" (a data property).
 */
export function structuralRejectability(mDisc, options = {}) {
  const alpha = options.alpha ?? 0.05;
  const familySize = options.familySize ?? 1;
  if (!Number.isInteger(mDisc) || mDisc < 0) {
    throw new RangeError('structuralRejectability: mDisc must be a non-negative integer');
  }
  const alphaStrictest = alpha / familySize;
  const pMin = mDisc === 0 ? 1 : exactMcNemarTwoSided(mDisc, mDisc);
  const rawRejectable = pMin <= alpha;
  const correctedRejectable = pMin <= alphaStrictest;
  return {
    mDisc,
    alpha,
    familySize,
    alphaStrictest,
    pMin,
    pMinFormula: mDisc === 0 ? 'undefined (m=0)' : '2^(1-m) = 2^' + String(1 - mDisc),
    rawRejectable,
    correctedRejectable,
    structurallyNonRejectable: !correctedRejectable,
    label: correctedRejectable ? 'rejectable' : 'structurally-non-rejectable'
  };
}

/** The floor table: m_disc 1..maxM at each family size. */
export function rejectabilityFloorTable(maxM = 12, options = {}) {
  const familySizes = options.familySizes ?? [1, 4];
  return familySizes.map((familySize) => ({
    familySize,
    alphaStrictest: 0.05 / familySize,
    minDiscordantForRejectability: minDiscordantForRejectability({ familySize }),
    rows: Array.from({ length: maxM }, (_, index) => structuralRejectability(index + 1, { familySize }))
  }));
}

/**
 * Smallest m_disc at which a Holm-corrected rejection is arithmetically
 * possible at all (2^(1-m) <= alpha/familySize). Below it the contrast is
 * structurally non-rejectable no matter how the data falls out.
 */
export function minDiscordantForRejectability(options = {}) {
  const alpha = options.alpha ?? 0.05;
  const familySize = options.familySize ?? 1;
  for (let m = 1; m <= 40; m += 1) {
    if (exactMcNemarTwoSided(m, m) <= alpha / familySize) return m;
  }
  return null;
}

/**
 * Smallest number of (all-discordant) paired tasks reaching `target` power for
 * the exact sign test at win probability `pi` - the minimal-sample-size
 * estimate the V3 report must publish when a contrast cannot reject.
 */
export function minTasksForPower(pi, options = {}) {
  const alpha = options.alpha ?? 0.05;
  const target = options.target ?? 0.8;
  for (let m = 1; m <= 200; m += 1) {
    if (exactSignTestPower(pi, m, alpha) >= target) return m;
  }
  return null;
}

/**
 * EXACT power of the paired randomization (sign-flip) test under the
 * fixed-magnitude Bernoulli-sign model: each task's |delta| is fixed by the
 * design and its sign is Bernoulli(pi). The null distribution of |sum| depends
 * only on the magnitude vector, so it is enumerated ONCE; each sign pattern's
 * own p-value is then a lookup, and power is the Bernoulli(pi)-weighted share
 * of patterns whose p-value clears alpha. Deterministic, no randomness.
 *
 * CONDITIONING NOTE (must travel with every reported number): this conditions
 * on the observed magnitude set; it is the exact conditional power of the
 * pre-registered test, not an unconditional power analysis.
 */
export function exactSignFlipPower(magnitudes, pi, options = {}) {
  const alpha = options.alpha ?? 0.05;
  const n = magnitudes.length;
  if (n === 0) return { n: 0, pi, alpha, threshold: 0, power: 0, patterns: 1, conditionedOnMagnitudes: true };
  if (n > 20) {
    throw new RangeError(
      'exactSignFlipPower: enumeration is limited to n <= 20 (got ' + String(n) + ')'
    );
  }
  const patterns = Math.pow(2, n);
  const sums = [];
  for (let mask = 0; mask < patterns; mask += 1) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      sum += (mask >> i) & 1 ? magnitudes[i] : -magnitudes[i];
    }
    sums.push(Math.abs(sum));
  }
  // smallest t in the null distribution with #{|sum| >= t} <= alpha * patterns:
  // the exact rejection boundary of the sign-flip test at this magnitude set.
  const maxCount = alpha * patterns;
  const distinct = [...new Set(sums)].sort((a, b) => a - b);
  let threshold = Infinity;
  for (const t of distinct) {
    let count = 0;
    for (const s of sums) if (s >= t - 1e-12) count += 1;
    if (count <= maxCount + 1e-9) { threshold = t; break; }
  }
  let power = 0;
  if (threshold !== Infinity) {
    for (let mask = 0; mask < patterns; mask += 1) {
      let sum = 0;
      let positives = 0;
      for (let i = 0; i < n; i += 1) {
        const positive = (mask >> i) & 1;
        sum += positive ? magnitudes[i] : -magnitudes[i];
        if (positive) positives += 1;
      }
      if (Math.abs(sum) >= threshold - 1e-12) {
        power += Math.pow(pi, positives) * Math.pow(1 - pi, n - positives);
      }
    }
  }
  return {
    n,
    pi,
    alpha,
    threshold: threshold === Infinity ? null : Math.round(threshold * 1e9) / 1e9,
    power: Math.round(power * 1e6) / 1e6,
    patterns,
    conditionedOnMagnitudes: true
  };
}

/** Smallest win probability reaching `target` power for a magnitude vector. */
export function piStarForSignFlip(magnitudes, options = {}) {
  const alpha = options.alpha ?? 0.05;
  const target = options.target ?? 0.8;
  let lo = 0.5;
  let hi = 1;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (exactSignFlipPower(magnitudes, mid, { alpha }).power < target) lo = mid;
    else hi = mid;
  }
  return Math.round(hi * 1e4) / 1e4;
}

/**
 * EXACT coverage of the Clopper-Pearson interval on the discordant-pair win
 * probability: P(cover | pi) enumerated over all m+1 observable outcomes.
 * Deterministic; this is the "coverage" the V3 report must publish (interval
 * coverage - a different quantity from the surface-coverage metric, and both
 * must appear in the report under their own names).
 */
/**
 * EXACT coverage of the Clopper-Pearson interval on the discordant-pair win
 * probability: the BINOMIAL-WEIGHTED probability that the interval covers the
 * true pi, enumerated over all m+1 observable outcomes
 *
 *   coverage(pi) = sum_w' C(m, w') pi^w' (1-pi)^(m-w') * 1[pi in CI(w')].
 *
 * Deterministic. This is the "coverage" the V3 report must publish (interval
 * coverage - a different quantity from the surface-coverage metric, and both
 * must appear in the report under their own names). The CP interval is exact
 * and conservative, so the enumerated coverage is >= 1 - alpha; a value below
 * nominal is a bug in the interval, which this check exists to catch.
 */
export function exactIntervalCoverage(m, pi, options = {}) {
  const alpha = options.alpha ?? 0.05;
  if (!Number.isInteger(m) || m < 1) throw new RangeError('exactIntervalCoverage: m must be a positive integer');
  if (pi < 0 || pi > 1) throw new RangeError('exactIntervalCoverage: pi must be in [0,1]');
  let covered = 0;
  const uncoveredOutcomes = [];
  for (let wins = 0; wins <= m; wins += 1) {
    const interval = exactDiscordantInterval(wins, m - wins, alpha);
    const coveredHere = pi >= interval.lower - 1e-12 && pi <= interval.upper + 1e-12;
    const probability = choose(m, wins) * Math.pow(pi, wins) * Math.pow(1 - pi, m - wins);
    if (coveredHere) covered += probability;
    else uncoveredOutcomes.push({ wins, probability: Math.round(probability * 1e9) / 1e9 });
  }
  return {
    m,
    pi,
    alpha,
    coverage: Math.round(covered * 1e6) / 1e6,
    uncoveredOutcomes,
    method: 'binomial-weighted enumeration over all observable outcomes'
  };
}

/** Exact integer binomial coefficient (m <= 60 is plenty for these tables). */
export function choose(n, k) {
  if (k < 0 || k > n) return 0;
  const kk = Math.min(k, n - k);
  let result = 1;
  for (let i = 0; i < kk; i += 1) {
    result = (result * (n - i)) / (i + 1);
  }
  return Math.round(result);
}

// ---------------------------------------------------------------------------
// V3 effect sizes (pre-registered estimators, definitions only)
// ---------------------------------------------------------------------------

/**
 * Pre-registered paired effect sizes for one contrast (V3 freeze table):
 *   meanDelta / s_delta  paired mean difference and its SD (task axis only)
 *   d_z                  meanDelta / s_delta (paired standardised effect)
 *   wins/ties/losses     task-level counts (w + t + l = N)
 *   mDisc                discordant pairs w + l (the exact tests' information)
 *   piHat                win share among discordant pairs, with its exact
 *                        Clopper-Pearson interval (descriptive, not the
 *                        degradation verdict - V2 A-3 carries over)
 */
export function pairedEffectSizes(observations, options = {}) {
  const alpha = options.alpha ?? 0.05;
  const summary = summarisePaired(observations);
  const dz = summary.sd > 0 ? summary.meanDelta / summary.sd : null;
  const interval = exactDiscordantInterval(summary.wins, summary.losses, alpha);
  return {
    pairs: summary.pairs,
    meanDelta: summary.meanDelta,
    sdDelta: summary.sd,
    dz,
    wins: summary.wins,
    ties: summary.ties,
    losses: summary.losses,
    mDisc: summary.discordantPairs,
    piHat: summary.discordantPairs > 0 ? summary.wins / summary.discordantPairs : null,
    piExactInterval: interval,
    definition:
      'd_z = meanDelta / s_delta over the task axis; piHat = wins / (wins + losses) on discordant pairs'
  };
}

// ---------------------------------------------------------------------------
// V3 frozen split (development / holdout) - deterministic, metrics-blind
// ---------------------------------------------------------------------------

/** Stable JSON stringification (sorted keys) for digests. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

/** sha256 over the canonical JSON of a value. */
export function sha256Of(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/**
 * The V3 frozen split rule (registered BEFORE data generation):
 *
 *   1. GROUP INTEGRITY: the unit of the split is the task FAMILY. Every task
 *      of a family lands on the SAME side - a family is never split across
 *      development and holdout.
 *   2. DETERMINISM: the side of a family is decided by sha256 over
 *      (salt + ':' + family) only. The function reads NOTHING else - no
 *      metric, no reward, no outcome, no timestamp - so the split cannot
 *      peek at data by construction (the test asserts metric-decoy invariance).
 *   3. SIZE BOUNDS: holdout must hold >= 25% and <= 50% of the tasks. Families
 *      are taken in hash order until the 25% floor is met; an allocation that
 *      would exceed 50% is skipped; if no family fits at all the split FAILS
 *      CLOSED (no silent shrink - the PR-4B rule).
 *   4. DIGEST: the manifest carries sha256 over its canonical JSON, so any
 *      post-hoc edit of the split is detectable.
 */
export function computeV3Split(table, options = {}) {
  const salt = options.salt ?? V3_SPLIT_SALT;
  const minShare = options.minShare ?? 0.25;
  const maxShare = options.maxShare ?? 0.5;
  const rows = table.map((entry) => ({ id: String(entry.id), family: String(entry.family) }));
  const ids = new Set(rows.map((row) => row.id));
  if (rows.length === 0 || ids.size !== rows.length) {
    throw new RangeError('computeV3Split: table must have unique non-empty task ids');
  }
  if (rows.some((row) => row.family.length === 0)) {
    throw new RangeError('computeV3Split: every task needs a family');
  }
  const byFamily = new Map();
  for (const row of rows) {
    if (!byFamily.has(row.family)) byFamily.set(row.family, []);
    byFamily.get(row.family).push(row.id);
  }
  for (const tasks of byFamily.values()) tasks.sort();
  const families = [...byFamily.keys()].sort(
    (a, b) => (sha256Of([salt, a]) < sha256Of([salt, b]) ? -1 : 1)
  );
  const total = rows.length;
  const minTasks = Math.ceil(total * minShare);
  const maxTasks = Math.floor(total * maxShare);
  const holdoutFamilies = [];
  let holdoutTasks = 0;
  for (const family of families) {
    const size = byFamily.get(family).length;
    if (holdoutTasks < minTasks && holdoutTasks + size <= maxTasks) {
      holdoutFamilies.push(family);
      holdoutTasks += size;
    }
  }
  if (holdoutTasks < minTasks) {
    throw new RangeError(
      'computeV3Split: no family allocation satisfies the holdout bounds ' +
      '(min ' + String(minTasks) + ', max ' + String(maxTasks) + ' of ' + String(total) + '); ' +
      'failing closed instead of shrinking the holdout'
    );
  }
  const manifest = {
    protocolId: V3_PROTOCOL_ID,
    salt,
    rule: {
      unit: 'task family (all tasks of a family on one side)',
      hash: 'sha256(canonicalJson([salt, family]))',
      order: 'families ascending by that hash; taken until the 25% floor is met',
      bounds: 'holdout >= ' + String(minShare) + ' and <= ' + String(maxShare) + ' of tasks, fail-closed',
      metricsBlind: 'the split reads task ids and families ONLY - no metric, reward, outcome or timestamp'
    },
    minTasks,
    maxTasks,
    totalTasks: total,
    development: {
      families: families.filter((family) => !holdoutFamilies.includes(family)).sort(),
      taskIds: rows.filter((row) => !holdoutFamilies.includes(row.family)).map((row) => row.id).sort()
    },
    holdout: {
      families: [...holdoutFamilies].sort(),
      taskIds: rows.filter((row) => holdoutFamilies.includes(row.family)).map((row) => row.id).sort()
    },
    tasks: rows
      .map((row) => ({
        id: row.id,
        family: row.family,
        side: holdoutFamilies.includes(row.family) ? 'holdout' : 'development'
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    shares: {
      development: Math.round((rows.length - holdoutTasks) / total * 1e6) / 1e6,
      holdout: Math.round(holdoutTasks / total * 1e6) / 1e6
    }
  };
  return manifest;
}

/** The digest of a split manifest (canonical JSON, digest field excluded). */
export function splitManifestDigest(manifest) {
  const clone = JSON.parse(JSON.stringify(manifest));
  delete clone.digest;
  return sha256Of(clone);
}

/**
 * Re-verify a split manifest: digest match, disjoint sides, union = table,
 * size bounds, family integrity, and the metrics-blind rule. Fail-closed.
 */
export function verifySplitManifest(manifest, table) {
  const violations = [];
  const effectiveTable =
    table ?? (Array.isArray(manifest.tasks) ? manifest.tasks.map((row) => ({ id: row.id, family: row.family })) : undefined);
  const digest = splitManifestDigest(manifest);
  if (manifest.digest === undefined) {
    violations.push({ kind: 'digest-missing', detail: 'a frozen split manifest must carry its digest' });
  } else if (manifest.digest !== digest) {
    violations.push({ kind: 'digest-mismatch', detail: 'manifest digest ' + manifest.digest + ' != recomputed ' + digest });
  }
  const dev = new Set(manifest.development.taskIds);
  const hold = new Set(manifest.holdout.taskIds);
  for (const id of dev) if (hold.has(id)) violations.push({ kind: 'side-overlap', detail: id });
  if (effectiveTable !== undefined) {
    const ids = new Set(effectiveTable.map((entry) => String(entry.id)));
    for (const id of dev) if (!ids.has(id)) violations.push({ kind: 'unknown-task', detail: id });
    for (const id of hold) if (!ids.has(id)) violations.push({ kind: 'unknown-task', detail: id });
    if (dev.size + hold.size !== ids.size) {
      violations.push({ kind: 'incomplete-union', detail: 'dev+holdout != table' });
    }
  }
  const total = dev.size + hold.size;
  const holdShare = hold.size / total;
  if (!(holdShare >= 0.25 - 1e-9 && holdShare <= 0.5 + 1e-9)) {
    violations.push({ kind: 'size-bounds', detail: 'holdout share ' + holdShare });
  }
  const familySides = new Map();
  for (const id of dev) familySides.set(id, 'dev');
  for (const id of hold) familySides.set(id, 'hold');
  if (effectiveTable !== undefined) {
    const byFamily = new Map();
    for (const entry of effectiveTable) {
      const side = familySides.get(String(entry.id));
      if (!byFamily.has(entry.family)) byFamily.set(entry.family, new Set());
      byFamily.get(entry.family).add(side);
    }
    for (const [family, sides] of byFamily) {
      if (sides.size > 1) violations.push({ kind: 'family-split', detail: family });
    }
  }
  if (manifest.shares && Math.abs(manifest.shares.holdout - holdShare) > 1e-6) {
    violations.push({ kind: 'share-drift', detail: String(manifest.shares.holdout) });
  }
  return { ok: violations.length === 0, violations, digest, holdoutShare: holdShare };
}

/**
 * HOLDOUT FIREWALL (V3): given a frozen split manifest and the artifacts that
 * fed candidate selection/tuning, assert that NO holdout task id occurs in any
 * of them. This is the checkable form of "holdout did not participate in
 * selection": the command is run over the selection artifacts and its output
 * goes into the report. Also re-verifies the manifest itself.
 */
export function checkHoldoutFirewall(manifest, artifacts, table) {
  const manifestCheck = verifySplitManifest(manifest, table);
  const violations = [...manifestCheck.violations];
  const holdout = new Set(manifest.holdout.taskIds);
  for (const artifact of artifacts) {
    for (const id of holdout) {
      if (artifact.content.includes(id)) {
        violations.push({ kind: 'holdout-in-selection-artifact', detail: artifact.path + ':' + id });
      }
    }
  }
  return { ok: violations.length === 0, violations, checkedArtifacts: artifacts.map((a) => a.path) };
}
// ---------------------------------------------------------------------------
// V3 task-table gate (P2-A discriminability) - independent recomputation
// ---------------------------------------------------------------------------

/**
 * Independently recompute the P2-A discriminability requirements from the
 * design module's own data (NOT by trusting its summary):
 *   1. at least one task with required NOT a subset of prefs[:3], and the share;
 *   2. the oracle recomputed from the table (union of every decision point's
 *      reachable candidate surfaces, blind surfaces removed) matches the
 *      declared oracleCoverage; oracle is not identically 1; at least one task
 *      shows non-degenerate prior-vs-oracle headroom;
 *   3. every decision point has >1 candidate actions and the support matrix
 *      (decision points x action classes) has rank > 1;
 *   4. the live module digest equals the frozen digest recorded here.
 * A gate that can only pass is not a gate: the matrix rank re-computation is
 * also exercised on a deliberately rank-1 fixture below.
 */
export function verifyV3TaskTableGate(design, digest, resolvers = {}) {
  const findings = [];
  const tasks = design.V3_TASKS;
  // Resolvers default to the design module's public functions; a test can
  // inject fakes to prove the gate fails on a bad table (a gate that can only
  // pass on the one table it ships with is not a gate).
  const resolveOracle = resolvers.oracleCoverage ?? oracleCoverage;
  const resolvePrior = resolvers.priorCoverage ?? priorCoverage;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { ok: false, findings: [{ check: 'tasks', detail: 'empty task table' }], digest: null };
  }
  // 1. required not subset of prefs[:3]
  const outsideTop3 = tasks.filter(
    (task) => (task.required ?? []).some((surface) => !(task.prefs ?? []).slice(0, 3).includes(surface))
  );
  if (outsideTop3.length < 1) {
    findings.push({ check: 'required-outside-prefs3', detail: 'no task requires a surface outside prefs[:3]' });
  }
  // 2. oracle recomputation + non-degeneracy
  const oracleRows = tasks.map((task) => {
    const blind = new Set(task.blind ?? []);
    const reachable = new Set();
    for (const point of taskDecisionPoints(task)) {
      for (const candidate of point.candidates) {
        for (const surface of candidate.surfaces) {
          if (!blind.has(surface)) reachable.add(surface);
        }
      }
    }
    const required = task.required ?? [];
    const oracle = required.length === 0
      ? 0
      : required.filter((surface) => reachable.has(surface)).length / required.length;
    return {
      id: task.id,
      declared: resolveOracle(task),
      prior: resolvePrior(task),
      recomputed: oracle
    };
  });
  for (const row of oracleRows) {
    if (Math.abs(row.declared - row.recomputed) > 1e-9) {
      findings.push({ check: 'oracle-recomputation', detail: row.id + ': declared ' + row.declared + ', recomputed ' + row.recomputed });
    }
  }
  if (oracleRows.every((row) => row.declared === 1)) {
    findings.push({ check: 'oracle-non-degenerate', detail: 'every task has oracle 1: the ceiling is not measured' });
  }
  const headroom = oracleRows.filter((row) => row.declared - row.prior > 1e-9);
  if (headroom.length < 1) {
    findings.push({ check: 'prior-vs-oracle', detail: 'no task shows non-degenerate prior-vs-oracle headroom' });
  }
  // 3. decision points: >1 candidate; support matrix rank > 1
  const points = tasks.flatMap((task) => taskDecisionPoints(task));
  const minActions = Math.min(...points.map((point) => point.candidates.length));
  if (!(minActions > 1)) {
    findings.push({ check: 'multi-action-decision-points', detail: 'minimum candidate count is ' + String(minActions) });
  }
  const classes = [...new Set(points.flatMap((point) => point.candidates.map((candidate) => candidate.className ?? candidate.actionKey)))].sort();
  const matrix = points.map((point) =>
    classes.map((className) => (point.candidates.some((candidate) => (candidate.className ?? candidate.actionKey) === className) ? 1 : 0))
  );
  const rank = matrixRank(matrix);
  if (!(rank > 1)) {
    findings.push({ check: 'support-matrix-rank', detail: 'rank ' + String(rank) });
  }
  // 4. digest binding
  if (digest !== V3_FROZEN_TASK_TABLE_DIGEST) {
    findings.push({
      check: 'task-table-digest',
      detail: 'live digest ' + digest + ' != frozen ' + V3_FROZEN_TASK_TABLE_DIGEST +
        ': the table changed without a re-freeze; no V3 number may be cited'
    });
  }
  return {
    ok: findings.length === 0,
    findings,
    digest,
    taskCount: tasks.length,
    outsideTop3Share: Math.round((outsideTop3.length / tasks.length) * 1e6) / 1e6,
    outsideTop3Tasks: outsideTop3.length,
    oracleBelowOne: oracleRows.filter((row) => row.declared < 1).length,
    headroomTasks: headroom.length,
    minActionsPerDecisionPoint: minActions,
    supportMatrixRank: rank,
    supportMatrixColumns: classes.length,
    supportMatrixRows: matrix.length
  };
}

/** Numeric matrix rank by Gaussian elimination (support-matrix rank check). */
export function matrixRank(matrix) {
  if (matrix.length === 0 || matrix[0].length === 0) return 0;
  const a = matrix.map((row) => [...row]);
  const rows = a.length;
  const cols = a[0].length;
  let rank = 0;
  for (let col = 0; col < cols && rank < rows; col += 1) {
    let pivot = -1;
    for (let row = rank; row < rows; row += 1) {
      if (a[row][col] !== 0) { pivot = row; break; }
    }
    if (pivot < 0) continue;
    const tmp = a[rank]; a[rank] = a[pivot]; a[pivot] = tmp;
    for (let row = 0; row < rows; row += 1) {
      if (row !== rank && a[row][col] !== 0) {
        const factor = a[row][col] / a[rank][col];
        for (let k = col; k < cols; k += 1) a[row][k] -= factor * a[rank][k];
      }
    }
    rank += 1;
  }
  return rank;
}

/**
 * A deliberately rank-1 matrix: the gate's rank re-computation must flag it.
 * (A check that only ever runs on inputs it passes is not a check.)
 */
export function rankOneFixture(rows = 3) {
  return Array.from({ length: rows }, () => [1, 0, 1, 1]);
}

// ---------------------------------------------------------------------------
// V3 report completeness (the report MUST contain these sections)
// ---------------------------------------------------------------------------

/** Required report sections and their required subfields (V3 freeze table). */
export const V3_REQUIRED_REPORT_SECTIONS = [
  { section: 'confidenceIntervals', fields: ['meanDelta', 'lower', 'upper', 'method', 'reproducibleCommand'] },
  { section: 'coverage', fields: ['intervalCoverage', 'surfaceCoverage'] },
  { section: 'policyChangeRate', fields: ['value', 'denominator'] },
  { section: 'winsTiesLosses', fields: ['wins', 'ties', 'losses', 'discordantPairs'] },
  { section: 'effectSizes', fields: ['meanDelta', 'sdDelta', 'dz'] },
  { section: 'power', fields: ['signTestPower', 'signFlipPower', 'rejectabilityFloor'] },
  { section: 'structuralRejectability', fields: ['label', 'pMin', 'alphaStrictest'] },
  { section: 'holdoutFirewall', fields: ['manifestDigest', 'checkedArtifacts', 'violations'] }
];

/**
 * Check a V3 report object for the REQUIRED sections. Missing sections or
 * missing subfields fail - the report template is a contract, not a suggestion.
 */
export function checkReportCompleteness(report) {
  const missing = [];
  for (const requirement of V3_REQUIRED_REPORT_SECTIONS) {
    const block = report[requirement.section];
    if (block === undefined || block === null) {
      missing.push({ section: requirement.section, fields: requirement.fields });
      continue;
    }
    for (const field of requirement.fields) {
      if (block[field] === undefined) {
        missing.push({ section: requirement.section, field });
      }
    }
  }
  return { ok: missing.length === 0, missing };
}


/**
 * Run every V2 + V3 check. Returns the problem list and the machine-readable
 * data block (used by --json). `emit` controls whether the human-readable
 * lines are printed.
 */
async function main({ emit = true } = {}) {
  // Pinned, pre-registered values. Each one is RECOMPUTED above by the checks
  // below; a drift in either the implementation or the document fails here.
  const PINS = {
    equalMagnitudes: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    heteroMagnitudes: [0.25, 0.25, 0.5, 0.5, 1, 1, 1, 1, 1.5, 1.5, 2, 2],
    heteroPower: { 0.7: 0.2139, 0.8: 0.464145, 0.9: 0.796537 },
    heteroPiStar: 0.9011,
    coveragePoints: [
      { m: 12, pi: 0.5, coverage: 0.961426 },
      { m: 12, pi: 0.7, coverage: 0.976669 },
      { m: 12, pi: 0.9, coverage: 0.995671 },
      { m: 8, pi: 0.5, coverage: 0.992188 },
      { m: 6, pi: 0.5, coverage: 0.96875 }
    ],
    minTasksPi085: 15,
    minTasksPi09: 12,
    minTasksPi08: 20,
    minTasksPi075: 30,
    minTasksPi07: 49,
    splitSalt: 'P2-V3-SPLIT-SALT-V1',
    splitDigest: '71cf9b17e8f051a8b53bac8f5825b3fcb64bea961158dc1f5541cd8f8ab00b1d',
    splitHoldoutShare: 0.25,
    splitHoldoutFamilies: ['ci-fix'],
    splitHoldoutTaskIds: ['v3-ci-01', 'v3-ci-02', 'v3-ci-03']
  };

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


  // =========================================================================
  // V3 (P2-C) self-verification: rejectability floor, exact randomization
  // power, exact coverage, frozen split, task-table binding.
  // =========================================================================

  // (a) STRUCTURAL REJECTABILITY FLOOR - the pre-registered label rule.
  //     p_min(m) = 2^(1-m); at family size 4 the strictest Holm threshold is
  //     0.0125, so m_disc <= 7 can NEVER reject, no matter how the data falls
  //     out. The report must then say structurally-non-rejectable, not
  //     not-reject.
  for (let m = 1; m <= 12; m += 1) {
    const floor = structuralRejectability(m, { alpha: 0.05, familySize: 4 });
    check('v3 floor family=4 m=' + m + ' structurallyNonRejectable', floor.structurallyNonRejectable, m < 8);
    check('v3 floor family=4 m=' + m + ' pMin=2^(1-m)', Math.abs(floor.pMin - Math.pow(2, 1 - m)) < 1e-15, true);
    check('v3 floor family=4 m=' + m + ' label', floor.label, m < 8 ? 'structurally-non-rejectable' : 'rejectable');
    // cross-check against the existing boundary helper: a Holm-corrected
    // rejection is possible at alpha/4 exactly when minWinsForRejection != null
    const minWins = minWinsForRejection(m, 0.05 / 4);
    check('v3 floor family=4 m=' + m + ' minWinsForRejection null-ness', minWins === null, m < 8);
  }
  for (let m = 1; m <= 12; m += 1) {
    const floor = structuralRejectability(m, { alpha: 0.05, familySize: 1 });
    check('v3 floor family=1 m=' + m + ' structurallyNonRejectable', floor.structurallyNonRejectable, m < 6);
  }
  check('v3 floor family=4 starts at m=8', minDiscordantForRejectability({ familySize: 4 }), 8);
  check('v3 floor family=1 starts at m=6', minDiscordantForRejectability({ familySize: 1 }), 6);
  check('v3 floor family=2 starts at m=7', minDiscordantForRejectability({ familySize: 2 }), 7);
  check('v3 Holm thresholds family=4', JSON.stringify(holmThresholds(4).map((t) => Number(t.toFixed(6)))), JSON.stringify([0.0125, 0.016667, 0.025, 0.05]));

  // worked example pre-registered in the V3 document: m=6 discordant pairs in a
  // family of 4 - the observed result is structurally non-rejectable, NOT a
  // mere not-reject.
  const worked = structuralRejectability(6, { alpha: 0.05, familySize: 4 });
  check('v3 worked example m=6 label', worked.label, 'structurally-non-rejectable');
  check('v3 worked example pMin', Math.abs(worked.pMin - 0.03125) < 1e-12, true);

  // (b) EXACT POWER of the paired randomization test. Consistency first: with
  //     all magnitudes equal the sign-flip test IS the sign test, so its exact
  //     power must equal exactSignTestPower.
  for (const pi of [0.7, 0.8, 0.9]) {
    const flip = exactSignFlipPower(PINS.equalMagnitudes, pi);
    const sign = exactSignTestPower(pi, PINS.equalMagnitudes.length);
    check('v3 sign-flip power == sign test power at pi=' + pi, Math.abs(flip.power - sign) < 1e-9, true);
  }
  for (const pi of [0.7, 0.8, 0.9]) {
    const flip = exactSignFlipPower(PINS.heteroMagnitudes, pi);
    check('v3 sign-flip power hetero pi=' + pi, flip.power, PINS.heteroPower[pi], 1e-6);
  }
  check('v3 sign-flip pi* hetero', piStarForSignFlip(PINS.heteroMagnitudes), PINS.heteroPiStar, 1e-4);
  check('v3 sign-test power m=12 pi=0.85 (V2 table)', exactSignTestPower(0.85, 12), 0.7358, 5e-5);
  check('v3 min tasks for 80% power at pi=0.85', minTasksForPower(0.85), PINS.minTasksPi085);
  check('v3 min tasks for 80% power at pi=0.9', minTasksForPower(0.9), PINS.minTasksPi09);
  check('v3 min tasks for 80% power at pi=0.8', minTasksForPower(0.8), PINS.minTasksPi08);
  check('v3 min tasks for 80% power at pi=0.75', minTasksForPower(0.75), PINS.minTasksPi075);
  check('v3 min tasks for 80% power at pi=0.7', minTasksForPower(0.7), PINS.minTasksPi07);

  // (c) EXACT COVERAGE of the Clopper-Pearson interval (enumerated).
  for (const point of PINS.coveragePoints) {
    const cov = exactIntervalCoverage(point.m, point.pi);
    check('v3 coverage m=' + point.m + ' pi=' + point.pi, cov.coverage, point.coverage, 1e-6);
    if (!(cov.coverage >= 0.95 - 1e-9)) {
      problems.push('v3 coverage at m=' + point.m + ' pi=' + point.pi + ' is below nominal 0.95: ' + cov.coverage);
    }
  }

  // (d) FROZEN SPLIT of the V3 task table + holdout firewall.
  const splitTable = V3_TASKS.map((task) => ({ id: task.id, family: task.family }));
  const splitA = computeV3Split(splitTable);
  splitA.digest = splitManifestDigest(splitA);
  const splitB = computeV3Split(splitTable);
  splitB.digest = splitManifestDigest(splitB);
  check('v3 split determinism', splitManifestDigest(splitA) === splitManifestDigest(splitB), true);
  check('v3 split salt', splitA.salt, PINS.splitSalt);
  check('v3 split digest', splitManifestDigest(splitA), PINS.splitDigest);
  check('v3 split holdout share', splitA.shares.holdout, PINS.splitHoldoutShare, 1e-9);
  check('v3 split holdout families', JSON.stringify(splitA.holdout.families), JSON.stringify(PINS.splitHoldoutFamilies));
  check('v3 split holdout task ids', JSON.stringify(splitA.holdout.taskIds), JSON.stringify(PINS.splitHoldoutTaskIds));
  check('v3 split sides disjoint', splitA.development.taskIds.filter((id) => splitA.holdout.taskIds.includes(id)).length, 0);
  check('v3 split union = table', splitA.development.taskIds.length + splitA.holdout.taskIds.length, splitTable.length);
  // family integrity: every family of the V3 table lies wholly on one side
  const familySides = new Map();
  for (const row of splitTable) {
    const side = splitA.holdout.taskIds.includes(row.id) ? 'hold' : 'dev';
    if (!familySides.has(row.family)) familySides.set(row.family, new Set());
    familySides.get(row.family).add(side);
  }
  for (const [family, sides] of familySides) {
    check('v3 split family integrity: ' + family, sides.size, 1);
  }
  // metric-decoy invariance: the split reads ids/families ONLY.
  const decoyTable = splitTable.map((row, index) => ({
    ...row,
    verifiedRate: index % 2 === 0 ? 1 : 0,
    reward: -index,
    policyChangeRate: 0.5,
    oraclePeek: 'holdout'
  }));
  check('v3 split is metrics-blind (decoy invariance)', splitManifestDigest(computeV3Split(decoyTable)), splitManifestDigest(splitA));

  // the firewall must catch a holdout id inside a selection artifact...
  const badArtifact = { path: 'work/v3-selection.json', content: JSON.stringify({ pool: PINS.splitHoldoutTaskIds }) };
  const caught = checkHoldoutFirewall(splitA, [badArtifact], splitTable);
  check('v3 firewall catches holdout in selection artifact', caught.ok, false);
  check('v3 firewall violation kind', caught.violations.some((v) => v.kind === 'holdout-in-selection-artifact'), true);
  // ...and must pass on clean artifacts.
  const cleanArtifacts = [
    { path: 'work/v3-selection.json', content: JSON.stringify({ pool: splitA.development.taskIds }) },
    { path: 'work/v3-tuning.json', content: JSON.stringify({ grid: 'beta,k,similarityThreshold', pool: 'development' }) }
  ];
  const cleanFirewall = checkHoldoutFirewall(splitA, cleanArtifacts, splitTable);
  check('v3 firewall passes clean artifacts', cleanFirewall.ok, true);
  // ...and a tampered manifest must fail the digest check.
  const tampered = JSON.parse(JSON.stringify(splitA));
  tampered.holdout.taskIds = [tampered.holdout.taskIds[0]];
  const tamperedCheck = verifySplitManifest(tampered, splitTable);
  check('v3 tampered manifest fails closed', tamperedCheck.ok, false);
  check('v3 tampered manifest digest-mismatch', tamperedCheck.violations.some((v) => v.kind === 'digest-mismatch'), true);

  // (e) V3 TASK-TABLE GATE (P2-A discriminability), independently recomputed.
  const liveTableDigest = await designDigest();
  const gate = verifyV3TaskTableGate({ V3_TASKS }, liveTableDigest);
  check('v3 table gate ok', gate.ok, true);
  check('v3 table gate digest == frozen', liveTableDigest, V3_FROZEN_TASK_TABLE_DIGEST);
  check('v3 table gate task count', gate.taskCount, 12);
  check('v3 table gate outside-prefs3 tasks', gate.outsideTop3Tasks, 10);
  check('v3 table gate outside-prefs3 share', gate.outsideTop3Share, 0.833333, 1e-6);
  check('v3 table gate oracle<1 tasks', gate.oracleBelowOne, 6);
  check('v3 table gate headroom tasks', gate.headroomTasks, 7);
  check('v3 table gate min actions per decision point', gate.minActionsPerDecisionPoint, 3);
  check('v3 table gate support matrix rank', gate.supportMatrixRank, 9);
  check('v3 table gate support matrix columns', gate.supportMatrixColumns, 14);
  // the design module's own gate must agree (two independent implementations)
  check('v3 design module gate findings empty', JSON.stringify(designGateFindings()), JSON.stringify([]));
  check('v3 design version', V3_DESIGN_VERSION, 'v3/tasks-20261029');
  check('v3 rounds', V3_ROUNDS, 3);
  // the rank re-computation itself must be able to FAIL (rank-1 fixture)
  check('v3 rank helper flags a rank-1 matrix', matrixRank(rankOneFixture()), 1);

  // the report-completeness checker must accept a complete report...
  const completeReport = {
    confidenceIntervals: { meanDelta: 0, lower: 0, upper: 0, method: 'x', reproducibleCommand: 'node scripts/eval/pr4a-stats.verify.mjs' },
    coverage: { intervalCoverage: 1, surfaceCoverage: 0 },
    policyChangeRate: { value: 0, denominator: 'decision points' },
    winsTiesLosses: { wins: 0, ties: 12, losses: 0, discordantPairs: 0 },
    effectSizes: { meanDelta: 0, sdDelta: 0, dz: null },
    power: { signTestPower: 0, signFlipPower: 0, rejectabilityFloor: {} },
    structuralRejectability: { label: 'structurally-non-rejectable', pMin: 0.03125, alphaStrictest: 0.0125 },
    holdoutFirewall: { manifestDigest: 'x', checkedArtifacts: [], violations: [] }
  };
  check('v3 report completeness: full report passes', checkReportCompleteness(completeReport).ok, true);
  // ...and reject a report that drops a required section.
  const incomplete = JSON.parse(JSON.stringify(completeReport));
  delete incomplete.power;
  const incompleteCheck = checkReportCompleteness(incomplete);
  check('v3 report completeness: dropped section fails', incompleteCheck.ok, false);
  check('v3 report completeness: missing field fails', checkReportCompleteness({ ...completeReport, effectSizes: { meanDelta: 0 } }).ok, false);

  // (f) the frozen split manifest FIXTURE must match the live split.
  const fixturePath = resolve(__dirname, '../..', 'tests/fixtures/p2-l1/p2-v3-split-manifest.json');
  if (existsSync(fixturePath)) {
    const fixtureManifest = JSON.parse(readFileSync(fixturePath, 'utf8'));
    const fixtureCheck = verifySplitManifest(fixtureManifest, splitTable);
    check('v3 split fixture manifest verifies', fixtureCheck.ok, true);
    check('v3 split fixture digest == live split', splitManifestDigest(fixtureManifest), PINS.splitDigest);
    check('v3 split fixture digest field', fixtureManifest.digest, PINS.splitDigest);
  } else {
    problems.push('v3 split fixture missing: tests/fixtures/p2-l1/p2-v3-split-manifest.json');
  }

  // -------------------------------------------------------------------------
  // report
  // -------------------------------------------------------------------------
  if (problems.length === 0) {
    if (emit) {
      console.log('[pr4a-stats] SUCCESS: every pre-registered table and invariant reproduces');
      console.log('[pr4a-stats]   §8.3.1 McNemar boundary  : 7/7 rows');
      console.log('[pr4a-stats]   §8.7   power curve       : 5/5 rows, pi*=' + minDetectableWinRate().toFixed(3) + ', d_min=' + d.d.toFixed(3));
      console.log('[pr4a-stats]   §8.4   width budget      : 6/6 ratios');
      console.log('[pr4a-stats]   §8.5   tuple dimensions  : coexist / independence / band edge');
      console.log('[pr4a-stats]   §8.3.1 exact interval    : bracket + monotone + 12/12 lower=' + twelveOfTwelve.lower.toFixed(4));
      console.log('[pr4a-stats]   V3 rejectability floor   : family=4 rejects only from m_disc>=8 (pMin = 2^(1-m))');
      console.log('[pr4a-stats]   V3 exact sign-flip power : pi*=' + PINS.heteroPiStar.toFixed(4) + ' (12 tasks, heterogeneous magnitudes)');
      console.log('[pr4a-stats]   V3 exact CP coverage     : >= 0.95 at every pinned point (12/0.5 -> ' + PINS.coveragePoints[0].coverage.toFixed(6) + ')');
      console.log('[pr4a-stats]   V3 frozen split          : holdout=' + PINS.splitHoldoutFamilies.join('+') + ' share=' + PINS.splitHoldoutShare + ' digest=' + PINS.splitDigest.slice(0, 16) + '...');
      console.log('[pr4a-stats]   V3 task-table binding    : ' + V3_FROZEN_TASK_TABLE_DIGEST);
    }
  } else if (emit) {
    console.error('[pr4a-stats] FAIL: ' + String(problems.length) + ' problem(s)');
    for (const problem of problems) console.error('  - ' + problem);
  }

  const data = {
    protocol: V3_PROTOCOL_ID,
    v2: { reproduces: problems.filter((p) => p.indexOf('v3 ') !== 0).length === 0 },
    v3: {
      taskTableVersion: V3_DESIGN_VERSION,
      taskTableDigest: V3_FROZEN_TASK_TABLE_DIGEST,
      rejectabilityFloor: rejectabilityFloorTable(12, { familySizes: [1, 4] }).map((entry) => ({
        familySize: entry.familySize,
        alphaStrictest: entry.alphaStrictest,
        minDiscordantForRejectability: entry.minDiscordantForRejectability,
        rows: entry.rows.map((row) => ({ mDisc: row.mDisc, pMin: row.pMin, label: row.label }))
      })),
      signFlipPower: [0.7, 0.8, 0.9].map((pi) => exactSignFlipPower(PINS.heteroMagnitudes, pi)),
      signFlipPiStar: PINS.heteroPiStar,
      minTasksForPower: {
        rawAlpha: { 0.7: PINS.minTasksPi07, 0.8: PINS.minTasksPi08, 0.85: PINS.minTasksPi085, 0.9: PINS.minTasksPi09 },
        holmWorstCase: { 0.8: 31, 0.85: 20, 0.9: 15 }
      },
      coverage: PINS.coveragePoints.map((point) => exactIntervalCoverage(point.m, point.pi)),
      split: splitA,
      splitDigest: PINS.splitDigest,
      taskTableGate: gate,
      problems
    }
  };
  return { problems, data };
} // end main


// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_V3_DOC = resolve(__dirname, '../../docs/reports/p2-preregistration-v3.md');

/** Exact phrases the V3 pre-registration document must contain (doc <-> code binding). */
export const V3_REQUIRED_DOC_MARKERS = [
  V3_PROTOCOL_ID,
  V3_FROZEN_TASK_TABLE_DIGEST,
  'P2-V3-SPLIT-SALT-V1',
  '71cf9b17e8f051a8b53bac8f5825b3fcb64bea961158dc1f5541cd8f8ab00b1d',
  'v3/tasks-20261029',
  'structurally-non-rejectable',
  'pMin = 2^(1-m)',
  'm_disc <= 7',
  'pi* = 0.9011',
  'minTasks(pi=0.85, alpha=0.0125) = 20',
  'coverage(m=12, pi=0.5) = 0.961426',
  'holdout families: ci-fix'
];

function parseArgs(argv) {
  const args = argv.slice(2);
  const valueOf = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const allOf = (name) => {
    const values = [];
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === name && args[index + 1] !== undefined) values.push(args[index + 1]);
    }
    return values;
  };
  return {
    json: args.includes('--json'),
    split: args.includes('--split'),
    v3Table: args.includes('--v3-table'),
    firewall: valueOf('--firewall'),
    artifacts: allOf('--artifact'),
    checkDoc: args.includes('--check-doc') ? (valueOf('--check-doc') ?? DEFAULT_V3_DOC) : undefined,
    emitPins: args.includes('--emit-pins')
  };
}

async function cli() {
  const options = parseArgs(process.argv);

  if (options.emitPins) {
    console.log(JSON.stringify({ note: 'development helper: first-run pin capture', heteroPower: [0.7, 0.8, 0.9].map((pi) => exactSignFlipPower([0.25, 0.25, 0.5, 0.5, 1, 1, 1, 1, 1.5, 1.5, 2, 2], pi).power) }, null, 2));
    return;
  }

  if (options.split) {
    const table = V3_TASKS.map((task) => ({ id: task.id, family: task.family }));
    const manifest = computeV3Split(table);
    manifest.digest = splitManifestDigest(manifest);
    const check = verifySplitManifest(manifest, table);
    if (!check.ok) {
      console.error('[pr4a-stats] split FAIL: ' + JSON.stringify(check.violations));
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  if (options.firewall !== undefined) {
    const manifest = JSON.parse(readFileSync(options.firewall, 'utf8'));
    const artifacts = options.artifacts.map((path) => ({ path, content: readFileSync(path, 'utf8') }));
    const verdict = checkHoldoutFirewall(manifest, artifacts);
    console.log(JSON.stringify(verdict, null, 2));
    process.exitCode = verdict.ok ? 0 : 1;
    return;
  }

  if (options.v3Table) {
    const liveDigest = await designDigest();
    const gate = verifyV3TaskTableGate({ V3_TASKS }, liveDigest);
    console.log(JSON.stringify({ digest: liveDigest, frozenDigest: V3_FROZEN_TASK_TABLE_DIGEST, gate }, null, 2));
    process.exitCode = gate.ok ? 0 : 1;
    return;
  }

  if (options.checkDoc !== undefined) {
    const path = resolve(options.checkDoc);
    if (!existsSync(path)) {
      console.error('[pr4a-stats] doc check FAIL: not found: ' + path);
      process.exitCode = 1;
      return;
    }
    const content = readFileSync(path, 'utf8');
    const missing = V3_REQUIRED_DOC_MARKERS.filter((marker) => !content.includes(marker));
    if (missing.length > 0) {
      console.error('[pr4a-stats] doc check FAIL: ' + String(missing.length) + ' required marker(s) missing');
      for (const marker of missing) console.error('  - ' + marker);
      process.exitCode = 1;
      return;
    }
    console.log('[pr4a-stats] doc check OK: ' + String(V3_REQUIRED_DOC_MARKERS.length) + ' markers bound to ' + path);
    return;
  }

  const { problems, data } = await main({ emit: !options.json });
  if (options.json) console.log(JSON.stringify(data, null, 2));
  process.exitCode = problems.length === 0 ? 0 : 1;
}

const isDirectExecution =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectExecution) {
  await cli();
}
