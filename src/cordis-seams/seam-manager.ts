/**
 * CordisSeamManager: the ICordisSeamManager implementation.
 *
 * Responsibilities
 *  - runInIsolatedBranch: fork a child context, mount the patch's surfaces inside
 *    it, run the injected executor, collect a ProbeTrajectory and dispose every
 *    branch resource on success, failure, timeout and abort.
 *  - applyPermanentPatch: mount a patch for real and return an idempotent
 *    disposer that rolls back every registered effect.
 *  - listActiveBranches / dispose: observable lifecycle for the orchestrator.
 *
 * The manager is host-neutral: it only talks to the injected CordisHostAdapter,
 * so unit tests run against structural mocks with no DSH runtime.
 */
import type {
  BranchSummary,
  EightSurfacePatch,
  HarnessComponentKey,
  ICordisSeamManager,
  IsolatedBranchContext,
  ProbeBranchRequest,
  ProbeExecutionResult,
  ProbeTrajectory,
  SurfacePatchDisposer,
  TrajectoryStatus
} from '../types/contracts';
import { buildBranchNamespace, createBranchIdFactory, createIsolatedBranch } from './context-forker';
import type { IsolatedBranchResources } from './context-forker';
import { DisposableRegistry } from './disposable-registry';
import { mountEightSurfaces } from './eight-surfaces';
import type { MountedSurfaces } from './eight-surfaces';
import { CordisSeamAbortError, CordisSeamError, CordisSeamTimeoutError } from './errors';
import type { ToolFaceRegistry } from './tool-face';
import type { CordisHostAdapter } from './host-adapter';
import { cloneAndFreezePatch } from './patch-utils';
import { TrajectoryCollector } from './trajectory-collector';

const defaultTrajectoryIds = createBranchIdFactory('traj');

/** Wiring for a CordisSeamManager. */
export interface CordisSeamManagerOptions {
  readonly host: CordisHostAdapter;
  readonly namespacePrefix?: string;
  readonly enabledSurfaces?: readonly HarnessComponentKey[];
  readonly maxConcurrentBranches?: number;
  readonly defaultTimeoutMs?: number;
  readonly now?: () => number;
  readonly createBranchId?: () => string;
  readonly createTrajectoryId?: () => string;
  readonly onDiagnostic?: (message: string, details?: Readonly<Record<string, unknown>>) => void;
  /**
   * P4-C: branch tool face. When set together with `toolAllowlist`, every probe
   * run installs a per-branch allowlist policy for its lifetime and removes it
   * on cleanup, so the isolated branch context carries exactly one tool face and
   * a sibling branch can never inherit it.
   *
   * The policy is an in-process cooperative fence, NOT a sandbox: it shares the
   * host process, filesystem and credentials.
   */
  readonly toolFace?: ToolFaceRegistry;
  /** The tools a probe branch may call. An empty array denies every tool. */
  readonly toolAllowlist?: readonly string[];
}

interface ActiveBranchRecord {
  readonly branchId: string;
  readonly sessionId: string;
  readonly namespace: string;
  readonly patchId: string;
  readonly startedAt: number;
  readonly seq: number;
  readonly resources: IsolatedBranchResources;
  mountedSurfaces: readonly HarnessComponentKey[];
}

interface PermanentPatchRecord {
  readonly registry: DisposableRegistry;
  readonly namespace: string;
  active: boolean;
}

interface ExecutionOutcome {
  readonly status?: TrajectoryStatus;
  readonly result?: ProbeExecutionResult;
  readonly error?: unknown;
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CordisSeamError('"' + field + '" must be a non-empty string.', {
      code: 'invalid_request',
      details: { field }
    });
  }
  return value;
}

function assertProbeBranchRequest(request: ProbeBranchRequest): void {
  if (typeof request !== 'object' || request === null) {
    throw new CordisSeamError('A ProbeBranchRequest object is required.', { code: 'invalid_request' });
  }
  assertNonEmptyString(request.sessionId, 'sessionId');
  if (typeof request.executor !== 'function') {
    throw new CordisSeamError('ProbeBranchRequest.executor must be a function.', {
      code: 'invalid_request',
      details: { field: 'executor' }
    });
  }
  const patch = request.patch as EightSurfacePatch | undefined;
  assertNonEmptyString(patch === undefined ? undefined : patch.id, 'patch.id');
  if (patch === undefined || typeof patch.edits !== 'object' || patch.edits === null) {
    throw new CordisSeamError('ProbeBranchRequest.patch.edits must be an object.', {
      code: 'invalid_request',
      details: { field: 'patch.edits' }
    });
  }
  const task = request.task as { id?: unknown; prompt?: unknown } | undefined;
  if (task === undefined || task === null || typeof task !== 'object') {
    throw new CordisSeamError('ProbeBranchRequest.task is required.', {
      code: 'invalid_request',
      details: { field: 'task' }
    });
  }
  assertNonEmptyString(task.id, 'task.id');
}

