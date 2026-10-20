/**
 * Driver 1 — Graph-Entity (实体关系图谱类).
 * Fingerprints: @modelcontextprotocol/server-memory, cognee-mcp.
 * Lessons become 'Lesson' entities; conditions become APPLIES_WHEN / AVOID_WHEN
 * relation edges (ARCHITECTURE.md 4.2 row 1). This backend has no metadata
 * filtering, so isolation is carried by the entity name and the inline scope tag.
 */

import type { MemoryBackendCapabilities } from '../../types/contracts';
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

/** Tool-name candidates fingerprinted by auto-discovery. */
export const GRAPH_ENTITY_TOOLS = {
  recall: ['search_nodes', 'open_nodes', 'read_graph'],
  commit: ['create_entities', 'add_observations'],
  prune: ['delete_entities']
} as const;

/** Entity name that carries the deterministic namespace. */
export function graphEntityName(namespace: string, lessonId: string): string {
  return 'Lesson:' + namespace + ':' + lessonId;
}

export function createGraphEntityDriver(binding: MemoryDriverToolBinding): IMemoryDriver {
  const capabilities: MemoryBackendCapabilities = {
    metadataFiltering: false,
    namespaces: false,
    negativePolarity: true,
    temporal: false,
    supportsPrune: binding.prune !== undefined
  };
  return {
    kind: 'graph_entity',
    label: 'MCP graph memory (entities + relations)',
    capabilities,
    binding,
    async recall(
      context: MemoryDriverContext,
      input: MemoryDriverRecallInput
    ): Promise<MemoryDriverRecallOutput> {
      const fields = resolveFields(context, binding.recall);
      const args: JsonObject = { [fields.query]: input.fingerprint };
      args[fields.limit] = input.limit;
      const result = await context.call(binding.recall, args);
      const records = recordsFromPayload(parseToolPayload(result), {
        namespace: input.namespace,
        limit: input.limit
      });
      return {
        records,
        diagnostics: ['graph_entity recall via ' + binding.recall + ' returned ' + records.length + ' lesson(s)']
      };
    },
    async commit(
      context: MemoryDriverContext,
      input: MemoryDriverWriteInput
    ): Promise<MemoryDriverWriteOutput> {
      const entityName = graphEntityName(input.namespace, input.lesson.id);
      const document = lessonDocument(input.lesson, input.namespace);
      const entities: JsonObject[] = [
        {
          name: entityName,
          entityType: 'Lesson',
          observations: [document]
        }
      ];
      const result = await context.call(binding.commit, { entities });
      const rejection = detectBackendRejection(parseToolPayload(result), result);
      if (rejection !== undefined) {
        return {
          persisted: false,
          backendRef: entityName,
          violations: [{ code: 'invalid_lesson', message: rejection, severity: 'block' }]
        };
      }
      if (context.hasTool('create_relations')) {
        const relations: JsonObject[] = [];
        for (const clause of input.lesson.whenToApply) {
          relations.push({ from: entityName, relationType: 'APPLIES_WHEN', to: 'Condition:' + clause });
        }
        for (const clause of input.lesson.whenNotToApply) {
          relations.push({ from: entityName, relationType: 'AVOID_WHEN', to: 'Condition:' + clause });
        }
        if (relations.length > 0) {
          await context.call('create_relations', { relations });
        }
      }
      return {
        persisted: true,
        backendRef: entityName,
        diagnostics: ['graph_entity wrote entity ' + entityName]
      };
    },
    async prune(
      context: MemoryDriverContext,
      input: MemoryDriverPruneInput
    ): Promise<MemoryDriverPruneOutput> {
      if (binding.prune === undefined) {
        return { removedIds: [], diagnostics: ['graph_entity backend exposes no delete tool'] };
      }
      const entityNames = input.ids.map((id) => graphEntityName(input.namespace, id));
      try {
        await context.call(binding.prune, { entityNames });
        return { removedIds: [...input.ids], diagnostics: ['graph_entity deleted ' + entityNames.length + ' entity(s)'] };
      } catch (error) {
        return { removedIds: [], diagnostics: ['graph_entity prune failed: ' + errorMessage(error)] };
      }
    }
  };
}
