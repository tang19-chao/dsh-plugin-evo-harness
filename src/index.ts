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
 *   - ctx.on                              -> auto_fallback failure events
 *   - ctx.prompt/tools/skills/sandbox/subagents/middleware/evoMemory/fork
 *                                         -> the eight Cordis capability seams
 *   - ctx.logger / ctx.provide            -> diagnostics and service exposure
 * When no host seam is discoverable the plugin mounts an in-process in-memory
 * host adapter so the lifecycle still runs deterministically; this is recorded in
 * plugin.diagnostics and never silently pretends to be a real sandbox.
 */
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

/** Host events the auto_fallback hook subscribes to by default. */
export const DEFAULT_AUTO_FALLBACK_EVENTS = ['task:failed', 'tool:error'] as const;

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
  /** Subscribe failure events for auto_fallback; defaults to true. */
  readonly registerAutoFallback?: boolean;
  readonly autoFallbackEvents?: readonly string[];
  readonly applyWinningPatch?: boolean;
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
  run(request: EvoHarnessRunRequest): Promise<EvoHarnessRunResult>;
  runFromCommand(args: unknown, context?: unknown): Promise<EvoHarnessRunResult>;
  handleFallbackEvent(payload: unknown): Promise<EvoHarnessRunResult | null>;
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

