/**
 * dsh-plugin-evo-harness Cordis plugin entrypoint (integrator-owned).
 *
 * Exports the standard Cordis plugin shape:
 *   - apply(ctx, config)   registers the /evo command and the auto_fallback hook
 *   - default export       { name, apply }
 *
 * The plugin never assumes host internals it cannot see. Every host capability is
 * probed structurally at mount time:
 *   - ctx.registerCommand / ctx.command   -> /evo slash command
 *   - ctx.on                              -> auto_fallback failure events, and
 *                                            (with a DSH service present) the
 *                                            real hook adapter
 *   - ctx.prompt/tools/skills/sandbox/subagents/middleware/evoMemory/fork
 *                                         -> the eight Cordis capability seams
 *   - ctx.logger / ctx.provide            -> diagnostics and service exposure
 * The host adapter is chosen in capability order: an injected adapter wins, then
 * real DSH hook middleware, then the structural seams, and finally an in-process
 * in-memory adapter so the lifecycle still runs deterministically. The chosen
 * source is reported as plugin.hostAdapterSource and the fallback is recorded in
 * plugin.diagnostics; the in-memory adapter never pretends to be a real sandbox. */
import {
  CONFIG_SCHEMA_VERSION,
  parseEvoHarnessConfig,
  validateEvoHarnessConfig,
  type EvoHarnessConfig
} from './config';
import {
  createCordisSeamManager,
  createDshHookHostAdapter,
  createInMemoryCordisHost,
  detectDshHookHost,
  type CordisHostAdapter,
  type DshHookDetection,
  type DshHookHostAdapter,
  type HostDisposer
} from './cordis-seams';
import {
  createMemoryBridge,
  type McpClient
} from './memory-bridge';
import {
  createAnonymousComposer,
  createDualTrackProposer,
  createEvidenceReflector
} from './harness2';
import {
  createActivePolicy,
  createActivePolicyFromDefaults,
  createDefaultPolicy,
  createDiscoveryTreePool,
  createFailureTaxonomy,
  createModelPolicyGenerator,
  createOfflineDreamer,
  createSurrogateScorer,
  generateCandidatePolicies,
  resolveJitPerturbationGrid,
  type OfflineDreamerOptions,
  type PolicyGenerator
} from './dream-rsi';
import {
  createEvoHarnessOrchestrator,
  type EvoHarnessOrchestrator,
  type EvoHarnessOrchestratorDeps
} from './orchestrator';
import type {
  PersistenceRuntime
} from './persistence';
import {
  aggregateExperienceStats,
  createJitRl,
  createJitActivePolicy,
  halfLifeMsFromConfig,
  jitMetaEnabled,
  type BridgeMirrorStore,
  type HostAdvisor,
  type JitActivePolicy,
  type JitMirrorMcpClient,
  type JitReplayHook,
  type JitRl,
  type JitRlDiagnostic
} from './jitrl';
import {
  createHostToolExperienceCollector,
  type HostToolExperienceCollector
} from './jitrl/host-tool-experience';
import {
  executeJitCommand,
  splitJitArgs,
  type JitCommandController,
  type JitCommandResult,
  type JitRecentDecision,
  type JitResetDrop
} from './jitrl/commands';
import type {
  DerivedCacheStats,
  JitBatchDiagnostics
} from './jitrl/jit-active-policy';
import {
  createAgentLoopExecutor,
  type AgentLoopAdapters
} from './dsh-bridge';
import type {
  BranchExecutor,
  DreamReplayReport,
  EvoHarnessRunRequest,
  ExperienceRecord,
  IActivePolicy,
  IExperienceStore,
  IOfflineDreamer,
  EvoHarnessRunResult,
  IModelAdapter,
  JitLevel,
  MetaSearchPolicy,
  MemoryScope,
  ProbeExecutionResult,
  ProbeTask,
  TriggerMode
} from './types/contracts';
/** Name registered with the host; hosts render it as /evo. */
export const EVO_COMMAND_NAME = 'evo';
/** Host events the auto_fallback hook subscribes to by default. */
export const DEFAULT_AUTO_FALLBACK_EVENTS = ['task:failed',
  'tool:error'] as const;
/** Minimal structural view of a Cordis plugin context (all members optional). */
export interface CordisPluginContext {
  readonly logger?: {
    debug?(message: string): void;
    info?(message: string): void;
    warn?(message: string): void;
    error?(message: string): void;
  };
  readonly registerCommand?: (name: string,
    handler: CordisCommandHandler) => unknown;
  readonly command?: (name: string,
    handler: CordisCommandHandler) => unknown;
  readonly addCommand?: (name: string,
    handler: CordisCommandHandler) => unknown;
  readonly on?: (event: string,
    handler: (payload: unknown) => unknown) => unknown;
  readonly provide?: (name: string,
    value: unknown) => unknown;
  readonly config?: unknown;
  readonly [key: string]: unknown;
}
/** Slash-command handler signature accepted by the structural context. */
export type CordisCommandHandler = (args?: unknown,
  context?: unknown) => unknown | Promise<unknown>;
/** Host-neutral plugin options; also accepts a raw cordis.yml plugin section. */
export interface EvoHarnessPluginOptions {
  /** Raw plugin configuration (parsed and validated by src/config.ts). */
  readonly config?: unknown;
  /** LLM boundary used by Harness2 propose/compose/reflect. */
  readonly model?: IModelAdapter;
  /** Cordis capability seams; when absent they are derived from ctx. */
  readonly host?: CordisHostAdapter;
  /** Mounted MCP memory clients (Mem0, official KG, dsh-memory, ...). */
  readonly clients?: readonly McpClient[];
  /** Deferred client provider for clients mounted after start-up. */
  readonly listClients?: () => Promise<readonly McpClient[]>;
  /** Host task runner executed inside each isolated probe branch. */
  readonly runBranch?: BranchExecutor;
  /** Override any collaborator (used by deterministic end-to-end tests). */
  readonly deps?: Partial<EvoHarnessOrchestratorDeps>;
  /**
   * Already-created durable TreePool / policy / counter storage, from
   * `createPersistenceRuntime()`. Passing it wires all three into the
   * orchestrator; the plugin then owns flush-on-dispose. Persistence stays off
   * by default so a bare mount writes nothing to disk. (The runtime is created
   * asynchronously, so a host resolves it before calling apply().)   */
  readonly persistence?: PersistenceRuntime;
  /**
   * Absolute path of the JitRL experience log (JSONL). When persistence is
   * enabled its data directory is used automatically; this option overrides it
   * and lets a test or a custom host place the log elsewhere. Absent (and no
   * persistence) keeps the experience store in memory only.   */
  readonly experienceFilePath?: string;
  /**
   * Run the cold-start backfill of L1 experiences from the persisted tree pool.
   * Defaults to true; it only has an effect when persistence is enabled, because
   * an in-memory pool is empty at start up anyway.   */
  readonly backfillFromTreePool?: boolean;
  /**
   * Adapters for the multi-step agent probe executor. When no `runBranch` is
   * injected, the plugin uses this executor; when both are present `runBranch`
   * wins because it is the explicit host override.   */
  readonly agentLoop?: AgentLoopAdapters;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly commitScope?: (sessionId: string) => MemoryScope;
  /** Subscribe failure events for auto_fallback; defaults to true. */
  readonly registerAutoFallback?: boolean;
  readonly autoFallbackEvents?: readonly string[];
  readonly applyWinningPatch?: boolean;
  /**
   * Injected MCP client used by the JitRL aggregate-statistics mirror
   * (plan section 7.2). Only touched when
   * `config.jitrl.store.mirrorToMemoryBridge` is true; absent keeps the mirror
   * degraded with zero writes. Tests and hosts pass their own client so no
   * concrete MCP implementation is imported by the plugin.   */
  readonly mirrorClient?: JitMirrorMcpClient;
  /**
   * Injected L3 host advisor (plan section 3.3). Defaults to one built from the
   * JitRL kernel; a host may replace it for custom evidence sources. The
   * advisor is only attached to the hook adapter when
   * `config.jitrl.hostAdvisor.enabled` is true, so the default stays silent.   */
  readonly hostAdvisor?: HostAdvisor;
  /**
   * Probe branch/session an attached L3 advisor is scoped to. A dispatch that
   * names a different branch or session is left untouched. Empty means the
   * advisor is host-local (every dispatch in this host).   */
  readonly hostAdvisorScope?: {
    readonly branchId?: string;
    readonly sessionId?: string;
    readonly namespace?: string;
  };
}
/** Attribute of the mounted host adapter, in probing order. */
export type EvoHarnessHostAdapterSource = 'injected' | 'dsh-hooks' | 'context' | 'in-memory';
/**
 * One Dream-RSI x JitRL replay observation (plan section 7.3, Phase 4).
 *
 * Reported through the real plugin path: the wired dreamer records the JitRL
 * hyperparameters of every policy it replayed, so a host can verify that the
 * perturbed candidate jit values actually reached replay instead of trusting a
 * unit test that instantiates the hook directly. */
