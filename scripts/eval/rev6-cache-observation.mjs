#!/usr/bin/env node
/**
 * rev6 R2-3 / R4: produce the cacheRead + recall-shadow observation report.
 *
 * WHAT THIS SCRIPT IS FOR
 * -----------------------
 * It answers, with numbers taken from data this repository ACTUALLY HAS:
 *   1. what precision the cacheRead evidence is at (measured / estimated / unknown);
 *   2. whether prefix caching has measurably reduced cacheRead tokens, and
 *      therefore whether proposing Tail Injection is justified;
 *   3. what a `whenToApply` positive filter WOULD do in shadow - hit rate and
 *      friendly-fire rate - without enabling it or writing anything.
 *
 * HARD RULES (enforced below, not just documented)
 * ------------------------------------------------
 *   - It performs NO network, NO model call, NO paid API and NO memory write.
 *     The `--json` output is a record, not a side effect.
 *   - It never relabels estimated/unknown data as measured: the precision comes
 *     from the frozen artifact's own `precision` fields and from the observation
 *     module's rules.
 *   - When the only data available is estimated (which is the case today), the
 *     gate stays closed and the report says so; `--require-applicable` exists so
 *     CI can PROVE it stays closed rather than trusting prose.
 *
 * USAGE
 *   node scripts/eval/rev6-cache-observation.mjs --json
 *   node scripts/eval/rev6-cache-observation.mjs --markdown
 *   node scripts/eval/rev6-cache-observation.mjs --json --require-gated
 *
 * EXIT CODES
 *   0  report produced (and, with --require-gated, the gate stayed closed)
 *   1  --require-gated was passed but the gate opened, or a required input is
 *      missing/unreadable (fail closed: a missing fixture is not "no problem")
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');
const ARTIFACT = path.join(repoRoot, 'tests/fixtures/pr4a/pr4a-five-arm-eval.json');

/**
 * The TypeScript sources this script needs.
 *
 * WHY COMPILED RATHER THAN IMPORTED DIRECTLY: the modules use extensionless
 * relative specifiers and TypeScript annotations, so a bare `import()` under
 * Node needs implicit type stripping. `scripts/eval/build-eval.mjs` documents
 * why that is fragile (a non-erasable construct anywhere in the graph aborts the
 * run before any work happens). The established fix in this repo is to compile
 * to a content-addressed artifact under `node_modules/.cache`, which is
 * gitignored and inside the package-resolution root.
 *
 * The cache key is a SHA-256 over the exact sources plus the esbuild version and
 * the node target, so a stale artifact is impossible without a matching key -
 * no timestamp heuristics.
 */
const TS_ENTRY_CONTENTS = [
  "export * from './src/dsh-bridge/cache-observation.ts';",
  "export * from './src/memory-bridge/recall-shadow-analysis.ts';",
  "export { DEFAULT_DSH_COUNTING_SEMANTICS } from './src/ledger/pricing.ts';"
].join('\n');

const CACHE_DIR = path.join(repoRoot, 'node_modules', '.cache', 'dsh-plugin-evo-harness');
const NODE_TARGET = 'node20';

async function loadModules() {
  const esbuildVersion = JSON.parse(
    readFileSync(path.join(repoRoot, 'node_modules', 'esbuild', 'package.json'), 'utf8')
  ).version;
  const key = createHash('sha256')
    .update(TS_ENTRY_CONTENTS)
    .update(readFileSync(path.join(repoRoot, 'src', 'dsh-bridge', 'cache-observation.ts')))
    .update(readFileSync(path.join(repoRoot, 'src', 'memory-bridge', 'recall-shadow-analysis.ts')))
    .update(readFileSync(path.join(repoRoot, 'src', 'memory-bridge', 'governance-polyfill.ts')))
    .update(readFileSync(path.join(repoRoot, 'src', 'ledger', 'pricing.ts')))
    .update('\n' + esbuildVersion + '\n' + NODE_TARGET + '\n')
    .digest('hex')
    .slice(0, 16);
  const artifact = path.join(CACHE_DIR, 'rev6-cache-observation-' + key + '.mjs');
  if (!existsSync(artifact)) {
    mkdirSync(CACHE_DIR, { recursive: true });
    await build({
      stdin: {
        contents: TS_ENTRY_CONTENTS,
        resolveDir: repoRoot,
        loader: 'ts'
      },
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: NODE_TARGET,
      // npm dependencies stay external: the artifact lives inside
      // node_modules/.cache, so bare specifiers resolve from the repo root.
      packages: 'external',
      outfile: artifact,
      logLevel: 'warning'
    });
  }
  return import(pathToFileURL(artifact).href);
}

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const markdownMode = args.includes('--markdown');
const requireGated = args.includes('--require-gated');
const unknownFlags = args.filter((arg) => !['--json', '--markdown', '--require-gated'].includes(arg));
if (unknownFlags.length > 0) {
  console.error('[rev6-cache] unknown argument(s): ' + unknownFlags.join(', '));
  process.exitCode = 1;
} else {
  run().catch((error) => {
    console.error('[rev6-cache] unexpected failure: ' + String(error && error.stack ? error.stack : error));
    process.exitCode = 1;
  });
}

