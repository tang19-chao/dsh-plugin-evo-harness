/**
 * P5-b: aggregate statistics mirror into the memory bridge (plan 7.2).
 *
 * Covers the IJitMirrorStore implementation in bridge.store.ts: the disabled
 * mirror as a strict zero-contact no-op, aggregate-only payloads that pass
 * the shared redaction (no raw text, absolute paths or secret-shaped
 * strings), per-level namespace isolation (`${prefix}/jitrl/${level}`) with
 * normalization, failure isolation (one bad row or backend error never
 * aborts or throws), tool discovery against the structural MCP boundary,
 * schema-driven argument field resolution, deterministic note paths and
 * empty-input behaviour. Every backend is a fake client; no network.
 */
import { describe, expect, it } from 'vitest';
import type { JitLevel, JitStatsAggregate } from '../../../src/types/contracts';
import {
  JITRL_STAT_TAG,
  createJitBridgeMirrorStore,
  MAX_DIAGNOSTIC_LENGTH,
  type BridgeMirrorStoreOptions,
  type JitMirrorMcpClient,
  type JitMirrorToolDescriptor
} from '../../../src/jitrl/stores/bridge.store';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface RecordedCall {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

/** Deterministic MCP fake: records every write, never touches a network. */
class FakeMirrorClient implements JitMirrorMcpClient {
  readonly serverId: string;
  readonly tools: readonly JitMirrorToolDescriptor[];
  readonly calls: RecordedCall[] = [];
  listToolsCalls = 0;
  listToolsError: Error | null = null;
  failWhen: ((call: RecordedCall) => boolean) | null = null;
  respondWithError = false;

  constructor(
    tools: readonly JitMirrorToolDescriptor[] = [{ name: 'write_note' }],
    serverId = 'fake-memory'
  ) {
    this.tools = tools;
    this.serverId = serverId;
  }

  async listTools(): Promise<readonly JitMirrorToolDescriptor[]> {
    this.listToolsCalls += 1;
    if (this.listToolsError !== null) {
      throw this.listToolsError;
    }
    return this.tools;
  }

  async callTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const call: RecordedCall = { tool, args };
    this.calls.push(call);
    if (this.failWhen !== null && this.failWhen(call)) {
      throw new Error('backend write failed');
    }
    if (this.respondWithError) {
      return { isError: true, content: [] };
    }
    return { content: [{ type: 'text', text: 'ok' }] };
  }
}

/** One aggregate statistics row (plan 7.2: per bucket x actionKey x level). */
function aggregate(overrides: Partial<JitStatsAggregate> = {}): JitStatsAggregate {
  return {
    bucket: 'task|simple',
    actionKey: 'action:alpha',
    level: 'meta',
    n: 3,
    meanReturn: 1.5,
    variance: 0.25,
    ...overrides
  };
}

function makeStore(
  client: JitMirrorMcpClient | undefined,
  overrides: Partial<BridgeMirrorStoreOptions> = {}
): ReturnType<typeof createJitBridgeMirrorStore> {
  return createJitBridgeMirrorStore({
    mirrorToMemoryBridge: true,
    namespacePrefix: 'harness2',
    ...(client === undefined ? {} : { client }),
    ...overrides
  });
}

function serializedCalls(client: FakeMirrorClient): string {
  return JSON.stringify(client.calls);
}

function metadataOf(call: RecordedCall | undefined): Record<string, unknown> {
  expect(call).toBeDefined();
  return (call?.args.metadata ?? {}) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Disabled mirror
// ---------------------------------------------------------------------------

describe('disabled mirror (jitrl.store.mirrorToMemoryBridge = false)', () => {
  it('writes nothing and never touches the injected client', async () => {
    const client = new FakeMirrorClient();
    const store = makeStore(client, { mirrorToMemoryBridge: false });

    const result = await store.mirror([aggregate(), aggregate({ level: 'proposal' })]);

    expect(result.written).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.namespaces).toEqual([]);
    expect(result.degraded).toBe(false);
    expect(client.listToolsCalls).toBe(0);
    expect(client.calls).toHaveLength(0);
  });

  it('still resolves namespaces from the configured prefix', () => {
    const store = makeStore(new FakeMirrorClient(), { mirrorToMemoryBridge: false });

    expect(store.namespaceFor('meta')).toBe('harness2/jitrl/meta');
  });
});

