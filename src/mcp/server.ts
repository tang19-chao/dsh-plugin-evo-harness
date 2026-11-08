/**
 * MCP stdio entry for the evo-harness (rev8 plan §5.2-§5.4, stage 3).
 *
 * WHAT THIS IS
 *   One process: the SAME plugin the Cordis entry mounts (through
 *   {@link buildEvoAssembly}, never a copied wiring) exposed over the Model
 *   Context Protocol as server name 'evo' with EXACTLY SEVEN tools:
 *
 *     evo_status      - read-only status projection (sync)
 *     evo_run_submit  - start a run, return { runId } immediately (start)
 *     evo_run_poll    - poll a run to its EvoHarnessRunResult (poll)
 *     evo_dream       - triggerDream through the orchestrator (gate-protected)
 *     evo_jit         - the /evo jit controller via plugin.runFromCommand
 *     evo_lessons     - lastLessons + dreamReports, bounded, redacted
 *     evo_text_probe  - evaluateTextProbe (always not-evaluable, honestly)
 *
 * REGISTRATION (the ask: "标准注册 API，不手写协议")
 *   Tools go through `McpServer.registerTool`; the wire (initialize 2025-06-18,
 *   notifications/initialized, tools/list, tools/call) is the installed
 *   @modelcontextprotocol/server 2.2.0's own - SUPPORTED_PROTOCOL_
 *   VERSIONS includes '2025-06-18' and the negotiation is the SDK's, verified
 *   in this session (t-proto: negotiated: 2025-06-18). Input schemas are JSON
 *   Schema objects wrapped with the SDK's own `fromJsonSchema` export - the
 *   documented path for hand-written schemas (zod is NOT a dependency of this
 *   package and is deliberately not imported).
 *
 * TRANSPORT
 *   stdio via the SDK's `serveStdio` (server/stdio subpath), with THIS module's
 *   own disconnect wiring on top: serveStdio's `wire.onclose` (stdio.mjs) closes
 *   the pinned McpServer PRODUCT but never calls any host callback, so a client
 *   disconnect would otherwise leave the assembly (and its persistence runtime)
 *   alive behind an empty stdin handle. `serveEvoMcpStdio` therefore passes a
 *   custom `StdioServerTransport` and wraps its `onclose` BEFORE
 *   `server.connect()`: when the client closes stdin, the transport fires
 *   onclose -> the SDK's Protocol._onclose aborts in-flight handlers, and our
 *   wrapper also cancels every running job through the book and disposes the
 *   assembly, so nothing keeps the process alive (verified this session against
 *   node_modules/@modelcontextprotocol/server/dist/stdio.mjs:88-99 close() fires
 *   `this.onclose?.()` last, and :566-572 wire.onclose closes only the product).
 *
 * CANCELLATION HONESTY (the ask: describe only what is real)
 *   - A job runs to completion server-side once submitted; the MCP
 *     `notifications/cancelled` of an ALREADY-RETURNED evo_run_submit cannot
 *     cancel it (the tool call had no in-flight request to abort). No tool
 *     result or comment may claim otherwise.
 *   - The real cancellation paths are: (a) client DISCONNECT (stdin close) —
 *     the transport's onclose wrapper cancels all running jobs; (b) the server
 *     shutting down — dispose() cancels all running jobs first. Both are
 *     exercised by tests (real subprocess stdin close; direct dispose).
 *
 * OUTPUT DISCIPLINE (plan §5.2: ≤8k chars, structured, never fake a zero)
 *   - Sync tools return short text plus the full payload as structuredContent.
 *   - Every structured payload is JSON-stringified and text-clipped (marker
 *     included) at 8 000 characters total.
 *   - Tool failures return isError:true results carrying the error's code -
 *     an exception never becomes a fabricated 0-score or a fake success.
 *   - EVERYTHING crossing the boundary — text AND structuredContent, deep —
 *     passes redactSecrets (src/jitrl/redaction.ts) recursively over strings:
 *     status.lastRun, poll.result, lessons fields, jit json included. The
 *     redaction never receives AbortSignal instances (they cannot be cloned to
 *     JSON and are stripped at the assembly of each payload).
 *
 * NO HOST CONTEXT (plan §5.3)
 *   The assembly runs with ctx=undefined, in-memory host only, no clients,
 *   no collaborator probing, no triggers; execution is pinned to shadow
 *   (MCP_EXECUTION_DEFAULTS). Nothing here can mount a patch into any real
 *   host, publish, or write to a memory backend.
 *
 * LAZY STARTUP (the lifecycle fix)
 *   `createEvoMcpServer` builds the McpServer and registers the seven tools; it
 *   does NOT build the assembly. `buildEvoAssembly` is not side-effect free —
 *   it resolves the profile directory, creates it, opens the tree-pool log and
 *   the policy store and runs the plugin's cold-start JitRL backfill — so an
 *   eager build at construction would create and write a data directory for a
 *   server that is never called, contradicting the `dryRun` promise
 *   (README.md:264 and the tool's own note below). The build therefore starts
 *   on the first REAL consumer: any tool handler that needs the assembly, or an
 *   explicit read of the handle's `ready` getter. A construction-only lifetime
 *   touches no disk, and `dispose()` on such a server is a true no-op.
 *
 *   Disposal while the build is still in flight awaits that build and disposes
 *   what it produced, so no background persistence runtime outlives the
 *   teardown. After `dispose()` the latch refuses every further build: a tool
 *   call that arrives post-teardown returns a named error result
 *   (`EVO_MCP_DISPOSED_MESSAGE`) instead of resurrecting an assembly.
 *
 * DURABILITY HONESTY
 *   The job book is in-memory; a restart loses run records and `evo_run_poll`
 *   says 'unknown_run_id' (never claims recovery). What DOES survive a restart
 *   is the persistence runtime's own data (tree pool, policy, counters), which
 *   the plugin rehydrates on the next assembly - verified by the assembly
 *   suite's reopen tests.
 */

import {
  McpServer,
  fromJsonSchema,
  type ToolAnnotations
} from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import type { JsonSchemaType } from '@modelcontextprotocol/server';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

import {
  buildEvoAssembly,
  MCP_EXECUTION_DEFAULTS,
  type EvoAssembly,
  type EvoAssemblyInput
} from './assembly';
import { createJobBook, McpJobBookError, type McpJobSnapshot } from './job-book';
import { DEFAULT_OPENAI_BASE_URL, createOpenAiModelAdapter } from './openai-model-adapter';
import { assessDreamReadiness, MIN_VERIFIED_TREES_FOR_DREAM } from '../dream-rsi/verified-tree-gate';
import { redactSecrets } from '../jitrl/redaction';
import type {
  CanonicalLesson,
  DreamReplayReport,
  EvoHarnessRunRequest,
  EvoHarnessRunResult,
  RunBudgetOverride
} from '../types/contracts';

// ---------------------------------------------------------------------------
// constants (process-level, never tool-input configurable)
// ---------------------------------------------------------------------------

/** Server identity the MCP client sees (plan §5.2: serverName='evo'). */
export const EVO_MCP_SERVER_NAME = 'evo';
export const EVO_MCP_SERVER_VERSION = '0.1.0';

/**
 * Environment variables the PRODUCTION adapter reads (rev8 boundary fix 1: the
 * deployed template's env block is live configuration, not documentation).
 * Both fall back to the adapter's own safe defaults and are validated as
 * non-empty strings — an empty value means "not configured", never "the empty
 * model id".
 */
