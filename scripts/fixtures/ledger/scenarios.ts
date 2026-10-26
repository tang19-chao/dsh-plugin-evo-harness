/**
 * Offline Deterministic Ledger Scenarios.
 *
 * Implements ADR-0003 §7.5:
 * 1. Duplicate billing (pricing the same callId twice)
 * 2. Double settle / secondary deduction (settle called twice with same callId)
 * 3. Unknown usage with conservative non-zero upper bound
 * 4. Cancelled settlement with incurred spend, seat released, and audit-only flag
 * 5. Complete 6-phase sequence (probe -> reference -> compose -> reflect -> judge -> dream)
 *
 * Zero network calls, zero paid models, strictly deterministic synthetic numbers.
 */

import { calculateUsageCost } from '../../../src/ledger/pricing.js';
import { LedgerReservationManager } from '../../../src/ledger/reservation-manager.js';
import {
  CostCalculation,
  LedgerBudgetStatus,
  LedgerPhase,
  ProviderUsagePayload,
  ReserveResult,
  SettleResult,
  UsageLedgerEvent
} from '../../../src/ledger/types.js';
import {
  DEEPSEEK_STYLE_RATE_CARD,
  OPENAI_STYLE_RATE_CARD
} from './sample-rate-cards.js';
import {
  CANCELLED_INCURRED_USAGE_PAYLOAD,
  COMPOSE_USAGE_PAYLOAD,
  DREAM_USAGE_PAYLOAD,
  JUDGE_USAGE_PAYLOAD,
  PROBE_USAGE_PAYLOAD,
  REFERENCE_USAGE_PAYLOAD,
  REFLECT_USAGE_PAYLOAD,
  UNKNOWN_USAGE_PAYLOAD
} from './synthetic-payloads.js';

export interface DuplicateBillingResult {
  firstCalculation: CostCalculation;
  secondCalculation: CostCalculation;
  identical: boolean;
}

/**
 * Scenario 1: Duplicate Billing (pricing the same call / payload twice).
 * Verifies that re-evaluating identical inputs yields bitwise identical results.
 */
export function runDuplicateBillingScenario(): DuplicateBillingResult {
  const payload = REFLECT_USAGE_PAYLOAD;
  const rateCard = DEEPSEEK_STYLE_RATE_CARD;

  const firstCalculation = calculateUsageCost(payload, rateCard);
  const secondCalculation = calculateUsageCost(payload, rateCard);

  const identical =
    firstCalculation.totalCostMicros === secondCalculation.totalCostMicros &&
    firstCalculation.provenance === secondCalculation.provenance &&
    firstCalculation.breakdown.netInputTokens === secondCalculation.breakdown.netInputTokens &&
    firstCalculation.breakdown.reasoningCostMicros === secondCalculation.breakdown.reasoningCostMicros;

  return {
    firstCalculation,
    secondCalculation,
    identical
  };
}

export interface DoubleSettleResult {
  firstSettle: SettleResult;
  secondSettle: SettleResult;
  budgetStatusAfterFirst: LedgerBudgetStatus;
  budgetStatusAfterSecond: LedgerBudgetStatus;
  noSecondaryDeduction: boolean;
}

/**
 * Scenario 2: Double Settle (settling the same callId twice).
 * Verifies that the second settle is an idempotent replay with NO secondary deduction.
 */
