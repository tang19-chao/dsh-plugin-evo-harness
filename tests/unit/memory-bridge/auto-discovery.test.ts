/**
 * Auto-discovery tests: fingerprint scoring selects the right driver family for
 * every required mock MCP family, honours explicit configuration, and never
 * binds a backend that cannot serve both recall and commit.
 */

import { describe, expect, it } from 'vitest';

import { autoDiscoverMemoryDriver, selectDriverFromServers } from '../../../src/memory-bridge/auto-discovery';
import { createMockServer, customMappedServer, graphEntityServer, lingshuServer, markdownNoteServer, temporalServer, vectorFactServer } from './mocks/mock-mcp';
import type { MockServer } from './mocks/mock-mcp';
import { memoryConfig } from './fixtures';

interface FamilyCase {
  readonly kind: string;
  readonly server: MockServer;
  readonly recallTool: string;
  readonly commitTool: string;
  readonly pruneTool?: string;
  readonly config?: Parameters<typeof memoryConfig>[0];
}

const familyCases: readonly FamilyCase[] = [
  {
    kind: 'graph_entity',
    server: graphEntityServer({ serverId: 'official_kg' }),
    recallTool: 'search_nodes',
    commitTool: 'create_entities',
    pruneTool: 'delete_entities'
  },
  {
    kind: 'vector_fact',
    server: vectorFactServer({ serverId: 'mem0' }),
    recallTool: 'search_memory',
    commitTool: 'add_memory',
    pruneTool: 'delete_memory'
  },
  {
    kind: 'temporal_graph',
    server: temporalServer({ serverId: 'graphiti' }),
    recallTool: 'search_facts',
    commitTool: 'add_episode',
    pruneTool: 'delete_episode'
  },
  {
    kind: 'markdown_note',
    server: markdownNoteServer({ serverId: 'basic_memory' }),
    recallTool: 'search_notes',
    commitTool: 'write_note',
    pruneTool: 'delete_note'
  },
  {
    kind: 'lingshu_mdcg',
    server: lingshuServer({ serverId: 'lingshu' }),
    recallTool: 'mdcg_recall',
    commitTool: 'cg',
    pruneTool: 'cg'
  },
  {
    kind: 'custom_mapped',
    server: customMappedServer({ serverId: 'my_custom' }),
    recallTool: 'my_custom_search',
    commitTool: 'my_custom_upsert',
    pruneTool: 'my_custom_purge',
    config: {
      customMapping: { enabled: true, recallToolName: 'my_custom_search', commitToolName: 'my_custom_upsert', pruneToolName: 'my_custom_purge' }
    }
  }
];

