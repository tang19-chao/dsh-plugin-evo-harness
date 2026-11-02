/**
 * Regression tests for the CROSS-AUDIT-REPORT §6 memory/seams residual items
 * owned by the cordis-seams layer (MEM-6/7/11/12). Each test reproduces the
 * failure shape the second-round audit confirmed.
 */

import { describe, expect, it } from 'vitest';

import {
  createCordisSeamManager,
  createInMemoryCordisHost,
  createToolFaceRegistry,
  DisposableRegistry,
  safeDispose,
  TrajectoryCollector,
  DEFAULT_DISPOSE_DEADLINE_MS
} from '../../../src/cordis-seams';
import type { CordisHostAdapter } from '../../../src/cordis-seams';
import { makeClock, makeExecutionResult, makeIdFactory, makePatch, makeRequest } from './fixtures';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// MEM-6: a duplicate caller-supplied branchId is rejected, not silently shared
// ---------------------------------------------------------------------------

describe('MEM-6 duplicate branchId rejection', () => {
  function manager(host: CordisHostAdapter, maxConcurrentBranches?: number) {
    return createCordisSeamManager({
      host,
      maxConcurrentBranches,
      createBranchId: makeIdFactory('br'),
      createTrajectoryId: makeIdFactory('traj'),
      now: makeClock(1_000, 5)
    });
  }

  it('rejects two same-tick calls that share one branchId instead of sharing the namespace', async () => {
    const host = createInMemoryCordisHost();
    const seams = manager(host);
    const gate = deferred<void>();
    const firstStarted = deferred<void>();
    const seen: string[] = [];

    const first = seams.runInIsolatedBranch(
      makeRequest(
        makePatch(),
        async (context) => {
          seen.push(context.namespace);
          firstStarted.resolve();
          await gate.promise;
          return makeExecutionResult();
        },
        { branchId: 'dup-branch' }
      )
    );
    const second = seams.runInIsolatedBranch(
      makeRequest(
        makePatch(),
        async (context) => {
          seen.push(context.namespace);
          return makeExecutionResult();
        },
        { branchId: 'dup-branch' }
      )
    );

    await expect(second).rejects.toMatchObject({ code: 'branch_id_conflict' });
    await firstStarted.promise;
    gate.resolve();
    await expect(first).resolves.toMatchObject({ status: 'succeeded' });

    // Exactly one branch ever entered the executor: the duplicate never got
    // its own (or a shared) namespace.
    expect(seen).toEqual(['harness2:probe_dup-branch']);
    expect(seams.activeBranchCount).toBe(0);
    expect(host.activeEffects()).toEqual([]);
  });

  it('lets the same branchId run again once the first branch has finished', async () => {
    const host = createInMemoryCordisHost();
    const seams = manager(host);
    const seen: string[] = [];

    await seams.runInIsolatedBranch(
      makeRequest(
        makePatch(),
        async (context) => {
          seen.push(context.namespace);
          return makeExecutionResult();
        },
        { branchId: 'reused' }
      )
    );
    await seams.runInIsolatedBranch(
      makeRequest(
        makePatch(),
        async (context) => {
          seen.push(context.namespace);
          return makeExecutionResult();
        },
        { branchId: 'reused' }
      )
    );
    expect(seen).toEqual(['harness2:probe_reused', 'harness2:probe_reused']);
    expect(seams.activeBranchCount).toBe(0);
  });

  it('still rejects duplicate branchIds when the concurrency cap is not the binding limit', async () => {
    const host = createInMemoryCordisHost();
    const seams = manager(host, 8);
    const gate = deferred<void>();
    const started = deferred<void>();

    const running = seams.runInIsolatedBranch(
      makeRequest(
        makePatch(),
        async () => {
          started.resolve();
          await gate.promise;
          return makeExecutionResult();
        },
        { branchId: 'same' }
      )
    );
    await started.promise;
    await expect(
      seams.runInIsolatedBranch(makeRequest(makePatch(), async () => makeExecutionResult(), { branchId: 'same' }))
    ).rejects.toMatchObject({ code: 'branch_id_conflict' });

    gate.resolve();
    await expect(running).resolves.toMatchObject({ status: 'succeeded' });
  });
});

// ---------------------------------------------------------------------------
// MEM-7: the allowlist TTL renews while a branch is still dispatching
// ---------------------------------------------------------------------------