export function runDoubleSettleScenario(
  manager: LedgerReservationManager
): DoubleSettleResult {
  const callId = `double_settle_call_${Date.now()}`;
  const reserveRes = manager.reserve({
    callId,
    phase: 'compose',
    pool: 'general',
    estimatedCostMicros: 20_000,
    requiresSeat: true
  });

  if (!reserveRes.granted || !reserveRes.reservationId) {
    throw new Error('Failed to grant initial reservation in double settle scenario');
  }

  // First settlement
  const firstSettle = manager.settle({
    callId,
    reservationId: reserveRes.reservationId,
    outcome: 'succeeded',
    actualCostMicros: 12_000,
    releaseSeat: true
  });

  const budgetStatusAfterFirst = manager.getBudgetStatus();

  // Second settlement (same callId and reservationId)
  const secondSettle = manager.settle({
    callId,
    reservationId: reserveRes.reservationId,
    outcome: 'succeeded',
    actualCostMicros: 12_000,
    releaseSeat: true
  });

  const budgetStatusAfterSecond = manager.getBudgetStatus();

  // Assert that general pool remaining budget did not decrease upon the second settle!
  const noSecondaryDeduction =
    secondSettle.isIdempotentReplay === true &&
    budgetStatusAfterFirst.generalPool.settledMicros ===
      budgetStatusAfterSecond.generalPool.settledMicros &&
    budgetStatusAfterFirst.generalPool.remainingMicros ===
      budgetStatusAfterSecond.generalPool.remainingMicros;

  return {
    firstSettle,
    secondSettle,
    budgetStatusAfterFirst,
    budgetStatusAfterSecond,
    noSecondaryDeduction
  };
}

export interface UnknownUsageResult {
  reserveResult: ReserveResult;
  settleResult: SettleResult;
  costCalculation: CostCalculation;
  isStrictlyNonZeroConservative: boolean;
}

/**
 * Scenario 3: Unknown Usage with Conservative Upper Bound.
 * Verifies that unknown semantics and precision result in a non-zero conservative charge.
 */
export function runUnknownUsageScenario(
  manager: LedgerReservationManager
): UnknownUsageResult {
  const callId = `unknown_usage_call_${Date.now()}`;
  const rateCard = OPENAI_STYLE_RATE_CARD;

  const reserveResult = manager.reserve({
    callId,
    phase: 'probe',
    pool: 'general',
    estimatedCostMicros: 15_000,
    requiresSeat: false
  });

  if (!reserveResult.granted || !reserveResult.reservationId) {
    throw new Error('Failed to reserve for unknown usage scenario');
  }

  const costCalculation = calculateUsageCost(UNKNOWN_USAGE_PAYLOAD, rateCard);

  const settleResult = manager.settle({
    callId,
    reservationId: reserveResult.reservationId,
    outcome: 'succeeded',
    usage: UNKNOWN_USAGE_PAYLOAD,
    rateCard,
    releaseSeat: false
  });

  const isStrictlyNonZeroConservative =
    settleResult.incurredCostMicros > 0 &&
    costCalculation.totalCostMicros > 0 &&
    costCalculation.conservative === true &&
    costCalculation.provenance === 'unknown';

  return {
    reserveResult,
    settleResult,
    costCalculation,
    isStrictlyNonZeroConservative
  };
}

export interface CancelledIncurredResult {
  reserveResult: ReserveResult;
  settleResult: SettleResult;
  seatReleased: boolean;
  amountRefundedMicros: number;
  incurredCostMicros: number;
  auditOnly: boolean;
  qualityEvidence: boolean;
}

/**
 * Scenario 4: Cancelled Settlement with Incurred Spend.
 * Verifies that a cancelled call deducts incurred spend, releases seat,
 * but sets auditOnly=true and qualityEvidence=false.
 */
export function runCancelledIncurredScenario(
  manager: LedgerReservationManager
): CancelledIncurredResult {
  const callId = `cancelled_call_${Date.now()}`;
  const reserveResult = manager.reserve({
    callId,
    phase: 'dream',
    pool: 'general',
    estimatedCostMicros: 30_000,
    requiresSeat: true
  });

  if (!reserveResult.granted || !reserveResult.reservationId) {
    throw new Error('Failed to reserve for cancelled incurred scenario');
  }

  const settleResult = manager.settle({
    callId,
    reservationId: reserveResult.reservationId,
    outcome: 'cancelled',
    usage: CANCELLED_INCURRED_USAGE_PAYLOAD,
    rateCard: OPENAI_STYLE_RATE_CARD,
    releaseSeat: true
  });

  return {
    reserveResult,
    settleResult,
    seatReleased: settleResult.seatReleased,
    amountRefundedMicros: settleResult.amountRefundedMicros,
    incurredCostMicros: settleResult.incurredCostMicros,
    auditOnly: settleResult.auditOnly,
    qualityEvidence: settleResult.qualityEvidence
  };
}

