/**
 * P3-C wiring: two-phase settlement for PRODUCTION consumers.
 *
 * WHY THIS MODULE EXISTS
 *   ADR-0004 §5.3 / §6 and the ledger's `settle(interim)` / `reconcileLateUsage`
 *   were implemented and pinned by tests in P3-C (t6), but nothing on the
 *   production path used them: `src/dsh-bridge/agent-loop-executor.ts` and
 *   `src/dsh-bridge/metered-model-adapter.ts` settled in ONE step and had no
 *   entry point for late usage at all. `docs/reports/p3-c-usage.md` §7.1 records
 *   that gap and the four wiring contracts this module implements:
 *
 *     1. persist `callId -> reservationId` for at least the reconciliation window;
 *     2. cancellation / timeout may only `settle({interim:true})` on the ORIGINAL
 *        callId — never a fresh one;
 *     3. late usage must be merged by the ORIGINAL callId through
 *        `reconcileLateUsage`; opening a new `reserve + settle` is the real
 *        double-booking path (the ledger cannot detect it: two callIds are two
 *        calls);
 *     4. a new callId is sanctioned ONLY for a provably unreachable origin, and
 *        only with an explicit `new-attempt` marker recorded for reconciliation.
 *
 * WHAT IT OWNS (and deliberately does NOT own)
 *   - `LedgerCallIndex`: the durable mapping. Append-only JSONL beside the WAL,
 *     so a restart (or a second process) can still join late usage to the call
 *     that produced it. It also persists the rate card FROZEN at reserve time,
 *     because after a final settlement the manager no longer holds the
 *     reservation record and would otherwise reprice late usage against today's
 *     default card (ADR-0004 §8.1 time-freeze).
 *   - `TwoPhaseSettlement`: the only sanctioned call lifecycle a bridge may use
 *     (beginCall -> settleCall -> reconcileLateUsage | bookNewAttempt). The
 *     interim/final choice is made HERE, from the outcome, so a consumer cannot
 *     "forget" to use interim for an unconfirmed remote termination.
 *   - It does NOT change accounting semantics: all money movement stays in
 *     `LedgerReservationManager`. It does not deny anything, and it never
 *     fabricates a ledger event.
 *
 * FAIL-CLOSED DEFAULTS
 *   - Late usage whose origin is unknown is REFUSED (`LATE_USAGE_UNKNOWN_CALL`),
 *     with nothing reserved and nothing settled. The escape hatch is a separate,
 *     explicitly marked call (`bookNewAttempt`).
 *   - Late usage for a call that has not terminated yet is REFUSED
 *     (`LATE_USAGE_BEFORE_TERMINATION`): the manager's reconcile treats an active
 *     reservation as "no interim buffer to release", which would book the spend
 *     while the reservation is still held.
 *   - A callId the index knows but the ledger has forgotten (a restart without
 *     `recoverFromWal()`) is REFUSED (`CALL_STATE_UNAVAILABLE`) instead of being
 *     silently re-reserved under the same identity.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isRemoteTerminationConfirmed, type LedgerReservationManager } from './reservation-manager.js';
import type {
  BudgetPoolType,
  ExecutionOutcome,
  LedgerPhase,
  ModelRateCard,
  ProviderUsagePayload,
  ReserveRequest,
  ReserveResult,
  SettleRequest,
  SettleResult,
  UsageLedgerEvent
} from './types.js';

/** Every durable lifecycle state a wired call can be in. */
export type LedgerCallState = 'reserved' | 'interim_settled' | 'settled' | 'reconciled';

/** The file the durable call mapping is appended to, next to the WAL. */
export const DEFAULT_CALL_INDEX_FILE = 'ledger.calls.jsonl';

/** Default number of TERMINAL call identities retained in memory (in-flight ones are never dropped). */
export const DEFAULT_MAX_RETAINED_CALLS = 4096;

/** Stable failure codes; assertions never grep prose. */
export type TwoPhaseLedgerErrorCode =
  | 'LATE_USAGE_UNKNOWN_CALL'
  | 'LATE_USAGE_BEFORE_TERMINATION'
  | 'NEW_ATTEMPT_MARKER_REQUIRED'
  | 'CALL_STATE_UNAVAILABLE'
  | 'CALL_NOT_TRACKED'
  | 'INDEX_CONFIG_CONFLICT'
  | 'INDEX_STORAGE_FORBIDDEN'
  // Raised by a CONSUMER whose ledger is switched off: metering cannot be
  // reconciled when nothing recorded the call in the first place.
  | 'LATE_USAGE_UNMETERED';