export interface EvoHarnessDreamJitStatus {
  /** config.jitrl.dream.hyperparamPerturbation in force. */
  readonly hyperparamPerturbation: boolean;
  /** config.jitrl.dream.driftRho forwarded to the replay hook. */
  readonly driftRho: number;
  /** True when a JitReplayHook is wired into the plugin's dreamer. */
  readonly hookAttached: boolean;
  /** Last dream replay observed through the wired dreamer. */
  readonly lastReplay?: {
    readonly ranAt: number;
    /** Frontier nodes the hook was invoked for. */
    readonly hookCalls: number;
    readonly improved: boolean;
    readonly selectedPolicyId: string;
    /** Per-replayed-policy jit hyperparameters, sorted by policy id. */
    readonly candidates: readonly {
      readonly policyId: string;
      readonly beta: number;
      readonly lambda: number;
      /** Drift down-weight factor in force for this policy's replay. */
      readonly driftRho: number;
    }[];
    /** jit of the hot-swapped policy, present only when a swap happened. */
    readonly appliedJit?: {
      readonly beta: number;
      readonly lambda: number
    };
  };
}
/** L3 host-advisor visibility (plan section 3.3, Phase 5). */
export interface EvoHarnessHostAdvisorStatus {
  readonly enabled: boolean;
  readonly mode: 'advisory' | 'gate';
  /** True when an advisor is attached to the real hook adapter. */
  readonly attached: boolean;
  /** False while `/evo jit off` keeps the advisor gated (repair F1). */
  readonly runtimeEnabled: boolean;
  readonly advisory: number;
  readonly ask: number;
  readonly noop: number;
  readonly skipped: number;
  readonly diagnostics: readonly string[];
}
/** Aggregate-statistics mirror visibility (plan section 7.2, Phase 5). */
export interface EvoHarnessMirrorStatus {
  readonly enabled: boolean;
  /** Plugin-side mirror() invocations (0 while the switch is off). */
  readonly calls: number;
  /** Rows the backend accepted across calls. */
  readonly writes: number;
  readonly degraded: boolean;
  /** Timestamp of the newest mirrored snapshot, 0 when nothing was mirrored. */
  readonly lastWritten: number;
}
/**
 * JitRL status exposed on the plugin handle (plan section 8 Phase 2). Reported
 * even when the feature is disabled, so a host can always read the switch state
 * without probing the wrapped policy. */
export interface EvoHarnessJitRlStatus {
  /** True only when config.jitrl.enabled AND levels include 'meta'. */
  readonly enabled: boolean;
  /** Active JitRL levels from configuration. */
  readonly levels: readonly string[];
  /** Experience records currently held (all levels). */
  readonly storeSize: number;
  /** Records written by the cold-start backfill in this process (0 if none). */
  readonly backfilled: number;
  /** True when a component degraded to a safe fallback (memory store, no wrapper). */
  readonly degraded: boolean;
  /** Payload-free notices from the JitRL kernel and the decorator. */
  readonly diagnostics: readonly string[];
  /** Live derived-policy cache counters from the L1 decorator (additive, P3-E). */
  readonly cacheStats?: DerivedCacheStats;
  /** Last 10 L1 decisions, newest first (additive, P3-E); always an array when enabled. */
  readonly recentDecisions?: readonly JitRecentDecision[];
  /** Dream-RSI x JitRL replay visibility (additive, Phase 4). */
  readonly dream?: EvoHarnessDreamJitStatus;
  /** L3 host-advisor visibility (additive, Phase 5). */
  readonly hostAdvisor?: EvoHarnessHostAdvisorStatus;
  /** Memory-bridge statistics mirror visibility (additive, Phase 5). */
  readonly mirror?: EvoHarnessMirrorStatus;
  /**
   * Host-tool experience records currently held (additive, H2 repair). This is
   * the evidence the L3 advisor retrieves; before the repair it was always 0 in
   * a real plugin.
   */
  readonly hostToolExperiences?: number;
}
/** /evo jit command result carried by a synthetic skipped-run summary. */
export type EvoHarnessCommandRunResult = EvoHarnessRunResult & {
  readonly jitCommand?: JitCommandResult;
};
/** Mounted plugin handle returned by apply/createEvoHarnessPlugin. */
export interface EvoHarnessPlugin {
  readonly name: string;
  readonly config: EvoHarnessConfig;
  readonly orchestrator: EvoHarnessOrchestrator;
  readonly diagnostics: readonly string[];
  readonly registeredCommands: readonly string[];
  readonly registeredEvents: readonly string[];
  readonly hostAdapterSource: EvoHarnessHostAdapterSource;
  /**
   * JitRL status. When the feature is off this reports { enabled: false } and
   * the plugin behaves exactly as it did before JitRL existed.   */
  readonly jitrl: EvoHarnessJitRlStatus;
  run(request: EvoHarnessRunRequest): Promise<EvoHarnessRunResult>;
  runFromCommand(args: unknown,
    context?: unknown): Promise<EvoHarnessCommandRunResult>;
  handleFallbackEvent(payload: unknown): Promise<EvoHarnessRunResult | null>;
  makeTask(input: {
    readonly prompt: string;
    readonly id?: string;
    readonly taskSignature?: string;
    readonly contextTags?: readonly string[];
  }): ProbeTask;
  dispose(): Promise<void>;
} function asRecord(value: unknown): Record<string,
  unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  } return value as Record<string,
    unknown>;
} function pickFunction(source: Record<string,
  unknown> | undefined,
  names: readonly string[]): ((...args: unknown[]) => unknown) | undefined {
  if (source === undefined) {
    return undefined;
  } for (const name of names) {
    const candidate = source[name];
    if (typeof candidate === 'function') {
      return candidate as (...args: unknown[]) => unknown;
    }
  } return undefined;
} function pickCapability(source: Record<string,
  unknown> | undefined,
  objectName: string,
  methodNames: readonly string[]): ((...args: unknown[]) => unknown) | undefined {
  const holder = source === undefined ? undefined : asRecord(source[objectName]);
  return pickFunction(holder,
    methodNames);
} function normalizeDisposer(result: unknown): HostDisposer {
  if (typeof result === 'function') {
    return {
      dispose: () => (result as () => void)()
    };
  } const record = asRecord(result);
  if (record !== undefined && typeof record.dispose === 'function') {
    const dispose = record.dispose as () => void | Promise<void>;
    return {
      dispose: () => dispose.call(result)
    };
  } return {
    dispose: () => undefined
  };
}
/**
 * Best-effort structural adapter over the documented Cordis capability seams.
 * Missing capabilities are omitted, so mounting that surface fails loudly with
 * seam_unavailable instead of silently pretending the surface exists. */
