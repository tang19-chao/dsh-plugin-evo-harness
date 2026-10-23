/**
 * Real DeepSeek Harness (Cordis) Hook adapter.
 *
 * The host-neutral {@link CordisHostAdapter} in `host-adapter.ts` is satisfied by
 * structural service objects (`ctx.prompt.registerSegment`, `ctx.tools.patch…`).
 * A real DSH host exposes a second, stronger interception surface: named
 * waterfall events that every model step and tool call is dispatched through.
 * This module implements the adapter on top of those events, so a patch mounted
 * inside a probe branch is a real listener rather than a simulation:
 *
 *   system-prompt/assemble  -> prompt sections visible in the assembled prompt
 *   tools/pre-execute       -> allow / deny decisions before a tool body runs
 *   tools/post-execute      -> observation of the post-policy tool result
 *   agent/pre-step          -> observation of the proposed step decision
 *
 * Verified listener shapes (dsh-probe/pkgs/*, Cordis 4):
 *   - `(assembly, context, next) => Assembly`
 *   - `(exec, next) => ToolDecision`          (`{kind:'allow'|'deny'|'ask'|'cancel'}`)
 *   - `(exec, result, next) => ToolPostDecision`
 *   - `({agent, messages, signal, step}, next) => PreStepDecision`
 * A listener that does not own a decision must delegate with `next()`.
 *
 * Scope isolation
 * ---------------
 * A mount records the branch/session/namespace it belongs to. Every listener
 * resolves the identity of the dispatch (branch id, session id, agent id,
 * namespace) from the payload and applies only mounts owned by that identity.
 * A payload that names a branch matches on the branch alone, so a session shared
 * by sibling probe branches can never leak one branch's patch into another.
 * A dispatch that carries no identity at all is treated as host-local and sees
 * every mount; that is the only fail-open case and is documented in
 * {@link hookScopeMatches}.
 *
 * Lifetime
 * --------
 * Construction has no host side effect: the four listeners are installed on the
 * first seam request or on an explicit `install()` (the plugin calls it at
 * apply() time), and they stay installed for the adapter lifetime as transparent
 * pass-throughs while no mount exists. `dispose()` removes them, so a disposed
 * adapter leaves no host listener behind. Every mount disposer is idempotent and
 * removes exactly one mount.
 *
 * Mount order and host cooperation
 * --------------------------------
 * Listeners call `next()` first and only then adjust the result, so every other
 * plugin's contribution is preserved. `tools/pre-execute` never upgrades a deny
 * or cancel decided further down the chain. An `append` prompt mount never
 * overwrites a same-named section owned by another plugin; it appends under a
 * deterministic per-mount name instead.
 *
 * Enforcement subset
 * ------------------
 * Generated middleware code is *not* evaluated here (that belongs to the
 * builder that owns the sandbox). The deterministic subset enforced on
 * `tools/pre-execute` is:
 *   - `toolPreconditions[{ toolName, rule }]` whose rule starts with `deny`;
 *   - `forbiddenActions` entries shaped `tool:<name>` or `deny:<name>`;
 *   - `options.denyTools` supplied by the host integrator.
 * Every other natural-language rule is recorded as an advisory instead of being
 * silently treated as enforced.
 */
import type { HarnessComponentKey, MiddlewareHook } from '../types/contracts';
import type { HostAdvisorRequest } from '../types/contracts';
import type { HostAdvisor } from '../jitrl/host-advisor';
import type {
  HostToolExperienceSink,
  HostToolObservation,
  HostTurnKindObservation,
  HostTurnObservation
} from '../jitrl/host-tool-experience';
import { normalizeToolActionKey } from '../jitrl/action-normalizer';
import { abstractHostState } from '../jitrl/state-abstraction';
import { CordisSeamError } from './errors';
import type {
  CordisHostAdapter,
  HostDisposer,
  HostGuardrailsSpec,
  HostMiddlewareSpec,
  HostPromptSegmentSpec
} from './host-adapter';

/** The four DSH hook events this adapter owns. */
export const DSH_HOOK_EVENT_NAMES = [
  'system-prompt/assemble',
  'tools/pre-execute',
  'tools/post-execute',
  'agent/pre-step'
] as const;
export type DshHookEventName = (typeof DSH_HOOK_EVENT_NAMES)[number];

/** Human-readable source reported by the plugin when this adapter is selected. */
export const DSH_HOOK_HOST_SOURCE = 'dsh-hooks' as const;

/** Structural view of the parts of a DSH host context this adapter probes. */
export interface DshHookHostContext {
  readonly on?: (event: string, listener: (...args: unknown[]) => unknown) => unknown;
  readonly off?: (event: string, listener: (...args: unknown[]) => unknown) => unknown;
  readonly waterfall?: (carrier: unknown, event: string, ...args: unknown[]) => unknown;
  readonly systemPrompt?: unknown;
  readonly tools?: unknown;
  readonly agents?: unknown;
  readonly [key: string]: unknown;
}

