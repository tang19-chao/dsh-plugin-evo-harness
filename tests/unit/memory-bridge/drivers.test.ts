/**
 * Per-family driver tests: every required mock MCP family is exercised through
 * the bridge, asserting tool names, argument mapping, round-trip fidelity,
 * prune behaviour and native-gate rejection handling.
 */

import { describe, expect, it } from 'vitest';

import { createMemoryBridge } from '../../../src/memory-bridge/bridge';
import { createDriverForKind, DRIVER_FINGERPRINTS } from '../../../src/memory-bridge/drivers/index';
import { MEMORY_DRIVER_KINDS } from '../../../src/types/contracts';
import type { MemoryBridgeConfig } from '../../../src/config';
import {
  customMappedServer,
  graphEntityServer,
  lingshuServer,
  markdownNoteServer,
  temporalServer,
  vectorFactServer
} from './mocks/mock-mcp';
import type { MockCall, MockServer } from './mocks/mock-mcp';
import { BRANCH_A_NS, FIXED_NOW, branchScope, memoryConfig, validLesson } from './fixtures';

interface DriverCase {
  readonly family: string;
  readonly makeServer: () => MockServer;
  readonly config: () => MemoryBridgeConfig;
  readonly recallTool: string;
  readonly commitTool: string;
  readonly pruneTool: string;
  readonly assertCommit: (call: MockCall, server: MockServer) => void;
}

const driverCases: readonly DriverCase[] = [
  {
    family: 'graph_entity',
    makeServer: () => graphEntityServer({ serverId: 'official_kg' }),
    config: memoryConfig,
    recallTool: 'search_nodes',
    commitTool: 'create_entities',
    pruneTool: 'delete_entities',
    assertCommit: (call, server) => {
      const entities = call.args.entities as Array<Record<string, unknown>>;
      const observations = entities[0]?.observations as string[];
      expect(entities[0]?.name).toBe('Lesson:' + BRANCH_A_NS + ':L-1');
      expect(entities[0]?.entityType).toBe('Lesson');
      expect(String(observations[0])).toContain('# 功能名：');
      const relations = server.lastCall('create_relations')?.args.relations as Array<Record<string, unknown>>;
      expect(relations.map((relation) => relation.relationType)).toEqual(['APPLIES_WHEN', 'AVOID_WHEN']);
    }
  },
  {
    family: 'vector_fact',
    makeServer: () => vectorFactServer({ serverId: 'mem0' }),
    config: memoryConfig,
    recallTool: 'search_memory',
    commitTool: 'add_memory',
    pruneTool: 'delete_memory',
    assertCommit: (call) => {
      expect(String(call.args.text)).toContain('# 功能名：');
      expect(call.args.user_id).toBe(BRANCH_A_NS);
      const metadata = call.args.metadata as Record<string, unknown>;
      expect(metadata.namespace).toBe(BRANCH_A_NS);
      expect(metadata.polarity).toBe('positive');
      expect(metadata.visibility).toBe('branch_private');
      expect(metadata.whenNotToApply).toEqual(['offline sandbox']);
    }
  },
  {
    family: 'temporal_graph',
    makeServer: () => temporalServer({ serverId: 'graphiti' }),
    config: memoryConfig,
    recallTool: 'search_facts',
    commitTool: 'add_episode',
    pruneTool: 'delete_episode',
    assertCommit: (call) => {
      expect(call.args.name).toBe('harness-lesson-L-1');
      expect(String(call.args.episode_body)).toContain('# 功能名：');
      expect(call.args.source).toBe('text');
      expect(call.args.group_id).toBe(BRANCH_A_NS);
      expect(typeof call.args.reference_time).toBe('string');
      expect(new Date(String(call.args.reference_time)).getTime()).toBe(FIXED_NOW);
    }
  },
  {
    family: 'markdown_note',
    makeServer: () => markdownNoteServer({ serverId: 'basic_memory' }),
    config: memoryConfig,
    recallTool: 'search_notes',
    commitTool: 'write_note',
    pruneTool: 'delete_note',
    assertCommit: (call) => {
      expect(call.args.path).toBe('harness2/branch/s-1/b-1/L-1.md');
      expect(String(call.args.content)).toContain('harness_lesson: 1');
      expect(call.args.tags).toEqual(['harness-lesson', 'positive']);
      expect((call.args.metadata as Record<string, unknown>).namespace).toBe(BRANCH_A_NS);
    }
  },
  {
    family: 'lingshu_mdcg',
    makeServer: () => lingshuServer({ serverId: 'lingshu' }),
    config: memoryConfig,
    recallTool: 'mdcg_recall',
    commitTool: 'cg',
    pruneTool: 'cg',
    assertCommit: (call) => {
      expect(call.args.op).toBe('write');
      const content = String(call.args.content);
      expect(content.startsWith('[SCOPE:' + BRANCH_A_NS + ']')).toBe(true);
      expect(content).toContain('# 功能名：');
      expect(content).toContain('## 不适用条件 / whenNotToApply');
    }
  },
  {
    family: 'custom_mapped',
    makeServer: () => customMappedServer({ serverId: 'my_custom' }),
    config: () =>
      memoryConfig({
        customMapping: {
          enabled: true,
          recallToolName: 'my_custom_search',
          commitToolName: 'my_custom_upsert',
          pruneToolName: 'my_custom_purge'
        }
      }),
    recallTool: 'my_custom_search',
    commitTool: 'my_custom_upsert',
    pruneTool: 'my_custom_purge',
    assertCommit: (call) => {
      expect(String(call.args.my_text)).toContain('# 功能名：');
      expect(call.args.my_scope).toBe(BRANCH_A_NS);
      expect((call.args.my_meta as Record<string, unknown>).namespace).toBe(BRANCH_A_NS);
    }
  }
];