export function createCordisHostFromContext(ctx: unknown): CordisHostAdapter {
  const root = asRecord(ctx);
  const adapter: Record<string,
    unknown> = {
  };
  const fork = pickFunction(root,
    ['fork',
      'forkBranch',
      'forkContext']);
  if (fork !== undefined) {
    adapter.forkBranch = async (request: {
      branchId: string;
      sessionId: string;
      namespace: string
    }) => {
      const result = await fork.call(ctx,
        request);
      const record = asRecord(result);
      let disposed = false;
      return {
        branchId: request.branchId,
        namespace: request.namespace,
        contextId: record !== undefined && typeof record.contextId === 'string' ? record.contextId : 'ctx-' + request.branchId,
        get isDisposed(): boolean {
          return disposed;
        },
        dispose: async (): Promise<void> => {
          if (disposed) {
            return;
          } disposed = true;
          const disposer = record === undefined ? undefined : record.dispose;
          if (typeof disposer === 'function') {
            try {
              await (disposer as () => Promise<void>).call(result);
            } catch {
              // Record disposed state even on error
            }
          }
        }
      };
    };
  } const promptSegment = pickCapability(root,
    'prompt',
    ['registerSegment']);
  if (promptSegment !== undefined) {
    adapter.registerPromptSegment = async (spec: Record<string,
      unknown>) => {
      const result = await promptSegment.call(asRecord(ctx)?.prompt,
        'system',
        spec.content,
        spec);
      return normalizeDisposer(result);
    };
  } const permissions = pickCapability(root,
    'permissions',
    ['register',
      'addRule',
      'guard']);
  if (permissions !== undefined) {
    adapter.registerGuardrails = async (spec: Record<string,
      unknown>) => {
      const result = await permissions.call(asRecord(ctx)?.permissions,
        spec);
      return normalizeDisposer(result);
    };
  } const memoryView = pickCapability(root,
    'evoMemory',
    ['createScopedView',
      'scopedView']);
  if (memoryView !== undefined) {
    adapter.registerMemoryScope = async (spec: Record<string,
      unknown>) => {
      const result = await memoryView.call(asRecord(ctx)?.evoMemory,
        spec.scopedViewId,
        spec);
      return normalizeDisposer(result);
    };
  } const patchDescriptions = pickCapability(root,
    'tools',
    ['patchDescriptions',
      'patchDescription']);
  if (patchDescriptions !== undefined) {
    adapter.patchToolGuidance = async (spec: Record<string,
      unknown>) => {
      const result = await patchDescriptions.call(asRecord(ctx)?.tools,
        spec.descriptions,
        spec);
      return normalizeDisposer(result);
    };
  } const mountSkill = pickCapability(root,
    'skills',
    ['mountDynamic',
      'mount']);
  if (mountSkill !== undefined) {
    adapter.mountSkills = async (spec: Record<string,
      unknown>) => {
      const result = await mountSkill.call(asRecord(ctx)?.skills,
        spec.skills,
        spec);
      return normalizeDisposer(result);
    };
  } const mountScript = pickCapability(root,
    'sandbox',
    ['mountScript',
      'writeFile']);
  if (mountScript !== undefined) {
    adapter.mountScripts = async (spec: Record<string,
      unknown>) => {
      const result = await mountScript.call(asRecord(ctx)?.sandbox,
        spec.scripts,
        spec);
      return normalizeDisposer(result);
    };
  } const registerSubagent = pickCapability(root,
    'subagents',
    ['register',
      'registerSubagent']);
  if (registerSubagent !== undefined) {
    adapter.registerSubagents = async (spec: Record<string,
      unknown>) => {
      const result = await registerSubagent.call(asRecord(ctx)?.subagents,
        spec.agents,
        spec);
      return normalizeDisposer(result);
    };
  } const useMiddleware = pickCapability(root,
    'middleware',
    ['use',
      'register']);
  if (useMiddleware !== undefined) {
    adapter.mountMiddleware = async (spec: Record<string,
      unknown>) => {
      const result = await useMiddleware.call(asRecord(ctx)?.middleware,
        spec.middleware,
        spec);
      return normalizeDisposer(result);
    };
  } const acquireSandbox = pickCapability(root,
    'sandbox',
    ['acquireWorkspace',
      'createWorkspace']);
  if (acquireSandbox !== undefined) {
    adapter.acquireSandbox = async (request: unknown) => {
      const result = await acquireSandbox.call(asRecord(ctx)?.sandbox,
        request);
      const record = asRecord(result);
      let disposed = false;
      return {
        id: record !== undefined && typeof record.id === 'string' ? record.id : 'sandbox-' + String((request as {
          branchId?: string
        }).branchId ?? 'unknown'),
        branchId: String((request as {
          branchId?: string
        }).branchId ?? 'unknown'),
        path: record !== undefined && typeof record.path === 'string' ? record.path : null,
        get isDisposed(): boolean {
          return disposed;
        },
        dispose: async (): Promise<void> => {
          if (disposed) {
            return;
          } disposed = true;
          const disposer = record === undefined ? undefined : record.dispose;
          if (typeof disposer === 'function') {
            try {
              await (disposer as () => Promise<void>).call(result);
            } catch {
              // Record disposed state even on error
            }
          }
        }
      };
    };
  } return adapter as CordisHostAdapter;
}
/** True when an adapter exposes at least one mountable seam. */
export function hostAdapterSeamCount(adapter: CordisHostAdapter): number {
  const keys: readonly (keyof CordisHostAdapter)[] = ['registerPromptSegment',
    'registerGuardrails',
    'registerMemoryScope',
    'patchToolGuidance',
    'mountSkills',
    'mountScripts',
    'registerSubagents',
    'mountMiddleware',
    'forkBranch',
    'acquireSandbox'];
  let count = 0;
  for (const key of keys) {
    if (typeof (adapter as Record<string,
      unknown>)[key] === 'function') {
      count += 1;
    }
  } return count;
} const OPTION_KEYS = ['model',
  'host',
  'clients',
  'listClients',
  'runBranch',
  'deps',
  'now',
  'newId',
  'commitScope',
  'registerAutoFallback',
  'autoFallbackEvents',
  'applyWinningPatch',
  'mirrorClient',
  'hostAdvisor',
  'hostAdvisorScope'] as const;
/** Accept either a raw plugin config section or a full options object. */
export function normalizePluginOptions(second: unknown,
  ctxConfig: unknown): EvoHarnessPluginOptions {
  const record = asRecord(second);
  if (record === undefined) {
    return second === undefined && ctxConfig !== undefined ? {
      config: ctxConfig
    } : {
    };
  } const looksLikeOptions = OPTION_KEYS.some((key) => record[key] !== undefined);
  if (looksLikeOptions) {
    return record as EvoHarnessPluginOptions;
  } return {
    config: second
  };
}
/** A model adapter that fails loudly; used when the host injects no LLM. */
export function missingModelAdapter(): IModelAdapter {
  return {
    async complete() {
      throw new Error('dsh-plugin-evo-harness: no model adapter was injected');
    }
  };
}
/**
 * Resolve the host adapter in capability order:
 *   1. an explicitly injected adapter (options.host) always wins;
 *   2. real DSH hook middleware (ctx.on + a DSH service);
 *   3. structural Cordis capability seams discovered on ctx;
 *   4. the in-memory reference adapter.
 * A real hook host keeps the structured seams as its fallback adapter, so the
 * hook surface is preferred per seam while fork/sandbox/memory keep working. */
export function resolveHostAdapter(ctx: unknown,
  options: EvoHarnessPluginOptions,
  diagnostics: string[]): {
    hostAdapter: CordisHostAdapter;
    hostAdapterSource: EvoHarnessHostAdapterSource;
    hookDetection?: DshHookDetection
  } {
  if (options.host !== undefined) {
    return {
      hostAdapter: options.host,
      hostAdapterSource: 'injected'
    };
  } const structured = createCordisHostFromContext(ctx);
  const structuredSeams = hostAdapterSeamCount(structured);
  const detection = detectDshHookHost(ctx);
  if (detection.detected) {
    const hookAdapter = createDshHookHostAdapter(ctx,
      {
        ... (structuredSeams > 0 ? {
          fallback: structured
        } : {
        }),
        onDiagnostic: (message) => diagnostics.push(message)
      });
    return {
      hostAdapter: hookAdapter,
      hostAdapterSource: 'dsh-hooks',
      hookDetection: detection
    };
  } if (structuredSeams > 0) {
    diagnostics.push('real DSH hook middleware is unavailable (' + detection.missing.join('; ') + '); using the structural Cordis capability seams instead');
    return {
      hostAdapter: structured,
      hostAdapterSource: 'context',
      hookDetection: detection
    };
  } return {
    hostAdapter: createInMemoryCordisHost(),
    hostAdapterSource: 'in-memory',
    hookDetection: detection
  };
}
/** JitRL surface produced while building the orchestrator collaborators. */
export interface JitRlWiring {
  /** The wired kernel, or undefined when L1 is disabled/unconfigured. */
  readonly kernel: JitRl | undefined;
  /** Effective status exposed on the plugin handle. */
  readonly status: EvoHarnessJitRlStatus;
  /** The mounted L1 decorator when creation succeeded (P3-E diagnostics). */
  readonly policy?: JitActivePolicy;
  /** Mutable runtime switch shared with the decorator (/evo jit off|on). */
  readonly runtimeEnabled?: {
    enabled: boolean
  };
  /** P4: replay observation sink filled by the wired dreamer. */
  readonly dream?: DreamReplayRecorder;
  /** P5-a: the L3 advisor, when the switch is on and a kernel exists. */
  readonly advisor?: HostAdvisor;
  /** P5-b: the aggregate-statistics mirror store, when a kernel exists. */
  readonly mirror?: BridgeMirrorStore;
  /** P5-b: mutable mirror counters read by the status getter. */
  readonly mirrorState?: MirrorCounterState;
  /** P5-a/H2: host-tool experience producer wired to the hook adapter. */
  readonly hostTool?: HostToolExperienceCollector;
}
/** Mutable last-replay record written by the wired dreamer (Phase 4). */
export interface DreamReplayRecorder {
  readonly hookAttached: boolean;
  lastReplay?: EvoHarnessDreamJitStatus['lastReplay'];
}
/** Mutable mirror counters written by the plugin's post-run sync (Phase 5). */
export interface MirrorCounterState {
  calls: number;
  writes: number;
  degraded: boolean;
  lastWritten: number;
}
/** P4 status value derived from config plus the wired dreamer's observation. */
export function dreamJitStatus(config: EvoHarnessConfig,
  recorder: DreamReplayRecorder | undefined): EvoHarnessDreamJitStatus {
  const lastReplay = recorder?.lastReplay;
  return {
    hyperparamPerturbation: config.jitrl.dream.hyperparamPerturbation,
    driftRho: config.jitrl.dream.driftRho,
    hookAttached: recorder?.hookAttached === true,
    ... (lastReplay === undefined ? {
    } : {
      lastReplay
    })
  };
}
/** L3 status value; attached means an advisor reached the real hook adapter. */
export function hostAdvisorJitStatus(input: {
  readonly config: EvoHarnessConfig;
  readonly attached: boolean;
  readonly advisor?: HostAdvisor;
  readonly runtimeEnabled?: boolean;
  readonly counters?: {
    readonly advisory: number;
    readonly ask: number;
    readonly noop: number;
    readonly skipped: number;
  };
}): EvoHarnessHostAdvisorStatus {
  const counters = input.counters ?? {
    advisory: 0,
    ask: 0,
    noop: 0,
    skipped: 0
  };
  return {
    enabled: input.config.jitrl.hostAdvisor.enabled,
    mode: input.config.jitrl.hostAdvisor.mode,
    attached: input.attached,
    runtimeEnabled: input.runtimeEnabled ?? true,
    advisory: counters.advisory,
    ask: counters.ask,
    noop: counters.noop,
    skipped: counters.skipped,
    diagnostics: input.advisor === undefined ? [] : [...input.advisor.diagnostics()]
  };
}
/** P5-b status value; a disabled mirror always reports zero calls. */
export function mirrorJitStatus(config: EvoHarnessConfig,
  state: MirrorCounterState | undefined): EvoHarnessMirrorStatus {
  return {
    enabled: config.jitrl.store.mirrorToMemoryBridge,
    calls: state?.calls ?? 0,
    writes: state?.writes ?? 0,
    degraded: state?.degraded ?? false,
    lastWritten: state?.lastWritten ?? 0
  };
}
/** First injected client that satisfies the mirror's structural MCP subset. */
function pickMirrorClient(clients: readonly unknown[] | undefined): JitMirrorMcpClient | undefined {
  for (const client of clients ?? []) {
    const record = client as Partial<JitMirrorMcpClient> | null;
    if (record !== null && typeof record === 'object' && typeof record.serverId === 'string' && typeof record.listTools === 'function' && typeof record.callTool === 'function') {
      return record as JitMirrorMcpClient;
    }
  } return undefined;
}
/** Dreamer surface plus the P4 diagnostic accessor the orchestrator reads. */
export interface WiredOfflineDreamer extends IOfflineDreamer {
  /** True when a JitReplayHook is injected on every replay (Phase 4). */
  readonly hookAttached: boolean;
  /** Human-readable summary of the last replay's JitRL hook activity. */
  lastDreamDiagnostics?(): readonly string[];
} function finiteOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
/**
 * P4: wrap the offline dreamer so every replay simulates JitRL against the LIVE
 * experience snapshot (plan section 7.3-2).
 *
 * The dreamer is created once at mount time, while the experience store keeps
 * growing; handing it a snapshot array at construction would freeze the replay
 * evidence at whatever existed before the first task. The wrapper therefore takes
 * the snapshot per replay and lets replayTree() perform the causal truncation, so
 * the hook can never observe records newer than the tree being replayed.
 *
 * The candidate jit hyperparameters travel with the policies: replay calls the
 * hook once per replayed policy and the hook reads `input.jit.beta`, so a
 * perturbed candidate really is simulated with its own beta. That observation is
 * recorded for the plugin status surface (it is the end-to-end proof that the
 * Phase 4 loop is reachable from the plugin entrypoint). */