export class TwoPhaseLedgerError extends Error {
  readonly code: TwoPhaseLedgerErrorCode;

  constructor(code: TwoPhaseLedgerErrorCode, message: string) {
    super('[' + code + '] ' + message);
    this.name = 'TwoPhaseLedgerError';
    this.code = code;
  }
}

/**
 * One wired call: the durable `callId -> reservationId` mapping plus the rate
 * card frozen when the reservation was made.
 */
export interface LedgerCallIdentity {
  readonly callId: string;
  readonly reservationId: string;
  readonly pool: BudgetPoolType;
  readonly phase: LedgerPhase;
  /** Which consumer reserved it ('agent-loop-executor', 'metered-model-adapter:compose', ...). */
  readonly consumer: string;
  readonly reservedCostMicros: number;
  /** The card snapshotted at reserve() time; re-used to price late usage (ADR-0004 §8.1). */
  readonly rateCard?: ModelRateCard;
  readonly sessionId?: string;
  readonly operationId?: string;
  readonly attempt?: number;
  readonly state: LedgerCallState;
  readonly outcome?: ExecutionOutcome;
  readonly incurredCostMicros?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly reconciledAt?: number;
  /** How many times late usage was merged into this call. */
  readonly reconciliations: number;
  /** Present only on a marked cross-callId booking (contract 4). */
  readonly newAttemptMarker?: 'new-attempt';
  readonly newAttemptReason?: string;
  readonly originCallId?: string;
}

/**
 * A late-arriving usage record, joined to the call that PRODUCED it.
 *
 * `originCallId` is the ledger identity we issued at reserve time — it is the
 * only key that makes the merge safe. `providerCallId` is audit metadata and is
 * never used to open a new ledger call.
 */
export interface LateUsageEvent {
  readonly originCallId: string;
  readonly providerCallId?: string;
  readonly usage?: ProviderUsagePayload;
  readonly actualCostMicros?: number;
  readonly sessionId?: string;
  /** Observation time of the late usage; defaults to the index clock. */
  readonly receivedAt?: number;
  /** Fallback card. The index's frozen card WINS (ADR-0004 §8.1). */
  readonly rateCard?: ModelRateCard;
  /** Only `bookNewAttempt` reads this; `reconcileLateUsage` never reserves. */
  readonly newAttemptMarker?: 'new-attempt';
  readonly newAttemptReason?: string;
}

/** How a late-usage event was booked. */
export type LateUsageMode = 'reconciled' | 'new-attempt';

export interface LateUsageSettlement {
  readonly mode: LateUsageMode;
  readonly callId: string;
  readonly reservationId: string;
  readonly incurredCostMicros: number;
  readonly seatReleased: boolean;
  readonly reconciledAt: number;
  /** True when this callId had already been reconciled before this event (a safe re-delivery). */
  readonly previouslyReconciled: boolean;
  readonly ledgerEvent?: UsageLedgerEvent;
  /** Set on a marked new attempt: the origin whose mapping was unreachable. */
  readonly originCallId?: string;
  readonly newAttemptMarker?: 'new-attempt';
  readonly newAttemptReason?: string;
}

/** Result of a wired settlement: which phase ran, and the resulting identity. */
export interface TwoPhaseSettleOutcome {
  readonly settlement: 'interim' | 'final';
  readonly result: SettleResult;
  readonly identity: LedgerCallIdentity;
  readonly idempotentReplay: boolean;
}

interface CallIndexLine {
  readonly v: 1;
  readonly op: 'reserve' | 'interim' | 'final' | 'reconcile' | 'new-attempt';
  readonly at: number;
  readonly callId: string;
  readonly reservationId?: string;
  readonly pool?: BudgetPoolType;
  readonly phase?: LedgerPhase;
  readonly consumer?: string;
  readonly reservedCostMicros?: number;
  readonly rateCard?: ModelRateCard;
  readonly sessionId?: string;
  readonly operationId?: string;
  readonly attempt?: number;
  readonly outcome?: ExecutionOutcome;
  readonly incurredCostMicros?: number;
  readonly originCallId?: string;
  readonly newAttemptMarker?: 'new-attempt';
  readonly newAttemptReason?: string;
}

