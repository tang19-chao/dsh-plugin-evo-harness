/**
 * P6.1-D2 / R3 F1-d: rewardVersion upgrade wiring - discriminating tests.
 *
 * The R3 review finding F1(medium): the RewardContract's upgradeRule had zero
 * production call points, CURRENT_REWARD_VERSION stayed on r2 while the
 * orchestrator already wrote r3, and neither isLearningEligible() nor the
 * backfill migration looked at rewardVersion - so after a real r2 -> r3
 * upgrade, old-yardstick records would be averaged into the same neighbourhood
 * as fresh r3 records.
 *
 * The three discriminating cases required by the fix:
 *   1. r2 and r3 records never mix into one neighbourhood / mean;
 *   2. the version bump triggers requiresExperienceRebuild's fail-closed
 *      behaviour - quarantine via marked copies, never an in-place rewrite of
 *      the audit log;
 *   3. isLearningEligible() isolates cross-version records.
 *
 * Every assertion is written so the PRE-FIX implementation fails it.
 */
import { describe, expect, it } from 'vitest';
import type {
  AbstractState,
  ExperienceRecord,
  JitCandidate
} from '../../../src/types/contracts';
import {
  CURRENT_REWARD_VERSION,
  EXPERIENCE_SCHEMA_VERSION,
  PREVIOUS_REWARD_VERSION,
  isLearningEligible,
  type StoredExperience
} from '../../../src/jitrl/experience-store';
import {
  REWARD_CONTRACT,
  isRewardVersionBump,
  isRewardVersionCompatible,
  requiresExperienceRebuild
} from '../../../src/jitrl/reward-contract';
import {
  BACKFILL_REWARD_VERSION,
  migrateExperienceRecords,
  partitionExperienceRecords
} from '../../../src/jitrl/backfill';
import { createMemoryExperienceStore } from '../../../src/jitrl/stores/memory.store';
import { createStoreOptimizer } from '../../../src/jitrl';
import { estimateStateValue } from '../../../src/jitrl/value-estimator';
import { DEFAULT_EVO_HARNESS_CONFIG } from '../../../src/config';
import type { JitRlConfig } from '../../../src/config';
import type { ScoredExperience } from '../../../src/types/contracts';

const T0 = 1_700_000_000_000;
const NOW = T0 + 60_000;

/**
 * `createStoreOptimizer` takes the mutable JitRlConfig while the frozen
 * defaults are deeply readonly, so the mutable fields are copied explicitly
 * (same pattern as learning-filter-wiring.test.ts).
 */
const OPTIMIZER_CONFIG: JitRlConfig = {
  ...DEFAULT_EVO_HARNESS_CONFIG.jitrl,
  levels: [...DEFAULT_EVO_HARNESS_CONFIG.jitrl.levels],
  similarityThreshold: 0,
  dream: {
    ...DEFAULT_EVO_HARNESS_CONFIG.jitrl.dream,
    candidateJitBetas: [...DEFAULT_EVO_HARNESS_CONFIG.jitrl.dream.candidateJitBetas],
    candidateJitLambdas: [...DEFAULT_EVO_HARNESS_CONFIG.jitrl.dream.candidateJitLambdas]
  }
};

function makeState(): AbstractState {
  return { level: 'proposal', bucket: 'task|fix|memory', tokens: ['sig:fix', 'slot:exploit'], summary: 'fix' };
}

interface VersionedOptions {
  readonly id: string;
  readonly rewardVersion?: string;
  readonly value: number;
  readonly schemaVersion?: number;
  readonly learningEligible?: boolean;
}

/** One proposal-level record with an explicit reward/schhema version mix. */
function versionedRecord(options: VersionedOptions): ExperienceRecord {
  return {
    id: options.id,
    level: 'proposal',
    state: makeState(),
    actionKey: 'patch:a',
    reward: options.value,
    return: options.value,
    observedReturn: options.value,
    rewardSources: { surrogate: options.value },
    guidance: 'memory',
    policyId: 'pi-0',
    sessionId: 'session-f1',
    experienceSchemaVersion: options.schemaVersion ?? EXPERIENCE_SCHEMA_VERSION,
    ...(options.rewardVersion === undefined ? {} : { rewardVersion: options.rewardVersion }),
    ...(options.learningEligible === undefined ? {} : { learningEligible: options.learningEligible }),
    createdAt: T0,
    redacted: true
  };
}

function scored(record: ExperienceRecord): ScoredExperience {
  return { record, similarity: 1, weight: 1 };
}