// ---------------------------------------------------------------------------
// Enabled mirror: writes, payload and isolation
// ---------------------------------------------------------------------------

describe('enabled mirror', () => {
  it('mirrors nothing for empty aggregates without any backend call', async () => {
    const client = new FakeMirrorClient();
    const store = makeStore(client);

    const result = await store.mirror([]);

    expect(result.written).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.namespaces).toEqual([]);
    expect(result.degraded).toBe(false);
    expect(client.listToolsCalls).toBe(0);
    expect(client.calls).toHaveLength(0);
  });

  it('writes one note per aggregate through the discovered write tool', async () => {
    const client = new FakeMirrorClient();
    const store = makeStore(client);

    const result = await store.mirror([
      aggregate(),
      aggregate({ bucket: 'task|complex', actionKey: 'action:beta', level: 'proposal' })
    ]);

    expect(result.written).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.degraded).toBe(false);
    expect(client.calls).toHaveLength(2);
    for (const call of client.calls) {
      expect(call.tool).toBe('write_note');
    }
    expect(result.namespaces).toEqual(['harness2/jitrl/meta', 'harness2/jitrl/proposal']);
  });

  it('carries only aggregate fields and structural metadata in the payload', async () => {
    const client = new FakeMirrorClient();
    const store = makeStore(client, { now: () => 1_000_000 });

    const result = await store.mirror([aggregate()]);

    expect(result.written).toBe(1);
    const args = client.calls[0]!.args;
    const metadata = metadataOf(client.calls[0]);
    expect(Object.keys(metadata).sort()).toEqual([
      'actionKey',
      'bucket',
      'kind',
      'level',
      'meanReturn',
      'n',
      'namespace',
      'updatedAt',
      'variance'
    ]);
    expect(metadata).toMatchObject({
      kind: 'jitrl-stat',
      namespace: 'harness2/jitrl/meta',
      level: 'meta',
      bucket: 'task|simple',
      actionKey: 'action:alpha',
      n: 3,
      meanReturn: 1.5,
      variance: 0.25,
      updatedAt: 1_000_000
    });
    expect(args.tags).toEqual([JITRL_STAT_TAG]);
    const document = String(args.text);
    expect(document).toBe(
      '#jitrl-stat level=meta bucket=task|simple actionKey=action:alpha n=3 meanReturn=1.5 variance=0.25'
    );
    const serialized = serializedCalls(client);
    expect(serialized).not.toContain('"reward"');
    expect(serialized).not.toContain('"state"');
    expect(serialized).not.toContain('tokens');
  });

  it('redacts secret-shaped strings and absolute paths before writing', async () => {
    const client = new FakeMirrorClient();
    const store = makeStore(client);
    const secretToken = 'ghp_0123456789abcdefghijklmnopqrstuv';

    const result = await store.mirror([
      aggregate({ bucket: 'task|' + secretToken, actionKey: 'action:C:\\Users\\Admin\\notes' })
    ]);

    expect(result.written).toBe(1);
    const metadata = metadataOf(client.calls[0]);
    expect(metadata.bucket).toBe('task|<secret>');
    expect(metadata.actionKey).toBe('action:<path>');
    const document = String(client.calls[0]!.args.text);
    expect(document).toContain('bucket=task|<secret>');
    expect(document).toContain('actionKey=action:<path>');
    const serialized = serializedCalls(client);
    expect(serialized).not.toContain('ghp_0123456789');
    expect(serialized).not.toContain('Users');
    expect(serialized).not.toContain('Admin');
    expect(serialized).toContain('<secret>');
    expect(serialized).toContain('<path>');
  });

  it('isolates one namespace per level and never crosses levels', async () => {
    const client = new FakeMirrorClient();
    const store = makeStore(client);

    expect(store.namespaceFor('meta')).toBe('harness2/jitrl/meta');
    expect(store.namespaceFor('proposal')).toBe('harness2/jitrl/proposal');
    expect(store.namespaceFor('host_tool')).toBe('harness2/jitrl/host_tool');
    expect(
      new Set([store.namespaceFor('meta'), store.namespaceFor('proposal'), store.namespaceFor('host_tool')]).size
    ).toBe(3);

    const result = await store.mirror([
      aggregate(),
      aggregate({ level: 'proposal' }),
      aggregate({ level: 'host_tool' })
    ]);

    expect(result.written).toBe(3);
    expect(result.namespaces).toEqual([
      'harness2/jitrl/host_tool',
      'harness2/jitrl/meta',
      'harness2/jitrl/proposal'
    ]);
    for (const call of client.calls) {
      const metadata = metadataOf(call);
      const namespace = String(metadata.namespace);
      expect(namespace).toBe('harness2/jitrl/' + String(metadata.level));
      const path = String(call.args.path);
      expect(path.startsWith(namespace + '/')).toBe(true);
      if (metadata.level === 'meta') {
        expect(path.startsWith('harness2/jitrl/meta/')).toBe(true);
        expect(path).not.toContain('/proposal/');
        expect(path).not.toContain('/host_tool/');
      }
    }
  });

  it('normalizes namespaces: no empty segments, duplicate slashes or illegal characters', () => {
    const spaced = makeStore(undefined, { namespacePrefix: 'My Brand//x/../y' });
    expect(spaced.namespaceFor('meta')).toBe('My-Brand/x/y/jitrl/meta');

    const colon = makeStore(undefined, { namespacePrefix: 'harness:2///deep//path' });
    expect(colon.namespaceFor('host_tool')).toBe('harness-2/deep/path/jitrl/host_tool');

    const separatorsOnly = makeStore(undefined, { namespacePrefix: '///' });
    expect(separatorsOnly.namespaceFor('meta')).toBe('jitrl/meta');

    const stable = makeStore(new FakeMirrorClient());
    expect(stable.namespaceFor('proposal')).toBe(stable.namespaceFor('proposal'));
  });
});

