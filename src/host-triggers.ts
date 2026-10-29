/**
 * DSH event-trigger layer (session/event, agent/error, agent/status).
 *
 * WHY THIS MODULE EXISTS: the previous defaults ('task:failed', 'tool:error')
 * DO NOT EXIST in DSH. They were absent from every JavaScript file in the
 * shipped runtime, so the "auto_fallback" hook could never fire. This module
 * subscribes ONLY to events that exist in the verified DSH event catalog
 * (`dsh-tool-cordis/lib/types/api-catalog.js`) and to the session event types
 * declared in `dsh-session/lib/types/known-event-types.js`:
 *
 *  - `session/event` (this: Scoped<Session>, session: Session, event: SessionEvent)
 *      Post-commit append feed. Two verified failure shapes ride on it:
 *        * event.type === 'tool/result'  with event.data.message.isError === true
 *        * event.type === 'turn/end'     with event.data.reason.kind === 'error'
 *      and one success shape, used ONLY by triggerMode 'always':
 *        * event.type === 'turn/end'     with event.data.reason.kind === 'completed'
 *  - `agent/error` ({agent, turn, step, error}) — always a failure.
 *  - `agent/status` ({status}) — the loop emits only `{ status }`; the agent is
 *      fused into the payload by the agent dispatcher at runtime, so it is read
 *      OPTIONALLY and `ctx.agents.list()` is the fallback. Status is 'idle'
 *      or 'running' and nothing else.
 *
 * `agent.runMaintenance(job)` THROWS ("already has active work") unless the
 * agent is idle, so every call is wrapped in try/catch: losing that race is
 * normal operation, not an error.
 *
 * The three trigger modes are genuinely distinct:
 *   slash_command -> no listeners at all (/evo is the only entry point)
 *   auto_fallback -> failure events only (tool/result error, turn/end error,
 *                    agent/error) plus the optional idle dream
 *   always        -> failure events + turn/end 'completed'
 *
 * Containment rule: DSH runs `session/event` listeners as contained observers,
 * so a throw cannot fail the committed append — but it would still be logged as
 * a listener failure. Every handler here is therefore total: it never throws,
 * and an asynchronous callback failure is reported through `onDiagnostic`.
 */
import type {
  FailureSignal,
  HostAdvisorObservabilityCounters,
  TriggerMode
} from './types/contracts';
import { MODEL_ROUTE_EFFORTS } from './dsh-bridge/model-config';

/** The session append feed; the only failure carrier among session events. */
export const DSH_SESSION_EVENT = 'session/event';
/** A step or turn errored. */
export const DSH_AGENT_ERROR = 'agent/error';
/** Agent status changed ('idle' | 'running'). */
export const DSH_AGENT_STATUS = 'agent/status';

/**
 * Every event this plugin subscribes to by default. Each name is verified
 * present in the shipped DSH event catalog.
 */
export const DSH_TRIGGER_EVENTS = [
  DSH_SESSION_EVENT,
  DSH_AGENT_ERROR,
  DSH_AGENT_STATUS
] as const;

/**
 * The fabricated pre-fix event names, kept ONLY for explicit opt-in.
 *
 * They do not exist in DSH, so subscribing to them is a no-op that costs a
 * listener slot; never list them as a default.
 */
export const LEGACY_TRIGGER_EVENTS = ['task:failed', 'tool:error'] as const;

/** Verified session event types this module interprets. */
export const DSH_SESSION_EVENT_TYPES = ['tool/result', 'turn/end'] as const;

/** Verified turn-end reason kinds (TurnEndReasonMap in the DSH catalog). */
export const DSH_TURN_END_KINDS = [
  'completed',
  'aborted',
  'blocked',
  'error',
  'max-tokens',
  'interrupted',
  'forked'
] as const;

/** Which surface reported the failure. */
export type DshFailureSource = 'session/event' | 'agent/error';

/** Normalized failure families derived from the verified payload shapes. */
export type DshFailureKind = 'tool_error' | 'turn_error' | 'agent_error';

