/**
 * P4-1/P4-3: the writable three-state handshake must be side-effect free, must
 * never default to 'yes', and must render Recall-Only for every non-yes state.
 *
 * The handshake is a pure function over data the caller already holds, so the
 * discriminative checks are:
 *   (1) the verdict flips ONLY on the documented evidence (permission, bound
 *       driver, advertised commit tool, schema properties);
 *   (2) the full discovery->handshake sequence records zero tools/call traffic
 *       and zero stored records on a recording mock backend;
 *   (3) the module source itself imports no filesystem module and calls no
 *       tool, so "no temp files / no write" is structural, not incidental.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { MemoryBridgeDescriptor } from '../../../src/types/contracts';
import {
  MEMORY_WRITABLE_STATES,
  RECALL_ONLY_LABEL,
  READ_WRITE_LABEL,
  autoDiscoverMemoryDriver,
  resolveMemoryWritableStatus,
  type MemoryBridgeStatusInput,
  type McpToolDescriptor
} from '../../../src/memory-bridge';
import { resolveExecutionProfile } from '../../../src/runtime/execution-profile';
import { memoryConfig } from './fixtures';
import { vectorFactServer } from './mocks/mock-mcp';

const TOOLS: readonly McpToolDescriptor[] = [
  { name: 'search_memory', inputSchema: { properties: { query: { type: 'string' } } } },
  {
    name: 'add_memory',
    inputSchema: { properties: { text: { type: 'string' }, user_id: { type: 'string' } } }
  },
  { name: 'delete_memory', inputSchema: { properties: { ids: { type: 'array' } } } }
];

const BINDING = { recall: 'search_memory', commit: 'add_memory', prune: 'delete_memory' } as const;

const DESCRIPTOR: MemoryBridgeDescriptor = {
  driverKind: 'vector_fact',
  serverId: 'mem0',
  backendLabel: 'mock vector/fact memory',
  capabilities: {
    metadataFiltering: true,
    namespaces: true,
    negativePolarity: true,
    temporal: false,
    supportsPrune: true
  },
  boundAt: 0,
  diagnostics: []
};

const ALLOWED = { allowed: true, reason: 'explicit test assembly permission' } as const;
const DENIED = {
  allowed: false,
  reason: 'real memory writes are never granted in this round (ADR 0002 R2)'
} as const;

function status(overrides: Partial<MemoryBridgeStatusInput> = {}) {
  return resolveMemoryWritableStatus({
    descriptor: DESCRIPTOR,
    tools: TOOLS,
    binding: BINDING,
    permission: ALLOWED,
    ...overrides
  });
}

describe('writable handshake: three states', () => {
  it('declares exactly the frozen three states', () => {
    expect([...MEMORY_WRITABLE_STATES]).toEqual(['yes', 'no', 'unknown']);
  });

  it('reports yes only when permission, commit tool and schema all confirm', () => {
    const result = status();
    expect(result.writable).toBe('yes');
    expect(result.mode).toBe('read-write');
    expect(result.label).toBe(READ_WRITE_LABEL);
    expect(result.reason).toContain('add_memory');
    expect(result.diagnostics.join(' | ')).toContain('2 top-level input property(ies)');
  });

  it('uses the fingerprinted commit candidate when no binding is supplied', () => {
    const result = status({ binding: null });
    expect(result.writable).toBe('yes');
    expect(result.reason).toContain('add_memory');
  });

  it('accepts a discovery result (descriptor + tools + selection) directly', () => {
    const result = status({
      descriptor: null,
      tools: null,
      binding: null,
      discovery: { descriptor: DESCRIPTOR, tools: TOOLS, selection: { candidate: { binding: BINDING } } }
    });
    expect(result.writable).toBe('yes');
  });

  it('accepts the REAL resolved execution profile object (t23 wiring shape)', () => {
    const discovery = { descriptor: DESCRIPTOR, tools: TOOLS, selection: { candidate: { binding: BINDING } } };
    const allowed = resolveMemoryWritableStatus({
      discovery,
      profile: resolveExecutionProfile({ memoryRealWrites: true })
    });
    expect(allowed.writable).toBe('yes');
    expect(allowed.mode).toBe('read-write');

    const denied = resolveMemoryWritableStatus({ discovery, profile: resolveExecutionProfile() });
    expect(denied.writable).toBe('no');
    expect(denied.mode).toBe('recall-only');
    expect(denied.label).toBe(RECALL_ONLY_LABEL);
  });

  it('stays unknown when the permission is not resolved', () => {
    const result = status({ permission: null });
    expect(result.writable).toBe('unknown');
    expect(result.mode).toBe('recall-only');
    expect(result.reason).toContain('permission is not resolved');
  });

  it('stays unknown when tools/list was never supplied', () => {
    const result = status({ tools: [] });
    expect(result.writable).toBe('unknown');
    expect(result.diagnostics.join(' ')).toContain('tools/list was not supplied');
  });

  it('stays unknown when the commit tool declares no input property', () => {
    const result = status({ tools: [{ name: 'add_memory' }] });
    expect(result.writable).toBe('unknown');
    expect(result.reason).toContain('declares no top-level input property');
  });

  it('stays unknown for the custom-mapped family without its configured binding', () => {
    const result = status({
      descriptor: { ...DESCRIPTOR, driverKind: 'custom_mapped' },
      binding: null,
      tools: [{ name: 'my_custom_upsert', inputSchema: { properties: { my_text: { type: 'string' } } } }]
    });
    expect(result.writable).toBe('unknown');
    expect(result.reason).toContain('custom-mapped');
  });

  it('reports no when the resolved permission denies writes', () => {
    const result = status({ permission: DENIED });
    expect(result.writable).toBe('no');
    expect(result.label).toBe(RECALL_ONLY_LABEL);
    expect(result.reason).toContain('memory writes are denied');
    expect(result.reason).toContain('ADR 0002 R2');
  });

  it('denial outranks the missing-descriptor unknown state (fail-closed ordering)', () => {
    const result = resolveMemoryWritableStatus({ permission: DENIED });
    expect(result.writable).toBe('no');
    expect(result.label).toBe(RECALL_ONLY_LABEL);
    expect(result.reason).toContain('memory writes are denied');
  });

  it('reports no when the memory backend is unbound', () => {
    const result = status({
      descriptor: { ...DESCRIPTOR, driverKind: 'unbound', serverId: null, backendLabel: 'unbound' }
    });
    expect(result.writable).toBe('no');
    expect(result.reason).toContain('unbound');
  });

  it('reports no when tools/list advertises no commit-capable tool', () => {
    const result = status({
      binding: null,
      tools: [{ name: 'search_memory', inputSchema: { properties: { query: { type: 'string' } } } }]
    });
    expect(result.writable).toBe('no');
    expect(result.reason).toContain('no commit-capable tool');
  });

  it('reports no when the binding names a commit tool the server does not advertise', () => {
    const result = status({
      tools: [{ name: 'search_memory', inputSchema: { properties: { query: { type: 'string' } } } }]
    });
    expect(result.writable).toBe('no');
    expect(result.reason).toContain('not advertised');
  });

  it('never defaults to yes: an empty input is unknown', () => {
    const result = resolveMemoryWritableStatus();
    expect(result.writable).toBe('unknown');
    expect(result.mode).toBe('recall-only');
    expect(result.label).toBe(RECALL_ONLY_LABEL);
  });

  it('renders Recall-Only for every non-yes state and keeps unknown distinct from no', () => {
    const unknown = status({ permission: null });
    const no = status({ permission: DENIED });
    const yes = status();

    expect(unknown.label).toBe(RECALL_ONLY_LABEL);
    expect(no.label).toBe(RECALL_ONLY_LABEL);
    expect(yes.label).toBe(READ_WRITE_LABEL);
    expect(unknown.mode).toBe('recall-only');
    expect(no.mode).toBe('recall-only');

    // unknown and no are distinguishable by field AND by reason, not only text.
    expect(unknown.writable).toBe('unknown');
    expect(no.writable).toBe('no');
    expect(unknown.reason).not.toBe(no.reason);
  });
});

describe('writable handshake: no side effects', () => {
  it('performs zero tools/call traffic, zero writes and is deterministic', async () => {
    const server = vectorFactServer({ serverId: 'mem0' });
    const config = memoryConfig();
    const discovery = await autoDiscoverMemoryDriver({
      config,
      clients: [server.client],
      now: () => 0
    });
    expect(discovery.descriptor.driverKind).toBe('vector_fact');
    expect(discovery.tools.length).toBeGreaterThan(0);

    const callsBefore = server.calls.length;
    const listsBefore = server.listToolsCalls;
    const recordsBefore = server.store.length;

    const profile = { permissions: { memory: ALLOWED } };
    const first = resolveMemoryWritableStatus({ discovery, profile });
    const second = resolveMemoryWritableStatus({ discovery, profile });

    expect(first.writable).toBe('yes');
    expect(first).not.toBeInstanceOf(Promise);
    expect(second).toEqual(first);

    // The handshake touched neither the tool surface nor the stored records.
    expect(server.calls.length).toBe(callsBefore);
    expect(server.listToolsCalls).toBe(listsBefore);
    expect(server.store.length).toBe(recordsBefore);
  });

  it('is structurally I/O free: the module imports no filesystem and calls no tool', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../src/memory-bridge/status.ts', import.meta.url)),
      'utf8'
    );
    // No filesystem module => it cannot create a temp file or write anything.
    expect(source).not.toMatch(/from\s+'node:fs'|from\s+'fs'|require\(\s*'fs'\s*\)/);
    // No tool invocation => the handshake cannot reach a backend.
    expect(source).not.toMatch(/\.callTool\s*\(/);
    expect(source).not.toMatch(/writeFileSync\s*\(|appendFileSync\s*\(|mkdirSync\s*\(|createWriteStream\s*\(/);
    // No ambient clock: the verdict is a function of the supplied data only.
    expect(source).not.toMatch(/Date\.now\s*\(|new Date\s*\(/);
  });
});
