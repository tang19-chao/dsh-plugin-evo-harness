/**
 * Host-neutral Cordis capability seams.
 *
 * This module never imports the DSH host runtime. It describes the capability
 * seams the plugin needs as one structural adapter (ARCHITECTURE.md section 3)
 * plus an in-memory implementation used by unit tests. A real host adapter -
 * wired by src/index.ts from a forked ctx - supplies ctx.fork(), prompt segment
 * registration, guardrails/permissions, tool-description patching, dynamic skill
 * mounting, sandbox script mounting, dynamic subagent registration and tool-loop
 * middleware behind this interface. Every seam returns an idempotent disposer.
 */
import type {
  DynamicSkillSpec,
  HarnessComponentKey,
  MiddlewareSpec,
  ScriptArtifactSpec,
  SubagentSpec,
  ToolGuidanceExample,
  ToolPrecondition
} from '../types/contracts';

/** Idempotent disposer returned by a host seam. */
export interface HostDisposer {
  dispose(): void | Promise<void>;
}

/** Request for a forked Cordis child context (ctx.fork()). */
export interface HostForkRequest {
  readonly branchId: string;
  readonly sessionId: string;
  readonly namespace: string;
}

/** Handle for a forked Cordis child context. */
export interface HostBranchHandle {
  readonly branchId: string;
  readonly namespace: string;
  readonly contextId: string;
  readonly isDisposed: boolean;
  dispose(): Promise<void>;
}

/** Fields common to every surface mount request. */
export interface HostSurfaceSpecBase {
  readonly surfaceId: string;
  readonly branchId: string;
  readonly sessionId: string;
  readonly namespace: string;
}

/** Surface 1: system prompt segment registration. */
export interface HostPromptSegmentSpec extends HostSurfaceSpecBase {
  readonly segment: string;
  readonly mode: 'append' | 'replace';
  readonly content: string;
  readonly priority?: number;
}

/** Surface 2: guardrails / permissions rules. */
export interface HostGuardrailsSpec extends HostSurfaceSpecBase {
  readonly appendRules: readonly string[];
  readonly forbiddenActions: readonly string[];
  readonly formatContract?: string;
  readonly toolPreconditions: readonly ToolPrecondition[];
}

/** Surface 3: branch-scoped memory view. */
export interface HostMemoryScopeSpec extends HostSurfaceSpecBase {
  readonly scopedViewId: string;
  readonly workingNotes: readonly string[];
  readonly recallTags: readonly string[];
}

/** Surface 4: tool description patching. */
export interface HostToolGuidanceSpec extends HostSurfaceSpecBase {
  readonly descriptions: Readonly<Record<string, string>>;
  readonly priorityOrder?: readonly string[];
  readonly examples?: readonly ToolGuidanceExample[];
}

/** Surface 5: dynamic skill mounting. */
export interface HostSkillsSpec extends HostSurfaceSpecBase {
  readonly skills: readonly DynamicSkillSpec[];
}

/** Surface 6: sandbox script mounting. */
export interface HostScriptsSpec extends HostSurfaceSpecBase {
  readonly scripts: readonly ScriptArtifactSpec[];
}

/** Surface 7: dynamic subagent registration. */
export interface HostSubagentsSpec extends HostSurfaceSpecBase {
  readonly agents: readonly SubagentSpec[];
}

/** Surface 8: tool-loop middleware mounting. */
export interface HostMiddlewareSpec extends HostSurfaceSpecBase {
  readonly middleware: readonly MiddlewareSpec[];
}

/** Request for a branch-private sandbox workspace. */
export interface HostSandboxRequest {
  readonly branchId: string;
  readonly sessionId: string;
  readonly namespace: string;
  readonly patchId: string;
}

/** Handle for a branch-private sandbox workspace or git worktree. */
export interface HostSandboxHandle {
  readonly id: string;
  readonly branchId: string;
  readonly path: string | null;
  readonly isDisposed: boolean;
  dispose(): Promise<void>;
}

/**
 * The eight capability seams plus branch forking and sandbox allocation.
 * Every method is optional so a test can mock exactly one seam, but requesting
 * a surface whose seam is missing fails loudly (see seam_unavailable).
 */
