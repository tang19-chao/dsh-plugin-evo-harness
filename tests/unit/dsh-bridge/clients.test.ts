/**
 * Unit tests for src/dsh-bridge/clients.ts — the tools-backed MCP client that
 * projects the DSH tool registry onto the plugin's frozen McpClient SPI.
 *
 * This module had ZERO test references (cross-audit TEST-1 residual): it is one
 * of the two modules swapped in when the plugin runs inside the real host, so a
 * regression here (a dropped tool, a mis-mapped error, a synthesized result
 * that hides a failure) would pass every other suite green. Everything below
 * runs against a FAKE ctx.tools — no real host, no network, no real DSH runtime.
 *
 * Covered per the audit's fix note: toMcpToolResult, listDshTools, the error
 * mapping, and the pure helpers (readDshTools / snapshotJsonValue / asJsonObject /
 * describeThrown) plus the createToolsBackedMcpClient call surface.
 */
import { describe, expect, it } from 'vitest';
import type { McpToolCallResult } from '../../../src/memory-bridge/spi';
import {
  DSH_TOOLS_SERVER_ID,
  asJsonObject,
  createToolsBackedMcpClient,
  describeThrown,
  listDshTools,
  readDshTools,
  snapshotJsonValue,
  toMcpToolResult,
  type DshToolDefinition,
  type DshToolExecution,
  type DshToolSchema,
  type DshToolsLike,
  type ToolsBackedMcpClient
} from '../../../src/dsh-bridge/clients';

/** A fake ToolRuntime exposing exactly the verified surface clients.ts codes against. */
function fakeTools(
  schemas: readonly DshToolSchema[],
  get?: (name: string) => DshToolDefinition | undefined
): DshToolsLike {
  return {
    schemas: () => schemas,
    get: get ?? (() => undefined)
  };
}

function schemaOf(name: string, extra: Partial<DshToolSchema> = {}): DshToolSchema {
  return { name, ...extra };
}

describe('readDshTools (guarded host read)', () => {
  it('returns undefined for a bare context and for a registry missing methods', () => {
    expect(readDshTools(null)).toBeUndefined();
    expect(readDshTools({})).toBeUndefined();
    expect(readDshTools({ tools: {} })).toBeUndefined();
    expect(readDshTools({ tools: { schemas: () => [] } })).toBeUndefined();
    expect(readDshTools({ tools: { get: () => undefined } })).toBeUndefined();
  });

  it('returns the registry when both schemas and get are functions', () => {
    const tools = fakeTools([]);
    const ctx = { tools };
    expect(readDshTools(ctx)).toBe(tools);
  });
});

describe('snapshotJsonValue (lossless JSON projection)', () => {
  it('keeps plain JSON data and drops functions, symbols and non-finite numbers', () => {
    const source = {
      text: 'ok',
      count: 3,
      flag: true,
      nothing: null,
      nested: { deep: ['a', 2] },
      fn: (): void => undefined,
      sym: Symbol('tag'),
      bad: Number.NaN,
      infinite: Number.POSITIVE_INFINITY
    };
    const snapshot = snapshotJsonValue(source) as Record<string, unknown>;
    expect(snapshot['text']).toBe('ok');
    expect(snapshot['count']).toBe(3);
    expect(snapshot['flag']).toBe(true);
    expect(snapshot['nothing']).toBeNull();
    expect(snapshot['nested']).toEqual({ deep: ['a', 2] });
    // The non-representable members are dropped, never passed through.
    expect('fn' in snapshot).toBe(false);
    expect('sym' in snapshot).toBe(false);
    expect('bad' in snapshot).toBe(false);
    expect('infinite' in snapshot).toBe(false);
  });

  it('drops a throwing accessor instead of throwing (the documented never-throw contract)', () => {
    const evil: Record<string, unknown> = { ok: 1 };
    Object.defineProperty(evil, 'exploding', {
      enumerable: true,
      get() {
        throw new Error('accessor blew up');
      }
    });
    const snapshot = snapshotJsonValue(evil) as Record<string, unknown>;
    expect(snapshot).toEqual({ ok: 1 });
    expect('exploding' in snapshot).toBe(false);
  });

  it('bounds cyclic references at the depth limit instead of throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic['self'] = cyclic;
    const snapshot = snapshotJsonValue(cyclic) as Record<string, unknown>;
    expect(snapshot['name']).toBe('root');
    // The projection terminates: walking `self` reaches a copy WITHOUT the
    // cycle key (the docstring's depth bound dropped it) instead of recursing
    // forever or throwing.
    let depth = 0;
    let node: unknown = snapshot;
    while (node !== null && typeof node === 'object' && 'self' in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)['self'];
      depth += 1;
      expect(depth).toBeLessThan(100);
    }
    expect(depth).toBeGreaterThan(0);
    expect(node).toEqual({ name: 'root' });
  });
});