/** ICordisSeamManager implementation over a host-neutral adapter. */
export class CordisSeamManager implements ICordisSeamManager {
  private readonly host: CordisHostAdapter;
  private readonly namespacePrefix: string | undefined;
  private readonly enabledSurfaces: readonly HarnessComponentKey[] | undefined;
  private readonly maxConcurrentBranches: number;
  private readonly defaultTimeoutMs: number | undefined;
  private readonly now: () => number;
  private readonly createBranchId: () => string;
  private readonly createTrajectoryId: () => string;
  private readonly onDiagnostic: ((message: string, details?: Readonly<Record<string, unknown>>) => void) | undefined;
  private readonly toolFace: ToolFaceRegistry | undefined;
  private readonly toolAllowlist: readonly string[] | undefined;
  private readonly activeBranches = new Map<string, ActiveBranchRecord>();
  private readonly permanentPatches = new Map<string, PermanentPatchRecord>();
  private sequence = 0;
  private disposed = false;

  constructor(options: CordisSeamManagerOptions) {
    if (options === null || options === undefined || options.host === undefined) {
      throw new CordisSeamError('CordisSeamManager requires a host adapter.', {
        code: 'invalid_request',
        details: { field: 'host' }
      });
    }
    this.host = options.host;
    this.namespacePrefix = options.namespacePrefix;
    this.enabledSurfaces = options.enabledSurfaces;
    this.maxConcurrentBranches = options.maxConcurrentBranches ?? 8;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.now = options.now ?? Date.now;
    this.createBranchId = options.createBranchId ?? createBranchIdFactory();
    this.createTrajectoryId = options.createTrajectoryId ?? defaultTrajectoryIds;
    this.onDiagnostic = options.onDiagnostic;
    this.toolFace = options.toolFace;
    if (options.toolAllowlist !== undefined && !Array.isArray(options.toolAllowlist)) {
      throw new CordisSeamError('toolAllowlist must be an array of tool names.', {
        code: 'invalid_request',
        details: { field: 'toolAllowlist' }
      });
    }
    this.toolAllowlist = options.toolAllowlist === undefined ? undefined : options.toolAllowlist.slice();

    if (!Number.isInteger(this.maxConcurrentBranches) || this.maxConcurrentBranches < 1) {
      throw new CordisSeamError('maxConcurrentBranches must be a positive integer.', {
        code: 'invalid_request',
        details: { maxConcurrentBranches: this.maxConcurrentBranches }
      });
    }
  }

  /** Number of branches currently executing. */
  get activeBranchCount(): number {
    return this.activeBranches.size;
  }

  /** Number of permanent patches currently mounted. */
  get permanentPatchCount(): number {
    return this.permanentPatches.size;
  }

