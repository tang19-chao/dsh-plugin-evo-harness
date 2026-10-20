/**
 * Branch isolation: forked Cordis child context, branch namespace, abort/timeout
 * wiring and the branch-owned resource set.
 *
 * One createIsolatedBranch() call owns exactly one DisposableRegistry. Every
 * reversible resource acquired for the branch (sandbox workspace, forked child
 * context, abort listeners, timeout timer, mounted surfaces) is registered in
 * that registry, so success, failure, timeout and abort all end in one LIFO
 * unwind. The patch handed to the branch is deep-cloned and deep-frozen first,
 * so concurrent branches never share mutable edits.
 */
import type { EightSurfacePatch, ProbeTask } from '../types/contracts';
import {
  DisposableRegistry,
  type DisposalFailure
} from './disposable-registry';
import { CordisSeamError, CordisSeamTimeoutError } from './errors';
import type { CordisHostAdapter, HostBranchHandle, HostSandboxHandle } from './host-adapter';
import { cloneAndFreezePatch, normalizeSurfaceKeys } from './patch-utils';
import type { HarnessComponentKey } from '../types/contracts';

/** Default namespace prefix; callers normally pass config.memoryBridge.namespacePrefix. */
export const DEFAULT_NAMESPACE_PREFIX = 'harness2';

/** Build the virtual namespace that isolates one probe branch. */
export function buildBranchNamespace(prefix: string | undefined, branchId: string): string {
  const normalized =
    prefix === undefined || prefix.trim().length === 0 ? DEFAULT_NAMESPACE_PREFIX : prefix.trim();
  return normalized + ':probe_' + branchId;
}

/** Monotonic, collision-resistant branch id factory. */
export function createBranchIdFactory(prefix = 'br'): () => string {
  let counter = 0;
  return (): string => {
    counter += 1;
    return prefix + '-' + counter.toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  };
}

const defaultBranchIds = createBranchIdFactory();

/** Options for createIsolatedBranch. */
export interface CreateIsolatedBranchOptions {
  readonly host: CordisHostAdapter;
  readonly sessionId: string;
  readonly task: ProbeTask;
  readonly patch: EightSurfacePatch;
  readonly branchId?: string;
  readonly namespacePrefix?: string;
  readonly timeoutMs?: number;
  readonly parentSignal?: AbortSignal;
  readonly now?: () => number;
  readonly createBranchId?: () => string;
}

/** Branch-scoped context and resources; dispose() is idempotent. */
export interface IsolatedBranchResources {
  readonly branchId: string;
  readonly sessionId: string;
  readonly namespace: string;
  readonly patchId: string;
  readonly startedAt: number;
  readonly frozenPatch: EightSurfacePatch;
  readonly registry: DisposableRegistry;
  readonly signal: AbortSignal;
  readonly aborted: boolean;
  readonly hostHandle: HostBranchHandle | null;
  readonly sandbox: HostSandboxHandle | null;
  abort(reason?: unknown): void;
  dispose(): Promise<readonly DisposalFailure[]>;
}

function linkAbort(
  controller: AbortController,
  parentSignal: AbortSignal | undefined,
  registry: DisposableRegistry
): void {
  if (parentSignal === undefined) {
    return;
  }
  if (parentSignal.aborted) {
    controller.abort(parentSignal.reason);
    return;
  }
  const onAbort = (): void => {
    controller.abort(parentSignal.reason);
  };
  parentSignal.addEventListener('abort', onAbort, { once: true });
  registry.register('parent-abort-listener', () => {
    parentSignal.removeEventListener('abort', onAbort);
  });
}

function registerTimeout(
  controller: AbortController,
  timeoutMs: number,
  registry: DisposableRegistry,
  branchId: string
): void {
  const timer = setTimeout(() => {
    controller.abort(
      new CordisSeamTimeoutError('Branch ' + branchId + ' exceeded its ' + timeoutMs + 'ms budget.', {
        branchId
      })
    );
  }, timeoutMs);
  const unref = (timer as { unref?: () => void }).unref;
  if (typeof unref === 'function') {
    unref.call(timer);
  }
  registry.register('branch-timeout-timer', () => {
    clearTimeout(timer);
  });
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

/**
 * Fork an isolated branch: allocate the branch resource set, fork the host child
 * context, acquire a branch-private sandbox and wire abort/timeout signalling.
 * On setup failure every already-acquired resource is disposed before throwing.
 */
export async function createIsolatedBranch(
  options: CreateIsolatedBranchOptions
): Promise<IsolatedBranchResources> {
  const sessionId = assertNonEmptyString(options.sessionId, 'sessionId');
  const timeoutMs = options.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
    throw new CordisSeamError('timeoutMs must be a non-negative finite number.', {
      code: 'invalid_request',
      details: { timeoutMs }
    });
  }

  const branchId =
    options.branchId !== undefined && options.branchId.length > 0
      ? options.branchId
      : (options.createBranchId ?? defaultBranchIds)();
  const namespace = buildBranchNamespace(options.namespacePrefix, branchId);
  const now = options.now ?? Date.now;
  const startedAt = now();

  const registry = new DisposableRegistry();
  const controller = new AbortController();
  const frozenPatch = cloneAndFreezePatch(options.patch, branchId);

  linkAbort(controller, options.parentSignal, registry);
  if (timeoutMs !== undefined) {
    registerTimeout(controller, timeoutMs, registry, branchId);
  }

  let hostHandle: HostBranchHandle | null = null;
  let sandbox: HostSandboxHandle | null = null;

  try {
    if (options.host.forkBranch !== undefined) {
      hostHandle = await options.host.forkBranch({ branchId, sessionId, namespace });
      registry.add('host-branch:' + branchId, hostHandle);
    }
    if (options.host.acquireSandbox !== undefined) {
      sandbox = await options.host.acquireSandbox({
        branchId,
        sessionId,
        namespace,
        patchId: frozenPatch.id
      });
      registry.add('sandbox:' + branchId, sandbox);
    }
  } catch (error) {
    const failures = await registry.disposeAll();
    throw new CordisSeamError(
      'Failed to set up isolated branch "' + branchId + '".',
      {
        code: 'branch_setup_failed',
        branchId,
        patchId: frozenPatch.id,
        cause: error,
        details: { cleanupFailures: failures.map((failure) => failure.label) }
      }
    );
  }

  const resources: IsolatedBranchResources = {
    branchId,
    sessionId,
    namespace,
    patchId: frozenPatch.id,
    startedAt,
    frozenPatch,
    registry,
    signal: controller.signal,
    get aborted(): boolean {
      return controller.signal.aborted;
    },
    hostHandle,
    sandbox,
    abort: (reason?: unknown): void => {
      controller.abort(reason);
    },
    dispose: (): Promise<readonly DisposalFailure[]> => registry.disposeAll()
  };

  return resources;
}

/** Surface keys a branch will mount, derivable before mounting for planning. */
export function plannedSurfaceKeys(
  keys: readonly HarnessComponentKey[]
): readonly HarnessComponentKey[] {
  return normalizeSurfaceKeys(keys);
}
