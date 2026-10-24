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
 *   structured, payload-free diagnostic (P6.1-B1 whitelist: bounded codes,
 *   phases, operations, error classes and hash correlation references only -
 *   backend error text, tool names and payloads never render); the remaining
 *   aggregates are still written and mirror() never throws.
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

/**
 * P6.1-B1: mirror diagnostics are structured and whitelist-rendered.
 *
 * Every visible diagnostic line is assembled from a FIXED field set
 * (`mirror_diag code= phase= operation= retryable= errorClass= correlationId=
 * [serverRef= namespaceRef=]`), never by echoing a backend error message.
 * Backend error bodies, tool arguments and note text are dropped at the
 * throw boundary: they are classified into one bounded `errorClass` enum and
 * one bounded `code` enum instead. No per-example redaction regex is added;
 * the only pattern-based rule left is the generic RAW_PAYLOAD shape rule
 * kept from the earlier repair (it guards the sanitizer surface itself).
 *
 * Hash notes: the short FNV-1a hashes below are NOT cryptographic
 * anonymization - they exist only to correlate repeated diagnostics for the
 * same server/namespace across lines. serverRef/namespaceRef are emitted
 * only where a masked correlation anchor is genuinely useful, and `hashOf`
 * stays private to this module so it cannot be mistaken for a general
 * de-identification helper. Raw-error debugging has no channel here: any
 * future debug surface must be a separate, explicitly authorized, retention-
 * bounded local log - never the model-visible or memory-mirror diagnostics.
 */

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
  /**
   * Recent store-level diagnostics (P6.1-B1 whitelist): every line is rendered
   * from the fixed field set `mirror_diag code= phase= operation= retryable=
   * errorClass= correlationId= [serverRef= namespaceRef=]` - bounded enums and
   * masked hash references only. No counts, no tool names, no backend error
   * text, no payloads (see the module header and renderDiagnostic()).
   */
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

/** Maximum length of any diagnostic string emitted by bridge store (kept). */
export const MAX_DIAGNOSTIC_LENGTH = 200;

/** Apply the shared redaction pipeline (secrets first, then absolute paths). */
function sanitizeText(raw: string): string {
  return redactAbsolutePaths(redactSecrets(raw));
}

/** Bounded diagnostic phase enum (P6.1-B1 whitelist). */
const DIAG_PHASES = ['discovery', 'write', 'unexpected'] as const;
type DiagPhase = (typeof DIAG_PHASES)[number];

/** Bounded diagnostic operation enum (P6.1-B1 whitelist). */
const DIAG_OPERATIONS = ['listTools', 'statWrite', 'aggregate'] as const;
type DiagOperation = (typeof DIAG_OPERATIONS)[number];

/** Bounded diagnostic error-class enum (P6.1-B1 whitelist). */
const DIAG_ERROR_CLASSES = [
  'transport',
  'backend_rejection',
  'invalid_input',
  'timeout',
  'aborted',
  'unknown'
] as const;
type DiagErrorClass = (typeof DIAG_ERROR_CLASSES)[number];

/** Bounded diagnostic code enum (P6.1-B1 whitelist). */
const DIAG_CODES = [
  'list_tools_failed',
  'no_write_tool',
  'no_client',
  'write_failed',
  'invalid_row',
  'aggregate_failed'
] as const;
type DiagCode = (typeof DIAG_CODES)[number];

/** One structured, payload-free mirror diagnostic (P6.1-B1 whitelist). */
export interface MirrorDiagnostic {
  readonly code: DiagCode;
  readonly phase: DiagPhase;
  readonly operation: DiagOperation;
  readonly retryable: boolean;
  readonly errorClass: DiagErrorClass;
  /** Correlation reference: bounded mirror-internal sequence + optional hashes. */
  readonly correlationId: string;
  /** Masked short-hash reference (`server:<8hex>`); only for correlation. */
  readonly serverRef?: string;
  /** Masked short-hash reference (`ns:<8hex>`); only for correlation. */
  readonly namespaceRef?: string;
}

/**
 * Classify an unknown thrown value into one bounded error class (P6.1-B1).
 * The error message itself is NEVER read or echoed; only structural facts
 * (prototype name, DOMException-ish `name`, MCP `isError` markers) feed the
 * classification, and everything unmapped folds into `unknown`.
 */
function classifyError(error: unknown): DiagErrorClass {
  if (error instanceof BackendRejectionError) {
    return 'backend_rejection';
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return 'aborted';
    }
    if (error.name === 'TimeoutError') {
      return 'timeout';
    }
    // Node/undici-style structural signals carried as typed names.
    if (error.name === 'TypeError' || error.name === 'RangeError') {
      return error.name === 'TypeError' ? 'transport' : 'invalid_input';
    }
    return 'unknown';
  }
  if (typeof error === 'string') {
    return 'unknown';
  }
  return 'unknown';
}

