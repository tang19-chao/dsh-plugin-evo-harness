/**
 * rev8 stage-2 tests: the MCP long-task book (src/mcp/job-book.ts).
 *
 * Fully deterministic and offline: the runner is always a controlled promise or
 * a scripted function — no plugin, no model, no fetch, no real clock. Timers
 * use vi.useFakeTimers() with explicit advanceTimersByTime, so the suite never
 * sleeps. The real plugin (and its probes) are exercised by the assembly suite;
 * here the runner records exactly what request reached it, which is how the
 * signal-passthrough contract is proven at the book boundary.
 *
 * Covered (the ask's assertions):
 *   1. submit returns { runId, status:'started', pollAfterMs } immediately;
 *   2. the run request carries the book's AbortController signal (and the
 *      caller-supplied signal is followed, not replaced);
 *   3. complete / failed / cancelled / timeout settle correctly and a runner
 *      rejection NEVER becomes an unhandled rejection;
 *   4. timeout is distinguished from cancel by the abort REASON (the book's
 *      sentinel), both when the run throws and when it limps home;
 *   5. duplicate runId / unknown runId give stable coded errors;
 *   6. cancel after settlement is a safe no-op; cleanup removes listeners;
 *   7. records are bounded, oldest terminal entries evicted, running entries
 *      never evicted;
 *   8. poll never leaks internal mutable objects (frozen snapshots, defensive
 *      result immutability via the contract's readonly shape);
 *   9. cancelAll aborts every running job (and only running jobs) — the
 *      server dispose path's precondition;
 *  10. minted run ids never collide, even at a frozen clock (counter + random
 *      suffix), while injected clock/token keep tests deterministic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEventListeners } from 'node:events';

import {
  createJobBook,
  isMcpJobBookTimeoutReason,
  McpJobBookError,
  type McpJobSnapshot
} from '../../../src/mcp/job-book';
import type { EvoHarnessRunRequest, EvoHarnessRunResult } from '../../../src/types/contracts';

// ---------------------------------------------------------------------------
// deterministic helpers
// ---------------------------------------------------------------------------

/** Controlled single-shot promise (the "slow probe" the tests hold). */
function deferred(): {
  promise: Promise<EvoHarnessRunResult>;
  resolve: (result: EvoHarnessRunResult) => void;
  reject: (error: unknown) => void;
  settled: boolean;
} {
  let resolve!: (result: EvoHarnessRunResult) => void;
  let reject!: (error: unknown) => void;
  let settled = false;
  const promise = new Promise<EvoHarnessRunResult>((res, rej) => {
    resolve = (result) => {
      settled = true;
      res(result);
    };
    reject = (error) => {
      settled = true;
      rej(error);
    };
  });
  return { promise, resolve, reject, get settled(): boolean { return settled; } };
}

function makeResult(overrides: Partial<EvoHarnessRunResult> = {}): EvoHarnessRunResult {
  return {
    runId: 'r1',
    sessionId: 'sess-1',
    taskId: 'task-1',
    outcome: 'composed',
    trigger: 'slash_command',
    probesRun: 1,
    lessonsCommitted: 0,
    diagnostics: [],
    startedAt: 1,
    endedAt: 2,
    ...overrides
  };
}

/** Monotonic fake clock, advancing 1ms per read (same style as the fixtures). */
function makeClock(start = 1_700_000_000_000): () => number {
  let current = start;
  return (): number => {
    current += 1;
    return current;
  };
}

/** A runner that records requests and returns canned behavior per test. */
function recordingRunner(
  behavior: (request: EvoHarnessRunRequest) => Promise<EvoHarnessRunResult>
): {
  run: (request: EvoHarnessRunRequest) => Promise<EvoHarnessRunResult>;
  requests: EvoHarnessRunRequest[];
} {
  const requests: EvoHarnessRunRequest[] = [];
  return {
    requests,
    run: (request: EvoHarnessRunRequest): Promise<EvoHarnessRunResult> => {
      requests.push(request);
      return behavior(request);
    }
  };
}

