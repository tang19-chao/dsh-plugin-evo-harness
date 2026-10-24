#!/usr/bin/env node
/**
 * Real-host smoke runner (P6.1-F).
 *
 * Responsibilities kept OUT of the in-host process so each one is auditable:
 *   - discover the installed DSH executable + asar, or stop with `not-run`;
 *   - pin the commit / worktree facts;
 *   - build the harness bundle (never into the repository);
 *   - run the in-host smoke with a hard deadline and a hang check;
 *   - verify the timeout/unload invariants on the produced result;
 *   - copy the generated markdown to `docs/reports/p61-host-smoke-rc.md`.
 *
 * Every failure mode here degrades to `not-run` with a reason rather than
 * inventing a pass: a missing installation, a missed deadline, a thrown harness
 * or a validation problem all leave the report in place with the failure kept.
 *
 * Usage:
 *   node scripts/host-smoke/run.mjs                # full run (writes the report)
 *   node scripts/host-smoke/run.mjs --check        # harness readiness only
 *   node scripts/host-smoke/run.mjs --no-write     # run, print, do not copy
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const REPORT_PATH = path.join(repoRoot, 'docs', 'reports', 'p61-host-smoke-rc.md');
const BUNDLE_ENTRY = 'tests/e2e/host-smoke/bundle-entry.ts';
const IN_HOST = path.join(__dirname, 'in-host.mjs');
/** Hard deadline for the whole in-host run (harness + backend spawn). */
const RUN_TIMEOUT_MS = 120_000;
/** A run must leave no lingering child process; checked by pid survival below. */
const UNLOAD_GRACE_MS = 2_000;

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? fallback : value;
}

function commandLine(command, args, cwd) {
  return '$ ' + command + ' ' + args.join(' ') + '   # cwd=' + cwd;
}