export function createJitWiredDreamer(input: {
  readonly kernel: JitRl;
  readonly config: EvoHarnessConfig;
  readonly base: OfflineDreamerOptions;
  readonly recorder: DreamReplayRecorder;
}): WiredOfflineDreamer {
  let lastDiagnostics: readonly string[] = [];
  const now = input.base.now ?? ((): number => Date.now());
  // P4-b: the configured perturbation grid must reach candidate generation; a
  // model-backed generator keeps its own call and falls back to the grid.
  const grid = input.config.jitrl.dream;
  const deterministic: PolicyGenerator = (baseline,
    count) => generateCandidatePolicies(baseline,
      count,
      {
        now,
        jitGrid: grid
      });
  const generatePolicies: PolicyGenerator = input.base.modelAdapter === undefined ? deterministic : createModelPolicyGenerator(input.base.modelAdapter,
    {
      now,
      fallback: deterministic
    });
  const snapshot = (): readonly ExperienceRecord[] => {
    const store = input.kernel.store as IExperienceStore & {
      snapshot?: () => readonly ExperienceRecord[];
    };
    return typeof store.snapshot === 'function' ? store.snapshot() : [];
  };
  return {
    hookAttached: true,
    lastDreamDiagnostics(): readonly string[] {
      return lastDiagnostics;
    },
    async replay(request): Promise<DreamReplayReport> {
      const driftRho = input.config.jitrl.dream.driftRho;
      const seen = new Map<string,
        {
          readonly policyId: string;
          readonly beta: number;
          readonly lambda: number;
          readonly driftRho: number
        }>();
      let hookCalls = 0;
      const innerHook = input.kernel.createReplayHook({
        driftRho
      });
      const recordingHook: JitReplayHook = (hookInput) => {
        hookCalls += 1;
        seen.set(hookInput.policyId,
          {
            policyId: hookInput.policyId,
            beta: finiteOrZero(hookInput.jit.beta),
            lambda: finiteOrZero(hookInput.jit.lambda),
            driftRho: finiteOrZero(hookInput.driftRho)
          });
        return innerHook(hookInput);
      };
      const dreamer = createOfflineDreamer({
        ...input.base,
        generatePolicies,
        experiences: snapshot(),
        jitHook: recordingHook,
        driftRho
      });
      const report = await dreamer.replay(request);
      const candidates = [...seen.values()].sort((left,
        right) => left.policyId < right.policyId ? - 1 : left.policyId > right.policyId ? 1 : 0);
      const holder = input.base.activePolicy as | {
        readonly policy?: MetaSearchPolicy
      } | undefined;
      const appliedJit = report.improved ? holder?.policy?.jit : undefined;
      input.recorder.lastReplay = {
        ranAt: report.ranAt,
        hookCalls,
        improved: report.improved,
        selectedPolicyId: report.selectedPolicyId,
        candidates,
        ... (appliedJit === undefined ? {
        } : {
          appliedJit: {
            beta: finiteOrZero(appliedJit.beta),
            lambda: finiteOrZero(appliedJit.lambda)
          }
        })
      };
      const betas = [... new Set(candidates.map((candidate) => candidate.beta))].sort((left,
        right) => left - right);
      lastDiagnostics = ['offline dream jit: ' + String(hookCalls) + ' replay hook call(s) across ' + String(candidates.length) + ' polic' + (candidates.length === 1 ? 'y' : 'ies') + ' (beta ' + (betas.length === 0 ? 'n/a' : betas.join('/')) + ', driftRho ' + String(driftRho) + ')'];
      return report;
    }
  };
}
/** File name of the JitRL experience log inside the persistence directory. */
export const JITRL_EXPERIENCE_FILE = 'jitrl-experience.jsonl';
/**
 * Wrap the resolved active policy in the L1 decorator and (when persistence is
 * on) wire the durable experience log.
 *
 * The kernel itself is synchronous, so the returned policy is usable
 * immediately; hydrate() only attaches the durable drive and runs the one-shot
 * cold-start backfill, both of which are awaited by the caller before the plugin
 * reports ready. A JitRL failure must never break the plugin: any throw leaves
 * the policy unwrapped and records a diagnostic. */