  /** True once dispose() has been called. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Run one probe in a fully isolated branch and return its trajectory. Every
   * resource acquired for the branch is disposed before this resolves, whatever
   * the outcome.
   */
  async runInIsolatedBranch(request: ProbeBranchRequest): Promise<ProbeTrajectory> {
    this.assertNotDisposed();
    assertProbeBranchRequest(request);

    const sessionId = request.sessionId;
    // ADR 0006 D-P4-4: a probe mount is branch-class, so the branch it proves
    // must be attributable. A request may carry a branchId, or the manager
    // mints one here; it is never left for a mount to be matched on the
    // sessionId alone.
    const branchId =
      request.branchId !== undefined && request.branchId.length > 0
        ? request.branchId
        : this.createBranchId();
    const namespace = buildBranchNamespace(this.namespacePrefix, branchId);
    const collector = new TrajectoryCollector({
      id: this.createTrajectoryId(),
      sessionId,
      branchId,
      branchNamespace: namespace,
      role: request.role ?? 'candidate',
      patch: request.patch,
      surfaceKeys: [],
      now: this.now,
      ...(request.treeId === undefined ? {} : { treeId: request.treeId }),
      ...(request.nodeId === undefined ? {} : { nodeId: request.nodeId }),
      ...(request.referenceTrajectoryId === undefined
        ? {}
        : { referenceTrajectoryId: request.referenceTrajectoryId }),
      ...(request.memoryRecallIds === undefined ? {} : { memoryRecallIds: request.memoryRecallIds })
    });

    if (request.signal !== undefined && request.signal.aborted) {
      collector.recordDiagnostic('request was already aborted; no branch resources were acquired');
      return collector.finalize({ status: 'aborted', endedAt: this.now() });
    }

    if (this.activeBranches.size >= this.maxConcurrentBranches) {
      throw new CordisSeamError(
        'Concurrent probe branch limit (' + this.maxConcurrentBranches + ') reached.',
        { code: 'branch_limit_exceeded', branchId, patchId: request.patch.id }
      );
    }

    let resources: IsolatedBranchResources | undefined;
    let result: ProbeExecutionResult | undefined;
    let error: unknown;
    let status: TrajectoryStatus | undefined;
    let toolFaceInstalled: string | undefined;

    try {
      resources = await createIsolatedBranch({
        host: this.host,
        sessionId,
        task: request.task,
        patch: request.patch,
        branchId,
        namespacePrefix: this.namespacePrefix,
        timeoutMs: request.timeoutMs ?? this.defaultTimeoutMs,
        parentSignal: request.signal,
        now: this.now,
        createBranchId: this.createBranchId
      });

      this.activeBranches.set(branchId, {
        branchId,
        sessionId,
        namespace: resources.namespace,
        patchId: resources.patchId,
        startedAt: resources.startedAt,
        seq: this.sequence,
        resources,
        mountedSurfaces: []
      });
      this.sequence += 1;

      const isInvariant =
        resources.frozenPatch.guidance === 'guidance_free' ||
        resources.frozenPatch.origin === 'invariant';
      const mounted: MountedSurfaces = await mountEightSurfaces(
        this.host,
        resources.frozenPatch,
        {
          sessionId,
          branchId,
          namespace: resources.namespace,
          patchId: resources.patchId,
          origin: resources.frozenPatch.origin,
          guidance: resources.frozenPatch.guidance,
          role: isInvariant ? 'invariant' : 'domain',
          allowAdvice: !isInvariant,
          // ADR 0006 D-P4-4: a probe mount belongs to ONE branch. It applies
          // only to a dispatch that proves this exact branchId - never to a
          // host dispatch, and never to a sibling branch that merely shares
          // the same sessionId.
          mountScope: 'branch'
        },
        { registry: resources.registry, enabledSurfaces: this.enabledSurfaces }
      );
      const record = this.activeBranches.get(branchId);
      if (record !== undefined) {
        record.mountedSurfaces = mounted.keys;
      }
      collector.setSurfaceKeys(mounted.keys);

      const context: IsolatedBranchContext = {
        branchId,
        sessionId,
        namespace: resources.namespace,
        task: request.task,
        patch: resources.frozenPatch,
        mountedSurfaces: mounted.keys,
        signal: resources.signal
      };

      // P4-C: the isolated branch context owns exactly one tool face for its
      // lifetime. A sibling branch gets its own policy (or none), and cleanup
      // removes it even when the executor throws or times out.
      if (this.toolFace !== undefined && this.toolAllowlist !== undefined) {
        this.toolFace.install({ branchId, allowTools: this.toolAllowlist, label: 'probe:' + branchId });
        toolFaceInstalled = branchId;
      }

      const outcome = await this.execute(request, resources, context);
      status = outcome.status;
      result = outcome.result;
      error = outcome.error;
    } catch (caught) {
      error = caught;
      status = 'failed';
    } finally {
      if (toolFaceInstalled !== undefined && this.toolFace !== undefined) {
        try {
          this.toolFace.remove(toolFaceInstalled);
        } catch (cleanupError) {
          this.onDiagnostic?.('branch_tool_face_cleanup_failed', {
            branchId: toolFaceInstalled,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          });
        }
      }
      if (resources !== undefined) {
        const failures = await resources.dispose();
        collector.recordDiagnostic(
          'branch cleanup released resources with ' + failures.length + ' failure(s)'
        );
        for (const failure of failures) {
          collector.recordDiagnostic('cleanup failure: ' + failure.label);
          this.onDiagnostic?.('branch_cleanup_failed', {
            branchId,
            label: failure.label,
            error: failure.error instanceof Error ? failure.error.message : String(failure.error)
          });
        }
        this.activeBranches.delete(branchId);
      }
    }

    return collector.finalize({ status, result, error });
  }