export interface PhaseStepRecord {
  phase: LedgerPhase;
  callId: string;
  reservedCost: number;
  incurredCost: number;
  amountRefunded: number;
  pool: 'general' | 'verification';
  event?: UsageLedgerEvent;
}

export interface AllPhasesWorkflowResult {
  steps: PhaseStepRecord[];
  finalBudgetStatus: LedgerBudgetStatus;
  allPhasesCompleted: boolean;
}

/**
 * Scenario 5: Full 6-Phase Lifecycle Sequence.
 * Sequences probe -> reference -> compose -> reflect -> judge -> dream.
 */
export function runAllPhasesWorkflowScenario(
  manager: LedgerReservationManager
): AllPhasesWorkflowResult {
  const phasesConfig: Array<{
    phase: LedgerPhase;
    payload: ProviderUsagePayload;
    pool: 'general' | 'verification';
    estimatedCost: number;
    requiresSeat: boolean;
  }> = [
    {
      phase: 'probe',
      payload: PROBE_USAGE_PAYLOAD,
      pool: 'general',
      estimatedCost: 10_000,
      requiresSeat: true
    },
    {
      phase: 'reference',
      payload: REFERENCE_USAGE_PAYLOAD,
      pool: 'general',
      estimatedCost: 15_000,
      requiresSeat: true
    },
    {
      phase: 'compose',
      payload: COMPOSE_USAGE_PAYLOAD,
      pool: 'general',
      estimatedCost: 20_000,
      requiresSeat: true
    },
    {
      phase: 'reflect',
      payload: REFLECT_USAGE_PAYLOAD,
      pool: 'general',
      estimatedCost: 25_000,
      requiresSeat: true
    },
    {
      phase: 'judge',
      payload: JUDGE_USAGE_PAYLOAD,
      pool: 'verification', // Dedicated verification reserve pool!
      estimatedCost: 30_000,
      requiresSeat: false
    },
    {
      phase: 'dream',
      payload: DREAM_USAGE_PAYLOAD,
      pool: 'general',
      estimatedCost: 40_000,
      requiresSeat: true
    }
  ];

  const steps: PhaseStepRecord[] = [];

  for (let i = 0; i < phasesConfig.length; i++) {
    const cfg = phasesConfig[i]!;
    const callId = `phase_flow_${cfg.phase}_${Date.now()}_${i}`;

    const reserveRes = manager.reserve({
      callId,
      phase: cfg.phase,
      pool: cfg.pool,
      estimatedCostMicros: cfg.estimatedCost,
      requiresSeat: cfg.requiresSeat
    });

    if (!reserveRes.granted || !reserveRes.reservationId) {
      throw new Error(`Failed reservation in phase "${cfg.phase}"`);
    }

    const settleRes = manager.settle({
      callId,
      reservationId: reserveRes.reservationId,
      outcome: 'succeeded',
      usage: cfg.payload,
      rateCard: OPENAI_STYLE_RATE_CARD,
      releaseSeat: cfg.requiresSeat
    });

    steps.push({
      phase: cfg.phase,
      callId,
      reservedCost: reserveRes.reservedCostMicros,
      incurredCost: settleRes.incurredCostMicros,
      amountRefunded: settleRes.amountRefundedMicros,
      pool: cfg.pool,
      event: settleRes.ledgerEvent
    });
  }

  const finalBudgetStatus = manager.getBudgetStatus();
  const allPhasesCompleted = steps.length === 6;

  return {
    steps,
    finalBudgetStatus,
    allPhasesCompleted
  };
}

