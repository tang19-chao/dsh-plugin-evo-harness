/**
 * Deterministic end-to-end fixtures for the integration suite.
 *
 * Everything is in-process: scripted model adapter, in-memory MCP memory servers
 * whose tools/list surfaces match the Mem0-like, official-KG-like and
 * Lingshu-like fingerprints, a scripted branch executor, and a structural fake
 * Cordis context. No network, host runtime, sandbox or real LLM is involved.
 */
import { vi } from 'vitest';
import type {
  BatchPlan,
  BranchExecutor,
  EightSurfacePatch,
  FailureCategory,
  FailureDiagnosis,
  IActivePolicy,
  ICordisSeamManager,
  IHarnessProposer,
  IModelAdapter,
  IsolatedBranchContext,
  MetaSearchPolicy,
  ModelRequest,
  ModelResponse,
  PlanGridRequest,
  ProbeExecutionResult,
  ProposeRequest,
  ProposedPatch,
  SearchGridPlan,
  SelectBatchRequest,
  StopCondition,
  SurfacePatchDisposer
} from '../../src/types/contracts';
import { parseLessonDocument } from '../../src/memory-bridge';
import { parseEvoHarnessConfig } from '../../src/config';
import { createActivePolicyFromDefaults, createFailureTaxonomy, diagnoseFailure } from '../../src/dream-rsi';
import type { FailureDiagnosisRequest, IFailureTaxonomy } from '../../src/dream-rsi';
import type { McpClient, McpToolCallResult, McpToolDescriptor } from '../../src/memory-bridge';
import { createCordisHostFromContext, createEvoHarnessPlugin } from '../../src/index';
import type {
  CordisCommandHandler,
  CordisPluginContext,
  EvoHarnessPlugin,
  EvoHarnessPluginOptions
} from '../../src/index';

// ---------------------------------------------------------------------------
// deterministic primitives
// ---------------------------------------------------------------------------

/** Monotonic clock: each read advances by one millisecond. */
export function makeClock(start = 1_700_000_000_000): () => number {
  let current = start;
  return (): number => {
    current += 1;
    return current;
  };
}

/** Deterministic id factory: prefix-1, prefix-2, ... */
export function makeIdFactory(prefix = 'id'): () => string {
  let counter = 0;
  return (): string => {
    counter += 1;
    return prefix + '-' + String(counter);
  };
}

// ---------------------------------------------------------------------------
// scripted model adapter
// ---------------------------------------------------------------------------

export interface ScriptedModel extends IModelAdapter {
  readonly requests: ModelRequest[];
}

/** Valid proposer payload (Harness2 contract). */
export function proposalPayload(): Record<string, unknown> {
  return {
    rationale: 'Mount an output contract so the tool loop stops retrying after a failure.',
    focusSurfaces: ['guardrails'],
    confidence: 0.72,
    expectedStepsDelta: -1,
    edits: {
      guardrails: {
        kind: 'guardrails',
        formatContract: 'Return minified JSON only.',
        appendRules: ['declare the failing tool before retrying']
      }
    }
  };
}

/** Proposer payload that edits the system prompt surface. */
export function systemPromptProposalPayload(): Record<string, unknown> {
  return {
    rationale: 'State the failing tool up front in the system prompt.',
    focusSurfaces: ['system_prompt'],
    confidence: 0.7,
    expectedStepsDelta: -1,
    edits: {
      system_prompt: {
        kind: 'system_prompt',
        mode: 'append',
        content: 'round 1: declare the failing tool before retrying'
      }
    }
  };
}

/** Proposer payload that edits the skills surface instead of guardrails. */
export function skillsProposalPayload(): Record<string, unknown> {
  return {
    rationale: 'Mount a domain SOP so the retry follows a written procedure.',
    focusSurfaces: ['skills'],
    confidence: 0.68,
    expectedStepsDelta: -2,
    edits: {
      skills: {
        kind: 'skills',
        skills: [{ name: 'build-sop', markdown: '# Build SOP', description: 'retry procedure' }]
      }
    }
  };
}

export interface ScriptedModelOptions {
  /**
   * Proposal payloads cycled per 'propose' request (the last one repeats). The
   * default is the single guardrails payload, so existing callers are unaffected.
   */
  readonly proposals?: readonly Record<string, unknown>[];
}

