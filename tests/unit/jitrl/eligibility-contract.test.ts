/**
 * P6.2 PR-A / F1+F2: the unified learning-eligibility predicate and the
 * exact-contract compatibility rule.
 *
 * This file converts the P6.1 review's three defect-reproduction probes
 * (work/p61-evidence/runs/probes/reviewer.test.ts, sections 4/5 of the review
 * document) into POSITIVE regressions:
 *
 *   F1 probe - old-r2 (return=+3) + new-r3 (return=-1) in the same bucket:
 *     BEFORE: store.query kept 1 (new-r3) but L1 selectBatch and the replay
 *       hook both saw 2 neighbours and estimated V = +1 (cross-yardstick mix),
 *       and the M3 fresh count reported usable=2 / fresh=2.
 *     AFTER (asserted here): all FOUR entry classes - strict store.query,
 *       L1 createJitActivePolicy, createJitReplayHook and the M3 fresh count -
 *       keep ONLY new-r3 and estimate V = -1.
 *
 *   F2 probe - a surrogate-only backfill record (score=0.9 ->
 *     observedReturn ~ +2.4 stamped r3/backfill-tree-v1):
 *     BEFORE: accepted by a strict store.query because compatibility was
 *       generation-prefix equality.
 *     AFTER: rejected everywhere - exact contract id or certified table only.
 *
 *   F3 upgrade drill - five historical shapes (r2 JSONL, current r3, missing
 *     version, future r4/x, surrogate backfill history) behave IDENTICALLY at
 *     four entry classes, including after hydrate() loads an old log, swaps
 *     the drive and backfills again (restart consistency).
 *
 * Every assertion goes through a real production entry point; none calls the
 * predicate directly as its only evidence (see the wiring tests inside for
 * the mutation companion).
 */
import { describe, expect, it } from 'vitest';
import type {
  AbstractState,
  DiscoveryNode,
  DiscoveryTreeSnapshot,
  ExperienceQuery,
  ExperienceRecord,
  JitReplayHookInput,
  SearchGridPlan,
  SelectBatchRequest
} from '../../../src/types/contracts';
import { DEFAULT_EVO_HARNESS_CONFIG, parseEvoHarnessConfig } from '../../../src/config';
import type { EvoHarnessConfig, JitRlConfig } from '../../../src/config';
import { createActivePolicy } from '../../../src/dream-rsi/active-policy';
import {
  CURRENT_PROVENANCE_VERSION,
  CURRENT_REWARD_VERSION,
  EXPERIENCE_SCHEMA_VERSION
} from '../../../src/jitrl/experience-store';
import { createMemoryExperienceStore } from '../../../src/jitrl/stores/memory.store';
import { createJitRl } from '../../../src/jitrl/index';
import {
  buildMetaState,
  createJitActivePolicy,
  readJitDiagnostics
} from '../../../src/jitrl/jit-active-policy';
import { createJitReplayHook, createStoreOptimizer } from '../../../src/jitrl/index';
import { normalizeMetaAction } from '../../../src/jitrl/action-normalizer';
import {
  REWARD_CONTRACT,
  REWARD_CONTRACT_COMPATIBLE_IDS,
  RESCORE_REWARD_VERSION,
  contractWeightsHash,
  isLearningEligibleRecord,
  isRewardVersionCompatible,
  isRewardVersionExact,
  isValidRescoreProvenance,
  strictTargetContractIds
} from '../../../src/jitrl/reward-contract';
import {
  BACKFILL_RECORD_PREFIX,
  BACKFILL_REWARD_VERSION,
  backfillFromTreePool,
  buildRescoredBackfillRecord,
  isSurrogatePriorRecord,
  parseRescoreProvenanceVersion
} from '../../../src/jitrl/backfill';
import { isLearningEligibleExperience } from '../../../src/jitrl/decision-kernel';

const T0 = 1_700_000_000_000;
const NOW = T0 + 60_000;
const HALF_LIFE = 60_000;
const NO_EXPLORE = (): number => 0.999;

// ---------------------------------------------------------------------------
// Fixtures (mirror the review probe's shapes)
// ---------------------------------------------------------------------------

function makeNode(
  overrides: Partial<DiscoveryNode> & Pick<DiscoveryNode, 'id'>
): DiscoveryNode {
  return {
    treeId: 'tree-elig',
    parentId: null,
    depth: 0,
    branchId: 'branch-' + overrides.id,
    patchId: 'patch-' + overrides.id,
    patchOrigin: 'reference',
    purpose: 'initial',
    guidance: 'memory',
    status: 'succeeded',
    childIds: [],
    createdAt: T0,
    updatedAt: T0,
    ...overrides
  };
}