describe('asJsonObject', () => {
  it('projects objects and refuses arrays, scalars and null', () => {
    expect(asJsonObject({ a: 1 })).toEqual({ a: 1 });
    expect(asJsonObject({ a: (): void => undefined })).toEqual({});
    expect(asJsonObject([1, 2])).toBeUndefined();
    expect(asJsonObject('text')).toBeUndefined();
    expect(asJsonObject(42)).toBeUndefined();
    expect(asJsonObject(null)).toBeUndefined();
  });
});

describe('describeThrown', () => {
  it('renders errors, strings and plain objects', () => {
    expect(describeThrown(new TypeError('nope'))).toBe('TypeError: nope');
    expect(describeThrown('plain string')).toBe('plain string');
    expect(describeThrown({ code: 7 })).toBe('{"code":7}');
  });
});

describe('listDshTools (error mapping)', () => {
  it('reports an unavailable registry with a named diagnostic', () => {
    const catalog = listDshTools({});
    expect(catalog.available).toBe(false);
    expect(catalog.tools).toEqual([]);
    expect(catalog.names).toEqual([]);
    expect(catalog.diagnostics).toHaveLength(1);
    expect(catalog.diagnostics[0]).toContain('ctx.tools is unavailable');
  });

  it('maps a throwing schemas() call to an empty catalogue with the thrown reason', () => {
    const ctx = {
      tools: {
        schemas: () => {
          throw new Error('registry offline');
        },
        get: () => undefined
      }
    };
    const catalog = listDshTools(ctx, 'scope-a');
    expect(catalog.available).toBe(true);
    expect(catalog.scope).toBe('scope-a');
    expect(catalog.tools).toEqual([]);
    expect(catalog.diagnostics).toHaveLength(1);
    expect(catalog.diagnostics[0]).toContain('ctx.tools.schemas() threw');
    expect(catalog.diagnostics[0]).toContain('Error: registry offline');
  });

  it('treats a non-array schemas() result as an empty catalogue', () => {
    const ctx = { tools: { schemas: () => 'not an array', get: () => undefined } };
    const catalog = listDshTools(ctx);
    expect(catalog.available).toBe(true);
    expect(catalog.tools).toEqual([]);
    expect(catalog.diagnostics.join(' ')).toContain('no registered tools');
  });

  it('skips a schema without a usable name and keeps the rest', () => {
    const ctx = {
      tools: fakeTools([
        // A malformed registry entry: the runtime object has no name, even
        // though the declared schema requires one.
        { description: 'nameless' } as unknown as DshToolSchema,
        schemaOf('cg', { description: 'cognitive graph' })
      ])
    };
    const catalog = listDshTools(ctx);
    expect(catalog.names).toEqual(['cg']);
    expect(catalog.tools).toEqual([
      { name: 'cg', description: 'cognitive graph' }
    ]);
    expect(catalog.diagnostics.join(' ')).toContain('without a usable name');
  });

  it('projects parameters through the lossless snapshot onto inputSchema', () => {
    const ctx = {
      tools: fakeTools([
        schemaOf('stg', { parameters: { op: 'write', limit: 3, callback: (): void => undefined } })
      ])
    };
    const catalog = listDshTools(ctx);
    expect(catalog.tools[0]?.inputSchema).toEqual({ op: 'write', limit: 3 });
  });

  it('names the empty-registry condition instead of reporting a silent zero', () => {
    const catalog = listDshTools({ tools: fakeTools([]) });
    expect(catalog.available).toBe(true);
    expect(catalog.tools).toEqual([]);
    expect(catalog.diagnostics.join(' ')).toContain('the memory bridge will stay unbound');
  });
});

describe('toMcpToolResult (result and error mapping)', () => {
  it('wraps a bare JSON return value as a successful structured result', () => {
    expect(toMcpToolResult('plain')).toEqual({
      content: [],
      isError: false,
      structuredContent: 'plain'
    });
    expect(toMcpToolResult(42)).toMatchObject({ isError: false, structuredContent: 42 });
    expect(toMcpToolResult(null)).toMatchObject({ isError: false, structuredContent: null });
    expect(toMcpToolResult(undefined)).toEqual({ content: [], isError: false });
  });

  it('keeps text blocks, drops non-object blocks and snapshots other block kinds', () => {
    const result = toMcpToolResult({
      content: [
        { type: 'text', text: 'hello' },
        42,
        null,
        { type: 'resource', uri: 'file:///notes/a.md' }
      ]
    });
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'resource', uri: 'file:///notes/a.md' }
    ]);
  });

  it('synthesizes the error text from error.message when an error carries no blocks', () => {
    const result = toMcpToolResult({ isError: true, error: { message: 'registry offline' } });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'Error: registry offline' }]);
  });

  it('falls back to the generic failure text when an error carries no message', () => {
    const result = toMcpToolResult({ isError: true });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'Error: tool execution failed' }]);
  });

  it('keeps existing blocks on an error result and carries the structured value', () => {
    const result = toMcpToolResult({
      isError: true,
      content: [{ type: 'text', text: 'quota exceeded' }],
      value: { code: 'RATE_LIMIT' }
    });
    expect(result.content).toEqual([{ type: 'text', text: 'quota exceeded' }]);
    expect(result.structuredContent).toEqual({ code: 'RATE_LIMIT' });
  });
});

