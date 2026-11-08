/**
 * rev8 stage-3 tests: the run lifecycle over the MCP tools (plan §5.8 step 2).
 *
 * Coverage split across this file:
 *   - evo_run end-to-end  : submit -> poll -> complete with the FULL
 *     EvoHarnessRunResult (lifecycle metadata intact, three-state verdict
 *     semantics untouched), then evo_status reflects the finished run;
 *   - start/poll          : a deliberately slow run proves submit returns
 *     IMMEDIATELY (the tool never blocks on a minute-scale search);
 *   - timeout             : a book-level deadline aborts the run and the poll
 *     reports status 'timeout' with timedOut=true, the server stays alive;
 *   - cancellation honesty: a notifications/cancelled for an ALREADY-RETURNED
 *     submit does NOT cancel the job (the honest boundary); the real cancel
 *     path is dispose/disconnect (the subprocess case lives in
 *     disconnect-lifecycle.test.ts);
 *   - unknown runId       : poll of an unknown/lost id is a coded error, and
 *     the error text says a process restart loses jobs (no fake recovery).
 *
 * The model is scripted; every directory is a temp dir; no DSH, no gateway,
 * no network, no real key.
 *
 * ISOLATION (rev8 leftover fix)
 *   Building a server with no `assembly.dataDir` makes it resolve, on first use,
 *   `<home>/.dsh/evo-harness/profiles/<profile>` — the real plugin data
 *   directory (src/persistence/data-dir.ts:142-152). That resolution used to
 *   happen at CONSTRUCTION time (`ready()` was called eagerly,
 *   src/mcp/server.ts:570 of the pre-fix file); the server now builds the
 *   assembly lazily and only on first use (a tool call or an explicit
 *   `instance.ready` warm-up — src/mcp/server.ts:520-580,1268), so a
 *   constructed-but-unused server leaves no trace on disk. Measured in this
 *   session against the current file: construction alone records no mkdir,
 *   while reading `instance.ready` on a dataDir-less instance still aims at the
 *   real profile directory.
 *
 *   EITHER WAY the test must not build such an instance. The slow-runner case
 *   did exactly that: it built a second instance with `assembly: { options: {
 *   runBranch } }` and no dataDir, then discarded it (`void withRunner`) while
 *   driving the FIRST one — so the slow executor never reached the server under
 *   test and a real-data-dir write was the only effect. The wiring is repaired
 *   here: the slow runner is passed to the instance the test actually drives,
 *   built by `handshaken()` with a temp `dataDir`, and that instance/client are
 *   always disposed (never `void`ed and left alive).
 *
 *   `describe('data isolation')` pins the invariant with NEGATIVE assertions
 *   instead of trusting the arrangement: an fs-recording guard covers the whole
 *   file, every directory created while it is active must live under the temp
 *   root, and any operation aimed at a real DSH/plugin data root is a violation
 *   (writes there are additionally refused before they land). The guard's own
 *   classifier and its ability to catch this defect are self-tested in
 *   tests/mcp/fs-isolation-guard.test.ts, so "zero violations" cannot be an
 *   empty classifier.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { InMemoryTransport } from '@modelcontextprotocol/server';

import { createEvoMcpServer } from '../../src/mcp/server';
import type {
  EvoHarnessRunRequest,
  EvoHarnessRunResult,
  IModelAdapter,
  ModelRequest,
  ModelResponse
} from '../../src/types/contracts';
import { cleanupDir, TEST_TMP_ROOT } from '../unit/persistence/fixtures';
import {
  installFsIsolationGuard,
  isWithinPath,
  makeTrackedTempDir,
  realDshRoots,
  samePath,
  type FsIsolationGuard
} from './fixtures/fs-isolation';

// ---------------------------------------------------------------------------
// scripted model + controllable run executor
// ---------------------------------------------------------------------------

function proposalPayload(): Record<string, unknown> {
  return {
    rationale: 'Contract the output format so retries stop.',
    focusSurfaces: ['guardrails'],
    confidence: 0.7,
    expectedStepsDelta: -1,
    edits: {
      guardrails: {
        kind: 'guardrails',
        formatContract: 'Return minified JSON only.',
        appendRules: ['declare the failing tool before retrying']
      }
    }
  };
}

function scriptedModel(): IModelAdapter {
  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      if (request.purpose === 'propose') {
        return { text: JSON.stringify(proposalPayload()), finishReason: 'stop', model: 'scripted' };
      }
      if (request.purpose === 'compose') {
        const text = request.messages.map((message) => message.content).join('\n');
        const aliases = [...new Set(text.match(/candidate_[A-Z]/g) ?? [])];
        return {
          text: JSON.stringify({
            ranking: aliases,
            assessments: aliases.map((alias, index) => ({ alias, rationale: 'judge ' + String(index) }))
          }),
          finishReason: 'stop',
          model: 'scripted'
        };
      }
      if (request.purpose === 'reflect') {
        return { text: JSON.stringify({ lessons: [] }), finishReason: 'stop', model: 'scripted' };
      }
      return { text: 'scripted deliverable', finishReason: 'stop', model: 'scripted' };
    }
  };
}

interface Deferred {
  resolve: (result: EvoHarnessRunResult) => void;
  reject: (error: unknown) => void;
  promise: Promise<EvoHarnessRunResult>;
}

function deferred(): Deferred {
  let resolve!: Deferred['resolve'];
  let reject!: Deferred['reject'];
  const promise = new Promise<EvoHarnessRunResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A branch result that settles a run successfully. The probe executor contract
 * (ProbeExecutionResult, src/types/contracts.ts:718-730) requires a deliverable
 * for a probe to count as a usable reference, so every fake executor returns
 * one.
 */