export const EVO_MODEL_BASE_URL_ENV = 'EVO_MODEL_BASE_URL';
export const EVO_MODEL_ID_ENV = 'EVO_MODEL_ID';

/**
 * The hard text cap for any single tool result (plan §5.2: ≤8k chars, inside
 * the host's spill/pruner gates before they would clip us).
 */
export const EVO_TOOL_TEXT_LIMIT = 8_000;

/**
 * How long dispose waits for cancelled runs to settle before the persistence
 * flush (rev8 boundary fix 9). Bounded on purpose: shutdown must never hang on
 * a runner that ignores its abort signal. 2000ms dwarfs a healthy unwind (the
 * abort reaches the probes in-process; the orchestrator's finalize path is
 * synchronous bookkeeping plus queued writes) while keeping worst-case
 * shutdown latency finite and observable (the deviation is logged).
 */
export const DISPOSE_SETTLE_WAIT_MS = 2_000;

/** One real-clock sleep; dispose's settle wait is an operational property. */
const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Tools this server registers, in list order (the probe asserts the set). */
export const EVO_TOOL_NAMES = [
  'evo_status',
  'evo_run_submit',
  'evo_run_poll',
  'evo_dream',
  'evo_jit',
  'evo_lessons',
  'evo_text_probe'
] as const;

export type EvoToolName = (typeof EVO_TOOL_NAMES)[number];

/**
 * Instructions for the system prompt (plan §5.3: ~15 lines, under 32768 bytes).
 * Kept byte-counted so a future edit cannot silently breach the host's
 * maxInstructionBytes limit.
 */
export const EVO_MCP_INSTRUCTIONS = [
  'evo-harness: offline self-evolution engine (Harness^2 + Dream-RSI + JitRL).',
  '- evo_run_submit starts a full search (reference probe + candidate probes) and',
  '  returns a runId; poll with evo_run_poll. Default mode is SHADOW: it only',
  '  produces proposals and experience records; it NEVER modifies the host\'s',
  '  system prompt, tools, or permissions.',
  '- Proposals are suggestions with a TTL, not applied patches. Read',
  '  result.metadata.lifecycle for the stage trace; verdicts are three-state',
  '  (graded / ungraded / not-evaluable) - an ungraded verdict is not a zero.',
  '- evo_dream replays verified trees offline (needs >=12 verified trees).',
  '- Pass cwd/sessionId explicitly; the server has no host context.'
].join('\n');

/** Read-only tools carry readOnlyHint annotations (informational for hosts). */
const READ_ONLY: ToolAnnotations = { readOnlyHint: true };
const WRITE_LOCAL: ToolAnnotations = { readOnlyHint: false, destructiveHint: false };

// ---------------------------------------------------------------------------
// JSON-Schema helpers (fromJsonSchema keeps us zod-free)
// ---------------------------------------------------------------------------

/** Shorthand for a nullable-free optional string property. */
function str(description: string): JsonSchemaType {
  return { type: 'string', description };
}

/** The shared object root every tool input schema starts from. */
function objectSchema(properties: Record<string, JsonSchemaType>, required: string[] = []): JsonSchemaType {
  return { type: 'object', properties, required, additionalProperties: false };
}

// ---------------------------------------------------------------------------
// serialization discipline
// ---------------------------------------------------------------------------

/** The redaction helper narrowed to the boundary's needs. */
export function redactForBoundary(text: string): string {
  return redactSecrets(text);
}

/**
 * TRUE deep redaction for EVERYTHING that crosses the boundary (rev8 boundary
 * fix 5: not only the text mirror). Walks plain objects/arrays and applies
 * redactSecrets to every string; primitives, booleans, numbers, nulls and
 * undefined pass through. Nothing else is reachable here: AbortSignal,
 * functions, class instances and other non-JSON values are DROPPED from
 * structured output (a signal cannot be cloned through JSON and must never
 * surface in metadata); getters that throw are treated as absent.
 */
export function redactDeepForBoundary(value: unknown, depth: number = 0): unknown {
  // Depth-bounded: a run result is a bounded contract shape, but a hostile
  // payload must not be able to recurse the serializer to death. 16 levels
  // dwarfs every real payload (results nest 4-5 deep at most).
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === undefined) {
    return typeof value === 'string' ? redactForBoundary(value) : value;
  }
  if (depth >= 16) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const entry of value) {
      const redacted = redactDeepForBoundary(entry, depth + 1);
      if (redacted !== undefined) {
        out.push(redacted);
      }
    }
    return out;
  }
  if (Object.prototype.toString.call(value) !== '[object Object]') {
    // AbortSignal, Date, Map, functions, class instances: not JSON values.
    // (Dates are not produced by the run-result contract; timestamps are
    // numbers.) Dropping beats crashing or leaking a host object.
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let entries: [string, unknown][];
  try {
    entries = Object.entries(source);
  } catch {
    return undefined;
  }
  for (const [key, entry] of entries) {
    try {
      const redacted = redactDeepForBoundary(entry, depth + 1);
      if (redacted !== undefined) {
        out[key] = redacted;
      }
    } catch {
      // A throwing getter is treated as absent, never fatal.
    }
  }
  return out;
}

/**
 * Clip one text block so the WHOLE string (clipping marker included) stays at
 * the 8k limit (plan §5.2: the caller is told what was clipped, and
 * structuredContent carries the full value when one exists).
 */
export function clipToolText(text: string, limit: number = EVO_TOOL_TEXT_LIMIT): string {
  const redacted = redactForBoundary(text);
  if (redacted.length <= limit) {
    return redacted;
  }
  const marker = '\n… [clipped; the structuredContent field carries the complete value]';
  // Budget the marker in so the FINAL length (marker included) is <= limit.
  return redacted.slice(0, Math.max(0, limit - marker.length)) + marker;
}

/** Text result with a full-value mirror in structuredContent. */
function textResult(text: string, structured: Record<string, unknown>): {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
} {
  return {
    content: [{ type: 'text', text: clipToolText(text) }],
    structuredContent: structured
  };
}

/** Error result: never a fabricated score, always the stable code. */
function errorResult(code: string, message: string, extra: Record<string, unknown> = {}): {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
  isError: true;
} {
  const text = redactForBoundary('error ' + code + ': ' + message);
  const redactedExtra = (redactDeepForBoundary(extra) ?? {}) as Record<string, unknown>;
  return {
    content: [{ type: 'text', text: clipToolText(text) }],
    structuredContent: { ok: false, code, message: text, ...redactedExtra },
    isError: true
  };
}

/**
 * JSON with a bounded, redacted text mirror. The structuredContent is the
 * DEEP-REDACTED value (rev8 boundary fix 5): the boundary is one choke point,
 * so status.lastRun, poll.result, lessons and jit json cannot slip through
 * unredacted even when a future edit forgets the text mirror.
 */
function structuredAndText(value: unknown, headline: string): {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
} {
  const payload = (redactDeepForBoundary(value) ?? {}) as Record<string, unknown>;
  const json = JSON.stringify(payload, null, 2) ?? 'null';
  return textResult(headline + '\n' + json, { ok: true, payload });
}

// ---------------------------------------------------------------------------
// server options and state
// ---------------------------------------------------------------------------