describe('auto-discovery', () => {
  it.each(familyCases)(
    'binds the $kind driver from tools/list fingerprints',
    async ({ kind, server, recallTool, commitTool, pruneTool, config }) => {
      const result = await autoDiscoverMemoryDriver({
        config: memoryConfig(config ?? {}),
        clients: [server.client]
      });
      expect(result.driver?.kind).toBe(kind);
      expect(result.descriptor.driverKind).toBe(kind);
      expect(result.descriptor.serverId).toBe(server.client.serverId);
      expect(result.selection.candidate?.binding.recall).toBe(recallTool);
      expect(result.selection.candidate?.binding.commit).toBe(commitTool);
      expect(result.selection.candidate?.binding.prune).toBe(pruneTool);
      expect(result.selection.candidates.length).toBeGreaterThan(0);
      expect(result.descriptor.diagnostics.join(' ')).toContain('selected ' + kind);
    }
  );

  it('prefers the highest scoring fingerprint on a multi-family server', () => {
    const tools = ['add_memory', 'search_memory', 'add_episode', 'search_facts'];
    const selection = selectDriverFromServers({
      config: memoryConfig(),
      servers: [{ serverId: 'multi', tools: tools.map((name) => ({ name })) }]
    });
    // temporal_graph scores 16 (3 matches + 2 strong), vector_fact 14.
    expect(selection.candidate?.kind).toBe('temporal_graph');
    expect(selection.candidate?.score).toBe(16);
    expect(selection.candidates.map((candidate) => candidate.kind)).toEqual([
      'temporal_graph',
      'vector_fact'
    ]);
  });

  it('breaks an exact score tie by the documented driver priority', () => {
    // graph_entity and vector_fact both score 2*2 + 5*2 = 14.
    const tools = ['search_nodes', 'create_entities', 'search_memory', 'add_memory'];
    const selection = selectDriverFromServers({
      config: memoryConfig(),
      servers: [{ serverId: 'multi', tools: tools.map((name) => ({ name })) }]
    });
    // temporal_graph also matches weakly (score 4) but never outranks the tie.
    expect(selection.candidates.map((candidate) => candidate.score)).toEqual([14, 14, 4]);
    expect(selection.candidate?.kind).toBe('graph_entity');
    expect(selection.candidates.map((candidate) => candidate.kind)).toEqual([
      'graph_entity',
      'vector_fact',
      'temporal_graph'
    ]);
  });

  it('respects an explicit mcpServerTarget', async () => {
    const graph = graphEntityServer({ serverId: 'official_kg' });
    const vector = vectorFactServer({ serverId: 'mem0' });
    const result = await autoDiscoverMemoryDriver({
      config: memoryConfig({ mcpServerTarget: 'official_kg' }),
      clients: [vector.client, graph.client]
    });
    expect(result.driver?.kind).toBe('graph_entity');
    expect(result.descriptor.serverId).toBe('official_kg');
    expect(result.descriptor.diagnostics.join(' ')).toContain('restricts discovery');
  });

  it('reports unbound when the configured server is not mounted', async () => {
    const result = await autoDiscoverMemoryDriver({
      config: memoryConfig({ mcpServerTarget: 'missing_server' }),
      clients: [vectorFactServer({ serverId: 'mem0' }).client]
    });
    expect(result.driver).toBeNull();
    expect(result.descriptor.driverKind).toBe('unbound');
    expect(result.descriptor.diagnostics.join(' ')).toContain('is not among the mounted MCP servers');
  });

  it('honours a driverHint that matches a mounted server', async () => {
    const graph = graphEntityServer({ serverId: 'official_kg' });
    const vector = vectorFactServer({ serverId: 'mem0' });
    const result = await autoDiscoverMemoryDriver({
      config: memoryConfig({ driverHint: 'graph_entity' }),
      clients: [vector.client, graph.client]
    });
    expect(result.driver?.kind).toBe('graph_entity');
    expect(result.descriptor.diagnostics.join(' ')).toContain('forced the driver family');
  });

  it('ignores a driverHint that matches nothing', async () => {
    const result = await autoDiscoverMemoryDriver({
      config: memoryConfig({ driverHint: 'markdown_note' }),
      clients: [vectorFactServer({ serverId: 'mem0' }).client]
    });
    expect(result.driver?.kind).toBe('vector_fact');
    expect(result.descriptor.diagnostics.join(' ')).toContain('did not match any mounted MCP memory server');
  });

  it('ignores a custom_mapped hint when customMapping is disabled', async () => {
    const result = await autoDiscoverMemoryDriver({
      config: memoryConfig({ driverHint: 'custom_mapped' }),
      clients: [customMappedServer({ serverId: 'my_custom' }).client]
    });
    expect(result.driver).toBeNull();
    expect(result.descriptor.diagnostics.join(' ')).toContain('customMapping.enabled is false');
  });

  it('leaves the bridge unbound for a server with no memory tools', async () => {
    const server = createMockServer([{ name: 'ping' }], { ping: () => ({ ok: true }) }, { serverId: 'unrelated' });
    const result = await autoDiscoverMemoryDriver({ config: memoryConfig(), clients: [server.client] });
    expect(result.driver).toBeNull();
    expect(result.descriptor.driverKind).toBe('unbound');
    expect(result.descriptor.capabilities).toEqual({
      metadataFiltering: false,
      namespaces: false,
      negativePolarity: false,
      temporal: false,
      supportsPrune: false
    });
  });

  it('skips a partial fingerprint without a usable recall/commit pair', async () => {
    const server = createMockServer(
      [{ name: 'search_nodes' }],
      { search_nodes: () => ({ entities: [] }) },
      { serverId: 'read_only_kg' }
    );
    const result = await autoDiscoverMemoryDriver({ config: memoryConfig(), clients: [server.client] });
    expect(result.driver).toBeNull();
    expect(result.descriptor.diagnostics.join(' ')).toContain('lacks a usable recall/commit tool pair');
  });

  it('breaks identical-fingerprint ties by server id', () => {
    const tools = ['add_memory', 'search_memory'];
    const selection = selectDriverFromServers({
      config: memoryConfig(),
      servers: [
        { serverId: 'zulu', tools: tools.map((name) => ({ name })) },
        { serverId: 'alpha', tools: tools.map((name) => ({ name })) }
      ]
    });
    expect(selection.serverId).toBe('alpha');
  });

  it('degrades when a tools/list call fails', async () => {
    const failing = {
      serverId: 'broken',
      async listTools(): Promise<never> {
        throw new Error('connection refused');
      },
      async callTool() {
        return { isError: true };
      }
    };
    const result = await autoDiscoverMemoryDriver({ config: memoryConfig(), clients: [failing] });
    expect(result.driver).toBeNull();
    expect(result.descriptor.diagnostics.join(' ')).toContain('tools/list failed for server "broken"');
  });
});