/** One normalized failure handed to the plugin for an auto_fallback run. */
export interface DshFailureEvent {
  readonly source: DshFailureSource;
  readonly kind: DshFailureKind;
  /** The DSH event name that produced this failure. */
  readonly dshEvent: string;
  /** Session id read from the `session` argument (Session.id / header.id). */
  readonly sessionId?: string;
  /** Agent id, when the payload exposed one. */
  readonly agentId?: string;
  /** One-line description used as the recovery task prompt. */
  readonly summary: string;
  /** Signals handed to the orchestrator's failure taxonomy. */
  readonly failureSignals: readonly FailureSignal[];
  /** Structured evidence for diagnostics; never contains fabricated fields. */
  readonly evidence: Readonly<Record<string, unknown>>;
}

/** A turn that ended successfully ('completed'), used by triggerMode 'always'. */
export interface DshCompletedTurnEvent {
  readonly dshEvent: typeof DSH_SESSION_EVENT;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly turn?: number;
  readonly reasonKind: 'completed';
  readonly evidence: Readonly<Record<string, unknown>>;
}

/** Result of reading one session event. */
export interface SessionEventClassification {
  readonly failure?: DshFailureEvent;
  readonly completed?: DshCompletedTurnEvent;
  /** Why the event was ignored; recorded for diagnostics only. */
  readonly ignored?: string;
}

/**
 * t5 → t7 status-mapping contract (ADR 0005 section 3.7): the entrypoint's L3
 * `hostAdvisor` status block is the fixed config shape plus the adapter-side
 * observability counters, with the "NOT COLLECTED ≠ ZERO" rule baked in.
 *
 * Mapping rule for t7 (`src/index.ts`, second writer):
 *   - When the adapter exposes `hostAdvisorStats()` (the real hook adapter),
 *     its snapshot is filtered through {@link HOST_ADVISOR_COUNTER_KEYS}: every
 *     one of the seven PUBLIC counters that was measured is forwarded verbatim
 *     (0 = a measured zero) and every other adapter field is dropped.
 *   - When it does NOT, the counter fields must stay ABSENT — never defaulted
 *     to 0 (F-15). `HostAdvisorObservabilityCounters`' optional fields plus
 *     JSON serialization drop absent keys automatically, which is exactly the
 *     desired wire shape.
 *
 * The fixed fields here are the ones the entrypoint already owns; only the
 * counters follow the collect-or-omit rule. The whitelist is deliberate
 * (R-01/t13 O2): the public status shape is owned by THIS module, not by
 * whatever the adapter happens to return. A structural adapter that leaks an
 * extra field (a tool name, a payload echo, a future private counter) must not
 * reach the public status through `{...stats}`.
 */

/**
 * The seven PUBLIC observability counters (ADR 0005 §3.7), in the order the
 * status contract documents them.
 *
 * Single source of truth for the mapping whitelist AND for the compile-time
 * exhaustiveness witness below: adding a counter to
 * `HostAdvisorObservabilityCounters` without registering it here (or removing
 * one here while the contract still declares it) fails `tsc --noEmit`.
 */
export const HOST_ADVISOR_COUNTER_KEYS = [
  'advisory',
  'ask',
  'noop',
  'skipped',
  'scopeUnknownSkipped',
  'considered',
  'excludedByDeclaration'
] as const;

/** Both directions of the counter surface, plus the exact count. */
type PublicCounterKey = keyof HostAdvisorObservabilityCounters;
type MissingCounterKey = Exclude<PublicCounterKey, (typeof HOST_ADVISOR_COUNTER_KEYS)[number]>;
type ForeignCounterKey = Exclude<(typeof HOST_ADVISOR_COUNTER_KEYS)[number], PublicCounterKey>;
/** Fails `tsc` when a declared public counter is not in the whitelist. */
const _COUNTER_KEYS_EXHAUSTIVE: [MissingCounterKey] extends [never] ? true : never = true;
/** Fails `tsc` when the whitelist names a key the public contract does not. */
const _COUNTER_KEYS_FOREIGN: [ForeignCounterKey] extends [never] ? true : never = true;
/** Fails `tsc` when the whitelist is not exactly the documented seven. */
const _COUNTER_KEYS_COUNT: (typeof HOST_ADVISOR_COUNTER_KEYS)['length'] extends 7 ? true : never = true;
void _COUNTER_KEYS_EXHAUSTIVE;
void _COUNTER_KEYS_FOREIGN;
void _COUNTER_KEYS_COUNT;

/**
 * Mutable view of the counter contract, used only to BUILD the whitelisted
 * counters object; the public type stays readonly.
 */
