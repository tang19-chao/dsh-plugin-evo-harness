/**
 * P1-4: JitRL logit sources. Verifies the plan section 3.2 verbalized
 * formula with hand-computed values (monotonic, clamped at 0/1/NaN), the
 * section 3.1 policy-prior normalization with memory-confidence modulation
 * and exploration temperature, the one-shot token-logprob probe with a
 * cached verdict and graceful degradation, and the auto resolution order.
 */
import { describe, expect, it } from 'vitest';
import {
  ZERO_SHARE_LOGIT,
  createAutoLogitSource,
  createTokenLogprobSource,
  policyPriorLogit,
  verbalizedLogit,
  type LogprobCapabilities
} from '../../../src/jitrl/logit-sources';
import {
  type IModelAdapter,
  type JitCandidate,
  type ModelRequest,
  type ModelResponse
} from '../../../src/types/contracts';

const WEIGHTS: Readonly<Record<'exploit' | 'explore_domain' | 'explore_invariant' | 'recover', number>> = {
  exploit: 4,
  explore_domain: 3,
  explore_invariant: 2,
  recover: 1
};

function fakeModel(
  handler: (request: ModelRequest) => ModelResponse
): IModelAdapter & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    complete: async (request) => {
      requests.push(request);
      return handler(request);
    }
  };
}

function candidate(actionKey: string): JitCandidate<unknown> {
  return { actionKey, baseLogit: 0, source: 'llm', payload: {} };
}

describe('verbalizedLogit (plan section 3.2)', () => {
  it('computes the exact smoothed log formula', () => {
    // ln(50.01 / 100.01) = ln(0.50004999...) = -0.6930472
    expect(verbalizedLogit(0.5)).toBeCloseTo(-0.69305, 4);
    // conf 0 clamps to 1e-6: ln((0.0001 + 0.01) / 100.01) = -9.2004901
    expect(verbalizedLogit(0)).toBeCloseTo(-9.20049, 4);
    // conf 1 clamps to 1 - 1e-6: ln((99.9999 + 0.01) / 100.01) ~ -1e-6
    expect(verbalizedLogit(1)).toBeCloseTo(-0.000001, 5);
  });

  it('is strictly monotonic in the confidence', () => {
    let previous = verbalizedLogit(0);
    for (let step = 1; step <= 20; step += 1) {
      const current = verbalizedLogit(step / 20);
      expect(current).toBeGreaterThan(previous);
      previous = current;
    }
  });

  it('clamps out-of-range and non-finite inputs deterministically', () => {
    expect(verbalizedLogit(-1)).toBe(verbalizedLogit(0));
    expect(verbalizedLogit(2)).toBe(verbalizedLogit(1));
    expect(verbalizedLogit(Number.NaN)).toBe(verbalizedLogit(0));
    expect(verbalizedLogit(Number.POSITIVE_INFINITY)).toBe(verbalizedLogit(1));
    expect(Number.isFinite(verbalizedLogit(Number.NaN))).toBe(true);
  });

  it('honours explicit delta and k, and guards non-finite ones', () => {
    expect(verbalizedLogit(0.5, 0.01, 1)).toBe(verbalizedLogit(0.5));
    expect(verbalizedLogit(0.5, Number.NaN, Number.NaN)).toBe(verbalizedLogit(0.5));
    // delta = 1, k = 1: ln(51 / 101) = -0.6832949
    expect(verbalizedLogit(0.5, 1, 1)).toBeCloseTo(-0.68329, 4);
  });
});

