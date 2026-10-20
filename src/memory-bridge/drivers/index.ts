/**
 * Built-in driver registry: fingerprints plus factories, in stable priority
 * order. Auto-discovery scores every registry entry against a server's
 * tools/list fingerprint and binds the winner.
 */

import type { MemoryDriverKind } from '../../types/contracts';
import { createCustomMappedDriver } from './custom-mapped.driver';
import { createGraphEntityDriver } from './graph-entity.driver';
import { createLingshuMdcgDriver } from './lingshu-mdcg.driver';
import { createMarkdownNoteDriver } from './markdown-note.driver';
import { createTemporalGraphDriver } from './temporal.driver';
import { createVectorFactDriver } from './vector-fact.driver';
import type { IMemoryDriver, MemoryDriverToolBinding } from '../spi';

export * from './custom-mapped.driver';
export * from './graph-entity.driver';
export * from './lingshu-mdcg.driver';
export * from './markdown-note.driver';
export * from './shared';
export * from './temporal.driver';
export * from './vector-fact.driver';

/** Fingerprint of one driver family. */
export interface DriverFingerprint {
  readonly kind: MemoryDriverKind;
  readonly label: string;
  /** Lower wins ties between equally-scoring fingerprints. */
  readonly priority: number;
  readonly recallCandidates: readonly string[];
  readonly commitCandidates: readonly string[];
  readonly pruneCandidates: readonly string[];
  /** Tools that strongly identify this ecosystem. */
  readonly strongTools: readonly string[];
}

/**
 * Stable fingerprint table (ARCHITECTURE.md 4.2). Order defines the documented
 * driver order; scoring breaks real ties deterministically.
 */
export const DRIVER_FINGERPRINTS: readonly DriverFingerprint[] = [
  {
    kind: 'lingshu_mdcg',
    label: '灵枢 dsh-memory white-box native driver (cg/stg)',
    priority: 0,
    recallCandidates: ['mdcg_recall', 'cg', 'stg'],
    commitCandidates: ['cg', 'mdcg_remember'],
    pruneCandidates: ['cg'],
    strongTools: ['cg', 'stg', 'mdcg_remember', 'mdcg_recall']
  },
  {
    kind: 'graph_entity',
    label: 'MCP graph memory (entities + relations)',
    priority: 1,
    recallCandidates: ['search_nodes', 'open_nodes', 'read_graph'],
    commitCandidates: ['create_entities', 'add_observations'],
    pruneCandidates: ['delete_entities'],
    strongTools: ['create_entities', 'create_relations', 'add_observations', 'search_nodes', 'open_nodes']
  },
  {
    kind: 'vector_fact',
    label: 'MCP vector/fact memory (mem0, supermemory, qdrant, chroma)',
    priority: 2,
    recallCandidates: ['search_memory', 'search_memories', 'qdrant-find', 'query_memories', 'search'],
    commitCandidates: ['add_memory', 'store_memory', 'qdrant-store', 'add_memories', 'save_memory'],
    pruneCandidates: ['delete_memory', 'delete_memories', 'qdrant-delete'],
    strongTools: ['add_memory', 'add_memories', 'search_memory', 'search_memories', 'store_memory', 'qdrant-store', 'qdrant-find']
  },
  {
    kind: 'temporal_graph',
    label: 'MCP temporal/episodic graph memory (graphiti/zep, letta)',
    priority: 3,
    recallCandidates: ['search_facts', 'search_episodes', 'search_nodes'],
    commitCandidates: ['add_episode', 'add_memory'],
    pruneCandidates: ['delete_episode', 'delete_memory'],
    strongTools: ['add_episode', 'search_facts', 'search_episodes', 'get_episodes']
  },
  {
    kind: 'markdown_note',
    label: 'MCP markdown/note memory (basic-memory, obsidian)',
    priority: 4,
    recallCandidates: ['search_notes', 'build_context', 'read_note'],
    commitCandidates: ['write_note', 'create_note', 'write_file'],
    pruneCandidates: ['delete_note', 'delete_file'],
    strongTools: ['search_notes', 'write_note', 'build_context', 'read_note', 'create_note']
  },
  {
    kind: 'custom_mapped',
    label: 'Custom-mapped MCP memory server (user configuration)',
    priority: 5,
    recallCandidates: [],
    commitCandidates: [],
    pruneCandidates: [],
    strongTools: []
  }
];

/** Lookup the registry entry for a driver kind. */
export function fingerprintFor(kind: MemoryDriverKind): DriverFingerprint | undefined {
  return DRIVER_FINGERPRINTS.find((entry) => entry.kind === kind);
}

/** Instantiate one driver family with a resolved tool binding. */
export function createDriverForKind(
  kind: MemoryDriverKind,
  binding: MemoryDriverToolBinding
): IMemoryDriver | undefined {
  switch (kind) {
    case 'graph_entity':
      return createGraphEntityDriver(binding);
    case 'vector_fact':
      return createVectorFactDriver(binding);
    case 'temporal_graph':
      return createTemporalGraphDriver(binding);
    case 'markdown_note':
      return createMarkdownNoteDriver(binding);
    case 'lingshu_mdcg':
      return createLingshuMdcgDriver(binding);
    case 'custom_mapped':
      return createCustomMappedDriver(binding);
    default:
      return undefined;
  }
}

/** Pick the first candidate tool name present on the server. */
export function firstAvailable(
  available: ReadonlySet<string>,
  candidates: readonly string[]
): string | undefined {
  for (const candidate of candidates) {
    if (available.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
