/**
 * VERIF-10 regression: the canary's "measured" token REPORT is the net sum, not
 * the gross double-count.
 *
 * `canaryUsageTokenCount` sums every reported field. Under DSH's declared
 * counting semantics (`inputIncludesCacheRead` / `outputIncludesReasoning`)
 * cacheRead is already inside input and reasoning already inside output, so the
 * gross sum counts them twice. The module header said the gross sum was used
 * "only [for] the abort decision", but `assembleResult` also built
 * `measuredTotalTokens` / `measuredBaselineTokens` / `measuredTreatmentTokens`
 * from it and published them in the tokenBudget block — as "measured".
 *
 * The KEEP-GROSS parts are pinned too: the per-call / per-arm KILL SWITCH still
 * judges the gross figure (over-counting aborts earlier, the safe direction),
 * and a call whose host reported nothing still leaves `allUsageMeasured: false`.
 *
 * MUST BE RED before the fix: with declared inclusion semantics the report
 * totals equal the gross sum (cacheRead + reasoning counted twice).
 */
import { describe, expect, it } from 'vitest';

import {
  evaluateRealBenefitCanary,
  REAL_BENEFIT_ROUTE_ID,
  type RawCanaryUsage,
  type RealBenefitBinding
} from '../../../src/dsh-bridge/real-benefit-controller';
import {
  canaryUsageNetTokenCount,
  canaryUsageTokenCount,
  createHostClientFromLlm,
  maskAccountId
} from '../../../src/dsh-bridge/real-benefit-host-client';

const RATE_CARD = {
  modelId: 'verif10-model',
  inputRatePerMillion: 1_000_000,
  outputRatePerMillion: 2_000_000,
  reasoningSeparatelyBilled: false,
  conservativeFallbackCostMicros: 3_000
} as const;

const ROUTE = {
  routeId: REAL_BENEFIT_ROUTE_ID,
  maxInputTokens: 2_000,
  maxOutputTokens: 1_000,
  maxReasoningTokens: 0,
  maxNetworkAttempts: 1,
  tokenizerVerified: true,
  providerEnforcesMaxTokens: true,
  allBillableDimensionsPriced: true
} as const;

function makeBinding(overrides: Partial<RealBenefitBinding> = {}): RealBenefitBinding {
  return {
    account: { provider: 'verif10-provider', model: 'verif10-model', accountId: 'acct-verif10' },
    generalBudgetMicros: 1_000_000,
    verificationReserveMicros: 0,
    maxConcurrencySeats: 1,
    rateCard: { ...RATE_CARD },
    route: { ...ROUTE },
    readonlyTools: ['fs.read'],
    tokenBudget: {
      totalTokens: 800_000,
      perTaskTokens: 500_000,
      perArmTokens: 300_000,
      perCallTokens: 200_000
    },
    authorization: { grantedBy: 'verif10-operator', reason: 'unit-test authorization' },
    taskId: 'verif10-task',
    recordedAdvice: 'prefer the short answer',
    ...overrides
  };
}

const SEMANTICS = { inputIncludesCacheRead: true, outputIncludesReasoning: true } as const;

