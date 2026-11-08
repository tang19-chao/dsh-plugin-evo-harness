/**
 * P3-B: the unified MeteredModelAdapter contract.
 *
 * Pins: stage -> purpose/phase mapping, purpose-mismatch rejection, the runtime
 * call-count gate (every underlying call must appear in the registry), honest
 * provenance (no ledger = 'none', no semantics = 'unknown', never 'measured'),
 * budget-denial and model-failure records.
 *
 * #183/#13 (rev8 audit 2026-11-07): a LOCAL abort (aborted DSH stream, caller
 * cancel) holds the conservative figure INTERIM and never books it as final paid
 * spend; the truth arrives only through the existing reconcile channel on the
 * ORIGINAL callId; a retry meters each attempt under its own callId.
 */
import { describe, expect, it } from 'vitest';
import {
  createMeteredModelAdapter,
  DshModelStreamError,
  globalModelCallRegistry,
  MeteredModelError,
  ModelCallRegistry,
  STAGE_LEDGER_PHASE,
  STAGE_PURPOSE,
  type MeteringStage
} from '../../../src/dsh-bridge';
import {
  createLedgerReservationManager,
  createUsagePayload,
  twoPhaseSettlementFor
} from '../../../src/ledger';
import type { IModelAdapter, ModelRequest, ModelResponse } from '../../../src/types/contracts';

const RATE_CARD = {
  modelId: 'test/model',
  inputRatePerMillion: 1_000_000,
  outputRatePerMillion: 2_000_000,
  reasoningSeparatelyBilled: false,
  conservativeFallbackCostMicros: 500
} as const;

const SEMANTICS = { inputIncludesCacheRead: true, outputIncludesReasoning: true } as const;

function fakeModel(options: {
  readonly fail?: boolean;
  /** Throws a non-abort transport exception (the ECONNRESET shape: name 'Error'). */
  readonly transportError?: boolean;
  /** Responds NORMALLY but with a provider-reported terminal error. */
  readonly finishError?: boolean;
  readonly rawUsage?: { readonly inputTokens: number; readonly outputTokens: number };
  readonly semantics?: typeof SEMANTICS;
} = {}): { model: IModelAdapter; calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  const model: IModelAdapter = {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      calls.push(request);
      if (options.fail === true) {
        throw new Error('provider boom');
      }
      if (options.transportError === true) {
        throw new Error('read ECONNRESET');
      }
      return {
        text: 'ok',
        finishReason: options.finishError === true ? 'error' : 'stop',
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        metadata: {
          ...(options.rawUsage === undefined ? {} : { rawUsage: options.rawUsage }),
          ...(options.semantics === undefined ? {} : { countingSemantics: options.semantics })
        }
      };
    }
  };
  return { model, calls };
}

function requestFor(purpose: ModelRequest['purpose']): ModelRequest {
  return { purpose, messages: [{ role: 'user', content: 'hi' }] };
}

const STAGES: readonly MeteringStage[] = [
  'propose',
  'compose',
  'reflect',
  'dream',
  'evaluate_steps',
  'logit_probe',
  'probe'
];

describe('stage -> purpose/phase mapping (the real labels)', () => {
  it('maps every stage to its real ModelPurpose', () => {
    expect(STAGE_PURPOSE).toEqual({
      propose: 'propose',
      compose: 'compose',
      reflect: 'reflect',
      dream: 'dream_policy',
      evaluate_steps: 'evaluate_steps',
      logit_probe: 'probe',
      probe: 'probe'
    });
  });

  it('maps every stage to its ledger phase', () => {
    expect(STAGE_LEDGER_PHASE).toEqual({
      propose: 'compose',
      compose: 'compose',
      reflect: 'reflect',
      dream: 'dream',
      evaluate_steps: 'judge',
      logit_probe: 'probe',
      probe: 'probe'
    });
  });

  it('probe and compose are DIFFERENT stages with DIFFERENT purposes', () => {
    expect(STAGE_PURPOSE.probe).toBe('probe');
    expect(STAGE_PURPOSE.compose).toBe('compose');
    expect(STAGE_PURPOSE.probe).not.toBe(STAGE_PURPOSE.compose);
  });
});