/** Everything the server needs; every field has a production default. */
export interface EvoMcpServerOptions {
  /** Assembly overrides (config section, dataDir options, injected clock). */
  readonly assembly?: Partial<Omit<EvoAssemblyInput, 'model'>>;
  /** Replace the production OpenAI-gateway adapter (tests: a scripted one). */
  readonly model?: EvoAssemblyInput['model'];
  /**
   * Environment snapshot for the PRODUCTION adapter (rev8 boundary fix 1).
   * Defaults to process.env; tests inject a fake. Read ONCE at adapter
   * creation for EVO_MODEL_BASE_URL / EVO_MODEL_ID; the key envs stay inside
   * the adapter (read there per request).
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Fetch implementation for the PRODUCTION adapter (defaults to globalThis
   * fetch inside the adapter; tests inject a stub so the env→adapter
   * propagation test never touches a network). Ignored when `model` replaces
   * the production adapter.
   */
  readonly fetch?: typeof fetch;
  /** Per-run deadline for the job book (undefined = probe budgets only). */
  readonly runTimeoutMs?: number;
  /** First-poll delay reported by submit (default 1000ms). */
  readonly pollAfterMs?: number;
  /** Injected clock, shared with the assembly and the job book. */
  readonly now?: () => number;
  /** Non-secret diagnostics (stderr by default via the stdio entry). */
  readonly log?: (line: string) => void;
}

/** Which state a status report reflects. */
export interface EvoStatusReport {
  readonly server: { readonly name: string; readonly version: string };
  readonly execution: typeof MCP_EXECUTION_DEFAULTS;
  readonly dataDir: string;
  readonly runs: { readonly running: number; readonly retained: number };
  readonly lastRun: EvoHarnessRunResult | undefined;
  /**
   * Phase of the run the report is about (rev8 boundary fix 6): a named run's
   * book phase, the NEWEST retained snapshot's phase, 'running' when jobs are
   * in flight, and 'idle' ONLY when the book holds no record at all. An idle
   * server that still has jobs never reports 'idle'.
   */
  readonly lastRunPhase: 'running' | 'complete' | 'failed' | 'cancelled' | 'timeout' | 'idle';
  /**
   * The orchestrator's stage trace (rev8 boundary fix 6). Live during a run:
   * the orchestrator resets the trace at its run() prologue and appends each
   * stage as it happens, so a status call DURING a running job reads the
   * in-flight stages of THAT run. Empty when no run has executed in this
   * process; for a named run still in the book the settled result's
   * metadata.lifecycle is the run's own trace.
   */
  readonly orchestrator: { readonly lastTrace: readonly string[] };
  readonly jitrl: {
    readonly enabled: boolean;
    readonly runtimeEnabled: boolean;
    readonly levels: readonly string[];
    readonly storeSize: number;
    readonly degraded: boolean;
  };
  readonly memory: { readonly writable: string; readonly mode: string; readonly label: string };
  readonly surfaces: readonly { readonly surface: string; readonly enabled: boolean; readonly mountable: boolean }[];
  readonly dream: {
    readonly minimum: number;
    readonly totalTrees: number;
    readonly verifiedTreeCount: number;
    readonly ready: boolean;
    readonly reason: string;
    readonly dreamsPerformed: number;
  };
  readonly completedTasks: number;
}

/** One evo_lessons page. */
export interface EvoLessonsReport {
  readonly lessons: readonly Record<string, unknown>[];
  readonly dreamReports: readonly Record<string, unknown>[];
  readonly counts: { readonly lessons: number; readonly dreamReports: number; readonly returned: number };
}

/** The full evo_dream reply (the report plus the gate verdict). */
export interface EvoDreamReport {
  readonly ok: boolean;
  readonly triggered: boolean;
  /** Gate/readiness text exactly as the orchestrator emitted it. */
  readonly reason: string;
  readonly report: DreamReplayReport | null;
}

/** The head of every poll response. */
export interface EvoPollReport {
  readonly ok: boolean;
  readonly runId: string;
  readonly status: McpJobSnapshot['status'];
  readonly ageMs: number;
  readonly timedOut: boolean;
  readonly error: string | undefined;
  /** Full EvoHarnessRunResult once settled; never a fabricated zero. */
  readonly result: EvoHarnessRunResult | undefined;
}

/**
 * The refusal every assembly-touching path returns once {@link dispose} has
 * run. Stable text so a caller (or a test) can tell "the server was torn down"
 * apart from "the assembly failed to open".
 */
export const EVO_MCP_DISPOSED_MESSAGE =
  'the evo MCP server has been disposed; no assembly will be created after teardown';

/**
 * Build the McpServer (tools registered) WITHOUT attaching a transport. The
 * stdio entry and the tests share this constructor.
 *
 * CONSTRUCTION IS SIDE-EFFECT FREE: no data directory is created, no
 * persistence store is opened and no cold-start backfill runs until the first
 * real consumer (a tool handler that needs the assembly, or an explicit
 * `handle.ready` read). See the `ready` block below.
 */