export function buildJitRlWiring(input: {
  readonly config: EvoHarnessConfig;
  readonly policy: IActivePolicy;
  readonly options: EvoHarnessPluginOptions;
  readonly persistence: PersistenceRuntime | undefined;
  readonly diagnostics: string[];
  readonly now: () => number;
}): {
  readonly policy: IActivePolicy;
  readonly wiring: JitRlWiring
} {
  const jitrl = input.config.jitrl;
  const enabled = jitrl.enabled && jitrl.levels.includes('meta');
  const disabledStatus: EvoHarnessJitRlStatus = {
    enabled: false,
    levels: [...jitrl.levels],
    storeSize: 0,
    backfilled: 0,
    degraded: false,
    diagnostics: [],
    recentDecisions: [],
    dream: dreamJitStatus(input.config,
      undefined),
    hostAdvisor: hostAdvisorJitStatus({
      config: input.config,
      attached: false
    }),
    mirror: mirrorJitStatus(input.config,
      undefined)
  };
  if (!enabled) {
    return {
      policy: input.policy,
      wiring: {
        kernel: undefined,
        status: disabledStatus
      }
    };
  } try {
    const kernel = createJitRl({
      config: input.config,
      now: input.now,
      ... (input.options.model === undefined ? {
      } : {
        model: input.options.model
      }),
      onDiagnostic: (diagnostic) => {
        input.diagnostics.push('jitrl: ' + diagnostic.message);
      }
    });
    // Runtime switch shared with the command surface; /evo jit off flips this
    // and the decorator returns the baseline plan until it is flipped back.
    const runtimeEnabled = {
      enabled: true
    };
    const wrapped = kernel.createJitActivePolicy({
      inner: input.policy,
      now: input.now,
      maxRecoverySlots: input.config.dreamRsi.maxRecoverySlots,
      isRuntimeEnabled: () => runtimeEnabled.enabled
    });
    if (input.options.deps?.policy !== undefined) {
      // A host that injects its own policy owns that decision; the decorator
      // still wraps it, but the override is reported so the trace is explicable.
      input.diagnostics.push('jitrl: the injected policy was wrapped by the L1 meta-scheduling decorator');
    }
    // P4/P5 wiring state. The recorder and counters are shared by reference with
    // the dreamer wrapper and the post-run mirror sync, so the status getter
    // always reads live values (never a stale snapshot).
    const dreamRecorder: DreamReplayRecorder = {
      hookAttached: true
    };
    const mirrorState: MirrorCounterState = {
      calls: 0,
      writes: 0,
      degraded: false,
      lastWritten: 0
    };
    const advisor = jitrl.hostAdvisor.enabled && input.options.hostAdvisor !== undefined ? input.options.hostAdvisor : jitrl.hostAdvisor.enabled ? kernel.createHostAdvisor() : undefined;
    const mirrorClient = input.options.mirrorClient ?? pickMirrorClient(input.options.clients);
    const mirror = kernel.createMirrorStore(mirrorClient === undefined ? {
    } : {
      client: mirrorClient
    });
    // H2: the host-tool experience producer. It is wired to the hook adapter by
    // createEvoHarnessPlugin once the adapter exists. Collection follows the L3
    // switch: with hostAdvisor.enabled=false the default stays exactly as silent
    // as before (no extra records, no extra store writes).
    const hostTool = jitrl.hostAdvisor.enabled
      ? createHostToolExperienceCollector({
          config: input.config,
          store: kernel.store,
          now: input.now,
          policyId: () => wrapped.policy.id,
          onDiagnostic: (message) => input.diagnostics.push('jitrl host-tool: ' + message)
        })
      : undefined;
    const status: EvoHarnessJitRlStatus = {
      enabled: true,
      levels: [...jitrl.levels],
      storeSize: kernel.count(),
      backfilled: kernel.backfilled,
      degraded: kernel.degraded,
      diagnostics: kernel.diagnostics().map((diagnostic) => diagnostic.level + ':' + diagnostic.code + ': ' + diagnostic.message),
      cacheStats: wrapped.cacheStats(),
      recentDecisions: [],
      dream: dreamJitStatus(input.config,
        dreamRecorder),
      hostAdvisor: hostAdvisorJitStatus({
        config: input.config,
        attached: false,
        advisor
      }),
      mirror: mirrorJitStatus(input.config,
        mirrorState),
      hostToolExperiences: 0
    };
    input.diagnostics.push('jitrl: L1 meta-scheduling is active (beta ' + String(jitrl.beta) + ', k ' + String(jitrl.k) + ', threshold ' + String(jitrl.similarityThreshold) + ')');
    return {
      policy: wrapped,
      wiring: {
        kernel,
        status,
        policy: wrapped,
        runtimeEnabled,
        dream: dreamRecorder,
        mirror,
        mirrorState,
        hostTool,
        ... (advisor === undefined ? {
        } : {
          advisor
        })
      }
    };
  } catch (error) {
    input.diagnostics.push('jitrl: the L1 decorator could not be created (' + (error instanceof Error ? error.message : String(error)) + '); the unmodified active policy stays in place');
    return {
      policy: input.policy,
      wiring: {
        kernel: undefined,
        status: disabledStatus
      }
    };
  }
}
/** True when the durable experience log should be wired and backfilled. */
export function shouldHydrateJitRl(options: EvoHarnessPluginOptions): boolean {
  return options.persistence !== undefined;
}
/** Resolve the experience log path, or undefined for a memory-only kernel. */
export function resolveExperienceFilePath(options: EvoHarnessPluginOptions): string | undefined {
  if (options.experienceFilePath !== undefined) {
    return options.experienceFilePath;
  } const dataDir = options.persistence?.dataDir;
  if (dataDir === undefined || dataDir.length === 0) {
    return undefined;
  } return joinPath(dataDir,
    JITRL_EXPERIENCE_FILE);
}
/** Minimal POSIX/Windows join that does not pull node:path into the entry module. */
function joinPath(dir: string,
  file: string): string {
  const separator = dir.includes('\\') ? '\\' : '/';
  return dir.endsWith('/') || dir.endsWith('\\') ? dir + file : dir + separator + file;
}
/** Build the orchestrator collaborators from the resolved plugin config. */
export function buildOrchestratorDeps(config: EvoHarnessConfig,
  options: EvoHarnessPluginOptions,
  ctx: unknown,
  diagnostics: string[]): {
    deps: EvoHarnessOrchestratorDeps;
    hostAdapter: CordisHostAdapter;
    hostAdapterSource: EvoHarnessHostAdapterSource;
    jitrl: JitRlWiring;
  } {
  const now = options.now ?? ((): number => Date.now());
  let sequence = 0;
  const newId = options.newId ?? ((): string => {
    sequence += 1;
    return 'evo-' + String(sequence);
  });
  const {
    hostAdapter,
    hostAdapterSource
  } = resolveHostAdapter(ctx,
    options,
    diagnostics);
  if (hostAdapterSource === 'in-memory') {
    diagnostics.push('no Cordis capability seams were discoverable on the host context; an in-process in-memory host adapter is mounted so the lifecycle still runs (inject options.host for real sandboxed probes)');
  } const persistence = options.persistence;
  const treePool = options.deps?.treePool ?? persistence?.treePool ?? createDiscoveryTreePool({
    maxTrees: config.dreamRsi.maxTreePoolSize
  });
  const memory = options.deps?.memory ?? createMemoryBridge({
    config: config.memoryBridge,
    ... (options.clients === undefined ? {
    } : {
      clients: options.clients
    }),
    ... (options.listClients === undefined ? {
    } : {
      listClients: options.listClients
    }),
    now
  });
  const seams = options.deps?.seams ?? createCordisSeamManager({
    host: hostAdapter,
    namespacePrefix: config.memoryBridge.namespacePrefix,
    enabledSurfaces: config.enabledSurfaces,
    now,
    createBranchId: () => 'br-' + newId()
  });
  const policyDefaults = {
    maxWidth: config.dreamRsi.maxWidth,
    maxDepth: config.dreamRsi.maxDepth,
    earlyStopThreshold: config.dreamRsi.earlyStopThreshold,
    minMemoryConfidenceForSkip: config.dreamRsi.minMemoryConfidenceForSkip
  };
  const policy = options.deps?.policy ?? (persistence === undefined ? createActivePolicyFromDefaults(policyDefaults,
    {
      now,
      maxRecoverySlots: config.dreamRsi.maxRecoverySlots
    }) :
    // Resume from the persisted policy instead of resetting to pi^0 and write
    // every accepted update back through the store. The stores were recovered
    // during createPersistenceRuntime(), so the resume candidate is read
    // synchronously: current snapshot first, then the newest revision.
    persistence.wrapPolicy(createActivePolicy({
      policy: persistence.policyStore.current ?? persistence.policyStore.history.at(- 1) ?? createDefaultPolicy(policyDefaults,
        now),
      now,
      maxRecoverySlots: config.dreamRsi.maxRecoverySlots
    })));
  // JitRL L1: wrap the resolved policy in the meta-scheduling decorator. The
  // kernel is synchronous, so the returned policy is usable right away; the
  // durable experience log and the cold-start backfill are attached later by
  // createEvoHarnessPlugin (they need an async startup hook).
  const jitWiring = buildJitRlWiring({
    config,
    policy,
    options,
    persistence,
    diagnostics,
    now
  });
  const activePolicy = jitWiring.policy;
  const model = options.deps?.proposer === undefined ? options.model ?? missingModelAdapter() : undefined;
  const proposer = options.deps?.proposer ?? createDualTrackProposer({
    model: model as IModelAdapter,
    now,
    newId
  });
  const composer = options.deps?.composer ?? createAnonymousComposer({
    model: model as IModelAdapter,
    now,
    newId
  });
  const reflector = options.deps?.reflector ?? createEvidenceReflector({
    model: model as IModelAdapter,
    now,
    newId
  });
  const scorer = options.deps?.scorer ?? createSurrogateScorer({
    defaultWeights: config.dreamRsi.surrogateWeights,
    now
  });
  const taxonomy = options.deps?.taxonomy ?? createFailureTaxonomy({
  });
  const dreamBase: OfflineDreamerOptions = {
    now,
    treePool,
    activePolicy,
    policyCount: config.dreamRsi.candidatePoliciesCount,
    rhoPreferences: config.dreamRsi.rhoPreferences,
    modelAdapter: options.model
  };
  const dreamer = options.deps?.dreamer ??
    // P4: with a live JitRL kernel the dreamer is wrapped so replay simulates
    // JitRL (hook + live causal snapshot + drift); without one the plain dreamer
    // stays byte-identical to the pre-Phase-4 wiring.
    (jitWiring.wiring.kernel !== undefined && jitWiring.wiring.dream !== undefined ? createJitWiredDreamer({
      kernel: jitWiring.wiring.kernel,
      config,
      base: dreamBase,
      recorder: jitWiring.wiring.dream
    }) : createOfflineDreamer(dreamBase));
  // Branch executor order: an explicit host runner wins (a test or integrator
  // override), then the multi-step agent probe executor, then the loud-failure
  // default. The agent executor itself degrades to a single call when it has no
  // planner or tool runtime, so enabling it never silently changes semantics.
  const agentExecutor = options.deps?.runBranch === undefined && options.runBranch === undefined && options.agentLoop !== undefined ? createAgentLoopExecutor(options.agentLoop,
    now) : undefined;
  if (agentExecutor !== undefined) {
    diagnostics.push('multi-step agent probe executor is active: ' + agentExecutor.describe().join('; '));
  } const deps: EvoHarnessOrchestratorDeps = {
    config,
    memory,
    seams,
    policy: activePolicy,
    proposer,
    composer,
    reflector,
    scorer,
    taxonomy,
    dreamer,
    treePool,
    runBranch: options.deps?.runBranch ?? options.runBranch ?? agentExecutor?.runBranch ?? unconfiguredBranchExecutor(now),
    // Phase 3: hand the kernel to the orchestrator so L2 can select among K
    // proposals and online L1/L2 samples are recorded. A host without JitRL (or
    // with it disabled) simply leaves this absent and both stages stay silent.
    ... (jitWiring.wiring.kernel === undefined ? {
    } : {
      jitrl: jitWiring.wiring.kernel
    }),
    ... (persistence === undefined ? {
    } : {
      taskCounter: persistence.policyStore
    }),
    now,
    newId: () => 'evo-' + newId(),
    ... (options.commitScope === undefined ? {
    } : {
      commitScope: options.commitScope
    }),
    applyWinningPatch: options.applyWinningPatch ?? true,
    ... (options.deps ?? {
    })
  };
  return {
    deps,
    hostAdapter,
    hostAdapterSource,
    jitrl: jitWiring.wiring
  };
}
/** Deterministic runner used when the host injects none: a loud failure. */
export function unconfiguredBranchExecutor(now: () => number): BranchExecutor {
  return async (): Promise<ProbeExecutionResult> => {
    const message = 'no branch executor was injected; the host must supply options.runBranch';
    return {
      status: 'failed',
      steps: [{
        index: 0,
        at: now(),
        kind: 'error',
        text: message
      }],
      failureSignals: [{
        kind: 'unknown',
        message,
        repairable: false
      }],
      error: {
        name: 'EvoHarnessPluginError',
        message
      }
    };
  };
}
/**
 * Attach the durable experience log and run the one-shot cold-start backfill.
 *
 * Only runs when the host supplied a PersistenceRuntime: an in-memory tree pool
 * is empty at mount time, so there is nothing to backfill and nothing to read.
 * Every failure is a diagnostic; the returned promise never rejects. */