describe('purpose enforcement: a mislabelled call is refused', () => {
  for (const stage of STAGES) {
    it('stage ' + stage + ' rejects a request with another purpose', async () => {
      const { model, calls } = fakeModel();
      const registry = new ModelCallRegistry();
      const adapter = createMeteredModelAdapter(model, stage, { registry });
      // Pick a purpose that differs from the stage's real one (logit_probe maps
      // to 'probe' too, so keying off the stage NAME would miss it).
      const wrong = STAGE_PURPOSE[stage] === 'probe' ? 'compose' : 'probe';
      await expect(adapter.call(requestFor(wrong))).rejects.toMatchObject({
        code: 'METERED_MODEL_PURPOSE_MISMATCH'
      });
      expect(calls).toHaveLength(0);
      expect(registry.size).toBe(1);
      expect(registry.snapshot()[0]?.error).toBe('purpose_mismatch');
    });
  }

  it('accepts the stage purpose and forwards it unchanged', async () => {
    const { model, calls } = fakeModel();
    const adapter = createMeteredModelAdapter(model, 'probe');
    await adapter.call(requestFor('probe'));
    expect(calls.map((call) => call.purpose)).toEqual(['probe']);
  });
});

describe('runtime count gate: every underlying call is recorded', () => {
  it('records exactly one entry per underlying model call', async () => {
    const { model, calls } = fakeModel();
    const registry = new ModelCallRegistry();
    const adapter = createMeteredModelAdapter(model, 'compose', { registry });
    await adapter.call(requestFor('compose'));
    await adapter.call(requestFor('compose'));
    expect(calls).toHaveLength(2);
    expect(registry.size).toBe(2);
    expect(registry.countsByStage()).toEqual({ compose: 2 });
    expect(registry.countsByPurpose()).toEqual({ compose: 2 });
    expect(adapter.stats().attempted).toBe(2);
  });

  it('route complete() through the same gate (IModelAdapter compatibility)', async () => {
    const { model, calls } = fakeModel();
    const registry = new ModelCallRegistry();
    const adapter = createMeteredModelAdapter(model, 'reflect', { registry });
    await adapter.complete(requestFor('reflect'));
    expect(calls).toHaveLength(1);
    expect(registry.size).toBe(1);
    expect(registry.snapshot()[0]?.stage).toBe('reflect');
  });
});

describe('default registry: collected implies traceable', () => {
  it('reports to the global registry when no registry is injected', async () => {
    const { model } = fakeModel();
    const before = globalModelCallRegistry().size;
    const adapter = createMeteredModelAdapter(model, 'logit_probe');
    await adapter.call(requestFor('probe'));
    const snapshot = globalModelCallRegistry().snapshot();
    expect(snapshot.length).toBe(before + 1);
    expect(snapshot[snapshot.length - 1]?.stage).toBe('logit_probe');
    expect(snapshot[snapshot.length - 1]?.purpose).toBe('probe');
  });

  it('is bounded: oldest records are dropped and the loss is visible', () => {
    const registry = new ModelCallRegistry();
    for (let index = 0; index < 5_100; index += 1) {
      registry.record({
        callId: 'c' + String(index),
        stage: 'probe',
        purpose: 'probe',
        ledgerPhase: 'probe',
        outcome: 'succeeded',
        durationMs: 1,
        reservedMicros: 0,
        provenance: 'none'
      });
    }
    expect(registry.size).toBe(5_000);
    expect(registry.dropped).toBeGreaterThan(0);
  });
});

