/**
 * rev8 boundary fix 1 — the SERVER-layer env→adapter propagation test (the
 * second-round review's nice-to-have).
 *
 * WHAT WAS UNTESTED BEFORE: tests/unit/mcp/openai-model-adapter.test.ts covers
 * the adapter's OWN env reading (EVO_GATEWAY_KEY / key file), but nothing
 * proved that createEvoMcpServer actually hands the deployment's
 * EVO_MODEL_BASE_URL / EVO_MODEL_ID to the PRODUCTION adapter. This file
 * closes that gap at the server boundary with a FETCH STUB — no network, no
 * gateway, no key file: the key comes from the injected env map itself.
 *
 * Covered:
 *   1. createEvoMcpServer({env}) + the production adapter (no `model`
 *      override) sends the env's base URL and model id on the run's proposal
 *      call — the env block of the deployed template (plan §5.5) is LIVE
 *      configuration.
 *   2. The default branch: with both envs absent, the stub sees the
 *      adapter's documented defaults (DEFAULT_OPENAI_BASE_URL /
 *      DEFAULT_OPENAI_MODEL_ID).
 *   3. The set-but-empty branch: an empty string falls back to the default
 *      AND produces the non-secret warning (the envNonEmpty branch) — the
 *      config mistake is visible, never silent.
 *
 * The run is driven through the server's OWN tool surface over an
 * InMemoryTransport pair (the handshake suite's pattern), so the adapter
 * under test is exactly the one the run path uses.
 *
 * OFFLINE: fetch is a recorded stub; env is an injected map; the data dir is
 * a persistence-fixture temp dir. No DSH, no gateway, no real key.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/server';

import { createEvoMcpServer, EVO_MODEL_BASE_URL_ENV, EVO_MODEL_ID_ENV } from '../../../src/mcp/server';
import {
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL_ID,
  EVO_GATEWAY_KEY_ENV
} from '../../../src/mcp/openai-model-adapter';
import { cleanupDir, makeTempDir } from '../persistence/fixtures';

interface RecordedCall {
  readonly url: string;
  readonly model: unknown;
}

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await cleanupDir(dir).catch(() => {});
  }
});

function okResponse(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: 'stub', finish_reason: 'stop' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

/** A recorded fetch stub returning one trivial OpenAI 200 per call. */
function fetchStub(): { calls: RecordedCall[]; fetch: typeof fetch } {
  const calls: RecordedCall[] = [];
  const stub = (async (url: string | URL | Request, init?: RequestInit) => {
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    let model: unknown = undefined;
    try {
      model = (JSON.parse(bodyText) as { model?: unknown }).model;
    } catch {
      model = undefined;
    }
    calls.push({ url: String(url), model });
    return okResponse();
  }) as typeof fetch;
  return { calls, fetch: stub };
}

/** The cheap 1x1 run config (same shape the e2e suite scripts). */
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

/** Raw JSON-RPC client over the linked InMemory pair (handshake suite shape). */
async function connectClient(
  server: ReturnType<typeof createEvoMcpServer>['server']
): Promise<{
  call: (method: string, params?: Record<string, unknown>) => Promise<any>;
}> {
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
    call: (method, params) => {
      seq += 1;
      const id = seq;
      return new Promise<any>((resolve) => {
        pending.set(id, resolve);
        void clientTransport.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
      });
    }
  };
}

async function handshaken(
  options: {
    env: Record<string, string | undefined>;
    fetch: typeof fetch;
    log?: (line: string) => void;
  }
): Promise<{ instance: ReturnType<typeof createEvoMcpServer>; client: Awaited<ReturnType<typeof connectClient>> }> {
  const dataDir = await makeTempDir('mcp-server-env');
  tempDirs.push(dataDir);
  const instance = createEvoMcpServer({
    env: options.env,
    fetch: options.fetch,
    ...(options.log === undefined ? {} : { log: options.log }),
    assembly: {
      config: cheapConfig(),
      dataDir: { dataDir, env: { EVO_HARNESS_DATA_DIR: undefined, DSH_DATA_DIR: undefined, DSH_PROFILE: undefined } }
    }
  });
  const client = await connectClient(instance.server);
  await client.call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'vitest-env', version: '0.0.0' }
  });
  await client.call('notifications/initialized', {});
  return { instance, client };
}