async function run() {
  const modules = await loadModules();
  const {
    cacheOptimizationGate,
    observeEstimatedCacheUsage,
    observeCacheUsage,
    pairByTask,
    summarizeCacheObservations,
    analyzeRecallShadow,
    renderRecallShadowMarkdown,
    DEFAULT_DSH_COUNTING_SEMANTICS
  } = modules;
  // ---- 1. the frozen artifact: what data do we actually have? -------------
  let artifact;
  try {
    artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
  } catch (error) {
    // Fail closed: a missing fixture must never read as "no cacheRead problem".
    console.error('[rev6-cache] cannot read ' + path.relative(repoRoot, ARTIFACT) + ': ' + String(error && error.message ? error.message : error));
    process.exitCode = 1;
    return;
  }

  const perArm = Array.isArray(artifact?.tokenFields?.perArm) ? artifact.tokenFields.perArm : [];
  const estimator = String(artifact?.tokenFields?.estimator ?? 'unknown');
  if (perArm.length === 0) {
    console.error('[rev6-cache] the artifact carries no per-arm token fields; cannot report');
    process.exitCode = 1;
    return;
  }

  // ---- 2. reconstruct the cacheRead observation from the artifact ---------
  // Every arm is ESTIMATED (the artifact's own precision says so), so each call
  // is observed through the estimated path. This is not a downgrade of measured
  // data - there is no measured data - and the observation module keeps the
  // provenance string visible in the report.
  const samples = [];
  const armLabels = [];
  perArm.forEach((arm, armIndex) => {
    const armLabel = armIndex % 2 === 0 ? 'baseline' : 'treatment';
    armLabels.push({ armId: arm.armId, armLabel, precision: arm.cacheReadTokens?.precision ?? 'unknown' });
    const calls = Number.isInteger(arm.modelCalls) ? arm.modelCalls : 0;
    for (let call = 0; call < calls; call += 1) {
      samples.push(
        observeEstimatedCacheUsage({
          callId: arm.armId + '#' + String(call),
          // Cycling task ids pairs the two arms on the same tasks.
          taskId: 'pr4a-task-' + String(call % 12),
          arm: armLabel,
          purpose: 'pr4a-five-arm',
          cacheReadTokens: arm.cacheReadTokens?.tokens ?? 0,
          inputTokens: arm.totalTokens?.tokens ?? 0,
          outputTokens: 0,
          estimator
        })
      );
    }
  });

  const pairs = pairByTask(samples);
  const gate = cacheOptimizationGate(pairs);
  const accounting = summarizeCacheObservations(samples);

  // ---- 3. a measured-provenance sample set, to show the OTHER branch ------
  // Taken from the same frozen numbers but labelled measured ON PURPOSE, so the
  // report can demonstrate what the gate would say IF the provider had declared
  // semantics. This is a WHAT-IF, clearly labelled, and it is never mixed into
  // the primary accounting above.
  const whatIfSamples = [];
  perArm.forEach((arm, armIndex) => {
    const armLabel = armIndex % 2 === 0 ? 'baseline' : 'treatment';
    const calls = Number.isInteger(arm.modelCalls) ? arm.modelCalls : 0;
    for (let call = 0; call < calls; call += 1) {
      whatIfSamples.push(
        observeCacheUsage({
          callId: arm.armId + '#whatif#' + String(call),
          taskId: 'pr4a-task-' + String(call % 12),
          arm: armLabel,
          purpose: 'pr4a-five-arm (what-if measured)',
          rawUsage: {
            inputTokens: arm.totalTokens?.tokens ?? 0,
            outputTokens: 0,
            cacheReadTokens: arm.cacheReadTokens?.tokens ?? 0
          },
          semantics: DEFAULT_DSH_COUNTING_SEMANTICS
        })
      );
    }
  });
  const whatIfPairs = pairByTask(whatIfSamples);
  const whatIfGate = cacheOptimizationGate(whatIfPairs);

  // ---- 4. the recall shadow: what WOULD a positive filter do? ------------
  // Fixtures are structural lessons over queries drawn from this run's own
  // vocabulary; nothing is read from or written to a memory backend.
  const shadowLessons = [
    {
      source: 'rev6 synthetic probe (cjk cue)',
      lesson: {
        id: 'rev6-shadow-cjk',
        title: '缓存前缀命中率下降时检查 prefix 复用',
        whenToApply: ['缓存前缀命中率下降'],
        whenNotToApply: ['简单的表格任务'],
        subFunctions: ['scripts'],
        executionPatch: { kind: 'noop' },
        verificationEvidence: { checks: [] },
        polarity: 'positive',
        visibility: 'session',
        sessionId: 'rev6-shadow-session'
      }
    },
    {
      source: 'rev6 synthetic probe (latin cue)',
      lesson: {
        id: 'rev6-shadow-latin',
        title: 'check cacheRead provenance before claiming a saving',
        whenToApply: ['cacheRead provenance measured'],
        whenNotToApply: ['estimated tokens only'],
        subFunctions: ['scripts'],
        executionPatch: { kind: 'noop' },
        verificationEvidence: { checks: [] },
        polarity: 'positive',
        visibility: 'session',
        sessionId: 'rev6-shadow-session'
      }
    }
  ];
  const shadowQueries = [
    { queryId: 'q-cjk-hit', query: { scope: { sessionId: 'rev6-shadow-session', namespace: 'harness2:session:rev6-shadow' }, text: '这次运行缓存前缀命中率下降了，先排查 prefix 复用', limit: 5 } },
    { queryId: 'q-cjk-friendly-fire', query: { scope: { sessionId: 'rev6-shadow-session', namespace: 'harness2:session:rev6-shadow' }, text: '缓存前缀命中率下降，但这是一个简单的表格任务', limit: 5 } },
    { queryId: 'q-latin-hit', query: { scope: { sessionId: 'rev6-shadow-session', namespace: 'harness2:session:rev6-shadow' }, text: 'is the cacheRead provenance measured for this arm', limit: 5 } },
    { queryId: 'q-latin-friendly-fire', query: { scope: { sessionId: 'rev6-shadow-session', namespace: 'harness2:session:rev6-shadow' }, text: 'cacheRead provenance measured but estimated tokens only here', limit: 5 } },
    { queryId: 'q-unrelated', query: { scope: { sessionId: 'rev6-shadow-session', namespace: 'harness2:session:rev6-shadow' }, text: 'rename a local variable in the build script', limit: 5 } }
  ];
  const shadow = analyzeRecallShadow({
    lessons: shadowLessons.map((entry) => ({ lesson: entry.lesson, source: entry.source })),
    queries: shadowQueries
  });

  // ---- 5. assemble the report --------------------------------------------
  const generatedAt = new Date().toISOString();
  const report = {
    generatedAt,
    commit: safeGitCommit(),
    inputs: {
      artifact: path.relative(repoRoot, ARTIFACT).replace(/\\/g, '/'),
      estimator,
      armLabels
    },
    cacheRead: {
      accounting,
      pairCount: pairs.length,
      completePairs: pairs.filter((pair) => pair.complete).length,
      gate,
      whatIfMeasured: {
        note:
          'WHAT-IF ONLY: the same frozen token numbers labelled measured, to demonstrate the gate\'s open branch. ' +
          'The provider never declared counting semantics for these calls, so this is NOT evidence of a saving and is ' +
          'excluded from the accounting above.',
        accounting: summarizeCacheObservations(whatIfSamples),
        pairCount: whatIfPairs.length,
        gate: whatIfGate
      }
    },
    recallShadow: shadow,
    boundaries: [
      'no network, no model call, no paid API, no memory write',
      'estimated/unknown cacheRead is never relabelled measured',
      'Tail Injection is NOT implemented here; an applicable gate only justifies an A/B',
      'positive whenToApply filtering stays default-OFF; this report measures, it does not enable'
    ]
  };

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    // Both --markdown and the default render the same document; the flag exists
    // so a caller can be explicit, not because the output differs.
    console.log(renderMarkdown(report, modules.renderRecallShadowMarkdown));
  }

  // ---- 6. the guard: CI can prove the gate stays CLOSED -------------------
  if (requireGated) {
    if (gate.status !== 'gated-not-applicable') {
      console.error(
        '[rev6-cache] --require-gated FAILED: the gate returned "' + gate.status + '" but measured evidence is required to open it'
      );
      process.exitCode = 1;
      return;
    }
    console.log('[rev6-cache] --require-gated: OK, the optimisation gate is closed (' + gate.status + ').');
  }
}