export interface CordisHostAdapter {
  forkBranch?(request: HostForkRequest): Promise<HostBranchHandle>;
  registerPromptSegment?(spec: HostPromptSegmentSpec): Promise<HostDisposer>;
  registerGuardrails?(spec: HostGuardrailsSpec): Promise<HostDisposer>;
  registerMemoryScope?(spec: HostMemoryScopeSpec): Promise<HostDisposer>;
  patchToolGuidance?(spec: HostToolGuidanceSpec): Promise<HostDisposer>;
  mountSkills?(spec: HostSkillsSpec): Promise<HostDisposer>;
  mountScripts?(spec: HostScriptsSpec): Promise<HostDisposer>;
  registerSubagents?(spec: HostSubagentsSpec): Promise<HostDisposer>;
  mountMiddleware?(spec: HostMiddlewareSpec): Promise<HostDisposer>;
  acquireSandbox?(request: HostSandboxRequest): Promise<HostSandboxHandle>;
}

/** Operations an in-memory host records and can be told to fail. */
export const HOST_OPERATIONS = [
  'fork_branch',
  'prompt_segment',
  'guardrails',
  'memory_scope',
  'tool_guidance',
  'skills',
  'scripts',
  'subagents',
  'middleware',
  'sandbox'
] as const;
export type HostOperation = (typeof HOST_OPERATIONS)[number];

/** Mapping from recorded operation to the surface it mounts. */
export const HOST_OPERATION_SURFACE: Readonly<Partial<Record<HostOperation, HarnessComponentKey>>> = {
  prompt_segment: 'system_prompt',
  guardrails: 'guardrails',
  memory_scope: 'memory',
  tool_guidance: 'tool_guidance',
  skills: 'skills',
  scripts: 'scripts',
  subagents: 'subagents',
  middleware: 'plugins'
};

/** One reversible effect recorded by the in-memory host. */
export interface RecordedHostEffect {
  readonly seq: number;
  readonly operation: HostOperation;
  readonly surface: HarnessComponentKey | null;
  readonly surfaceId: string | null;
  readonly branchId: string;
  readonly namespace: string;
  readonly active: boolean;
  readonly spec: unknown;
}

/** In-memory host adapter with introspection used by unit tests. */
export interface InMemoryCordisHost extends CordisHostAdapter {
  readonly effects: readonly RecordedHostEffect[];
  readonly sandboxes: readonly HostSandboxHandle[];
  readonly forkRequests: readonly HostForkRequest[];
  activeEffects(namespace?: string): readonly RecordedHostEffect[];
  effectsFor(namespace: string): readonly RecordedHostEffect[];
  callCount(operation: HostOperation): number;
  activeCount(operation: HostOperation): number;
  failNext(operation: HostOperation, times?: number, error?: unknown): void;
  reset(): void;
}

interface MutableEffect {
  seq: number;
  operation: HostOperation;
  surface: HarnessComponentKey | null;
  surfaceId: string | null;
  branchId: string;
  namespace: string;
  active: boolean;
  spec: unknown;
}

interface RecordedSeam {
  readonly effect: MutableEffect;
  readonly disposer: HostDisposer;
  readonly deactivate: () => void;
}

/**
 * Deterministic in-memory host used by unit tests and as a reference adapter.
 * It records every effect per namespace and can be instructed to fail the next
 * call of a given operation, which is how rollback paths are exercised.
 */
