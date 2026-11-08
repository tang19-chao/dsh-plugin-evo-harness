import { describe, expect, it } from 'vitest';
import { HARNESS_COMPONENT_KEYS } from '../../../src/types/contracts';
import type { BranchSummary, IsolatedBranchContext } from '../../../src/types/contracts';
import { createCordisSeamManager, createInMemoryCordisHost } from '../../../src/cordis-seams';
import type { CordisHostAdapter } from '../../../src/cordis-seams';
import { createAgentLoopExecutor } from '../../../src/dsh-bridge/agent-loop-executor';
import {
  EVIDENCE_INTEGRITY_VERSION,
  readEvidenceIntegrityMark
} from '../../../src/verification/evidence-integrity';
import { writebackIntegrityViewOf } from '../../../src/jitrl/writeback-gate';
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

function neverSettles(): Promise<never> {
  return new Promise<never>(() => undefined);
}

function makeManager(host: CordisHostAdapter, idPrefix = 'br') {
  return createCordisSeamManager({
    host,
    createBranchId: makeIdFactory(idPrefix),
    createTrajectoryId: makeIdFactory('traj'),
    now: makeClock(1_000, 5)
  });
}

describe('runInIsolatedBranch', () => {
  it('mounts all eight surfaces, returns a ProbeTrajectory and disposes everything after success', async () => {
    const host = createInMemoryCordisHost();
    const manager = makeManager(host);
    let seen: IsolatedBranchContext | undefined;
    let duringRun: readonly BranchSummary[] = [];

    const trajectory = await manager.runInIsolatedBranch(
      makeRequest(makePatch(), async (context) => {
        seen = context;
        duringRun = manager.listActiveBranches();
        return makeExecutionResult();
      })
    );

    const context = seen as IsolatedBranchContext;
    expect(context.branchId).toBe('br-1');
    expect(context.namespace).toBe('harness2:probe_br-1');
    expect(context.sessionId).toBe('sess-1');
    expect(context.mountedSurfaces).toEqual([...HARNESS_COMPONENT_KEYS]);
    expect(context.patch.branchId).toBe('br-1');
    expect(Object.isFrozen(context.patch)).toBe(true);
    expect(context.signal.aborted).toBe(false);

    expect(duringRun).toHaveLength(1);
    expect(duringRun[0]?.mountedSurfaces).toEqual([...HARNESS_COMPONENT_KEYS]);
    expect(duringRun[0]?.patchId).toBe('patch-1');

    expect(trajectory.status).toBe('succeeded');
    expect(trajectory.branchId).toBe('br-1');
    expect(trajectory.branchNamespace).toBe('harness2:probe_br-1');
    expect(trajectory.patchId).toBe('patch-1');
    expect(trajectory.surfaceKeys).toEqual([...HARNESS_COMPONENT_KEYS]);
    expect(trajectory.metrics.steps).toBe(3);
    expect(trajectory.metrics.toolCalls).toBe(1);
    expect(trajectory.metrics.toolErrors).toBe(1);
    expect(trajectory.metrics.totalTokens).toBe(15);
    expect(trajectory.deliverable?.content).toBe('done');

    // Clean rollback: every mount, the sandbox and the forked context are gone.
    expect(manager.activeBranchCount).toBe(0);
    expect(manager.listActiveBranches()).toEqual([]);
    expect(host.activeEffects()).toEqual([]);
    expect(host.callCount('fork_branch')).toBe(1);
    expect(host.callCount('sandbox')).toBe(1);
    expect(host.sandboxes.every((sandbox) => sandbox.isDisposed)).toBe(true);
    expect(trajectory.metadata?.diagnostics).toEqual(['branch cleanup released resources with 0 failure(s)']);
  });

  it('honours an explicit branchId and namespace prefix', async () => {
    const host = createInMemoryCordisHost();
    const manager = createCordisSeamManager({
      host,
      namespacePrefix: 'custom',
      now: makeClock(1_000, 5)
    });
    let seen: IsolatedBranchContext | undefined;

    const trajectory = await manager.runInIsolatedBranch(
      makeRequest(makePatch(), async (context) => {
        seen = context;
        return makeExecutionResult();
      }, { branchId: 'br-explicit' })
    );

    expect((seen as IsolatedBranchContext).namespace).toBe('custom:probe_br-explicit');
    expect(trajectory.branchNamespace).toBe('custom:probe_br-explicit');
  });

  it('disposes every resource when the executor fails', async () => {
    const host = createInMemoryCordisHost();
    const manager = makeManager(host);

    const trajectory = await manager.runInIsolatedBranch(
      makeRequest(makePatch(), async () => {
        throw new Error('probe exploded');
      })
    );

    expect(trajectory.status).toBe('failed');
    expect(trajectory.error?.message).toBe('probe exploded');
    expect(trajectory.failureSignals.map((signal) => signal.kind)).toContain('unknown');
    expect(trajectory.surfaceKeys).toEqual([...HARNESS_COMPONENT_KEYS]);
    expect(manager.activeBranchCount).toBe(0);
    expect(host.activeEffects()).toEqual([]);
    expect(host.sandboxes.every((sandbox) => sandbox.isDisposed)).toBe(true);
  });

  it('times out a runaway probe and still unwinds the branch', async () => {
    const host = createInMemoryCordisHost();
    const manager = makeManager(host);

    const trajectory = await manager.runInIsolatedBranch(
      makeRequest(makePatch(), neverSettles, { timeoutMs: 5 })
    );

    expect(trajectory.status).toBe('timeout');
    expect(trajectory.error?.name).toBe('CordisSeamTimeoutError');
    expect(trajectory.failureSignals.map((signal) => signal.kind)).toContain('timeout');
    expect(manager.activeBranchCount).toBe(0);
    expect(host.activeEffects()).toEqual([]);
  });

  it('aborts a running probe when the caller aborts', async () => {
    const host = createInMemoryCordisHost();
    const manager = makeManager(host);
    const controller = new AbortController();
    const started = deferred<void>();

    const run = manager.runInIsolatedBranch(
      makeRequest(makePatch(), async () => {
        started.resolve();
        return neverSettles();
      }, { signal: controller.signal })
    );
    await started.promise;
    controller.abort();

    const trajectory = await run;

    expect(trajectory.status).toBe('aborted');
    expect(trajectory.failureSignals).toEqual([]);
    expect(host.activeEffects()).toEqual([]);
  });

  it('short-circuits an already-aborted request without acquiring resources', async () => {
    const host = createInMemoryCordisHost();
    const manager = makeManager(host);
    const controller = new AbortController();
    controller.abort();

    const trajectory = await manager.runInIsolatedBranch(
      makeRequest(makePatch(), async () => makeExecutionResult(), { signal: controller.signal })
    );

    expect(trajectory.status).toBe('aborted');
    expect(trajectory.surfaceKeys).toEqual([]);
    expect(host.callCount('fork_branch')).toBe(0);
    expect(host.effects).toEqual([]);
  });

  it('reports a failed trajectory when a required seam is unavailable', async () => {
    const host = createInMemoryCordisHost();
    const partialHost: CordisHostAdapter = {
      registerPromptSegment: host.registerPromptSegment!.bind(host)
    };
    const manager = makeManager(partialHost);

    const trajectory = await manager.runInIsolatedBranch(
      makeRequest(makePatch(), async () => makeExecutionResult())
    );

    expect(trajectory.status).toBe('failed');
    expect(trajectory.error?.code).toBe('seam_unavailable');
    expect(host.activeEffects()).toEqual([]);
  });

  it('enforces the concurrent branch limit and releases it afterwards', async () => {
    const host = createInMemoryCordisHost();
    const manager = createCordisSeamManager({
      host,
      maxConcurrentBranches: 1,
      createBranchId: makeIdFactory('br'),
      now: makeClock(1_000, 5)
    });
    const gate = deferred<void>();
    const started = deferred<void>();

    const running = manager.runInIsolatedBranch(
      makeRequest(makePatch(), async () => {
        started.resolve();
        await gate.promise;
        return makeExecutionResult();
      })
    );
    await started.promise;

    await expect(
      manager.runInIsolatedBranch(makeRequest(makePatch(), async () => makeExecutionResult()))
    ).rejects.toMatchObject({ code: 'branch_limit_exceeded' });

    gate.resolve();
    await expect(running).resolves.toMatchObject({ status: 'succeeded' });
    await expect(
      manager.runInIsolatedBranch(makeRequest(makePatch(), async () => makeExecutionResult()))
    ).resolves.toMatchObject({ status: 'succeeded' });
    expect(manager.activeBranchCount).toBe(0);
  });

  it('admits only one same-tick call when the cap is 1 (MEM-5 check-then-await TOCTOU)', async () => {
    const host = createInMemoryCordisHost();
    const manager = createCordisSeamManager({
      host,
      maxConcurrentBranches: 1,
      createBranchId: makeIdFactory('br'),
      now: makeClock(1_000, 5)
    });
    let entered = 0;
    // Both calls are fired in the same tick, so the second one must observe the
    // first call's synchronous slot reservation when it runs the limit check.
    const first = manager.runInIsolatedBranch(
      makeRequest(makePatch(), async () => {
        entered += 1;
        return makeExecutionResult();
      })
    );
    const second = manager.runInIsolatedBranch(
      makeRequest(makePatch(), async () => {
        entered += 1;
        return makeExecutionResult();
      })
    );
    await expect(second).rejects.toMatchObject({ code: 'branch_limit_exceeded' });
    await expect(first).resolves.toMatchObject({ status: 'succeeded' });
    expect(entered).toBe(1);
    expect(manager.activeBranchCount).toBe(0);
  });
});