function safeGitCommit() {
  try {
    // Read-only: the pinned commit for the header, from the git dir on disk.
    const head = readFileSync(path.join(repoRoot, '.git', 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) {
      return head;
    }
    const refPath = path.join(repoRoot, '.git', head.slice('ref: '.length));
    return readFileSync(refPath, 'utf8').trim();
  } catch {
    return 'unknown';
  }
}

function renderMarkdown(report, renderRecallShadowMarkdown) {
  const lines = [];
  lines.push('# rev6 R2-3 / R4：cacheRead 计量与召回 shadow 观测');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('| :-- | :-- |');
  lines.push('| 生成时刻 | ' + report.generatedAt + ' |');
  lines.push('| 固定 commit | `' + report.commit + '` |');
  lines.push('| 数据来源 | `' + report.inputs.artifact + '` |');
  lines.push('| 估算器 | ' + report.inputs.estimator.replace(/\|/g, '\\|') + ' |');
  lines.push('');

  lines.push('## 1. cacheRead 三态计量');
  lines.push('');
  const acc = report.cacheRead.accounting;
  lines.push('| 状态 | calls | cacheRead tokens |');
  lines.push('| :-- | --: | --: |');
  lines.push('| measured | ' + String(acc.measuredCalls) + ' | ' + String(acc.measuredCacheReadTokens) + ' |');
  lines.push('| estimated | ' + String(acc.estimatedCalls) + ' | ' + String(acc.estimatedCacheReadTokens) + ' |');
  lines.push('| unknown | ' + String(acc.unknownCalls) + ' | ' + String(acc.unknownCacheReadTokens) + ' |');
  lines.push('');
  lines.push('- 总样本：' + String(acc.totalSamples) + '；cacheRead 不可用/unknown calls：' + String(acc.cacheReadUnknownCalls));
  lines.push('- paired 样本：' + String(report.cacheRead.pairCount) + '（完整 ' + String(report.cacheRead.completePairs) + '）');
  lines.push('');

  lines.push('## 2. 优化门（Tail Injection 前置）');
  lines.push('');
  const gate = report.cacheRead.gate;
  lines.push('- 结论：**' + gate.status + '**');
  lines.push('- 理由：' + gate.reason.replace(/\|/g, '\\|'));
  if (gate.status === 'applicable') {
    lines.push('- 平均降幅：' + String(gate.meanReduction) + ' tokens；不一致对 ' + String(gate.discordantPairs) + '；sign test p=' + String(gate.signTestP));
    lines.push('- 建议：' + gate.recommendation);
  }
  lines.push('');
  const whatIf = report.cacheRead.whatIfMeasured;
  lines.push('### 2.1 What-if（**非证据**，仅演示门的开启分支）');
  lines.push('');
  lines.push('> ' + whatIf.note);
  lines.push('');
  lines.push('- what-if 门结论：**' + whatIf.gate.status + '**');
  lines.push('- what-if 理由：' + whatIf.gate.reason.replace(/\|/g, '\\|'));
  lines.push('');

  lines.push('## 3. `whenToApply` shadow（R4 前置，**不启用**）');
  lines.push('');
  lines.push(renderRecallShadowMarkdown(report.recallShadow, { generatedAt: report.generatedAt }).split('\n').slice(2).join('\n'));
  lines.push('');

  lines.push('## 4. 边界');
  lines.push('');
  for (const boundary of report.boundaries) {
    lines.push('- ' + boundary);
  }
  return lines.join('\n');
}