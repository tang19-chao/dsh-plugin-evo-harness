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
import { createLedgerReservationManager, twoPhaseSettlementFor } from '../../../src/ledger';
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
      return {
        text: 'ok',
        finishReason: 'stop',
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

  it('records and rethrows a model failure, settling what was incurred', async () => {
    const manager = createLedgerReservationManager({ enabled: true, defaultRateCard: RATE_CARD });
    const { model, calls } = fakeModel({ fail: true });
    const adapter = createMeteredModelAdapter(model, 'reflect', { ledgerSettlement: twoPhaseSettlementFor(manager, { consumer: 'metered-model-adapter:test' }) });
    await expect(adapter.call(requestFor('reflect'))).rejects.toThrow('provider boom');
    expect(calls).toHaveLength(1);
    const record = adapter.records()[0];
    expect(record?.outcome).toBe('failed');
    expect(record?.incurredCostMicros).toBeGreaterThanOrEqual(0);
    expect(adapter.stats().modelFailures).toBe(1);
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
