/**
 * L3 host-tool experience producer (plan sections 3.3 and 6.5; repair H2).
 *
 * The L3 advisor retrieves `level: 'host_tool'` neighbours, but before this
 * module existed nothing in the plugin ever wrote such a record: the DSH hook
 * adapter only counted `tools/post-execute` dispatches, so the default
 * `kernel.createHostAdvisor()` always degraded to `noop('no_neighbors')`.
 *
 * This module turns the two host observations that already reach the adapter
 * into experience:
 *
 *   - `tools/post-execute` gives the tool name, `isError` and (when readable) an
 *     exit code. The fused reward uses plan section 6.5's tool signals:
 *     error -2, success +0.5, and an extra -3 when the same error repeats;
 *   - `turn/end` gives the turn `reason.kind`: completed +1, error -2,
 *     max-tokens -1, aborted 0. The turn signal is credited to the last observed
 *     tool action, because the turn outcome is the outcome of that action.
 *
 * The fused step reward is `clip(sum(w * signal), clip[0], clip[1])` using the
 * configured reward weights/clip; `return` equals the step reward (a host tool
 * call has no discount horizon of its own).
 *
 * Privacy (plan section 7.2 and `jitrl.privacy`): only an abstract state, a
 * normalized action key and statistics are persisted. The adapter never forwards
 * command text or tool arguments to this module, `storeRawText` cannot add raw
 * text because there is no text to store, and every string that does leave the
 * collector (tool name, error class) is passed through `redactSecrets`.
 *
 * The collector never throws: append failures become payload-free diagnostics so
 * a broken store can never break the host turn.
 */
import type { EvoHarnessConfig } from '../config';
import type { AbstractState, ExperienceRecord, IExperienceStore } from '../types/contracts';
import { normalizeToolActionKey } from './action-normalizer';
import { redactSecrets } from './redaction';
import { abstractHostState } from './state-abstraction';

/** Plan section 6.5 reward signals for the host tool-call surface. */
export const HOST_TOOL_REWARD_SIGNALS = {
  /** A tool call that reported an error. */
  toolError: -2,
  /** A tool call that succeeded. */
  toolSuccess: 0.5,
  /** Additional signal when the same error repeats in the same session. */
  repeatedError: -3,
  /** turn/end reason.kind signals. */
  turnCompleted: 1,
  turnError: -2,
  turnMaxTokens: -1,
  turnAborted: 0
} as const;

/** Turn outcomes this producer understands; anything else maps to 'unknown'. */
export const HOST_TURN_KIND_OBSERVATIONS = [
  'completed',
  'error',
  'max_tokens',
  'aborted',
  'unknown'
] as const;
export type HostTurnKindObservation = (typeof HOST_TURN_KIND_OBSERVATIONS)[number];

/** One observed tool result, as the hook adapter can read it. */
export interface HostToolObservation {
  readonly toolName: string;
  readonly isError: boolean;
  /** Process exit code, when the host exposes one. */
  readonly exitCode?: number;
  /** Short error class / status; never a raw message. */
  readonly errorClass?: string;
  readonly sessionId?: string;
  readonly branchId?: string;
  /** Observation timestamp; defaults to the injected clock. */
  readonly at?: number;
}

/** One observed turn end. */
export interface HostTurnObservation {
  readonly kind: HostTurnKindObservation;
  readonly sessionId?: string;
  readonly branchId?: string;
  readonly at?: number;
}

/** Sink the hook adapter calls; kept free of kernel types on purpose. */
export interface HostToolExperienceSink {
  observeToolCall(observation: HostToolObservation): Promise<void>;
  observeTurnEnd(observation: HostTurnObservation): Promise<void>;
}

