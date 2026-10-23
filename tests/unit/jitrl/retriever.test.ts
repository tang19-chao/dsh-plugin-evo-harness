/**
 * P1-3 retriever: Jaccard edge cases, two-stage exact-bucket preference and
 * level-wide relaxation, similarity threshold, top-k, injected-clock half-life
 * decay, causal cutoff, guidance/level filtering and deterministic ordering.
 */
import { describe, expect, it } from 'vitest';
import type {
  AbstractState,
  ExperienceRecord,
  JitLevel,
  ScoredExperience
} from '../../../src/types/contracts';
import {
  driftFactorFor,
  jaccard,
  resolveDriftContext,
  retrieve,
  retrieveNeighbors,
  toExperienceQuery,
  type DriftContext
} from '../../../src/jitrl/retriever';

const T0 = 1_700_000_000_000;

function makeState(
  bucket = 'bucket-a',
  tokens: readonly string[] = ['x', 'y'],
  level: JitLevel = 'meta'
): AbstractState {
  return { level, bucket, tokens, summary: 'summary' };
}

interface RecordInput {
  readonly id: string;
  readonly state?: AbstractState;
  readonly level?: JitLevel;
  readonly actionKey?: string;
  readonly createdAt?: number;
  readonly guidance?: ExperienceRecord['guidance'];
  readonly value?: number;
  readonly policyId?: string;
}

function makeRecord(input: RecordInput): ExperienceRecord {
  const state = input.state ?? makeState();
  return {
    id: input.id,
    level: input.level ?? state.level,
    state,
    actionKey: input.actionKey ?? 'a1',
    reward: input.value ?? 0,
    return: input.value ?? 0,
    rewardSources: {},
    guidance: input.guidance ?? 'memory',
    policyId: input.policyId ?? 'policy',
    sessionId: 'session',
    createdAt: input.createdAt ?? T0,
    redacted: true
  };
}

function ids(scored: readonly ScoredExperience[]): readonly string[] {
  return scored.map((entry) => entry.record.id);
}

function weightOf(scored: readonly ScoredExperience[], id: string): number {
  const entry = scored.find((candidate) => candidate.record.id === id);
  expect(entry).toBeDefined();
  return entry?.weight ?? Number.NaN;
}

const BASE_STATE = makeState();