/** A host client over a synthetic llm seam that reports the given usage. */
function hostClientWithUsage(usage: RawCanaryUsage) {
  const calls: string[] = [];
  const llm = {
    stream: async function* (options: { messages: readonly { content: readonly { text: string }[] }[] }) {
      const prompt = options.messages[0]?.content[0]?.text ?? '';
      calls.push(prompt.includes('Recorded advice') ? 'treatment' : 'baseline');
      yield { type: 'usage', usage };
      yield { type: 'text-delta', index: 0, text: '42' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  };
  return {
    calls,
    client: createHostClientFromLlm(llm, {
      provider: 'verif10-provider',
      model: 'verif10-model',
      routeId: REAL_BENEFIT_ROUTE_ID,
      accountIdMasked: maskAccountId('acct-verif10')
    })
  };
}

describe('VERIF-10: canary token reports use the net (per-call deduplicated) sum', () => {
  const INCLUSIVE_USAGE: RawCanaryUsage = {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 80,
    reasoningTokens: 10,
    cacheWriteTokens: 5
  };

  it('reports net totals while the kill switch still keeps the gross figure', () => {
    // Under the declared semantics the logical spend is
    // input 100 + output 20 + cacheWrite 5 = 125 (cacheRead 80 and reasoning 10
    // are ALREADY inside input/output), while the gross kill-switch sum is
    // 100 + 20 + 80 + 10 + 5 = 215.
    expect(canaryUsageNetTokenCount(INCLUSIVE_USAGE, SEMANTICS)).toBe(125);
    expect(canaryUsageTokenCount(INCLUSIVE_USAGE)).toBe(215);
  });

  it('the tokenBudget block reports the NET figure for each arm and the total', async () => {
    const { client } = hostClientWithUsage(INCLUSIVE_USAGE);
    const result = await evaluateRealBenefitCanary({
      binding: makeBinding(),
      identity: { branchId: 'verif10-branch', sessionId: 'verif10-session' },
      hostClient: client,
      countingSemantics: SEMANTICS
    });

    expect(result.calls).toHaveLength(2);
    // RED before the fix: 215 / 430 (the gross double-count).
    expect(result.tokenBudget.measuredBaselineTokens).toBe(125);
    expect(result.tokenBudget.measuredTreatmentTokens).toBe(125);
    expect(result.tokenBudget.measuredTotalTokens).toBe(250);
    expect(result.tokenBudget.allUsageMeasured).toBe(true);
    // Raw usage stays verbatim on every record (the report fix changes no data).
    for (const call of result.calls) {
      expect(call.usageRaw).toEqual(INCLUSIVE_USAGE);
      // The per-call KILL-SWITCH figure is still the gross sum (safe direction).
      expect(call.measuredTokens).toBe(215);
    }
  });

  it('does NOT subtract a field the provider did not declare as included', async () => {
    // Declared: cacheRead inside input, reasoning NOT inside output. So cacheRead
    // is excluded from the net sum but reasoning still counts:
    // 100 + 20 + 10 + 5 = 135.
    const result = await evaluateRealBenefitCanary({
      binding: makeBinding(),
      identity: { branchId: 'verif10-branch-2', sessionId: 'verif10-session' },
      hostClient: hostClientWithUsage(INCLUSIVE_USAGE).client,
      countingSemantics: { inputIncludesCacheRead: true, outputIncludesReasoning: false }
    });

    expect(result.tokenBudget.measuredBaselineTokens).toBe(135);
    expect(result.tokenBudget.measuredTreatmentTokens).toBe(135);
    expect(result.tokenBudget.measuredTotalTokens).toBe(270);
  });

  it('counts every field independently when no semantics were declared (never understates)', async () => {
    const result = await evaluateRealBenefitCanary({
      binding: makeBinding(),
      identity: { branchId: 'verif10-branch-3', sessionId: 'verif10-session' },
      hostClient: hostClientWithUsage(INCLUSIVE_USAGE).client
    });

    // No declaration ⇒ no subtraction ⇒ net == gross (215 per arm).
    expect(result.tokenBudget.measuredBaselineTokens).toBe(215);
    expect(result.tokenBudget.measuredTotalTokens).toBe(430);
    expect(result.tokenBudget.allUsageMeasured).toBe(true);
  });

  it('still marks usage unmeasured when a call reports no usage at all', async () => {
    const llm = {
      stream: async function* () {
        yield { type: 'text-delta', index: 0, text: '42' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    };
    const client = createHostClientFromLlm(llm, {
      provider: 'verif10-provider',
      model: 'verif10-model',
      routeId: REAL_BENEFIT_ROUTE_ID,
      accountIdMasked: maskAccountId('acct-verif10')
    });

    const result = await evaluateRealBenefitCanary({
      binding: makeBinding(),
      identity: { branchId: 'verif10-branch-4', sessionId: 'verif10-session' },
      hostClient: client,
      countingSemantics: SEMANTICS
    });

    expect(result.tokenBudget.allUsageMeasured).toBe(false);
    expect(result.tokenBudget.measuredTotalTokens).toBe(0);
  });
});