export async function hydrateJitRl(input: {
  readonly kernel: JitRl;
  readonly options: EvoHarnessPluginOptions;
  readonly persistence: PersistenceRuntime | undefined;
  readonly diagnostics: string[];
}): Promise<void> {
  try {
    if (!shouldHydrateJitRl(input.options)) {
      return;
    } const filePath = resolveExperienceFilePath(input.options);
    const pool = input.options.backfillFromTreePool === false ? undefined : input.persistence?.treePool;
    const result = await input.kernel.hydrate({
      ... (filePath === undefined ? {
      } : {
        filePath
      }),
      ... (pool === undefined ? {
      } : {
        pool
      })
    });
    if (result !== undefined) {
      input.diagnostics.push('jitrl: cold-start backfill converted ' + String(result.recordCount) + ' scored node(s) from ' + String(result.treeCount) + ' persisted tree(s) into L1 experience (' + String(result.appended) + ' appended)');
    } if (filePath !== undefined) {
      input.diagnostics.push('jitrl: experience log ' + filePath);
    }
  } catch (error) {
    input.diagnostics.push('jitrl: cold start failed (' + (error instanceof Error ? error.message : String(error)) + '); L1 scheduling continues from an empty experience store');
  }
}
/** Map one L1 diagnostic into the command layer's explain/status row shape. */
function toJitRecentDecision(decision: JitBatchDiagnostics,
  index: number,
  beta: number): JitRecentDecision {
  return {
    decisionId: 'decision-' + String(index + 1),
    level: decision.level,
    stateValue: decision.stateValue,
    neighborCount: decision.neighborCount,
    klToPrior: decision.klToPrior,
    rationale: decision.rationale,
    adjustments: decision.adjustments.map((adjustment) => ({
      candidate: adjustment.actionKey,
      source: adjustment.source ?? 'policy_prior',
      // z' = z + beta * A-tilde, so the prior logit is recoverable exactly.
      baseLogit: adjustment.adjustedLogit - beta * adjustment.normalizedAdvantage,
      q: adjustment.q,
      advantage: adjustment.advantage,
      normalizedAdvantage: adjustment.normalizedAdvantage,
      adjustedLogit: adjustment.adjustedLogit,
      note: (adjustment.explored ? 'explored' : 'support ' + String(adjustment.support)) + (adjustment.focusSurfaces === undefined || adjustment.focusSurfaces.length === 0 ? '' : '; surfaces ' + [...adjustment.focusSurfaces].join('+'))
    }))
  };
}
/** Newest-first, bounded mapping of decorator decisions. */
function recentJitDecisions(decisions: readonly JitBatchDiagnostics[],
  beta: number,
  limit: number): readonly JitRecentDecision[] {
  const bounded = Math.max(0,
    Math.floor(limit));
  if (bounded === 0) {
    return [];
  } const start = Math.max(0,
    decisions.length - bounded);
  const rows: JitRecentDecision[] = [];
  for (let index = start;
    index < decisions.length;
    index += 1) {
    const decision = decisions[index];
    if (decision !== undefined) {
      rows.push(toJitRecentDecision(decision,
        index,
        beta));
    }
  } return rows.reverse();
}
/** Construct the plugin without touching a host context. */
export function createEvoHarnessPlugin(options: EvoHarnessPluginOptions = {
},
  ctx?: unknown): EvoHarnessPlugin {
  const resolved = parseEvoHarnessConfig(options.config ?? (asRecord(ctx)?.config ?? undefined));
  const diagnostics: string[] = [];
  const {
    deps,
    hostAdapter,
    hostAdapterSource,
    jitrl: jitWiring
  } = buildOrchestratorDeps(resolved,
    options,
    ctx,
    diagnostics);
  const orchestrator = createEvoHarnessOrchestrator(deps);
  // JitRL cold start (plan section 8 Phase 2): attach the durable experience log
  // when persistence is on and convert the recovered tree pool into L1
  // experiences. Hydration is idempotent and never rejects, so awaiting it in
  // run() costs one resolved promise once startup settled.
  const jitReady: Promise<void> = jitWiring.kernel === undefined ? Promise.resolve() : hydrateJitRl({
    kernel: jitWiring.kernel,
    options,
    persistence: options.persistence,
    diagnostics
  });
  const disposers: Array<() => void | Promise<void>> = [];
  const registeredCommands: string[] = [];
  const registeredEvents: string[] = [];
  const inFlight = new Set<string>();
  // Single runtime switch for every JitRL surface (repair F1): L1 already reads
  // it through jitWiring.runtimeEnabled; L3 and the mirror read this object so
  // `/evo jit off` really stops advice, gate asks, mirror calls and evidence
  // collection, and `/evo jit on` restores all of them.
  const runtimeGate = {
    enabled: jitWiring.status.enabled
  };
  // The hook adapter owns host listeners the plugin installed itself; an
  // injected adapter stays owned by its injector.
  if (hostAdapterSource === 'dsh-hooks') {
    const hookAdapter = hostAdapter as CordisHostAdapter & {
      install?: () => void;
      dispose?: () => Promise<void>;
    };
    hookAdapter.install?.();
    // H2: forward tools/post-execute (and turn/end when available) to the
    // host-tool experience producer. Evidence collection pauses while JitRL is
    // switched off at runtime.
    const hookWiring = hostAdapter as DshHookHostAdapter;
    const hostTool = jitWiring.hostTool;
    if (hostTool !== undefined && typeof hookWiring.setHostToolExperienceSink === 'function') {
      hookWiring.setHostToolExperienceSink({
        observeToolCall: (observation) =>
          runtimeGate.enabled ? hostTool.observeToolCall(observation) : Promise.resolve(),
        observeTurnEnd: (observation) =>
          runtimeGate.enabled ? hostTool.observeTurnEnd(observation) : Promise.resolve()
      });
      diagnostics.push('jitrl: host-tool experience producer attached to the DSH hook adapter');
    }
    // P5-a: the L3 advisor is attached to the real hook listeners, scoped to the
    // configured probe branch/session. With hostAdvisor.enabled=false the wiring
    // leaves jitWiring.advisor undefined and the listeners stay pass-throughs.
    if (jitWiring.advisor !== undefined && typeof hookWiring.attachHostAdvisor === 'function') {
      hookWiring.attachHostAdvisor(jitWiring.advisor,
        {
          mode: resolved.jitrl.hostAdvisor.mode,
          isRuntimeEnabled: () => runtimeGate.enabled,
          ... (options.hostAdvisorScope === undefined ? {
          } : {
            scope: options.hostAdvisorScope
          })
        });
      diagnostics.push('jitrl: L3 host advisor attached to the DSH hook adapter (mode ' + resolved.jitrl.hostAdvisor.mode + (options.hostAdvisorScope === undefined ? ', host-local' : ', scoped') + ')');
    } const disposeHooks = hookAdapter.dispose;
    if (disposeHooks !== undefined) {
      disposers.push(() => disposeHooks.call(hookAdapter));
    }
  }
  // A recovered persistence runtime is owned by the host that created it, so the
  // plugin only flushes it (the durability barrier) and never closes its stores.
  const persistence = options.persistence;
  if (persistence !== undefined) {
    for (const message of persistence.diagnostics) {
      diagnostics.push(message);
    } disposers.push(() => persistence.flush());
  }
  /**
   * Live status for the plugin handle. Re-read on every access because the
   * backfill lands asynchronously and storeSize must reflect it.   */
  const currentJitRlStatus = (): EvoHarnessJitRlStatus => {
    const kernel = jitWiring.kernel;
    if (kernel === undefined) {
      return {
        ...jitWiring.status,
        // P5-a can be inspected (enabled/mode) with no kernel, but it is never
        // attached without one; report the observed adapter counters regardless.
        hostAdvisor: hostAdvisorJitStatus({
          config: resolved,
          attached: jitWiring.advisor !== undefined && hostAdapterSource === 'dsh-hooks',
          runtimeEnabled: false,
          ... (jitWiring.advisor === undefined ? {
          } : {
            advisor: jitWiring.advisor
          }),
          counters: advisorCounters()
        }),
        mirror: mirrorJitStatus(resolved,
          jitWiring.mirrorState),
        hostToolExperiences: 0
      };
    } const decorator = jitWiring.policy;
    const advisorAttached = jitWiring.advisor !== undefined && hostAdapterSource === 'dsh-hooks';
    return {
      enabled: true,
      levels: [...kernel.config.levels],
      storeSize: kernel.count(),
      backfilled: kernel.backfilled,
      degraded: kernel.degraded,
      diagnostics: kernel.diagnostics().map((diagnostic) => diagnostic.level + ':' + diagnostic.code + ': ' + diagnostic.message),
      ... (decorator === undefined ? {
      } : {
        cacheStats: decorator.cacheStats()
      }),
      recentDecisions: decorator === undefined ? [] : recentJitDecisions(decorator.decisions,
        resolved.jitrl.beta,
        10),
      dream: dreamJitStatus(resolved,
        jitWiring.dream),
      hostAdvisor: hostAdvisorJitStatus({
        config: resolved,
        attached: advisorAttached,
        runtimeEnabled: runtimeGate.enabled,
        ... (jitWiring.advisor === undefined ? {
        } : {
          advisor: jitWiring.advisor
        }),
        counters: advisorCounters()
      }),
      mirror: mirrorJitStatus(resolved,
        jitWiring.mirrorState),
      hostToolExperiences: jitExperienceSnapshot().filter((record) => record.level === 'host_tool').length
    };
  };
  /** Adapter-side L3 counters; zero when the adapter has no advisor support. */
  const advisorCounters = (): {
    readonly advisory: number;
    readonly ask: number;
    readonly noop: number;
    readonly skipped: number;
  } => {
    const adapter = hostAdapter as Partial<DshHookHostAdapter>;
    if (typeof adapter.hostAdvisorStats !== 'function') {
      return {
        advisory: 0,
        ask: 0,
        noop: 0,
        skipped: 0
      };
    } return adapter.hostAdvisorStats();
  };
  /**
   * P5-b: mirror the aggregate experience statistics after each completed run.
   *
   * Aggregate-only (plan section 7.2): the payload is one row per
   * (level, bucket, actionKey) and never a raw record. With
   * `mirrorToMemoryBridge: false` this returns before calling mirror(), so the
   * disabled switch costs exactly zero backend calls.   */
  const syncJitMirror = async (): Promise<void> => {
    const mirror = jitWiring.mirror;
    const state = jitWiring.mirrorState;
    if (mirror === undefined || state === undefined || !resolved.jitrl.store.mirrorToMemoryBridge) {
      return;
    }
    // Repair F1: `/evo jit off` also stops the mirror, so switching the feature
    // off really means zero backend calls from that moment on.
    if (!runtimeGate.enabled) {
      return;
    } const rows = aggregateExperienceStats(jitExperienceSnapshot());
    if (rows.length === 0) {
      return;
    } try {
      const result = await mirror.mirror(rows);
      state.calls += 1;
      state.writes += result.written;
      state.degraded = result.degraded;
      if (result.written > 0) {
        state.lastWritten = (options.now ?? ((): number => Date.now()))();
      } for (const line of result.diagnostics) {
        diagnostics.push('jitrl mirror: ' + line);
      }
    } catch (error) {
      state.degraded = true;
      diagnostics.push('jitrl mirror: aggregate mirror failed (' + (error instanceof Error ? error.message : String(error)) + ')');
    }
  };
  const log = (level: 'info' | 'warn',
    message: string): void => {
    const logger = asRecord(ctx)?.logger;
    const sink = logger === undefined ? undefined : (logger as Record<string,
      unknown>)[level];
    if (typeof sink === 'function') {
      (sink as (value: string) => void).call(logger,
        message);
      return;
    } diagnostics.push(message);
  };
  // --- /evo jit command surface (P3-E) ------------------------------------
  let volatileJitEnabled = jitWiring.status.enabled;
  const jitExperienceSnapshot = (): readonly ExperienceRecord[] => {
    const kernel = jitWiring.kernel;
    if (kernel === undefined) {
      return [];
    } const store = kernel.store as IExperienceStore & {
      snapshot?: () => readonly ExperienceRecord[];
    };
    return typeof store.snapshot === 'function' ? store.snapshot() : [];
  };
  const jitDecoratorDecisions = (): readonly JitBatchDiagnostics[] => jitWiring.policy?.decisions ?? [];
  /**
   * /evo jit reset delegates to the live store drive's purge(): the memory and
   * JSONL stores both rewrite/remove atomically, so the durable log and the
   * in-process index stay in sync (P3-E2 gap 2). Unknown buckets are a no-op.   */
  const resetJitExperienceStore = async (bucket?: string): Promise<JitResetDrop> => {
    const kernel = jitWiring.kernel;
    if (kernel === undefined) {
      return {
        dropped: 0,
        supported: false,
        note: 'JitRL is not active in this process'
      };
    } const facade = kernel.store as IExperienceStore & {
      purge?(options?: {
        readonly bucket?: string
      }): Promise<number>;
    };
    if (typeof facade.purge !== 'function') {
      return {
        dropped: 0,
        supported: false,
        note: 'the experience store driver exposes no purge operation'
      };
    } const dropped = await facade.purge(bucket === undefined ? {
    } : {
      bucket
    });
    diagnostics.push('jitrl: reset purged ' + String(dropped) + ' experience record(s)' + (bucket === undefined ? ' from every bucket' : ' from bucket ' + bucket));
    return {
      dropped,
      supported: true
    };
  };
  const jitCommandController: JitCommandController = {
    isEnabled: () => jitWiring.kernel !== undefined && volatileJitEnabled,
    setEnabled: (enabled) => {
      volatileJitEnabled = jitWiring.kernel !== undefined && enabled;
      // Flip the decorator's runtime switch too, so off really stops adjustments.
      if (jitWiring.runtimeEnabled !== undefined) {
        jitWiring.runtimeEnabled.enabled = volatileJitEnabled;
      }
      // Repair F1: the same toggle gates L3 (advice/gate), the mirror and the
      // host-tool evidence producer.
      runtimeGate.enabled = volatileJitEnabled;
      return volatileJitEnabled;
    },
    levels: () => jitWiring.kernel === undefined ? [...resolved.jitrl.levels] : [...jitWiring.kernel.config.levels],
    storeSize: (level) => (jitWiring.kernel === undefined ? 0 : jitWiring.kernel.count(level)),
    bucketCoverage: () => {
      const counts = new Map<string,
        {
          level: JitLevel;
          bucket: string;
          count: number
        }>();
      for (const record of jitExperienceSnapshot()) {
        const key = record.level + '|' + record.state.bucket;
        const existing = counts.get(key);
        if (existing === undefined) {
          counts.set(key,
            {
              level: record.level,
              bucket: record.state.bucket,
              count: 1
            });
        } else {
          counts.set(key,
            {
              level: existing.level,
              bucket: existing.bucket,
              count: existing.count + 1
            });
        }
      } return [...counts.values()];
    },
    cacheStats: () => jitWiring.policy?.cacheStats(),
    recentDecisions: (limit) => recentJitDecisions(jitDecoratorDecisions(),
      resolved.jitrl.beta,
      limit),
    findDecision: (runId) => {
      const decisions = jitDecoratorDecisions();
      const beta = resolved.jitrl.beta;
      if (runId === 'latest') {
        const index = decisions.length - 1;
        const decision = decisions[index];
        return decision === undefined ? undefined : toJitRecentDecision(decision,
          index,
          beta);
      }
      const match = /^decision-(\d+)$/.exec(runId.trim());
      if (match === null) {
        return undefined;
      }
      const index = Number(match[1]) - 1;
      const decision = decisions[index];
      return decision === undefined ? undefined : toJitRecentDecision(decision,
        index,
        beta);
    },
    reset: (bucket) => resetJitExperienceStore(bucket)
  };
  const plugin: EvoHarnessPlugin = {
    name: 'dsh-plugin-evo-harness',
    config: resolved,
    orchestrator,
    diagnostics,
    registeredCommands,
    registeredEvents,
    hostAdapterSource,
    get jitrl(): EvoHarnessJitRlStatus {
      return currentJitRlStatus();
    },
    async run(request: EvoHarnessRunRequest): Promise<EvoHarnessRunResult> {
      // The very first run may start before the cold-start backfill finished;
      // waiting here (not at construction) keeps the plugin synchronous to mount.
      await jitReady;
      const runResult = await orchestrator.run(request);
      // P5-b: mirror the aggregate statistics this run just wrote. A disabled
      // mirror returns before the first backend call, so it costs nothing.
      await syncJitMirror();
      return runResult;
    },
    async runFromCommand(args: unknown,
      context?: unknown): Promise<EvoHarnessCommandRunResult> {
      // /evo jit ... is a control surface, not a run: dispatch before any prompt
      // extraction so non-jit invocations keep their existing semantics.
      const commandTokens = typeof args === 'string' ? splitJitArgs(args) : [];
      if (commandTokens[0] === 'jit') {
        const jitCommand = await executeJitCommand(commandTokens.slice(1),
          jitCommandController);
        const timestamp = (options.now ?? ((): number => Date.now()))();
        const commandSession = typeof asRecord(context)?.sessionId === 'string' ? String((asRecord(context) as Record<string,
          unknown>).sessionId) : 'session-unknown';
        return {
          runId: 'jit-' + jitCommand.command,
          sessionId: commandSession,
          taskId: 'jit-command',
          outcome: 'skipped',
          trigger: 'slash_command',
          probesRun: 0,
          lessonsCommitted: 0,
          diagnostics: [jitCommand.text],
          startedAt: timestamp,
          endedAt: timestamp,
          metadata: {
            jitCommand
          },
          jitCommand
        };
      } const record = asRecord(args);
      const prompt = typeof args === 'string' && args.trim().length > 0 ? args : typeof record?.prompt === 'string' ? (record.prompt as string) : typeof record?.text === 'string' ? (record.text as string) : 'evolve the current task';
      const sessionId = typeof record?.sessionId === 'string' ? (record.sessionId as string) : typeof asRecord(context)?.sessionId === 'string' ? String((asRecord(context) as Record<string,
        unknown>).sessionId) : 'session-unknown';
      const task = plugin.makeTask({
        prompt,
        ... (typeof record?.taskId === 'string' ? {
          id: record.taskId as string
        } : {
        }),
        ... (typeof record?.taskSignature === 'string' ? {
          taskSignature: record.taskSignature as string
        } : {
        })
      });
      const runResult = await orchestrator.run({
        sessionId,
        task,
        trigger: 'slash_command'
      });
      await syncJitMirror();
      return runResult;
    },
    async handleFallbackEvent(payload: unknown): Promise<EvoHarnessRunResult | null> {
      if (resolved.triggerMode === 'slash_command') {
        diagnostics.push('triggerMode=slash_command: the auto_fallback event was ignored');
        return null;
      } const record = asRecord(payload);
      const sessionId = typeof record?.sessionId === 'string' ? (record.sessionId as string) : 'session-unknown';
      if (inFlight.has(sessionId)) {
        diagnostics.push('auto_fallback: a run is already in flight for ' + sessionId + '; event ignored');
        return null;
      } const taskRecord = asRecord(record?.task);
      const failureSignals = record?.failureSignals;
      const prompt = typeof taskRecord?.prompt === 'string' ? (taskRecord.prompt as string) : typeof record?.prompt === 'string' ? (record.prompt as string) : typeof record?.message === 'string' ? (record.message as string) : 'recover from the reported failure';
      inFlight.add(sessionId);
      try {
        return await orchestrator.run({
          sessionId,
          task: plugin.makeTask({
            prompt,
            ... (typeof taskRecord?.id === 'string' ? {
              id: taskRecord.id as string
            } : {
            })
          }),
          trigger: 'auto_fallback',
          metadata: {
            autoFallback: true,
            ... (failureSignals === undefined ? {
            } : {
              failureSignals
            }),
            ... (record?.toolErrors === undefined ? {
            } : {
              toolErrors: record.toolErrors
            })
          }
        });
      } finally {
        inFlight.delete(sessionId);
      }
    },
    makeTask(input): ProbeTask {
      const base = input.id ?? 'task-' + input.prompt.slice(0,
        32);
      return {
        id: base,
        prompt: input.prompt,
        ... (input.taskSignature === undefined ? {
        } : {
          taskSignature: input.taskSignature
        }),
        ... (input.contextTags === undefined ? {
        } : {
          contextTags: input.contextTags
        })
      };
    },
    async dispose(): Promise<void> {
      for (const dispose of disposers) {
        try {
          await dispose();
        } catch {
          // ignore
        }
      } disposers.length = 0;
      await orchestrator.dispose();
    }
  };
  const registerCommand = pickFunction(asRecord(ctx),
    ['registerCommand',
      'command',
      'addCommand']);
  if (registerCommand !== undefined) {
    try {
      const result = registerCommand.call(ctx,
        EVO_COMMAND_NAME,
        (args: unknown,
          context?: unknown) => plugin.runFromCommand(args,
            context));
      const normalized = normalizeDisposer(result);
      disposers.push(() => normalized.dispose());
      registeredCommands.push(EVO_COMMAND_NAME);
      log('info',
        'evo-harness: registered /' + EVO_COMMAND_NAME + ' slash command');
    } catch (error) {
      diagnostics.push('failed to register the /evo command: ' + String(error));
    }
  } else {
    diagnostics.push('the host context exposes no command registrar; plugin.runFromCommand(args) is the fallback entrypoint for /evo');
  } if (options.registerAutoFallback !== false && resolved.triggerMode === 'slash_command') {
    diagnostics.push('triggerMode=slash_command: auto_fallback listeners were not registered; /evo remains the only entrypoint');
  } else if (options.registerAutoFallback !== false) {
    const on = pickFunction(asRecord(ctx),
      ['on',
        'onEvent',
        'subscribe']);
    const events = options.autoFallbackEvents ?? DEFAULT_AUTO_FALLBACK_EVENTS;
    if (on !== undefined) {
      for (const event of events) {
        try {
          const result = on.call(ctx,
            event,
            (payload: unknown) => plugin.handleFallbackEvent(payload));
          const normalized = normalizeDisposer(result);
          disposers.push(() => normalized.dispose());
          registeredEvents.push(event);
        } catch (error) {
          diagnostics.push('failed to subscribe to "' + event + '": ' + String(error));
        }
      } if (registeredEvents.length > 0) {
        log('info',
          'evo-harness: auto_fallback subscribed to ' + registeredEvents.join(', '));
      }
    } else {
      diagnostics.push('the host context exposes no event subscriber; call plugin.handleFallbackEvent(payload) for auto_fallback');
    }
  } const provide = pickFunction(asRecord(ctx),
    ['provide',
      'set',
      'expose']);
  if (provide !== undefined) {
    try {
      provide.call(ctx,
        'evoHarness',
        plugin);
    } catch (error) {
      diagnostics.push('failed to expose the evoHarness service: ' + String(error));
    }
  } else {
    const record = asRecord(ctx);
    if (record !== undefined && !Object.isFrozen(record)) {
      try {
        record.evoHarness = plugin;
      } catch (error) {
        diagnostics.push('failed to attach the evoHarness service: ' + String(error));
      }
    }
  } return plugin;
}
/** Standard Cordis plugin entrypoint. */
export function apply(ctx: unknown,
  optionsOrConfig?: unknown): EvoHarnessPlugin {
  const normalized = normalizePluginOptions(optionsOrConfig,
    asRecord(ctx)?.config);
  return createEvoHarnessPlugin(normalized,
    ctx);
}
/** Plugin name shared by the default export and the plugin handle. */
export const PLUGIN_NAME = 'dsh-plugin-evo-harness';
export const plugin = {
  name: PLUGIN_NAME,
  apply
};
export default plugin;
/** Re-exported for hosts that resolve the trigger mode themselves. */
export type EvoHarnessTrigger = TriggerMode;
export {
  CONFIG_SCHEMA_VERSION,
  validateEvoHarnessConfig
};
/**
 * Public sub-layers, re-exported so a host resolves them from the package entry
 * instead of an internal path.
 *
 * Names that `src/index.ts` already declares are re-exported selectively: the
 * dotted paths keep both surfaces available without an ambiguous star export. */
