/**
 * P1-3 value estimator: weighted means, V/Q estimation, both unseen-action
 * fallbacks, optimistic exploration with an injected rng, normalized
 * advantages with the epsilon guard, and numeric-safety behaviour.
 */
import { describe, expect, it } from 'vitest';
import type {
  AbstractState,
  ExperienceRecord,
  JitCandidate,
  JitLevel,
  ScoredExperience
} from '../../../src/types/contracts';
import {
  ADVANTAGE_EPSILON,
  conservativeAdvantage,
  effectiveSampleSize,
  estimateActionValues,
  estimateActionValuesWithContract,
  estimateStateValue,
  normalizeAdvantages,
  selectNeighbors,
  weightedMean,
  type ActionValueEstimate,
  type ValueEstimatorConfig
} from '../../../src/jitrl/value-estimator';
import {
  REWARD_CONTRACT,
  consumedTargetFieldOf,
  estimatorTargetLine,
  isRewardVersionBump,
  readLearningTarget,
  requiresExperienceRebuild
} from '../../../src/jitrl/reward-contract';

const T0 = 1_700_000_000_000;
const CONFIG: ValueEstimatorConfig = {
  lambda: 0.05,
  alpha: 5,
  unseenFallback: 'baseline'
};

function makeState(
  bucket = 'bucket-a',
  tokens: readonly string[] = ['x', 'y'],
  level: JitLevel = 'meta'
): AbstractState {
  return { level, bucket, tokens, summary: 'summary' };
}

const STATE = makeState();

interface NeighborInput {
  readonly id: string;
  readonly actionKey: string;
  readonly value: number;
  readonly similarity?: number;
  readonly weight?: number;
  readonly level?: JitLevel;
}

function makeRecord(input: NeighborInput): ExperienceRecord {
  return {
    id: input.id,
    level: input.level ?? 'meta',
    state: makeState('bucket-a', ['x', 'y'], input.level ?? 'meta'),
    actionKey: input.actionKey,
    reward: input.value,
    return: input.value,
    rewardSources: {},
    guidance: 'memory',
    policyId: 'policy',
    sessionId: 'session',
    createdAt: T0,
    redacted: true
  };
}

function scored(input: NeighborInput): ScoredExperience {
  const base: ScoredExperience = {
    record: makeRecord(input),
    similarity: input.similarity ?? 1
  };
  return input.weight === undefined ? base : { ...base, weight: input.weight };
}

/** Plan section 8 / paper Figure 2 neighbourhood. */
function figureNeighbors(): readonly ScoredExperience[] {
  return [
    scored({ id: 'e1', actionKey: 'a1', value: -1 }),
    scored({ id: 'e2', actionKey: 'a1', value: -3 }),
    scored({ id: 'e3', actionKey: 'a2', value: 2 }),
    scored({ id: 'e4', actionKey: 'a2', value: 4 }),
    scored({ id: 'e5', actionKey: 'a3', value: 1 })
  ];
}

function figureCandidates(): readonly JitCandidate<string>[] {
  return [
    { actionKey: 'a1', baseLogit: 0.6, source: 'llm', payload: 'a1' },
    { actionKey: 'a2', baseLogit: 0.3, source: 'llm', payload: 'a2' },
    { actionKey: 'a3', baseLogit: 0.1, source: 'llm', payload: 'a3' }
  ];
}

function byActionKey(
  estimates: readonly ActionValueEstimate[],
  actionKey: string
): ActionValueEstimate {
  const estimate = estimates.find((entry) => entry.actionKey === actionKey);
  expect(estimate).toBeDefined();
  return estimate as ActionValueEstimate;
}

describe('weightedMean', () => {
  it('averages uniformly and by weight', () => {
    expect(weightedMean([1, 3], [1, 1])).toBe(2);
    expect(weightedMean([1, 3], [0.25, 0.75])).toBe(2.5);
  });

  it('returns 0 for an empty input', () => {
    expect(weightedMean([], [])).toBe(0);
  });

  it('falls back to the arithmetic mean when every weight is zero', () => {
    expect(weightedMean([2, 4], [0, 0])).toBe(3);
  });

  it('rejects mismatched lengths and invalid numbers', () => {
    expect(() => weightedMean([1], [1, 2])).toThrow(RangeError);
    expect(() => weightedMean([Number.NaN], [1])).toThrow(RangeError);
    expect(() => weightedMean([1], [Number.POSITIVE_INFINITY])).toThrow(RangeError);
    expect(() => weightedMean([1], [-1])).toThrow(RangeError);
  });
});

