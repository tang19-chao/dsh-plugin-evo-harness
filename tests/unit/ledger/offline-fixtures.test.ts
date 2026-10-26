import { beforeEach, describe, expect, it } from 'vitest';
import {
  runActualCostZeroWithoutUsageScenario,
  runActualCostZeroWithUnknownUsageScenario,
  runAllPhasesWorkflowScenario,
  runBudgetExhaustionScenario,
  runCancelledIncurredScenario,
  runDoubleSettleScenario,
  runDuplicateBillingScenario,
  runReserveAfterSettleRejectedScenario,
  runSeatReleaseVsRefundScenario,
  runUnknownUsageScenario,
  runVerificationPoolIsolationScenario
} from '../../../scripts/fixtures/ledger/scenarios.js';
import {
  OPENAI_STYLE_RATE_CARD
} from '../../../scripts/fixtures/ledger/sample-rate-cards.js';
import {
  LedgerReservationManager
} from '../../../src/ledger/reservation-manager.js';

describe('Offline Deterministic Fixture Scenarios (ADR-0003 §7.5)', () => {
  let manager: LedgerReservationManager;

  beforeEach(() => {
    manager = new LedgerReservationManager({
      generalBudgetMicros: 200_000, // $0.20
      verificationReserveMicros: 100_000, // $0.10
      maxConcurrencySeats: 5,
      defaultRateCard: OPENAI_STYLE_RATE_CARD
    });
  });

  it('Scenario 1: Duplicate billing yields identical deterministic calculations', () => {
    const res = runDuplicateBillingScenario();
    expect(res.identical).toBe(true);
    expect(res.firstCalculation.totalCostMicros).toBe(res.secondCalculation.totalCostMicros);
    expect(res.firstCalculation.totalCostMicros).toBeGreaterThan(0);
  });

  it('Scenario 2: Double settle detects idempotent replay with zero secondary deduction', () => {
    const res = runDoubleSettleScenario(manager);
    expect(res.noSecondaryDeduction).toBe(true);
    expect(res.firstSettle.isIdempotentReplay).toBe(false);
    expect(res.secondSettle.isIdempotentReplay).toBe(true);
    expect(res.firstSettle.incurredCostMicros).toBe(res.secondSettle.incurredCostMicros);
    expect(res.budgetStatusAfterFirst.generalPool.remainingMicros).toBe(
      res.budgetStatusAfterSecond.generalPool.remainingMicros
    );
  });

  it('Scenario 3: Unknown usage applies non-zero conservative floor', () => {
    const res = runUnknownUsageScenario(manager);
    expect(res.isStrictlyNonZeroConservative).toBe(true);
    expect(res.costCalculation.provenance).toBe('unknown');
    expect(res.costCalculation.conservative).toBe(true);
    expect(res.settleResult.incurredCostMicros).toBeGreaterThan(0);
  });

  it('Scenario 4: Cancelled call incurs spend, releases seat, but marks auditOnly=true', () => {
    const res = runCancelledIncurredScenario(manager);
    expect(res.seatReleased).toBe(true);
    expect(res.incurredCostMicros).toBeGreaterThan(0);
    expect(res.auditOnly).toBe(true);
    expect(res.qualityEvidence).toBe(false);
  });

  it('Scenario 5: Complete 6-phase lifecycle sequence (probe -> reference -> compose -> reflect -> judge -> dream)', () => {
    const res = runAllPhasesWorkflowScenario(manager);
    expect(res.allPhasesCompleted).toBe(true);
    expect(res.steps).toHaveLength(6);

    const phases = res.steps.map(s => s.phase);
    expect(phases).toEqual(['probe', 'reference', 'compose', 'reflect', 'judge', 'dream']);

    // Check pool assignments: judge uses verification reserve, others use general
    const judgeStep = res.steps.find(s => s.phase === 'judge')!;
    expect(judgeStep.pool).toBe('verification');

    const otherSteps = res.steps.filter(s => s.phase !== 'judge');
    for (const step of otherSteps) {
      expect(step.pool).toBe('general');
    }

    // Verify all steps recorded valid ledger events
    for (const step of res.steps) {
      expect(step.event).toBeDefined();
      expect(step.event?.phase).toBe(step.phase);
      expect(step.incurredCost).toBeGreaterThan(0);
    }

    // Verify final budget reflects deductions
    expect(res.finalBudgetStatus.generalPool.settledMicros).toBeGreaterThan(0);
    expect(res.finalBudgetStatus.verificationPool.settledMicros).toBeGreaterThan(0);
  });

  it('Scenario 6: Budget exhaustion triggers fail-closed rejection', () => {
    const res = runBudgetExhaustionScenario(manager);
    expect(res.attemptFailedClosed).toBe(true);
    expect(res.rejectionReason).toBe('insufficient_budget');
  });

  it('Scenario 7: Verification pool isolation preserves verification capacity when general budget is depleted', () => {
    // Deplete general pool
    manager.reserve({
      callId: 'drain_general',
      phase: 'dream',
      pool: 'general',
      estimatedCostMicros: manager.generalRemainingMicros
    });
    expect(manager.generalRemainingMicros).toBe(0);

    const res = runVerificationPoolIsolationScenario(manager);
    expect(res.verificationGranted).toBe(true);
    expect(res.pool).toBe('verification');
  });

  it('Scenario 8: Seat release does not imply amount refund', () => {
    const res = runSeatReleaseVsRefundScenario(manager);
    expect(res.seatReleased).toBe(true);
    expect(res.amountRefundedMicros).toBe(0);
  });

  it('Scenario 9 (F-1): actualCostMicros=0 without usage payload enforces positive conservative floor and unknown provenance', () => {
    const res = runActualCostZeroWithoutUsageScenario(manager);
    expect(res.isStrictlyNonZeroConservative).toBe(true);
    expect(res.incurredCostMicros).toBeGreaterThan(0);
    expect(res.provenance).toBe('unknown');
    expect(res.conservative).toBe(true);
  });

  it('Scenario 10 (F-1): actualCostMicros=0 with unknown usage payload enforces positive conservative floor and surcharge', () => {
    const res = runActualCostZeroWithUnknownUsageScenario(manager);
    expect(res.isSelfConsistent).toBe(true);
    expect(res.incurredCostMicros).toBeGreaterThan(0);
    expect(res.provenance).toBe('unknown');
    expect(res.conservative).toBe(true);
    expect(res.conservativeSurchargeMicros).toBeGreaterThan(0);
    expect(res.incurredCostMicros).toBe(res.conservativeSurchargeMicros);
  });

  it('Scenario 11 (F-2): Attempt to re-reserve an already settled callId is rejected without ledger leakage', () => {
    const res = runReserveAfterSettleRejectedScenario(manager);
    expect(res.firstReserveGranted).toBe(true);
    expect(res.firstSettleDone).toBe(true);
    expect(res.reReserveRejected).toBe(true);
    expect(res.rejectionReason).toBe('call_already_settled');
    expect(res.unaffectedCallGranted).toBe(true);
    expect(res.noLedgerLeakage).toBe(true);
  });

  it('Contract boundary: r4 learningTarget and reward weights remain completely untouched', () => {
    // Generate deterministic ledger events through full 6-phase workflow to ensure non-vacuous assertion (Z-1)
    runAllPhasesWorkflowScenario(manager);
    const events = manager.getLedgerEvents();
    expect(events.length).toBeGreaterThan(0);
    // Verify that ledger events never touch reward weights or r4 learningTarget
    for (const evt of events) {
      expect(evt).not.toHaveProperty('learningTarget');
      expect(evt).not.toHaveProperty('contractWeightsHash');
    }
  });
});