function payload(reply: any): Record<string, any> {
  expect(reply.error).toBeUndefined();
  expect(reply.result?.isError).toBeFalsy();
  return reply.result.structuredContent;
}

/** Submit one run and wait until the book settles it; returns the runId. */
async function runOne(
  instance: ReturnType<typeof createEvoMcpServer>,
  client: Awaited<ReturnType<typeof connectClient>>
): Promise<string> {
  const submitted = await client.call('tools/call', {
    name: 'evo_run_submit',
    arguments: { prompt: 'Env propagation probe.', sessionId: 'sess-env' }
  });
  const runId: string = payload(submitted).payload.runId;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (instance.pollJob(runId).status !== 'running') {
      return runId;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('run ' + runId + ' never settled');
}

describe('server env → production adapter propagation (rev8 boundary fix 1)', () => {
  it('routes EVO_MODEL_BASE_URL / EVO_MODEL_ID from the injected env into the run proposal call', async () => {
    const { calls, fetch } = fetchStub();
    const { instance, client } = await handshaken({
      env: {
        [EVO_MODEL_BASE_URL_ENV]: 'http://127.0.0.1:9999/v7',
        [EVO_MODEL_ID_ENV]: 'prov/model-x',
        [EVO_GATEWAY_KEY_ENV]: 'test-key-not-real'
      },
      fetch
    });
    try {
      const runId = await runOne(instance, client);
      const snapshot = instance.pollJob(runId);
      // The run settled (whatever the stub proposal made of it) and the
      // adapter really saw traffic from the proposer.
      expect(['complete', 'failed']).toContain(snapshot.status);
      expect(calls.length).toBeGreaterThan(0);
      // THE env PROPAGATION PROOF: every adapter call went to the env's base
      // URL carrying the env's model id — not the defaults.
      for (const call of calls) {
        expect(call.url).toBe('http://127.0.0.1:9999/v7/chat/completions');
        expect(call.model).toBe('prov/model-x');
      }
    } finally {
      await instance.dispose().catch(() => {});
    }
  });

  it('falls back to the documented defaults when both envs are absent', async () => {
    const { calls, fetch } = fetchStub();
    const { instance, client } = await handshaken({
      env: { [EVO_GATEWAY_KEY_ENV]: 'test-key-not-real' },
      fetch
    });
    try {
      const runId = await runOne(instance, client);
      expect(['complete', 'failed']).toContain(instance.pollJob(runId).status);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.url).toBe(DEFAULT_OPENAI_BASE_URL + '/chat/completions');
        expect(call.model).toBe(DEFAULT_OPENAI_MODEL_ID);
      }
    } finally {
      await instance.dispose().catch(() => {});
    }
  });

  it('a SET-BUT-EMPTY env value falls back to the default AND logs the non-secret warning', async () => {
    const { calls, fetch } = fetchStub();
    const logs: string[] = [];
    const { instance, client } = await handshaken({
      env: {
        [EVO_MODEL_BASE_URL_ENV]: '',
        [EVO_MODEL_ID_ENV]: '',
        [EVO_GATEWAY_KEY_ENV]: 'test-key-not-real'
      },
      fetch,
      log: (line) => logs.push(line)
    });
    try {
      const runId = await runOne(instance, client);
      expect(['complete', 'failed']).toContain(instance.pollJob(runId).status);
      expect(calls.length).toBeGreaterThan(0);
      // The empty strings fell back to the adapter defaults (never an empty
      // base URL or model id on the wire).
      for (const call of calls) {
        expect(call.url).toBe(DEFAULT_OPENAI_BASE_URL + '/chat/completions');
        expect(call.model).toBe(DEFAULT_OPENAI_MODEL_ID);
      }
      // The mistake is VISIBLE: one warning per empty variable, non-secret.
      const warnings = logs.filter((line) => line.includes('is set but empty'));
      expect(warnings).toHaveLength(2);
      expect(warnings.some((line) => line.includes(EVO_MODEL_BASE_URL_ENV))).toBe(true);
      expect(warnings.some((line) => line.includes(EVO_MODEL_ID_ENV))).toBe(true);
      for (const line of warnings) {
        expect(line).not.toContain('test-key-not-real');
      }
    } finally {
      await instance.dispose().catch(() => {});
    }
  });
});
