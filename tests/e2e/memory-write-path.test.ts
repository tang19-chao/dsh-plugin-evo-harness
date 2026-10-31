/**
 * A-t11-6: the governed memory write path exercised end to end, under the
 * TEST-ONLY permission assembly only, against a deterministic in-memory MCP mock.
 *
 * Three things are asserted for the write path, and nothing touches a real
 * backend, a real MCP server, a user directory or the network:
 *   1. governance interception — an incomplete lesson is blocked BEFORE any
 *      backend call (zero write-tool traffic, zero stored records);
 *   2. namespace isolation — the deterministic namespace of the committing
 *      scope is the only namespace a sibling branch may read, both for a
 *      namespace-enforcing backend and for a namespace-blind one (where the
 *      client-side firewall alone must hold the line), for the default
 *      'harness2' prefix and for a custom prefix;
 *   3. failure rollback — when the backend throws, the commit is reported as a
 *      failure, no half-written record is observable, and the bridge keeps no
 *      phantom bookkeeping of the aborted attempt (a retry of the same lesson id
 *      succeeds without a duplicate warning).
 *
 * A fourth case pins the boundary from the other side: the DEFAULT assembly (no
 * permission input) reaches the backend for recall but never for a write.
 *
 * The strict backend below filters by the requested namespaces with NO fallback
 * to "everything" — the shared e2e fixtures deliberately fall back, which is
 * exactly the shape that cannot prove isolation.
 */

import { describe, expect, it } from 'vitest';
import { parseEvoHarnessConfig } from '../../src/config';
import {
  createMemoryBridge,
  deriveNamespace,
  parseLessonDocument,
  resolveMemoryWritableStatus,
  type McpClient,
  type McpToolCallResult,
  type McpToolDescriptor,
  type UniversalMemoryBridge
} from '../../src/memory-bridge';
import { createEvoHarnessPlugin } from '../../src/index';
import { resolveExecutionProfile } from '../../src/runtime/execution-profile';
import type { CanonicalLesson, MemoryScope } from '../../src/types/contracts';
import { createScriptedModel, createScriptedRunner, e2eConfig, makeClock, makeIdFactory } from './fixtures';

const SESSION = 'sess-write-path';
const BRANCH_A: MemoryScope = { kind: 'branch', sessionId: SESSION, branchId: 'b-1' };
const BRANCH_B: MemoryScope = { kind: 'branch', sessionId: SESSION, branchId: 'b-2' };

interface StrictCall {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

interface StrictRecord {
  readonly id: string;
  readonly namespace: string;
  readonly text: string;
  readonly polarity: string;
}

interface StrictServer {
  readonly client: McpClient;
  readonly records: StrictRecord[];
  readonly calls: StrictCall[];
  listToolsCalls: number;
  /** Throw out of the write tool instead of persisting (transport failure). */
  failWrites: boolean;
  /** Answer the write tool with a native rejection verdict. */
  rejectWrites: boolean;
  /** Ignore the requested namespace filter (namespace-blind backend). */
  readonly namespaceBlind: boolean;
  callsTo(tool: string): StrictCall[];
}

function schema(shape: Readonly<Record<string, string>>): never {
  const properties: Record<string, { type: string }> = {};
  for (const [key, type] of Object.entries(shape)) {
    properties[key] = { type };
  }
  return { properties } as never;
}

/** Every namespace a call asked for, from the declared argument shapes. */
function requestedNamespaces(args: Record<string, unknown>): string[] {
  const found: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value.length > 0) {
      found.push(value);
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string' && entry.length > 0) {
          found.push(entry);
        }
      }
    }
  };
  push(args.user_id);
  push(args.userId);
  push(args.namespace);
  const metadata = args.metadata;
  if (metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)) {
    push((metadata as Record<string, unknown>).namespaces);
    push((metadata as Record<string, unknown>).namespace);
  }
  return [...new Set(found)];
}

function jsonResult(payload: unknown): McpToolCallResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload as never
  };
}