describe('honest provenance: no ledger never claims measured', () => {
  it('is UNMETERED without a ledger and records provenance none / cost 0', async () => {
    const { model } = fakeModel({ rawUsage: { inputTokens: 10, outputTokens: 5 }, semantics: SEMANTICS });
    const adapter = createMeteredModelAdapter(model, 'propose');
    await adapter.call(requestFor('propose'));
    expect(adapter.metering).toBe('unmetered');
    const record = adapter.records()[0];
    expect(record?.provenance).toBe('none');
    expect(record?.incurredCostMicros).toBeUndefined();
    // No ledger means NO ring-fence: the record must not claim the 10_000
    // default estimate was reserved (the interface documents 0 here).
    expect(record?.reservedMicros).toBe(0);
    const stats = adapter.stats();
    expect(stats.reserved).toBe(0);
    expect(stats.costMicros).toBe(0);
    expect(stats.measuredCalls).toBe(0);
    expect(stats.estimatedCalls).toBe(0);
    expect(stats.unknownCalls).toBe(0);
  });

  it('records the ACTUAL ring-fenced amount: observe mode reserves 0, not the estimate', async () => {
    const manager = createLedgerReservationManager({
      enabled: true,
      defaultRateCard: RATE_CARD
    });
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'metered-model-adapter:observe' });
    const { model } = fakeModel({ rawUsage: { inputTokens: 10, outputTokens: 5 }, semantics: SEMANTICS });
    const adapter = createMeteredModelAdapter(model, 'propose', { ledgerSettlement: settlement });
    await adapter.call(requestFor('propose'));
    const record = adapter.records()[0];
    expect(record?.reservationId).toBeDefined();
    expect(record?.settlement).toBe('final');
    // The assembly path defaults to observe: `beginCall` granted the call but
    // ring-fenced nothing, so the rendered record must report 0. It used to
    // report the 10_000 request estimate and inflate stats().reserved.
    expect(record?.reservedMicros).toBe(0);
    expect(manager.getBudgetStatus().generalPool.reservedMicros).toBe(0);
    expect(adapter.stats().reserved).toBe(0);
  });

  it('records measured provenance only when usage AND semantics are provider-declared', async () => {
    const manager = createLedgerReservationManager({ enabled: true, defaultRateCard: RATE_CARD });
    const { model } = fakeModel({ rawUsage: { inputTokens: 10, outputTokens: 5 }, semantics: SEMANTICS });
    const adapter = createMeteredModelAdapter(model, 'compose', { ledgerSettlement: twoPhaseSettlementFor(manager, { consumer: 'metered-model-adapter:test' }) });
    await adapter.call(requestFor('compose'));
    expect(adapter.metering).toBe('observed');
    const record = adapter.records()[0];
    expect(record?.provenance).toBe('measured');
    expect(record?.incurredCostMicros).toBeGreaterThan(0);
    expect(adapter.stats().measuredCalls).toBe(1);
    expect(adapter.stats().estimatedCalls).toBe(0);
  });

  it('records UNKNOWN (never measured) when the provider declares no semantics', async () => {
    const manager = createLedgerReservationManager({ enabled: true, defaultRateCard: RATE_CARD });
    const { model } = fakeModel({ rawUsage: { inputTokens: 10, outputTokens: 5 } });
    const adapter = createMeteredModelAdapter(model, 'compose', { ledgerSettlement: twoPhaseSettlementFor(manager, { consumer: 'metered-model-adapter:test' }) });
    await adapter.call(requestFor('compose'));
    const record = adapter.records()[0];
    expect(record?.provenance).toBe('unknown');
    expect(record?.incurredCostMicros).toBeGreaterThan(0);
    expect(adapter.stats().measuredCalls).toBe(0);
    expect(adapter.stats().unknownCalls).toBe(1);
  });
});