export {
  createPersistenceRuntime,
  resolvePersistenceDataDir,
  PERSISTENCE_DEFAULTS,
  type PersistenceRuntime,
  type PersistenceRuntimeOptions
} from './persistence';
/**
 * JitRL public surface (Phase 1 kernel + Phase 2 L1). Re-exported selectively so
 * a host can build the kernel or assert on the decorator without importing an
 * internal path; the namespace keeps the L1 names unambiguous next to the
 * Dream-RSI ActivePolicy exports above. */
export {
  createJitRl,
  createJitActivePolicy,
  createJitActivePolicy as createL1JitActivePolicy,
  createJitReplayHook,
  aggregateExperienceStats,
  createHostAdvisor,
  createJitBridgeMirrorStore,
  JITRL_STAT_TAG,
  JITRL_STAT_KIND,
  isJitActivePolicy,
  jitMetaEnabled,
  halfLifeMsFromConfig,
  backfillFromTreePool,
  hasJitDiagnostics,
  readJitDiagnostics,
  buildMetaState,
  slotKindOfActionKey,
  JIT_BATCH_METADATA_KEY,
  BACKFILL_RECORD_PREFIX,
  backfillRecordId,
  mapScoreToReward,
  type JitRl,
  type JitRlFactoryOptions,
  type JitRlHydrateOptions,
  type JitRlDiagnostic,
  type JitActivePolicy,
  type JitActivePolicyOptions,
  type JitActivePolicyConfig,
  type JitBatchDiagnostics,
  type JitBatchAdjustment,
  type MetaActionPayload,
  type BackfillOptions,
  type BackfillResult,
  type BackfillTreeSource,
  type ExperienceAppendSink,
  type JitReplayHook,
  type JitReplayHookInput,
  type JitReplayHookResult,
  type JitReplayHookDiagnostics,
  type JitReplayAdjustment,
  type DreamJitDiagnostics,
  type JitStatsAggregate,
  type HostAdvisor,
  type HostAdvisorOptions,
  type BridgeMirrorStore,
  type JitMirrorMcpClient
} from './jitrl';
export {
  createAgentLoopExecutor,
  asAgentLoopModel,
  defaultAgentProbeMessages,
  extractToolGuidance,
  DEFAULT_MAX_STEPS_PER_PROBE,
  type AgentExecutionMode,
  type AgentLoopAdapters,
  type AgentLoopDecision,
  type AgentLoopExecutor,
  type AgentLoopModel,
  type AgentPlanRequest,
  type AgentStepEvent,
  type AgentToolCallOutcome,
  type AgentToolCallRequest,
  type AgentToolGuidanceView,
  type AgentToolRuntime
} from './dsh-bridge';
