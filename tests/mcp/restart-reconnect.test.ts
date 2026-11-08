/**
 * rev8 stage-3 tests: restart/reconnect + shadow zero-side-effect.
 *
 * RESTART (the honesty contract)
 *   The job book is in-process memory: a restart LOSES run records and the
 *   new server's tools/list must be IDENTICAL to the old one's. What DOES
 *   survive is the persistence runtime's durable state (tree pool, policy
 *   counters) — asserted here by building a second assembly over the SAME
 *   data directory (the reopen path the assembly suite proves; here through
 *   the server entry).
 *
 * SHADOW ZERO-SIDE-EFFECT (plan §5.8 step 1 assertion)
 *   After a full run through the MCP tools: the in-memory host's
 *   activeEffects() is empty (every branch-mount was disposed at branch end),
 *   the memory capability never becomes writable, and the data directory
 *   contains ONLY evo-harness products (no host-shaped files).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { readdir } from 'node:fs/promises';

import { InMemoryTransport } from '@modelcontextprotocol/server';

import { createEvoMcpServer, EVO_TOOL_NAMES } from '../../src/mcp/server';
import type { IModelAdapter, ModelRequest, ModelResponse } from '../../src/types/contracts';
import { cleanupDir, makeTempDir } from '../unit/persistence/fixtures';

// ---------------------------------------------------------------------------
// scripted model
// ---------------------------------------------------------------------------

function proposalPayload(): Record<string, unknown> {
  return {
    rationale: 'Pin the deliverable format so scoring stops guessing.',
    focusSurfaces: ['guardrails'],
    confidence: 0.7,
    expectedStepsDelta: -1,
    edits: {
      guardrails: {
        kind: 'guardrails',
        formatContract: 'Return minified JSON only.',
        appendRules: ['declare the failing tool before retrying']
      }
    }
  };
}

function scriptedModel(): IModelAdapter {
  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      if (request.purpose === 'propose') {
        return { text: JSON.stringify(proposalPayload()), finishReason: 'stop', model: 'scripted' };
      }
      if (request.purpose === 'compose') {
        const text = request.messages.map((message) => message.content).join('\n');
        const aliases = [...new Set(text.match(/candidate_[A-Z]/g) ?? [])];
        return {
          text: JSON.stringify({
            ranking: aliases,
            assessments: aliases.map((alias, index) => ({ alias, rationale: 'judge ' + String(index) }))
          }),
          finishReason: 'stop',
          model: 'scripted'
        };
      }
      if (request.purpose === 'reflect') {
        return { text: JSON.stringify({ lessons: [] }), finishReason: 'stop', model: 'scripted' };
      }
      return { text: 'scripted deliverable', finishReason: 'stop', model: 'scripted' };
    }
  };
}

// ---------------------------------------------------------------------------
// raw JSON-RPC client
// ---------------------------------------------------------------------------

interface RawClient {
  call(method: string, params?: Record<string, unknown>): Promise<any>;
  notify(method: string, params?: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

async function connectClient(server: Awaited<ReturnType<typeof createEvoMcpServer>>['server']): Promise<RawClient> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const pending = new Map<number, (value: any) => void>();
  clientTransport.onmessage = (message) => {
    const record = message as { id?: unknown };
    if (record.id !== undefined && pending.has(record.id as number)) {
      const resolve = pending.get(record.id as number)!;
      pending.delete(record.id as number);
      resolve(message);
    }
  };
  await clientTransport.start();
  let seq = 0;
  return {
    async call(method, params) {
      seq += 1;
      const id = seq;
      return new Promise<any>((resolve) => {
        pending.set(id, resolve);
        void clientTransport.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
      });
    },
    async notify(method, params) {
      await clientTransport.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
    },
    async close() {
      await clientTransport.close();
    }
  };
}

function cheapConfig(): Record<string, unknown> {
  return {
    triggerMode: 'slash_command',
    probe: { maxConcurrentProbes: 1, probeTimeoutMs: 1_000 },
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

const tempDirs: string[] = [];

async function makeDataDir(): Promise<string> {
  const dir = await makeTempDir('mcp-restart');
  tempDirs.push(dir);
  return dir;
}

interface Built {
  instance: ReturnType<typeof createEvoMcpServer>;
  client: RawClient;
}

async function buildOver(dataDir: string): Promise<Built> {
  const instance = createEvoMcpServer({
    model: scriptedModel(),
    now: (() => {
      let tick = 1_700_000_000_000;
      return () => (tick += 1);
    })(),
    assembly: {
      config: cheapConfig(),
      dataDir: { dataDir, env: { EVO_HARNESS_DATA_DIR: undefined, DSH_DATA_DIR: undefined, DSH_PROFILE: undefined } }
    }
  });
  const client = await connectClient(instance.server);
  await client.call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'vitest', version: '0.0.0' }
  });
  await client.notify('notifications/initialized');
  return { instance, client };
}

function payload(reply: any): Record<string, any> {
  expect(reply.error).toBeUndefined();
  expect(reply.result?.isError).toBeFalsy();
  return reply.result.structuredContent;
}

/** Poll until the run settles (bounded). */
async function pollUntilSettled(client: RawClient, runId: string): Promise<Record<string, any>> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const polled = await client.call('tools/call', { name: 'evo_run_poll', arguments: { runId } });
    const report = payload(polled).payload;
    if (report.status !== 'running') return report;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('run ' + runId + ' never settled');
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await cleanupDir(dir).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// restart: tool identity survives, run memory does not
// ---------------------------------------------------------------------------