// ---------------------------------------------------------------------------
// Enabled mirror: failure isolation and degradation
// ---------------------------------------------------------------------------

describe('enabled mirror under failure', () => {
  it('isolates a failed row: continues, records a payload-free diagnostic, never throws', async () => {
    const client = new FakeMirrorClient();
    const store = makeStore(client);
    client.failWhen = () => client.calls.length === 2;

    const result = await store.mirror([
      aggregate(),
      aggregate({ bucket: 'task|two' }),
      aggregate({ bucket: 'task|three' })
    ]);

    expect(result.written).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.degraded).toBe(true);
    expect(client.calls).toHaveLength(3);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    const joined = result.diagnostics.join('\n');
    expect(joined).not.toContain('task|two');
    expect(joined).not.toContain('task|three');
    expect(store.diagnostics().length).toBeGreaterThan(0);
  });

  it('treats an MCP isError result as a failed write', async () => {
    const client = new FakeMirrorClient();
    client.respondWithError = true;
    const store = makeStore(client);

    const result = await store.mirror([aggregate(), aggregate({ bucket: 'task|two' })]);

    expect(result.written).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.degraded).toBe(true);
    expect(client.calls).toHaveLength(2);
  });

  it('degrades to zero writes when listTools fails', async () => {
    const client = new FakeMirrorClient();
    client.listToolsError = new Error('transport down');
    const store = makeStore(client);

    const result = await store.mirror([aggregate(), aggregate({ bucket: 'task|two' })]);

    expect(result.written).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.degraded).toBe(true);
    expect(client.calls).toHaveLength(0);
    expect(result.diagnostics[0]).toContain('listTools failed');
  });

  it('degrades to zero writes when no write tool is advertised', async () => {
    const client = new FakeMirrorClient([{ name: 'search_notes' }, { name: 'read_note' }]);
    const store = makeStore(client);

    const result = await store.mirror([aggregate()]);

    expect(result.written).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.degraded).toBe(true);
    expect(client.calls).toHaveLength(0);
    expect(result.diagnostics[0]).toContain('no aggregate write tool');
  });

