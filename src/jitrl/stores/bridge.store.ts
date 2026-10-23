/**
 * P5-b: mirror of JitRL aggregate statistics into the governed memory bridge
 * (plan section 7.2, Phase 5).
 *
 * Ownership: src/jitrl/stores/bridge.store.ts (Phase 5, P5-b).
 *
 * The store implements the IJitMirrorStore contract declared in
 * src/types/contracts.ts. It mirrors ONLY aggregated statistics - per
 * (bucket, actionKey, level) sample count n, meanReturn and variance - into
 * the MCP memory backend behind an injected client. Namespaces are strictly
 * isolated per JitRL level (`${prefix}/jitrl/${level}`), so statistics of one
 * level can never leak into another level's namespace.
 *
 * Hard guarantees:
 * - Disabled mirror (config.jitrl.store.mirrorToMemoryBridge = false) is a
 *   strict no-op: mirror() resolves immediately with zero written rows and
 *   never touches the injected client, not even listTools.
 * - Aggregate-only payload: n, meanReturn, variance, bucket, actionKey and
 *   level, plus the structural fields required to keep the mirror usable and
 *   isolated (kind / namespace / updatedAt). Raw records, prompts, tool
 *   outputs, absolute paths and credentials never reach the backend: every
 *   free-form string passes the shared redaction helpers (../redaction.ts,
 *   read-only reuse) before it enters a write.
 * - Failure isolation: one failed or invalid write is recorded as a
 *   payload-free diagnostic; the remaining aggregates are still written and
 *   mirror() never throws.
 * - Host neutrality: the backend is the structural JitMirrorMcpClient
 *   boundary below, a compatible subset of the memory-bridge McpClient SPI.
 *   No concrete MCP implementation is imported and no network call is made
 *   from this module; tests inject deterministic fakes.
 * - Decoupling: the mirror consumes aggregate rows only. It never reads the
 *   local JSONL experience store.
 */

import type {
  IJitMirrorStore,
  JitLevel,
  JitMirrorResult,
  JitStatsAggregate
} from '../../types/contracts';
import { redactAbsolutePaths, redactSecrets } from '../redaction';

/** Tag carried by every mirrored aggregate (plan section 7.2: #jitrl-stat). */
export const JITRL_STAT_TAG = 'jitrl-stat';

/** Structural kind marker written into the metadata of every mirrored row. */
export const JITRL_STAT_KIND = 'jitrl-stat';

/**
 * One MCP tool descriptor as the mirror needs it. inputSchema stays unknown
 * on purpose: the mirror only probes it for property NAMES, never for types,
 * so any real descriptor (and any test double) fits structurally.
 */
export interface JitMirrorToolDescriptor {
  readonly name: string;
  readonly inputSchema?: unknown;
}

/**
 * Structural MCP write boundary. A compatible subset of the memory-bridge
 * McpClient SPI (tools/list + tools/call only), declared locally so this
 * module never imports from src/memory-bridge/**. Concrete clients are
 * supplied by the integrator; tests supply fakes.
 */
export interface JitMirrorMcpClient {
  readonly serverId: string;
  listTools(options?: { readonly timeoutMs?: number }): Promise<readonly JitMirrorToolDescriptor[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { readonly timeoutMs?: number }
  ): Promise<unknown>;
}

/** Construction options for the bridge mirror store. */
export interface BridgeMirrorStoreOptions {
  /** config.jitrl.store.mirrorToMemoryBridge; false keeps mirror() a no-op. */
  readonly mirrorToMemoryBridge: boolean;
  /** config.memoryBridge.namespacePrefix; sanitized per namespace segment. */
  readonly namespacePrefix: string;
  /** Injected MCP client; omit only when the mirror is disabled. */
  readonly client?: JitMirrorMcpClient;
  /** Milliseconds since epoch provider; defaults to Date.now. */
  readonly now?: () => number;
  /** Optional diagnostic sink (payload free, like every diagnostic here). */
  readonly onDiagnostic?: (diagnostic: string) => void;
}

/** The mirror contract plus its bounded payload-free diagnostic surface. */
export interface BridgeMirrorStore extends IJitMirrorStore {
  /** Recent store-level diagnostics (counts and tool names only, no payloads). */
  diagnostics(): readonly string[];
}

