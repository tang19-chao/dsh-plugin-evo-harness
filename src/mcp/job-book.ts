/**
 * MCP long-task bookkeeping (rev8 plan §5.1 stage 2 / §5.2 `evo_run_submit` +
 * `evo_run_poll`).
 *
 * WHAT THIS IS
 *   The in-process runId -> job map behind the future MCP server's start/poll
 *   pair. `submit` STARTS a run through the injected starter (the plugin
 *   handle's `run`) and returns immediately with `{ runId, status: 'started',
 *   pollAfterMs }`; `poll` returns an immutable snapshot of the run's phase.
 *   Nothing here ever awaits the run synchronously, so a minute-scale evolution
 *   run can never hold an MCP tool call open past the host's
 *   `toolCallTimeoutMs` (plan §7 risk 4).
 *
 * CANCELLATION (per-run AbortController)
 *   The book owns one `AbortController` per runId and passes its signal to the
 *   run request (`EvoHarnessRunRequest.signal`, the additive field this stage
 *   introduced). A client disconnect / explicit cancel aborts THAT controller,
 *   and the orchestrator forwards the signal to every isolated-branch probe
 *   (`ProbeBranchRequest.signal`), where the seam manager's abort guard turns
 *   it into an 'aborted' trajectory. Aborting after the run settled is a no-op
 *   (the listener is removed on settlement; `AbortController.abort` after
 *   listener removal touches nothing).
 *
 * TIMEOUT vs CANCEL (plan: "超时必须与取消区分")
 *   The book's deadline timer aborts the SAME controller with a distinct
 *   sentinel reason. Settlement classification is by REASON, not by who fired:
 *   - the sentinel reason -> status 'timeout';
 *   - the signal aborted by anything else (cancel(runId), an external abort of
 *     a caller-supplied signal, …) -> status 'cancelled';
 *   - the run rejected on its own -> status 'failed';
 *   - the run resolved with NO abort -> status 'complete' (with the run's own
 *     outcome — 'failed' EvoHarnessRunResults included; a graceful failure
 *     result is a completed run, not a crashed one).
 *   A RESOLVED run whose signal was already aborted is STILL 'cancelled', not
 *   'complete': a cooperative executor may abort its probes and then return a
 *   structured result, but that return is at most a PARTIAL result — the
 *   caller withdrew the run. The book keeps such a result on the snapshot
 *   (cancellationRequested=true) for audit while preserving the terminal
 *   cancellation/timeout state; it is never presented as a normal completion.
 *
 * NOT DURABLE (plan honesty requirement)
 *   Every record lives in this process's memory. A server restart loses all
 *   in-flight and completed runs — `poll` on a restart returns the same
 *   'unknown_run' error as an unknown runId, and the server layer must say so
 *   rather than promise recovery. This module never claims restart recovery.
 *
 * BOUNDED MEMORY
 *   `maxRecords` (default 128) bounds the map: terminating a run evicts the
 *   OLDEST terminal record when the bound is exceeded. A running entry is
 *   never evicted — under the bound there is always room for a fresh terminal
 *   record because every eviction frees one slot first.
 *
 * ERROR CONTRACT (stable errors the server layer can render)
 *   - duplicate runId on submit -> `McpJobBookError` code 'duplicate_run_id';
 *   - unknown / evicted runId on poll or cancel -> code 'unknown_run_id'.
 *   Both are plain named errors with a stable `code` field; the MCP server
 *   maps them to its tool-result shape.
 *
 * MINTED IDS (rev8 boundary fix 3)
 *   A client-chosen runId is used verbatim (and still collides loudly).
 *   A MINTED id combines the injected clock, a per-book counter and a random
 *   suffix so two submits in the same millisecond can never share an id; the
 *   counter keeps ids sortable/deduplicable under a fixed test clock, the
 *   random suffix covers a clock that never advances. Injecting `now` (and a
 *   test `randomToken`) keeps the whole scheme deterministic in tests.
 *
 * DISPOSE (rev8 boundary fix 3)
 *   `cancelAll(reason)` aborts every STILL-RUNNING controller (settled entries
 *   are inert) and returns the runIds it aborted; the server's dispose path
 *   calls it BEFORE flushing/disposing the assembly so no run outlives its
 *   runtime. A book-level deadline timer is unref'd (never holds the process
 *   open) and cleared on settlement.
 */

import type { EvoHarnessRunRequest, EvoHarnessRunResult } from '../types/contracts';

/** Stable error codes emitted by the job book. */
export type McpJobBookErrorCode = 'duplicate_run_id' | 'unknown_run_id';