/**
 * Routes on ModelPurpose so one adapter serves propose/compose/reflect/probe:
 *  - propose -> the next cycled proposal payload
 *  - compose -> ranking of every candidate alias found in the prompt
 *  - reflect -> no headers, so the reflector keeps its deterministic titles
 *  - probe   -> a distinct scripted probe reply, so model calls made inside an
 *    isolated probe branch stay distinguishable from 'compose' judging
 */
export function createScriptedModel(options: ScriptedModelOptions = {}): ScriptedModel {
  const requests: ModelRequest[] = [];
  const proposals = options.proposals ?? [proposalPayload()];
  let proposalIndex = 0;
  return {
    requests,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      requests.push(request);
      if (request.purpose === 'propose') {
        const index = Math.min(proposalIndex, proposals.length - 1);
        proposalIndex += 1;
        return {
          text: JSON.stringify(proposals[index] ?? proposalPayload()),
          finishReason: 'stop',
          model: 'scripted'
        };
      }
      if (request.purpose === 'compose') {
        const text = request.messages.map((message) => message.content).join(String.fromCharCode(10));
        const found = text.match(/candidate_[A-Z]/g) ?? [];
        const aliases = [...new Set(found)];
        return {
          text: JSON.stringify({
            ranking: aliases,
            assessments: aliases.map((alias, index) => ({
              alias,
              rationale: 'ranked ' + String(index + 1) + ' by the scripted judge'
            }))
          }),
          finishReason: 'stop',
          model: 'scripted'
        };
      }
      if (request.purpose === 'reflect') {
        return { text: JSON.stringify({ lessons: [] }), finishReason: 'stop', model: 'scripted' };
      }
      if (request.purpose === 'probe') {
        return { text: 'probe-loop-reply', finishReason: 'stop', model: 'scripted' };
      }
      return { text: JSON.stringify({ policies: [] }), finishReason: 'stop', model: 'scripted' };
    }
  };
}

// ---------------------------------------------------------------------------
// scripted branch executor: the reference run fails, patched candidates recover
// ---------------------------------------------------------------------------

export interface ScriptedRunner {
  (context: IsolatedBranchContext): Promise<ProbeExecutionResult>;
  readonly calls: string[];
  /** Mounted surface keys of every executed branch, sorted, in call order. */
  readonly executedSurfaces: readonly (readonly string[])[];
  /** Id of the patch object each executed branch received, in call order. */
  readonly executedPatchIds: readonly string[];
}

export interface ScriptedRunnerOptions {
  /**
   * Outcome of each candidate probe in call order; defaults to 'succeed'.
   *  - 'succeed': clean run with a deliverable
   *  - 'fail':    repairable tool error (repairable_implementation)
   *  - 'weak':    timeout without a deliverable (weak_underexplored, not repairable)
   *  - 'hard':    model refusal (hard_unrecoverable, terminal)
   */
  readonly candidateOutcomes?: readonly ('succeed' | 'fail' | 'weak' | 'hard')[];
}

/**
 * Reference run fails with a tool error; candidate patches succeed unless
 * candidateOutcomes marks that probe index as a failure.
 */