describe('policyPriorLogit (plan section 3.1)', () => {
  it('logs the normalized slot share', () => {
    expect(policyPriorLogit(WEIGHTS, 'exploit')).toBeCloseTo(Math.log(0.4), 6);
    expect(policyPriorLogit(WEIGHTS, 'recover')).toBeCloseTo(Math.log(0.1), 6);
  });

  it('modulates exploration shares with memory confidence like utilityOf', () => {
    // conf 1: explore_domain share 0.3 * (0.5 + 0.5) = 0.3
    expect(policyPriorLogit(WEIGHTS, 'explore_domain', undefined, 1)).toBeCloseTo(Math.log(0.3), 6);
    // conf 1: explore_invariant share 0.2 * (0.5 + 0.5 * 0) = 0.1
    expect(policyPriorLogit(WEIGHTS, 'explore_invariant', undefined, 1)).toBeCloseTo(Math.log(0.1), 6);
    // conf 0: explore_domain share 0.3 * 0.5 = 0.15
    expect(policyPriorLogit(WEIGHTS, 'explore_domain', undefined, 0)).toBeCloseTo(Math.log(0.15), 6);
    // exploit and recover are never modulated
    expect(policyPriorLogit(WEIGHTS, 'exploit', undefined, 1)).toBeCloseTo(Math.log(0.4), 6);
  });

  it('treats an undefined memory confidence as no modulation', () => {
    expect(policyPriorLogit(WEIGHTS, 'explore_domain')).toBeCloseTo(Math.log(0.3), 6);
  });

  it('divides by the exploration temperature', () => {
    expect(policyPriorLogit(WEIGHTS, 'exploit', 2)).toBeCloseTo(Math.log(0.2), 6);
    // Non-positive or non-finite temperatures are ignored (1).
    expect(policyPriorLogit(WEIGHTS, 'exploit', 0)).toBeCloseTo(Math.log(0.4), 6);
    expect(policyPriorLogit(WEIGHTS, 'exploit', Number.NaN)).toBeCloseTo(Math.log(0.4), 6);
  });

  it('floors zero shares at log(1e-9)', () => {
    const weights = { exploit: 1, explore_domain: 0, explore_invariant: 0, recover: 0 };
    expect(policyPriorLogit(weights, 'explore_domain')).toBe(ZERO_SHARE_LOGIT);
    expect(ZERO_SHARE_LOGIT).toBeCloseTo(-20.7233, 4);
  });

  it('falls back to the frozen default prior for degenerate weights', () => {
    const allZero = { exploit: 0, explore_domain: 0, explore_invariant: 0, recover: 0 };
    expect(policyPriorLogit(allZero, 'exploit')).toBeCloseTo(Math.log(0.4), 6);
    expect(policyPriorLogit(undefined, 'exploit')).toBeCloseTo(Math.log(0.4), 6);
    expect(
      policyPriorLogit({ exploit: -5, explore_domain: Number.NaN, explore_invariant: 0, recover: 0 }, 'exploit')
    ).toBeCloseTo(Math.log(0.4), 6);
  });
});

describe('token logprob source', () => {
  it('degrades to verbalized with a diagnostic when logprobs are unsupported', async () => {
    const model = fakeModel(() => ({ text: 'ok' }));
    const capabilities: LogprobCapabilities = { tokenLogprobs: 'unknown' };
    const source = await createTokenLogprobSource({ model, capabilities });
    expect(source.kind).toBe('verbalized');
    expect(capabilities.tokenLogprobs).toBe('unsupported');
    expect(source.diagnostics().join(' ')).toContain('unsupported');
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.logprobs).toEqual({ topK: 1 });
    expect(source.logitFor({ confidence: 0.5 })).toBeCloseTo(verbalizedLogit(0.5), 10);
    expect(source.logitFor({})).toBe(0);
  });

  it('never throws when the probe request fails', async () => {
    const model = fakeModel(() => {
      throw new Error('provider exploded');
    });
    const capabilities: LogprobCapabilities = { tokenLogprobs: 'unknown' };
    const source = await createTokenLogprobSource({ model, capabilities });
    expect(source.kind).toBe('verbalized');
    expect(capabilities.tokenLogprobs).toBe('unsupported');
    expect(source.logitFor({ confidence: 0.25 })).toBeCloseTo(verbalizedLogit(0.25), 10);
  });

  it('caches a supported verdict and uses the mean token logprob', async () => {
    const model = fakeModel(() => ({
      text: 'ok',
      tokenLogprobs: [
        { token: 'a', logprob: -0.5 },
        { token: 'b', logprob: -1.5 },
        { token: 'c', logprob: Number.NaN }
      ]
    }));
    const capabilities: LogprobCapabilities = { tokenLogprobs: 'unknown' };
    const first = await createTokenLogprobSource({ model, capabilities });
    expect(first.kind).toBe('token');
    expect(capabilities.tokenLogprobs).toBe('supported');
    expect(
      first.logitFor({
        tokenLogprobs: [
          { token: 'a', logprob: -0.5 },
          { token: 'b', logprob: -1.5 }
        ]
      })
    ).toBeCloseTo(-1.0, 10);
    // A second source reusing the cached verdict must not probe again.
    const second = await createTokenLogprobSource({ model, capabilities });
    expect(second.kind).toBe('token');
    expect(model.requests).toHaveLength(1);
  });

  it('falls back gracefully when a supported provider returns no data', async () => {
    const model = fakeModel(() => ({
      text: 'ok',
      tokenLogprobs: [{ token: 'a', logprob: -0.2 }]
    }));
    const source = await createTokenLogprobSource({
      model,
      capabilities: { tokenLogprobs: 'supported' }
    });
    expect(source.logitFor({})).toBe(0);
    expect(source.logitFor({ confidence: 0.5 })).toBeCloseTo(verbalizedLogit(0.5), 10);
  });
});

