/**
 * dsh-plugin-evo-harness Cordis plugin entrypoint (integrator-owned).
 *
 * Exports the standard Cordis plugin shape:
 *   - Config               volatile schemastery fragment for the settings page
 *   - apply(ctx, config)   registers /evo and the verified DSH triggers
 *   - default export       { name, inject, Config, apply }
 *
 * Everything host-facing is resolved structurally at mount time:
 *   - ctx.commands.register({name,description,input,handler}) -> /evo
 *   - ctx.on('session/event' | 'agent/error' | 'agent/status') -> src/host-triggers.ts
 *   - ctx.llm / ctx.tools / ctx.agents -> src/dsh-bridge (resolveDshCollaborators)
 *   - ctx.prompt/tools/skills/sandbox/subagents/middleware/evoMemory/fork
 *                                        -> the eight Cordis capability seams
 *   - ctx.logger / ctx.provide           -> diagnostics and service exposure
 *
 * The fabricated event names 'task:failed' / 'tool:error' are NOT DSH events and
 * are no longer defaults: they survive only behind an explicit opt-in list.
 */
import z from '@deepseek-ai/schemastery';
import {
  CONFIG_SCHEMA_VERSION,
  parseEvoHarnessConfig,
  validateEvoHarnessConfig,
  type EvoHarnessConfig
} from './config';
import {
  createCordisSeamManager,
  createInMemoryCordisHost,
  type CordisHostAdapter,
  type HostDisposer
} from './cordis-seams';
import { createMemoryBridge, type McpClient } from './memory-bridge';
import {
  createAnonymousComposer,
  createDualTrackProposer,
  createEvidenceReflector
} from './harness2';
import {
  createActivePolicyFromDefaults,
  createDiscoveryTreePool,
  createFailureTaxonomy,
  createOfflineDreamer,
  createSurrogateScorer
} from './dream-rsi';
import {
  createEvoHarnessOrchestrator,
  type EvoHarnessOrchestrator,
  type EvoHarnessOrchestratorDeps
} from './orchestrator';
import {
  createModelConfigFragment,
  createModelRouteSchema,
  MODEL_ROUTE_DEFAULTS,
  resolveDshCollaborators,
  resolveModelRouteConfig,
  type DshCollaborators
} from './dsh-bridge';
import {
  DSH_AGENT_ERROR,
  DSH_AGENT_STATUS,
  DSH_SESSION_EVENT,
  LEGACY_TRIGGER_EVENTS,
  registerDshTriggers,
  splitModelRoute,
  unwrapConfigValues,
  type DshCompletedTurnEvent,
  type DshFailureEvent,
  type DshTriggerRegistration
} from './host-triggers';
import type {
  BranchExecutor,
  EvoHarnessRunRequest,
  EvoHarnessRunResult,
  IModelAdapter,
  MemoryScope,
  ProbeExecutionResult,
  ProbeTask,
  TriggerMode
} from './types/contracts';

/** Name registered with the host; hosts render it as /evo. */
export const EVO_COMMAND_NAME = 'evo';

/**
 * Events the auto_fallback hook subscribes to by default.
 *
 * These are the VERIFIED DSH names (see src/host-triggers.ts). The previous
 * values 'task:failed' and 'tool:error' do not exist anywhere in the DSH
 * runtime, so no listener registered on them could ever fire.
 */
export const DEFAULT_AUTO_FALLBACK_EVENTS = [
  DSH_SESSION_EVENT,
  DSH_AGENT_ERROR,
  DSH_AGENT_STATUS
] as const;

/**
 * The fabricated pre-fix names. Exported for the explicit opt-in path only;
 * never registered unless the caller asks for them by name.
 */
export const LEGACY_AUTO_FALLBACK_EVENTS = LEGACY_TRIGGER_EVENTS;

/** Configured provider/model/reasoningEffort for the optional second page. */
export type EvoHarnessModelRoute = {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: string;
};

/** Verified default route, mirrored by the modelRoute block in cordis.patch.yml. */
export const modelRouteDefaults: EvoHarnessModelRoute = {
  provider: MODEL_ROUTE_DEFAULTS.provider,
  model: MODEL_ROUTE_DEFAULTS.model,
  reasoningEffort: MODEL_ROUTE_DEFAULTS.reasoningEffort
};

/**
 * DSH plugin Config: the volatile fragment the settings page renders.
 *
 * Every leaf carries .volatile() — a plain field is frozen into the fiber
 * config and the settings page cannot save a change to it. The enclosing
 * `modelRoute` group is deliberately NOT volatile: Cordis rejects a volatile
 * field under a volatile parent. Defaults mirror cordis.patch.yml.
 */
export const Config = createModelConfigFragment(
  z as unknown as Parameters<typeof createModelConfigFragment>[0]
);

/**
 * Persist-safe serializer for the plugin config.
 *
 * DSH's loader calls `Config.simplify(validated)` before writing an entry back
 * to cordis.patch.yml. Default schemastery simplify DROPS undeclared keys, so
 * saving the model route from the settings page would erase triggerMode,
 * enabledSurfaces, memoryBridge, dreamRsi and logging. Unwrapping the volatile
 * references while preserving every key keeps the rest of the entry intact.
 */
(Config as unknown as Record<string, unknown>)['simplify'] = unwrapConfigValues;

/**
 * Services this plugin declares.
 *
 * Only `commands` is REQUIRED. Cordis has no optional inject: a name listed
 * here holds the fiber PENDING until that service mounts, so declaring `llm`,
 * `tools` or `agents` would silently prevent the plugin (and /evo) from ever
 * mounting on a profile without them. All three are optional collaborators with
 * a recorded fallback, so they are read through the throwing-safe probe in
 * src/dsh-bridge instead, where an absent service is a diagnostic instead of a
 * stalled fiber.
 */
