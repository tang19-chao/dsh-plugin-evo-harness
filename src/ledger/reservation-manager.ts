/**
 * Ledger Reservation & Settlement Manager.
 *
 * Implements ADR-0003 §7.4:
 * - Concurrency: unique reservationId per callId; concurrent calls do not overwrite each other.
 * - Idempotency: duplicate settle on the same callId returns initial result without double deduction.
 * - Shared general budget: fail-closed rejection on depletion, no overdraft.
 * - Dedicated verification reserve: strictly isolated from general exploration budget.
 * - Concurrency seats: exploration seat release != amount refunded.
 * - Lifecycle validation: reserve -> settle -> releaseSeat.
 */

import { aggregatePrecision, calculateUsageCost } from './pricing.js';
import { createUsageLedgerEvent } from './ledger-event.js';
import {
  BudgetPoolType,
  CostCalculation,
  LedgerBudgetConfig,
  LedgerBudgetStatus,
  ModelRateCard,
  ProviderUsagePayload,
  ReservationRecord,
  ReserveRequest,
  ReserveResult,
  SettleRequest,
  SettleResult,
  UsageLedgerEvent
} from './types.js';

export class LedgerError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'UNRESERVED_CALL_SETTLE'
      | 'RESERVATION_ID_MISMATCH'
      | 'DUPLICATE_ACTIVE_RESERVATION'
      | 'SEAT_ALREADY_RELEASED'
      | 'INVALID_SETTLEMENT_STATE'
  ) {
    super(`[LedgerError:${code}] ${message}`);
    this.name = 'LedgerError';
  }
}

let reservationSequence = 0;

export class LedgerReservationManager {
  private generalTotalMicros: number;
  private generalReservedMicros = 0;
  private generalSettledMicros = 0;

  private verificationTotalMicros: number;
  private verificationReservedMicros = 0;
  private verificationSettledMicros = 0;

  private maxSeats: number;
  private occupiedSeats = 0;

  private defaultRateCard?: ModelRateCard;

  /** Active reservations mapped by reservationId */
  private activeReservations = new Map<string, ReservationRecord>();

  /** Map callId -> reservationId for active reservations */
  private callToReservation = new Map<string, string>();

  /** Idempotent settlement records mapped by callId */
  private settledCalls = new Map<string, SettleResult>();

  /** Historical ledger events recorded upon settlement */
  private ledgerEvents: UsageLedgerEvent[] = [];

  constructor(config: LedgerBudgetConfig) {
    this.generalTotalMicros = Math.max(0, config.generalBudgetMicros);
    this.verificationTotalMicros = Math.max(0, config.verificationReserveMicros);
    this.maxSeats = Math.max(0, config.maxConcurrencySeats);
    this.defaultRateCard = config.defaultRateCard;
  }

  /**
   * Current remaining general budget (total - reserved - settled).
   */
  get generalRemainingMicros(): number {
    return Math.max(0, this.generalTotalMicros - this.generalReservedMicros - this.generalSettledMicros);
  }

  /**
   * Current remaining verification reserve (total - reserved - settled).
   */
  get verificationRemainingMicros(): number {
    return Math.max(0, this.verificationTotalMicros - this.verificationReservedMicros - this.verificationSettledMicros);
  }

  /**
   * Current available concurrency seats.
   */
  get availableSeats(): number {
    return Math.max(0, this.maxSeats - this.occupiedSeats);
  }