describe('failure paths remain auditable', () => {
  it('refuses before calling the model when the ledger denies the reservation', async () => {
    // Denial is an ENFORCE-mode behaviour; observe (the default) proceeds.
    const manager = createLedgerReservationManager({
      enabled: true,
      enforceHardBounds: true,
      generalBudgetMicros: 0
    });
    const { model, calls } = fakeModel();
    const adapter = createMeteredModelAdapter(model, 'probe', { ledgerSettlement: twoPhaseSettlementFor(manager, { consumer: 'metered-model-adapter:test' }) });
    await expect(adapter.call(requestFor('probe'))).rejects.toMatchObject({
      code: 'METERED_MODEL_BUDGET_DENIED'
    });
    expect(calls).toHaveLength(0);
    expect(adapter.stats().denied).toBe(1);
    expect(adapter.records()[0]?.error).toBe('budget_denied');
  });

  it('records and rethrows a thrown model failure, HOLDING the money interim (LEDGER-5)', async () => {
    const manager = createLedgerReservationManager({
      enabled: true,
      enforceHardBounds: true,
      generalBudgetMicros: 1_000_000,
      defaultRateCard: RATE_CARD
    });
    const { model, calls } = fakeModel({ fail: true });
    const adapter = createMeteredModelAdapter(model, 'reflect', { ledgerSettlement: twoPhaseSettlementFor(manager, { consumer: 'metered-model-adapter:test' }) });
    await expect(adapter.call(requestFor('reflect'))).rejects.toThrow('provider boom');
    expect(calls).toHaveLength(1);
    // A thrown non-abort exception does not prove the provider stopped: the
    // outcome is infrastructure_error (NOT remote-confirmed), so settleCall goes
    // INTERIM and the conservative figure is HELD, never booked as settled spend.
    const record = adapter.records()[0];
    expect(record?.outcome).toBe('infrastructure_error');
    expect(record?.settlement).toBe('interim');
    expect(record?.heldCostMicros).toBe(RATE_CARD.conservativeFallbackCostMicros);
    expect(record?.incurredCostMicros).toBeUndefined();
    expect(record?.error).toBe('Error');
    expect(adapter.stats().modelFailures).toBe(1);
    // The money stays ring-fenced on the pool: reserved, not settled.
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(0);
    expect(manager.getBudgetStatus().generalPool.reservedMicros).toBeGreaterThan(0);
  });

  it('keeps a provider-RESPONDED terminal error remote-confirmed and final (LEDGER-5)', async () => {
    const manager = createLedgerReservationManager({
      enabled: true,
      enforceHardBounds: true,
      generalBudgetMicros: 1_000_000,
      defaultRateCard: RATE_CARD
    });
    const { model } = fakeModel({ finishError: true });
    const adapter = createMeteredModelAdapter(model, 'reflect', { ledgerSettlement: twoPhaseSettlementFor(manager, { consumer: 'metered-model-adapter:test' }) });
    await adapter.call(requestFor('reflect'));
    const record = adapter.records()[0];
    expect(record?.outcome).toBe('failed');
    expect(record?.settlement).toBe('final');
    expect(record?.incurredCostMicros).toBeGreaterThan(0);
    expect(record?.heldCostMicros).toBeUndefined();
    expect(adapter.stats().settled).toBe(1);
  });

  it('refuses ambiguous ledger wiring at construction', () => {
    const manager = createLedgerReservationManager({ enabled: true });
    expect(() =>
      createMeteredModelAdapter(fakeModel().model, 'probe', {
        ledger: { enabled: true },
        ledgerSettlement: twoPhaseSettlementFor(manager, { consumer: 'metered-model-adapter:probe' })
      })
    ).toThrow(MeteredModelError);
  });
});

