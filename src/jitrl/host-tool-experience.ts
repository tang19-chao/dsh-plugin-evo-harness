/**
 * L3 host-tool experience producer (plan sections 3.3 and 6.5; repairs H2, R2, R3).
 *
 * Scope isolation (R2, plan section 5.2):
 * State (recentTools, lastCredit, error history) is strictly bucketed by scope
 * (session + branch). Different sessions and different branches never share
 * recent tool history or action credits. Turn completion cleans up pending
 * credits, preventing duplicate turn-end attributions. Unknown scopes do not
 * inherit any global state.
 *
 * Invariant branch protection (R3, plan section 5.2):
 * Invariant probe branches (guidance_free) are never masqueraded as regular
 * memory experience. The collector rejects memory record creation for invariant
 * scopes.
 *
 * Safe disposal, deduplication, TTL pruning and bounded scope capacity (maxScopes)
 * prevent unbounded memory growth.
 */
import type { EvoHarnessConfig } from '../config';
import type { AbstractState, ExperienceRecord, GuidanceMode, IExperienceStore } from '../types/contracts';
import { normalizeToolActionKey } from './action-normalizer';
import { redactSecrets } from './redaction';
import { abstractHostState } from './state-abstraction';
import {
  createScopeRegistry,
  formatScopeKey,
  isInvariantScopeName,
  type ScopeRegistry
} from './scope-registry';

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
  /** Slot provenance (e.g. 'explore_invariant', 'explore_domain'). */
  readonly origin?: string;
  readonly provenance?: string;
  /** Guidance mode: invariant scopes set guidance_free. */
  readonly guidance?: GuidanceMode;
  /** Observation timestamp; defaults to the injected clock. */
  readonly at?: number;
  readonly toolCallId?: string;
  readonly eventId?: string;
}

/** One observed turn end. */
export interface HostTurnObservation {
  readonly kind: HostTurnKindObservation;
  readonly sessionId?: string;
  readonly branchId?: string;
  readonly origin?: string;
  readonly provenance?: string;
  readonly guidance?: GuidanceMode;
  readonly at?: number;
  readonly turnId?: string;
  readonly eventId?: string;
  readonly reason?: unknown;
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
  /** Injected ScopeRegistry for trusted scope resolution and invariant branch protection. */
  readonly scopeRegistry?: ScopeRegistry;
  /** Maximum number of scope buckets kept concurrently. Default 256. */
  readonly maxScopes?: number;
  /** Scope inactivity TTL in ms. Default 30 minutes (1_800_000 ms). */
  readonly ttlMs?: number;
}

/** The constructed producer. */
export interface HostToolExperienceCollector extends HostToolExperienceSink {
  /** The ScopeRegistry used for trusted scope resolution. */
  readonly scopeRegistry?: ScopeRegistry;
  /** Records this collector appended successfully in this process. */
  count(): number;
  /** Payload-free diagnostics (append failures, invalid observations). */
  diagnostics(): readonly string[];
  /** Prune inactive scope buckets older than TTL. Returns count of pruned scopes. */
  prune(now?: number): number;
  /** Active scope keys currently tracked in memory. */
  activeScopeKeys(): readonly string[];
  /** Clear all state buckets and dispose the collector. */
  dispose(): void;
  /** Whether the collector has been disposed. */
  readonly isDisposed?: boolean;
}

/** Longest tool-name fragment kept in a token; matches the L3 state contract. */
const TOOL_NAME_LIMIT = 48;
/** Rolling window of tool names carried by the abstract state (plan section 6.5). */
const RECENT_TOOL_WINDOW = 8;
/** Maximum event deduplication keys retained per scope bucket. */
const MAX_SEEN_EVENT_KEYS = 32;

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

/** Per-scope state bucket isolating attribution, recent tools and error history. */
interface ScopeBucket {
  readonly scopeKey: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly isInvariant: boolean;
  readonly guidance: GuidanceMode;
  readonly recentTools: string[];
  lastCredit?: {
    readonly actionKey: string;
    readonly toolName: string;
    readonly errorClass: string;
    readonly sessionId: string;
    readonly branchId: string;
    readonly toolCallId?: string;
    readonly at: number;
  };
  lastError?: string; // signature: toolName + '|' + errorClass + '|' + exitCode
  lastSeenAt: number;
  readonly seenEventKeys: Set<string>;
}

interface ResolvedScopeInfo {
  readonly scopeKey: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly isInvariant: boolean;
  readonly guidance: GuidanceMode;
  readonly isKnown: boolean;
}