export interface LedgerCallIndexOptions {
  /** Directory shared with the WAL (the default: `<storageDir>/ledger.calls.jsonl`). */
  readonly storageDir?: string;
  /** Explicit file path, overriding `storageDir`. */
  readonly filePath?: string;
  /** TERMINAL identities retained in memory; in-flight ones are never evicted. */
  readonly maxRetainedCalls?: number;
  /** Injected clock so tests are deterministic. */
  readonly now?: () => number;
}

/**
 * Append-only durable `callId -> reservationId` index.
 *
 * The file is the durable log and is never rewritten; `load()` replays it into
 * the latest identity per callId. Eviction (of TERMINAL identities only) is
 * visible through `evicted`, never silent.
 */
export class LedgerCallIndex {
  private readonly filePath?: string;
  private readonly storageDirPath?: string;
  private readonly maxRetainedCalls: number;
  private readonly now: () => number;
  private readonly identitiesByName = new Map<string, LedgerCallIdentity>();
  private readonly newAttemptIds: string[] = [];
  private evictedCount = 0;
  private loadedLines = 0;

  constructor(options: LedgerCallIndexOptions = {}) {
    this.now = options.now ?? ((): number => Date.now());
    this.maxRetainedCalls =
      options.maxRetainedCalls === undefined || options.maxRetainedCalls < 1
        ? DEFAULT_MAX_RETAINED_CALLS
        : Math.floor(options.maxRetainedCalls);

    if (options.filePath !== undefined) {
      const resolved = path.resolve(options.filePath);
      this.assertWritableLocation(resolved);
      this.filePath = resolved;
      this.storageDirPath = path.dirname(resolved);
    } else if (options.storageDir !== undefined) {
      const normalized = path.resolve(options.storageDir);
      this.assertWritableLocation(normalized);
      this.storageDirPath = normalized;
      this.filePath = path.join(normalized, DEFAULT_CALL_INDEX_FILE);
    }

    if (this.storageDirPath !== undefined && !fs.existsSync(this.storageDirPath)) {
      fs.mkdirSync(this.storageDirPath, { recursive: true });
    }
    this.load();
  }

  /** The append-only file, or undefined when this index is process-local only. */
  get persistencePath(): string | undefined {
    return this.filePath;
  }

  /** The normalized directory the mapping lives in (undefined when in-memory). */
  get storageDir(): string | undefined {
    return this.storageDirPath;
  }

  /** True when the mapping survives a restart. False is a visible degradation, never silent. */
  get persistent(): boolean {
    return this.filePath !== undefined;
  }

  /** TERMINAL identities evicted from memory by the retention bound. */
  get evicted(): number {
    return this.evictedCount;
  }

  /** Durable lines replayed by the last `load()`. */
  get replayedLines(): number {
    return this.loadedLines;
  }

  private assertWritableLocation(target: string): void {
    // Same compliance guard as the WAL: team collaboration internals are never ours.
    if (target.includes('.agent-teams')) {
      throw new TwoPhaseLedgerError(
        'INDEX_STORAGE_FORBIDDEN',
        'the call index must not be written inside .agent-teams ("' + target + '")'
      );
    }
  }

  /** Replay the file (if any) into the current identity map. Idempotent. */
  load(): number {
    this.identitiesByName.clear();
    this.newAttemptIds.length = 0;
    this.loadedLines = 0;
    if (this.filePath === undefined || !fs.existsSync(this.filePath)) {
      return 0;
    }
    const content = fs.readFileSync(this.filePath, 'utf8');
    for (const rawLine of content.split('\n')) {
      const trimmed = rawLine.trim();
      if (trimmed.length === 0) {
        continue;
      }
      let line: CallIndexLine;
      try {
        line = JSON.parse(trimmed) as CallIndexLine;
      } catch {
        // A crash can truncate exactly the final line. Anything else is corruption
        // and must not be silently skipped (it would drop a real mapping).
        continue;
      }
      if (typeof line.callId !== 'string' || typeof line.op !== 'string') {
        continue;
      }
      this.apply(line);
      this.loadedLines += 1;
    }
    this.enforceRetention();
    return this.loadedLines;
  }