describe('selectNeighbors', () => {
  it('keeps only same-level, finite-return, positive-weight neighbours', () => {
    const selected = selectNeighbors(STATE, [
      scored({ id: 'ok', actionKey: 'a1', value: 1 }),
      scored({ id: 'other-level', actionKey: 'a2', value: 1, level: 'proposal' }),
      scored({ id: 'nan', actionKey: 'a3', value: Number.NaN }),
      scored({ id: 'zero-weight', actionKey: 'a4', value: 1, weight: 0 })
    ]);
    expect(selected.map((entry) => entry.record.id)).toEqual(['ok']);
  });
});

describe('estimateStateValue', () => {
  it('uses retrieval weights when present and similarity otherwise', () => {
    const neighbors = [
      scored({ id: 'a', actionKey: 'a1', value: 1, weight: 3 }),
      scored({ id: 'b', actionKey: 'a2', value: 5, weight: 1 })
    ];
    expect(estimateStateValue(neighbors)).toBe(2);
    expect(
      estimateStateValue([
        scored({ id: 'c', actionKey: 'a1', value: 1, similarity: 0.25 }),
        scored({ id: 'd', actionKey: 'a2', value: 5, similarity: 0.75 })
      ])
    ).toBe(4);
  });

  it('returns 0 for an empty or unusable neighbourhood', () => {
    expect(estimateStateValue([])).toBe(0);
    expect(
      estimateStateValue([scored({ id: 'nan', actionKey: 'a1', value: Number.NaN })])
    ).toBe(0);
  });
});