export function createScriptedRunner(
  now: () => number,
  options: ScriptedRunnerOptions = {}
): ScriptedRunner {
  const calls: string[] = [];
  const executedSurfaces: string[][] = [];
  const executedPatchIds: string[] = [];
  let candidateIndex = 0;
  const run = async (context: IsolatedBranchContext): Promise<ProbeExecutionResult> => {
      // The baseline run is the only purpose 'initial', edit-free patch; exploit
      // slots also use origin 'reference' (memory-guided), so origin alone is not
      // a safe discriminator.
      const isReference =
        context.patch.purpose === 'initial' && Object.keys(context.patch.edits).length === 0;
      calls.push(isReference ? 'reference' : 'candidate');
      executedSurfaces.push(Object.keys(context.patch.edits).sort());
      executedPatchIds.push(context.patch.id);
      const candidateOutcome = isReference
        ? undefined
        : (options.candidateOutcomes?.[candidateIndex] ?? 'succeed');
      if (!isReference) {
        candidateIndex += 1;
      }
      if (isReference) {
        return {
          status: 'failed',
          steps: [
            { index: 0, at: now(), kind: 'model', text: 'plan the migration' },
            {
              index: 1,
              at: now(),
              kind: 'tool',
              toolName: 'shell',
              toolArguments: { cmd: 'npm test' },
              error: { name: 'ToolError', message: 'exit 1' }
            },
            { index: 2, at: now(), kind: 'error', text: 'the build failed' }
          ],
          toolErrors: [
            { toolName: 'shell', message: 'exit 1', code: 'E1', stepIndex: 1, retryable: true }
          ],
          failureSignals: [
            { kind: 'tool_error', message: 'exit 1', toolName: 'shell', repairable: true }
          ]
        };
      }
      if (candidateOutcome === 'fail') {
        return {
          status: 'failed',
          steps: [
            { index: 0, at: now(), kind: 'model', text: 'apply the candidate scaffold' },
            {
              index: 1,
              at: now(),
              kind: 'tool',
              toolName: 'shell',
              toolArguments: { cmd: 'npm test' },
              error: { name: 'ToolError', message: 'candidate exit 2' }
            },
            { index: 2, at: now(), kind: 'error', text: 'the candidate build still fails' }
          ],
          toolErrors: [
            { toolName: 'shell', message: 'candidate exit 2', code: 'E2', stepIndex: 1, retryable: true }
          ],
          failureSignals: [
            { kind: 'tool_error', message: 'candidate exit 2', toolName: 'shell', repairable: true }
          ]
        };
      }
      if (candidateOutcome === 'weak') {
        return {
          status: 'timeout',
          steps: [
            { index: 0, at: now(), kind: 'model', text: 'apply the candidate scaffold' },
            { index: 1, at: now(), kind: 'error', text: 'the candidate run timed out' }
          ],
          toolErrors: [],
          failureSignals: [
            { kind: 'timeout', message: 'candidate timed out', repairable: false }
          ]
        };
      }
      if (candidateOutcome === 'hard') {
        return {
          status: 'failed',
          steps: [
            { index: 0, at: now(), kind: 'model', text: 'apply the candidate scaffold' },
            { index: 1, at: now(), kind: 'error', text: 'the model refused to continue' }
          ],
          toolErrors: [],
          failureSignals: [
            { kind: 'model_refusal', message: 'the model refused to continue', repairable: false }
          ]
        };
      }
      return {
        status: 'succeeded',
        steps: [
          { index: 0, at: now(), kind: 'model', text: 'plan with the mounted guardrails' },
          {
            index: 1,
            at: now(),
            kind: 'tool',
            toolName: 'shell',
            toolArguments: { cmd: 'npm test' },
            toolResult: { exitCode: 0 }
          },
          { index: 2, at: now(), kind: 'message', text: 'the build passes' }
        ],
        deliverable: { content: 'recovered: the build passes with the mounted SOP', format: 'markdown' },
        usage: { inputTokens: 120, outputTokens: 48, totalTokens: 168 }
    };
  };
  return Object.assign(run, { calls, executedSurfaces, executedPatchIds });
}

// ---------------------------------------------------------------------------
// in-memory MCP memory servers (one per required fingerprint family)
// ---------------------------------------------------------------------------

export interface MockRecord {
  readonly id: string;
  readonly namespace: string;
  readonly text: string;
  readonly polarity: string;
}

export interface MockCall {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

export interface MockMemoryServer {
  readonly client: McpClient;
  readonly records: MockRecord[];
  readonly calls: MockCall[];
  callsTo(tool: string): readonly MockCall[];
  toolNames(): readonly string[];
}

type MockHandler = (args: Record<string, unknown>, server: MockMemoryServer) => unknown;

function toResult(value: unknown): McpToolCallResult {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value as never };
}

function createServer(
  serverId: string,
  tools: readonly McpToolDescriptor[],
  handlers: Readonly<Record<string, MockHandler>>
): MockMemoryServer {
  const records: MockRecord[] = [];
  const calls: MockCall[] = [];
  const server: MockMemoryServer = {
    records,
    calls,
    callsTo: (tool: string): readonly MockCall[] => calls.filter((call) => call.tool === tool),
    toolNames: (): readonly string[] => tools.map((tool) => tool.name),
    client: {
      serverId,
      async listTools(): Promise<readonly McpToolDescriptor[]> {
        return tools;
      },
      async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
        calls.push({ tool: name, args });
        const handler = handlers[name];
        if (handler === undefined) {
          return { isError: true, content: [{ type: 'text', text: 'unknown tool ' + name }] };
        }
        return toResult(handler(args, server));
      }
    }
  };
  return server;
}

