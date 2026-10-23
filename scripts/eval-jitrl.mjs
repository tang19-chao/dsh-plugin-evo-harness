#!/usr/bin/env node
/**
 * JitRL ablation/evaluation CLI (plan section 9, P5-c).
 *
 * Runs the protocol in scripts/eval/jitrl-eval-lib.ts and prints either the JSON
 * report or a human-readable summary; with --report it regenerates the committed
 * markdown report from the numbers it just measured.
 *
 * TypeScript loading (P6 PR1, plan section 4 R7): the lib is TypeScript and
 * reaches non-erasable syntax (`src/dsh-bridge/branch.ts` uses a parameter
 * property), which Node's strip-only mode rejects with
 * ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. The lib is therefore precompiled once with
 * the repository's esbuild into a content-addressed cache under
 * node_modules/.cache and imported from there (see scripts/eval/build-eval.mjs).
 * No `--experimental-*` flag is ever required: the documented command above
 * works as written.
 *
 * Exit codes (a regression must be visible in CI):
 *   0  protocol completed and every gate passed
 *   1  a gate failed (leak, Avg below --min-avg, or Final < Avg when asked)
 *   2  the protocol itself threw (including a failure to build the lib)
 *
 * Usage: node scripts/eval-jitrl.mjs [options]
 *   --json                     print the JSON report only
 *   --report <path>            write the markdown report to <path>
 *   --baseline <path>          run the documented command in a child process and
 *                              write the fixed-commit baseline report to <path>
 *   --episodes <n>             episode length L (default 5)
 *   --conditions <ids>         comma-separated subset, e.g. B0,B1,B2,B3
 *   --tasks <ids>              comma-separated subset of task ids
 *   --min-avg <n>              fail when any condition's Avg is below n (default 0)
 *   --expect-final-improvement fail when a baseline's Final < Avg
 *   --quiet                    do not print the human-readable summary
 */

import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// `loadEvalLib` builds the artifact only when the source fingerprint changed,
// then imports the compiled ES module. Everything the CLI does below is
// identical to the previous direct-import version.
const { loadEvalLib } = await import('./eval/build-eval.mjs');
const { runEval, renderMarkdown, CONDITIONS, DEFAULT_CANARY, fixed } = await loadEvalLib();

// ---------------------------------------------------------------------------
// argument parsing
// ---------------------------------------------------------------------------

/**
 * Split a list argument. Commas are the documented separator, but `pnpm run
 * eval:jitrl -- --conditions B0,B3` reaches the script as "B0 B3" (pnpm
 * re-splits the passthrough), so whitespace is accepted as well.
 */
function splitList(value) {
  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function readArgs(argv) {
  const options = {
    json: false,
    quiet: false,
    episodes: 5,
    conditions: undefined,
    tasks: undefined,
    report: undefined,
    baseline: undefined,
    minAvg: 0,
    expectFinalImprovement: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('missing value for ' + String(arg));
      }
      index += 1;
      return value;
    };
    switch (arg) {
      case '--json':
        options.json = true;
        break;
      case '--quiet':
        options.quiet = true;
        break;
      case '--expect-final-improvement':
        options.expectFinalImprovement = true;
        break;
      case '--episodes':
        options.episodes = Number.parseInt(next(), 10);
        break;
      case '--conditions':
        options.conditions = splitList(next());
        break;
      case '--tasks':
        options.tasks = splitList(next());
        break;
      case '--min-avg':
        options.minAvg = Number.parseFloat(next());
        break;
      case '--report':
        options.report = next();
        break;
      case '--baseline':
        options.baseline = next();
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error('unknown argument: ' + String(arg));
    }
  }
  if (!Number.isInteger(options.episodes) || options.episodes < 1) {
    throw new Error('--episodes must be a positive integer');
  }
  if (!Number.isFinite(options.minAvg)) {
    throw new Error('--min-avg must be a number');
  }
  return options;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function fail(message) {
  console.error('eval:jitrl FAILED: ' + message);
  process.exitCode = 1;
}

