/**
 * Universal MCP Memory Bridge — service provider interface (SPI).
 *
 * HOST NEUTRALITY: this module never imports a concrete MCP client, a Cordis
 * context, or any host package. Everything the bridge needs from the host is
 * expressed as the structural McpClient boundary below, so unit tests and E2E
 * tests can inject a deterministic fake with zero network access
 * (src/types/contracts.ts "HOST API ASSUMPTIONS" note 2 and 4).
 *
 * The frozen IMemoryBridge facade lives in src/types/contracts.ts; drivers are
 * an implementation detail of this directory and may evolve per MCP ecosystem.
 */

import type { MemoryBridgeConfig } from '../config';
import type {
  CanonicalLesson,
  MemoryBackendCapabilities,
  MemoryDriverKind,
  MemoryRecallQuery
} from '../types/contracts';

// ---------------------------------------------------------------------------
// JSON value helpers (MCP arguments and content are JSON-serializable)
// ---------------------------------------------------------------------------

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** Serialize a payload without ever throwing on cycles. */
export function safeStringify(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// MCP client boundary (mockable)
// ---------------------------------------------------------------------------

/** One MCP tool advertised by tools/list. */
export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: JsonObject;
}

/** Free-form textual content block. */
export interface McpTextBlock {
  readonly type: 'text';
  readonly text: string;
}

/** Structured content block carrying already-parsed JSON. */
export interface McpJsonBlock {
  readonly type: 'json';
  readonly data: JsonValue;
}

/** Any other MCP content block; treated as opaque data. */
export interface McpOpaqueBlock {
  readonly type: string;
  readonly [key: string]: unknown;
}

export type McpContentBlock = McpTextBlock | McpJsonBlock | McpOpaqueBlock;

/** Result of one tools/call. */
export interface McpToolCallResult {
  readonly content?: readonly McpContentBlock[];
  readonly isError?: boolean;
  readonly structuredContent?: JsonValue;
}

/** Per-call transport options. timeoutMs is enforced by callToolWithTimeout. */
export interface McpCallOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * The injected MCP client. Only these two operations are required, which is the
 * whole contract of MCP's tools/list + tools/call surface. Concrete clients
 * (stdio, SSE, in-process) are supplied by the integrator; tests supply fakes.
 */
export interface McpClient {
  readonly serverId: string;
  listTools(options?: McpCallOptions): Promise<readonly McpToolDescriptor[]>;
  callTool(name: string, args: JsonObject, options?: McpCallOptions): Promise<McpToolCallResult>;
}

/** Collect every textual/json block of a tool result into one string. */
export function collectText(result: McpToolCallResult | null | undefined): string {
  if (!result) {
    return '';
  }
  const parts: string[] = [];
  const blocks: readonly McpContentBlock[] = result.content ?? [];
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string') {
      parts.push(record.text);
    } else if (record.type === 'json' && record.data !== undefined) {
      parts.push(safeStringify(record.data));
    } else if (typeof record.text === 'string') {
      parts.push(record.text);
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(safeStringify(result.structuredContent));
  }
  return parts.join('\n');
}

/**
 * Best-effort JSON extraction from an MCP text payload: whole-text JSON,
 * fenced code blocks, then the first balanced object/array region.
 */
export function parseJsonPayload(text: string): JsonValue | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const direct = tryJson(trimmed);
  if (direct !== undefined) {
    return direct;
  }
  const fence = /\x60\x60\x60(?:json)?\s*([\s\S]*?)\x60\x60\x60/.exec(text);
  if (fence !== null && fence[1] !== undefined) {
    const fenced = tryJson(fence[1].trim());
    if (fenced !== undefined) {
      return fenced;
    }
  }
  const start = firstJsonStart(trimmed);
  if (start < 0) {
    return undefined;
  }
  const opener = trimmed[start];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === undefined) {
      break;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === opener) {
      depth += 1;
    } else if (char === closer) {
      depth -= 1;
      if (depth === 0) {
        return tryJson(trimmed.slice(start, index + 1));
      }
    }
  }
  return undefined;
}

function firstJsonStart(text: string): number {
  const objectStart = text.indexOf('{');
  const arrayStart = text.indexOf('[');
  if (objectStart < 0) {
    return arrayStart;
  }
  if (arrayStart < 0) {
    return objectStart;
  }
  return Math.min(objectStart, arrayStart);
}

function tryJson(text: string): JsonValue | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') {
      return undefined;
    }
    return parsed as JsonValue;
  } catch {
    return undefined;
  }
}

/** Structured payload of a tool result: structuredContent, else parsed text. */
export function parseToolPayload(result: McpToolCallResult | null | undefined): JsonValue | undefined {
  if (!result) {
    return undefined;
  }
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  const text = collectText(result);
  return parseJsonPayload(text);
}

/** Declared top-level property names of a tool input schema. */
export function toolSchemaPropertyNames(tool: McpToolDescriptor | undefined): ReadonlySet<string> {
  if (!tool || tool.inputSchema === undefined) {
    return new Set<string>();
  }
  const properties = tool.inputSchema.properties;
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
    return new Set<string>();
  }
  return new Set<string>(Object.keys(properties));
}

