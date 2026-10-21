/**
 * Tools-backed MCP client: projects the DSH tool registry onto the plugin's
 * frozen McpClient SPI (src/memory-bridge/spi.ts).
 *
 * HOST FACTS THIS MODULE CODES AGAINST (verified against
 * resources/app.asar \\ node_modules/@deepseek-ai/dsh-tools/lib/index.js):
 * 1. `ctx.tools` is the ToolRuntime service. Its verified public surface is
 *    register / restrict / get / resolveExecution / schemas / sdkSchemas /
 *    executionMode / execute / guard. THERE IS NO `ctx.tools.execute(name, args)`
 *    overload and no `ctx.tools.list()`; discovery is `schemas(scope)` and
 *    lookup is `get(name, scope)`.
 * 2. `schemas(scope)` returns the model-facing projection
 *    `{ name, description, parameters, deferLoading? }` — execution and
 *    presentation callbacks are stripped.
 * 3. `get(name, scope)` returns the ToolDefinition, whose verified call form is
 *    `definition.execute(args, exec)` (the registry itself calls
 *    `tool.execute(exec.arguments, exec)`). `exec` carries the call identity and
 *    `signal`; a definition body reads at least `exec.signal`.
 * 4. Tool names are data, never constants. The memory bridge must discover
 *    whatever the mounted composition registers; hard-coding a name such as
 *    'mdcg_recall' would break every deployment whose server registers a
 *    different tool set (the 灵枢 dsh-memory profile runs `tools: 'core'` and
 *    registers only cg/stg).
 * 5. A live Cordis context throws for an undeclared service, so every read goes
 *    through the guarded reader.
 */

import type {
  JsonObject,
  McpCallOptions,
  McpClient,
  McpContentBlock,
  McpToolCallResult,
  McpToolDescriptor
} from '../memory-bridge/spi';
import { safeGet } from './model';

/** Verified DSH model-facing tool schema. */
export interface DshToolSchema {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: unknown;
  readonly deferLoading?: boolean;
}

/** Verified structural view of one registered DSH ToolDefinition. */
export interface DshToolDefinition {
  readonly name?: string;
  readonly description?: string;
  execute(args: unknown, exec: DshToolExecution): unknown;
}

/**
 * Verified structural view of the ToolExecution the registry mints. Only the
 * members a tool body may read are declared; `deferContext`/`concludeTurn` are
 * optional because a directly-invoked definition is not registry-scheduled.
 */
export interface DshToolExecution {
  readonly callId?: string;
  readonly rootCallId?: string;
  readonly name?: string;
  readonly signal?: AbortSignal;
  readonly arguments?: unknown;
  readonly agent?: unknown;
  readonly parent?: string;
  deferContext?(context: unknown): void;
  concludeTurn?(): void;
}

/** Verified structural view of the ToolRuntime service. */
export interface DshToolsLike {
  schemas(scope?: unknown): readonly DshToolSchema[];
  get(name: string, scope?: unknown): DshToolDefinition | undefined;
}

/** Resolve the DSH tool registry from a host context, or undefined when absent. */
export function readDshTools(ctx: unknown): DshToolsLike | undefined {
  const tools = safeGet(ctx, 'tools');
  if (tools === null || typeof tools !== 'object') {
    return undefined;
  }
  if (typeof safeGet(tools, 'schemas') !== 'function' || typeof safeGet(tools, 'get') !== 'function') {
    return undefined;
  }
  return tools as DshToolsLike;
}

// ---------------------------------------------------------------------------
// Lossless JSON projection
// ---------------------------------------------------------------------------

const MAX_JSON_DEPTH = 32;
const MAX_JSON_ITEMS = 4096;

/**
 * Copy a host value onto plain JSON data without ever throwing. A value that
 * cannot be represented losslessly (a function, a symbol, an accessor that
 * throws, a cyclic object beyond the depth bound) is dropped instead of being
 * passed through to the MCP layer, where it would corrupt serialization.
 */
export function snapshotJsonValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== 'object' || depth >= MAX_JSON_DEPTH) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const limit = Math.min(value.length, MAX_JSON_ITEMS);
    const items: unknown[] = [];
    for (let index = 0; index < limit; index += 1) {
      const item = snapshotJsonValue(value[index], depth + 1);
      if (item !== undefined) {
        items.push(item);
      }
    }
    return items;
  }
  const record = value as Record<string, unknown>;
  let keys: string[];
  try {
    keys = Object.keys(record);
  } catch {
    return undefined;
  }
  const copy: Record<string, unknown> = {};
  for (const key of keys.slice(0, MAX_JSON_ITEMS)) {
    const item = snapshotJsonValue(record[key], depth + 1);
    if (item !== undefined) {
      copy[key] = item;
    }
  }
  return copy;
}

