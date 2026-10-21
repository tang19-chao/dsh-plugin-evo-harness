/**
 * DSH collaborator bridge — the public entry point.
 *
 * dsh-plugin-evo-harness is host-neutral by construction: the orchestrator only
 * knows structural boundaries (IModelAdapter, McpClient, BranchExecutor). This
 * module detects the real DSH services on a live Cordis context and builds those
 * three collaborators from them, or reports exactly what is missing.
 *
 * LIVE-CONTEXT RULE (the reason every read is guarded): a live Cordis context
 * resolves property reads through its reflection layer, and reading a service the
 * fiber did not declare in `inject` THROWS
 * `cannot get property "<name>" without inject`. Detection must therefore treat
 * a throw exactly like an absent service, and a missing collaborator must become
 * a DIAGNOSTIC ENTRY rather than a silent undefined.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO:
 *  - It does not touch ctx.llm.complete — that method has never existed; the
 *    verified entry point is ctx.llm.stream() (see ./model.ts).
 *  - It does not hard-code tool names such as 'mdcg_recall'; ctx.tools is
 *    enumerated dynamically (see ./clients.ts).
 *  - It does not fork a Cordis context or acquire a sandbox; probe branches run
 *    in-process by user decision (see ./branch.ts).
 *  - It does not import @deepseek-ai/schemastery, which is not resolvable from
 *    this symlink-installed package (see ./model-config.ts).
 */

import type { BranchExecutor, IModelAdapter } from '../types/contracts';
import type { McpClient } from '../memory-bridge/spi';
import { createBranchExecutor, type BranchAdapters, type DshBranchExecutor } from './branch';
import { createToolsBackedMcpClient, type DshToolCatalog, type ToolsBackedClientOptions } from './clients';
import { createLlmModelAdapter, readDshLlm, safeGet, type DshModelRoute } from './model';
import {
  loadSchemastery,
  MODEL_ROUTE_DEFAULTS,
  resolveModelRouteConfig,
  SCHEMASTERY_PACKAGE,
  type ModelRouteConfig
} from './model-config';

// ---------------------------------------------------------------------------
// Re-exports: the bridge surface for the integrator and for tests
// ---------------------------------------------------------------------------

export {
  chunkTypeOf,
  createLlmModelAdapter,
  DEFAULT_DSH_ROUTE,
  describeDshFailure,
  drainDshStream,
  DshLlmUnavailableError,
  DshModelStreamError,
  finishReasonOf,
  readDshLlm,
  safeGet,
  toDshMessage,
  toDshMessages,
  usageToTokens
} from './model';
export type {
  DshFinishReason,
  DshGenerateOptions,
  DshLlmLike,
  DshModelAdapterOptions,
  DshModelRoute,
  DshRequestMessage,
  DshStreamChunk,
  DshStreamOutcome,
  DshTextBlock,
  DshUsage
} from './model';
export {
  asJsonObject,
  createToolsBackedMcpClient,
  describeThrown,
  DSH_TOOLS_SERVER_ID,
  listDshTools,
  readDshTools,
  snapshotJsonValue,
  toMcpToolResult
} from './clients';
export type {
  DshToolCatalog,
  DshToolDefinition,
  DshToolExecution,
  DshToolSchema,
  DshToolsLike,
  ToolsBackedClientOptions,
  ToolsBackedMcpClient
} from './clients';
export { createBranchExecutor, defaultBranchMessages, toTrajectoryError } from './branch';
export type { BranchAdapters, BranchMemoryLike, BranchPromptSource, DshBranchExecutor } from './branch';
export {
  createModelConfigFragment,
  createModelRouteSchema,
  isSchemasteryLike,
  loadSchemastery,
  MODEL_ROUTE_DEFAULTS,
  MODEL_ROUTE_EFFORTS,
  MODEL_ROUTE_FIELDS,
  resolveModelRouteConfig,
  SCHEMASTERY_PACKAGE,
  SchemasteryUnavailableError
} from './model-config';
export type {
  ModelRouteConfig,
  ModelRouteFieldSpec,
  SchemasteryLike,
  SchemasteryObjectSchema,
  SchemasteryStringSchema
} from './model-config';

// ---------------------------------------------------------------------------
// Public result shapes
// ---------------------------------------------------------------------------