/**
 * Scenario 6: Shared General Budget Exhaustion (fail-closed).
 */
export function runBudgetExhaustionScenario(
  manager: LedgerReservationManager
): { attemptFailedClosed: boolean; rejectionReason?: string } {
  const hugeEstimate = manager.generalRemainingMicros + 500_000_000;
  const res = manager.reserve({
    callId: `exhaust_call_${Date.now()}`,
    phase: 'probe',
    pool: 'general',
    estimatedCostMicros: hugeEstimate,
    requiresSeat: false
  });

  return {
    attemptFailedClosed: !res.granted,
    rejectionReason: res.rejectionReason
  };
}

/**
 * Scenario 7: Verification Pool Isolation.
 * General budget depletion does not affect verification reserve.
 */
export function runVerificationPoolIsolationScenario(
  manager: LedgerReservationManager
): {
  verificationGranted: boolean;
  pool: 'verification';
} {
  const callId = `verif_isolated_${Date.now()}`;
  const res = manager.reserve({
    callId,
    phase: 'judge',
    pool: 'verification',
    estimatedCostMicros: 5_000,
    requiresSeat: false
  });

  return {
    verificationGranted: res.granted,
    pool: 'verification'
  };
}

/**
 * Scenario 8: Seat Release != Amount Refunded.
 * When incurred spend equals or exceeds reserved amount, amountRefunded is 0,
 * but seatReleased is still true.
 */
export function runSeatReleaseVsRefundScenario(
  manager: LedgerReservationManager
): { seatReleased: boolean; amountRefundedMicros: number } {
  const callId = `seat_refund_test_${Date.now()}`;
  const reserveRes = manager.reserve({
    callId,
    phase: 'compose',
    pool: 'general',
    estimatedCostMicros: 10_000,
    requiresSeat: true
  });

  if (!reserveRes.granted || !reserveRes.reservationId) {
    throw new Error('Failed reserve in seat vs refund test');
  }

  // Incurred cost exactly matches reserved cost
  const settleRes = manager.settle({
    callId,
    reservationId: reserveRes.reservationId,
    outcome: 'succeeded',
    actualCostMicros: 10_000,
    releaseSeat: true
  });

  return {
    seatReleased: settleRes.seatReleased,
    amountRefundedMicros: settleRes.amountRefundedMicros
  };
}

/**
 * Scenario 9 (F-1): actualCostMicros=0 without usage payload.
 * Verifies that 0 cost without usage cannot masquerade as estimated,
 * and falls back to strictly positive conservative floor with unknown provenance.
 */
export function runActualCostZeroWithoutUsageScenario(
  manager: LedgerReservationManager
): {
  incurredCostMicros: number;
  provenance: string;
  conservative: boolean;
  isStrictlyNonZeroConservative: boolean;
} {
  const callId = `zero_no_usage_${Date.now()}`;
  const reserveRes = manager.reserve({
    callId,
    phase: 'probe',
    pool: 'general',
    estimatedCostMicros: 15_000,
    requiresSeat: false
  });

  if (!reserveRes.granted || !reserveRes.reservationId) {
    throw new Error('Failed to reserve in actualCostZeroWithoutUsage scenario');
  }

  const settleRes = manager.settle({
    callId,
    reservationId: reserveRes.reservationId,
    outcome: 'succeeded',
    actualCostMicros: 0
    // no usage provided
  });

  const cost = settleRes.ledgerEvent?.cost;
  const isStrictlyNonZeroConservative =
    settleRes.incurredCostMicros > 0 &&
    cost?.provenance === 'unknown' &&
    cost?.conservative === true;

  return {
    incurredCostMicros: settleRes.incurredCostMicros,
    provenance: cost?.provenance ?? '',
    conservative: cost?.conservative ?? false,
    isStrictlyNonZeroConservative
  };
}

/**
 * Scenario 10 (F-1): actualCostMicros=0 with unknown usage payload.
 * Verifies that explicit unknown usage with 0 actualCost enforces the non-zero conservative floor.
 */
