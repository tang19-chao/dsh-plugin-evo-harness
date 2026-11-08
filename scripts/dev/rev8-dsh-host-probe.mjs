#!/usr/bin/env node
/**
 * rev8 host-runtime MCP acceptance probe.
 *
 * The IN-HOST half must run under `ELECTRON_RUN_AS_NODE=1` with the installed
 * DeepSeek Harness executable (same pattern as scripts/host-smoke/run.mjs +
 * in-host.mjs). It reads (never edits) the desktop patch layer, mounts the
 * installed @deepseek-ai/dsh-mcp-client on the installed ToolRuntime, waits for
 * its initialize + tools/list, invokes the registered `mcp__evo__evo_status`
 * through the REAL bridge definition (real SDK client -> stdio server), then
 * disposes the Cordis fibers and verifies the tool registrations are gone.
 *
 * Contract facts this file RELIES ON, all verified against the installed asar
 * runtime (0.2.2-rc.1) in this workspace before being encoded here:
 *   - `yaml.parse` (asar dsh/node_modules/yaml 2.9.1, dist/index.js) tolerates
 *     `!!js` tags by falling back to the literal string (stderr warning only);
 *     this probe therefore never evaluates !!js expressions and drops env from
 *     all output. The deployed template passes the gateway key by FILE PATH, so
 *     no functional gap for the real acceptance run.
 *   - `mcp.Config(config)` is callable and applies schema defaults.
 *   - `ctx.plugin(mcpObject, config)` returns the plugin's Cordis Fiber
 *     (thenable); `await fiber.inertia` settles exactly when the bridge's
 *     async apply() finished, i.e. after initialize + initial tools/list.
 *   - Registered public names appear on `ctx.tools.view().visible` as
 *     `mcp__<serverName>__<rawName>`; `ctx.tools.executable(name)` resolves the
 *     definition; `definition.execute(args, {name, arguments, signal, callId,
 *     rootCallId})` returns the canonical `{content, structuredContent?}`.
 *   - `await fiber.dispose()` unregisters the generation and closes the
 *     transport (observed: fiber.state 4, uid null, mcp registrations 0).
 *
 * What this probe does NOT do: start/stop the desktop DSH process, touch the
 * profile or E: drive, call any model gateway, or read any secret file. A
 * passed run proves the host client/bridge/server path — NOT UI tool exposure
 * or approval behaviour inside an existing interactive DSH session (those need
 * the deployment-stage session smoke). Logs keep bounded error text only; tool
 * payloads, env values and key-file contents are never recorded.
 *
 * Offline self-test (ordinary Node; real asar client + mock stdio server):
 *   node scripts/dev/rev8-dsh-host-probe.mjs --self-test
 *
 * Real deployed-entry acceptance (deployment stage only; exit 1 until the
 * mcp-evo entry exists and every stage passes):
 *   node scripts/dev/rev8-dsh-host-probe.mjs --out work/rev8-mcp/host-probe-result.json
 *
 * Explicit pre-deployment readiness check (missing entry => not-run, exit 0):
 *   node scripts/dev/rev8-dsh-host-probe.mjs --allow-missing-entry
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { killProcessTree } from '../host-smoke/kill-tree.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_TIMEOUT_MS = 90_000;
const MAX_LOG_CHARS = 2_000;
const MAX_LOG_LINES = 100;

function errorText(error) {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.replace(/[\r\n]+/g, ' ').slice(0, MAX_LOG_CHARS);
}

/** Log config shape without env values, headers, args payload or secrets. */
function redactConfig(config) {
  const shared = {
    serverName: config.serverName,
    toolCallTimeoutMs: config.toolCallTimeoutMs,
    failOnStartupError: config.failOnStartupError,
    maxInstructionBytes: config.maxInstructionBytes,
    reconnect: config.reconnect
  };
  if (config.transport === 'stdio') {
    return { transport: 'stdio', command: config.command, args: config.args, cwd: config.cwd, ...shared };
  }
  return { transport: 'streamable-http', url: config.url, headers: '<omitted>', ...shared };
}

