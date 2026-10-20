/**
 * Driver 2 — Vector-Fact (语义向量与事实库类).
 * Fingerprints: mem0-mcp, supermemory-mcp, qdrant-mcp, chroma-mcp.
 * The canonical lesson is stored as structured Markdown in the text field while
 * namespace/polarity/restraint clauses travel in metadata for backends that
 * support metadata filtering (ARCHITECTURE.md 4.2 row 2).
 */

import type { CanonicalLesson, MemoryBackendCapabilities } from '../../types/contracts';
import { detectBackendRejection, lessonDocument, recordsFromPayload, resolveFields } from './shared';
import type {
  IMemoryDriver,
  JsonObject,
  MemoryDriverContext,
  MemoryDriverPruneInput,
  MemoryDriverPruneOutput,
  MemoryDriverRecallInput,
  MemoryDriverRecallOutput,
  MemoryDriverToolBinding,
  MemoryDriverWriteInput,
  MemoryDriverWriteOutput
} from '../spi';
import { errorMessage, parseToolPayload } from '../spi';

export const VECTOR_FACT_TOOLS = {
  recall: ['search_memory', 'search_memories', 'qdrant-find', 'query_memories', 'search'],
  commit: ['add_memory', 'store_memory', 'qdrant-store', 'add_memories', 'save_memory'],
  prune: ['delete_memory', 'delete_memories', 'qdrant-delete']
} as const;

/** Metadata payload that mirrors the governance fields into the backend. */
export function vectorLessonMetadata(lesson: CanonicalLesson, namespace: string): JsonObject {
  const metadata: JsonObject = {
    namespace,
    harness_lesson: 1,
    polarity: lesson.polarity,
    visibility: lesson.visibility,
    sessionId: lesson.sessionId
  };
  if (lesson.branchId !== undefined) {
    metadata.branchId = lesson.branchId;
  }
  metadata.whenNotToApply = [...lesson.whenNotToApply];
  if (lesson.taskSignature !== undefined) {
    metadata.taskSignature = lesson.taskSignature;
  }
  if (lesson.tags !== undefined) {
    metadata.tags = [...lesson.tags];
  }
  return metadata;
}

function namespaceFilter(namespaces: readonly string[]): JsonObject {
  return { namespaces: [...namespaces], namespace: namespaces[0] ?? '', harness_lesson: 1 };
}

export function createVectorFactDriver(binding: MemoryDriverToolBinding): IMemoryDriver {
  const capabilities: MemoryBackendCapabilities = {
    metadataFiltering: true,
    namespaces: true,
    negativePolarity: true,
    temporal: false,
    supportsPrune: binding.prune !== undefined
  };
  return {
    kind: 'vector_fact',
    label: 'MCP vector/fact memory (mem0, supermemory, qdrant, chroma)',
    capabilities,
    binding,
    async recall(
      context: MemoryDriverContext,
      input: MemoryDriverRecallInput
    ): Promise<MemoryDriverRecallOutput> {
      const fields = resolveFields(context, binding.recall);
      const primary = input.namespaces[0] ?? input.namespace;
      const args: JsonObject = { [fields.query]: input.fingerprint };
      args[fields.limit] = input.limit;
      args[fields.namespace] = input.namespaces.length > 1 ? [...input.namespaces] : primary;
      args[fields.metadata] = namespaceFilter(input.namespaces);
      const result = await context.call(binding.recall, args);
      const records = recordsFromPayload(parseToolPayload(result), {
        namespace: input.namespace,
        limit: input.limit
      });
      return {
        records,
        diagnostics: ['vector_fact recall via ' + binding.recall + ' returned ' + records.length + ' lesson(s)']
      };
    },
    async commit(
      context: MemoryDriverContext,
      input: MemoryDriverWriteInput
    ): Promise<MemoryDriverWriteOutput> {
      const fields = resolveFields(context, binding.commit);
      const document = lessonDocument(input.lesson, input.namespace);
      const args: JsonObject = { [fields.text]: document };
      args[fields.namespace] = input.namespace;
      args[fields.metadata] = vectorLessonMetadata(input.lesson, input.namespace);
      const result = await context.call(binding.commit, args);
      const payload = parseToolPayload(result);
      const rejection = detectBackendRejection(payload, result);
      if (rejection !== undefined) {
        return {
          persisted: false,
          violations: [{ code: 'invalid_lesson', message: rejection, severity: 'block' }]
        };
      }
      return {
        persisted: true,
        backendRef: backendRefOf(payload) ?? input.lesson.id,
        diagnostics: ['vector_fact stored lesson ' + input.lesson.id + ' in namespace ' + input.namespace]
      };
    },
    async prune(
      context: MemoryDriverContext,
      input: MemoryDriverPruneInput
    ): Promise<MemoryDriverPruneOutput> {
      if (binding.prune === undefined) {
        return { removedIds: [], diagnostics: ['vector_fact backend exposes no delete tool'] };
      }
      const fields = resolveFields(context, binding.prune);
      const args: JsonObject = { [fields.ids]: [...input.ids] };
      args[fields.namespace] = input.namespace;
      try {
        await context.call(binding.prune, args);
        return { removedIds: [...input.ids], diagnostics: ['vector_fact deleted ' + input.ids.length + ' memor(ies)'] };
      } catch (error) {
        return { removedIds: [], diagnostics: ['vector_fact prune failed: ' + errorMessage(error)] };
      }
    }
  };
}

function backendRefOf(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  for (const key of ['id', 'memory_id', 'memoryId', 'documentId']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  const results = record.results;
  if (Array.isArray(results) && results.length > 0) {
    const first = results[0];
    if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
      const id = (first as Record<string, unknown>).id;
      if (typeof id === 'string' && id.length > 0) {
        return id;
      }
    }
  }
  return undefined;
}
