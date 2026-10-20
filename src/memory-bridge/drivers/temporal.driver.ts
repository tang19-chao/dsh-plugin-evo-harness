/**
 * Driver 3 — Temporal-Graph (时序情节图谱类).
 * Fingerprints: graphiti-mcp (Zep), letta-mcp.
 * One Propose-Probe-Compose contrast is committed as a complete episode and
 * recalled with a time window (ARCHITECTURE.md 4.2 row 3).
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

export const TEMPORAL_GRAPH_TOOLS = {
  recall: ['search_facts', 'search_episodes', 'search_nodes'],
  commit: ['add_episode', 'add_memory'],
  prune: ['delete_episode', 'delete_memory']
} as const;

/** Default recall window: 30 days, matching a plausible evolution cadence. */
export const TEMPORAL_WINDOW_DAYS = 30;

export function createTemporalGraphDriver(binding: MemoryDriverToolBinding): IMemoryDriver {
  const capabilities: MemoryBackendCapabilities = {
    metadataFiltering: true,
    namespaces: true,
    negativePolarity: true,
    temporal: true,
    supportsPrune: binding.prune !== undefined
  };
  return {
    kind: 'temporal_graph',
    label: 'MCP temporal/episodic graph memory (graphiti/zep, letta)',
    capabilities,
    binding,
    async recall(
      context: MemoryDriverContext,
      input: MemoryDriverRecallInput
    ): Promise<MemoryDriverRecallOutput> {
      const fields = resolveFields(context, binding.recall);
      const windowStartMs = input.now - TEMPORAL_WINDOW_DAYS * 24 * 60 * 60 * 1000;
      const args: JsonObject = { [fields.query]: input.fingerprint };
      args[fields.limit] = input.limit;
      args[fields.namespace] = input.namespaces.length > 1 ? [...input.namespaces] : input.namespace;
      if (context.schemaProperties.get(binding.recall)?.has('group_ids') === true) {
        args.group_ids = [...input.namespaces];
      }
      if (context.schemaProperties.get(binding.recall)?.has('start_time') === true) {
        args.start_time = new Date(windowStartMs).toISOString();
      }
      const result = await context.call(binding.recall, args);
      const records = recordsFromPayload(parseToolPayload(result), {
        namespace: input.namespace,
        limit: input.limit
      });
      return {
        records,
        diagnostics: [
          'temporal_graph recall via ' +
            binding.recall +
            ' returned ' +
            records.length +
            ' episode lesson(s) within ' +
            TEMPORAL_WINDOW_DAYS +
            ' days'
        ]
      };
    },
    async commit(
      context: MemoryDriverContext,
      input: MemoryDriverWriteInput
    ): Promise<MemoryDriverWriteOutput> {
      const fields = resolveFields(context, binding.commit);
      const document = lessonDocument(input.lesson, input.namespace);
      const args: JsonObject = {};
      if (binding.commit === 'add_episode') {
        args.name = 'harness-lesson-' + input.lesson.id;
        args.episode_body = document;
        args.source = 'text';
        args.reference_time = new Date(input.now).toISOString();
      } else {
        args[fields.text] = document;
      }
      args[fields.namespace] = input.namespace;
      args[fields.metadata] = {
        namespace: input.namespace,
        harness_lesson: 1,
        polarity: input.lesson.polarity,
        visibility: input.lesson.visibility,
        whenNotToApply: [...input.lesson.whenNotToApply]
      };
      const result = await context.call(binding.commit, args);
      const rejection = detectBackendRejection(parseToolPayload(result), result);
      if (rejection !== undefined) {
        return {
          persisted: false,
          violations: [{ code: 'invalid_lesson', message: rejection, severity: 'block' }]
        };
      }
      return {
        persisted: true,
        backendRef: 'episode:' + input.lesson.id,
        diagnostics: ['temporal_graph committed episode for lesson ' + input.lesson.id]
      };
    },
    async prune(
      context: MemoryDriverContext,
      input: MemoryDriverPruneInput
    ): Promise<MemoryDriverPruneOutput> {
      if (binding.prune === undefined) {
        return { removedIds: [], diagnostics: ['temporal_graph backend exposes no delete tool'] };
      }
      try {
        await context.call(binding.prune, {
          ids: [...input.ids],
          group_id: input.namespace
        });
        return { removedIds: [...input.ids], diagnostics: ['temporal_graph deleted ' + input.ids.length + ' episode(s)'] };
      } catch (error) {
        return { removedIds: [], diagnostics: ['temporal_graph prune failed: ' + errorMessage(error)] };
      }
    }
  };
}
