/**
 * MCP entry assembly (rev8 plan §5.1 / §5.7, stage 1).
 *
 * WHAT THIS IS
 *   The ctx-free assembly the future MCP stdio server reuses. It builds the SAME
 *   plugin the Cordis entry builds — through {@link createEvoHarnessPlugin}, not
 *   a copy of its wiring — with the host-dependent collaborators fixed to the
 *   values an MCP process actually has:
 *
 *   - host: a fresh {@link createInMemoryCordisHost}. The eight-surface seam
 *     lifecycle still runs and stays auditable, but every mount lands in memory
 *     only (plan §5.7: "八面 patch 只进内存记录"). Note the mountable statuses
 *     stay `true` — the in-memory host implements every host method — which is
 *     the honest state; the observable safety property is that
 *     `activeEffects()` is empty after every run, not a fake `mountable=false`.
 *   - clients: `[]`. A stdio MCP process has no ctx.tools, so the memory bridge
 *     starts unbound (bridge.ts keeps its degraded, non-failing semantics).
 *   - resolveDshCollaborators: false. Collaborator detection needs a live host
 *     context; the plan's recommended bypass (§5.1) is this documented switch
 *     (src/index.ts options), which also skips the async detection IIFE.
 *   - registerAutoFallback / enableIdleDream: false. MCP is pull-mode; there are
 *     no host events to subscribe and no idle dream hook (plan §4.1 "丢失").
 *   - executionProfile: pinned to shadow via a config-level guard (see below).
 *
 * WHAT THE CALLER SUPPLIES
 *   - config: an already-resolved EvoHarnessConfig, or a raw section parsed
 *     through parseEvoHarnessConfig (the single merge path; never a manual
 *     deep-merge that could drift from config.ts validation).
 *   - model: the explicit IModelAdapter. It is injected both as `options.model`
 *     and as `agentLoop.model`, so the agent-loop probe executor runs probes in
 *     its single_call degradation (plan §5.1: "首版不注入 tools") and the
 *     JitRL kernel's step judge sees the same adapter (rev6 A4-4/B3). An
 *     explicitly supplied `runBranch` in the caller extras still wins over the
 *     agent-loop executor — that precedence is the plugin's own (src/index.ts
 *     P0-1), never re-implemented here.
 *
 * SAFETY DEFAULTS (plan §5.7 — process constants, not tool-input switches)
 *   The caller's config is parsed through parseEvoHarnessConfig, whose
 *   validation (config.ts:1263-1271) refuses `applyWinningPatch: true` unless
 *   `execution.mode === 'guarded-active'`, so a caller cannot promote
 *   applyWinningPatch into any non-shadow mode through this assembly. The
 *   resolved config's execution group is then overwritten with the shadow
 *   constants AFTER parsing (mode 'shadow', applyWinningPatch false), and
 *   `jitrl.store.mirrorToMemoryBridge` is pinned to false — the plan forbids a
 *   caller promoting execution.mode, applyWinningPatch or the mirror request
 *   out of the shadow shape. The resolved ExecutionProfile the orchestrator
 *   receives therefore comes from resolveExecutionProfile({mode:'shadow'}).
 *   No config field and no option reaches this module that can widen the patch,
 *   publish or memory permissions (resolveExecutionProfile denies publish and
 *   memory in every shape; memoryRealWrites is never set here).
 *
 *   One additive guard beyond the config path: `options.deps.executionProfile`
 *   is the documented TEST seam that replaces the resolved profile wholesale
 *   (src/index.ts buildOrchestratorDeps t12/R1c). A caller supplying it through
 *   this assembly would widen exactly what the shadow pin narrows, so that one
 *   deps key is refused with a named error. Every other `deps` override passes
 *   through untouched.
 *
 * PERSISTENCE (plan §5.7)
 *   A fresh PersistenceRuntime is created per assembly from the caller's data
 *   directory options. The default resolution is exactly resolveProfileDataDir's
 *   documented precedence: an explicit dataDir, then EVO_HARNESS_DATA_DIR /
 *   DSH_DATA_DIR / ~/.dsh/evo-harness with `profiles/<profile>` appended (the
 *   profile name from `profile` or DSH_PROFILE, sanitized; 'default' when
 *   stdio scrubbing removed DSH_*). Nothing here points at the real plugin
 *   profile directory by default, so the MCP data directory stays physically
 *   isolated from the Cordis plugin's. Creation failure propagates to the
 *   caller (fail fast, before any run can write) — the durability of an
 *   explicit MCP deployment is an operator decision, not a silent in-memory
 *   fallback. The runtime is flushed and disposed by dispose(); the plugin's
 *   own dispose flushes it first (plugin owns flush-on-dispose), so dispose()
 *   here is a second barrier plus the runtime's own teardown, in an order that
 *   survives either one failing (both errors propagate).
 */