  /**
   * Run the injected executor under timeout and abort guards. Guard failures win
   * the race and are reported as 'timeout' / 'aborted'; any other throw is a
   * 'failed' run. Cleanup of timers and listeners happens in every path.
   */
  private async execute(
    request: ProbeBranchRequest,
    resources: IsolatedBranchResources,
    context: IsolatedBranchContext
  ): Promise<ExecutionOutcome> {
    const guards: Promise<never>[] = [];
    const cleanups: Array<() => void> = [];
    let timedOut = false;
    let aborted = false;

    // The branch controller is the single owner of the timeout: createIsolatedBranch
    // aborts it with a CordisSeamTimeoutError when the budget elapses, the caller's
    // signal aborts it on cancellation, and the manager aborts it on dispose. The
    // abort reason therefore decides whether this run timed out or was cancelled.
    guards.push(
      new Promise<never>((_resolve, reject) => {
        const onBranchAbort = (): void => {
          const reason: unknown = resources.signal.reason;
          if (reason instanceof CordisSeamTimeoutError) {
            timedOut = true;
            reject(reason);
            return;
          }
          aborted = true;
          reject(
            new CordisSeamAbortError(
              'Branch ' + context.branchId + ' was aborted.',
              { branchId: context.branchId }
            )
          );
        };
        if (resources.signal.aborted) {
          onBranchAbort();
          return;
        }
        resources.signal.addEventListener('abort', onBranchAbort, { once: true });
        cleanups.push(() => resources.signal.removeEventListener('abort', onBranchAbort));
      })
    );

    const parentSignal = request.signal;
    if (parentSignal !== undefined) {
      guards.push(
        new Promise<never>((_resolve, reject) => {
          const onAbort = (): void => {
            aborted = true;
            resources.abort(parentSignal.reason);
            reject(
              new CordisSeamAbortError(
                'Branch ' + context.branchId + ' was aborted by its caller.',
                { branchId: context.branchId }
              )
            );
          };
          if (parentSignal.aborted) {
            onAbort();
            return;
          }
          parentSignal.addEventListener('abort', onAbort, { once: true });
          cleanups.push(() => parentSignal.removeEventListener('abort', onAbort));
        })
      );
    }

    const executorPromise: Promise<ProbeExecutionResult> = Promise.resolve().then(() =>
      request.executor(context)
    );
    // The executor may settle after a timeout/abort already won the race; make
    // sure that late settlement is never an unhandled rejection.
    executorPromise.catch(() => undefined);

    try {
      const raceables: Array<Promise<ProbeExecutionResult>> = [
        executorPromise,
        ...guards.map((guard) => guard as unknown as Promise<ProbeExecutionResult>)
      ];
      const result = await Promise.race(raceables);
      return { result };
    } catch (caught) {
      if (timedOut) {
        return { status: 'timeout', error: caught };
      }
      if (aborted) {
        return { status: 'aborted', error: caught };
      }
      return { status: 'failed', error: caught };
    } finally {
      for (const cleanup of cleanups) {
        cleanup();
      }
    }
  }