type MutableCounters = {
  -readonly [Key in keyof HostAdvisorObservabilityCounters]: HostAdvisorObservabilityCounters[Key];
};
export interface DshHostAdvisorStatusMapping {
  readonly enabled: boolean;
  readonly mode: 'advisory' | 'gate';
  readonly attached: boolean;
  readonly runtimeEnabled: boolean;
  readonly diagnostics: readonly string[];
  readonly counters: HostAdvisorObservabilityCounters;
}

/**
 * Pure t5-provided helper for the t7 wiring: merge the fixed status fields with
 * an adapter stats source that may be absent.
 *
 * - `stats` present  -> the seven PUBLIC counters are copied, key by key, and
 *   every other adapter field is dropped (the status shape belongs to this
 *   module, not to the adapter). A measured `0` is copied as `0`.
 * - `stats` absent   -> counters stay ABSENT (an empty object, so JSON drops
 *   every counter key instead of reporting fabricated zeros).
 * - a present-but-non-numeric / non-finite counter value is NOT a measurement:
 *   it is omitted exactly like an absent one, never coerced to `0` (F-15).
 *
 * No payload ever flows through this function: counters only.
 */
export function mapHostAdvisorStatus(
  fixed: {
    readonly enabled: boolean;
    readonly mode: 'advisory' | 'gate';
    readonly attached: boolean;
    readonly runtimeEnabled: boolean;
    readonly diagnostics: readonly string[];
  },
  stats?: HostAdvisorObservabilityCounters
): DshHostAdvisorStatusMapping {
  return {
    ...fixed,
    counters: pickHostAdvisorCounters(stats)
  };
}

/**
 * Copy ONLY the seven public counters out of an adapter snapshot.
 *
 * R-01 (t13 O2): the previous `{...stats}` forwarded whatever the adapter
 * returned, so an extra field could reach the public status. The whitelist keeps
 * the public surface authoritative here AND preserves the two invariants that
 * make the counters trustworthy:
 *   - "measured zero stays zero": `0` is a number and is copied verbatim;
 *   - "not collected is absent": a missing or non-numeric value is dropped, so
 *     no fabricated `0` can ever appear.
 */
function pickHostAdvisorCounters(
  stats?: HostAdvisorObservabilityCounters
): HostAdvisorObservabilityCounters {
  const counters: MutableCounters = {};
  if (stats === undefined) {
    return counters;
  }
  for (const key of HOST_ADVISOR_COUNTER_KEYS) {
    const value = stats[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      counters[key] = value;
    }
  }
  return counters;
}

/** Idle-dream wiring. Both halves are optional and independently gated. */
export interface DshDreamOptions {
  /** True when offline replay has at least one retained tree. */
  readonly hasMaterial: () => boolean;
  /** The replay work itself; runs inside agent.runMaintenance when possible. */
  readonly run: () => Promise<unknown> | unknown;
  /** Our own throttle, in milliseconds; defaults to 5 minutes. */
  readonly cooldownMs?: number;
  /** Clock injection for deterministic tests. */
  readonly now?: () => number;
  readonly onDiagnostic?: (message: string) => void;
}

/** Callbacks the plugin supplies to the trigger layer. */
export interface DshTriggerCallbacks {
  /** A verified failure was observed; start an auto_fallback run. */
  readonly onFailure: (failure: DshFailureEvent) => unknown;
  /** A turn completed; only called under triggerMode 'always'. */
  readonly onTurnCompleted?: (turn: DshCompletedTurnEvent) => unknown;
  /** Offline replay on agent idle; only called when the gates open. */
  readonly dream?: DshDreamOptions;
  /** Fallback agent source for `agent/status` (ctx.agents.list). */
  readonly agents?: () => readonly unknown[];
}

/** Options for registerDshTriggers. */
export interface RegisterDshTriggersOptions extends DshTriggerCallbacks {
  readonly triggerMode: TriggerMode;
  /**
   * Explicit opt-in to the fabricated legacy names. Off by default and never
   * combined with the verified defaults unless the caller asks for it.
   */
  readonly legacyEvents?: readonly string[];
  /** Diagnostic sink; never throws. */
  readonly onDiagnostic?: (message: string) => void;
}

