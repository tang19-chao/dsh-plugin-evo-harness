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
 *     while the reservation is still held. One audited exception (R2-1): a
 *     crash-recovered call the manager marks `pending_reconciliation` (or whose
 *     interim settle reached the WAL but not the index, P1-5) is provably not
 *     running anymore and DOES reconcile through the sanctioned path — never as
 *     a silent 0 booking (a recovered reconcile requires usage with a card, or
 *     an actualCostMicros).
 *   - A callId the index knows but the ledger has forgotten (a restart without
 *     `recoverFromWal()`) is REFUSED (`CALL_STATE_UNAVAILABLE`) instead of being
 *     silently re-reserved under the same identity.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CONSERVATIVE_FALLBACK_FLOOR_MICROS,
  isRemoteTerminationConfirmed,
  type LedgerReservationManager
} from './reservation-manager.js';
import type {
  BudgetPoolType,
  ExecutionOutcome,
  LedgerPhase,
  LedgerRecoveryReport,
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
  // LEDGER-7: the call-index file is corrupt somewhere other than the final
  // line; load() refuses instead of silently dropping a real mapping.
  | 'INDEX_CORRUPT'
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
  /**
   * The provider-side call id carried by the late usage that was joined to this
   * call (LEDGER-12). Persisted so an external bill keyed only by provider ids
   * can still be matched against the ledger (reconciliation.ts dual-key match).
   */
  readonly providerCallId?: string;
  /** Present only on a marked cross-callId booking (contract 4). */
  readonly newAttemptMarker?: 'new-attempt';
  readonly newAttemptReason?: string;
  readonly originCallId?: string;
}

/**
 * A late-arriving usage record, joined to the call that PRODUCED it.
 *
 * `originCallId` is the ledger identity we issued at reserve time — it is the
 * only key that makes the merge safe. `providerCallId` is never used to open a
 * new ledger call, but it IS persisted on the joined identity at reconciliation
 * time (LEDGER-12) so an external provider bill keyed by provider ids can be
 * matched against the ledger afterwards.
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
  readonly providerCallId?: string;
  readonly originCallId?: string;
  readonly newAttemptMarker?: 'new-attempt';
  readonly newAttemptReason?: string;
}

/**
 * The shapes the manager appends to the WAL for the three event kinds the index
 * sync replays (reservation-manager.ts). They are internal to the ledger; every
 * field is defensively defaulted at read time — a legacy or hand-written event
 * must never crash recovery, only degrade to the index's own defaults.
 */
interface WalReservedPayload {
  readonly callId?: string;
  readonly reservationId?: string;
  readonly pool?: BudgetPoolType;
  readonly phase?: LedgerPhase;
  readonly reservedCostMicros?: number;
  readonly rateCard?: ModelRateCard;
  readonly sessionId?: string;
  readonly operationId?: string;
  readonly attempt?: number;
}

interface WalSettledPayload {
  readonly callId?: string;
  readonly interim?: boolean;
  readonly incurredCostMicros?: number;
  readonly outcome?: ExecutionOutcome;
}

interface WalReconciledPayload {
  readonly callId?: string;
  readonly newIncurredCost?: number;
}