function schema(shape: Readonly<Record<string, string>>): never {
  const properties: Record<string, { type: string }> = {};
  for (const [key, type] of Object.entries(shape)) {
    properties[key] = { type };
  }
  return { properties } as never;
}

/** Find the first serialized lesson envelope anywhere in the tool arguments. */
export function extractLesson(args: Record<string, unknown>): {
  lesson: { id: string; polarity: string };
  namespace: string;
  text: string;
} | undefined {
  let found: { lesson: { id: string; polarity: string }; namespace: string; text: string } | undefined;
  const walk = (node: unknown, depth: number): void => {
    if (found !== undefined || depth > 8 || node === null || node === undefined) {
      return;
    }
    if (typeof node === 'string') {
      const parsed = parseLessonDocument(node);
      if (parsed !== undefined) {
        found = { lesson: parsed.lesson, namespace: parsed.namespace, text: node };
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const entry of node) {
        walk(entry, depth + 1);
      }
      return;
    }
    if (typeof node !== 'object') {
      return;
    }
    for (const value of Object.values(node as Record<string, unknown>)) {
      walk(value, depth + 1);
    }
  };
  walk(args, 0);
  return found;
}

/** Namespace declared by explicit argument keys. */
export function namespaceFromArgs(args: Record<string, unknown>): string | undefined {
  for (const key of ['user_id', 'userId', 'namespace', 'group_id', 'groupId', 'container', 'my_scope']) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  const metadata = args.metadata;
  if (metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const nested = (metadata as Record<string, unknown>).namespace;
    if (typeof nested === 'string' && nested.length > 0) {
      return nested;
    }
  }
  return undefined;
}

function store(server: MockMemoryServer, args: Record<string, unknown>): MockRecord | undefined {
  const found = extractLesson(args);
  if (found === undefined) {
    return undefined;
  }
  const record: MockRecord = {
    id: found.lesson.id,
    namespace: namespaceFromArgs(args) ?? found.namespace,
    text: found.text,
    polarity: found.lesson.polarity
  };
  server.records.push(record);
  return record;
}

function filterByNamespace(server: MockMemoryServer, args: Record<string, unknown>): readonly MockRecord[] {
  const namespace = namespaceFromArgs(args);
  if (namespace === undefined) {
    return server.records;
  }
  const matching = server.records.filter((record) => record.namespace === namespace);
  return matching.length > 0 ? matching : server.records;
}

/** Mem0-like vector/fact server: add_memories + search_memory. */
export function mem0LikeServer(serverId = 'mem0'): MockMemoryServer {
  return createServer(
    serverId,
    [
      { name: 'add_memories', description: 'store memories', inputSchema: schema({ text: 'string', user_id: 'string' }) },
      { name: 'search_memory', inputSchema: schema({ query: 'string', user_id: 'string', limit: 'number' }) },
      { name: 'delete_memories', inputSchema: schema({ ids: 'array', user_id: 'string' }) }
    ],
    {
      add_memories: (args, server) => {
        const record = store(server, args);
        return { id: record?.id ?? 'unknown', stored: record !== undefined };
      },
      search_memory: (args, server) => ({
        results: filterByNamespace(server, args).map((record) => ({
          id: record.id,
          memory: record.text,
          metadata: { namespace: record.namespace }
        }))
      }),
      delete_memories: (args, server) => {
        const ids = Array.isArray(args.ids) ? args.ids : [];
        let removed = 0;
        for (const id of ids) {
          const index = server.records.findIndex((record) => record.id === id);
          if (index >= 0) {
            server.records.splice(index, 1);
            removed += 1;
          }
        }
        return { removed };
      }
    }
  );
}

