/**
 * P1-3 logit adjuster and decision composition.
 *
 * Mandatory acceptance: the plan section 8 / paper Figure 2 reproduction
 * (experiences (a1,-1), (a1,-3), (a2,+2), (a2,+4), (a3,+1) with base logits
 * 0.6/0.3/0.1 and beta = 1 chooses a2) and KL monotonicity in beta.
 */
import { describe, expect, it } from 'vitest';
import type {
  AbstractState,
  ExperienceRecord,
  JitAdjustment,
  JitCandidate,
  ScoredExperience
} from '../../../src/types/contracts';
import { retrieveNeighbors } from '../../../src/jitrl/retriever';
import {
  adjustLogits,
  centerLogits,
  composeDecision,
  decide,
  klDivergence,
  softmax,
  type DecideOptions
} from '../../../src/jitrl/logit-adjuster';

const T0 = 1_700_000_000_000;

const STATE: AbstractState = {
  level: 'meta',
  bucket: 'signature|medium',
  tokens: ['task:search', 'cx:medium'],
  summary: 'meta|signature|medium'
};

const CANDIDATES: readonly JitCandidate<string>[] = [
  { actionKey: 'a1', baseLogit: 0.6, source: 'llm', payload: 'a1' },
  { actionKey: 'a2', baseLogit: 0.3, source: 'llm', payload: 'a2' },
  { actionKey: 'a3', baseLogit: 0.1, source: 'llm', payload: 'a3' }
];

function makeRecord(id: string, actionKey: string, value: number): ExperienceRecord {
  return {
    id,
    level: 'meta',
    state: STATE,
    actionKey,
    reward: value,
    return: value,
    rewardSources: {},
    guidance: 'memory',
    policyId: 'policy',
    sessionId: 'session',
    createdAt: T0,
    redacted: true
  };
}

/** Plan section 8 / paper Figure 2 neighbourhood: returns (a1,-1),(a1,-3),(a2,2),(a2,4),(a3,1). */
const FIGURE_RECORDS: readonly ExperienceRecord[] = [
  makeRecord('e1', 'a1', -1),
  makeRecord('e2', 'a1', -3),
  makeRecord('e3', 'a2', 2),
  makeRecord('e4', 'a2', 4),
  makeRecord('e5', 'a3', 1)
];

const NO_EXPLORE = (): number => 0.99;
const ALWAYS_EXPLORE = (): number => 0;

const FIGURE_OPTIONS: DecideOptions = {
  experiences: FIGURE_RECORDS,
  k: 10,
  similarityThreshold: 0.3,
  beta: 1,
  selection: 'argmax',
  lambda: 0.05,
  alpha: 5,
  unseenFallback: 'zero',
  rng: NO_EXPLORE
};

function byKey(
  decision: { readonly adjustments: readonly JitAdjustment<string>[] },
  actionKey: string
): JitAdjustment<string> {
  const adjustment = decision.adjustments.find(
    (entry) => entry.candidate.actionKey === actionKey
  );
  expect(adjustment).toBeDefined();
  return adjustment as JitAdjustment<string>;
}