/** A vector/fact-shaped MCP backend that never widens a namespace filter. */
function strictMemoryServer(options: { readonly serverId?: string; readonly namespaceBlind?: boolean } = {}): StrictServer {
  const records: StrictRecord[] = [];
  const calls: StrictCall[] = [];
  const tools: McpToolDescriptor[] = [
    {
      name: 'add_memory',
      description: 'store one lesson document',
      inputSchema: schema({ text: 'string', user_id: 'string', metadata: 'object' })
    },
    {
      name: 'search_memory',
      inputSchema: schema({ query: 'string', user_id: 'string', limit: 'number', metadata: 'object' })
    },
    { name: 'delete_memory', inputSchema: schema({ ids: 'array', user_id: 'string' }) }
  ];
  const server: StrictServer = {
    records,
    calls,
    listToolsCalls: 0,
    failWrites: false,
    rejectWrites: false,
    namespaceBlind: options.namespaceBlind === true,
    callsTo(tool: string): StrictCall[] {
      return calls.filter((call) => call.tool === tool);
    },
    client: {
      serverId: options.serverId ?? 'strict-mem0',
      async listTools(): Promise<readonly McpToolDescriptor[]> {
        server.listToolsCalls += 1;
        return tools;
      },
      async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
        calls.push({ tool: name, args });
        if (name === 'add_memory') {
          if (server.rejectWrites) {
            return jsonResult({ verdict: 'reject', reason: 'native gate rejected the lesson' });
          }
          if (server.failWrites) {
            // A transactional backend: it fails BEFORE anything is persisted.
            throw new Error('backend exploded before persisting');
          }
          const text = typeof args.text === 'string' ? args.text : '';
          const parsed = parseLessonDocument(text);
          if (parsed === undefined) {
            return { isError: true, content: [{ type: 'text', text: 'unrecognized lesson payload' }] };
          }
          records.push({
            id: parsed.lesson.id,
            namespace: requestedNamespaces(args)[0] ?? parsed.namespace,
            text,
            polarity: parsed.lesson.polarity
          });
          return jsonResult({ id: parsed.lesson.id, stored: true });
        }
        if (name === 'search_memory') {
          const requested = requestedNamespaces(args);
          const visible = server.namespaceBlind
            ? records
            : records.filter((record) => requested.includes(record.namespace));
          return jsonResult({
            results: visible.map((record) => ({
              id: record.id,
              memory: record.text,
              metadata: { namespace: record.namespace }
            }))
          });
        }
        if (name === 'delete_memory') {
          const ids = new Set(
            Array.isArray(args.ids) ? args.ids.filter((entry): entry is string => typeof entry === 'string') : []
          );
          for (let index = records.length - 1; index >= 0; index -= 1) {
            const record = records[index];
            if (record !== undefined && ids.has(record.id)) {
              records.splice(index, 1);
            }
          }
          return jsonResult({ removed: ids.size });
        }
        return { isError: true, content: [{ type: 'text', text: 'unknown tool ' + name }] };
      }
    }
  };
  return server;
}

function makeLesson(overrides: Partial<CanonicalLesson> = {}): CanonicalLesson {
  return {
    id: 'lesson-write-path',
    title: 'Pin the failing tool signature before retrying the build',
    whenToApply: ['observedSignal=tool_error'],
    subFunctions: ['guardrails'],
    executionPatch: { summary: 'Identify the failing tool before any retry.' },
    verificationEvidence: {
      referenceFailure: 'reference run: 3 argument-validation tool errors',
      candidateSuccess: 'candidate run: 0 argument-validation tool errors',
      metricsDelta: { stepsDiff: 0, toolErrorsDiff: -3 }
    },
    whenNotToApply: ['do not apply when the build already passes'],
    polarity: 'positive',
    visibility: 'session',
    sessionId: SESSION,
    createdAt: 1_700_000_000_000,
    confidence: 0.8,
    ...overrides
  };
}

function bridge(config: ReturnType<typeof parseEvoHarnessConfig>, server: StrictServer): UniversalMemoryBridge {
  return createMemoryBridge({ config: config.memoryBridge, clients: [server.client], now: makeClock() });
}