function parseArgs(argv) {
  const options = { selfTest: false, allowMissingEntry: false, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--self-test') options.selfTest = true;
    else if (arg === '--allow-missing-entry') options.allowMissingEntry = true;
    else if (arg === '--timeout-ms') options.timeoutMs = Number(argv[++i]);
    else if (arg === '--profile') options.profilePath = argv[++i];
    else if (arg === '--dsh-home') options.dshHome = argv[++i];
    else if (arg === '--out') options.outPath = argv[++i];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 5_000 || options.timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`--timeout-ms must be an integer from 5000 through ${MAX_TIMEOUT_MS}`);
  }
  if (options.profilePath !== undefined && !options.profilePath) throw new Error('missing value for --profile');
  if (options.outPath !== undefined && !options.outPath) throw new Error('missing value for --out');
  return options;
}

function locateHost(dshHome) {
  const installDir = dshHome ?? process.env.REV8_DSH_HOME ??
    (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness') : '');
  if (!installDir) throw new Error('DSH install directory not found; pass --dsh-home');
  return {
    installDir,
    executable: path.join(installDir, process.platform === 'win32' ? 'DeepSeek Harness.exe' : 'DeepSeek Harness'),
    asarPath: path.join(installDir, 'resources', 'app.asar')
  };
}

function spawnInHost(host, innerScript, input, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(host.executable, [innerScript], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        REV8_HOST_PROBE_INPUT: JSON.stringify(input),
        REV8_HOST_PROBE_ASAR: host.asarPath
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32'
    });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
      child.kill();
    }, timeoutMs);
    const tail = (old, chunk) => (old + String(chunk)).slice(-32_000);
    child.stdout.on('data', (chunk) => { stdout = tail(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = tail(stderr, chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + errorText(error), timedOut, pid: child.pid });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, pid: child.pid });
    });
  });
}