  /**
   * Request a budget reservation and optionally acquire an exploration seat.
   * Fail-closed: returns granted=false without mutating state if budget or seats are insufficient.
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

    // 2. Check seat availability if required
    const needsSeat = requiresSeat ?? false;
    if (needsSeat && this.occupiedSeats >= this.maxSeats) {
      return {
        granted: false,
        callId,
        pool,
        reservedCostMicros: 0,
        seatAcquired: false,
        rejectionReason: 'insufficient_seats'
      };
    }

    // 3. Check pool budget (isolated, no cross-borrowing per ADR-0003 §7.4)
    const requiredMicros = Math.max(0, estimatedCostMicros);
    if (pool === 'general') {
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

    if (needsSeat) {
      this.occupiedSeats += 1;
    }

    reservationSequence += 1;
    const reservationId = `res_${callId}_${Date.now()}_${reservationSequence}`;

    const record: ReservationRecord = {
      reservationId,
      callId,
      phase: request.phase,
      pool,
      reservedCostMicros: requiredMicros,
      seatAcquired: needsSeat,
      sessionId: request.sessionId,
      createdAt: Date.now(),
      state: 'active'
    };

    this.activeReservations.set(reservationId, record);
    this.callToReservation.set(callId, reservationId);

    return {
      granted: true,
      reservationId,
      callId,
      pool,
      reservedCostMicros: requiredMicros,
      seatAcquired: needsSeat
    };
  }

  /**
   * Release concurrency seat early before final monetary settlement (optional lifecycle step).
   */
  releaseSeat(callId: string): boolean {
    const reservationId = this.callToReservation.get(callId);
    if (!reservationId) {
      return false;
    }
    const record = this.activeReservations.get(reservationId);
    if (!record || !record.seatAcquired) {
      return false;
    }

    record.seatAcquired = false;
    this.occupiedSeats = Math.max(0, this.occupiedSeats - 1);
    return true;
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
   */
  settle(request: SettleRequest): SettleResult {
    const { callId, reservationId, outcome, usage, rateCard } = request;

    // 1. Idempotent replay check
    const existing = this.settledCalls.get(callId);
    if (existing) {
      return {
        ...existing,
        isIdempotentReplay: true
      };
    }

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
    if (!reservation || reservation.state !== 'active') {
      throw new LedgerError(
        `Reservation "${reservationId}" is not in active state for settlement.`,
        'INVALID_SETTLEMENT_STATE'
      );
    }

    // 3. Compute incurred cost
    const effectiveRateCard = rateCard ?? this.defaultRateCard;
    let costCalc: CostCalculation;

    if (request.actualCostMicros !== undefined) {
      const rawMicros = Math.max(0, request.actualCostMicros);
      const fallbackFloor = effectiveRateCard ? Math.max(1, effectiveRateCard.conservativeFallbackCostMicros) : 10_000;

      if (!usage) {
        // actualCostMicros provided without usage payload => cannot claim estimated; must be unknown and conservative (ADR-0003 §7.3.5)
        // If rawMicros < fallbackFloor (including 0), enforce conservative floor (t11 F-1)
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

    // Refund unspent amount back to pool: Math.max(0, reserved - incurred)
    const amountRefundedMicros = Math.max(0, reservedCostMicros - incurredCostMicros);

    // 4. Update Budget Pool
    if (reservation.pool === 'general') {
      this.generalReservedMicros = Math.max(0, this.generalReservedMicros - reservedCostMicros);
      this.generalSettledMicros += incurredCostMicros;
    } else {
      this.verificationReservedMicros = Math.max(0, this.verificationReservedMicros - reservedCostMicros);
      this.verificationSettledMicros += incurredCostMicros;
    }

    // 5. Seat Management: seatReleased != amountRefunded
    let seatReleased = false;
    const shouldReleaseSeat = request.releaseSeat ?? true;
    if (reservation.seatAcquired && shouldReleaseSeat) {
      reservation.seatAcquired = false;
      this.occupiedSeats = Math.max(0, this.occupiedSeats - 1);
      seatReleased = true;
    }

    // 6. Record Event
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

    // 7. Cleanup active reservation state
    reservation.state = 'settled';
    this.activeReservations.delete(reservationId);
    this.callToReservation.delete(callId);

    const result: SettleResult = {
      settled: true,
      callId,
      reservationId,
      pool: reservation.pool,
      incurredCostMicros,
      amountRefundedMicros,
      seatReleased,
      isIdempotentReplay: false,
      auditOnly: ledgerEvent.auditOnly,
      qualityEvidence: ledgerEvent.qualityEvidence,
      ledgerEvent
    };

    // Store for idempotent replay
    this.settledCalls.set(callId, result);

    return result;
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
        remainingMicros: this.generalRemainingMicros
      },
      verificationPool: {
        totalMicros: this.verificationTotalMicros,
        reservedMicros: this.verificationReservedMicros,
        settledMicros: this.verificationSettledMicros,
        remainingMicros: this.verificationRemainingMicros
      },
      seats: {
        total: this.maxSeats,
        occupied: this.occupiedSeats,
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

  /**
   * Retrieve all recorded usage ledger events.
   */
  getLedgerEvents(): readonly UsageLedgerEvent[] {
    return this.ledgerEvents;
  }
}