/** The review's F2 tree: one scored node with score = 0.9. */
function makeTree(): DiscoveryTreeSnapshot {
  const built: Record<string, DiscoveryNode> = {
    root: makeNode({ id: 'root', guidance: 'guidance_free' }),
    best: makeNode({
      id: 'best',
      parentId: 'root',
      depth: 1,
      slot: 'exploit',
      purpose: 'deepen',
      score: 0.9
    })
  };
  const rootNode = built.root as DiscoveryNode;
  built.root = { ...rootNode, childIds: ['best'] };
  return {
    id: 'tree-elig',
    sessionId: 'session-elig',
    taskId: 'task-elig',
    rootId: 'root',
    nodes: built,
    policyId: 'pi-0',
    stats: {
      nodeCount: 2,
      maxDepth: 1,
      maxWidth: 2,
      scoredNodes: 1,
      completedNodes: 2
    },
    completed: false,
    createdAt: T0,
    updatedAt: T0
  };
}

function makeGrid(): SearchGridPlan {
  return {
    maxWidth: 8,
    maxDepth: 2,
    budget: 8,
    skipProbing: false,
    stopCondition: 'budget_exhausted',
    complexity: 'moderate',
    rationale: 'eligibility grid',
    policyId: 'pi-0'
  };
}

function makeRequest(): SelectBatchRequest {
  return {
    task: {
      id: 'task-elig',
      prompt: 'Fix the failing build without breaking the release train.',
      taskSignature: 'fix-build',
      complexity: 'moderate',
      contextTags: ['ci']
    },
    sessionId: 'session-elig',
    tree: makeTree(),
    grid: makeGrid(),
    memoryConfidence: 0.8,
    round: 1,
    previousBestNodeId: 'best'
  };
}

function parityState(): AbstractState {
  return buildMetaState(makeRequest());
}

interface EligibilityOptions {
  readonly id: string;
  readonly value: number;
  readonly rewardVersion?: string;
  readonly schemaVersion?: number;
  readonly learningEligible?: boolean;
  readonly policyId?: string;
}

/**
 * One meta record at the request's exact state. `rewardVersion` is omitted
 * only when deliberately modelling an unversioned line.
 */
function elig(options: EligibilityOptions): ExperienceRecord {
  const state = parityState();
  const record: ExperienceRecord = {
    id: options.id,
    level: 'meta',
    state,
    actionKey: normalizeMetaAction('exploit', []),
    reward: options.value,
    return: options.value,
    rewardSources: { surrogate: options.value },
    guidance: 'memory',
    policyId: options.policyId ?? 'pi-0',
    sessionId: 'session-elig',
    treeId: 'tree-elig',
    nodeId: options.id,
    experienceSchemaVersion: options.schemaVersion ?? EXPERIENCE_SCHEMA_VERSION,
    learningEligible: options.learningEligible ?? true,
    createdAt: T0 - 60_000,
    redacted: true
  };
  if (options.rewardVersion !== undefined) {
    return { ...record, rewardVersion: options.rewardVersion };
  }
  return record;
}

/** The F1 probe pair: old r2 return +3 vs new r3 return -1. */
function f1Pair(): readonly ExperienceRecord[] {
  return [
    elig({
      id: 'old-r2',
      value: 3,
      rewardVersion: 'r2/verifiable-v1'
    }),
    elig({
      id: 'new-r3',
      value: -1,
      rewardVersion: CURRENT_REWARD_VERSION
    })
  ] as readonly ExperienceRecord[];
}

function innerPolicy() {
  return createActivePolicy({
    policy: {
      id: 'pi-0',
      version: 3,
      createdAt: T0,
      maxWidth: 4,
      maxDepth: 2,
      slotWeights: { exploit: 0.4, explore_domain: 0.3, explore_invariant: 0.2, recover: 0.1 },
      earlyStopThreshold: 0.8,
      minMemoryConfidenceForSkip: 0.75
    } as never,
    now: () => T0,
    maxRecoverySlots: 1
  });
}

function replayHook() {
  return createJitReplayHook({
    config: DEFAULT_EVO_HARNESS_CONFIG.jitrl,
    stateOf: () => parityState(),
    now: () => NOW,
    seed: 7
  });
}

function hookInput(
  experiences: readonly ExperienceRecord[],
  overrides: Partial<JitReplayHookInput> = {}
): JitReplayHookInput {
  return {
    treeId: 'tree-elig',
    policyId: 'pi-0',
    rho: 0.5,
    slotWeights: { exploit: 0.4, explore_domain: 0.3, explore_invariant: 0.2, recover: 0.1 },
    frontier: {
      nodeId: 'best',
      depth: 1,
      patchOrigin: 'domain',
      purpose: 'deepen',
      guidance: 'memory',
      slot: 'exploit',
      score: 0.9,
      createdAt: T0
    },
    experiences,
    jit: {
      beta: 1,
      lambda: 0,
      alpha: 0,
      k: 10,
      gamma: 0.5,
      similarityThreshold: 0.3
    },
    driftRho: 0.7,
    ...overrides
  };
}