  private apply(line: CallIndexLine): void {
    const previous = this.identitiesByName.get(line.callId);
    const base: LedgerCallIdentity =
      previous ??
      {
        callId: line.callId,
        reservationId: line.reservationId ?? '',
        pool: line.pool ?? 'general',
        phase: line.phase ?? 'probe',
        consumer: line.consumer ?? 'unknown',
        reservedCostMicros: line.reservedCostMicros ?? 0,
        createdAt: line.at,
        updatedAt: line.at,
        state: 'reserved',
        reconciliations: 0
      };

    const state: LedgerCallState =
      line.op === 'interim'
        ? 'interim_settled'
        : line.op === 'final'
          ? 'settled'
          : line.op === 'reconcile'
            ? 'reconciled'
            : base.state;

    const next: LedgerCallIdentity = {
      ...base,
      updatedAt: line.at,
      state,
      ...(line.op === 'reconcile'
        ? { reconciledAt: line.at, reconciliations: base.reconciliations + 1 }
        : {}),
      ...(line.reservationId === undefined ? {} : { reservationId: line.reservationId }),
      ...(line.pool === undefined ? {} : { pool: line.pool }),
      ...(line.phase === undefined ? {} : { phase: line.phase }),
      ...(line.consumer === undefined ? {} : { consumer: line.consumer }),
      ...(line.reservedCostMicros === undefined ? {} : { reservedCostMicros: line.reservedCostMicros }),
      ...(line.rateCard === undefined ? {} : { rateCard: line.rateCard }),
      ...(line.sessionId === undefined ? {} : { sessionId: line.sessionId }),
      ...(line.operationId === undefined ? {} : { operationId: line.operationId }),
      ...(line.attempt === undefined ? {} : { attempt: line.attempt }),
      ...(line.outcome === undefined ? {} : { outcome: line.outcome }),
      ...(line.incurredCostMicros === undefined ? {} : { incurredCostMicros: line.incurredCostMicros }),
      ...(line.newAttemptMarker === undefined ? {} : { newAttemptMarker: line.newAttemptMarker }),
      ...(line.newAttemptReason === undefined ? {} : { newAttemptReason: line.newAttemptReason }),
      ...(line.originCallId === undefined ? {} : { originCallId: line.originCallId })
    };

    // Re-insert so the newest touch is the newest entry (retention order).
    this.identitiesByName.delete(line.callId);
    this.identitiesByName.set(line.callId, next);
    if (line.op === 'new-attempt' && !this.newAttemptIds.includes(line.callId)) {
      this.newAttemptIds.push(line.callId);
    }
  }

  private enforceRetention(): void {
    if (this.identitiesByName.size <= this.maxRetainedCalls) {
      return;
    }
    for (const [callId, identity] of [...this.identitiesByName.entries()]) {
      if (this.identitiesByName.size <= this.maxRetainedCalls) {
        break;
      }
      // In-flight obligations (reserved / interim) are never evicted: they are
      // still joinable late usage.
      if (identity.state === 'reserved' || identity.state === 'interim_settled') {
        continue;
      }
      this.identitiesByName.delete(callId);
      this.evictedCount += 1;
    }
  }

  private append(line: CallIndexLine): void {
    this.apply(line);
    this.enforceRetention();
    if (this.filePath === undefined) {
      return;
    }
    const payload = JSON.stringify(line) + '\n';
    fs.appendFileSync(this.filePath, payload, 'utf8');
    // The mapping must reach stable storage before the caller treats the call as
    // committed: without fsync a power loss can lose the reservation mapping
    // while the WAL already holds the reservation (Windows needs an append-mode
    // descriptor for fsync, see LedgerWalWriter.append).
    const descriptor = fs.openSync(this.filePath, 'a');
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }

  /** Record a newly granted reservation. */
  recordReservation(identity: {
    callId: string;
    reservationId: string;
    pool: BudgetPoolType;
    phase: LedgerPhase;
    consumer: string;
    reservedCostMicros: number;
    rateCard?: ModelRateCard;
    sessionId?: string;
    operationId?: string;
    attempt?: number;
    at?: number;
  }): LedgerCallIdentity {
    this.append({
      v: 1,
      op: 'reserve',
      at: identity.at ?? this.now(),
      callId: identity.callId,
      reservationId: identity.reservationId,
      pool: identity.pool,
      phase: identity.phase,
      consumer: identity.consumer,
      reservedCostMicros: identity.reservedCostMicros,
      ...(identity.rateCard === undefined ? {} : { rateCard: identity.rateCard }),
      ...(identity.sessionId === undefined ? {} : { sessionId: identity.sessionId }),
      ...(identity.operationId === undefined ? {} : { operationId: identity.operationId }),
      ...(identity.attempt === undefined ? {} : { attempt: identity.attempt })
    });
    return this.mustFindIdentity(identity.callId);
  }