/** Official knowledge-graph-like server: create_entities + search_nodes. */
export function officialKgLikeServer(serverId = 'official_kg'): MockMemoryServer {
  return createServer(
    serverId,
    [
      { name: 'create_entities', description: 'create graph entities', inputSchema: schema({ entities: 'array' }) },
      { name: 'create_relations', inputSchema: schema({ relations: 'array' }) },
      { name: 'add_observations', inputSchema: schema({ observations: 'array' }) },
      { name: 'search_nodes', inputSchema: schema({ query: 'string' }) },
      { name: 'read_graph', inputSchema: schema({}) },
      { name: 'delete_entities', inputSchema: schema({ entityNames: 'array' }) }
    ],
    {
      create_entities: (args, server) => {
        const entities = Array.isArray(args.entities) ? args.entities : [];
        let created = 0;
        for (const entity of entities) {
          if (entity === null || typeof entity !== 'object') {
            continue;
          }
          const observations = (entity as Record<string, unknown>).observations;
          if (!Array.isArray(observations)) {
            continue;
          }
          for (const observation of observations) {
            const record = store(server, { observation });
            if (record !== undefined) {
              created += 1;
            }
          }
        }
        return { created };
      },
      create_relations: (args) => ({ relations: Array.isArray(args.relations) ? args.relations.length : 0 }),
      add_observations: (args, server) => {
        const observations = Array.isArray(args.observations) ? args.observations : [];
        let added = 0;
        for (const observation of observations) {
          if (store(server, { observation }) !== undefined) {
            added += 1;
          }
        }
        return { added };
      },
      search_nodes: (_args, server) => ({
        entities: server.records.map((record) => ({
          name: 'Lesson:' + record.namespace + ':' + record.id,
          entityType: 'Lesson',
          observations: [record.text]
        }))
      }),
      read_graph: (_args, server) => ({
        entities: server.records.map((record) => ({
          name: 'Lesson:' + record.namespace + ':' + record.id,
          entityType: 'Lesson',
          observations: [record.text]
        }))
      }),
      delete_entities: (args, server) => {
        const names = Array.isArray(args.entityNames) ? args.entityNames : [];
        let removed = 0;
        for (const name of names) {
          if (typeof name !== 'string') {
            continue;
          }
          const id = name.slice(name.lastIndexOf(':') + 1);
          const index = server.records.findIndex((record) => record.id === id);
          if (index >= 0) {
            server.records.splice(index, 1);
            removed += 1;
          }
        }
        return { removed };
      }
    }
  );
}

/** Lingshu (dsh-memory) white-box native server: cg + stg. */
export function lingshuLikeServer(serverId = 'lingshu'): MockMemoryServer {
  return createServer(
    serverId,
    [
      { name: 'cg', description: 'lingu cognitive graph', inputSchema: schema({ op: 'string', query: 'string', content: 'string', namespace: 'string' }) },
      { name: 'stg', inputSchema: schema({ op: 'string', limit: 'number' }) }
    ],
    {
      cg: (args, server) => {
        const op = args.op;
        if (op === 'write') {
          const record = store(server, args);
          return { verdict: 'accept', id: record?.id ?? 'unknown', gates: 3 };
        }
        if (op === 'forget') {
          const ids = Array.isArray(args.ids) ? args.ids : [];
          let removed = 0;
          for (const id of ids) {
            const index = server.records.findIndex((record) => record.id === id);
            if (index >= 0) {
              server.records.splice(index, 1);
              removed += 1;
            }
          }
          return { removed };
        }
        return {
          results: filterByNamespace(server, args).map((record) => ({
            content: record.text,
            namespace: record.namespace
          }))
        };
      },
      stg: (_args, server) => ({
        episodes: server.records.map((record) => ({ content: record.text }))
      })
    }
  );
}

// ---------------------------------------------------------------------------
// structural fake Cordis context
// ---------------------------------------------------------------------------

export interface FakeContext {
  readonly ctx: CordisPluginContext & Record<string, unknown>;
  readonly commands: Map<string, CordisCommandHandler>;
  /**
   * Registered listeners, keyed by event name.
   *
   * Variadic on purpose: DSH dispatches `session/event` as `(session, event)`,
   * `agent/error` as `({agent,turn,step,error})` and `agent/status` as
   * `({status})`, so a fixed single-argument signature would misrepresent the
   * host contract this fake stands in for.
   */
  readonly events: Map<string, (...args: unknown[]) => unknown>;
  readonly info: ReturnType<typeof vi.fn>;
  readonly warn: ReturnType<typeof vi.fn>;
}

/** A fake host context exposing only the capabilities a host may expose. */
export function createFakeContext(overrides: Record<string, unknown> = {}): FakeContext {
  const commands = new Map<string, CordisCommandHandler>();
  const events = new Map<string, (...args: unknown[]) => unknown>();
  const info = vi.fn();
  const warn = vi.fn();
  const ctx: CordisPluginContext & Record<string, unknown> = {
    logger: { info, warn, debug: vi.fn(), error: vi.fn() },
    registerCommand: (name: string, handler: CordisCommandHandler) => {
      commands.set(name, handler);
      return () => commands.delete(name);
    },
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      events.set(event, handler);
      return () => events.delete(event);
    },
    ...overrides
  };
  return { ctx, commands, events, info, warn };
}