/** What a registration attempt produced. */
export interface DshTriggerRegistration {
  /** Event names actually subscribed, in registration order. */
  readonly events: readonly string[];
  /** Disposers for every listener (host disposer or a local fallback). */
  readonly disposers: readonly (() => unknown)[];
  readonly diagnostics: readonly string[];
}

const DEFAULT_DREAM_COOLDOWN_MS = 5 * 60_000;
const MAX_SUMMARY_LENGTH = 400;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/** Read one property through a proxy without letting it throw. */
export function safeRead(source: unknown, key: string): unknown {
  if (source === null || typeof source !== 'object') {
    return undefined;
  }
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function readString(source: unknown, key: string): string | undefined {
  const value = safeRead(source, key);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(source: unknown, key: string): number | undefined {
  const value = safeRead(source, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function describeThrown(value: unknown): string {
  if (value instanceof Error) {
    return value.name + ': ' + value.message;
  }
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  const record = asRecord(value);
  if (record !== undefined) {
    const message = readString(record, 'message');
    const code = readString(record, 'code');
    if (message !== undefined) {
      return code === undefined ? message : message + ' (' + code + ')';
    }
  }
  try {
    return String(value);
  } catch {
    return '<unrenderable value>';
  }
}

/** Truncate a summary so one huge tool payload cannot blow up a task prompt. */
function clampSummary(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0) {
    return 'unspecified host failure';
  }
  return trimmed.length <= MAX_SUMMARY_LENGTH
    ? trimmed
    : trimmed.slice(0, MAX_SUMMARY_LENGTH) + '…';
}

/** Read the session id from a Session-like object (id or header.id). */
export function readSessionId(session: unknown): string | undefined {
  const direct = readString(session, 'id');
  if (direct !== undefined) {
    return direct;
  }
  return readString(safeRead(session, 'header'), 'id');
}

/** Collect the text of a DSH content-block array (TextBlock[]). */
function contentText(message: unknown): string | undefined {
  const content = safeRead(message, 'content');
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const block of content) {
    const text = readString(block, 'text');
    if (text !== undefined) {
      parts.push(text);
    }
  }
  return parts.length === 0 ? undefined : parts.join(' ');
}

/** True when a value looks like a DSH SessionEvent envelope. */
function looksLikeEvent(value: unknown): boolean {
  return typeof readString(value, 'type') === 'string';
}

/**
 * Normalize the `session/event` arguments.
 *
 * DSH dispatches `(session, event)`; the plugin's structural test/legacy path
 * may hand over a single `{type,data}` payload. Both are accepted, and the
 * session is only used for its id, so a payload-only call never invents one.
 */
export function readSessionEventArgs(
  first: unknown,
  second: unknown
): { session?: unknown; event?: { type: string; data?: unknown } } | undefined {
  if (looksLikeEvent(second)) {
    return { session: first, event: second as { type: string; data?: unknown } };
  }
  if (looksLikeEvent(first)) {
    return { event: first as { type: string; data?: unknown } };
  }
  return undefined;
}

/**
 * Classify one `session/event` append.
 *
 * Only verified shapes are interpreted; everything else is ignored with a
 * reason instead of being guessed at.
 */
export function classifySessionEvent(
  session: unknown,
  event: unknown
): SessionEventClassification {
  const type = readString(event, 'type');
  if (type === undefined) {
    return { ignored: 'the session event carries no string type' };
  }
  const data = safeRead(event, 'data');
  const sessionId = readSessionId(session);
  const turn = readNumber(data, 'turn');
  const step = readNumber(data, 'step');

  if (type === 'tool/result') {
    const message = safeRead(data, 'message');
    const isError = safeRead(message, 'isError') === true;
    if (!isError) {
      return { ignored: 'tool/result without message.isError' };
    }
    const error = asRecord(safeRead(data, 'error'));
    const errorCode = error === undefined ? undefined : readString(error, 'code');
    const errorReason = error === undefined ? undefined : readString(error, 'reason');
    const errorName = error === undefined ? undefined : readString(error, 'name');
    const text = contentText(message);
    const detail =
      errorReason ??
      errorName ??
      text ??
      (errorCode === undefined ? 'tool returned an error result' : 'tool failed with code ' + errorCode);
    const signals: FailureSignal[] = [
      {
        kind: 'tool_error',
        message: clampSummary(detail),
        ...(errorCode === undefined ? {} : { code: errorCode }),
        ...(step === undefined ? {} : { stepIndex: step })
      }
    ];
    return {
      failure: {
        source: 'session/event',
        kind: 'tool_error',
        dshEvent: 'session/event',
        ...(sessionId === undefined ? {} : { sessionId }),
        summary: clampSummary('tool call failed: ' + detail),
        failureSignals: signals,
        evidence: {
          eventType: type,
          ...(turn === undefined ? {} : { turn }),
          ...(step === undefined ? {} : { step }),
          ...(errorCode === undefined ? {} : { errorCode }),
          ...(errorName === undefined ? {} : { errorName })
        }
      }
    };
  }

  if (type === 'turn/end') {
    const reason = safeRead(data, 'reason');
    const kind = readString(reason, 'kind');
    if (kind === 'error') {
      const failure = asRecord(safeRead(reason, 'error'));
      const message = failure === undefined ? undefined : readString(failure, 'message');
      const code = failure === undefined ? undefined : readString(failure, 'code');
      const detail = message ?? 'the turn ended with an error';
      const signals: FailureSignal[] = [
        {
          kind: 'unknown',
          message: clampSummary(detail),
          ...(code === undefined ? {} : { code })
        }
      ];
      return {
        failure: {
          source: 'session/event',
          kind: 'turn_error',
          dshEvent: 'session/event',
          ...(sessionId === undefined ? {} : { sessionId }),
          summary: clampSummary('turn ended with an error: ' + detail),
          failureSignals: signals,
          evidence: {
            eventType: type,
            reasonKind: kind,
            ...(turn === undefined ? {} : { turn }),
            ...(code === undefined ? {} : { errorCode: code })
          }
        }
      };
    }
    if (kind === 'completed') {
      return {
        completed: {
          dshEvent: 'session/event',
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(turn === undefined ? {} : { turn }),
          reasonKind: 'completed',
          evidence: { eventType: type, reasonKind: kind, ...(turn === undefined ? {} : { turn }) }
        }
      };
    }
    return {
      ignored:
        'turn/end reason.kind=' + String(kind ?? '<none>') + ' is not a verified trigger'
    };
  }

  return { ignored: 'session event type "' + type + '" is not a trigger' };
}

/** Classify one `agent/error` payload ({turn, step, error}). */
export function classifyAgentError(payload: unknown): DshFailureEvent {
  const record = asRecord(payload);
  const error = safeRead(record, 'error');
  const detail = describeThrown(error);
  const turn = readNumber(record, 'turn');
  const step = readNumber(record, 'step');
  const agent = safeRead(record, 'agent');
  const agentId = readString(agent, 'id');
  const sessionId = readSessionId(safeRead(agent, 'session'));
  const code = readString(asRecord(error), 'code');
  const signals: FailureSignal[] = [
    {
      kind: 'unknown',
      message: clampSummary(detail),
      ...(code === undefined ? {} : { code }),
      ...(step === undefined ? {} : { stepIndex: step })
    }
  ];
  return {
    source: 'agent/error',
    kind: 'agent_error',
    dshEvent: DSH_AGENT_ERROR,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(agentId === undefined ? {} : { agentId }),
    summary: clampSummary('agent error: ' + detail),
    failureSignals: signals,
    evidence: {
      eventType: DSH_AGENT_ERROR,
      ...(turn === undefined ? {} : { turn }),
      ...(step === undefined ? {} : { step })
    }
  };
}

/** Read the verified agent status payload: 'idle' | 'running' | undefined. */
export function readAgentStatus(payload: unknown): 'idle' | 'running' | undefined {
  const status = readString(payload, 'status');
  return status === 'idle' || status === 'running' ? status : undefined;
}

/**
 * Resolve the agent a status payload refers to.
 *
 * The loop emits `{ status }` only; the agent dispatcher fuses `agent` into
 * the payload. `ctx.agents.list()` is the documented fallback.
 */
function resolveAgent(
  payload: unknown,
  agents: (() => readonly unknown[]) | undefined
): unknown {
  const direct = safeRead(payload, 'agent');
  if (direct !== undefined) {
    return direct;
  }
  if (typeof safeRead(payload, 'runMaintenance') === 'function') {
    return payload;
  }
  if (agents === undefined) {
    return undefined;
  }
  let live: readonly unknown[];
  try {
    live = agents();
  } catch {
    return undefined;
  }
  for (const candidate of live) {
    if (typeof safeRead(candidate, 'runMaintenance') === 'function') {
      return candidate;
    }
  }
  return undefined;
}

function pickFunction(
  source: unknown,
  key: string
): ((...args: unknown[]) => unknown) | undefined {
  const candidate = safeRead(source, key);
  return typeof candidate === 'function'
    ? (candidate as (...args: unknown[]) => unknown)
    : undefined;
}

function normalizeDisposer(result: unknown): () => unknown {
  if (typeof result === 'function') {
    return () => (result as () => unknown)();
  }
  const record = asRecord(result);
  const dispose = record === undefined ? undefined : safeRead(record, 'dispose');
  if (typeof dispose === 'function') {
    return () => (dispose as () => unknown).call(result);
  }
  return () => undefined;
}

/** Ignore a returned promise while still containing its rejection. */
function contain(outcome: unknown, onDiagnostic: (message: string) => void, what: string): void {
  if (outcome === null || typeof outcome !== 'object') {
    return;
  }
  if (typeof (outcome as { then?: unknown }).then !== 'function') {
    return;
  }
  void Promise.resolve(outcome).catch((error: unknown) => {
    onDiagnostic(what + ' failed: ' + describeThrown(error));
  });
}

/**
 * Subscribe the plugin's trigger list on a host context.
 *
 * Every listener is registered through `ctx.on(name, handler)`, whose return
 * value is the fiber-owned disposer; the caller collects them so teardown is
 * explicit even on hosts whose `ctx.effect` wiring differs.
 */
export function registerDshTriggers(
  ctx: unknown,
  options: RegisterDshTriggersOptions
): DshTriggerRegistration {
  const diagnostics: string[] = [];
  const events: string[] = [];
  const disposers: (() => unknown)[] = [];
  const report = (message: string): void => {
    diagnostics.push(message);
    options.onDiagnostic?.(message);
  };

  if (options.triggerMode === 'slash_command') {
    report(
      'triggerMode=slash_command: no DSH listeners were registered; /evo is the only entry point'
    );
    return { events, disposers, diagnostics };
  }

  if (options.legacyEvents !== undefined && options.legacyEvents.length > 0) {
    report(
      'subscribing to explicitly configured event names: ' + options.legacyEvents.join(', ')
    );
  }

  const on = pickFunction(ctx, 'on');
  if (on === undefined) {
    report(
      'the host context exposes no event subscriber; call the plugin handle directly for '
        + options.triggerMode
        + ' triggers'
    );
    return { events, disposers, diagnostics };
  }

  const subscribe = (name: string, handler: (...args: unknown[]) => void): void => {
    try {
      const result = on.call(ctx, name, handler);
      disposers.push(normalizeDisposer(result));
      events.push(name);
    } catch (error) {
      report('failed to subscribe to "' + name + '": ' + describeThrown(error));
    }
  };

  // ---- session/event: failures (+ completed turns under 'always') --------
  const dream = options.dream;
  let dreamInFlight = false;
  let lastDreamAt = Number.NEGATIVE_INFINITY;
  const dreamNow = dream?.now ?? ((): number => Date.now());
  const dreamCooldown = dream?.cooldownMs ?? DEFAULT_DREAM_COOLDOWN_MS;

  const runIdleDream = (payload: unknown): void => {
    if (dream === undefined) {
      return;
    }
    if (dreamInFlight) {
      return;
    }
    let hasMaterial = false;
    try {
      hasMaterial = dream.hasMaterial();
    } catch (error) {
      report('idle dream gate failed: ' + describeThrown(error));
      return;
    }
    if (!hasMaterial) {
      // Nothing to replay yet: stay silent instead of dreaming over zero trees.
      return;
    }
    const at = dreamNow();
    if (at - lastDreamAt < dreamCooldown) {
      return;
    }
    const agent = resolveAgent(payload, options.agents);
    const maintenance =
      agent === undefined ? undefined : pickFunction(agent, 'runMaintenance');
    const job = async (): Promise<void> => {
      dreamInFlight = true;
      try {
        await dream.run();
        lastDreamAt = dreamNow();
      } catch (error) {
        dream.onDiagnostic?.('idle dream failed: ' + describeThrown(error));
      } finally {
        dreamInFlight = false;
      }
    };
    if (maintenance === undefined) {
      // No live agent: still contained, just unserialized against turns.
      contain(job(), report, 'idle dream');
      return;
    }
    try {
      // THROWS unless the agent is idle ("already has active work"); racing a
      // turn is normal, so a throw is recorded and the next idle retries.
      contain(maintenance.call(agent, job), report, 'idle dream maintenance');
    } catch (error) {
      report('idle dream skipped: ' + describeThrown(error));
    }
  };

  const handleSessionEvent = (first: unknown, second: unknown): void => {
    try {
      const args = readSessionEventArgs(first, second);
      if (args === undefined) {
        return;
      }
      const classified = classifySessionEvent(args.session, args.event);
      if (classified.failure !== undefined) {
        contain(options.onFailure(classified.failure), report, 'auto_fallback run');
        return;
      }
      if (classified.completed !== undefined) {
        if (options.triggerMode !== 'always') {
          return;
        }
        const completed = options.onTurnCompleted;
        if (completed === undefined) {
          report('triggerMode=always: no completed-turn callback was supplied');
          return;
        }
        contain(completed(classified.completed), report, 'always trigger run');
      }
    } catch (error) {
      report('session/event handler failed: ' + describeThrown(error));
    }
  };

  // ---- agent/error: always a failure ------------------------------------
  const handleAgentError = (payload: unknown): void => {
    try {
      contain(options.onFailure(classifyAgentError(payload)), report, 'auto_fallback run');
    } catch (error) {
      report('agent/error handler failed: ' + describeThrown(error));
    }
  };

  // ---- agent/status: idle -> optional offline replay ---------------------
  const handleAgentStatus = (payload: unknown): void => {
    try {
      if (readAgentStatus(payload) !== 'idle') {
        return;
      }
      runIdleDream(payload);
    } catch (error) {
      report('agent/status handler failed: ' + describeThrown(error));
    }
  };

  subscribe(DSH_SESSION_EVENT, handleSessionEvent);
  subscribe(DSH_AGENT_ERROR, handleAgentError);
  subscribe(DSH_AGENT_STATUS, handleAgentStatus);

  for (const legacy of options.legacyEvents ?? []) {
    if ((DSH_TRIGGER_EVENTS as readonly string[]).includes(legacy)) {
      continue;
    }
    subscribe(legacy, (payload: unknown) => {
      try {
        contain(options.onFailure(classifyLegacyPayload(legacy, payload)), report, 'legacy trigger run');
      } catch (error) {
        report('legacy handler for "' + legacy + '" failed: ' + describeThrown(error));
      }
    });
  }

  if (events.length > 0) {
    report(
      'triggerMode=' + options.triggerMode + ': subscribed to ' + events.join(', ')
    );
  }
  return { events, disposers, diagnostics };
}

/**
 * Normalize a payload delivered to an explicitly opted-in legacy event name.
 *
 * The shape cannot be verified (the event does not exist in DSH), so this is a
 * permissive best-effort mapping used only when a caller names the event.
 */
export function classifyLegacyPayload(event: string, payload: unknown): DshFailureEvent {
  const record = asRecord(payload);
  const failureSignals = safeRead(record, 'failureSignals');
  const signals: FailureSignal[] =
    Array.isArray(failureSignals) && failureSignals.length > 0
      ? (failureSignals as FailureSignal[])
      : [{ kind: 'unknown', message: clampSummary(event + ' observed') }];
  const message = readString(record, 'message');
  const sessionId = readString(record, 'sessionId');
  return {
    source: 'session/event',
    kind: event === 'tool:error' ? 'tool_error' : 'agent_error',
    dshEvent: event,
    ...(sessionId === undefined ? {} : { sessionId }),
    summary: clampSummary(message ?? event + ' was reported by the host'),
    failureSignals: signals,
    evidence: { eventType: event, legacyEvent: true }
  };
}

/**
 * Unwrap schemastery volatile references from a validated config value.
 *
 * A volatile field validates into a reference exposing `get()`, so the value
 * Cordis hands to `apply` is not the plain object the caller wrote. This also
 * doubles as the plugin's `Config.simplify` implementation: DSH's loader calls
 * `Config.simplify(validated)` before persisting an entry, and the default
 * schemastery simplify DROPS keys the schema does not declare — which would
 * erase `triggerMode`, `enabledSurfaces`, `memoryBridge`, `dreamRsi` and
 * `logging` from cordis.patch.yml the first time the settings page saves the
 * model route. Preserving them is what keeps the rest of the config intact.
 */
export function unwrapConfigValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => unwrapConfigValues(item));
  }
  const record = asRecord(value);
  if (record === undefined) {
    return value;
  }
  const getter = safeRead(record, 'get');
  if (typeof getter === 'function') {
    try {
      return (getter as () => unknown).call(record);
    } catch {
      return undefined;
    }
  }
  const plain: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    plain[key] = unwrapConfigValues(record[key]);
  }
  return plain;
}

