/**
 * Ledger Reservation & Settlement Manager.
 *
 * Implements ADR-0003 §7.4 and ADR-0004 §4, §5, §6:
 * - Concurrency: unique reservationId per callId; concurrent calls do not overwrite each other.
 * - Idempotency: duplicate settle on the same callId returns initial result without double deduction.
 * - Shared general budget: fail-closed rejection on depletion, no overdraft.
 * - Dedicated verification reserve: strictly isolated from general exploration budget.
 * - Concurrency seats: exploration seat release != amount refunded.
 * - Lifecycle validation: reserve -> settle -> releaseSeat.
 * - Time-freezing principle: rate card snapshotted at reservation time (ADR-0004 §8.1).
 * - Real cancellation & late usage reconciliation (ADR-0004 §5).
 * - Write-Ahead Log (WAL) and crash recovery with conservation check (ADR-0004 §6).
 */

import { aggregatePrecision, calculateUsageCost } from './pricing.js';
import { createUsageLedgerEvent } from './ledger-event.js';
import { summarizeUsageAccounting, type UsageAccountingReport } from './usage-report.js';
import {
  BudgetPoolType,
  CostCalculation,
  ExecutionOutcome,
  LedgerBudgetConfig,
  LedgerBudgetStatus,
  LedgerMeteringMode,
  LedgerMeteringStatus,
  LedgerRecoveryReport,
  ModelRateCard,
  ProviderUsagePayload,
  ReservationRecord,
  ReserveRejectionReason,
  ReserveRequest,
  ReserveResult,
  SettleRequest,
  SettleResult,
  UsageLedgerEvent
} from './types.js';
import { LedgerSnapshotData, LedgerWalWriter } from './wal.js';
import {
  AdmissionDecision,
  AdmissionPolicy,
  AdmissionRejection,
  CostUpperBoundBreakdown,
  CurrencyMicros,
  LimitAlert,
  LimitAlertKind,
  PoolLimitStatus,
  RouteCostBound,
  WatermarkConfig,
  WatermarkTier,
  criticalTierSeatCap,
  currencyMicros,
  decideAdmission,
  poolLimitStatus
} from './limits.js';

export class LedgerError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'UNRESERVED_CALL_SETTLE'
      | 'RESERVATION_ID_MISMATCH'
      | 'DUPLICATE_ACTIVE_RESERVATION'
      | 'SEAT_ALREADY_RELEASED'
      | 'INVALID_SETTLEMENT_STATE'
      | 'LEDGER_BALANCE_MISMATCH'
      | 'CALL_NOT_FOUND'
      | 'CANNOT_RECONCILE'
  ) {
    super(`[LedgerError:${code}] ${message}`);
    this.name = 'LedgerError';
  }
}

let reservationSequence = 0;

/**
 * Outcomes that prove the REMOTE side has stopped generating (ADR-0004 §5.2).
 *
 * Only these may return a concurrency seat. The `*_local` outcomes mean precisely
 * that we stopped WAITING and nothing more (§5.1): the provider may still be
 * producing tokens, so the seat stays held until reconciliation or an external
 * bill settles the truth. `stream_interrupted` is deliberately NOT here: a broken
 * transport is not proof that the far end stopped either.
 */
const REMOTE_TERMINATED_OUTCOMES: ReadonlySet<ExecutionOutcome> = new Set<ExecutionOutcome>([
  'succeeded',
  'failed',
  'aborted_confirmed',
  'timed_out_confirmed'
]);

/** True when the outcome proves the remote call terminated (not just local wait). */
export function isRemoteTerminationConfirmed(outcome: ExecutionOutcome): boolean {
  return REMOTE_TERMINATED_OUTCOMES.has(outcome);
}

export interface LedgerManagerOptions extends LedgerBudgetConfig {
  readonly storageDir?: string;
  readonly walWriter?: LedgerWalWriter;

  /**
   * PR-3B admission policy. Omit it to keep the pre-PR-3B behaviour: no bound is
   * claimed, nothing is refused on bound grounds (ADR-0004 §9.2 degradation).
   */
  readonly admissionPolicy?: AdmissionPolicy;

  /** PR-3B watermark thresholds. Defaults to 80% / 95% (ADR-0004 §7.4). */
  readonly watermarks?: WatermarkConfig;

  /** Route cost bounds declared up front, keyed by routeId. */
  readonly routeBounds?: readonly RouteCostBound[];

  /**
   * P3-A2: 'enforce' (default for direct construction, preserving every existing
   * accounting contract) denies on budget/seat/admission grounds. 'observe'
   * never denies for those reasons: it records the rejection it WOULD have made
   * and lets the call proceed, so a probe's outcome can never be changed by
   * metering. The assembly path defaults to 'observe' and only
   * `enforceHardBounds: true` opts into enforcement — independent of any other
   * permission switch.
   */
  readonly meteringMode?: LedgerMeteringMode;
}

export class LedgerReservationManager {
  private generalTotalMicros: number;
  private generalReservedMicros = 0;
  private generalSettledMicros = 0;

  private verificationTotalMicros: number;
  private verificationReservedMicros = 0;
  private verificationSettledMicros = 0;

  /**
   * Observed overspend variances (ADR-0004 §5.3-3). Append-only audit trail;
   * the authoritative overspend amount is always DERIVED from pool state (see
   * {@link derivedGeneralOverdraftMicros}) so crash recovery cannot drift.
   */
  private readonly overdraftVariances: Array<{
    callId: string;
    pool: BudgetPoolType;
    overdraftMicros: number;
    observedAt: number;
  }> = [];

  private maxSeats: number;

  /**
   * Single authority for concurrency-seat ownership, keyed by callId.
   *
   * Previous versions kept an `occupiedSeats` counter plus separate retained
   * handles. Releasing a seat through one path but not the others double-counted
   * (or leaked) capacity. Ownership is now a set: adding/removing a callId is the
   * ONLY way occupancy changes, and a release is idempotent because `delete`
   * reports whether it actually owned the seat.
   */
  private readonly seatOwners = new Set<string>();

  private defaultRateCard?: ModelRateCard;
  private walWriter: LedgerWalWriter;

  // P3-A2 mode + observable counters. Counters exist so "ledger with zero calls"
  // and "no ledger at all" are distinguishable (the caller's undefined manager
  // is the third state, represented by absence).
  private readonly meteringMode: LedgerMeteringMode;
  private reserveAttempts = 0;
  private reserveGranted = 0;
  private observedDenials = 0;
  private settleCount = 0;

  /** Active reservations mapped by reservationId */
  private activeReservations = new Map<string, ReservationRecord>();

  /** Map callId -> reservationId for active reservations */
  private callToReservation = new Map<string, string>();

  /**
   * Seats held for calls whose remote termination is not yet confirmed
   * (ADR-0004 §5.1). The reservation itself is already settled and removed from
   * {@link activeReservations}, so without this handle the seat would be
   * unrecoverable — see the `seatRetainedForRemote` branch in {@link settle}.
   */
  private readonly seatsRetainedPendingRemote = new Map<string, string>();

  /**
   * Seats retained because the CALLER asked not to release them yet
   * (`settle({releaseSeat:false})`). The reservation leaves `activeReservations`
   * on final settlement, so this handle is the only way a later
   * `releaseSeat(callId)` can find the seat. Without it the seat is leaked and
   * the pool eventually reports `insufficient_seats` with no live request.
   */
  private readonly seatsRetainedByCaller = new Set<string>();

  /** Idempotent settlement records mapped by callId */
  private settledCalls = new Map<string, SettleResult>();

  /** Historical ledger events recorded upon settlement */
  private ledgerEvents: UsageLedgerEvent[] = [];

  // ---- PR-3B: admission, watermarks and alerts ----------------------------
  //
  // All optional. When `admissionPolicy` is omitted the manager behaves exactly
  // as it did before PR-3B (observation only), which is what keeps the existing
  // suites and the default safe shape unchanged (ADR-0004 §9.2 degradation).

  /** Route bounds declared by the caller, keyed by routeId. */
  private readonly routeBounds = new Map<string, RouteCostBound>();

  /** Emitted limit alerts (bounded ring: the newest N are retained). */
  private readonly alerts: LimitAlert[] = [];
  private static readonly MAX_RETAINED_ALERTS = 200;

  /** Watermark configuration for both pools. */
  private watermarks?: WatermarkConfig;