export function createInMemoryCordisHost(): InMemoryCordisHost {
  const effects: MutableEffect[] = [];
  const sandboxes: HostSandboxHandle[] = [];
  const forkRequests: HostForkRequest[] = [];
  const calls = new Map<HostOperation, number>();
  const pendingFailures = new Map<HostOperation, { remaining: number; error: unknown }>();
  let effectSeq = 0;
  let forkSeq = 0;
  let sandboxSeq = 0;

  const take = (operation: HostOperation): void => {
    calls.set(operation, (calls.get(operation) ?? 0) + 1);
    const pending = pendingFailures.get(operation);
    if (pending !== undefined && pending.remaining > 0) {
      pending.remaining -= 1;
      throw pending.error instanceof Error
        ? pending.error
        : new Error('in-memory host failure for ' + operation);
    }
  };

  const recordSeam = (
    operation: HostOperation,
    params: { surfaceId?: string; branchId: string; namespace: string; spec: unknown }
  ): RecordedSeam => {
    effectSeq += 1;
    const effect: MutableEffect = {
      seq: effectSeq,
      operation,
      surface: HOST_OPERATION_SURFACE[operation] ?? null,
      surfaceId: params.surfaceId ?? null,
      branchId: params.branchId,
      namespace: params.namespace,
      active: true,
      spec: params.spec
    };
    effects.push(effect);
    let disposed = false;
    const deactivate = (): void => {
      if (disposed) {
        return;
      }
      disposed = true;
      effect.active = false;
    };
    const disposer: HostDisposer = { dispose: () => deactivate() };
    return { effect, disposer, deactivate };
  };

  const seam =
    (operation: HostOperation) =>
    async (spec: { surfaceId: string; branchId: string; namespace: string }): Promise<HostDisposer> => {
      take(operation);
      return recordSeam(operation, {
        surfaceId: spec.surfaceId,
        branchId: spec.branchId,
        namespace: spec.namespace,
        spec
      }).disposer;
    };

  const host: InMemoryCordisHost = {
    forkBranch: async (request: HostForkRequest): Promise<HostBranchHandle> => {
      take('fork_branch');
      forkRequests.push({ ...request });
      forkSeq += 1;
      const recorded = recordSeam('fork_branch', {
        branchId: request.branchId,
        namespace: request.namespace,
        spec: { ...request }
      });
      let disposed = false;
      return {
        branchId: request.branchId,
        namespace: request.namespace,
        contextId: 'ctx-' + forkSeq,
        get isDisposed(): boolean {
          return disposed;
        },
        dispose: async (): Promise<void> => {
          if (disposed) {
            return;
          }
          disposed = true;
          recorded.deactivate();
        }
      };
    },
    registerPromptSegment: seam('prompt_segment'),
    registerGuardrails: seam('guardrails'),
    registerMemoryScope: seam('memory_scope'),
    patchToolGuidance: seam('tool_guidance'),
    mountSkills: seam('skills'),
    mountScripts: seam('scripts'),
    registerSubagents: seam('subagents'),
    mountMiddleware: seam('middleware'),
    acquireSandbox: async (request: HostSandboxRequest): Promise<HostSandboxHandle> => {
      take('sandbox');
      sandboxSeq += 1;
      const recorded = recordSeam('sandbox', {
        branchId: request.branchId,
        namespace: request.namespace,
        spec: { ...request }
      });
      let disposed = false;
      const handle: HostSandboxHandle = {
        id: 'sandbox-' + sandboxSeq,
        branchId: request.branchId,
        path: null,
        get isDisposed(): boolean {
          return disposed;
        },
        dispose: async (): Promise<void> => {
          if (disposed) {
            return;
          }
          disposed = true;
          recorded.deactivate();
        }
      };
      sandboxes.push(handle);
      return handle;
    },
    get effects(): readonly RecordedHostEffect[] {
      return effects;
    },
    get sandboxes(): readonly HostSandboxHandle[] {
      return sandboxes;
    },
    get forkRequests(): readonly HostForkRequest[] {
      return forkRequests;
    },
    activeEffects: (namespace?: string): readonly RecordedHostEffect[] =>
      effects.filter(
        (effect) => effect.active && (namespace === undefined || effect.namespace === namespace)
      ),
    effectsFor: (namespace: string): readonly RecordedHostEffect[] =>
      effects.filter((effect) => effect.namespace === namespace),
    callCount: (operation: HostOperation): number => calls.get(operation) ?? 0,
    activeCount: (operation: HostOperation): number =>
      effects.filter((effect) => effect.active && effect.operation === operation).length,
    failNext: (operation: HostOperation, times = 1, error?: unknown): void => {
      pendingFailures.set(operation, {
        remaining: times,
        error: error ?? new Error('in-memory host failure for ' + operation)
      });
    },
    reset: (): void => {
      effects.length = 0;
      sandboxes.length = 0;
      forkRequests.length = 0;
      calls.clear();
      pendingFailures.clear();
    }
  };

  return host;
}