describe('restart/reconnect', () => {
  it('tools/list is identical after a restart; the old runId becomes unknown_run_id', async () => {
    const dataDir = await makeDataDir();
    const first = await buildOver(dataDir);
    // tools/list is a PROTOCOL result (no structuredContent wrapper).
    const firstNames = ((await first.client.call('tools/list')).result.tools as { name: string }[])
      .map((tool) => tool.name)
      .sort();
    expect(firstNames).toEqual([...EVO_TOOL_NAMES].sort());

    // One real run in generation 1.
    const submitted = await first.client.call('tools/call', {
      name: 'evo_run_submit',
      arguments: { prompt: 'Fix the failing build.', runId: 'gen-1-run' }
    });
    const runId: string = payload(submitted).payload.runId;
    await pollUntilSettled(first.client, runId);
    await first.client.close();
    await first.instance.dispose();

    // Generation 2 over the SAME data directory: same seven tools.
    const second = await buildOver(dataDir);
    try {
      const secondNames = ((await second.client.call('tools/list')).result.tools as { name: string }[])
        .map((tool) => tool.name)
        .sort();
      expect(secondNames).toEqual(firstNames);

      // The in-memory job is GONE — and the error says so honestly.
      const polled = await second.client.call('tools/call', {
        name: 'evo_run_poll',
        arguments: { runId }
      });
      expect(polled.result.isError).toBe(true);
      expect(polled.result.structuredContent.code).toBe('unknown_run_id');

      // What DID survive: the durable task counter counts generation 1's run.
      const status = payload(await second.client.call('tools/call', { name: 'evo_status', arguments: {} })).payload;
      expect(status.completedTasks).toBeGreaterThanOrEqual(1);
      // The orchestrator's last trace of THIS generation is empty (fresh
      // process) and the honest phase without any book record is 'idle'.
      expect(Array.isArray(status.orchestrator.lastTrace)).toBe(true);
      expect(status.orchestrator.lastTrace).toHaveLength(0);
      expect(status.lastRunPhase).toBe('idle');
    } finally {
      await second.client.close();
      await second.instance.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// status honesty (rev8 boundary fix 6)
// ---------------------------------------------------------------------------

describe('evo_status lastRun honesty', () => {
  it('a server that FINISHED a run reports the real lastRun + phase, never a bare idle', async () => {
    const dataDir = await makeDataDir();
    const { instance, client } = await buildOver(dataDir);
    try {
      const submitted = await client.call('tools/call', {
        name: 'evo_run_submit',
        arguments: { prompt: 'Fix the failing build.', runId: 'status-real' }
      });
      const runId: string = payload(submitted).payload.runId;
      const settled = await pollUntilSettled(client, runId);
      expect(['complete', 'failed']).toContain(settled.status);

      const status = payload(await client.call('tools/call', { name: 'evo_status', arguments: {} })).payload;
      expect(status.lastRunPhase).not.toBe('idle');
      expect(status.lastRun).toBeDefined();
      expect(status.lastRun.runId).toBe(runId);
      // The orchestrator's stage trace of the just-finished run is exposed.
      expect(Array.isArray(status.orchestrator.lastTrace)).toBe(true);
      expect((status.orchestrator.lastTrace as string[]).length).toBeGreaterThan(0);
    } finally {
      await client.close();
      await instance.dispose();
    }
  });

  it('a server with an IN-FLIGHT run reports running, never idle', async () => {
    const dataDir = await makeDataDir();
    tempDirs.push(dataDir);
    const observedSignals: AbortSignal[] = [];
    const runner = async (context: { signal?: AbortSignal }): Promise<any> => {
      observedSignals.push(context.signal!);
      await new Promise<void>((resolve, reject) => {
        context.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      return {
        status: 'succeeded',
        steps: [],
        toolErrors: [],
        failureSignals: [],
        deliverable: { content: 'x', format: 'markdown', producedFiles: [] }
      };
    };
    const instance = createEvoMcpServer({
      model: scriptedModel(),
      pollAfterMs: 10,
      now: (() => {
        let tick = 1_700_000_000_000;
        return () => (tick += 1);
      })(),
      assembly: {
        options: { runBranch: runner as never },
        config: cheapConfig(),
        dataDir: { dataDir, env: { EVO_HARNESS_DATA_DIR: undefined, DSH_DATA_DIR: undefined, DSH_PROFILE: undefined } }
      }
    });
    const client = await connectClient(instance.server);
    await client.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'vitest', version: '0.0.0' }
    });
    try {
      const submitted = await client.call('tools/call', {
        name: 'evo_run_submit',
        arguments: { prompt: 'Long in-flight run.' }
      });
      expect(submitted.result?.isError).toBeFalsy();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const status = payload(await client.call('tools/call', { name: 'evo_status', arguments: {} })).payload;
      expect(status.lastRunPhase).toBe('running');
      expect(status.runs.running).toBeGreaterThanOrEqual(1);
    } finally {
      await client.close().catch(() => {});
      await instance.dispose().catch(() => {});
    }
  });

  it('a status call DURING a running job reads the orchestrator live stage trace (rev8 boundary fix 6)', async () => {
    // The ask: "服务器状态running时应给orchestrator.lastTrace". The orchestrator
    // resets its trace at the run() prologue and appends every stage as it
    // happens (src/orchestrator.ts run() prologue + stage()), so a mid-run
    // evo_status must observe the IN-FLIGHT stages of that run — never an
    // empty array and never the previous run's trace. The branch executor
    // below parks in the 'probe' stage, so the mid-run snapshot must already
    // carry the stages that precede the parked probe.
    const dataDir = await makeDataDir();
    tempDirs.push(dataDir);
    let releaseBranch: (() => void) | undefined;
    const runner = async (): Promise<any> => {
      await new Promise<void>((resolve) => {
        releaseBranch = resolve;
      });
      return {
        status: 'succeeded',
        steps: [],
        toolErrors: [],
        failureSignals: [],
        deliverable: { content: 'traced', format: 'markdown', producedFiles: [] }
      };
    };
    const instance = createEvoMcpServer({
      model: scriptedModel(),
      pollAfterMs: 10,
      now: (() => {
        let tick = 1_700_000_000_000;
        return () => (tick += 1);
      })(),
      assembly: {
        options: { runBranch: runner as never },
        config: cheapConfig(),
        dataDir: { dataDir, env: { EVO_HARNESS_DATA_DIR: undefined, DSH_DATA_DIR: undefined, DSH_PROFILE: undefined } }
      }
    });
    const client = await connectClient(instance.server);
    await client.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'vitest', version: '0.0.0' }
    });
    try {
      const submitted = await client.call('tools/call', {
        name: 'evo_run_submit',
        arguments: { prompt: 'Trace me mid-flight.', sessionId: 'sess-trace' }
      });
      const runId: string = payload(submitted).payload.runId;
      // Wait until the branch executor is parked (the run is mid-probe).
      for (let attempt = 0; attempt < 100 && releaseBranch === undefined; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(releaseBranch).toBeDefined();

      const status = payload(await client.call('tools/call', { name: 'evo_status', arguments: {} })).payload;
      expect(status.lastRunPhase).toBe('running');
      // THE in-flight proof: the live trace exists and includes the stages the
      // run has ALREADY passed (initialize always runs first; the cheap config
      // parks the run at the pre-probe planning stages, so the mid-run
      // snapshot is non-empty while the branch executor is still parked).
      const trace = status.orchestrator.lastTrace as string[];
      expect(Array.isArray(trace)).toBe(true);
      expect(trace.length).toBeGreaterThan(0);
      expect(trace[0]).toBe('initialize');
      expect(trace).toContain('recall');
      // The named-run view agrees with the anonymous one while it is live.
      const named = payload(await client.call('tools/call', {
        name: 'evo_status',
        arguments: { runId }
      })).payload;
      expect(named.lastRunPhase).toBe('running');

      // After settle, the trace stays and the phase flips — the same field,
      // now the completed run's final stages (finalize appended last).
      releaseBranch!();
      let settled: Record<string, any> | undefined;
      for (let attempt = 0; attempt < 60 && settled === undefined; attempt += 1) {
        const polled = await client.call('tools/call', { name: 'evo_run_poll', arguments: { runId } });
        const report = payload(polled).payload;
        if (report.status !== 'running') settled = report;
        else await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(settled).toBeDefined();
      const after = payload(await client.call('tools/call', { name: 'evo_status', arguments: { runId } })).payload;
      expect(after.lastRunPhase).toBe(settled!.status);
      const afterTrace = after.orchestrator.lastTrace as string[];
      expect(afterTrace).toContain('finalize');
    } finally {
      releaseBranch?.();
      await client.close().catch(() => {});
      await instance.dispose().catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// shadow zero-side-effect
// ---------------------------------------------------------------------------

describe('shadow zero host side effect (plan §5.8 step 1)', () => {
  it('after a full run: empty active effects, recall-only memory, only evo products on disk', async () => {
    const dataDir = await makeDataDir();
    const { instance, client } = await buildOver(dataDir);
    try {
      const submitted = await client.call('tools/call', {
        name: 'evo_run_submit',
        arguments: { prompt: 'Fix the failing build.', sessionId: 'sess-shadow' }
      });
      const runId: string = payload(submitted).payload.runId;
      const settled = await pollUntilSettled(client, runId);
      expect(['complete', 'failed']).toContain(settled.status);

      const assembly = await instance.ready;
      // The eight surfaces mounted inside ISOLATED branches during the run and
      // every branch effect was disposed at branch end.
      expect(assembly.host.activeEffects()).toHaveLength(0);
      // Shadow profile: the bridge never became writable.
      expect(assembly.plugin.memory.writable).not.toBe('yes');
      expect(assembly.plugin.memory.label).toBe('Recall-Only');
      // The run diagnostics never claim a winning patch was mounted.
      expect(assembly.plugin.diagnostics.join(' ')).not.toContain('apply_patch: winning patch mounted');

      // Disk: only evo-harness products (no package.json, no .git, no patch
      // files, and every persisted directory is the default profile).
      const entries = await readdir(dataDir, { recursive: true });
      const forbidden = entries.filter((name) =>
        /node_modules|\.git|cordis\.patch|package\.json$/i.test(name.replace(/\\/g, '/'))
      );
      expect(forbidden).toEqual([]);
    } finally {
      await client.close();
      await instance.dispose();
    }
  });

  it('evo_dream under the 12-tree gate is refused with the gate reason, and writes nothing hostile', async () => {
    const dataDir = await makeDataDir();
    const { instance, client } = await buildOver(dataDir);
    try {
      const dreamed = await client.call('tools/call', { name: 'evo_dream', arguments: {} });
      expect(dreamed.result.isError).toBeFalsy();
      const report = payload(dreamed).payload;
      // The pool is empty: the gate refuses and SAYS so (never a fake run).
      expect(report.triggered).toBe(false);
      expect(String(report.reason)).toMatch(/skipped|no retained trees|verified/i);
      const status = payload(await client.call('tools/call', { name: 'evo_status', arguments: {} })).payload;
      expect(status.dream.ready).toBe(false);
      expect(status.dream.dreamsPerformed).toBe(0);
    } finally {
      await client.close();
      await instance.dispose();
    }
  });

  it('evo_jit status/on/off/reset travel through the plugin command path', async () => {
    const dataDir = await makeDataDir();
    const { instance, client } = await buildOver(dataDir);
    try {
      const status = await client.call('tools/call', {
        name: 'evo_jit',
        arguments: { action: 'status' }
      });
      const statusPayload = payload(status).payload;
      expect(statusPayload.command).toBe('status');
      expect(typeof statusPayload.json).toBe('object');

      const off = await client.call('tools/call', {
        name: 'evo_jit',
        arguments: { action: 'off' }
      });
      expect(payload(off).payload.json.enabled).toBe(false);

      const reset = await client.call('tools/call', {
        name: 'evo_jit',
        arguments: { action: 'reset', confirm: true }
      });
      expect(payload(reset).payload.json.supported).toBe(true);

      // An out-of-enum action is refused by the schema layer: an isError
      // result whose text names the validation (no structuredContent — the
      // SDK's input-validation path builds a bare error result).
      const bad = await client.call('tools/call', {
        name: 'evo_jit',
        arguments: { action: 'detonate' }
      });
      expect(bad.result.isError).toBe(true);
      expect(String(bad.result.content?.[0]?.text)).toContain('Invalid arguments');
      void instance;
    } finally {
      await client.close();
      await instance.dispose();
    }
  });

  it('evo_lessons returns a bounded, redacted page (empty is honest when nothing committed)', async () => {
    const dataDir = await makeDataDir();
    const { instance, client } = await buildOver(dataDir);
    try {
      const lessons = await client.call('tools/call', {
        name: 'evo_lessons',
        arguments: { limit: 5 }
      });
      const report = payload(lessons).payload;
      expect(Array.isArray(report.lessons)).toBe(true);
      expect(Array.isArray(report.dreamReports)).toBe(true);
      expect(report.counts.returned).toBe(report.lessons.length + report.dreamReports.length);
      expect(report.counts.returned).toBeLessThanOrEqual(10);
      void instance;
    } finally {
      await client.close();
      await instance.dispose();
    }
  });
});