  constructor(config: LedgerManagerOptions) {
    this.generalTotalMicros = Math.max(0, config.generalBudgetMicros);
    this.verificationTotalMicros = Math.max(0, config.verificationReserveMicros);
    this.maxSeats = Math.max(0, config.maxConcurrencySeats);
    this.defaultRateCard = config.defaultRateCard;
    this.meteringMode = config.meteringMode ?? 'enforce';
    this.walWriter = config.walWriter ?? new LedgerWalWriter({ storageDir: config.storageDir });
    this.admissionPolicy = config.admissionPolicy;
    this.watermarks = config.watermarks;
    for (const bound of config.routeBounds ?? []) {
      this.routeBounds.set(bound.routeId, bound);
    }
  }

  /** The configured PR-3B admission policy, or undefined (observation only). */
  private readonly admissionPolicy: AdmissionPolicy | undefined;

  /** Register or replace a route's declared cost bound. */
  registerRouteBound(bound: RouteCostBound): void {
    this.routeBounds.set(bound.routeId, bound);
  }

  /** Read a registered route bound. */
  getRouteBound(routeId: string): RouteCostBound | undefined {
    return this.routeBounds.get(routeId);
  }

  /** Record an alert, keeping only the newest {@link MAX_RETAINED_ALERTS}. */
  private pushAlert(kind: LimitAlertKind, detail: string, extra: { pool?: 'general' | 'verification'; callId?: string } = {}): void {
    this.alerts.push({
      kind,
      detail,
      observedAt: Date.now(),
      ...(extra.pool === undefined ? {} : { pool: extra.pool }),
      ...(extra.callId === undefined ? {} : { callId: extra.callId })
    });
    if (this.alerts.length > LedgerReservationManager.MAX_RETAINED_ALERTS) {
      this.alerts.splice(0, this.alerts.length - LedgerReservationManager.MAX_RETAINED_ALERTS);
    }
  }

  /** All retained limit alerts, oldest first. */
  getAlerts(): readonly LimitAlert[] {
    return [...this.alerts];
  }

  /** Alerts of one kind. */
  getAlertsOfKind(kind: LimitAlertKind): readonly LimitAlert[] {
    return this.alerts.filter((alert) => alert.kind === kind);
  }

  /**
   * PR-3B admission decision for one prospective call, WITHOUT reserving.
   *
   * This is the pure §7.3 rule applied to the manager's registered bounds and
   * policy. Callers that need the decision before touching the network use this;
   * {@link reserve} applies the same rule internally so the two can never drift.
   */
  decideAdmissionFor(params: {
    routeId?: string;
    rateCard?: ModelRateCard;
    estimatedCostMicros: number;
  }): AdmissionDecision {
    const rateCard = params.rateCard ?? this.defaultRateCard;
    if (rateCard === undefined) {
      throw new LedgerError(
        'no rate card available for an admission decision',
        'CANNOT_RECONCILE'
      );
    }
    const route = params.routeId === undefined ? undefined : this.routeBounds.get(params.routeId);
    return decideAdmission({
      policy: this.admissionPolicy ?? { mode: 'observation', allowUnboundedRiskOverride: false },
      route,
      rateCard,
      estimatedCostMicros: params.estimatedCostMicros
    });
  }

  /** The phased-limit status of both pools (ADR-0004 §7.4). */
  getPoolLimitStatus(): { general: PoolLimitStatus; verification: PoolLimitStatus } {
    const general = poolLimitStatus({
      totalMicros: this.generalTotalMicros,
      reservedMicros: this.generalReservedMicros,
      settledMicros: this.generalSettledMicros,
      overdraftMicros: this.derivedGeneralOverdraftMicros,
      ...(this.watermarks === undefined ? {} : { watermarks: this.watermarks })
    });
    const verification = poolLimitStatus({
      totalMicros: this.verificationTotalMicros,
      reservedMicros: this.verificationReservedMicros,
      settledMicros: this.verificationSettledMicros,
      overdraftMicros: this.derivedVerificationOverdraftMicros,
      ...(this.watermarks === undefined ? {} : { watermarks: this.watermarks })
    });
    return { general, verification };
  }

  /**
   * Current concurrency seat cap after the §7.4 critical-tier throttle.
   *
   * At the critical watermark general exploration concurrency is halved; the
   * verification pool (`judge`) is untouched so a run can always be judged.
   */
  getEffectiveSeatCap(): number {
    const tier = this.getPoolLimitStatus().general.tier;
    if (tier === 'critical') {
      return criticalTierSeatCap(this.maxSeats);
    }
    if (tier === 'frozen') {
      return 0;
    }
    return this.maxSeats;
  }

  /** Current watermark tier of the general pool. */
  getGeneralTier(): WatermarkTier {
    return this.getPoolLimitStatus().general.tier;
  }

  getWalWriter(): LedgerWalWriter {
    return this.walWriter;
  }

  /**
   * RAW remaining general budget, unclamped. Can be NEGATIVE when settled spend
   * has exceeded the total budget (an overdraft). ADR-0004 §5.3-3 requires that
   * overspend be observable and recorded rather than silently floored away.
   */
  private get rawGeneralRemainingMicros(): number {
    return this.generalTotalMicros - this.generalReservedMicros - this.generalSettledMicros;
  }

  /** RAW remaining verification reserve, unclamped. See {@link rawGeneralRemainingMicros}. */
  private get rawVerificationRemainingMicros(): number {
    return this.verificationTotalMicros - this.verificationReservedMicros - this.verificationSettledMicros;
  }

  /**
   * Current remaining general budget (total - reserved - settled).
   *
   * Clamped at 0: a pool cannot hand out negative credit, so `reserve` fails
   * closed. The overspend itself is NOT lost — it is recorded in
   * {@link generalOverdraftMicros} and surfaced through the conservation law.
   */
  get generalRemainingMicros(): number {
    return Math.max(0, this.rawGeneralRemainingMicros);
  }

  /**
   * Current remaining verification reserve (total - reserved - settled).
   * Clamped at 0 for the same reason as {@link generalRemainingMicros}.
   */
  get verificationRemainingMicros(): number {
    return Math.max(0, this.rawVerificationRemainingMicros);
  }

  /**
   * Observed overspend beyond the general budget, derived from current state.
   *
   * ADR-0004 §6.3 defines the conservation law as
   * `InitialBudget = Remaining + Reserved + Settled - TotalOverdraft`. Because
   * `Remaining` is clamped at 0, the overdraft is exactly the amount by which
   * `Reserved + Settled` exceeds `InitialBudget`. Deriving it (instead of
   * accumulating it at scattered call sites) is what keeps a crash-recovered
   * ledger consistent: WAL replay recomputes the pools, so the overspend is
   * reconstructed for free rather than requiring an extra persisted counter.
   */
  private get derivedGeneralOverdraftMicros(): number {
    return Math.max(0, -this.rawGeneralRemainingMicros);
  }

  /** Observed overspend beyond the verification reserve. See {@link derivedGeneralOverdraftMicros}. */
  private get derivedVerificationOverdraftMicros(): number {
    return Math.max(0, -this.rawVerificationRemainingMicros);
  }

  /**
   * Current available concurrency seats.
   */
  get availableSeats(): number {
    return Math.max(0, this.maxSeats - this.seatOwners.size);
  }

  /** Number of callIds currently owning a concurrency seat. */
  get occupiedSeatCount(): number {
    return this.seatOwners.size;
  }

  /**
   * Release the one seat owned by `callId`, clearing every representation of the
   * hold (active record flag, pending-remote handle, caller-deferred handle).
   *
   * Idempotent: returns true only when this call actually owned the seat, so a
   * stale call can never decrement another live call's capacity.
   */
  private releaseSeatOwnership(callId: string): boolean {
    const reservationId = this.callToReservation.get(callId);
    const record = reservationId === undefined ? undefined : this.activeReservations.get(reservationId);
    const hadOwner = this.seatOwners.delete(callId);
    const hadPending = this.seatsRetainedPendingRemote.delete(callId);
    const hadDeferred = this.seatsRetainedByCaller.delete(callId);
    if (record?.seatAcquired === true) {
      record.seatAcquired = false;
    }
    return hadOwner || hadPending || hadDeferred;
  }