/** Which DSH capabilities were detected on the host context. */
export interface DshCollaboratorPresence {
  /** ctx.llm resolves to an object. */
  readonly llm: boolean;
  /** ctx.llm.stream is a function — the verified model-call entry point. */
  readonly llmStream: boolean;
  /** ctx.tools resolves to an object. */
  readonly tools: boolean;
  /** ctx.tools.schemas(scope) returned at least one tool. */
  readonly toolCatalogNonEmpty: boolean;
  readonly commands: boolean;
  readonly events: boolean;
  readonly logger: boolean;
  readonly schemastery: 'resolved' | 'unavailable' | 'unchecked';
}

/** Collaborators resolved from a DSH host context. */
export interface DshCollaborators {
  /** LLM-backed model adapter; absent when neither ctx.llm nor a caller model exists. */
  readonly model?: IModelAdapter;
  /** MCP clients: the tools-backed client when ctx.tools exists, plus caller extras. */
  readonly clients: readonly McpClient[];
  /** Same-process probe executor; always present. */
  readonly runBranch: BranchExecutor;
  /** Effective model route (resolved config first, then the verified DSH default). */
  readonly route: Required<DshModelRoute>;
  /** What the DSH tool registry currently offers. */
  readonly toolCatalog: DshToolCatalog;
  /** Per-capability detection results, including every missing collaborator. */
  readonly presence: DshCollaboratorPresence;
  /** Human-readable problems and fallbacks; never empty when something is missing. */
  readonly diagnostics: readonly string[];
}