export function runActualCostZeroWithUnknownUsageScenario(
  manager: LedgerReservationManager
): {
  incurredCostMicros: number;
  provenance: string;
  conservative: boolean;
  conservativeSurchargeMicros: number;
  isSelfConsistent: boolean;
} {
  const callId = `zero_unknown_usage_${Date.now()}`;
  const reserveRes = manager.reserve({
    callId,
    phase: 'compose',
    pool: 'general',
    estimatedCostMicros: 20_000,
    requiresSeat: false
  });

  if (!reserveRes.granted || !reserveRes.reservationId) {
    throw new Error('Failed to reserve in actualCostZeroWithUnknownUsage scenario');
  }

  const settleRes = manager.settle({
    callId,
    reservationId: reserveRes.reservationId,
    outcome: 'succeeded',
    actualCostMicros: 0,
    usage: UNKNOWN_USAGE_PAYLOAD
  });

  const cost = settleRes.ledgerEvent?.cost;
  const surcharge = cost?.breakdown.conservativeSurchargeMicros ?? 0;
  const isSelfConsistent =
    settleRes.incurredCostMicros > 0 &&
    cost?.provenance === 'unknown' &&
    cost?.conservative === true &&
    surcharge > 0 &&
    cost?.totalCostMicros === surcharge;

  return {
    incurredCostMicros: settleRes.incurredCostMicros,
    provenance: cost?.provenance ?? '',
    conservative: cost?.conservative ?? false,
    conservativeSurchargeMicros: surcharge,
    isSelfConsistent
  };
}

/**
 * Scenario 11 (F-2): Attempt to reserve a callId that was already settled.
 * Verifies that re-reserving an already settled callId is rejected with call_already_settled,
 * does NOT leak seats or budget reservations, and other callIds can still proceed.
 */
export function runReserveAfterSettleRejectedScenario(
  manager: LedgerReservationManager
): {
  firstReserveGranted: boolean;
  firstSettleDone: boolean;
  reReserveRejected: boolean;
  rejectionReason?: string;
  unaffectedCallGranted: boolean;
  noLedgerLeakage: boolean;
} {
  const callId = `settled_call_${Date.now()}`;
  const reserveRes = manager.reserve({
    callId,
    phase: 'probe',
    pool: 'general',
    estimatedCostMicros: 10_000,
    requiresSeat: true
  });

  const settleRes = manager.settle({
    callId,
    reservationId: reserveRes.reservationId!,
    outcome: 'succeeded',
    actualCostMicros: 8_000,
    releaseSeat: true
  });

  const statusBefore = manager.getBudgetStatus();

  // Attempt to re-reserve the same callId
  const reReserveRes = manager.reserve({
    callId,
    phase: 'probe',
    pool: 'general',
    estimatedCostMicros: 10_000,
    requiresSeat: true
  });

  const statusAfter = manager.getBudgetStatus();

  // Other distinct callId must be able to reserve normally
  const otherCallRes = manager.reserve({
    callId: `other_call_${Date.now()}`,
    phase: 'probe',
    pool: 'general',
    estimatedCostMicros: 5_000,
    requiresSeat: true
  });

  const noLedgerLeakage =
    reReserveRes.granted === false &&
    reReserveRes.rejectionReason === 'call_already_settled' &&
    statusBefore.generalPool.reservedMicros === statusAfter.generalPool.reservedMicros &&
    statusBefore.seats.occupied === statusAfter.seats.occupied &&
    statusBefore.generalPool.settledMicros === statusAfter.generalPool.settledMicros;

  return {
    firstReserveGranted: reserveRes.granted,
    firstSettleDone: settleRes.settled,
    reReserveRejected: !reReserveRes.granted,
    rejectionReason: reReserveRes.rejectionReason,
    unaffectedCallGranted: otherCallRes.granted,
    noLedgerLeakage
  };
}