/** Run one command and capture its stdout (used for the pinned git facts). */
function capture(command, args) {
  try {
    return execFileSync(command, args, { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/**
 * Locate the installed DSH host.
 *
 * Returns `{ ok: true, ... }` or `{ ok: false, reason }`; never a fabricated
 * path, because a smoke against a guessed binary would be worse than not-run.
 */
export function locateDshHost() {
  const fromEnv = process.env.HOSTSMOKE_DSH_HOME;
  const candidates = [];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    candidates.push(fromEnv);
  }
  if (process.env.LOCALAPPDATA !== undefined) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness'));
  }
  for (const installDir of candidates) {
    const executable = path.join(installDir, process.platform === 'win32' ? 'DeepSeek Harness.exe' : 'DeepSeek Harness');
    const asarPath = path.join(installDir, 'resources', 'app.asar');
    if (fs.existsSync(executable) && fs.existsSync(asarPath)) {
      // The installer's `version` file is the ELECTRON version (44.7.0), not the
      // product version. Reporting it as the host version would misattribute the
      // runtime to the host, so the DSH product version is read from the asar's
      // own package.json and the electron version is reported separately.
      const electronVersionFile = path.join(installDir, 'version');
      const electronVersion = fs.existsSync(electronVersionFile)
        ? fs.readFileSync(electronVersionFile, 'utf8').trim()
        : 'unknown';
      let dshVersion = 'unknown';
      try {
        dshVersion = JSON.parse(fs.readFileSync(path.join(asarPath, 'package.json'), 'utf8')).version;
      } catch {
        // Fall back to the dsh runtime package, then to unknown.
        try {
          dshVersion = JSON.parse(fs.readFileSync(path.join(asarPath, 'dsh', 'package.json'), 'utf8')).version;
        } catch {
          dshVersion = 'unknown';
        }
      }
      return {
        ok: true,
        installDir,
        executable,
        asarPath,
        version: dshVersion,
        electronVersion
      };
    }
  }
  return {
    ok: false,
    reason:
      'installed DSH host not found (set HOSTSMOKE_DSH_HOME to the installation directory, or install DeepSeek Harness)'
  };
}

/** Read plugin package facts without importing the plugin. */
function pluginFacts() {
  const packagePath = path.join(repoRoot, 'package.json');
  const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  return { name: parsed.name, version: parsed.version };
}

/** Git facts the report pins. */
function gitFacts() {
  const commit = capture('git', ['rev-parse', 'HEAD']) || 'unknown';
  const status = capture('git', ['status', '--porcelain']);
  return { commit, worktreeDirty: status.length > 0 };
}

/** Build the harness bundle into the OS temp dir. */
async function buildBundle(outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await build({
    entryPoints: [path.join(repoRoot, BUNDLE_ENTRY)],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: outFile,
    logLevel: 'warning',
    sourcemap: false
  });
  return fs.statSync(outFile).size;
}

/**
 * Run the in-host smoke with a hard deadline.
 *
 * The deadline is enforced here rather than inside the harness so a hung host
 * call cannot consume the whole budget: the child is killed and the run is
 * recorded as `not-run: deadline`.
 */
function runInHost(input) {
  return new Promise((resolve) => {
    const child = spawn(input.executable, [input.inHostScript], {
      cwd: input.cwd,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        HOSTSMOKE_BUNDLE: input.bundlePath,
        HOSTSMOKE_ASAR: input.asarPath,
        HOSTSMOKE_OUT_DIR: input.outDir,
        HOSTSMOKE_COMMIT: input.commit,
        HOSTSMOKE_DIRTY: input.worktreeDirty ? '1' : '0',
        HOSTSMOKE_EXECUTABLE: input.executable,
        HOSTSMOKE_INSTALL_DIR: input.installDir,
        HOSTSMOKE_HOST_VERSION: input.hostVersion,
        HOSTSMOKE_ELECTRON_VERSION: input.electronVersion,
        HOSTSMOKE_PLUGIN_VERSION: input.pluginVersion,
        HOSTSMOKE_BUNDLE_ENTRY: BUNDLE_ENTRY,
        HOSTSMOKE_RUN_ID: input.runId,
        HOSTSMOKE_CANARY: input.canary,
        HOSTSMOKE_MCP_SERVER: input.mcpServer,
        HOSTSMOKE_MCP_CWD: input.cwd,
        HOSTSMOKE_PRODUCT: 'DeepSeek Harness',
        HOSTSMOKE_COMMANDS: input.commands.join('\n'),
        HOSTSMOKE_AUTHORIZED: process.env.HOSTSMOKE_AUTHORIZED ?? '0'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, input.timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, pid: child.pid });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, signal: null, stdout, stderr: stderr + String(error.message), timedOut: false, pid: child.pid });
    });
  });
}

/** True when a pid is still alive (the child must not outlive the run). */
function pidAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read the in-host result file, if the run produced one. */
function readResult(outDir) {
  const resultPath = path.join(outDir, 'result.json');
  if (!fs.existsSync(resultPath)) {
    return { result: null, problem: 'in-host run produced no result.json' };
  }
  try {
    return { result: JSON.parse(fs.readFileSync(resultPath, 'utf8')), problem: null };
  } catch (error) {
    return { result: null, problem: 'result.json is not valid JSON: ' + String(error.message) };
  }
}

/**
 * Timeout/unload invariants the runner checks on the produced result.
 *
 * Kept in the runner (not the harness) because they are properties of the
 * process boundary: the child must have exited, no pid may survive, and the
 * harness must have reported dispose with zero residue.
 */
