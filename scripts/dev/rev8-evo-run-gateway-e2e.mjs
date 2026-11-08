#!/usr/bin/env node
/**
 * rev8 deployment-stage gateway e2e: ONE minimal-budget evo_run_submit/poll
 * against the REAL 127.0.0.1:8326 OpenAI-compatible gateway, driven through
 * the DEPLOYED stdio server (same entry + env block the desktop patch uses).
 *
 * Boundaries (mirrors the ask):
 *   - The key file named by EVO_GATEWAY_KEY_FILE is resolved lazily by the
 *     SERVER process only; this runner never opens, reads, or prints it.
 *   - No prompt, payload, or model output is echoed into the report; the
 *     record carries counts, stage names, three-state verdict surface and
 *     usage NUMBERS only (adapter usage lines are numbers).
 *   - At most one submit; polls only. No retry loop, no budget enlargement.
 *
 * Usage:
 *   node scripts/dev/rev8-evo-run-gateway-e2e.mjs \
 *     --entry 'E:/DS/插件/dsh-plugin-evo-harness-mcp/lib/mcp/server.js' \
 *     --out work/rev8-mcp/gateway-e2e-result.json
 * Exit 0 iff the run reached status 'complete'. Any other terminal state or
 * error exits 1 with the honest record written.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

const args = process.argv.slice(2);
const opt = { wallMs: 480_000 };
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--entry') opt.entry = args[++i];
  else if (args[i] === '--out') opt.out = args[++i];
  else if (args[i] === '--wall-ms') opt.wallMs = Number(args[++i]);
  else if (args[i] === '--data-dir') opt.dataDir = args[++i];
  else throw new Error('unknown argument: ' + args[i]);
}
if (!opt.entry) throw new Error('--entry is required (the DEPLOYED server entry)');
if (!Number.isFinite(opt.wallMs) || opt.wallMs < 10_000) throw new Error('--wall-ms must be >= 10000');

// The deployment env block (identical values to the desktop patch entry).
// EVO_GATEWAY_KEY_FILE is a PATH; its contents are never read here.
const DEPLOY_ENV = {
  EVO_HARNESS_DATA_DIR: opt.dataDir ?? 'C:/Users/Administrator/.dsh/evo-harness-mcp',
  EVO_GATEWAY_KEY_FILE: 'C:/Users/Administrator/.dsh/openai-gateway/api-key',
  EVO_MODEL_BASE_URL: 'http://127.0.0.1:8326/v1',
  EVO_MODEL_ID: 'magpie/auto/glm-5.3-flash'
};

// Minimal task text: no secrets, no host paths; the deliverable is a short JSON.
const PROMPT =
  'Return exactly one JSON object and nothing else: {"task":"rev8-gateway-e2e","answer":"ok"}';

const report = {
  schemaVersion: 1,
  capturedAt: new Date().toISOString(),
  entry: opt.entry,
  dataDir: DEPLOY_ENV.EVO_HARNESS_DATA_DIR,
  modelBaseUrl: DEPLOY_ENV.EVO_MODEL_BASE_URL,
  modelId: DEPLOY_ENV.EVO_MODEL_ID,
  budgetOverride: { maxWidth: 1, maxDepth: 1, maxOnlineRolloutBudget: 1 },
  submit: { ok: false },
  polls: { count: 0, lastStatus: null },
  result: null,
  statusSurface: null,
  adapterUsageLines: [],
  serverLogLines: [],
  wallMs: null,
  failure: null
};

const startedAt = Date.now();
const deadline = startedAt + opt.wallMs;
const clip = (text, n) => String(text).replace(/[\r\n]+/g, ' ').slice(0, n);

const child = spawn(process.execPath, [opt.entry], {
  cwd: path.dirname(opt.entry),
  env: {
    PATH: process.env.PATH ?? '',
    SystemRoot: process.env.SystemRoot ?? '',
    ...DEPLOY_ENV
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true
});

const pending = new Map();
let nextId = 1;
let stdoutBuf = '';
child.stdout.on('data', (chunk) => {
  stdoutBuf += String(chunk);
  let nl = stdoutBuf.indexOf('\n');
  while (nl >= 0) {
    const line = stdoutBuf.slice(0, nl).trim();
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (line.length > 0) {
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined && pending.has(message.id)) {
          const resolve = pending.get(message.id);
          pending.delete(message.id);
          resolve(message);
        }
      } catch {
        /* a non-JSON stdout line is protocol noise; never echoed to the report */
      }
    }
    nl = stdoutBuf.indexOf('\n');
  }
});
child.stderr.on('data', (chunk) => {
  for (const line of String(chunk).split('\n')) {
    const text = line.trim();
    if (text.length === 0) continue;
    // Adapter usage lines carry ONLY numbers; every [evo-mcp] line is a
    // non-secret server/adapter diagnostic by construction (server.ts).
    if (/usage\(prompt=\d+ completion=\d+ total=\d+\)/.test(text)) {
      report.adapterUsageLines.push(clip(text, 300));
    } else if (text.startsWith('[evo-mcp]')) {
      if (report.serverLogLines.length < 80) report.serverLogLines.push(clip(text, 300));
    }
  }
});