describe('softmax and logit helpers', () => {
  it('normalizes uniformly and is numerically stable for huge logits', () => {
    expect(softmax([0, 0])).toEqual([0.5, 0.5]);
    const stable = softmax([1000, 1000]);
    expect(stable[0]).toBeCloseTo(0.5, 12);
    expect(Number.isFinite(stable[0] as number)).toBe(true);
  });

  it('returns an empty distribution for empty input and rejects non-finite logits', () => {
    expect(softmax([])).toEqual([]);
    expect(() => softmax([Number.NaN])).toThrow(RangeError);
    expect(() => softmax([Number.POSITIVE_INFINITY])).toThrow(RangeError);
    expect(() => softmax([1, Number.NEGATIVE_INFINITY])).toThrow(RangeError);
  });

  it('produces ordered probabilities that sum to 1', () => {
    const probabilities = softmax([1, 2, 3]);
    const total = probabilities.reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 12);
    expect(probabilities[0] as number).toBeLessThan(probabilities[1] as number);
    expect(probabilities[1] as number).toBeLessThan(probabilities[2] as number);
  });

  it('centres logits per decision without changing the softmax', () => {
    expect(centerLogits([1, 2, 3])).toEqual([-1, 0, 1]);
    expect(centerLogits([])).toEqual([]);
    const centered = softmax(centerLogits([0.6, 0.3, 0.1]));
    const direct = softmax([0.6, 0.3, 0.1]);
    for (let index = 0; index < direct.length; index += 1) {
      expect(centered[index] as number).toBeCloseTo(direct[index] as number, 12);
    }
    expect(() => centerLogits([Number.NaN])).toThrow(RangeError);
  });

  it('computes KL divergence and guards degenerate inputs', () => {
    expect(klDivergence([0.5, 0.5], [0.5, 0.5])).toBe(0);
    expect(klDivergence([0.5, 0.5], [0.25, 0.75])).toBeCloseTo(0.143841, 6);
    expect(klDivergence([1, 0], [0.5, 0.5])).toBeCloseTo(Math.LN2, 12);
    expect(klDivergence([1, 0], [0, 1])).toBe(Number.POSITIVE_INFINITY);
    expect(() => klDivergence([1], [1, 0])).toThrow(RangeError);
    expect(() => klDivergence([-0.1, 1.1], [0.5, 0.5])).toThrow(RangeError);
    expect(() => klDivergence([Number.NaN, 1], [0.5, 0.5])).toThrow(RangeError);
  });
});

describe('adjustLogits', () => {
  it('returns center(z) + beta * A-tilde for the Figure 2 advantages', () => {
    const adjusted = adjustLogits(
      CANDIDATES,
      [-2.6, 2.4, 0.4],
      1
    );
    expect(adjusted[0]).toBeCloseTo(-0.733333, 5);
    expect(adjusted[1]).toBeCloseTo(0.889744, 5);
    expect(adjusted[2]).toBeCloseTo(-0.079487, 5);
  });

  it('is the identity on centred logits when beta is 0', () => {
    expect(adjustLogits(CANDIDATES, [-2.6, 2.4, 0.4], 0)).toEqual(
      centerLogits(CANDIDATES.map((candidate) => candidate.baseLogit))
    );
  });

  it('rejects mismatched lengths and invalid beta', () => {
    expect(() => adjustLogits(CANDIDATES, [1, 2], 1)).toThrow(RangeError);
    expect(() => adjustLogits(CANDIDATES, [1, 2, 3], -1)).toThrow(RangeError);
    expect(() => adjustLogits(CANDIDATES, [1, 2, 3], Number.NaN)).toThrow(RangeError);
  });
});

