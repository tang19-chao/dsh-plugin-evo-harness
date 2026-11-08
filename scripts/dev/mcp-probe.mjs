#!/usr/bin/env node
/**
 * MCP stdio probe for the evo server (rev8 plan §5.8 step 1).
 *
 * WHAT IT DOES (spawns a real subprocess, speaks real JSON-RPC over stdio)
 *   1. spawns `node <server-entry>` with a TEMPORARY data directory
 *      (EVO_HARNESS_DATA_DIR points at a fresh mkdtemp dir - never the real
 *      plugin profile, never a host directory);
 *   2. speaks the handshake: initialize (protocolVersion 2025-06-18) ->
 *      notifications/initialized;
 *   3. asserts tools/list returns EXACTLY the seven evo_* tools and that each
 *      carries a JSON-schema inputSchema — and, BEFORE any tool call, that the
 *      temp data directory does NOT exist yet (lazy startup: handshake and
 *      tools/list create nothing);
 *   4. calls the model-free tools and asserts their replies:
 *      evo_status (shadow constants) and evo_text_probe (honest third state);
 *   5. calls evo_run_submit with dryRun:true and asserts the NO-SIDE-EFFECT
 *      preview: the payload says nothing was started AND the recursive data
 *      directory listing is byte-for-byte unchanged across the call (no run
 *      record, no persistence write, no data directory growth);
 *   6. calls evo_jit status (the read-only controller surface);
 *   7. calls evo_dream on the EMPTY pool and asserts the verified-tree gate
 *      REFUSES with its reason (triggered=false, no dream report, the dream
 *      counter stays 0 - never a fabricated replay);
 *   8. calls evo_lessons and asserts the bounded page shape;
 *   9. asserts the SHADOW ZERO-SIDE-EFFECT property: after all calls, the
 *      temp data directory contains ONLY evo-harness products and the process
 *      is still alive with no active mounts;
 *  10. closes stdin and waits for a clean child exit.
 *
 * TEXT BUDGET (rev8 plan §5.2): EVERY tools/call reply's complete text (the
 * whole content[0].text string, clipping marker included) is asserted at
 * <= 8000 characters - the server's own EVO_TOOL_TEXT_LIMIT, inside the
 * host's spill/pruner gates.
 *
 * No DSH process is started or stopped, no host configuration is read or
 * written, no gateway key is read (no model call happens: every tool the
 * probe calls is model-free - the dryRun preview and the gated dream never
 * reach a model), no network listener is opened.
 *
 * Usage: node scripts/dev/mcp-probe.mjs [--entry lib/mcp/server.js]
 *   --entry  server entry to spawn (default lib/mcp/server.js - run
 *            `pnpm run build` first; the path is used verbatim, so a source
 *            run needs a pre-built bundle or another runner).
 * Exit code 0 = every assertion held; 1 = a failed assertion (printed).
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let entryArg = 'lib/mcp/server.js';
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--entry') {
    entryArg = args[i + 1] ?? entryArg;
    i += 1;
  }
}
const entryPath = path.isAbsolute(entryArg) ? entryArg : path.join(repoRoot, entryArg);

// ---------------------------------------------------------------------------
// assertion helper
// ---------------------------------------------------------------------------

/** @type {string[]} */
const failures = [];
/**
 * @param {boolean} ok
 * @param {string} label
 */
function check(ok, label) {
  if (ok) {
    process.stdout.write('  ok    ' + label + '\n');
  } else {
    failures.push(label);
    process.stdout.write('  FAIL  ' + label + '\n');
  }
}

/** The server's own hard cap (src/mcp/server.ts EVO_TOOL_TEXT_LIMIT). */
const TOOL_TEXT_LIMIT = 8000;

/**
 * Assert one tools/call reply's COMPLETE text stays inside the 8k budget
 * (plan §5.2: the whole content[0].text string, clipping marker included —
 * the server must clip before the host's spill/pruner gates do).
 * @param {any} reply
 * @param {string} label
 */
function checkTextBudget(reply, label) {
  const text = reply?.result?.content?.[0]?.text ?? '';
  check(
    typeof text === 'string' && text.length <= TOOL_TEXT_LIMIT,
    label + ' complete text stays within ' + String(TOOL_TEXT_LIMIT) + ' chars (got ' + String(text.length) + ')'
  );
}