describe('driver adapters', () => {
  it('registers one fingerprint and factory for every frozen driver kind', () => {
    for (const kind of MEMORY_DRIVER_KINDS) {
      expect(DRIVER_FINGERPRINTS.some((fingerprint) => fingerprint.kind === kind)).toBe(true);
      const driver = createDriverForKind(kind, { recall: 'r', commit: 'c' });
      expect(driver?.kind).toBe(kind);
    }
  });

  it.each(driverCases)('$family: commits with the mapped tool arguments', async (testCase) => {
    const server = testCase.makeServer();
    const bridge = createMemoryBridge({
      config: testCase.config(),
      clients: [server.client],
      now: () => FIXED_NOW
    });
    const descriptor = await bridge.initialize();
    expect(descriptor.driverKind).toBe(testCase.family);
    const result = await bridge.commit(validLesson(), { scope: branchScope() });
    expect(result.accepted).toBe(true);
    const call = server.lastCall(testCase.commitTool);
    expect(call).toBeDefined();
    testCase.assertCommit(call as MockCall, server);
  });

  it.each(driverCases)('$family: round-trips the canonical lesson through recall', async (testCase) => {
    const server = testCase.makeServer();
    const bridge = createMemoryBridge({
      config: testCase.config(),
      clients: [server.client],
      now: () => FIXED_NOW
    });
    const lesson = validLesson();
    expect((await bridge.commit(lesson, { scope: branchScope() })).accepted).toBe(true);
    const recall = await bridge.recall({ scope: branchScope(), text: 'tool keeps failing argument validation' });
    expect(server.callsTo(testCase.recallTool).length).toBeGreaterThan(0);
    expect(recall.driverKind).toBe(testCase.family);
    expect(recall.positiveLessons).toHaveLength(1);
    const recovered = recall.positiveLessons[0];
    expect(recovered?.id).toBe(lesson.id);
    expect(recovered?.title).toBe(lesson.title);
    expect(recovered?.whenToApply).toEqual([...lesson.whenToApply]);
    expect(recovered?.whenNotToApply).toEqual([...lesson.whenNotToApply]);
    expect(recovered?.subFunctions).toEqual([...lesson.subFunctions]);
    expect(recovered?.executionPatch.summary).toBe(lesson.executionPatch.summary);
    expect(recovered?.verificationEvidence).toEqual(lesson.verificationEvidence);
    expect(recovered?.polarity).toBe('positive');
    expect(recovered?.visibility).toBe('branch_private');
    expect(recovered?.sessionId).toBe('s-1');
    expect(recovered?.confidence).toBeCloseTo(0.9, 6);
  });

  it.each(driverCases)('$family: prunes scoped lessons and honours dry-run', async (testCase) => {
    const server = testCase.makeServer();
    const bridge = createMemoryBridge({
      config: testCase.config(),
      clients: [server.client],
      now: () => FIXED_NOW
    });
    await bridge.initialize();
    await bridge.commit(validLesson({ createdAt: FIXED_NOW - 10_000 }), { scope: branchScope() });
    const dryRun = await bridge.prune({ scope: branchScope(), dryRun: true });
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.scanned).toBe(1);
    expect(dryRun.removedIds).toEqual(['L-1']);
    expect(server.store).toHaveLength(1);

    const pruned = await bridge.prune({ scope: branchScope() });
    expect(pruned.removedIds).toEqual(['L-1']);
    expect(server.store).toHaveLength(0);
    expect(server.callsTo(testCase.pruneTool).length).toBeGreaterThan(0);
  });

  it('filters prune candidates by age, id and polarity', async () => {
    const server = vectorFactServer({ serverId: 'mem0' });
    const bridge = createMemoryBridge({ config: memoryConfig(), clients: [server.client], now: () => FIXED_NOW });
    await bridge.initialize();
    await bridge.commit(validLesson({ id: 'L-old', createdAt: FIXED_NOW - 100_000 }), { scope: branchScope() });
    await bridge.commit(validLesson({ id: 'L-new', createdAt: FIXED_NOW }), { scope: branchScope() });
    const byAge = await bridge.prune({ scope: branchScope(), olderThan: FIXED_NOW - 1_000, dryRun: true });
    expect(byAge.removedIds).toEqual(['L-old']);
    const byId = await bridge.prune({ scope: branchScope(), ids: ['L-new'], dryRun: true });
    expect(byId.removedIds).toEqual(['L-new']);
    const byPolarity = await bridge.prune({ scope: branchScope(), polarity: 'negative', dryRun: true });
    expect(byPolarity.removedIds).toEqual([]);
    const capped = await bridge.prune({ scope: branchScope(), maxItems: 1, dryRun: true });
    expect(capped.removedIds).toEqual(['L-old']);
  });

  it('surfaces a native white-box gate rejection as a blocking violation', async () => {
    const server = lingshuServer({ serverId: 'lingshu', rejectWrites: true });
    const bridge = createMemoryBridge({ config: memoryConfig(), clients: [server.client], now: () => FIXED_NOW });
    await bridge.initialize();
    const result = await bridge.commit(validLesson(), { scope: branchScope() });
    expect(result.accepted).toBe(false);
    expect(result.persisted).toBe(false);
    const violation = result.violations.find((entry) => entry.code === 'invalid_lesson');
    expect(violation?.severity).toBe('block');
    expect(violation?.message).toContain('灵枢');
    expect(server.store).toHaveLength(0);
  });

  it('surfaces a vector backend rejection as a blocking violation', async () => {
    const server = vectorFactServer({ serverId: 'mem0', rejectWrites: true });
    const bridge = createMemoryBridge({ config: memoryConfig(), clients: [server.client], now: () => FIXED_NOW });
    await bridge.initialize();
    const result = await bridge.commit(validLesson(), { scope: branchScope() });
    expect(result.accepted).toBe(false);
    expect(result.violations.map((entry) => entry.code)).toContain('invalid_lesson');
  });

  it('degrades a hung recall instead of rejecting', async () => {
    const server = vectorFactServer({ serverId: 'mem0', hangTools: ['search_memory'] });
    const bridge = createMemoryBridge({
      config: memoryConfig({ requestTimeoutMs: 100 }),
      clients: [server.client],
      now: () => FIXED_NOW
    });
    const recall = await bridge.recall({ scope: branchScope(), text: 'anything' });
    expect(recall.degraded).toBe(true);
    expect(recall.lessons).toEqual([]);
    expect(recall.diagnostics.join(' ')).toContain('driver recall failed');
  });

  it('rejects a commit whose backend call times out', async () => {
    const server = vectorFactServer({ serverId: 'mem0', hangTools: ['add_memory'] });
    const bridge = createMemoryBridge({
      config: memoryConfig({ requestTimeoutMs: 100 }),
      clients: [server.client],
      now: () => FIXED_NOW
    });
    const result = await bridge.commit(validLesson(), { scope: branchScope() });
    expect(result.accepted).toBe(false);
    expect(result.violations.map((entry) => entry.code)).toContain('unsupported_operation');
  });
});