const OPTIMIZER_CONFIG: JitRlConfig = {
  ...DEFAULT_EVO_HARNESS_CONFIG.jitrl,
  levels: [...DEFAULT_EVO_HARNESS_CONFIG.jitrl.levels],
  dream: {
    ...DEFAULT_EVO_HARNESS_CONFIG.jitrl.dream,
    candidateJitBetas: [...DEFAULT_EVO_HARNESS_CONFIG.jitrl.dream.candidateJitBetas],
    candidateJitLambdas: [...DEFAULT_EVO_HARNESS_CONFIG.jitrl.dream.candidateJitLambdas]
  }
};

/**
 * A mutable EvoHarnessConfig for createJitRl: the frozen defaults are deeply
 * readonly, so the kernel factory (which takes the mutable type) cannot accept
 * them directly. Parsing the defaults back through the resolver returns the
 * mutable shape with identical values.
 */
function e2eBaseConfig(): EvoHarnessConfig {
  return parseEvoHarnessConfig({});
}

const STRICT_QUERY = (): ExperienceQuery => ({
  level: 'meta',
  state: parityState(),
  k: 10,
  similarityThreshold: 0,
  excludeLegacy: true,
  learningEligibleOnly: true
});

// ---------------------------------------------------------------------------
// F1: the probe pair, entry class by entry class
// ---------------------------------------------------------------------------

