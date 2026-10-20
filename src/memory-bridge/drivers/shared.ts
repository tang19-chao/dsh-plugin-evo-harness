/**
 * Shared adapter helpers: schema-aware argument field resolution, payload
 * parsing and native-gate rejection detection for the six built-in drivers.
 */

import type { CanonicalLesson } from '../../types/contracts';
import { collectLessonRecords, serializeLesson } from '../lesson-codec';
import { scopeInlineTag } from '../namespace';
import type {
  DriverLessonRecord,
  JsonObject,
  JsonValue,
  McpToolCallResult,
  MemoryDriverContext
} from '../spi';
import { collectText, parseToolPayload } from '../spi';

/** Resolved argument field names for one MCP tool. */
export interface DriverFields {
  readonly query: string;
  readonly text: string;
  readonly namespace: string;
  readonly limit: string;
  readonly ids: string;
  readonly metadata: string;
}

const FALLBACK_FIELDS: DriverFields = {
  query: 'query',
  text: 'text',
  namespace: 'user_id',
  limit: 'limit',
  ids: 'ids',
  metadata: 'metadata'
};

function declared(context: MemoryDriverContext, tool: string | undefined): ReadonlySet<string> {
  if (tool === undefined) {
    return new Set<string>();
  }
  return context.schemaProperties.get(tool) ?? new Set<string>();
}

/**
 * Resolve one logical field to a declared schema property. Exact names win;
 * otherwise prefixed/suffixed spellings are accepted ("my_query" for "query"),
 * scanning in sorted order so the result is deterministic.
 */
function firstDeclared(props: ReadonlySet<string>, names: readonly string[], fallback: string): string {
  for (const name of names) {
    if (props.has(name)) {
      return name;
    }
  }
  const declared = [...props].sort();
  for (const name of names) {
    for (const property of declared) {
      if (property.endsWith('_' + name) || property.startsWith(name + '_')) {
        return property;
      }
    }
  }
  return fallback;
}

/**
 * Resolve the argument names a tool actually declares, falling back to the
 * canonical spelling when the backend publishes no (or an empty) input schema.
 * Deterministic: same descriptors always yield the same field names.
 */
export function resolveFields(
  context: MemoryDriverContext,
  tool: string | undefined,
  overrides: Partial<DriverFields> = {}
): DriverFields {
  const props = declared(context, tool);
  if (props.size === 0) {
    return { ...FALLBACK_FIELDS, ...overrides };
  }
  return {
    query: firstDeclared(props, ['query', 'q', 'search', 'text', 'prompt'], FALLBACK_FIELDS.query),
    text: firstDeclared(props, ['text', 'content', 'memory', 'note', 'data', 'body', 'fact'], FALLBACK_FIELDS.text),
    namespace: firstDeclared(
      props,
      ['user_id', 'userId', 'namespace', 'group_id', 'groupId', 'scope', 'container'],
      FALLBACK_FIELDS.namespace
    ),
    limit: firstDeclared(props, ['limit', 'top_k', 'topK', 'count', 'k'], FALLBACK_FIELDS.limit),
    ids: firstDeclared(props, ['ids', 'memory_ids', 'memoryIds', 'entityNames', 'names'], FALLBACK_FIELDS.ids),
    metadata: firstDeclared(props, ['metadata', 'meta', 'filters', 'filter'], FALLBACK_FIELDS.metadata),
    ...overrides
  };
}

/** Add an optional argument only when the tool declares it. */
export function putIfDeclared(
  context: MemoryDriverContext,
  tool: string | undefined,
  args: JsonObject,
  name: string,
  value: JsonValue
): void {
  if (declared(context, tool).has(name)) {
    args[name] = value;
  }
}

/** Parse a tool payload into lesson records carrying their origin namespace. */
export function recordsFromPayload(
  payload: unknown,
  input: { readonly namespace: string; readonly limit: number }
): DriverLessonRecord[] {
  const records = collectLessonRecords(payload, {
    namespaceHint: input.namespace,
    defaultNamespace: input.namespace
  });
  return records.slice(0, input.limit);
}

/** Serialized lesson text, optionally prefixed with the inline scope tag. */
export function lessonDocument(
  lesson: CanonicalLesson,
  namespace: string,
  options: { readonly scopeTag: boolean } = { scopeTag: true }
): string {
  const document = serializeLesson(lesson, { namespace });
  return options.scopeTag ? scopeInlineTag(namespace) + '\n' + document : document;
}

const REJECTION_VERDICTS = new Set(['reject', 'rejected', 'deny', 'denied', 'blocked', 'refused']);
const REJECTION_KEYS = ['verdict', 'status', 'decision', 'result'] as const;

/**
 * Detect a native backend gate refusal (for example 灵枢's white-box gates, or
 * an MCP isError result). Returns a human-readable reason when rejected.
 */
export function detectBackendRejection(
  payload: unknown,
  result: McpToolCallResult | undefined
): string | undefined {
  const text = collectText(result);
  if (result !== undefined && result.isError === true) {
    return text.length > 0 ? text : 'backend reported isError';
  }
  const candidates: unknown[] = [payload];
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (record.result !== undefined) {
      candidates.push(record.result);
    }
  }
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      continue;
    }
    const record = candidate as Record<string, unknown>;
    if (record.accepted === false || record.ok === false || record.persisted === false) {
      return 'backend rejected the write (accepted=false)';
    }
    for (const key of REJECTION_KEYS) {
      const value = record[key];
      if (typeof value === 'string' && REJECTION_VERDICTS.has(value.toLowerCase())) {
        return 'backend verdict "' + value + '"';
      }
    }
  }
  if (/\breject(ed|ion)?\b/i.test(text) && text.length > 0) {
    return text;
  }
  return undefined;
}

/** Serialized payload of a tool call, or undefined. */
export function payloadOf(result: McpToolCallResult | undefined): JsonValue | undefined {
  return parseToolPayload(result);
}