/**
 * Call one MCP tool with a hard client-side deadline. The bridge must never
 * hang on a wedged backend, and a timeout is surfaced as a degraded recall or
 * a rejected commit instead of an unhandled rejection.
 */
export async function callToolWithTimeout(
  client: McpClient,
  toolName: string,
  args: JsonObject,
  options: McpCallOptions = {}
): Promise<McpToolCallResult> {
  const timeoutMs = options.timeoutMs;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return client.callTool(toolName, args, options);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error('MCP tool "' + toolName + '" timed out after ' + timeoutMs + 'ms'));
  }, timeoutMs);
  const forward = (): void => {
    controller.abort(options.signal === undefined ? undefined : options.signal.reason);
  };
  if (options.signal !== undefined) {
    if (options.signal.aborted) {
      forward();
    } else {
      options.signal.addEventListener('abort', forward, { once: true });
    }
  }
  try {
    return await client.callTool(toolName, args, { timeoutMs, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (options.signal !== undefined) {
      options.signal.removeEventListener('abort', forward);
    }
  }
}

/** Human-readable message for an unknown thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.name + ': ' + error.message;
  }
  return safeStringify(error);
}

// ---------------------------------------------------------------------------
// Driver SPI
// ---------------------------------------------------------------------------

/** Tool names a driver binds to after auto-discovery. */
export interface MemoryDriverToolBinding {
  readonly recall: string;
  readonly commit: string;
  readonly prune?: string;
}

/** Everything a driver may use; supplied by the bridge, never by the driver. */
export interface MemoryDriverContext {
  readonly client: McpClient;
  readonly tools: readonly McpToolDescriptor[];
  readonly toolNames: ReadonlySet<string>;
  readonly schemaProperties: ReadonlyMap<string, ReadonlySet<string>>;
  readonly config: MemoryBridgeConfig;
  readonly binding: MemoryDriverToolBinding;
  readonly now: () => number;
  hasTool(toolName: string | undefined): boolean;
  call(toolName: string, args: JsonObject): Promise<McpToolCallResult>;
}

/** One lesson read back from a backend plus the namespace it came from. */
export interface DriverLessonRecord {
  readonly lesson: CanonicalLesson;
  readonly namespace: string;
  readonly backendRef?: string;
}

export interface MemoryDriverRecallInput {
  readonly query: MemoryRecallQuery;
  /** Primary namespace of the requested scope. */
  readonly namespace: string;
  /**
   * Every namespace visible to the requested scope, primary first
   * (branch -> branch, session, global). Sibling branches are never included,
   * so a backend filter can never widen the isolation boundary.
   */
  readonly namespaces: readonly string[];
  readonly limit: number;
  /** Query text assembled from the task text, signature and context tags. */
  readonly fingerprint: string;
  readonly now: number;
}

export interface MemoryDriverRecallOutput {
  readonly records: readonly DriverLessonRecord[];
  readonly diagnostics?: readonly string[];
  readonly degraded?: boolean;
}

export interface MemoryDriverWriteInput {
  readonly lesson: CanonicalLesson;
  readonly namespace: string;
  readonly now: number;
}

export interface MemoryDriverWriteOutput {
  readonly persisted: boolean;
  readonly backendRef?: string;
  readonly diagnostics?: readonly string[];
  /** Blocking violation reported by a native backend gate (for example 灵枢). */
  readonly violations?: readonly {
    readonly code: 'invalid_lesson';
    readonly message: string;
    readonly severity: 'block';
  }[];
}

export interface MemoryDriverPruneInput {
  readonly namespace: string;
  readonly ids: readonly string[];
  readonly now: number;
}

export interface MemoryDriverPruneOutput {
  readonly removedIds: readonly string[];
  readonly diagnostics?: readonly string[];
}

/**
 * One MCP memory adapter family (ARCHITECTURE.md 4.2). Drivers translate the
 * canonical lesson envelope into ecosystem-specific tool calls and back.
 */
export interface IMemoryDriver {
  readonly kind: MemoryDriverKind;
  readonly label: string;
  readonly capabilities: MemoryBackendCapabilities;
  readonly binding: MemoryDriverToolBinding;
  recall(context: MemoryDriverContext, input: MemoryDriverRecallInput): Promise<MemoryDriverRecallOutput>;
  commit(context: MemoryDriverContext, input: MemoryDriverWriteInput): Promise<MemoryDriverWriteOutput>;
  prune(context: MemoryDriverContext, input: MemoryDriverPruneInput): Promise<MemoryDriverPruneOutput>;
}

/** Build driver arguments that respect the tool's declared JSON Schema. */
export function buildSchemaArgs(
  context: MemoryDriverContext,
  toolName: string | undefined,
  spec: readonly (readonly [string, JsonValue])[],
  fallback: JsonObject
): JsonObject {
  const properties = toolName === undefined ? new Set<string>() : context.schemaProperties.get(toolName);
  if (properties === undefined || properties.size === 0) {
    return { ...fallback };
  }
  const args: JsonObject = {};
  for (const entry of spec) {
    if (properties.has(entry[0])) {
      args[entry[0]] = entry[1];
    }
  }
  if (Object.keys(args).length === 0) {
    return { ...fallback };
  }
  return args;
}
