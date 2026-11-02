/**
 * LEDGER-12 (audit rounds 1+2): `LateUsageEvent.providerCallId` was declared
 * "audit metadata" and never persisted, so `reconcileWithExternalBill` only had
 * our `callId` to join on — a real provider export keyed by provider ids was
 * 100% `unresolved` + `unknownToLedger` even when the mapping existed.
 *
 * WHAT THIS PINS (the fix contract):
 *
 *   - the providerCallId carried by a late-usage event is persisted on the
 *     durable call-index identity (both on the reconcile path and on the marked
 *     new-attempt path), and survives a reload of the index file;
 *   - an external bill keyed ONLY by providerCallId matches the ledger
 *     (`matched`/`exact`, no `unresolved`, nothing `unknownToLedger`);
 *   - our callId still wins when the bill exposes it;
 *   - the two namespaces stay separate: a bill line whose providerCallId happens
 *     to equal our callId is `unknownToLedger` (a mis-joined export, not a match);
 *   - lines that match nothing stay visible, and duplicate keys are still surfaced.
 *
 * Everything runs on the REAL manager + settlement over REAL files; only
 * callId/usage values are constructed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  calculateUsageCost,
  createLedgerReservationManager,
  createUsagePayload,
  LedgerCallIndex,
  reconcileWithExternalBill,
  twoPhaseSettlementFor,
  type LedgerReservationManager,
  type ModelRateCard,
  type ProviderUsagePayload
} from '../../../src/ledger';

const RATE_CARD: ModelRateCard = {
  modelId: 'ledger-12/dual-key-model',
  inputRatePerMillion: 1_000_000,
  outputRatePerMillion: 2_000_000,
  reasoningSeparatelyBilled: false,
  conservativeFallbackCostMicros: 500
};

const SEMANTICS = { inputIncludesCacheRead: true, outputIncludesReasoning: true } as const;

const LAT_USAGE: ProviderUsagePayload = createUsagePayload({
  input: 2_000,
  output: 500,
  cacheRead: 100,
  semantics: SEMANTICS
});

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0).reverse()) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-12-dual-key-'));
  tempDirs.push(dir);
  return dir;
}

function makeManager(storageDir?: string): LedgerReservationManager {
  return createLedgerReservationManager({
    enabled: true,
    enforceHardBounds: true,
    generalBudgetMicros: 10_000_000,
    verificationReserveMicros: 1_000_000,
    maxConcurrencySeats: 4,
    defaultRateCard: RATE_CARD,
    ...(storageDir === undefined ? {} : { storageDir })
  });
}

describe('LEDGER-12: a provider-keyed bill can be reconciled (dual-key join)', () => {
  it('persists providerCallId on the identity at late-usage reconcile time', () => {
    const manager = makeManager();
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'test' });
    const callId = 'call-dual-key';
    settlement.beginCall({
      callId,
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 10_000,
      requiresSeat: false,
      rateCard: RATE_CARD
    });
    // Termination with no usage: an interim hold, exactly the late-usage shape.
    settlement.settleCall({ callId, reservationId: manager.getReservationByCallId(callId)?.reservationId as string, outcome: 'cancelled' });
    expect(settlement.identityOf(callId)?.providerCallId).toBeUndefined();

    const merged = settlement.reconcileLateUsage({
      originCallId: callId,
      providerCallId: 'resp_provider_abc',
      usage: LAT_USAGE
    });
    expect(merged.mode).toBe('reconciled');
    // The join key the bill will expose is now on the durable identity.
    expect(settlement.identityOf(callId)?.providerCallId).toBe('resp_provider_abc');
    expect(settlement.identityOf(callId)?.state).toBe('reconciled');
  });

  it('persists providerCallId on a marked new attempt too', () => {
    const manager = makeManager();
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'test' });
    const booked = settlement.bookNewAttempt({
      originCallId: 'origin-unreachable',
      providerCallId: 'resp_new_attempt_1',
      usage: LAT_USAGE,
      newAttemptMarker: 'new-attempt',
      newAttemptReason: 'the origin mapping was never persisted'
    });
    expect(settlement.identityOf(booked.callId)?.providerCallId).toBe('resp_new_attempt_1');
  });

    it('survives an index reload (the persistence is on disk, not just in memory)', () => {
    const dir = tempDir();
    const manager = makeManager(dir);
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'test', storageDir: dir });
    const callId = 'call-dual-key-durable';
    settlement.beginCall({
      callId,
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 10_000,
      requiresSeat: false,
      rateCard: RATE_CARD
    });
    settlement.settleCall({
      callId,
      reservationId: manager.getReservationByCallId(callId)?.reservationId as string,
      outcome: 'cancelled'
    });
    settlement.reconcileLateUsage({ originCallId: callId, providerCallId: 'resp_durable_1', usage: LAT_USAGE });

    const reloaded = new LedgerCallIndex({ storageDir: dir });
    expect(reloaded.lookup(callId)?.providerCallId).toBe('resp_durable_1');
  });

  it('matches a bill keyed ONLY by providerCallId (the audited 100%-unresolved shape)', () => {
    const internalCost = calculateUsageCost(LAT_USAGE, RATE_CARD).totalCostMicros;
    const report = reconcileWithExternalBill({
      internal: [{ callId: 'c1', providerCallId: 'resp_abc', incurredCostMicros: internalCost }],
      external: [{ providerCallId: 'resp_abc', chargedMicros: internalCost }]
    });
    expect(report.matched).toBe(1);
    expect(report.exact).toBe(1);
    expect(report.unresolved).toBe(0);
    expect(report.unknownToLedger).toEqual([]);
    expect(report.verdicts[0]?.state).toBe('reconciled_exact');
    expect(report.allSettled).toBe(true);
  });

  it('still prefers our callId when the bill exposes it', () => {
    const report = reconcileWithExternalBill({
      internal: [{ callId: 'c1', providerCallId: 'resp_abc', incurredCostMicros: 1_000 }],
      external: [{ callId: 'c1', providerCallId: 'resp_abc', chargedMicros: 1_000 }]
    });
    expect(report.matched).toBe(1);
    expect(report.exact).toBe(1);
  });

  it('keeps the namespaces separate: an unclaimed providerCallId is NOT a callId match', () => {
    const report = reconcileWithExternalBill({
      internal: [{ callId: 'c1', incurredCostMicros: 1_000 }],
      external: [{ providerCallId: 'c1', chargedMicros: 1_000 }]
    });
    // The bill's provider-side id equals our callId string, but no identity
    // recorded that provider id: this is a mis-joined export, not a match.
    expect(report.matched).toBe(0);
    expect(report.unresolved).toBe(1);
    expect(report.unknownToLedger).toHaveLength(1);
    expect(report.allSettled).toBe(false);
  });

  it('still surfaces unknown lines and duplicate keys alongside a provider-keyed match', () => {
    const report = reconcileWithExternalBill({
      internal: [
        { callId: 'c1', providerCallId: 'resp_1', incurredCostMicros: 1_000 },
        { callId: 'c2', providerCallId: 'resp_2', incurredCostMicros: 2_000 }
      ],
      external: [
        { providerCallId: 'resp_1', chargedMicros: 1_000 },
        { providerCallId: 'resp_2', chargedMicros: 2_000 },
        { providerCallId: 'resp_2', chargedMicros: 2_000 }, // duplicate provider key
        { providerCallId: 'resp_ghost', chargedMicros: 999 }
      ]
    });
    expect(report.matched).toBe(2);
    expect(report.exact).toBe(2);
    expect(report.duplicateBillKeys).toEqual(['resp_2']);
    expect(report.unknownToLedger).toHaveLength(1);
    expect(report.unknownToLedger[0]?.providerCallId).toBe('resp_ghost');
    // A duplicate line is unknown to the ledger too: it is nobody's match target.
    expect(report.unknownToLedger.some((line) => line.providerCallId === 'resp_2')).toBe(false);
    expect(report.allSettled).toBe(false);
  });

  it('an internal line WITHOUT a recorded providerCallId still reconciles by callId', () => {
    const report = reconcileWithExternalBill({
      internal: [{ callId: 'c1', incurredCostMicros: 1_000 }],
      external: [{ callId: 'c1', chargedMicros: 1_000 }]
    });
    expect(report.matched).toBe(1);
    expect(report.allSettled).toBe(true);
  });
});