/** The in-host half: runs under the installed DSH Electron runtime. */
async function runInHost() {
  const input = JSON.parse(process.env.REV8_HOST_PROBE_INPUT ?? '{}');
  const asarPath = process.env.REV8_HOST_PROBE_ASAR;
  if (!asarPath) throw new Error('REV8_HOST_PROBE_ASAR is required');
  const packageDir = (name) => path.join(asarPath, 'dsh', 'node_modules', ...name.split('/'));
  const importHost = async (name, entry = 'lib/index.js') =>
    import(pathToFileURL(path.join(packageDir(name), entry)).href);
  const { parse: parseYaml } = await importHost('yaml', 'dist/index.js');
  const { Context } = await importHost('@deepseek-ai/cordis');
  const { SystemPrompt } = await importHost('@deepseek-ai/dsh-system-prompt');
  const { ToolRuntime } = await importHost('@deepseek-ai/dsh-tools');
  const mcp = await importHost('@deepseek-ai/dsh-mcp-client');

  const report = {
    schemaVersion: 1,
    evidenceKind: input.evidenceKind,
    status: 'not-run',
    ok: false,
    capturedAt: new Date().toISOString(),
    host: {
      product: 'DeepSeek Harness',
      version: JSON.parse(fs.readFileSync(path.join(asarPath, 'dsh', 'package.json'), 'utf8')).version,
      clientVersion: JSON.parse(fs.readFileSync(path.join(packageDir('@deepseek-ai/dsh-mcp-client'), 'package.json'), 'utf8')).version,
      electron: process.versions.electron ?? 'not-electron',
      node: process.versions.node,
      executable: process.execPath,
      asarPath,
      profilePath: input.profilePath
    },
    config: null,
    logs: [],
    checks: [],
    discovery: { found: false, entryId: null, entryName: null },
    initialize: { ok: false },
    toolsList: { ok: false, names: [] },
    toolCall: { name: 'mcp__evo__evo_status', ok: false },
    cleanup: { attempted: false, ok: false, registeredAfterDispose: null },
    failure: null
  };
  const check = (name, ok, detail = null) => {
    report.checks.push({ name, ok, ...(detail ? { detail } : {}) });
    if (!ok) throw new Error(`${name}${detail ? ': ' + detail : ''}`);
  };
  let context;
  let mcpFiber;
  const serviceFibers = [];
  let currentPhase = 'bootstrap';
  const deadline = Date.now() + input.timeoutMs - 3_000;
  const remaining = () => Math.max(1, deadline - Date.now());
  async function bounded(label, promise) {
    currentPhase = label;
    let timer;
    try {
      return await Promise.race([
        Promise.resolve(promise),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`host probe deadline at ${label} (${input.timeoutMs}ms budget)`)), remaining());
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    // -- discovery: read the desktop patch layer (read-only) ----------------
    currentPhase = 'discovery';
    const parsed = parseYaml(fs.readFileSync(input.profilePath, 'utf8'));
    check('desktop patch is a YAML array', Array.isArray(parsed), typeof parsed);
    // The deployed shape is a `- insert:` list item (rev8 plan §5.5: a bare
    // top-level `- id:` never activates a built-in package name, silently).
    // Discovery accepts BOTH shapes and requires exactly one mcp-evo across
    // them, so a wrong-shape deploy cannot masquerade as the deployed one.
    const matches = [
      ...parsed.filter((entry) => entry?.id === 'mcp-evo'),
      ...parsed
        .flatMap((entry) => (Array.isArray(entry?.insert) ? entry.insert : []))
        .filter((entry) => entry?.id === 'mcp-evo')
    ];
    if (matches.length === 0 && input.allowMissingEntry) {
      report.status = 'not-run';
      report.failure = {
        phase: 'discovery',
        reason: `no mcp-evo entry in ${input.profilePath} (pre-deployment state); explicit --allow-missing-entry readiness result, not MCP evidence`
      };
      return; // the finally block writes the report exactly once
    }
    check('exactly one mcp-evo entry', matches.length === 1, `found=${matches.length}`);
    const entry = matches[0];
    check('mcp-evo uses @deepseek-ai/dsh-mcp-client', entry.name === '@deepseek-ai/dsh-mcp-client', String(entry.name));
    check('mcp-evo is enabled', entry.disabled !== true && entry.disabled !== 'true', String(entry.disabled));
    check('mcp-evo has a config object', Boolean(entry.config) && typeof entry.config === 'object', typeof entry.config);
    const config = mcp.Config(entry.config); // real installed schema, defaults applied
    report.config = redactConfig(config);
    report.discovery = {
      found: true,
      entryId: entry.id,
      entryName: entry.name,
      // true when the entry rode a `- insert:` wrapper (the deployed shape).
      viaInsert: !parsed.includes(entry)
    };
    if (config.transport === 'stdio' && typeof config.args[0] === 'string' && !fs.existsSync(config.args[0])) {
      const problem = `configured stdio server entry does not exist: ${config.args[0]}`;
      if (input.allowMissingEntry) {
        report.status = 'not-run';
        report.failure = {
          phase: 'discovery',
          reason: `${problem}; explicit --allow-missing-entry readiness result, not MCP evidence`
        };
        return; // the finally block writes the report exactly once
      }
      throw new Error(problem);
    }

    // -- real host services + real plugin ------------------------------------
    currentPhase = 'host-services';
    context = new Context();
    for (const level of ['debug', 'info', 'warn', 'error', 'success']) {
      context.logger[level] = (format, ...args) => {
        if (report.logs.length < MAX_LOG_LINES) {
          const text = [format, ...args]
            .map((value) => (typeof value === 'string' ? value : errorText(value)))
            .join(' ');
          report.logs.push({ level, message: text.slice(0, MAX_LOG_CHARS) });
        }
      };
    }
    serviceFibers.push(ctxPlugin(SystemPrompt), ctxPlugin(ToolRuntime));
    function ctxPlugin(pluginObject) {
      return context.plugin(pluginObject); // returns the plugin's Fiber (verified)
    }
    await bounded('host-service-start', new Promise((resolve) => setTimeout(resolve, 250)));
    check('real ctx.tools is mounted', context.tools !== undefined);

    currentPhase = 'mcp-apply-initialize-tools-list';
    mcpFiber = context.plugin(mcp, config);
    // await the bridge's own async apply() settle (initialize + tools/list).
    await bounded('mcp-apply-initialize-tools-list', fiberInertia(mcpFiber));
    report.initialize.ok = true;
    report.checks.push({ name: 'dsh-mcp-client apply settled after initialize', ok: true });

    currentPhase = 'tools-list';
    async function fiberInertia(fiber) {
      // activation is scheduled on the microtask queue; wait briefly for the
      // in-flight transition promise, then await it (rejects on failure).
      const started = Date.now();
      while (!fiber.inertia && fiber.state === 0 && Date.now() - started < 2_000) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!fiber.inertia) throw new Error(`mcp fiber never started activation (state=${fiber.state})`);
      return fiber.inertia;
    }
    const publicNames = [...context.tools.view().visible.keys()]
      .filter((name) => name.startsWith('mcp__evo__'))
      .sort();
    report.toolsList = { ok: true, names: publicNames };
    check(
      'tools/list registered mcp__evo__evo_status',
      publicNames.includes('mcp__evo__evo_status'),
      `evo tool count=${publicNames.length} names=${publicNames.join(',')}`
    );

    // -- call the REAL registered bridge definition ---------------------------
    currentPhase = 'mcp__evo__evo_status';
    const tool = context.tools.executable('mcp__evo__evo_status');
    check('registered evo_status is executable', typeof tool?.execute === 'function', typeof tool?.execute);
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(new Error('evo_status probe deadline')), remaining());
    let call;
    try {
      call = await bounded('mcp__evo__evo_status', tool.execute({}, {
        name: 'mcp__evo__evo_status',
        arguments: {},
        signal: controller.signal,
        callId: 'rev8-host-probe-status',
        rootCallId: 'rev8-host-probe-status'
      }));
    } finally {
      clearTimeout(abortTimer);
    }
    check('evo_status result is not an MCP error', call?.isError !== true, String(call?.isError));
    check('evo_status returned canonical content', Array.isArray(call?.content) && call.content.length > 0, String(call?.content?.length));
    const statusPayload = call?.structuredContent?.payload;
    check('evo_status execution.mode=shadow', statusPayload?.execution?.mode === 'shadow', String(statusPayload?.execution?.mode));
    check('evo_status applyWinningPatch=false', statusPayload?.execution?.applyWinningPatch === false, String(statusPayload?.execution?.applyWinningPatch));
    report.toolCall = {
      name: 'mcp__evo__evo_status',
      ok: true,
      executionMode: statusPayload.execution.mode,
      applyWinningPatch: statusPayload.execution.applyWinningPatch,
      contentBlocks: call.content.length
    };
    report.status = 'passed';
    report.ok = true;
  } catch (error) {
    report.status = 'failed';
    report.ok = false;
    report.failure = { phase: currentPhase, reason: errorText(error) };
  } finally {
    // -- disconnect cleanup: dispose the MCP fiber first (its connection
    // effect closes the SDK client + transport and unregisters the tools),
    // then the host service fibers. Every step is bounded. A not-run result
    // (discovery refused before any connection) records nothing as attempted.
    if (report.status !== 'not-run') {
      report.cleanup.attempted = true;
    try {
      if (mcpFiber && mcpFiber.uid !== null) await bounded('dispose-mcp', mcpFiber.dispose());
      for (const fiber of serviceFibers.reverse()) {
        if (fiber.uid !== null) await bounded('dispose-service', fiber.dispose());
      }
      const remainingNames = context?.tools
        ? [...context.tools.view().visible.keys()].filter((name) => name.startsWith('mcp__evo__'))
        : [];
      report.cleanup.registeredAfterDispose = remainingNames.length;
      report.cleanup.ok = remainingNames.length === 0;
      report.checks.push({ name: 'disconnect removed evo tool registrations', ok: remainingNames.length === 0, detail: `remaining=${remainingNames.length}` });
      if (remainingNames.length !== 0) {
        report.ok = false;
        report.status = 'failed';
        report.failure ??= { phase: 'cleanup', reason: `${remainingNames.length} evo tool registrations remain after dispose` };
      }
    } catch (error) {
      report.cleanup.ok = false;
      report.cleanup.error = errorText(error);
      report.ok = false;
      report.status = 'failed';
      report.failure ??= { phase: 'cleanup', reason: errorText(error) };
    }
    }
    report.durationMs = Date.now() - new Date(report.capturedAt).getTime();
    process.stdout.write(JSON.stringify(report));
  }
}

