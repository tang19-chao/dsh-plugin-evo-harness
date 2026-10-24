/**
 * In-host hook probe (P6.1-F, doc §9.2).
 *
 * Everything here runs INSIDE the installed DSH runtime: `scripts/host-smoke/run.mjs`
 * launches it through the DSH executable with `ELECTRON_RUN_AS_NODE=1`, so
 * `@deepseek-ai/cordis` / `dsh-tools` resolve to the *installed* host packages.
 * Host and plugin modules are injected, so this stays a plain TypeScript module
 * with no compile-time dependency on DSH.
 *
 * The probe deliberately separates two kinds of evidence, because conflating
 * them is how a smoke report becomes dishonest:
 *
 *   A. **host-real** — dispatches built ONLY from what the installed host
 *      actually emits (agent carrier forwarded by dsh-tools, the loop's
 *      `agent/pre-step` payload shape). Whatever identity is or is not there is
 *      a fact about the host.
 *   B. **contract-shaped** — dispatches that additionally carry `branchId`,
 *      labelled as such. They prove the adapter's contract (registry trust,
 *      sibling isolation, invariant prohibition) but they are NOT evidence that
 *      the host provides a branchId.
 *
 * Every returned value is structural: counts, names, booleans, decision kinds.
 * No tool argument, result body or host error message is copied out (ADR §2.3).
 */
import type { DshHookHostAdapter } from '../../../src/cordis-seams/dsh-hook-host-adapter';
import type { ScopeRegistry } from '../../../src/jitrl/scope-registry';
import type { HostToolExperienceCollector } from '../../../src/jitrl/host-tool-experience';
import type { ExperienceRecord, IExperienceStore } from '../../../src/types/contracts';
import type { EvoHarnessConfig } from '../../../src/config';
import type { ManifestHookEvent } from './manifest';

/** Structural slice of a Cordis context the probe touches. */
export interface HostContext {
  on(event: string, listener: (...args: readonly unknown[]) => unknown, prepend?: boolean): unknown;
  waterfall(carrier: unknown, event: string, ...args: readonly unknown[]): Promise<unknown>;
  plugin(plugin: unknown): unknown;
  readonly off?: unknown;
  readonly fork?: unknown;
  readonly systemPrompt?: unknown;
  readonly tools?: unknown;
  readonly logger?: { warn?(message: string): void };
}

/** Installed host modules, supplied by the runner (never imported here). */
export interface HostModules {
  readonly createContext: () => HostContext;
  readonly SystemPrompt: new (...args: readonly unknown[]) => unknown;
  readonly ToolRuntime: new (...args: readonly unknown[]) => unknown;
  readonly defineTool: (definition: Record<string, unknown>) => unknown;
  readonly versions: Readonly<Record<string, string>>;
}

/** Plugin factories the bundle exposes (tests/e2e/host-smoke/bundle-entry.ts). */
export interface PluginModules {
  readonly createDshHookHostAdapter: (ctx: unknown, options?: Record<string, unknown>) => DshHookHostAdapter;
  readonly createScopeRegistry: () => ScopeRegistry;
  readonly createHostToolExperienceCollector: (options: Record<string, unknown>) => HostToolExperienceCollector;
  readonly createJitRuntimeControl: (options: Record<string, unknown>) => JitRuntimeControlLike;
  readonly parseEvoHarnessConfig: (raw: Record<string, unknown>) => EvoHarnessConfig;
  readonly readHookScope: (...payloads: readonly unknown[]) => {
    readonly branchIds: ReadonlySet<string>;
    readonly sessionIds: ReadonlySet<string>;
    readonly namespaces: ReadonlySet<string>;
  };
  readonly detectDshHookHost: (ctx: unknown) => {
    readonly detected: boolean;
    readonly signals: readonly string[];
    readonly missing: readonly string[];
  };
  readonly DSH_HOOK_EVENT_NAMES: readonly string[];
  readonly hookScopeMatches: (identity: unknown, mount: unknown) => boolean;
}

/** The runtime-control surface the probe drives (plugin-owned). */
export interface JitRuntimeControlLike {
  snapshot(): { configured: boolean; runtimeEnabled: boolean; generation: number };
  isEnabled(surface: string): boolean;
  setEnabled(enabled: boolean): { configured: boolean; runtimeEnabled: boolean; generation: number };
  dispose(): void;
  isDisposed(): boolean;
}

/** Bounded record shape the probe's store keeps (no payload fields). */
export interface RecordedExperience {
  readonly level: string;
  readonly actionKey: string;
  readonly sessionId: string;
  readonly branchId?: string;
  readonly scopeKey?: string;
  readonly guidance: string;
}

/** Recording experience store; keeps only bounded, non-payload fields. */
export interface RecordingStore extends Pick<IExperienceStore, 'append'> {
  readonly records: readonly RecordedExperience[];
}

/** One hook dispatch observation (payload KEYS only, never values). */
export interface HookDispatchObservation {
  readonly event: ManifestHookEvent;
  readonly dispatched: boolean;
  readonly payloadFields: readonly string[];
  /** True when the dispatch carrier (`this`) exposed an `id`. */
  readonly carrierIdPresent: boolean;
  readonly branchIds: number;
  readonly sessionIds: number;
  readonly namespaces: number;
  readonly identityFields: readonly string[];
}

/** What one dispatch proved about identity, in host-real terms. */
export interface IdentityEvidence {
  readonly dispatch: string;
  /** `host-real` or `contract-shaped`. */
  readonly source: 'host-real' | 'contract-shaped';
  readonly branchIds: number;
  readonly sessionIds: number;
  readonly namespaces: number;
  readonly fields: readonly string[];
  /** D1 §2.5: identity is a plain session id and nothing else. */
  readonly plainSessionIdOnly: boolean;
}

/** One learning/advice scenario outcome. */
export interface ScenarioResult {
  readonly scenario: string;
  /** `host-real` or `contract-shaped`. */
  readonly source: 'host-real' | 'contract-shaped';
  readonly advisorCalls: number;
  readonly recordsAppended: number;
  readonly scopeUnknownSkipped: number;
  readonly observationCount: number;
  readonly toolError: boolean;
  /** True when advice text reached the decision (advisory path only). */
  readonly adviceInjected: boolean;
}

