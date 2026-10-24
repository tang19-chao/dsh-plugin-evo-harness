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
 * empty-input behaviour.
 *
 * P6.1-B1: failure diagnostics are structured whitelist lines
 * (`mirror_diag code= phase= operation= retryable= errorClass= correlationId=
 * [serverRef= namespaceRef=]`). Backend error bodies, tool args and note
 * text never render: every visible diagnostic exit (result.diagnostics,
 * store.diagnostics(), the onDiagnostic sink) is asserted canary-free, with
 * a canary that varies per case (Chinese body, English sentence, JSON,
 * newline, nested cause, extreme length, string throw, key/path canary).
 * Every backend is a fake client; no network.
 */
import { describe, expect, it } from 'vitest';
import type { JitLevel, JitStatsAggregate } from '../../../src/types/contracts';
import {
  JITRL_STAT_TAG,
  createJitBridgeMirrorStore,
  maskNamespace,
  maskServerId,
  sanitizeDiagnostic,
  MAX_DIAGNOSTIC_LENGTH,
  type BridgeMirrorStoreOptions,
  type JitMirrorMcpClient,
  type JitMirrorToolDescriptor
} from '../../../src/jitrl/stores/bridge.store';

/** Local aliases so sanitizer tests read without shadowing imports. */
const maskNamespaceForTest = maskNamespace;
const maskServerIdForTest = maskServerId;

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
  listToolsError: unknown = null;
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
// P6.1-B1 whitelist assertions
// ---------------------------------------------------------------------------

/** Fixed field names of the structured mirror diagnostic line. */
const WHITELIST_FIELDS = [
  'code',
  'phase',
  'operation',
  'retryable',
  'errorClass',
  'correlationId',
  'serverRef',
  'namespaceRef'
] as const;

/**
 * Every visible mirror diagnostic must be one whitelist line: exactly the
 * `mirror_diag` prefix, only known `key=value` fields, no free-form text.
 */
function expectWhitelistLine(diagnostic: string): void {
  expect(diagnostic.startsWith('mirror_diag ')).toBe(true);
  const body = diagnostic.slice('mirror_diag '.length);
  const fields = body.split(' ');
  for (const field of fields) {
    const eq = field.indexOf('=');
    expect(eq, field).toBeGreaterThan(0);
    const key = field.slice(0, eq);
    expect(WHITELIST_FIELDS as readonly string[]).toContain(key);
  }
  const keys = fields.map((field) => field.slice(0, field.indexOf('=')));
  expect(new Set(keys).size).toBe(keys.length);
  expect(diagnostic.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_LENGTH);
}

interface MirrorOutcomeLike {
  readonly diagnostics: readonly string[];
  readonly degraded: boolean;
}