  /**
   * Request a budget reservation and optionally acquire an exploration seat.
   * Fail-closed: returns granted=false without mutating state if budget or seats are insufficient.
   * Freezes rate card snapshot at reservation time per ADR-0004 §8.1.
   */
  reserve(request: ReserveRequest): ReserveResult {
    const { callId, pool, estimatedCostMicros, requiresSeat } = request;

    // 1. Check for duplicate active reservation or already-settled callId
    if (this.callToReservation.has(callId)) {
      return {
        granted: false,
        callId,
        pool,
        reservedCostMicros: 0,
        seatAcquired: false,
        rejectionReason: 'duplicate_active_call'
      };
    }

    if (this.settledCalls.has(callId)) {
      return {
        granted: false,
        callId,
        pool,
        reservedCostMicros: 0,
        seatAcquired: false,
        rejectionReason: 'call_already_settled'
      };
    }

    this.reserveAttempts += 1;

    // 2. Check seat availability if required
    //
    // P3-A2: observe mode NEVER denies for seats. It records
    // observedRejection='insufficient_seats' and proceeds seatless.
    //
    // PR-3B §7.4-2: at the CRITICAL watermark, general exploration concurrency is
    // halved. The verification pool is exempt so a run can still be judged after
    // the exploration budget is nearly exhausted.
    const needsSeat = requiresSeat ?? false;
    const observe = this.meteringMode === 'observe';
    let observedRejection: ReserveRejectionReason | undefined;
    // Observe mode is not throttled by enforcement-tier watermarks: its seat cap
    // is the real cap, so an observed denial reflects the true capacity rather
    // than a limit observe is not enforcing.
    const effectiveSeatCap = observe || pool === 'verification'
      ? this.maxSeats
      : this.getEffectiveSeatCap();
    if (needsSeat && this.seatOwners.size >= effectiveSeatCap) {
      if (effectiveSeatCap < this.maxSeats) {
        this.pushAlert(
          'critical-tier-throttled',
          `general concurrency throttled to ${effectiveSeatCap} of ${this.maxSeats} seats at the critical watermark`,
          { pool }
        );
      }
      if (observe) {
        observedRejection = 'insufficient_seats';
        this.pushAlert(
          'observe-seat-exceeded',
          `call "${callId}" would have been denied for seats (${this.seatOwners.size}/${effectiveSeatCap}); observe mode proceeds without a seat`,
          { pool, callId }
        );
      } else {
        return {
          granted: false,
          callId,
          pool,
          reservedCostMicros: 0,
          seatAcquired: false,
          rejectionReason: 'insufficient_seats'
        };
      }
    }

    // 2b. PR-3B §7.3: route admission. In hard mode an unbounded route is refused
    // outright (or admitted only under an explicit, ceiling-limited override); a
    // bounded route reserves the PHYSICAL CEILING, not an estimate.
    let boundAdmission: AdmissionDecision | undefined;
    if (!observe && this.admissionPolicy !== undefined) {
      boundAdmission = this.decideAdmissionFor({
        ...(request.routeId === undefined ? {} : { routeId: request.routeId }),
        ...(request.rateCard === undefined ? {} : { rateCard: request.rateCard }),
        estimatedCostMicros
      });
      if (!boundAdmission.admitted) {
        this.pushAlert(
          'unbounded-route-rejected',
          `route "${String(request.routeId ?? '<none>')}" refused: ${boundAdmission.reason} — ${boundAdmission.detail}`,
          { pool, callId }
        );
        return {
          granted: false,
          callId,
          pool,
          reservedCostMicros: 0,
          seatAcquired: false,
          rejectionReason: boundAdmission.reason as ReserveRejectionReason
        };
      }
      if (boundAdmission.unboundedRisk) {
        this.pushAlert(
          'unbounded-route-granted',
          `route "${String(request.routeId ?? '<none>')}" admitted as UNBOUNDED_RISK with a ` +
            `${boundAdmission.stopLossMicros}u stop-loss`,
          { pool, callId }
        );
      }
    }

    // 3. Check pool budget (isolated, no cross-borrowing per ADR-0003 §7.4 & ADR-0004 §4.2)
    //
    // PR-3B §7.3: under a provable hard bound the amount to ring-fence is the
    // PHYSICAL CEILING, not the caller's estimate. Reserving the estimate and
    // hoping is exactly the failure §7.1 documents (a runaway generation can bill
    // far past it). An explicit risk override ring-fences its stop-loss instead.
    const requiredMicros = observe
      ? 0
      : boundAdmission !== undefined && boundAdmission.admitted
        ? (boundAdmission.reserveMicros as number)
        : Math.max(0, estimatedCostMicros);
    if (observe) {
      // Observation: ring-fence NOTHING and deny NOTHING. The spend still books
      // at settle time, so the pool can report an overdraft (visible) without
      // ever changing the probe's control flow.
      const wouldExceed =
        pool === 'general'
          ? this.generalRemainingMicros < Math.max(0, estimatedCostMicros)
          : this.verificationRemainingMicros < Math.max(0, estimatedCostMicros);
      if (wouldExceed) {
        observedRejection =
          observedRejection ??
          (pool === 'general' ? 'insufficient_budget' : 'insufficient_verification_reserve');
        this.pushAlert(
          'observe-budget-exceeded',
          `call "${callId}" would have been denied for budget (${String(Math.max(0, estimatedCostMicros))}u requested); observe mode proceeds and books actual spend at settle`,
          { pool, callId }
        );
      }
    } else if (pool === 'general') {
      if (this.generalRemainingMicros < requiredMicros) {
        return {
          granted: false,
          callId,
          pool,
          reservedCostMicros: 0,
          seatAcquired: false,
          rejectionReason: 'insufficient_budget'
        };
      }
      this.generalReservedMicros += requiredMicros;
    } else if (pool === 'verification') {
      if (this.verificationRemainingMicros < requiredMicros) {
        return {
          granted: false,
          callId,
          pool,
          reservedCostMicros: 0,
          seatAcquired: false,
          rejectionReason: 'insufficient_verification_reserve'
        };
      }
      this.verificationReservedMicros += requiredMicros;
    }

    const seatAcquired = needsSeat && !observe;
    if (seatAcquired) {
      this.seatOwners.add(callId);
    }

    reservationSequence += 1;
    const reservationId = `res_${callId}_${Date.now()}_${reservationSequence}`;

    // Snapshot the effective rate card at reservation time (time-freezing principle ADR-0004 §8.1)
    const effectiveRateCard = request.rateCard ?? this.defaultRateCard;

    const record: ReservationRecord = {
      reservationId,
      callId,
      phase: request.phase,
      pool,
      reservedCostMicros: requiredMicros,
      seatAcquired,
      sessionId: request.sessionId,
      operationId: request.operationId,
      attempt: request.attempt,
      pricingIdentity: request.pricingIdentity,
      rateCard: effectiveRateCard,
      createdAt: Date.now(),
      state: 'active'
    };

    this.activeReservations.set(reservationId, record);
    this.callToReservation.set(callId, reservationId);

    this.walWriter.append('EVENT_RESERVED', {
      reservationId,
      callId,
      operationId: request.operationId,
      attempt: request.attempt,
      phase: request.phase,
      pool,
      reservedCostMicros: requiredMicros,
      seatAcquired,
      pricingIdentity: request.pricingIdentity,
      // Freeze the rate card in the WAL as well as in memory: replay must not
      // silently reprice a recovered reservation against today's default card.
      ...(effectiveRateCard === undefined ? {} : { rateCard: effectiveRateCard })
    });

    if (observe) {
      this.reserveGranted += 1;
      if (observedRejection !== undefined) {
        this.observedDenials += 1;
      }
    } else {
      this.reserveGranted += 1;
    }
    return {
      granted: true,
      reservationId,
      callId,
      pool,
      reservedCostMicros: requiredMicros,
      seatAcquired,
      ...(observe ? { observed: true } : {}),
      ...(observedRejection === undefined ? {} : { observedRejection })
    };
  }

  /**
   * Release a concurrency seat.
   *
   * Two situations require this:
   *   1. EARLY release while the call is still active (the original use);
   *   2. LATE release of a seat RETAINED because remote termination was not yet
   *      confirmed at settle time (ADR-0004 §5.1). Once the caller has
   *      independent evidence that the remote call ended, the retained seat must
   *      be recoverable — otherwise a cancelled call would hold a concurrency
   *      slot forever (t7 repair).
   */
  releaseSeat(callId: string): boolean {
    const reservationId = this.callToReservation.get(callId);
    const released = this.releaseSeatOwnership(callId);
    if (!released) {
      return false;
    }
    this.walWriter.append('EVENT_SEAT_RELEASED', {
      callId,
      ...(reservationId === undefined ? {} : { reservationId })
    });
    return true;
  }