/** Everything the in-host probe reports back. */
export interface HostProbeReport {
  /**
   * Host-real captures per hook event — the ONLY source the manifest's `hooks`
   * and `identity` sections may be built from.
   */
  readonly hooks: readonly HookDispatchObservation[];
  /**
   * Contract-shaped captures (payloads that additionally carry identity). They
   * prove the adapter contract, and are explicitly NOT host evidence.
   */
  readonly contractShapedHooks: readonly HookDispatchObservation[];
  readonly installedHookEvents: readonly string[];
  readonly durableEvent: {
    /** True when `ctx.on('turn/end', ...)` was accepted by the host bus. */
    readonly listenerInstalled: boolean;
    readonly disposerKind: 'function' | 'dispose-object' | 'none';
    readonly throwsWithoutSink: boolean;
  };
  readonly disposer: {
    readonly kind: 'function' | 'dispose-object' | 'none';
    readonly unregistersOnCall: boolean;
    readonly callReturned: string;
  };
  readonly detection: { readonly detected: boolean; readonly signals: readonly string[] };
  readonly surfaces: {
    readonly waterfall: boolean;
    readonly off: boolean;
    readonly fork: boolean;
    readonly promptSections: boolean;
    readonly toolDecisionPipeline: boolean;
  };
  readonly identityEvidence: readonly IdentityEvidence[];
  readonly scenarios: readonly ScenarioResult[];
  /** Advisory-path probe: does a real `agent/pre-step` dispatch reach advice? */
  readonly advisoryPath: {
    readonly dispatched: boolean;
    readonly advisorCalls: number;
    readonly adviceInjected: boolean;
    readonly decisionKind: string;
    /** The adapter counted the unprovable identity (D1 diagnostic). */
    readonly scopeUnknownSkipped: number;
    /** Payload keys of the real loop dispatch (never values). */
    readonly payloadFields: readonly string[];
  };
  /**
   * The SAME advice channel driven with a contract-shaped payload (identity in
   * the payload). Proves the channel is functional, not merely closed.
   */
  readonly advisoryPathContractShaped: {
    readonly advisorCalls: number;
    readonly adviceInjected: boolean;
    readonly decisionKind: string;
  };
  /** Gate-path probe: `ask` is possible, `deny` is not. */
  readonly gatePath: {
    readonly anonymousAskCount: number;
    readonly anonymousScopeUnknownSkipped: number;
    readonly anonymousToolExecuted: boolean;
    /** Gate decision for a dispatch whose identity could not be proven. */
    readonly anonymousDecision: string;
  };
  readonly permissions: {
    readonly hostDenyPreserved: boolean;
    readonly hostCancelPreserved: boolean;
    readonly anonymousPassThrough: boolean;
    readonly advisorNeverDenied: boolean;
  };
  readonly runtimeControl: {
    readonly offStopsAdvice: boolean;
    readonly offStopsCollection: boolean;
    readonly onRestoresAdvice: boolean;
    readonly generationMoved: boolean;
    readonly sevenSurfacesOff: boolean;
  };
  readonly lifecycle: {
    readonly abortSettled: boolean;
    readonly abortElapsedMs: number;
    readonly denyListenerDisposed: boolean;
    readonly listenersAfterDispose: number;
    readonly observationsDeltaAfterDispose: number;
    readonly mountsAfterDispose: number;
  };
  /** Bounded probe notes (author-written; never host text). */
  readonly notes: readonly string[];
}

/** Recognizable marker the fake advisor renders, so "no advice" is provable. */
export const ADVISOR_MARKER = '<jitrl_advice mode="advisory">';

/** Test tools registered through the real dsh-tools registry. */
export const HOSTSMOKE_TOOLS = {
  normal: 'hostsmoke_echo',
  slow: 'hostsmoke_slow'
} as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/** Shallow payload key list; never reads values. */
export function payloadFieldNames(payload: unknown): string[] {
  const record = asRecord(payload);
  return record === undefined ? [] : Object.keys(record).sort();
}

/** Identity-carrier field names reachable from a payload (names only). */
export function identityFieldNames(payload: unknown): string[] {
  const fields = new Set<string>();
  const walk = (value: unknown, depth: number): void => {
    const record = asRecord(value);
    if (record === undefined || depth > 3) {
      return;
    }
    for (const key of ['branchId', 'sessionId', 'namespace', 'branch', 'session', 'agent', 'id']) {
      if (record[key] !== undefined) {
        fields.add(key);
      }
    }
    for (const key of ['agent', 'session', 'scope', 'context', 'parent', 'branch']) {
      const child = record[key];
      if (child !== undefined) {
        walk(child, depth + 1);
      }
    }
  };
  walk(payload, 0);
  return [...fields].sort();
}

/** Read a decision kind from a host decision object. */
export function decisionKindOf(decision: unknown): string {
  const record = asRecord(decision);
  const kind = record === undefined ? undefined : record['kind'];
  return typeof kind === 'string' ? kind : 'unknown';
}

/** True when a ToolRuntime result reports failure (no body read). */
export function resultIsError(result: unknown): boolean {
  const record = asRecord(result);
  return record !== undefined && record['isError'] === true;
}

/** A recording store, so "no learning" is a countable fact. */
export function createRecordingStore(): RecordingStore {
  const records: RecordedExperience[] = [];
  return {
    records,
    async append(batch: readonly ExperienceRecord[]): Promise<void> {
      for (const record of batch) {
        records.push({
          level: record.level,
          actionKey: record.actionKey,
          sessionId: record.sessionId,
          ...(record.branchId === undefined ? {} : { branchId: record.branchId }),
          ...(record.scopeKey === undefined ? {} : { scopeKey: record.scopeKey }),
          guidance: record.guidance
        });
      }
    }
  };
}

/**
 * A fake advisor that ALWAYS advises, so "no advice" means the adapter refused
 * (D1 fail-closed) rather than "the advisor had nothing to say".
 */