describe('LEDGER-5: transport exceptions hold funds/seats instead of booking FINAL', () => {
  it('an ECONNRESET-shaped exception settles INTERIM and the late usage reconciles on the SAME callId', async () => {
    const manager = createLedgerReservationManager({
      enabled: true,
      enforceHardBounds: true,
      generalBudgetMicros: 1_000_000,
      defaultRateCard: RATE_CARD
    });
    const { model } = fakeModel({ transportError: true });
    const adapter = createMeteredModelAdapter(model, 'probe', {
      ledgerSettlement: twoPhaseSettlementFor(manager, { consumer: 'metered-model-adapter:test' }),
      idFactory: () => 'mcall_econnreset'
    });
    await expect(adapter.call(requestFor('probe'))).rejects.toThrow('read ECONNRESET');
    const record = adapter.records()[0];
    expect(record?.outcome).toBe('infrastructure_error');
    expect(record?.settlement).toBe('interim');
    expect(record?.reservationId).toBeDefined();
    // Nothing was booked as settled spend; the conservative figure is HELD.
    expect(record?.incurredCostMicros).toBeUndefined();
    expect(record?.heldCostMicros).toBe(RATE_CARD.conservativeFallbackCostMicros);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(0);
    expect(manager.getBudgetStatus().generalPool.reservedMicros).toBeGreaterThan(0);

    // The identity survives so the provider's late usage (or an external bill)
    // can still land on the ORIGINAL callId — the held money gets its truth.
    const merged = adapter.reconcileLateUsage({
      originCallId: 'mcall_econnreset',
      usage: createUsagePayload({ input: 1_000, output: 500, semantics: SEMANTICS })
    });
    expect(merged.callId).toBe('mcall_econnreset');
    expect(merged.incurredCostMicros).toBeGreaterThan(0);
    expect(adapter.lateUsageSettlements()).toHaveLength(1);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(merged.incurredCostMicros);
  });

  it('holds the SEAT for an infrastructure_error and releases it for a remote-confirmed failed', () => {
    // `requiresSeat` is a begin-call knob the adapter does not expose (it always
    // passes false), so the seat half of the contract is pinned at the settlement
    // level the adapter delegates to.
    const infra = createLedgerReservationManager({
      enabled: true,
      enforceHardBounds: true,
      defaultRateCard: RATE_CARD,
      maxConcurrencySeats: 2
    });
    const infraSettlement = twoPhaseSettlementFor(infra, { consumer: 'metered-model-adapter:test' });
    const infraCall = infraSettlement.beginCall({
      consumer: 'metered-model-adapter:test',
      callId: 'mcall_seat_infra',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 10_000,
      requiresSeat: true
    });
    expect(infraCall.granted).toBe(true);
    const infraSettled = infraSettlement.settleCall({
      callId: 'mcall_seat_infra',
      reservationId: infraCall.reservationId as string,
      outcome: 'infrastructure_error',
      releaseSeat: true
    });
    // An explicit releaseSeat is DELAYED, never forced: the provider may still
    // be generating, so the slot stays occupied (ADR-0004 §5.1).
    expect(infraSettled.settlement).toBe('interim');
    expect(infraSettled.result.seatReleased).toBe(false);
    expect(infraSettled.result.seatRetainedPendingRemote).toBe(true);
    expect(infra.occupiedSeatCount).toBe(1);

    const failed = createLedgerReservationManager({
      enabled: true,
      enforceHardBounds: true,
      defaultRateCard: RATE_CARD,
      maxConcurrencySeats: 2
    });
    const failedSettlement = twoPhaseSettlementFor(failed, { consumer: 'metered-model-adapter:test' });
    const failedCall = failedSettlement.beginCall({
      consumer: 'metered-model-adapter:test',
      callId: 'mcall_seat_failed',
      phase: 'probe',
      pool: 'general',
      estimatedCostMicros: 10_000,
      requiresSeat: true
    });
    expect(failedCall.granted).toBe(true);
    const failedSettled = failedSettlement.settleCall({
      callId: 'mcall_seat_failed',
      reservationId: failedCall.reservationId as string,
      outcome: 'failed',
      releaseSeat: true
    });
    expect(failedSettled.settlement).toBe('final');
    expect(failedSettled.result.seatReleased).toBe(true);
    expect(failed.occupiedSeatCount).toBe(0);
  });
});

describe('LEDGER-6: a failed settlement is recorded as settle_failed on EVERY path', () => {
  it('the SUCCESS path records settle_failed and counts it in stats', async () => {
    const manager = createLedgerReservationManager({ enabled: true, defaultRateCard: RATE_CARD });
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'metered-model-adapter:test' });
    // Poison the settlement AFTER the reservation is minted by beginCall but so
    // that settleCall throws — the "money may already have moved" shape.
    const poisonedSettle = settlement.settleCall.bind(settlement);
    settlement.settleCall = (request: Parameters<typeof settlement.settleCall>[0]) => {
      if (request.callId === 'mcall_poison_success') {
        throw new Error('wal append failed (poisoned)');
      }
      return poisonedSettle(request);
    };
    const { model } = fakeModel();
    const adapter = createMeteredModelAdapter(model, 'compose', {
      ledgerSettlement: settlement,
      idFactory: () => 'mcall_poison_success'
    });
    // The model call itself SUCCEEDS; only the settlement behind it fails.
    const response = await adapter.call(requestFor('compose'));
    expect(response.text).toBe('ok');
    const record = adapter.records()[0];
    expect(record?.outcome).toBe('succeeded');
    expect(record?.reservationId).toBeDefined();
    expect(record?.error).toBe('settle_failed');
    expect(record?.provenance).toBe('unknown');
    expect(record?.incurredCostMicros).toBeUndefined();
    expect(record?.settlement).toBe('none');
    const stats = adapter.stats();
    expect(stats.settleFailures).toBe(1);
    expect(stats.modelFailures).toBe(0);
  });

  it('the ERROR path keeps recording settle_failed (the mirrored marker)', async () => {
    const manager = createLedgerReservationManager({ enabled: true, defaultRateCard: RATE_CARD });
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'metered-model-adapter:test' });
    const poisonedSettle = settlement.settleCall.bind(settlement);
    settlement.settleCall = (request: Parameters<typeof settlement.settleCall>[0]) => {
      if (request.callId === 'mcall_poison_error') {
        throw new Error('wal append failed (poisoned)');
      }
      return poisonedSettle(request);
    };
    const { model } = fakeModel({ fail: true });
    const adapter = createMeteredModelAdapter(model, 'reflect', {
      ledgerSettlement: settlement,
      idFactory: () => 'mcall_poison_error'
    });
    await expect(adapter.call(requestFor('reflect'))).rejects.toThrow('provider boom');
    const record = adapter.records()[0];
    expect(record?.error).toBe('settle_failed');
    expect(adapter.stats().settleFailures).toBe(1);
    expect(adapter.stats().modelFailures).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #183/#13 (rev8 audit): partial usage on a LOCAL abort.
