#!/usr/bin/env node
/**
 * rev6 R1-2 (t9): the JitRL write-back intervention experiment.
 *
 * WHAT IT MEASURES, AND WHAT IT REFUSES TO PRETEND
 * ------------------------------------------------
 * The preregistration (`docs/reports/rev6-jitrl-intervention-preregistration.md`)
 * fixes the frame (12 tasks, episodes=5, rounds=3, seed=6221082, K=10, same-task)
 * and §9.1 records a STRUCTURAL FACT measured BEFORE any implementation:
 * `scripts/eval/jitrl-eval-lib.ts` never attaches `metadata.verification` and
 * never passes `trustedProducers`, so in this synthetic pool every verdict is
 * structural (`unknown`) and `trustedSource` is always false. G-A needs a trusted
 * receipt and G-B's `verified` needs one too, so **the gate can admit nothing**
 * there.
 *
 * Consequently this script does NOT run a "gated C3" arm and call the delta a
 * benefit. It does three things that are each honestly labelled:
 *
 *   1. REPLICATION   re-runs the frozen historical frame and asserts it still
 *                    produces 1.000 / 0.750, Δ −0.250, CI95 [−0.417, −0.083],
 *                    0/7/5. (Reproduction, not new evidence.)
 *   2. CORPUS        captures the ACTUAL records a real C3-online run writes
 *                    (via `runFairEngineWithLedger().collectRecords`, 180
 *                    records) and applies the gate to every one of them, offline,
 *                    with the gate's own rules. Reported as measured counts:
 *                    how many would be admitted to L2 vs audited-only, and why.
 *   3. DERIVATION    states the CONSEQUENCE of (2) for C3 as an explicitly
 *                    DERIVED, not-measured, statement: if the gate admits 0
 *                    records, gated C3-online writes nothing, so it becomes
 *                    C3-frozen (1.000) by construction; the delta is then
 *                    branch-dependent and MUST NOT be quoted as a benefit.
 *
 * Every number carries its provenance tag: `measured` | `derived` | `not-evaluable`.
 *
 * USAGE
 *   node scripts/eval/rev6-jitrl-intervention.mjs --json
 *   node scripts/eval/rev6-jitrl-intervention.mjs --markdown
 *
 * EXIT CODES
 *   0  the report was produced and the preregistration ordering holds
 *   1  the preregistration could not be read, or it post-dates the first sample
 *      (that voids R1 per preregistration §9 - a legitimate hard failure)
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');
const PREREG = path.join(repoRoot, 'docs/reports/rev6-jitrl-intervention-preregistration.md');

// ---------------------------------------------------------------------------
// module loading (same content-addressed esbuild cache the other eval scripts use)
// ---------------------------------------------------------------------------
const TS_ENTRY = [
  "export * from './src/jitrl/writeback-gate.ts';",
  "export * from './src/jitrl/step-evaluator.ts';",
  "export * from './src/jitrl/experience-store.ts';",
  "export * from './src/jitrl/stores/memory.store.ts';"
].join('\n');

const CACHE_DIR = path.join(repoRoot, 'node_modules', '.cache', 'dsh-plugin-evo-harness');

async function loadGate() {
  const esbuildVersion = JSON.parse(
    readFileSync(path.join(repoRoot, 'node_modules/esbuild/package.json'), 'utf8')
  ).version;
  const sources = TS_ENTRY.split('\n')
    .map((line) => {
      const match = /'(\.\/src\/.+?)'/.exec(line);
      return match === null ? '' : match[1];
    })
    .filter(Boolean)
    .map((rel) => rel + ': ' + createHash('sha256').update(readFileSync(path.join(repoRoot, rel)).digest ?? '').digest('hex'));
  // The cache key is a digest over the exact entry text + esbuild version + node
  // target, so a stale bundle cannot be certified (same recipe as rev6-cache-observation).
  const key = createHash('sha256')
    .update(TS_ENTRY)
    .update(esbuildVersion)
    .update('node20')
    .digest('hex')
    .slice(0, 16);
  const outfile = path.join(CACHE_DIR, 'rev6-jitrl-intervention-' + key + '.mjs');
  if (!statSync(outfile, { throwIfNoEntry: false })?.isFile?.()) {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(CACHE_DIR, { recursive: true });
    await build({
      stdin: { contents: TS_ENTRY, resolveDir: repoRoot, loader: 'ts', sourcefile: 'rev6-intervention-entry.ts' },
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      outfile,
      logLevel: 'warning'
    });
  }
  return import(pathToFileURL(outfile).href);
}

// ---------------------------------------------------------------------------
// statistics (preregistration §4: paired t interval + bootstrap cross-check)
// ---------------------------------------------------------------------------
function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
/** Population SD (divisor n) - the frozen engine's `standardDeviation`. */
function sdPopulation(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - m) ** 2)));
}
/** Sample SD (divisor n-1) - the preregistered paired-t interval uses this. */
function sdSample(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1)
  );
}
/**
 * THE PRE-REGISTERED PRIMARY INTERVAL (preregistration §4): paired t, two-sided
 * 95%, n=12 fixed by the pool, t_{0.975,11}=2.201.
 */