describe('estimateActionValues', () => {
  it('reproduces the Figure 2 state and action values', () => {
    const estimates = estimateActionValues(
      STATE,
      figureNeighbors(),
      figureCandidates(),
      { ...CONFIG, unseenFallback: 'zero' }
    );
    expect(estimateStateValue(figureNeighbors())).toBeCloseTo(0.6, 12);
    expect(byActionKey(estimates, 'a1')).toMatchObject({
      q: -2,
      support: 2,
      explored: false
    });
    expect(byActionKey(estimates, 'a2')).toMatchObject({ q: 3, support: 2 });
    expect(byActionKey(estimates, 'a3')).toMatchObject({ q: 1, support: 1 });
    expect(byActionKey(estimates, 'a1').advantage).toBeCloseTo(-2.6, 12);
    expect(byActionKey(estimates, 'a2').advantage).toBeCloseTo(2.4, 12);
    expect(byActionKey(estimates, 'a3').advantage).toBeCloseTo(0.4, 12);
  });

  it('ignores neighbours from another level (no cross-level contamination)', () => {
    const neighbors = [
      scored({ id: 'meta-1', actionKey: 'a1', value: -1 }),
      scored({ id: 'meta-2', actionKey: 'a1', value: -3 }),
      scored({ id: 'foreign', actionKey: 'a2', value: 100, level: 'proposal' })
    ];
    const estimates = estimateActionValues(
      STATE,
      neighbors,
      figureCandidates(),
      CONFIG,
      () => 0.99
    );
    expect(byActionKey(estimates, 'a1').q).toBe(-2);
    // a2 only exists at the proposal level, so it is unseen for this meta state.
    expect(byActionKey(estimates, 'a2')).toMatchObject({
      q: null,
      support: 0,
      explored: false,
      advantage: 0
    });
  });

  it("returns A = 0 for the default 'baseline' fallback", () => {
    const estimates = estimateActionValues(
      STATE,
      figureNeighbors(),
      [...figureCandidates(), { actionKey: 'a4', baseLogit: 0, source: 'policy_prior', payload: 'a4' }],
      CONFIG,
      () => 0.99
    );
    expect(byActionKey(estimates, 'a4')).toMatchObject({
      q: null,
      support: 0,
      explored: false
    });
    expect(byActionKey(estimates, 'a4').advantage).toBeCloseTo(0, 12);
  });

  it("returns A = -V for the paper's 'zero' fallback", () => {
    const estimates = estimateActionValues(
      STATE,
      figureNeighbors(),
      [...figureCandidates(), { actionKey: 'a4', baseLogit: 0, source: 'policy_prior', payload: 'a4' }],
      { ...CONFIG, unseenFallback: 'zero' },
      () => 0.99
    );
    expect(byActionKey(estimates, 'a4').advantage).toBeCloseTo(-0.6, 12);
  });

  it('adds the optimistic bonus V + alpha / max(1, |N|) when the rng explores', () => {
    const estimates = estimateActionValues(
      STATE,
      figureNeighbors(),
      [{ actionKey: 'a4', baseLogit: 0, source: 'policy_prior', payload: 'a4' }],
      CONFIG,
      () => 0
    );
    const explored = byActionKey(estimates, 'a4');
    expect(explored.explored).toBe(true);
    expect(explored.q).toBeCloseTo(0.6 + 5 / 5, 12);
    expect(explored.advantage).toBeCloseTo(1, 12);
  });

  it('uses max(1, |N|) so an empty neighbourhood still explores', () => {
    const estimates = estimateActionValues(
      STATE,
      [],
      [{ actionKey: 'a1', baseLogit: 0, source: 'llm', payload: 'a1' }],
      CONFIG,
      () => 0
    );
    expect(byActionKey(estimates, 'a1')).toMatchObject({ q: 5, explored: true, support: 0 });
  });

  it('draws exactly once per unsupported action, in candidate order', () => {
    const draws = [0.9, 0];
    let calls = 0;
    const estimates = estimateActionValues(
      STATE,
      figureNeighbors(),
      [
        { actionKey: 'a4', baseLogit: 0, source: 'policy_prior', payload: 'a4' },
        { actionKey: 'a5', baseLogit: 0, source: 'policy_prior', payload: 'a5' }
      ],
      CONFIG,
      () => draws[calls++] ?? 0.9
    );
    expect(calls).toBe(2);
    expect(byActionKey(estimates, 'a4').explored).toBe(false);
    expect(byActionKey(estimates, 'a5').explored).toBe(true);
    expect(byActionKey(estimates, 'a5').q).toBeCloseTo(0.6 + 5 / 5, 12);
  });

  it('treats lambda = 0 and lambda = 1 as hard boundaries', () => {
    const candidate: readonly JitCandidate<string>[] = [
      { actionKey: 'a4', baseLogit: 0, source: 'policy_prior', payload: 'a4' }
    ];
    const never = estimateActionValues(
      STATE,
      figureNeighbors(),
      candidate,
      { ...CONFIG, lambda: 0 },
      () => 0
    );
    expect(byActionKey(never, 'a4').explored).toBe(false);
    const always = estimateActionValues(
      STATE,
      figureNeighbors(),
      candidate,
      { ...CONFIG, lambda: 1 },
      () => 0.999999
    );
    expect(byActionKey(always, 'a4').explored).toBe(true);
  });

  it('preserves candidate order and supports duplicate action keys', () => {
    const estimates = estimateActionValues(
      STATE,
      figureNeighbors(),
      [
        { actionKey: 'a2', baseLogit: 0, source: 'llm', payload: 1 },
        { actionKey: 'a1', baseLogit: 0, source: 'llm', payload: 2 },
        { actionKey: 'a2', baseLogit: 0, source: 'policy_prior', payload: 3 }
      ],
      CONFIG
    );
    expect(estimates.map((entry) => entry.actionKey)).toEqual(['a2', 'a1', 'a2']);
    expect(estimates[0]?.support).toBe(2);
    expect(estimates[2]?.support).toBe(2);
  });

  it('skips non-finite returns instead of poisoning the average', () => {
    const estimates = estimateActionValues(
      STATE,
      [
        scored({ id: 'nan', actionKey: 'a1', value: Number.NaN }),
        scored({ id: 'ok', actionKey: 'a1', value: -1 })
      ],
      [{ actionKey: 'a1', baseLogit: 0, source: 'llm', payload: 'a1' }],
      CONFIG
    );
    expect(byActionKey(estimates, 'a1')).toMatchObject({ q: -1, support: 1 });
  });

  it('rejects invalid config and non-finite rng draws', () => {
    const candidate: readonly JitCandidate<string>[] = [
      { actionKey: 'a4', baseLogit: 0, source: 'policy_prior', payload: 'a4' }
    ];
    expect(() =>
      estimateActionValues(STATE, [], candidate, { ...CONFIG, lambda: -0.1 })
    ).toThrow(RangeError);
    expect(() =>
      estimateActionValues(STATE, [], candidate, { ...CONFIG, lambda: 1.1 })
    ).toThrow(RangeError);
    expect(() =>
      estimateActionValues(STATE, [], candidate, { ...CONFIG, alpha: -1 })
    ).toThrow(RangeError);
    expect(() =>
      estimateActionValues(STATE, [], candidate, {
        ...CONFIG,
        unseenFallback: 'bogus' as never
      })
    ).toThrow(RangeError);
    expect(() =>
      estimateActionValues(STATE, [], candidate, CONFIG, () => Number.NaN)
    ).toThrow(RangeError);
  });
});