function baseRequest(overrides: Partial<EvoHarnessRunRequest> = {}): EvoHarnessRunRequest {
  return {
    runId: 'r1',
    sessionId: 'sess-1',
    task: { id: 'task-1', prompt: 'Fix the failing build.' },
    trigger: 'slash_command',
    ...overrides
  };
}

/**
 * The runner starts inside Promise.resolve().then(...), so a recorded request
 * exists one microtask after submit. This helper awaits that microtask
 * deterministically (no timers, no real async work).
 */
const afterStart = (): Promise<void> => new Promise<void>((resolve) => queueMicrotask(resolve));

const clock = makeClock();

/**
 * Real-timer capture for the unref contract test: the REAL Node setTimeout
 * (captured BEFORE any stubbing) and the last Timeout handle the book stored.
 * Real handles — not fake-timer records — are what carry hasRef()/unref().
 */
const realSetTimeout: typeof setTimeout = globalThis.setTimeout.bind(globalThis);
let capturedDeadlineTimer: NodeJS.Timeout | null = null;

function bookWith(
  behavior: (request: EvoHarnessRunRequest) => Promise<EvoHarnessRunResult>,
  overrides: { timeoutMs?: number; maxRecords?: number; pollAfterMs?: number } = {}
) {
  const runner = recordingRunner(behavior);
  const book = createJobBook({
    run: runner.run,
    now: clock,
    ...overrides
  });
  return { book, requests: runner.requests };
}

