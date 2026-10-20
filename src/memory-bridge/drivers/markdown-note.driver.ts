/**
 * Driver 4 — Markdown-Note (文档/笔记库类).
 * Fingerprints: basic-memory, obsidian-mcp, filesystem-mcp.
 * Each lesson becomes a Markdown note with YAML frontmatter under the derived
 * namespace directory and the #harness-lesson tag (ARCHITECTURE.md 4.2 row 4).
 */

import type { MemoryBackendCapabilities } from '../../types/contracts';
import { LESSON_TAG } from '../lesson-codec';
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

export const MARKDOWN_NOTE_TOOLS = {
  recall: ['search_notes', 'build_context', 'read_note'],
  commit: ['write_note', 'create_note', 'write_file'],
  prune: ['delete_note', 'delete_file']
} as const;

/** Directory form of a namespace, used as the note folder (namespace-blind). */
export function noteDirectory(namespace: string): string {
  return namespace.replace(/[.:]+/g, '/');
}

/** Note path for one lesson. */
export function notePath(namespace: string, lessonId: string): string {
  return noteDirectory(namespace) + '/' + lessonId + '.md';
}

/** Normalize a directory-form namespace back to the canonical colon form. */
export function normalizeNamespaceForm(namespace: string): string {
  return namespace.replace(/[\\/]+/g, ':');
}

export function createMarkdownNoteDriver(binding: MemoryDriverToolBinding): IMemoryDriver {
  const capabilities: MemoryBackendCapabilities = {
    metadataFiltering: true,
    namespaces: false,
    negativePolarity: true,
    temporal: false,
    supportsPrune: binding.prune !== undefined
  };
  return {
    kind: 'markdown_note',
    label: 'MCP markdown/note memory (basic-memory, obsidian)',
    capabilities,
    binding,
    async recall(
      context: MemoryDriverContext,
      input: MemoryDriverRecallInput
    ): Promise<MemoryDriverRecallOutput> {
      const fields = resolveFields(context, binding.recall);
      const args: JsonObject = {};
      if (binding.recall === 'build_context') {
        args.url = input.fingerprint;
      } else {
        args[fields.query] = input.fingerprint;
        args[fields.limit] = input.limit;
        args[fields.metadata] = { tags: [LESSON_TAG], namespace: input.namespace };
      }
      const result = await context.call(binding.recall, args);
      const payload = parseToolPayload(result);
      const visible = new Set(input.namespaces);
      const records = recordsFromPayload(payload, { namespace: input.namespace, limit: input.limit }).filter(
        (record) => visible.has(normalizeNamespaceForm(record.namespace))
      );
      return {
        records,
        diagnostics: [
          'markdown_note recall via ' + binding.recall + ' returned ' + records.length + ' tagged note(s)'
        ]
      };
    },
    async commit(
      context: MemoryDriverContext,
      input: MemoryDriverWriteInput
    ): Promise<MemoryDriverWriteOutput> {
      const fields = resolveFields(context, binding.commit);
      const path = notePath(input.namespace, input.lesson.id);
      const document = lessonDocument(input.lesson, input.namespace);
      const args: JsonObject = { [fields.text]: document };
      const properties = context.schemaProperties.get(binding.commit) ?? new Set<string>();
      if (properties.size === 0 || properties.has('path')) {
        args.path = path;
      } else if (properties.has('identifier')) {
        args.identifier = path;
      } else if (properties.has('title')) {
        args.title = input.lesson.id;
      }
      args.tags = [LESSON_TAG, input.lesson.polarity];
      args[fields.metadata] = {
        namespace: input.namespace,
        harness_lesson: 1,
        polarity: input.lesson.polarity,
        visibility: input.lesson.visibility
      };
      const result = await context.call(binding.commit, args);
      const rejection = detectBackendRejection(parseToolPayload(result), result);
      if (rejection !== undefined) {
        return {
          persisted: false,
          backendRef: path,
          violations: [{ code: 'invalid_lesson', message: rejection, severity: 'block' }]
        };
      }
      return { persisted: true, backendRef: path, diagnostics: ['markdown_note wrote ' + path] };
    },
    async prune(
      context: MemoryDriverContext,
      input: MemoryDriverPruneInput
    ): Promise<MemoryDriverPruneOutput> {
      if (binding.prune === undefined) {
        return { removedIds: [], diagnostics: ['markdown_note backend exposes no delete tool'] };
      }
      const fields = resolveFields(context, binding.prune);
      const removed: string[] = [];
      const diagnostics: string[] = [];
      for (const id of input.ids) {
        const path = notePath(input.namespace, id);
        const args: JsonObject = { path, [fields.ids]: [path] };
        try {
          await context.call(binding.prune, args);
          removed.push(id);
        } catch (error) {
          diagnostics.push('markdown_note delete failed for ' + path + ': ' + errorMessage(error));
        }
      }
      return { removedIds: removed, diagnostics };
    }
  };
}
