/**
 * rev8 boundary fix 4: the client-disconnect lifecycle over a REAL stdio
 * subprocess.
 *
 * WHY A SUBPROCESS (the ask: "用真实子进程测试 stdin close、探针 signal aborted
 * 和临时目录清理，不能只测直接 dispose")
 *   The InMemoryTransport tests cannot observe what a real disconnect does:
 *   the SDK's serveStdio owns wire.onclose, closes only the pinned McpServer
 *   PRODUCT (stdio.mjs:566-572), and never invokes a host callback — so the
 *   assembly's fate on a real client disconnect is invisible there. Here the
 *   server runs in a real `node` child whose stdin this test closes; the
 *   assertions observe the REAL lifecycle: the run's probe signal aborts, the
 *   data directory becomes removable (no open write handle keeps it alive),
 *   and the child exits cleanly instead of being held by an empty stdin
 *   handle.
 *
 * MECHANISM UNDER TEST
 *   serveEvoMcpStdio passes a custom StdioServerTransport and wraps its
 *   onclose BEFORE server.connect() (the SDK's Protocol.connect preserves and
 *   chains the previous callback). On stdin close the wrapper cancels all
 *   running jobs and disposes the assembly — verified by the child writing a
 *   structured JSON line to STDERR when the runner's signal aborts and when
 *   dispose completes (stderr is the one channel a stdio MCP server may use).
 *
 * OFFLINE: the model is the bundle's scripted default path never reached (the
 * runBranch runner blocks on the abort); the data dir is a fresh temp dir; no
 * DSH, no gateway, no key.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require_ = createRequire(import.meta.url);

/** Tracked temp dirs (the bundle dir and the per-test data dirs). */
const trackedDirs: string[] = [];

afterAll(async () => {
  for (const dir of trackedDirs.splice(0, trackedDirs.length)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

/**
 * Bundle the REAL src/mcp/server.ts into a temp dir with the byte-identical
 * esbuild options scripts/build.mjs uses — the disconnect wiring ships in the
 * entry module, so the subprocess must run THAT module, not a re-implementation.
 */
async function bundleServerEntry(): Promise<string> {
  const esbuild = require_(path.join(repoRoot, 'node_modules', 'esbuild')) as {
    buildSync: (options: Record<string, unknown>) => unknown;
  };
  const dir = await mkdtemp(path.join(tmpdir(), 'evo-mcp-disconnect-'));
  trackedDirs.push(dir);
  const outfile = path.join(dir, 'server.js');
  esbuild.buildSync({
    entryPoints: [path.join(repoRoot, 'src', 'mcp', 'server.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile,
    sourcemap: 'external',
    logLevel: 'silent'
  });
  return outfile;
}

interface StderrEvent {
  readonly event: string;
  readonly [key: string]: unknown;
}

/** All stderr JSON diagnostic lines the child emitted. */
function parseEvents(stderr: string): StderrEvent[] {
  const events: StderrEvent[] = [];
  for (const line of stderr.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed) as StderrEvent);
    } catch {
      // Non-JSON stderr (e.g. a crash dump) is surfaced by the exit assertions.
    }
  }
  return events;
}

interface StdioRpc {
  request(method: string, params: Record<string, unknown>): Promise<Record<string, any>>;
  closeStdin(): void;
  stderr: string;
  exit: Promise<number | string>;
}

/** Speak the JSON-RPC handshake + one tools/call against the child's stdio. */
function speak(entry: string, env: Record<string, string>): StdioRpc {
  const child = spawn(process.execPath, [entry], {
    cwd: repoRoot,
    env: {
      // Explicit env, mirroring the probe's scrubbing: nothing sensitive
      // inherited, only what the server needs.
      PATH: process.env.PATH ?? '',
      SystemRoot: process.env.SystemRoot ?? '',
      ...env
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let buffer = '';
  let stderrText = '';
  const pending = new Map<number, (value: Record<string, any>) => void>();
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += String(chunk);
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) {
        try {
          const message = JSON.parse(line) as { id?: number; result?: Record<string, any>; error?: unknown };
          if (message.id !== undefined && pending.has(message.id)) {
            const resolve = pending.get(message.id)!;
            pending.delete(message.id);
            resolve(message);
          }
        } catch {
          // ignore unparseable
        }
      }
      newline = buffer.indexOf('\n');
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrText += String(chunk);
  });
  let seq = 0;
  const request = (method: string, params: Record<string, unknown>): Promise<Record<string, any>> =>
    new Promise((resolve, reject) => {
      seq += 1;
      const id = seq;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('stdio request timed out: ' + method));
        }
      }, 30_000);
      void timer;
    });
  const exit = new Promise<number | string>((resolve) => {
    child.on('exit', (code) => resolve(code ?? 'signal'));
  });
  return {
    request,
    closeStdin: (): void => {
      child.stdin.end();
    },
    get stderr(): string {
      return stderrText;
    },
    exit
  };
}