describe('MEM-7 allowlist TTL renewal on use', () => {
  it('never lapses to fail-open no-policy while decisions keep arriving', () => {
    let clock = 1_000;
    const registry = createToolFaceRegistry({ now: () => clock, ttlMs: 100 });
    registry.install({ branchId: 'br-1', allowTools: ['read_note'] });

    // Advance past the original expiry in two steps, dispatching in between:
    // each decision renews the expiry from NOW, so the policy is still there.
    clock = 1_050;
    expect(registry.decide({ toolName: 'read_note', branchId: 'br-1' })).toMatchObject({
      allowed: true,
      code: 'allowlisted'
    });
    clock = 1_120;
    expect(registry.decide({ toolName: 'shell', branchId: 'br-1' })).toMatchObject({
      allowed: false,
      code: 'not-allowlisted'
    });
    clock = 1_190;
    expect(registry.decide({ toolName: 'read_note', branchId: 'br-1' })).toMatchObject({
      allowed: true,
      code: 'allowlisted'
    });
    expect(registry.stats().noPolicy).toBe(0);
  });

  it('still expires an idle policy so a leaked policy cannot live forever', () => {
    let clock = 1_000;
    const registry = createToolFaceRegistry({ now: () => clock, ttlMs: 100 });
    registry.install({ branchId: 'br-1', allowTools: ['read_note'] });
    clock = 1_500;
    expect(registry.policyFor('br-1')).toBeUndefined();
    expect(registry.stats().expiredPolicies).toBe(1);
  });

  it('falls back to the documented default TTL for non-positive registry values', () => {
    let clock = 1_000;
    const defaulted = createToolFaceRegistry({ now: () => clock, ttlMs: 0 });
    const policy = defaulted.install({ branchId: 'br-1', allowTools: ['read_note'] });
    expect(policy.expiresAt).toBe(clock + 1_800_000);
    expect(policy.ttlMs).toBe(1_800_000);
  });
});

// ---------------------------------------------------------------------------
// MEM-11: a hung disposer is bounded by the deadline and the LIFO pass goes on
// ---------------------------------------------------------------------------

describe('MEM-11 disposal deadline', () => {
  it('reports a never-settling disposer as a failure and disposes the rest', async () => {
    const order: string[] = [];
    const registry = new DisposableRegistry({ disposeDeadlineMs: 50 });
    registry.register('first', () => {
      order.push('first');
    });
    registry.register('hung', () => new Promise<void>(() => undefined));
    registry.register('last', () => {
      order.push('last');
    });

    const failures = await registry.disposeAll();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.label).toBe('hung');
    expect(String((failures[0]?.error as Error).message)).toContain('50ms');
    // LIFO continues: the entries registered BEFORE the hung one still unwind.
    expect(order).toEqual(['last', 'first']);
    expect(registry.size).toBe(0);
  });

  it('does not delay a well-behaved disposer', async () => {
    const registry = new DisposableRegistry({ disposeDeadlineMs: 50 });
    const dispose = () => undefined;
    registry.register('fast', dispose);
    const started = Date.now();
    await expect(registry.disposeAll()).resolves.toEqual([]);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('safeDispose accepts an explicit deadline and defaults to a generous bound', async () => {
    expect(DEFAULT_DISPOSE_DEADLINE_MS).toBe(30_000);
    const failure = await safeDispose('hang', () => new Promise<void>(() => undefined), 25);
    expect(failure?.label).toBe('hang');
    await expect(safeDispose('ok', () => undefined, 25)).resolves.toBeNull();
    await expect(safeDispose('none', undefined, 25)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MEM-12: finalize merges steps, tool errors and signals the same way
// ---------------------------------------------------------------------------

describe('MEM-12 uniform finalize merge', () => {
  function collector() {
    return new TrajectoryCollector({
      id: 'traj-1',
      sessionId: 'sess-1',
      branchId: 'br-1',
      branchNamespace: 'harness2:probe_br-1',
      role: 'candidate',
      patch: makePatch(),
      now: makeClock(1_000, 10)
    });
  }

  it('keeps collector-recorded steps when the executor also returns steps', () => {
    const col = collector();
    col.appendStep({ kind: 'model', text: 'collector step' });
    const trajectory = col.finalize({
      endedAt: 1_200,
      result: {
        status: 'succeeded',
        steps: [{ index: 3, at: 1, kind: 'tool', toolName: 'shell' }],
        toolErrors: [],
        failureSignals: []
      }
    });
    // Union, collector-first, reindexed — the old code REPLACED collector steps.
    expect(trajectory.steps.map((step) => step.kind)).toEqual(['model', 'tool']);
    expect(trajectory.steps.map((step) => step.index)).toEqual([0, 1]);
    expect(trajectory.metrics.steps).toBe(2);
  });

  it('covers the union of tool errors and signals from both sources', () => {
    const col = collector();
    col.recordToolError({ toolName: 'collector', message: 'collector error' });
    col.recordFailureSignal({ kind: 'budget_exhausted', message: 'collector signal' });
    const trajectory = col.finalize({
      endedAt: 1_200,
      result: {
        status: 'failed',
        steps: [],
        toolErrors: [{ toolName: 'executor', message: 'executor error' }],
        failureSignals: [{ kind: 'tool_error', message: 'executor signal' }]
      }
    });
    expect(trajectory.toolErrors.map((entry) => entry.toolName)).toEqual(['collector', 'executor']);
    expect(trajectory.metrics.toolErrors).toBe(2);
    expect(trajectory.failureSignals.map((signal) => signal.message)).toContain('collector signal');
    expect(trajectory.failureSignals.map((signal) => signal.message)).toContain('executor signal');
  });

  it('leaves a collector-only finalize unchanged', () => {
    const col = collector();
    col.appendStep({ kind: 'model', text: 'only step' });
    const trajectory = col.finalize({ status: 'succeeded', endedAt: 1_200 });
    expect(trajectory.steps).toHaveLength(1);
    expect(trajectory.metrics.steps).toBe(1);
  });
});
