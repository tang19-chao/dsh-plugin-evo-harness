/**
 * t28 acceptance: the learning-facing filter is wired at the PRODUCTION call
 * points, not just available in the kernel.
 *
 * Review finding (t14): `excludeLegacy` / `learningEligibleOnly` existed on
 * `ExperienceFilterOptions` but no production caller passed them, so on the live
 * path:
 *
 *   - legacy records (written under the superseded reward/provenance model) were
 *     still eligible as online decision neighbours, i.e. §6.5 was not enforced;
 *   - and, more quietly, the M3 fresh-policy count was inflated by legacy and
 *     learning-ineligible samples, so `saturated = fresh >= k` became true early
 *     and the drift penalty switched itself off on exactly the buckets holding
 *     the most polluted history.
 *
 * Every assertion below goes through a real entry point
 * (`createJitActivePolicy().selectBatch()` and `createJitReplayHook()`), never
 * through `filterExperienceSnapshot()` directly: a test that calls the predicate
 * itself would pass even with the call sites unwired, which is the defect class
 * this file exists to prevent.
 *
 * The mutation companion is documented at the bottom: deleting the two flags at
 * any of the three call sites turns these tests red.
 */
import { describe, expect, it } from 'vitest';
import type {
  AbstractState,
  BatchSlotKind,
  DiscoveryNode,
  DiscoveryTreeSnapshot,
  ExperienceQuery,
  ExperienceRecord,
  JitReplayHookInput,
  ScoredExperience,
  SearchGridPlan,
  SelectBatchRequest
} from '../../../src/types/contracts';
import { BATCH_SLOT_KINDS } from '../../../src/types/contracts';
import { createActivePolicy } from '../../../src/dream-rsi/active-policy';
import { DEFAULT_EVO_HARNESS_CONFIG } from '../../../src/config';
import type { JitRlConfig } from '../../../src/config';
import { EXPERIENCE_SCHEMA_VERSION } from '../../../src/jitrl/experience-store';
import {
  LEARNING_CONSUMER_FILTER,
  learningFacingFilterOptions
} from '../../../src/jitrl/decision-kernel';
import {
  buildMetaState,
  createJitActivePolicy,
  readJitDiagnostics
} from '../../../src/jitrl/jit-active-policy';
import { createJitReplayHook, createStoreOptimizer } from '../../../src/jitrl/index';
import { policyPriorLogit } from '../../../src/jitrl/logit-sources';
import { normalizeMetaAction } from '../../../src/jitrl/action-normalizer';

const T0 = 1_700_000_000_000;
const NOW = T0 + 60_000;
const HALF_LIFE = 60_000;
const NO_EXPLORE = (): number => 0.999;

function makeNode(
  overrides: Partial<DiscoveryNode> & Pick<DiscoveryNode, 'id'>
): DiscoveryNode {
  return {
    treeId: 'tree-filter',
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
    id: 'tree-filter',
    sessionId: 'session-filter',
    taskId: 'task-filter',
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
    rationale: 'filter grid',
    policyId: 'pi-0'
  };
}

