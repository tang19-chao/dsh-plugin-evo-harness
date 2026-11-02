/**
 * P3-B: the unified MeteredModelAdapter contract.
 *
 * Pins: stage -> purpose/phase mapping, purpose-mismatch rejection, the runtime
 * call-count gate (every underlying call must appear in the registry), honest
 * provenance (no ledger = 'none', no semantics = 'unknown', never 'measured'),
 * budget-denial and model-failure records.
 */
import { describe, expect, it } from 'vitest';
import {
  createMeteredModelAdapter,
  globalModelCallRegistry,
  MeteredModelError,
  ModelCallRegistry,
  STAGE_LEDGER_PHASE,
  STAGE_PURPOSE,
  type MeteringStage
} from '../../../src/dsh-bridge';
import { createLedgerReservationManager, createUsagePayload, twoPhaseSettlementFor } from '../../../src/ledger';
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
    const stats = adapter.stats();
    expect(stats.costMicros).toBe(0);
    expect(stats.measuredCalls).toBe(0);
    expect(stats.estimatedCalls).toBe(0);
    expect(stats.unknownCalls).toBe(0);
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
