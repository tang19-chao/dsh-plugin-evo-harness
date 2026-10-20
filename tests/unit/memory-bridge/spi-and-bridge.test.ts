/**
 * SPI + bridge facade tests: the MCP client boundary is injectable/mockable and
 * recall/commit/promote map onto it; unbound backends degrade deterministically.
 */

import { describe, expect, it } from 'vitest';

import { createDriverContext } from '../../../src/memory-bridge/auto-discovery';
import { createMemoryBridge } from '../../../src/memory-bridge/bridge';
import { createDriverForKind } from '../../../src/memory-bridge/drivers/index';
import type { McpClient, McpToolDescriptor } from '../../../src/memory-bridge/spi';
import type { IMemoryBridge } from '../../../src/types/contracts';
import { vectorFactServer } from './mocks/mock-mcp';
import {
  BRANCH_A_NS,
  FIXED_NOW,
  GLOBAL_NS,
  branchScope,
  globalLesson,
  memoryConfig,
  validLesson
} from './fixtures';

describe('SPI boundary', () => {
  it('is satisfied by a hand-rolled plain-object client (no host types)', async () => {
    const tools: readonly McpToolDescriptor[] = [
      {
        name: 'search_memory',
        inputSchema: { properties: { query: { type: 'string' } } }
      },
      {
        name: 'add_memory',
        inputSchema: { properties: { text: { type: 'string' }, user_id: { type: 'string' } } }
      }
    ];
    const calls: string[] = [];
    const client: McpClient = {
      serverId: 'hand-rolled',
      async listTools() {
        return tools;
      },
      async callTool(name: string) {
        calls.push(name);
        if (name === 'search_memory') {
          return { content: [{ type: 'text', text: JSON.stringify({ results: [] }) }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
      }
    };
    const bridge = createMemoryBridge({ config: memoryConfig(), clients: [client] });
    const descriptor = await bridge.initialize();
    expect(descriptor.driverKind).toBe('vector_fact');
    const commit = await bridge.commit(validLesson(), { scope: branchScope() });
    expect(commit.accepted).toBe(true);
    await bridge.recall({ scope: branchScope(), text: 'tool argument validation' });
    expect(calls).toContain('add_memory');
    expect(calls).toContain('search_memory');
  });
});

describe('driver SPI', () => {
  it('is driven directly by a hand-built context (no host, no bridge)', async () => {
    const server = vectorFactServer({ serverId: 'mem0' });
    const tools = await server.client.listTools();
    const binding = { recall: 'search_memory', commit: 'add_memory' };
    const context = createDriverContext(server.client, tools, memoryConfig(), binding, () => FIXED_NOW);
    const driver = createDriverForKind('vector_fact', binding);
    expect(driver?.kind).toBe('vector_fact');
    expect(driver?.binding.recall).toBe('search_memory');
    expect(driver?.capabilities.metadataFiltering).toBe(true);

    const write = await driver?.commit(context, {
      lesson: validLesson(),
      namespace: BRANCH_A_NS,
      now: FIXED_NOW
    });
    expect(write?.persisted).toBe(true);

    const read = await driver?.recall(context, {
      query: { scope: branchScope(), text: 'tool argument validation' },
      namespace: BRANCH_A_NS,
      namespaces: [BRANCH_A_NS],
      limit: 5,
      fingerprint: 'tool argument validation',
      now: FIXED_NOW
    });
    expect(read?.records.map((record) => record.lesson.id)).toEqual(['L-1']);
  });

  it('lets a fake MCP client fail without leaking host errors', async () => {
    const client: McpClient = {
      serverId: 'flaky',
      async listTools() {
        return [{ name: 'search_memory' }, { name: 'add_memory' }];
      },
      async callTool(name: string) {
        return { isError: true, content: [{ type: 'text', text: name + ' exploded' }] };
      }
    };
    const bridge = createMemoryBridge({ config: memoryConfig(), clients: [client] });
    await bridge.initialize();
    const commit = await bridge.commit(validLesson(), { scope: branchScope() });
    expect(commit.accepted).toBe(false);
    expect(commit.persisted).toBe(false);
    expect(commit.violations[0]?.severity).toBe('block');
  });
});

describe('UniversalMemoryBridge', () => {
  it('structurally satisfies the frozen IMemoryBridge facade', async () => {
    const bridge: IMemoryBridge = createMemoryBridge({ config: memoryConfig(), clients: [] });
    expect(typeof bridge.initialize).toBe('function');
    expect(typeof bridge.recall).toBe('function');
    expect(typeof bridge.commit).toBe('function');
    expect(typeof bridge.isolate).toBe('function');
    expect(typeof bridge.promote).toBe('function');
    expect(typeof bridge.prune).toBe('function');
    expect(typeof bridge.dispose).toBe('function');
    expect(bridge.descriptor.driverKind).toBe('unbound');
    const inserted: IMemoryBridge = bridge;
    expect(inserted).toBe(bridge);
  });

  it('maps recall, commit and branch promotion onto the injected MCP client', async () => {
    const server = vectorFactServer({ serverId: 'mem0' });
    const bridge = createMemoryBridge({
      config: memoryConfig({ recallLimit: 6, namespacePrefix: 'harness2' }),
      clients: [server.client],
      now: () => FIXED_NOW
    });
    const descriptor = await bridge.initialize();
    expect(descriptor.driverKind).toBe('vector_fact');
    expect(descriptor.serverId).toBe('mem0');
    expect(descriptor.backendLabel).toContain('vector');
    expect(descriptor.capabilities).toEqual({
      metadataFiltering: true,
      namespaces: true,
      negativePolarity: true,
      temporal: false,
      supportsPrune: true
    });

    const commit = await bridge.commit(validLesson(), { scope: branchScope() });
    expect(commit.accepted).toBe(true);
    expect(commit.persisted).toBe(true);
    expect(commit.namespace).toBe(BRANCH_A_NS);
    expect(commit.driverKind).toBe('vector_fact');

    const writeCall = server.lastCall('add_memory');
    expect(writeCall).toBeDefined();
    expect(String(writeCall?.args.text)).toContain('# 功能名：Pin the failing tool signature');
    const metadata = writeCall?.args.metadata as Record<string, unknown>;
    expect(metadata.namespace).toBe(BRANCH_A_NS);
    expect(metadata.polarity).toBe('positive');
    expect(metadata.whenNotToApply).toEqual(['offline sandbox']);
    expect(writeCall?.args.user_id).toBe(BRANCH_A_NS);

    const recall = await bridge.recall({ scope: branchScope(), text: 'tool keeps failing argument validation' });
    expect(recall.driverKind).toBe('vector_fact');
    expect(recall.positiveLessons.map((lesson) => lesson.id)).toEqual(['L-1']);
    expect(recall.negativeLessons).toEqual([]);
    expect(recall.lessons.length).toBe(recall.positiveLessons.length + recall.negativeLessons.length);
    expect(recall.confidence).toBeCloseTo(0.9, 6);
    expect(recall.degraded).toBe(false);

    const promoted = await bridge.promote(validLesson(), { from: branchScope() });
    expect(promoted.accepted).toBe(true);
    expect(promoted.persisted).toBe(true);
    expect(promoted.namespace).toBe(GLOBAL_NS);
    const globalWrite = server.callsTo('add_memory').at(-1);
    expect((globalWrite?.args.metadata as Record<string, unknown>).namespace).toBe(GLOBAL_NS);
    expect(server.callsTo('delete_memory').length).toBeGreaterThan(0);
    expect(server.store.filter((record) => record.namespace === BRANCH_A_NS)).toHaveLength(0);

    const globalRecall = await bridge.recall({ scope: branchScope('s-1', 'b-2'), text: 'tool argument validation' });
    expect(globalRecall.positiveLessons.map((lesson) => lesson.id)).toEqual(['L-1']);
  });

  it('degrades deterministically when no MCP memory driver is bound', async () => {
    const bridge = createMemoryBridge({ config: memoryConfig(), clients: [], now: () => FIXED_NOW });
    const descriptor = await bridge.initialize();
    expect(descriptor.driverKind).toBe('unbound');
    expect(descriptor.serverId).toBeNull();
    expect(descriptor.capabilities.namespaces).toBe(false);

    const recall = await bridge.recall({ scope: { kind: 'global' }, text: 'anything' });
    expect(recall.degraded).toBe(true);
    expect(recall.confidence).toBe(0);
    expect(recall.lessons).toEqual([]);
    expect(recall.diagnostics.join(' ')).toContain('no MCP memory driver is bound');

    const commit = await bridge.commit(globalLesson(), { scope: { kind: 'global' } });
    expect(commit.accepted).toBe(false);
    expect(commit.persisted).toBe(false);
    expect(commit.violations.map((violation) => violation.code)).toContain('unsupported_operation');

    const prune = await bridge.prune({ scope: { kind: 'global' } });
    expect(prune).toEqual({ scanned: 0, removedIds: [], dryRun: false });
  });

  it('reports an unbound descriptor before initialize and initializes lazily', async () => {
    const server = vectorFactServer({ serverId: 'mem0' });
    const bridge = createMemoryBridge({ config: memoryConfig(), clients: [server.client] });
    expect(bridge.initialized).toBe(false);
    expect(bridge.descriptor.driverKind).toBe('unbound');
    expect(bridge.descriptor.diagnostics.join(' ')).toContain('auto-discovery has not run yet');
    const recall = await bridge.recall({ scope: branchScope(), text: 'x' });
    expect(bridge.initialized).toBe(true);
    expect(recall.driverKind).toBe('vector_fact');
    expect(server.listToolsCalls).toBe(1);
  });

  it('creates deterministic isolated namespaces with an idempotent release', async () => {
    const bridge = createMemoryBridge({ config: memoryConfig(), clients: [] });
    const handleA = await bridge.isolate(branchScope('s-1', 'b-1'));
    const handleB = await bridge.isolate(branchScope('s-1', 'b-2'));
    expect(handleA.namespace).toBe(BRANCH_A_NS);
    expect(handleB.namespace).toBe('harness2:branch:s-1:b-2');
    expect(handleA.active).toBe(true);
    await handleA.release();
    await handleA.release();
    expect(handleA.active).toBe(false);
    expect(handleB.active).toBe(true);
    expect(bridge.activeNamespaces()).toEqual(['harness2:branch:s-1:b-2']);
  });

  it('stops touching the backend after dispose', async () => {
    const server = vectorFactServer({ serverId: 'mem0' });
    const bridge = createMemoryBridge({ config: memoryConfig(), clients: [server.client], now: () => FIXED_NOW });
    await bridge.initialize();
    const before = server.calls.length;
    await bridge.dispose();
    await bridge.dispose();
    expect(bridge.disposed).toBe(true);
    const recall = await bridge.recall({ scope: branchScope(), text: 'x' });
    expect(recall.degraded).toBe(true);
    expect(recall.diagnostics.join(' ')).toContain('disposed');
    const commit = await bridge.commit(validLesson(), { scope: branchScope() });
    expect(commit.accepted).toBe(false);
    expect(server.calls.length).toBe(before);
  });
});