describe('F1 probe regression: old-r2 (+3) and new-r3 (-1) at every entry', () => {
  it('store.query keeps only new-r3 (V = -1)', async () => {
    const store = createMemoryExperienceStore({ now: () => NOW, halfLifeMs: HALF_LIFE });
    await store.append(f1Pair() as ExperienceRecord[]);
    const queried = await store.query(STRICT_QUERY());
    expect(queried.map((entry) => entry.record.id)).toEqual(['new-r3']);
  });

  it('L1 createJitActivePolicy keeps only new-r3 and estimates V = -1', () => {
    const jit = createJitActivePolicy({
      inner: innerPolicy(),
      experiences: f1Pair() as ExperienceRecord[],
      config: { useSurfaces: false },
      now: () => NOW,
      rng: NO_EXPLORE
    });
    const diagnostics = readJitDiagnostics(jit.selectBatch(makeRequest()));
    // BEFORE the fix: neighborCount 2, stateValue +1 (the mixed estimate).
    expect(diagnostics?.neighborCount).toBe(1);
    expect(diagnostics?.stateValue).toBeCloseTo(-1, 6);
    expect(diagnostics?.filter?.records).toBe(2);
    expect(diagnostics?.filter?.kept).toBe(1);
  });

  it('replay keeps only new-r3 and estimates V = -1', () => {
    const replayed = replayHook()(hookInput(f1Pair()));
    expect(replayed.diagnostics.neighborCount).toBe(1);
    expect(replayed.diagnostics.stateValue).toBeCloseTo(-1, 6);
    const notes = (replayed.diagnostics.notes ?? []).join(' ');
    expect(notes).toContain('filtered 1 of 2');
  });

  it('M3 fresh/usable denominators count neither the old-r2 nor the surrogate lines', () => {
    // The review's polluted-batch variant: usable=2 / fresh=2 came from
    // counting the old-version record as fresh support.
    const polluted = [
      ...f1Pair(),
      elig({ id: 'unversioned', value: 9 }),
      elig({ id: 'surrogate', value: 5, rewardVersion: BACKFILL_REWARD_VERSION })
    ];
    const replayed = replayHook()(
      hookInput(polluted, {
        jit: {
          beta: 1,
          lambda: 0,
          alpha: 0,
          k: 2,
          gamma: 0.5,
          similarityThreshold: 0.3
        }
      })
    );
    const notes = (replayed.diagnostics.notes ?? []).join(' ');
    // usable 1 / fresh 1 (only new-r3, written by pi-0); the k=2 case must NOT
    // saturate, so the drift penalty note stays absent.
    expect(notes).toContain('usable 1');
    expect(notes).toContain('=1/2');
    expect(notes).not.toContain('drift penalty inactive');
  });

  it('L2 createStoreOptimizer applies the same cut through store.query', async () => {
    const store = createMemoryExperienceStore({ now: () => NOW, halfLifeMs: HALF_LIFE });
    const state = parityState();
    const pairAtProposal = (f1Pair() as ExperienceRecord[]).map((record) => ({
      ...record,
      id: record.id + '-l2',
      level: 'proposal' as const,
      state: { ...state, level: 'proposal' as const }
    }));
    await store.append(pairAtProposal);
    const optimizer = createStoreOptimizer({
      store,
      config: { ...OPTIMIZER_CONFIG, similarityThreshold: 0 },
      halfLifeMs: HALF_LIFE,
      now: () => NOW,
      rng: () => 0.999
    });
    const decision = await optimizer.decide('proposal', { ...state, level: 'proposal' }, [
      { actionKey: 'patch:a', baseLogit: 0, source: 'policy_prior', payload: undefined }
    ]);
    expect(decision.neighborCount).toBe(1);
    expect(decision.stateValue).toBeCloseTo(-1, 6);
  });

  it('L3 kernel.createHostAdvisor queries with the same strict filter and the kernel store stamps its producers', async () => {
    // The kernel composition root is the L3 learning-consumer wiring point:
    // the advisor's store seam must carry learningFacingFilterOptions, and the
    // facade append must stamp current versions on records whose producer does
    // not stamp (the host-tool collector) so fail-closed filtering never
    // excludes fresh evidence for lacking a stamp.
    const config = e2eBaseConfig();
    config.jitrl.hostAdvisor = {
      ...config.jitrl.hostAdvisor,
      enabled: true,
      mode: 'advisory',
      adviseThreshold: -0.2,
      gateThreshold: -0.2,
      minSupport: 1
    };
    const kernel = createJitRl({ config, now: () => NOW });
    const advisor = kernel.createHostAdvisor();

    // One host_tool state shared by all the records below.
    const hostState: AbstractState = {
      level: 'host_tool',
      bucket: 'recent:bash|error:exit_127',
      tokens: ['tool:bash', 'error:exit_127'],
      summary: 'bash after failure'
    };
    const hostRecord = (
      id: string,
      value: number,
      extra: Partial<ExperienceRecord> = {}
    ): ExperienceRecord => ({
      id,
      level: 'host_tool',
      state: hostState,
      actionKey: 'tool:bash',
      reward: value,
      return: value,
      rewardSources: { tool: value },
      guidance: 'memory',
      policyId: 'pi-0',
      sessionId: 'session-elig',
      createdAt: T0 - 60_000,
      redacted: true,
      ...extra
    });

    // A stamped current record (the online path) plus an old-r2 record and a
    // surrogate record at host_tool level - the +5 inflators L3 must exclude.
    // (An unversioned line cannot reach the facade un-stamped: append() stamps
    // new producers, and historical unversioned lines only arrive through the
    // JSONL load path; that case is covered by the F3 drill at L1/replay.)
    await kernel.store.append([
      hostRecord('h-r3', -2, {
        experienceSchemaVersion: EXPERIENCE_SCHEMA_VERSION,
        rewardVersion: CURRENT_REWARD_VERSION,
        provenanceVersion: CURRENT_PROVENANCE_VERSION,
        learningEligible: true
      }),
      hostRecord('h-r2', 5, {
        experienceSchemaVersion: EXPERIENCE_SCHEMA_VERSION,
        rewardVersion: 'r2/verifiable-v1',
        provenanceVersion: CURRENT_PROVENANCE_VERSION,
        learningEligible: true
      }),
      hostRecord('h-surr', 5, {
        experienceSchemaVersion: EXPERIENCE_SCHEMA_VERSION,
        rewardVersion: BACKFILL_REWARD_VERSION,
        provenanceVersion: 'p2/backfill-tree-v1',
        learningEligible: true
      })
    ]);

    // Unversioned append through the kernel facade is stamped current (the
    // host-tool producer does not stamp), so it must be learning-visible.
    await kernel.store.append([hostRecord('h-auto', -1)]);

    const decision = await advisor.evaluate({
      level: 'host_tool',
      state: hostState,
      recentTools: [{ name: 'bash' } as never],
      errors: [],
      mode: 'advisory',
      adviseThreshold: -0.2,
      gateThreshold: -0.2,
      minSupport: 1,
      policyId: 'pi-0'
    });
    // The advice carries only the strict set: V from (-2, -1) = -1.5; the +5
    // inflators (r2 / surrogate) are excluded by the L3 learning filter.
    expect(decision.diagnostics).toBeDefined();
    expect(decision.diagnostics?.support).toBe(2);
    expect(decision.diagnostics?.stateValue).toBeCloseTo(-1.5, 6);

    // And the auto-stamped record really carries the current contract id.
    const allHost = await kernel.store.query({
      level: 'host_tool',
      state: hostState,
      k: 10,
      similarityThreshold: 0
    });
    const auto = allHost.map((entry) => entry.record).find((record) => record.id === 'h-auto');
    expect(auto?.rewardVersion).toBe(CURRENT_REWARD_VERSION);
    expect(auto?.experienceSchemaVersion).toBe(EXPERIENCE_SCHEMA_VERSION);
  });
});

