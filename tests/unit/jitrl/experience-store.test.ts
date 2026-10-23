/**
 * P1-2: ExperienceStore shared kernel and the in-memory driver.
 *
 * Covers record validation/dedupe, the inverted index pre-filter with its
 * k/2 relaxation, Jaccard top-k with half-life weights, causal (before) and
 * guidance filtering, deterministic ordering, compaction and export.
 */
import { describe, expect, it } from 'vitest';
import type {
  ExperienceQuery,
  ExperienceRecord,
  GuidanceMode,
  JitLevel
} from '../../../src/types/contracts';
import {
  CURRENT_PROVENANCE_VERSION,
  CURRENT_REWARD_VERSION,
  DEFAULT_EXPERIENCE_HALF_LIFE_MS,
  EXPERIENCE_SCHEMA_VERSION,
  ExperienceIndex,
  ExperienceRecordError,
  compareStoredExperiences,
  executeExperienceQuery,
  experienceJaccard,
  experienceWeight,
  isLearningEligible,
  isLegacyStoredExperience,
  isValidExperienceRecord,
  mirrorVisibleRecords,
  normalizeExperienceRecords,
  planCompaction,
  type StoredExperience
} from '../../../src/jitrl/experience-store';
import { createMemoryExperienceStore } from '../../../src/jitrl/stores/memory.store';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HALF_LIFE = 1000;
const NOW = 1_000_000_000_000;

let idCounter = 0;

function makeRecord(overrides: Partial<ExperienceRecord> & {
  readonly id?: string;
  readonly level?: JitLevel;
  readonly bucket?: string;
  readonly tokens?: readonly string[];
  readonly createdAt?: number;
  readonly guidance?: GuidanceMode;
} = {}): ExperienceRecord {
  idCounter += 1;
  const level = overrides.level ?? 'meta';
  const id = overrides.id ?? 'rec-' + String(idCounter) + '-' + String(Math.round(Math.random() * 1e6));
  return {
    id,
    level,
    state: {
      level,
      bucket: overrides.bucket ?? 'task|simple',
      tokens: overrides.tokens ?? ['alpha', 'beta'],
      summary: 'summary for ' + id
    },
    actionKey: 'action:' + id,
    reward: 1,
    return: 1,
    rewardSources: { llm: 1 },
    guidance: overrides.guidance ?? 'memory',
    policyId: 'policy-1',
    sessionId: 'session-1',
    createdAt: overrides.createdAt ?? NOW - HALF_LIFE,
    redacted: true
  };
}

function makeQuery(overrides: Partial<ExperienceQuery> = {}): ExperienceQuery {
  return {
    level: overrides.level ?? 'meta',
    state: overrides.state ?? {
      level: overrides.level ?? 'meta',
      bucket: 'task|simple',
      tokens: ['alpha', 'beta'],
      summary: 'query'
    },
    k: overrides.k ?? 5,
    similarityThreshold: overrides.similarityThreshold ?? 0,
    ...(overrides.guidanceFilter === undefined ? {} : { guidanceFilter: overrides.guidanceFilter }),
    ...(overrides.before === undefined ? {} : { before: overrides.before })
  };
}

function memoryStore(options: { readonly bucketCap?: number } = {}) {
  return createMemoryExperienceStore({
    now: () => NOW,
    halfLifeMs: HALF_LIFE,
    ...(options.bucketCap === undefined ? {} : { bucketCap: options.bucketCap })
  });
}