/** Named error with a stable `code`; the server layer branches on the code. */
export class McpJobBookError extends Error {
  readonly code: McpJobBookErrorCode;
  readonly runId: string;

  constructor(code: McpJobBookErrorCode, runId: string, message: string) {
    super(message);
    this.name = 'McpJobBookError';
    this.code = code;
    this.runId = runId;
  }
}

/** Job phase as the poll tool reports it. */
export type McpJobStatus = 'running' | 'complete' | 'failed' | 'cancelled' | 'timeout';

/** The submit tool's immediate reply. */
export interface McpJobSubmission {
  readonly runId: string;
  readonly status: 'started';
  /** Milliseconds the client should wait before the first poll. */
  readonly pollAfterMs: number;
}

/** One immutable poll snapshot; safe to hand to a client (no internal state). */
export interface McpJobSnapshot {
  readonly runId: string;
  readonly status: McpJobStatus;
  /** Wall-clock ms the job has been known to the book. */
  readonly ageMs: number;
  /** Present once settled: the run's own result (a graceful failure included). */
  readonly result?: EvoHarnessRunResult;
  /** Present once settled when the run rejected or was cancelled/timed out. */
  readonly error?: string;
  /**
   * True only when the run's request signal fired with the BOOK's deadline
   * sentinel — the client-visible proof this was a book timeout, not a cancel.
   */
  readonly timedOut: boolean;
  /** Cancellation/timeout was requested before settlement, even when a runner
   * later returned a partial result instead of throwing. Such a result stays
   * available for audit but is not presented as a normal completed run.
   */
  readonly cancellationRequested?: boolean;
}

/** The run starter the book drives: the plugin handle's `run` (or a test fake). */
export type McpJobRunner = (request: EvoHarnessRunRequest) => Promise<EvoHarnessRunResult>;

/** Options for {@link createJobBook}. */
export interface McpJobBookOptions {
  /** Starts one run; every request the book builds carries `signal`. */
  readonly run: McpJobRunner;
  /** Injected clock (defaults to Date.now); shared with the plugin in tests. */
  readonly now?: () => number;
  /**
   * Per-run wall-clock deadline in ms. `undefined` (default) means no
   * book-level deadline: the probes keep their own probeTimeoutMs budget.
   */
  readonly timeoutMs?: number;
  /** Delay reported by submit before the first poll (default 1000). */
  readonly pollAfterMs?: number;
  /** Maximum retained job records, running entries never evicted (default 128). */
  readonly maxRecords?: number;
  /**
   * Random-suffix source for minted run ids (rev8 boundary fix 3). Defaults to
   * a cryptographically random hex token; tests inject a fixed one.
   */
  readonly randomToken?: () => string;
}

interface JobEntry {
  readonly runId: string;
  readonly controller: AbortController;
  readonly startedAt: number;
  /** The externally supplied signal to follow, if the caller passed one. */
  readonly externalSignal: AbortSignal | undefined;
  /**
   * The EXACT function registered on the external signal — the settle path
   * removes this same reference, so the listener is genuinely gone after
   * settlement (an arrow recreated at removal time would match nothing and
   * leak one listener per run on the long-lived connection signal).
   */
  readonly onExternalAbort: (() => void) | undefined;
  /** The book's deadline handle; cleared on settlement. */
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Settlement snapshot; replaced exactly once. */
  snapshot: McpJobSnapshot | undefined;
}

/** The sentinel the deadline timer aborts with (timeout vs cancel proof). */
const TIMEOUT_REASON = Symbol('mcp-job-book-timeout');

/** True when `error` is the book's own deadline sentinel. */
function isTimeoutReason(error: unknown): boolean {
  return error === TIMEOUT_REASON;
}

/** One-line human text for a settlement error. */
function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.name + ': ' + error.message;
  }
  return String(error);
}

/**
 * Create the long-task book. One instance per MCP server process; it is an
 * in-memory index only and holds no persistence of its own.
 */