import type { EvoHarnessConfig } from '../config';
import { parseEvoHarnessConfig } from '../config';
import {
  createEvoHarnessPlugin,
  type EvoHarnessPlugin,
  type EvoHarnessPluginOptions
} from '../index';
import { createInMemoryCordisHost, type InMemoryCordisHost } from '../cordis-seams';
import {
  createPersistenceRuntime,
  resolvePersistenceDataDir,
  type PersistenceRuntime,
  type PersistenceRuntimeOptions
} from '../persistence';
import { DSH_DATA_ROOT_ENV, EVO_HARNESS_DATA_ROOT_ENV } from '../persistence/data-dir';
import type { IModelAdapter } from '../types/contracts';

/**
 * The MCP execution constants (plan §5.7). Exported so a test — or a future
 * server-side status tool — can assert the assembly enforces them without
 * re-deriving the literals.
 */
export const MCP_EXECUTION_DEFAULTS = {
  mode: 'shadow',
  applyWinningPatch: false
} as const;

/**
 * Data-directory options for one MCP assembly. They are a subset of
 * PersistenceRuntimeOptions: `env` overrides the environment lookups
 * (EVO_HARNESS_DATA_DIR / DSH_DATA_DIR / DSH_PROFILE), so tests never touch the
 * real process environment.
 */