describe('test-assembly write path (memoryRealWrites)', () => {
  it('commits governed lessons through the harness2 namespaces and never a foreign one', async () => {
    const server = strictMemoryServer({ serverId: 'strict-mem0' });
    const config = parseEvoHarnessConfig(e2eConfig());
    const now = makeClock();
    const memory = createMemoryBridge({ config: config.memoryBridge, clients: [server.client], now });
    const plugin = createEvoHarnessPlugin(
      {
        config,
        model: createScriptedModel(),
        clients: [server.client],
        runBranch: createScriptedRunner(now),
        now,
        newId: makeIdFactory('write-path'),
        // TEST-ONLY assembly: an in-memory mock backend plus the explicit
        // permission input. No config field produces this profile, and the
        // production entrypoint never sets it.
        deps: { memory, executionProfile: resolveExecutionProfile({ memoryRealWrites: true }) }
      },
      {}
    );

    const result = await plugin.run({
      sessionId: SESSION,
      task: plugin.makeTask({ id: 'task-write-path', prompt: 'Fix the failing build.' }),
      trigger: 'always'
    });

    expect(result.outcome).toBe('composed');
    expect(result.lessonsCommitted).toBeGreaterThanOrEqual(1);
    expect(server.records.length).toBeGreaterThanOrEqual(1);
    expect(server.records.every((record) => record.namespace.startsWith('harness2:'))).toBe(true);
    expect(server.records.some((record) => /:branch:|:session:/.test(record.namespace))).toBe(true);
    // The governed commit went through the family's own write tool.
    expect(server.callsTo('add_memory').length).toBeGreaterThanOrEqual(1);
  });

  it('denies the same write path in the default assembly (no real memory write)', async () => {
    const server = strictMemoryServer({ serverId: 'strict-mem0-denied' });
    const config = parseEvoHarnessConfig(
      e2eConfig({ config: { memoryBridge: { promoteOnComposeSuccess: true } } })
    );
    const now = makeClock();
    const memory = createMemoryBridge({ config: config.memoryBridge, clients: [server.client], now });
    const plugin = createEvoHarnessPlugin(
      {
        config,
        model: createScriptedModel(),
        clients: [server.client],
        runBranch: createScriptedRunner(now),
        now,
        newId: makeIdFactory('write-path-denied'),
        // Default profile: the permission half is denied, so the bridge is
        // never called for a write even though the request half is on.
        deps: { memory }
      },
      {}
    );

    const result = await plugin.run({
      sessionId: 'sess-denied',
      task: plugin.makeTask({ id: 'task-denied', prompt: 'Fix the failing build.' }),
      trigger: 'always'
    });

    expect(result.outcome).toBe('composed');
    expect(result.lessonsCommitted).toBe(0);
    expect(server.records).toEqual([]);
    expect(server.callsTo('add_memory')).toEqual([]);
    expect(result.diagnostics.join(' ')).toContain('NOT committed');
    // Recall is still exercised: the denial is a write gate, not a memory blackout.
    expect(server.callsTo('search_memory').length).toBeGreaterThan(0);
  });

  it('exposes the writable handshake over the live discovery with zero tool calls', async () => {
    const server = strictMemoryServer({ serverId: 'strict-mem0-status' });
    const config = parseEvoHarnessConfig(e2eConfig());
    const memory = bridge(config, server);
    await memory.initialize();
    const discovery = memory.discoveryResult();
    expect(discovery).not.toBeNull();
    const callsBefore = server.calls.length;
    const recordsBefore = server.records.length;

    const denied = resolveMemoryWritableStatus({ discovery, profile: resolveExecutionProfile() });
    const granted = resolveMemoryWritableStatus({
      discovery,
      profile: resolveExecutionProfile({ memoryRealWrites: true })
    });

    expect(denied.writable).toBe('no');
    expect(denied.mode).toBe('recall-only');
    expect(denied.label).toBe('Recall-Only');
    expect(granted.writable).toBe('yes');
    expect(granted.mode).toBe('read-write');

    // The handshake is a read of already-held data: no tools/call traffic, no
    // stored record, and tools/list was consulted exactly once (initialize).
    expect(server.calls.length).toBe(callsBefore);
    expect(server.records.length).toBe(recordsBefore);
    expect(server.listToolsCalls).toBe(1);
  });
});

describe('governance interception before any backend write', () => {
  it('blocks an incomplete lesson with zero write-tool traffic', async () => {
    const server = strictMemoryServer({ serverId: 'strict-gov' });
    const memory = bridge(parseEvoHarnessConfig(e2eConfig()), server);
    await memory.initialize();
    const callsBefore = server.calls.length;

    const outcome = await memory.commit(makeLesson({ id: 'lesson-incomplete', whenNotToApply: [] }), {
      scope: BRANCH_A
    });

    expect(outcome.accepted).toBe(false);
    expect(outcome.persisted).toBe(false);
    expect(outcome.violations.map((violation) => violation.code)).toContain('missing_when_not_to_apply');
    expect(server.calls.length).toBe(callsBefore);
    expect(server.callsTo('add_memory')).toEqual([]);
    expect(server.records).toEqual([]);
  });
});