  /** True when a seat is held for `callId` pending remote-termination confirmation. */
  isSeatRetainedPendingRemote(callId: string): boolean {
    return this.seatsRetainedPendingRemote.has(callId);
  }

  /**
   * Call ids whose seat is still held awaiting remote confirmation.
   * Exposed for the status report: these are NOT leaks, they are §5.1 holds.
   */
  getSeatsPendingRemote(): readonly string[] {
    return [...this.seatsRetainedPendingRemote.keys()];
  }

  /**
   * Settle an LLM call.
   *
   * Invariants:
   * 1. Idempotency: if callId is already settled, returns previous SettleResult with isIdempotentReplay=true.
   * 2. Unreserved check: settling an unreserved call throws UNRESERVED_CALL_SETTLE.
   * 3. Mismatch check: if reservationId does not match call's reservation, throws RESERVATION_ID_MISMATCH.
   * 4. Seat release != Amount refund:
   *    Seat is released (if held and releaseSeat !== false).
   *    Incurred cost is deducted; unspent reserved amount is refunded.
   *    If incurred >= reserved, refund is 0 even though seat is released!
   * 5. Non-zero conservative / audit-only:
   *    Cancelled / failed / timeout calls record incurred cost truthfully, but auditOnly=true, qualityEvidence=false.
   * 6. Rate card time-locking: Uses rateCard snapshotted at reserve() time if not overridden (ADR-0004 §8.1).
   * 7. Interim settlement: If interim=true, holds reserved funds pending reconciliation (ADR-0004 §5.3).
   */
  settle(request: SettleRequest): SettleResult {
    const { callId, reservationId, outcome, usage } = request;

    // 1. Idempotent replay check
    const existing = this.settledCalls.get(callId);
    if (existing) {
      return {
        ...existing,
        isIdempotentReplay: true
      };
    }
    this.settleCount += 1;

    // 2. Active reservation lookup
    const expectedResId = this.callToReservation.get(callId);
    if (!expectedResId) {
      throw new LedgerError(
        `No active reservation found for callId="${callId}". Calls must reserve budget before settlement.`,
        'UNRESERVED_CALL_SETTLE'
      );
    }

    if (expectedResId !== reservationId) {
      throw new LedgerError(
        `Reservation id mismatch for callId="${callId}": expected="${expectedResId}", received="${reservationId}".`,
        'RESERVATION_ID_MISMATCH'
      );
    }

    const reservation = this.activeReservations.get(reservationId);
    if (!reservation || (reservation.state !== 'active' && reservation.state !== 'interim_settled')) {
      throw new LedgerError(
        `Reservation "${reservationId}" is not in active state for settlement.`,
        'INVALID_SETTLEMENT_STATE'
      );
    }

    // 3. Compute incurred cost using the rate card SNAPSHOTTED AT RESERVATION TIME
    //
    // ADR-0004 §8.1 time-freeze: the rate card bound at reserve() is permanent for
    // this call. A rate-card update between reserve and settle must NOT change
    // what this call is charged, or every price change would retroactively rewrite
    // history and make settled figures unreconcilable against old invoices.
    //
    // The reservation snapshot therefore WINS over a card passed to settle(); the
    // caller-supplied card is only a fallback for records that never captured one
    // (e.g. replay of a legacy event). This ordering is the fix for a real defect:
    // it previously read `request.rateCard ?? reservation.rateCard`, so passing the
    // new card silently repriced a call that had already started.
    const effectiveRateCard = reservation.rateCard ?? request.rateCard ?? this.defaultRateCard;
    let costCalc: CostCalculation;

    if (request.actualCostMicros !== undefined) {
      const rawMicros = Math.max(0, request.actualCostMicros);
      const fallbackFloor = effectiveRateCard ? Math.max(1, effectiveRateCard.conservativeFallbackCostMicros) : 10_000;

      if (!usage) {
        // actualCostMicros provided without usage payload => cannot claim estimated; must be unknown and conservative
        const totalCostMicros = Math.max(rawMicros, fallbackFloor);
        const conservativeSurchargeMicros = totalCostMicros - rawMicros;
        costCalc = {
          totalCostMicros,
          breakdown: {
            netInputTokens: 0,
            inputCostMicros: rawMicros,
            cacheReadTokens: 0,
            cacheReadCostMicros: 0,
            cacheWriteTokens: 0,
            cacheWriteCostMicros: 0,
            netOutputTokens: 0,
            outputCostMicros: 0,
            reasoningTokens: 0,
            reasoningCostMicros: 0,
            conservativeSurchargeMicros: conservativeSurchargeMicros > 0 ? conservativeSurchargeMicros : undefined
          },
          provenance: 'unknown',
          conservative: true,
          auditNote:
            conservativeSurchargeMicros > 0
              ? `actualCostMicros=${rawMicros}u without usage; applied conservative floor ${fallbackFloor}u`
              : 'actualCostMicros provided without usage payload; marked provenance unknown'
        };
      } else {
        const semanticsDeclared = usage.countingSemantics !== undefined && usage.countingSemantics !== null;
        const metrics = [
          usage.inputTokens,
          usage.outputTokens,
          usage.cacheReadTokens,
          usage.cacheWriteTokens,
          usage.reasoningTokens
        ];
        const provenance = aggregatePrecision(metrics, semanticsDeclared);
        const isUnknown = provenance === 'unknown';
        const conservative = isUnknown;

        let totalCostMicros = rawMicros;
        let conservativeSurchargeMicros = 0;

        if (conservative) {
          if (rawMicros === 0 || rawMicros < fallbackFloor) {
            conservativeSurchargeMicros = fallbackFloor - rawMicros;
            totalCostMicros = fallbackFloor;
          }
        }

        costCalc = {
          totalCostMicros,
          breakdown: {
            netInputTokens: usage.inputTokens?.tokens ?? 0,
            inputCostMicros: rawMicros,
            cacheReadTokens: usage.cacheReadTokens?.tokens ?? 0,
            cacheReadCostMicros: 0,
            cacheWriteTokens: usage.cacheWriteTokens?.tokens ?? 0,
            cacheWriteCostMicros: 0,
            netOutputTokens: usage.outputTokens?.tokens ?? 0,
            outputCostMicros: 0,
            reasoningTokens: usage.reasoningTokens?.tokens ?? 0,
            reasoningCostMicros: 0,
            conservativeSurchargeMicros: conservativeSurchargeMicros > 0 ? conservativeSurchargeMicros : undefined
          },
          provenance,
          conservative,
          auditNote:
            conservativeSurchargeMicros > 0
              ? `actualCostMicros=${rawMicros}u with unknown usage; applied conservative floor ${fallbackFloor}u`
              : undefined
        };
      }
    } else if (usage && effectiveRateCard) {
      costCalc = calculateUsageCost(usage, effectiveRateCard);
    } else if (effectiveRateCard) {
      // Missing usage => conservative fallback ceiling
      costCalc = {
        totalCostMicros: effectiveRateCard.conservativeFallbackCostMicros,
        breakdown: {
          netInputTokens: 0,
          inputCostMicros: 0,
          cacheReadTokens: 0,
          cacheReadCostMicros: 0,
          cacheWriteTokens: 0,
          cacheWriteCostMicros: 0,
          netOutputTokens: 0,
          outputCostMicros: 0,
          reasoningTokens: 0,
          reasoningCostMicros: 0,
          conservativeSurchargeMicros: effectiveRateCard.conservativeFallbackCostMicros
        },
        provenance: 'unknown',
        conservative: true,
        auditNote: 'Usage payload omitted; applied conservative rate card ceiling'
      };
    } else {
      // Fallback: use reserved amount
      costCalc = {
        totalCostMicros: reservation.reservedCostMicros,
        breakdown: {
          netInputTokens: 0,
          inputCostMicros: reservation.reservedCostMicros,
          cacheReadTokens: 0,
          cacheReadCostMicros: 0,
          cacheWriteTokens: 0,
          cacheWriteCostMicros: 0,
          netOutputTokens: 0,
          outputCostMicros: 0,
          reasoningTokens: 0,
          reasoningCostMicros: 0
        },
        provenance: 'unknown',
        conservative: true,
        auditNote: 'No rate card or usage provided; settled at reserved upper bound'
      };
    }

    const incurredCostMicros = costCalc.totalCostMicros;
    const reservedCostMicros = reservation.reservedCostMicros;

    // Handle Interim vs Final Settlement
    const isInterim = request.interim === true;

    let amountRefundedMicros = 0;
    if (!isInterim) {
      amountRefundedMicros = Math.max(0, reservedCostMicros - incurredCostMicros);
      // Update Budget Pool
      if (reservation.pool === 'general') {
        this.generalReservedMicros = Math.max(0, this.generalReservedMicros - reservedCostMicros);
        this.generalSettledMicros += incurredCostMicros;
      } else {
        this.verificationReservedMicros = Math.max(0, this.verificationReservedMicros - reservedCostMicros);
        this.verificationSettledMicros += incurredCostMicros;
      }
    }

    // Seat Management: seatReleased != amountRefunded
    //
    // ADR-0004 §5.1 / B-4 (t7 repair): a seat may only be returned once the REMOTE
    // termination is confirmable. `Promise.race` deciding that we stop waiting is
    // NOT the provider stopping — the socket may still be streaming and billing.
    // Releasing the seat there lets a competing call take a slot that is still
    // occupied by a live request, which B-4 lists as a contract violation.
    //
    // The caller's `releaseSeat` can therefore DELAY a release but never force one:
    // an explicit `true` on a remote-unconfirmed outcome is still refused, because
    // a permission flag is not evidence that the provider stopped.
    const shouldReleaseSeat = request.releaseSeat ?? true;
    const remoteConfirmed = isRemoteTerminationConfirmed(outcome);
    const seatRetainedForRemote = reservation.seatAcquired && shouldReleaseSeat && !remoteConfirmed;
    const seatRetainedForCaller = reservation.seatAcquired && !shouldReleaseSeat;
    const seatReleased =
      reservation.seatAcquired && shouldReleaseSeat && remoteConfirmed
        ? this.releaseSeatOwnership(callId)
        : false;
    if (seatRetainedForRemote) {
      // Keep the OWNERSHIP SET unchanged (the call still owns the slot) and
      // record why. The handle is metadata; releasing just deletes the callId
      // from the set and this map, so a stale call can never free someone else.
      this.seatsRetainedPendingRemote.set(callId, reservationId);
      this.pushAlert(
        'seat-retained-pending-remote',
        `call "${callId}" stopped waiting locally but remote termination is unconfirmed; seat retained`,
        { pool: reservation.pool, callId }
      );
    } else if (seatRetainedForCaller) {
      this.seatsRetainedByCaller.add(callId);
    }

    // Record Event
    const effectiveUsage: ProviderUsagePayload = usage ?? {
      inputTokens: { tokens: 0, precision: 'unknown' },
      outputTokens: { tokens: 0, precision: 'unknown' }
    };

    const ledgerEvent = createUsageLedgerEvent({
      callId,
      reservationId,
      phase: reservation.phase,
      outcome,
      incurredCostMicros,
      usage: effectiveUsage,
      cost: costCalc,
      sessionId: request.sessionId ?? reservation.sessionId
    });

    this.ledgerEvents.push(ledgerEvent);

    if (isInterim) {
      reservation.state = 'interim_settled';
      reservation.incurredCostMicros = incurredCostMicros;
    } else {
      reservation.state = 'settled';
      reservation.incurredCostMicros = incurredCostMicros;
      this.activeReservations.delete(reservationId);
      this.callToReservation.delete(callId);
    }

    const result: SettleResult = {
      settled: true,
      callId,
      reservationId,
      pool: reservation.pool,
      incurredCostMicros,
      amountRefundedMicros,
      seatReleased,
      ...(seatRetainedForRemote ? { seatRetainedPendingRemote: true } : {}),
      ...(seatRetainedForCaller ? { seatRetainedByCaller: true } : {}),
      isIdempotentReplay: false,
      auditOnly: ledgerEvent.auditOnly,
      qualityEvidence: ledgerEvent.qualityEvidence,
      ledgerEvent,
      state: isInterim ? 'interim_settled' : 'settled'
    };

    // Store for idempotent replay
    this.settledCalls.set(callId, result);

    this.walWriter.append('EVENT_SETTLED', {
      callId,
      reservationId,
      outcome,
      incurredCostMicros,
      amountRefundedMicros,
      seatReleased,
      interim: isInterim,
      auditOnly: ledgerEvent.auditOnly,
      qualityEvidence: ledgerEvent.qualityEvidence,
      ...(seatRetainedForRemote ? { seatRetainedPendingRemote: true } : {}),
      ...(seatRetainedForCaller ? { seatRetainedByCaller: true } : {})
    });

    // PR-3B §7.4: emit watermark / freeze / overdraft alerts after the pools move.
    this.emitPoolAlerts(reservation.pool, callId);

    return result;
  }

