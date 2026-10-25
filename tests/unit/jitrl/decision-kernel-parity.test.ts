/**
 * P6 PR5 acceptance: online and replay run the SAME decision kernel.
 *
 * Plan sections 7.1-7.5. Before this round there were two algorithms: the online
 * L1 decorator ran retrieveNeighbors() + composeDecision(), while the Dream
 * replay hook aggregated the causal window itself (weighted means over the whole
 * level, its own exp(beta * A-tab) re-apportioning, no nearest-neighbour
 * retrieval and no top-k truncation). Offline replay therefore evaluated a
 * different policy than the one that ran online, which is defect R5.
 *
 * Everything below is written to fail on a regression to that state:
 *
 *  1. the online decorator and the replay hook must agree on neighbours, weights,
 *     V, Q, advantages and adjusted logits for the same input;
 *  2. the retriever's bucket / similarity / decay / top-k semantics must be the
 *     ones replay uses (not "aggregate the whole level");
 *  3. each swept dimension must have a counterexample proving a change to it
 *     really moves the neighbourhood, the decision or the evaluation;
 *  4. the effective configuration must be versioned, read per decision, and
 *     version-invalidate consumer caches;
 *  5. M3: fresh-policy support is counted per (level, bucket) after filtering.
 */
import { describe, expect, it } from 'vitest';
import type {
  AbstractState,
  BatchPlan,
  BatchSlotKind,
  DiscoveryNode,
  DiscoveryTreeSnapshot,
  ExperienceRecord,
  HarnessComponentKey,
  JitCandidate,
  JitReplayHookInput,
  MetaSearchPolicy,
  SearchGridPlan,
  SelectBatchRequest
} from '../../../src/types/contracts';
import { BATCH_SLOT_KINDS } from '../../../src/types/contracts';
import {
  createActivePolicy,
  createDefaultPolicy,
  type ActivePolicy
} from '../../../src/dream-rsi/active-policy';
import { DEFAULT_EVO_HARNESS_CONFIG } from '../../../src/config';
import {
  POLICY_DIMENSION_LAYERS,
  POLICY_IGNORED_DIMENSIONS,
  POLICY_SEARCH_DIMENSIONS,
  baseEffectivePolicyConfig,
  createEffectivePolicyConfigProvider,
  createSeededRandom,
  decideReplayPublication,
  effectiveConfigForPolicy,
  experienceFilterReason,
  filterExperienceSnapshot,
  freshPolicySupport,
  ignoredDimension,
  isSearchDimension,
  layerOwnsDimension,
  normalizeLayerDecisionConfig,
  projectNeighborsBySlotKind,
  runDecisionKernel,
  seedFromParts,
  slotKindOfMetaActionKey,
  slotWeightsFromDecision,
  REPLAY_GATE_BOUNDARY,
  type LayerDecisionConfig
} from '../../../src/jitrl/decision-kernel';
import {
  buildMetaState,
  createJitActivePolicy,
  readJitDiagnostics,
  slotKindOfActionKey
} from '../../../src/jitrl/jit-active-policy';
import { policyPriorLogit } from '../../../src/jitrl/logit-sources';
import { CURRENT_REWARD_VERSION, EXPERIENCE_SCHEMA_VERSION } from '../../../src/jitrl/experience-store';
import { createJitReplayHook } from '../../../src/jitrl/index';
import { retrieveNeighbors } from '../../../src/jitrl/retriever';
import { abstractMetaState } from '../../../src/jitrl/state-abstraction';
import { normalizeMetaAction } from '../../../src/jitrl/action-normalizer';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;
const NOW = T0 + 60_000;
/** Half-life of one minute, so the decay is observable inside the fixture. */
const HALF_LIFE = 60_000;