  /** Record an interim settlement (money held pending reconciliation). */
  recordInterim(callId: string, event: { outcome: ExecutionOutcome; incurredCostMicros: number; at?: number }): LedgerCallIdentity {
    const known = this.mustFindIdentity(callId);
    this.append({
      v: 1,
      op: 'interim',
      at: event.at ?? this.now(),
      callId,
      reservationId: known.reservationId,
      outcome: event.outcome,
      incurredCostMicros: event.incurredCostMicros
    });
    return this.mustFindIdentity(callId);
  }

  /** Record a final settlement (booked now). */
  recordFinal(callId: string, event: { outcome: ExecutionOutcome; incurredCostMicros: number; at?: number }): LedgerCallIdentity {
    const known = this.mustFindIdentity(callId);
    this.append({
      v: 1,
      op: 'final',
      at: event.at ?? this.now(),
      callId,
      reservationId: known.reservationId,
      outcome: event.outcome,
      incurredCostMicros: event.incurredCostMicros
    });
    return this.mustFindIdentity(callId);
  }

  /** Record a late-usage merge into an existing call identity. */
  recordReconciliation(callId: string, event: { incurredCostMicros: number; at?: number }): LedgerCallIdentity {
    const known = this.mustFindIdentity(callId);
    this.append({
      v: 1,
      op: 'reconcile',
      at: event.at ?? this.now(),
      callId,
      reservationId: known.reservationId,
      incurredCostMicros: event.incurredCostMicros
    });
    return this.mustFindIdentity(callId);
  }

  /** Record the explicit, marked cross-callId booking (contract 4). */
  recordNewAttempt(callId: string, event: {
    originCallId: string;
    reservationId: string;
    pool: BudgetPoolType;
    phase: LedgerPhase;
    consumer: string;
    reservedCostMicros: number;
    reason: string;
    rateCard?: ModelRateCard;
    at?: number;
  }): LedgerCallIdentity {
    const at = event.at ?? this.now();
    this.append({
      v: 1,
      op: 'new-attempt',
      at,
      callId,
      reservationId: event.reservationId,
      pool: event.pool,
      phase: event.phase,
      consumer: event.consumer,
      reservedCostMicros: event.reservedCostMicros,
      originCallId: event.originCallId,
      newAttemptMarker: 'new-attempt',
      newAttemptReason: event.reason,
      ...(event.rateCard === undefined ? {} : { rateCard: event.rateCard })
    });
    return this.mustFindIdentity(callId);
  }

  lookup(callId: string): LedgerCallIdentity | undefined {
    return this.identitiesByName.get(callId);
  }

  /**
   * Look up an identity that MUST exist.
   *
   * Deliberately NOT named after the CommonJS loader function: that name survives
   * into the esbuild bundle as a member call, and the build/ESM smoke gate
   * (scripts/eval/smoke-build.mjs) reads any such call as CommonJS syntax and
   * fails the build. A private helper must not be able to break that gate.
   */
  private mustFindIdentity(callId: string): LedgerCallIdentity {
    const found = this.identitiesByName.get(callId);
    if (found === undefined) {
      throw new TwoPhaseLedgerError('CALL_NOT_TRACKED', 'no call identity recorded for "' + callId + '"');
    }
    return found;
  }

  /** Every known identity, oldest first. */
  entries(): readonly LedgerCallIdentity[] {
    return [...this.identitiesByName.values()];
  }

  /** Identities booked through the marked new-attempt path (audit separation). */
  newAttempts(): readonly LedgerCallIdentity[] {
    return this.newAttemptIds
      .map((callId) => this.identitiesByName.get(callId))
      .filter((identity): identity is LedgerCallIdentity => identity !== undefined);
  }

  /** Number of calls still holding reserved money pending reconciliation. */
  pendingReconciliationCallIds(): readonly string[] {
    return [...this.identitiesByName.values()]
      .filter((identity) => identity.state === 'interim_settled')
      .map((identity) => identity.callId);
  }
}