describe('jaccard', () => {
  it('is 1 for identical token sets and 0 for disjoint sets', () => {
    expect(jaccard(['a', 'b'], ['a', 'b'])).toBe(1);
    expect(jaccard(['a', 'b'], ['c', 'd'])).toBe(0);
  });

  it('computes |intersection| / |union| for partial overlap', () => {
    expect(jaccard(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3, 12);
    expect(jaccard(['a', 'b', 'c'], ['b', 'c', 'd'])).toBeCloseTo(2 / 4, 12);
  });

  it('returns 0 whenever either side is empty', () => {
    expect(jaccard([], [])).toBe(0);
    expect(jaccard([], ['a'])).toBe(0);
    expect(jaccard(['a'], [])).toBe(0);
  });

  it('treats tokens as a set and ignores order and duplicates', () => {
    expect(jaccard(['b', 'a', 'a'], ['a', 'b'])).toBe(1);
    expect(jaccard(['a', 'a', 'b'], ['b', 'c', 'c', 'c'])).toBeCloseTo(1 / 3, 12);
  });
});

describe('retrieveNeighbors: two-stage retrieval', () => {
  it('stays inside the exact bucket once it has at least k/2 hits', () => {
    const state = makeState('bucket-b', ['x', 'y']);
    const records = [
      makeRecord({ id: 'exact-1', state: makeState('bucket-b', ['x']) }),
      makeRecord({ id: 'exact-2', state: makeState('bucket-b', ['y']) }),
      makeRecord({ id: 'other', state: makeState('bucket-c', ['x', 'y']) })
    ];
    const scored = retrieveNeighbors(records, state, {
      k: 4,
      similarityThreshold: 0
    });
    // bucket hits are 2 >= k/2 = 2, so the cross-bucket perfect match is excluded.
    expect(ids(scored)).toEqual(['exact-1', 'exact-2']);
    expect(scored[0]?.similarity).toBeCloseTo(0.5, 12);
  });

  it('relaxes to the whole level when bucket hits are fewer than k/2', () => {
    const state = makeState('bucket-b', ['x', 'y']);
    const records = [
      makeRecord({ id: 'exact', state: makeState('bucket-b', ['x']) }),
      makeRecord({ id: 'cross-1', state: makeState('bucket-c', ['x', 'y']) }),
      makeRecord({ id: 'cross-2', state: makeState('bucket-c', ['x', 'y', 'z']) })
    ];
    const scored = retrieveNeighbors(records, state, {
      k: 4,
      similarityThreshold: 0
    });
    expect(ids(scored)).toEqual(['cross-1', 'cross-2', 'exact']);
    expect(scored[0]?.similarity).toBeCloseTo(1, 12);
    expect(scored[1]?.similarity).toBeCloseTo(2 / 3, 12);
  });

  it('never returns records from another JitRL level', () => {
    const state = makeState('bucket-a', ['x', 'y'], 'meta');
    const records = [
      makeRecord({ id: 'meta', state }),
      makeRecord({
        id: 'proposal',
        state: makeState('bucket-a', ['x', 'y'], 'proposal'),
        level: 'proposal'
      })
    ];
    expect(ids(retrieveNeighbors(records, state, { k: 5, similarityThreshold: 0 }))).toEqual([
      'meta'
    ]);
  });

  it('honours the guidance filter (invariant isolation)', () => {
    const state = makeState();
    const records = [
      makeRecord({ id: 'free', guidance: 'guidance_free' }),
      makeRecord({ id: 'memory', guidance: 'memory' })
    ];
    expect(
      ids(
        retrieveNeighbors(records, state, {
          k: 5,
          similarityThreshold: 0,
          guidanceFilter: 'guidance_free'
        })
      )
    ).toEqual(['free']);
  });

  it('applies an inclusive causal cutoff', () => {
    const state = makeState();
    const records = [
      makeRecord({ id: 'past', createdAt: T0 - 10 }),
      makeRecord({ id: 'boundary', createdAt: T0 }),
      makeRecord({ id: 'future', createdAt: T0 + 1 })
    ];
    expect(
      ids(retrieveNeighbors(records, state, { k: 5, similarityThreshold: 0, before: T0 }))
    ).toEqual(['boundary', 'past']);
  });

  it('drops records below the similarity threshold, inclusive at the boundary', () => {
    const state = makeState('bucket-a', ['a', 'b']);
    const records = [
      makeRecord({ id: 'half', state: makeState('bucket-a', ['a']) }),
      makeRecord({ id: 'full', state: makeState('bucket-a', ['a', 'b']) })
    ];
    expect(
      ids(retrieveNeighbors(records, state, { k: 2, similarityThreshold: 0.6 }))
    ).toEqual(['full']);
    expect(
      ids(retrieveNeighbors(records, state, { k: 2, similarityThreshold: 0.5 }))
    ).toEqual(['full', 'half']);
  });

  it('keeps only the top-k after ranking', () => {
    const state = makeState('bucket-a', ['a', 'b', 'c', 'd']);
    const records = [
      makeRecord({ id: 'sim-1', state: makeState('bucket-a', ['a', 'b', 'c', 'd']) }),
      makeRecord({ id: 'sim-2', state: makeState('bucket-a', ['a', 'b', 'c']) }),
      makeRecord({ id: 'sim-3', state: makeState('bucket-a', ['a', 'b']) }),
      makeRecord({ id: 'sim-4', state: makeState('bucket-a', ['a']) })
    ];
    const scored = retrieveNeighbors(records, state, {
      k: 2,
      similarityThreshold: 0
    });
    expect(ids(scored)).toEqual(['sim-1', 'sim-2']);
  });

  it('drops zero-similarity records even when the threshold is 0', () => {
    const state = makeState('bucket-a', ['a']);
    const records = [
      makeRecord({ id: 'disjoint', state: makeState('bucket-a', ['z']) })
    ];
    expect(retrieveNeighbors(records, state, { k: 5, similarityThreshold: 0 })).toEqual(
      []
    );
  });

  it('returns no neighbours for empty pools or empty state tokens', () => {
    expect(retrieveNeighbors([], BASE_STATE, { k: 5, similarityThreshold: 0 })).toEqual([]);
    expect(
      retrieveNeighbors([makeRecord({ id: 'r' })], makeState('bucket-a', []), {
        k: 5,
        similarityThreshold: 0
      })
    ).toEqual([]);
  });

  it('skips records with non-finite timestamps', () => {
    const records = [
      makeRecord({ id: 'broken', createdAt: Number.NaN }),
      makeRecord({ id: 'ok' })
    ];
    expect(ids(retrieveNeighbors(records, BASE_STATE, { k: 5, similarityThreshold: 0 }))).toEqual(
      ['ok']
    );
  });
});

describe('retrieveNeighbors: deterministic ordering', () => {
  it('orders by similarity, then newest first, then id ascending', () => {
    const state = makeState('bucket-a', ['a', 'b']);
    const records = [
      makeRecord({ id: 'old', state: makeState('bucket-a', ['a', 'b']), createdAt: T0 }),
      makeRecord({ id: 'new', state: makeState('bucket-a', ['a', 'b']), createdAt: T0 + 100 }),
      makeRecord({ id: 'b', state: makeState('bucket-a', ['a']), createdAt: T0 + 100 }),
      makeRecord({ id: 'a', state: makeState('bucket-a', ['a']), createdAt: T0 + 100 })
    ];
    expect(
      ids(retrieveNeighbors(records, state, { k: 10, similarityThreshold: 0 }))
    ).toEqual(['new', 'old', 'a', 'b']);
  });
});

describe('retrieveNeighbors: half-life decay with injected clock', () => {
  it('halves the weight after one half-life and leaves similarity untouched', () => {
    const state = makeState('bucket-a', ['a']);
    const records = [
      makeRecord({ id: 'fresh', state, createdAt: T0 }),
      makeRecord({ id: 'half', state, createdAt: T0 - 1000 }),
      makeRecord({ id: 'old', state, createdAt: T0 - 4000 })
    ];
    const scored = retrieveNeighbors(records, state, {
      k: 5,
      similarityThreshold: 0,
      now: T0,
      halfLifeMs: 1000
    });
    expect(scored.map((entry) => entry.similarity)).toEqual([1, 1, 1]);
    expect(weightOf(scored, 'fresh')).toBeCloseTo(1, 12);
    expect(weightOf(scored, 'half')).toBeCloseTo(0.5, 12);
    expect(weightOf(scored, 'old')).toBeCloseTo(2 ** -4, 12);
  });

  it('does not decay without now or with a non-positive half-life', () => {
    const state = makeState('bucket-a', ['a']);
    const records = [makeRecord({ id: 'old', state, createdAt: T0 - 10_000 })];
    const noClock = retrieveNeighbors(records, state, { k: 5, similarityThreshold: 0 });
    expect(weightOf(noClock, 'old')).toBeCloseTo(1, 12);
    const zeroHalfLife = retrieveNeighbors(records, state, {
      k: 5,
      similarityThreshold: 0,
      now: T0,
      halfLifeMs: 0
    });
    expect(weightOf(zeroHalfLife, 'old')).toBeCloseTo(1, 12);
  });

  it('clamps future timestamps to age 0 instead of amplifying them', () => {
    const state = makeState('bucket-a', ['a']);
    const records = [makeRecord({ id: 'future', state, createdAt: T0 + 5000 })];
    const scored = retrieveNeighbors(records, state, {
      k: 5,
      similarityThreshold: 0,
      now: T0,
      halfLifeMs: 1000
    });
    expect(weightOf(scored, 'future')).toBeCloseTo(1, 12);
  });

  it('exposes an explicit weight on every returned neighbour', () => {
    const scored = retrieveNeighbors([makeRecord({ id: 'r' })], BASE_STATE, {
      k: 5,
      similarityThreshold: 0
    });
    expect(scored[0]?.weight).toBeCloseTo(1, 12);
  });
});

describe('retrieveNeighbors: option validation', () => {
  it('rejects an invalid k or similarity threshold', () => {
    const records = [makeRecord({ id: 'r' })];
    expect(() => retrieveNeighbors(records, BASE_STATE, { k: 0, similarityThreshold: 0 })).toThrow(
      RangeError
    );
    expect(() =>
      retrieveNeighbors(records, BASE_STATE, { k: 1.5, similarityThreshold: 0 })
    ).toThrow(RangeError);
    expect(() =>
      retrieveNeighbors(records, BASE_STATE, { k: 1, similarityThreshold: -0.1 })
    ).toThrow(RangeError);
    expect(() =>
      retrieveNeighbors(records, BASE_STATE, { k: 1, similarityThreshold: 1.1 })
    ).toThrow(RangeError);
    expect(() =>
      retrieveNeighbors(records, BASE_STATE, { k: 1, similarityThreshold: Number.NaN })
    ).toThrow(RangeError);
  });

  it('rejects non-finite clocks and negative half-life', () => {
    const records = [makeRecord({ id: 'r' })];
    expect(() =>
      retrieveNeighbors(records, BASE_STATE, {
        k: 1,
        similarityThreshold: 0,
        now: Number.NaN
      })
    ).toThrow(RangeError);
    expect(() =>
      retrieveNeighbors(records, BASE_STATE, {
        k: 1,
        similarityThreshold: 0,
        before: Number.POSITIVE_INFINITY
      })
    ).toThrow(RangeError);
    expect(() =>
      retrieveNeighbors(records, BASE_STATE, {
        k: 1,
        similarityThreshold: 0,
        halfLifeMs: -1
      })
    ).toThrow(RangeError);
  });
});

describe('retrieve adapter and store query bridge', () => {
  it('accepts a record array or a { records } snapshot', () => {
    const records = [
      makeRecord({ id: 'first' }),
      makeRecord({ id: 'second', state: makeState('bucket-a', ['x']) })
    ];
    const options = { k: 2, similarityThreshold: 0 };
    const direct = retrieveNeighbors(records, BASE_STATE, options);
    expect(retrieve(records, BASE_STATE, options)).toEqual(direct);
    expect(retrieve({ records }, BASE_STATE, options)).toEqual(direct);
  });

  it('builds the store-facing ExperienceQuery with optional filters', () => {
    expect(
      toExperienceQuery(BASE_STATE, { k: 5, similarityThreshold: 0.25, before: 123 })
    ).toEqual({ level: 'meta', state: BASE_STATE, k: 5, similarityThreshold: 0.25, before: 123 });
    expect(
      toExperienceQuery(BASE_STATE, {
        k: 5,
        similarityThreshold: 0.25,
        guidanceFilter: 'guidance_free'
      })
    ).toEqual({
      level: 'meta',
      state: BASE_STATE,
      k: 5,
      similarityThreshold: 0.25,
      guidanceFilter: 'guidance_free'
    });
  });
});

/**
 * Phase 4 drift down-weighting (plan section 7.3-4): after a hot swap, records
 * written by a superseded policy are scaled by rho_drift until the current
 * policy owns k records in the same bucket.
 */
describe('retrieveNeighbors: drift down-weighting by policyId', () => {
  const CURRENT = 'policy-current';
  const STALE = 'policy-old';

  it('down-weights stale-policy records to rho_drift of the baseline', () => {
    const state = makeState('bucket-a', ['x']);
    const records = [
      makeRecord({ id: 'fresh', state, policyId: CURRENT }),
      makeRecord({ id: 'stale', state, policyId: STALE })
    ];
    const options = {
      k: 10,
      similarityThreshold: 0,
      policyId: CURRENT,
      driftRho: 0.7
    };
    const scored = retrieveNeighbors(records, state, options);
    expect(weightOf(scored, 'fresh')).toBeCloseTo(1, 12);
    expect(weightOf(scored, 'stale')).toBeCloseTo(0.7, 12);
    // Similarity itself is never altered by drift.
    expect(scored.map((entry) => entry.similarity)).toEqual([1, 1]);
  });

  it('reports driftWeight only for the neighbours it actually down-weighted', () => {
    const state = makeState('bucket-a', ['x']);
    const records = [
      makeRecord({ id: 'fresh', state, policyId: CURRENT }),
      makeRecord({ id: 'stale', state, policyId: STALE })
    ];
    const scored = retrieveNeighbors(records, state, {
      k: 10,
      similarityThreshold: 0,
      policyId: CURRENT,
      driftRho: 0.7
    });
    const byId = new Map(scored.map((entry) => [entry.record.id, entry]));
    expect(byId.get('fresh')?.driftWeight).toBeUndefined();
    expect(byId.get('stale')?.driftWeight).toBeCloseTo(0.7, 12);
  });

  it('stops down-weighting once the current policy owns k records in the bucket', () => {
    const state = makeState('bucket-a', ['x', 'y']);
    // The stale record matches both query tokens (similarity 1) so it outranks
    // the current-policy records (similarity 0.5) and survives the top-k cut;
    // that keeps saturation observable instead of hidden by truncation.
    const stale = makeRecord({
      id: 'stale',
      state: makeState('bucket-a', ['x', 'y']),
      policyId: STALE
    });
    const current = (id: string, tokens: readonly string[]): ExperienceRecord =>
      makeRecord({ id, state: makeState('bucket-a', tokens), policyId: CURRENT });

    // k = 2, and the same bucket already holds 2 current-policy records.
    const enough = [current('cur-1', ['x']), current('cur-2', ['x']), stale];
    const atK = retrieveNeighbors(enough, state, {
      k: 2,
      similarityThreshold: 0,
      policyId: CURRENT,
      driftRho: 0.7
    });
    expect(ids(atK)).toEqual(['stale', 'cur-1']);
    expect(weightOf(atK, 'stale')).toBeCloseTo(1, 12);
    expect(atK.every((entry) => entry.driftWeight === undefined)).toBe(true);

    // One current-policy record short of k: the penalty is still in force.
    const below = retrieveNeighbors([current('cur-1', ['x']), stale], state, {
      k: 2,
      similarityThreshold: 0,
      policyId: CURRENT,
      driftRho: 0.7
    });
    expect(weightOf(below, 'stale')).toBeCloseTo(0.7, 12);
  });

  it('is byte-identical to the pre-drift behaviour when policyId is absent', () => {
    const state = makeState('bucket-a', ['x']);
    const records = [
      makeRecord({ id: 'a', state, policyId: CURRENT }),
      makeRecord({ id: 'b', state, policyId: STALE })
    ];
    const legacy = retrieveNeighbors(records, state, { k: 5, similarityThreshold: 0 });
    // Requesting driftRho without a policyId must not change anything either:
    // there is no "current policy" to compare against.
    const rhoOnly = retrieveNeighbors(records, state, {
      k: 5,
      similarityThreshold: 0,
      driftRho: 0.7
    });
    expect(rhoOnly).toEqual(legacy);
    expect(weightOf(legacy, 'b')).toBeCloseTo(1, 12);
    expect(legacy.every((entry) => entry.driftWeight === undefined)).toBe(true);
    // The exact object shape is preserved: only the three legacy keys appear.
    expect(Object.keys(legacy[0] ?? {}).sort()).toEqual(['record', 'similarity', 'weight']);
  });

  it('composes multiplicatively with the half-life decay instead of replacing it', () => {
    const state = makeState('bucket-a', ['a']);
    const records = [
      makeRecord({ id: 'stale', state, policyId: STALE, createdAt: T0 - 1000 })
    ];
    const scored = retrieveNeighbors(records, state, {
      k: 5,
      similarityThreshold: 0,
      now: T0,
      halfLifeMs: 1000,
      policyId: CURRENT,
      driftRho: 0.7
    });
    // One half-life (0.5) times drift (0.7) = 0.35, not either factor alone.
    expect(weightOf(scored, 'stale')).toBeCloseTo(0.5 * 0.7, 12);
    expect(weightOf(scored, 'stale')).not.toBeCloseTo(0.5, 6);
    expect(weightOf(scored, 'stale')).not.toBeCloseTo(0.7, 6);
  });

  it('treats driftRho = 0 as dropping the stale record entirely', () => {
    const state = makeState('bucket-a', ['x']);
    const records = [makeRecord({ id: 'stale', state, policyId: STALE })];
    const scored = retrieveNeighbors(records, state, {
      k: 5,
      similarityThreshold: 0,
      policyId: CURRENT,
      driftRho: 0
    });
    expect(scored).toEqual([]);
  });

  it('applies drift to the level-wide relaxed pool too', () => {
    const state = makeState('bucket-a', ['x']);
    // A record from another bucket enters the pool via the k/2 relaxation; its
    // drift factor must still be derived from its own policy.
    const records = [
      makeRecord({ id: 'cross', state: makeState('bucket-b', ['x']), policyId: STALE })
    ];
    const scored = retrieveNeighbors(records, state, {
      k: 10,
      similarityThreshold: 0,
      policyId: CURRENT,
      driftRho: 0.7
    });
    expect(weightOf(scored, 'cross')).toBeCloseTo(0.7, 12);
  });

  it('rejects an out-of-range or non-finite driftRho', () => {
    const records = [makeRecord({ id: 'r' })];
    for (const bad of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY] as const) {
      expect(() =>
        retrieveNeighbors(records, BASE_STATE, {
          k: 1,
          similarityThreshold: 0,
          policyId: CURRENT,
          driftRho: bad
        })
      ).toThrow(RangeError);
    }
  });
});

