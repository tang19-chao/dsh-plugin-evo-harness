/**
 * LEDGER-9 regression: the JitRL composition root threads the metering wiring
 * into its two model-consuming stages - the logit capability probe
 * (createAutoLogitSource -> createTokenLogprobSource) and the LLM step judge
 * (createStepEvaluator). Before the fix JitRlFactoryOptions could not even
 * express metering, so both stages made real provider calls that were recorded
 * in the call registry with provenance 'none' but never reserved or settled in
 * any ledger (invisible to budgets, watermarks and the cost report).
 */
import { describe, expect, it } from 'vitest';
import { ModelCallRegistry } from '../../../src/dsh-bridge';
import { createLedgerReservationManager, twoPhaseSettlementFor } from '../../../src/ledger';
import { createJitRl } from '../../../src/jitrl';
import { parseEvoHarnessConfig } from '../../../src/config';
import type {
  IModelAdapter,
  ModelRequest,
  ModelResponse,
  ProbeTask,
  ProbeTrajectory
} from '../../../src/types/contracts';

const RATE_CARD = {
  modelId: 'test/model',
  inputRatePerMillion: 1_000_000,
  outputRatePerMillion: 2_000_000,
  reasoningSeparatelyBilled: false,
  conservativeFallbackCostMicros: 500
} as const;

const TASK: ProbeTask = { id: 'task-jitrl-metering', prompt: 'add a regression test' };

function judgeableModel(): IModelAdapter & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    complete: async (request: ModelRequest): Promise<ModelResponse> => {
      requests.push(request);
      return {
        text: 'ok',
        finishReason: 'stop',
        // The capability probe reads this to conclude 'supported'.
        tokenLogprobs: [{ token: 'ok', logprob: -0.25 }]
      };
    }
  };
}

function makeTrajectory(): ProbeTrajectory {
  return {
    id: 'traj-1',
    sessionId: 'session-1',
    branchId: 'branch-1',
    branchNamespace: 'ns',
    role: 'candidate',
    status: 'succeeded',
    patchId: 'patch-1',
    patchOrigin: 'domain',
    surfaceKeys: ['system_prompt'],
    startedAt: 0,
    endedAt: 10,
    metrics: { steps: 1, toolCalls: 0, toolErrors: 0, durationMs: 10 },
    steps: [{ index: 0, at: 0, kind: 'tool' }],
    toolErrors: [],
    failureSignals: [],
    memoryRecallIds: []
  };
}

describe('LEDGER-9: jitrl probe and judge spend goes through the ledger', () => {
  it('a metering-wired kernel reserves and settles for BOTH the logit probe and the judge', async () => {
    const manager = createLedgerReservationManager({ enabled: true, defaultRateCard: RATE_CARD });
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'jitrl:ledgers' });
    const registry = new ModelCallRegistry();
    const target = judgeableModel();
    const kernel = createJitRl({
      config: parseEvoHarnessConfig({}),
      model: target,
      metering: { ledgerSettlement: settlement, registry },
      now: () => 1_700_000_000_000
    });

    // The capability probe: one real provider call, wired to a reservation.
    const source = await kernel.getLogitSource();
    expect(source.resolved()).toBe('token');
    const probeRecords = registry.snapshot().filter((entry) => entry.stage === 'logit_probe');
    expect(probeRecords).toHaveLength(1);
    expect(probeRecords[0]?.reservationId).toBeDefined();
    expect(probeRecords[0]?.settlement).toBe('final');
    expect(probeRecords[0]?.reservedMicros).toBeGreaterThan(0);

    // The LLM step judge: forced through the cost gate with the `selected` hint.
    await kernel.stepEvaluator.evaluateSteps({
      trajectory: makeTrajectory(),
      task: TASK,
      selected: true
    });
    const judgeRecords = registry.snapshot().filter((entry) => entry.stage === 'evaluate_steps');
    expect(judgeRecords).toHaveLength(1);
    expect(judgeRecords[0]?.reservationId).toBeDefined();
    expect(judgeRecords[0]?.settlement).toBe('final');

    // The ledger actually saw both calls: two reserves, two settles, both FINAL.
    expect(target.requests).toHaveLength(2);
    expect(manager.getMeteringStatus().reserveAttempts).toBe(2);
    expect(manager.getMeteringStatus().settleCount).toBe(2);
    expect(settlement.identities().map((identity) => identity.state)).toEqual(['settled', 'settled']);
  });

  it('WITHOUT the wiring the same two calls stay unmetered (the pre-fix behaviour, pinned)', async () => {
    const manager = createLedgerReservationManager({ enabled: true, defaultRateCard: RATE_CARD });
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'jitrl:ledgers' });
    const registry = new ModelCallRegistry();
    const kernel = createJitRl({
      config: parseEvoHarnessConfig({}),
      model: judgeableModel(),
      // A registry WITHOUT a ledger: the adapters stay 'unmetered', so the
      // calls are recorded but never reserve or settle anything.
      metering: { registry },
      now: () => 1_700_000_000_000
    });
    await kernel.getLogitSource();
    await kernel.stepEvaluator.evaluateSteps({
      trajectory: makeTrajectory(),
      task: TASK,
      selected: true
    });
    expect(registry.size).toBe(2);
    for (const record of registry.snapshot()) {
      expect(record.settlement).toBe('none');
      expect(record.reservationId).toBeUndefined();
    }
    expect(manager.getMeteringStatus().reserveAttempts).toBe(0);
    expect(manager.getMeteringStatus().settleCount).toBe(0);
    expect(settlement.identities()).toHaveLength(0);
  });
});