describe('decide: paper Figure 2 reproduction', () => {
  it('chooses a2 for beta = 1 and reports the expected V, Q and A-tilde', () => {
    const decision = decide('meta', STATE, CANDIDATES, FIGURE_OPTIONS);

    expect(decision.level).toBe('meta');
    expect(decision.neighborCount).toBe(5);
    expect(decision.stateValue).toBeCloseTo(0.6, 12);
    expect(decision.chosen.candidate.actionKey).toBe('a2');

    const a1 = byKey(decision, 'a1');
    const a2 = byKey(decision, 'a2');
    const a3 = byKey(decision, 'a3');

    expect(a1.q).toBe(-2);
    expect(a2.q).toBe(3);
    expect(a3.q).toBe(1);
    expect(a1.support).toBe(2);
    expect(a2.support).toBe(2);
    expect(a3.support).toBe(1);
    expect(a1.advantage).toBeCloseTo(-2.6, 12);
    expect(a2.advantage).toBeCloseTo(2.4, 12);
    expect(a3.advantage).toBeCloseTo(0.4, 12);
    expect(a2.normalizedAdvantage).toBeGreaterThan(0);
    expect(a2.normalizedAdvantage).toBeCloseTo(2.4 / 2.600001, 6);
    expect(a1.normalizedAdvantage).toBeLessThan(0);

    // Deviation from the task brief, which asked to assert a3's A-tilde <= 0:
    // that is mathematically impossible for these numbers because a3's return
    // (+1) is above V-hat (0.6), so its advantage is +0.4. The paper-figure
    // invariant that actually matters is that a3's corrected logit stays
    // negative and it cannot beat a2.
    expect(a3.normalizedAdvantage).toBeGreaterThan(0);
    expect(a3.adjustedLogit).toBeLessThan(0);
    expect(a3.adjustedLogit).toBeLessThan(a2.adjustedLogit);

    const probabilityTotal = decision.adjustments.reduce(
      (sum, adjustment) => sum + adjustment.probability,
      0
    );
    expect(probabilityTotal).toBeCloseTo(1, 12);
    expect(a2.probability).toBeGreaterThan(a1.probability);
    expect(a2.probability).toBeGreaterThan(a3.probability);
    expect(decision.klToPrior).toBeGreaterThan(0);
    expect(decision.rationale).toContain('neighbors=5');
    expect(decision.rationale).toContain('chosen=a2');
    expect(decision.rationale).toContain('kl=');
  });

  it('falls back to the prior argmax when beta = 0', () => {
    const decision = decide('meta', STATE, CANDIDATES, {
      ...FIGURE_OPTIONS,
      beta: 0
    });
    expect(decision.chosen.candidate.actionKey).toBe('a1');
    expect(decision.klToPrior).toBeCloseTo(0, 12);
    expect(decision.adjustments[0]?.probability).toBeCloseTo(0.426, 3);
    for (let index = 0; index < CANDIDATES.length; index += 1) {
      expect(decision.adjustments[index]?.adjustedLogit).toBeCloseTo(
        (CANDIDATES[index]?.baseLogit as number) - 1 / 3,
        6
      );
    }
  });

  it('increases KL(pi_prime || pi_prior) monotonically with beta', () => {
    const betas = [0, 0.5, 1, 2, 4];
    const divergences = betas.map(
      (beta) => decide('meta', STATE, CANDIDATES, { ...FIGURE_OPTIONS, beta }).klToPrior
    );
    expect(divergences[0] as number).toBeCloseTo(0, 12);
    for (let index = 1; index < divergences.length; index += 1) {
      expect(divergences[index] as number).toBeGreaterThanOrEqual(
        (divergences[index - 1] as number) - 1e-12
      );
    }
    // Strictly increasing between beta = 0 and beta = 1 (index 2 is beta = 1).
    expect(divergences[2] as number).toBeGreaterThan((divergences[0] as number) + 1e-6);
    for (const beta of betas.slice(1)) {
      expect(
        decide('meta', STATE, CANDIDATES, { ...FIGURE_OPTIONS, beta }).chosen.candidate
          .actionKey
      ).toBe('a2');
    }
  });
});