describe('F1-a: the persisted version constant IS the contract version', () => {
  it('CURRENT_REWARD_VERSION points at the RewardContract version (no store/orchestrator split)', () => {
    // Pre-fix: the store said 'r2/verifiable-v1' while the orchestrator wrote
    // the contract's 'r3/unified-signals-v1' - two sources of truth.
    expect(CURRENT_REWARD_VERSION).toBe(REWARD_CONTRACT.version);
    expect(CURRENT_REWARD_VERSION).toBe('r3/unified-signals-v1');
    // The previous lineage stays explicitly named, not implicit.
    expect(PREVIOUS_REWARD_VERSION).toBe('r2/verifiable-v1');
    expect(CURRENT_REWARD_VERSION).not.toBe(PREVIOUS_REWARD_VERSION);
  });

  it('the r2 -> r3 change is a real generation bump requiring a rebuild', () => {
    expect(isRewardVersionBump(PREVIOUS_REWARD_VERSION, CURRENT_REWARD_VERSION)).toBe(true);
    expect(requiresExperienceRebuild(PREVIOUS_REWARD_VERSION, CURRENT_REWARD_VERSION)).toBe(true);
  });
});

describe('F1-d ①: r2 and r3 records never mix into one neighbourhood mean', () => {
  it('the pure estimator never averages a mixed-version neighbour set', () => {
    // Same trajectory shape, wildly different calibration: an r2 winner-era
    // return of +2.5 vs an r3 contract return of -1. Averaging them would be
    // the exact cross-yardstick estimation P6.1-D eliminated for trajectories.
    const r2Record = versionedRecord({ id: 'r2-old', rewardVersion: 'r2/verifiable-v1', value: 2.5 });
    const r3Record = versionedRecord({ id: 'r3-new', rewardVersion: CURRENT_REWARD_VERSION, value: -1 });

    // Compatibility verdicts (the production wiring primitive).
    // P6.2 PR-A / F2: compatibility is EXACT contract-id matching, so a
    // surrogate backfill stamp is NOT compatible with the online contract
    // even though both carry the r3 generation prefix.
    expect(isRewardVersionCompatible('r2/verifiable-v1', CURRENT_REWARD_VERSION)).toBe(false);
    expect(isRewardVersionCompatible(CURRENT_REWARD_VERSION, CURRENT_REWARD_VERSION)).toBe(true);
    expect(isRewardVersionCompatible(BACKFILL_REWARD_VERSION, CURRENT_REWARD_VERSION)).toBe(false);
    expect(isRewardVersionCompatible(undefined, CURRENT_REWARD_VERSION)).toBe(false);
    expect(isRewardVersionCompatible('legacy', CURRENT_REWARD_VERSION)).toBe(false);
    expect(isRewardVersionCompatible('r4/future', CURRENT_REWARD_VERSION)).toBe(false);

    // Filtering to the compatible subset must leave ONLY the r3 record, so the
    // mean is the r3 value, not (2.5 + -1) / 2.
    const filtered = [r2Record, r3Record].filter((record) =>
      isRewardVersionCompatible(record.rewardVersion, CURRENT_REWARD_VERSION)
    );
    expect(filtered.map((record) => record.id)).toEqual(['r3-new']);
    expect(estimateStateValue(filtered.map(scored))).toBeCloseTo(-1, 12);
  });

  it('the store learning query excludes old-generation records from the L2 neighbourhood', async () => {
    const store = createMemoryExperienceStore({ now: () => NOW });
    await store.append([
      versionedRecord({ id: 'r3-a', rewardVersion: CURRENT_REWARD_VERSION, value: 2 }),
      versionedRecord({ id: 'r3-b', rewardVersion: CURRENT_REWARD_VERSION, value: 4 }),
      // Schema is current, eligibility flag is true, but the reward generation
      // is r2: the exact F1 scenario after a real upgrade.
      versionedRecord({ id: 'r2-poison', rewardVersion: 'r2/verifiable-v1', value: 99 }),
      versionedRecord({ id: 'unversioned-poison', value: 88 })
    ]);

    const optimizer = createStoreOptimizer({
      store,
      config: OPTIMIZER_CONFIG,
      halfLifeMs: 1_000_000_000,
      now: () => NOW,
      rng: () => 0.5
    });

    const candidates: readonly JitCandidate<undefined>[] = [
      { actionKey: 'patch:a', baseLogit: 0, source: 'policy_prior', payload: undefined }
    ];
    const decision = await optimizer.decide('proposal', makeState(), candidates);
    // Only the two r3 records are neighbours; the 99/88 poison never lands in
    // the mean (pre-fix: neighbourCount 4 and stateValue ~48).
    expect(decision.neighborCount).toBe(2);
    expect(decision.stateValue).toBeCloseTo(3, 6);
  });
});