/** Result of a two-phase crash recovery: the manager's report plus the index sync. */
export interface TwoPhaseRecoveryReport {
  /** The manager's own WAL/snapshot recovery report (ADR-0004 §6.2). */
  readonly manager: LedgerRecoveryReport;
  /** Call identities rebuilt into the index from EVENT_RESERVED payloads. */
  readonly indexReservationsBackfilled: number;
  /** Index identities advanced from EVENT_SETTLED / EVENT_RECONCILED payloads. */
  readonly indexSettlementsAdvanced: number;
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
    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const trimmed = (lines[index] ?? '').trim();
      if (trimmed.length === 0) {
        continue;
      }
      let line: CallIndexLine | undefined;
      let corruptReason: string | undefined;
      try {
        line = JSON.parse(trimmed) as CallIndexLine;
      } catch (error) {
        corruptReason = error instanceof Error ? error.message : String(error);
      }
      if (line !== undefined && (typeof line.callId !== 'string' || typeof line.op !== 'string')) {
        // A line `append()` wrote always carries both fields; a parseable line
        // without them is corruption too, not a legal entry.
        corruptReason = 'line is missing callId/op';
        line = undefined;
      }
      if (line === undefined) {
        // LEDGER-7: mirror the WAL reader's rule (LedgerWalWriter.readAllEvents).
        // A crash can truncate exactly the final line. Anything else is
        // corruption and must not be silently skipped (it would drop a real
        // fsynced callId -> reservationId mapping, and late usage for that call
        // would be refused forever). Fail closed with a named error.
        const isLastNonEmpty = lines.slice(index + 1).every((raw) => raw.trim().length === 0);
        if (!isLastNonEmpty) {
          throw new TwoPhaseLedgerError(
            'INDEX_CORRUPT',
            'the call index "' + this.filePath + '" is corrupt at line ' + String(index + 1) + ': ' +
              (corruptReason ?? 'unknown reason')
          );
        }
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
      ...(line.providerCallId === undefined ? {} : { providerCallId: line.providerCallId }),
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
  recordReconciliation(callId: string, event: {
    incurredCostMicros: number;
    /** Provider-side id of the late usage (LEDGER-12); persisted on the identity. */
    providerCallId?: string;
    at?: number;
  }): LedgerCallIdentity {
    const known = this.mustFindIdentity(callId);
    this.append({
      v: 1,
      op: 'reconcile',
      at: event.at ?? this.now(),
      callId,
      reservationId: known.reservationId,
      incurredCostMicros: event.incurredCostMicros,
      ...(event.providerCallId === undefined ? {} : { providerCallId: event.providerCallId })
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
    /** Provider-side id of the late usage (LEDGER-12); persisted on the identity. */
    providerCallId?: string;
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
      ...(event.providerCallId === undefined ? {} : { providerCallId: event.providerCallId }),
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
 * Derive the attempt callId DETERMINISTICALLY from the event (P0-3, audit
 * LEDGER-1): the same late-usage delivery must derive the SAME callId on every
 * redelivery, so the manager's settle-side idempotency cache (keyed per callId)
 * can see the duplicate, while a genuinely different event (another reason,
 * providerCallId or observation time) still derives its own callId. The digest
 * is the ledger's usual deterministic hash shape — SHA-256, first 16 hex, over a
 * canonical JSON array, exactly like the §8.1 rate-card digest (`rateCardDigest`
 * in limits.ts). `receivedAt` is part of the key on purpose: it is the
 * observation time that travels WITH the event, so two genuinely distinct late
 * deliveries of one unreachable origin book separately.
 */
function deriveNewAttemptCallId(event: LateUsageEvent, reason: string): string {
  const canonical = JSON.stringify([
    event.originCallId,
    reason,
    event.providerCallId ?? null,
    event.receivedAt ?? null
  ]);
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
  return event.originCallId + '#new-attempt-' + digest;
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
  /**
   * P3-4 (rev5 t12, structural debt B): the manager is PRIVATE ON PURPOSE.
   *
   * The register (`docs/reports/p3-c-structural-debt-register.md` §3 B) requires
   * the production bridges to hold no live manager reference: a public
   * `settlement.manager` would be exactly the "get the manager back through the
   * assembly's return value, then settle directly" bypass the AST gate exists to
   * stop. Keeping it private makes that path a TYPE ERROR rather than a lint
   * warning, while the sanctioned lifecycle (`beginCall`/`settleCall`/
   * `reconcileLateUsage`/`bookNewAttempt`) stays public.
   */
  private readonly manager: LedgerReservationManager;
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
   *
   * P1-5 (audit LEDGER-2): the mapping is recorded AFTER `manager.reserve()` on
   * purpose — the reservationId only exists once the manager minted it. The
   * crash window that ordering opens (reserve fsynced, index line lost) is
   * closed by {@link recoverFromWal}'s index sync and by the back-fill in
   * `settleCall`/`reconcileLateUsage`, not by reordering here.
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
   *
   * P3-4 (rev5 t12, structural debt A): the parameter type is
   * `Omit<SettleRequest,'interim'>`. A caller that passes `interim` now gets
   * `TS2353` instead of silently having the flag ignored (the pre-fix behaviour
   * the register reproduced: `settleCall({..., interim:false})` compiled and was
   * overridden at runtime). The runtime decision is still made from the outcome —
   * this type removes the misleading knob, it does not add a policy switch.
   */
  settleCall(request: Omit<SettleRequest, 'interim'>): TwoPhaseSettleOutcome {
    // P1-5 (audit LEDGER-2): a crash (or an fs error) between the manager's
    // fsynced settle and the index append can leave a reservation the index has
    // never heard of. The manager's state is the durable truth (its WAL event
    // was fsynced first), so the identity is rebuilt from it instead of refusing
    // forever with CALL_NOT_TRACKED.
    let identity = this.index.lookup(request.callId) ?? this.backfillIndexIdentityFromManager(request.callId);
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
    } else if (identity.state === 'reserved') {
      // P1-5: the FIRST settle already reached the WAL (that is why this is a
      // replay) but its index line was lost. The index ops are idempotent
      // appends keyed by callId, so replaying the missing line brings the
      // identity forward — without this the identity stays 'reserved' forever,
      // the reserved buffer is never joinable, and reconcileLateUsage refuses
      // with LATE_USAGE_BEFORE_TERMINATION on every retry. The state recorded is
      // the one the manager actually booked (the cached result), never whatever
      // the retry's outcome happens to suggest.
      const outcome = result.ledgerEvent?.outcome ?? request.outcome;
      if (result.state === 'interim_settled') {
        this.index.recordInterim(request.callId, {
          outcome,
          incurredCostMicros: result.incurredCostMicros
        });
      } else {
        this.index.recordFinal(request.callId, {
          outcome,
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
    // P1-5/R2-1: the crash windows can also cost the index its reserve line
    // while the manager still holds (or has recovered) the reservation. Rebuild
    // the identity from the manager before refusing — a recovered call must stay
    // joinable through THIS path, not only through bookNewAttempt.
    const identity =
      this.index.lookup(event.originCallId) ?? this.backfillIndexIdentityFromManager(event.originCallId);
    if (identity === undefined) {
      throw new TwoPhaseLedgerError(
        'LATE_USAGE_UNKNOWN_CALL',
        'no durable call identity for originCallId "' + event.originCallId + '"; a late-usage record is NEVER ' +
          'booked as a new reservation (that is the cross-callId double-booking path). Use bookNewAttempt() only ' +
          'when the origin is provably unreachable, with the explicit new-attempt marker.'
      );
    }
    const rateCard = identity.rateCard ?? event.rateCard;
    if (identity.state === 'reserved') {
      // R2-1: after a crash the manager marks the interrupted reservation
      // `pending_reconciliation` (or it is `interim_settled` when the crash hit
      // between the manager's fsynced interim settle and the index append —
      // P1-5). The call is provably NOT running anymore, so the manager's
      // reconcile path (which releases the buffer and books the true cost) is
      // the sanctioned exit; refusing here locked the funds forever. A genuinely
      // active reservation is still refused.
      const reservation = this.manager.getReservationByCallId(identity.callId);
      const noLongerRunning =
        reservation !== undefined &&
        (reservation.state === 'interim_settled' || reservation.state === 'pending_reconciliation');
      // Never open a new silent-0 path: with neither a usable card for the usage
      // nor an actualCostMicros, the manager's no-data branch would book
      // previousIncurred (0 for a recovered call) and release the buffer.
      const bookable =
        event.actualCostMicros !== undefined || (event.usage !== undefined && rateCard !== undefined);
      if (!noLongerRunning || !bookable) {
        throw new TwoPhaseLedgerError(
          'LATE_USAGE_BEFORE_TERMINATION',
          noLongerRunning
            ? 'recovered call "' + identity.callId + '" carries no rate card for its usage and no actualCostMicros; ' +
              'reconciling it as-is would silently book 0 and release the reserved buffer'
            : 'call "' + identity.callId + '" is still active; settle it (interim for an unconfirmed cancellation) ' +
              'before merging late usage, otherwise the spend is booked while the reservation is still held'
        );
      }
    }
    this.assertManagerAlignedWithIndex(identity.callId);
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
      // LEDGER-12: keep the provider-side id on the durable identity so an
      // external bill keyed only by providerCallId can be matched later.
      ...(event.providerCallId === undefined ? {} : { providerCallId: event.providerCallId }),
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
   * reconciliation report can separate it from the joined calls. The callId is
   * deterministic in the event (see {@link deriveNewAttemptCallId}), so a
   * redelivery of the same at-least-once event returns the already-recorded
   * settlement instead of booking the spend twice (P0-3, audit LEDGER-1).
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
    // P0-3 (audit LEDGER-1): the attempt callId is derived from the EVENT, never
    // from a mutable counter. `newAttempts().length + 1` handed every redelivery
    // of the same at-least-once late-usage event a fresh callId, and both dedupe
    // layers (reserve/settle) are keyed per callId, so the double booking was
    // invisible by construction.
    const callId = deriveNewAttemptCallId(event, reason);
    // The same event derives the same callId, so an already-settled delivery is
    // visible in the settle-side idempotency cache (the settledCalls cache that
    // makes a duplicate settleCall an idempotent replay): the EXISTING settlement
    // is returned as-is and nothing is booked a second time.
    const alreadySettled = this.manager.getSettledResult(callId);
    if (alreadySettled !== undefined) {
      const tracked = this.index.lookup(callId);
      if (
        tracked === undefined ||
        tracked.newAttemptMarker !== 'new-attempt' ||
        tracked.originCallId !== event.originCallId
      ) {
        throw new TwoPhaseLedgerError(
          'CALL_STATE_UNAVAILABLE',
          'the ledger already settled "' + callId + '" but the call index holds no marked new-attempt identity ' +
            'for origin "' + event.originCallId + '"; refusing to book the same late usage a second time'
        );
      }
      return {
        mode: 'new-attempt',
        callId: tracked.callId,
        reservationId: tracked.reservationId,
        incurredCostMicros: alreadySettled.incurredCostMicros,
        seatReleased: alreadySettled.seatReleased,
        reconciledAt: tracked.updatedAt,
        previouslyReconciled: true,
        ...(alreadySettled.ledgerEvent === undefined ? {} : { ledgerEvent: alreadySettled.ledgerEvent }),
        originCallId: event.originCallId,
        newAttemptMarker: 'new-attempt',
        newAttemptReason: tracked.newAttemptReason ?? reason
      };
    }
    const origin = this.index.lookup(event.originCallId);
    const rateCard = origin?.rateCard ?? event.rateCard;
    // R2-3 (audit round 2): with no rate card reachable the old estimate was
    // `origin?.reservedCostMicros ?? 0`, so the settle below fell to the
    // reserved-upper-bound branch and booked real usage as 0. Ring-fence
    // settle()'s conservative floor instead: the no-card settle then lands at
    // the reserved upper bound with provenance 'unknown' and conservative=true
    // (never a silent 0, ADR-0003 §7.3.5). With a card the pricing path (or the
    // origin's own estimate) decides, exactly as before.
    const estimatedCostMicros =
      rateCard === undefined
        ? Math.max(origin?.reservedCostMicros ?? 0, CONSERVATIVE_FALLBACK_FLOOR_MICROS)
        : origin?.reservedCostMicros ?? 0;
    const reserved = this.beginCall({
      callId,
      phase: origin?.phase ?? 'probe',
      pool: origin?.pool ?? 'general',
      estimatedCostMicros,
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
      // LEDGER-12: the provider-side id joins the marked identity too.
      ...(event.providerCallId === undefined ? {} : { providerCallId: event.providerCallId }),
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
   * Crash recovery for the PAIR (manager + call index).
   *
   * `manager.recoverFromWal()` rebuilds the pools from the WAL/snapshot; this
   * method then syncs the durable call index from the SAME WAL event payloads
   * (audit LEDGER-2 / R2-1): a crash between the manager's fsynced append and
   * the index append otherwise leaves a live reservation whose identity the
   * index never learns, and no sanctioned lifecycle exit can book it. Only
   * MISSING index lines are back-filled — an identity the index already has is
   * never rewritten, so re-running this is a no-op.
   */
  recoverFromWal(): TwoPhaseRecoveryReport {
    const manager = this.manager.recoverFromWal();
    return { manager, ...this.syncIndexFromWalEvents() };
  }

  /**
   * Rebuild/advance index identities from the WAL event payloads.
   *
   * Three event kinds matter: EVENT_RESERVED back-fills a `reserve` identity the
   * index never received; EVENT_SETTLED advances a still-'reserved' identity to
   * interim/final (the P1-5 window, healed proactively instead of only on the
   * next settle retry); EVENT_RECONCILED advances the identity to 'reconciled'.
   * The scan is strictly forward-only and additive: it never inserts a line for
   * a call the index already tracks and never moves an identity backwards.
   */
  private syncIndexFromWalEvents(): {
    indexReservationsBackfilled: number;
    indexSettlementsAdvanced: number;
  } {
    let reservationsBackfilled = 0;
    let settlementsAdvanced = 0;
    for (const event of this.manager.getWalWriter().readAllEvents()) {
      if (event.type === 'EVENT_RESERVED') {
        const payload = (event.payload ?? {}) as WalReservedPayload;
        if (
          payload.callId === undefined ||
          payload.reservationId === undefined ||
          this.index.lookup(payload.callId) !== undefined
        ) {
          continue;
        }
        this.index.recordReservation({
          callId: payload.callId,
          reservationId: payload.reservationId,
          pool: payload.pool ?? 'general',
          phase: payload.phase ?? 'probe',
          consumer: 'wal-recovery',
          reservedCostMicros: payload.reservedCostMicros ?? 0,
          at: event.timestamp,
          ...(payload.rateCard === undefined ? {} : { rateCard: payload.rateCard }),
          ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }),
          ...(payload.operationId === undefined ? {} : { operationId: payload.operationId }),
          ...(payload.attempt === undefined ? {} : { attempt: payload.attempt })
        });
        reservationsBackfilled += 1;
      } else if (event.type === 'EVENT_SETTLED') {
        const payload = (event.payload ?? {}) as WalSettledPayload;
        const identity = payload.callId === undefined ? undefined : this.index.lookup(payload.callId);
        if (payload.callId === undefined || identity === undefined || identity.state !== 'reserved') {
          continue;
        }
        const interim = payload.interim === true;
        const outcome = payload.outcome ?? 'interrupted_by_crash';
        const incurred = payload.incurredCostMicros ?? 0;
        if (interim) {
          this.index.recordInterim(payload.callId, { outcome, incurredCostMicros: incurred, at: event.timestamp });
        } else {
          this.index.recordFinal(payload.callId, { outcome, incurredCostMicros: incurred, at: event.timestamp });
        }
        settlementsAdvanced += 1;
      } else if (event.type === 'EVENT_RECONCILED') {
        const payload = (event.payload ?? {}) as WalReconciledPayload;
        const identity = payload.callId === undefined ? undefined : this.index.lookup(payload.callId);
        if (payload.callId === undefined || identity === undefined || identity.state === 'reconciled') {
          continue;
        }
        this.index.recordReconciliation(payload.callId, {
          incurredCostMicros: payload.newIncurredCost ?? 0,
          at: event.timestamp
        });
        settlementsAdvanced += 1;
      }
    }
    return { indexReservationsBackfilled: reservationsBackfilled, indexSettlementsAdvanced: settlementsAdvanced };
  }

  /**
   * Rebuild a call identity the index lost, from the manager's reservation.
   *
   * The manager's record IS the durable truth (a live reservation was appended
   * to the fsynced WAL; a recovered one was replayed from the EVENT_RESERVED
   * payload by `recoverFromWal()`), so a missing index mapping is re-recorded
   * from it. The consumer label is honestly unknown — the WAL does not carry it
   * — so a rebuilt identity is always marked 'wal-recovery'. Returns undefined
   * when the manager holds no reservation for the callId (then the caller's
   * original typed refusal stands).
   */
  private backfillIndexIdentityFromManager(callId: string): LedgerCallIdentity | undefined {
    const existing = this.index.lookup(callId);
    if (existing !== undefined) {
      return existing;
    }
    const reservation = this.manager.getReservationByCallId(callId);
    if (reservation === undefined) {
      return undefined;
    }
    this.index.recordReservation({
      callId,
      reservationId: reservation.reservationId,
      pool: reservation.pool,
      phase: reservation.phase,
      consumer: 'wal-recovery',
      reservedCostMicros: reservation.reservedCostMicros,
      ...(reservation.rateCard === undefined ? {} : { rateCard: reservation.rateCard }),
      ...(reservation.sessionId === undefined ? {} : { sessionId: reservation.sessionId }),
      ...(reservation.operationId === undefined ? {} : { operationId: reservation.operationId }),
      ...(reservation.attempt === undefined ? {} : { attempt: reservation.attempt })
    });
    return this.index.lookup(callId);
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