  /**
   * Emit the §7.4 alerts implied by the CURRENT pool state.
   *
   * Alerts are derived from state, not accumulated per call, so the same state
   * cannot produce a different alert history depending on the order of unrelated
   * events. Only transitions that are still true are reported.
   */
  private emitPoolAlerts(pool: BudgetPoolType, callId: string): void {
    const status = this.getPoolLimitStatus();
    const relevant = pool === 'general' ? status.general : status.verification;
    if (relevant.overdraftMicros > 0) {
      this.pushAlert(
        'overdraft-observed',
        `${pool} pool overdrawn by ${relevant.overdraftMicros}u (settled spend exceeded the pool total)`,
        { pool, callId }
      );
    }
    if (relevant.tier === 'frozen') {
      this.pushAlert(
        'pool-frozen',
        `${pool} pool is frozen: ${relevant.committedMicros}u committed of ${relevant.totalMicros}u total; ` +
          'new work is refused and the system degrades to read-only audit',
        { pool, callId }
      );
    } else if (relevant.tier === 'critical') {
      this.pushAlert(
        'watermark-critical',
        `${pool} pool crossed the critical watermark (${relevant.committedMicros}u of ${relevant.totalMicros}u); ` +
          'general concurrency is halved',
        { pool, callId }
      );
    } else if (relevant.tier === 'warning') {
      this.pushAlert(
        'watermark-warning',
        `${pool} pool crossed the warning watermark (${relevant.committedMicros}u of ${relevant.totalMicros}u)`,
        { pool, callId }
      );
    }
  }