/** Stable hash suffix used by the whitelisted correlation references. */
function hashOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Mask a serverId using a deterministic short hash (correlation ref only). */
export function maskServerId(serverId: string): string {
  if (!serverId || typeof serverId !== 'string') {
    return 'server:unknown';
  }
  return 'server:' + hashOf(serverId);
}

/** Mask a namespace using a deterministic short hash (correlation ref only). */
export function maskNamespace(namespace: string): string {
  if (!namespace || typeof namespace !== 'string') {
    return 'ns:unknown';
  }
  return 'ns:' + hashOf(namespace);
}

/** The masked correlation references for one diagnostic, when supplied. */
function correlationRefs(
  serverId?: string,
  namespace?: string
): Pick<MirrorDiagnostic, 'serverRef' | 'namespaceRef'> {
  const refs: {
    serverRef?: string;
    namespaceRef?: string;
  } = {};
  if (typeof serverId === 'string' && serverId.length > 0) {
    refs.serverRef = maskServerId(serverId);
  }
  if (typeof namespace === 'string' && namespace.length > 0) {
    refs.namespaceRef = maskNamespace(namespace);
  }
  return refs;
}

/** The only diagnostic text field renderer; every field is a bounded enum. */
function whitelistFields(diagnostic: MirrorDiagnostic): string {
  const fields: readonly (readonly string[])[] = [
    ['code', diagnostic.code],
    ['phase', diagnostic.phase],
    ['operation', diagnostic.operation],
    ['retryable', String(diagnostic.retryable)],
    ['errorClass', diagnostic.errorClass],
    ['correlationId', diagnostic.correlationId],
    ...(diagnostic.serverRef === undefined ? [] : [['serverRef', diagnostic.serverRef] as const]),
    ...(diagnostic.namespaceRef === undefined
      ? []
      : [['namespaceRef', diagnostic.namespaceRef] as const])
  ];
  return fields.map(([key, value]) => key + '=' + value).join(' ');
}

export interface SanitizeDiagnosticOptions {
  readonly serverId?: string;
  readonly namespace?: string;
}

/**
 * Sanitize and bound diagnostic text (P6.1-B1 hardening):
 * - Redacts secrets and absolute paths using sanitizeText() (kept from the
 *   earlier repairs: keys must stay redacted even inside bounded fields).
 * - Masks serverId/namespace supplied as explicit context with short hashes.
 * - Keeps the generic RAW_PAYLOAD shape rule (no per-example regexes are
 *   added; example-specific matching is removed entirely).
 * - Truncates to MAX_DIAGNOSTIC_LENGTH.
 */