export interface McpDataDirOptions {
  /** Explicit final directory; wins over rootDir/profile/env (precedence 1). */
  readonly dataDir?: string;
  /** Persistence root that contains 'profiles/<name>' (precedence 2). */
  readonly rootDir?: string;
  /** DSH profile name; DSH_PROFILE then 'default' are the fallbacks. */
  readonly profile?: string;
  /** Environment snapshot; defaults to process.env (tests pass a fake). */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Everything the MCP entry passes to one assembly. */
export interface EvoAssemblyInput {
  /**
   * Already-resolved plugin configuration, or a raw section. Raw sections are
   * parsed with parseEvoHarnessConfig (the single merge path — a manual merge
   * here could drift from config.ts validation and is deliberately absent).
   */
  readonly config?: EvoHarnessConfig | unknown;
  /** Explicit model adapter; required for probes to produce a deliverable. */
  readonly model: IModelAdapter;
  /**
   * Non-secret diagnostics channel (rev8 review nice-to-have: the inherited
   * DSH_DATA_DIR warning). Defaults to stderr through the caller; tests
   * inject a recorder. Warnings never carry key material — only env NAMES.
   */
  readonly log?: (line: string) => void;
  /**
   * Caller extras merged into the plugin options. `model`, `host`, `clients`,
   * `resolveDshCollaborators`, `registerAutoFallback` and `enableIdleDream` are
   * pinned by this assembly and rejected here — an explicit refusal keeps the
   * override surface honest instead of silently ignoring a key. `runBranch`
   * passes through: the plugin's own precedence (explicit host runner beats the
   * agent-loop executor) stays authoritative.
   */
  readonly options?: Omit<
    EvoHarnessPluginOptions,
    | 'model'
    | 'host'
    | 'clients'
    | 'listClients'
    | 'resolveDshCollaborators'
    | 'registerAutoFallback'
    | 'enableIdleDream'
    | 'persistence'
  >;
  /** Data-directory resolution for the fresh PersistenceRuntime. */
  readonly dataDir?: McpDataDirOptions;
  /** Injected clock; shared by the plugin and the persistence runtime. */
  readonly now?: () => number;
}

/** One assembled, independently persisted MCP runtime. */
export interface EvoAssembly {
  /** The mounted plugin handle (the SAME object createEvoHarnessPlugin builds). */
  readonly plugin: EvoHarnessPlugin;
  /** The in-memory host the eight surfaces mounted into. */
  readonly host: InMemoryCordisHost;
  /** The fresh persistence runtime backing the tree pool / policy / counters. */
  readonly persistence: PersistenceRuntime;
  /** The resolved final data directory (persistence.dataDir, post-resolution). */
  readonly dataDir: string;
  /**
   * Idempotent teardown: plugin.dispose() first (which flushes persistence and
   * joins trigger runs), then persistence.dispose(). Every step is attempted
   * even when a previous one threw; dispose is a no-op after the first call.
   */
  readonly dispose: () => Promise<void>;
}

/**
 * Option keys this assembly pins. A caller attempt to override one of them
 * through `options` is refused with a named error instead of being dropped.
 */
const PINNED_OPTION_KEYS = new Set<string>([
  'model',
  'host',
  'clients',
  'listClients',
  'resolveDshCollaborators',
  'registerAutoFallback',
  'enableIdleDream',
  'persistence'
]);

/**
 * Merge the pinned execution group over a parsed config and pin the shadow
 * profile. Exported for tests; callers go through {@link buildEvoAssembly}.
 */
function withMcpExecutionDefaults(config: EvoHarnessConfig): EvoHarnessConfig {
  // The parsed config is a fresh merged object (buildConfig deep-merges over a
  // fresh createDefaultConfig()), so overwriting these leaves here does not
  // touch DEFAULT_EVO_HARNESS_CONFIG.
  const pinned = {
    ...config,
    execution: {
      ...config.execution,
      mode: MCP_EXECUTION_DEFAULTS.mode,
      applyWinningPatch: MCP_EXECUTION_DEFAULTS.applyWinningPatch
    },
    jitrl: {
      ...config.jitrl,
      store: {
        ...config.jitrl.store,
        mirrorToMemoryBridge: false
      }
    }
  };
  return pinned;
}

/**
 * Build one MCP assembly: plugin + in-memory host + fresh persistence runtime
 * + idempotent dispose.
 *
 * Async because the persistence runtime is created asynchronously (durability
 * failure propagates — see the module header). The returned assembly's runs are
 * synchronous to start; `plugin.jitrl` cold-start hydration is awaited inside
 * each run by the plugin itself.
 */
export async function buildEvoAssembly(input: EvoAssemblyInput): Promise<EvoAssembly> {
  if (input.model === undefined) {
    throw new Error(
      'buildEvoAssembly: an explicit model adapter is required; the MCP entry has no ctx.llm fallback'
    );
  }
  const extras = input.options ?? {};
  for (const key of Object.keys(extras)) {
    if (PINNED_OPTION_KEYS.has(key)) {
      throw new Error(
        'buildEvoAssembly: options.' +
          key +
          ' is pinned by the MCP assembly (shadow in-memory host, clients=[], collaborators off, ' +
          'triggers off, own persistence) and cannot be overridden'
      );
    }
  }
  if (extras.deps?.executionProfile !== undefined) {
    throw new Error(
      'buildEvoAssembly: options.deps.executionProfile would replace the resolved shadow profile ' +
        '(the documented test seam); the MCP assembly pins the execution profile and cannot accept it'
    );
  }

  // --- config: parseEvoHarnessConfig is the single merge path ---------------
  // A raw section is validated and merged against the frozen defaults here; an
  // already-resolved config is re-validated (it parses identically) so both
  // shapes go through the same code path. Validation failure throws
  // ConfigValidationError to the caller — a misconfigured MCP deployment must
  // fail to start, not silently run on defaults.
  const parsed = parseEvoHarnessConfig(
    input.config === undefined
      ? undefined
      : (input.config as EvoHarnessConfig)
  );
  // Plan §5.7: the MCP process runs shadow no matter what the config declared.
  // applyWinningPatch=true + mode!=='guarded-active' was already refused by
  // validation; even a guarded-active parsed config is pinned back to the
  // shadow constants below, and buildOrchestratorDeps resolves its
  // ExecutionProfile from config.execution.mode ('shadow'), which hard-deny the
  // patch/publish/memory layers.
  const config = withMcpExecutionDefaults(parsed);

  // --- persistence: fresh runtime, documented data-dir precedence ----------
  const persistenceOptions: PersistenceRuntimeOptions = {
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.dataDir === undefined
      ? {}
      : {
          ...(input.dataDir.dataDir === undefined ? {} : { dataDir: input.dataDir.dataDir }),
          ...(input.dataDir.rootDir === undefined ? {} : { rootDir: input.dataDir.rootDir }),
          ...(input.dataDir.profile === undefined ? {} : { profile: input.dataDir.profile }),
          ...(input.dataDir.env === undefined ? {} : { env: input.dataDir.env })
        })
  };
  // ISOLATION WARNING (rev8 review nice-to-have, data-dir.ts:22-27): the
  // default root resolution FALLS BACK to DSH_DATA_DIR. The stdio env
  // scrubbing (dsh-subprocess) deletes DSH_* before the MCP child starts, so
  // a DSH_DATA_DIR that IS present here was passed through EXPLICITLY by the
  // deployment — and with no explicit dataDir/rootDir to redirect it, the MCP
  // assembly would resolve the SAME profiles/<profile> directory the Cordis
  // plugin uses, breaking the single-writer assumption (last-writer-wins /
  // JSONL tear). Never silent, never fatal: the operator may genuinely want a
  // shared root (shared data root is fine; only the profile dir is not), so
  // this is a named warning, not a refusal. Only env NAMES appear in the
  // message, never values.
  const envSnapshot = input.dataDir?.env;
  const dataRootExplicit =
    input.dataDir?.dataDir !== undefined || input.dataDir?.rootDir !== undefined;
  const inheritedDshRoot = envSnapshot?.[DSH_DATA_ROOT_ENV];
  if (!dataRootExplicit && typeof inheritedDshRoot === 'string' && inheritedDshRoot.length > 0) {
    const line =
      'evo-mcp: ' +
      DSH_DATA_ROOT_ENV +
      ' is set in the server environment and no explicit dataDir/rootDir was configured; ' +
      'the assembly would resolve the SAME profiles/<profile> directory the Cordis plugin uses ' +
      '(single-host assumption, src/persistence/data-dir.ts). Set ' +
      EVO_HARNESS_DATA_ROOT_ENV +
      ' (or dataDir) to an independent root — see plan §5.7.';
    if (input.log !== undefined) {
      input.log(line);
    } else {
      process.stderr.write('[evo-mcp] ' + line + '\n');
    }
  }
  const persistence = await createPersistenceRuntime(persistenceOptions);