function printSummary(report) {
  const rows = report.metrics;
  const header = ['condition', 'levels', 'k', 'beta', 'Avg', 'Final', 'Final-Avg', 'solved', 'KL mean', 'KL p95'];
  console.log('protocol: L=' + String(report.protocol.episodes) + ', tasks=' + String(report.protocol.taskCount) + ', families=' + report.protocol.families.join(','));
  console.log('seed: ' + report.protocol.seed);
  console.log('');
  console.log(header.join(' | '));
  for (const row of rows) {
    console.log(
      [
        row.id,
        row.config.levels.join('+') || '-',
        String(row.config.k),
        String(row.config.beta),
        fixed(row.avg),
        fixed(row.final),
        (row.finalMinusAvg > 0 ? '+' : '') + fixed(row.finalMinusAvg),
        fixed(row.solvedRate),
        fixed(row.health.klMean),
        fixed(row.health.klP95)
      ].join(' | ')
    );
  }
  console.log('');
  const leaks = rows.reduce((total, row) => total + row.safety.invariantLeaks + row.safety.invariantMemoryLeaks + row.safety.canaryLeaks, 0);
  console.log('safety: invariant leaks=' + String(leaks) + ' (must be 0)');
  console.log('timing: total ' + String(report.timing.totalMs) + 'ms');
  for (const [id, ms] of Object.entries(report.timing.perConditionMs)) {
    console.log('  ' + id + ': ' + String(ms) + 'ms');
  }
  console.log('');
  console.log('unimplemented ablations: ' + report.unimplemented.map((entry) => entry.id).join(', '));
}

function currentCommit() {
  const cwd = process.cwd();
  try {
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' })
      .split('\n')
      .some((line) => line.trim().length > 0);
    return head + (dirty ? '+dirty' : '');
  } catch {
    return 'unknown';
  }
}

function localTimestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return (
    String(now.getFullYear()) +
    '-' + pad(now.getMonth() + 1) +
    '-' + pad(now.getDate()) +
    ' ' + pad(now.getHours()) +
    ':' + pad(now.getMinutes()) +
    ':' + pad(now.getSeconds()) +
    ' (UTC' + (now.getTimezoneOffset() <= 0 ? '+' : '-') + pad(Math.abs(now.getTimezoneOffset()) / 60) + ')'
  );
}

// ---------------------------------------------------------------------------
// fixed-commit baseline report (--baseline <path>)
// ---------------------------------------------------------------------------
//
// The baseline must come from the documented command, not from this process:
// importing runEval() here would certify "the library works", which is exactly
// what the ablation e2e suite already does. So --baseline re-spawns
// `node scripts/eval-jitrl.mjs --json` as a child process (no extra flags) and
// renders the report from the JSON that command prints. The gates below are
// computed from those measured numbers, never asserted by hand.

const SELF_PATH = fileURLToPath(import.meta.url);

/** The user-facing command whose behaviour the baseline certifies. */
const DOCUMENTED_COMMAND = 'node scripts/eval-jitrl.mjs --json';

/** Run the documented command as a child process and collect its exit status. */
function runDocumentedCommand(cwd) {
  const script = SELF_PATH.split(sep).join('/');
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [script, '--json'],
      { cwd, timeout: 300_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        resolvePromise({
          exitCode: error === null ? 0 : typeof error.code === 'number' ? error.code : -1,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : ''
        });
      }
    );
  });
}

/**
 * Commit under test, dirty marker, and whether `src/**` itself is modified.
 *
 * The shared tree may carry other PRs' uncommitted plugin changes, so the
 * report must measure this rather than assume it: claiming "src/** unchanged"
 * on faith would turn a dirty measurement into a fake certification.
 */