async function runSelfTest() {
  const script = fileURLToPath(import.meta.url);
  const fixture = path.join(HERE, 'rev8-dsh-host-probe-fixture.mjs');
  const host = locateHost(undefined);
  const scenarios = ['success', 'missing-tool', 'tool-error', 'timeout'];
  let failures = 0;
  for (const scenario of scenarios) {
    const started = Date.now();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev8-host-probe-'));
    const profilePath = path.join(tempDir, 'cordis.patch.yml');
    try {
      await new Promise((resolve, reject) => {
        const writer = spawn(process.execPath, [fixture, profilePath, `offline-${scenario}`], { stdio: 'ignore', windowsHide: true });
        writer.once('error', reject);
        writer.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`fixture patch writer exit=${code}`))));
      });
      const outcome = await spawnInHost(host, script, {
        evidenceKind: `offline-${scenario}`,
        profilePath,
        timeoutMs: 20_000
      }, 30_000);
      let parsed;
      try {
        parsed = JSON.parse(outcome.stdout.trim());
      } catch {
        parsed = null;
      }
      const expectedStatus = scenario === 'success' ? 'passed' : 'failed';
      const cleanupAttempted = parsed?.cleanup?.attempted === true;
      let scenarioOk = outcome.code === 0 && parsed?.status === expectedStatus && cleanupAttempted;
      let extra = '';
      if (scenarioOk && scenario === 'success') {
        // the mock server child must be reaped after dispose (pidfile evidence)
        const pidFile = profilePath + '.fixture.pid';
        const pid = Number(fs.readFileSync(pidFile, 'utf8'));
        let alive = true;
        for (let waited = 0; waited < 3_000 && alive; waited += 250) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          try { process.kill(pid, 0); } catch { alive = false; }
        }
        scenarioOk = !alive;
        extra = ` fixtureServerReaped=${String(!alive)}`;
      }
      const label = scenarioOk ? 'PASS' : 'FAIL';
      const reason = parsed?.failure ? `${parsed.failure.phase}: ${parsed.failure.reason}` : 'none';
      console.log(`[self-test] ${scenario}: ${label} status=${parsed?.status ?? 'no-json'} failure=${reason} cleanup=${String(cleanupAttempted)} wallMs=${String(Date.now() - started)}${extra}`);
      if (scenario === 'success' && scenarioOk) {
        console.log(`[self-test] success tools=${parsed.toolsList.names.join(',')} call=${parsed.toolCall.name} mode=${parsed.toolCall.executionMode} applyWinningPatch=${String(parsed.toolCall.applyWinningPatch)}`);
      }
      if (!scenarioOk) {
        failures += 1;
        console.log(`[self-test] ${scenario}: exit=${String(outcome.code)} timedOut=${String(outcome.timedOut)} stdoutTail=${outcome.stdout.slice(-1_500)} stderrTail=${outcome.stderr.slice(-1_500)}`);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
  if (failures > 0) throw new Error(`${failures} offline self-test scenario(s) failed`);
  console.log('[self-test] all 4 scenarios passed; no real evo MCP entry was called');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log([
      'node scripts/dev/rev8-dsh-host-probe.mjs --self-test',
      'node scripts/dev/rev8-dsh-host-probe.mjs [--profile <cordis.patch.yml>] [--dsh-home <install>]',
      '                                          [--out <result.json>] [--allow-missing-entry] [--timeout-ms 45000]'
    ].join('\n'));
    return;
  }
  if (options.selfTest) {
    await runSelfTest();
    return;
  }

  const host = locateHost(options.dshHome);
  const profilePath = options.profilePath ?? path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
  const input = {
    evidenceKind: 'real-host-configured-evo',
    profilePath,
    timeoutMs: options.timeoutMs,
    allowMissingEntry: options.allowMissingEntry
  };
  const outcome = await spawnInHost(host, fileURLToPath(import.meta.url), input, options.timeoutMs);
  let report;
  try {
    report = JSON.parse(outcome.stdout.trim());
  } catch {
    report = {
      schemaVersion: 1,
      evidenceKind: input.evidenceKind,
      status: 'not-run',
      ok: false,
      capturedAt: new Date().toISOString(),
      host,
      failure: {
        phase: outcome.timedOut ? 'deadline' : 'runner',
        reason: outcome.timedOut
          ? `outer deadline ${options.timeoutMs}ms exceeded; process tree reaped`
          : 'in-host probe produced no JSON result'
      },
      runner: {
        exitCode: outcome.code,
        timedOut: outcome.timedOut,
        stdoutTail: outcome.stdout.slice(-MAX_LOG_CHARS),
        stderrTail: outcome.stderr.slice(-MAX_LOG_CHARS)
      }
    };
  }
  report.runner = { ...(report.runner ?? {}), exitCode: outcome.code, timedOut: outcome.timedOut };
  if (outcome.timedOut || outcome.code !== 0) {
    report.ok = false;
    if (report.status === 'passed') report.status = 'failed';
    report.failure ??= { phase: 'runner', reason: `in-host exit=${outcome.code} timedOut=${outcome.timedOut}` };
  }
  const serialized = JSON.stringify(report, null, 2) + '\n';
  if (options.outPath) {
    const outPath = path.resolve(REPO_ROOT, options.outPath);
    if (fs.existsSync(outPath)) throw new Error(`refusing to overwrite existing result: ${outPath}`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, serialized, { encoding: 'utf8', flag: 'wx' });
  }
  process.stdout.write(serialized);
  console.log(`[rev8-host-probe] status=${report.status} ok=${String(report.ok)} evidence=${report.evidenceKind}` +
    (report.failure ? ` failure=${report.failure.phase}: ${report.failure.reason}` : ''));
  // Only an explicitly requested missing-entry readiness result may end non-pass
  // with exit 0. Real initialize/list/call/teardown failures stay red.
  process.exitCode = report.ok || (options.allowMissingEntry && report.status === 'not-run' && !outcome.timedOut && outcome.code === 0) ? 0 : 1;
}

if (process.env.REV8_HOST_PROBE_INPUT) {
  await runInHost().catch((error) => {
    process.stdout.write(JSON.stringify({
      schemaVersion: 1,
      status: 'failed',
      ok: false,
      failure: { phase: 'in-host-bootstrap', reason: errorText(error) }
    }));
    process.exitCode = 1;
  });
} else {
  await main().catch((error) => {
    console.error('[rev8-host-probe] ' + errorText(error));
    process.exitCode = 1;
  });
}