describe('normalizeAdvantages', () => {
  it('scales by max |A| + epsilon and preserves signs', () => {
    const normalized = normalizeAdvantages([2.6, -2.6, 0.4]);
    expect(normalized[0]).toBeCloseTo(2.6 / (2.6 + ADVANTAGE_EPSILON), 12);
    expect(normalized[1]).toBeCloseTo(-2.6 / (2.6 + ADVANTAGE_EPSILON), 12);
    expect(normalized[2]).toBeCloseTo(0.4 / (2.6 + ADVANTAGE_EPSILON), 12);
    expect(Math.abs(normalized[0] as number)).toBeLessThan(1);
  });

  it('returns zeros for empty or all-zero advantages (epsilon guard)', () => {
    expect(normalizeAdvantages([])).toEqual([]);
    expect(normalizeAdvantages([0, 0, 0])).toEqual([0, 0, 0]);
    expect(normalizeAdvantages([0, 0], 0)).toEqual([0, 0]);
  });

  it('handles a single action without producing +-1 division artefacts', () => {
    const [normalized] = normalizeAdvantages([7]);
    expect(normalized).toBeCloseTo(7 / (7 + ADVANTAGE_EPSILON), 12);
    expect(normalized as number).toBeLessThan(1);
  });

  it('reaches +-1 exactly when epsilon is 0', () => {
    expect(normalizeAdvantages([2, -2], 0)).toEqual([1, -1]);
  });

  it('rejects non-finite advantages and invalid epsilon', () => {
    expect(() => normalizeAdvantages([Number.NaN])).toThrow(RangeError);
    expect(() => normalizeAdvantages([Number.POSITIVE_INFINITY])).toThrow(RangeError);
    expect(() => normalizeAdvantages([1], -1)).toThrow(RangeError);
    expect(() => normalizeAdvantages([1], Number.NaN)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// P6.2 PR-B / F4: conservative replacement evidence (estimation != replace)
// ---------------------------------------------------------------------------

describe('P6.2 PR-B: effective sample size', () => {
  it('computes n_eff = (Σw)² / Σw² and shrinks under concentrated weights', () => {
    // Equal weights: n_eff equals the raw count.
    expect(effectiveSampleSize([1, 1, 1, 1])).toBeCloseTo(4, 12);
    // One dominant weight + nine near-zero: "10 records" is n_eff ~ 1.19.
    expect(effectiveSampleSize([1, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01])).toBeCloseTo(
      1.09 * 1.09 / (1 + 9 * 0.0001),
      12
    );
    expect(effectiveSampleSize([0.5, 0.5])).toBeCloseTo(2, 12);
    expect(effectiveSampleSize([2, 2])).toBeCloseTo(2, 12);
  });

  it('returns 0 for empty, all-zero or negative-weight inputs', () => {
    expect(effectiveSampleSize([])).toBe(0);
    expect(effectiveSampleSize([0, 0])).toBe(0);
    expect(effectiveSampleSize([-1, 1])).toBe(1);
  });

  it('is carried on every estimate (nEff participates in the judgement)', () => {
    const supported = estimateActionValues(
      STATE,
      figureNeighbors(),
      figureCandidates(),
      { ...CONFIG, unseenFallback: 'zero' }
    );
    // a1/a2 hold 2 equally-weighted records (n_eff 2); a3 holds 1 (n_eff 1).
    expect(byActionKey(supported, 'a1').nEff).toBeCloseTo(2, 12);
    expect(byActionKey(supported, 'a2').nEff).toBeCloseTo(2, 12);
    expect(byActionKey(supported, 'a3').nEff).toBeCloseTo(1, 12);
    // Unsupported actions carry nEff 0.
    const unsupported = estimateActionValues(
      STATE,
      figureNeighbors(),
      [{ actionKey: 'a4', baseLogit: 0, source: 'policy_prior', payload: 'a4' }],
      CONFIG,
      () => 0.99
    );
    expect(byActionKey(unsupported, 'a4').nEff).toBe(0);
  });
});

describe('P6.2 PR-B: conservativeAdvantage (shrinkage + calibrated scale)', () => {
  it('marks the zero-advantage-without-support artefact (the F4 hole)', () => {
    // The first-harm shape: unsupported action, 'baseline' fallback, A = 0.
    const artefact = conservativeAdvantage({
      actionKey: 'noop',
      q: null,
      support: 0,
      nEff: 0,
      explored: false,
      advantage: 0
    });
    expect(artefact.implicitZeroAdvantage).toBe(true);
    expect(artefact.hasReplacementEvidence).toBe(false);
    expect(artefact.shrunkAdvantage).toBe(0);
    // A supported action with the same advantage is NOT the artefact.
    const supported = conservativeAdvantage({
      actionKey: 'a',
      q: 0.6,
      support: 2,
      nEff: 2,
      explored: false,
      advantage: 0
    });
    expect(supported.implicitZeroAdvantage).toBe(false);
  });

  it('shrinks under-evidenced advantages and calibrates on the fixed scale', () => {
    // n_eff = 2, k = 2: A_shrunk = A * 2/(2+2) = A/2.
    const thin = conservativeAdvantage({
      actionKey: 'a',
      q: 1.6,
      support: 2,
      nEff: 2,
      explored: false,
      advantage: 1.0
    });
    expect(thin.hasReplacementEvidence).toBe(true);
    expect(thin.shrunkAdvantage).toBeCloseTo(0.5, 12);
    // Calibrated: the [-3,3] scale maps a maximal raw advantage to ±1; small
    // noise stays small instead of being max-normalized to ~±1.
    expect(thin.calibratedAdvantage).toBeCloseTo(0.5 / 3, 12);
    const tiny = conservativeAdvantage({
      actionKey: 'a',
      q: 0.05,
      support: 4,
      nEff: 4,
      explored: false,
      advantage: 0.05
    });
    expect(tiny.calibratedAdvantage).toBeCloseTo((0.05 * 4 / 6) / 3, 12);
    expect(Math.abs(tiny.calibratedAdvantage)).toBeLessThan(0.02);
  });

  it('zeroes the suggestion below the evidence floor (estimation != replacement)', () => {
    const below = conservativeAdvantage({
      actionKey: 'a',
      q: 2,
      support: 1,
      nEff: 1,
      explored: false,
      advantage: 1.4
    });
    expect(below.hasReplacementEvidence).toBe(false);
    expect(below.shrunkAdvantage).toBe(0);
    expect(below.calibratedAdvantage).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// P6.1-D: the estimator consumes the RewardContract's target field
// ---------------------------------------------------------------------------

describe('P6.1-D: RewardContract target-field consumption', () => {
  function versionedRecord(input: {
    readonly id: string;
    readonly value: number;
    readonly observedReturn?: number;
    readonly learningTarget?: number;
  }): ExperienceRecord {
    return {
      ...makeRecord({ id: input.id, actionKey: 'a1', value: input.value }),
      ...(input.observedReturn === undefined ? {} : { observedReturn: input.observedReturn }),
      ...(input.learningTarget === undefined ? {} : { learningTarget: input.learningTarget })
    };
  }

  it('reads observedReturn first, falls back to return only for legacy records', () => {
    const current = versionedRecord({
      id: 'cur',
      value: 1,
      observedReturn: 2,
      learningTarget: 5
    });
    // The contract default is observedReturn - NOT the gain (learningTarget),
    // which is the ablation arm.
    expect(consumedTargetFieldOf(current)).toBe('observedReturn');
    expect(readLearningTarget(current)).toBe(2);

    const legacy = versionedRecord({ id: 'leg', value: 1 });
    expect(consumedTargetFieldOf(legacy)).toBe('return');
    expect(readLearningTarget(legacy)).toBe(1);

    const broken = { ...versionedRecord({ id: 'nan', value: 1 }), observedReturn: Number.NaN };
    expect(consumedTargetFieldOf(broken)).toBe('return');
  });

  it('estimateStateValue averages the contract target, not the gain field', () => {
    // Two neighbours whose `return` differs from their observedReturn and whose
    // learningTarget is deliberately extreme: the estimate must use
    // observedReturn (contract default), proving which field was consumed.
    const neighbors = [
      scored({ id: 'n1', actionKey: 'a1', value: -10 }),
      scored({ id: 'n2', actionKey: 'a1', value: -10 })
    ].map((entry) => ({
      ...entry,
      record: {
        ...entry.record,
        observedReturn: 2,
        learningTarget: 3,
        return: -10
      } as ExperienceRecord
    }));
    expect(estimateStateValue(neighbors)).toBeCloseTo(2, 12);
  });

  it('renders the estimator log line with the consumed field and rewardVersion', () => {
    const records = [
      versionedRecord({ id: 'a', value: 1, observedReturn: 2 }),
      versionedRecord({ id: 'b', value: 1 })
    ];
    const line = estimatorTargetLine(records, REWARD_CONTRACT.version);
    // The line names the contract default field...
    expect(line).toContain('target field observedReturn');
    // ...reports how many neighbours each concrete field contributed...
    expect(line).toContain('observedReturn=1');
    expect(line).toContain('return=1');
    // ...and carries the rewardVersion, so the fact is not JSONL-only.
    expect(line).toContain('rewardVersion=' + REWARD_CONTRACT.version);
  });

  it('estimateActionValuesWithContract returns the same estimates plus the line', () => {
    const neighbors = figureNeighbors();
    const candidates = figureCandidates();
    const plain = estimateActionValues(STATE, neighbors, candidates, {
      ...CONFIG,
      unseenFallback: 'zero'
    });
    const withContract = estimateActionValuesWithContract(
      STATE,
      neighbors,
      candidates,
      { ...CONFIG, unseenFallback: 'zero' },
      () => 0.99,
      REWARD_CONTRACT.version
    );
    expect(withContract.estimates).toEqual(plain);
    expect(withContract.rewardVersion).toBe(REWARD_CONTRACT.version);
    expect(withContract.targetLine).toContain('rewardVersion=' + REWARD_CONTRACT.version);
  });

  it('bumps the rewardVersion and demands a rebuild when the scale changes', () => {
    // A generation bump is a real version bump...
    expect(isRewardVersionBump('r2/verifiable-v1', REWARD_CONTRACT.version)).toBe(true);
    // ...and invalidates old-scale experience: rebuild, never rewrite in place.
    expect(requiresExperienceRebuild('r2/verifiable-v1', REWARD_CONTRACT.version)).toBe(true);
    // Same version means no change.
    expect(requiresExperienceRebuild(REWARD_CONTRACT.version, REWARD_CONTRACT.version)).toBe(false);
    // Downgrades and unknown shapes fail closed to rebuild.
    expect(requiresExperienceRebuild('r3/x', 'r2/verifiable-v1')).toBe(true);
    expect(requiresExperienceRebuild('legacy', 'r3/unified-signals-v1')).toBe(true);
  });
});