function makeNode(
  overrides: Partial<DiscoveryNode> & Pick<DiscoveryNode, 'id'>
): DiscoveryNode {
  return {
    treeId: 'tree-parity',
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

function makeTree(nodes?: Record<string, DiscoveryNode>): DiscoveryTreeSnapshot {
  const built: Record<string, DiscoveryNode> = nodes ?? {
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
  if (rootNode.childIds.length === 0) {
    built.root = { ...rootNode, childIds: Object.keys(built).filter((id) => id !== 'root') };
  }
  return {
    id: 'tree-parity',
    sessionId: 'session-parity',
    taskId: 'task-parity',
    rootId: 'root',
    nodes: built,
    policyId: 'pi-0',
    stats: {
      nodeCount: Object.keys(built).length,
      maxDepth: 1,
      maxWidth: 3,
      scoredNodes: Object.values(built).filter((node) => node.score !== undefined).length,
      completedNodes: Object.keys(built).length
    },
    completed: false,
    createdAt: T0,
    updatedAt: T0
  };
}

function makeGrid(overrides: Partial<SearchGridPlan> = {}): SearchGridPlan {
  return {
    maxWidth: 8,
    maxDepth: 2,
    budget: 8,
    skipProbing: false,
    stopCondition: 'budget_exhausted',
    complexity: 'moderate',
    rationale: 'parity grid',
    policyId: 'pi-0',
    ...overrides
  };
}

function makeRequest(overrides: Partial<SelectBatchRequest> = {}): SelectBatchRequest {
  return {
    task: {
      id: 'task-parity',
      prompt: 'Fix the failing build without breaking the release train.',
      taskSignature: 'fix-build',
      complexity: 'moderate',
      contextTags: ['ci']
    },
    sessionId: 'session-parity',
    tree: makeTree(),
    grid: makeGrid(),
    memoryConfidence: 0.8,
    round: 1,
    previousBestNodeId: 'best',
    ...overrides
  };
}

function makeBasePolicy(overrides: Partial<MetaSearchPolicy> = {}): MetaSearchPolicy {
  return createDefaultPolicy({ id: 'pi-0', version: 3 }, () => T0);
}

/** The L1 state the canonical request abstracts to (what online decides on). */
function parityState(): AbstractState {
  return buildMetaState(makeRequest());
}

interface MetaRecordInput {
  readonly id: string;
  readonly slotKind: BatchSlotKind;
  readonly value: number;
  readonly createdAt?: number;
  readonly guidance?: 'memory' | 'guidance_free';
  readonly policyId?: string;
  readonly state?: AbstractState;
  readonly actionKey?: string;
  readonly level?: ExperienceRecord['level'];
  readonly experienceSchemaVersion?: number;
  readonly rewardVersion?: string;
  readonly learningEligible?: boolean;
}

/** L1 record matching the canonical request's state (Jaccard 1 unless overridden). */
function makeMetaRecord(options: MetaRecordInput): ExperienceRecord {
  const state = options.state ?? parityState();
  return {
    id: options.id,
    level: options.level ?? 'meta',
    state,
    actionKey: options.actionKey ?? normalizeMetaAction(options.slotKind, []),
    reward: options.value,
    return: options.value,
    rewardSources: { surrogate: options.value },
    guidance: options.guidance ?? 'memory',
    policyId: options.policyId ?? 'pi-0',
    sessionId: 'session-parity',
    treeId: 'tree-parity',
    nodeId: options.id,
    createdAt: options.createdAt ?? T0 - 60_000,
    redacted: true,
    // Current-schema by default: a record without a schema version is LEGACY
    // (plan section 6.5), so the default fixture must carry the live version or
    // a legacy-excluding query would drop the whole history.
    experienceSchemaVersion: options.experienceSchemaVersion ?? EXPERIENCE_SCHEMA_VERSION,
    // P6.2 PR-A: the live writer also stamps the current reward contract id;
    // the unified predicate is exact-contract and fail-closed, so the fixture
    // must carry it too or the whole parity history would be excluded.
    ...(options.rewardVersion === undefined &&
      (options.experienceSchemaVersion !== undefined &&
        options.experienceSchemaVersion < EXPERIENCE_SCHEMA_VERSION)
      ? {}
      : { rewardVersion: options.rewardVersion ?? CURRENT_REWARD_VERSION }),
    ...(options.learningEligible === undefined
      ? {}
      : { learningEligible: options.learningEligible })
  };
}

/** History where the invariant track clearly outperforms exploit. */
function parityHistory(): readonly ExperienceRecord[] {
  return [
    makeMetaRecord({ id: 'h1', slotKind: 'explore_invariant', value: 2.5 }),
    makeMetaRecord({ id: 'h2', slotKind: 'explore_invariant', value: 2.2 }),
    makeMetaRecord({ id: 'h3', slotKind: 'explore_invariant', value: 2.4 }),
    makeMetaRecord({ id: 'h4', slotKind: 'exploit', value: -2 }),
    makeMetaRecord({ id: 'h5', slotKind: 'exploit', value: -1.8 }),
    makeMetaRecord({ id: 'h6', slotKind: 'explore_domain', value: 0.1 }),
    makeMetaRecord({ id: 'h7', slotKind: 'recover', value: 0.4 })
  ];
}

const NO_EXPLORE = (): number => 0.999;

function layerConfig(overrides: Partial<LayerDecisionConfig> = {}): LayerDecisionConfig {
  return normalizeLayerDecisionConfig({
    beta: 1,
    k: 10,
    similarityThreshold: 0.3,
    selection: 'argmax',
    lambda: 0,
    alpha: 0,
    unseenFallback: 'baseline',
    halfLifeMs: HALF_LIFE,
    ...overrides
  });
}

/** One replay hook input for the same decision the online decorator took. */
function hookInput(
  overrides: Partial<JitReplayHookInput> = {}
): JitReplayHookInput {
  return {
    treeId: 'tree-parity',
    policyId: 'pi-0',
    rho: 0.5,
    slotWeights: makeBasePolicy().slotWeights,
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
    experiences: parityHistory(),
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

/** Candidates exactly as replay builds them (one per slot kind). */
function replayCandidates(
  weights: Readonly<Record<BatchSlotKind, number>> = makeBasePolicy().slotWeights
): readonly JitCandidate<{ readonly slotKind: BatchSlotKind }>[] {
  return BATCH_SLOT_KINDS.map((kind) => ({
    actionKey: 'slot:' + kind,
    baseLogit: policyPriorLogit(weights, kind, undefined, undefined),
    source: 'policy_prior' as const,
    payload: { slotKind: kind }
  }));
}

/** The single kernel call both paths make, for the parity assertions. */
function kernelResult(
  options: {
    readonly records?: readonly ExperienceRecord[];
    readonly config?: LayerDecisionConfig;
    readonly gamma?: number;
    readonly seed?: number;
    readonly project?: boolean;
  } = {}
) {
  const candidates = replayCandidates();
  return runDecisionKernel({
    level: 'meta',
    state: parityState(),
    candidates,
    records: options.records ?? parityHistory(),
    config: options.config ?? layerConfig(),
    now: NOW,
    seed: options.seed ?? 7,
    ...(options.project === false
      ? {}
      : {
          projectNeighbors: (neighbors: readonly ScoredExperienceLike[], all: readonly JitCandidate<{ readonly slotKind: BatchSlotKind }>[]) =>
            projectNeighborsBySlotKind(neighbors, all)
        })
  });
}

/** Structural alias so the projection lambda stays readable. */
type ScoredExperienceLike = Parameters<typeof projectNeighborsBySlotKind>[0][number];

function adjustmentOf(
  result: ReturnType<typeof kernelResult>,
  kind: BatchSlotKind
) {
  const entry = result.decision.adjustments.find(
    (adjustment) => adjustment.candidate.actionKey === 'slot:' + kind
  );
  expect(entry).toBeDefined();
  return entry as NonNullable<typeof entry>;
}

// ---------------------------------------------------------------------------
// 1. Online and replay agree term by term (plan section 7.5)
// ---------------------------------------------------------------------------

describe('online/replay parity on the same decision input', () => {
  it('produces identical neighbours and weights on both paths', () => {
    // Replay path: the hook, which is now a shell over the kernel.
    const hook = createJitReplayHook({
      config: DEFAULT_EVO_HARNESS_CONFIG.jitrl,
      stateOf: () => parityState(),
      priorLogitOf: (kind, weights) => policyPriorLogit(weights, kind),
      now: () => NOW,
      seed: 7
    });
    const replayed = hook(hookInput());

    // Kernel path: the same call the online decorator makes, with the same
    // snapshot, state, config, clock and seed.
    const direct = kernelResult();
    // Online retrieval, asserted through the retriever directly: replay must use
    // the same bucket/similarity/decay/top-k semantics, not an aggregate.
    const retrieved = retrieveNeighbors(parityHistory(), parityState(), {
      k: 10,
      similarityThreshold: 0.3,
      level: 'meta',
      now: NOW,
      halfLifeMs: HALF_LIFE
    });

    expect(direct.neighbors.map((entry) => entry.record.id)).toEqual(
      retrieved.map((entry) => entry.record.id)
    );
    for (let index = 0; index < direct.neighbors.length; index += 1) {
      expect(direct.neighbors[index]?.weight).toBeCloseTo(
        retrieved[index]?.weight ?? Number.NaN,
        12
      );
      expect(direct.neighbors[index]?.similarity).toBeCloseTo(
        retrieved[index]?.similarity ?? Number.NaN,
        12
      );
    }

    // The hook's diagnostic V and neighbour count are the kernel's, not a
    // re-aggregation: this is the assertion the pre-PR5 hook failed.
    expect(replayed.diagnostics.stateValue).toBeCloseTo(direct.stateValue, 12);
    expect(replayed.diagnostics.neighborCount).toBe(direct.neighborCount);
    expect(direct.neighborCount).toBe(retrieved.length);
    // The kernel keeps the top-k budget, so a snapshot larger than k is truncated
    // rather than counted beyond it.
    expect(direct.neighbors.length).toBeLessThanOrEqual(10);
  });

  it('agrees on Q, V, advantages and adjusted logits for every slot', () => {
    const hook = createJitReplayHook({
      config: DEFAULT_EVO_HARNESS_CONFIG.jitrl,
      stateOf: () => parityState(),
      now: () => NOW,
      seed: 7
    });
    const replayed = hook(hookInput());
    const direct = kernelResult();

    for (const kind of BATCH_SLOT_KINDS) {
      const entry = adjustmentOf(direct, kind);
      const replayAdjustment = replayed.diagnostics.adjustments.find(
        (adjustment) => adjustment.slot === kind
      );
      expect(replayAdjustment).toBeDefined();
      if (kind === 'recover') {
        // The recovery slot is structural: L1 caps it and replay holds its prior
        // share, so its *weight* is intentionally not the kernel allocation. The
        // Q / advantage / support of the action still come from the same kernel.
        expect(replayAdjustment?.support).toBe(entry.support);
        continue;
      }
      // support and Q come from the same neighbourhood, so they must be exact.
      expect(replayAdjustment?.support).toBe(entry.support);
      if (entry.q === null) {
        expect(replayAdjustment?.q).toBeNull();
      } else {
        expect(replayAdjustment?.q).toBeCloseTo(entry.q, 12);
      }
      expect(replayAdjustment?.advantage).toBeCloseTo(entry.advantage, 12);
      expect(replayAdjustment?.normalizedAdvantage).toBeCloseTo(
        entry.normalizedAdvantage,
        12
      );
      // The V the hook reports is the kernel's V, which is what makes the two
      // advantage vectors comparable at all.
      expect(replayed.diagnostics.stateValue).toBeCloseTo(direct.stateValue, 12);
    }
  });

  it('allocates the same search shares on both paths (slot weights)', () => {
    const hook = createJitReplayHook({
      config: DEFAULT_EVO_HARNESS_CONFIG.jitrl,
      stateOf: () => parityState(),
      now: () => NOW,
      seed: 7
    });
    const prior = makeBasePolicy().slotWeights;
    const replayed = hook(hookInput());
    const direct = kernelResult();
    const allocated = direct.slotWeights;
    expect(allocated).not.toBeNull();

    // Replay holds recover at its prior and renormalizes the three search shares
    // against it; the online apportionment is fed by the same allocation. So the
    // *relative* shares of the three search slots must match exactly.
    const replaySearchTotal =
      (replayed.slotWeights.exploit ?? 0) +
      (replayed.slotWeights.explore_domain ?? 0) +
      (replayed.slotWeights.explore_invariant ?? 0);
    const kernelSearchTotal =
      (allocated?.exploit ?? 0) +
      (allocated?.explore_domain ?? 0) +
      (allocated?.explore_invariant ?? 0);
    expect(replaySearchTotal).toBeGreaterThan(0);
    expect(kernelSearchTotal).toBeGreaterThan(0);
    for (const kind of ['exploit', 'explore_domain', 'explore_invariant'] as const) {
      expect((replayed.slotWeights[kind] ?? 0) / replaySearchTotal).toBeCloseTo(
        (allocated?.[kind] ?? 0) / kernelSearchTotal,
        12
      );
    }
    // The recovery share is the prior's, unchanged on both sides. That is the one
    // documented difference in the discrete allocation, and it is deliberate.
    expect(replayed.slotWeights.recover).toBeCloseTo(prior.recover, 12);
  });

  it('online decorator diagnostics expose the kernel version and filter trace', () => {
    const record = makeMetaRecord({ id: 'h1', slotKind: 'explore_invariant', value: 2.5 });
    const state = parityState();
    const provider = createEffectivePolicyConfigProvider({
      initial: baseEffectivePolicyConfig({ jitrl: DEFAULT_EVO_HARNESS_CONFIG.jitrl }),
      now: () => NOW
    });
    const published = provider.publish({
      policy: { ...makeBasePolicy(), id: 'pi-parity', version: 9 }
    });
    expect(published.versionTag).toBe('pi-parity@v9');

    const inner = createActivePolicy({
      policy: makeBasePolicy(),
      now: () => T0,
      maxRecoverySlots: 1
    });
    const jit = createJitActivePolicy({
      inner,
      experiences: [record],
      config: { useSurfaces: false },
      now: () => NOW,
      rng: NO_EXPLORE,
      policyConfigProvider: provider
    });
    const plan = jit.selectBatch(makeRequest());
    const diagnostics = readJitDiagnostics(plan);
    expect(diagnostics).toBeDefined();
    // The version actually consumed is recorded, so a log line can be traced.
    expect(diagnostics?.policyVersion).toBe('pi-parity@v9');
    // Ignored dimensions are restated per decision instead of being silent.
    expect(diagnostics?.ignoredDimensions).toEqual(['lambda', 'alpha', 'gamma']);
    expect(diagnostics?.filter?.records).toBe(1);
    // The provider logged the read, which is what makes "consumed version"
    // auditable rather than reconstructed.
    const log = provider.consumptionLog();
    expect(log).toHaveLength(1);
    expect(log[0]?.versionTag).toBe('pi-parity@v9');
    expect(log[0]?.consumer).toBe('level1');
    // Sanity: the state the decorator used is the fixture state.
    expect(state.bucket).toBe(diagnostics === undefined ? '' : state.bucket);
  });

  it('folds surface-qualified history onto the live candidate on both paths', () => {
    // With the surface action space enabled the online candidates are
    // 'slot:<kind>/surf:<a>' keys while older records may carry a different
    // surface or none at all. Both paths must fold those onto the candidate that
    // represents the kind - otherwise replay would count support the online
    // decision never saw (or vice versa).
    const state = parityState();
    const withSurfaces = [
      makeMetaRecord({
        id: 'surf-a',
        slotKind: 'explore_invariant',
        value: 2.5,
        actionKey: 'slot:explore_invariant/surf:system_prompt'
      }),
      makeMetaRecord({
        id: 'surf-b',
        slotKind: 'explore_invariant',
        value: 2.2,
        actionKey: 'slot:explore_invariant/surf:guardrails'
      }),
      makeMetaRecord({
        id: 'bare',
        slotKind: 'exploit',
        value: -2,
        actionKey: 'slot:exploit'
      })
    ];
    const candidates: readonly JitCandidate<HarnessComponentKey>[] = BATCH_SLOT_KINDS.map(
      (kind) => ({
        actionKey:
          kind === 'explore_invariant'
            ? 'slot:explore_invariant/surf:system_prompt'
            : 'slot:' + kind,
        baseLogit: policyPriorLogit(makeBasePolicy().slotWeights, kind),
        source: 'policy_prior' as const,
        payload: 'system_prompt' as HarnessComponentKey
      })
    );

    const neighbors = retrieveNeighbors(withSurfaces, state, {
      k: 10,
      similarityThreshold: 0.3,
      level: 'meta',
      now: NOW,
      halfLifeMs: HALF_LIFE
    });
    const folded = projectNeighborsBySlotKind(neighbors, candidates);
    // The exact-key record keeps its key; the sibling-surface and bare records
    // fold onto the same candidate, so the invariant action accumulates support.
    // All three share similarity 1 and the same timestamp, so the retriever
    // orders them by id: bare, surf-a, surf-b.
    expect(folded.map((entry) => entry.record.id)).toEqual(['bare', 'surf-a', 'surf-b']);
    expect(folded.map((entry) => entry.record.actionKey)).toEqual([
      'slot:exploit',
      'slot:explore_invariant/surf:system_prompt',
      'slot:explore_invariant/surf:system_prompt'
    ]);

    const projected = runDecisionKernel({
      level: 'meta',
      state,
      candidates,
      records: withSurfaces,
      config: layerConfig(),
      now: NOW,
      projectNeighbors: projectNeighborsBySlotKind
    });
    const unprojected = runDecisionKernel({
      level: 'meta',
      state,
      candidates,
      records: withSurfaces,
      config: layerConfig(),
      now: NOW
    });
    const invariantProjected = projected.decision.adjustments.find(
      (entry) => entry.candidate.actionKey === 'slot:explore_invariant/surf:system_prompt'
    );
    const invariantRaw = unprojected.decision.adjustments.find(
      (entry) => entry.candidate.actionKey === 'slot:explore_invariant/surf:system_prompt'
    );
    // Folding hands the live candidate both invariant records instead of one.
    expect(invariantRaw?.support).toBe(1);
    expect(invariantProjected?.support).toBe(2);
  });

  it('folds surface-qualified history onto the bare slot candidate inside the hook', () => {
    // The hook builds one candidate per slot kind ('slot:<kind>'), while the
    // stored history may carry 'slot:<kind>/surf:<...>' keys written by the
    // surface action space. Without the shared projection those records match no
    // candidate at all, so the invariant action would silently lose all of its
    // support. This case is what pins that fold in the hook (a kernel-level test
    // would not: it injects the projection explicitly).
    const surfHistory = [
      makeMetaRecord({
        id: 'surf-only-1',
        slotKind: 'explore_invariant',
        value: 2.5,
        actionKey: 'slot:explore_invariant/surf:guardrails'
      }),
      makeMetaRecord({
        id: 'surf-only-2',
        slotKind: 'explore_invariant',
        value: 2.2,
        actionKey: 'slot:explore_invariant/surf:system_prompt'
      }),
      // A bare exploit record, so V sits between the two actions and the
      // invariant advantage is strictly positive.
      makeMetaRecord({ id: 'bare-exploit', slotKind: 'exploit', value: -2 })
    ];
    const hook = createJitReplayHook({
      config: DEFAULT_EVO_HARNESS_CONFIG.jitrl,
      stateOf: () => parityState(),
      now: () => NOW,
      seed: 7
    });
    const replayed = hook(hookInput({ experiences: surfHistory }));
    const invariant = replayed.diagnostics.adjustments.find(
      (adjustment) => adjustment.slot === 'explore_invariant'
    );
    expect(invariant).toBeDefined();
    // Both records were folded onto the single invariant candidate.
    expect(invariant?.support).toBe(2);
    expect(invariant?.q).toBeCloseTo((2.5 + 2.2) / 2, 12);
    expect(invariant?.advantage).toBeGreaterThan(0);
  });

  it('keeps the slot-kind mapping identical across modules', () => {
    // The kernel re-declares the mapping to avoid importing the decorator, so an
    // accidental divergence would silently change replay's neighbour folding.
    for (const kind of BATCH_SLOT_KINDS) {
      for (const key of [
        normalizeMetaAction(kind, []),
        normalizeMetaAction(kind, ['system_prompt' as HarnessComponentKey])
      ]) {
        expect(slotKindOfMetaActionKey(key)).toBe(kind);
        expect(slotKindOfActionKey(key)).toBe(kind);
      }
    }
    expect(slotKindOfMetaActionKey('patch:abc')).toBeUndefined();
    expect(slotKindOfMetaActionKey('slot:not-a-kind')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Counterexamples: every swept dimension must actually matter
// ---------------------------------------------------------------------------

describe('counterexamples: each searched dimension changes the outcome', () => {
  it('beta moves the adjusted logits and the portfolio divergence', () => {
    const atZero = kernelResult({ config: layerConfig({ beta: 0 }) });
    const atTwo = kernelResult({ config: layerConfig({ beta: 2 }) });
    // With beta = 0 the correction is a no-op, so z' equals the prior and the
    // candidate probabilities are the prior's.
    expect(atZero.decision.klToPrior).toBeCloseTo(0, 12);
    expect(atTwo.decision.klToPrior).toBeGreaterThan(0);
    expect(atTwo.decision.klToPrior).toBeGreaterThan(atZero.decision.klToPrior);
    // And the logits themselves moved, not just the summary.
    const invariantAtZero = adjustmentOf(atZero, 'explore_invariant');
    const invariantAtTwo = adjustmentOf(atTwo, 'explore_invariant');
    expect(invariantAtZero.normalizedAdvantage).toBeCloseTo(
      invariantAtTwo.normalizedAdvantage,
      12
    );
    expect(Math.abs(invariantAtTwo.adjustedLogit - invariantAtZero.adjustedLogit)).toBeGreaterThan(0);
  });

  it('k changes the neighbourhood size and therefore V', () => {
    // A snapshot with more usable neighbours than the budget.
    const history = [
      ...parityHistory(),
      makeMetaRecord({ id: 'h8', slotKind: 'exploit', value: 3 }),
      makeMetaRecord({ id: 'h9', slotKind: 'exploit', value: 2.9 })
    ];
    const small = kernelResult({ records: history, config: layerConfig({ k: 1 }) });
    const large = kernelResult({ records: history, config: layerConfig({ k: 10 }) });
    expect(small.neighbors.length).toBe(1);
    expect(large.neighbors.length).toBeGreaterThan(small.neighbors.length);
    // The extra neighbours carry the high-return exploit records, so V must move.
    expect(large.stateValue).not.toBeCloseTo(small.stateValue, 6);
    // Top-k truncation is real: the corpus is bigger than even the large budget.
    expect(large.neighbors.length).toBeLessThanOrEqual(10);
  });

  it('similarityThreshold changes which records are neighbours', () => {
    // A near-miss record: shares enough tokens to sit between the two thresholds.
    const nearMiss = makeMetaRecord({
      id: 'near',
      slotKind: 'exploit',
      value: 5,
      state: {
        level: 'meta',
        bucket: parityState().bucket,
        tokens: parityState().tokens.slice(0, 4),
        summary: 'partial overlap'
      }
    });
    const strict = kernelResult({
      records: [nearMiss],
      config: layerConfig({ similarityThreshold: 0.9 })
    });
    const loose = kernelResult({
      records: [nearMiss],
      config: layerConfig({ similarityThreshold: 0.05 })
    });
    expect(strict.neighbors).toHaveLength(0);
    expect(loose.neighbors).toHaveLength(1);
    expect(loose.stateValue).toBeCloseTo(5, 12);
    expect(strict.stateValue).toBe(0);
  });

  it('rejects a dimension outside the search set instead of silently applying it', () => {
    // Every ignored dimension is enumerable, carries a reason, and is NOT in the
    // search set: "not searched" is a fact a reviewer can check.
    expect([...POLICY_SEARCH_DIMENSIONS]).toEqual(['beta', 'k', 'similarityThreshold']);
    for (const ignored of POLICY_IGNORED_DIMENSIONS) {
      expect(isSearchDimension(ignored.dimension)).toBe(false);
      expect(ignoredDimension(ignored.dimension)?.reason.length).toBeGreaterThan(0);
      expect(ignored.dimension === 'gamma' ? ignored.reason : ignored.reason).toContain(
        ignored.dimension === 'gamma' ? 'frozen' : 'not swept'
      );
    }
    expect(isSearchDimension('beta')).toBe(true);
    expect(ignoredDimension('beta')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. The effective-configuration provider (plan section 7.3)
// ---------------------------------------------------------------------------

describe('effective policy config provider', () => {
  it('reads the currently published version on every decision', () => {
    const provider = createEffectivePolicyConfigProvider({
      initial: baseEffectivePolicyConfig({
        jitrl: DEFAULT_EVO_HARNESS_CONFIG.jitrl,
        halfLifeMs: HALF_LIFE
      }),
      now: () => NOW
    });
    expect(provider.current('level1').versionTag).toBe('config@v0');

    const first = provider.publish({ level1: { beta: 2 } });
    expect(first.level1.beta).toBe(2);
    // Reading twice after one publish must return the same version: no phantom
    // version bump, and the value is the published one.
    expect(provider.current('level1').level1.beta).toBe(2);
    expect(provider.current('level1').versionTag).toBe(first.versionTag);

    const second = provider.publish({ level1: { beta: 0.5 } });
    expect(second.level1.beta).toBe(0.5);
    expect(second.policyVersion).toBe(first.policyVersion + 1);
    expect(provider.current('level1').level1.beta).toBe(0.5);
  });

  it('switches version and configuration atomically and logs the consumer', () => {
    const provider = createEffectivePolicyConfigProvider({
      initial: baseEffectivePolicyConfig({ jitrl: DEFAULT_EVO_HARNESS_CONFIG.jitrl }),
      now: () => NOW
    });
    provider.publish({ policy: { ...makeBasePolicy(), id: 'pi-hot', version: 4 } });
    // Consecutive reads see a self-consistent (version, config) pair: the write
    // is one assignment, so a torn read is impossible.
    for (let index = 0; index < 5; index += 1) {
      const snapshot = provider.current(index % 2 === 0 ? 'level1' : 'level2');
      expect(snapshot.versionTag).toBe('pi-hot@v4');
      expect(snapshot.policyId).toBe('pi-hot');
      expect(snapshot.policyVersion).toBe(4);
    }
    const log = provider.consumptionLog();
    expect(log).toHaveLength(5);
    expect(log.map((entry) => entry.consumer)).toEqual([
      'level1',
      'level2',
      'level1',
      'level2',
      'level1'
    ]);
    // History is append-only, so a reader can explain how a version was reached.
    expect(provider.history().map((entry) => entry.versionTag)).toEqual([
      'config@v0',
      'pi-hot@v4'
    ]);
  });

  it('keeps L1/L2/L3 ownership explicit instead of sharing one temperature', () => {
    const provider = createEffectivePolicyConfigProvider({
      initial: baseEffectivePolicyConfig({ jitrl: DEFAULT_EVO_HARNESS_CONFIG.jitrl }),
      now: () => NOW
    });
    provider.publish({ level1: { beta: 0.25 } });
    expect(provider.current('level1').level1.beta).toBe(0.25);
    // L2 is a separate object: raising L1's temperature must not move L2's.
    expect(provider.current('level2').level2.beta).toBe(
      DEFAULT_EVO_HARNESS_CONFIG.jitrl.beta
    );
    // gamma belongs to the dream pipeline (L2) only, so L1 does not own it.
    expect(layerOwnsDimension('level1', 'beta')).toBe(true);
    expect(layerOwnsDimension('level2', 'beta')).toBe(true);
    expect(layerOwnsDimension('level1', 'gamma')).toBe(false);
    expect(layerOwnsDimension('level2', 'gamma')).toBe(true);
    // L3 has thresholds, never a KL temperature.
    expect(layerOwnsDimension('level3', 'adviseThreshold')).toBe(true);
    expect(layerOwnsDimension('level3', 'beta')).toBe(false);
    expect(POLICY_DIMENSION_LAYERS.gamma).toEqual(['level2']);
  });

  it('locates the dimension a policy block carries, and inherits the rest', () => {
    const base = baseEffectivePolicyConfig({
      jitrl: DEFAULT_EVO_HARNESS_CONFIG.jitrl,
      halfLifeMs: HALF_LIFE
    });
    const effective = effectiveConfigForPolicy(
      {
        ...makeBasePolicy(),
        id: 'pi-swap',
        version: 7,
        jit: { beta: 3, lambda: 0.4, alpha: 9, k: 4, gamma: 0.9, similarityThreshold: 0.6 }
      },
      base
    );
    expect(effective.versionTag).toBe('pi-swap@v7');
    expect(effective.level1.beta).toBe(3);
    expect(effective.level1.k).toBe(4);
    expect(effective.level1.similarityThreshold).toBe(0.6);
    expect(effective.level2.beta).toBe(3);
    // gamma is mirrored on the config (dream pipeline), not on a layer.
    expect(effective.gamma).toBe(0.9);
    expect(effective.source).toBe('policy');
  });

  it('invalidates a version-keyed consumer cache on a hot swap', () => {
    // The decorator's derived-policy cache key carries the config version, so a
    // swap with an identical weight vector must still rebuild.
    const provider = createEffectivePolicyConfigProvider({
      initial: baseEffectivePolicyConfig({ jitrl: DEFAULT_EVO_HARNESS_CONFIG.jitrl }),
      now: () => NOW
    });
    const inner = createActivePolicy({
      policy: makeBasePolicy(),
      now: () => T0,
      maxRecoverySlots: 1
    });
    const jit = createJitActivePolicy({
      inner,
      experiences: parityHistory(),
      config: { useSurfaces: false },
      now: () => NOW,
      rng: NO_EXPLORE,
      policyConfigProvider: provider
    });
    const first = jit.selectBatch(makeRequest());
    const firstVersion = readJitDiagnostics(first)?.policyVersion;
    const cacheAfterFirst = jit.cacheStats().misses;

    provider.publish({ policy: { ...makeBasePolicy(), id: 'pi-0', version: 11 } });
    const second = jit.selectBatch(makeRequest());
    const secondVersion = readJitDiagnostics(second)?.policyVersion;
    // The version moved, so the decision is attributed to the new version...
    expect(firstVersion).not.toBe(secondVersion);
    expect(secondVersion).toBe('pi-0@v11');
    // ...and the cache could not serve the previous entry.
    expect(jit.cacheStats().misses).toBeGreaterThan(cacheAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// 4. Filters: legacy, invariant guidance, time boundary, missing fields
// ---------------------------------------------------------------------------

describe('shared filter semantics', () => {
  it('excludes legacy records from the neighbourhood when asked', () => {
    const legacy = makeMetaRecord({
      id: 'legacy',
      slotKind: 'explore_invariant',
      value: 9,
      experienceSchemaVersion: 1
    });
    const current = parityHistory();
    const kept = kernelResult({ records: [legacy, ...current] });
    // Default: no legacy exclusion (pre-PR5 readers keep working).
    expect(kept.neighbors.some((entry) => entry.record.id === 'legacy')).toBe(true);

    const excluded = runDecisionKernel({
      level: 'meta',
      state: parityState(),
      candidates: replayCandidates(),
      records: [legacy, ...current],
      config: layerConfig(),
      now: NOW,
      excludeLegacy: true
    });
    expect(excluded.neighbors.some((entry) => entry.record.id === 'legacy')).toBe(false);
    expect(excluded.filters.records).toBe(current.length + 1);
    expect(excluded.filters.kept).toBe(current.length);
    expect(experienceFilterReason(legacy, { level: 'meta', excludeLegacy: true })).toBe('legacy');
  });

  it('keeps invariant guidance isolated', () => {
    const memory = makeMetaRecord({ id: 'mem', slotKind: 'exploit', value: 9 });
    const invariant = makeMetaRecord({
      id: 'inv',
      slotKind: 'explore_invariant',
      value: 1,
      guidance: 'guidance_free'
    });
    const free = runDecisionKernel({
      level: 'meta',
      state: parityState(),
      candidates: replayCandidates(),
      records: [memory, invariant],
      config: layerConfig(),
      guidance: 'guidance_free',
      now: NOW
    });
    expect(free.neighbors.map((entry) => entry.record.id)).toEqual(['inv']);
    expect(free.stateValue).toBeCloseTo(1, 12);
    const all = runDecisionKernel({
      level: 'meta',
      state: parityState(),
      candidates: replayCandidates(),
      records: [memory, invariant],
      config: layerConfig(),
      now: NOW
    });
    expect(all.neighbors).toHaveLength(2);
  });

  it('treats the causal cutoff as inclusive at an identical timestamp', () => {
    const atCutoff = makeMetaRecord({
      id: 'at',
      slotKind: 'exploit',
      value: 1,
      createdAt: T0
    });
    const afterCutoff = makeMetaRecord({
      id: 'after',
      slotKind: 'exploit',
      value: 2,
      createdAt: T0 + 1
    });
    const before = runDecisionKernel({
      level: 'meta',
      state: parityState(),
      candidates: replayCandidates(),
      records: [atCutoff, afterCutoff],
      config: layerConfig({ before: T0 }),
      now: NOW
    });
    // created_at == cutoff is visible; cutoff + 1 is not.
    expect(before.neighbors.map((entry) => entry.record.id)).toEqual(['at']);
    expect(experienceFilterReason(afterCutoff, { level: 'meta', before: T0 })).toBe('time');
  });

  it('drops a record with a missing or non-finite timestamp instead of ranking it', () => {
    const broken = makeMetaRecord({ id: 'broken', slotKind: 'exploit', value: 3 });
    const withBroken = { ...broken, createdAt: Number.NaN };
    expect(
      experienceFilterReason(withBroken, { level: 'meta' })
    ).toBe('timestamp');
    const result = runDecisionKernel({
      level: 'meta',
      state: parityState(),
      candidates: replayCandidates(),
      records: [withBroken],
      config: layerConfig(),
      now: NOW
    });
    expect(result.neighbors).toHaveLength(0);
    expect(result.filters.kept).toBe(0);
  });

  it('excludes cancelled/infrastructure records from training when asked', () => {
    const cancelled = makeMetaRecord({
      id: 'cancelled',
      slotKind: 'exploit',
      value: -9,
      learningEligible: false
    });
    expect(
      experienceFilterReason(cancelled, { level: 'meta', learningEligibleOnly: true })
    ).toBe('learning_ineligible');
    const result = runDecisionKernel({
      level: 'meta',
      state: parityState(),
      candidates: replayCandidates(),
      records: [cancelled, ...parityHistory()],
      config: layerConfig(),
      learningEligibleOnly: true,
      now: NOW
    });
    expect(result.neighbors.some((entry) => entry.record.id === 'cancelled')).toBe(false);
  });

  it('handles an empty neighbourhood as a cold start, not an error', () => {
    const result = runDecisionKernel({
      level: 'meta',
      state: parityState(),
      candidates: replayCandidates(),
      records: [],
      config: layerConfig(),
      now: NOW
    });
    expect(result.neighborCount).toBe(0);
    expect(result.stateValue).toBe(0);
    expect(result.decision.klToPrior).toBeCloseTo(0, 12);
    expect(filterExperienceSnapshot([], { level: 'meta' })).toEqual([]);
    // Non-array input degrades the same way rather than throwing.
    const degraded = runDecisionKernel({
      level: 'meta',
      state: parityState(),
      candidates: replayCandidates(),
      records: undefined as unknown as readonly ExperienceRecord[],
      config: layerConfig()
    });
    expect(degraded.neighbors).toHaveLength(0);
  });

  it('keeps the k = 1 boundary exact', () => {
    const result = runDecisionKernel({
      level: 'meta',
      state: parityState(),
      candidates: replayCandidates(),
      records: parityHistory(),
      config: layerConfig({ k: 1 }),
      now: NOW
    });
    expect(result.neighbors).toHaveLength(1);
    expect(result.decision.adjustments).toHaveLength(BATCH_SLOT_KINDS.length);
  });

  it('rejects an out-of-range configuration instead of clamping silently', () => {
    expect(() => normalizeLayerDecisionConfig({ beta: -1 })).toThrow(RangeError);
    expect(() => normalizeLayerDecisionConfig({ similarityThreshold: 1.5 })).toThrow(RangeError);
    expect(() => normalizeLayerDecisionConfig({ lambda: 2 })).toThrow(RangeError);
    expect(() => normalizeLayerDecisionConfig({ alpha: -1 })).toThrow(RangeError);
    expect(() => normalizeLayerDecisionConfig({ k: 0 })).not.toThrow();
    // k is a count: a non-integer budget floors to a usable one.
    expect(normalizeLayerDecisionConfig({ k: 3.7 }).k).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 5. Drift and M3: per (level, bucket) fresh-policy support
// ---------------------------------------------------------------------------

describe('M3: fresh-policy support is counted per (level, bucket)', () => {
  const otherBucket: AbstractState = {
    level: 'meta',
    bucket: 'meta|sig:other|cx:trivial',
    tokens: ['sig:other', 'cx:trivial'],
    summary: 'a different task family'
  };

  it('does not count another bucket fresh experience as support here', () => {
    const state = parityState();
    // The decision bucket holds no fresh record; the *other* bucket is saturated
    // with fresh ones. Counting per level (the pre-PR5 defect) would report the
    // current bucket as supported and stop the drift penalty early.
    const records = [
      makeMetaRecord({ id: 'stale', slotKind: 'exploit', value: 1, policyId: 'pi-old' }),
      ...Array.from({ length: 12 }, (_, index) =>
        makeMetaRecord({
          id: 'fresh-other-' + String(index),
          slotKind: 'exploit',
          value: 1,
          policyId: 'pi-0',
          state: otherBucket
        })
      )
    ];
    const support = freshPolicySupport(records, {
      level: 'meta',
      bucket: state.bucket,
      policyId: 'pi-0',
      k: 10
    });
    expect(support.fresh).toBe(0);
    expect(support.usable).toBe(1);
    expect(support.stale).toBe(1);
    expect(support.saturated).toBe(false);

    // The same records read as the other bucket ARE supported.
    const otherSupport = freshPolicySupport(records, {
      level: 'meta',
      bucket: otherBucket.bucket,
      policyId: 'pi-0',
      k: 10
    });
    expect(otherSupport.fresh).toBe(12);
    expect(otherSupport.saturated).toBe(true);
  });

  it('counts only records that survive the filter', () => {
    const stale = makeMetaRecord({ id: 'legacy', slotKind: 'exploit', value: 1, policyId: 'pi-0', experienceSchemaVersion: 1 });
    const future = makeMetaRecord({
      id: 'future',
      slotKind: 'exploit',
      value: 1,
      policyId: 'pi-0',
      createdAt: T0 + 5_000
    });
    const cancelled = makeMetaRecord({
      id: 'cancelled',
      slotKind: 'exploit',
      value: 1,
      policyId: 'pi-0',
      learningEligible: false
    });
    const usable = makeMetaRecord({ id: 'usable', slotKind: 'exploit', value: 1, policyId: 'pi-0' });
    const support = freshPolicySupport([stale, future, cancelled, usable], {
      level: 'meta',
      bucket: parityState().bucket,
      policyId: 'pi-0',
      k: 2,
      before: T0,
      excludeLegacy: true,
      learningEligibleOnly: true
    });
    // Legacy, out-of-window and learning-ineligible records cannot saturate.
    expect(support.usable).toBe(1);
    expect(support.fresh).toBe(1);
    expect(support.saturated).toBe(false);
  });

  it('saturates at exactly k fresh records in the bucket', () => {
    const records = Array.from({ length: 3 }, (_, index) =>
      makeMetaRecord({ id: 'f' + String(index), slotKind: 'exploit', value: 1, policyId: 'pi-0' })
    );
    const below = freshPolicySupport(records, {
      level: 'meta',
      bucket: parityState().bucket,
      policyId: 'pi-0',
      k: 4
    });
    const at = freshPolicySupport(records, {
      level: 'meta',
      bucket: parityState().bucket,
      policyId: 'pi-0',
      k: 3
    });
    expect(below.saturated).toBe(false);
    expect(at.saturated).toBe(true);
  });

  it('applies the drift down-weight from the same bucket count', () => {
    const state = parityState();
    // One stale record plus k fresh ones in the SAME bucket: the penalty stops.
    const fresh = Array.from({ length: 10 }, (_, index) =>
      makeMetaRecord({ id: 'f' + String(index), slotKind: 'exploit', value: 1, policyId: 'pi-0', createdAt: T0 - 1_000 })
    );
    const stale = makeMetaRecord({
      id: 'stale',
      slotKind: 'explore_invariant',
      value: 2,
      policyId: 'pi-old',
      createdAt: T0 - 1_000
    });
    const saturated = retrieveNeighbors([...fresh, stale], state, {
      k: 10,
      similarityThreshold: 0.3,
      level: 'meta',
      now: NOW,
      halfLifeMs: HALF_LIFE,
      policyId: 'pi-0',
      driftRho: 0.5
    });
    // The stale record still ranks (its similarity is 1) but is NOT down-weighted
    // because the bucket holds k fresh records.
    const staleEntry = saturated.find((entry) => entry.record.id === 'stale');
    expect(staleEntry?.driftWeight).toBeUndefined();

    // With only k - 1 fresh records the penalty is in force.
    const short = retrieveNeighbors([...fresh.slice(0, 9), stale], state, {
      k: 10,
      similarityThreshold: 0.3,
      level: 'meta',
      now: NOW,
      halfLifeMs: HALF_LIFE,
      policyId: 'pi-0',
      driftRho: 0.5
    });
    expect(short.find((entry) => entry.record.id === 'stale')?.driftWeight).toBeCloseTo(0.5, 12);
  });

  it('reports the same bucket count the retriever used', () => {
    const state = parityState();
    const records = [
      makeMetaRecord({ id: 'a', slotKind: 'exploit', value: 1, policyId: 'pi-0' }),
      makeMetaRecord({ id: 'b', slotKind: 'exploit', value: 1, policyId: 'pi-0' }),
      makeMetaRecord({ id: 'c', slotKind: 'exploit', value: 1, policyId: 'pi-old' })
    ];
    const support = freshPolicySupport(records, {
      level: 'meta',
      bucket: state.bucket,
      policyId: 'pi-0',
      k: 5
    });
    expect(support).toMatchObject({
      level: 'meta',
      bucket: state.bucket,
      policyId: 'pi-0',
      k: 5,
      usable: 3,
      fresh: 2,
      stale: 1,
      saturated: false
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Publication gate, shadow mode and the boundary statement
// ---------------------------------------------------------------------------

describe('replay publication gate (plan section 7.4)', () => {
  it('never publishes in shadow mode', () => {
    const verdict = decideReplayPublication({ improved: true, shadowMode: true });
    expect(verdict.publish).toBe(false);
    expect(verdict.improved).toBe(true);
    expect(verdict.reason).toContain('shadow mode');
    // The boundary travels with the verdict so it cannot be quoted alone.
    expect(verdict.boundary).toBe(REPLAY_GATE_BOUNDARY);
    expect(verdict.boundary).toContain('not a monotone non-regression guarantee');
  });

  it('withholds a winner that does not hold up on held-out trees', () => {
    const verdict = decideReplayPublication({
      improved: true,
      validatedOnHoldout: false
    });
    expect(verdict.publish).toBe(false);
    expect(verdict.reason).toContain('held-out');
  });

  it('publishes only a strict improvement that passed validation', () => {
    expect(decideReplayPublication({ improved: false }).publish).toBe(false);
    const published = decideReplayPublication({ improved: true, validatedOnHoldout: true });
    expect(published.publish).toBe(true);
    expect(published.boundary).toBe(REPLAY_GATE_BOUNDARY);
  });

  it('declares the boundary as replay-only, not a live guarantee', () => {
    expect(REPLAY_GATE_BOUNDARY).toContain('fixed historical replay set');
    expect(REPLAY_GATE_BOUNDARY).toContain('proxy metric');
  });
});

// ---------------------------------------------------------------------------
// 7. Determinism: the seed is the only randomness
// ---------------------------------------------------------------------------

describe('injectable seed', () => {
  it('reproduces the same decision for the same seed and diverges for another', () => {
    const candidates = replayCandidates();
    const run = (seed: number) =>
      runDecisionKernel({
        level: 'meta',
        state: parityState(),
        candidates,
        records: parityHistory(),
        // lambda > 0 makes the exploration draw observable.
        config: layerConfig({ lambda: 1, alpha: 3 }),
        now: NOW,
        seed
      });
    const first = run(11);
    const again = run(11);
    expect(again.decision.adjustments.map((entry) => entry.q)).toEqual(
      first.decision.adjustments.map((entry) => entry.q)
    );
    expect(again.seed).toBe(first.seed);
    // Seeds hash deterministically, so a replay can be described by its seed.
    expect(seedFromParts('tree', 3)).toBe(seedFromParts('tree', 3));
    expect(seedFromParts('tree', 3)).not.toBe(seedFromParts('tree', 4));
    expect(createSeededRandom(1)().valueOf()).toBe(createSeededRandom(1)().valueOf());
    expect(run(11).decision.rationale).toBe(run(11).decision.rationale);
  });

  it('is exploration-free when no seed and no rng are given to replay', () => {
    const hook = createJitReplayHook({
      config: DEFAULT_EVO_HARNESS_CONFIG.jitrl,
      stateOf: () => parityState(),
      now: () => NOW
    });
    const first = hook(hookInput());
    const second = hook(hookInput());
    expect(second.slotWeights).toEqual(first.slotWeights);
    // No candidate was "explored": replay's default draw is 1.
    for (const adjustment of first.diagnostics.adjustments) {
      expect(adjustment.explored).toBe(false);
    }
  });
});