function pickFunction(
  source: Record<string, unknown> | undefined,
  names: readonly string[]
): ((...args: unknown[]) => unknown) | undefined {
  if (source === undefined) {
    return undefined;
  }
  for (const name of names) {
    const candidate = source[name];
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
  const holder = source === undefined ? undefined : asRecord(source[objectName]);
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
      const result = await promptSegment.call(asRecord(ctx)?.prompt, 'system', spec.content, spec);
      return normalizeDisposer(result);
    };
  }
  const permissions = pickCapability(root, 'permissions', ['register', 'addRule', 'guard']);
  if (permissions !== undefined) {
    adapter.registerGuardrails = async (spec: Record<string, unknown>) => {
      const result = await permissions.call(asRecord(ctx)?.permissions, spec);
      return normalizeDisposer(result);
    };
  }
  const memoryView = pickCapability(root, 'evoMemory', ['createScopedView', 'scopedView']);
  if (memoryView !== undefined) {
    adapter.registerMemoryScope = async (spec: Record<string, unknown>) => {
      const result = await memoryView.call(asRecord(ctx)?.evoMemory, spec.scopedViewId, spec);
      return normalizeDisposer(result);
    };
  }
  const patchDescriptions = pickCapability(root, 'tools', ['patchDescriptions', 'patchDescription']);
  if (patchDescriptions !== undefined) {
    adapter.patchToolGuidance = async (spec: Record<string, unknown>) => {
      const result = await patchDescriptions.call(asRecord(ctx)?.tools, spec.descriptions, spec);
      return normalizeDisposer(result);
    };
  }
  const mountSkill = pickCapability(root, 'skills', ['mountDynamic', 'mount']);
  if (mountSkill !== undefined) {
    adapter.mountSkills = async (spec: Record<string, unknown>) => {
      const result = await mountSkill.call(asRecord(ctx)?.skills, spec.skills, spec);
      return normalizeDisposer(result);
    };
  }
  const mountScript = pickCapability(root, 'sandbox', ['mountScript', 'writeFile']);
  if (mountScript !== undefined) {
    adapter.mountScripts = async (spec: Record<string, unknown>) => {
      const result = await mountScript.call(asRecord(ctx)?.sandbox, spec.scripts, spec);
      return normalizeDisposer(result);
    };
  }
  const registerSubagent = pickCapability(root, 'subagents', ['register', 'registerSubagent']);
  if (registerSubagent !== undefined) {
    adapter.registerSubagents = async (spec: Record<string, unknown>) => {
      const result = await registerSubagent.call(asRecord(ctx)?.subagents, spec.agents, spec);
      return normalizeDisposer(result);
    };
  }
  const useMiddleware = pickCapability(root, 'middleware', ['use', 'register']);
  if (useMiddleware !== undefined) {
    adapter.mountMiddleware = async (spec: Record<string, unknown>) => {
      const result = await useMiddleware.call(asRecord(ctx)?.middleware, spec.middleware, spec);
      return normalizeDisposer(result);
    };
  }
  const acquireSandbox = pickCapability(root, 'sandbox', ['acquireWorkspace', 'createWorkspace']);
  if (acquireSandbox !== undefined) {
    adapter.acquireSandbox = async (request: unknown) => {
      const result = await acquireSandbox.call(asRecord(ctx)?.sandbox, request);
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

/** Construct the plugin without touching a host context. */
export function createEvoHarnessPlugin(
  options: EvoHarnessPluginOptions = {},
  ctx?: unknown
): EvoHarnessPlugin {
  const resolved = parseEvoHarnessConfig(options.config ?? (asRecord(ctx)?.config ?? undefined));
  const diagnostics: string[] = [];
  const { deps, hostAdapterSource } = buildOrchestratorDeps(resolved, options, ctx, diagnostics);
  const orchestrator = createEvoHarnessOrchestrator(deps);
  const disposers: Array<() => void | Promise<void>> = [];
  const registeredCommands: string[] = [];
  const registeredEvents: string[] = [];
  const inFlight = new Set<string>();

  const log = (level: 'info' | 'warn', message: string): void => {
    const logger = asRecord(ctx)?.logger;
    const sink = logger === undefined ? undefined : (logger as Record<string, unknown>)[level];
    if (typeof sink === 'function') {
      (sink as (value: string) => void).call(logger, message);
      return;
    }
    diagnostics.push(message);
  };

  const plugin: EvoHarnessPlugin = {
    name: 'dsh-plugin-evo-harness',
    config: resolved,
    orchestrator,
    diagnostics,
    registeredCommands,
    registeredEvents,
    hostAdapterSource,
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
    async handleFallbackEvent(payload: unknown): Promise<EvoHarnessRunResult | null> {
      if (resolved.triggerMode === 'slash_command') {
        diagnostics.push('triggerMode=slash_command: the auto_fallback event was ignored');
        return null;
      }
      const record = asRecord(payload);
      const sessionId =
        typeof record?.sessionId === 'string' ? (record.sessionId as string) : 'session-unknown';
      if (inFlight.has(sessionId)) {
        diagnostics.push('auto_fallback: a run is already in flight for ' + sessionId + '; event ignored');
        return null;
      }
      const taskRecord = asRecord(record?.task);
      const failureSignals = record?.failureSignals;
      const prompt =
        typeof taskRecord?.prompt === 'string'
          ? (taskRecord.prompt as string)
          : typeof record?.prompt === 'string'
            ? (record.prompt as string)
            : typeof record?.message === 'string'
              ? (record.message as string)
              : 'recover from the reported failure';
      inFlight.add(sessionId);
      try {
        return await orchestrator.run({
          sessionId,
          task: plugin.makeTask({
            prompt,
            ...(typeof taskRecord?.id === 'string' ? { id: taskRecord.id as string } : {})
          }),
          trigger: 'auto_fallback',
          metadata: {
            autoFallback: true,
            ...(failureSignals === undefined ? {} : { failureSignals }),
            ...(record?.toolErrors === undefined ? {} : { toolErrors: record.toolErrors })
          }
        });
      } finally {
        inFlight.delete(sessionId);
      }
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

  const registerCommand = pickFunction(asRecord(ctx), ['registerCommand', 'command', 'addCommand']);
  if (registerCommand !== undefined) {
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
  } else {
    diagnostics.push(
      'the host context exposes no command registrar; plugin.runFromCommand(args) is the fallback entrypoint for /evo'
    );
  }

  if (options.registerAutoFallback !== false && resolved.triggerMode === 'slash_command') {
    diagnostics.push(
      'triggerMode=slash_command: auto_fallback listeners were not registered; /evo remains the only entrypoint'
    );
  } else if (options.registerAutoFallback !== false) {
    const on = pickFunction(asRecord(ctx), ['on', 'onEvent', 'subscribe']);
    const events = options.autoFallbackEvents ?? DEFAULT_AUTO_FALLBACK_EVENTS;
    if (on !== undefined) {
      for (const event of events) {
        try {
          const result = on.call(ctx, event, (payload: unknown) => plugin.handleFallbackEvent(payload));
          const normalized = normalizeDisposer(result);
          disposers.push(() => normalized.dispose());
          registeredEvents.push(event);
        } catch (error) {
          diagnostics.push('failed to subscribe to "' + event + '": ' + String(error));
        }
      }
      if (registeredEvents.length > 0) {
        log('info', 'evo-harness: auto_fallback subscribed to ' + registeredEvents.join(', '));
      }
    } else {
      diagnostics.push(
        'the host context exposes no event subscriber; call plugin.handleFallbackEvent(payload) for auto_fallback'
      );
    }
  }

  const provide = pickFunction(asRecord(ctx), ['provide', 'set', 'expose']);
  if (provide !== undefined) {
    try {
      provide.call(ctx, 'evoHarness', plugin);
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
  }

  return plugin;
}

/** Standard Cordis plugin entrypoint. */
export function apply(ctx: unknown, optionsOrConfig?: unknown): EvoHarnessPlugin {
  const normalized = normalizePluginOptions(optionsOrConfig, asRecord(ctx)?.config);
  return createEvoHarnessPlugin(normalized, ctx);
}

/** Plugin name shared by the default export and the plugin handle. */
export const PLUGIN_NAME = 'dsh-plugin-evo-harness';

export const plugin = { name: PLUGIN_NAME, apply };

export default plugin;

/** Re-exported for hosts that resolve the trigger mode themselves. */
export type EvoHarnessTrigger = TriggerMode;
export { CONFIG_SCHEMA_VERSION, validateEvoHarnessConfig };