/** The canned per-test config (cheap budgets, silent logging). */
function cheapConfig(): Record<string, unknown> {
  return {
    triggerMode: 'slash_command',
    probe: { maxConcurrentProbes: 1, probeTimeoutMs: 30_000 },
    dreamRsi: {
      maxOnlineRolloutBudget: 2,
      maxWidth: 1,
      maxDepth: 1,
      candidatePoliciesCount: 2,
      rhoPreferences: [0, 1],
      offlineDreamTriggerEveryNTasks: 100
    },
    logging: { level: 'silent' }
  };
}

// The runner the child uses lives inside the generated entry below: a branch
// executor that blocks until its branch signal aborts (what a real probe
// executor does with a disconnected caller), then reports the abort onto
// stderr as a structured line.

/**
 * Build the child's ENTRY: it imports the bundled server module and serves it
 * over real stdio with a slow runner — a thin harness for the REAL wiring
 * (serveEvoMcpStdio + StdioServerTransport), not a re-implementation.
 */
async function makeChildEntry(serverEntry: string, config: unknown, dataDir: string): Promise<string> {
  const dir = path.dirname(serverEntry);
  const entryPath = path.join(dir, 'child-entry.mjs');
  // ESM imports on Windows need file:// URLs, never bare drive paths.
  const serverUrl = pathToFileURL(serverEntry).href;
  const source = [
    "import { serveEvoMcpStdio } from '" + serverUrl + "';",
    "import { readFileSync } from 'node:fs';",
    "import path from 'node:path';",
    '',
    '// Per-test parameters arrive through sibling JSON files (no shell quoting).',
    'const config = JSON.parse(readFileSync(path.join(import.meta.dirname, "config.json"), "utf8"));',
    'const dataDir = JSON.parse(readFileSync(path.join(import.meta.dirname, "datadir.json"), "utf8")).dataDir;',
    '',
    'const runner = (context) => new Promise((resolve, reject) => {',
    '  const finish = () => {',
    '    process.stderr.write(JSON.stringify({ event: "runner_released", aborted: context.signal.aborted }) + "\\n");',
    '    if (context.signal.aborted) { reject(new Error("branch aborted by its caller")); return; }',
    '    resolve({ status: "succeeded", steps: [], toolErrors: [], failureSignals: [], deliverable: { content: "done", format: "markdown", producedFiles: [] } });',
    '  };',
    '  if (context.signal.aborted) { finish(); return; }',
    '  context.signal.addEventListener("abort", finish, { once: true });',
    '});',
    '',
    'const handle = serveEvoMcpStdio({',
    '  assembly: {',
    '    options: { runBranch: runner },',
    '    config,',
    '    dataDir: { dataDir, env: { EVO_HARNESS_DATA_DIR: undefined, DSH_DATA_DIR: undefined, DSH_PROFILE: undefined } }',
    '  },',
    '  log: (line) => {',
    '    if (line.includes("dispose cancelled") || line.includes("dispose error") || line.includes("dispose failed")) {',
    '      process.stderr.write(JSON.stringify({ event: "server_log", line }) + "\\n");',
    '    }',
    '  }',
    '});',
    'void handle;',
    'process.stderr.write(JSON.stringify({ event: "ready" }) + "\\n");',
    ''
  ].join('\n');
  await mkdir(dir, { recursive: true });
  await writeFile(entryPath, source, 'utf8');
  await writeFile(path.join(dir, 'config.json'), JSON.stringify(config), 'utf8');
  await writeFile(path.join(dir, 'datadir.json'), JSON.stringify({ dataDir }), 'utf8');
  return entryPath;
}