  /**
   * Reconcile late-arriving usage after an interim settlement or timeout/abort (ADR-0004 §5.3).
   * Calculates delta against previously reserved/settled cost and adjusts pool accordingly.
   */
  reconcileLateUsage(request: {
    callId: string;
    usage?: ProviderUsagePayload;
    actualCostMicros?: number;
    rateCard?: ModelRateCard;
    sessionId?: string;
  }): SettleResult {
    const { callId, usage } = request;
    const existing = this.settledCalls.get(callId);
    const reservationResId = this.callToReservation.get(callId);
    const reservation = reservationResId ? this.activeReservations.get(reservationResId) : undefined;

    if (!existing && !reservation) {
      throw new LedgerError(
        `No settlement or reservation found to reconcile for callId="${callId}".`,
        'CALL_NOT_FOUND'
      );
    }

    const reservationId = existing?.reservationId ?? reservation!.reservationId;
    const pool = reservation?.pool ?? existing!.pool;
    // A crash-recovered reservation is `pending_reconciliation`: its money is
    // still reserved and it has NO settled record. Treat it exactly like an
    // interim settlement for accounting, otherwise late usage adds the spend but
    // never releases the reservation, permanently locking the budget.
    const resolvingPending = reservation?.state === 'pending_reconciliation';
    const wasInterim =
      existing?.state === 'interim_settled' ||
      reservation?.state === 'interim_settled' ||
      resolvingPending;
    const reservedCost = wasInterim ? (reservation?.reservedCostMicros ?? 0) : 0;
    const previousIncurred = existing?.incurredCostMicros ?? 0;
    // ADR-0004 §8.1: the rate card frozen at reserve() time wins. A later card
    // passed to reconcile() must never reprice a call that already ran.
    const effectiveRateCard = reservation?.rateCard ?? request.rateCard ?? this.defaultRateCard;

    let newIncurredCost = 0;
    let costCalc: CostCalculation;

    if (request.actualCostMicros !== undefined) {
      const rawMicros = Math.max(0, request.actualCostMicros);
      const fallbackFloor = effectiveRateCard ? Math.max(1, effectiveRateCard.conservativeFallbackCostMicros) : 10_000;
      if (!usage) {
        // No usage payload => this is NOT a measured figure. Apply the same
        // conservative floor as settle(), so reconcile({actualCostMicros:0})
        // cannot silently erase a real incurred cost.
        newIncurredCost = Math.max(rawMicros, fallbackFloor);
        costCalc = {
          totalCostMicros: newIncurredCost,
          breakdown: {
            netInputTokens: 0,
            inputCostMicros: newIncurredCost,
            cacheReadTokens: 0,
            cacheReadCostMicros: 0,
            cacheWriteTokens: 0,
            cacheWriteCostMicros: 0,
            netOutputTokens: 0,
            outputCostMicros: 0,
            reasoningTokens: 0,
            reasoningCostMicros: 0,
            ...(newIncurredCost - rawMicros > 0
              ? { conservativeSurchargeMicros: newIncurredCost - rawMicros }
              : {})
          },
          provenance: 'unknown',
          conservative: true,
          auditNote: `reconcile actualCostMicros=${rawMicros}u without usage; applied conservative floor ${fallbackFloor}u`
        };
      } else {
        newIncurredCost = rawMicros;
        costCalc = {
          totalCostMicros: newIncurredCost,
          breakdown: {
            netInputTokens: 0,
            inputCostMicros: newIncurredCost,
            cacheReadTokens: 0,
            cacheReadCostMicros: 0,
            cacheWriteTokens: 0,
            cacheWriteCostMicros: 0,
            netOutputTokens: 0,
            outputCostMicros: 0,
            reasoningTokens: 0,
            reasoningCostMicros: 0
          },
          provenance: 'measured',
          conservative: false,
          auditNote: 'Reconciled actual cost directly specified with usage payload'
        };
      }
    } else if (usage && effectiveRateCard) {
      costCalc = calculateUsageCost(usage, effectiveRateCard);
      newIncurredCost = costCalc.totalCostMicros;
    } else {
      newIncurredCost = previousIncurred;
      costCalc = existing?.ledgerEvent?.cost ?? {
        totalCostMicros: newIncurredCost,
        breakdown: {
          netInputTokens: 0,
          inputCostMicros: newIncurredCost,
          cacheReadTokens: 0,
          cacheReadCostMicros: 0,
          cacheWriteTokens: 0,
          cacheWriteCostMicros: 0,
          netOutputTokens: 0,
          outputCostMicros: 0,
          reasoningTokens: 0,
          reasoningCostMicros: 0
        },
        provenance: 'unknown',
        conservative: true
      };
    }

    let amountRefundedMicros = 0;
    let delta = 0;

    if (wasInterim) {
      delta = newIncurredCost - reservedCost;
      if (pool === 'general') {
        this.generalReservedMicros = Math.max(0, this.generalReservedMicros - reservedCost);
        this.generalSettledMicros += newIncurredCost;
      } else {
        this.verificationReservedMicros = Math.max(0, this.verificationReservedMicros - reservedCost);
        this.verificationSettledMicros += newIncurredCost;
      }
      amountRefundedMicros = Math.max(0, -delta);
      if (reservation) {
        reservation.state = 'settled';
        reservation.incurredCostMicros = newIncurredCost;
        this.activeReservations.delete(reservationId);
        this.callToReservation.delete(callId);
      }
    } else {
      // Adjusting an already-settled record with later telemetry.
      delta = newIncurredCost - previousIncurred;
      if (delta !== 0) {
        if (pool === 'general') {
          this.generalSettledMicros += delta;
        } else {
          this.verificationSettledMicros += delta;
        }
      }
      amountRefundedMicros = existing?.amountRefundedMicros ?? 0;
    }

    if (delta > 0) {
      const overdraft =
        pool === 'general' ? this.derivedGeneralOverdraftMicros : this.derivedVerificationOverdraftMicros;
      if (overdraft > 0) {
        this.overdraftVariances.push({ callId, pool, overdraftMicros: overdraft, observedAt: Date.now() });
      }
    }

    const effectiveUsage: ProviderUsagePayload = usage ?? existing?.ledgerEvent?.usage ?? {
      inputTokens: { tokens: 0, precision: 'unknown' },
      outputTokens: { tokens: 0, precision: 'unknown' }
    };

    const reconciledEvent = createUsageLedgerEvent({
      callId,
      reservationId,
      phase: reservation?.phase ?? existing?.ledgerEvent?.phase ?? 'probe',
      outcome: existing?.ledgerEvent?.outcome ?? 'aborted_confirmed',
      incurredCostMicros: newIncurredCost,
      usage: effectiveUsage,
      cost: costCalc,
      sessionId: request.sessionId ?? reservation?.sessionId ?? existing?.ledgerEvent?.sessionId
    });

    this.ledgerEvents.push(reconciledEvent);

    // ADR-0004 §5.1/§5.3 (t7 repair): arriving late usage IS the remote
    // termination becoming confirmable, so the seat retained at interim
    // settlement is returned HERE. The previous implementation hardcoded
    // `seatReleased: true` without touching `occupiedSeats`, which both lied in
    // the report and leaked the seat forever (the record is deleted right below).
    // Late usage proves the remote call ended, so the single ownership primitive
    // releases exactly once and clears every metadata handle atomically.
    const seatReleased = this.releaseSeatOwnership(callId);
    if (seatReleased) {
      this.walWriter.append('EVENT_SEAT_RELEASED', {
        callId,
        reservationId,
        reason: 'late-usage-confirms-remote'
      });
    }

    const reconciledResult: SettleResult = {
      settled: true,
      callId,
      reservationId,
      pool,
      incurredCostMicros: newIncurredCost,
      amountRefundedMicros,
      seatReleased,
      isIdempotentReplay: false,
      auditOnly: reconciledEvent.auditOnly,
      qualityEvidence: reconciledEvent.qualityEvidence,
      ledgerEvent: reconciledEvent,
      state: 'settled'
    };

    this.settledCalls.set(callId, reconciledResult);

    this.walWriter.append('EVENT_RECONCILED', {
      callId,
      reservationId,
      pool,
      reservedCost,
      previousIncurred,
      newIncurredCost,
      amountRefundedMicros,
      wasInterim,
      auditOnly: reconciledEvent.auditOnly,
      qualityEvidence: reconciledEvent.qualityEvidence,
      seatReleased
    });

    // Same watermark/freeze/overdraft visibility as settle(): a reconciliation
    // that pushes a pool over budget must not be quieter than a normal settle.
    this.emitPoolAlerts(pool, callId);

    return reconciledResult;
  }

  /**
   * Total balance conservation check per ADR-0004 §6.3:
   * InitialBudget = RemainingBudget + ReservedBudget + SettledBudget - TotalOverdraft
   *
   * The overdraft term is DERIVED from pool state, so this check is a genuine
   * identity (it cannot be satisfied by a counter that merely agrees with
   * itself). A provable overspend is reported as `overdrawn` + an
   * `overdraftVarianceMicros`, NOT as a mismatch: ADR-0004 §5.3-3 requires the
   * ledger to record the variance and keep operating, and the actual lock-out
   * mechanism is `reserve()` failing closed once a pool is exhausted.
   *
   * A mismatch (a real accounting bug) still throws LedgerError and locks the
   * system.
   */
  verifyConservationLaw(): {
    balanced: boolean;
    generalDelta: number;
    verificationDelta: number;
    overdrawn: boolean;
    overdraftVarianceMicros: number;
  } {
    // Independent side of the identity: the pool counters must equal the SUM of
    // the live reservation records. The old check compared `remaining` and
    // `overdraft`, both derived from the same two counters, so it was a
    // tautology that stayed "balanced" even after a snapshot lost reservations.
    let recordedGeneralReserved = 0;
    let recordedVerificationReserved = 0;
    for (const record of this.activeReservations.values()) {
      if (record.state !== 'active' && record.state !== 'interim_settled' && record.state !== 'pending_reconciliation') {
        continue;
      }
      if (record.pool === 'general') {
        recordedGeneralReserved += record.reservedCostMicros;
      } else {
        recordedVerificationReserved += record.reservedCostMicros;
      }
    }
    if (recordedGeneralReserved !== this.generalReservedMicros) {
      throw new LedgerError(
        `Ledger reservation mismatch (general): pool=${this.generalReservedMicros}u, records=${recordedGeneralReserved}u`,
        'LEDGER_BALANCE_MISMATCH'
      );
    }
    if (recordedVerificationReserved !== this.verificationReservedMicros) {
      throw new LedgerError(
        `Ledger reservation mismatch (verification): pool=${this.verificationReservedMicros}u, records=${recordedVerificationReserved}u`,
        'LEDGER_BALANCE_MISMATCH'
      );
    }
    if (this.seatOwners.size > this.maxSeats) {
      throw new LedgerError(
        `Ledger seat ownership exceeds capacity: owners=${this.seatOwners.size}, max=${this.maxSeats}`,
        'LEDGER_BALANCE_MISMATCH'
      );
    }

    const generalCalculated =
      this.generalRemainingMicros +
      this.generalReservedMicros +
      this.generalSettledMicros -
      this.derivedGeneralOverdraftMicros;
    const generalDelta = this.generalTotalMicros - generalCalculated;

    const verificationCalculated =
      this.verificationRemainingMicros +
      this.verificationReservedMicros +
      this.verificationSettledMicros -
      this.derivedVerificationOverdraftMicros;
    const verificationDelta = this.verificationTotalMicros - verificationCalculated;

    const balanced = generalDelta === 0 && verificationDelta === 0;
    if (!balanced) {
      throw new LedgerError(
        `Ledger conservation law violated! generalDelta=${generalDelta}, verificationDelta=${verificationDelta}`,
        'LEDGER_BALANCE_MISMATCH'
      );
    }

    const overdraftVarianceMicros =
      this.derivedGeneralOverdraftMicros + this.derivedVerificationOverdraftMicros;

    return {
      balanced: true,
      generalDelta: 0,
      verificationDelta: 0,
      overdrawn: overdraftVarianceMicros > 0,
      overdraftVarianceMicros
    };
  }