describe('memory store purge (P3-E2 gap 2)', () => {
  it('drops one bucket and keeps the others', async () => {
    const store = memoryStore();
    await store.append([
      makeRecord({ id: 'keep-1', bucket: 'keep' }),
      makeRecord({ id: 'drop-1', bucket: 'drop' }),
      makeRecord({ id: 'drop-2', bucket: 'drop', level: 'proposal' })
    ]);
    expect(await store.purge({ bucket: 'drop' })).toBe(2);
    expect(store.snapshot().map((result) => result.id)).toEqual(['keep-1']);
    expect(await store.size()).toBe(1);
  });

  it('drops everything for a global purge', async () => {
    const store = memoryStore();
    await store.append([makeRecord({ id: 'a' }), makeRecord({ id: 'b', bucket: 'other' })]);
    expect(await store.purge()).toBe(2);
    expect(store.snapshot()).toEqual([]);
    expect(await store.size()).toBe(0);
  });

  it('is a no-op for an unknown bucket', async () => {
    const store = memoryStore();
    await store.append([makeRecord({ id: 'a', bucket: 'keep' })]);
    expect(await store.purge({ bucket: 'missing' })).toBe(0);
    expect(store.snapshot().map((result) => result.id)).toEqual(['a']);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('experience-store helpers', () => {
  it('computes Jaccard similarity with an empty-set boundary of 0', () => {
    expect(experienceJaccard(['a', 'b'], ['a', 'b'])).toBe(1);
    expect(experienceJaccard(['a', 'b'], ['a', 'b', 'c', 'd'])).toBe(0.5);
    expect(experienceJaccard(['a'], ['b'])).toBe(0);
    expect(experienceJaccard([], ['a'])).toBe(0);
    expect(experienceJaccard(['a'], [])).toBe(0);
    // Duplicate tokens are ignored on both sides.
    expect(experienceJaccard(['a', 'a', 'b'], ['a', 'b'])).toBe(1);
  });

  it('decays the weight by exactly 2^(-age/halfLife) and clamps future timestamps', () => {
    expect(experienceWeight(1, NOW, NOW, HALF_LIFE)).toBe(1);
    expect(experienceWeight(1, NOW - HALF_LIFE, NOW, HALF_LIFE)).toBeCloseTo(0.5, 12);
    expect(experienceWeight(1, NOW - 2 * HALF_LIFE, NOW, HALF_LIFE)).toBeCloseTo(0.25, 12);
    expect(experienceWeight(0.5, NOW - HALF_LIFE, NOW, HALF_LIFE)).toBeCloseTo(0.25, 12);
    // A future timestamp is not amplified: age is clamped to 0.
    expect(experienceWeight(1, NOW + 10 * HALF_LIFE, NOW, HALF_LIFE)).toBe(1);
    // halfLife 0 disables the decay entirely.
    expect(experienceWeight(0.75, NOW - 999, NOW, 0)).toBe(0.75);
    // The default half-life is 30 days.
    expect(DEFAULT_EXPERIENCE_HALF_LIFE_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('validates records and rejects malformed ones with stable codes', () => {
    expect(isValidExperienceRecord(makeRecord())).toBe(true);
    const cases: readonly { readonly value: unknown; readonly code: string }[] = [
      { value: null, code: 'not_object' },
      { value: 'nope', code: 'not_object' },
      { value: { ...makeRecord(), id: '' }, code: 'invalid_field' },
      { value: { ...makeRecord(), level: 'other' }, code: 'invalid_field' },
      { value: { ...makeRecord(), state: undefined }, code: 'missing_field' },
      { value: { ...makeRecord(), state: { level: 'meta', bucket: '', tokens: [], summary: '' } }, code: 'invalid_field' },
      { value: { ...makeRecord(), state: { level: 'meta', bucket: 'b', tokens: [1], summary: '' } }, code: 'invalid_field' },
      { value: { ...makeRecord(), reward: Number.NaN }, code: 'invalid_field' },
      { value: { ...makeRecord(), createdAt: 'now' }, code: 'invalid_field' },
      { value: { ...makeRecord(), redacted: undefined }, code: 'missing_field' },
      { value: { ...makeRecord(), rewardSources: { llm: 'high' } }, code: 'invalid_field' }
    ];
    for (const testCase of cases) {
      expect(isValidExperienceRecord(testCase.value)).toBe(false);
      let code = '';
      try {
        normalizeExperienceRecords([testCase.value as ExperienceRecord]);
      } catch (error) {
        code = error instanceof ExperienceRecordError ? error.code : 'not_an_experience_error';
      }
      expect(code).toBe(testCase.code);
    }
  });

  it('dedupes tokens and rejects duplicate ids inside one append batch', () => {
    const normalized = normalizeExperienceRecords([
      makeRecord({ id: 'dup-token', tokens: ['a', 'a', 'b'] })
    ]);
    expect(normalized[0]?.tokens).toEqual(['a', 'b']);
    expect(() =>
      normalizeExperienceRecords([makeRecord({ id: 'same' }), makeRecord({ id: 'same' })])
    ).toThrowError(ExperienceRecordError);
  });

  it('orders by similarity, then weight, then createdAt, then id', () => {
    const base = normalizeExperienceRecords([makeRecord({ id: 'a', createdAt: NOW })])[0] as StoredExperience;
    const compare = (leftSimilarity: number, leftWeight: number, rightSimilarity: number, rightWeight: number, leftCreatedAt: number, rightCreatedAt: number, leftId = 'a', rightId = 'a'): number =>
      compareStoredExperiences(
        { record: { ...base, id: leftId, createdAt: leftCreatedAt }, similarity: leftSimilarity, weight: leftWeight },
        { record: { ...base, id: rightId, createdAt: rightCreatedAt }, similarity: rightSimilarity, weight: rightWeight }
      );
    expect(compare(0.9, 0.1, 0.5, 0.4, NOW, NOW)).toBeLessThan(0);
    expect(compare(0.5, 0.4, 0.5, 0.1, NOW, NOW)).toBeLessThan(0);
    expect(compare(0.5, 0.2, 0.5, 0.2, NOW, NOW - 5)).toBeLessThan(0);
    expect(compare(0.5, 0.2, 0.5, 0.2, NOW, NOW)).toBe(0);
    // Weight equality inside the epsilon is a tie, not a reordering.
    expect(compare(0.5, 0.2, 0.5, 0.2 + 1e-12, NOW, NOW)).toBe(0);
    // Equal timestamp and weight: ascending id wins.
    expect(compare(0.5, 0.2, 0.5, 0.2, NOW, NOW, 'a', 'b')).toBeLessThan(0);
    expect(compare(0.5, 0.2, 0.5, 0.2, NOW, NOW, 'b', 'a')).toBeGreaterThan(0);
    expect(compare(0.5, 0.2, 0.5, 0.2, NOW, NOW, 'a', 'a')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Query through the memory store
// ---------------------------------------------------------------------------

describe('memory experience store retrieval', () => {
  it('returns an empty result for an empty store', async () => {
    const store = memoryStore();
    expect(await store.size()).toBe(0);
    expect(await store.query(makeQuery())).toEqual([]);
  });

  it('appends, counts and queries the same tokens at similarity 1', async () => {
    const store = memoryStore();
    await store.append([makeRecord({ id: 'r1', createdAt: NOW }), makeRecord({ id: 'r2', tokens: ['gamma'] })]);
    expect(await store.size()).toBe(2);
    expect(await store.size('meta')).toBe(2);
    expect(await store.size('proposal')).toBe(0);
    const scored = await store.query(makeQuery());
    expect(scored).toHaveLength(1);
    expect(scored[0]?.record.id).toBe('r1');
    expect(scored[0]?.similarity).toBe(1);
    expect(scored[0]?.weight).toBe(1);
  });

  it('excludes other levels even when their tokens match', async () => {
    const store = memoryStore();
    await store.append([makeRecord({ id: 'p1', level: 'proposal' })]);
    expect(await store.query(makeQuery({ level: 'meta' }))).toEqual([]);
    expect((await store.query(makeQuery({ level: 'proposal' })))[0]?.record.id).toBe('p1');
  });

  it('prefers the exact bucket and relaxes to the level only when hits < max(1, k/2)', async () => {
    const store = memoryStore();
    await store.append([
      makeRecord({ id: 'exact', bucket: 'task|simple', tokens: ['alpha', 'beta'] }),
      makeRecord({ id: 'other-1', bucket: 'task|hard', tokens: ['alpha', 'beta'] }),
      makeRecord({ id: 'other-2', bucket: 'task|hard', tokens: ['alpha', 'beta'] })
    ]);
    // k=2 -> threshold max(1, 1) = 1; the exact bucket already has one hit.
    const strict = await store.query(makeQuery({ k: 2 }));
    expect(strict.map((entry) => entry.record.id)).toEqual(['exact']);
    // k=4 -> threshold max(1, 2) = 2; one hit is not enough, so the pool relaxes.
    const relaxed = await store.query(makeQuery({ k: 4 }));
    expect(relaxed.map((entry) => entry.record.id).sort()).toEqual(['exact', 'other-1', 'other-2']);
  });

  it('drops records below similarityThreshold (inclusive boundary)', async () => {
    const store = memoryStore();
    await store.append([
      makeRecord({ id: 'half', tokens: ['alpha', 'beta', 'gamma', 'delta'] }),
      makeRecord({ id: 'full', tokens: ['alpha', 'beta'] })
    ]);
    // J(half) = 2/4 = 0.5, J(full) = 1.
    const atHalf = await store.query(makeQuery({ similarityThreshold: 0.5 }));
    expect(atHalf.map((entry) => entry.record.id)).toEqual(['full', 'half']);
    expect(atHalf[1]?.similarity).toBe(0.5);
    const aboveHalf = await store.query(makeQuery({ similarityThreshold: 0.51 }));
    expect(aboveHalf.map((entry) => entry.record.id)).toEqual(['full']);
    const zeroSimilarity = await store.query(makeQuery({ similarityThreshold: 0 }));
    expect(zeroSimilarity.map((entry) => entry.record.id)).toEqual(['full', 'half']);
  });

  it('drops a zero-similarity record even at threshold 0', async () => {
    const store = memoryStore();
    await store.append([makeRecord({ id: 'disjoint', tokens: ['zeta', 'eta'] })]);
    expect(await store.query(makeQuery({ similarityThreshold: 0 }))).toEqual([]);
  });

  it('honours the causal before cutoff inclusively', async () => {
    const store = memoryStore();
    await store.append([
      makeRecord({ id: 'past', createdAt: NOW - 300 }),
      makeRecord({ id: 'boundary', createdAt: NOW - 200 }),
      makeRecord({ id: 'future', createdAt: NOW - 100 })
    ]);
    const visible = await store.query(makeQuery({ before: NOW - 200 }));
    expect(visible.map((entry) => entry.record.id).sort()).toEqual(['boundary', 'past']);
    const none = await store.query(makeQuery({ before: NOW - 301 }));
    expect(none).toEqual([]);
  });

  it('honours guidanceFilter', async () => {
    const store = memoryStore();
    await store.append([
      makeRecord({ id: 'mem', guidance: 'memory' }),
      makeRecord({ id: 'free', guidance: 'guidance_free' })
    ]);
    const filtered = await store.query(makeQuery({ guidanceFilter: 'guidance_free' }));
    expect(filtered.map((entry) => entry.record.id)).toEqual(['free']);
    const both = await store.query(makeQuery());
    expect(both).toHaveLength(2);
  });

  it('truncates to k after ranking', async () => {
    const store = memoryStore();
    await store.append([
      makeRecord({ id: 'a', createdAt: NOW - 1 }),
      makeRecord({ id: 'b', createdAt: NOW - 2 }),
      makeRecord({ id: 'c', createdAt: NOW - 3 }),
      makeRecord({ id: 'd', createdAt: NOW - 4 })
    ]);
    const top = await store.query(makeQuery({ k: 2 }));
    expect(top.map((entry) => entry.record.id)).toEqual(['a', 'b']);
  });

  it('ranks similarity first, weight second, newest third and id last', async () => {
    const store = memoryStore();
    await store.append([
      // Same similarity, different age: the newest wins even though its weight
      // is larger too.
      makeRecord({ id: 'old', tokens: ['alpha', 'beta'], createdAt: NOW - 3 * HALF_LIFE }),
      makeRecord({ id: 'new', tokens: ['alpha', 'beta'], createdAt: NOW }),
      // Same similarity, same age: ascending id wins.
      makeRecord({ id: 'tie-b', tokens: ['alpha', 'beta'], createdAt: NOW - HALF_LIFE }),
      makeRecord({ id: 'tie-a', tokens: ['alpha', 'beta'], createdAt: NOW - HALF_LIFE }),
      // Lower similarity but newer: similarity still dominates.
      makeRecord({ id: 'partial', tokens: ['alpha', 'beta', 'gamma', 'delta'], createdAt: NOW })
    ]);
    const scored = await store.query(makeQuery({ k: 5 }));
    expect(scored.map((entry) => entry.record.id)).toEqual(['new', 'tie-a', 'tie-b', 'old', 'partial']);
    expect(scored[1]?.weight).toBeCloseTo(0.5, 12);
    expect(scored[3]?.weight).toBeCloseTo(Math.pow(2, -3), 12);
    expect(scored[4]?.similarity).toBe(0.5);
  });

  it('assigns half-life weights that make older records weaker', async () => {
    const store = memoryStore();
    await store.append([
      makeRecord({ id: 'fresh', createdAt: NOW }),
      makeRecord({ id: 'stale', createdAt: NOW - 4 * HALF_LIFE })
    ]);
    const scored = await store.query(makeQuery({ k: 2 }));
    expect(scored[0]?.record.id).toBe('fresh');
    expect(scored[0]?.weight).toBe(1);
    expect(scored[1]?.weight).toBeCloseTo(Math.pow(2, -4), 12);
    expect(scored[1]?.weight as number).toBeLessThan(scored[0]?.weight as number);
  });

  it('upserts a re-appended id instead of storing it twice', async () => {
    const store = memoryStore();
    await store.append([makeRecord({ id: 'same', tokens: ['alpha'] })]);
    await store.append([makeRecord({ id: 'same', tokens: ['beta'] })]);
    expect(await store.size()).toBe(1);
    const scored = await store.query(makeQuery({ state: { level: 'meta', bucket: 'task|simple', tokens: ['beta'], summary: 'q' } }));
    expect(scored).toHaveLength(1);
    expect(scored[0]?.similarity).toBe(1);
  });

  it('exports every live record newest first', async () => {
    const store = memoryStore();
    await store.append([
      makeRecord({ id: 'x', createdAt: 10 }),
      makeRecord({ id: 'y', createdAt: 30 }),
      makeRecord({ id: 'z', createdAt: 20 })
    ]);
    const ids: string[] = [];
    for await (const record of store.export()) {
      ids.push(record.id);
    }
    expect(ids).toEqual(['y', 'z', 'x']);
    expect(store.snapshot().map((record) => record.id)).toEqual(['y', 'z', 'x']);
  });
});

// ---------------------------------------------------------------------------
// Compaction and the index cap
// ---------------------------------------------------------------------------

describe('experience store compaction and cap', () => {
  it('compacts to maxPerBucket by time decay and drops fully expired records', async () => {
    const store = memoryStore();
    await store.append([
      makeRecord({ id: 'decay-1', createdAt: NOW }),
      makeRecord({ id: 'decay-0.5', createdAt: NOW - HALF_LIFE }),
      makeRecord({ id: 'decay-0.25', createdAt: NOW - 2 * HALF_LIFE }),
      makeRecord({ id: 'expired', createdAt: NOW - 100 * HALF_LIFE })
    ]);
    const removed = await store.compact({ maxPerBucket: 2, halfLifeMs: HALF_LIFE });
    expect(removed).toBe(2);
    expect(await store.size()).toBe(2);
    const survivors = store.snapshot().map((record) => record.id);
    expect(survivors.sort()).toEqual(['decay-0.5', 'decay-1']);
    expect(store.diagnostics().some((entry) => entry.code === 'experience_store_compacted')).toBe(true);
    expect(await store.compact({ maxPerBucket: 2, halfLifeMs: HALF_LIFE })).toBe(0);
  });

  it('plans compaction per bucket independently', () => {
    const records = normalizeExperienceRecords([
      makeRecord({ id: 'a1', bucket: 'b1', createdAt: NOW }),
      makeRecord({ id: 'a2', bucket: 'b1', createdAt: NOW - HALF_LIFE }),
      makeRecord({ id: 'b1r', bucket: 'b2', createdAt: NOW - 5 * HALF_LIFE }),
      makeRecord({ id: 'b2r', bucket: 'b2', createdAt: NOW - 6 * HALF_LIFE })
    ]);
    const removed = planCompaction(records, { maxPerBucket: 1, halfLifeMs: HALF_LIFE, now: NOW });
    expect(removed.map((record) => record.id).sort()).toEqual(['a2', 'b2r']);
  });

  it('rejects an out-of-range compaction plan', () => {
    expect(() => planCompaction([], { maxPerBucket: 0 })).toThrowError(RangeError);
    expect(() => planCompaction([], { maxPerBucket: 2, halfLifeMs: -1 })).toThrowError(RangeError);
  });

  it('evicts the oldest record when a bucket exceeds its cap, deterministically', async () => {
    const evicted: string[] = [];
    const store = createMemoryExperienceStore({
      now: () => NOW,
      halfLifeMs: HALF_LIFE,
      bucketCap: 2,
      onEvict: (eviction) => evicted.push(eviction.id)
    });
    await store.append([
      makeRecord({ id: 'oldest', createdAt: 1 }),
      makeRecord({ id: 'middle', createdAt: 2 }),
      makeRecord({ id: 'newest', createdAt: 3 })
    ]);
    expect(await store.size()).toBe(2);
    expect(evicted).toEqual(['oldest']);
    expect(store.snapshot().map((record) => record.id)).toEqual(['newest', 'middle']);
    // The freshly appended record is never the eviction victim.
    await store.append([makeRecord({ id: 'freshest', createdAt: 0 })]);
    expect(evicted).toEqual(['oldest', 'middle']);
    expect(store.snapshot().map((record) => record.id)).toEqual(['newest', 'freshest']);
  });
});

// ---------------------------------------------------------------------------
// Direct algorithm access (the raw index + executeExperienceQuery)
// ---------------------------------------------------------------------------

describe('experience index primitives', () => {
  it('answers executeExperienceQuery with explicit weights and validates input', () => {
    const index = new ExperienceIndex();
    for (const record of normalizeExperienceRecords([
      makeRecord({ id: 'direct', tokens: ['alpha', 'beta'], createdAt: NOW - HALF_LIFE })
    ])) {
      index.insert(record);
    }
    const scored = executeExperienceQuery(index, makeQuery(), { now: NOW, halfLifeMs: HALF_LIFE });
    expect(scored).toHaveLength(1);
    expect(scored[0]?.similarity).toBe(1);
    expect(scored[0]?.weight).toBeCloseTo(0.5, 12);
    expect(() => executeExperienceQuery(index, makeQuery({ k: 0 }), { now: NOW, halfLifeMs: HALF_LIFE })).toThrowError(RangeError);
    expect(() => executeExperienceQuery(index, makeQuery({ similarityThreshold: 2 }), { now: NOW, halfLifeMs: HALF_LIFE })).toThrowError(RangeError);
    expect(() => executeExperienceQuery(index, makeQuery(), { now: -1, halfLifeMs: HALF_LIFE })).toThrowError(RangeError);
  });

  it('keeps exactBucketRecords and levelRecordsDescending in sync with removals', () => {
    const index = new ExperienceIndex();
    for (const record of normalizeExperienceRecords([
      makeRecord({ id: 'r-old', createdAt: 1 }),
      makeRecord({ id: 'r-new', createdAt: 2, bucket: 'other' })
    ])) {
      index.insert(record);
    }
    expect(index.size()).toBe(2);
    expect(index.exactBucketRecords('meta', 'task|simple').map((record) => record.id)).toEqual(['r-old']);
    expect(index.levelRecordsDescending('meta').map((record) => record.id)).toEqual(['r-new', 'r-old']);
    expect(index.remove('r-new')).toBe(true);
    expect(index.remove('r-new')).toBe(false);
    expect(index.size()).toBe(1);
    expect(index.levelRecordsDescending('meta').map((record) => record.id)).toEqual(['r-old']);
    // A query that relaxes now only sees the remaining record.
    expect(index.tokenCandidates('meta', ['alpha'], 10).map((record) => record.id)).toEqual(['r-old']);
    expect(index.tokenCandidates('meta', ['missing-token'], 10)).toEqual([]);
  });

  it('rejects a non-positive bucket cap', () => {
    expect(() => new ExperienceIndex({ bucketCap: 0 })).toThrowError(RangeError);
  });
});
// ---------------------------------------------------------------------------
// Query path cost (CI safe bound; the 5ms target is measured by
// scripts/bench-jitrl-query.mjs, never asserted here)
// ---------------------------------------------------------------------------

describe('experience store query path cost', () => {
  it('answers one query over 2k records well under the CI bound', async () => {
    const store = memoryStore();
    const records: ExperienceRecord[] = [];
    for (let index = 0; index < 2000; index += 1) {
      records.push(makeRecord({
        id: 'perf-' + String(index),
        bucket: 'task|b' + String(index % 20),
        tokens: ['shared', 'v-' + String(index % 40), 'w-' + String(index % 13)],
        createdAt: NOW - (index % 50) * HALF_LIFE
      }));
    }
    await store.append(records);
    expect(await store.size()).toBe(2000);

    const query = makeQuery({
      k: 8,
      similarityThreshold: 0.3,
      state: { level: 'meta', bucket: 'task|b0', tokens: ['shared', 'v-0', 'w-0'], summary: 'perf' }
    });
    // Warm the path up, then assert a single query stays far below the bound.
    await store.query(query);
    const started = Date.now();
    const scored = await store.query(query);
    const elapsed = Date.now() - started;
    expect(scored.length).toBeLessThanOrEqual(8);
    expect(elapsed).toBeLessThan(25);
  });
});

// ---------------------------------------------------------------------------
// P6 PR4 / plan section 6.5: version fields, legacy isolation, mirror rule
// ---------------------------------------------------------------------------

describe('P6 PR4: record versions and legacy isolation', () => {
  const STATE = { level: 'meta' as const, bucket: 'task|pr4', tokens: ['pr4'], summary: '' };

  function record(id: string, overrides: Partial<ExperienceRecord> = {}): ExperienceRecord {
    return {
      id,
      level: 'meta',
      state: STATE,
      actionKey: 'slot:exploit',
      reward: 1,
      return: 1,
      rewardSources: { surrogate: 1 },
      guidance: 'memory',
      policyId: 'policy-pr4',
      sessionId: 'session-pr4',
      createdAt: 100,
      redacted: true,
      ...overrides
    };
  }

  const CURRENT: Partial<ExperienceRecord> = {
    experienceSchemaVersion: EXPERIENCE_SCHEMA_VERSION,
    rewardVersion: CURRENT_REWARD_VERSION,
    provenanceVersion: CURRENT_PROVENANCE_VERSION,
    outcome: 'succeeded',
    learningEligible: true,
    observedReturn: 1,
    attributionBaseline: 0,
    learningTarget: 1,
    trajectoryId: 'traj-pr4',
    round: 1,
    slotIndex: 0
  };

  it('normalizes every optional association field and keeps the rest untouched', () => {
    const normalized = normalizeExperienceRecords([
      record('pr4-full', {
        ...CURRENT,
        branchId: 'branch-pr4',
        scopeKey: 'session-pr4::branch-pr4',
        decisionId: 'jit-decision-run-1-r1-s0',
        runId: 'run-1',
        parentNodeId: 'root',
        policyVersion: 'policy-pr4@v7'
      })
    ]);
    const stored = normalized[0];
    expect(stored?.decisionId).toBe('jit-decision-run-1-r1-s0');
    expect(stored?.runId).toBe('run-1');
    expect(stored?.round).toBe(1);
    expect(stored?.slotIndex).toBe(0);
    expect(stored?.parentNodeId).toBe('root');
    expect(stored?.trajectoryId).toBe('traj-pr4');
    expect(stored?.branchId).toBe('branch-pr4');
    expect(stored?.scopeKey).toBe('session-pr4::branch-pr4');
    expect(stored?.policyVersion).toBe('policy-pr4@v7');
    expect(stored?.rewardVersion).toBe(CURRENT_REWARD_VERSION);
    expect(stored?.provenanceVersion).toBe(CURRENT_PROVENANCE_VERSION);
    expect(stored?.experienceSchemaVersion).toBe(EXPERIENCE_SCHEMA_VERSION);
    expect(stored?.observedReturn).toBe(1);
    expect(stored?.attributionBaseline).toBe(0);
    expect(stored?.learningTarget).toBe(1);
    expect(stored?.outcome).toBe('succeeded');
    expect(stored?.learningEligible).toBe(true);
  });

  it('rejects a wrong-typed association field instead of guessing', () => {
    expect(() => normalizeExperienceRecords([record('bad-round', { round: 1.5 })])).toThrow(
      ExperienceRecordError
    );
    expect(() =>
      normalizeExperienceRecords([
        record('bad-outcome', { outcome: 'exploded' as unknown as ExperienceRecord['outcome'] })
      ])
    ).toThrow(ExperienceRecordError);
    expect(() =>
      normalizeExperienceRecords([
        record('bad-eligible', { learningEligible: 'yes' as unknown as boolean })
      ])
    ).toThrow(ExperienceRecordError);
  });

  it('keeps a pre-PR4 record loadable and classifies it as legacy', () => {
    const legacy = record('legacy-plain');
    const normalized = normalizeExperienceRecords([legacy]);
    expect(normalized[0]?.experienceSchemaVersion).toBeUndefined();
    expect(isLegacyStoredExperience(normalized[0] as StoredExperience)).toBe(true);
    expect(isLearningEligible(normalized[0] as StoredExperience)).toBe(false);
    const current = normalizeExperienceRecords([record('current-plain', CURRENT)])[0];
    expect(isLegacyStoredExperience(current as StoredExperience)).toBe(false);
    expect(isLearningEligible(current as StoredExperience)).toBe(true);
  });

  it('excludes legacy records from a version-filtered query but keeps them queryable', async () => {
    const store = createMemoryExperienceStore({ now: () => 100 });
    await store.append([
      record('legacy-1'),
      record('current-1', CURRENT),
      record('ineligible-1', { ...CURRENT, learningEligible: false })
    ]);

    const all = await store.query({ level: 'meta', state: STATE, k: 10, similarityThreshold: 0 });
    expect(all.map((entry) => entry.record.id).sort()).toEqual([
      'current-1',
      'ineligible-1',
      'legacy-1'
    ]);

    const learning = await store.query({
      level: 'meta',
      state: STATE,
      k: 10,
      similarityThreshold: 0,
      excludeLegacy: true
    });
    expect(learning.map((entry) => entry.record.id).sort()).toEqual(['current-1', 'ineligible-1']);

    const eligible = await store.query({
      level: 'meta',
      state: STATE,
      k: 10,
      similarityThreshold: 0,
      excludeLegacy: true,
      learningEligibleOnly: true
    });
    expect(eligible.map((entry) => entry.record.id)).toEqual(['current-1']);

    // Audit access survives: nothing was deleted.
    expect(await store.size('meta')).toBe(3);
  });

  it('accepts an explicit minimum schema version', async () => {
    const store = createMemoryExperienceStore({ now: () => 100 });
    await store.append([record('v2', CURRENT), record('v1', { experienceSchemaVersion: 1 })]);
    const atOne = await store.query({
      level: 'meta',
      state: STATE,
      k: 10,
      similarityThreshold: 0,
      excludeLegacy: true,
      minimumExperienceSchemaVersion: 1
    });
    expect(atOne.map((entry) => entry.record.id).sort()).toEqual(['v1', 'v2']);
  });

  it('validates the new query filters instead of silently ignoring them', () => {
    const base: ExperienceQuery = { level: 'meta', state: STATE, k: 1, similarityThreshold: 0 };
    expect(() =>
      executeExperienceQuery(new ExperienceIndex(), {
        ...base,
        excludeLegacy: 'yes' as unknown as boolean
      })
    ).toThrow(TypeError);
    expect(() =>
      executeExperienceQuery(new ExperienceIndex(), {
        ...base,
        minimumExperienceSchemaVersion: 0
      })
    ).toThrow(RangeError);
    expect(() =>
      executeExperienceQuery(new ExperienceIndex(), {
        ...base,
        learningEligibleOnly: 'no' as unknown as boolean
      })
    ).toThrow(TypeError);
  });

  it('isolates legacy records from the mirror-visible snapshot', () => {
    const visible = mirrorVisibleRecords([
      record('legacy-1'),
      record('current-1', CURRENT),
      record('ineligible-1', { ...CURRENT, learningEligible: false })
    ]);
    expect(visible.current.map((entry) => entry.id)).toEqual(['current-1']);
    expect(visible.legacyExcluded).toBe(1);
    expect(visible.ineligibleExcluded).toBe(1);
    expect(visible.isolated).toBe(true);
    expect(visible.rewardVersion).toBe(CURRENT_REWARD_VERSION);
    expect(visible.mixedRewardVersions).toBe(false);

    const clean = mirrorVisibleRecords([record('current-2', CURRENT)]);
    expect(clean.isolated).toBe(false);
    expect(clean.legacyExcluded).toBe(0);
  });

  it('flags a mirror snapshot that mixes reward versions', () => {
    const visible = mirrorVisibleRecords([
      record('current-a', CURRENT),
      record('current-b', { ...CURRENT, rewardVersion: 'r1/legacy-vector' })
    ]);
    expect(visible.mixedRewardVersions).toBe(true);
    expect(visible.isolated).toBe(false);
  });
});