/** Wiring for {@link createHostToolExperienceCollector}. */
export interface HostToolExperienceCollectorOptions {
  /** Fully resolved plugin configuration (reward weights/clip are read). */
  readonly config: EvoHarnessConfig;
  /** Experience store facade; only append() is needed. */
  readonly store: Pick<IExperienceStore, 'append'>;
  /** Injected clock shared with the kernel. */
  readonly now?: () => number;
  /** Current policy id used for the drift bookkeeping of these records. */
  readonly policyId?: () => string;
  /** Diagnostic sink (payload free). */
  readonly onDiagnostic?: (message: string) => void;
  /**
   * Runtime gate (`/evo jit off`): when it returns false no record is produced,
   * so switching JitRL off also stops evidence collection.
   */
  readonly isEnabled?: () => boolean;
}

/** The constructed producer. */
export interface HostToolExperienceCollector extends HostToolExperienceSink {
  /** Records this collector appended successfully in this process. */
  count(): number;
  /** Payload-free diagnostics (append failures, invalid observations). */
  diagnostics(): readonly string[];
}

/** Longest tool-name fragment kept in a token; matches the L3 state contract. */
const TOOL_NAME_LIMIT = 48;
/** Rolling window of tool names carried by the abstract state (plan section 6.5). */
const RECENT_TOOL_WINDOW = 8;

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return value < min ? min : value > max ? max : value;
}

/** A tool name reduced to a redacted, bounded token fragment. */
function safeToolName(raw: string): string {
  const redacted = redactSecrets(typeof raw === 'string' ? raw : 'unknown').trim();
  if (redacted.length === 0) {
    return 'unknown';
  }
  return redacted.length <= TOOL_NAME_LIMIT ? redacted : redacted.slice(0, TOOL_NAME_LIMIT);
}

/** A redacted, bounded error class; raw host messages never reach this far. */
function safeErrorClass(raw: string | undefined, isError: boolean): string {
  if (!isError) {
    return 'none';
  }
  const redacted = redactSecrets(raw === undefined ? 'tool_error' : raw).trim();
  return redacted.length === 0 ? 'tool_error' : redacted.slice(0, TOOL_NAME_LIMIT);
}

/**
 * Create the host-tool experience producer.
 *
 * Deliberately independent of who calls it: the adapter only knows this sink
 * interface, so the producer can be swapped in tests without touching the hook
 * surface.
 */