/** Result of probing a context for the real DSH hook surface. */
export interface DshHookDetection {
  readonly detected: boolean;
  /** Positive signals that made detection succeed (or the missing ones). */
  readonly signals: readonly string[];
  /** Why detection failed; empty when detected. */
  readonly missing: readonly string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function hasFunction(holder: unknown, names: readonly string[]): boolean {
  const record = asRecord(holder);
  if (record === undefined) {
    return false;
  }
  return names.some((name) => typeof record[name] === 'function');
}

/**
 * True when the context exposes both the waterfall listener registrar and at
 * least one real DSH service (system prompt, tool runtime or agent registry).
 *
 * Requiring a service keeps a purely structural mock (`{ prompt: { register
 * Segment }, on() {} }`) on the structured-API path: hook interception without
 * the services a real host runs would only intercept an empty pipeline. A bare
 * context (`{}` or a logger-only fake) still falls through to in-memory.
 */
export function detectDshHookHost(ctx: unknown): DshHookDetection {
  const root = asRecord(ctx);
  const signals: string[] = [];
  const missing: string[] = [];
  if (root === undefined) {
    return { detected: false, signals: [], missing: ['ctx is not an object'] };
  }
  if (typeof root['on'] !== 'function') {
    missing.push('ctx.on(event, listener) is required to register hook listeners');
  } else {
    signals.push('ctx.on');
  }
  if (typeof root['waterfall'] === 'function') {
    signals.push('ctx.waterfall');
  }
  if (hasFunction(root['systemPrompt'], ['section', 'assemble'])) {
    signals.push('ctx.systemPrompt');
  }
  if (hasFunction(root['tools'], ['execute', 'schemas', 'register'])) {
    signals.push('ctx.tools');
  }
  if (hasFunction(root['agents'], ['create', 'get', 'list'])) {
    signals.push('ctx.agents');
  }
  const serviceCount = signals.filter((signal) => signal !== 'ctx.on' && signal !== 'ctx.waterfall').length;
  if (serviceCount === 0) {
    missing.push(
      'no DSH service was found (ctx.systemPrompt / ctx.tools / ctx.agents); structural seams use the context adapter'
    );
  }
  return { detected: missing.length === 0, signals, missing };
}

// ---------------------------------------------------------------------------
// Scope identity
// ---------------------------------------------------------------------------

/** Ids a hook dispatch can be attributed to. */
export interface HookScopeIdentity {
  readonly branchIds: ReadonlySet<string>;
  readonly sessionIds: ReadonlySet<string>;
  readonly namespaces: ReadonlySet<string>;
}

function addId(target: Set<string>, value: unknown): void {
  if (typeof value === 'string' && value.length > 0) {
    target.add(value);
    return;
  }
  const record = asRecord(value);
  if (record === undefined) {
    return;
  }
  const id = record['id'];
  if (typeof id === 'string' && id.length > 0) {
    target.add(id);
  }
}

const CARRIER_KEYS = ['agent', 'session', 'scope', 'context', 'parent', 'branch'] as const;

/**
 * Collect every branch/session/namespace identity reachable from a hook payload.
 *
 * The walk is deliberately narrow: known carrier keys plus a shallow read of
 * `id` on those carriers. It never treats an arbitrary `id` (a surface id, a
 * call id) as a session identity.
 */
export function readHookScope(...payloads: readonly unknown[]): HookScopeIdentity {
  const branchIds = new Set<string>();
  const sessionIds = new Set<string>();
  const namespaces = new Set<string>();

  const visit = (value: unknown, depth: number, readId: boolean): void => {
    const record = asRecord(value);
    if (record === undefined || depth > 4) {
      return;
    }
    if (readId) {
      const id = record['id'];
      if (typeof id === 'string' && id.length > 0) {
        // An agent/session carrier: the id doubles as the session identity.
        sessionIds.add(id);
      }
    }
    addId(branchIds, record['branchId']);
    addId(sessionIds, record['sessionId']);
    addId(namespaces, record['namespace']);
    addId(branchIds, record['branch']);
    addId(sessionIds, record['session']);
    if (record['branchName'] !== undefined) {
      addId(branchIds, record['branchName']);
    }
    for (const key of CARRIER_KEYS) {
      const child = record[key];
      if (child !== undefined) {
        visit(child, depth + 1, key === 'agent' || key === 'session' || key === 'branch');
      }
    }
  };

  for (const payload of payloads) {
    visit(payload, 0, false);
  }
  return { branchIds, sessionIds, namespaces };
}

/** Identity fields a mount is attributed to. */
export interface HookMountScope {
  readonly branchId: string;
  readonly sessionId: string;
  readonly namespace: string;
}

/**
 * Whether a mount applies to a dispatch with `identity`.
 *
 * Precedence matters for isolation: when the dispatch names a branch, only that
 * branch's mounts apply — a shared session id must never leak one probe branch's
 * patch into a sibling branch. Without a branch id the session (or namespace)
 * decides. A payload with no identity at all is host-local and fails open.
 */
export function hookScopeMatches(identity: HookScopeIdentity, mount: HookMountScope): boolean {
  const total = identity.branchIds.size + identity.sessionIds.size + identity.namespaces.size;
  if (total === 0) {
    return true;
  }
  if (identity.branchIds.size > 0) {
    return identity.branchIds.has(mount.branchId);
  }
  if (identity.sessionIds.size > 0) {
    return identity.sessionIds.has(mount.sessionId);
  }
  return mount.namespace.length > 0 && identity.namespaces.has(mount.namespace);
}

// ---------------------------------------------------------------------------
// Mount records
// ---------------------------------------------------------------------------

/** Deterministic denial derived from a guardrails mount or host policy. */
export interface DshHookDenyRule {
  /** Tool name, or `*` for every tool. */
  readonly toolName: string;
  readonly reason: string;
}

/** One active mount; exposed for diagnostics and tests. */
export interface DshHookMountSummary {
  readonly surfaceId: string;
  readonly kind: 'prompt' | 'guardrails' | 'middleware';
  readonly branchId: string;
  readonly sessionId: string;
  readonly namespace: string;
  readonly active: boolean;
}

interface MountBase extends HookMountScope {
  readonly surfaceId: string;
  readonly kind: DshHookMountSummary['kind'];
  active: boolean;
}

interface PromptMount extends MountBase {
  readonly kind: 'prompt';
  readonly segment: string;
  readonly mode: 'append' | 'replace';
  readonly content: string;
  readonly priority: number;
}

interface GuardrailsMount extends MountBase {
  readonly kind: 'guardrails';
  readonly denyRules: readonly DshHookDenyRule[];
  readonly advisories: readonly string[];
}

interface MiddlewareBinding {
  readonly name: string;
  readonly hook: MiddlewareHook;
}

interface MiddlewareMount extends MountBase {
  readonly kind: 'middleware';
  readonly bindings: readonly MiddlewareBinding[];
}

type HookMount = PromptMount | GuardrailsMount | MiddlewareMount;

/** Per-hook counters: `applied` means a scoped mount changed or observed the call. */
export interface DshHookCounter {
  readonly applied: number;
  readonly delegated: number;
}

/** Observable L3 advisor activity on this adapter (P5-a). */
export interface DshHostAdvisorStats {
  /** advisory decisions whose text was appended to a pre-step dispatch. */
  readonly advisory: number;
  /** gate decisions forwarded as `{ kind: 'ask' }` (never `deny`). */
  readonly ask: number;
  /** Evaluations that returned noop / could not be used. */
  readonly noop: number;
  /** Dispatches skipped because the advisor was off, busy or out of scope. */
  readonly skipped: number;
}

/** Wiring for {@link DshHookHostAdapter.attachHostAdvisor}. */
export interface DshHostAdvisorAttachOptions {
  /** Which hook consumes the advisor; defaults to the adapter's current mode. */
  readonly mode?: 'advisory' | 'gate';
  /** Branch/session scope; empty means host-local (every dispatch). */
  readonly scope?: Partial<HookMountScope>;
  /**
   * Runtime gate shared with `/evo jit off` (repair F1). When it returns false
   * the advisor is skipped entirely: no advice is injected and no tool call is
   * gated, but the attachment itself stays in place so `on` can restore it.
   */
  readonly isRuntimeEnabled?: () => boolean;
}

/** Observable adapter statistics used by diagnostics and tests. */
export interface DshHookAdapterStats {
  readonly assemble: DshHookCounter;
  readonly preExecute: DshHookCounter;
  readonly postExecute: DshHookCounter;
  readonly preStep: DshHookCounter;
  readonly deniedToolCalls: number;
  readonly installFailures: readonly string[];
}

/**
 * Real DSH hook adapter.
 *
 * Structural seams that are not hook-shaped (`forkBranch`, sandbox, memory view,
 * skill/script/subagent mounting, tool-description patching) are forwarded to
 * the `fallback` structured adapter, so a real host keeps both surfaces.
 */
export interface DshHookHostAdapter extends CordisHostAdapter {
  readonly hostKind: typeof DSH_HOOK_HOST_SOURCE;
  /** Hook-mounted surfaces are always available on this adapter. */
  registerPromptSegment(spec: HostPromptSegmentSpec): Promise<HostDisposer>;
  registerGuardrails(spec: HostGuardrailsSpec): Promise<HostDisposer>;
  mountMiddleware(spec: HostMiddlewareSpec): Promise<HostDisposer>;
  /** Hook events whose listener is currently registered on the host. */
  installedHookEvents(): DshHookEventName[];
  /**
   * Install the four hook listeners now (idempotent). Mounting a surface also
   * installs them; the plugin calls this at apply() time so a real host wires
   * interception at load. Disposing the adapter removes them again.
   */
  install(): void;
  /** True once dispose() ran; no further mount is accepted. */
  readonly isDisposed: boolean;
  /** Snapshot of active mounts in registration order. */
  activeMounts(): readonly DshHookMountSummary[];
  /** Snapshot of the counters. */
  stats(): DshHookAdapterStats;
  /** Human-readable notes collected while installing/enforcing. */
  advisories(): readonly string[];
  /**
   * P5-a: attach the L3 host advisor to the live hook listeners.
   *
   * advisory mode appends the rendered `<jitrl_advice>` block to the pre-step
   * decision's `additionalContexts`; gate mode forwards a `{ kind: 'ask' }`
   * decision from tools/pre-execute. The advisor can never deny: every other
   * decision (including a hypothetical 'deny' from a foreign advisor) falls
   * through to the host decision this adapter was handed.
   */
  attachHostAdvisor(advisor: HostAdvisor, options?: DshHostAdvisorAttachOptions): void;
  /** The currently attached advisor, when any. */
  readonly hostAdvisor?: HostAdvisor;
  /** L3 activity counters since construction. */
  hostAdvisorStats(): DshHostAdvisorStats;
  /**
   * L3 evidence: install the host-tool experience producer (repair H2).
   *
   * The post-execute listener forwards `{toolName, isError, exitCode,
   * errorClass}` for every observed tool result, and (when the host exposes it)
   * a `turn/end` listener forwards `reason.kind`. Passing undefined detaches the
   * sink. Recording is independent of the advisor switch: evidence exists even
   * while `hostAdvisor.enabled` is false, so switching it on later has data.
   */
  setHostToolExperienceSink(sink: HostToolExperienceSink | undefined): void;
  /** Tool results forwarded to the sink since construction. */
  hostToolObservationCount(): number;
  /** Uninstall every listener and clear every mount. Idempotent. */
  dispose(): Promise<void>;
}

/** Wiring for {@link createDshHookHostAdapter}. */
export interface DshHookHostAdapterOptions {
  /** Structured adapter used for the seams the hook surface does not own. */
  readonly fallback?: CordisHostAdapter;
  /** Host-supplied deterministic denials, evaluated before mount rules. */
  readonly denyTools?: readonly DshHookDenyRule[];
  /** Optional diagnostic sink (advisories stay available on the adapter too). */
  readonly onDiagnostic?: (message: string) => void;
  /** P5-a: L3 host advisor attached at construction (optional). */
  readonly hostAdvisor?: HostAdvisor;
  /** Which hook consumes the advisor; defaults to 'advisory'. */
  readonly hostAdvisorMode?: 'advisory' | 'gate';
  /** Branch/session scope of the advisor; empty means host-local. */
  readonly hostAdvisorScope?: Partial<HookMountScope>;
  /** Runtime gate shared with `/evo jit off`; absent means always enabled. */
  readonly hostAdvisorRuntimeEnabled?: () => boolean;
  /** Host-tool experience producer installed at construction (optional). */
  readonly hostToolExperience?: HostToolExperienceSink;
}

function compileDenyRules(
  spec: HostGuardrailsSpec
): { rules: readonly DshHookDenyRule[]; advisories: readonly string[] } {
  const rules: DshHookDenyRule[] = [];
  const advisories: string[] = [];
  for (const precondition of spec.toolPreconditions ?? []) {
    const rule = precondition.rule.trim();
    if (/^deny\b/i.test(rule)) {
      const reason = rule.replace(/^deny\b[:\s-]*/i, '').trim();
      rules.push({
        toolName: precondition.toolName,
        reason: reason.length > 0 ? reason : 'denied by guardrails precondition for ' + precondition.toolName
      });
    } else {
      advisories.push(
        'advisory precondition not enforced (needs generated middleware): ' +
          precondition.toolName +
          ' -> ' +
          rule
      );
    }
  }
  for (const action of spec.forbiddenActions ?? []) {
    const match = /^(?:tool|deny)\s*:\s*(.+)$/i.exec(action.trim());
    if (match !== null && match[1] !== undefined) {
      rules.push({ toolName: match[1].trim(), reason: 'forbidden action: ' + action });
    } else if (action.trim().length > 0) {
      advisories.push('advisory forbidden action not enforced (needs generated middleware): ' + action);
    }
  }
  for (const appendRule of spec.appendRules ?? []) {
    if (appendRule.trim().length > 0) {
      advisories.push('advisory guardrail rule not enforced (needs generated middleware): ' + appendRule);
    }
  }
  return { rules, advisories };
}

interface AssemblySection {
  readonly name: string;
  readonly text: string;
  readonly interpolate?: boolean;
  readonly [key: string]: unknown;
}

function readSections(value: unknown): AssemblySection[] | undefined {
  const record = asRecord(value);
  if (record === undefined || !Array.isArray(record['sections'])) {
    return undefined;
  }
  const sections: AssemblySection[] = [];
  for (const entry of record['sections'] as readonly unknown[]) {
    const section = asRecord(entry);
    if (section === undefined || typeof section['name'] !== 'string' || typeof section['text'] !== 'string') {
      return undefined;
    }
    sections.push(section as unknown as AssemblySection);
  }
  return sections;
}

function toolNameOf(exec: unknown): string | undefined {
  const record = asRecord(exec);
  const name = record === undefined ? undefined : record['name'];
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

/** Read a finite numeric exit code from either side of the dispatch. */
function exitCodeOf(exec: unknown, result: unknown): number | undefined {
  for (const candidate of [result, exec]) {
    const record = asRecord(candidate);
    if (record === undefined) {
      continue;
    }
    for (const key of ['exitCode', 'exit_code', 'code']) {
      const value = record[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
    }
  }
  return undefined;
}

/** Short error class only; raw host messages are never forwarded. */
function errorClassOf(result: unknown): string | undefined {
  const record = asRecord(result);
  if (record === undefined) {
    return undefined;
  }
  for (const key of ['errorClass', 'errorName', 'status']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/** True when the tool result reports a failure in any documented shape. */
function isToolError(result: unknown): boolean {
  const record = asRecord(result);
  if (record === undefined) {
    return false;
  }
  if (record['isError'] === true || record['is_error'] === true) {
    return true;
  }
  if (record['ok'] === false) {
    return true;
  }
  const status = record['status'];
  return typeof status === 'string' && /^(error|failed|failure)$/i.test(status);
}

/** Build one tool observation from the post-execute dispatch, when usable. */
function readToolObservation(exec: unknown, result: unknown): HostToolObservation | undefined {
  const toolName = toolNameOf(exec);
  if (toolName === undefined) {
    return undefined;
  }
  const scope = readHookScope(exec, result);
  const sessionId = [...scope.sessionIds][0];
  const branchId = [...scope.branchIds][0];
  const exitCode = exitCodeOf(exec, result);
  const errorClass = errorClassOf(result);
  return {
    toolName,
    isError: isToolError(result),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(errorClass === undefined ? {} : { errorClass }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(branchId === undefined ? {} : { branchId })
  };
}

/** Read `reason.kind` from a turn/end payload, tolerating nesting. */
function readTurnKind(payload: unknown): HostTurnKindObservation | undefined {
  const root = asRecord(payload);
  if (root === undefined) {
    return undefined;
  }
  const reason = asRecord(root['reason']);
  const turn = asRecord(root['turn']);
  const turnReason = turn === undefined ? undefined : asRecord(turn['reason']);
  const candidates: readonly unknown[] = [
    reason === undefined ? undefined : reason['kind'],
    turnReason === undefined ? undefined : turnReason['kind'],
    root['reasonKind'],
    root['kind']
  ];
  const kinds: readonly HostTurnKindObservation[] = [
    'completed',
    'error',
    'max_tokens',
    'aborted',
    'unknown'
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const known = kinds.find((kind) => kind === candidate);
      if (known !== undefined) {
        return known;
      }
    }
  }
  return undefined;
}

function assertHostRegistration(ctx: unknown): DshHookHostContext & {
  on: (event: string, listener: (...args: unknown[]) => unknown) => unknown;
} {
  const root = asRecord(ctx);
  if (root === undefined || typeof root['on'] !== 'function') {
    throw new CordisSeamError(
      'The DSH hook adapter requires a context exposing on(event, listener).',
      { code: 'invalid_request', details: { field: 'ctx.on' } }
    );
  }
  return root as unknown as DshHookHostContext & {
    on: (event: string, listener: (...args: unknown[]) => unknown) => unknown;
  };
}

/** Build the real-hook host adapter over a DSH context. */
export function createDshHookHostAdapter(
  ctx: unknown,
  options: DshHookHostAdapterOptions = {}
): DshHookHostAdapter {
  const host = assertHostRegistration(ctx);
  const fallback = options.fallback;
  const diagnostics: string[] = [];

  const mounts: HookMount[] = [];
  const installed = new Map<DshHookEventName, () => void>();
  const counters = {
    assemble: { applied: 0, delegated: 0 },
    preExecute: { applied: 0, delegated: 0 },
    postExecute: { applied: 0, delegated: 0 },
    preStep: { applied: 0, delegated: 0 }
  };
  let denied = 0;
  let disposed = false;

  // --- L3 host advisor (P5-a) ------------------------------------------------
  let advisor: HostAdvisor | undefined = options.hostAdvisor;
  let advisorMode: 'advisory' | 'gate' = options.hostAdvisorMode ?? 'advisory';
  const advisorCounters = { advisory: 0, ask: 0, noop: 0, skipped: 0 };
  let advisorScope: HookMountScope = normalizeAdvisorScope(options.hostAdvisorScope);
  let advisorRuntime: (() => boolean) | undefined = options.hostAdvisorRuntimeEnabled;

  // --- L3 host-tool experience producer (H2 repair) --------------------------
  let hostToolSink: HostToolExperienceSink | undefined = options.hostToolExperience;
  let turnEndDisposer: (() => void) | undefined;
  let hostToolObservations = 0;

  /** The advisor stays off while `/evo jit off` is in force (repair F1). */
  const advisorRuntimeEnabled = (): boolean => {
    if (advisorRuntime === undefined) {
      return true;
    }
    try {
      return advisorRuntime() !== false;
    } catch {
      // A broken switch must not disable a decision surface silently; fail open
      // here mirrors the L1 decorator's own runtime check semantics.
      return true;
    }
  };

  /** Turn-end listener: forwards reason.kind to the host-tool producer. */
  const onTurnEnd = async (payload: unknown, next: unknown): Promise<unknown> => {
    const advance =
      typeof next === 'function' ? (next as () => Promise<unknown>) : async (): Promise<unknown> => payload;
    const decision = await advance();
    const sink = hostToolSink;
    if (sink === undefined || disposed) {
      return decision;
    }
    const kind = readTurnKind(payload);
    if (kind === undefined) {
      return decision;
    }
    const scope = readHookScope(payload);
    const observation: HostTurnObservation = {
      kind,
      ...([...scope.sessionIds][0] === undefined
        ? {}
        : { sessionId: [...scope.sessionIds][0] as string }),
      ...([...scope.branchIds][0] === undefined
        ? {}
        : { branchId: [...scope.branchIds][0] as string })
    };
    try {
      await sink.observeTurnEnd(observation);
    } catch (error) {
      note(
        'turn/end observation failed: ' +
          (error instanceof Error ? error.name : 'unknown')
      );
    }
    return decision;
  };

  /** Register the optional turn/end listener (host support is probed). */
  const installTurnEnd = (): void => {
    if (disposed || hostToolSink === undefined || turnEndDisposer !== undefined) {
      return;
    }
    try {
      const result = host.on('turn/end', onTurnEnd);
      if (typeof result === 'function') {
        turnEndDisposer = () => (result as () => void)();
      } else {
        const record = asRecord(result);
        if (record !== undefined && typeof record['dispose'] === 'function') {
          const dispose = record['dispose'] as () => void;
          turnEndDisposer = () => dispose.call(result);
        } else if (typeof host.off === 'function') {
          turnEndDisposer = () => {
            host.off?.('turn/end', onTurnEnd);
          };
        } else {
          turnEndDisposer = () => undefined;
        }
      }
    } catch (error) {
      // Not every host dispatches turn/end; turn signals then stay at zero.
      turnEndDisposer = () => undefined;
      note(
        'turn/end is unavailable; turn rewards stay at zero (' +
          (error instanceof Error ? error.message : String(error)) +
          ')'
      );
    }
  };

  const uninstallTurnEnd = (): void => {
    if (turnEndDisposer === undefined) {
      return;
    }
    const dispose = turnEndDisposer;
    turnEndDisposer = undefined;
    try {
      dispose();
    } catch (error) {
      note(
        'failed to unregister turn/end: ' +
          (error instanceof Error ? error.message : String(error))
      );
    }
  };

  function normalizeAdvisorScope(
    scope: Partial<HookMountScope> | undefined
  ): HookMountScope {
    const read = (value: unknown): string =>
      typeof value === 'string' ? value.trim() : '';
    return {
      branchId: read(scope?.branchId),
      sessionId: read(scope?.sessionId),
      namespace: read(scope?.namespace)
    };
  }

  /** True when the advisor should evaluate this dispatch (fail-closed on scope). */
  const advisorInScope = (payloads: readonly unknown[]): boolean => {
    if (
      advisorScope.branchId === '' &&
      advisorScope.sessionId === '' &&
      advisorScope.namespace === ''
    ) {
      return true;
    }
    const identity = readHookScope(...payloads);
    const total =
      identity.branchIds.size + identity.sessionIds.size + identity.namespaces.size;
    // An explicitly scoped advisor never acts on an anonymous dispatch: without
    // an identity there is no way to prove the dispatch belongs to its branch.
    if (total === 0) {
      return false;
    }
    return hookScopeMatches(identity, advisorScope);
  };

  /** A deny/cancel decided below us is final; the advisor must not touch it. */
  const isBlockingDecision = (decision: unknown): boolean => {
    const record = asRecord(decision);
    return (
      record !== undefined &&
      (record['kind'] === 'deny' || record['kind'] === 'cancel')
    );
  };

  /**
   * Minimal L3 request. Thresholds are intentionally non-finite: the advisor
   * then falls back to config.jitrl.hostAdvisor, so the adapter never needs a
   * copy of the configuration.
   */
  const advisorRequest = (
    mode: 'advisory' | 'gate',
    toolName?: string
  ): HostAdvisorRequest => {
    const recentTools =
      toolName === undefined
        ? []
        : [
            {
              toolName,
              // Align with the action keys the host-tool producer writes, so the
              // gate focuses the call it was actually handed.
              actionKey: normalizeToolActionKey(toolName)
            }
          ];
    return {
      level: 'host_tool',
      state: abstractHostState({
        recentToolNames: recentTools.map((tool) => tool.toolName)
      }),
      recentTools,
      errors: [],
      mode,
      adviseThreshold: Number.NaN,
      gateThreshold: Number.NaN,
      minSupport: Number.NaN
    };
  };

  const note = (message: string): void => {
    diagnostics.push(message);
    options.onDiagnostic?.(message);
  };

  const isScopeMatch = (payloads: readonly unknown[]): boolean => {
    const identity = readHookScope(...payloads);
    return mounts.some((mount) => mount.active && hookScopeMatches(identity, mount));
  };

  const promptMountsInScope = (payloads: readonly unknown[]): PromptMount[] => {
    const identity = readHookScope(...payloads);
    return mounts
      .filter((mount): mount is PromptMount => mount.kind === 'prompt' && mount.active && hookScopeMatches(identity, mount))
      .sort((left, right) => left.priority - right.priority || left.segment.localeCompare(right.segment));
  };

  const denyRulesInScope = (payloads: readonly unknown[]): DshHookDenyRule[] => {
    const identity = readHookScope(...payloads);
    const rules: DshHookDenyRule[] = [...(options.denyTools ?? [])];
    for (const mount of mounts) {
      if (mount.kind !== 'guardrails' || !mount.active || !hookScopeMatches(identity, mount)) {
        continue;
      }
      rules.push(...mount.denyRules);
    }
    return rules;
  };

  const listeners: Record<DshHookEventName, (...args: unknown[]) => unknown> = {
    'system-prompt/assemble': async (assembly: unknown, context: unknown, next: unknown): Promise<unknown> => {
      const advance = typeof next === 'function' ? (next as () => Promise<unknown>) : async (): Promise<unknown> => assembly;
      const base = await advance();
      const scoped = promptMountsInScope([context, assembly]);
      if (scoped.length === 0) {
        counters.assemble.delegated += 1;
        return base;
      }
      const baseRecord = asRecord(base);
      const sections = readSections(base);
      if (baseRecord === undefined || sections === undefined) {
        counters.assemble.delegated += 1;
        note('system-prompt/assemble returned a shape without a sections array; prompt mount was not applied');
        return base;
      }
      const merged = sections.slice();
      let changed = false;
      for (const mount of scoped) {
        const existingIndex = merged.findIndex((section) => section.name === mount.segment);
        if (existingIndex >= 0 && mount.mode === 'replace') {
          merged[existingIndex] = { name: mount.segment, text: mount.content, interpolate: false };
          changed = true;
          continue;
        }
        if (existingIndex >= 0 && merged[existingIndex]?.text === mount.content) {
          continue;
        }
        // Append never clobbers another contribution that already owns the
        // name. It falls back to a deterministic per-mount section name, so a
        // repeated assembly finds the same section and stays idempotent.
        const name = existingIndex >= 0 ? mount.segment + ':' + mount.surfaceId : mount.segment;
        const target = merged.findIndex((section) => section.name === name);
        if (target >= 0) {
          if (merged[target]?.text !== mount.content) {
            merged[target] = { name, text: mount.content, interpolate: false };
            changed = true;
          }
          continue;
        }
        merged.push({ name, text: mount.content, interpolate: false });
        changed = true;
      }
      if (!changed) {
        counters.assemble.delegated += 1;
        return base;
      }
      counters.assemble.applied += 1;
      return { ...baseRecord, sections: merged };
    },
    'tools/pre-execute': async (exec: unknown, next: unknown): Promise<unknown> => {
      const advance = typeof next === 'function' ? (next as () => Promise<unknown>) : async (): Promise<unknown> => ({ kind: 'allow' });
      const decision = await advance();
      const current = asRecord(decision);
      if (current !== undefined && (current['kind'] === 'deny' || current['kind'] === 'cancel')) {
        counters.preExecute.delegated += 1;
        return decision;
      }
      const toolName = toolNameOf(exec);
      const rules = denyRulesInScope([exec]);
      const matched = rules.find((rule) => rule.toolName === '*' || rule.toolName === toolName);
      if (matched !== undefined) {
        counters.preExecute.applied += 1;
        denied += 1;
        return { kind: 'deny', reason: matched.reason };
      }
      // P5-a gate: the advisor may ask the user, never deny. The host decision
      // this adapter was handed stays authoritative for every other outcome.
      if (advisor !== undefined && !disposed && !advisorRuntimeEnabled()) {
        advisorCounters.skipped += 1;
      } else if (advisor !== undefined && !disposed && advisorMode === 'gate') {
        if (!advisorInScope([exec])) {
          advisorCounters.skipped += 1;
        } else if (toolName !== undefined) {
          try {
            const verdict = await advisor.evaluate(advisorRequest('gate', toolName));
            if (verdict.kind === 'ask') {
              advisorCounters.ask += 1;
              counters.preExecute.applied += 1;
              return {
                kind: 'ask',
                reason: verdict.reason,
                ...(verdict.suggestedActionKey === undefined
                  ? {}
                  : { suggestedActionKey: verdict.suggestedActionKey })
              };
            }
            advisorCounters.noop += 1;
          } catch {
            // A broken advisor must never break the host turn.
            advisorCounters.noop += 1;
          }
        } else {
          advisorCounters.skipped += 1;
        }
      }
      counters.preExecute.delegated += 1;
      return decision;
    },
    'tools/post-execute': async (exec: unknown, result: unknown, next: unknown): Promise<unknown> => {
      const advance =
        typeof next === 'function' ? (next as () => Promise<unknown>) : async (): Promise<unknown> => ({ kind: 'accept' });
      const decision = await advance();
      if (isScopeMatch([exec, result])) {
        counters.postExecute.applied += 1;
      } else {
        counters.postExecute.delegated += 1;
      }
      // H2 repair: forward the observed tool result to the host-tool experience
      // producer. Only {toolName, isError, exitCode, errorClass, ids} is read -
      // command text and tool arguments never leave the host.
      const sink = hostToolSink;
      if (sink !== undefined && !disposed) {
        const observation = readToolObservation(exec, result);
        if (observation !== undefined) {
          try {
            await sink.observeToolCall(observation);
            hostToolObservations += 1;
          } catch (error) {
            note(
              'host-tool observation failed: ' +
                (error instanceof Error ? error.name : 'unknown')
            );
          }
        }
      }
      return decision;
    },
    'agent/pre-step': async (payload: unknown, next: unknown): Promise<unknown> => {
      const advance =
        typeof next === 'function' ? (next as () => Promise<unknown>) : async (): Promise<unknown> => ({ kind: 'enter', messages: [] });
      const decision = await advance();
      if (isScopeMatch([payload])) {
        counters.preStep.applied += 1;
      } else {
        counters.preStep.delegated += 1;
      }
      // P5-a advisory: append the rendered advice to additionalContexts. The
      // messages and the step decision itself are never rewritten.
      if (advisor === undefined || disposed || isBlockingDecision(decision)) {
        return decision;
      }
      if (advisorMode !== 'advisory') {
        return decision;
      }
      if (!advisorRuntimeEnabled()) {
        advisorCounters.skipped += 1;
        return decision;
      }
      if (!advisorInScope([payload])) {
        advisorCounters.skipped += 1;
        return decision;
      }
      try {
        const verdict = await advisor.evaluate(advisorRequest('advisory'));
        const target = asRecord(decision);
        if (verdict.kind !== 'advisory' || target === undefined) {
          advisorCounters.noop += 1;
          return decision;
        }
        const existing = Array.isArray(target['additionalContexts'])
          ? (target['additionalContexts'] as readonly unknown[])
          : [];
        advisorCounters.advisory += 1;
        return { ...target, additionalContexts: [...existing, verdict.text] };
      } catch {
        advisorCounters.noop += 1;
        return decision;
      }
    }
  };

  const normalizeDisposer = (result: unknown, event: DshHookEventName): (() => void) => {
    if (typeof result === 'function') {
      return () => (result as () => void)();
    }
    const record = asRecord(result);
    if (record !== undefined && typeof record['dispose'] === 'function') {
      const dispose = record['dispose'] as () => void;
      return () => dispose.call(result);
    }
    if (typeof host.off === 'function') {
      return () => {
        host.off?.(event, listeners[event]);
      };
    }
    return () => undefined;
  };

  // Listeners are installed once for the adapter lifetime: they are transparent
  // pass-throughs while no mount exists, and eager installation is what lets
  // each seam report its real availability before a mount is attempted.
  const installAll = (): void => {
    if (disposed || installed.size > 0) {
      return;
    }
    for (const event of DSH_HOOK_EVENT_NAMES) {
      try {
        const result = host.on(event, listeners[event]);
        installed.set(event, normalizeDisposer(result, event));
      } catch (error) {
        note('failed to register hook "' + event + '": ' + (error instanceof Error ? error.message : String(error)));
      }
    }
    // Optional fifth surface (H2 repair): turn outcomes feed the host-tool
    // experience producer. Hosts without turn/end simply never deliver one.
    installTurnEnd();
  };

  const uninstallAll = (): void => {
    uninstallTurnEnd();
    if (installed.size === 0) {
      return;
    }
    const entries = [...installed.entries()];
    installed.clear();
    for (const [event, dispose] of entries) {
      try {
        dispose();
      } catch (error) {
        note('failed to unregister hook "' + event + '": ' + (error instanceof Error ? error.message : String(error)));
      }
    }
  };

  const release = (mount: HookMount): void => {
    if (!mount.active) {
      return;
    }
    mount.active = false;
    const index = mounts.indexOf(mount);
    if (index >= 0) {
      mounts.splice(index, 1);
    }
  };

  const register = (mount: HookMount): HostDisposer => {
    if (disposed) {
      throw new CordisSeamError('The DSH hook adapter has been disposed.', {
        code: 'manager_disposed'
      });
    }
    mounts.push(mount);
    return { dispose: (): void => release(mount) };
  };

  const missingSeam = (
    method: string,
    surface: HarnessComponentKey,
    spec: { branchId: string; surfaceId: string }
  ): never => {
    throw new CordisSeamError(
      'The DSH hook adapter could not install the hook required by surface "' + surface + '".',
      {
        code: 'seam_unavailable',
        surface,
        branchId: spec.branchId,
        details: { method, hookEvents: [...installed.keys()], advisories: diagnostics.slice() }
      }
    );
  };

  // Listeners are installed lazily on the first seam request and then stay for
  // the adapter lifetime: they are transparent pass-throughs while no mount
  // exists, and installing before the availability check is what lets each seam
  // report whether the host really accepted the event. Constructing the adapter
  // has no host side effect, so probing a context is free.
  const ensureInstalled = (): void => {
    installAll();
  };

  const adapter: DshHookHostAdapter = {
    hostKind: DSH_HOOK_HOST_SOURCE,
    get isDisposed(): boolean {
      return disposed;
    },
    installedHookEvents: (): DshHookEventName[] => [...installed.keys()],
    install: (): void => {
      if (!disposed) {
        installAll();
      }
    },
    activeMounts: (): readonly DshHookMountSummary[] =>
      mounts
        .filter((mount) => mount.active)
        .map((mount) => ({
          surfaceId: mount.surfaceId,
          kind: mount.kind,
          branchId: mount.branchId,
          sessionId: mount.sessionId,
          namespace: mount.namespace,
          active: mount.active
        })),
    stats: (): DshHookAdapterStats => ({
      assemble: { ...counters.assemble },
      preExecute: { ...counters.preExecute },
      postExecute: { ...counters.postExecute },
      preStep: { ...counters.preStep },
      deniedToolCalls: denied,
      installFailures: diagnostics.slice()
    }),
    advisories: (): readonly string[] => diagnostics.slice(),
    get hostAdvisor(): HostAdvisor | undefined {
      return advisor;
    },
    attachHostAdvisor(
      nextAdvisor: HostAdvisor,
      attachOptions: DshHostAdvisorAttachOptions = {}
    ): void {
      if (disposed) {
        return;
      }
      advisor = nextAdvisor;
      if (attachOptions.mode !== undefined) {
        advisorMode = attachOptions.mode;
      }
      if (attachOptions.scope !== undefined) {
        advisorScope = normalizeAdvisorScope(attachOptions.scope);
      }
      if (attachOptions.isRuntimeEnabled !== undefined) {
        advisorRuntime = attachOptions.isRuntimeEnabled;
      }
      note(
        'L3 host advisor attached (mode ' +
          advisorMode +
          (advisorScope.branchId === '' &&
          advisorScope.sessionId === '' &&
          advisorScope.namespace === ''
            ? ', host-local'
            : ', scoped to ' + (advisorScope.branchId || advisorScope.sessionId || advisorScope.namespace)) +
          ')'
      );
    },
    hostAdvisorStats: (): DshHostAdvisorStats => ({ ...advisorCounters }),
    setHostToolExperienceSink(sink: HostToolExperienceSink | undefined): void {
      if (disposed) {
        return;
      }
      hostToolSink = sink;
      if (sink === undefined) {
        uninstallTurnEnd();
        return;
      }
      installTurnEnd();
    },
    hostToolObservationCount: (): number => hostToolObservations,

    async registerPromptSegment(spec: HostPromptSegmentSpec): Promise<HostDisposer> {
      ensureInstalled();
      if (!installed.has('system-prompt/assemble')) {
        if (fallback?.registerPromptSegment !== undefined) {
          note('falling back to ctx.prompt.registerSegment: system-prompt/assemble is unavailable');
          return fallback.registerPromptSegment(spec);
        }
        return missingSeam('registerPromptSegment', 'system_prompt', spec);
      }
      return register({
        kind: 'prompt',
        surfaceId: spec.surfaceId,
        branchId: spec.branchId,
        sessionId: spec.sessionId,
        namespace: spec.namespace,
        active: true,
        segment: spec.segment,
        mode: spec.mode,
        content: spec.content,
        priority: spec.priority ?? 0
      });
    },

    async registerGuardrails(spec: HostGuardrailsSpec): Promise<HostDisposer> {
      ensureInstalled();
      if (!installed.has('tools/pre-execute')) {
        if (fallback?.registerGuardrails !== undefined) {
          note('falling back to ctx.permissions: tools/pre-execute is unavailable');
          return fallback.registerGuardrails(spec);
        }
        return missingSeam('registerGuardrails', 'guardrails', spec);
      }
      const compiled = compileDenyRules(spec);
      for (const advisory of compiled.advisories) {
        note(advisory);
      }
      return register({
        kind: 'guardrails',
        surfaceId: spec.surfaceId,
        branchId: spec.branchId,
        sessionId: spec.sessionId,
        namespace: spec.namespace,
        active: true,
        denyRules: compiled.rules,
        advisories: compiled.advisories
      });
    },

    async mountMiddleware(spec: HostMiddlewareSpec): Promise<HostDisposer> {
      ensureInstalled();
      if (!installed.has('tools/pre-execute') && !installed.has('tools/post-execute')) {
        if (fallback?.mountMiddleware !== undefined) {
          note('falling back to ctx.middleware: tool hooks are unavailable');
          return fallback.mountMiddleware(spec);
        }
        return missingSeam('mountMiddleware', 'plugins', spec);
      }
      return register({
        kind: 'middleware',
        surfaceId: spec.surfaceId,
        branchId: spec.branchId,
        sessionId: spec.sessionId,
        namespace: spec.namespace,
        active: true,
        bindings: spec.middleware.map((entry) => ({ name: entry.name, hook: entry.hook }))
      });
    },

    ...(fallback?.forkBranch === undefined
      ? {}
      : {
          forkBranch: (request: Parameters<NonNullable<CordisHostAdapter['forkBranch']>>[0]) =>
            fallback.forkBranch!(request)
        }),
    ...(fallback?.registerMemoryScope === undefined
      ? {}
      : {
          registerMemoryScope: (spec: Parameters<NonNullable<CordisHostAdapter['registerMemoryScope']>>[0]) =>
            fallback.registerMemoryScope!(spec)
        }),
    ...(fallback?.patchToolGuidance === undefined
      ? {}
      : {
          patchToolGuidance: (spec: Parameters<NonNullable<CordisHostAdapter['patchToolGuidance']>>[0]) =>
            fallback.patchToolGuidance!(spec)
        }),
    ...(fallback?.mountSkills === undefined
      ? {}
      : {
          mountSkills: (spec: Parameters<NonNullable<CordisHostAdapter['mountSkills']>>[0]) =>
            fallback.mountSkills!(spec)
        }),
    ...(fallback?.mountScripts === undefined
      ? {}
      : {
          mountScripts: (spec: Parameters<NonNullable<CordisHostAdapter['mountScripts']>>[0]) =>
            fallback.mountScripts!(spec)
        }),
    ...(fallback?.registerSubagents === undefined
      ? {}
      : {
          registerSubagents: (spec: Parameters<NonNullable<CordisHostAdapter['registerSubagents']>>[0]) =>
            fallback.registerSubagents!(spec)
        }),
    ...(fallback?.acquireSandbox === undefined
      ? {}
      : {
          acquireSandbox: (request: Parameters<NonNullable<CordisHostAdapter['acquireSandbox']>>[0]) =>
            fallback.acquireSandbox!(request)
        }),

    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      advisor = undefined;
      hostToolSink = undefined;
      uninstallTurnEnd();
      for (const mount of mounts.slice()) {
        mount.active = false;
      }
      mounts.length = 0;
      uninstallAll();
    }
  };

  return adapter;
}