/** Cast a lossless-JSON snapshot to the MCP JsonObject shape when it is an object. */
export function asJsonObject(value: unknown): JsonObject | undefined {
  const snapshot = snapshotJsonValue(value);
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return undefined;
  }
  return snapshot as JsonObject;
}

/** Human-readable text for an unknown thrown value. */
export function describeThrown(error: unknown): string {
  if (error instanceof Error) {
    return error.name + ': ' + error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  const snapshot = snapshotJsonValue(error);
  if (snapshot === undefined) {
    return String(error);
  }
  try {
    return JSON.stringify(snapshot) ?? String(error);
  } catch {
    return String(error);
  }
}

// ---------------------------------------------------------------------------
// Tool catalogue over the DSH registry
// ---------------------------------------------------------------------------

/** What the registry currently offers, plus why a projection came up empty. */
export interface DshToolCatalog {
  readonly available: boolean;
  readonly scope: unknown;
  readonly tools: readonly McpToolDescriptor[];
  readonly names: readonly string[];
  readonly diagnostics: readonly string[];
}

/** Project the DSH schemas onto MCP tool descriptors. */
export function listDshTools(ctx: unknown, scope?: unknown): DshToolCatalog {
  const diagnostics: string[] = [];
  const tools = readDshTools(ctx);
  if (tools === undefined) {
    return {
      available: false,
      scope,
      tools: [],
      names: [],
      diagnostics: ['ctx.tools is unavailable (declare "tools" in inject, or mount @deepseek-ai/dsh-tools)']
    };
  }
  let schemas: readonly DshToolSchema[] = [];
  try {
    const projected = tools.schemas(scope);
    schemas = Array.isArray(projected) ? (projected as readonly DshToolSchema[]) : [];
  } catch (error) {
    diagnostics.push('ctx.tools.schemas() threw: ' + describeThrown(error));
    return { available: true, scope, tools: [], names: [], diagnostics };
  }
  const descriptors: McpToolDescriptor[] = [];
  const names: string[] = [];
  for (const schema of schemas) {
    const record = schema as unknown as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : undefined;
    if (name === undefined || name.length === 0) {
      diagnostics.push('ctx.tools.schemas() returned a descriptor without a usable name; it was skipped');
      continue;
    }
    const description = typeof record.description === 'string' ? record.description : undefined;
    const inputSchema = asJsonObject(record.parameters);
    descriptors.push({
      name,
      ...(description === undefined ? {} : { description }),
      ...(inputSchema === undefined ? {} : { inputSchema })
    });
    names.push(name);
  }
  if (descriptors.length === 0) {
    diagnostics.push('ctx.tools.schemas() reported no registered tools; the memory bridge will stay unbound');
  }
  return { available: true, scope, tools: descriptors, names, diagnostics };
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/** Identifier reported to the memory bridge for the DSH tool registry. */
export const DSH_TOOLS_SERVER_ID = 'dsh-tools';

/** Options accepted by createToolsBackedMcpClient. */
export interface ToolsBackedClientOptions {
  /** MCP server id reported on every descriptor. Defaults to 'dsh-tools'. */
  readonly serverId?: string;
  /** Agent/registry scope passed to schemas()/get(); omitted = the global view. */
  readonly scope?: unknown;
  /** Receiver for non-fatal projection failures discovered lazily. */
  readonly onDiagnostic?: (message: string) => void;
  /** Monotonic id source for tool call ids; injectable for deterministic tests. */
  readonly newCallId?: () => string;
}

/** McpClient extended with the live catalogue projection used to build it. */
export interface ToolsBackedMcpClient extends McpClient {
  /**
   * Catalogue snapshot taken at construction time. Callers that need the FRESH
   * projection (for diagnostics) read client.listTools() or listDshTools()
   * instead; this field exists so one create call can both satisfy the SPI and
   * report what it saw.
   */
  readonly catalog: DshToolCatalog;
}

/** Turn a DSH ToolExecutionResult (or a raw tool return) into MCP content blocks. */
export function toMcpToolResult(result: unknown): McpToolCallResult {
  const record = result === null || typeof result !== 'object' ? undefined : (result as Record<string, unknown>);
  if (record === undefined) {
    // A definition that returns a bare JSON value is still a successful call.
    const value = snapshotJsonValue(result);
    return {
      content: [],
      isError: false,
      ...(value === undefined ? {} : { structuredContent: value as McpToolCallResult['structuredContent'] })
    };
  }
  const blocks = Array.isArray(record.content) ? record.content : [];
  const content: McpContentBlock[] = [];
  for (const block of blocks) {
    const blockRecord = block === null || typeof block !== 'object' ? undefined : (block as Record<string, unknown>);
    if (blockRecord === undefined) {
      continue;
    }
    const type = typeof blockRecord.type === 'string' ? blockRecord.type : undefined;
    const text = typeof blockRecord.text === 'string' ? blockRecord.text : undefined;
    if (type === 'text' && text !== undefined) {
      content.push({ type: 'text', text });
      continue;
    }
    const snapshot = snapshotJsonValue(blockRecord);
    if (snapshot !== null && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
      content.push({ type: type ?? 'unknown', ...(snapshot as Record<string, unknown>) } as McpContentBlock);
    }
  }
  const isError = record.isError === true;
  const value = snapshotJsonValue(record.value);
  if (isError && content.length === 0) {
    const message = safeGet(safeGet(record, 'error'), 'message');
    content.push({
      type: 'text',
      text: 'Error: ' + (typeof message === 'string' && message.length > 0 ? message : 'tool execution failed')
    });
  }
  return {
    content,
    isError,
    ...(value === undefined ? {} : { structuredContent: value as McpToolCallResult['structuredContent'] })
  };
}

/**
 * Build the McpClient the memory bridge consumes, backed by ctx.tools.
 *
 * Returns an McpClient (serverId / listTools / callTool) so it can be handed to
 * createMemoryBridge as-is; the catalogue snapshot rides along on the returned
 * object for diagnostics. A registry-less context still yields a client whose
 * listTools() is empty and whose callTool() throws a descriptive error, so a
 * missing backend is never a silent undefined.
 */
export function createToolsBackedMcpClient(
  ctx: unknown,
  options: ToolsBackedClientOptions = {}
): ToolsBackedMcpClient {
  const catalog = listDshTools(ctx, options.scope);
  const report = options.onDiagnostic;
  for (const diagnostic of catalog.diagnostics) {
    if (report !== undefined) {
      report(diagnostic);
    }
  }
  const serverId = options.serverId ?? DSH_TOOLS_SERVER_ID;
  let sequence = 0;
  const newCallId =
    options.newCallId ??
    ((): string => {
      sequence += 1;
      return 'evo-tool-' + String(sequence);
    });

  const client: ToolsBackedMcpClient = {
    serverId,
    catalog,
    async listTools(): Promise<readonly McpToolDescriptor[]> {
      const live = listDshTools(ctx, options.scope);
      for (const diagnostic of live.diagnostics) {
        if (report !== undefined && !catalog.diagnostics.includes(diagnostic)) {
          report(diagnostic);
        }
      }
      return live.tools;
    },
    async callTool(name: string, args: JsonObject, callOptions?: McpCallOptions): Promise<McpToolCallResult> {
      const tools = readDshTools(ctx);
      if (tools === undefined) {
        throw new Error(
          serverId + ': cannot call "' + name + '" because ctx.tools is unavailable on this host context'
        );
      }
      let definition: DshToolDefinition | undefined = undefined;
      try {
        definition = tools.get(name, options.scope);
      } catch (error) {
        throw new Error(serverId + ': ctx.tools.get("' + name + '") threw: ' + describeThrown(error));
      }
      if (definition === undefined || typeof definition.execute !== 'function') {
        throw new Error(
          serverId + ': tool "' + name + '" is not registered in the DSH tool registry'
        );
      }
      const exec: DshToolExecution = {
        callId: newCallId(),
        name,
        arguments: args,
        signal: callOptions?.signal
      };
      try {
        const result = await definition.execute(args, exec);
        return toMcpToolResult(result);
      } catch (error) {
        return { content: [{ type: 'text', text: 'Error: ' + describeThrown(error) }], isError: true };
      }
    }
  };

  return client;
}