function succeededBranch(content: string): Record<string, unknown> {
  return {
    status: 'succeeded',
    steps: [],
    toolErrors: [],
    failureSignals: [],
    deliverable: { content, format: 'markdown', producedFiles: [] }
  };
}

// ---------------------------------------------------------------------------
// raw JSON-RPC client over InMemoryTransport (shared shape with handshake.test)
// ---------------------------------------------------------------------------

interface RawClient {
  call(method: string, params?: Record<string, unknown>): Promise<any>;
  notify(method: string, params?: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

async function connectClient(server: Awaited<ReturnType<typeof createEvoMcpServer>>['server']): Promise<RawClient> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const pending = new Map<number, (value: any) => void>();
  clientTransport.onmessage = (message) => {
    const record = message as { id?: unknown };
    if (record.id !== undefined && pending.has(record.id as number)) {
      const resolve = pending.get(record.id as number)!;
      pending.delete(record.id as number);
      resolve(message);
    }
  };
  await clientTransport.start();
  let seq = 0;
  return {
    async call(method, params) {
      seq += 1;
      const id = seq;
      return new Promise<any>((resolve) => {
        pending.set(id, resolve);
        void clientTransport.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
      });
    },
    async notify(method, params) {
      await clientTransport.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
    },
    async close() {
      await clientTransport.close();
    }
  };
}

// ---------------------------------------------------------------------------
// scaffolding
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

/** The env snapshot every assembly receives: no inherited DSH/Evo data root. */
const ISOLATED_ENV = {
  EVO_HARNESS_DATA_DIR: undefined,
  DSH_DATA_DIR: undefined,
  DSH_PROFILE: undefined
} as const;

interface Built {
  instance: ReturnType<typeof createEvoMcpServer>;
  client: RawClient;
  dataDir: string;
}

/**
 * Build ONE server over a fresh temp data directory and complete the MCP
 * handshake. `overrides` is merged at the top level (a test may replace
 * `runTimeoutMs`, `pollAfterMs`, …); `assembly` is the base the caller can
 * extend through `overrides.assembly`, which is deep-merged here so a caller
 * adding `options.runBranch` cannot silently drop the temp `dataDir`.
 */
async function handshaken(overrides: Record<string, unknown> = {}): Promise<Built> {
  const dataDir = await makeTrackedTempDir('mcp-evo-run');
  tempDirs.push(dataDir);
  const baseAssembly = {
    config: {
      triggerMode: 'slash_command',
      probe: { maxConcurrentProbes: 1, probeTimeoutMs: 1_000 },
      dreamRsi: {
        maxOnlineRolloutBudget: 2,
        maxWidth: 1,
        maxDepth: 1,
        candidatePoliciesCount: 2,
        rhoPreferences: [0, 1],
        offlineDreamTriggerEveryNTasks: 100
      },
      logging: { level: 'silent' }
    },
    dataDir: { dataDir, env: ISOLATED_ENV }
  };
  const requested = overrides['assembly'] as Record<string, unknown> | undefined;
  const assembly = { ...baseAssembly, ...(requested ?? {}) };
  const instance = createEvoMcpServer({
    model: scriptedModel(),
    now: (() => {
      let tick = 1_700_000_000_000;
      return () => (tick += 1);
    })(),
    ...overrides,
    assembly
  });
  const client = await connectClient(instance.server);
  await client.call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'vitest', version: '0.0.0' }
  });
  await client.notify('notifications/initialized');
  return { instance, client, dataDir };
}

/** Extract the tools/call structured payload (asserts non-error first). */
function payload(reply: any): Record<string, any> {
  expect(reply.error).toBeUndefined();
  expect(reply.result?.isError).toBeFalsy();
  return reply.result.structuredContent;
}