/** Context with no host capabilities at all (worst-case structural probe). */
export function createBareContext(): CordisPluginContext {
  return {};
}

// ---------------------------------------------------------------------------
// end-to-end harness
// ---------------------------------------------------------------------------

export interface E2EHarness {
  readonly plugin: EvoHarnessPlugin;
  readonly server: MockMemoryServer;
  readonly model: ScriptedModel;
  readonly runner: ScriptedRunner;
  readonly now: () => number;
}

export interface E2EBuildOptions {
  readonly server?: MockMemoryServer;
  readonly config?: Record<string, unknown>;
  readonly ctx?: CordisPluginContext;
  readonly host?: EvoHarnessPluginOptions['host'];
  readonly extra?: Partial<EvoHarnessPluginOptions>;
  readonly dreamEveryNTasks?: number;
  readonly maxDepth?: number;
  readonly maxWidth?: number;
  readonly rolloutBudget?: number;
  /** Outcome of each candidate probe, forwarded to the scripted runner. */
  readonly candidateOutcomes?: readonly ('succeed' | 'fail' | 'weak' | 'hard')[];
}

const CONFIG_GROUPS = ['probe', 'memoryBridge', 'dreamRsi', 'logging'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Base plugin config: deterministic, one round, first-success stop. Nested
 * groups (probe/memoryBridge/dreamRsi/logging) are deep-merged so a partial
 * override such as { memoryBridge: { promoteOnComposeSuccess: false } } cannot
 * silently drop the rest of the group.
 */
export function e2eConfig(options: E2EBuildOptions = {}): Record<string, unknown> {
  const overrides = options.config ?? {};
  const base: Record<string, unknown> = {
    triggerMode: 'always',
    enabledSurfaces: [
      'system_prompt',
      'guardrails',
      'memory',
      'tool_guidance',
      'skills',
      'scripts',
      'subagents',
      'plugins'
    ],
    probe: { maxConcurrentProbes: 2, probeTimeoutMs: 5_000 },
    memoryBridge: {
      mcpServerTarget: 'auto',
      recallLimit: 5,
      namespacePrefix: 'harness2',
      requireEvidence: true,
      enableNegativeFirewall: true
    },
    dreamRsi: {
      maxOnlineRolloutBudget: options.rolloutBudget ?? 4,
      maxWidth: options.maxWidth ?? 2,
      maxDepth: options.maxDepth ?? 1,
      offlineDreamTriggerEveryNTasks: options.dreamEveryNTasks ?? 100,
      candidatePoliciesCount: 3,
      rhoPreferences: [0, 0.5, 1],
      surrogateWeights: { selection: 0.4, adoption: 0.3, efficiency: 0.2, toolErrorPenalty: 0.1 }
    },
    logging: { level: 'silent' }
  };
  const merged: Record<string, unknown> = { ...base, ...overrides };
  for (const group of CONFIG_GROUPS) {
    const extra = overrides[group];
    if (isRecord(extra)) {
      merged[group] = { ...(isRecord(base[group]) ? (base[group] as Record<string, unknown>) : {}), ...extra };
    }
  }
  return merged;
}

/** Build a complete plugin over the real modules with injected fakes. */
export function buildE2E(options: E2EBuildOptions = {}): E2EHarness {
  const server = options.server ?? mem0LikeServer();
  const model = createScriptedModel();
  const now = makeClock();
  const runner = createScriptedRunner(now, { candidateOutcomes: options.candidateOutcomes });
  const pluginOptions: EvoHarnessPluginOptions = {
    config: e2eConfig(options),
    model,
    clients: [server.client],
    runBranch: runner,
    now,
    newId: makeIdFactory('e2e'),
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.extra ?? {})
  };
  const plugin = createEvoHarnessPlugin(pluginOptions, options.ctx);
  return { plugin, server, model, runner, now };
}

// ---------------------------------------------------------------------------
// recording active policy (observes what the orchestrator hands the scheduler)
// ---------------------------------------------------------------------------

export interface RecordingPolicy extends IActivePolicy {
  readonly selectBatchRequests: SelectBatchRequest[];
  readonly batchPlans: BatchPlan[];
  readonly planGridRequests: PlanGridRequest[];
}