describe('driftFactorFor / resolveDriftContext (pure helpers)', () => {
  const context: DriftContext = {
    policyId: 'policy-current',
    driftRho: 0.7,
    currentBucketCount: 0,
    k: 10
  };

  it('returns 1 for current-policy records and driftRho for stale ones', () => {
    expect(driftFactorFor('policy-current', context)).toBe(1);
    expect(driftFactorFor('policy-old', context)).toBe(0.7);
  });

  it('returns 1 for everyone once currentBucketCount reaches k', () => {
    const saturated: DriftContext = { ...context, currentBucketCount: 10 };
    expect(driftFactorFor('policy-old', saturated)).toBe(1);
    const overSaturated: DriftContext = { ...context, currentBucketCount: 11 };
    expect(driftFactorFor('policy-old', overSaturated)).toBe(1);
  });

  it('is null when drift is not requested, so the legacy path stays intact', () => {
    const records = [makeRecord({ id: 'r', policyId: 'policy-old' })];
    expect(resolveDriftContext(records, { k: 5, similarityThreshold: 0 })).toBeNull();
    expect(
      resolveDriftContext(records, { k: 5, similarityThreshold: 0, policyId: 'policy-current' })
    ).toBeNull();
    expect(
      resolveDriftContext(records, { k: 5, similarityThreshold: 0, driftRho: 0.7 })
    ).toBeNull();
  });

  it('counts only the current policy records in the supplied bucket snapshot', () => {
    const records = [
      makeRecord({ id: 'c1', policyId: 'policy-current' }),
      makeRecord({ id: 'c2', policyId: 'policy-current' }),
      makeRecord({ id: 's1', policyId: 'policy-old' })
    ];
    const resolved = resolveDriftContext(records, {
      k: 5,
      similarityThreshold: 0,
      policyId: 'policy-current',
      driftRho: 0.7
    });
    expect(resolved).toEqual({
      policyId: 'policy-current',
      driftRho: 0.7,
      currentBucketCount: 2,
      k: 5
    });
    expect(resolved).not.toBeNull();
    expect(driftFactorFor('policy-old', resolved as DriftContext)).toBe(0.7);
  });
});

describe('toExperienceQuery: drift inputs are forwarded to the store', () => {
  it('omits the drift keys when they are not requested (byte-identical query)', () => {
    const query = toExperienceQuery(BASE_STATE, { k: 5, similarityThreshold: 0.25 });
    expect(query).toEqual({
      level: 'meta',
      state: BASE_STATE,
      k: 5,
      similarityThreshold: 0.25
    });
    expect('policyId' in query).toBe(false);
    expect('driftRho' in query).toBe(false);
  });

  it('forwards policyId and driftRho verbatim', () => {
    const query = toExperienceQuery(BASE_STATE, {
      k: 5,
      similarityThreshold: 0.25,
      policyId: 'policy-current',
      driftRho: 0.7
    });
    expect(query.policyId).toBe('policy-current');
    expect(query.driftRho).toBe(0.7);
  });
});