export function createJobBook(options: McpJobBookOptions): {
  submit(request: EvoHarnessRunRequest): McpJobSubmission;
  poll(runId: string): McpJobSnapshot;
  cancel(runId: string, reason?: unknown): boolean;
  /**
   * Abort every still-running job (rev8 boundary fix 3). Settled entries are
   * untouched. Returns the runIds that were aborted, in submission order —
   * the server's dispose calls this before its flush barrier.
   */
  cancelAll(reason?: unknown): string[];
  /** Diagnostics helper for the server's status tool: count by phase. */
  counts(): { running: number; retained: number };
} {
  const now = options.now ?? Date.now;
  const pollAfterMs = options.pollAfterMs ?? 1_000;
  const maxRecords = Math.max(1, Math.floor(options.maxRecords ?? 128));
  const randomToken =
    options.randomToken ??
    ((): string => {
      // 64 bits of hex is collision-negligible; the counter below already
      // guarantees uniqueness within one process even if this ever repeated.
      const bytes = globalThis.crypto?.getRandomValues !== undefined ? globalThis.crypto.getRandomValues(new Uint8Array(8)) : undefined;
      if (bytes === undefined) {
        return String(Math.random()).slice(2, 10).padEnd(8, '0');
      }
      let hex = '';
      for (const byte of bytes) {
        hex += byte.toString(16).padStart(2, '0');
      }
      return hex;
    });
  const jobs = new Map<string, JobEntry>();
  // Insertion order = oldest first; only terminal entries are evictable.
  const terminalOrder: string[] = [];
  // Monotonic per-book counter for minted ids (same-millisecond collision fix).
  let mintedCounter = 0;

  const evictIfNeeded = (): void => {
    while (terminalOrder.length > maxRecords) {
      const oldest = terminalOrder.shift();
      if (oldest !== undefined) {
        jobs.delete(oldest);
      }
    }
  };

  const settle = (entry: JobEntry, snapshot: McpJobSnapshot): void => {
    if (entry.snapshot !== undefined) {
      return;
    }
    // The snapshot is frozen ONCE and reused for every later poll: a client
    // (or the server serializer) can never edit the book's terminal record,
    // and no poll hands out a reference to the JobEntry itself.
    entry.snapshot = Object.freeze(snapshot);
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    if (entry.externalSignal !== undefined && entry.onExternalAbort !== undefined) {
      entry.externalSignal.removeEventListener('abort', entry.onExternalAbort);
    }
    terminalOrder.push(entry.runId);
    evictIfNeeded();
  };

  const classifyAndSettle = (
    entry: JobEntry,
    outcome:
      | { kind: 'resolved'; result: EvoHarnessRunResult }
      | { kind: 'rejected'; error: unknown }
  ): void => {
    const signalAborted = entry.controller.signal.aborted;
    if (outcome.kind === 'rejected') {
      // The run crashed. A deadline abort that reached the runner as a throw
      // must be reported as 'timeout', a cancel as 'cancelled' — by reason.
      if (signalAborted && isTimeoutReason(entry.controller.signal.reason)) {
        settle(entry, {
          runId: entry.runId,
          status: 'timeout',
          ageMs: now() - entry.startedAt,
          timedOut: true,
          error: errorText(outcome.error)
        });
        return;
      }
      if (signalAborted && !isTimeoutReason(entry.controller.signal.reason)) {
        settle(entry, {
          runId: entry.runId,
          status: 'cancelled',
          ageMs: now() - entry.startedAt,
          timedOut: false,
          error: errorText(outcome.error)
        });
        return;
      }
      settle(entry, {
        runId: entry.runId,
        status: 'failed',
        ageMs: now() - entry.startedAt,
        timedOut: false,
        error: errorText(outcome.error)
      });
      return;
    }
    // The run RESOLVED. Once the caller has cancelled or its deadline fired,
    // a later normal return is at most a PARTIAL result, not a normal
    // completion: a cooperative executor may abort its probes but still return
    // a structured EvoHarnessRunResult. Keep that result for audit while
    // preserving the terminal cancellation/timeout state.
    const timedOut = signalAborted && isTimeoutReason(entry.controller.signal.reason);
    settle(entry, {
      runId: entry.runId,
      status: timedOut ? 'timeout' : signalAborted ? 'cancelled' : 'complete',
      ageMs: now() - entry.startedAt,
      timedOut,
      ...(signalAborted ? { cancellationRequested: true } : {}),
      result: outcome.result
    });
  };

  const startDeadline = (entry: JobEntry): void => {
    if (options.timeoutMs === undefined) {
      return;
    }
    entry.timer = setTimeout(() => {
      entry.controller.abort(TIMEOUT_REASON);
    }, options.timeoutMs);
    const unref = (entry.timer as { unref?: () => void }).unref;
    if (typeof unref === 'function') {
      unref.call(entry.timer);
    }
  };

  return {
    submit(request: EvoHarnessRunRequest): McpJobSubmission {
      const supplied = request.runId;
      // rev8 boundary fix 3: a minted id can never collide within one process.
      // clock (injected, sortable in tests) + counter (same-ms submits) +
      // random token (a clock that never advances). Client-chosen ids keep the
      // loud duplicate_run_id error instead of silent minting.
      //
      // Separator choice: ':' (NOT '-'). A minted id must survive the boundary
      // secret redaction verbatim — the client polls with exactly what submit
      // returned. A 40+ char [A-Za-z0-9-] run (which 'evo-run-<ts>-…' is, and
      // '-' is in the base64 candidate class) matches redaction.ts's
      // base64_blob shape; the ':' separator breaks the run, and the
      // anti-over-redaction lookbehind (?<![-:/\\@.]) independently excludes a
      // match starting right after it.
      const runId =
        typeof supplied === 'string' && supplied.length > 0
          ? supplied
          : 'evo-run:' + String(now()) + ':' + String(mintedCounter++).padStart(4, '0') + ':' + randomToken();
      const existing = jobs.get(runId);
      if (existing !== undefined) {
        throw new McpJobBookError(
          'duplicate_run_id',
          runId,
          existing.snapshot === undefined
            ? 'run "' + runId + '" is already running'
            : 'run "' + runId + '" already completed and its record is still retained; submit without runId to mint a fresh one'
        );
      }

      // One controller per run: cancel(runId) and the deadline abort it; the
      // caller's own signal, if any, is FOLLOWED (abort propagation) but never
      // replaced, so the book can always tell its own deadline apart.
      const controller = new AbortController();
      const externalSignal = request.signal;
      let onExternalAbort: (() => void) | undefined;
      if (externalSignal !== undefined && !externalSignal.aborted) {
        onExternalAbort = (): void => {
          controller.abort(externalSignal.reason);
        };
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      } else if (externalSignal !== undefined && externalSignal.aborted) {
        controller.abort(externalSignal.reason);
      }

      const entry: JobEntry = {
        runId,
        controller,
        startedAt: now(),
        externalSignal,
        onExternalAbort,
        timer: undefined,
        snapshot: undefined
      };
      jobs.set(runId, entry);
      startDeadline(entry);

      // The run starts NOW; the book chains the promise so neither settlement
      // path can ever surface as an unhandled rejection. `Promise.resolve()
      // .then(...)` also converts a runner that throws SYNCHRONOUSLY (a
      // misbehaving starter) into a rejection, so the entry still settles
      // instead of sticking in 'running' forever.
      void Promise.resolve()
        .then(() => options.run({ ...request, runId, signal: controller.signal }))
        .then(
          (result) => classifyAndSettle(entry, { kind: 'resolved', result }),
          (error) => classifyAndSettle(entry, { kind: 'rejected', error })
        );
      return { runId, status: 'started', pollAfterMs };
    },

    poll(runId: string): McpJobSnapshot {
      const entry = jobs.get(runId);
      if (entry === undefined) {
        throw new McpJobBookError(
          'unknown_run_id',
          runId,
          'no run "' + runId + '" is recorded (never submitted, evicted, or lost to a process restart)'
        );
      }
      if (entry.snapshot !== undefined) {
        return entry.snapshot;
      }
      // Every poll of a live run gets a FRESH frozen object: callers cannot
      // mutate shared state through it, and successive polls never alias.
      return Object.freeze({
        runId,
        status: 'running',
        ageMs: now() - entry.startedAt,
        timedOut: false
      });
    },

    cancel(runId: string, reason?: unknown): boolean {
      const entry = jobs.get(runId);
      if (entry === undefined) {
        throw new McpJobBookError(
          'unknown_run_id',
          runId,
          'no run "' + runId + '" is recorded (never submitted, evicted, or lost to a process restart)'
        );
      }
      if (entry.snapshot !== undefined) {
        // Cancel after settlement is a safe no-op: nothing left to abort, and
        // the terminal snapshot is never rewritten.
        return false;
      }
      entry.controller.abort(reason ?? new Error('run "' + runId + '" was cancelled by the client'));
      return true;
    },

    cancelAll(reason?: unknown): string[] {
      const aborted: string[] = [];
      const abortReason =
        reason ?? new Error('all runs were cancelled by the server shutting down');
      // Insertion order = submission order; abort each entry exactly once.
      for (const entry of jobs.values()) {
        if (entry.snapshot !== undefined) {
          continue;
        }
        entry.controller.abort(abortReason);
        aborted.push(entry.runId);
      }
      return aborted;
    },

    counts(): { running: number; retained: number } {
      let running = 0;
      for (const entry of jobs.values()) {
        if (entry.snapshot === undefined) {
          running += 1;
        }
      }
      return { running, retained: jobs.size };
    }
  };
}

/** Re-export for the server layer's error rendering without a second import. */
export { isTimeoutReason as isMcpJobBookTimeoutReason };