export function checkTimeoutAndUnload(result, spawnOutcome) {
  const problems = [];
  if (spawnOutcome.timedOut) {
    problems.push('in-host run exceeded the ' + String(RUN_TIMEOUT_MS) + 'ms deadline and was killed');
  }
  if (spawnOutcome.code !== 0) {
    problems.push('in-host run exited with code ' + String(spawnOutcome.code) + (spawnOutcome.signal ? ' (signal ' + String(spawnOutcome.signal) + ')' : ''));
  }
  if (result !== null && result.probe !== null && typeof result.probe === 'object') {
    const lifecycle = result.probe.lifecycle;
    if (lifecycle !== undefined) {
      if (lifecycle.listenersAfterDispose !== 0) {
        problems.push('dispose left ' + String(lifecycle.listenersAfterDispose) + ' hook listener(s) installed');
      }
      if (lifecycle.mountsAfterDispose !== 0) {
        problems.push('dispose left ' + String(lifecycle.mountsAfterDispose) + ' surface mount(s) active');
      }
      if (lifecycle.observationsDeltaAfterDispose !== 0) {
        problems.push('an observation still reached the collector after dispose (delta ' + String(lifecycle.observationsDeltaAfterDispose) + ')');
      }
      if (lifecycle.abortSettled !== true) {
        problems.push('the aborted tool call never settled');
      }
    }
  }
  return problems;
}

/**
 * Harness readiness check (`--check`): everything that can be verified without
 * executing a real host call. Fails loudly on a missing piece so the harness
 * cannot silently regress to "not ready".
 */
export function checkHarnessReadiness() {
  const problems = [];
  const required = [
    BUNDLE_ENTRY,
    'tests/e2e/host-smoke/manifest.ts',
    'tests/e2e/host-smoke/samples.ts',
    'tests/e2e/host-smoke/report-template.ts',
    'tests/e2e/host-smoke/probe.ts',
    'tests/e2e/host-smoke/degradation.ts',
    'tests/e2e/host-smoke/mcp-client.ts',
    'tests/e2e/host-smoke/mcp-smoke.ts',
    'tests/e2e/host-smoke/mcp-backend-server.mjs',
    'scripts/host-smoke/in-host.mjs',
    'scripts/host-smoke/run.mjs'
  ];
  for (const relative of required) {
    if (!fs.existsSync(path.join(repoRoot, relative))) {
      problems.push('missing harness file ' + relative);
    }
  }
  const host = locateDshHost();
  if (!host.ok) {
    problems.push(host.reason);
  }
  return { problems, host };
}

