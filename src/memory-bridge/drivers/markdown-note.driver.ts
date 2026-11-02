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

/**
 * Filesystem token for one lesson id (SEC-1). The id originates from
 * backend-controlled document trailers, so it never reaches a tool path
 * verbatim: ids bearing path separators or a traversal segment are rejected
 * (undefined) instead of rewritten, and every other character outside the
 * [A-Za-z0-9._-] whitelist collapses to '_' — the same character class as
 * sanitizeFileToken in lesson-codec.
 */
export function lessonIdToken(lessonId: string): string | undefined {
  if (lessonId.includes('/') || lessonId.includes('\\') || lessonId.includes('..')) {
    return undefined;
  }
  const token = lessonId.replace(/[^A-Za-z0-9._-]/g, '_');
  return token.length === 0 ? undefined : token;
}

/** Note path for one lesson; throws on a traversal-bearing id (see lessonIdToken). */
export function notePath(namespace: string, lessonId: string): string {
  const token = lessonIdToken(lessonId);
  if (token === undefined) {
    throw new Error(
      'markdown_note: lesson id carries path separators or a traversal segment: ' + JSON.stringify(lessonId)
    );
  }
  return noteDirectory(namespace) + '/' + token + '.md';
}

/** Upper bound for the fingerprint forwarded as a backend `url` argument (SEC-2). */
const BUILD_CONTEXT_URL_MAX_CHARS = 512;

/** Scheme prefix of a URL-shaped string, e.g. "http:" or "memory:". */
const URL_SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** The one scheme a build_context backend may see (in-store memory references). */
const BUILD_CONTEXT_URL_ALLOWED_SCHEME = 'memory';

/**
 * Server-safe `url` argument for build_context recall (SEC-2): the fingerprint
 * is raw task text, so any non-memory URL scheme is stripped (a hostile
 * "http://…" prompt must not arrive dereferenceable) and the remainder is
 * length-capped so an unbounded prompt cannot degrade the recall call.
 */
export function buildContextUrlFrom(fingerprint: string): string {
  const scheme = URL_SCHEME_PREFIX.exec(fingerprint);
  const stripped =
    scheme !== null && scheme[0].toLowerCase() !== BUILD_CONTEXT_URL_ALLOWED_SCHEME + ':'
      ? fingerprint.slice(scheme[0].length).replace(/^\/+/, '')
      : fingerprint;
  return stripped.slice(0, BUILD_CONTEXT_URL_MAX_CHARS);
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
        args.url = buildContextUrlFrom(input.fingerprint);
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
      if (lessonIdToken(input.lesson.id) === undefined) {
        // SEC-1: deny the write rather than silently rewriting the id, so the
        // mismatch with the stored lesson surfaces as a blocking violation.
        return {
          persisted: false,
          violations: [
            {
              code: 'invalid_lesson',
              message:
                'lesson id carries path separators or a traversal segment: ' + JSON.stringify(input.lesson.id),
              severity: 'block'
            }
          ]
        };
      }
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
        if (lessonIdToken(id) === undefined) {
          // SEC-1: a backend-planted traversal id never reaches the delete path.
          diagnostics.push(
            'markdown_note refused unsafe lesson id ' + JSON.stringify(id) + ' (path separators or traversal)'
          );
          continue;
        }
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
