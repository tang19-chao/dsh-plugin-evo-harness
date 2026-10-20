/**
 * Driver 6 — Custom-Mapped (用户自定义 JSONPath/工具名映射).
 * Used when the user points the bridge at a小众 MCP memory server through
 * memoryBridge.customMapping (recallToolName / commitToolName / pruneToolName).
 * Argument names are resolved from each tool's declared input schema, so the
 * same driver adapts to arbitrary custom servers without code changes.
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

/** Metadata mirror used for custom backends that accept a metadata bag. */
export function customLessonMetadata(lesson: CanonicalLesson, namespace: string): JsonObject {
  const metadata: JsonObject = {
    namespace,
    harness_lesson: 1,
    polarity: lesson.polarity,
    visibility: lesson.visibility,
    sessionId: lesson.sessionId,
    whenNotToApply: [...lesson.whenNotToApply],
    whenToApply: [...lesson.whenToApply]
  };
  if (lesson.branchId !== undefined) {
    metadata.branchId = lesson.branchId;
  }
  return metadata;
}

export function createCustomMappedDriver(binding: MemoryDriverToolBinding): IMemoryDriver {
  const capabilities: MemoryBackendCapabilities = {
    metadataFiltering: true,
    namespaces: true,
    negativePolarity: true,
    temporal: false,
    supportsPrune: binding.prune !== undefined
  };
  return {
    kind: 'custom_mapped',
    label: 'Custom-mapped MCP memory server (user configuration)',
    capabilities,
    binding,
    async recall(
      context: MemoryDriverContext,
      input: MemoryDriverRecallInput
    ): Promise<MemoryDriverRecallOutput> {
      const fields = resolveFields(context, binding.recall);
      const args: JsonObject = { [fields.query]: input.fingerprint };
      args[fields.limit] = input.limit;
      args[fields.namespace] = input.namespaces.length > 1 ? [...input.namespaces] : input.namespace;
      args[fields.metadata] = { namespaces: [...input.namespaces], harness_lesson: 1 };
      const result = await context.call(binding.recall, args);
      const records = recordsFromPayload(parseToolPayload(result), {
        namespace: input.namespace,
        limit: input.limit
      });
      return {
        records,
        diagnostics: ['custom_mapped recall via ' + binding.recall + ' returned ' + records.length + ' record(s)']
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
      args[fields.metadata] = customLessonMetadata(input.lesson, input.namespace);
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
        backendRef: binding.commit + ':' + input.lesson.id,
        diagnostics: ['custom_mapped stored lesson ' + input.lesson.id + ' via ' + binding.commit]
      };
    },
    async prune(
      context: MemoryDriverContext,
      input: MemoryDriverPruneInput
    ): Promise<MemoryDriverPruneOutput> {
      if (binding.prune === undefined) {
        return { removedIds: [], diagnostics: ['custom_mapped server exposes no prune tool'] };
      }
      const fields = resolveFields(context, binding.prune);
      const args: JsonObject = { [fields.ids]: [...input.ids] };
      args[fields.namespace] = input.namespace;
      try {
        await context.call(binding.prune, args);
        return { removedIds: [...input.ids], diagnostics: ['custom_mapped pruned ' + input.ids.length + ' record(s)'] };
      } catch (error) {
        return { removedIds: [], diagnostics: ['custom_mapped prune failed: ' + errorMessage(error)] };
      }
    }
  };
}