describe('decide: zero advantages and cold start', () => {
  it('keeps the prior distribution when the candidate set has no evidence', () => {
    const decision = decide('meta', STATE, CANDIDATES, {
      experiences: [],
      k: 10,
      similarityThreshold: 0.3,
      beta: 1,
      selection: 'argmax',
      lambda: 0.05,
      alpha: 5,
      unseenFallback: 'baseline',
      rng: NO_EXPLORE
    });
    expect(decision.neighborCount).toBe(0);
    expect(decision.stateValue).toBe(0);
    expect(decision.klToPrior).toBe(0);
    for (const adjustment of decision.adjustments) {
      expect(adjustment.normalizedAdvantage).toBe(0);
      expect(adjustment.q).toBeNull();
      expect(adjustment.support).toBe(0);
      expect(adjustment.explored).toBe(false);
    }
    expect(decision.adjustments[0]?.probability).toBeCloseTo(0.426, 3);
    expect(decision.adjustments[1]?.probability).toBeCloseTo(0.3156, 3);
    expect(decision.adjustments[2]?.probability).toBeCloseTo(0.2584, 3);
    expect(decision.chosen.candidate.actionKey).toBe('a1');
  });

  it('keeps the prior when all supported actions tie at the state value', () => {
    const neighbors: readonly ScoredExperience[] = [
      {
        record: makeRecord('t1', 'a1', 1),
        similarity: 1,
        weight: 1
      },
      {
        record: makeRecord('t2', 'a2', 1),
        similarity: 1,
        weight: 1
      }
    ];
    const candidates: readonly JitCandidate<string>[] = [
      { actionKey: 'a1', baseLogit: 0.6, source: 'llm', payload: 'a1' },
      { actionKey: 'a2', baseLogit: 0.3, source: 'llm', payload: 'a2' }
    ];
    const decision = composeDecision('meta', STATE, neighbors, candidates, {
      beta: 2
    });
    expect(decision.stateValue).toBe(1);
    expect(decision.klToPrior).toBe(0);
    expect(decision.chosen.candidate.actionKey).toBe('a1');
    expect(decision.adjustments.every((entry) => entry.normalizedAdvantage === 0)).toBe(
      true
    );
    expect(decision.adjustments[0]?.q).toBe(1);
    expect(decision.adjustments[0]?.support).toBe(1);
  });

  it('handles a single action analytically', () => {
    const single: readonly JitCandidate<string>[] = [
      { actionKey: 'only', baseLogit: 2, source: 'policy_prior', payload: 'only' }
    ];
    const decision = decide('meta', STATE, single, {
      experiences: [],
      beta: 1,
      rng: NO_EXPLORE
    });
    expect(decision.chosen.candidate.actionKey).toBe('only');
    expect(decision.chosen.probability).toBeCloseTo(1, 12);
    expect(decision.klToPrior).toBe(0);
    expect(decision.neighborCount).toBe(0);
  });
});

describe('decide: selection rules', () => {
  it('breaks adjusted-logit ties by ascending actionKey', () => {
    const candidates: readonly JitCandidate<string>[] = [
      { actionKey: 'b', baseLogit: 0.5, source: 'llm', payload: 'b' },
      { actionKey: 'a', baseLogit: 0.5, source: 'llm', payload: 'a' }
    ];
    // Both actions have the same support and return, so A-tilde is 0 for both.
    const neighbors: readonly ScoredExperience[] = [
      { record: makeRecord('n1', 'a', 2), similarity: 1, weight: 1 },
      { record: makeRecord('n2', 'b', 2), similarity: 1, weight: 1 }
    ];
    const decision = composeDecision('meta', STATE, neighbors, candidates, {
      beta: 1
    });
    expect(decision.chosen.candidate.actionKey).toBe('a');
  });

  it('samples deterministically from softmax(z_prime) with an injected rng', () => {
    const argmaxDecision = decide('meta', STATE, CANDIDATES, FIGURE_OPTIONS);
    const probabilities = argmaxDecision.adjustments.map(
      (adjustment) => adjustment.probability
    );
    const p0 = probabilities[0] as number;
    const p1 = probabilities[1] as number;
    const chosenWith = (draw: number): string =>
      decide('meta', STATE, CANDIDATES, {
        ...FIGURE_OPTIONS,
        selection: 'sample',
        rng: () => draw
      }).chosen.candidate.actionKey;

    expect(chosenWith(p0 / 2)).toBe('a1');
    expect(chosenWith(p0 + p1 / 2)).toBe('a2');
    expect(chosenWith(0.999999)).toBe('a3');
  });

  it('consumes exploration draws before the selection draw', () => {
    // Three unsupported actions draw once each; the fourth draw selects.
    const draws = [0.9, 0.9, 0.9, 0.99];
    let calls = 0;
    const decision = decide('meta', STATE, CANDIDATES, {
      experiences: [],
      beta: 1,
      selection: 'sample',
      lambda: 0.05,
      alpha: 5,
      unseenFallback: 'baseline',
      rng: () => draws[calls++] ?? 0.99
    });
    expect(calls).toBe(4);
    expect(decision.chosen.candidate.actionKey).toBe('a3');
    expect(decision.adjustments.every((entry) => entry.explored === false)).toBe(true);
  });

  it('does not draw randomness during argmax when every action is supported', () => {
    const decision = decide('meta', STATE, CANDIDATES, {
      ...FIGURE_OPTIONS,
      rng: () => {
        throw new Error('rng must not be called for fully supported argmax');
      }
    });
    expect(decision.chosen.candidate.actionKey).toBe('a2');
  });
});