describe('namespace isolation on the write path', () => {
  it('keeps a branch-private lesson inside its own deterministic namespace (backend enforces)', async () => {
    const server = strictMemoryServer({ serverId: 'strict-iso' });
    const memory = bridge(parseEvoHarnessConfig(e2eConfig()), server);
    await memory.initialize();

    const committed = await memory.commit(makeLesson({ id: 'lesson-branch-a', visibility: 'branch_private' }), {
      scope: BRANCH_A
    });
    expect(committed.accepted).toBe(true);
    expect(committed.namespace).toBe(deriveNamespace(BRANCH_A, 'harness2'));
    expect(committed.namespace).toBe('harness2:branch:sess-write-path:b-1');
    expect(server.records.map((record) => record.namespace)).toEqual(['harness2:branch:sess-write-path:b-1']);

    const own = await memory.recall({
      scope: BRANCH_A,
      text: 'the tool keeps failing argument validation on the build',
      taskSignature: 'build-failure'
    });
    expect(own.positiveLessons.map((lesson) => lesson.id)).toEqual(['lesson-branch-a']);

    const sibling = await memory.recall({
      scope: BRANCH_B,
      text: 'the tool keeps failing argument validation on the build',
      taskSignature: 'build-failure'
    });
    expect(sibling.lessons).toEqual([]);
  });

  it('suppresses a foreign branch record client-side when the backend is namespace-blind', async () => {
    const server = strictMemoryServer({ serverId: 'strict-blind', namespaceBlind: true });
    const memory = bridge(parseEvoHarnessConfig(e2eConfig()), server);
    await memory.initialize();

    await memory.commit(makeLesson({ id: 'lesson-blind-a', visibility: 'branch_private' }), { scope: BRANCH_A });
    const sibling = await memory.recall({ scope: BRANCH_B, text: 'Fix the failing build.' });

    expect(sibling.lessons).toEqual([]);
    expect(sibling.suppressedLessons.some((entry) => entry.reason === 'scope_mismatch')).toBe(true);
  });

  it('honours a custom namespace prefix and does not collide with the default one', async () => {
    const customConfig = parseEvoHarnessConfig(
      e2eConfig({ config: { memoryBridge: { namespacePrefix: 'team-custom' } } })
    );
    const customServer = strictMemoryServer({ serverId: 'strict-custom' });
    const customMemory = createMemoryBridge({
      config: customConfig.memoryBridge,
      clients: [customServer.client],
      now: makeClock()
    });
    await customMemory.initialize();

    const committed = await customMemory.commit(makeLesson({ id: 'lesson-custom', visibility: 'branch_private' }), {
      scope: BRANCH_A
    });
    expect(committed.namespace).toBe('team-custom:branch:sess-write-path:b-1');
    expect(customServer.records[0]?.namespace).toBe('team-custom:branch:sess-write-path:b-1');

    // A bridge on the default prefix must not read the custom-prefix namespace.
    const defaultServer = strictMemoryServer({ serverId: 'strict-default' });
    const defaultMemory = bridge(parseEvoHarnessConfig(e2eConfig()), defaultServer);
    await defaultMemory.initialize();
    const crossRead = await defaultMemory.recall({ scope: BRANCH_A, text: 'Fix the failing build.' });
    expect(crossRead.lessons).toEqual([]);

    // And the custom-prefix bridge reads its own record back.
    const ownRead = await customMemory.recall({ scope: BRANCH_A, text: 'Fix the failing build.' });
    expect(ownRead.positiveLessons.map((lesson) => lesson.id)).toEqual(['lesson-custom']);
  });
});

describe('failure rollback of a backend write', () => {
  it('reports the failure, leaves no half-written record and keeps no phantom state', async () => {
    const server = strictMemoryServer({ serverId: 'strict-rollback' });
    const memory = bridge(parseEvoHarnessConfig(e2eConfig()), server);
    await memory.initialize();

    server.failWrites = true;
    const failed = await memory.commit(makeLesson({ id: 'lesson-rollback' }), { scope: BRANCH_A });

    expect(failed.accepted).toBe(false);
    expect(failed.persisted).toBe(false);
    expect(failed.violations.some((violation) => violation.severity === 'block')).toBe(true);
    expect(failed.violations.map((violation) => violation.message).join(' ')).toContain('backend commit failed');
    // The attempt reached the backend exactly once and nothing was persisted.
    expect(server.callsTo('add_memory')).toHaveLength(1);
    expect(server.records).toEqual([]);

    const after = await memory.recall({ scope: BRANCH_A, text: 'Fix the failing build.' });
    expect(after.lessons).toEqual([]);

    server.failWrites = false;
    const retried = await memory.commit(makeLesson({ id: 'lesson-rollback' }), { scope: BRANCH_A });
    // No phantom bookkeeping: the aborted attempt did not mark the id as
    // already persisted, so the retry is accepted without a duplicate warning.
    expect(retried.accepted).toBe(true);
    expect(retried.persisted).toBe(true);
    expect(retried.violations.map((violation) => violation.code)).not.toContain('duplicate_lesson');
    expect(server.records.map((record) => record.id)).toEqual(['lesson-rollback']);
  });

  it('treats a native rejection verdict as a refusal that persisted nothing', async () => {
    const server = strictMemoryServer({ serverId: 'strict-reject' });
    const memory = bridge(parseEvoHarnessConfig(e2eConfig()), server);
    await memory.initialize();

    server.rejectWrites = true;
    const rejected = await memory.commit(makeLesson({ id: 'lesson-rejected' }), { scope: BRANCH_A });

    expect(rejected.accepted).toBe(false);
    expect(rejected.persisted).toBe(false);
    expect(rejected.violations.map((violation) => violation.code)).toContain('invalid_lesson');
    expect(server.records).toEqual([]);

    const after = await memory.recall({ scope: BRANCH_A, text: 'Fix the failing build.' });
    expect(after.lessons).toEqual([]);
  });
});