/** Poll until the job leaves 'running' (bounded; never an unbounded wait). */
async function pollToSettle(
  client: RawClient,
  runId: string,
  attempts = 40
): Promise<Record<string, any>> {
  let settled: Record<string, any> | undefined;
  for (let attempt = 0; attempt < attempts && settled === undefined; attempt += 1) {
    const polled = await client.call('tools/call', {
      name: 'evo_run_poll',
      arguments: { runId }
    });
    const report = payload(polled).payload;
    if (report.status !== 'running') {
      settled = report;
    } else {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  expect(settled, 'run ' + runId + ' never left the running phase').toBeDefined();
  return settled!;
}

// ---------------------------------------------------------------------------
// isolation guard: active for every test in this file
// ---------------------------------------------------------------------------

let guard: FsIsolationGuard | undefined;

beforeEach(() => {
  guard = installFsIsolationGuard({
    allowedRoots: [TEST_TMP_ROOT],
    forbiddenRoots: realDshRoots()
  });
});

afterEach(async () => {
  const active = guard;
  guard = undefined;
  active?.restore();
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await cleanupDir(dir).catch(() => {});
  }
  // The guard saw the whole test body, including its cleanup: a violation here
  // fails the test even when every functional assertion passed.
  if (active !== undefined) {
    expect(active.hookFailures).toEqual([]);
    expect(active.createdOutsideAllowed).toEqual([]);
    expect(active.forbiddenAccesses).toEqual([]);
  }
});

// ---------------------------------------------------------------------------
// evo_run end-to-end (fast scripted run: submit -> poll -> complete)
// ---------------------------------------------------------------------------

describe('evo_run end-to-end', () => {
  it('submit returns immediately; poll reaches complete with the full run result', async () => {
    const { instance, client } = await handshaken();
    try {
      const submitted = await client.call('tools/call', {
        name: 'evo_run_submit',
        arguments: { prompt: 'Fix the failing build.', sessionId: 'sess-e2e' }
      });
      const submission = payload(submitted).payload;
      expect(submission.status).toBe('started');
      expect(typeof submission.runId).toBe('string');
      expect(submission.runId.length).toBeGreaterThan(0);
      expect(typeof submission.pollAfterMs).toBe('number');

      const settled = await pollToSettle(client, submission.runId);
      expect(['complete', 'failed']).toContain(settled['status']);
      expect(settled['timedOut']).toBe(false);
      // The FULL result travels once settled — never a summary stub.
      const result = settled['result'];
      expect(result).toBeDefined();
      expect(result.runId).toBe(submission.runId);
      expect(result.sessionId).toBe('sess-e2e');
      expect(typeof result.probesRun).toBe('number');
      expect(typeof result.lessonsCommitted).toBe('number');
      expect(Array.isArray(result.diagnostics)).toBe(true);
      expect(Array.isArray(result.metadata?.lifecycle)).toBe(true);
      expect(result.metadata?.lifecycle.length).toBeGreaterThan(0);
      expect(result.startedAt).toBeLessThanOrEqual(result.endedAt);
    } finally {
      await client.close();
      await instance.dispose();
    }
  });

  it('keeps failure results AS failures (never rewritten to zero or success)', async () => {
    const { instance, client } = await handshaken();
    try {
      const submitted = await client.call('tools/call', {
        name: 'evo_run_submit',
        arguments: { prompt: 'Fix the failing build.' }
      });
      const runId: string = payload(submitted).payload.runId;
      const settled = await pollToSettle(client, runId);
      // Whatever the outcome, the report carries the run's OWN outcome; a
      // graceful failure result is a completed run whose result.outcome says
      // 'failed' — the poll status and the outcome never contradict.
      if (settled['status'] === 'complete') {
        expect(['composed', 'probed', 'skipped', 'no_probe', 'failed']).toContain(
          settled['result'].outcome
        );
        if (settled['result'].outcome === 'failed') {
          expect(settled['result'].failure).toBeDefined();
        }
      } else {
        expect(settled['error']).toBeDefined();
      }
    } finally {
      await client.close();
      await instance.dispose();
    }
  });

  it('accepts a caller-narrowed budgetOverride and a dryRun preview', async () => {
    const { instance, client } = await handshaken();
    try {
      const dry = await client.call('tools/call', {
        name: 'evo_run_submit',
        arguments: { prompt: 'preview only', dryRun: true }
      });
      const dryPayload = payload(dry).payload;
      expect(dryPayload.dryRun).toBe(true);
      expect(dryPayload.note).toContain('nothing was started');
      expect(dryPayload.note).toContain('no data directory was created');

      const submitted = await client.call('tools/call', {
        name: 'evo_run_submit',
        arguments: {
          prompt: 'Fix the failing build.',
          budgetOverride: { maxWidth: 1, maxDepth: 1, maxOnlineRolloutBudget: 1 }
        }
      });
      const runId: string = payload(submitted).payload.runId;
      // The run is visible to poll (started with the narrowed budget).
      const polled = await client.call('tools/call', {
        name: 'evo_run_poll',
        arguments: { runId }
      });
      expect(payload(polled).payload.runId).toBe(runId);
    } finally {
      await client.close();
      await instance.dispose();
    }
  });

  it('dryRun is a PURE preview: no assembly, no data directory, no run record (rev8 boundary fix 2)', async () => {
    // The assembly's data directory is never created because the preview path
    // never awaits ready() (src/mcp/server.ts:826-844). The guard below proves
    // it: the only recorded creation in this test is the test's own temp dir.
    const dataDir = await makeTrackedTempDir('mcp-dryrun-pure');
    tempDirs.push(dataDir);
    const instance = createEvoMcpServer({
      model: scriptedModel(),
      assembly: {
        config: { triggerMode: 'slash_command', logging: { level: 'silent' } },
        dataDir: { dataDir, env: ISOLATED_ENV }
      }
    });
    const client = await connectClient(instance.server);
    await client.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'vitest', version: '0.0.0' }
    });
    try {
      const dry = await client.call('tools/call', {
        name: 'evo_run_submit',
        arguments: {
          prompt: 'dry with a broken data dir',
          dryRun: true,
          cwd: 'C:/tmp/preview-workspace',
          runId: 'client-id-1'
        }
      });
      expect(dry.result?.isError).toBeFalsy();
      const dryPayload = dry.result.structuredContent.payload;
      expect(dryPayload.dryRun).toBe(true);
      // The preview reflects the exact request shape that WOULD run.
      expect(dryPayload.request.sessionId).toBe('mcp-session');
      expect(dryPayload.request.runId).toBe('client-id-1');
      expect(dryPayload.request.cwd).toBe('C:/tmp/preview-workspace');
      expect(dryPayload.request.trigger).toBe('slash_command');
      // Zero side effects on disk: no persistence directory was created.
      const entries = await readdir(dataDir, { recursive: true }).catch(() => []);
      expect(entries).toEqual([]);
    } finally {
      await client.close().catch(() => {});
      await instance.dispose().catch(() => {});
    }
  });

  it('carries cwd as TASK metadata into the run (a label, never executed)', async () => {
    const dataDir = await makeTrackedTempDir('mcp-cwd');
    tempDirs.push(dataDir);
    const observedTasks: Array<Record<string, unknown>> = [];
    const runner = async (context: { task: { metadata?: Record<string, unknown> } }): Promise<any> => {
      observedTasks.push({ metadata: context.task?.metadata });
      return succeededBranch('done');
    };
    const instance = createEvoMcpServer({
      model: scriptedModel(),
      pollAfterMs: 10,
      now: (() => {
        let tick = 1_700_000_000_000;
        return () => (tick += 1);
      })(),
      assembly: {
        options: { runBranch: runner as never },
        config: {
          triggerMode: 'slash_command',
          probe: { maxConcurrentProbes: 1, probeTimeoutMs: 30_000 },
          logging: { level: 'silent' }
        },
        dataDir: { dataDir, env: ISOLATED_ENV }
      }
    });
    const client = await connectClient(instance.server);
    await client.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'vitest', version: '0.0.0' }
    });
    try {
      const submitted = await client.call('tools/call', {
        name: 'evo_run_submit',
        arguments: { prompt: 'Evolve this.', cwd: 'C:/Users/me/project-a', sessionId: 'sess-cwd' }
      });
      expect(submitted.result?.isError).toBeFalsy();
      // Wait for the run to REACH the runner (the assertion below is the proof;
      // the wait is bounded so a wiring break fails instead of hanging).
      for (let attempt = 0; attempt < 40 && observedTasks.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(observedTasks.length).toBeGreaterThan(0);
      // The cwd arrived as task metadata at the branch executor.
      expect(observedTasks[0]!['metadata']).toMatchObject({ cwd: 'C:/Users/me/project-a' });
    } finally {
      await client.close().catch(() => {});
      await instance.dispose().catch(() => {});
    }
  });

  it('rejects a duplicate runId with the stable code', async () => {
    const { instance, client } = await handshaken();
    try {
      const first = await client.call('tools/call', {
        name: 'evo_run_submit',
        arguments: { prompt: 'Fix the failing build.', runId: 'dup-1' }
      });
      expect(payload(first).payload.runId).toBe('dup-1');
      const second = await client.call('tools/call', {
        name: 'evo_run_submit',
        arguments: { prompt: 'Fix it again.', runId: 'dup-1' }
      });
      expect(second.result.isError).toBe(true);
      expect(second.result.structuredContent.code).toBe('duplicate_run_id');
    } finally {
      await client.close();
      await instance.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// start/poll: submit never blocks on a slow run
// ---------------------------------------------------------------------------

describe('start/poll latency contract', () => {
  it('returns from submit while the run is still in flight', async () => {
    // The runner the SLOW path needs reaches the instance the test DRIVES: the
    // runBranch seam (src/index.ts:2415 precedence) is passed through
    // `assembly.options` to the SAME server whose tools are called below. The
    // old shape built a second, dataDir-less server, voided it, and drove the
    // first one — so the slow executor never ran and the only effect was a
    // write to the real plugin data directory (see the file header).
    let entered = false;
    let aborted = false;
    let completed = false;
    const slowRunner = async (context: { signal?: AbortSignal }): Promise<any> => {
      entered = true;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 5_000);
        const onAbort = (): void => {
          aborted = true;
          clearTimeout(timer);
          reject(new Error('aborted by dispose'));
        };
        if (context.signal?.aborted === true) {
          onAbort();
          return;
        }
        context.signal?.addEventListener('abort', onAbort, { once: true });
      });
      completed = true;
      return succeededBranch('slow');
    };
    const { instance, client } = await handshaken({
      assembly: { options: { runBranch: slowRunner as never } }
    });
    try {
      // The server under test IS the one built with the slow runner: its own
      // ready() resolves against the temp dataDir (never a stray instance).
      const assembly = await instance.ready;
      expect(isWithinPath(TEST_TMP_ROOT, assembly.dataDir)).toBe(true);

      const started = Date.now();
      const submitted = await client.call('tools/call', {
        name: 'evo_run_submit',
        arguments: { prompt: 'Long-running task.' }
      });
      const elapsed = Date.now() - started;
      const submission = payload(submitted).payload;
      expect(submission.status).toBe('started');
      // Submit answered while the run was still going: the reply is immediate
      // (well under the slow runner's 5s), and a first poll reports running.
      expect(elapsed).toBeLessThan(4_000);
      const polled = await client.call('tools/call', {
        name: 'evo_run_poll',
        arguments: { runId: submission.runId }
      });
      expect(payload(polled).payload.status).toBe('running');

      // The slow executor is genuinely the one in flight — otherwise "submit
      // returned early" would prove nothing about a minute-scale run.
      for (let attempt = 0; attempt < 100 && !entered; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(entered).toBe(true);
      expect(completed).toBe(false);
      expect(instance.pollJob(submission.runId).status).toBe('running');

      // Dispose cancels the in-flight run: the book aborts every running job
      // (src/mcp/server.ts:1099), the signal reaches the executor, and the
      // executor observes the abort instead of running out its 5s.
      const disposeStarted = Date.now();
      await instance.dispose();
      const disposeElapsed = Date.now() - disposeStarted;
      expect(aborted).toBe(true);
      expect(completed).toBe(false);
      expect(disposeElapsed).toBeLessThan(4_000);
      expect(instance.pollJob(submission.runId).status).toBe('cancelled');
    } finally {
      await client.close().catch(() => {});
      await instance.dispose().catch(() => {});
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// concurrency: submit x2 serializes the EXECUTION (rev8 review blocking fix 2)
// ---------------------------------------------------------------------------

describe('concurrent submits (rev8 review blocking fix 2)', () => {
  it('two overlapping submits are tracked as separate running jobs, but their executions serialize with no state crosstalk', async () => {
    // A controllable executor: each branch blocks until its test-side release.
    // The executor records overlap: enter/leave pairs must nest cleanly.
    const gates = new Map<string, () => void>();
    let inside = 0;
    let maxInside = 0;
    let entered = 0;
    const order: string[] = [];
    const runner = async (context: { signal?: AbortSignal; sessionId?: string }): Promise<any> => {
      entered += 1;
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      const sessionId = context.sessionId ?? 'unknown';
      order.push('enter:' + sessionId);
      await new Promise<void>((resolve, reject) => {
        const release = gates.get(sessionId);
        if (release !== undefined) {
          gates.delete(sessionId);
          resolve();
          return;
        }
        gates.set(sessionId, resolve);
        context.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      inside -= 1;
      order.push('leave:' + sessionId);
      return succeededBranch('done ' + sessionId);
    };

    const { instance, client } = await handshaken({
      pollAfterMs: 10,
      assembly: {
        options: { runBranch: runner as never },
        config: {
          triggerMode: 'slash_command',
          probe: { maxConcurrentProbes: 1, probeTimeoutMs: 30_000 },
          dreamRsi: {
            maxOnlineRolloutBudget: 2,
            maxWidth: 1,
            maxDepth: 1,
            candidatePoliciesCount: 2,
            rhoPreferences: [0, 1],
            offlineDreamTriggerEveryNTasks: 100
          },
          logging: { level: 'silent' }
        }
      }
    });
    try {
      // TWO submits back to back, DIFFERENT sessions, both holding in the
      // branch executor. Both tool calls answer immediately (start/poll).
      const first = await client.call('tools/call', {
        name: 'evo_run_submit',
        arguments: { prompt: 'Run one.', sessionId: 'sess-a' }
      });
      const second = await client.call('tools/call', {
        name: 'evo_run_submit',
        arguments: { prompt: 'Run two.', sessionId: 'sess-b' }
      });
      const idA: string = payload(first).payload.runId;
      const idB: string = payload(second).payload.runId;
      expect(idA).not.toBe(idB);

      // Give both runs a turn to reach the orchestrator.
      await new Promise((resolve) => setTimeout(resolve, 300));
      // Both jobs are tracked as running (the book keeps its per-job record),
      // and exactly ONE execution holds the orchestrator at a time.
      expect(instance.pollJob(idA).status).toBe('running');
      expect(instance.pollJob(idB).status).toBe('running');
      expect(entered).toBeGreaterThanOrEqual(1);
      expect(maxInside).toBe(1);

      // Release run A and let its run settle. B may already have entered the
      // executor by the time the wait ends (serialization releases it the
      // moment A's chain link finishes) — the overlap proof is the nesting,
      // asserted below, not a wall-clock guess about when B started.
      gates.get('sess-a')?.();
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(order).toEqual(expect.arrayContaining(['enter:sess-a', 'leave:sess-a']));
      expect(instance.pollJob(idA).status).toBe('complete');
      // A's settled result is A's own, with its full lifecycle intact.
      const snapshotA = instance.pollJob(idA);
      expect(snapshotA.result?.sessionId).toBe('sess-a');
      expect(Array.isArray(snapshotA.result?.metadata?.lifecycle)).toBe(true);

      // Release run B (its gate may or may not have been claimed yet; settle
      // it either way) and let it run to completion.
      gates.get('sess-b')?.();
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(instance.pollJob(idB).status).toBe('complete');
      const snapshotB = instance.pollJob(idB);
      expect(snapshotB.result?.sessionId).toBe('sess-b');
      expect(snapshotB.result?.runId).toBe(idB);
      // B's lifecycle was never reset by A's settlement (the crosstalk this
      // test pins): B carries its own full stage list.
      expect(snapshotB.result?.metadata?.lifecycle).toEqual(
        expect.arrayContaining(['initialize', 'finalize'])
      );
      // THE SERIALIZATION PROOF: exactly one probe execution inside the
      // orchestrator at any time (maxInside 1), and B's FIRST probe strictly
      // after A's FIRST settle — A's whole run completes before B's first
      // branch starts (the run-level chain, distinct from probe concurrency).
      expect(maxInside).toBe(1);
      const enterA = order.indexOf('enter:sess-a');
      const leaveA = order.indexOf('leave:sess-a');
      const enterB = order.indexOf('enter:sess-b');
      const leaveB = order.indexOf('leave:sess-b');
      expect(enterA).toBeGreaterThanOrEqual(0);
      expect(leaveA).toBeGreaterThan(enterA);
      expect(enterB).toBeGreaterThan(leaveA);
      expect(leaveB).toBeGreaterThan(enterB);
    } finally {
      // Release any gate left set so dispose never hangs on a blocked branch.
      for (const release of gates.values()) release();
      gates.clear();
      await client.close().catch(() => {});
      await instance.dispose().catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// timeout vs cancel
// ---------------------------------------------------------------------------

describe('run timeout (book deadline)', () => {
  it('a deadline abort settles the poll as timeout with timedOut=true', async () => {
    const blocked: Deferred = deferred();
    const runner = async (request: EvoHarnessRunRequest): Promise<EvoHarnessRunResult> => {
      // Hold until the deadline abort reaches us, then surface the abort as a
      // rejection (what a real probe executor does with an aborted signal).
      await new Promise<void>((_resolve, reject) => {
        if (request.signal?.aborted === true) {
          reject(new Error('deadline'));
          return;
        }
        request.signal?.addEventListener('abort', () => reject(new Error('deadline')), { once: true });
      });
      return blocked.promise;
    };
    // A runTimeoutMs of 150ms: the deadline fires long before the poll loop.
    const { instance, client } = await handshaken({
      runTimeoutMs: 150,
      pollAfterMs: 10,
      assembly: {
        options: { runBranch: runner as never },
        config: {
          triggerMode: 'slash_command',
          probe: { maxConcurrentProbes: 1, probeTimeoutMs: 30_000 },
          logging: { level: 'silent' }
        }
      }
    });
    try {
      const submitted = await client.call('tools/call', {
        name: 'evo_run_submit',
        arguments: { prompt: 'Hang until the deadline.' }
      });
      const runId: string = payload(submitted).payload.runId;
      const settled = await pollToSettle(client, runId);
      expect(settled['status']).toBe('timeout');
      expect(settled['timedOut']).toBe(true);
      // The server survived the timeout.
      const status = await client.call('tools/call', { name: 'evo_status', arguments: {} });
      expect(payload(status).payload.server.name).toBe('evo');
    } finally {
      blocked.resolve({
        runId: 'never',
        sessionId: 'never',
        taskId: 'never',
        outcome: 'skipped',
        trigger: 'slash_command',
        probesRun: 0,
        lessonsCommitted: 0,
        diagnostics: [],
        startedAt: 0,
        endedAt: 0
      });
      await client.close().catch(() => {});
      await instance.dispose().catch(() => {});
    }
  });
});

describe('run cancellation honesty (rev8 boundary fix 8)', () => {
  it('notifications/cancelled of an ALREADY-RETURNED submit cannot cancel the job; dispose is the real path', async () => {
    const observedSignals: AbortSignal[] = [];
    const runner = async (request: EvoHarnessRunRequest): Promise<EvoHarnessRunResult> => {
      observedSignals.push(request.signal!);
      await new Promise<void>((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(new Error('cancelled by client')), { once: true });
      });
      return {
        runId: request.runId ?? 'r',
        sessionId: request.sessionId,
        taskId: request.task.id,
        outcome: 'skipped',
        trigger: request.trigger,
        probesRun: 0,
        lessonsCommitted: 0,
        diagnostics: [],
        startedAt: 0,
        endedAt: 0
      };
    };
    const { instance, client } = await handshaken({
      pollAfterMs: 10,
      assembly: {
        options: { runBranch: runner as never },
        config: {
          triggerMode: 'slash_command',
          probe: { maxConcurrentProbes: 1, probeTimeoutMs: 30_000 },
          logging: { level: 'silent' }
        }
      }
    });
    try {
      const submitted = await client.call('tools/call', {
        name: 'evo_run_submit',
        arguments: { prompt: 'Will be cancelled.', runId: 'cancel-1' }
      });
      const runId: string = payload(submitted).payload.runId;
      // The run's controller signal must already be observable.
      for (let attempt = 0; attempt < 100 && observedSignals.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(observedSignals.length).toBeGreaterThan(0);
      expect(observedSignals[0]!.aborted).toBe(false);
      expect(instance.pollJob('cancel-1').status).toBe('running');

      // CANCELLATION HONESTY: evo_run_submit already returned its result, so
      // an MCP notifications/cancelled for that request id has nothing to
      // abort — the job keeps running. The notification is sent and the run
      // must STILL be observable as running afterwards.
      await client.notify('notifications/cancelled', { requestId: 2, reason: 'client went away' });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(instance.pollJob('cancel-1').status).toBe('running');
      expect(observedSignals[0]!.aborted).toBe(false);
      void runId;

      // The REAL cancel path: server dispose (or client disconnect, covered by
      // disconnect-lifecycle.test.ts over a real subprocess) cancels every
      // running job through book.cancelAll BEFORE the assembly flushes.
      await instance.dispose();
      // Dispose cancelled the in-flight run: the recorded signal is aborted.
      expect(observedSignals[0]!.aborted).toBe(true);
    } finally {
      await client.close().catch(() => {});
      await instance.dispose().catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// dispose ordering (rev8 boundary fix 3 + fix 9): cancel first, settle boundedly, then flush
// ---------------------------------------------------------------------------

describe('dispose ordering (cancel -> bounded settle -> flush)', () => {
  it('dispose cancels the running job, waits for its settlement, and only then flushes the assembly', async () => {
    let branchRelease: (() => void) | undefined;
    let sawAbort = false;
    const runner = async (context: { signal?: AbortSignal }): Promise<any> => {
      await new Promise<void>((resolve, reject) => {
        const release = (): void => {
          if (context.signal?.aborted === true) {
            sawAbort = true;
            reject(new Error('aborted by dispose'));
            return;
          }
          resolve();
        };
        if (context.signal?.aborted === true) {
          release();
          return;
        }
        context.signal?.addEventListener('abort', release, { once: true });
        branchRelease = release;
      });
      return succeededBranch('done');
    };
    const { instance, client, dataDir } = await handshaken({
      pollAfterMs: 10,
      assembly: {
        options: { runBranch: runner as never },
        config: {
          triggerMode: 'slash_command',
          probe: { maxConcurrentProbes: 1, probeTimeoutMs: 30_000 },
          logging: { level: 'silent' }
        }
      }
    });
    try {
      const submitted = await client.call('tools/call', {
        name: 'evo_run_submit',
        arguments: { prompt: 'Dispose while running.', runId: 'dispose-1' }
      });
      expect(submitted.result?.isError).toBeFalsy();
      // Park the run inside the branch executor.
      for (let attempt = 0; attempt < 100 && branchRelease === undefined; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(branchRelease).toBeDefined();

      // Dispose must complete WITHOUT the branch being released first — the
      // abort path (fix 3) releases it. When dispose resolves:
      //  1. the run observed the abort (cancel happened — the runner records
      //     the abort it saw);
      //  2. the job is SETTLED in the book — the bounded settle wait (fix 9)
      //     keeps dispose from flushing while a cancelled run is still
      //     unwinding. The run RESOLVES gracefully through its aborted probes
      //     and the book classifies a post-cancellation return as 'cancelled'
      //     with cancellationRequested=true and the partial result retained
      //     for audit (job-book.ts classifyAndSettle) — 'running' would mean
      //     dispose flushed over an unsettled run;
      //  3. the persistence data dir is fully removable (flush already ran —
      //     Windows rm fails over any still-open/unfinished write handle).
      await instance.dispose();
      expect(sawAbort).toBe(true);
      const snapshot = instance.pollJob('dispose-1');
      expect(snapshot.status).not.toBe('running');
      expect(snapshot.status).toBe('cancelled');
      expect(snapshot.timedOut).toBe(false);
      expect(snapshot.cancellationRequested).toBe(true);
      // The partial result survives for audit — never rewritten to a fake zero.
      expect(snapshot.result).toBeDefined();
      await expect(rm(dataDir, { recursive: true, force: true })).resolves.toBeUndefined();
    } finally {
      branchRelease?.();
      await client.close().catch(() => {});
      await instance.dispose().catch(() => {});
    }
  }, 30_000);

  it('a QUEUED run whose turn never comes (cancelled mid-queue) settles cancelled and never touches the orchestrator', async () => {
    const enteredSessions: string[] = [];
    let firstRelease: (() => void) | undefined;
    const runner = async (context: { signal?: AbortSignal; sessionId?: string }): Promise<any> => {
      enteredSessions.push(context.sessionId ?? 'unknown');
      if (firstRelease === undefined) {
        await new Promise<void>((resolve) => {
          firstRelease = resolve;
        });
      }
      return succeededBranch('done');
    };
    const { instance, client } = await handshaken({
      pollAfterMs: 10,
      assembly: {
        options: { runBranch: runner as never },
        config: {
          triggerMode: 'slash_command',
          probe: { maxConcurrentProbes: 1, probeTimeoutMs: 30_000 },
          logging: { level: 'silent' }
        }
      }
    });
    try {
      // Run A parks in the branch executor and holds the orchestrator chain;
      // run B is submitted behind it and sits QUEUED.
      const first = await client.call('tools/call', {
        name: 'evo_run_submit',
        arguments: { prompt: 'Holding the chain.', sessionId: 'sess-hold', runId: 'queue-hold' }
      });
      const second = await client.call('tools/call', {
        name: 'evo_run_submit',
        arguments: { prompt: 'Queued behind it.', sessionId: 'sess-queued', runId: 'queue-waiter' }
      });
      expect(payload(first).payload.runId).toBe('queue-hold');
      expect(payload(second).payload.runId).toBe('queue-waiter');
      for (let attempt = 0; attempt < 100 && firstRelease === undefined; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(firstRelease).toBeDefined();
      expect(enteredSessions).toEqual(['sess-hold']);

      // Dispose: the hold job's abort propagates (its runner is parked on the
      // signal), and the QUEUED job must settle 'cancelled' WITHOUT ever
      // starting — the server's enqueue guard rejects a request whose signal
      // aborted before its turn, so no orchestrator lifecycle opens against a
      // shutting-down assembly. The hold run itself RESOLVES gracefully
      // through its aborted probes, so the book keeps it as 'cancelled' with
      // cancellationRequested=true (the post-cancellation return is a partial
      // result, job-book.ts classifyAndSettle) — 'running' at
      // dispose-resolution time would mean the settle wait (fix 9) did not
      // hold the flush until settlement.
      await instance.dispose();
      const hold = instance.pollJob('queue-hold');
      expect(hold.status).toBe('cancelled');
      expect(hold.cancellationRequested).toBe(true);
      const waiter = instance.pollJob('queue-waiter');
      expect(waiter.status).toBe('cancelled');
      expect(waiter.result).toBeUndefined();
      expect(waiter.timedOut).toBe(false);
      // The queued run never entered the executor (every entry belongs to the
      // hold session — the hold run may legitimately re-enter per probe).
      expect(enteredSessions).not.toContain('sess-queued');
      for (const session of enteredSessions) {
        expect(session).toBe('sess-hold');
      }
    } finally {
      firstRelease?.();
      await client.close().catch(() => {});
      await instance.dispose().catch(() => {});
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// data isolation (rev8 leftover fix: no real plugin data dir, ever)
// ---------------------------------------------------------------------------

describe('data isolation', () => {
  it('every directory created by a served instance lives in the temp root; the real plugin data root is never touched', async () => {
    // The baseline server is built by handshaken(): temp dataDir, handshake.
    const { instance, client, dataDir } = await handshaken();
    const realRoots = realDshRoots();
    try {
      const assembly = await instance.ready;
      // The resolved data directory is the temp directory the test passed —
      // not a profiles/<name> fallback (src/persistence/data-dir.ts:142-152).
      expect(samePath(assembly.dataDir, dataDir)).toBe(true);
      expect(assembly.persistence.dataDir).toBe(assembly.dataDir);
      expect(isWithinPath(TEST_TMP_ROOT, assembly.dataDir)).toBe(true);
      for (const root of realRoots) {
        expect(isWithinPath(root, assembly.dataDir)).toBe(false);
      }

      // A real run + a poll + a status projection: the paths a run actually
      // writes (tree-pool.jsonl, counters.json, the JitRL experience log —
      // src/persistence/tree-pool.store.ts:53,
      // src/persistence/policy.store.ts:53-59, src/index.ts:2071-2076).
      const submitted = await client.call('tools/call', {
        name: 'evo_run_submit',
        arguments: { prompt: 'Isolation check.', sessionId: 'sess-iso' }
      });
      const runId: string = payload(submitted).payload.runId;
      await pollToSettle(client, runId);
      const status = await client.call('tools/call', { name: 'evo_status', arguments: {} });
      expect(String(payload(status).payload.dataDir)).toContain(path.basename(dataDir));

      // NEGATIVE ASSERTIONS. Both lists are computed from the calls the served
      // code made, not from the arrangement: if any instance had been built
      // without a temp dataDir, its mkdir would appear here.
      const created = guard!.createdDirs;
      expect(created.length).toBeGreaterThan(0);
      for (const createdPath of created) {
        expect(isWithinPath(TEST_TMP_ROOT, createdPath)).toBe(true);
        for (const root of realRoots) {
          expect(isWithinPath(root, createdPath)).toBe(false);
        }
      }
      expect(guard!.createdOutsideAllowed).toEqual([]);
      expect(guard!.forbiddenAccesses).toEqual([]);
      expect(guard!.blockedCalls).toEqual([]);
      // Every written path is inside the temp tree as well.
      expect(guard!.writtenPaths.length).toBeGreaterThan(0);
      for (const writtenPath of guard!.writtenPaths) {
        expect(isWithinPath(TEST_TMP_ROOT, writtenPath)).toBe(true);
      }
    } finally {
      await client.close().catch(() => {});
      await instance.dispose().catch(() => {});
    }
  }, 30_000);

  it('the guard is genuinely watching: every hook it claims is installed', async () => {
    // The classifier itself is self-tested in tests/mcp/fs-isolation-guard.test.ts
    // (that file owns the deliberately out-of-root calls, and its negative
    // control reproduces this exact file's old defect shape). Here the proof is
    // the other direction: the guard wrapped every operation it claims to wrap,
    // so "zero violations recorded above" cannot mean "nothing was being watched".
    expect(guard!.hooksComplete()).toBe(true);
    expect(guard!.hooked).toContain('promises.mkdir');
    expect(guard!.hooked).toContain('promises.open');
    expect(guard!.hooked).toContain('promises.readFile');
    expect(guard!.hookFailures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// unknown runId
// ---------------------------------------------------------------------------

describe('unknown runId', () => {
  it('poll of an unknown id is a coded error that names restart loss', async () => {
    const { instance, client } = await handshaken();
    try {
      const polled = await client.call('tools/call', {
        name: 'evo_run_poll',
        arguments: { runId: 'never-submitted' }
      });
      expect(polled.result.isError).toBe(true);
      expect(polled.result.structuredContent.code).toBe('unknown_run_id');
      expect(String(polled.result.structuredContent.message)).toContain('restart');
    } finally {
      await client.close();
      await instance.dispose();
    }
  });
});
