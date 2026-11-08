/**
 * rev8 stage-3 tests: the MCP stdio server (src/mcp/server.ts).
 *
 * Fully offline and deterministic: the model is a scripted adapter, the data
 * directory is a fresh temp dir under work/persistence-tmp (gitignored), and
 * the wire is the SDK's InMemoryTransport pair driven by a hand-rolled raw
 * JSON-RPC client — the SAME handshake a real stdio client speaks, without
 * spawning a process. The real stdio subprocess path is exercised separately
 * by scripts/dev/mcp-probe.mjs (assertion counts grow with the probe; that
 * script's own "all assertions held" footer is the claim to trust, not a
 * number frozen here).
 *
 * This file covers the HANDSHAKE + tools/list contract:
 *   - initialize at protocol 2025-06-18 negotiates and reports the 'evo'
 *     identity plus instructions;
 *   - notifications/initialized is accepted;
 *   - tools/list returns EXACTLY the seven evo_* tools, each with an object
 *     inputSchema, and the evo_jit action enum is restricted;
 *   - tools/call on evo_status succeeds with zero host side effects.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { InMemoryTransport } from '@modelcontextprotocol/server';

import {
  createEvoMcpServer,
  EVO_MCP_INSTRUCTIONS,
  EVO_MCP_SERVER_NAME,
  EVO_TOOL_NAMES
} from '../../src/mcp/server';
import type { IModelAdapter, ModelRequest, ModelResponse } from '../../src/types/contracts';
import { cleanupDir, makeTempDir } from '../unit/persistence/fixtures';

// ---------------------------------------------------------------------------
// deterministic scripted model (same shape as the unit/mcp suites)
// ---------------------------------------------------------------------------

function proposalPayload(): Record<string, unknown> {
  return {
    rationale: 'Tighten the guardrail contract so the tool loop stops retrying.',
    focusSurfaces: ['guardrails'],
    confidence: 0.6,
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

function scriptedModel(reply = 'scripted deliverable'): IModelAdapter {
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
            assessments: aliases.map((alias, index) => ({
              alias,
              rationale: 'ranked by the scripted judge ' + String(index)
            }))
          }),
          finishReason: 'stop',
          model: 'scripted'
        };
      }
      if (request.purpose === 'reflect') {
        return { text: JSON.stringify({ lessons: [] }), finishReason: 'stop', model: 'scripted' };
      }
      return { text: reply, finishReason: 'stop', model: 'scripted' };
    }
  };
}

// ---------------------------------------------------------------------------
// a raw JSON-RPC client over InMemoryTransport (the handshake a client speaks)
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
      const reply = await new Promise<any>((resolve) => {
        pending.set(id, resolve);
        void clientTransport.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
      });
      return reply;
    },
    async notify(method, params) {
      await clientTransport.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
    },
    async close() {
      await clientTransport.close();
    }
  };
}

// ---------------------------------------------------------------------------
// per-test scaffolding
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

async function buildServer(overrides: Record<string, unknown> = {}): Promise<{
  instance: ReturnType<typeof createEvoMcpServer>;
  client: RawClient;
  dataDir: string;
}> {
  const dataDir = await makeTempDir('mcp-server');
  tempDirs.push(dataDir);
  const instance = createEvoMcpServer({
    model: scriptedModel(),
    now: (() => {
      let tick = 1_700_000_000_000;
      return () => (tick += 1);
    })(),
    assembly: {
      config: {
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
      },
      dataDir: { dataDir, env: { EVO_HARNESS_DATA_DIR: undefined, DSH_DATA_DIR: undefined, DSH_PROFILE: undefined } }
    },
    ...overrides
  });
  const client = await connectClient(instance.server);
  return { instance, client, dataDir };
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await cleanupDir(dir).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// handshake
// ---------------------------------------------------------------------------

describe('initialize handshake (protocol 2025-06-18)', () => {
  it('negotiates 2025-06-18 and reports the evo identity', async () => {
    const { instance, client } = await buildServer();
    try {
      const reply = await client.call('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '0.0.0' }
      });
      expect(reply.error).toBeUndefined();
      expect(reply.result.protocolVersion).toBe('2025-06-18');
      expect(reply.result.serverInfo.name).toBe(EVO_MCP_SERVER_NAME);
      expect(reply.result.serverInfo.name).toBe('evo');
      expect(reply.result.capabilities.tools).toBeDefined();
    } finally {
      await client.close();
      await instance.dispose();
    }
  });

  it('carries instructions that state shadow, start/poll and the three-state verdict', async () => {
    const { instance, client } = await buildServer();
    try {
      const reply = await client.call('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '0.0.0' }
      });
      const instructions: string = reply.result.instructions;
      expect(typeof instructions).toBe('string');
      expect(instructions.length).toBeLessThan(32_768);
      expect(instructions).toBe(EVO_MCP_INSTRUCTIONS);
      expect(instructions).toContain('SHADOW');
      expect(instructions).toContain('evo_run_poll');
      expect(instructions).toContain('graded / ungraded / not-evaluable');
      expect(instructions).toContain('no host context');
    } finally {
      await client.close();
      await instance.dispose();
    }
  });

  it('accepts notifications/initialized after the handshake', async () => {
    const { instance, client } = await buildServer();
    try {
      await client.call('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '0.0.0' }
      });
      // A rejection would surface as an unhandled error from the transport;
      // awaiting the notify simply completes.
      await expect(client.notify('notifications/initialized')).resolves.toBeUndefined();
    } finally {
      await client.close();
      await instance.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// tools/list: exactly the seven
// ---------------------------------------------------------------------------

describe('tools/list contract', () => {
  it('returns exactly the seven evo tools after the handshake', async () => {
    const { instance, client } = await buildServer();
    try {
      await client.call('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '0.0.0' }
      });
      await client.notify('notifications/initialized');
      const reply = await client.call('tools/list');
      expect(reply.error).toBeUndefined();
      const tools: { name: string; inputSchema?: { type?: string } }[] = reply.result.tools;
      expect(tools.map((tool) => tool.name).sort()).toEqual([...EVO_TOOL_NAMES].sort());
      expect(tools).toHaveLength(7);
      for (const tool of tools) {
        expect(tool.inputSchema?.type).toBe('object');
      }
    } finally {
      await client.close();
      await instance.dispose();
    }
  });

  it('restricts the evo_jit action to the on/off/status/reset enum', async () => {
    const { instance, client } = await buildServer();
    try {
      await client.call('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '0.0.0' }
      });
      const reply = await client.call('tools/list');
      const evoJit = (reply.result.tools as { name: string; inputSchema: Record<string, any> }[]).find(
        (tool) => tool.name === 'evo_jit'
      );
      const actionEnum: string[] = evoJit?.inputSchema?.properties?.action?.enum;
      expect(actionEnum).toEqual(expect.arrayContaining(['on', 'off', 'status', 'reset']));
      expect(actionEnum).toHaveLength(4);
    } finally {
      await client.close();
      await instance.dispose();
    }
  });

  it('marks the read-only tools with readOnlyHint annotations', async () => {
    const { instance, client } = await buildServer();
    try {
      await client.call('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '0.0.0' }
      });
      const reply = await client.call('tools/list');
      const tools = reply.result.tools as { name: string; annotations?: { readOnlyHint?: boolean } }[];
      for (const name of ['evo_status', 'evo_run_poll', 'evo_lessons', 'evo_text_probe']) {
        const tool = tools.find((entry) => entry.name === name);
        expect(tool?.annotations?.readOnlyHint).toBe(true);
      }
      const submit = tools.find((entry) => entry.name === 'evo_run_submit');
      expect(submit?.annotations?.readOnlyHint).toBe(false);
    } finally {
      await client.close();
      await instance.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// boundary redaction (rev8 boundary fix 5)
// ---------------------------------------------------------------------------

describe('boundary deep redaction', () => {
  it('redactDeepForBoundary redacts strings at EVERY level of a structured payload', async () => {
    const { redactDeepForBoundary, clipToolText, EVO_TOOL_TEXT_LIMIT } = await import('../../src/mcp/server');
    const payload = {
      ok: true,
      nested: {
        lesson: {
          title: 'connect with Bearer sk-proj-abcdefgh1234 now',
          whenToApply: ['when the token is ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
          evidence: { text: 'password=hunter2sensitive' }
        },
        count: 3,
        flag: false,
        nothing: null
      }
    };
    const redacted = redactDeepForBoundary(payload) as Record<string, any>;
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('sk-proj-abcdefgh1234');
    expect(serialized).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(serialized).not.toContain('hunter2sensitive');
    expect(redacted.nested.lesson.title).toContain('<secret>');
    expect(redacted.nested.lesson.whenToApply[0]).toContain('<secret>');
    expect(redacted.nested.lesson.evidence.text).toContain('<secret>');
    // Non-strings pass verbatim.
    expect(redacted.nested.count).toBe(3);
    expect(redacted.nested.flag).toBe(false);
    expect(redacted.nested.nothing).toBeNull();
    expect(redacted.ok).toBe(true);

    // AbortSignals and host objects never survive: the boundary drops them.
    const withSignal = redactDeepForBoundary({ signal: new AbortController().signal, keep: 1 }) as Record<string, unknown>;
    expect(withSignal['signal']).toBeUndefined();
    expect(withSignal['keep']).toBe(1);

    // The clip keeps the WHOLE string (marker included) inside the limit.
    const clipped = clipToolText('x'.repeat(EVO_TOOL_TEXT_LIMIT + 500));
    expect(clipped.length).toBeLessThanOrEqual(EVO_TOOL_TEXT_LIMIT);
    expect(clipped).toContain('clipped');
  });

  it('a tool result whose payload embeds a secret shape is redacted in BOTH text and structuredContent', async () => {
    const { instance, client } = await buildServer();
    try {
      await client.call('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '0.0.0' }
      });
      const reply = await client.call('tools/call', {
        name: 'evo_text_probe',
        arguments: { prompt: 'leak the key sk-proj-abcdefgh1234 in the detail' }
      });
      expect(reply.result?.isError).toBeFalsy();
      const text: string = reply.result.content[0].text;
      const structured: string = JSON.stringify(reply.result.structuredContent);
      // The evaluation never echoes the prompt, but the boundary invariant
      // still holds for both surfaces: no secret-shaped string survives.
      expect(text).not.toContain('sk-proj-abcdefgh1234');
      expect(structured).not.toContain('sk-proj-abcdefgh1234');
    } finally {
      await client.close();
      await instance.dispose();
    }
  });
});

describe('evo_status over tools/call', () => {
  it('reports the shadow constants and a temp-dir dataDir', async () => {
    const { instance, client, dataDir } = await buildServer();
    try {
      await client.call('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '0.0.0' }
      });
      const reply = await client.call('tools/call', { name: 'evo_status', arguments: {} });
      expect(reply.error).toBeUndefined();
      expect(reply.result.isError).toBeFalsy();
      const payload = reply.result.structuredContent.payload;
      expect(payload.execution.mode).toBe('shadow');
      expect(payload.execution.applyWinningPatch).toBe(false);
      expect(payload.server.name).toBe('evo');
      expect(String(payload.dataDir).toLowerCase()).toContain(dataDir.toLowerCase());
      // The memory projection of an unbound bridge: never 'yes'.
      expect(payload.memory.writable).not.toBe('yes');
      expect(payload.dream.minimum).toBe(12);
    } finally {
      await client.close();
      await instance.dispose();
    }
  });
});