function gitIdentity(cwd) {
  try {
    const full = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    const short = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    const changed = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.includes('.agent-teams/'));
    // Porcelain v1: "XY <path>"; a rename is reported as "old -> new".
    const paths = changed.map((line) => line.slice(3).split(' -> ').pop() ?? line.slice(3));
    const srcChanged = paths.some((path) => path === 'src' || path.startsWith('src/'));
    return { full, short, changed, paths, srcChanged, dirty: changed.length > 0 };
  } catch (error) {
    return {
      full: 'unknown',
      short: 'unknown',
      changed: [],
      paths: [],
      srcChanged: false,
      dirty: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/** Baseline gates, all computed from the measured report. */
function baselineGates(report, exitCode) {
  const metrics = Array.isArray(report?.metrics) ? report.metrics : [];
  const ids = metrics.map((row) => row.id);
  const baselines = ['B0', 'B1', 'B2', 'B3']
    .map((id) => metrics.find((row) => row.id === id))
    .filter((row) => row !== undefined);
  const leaks = metrics.reduce(
    (total, row) =>
      total +
      (row.safety?.invariantLeaks ?? 0) +
      (row.safety?.invariantMemoryLeaks ?? 0) +
      (row.safety?.invariantGuidanceLeaks ?? 0) +
      (row.safety?.canaryLeaks ?? 0),
    0
  );
  const b0 = metrics.find((row) => row.id === 'B0');
  const belowFloor =
    b0 === undefined
      ? []
      : baselines.filter((row) => row.id !== 'B0' && row.avg < b0.avg - 1e-9).map((row) => row.id);
  const gates = [
    {
      id: 'G0.1',
      name: '默认命令退出码为 0',
      detail: '`' + DOCUMENTED_COMMAND + '` 以退出码 ' + String(exitCode) + ' 结束',
      passed: exitCode === 0
    },
    {
      id: 'G0.2',
      name: '输出为可解析 JSON 且含 protocol/metrics',
      detail: 'protocol.episodes=' + String(report?.protocol?.episodes) + '；metrics=' + String(metrics.length) + ' 条',
      passed: report?.protocol !== undefined && metrics.length > 0
    },
    {
      id: 'G0.3',
      name: 'B0–B3 四组基线齐全',
      detail:
        baselines.length === 4
          ? 'B0–B3 全部出现'
          : '缺失：' + ['B0', 'B1', 'B2', 'B3'].filter((id) => !ids.includes(id)).join(', '),
      passed: baselines.length === 4
    },
    {
      id: 'G0.4',
      name: '三类 invariant 泄漏与 canary 泄漏合计为 0',
      detail: '合计 ' + String(leaks) + ' 次泄漏（' + String(metrics.length) + ' 个条件）',
      passed: leaks === 0
    },
    {
      id: 'G0.5',
      name: 'B0 是静态下界（其余基线 Avg 不低于 B0）',
      detail: belowFloor.length === 0 ? 'B1/B2/B3 均不低于 B0' : '低于 B0 的条件：' + belowFloor.join(', '),
      passed: belowFloor.length === 0
    },
    {
      id: 'G0.6',
      name: '协议声明确定性',
      detail: String(report?.protocol?.deterministic) + '；seed ' + String(report?.protocol?.seed),
      passed: report?.protocol?.deterministic === true
    }
  ];
  return { gates, metrics, leaks, baselines };
}

/** Render the committed baseline markdown from the measured run. */
function renderBaseline({ git, generatedAt, nodeVersion, exitCode, report, evaluation }) {
  const { gates, metrics, leaks, baselines } = evaluation;
  const lines = [];
  const fixed3 = (value, digits = 3) => (Number.isFinite(value) ? value.toFixed(digits) : '0');
  const signed3 = (value, digits = 3) => (value > 0 ? '+' : '') + fixed3(value, digits);

  lines.push('# P6 固定基线报告（R7 / PR1）');
  lines.push('');
  lines.push('> 本文件由 `node scripts/eval-jitrl.mjs --baseline docs/reports/p6-eval-baseline.md` 生成。' +
    '数字来自 `' + DOCUMENTED_COMMAND + '` 的一次真实子进程执行，**没有**使用 `--experimental-transform-types` 等诊断参数，' +
    '也不是手写估值。');
  lines.push('');
  lines.push('## 1. 基本身份');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('| :-- | :-- |');
  lines.push('| 代码版本 | `' + git.full + '`（short `' + git.short + '`） |');
  lines.push('| 工作树状态 | ' + (git.dirty
    ? '**dirty**：基线是在未提交的工作树上测得的，改动清单见 §1.1' +
      (git.srcChanged
        ? '；其中包含 `src/**` 的未提交改动，此时基线描述的是**工作树中的插件**，不是 `' + git.short + '` 的已提交行为'
        : '')
    : 'clean（工作树与 commit 一致）') + ' |');
  lines.push('| 生成时间（本地） | ' + generatedAt + ' |');
  lines.push('| Node | `' + nodeVersion + '` |');
  lines.push('| 命令 | `' + DOCUMENTED_COMMAND + '` |');
  lines.push('| 退出码 | `' + String(exitCode) + '` |');
  lines.push('| 协议 | 每任务连续 L=' + String(report?.protocol?.episodes) + ' 次；报告 Avg（L 次均值）、Final（第 L 次）、Final−Avg |');
  lines.push('| 任务集 | ' + String(report?.protocol?.taskCount) + ' 个离线合成任务；家族：' +
    (Array.isArray(report?.protocol?.families) ? report.protocol.families.join(', ') : 'unknown') + ' |');
  lines.push('| 随机性 | ' + String(report?.protocol?.seed) + ' |');
  lines.push('| 总耗时（协议） | ' + String(report?.timing?.totalMs) + ' ms |');
  lines.push('');
  lines.push('### 1.1 工作树改动清单（基线对应的未提交改动）');
  lines.push('');
  if (git.changed.length === 0) {
    lines.push('无。');
  } else {
    lines.push('```text');
    for (const line of git.changed) {
      lines.push(line);
    }
    lines.push('```');
    lines.push('');
    if (git.srcChanged) {
      lines.push('**注意**：清单中包含 `src/**` 的未提交改动（本 PR1 未修改 `src/**`；这些是同一共享工作树上其他并行 PR 的改动）。' +
        '因此本报告证明的是「默认评测命令在当前工作树上可直接运行并退出 0」，其指标块描述的是**当前工作树中的插件**，' +
        '不能直接标注为 `' + git.short + '` 的已提交行为。');
    } else {
      lines.push('这些改动只涉及评测入口、构建缓存、CI、smoke 测试与本报告；`src/**` 未改动，因此指标块可与 `' +
        git.short + '` 的插件行为直接对齐。');
    }
  }
  lines.push('');
  lines.push('## 2. 门禁结果');
  lines.push('');
  lines.push('| 门禁 | 检查项 | 结果 | 证据 |');
  lines.push('| :-- | :-- | :-- | :-- |');
  for (const gate of gates) {
    lines.push('| ' + gate.id + ' | ' + gate.name + ' | ' + (gate.passed ? 'PASS' : 'FAIL') + ' | ' + gate.detail + ' |');
  }
  lines.push('');
  const failed = gates.filter((gate) => !gate.passed).map((gate) => gate.id);
  lines.push(failed.length === 0
    ? '全部门禁通过。'
    : '**未通过的门禁：' + failed.join(', ') + '**；本基线不能作为通过证据。');
  lines.push('');
  lines.push('## 3. 基线指标 B0–B3');
  lines.push('');
  lines.push('| 组 | 配置 | Avg | Final | Final−Avg | 解出率 | oracle 比 | probes/任务 | KL 均值 | KL p95 | 近邻命中率 |');
  lines.push('| :-- | :-- | --: | --: | --: | --: | --: | --: | --: | --: | --: |');
  for (const row of baselines) {
    lines.push(
      '| ' + row.id + ' | ' + (row.config?.levels?.length ? row.config.levels.join('+') : '-') + ' | ' +
      fixed3(row.avg) + ' | ' + fixed3(row.final) + ' | ' + signed3(row.finalMinusAvg) + ' | ' +
      fixed3(row.solvedRate) + ' | ' + fixed3(row.oracleRatio) + ' | ' +
      fixed3(row.probesPerTask, 2) + ' | ' + fixed3(row.health?.klMean) + ' | ' + fixed3(row.health?.klP95) + ' | ' +
      fixed3(row.health?.neighborHitRate) + ' |'
    );
  }
  lines.push('');
  lines.push('`Avg`/`Final` 是覆盖率（命中的必需表面 / 必需表面总数）在 12 个任务上的均值；`解出率` 是完全解出的 run 占比；' +
    '`oracle 比` 是实测覆盖率与该任务表内最优覆盖率之比。');
  lines.push('');
  lines.push('## 4. 安全指标');
  lines.push('');
  lines.push('| 组 | invariant 泄漏 | invariant 记忆泄漏 | invariant guidance 违约 | canary 泄漏 | invariant 提案数 |');
  lines.push('| :-- | --: | --: | --: | --: | --: |');
  for (const row of metrics) {
    lines.push(
      '| ' + row.id + ' | ' + String(row.safety?.invariantLeaks ?? '?') + ' | ' +
      String(row.safety?.invariantMemoryLeaks ?? '?') + ' | ' + String(row.safety?.invariantGuidanceLeaks ?? '?') + ' | ' +
      String(row.safety?.canaryLeaks ?? '?') + ' | ' + String(row.safety?.invariantProbes ?? '?') + ' |'
    );
  }
  lines.push('');
  lines.push('三类 invariant 泄漏与 canary 泄漏合计 **' + String(leaks) + '**（必须为 0）。');
  lines.push('');
  lines.push('## 5. 如何复核本基线');
  lines.push('');
  lines.push('```bash');
  lines.push('# 1) 用户文档中的原命令（不得附加任何 --experimental-* 参数）');
  lines.push(DOCUMENTED_COMMAND);
  lines.push('');
  lines.push('# 2) 通过 pnpm 脚本执行同一入口');
  lines.push('pnpm run eval:jitrl -- --json');
  lines.push('');
  lines.push('# 3) 重新生成本报告（会重新执行上面的命令）');
  lines.push('pnpm run eval:jitrl:baseline');
  lines.push('');
  lines.push('# 4) 子进程 smoke（CI 门禁）');
  lines.push('pnpm exec vitest run tests/e2e/eval-cli.smoke.test.ts');
  lines.push('```');
  lines.push('');
  lines.push('CLI 通过 esbuild 预编译评测库到 `node_modules/.cache/dsh-plugin-evo-harness/` 后导入产物，' +
    '因此不再依赖 Node 原生 TS strip 对 parameter property 的支持，也不需要隐藏 flag。');
  lines.push('');
  lines.push('## 6. 这份基线能证明什么、不能证明什么');
  lines.push('');
  lines.push('- **能证明**：`' + DOCUMENTED_COMMAND + '` 在 Node `' + nodeVersion + '` 上可直接运行并退出 0，输出可机读；' +
    'B0–B3 与安全门禁位于上述数值。' +
    (git.srcChanged
      ? '代码版本为 `' + git.short + '` 加上 §1.1 中的工作树改动，因此上述指标描述的是**该工作树中的插件**。'
      : '代码版本为 `' + git.short + '`（工作树 clean），因此上述指标即为该 commit 的行为。'));
  lines.push('- **不能证明**：真实模型、真实 DSH 宿主或真实 MCP 后端上的效果；合成任务集的收益不能外推为生产收益。');
  lines.push('- **不能替代**：`tests/e2e/jitrl-ablation.test.ts`（协议不变量）与后续 Gate 1–4 的验收证据。');
  if (git.srcChanged) {
    lines.push('- **重跑时机**：当 §1.1 中的 `src/**` 改动全部提交、工作树只剩本 PR1 的评测入口改动时，重跑即可把基线对齐到一个确定的 commit。');
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * `--baseline <path>`: certify the documented command and write the report.
 * Returns the process exit code contribution (0 pass, 1 gate failure, 2 throw).
 */
async function writeBaselineReport(target, cwd) {
  const result = await runDocumentedCommand(cwd);
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    console.error(
      'eval:jitrl BASELINE FAILED: stdout of `' + DOCUMENTED_COMMAND + '` is not valid JSON: ' +
      (error instanceof Error ? error.message : String(error))
    );
    console.error('exit code: ' + String(result.exitCode));
    console.error('stderr: ' + result.stderr.slice(0, 4_000));
    return 2;
  }
  const evaluation = baselineGates(report, result.exitCode);
  const markdown = renderBaseline({
    git: gitIdentity(cwd),
    // localTimestamp() already carries the UTC offset, so no extra timezone.
    generatedAt: localTimestamp(),
    nodeVersion: process.version,
    exitCode: result.exitCode,
    report,
    evaluation
  });
  const absolute = resolve(cwd, target);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, markdown, 'utf8');
  console.log('baseline written to ' + absolute);
  console.log('command: ' + DOCUMENTED_COMMAND + ' (exit ' + String(result.exitCode) + ')');
  const failed = evaluation.gates.filter((gate) => !gate.passed);
  console.log('gates: ' + evaluation.gates.map((gate) => gate.id + '=' + (gate.passed ? 'PASS' : 'FAIL')).join(' '));
  if (failed.length > 0) {
    console.error('eval:jitrl BASELINE FAILED: ' + failed.map((gate) => gate.id + ' ' + gate.name).join('; '));
    return 1;
  }
  return 0;
}

async function main() {
  const options = readArgs(process.argv.slice(2));
  if (options.help === true) {
    console.log('usage: node scripts/eval-jitrl.mjs [--json] [--report <path>] [--baseline <path>] [--episodes <n>] [--conditions <ids>] [--tasks <ids>] [--min-avg <n>] [--expect-final-improvement] [--quiet]');
    console.log('conditions: ' + CONDITIONS.map((entry) => entry.id).join(', '));
    return;
  }
  // `--baseline` measures the documented command in a child process, so it must
  // not also run the protocol in this process (that would double the cost and
  // make the certified numbers come from the wrong entry point).
  if (options.baseline !== undefined) {
    process.exitCode = await writeBaselineReport(options.baseline, process.cwd());
    return;
  }
  const known = new Set(CONDITIONS.map((entry) => entry.id));
  if (options.conditions !== undefined) {
    const unknown = options.conditions.filter((entry) => !known.has(entry));
    if (unknown.length > 0) {
      throw new Error('unknown condition(s): ' + unknown.join(', ') + '; known: ' + [...known].join(', '));
    }
  }

  const report = await runEval({
    ...(options.episodes === 5 ? {} : { episodes: options.episodes }),
    ...(options.conditions === undefined ? {} : { conditions: options.conditions }),
    canary: DEFAULT_CANARY
  });

  if (options.json === true) {
    console.log(JSON.stringify(report, null, 2));
  } else if (options.quiet !== true) {
    printSummary(report);
  }

  if (options.report !== undefined) {
    const command = 'node scripts/eval-jitrl.mjs --report ' + options.report;
    const markdown = renderMarkdown(report, {
      commit: currentCommit(),
      generatedAt: localTimestamp(),
      command
    });
    const target = resolve(process.cwd(), options.report);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, markdown, 'utf8');
    if (options.quiet !== true) {
      console.log('');
      console.log('markdown report written to ' + target);
    }
  }

  // -------------------------------------------------------------------------
  // gates
  // -------------------------------------------------------------------------
  let failed = false;
  for (const row of report.metrics) {
    const leaks =
      row.safety.invariantLeaks +
      row.safety.invariantMemoryLeaks +
      row.safety.invariantGuidanceLeaks +
      row.safety.canaryLeaks;
    if (leaks > 0) {
      fail(
        'condition ' + row.id + ' reported ' + String(leaks) + ' safety leak(s): ' +
        JSON.stringify(row.safety)
      );
      failed = true;
    }
    if (row.avg < options.minAvg) {
      fail('condition ' + row.id + ' Avg ' + fixed(row.avg) + ' is below --min-avg ' + String(options.minAvg));
      failed = true;
    }
    if (options.expectFinalImprovement && row.group === 'baseline' && row.final < row.avg) {
      fail('condition ' + row.id + ' Final ' + fixed(row.final) + ' < Avg ' + fixed(row.avg));
      failed = true;
    }
  }
  // The very first sanity gate: the harness must actually measure something.
  const measured = report.metrics.filter((row) => row.group === 'baseline');
  if (measured.length === 0) {
    fail('no baseline condition ran; the report would be empty');
    failed = true;
  }
  // B0 must be a floor: a static agent with no harness cannot beat every arm.
  const b0 = report.metrics.find((row) => row.id === 'B0');
  if (b0 !== undefined) {
    for (const row of measured) {
      if (row.id !== 'B0' && row.avg < b0.avg - 1e-9) {
        fail('regression: ' + row.id + ' Avg ' + fixed(row.avg) + ' is below the static floor B0 ' + fixed(b0.avg));
        failed = true;
      }
    }
  }
  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('eval:jitrl ERROR: ' + (error instanceof Error ? error.stack ?? error.message : String(error)));
  process.exitCode = 2;
});