  /**
   * Mount a patch for real and return an idempotent disposer that rolls back
   * every registered effect (LIFO). A partial mount failure rolls back what was
   * already mounted before rethrowing.
   */
  async applyPermanentPatch(patch: EightSurfacePatch): Promise<SurfacePatchDisposer> {
    this.assertNotDisposed();
    assertNonEmptyString(patch === undefined ? undefined : patch.id, 'patch.id');
    if (this.permanentPatches.has(patch.id)) {
      throw new CordisSeamError('Permanent patch "' + patch.id + '" is already applied.', {
        code: 'permanent_patch_conflict',
        patchId: patch.id
      });
    }

    const branchId = 'permanent-' + patch.id;
    const namespace = buildBranchNamespace(this.namespacePrefix, branchId);
    const frozenPatch = cloneAndFreezePatch(patch, branchId);
    const registry = new DisposableRegistry();
    const record: PermanentPatchRecord = { registry, namespace, active: true };
    this.permanentPatches.set(patch.id, record);

    try {
      const isInvariant =
        frozenPatch.guidance === 'guidance_free' ||
        frozenPatch.origin === 'invariant';
      await mountEightSurfaces(
        this.host,
        frozenPatch,
        {
          sessionId: patch.sessionId,
          branchId,
          namespace,
          patchId: patch.id,
          origin: frozenPatch.origin,
          guidance: frozenPatch.guidance,
          role: isInvariant ? 'invariant' : 'domain',
          allowAdvice: !isInvariant,
          // ADR 0006 D-P4-4: a permanent patch is the ONLY host-class mount.
          // It carries the grant provenance with it; reaching this line means
          // the execution profile's patch permission already allowed it (the
          // orchestrator gates the call site), so the mount is a named
          // authorization rather than an ambient default.
          mountScope: 'host',
          hostScopeGrant: 'permanent-patch:' + patch.id
        },
        { registry, enabledSurfaces: this.enabledSurfaces }
      );
    } catch (caught) {
      record.active = false;
      this.permanentPatches.delete(patch.id);
      await registry.disposeAll();
      if (caught instanceof CordisSeamError) {
        throw caught;
      }
      throw new CordisSeamError('Failed to apply permanent patch "' + patch.id + '".', {
        code: 'permanent_mount_failed',
        patchId: patch.id,
        cause: caught
      });
    }

    const disposer: SurfacePatchDisposer = {
      patchId: patch.id,
      get active(): boolean {
        return record.active && !record.registry.isDisposed;
      },
      dispose: async (): Promise<void> => {
        if (!record.active) {
          return;
        }
        record.active = false;
        this.permanentPatches.delete(patch.id);
        const failures = await record.registry.disposeAll();
        if (failures.length > 0) {
          const first = failures[0];
          throw new CordisSeamError(
            'Failed to roll back ' + failures.length + ' effect(s) of patch "' + patch.id + '".',
            {
              code: 'dispose_failed',
              patchId: patch.id,
              cause: first === undefined ? undefined : first.error,
              details: { labels: failures.map((failure) => failure.label) }
            }
          );
        }
      }
    };

    return disposer;
  }

  /** Snapshot of branches that are currently executing. */
  listActiveBranches(): readonly BranchSummary[] {
    return [...this.activeBranches.values()]
      .sort((left, right) => left.seq - right.seq)
      .map((record) => ({
        branchId: record.branchId,
        sessionId: record.sessionId,
        namespace: record.namespace,
        patchId: record.patchId,
        mountedSurfaces: record.mountedSurfaces.slice(),
        startedAt: record.startedAt
      }));
  }

  /** Abort and dispose every branch, then roll back every permanent patch. */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    const branches = [...this.activeBranches.values()];
    this.activeBranches.clear();
    for (const branch of branches) {
      this.onDiagnostic?.('branch_disposed_by_manager', { branchId: branch.branchId });
      branch.resources.abort(
        new CordisSeamError('Branch aborted because the seam manager was disposed.', {
          code: 'manager_disposed',
          branchId: branch.branchId
        })
      );
    }
    await Promise.all(branches.map((branch) => this.disposeBranchRecord(branch)));

    const patches = [...this.permanentPatches.entries()];
    this.permanentPatches.clear();
    for (const [patchId, record] of patches) {
      record.active = false;
      const failures = await record.registry.disposeAll();
      if (failures.length > 0) {
        this.onDiagnostic?.('permanent_patch_cleanup_failed', {
          patchId,
          labels: failures.map((failure) => failure.label)
        });
      }
    }
  }

  private async disposeBranchRecord(record: ActiveBranchRecord): Promise<void> {
    const failures = await record.resources.dispose();
    if (failures.length > 0) {
      this.onDiagnostic?.('branch_cleanup_failed', {
        branchId: record.branchId,
        labels: failures.map((failure) => failure.label)
      });
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new CordisSeamError('CordisSeamManager has been disposed.', { code: 'manager_disposed' });
    }
  }
}

/** Factory mirroring the constructor for integrator wiring. */
export function createCordisSeamManager(options: CordisSeamManagerOptions): CordisSeamManager {
  return new CordisSeamManager(options);
}
