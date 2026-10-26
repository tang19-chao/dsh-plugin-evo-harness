import { beforeEach, describe, expect, it } from 'vitest';
import {
  LedgerError,
  LedgerReservationManager
} from '../../../src/ledger/reservation-manager.js';
import {
  LedgerBudgetConfig,
  ModelRateCard
} from '../../../src/ledger/types.js';

describe('Ledger Reservation Manager Lifecycle (ADR-0003 §7.4)', () => {
  const testRateCard: ModelRateCard = {
    modelId: 'test-model',
    inputRatePerMillion: 1_000_000,
    outputRatePerMillion: 2_000_000,
    reasoningSeparatelyBilled: false,
    conservativeFallbackCostMicros: 10_000
  };

  const config: LedgerBudgetConfig = {
    generalBudgetMicros: 100_000, // $0.10 total
    verificationReserveMicros: 50_000, // $0.05 verification reserve
    maxConcurrencySeats: 3,
    defaultRateCard: testRateCard
  };

  let manager: LedgerReservationManager;

  beforeEach(() => {
    manager = new LedgerReservationManager(config);
  });

  describe('Concurrency & Call Isolation', () => {
    it('grants distinct reservations for concurrent distinct callIds', () => {
      const res1 = manager.reserve({
        callId: 'call_1',
        phase: 'probe',
        pool: 'general',
        estimatedCostMicros: 10_000,
        requiresSeat: true
      });

      const res2 = manager.reserve({
        callId: 'call_2',
        phase: 'compose',
        pool: 'general',
        estimatedCostMicros: 15_000,
        requiresSeat: true
      });

      expect(res1.granted).toBe(true);
      expect(res2.granted).toBe(true);
      expect(res1.reservationId).not.toBe(res2.reservationId);
      expect(manager.getBudgetStatus().seats.occupied).toBe(2);
      expect(manager.getBudgetStatus().generalPool.reservedMicros).toBe(25_000);
    });

    it('rejects duplicate active reservation on the same callId', () => {
      const res1 = manager.reserve({
        callId: 'duplicate_call',
        phase: 'probe',
        pool: 'general',
        estimatedCostMicros: 10_000
      });
      expect(res1.granted).toBe(true);

      const res2 = manager.reserve({
        callId: 'duplicate_call',
        phase: 'probe',
        pool: 'general',
        estimatedCostMicros: 10_000
      });
      expect(res2.granted).toBe(false);
      expect(res2.rejectionReason).toBe('duplicate_active_call');
    });
  });

  describe('Budget Pool Isolation & Fail-Closed Guardrails', () => {
    it('rejects general call when general budget is depleted (fail-closed, no overdraft)', () => {
      const res1 = manager.reserve({
        callId: 'big_call',
        phase: 'dream',
        pool: 'general',
        estimatedCostMicros: 90_000
      });
      expect(res1.granted).toBe(true);

      // Attempting to reserve 20_000 when only 10_000 remains in general pool
      const res2 = manager.reserve({
        callId: 'overdraft_call',
        phase: 'dream',
        pool: 'general',
        estimatedCostMicros: 20_000
      });

      expect(res2.granted).toBe(false);
      expect(res2.rejectionReason).toBe('insufficient_budget');
      // No money was reserved
      expect(manager.generalRemainingMicros).toBe(10_000);
    });

    it('keeps verification reserve strictly isolated from general exploration calls', () => {
      // Consume all general budget
      manager.reserve({
        callId: 'exhaust_general',
        phase: 'dream',
        pool: 'general',
        estimatedCostMicros: 100_000
      });

      expect(manager.generalRemainingMicros).toBe(0);

      // General call fails
      const genRes = manager.reserve({
        callId: 'gen_fail',
        phase: 'probe',
        pool: 'general',
        estimatedCostMicros: 5_000
      });
      expect(genRes.granted).toBe(false);

      // Verification call succeeds because verification pool is independent!
      const verifRes = manager.reserve({
        callId: 'verif_judge',
        phase: 'judge',
        pool: 'verification',
        estimatedCostMicros: 25_000
      });
      expect(verifRes.granted).toBe(true);
      expect(manager.verificationRemainingMicros).toBe(25_000);
    });
  });

  describe('Concurrency Seat Management', () => {
    it('enforces maxConcurrencySeats limit and frees seats upon releaseSeat', () => {
      manager.reserve({ callId: 'c1', phase: 'probe', pool: 'general', estimatedCostMicros: 5000, requiresSeat: true });
      manager.reserve({ callId: 'c2', phase: 'probe', pool: 'general', estimatedCostMicros: 5000, requiresSeat: true });
      manager.reserve({ callId: 'c3', phase: 'probe', pool: 'general', estimatedCostMicros: 5000, requiresSeat: true });

      expect(manager.getBudgetStatus().seats.occupied).toBe(3);
      expect(manager.availableSeats).toBe(0);

      // Fourth seat request is rejected
      const c4 = manager.reserve({ callId: 'c4', phase: 'probe', pool: 'general', estimatedCostMicros: 5000, requiresSeat: true });
      expect(c4.granted).toBe(false);
      expect(c4.rejectionReason).toBe('insufficient_seats');

      // Releasing a seat allows new reservation
      const released = manager.releaseSeat('c1');
      expect(released).toBe(true);
      expect(manager.availableSeats).toBe(1);

      const c4Retry = manager.reserve({ callId: 'c4', phase: 'probe', pool: 'general', estimatedCostMicros: 5000, requiresSeat: true });
      expect(c4Retry.granted).toBe(true);
    });
  });

  describe('Idempotent Settlement & Anti-Double Deduction', () => {
    it('returns cached result on duplicate settle without secondary budget deduction', () => {
      const res = manager.reserve({
        callId: 'settle_test',
        phase: 'compose',
        pool: 'general',
        estimatedCostMicros: 30_000,
        requiresSeat: true
      });

      const initialRemaining = manager.generalRemainingMicros;

      // First settlement: actual cost 18_000 (refund 12_000)
      const firstSettle = manager.settle({
        callId: 'settle_test',
        reservationId: res.reservationId!,
        outcome: 'succeeded',
        actualCostMicros: 18_000,
        releaseSeat: true
      });

      expect(firstSettle.isIdempotentReplay).toBe(false);
      expect(firstSettle.incurredCostMicros).toBe(18_000);
      expect(firstSettle.amountRefundedMicros).toBe(12_000);
      expect(firstSettle.seatReleased).toBe(true);

      const statusAfterFirst = manager.getBudgetStatus();
      expect(statusAfterFirst.generalPool.settledMicros).toBe(18_000);
      expect(statusAfterFirst.generalPool.remainingMicros).toBe(82_000);

      // Second settlement with identical callId
      const secondSettle = manager.settle({
        callId: 'settle_test',
        reservationId: res.reservationId!,
        outcome: 'succeeded',
        actualCostMicros: 18_000,
        releaseSeat: true
      });

      expect(secondSettle.isIdempotentReplay).toBe(true);
      expect(secondSettle.incurredCostMicros).toBe(18_000);

      // Budget status MUST remain completely unchanged!
      const statusAfterSecond = manager.getBudgetStatus();
      expect(statusAfterSecond.generalPool.settledMicros).toBe(statusAfterFirst.generalPool.settledMicros);
      expect(statusAfterSecond.generalPool.remainingMicros).toBe(statusAfterFirst.generalPool.remainingMicros);
    });
  });

  describe('Seat Release != Amount Refunded (ADR-0003 §7.4)', () => {
    it('demonstrates seat release with zero refund when incurred spend matches reservation', () => {
      const res = manager.reserve({
        callId: 'full_spend_call',
        phase: 'reflect',
        pool: 'general',
        estimatedCostMicros: 20_000,
        requiresSeat: true
      });

      const settle = manager.settle({
        callId: 'full_spend_call',
        reservationId: res.reservationId!,
        outcome: 'succeeded',
        actualCostMicros: 20_000,
        releaseSeat: true
      });

      // Seat was released, but 0 amount was refunded
      expect(settle.seatReleased).toBe(true);
      expect(settle.amountRefundedMicros).toBe(0);
      expect(manager.getBudgetStatus().seats.occupied).toBe(0);
    });
  });

  describe('Cancelled / Failed calls & Audit-Only (ADR-0003 §7.3.6)', () => {
    it('truthfully records incurred cost on cancellation, but marks auditOnly=true and qualityEvidence=false', () => {
      const res = manager.reserve({
        callId: 'cancelled_call',
        phase: 'probe',
        pool: 'general',
        estimatedCostMicros: 25_000,
        requiresSeat: true
      });

      const settle = manager.settle({
        callId: 'cancelled_call',
        reservationId: res.reservationId!,
        outcome: 'cancelled',
        actualCostMicros: 8_000,
        releaseSeat: true
      });

      // Under ADR-0003 §7.3.5 / t11 F-1, actualCostMicros without usage has provenance 'unknown' and conservative=true.
      // 8_000 is clamped to fallback floor (10_000). Refund is 25_000 - 10_000 = 15_000.
      expect(settle.incurredCostMicros).toBe(10_000);
      expect(settle.amountRefundedMicros).toBe(15_000);
      expect(settle.auditOnly).toBe(true);
      expect(settle.qualityEvidence).toBe(false);

      const event = settle.ledgerEvent!;
      expect(event.auditOnly).toBe(true);
      expect(event.qualityEvidence).toBe(false);
      expect(event.outcome).toBe('cancelled');
      expect(event.cost.provenance).toBe('unknown');
      expect(event.cost.conservative).toBe(true);
    });

    it('marks failed executions as auditOnly=true and qualityEvidence=false', () => {
      const res = manager.reserve({
        callId: 'failed_call',
        phase: 'compose',
        pool: 'general',
        estimatedCostMicros: 15_000
      });

      const settle = manager.settle({
        callId: 'failed_call',
        reservationId: res.reservationId!,
        outcome: 'infrastructure_error',
        actualCostMicros: 5_000
      });

      expect(settle.auditOnly).toBe(true);
      expect(settle.qualityEvidence).toBe(false);
      // Under ADR-0003 §7.3.5 / t11 F-1, 5_000 without usage is clamped to conservative floor 10_000.
      expect(settle.incurredCostMicros).toBe(10_000);
      expect(settle.amountRefundedMicros).toBe(5_000); // 15_000 - 10_000
      expect(settle.ledgerEvent?.cost.provenance).toBe('unknown');
      expect(settle.ledgerEvent?.cost.conservative).toBe(true);
    });
  });

  describe('Lifecycle Order Diagnostics', () => {
    it('throws UNRESERVED_CALL_SETTLE when settling an unreserved callId', () => {
      expect(() => {
        manager.settle({
          callId: 'never_reserved',
          reservationId: 'res_fake',
          outcome: 'succeeded'
        });
      }).toThrowError(LedgerError);
    });

    it('throws RESERVATION_ID_MISMATCH when reservationId does not match call', () => {
      const res = manager.reserve({
        callId: 'valid_call',
        phase: 'probe',
        pool: 'general',
        estimatedCostMicros: 5_000
      });

      expect(() => {
        manager.settle({
          callId: 'valid_call',
          reservationId: 'res_different_id',
          outcome: 'succeeded'
        });
      }).toThrowError(LedgerError);
    });
  });

  describe('F-1 & F-2 Defect Closures (Zero Cost Bypass & Settled Call Re-Reserve)', () => {
    it('enforces conservative non-zero floor and unknown provenance when actualCostMicros=0 without usage (F-1)', () => {
      const res = manager.reserve({
        callId: 'zero_cost_no_usage',
        phase: 'probe',
        pool: 'general',
        estimatedCostMicros: 20_000
      });

      const settle = manager.settle({
        callId: 'zero_cost_no_usage',
        reservationId: res.reservationId!,
        outcome: 'succeeded',
        actualCostMicros: 0
        // no usage payload
      });

      // MUST NOT fall to 0 or estimated!
      expect(settle.incurredCostMicros).toBe(10_000); // testRateCard.conservativeFallbackCostMicros
      expect(settle.incurredCostMicros).toBeGreaterThan(0);
      expect(settle.ledgerEvent?.cost.provenance).toBe('unknown');
      expect(settle.ledgerEvent?.cost.conservative).toBe(true);
      expect(settle.ledgerEvent?.cost.breakdown.conservativeSurchargeMicros).toBe(10_000);
    });

    it('enforces conservative non-zero floor and self-consistent conservative flag when actualCostMicros=0 with unknown usage (F-1)', () => {
      const res = manager.reserve({
        callId: 'zero_cost_unknown_usage',
        phase: 'compose',
        pool: 'general',
        estimatedCostMicros: 20_000
      });

      const settle = manager.settle({
        callId: 'zero_cost_unknown_usage',
        reservationId: res.reservationId!,
        outcome: 'succeeded',
        actualCostMicros: 0,
        usage: {
          inputTokens: { tokens: 0, precision: 'unknown' },
          outputTokens: { tokens: 0, precision: 'unknown' }
          // missing countingSemantics
        }
      });

      // MUST NOT fall to 0!
      expect(settle.incurredCostMicros).toBe(10_000);
      expect(settle.ledgerEvent?.cost.provenance).toBe('unknown');
      expect(settle.ledgerEvent?.cost.conservative).toBe(true);
      expect(settle.ledgerEvent?.cost.breakdown.conservativeSurchargeMicros).toBe(10_000);
    });

    it('rejects re-reserving an already settled callId without leaking budget or seats (F-2)', () => {
      // 1. Initial reservation and settlement
      const res1 = manager.reserve({
        callId: 'call_lifecycle_test',
        phase: 'reflect',
        pool: 'general',
        estimatedCostMicros: 15_000,
        requiresSeat: true
      });
      expect(res1.granted).toBe(true);

      const settle1 = manager.settle({
        callId: 'call_lifecycle_test',
        reservationId: res1.reservationId!,
        outcome: 'succeeded',
        actualCostMicros: 15_000,
        releaseSeat: true
      });
      expect(settle1.settled).toBe(true);

      const statusBefore = manager.getBudgetStatus();
      expect(statusBefore.generalPool.reservedMicros).toBe(0);
      expect(statusBefore.seats.occupied).toBe(0);
      expect(statusBefore.generalPool.settledMicros).toBe(15_000);

      // 2. Attempt to re-reserve the settled callId => MUST BE REJECTED!
      const resReReserve = manager.reserve({
        callId: 'call_lifecycle_test',
        phase: 'reflect',
        pool: 'general',
        estimatedCostMicros: 15_000,
        requiresSeat: true
      });

      expect(resReReserve.granted).toBe(false);
      expect(resReReserve.rejectionReason).toBe('call_already_settled');

      // 3. Verify ledger is NOT leaked
      const statusAfter = manager.getBudgetStatus();
      expect(statusAfter.generalPool.reservedMicros).toBe(0);
      expect(statusAfter.seats.occupied).toBe(0);
      expect(statusAfter.generalPool.settledMicros).toBe(15_000);
      expect(statusAfter.generalPool.remainingMicros).toBe(statusBefore.generalPool.remainingMicros);

      // 4. Other callId can reserve and acquire seat without being blocked
      const otherRes = manager.reserve({
        callId: 'unrelated_call',
        phase: 'reflect',
        pool: 'general',
        estimatedCostMicros: 10_000,
        requiresSeat: true
      });
      expect(otherRes.granted).toBe(true);
      expect(manager.getBudgetStatus().seats.occupied).toBe(1);
    });
  });
});