describe('concurrent branch isolation', () => {
  it('keeps patches, namespaces, resources, hooks and skills disjoint across branches', async () => {
    const host = createInMemoryCordisHost();
    const manager = makeManager(host);
    const source = makePatch();
    const gate = deferred<void>();
    const startedA = deferred<void>();
    const startedB = deferred<void>();
    let contextA: IsolatedBranchContext | undefined;
    let contextB: IsolatedBranchContext | undefined;

    const runA = manager.runInIsolatedBranch(
      makeRequest(source, async (context) => {
        contextA = context;
        startedA.resolve();
        await gate.promise;
        return makeExecutionResult({ deliverable: { content: 'A' } });
      })
    );
    const runB = manager.runInIsolatedBranch(
      makeRequest(source, async (context) => {
        contextB = context;
        startedB.resolve();
        return makeExecutionResult({ deliverable: { content: 'B' } });
      })
    );

    await startedA.promise;
    await startedB.promise;
    const branchA = contextA as IsolatedBranchContext;
    const branchB = contextB as IsolatedBranchContext;

    expect(manager.activeBranchCount).toBe(2);
    expect(branchA.branchId).not.toBe(branchB.branchId);
    expect(branchA.namespace).not.toBe(branchB.namespace);

    // No shared mutable patch: distinct frozen object graphs, pinned to each branch.
    expect(branchA.patch).not.toBe(branchB.patch);
    expect(branchA.patch).not.toBe(source);
    expect(Object.isFrozen(branchA.patch)).toBe(true);
    expect(Object.isFrozen(branchB.patch)).toBe(true);
    expect(branchA.patch.branchId).toBe(branchA.branchId);
    expect(branchB.patch.branchId).toBe(branchB.branchId);
    expect(source.branchId).toBe('source-branch');
    expect(Object.isFrozen(source)).toBe(false);

    // Distinct surface ids, effects and sandboxes per branch.
    const idsA = host
      .effectsFor(branchA.namespace)
      .map((effect) => effect.surfaceId)
      .filter((id): id is string => id !== null);
    const idsB = host
      .effectsFor(branchB.namespace)
      .map((effect) => effect.surfaceId)
      .filter((id): id is string => id !== null);
    expect(idsA).toHaveLength(8);
    expect(idsB).toHaveLength(8);
    expect(idsA.filter((id) => idsB.includes(id))).toEqual([]);
    expect(host.activeEffects(branchA.namespace)).toHaveLength(10);
    expect(host.activeEffects(branchB.namespace)).toHaveLength(10);
    expect(host.sandboxes[0]).not.toBe(host.sandboxes[1]);

    // Mutating the caller's patch after the branches started cannot leak in.
    (source.edits.system_prompt as { content: string }).content = 'MUTATED';
    expect(branchA.patch.edits.system_prompt?.content).toBe('Prefer evidence over speculation.');

    // Branch B finishing tears down only B.
    const trajectoryB = await runB;
    expect(trajectoryB.deliverable?.content).toBe('B');
    expect(host.activeEffects(branchB.namespace)).toEqual([]);
    expect(host.activeEffects(branchA.namespace)).toHaveLength(10);
    expect(manager.activeBranchCount).toBe(1);

    gate.resolve();
    const trajectoryA = await runA;
    expect(trajectoryA.deliverable?.content).toBe('A');
    expect(host.activeEffects()).toEqual([]);
    expect(manager.activeBranchCount).toBe(0);
    expect(manager.listActiveBranches()).toEqual([]);
  });
});