// ---------------------------------------------------------------------------
// F2: surrogate-only backfill isolation
// ---------------------------------------------------------------------------

describe('F2 probe regression: surrogate-only backfill never enters the online r3 neighbourhood', () => {
  it('exact-contract compatibility rejects r3/backfill-tree-v1 against r3/unified-signals-v1', () => {
    // BEFORE: generation-prefix equality made this true.
    expect(isRewardVersionCompatible(BACKFILL_REWARD_VERSION, CURRENT_REWARD_VERSION)).toBe(false);
    expect(isRewardVersionExact(BACKFILL_REWARD_VERSION, CURRENT_REWARD_VERSION)).toBe(false);
    // The certified table does not list the surrogate producer.
    expect(
      REWARD_CONTRACT_COMPATIBLE_IDS[CURRENT_REWARD_VERSION]?.includes(BACKFILL_REWARD_VERSION)
    ).not.toBe(true);
    // Self-compatibility still holds for audit tooling that filters by id.
    expect(isRewardVersionExact(BACKFILL_REWARD_VERSION, BACKFILL_REWARD_VERSION)).toBe(true);
    // Compatibility is symmetric.
    expect(isRewardVersionExact(CURRENT_REWARD_VERSION, BACKFILL_REWARD_VERSION)).toBe(false);
  });

  it('the strict store.query no longer accepts the surrogate-only record', async () => {
    const store = createMemoryExperienceStore({ now: () => NOW });
    const result = await backfillFromTreePool({ pool: [makeTree()], store, now: () => NOW });
    expect(result.records.length).toBeGreaterThan(0);
    const rec = result.records[0] as ExperienceRecord;
    // The review's numbers: score=0.9 -> observedReturn ~ +2.4 (clip [−3,3]
    // span 6 * 0.9 − 3 = 2.4), previously accepted into the neighbourhood.
    expect(rec.observedReturn).toBeCloseTo(2.4, 6);
    expect(rec.rewardVersion).toBe(BACKFILL_REWARD_VERSION);
    expect(rec.learningEligible).toBe(false); // surrogatePrior / audit-only
    expect(isSurrogatePriorRecord(rec)).toBe(true);
    const queried = await store.query({
      level: 'meta',
      state: rec.state,
      k: 10,
      similarityThreshold: 0,
      excludeLegacy: true,
      learningEligibleOnly: true
    });
    // BEFORE: queried.length > 0 (the F2 defect). AFTER: quarantined.
    expect(queried).toHaveLength(0);
  });

  it('a rescored record with full original-evidence provenance IS accepted', async () => {
    const store = createMemoryExperienceStore({ now: () => NOW });
    const result = await backfillFromTreePool({ pool: [makeTree()], store, now: () => NOW });
    const base = result.records[0] as ExperienceRecord;
    const provenance = {
      sourceTrajectoryHash: 'sha256:abc123',
      targetContractId: CURRENT_REWARD_VERSION,
      aggregation: 'trajectory-signals-v1',
      horizon: 'single-trajectory',
      weightsHash: contractWeightsHash(),
      verifierId: 'verifier-ci-01'
    };
    expect(isValidRescoreProvenance(provenance)).toBe(true);
    const rescored = buildRescoredBackfillRecord({
      base,
      provenance,
      contractObservedReturn: -1
    });
    expect(rescored).toBeDefined();
    const record = rescored as ExperienceRecord;
    expect(record.rewardVersion).toBe(RESCORE_REWARD_VERSION);
    expect(record.learningEligible).toBe(true);
    // The provenance chain survives on the record and parses back.
    const parsed = parseRescoreProvenanceVersion(record.provenanceVersion);
    expect(parsed?.sourceTrajectoryHash).toBe('sha256:abc123');
    expect(parsed?.targetContractId).toBe(CURRENT_REWARD_VERSION);
    expect(parsed?.aggregation).toBe('trajectory-signals-v1');
    expect(parsed?.horizon).toBe('single-trajectory');
    expect(parsed?.weightsHash).toBe(contractWeightsHash());
    expect(parsed?.verifierId).toBe('verifier-ci-01');
    // And the certified table accepts the rescore id.
    expect(isRewardVersionCompatible(RESCORE_REWARD_VERSION, CURRENT_REWARD_VERSION)).toBe(true);
    const appended = createMemoryExperienceStore({ now: () => NOW });
    await appended.append([record]);
    const queried = await appended.query({
      level: 'meta',
      state: record.state,
      k: 10,
      similarityThreshold: 0,
      excludeLegacy: true,
      learningEligibleOnly: true
    });
    expect(queried.map((entry) => entry.record.id)).toEqual([record.id]);
  });

  it('a rescore without valid provenance fails closed (stays audit-only)', () => {
    const result = { records: [] as ExperienceRecord[] };
    void result;
    const base = elig({ id: 'surrogate-base', value: 2.4, rewardVersion: BACKFILL_REWARD_VERSION });
    // Missing verifierId and a foreign aggregation: must not pass.
    const bad = buildRescoredBackfillRecord({
      base,
      provenance: {
        sourceTrajectoryHash: 'sha256:abc',
        targetContractId: CURRENT_REWARD_VERSION,
        aggregation: 'something-else-v9',
        horizon: 'single-trajectory',
        weightsHash: contractWeightsHash()
      },
      contractObservedReturn: 1
    });
    expect(bad).toBeUndefined();
    // A weights hash from a different scale is a different yardstick.
    const foreignWeights = buildRescoredBackfillRecord({
      base,
      provenance: {
        sourceTrajectoryHash: 'sha256:abc',
        targetContractId: CURRENT_REWARD_VERSION,
        aggregation: 'trajectory-signals-v1',
        horizon: 'single-trajectory',
        weightsHash: 'deadbeef',
        verifierId: 'v1'
      },
      contractObservedReturn: 1
    });
    expect(foreignWeights).toBeUndefined();
    expect(isValidRescoreProvenance(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The single predicate, fail-closed on every axis
// ---------------------------------------------------------------------------

describe('the single learning-eligibility predicate (one implementation, fail-closed)', () => {
  it('accepts exactly: current id, eligible, current schema', () => {
    expect(
      isLearningEligibleExperience(
        elig({ id: 'ok', value: 1, rewardVersion: CURRENT_REWARD_VERSION })
      )
    ).toBe(true);
    // Certified compatible rescore id.
    expect(
      isLearningEligibleExperience(
        elig({ id: 'rescore', value: 1, rewardVersion: RESCORE_REWARD_VERSION })
      )
    ).toBe(true);
  });

  it('rejects old generation, unversioned, future, surrogate, ineligible, legacy schema', () => {
    expect(
      isLearningEligibleExperience(elig({ id: 'r2', value: 1, rewardVersion: 'r2/verifiable-v1' }))
    ).toBe(false);
    expect(isLearningEligibleExperience(elig({ id: 'bare', value: 1 }))).toBe(false);
    expect(
      isLearningEligibleExperience(elig({ id: 'future', value: 1, rewardVersion: 'r4/x' }))
    ).toBe(false);
    expect(
      isLearningEligibleExperience(
        elig({ id: 'surrogate', value: 1, rewardVersion: BACKFILL_REWARD_VERSION })
      )
    ).toBe(false);
    expect(
      isLearningEligibleExperience(
        elig({ id: 'vetoed', value: 1, rewardVersion: CURRENT_REWARD_VERSION, learningEligible: false })
      )
    ).toBe(false);
    expect(
      isLearningEligibleExperience(
        elig({ id: 'legacy-schema', value: 1, rewardVersion: CURRENT_REWARD_VERSION, schemaVersion: 1 })
      )
    ).toBe(false);
  });

  it('store-side and kernel-side predicates are the same rule (no second strict copy)', () => {
    // The store's isLearningEligible delegates to the same leaf predicate the
    // kernel re-exports; identical inputs must give identical verdicts for
    // every discriminating shape.
    const shapes: readonly ExperienceRecord[] = [
      elig({ id: 'ok', value: 1, rewardVersion: CURRENT_REWARD_VERSION }),
      elig({ id: 'r2', value: 1, rewardVersion: 'r2/verifiable-v1' }),
      elig({ id: 'bare', value: 1 }),
      elig({ id: 'r4', value: 1, rewardVersion: 'r4/x' }),
      elig({ id: 'surr', value: 1, rewardVersion: BACKFILL_REWARD_VERSION }),
      elig({ id: 'rescore', value: 1, rewardVersion: RESCORE_REWARD_VERSION }),
      elig({ id: 'veto', value: 1, rewardVersion: CURRENT_REWARD_VERSION, learningEligible: false })
    ];
    for (const record of shapes) {
      expect(isLearningEligibleRecord(record)).toBe(isLearningEligibleExperience(record));
    }
  });

  it('the declared accepted ids are exactly the current id plus the certified table', () => {
    expect(strictTargetContractIds()).toEqual([CURRENT_REWARD_VERSION, RESCORE_REWARD_VERSION]);
    expect(strictTargetContractIds(BACKFILL_REWARD_VERSION)).toEqual([BACKFILL_REWARD_VERSION]);
    expect(CURRENT_REWARD_VERSION).toBe(REWARD_CONTRACT.version);
  });
});

// ---------------------------------------------------------------------------
// F3 upgrade drill: five input shapes x four entry classes, one behaviour
// ---------------------------------------------------------------------------

/**
 * The five historical shapes the upgrade drill must handle identically:
 *   r2 JSONL        - schema current, reward generation superseded;
 *   r3 current      - the online recorder's stamp (LEARNING);
 *   missing version - old line that predates stamping;
 *   future r4/x     - a log written by a newer contract;
 *   surrogate backfill history - pre-quarantine surrogate lines.
 */
function drillInputs(): readonly { readonly label: string; readonly record: ExperienceRecord }[] {
  return [
    { label: 'r2-jsonl', record: elig({ id: 'd-r2', value: 3, rewardVersion: 'r2/verifiable-v1' }) },
    { label: 'r3-current', record: elig({ id: 'd-r3', value: -1, rewardVersion: CURRENT_REWARD_VERSION }) },
    { label: 'missing-version', record: elig({ id: 'd-bare', value: 9 }) },
    { label: 'future-r4', record: elig({ id: 'd-r4', value: 5, rewardVersion: 'r4/x' }) },
    { label: 'surrogate-history', record: elig({ id: 'd-surr', value: 5, rewardVersion: BACKFILL_REWARD_VERSION, learningEligible: true }) }
  ];
}

const EXPECTED_KEPT: readonly string[] = ['d-r3'];

describe('F3 upgrade drill: five input shapes behave identically at four entry classes', () => {
  it('store.query keeps exactly the current-contract records', async () => {
    const store = createMemoryExperienceStore({ now: () => NOW, halfLifeMs: HALF_LIFE });
    await store.append(drillInputs().map((entry) => entry.record));
    const queried = await store.query(STRICT_QUERY());
    expect(queried.map((entry) => entry.record.id).sort()).toEqual([...EXPECTED_KEPT]);
  });

  it('L1 keeps exactly the current-contract records', () => {
    const jit = createJitActivePolicy({
      inner: innerPolicy(),
      experiences: drillInputs().map((entry) => entry.record),
      config: { useSurfaces: false },
      now: () => NOW,
      rng: NO_EXPLORE
    });
    const diagnostics = readJitDiagnostics(jit.selectBatch(makeRequest()));
    expect(diagnostics?.neighborCount).toBe(EXPECTED_KEPT.length);
    expect(diagnostics?.filter?.records).toBe(5);
    expect(diagnostics?.filter?.kept).toBe(1);
    expect(diagnostics?.stateValue).toBeCloseTo(-1, 6);
  });

  it('replay keeps exactly the current-contract records', () => {
    const replayed = replayHook()(hookInput(drillInputs().map((entry) => entry.record)));
    expect(replayed.diagnostics.neighborCount).toBe(EXPECTED_KEPT.length);
    expect(replayed.diagnostics.stateValue).toBeCloseTo(-1, 6);
    const notes = (replayed.diagnostics.notes ?? []).join(' ');
    expect(notes).toContain('filtered 4 of 5');
  });

  it('M3 usable counts exactly the current-contract records', () => {
    const replayed = replayHook()(hookInput(drillInputs().map((entry) => entry.record)));
    const notes = (replayed.diagnostics.notes ?? []).join(' ');
    expect(notes).toContain('usable 1');
    expect(notes).toContain('=1/10');
  });

  it('the kernel predicate classifies all five shapes explicitly', () => {
    const verdicts = drillInputs().map(
      (entry) => ({ label: entry.label, ok: isLearningEligibleExperience(entry.record) })
    );
    expect(verdicts).toEqual([
      { label: 'r2-jsonl', ok: false },
      { label: 'r3-current', ok: true },
      { label: 'missing-version', ok: false },
      { label: 'future-r4', ok: false },
      { label: 'surrogate-history', ok: false }
    ]);
  });
});

// ---------------------------------------------------------------------------
// Hydrate / restart consistency: old JSONL + drive swap + backfill
// ---------------------------------------------------------------------------

describe('hydrate: load an old JSONL log, swap the drive, backfill again', () => {
  function fakeFs(seed: readonly string[]): {
    readonly fs: {
      appendDurable(filePath: string, contents: string): Promise<void>;
      readText(filePath: string): Promise<string | undefined>;
      replaceAtomic(filePath: string, contents: string): Promise<void>;
    };
    readonly lines: () => readonly string[];
  } {
    const lines = [...seed];
    return {
      fs: {
        async appendDurable(_filePath: string, contents: string): Promise<void> {
          lines.push(contents);
        },
        async readText(_filePath: string): Promise<string | undefined> {
          return lines.join('');
        },
        async replaceAtomic(_filePath: string, contents: string): Promise<void> {
          lines.length = 0;
          lines.push(contents);
        }
      },
      lines: () => [...lines]
    };
  }

  it('old unmigrated lines are not silently mixed in after the drive swap', async () => {
    // An old log: two r2 JSONL lines + one unversioned line + one r3 line.
    const oldLog = [
      elig({ id: 'old-r2-a', value: 3, rewardVersion: 'r2/verifiable-v1' }),
      elig({ id: 'old-r2-b', value: 2.5, rewardVersion: 'r2/verifiable-v1' }),
      elig({ id: 'old-bare', value: 9 }),
      elig({ id: 'old-r3', value: -1, rewardVersion: CURRENT_REWARD_VERSION })
    ]
      .map((record) => JSON.stringify(record))
      .map((line) => line + '\n');
    const { fs, lines } = fakeFs(oldLog);

    const kernel = createJitRl({ config: e2eBaseConfig(), jitrl: OPTIMIZER_CONFIG, now: () => NOW });
    await kernel.hydrate({ filePath: 'elig-log.jsonl', fs, pool: [makeTree()] });

    // The learning neighbours after the drive swap + surrogate backfill: the
    // strict query keeps ONLY the r3 line - the two r2 lines, the unversioned
    // line and the freshly backfilled surrogate records are all excluded.
    const queried = await kernel.store.query({
      ...STRICT_QUERY(),
      state: parityState()
    });
    expect(queried.map((entry) => entry.record.id).sort()).toEqual(['old-r3']);

    // The durable log still carries EVERY historical line plus the surrogate
    // backfill records (audit untouched, nothing was rewritten in place), so
    // the exclusion above is filtering, not deletion.
    const durableText = lines().join('');
    expect(durableText).toContain('"old-r2-a"');
    expect(durableText).toContain('"old-bare"');
    expect(durableText).toContain(BACKFILL_RECORD_PREFIX);
    // Every durable surrogate line is quarantined: parsed through the single
    // predicate, none of them may train.
    const surrogateLines: ExperienceRecord[] = [];
    for (const line of durableText.split('\n')) {
      if (line.trim().length === 0) {
        continue;
      }
      const record = JSON.parse(line) as ExperienceRecord;
      if (isSurrogatePriorRecord(record)) {
        surrogateLines.push(record);
      }
    }
    expect(surrogateLines.length).toBeGreaterThan(0);
    for (const record of surrogateLines) {
      expect(isLearningEligibleExperience(record)).toBe(false);
    }
  });

  it('restart: reloading the same log reproduces the same neighbour set', async () => {
    const oldLog = [
      elig({ id: 'p-r2', value: 3, rewardVersion: 'r2/verifiable-v1' }),
      elig({ id: 'p-r3', value: -1, rewardVersion: CURRENT_REWARD_VERSION })
    ]
      .map((record) => JSON.stringify(record) + '\n');
    const { fs, lines } = fakeFs(oldLog);

    const first = createJitRl({ config: e2eBaseConfig(), jitrl: OPTIMIZER_CONFIG, now: () => NOW });
    await first.hydrate({ filePath: 'restart-log.jsonl', fs, pool: [makeTree()] });
    const neighboursFirst = (await first.store.query(STRICT_QUERY()))
      .map((entry) => entry.record.id)
      .sort();

    // "Restart": a second kernel loads whatever the first process left on disk.
    const second = createJitRl({ config: e2eBaseConfig(), jitrl: OPTIMIZER_CONFIG, now: () => NOW });
    await second.hydrate({ filePath: 'restart-log.jsonl', fs, pool: [makeTree()] });
    const neighboursSecond = (await second.store.query(STRICT_QUERY()))
      .map((entry) => entry.record.id)
      .sort();

    expect(neighboursFirst).toEqual(neighboursSecond);
    expect(neighboursFirst).toEqual(['p-r3']);
    // The durable log still carries every historical line (audit untouched).
    expect(lines().length).toBeGreaterThan(oldLog.length);
  });
});

/**
 * MUTATION COMPANION (executed while preparing this PR; steps and observed
 * results recorded in the delivery notes, no resident script added).
 *
 *   M-a  delete the rewardVersion check from the unified predicate
 *        (src/jitrl/reward-contract.ts isLearningEligibleRecord): the F1
 *        L1/replay tests above turn RED (neighborCount 2, V = +1) and the M3
 *        note becomes 'usable 3' - the store.query test alone would still be
 *        green because the store delegates to the same broken predicate, which
 *        is exactly why all four entry classes are asserted here.
 *   M-b  revert backfill's surrogate quarantine (learningEligible: true on
 *        backfill records, or add r3/backfill-tree-v1 to the certified table):
 *        the F2 probe test turns RED (queried.length > 0).
 *   M-c  drop ...learningFacingFilterOptions() from any production call site
 *        (jit-active-policy.ts / index.ts replay / index.ts optimizer /
 *        host-advisor.ts): the corresponding entry-class test above turns RED.
 */