  /**
   * Recorded overdraft variances (ADR-0004 §5.3-3), oldest first.
   * Empty when the ledger has never spent beyond an initial pool budget.
   */
  getOverdraftVariances(): readonly {
    callId: string;
    pool: BudgetPoolType;
    overdraftMicros: number;
    observedAt: number;
  }[] {
    return [...this.overdraftVariances];
  }

  /** Most recent observed overdraft variance in micros (0 when none). */
  get overdraftVarianceMicros(): number {
    return this.derivedGeneralOverdraftMicros + this.derivedVerificationOverdraftMicros;
  }

  /** True when settled spend has exceeded the total of any pool. */
  get isOverdrawn(): boolean {
    return this.overdraftVarianceMicros > 0;
  }

  /**
   * Recover ledger state from Write-Ahead Log (WAL) and snapshot (ADR-0004 §6.2).
   */
  recoverFromWal(): LedgerRecoveryReport {
    const events = this.walWriter.readAllEvents();
    const snapshot = this.walWriter.loadSnapshot();

    this.activeReservations.clear();
    this.callToReservation.clear();
    this.settledCalls.clear();
    this.seatsRetainedPendingRemote.clear();
    this.seatsRetainedByCaller.clear();
    this.seatOwners.clear();
    this.ledgerEvents = [];

    if (snapshot) {
      this.generalTotalMicros = snapshot.generalPool.totalMicros;
      this.generalReservedMicros = snapshot.generalPool.reservedMicros;
      this.generalSettledMicros = snapshot.generalPool.settledMicros;
      this.verificationTotalMicros = snapshot.verificationPool.totalMicros;
      this.verificationReservedMicros = snapshot.verificationPool.reservedMicros;
      this.verificationSettledMicros = snapshot.verificationPool.settledMicros;
      this.maxSeats = snapshot.maxSeats;
      // Restore in-flight reservations and seat identities. Snapshot pool totals
      // already include their reserved money, so they must NOT be added again.
      for (const record of snapshot.activeReservations ?? []) {
        this.activeReservations.set(record.reservationId, { ...record });
        this.callToReservation.set(record.callId, record.reservationId);
      }
      for (const callId of snapshot.seatOwners ?? []) {
        this.seatOwners.add(callId);
      }
      // A snapshot written by an older version has occupiedSeats but no
      // identities. Derive identities from the active records where possible;
      // if the count still disagrees, conservation will fail closed below
      // instead of silently dropping seats.
      if (snapshot.seatOwners === undefined) {
        for (const record of this.activeReservations.values()) {
          if (record.seatAcquired) {
            this.seatOwners.add(record.callId);
          }
        }
      }
    } else {
      this.generalReservedMicros = 0;
      this.generalSettledMicros = 0;
      this.verificationReservedMicros = 0;
      this.verificationSettledMicros = 0;
    }

    const snapshotSeq = snapshot?.lastSequenceNumber ?? 0;
    const eventsToReplay = events.filter((e) => e.sequenceNumber > snapshotSeq);

    for (const ev of eventsToReplay) {
      switch (ev.type) {
        case 'EVENT_RESERVED': {
          const payload = ev.payload as any;
          const record: ReservationRecord = {
            reservationId: payload.reservationId,
            callId: payload.callId,
            operationId: payload.operationId,
            attempt: payload.attempt,
            phase: payload.phase,
            pool: payload.pool,
            reservedCostMicros: payload.reservedCostMicros,
            seatAcquired: payload.seatAcquired,
            sessionId: payload.sessionId,
            createdAt: ev.timestamp,
            state: 'active',
            pricingIdentity: payload.pricingIdentity,
            ...(payload.rateCard === undefined ? {} : { rateCard: payload.rateCard })
          };
          this.activeReservations.set(payload.reservationId, record);
          this.callToReservation.set(payload.callId, payload.reservationId);
          if (payload.pool === 'general') {
            this.generalReservedMicros += payload.reservedCostMicros;
          } else {
            this.verificationReservedMicros += payload.reservedCostMicros;
          }
          if (payload.seatAcquired) {
            this.seatOwners.add(payload.callId);
          }
          break;
        }
        case 'EVENT_SEAT_RELEASED': {
          const payload = ev.payload as any;
          this.releaseSeatOwnership(payload.callId);
          break;
        }
        case 'EVENT_SETTLED': {
          const payload = ev.payload as any;
          const record = this.activeReservations.get(payload.reservationId);
          const pool = record?.pool ?? 'general';
          const reservedCost = record?.reservedCostMicros ?? 0;
          const incurred = payload.incurredCostMicros ?? 0;
          const isInterim = payload.interim === true;

          if (isInterim) {
            if (record) {
              record.state = 'interim_settled';
              record.incurredCostMicros = incurred;
            }
          } else {
            if (pool === 'general') {
              this.generalReservedMicros = Math.max(0, this.generalReservedMicros - reservedCost);
              this.generalSettledMicros += incurred;
            } else {
              this.verificationReservedMicros = Math.max(0, this.verificationReservedMicros - reservedCost);
              this.verificationSettledMicros += incurred;
            }
            if (record) {
              record.state = 'settled';
              this.activeReservations.delete(payload.reservationId);
              this.callToReservation.delete(payload.callId);
            }
          }
          if (payload.seatReleased) {
            this.seatOwners.delete(payload.callId);
            this.seatsRetainedPendingRemote.delete(payload.callId);
            this.seatsRetainedByCaller.delete(payload.callId);
          } else if (payload.seatRetainedPendingRemote === true) {
            // Reconstruct the §5.1 hold: the seat was retained at settle time
            // because remote termination was unconfirmed. Replay must rebuild
            // the handle or the recovered ledger would hold an unreleasable
            // seat (t7 repair).
            this.seatsRetainedPendingRemote.set(payload.callId, payload.reservationId);
          } else if (payload.seatRetainedByCaller === true) {
            // Rebuild a caller-deferred seat handle too. Without this, a
            // restart would silently convert the caller's deferred release into
            // a permanent leak (the reservation record is gone).
            this.seatsRetainedByCaller.add(payload.callId);
          }

          this.settledCalls.set(payload.callId, {
            settled: true,
            callId: payload.callId,
            reservationId: payload.reservationId,
            pool,
            incurredCostMicros: incurred,
            amountRefundedMicros: payload.amountRefundedMicros ?? 0,
            seatReleased: payload.seatReleased ?? false,
            isIdempotentReplay: false,
            // Preserve the original audit/quality flags. Hardcoding true/false
            // here used to turn a successful call audit-only after a restart.
            auditOnly: payload.auditOnly === true,
            qualityEvidence: payload.qualityEvidence === true,
            state: isInterim ? 'interim_settled' : 'settled'
          });
          break;
        }
        case 'EVENT_RECONCILED': {
          const payload = ev.payload as any;
          const record = this.activeReservations.get(payload.reservationId);
          const pool = payload.pool ?? record?.pool ?? 'general';
          const reservedCost = payload.reservedCost ?? record?.reservedCostMicros ?? 0;
          const previousIncurred = payload.previousIncurred ?? this.settledCalls.get(payload.callId)?.incurredCostMicros ?? 0;
          const newIncurredCost = payload.newIncurredCost ?? 0;
          if (payload.wasInterim === true) {
            // Mirror the live interim reconciliation exactly: release the
            // reservation buffer, book the true incurred amount.
            if (pool === 'general') {
              this.generalReservedMicros = Math.max(0, this.generalReservedMicros - reservedCost);
              this.generalSettledMicros += newIncurredCost;
            } else {
              this.verificationReservedMicros = Math.max(0, this.verificationReservedMicros - reservedCost);
              this.verificationSettledMicros += newIncurredCost;
            }
          } else {
            const delta = newIncurredCost - previousIncurred;
            if (delta !== 0) {
              if (pool === 'general') {
                this.generalSettledMicros += delta;
              } else {
                this.verificationSettledMicros += delta;
              }
            }
          }
          if (record) {
            record.state = 'settled';
            record.incurredCostMicros = newIncurredCost;
            this.activeReservations.delete(payload.reservationId);
            this.callToReservation.delete(payload.callId);
          }
          // Late usage proves remote termination: the seat ownership is gone.
          this.releaseSeatOwnership(payload.callId);
          const existing = this.settledCalls.get(payload.callId);
          const settled: SettleResult =
            existing ?? {
              settled: true,
              callId: payload.callId,
              reservationId: payload.reservationId,
              pool,
              incurredCostMicros: newIncurredCost,
              amountRefundedMicros: payload.amountRefundedMicros ?? 0,
              seatReleased: payload.seatReleased === true,
              isIdempotentReplay: false,
              auditOnly: payload.auditOnly === true,
              qualityEvidence: payload.qualityEvidence === true,
              state: 'settled'
            };
          settled.incurredCostMicros = newIncurredCost;
          settled.amountRefundedMicros = payload.amountRefundedMicros ?? settled.amountRefundedMicros;
          settled.state = 'settled';
          this.settledCalls.set(payload.callId, settled);
          break;
        }
        case 'EVENT_CRASH_RECOVERED': {
          const payload = ev.payload as any;
          const record = this.activeReservations.get(payload.reservationId);
          if (record) {
            record.state = 'pending_reconciliation';
            // Cost stays UNKNOWN (never assumed 0) — kept identical to the
            // step-4 scan so a repeated recovery yields the same record shape.
            record.incurredCostMicros = null;
            // ADR-0004 §5.1/§6.2: a crash is NOT proof that the remote provider
            // stopped generating. Keep the risk seat held. Repeated recovery is
            // idempotent because this record stays `pending_reconciliation` and
            // the step-4 dangling scan skips it; the seat can later be released
            // through `releaseSeat(callId)` once termination is evidenced.
          }
          break;
        }
      }
    }

    // The fresh writer starts its sequence at 0. Without flooring it to the
    // recovered high-water mark, the next append would reuse 1..N and a later
    // replay would filter those events out as "older than the snapshot".
    const replayedHighWater = events.reduce(
      (max, event) => (event.sequenceNumber > max ? event.sequenceNumber : max),
      snapshotSeq
    );
    this.walWriter.ensureSequenceAtLeast(replayedHighWater);

    // Step 4: Scan and recover dangling active reservations per ADR-0004 §6.2
    const danglingCallIds: string[] = [];
    for (const [resId, record] of this.activeReservations.entries()) {
      if (record.state === 'active' || record.state === 'interim_settled') {
        record.state = 'pending_reconciliation';
        record.incurredCostMicros = null;
        danglingCallIds.push(record.callId);
        this.pushAlert(
          'call-unresolved-after-window',
          `call "${record.callId}" was interrupted by a crash; cost is unknown and the risk seat is retained until reconciled`,
          { pool: record.pool, callId: record.callId }
        );

        // Keep the risk seat: a process crash does not prove the provider
        // stopped generating, so releasing the concurrency slot here could
        // under-count live billing. It remains recoverable via releaseSeat()
        // after a confirmed terminal state or external reconciliation.

        this.walWriter.append('EVENT_CRASH_RECOVERED', {
          reservationId: resId,
          callId: record.callId,
          state: 'pending_reconciliation',
          outcome: 'interrupted_by_crash',
          auditOnly: true,
          qualityEvidence: false,
          reservedCostMicros: record.reservedCostMicros
        });
      }
    }

    // Step 5: Conservation law verification
    this.verifyConservationLaw();

    return {
      replayedEventsCount: eventsToReplay.length,
      recoveredDanglingCount: danglingCallIds.length,
      recoveredCallIds: danglingCallIds,
      generalPoolRemainingMicros: this.generalRemainingMicros,
      verificationPoolRemainingMicros: this.verificationRemainingMicros,
      occupiedSeats: this.seatOwners.size,
      balanceBalanced: true
    };
  }