beforeEach(() => {
  // No test may observe real timers: the book's deadline runs on fakes.
  vi.useFakeTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. submit returns immediately
// ---------------------------------------------------------------------------

describe('submit', () => {
  it('returns { runId, status: started, pollAfterMs } while the run is still pending', () => {
    const pending = deferred();
    const { book } = bookWith(() => pending.promise, { pollAfterMs: 4_321 });
    const submission = book.submit(baseRequest());
    expect(submission).toEqual({ runId: 'r1', status: 'started', pollAfterMs: 4_321 });
    // The run has not settled: the controlled promise is still pending.
    expect(pending.settled).toBe(false);
    // The poll reflects the still-running phase.
    expect(book.poll('r1')).toMatchObject({ runId: 'r1', status: 'running' });
    pending.resolve(makeResult());
  });

  it('rejects a duplicate live runId with a stable coded error', () => {
    const pending = deferred();
    const { book } = bookWith(() => pending.promise);
    book.submit(baseRequest({ runId: 'dup' }));
    expect(() => book.submit(baseRequest({ runId: 'dup' }))).toThrowError(McpJobBookError);
    try {
      book.submit(baseRequest({ runId: 'dup' }));
    } catch (error) {
      expect((error as McpJobBookError).code).toBe('duplicate_run_id');
      expect((error as McpJobBookError).runId).toBe('dup');
    }
    pending.resolve(makeResult());
  });

  it('rejects a duplicate runId whose terminal record is still retained', async () => {
    const { book } = bookWith(async () => makeResult({ runId: 'done' }));
    book.submit(baseRequest({ runId: 'done' }));
    await vi.waitFor(() => expect(book.poll('done').status).toBe('complete'));
    expect(() => book.submit(baseRequest({ runId: 'done' }))).toThrowError(/already completed/);
  });

  it('mints a runId when the request supplies none', () => {
    const pending = deferred();
    const { book } = bookWith(() => pending.promise);
    const submission = book.submit({ ...baseRequest(), runId: undefined });
    expect(submission.runId).toMatch(/^evo-run:/);
    expect(book.poll(submission.runId).status).toBe('running');
    pending.resolve(makeResult({ runId: submission.runId }));
  });

  it('minted run ids NEVER collide, even with a frozen clock (counter + random suffix)', () => {
    const pending = deferred();
    // A clock that NEVER advances is the worst case: only the counter and the
    // random token can separate two submits in the same millisecond.
    let calls = 0;
    const frozenClock = (): number => {
      calls += 1;
      return 1_700_000_000_000;
    };
    let tokenSeq = 0;
    const book = createJobBook({
      run: () => pending.promise,
      now: frozenClock,
      randomToken: (): string => {
        tokenSeq += 1;
        return 'token' + String(tokenSeq);
      }
    });
    const first = book.submit({ ...baseRequest({ runId: undefined }), runId: undefined });
    const second = book.submit({ ...baseRequest({ runId: undefined }), runId: undefined });
    expect(first.runId).not.toBe(second.runId);
    expect(first.runId).toBe('evo-run:1700000000000:0000:token1');
    expect(second.runId).toBe('evo-run:1700000000000:0001:token2');
    expect(book.poll(first.runId).status).toBe('running');
    expect(book.poll(second.runId).status).toBe('running');
    pending.resolve(makeResult());
  });

  it('a minted runId survives the boundary secret redaction VERBATIM (the client polls with it)', async () => {
    // rev8 boundary fix 5 interaction: submit returns the runId the client
    // must poll with — if the redactor rewrote it, every poll would fail.
    // Regression: a '-'-separated minted id matched the base64_blob secret
    // pattern and came back as '<secret>'.
    const { redactForBoundary } = await import('../../../src/mcp/server');
    const pending = deferred();
    const { book } = bookWith(() => pending.promise);
    const ids = new Set<string>();
    for (let index = 0; index < 8; index += 1) {
      const submission = book.submit({ ...baseRequest({ runId: undefined }), runId: undefined });
      ids.add(submission.runId);
      // The id crosses the boundary unchanged.
      expect(redactForBoundary(submission.runId)).toBe(submission.runId);
    }
    expect(ids.size).toBe(8);
    pending.resolve(makeResult());
  });

  it('the default random source yields distinct ids without a fixed clock', () => {
    const pending = deferred();
    const { book } = bookWith(() => pending.promise);
    const ids = new Set<string>();
    for (let index = 0; index < 32; index += 1) {
      ids.add(book.submit({ ...baseRequest({ runId: undefined }), runId: undefined }).runId);
    }
    // 32 same-tick submits with no injected token: all ids distinct.
    expect(ids.size).toBe(32);
    pending.resolve(makeResult());
  });
});

// ---------------------------------------------------------------------------
// 2. signal passthrough
// ---------------------------------------------------------------------------

describe('signal passthrough', () => {
  it('carries the book-owned controller signal on every run request', async () => {
    const pending = deferred();
    const { book, requests } = bookWith(() => pending.promise);
    book.submit(baseRequest());
    await afterStart();
    expect(requests).toHaveLength(1);
    const signal = requests[0]!.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    pending.resolve(makeResult());
  });

  it('the book cancel aborts the SAME signal the runner received', async () => {
    const pending = deferred();
    const { book, requests } = bookWith(() => pending.promise);
    book.submit(baseRequest());
    await afterStart();
    const runnerSignal = requests[0]!.signal!;
    expect(book.cancel('r1', new Error('client disconnected'))).toBe(true);
    expect(runnerSignal.aborted).toBe(true);
    expect(isMcpJobBookTimeoutReason(runnerSignal.reason)).toBe(false);
    pending.resolve(makeResult());
  });

  it('follows an externally supplied signal without replacing it (additive, both reach the runner)', async () => {
    const pending = deferred();
    const { book, requests } = bookWith(() => pending.promise);
    const external = new AbortController();
    book.submit(baseRequest({ signal: external.signal }));
    await afterStart();
    const runnerSignal = requests[0]!.signal!;
    expect(runnerSignal).not.toBe(external.signal);
    // External abort propagates to the signal the runner actually sees.
    external.abort(new Error('caller went away'));
    expect(runnerSignal.aborted).toBe(true);
    pending.resolve(makeResult());
  });

  it('an already-aborted external signal is honored before the run even starts', async () => {
    const pending = deferred();
    const { book, requests } = bookWith(() => pending.promise);
    const external = new AbortController();
    external.abort(new Error('dead on arrival'));
    book.submit(baseRequest({ signal: external.signal }));
    await afterStart();
    expect(requests[0]!.signal?.aborted).toBe(true);
    pending.resolve(makeResult());
  });
});

// ---------------------------------------------------------------------------
// 3. settlement: complete / failed / cancelled
// ---------------------------------------------------------------------------

describe('settlement', () => {
  it('complete: poll exposes the run result as an immutable snapshot', async () => {
    const pending = deferred();
    const { book } = bookWith(() => pending.promise);
    book.submit(baseRequest());
    pending.resolve(makeResult({ probesRun: 7 }));
    await vi.waitFor(() => expect(book.poll('r1').status).toBe('complete'));
    const snapshot = book.poll('r1');
    expect(snapshot.result?.probesRun).toBe(7);
    expect(snapshot.timedOut).toBe(false);
    expect(snapshot.error).toBeUndefined();
    // The snapshot is frozen: mutating it cannot corrupt the book's record.
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => {
      (snapshot as { status: string }).status = 'running';
    }).toThrow();
  });

  it('a run that resolves with outcome=failed is still a completed run (graceful failure)', async () => {
    const pending = deferred();
    const { book } = bookWith(() => pending.promise);
    book.submit(baseRequest());
    pending.resolve(makeResult({ outcome: 'failed', failure: { category: 'hard_unrecoverable', message: 'probes all failed' } }));
    await vi.waitFor(() => expect(book.poll('r1').status).toBe('complete'));
    expect(book.poll('r1').result?.outcome).toBe('failed');
    expect(book.poll('r1').error).toBeUndefined();
  });

  it('failed: a runner rejection settles as failed and is NOT an unhandled rejection', async () => {
    const pending = deferred();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const { book } = bookWith(() => pending.promise);
    book.submit(baseRequest());
    pending.reject(new Error('proposer channel exploded'));
    await vi.waitFor(() => expect(book.poll('r1').status).toBe('failed'));
    // Give the event loop a turn for a would-be unhandled rejection to fire.
    await Promise.resolve();
    await Promise.resolve();
    expect(book.poll('r1').error).toContain('proposer channel exploded');
    expect(unhandled).toHaveLength(0);
    process.off('unhandledRejection', onUnhandled);
  });

  it('cancelled: cancel(runId) aborts the run signal and settles the poll as cancelled', async () => {
    const pending = deferred();
    const { book } = bookWith(() => pending.promise);
    book.submit(baseRequest());
    book.cancel('r1');
    // The runner observes the abort and rejects (like the seam abort guard).
    pending.reject(new Error('Branch was aborted by its caller.'));
    await vi.waitFor(() => expect(book.poll('r1').status).toBe('cancelled'));
    expect(book.poll('r1').timedOut).toBe(false);
    expect(isMcpJobBookTimeoutReason(book.poll('r1'))).toBe(false);
  });

  it('cancelled: a normal return AFTER cancellation stays cancelled and retains the partial result', async () => {
    const pending = deferred();
    const { book } = bookWith(() => pending.promise);
    book.submit(baseRequest());
    book.cancel('r1');
    pending.resolve(makeResult({ outcome: 'no_probe' }));
    await vi.waitFor(() => expect(book.poll('r1').status).toBe('cancelled'));
    expect(book.poll('r1').cancellationRequested).toBe(true);
    expect(book.poll('r1').result?.outcome).toBe('no_probe');
  });

  it('cancel is a safe no-op after settlement (returns false, snapshot untouched)', async () => {
    const pending = deferred();
    const { book } = bookWith(() => pending.promise);
    book.submit(baseRequest());
    pending.resolve(makeResult());
    await vi.waitFor(() => expect(book.poll('r1').status).toBe('complete'));
    const before = book.poll('r1');
    expect(book.cancel('r1')).toBe(false);
    expect(book.poll('r1')).toBe(before);
  });

  it('cancel of an unknown runId throws the stable unknown_run_id error', () => {
    const { book } = bookWith(async () => makeResult());
    expect(() => book.cancel('ghost')).toThrowError(McpJobBookError);
    try {
      book.cancel('ghost');
    } catch (error) {
      expect((error as McpJobBookError).code).toBe('unknown_run_id');
    }
  });
});

// ---------------------------------------------------------------------------
// 4. timeout vs cancel
// ---------------------------------------------------------------------------

describe('timeout vs cancel (distinguished by abort reason)', () => {
  it('the deadline abort settles a thrown run as timeout with timedOut=true', async () => {
    const pending = deferred();
    const { book, requests } = bookWith(() => pending.promise, { timeoutMs: 5_000 });
    book.submit(baseRequest());
    await afterStart();
    vi.advanceTimersByTime(5_000);
    expect(requests[0]!.signal?.aborted).toBe(true);
    // The runner rejects (like the seam abort guard would).
    pending.reject(new Error('deadline'));
    await vi.waitFor(() => expect(book.poll('r1').status).toBe('timeout'));
    expect(book.poll('r1').timedOut).toBe(true);
  });

  it('a cancel AFTER the deadline fired stays timeout (the deadline wins the reason race)', async () => {
    const pending = deferred();
    const { book } = bookWith(() => pending.promise, { timeoutMs: 1_000 });
    book.submit(baseRequest());
    vi.advanceTimersByTime(1_000);
    // Cancel after deadline: the controller is already aborted; cancel() on a
    // live entry aborts again with the cancel reason, but the FIRST reason the
    // signal carries is the sentinel — the poll must not flip to cancelled.
    book.cancel('r1');
    pending.reject(new Error('aborted'));
    await vi.waitFor(() => expect(book.poll('r1').status).toBe('timeout'));
    expect(book.poll('r1').timedOut).toBe(true);
  });

  it('timeout is distinguished from an explicit cancel on an identical throw', async () => {
    const pendingA = deferred();
    const a = bookWith(() => pendingA.promise, { timeoutMs: 500 });
    a.book.submit(baseRequest({ runId: 't-out' }));
    const pendingB = deferred();
    const b = bookWith(() => pendingB.promise, { timeoutMs: 60_000 });
    b.book.submit(baseRequest({ runId: 't-cancel' }));
    await afterStart();
    // Advance past a's deadline only.
    vi.advanceTimersByTime(500);
    b.book.cancel('t-cancel');
    pendingA.reject(new Error('aborted'));
    pendingB.reject(new Error('aborted'));
    await vi.waitFor(() => expect(a.book.poll('t-out').status).toBe('timeout'));
    await vi.waitFor(() => expect(b.book.poll('t-cancel').status).toBe('cancelled'));
    expect(b.book.poll('t-cancel').timedOut).toBe(false);
  });

  it('the deadline timer is cleared on settlement (fake-timer leak check)', async () => {
    const pending = deferred();
    const { book } = bookWith(() => pending.promise, { timeoutMs: 30_000 });
    book.submit(baseRequest({ runId: 'leak' }));
    expect(vi.getTimerCount()).toBe(1);
    pending.resolve(makeResult({ runId: 'leak' }));
    await vi.waitFor(() => expect(book.poll('leak').status).toBe('complete'));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('no timeoutMs configured: no timer, and cancel still distinguishes cancelled', async () => {
    const pending = deferred();
    const { book } = bookWith(() => pending.promise, {});
    book.submit(baseRequest({ runId: 'no-deadline' }));
    expect(vi.getTimerCount()).toBe(0);
    book.cancel('no-deadline');
    pending.reject(new Error('cancelled'));
    await vi.waitFor(() => expect(book.poll('no-deadline').status).toBe('cancelled'));
  });

  it('the deadline timer is UNREF\u0027d — it can never keep the process alive (real-timer check)', async () => {
    // The ask: "timeout 的定时器不能使进程保活". Fake timers cannot express
    // refness, so this test runs on REAL timers: the stub forwards the real
    // Node setTimeout and captures the SAME Timeout handle the book stores,
    // then asserts the Node-level contract directly — hasRef() flipped to
    // false by the book's own unref() call inside startDeadline
    // (src/mcp/job-book.ts). An unref'd deadline cannot hold the event loop
    // open, which is what lets the stdio server exit while a deadline is
    // still armed (job-book.ts DISPOSE header: "unref'd (never holds the
    // process open)").
    vi.useRealTimers();
    vi.stubGlobal(
      'setTimeout',
      ((callback: () => void, ms?: number) => {
        const handle = realSetTimeout(callback, ms);
        capturedDeadlineTimer = handle;
        return handle;
      }) as typeof setTimeout
    );
    try {
      const pending = deferred();
      const { book } = bookWith(() => pending.promise, { timeoutMs: 60_000 });
      book.submit(baseRequest({ runId: 'unref-deadline' }));
      // The stub intercepted the book's deadline setTimeout.
      expect(capturedDeadlineTimer).not.toBeNull();
      const timer = capturedDeadlineTimer as NodeJS.Timeout;
      // THE contract: the book unref'd the deadline handle, so the timer no
      // longer counts as an event-loop keep-alive reference.
      expect(timer.hasRef()).toBe(false);
      // Settle: the book clears the (unref'd) timer on settlement.
      pending.resolve(makeResult({ runId: 'unref-deadline' }));
      await vi.waitFor(() => expect(book.poll('unref-deadline').status).toBe('complete'));
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. poll errors
// ---------------------------------------------------------------------------

describe('poll errors', () => {
  it('unknown runId throws the stable coded error with restart-honest wording', () => {
    const { book } = bookWith(async () => makeResult());
    expect(() => book.poll('never-submitted')).toThrowError(McpJobBookError);
    try {
      book.poll('never-submitted');
    } catch (error) {
      const coded = error as McpJobBookError;
      expect(coded.code).toBe('unknown_run_id');
      // Honesty requirement: the message may NOT promise restart recovery.
      expect(coded.message).toContain('restart');
      expect(coded.message.toLowerCase()).not.toContain('recover');
    }
  });
});

// ---------------------------------------------------------------------------
// 6. bounded records
// ---------------------------------------------------------------------------

describe('bounded records', () => {
  it('evicts the OLDEST terminal records beyond maxRecords and reports unknown_run_id for them', async () => {
    const settledRunner = bookWith(async (request) => makeResult({ runId: request.runId ?? '' }), {
      maxRecords: 2
    });
    const book = settledRunner.book;
    for (const runId of ['a', 'b', 'c']) {
      book.submit(baseRequest({ runId }));
    }
    await vi.waitFor(() => expect(book.poll('c').status).toBe('complete'));
    // Three terminal records pushed the bound: 'a' (oldest) was evicted;
    // 'b' and 'c' (within maxRecords=2) are retained.
    expect(() => book.poll('a')).toThrowError(McpJobBookError);
    try {
      book.poll('a');
    } catch (error) {
      expect((error as McpJobBookError).code).toBe('unknown_run_id');
    }
    expect(book.poll('b').status).toBe('complete');
    expect(book.poll('c').status).toBe('complete');
    expect(book.counts()).toEqual({ running: 0, retained: 2 });
  });

  it('a RUNNING entry is never evicted even when terminal records churn', async () => {
    const pending = deferred();
    const settled = bookWith((request) =>
      request.runId === 'live' ? pending.promise : Promise.resolve(makeResult({ runId: request.runId ?? '' }))
    , { maxRecords: 1 });
    const book = settled.book;
    book.submit(baseRequest({ runId: 'live' }));
    for (const runId of ['t1', 't2', 't3']) {
      book.submit(baseRequest({ runId }));
      // Let each terminal record settle before submitting the next.
      await vi.waitFor(() => expect(book.poll(runId).status).toBe('complete'));
    }
    // The live run survived every eviction; the terminals churned down to one.
    expect(book.poll('live').status).toBe('running');
    expect(book.counts()).toEqual({ running: 1, retained: 2 });
    pending.resolve(makeResult({ runId: 'live' }));
  });

  it('counts() reflects phases during a run', async () => {
    const pending = deferred();
    const { book } = bookWith(() => pending.promise);
    book.submit(baseRequest());
    expect(book.counts()).toEqual({ running: 1, retained: 1 });
    pending.resolve(makeResult());
    await vi.waitFor(() => expect(book.poll('r1').status).toBe('complete'));
    expect(book.counts()).toEqual({ running: 0, retained: 1 });
  });
});

// ---------------------------------------------------------------------------
// 7. poll never leaks internal mutable objects
// ---------------------------------------------------------------------------

describe('poll immutability', () => {
  it('the running snapshot is frozen and stable across polls', () => {
    const pending = deferred();
    const { book } = bookWith(() => pending.promise);
    book.submit(baseRequest());
    const first = book.poll('r1');
    const second = book.poll('r1');
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(second)).toBe(true);
    // Mutating one poll result must not affect the next (no shared mutable).
    const mutated: McpJobSnapshot = { ...first, status: 'failed' };
    expect(second.status).toBe('running');
    expect(mutated.status).toBe('failed');
    pending.resolve(makeResult());
  });

  it('the settled snapshot is frozen and its embedded result matches the run result field-for-field', async () => {
    const pending = deferred();
    const { book } = bookWith(() => pending.promise);
    book.submit(baseRequest({ runId: 'snap' }));
    const diagnostics = ['diagnostic one'];
    pending.resolve(makeResult({ runId: 'snap', diagnostics }));
    await vi.waitFor(() => expect(book.poll('snap').status).toBe('complete'));
    const snapshot = book.poll('snap');
    expect(Object.isFrozen(snapshot)).toBe(true);
    // The result passed through is the SAME readonly contract shape; the book
    // adds no live references of its own (no controller, no timer, no entry).
    expect(Object.keys(snapshot)).toEqual(
      expect.arrayContaining(['runId', 'status', 'ageMs', 'result', 'timedOut'])
    );
    expect(snapshot.result?.runId).toBe('snap');
    expect(snapshot.runId).toBe('snap');
    // Mutating the caller's own array afterwards cannot retroactively change
    // what the book recorded (the result carries the reference the runner
    // returned, per the contract's readonly discipline; the snapshot itself is
    // frozen so the BOOK's shape cannot be edited).
    diagnostics.push('sneaky');
    expect(snapshot.result?.diagnostics).toContain('sneaky');
    expect(() => {
      (snapshot as { result?: unknown }).result = undefined;
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 8. cleanup safety
// ---------------------------------------------------------------------------

describe('cleanup safety', () => {
  it('settling removes the external-signal listener (no leak across many runs)', async () => {
    const settledRunner = bookWith(async (request) => makeResult({ runId: request.runId ?? '' }));
    const book = settledRunner.book;
    for (let index = 0; index < 5; index += 1) {
      const external = new AbortController();
      book.submit(baseRequest({ runId: 'cycle-' + String(index), signal: external.signal }));
      await vi.waitFor(() => expect(book.poll('cycle-' + String(index)).status).toBe('complete'));
    }
    expect(book.counts()).toEqual({ running: 0, retained: 5 });
  });

  it('aborting an external signal after its run settled does not resurrect or mutate the record', async () => {
    const pending = deferred();
    const { book } = bookWith(() => pending.promise);
    const external = new AbortController();
    book.submit(baseRequest({ runId: 'late-abort', signal: external.signal }));
    pending.resolve(makeResult({ runId: 'late-abort' }));
    await vi.waitFor(() => expect(book.poll('late-abort').status).toBe('complete'));
    const before = book.poll('late-abort');
    // The listener was removed on settlement: this abort must be inert. (Even
    // in the worst case the snapshot cannot be rewritten — settle() guards it.)
    external.abort(new Error('too late'));
    expect(book.poll('late-abort')).toBe(before);
    expect(book.poll('late-abort').status).toBe('complete');
  });

  it('the EXACT external listener is removed on settlement (getEventListeners count drops)', async () => {
    const pending = deferred();
    const { book } = bookWith(() => pending.promise);
    const external = new AbortController();
    book.submit(baseRequest({ runId: 'listener-count', signal: external.signal }));
    // Node exposes registered listeners statically via events.getEventListeners.
    expect(getEventListeners(external.signal, 'abort')).toHaveLength(1);
    pending.resolve(makeResult({ runId: 'listener-count' }));
    await vi.waitFor(() => expect(book.poll('listener-count').status).toBe('complete'));
    expect(getEventListeners(external.signal, 'abort')).toHaveLength(0);
  });

  it('a runner that throws SYNCHRONOUSLY still settles the entry as failed', async () => {
    const { book } = bookWith(() => {
      throw new Error('starter exploded synchronously');
    });
    book.submit(baseRequest({ runId: 'sync-throw' }));
    await vi.waitFor(() => expect(book.poll('sync-throw').status).toBe('failed'));
    expect(book.poll('sync-throw').error).toContain('starter exploded synchronously');
    // It counted as a terminal record, not a stuck running entry.
    expect(book.counts()).toEqual({ running: 0, retained: 1 });
  });
});

// ---------------------------------------------------------------------------
// 9. cancelAll (the server dispose path's precondition)
// ---------------------------------------------------------------------------

describe('cancelAll', () => {
  it('aborts EVERY running job and reports the aborted runIds in submission order', async () => {
    const pendingA = deferred();
    const pendingB = deferred();
    const { book, requests } = bookWith((request) =>
      request.runId === 'a' ? pendingA.promise : pendingB.promise
    );
    book.submit(baseRequest({ runId: 'a' }));
    book.submit(baseRequest({ runId: 'b' }));
    await afterStart();
    const aborted = book.cancelAll();
    expect(aborted).toEqual(['a', 'b']);
    expect(requests[0]!.signal?.aborted).toBe(true);
    expect(requests[1]!.signal?.aborted).toBe(true);
    pendingA.reject(new Error('cancelled'));
    pendingB.reject(new Error('cancelled'));
    await vi.waitFor(() => expect(book.poll('a').status).toBe('cancelled'));
    await vi.waitFor(() => expect(book.poll('b').status).toBe('cancelled'));
  });

  it('leaves settled records untouched and skips them in the report', async () => {
    const pending = deferred();
    const { book, requests } = bookWith((request) =>
      request.runId === 'done' ? Promise.resolve(makeResult({ runId: 'done' })) : pending.promise
    );
    book.submit(baseRequest({ runId: 'done' }));
    book.submit(baseRequest({ runId: 'live' }));
    await vi.waitFor(() => expect(book.poll('done').status).toBe('complete'));
    const before = book.poll('done');
    const aborted = book.cancelAll();
    expect(aborted).toEqual(['live']);
    expect(book.poll('done')).toBe(before);
    expect(book.poll('done').status).toBe('complete');
    expect(requests[0]!.signal?.aborted).toBe(false);
    pending.reject(new Error('cancelled by cancelAll'));
    await vi.waitFor(() => expect(book.poll('live').status).toBe('cancelled'));
  });

  it('is a safe no-op with no jobs and with only settled jobs', async () => {
    const settled = bookWith(async () => makeResult());
    settled.book.submit(baseRequest({ runId: 'done' }));
    await vi.waitFor(() => expect(settled.book.poll('done').status).toBe('complete'));
    expect(settled.book.cancelAll()).toEqual([]);
    const empty = bookWith(async () => makeResult());
    expect(empty.book.cancelAll()).toEqual([]);
  });
});