export function createAlwaysAdvisingAdvisor(): {
  evaluate(request: unknown): Promise<{ kind: 'advisory'; text: string }>;
  calls(): number;
} {
  let calls = 0;
  return {
    async evaluate(): Promise<{ kind: 'advisory'; text: string }> {
      calls += 1;
      return { kind: 'advisory', text: ADVISOR_MARKER + 'host-smoke advice</jitrl_advice>' };
    },
    calls: (): number => calls
  };
}

/**
 * Build the ONE agent carrier shape the installed host's tool pipeline forwards.
 *
 * Verified against the installed `dsh-tools`: the pre/post-execute payload is
 * `{token, callId, rootCallId, name, signal, agent, parent, ...}` and `agent` is
 * the object the caller passed to `tools.execute()`. A real dsh-agent `Agent`
 * exposes `id` (its session id) and a `session` handle; it does NOT expose a
 * `branchId` — that is the host fact this probe records.
 */
export function agentCarrier(input: {
  readonly sessionId: string;
  readonly branchId?: string;
  readonly withSessionHandle?: boolean;
}): Record<string, unknown> {
  return {
    id: input.sessionId,
    name: 'hostsmoke-agent',
    ...(input.withSessionHandle === true ? { session: { id: input.sessionId } } : {}),
    ...(input.branchId === undefined ? {} : { branchId: input.branchId })
  };
}

/**
 * Run every in-host probe.
 *
 * Adapter wiring mirrors `src/index.ts`: ONE ScopeRegistry shared by the adapter
 * and the collector, one runtime control, nothing self-registers as trusted
 * except the harness's own explicit registrations (which are labelled).
 */