/**
 * Candidate write tools in priority order. The first tool advertised by the
 * backend whose name matches (case-insensitive) wins; backends that expose
 * none degrade to zero writes with a diagnostic instead of guessing.
 */
const WRITE_TOOL_CANDIDATES: readonly string[] = [
  'write_note',
  'create_note',
  'write_file',
  'create_memory',
  'add_memory',
  'save_memory',
  'create_entities',
  'remember',
  'write'
];

const TEXT_FIELD_CANDIDATES: readonly string[] = ['text', 'content', 'body', 'markdown', 'document'];
const PATH_FIELD_CANDIDATES: readonly string[] = ['path', 'identifier', 'title', 'name'];
const TAGS_FIELD_CANDIDATES: readonly string[] = ['tags'];
const METADATA_FIELD_CANDIDATES: readonly string[] = ['metadata', 'meta', 'properties', 'attributes'];

/** Anything outside this set is an illegal namespace/path segment character. */
const ILLEGAL_SEGMENT_CHARS = /[^A-Za-z0-9._-]+/g;

const JIT_LEVELS: readonly JitLevel[] = ['meta', 'proposal', 'host_tool'];

const MAX_STORE_DIAGNOSTICS = 100;

/** Argument field names resolved against the selected tool descriptor. */
interface ResolvedWriteFields {
  /** Text/document field; always present (falls back to 'text'). */
  readonly text: string;
  /** Path-like field, or null when the schema shows no such property. */
  readonly path: string | null;
  /** Tags field, or null when the schema shows no such property. */
  readonly tags: string | null;
  /** Metadata field, or null when the schema shows no such property. */
  readonly metadata: string | null;
}