async function main() {
  const args = process.argv.slice(2);
  const readinessOnly = args.includes('--check');
  const writeReport = !args.includes('--no-write');

  if (readinessOnly) {
    const readiness = checkHarnessReadiness();
    for (const problem of readiness.problems) {
      console.log('[host-smoke] readiness: ' + problem);
    }
    console.log('[host-smoke] readiness ok=' + String(readiness.problems.length === 0));
    if (readiness.problems.length > 0) {
      process.exitCode = 1;
    }
    return;
  }

  const host = locateDshHost();
  const plugin = pluginFacts();
  const git = gitFacts();
  const runId = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const outDir = path.join(os.tmpdir(), 'dsh-evo-p61-host-smoke', 'run-' + runId);
  const bundlePath = path.join(outDir, 'harness.cjs');
  const mcpServer = path.join(repoRoot, 'tests', 'e2e', 'host-smoke', 'mcp-backend-server.mjs');
  const canary = 'HOSTSMOKE-CANARY-' + runId;
  const commands = [];

  if (!host.ok) {
    // No installation: keep the run honest. A report is still produced (with
    // every real-host row `not-run`) so the gap is visible rather than absent.
    console.log('[host-smoke] ' + host.reason);
    if (writeReport) {
      writeNotRunReport({ plugin, git, reason: host.reason, runId });
    }
    process.exitCode = 0;
    return;
  }

  commands.push(commandLine('node scripts/host-smoke/run.mjs', [], repoRoot));
  commands.push(commandLine('pnpm run typecheck', [], repoRoot));
  commands.push(commandLine('git rev-parse HEAD', [], repoRoot));

  const bundleBytes = await buildBundle(bundlePath);
  console.log('[host-smoke] bundle ready (' + String(bundleBytes) + ' bytes)');

  const spawnOutcome = await runInHost({
    executable: host.executable,
    inHostScript: IN_HOST,
    cwd: repoRoot,
    env: process.env,
    asarPath: host.asarPath,
    installDir: host.installDir,
    hostVersion: host.version,
    electronVersion: host.electronVersion,
    bundlePath,
    outDir,
    commit: git.commit,
    worktreeDirty: git.worktreeDirty,
    pluginVersion: plugin.version,
    runId,
    canary,
    mcpServer,
    commands,
    timeoutMs: RUN_TIMEOUT_MS
  });

  // Unload check: give the OS a moment, then confirm the child is gone.
  await new Promise((resolve) => setTimeout(resolve, UNLOAD_GRACE_MS));
  const childSurvived = pidAlive(spawnOutcome.pid ?? 0);
  if (spawnOutcome.stdout.trim().length > 0) {
    console.log(spawnOutcome.stdout.trim());
  }
  if (spawnOutcome.stderr.trim().length > 0) {
    console.error(spawnOutcome.stderr.trim());
  }

  const { result, problem } = readResult(outDir);
  const boundaryProblems = checkTimeoutAndUnload(result, spawnOutcome);
  if (childSurvived) {
    boundaryProblems.push('in-host process ' + String(spawnOutcome.pid) + ' was still alive after the run');
  }
  if (result !== null && result.notes !== undefined) {
    for (const note of result.notes) {
      console.log('[host-smoke] ' + note);
    }
  }
  for (const boundaryProblem of boundaryProblems) {
    console.log('[host-smoke] boundary: ' + boundaryProblem);
  }

  if (result === null) {
    if (writeReport) {
      writeNotRunReport({
        plugin,
        git,
        reason: (problem ?? 'in-host run produced no result') + (boundaryProblems.length > 0 ? '; ' + boundaryProblems.join('; ') : ''),
        runId,
        host
      });
    }
    process.exitCode = 1;
    return;
  }

  // Append the boundary checks as an extra report section so a runner-level
  // failure can never be hidden by a clean in-host report.
  const boundarySection = [
    '',
    '---',
    '',
    '## 附录：运行边界检查（runner 侧）',
    '',
    '| 检查 | 结果 |',
    '| :-- | :-- |',
    '| 子进程退出码 | ' + String(spawnOutcome.code) + ' |',
    '| 是否超时（' + String(RUN_TIMEOUT_MS) + 'ms） | ' + (spawnOutcome.timedOut ? '**超时**' : '否') + ' |',
    '| 卸载后是否有存活子进程 | ' + (childSurvived ? '**有**' : '无') + ' |',
    '| manifest 校验问题 | ' + (result.manifestProblems.length === 0 ? '无' : result.manifestProblems.join('；')) + ' |',
    '| 报告行校验问题 | ' + (result.rowProblems.length === 0 ? '无' : result.rowProblems.join('；')) + ' |',
    ''
  ];
  const boundaryProblemsText = boundaryProblems.length === 0
    ? ['（无）']
    : boundaryProblems.map((entry) => '- ' + entry);
  boundarySection.push('边界问题清单：');
  boundarySection.push(...boundaryProblemsText);
  boundarySection.push('');

  const markdown = result.reportMarkdown + boundarySection.join('\n');
  if (writeReport) {
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, markdown, 'utf8');
    console.log('[host-smoke] report written to ' + path.relative(repoRoot, REPORT_PATH));
  }

  const failedRows = result.rows.filter((row) => row.state === 'failed').length;
  const notRunRows = result.rows.filter((row) => row.state === 'not-run').length;
  console.log(
    '[host-smoke] rows: passed=' +
      String(result.rows.length - failedRows - notRunRows) +
      ' failed=' +
      String(failedRows) +
      ' not-run=' +
      String(notRunRows)
  );
  console.log('[host-smoke] result.json=' + path.join(outDir, 'result.json'));
  // Exit 0 when the harness ran and the report was written, even with failed
  // rows: a failure is a legitimate, preserved result. Exit 1 only when the
  // harness itself could not run (handled above) or a boundary check broke.
  process.exitCode = boundaryProblems.length === 0 ? 0 : 1;
}