export interface RecordingPolicyOverrides {
  /** Force the grid stop condition while keeping the real policy behaviour. */
  readonly stopCondition?: StopCondition;
  /**
   * Rewrite exploit slots so they deepen the most recently created succeeded
   * candidate. Real policies resolve the best node heuristically; pinning the
   * chain here keeps deep-lineage regressions deterministic without touching any
   * production code path.
   */
  readonly pinExploitToLatestNode?: boolean;
}

/** See RecordingPolicyOverrides.pinExploitToLatestNode. */
function pinExploitParents(batch: BatchPlan, request: SelectBatchRequest): BatchPlan {
  const succeeded = Object.values(request.tree.nodes)
    .filter((node) => node.status === 'succeeded' && node.parentId !== null)
    .sort((left, right) => left.createdAt - right.createdAt);
  const latest = succeeded[succeeded.length - 1];
  if (latest === undefined) {
    return batch;
  }
  return {
    ...batch,
    slots: batch.slots.map((slot) =>
      slot.slot === 'exploit'
        ? { ...slot, parentNodeId: latest.id, seedPatchIds: [latest.patchId] }
        : slot
    )
  };
}

/** Wrap a real ActivePolicy, recording every scheduler interaction. */
export function createRecordingPolicyFrom(
  base: IActivePolicy,
  overrides: RecordingPolicyOverrides = {}
): RecordingPolicy {
  const selectBatchRequests: SelectBatchRequest[] = [];
  const batchPlans: BatchPlan[] = [];
  const planGridRequests: PlanGridRequest[] = [];
  let current: MetaSearchPolicy = base.policy;
  return {
    selectBatchRequests,
    batchPlans,
    planGridRequests,
    get policy(): MetaSearchPolicy {
      return current;
    },
    planGrid(request: PlanGridRequest): SearchGridPlan {
      planGridRequests.push(request);
      const grid = base.planGrid(request);
      return overrides.stopCondition === undefined
        ? grid
        : { ...grid, stopCondition: overrides.stopCondition };
    },
    selectBatch(request: SelectBatchRequest): BatchPlan {
      selectBatchRequests.push(request);
      const batch = base.selectBatch(request);
      const adjusted =
        overrides.pinExploitToLatestNode === true ? pinExploitParents(batch, request) : batch;
      batchPlans.push(adjusted);
      return adjusted;
    },
    update(policy: MetaSearchPolicy): void {
      current = policy;
      base.update(policy);
    }
  };
}

/**
 * Recording policy built exactly like the production wiring in src/index.ts, so
 * the real ActivePolicy still composes the slot portfolio.
 */
export function createRecordingPolicy(
  options: E2EBuildOptions = {},
  overrides: RecordingPolicyOverrides = {}
): RecordingPolicy {
  const config = parseEvoHarnessConfig(e2eConfig(options));
  const base = createActivePolicyFromDefaults(
    {
      maxWidth: config.dreamRsi.maxWidth,
      maxDepth: config.dreamRsi.maxDepth,
      earlyStopThreshold: config.dreamRsi.earlyStopThreshold,
      minMemoryConfidenceForSkip: config.dreamRsi.minMemoryConfidenceForSkip
    },
    { now: makeClock(), maxRecoverySlots: config.dreamRsi.maxRecoverySlots }
  );
  return createRecordingPolicyFrom(base, overrides);
}

// ---------------------------------------------------------------------------
// recording failure taxonomy (observes lineage handed to the classifier)
// ---------------------------------------------------------------------------

export interface RecordingTaxonomy extends IFailureTaxonomy {
  readonly requests: FailureDiagnosisRequest[];
}

/** Wrap a real taxonomy, recording every diagnosis request. */
export function createRecordingTaxonomy(base: IFailureTaxonomy): RecordingTaxonomy {
  const requests: FailureDiagnosisRequest[] = [];
  return {
    requests,
    diagnose(request: FailureDiagnosisRequest) {
      requests.push(request);
      return base.diagnose(request);
    }
  };
}

/** Recording taxonomy over the production default taxonomy. */
export function createDefaultRecordingTaxonomy(): RecordingTaxonomy {
  return createRecordingTaxonomy(createFailureTaxonomy({}));
}

export interface ForcedTaxonomyOptions {
  /** Repairability reported with the forced category (default false). */
  readonly repairable?: boolean;
  /** How many diagnoses to override before delegating (default: all). */
  readonly maxForced?: number;
}