export const pluginInject = ['commands'] as const;

/** Minimal structural view of a Cordis plugin context (all members optional). */
export interface CordisPluginContext {
  readonly logger?: {
    debug?(message: string): void;
    info?(message: string): void;
    warn?(message: string): void;
    error?(message: string): void;
  };
  readonly registerCommand?: (name: string, handler: CordisCommandHandler) => unknown;
  readonly command?: (name: string, handler: CordisCommandHandler) => unknown;
  readonly addCommand?: (name: string, handler: CordisCommandHandler) => unknown;
  readonly on?: (event: string, handler: (payload: unknown) => unknown) => unknown;
  readonly provide?: (name: string, value: unknown) => unknown;
  readonly config?: unknown;
  readonly [key: string]: unknown;
}

/** Slash-command handler signature accepted by the structural context. */
export type CordisCommandHandler = (
  args?: unknown,
  context?: unknown
) => unknown | Promise<unknown>;

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
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly commitScope?: (sessionId: string) => MemoryScope;
  /** Subscribe the verified DSH triggers; defaults to true. */
  readonly registerAutoFallback?: boolean;
  /**
   * Explicit opt-in to event names that are NOT part of DSH.
   *
   * The pre-fix defaults 'task:failed' / 'tool:error' do not exist in the DSH
   * runtime, so they are never registered unless named here.
   */
  readonly autoFallbackEvents?: readonly string[];
  readonly applyWinningPatch?: boolean;
  /**
   * Resolve ctx.llm / ctx.tools / the same-process BranchExecutor through
   * src/dsh-bridge. Defaults to true; tests inject the three collaborators
   * directly and do not need a host context.
   */
  readonly resolveDshCollaborators?: boolean;
  /** Override the route explicitly (provider/model/reasoningEffort). */
  readonly route?: { provider?: string; model?: string; reasoningEffort?: string };
  /** Enable the idle-dream hook on agent/status; defaults to true. */
  readonly enableIdleDream?: boolean;
  /** Override the idle-dream replay body (tests pass a spy). */
  readonly dream?: () => Promise<unknown> | unknown;
}