it('L3 governance: redacts and bounds diagnostics when backend echoes raw secret payload and long text', async () => {
    const rawSecret = 'ghp_SECRET_TOKEN_1234567890abcdefghijklmnopqrstuv';
    const rawPath = '/usr/local/secret/keys.pem';
    const client = new FakeMirrorClient();
    client.failWhen = () => true;
    // Override callTool to throw an error echoing the raw payload and long text
    client.callTool = async (tool: string, args: Record<string, unknown>) => {
      throw new Error(
        'Backend failed on payload: ' + rawSecret + ' at ' + rawPath + ' ' + 'repeated info '.repeat(25)
      );
    };

    const store = makeStore(client);
    const result = await store.mirror([aggregate()]);

    expect(result.degraded).toBe(true);
    expect(result.written).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.diagnostics.length).toBeGreaterThan(0);

    for (const diag of result.diagnostics) {
      // Must not leak the raw secret
      expect(diag).not.toContain(rawSecret);
      // Must not leak absolute paths
      expect(diag).not.toContain(rawPath);
      // Redaction placeholders must be present
      expect(diag).toContain('<secret>');
      expect(diag).toContain('<path>');
      // Must be bounded in length
      expect(diag.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_LENGTH);
    }
  });

  it('L3 governance: redacts and bounds serverId and backend exceptions in diagnostics when listTools fails', async () => {
    const rawServerSecret = 'ghp_SERVER_SECRET_9876543210zyxwvutsrq';
    const rawServerPath = 'C:\\Secret\\ServerConfig\\path.json';
    const client = new FakeMirrorClient(
      [{ name: 'write_note' }],
      'server-' + rawServerSecret
    );
    client.listToolsError = new Error(
      'transport error on ' + rawServerPath + ' using ' + rawServerSecret + ': ' + 'error details '.repeat(30)
    );

    const store = makeStore(client);
    const result = await store.mirror([aggregate()]);

    expect(result.degraded).toBe(true);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    const diag = result.diagnostics[0]!;

    expect(diag).not.toContain(rawServerSecret);
    expect(diag).not.toContain(rawServerPath);
    expect(diag).toContain('<secret>');
    expect(diag).toContain('<path>');
    expect(diag).toContain('server:');
    expect(diag.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_LENGTH);
  });

  it('F2 acceptance: backend echoing serverId, namespace, RAW_PAYLOAD, ghp_ and absolute path masks all sensitive data and bounds length <= 200', async () => {
    const rawServerId = 'mem0-prod-server-7f3a';
    const rawNamespace = 'tenant/secret-space';
    const rawPayload = 'RAW_PAYLOAD_INTERNAL_STATE_999888';
    const rawSecret = 'ghp_BACKEND_ECHO_TOKEN_1234567890abcdefgh';
    const rawPath = '/var/log/app/secrets/vault.key';

    const client = new FakeMirrorClient([{ name: 'write_note' }], rawServerId);
    client.failWhen = () => true;
    client.callTool = async () => {
      throw new Error(
        `Backend failed: server=${rawServerId} namespace=${rawNamespace} payload=${rawPayload} secret=${rawSecret} path=${rawPath} ` +
          'extra-context-'.repeat(20)
      );
    };

    const store = makeStore(client);
    const result = await store.mirror([aggregate()]);

    expect(result.degraded).toBe(true);
    expect(result.diagnostics.length).toBeGreaterThan(0);

    for (const diag of result.diagnostics) {
      // Must not leak serverId
      expect(diag).not.toContain(rawServerId);
      // Must not leak namespace
      expect(diag).not.toContain(rawNamespace);
      // Must not leak RAW_PAYLOAD
      expect(diag).not.toContain('RAW_PAYLOAD');
      expect(diag).not.toContain(rawPayload);
      // Must not leak raw secrets or absolute paths
      expect(diag).not.toContain(rawSecret);
      expect(diag).not.toContain(rawPath);
      // Must contain masked forms and placeholders
      expect(diag).toContain('ns:');
      expect(diag).toContain('<payload>');
      expect(diag).toContain('<secret>');
      expect(diag).toContain('<path>');
      // Must be bounded in length <= 200
      expect(diag.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_LENGTH);
    }
  });

    it('degrades when enabled but no client is injected', async () => {
    const store = makeStore(undefined);

    const result = await store.mirror([aggregate()]);

    expect(result.written).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.degraded).toBe(true);
    expect(result.diagnostics[0]).toContain('no MCP memory client');
  });

  it('skips invalid aggregate rows without throwing and still writes the valid ones', async () => {
    const client = new FakeMirrorClient();
    const store = makeStore(client);

    const result = await store.mirror([
      aggregate(),
      aggregate({ n: 0 }),
      aggregate({ meanReturn: Number.NaN }),
      aggregate({ variance: -1 }),
      aggregate({ bucket: '' }),
      aggregate({ actionKey: '  ' }),
      aggregate({ level: 'bogus' as JitLevel })
    ]);

    expect(result.written).toBe(1);
    expect(result.skipped).toBe(6);
    expect(result.degraded).toBe(true);
    expect(client.calls).toHaveLength(1);
    expect(metadataOf(client.calls[0]).bucket).toBe('task|simple');
  });
});