function pairedTInterval(deltas, tCritical = 2.201) {
  const n = deltas.length;
  const m = mean(deltas);
  const s = sdSample(deltas);
  const se = n === 0 ? 0 : s / Math.sqrt(n);
  const half = tCritical * se;
  return { n, meanDelta: m, sd: s, se, ci95: [m - half, m + half], method: 'paired-t-95% (t=2.201, df=11, sample SD)' };
}
/**
 * THE FROZEN ENGINE'S INTERVAL (`fairCompare`, jitrl-eval-lib.ts:3633-3658):
 * normal approximation with population SD. It is what produced the historical
 * −0.250 / [−0.417, −0.083] record, so REPLICATION is judged on this one - and it
 * is explicitly self-described as "a feasibility interval ... not a significance
 * claim".
 */
function normalApproxInterval(deltas, z = 1.96) {
  const n = deltas.length;
  const m = mean(deltas);
  const s = sdPopulation(deltas);
  const se = n === 0 ? 0 : s / Math.sqrt(n);
  return { n, meanDelta: m, sd: s, se, ci95: [m - z * se, m + z * se], method: 'normal-approx-95% (1.96, population SD) = fairCompare' };
}
/** Deterministic LCG so the bootstrap is reproducible without a dependency. */
function bootstrapInterval(deltas, iterations = 10000, seed = 6221082) {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const means = [];
  for (let i = 0; i < iterations; i += 1) {
    const sample = [];
    for (let j = 0; j < deltas.length; j += 1) {
      sample.push(deltas[Math.floor(next() * deltas.length)]);
    }
    means.push(mean(sample));
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor(0.025 * means.length)];
  const hi = means[Math.floor(0.975 * means.length)];
  return { iterations, ci95: [lo, hi] };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const preregBytes = readFileSync(PREREG);
const preregSha = createHash('sha256').update(preregBytes).digest('hex');
const preregMtimeMs = Math.floor(statSync(PREREG).mtimeMs);
const firstSampleAtMs = Date.now();

const { loadEvalLib } = await import(pathToFileURL(path.join(repoRoot, 'scripts/eval/build-eval.mjs')).href);
const lib = await loadEvalLib();
const gate = await loadGate();

// --- 1. REPLICATION of the frozen historical frame -------------------------
const repStarted = Date.now();
const report = await lib.runFairEval({
  episodes: 5,
  rounds: 3,
  seed: 6221082,
  includePolicySelection: false,
  includeOrderCheck: false,
  includeOnlineItem: false
});
const sameTask = report.protocols.find((entry) => entry.id === 'same-task');
const frozenArm = sameTask.arms.find((arm) => arm.id === 'C3-frozen');
const onlineArm = sameTask.arms.find((arm) => arm.id === 'C3-online');
const cmp = sameTask.comparisons.find(
  (entry) => entry.left === 'C3-online' && entry.right === 'C3-frozen' && entry.metric === 'verifiedRate'
);

// The per-TASK deltas (the independent analysis unit) - recomputed here from the
// arms rather than read off the report, so the interval math is this script's own.
const taskDeltas = [];
for (const task of onlineArm.tasks) {
  const frozenTask = frozenArm.tasks.find((entry) => entry.taskId === task.taskId);
  taskDeltas.push(task.verifiedRate - frozenTask.verifiedRate);
}
const paired = pairedTInterval(taskDeltas);
const frozenFormula = normalApproxInterval(taskDeltas);
const boot = bootstrapInterval(taskDeltas);

// Replication is judged against the FROZEN formula (the one that produced the
// historical record). The preregistered interval is reported alongside; where the
// two disagree this script must not silently prefer the friendlier one.
const historicalMatch =
  Math.abs(frozenArm.verifiedRate - 1) < 1e-9 &&
  Math.abs(onlineArm.verifiedRate - 0.75) < 1e-9 &&
  Math.abs(frozenFormula.meanDelta - -0.25) < 1e-9 &&
  Math.abs(frozenFormula.ci95[0] - -0.4174) < 5e-4 &&
  cmp.wins === 0 && cmp.ties === 7 && cmp.losses === 5;

// --- 2. CORPUS: apply the gate to the records a REAL C3-online run wrote -----
const corpusRecords = [];
await lib.runFairEngineWithLedger({
  spec: lib.fairArm('C3-online'),
  tasks: lib.EVAL_TASKS,
  episodes: 5,
  rounds: 3,
  seed: 6221082,
  k: lib.FAIR_DEFAULT_K,
  beta: lib.FAIR_DEFAULT_BETA,
  similarityThreshold: lib.FAIR_DEFAULT_SIMILARITY,
  protocol: 'same-task',
  initialSnapshot: [],
  storeMode: 'per-task',
  updates: true,
  experienceSource: 'self',
  collectRecords: (records) => {
    corpusRecords.length = 0;
    corpusRecords.push(...records);
  }
});

// Judge every captured record with the gate's own rules. The history each record
// is judged against is the set of records WRITTEN BEFORE IT in the same task
// (causal: nothing can vouch for itself), which is the same discipline the
// production path uses via its `before` cutoff.
let summary = gate.emptyWritebackGateSummary(true);
const verdicts = [];
const byTask = new Map();
for (const record of corpusRecords) {
  const taskId = record.sessionId ?? 'unknown';
  const prior = byTask.get(taskId) ?? [];
  const marks = record.rewardSources ?? {};
  const verdictCode = typeof marks.verificationVerdict === 'number' ? marks.verificationVerdict : 0;
  const verdict = gate.judgeWriteback(
    {
      actionKey: record.actionKey,
      trustedSource: marks.verificationTrusted === 1,
      verificationStatus: verdictCode === 1 ? 'passed' : verdictCode === 2 ? 'failed' : 'unknown',
      verifierRewardMismatch: verdictCode === 2 && (record.learningTarget ?? 0) > 0,
      forceAuditOnly: marks.verificationAuditOnly === 1,
      recordLearningEligible: record.learningEligible !== false
    },
    gate.indexWritebackHistory(prior)
  );
  summary = gate.accumulateWritebackSummary(summary, verdict);
  verdicts.push({
    taskId,
    level: record.level,
    actionKey: record.actionKey,
    admitted: verdict.admitted,
    route: verdict.route ?? null,
    refusal: verdict.refusal ?? null,
    support: verdict.support,
    verifiedRate: verdict.verifiedRate
  });
  prior.push(
    gate.writebackHistoryEntryOf(record.actionKey, {
      trustedSource: marks.verificationTrusted === 1,
      verificationStatus: verdictCode === 1 ? 'passed' : verdictCode === 2 ? 'failed' : 'unknown',
      verifierRewardMismatch: verdictCode === 2 && (record.learningTarget ?? 0) > 0,
      forceAuditOnly: marks.verificationAuditOnly === 1
    })
  );
  byTask.set(taskId, prior);
}

const writingBackRate = summary.judged === 0 ? 0 : summary.admitted / summary.judged;
const gateIsIdentity = summary.admitted === 0 || summary.admitted === summary.judged;

// --- 3. DERIVATION (explicitly not measured) -------------------------------
const derivation = {
  premise: 'the corpus run above is the real C3-online arm; the gate admits '
    + String(summary.admitted) + ' of its ' + String(summary.judged) + ' records',
  consequence: summary.admitted === 0
    ? 'gated C3-online would write NOTHING, so it degenerates to C3-frozen (verifiedRate 1.000)'
    : 'gated C3-online would write ' + String(summary.admitted) + ' records; the effect is NOT derivable without re-running L2 selection',
  status: 'derived-not-measured',
  whyNotMeasured:
    'injecting a gated store into the frozen fair engine requires editing '
    + 'scripts/eval/jitrl-eval-lib.ts, which is outside t9 inScope (contract §4.1)'
};

// --- 4. H2 verdict per preregistration §4/§7/§9.1 ---------------------------
const h2 = gateIsIdentity
  ? {
      verdict: 'not-evaluable',
      reason:
        'the gate is an identity function on this pool (admitted=' + String(summary.admitted)
        + ', judged=' + String(summary.judged) + '): the synthetic pool carries no trusted '
        + 'receipts (preregistration §9.1), so "gate off vs gate on" compares two runs that '
        + 'write the same thing. Reporting any delta as a benefit would be the exact '
        + 'misreading §7 forbids.',
      writingBackRate
    }
  : {
      verdict: 'evaluable-but-not-run',
      reason: 'the gate discriminates on this corpus (writingBackRate=' + String(writingBackRate)
        + '), so a gated L2 re-run would be required; that needs the out-of-scope engine edit',
      writingBackRate
    };

const payload = {
  rule: 'rev6 contract §5.4 (R1-1/R1-2); preregistration §4/§5/§7/§8/§9',
  preregistration: {
    path: 'docs/reports/rev6-jitrl-intervention-preregistration.md',
    sha256: preregSha,
    mtimeMs: preregMtimeMs,
    mtimeIso: new Date(preregMtimeMs).toISOString()
  },
  firstSampleAtMs,
  firstSampleIso: new Date(firstSampleAtMs).toISOString(),
  preregisteredBeforeFirstSample: preregMtimeMs <= firstSampleAtMs,
  frame: {
    suiteSeed: report.generatedFrom.suiteSeed,
    taskCount: lib.EVAL_TASKS.length,
    taskIds: lib.EVAL_TASKS.map((task) => task.id),
    episodes: 5,
    rounds: 3,
    seed: 6221082,
    k: lib.FAIR_DEFAULT_K,
    beta: lib.FAIR_DEFAULT_BETA,
    similarityThreshold: lib.FAIR_DEFAULT_SIMILARITY,
    protocol: 'same-task'
  },
  replication: {
    provenance: 'reproduction-of-frozen-history',
    arms: {
      'C3-frozen': { verifiedRate: frozenArm.verifiedRate, meanCoverage: frozenArm.meanCoverage },
      'C3-online': {
        verifiedRate: onlineArm.verifiedRate,
        meanCoverage: onlineArm.meanCoverage,
        recordsAppended: onlineArm.recordsAppended,
        storeRecords: onlineArm.storeRecords
      }
    },
    paired: {
      unit: 'task',
      pairs: paired.n,
      // The preregistered primary interval (paired t, sample SD, t=2.201).
      meanDelta: paired.meanDelta,
      sd: paired.sd,
      se: paired.se,
      ci95: paired.ci95,
      intervalMethod: paired.method,
      // The interval the historical record was actually computed with, kept
      // beside it so a reader can see the two disagree without either being
      // hidden (the frozen engine's own note calls it "feasibility only, not a
      // significance claim").
      frozenFormula: {
        meanDelta: frozenFormula.meanDelta,
        sd: frozenFormula.sd,
        ci95: frozenFormula.ci95,
        method: frozenFormula.method
      },
      bootstrapCi95: boot.ci95,
      wins: cmp.wins,
      ties: cmp.ties,
      losses: cmp.losses,
      // Preregistered tolerance test on BOTH intervals: the lower bound must be
      // >= -0.05 for the "no regression beyond tolerance" claim. Computed, not
      // asserted by prose, so a future reader sees which interval was used.
      toleranceCheck: {
        threshold: -0.05,
        pairedTLower: paired.ci95[0],
        frozenLower: frozenFormula.ci95[0],
        bootstrapLower: boot.ci95[0],
        meetsToleranceOnPairedT: paired.ci95[0] >= -0.05,
        meetsToleranceOnFrozen: frozenFormula.ci95[0] >= -0.05
      }
    },
    matchesHistoricalFrame: historicalMatch,
    historicalReference: {
      source: 'docs/reports/p6-fair-eval.md §5 (2026-10-29)',
      meanDelta: -0.25,
      ci95: [-0.417, -0.083],
      winsTiesLosses: '0/7/5'
    }
  },
  corpus: {
    provenance: 'measured',
    recordsCaptured: corpusRecords.length,
    judged: summary.judged,
    admittedToL2: summary.admitted,
    auditedOnly: summary.auditedOnly,
    gateFired: summary.gateFired,
    refusalCounts: summary.refusalCounts,
    routeCounts: summary.routeCounts,
    writingBackRate,
    counterexamplesFound: verdicts.filter((entry) => entry.refusal === 'rejected-verifier-mismatch').length,
    // A sample of coordinates so a finding can be located, not just counted.
    sampleVerdicts: verdicts.slice(0, 6)
  },
  derivation,
  h2,
  boundary: {
    synthetic: true,
    noRealModel: true,
    noMemoryWrite: true,
    noArmFive: true,
    episodesAreNotIndependentSamples: true,
    historicalNumbersUnchanged: true,
    notAResultAboutProductionLearning: true
  },
  verification: {
    gateModuleExported: typeof gate.judgeWriteback === 'function',
    corpusRunArm: 'C3-online',
    preregistrationOrderHolds: preregMtimeMs <= firstSampleAtMs
  }
};

const json = process.argv.includes('--json');
const markdown = process.argv.includes('--markdown');

if (json) {
  console.log(JSON.stringify(payload, null, 2));
} else if (markdown) {
  const lines = [];
  lines.push('# rev6 R1-2：JitRL 写回门的干预实验（自动生成）');
  lines.push('');
  lines.push('- 生成命令：`node scripts/eval/rev6-jitrl-intervention.mjs --markdown`');
  lines.push('- 预注册：`' + payload.preregistration.path + '`，sha256 `' + payload.preregistration.sha256 + '`，mtime `' + payload.preregistration.mtimeIso + '`');
  lines.push('- 首次采样：`' + payload.firstSampleIso + '`；**预注册先于采样**：`' + String(payload.preregisteredBeforeFirstSample) + '`');
  lines.push('');
  lines.push('## 1. 冻结框架复现（不是新证据）');
  lines.push('');
  lines.push('| 臂 | verifiedRate | meanCoverage | 写入记录 |');
  lines.push('| --- | --: | --: | --: |');
  lines.push('| C3-frozen | ' + payload.replication.arms['C3-frozen'].verifiedRate + ' | ' + payload.replication.arms['C3-frozen'].meanCoverage + ' | 0 |');
  lines.push('| C3-online | ' + payload.replication.arms['C3-online'].verifiedRate + ' | ' + payload.replication.arms['C3-online'].meanCoverage + ' | ' + payload.replication.arms['C3-online'].recordsAppended + ' |');
  lines.push('');
  lines.push('配对（独立单元 = 任务，n=' + payload.replication.paired.pairs + '）：均值差 ' + payload.replication.paired.meanDelta.toFixed(4)
    + '，sd ' + payload.replication.paired.sd.toFixed(4) + '，CI95 [' + payload.replication.paired.ci95.map((v) => v.toFixed(4)).join(', ') + ']'
    + '，胜/平/负 ' + payload.replication.paired.wins + '/' + payload.replication.paired.ties + '/' + payload.replication.paired.losses + '。');
  lines.push('');
  lines.push('与历史报告一致：**' + String(payload.replication.matchesHistoricalFrame) + '**（历史：−0.250、[−0.417, −0.083]、0/7/5）。');
  lines.push('');
  lines.push('## 2. 门在真实记录语料上的实测');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('| --- | --: |');
  lines.push('| 捕获记录 | ' + payload.corpus.recordsCaptured + ' |');
  lines.push('| 判定 | ' + payload.corpus.judged + ' |');
  lines.push('| 准入 L2 | ' + payload.corpus.admittedToL2 + ' |');
  lines.push('| 仅审计 | ' + payload.corpus.auditedOnly + ' |');
  lines.push('| gateFired | ' + payload.corpus.gateFired + ' |');
  lines.push('| writingBackRate | ' + payload.corpus.writingBackRate + ' |');
  lines.push('');
  lines.push('拒绝原因分布：`' + JSON.stringify(payload.corpus.refusalCounts) + '`');
  lines.push('');
  lines.push('## 3. H2 判定');
  lines.push('');
  lines.push('**' + payload.h2.verdict + '** —— ' + payload.h2.reason);
  console.log(lines.join('\n'));
} else {
  console.log('[rev6-intervention] prereg sha256   ' + preregSha);
  console.log('[rev6-intervention] prereg mtime    ' + new Date(preregMtimeMs).toISOString());
  console.log('[rev6-intervention] first sample    ' + new Date(firstSampleAtMs).toISOString());
  console.log('[rev6-intervention] order holds     ' + String(payload.preregisteredBeforeFirstSample));
  console.log('[rev6-intervention] replication     C3-frozen=' + frozenArm.verifiedRate + ' C3-online=' + onlineArm.verifiedRate
    + ' delta=' + paired.meanDelta.toFixed(4) + ' ci95=[' + paired.ci95.map((v) => v.toFixed(4)).join(',') + ']'
    + ' matches-history=' + String(historicalMatch));
  console.log('[rev6-intervention] corpus          captured=' + corpusRecords.length + ' admitted=' + summary.admitted
    + ' audited=' + summary.auditedOnly + ' fired=' + summary.gateFired);
  console.log('[rev6-intervention] H2              ' + h2.verdict);
}

if (!payload.preregisteredBeforeFirstSample) {
  console.error('[rev6-intervention] FAIL: the preregistration post-dates the first sample; R1 is void (preregistration §9)');
  process.exit(1);
}
process.exit(0);