export function createHostToolExperienceCollector(
  options: HostToolExperienceCollectorOptions
): HostToolExperienceCollector {
  const config = options.config;
  const now = options.now ?? ((): number => Date.now());
  const policyId = options.policyId ?? ((): string => 'pi-host');
  const weights = config.jitrl.reward.weights;
  const clipMin = finiteOr(config.jitrl.reward.clip[0], -3);
  const clipMax = finiteOr(config.jitrl.reward.clip[1], 3);
  const toolWeight = finiteOr(weights.tool, 0);
  const turnWeight = finiteOr(weights.turn, 0);

  const diagnostics: string[] = [];
  const recentTools: string[] = [];
  /** Last error signature per session, for the repeated-error signal. */
  const lastErrorBySession = new Map<string, string>();
  /** Last credited action, so a turn/end can be attributed to it. */
  let lastCredit:
    | { readonly actionKey: string; readonly errorClass: string; readonly sessionId: string }
    | undefined;
  let sequence = 0;
  let appended = 0;

  const enabled = (): boolean =>
    options.isEnabled === undefined ? true : options.isEnabled() !== false;

  const note = (message: string): void => {
    diagnostics.push(message);
    options.onDiagnostic?.(message);
  };

  const append = async (input: {
    readonly reward: number;
    readonly toolName: string;
    readonly state: AbstractState;
    readonly actionKey: string;
    readonly sessionId: string;
    readonly rewardSources: Readonly<Record<string, number>>;
    readonly at: number;
  }): Promise<void> => {
    if (!enabled()) {
      return;
    }
    sequence += 1;
    const record: ExperienceRecord = {
      id: 'host-tool-' + String(sequence),
      level: 'host_tool',
      state: input.state,
      actionKey: input.actionKey,
      reward: input.reward,
      // A single host action has no discount horizon: G_t = r_t (gamma^0).
      return: input.reward,
      rewardSources: input.rewardSources,
      guidance: 'memory',
      policyId: policyId(),
      sessionId: input.sessionId,
      createdAt: input.at,
      redacted: true
    };
    try {
      await options.store.append([record]);
      appended += 1;
    } catch (error) {
      note(
        'host-tool experience append failed: ' +
          (error instanceof Error ? error.name + ': ' + redactSecrets(error.message) : 'unknown')
      );
    }
  };

  return {
    async observeToolCall(observation: HostToolObservation): Promise<void> {
      if (observation === null || typeof observation !== 'object') {
        return;
      }
      const rawName = typeof observation.toolName === 'string' ? observation.toolName : '';
      if (rawName.length === 0) {
        return;
      }
      const toolName = safeToolName(rawName);
      recentTools.push(toolName);
      while (recentTools.length > RECENT_TOOL_WINDOW) {
        recentTools.shift();
      }
      const sessionId =
        typeof observation.sessionId === 'string' && observation.sessionId.length > 0
          ? observation.sessionId
          : 'host-local';
      const isError = observation.isError === true;
      const errorClass = safeErrorClass(observation.errorClass, isError);

      let toolSignal = isError
        ? HOST_TOOL_REWARD_SIGNALS.toolError
        : HOST_TOOL_REWARD_SIGNALS.toolSuccess;
      if (isError) {
        const signature =
          toolName +
          '|' +
          errorClass +
          '|' +
          (typeof observation.exitCode === 'number' ? String(observation.exitCode) : '');
        if (lastErrorBySession.get(sessionId) === signature) {
          toolSignal += HOST_TOOL_REWARD_SIGNALS.repeatedError;
        }
        lastErrorBySession.set(sessionId, signature);
      } else {
        lastErrorBySession.delete(sessionId);
      }

      const toolContribution = toolWeight * toolSignal;
      const reward = clamp(toolContribution, clipMin, clipMax);
      const state = abstractHostState({
        recentToolNames: recentTools,
        lastErrorClass: errorClass,
        turnKind: 'unknown'
      });
      const actionKey = redactSecrets(normalizeToolActionKey(toolName));
      lastCredit = { actionKey, errorClass, sessionId };
      await append({
        reward,
        toolName,
        state,
        actionKey,
        sessionId,
        rewardSources: { tool: toolContribution, turn: 0 },
        at: finiteOr(observation.at, now())
      });
    },

    async observeTurnEnd(observation: HostTurnObservation): Promise<void> {
      if (observation === null || typeof observation !== 'object') {
        return;
      }
      const kind = HOST_TURN_KIND_OBSERVATIONS.find((known) => known === observation.kind) ?? 'unknown';
      const signal =
        kind === 'completed'
          ? HOST_TOOL_REWARD_SIGNALS.turnCompleted
          : kind === 'error'
            ? HOST_TOOL_REWARD_SIGNALS.turnError
            : kind === 'max_tokens'
              ? HOST_TOOL_REWARD_SIGNALS.turnMaxTokens
              : kind === 'aborted'
                ? HOST_TOOL_REWARD_SIGNALS.turnAborted
                : 0;
      const turnContribution = turnWeight * signal;
      if (turnContribution === 0) {
        return;
      }
      const sessionId =
        typeof observation.sessionId === 'string' && observation.sessionId.length > 0
          ? observation.sessionId
          : (lastCredit?.sessionId ?? 'host-local');
      // Credit the last tool action: the turn outcome is that action's outcome.
      // Without a preceding tool call there is nothing to attribute, so the turn
      // contributes no standalone action sample.
      const credit = lastCredit;
      if (credit === undefined) {
        return;
      }
      const state = abstractHostState({
        recentToolNames: recentTools,
        lastErrorClass: credit.errorClass,
        turnKind: kind
      });
      await append({
        reward: clamp(turnContribution, clipMin, clipMax),
        toolName: recentTools[recentTools.length - 1] ?? 'unknown',
        state,
        actionKey: credit.actionKey,
        sessionId,
        rewardSources: { tool: 0, turn: turnContribution },
        at: finiteOr(observation.at, now())
      });
    },

    count(): number {
      return appended;
    },

    diagnostics(): readonly string[] {
      return [...diagnostics];
    }
  };
}