const request = (method, params, timeoutMs = 120_000) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('request timed out: ' + method));
      }
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function toolPayload(reply) {
  if (reply?.error !== undefined) throw new Error('jsonrpc error: ' + clip(JSON.stringify(reply.error), 300));
  if (reply?.result?.isError === true) {
    const text = reply?.result?.content?.map((block) => block?.text ?? '').join(' ') ?? '';
    throw new Error('tool error result: ' + clip(text, 300));
  }
  return reply?.result?.structuredContent;
}

let exitCode = 1;
try {
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'rev8-gateway-e2e', version: '0.1.0' }
  }, 30_000);
  if (init?.error !== undefined) throw new Error('initialize failed: ' + clip(JSON.stringify(init.error), 200));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const status = toolPayload(await request('tools/call', { name: 'evo_status', arguments: {} }, 60_000))?.payload;
  report.statusSurface = {
    executionMode: status?.execution?.mode ?? null,
    applyWinningPatch: status?.execution?.applyWinningPatch ?? null,
    dataDir: status?.dataDir ?? null
  };

  const submitted = toolPayload(await request('tools/call', {
    name: 'evo_run_submit',
    arguments: {
      prompt: PROMPT,
      budgetOverride: { ...report.budgetOverride }
    }
  }, 60_000))?.payload;
  report.submit = {
    ok: submitted?.runId !== undefined && submitted?.status === 'started',
    runId: submitted?.runId ?? null,
    status: submitted?.status ?? null,
    pollAfterMs: submitted?.pollAfterMs ?? null
  };
  if (!report.submit.ok) throw new Error('submit did not return {runId, status:"started"}');

  const pollAfterMs = Math.max(250, Number(report.submit.pollAfterMs) || 1000);
  let lastPayload;
  while (Date.now() < deadline) {
    await sleep(pollAfterMs);
    lastPayload = toolPayload(await request('tools/call', { name: 'evo_run_poll', arguments: { runId: report.submit.runId } }, 120_000))?.payload;
    report.polls.count += 1;
    report.polls.lastStatus = lastPayload?.status ?? null;
    if (['complete', 'failed', 'timeout', 'cancelled'].includes(report.polls.lastStatus)) break;
  }
  if (!['complete', 'failed', 'timeout', 'cancelled'].includes(report.polls.lastStatus)) {
    throw new Error('poll budget exhausted at wall ' + opt.wallMs + 'ms; last status=' + String(report.polls.lastStatus));
  }

  const result = lastPayload?.result;
  report.result = result === undefined ? null : {
    outcome: result.outcome ?? null,
    probesRun: result.probesRun ?? null,
    lessonsCommitted: result.lessonsCommitted ?? null,
    stopReason: result.metadata?.stopReason ?? null,
    rounds: result.metadata?.rounds ?? null,
    lifecycleStages: Array.isArray(result.metadata?.lifecycle)
      ? result.metadata.lifecycle.map((stage) => (typeof stage?.stage === 'string' ? stage.stage : clip(JSON.stringify(stage), 40)))
      : null,
    diagnosticsCount: Array.isArray(result.diagnostics) ? result.diagnostics.length : null,
    diagnosticsHead: Array.isArray(result.diagnostics) ? result.diagnostics.slice(0, 6).map((line) => clip(line, 220)) : null,
    failure: result.failure ?? null,
    startedAt: result.startedAt ?? null,
    endedAt: result.endedAt ?? null,
    durationMs: Number.isFinite(result.startedAt) && Number.isFinite(result.endedAt) ? result.endedAt - result.startedAt : null
  };

  // Three-state verdict surface after settlement (status reads the run record;
  // the run result never rewrites an ungraded/not-evaluable verdict into a zero).
  const statusAfter = toolPayload(await request('tools/call', { name: 'evo_status', arguments: {} }, 60_000))?.payload;
  const lastRun = statusAfter?.lastRun ?? statusAfter?.run ?? null;
  report.statusSurface.lastRunStatus = lastRun?.status ?? lastRun?.outcome ?? null;

  exitCode = report.polls.lastStatus === 'complete' ? 0 : 1;
} catch (error) {
  report.failure = error instanceof Error ? clip(error.message, 400) : clip(String(error), 400);
  exitCode = 1;
} finally {
  report.wallMs = Date.now() - startedAt;
  try { child.stdin.end(); } catch { /* stdin already closed */ }
  const reapAt = Date.now();
  while (child.exitCode === null && Date.now() - reapAt < 10_000) {
    await sleep(200);
  }
  if (child.exitCode === null) {
    child.kill();
    report.serverLogLines.push('[runner] server did not exit within 10s of stdin close; killed');
  }
  const serialized = JSON.stringify(report, null, 2) + '\n';
  if (opt.out) {
    const outPath = path.resolve(REPO_ROOT, opt.out);
    if (fs.existsSync(outPath)) throw new Error('refusing to overwrite existing result: ' + outPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, serialized, { encoding: 'utf8', flag: 'wx' });
  }
  process.stdout.write(serialized);
  process.exitCode = exitCode;
}