describe('auto logit source', () => {
  it('resolves verbalized mode directly', async () => {
    const source = await createAutoLogitSource({ logitSource: 'verbalized' });
    expect(source.logitFor(candidate('patch:x'), { confidence: 0.25 })).toBeCloseTo(verbalizedLogit(0.25), 10);
    expect(source.resolved()).toBe('verbalized');
    expect(source.logitFor(candidate('patch:x'), {})).toBe(0);
  });

  it('prefers token data, then confidence, then the policy prior, then neutral', async () => {
    const model = fakeModel(() => ({ text: 'ok' }));
    const source = await createAutoLogitSource({
      logitSource: 'auto',
      model,
      capabilities: { tokenLogprobs: 'unknown' }
    });
    // Probe concluded unsupported, so token data alone yields the neutral
    // 0 with an honest 'neutral' resolution.
    expect(
      source.logitFor(candidate('a'), { tokenLogprobs: [{ token: 'x', logprob: -2 }] })
    ).toBeCloseTo(0, 10);
    expect(source.resolved()).toBe('neutral');
    expect(source.logitFor(candidate('b'), { confidence: 0.5 })).toBeCloseTo(verbalizedLogit(0.5), 10);
    expect(source.resolved()).toBe('verbalized');
    expect(
      source.logitFor(candidate('c'), { slotWeights: WEIGHTS, slotKind: 'exploit' })
    ).toBeCloseTo(Math.log(0.4), 6);
    expect(source.resolved()).toBe('policy_prior');
    expect(source.logitFor(candidate('d'), {})).toBe(0);
    expect(source.resolved()).toBe('neutral');
  });

  it('uses token logprobs in auto mode when supported', async () => {
    const model = fakeModel(() => ({
      text: 'ok',
      tokenLogprobs: [{ token: 'a', logprob: -0.25 }, { token: 'b', logprob: -0.75 }]
    }));
    const source = await createAutoLogitSource({
      logitSource: 'auto',
      model,
      capabilities: { tokenLogprobs: 'unknown' }
    });
    expect(
      source.logitFor(candidate('a'), {
        tokenLogprobs: [{ token: 'x', logprob: -0.25 }, { token: 'y', logprob: -0.75 }]
      })
    ).toBeCloseTo(-0.5, 10);
    expect(source.resolved()).toBe('token');
  });

  it('degrades token mode without a model adapter and records a diagnostic', async () => {
    const source = await createAutoLogitSource({ logitSource: 'token' });
    expect(source.diagnostics().join(' ')).toContain('degraded');
    expect(source.logitFor(candidate('a'), { confidence: 0.75 })).toBeCloseTo(verbalizedLogit(0.75), 10);
    expect(source.resolved()).toBe('verbalized');
  });

  it('keeps diagnostics deterministic and free of candidate payloads', async () => {
    const model = fakeModel(() => ({ text: 'ok' }));
    const source = await createAutoLogitSource({
      logitSource: 'auto',
      model,
      capabilities: { tokenLogprobs: 'unknown' }
    });
    const lines = source.diagnostics();
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('payload');
  });
});