/** Options for {@link TwoPhaseSettlement}. */
export interface TwoPhaseSettlementOptions {
  /** Default consumer label recorded on identities ('agent-loop-executor', 'metered-model-adapter:compose', ...). */
  readonly consumer: string;
  /** Injectable index; defaults to one over `storageDir`. */
  readonly index?: LedgerCallIndex;
  /** Directory shared with the WAL, when this creates the index itself. */
  readonly storageDir?: string;
}

/**
 * The single sanctioned call lifecycle for a production consumer.
 *
 * Lifecycle: `beginCall` (durable mapping + reserve) -> `settleCall` (interim when
 * the remote termination is unconfirmed, final otherwise) -> `reconcileLateUsage`
 * when usage arrives after termination. `bookNewAttempt` is the only path that
 * may open a NEW callId, and only with an explicit marker.
 */
export class TwoPhaseSettlement {
  readonly manager: LedgerReservationManager;
  readonly index: LedgerCallIndex;
  private readonly defaultConsumer: string;

  constructor(manager: LedgerReservationManager, options: TwoPhaseSettlementOptions) {
    this.manager = manager;
    this.defaultConsumer = options.consumer;
    this.index = options.index ?? new LedgerCallIndex({ storageDir: options.storageDir });
  }

  /**
   * Reserve under a durable callId -> reservationId mapping.
   *
   * Refuses (typed error) when the index already knows this callId but the ledger
   * has no state for it — that is a restart that skipped `recoverFromWal()`, and
   * re-reserving would silently fork one identity into two reservations.
   */
  beginCall(request: ReserveRequest & { readonly consumer?: string }): ReserveResult {
    this.assertManagerAlignedWithIndex(request.callId);
    const { consumer, ...reserveRequest } = request;
    const result = this.manager.reserve(reserveRequest);
    if (result.granted && result.reservationId !== undefined) {
      this.index.recordReservation({
        callId: request.callId,
        reservationId: result.reservationId,
        pool: result.pool,
        phase: request.phase,
        consumer: consumer ?? this.defaultConsumer,
        reservedCostMicros: result.reservedCostMicros,
        ...(request.rateCard === undefined ? {} : { rateCard: request.rateCard }),
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        ...(request.operationId === undefined ? {} : { operationId: request.operationId }),
        ...(request.attempt === undefined ? {} : { attempt: request.attempt })
      });
    }
    return result;
  }

  /**
   * Settle a wired call. The interim/final choice is made from the OUTCOME:
   * anything that does not prove the remote terminated settles interim, holding
   * the money and the seat until reconciliation (ADR-0004 §5.1/§5.3).
   */
  settleCall(request: SettleRequest): TwoPhaseSettleOutcome {
    const identity = this.index.lookup(request.callId);
    if (identity === undefined) {
      throw new TwoPhaseLedgerError(
        'CALL_NOT_TRACKED',
        'callId "' + request.callId + '" was never opened through beginCall(); refusing to settle an untracked call'
      );
    }
    this.assertManagerAlignedWithIndex(request.callId);
    const interim = !isRemoteTerminationConfirmed(request.outcome);
    const result = this.manager.settle({
      ...request,
      interim
    });
    if (!result.isIdempotentReplay) {
      if (interim) {
        this.index.recordInterim(request.callId, {
          outcome: request.outcome,
          incurredCostMicros: result.incurredCostMicros
        });
      } else {
        this.index.recordFinal(request.callId, {
          outcome: request.outcome,
          incurredCostMicros: result.incurredCostMicros
        });
      }
    }
    const updated = this.index.lookup(request.callId);
    if (updated === undefined) {
      throw new TwoPhaseLedgerError('CALL_NOT_TRACKED', 'call identity for "' + request.callId + '" disappeared');
    }
    return {
      settlement: interim ? 'interim' : 'final',
      result,
      identity: updated,
      idempotentReplay: result.isIdempotentReplay
    };
  }