describe('applyPermanentPatch', () => {
  it('mounts all eight surfaces and rolls every effect back on dispose', async () => {
    const host = createInMemoryCordisHost();
    const manager = makeManager(host);

    const disposer = await manager.applyPermanentPatch(makePatch());

    expect(disposer.patchId).toBe('patch-1');
    expect(disposer.active).toBe(true);
    expect(manager.permanentPatchCount).toBe(1);
    expect(host.activeEffects()).toHaveLength(8);
    const namespaces = new Set(host.activeEffects().map((effect) => effect.namespace));
    expect(namespaces.size).toBe(1);

    await disposer.dispose();

    expect(disposer.active).toBe(false);
    expect(manager.permanentPatchCount).toBe(0);
    expect(host.activeEffects()).toEqual([]);

    // Idempotent: a second dispose must not disturb anything.
    await disposer.dispose();
    expect(host.activeEffects()).toEqual([]);
  });

  it('rejects a second mount of the same patch id', async () => {
    const host = createInMemoryCordisHost();
    const manager = makeManager(host);

    await manager.applyPermanentPatch(makePatch());

    await expect(manager.applyPermanentPatch(makePatch())).rejects.toMatchObject({
      code: 'permanent_patch_conflict'
    });
    expect(manager.permanentPatchCount).toBe(1);
  });

  it('rolls back a partially mounted patch and surfaces the failing surface', async () => {
    const host = createInMemoryCordisHost();
    const manager = makeManager(host);
    host.failNext('memory_scope', 1, new Error('memory seam exploded'));

    let caught: unknown;
    try {
      await manager.applyPermanentPatch(makePatch());
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: 'surface_mount_failed', surface: 'memory' });
    expect(manager.permanentPatchCount).toBe(0);
    expect(host.activeEffects()).toEqual([]);
  });

  it('rolls permanent patches back when the manager is disposed', async () => {
    const host = createInMemoryCordisHost();
    const manager = makeManager(host);

    const first = await manager.applyPermanentPatch(makePatch());
    const second = await manager.applyPermanentPatch(makePatch({ id: 'patch-2' }));
    expect(host.activeEffects()).toHaveLength(16);

    await manager.dispose();

    expect(host.activeEffects()).toEqual([]);
    expect(manager.permanentPatchCount).toBe(0);
    expect(first.active).toBe(false);
    expect(second.active).toBe(false);
  });
});