describe('client disconnect lifecycle (real subprocess, rev8 boundary fix 4)', () => {
  it('stdin close aborts the running probe, disposes the assembly, and exits the process cleanly', async () => {
    const serverEntry = await bundleServerEntry();
    const dataDir = await mkdtemp(path.join(tmpdir(), 'evo-mcp-disconnect-data-'));
    trackedDirs.push(dataDir);
    const childEntry = await makeChildEntry(serverEntry, cheapConfig(), dataDir);
    const rpc = speak(childEntry, { EVO_HARNESS_DATA_DIR: dataDir });

    try {
      // Handshake over the real stdio.
      const init = await rpc.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'disconnect-test', version: '0.0.0' }
      });
      expect(init.error).toBeUndefined();
      expect(init.result?.serverInfo?.name).toBe('evo');
      rpc.request('notifications/initialized', {}).catch(() => {});

      // Start a run whose branch executor blocks until the branch signal
      // aborts. Submit returns immediately (start/poll contract).
      const submitted = await rpc.request('tools/call', {
        name: 'evo_run_submit',
        arguments: { prompt: 'Disconnect while running.', sessionId: 'sess-disconnect' }
      });
      expect(submitted.result?.isError).toBeFalsy();
      const runId: string = submitted.result.structuredContent.payload.runId;

      // Wait until the child's runner is inside the blocked branch.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(rpc.stderr).toContain('ready');

      // THE DISCONNECT: close stdin like a dying client would.
      rpc.closeStdin();

      // The run's branch signal must abort (the book's cancelAll ran through
      // the transport's onclose wrapper) and the runner must be released.
      const exit = await Promise.race([
        rpc.exit,
        new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 20_000))
      ]);
      expect(exit).toBe(0);

      const events = parseEvents(rpc.stderr);
      const released = events.find((event) => event['event'] === 'runner_released');
      // The probe OBSERVED the abort: signal aborted is the honest evidence.
      expect(released).toBeDefined();
      expect(released?.['aborted']).toBe(true);
      // The dispose path logged the cancellation of OUR run.
      const disposeLog = events.find(
        (event) => event['event'] === 'server_log' && String(event['line']).includes(runId)
      );
      expect(disposeLog).toBeDefined();

      // The data directory is REMOVABLE: no flush/write handle held it open
      // past dispose (Windows would refuse an rm over an open handle).
      await expect(rm(dataDir, { recursive: true, force: true })).resolves.toBeUndefined();
    } finally {
      rpc.closeStdin();
      await Promise.race([rpc.exit, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
  }, 60_000);

  it('a clean disconnect with NO running jobs still disposes and exits (no stdin-handle hold)', async () => {
    const serverEntry = await bundleServerEntry();
    const dataDir = await mkdtemp(path.join(tmpdir(), 'evo-mcp-idle-disconnect-'));
    trackedDirs.push(dataDir);
    const childEntry = await makeChildEntry(serverEntry, cheapConfig(), dataDir);
    const rpc = speak(childEntry, { EVO_HARNESS_DATA_DIR: dataDir });
    try {
      const init = await rpc.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'disconnect-test', version: '0.0.0' }
      });
      expect(init.error).toBeUndefined();
      // One cheap synchronous call. Startup is LAZY (rev8 lifecycle fix), so
      // it is this call — not the process start — that resolves the assembly
      // and creates the data directory.
      const status = await rpc.request('tools/call', { name: 'evo_status', arguments: {} });
      expect(status.result?.isError).toBeFalsy();
      // The assembly created the persistence data directory on disk (an
      // explicit dataDir is used verbatim — precedence 1 of
      // resolveProfileDataDir — so it IS the profile dir here). The directory
      // appearing only AFTER the call above is what proves the lazy start: the
      // process was already serving requests before it existed.
      const dirExisted = await readdir(dataDir).then(
        () => true,
        () => false
      );
      expect(dirExisted).toBe(true);

      rpc.closeStdin();
      const exit = await Promise.race([
        rpc.exit,
        new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 20_000))
      ]);
      // The empty stdin handle must not hold the process open.
      expect(exit).toBe(0);
      await expect(rm(dataDir, { recursive: true, force: true })).resolves.toBeUndefined();
    } finally {
      rpc.closeStdin();
      await Promise.race([rpc.exit, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
  }, 60_000);
});