/**
 * Taxonomy that reports a fixed category for the first N diagnoses and then
 * delegates to the production classifier. Used to exercise stop-condition scope
 * (hard_unrecoverable vs repeatedly_unpromising) deterministically.
 */
export function createForcedTaxonomy(
  category: FailureCategory,
  options: ForcedTaxonomyOptions = {}
): IFailureTaxonomy {
  let forced = 0;
  const maxForced = options.maxForced ?? Number.MAX_SAFE_INTEGER;
  return {
    diagnose(request: FailureDiagnosisRequest): FailureDiagnosis {
      if (forced >= maxForced) {
        return diagnoseFailure(request);
      }
      forced += 1;
      return {
        category,
        confidence: 0.9,
        repairable: options.repairable ?? false,
        recommendedAction: category === 'hard_unrecoverable' ? 'stop' : 'explore_elsewhere',
        evidence: ['forced category ' + category + ' by the e2e taxonomy'],
        signals: []
      };
    }
  };
}

/** One step of a sequenced taxonomy run. */
export interface ForcedDiagnosisStep {
  readonly category: FailureCategory;
  /** Repairability reported with this step (default true only for repairable_implementation). */
  readonly repairable?: boolean;
}

/**
 * Taxonomy that walks a fixed step sequence - one diagnosis per probe, repeating
 * the last step afterwards - so sibling arrival order can be controlled
 * deterministically in failure-precedence regressions.
 */
export function createSequencedTaxonomy(
  steps: readonly ForcedDiagnosisStep[]
): IFailureTaxonomy {
  const sequence: readonly ForcedDiagnosisStep[] =
    steps.length > 0 ? steps : [{ category: 'none' }];
  let index = 0;
  return {
    diagnose(): FailureDiagnosis {
      const step = sequence[Math.min(index, sequence.length - 1)] ?? sequence[0];
      index += 1;
      const category: FailureCategory = step === undefined ? 'none' : step.category;
      return {
        category,
        confidence: 0.9,
        repairable: step?.repairable ?? category === 'repairable_implementation',
        recommendedAction:
          category === 'hard_unrecoverable'
            ? 'stop'
            : category === 'repairable_implementation'
              ? 'repair'
              : 'explore_elsewhere',
        evidence: ['sequenced category ' + category + ' by the e2e taxonomy'],
        signals: []
      };
    }
  };
}

// ---------------------------------------------------------------------------
// recording proposer (observes the ProposeRequest the orchestrator builds)
// ---------------------------------------------------------------------------

export interface RecordingProposer extends IHarnessProposer {
  readonly requests: ProposeRequest[];
}

/** Wrap a real proposer, recording every proposal request it receives. */
export function createRecordingProposer(base: IHarnessProposer): RecordingProposer {
  const requests: ProposeRequest[] = [];
  return {
    requests,
    async propose(request: ProposeRequest): Promise<ProposedPatch> {
      requests.push(request);
      return base.propose(request);
    }
  };
}

// ---------------------------------------------------------------------------
// seam manager whose permanent-patch disposers always throw on rollback
// ---------------------------------------------------------------------------

export interface ThrowingRollbackSeams extends ICordisSeamManager {
  readonly rollbackFailures: readonly string[];
}

/**
 * Wrap a seam manager so every permanently mounted patch hands back a disposer
 * that throws on rollback while the underlying mount still happens. Used to prove
 * the orchestrator records the rollback failure instead of aborting the run.
 */
export function createThrowingRollbackSeams(base: ICordisSeamManager): ThrowingRollbackSeams {
  const rollbackFailures: string[] = [];
  return {
    rollbackFailures,
    runInIsolatedBranch: (request) => base.runInIsolatedBranch(request),
    listActiveBranches: () => base.listActiveBranches(),
    dispose: () => base.dispose(),
    async applyPermanentPatch(patch: EightSurfacePatch): Promise<SurfacePatchDisposer> {
      const real = await base.applyPermanentPatch(patch);
      return {
        patchId: real.patchId,
        get active(): boolean {
          return real.active;
        },
        dispose: async (): Promise<void> => {
          rollbackFailures.push(real.patchId);
          throw new Error('rollback boom for ' + real.patchId);
        }
      };
    }
  };
}

/** Re-export for tests that assert host derivation. */
export { createCordisHostFromContext };