/** Write a `not-run` report when the host run could not happen at all. */
function writeNotRunReport(input) {
  const hostLines = input.host === undefined ? ['installed DSH host: not found'] : [input.host.version + ' @ ' + input.host.installDir];
  const reason = input.reason.replace(/\|/g, '\\|');
  const rows = [
    { id: '9.0-1', label: '工程可运行：harness 就绪', layer: 'engineering-runnable' },
    { id: '9.2-1', label: '两会话两分支 domain/invariant/普通工具', layer: 'security-contract' },
    { id: '9.2-2', label: '每个 hook 的身份字段 + sibling probe 隔离', layer: 'real-host-compatibility' },
    { id: '9.2-3', label: 'off→on/执行中 off/abort/timeout/dispose', layer: 'engineering-runnable' },
    { id: '9.2-4', label: '原宿主 deny/cancel 优先', layer: 'security-contract' },
    { id: '9.2-5', label: '身份缺失按 D1 透传不学习', layer: 'security-contract' },
    { id: '9.2-6', label: '命名空间隔离边界（非 OS 沙箱）', layer: 'security-contract' },
    { id: '9.3-1', label: '单 MCP 后端 smoke', layer: 'real-host-compatibility' },
    { id: '9.4-1', label: '受控发布边界', layer: 'security-contract' },
    { id: '9.4-2', label: '真实模型调用/真实 memory 写入', layer: 'task-benefit' },
    { id: '9.4-3', label: 'shadow RC 任务收益', layer: 'task-benefit' },
    { id: '9.5-1', label: '学习语义（shadow≠jit off）', layer: 'learning-semantics' }
  ];
  const lines = [
    '# P6.1-F 真实宿主受控 smoke 与 shadow RC 报告',
    '',
    '| 项 | 值 |',
    '| :-- | :-- |',
    '| 固定 commit | `' + input.git.commit + '`' + (input.git.worktreeDirty ? '（工作树有未提交改动）' : '') + ' |',
    '| 插件版本 | `' + input.plugin.version + '` |',
    '| 采集时间 | ' + new Date().toISOString() + ' |',
    '| 宿主 | ' + hostLines.map((line) => line.replace(/\|/g, '\\|')).join(' / ') + ' |',
    '| 本轮结论 | **not-run**：' + reason + ' |',
    '',
    '## 分层结论',
    '',
    '本轮未执行真实宿主 smoke，因此所有层均为 not-run。这不是通过，也不是失败；是缺条件。',
    '',
    '| 层 | passed | failed | not-run |',
    '| :-- | --: | --: | --: |' +
      ['engineering-runnable', 'security-contract', 'learning-semantics', 'real-host-compatibility', 'task-benefit']
        .map((layer) => {
          const count = rows.filter((row) => row.layer === layer).length;
          return '\n| `' + layer + '` | 0 | 0 | ' + String(count) + ' |';
        })
        .join(''),
    '',
    '## 条目',
    '',
    '| id | 条目 | 状态 | 原因 |',
    '| :-- | :-- | :-- | :-- |',
    ...rows.map((row) => '| `' + row.id + '` | ' + row.label + ' | **not-run** | ' + reason + ' |'),
    '',
    '## 如何变成可执行',
    '',
    '1. 安装 DeepSeek Harness（或设置 `HOSTSMOKE_DSH_HOME` 指向安装目录）；',
    '2. `node scripts/host-smoke/run.mjs --check` 应报告 `readiness ok=true`；',
    '3. `node scripts/host-smoke/run.mjs` 生成真实报告；真实模型调用/真实 memory 写入需额外显式授权。',
    ''
  ];
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, lines.join('\n'), 'utf8');
  console.log('[host-smoke] not-run report written to ' + path.relative(repoRoot, REPORT_PATH));
}

await main();
