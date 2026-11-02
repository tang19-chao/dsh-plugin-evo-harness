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

/**
 * Declared JSON-Schema type of one tool property, when the tool publishes its
 * input schema (MEM-3): resolveFields matches property NAMES only, so the
 * drivers need the declared type to avoid handing a JSON array to a filter
 * field the backend declares as a scalar string.
 */
export function declaredPropertyType(
  context: MemoryDriverContext,
  tool: string | undefined,
  property: string
): string | undefined {
  if (tool === undefined) {
    return undefined;
  }
  const descriptor = context.tools.find((entry) => entry.name === tool);
  const properties = descriptor?.inputSchema?.properties;
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
    return undefined;
  }
  const spec = (properties as Record<string, unknown>)[property];
  const type = spec !== null && typeof spec === 'object' ? (spec as Record<string, unknown>).type : undefined;
  return typeof type === 'string' ? type : undefined;
}

/**
 * Issue the recall call(s) for one namespace filter field, conforming to the
 * backend's declared schema (MEM-3). When the resolved field is array-typed, a
 * single call carries every visible namespace; otherwise — the common
 * mem0/supermemory scalar shape, and the no-schema case where an array would
 * simply be rejected — one call per namespace is issued with a SCALAR filter,
 * so a branch scope never sends an array where the schema declares a string
 * (and never silently narrows to the primary namespace either).
 * Returns the tool results in call order.
 */
export async function recallNamespaceScoped(
  context: MemoryDriverContext,
  tool: string,
  namespaceField: string,
  namespaces: readonly string[],
  build: (namespaceFilter: JsonValue) => JsonObject
): Promise<readonly McpToolCallResult[]> {
  if (declaredPropertyType(context, tool, namespaceField) === 'array') {
    return [await context.call(tool, build([...namespaces]))];
  }
  const results: McpToolCallResult[] = [];
  for (const namespace of namespaces) {
    results.push(await context.call(tool, build(namespace)));
  }
  return results;
}

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

/**
 * Collapse records that more than one per-namespace call returned (a backend
 * that ignores the namespace filter answers every call with the same store),
 * keeping the first occurrence like collectLessonRecords does within a payload.
 */
export function dedupeRecordsById(records: readonly DriverLessonRecord[]): DriverLessonRecord[] {
  const seen = new Set<string>();
  const result: DriverLessonRecord[] = [];
  for (const record of records) {
    const key = record.namespace + '#' + record.lesson.id;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(record);
  }
  return result;
}