/** Assert every visible diagnostic exit of a degraded mirror is whitelist-only. */
function expectAllVisibleDiagnosticsWhitelisted(
  result: MirrorOutcomeLike,
  store: ReturnType<typeof createJitBridgeMirrorStore>,
  sinkLines: readonly string[]
): void {
  expect(result.degraded).toBe(true);
  expect(result.diagnostics.length).toBeGreaterThan(0);
  for (const line of [...result.diagnostics, ...store.diagnostics(), ...sinkLines]) {
    expectWhitelistLine(line);
  }
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

  it('degrades to zero writes when listTools fails, with a whitelist diagnostic', async () => {
    const client = new FakeMirrorClient();
    client.listToolsError = new Error('transport down');
    const store = makeStore(client);

    const result = await store.mirror([aggregate(), aggregate({ bucket: 'task|two' })]);

    expect(result.written).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.degraded).toBe(true);
    expect(client.calls).toHaveLength(0);
    expectWhitelistLine(result.diagnostics[0]!);
    expect(result.diagnostics[0]).toContain('code=list_tools_failed');
    expect(result.diagnostics[0]).toContain('operation=listTools');
    expect(result.diagnostics[0]).toContain('serverRef=server:');
  });

  it('degrades to zero writes when no write tool is advertised, with a whitelist diagnostic', async () => {
    const client = new FakeMirrorClient([{ name: 'search_notes' }, { name: 'read_note' }]);
    const store = makeStore(client);

    const result = await store.mirror([aggregate()]);

    expect(result.written).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.degraded).toBe(true);
    expect(client.calls).toHaveLength(0);
    expectWhitelistLine(result.diagnostics[0]!);
    expect(result.diagnostics[0]).toContain('code=no_write_tool');
  });

  it('P6.1-B1: whitelist diagnostic never echoes backend error text (write path)', async () => {
    const rawSecret = 'ghp_SECRET_TOKEN_1234567890abcdefghijklmnopqrstuv';
    const rawPath = '/usr/local/secret/keys.pem';
    const client = new FakeMirrorClient();
    client.callTool = async () => {
      throw new Error(
        'Backend failed on payload: ' + rawSecret + ' at ' + rawPath + ' ' + 'repeated info '.repeat(25)
      );
    };

    const store = makeStore(client);
    const result = await store.mirror([aggregate()]);

    for (const diag of result.diagnostics) {
      // Whitelist-only line: no free-form text, bounded length.
      expectWhitelistLine(diag);
      // Must not leak any part of the backend error body.
      expect(diag).not.toContain(rawSecret);
      expect(diag).not.toContain('Backend failed');
      expect(diag).not.toContain('repeated info');
      expect(diag).not.toContain('/usr/local');
      expect(diag).not.toContain('keys.pem');
      expect(diag).toContain('code=write_failed');
      expect(diag).toContain('serverRef=server:');
      expect(diag).toContain('namespaceRef=ns:');
    }
  });

  it('P6.1-B1: whitelist diagnostic never echoes backend error text (listTools path)', async () => {
    const rawServerSecret = 'ghp_SERVER_SECRET_9876543210zyxwvutsrq';
    const rawServerPath = 'C:\\Secret\\ServerConfig\\path.json';
    const client = new FakeMirrorClient([{ name: 'write_note' }], 'server-' + rawServerSecret);
    client.listToolsError = new Error(
      'transport error on ' + rawServerPath + ' using ' + rawServerSecret + ': ' + 'error details '.repeat(30)
    );

    const store = makeStore(client);
    const result = await store.mirror([aggregate()]);

    const diag = result.diagnostics[0]!;
    expectWhitelistLine(diag);
    expect(diag).not.toContain(rawServerSecret);
    expect(diag).not.toContain(rawServerPath);
    expect(diag).not.toContain('transport error');
    expect(diag).toContain('code=list_tools_failed');
    expect(diag).toContain('serverRef=server:');
    expect(diag).not.toContain('server-' + rawServerSecret.slice(0, 8));
  });

  it('P6.1-B1: masks serverId/namespace references, classifies backend isError, bounds length', async () => {
    const rawServerId = 'mem0-prod-server-7f3a';
    const rawNamespace = 'tenant/secret-space';
    const rawPayload = 'RAW_PAYLOAD_INTERNAL_STATE_999888';
    const rawSecret = 'ghp_BACKEND_ECHO_TOKEN_1234567890abcdefgh';
    const rawPath = '/var/log/app/secrets/vault.key';

    const client = new FakeMirrorClient([{ name: 'write_note' }], rawServerId);
    client.callTool = async () => {
      throw new Error(
        `Backend failed: server=${rawServerId} namespace=${rawNamespace} payload=${rawPayload} secret=${rawSecret} path=${rawPath} ` +
          'extra-context-'.repeat(20)
      );
    };

    const store = makeStore(client);
    const result = await store.mirror([aggregate()]);

    expect(result.degraded).toBe(true);
    for (const diag of result.diagnostics) {
      expectWhitelistLine(diag);
      // Nothing from the backend echo may appear - not even masked remnants
      // of the example-specific strings (no per-example matching exists).
      expect(diag).not.toContain(rawServerId);
      expect(diag).not.toContain(rawNamespace);
      expect(diag).not.toContain('RAW_PAYLOAD');
      expect(diag).not.toContain(rawPayload);
      expect(diag).not.toContain(rawSecret);
      expect(diag).not.toContain(rawPath);
      expect(diag).not.toContain('mem0-prod');
      expect(diag).not.toContain('secret-space');
      expect(diag).toContain('serverRef=server:');
      expect(diag).toContain('namespaceRef=ns:');
    }
  });

  it('P6.1-B1: sanitizer keeps masking RAW_PAYLOAD shapes, secrets and paths in bounded text', () => {
    const rawNamespace = 'tenant/secret-space';
    const raw = `namespace=${rawNamespace} payload=${'RAW_PAYLOAD_XY_'.repeat(6)} secret=ghp_0123456789abcdefghijklmnopqrstuv path=/etc/vault/key.pem ${'tail '.repeat(60)}`;

    const diag = sanitizeDiagnostic(raw, { namespace: rawNamespace });

    expect(diag.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_LENGTH);
    expect(diag).toContain('<payload>');
    expect(diag).toContain('<secret>');
    expect(diag).toContain('<path>');
    expect(diag).not.toContain(rawNamespace);
    expect(diag).not.toContain('ghp_0123456789');
    // The explicit namespace context is masked with its hash reference.
    expect(diag).toContain(maskNamespaceForTest(rawNamespace));
  });

  it('degrades when enabled but no client is injected, with a whitelist diagnostic', async () => {
    const store = makeStore(undefined);

    const result = await store.mirror([aggregate()]);

    expect(result.written).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.degraded).toBe(true);
    expectWhitelistLine(result.diagnostics[0]!);
    expect(result.diagnostics[0]).toContain('code=no_client');
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

// ---------------------------------------------------------------------------
// P6.1-B1 acceptance: canary matrix through the real mirror() path
// ---------------------------------------------------------------------------

describe('P6.1-B1 canary matrix (real createJitBridgeMirrorStore().mirror() path)', () => {
  interface CanaryCase {
    readonly name: string;
    /** The canary body a (hostile) backend error would try to echo back. */
    readonly canary: string;
    /** Extra substrings that must never appear in any visible diagnostic. */
    readonly extraForbiddens?: readonly string[];
    /** Error factory - covers Error, string and nested-cause throws. */
    readonly throwValue: (canary: string) => unknown;
  }

  const canaryCases: readonly CanaryCase[] = [
    {
      name: 'chinese body',
      canary: '金丝雀载荷中文正文泄漏探针七三四一',
      throwValue: (c) => new Error('后端失败：' + c)
    },
    {
      name: 'english short sentence',
      canary: 'CANARY_ENGLISH_BODY_7341 leaked sentence',
      throwValue: (c) => new Error('backend exploded: ' + c)
    },
    {
      name: 'json body',
      canary: JSON.stringify({ canary: 'CANARY_JSON_7341', nested: { deep: 'leak' } }),
      extraForbiddens: ['CANARY_JSON_7341', '"nested"', '"deep"'],
      throwValue: (c) => new Error('invalid payload ' + c)
    },
    {
      name: 'newline body',
      canary: 'CANARY_LINE1_7341\nCANARY_LINE2_7341',
      extraForbiddens: ['CANARY_LINE1_7341', 'CANARY_LINE2_7341'],
      throwValue: (c) => new Error('multiline\n' + c)
    },
    {
      name: 'nested cause',
      canary: 'CANARY_CAUSE_BODY_7341',
      throwValue: (c) => {
        const cause = new Error('root cause carries ' + c);
        const wrapped = new Error('wrapped', { cause });
        return wrapped;
      }
    },
    {
      name: 'extreme length',
      canary: 'CANARY_LONG_' + 'Z'.repeat(4000) + '_7341',
      throwValue: (c) => new Error('huge ' + c)
    },
    {
      name: 'string throw',
      canary: 'CANARY_STRING_THROW_7341',
      throwValue: (c) => 'plain string throw: ' + c
    },
    {
      name: 'key and path canary',
      canary: 'token=CANARY_KEY_7341 path=C:\\\\Users\\\\canary\\\\secrets.txt',
      extraForbiddens: ['CANARY_KEY_7341', 'canary', 'secrets.txt'],
      throwValue: (c) => new Error('write rejected: ' + c)
    }
  ];

  for (const canaryCase of canaryCases) {
    it(`never echoes ${canaryCase.name} through any visible diagnostic exit`, async () => {
      const sinkLines: string[] = [];
      const client = new FakeMirrorClient();
      client.callTool = async () => {
        throw canaryCase.throwValue(canaryCase.canary);
      };
      const store = makeStore(client, {
        onDiagnostic: (line) => {
          sinkLines.push(line);
        }
      });

      const result = await store.mirror([
        aggregate({ bucket: 'task|canary_' + canaryCase.name.replace(/\s+/g, '_') })
      ]);

      expect(result.degraded).toBe(true);
      expectAllVisibleDiagnosticsWhitelisted(result, store, sinkLines);

      const allVisible = [...result.diagnostics, ...store.diagnostics(), ...sinkLines].join('\n');
      const forbiddens = [canaryCase.canary, ...(canaryCase.extraForbiddens ?? [])];
      for (const forbidden of forbiddens) {
        expect(allVisible, canaryCase.name + ' leaked via ' + forbidden).not.toContain(forbidden);
      }
      // The diagnostic must still be actionable: bounded code + operation.
      expect(result.diagnostics[0]).toContain('code=write_failed');
      expect(result.diagnostics[0]).toContain('operation=statWrite');
    });
  }

  it('varies with each case: canary bodies differ, refs stay stable correlation anchors', async () => {
    // The whitelist drops the error body at the throw boundary, so every
    // case's diagnostic is body-free; the per-call sequence restarts (by
    // design, nothing persists across mirror() calls) and the masked hash
    // refs stay stable, which is exactly their correlation role.
    const seenServerRefs = new Set<string>();
    for (const canaryCase of canaryCases) {
      const client = new FakeMirrorClient();
      client.callTool = async () => {
        throw canaryCase.throwValue(canaryCase.canary);
      };
      const store = makeStore(client);
      const result = await store.mirror([aggregate()]);
      const line = result.diagnostics[0]!;
      // The canary body never appears - the "variation" between cases is
      // proven by the forbidden-substring scan, not by echoing bodies.
      expect(line).not.toContain(canaryCase.canary.split(' ')[0]!.slice(0, 12));
      const serverRef = line.split(' ').find((field) => field.startsWith('serverRef='))!;
      seenServerRefs.add(serverRef);
      expect(serverRef).toBe('serverRef=server:6ee7c874');
    }
    // One stable hash for the same fake server across all cases.
    expect(seenServerRefs.size).toBe(1);
  });

  it('RAW_PAYLOAD echo shape is masked generically (kept rule), and no example-string branch is required', async () => {
    // A hostile backend echoing an arbitrary RAW_PAYLOAD-shaped token through
    // the sanitizer surface is masked by the kept generic shape rule; the
    // diagnostic line itself never carries it because the whitelist drops
    // the message body long before sanitization.
    const diag = sanitizeDiagnostic('echo RAW_PAYLOAD_CANARY_7341 tail');
    expect(diag).toContain('<payload>');
    expect(diag).not.toContain('RAW_PAYLOAD');

    // And on the real mirror path the whole body is gone anyway:
    const client = new FakeMirrorClient();
    client.callTool = async () => {
      throw new Error('RAW_PAYLOAD_CANARY_7341 body');
    };
    const store = makeStore(client);
    const result = await store.mirror([aggregate()]);
    const allVisible = [...result.diagnostics, ...store.diagnostics()].join('\n');
    expect(allVisible).not.toContain('RAW_PAYLOAD');
    expect(allVisible).not.toContain('7341');
  });

  it('keeps onDiagnostic sink failures from breaking mirroring', async () => {
    const client = new FakeMirrorClient();
    client.callTool = async () => {
      throw new Error('backend down');
    };
    const store = makeStore(client, {
      onDiagnostic: () => {
        throw new Error('sink is broken');
      }
    });

    const result = await store.mirror([aggregate()]);

    expect(result.degraded).toBe(true);
    expectWhitelistLine(result.diagnostics[0]!);
  });

  it('hash references are not treated as encrypted anonymization (documented correlation role)', () => {
    // Same input -> same short hash (stable correlation across lines) ...
    expect(maskNamespaceForTest('tenant/secret-space')).toBe(maskNamespaceForTest('tenant/secret-space'));
    // ... but different inputs keep distinct hashes and the hash is short,
    // i.e. invertible by enumeration - hence refs only, never "anonymized".
    expect(maskNamespaceForTest('tenant/secret-space')).not.toBe(maskNamespaceForTest('tenant/other-space'));
    expect(maskNamespaceForTest('tenant/secret-space')).toMatch(/^ns:[0-9a-f]{8}$/);
    expect(maskServerIdForTest('mem0-prod-server-7f3a')).toMatch(/^server:[0-9a-f]{8}$/);
  });
});