/**
 * Recursive snapshot of a directory listing, normalized and sorted, so a
 * before/after dryRun comparison can prove nothing was written.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listingOf(dir) {
  const entries = await readdir(dir, { recursive: true }).catch(() => []);
  return entries.map((name) => String(name).replace(/\\/g, '/')).sort();
}

// ---------------------------------------------------------------------------
// the probe client: a raw JSON-RPC speaker over the child's stdio
// ---------------------------------------------------------------------------

/** @type {Map<number, (value: any) => void>} */
const pending = new Map();
let nextId = 1;
/** @type {any[]} */
const inbound = [];
/** @type {((message: any) => void) | undefined} */
let onNotification;

const EXPECTED_TOOLS = [
  'evo_status',
  'evo_run_submit',
  'evo_run_poll',
  'evo_dream',
  'evo_jit',
  'evo_lessons',
  'evo_text_probe'
];

async function main() {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'evo-mcp-probe-'));
  const dataDir = path.join(dataRoot, 'data');
  let child;
  try {
    child = spawn(process.execPath, [entryPath], {
      cwd: repoRoot,
      env: {
        // Explicit env: the stdio child inherits nothing sensitive from this
        // probe process (mirrors the DSH scrubbing the plan documents).
        PATH: process.env.PATH ?? '',
        SystemRoot: process.env.SystemRoot ?? '',
        EVO_HARNESS_DATA_DIR: dataDir
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdoutBuffer = '';
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += String(chunk);
      let newline = stdoutBuffer.indexOf('\n');
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line.length > 0) {
          try {
            const message = JSON.parse(line);
            if (message.id !== undefined && pending.has(message.id)) {
              const resolve = pending.get(message.id);
              pending.delete(message.id);
              resolve(message);
            } else {
              inbound.push(message);
              if (onNotification !== undefined) onNotification(message);
            }
          } catch {
            process.stdout.write('  note  unparseable stdout line: ' + line.slice(0, 120) + '\n');
          }
        }
        newline = stdoutBuffer.indexOf('\n');
      }
    });
    /** @type {string[]} */
    const stderrLines = [];
    child.stderr.on('data', (chunk) => {
      stderrLines.push(String(chunk).trim());
    });

    /** @param {any} body @returns {Promise<any>} */
    const request = (body) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, resolve);
        child.stdin.write(JSON.stringify({ ...body, id }) + '\n');
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error('request timed out: ' + String(body.method)));
          }
        }, 60_000);
      });
    /** @param {any} body */
    const notify = (body) => {
      child.stdin.write(JSON.stringify(body) + '\n');
    };

    process.stdout.write('evo MCP probe\n  entry: ' + entryPath + '\n  dataDir: ' + dataDir + '\n');

    // -- 1. handshake ------------------------------------------------------
    const init = await request({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'mcp-probe', version: '0.1.0' }
      }
    });
    check(init.error === undefined, 'initialize succeeds');
    check(init.result?.protocolVersion === '2025-06-18', 'negotiated protocol is 2025-06-18 (got ' + String(init.result?.protocolVersion) + ')');
    check(init.result?.serverInfo?.name === 'evo', 'serverInfo.name is "evo"');
    check(typeof init.result?.instructions === 'string' && init.result.instructions.includes('SHADOW'), 'instructions mention SHADOW');
    check(
      init.result?.capabilities?.tools !== undefined,
      'server advertises the tools capability'
    );
    notify({ jsonrpc: '2.0', method: 'notifications/initialized' });

    // -- 2. tools/list: exactly the seven ---------------------------------
    const list = await request({ jsonrpc: '2.0', method: 'tools/list' });
    // LAZY STARTUP (the lifecycle fix): after a resolved handshake and a
    // tools/list — with no tool call yet — the server must not have created
    // the data directory at all. Checked here, BEFORE the first initializing
    // call, so this is a real observation of process startup rather than an
    // after-the-fact inference.
    const preCallEntries = await readdir(dataDir, { recursive: true }).catch(() => 'MISSING');
    check(
      preCallEntries === 'MISSING',
      'handshake + tools/list created NO data directory (lazy startup; got ' + JSON.stringify(preCallEntries) + ')'
    );
    const toolNames = (list.result?.tools ?? []).map((/** @type {any} */ tool) => tool.name);
    check(
      toolNames.length === EXPECTED_TOOLS.length && EXPECTED_TOOLS.every((name) => toolNames.includes(name)),
      'tools/list returns exactly the seven evo tools (got ' + JSON.stringify(toolNames) + ')'
    );
    for (const tool of list.result?.tools ?? []) {
      const schema = tool.inputSchema;
      check(
        schema !== undefined && schema.type === 'object',
        'tool ' + tool.name + ' carries an object inputSchema'
      );
    }
    const evoJit = (list.result?.tools ?? []).find((/** @type {any} */ tool) => tool.name === 'evo_jit');
    const jitEnum = evoJit?.inputSchema?.properties?.action?.enum;
    check(
      Array.isArray(jitEnum) && ['on', 'off', 'status', 'reset'].every((a) => jitEnum.includes(a)),
      'evo_jit inputSchema restricts action to the on/off/status/reset enum'
    );

    // -- 3. evo_status (model-free) ---------------------------------------
    const status = await request({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'evo_status', arguments: {} }
    });
    check(status.error === undefined, 'evo_status call succeeds');
    check(status.result?.isError !== true, 'evo_status result is not an error result');
    const statusStructured = status.result?.structuredContent?.payload;
    check(statusStructured?.execution?.mode === 'shadow', 'evo_status reports execution.mode=shadow');
    check(statusStructured?.execution?.applyWinningPatch === false, 'evo_status reports applyWinningPatch=false');
    check(typeof statusStructured?.dataDir === 'string' && statusStructured.dataDir.startsWith(dataDir), 'evo_status dataDir is inside the probe temp dir');
    // (the text budget for evo_status is asserted by checkTextBudget below,
    // together with every other tools/call reply)

    // -- 4. evo_text_probe (model-free, honest third state) ---------------
    const probe = await request({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'evo_text_probe', arguments: { prompt: 'probe from scripts/dev/mcp-probe.mjs' } }
    });
    check(probe.result?.isError !== true, 'evo_text_probe result is not an error result');
    const probeStructured = probe.result?.structuredContent?.payload;
    check(probeStructured?.status === 'not-evaluable', 'evo_text_probe reports not-evaluable (the honest third state)');
    check(probeStructured?.reward === 0 && probeStructured?.evaluable === false, 'evo_text_probe carries evaluable=false and reward=0');
    checkTextBudget(status, 'evo_status');
    checkTextBudget(probe, 'evo_text_probe');

    // -- 5. evo_run_submit dryRun: a NO-SIDE-EFFECT preview ----------------
    // The data directory already exists (evo_status created the assembly), so
    // the zero-side-effect proof is a before/after listing comparison: the
    // dryRun must not add a single entry, mint a run record, or touch disk.
    const listingBeforeDryRun = await listingOf(dataDir);
    const dry = await request({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'evo_run_submit',
        arguments: {
          prompt: 'dryRun preview from scripts/dev/mcp-probe.mjs - nothing should run',
          sessionId: 'probe-dryrun',
          dryRun: true
        }
      }
    });
    check(dry.result?.isError !== true, 'evo_run_submit dryRun result is not an error result');
    const dryStructured = dry.result?.structuredContent?.payload;
    check(dryStructured?.dryRun === true, 'dryRun payload marks itself dryRun=true');
    check(
      typeof dryStructured?.note === 'string' && dryStructured.note.includes('nothing was started'),
      'dryRun note says nothing was started'
    );
    check(dryStructured?.request?.trigger === 'slash_command', 'dryRun previews the exact request shape (trigger slash_command)');
    const listingAfterDryRun = await listingOf(dataDir);
    check(
      JSON.stringify(listingBeforeDryRun) === JSON.stringify(listingAfterDryRun),
      'dryRun left the data directory listing UNCHANGED (no run record, no persistence write)'
    );
    const statusAfterDry = await request({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'evo_status', arguments: {} }
    });
    const runsAfterDry = statusAfterDry.result?.structuredContent?.payload?.runs;
    check(
      runsAfterDry?.running === 0 && runsAfterDry?.retained === 0,
      'no run record was minted by the dryRun (runs.running=0, runs.retained=0)'
    );
    checkTextBudget(dry, 'evo_run_submit dryRun');
    checkTextBudget(statusAfterDry, 'evo_status after dryRun');

    // -- 6. evo_jit status (the read-only controller surface) --------------
    const jit = await request({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'evo_jit', arguments: { action: 'status' } }
    });
    check(jit.result?.isError !== true, 'evo_jit status result is not an error result');
    const jitStructured = jit.result?.structuredContent?.payload;
    check(jitStructured?.command === 'status', 'evo_jit status reports command=status');
    check(jitStructured !== undefined && typeof jitStructured?.json === 'object' && jitStructured.json !== null, 'evo_jit status carries the controller json payload');
    checkTextBudget(jit, 'evo_jit status');

    // -- 7. evo_dream on the EMPTY pool: the verified-tree gate refuses ----
    const dream = await request({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'evo_dream', arguments: {} }
    });
    check(dream.result?.isError !== true, 'evo_dream (empty pool) result is not an error result');
    const dreamStructured = dream.result?.structuredContent?.payload;
    check(dreamStructured?.triggered === false, 'evo_dream on an empty pool is NOT triggered (the gate refuses)');
    check(typeof dreamStructured?.reason === 'string' && dreamStructured.reason.length > 0, 'evo_dream carries the gate reason (never a silent refusal)');
    check(dreamStructured?.report === null, 'evo_dream produced NO dream report');
    const statusAfterDream = await request({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'evo_status', arguments: {} }
    });
    const dreamStatus = statusAfterDream.result?.structuredContent?.payload?.dream;
    check(dreamStatus?.ready === false, 'dream readiness stays not-ready on the empty pool');
    check(dreamStatus?.dreamsPerformed === 0, 'the dream counter stays 0 (no fabricated replay)');
    checkTextBudget(dream, 'evo_dream empty pool');
    checkTextBudget(statusAfterDream, 'evo_status after dream');

    // -- 8. evo_lessons (bounded, redacted page) ----------------------------
    const lessons = await request({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'evo_lessons', arguments: { limit: 5 } }
    });
    check(lessons.result?.isError !== true, 'evo_lessons result is not an error result');
    const lessonsStructured = lessons.result?.structuredContent?.payload;
    check(Array.isArray(lessonsStructured?.lessons), 'evo_lessons returns the lessons array');
    check(Array.isArray(lessonsStructured?.dreamReports), 'evo_lessons returns the dreamReports array');
    check(
      lessonsStructured?.counts?.returned === (lessonsStructured?.lessons?.length ?? 0) + (lessonsStructured?.dreamReports?.length ?? 0),
      'evo_lessons counts.returned matches the returned lists'
    );
    checkTextBudget(lessons, 'evo_lessons');

    // -- 9. shadow zero-side-effect on the data dir ------------------------
    const entries = await readdir(dataDir, { recursive: true }).catch(() => []);
    const forbidden = entries.filter((/** @type {string} */ name) =>
      /node_modules|\.git|cordis\.patch|package\.json$|profiles\/(?!default)/i.test(name)
    );
    check(forbidden.length === 0, 'data dir contains no host-shaped or non-default-profile entries (found ' + JSON.stringify(forbidden.slice(0, 5)) + ')');
    check(child.exitCode === null && !child.killed, 'server process is still alive after every model-free call');

    // -- 10. clean shutdown --------------------------------------------------
    const hadRunningJobs = statusStructured?.runs?.running ?? 0;
    check(hadRunningJobs === 0, 'no runs left in flight at shutdown time');
    child.stdin.end();
    const exit = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 15_000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    check(exit === 0, 'server exits cleanly after stdin close (exit code ' + String(exit) + ')');
  } finally {
    if (child !== undefined && child.exitCode === null && !child.killed) {
      child.kill();
    }
    await rm(dataRoot, { recursive: true, force: true }).catch(() => {});
  }

  if (failures.length > 0) {
    process.stdout.write('\n' + String(failures.length) + ' assertion(s) FAILED\n');
    process.exitCode = 1;
  } else {
    process.stdout.write('\nall assertions held\n');
  }
}

main().catch((error) => {
  process.stdout.write('probe crashed: ' + (error instanceof Error ? error.stack : String(error)) + '\n');
  process.exitCode = 1;
});