  saveSnapshot(): LedgerSnapshotData {
    return this.walWriter.writeSnapshot({
      generalPool: this.getBudgetStatus().generalPool,
      verificationPool: this.getBudgetStatus().verificationPool,
      occupiedSeats: this.seatOwners.size,
      maxSeats: this.maxSeats,
      activeReservations: [...this.activeReservations.values()],
      seatOwners: [...this.seatOwners]
    });
  }

  /**
   * Get current budget status snapshot.
   */
  getBudgetStatus(): LedgerBudgetStatus {
    return {
      generalPool: {
        totalMicros: this.generalTotalMicros,
        reservedMicros: this.generalReservedMicros,
        settledMicros: this.generalSettledMicros,
        remainingMicros: this.generalRemainingMicros,
        overdraftMicros: this.derivedGeneralOverdraftMicros
      },
      verificationPool: {
        totalMicros: this.verificationTotalMicros,
        reservedMicros: this.verificationReservedMicros,
        settledMicros: this.verificationSettledMicros,
        remainingMicros: this.verificationRemainingMicros,
        overdraftMicros: this.derivedVerificationOverdraftMicros
      },
      seats: {
        total: this.maxSeats,
        occupied: this.seatOwners.size,
        available: this.availableSeats
      }
    };
  }

  /**
   * Query an active reservation by reservationId.
   */
  getReservation(reservationId: string): ReservationRecord | undefined {
    return this.activeReservations.get(reservationId);
  }

  /**
   * Query an active reservation by callId.
   */
  getReservationByCallId(callId: string): ReservationRecord | undefined {
    const reservationId = this.callToReservation.get(callId);
    return reservationId ? this.activeReservations.get(reservationId) : undefined;
  }

  /**
   * Query a settled result by callId.
   */
  getSettledResult(callId: string): SettleResult | undefined {
    return this.settledCalls.get(callId);
  }

  /** P3-A2: observe or enforce; never inferred from any other permission switch. */
  getMeteringMode(): LedgerMeteringMode {
    return this.meteringMode;
  }

  /**
   * P3-A2: ledger-side metering status.
   *
   * "Ledger assembled but ZERO calls so far" (reserveAttempts=0) and "ledger
   * with calls whose provenance is unknown" are both visible here, so a cost
   * report can never conflate "0 calls" with "no metering" or "measured".
   */
  getMeteringStatus(): LedgerMeteringStatus {
    const accounting = summarizeUsageAccounting(this.ledgerEvents);
    return {
      mode: this.meteringMode,
      metered: true,
      reserveAttempts: this.reserveAttempts,
      reserveGranted: this.reserveGranted,
      observedDenials: this.observedDenials,
      settleCount: this.settleCount,
      measuredCalls: accounting.measured.calls,
      estimatedCalls: accounting.estimated.calls,
      unknownCalls: accounting.unknown.calls,
      totalCostMicros: accounting.totalCostMicros
    };
  }

  /** P3-C: measured/estimated/unknown accounting over the recorded events. */
  getUsageAccounting(): UsageAccountingReport {
    return summarizeUsageAccounting(this.ledgerEvents);
  }

  /**
   * Retrieve all recorded usage ledger events.
   */
  getLedgerEvents(): readonly UsageLedgerEvent[] {
    return this.ledgerEvents;
  }
}
