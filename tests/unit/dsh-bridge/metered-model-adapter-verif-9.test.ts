/**
 * VERIF-9 regression: an ABORTED DSH stream is a CANCEL, not an
 * infrastructure failure.
 *
 * `createHostClientFromLlm` throws `DshModelStreamError(detail, 'aborted')` when
 * the host stream settles with an aborted finish (real-benefit-host-client.ts:
 * the `kind === 'aborted' && !capAborted` branch). The metered adapter's
 * `outcomeOfError` classified thrown errors by NAME only ('abort'/'cancel'
 * substrings), and `DshModelStreamError`'s name carries neither — so a mid-stream
 * abort fell through to the catch-all.
 *
 * After batch-1 (LEDGER-5) that catch-all is `infrastructure_error`, which is
 * ALSO interim, so money/seat handling was already safe. What stayed wrong is the
 * RECORDED SEMANTICS: the call was aborted (the remote may still be producing under
 * a caller-owned abort) yet the record said the harness/transport broke. The
 * agent-loop executor encodes the abort rule as `cancelled` (its outcome ladder:
 * `timedOut ? 'timed_out' : cancelled ? 'cancelled' : 'failed'`), so the two
 * production consumers disagreed about the same abort.
 *
 * Also pinned: a provider-RESPONDED error finish (`finishKind: 'error'`) is a
 * remote-confirmed `failed` (FINAL) and must NOT be reclassified by this fix.
 *
 * MUST BE RED before the fix: the aborted-stream record reads `infrastructure_error`.
 */
import { describe, expect, it } from 'vitest';

import {
  createMeteredModelAdapter,
  DshModelStreamError,
  MeteredModelError
} from '../../../src/dsh-bridge';
import { createLedgerReservationManager, twoPhaseSettlementFor } from '../../../src/ledger';
import type { IModelAdapter, ModelRequest, ModelResponse } from '../../../src/types/contracts';

const RATE_CARD = {
  modelId: 'verif9/model',
  inputRatePerMillion: 1_000_000,
  outputRatePerMillion: 2_000_000,
  reasoningSeparatelyBilled: false,
  conservativeFallbackCostMicros: 500
} as const;

/** A model that throws the exact error shape the real host client produces. */
function abortingStreamModel(): { readonly model: IModelAdapter; calls: number } {
  const state = { calls: 0 };
  const model: IModelAdapter = {
    async complete(_request: ModelRequest): Promise<ModelResponse> {
      state.calls += 1;
      throw new DshModelStreamError('the host stream was aborted by the caller', 'aborted');
    }
  };
  return { model, get calls(): number { return state.calls; } } as unknown as {
    readonly model: IModelAdapter;
    calls: number;
  };
}

function erroredStreamModel(): IModelAdapter {
  return {
    async complete(_request: ModelRequest): Promise<ModelResponse> {
      throw new DshModelStreamError('the provider returned a rate-limit error', 'error', 'RATE_LIMIT');
    }
  };
}

function requestFor(purpose: ModelRequest['purpose']): ModelRequest {
  return { purpose, messages: [{ role: 'user', content: 'hi' }] };
}

describe('VERIF-9: DshModelStreamError(finishKind "aborted") settles as a cancel (INTERIM)', () => {
  it('records outcome "cancelled" (not infrastructure_error) and holds the money INTERIM', async () => {
    const manager = createLedgerReservationManager({
      enabled: true,
      enforceHardBounds: true,
      generalBudgetMicros: 1_000_000,
      defaultRateCard: RATE_CARD
    });
    const { model } = abortingStreamModel();
    const adapter = createMeteredModelAdapter(model, 'probe', {
      ledgerSettlement: twoPhaseSettlementFor(manager, { consumer: 'metered-model-adapter:test' }),
      idFactory: () => 'mcall_aborted_stream'
    });

    await expect(adapter.call(requestFor('probe'))).rejects.toThrow('aborted by the caller');

    const record = adapter.records()[0];
    // The load-bearing assertion (RED before the fix: 'infrastructure_error').
    expect(record?.outcome).toBe('cancelled');
    // 'cancelled' is NOT a remote-confirmed outcome, so the settlement stays
    // INTERIM: money + seat held, nothing booked as settled spend.
    expect(record?.settlement).toBe('interim');
    expect(record?.incurredCostMicros).toBeUndefined();
    expect(record?.heldCostMicros).toBe(RATE_CARD.conservativeFallbackCostMicros);
    expect(manager.getBudgetStatus().generalPool.settledMicros).toBe(0);
    expect(manager.getBudgetStatus().generalPool.reservedMicros).toBeGreaterThan(0);
    // The aborting call was really dialed (this is not a pre-dial refusal).
    expect(adapter.stats().attempted).toBe(1);
  });

  it('keeps the callId identity so late usage merges into the SAME call', async () => {
    const manager = createLedgerReservationManager({
      enabled: true,
      enforceHardBounds: true,
      generalBudgetMicros: 1_000_000,
      defaultRateCard: RATE_CARD
    });
    const { model } = abortingStreamModel();
    const adapter = createMeteredModelAdapter(model, 'probe', {
      ledgerSettlement: twoPhaseSettlementFor(manager, { consumer: 'metered-model-adapter:test' }),
      idFactory: () => 'mcall_aborted_late'
    });

    await expect(adapter.call(requestFor('probe'))).rejects.toThrow();

    expect(adapter.records()[0]?.reservationId).toBeDefined();
    // The abort-interim call is reconcilable on its ORIGINAL callId.
    expect(adapter.callIdentities().some((identity) => identity.callId === 'mcall_aborted_late')).toBe(true);
  });

  it('does NOT reclassify a provider-RESPONDED error finish (still remote-confirmed "failed")', async () => {
    const manager = createLedgerReservationManager({
      enabled: true,
      enforceHardBounds: true,
      generalBudgetMicros: 1_000_000,
      defaultRateCard: RATE_CARD
    });
    const adapter = createMeteredModelAdapter(erroredStreamModel(), 'probe', {
      ledgerSettlement: twoPhaseSettlementFor(manager, { consumer: 'metered-model-adapter:test' })
    });

    await expect(adapter.call(requestFor('probe'))).rejects.toThrow('rate-limit error');

    const record = adapter.records()[0];
    expect(record?.outcome).toBe('infrastructure_error');
    expect(record?.settlement).toBe('interim');
  });

  it('leaves the existing name-based AbortError/CancelError mapping intact', async () => {
    const manager = createLedgerReservationManager({
      enabled: true,
      enforceHardBounds: true,
      generalBudgetMicros: 1_000_000,
      defaultRateCard: RATE_CARD
    });
    const abortingAdapter: IModelAdapter = {
      async complete(): Promise<ModelResponse> {
        const error = new Error('caller aborted');
        error.name = 'AbortError';
        throw error;
      }
    };
    const adapter = createMeteredModelAdapter(abortingAdapter, 'probe', {
      ledgerSettlement: twoPhaseSettlementFor(manager, { consumer: 'metered-model-adapter:test' })
    });

    await expect(adapter.call(requestFor('probe'))).rejects.toThrow('caller aborted');

    expect(adapter.records()[0]?.outcome).toBe('cancelled');
    expect(adapter.records()[0]?.settlement).toBe('interim');
  });

  it('still refuses a mislabelled purpose before any of this (no regression in the gate)', async () => {
    const adapter = createMeteredModelAdapter(abortingStreamModel().model, 'probe');
    await expect(adapter.call(requestFor('compose'))).rejects.toBeInstanceOf(MeteredModelError);
  });
});