describe('F1-d ②: the upgrade quarantines via marked copies, never an in-place rewrite', () => {
  it('migrates schema-current r2 records as rewardVersionIsolated marked copies', async () => {
    const r2OnlineRecord = versionedRecord({
      id: 'r2-online',
      rewardVersion: 'r2/verifiable-v1',
      value: 1.5,
      learningEligible: true
    });
    const r3OnlineRecord = versionedRecord({
      id: 'r3-online',
      rewardVersion: CURRENT_REWARD_VERSION,
      value: 2,
      learningEligible: true
    });
    const source = [r2OnlineRecord, r3OnlineRecord];
    const before = JSON.stringify(source);

    const dryRun = await migrateExperienceRecords({ records: source });
    // The r2 record is quarantined BECAUSE of its reward version (schema was
    // current), and the count says so explicitly.
    expect(dryRun.rewardVersionIsolated).toBe(1);
    expect(dryRun.legacy).toBe(1);
    expect(dryRun.current).toBe(1);
    // The audit diagnostic names the version conflict.
    expect(dryRun.diagnostics.join(' ')).toContain('incompatible with ' + CURRENT_REWARD_VERSION);
    // Marked copy: legacy tag + audit-only, same identity.
    expect(dryRun.marked).toHaveLength(1);
    expect(dryRun.marked[0]?.id).toBe('r2-online');
    expect(dryRun.marked[0]?.rewardVersion).toBe('legacy');
    expect(dryRun.marked[0]?.learningEligible).toBe(false);
    // Fail-closed on the source log: nothing was rewritten in place.
    expect(JSON.stringify(source)).toBe(before);

    // The r3 record's own bytes are untouched by the pass.
    expect(source[1]?.rewardVersion).toBe(CURRENT_REWARD_VERSION);
  });

  it('partitionExperienceRecords keeps old-yardstick records out of the learning set', () => {
    const partition = partitionExperienceRecords([
      versionedRecord({ id: 'r2-old', rewardVersion: 'r2/verifiable-v1', value: 3 }),
      versionedRecord({ id: 'r3-stay', rewardVersion: CURRENT_REWARD_VERSION, value: 1 }),
      versionedRecord({ id: 'r3-backfill', rewardVersion: BACKFILL_REWARD_VERSION, value: 2 }),
      versionedRecord({ id: 'no-version', value: 5 })
    ]);
    // P6.2 PR-A / F2: learning keeps exactly the online-contract records;
    // audit-only keeps the r2 line, the unversioned line AND the surrogate
    // backfill line (target-heterogeneous with the online contract).
    expect(partition.learning.map((record) => record.id).sort()).toEqual(['r3-stay']);
    expect(partition.auditOnly.map((record) => record.id).sort()).toEqual([
      'no-version',
      'r2-old',
      'r3-backfill'
    ]);
  });
});

describe('F1-d ③: isLearningEligible isolates cross-version records', () => {
  const stored = (record: ExperienceRecord): StoredExperience =>
    ({
      ...record,
      bucket: record.state.bucket,
      tokens: [...record.state.tokens],
      summary: record.state.summary ?? '',
      treeId: undefined,
      nodeId: undefined,
      branchId: undefined,
      scopeKey: undefined,
      decisionId: undefined,
      runId: undefined,
      round: undefined,
      slotIndex: undefined,
      parentNodeId: undefined,
      trajectoryId: undefined,
      policyVersion: undefined,
      provenanceVersion: undefined,
      attributionBaseline: undefined,
      learningTarget: undefined,
      outcome: undefined
    }) as StoredExperience;

  it('accepts only exact-current-contract records, whatever the schema flag says', () => {
    // Current generation, schema current, eligible -> learns.
    expect(
      isLearningEligible(
        stored(versionedRecord({ id: 'ok', rewardVersion: CURRENT_REWARD_VERSION, value: 1 }))
      )
    ).toBe(true);
    // P6.2 PR-A / F2: surrogate rebuild stamps a DIFFERENT contract id, which
    // is not certified compatible -> isolated (the cold-start surrogate prior
    // is audit-only; only a rescore with original evidence re-enters, stamped
    // with the rescore id).
    expect(
      isLearningEligible(
        stored(versionedRecord({ id: 'rebuilt', rewardVersion: BACKFILL_REWARD_VERSION, value: 1 }))
      )
    ).toBe(false);
    // Schema-current but r2 generation -> isolated (the F1 scenario).
    expect(
      isLearningEligible(
        stored(versionedRecord({ id: 'old-gen', rewardVersion: 'r2/verifiable-v1', value: 1 }))
      )
    ).toBe(false);
    // No version at all -> proves nothing -> fails closed.
    expect(isLearningEligible(stored(versionedRecord({ id: 'bare', value: 1 })))).toBe(false);
    // Unknown shape -> fails closed.
    expect(
      isLearningEligible(stored(versionedRecord({ id: 'alien', rewardVersion: 'legacy', value: 1 })))
    ).toBe(false);
    // Future generation -> this code predates that contract -> fails closed.
    expect(
      isLearningEligible(stored(versionedRecord({ id: 'future', rewardVersion: 'r4/x', value: 1 })))
    ).toBe(false);
    // Explicit learningEligible: false keeps vetoing regardless of version.
    expect(
      isLearningEligible(
        stored(
          versionedRecord({
            id: 'ineligible',
            rewardVersion: CURRENT_REWARD_VERSION,
            value: 1,
            learningEligible: false
          })
        )
      )
    ).toBe(false);
  });
});