  // --- plugin: the REAL entrypoint, host-collaborators fixed ---------------
  const host = createInMemoryCordisHost();
  // The agent-loop executor (plan §5.1): model only, no tools — every probe
  // takes the single_call degradation. An explicit runBranch in `extras`
  // outranks it inside the plugin (P0-1 precedence), so this default never
  // overrides a caller-provided executor.
  const pluginOptions: EvoHarnessPluginOptions = {
    ...extras,
    config,
    model: input.model,
    host,
    clients: [],
    resolveDshCollaborators: false,
    registerAutoFallback: false,
    enableIdleDream: false,
    persistence,
    agentLoop: {
      ...extras.agentLoop,
      model: input.model
    },
    ...(input.now === undefined ? {} : { now: input.now })
  };
  const plugin = createEvoHarnessPlugin(pluginOptions, undefined);

  // --- dispose: plugin first (flush barrier), then the runtime ------------
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) {
      return;
    }
    disposed = true;
    let pluginError: unknown = undefined;
    try {
      await plugin.dispose();
    } catch (error) {
      pluginError = error;
    }
    try {
      await persistence.dispose();
    } catch (error) {
      // Both failures propagate: the caller learns that teardown was not
      // clean, and a plugin failure must not silently skip the flush barrier.
      if (pluginError !== undefined) {
        throw new Error(
          'buildEvoAssembly dispose: both the plugin and the persistence runtime failed to dispose; ' +
            'plugin error: ' +
            (pluginError instanceof Error ? pluginError.message : String(pluginError)) +
            '; persistence error: ' +
            (error instanceof Error ? error.message : String(error))
        );
      }
      throw error;
    }
    if (pluginError !== undefined) {
      throw pluginError;
    }
  };

  return {
    plugin,
    host,
    persistence,
    dataDir: persistence.dataDir,
    dispose
  };
}

/** Resolve the data directory an assembly WOULD use, without creating one. */
export function resolveMcpDataDir(options: McpDataDirOptions = {}): string {
  return resolvePersistenceDataDir({
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    ...(options.rootDir === undefined ? {} : { rootDir: options.rootDir }),
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    ...(options.env === undefined ? {} : { env: options.env })
  });
}