/**
 * Split the host-only `modelRoute` group out of a raw plugin config section.
 *
 * `modelRoute` belongs to the second-level settings page (provider / model /
 * reasoningEffort); the frozen schema in src/config.ts rejects unknown keys, so
 * the group is removed before that validation runs and is passed to the model
 * adapter instead.
 */

/**
 * Named rejection of an out-of-enum `modelRoute.reasoningEffort` (ADR 0005
 * section 3.6 / F-16).
 *
 * A silent fallback to the default effort would be a silent config drop: the
 * host wrote a route this plugin would never actually call. The error is
 * payload-safe by construction — it names the offending value (one short
 * config string the integrator typed themselves) and the allowed enum, and
 * nothing else.
 */
export class ModelRouteEffortError extends Error {
  /** Stable machine-readable code; tests and hosts match on this. */
  readonly code = 'model-route-effort-invalid' as const;
  /** The rejected reasoningEffort value. */
  readonly value: string;
  /** The allowed efforts, from the dsh-bridge single source. */
  readonly allowed: readonly string[];

  constructor(value: string, allowed: readonly string[]) {
    super(
      'model-route-effort-invalid: modelRoute.reasoningEffort="' +
        value +
        '" is not one of the supported efforts [' +
        allowed.join(', ') +
        ']; the route would never be called with this effort, so the plugin refuses to mount instead of silently falling back to the default'
    );
    this.name = 'ModelRouteEffortError';
    this.value = value;
    this.allowed = [...allowed];
  }
}