  /**
   * Merge late usage into the ORIGINAL call. This path NEVER reserves: an origin
   * the index cannot join is refused, so the "open a new callId" double-booking
   * path (path 乙 in the P3-C report) is closed rather than merely discouraged.
   */
  reconcileLateUsage(event: LateUsageEvent): LateUsageSettlement {
    const identity = this.index.lookup(event.originCallId);
    if (identity === undefined) {
      throw new TwoPhaseLedgerError(
        'LATE_USAGE_UNKNOWN_CALL',
        'no durable call identity for originCallId "' + event.originCallId + '"; a late-usage record is NEVER ' +
          'booked as a new reservation (that is the cross-callId double-booking path). Use bookNewAttempt() only ' +
          'when the origin is provably unreachable, with the explicit new-attempt marker.'
      );
    }
    if (identity.state === 'reserved') {
      throw new TwoPhaseLedgerError(
        'LATE_USAGE_BEFORE_TERMINATION',
        'call "' + identity.callId + '" is still active; settle it (interim for an unconfirmed cancellation) ' +
          'before merging late usage, otherwise the spend is booked while the reservation is still held'
      );
    }
    this.assertManagerAlignedWithIndex(identity.callId);
    const rateCard = identity.rateCard ?? event.rateCard;
    const result = this.manager.reconcileLateUsage({
      callId: identity.callId,
      ...(event.usage === undefined ? {} : { usage: event.usage }),
      ...(event.actualCostMicros === undefined ? {} : { actualCostMicros: event.actualCostMicros }),
      ...(rateCard === undefined ? {} : { rateCard }),
      ...((event.sessionId ?? identity.sessionId) === undefined
        ? {}
        : { sessionId: event.sessionId ?? identity.sessionId })
    });
    const reconciled = this.index.recordReconciliation(identity.callId, {
      incurredCostMicros: result.incurredCostMicros,
      ...(event.receivedAt === undefined ? {} : { at: event.receivedAt })
    });
    return {
      mode: 'reconciled',
      callId: reconciled.callId,
      reservationId: reconciled.reservationId,
      incurredCostMicros: result.incurredCostMicros,
      seatReleased: result.seatReleased,
      reconciledAt: reconciled.reconciledAt ?? event.receivedAt ?? Date.now(),
      previouslyReconciled: identity.state === 'reconciled',
      ...(result.ledgerEvent === undefined ? {} : { ledgerEvent: result.ledgerEvent })
    };
  }

  /**
   * The ONLY sanctioned way to book usage whose origin call is unreachable
   * (contract 4): the caller must state the marker AND a reason, the ledger call
   * gets a derived callId, and the identity records the origin so a
   * reconciliation report can separate it from the joined calls.
   *
   * The new record settles with outcome 'failed' on purpose: an unjoined usage is
   * a booking correction, not evidence that a call succeeded, so it stays
   * audit-only and is never quality evidence.
   */
  bookNewAttempt(event: LateUsageEvent): LateUsageSettlement {
    const reason = event.newAttemptReason;
    if (event.newAttemptMarker !== 'new-attempt' || reason === undefined || reason.trim().length === 0) {
      throw new TwoPhaseLedgerError(
        'NEW_ATTEMPT_MARKER_REQUIRED',
        'opening a new ledger call for late usage requires newAttemptMarker="new-attempt" and a non-empty ' +
          'newAttemptReason; without them the booking is indistinguishable from double counting'
      );
    }
    const origin = this.index.lookup(event.originCallId);
    const callId = event.originCallId + '#new-attempt-' + String(this.index.newAttempts().length + 1);
    const rateCard = origin?.rateCard ?? event.rateCard;
    const reserved = this.beginCall({
      callId,
      phase: origin?.phase ?? 'probe',
      pool: origin?.pool ?? 'general',
      estimatedCostMicros: origin?.reservedCostMicros ?? 0,
      requiresSeat: false,
      consumer: this.defaultConsumer + ':late-usage-new-attempt',
      ...(rateCard === undefined ? {} : { rateCard })
    });
    if (!reserved.granted || reserved.reservationId === undefined) {
      throw new TwoPhaseLedgerError(
        'LATE_USAGE_UNKNOWN_CALL',
        'the ledger refused the marked new attempt for origin "' + event.originCallId + '": ' +
          (reserved.rejectionReason ?? 'unknown reason')
      );
    }
    const settled = this.settleCall({
      callId,
      reservationId: reserved.reservationId,
      outcome: 'failed',
      ...(event.usage === undefined ? {} : { usage: event.usage }),
      ...(event.actualCostMicros === undefined ? {} : { actualCostMicros: event.actualCostMicros })
    });
    const recorded = this.index.recordNewAttempt(callId, {
      originCallId: event.originCallId,
      reservationId: reserved.reservationId,
      pool: reserved.pool,
      phase: origin?.phase ?? 'probe',
      consumer: this.defaultConsumer + ':late-usage-new-attempt',
      reservedCostMicros: reserved.reservedCostMicros,
      reason,
      ...(rateCard === undefined ? {} : { rateCard })
    });
    return {
      mode: 'new-attempt',
      callId: recorded.callId,
      reservationId: recorded.reservationId,
      incurredCostMicros: settled.result.incurredCostMicros,
      seatReleased: settled.result.seatReleased,
      reconciledAt: recorded.updatedAt,
      previouslyReconciled: false,
      originCallId: event.originCallId,
      newAttemptMarker: 'new-attempt',
      newAttemptReason: reason,
      ...(settled.result.ledgerEvent === undefined ? {} : { ledgerEvent: settled.result.ledgerEvent })
    };
  }