function makeRequest(): SelectBatchRequest {
  return {
    task: {
      id: 'task-filter',
      prompt: 'Fix the failing build without breaking the release train.',
      taskSignature: 'fix-build',
      complexity: 'moderate',
      contextTags: ['ci']
    },
    sessionId: 'session-filter',
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

/** An L2 proposal-level state, so the optimizer's level guard is satisfied. */
function proposalState(): AbstractState {
  return {
    level: 'proposal',
    bucket: parityState().bucket + '|exploit|memory',
    tokens: [...parityState().tokens, 'slot:exploit', 'guidance:memory'],
    summary: 'proposal state'
  };
}

interface RecordOptions {
  readonly id: string;
  readonly slotKind: BatchSlotKind;
  readonly value: number;
  readonly policyId?: string;
  readonly createdAt?: number;
  /** Omit the schema version so the record is LEGACY (pre-PR4). */
  readonly legacy?: boolean;
  /** Mark the record as audit-only (cancelled / infrastructure outcome). */
  readonly ineligible?: boolean;
}

/**
 * One L1 record matching the canonical request's state.
 *
 * `legacy` and `ineligible` are the two exclusion classes:
 *   legacy     -> no experienceSchemaVersion at all (§6.5 stale model)
 *   ineligible -> learningEligible: false (§6.2 cancellation / infra failure)
 */
function record(options: RecordOptions): ExperienceRecord {
  const state = parityState();
  return {
    id: options.id,
    level: 'meta',
    state,
    actionKey: normalizeMetaAction(options.slotKind, []),
    reward: options.value,
    return: options.value,
    rewardSources: { surrogate: options.value },
    guidance: 'memory',
    policyId: options.policyId ?? 'pi-0',
    sessionId: 'session-filter',
    treeId: 'tree-filter',
    nodeId: options.id,
    ...(options.legacy === true
      ? {}
      : { experienceSchemaVersion: EXPERIENCE_SCHEMA_VERSION }),
    ...(options.ineligible === true ? { learningEligible: false } : {}),
    createdAt: options.createdAt ?? T0 - 60_000,
    redacted: true
  };
}

/**
 * The mixed batch from the review: 4 records in total, of which
 *   1 is legacy, 1 is learning-ineligible, 2 are clean.
 *
 * Strict accounting: kept = 2. Production-before-repair accounting: kept = 4.
 * The two clean records deliberately favour opposite slots so a wrong
 * neighbourhood is visible in Q/V as well as in the counts.
 */
function mixedHistory(): readonly ExperienceRecord[] {
  return [
    record({ id: 'clean-invariant', slotKind: 'explore_invariant', value: 2.5 }),
    record({ id: 'clean-exploit', slotKind: 'exploit', value: -2 }),
    record({ id: 'stale-legacy', slotKind: 'explore_invariant', value: 9, legacy: true }),
    record({ id: 'cancelled', slotKind: 'exploit', value: 9, ineligible: true })
  ];
}

const STRICT_KEPT = 2;

/** Replay hook input over the same mixed batch. */
function hookInput(
  experiences: readonly ExperienceRecord[],
  overrides: Partial<JitReplayHookInput> = {}
): JitReplayHookInput {
  const policy = createActivePolicy({
    policy: {
      id: 'pi-0',
      version: 3,
      parentPolicyId: undefined,
      createdAt: T0,
      maxWidth: 4,
      maxDepth: 2,
      slotWeights: { exploit: 0.4, explore_domain: 0.3, explore_invariant: 0.2, recover: 0.1 },
      earlyStopThreshold: 0.8,
      minMemoryConfidenceForSkip: 0.75
    } as never,
    now: () => T0,
    maxRecoverySlots: 1
  }).policy;
  return {
    treeId: 'tree-filter',
    policyId: 'pi-0',
    rho: 0.5,
    slotWeights: policy.slotWeights,
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

// ---------------------------------------------------------------------------
// 1. Online production call point
// ---------------------------------------------------------------------------

describe('online decision neighbourhood excludes legacy and ineligible records', () => {
  it('keeps only the clean records and reports the strict counts', () => {
    const jit = createJitActivePolicy({
      inner: createActivePolicy({
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
      }),
      experiences: mixedHistory(),
      config: { useSurfaces: false },
      now: () => NOW,
      rng: NO_EXPLORE
    });
    const plan = jit.selectBatch(makeRequest());
    const diagnostics = readJitDiagnostics(plan);
    expect(diagnostics).toBeDefined();

    // The filter trace proves the flags were actually in force, and the kept
    // count is the strict one - 4 would mean the legacy/ineligible pair leaked.
    expect(diagnostics?.filter?.records).toBe(4);
    expect(diagnostics?.filter?.kept).toBe(STRICT_KEPT);
    expect(diagnostics?.filter?.excludeLegacy).toBe(true);
    expect(diagnostics?.filter?.learningEligibleOnly).toBe(true);
    // The neighbourhood the decision actually used is the strict one.
    expect(diagnostics?.neighborCount).toBe(STRICT_KEPT);
  });

  it('does not let a legacy or cancelled high-return record set Q', () => {
    // Both excluded records carry return 9 - an absurd value that would dominate
    // the weighted mean if it ever reached the estimator.
    const jit = createJitActivePolicy({
      inner: createActivePolicy({
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
      }),
      experiences: mixedHistory(),
      config: { useSurfaces: false },
      now: () => NOW,
      rng: NO_EXPLORE
    });
    const diagnostics = readJitDiagnostics(jit.selectBatch(makeRequest()));
    // V is the mean of the two clean records (+2.5 and -2) = 0.25, not the mean
    // of four records dominated by 9s.
    expect(diagnostics?.stateValue).toBeCloseTo((2.5 + -2) / 2, 6);
    expect(diagnostics?.stateValue).toBeLessThan(1);
    for (const adjustment of diagnostics?.adjustments ?? []) {
      if (adjustment.q === null) {
        continue;
      }
      // No action may be estimated from an excluded record alone.
      expect(adjustment.q).toBeLessThan(9);
    }
  });

  it('is the behaviour the learning-facing defaults declare', () => {
    // The opt-in is not incidental: the kernel publishes the strict filter and
    // the call sites spread it. This pins the constant the wiring depends on.
    expect(LEARNING_CONSUMER_FILTER).toEqual({
      excludeLegacy: true,
      learningEligibleOnly: true
    });
    const strict = learningFacingFilterOptions();
    expect(strict.excludeLegacy).toBe(true);
    expect(strict.learningEligibleOnly).toBe(true);
    // Overridable for the audit path, which legitimately reads everything.
    const audit = learningFacingFilterOptions({
      excludeLegacy: false,
      learningEligibleOnly: false
    });
    expect(audit.excludeLegacy).toBe(false);
    expect(audit.learningEligibleOnly).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Replay production call point
// ---------------------------------------------------------------------------

describe('replay neighbourhood and M3 counts use the strict filter', () => {
  it('reports the strict neighbour count on the mixed batch', () => {
    const hook = createJitReplayHook({
      config: DEFAULT_EVO_HARNESS_CONFIG.jitrl,
      stateOf: () => parityState(),
      now: () => NOW,
      seed: 7
    });
    const replayed = hook(hookInput(mixedHistory()));
    // 2 clean neighbours, not 4: replay and online now see one evidence set.
    expect(replayed.diagnostics.neighborCount).toBe(STRICT_KEPT);
    expect(replayed.diagnostics.stateValue).toBeCloseTo((2.5 + -2) / 2, 6);
    const notes = (replayed.diagnostics.notes ?? []).join(' ');
    // The hook explains the exclusion instead of silently shrinking the window.
    expect(notes).toContain('filtered 2 of 4');
  });

  it('counts M3 usable/fresh against the strict denominator', () => {
    const hook = createJitReplayHook({
      config: DEFAULT_EVO_HARNESS_CONFIG.jitrl,
      stateOf: () => parityState(),
      now: () => NOW,
      seed: 7
    });
    // Two of the four records belong to the current policy ('pi-0'), one of
    // which is legacy. Strict: usable 2, fresh 1. Permissive (the defect):
    // usable 4, fresh 3 - exactly the review's 4/3 vs 2/1.
    const replayed = hook(
      hookInput([
        record({ id: 'fresh', slotKind: 'explore_invariant', value: 2.5 }),
        record({ id: 'stale-policy', slotKind: 'exploit', value: -2, policyId: 'pi-old' }),
        record({ id: 'legacy', slotKind: 'explore_invariant', value: 9, legacy: true }),
        record({ id: 'cancelled', slotKind: 'exploit', value: 9, ineligible: true })
      ])
    );
    const notes = (replayed.diagnostics.notes ?? []).join(' ');
    expect(notes).toContain('usable 2');
    expect(notes).toContain('=1/');
  });

  it('does not saturate M3 early because of polluted history', () => {
    // The review's quieter consequence: k = 2 with one clean fresh record plus
    // two polluted "fresh" ones. Permissive counting gives fresh = 3 >= k, so
    // saturation fires and the drift penalty silently stops on the most
    // polluted bucket. Strict counting gives fresh = 1 < k: the penalty stays on.
    const hook = createJitReplayHook({
      config: DEFAULT_EVO_HARNESS_CONFIG.jitrl,
      stateOf: () => parityState(),
      now: () => NOW,
      seed: 7
    });
    const polluted = [
      record({ id: 'clean-fresh', slotKind: 'explore_invariant', value: 2 }),
      record({ id: 'legacy-fresh', slotKind: 'explore_invariant', value: 2, legacy: true }),
      record({ id: 'cancelled-fresh', slotKind: 'explore_invariant', value: 2, ineligible: true }),
      // A superseded-policy record, so drift has something to down-weight.
      record({ id: 'stale', slotKind: 'exploit', value: -2, policyId: 'pi-old' })
    ];
    const replayed = hook(
      hookInput(polluted, {
        jit: {
          beta: 1,
          lambda: 0,
          alpha: 0,
          // k = 2: permissive fresh = 3 saturates, strict fresh = 1 does not.
          k: 2,
          gamma: 0.5,
          similarityThreshold: 0.3
        }
      })
    );
    const notes = (replayed.diagnostics.notes ?? []).join(' ');
    expect(notes).toContain('=1/2');
    // The penalty is still in force, so the note must NOT claim it went inactive.
    expect(notes).not.toContain('drift penalty inactive');
    // And the drift down-weight actually happened on the stale record.
    expect(notes).toContain('down-weighted');
  });

  it('saturates only when the strict count really reaches k', () => {
    const hook = createJitReplayHook({
      config: DEFAULT_EVO_HARNESS_CONFIG.jitrl,
      stateOf: () => parityState(),
      now: () => NOW,
      seed: 7
    });
    // Two clean fresh records with k = 2: strict saturation is legitimate here.
    const clean = [
      record({ id: 'f1', slotKind: 'explore_invariant', value: 2 }),
      record({ id: 'f2', slotKind: 'explore_invariant', value: 2 })
    ];
    const replayed = hook(
      hookInput(clean, {
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
    expect(notes).toContain('=2/2');
    expect(notes).toContain('drift penalty inactive');
  });
});

// ---------------------------------------------------------------------------
// 3. L2 proposal-selection call point (createStoreOptimizer)
// ---------------------------------------------------------------------------

describe('L2 proposal selection queries with the strict filter', () => {
  /**
   * `createStoreOptimizer` takes the mutable `JitRlConfig` while the frozen
   * defaults are deeply readonly, so the mutable fields are copied explicitly.
   * The optimizer only reads k / similarityThreshold / beta / selection /
   * lambda / alpha / unseenFallback, none of which live in `dream`.
   */
  const defaults = DEFAULT_EVO_HARNESS_CONFIG.jitrl;
  const optimizerConfig: JitRlConfig = {
    ...defaults,
    levels: [...defaults.levels],
    dream: {
      ...defaults.dream,
      candidateJitBetas: [...defaults.dream.candidateJitBetas],
      candidateJitLambdas: [...defaults.dream.candidateJitLambdas]
    }
  };

  /** Minimal in-memory store that records the query it was asked for. */
  function recordingStore() {
    const queries: ExperienceQuery[] = [];
    return {
      queries,
      store: {
        async query(query: ExperienceQuery): Promise<readonly ScoredExperience[]> {
          queries.push(query);
          return [];
        }
      }
    };
  }

  it('asks the store for non-legacy, learning-eligible records only', async () => {
    const { queries, store } = recordingStore();
    const optimizer = createStoreOptimizer({
      store,
      config: optimizerConfig,
      halfLifeMs: HALF_LIFE,
      now: () => NOW,
      rng: () => 0.999
    });
    await optimizer.decide('proposal', proposalState(), [
      {
        actionKey: 'patch:a',
        baseLogit: 0,
        source: 'policy_prior',
        payload: undefined
      }
    ]);
    expect(queries).toHaveLength(1);
    // The L2 selector is a learning consumer: it picks which proposal to execute,
    // so the evidence it reads must be the strict set.
    expect(queries[0]?.excludeLegacy).toBe(true);
    expect(queries[0]?.learningEligibleOnly).toBe(true);
  });

  it('keeps the caller guidance filter alongside the learning filter', async () => {
    const { queries, store } = recordingStore();
    const optimizer = createStoreOptimizer({
      store,
      config: optimizerConfig,
      halfLifeMs: HALF_LIFE,
      now: () => NOW,
      rng: () => 0.999
    });
    await optimizer.decide(
      'proposal',
      proposalState(),
      [{ actionKey: 'patch:a', baseLogit: 0, source: 'policy_prior', payload: undefined }],
      { guidanceFilter: 'guidance_free' }
    );
    // Invariant isolation and the learning filter are independent axes: both
    // must reach the store, or the strict set alone would lose the isolation.
    expect(queries[0]?.guidanceFilter).toBe('guidance_free');
    expect(queries[0]?.excludeLegacy).toBe(true);
    expect(queries[0]?.learningEligibleOnly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Parity of the exclusion between the two paths
// ---------------------------------------------------------------------------

describe('online and replay exclude the same evidence', () => {
  it('agree on the strict neighbour count for the same snapshot', () => {
    const hook = createJitReplayHook({
      config: DEFAULT_EVO_HARNESS_CONFIG.jitrl,
      stateOf: () => parityState(),
      now: () => NOW,
      seed: 7,
      priorLogitOf: (kind, weights) => policyPriorLogit(weights, kind)
    });
    const replayed = hook(hookInput(mixedHistory()));

    const jit = createJitActivePolicy({
      inner: createActivePolicy({
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
      }),
      experiences: mixedHistory(),
      config: { useSurfaces: false },
      now: () => NOW,
      rng: NO_EXPLORE
    });
    const online = readJitDiagnostics(jit.selectBatch(makeRequest()));

    // Same snapshot, same exclusions, same neighbourhood size and same V.
    expect(online?.neighborCount).toBe(replayed.diagnostics.neighborCount);
    expect(online?.stateValue).toBeCloseTo(replayed.diagnostics.stateValue, 6);
    expect(online?.filter?.kept).toBe(replayed.diagnostics.neighborCount);
  });

  it('still reaches every slot kind after the exclusion', () => {
    const hook = createJitReplayHook({
      config: DEFAULT_EVO_HARNESS_CONFIG.jitrl,
      stateOf: () => parityState(),
      now: () => NOW,
      seed: 7
    });
    const replayed = hook(hookInput(mixedHistory()));
    // Filtering must not collapse the action space: all four slots are still
    // decided on, they simply have support from the clean records only.
    expect(replayed.diagnostics.adjustments.map((entry) => entry.slot)).toEqual([
      ...BATCH_SLOT_KINDS
    ]);
    const invariant = replayed.diagnostics.adjustments.find(
      (entry) => entry.slot === 'explore_invariant'
    );
    const exploit = replayed.diagnostics.adjustments.find(
      (entry) => entry.slot === 'exploit'
    );
    // Each supported slot keeps its own clean support; no record is double-counted.
    expect(invariant?.support).toBe(1);
    expect(exploit?.support).toBe(1);
  });
});

/**
 * MUTATION COMPANION (executed while preparing this task, results below).
 *
 * Removing the two flags from any production call site turns these tests red:
 *
 *   M-a  jit-active-policy.ts: drop `...learningFacingFilterOptions()` from
 *        runDecisionKernel -> online kept becomes 4 and neighborCount 4, so
 *        'keeps only the clean records' and the Q/V assertions fail.
 *   M-b  index.ts replay kernel: drop the same spread -> neighborCount 4 and
 *        the 'filtered 2 of 4' note disappears.
 *   M-c  index.ts freshPolicySupport: drop the spread -> 'usable 4' instead of
 *        'usable 2', and the k = 2 case saturates ('drift penalty inactive'
 *        appears), failing the early-saturation test.
 *
 * Each mutation was applied to the working tree, the failure observed, and the
 * file restored byte-for-byte.
 */