export function sanitizeDiagnostic(raw: string, options?: SanitizeDiagnosticOptions): string {
  let sanitized = sanitizeText(raw);
  if (options?.serverId) {
    sanitized = sanitized.replaceAll(options.serverId, maskServerId(options.serverId));
  }
  if (options?.namespace) {
    sanitized = sanitized.replaceAll(options.namespace, maskNamespace(options.namespace));
  }
  // Mask RAW_PAYLOAD-shaped echo tokens (generic shape rule, not example-specific).
  sanitized = sanitized.replace(/RAW_PAYLOAD[^\s"':;,]*/gi, '<payload>');
  if (sanitized.length > MAX_DIAGNOSTIC_LENGTH) {
    sanitized = sanitized.slice(0, MAX_DIAGNOSTIC_LENGTH - 1) + '\u2026';
  }
  // Field-level defense in depth: the whitelist fields are bounded enums by
  // construction, so this pass is a no-op for well-formed diagnostics and a
  // bounds check for anything a future caller hands in directly.
  return sanitizeText(sanitized);
}

/**
 * Bounded-per-call counter that keeps correlationIds unique within one
 * mirror() invocation without persisting anything across calls.
 */
function correlationIdFactory(): (code: DiagCode) => string {
  let sequence = 0;
  return (code: DiagCode): string => {
    sequence += 1;
    return 'mirror-' + code + '-' + String(sequence);
  };
}

/**
 * Render one structured diagnostic line through the whitelist. The result
 * contains no free-form text by construction: every field is a bounded enum
 * or a hash reference, so no backend message body can appear.
 */
function renderDiagnostic(
  diagnostic: MirrorDiagnostic,
  context?: SanitizeDiagnosticOptions
): string {
  const line = 'mirror_diag ' + whitelistFields(diagnostic);
  // sanitizeText keeps the secret/path scrub as defense in depth; enums and
  // hashes never match those patterns, so the line passes through unchanged.
  return sanitizeDiagnostic(line, context);
}

/**
 * Convert a failure at a known phase into its structured, payload-free
 * diagnostic. This replaces the previous free-form errorMessage() echo: the
 * thrown value is consumed only for classification, never for its text.
 */
function diagnosticFromError(
  code: DiagCode,
  phase: DiagPhase,
  operation: DiagOperation,
  error: unknown,
  correlation: (code: DiagCode) => string,
  refs?: Pick<MirrorDiagnostic, 'serverRef' | 'namespaceRef'>
): string {
  // Backend MCP rejections surface here as BackendRejectionError thrown by
  // writeRow() from the structural isError answer; the classification reads
  // the marker type only and never the backend message body.
  const errorClass = classifyError(error);
  const diagnostic: MirrorDiagnostic = {
    code,
    phase,
    operation,
    retryable: errorClass === 'transport' || errorClass === 'timeout' || errorClass === 'aborted',
    errorClass,
    correlationId: correlation(code),
    ...refs
  };
  return renderDiagnostic(diagnostic);
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

/**
 * P6.1-B1 structural marker for an MCP isError answer. It carries NO backend
 * text: the rejection is signaled by type, so downstream classification can
 * never depend on (or echo) the backend message body.
 */
export class BackendRejectionError extends Error {
  constructor() {
    super('backend reported isError for the stat write');
    this.name = 'BackendRejectionError';
  }
}

/** True when the backend answered with an MCP error result. */
function backendRejection(result: unknown): boolean {
  return isRecord(result) && result.isError === true;
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
      // Defense in depth: every recorded line goes through the sanitizer,
      // and a throwing onDiagnostic sink can never break mirror() itself.
      const safe = sanitizeDiagnostic(diagnostic);
      recentDiagnostics.push(safe);
      try {
        options.onDiagnostic?.(safe);
      } catch {
        // Diagnostic sink failures must not degrade mirroring.
      }
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
      const correlation = correlationIdFactory();
      try {
        return await mirrorAll(aggregates, correlation);
      } catch (error) {
        // P6.1-B1: the thrown value is classified structurally, never echoed.
        const diagnostics = [
          diagnosticFromError(
            'aggregate_failed',
            'unexpected',
            'aggregate',
            error,
            correlation,
            correlationRefs(options.client?.serverId)
          )
        ];
        record(diagnostics);
        return { written: 0, skipped: aggregates.length, namespaces: [], degraded: true, diagnostics };
      }
    },

    diagnostics(): readonly string[] {
      return [...recentDiagnostics];
    }
  };
  return store;

  async function mirrorAll(
    aggregates: readonly JitStatsAggregate[],
    correlation: (code: DiagCode) => string
  ): Promise<JitMirrorResult> {
    const client = options.client;
    if (client === undefined) {
      const diagnostics = [
        renderDiagnostic(
          {
            code: 'no_client',
            phase: 'discovery',
            operation: 'aggregate',
            retryable: false,
            errorClass: 'invalid_input',
            correlationId: correlation('no_client')
          }
        )
      ];
      record(diagnostics);
      return { written: 0, skipped: aggregates.length, namespaces: [], degraded: true, diagnostics };
    }

    const diagnostics: string[] = [];
    const tool = await resolveWriteTool(client, diagnostics, correlation);
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
        diagnostics.push(
          renderDiagnostic({
            code: 'invalid_row',
            phase: 'write',
            operation: 'aggregate',
            retryable: false,
            errorClass: 'invalid_input',
            correlationId: correlation('invalid_row')
          })
        );
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
        // P6.1-B1: no error text, tool args or namespace are echoed - only
        // the bounded enum set plus masked hash references.
        diagnostics.push(
          diagnosticFromError(
            'write_failed',
            'write',
            'statWrite',
            error,
            correlation,
            correlationRefs(client.serverId, namespace)
          )
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
    diagnostics: string[],
    correlation: (code: DiagCode) => string
  ): Promise<ResolvedWriteTool | null> {
    let descriptors: readonly JitMirrorToolDescriptor[];
    try {
      descriptors = await client.listTools();
    } catch (error) {
      // P6.1-B1: the transport failure is classified; its text is dropped.
      diagnostics.push(
        diagnosticFromError(
          'list_tools_failed',
          'discovery',
          'listTools',
          error,
          correlation,
          correlationRefs(client.serverId)
        )
      );
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
    diagnostics.push(
      renderDiagnostic({
        code: 'no_write_tool',
        phase: 'discovery',
        operation: 'listTools',
        retryable: false,
        errorClass: 'backend_rejection',
        correlationId: correlation('no_write_tool'),
        serverRef: maskServerId(client.serverId)
      })
    );
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
    if (backendRejection(result)) {
      throw new BackendRejectionError();
    }
  }
}