/**
 * Runtime single-source check for one `modelRoute.reasoningEffort` value.
 *
 * Consumes ONLY the existing `MODEL_ROUTE_EFFORTS` enum (no second copy of the
 * vocabulary). A value that is PRESENT but out of enum throws
 * {@link ModelRouteEffortError} instead of silently falling back to the default
 * (a silent fallback is a silent config drop). Absent-like values —
 * `undefined`, `null` and the empty string — fall through so
 * `resolveModelRouteConfig` keeps its documented per-field default behavior:
 * an ABSENT field is a default, a PRESENT-but-invalid field is a config error.
 */
export function assertModelRouteEffort(value: unknown): void {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value === 'string') {
    if (value.length === 0) {
      return;
    }
    if (!(MODEL_ROUTE_EFFORTS as readonly string[]).includes(value)) {
      throw new ModelRouteEffortError(value, MODEL_ROUTE_EFFORTS);
    }
    return;
  }
  // Present but not a string (number/boolean/object): never a valid effort.
  // String() only; the raw value is never JSON-rendered into the message.
  throw new ModelRouteEffortError(
    typeof value === 'object' ? '[object]' : String(value),
    MODEL_ROUTE_EFFORTS
  );
}

export function splitModelRoute(section: unknown): {
  readonly config: Record<string, unknown> | undefined;
  readonly modelRoute: Record<string, unknown> | undefined;
} {
  const plain = unwrapConfigValues(section);
  const record = asRecord(plain);
  if (record === undefined) {
    return { config: record, modelRoute: undefined };
  }
  const rest: Record<string, unknown> = {};
  let modelRoute: Record<string, unknown> | undefined;
  for (const key of Object.keys(record)) {
    if (key === 'modelRoute') {
      modelRoute = asRecord(record[key]);
      continue;
    }
    rest[key] = record[key];
  }
  if (modelRoute !== undefined && Object.prototype.hasOwnProperty.call(modelRoute, 'reasoningEffort')) {
    assertModelRouteEffort(modelRoute['reasoningEffort']);
  }
  return { config: rest, modelRoute };
}