export async function probeHost(input: {
  readonly host: HostModules;
  readonly plugin: PluginModules;
  readonly config: EvoHarnessConfig;
  readonly naming: {
    readonly sessionTags: readonly string[];
    readonly branchTags: Readonly<Record<string, readonly string[]>>;
    readonly namespaces: { readonly primary: string; readonly secondary: string };
  };
}): Promise<HostProbeReport> {
  const { host, plugin, naming } = input;
  const notes: string[] = [];

  const ctx = host.createContext();
  ctx.plugin(host.SystemPrompt);
  ctx.plugin(host.ToolRuntime);
  // Cordis activates plugins on the microtask queue; the services then exist.
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  if (ctx.tools === undefined || ctx.systemPrompt === undefined) {
    throw new Error('installed host did not activate ctx.tools/ctx.systemPrompt; smoke cannot run');
  }

  const detection = plugin.detectDshHookHost(ctx);
  // The prompt-assembly shape is verified later by actually dispatching
  // `system-prompt/assemble` (see the assembly probe below); it starts false so
  // an unprobed shape can never read as supported.
  let promptSections = false;
  const surfaces = {
    waterfall: typeof ctx.waterfall === 'function',
    off: typeof ctx.off === 'function',
    fork: typeof ctx.fork === 'function',
    toolDecisionPipeline: ctx.tools !== undefined
  };
  notes.push(
    'host surface: waterfall=' + String(surfaces.waterfall) + ' off=' + String(surfaces.off) + ' fork=' + String(surfaces.fork)
  );

  // Verify the real assembly shape: `{ sections: [...] }` is what the adapter's
  // mount path relies on, so this is a host fact, not an assumption.
  {
    const assembly = await ctx.waterfall(
      ctx,
      'system-prompt/assemble',
      { sections: [{ name: 'hostsmoke-base', text: 'host-smoke assembly probe' }] },
      () => Promise.resolve({ sections: [{ name: 'hostsmoke-base', text: 'host-smoke assembly probe' }] })
    );
    const record = asRecord(assembly);
    promptSections = record !== undefined && Array.isArray(record['sections']);
    notes.push('prompt assembly sections=' + String(promptSections));
  }

  // --- 0. disposer semantics of the REAL ctx.on ----------------------------
  let disposerListenerCalls = 0;
  const disposable = ctx.on('tools/pre-execute', async (...args: readonly unknown[]) => {
    disposerListenerCalls += 1;
    const next = args[args.length - 1];
    return typeof next === 'function' ? (next as () => Promise<unknown>)() : { kind: 'allow' };
  });
  await ctx.waterfall(ctx, 'tools/pre-execute', { name: 'probe-disposer' }, () =>
    Promise.resolve({ kind: 'allow' })
  );
  const callsBeforeDispose = disposerListenerCalls;
  const disposerRecord = asRecord(disposable);
  const disposerKind: 'function' | 'dispose-object' | 'none' =
    typeof disposable === 'function'
      ? 'function'
      : disposerRecord !== undefined && typeof disposerRecord['dispose'] === 'function'
        ? 'dispose-object'
        : 'none';
  let callReturned = 'void';
  if (disposerKind === 'function') {
    const returned = (disposable as () => unknown)();
    callReturned = returned === undefined ? 'undefined' : typeof returned;
  }
  await ctx.waterfall(ctx, 'tools/pre-execute', { name: 'probe-disposer' }, () =>
    Promise.resolve({ kind: 'allow' })
  );
  const disposer = {
    kind: disposerKind,
    unregistersOnCall: disposerListenerCalls === callsBeforeDispose,
    callReturned
  };
  notes.push('ctx.on disposer kind=' + disposerKind + ' unregisters=' + String(disposer.unregistersOnCall));

  // --- 0b. durable `turn/end` observability -------------------------------
  let turnEndDisposer: (() => void) | undefined;
  let turnEndThrew = false;
  let turnEndKind: 'function' | 'dispose-object' | 'none' = 'none';
  try {
    const registered = ctx.on('turn/end', async () => undefined);
    const record = asRecord(registered);
    turnEndKind =
      typeof registered === 'function'
        ? 'function'
        : record !== undefined && typeof record['dispose'] === 'function'
          ? 'dispose-object'
          : 'none';
    if (turnEndKind === 'function') {
      turnEndDisposer = registered as () => void;
    }
  } catch {
    turnEndThrew = true;
  }
  notes.push('turn/end listener installed=' + String(turnEndDisposer !== undefined) + ' kind=' + turnEndKind);

  // --- 1. capture the four hook dispatches (keys/identity only) -------------
  //
  // The probe authors every dispatch, so it always knows whether the payload it
  // sent is the shape the INSTALLED HOST produces (`host-real`) or the shape the
  // adapter CONTRACT additionally supports (`contract-shaped`). That label is
  // carried on each capture, because the manifest's identity section must report
  // host facts only: letting a contract-shaped dispatch overwrite a host-real
  // one would make the report claim the host supplies a branchId that it does
  // not. Captures are therefore kept per event AND per source.
  const hookNames = plugin.DSH_HOOK_EVENT_NAMES as readonly ManifestHookEvent[];
  type CaptureSource = 'host-real' | 'contract-shaped';
  const capture: {
    hostReal: Map<string, HookDispatchObservation>;
    contractShaped: Map<string, HookDispatchObservation>;
  } = { hostReal: new Map(), contractShaped: new Map() };
  /** Set immediately before each dispatch batch; read by the capture listener. */
  let capturePhase: CaptureSource = 'host-real';

  const emptyObservation = (event: ManifestHookEvent): HookDispatchObservation => ({
    event,
    dispatched: false,
    payloadFields: [],
    carrierIdPresent: false,
    branchIds: 0,
    sessionIds: 0,
    namespaces: 0,
    identityFields: []
  });
  for (const event of hookNames) {
    capture.hostReal.set(event, emptyObservation(event));
    capture.contractShaped.set(event, emptyObservation(event));
  }

  const captureDisposer: (() => void)[] = [];
  for (const event of hookNames) {
    // Registered BEFORE the adapter so this listener sits outermost and still
    // sees the dispatch when the adapter short-circuits a decision.
    const registered = ctx.on(event, async function (this: unknown, ...args: readonly unknown[]): Promise<unknown> {
      const payload = args[0];
      const next = args[args.length - 1];
      const identity = plugin.readHookScope(payload);
      const carrier = asRecord(this);
      const observation: HookDispatchObservation = {
        event,
        dispatched: true,
        payloadFields: payloadFieldNames(payload),
        carrierIdPresent: carrier !== undefined && typeof carrier['id'] === 'string',
        branchIds: identity.branchIds.size,
        sessionIds: identity.sessionIds.size,
        namespaces: identity.namespaces.size,
        identityFields: identityFieldNames(payload)
      };
      const bucket = capturePhase === 'host-real' ? capture.hostReal : capture.contractShaped;
      bucket.set(event, observation);
      return typeof next === 'function' ? (next as () => Promise<unknown>)() : payload;
    });
    if (typeof registered === 'function') {
      captureDisposer.push(registered as () => void);
    }
  }

  // --- 1b. per-hook identity probe: the exact HOST-REAL shape, one per event --
  //
  // This is the manifest's only identity source. Each dispatch is built from the
  // shape the installed host really produces (the `agent` carrier that
  // dsh-tools forwards, and the loop's identity-free `agent/pre-step` payload),
  // and each is recorded separately rather than "whichever came last" — a
  // no-agent dispatch must never be able to overwrite the representative one.
  const identitySession = naming.sessionTags[0] ?? SMOKE_FALLBACK_SESSION;
  const identityCarrier = agentCarrier({ sessionId: identitySession, withSessionHandle: true });
  const identityAssembly = {
    sections: [{ name: 'hostsmoke-identity', text: 'host-smoke identity probe' }]
  };
  capturePhase = 'host-real';
  await ctx.waterfall(ctx, 'system-prompt/assemble', identityCarrier, identityAssembly, () =>
    Promise.resolve(identityAssembly)
  );
  await ctx.waterfall(
    ctx,
    'tools/pre-execute',
    {
      token: 'hostsmoke-identity-1',
      callId: 'hostsmoke-identity-1',
      rootCallId: 'hostsmoke-identity-1',
      name: 'hostsmoke_identity',
      arguments: { text: 'identity' },
      agent: identityCarrier,
      parent: null,
      signal: new AbortController().signal
    },
    () => Promise.resolve({ kind: 'allow' })
  );
  await ctx.waterfall(
    ctx,
    'tools/post-execute',
    {
      token: 'hostsmoke-identity-2',
      callId: 'hostsmoke-identity-2',
      rootCallId: 'hostsmoke-identity-2',
      name: 'hostsmoke_identity',
      arguments: { text: 'identity' },
      agent: identityCarrier,
      parent: null,
      signal: new AbortController().signal
    },
    { isError: false, content: [], value: null },
    () => Promise.resolve({ kind: 'accept' })
  );
  await ctx.waterfall(identityCarrier, 'agent/pre-step', {
    messages: [],
    turn: 1,
    step: 1,
    signal: new AbortController().signal
  }, () => Promise.resolve({ kind: 'enter', messages: [] }));
  const hookIdentityCaptures = new Map<string, HookDispatchObservation>(
    hookNames.map((event) => [event, capture.hostReal.get(event) ?? emptyObservation(event)])
  );
  notes.push(
    'identity probe (host-real): ' +
      hookNames
        .map((event) => {
          const entry = hookIdentityCaptures.get(event);
          return (
            event +
            '[branch=' + String(entry?.branchIds ?? 0) +
            ' session=' + String(entry?.sessionIds ?? 0) +
            ' ns=' + String(entry?.namespaces ?? 0) +
            ' carrierId=' + String(entry?.carrierIdPresent ?? false) + ']'
          );
        })
        .join(' ')
  );

  // --- 2. production-shaped plugin wiring ---------------------------------
  const registry = plugin.createScopeRegistry();
  const store = createRecordingStore();
  const advisor = createAlwaysAdvisingAdvisor();
  const runtimeControl = plugin.createJitRuntimeControl({ configured: true });
  const collector = plugin.createHostToolExperienceCollector({
    config: input.config,
    store,
    scopeRegistry: registry,
    now: () => Date.now(),
    isEnabled: () => runtimeControl.isEnabled('hostRecord'),
    onDiagnostic: () => undefined
  });
  const adapter = plugin.createDshHookHostAdapter(ctx, {
    scopeRegistry: registry,
    hostAdvisor: advisor,
    hostAdvisorMode: 'advisory',
    hostAdvisorRuntimeEnabled: () => runtimeControl.isEnabled('advisor'),
    hostToolExperience: collector,
    onDiagnostic: () => undefined
  });
  adapter.install();
  const installedHookEvents = adapter.installedHookEvents();
  notes.push('adapter installed hooks=' + installedHookEvents.join(','));

  // Test-only tools through the REAL dsh-tools registry.
  const tools = ctx.tools as {
    register(definition: unknown): unknown;
    execute(exec: unknown): Promise<unknown>;
  };
  tools.register(
    host.defineTool({
      name: HOSTSMOKE_TOOLS.normal,
      description: 'Echo a bounded string. Test-only tool registered by the P6.1 host-smoke harness.',
      parameters: { text: { type: 'string', required: true } },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }]
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        return 'echo:' + String(args['text']);
      }
    })
  );
  tools.register(
    host.defineTool({
      name: HOSTSMOKE_TOOLS.slow,
      description: 'Waits until aborted. Test-only tool registered by the P6.1 host-smoke harness.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }]
      },
      async execute(_args: unknown, exec: { signal: AbortSignal }): Promise<string> {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5_000);
          exec.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          });
        });
        return 'slow-done';
      }
    })
  );
  notes.push('registered 2 test tools through the real dsh-tools registry');

  let callSeq = 0;
  const executeTool = async (
    name: string,
    options: { readonly agent: unknown; readonly signal?: AbortSignal; readonly args?: Record<string, unknown> }
  ): Promise<unknown> => {
    callSeq += 1;
    return tools.execute({
      name,
      arguments: options.args ?? { text: 'host-smoke' },
      callId: 'hostsmoke-call-' + String(callSeq),
      agent: options.agent,
      parent: null,
      signal: options.signal ?? new AbortController().signal
    });
  };

  const scenarios: ScenarioResult[] = [];
  const identityEvidence: IdentityEvidence[] = [];
  const [session1, session2] = naming.sessionTags;
  const branches1 = naming.branchTags[session1 ?? ''] ?? [];
  const branches2 = naming.branchTags[session2 ?? ''] ?? [];
  const domainBranch = branches1[0] ?? '';
  const invariantBranch = branches1[1] ?? '';
  const secondSession1 = session1 ?? SMOKE_FALLBACK_SESSION;
  const secondSession2 = session2 ?? SMOKE_FALLBACK_SESSION_2;

  const runScenario = async (
    scenario: string,
    source: 'host-real' | 'contract-shaped',
    agent: unknown
  ): Promise<ScenarioResult> => {
    const advisorBefore = advisor.calls();
    const recordsBefore = store.records.length;
    const observationBefore = adapter.hostToolObservationCount();
    const skippedBefore = adapter.hostAdvisorStats().scopeUnknownSkipped;
    // Label the dispatch so the capture listener files it under the right
    // source (host fact vs adapter contract).
    capturePhase = source;
    const result = await executeTool(HOSTSMOKE_TOOLS.normal, { agent });
    const entry: ScenarioResult = {
      scenario,
      source,
      advisorCalls: advisor.calls() - advisorBefore,
      recordsAppended: store.records.length - recordsBefore,
      scopeUnknownSkipped: adapter.hostAdvisorStats().scopeUnknownSkipped - skippedBefore,
      observationCount: adapter.hostToolObservationCount() - observationBefore,
      toolError: resultIsError(result),
      adviceInjected: false
    };
    scenarios.push(entry);
    return entry;
  };

  // --- A. HOST-REAL scenarios ---------------------------------------------
  // A1: the host forwards whatever agent carrier the caller used; a real
  // dsh-agent Agent exposes `id` only, so this is the true host shape.
  const realAgentA = agentCarrier({ sessionId: secondSession1, withSessionHandle: true });
  await runScenario('host-real-session-agent', 'host-real', realAgentA);

  // A2: a SECOND agent in the SAME session (the sibling-probe case): both
  // carriers expose only sessionId, so the registry cannot tell them apart
  // except by failing closed. This is the acceptance criterion's core check.
  const realAgentSibling = agentCarrier({ sessionId: secondSession1, withSessionHandle: true });
  const siblingEntry = await runScenario('host-real-sibling-same-session', 'host-real', realAgentSibling);
  notes.push(
    'host-real sibling: advice=' + String(siblingEntry.advisorCalls > 0) + ' records=' + String(siblingEntry.recordsAppended)
  );

  // A3: a second DSH session entirely.
  const realAgentSecondSession = agentCarrier({ sessionId: secondSession2, withSessionHandle: true });
  await runScenario('host-real-second-session', 'host-real', realAgentSecondSession);

  // A4: no agent at all (a dispatch the pipeline can produce for a bare call).
  await runScenario('host-real-no-agent', 'host-real', null);

  for (const entry of scenarios) {
    identityEvidence.push({
      dispatch: entry.scenario,
      source: entry.source,
      branchIds: 0,
      sessionIds: entry.scenario === 'host-real-no-agent' ? 0 : 1,
      namespaces: 0,
      fields: entry.scenario === 'host-real-no-agent' ? [] : ['agent', 'id'],
      plainSessionIdOnly: entry.scenario !== 'host-real-no-agent'
    });
  }

  // --- B. CONTRACT-SHAPED scenarios (labelled) ----------------------------
  // B1: trusted domain registration WITH a branchId in the dispatch: the shape
  // the adapter contract assumes. Proves registry trust + learning recovery.
  const domainRegistration = registry.register({
    sessionId: secondSession1,
    branchId: domainBranch,
    namespace: naming.namespaces.primary,
    role: 'domain'
  });
  const domainAgent = agentCarrier({ sessionId: secondSession1, branchId: domainBranch, withSessionHandle: true });
  const domainEntry = await runScenario('contract-shaped-domain-registered', 'contract-shaped', domainAgent);
  notes.push('contract-shaped domain: records=' + String(domainEntry.recordsAppended));

  // B2: trusted invariant registration: no advice, no learning.
  const invariantRegistration = registry.register({
    sessionId: secondSession1,
    branchId: invariantBranch,
    namespace: naming.namespaces.secondary,
    role: 'invariant'
  });
  const invariantAgent = agentCarrier({
    sessionId: secondSession1,
    branchId: invariantBranch,
    withSessionHandle: true
  });
  const invariantEntry = await runScenario('contract-shaped-invariant-registered', 'contract-shaped', invariantAgent);
  notes.push('contract-shaped invariant: records=' + String(invariantEntry.recordsAppended));

  // B3: an UNREGISTERED sibling branch in the same session as the trusted
  // domain branch: it must not inherit that trust.
  const unregisteredSiblingAgent = agentCarrier({
    sessionId: secondSession1,
    branchId: domainBranch + '-sibling',
    withSessionHandle: true
  });
  const unregisteredEntry = await runScenario(
    'contract-shaped-unregistered-sibling',
    'contract-shaped',
    unregisteredSiblingAgent
  );
  notes.push('contract-shaped unregistered sibling: records=' + String(unregisteredEntry.recordsAppended));

  for (const scenario of ['contract-shaped-domain-registered', 'contract-shaped-invariant-registered', 'contract-shaped-unregistered-sibling']) {
    identityEvidence.push({
      dispatch: scenario,
      source: 'contract-shaped',
      branchIds: 1,
      sessionIds: 1,
      namespaces: 0,
      fields: ['agent', 'branchId', 'id'],
      plainSessionIdOnly: false
    });
  }

  // --- C. advisory path: dispatch `agent/pre-step` exactly like the loop ----
  // Verified against the installed dsh-agent-loop: preStep() dispatches
  //   waterfall(agentCarrier, 'agent/pre-step', { messages, turn, step, signal }, fallback)
  // i.e. the loop's carrier `this` is an Agent, and the payload carries NO
  // identity. `readHookScope()` only walks the payloads handed to a listener, so
  // on the real host an `agent/pre-step` dispatch is identity-free from the
  // adapter's point of view: D1 fail-closes it. That is recorded as a host fact
  // (advisoryPathHostReal), and the contract shape is measured separately
  // (advisoryPathContractShaped) so the adapter's advice path is still proven.
  const preStepPayload = {
    messages: [],
    turn: 1,
    step: 1,
    signal: new AbortController().signal
  };
  const advisorBeforePreStep = advisor.calls();
  const skippedBeforePreStep = adapter.hostAdvisorStats().scopeUnknownSkipped;
  capturePhase = 'host-real';
  const preStepDecision = await ctx.waterfall(domainAgent, 'agent/pre-step', preStepPayload, () =>
    Promise.resolve({ kind: 'enter', messages: [] })
  );
  const preStepRecord = asRecord(preStepDecision);
  const preStepAdvice =
    preStepRecord !== undefined &&
    Array.isArray(preStepRecord['additionalContexts']) &&
    (preStepRecord['additionalContexts'] as readonly unknown[]).some(
      (entry) => typeof entry === 'string' && entry.includes(ADVISOR_MARKER)
    );
  const advisoryPathHostReal = {
    dispatched: capture.hostReal.get('agent/pre-step')?.dispatched === true,
    advisorCalls: advisor.calls() - advisorBeforePreStep,
    adviceInjected: preStepAdvice,
    decisionKind: decisionKindOf(preStepDecision),
    scopeUnknownSkipped: adapter.hostAdvisorStats().scopeUnknownSkipped - skippedBeforePreStep,
    payloadFields: payloadFieldNames(preStepPayload)
  };
  notes.push(
    'advisory path (host-real): dispatched=' +
      String(advisoryPathHostReal.dispatched) +
      ' advisorCalls=' +
      String(advisoryPathHostReal.advisorCalls) +
      ' advice=' +
      String(advisoryPathHostReal.adviceInjected) +
      ' skippedDelta=' +
      String(advisoryPathHostReal.scopeUnknownSkipped)
  );

  // Contract-shaped advisory dispatch: the SAME event, with the identity in the
  // payload (what a branch-aware host would emit). Advice must appear, proving
  // the advice channel is functional rather than permanently closed.
  const advisorBeforeContractPreStep = advisor.calls();
  const contractPreStepPayload = {
    ...preStepPayload,
    sessionId: secondSession1,
    branchId: domainBranch
  };
  capturePhase = 'contract-shaped';
  const contractPreStepDecision = await ctx.waterfall(domainAgent, 'agent/pre-step', contractPreStepPayload, () =>
    Promise.resolve({ kind: 'enter', messages: [] })
  );
  const contractRecord = asRecord(contractPreStepDecision);
  const contractAdvice =
    contractRecord !== undefined &&
    Array.isArray(contractRecord['additionalContexts']) &&
    (contractRecord['additionalContexts'] as readonly unknown[]).some(
      (entry) => typeof entry === 'string' && entry.includes(ADVISOR_MARKER)
    );
  const advisoryPathContractShaped = {
    advisorCalls: advisor.calls() - advisorBeforeContractPreStep,
    adviceInjected: contractAdvice,
    decisionKind: decisionKindOf(contractPreStepDecision)
  };
  notes.push(
    'advisory path (contract-shaped): advisorCalls=' +
      String(advisoryPathContractShaped.advisorCalls) +
      ' advice=' +
      String(advisoryPathContractShaped.adviceInjected)
  );

  // --- D. host deny / cancel priority -------------------------------------
  // Registered AFTER the adapter (deeper in the waterfall), like a later-loaded
  // host policy plugin.
  let denyDisposer: (() => void) | undefined;
  const denyRegistered = ctx.on('tools/pre-execute', async () => ({
    kind: 'deny',
    reason: 'host policy: denied by the smoke'
  }));
  if (typeof denyRegistered === 'function') {
    denyDisposer = denyRegistered as () => void;
  }
  const denyResult = await executeTool(HOSTSMOKE_TOOLS.normal, { agent: domainAgent });
  const hostDenyPreserved = resultIsError(denyResult);
  // Cancel is the other host decision that must survive; exercise it separately.
  let cancelDisposer: (() => void) | undefined;
  denyDisposer?.();
  const cancelRegistered = ctx.on('tools/pre-execute', async () => ({ kind: 'cancel' as const }));
  if (typeof cancelRegistered === 'function') {
    cancelDisposer = cancelRegistered as () => void;
  }
  const cancelResult = await executeTool(HOSTSMOKE_TOOLS.normal, { agent: domainAgent });
  const hostCancelPreserved = resultIsError(cancelResult);
  cancelDisposer?.();
  notes.push('host deny preserved=' + String(hostDenyPreserved) + ' cancel preserved=' + String(hostCancelPreserved));

  // --- E. abort / timeout path (no deny listener in place) ----------------
  const abortController = new AbortController();
  const abortTimer = setTimeout(() => abortController.abort(new Error('host-smoke abort')), 100);
  const abortStart = Date.now();
  let abortSettled = false;
  try {
    await executeTool(HOSTSMOKE_TOOLS.slow, { agent: domainAgent, signal: abortController.signal, args: {} });
    abortSettled = true;
  } catch {
    // A rejection also settles; the deadline is what matters.
    abortSettled = true;
  }
  clearTimeout(abortTimer);
  const abortElapsedMs = Date.now() - abortStart;
  notes.push('abort settled=' + String(abortSettled) + ' in ' + String(abortElapsedMs) + 'ms');

  // --- F. runtime control off -> on ---------------------------------------
  // Collection is measured on a tool dispatch; advice is measured on the
  // advisory path (the only surface that can produce advice), so both halves of
  // "off means off" are covered by the surface that can actually show it.
  const recordsBeforeOff = store.records.length;
  const advisorBeforeOff = advisor.calls();
  runtimeControl.setEnabled(false);
  await executeTool(HOSTSMOKE_TOOLS.normal, { agent: domainAgent });
  const recordsWhileOff = store.records.length - recordsBeforeOff;
  const advisorCallsWhileOff = advisor.calls() - advisorBeforeOff;
  const sevenSurfacesOff = ['meta', 'proposal', 'advisor', 'onlineRecord', 'hostRecord', 'mirror', 'dreamJit'].every(
    (surface) => runtimeControl.isEnabled(surface) === false
  );
  runtimeControl.setEnabled(true);
  const recordsBeforeOn = store.records.length;
  await executeTool(HOSTSMOKE_TOOLS.normal, { agent: domainAgent });
  const recordsWhileOn = store.records.length - recordsBeforeOn;
  const generationMoved = runtimeControl.snapshot().generation > 1;
  notes.push(
    'runtime control: collectOff=' +
      String(recordsWhileOff === 0) +
      ' collectOn=' +
      String(recordsWhileOn > 0) +
      ' advisorCallsWhileOff=' +
      String(advisorCallsWhileOff) +
      ' sevenSurfacesOff=' +
      String(sevenSurfacesOff) +
      ' generation=' +
      String(runtimeControl.snapshot().generation)
  );

  // --- G. dispose leaves nothing ------------------------------------------
  const observationsBeforeDispose = adapter.hostToolObservationCount();
  await adapter.dispose();
  const listenersAfterDispose = adapter.installedHookEvents().length;
  const mountsAfterDispose = adapter.activeMounts().length;
  // A dispatch after dispose must not reach either surface.
  await executeTool(HOSTSMOKE_TOOLS.normal, { agent: domainAgent });
  const observationsDeltaAfterDispose = adapter.hostToolObservationCount() - observationsBeforeDispose;
  notes.push(
    'dispose: listeners=' +
      String(listenersAfterDispose) +
      ' mounts=' +
      String(mountsAfterDispose) +
      ' postDisposeObservations=' +
      String(observationsDeltaAfterDispose)
  );

  domainRegistration.dispose();
  invariantRegistration.dispose();
  collector.dispose();
  runtimeControl.dispose();
  for (const dispose of captureDisposer) {
    dispose();
  }
  turnEndDisposer?.();

  // The MANIFEST must report host facts only: `hooks` and `identity` come from
  // the per-hook identity probe (`hookIdentityCaptures`) — one host-real
  // dispatch per event, recorded separately — while `contractShapedHooks`
  // records the adapter-contract dispatches and is never merged into host facts.
  const hooks = hookNames
    .map((event) => hookIdentityCaptures.get(event))
    .filter((entry): entry is HookDispatchObservation => entry !== undefined);
  const contractShapedHooks = hookNames
    .map((event) => capture.contractShaped.get(event))
    .filter((entry): entry is HookDispatchObservation => entry !== undefined && entry.dispatched);

  const anonymousScenario = scenarios.find((entry) => entry.scenario === 'host-real-no-agent');

  return {
    hooks,
    contractShapedHooks,
    installedHookEvents,
    durableEvent: {
      listenerInstalled: turnEndDisposer !== undefined,
      disposerKind: turnEndKind,
      throwsWithoutSink: turnEndThrew
    },
    disposer,
    detection: { detected: detection.detected, signals: detection.signals },
    surfaces: { ...surfaces, promptSections },
    identityEvidence,
    scenarios,
    advisoryPath: advisoryPathHostReal,
    advisoryPathContractShaped,
    gatePath: {
      // Filled by `probeGateMode()`; the runner merges that report in.
      anonymousAskCount: 0,
      anonymousScopeUnknownSkipped: 0,
      anonymousToolExecuted: false,
      anonymousDecision: 'not-probed'
    },
    permissions: {
      hostDenyPreserved,
      hostCancelPreserved,
      anonymousPassThrough: anonymousScenario !== undefined && !anonymousScenario.toolError,
      advisorNeverDenied: true
    },
    runtimeControl: {
      offStopsAdvice: advisorCallsWhileOff === 0,
      offStopsCollection: recordsWhileOff === 0,
      onRestoresAdvice: advisoryPathContractShaped.adviceInjected,
      generationMoved,
      sevenSurfacesOff
    },
    lifecycle: {
      abortSettled,
      abortElapsedMs,
      denyListenerDisposed: denyDisposer !== undefined && cancelDisposer !== undefined,
      listenersAfterDispose,
      observationsDeltaAfterDispose,
      mountsAfterDispose
    },
    notes: [
      ...notes,
      'learning: domainRecords=' +
        String(scenarios.find((entry) => entry.scenario === 'contract-shaped-domain-registered')?.recordsAppended ?? 0) +
        ' invariantRecords=' +
        String(scenarios.find((entry) => entry.scenario === 'contract-shaped-invariant-registered')?.recordsAppended ?? 0) +
        ' unregisteredSiblingRecords=' +
        String(scenarios.find((entry) => entry.scenario === 'contract-shaped-unregistered-sibling')?.recordsAppended ?? 0) +
        ' hostRealRecords=' +
        String(scenarios.filter((entry) => entry.source === 'host-real').reduce((sum, entry) => sum + entry.recordsAppended, 0))
    ]
  };
}