//
// A local abort (a mid-stream DSH abort, a caller cancel) does NOT prove the
// provider stopped generating, so the conservative figure is HELD interim and
// the record must never dress it up as final paid spend. The truth arrives only
// through the already-existing reconcile channel, on the ORIGINAL callId; and a
// retried call is a NEW callId that meters on its own — never booked twice.
// ---------------------------------------------------------------------------

describe('#183/#13: partial usage on a local abort settles through reconcile, never as fake final', () => {
  /** The exact error shape createLlmModelAdapter throws for an aborted DSH stream. */
  function abortedStreamModel(): IModelAdapter {
    return {
      async complete(): Promise<ModelResponse> {
        throw new DshModelStreamError('the host stream was aborted by the caller', 'aborted');
      }
    };
  }

  it('an aborted-stream call holds the conservative figure INTERIM — no final booking', async () => {
    const manager = createLedgerReservationManager({
      enabled: true,
      enforceHardBounds: true,
      generalBudgetMicros: 1_000_000,
      defaultRateCard: RATE_CARD
    });
    const adapter = createMeteredModelAdapter(abortedStreamModel(), 'probe', {
      ledgerSettlement: twoPhaseSettlementFor(manager, { consumer: 'metered-model-adapter:183' }),
      idFactory: () => 'mcall_183_abort'
    });

    await expect(adapter.call(requestFor('probe'))).rejects.toThrow('aborted by the caller');

    const record = adapter.records()[0];
    // Outcome semantics: an abort is a cancel, not a transport break (VERIF-9).
    expect(record?.outcome).toBe('cancelled');
    // THE ASK'S BAR: the held interim figure is never misreported as final paid
    // spend — incurredCostMicros stays absent and the pool books nothing.
    expect(record?.settlement).toBe('interim');
    expect(record?.incurredCostMicros).toBeUndefined();
    expect(record?.heldCostMicros).toBe(RATE_CARD.conservativeFallbackCostMicros);
    expect(adapter.stats().settled).toBe(0);
    expect(adapter.stats().costMicros).toBe(0);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(0);
    // The reservation identity survives so late usage can still join.
    expect(record?.reservationId).toBeDefined();
    expect(adapter.callIdentities().some((identity) => identity.callId === 'mcall_183_abort')).toBe(true);
  });

  it('a late partial usage books through the EXISTING reconcile channel on the ORIGINAL callId', async () => {
    const manager = createLedgerReservationManager({
      enabled: true,
      enforceHardBounds: true,
      generalBudgetMicros: 1_000_000,
      defaultRateCard: RATE_CARD
    });
    const adapter = createMeteredModelAdapter(abortedStreamModel(), 'probe', {
      ledgerSettlement: twoPhaseSettlementFor(manager, { consumer: 'metered-model-adapter:183' }),
      idFactory: () => 'mcall_183_late'
    });
    await expect(adapter.call(requestFor('probe'))).rejects.toThrow();
    const heldRecord = adapter.records()[0];
    expect(heldRecord?.settlement).toBe('interim');

    // The provider's partial usage for the aborted generation arrives late and
    // merges into the SAME callId — one reserve attempt, no new reservation.
    const merged = adapter.reconcileLateUsage({
      originCallId: 'mcall_183_late',
      usage: createUsagePayload({ input: 800, output: 120, semantics: SEMANTICS })
    });
    expect(merged.mode).toBe('reconciled');
    expect(merged.callId).toBe('mcall_183_late');
    expect(merged.incurredCostMicros).toBeGreaterThan(0);
    expect(adapter.lateUsageSettlements()).toHaveLength(1);
    expect(adapter.stats().lateUsageSettlements).toBe(1);
    // The truth replaced the hold: the pool books exactly the reconciled figure.
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(merged.incurredCostMicros);
    expect(manager.getBudgetStatus().generalPool.reservedMicros).toBe(0);
    // stats().costMicros reads the booked map, not the interim hold.
    expect(adapter.stats().costMicros).toBe(merged.incurredCostMicros);
    // One reserve, one settle bookkeeping: reconcile never opened a second call.
    expect(manager.getMeteringStatus().reserveAttempts).toBe(1);
    expect(manager.getMeteringStatus().settleCount).toBe(1);
    expect(manager.verifyConservationLaw().balanced).toBe(true);
  });

  it('a redelivered late usage is a no-op, not a second charge on the same callId', async () => {
    const manager = createLedgerReservationManager({
      enabled: true,
      enforceHardBounds: true,
      generalBudgetMicros: 1_000_000,
      defaultRateCard: RATE_CARD
    });
    const adapter = createMeteredModelAdapter(abortedStreamModel(), 'probe', {
      ledgerSettlement: twoPhaseSettlementFor(manager, { consumer: 'metered-model-adapter:183' }),
      idFactory: () => 'mcall_183_replay'
    });
    await expect(adapter.call(requestFor('probe'))).rejects.toThrow();
    const event = {
      originCallId: 'mcall_183_replay',
      usage: createUsagePayload({ input: 800, output: 120, semantics: SEMANTICS })
    } as const;
    const merged = adapter.reconcileLateUsage(event);
    const booked = manager.getBudgetStatus().generalPool.settledMicros;
    expect(booked).toBe(merged.incurredCostMicros);

    const redelivered = adapter.reconcileLateUsage(event);
    expect(redelivered.previouslyReconciled).toBe(true);
    expect(redelivered.incurredCostMicros).toBe(merged.incurredCostMicros);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(booked);
    expect(manager.getMeteringStatus().settleCount).toBe(1);
    expect(manager.getMeteringStatus().reserveAttempts).toBe(1);
  });

  it('reconciling an UNKNOWN origin stays refused — no new branch for unjoined usage', async () => {
    const manager = createLedgerReservationManager({
      enabled: true,
      enforceHardBounds: true,
      generalBudgetMicros: 1_000_000,
      defaultRateCard: RATE_CARD
    });
    const adapter = createMeteredModelAdapter(abortedStreamModel(), 'probe', {
      ledgerSettlement: twoPhaseSettlementFor(manager, { consumer: 'metered-model-adapter:183' })
    });
    await expect(adapter.call(requestFor('probe'))).rejects.toThrow();

    const before = manager.getBudgetStatus();
    expect(() =>
      adapter.reconcileLateUsage({
        originCallId: 'mcall_never_seen',
        usage: createUsagePayload({ input: 800, output: 120, semantics: SEMANTICS })
      })
    ).toThrow('LATE_USAGE_UNKNOWN_CALL');
    // Not even the marker turns reconcile into the double-booking path.
    expect(() =>
      adapter.reconcileLateUsage({
        originCallId: 'mcall_never_seen',
        usage: createUsagePayload({ input: 800, output: 120, semantics: SEMANTICS }),
        newAttemptMarker: 'new-attempt',
        newAttemptReason: 'the marker alone is not a licence'
      })
    ).toThrow('LATE_USAGE_UNKNOWN_CALL');
    expect(manager.getBudgetStatus().generalPool).toEqual(before.generalPool);
  });

  it('a marked new attempt books once, audit-only, under a DERIVED callId', async () => {
    const manager = createLedgerReservationManager({
      enabled: true,
      enforceHardBounds: true,
      generalBudgetMicros: 1_000_000,
      defaultRateCard: RATE_CARD
    });
    const adapter = createMeteredModelAdapter(abortedStreamModel(), 'probe', {
      ledgerSettlement: twoPhaseSettlementFor(manager, { consumer: 'metered-model-adapter:183' })
    });
    await expect(adapter.call(requestFor('probe'))).rejects.toThrow();

    const event = {
      originCallId: 'mcall_183_unreachable',
      usage: createUsagePayload({ input: 800, output: 120, semantics: SEMANTICS }),
      newAttemptMarker: 'new-attempt',
      newAttemptReason: 'the origin mapping was not persisted by an older process'
    } as const;
    const booked = adapter.bookNewAttempt(event);
    expect(booked.mode).toBe('new-attempt');
    // The booking is a correction under its own derived callId — never the
    // original callId counted twice.
    expect(booked.callId).not.toBe('mcall_183_unreachable');
    expect(booked.ledgerEvent?.auditOnly).toBe(true);
    expect(booked.ledgerEvent?.qualityEvidence).toBe(false);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(booked.incurredCostMicros);

    // The SAME event redelivered derives the SAME callId: idempotent, no second
    // booking (the deterministic-derivation rule, P0-3). The counters read 2
    // because the marked attempt IS a sanctioned new reservation (1 aborted
    // original + 1 new attempt); the redelivery adds neither.
    const redelivered = adapter.bookNewAttempt(event);
    expect(redelivered.previouslyReconciled).toBe(true);
    expect(redelivered.incurredCostMicros).toBe(booked.incurredCostMicros);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(booked.incurredCostMicros);
    expect(manager.getMeteringStatus().reserveAttempts).toBe(2);
    expect(manager.getMeteringStatus().settleCount).toBe(2);
  });

  it('a retried attempt is a NEW callId metering ONCE on its own — the aborted callId is never billed twice', async () => {
    const manager = createLedgerReservationManager({
      enabled: true,
      enforceHardBounds: true,
      generalBudgetMicros: 1_000_000,
      defaultRateCard: RATE_CARD
    });
    let attempt = 0;
    const retryingModel: IModelAdapter = {
      async complete(): Promise<ModelResponse> {
        attempt += 1;
        if (attempt === 1) {
          throw new DshModelStreamError('the host stream was aborted by the caller', 'aborted');
        }
        return {
          text: 'ok',
          finishReason: 'stop',
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
          metadata: {
            rawUsage: { inputTokens: 500, outputTokens: 100 },
            countingSemantics: SEMANTICS
          }
        };
      }
    };
    let sequence = 0;
    const adapter = createMeteredModelAdapter(retryingModel, 'probe', {
      ledgerSettlement: twoPhaseSettlementFor(manager, { consumer: 'metered-model-adapter:183' }),
      idFactory: (): string => 'mcall_183_attempt_' + String((sequence += 1))
    });

    // Attempt 1 aborts locally: interim hold, nothing booked.
    await expect(adapter.call(requestFor('probe'))).rejects.toThrow('aborted by the caller');
    expect(adapter.records()[0]?.settlement).toBe('interim');
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(0);

    // Attempt 2 (the retry) is its own callId with its own final settlement.
    const response = await adapter.call(requestFor('probe'));
    expect(response.finishReason).toBe('stop');
    const settled = adapter.records()[1];
    expect(settled?.callId).toBe('mcall_183_attempt_2');
    expect(settled?.settlement).toBe('final');
    const booked = manager.getBudgetStatus().generalPool.settledMicros;
    expect(booked).toBe(settled?.incurredCostMicros);

    // The retry's truth does not touch the aborted callId: attempt 1 still holds
    // interim with no incurred figure — the two attempts are never merged, so the
    // same work cannot be paid for twice.
    expect(adapter.records()[0]?.callId).toBe('mcall_183_attempt_1');
    expect(adapter.records()[0]?.incurredCostMicros).toBeUndefined();
    expect(adapter.records()[0]?.heldCostMicros).toBe(RATE_CARD.conservativeFallbackCostMicros);
    // Exactly one reserve + one settle per attempt, nothing more.
    expect(manager.getMeteringStatus().reserveAttempts).toBe(2);
    expect(manager.getMeteringStatus().settleCount).toBe(2);
    // The booked map keeps per-call figures separate (no summed double count).
    expect(adapter.stats().costMicros).toBe(booked);
  });
});