describe('manager lifecycle', () => {
  it('aborts in-flight branches on dispose and refuses new work', async () => {
    const host = createInMemoryCordisHost();
    const manager = makeManager(host);
    const started = deferred<void>();
    const gate = deferred<void>();

    const running = manager.runInIsolatedBranch(
      makeRequest(makePatch(), async () => {
        started.resolve();
        await gate.promise;
        return makeExecutionResult();
      })
    );
    await started.promise;

    await manager.dispose();
    const trajectory = await running;

    expect(trajectory.status).toBe('aborted');
    expect(manager.isDisposed).toBe(true);
    expect(manager.activeBranchCount).toBe(0);
    expect(host.activeEffects()).toEqual([]);

    gate.resolve();
    await expect(
      manager.runInIsolatedBranch(makeRequest(makePatch(), async () => makeExecutionResult()))
    ).rejects.toMatchObject({ code: 'manager_disposed' });
    await expect(manager.applyPermanentPatch(makePatch())).rejects.toMatchObject({
      code: 'manager_disposed'
    });
    await expect(manager.dispose()).resolves.toBeUndefined();
  });

  it('rejects malformed requests before touching the host', async () => {
    const host = createInMemoryCordisHost();
    const manager = makeManager(host);

    await expect(
      manager.runInIsolatedBranch(
        makeRequest(makePatch(), async () => makeExecutionResult(), { sessionId: '' })
      )
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      manager.runInIsolatedBranch(
        makeRequest(makePatch(), undefined as never)
      )
    ).rejects.toMatchObject({ code: 'invalid_request' });

    expect(host.callCount('fork_branch')).toBe(0);
    expect(host.effects).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// rev8 #175: answer-key path collisions are refused BEFORE rollout
// ---------------------------------------------------------------------------

describe('rev8 #175: pre-rollout answer-key path rejection', () => {
  it('refuses a colliding patch without acquiring a branch or running the executor', async () => {
    const host = createInMemoryCordisHost();
    const manager = createCordisSeamManager({
      host,
      createBranchId: makeIdFactory('br'),
      createTrajectoryId: makeIdFactory('traj'),
      now: makeClock(1_000, 5),
      evidenceIntegrity: { taskId: 'task-1', forbiddenPathSegments: ['tests', 'reference'] }
    });
    const collidingPatch = {
      ...makePatch(),
      id: 'patch-collide',
      edits: {
        ...makePatch().edits,
        skills: { kind: 'skills' as const, skills: [{ name: 'tests', markdown: '# x' }] }
      }
    };
    let executed = 0;

    const trajectory = await manager.runInIsolatedBranch(
      makeRequest(collidingPatch, async () => {
        executed += 1;
        return makeExecutionResult();
      })
    );

    expect(executed).toBe(0);
    expect(trajectory.status).toBe('failed');
    expect(trajectory.failureSignals[0]?.code).toBe('answer-key-path');
    expect(trajectory.failureSignals[0]?.repairable).toBe(true);
    const mark = trajectory.metadata?.['evidenceIntegrity'] as { contaminated: boolean };
    expect(mark.contaminated).toBe(true);
    // No branch was ever acquired: the host saw nothing.
    expect(host.callCount('fork_branch')).toBe(0);
    expect(host.activeEffects()).toEqual([]);
  });

  it('a near-miss component name runs normally', async () => {
    const host = createInMemoryCordisHost();
    const manager = createCordisSeamManager({
      host,
      createBranchId: makeIdFactory('br'),
      createTrajectoryId: makeIdFactory('traj'),
      now: makeClock(1_000, 5),
      evidenceIntegrity: { taskId: 'task-1', forbiddenPathSegments: ['tests'] }
    });
    const nearMissPatch = {
      ...makePatch(),
      id: 'patch-near-miss',
      edits: {
        ...makePatch().edits,
        skills: { kind: 'skills' as const, skills: [{ name: 'run_tests', markdown: '# x' }] }
      }
    };
    let executed = 0;

    const trajectory = await manager.runInIsolatedBranch(
      makeRequest(nearMissPatch, async () => {
        executed += 1;
        return makeExecutionResult();
      })
    );

    expect(executed).toBe(1);
    expect(trajectory.status).toBe('succeeded');
    expect(trajectory.metadata?.['evidenceIntegrity']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// rev8 W2-propagation: the inner collector's mark survives the outer collector
//
// The DEFAULT production assembly arms the agent-loop executor's own collector
// with the host policy. That inner collector quarantines the content and leaves
// the only mark on the inner trajectory metadata, which the bridge projects to
// `result.metadata.trajectory`. The outer collector used to read no metadata and
// re-scanned already-neutral content, so the mark vanished. These tests pin the
// seam (real manager + real executor) rather than the plugin assembly.
// ---------------------------------------------------------------------------

const CARRIED_ANSWER_CRITERIA = [
  {
    id: 'k1',
    text: 'the reconciliation ledger must record every disputed invoice line verbatim including the reversal timestamp and the operator initials'
  },
  {
    id: 'k2',
    text: 'the migration script must abort before writing whenever the checksum manifest disagrees with the fetched artifact digest'
  }
] as const;
const CARRIED_FULL_KEY = CARRIED_ANSWER_CRITERIA.map((entry) => entry.text).join('\n');
const CARRIED_POLICY = {
  taskId: 'task-carried-seam',
  answerKey: { criteria: CARRIED_ANSWER_CRITERIA, visibleText: [] }
};

describe('rev8 W2-propagation: the seam preserves the inner collector mark', () => {
  it('the REAL agent-loop executor mark survives the REAL seam manager', async () => {
    const host = createInMemoryCordisHost();
    const manager = createCordisSeamManager({
      host,
      createBranchId: makeIdFactory('br'),
      createTrajectoryId: makeIdFactory('traj'),
      now: makeClock(1_000, 5),
      evidenceIntegrity: CARRIED_POLICY
    });
    // The same construction the plugin performs: the inner collector is armed
    // with the host policy, so it quarantines before the manager sees the result.
    const executor = createAgentLoopExecutor(
      {
        model: {
          async complete() {
            return { text: CARRIED_FULL_KEY, finishReason: 'stop' as const, model: 'scripted' };
          }
        },
        evidenceIntegrity: CARRIED_POLICY
      },
      makeClock(1_000, 5)
    );

    const trajectory = await manager.runInIsolatedBranch(
      makeRequest(makePatch(), executor.runBranch)
    );

    expect(trajectory.status).toBe('failed');
    expect(trajectory.deliverable).toBeUndefined();
    // The outer trajectory carries the mark the orchestrator/gates read.
    const mark = readEvidenceIntegrityMark(trajectory.metadata);
    expect(mark?.contaminated).toBe(true);
    expect(mark?.findings.map((finding) => finding.kind)).toContain('answer-key-text');
    expect(writebackIntegrityViewOf(trajectory)).toEqual({ contaminated: true });
    expect(JSON.stringify(trajectory)).not.toContain(CARRIED_ANSWER_CRITERIA[0].text);
  });

  it('an untrusted executor cannot claim clean over contaminated content', async () => {
    const host = createInMemoryCordisHost();
    const manager = createCordisSeamManager({
      host,
      createBranchId: makeIdFactory('br'),
      createTrajectoryId: makeIdFactory('traj'),
      now: makeClock(1_000, 5),
      evidenceIntegrity: CARRIED_POLICY
    });

    const trajectory = await manager.runInIsolatedBranch(
      makeRequest(makePatch(), async () => ({
        status: 'succeeded',
        steps: [{ index: 0, at: 1_000, kind: 'result' as const, text: 'done' }],
        deliverable: { content: CARRIED_FULL_KEY, format: 'text' as const },
        metadata: {
          trajectory: {
            evidenceIntegrity: {
              version: EVIDENCE_INTEGRITY_VERSION,
              contaminated: false,
              withheld: false,
              findings: []
            }
          }
        }
      }))
    );

    // The forged clean claim is inert: the host scan is authoritative.
    expect(trajectory.status).toBe('failed');
    const mark = readEvidenceIntegrityMark(trajectory.metadata);
    expect(mark?.contaminated).toBe(true);
    expect(mark?.findings.map((finding) => finding.kind)).toContain('answer-key-text');
  });
});