// ---------------------------------------------------------------------------
// Tool discovery and argument shapes
// ---------------------------------------------------------------------------

describe('tool discovery and argument shapes', () => {
  it('prefers the highest-priority candidate regardless of advertisement order or case', async () => {
    const client = new FakeMirrorClient([{ name: 'Write' }, { name: 'Write_Note' }]);
    const store = makeStore(client);

    await store.mirror([aggregate()]);

    expect(client.calls[0]!.tool).toBe('Write_Note');
  });

  it('resolves argument fields from the tool input schema', async () => {
    const client = new FakeMirrorClient([
      {
        name: 'write_note',
        inputSchema: {
          properties: {
            content: { type: 'string' },
            identifier: { type: 'string' },
            metadata: { type: 'object' }
          }
        }
      }
    ]);
    const store = makeStore(client);

    const result = await store.mirror([aggregate()]);

    expect(result.written).toBe(1);
    const args = client.calls[0]!.args;
    expect(Object.keys(args).sort()).toEqual(['content', 'identifier', 'metadata']);
    expect(String(args.content)).toContain('#jitrl-stat');
  });

  it('omits path/tags/metadata when the schema shows no such property', async () => {
    const client = new FakeMirrorClient([
      { name: 'save_memory', inputSchema: { properties: { text: { type: 'string' } } } }
    ]);
    const store = makeStore(client);

    await store.mirror([aggregate()]);

    expect(Object.keys(client.calls[0]!.args)).toEqual(['text']);
  });

  it('uses conservative default fields when the tool exposes no schema', async () => {
    const client = new FakeMirrorClient([{ name: 'create_memory' }]);
    const store = makeStore(client);

    await store.mirror([aggregate()]);

    const args = client.calls[0]!.args;
    expect(Object.keys(args).sort()).toEqual(['metadata', 'path', 'tags', 'text']);
    expect(String(args.path).startsWith('harness2/jitrl/meta/')).toBe(true);
    expect(args.tags).toEqual(['jitrl-stat']);
  });
});

// ---------------------------------------------------------------------------
// Determinism and bookkeeping
// ---------------------------------------------------------------------------

describe('determinism and bookkeeping', () => {
  it('derives a deterministic path per aggregate and never leaks raw separators', async () => {
    const client = new FakeMirrorClient();
    const store = makeStore(client, { now: () => 1_000_000 });
    const row = aggregate({ bucket: 'task|weird path:x', actionKey: 'action|weird' });

    await store.mirror([row]);
    await store.mirror([row]);

    expect(client.calls).toHaveLength(2);
    const firstPath = String(client.calls[0]!.args.path);
    expect(String(client.calls[1]!.args.path)).toBe(firstPath);
    expect(firstPath.startsWith('harness2/jitrl/meta/')).toBe(true);
    expect(firstPath.endsWith('.md')).toBe(true);
    expect(firstPath).not.toContain('|');
    expect(firstPath).not.toContain(':');
    expect(firstPath).not.toContain(' ');
  });

  it('prefers the aggregate timestamp and falls back to the injected clock', async () => {
    const client = new FakeMirrorClient();
    const store = makeStore(client, { now: () => 777 });

    await store.mirror([aggregate({ updatedAt: 12345 }), aggregate()]);

    expect(metadataOf(client.calls[0]).updatedAt).toBe(12345);
    expect(metadataOf(client.calls[1]).updatedAt).toBe(777);
  });
});