describe('decide: composition and validation', () => {
  it('composes retrieval and pre-scored neighbours identically', () => {
    const retrieved = retrieveNeighbors(FIGURE_RECORDS, STATE, {
      k: 10,
      similarityThreshold: 0.3
    });
    const viaExperiences = decide('meta', STATE, CANDIDATES, FIGURE_OPTIONS);
    const viaNeighbors = decide('meta', STATE, CANDIDATES, {
      ...FIGURE_OPTIONS,
      experiences: undefined,
      neighbors: retrieved
    });
    const viaCompose = composeDecision('meta', STATE, retrieved, CANDIDATES, {
      beta: 1,
      selection: 'argmax',
      lambda: 0.05,
      alpha: 5,
      unseenFallback: 'zero',
      rng: NO_EXPLORE
    });
    expect(viaNeighbors).toEqual(viaExperiences);
    expect(viaCompose).toEqual(viaExperiences);
  });

  it('rejects empty candidates, duplicate keys, non-finite logits and level mismatch', () => {
    expect(() => decide('meta', STATE, [], { experiences: [], rng: NO_EXPLORE })).toThrow(
      RangeError
    );
    expect(() =>
      decide(
        'meta',
        STATE,
        [
          { actionKey: 'a', baseLogit: 0, source: 'llm', payload: 1 },
          { actionKey: 'a', baseLogit: 1, source: 'llm', payload: 2 }
        ],
        { experiences: [], rng: NO_EXPLORE }
      )
    ).toThrow(RangeError);
    expect(() =>
      decide(
        'meta',
        STATE,
        [{ actionKey: 'a', baseLogit: Number.POSITIVE_INFINITY, source: 'llm', payload: 1 }],
        { experiences: [], rng: NO_EXPLORE }
      )
    ).toThrow(RangeError);
    expect(() => decide('proposal', STATE, CANDIDATES, { experiences: [] })).toThrow(
      RangeError
    );
  });

  it('requires exactly one experience source', () => {
    const neighbors = retrieveNeighbors(FIGURE_RECORDS, STATE, {
      k: 10,
      similarityThreshold: 0.3
    });
    expect(() => decide('meta', STATE, CANDIDATES, {})).toThrow(TypeError);
    expect(() =>
      decide('meta', STATE, CANDIDATES, {
        experiences: FIGURE_RECORDS,
        neighbors
      })
    ).toThrow(TypeError);
  });

  it('rejects a non-finite beta or rng draw', () => {
    expect(() =>
      decide('meta', STATE, CANDIDATES, { ...FIGURE_OPTIONS, beta: Number.NaN })
    ).toThrow(RangeError);
    expect(() =>
      decide('meta', STATE, CANDIDATES, {
        ...FIGURE_OPTIONS,
        selection: 'sample',
        rng: () => Number.NaN
      })
    ).toThrow(RangeError);
  });

  it('supports the sample selection with a 0 draw selecting the first action', () => {
    expect(
      decide('meta', STATE, CANDIDATES, { ...FIGURE_OPTIONS, selection: 'sample', rng: () => 0 })
        .chosen.candidate.actionKey
    ).toBe('a1');
  });
});