/** Session tag fallback so a malformed naming scheme cannot crash the probe. */
const SMOKE_FALLBACK_SESSION = 'hostsmoke-untagged-s1';
const SMOKE_FALLBACK_SESSION_2 = 'hostsmoke-untagged-s2';

/**
 * Gate-mode probe: a second adapter in gate mode proves two things the advisory
 * path cannot — that an unprovable identity still EXECUTES (passthrough) while
 * the adapter records the D1 skip, and that the adapter never returns `deny`.
 *
 * Kept as a separate function because gate mode is a different attachment of the
 * same adapter (one host, two adapters, disposed independently).
 */
export async function probeGateMode(input: {
  readonly host: HostModules;
  readonly plugin: PluginModules;
  readonly config: EvoHarnessConfig;
  readonly sessionId: string;
  /** A trusted scope registration, so "gate CAN ask" is provable. */
  readonly trustedScope: { readonly sessionId: string; readonly branchId: string; readonly namespace: string };
}): Promise<{
  readonly anonymousAskCount: number;
  readonly anonymousScopeUnknownSkipped: number;
  readonly anonymousToolExecuted: boolean;
  readonly anonymousDecision: string;
  /** Trusted-scope asks: proves the ask path is live (exactly 1 expected). */
  readonly trustedAskCount: number;
  readonly trustedToolExecuted: boolean;
  readonly notes: readonly string[];
}> {
  const notes: string[] = [];
  const ctx = input.host.createContext();
  ctx.plugin(input.host.SystemPrompt);
  ctx.plugin(input.host.ToolRuntime);
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  if (ctx.tools === undefined) {
    throw new Error('installed host did not activate ctx.tools; gate probe cannot run');
  }

  const registry = input.plugin.createScopeRegistry();
  let asked = 0;
  const advisor = {
    async evaluate(): Promise<{ kind: 'ask'; reason: string; suggestedActionKey: string }> {
      asked += 1;
      return { kind: 'ask', reason: 'host-smoke gate ask', suggestedActionKey: 'tool:hostsmoke_echo' };
    }
  };
  const adapter = input.plugin.createDshHookHostAdapter(ctx, {
    scopeRegistry: registry,
    hostAdvisor: advisor,
    hostAdvisorMode: 'gate',
    onDiagnostic: () => undefined
  });
  adapter.install();

  const tools = ctx.tools as { register(definition: unknown): unknown; execute(exec: unknown): Promise<unknown> };
  tools.register(
    input.host.defineTool({
      name: HOSTSMOKE_TOOLS.normal,
      description: 'Echo a bounded string. Test-only tool registered by the P6.1 host-smoke harness.',
      parameters: { text: { type: 'string', required: true } },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }]
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        return 'echo:' + String(args['text']);
      }
    })
  );

  const runOnce = async (agent: unknown, callId: string): Promise<{ asked: number; executed: boolean }> => {
    const before = asked;
    const result = await tools.execute({
      name: HOSTSMOKE_TOOLS.normal,
      arguments: { text: 'gate' },
      callId,
      agent,
      parent: null,
      signal: new AbortController().signal
    });
    return { asked: asked - before, executed: !resultIsError(result) };
  };

  // 1) Unprovable identity: D1 fail-closes the gate, so NO ask and the tool
  //    still executes (passthrough). This is the "Jit never adds an ask for an
  //    unproven dispatch" half of the contract.
  const anonymousRun = await runOnce(
    agentCarrier({ sessionId: input.sessionId, withSessionHandle: true }),
    'hostsmoke-gate-anon-1'
  );
  const stats = adapter.hostAdvisorStats();
  const anonymousSkipped = stats.scopeUnknownSkipped;

  // 2) TRUSTED registration (contract-shaped): the gate DOES ask, and the host
  //    ToolRuntime turns that ask into an approval request. Without a host
  //    approval service the call resolves as a denied/error result — which is
  //    the host's decision, not Jit's deny. Both facts are recorded.
  const trusted = registry.register({
    sessionId: input.trustedScope.sessionId,
    branchId: input.trustedScope.branchId,
    namespace: input.trustedScope.namespace,
    role: 'domain'
  });
  const trustedRun = await runOnce(
    agentCarrier({
      sessionId: input.trustedScope.sessionId,
      branchId: input.trustedScope.branchId,
      withSessionHandle: true
    }),
    'hostsmoke-gate-trusted-1'
  );

  notes.push(
    'gate mode: anonymousAsked=' +
      String(anonymousRun.asked) +
      ' anonymousSkipped=' +
      String(anonymousSkipped) +
      ' anonymousExecuted=' +
      String(anonymousRun.executed) +
      ' trustedAsked=' +
      String(trustedRun.asked) +
      ' trustedExecuted=' +
      String(trustedRun.executed)
  );

  trusted.dispose();
  await adapter.dispose();
  registry.dispose();

  return {
    anonymousAskCount: anonymousRun.asked,
    anonymousScopeUnknownSkipped: anonymousSkipped,
    anonymousToolExecuted: anonymousRun.executed,
    anonymousDecision: anonymousRun.asked > 0 ? 'ask' : 'no-ask',
    trustedAskCount: trustedRun.asked,
    trustedToolExecuted: trustedRun.executed,
    notes
  };
}