describe('createToolsBackedMcpClient (the SPI face over ctx.tools)', () => {
  function textResult(result: McpToolCallResult): string {
    const block = result.content?.[0] as { text?: unknown } | undefined;
    return typeof block?.text === 'string' ? block.text : '';
  }

  it('defaults the server id and snapshots the catalogue at construction', () => {
    const diagnostics: string[] = [];
    const client = createToolsBackedMcpClient(
      { tools: fakeTools([schemaOf('cg')]) },
      { onDiagnostic: (message) => diagnostics.push(message) }
    );
    expect(client.serverId).toBe(DSH_TOOLS_SERVER_ID);
    expect(client.catalog.names).toEqual(['cg']);
    expect(diagnostics).toEqual([]);
  });

  it('reports construction-time diagnostics once and never re-reports known ones', async () => {
    const diagnostics: string[] = [];
    const ctx = { tools: fakeTools([]) };
    const client = createToolsBackedMcpClient(ctx, { onDiagnostic: (message) => diagnostics.push(message) });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain('no registered tools');
    await client.listTools();
    await client.listTools();
    // The live projection still sees the same empty registry; the diagnostic
    // must not be duplicated per listTools() call.
    expect(diagnostics).toHaveLength(1);
    expect(client.catalog.names).toEqual([]);
  });

  it('listTools returns the LIVE projection while the construction catalog stays stale', async () => {
    const schemas: DshToolSchema[] = [schemaOf('cg')];
    const ctx = { tools: fakeTools(schemas) };
    const client = createToolsBackedMcpClient(ctx);
    schemas.push(schemaOf('stg'));
    const live = await client.listTools();
    expect(live.map((tool) => tool.name)).toEqual(['cg', 'stg']);
    expect(client.catalog.names).toEqual(['cg']);
  });

  it('callTool executes the registered definition and maps the result through toMcpToolResult', async () => {
    const seen: Array<{ args: unknown; exec: DshToolExecution }> = [];
    const signal = new AbortController().signal;
    const ctx = {
      tools: fakeTools([schemaOf('cg')], (name) => ({
        name,
        execute(args: unknown, exec: DshToolExecution) {
          seen.push({ args, exec });
          return { content: [{ type: 'text', text: 'accepted ' + String(exec.callId) }], value: { verdict: 'accept' } };
        }
      }))
    };
    const client: ToolsBackedMcpClient = createToolsBackedMcpClient(ctx, {
      newCallId: () => 'call-fixed-1'
    });
    const result = await client.callTool('cg', { op: 'write', content: 'lesson body' }, { signal });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.args).toEqual({ op: 'write', content: 'lesson body' });
    expect(seen[0]?.exec.callId).toBe('call-fixed-1');
    expect(seen[0]?.exec.name).toBe('cg');
    expect(seen[0]?.exec.arguments).toEqual({ op: 'write', content: 'lesson body' });
    expect(seen[0]?.exec.signal).toBe(signal);
    expect(result.isError).toBe(false);
    expect(textResult(result)).toBe('accepted call-fixed-1');
    expect(result.structuredContent).toEqual({ verdict: 'accept' });
  });

  it('maps a throwing definition to a structured error result instead of a rejection', async () => {
    const ctx = {
      tools: fakeTools([schemaOf('cg')], () => ({
        execute() {
          throw new Error('backend exploded');
        }
      }))
    };
    const client = createToolsBackedMcpClient(ctx);
    const result = await client.callTool('cg', {});
    expect(result.isError).toBe(true);
    expect(textResult(result)).toContain('backend exploded');
  });

  it('rejects an unregistered tool with a named error', async () => {
    const client = createToolsBackedMcpClient({ tools: fakeTools([schemaOf('cg')]) });
    await expect(client.callTool('stg', {})).rejects.toThrow(
      /tool "stg" is not registered in the DSH tool registry/
    );
  });

  it('wraps a throwing registry lookup with the tool name and cause', async () => {
    const ctx = {
      tools: {
        schemas: () => [schemaOf('cg')],
        get: () => {
          throw new Error('registry proxy wedged');
        }
      }
    };
    const client = createToolsBackedMcpClient(ctx);
    await expect(client.callTool('cg', {})).rejects.toThrow(
      /ctx\.tools\.get\("cg"\) threw: Error: registry proxy wedged/
    );
  });

  it('rejects with the named unavailable error when the registry vanishes from the context', async () => {
    const ctx: Record<string, unknown> = { tools: fakeTools([schemaOf('cg')]) };
    const client = createToolsBackedMcpClient(ctx);
    expect(client.serverId).toBe('dsh-tools');
    delete ctx['tools'];
    await expect(client.callTool('cg', {})).rejects.toThrow(
      /dsh-tools: cannot call "cg" because ctx\.tools is unavailable/
    );
  });

  it('gives a registry-less context a client whose callTool throws descriptively', async () => {
    const client = createToolsBackedMcpClient({});
    expect(await client.listTools()).toEqual([]);
    await expect(client.callTool('cg', {})).rejects.toThrow(/ctx\.tools is unavailable/);
  });
});