/** The write tool chosen by discovery, together with its raw schema. */
interface ResolvedWriteTool {
  readonly name: string;
  readonly schema?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isJitLevel(value: unknown): value is JitLevel {
  return typeof value === 'string' && (JIT_LEVELS as readonly string[]).includes(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

/** Apply the shared redaction pipeline (secrets first, then absolute paths). */
function sanitizeText(raw: string): string {
  return redactAbsolutePaths(redactSecrets(raw));
}

/**
 * Join namespace parts into a slash-separated namespace: every part is split
 * on '/', each segment is trimmed and has illegal characters replaced, and
 * empty / traversal segments are dropped. The result can never contain empty
 * segments, consecutive slashes or illegal characters.
 */
function joinNamespaceSegments(parts: readonly string[]): string {
  const segments: string[] = [];
  for (const part of parts) {
    for (const piece of part.split('/')) {
      const normalized = piece.trim().replace(ILLEGAL_SEGMENT_CHARS, '-');
      if (normalized.length > 0 && normalized !== '.' && normalized !== '..') {
        segments.push(normalized);
      }
    }
  }
  return segments.join('/');
}

/** File-name-safe slug of one raw string (bucket / actionKey). */
function slugSegment(raw: string): string {
  const slug = raw.replace(ILLEGAL_SEGMENT_CHARS, '-').replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'x';
}

/** Deterministic djb2 hash, base36 - disambiguates slug collisions only. */
function stableHash(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/** Deterministic note path for one aggregate inside its level namespace. */
function statPath(namespace: string, level: JitLevel, bucket: string, actionKey: string): string {
  const bucketSlug = slugSegment(bucket);
  const actionSlug = slugSegment(actionKey);
  const hash = stableHash(level + '\u0000' + bucket + '\u0000' + actionKey);
  return namespace + '/' + bucketSlug + '.' + actionSlug + '-' + hash + '.md';
}

/** One aggregate document line: aggregate statistics only. */
function statDocument(
  level: JitLevel,
  bucket: string,
  actionKey: string,
  aggregate: JitStatsAggregate
): string {
  return (
    '#' +
    JITRL_STAT_TAG +
    ' level=' +
    level +
    ' bucket=' +
    bucket +
    ' actionKey=' +
    actionKey +
    ' n=' +
    String(aggregate.n) +
    ' meanReturn=' +
    String(aggregate.meanReturn) +
    ' variance=' +
    String(aggregate.variance)
  );
}

/** A row is mirrorable only when every statistical field is well-formed. */
function isValidAggregate(aggregate: JitStatsAggregate): boolean {
  return (
    typeof aggregate.bucket === 'string' &&
    aggregate.bucket.trim().length > 0 &&
    typeof aggregate.actionKey === 'string' &&
    aggregate.actionKey.trim().length > 0 &&
    isJitLevel(aggregate.level) &&
    isFiniteNumber(aggregate.n) &&
    aggregate.n >= 1 &&
    isFiniteNumber(aggregate.meanReturn) &&
    isFiniteNumber(aggregate.variance) &&
    aggregate.variance >= 0
  );
}

/** True when the backend answered with an MCP error result. */
function backendRejection(result: unknown): string | null {
  if (isRecord(result) && result.isError === true) {
    return 'backend reported isError for the stat write';
  }
  return null;
}

function schemaPropertyNames(schema: unknown): Set<string> | null {
  if (!isRecord(schema)) {
    return null;
  }
  const properties = schema.properties;
  if (!isRecord(properties)) {
    return null;
  }
  return new Set(Object.keys(properties));
}

/**
 * Resolve argument field names against the tool schema. With no schema
 * (null) the conservative defaults are used; with a schema that shows none
 * of the optional candidates the argument is omitted entirely so a strict
 * backend is never handed unknown properties.
 */
function resolveWriteFields(schema: unknown): ResolvedWriteFields {
  const names = schemaPropertyNames(schema);
  const pick = (candidates: readonly string[], fallback: string | null): string | null => {
    if (names === null) {
      return fallback;
    }
    for (const candidate of candidates) {
      if (names.has(candidate)) {
        return candidate;
      }
    }
    return null;
  };
  return {
    text: pick(TEXT_FIELD_CANDIDATES, 'text') ?? 'text',
    path: pick(PATH_FIELD_CANDIDATES, 'path'),
    tags: pick(TAGS_FIELD_CANDIDATES, 'tags'),
    metadata: pick(METADATA_FIELD_CANDIDATES, 'metadata')
  };
}

/** Create the P5-b aggregate statistics mirror (plan section 7.2). */
export function createJitBridgeMirrorStore(options: BridgeMirrorStoreOptions): BridgeMirrorStore {
  const enabled = options.mirrorToMemoryBridge === true;
  const namespacePrefix = typeof options.namespacePrefix === 'string' ? options.namespacePrefix : '';
  const now = options.now ?? ((): number => Date.now());
  const namespaceCache = new Map<JitLevel, string>();
  const recentDiagnostics: string[] = [];

  const record = (diagnostics: readonly string[]): void => {
    for (const diagnostic of diagnostics) {
      recentDiagnostics.push(diagnostic);
      options.onDiagnostic?.(diagnostic);
    }
    if (recentDiagnostics.length > MAX_STORE_DIAGNOSTICS) {
      recentDiagnostics.splice(0, recentDiagnostics.length - MAX_STORE_DIAGNOSTICS);
    }
  };

  const store: BridgeMirrorStore = {
    namespaceFor(level: JitLevel): string {
      const cached = namespaceCache.get(level);
      if (cached !== undefined) {
        return cached;
      }
      const computed = joinNamespaceSegments([namespacePrefix, 'jitrl', level]);
      namespaceCache.set(level, computed);
      return computed;
    },

    async mirror(aggregates: readonly JitStatsAggregate[]): Promise<JitMirrorResult> {
      // Disabled mirror: strict no-op, zero backend contact, zero side effects.
      if (!enabled) {
        return { written: 0, skipped: 0, namespaces: [], degraded: false, diagnostics: [] };
      }
      // Nothing to mirror: still zero backend contact.
      if (aggregates.length === 0) {
        return { written: 0, skipped: 0, namespaces: [], degraded: false, diagnostics: [] };
      }
      try {
        return await mirrorAll(aggregates);
      } catch (error) {
        const diagnostics = ['unexpected aggregate mirror failure: ' + errorMessage(error)];
        record(diagnostics);
        return { written: 0, skipped: aggregates.length, namespaces: [], degraded: true, diagnostics };
      }
    },

    diagnostics(): readonly string[] {
      return [...recentDiagnostics];
    }
  };
  return store;

  async function mirrorAll(aggregates: readonly JitStatsAggregate[]): Promise<JitMirrorResult> {
    const client = options.client;
    if (client === undefined) {
      const diagnostics = ['no MCP memory client is injected: aggregate mirror degrades to zero writes'];
      record(diagnostics);
      return { written: 0, skipped: aggregates.length, namespaces: [], degraded: true, diagnostics };
    }

    const diagnostics: string[] = [];
    const tool = await resolveWriteTool(client, diagnostics);
    if (tool === null) {
      record(diagnostics);
      return { written: 0, skipped: aggregates.length, namespaces: [], degraded: true, diagnostics };
    }
    const fields = resolveWriteFields(tool.schema);

    let written = 0;
    const namespaces = new Set<string>();
    for (let index = 0; index < aggregates.length; index += 1) {
      const aggregate = aggregates[index];
      if (aggregate === undefined) {
        continue;
      }
      if (!isValidAggregate(aggregate)) {
        diagnostics.push('skipped an invalid aggregate row at index ' + String(index));
        continue;
      }
      // The namespace is recomputed from the row's own level, so isolation
      // never depends on the caller filling JitStatsAggregate.namespace.
      const namespace = store.namespaceFor(aggregate.level);
      try {
        await writeRow(client, tool.name, fields, aggregate, namespace);
        written += 1;
        namespaces.add(namespace);
      } catch (error) {
        diagnostics.push(
          'stat write failed in namespace ' + namespace + ' (row ' + String(index) + '): ' + errorMessage(error)
        );
      }
    }

    record(diagnostics);
    return {
      written,
      skipped: aggregates.length - written,
      namespaces: [...namespaces].sort(),
      degraded: diagnostics.length > 0,
      diagnostics
    };
  }

  /** One listTools round per mirror() call; the chosen tool and its schema. */
  async function resolveWriteTool(
    client: JitMirrorMcpClient,
    diagnostics: string[]
  ): Promise<ResolvedWriteTool | null> {
    let descriptors: readonly JitMirrorToolDescriptor[];
    try {
      descriptors = await client.listTools();
    } catch (error) {
      diagnostics.push('listTools failed on ' + client.serverId + ': ' + errorMessage(error));
      return null;
    }
    for (const candidate of WRITE_TOOL_CANDIDATES) {
      const match = descriptors.find(
        (descriptor) => typeof descriptor?.name === 'string' && descriptor.name.toLowerCase() === candidate
      );
      if (match !== undefined) {
        return { name: match.name, schema: match.inputSchema };
      }
    }
    diagnostics.push('no aggregate write tool advertised by ' + client.serverId);
    return null;
  }

  async function writeRow(
    client: JitMirrorMcpClient,
    tool: string,
    fields: ResolvedWriteFields,
    aggregate: JitStatsAggregate,
    namespace: string
  ): Promise<void> {
    // Only aggregate statistics pass through; every free-form string is
    // redacted with the shared helpers before it enters the payload - the
    // note path included, so a slug can never carry secret-shaped text.
    const bucket = sanitizeText(aggregate.bucket);
    const actionKey = sanitizeText(aggregate.actionKey);
    const document = sanitizeText(statDocument(aggregate.level, bucket, actionKey, aggregate));
    const updatedAt = aggregate.updatedAt ?? now();

    const args: Record<string, unknown> = { [fields.text]: document };
    if (fields.path !== null) {
      args[fields.path] = statPath(namespace, aggregate.level, bucket, actionKey);
    }
    if (fields.tags !== null) {
      args[fields.tags] = [JITRL_STAT_TAG];
    }
    if (fields.metadata !== null) {
      args[fields.metadata] = {
        kind: JITRL_STAT_KIND,
        namespace,
        level: aggregate.level,
        bucket,
        actionKey,
        n: aggregate.n,
        meanReturn: aggregate.meanReturn,
        variance: aggregate.variance,
        updatedAt
      };
    }

    const result = await client.callTool(tool, args);
    const rejection = backendRejection(result);
    if (rejection !== null) {
      throw new Error(rejection);
    }
  }
}