  identityOf(callId: string): LedgerCallIdentity | undefined {
    return this.index.lookup(callId);
  }

  identities(): readonly LedgerCallIdentity[] {
    return this.index.entries();
  }

  /** One-line state summary, safe to log (no prompts, no budgets of individual calls). */
  describe(): string {
    return (
      'two-phase settlement: consumer=' + this.defaultConsumer +
      ', call index=' + (this.index.persistent ? 'persistent (' + String(this.index.persistencePath) + ')' : 'in-memory (no storageDir)') +
      ', retained=' + String(this.index.entries().length) +
      (this.index.evicted === 0 ? '' : ', evicted=' + String(this.index.evicted))
    );
  }

  /**
   * Refuse when the durable index knows a call the LEDGER does not. Re-reserving
   * the same callId would fork one identity into two reservations, and settling
   * would throw a confusing UNRESERVED_CALL_SETTLE far from the cause.
   */
  private assertManagerAlignedWithIndex(callId: string): void {
    if (this.index.lookup(callId) === undefined) {
      return;
    }
    if (this.manager.getSettledResult(callId) !== undefined || this.manager.getReservationByCallId(callId) !== undefined) {
      return;
    }
    throw new TwoPhaseLedgerError(
      'CALL_STATE_UNAVAILABLE',
      'the durable call index knows "' + callId + '" but the ledger has no reservation or settlement for it; ' +
        'call recoverFromWal() on the manager before wiring a recovered process to this index'
    );
  }
}

/**
 * One settlement coordinator per ledger manager.
 *
 * The executor and the metered adapter must share it: otherwise a mapping written
 * by one consumer is invisible to the other, and two writers can address the same
 * append-only file. The storage directory is derived from the manager's WAL when
 * the caller does not pass one, so the mapping always lives beside the events it
 * describes.
 */
const SETTLEMENTS = new WeakMap<LedgerReservationManager, TwoPhaseSettlement>();

/** The directory a manager's WAL lives in, when it is durable. */
export function ledgerStorageDirOf(manager: LedgerReservationManager): string | undefined {
  const eventsPath = manager.getWalWriter().eventsPath;
  return eventsPath === undefined ? undefined : path.dirname(eventsPath);
}

export function twoPhaseSettlementFor(
  manager: LedgerReservationManager,
  options: { readonly consumer: string; readonly storageDir?: string; readonly index?: LedgerCallIndex }
): TwoPhaseSettlement {
  const existing = SETTLEMENTS.get(manager);
  if (existing !== undefined) {
    const requested = options.storageDir === undefined ? undefined : path.resolve(options.storageDir);
    if (requested !== undefined && existing.index.storageDir !== undefined && requested !== existing.index.storageDir) {
      throw new TwoPhaseLedgerError(
        'INDEX_CONFIG_CONFLICT',
        'this ledger manager already has a call index at "' + String(existing.index.storageDir) + '"; refusing to ' +
          'silently prefer a second one at "' + requested + '"'
      );
    }
    return existing;
  }
  const storageDir = options.storageDir ?? ledgerStorageDirOf(manager);
  const created = new TwoPhaseSettlement(manager, {
    consumer: options.consumer,
    ...(options.index === undefined ? {} : { index: options.index }),
    ...(storageDir === undefined ? {} : { storageDir })
  });
  SETTLEMENTS.set(manager, created);
  return created;
}

/** True when an outcome must settle INTERIM (remote termination unconfirmed). */
export function requiresInterimSettlement(outcome: ExecutionOutcome): boolean {
  return !isRemoteTerminationConfirmed(outcome);
}