/**
 * Create the host-tool experience producer with scope isolation.
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
  const maxScopes = typeof options.maxScopes === 'number' && options.maxScopes > 0 ? options.maxScopes : 256;
  const ttlMs = typeof options.ttlMs === 'number' && options.ttlMs > 0 ? options.ttlMs : 1_800_000;

  const registry =
    options.scopeRegistry ??
    createScopeRegistry({
      now: options.now,
      onDiagnostic: (msg) => options.onDiagnostic?.('scope-registry: ' + msg)
    });

  const diagnostics: string[] = [];
  const scopeBuckets = new Map<string, ScopeBucket>();
  const scopeOrder: string[] = [];
  let sequence = 0;
  let appended = 0;
  let disposed = false;

  const enabled = (): boolean =>
    options.isEnabled === undefined ? true : options.isEnabled() !== false;

  const note = (message: string): void => {
    diagnostics.push(message);
    options.onDiagnostic?.(message);
  };

  const pruneOldestIfNeeded = (): void => {
    while (scopeBuckets.size >= maxScopes && scopeOrder.length > 0) {
      const oldestKey = scopeOrder.shift();
      if (oldestKey !== undefined) {
        scopeBuckets.delete(oldestKey);
        note(`scope_bucket_evicted: ${oldestKey}`);
      }
    }
  };

  const pruneInactiveBuckets = (currentNow: number): number => {
    let count = 0;
    const cutoff = currentNow - ttlMs;
    for (const [key, bucket] of [...scopeBuckets.entries()]) {
      if (bucket.lastSeenAt < cutoff) {
        scopeBuckets.delete(key);
        const idx = scopeOrder.indexOf(key);
        if (idx >= 0) {
          scopeOrder.splice(idx, 1);
        }
        count += 1;
      }
    }
    return count;
  };

  const resolveScope = (
    observation: HostToolObservation | HostTurnObservation
  ): ResolvedScopeInfo => {
    const isExplicitInvariant =
      observation.guidance === 'guidance_free' ||
      observation.origin === 'explore_invariant' ||
      observation.provenance === 'explore_invariant' ||
      (typeof observation.branchId === 'string' && isInvariantScopeName(observation.branchId));

    if (options.scopeRegistry !== undefined) {
      const resolved = options.scopeRegistry.resolve(observation);
      if (resolved !== 'unknown') {
        const isInv = isExplicitInvariant || resolved.isInvariant;
        return {
          scopeKey: resolved.scopeKey,
          sessionId: resolved.sessionId,
          branchId: resolved.branchId,
          isInvariant: isInv,
          guidance: isInv ? 'guidance_free' : resolved.guidance,
          isKnown: true
        };
      }
      return {
        scopeKey: 'unknown',
        sessionId: 'unknown',
        branchId: 'unknown',
        isInvariant: isExplicitInvariant,
        guidance: 'guidance_free',
        isKnown: false
      };
    }

    // Standalone collector without ScopeRegistry:
    const rawSession =
      typeof observation.sessionId === 'string' && observation.sessionId.trim().length > 0
        ? observation.sessionId.trim()
        : undefined;
    const rawBranch =
      typeof observation.branchId === 'string' && observation.branchId.trim().length > 0
        ? observation.branchId.trim()
        : undefined;

    if (rawSession !== undefined && rawBranch !== undefined) {
      const isInv = isExplicitInvariant || isInvariantScopeName(rawBranch);
      return {
        scopeKey: formatScopeKey(rawSession, rawBranch),
        sessionId: rawSession,
        branchId: rawBranch,
        isInvariant: isInv,
        guidance: isInv ? 'guidance_free' : 'memory',
        isKnown: true
      };
    }

    // Missing branchId or missing sessionId: never invent 'main' (F5)!
    return {
      scopeKey: 'unknown',
      sessionId: 'unknown',
      branchId: 'unknown',
      isInvariant: isExplicitInvariant,
      guidance: isExplicitInvariant ? 'guidance_free' : 'memory',
      isKnown: false
    };
  };

  const getOrCreateBucket = (scopeInfo: ResolvedScopeInfo, currentNow: number): ScopeBucket => {
    let bucket = scopeBuckets.get(scopeInfo.scopeKey);
    if (bucket !== undefined) {
      bucket.lastSeenAt = currentNow;
      return bucket;
    }

    pruneOldestIfNeeded();

    bucket = {
      scopeKey: scopeInfo.scopeKey,
      sessionId: scopeInfo.sessionId,
      branchId: scopeInfo.branchId,
      isInvariant: scopeInfo.isInvariant,
      guidance: scopeInfo.guidance,
      recentTools: [],
      lastSeenAt: currentNow,
      seenEventKeys: new Set<string>()
    };

    scopeBuckets.set(scopeInfo.scopeKey, bucket);
    scopeOrder.push(scopeInfo.scopeKey);
    return bucket;
  };

  const rememberEventKey = (bucket: ScopeBucket, eventKey: string | undefined): boolean => {
    if (eventKey === undefined || eventKey.length === 0) {
      return false; // not a deduplicable event
    }
    if (bucket.seenEventKeys.has(eventKey)) {
      return true; // duplicate!
    }
    if (bucket.seenEventKeys.size >= MAX_SEEN_EVENT_KEYS) {
      const first = bucket.seenEventKeys.values().next().value;
      if (first !== undefined) {
        bucket.seenEventKeys.delete(first);
      }
    }
    bucket.seenEventKeys.add(eventKey);
    return false;
  };

  const append = async (input: {
    readonly reward: number;
    readonly toolName: string;
    readonly state: AbstractState;
    readonly actionKey: string;
    readonly sessionId: string;
    readonly branchId?: string;
    readonly scopeKey?: string;
    readonly guidance: GuidanceMode;
    readonly rewardSources: Readonly<Record<string, number>>;
    readonly at: number;
  }): Promise<void> => {
    if (!enabled() || disposed) {
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
      guidance: input.guidance,
      policyId: policyId(),
      sessionId: input.sessionId,
      ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
      ...(input.scopeKey !== undefined ? { scopeKey: input.scopeKey } : {}),
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
    get isDisposed(): boolean {
      return disposed;
    },

    async observeToolCall(observation: HostToolObservation): Promise<void> {
      if (disposed || observation === null || typeof observation !== 'object') {
        return;
      }
      if (!enabled()) {
        return;
      }
      const rawName = typeof observation.toolName === 'string' ? observation.toolName : '';
      if (rawName.length === 0) {
        return;
      }
      const toolName = safeToolName(rawName);
      const currentTime = finiteOr(observation.at, now());
      pruneInactiveBuckets(currentTime);

      const scopeInfo = resolveScope(observation);

      // Invariant probe branches must NEVER produce memory experience (plan section 5.2 / R3)
      if (scopeInfo.isInvariant) {
        note('host-tool observation skipped: invariant probe scope is prohibited from memory collection');
        return;
      }

      // Handle unknown scope: isolates to its own 'unknown' bucket, does NOT inherit any global state
      // Option 2 (F9): Unproven branches (rawBranch.length > 0) fail-closed and write zero memory.
      // Host-local ordinary tool executions without branchId accumulate host-level baseline experience.
      if (!scopeInfo.isKnown) {
        const rawBranch = typeof observation.branchId === 'string' ? observation.branchId.trim() : '';
        if (rawBranch.length > 0) {
          note('host-tool observation skipped: unproven branch scope is prohibited from collection');
          return;
        }

        const bucket = getOrCreateBucket(scopeInfo, currentTime);
        const isError = observation.isError === true;
        const errorClass = safeErrorClass(observation.errorClass, isError);
        const toolSignal = isError
          ? HOST_TOOL_REWARD_SIGNALS.toolError
          : HOST_TOOL_REWARD_SIGNALS.toolSuccess;
        const toolContribution = toolWeight * toolSignal;
        const reward = clamp(toolContribution, clipMin, clipMax);
        bucket.recentTools.push(toolName);
        while (bucket.recentTools.length > RECENT_TOOL_WINDOW) {
          bucket.recentTools.shift();
        }
        const state = abstractHostState({
          recentToolNames: [...bucket.recentTools],
          lastErrorClass: errorClass,
          turnKind: 'unknown'
        });
        const actionKey = redactSecrets(normalizeToolActionKey(toolName));
        bucket.lastCredit = {
          actionKey,
          toolName,
          errorClass,
          sessionId: 'unknown',
          branchId: 'unknown',
          toolCallId: observation.toolCallId,
          at: currentTime
        };
        await append({
          reward,
          toolName,
          state,
          actionKey,
          sessionId: 'unknown',
          guidance: 'memory',
          rewardSources: { tool: toolContribution, turn: 0 },
          at: currentTime
        });
        return;
      }

      const bucket = getOrCreateBucket(scopeInfo, currentTime);

      // Deduplication check
      const eventKey =
        observation.eventId ??
        observation.toolCallId ??
        (observation.at !== undefined ? `${toolName}:${observation.isError}:${observation.at}` : undefined);
      if (rememberEventKey(bucket, eventKey)) {
        return; // duplicate observation suppressed
      }

      bucket.recentTools.push(toolName);
      while (bucket.recentTools.length > RECENT_TOOL_WINDOW) {
        bucket.recentTools.shift();
      }

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
        if (bucket.lastError === signature) {
          toolSignal += HOST_TOOL_REWARD_SIGNALS.repeatedError;
        }
        bucket.lastError = signature;
      } else {
        bucket.lastError = undefined;
      }

      const toolContribution = toolWeight * toolSignal;
      const reward = clamp(toolContribution, clipMin, clipMax);
      const state = abstractHostState({
        recentToolNames: [...bucket.recentTools],
        lastErrorClass: errorClass,
        turnKind: 'unknown'
      });
      const actionKey = redactSecrets(normalizeToolActionKey(toolName));

      // Credited within this scope bucket only
      bucket.lastCredit = {
        actionKey,
        toolName,
        errorClass,
        sessionId: scopeInfo.sessionId,
        branchId: scopeInfo.branchId,
        toolCallId: observation.toolCallId,
        at: currentTime
      };

      await append({
        reward,
        toolName,
        state,
        actionKey,
        sessionId: scopeInfo.sessionId,
        branchId: scopeInfo.branchId,
        scopeKey: bucket.scopeKey,
        guidance: bucket.guidance,
        rewardSources: { tool: toolContribution, turn: 0 },
        at: currentTime
      });
    },

    async observeTurnEnd(observation: HostTurnObservation): Promise<void> {
      if (disposed || observation === null || typeof observation !== 'object') {
        return;
      }
      if (!enabled()) {
        return;
      }
      const currentTime = finiteOr(observation.at, now());
      const rawKind =
        observation.kind ??
        (typeof observation.reason === 'object' && observation.reason !== null
          ? (observation.reason as { kind?: unknown }).kind
          : undefined);
      const kind =
        HOST_TURN_KIND_OBSERVATIONS.find((known) => known === rawKind) ?? 'unknown';

      const scopeInfo = resolveScope(observation);

      // Invariant probe branches must NEVER produce memory experience
      if (scopeInfo.isInvariant) {
        return;
      }

      let bucket = scopeBuckets.get(scopeInfo.scopeKey);
      if (bucket === undefined && scopeInfo.scopeKey !== 'unknown') {
        bucket = scopeBuckets.get('unknown');
      }
      if (!scopeInfo.isKnown && (bucket === undefined || bucket.lastCredit === undefined)) {
        return;
      }
      if (bucket === undefined) {
        // No preceding tool call in this scope bucket; nothing to attribute
        return;
      }

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

      // Deduplication check
      const eventKey =
        observation.eventId ??
        observation.turnId ??
        (observation.at !== undefined ? `turn:${kind}:${observation.at}` : undefined);
      if (rememberEventKey(bucket, eventKey)) {
        return; // duplicate turn suppressed
      }

      // If aborted or zero contribution, clean up pending credit and finish
      if (turnContribution === 0 || kind === 'aborted') {
        bucket.lastCredit = undefined;
        bucket.lastSeenAt = currentTime;
        return;
      }

      // Credit the last tool action in this scope bucket
      const credit = bucket.lastCredit;
      if (credit === undefined) {
        // Without a preceding tool call in this bucket, there is nothing to attribute
        return;
      }

      // Clean up pending credit: turn termination prevents duplicate attribution
      bucket.lastCredit = undefined;
      bucket.lastSeenAt = currentTime;

      const state = abstractHostState({
        recentToolNames: [...bucket.recentTools],
        lastErrorClass: credit.errorClass,
        turnKind: kind
      });

      await append({
        reward: clamp(turnContribution, clipMin, clipMax),
        toolName: credit.toolName,
        state,
        actionKey: credit.actionKey,
        sessionId: credit.sessionId,
        branchId: credit.branchId,
        scopeKey: bucket.scopeKey,
        guidance: bucket.guidance,
        rewardSources: { tool: 0, turn: turnContribution },
        at: currentTime
      });
    },

    count(): number {
      return appended;
    },

    diagnostics(): readonly string[] {
      return [...diagnostics];
    },

    prune(at?: number): number {
      if (disposed) return 0;
      return pruneInactiveBuckets(at ?? now());
    },

    get scopeRegistry(): ScopeRegistry {
      return registry;
    },

    activeScopeKeys(): readonly string[] {
      if (disposed) return [];
      return [...scopeBuckets.keys()];
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      scopeBuckets.clear();
      scopeOrder.length = 0;
      registry.dispose();
    }
  };
}