/** Options accepted by resolveDshCollaborators. */
export interface ResolveDshCollaboratorsOptions {
  /** Overrides the resolved route; omitted fields fall back to config then defaults. */
  readonly route?: Partial<ModelRouteConfig>;
  /** Raw plugin config section the route is read from (config wins over defaults). */
  readonly config?: unknown;
  /** Pre-built model adapter; when supplied, ctx.llm is not consulted. */
  readonly model?: IModelAdapter;
  /** Extra MCP clients merged after the tools-backed one. */
  readonly clients?: readonly McpClient[];
  /** Tuning for the tools-backed client. */
  readonly client?: Omit<ToolsBackedClientOptions, 'onDiagnostic'>;
  /** Pre-built branch executor; when supplied, the same-process one is skipped. */
  readonly runBranch?: BranchExecutor;
  /** Tuning for the same-process executor. */
  readonly branch?: Omit<BranchAdapters, 'model' | 'route' | 'clients' | 'onDiagnostic'>;
  /** Try to resolve @deepseek-ai/schemastery at runtime for the config fragment. */
  readonly resolveSchemastery?: boolean;
  /** Receiver called for every diagnostic as it is discovered. */
  readonly onDiagnostic?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function hasFunction(source: unknown, key: string): boolean {
  return typeof safeGet(source, key) === 'function';
}

/** Detect which DSH services and seams the context exposes, without throwing. */
export function detectDshCollaborators(ctx: unknown): DshCollaboratorPresence {
  const llm = safeGet(ctx, 'llm');
  const tools = safeGet(ctx, 'tools');
  let toolCatalogNonEmpty = false;
  if (tools !== null && typeof tools === 'object' && hasFunction(tools, 'schemas')) {
    try {
      const schemas = (tools as { schemas: (scope?: unknown) => unknown }).schemas();
      toolCatalogNonEmpty = Array.isArray(schemas) && schemas.length > 0;
    } catch {
      toolCatalogNonEmpty = false;
    }
  }
  return {
    llm: llm !== null && typeof llm === 'object',
    llmStream: hasFunction(llm, 'stream'),
    tools: tools !== null && typeof tools === 'object',
    toolCatalogNonEmpty,
    commands: safeGet(ctx, 'commands') !== undefined,
    events: hasFunction(ctx, 'on'),
    logger: safeGet(ctx, 'logger') !== undefined,
    schemastery: 'unchecked'
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve every DSH-backed collaborator from a live host context.
 *
 * Absent capabilities never throw and never produce a silent undefined: each one
 * appends a diagnostic explaining the consequence and the remedy, while the
 * returned collaborators keep their loud-failure behaviour (a model call without
 * ctx.llm throws DshLlmUnavailableError; a tools call without the registry
 * reports an empty catalogue and throws on call).
 *
 * `runBranch` is always present: either the caller's executor or the same-process
 * one, which records a failed trajectory when no model adapter exists rather than
 * silently succeeding.
 */
export async function resolveDshCollaborators(
  ctx: unknown,
  options: ResolveDshCollaboratorsOptions = {}
): Promise<DshCollaborators> {
  const diagnostics: string[] = [];
  const report = (message: string): void => {
    diagnostics.push(message);
    options.onDiagnostic?.(message);
  };

  // ---- model route -------------------------------------------------------
  const configured = resolveModelRouteConfig(options.config ?? safeGet(ctx, 'config'));
  const route: Required<DshModelRoute> = {
    provider: options.route?.provider ?? configured.provider,
    model: options.route?.model ?? configured.model,
    reasoningEffort: options.route?.reasoningEffort ?? configured.reasoningEffort
  };
  if (route.provider !== MODEL_ROUTE_DEFAULTS.provider || route.model !== MODEL_ROUTE_DEFAULTS.model) {
    report(
      'model route resolved to ' + route.provider + '/' + route.model + ' (the DSH default is '
        + MODEL_ROUTE_DEFAULTS.provider + '/' + MODEL_ROUTE_DEFAULTS.model + ')'
    );
  }

  // ---- model adapter -----------------------------------------------------
  // "Only inject what exists": when ctx.llm has no stream(), no model collaborator
  // is returned, the integrator's missing-model path stays in charge, and the
  // consequence is recorded here instead of being papered over with a
  // constructible-but-useless adapter.
  const llmService = readDshLlm(ctx);
  let model: IModelAdapter | undefined = undefined;
  if (options.model !== undefined) {
    model = options.model;
    report('model adapter supplied by the caller; ctx.llm was not consulted');
  } else if (llmService === undefined) {
    report(
      'ctx.llm exposes no stream() method, so no model adapter was resolved. Mount @deepseek-ai/dsh-llm with a '
        + 'provider adapter and declare "llm" in this plugin inject list, or inject a model adapter. Harness2 '
        + 'propose/compose/reflect and Dream-RSI policy generation will fail loudly until then.'
    );
  } else {
    model = createLlmModelAdapter(ctx, route, {
      ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic })
    });
  }

  // ---- tools-backed MCP client ------------------------------------------
  const toolsClient = createToolsBackedMcpClient(ctx, { ...options.client, onDiagnostic: report });
  const clients: McpClient[] = [toolsClient];
  const toolCatalog: DshToolCatalog = toolsClient.catalog;
  if (!toolCatalog.available) {
    report(
      'ctx.tools is unavailable, so the tools-backed MCP client would report an empty catalogue. Declare '
        + '"tools" in this plugin inject list and mount @deepseek-ai/dsh-tools to let the memory bridge '
        + 'auto-discover a backend.'
    );
  } else if (toolCatalog.tools.length === 0) {
    report(
      'ctx.tools.schemas() returned no tools, so the tools-backed MCP client has an empty catalogue. The '
        + 'memory bridge will report its backend as unbound instead of failing the mount.'
    );
  }
  for (const extra of options.clients ?? []) {
    clients.push(extra);
  }
  if (clients.length > 1) {
    report(
      'memory bridge receives ' + String(clients.length) + ' MCP clients: '
        + clients.map((client) => client.serverId).join(', ')
    );
  }

  // ---- same-process branch executor -------------------------------------
  let runBranch: BranchExecutor;
  let executor: DshBranchExecutor | undefined = undefined;
  if (options.runBranch !== undefined) {
    runBranch = options.runBranch;
    report('branch executor supplied by the caller; the same-process executor was not constructed');
  } else {
    executor = createBranchExecutor(ctx, {
      ...options.branch,
      ...(model === undefined ? {} : { model }),
      route,
      clients: clients.map((client) => ({ serverId: client.serverId })),
      onDiagnostic: report
    });
    runBranch = executor.runBranch;
    for (const capability of executor.describe()) {
      report('branch executor: ' + capability);
    }
  }

  // ---- optional schemastery resolution ----------------------------------
  let presence: DshCollaboratorPresence = detectDshCollaborators(ctx);
  if (options.resolveSchemastery === true) {
    const loaded = await loadSchemastery(report);
    presence = {
      ...presence,
      schemastery: loaded === undefined ? 'unavailable' : 'resolved'
    };
    if (loaded !== undefined) {
      report(SCHEMASTERY_PACKAGE + ' resolved: createModelConfigFragment(module) builds the settings fragment');
    }
  } else {
    report(
      'the model-route settings fragment is available through createModelConfigFragment(); it needs a '
        + 'schemastery instance, and ' + SCHEMASTERY_PACKAGE + ' is not importable from this install '
        + '(see src/dsh-bridge/model-config.ts)'
    );
  }

  return {
    ...(model === undefined ? {} : { model }),
    clients,
    runBranch,
    route,
    toolCatalog,
    presence,
    diagnostics
  };
}