/** Mounted plugin handle returned by apply/createEvoHarnessPlugin. */
export interface EvoHarnessPlugin {
  readonly name: string;
  readonly config: EvoHarnessConfig;
  readonly orchestrator: EvoHarnessOrchestrator;
  readonly diagnostics: readonly string[];
  readonly registeredCommands: readonly string[];
  readonly registeredEvents: readonly string[];
  readonly hostAdapterSource: 'injected' | 'context' | 'in-memory';
  /** Effective provider/model/reasoningEffort for model calls. */
  readonly modelRoute: EvoHarnessModelRoute;
  /** Resolves once ctx.llm / ctx.tools / runBranch detection settles. */
  readonly collaborators: Promise<DshCollaborators | undefined>;
  run(request: EvoHarnessRunRequest): Promise<EvoHarnessRunResult>;
  runFromCommand(args: unknown, context?: unknown): Promise<EvoHarnessRunResult>;
  handleFallbackEvent(payload: unknown): Promise<EvoHarnessRunResult | null>;
  /** Handle one verified DSH failure observation (auto_fallback / always). */
  handleTriggerFailure(failure: DshFailureEvent): Promise<EvoHarnessRunResult | null>;
  /** Handle one completed turn; runs only under triggerMode 'always'. */
  handleTurnCompleted(turn: DshCompletedTurnEvent): Promise<EvoHarnessRunResult | null>;
  /**
   * Await every trigger-initiated run that is still in flight, in completion
   * order.
   *
   * DSH dispatches `session/event` as a contained fire-and-forget emit, so the
   * listener cannot return the run's result. This is the deterministic join
   * point: the plugin's own teardown uses it, and a caller that wants the
   * outcome of an event it just dispatched awaits it here.
   */
  settle(): Promise<readonly EvoHarnessRunResult[]>;
  makeTask(input: {
    readonly prompt: string;
    readonly id?: string;
    readonly taskSignature?: string;
    readonly contextTags?: readonly string[];
  }): ProbeTask;
  dispose(): Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * Read one property without letting the host's proxy throw.
 *
 * A live Cordis context resolves property reads through its reflection layer:
 * reading a service the plugin did not declare in `inject` raises
 * `cannot get property "<name>" without inject` instead of returning
 * `undefined`. Structural probing must therefore treat a throw exactly like an
 * absent capability, or mounting a plugin that probes for optional services
 * fails the whole fiber.
 */
function safeGet(source: unknown, key: string): unknown {
  if (source === null || typeof source !== 'object') {
    return undefined;
  }
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** Read the host context's plugin config without assuming it is injectable. */
function contextConfig(ctx: unknown): unknown {
  return safeGet(ctx, 'config');
}

function pickFunction(
  source: Record<string, unknown> | undefined,
  names: readonly string[]
): ((...args: unknown[]) => unknown) | undefined {
  if (source === undefined) {
    return undefined;
  }
  for (const name of names) {
    const candidate = safeGet(source, name);
    if (typeof candidate === 'function') {
      return candidate as (...args: unknown[]) => unknown;
    }
  }
  return undefined;
}

function pickCapability(
  source: Record<string, unknown> | undefined,
  objectName: string,
  methodNames: readonly string[]
): ((...args: unknown[]) => unknown) | undefined {
  const holder = source === undefined ? undefined : asRecord(safeGet(source, objectName));
  return pickFunction(holder, methodNames);
}

function normalizeDisposer(result: unknown): HostDisposer {
  if (typeof result === 'function') {
    return { dispose: () => (result as () => void)() };
  }
  const record = asRecord(result);
  if (record !== undefined && typeof record.dispose === 'function') {
    const dispose = record.dispose as () => void | Promise<void>;
    return { dispose: () => dispose.call(result) };
  }
  return { dispose: () => undefined };
}

/**
 * Best-effort structural adapter over the documented Cordis capability seams.
 * Missing capabilities are omitted, so mounting that surface fails loudly with
 * seam_unavailable instead of silently pretending the surface exists.
 */
export function createCordisHostFromContext(ctx: unknown): CordisHostAdapter {
  const root = asRecord(ctx);
  const adapter: Record<string, unknown> = {};
  const fork = pickFunction(root, ['fork', 'forkBranch', 'forkContext']);
  if (fork !== undefined) {
    adapter.forkBranch = async (request: { branchId: string; sessionId: string; namespace: string }) => {
      const result = await fork.call(ctx, request);
      const record = asRecord(result);
      let disposed = false;
      return {
        branchId: request.branchId,
        namespace: request.namespace,
        contextId:
          record !== undefined && typeof record.contextId === 'string'
            ? record.contextId
            : 'ctx-' + request.branchId,
        get isDisposed(): boolean {
          return disposed;
        },
        dispose: async (): Promise<void> => {
          if (disposed) {
            return;
          }
          disposed = true;
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
  }

  const promptSegment = pickCapability(root, 'prompt', ['registerSegment']);
  if (promptSegment !== undefined) {
    adapter.registerPromptSegment = async (spec: Record<string, unknown>) => {
      const result = await promptSegment.call(asRecord(safeGet(ctx, 'prompt')), 'system', spec.content, spec);
      return normalizeDisposer(result);
    };
  }
  const permissions = pickCapability(root, 'permissions', ['register', 'addRule', 'guard']);
  if (permissions !== undefined) {
    adapter.registerGuardrails = async (spec: Record<string, unknown>) => {
      const result = await permissions.call(asRecord(safeGet(ctx, 'permissions')), spec);
      return normalizeDisposer(result);
    };
  }
  const memoryView = pickCapability(root, 'evoMemory', ['createScopedView', 'scopedView']);
  if (memoryView !== undefined) {
    adapter.registerMemoryScope = async (spec: Record<string, unknown>) => {
      const result = await memoryView.call(asRecord(safeGet(ctx, 'evoMemory')), spec.scopedViewId, spec);
      return normalizeDisposer(result);
    };
  }
  const patchDescriptions = pickCapability(root, 'tools', ['patchDescriptions', 'patchDescription']);
  if (patchDescriptions !== undefined) {
    adapter.patchToolGuidance = async (spec: Record<string, unknown>) => {
      const result = await patchDescriptions.call(asRecord(safeGet(ctx, 'tools')), spec.descriptions, spec);
      return normalizeDisposer(result);
    };
  }
  const mountSkill = pickCapability(root, 'skills', ['mountDynamic', 'mount']);
  if (mountSkill !== undefined) {
    adapter.mountSkills = async (spec: Record<string, unknown>) => {
      const result = await mountSkill.call(asRecord(safeGet(ctx, 'skills')), spec.skills, spec);
      return normalizeDisposer(result);
    };
  }
  const mountScript = pickCapability(root, 'sandbox', ['mountScript', 'writeFile']);
  if (mountScript !== undefined) {
    adapter.mountScripts = async (spec: Record<string, unknown>) => {
      const result = await mountScript.call(asRecord(safeGet(ctx, 'sandbox')), spec.scripts, spec);
      return normalizeDisposer(result);
    };
  }
  const registerSubagent = pickCapability(root, 'subagents', ['register', 'registerSubagent']);
  if (registerSubagent !== undefined) {
    adapter.registerSubagents = async (spec: Record<string, unknown>) => {
      const result = await registerSubagent.call(asRecord(safeGet(ctx, 'subagents')), spec.agents, spec);
      return normalizeDisposer(result);
    };
  }
  const useMiddleware = pickCapability(root, 'middleware', ['use', 'register']);
  if (useMiddleware !== undefined) {
    adapter.mountMiddleware = async (spec: Record<string, unknown>) => {
      const result = await useMiddleware.call(asRecord(safeGet(ctx, 'middleware')), spec.middleware, spec);
      return normalizeDisposer(result);
    };
  }
  const acquireSandbox = pickCapability(root, 'sandbox', ['acquireWorkspace', 'createWorkspace']);
  if (acquireSandbox !== undefined) {
    adapter.acquireSandbox = async (request: unknown) => {
      const result = await acquireSandbox.call(asRecord(safeGet(ctx, 'sandbox')), request);
      const record = asRecord(result);
      let disposed = false;
      return {
        id:
          record !== undefined && typeof record.id === 'string'
            ? record.id
            : 'sandbox-' + String((request as { branchId?: string }).branchId ?? 'unknown'),
        branchId: String((request as { branchId?: string }).branchId ?? 'unknown'),
        path: record !== undefined && typeof record.path === 'string' ? record.path : null,
        get isDisposed(): boolean {
          return disposed;
        },
        dispose: async (): Promise<void> => {
          if (disposed) {
            return;
          }
          disposed = true;
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
  }

  return adapter as CordisHostAdapter;
}

/** True when an adapter exposes at least one mountable seam. */
export function hostAdapterSeamCount(adapter: CordisHostAdapter): number {
  const keys: readonly (keyof CordisHostAdapter)[] = [
    'registerPromptSegment',
    'registerGuardrails',
    'registerMemoryScope',
    'patchToolGuidance',
    'mountSkills',
    'mountScripts',
    'registerSubagents',
    'mountMiddleware',
    'forkBranch',
    'acquireSandbox'
  ];
  let count = 0;
  for (const key of keys) {
    if (typeof (adapter as Record<string, unknown>)[key] === 'function') {
      count += 1;
    }
  }
  return count;
}

const OPTION_KEYS = [
  'model',
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
  'applyWinningPatch'
] as const;

/** Accept either a raw plugin config section or a full options object. */
export function normalizePluginOptions(
  second: unknown,
  ctxConfig: unknown
): EvoHarnessPluginOptions {
  const record = asRecord(second);
  if (record === undefined) {
    return second === undefined && ctxConfig !== undefined ? { config: ctxConfig } : {};
  }
  const looksLikeOptions = OPTION_KEYS.some((key) => record[key] !== undefined);
  if (looksLikeOptions) {
    return record as EvoHarnessPluginOptions;
  }
  return { config: second };
}

/** A model adapter that fails loudly; used when the host injects no LLM. */
export function missingModelAdapter(): IModelAdapter {
  return {
    async complete() {
      throw new Error('dsh-plugin-evo-harness: no model adapter was injected');
    }
  };
}

/** Build the orchestrator collaborators from the resolved plugin config. */
export function buildOrchestratorDeps(
  config: EvoHarnessConfig,
  options: EvoHarnessPluginOptions,
  ctx: unknown,
  diagnostics: string[]
): { deps: EvoHarnessOrchestratorDeps; hostAdapterSource: EvoHarnessPlugin['hostAdapterSource'] } {
  const now = options.now ?? ((): number => Date.now());
  let sequence = 0;
  const newId = options.newId ?? ((): string => {
    sequence += 1;
    return 'evo-' + String(sequence);
  });

  let hostAdapter: CordisHostAdapter;
  let hostAdapterSource: EvoHarnessPlugin['hostAdapterSource'];
  if (options.host !== undefined) {
    hostAdapter = options.host;
    hostAdapterSource = 'injected';
  } else {
    const derived = createCordisHostFromContext(ctx);
    if (hostAdapterSeamCount(derived) > 0) {
      hostAdapter = derived;
      hostAdapterSource = 'context';
    } else {
      hostAdapter = createInMemoryCordisHost();
      hostAdapterSource = 'in-memory';
      diagnostics.push(
        'no Cordis capability seams were discoverable on the host context; an in-process in-memory host adapter is mounted so the lifecycle still runs (inject options.host for real sandboxed probes)'
      );
    }
  }

  const treePool = options.deps?.treePool ?? createDiscoveryTreePool({ maxTrees: config.dreamRsi.maxTreePoolSize });
  const memory =
    options.deps?.memory ??
    createMemoryBridge({
      config: config.memoryBridge,
      ...(options.clients === undefined ? {} : { clients: options.clients }),
      ...(options.listClients === undefined ? {} : { listClients: options.listClients }),
      now
    });
  const seams =
    options.deps?.seams ??
    createCordisSeamManager({
      host: hostAdapter,
      namespacePrefix: config.memoryBridge.namespacePrefix,
      enabledSurfaces: config.enabledSurfaces,
      now,
      createBranchId: () => 'br-' + newId()
    });
  const policy =
    options.deps?.policy ??
    createActivePolicyFromDefaults(
      {
        maxWidth: config.dreamRsi.maxWidth,
        maxDepth: config.dreamRsi.maxDepth,
        earlyStopThreshold: config.dreamRsi.earlyStopThreshold,
        minMemoryConfidenceForSkip: config.dreamRsi.minMemoryConfidenceForSkip
      },
      { now, maxRecoverySlots: config.dreamRsi.maxRecoverySlots }
    );
  const model = options.deps?.proposer === undefined ? options.model ?? missingModelAdapter() : undefined;
  const proposer = options.deps?.proposer ?? createDualTrackProposer({ model: model as IModelAdapter, now, newId });
  const composer = options.deps?.composer ?? createAnonymousComposer({ model: model as IModelAdapter, now, newId });
  const reflector = options.deps?.reflector ?? createEvidenceReflector({ model: model as IModelAdapter, now, newId });
  const scorer = options.deps?.scorer ?? createSurrogateScorer({ defaultWeights: config.dreamRsi.surrogateWeights, now });
  const taxonomy = options.deps?.taxonomy ?? createFailureTaxonomy({});
  const dreamer =
    options.deps?.dreamer ??
    createOfflineDreamer({
      now,
      treePool,
      activePolicy: policy,
      policyCount: config.dreamRsi.candidatePoliciesCount,
      rhoPreferences: config.dreamRsi.rhoPreferences,
      modelAdapter: options.model
    });

  const deps: EvoHarnessOrchestratorDeps = {
    config,
    memory,
    seams,
    policy,
    proposer,
    composer,
    reflector,
    scorer,
    taxonomy,
    dreamer,
    treePool,
    runBranch: options.deps?.runBranch ?? options.runBranch ?? unconfiguredBranchExecutor(now),
    now,
    newId: () => 'evo-' + newId(),
    ...(options.commitScope === undefined ? {} : { commitScope: options.commitScope }),
    applyWinningPatch: options.applyWinningPatch ?? true,
    ...(options.deps ?? {})
  };

  return { deps, hostAdapterSource };
}

/** Deterministic runner used when the host injects none: a loud failure. */
export function unconfiguredBranchExecutor(now: () => number): BranchExecutor {
  return async (): Promise<ProbeExecutionResult> => {
    const message = 'no branch executor was injected; the host must supply options.runBranch';
    return {
      status: 'failed',
      steps: [{ index: 0, at: now(), kind: 'error', text: message }],
      failureSignals: [{ kind: 'unknown', message, repairable: false }],
      error: { name: 'EvoHarnessPluginError', message }
    };
  };
}

/**
 * Deferred collaborators.
 *
 * `resolveDshCollaborators` is asynchronous (it may resolve schemastery), but a
 * Cordis `apply` is synchronous. The orchestrator therefore receives stable
 * FORWARDING collaborator objects whose target is replaced once detection
 * settles: an early `ctx.llm` call still fails loudly with the documented
 * message instead of silently succeeding, and a later call uses the real
 * adapter. No run can observe a half-configured collaborator, because the
 * forwarding target is assigned before the first run can start.
 */
interface CollaboratorHolder {
  model?: IModelAdapter;
  runBranch?: BranchExecutor;
}

function forwardingModel(holder: CollaboratorHolder, missing: () => IModelAdapter): IModelAdapter {
  return {
    complete: (request) => (holder.model ?? missing()).complete(request)
  };
}

function forwardingBranch(holder: CollaboratorHolder, fallback: BranchExecutor): BranchExecutor {
  return async (context) => (holder.runBranch ?? fallback)(context);
}

/** Read the raw plugin config section, splitting out the host-only group. */
function readPluginSection(options: EvoHarnessPluginOptions, ctx: unknown): {
  readonly config: Record<string, unknown> | undefined;
  readonly modelRoute: Record<string, unknown> | undefined;
} {
  const raw = options.config ?? contextConfig(ctx);
  return splitModelRoute(raw);
}

/** Construct the plugin without touching a host context. */
export function createEvoHarnessPlugin(
  options: EvoHarnessPluginOptions = {},
  ctx?: unknown
): EvoHarnessPlugin {
  const section = readPluginSection(options, ctx);
  const resolved = parseEvoHarnessConfig(section.config ?? undefined);
  const diagnostics: string[] = [];
  const report = (message: string): void => {
    diagnostics.push(message);
  };

  /**
   * Effective model route: the plugin's own options win, then the resolved
   * `modelRoute` group from the settings page / cordis.patch.yml, then the
   * verified DSH default. Read with the bridge's reference-unwrapping reader so
   * a schemastery volatile reference yields its value.
   */
  const configuredRoute = resolveModelRouteConfig(section.modelRoute);
  const modelRoute: EvoHarnessModelRoute = {
    provider: options.route?.provider ?? configuredRoute.provider,
    model: options.route?.model ?? configuredRoute.model,
    reasoningEffort: options.route?.reasoningEffort ?? configuredRoute.reasoningEffort
  };

  const holder: CollaboratorHolder = {};
  if (options.model !== undefined) {
    holder.model = options.model;
  }
  if (options.runBranch !== undefined) {
    holder.runBranch = options.runBranch;
  }

  /**
   * Deferred client provider.
   *
   * The tools-backed MCP client only exists after collaborator detection
   * settles, and the memory bridge is constructed synchronously. The bridge
   * awaits `listClients` on its first initialize(), which is after detection,
   * so the DSH tool catalogue reaches auto-discovery without a race — and
   * without a fabricated client when ctx.tools is absent.
   */
  const deferredClients = async (): Promise<readonly McpClient[]> => {
    const detected = await collaborators;
    if (detected === undefined) {
      return options.clients ?? [];
    }
    return detected.clients;
  };

  // The orchestrator's three host-facing collaborators are forwarding objects;
  // the concrete targets arrive from resolveDshCollaborators below.
  const bridgeOptions: EvoHarnessPluginOptions = {
    ...options,
    model: forwardingModel(holder, () => options.model ?? missingModelAdapter()),
    runBranch: forwardingBranch(holder, unconfiguredBranchExecutor(() => Date.now())),
    ...(options.clients !== undefined || options.listClients !== undefined
      ? {}
      : { listClients: deferredClients })
  };
  const { deps, hostAdapterSource } = buildOrchestratorDeps(resolved, bridgeOptions, ctx, diagnostics);
  const orchestrator = createEvoHarnessOrchestrator(deps);
  const disposers: Array<() => void | Promise<void>> = [];
  const registeredCommands: string[] = [];
  const registeredEvents: string[] = [];
  const inFlight = new Set<string>();
  const triggerDisposers: Array<() => unknown> = [];
  /** Runs started by a trigger; `settle()` joins them for deterministic teardown. */
  const triggeredRuns = new Set<Promise<EvoHarnessRunResult | null>>();
  let disposed = false;

  /** Track one trigger-initiated run and collect its result on completion. */
  const trackRun = (run: Promise<EvoHarnessRunResult | null>): Promise<EvoHarnessRunResult | null> => {
    triggeredRuns.add(run);
    void run.catch(() => undefined).finally(() => {
      triggeredRuns.delete(run);
    });
    return run;
  };

  const log = (level: 'info' | 'warn', message: string): void => {
    const logger = asRecord(safeGet(ctx, 'logger'));
    const sink = logger === undefined ? undefined : safeGet(logger, level);
    if (typeof sink === 'function') {
      (sink as (value: string) => void).call(logger, message);
      return;
    }
    diagnostics.push(message);
  };

  /**
   * Collaborator detection. Resolved once and shared by every consumer; a
   * failure here is a diagnostic, never a mount failure.
   */
  const collaborators: Promise<DshCollaborators | undefined> = (async () => {
    if (options.resolveDshCollaborators === false) {
      report('DSH collaborator detection was disabled by options.resolveDshCollaborators=false');
      return undefined;
    }
    try {
      const resolvedCollaborators = await resolveDshCollaborators(ctx, {
        config: section.config,
        route: modelRoute,
        ...(options.route === undefined ? {} : { route: options.route }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.runBranch === undefined ? {} : { runBranch: options.runBranch }),
        ...(options.clients === undefined ? {} : { clients: options.clients }),
        onDiagnostic: report
      });
      if (holder.model === undefined && resolvedCollaborators.model !== undefined) {
        holder.model = resolvedCollaborators.model;
      }
      if (holder.runBranch === undefined) {
        holder.runBranch = resolvedCollaborators.runBranch;
      }
      report(
        'model route in effect: '
          + resolvedCollaborators.route.provider
          + '/'
          + resolvedCollaborators.route.model
          + ' (effort '
          + resolvedCollaborators.route.reasoningEffort
          + ')'
      );
      return resolvedCollaborators;
    } catch (error) {
      report(
        'DSH collaborator detection failed: '
          + (error instanceof Error ? error.name + ': ' + error.message : String(error))
      );
      return undefined;
    }
  })();

  // A rejection is already contained inside the async block above; this keeps a
  // fire-and-forget consumer from surfacing an unhandled rejection.
  void collaborators.catch(() => undefined);

  /** Build the recovery prompt from a verified failure observation. */
  const failurePrompt = (failure: DshFailureEvent): string => failure.summary;

  /** One auto_fallback run keyed by session, with an in-flight guard. */
  const runFallback = async (
    failure: DshFailureEvent
  ): Promise<EvoHarnessRunResult | null> => {
    if (resolved.triggerMode === 'slash_command') {
      report('triggerMode=slash_command: the failure observation was ignored');
      return null;
    }
    if (disposed) {
      return null;
    }
    const sessionId = failure.sessionId ?? 'session-unknown';
    if (inFlight.has(sessionId)) {
      report('auto_fallback: a run is already in flight for ' + sessionId + '; event ignored');
      return null;
    }
    inFlight.add(sessionId);
    try {
      return await orchestrator.run({
        sessionId,
        task: plugin.makeTask({ prompt: failurePrompt(failure) }),
        trigger: 'auto_fallback',
        metadata: {
          autoFallback: true,
          dshEvent: failure.dshEvent,
          dshFailureKind: failure.kind,
          failureSignals: failure.failureSignals,
          evidence: failure.evidence
        }
      });
    } catch (error) {
      report(
        'auto_fallback run failed: '
          + (error instanceof Error ? error.name + ': ' + error.message : String(error))
      );
      return null;
    } finally {
      inFlight.delete(sessionId);
    }
  };

  /** One 'always' run for a completed turn, with the same in-flight guard. */
  const runCompletedTurn = async (
    turn: DshCompletedTurnEvent
  ): Promise<EvoHarnessRunResult | null> => {
    if (resolved.triggerMode !== 'always' || disposed) {
      return null;
    }
    const sessionId = turn.sessionId ?? 'session-unknown';
    if (inFlight.has(sessionId)) {
      report('always: a run is already in flight for ' + sessionId + '; turn ignored');
      return null;
    }
    inFlight.add(sessionId);
    try {
      return await orchestrator.run({
        sessionId,
        task: plugin.makeTask({
          prompt: 'improve the completed turn' + (turn.turn === undefined ? '' : ' #' + String(turn.turn))
        }),
        trigger: 'always',
        metadata: {
          dshEvent: turn.dshEvent,
          completedTurn: turn.evidence
        }
      });
    } catch (error) {
      report(
        'always run failed: '
          + (error instanceof Error ? error.name + ': ' + error.message : String(error))
      );
      return null;
    } finally {
      inFlight.delete(sessionId);
    }
  };

  const plugin: EvoHarnessPlugin = {
    name: 'dsh-plugin-evo-harness',
    config: resolved,
    orchestrator,
    diagnostics,
    registeredCommands,
    registeredEvents,
    hostAdapterSource,
    modelRoute,
    collaborators,
    run: (request) => orchestrator.run(request),
    async runFromCommand(args: unknown, context?: unknown): Promise<EvoHarnessRunResult> {
      const record = asRecord(args);
      const prompt =
        typeof args === 'string' && args.trim().length > 0
          ? args
          : typeof record?.prompt === 'string'
            ? (record.prompt as string)
            : typeof record?.text === 'string'
              ? (record.text as string)
              : 'evolve the current task';
      const sessionId =
        typeof record?.sessionId === 'string'
          ? (record.sessionId as string)
          : typeof asRecord(context)?.sessionId === 'string'
            ? String((asRecord(context) as Record<string, unknown>).sessionId)
            : 'session-unknown';
      const task = plugin.makeTask({
        prompt,
        ...(typeof record?.taskId === 'string' ? { id: record.taskId as string } : {}),
        ...(typeof record?.taskSignature === 'string' ? { taskSignature: record.taskSignature as string } : {})
      });
      return orchestrator.run({ sessionId, task, trigger: 'slash_command' });
    },
    /**
     * Direct entry point for a failure observation from any transport.
     *
     * A host payload (the pre-fix shape with sessionId/task/failureSignals) is
     * normalized into a verified failure record; the runtime listeners use
     * handleTriggerFailure with an already-normalized observation.
     */
    async handleFallbackEvent(payload: unknown): Promise<EvoHarnessRunResult | null> {
      if (resolved.triggerMode === 'slash_command') {
        diagnostics.push('triggerMode=slash_command: the auto_fallback event was ignored');
        return null;
      }
      const record = asRecord(payload);
      const taskRecord = asRecord(record?.task);
      const supplied = record?.failureSignals;
      const sessionId =
        typeof record?.sessionId === 'string' ? (record.sessionId as string) : undefined;
      const prompt =
        typeof taskRecord?.prompt === 'string'
          ? (taskRecord.prompt as string)
          : typeof record?.prompt === 'string'
            ? (record.prompt as string)
            : typeof record?.message === 'string'
              ? (record.message as string)
              : 'recover from the reported failure';
      const failureSignals =
        Array.isArray(supplied) && supplied.length > 0
          ? (supplied as readonly { kind: string; message: string }[])
          : [{ kind: 'unknown', message: prompt }];
      return runFallback({
        source: 'session/event',
        kind: 'agent_error',
        dshEvent: 'handleFallbackEvent',
        ...(sessionId === undefined ? {} : { sessionId }),
        summary: prompt,
        failureSignals: failureSignals as DshFailureEvent['failureSignals'],
        evidence: {
          ...(typeof taskRecord?.id === 'string' ? { taskId: taskRecord.id } : {}),
          transport: 'direct'
        }
      });
    },
    handleTriggerFailure: (failure) => trackRun(runFallback(failure)),
    handleTurnCompleted: (turn) => trackRun(runCompletedTurn(turn)),
    async settle(): Promise<readonly EvoHarnessRunResult[]> {
      const results: EvoHarnessRunResult[] = [];
      // A run can start another only through a later event, so one pass over
      // the live set is enough; loop anyway in case a run re-enters it.
      while (triggeredRuns.size > 0) {
        const pending = [...triggeredRuns];
        for (const settled of await Promise.all(pending)) {
          if (settled !== null) {
            results.push(settled);
          }
        }
      }
      return results;
    },
    makeTask(input): ProbeTask {
      const base = input.id ?? 'task-' + input.prompt.slice(0, 32);
      return {
        id: base,
        prompt: input.prompt,
        ...(input.taskSignature === undefined ? {} : { taskSignature: input.taskSignature }),
        ...(input.contextTags === undefined ? {} : { contextTags: input.contextTags })
      };
    },
    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      // Let in-flight trigger runs finish before tearing the orchestrator down,
      // so a run started by the last event is not aborted mid-flight.
      if (triggeredRuns.size > 0) {
        try {
          await Promise.all([...triggeredRuns]);
        } catch {
          // individual runs already report their own failure
        }
      }
      for (const dispose of triggerDisposers) {
        try {
          await dispose();
        } catch {
          // a host disposer failure must not strand teardown
        }
      }
      triggerDisposers.length = 0;
      for (const dispose of disposers) {
        try {
          await dispose();
        } catch {
          // ignore
        }
      }
      disposers.length = 0;
      await orchestrator.dispose();
    }
  };

  // DSH's own command service takes precedence: ctx.commands.register({ name,
  // description, handler }) validates the definition and returns the exact
  // effect disposer that unregisters it when the fiber unloads.
  const commandsService = asRecord(safeGet(ctx, 'commands'));
  const dshRegister = pickFunction(commandsService, ['register']);
  if (dshRegister !== undefined) {
    try {
      const result = dshRegister.call(commandsService, {
        name: EVO_COMMAND_NAME,
        description: 'Run a test-time self-evolution pass over the current task',
        input: { hint: '<task prompt | blank recovers the current task>' },
        handler: (invocation: unknown) => handleDshCommand(plugin, invocation)
      });
      const normalized = normalizeDisposer(result);
      disposers.push(() => normalized.dispose());
      registeredCommands.push(EVO_COMMAND_NAME);
      log('info', 'evo-harness: registered /' + EVO_COMMAND_NAME + ' through ctx.commands');
    } catch (error) {
      diagnostics.push('failed to register /evo with ctx.commands: ' + String(error));
    }
  }

  const registerCommand = pickFunction(asRecord(ctx), ['registerCommand', 'command', 'addCommand']);
  if (registeredCommands.length === 0 && registerCommand !== undefined) {
    try {
      const result = registerCommand.call(ctx, EVO_COMMAND_NAME, (args: unknown, context?: unknown) =>
        plugin.runFromCommand(args, context)
      );
      const normalized = normalizeDisposer(result);
      disposers.push(() => normalized.dispose());
      registeredCommands.push(EVO_COMMAND_NAME);
      log('info', 'evo-harness: registered /' + EVO_COMMAND_NAME + ' slash command');
    } catch (error) {
      diagnostics.push('failed to register the /evo command: ' + String(error));
    }
  } else if (registeredCommands.length === 0) {
    diagnostics.push(
      'the host context exposes no command registrar; plugin.runFromCommand(args) is the fallback entrypoint for /evo'
    );
  }

  // Verified DSH triggers only: session/event (tool/result errors, turn/end
  // errors, and — under 'always' — turn/end 'completed'), agent/error, and
  // agent/status 'idle' for the optional offline dream.
  if (options.registerAutoFallback === false) {
    diagnostics.push('trigger registration was disabled by options.registerAutoFallback=false');
  } else {
    const dreamEnabled = options.enableIdleDream !== false;
    // Zero-execution replay of the retained trees. The dreamer's own policy
    // generator produces the candidates when none are supplied, which is
    // exactly what the orchestrator's in-run dream does.
    const dreamRun = async (): Promise<unknown> => {
      if (options.dream !== undefined) {
        return options.dream();
      }
      const trees = orchestrator.treePool.list();
      if (trees.length === 0) {
        return undefined;
      }
      return deps.dreamer.replay({
        trees,
        baselinePolicy: deps.policy.policy,
        candidatePolicies: []
      });
    };
    const registration: DshTriggerRegistration = registerDshTriggers(ctx, {
      triggerMode: resolved.triggerMode,
      onFailure: (failure) => plugin.handleTriggerFailure(failure),
      onTurnCompleted: (turn) => plugin.handleTurnCompleted(turn),
      ...(dreamEnabled
        ? {
            dream: {
              // Gate on retained material: replaying zero trees is pointless.
              hasMaterial: () => orchestrator.treePool.list().length > 0,
              run: dreamRun,
              onDiagnostic: report
            }
          }
        : {}),
      agents: () => {
        const agentsService = asRecord(safeGet(ctx, 'agents'));
        const list = pickFunction(agentsService, ['list']);
        if (list === undefined) {
          return [];
        }
        try {
          const live = list.call(agentsService);
          return Array.isArray(live) ? live : [];
        } catch {
          return [];
        }
      },
      ...(options.autoFallbackEvents === undefined
        ? {}
        : { legacyEvents: options.autoFallbackEvents }),
      onDiagnostic: report
    });
    for (const name of registration.events) {
      registeredEvents.push(name);
    }
    for (const dispose of registration.disposers) {
      triggerDisposers.push(dispose);
    }
    if (registration.events.length > 0) {
      log(
        'info',
        'evo-harness: triggerMode=' + resolved.triggerMode + ' subscribed to ' + registration.events.join(', ')
      );
    }
  }
  if (options.autoFallbackEvents !== undefined && options.registerAutoFallback !== false) {
    diagnostics.push(
      'options.autoFallbackEvents overrides the verified DSH trigger list; the names supplied are not verified DSH events'
    );
  }

  // Exposing the handle is best-effort: a live Cordis context only accepts a
  // service registration from a fiber that owns it ("cannot provide ... in
  // inactive context"), so a throw here records a diagnostic instead of failing
  // the whole mount. Plain object contexts get the property fallback.
  const provide = pickFunction(asRecord(ctx), ['provide', 'set', 'expose']);
  let exposed = false;
  if (provide !== undefined) {
    try {
      provide.call(ctx, 'evoHarness', plugin);
      exposed = true;
    } catch (error) {
      diagnostics.push('failed to expose the evoHarness service: ' + String(error));
    }
  }
  if (!exposed) {
    const record = asRecord(ctx);
    if (record !== undefined && !Object.isFrozen(record)) {
      try {
        record.evoHarness = plugin;
        exposed = true;
      } catch (error) {
        diagnostics.push('failed to attach the evoHarness service: ' + String(error));
      }
    }
  }
  if (!exposed && diagnostics.length > 0) {
    diagnostics.push(
      'the host exposes no writable service registrar; use the mounted handle returned by apply()'
    );
  }

  // Cordis ignores the `apply` return value: the disposers collected above only
  // run when the fiber unloads if they are registered as a fiber effect. Without
  // this, a reload would leave the /evo command and the failure listeners
  // registered against a dead fiber.
  const registerEffect = pickFunction(asRecord(ctx), ['effect']);
  if (registerEffect !== undefined) {
    try {
      registerEffect.call(ctx, () => () => plugin.dispose());
    } catch (error) {
      diagnostics.push('failed to register the fiber disposal effect: ' + String(error));
    }
  }

  return plugin;
}

/**
 * DSH command adapter: turn one `/evo` invocation into a run result.
 *
 * DSH's command service calls the handler with an invocation object that
 * carries `rawInput` plus the receiving agent. The handler must return a
 * `{ kind: 'success' | 'error', text }` result instead of throwing, so a
 * failed evolution pass is reported in the transcript rather than killing the
 * command.
 */
function handleDshCommand(
  mounted: EvoHarnessPlugin,
  invocation: unknown
): Promise<{ kind: 'success' | 'error'; text: string }> {
  const record = asRecord(invocation);
  const rawInput = typeof record?.rawInput === 'string' ? (record.rawInput as string) : '';
  const agent = asRecord(record?.agent);
  const sessionId =
    typeof agent?.sessionId === 'string'
      ? (agent.sessionId as string)
      : typeof record?.sessionId === 'string'
        ? (record.sessionId as string)
        : 'session-unknown';
  return mounted
    .runFromCommand({ prompt: rawInput.trim(), sessionId })
    .then((result) => ({
      kind: 'success' as const,
      text: [
        '/evo ' + result.outcome + ' on task ' + result.taskId,
        'probes run: ' + String(result.probesRun) + ', lessons committed: ' + String(result.lessonsCommitted)
      ].join('\n')
    }))
    .catch((error: unknown) => ({
      kind: 'error' as const,
      text: '/evo failed: ' + (error instanceof Error ? error.message : String(error))
    }));
}
/** Standard Cordis plugin entrypoint. */
export function apply(ctx: unknown, optionsOrConfig?: unknown): EvoHarnessPlugin {
  const normalized = normalizePluginOptions(optionsOrConfig, contextConfig(ctx));
  return createEvoHarnessPlugin(normalized, ctx);
}

/** Plugin name shared by the default export and the plugin handle. */
export const PLUGIN_NAME = 'dsh-plugin-evo-harness';

/** Cordis services this plugin requires before it can mount. */
export const inject = pluginInject;

/**
 * The Cordis plugin export.
 *
 * `Config` is what makes the second-level settings page render the
 * provider/model/reasoningEffort pickers: Cordis reads
 * `runtime.Config['~standard'].validate(config)` at load time and
 * `Config['simplify']` when persisting an entry.
 */
export const plugin = { name: PLUGIN_NAME, inject, Config, apply };

export default plugin;

/** Re-exported for hosts that resolve the trigger mode themselves. */
export type EvoHarnessTrigger = TriggerMode;
export { CONFIG_SCHEMA_VERSION, validateEvoHarnessConfig };