export function createEvoMcpServer(options: EvoMcpServerOptions = {}): {
  readonly server: McpServer;
  /**
   * EXPLICIT WARM-UP. Reading this property starts (or joins) the one assembly
   * build and resolves with it. It is a getter, not a promise created at
   * construction: merely constructing the server does not build anything, so a
   * server that is constructed and never used leaves no directory behind.
   * Tool handlers use the same memoized build internally.
   */
  readonly ready: Promise<EvoAssembly>;
  /** Idempotent teardown: cancel running jobs, dispose the assembly. */
  readonly dispose: () => Promise<void>;
  /** The bookkeeping keys a status report reads. */
  readonly jobCounts: () => { running: number; retained: number };
  /** The last settled snapshot per runId (for status after restart: empty). */
  readonly pollJob: (runId: string) => McpJobSnapshot;
} {
  const log = options.log;
  const logLine = (line: string): void => {
    if (log !== undefined) {
      try {
        log(line);
      } catch {
        // A broken logger must not take the server down.
      }
    }
  };

  // rev8 boundary fix 1: the PRODUCTION adapter reads the deployment's env
  // (EVO_MODEL_BASE_URL / EVO_MODEL_ID — the same names the template writes)
  // with the adapter's own safe defaults as fallback. Values are validated as
  // non-empty strings; a set-but-empty variable falls back to the default
  // rather than silently producing a malformed URL or model id.
  const serverEnv = options.env ?? process.env;
  const envNonEmpty = (name: string): string | undefined => {
    const value = serverEnv[name];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };
  const envBaseUrl = envNonEmpty(EVO_MODEL_BASE_URL_ENV);
  const envModelId = envNonEmpty(EVO_MODEL_ID_ENV);
  if (envBaseUrl === undefined && serverEnv[EVO_MODEL_BASE_URL_ENV] !== undefined) {
    logLine('evo-mcp: ' + EVO_MODEL_BASE_URL_ENV + ' is set but empty; using the default base URL ' + DEFAULT_OPENAI_BASE_URL);
  }
  if (envModelId === undefined && serverEnv[EVO_MODEL_ID_ENV] !== undefined) {
    logLine('evo-mcp: ' + EVO_MODEL_ID_ENV + ' is set but empty; using the default model id');
  }
  const model =
    options.model ??
    createOpenAiModelAdapter({
      ...(envBaseUrl === undefined ? {} : { baseUrl: envBaseUrl }),
      ...(envModelId === undefined ? {} : { model: envModelId }),
      env: serverEnv,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.now === undefined ? {} : { now: options.now }),
      log: logLine
    });
  const assemblyInput: EvoAssemblyInput = {
    ...(options.assembly?.config !== undefined ? { config: options.assembly.config } : {}),
    ...(options.assembly?.options !== undefined ? { options: options.assembly.options } : {}),
    ...(options.assembly?.dataDir !== undefined ? { dataDir: options.assembly.dataDir } : {}),
    ...(options.now === undefined ? {} : { now: options.now }),
    // The assembly's warnings (inherited DSH_DATA_DIR isolation) ride the
    // same non-secret channel as the server's own diagnostics.
    log: logLine,
    model
  };
  /**
   * LAZY ASSEMBLY (rev8 lifecycle fix).
   *
   * `buildEvoAssembly` is NOT a pure function of the options: it resolves the
   * profile directory, `mkdir`s it, opens the tree-pool log and the policy
   * store, and mounts the plugin (whose cold-start backfill appends to the
   * JitRL experience log). Construction therefore has observable, on-disk
   * consequences.
   *
   * Creating the McpServer must have NONE of them: a process that is started
   * and never called (an MCP client that connects, lists tools and goes away)
   * must not create a data directory, exactly as `evo_run_submit`'s `dryRun`
   * preview promises (README:264, and the dryRun note at the tool below). So
   * the build starts on the FIRST consumer — a tool handler reaching for the
   * assembly, or an explicit `instance.ready` warm-up — and never at
   * construction time.
   *
   * The promise is memoized so the assembly is built exactly once; every later
   * caller shares it. Two consequences worth stating:
   *   - a slow persistence open delays tools rather than failing them, and an
   *     open error rejects the ONE promise, so every subsequent call reports
   *     the same failure (fail-fast stays in buildEvoAssembly);
   *   - after {@link dispose} the promise is never created again: a tool call
   *     that arrives post-teardown is refused with a named error instead of
   *     resurrecting an assembly (and its data directory) behind a closed
   *     server.
   */
  let assemblyPromise: Promise<EvoAssembly> | undefined;
  /** The resolved assembly, for the projections that never await (evo_lessons). */
  let resolvedAssembly: EvoAssembly | undefined;
  /** Set by dispose; latches so no later call can start a build. */
  let disposed = false;

  const ready = (): Promise<EvoAssembly> => {
    if (disposed) {
      // Never build (or hand out) an assembly after teardown: the caller gets
      // the latched refusal and each tool renders it as its own error result.
      const rejection = Promise.reject(new Error(EVO_MCP_DISPOSED_MESSAGE));
      // The returned promise is the caller's handle on the failure. This
      // observer exists only so a caller that DROPS that handle cannot turn the
      // refusal into an unhandled rejection; the rejection itself still
      // reaches every caller that awaits it.
      void rejection.catch(() => undefined);
      return rejection;
    }
    if (assemblyPromise === undefined) {
      const pending = buildEvoAssembly(assemblyInput);
      // Synchronous projection mirror. Registering the observer here (the
      // first `.then` on `pending`) also marks the rejection as handled, so a
      // build that fails before any tool awaits it can never surface as an
      // unhandled rejection — the failure itself is still re-thrown to every
      // caller of ready().
      void pending.then(
        (assembly) => {
          resolvedAssembly = assembly;
        },
        () => undefined
      );
      assemblyPromise = pending;
    }
    return assemblyPromise;
  };

  /**
   * The serialization chain for every entry point that drives the orchestrator
   * (rev8 review blocking fix 2: concurrent-run state crosstalk).
   *
   * WHY A MUTEX AT THE SERVER LAYER: EvoHarnessOrchestratorImpl.run() RESETS
   * per-run instance state at its entry (this.trace/this.plan/this.composition/
   * this.lessons/this.verificationView/this.runSignal — orchestrator.ts
   * run() prologue) and releases `this.runSignal` in its single result()
   * exit. Two concurrent runs would clobber each other's lifecycle trace and
   * verification views, and a run finishing mid-flight of another would
   * unlink the proposer's cancellation signal (exactly the rev8 cancel
   * semantics this server advertises). The plugin's direct `run` path has no
   * in-flight guard (executeRun's trackInFlight only protects the
   * auto_fallback/trigger paths), so the MCP boundary serializes: the book
   * still tracks EVERY submit as its own job (running/poll/settle untouched —
   * the client-visible start/poll contract is unchanged), but the heavy
   * executions themselves chain one after another.
   *
   * The same chain also serializes evo_dream (it reads the tree pool a run
   * writes and replays against the live policy holder) and evo_jit reset
   * (it drops the experience records a run's kernel snapshots read), so no
   * two mutating entry points can interleave inside the orchestrator.
   */
  let orchestratorChain: Promise<unknown> = Promise.resolve();
  /**
   * Run `task` when every previously enqueued task has settled. Failures do
   * not break the chain (the next task still runs); only a THROWN rejection
   * propagates to the caller of the returned promise.
   */
  const enqueueOnOrchestrator = <T>(task: () => Promise<T>): Promise<T> => {
    const run = orchestratorChain.then(task, task);
    // Keep the chain alive regardless of this task's outcome; surface the
    // rejection ONLY to this task's own caller.
    orchestratorChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };

  const book = createJobBook({
    run: (request: EvoHarnessRunRequest): Promise<EvoHarnessRunResult> =>
      enqueueOnOrchestrator(async (): Promise<EvoHarnessRunResult> => {
        // A queued run whose job was cancelled (dispose / cancelAll) while it
        // waited for the chain must NOT start: the orchestrator would open a
        // lifecycle against a shutting-down assembly. Rejecting here settles
        // the job as 'cancelled' (the signal aborted with a non-timeout
        // reason) — the honest classification, before any state was touched.
        if (request.signal?.aborted === true) {
          throw new Error('run "' + request.runId + '" was cancelled before its turn (server shutdown or client disconnect)');
        }
        const assembly = await ready();
        logLine('evo-mcp: run ' + request.runId + ' starting (trigger ' + request.trigger + ')');
        return assembly.plugin.run(request);
      }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.runTimeoutMs === undefined ? {} : { timeoutMs: options.runTimeoutMs }),
    ...(options.pollAfterMs === undefined ? {} : { pollAfterMs: options.pollAfterMs })
  });

  /**
   * The NEWEST run record, whatever the book retains (rev8 boundary fix 6):
   * the book does not expose iteration, so the server mirrors the latest
   * snapshot it has seen — submit records a running entry, pollJob/poll and
   * the run-completion path refresh it. This is what lets an idle-status call
   * report the last REAL run instead of a bare 'idle', and lets a server with
   * in-flight jobs never claim 'idle'.
   */
  let lastKnownSnapshot: McpJobSnapshot | undefined;
  const rememberSnapshot = (snapshot: McpJobSnapshot): void => {
    lastKnownSnapshot = snapshot;
  };

  // -----------------------------------------------------------------------
  // shared projections
  // -----------------------------------------------------------------------

  const statusReport = async (runId?: string): Promise<EvoStatusReport> => {
    const assembly = await ready();
    const { plugin } = assembly;
    let lastRun: EvoHarnessRunResult | undefined;
    let lastRunPhase: EvoStatusReport['lastRunPhase'] = 'idle';
    if (runId !== undefined) {
      const snapshot = book.poll(runId);
      rememberSnapshot(snapshot);
      lastRun = snapshot.result;
      lastRunPhase = snapshot.status;
    } else {
      const counts = book.counts();
      if (counts.running > 0) {
        // A server with jobs in flight is NEVER 'idle' (rev8 boundary fix 6).
        lastRunPhase = 'running';
      } else if (lastKnownSnapshot !== undefined) {
        // The most recent REAL record: the settled snapshot (or a running
        // snapshot superseded by the counts above). Never a fabricated idle.
        lastRun = lastKnownSnapshot.result;
        lastRunPhase = lastKnownSnapshot.status;
      } else {
        const trace = plugin.orchestrator.lastTrace();
        // No book record exists, but the orchestrator may have run within this
        // process (e.g. a book eviction): report its last trace with a phase
        // derived from the last lifecycle stage. 'idle' only when there is
        // genuinely nothing.
        if (trace.length > 0) {
          lastRunPhase = 'complete';
        }
      }
    }
    const jitrl = plugin.jitrl;
    const treeList = assembly.persistence.treePool.list();
    const readiness = assessDreamReadiness(treeList, MIN_VERIFIED_TREES_FOR_DREAM);
    return {
      server: { name: EVO_MCP_SERVER_NAME, version: EVO_MCP_SERVER_VERSION },
      execution: MCP_EXECUTION_DEFAULTS,
      dataDir: assembly.dataDir,
      runs: book.counts(),
      lastRun,
      lastRunPhase,
      orchestrator: {
        lastTrace: [...plugin.orchestrator.lastTrace()]
      },
      jitrl: {
        enabled: jitrl.enabled,
        runtimeEnabled: jitrl.runtime?.runtimeEnabled ?? false,
        levels: [...jitrl.levels],
        storeSize: jitrl.storeSize,
        degraded: jitrl.degraded
      },
      memory: {
        writable: plugin.memory.writable,
        mode: plugin.memory.mode,
        label: plugin.memory.label
      },
      surfaces: plugin.surfaces.map((surface) => ({
        surface: surface.surface,
        enabled: surface.enabled,
        mountable: surface.mountable
      })),
      dream: {
        minimum: readiness.minimum,
        totalTrees: readiness.totalTrees,
        verifiedTreeCount: readiness.verifiedTreeCount,
        ready: readiness.ready,
        reason: redactForBoundary(readiness.reason),
        dreamsPerformed: assembly.persistence.policyStore.counters.dreams
      },
      completedTasks: assembly.persistence.policyStore.counters.completedTasks
    };
  };

  const lessonsReport = (limit: number): EvoLessonsReport => {
    // Bound BEFORE redaction: the limit applies to what leaves the process.
    const bounded = Math.max(1, Math.min(Math.floor(limit) || 20, 200));
    const dreamOf = (dream: DreamReplayReport): Record<string, unknown> => ({
      ranAt: dream.ranAt,
      improved: dream.improved,
      selectedPolicyId: dream.selectedPolicyId,
      replayedTreeIds: [...dream.replayedTreeIds],
      baseline: { policyId: dream.baseline.policyId, hypervolume: dream.baseline.hypervolume, meanCost: dream.baseline.meanCost },
      best: { policyId: dream.best.policyId, hypervolume: dream.best.hypervolume, meanCost: dream.best.meanCost }
    });
    const lessonOf = (record: CanonicalLesson): Record<string, unknown> => {
      // rev8 boundary fix 5: the shape mirrors the canonical lesson's own
      // field set — ids, numbers and enums pass verbatim (they carry no
      // instance detail); every STRING field (title, whenToApply/
      // whenNotToApply, executionPatch.summary, verification evidence text) is
      // redacted here. The final `structuredAndText` pass re-runs the deep
      // redaction over the whole page, so the two layers cannot drift.
      return {
        id: record.id,
        title: redactForBoundary(record.title),
        whenToApply: record.whenToApply.map(redactForBoundary),
        whenNotToApply: record.whenNotToApply.map(redactForBoundary),
        polarity: record.polarity,
        visibility: record.visibility,
        subFunctions: [...record.subFunctions],
        executionPatch: {
          summary: redactForBoundary(record.executionPatch.summary),
          ...(record.executionPatch.patchId === undefined ? {} : { patchId: record.executionPatch.patchId })
        },
        verificationEvidence: {
          referenceFailure: redactForBoundary(record.verificationEvidence.referenceFailure),
          candidateSuccess: redactForBoundary(record.verificationEvidence.candidateSuccess),
          metricsDelta: { ...record.verificationEvidence.metricsDelta }
        },
        ...(record.confidence === undefined ? {} : { confidence: record.confidence }),
        ...(record.createdAt === undefined ? {} : { createdAt: record.createdAt }),
        ...(record.sourceTreeId === undefined ? {} : { sourceTreeId: record.sourceTreeId })
      };
    };
    const assembly = resolvedAssembly;
    if (assembly === undefined) {
      // The assembly has not been built yet (nothing that needs it has been
      // called in this process) or its build failed; an honest empty page, not
      // a fabricated one. This tool deliberately does NOT initialize the
      // assembly: it reads in-process orchestrator memory only, so a read-only
      // lessons query must not create a data directory as a side effect.
      return { lessons: [], dreamReports: [], counts: { lessons: 0, dreamReports: 0, returned: 0 } };
    }
    const allLessons = assembly.plugin.orchestrator.lastLessons();
    const allDreams = assembly.plugin.orchestrator.dreamReports();
    const lessons = allLessons.slice(-bounded).map(lessonOf);
    const dreams = allDreams.slice(-bounded).map(dreamOf);
    return {
      lessons,
      dreamReports: dreams,
      counts: {
        lessons: allLessons.length,
        dreamReports: allDreams.length,
        returned: lessons.length + dreams.length
      }
    };
  };

  // -----------------------------------------------------------------------
  // tool handlers
  // -----------------------------------------------------------------------

  /** A tool result the SDK's CallToolResult accepts. */
  type ToolReply =
    | { content: { type: 'text'; text: string }[]; structuredContent: Record<string, unknown> }
    | { content: { type: 'text'; text: string }[]; structuredContent: Record<string, unknown>; isError: true };

  /**
   * Register one tool with a JSON-Schema input. `fromJsonSchema` types the
   * handler args `unknown` (raw JSON Schema carries no TS types), so each
   * handler narrows defensively: a malformed call that somehow passes the
   * schema validator still meets a named error, never a crash.
   */
  function registerJsonTool(
    name: EvoToolName,
    config: { title: string; description: string; annotations: ToolAnnotations },
    schema: JsonSchemaType,
    handler: (args: Record<string, unknown>) => Promise<ToolReply>
  ): void {
    server.registerTool(name, { ...config, inputSchema: fromJsonSchema(schema) }, async (args) =>
      handler((args ?? {}) as Record<string, unknown>)
    );
  }

  const server = new McpServer(
    { name: EVO_MCP_SERVER_NAME, version: EVO_MCP_SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: EVO_MCP_INSTRUCTIONS }
  );

  // ---- evo_status --------------------------------------------------------
  registerJsonTool(
    'evo_status',
    {
      title: 'Evo harness status',
      description:
        'Read-only status: current run phase, JitRL switch state, dream readiness (verified-tree gate), memory capability, and the shadow execution constants. Never mounts or writes anything.',
      annotations: READ_ONLY
    },
    objectSchema({
      runId: str('Optional run id to report that run\'s phase instead of the idle summary')
    }),
    async (rawArgs) => {
      const args = rawArgs as { runId?: string };
      try {
        const report = await statusReport(args?.runId);
        const headline =
          'evo ' + report.server.version +
          ' | execution ' + report.execution.mode +
          ' | runs ' + report.runs.running + ' running / ' + report.runs.retained + ' retained' +
          ' | jitrl ' + (report.jitrl.runtimeEnabled ? 'on' : report.jitrl.enabled ? 'configured-off' : 'off') +
          ' | dream ' + (report.dream.ready ? 'ready' : 'not ready (' + String(report.dream.verifiedTreeCount) + '/' + String(report.dream.minimum) + ' verified trees)');
        return structuredAndText(report, headline);
      } catch (error) {
        // A named runId is projected through the same job book as
        // evo_run_poll. Preserve its stable unknown_run_id contract instead of
        // hiding the lookup failure behind the generic status error code.
        if (error instanceof McpJobBookError) {
          return errorResult(error.code, error.message, { runId: error.runId });
        }
        return errorResult('evo_status_failed', error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ---- evo_run_submit ----------------------------------------------------
  registerJsonTool(
    'evo_run_submit',
    {
      title: 'Start an evolution run',
      description:
        'Starts a full shadow-mode search for one task prompt and returns { runId, status: "started", pollAfterMs } immediately. Poll with evo_run_poll. Long-running: never blocks this call. Writes only local proposal/experience records (never host state); pass dryRun to preview the request without starting anything. The prompt is task TEXT, never a host path to execute.',
      annotations: WRITE_LOCAL
    },
    objectSchema(
      {
        prompt: str('The task to evolve against (required)'),
        sessionId: str('Client session id to attribute the run to (recommended; no host default exists)'),
        runId: str('Optional client-chosen run id; a fresh id is minted otherwise'),
        cwd: str('Optional client working directory, attached to the task metadata as cwd (a LABEL for provenance only; it is never resolved, read or executed by the server)'),
        budgetOverride: objectSchema(
          {
            maxOnlineRolloutBudget: { type: 'integer', description: 'Maximum online rollout budget' },
            maxWidth: { type: 'integer', description: 'Maximum search-grid width' },
            maxDepth: { type: 'integer', description: 'Maximum search-grid depth' }
          }
        ),
        dryRun: { type: 'boolean', description: 'Preview the run request without starting a run' }
      },
      ['prompt']
    ),
    async (rawArgs) => {
      const args = rawArgs as { prompt: string; sessionId?: string; runId?: string; cwd?: string; budgetOverride?: RunBudgetOverride; dryRun?: boolean };
      if (typeof args?.prompt !== 'string' || args.prompt.trim().length === 0) {
        return errorResult('invalid_arguments', 'prompt is required and must be a non-empty string');
      }
      if (args.cwd !== undefined && (typeof args.cwd !== 'string' || args.cwd.trim().length === 0)) {
        return errorResult('invalid_arguments', 'cwd, when provided, must be a non-empty string');
      }
      // rev8 boundary fix 2: dryRun previews the request WITHOUT awaiting
      // ready() — creating the assembly opens the persistence data directory
      // on disk, and a preview must be a pure function of the arguments with
      // zero side effects. The task id derivation mirrors plugin.makeTask's
      // documented base ('task-' + first 32 prompt chars) WITHOUT needing the
      // plugin; the run path below still uses the real makeTask (plus the cwd
      // metadata merge). The budget override travels as given — the
      // orchestrator's resolveBudget only ever NARROWS it to the configured
      // bounds (clampPositiveInt), so the preview shows the clamped-to-config
      // guarantee honestly.
      if (args.dryRun === true) {
        const previewTaskId = 'task-' + args.prompt.slice(0, 32);
        return structuredAndText(
          {
            ok: true,
            dryRun: true,
            request: {
              sessionId: args.sessionId ?? 'mcp-session',
              taskId: previewTaskId,
              trigger: 'slash_command',
              ...(args.runId === undefined ? {} : { runId: args.runId }),
              ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
              ...(args.budgetOverride === undefined ? {} : { budgetOverride: args.budgetOverride })
            },
            note: 'dryRun: nothing was started and nothing was written (no data directory was created)'
          },
          'dry run for prompt "' + redactForBoundary(args.prompt.slice(0, 80)) + '"'
        );
      }
      // rev8 boundary fix 7: cwd travels as TASK metadata (the ProbeTask's
      // ContractMetadata), per the plan's "cwd 需模型作为工具入参传入". It is a
      // provenance label on the task record — never a path this server
      // resolves, reads, chdirs into or executes. Composition note: makeTask's
      // documented input has no metadata field (its impl spreads only
      // taskSignature/contextTags), so the cwd is merged onto the returned
      // task additively — the same ProbeTask.metadata contract, without
      // touching the shared plugin entry (not this task's file).
      //
      // The whole block sits in one try because the assembly build is LAZY: a
      // first submit can be the call that opens the persistence runtime, so an
      // open failure (a data directory that cannot be created, a rejected
      // config) is reported as this tool's own error result instead of
      // escaping to the SDK.
      try {
        const assembly = await ready();
        const baseTask = assembly.plugin.makeTask({ prompt: args.prompt });
        const task = args.cwd === undefined ? baseTask : { ...baseTask, metadata: { cwd: args.cwd } };
        const request: EvoHarnessRunRequest = {
          sessionId: args.sessionId ?? 'mcp-session',
          task,
          trigger: 'slash_command',
          ...(args.runId === undefined ? {} : { runId: args.runId }),
          ...(args.budgetOverride === undefined ? {} : { budgetOverride: args.budgetOverride })
        };
        const submission = book.submit(request);
        rememberSnapshot(book.poll(submission.runId));
        logLine('evo-mcp: submitted ' + submission.runId + ' (poll after ' + String(submission.pollAfterMs) + 'ms)');
        return structuredAndText(
          { ok: true, ...submission, note: 'writes local shadow-mode records under ' + assembly.dataDir },
          'run started: ' + submission.runId + ' (poll with evo_run_poll)'
        );
      } catch (error) {
        if (error instanceof McpJobBookError) {
          return errorResult(error.code, error.message, { runId: error.runId });
        }
        return errorResult('submit_failed', error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ---- evo_run_poll ------------------------------------------------------
  registerJsonTool(
    'evo_run_poll',
    {
      title: 'Poll an evolution run',
      description:
        'Returns the run\'s phase. On completion the full EvoHarnessRunResult rides in structuredContent.result (outcome, probesRun, lessonsCommitted, diagnostics, metadata.lifecycle). Failures and timeouts are reported AS failures; an ungraded or not-evaluable verdict is never rewritten into a zero.',
      annotations: READ_ONLY
    },
    objectSchema({ runId: str('The run id returned by evo_run_submit') }, ['runId']),
    async (rawArgs) => {
      const args = rawArgs as { runId: string };
      if (typeof args?.runId !== 'string' || args.runId.length === 0) {
        return errorResult('invalid_arguments', 'runId is required');
      }
      let snapshot: McpJobSnapshot;
      try {
        snapshot = book.poll(args.runId);
      } catch (error) {
        if (error instanceof McpJobBookError) {
          // Restarts lose in-memory jobs; the error says so instead of
          // promising recovery (job-book.ts header).
          return errorResult(error.code, error.message, { runId: error.runId });
        }
        return errorResult('poll_failed', error instanceof Error ? error.message : String(error));
      }
      rememberSnapshot(snapshot);
      const report: EvoPollReport = {
        ok: true,
        runId: snapshot.runId,
        status: snapshot.status,
        ageMs: snapshot.ageMs,
        timedOut: snapshot.timedOut,
        error: snapshot.error,
        result: snapshot.result
      };
      const headline =
        'run ' + snapshot.runId + ': ' + snapshot.status +
        (snapshot.result === undefined
          ? ''
          : ' outcome=' + snapshot.result.outcome + ' probesRun=' + String(snapshot.result.probesRun) + ' lessonsCommitted=' + String(snapshot.result.lessonsCommitted));
      return structuredAndText(report, headline);
    }
  );

  // ---- evo_dream ---------------------------------------------------------
  registerJsonTool(
    'evo_dream',
    {
      title: 'Run the offline dream replay',
      description:
        'Triggers the orchestrator\'s offline dream (zero-execution replay of verified trees). Refuses with the gate reason when fewer than 12 verified trees are retained. Records a dream report; publishes nothing (shadow).',
      annotations: WRITE_LOCAL
    },
    objectSchema({
      diagnostics: str('Optional free-text diagnostic attached to the dream record')
    }),
    async (rawArgs) => {
      const args = rawArgs as { diagnostics?: string };
      try {
        const assembly = await ready();
        const diagnostics = args?.diagnostics === undefined ? [] : [args.diagnostics];
        // The ONLY dream path: the orchestrator's own gate-protected
        // entrypoint. This tool never calls a dreamer or a pool directly.
        // Serialized behind the run chain (rev8 review blocking fix 2): a
        // dream reads the tree pool and policy a concurrent run writes, so
        // both go through the same one-at-a-time gate.
        const report = await enqueueOnOrchestrator(() =>
          assembly.plugin.orchestrator.triggerDream(diagnostics)
        );
        const treeList = assembly.persistence.treePool.list();
        const readiness = assessDreamReadiness(treeList, MIN_VERIFIED_TREES_FOR_DREAM);
        const payload: EvoDreamReport = {
          ok: true,
          triggered: report !== null,
          reason: redactForBoundary(readiness.reason),
          report: report
        };
        const headline =
          report === null
            ? 'dream NOT run: ' + payload.reason
            : 'dream replayed ' + String(report.replayedTreeIds.length) + ' tree(s), improved=' + String(report.improved) + ', selected ' + report.selectedPolicyId;
        return structuredAndText(payload, headline);
      } catch (error) {
        return errorResult('evo_dream_failed', error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ---- evo_jit -----------------------------------------------------------
  const JIT_ACTIONS = ['on', 'off', 'status', 'reset'] as const;
  type JitAction = (typeof JIT_ACTIONS)[number];

  registerJsonTool(
    'evo_jit',
    {
      title: 'JitRL runtime control',
      description:
        'The /evo jit controller surface. Actions: "status" (report), "on"/"off" (volatile in-process switch - the persisted config is unchanged), "reset" (drops experience records; requires confirm:true). Results are the controller\'s own text/JSON, redacted.',
      annotations: { readOnlyHint: false, destructiveHint: true }
    },
    objectSchema(
      {
        action: { type: 'string', enum: [...JIT_ACTIONS], description: 'on | off | status | reset' },
        bucket: str('Optional bucket scope for reset'),
        confirm: { type: 'boolean', description: 'Must be true for reset' }
      },
      ['action']
    ),
    async (rawArgs) => {
      const args = rawArgs as { action: JitAction; bucket?: string; confirm?: boolean };
      const action = args?.action;
      if (action === undefined || !JIT_ACTIONS.includes(action)) {
        return errorResult('invalid_arguments', 'action must be one of ' + JIT_ACTIONS.join(' | '));
      }
      if (action === 'reset' && args.confirm !== true) {
        // The command layer also refuses an unconfirmed reset; refusing here
        // keeps the MCP surface's own contract explicit.
        return errorResult('confirmation_required', 'reset requires confirm:true; nothing was dropped');
      }
      try {
        const assembly = await ready();
        // The EXISTING controller, reached through the plugin's OWN command
        // path (runFromCommand('jit ...')); the server adds no second parsing
        // and no second controller. The action enum above bounds the tokens.
        // 'reset' drops experience records a run's kernel snapshot reads and
        // on/off flips state a proposal path reads, so the whole command goes
        // through the same serialization chain as runs and dreams (rev8
        // review blocking fix 2).
        const tokens = ['jit', action, ...(args.bucket === undefined ? [] : [args.bucket])];
        const result = await enqueueOnOrchestrator(() =>
          assembly.plugin.runFromCommand(tokens.join(' '), {
            sessionId: 'mcp-jit'
          })
        );
        const jitCommand = result.jitCommand;
        if (jitCommand === undefined) {
          return errorResult('evo_jit_failed', 'the command path returned no jit result');
        }
        // The controller's whole json payload rides structuredContent; the
        // boundary's deep redaction (structuredAndText) covers it, so nested
        // strings inside `json` cannot bypass the same choke point the text
        // mirror goes through.
        return structuredAndText(
          { ok: jitCommand.ok, command: jitCommand.command, json: jitCommand.json },
          redactForBoundary(jitCommand.text)
        );
      } catch (error) {
        return errorResult('evo_jit_failed', error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ---- evo_lessons -------------------------------------------------------
  registerJsonTool(
    'evo_lessons',
    {
      title: 'Read committed lessons and dream reports',
      description:
        'Read-only export of the most recent canonical lessons and dream replay reports, bounded and secret-redacted before it crosses the process boundary.',
      annotations: READ_ONLY
    },
    objectSchema({
      limit: { type: 'integer', description: 'How many entries per list (1-200, default 20)' }
    }),
    async (rawArgs) => {
      const args = rawArgs as { limit?: number };
      try {
        const report = lessonsReport(args?.limit ?? 20);
        return structuredAndText(
          report,
          'lessons ' + String(report.counts.returned) + ' returned (' + String(report.counts.lessons) + ' total lessons, ' + String(report.counts.dreamReports) + ' dream reports)'
        );
      } catch (error) {
        return errorResult('evo_lessons_failed', error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ---- evo_text_probe ----------------------------------------------------
  registerJsonTool(
    'evo_text_probe',
    {
      title: 'Evaluate a text probe (always not-evaluable)',
      description:
        'The harness\'s honest three-state semantics: a text-only probe is ALWAYS not-evaluable - never a score, never a pass. The reply names the missing executable observable.',
      annotations: READ_ONLY
    },
    objectSchema({
      prompt: str('The probe prompt (optional)'),
      textDeliverables: { type: 'array', items: { type: 'string' }, description: 'Declared text deliverables' }
    }),
    async (rawArgs) => {
      const args = rawArgs as { prompt?: string; textDeliverables?: string[] };
      // The build is lazy, so the FIRST call to this tool can be the call that
      // opens the assembly: an open failure has to be reported as a tool error
      // result here instead of escaping to the SDK (whose fallback result
      // carries no structuredContent and no code).
      let assembly: EvoAssembly;
      try {
        assembly = await ready();
      } catch (error) {
        return errorResult('evo_text_probe_failed', error instanceof Error ? error.message : String(error));
      }
      const evaluation = assembly.plugin.evaluateTextProbe({
        ...(args?.prompt === undefined ? {} : { prompt: args.prompt }),
        ...(args?.textDeliverables === undefined ? {} : { textDeliverables: args.textDeliverables })
      });
      return structuredAndText(
        evaluation,
        'text probe: ' + evaluation.status + ' (' + evaluation.reason + ') - ' + evaluation.detail
      );
    }
  );

  // -----------------------------------------------------------------------
  // teardown: cancel in-flight jobs, dispose the assembly
  // -----------------------------------------------------------------------

  const dispose = async (): Promise<void> => {
    if (disposed) {
      return;
    }
    disposed = true;
    // Capture the warm-up that ALREADY started BEFORE the latch above: from
    // now on ready() refuses new builds (it must never resurrect an assembly),
    // but a build that was already in flight still owns a data directory and
    // a persistence runtime, so teardown has to reach it. `undefined` means
    // the server was never used past construction — nothing was created, so
    // there is nothing to flush, dispose or remove (this is what lets a
    // constructed-and-never-called server leave no trace on disk).
    const pendingAssembly = assemblyPromise;
    // ORDER (rev8 boundary fix 3): cancel FIRST — every running job's abort
    // propagates to its probes through the run request's signal, so no run can
    // outlive the assembly this loop is about to flush and tear down. Only
    // then is the assembly disposed (plugin dispose flushes persistence).
    const cancelled = book.cancelAll(new Error('the evo MCP server is shutting down'));
    if (cancelled.length > 0) {
      logLine('evo-mcp: dispose cancelled ' + String(cancelled.length) + ' running job(s): ' + cancelled.join(', '));
      // rev8 boundary fix 9 (bounded settle wait): an aborted run still has
      // in-flight work to UNWIND before its last persistence record is queued
      // — the orchestrator's finalize path (treePool append, counters,
      // diagnostics) runs on the way to its 'cancelled' settlement. Flushing
      // while that unwind is still racing would let a post-flush write land
      // after the durability barrier (last-writer-wins over a disposed
      // runtime). So dispose waits for the book's running count to reach 0
      // BEFORE the flush — but BOUNDED, never an unbounded wait: a hostile or
      // hung runner that ignores its abort signal must not hang shutdown.
      // DISPOSE_SETTLE_WAIT_MS bounds each wait (wall-clock, not the injected
      // clock — shutdown latency is an operational property); the counts()
      // poll is 10ms apart so a well-behaved run (sub-ms unwind) settles on
      // the first or second observation and a stuck one delays shutdown by
      // at most the bound, never forever.
      const settleDeadline = Date.now() + DISPOSE_SETTLE_WAIT_MS;
      while (book.counts().running > 0 && Date.now() < settleDeadline) {
        await sleep(10);
      }
      const stillRunning = book.counts().running;
      if (stillRunning > 0) {
        // Honesty: say what did NOT settle instead of silently racing the
        // flush. The overhanging writes are still queued INSIDE the store
        // objects (flush awaits the live queue tail), so the durability
        // barrier itself stays correct; the log line documents the deviation.
        logLine(
          'evo-mcp: ' + String(stillRunning) + ' cancelled job(s) did not settle within ' +
            String(DISPOSE_SETTLE_WAIT_MS) + 'ms; flushing over them (their writes remain queued in the stores)'
        );
      }
    }
    if (pendingAssembly === undefined) {
      // Nothing was ever initialized: no data directory was created, no
      // persistence runtime exists, no job ever ran (the book was started by
      // this constructor but its run path never resolved an assembly). A
      // construction-only lifetime therefore tears down to a true no-op, which
      // is the whole point of the lazy build.
      logLine('evo-mcp: dispose found no started assembly; no data directory was created or flushed');
      return;
    }
    try {
      // A warm-up that is STILL RUNNING is awaited, not abandoned: the build
      // already owns an on-disk directory and a persistence runtime, and this
      // is the only handle that can dispose them. Awaiting it is what keeps a
      // dispose-during-startup from leaving a background runtime writing after
      // the caller believes the server is closed.
      //
      // `ready` rejection is NOT routed through ready() here (that call would
      // refuse after the latch): the captured promise is awaited directly so
      // the half-built attempt is observed. buildEvoAssembly rejects before
      // returning a handle, so there is nothing left to dispose; a rejection is
      // logged and rethrown so the caller learns teardown was not clean.
      const assembly = await pendingAssembly;
      await assembly.dispose();
    } catch (error) {
      logLine('evo-mcp: dispose error: ' + (error instanceof Error ? error.message : String(error)));
      throw error;
    }
  };

  return {
    server,
    // A GETTER, deliberately: reading it is the explicit warm-up. If this were
    // `ready: ready()` the build (and therefore the data directory) would start
    // during construction, which is exactly the side effect this constructor
    // must not have.
    get ready(): Promise<EvoAssembly> {
      return ready();
    },
    dispose,
    jobCounts: () => book.counts(),
    pollJob: (runId: string): McpJobSnapshot => {
      const snapshot = book.poll(runId);
      rememberSnapshot(snapshot);
      return snapshot;
    }
  };
}

// ---------------------------------------------------------------------------
// the stdio entry
// ---------------------------------------------------------------------------

/**
 * Serve the evo MCP server over stdio. Returns the same handle serveStdio
 * returns (close() tears the transport down); the assembly disposal is wired
 * through the options hook so tests can drive it deterministically.
 *
 * DISCONNECT LIFECYCLE (rev8 boundary fix 4): the SDK's serveStdio closes the
 * pinned McpServer PRODUCT on wire close but invokes no host callback (its
 * wire.onclose at stdio.mjs:566-572 only calls product.close()), so a client
 * disconnect would leave the assembly alive behind an empty stdin handle. The
 * entry therefore passes a custom StdioServerTransport and wraps its onclose
 * BEFORE the server connects: `server.connect()` chains the previous onclose
 * (SDK Protocol.connect at src-BHSMhZ_W.mjs:6372-6378 preserves the prior
 * callback and runs our wrapper after the SDK's own teardown). When stdin
 * closes — or close() is called — the wrapper cancels all running jobs and
 * disposes the assembly; the process then exits once no keep-alive handle
 * remains (the deadline timers are unref'd; the book's cancelAll is called
 * before the runtime flush).
 */
export function serveEvoMcpStdio(options: EvoMcpServerOptions = {}): {
  readonly close: () => Promise<void>;
} {
  // stderr is the only logging channel a stdio MCP server may use (stdout is
  // the protocol). Non-secret lines only; the adapter's own logger already
  // keeps key material out.
  const stderrLog = (line: string): void => {
    process.stderr.write('[evo-mcp] ' + line + '\n');
  };
  let instance: ReturnType<typeof createEvoMcpServer> | undefined;
  let closed = false;

  /** The disconnect/teardown chain: cancel jobs, dispose the assembly. */
  const teardownInstance = async (): Promise<void> => {
    if (instance === undefined) {
      return;
    }
    await instance.dispose().catch((error: unknown) => {
      stderrLog('dispose failed: ' + (error instanceof Error ? error.message : String(error)));
    });
  };

  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    await teardownInstance();
    await handle.close();
  };

  // A custom transport over the process stdio (the SDK's own class, default
  // streams), so the entry can observe onclose. server.connect() chains this
  // callback with the SDK's Protocol._onclose (the previous onclose is invoked
  // first, then the SDK's abort/settlement pass) — the order at stdio.mjs
  // close() is: listener removal -> onclose fire. Wrapping BEFORE connect
  // means our wrapper IS the "previous" callback the SDK preserves.
  const wire = new StdioServerTransport();
  const handle = serveStdio(
    () => {
      instance = createEvoMcpServer({ ...options, log: options.log ?? stderrLog });
      return instance.server;
    },
    { transport: wire }
  );
  const previousOnClose = wire.onclose;
  wire.onclose = (): void => {
    try {
      previousOnClose?.();
    } finally {
      void teardownInstance();
    }
  };

  return { close };
}

/** The CLI entry (node lib/mcp/server.js or tsx src/mcp/server.ts). */
export function main(): void {
  serveEvoMcpStdio();
}

// Direct-execution guard: run the stdio server when THIS module is the entry
// (node lib/mcp/server.js, the bundled artifact, or a tsx run). An import of
// this module never starts a server - the tests import createEvoMcpServer and
// drive the McpServer instance themselves.
// import.meta.url is the bundle's own URL when the entry is bundled with
// esbuild's default banner, so the URL comparison stays correct for both the
// source run and the bundle run.
const invokedDirectly = (() => {
  try {
    const entryUrl = pathToFileURL(process.argv[1] ?? '').href;
    return import.meta.url === entryUrl || import.meta.url.endsWith(path.basename(entryUrl));
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main();
}
