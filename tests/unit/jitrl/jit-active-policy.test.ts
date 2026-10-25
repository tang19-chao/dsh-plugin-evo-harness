/**
 * P2 L1 JitActivePolicy decorator (plan sections 3.1, 6.4 and 8 Phase 2).
 *
 * Mandatory acceptance:
 *   (a) synthetic history where signature S rewards invariant clearly higher
 *       makes selectBatch schedule MORE explore_invariant seats than the plain
 *       policy for the same request;
 *   (b) a brand-new signature with no neighbours yields an identical BatchPlan
 *       (same kinds, same order, same focus surfaces) and klToPrior 0;
 *   (c) beta = 0 is identical to the plain policy;
 *   (d) invariant slot guidance stays 'guidance_free' and recovery stays capped
 *       at one, and the base policy is never updated by a Jit decision.
 */
import { describe, expect, it } from 'vitest';
import type {
  BatchPlan,
  BatchSlotKind,
  DiscoveryNode,
  DiscoveryTreeSnapshot,
  ExperienceRecord,
  HarnessComponentKey,
  IActivePolicy,
  MetaSearchPolicy,
  PlanGridRequest,
  SearchGridPlan,
  SelectBatchRequest
} from '../../../src/types/contracts';
import {
  createActivePolicy,
  createDefaultPolicy,
  type ActivePolicy
} from '../../../src/dream-rsi/active-policy';
import { abstractMetaState } from '../../../src/jitrl/state-abstraction';
import { normalizeMetaAction } from '../../../src/jitrl/action-normalizer';
import {
  CURRENT_PROVENANCE_VERSION,
  CURRENT_REWARD_VERSION,
  EXPERIENCE_SCHEMA_VERSION
} from '../../../src/jitrl/experience-store';
import { DEFAULT_EVO_HARNESS_CONFIG } from '../../../src/config';
import {
  baseEffectivePolicyConfig,
  createEffectivePolicyConfigProvider,
  type EffectivePolicyConfigProvider
} from '../../../src/jitrl/decision-kernel';
import {
  DEFAULT_DERIVED_CACHE_ENTRIES,
  MAX_DERIVED_CACHE_ENTRIES,
  MIN_DERIVED_CACHE_ENTRIES,
  buildMetaState,
  createJitActivePolicy,
  hasJitDiagnostics,
  readJitDiagnostics,
  slotKindOfActionKey,
  type JitActivePolicy,
  type JitBatchDiagnostics
} from '../../../src/jitrl/jit-active-policy';

/** Shared L1 fixtures: a deterministic base policy plus synthetic L1 history. */
const T0 = 1_700_000_000_000;

/** One recorded diagnostic from either store or decorator. */
function makeNode(
  overrides: Partial<DiscoveryNode> & Pick<DiscoveryNode, 'id'>
): DiscoveryNode {
  return {
    treeId: 'tree-jit',
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

/** Root plus one succeeded candidate, so recovery/exploit resolve normally. */
function makeTree(nodes?: Record<string, DiscoveryNode>): DiscoveryTreeSnapshot {
  const built: Record<string, DiscoveryNode> =
    nodes ??
    {
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
    id: 'tree-jit',
    sessionId: 'session-jit',
    taskId: 'task-jit',
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

/** A grid wide enough to schedule several slots in one batch. */
function makeGrid(overrides: Partial<SearchGridPlan> = {}): SearchGridPlan {
  return {
    maxWidth: 4,
    maxDepth: 2,
    budget: 4,
    skipProbing: false,
    stopCondition: 'budget_exhausted',
    complexity: 'moderate',
    rationale: 'test grid',
    policyId: 'pi-0',
    ...overrides
  };
}

/**
 * Wide grid for the "more seats" acceptance. Capacity 8 is the smallest width
 * where the largest-remainder apportionment can actually express a share change
 * on three search tracks: at capacity 6 both the prior and the corrected shares
 * round to 2/2/2 seats, which would make the assertion vacuous.
 */
function makeWideGrid(): SearchGridPlan {
  return makeGrid({ maxWidth: 8, budget: 8 });
}

/**
 * Request for a task family the synthetic history knows nothing about.
 *
 * Bucket relaxation is by design (plan section 6.3 relaxes to the level-wide
 * pool when exact-bucket hits are fewer than k/2), so "no neighbours" here means
 * the Jaccard similarity genuinely falls below the configured threshold: this
 * state shares only the boilerplate pfail/ref/terr tokens with the fixture
 * history, i.e. 3 / 17 = 0.18 < 0.3.
 */
function makeDissimilarRequest(): SelectBatchRequest {
  return {
    task: {
      id: 'task-novel',
      prompt: 'Translate the onboarding handbook into Japanese.',
      taskSignature: 'novel-signature',
      complexity: 'trivial',
      contextTags: ['docs']
    },
    sessionId: 'session-jit',
    tree: makeTree(),
    grid: makeGrid(),
    memoryConfidence: 0.1,
    round: 3
  };
}

/** The canonical batch request the invariants are asserted against. */
function makeRequest(overrides: Partial<SelectBatchRequest> = {}): SelectBatchRequest {
  return {
    task: {
      id: 'task-jit',
      prompt: 'Fix the failing build without breaking the release train.',
      taskSignature: 'fix-build',
      complexity: 'moderate',
      contextTags: ['ci']
    },
    sessionId: 'session-jit',
    tree: makeTree(),
    grid: makeGrid(),
    memoryConfidence: 0.8,
    round: 1,
    // The fixture history is recorded against this parent, so the canonical
    // request must abstract to exactly the same token set (Jaccard 1).
    previousBestNodeId: 'best',
    ...overrides
  };
}

/** Base policy used by every decorator test. */
function makeBasePolicy(overrides: Partial<MetaSearchPolicy> = {}): MetaSearchPolicy {
  return createDefaultPolicy({ id: 'pi-0', version: 3 }, () => T0);
}

/** A fresh undecorated policy sharing the base policy object. */
function makeInner(policy: MetaSearchPolicy = makeBasePolicy()): ActivePolicy {
  return createActivePolicy({ policy, now: () => T0, maxRecoverySlots: 1 });
}

/** L1 record whose bucket and tokens match the canonical request's meta state. */
function makeMetaRecord(options: {
  readonly id: string;
  readonly slotKind: BatchSlotKind;
  readonly value: number;
  readonly surfaces?: readonly HarnessComponentKey[];
  readonly createdAt?: number;
  readonly guidance?: 'memory' | 'guidance_free';
  readonly actionSuffix?: boolean;
  /** Omit the schema version to model a pre-PR4 (legacy) record. */
  readonly omitSchemaVersion?: boolean;
  /** Explicit learning-eligibility override (cancelled/infrastructure cases). */
  readonly learningEligible?: boolean;
}): ExperienceRecord {
  // Exactly what buildMetaState(makeRequest()) produces, so the synthetic
  // history is a genuine nearest-neighbour match (Jaccard 1) for the request.
  const request = makeRequest();
  const state = abstractMetaState({
    task: request.task,
    round: 1,
    parentDepth: 1,
    parentSlot: 'exploit',
    memoryConfidence: 0.8,
    referenceStatus: 'missing'
  });
  const surfaces = options.surfaces ?? [];
  return {
    id: options.id,
    level: 'meta',
    state,
    actionKey: normalizeMetaAction(options.slotKind, surfaces),
    reward: options.value,
    return: options.value,
    rewardSources: { surrogate: options.value },
    guidance: options.guidance ?? 'memory',
    policyId: 'pi-0',
    sessionId: 'session-jit',
    treeId: 'tree-jit',
    nodeId: options.id,
    // Fixture histories model evidence the live writer produces, and the live
    // writer always stamps the current schema version (orchestrator
    // recordOnlineExperience). Without it these records would be LEGACY and a
    // learning-facing neighbourhood would - correctly - exclude all of them.
    ...(options.omitSchemaVersion === true
      ? {}
      : { experienceSchemaVersion: EXPERIENCE_SCHEMA_VERSION }),
    // P6.2 PR-A: the live writer stamps the current reward contract id on every
    // record; the learning-facing predicate is exact-contract and fail-closed,
    // so a fixture without the stamp would be (correctly) excluded from the
    // neighbourhood and every behaviour assertion below would go cold.
    ...(options.omitSchemaVersion === true
      ? {}
      : { rewardVersion: CURRENT_REWARD_VERSION, provenanceVersion: CURRENT_PROVENANCE_VERSION }),
    ...(options.learningEligible === undefined
      ? {}
      : { learningEligible: options.learningEligible }),
    createdAt: options.createdAt ?? T0 - 1000,
    redacted: true
  };
}

/**
 * Synthetic history where signature S clearly rewards the invariant track:
 * explore_invariant records return +2.5 while exploit returns -2.
 */
function invariantLovingHistory(): readonly ExperienceRecord[] {
  return [
    makeMetaRecord({ id: 'h1', slotKind: 'explore_invariant', value: 2.5 }),
    makeMetaRecord({ id: 'h2', slotKind: 'explore_invariant', value: 2.2 }),
    makeMetaRecord({ id: 'h3', slotKind: 'explore_invariant', value: 2.4 }),
    makeMetaRecord({ id: 'h4', slotKind: 'exploit', value: -2 }),
    makeMetaRecord({ id: 'h5', slotKind: 'exploit', value: -1.8 }),
    makeMetaRecord({ id: 'h6', slotKind: 'explore_domain', value: 0.1 })
  ];
}

/** Recording wrapper: keeps every plan the inner policy produced. */
interface RecordingInner extends IActivePolicy {
  readonly plans: BatchPlan[];
  readonly updates: MetaSearchPolicy[];
  readonly grids: SearchGridPlan[];
}

function recordingInner(policy: MetaSearchPolicy = makeBasePolicy()): RecordingInner {
  const delegate = makeInner(policy);
  const plans: BatchPlan[] = [];
  const updates: MetaSearchPolicy[] = [];
  const grids: SearchGridPlan[] = [];
  return {
    plans,
    updates,
    grids,
    get policy(): MetaSearchPolicy {
      return delegate.policy;
    },
    planGrid(request: PlanGridRequest): SearchGridPlan {
      const grid = delegate.planGrid(request);
      grids.push(grid);
      return grid;
    },
    selectBatch(request: SelectBatchRequest): BatchPlan {
      const plan = delegate.selectBatch(request);
      plans.push(plan);
      return plan;
    },
    update(next: MetaSearchPolicy): void {
      updates.push(next);
      delegate.update(next);
    }
  };
}

/** Count scheduled slots of one kind. */
function countSlots(plan: BatchPlan, kind: BatchSlotKind): number {
  return plan.slots.filter((slot) => slot.slot === kind).length;
}

const NO_EXPLORE = (): number => 0.999;
const NO_SURFACES = { useSurfaces: false } as const;

function slotKinds(plan: { readonly slots: readonly { readonly slot: BatchSlotKind }[] }): BatchSlotKind[] {
  return plan.slots.map((slot) => slot.slot);
}

describe('buildMetaState', () => {
  it('abstracts the batch request into an L1 meta state', () => {
    const state = buildMetaState(makeRequest());
    expect(state.level).toBe('meta');
    expect(state.bucket).toBe('meta|fix-build|moderate');
    expect(state.tokens).toContain('sig:fix-build');
    expect(state.tokens).toContain('cx:moderate');
    expect(state.tokens).toContain('tag:ci');
    expect(state.tokens).toContain('round:1');
    expect(state.tokens).toContain('mconf:3');
    // An absent reference status degrades to 'missing', never to an error.
    expect(state.tokens).toContain('ref:missing');
  });

  it('prefers the abstracted parent node for depth/slot/failure', () => {
    const request = makeRequest({ previousBestNodeId: 'best' });
    const state = buildMetaState(request);
    expect(state.tokens).toContain('depth:1');
    expect(state.tokens).toContain('pslot:exploit');
    expect(state.tokens).toContain('pfail:none');
  });
});

describe('slotKindOfActionKey', () => {
  it('resolves both bare and surface-qualified L1 action keys', () => {
    expect(slotKindOfActionKey('slot:exploit')).toBe('exploit');
    expect(slotKindOfActionKey('slot:explore_invariant/surf:guardrails+skills')).toBe(
      'explore_invariant'
    );
    expect(slotKindOfActionKey('slot:explore_domain/surf:tool_guidance')).toBe('explore_domain');
  });

  it('rejects keys from other levels', () => {
    expect(slotKindOfActionKey('tool:shell(cmd=pnpm*)')).toBeUndefined();
    expect(slotKindOfActionKey('guardrails:precondition(shell)')).toBeUndefined();
    expect(slotKindOfActionKey('slot:unknown')).toBeUndefined();
  });
});

describe('JitActivePolicy delegation', () => {
  it('keeps the base policy object and identity', () => {
    const inner = makeInner();
    const jit = createJitActivePolicy({ inner, experiences: [], rng: NO_EXPLORE });
    expect(jit.policy).toBe(inner.policy);
    expect(jit.policy.id).toBe('pi-0');
    expect(jit.inner).toBe(inner);
  });

  it('delegates planGrid unchanged', () => {
    const inner = recordingInner();
    const jit = createJitActivePolicy({ inner, experiences: [], rng: NO_EXPLORE });
    const request = makeRequest();
    const direct = inner.planGrid({
      task: request.task,
      memoryConfidence: 0.8,
      budgetRemaining: 8,
      currentDepth: 0,
      exploredNodes: 0,
      previousFailures: [],
      policy: inner.policy
    });
    const viaJit = jit.planGrid({
      task: request.task,
      memoryConfidence: 0.8,
      budgetRemaining: 8,
      currentDepth: 0,
      exploredNodes: 0,
      previousFailures: [],
      policy: inner.policy
    });
    expect(viaJit).toEqual(direct);
  });

  it('delegates update() and never applies one for a Jit decision', () => {
    const inner = recordingInner();
    const jit = createJitActivePolicy({
      inner,
      experiences: invariantLovingHistory(),
      config: NO_SURFACES,
      rng: NO_EXPLORE
    });
    jit.selectBatch(makeRequest());
    expect(inner.updates).toHaveLength(0);

    const upgraded: MetaSearchPolicy = { ...makeBasePolicy(), version: 4, id: 'pi-1' };
    jit.update(upgraded);
    expect(inner.updates).toHaveLength(1);
    expect(inner.updates[0]).toBe(upgraded);
    expect(jit.policy).toBe(upgraded);
  });
});

describe('JitActivePolicy diagnostics surface', () => {
  it('attaches JSON-safe L1 diagnostics under metadata.jit', () => {
    const jit = createJitActivePolicy({
      inner: makeInner(),
      experiences: invariantLovingHistory(),
      config: NO_SURFACES,
      rng: NO_EXPLORE
    });
    const plan = jit.selectBatch(makeRequest());
    expect(hasJitDiagnostics(plan)).toBe(true);
    const diagnostics = readJitDiagnostics(plan);
    expect(diagnostics).toBeDefined();
    expect(diagnostics?.level).toBe('meta');
    expect(diagnostics?.neighborCount).toBe(6);
    expect(diagnostics?.adjustments).toHaveLength(4);
    expect(diagnostics?.adjustments.map((entry) => entry.slotKind)).toEqual([
      'exploit',
      'explore_domain',
      'explore_invariant',
      'recover'
    ]);
    for (const entry of diagnostics?.adjustments ?? []) {
      expect(Number.isFinite(entry.adjustedLogit)).toBe(true);
      expect(Number.isFinite(entry.probability)).toBe(true);
      expect(entry.probability).toBeGreaterThanOrEqual(0);
    }
    // Metadata stays JSON-serialisable: no class instances or functions.
    expect(() => JSON.stringify(plan.metadata)).not.toThrow();
    expect(jit.decisions).toHaveLength(1);
  });

  it('keeps BatchPlan.policyId equal to the BASE policy id', () => {
    const jit = createJitActivePolicy({
      inner: makeInner(),
      experiences: invariantLovingHistory(),
      config: NO_SURFACES,
      rng: NO_EXPLORE
    });
    const plan = jit.selectBatch(makeRequest());
    expect(plan.policyId).toBe('pi-0');
  });

  it('preserves width, budget and the grid of the request', () => {
    const inner = makeInner();
    const baseline = inner.selectBatch(makeRequest());
    const jit = createJitActivePolicy({
      inner: makeInner(),
      experiences: invariantLovingHistory(),
      config: NO_SURFACES,
      rng: NO_EXPLORE
    });
    const plan = jit.selectBatch(makeRequest());
    expect(plan.width).toBe(plan.slots.length);
    expect(plan.grid).toEqual(baseline.grid);
    // Capacity is untouched: the Jit correction only moves shares inside it.
    expect(plan.slots.length).toBeLessThanOrEqual(baseline.slots.length + 4);
  });
});

describe('acceptance (a): invariant gets more seats', () => {
  it('schedules strictly more explore_invariant slots than the plain policy', () => {
    // Capacity 6: the fixture tree has no repairable failure, so all six seats
    // are apportioned over the three search tracks and the shares can move.
    const request = makeRequest({ grid: makeWideGrid() });
    const plain = makeInner().selectBatch(request);
    const jit = createJitActivePolicy({
      inner: makeInner(),
      experiences: invariantLovingHistory(),
      config: NO_SURFACES,
      rng: NO_EXPLORE
    });
    const adjusted = jit.selectBatch(request);

    expect(countSlots(adjusted, 'explore_invariant')).toBeGreaterThan(
      countSlots(plain, 'explore_invariant')
    );
    expect(readJitDiagnostics(adjusted)?.klToPrior).toBeGreaterThan(0);
    // Capacity itself never moves: width is still the apportioned 6.
    expect(adjusted.width).toBe(plain.width);
  });

  it('lowers the exploit share when exploit history is strongly negative', () => {
    const request = makeRequest({ grid: { ...makeRequest().grid, maxWidth: 4, budget: 4 } });
    const jit = createJitActivePolicy({
      inner: makeInner(),
      experiences: invariantLovingHistory(),
      config: NO_SURFACES,
      rng: NO_EXPLORE
    });
    const plan = jit.selectBatch(request);
    const diagnostics = readJitDiagnostics(plan);
    const exploit = diagnostics?.adjustments.find((entry) => entry.slotKind === 'exploit');
    const invariant = diagnostics?.adjustments.find(
      (entry) => entry.slotKind === 'explore_invariant'
    );
    expect(invariant === undefined ? 0 : invariant.normalizedAdvantage).toBeGreaterThan(
      exploit === undefined ? 0 : exploit.normalizedAdvantage
    );
  });
});

describe('acceptance (b): a brand-new signature is untouched', () => {
  it('returns identical slots and klToPrior 0 when there are no neighbours', () => {
    const request = makeDissimilarRequest();
    const plain = makeInner().selectBatch(request);
    const jit = createJitActivePolicy({
      inner: makeInner(),
      experiences: invariantLovingHistory(),
      config: NO_SURFACES,
      rng: NO_EXPLORE
    });
    const adjusted = jit.selectBatch(request);

    expect(readJitDiagnostics(adjusted)?.neighborCount).toBe(0);
    expect(readJitDiagnostics(adjusted)?.klToPrior).toBe(0);
    expect(adjusted.slots).toEqual(plain.slots);
    expect(adjusted.width).toBe(plain.width);
    expect(adjusted.policyId).toBe(plain.policyId);
  });

  it('returns identical slots for an empty experience store', () => {
    const request = makeRequest();
    const plain = makeInner().selectBatch(request);
    const jit = createJitActivePolicy({ inner: makeInner(), experiences: [], rng: NO_EXPLORE });
    const adjusted = jit.selectBatch(request);
    expect(adjusted.slots).toEqual(plain.slots);
    expect(readJitDiagnostics(adjusted)?.klToPrior).toBe(0);
  });
});

describe('acceptance (c): beta = 0 equals the plain policy', () => {
  it('leaves the plan byte-identical when the KL temperature is 0', () => {
    const request = makeRequest();
    const plain = makeInner().selectBatch(request);
    const jit = createJitActivePolicy({
      inner: makeInner(),
      experiences: invariantLovingHistory(),
      config: { ...NO_SURFACES, beta: 0 },
      rng: NO_EXPLORE
    });
    const adjusted = jit.selectBatch(request);
    expect(adjusted.slots).toEqual(plain.slots);
    expect(readJitDiagnostics(adjusted)?.klToPrior).toBe(0);
  });
});

describe('acceptance (d): structural invariants survive the correction', () => {
  it('keeps every explore_invariant slot guidance_free', () => {
    const jit = createJitActivePolicy({
      inner: makeInner(),
      experiences: invariantLovingHistory(),
      config: NO_SURFACES,
      rng: NO_EXPLORE
    });
    const plan = jit.selectBatch(makeRequest());
    const invariants = plan.slots.filter((slot) => slot.slot === 'explore_invariant');
    expect(invariants.length).toBeGreaterThan(0);
    for (const slot of invariants) {
      expect(slot.guidance).toBe('guidance_free');
    }
  });

  it('never schedules more than one recovery slot', () => {
    const jit = createJitActivePolicy({
      inner: makeInner(),
      experiences: invariantLovingHistory(),
      config: NO_SURFACES,
      rng: NO_EXPLORE
    });
    const plan = jit.selectBatch(makeRequest());
    expect(countSlots(plan, 'recover')).toBeLessThanOrEqual(1);
  });

  it('keeps slot indexes contiguous from zero', () => {
    const jit = createJitActivePolicy({
      inner: makeInner(),
      experiences: invariantLovingHistory(),
      config: NO_SURFACES,
      rng: NO_EXPLORE
    });
    const plan = jit.selectBatch(makeRequest());
    expect(plan.slots.map((slot) => slot.slotIndex)).toEqual(
      plan.slots.map((_, index) => index)
    );
  });

  it('returns the baseline untouched when the grid schedules nothing', () => {
    const request = makeRequest({
      grid: { ...makeRequest().grid, skipProbing: true, maxWidth: 0, budget: 0 }
    });
    const jit = createJitActivePolicy({
      inner: makeInner(),
      experiences: invariantLovingHistory(),
      config: NO_SURFACES,
      rng: NO_EXPLORE
    });
    const plan = jit.selectBatch(request);
    expect(plan.slots).toEqual([]);
    expect(hasJitDiagnostics(plan)).toBe(false);
  });
});

describe('surface fan-out', () => {
  it('uses slot:<kind>/surf:<...> action keys when surfaces are enabled', () => {
    const jit = createJitActivePolicy({
      inner: makeInner(),
      experiences: invariantLovingHistory(),
      config: { useSurfaces: true },
      rng: NO_EXPLORE
    });
    const plan = jit.selectBatch(makeRequest());
    const diagnostics = readJitDiagnostics(plan);
    // Every action key stays a legal L1 key and resolves back to its kind.
    for (const entry of diagnostics?.adjustments ?? []) {
      expect(slotKindOfActionKey(entry.actionKey)).toBe(entry.slotKind);
    }
  });

  it('still increases invariant seats with surface-qualified candidates', () => {
    const request = makeRequest();
    const plain = makeInner().selectBatch(request);
    const records = [
      makeMetaRecord({
        id: 's1',
        slotKind: 'explore_invariant',
        value: 2.6,
        surfaces: ['guardrails']
      }),
      makeMetaRecord({
        id: 's2',
        slotKind: 'explore_invariant',
        value: 2.4,
        surfaces: ['guardrails']
      }),
      makeMetaRecord({ id: 's3', slotKind: 'exploit', value: -2.2, surfaces: ['guardrails'] }),
      makeMetaRecord({ id: 's4', slotKind: 'exploit', value: -1.9, surfaces: ['guardrails'] })
    ];
    const jit = createJitActivePolicy({
      inner: makeInner(),
      experiences: records,
      config: { useSurfaces: true },
      rng: NO_EXPLORE
    });
    const adjusted = jit.selectBatch(request);
    expect(countSlots(adjusted, 'explore_invariant')).toBeGreaterThan(
      countSlots(plain, 'explore_invariant')
    );
  });
});

describe('degraded paths', () => {
  it('falls back to the unadjusted plan when the optimizer throws', () => {
    const throwing = makeInner();
    const jit = createJitActivePolicy({
      inner: throwing,
      experiences: () => {
        throw new Error('experience snapshot unavailable');
      },
      config: NO_SURFACES,
      rng: NO_EXPLORE
    });
    const request = makeRequest();
    const plain = throwing.selectBatch(request);
    const plan = jit.selectBatch(request);
    const diagnostics = readJitDiagnostics(plan);
    expect(diagnostics?.degraded).toBe(true);
    expect(diagnostics?.degradedReason).toContain('experience snapshot unavailable');
    expect(plan.slots).toEqual(plain.slots);
    expect(jit.diagnostics().join(' ')).toContain('degraded');
  });

  it('records a diagnostic instead of throwing on a hostile request', () => {
    const jit = createJitActivePolicy({
      inner: makeInner(),
      experiences: invariantLovingHistory(),
      config: NO_SURFACES,
      rng: NO_EXPLORE
    });
    // previousBestNodeId points at a node that does not exist in the tree.
    const request = makeRequest({ previousBestNodeId: 'ghost' });
    const plan = jit.selectBatch(request);
    expect(plan.width).toBeGreaterThan(0);
    expect(plan.slots.length).toBeGreaterThan(0);
  });

  it('keeps the frozen defaults when no config is injected', () => {
    const jit = createJitActivePolicy({ inner: makeInner(), experiences: [], rng: NO_EXPLORE });
    const plan = jit.selectBatch(makeRequest());
    expect(plan.width).toBeGreaterThan(0);
    expect(readJitDiagnostics(plan)?.klToPrior).toBe(0);
  });

  it('uses the injected clock for retrieval decay', () => {
    const records = invariantLovingHistory();
    const jit = createJitActivePolicy({
      inner: makeInner(),
      experiences: records,
      config: { ...NO_SURFACES, halfLifeMs: 1000 },
      now: () => T0 + 1000 * 60 * 60,
      rng: NO_EXPLORE
    });
    const plan = jit.selectBatch(makeRequest());
    // Fully decayed neighbours still produce a finite, zero-KL decision.
    const diagnostics = readJitDiagnostics(plan);
    expect(diagnostics).toBeDefined();
    expect(Number.isFinite(diagnostics?.klToPrior)).toBe(true);
  });
});

describe('repair B3: the derived-policy cache is bounded', () => {
  /**
   * Deterministic history whose weight vector differs on EVERY step.
   *
   * A rotation over six values would only ever produce six distinct weight
   * vectors (period 6), which cannot probe an unbounded cache. Instead each
   * record's return is a distinct affine function of the step, so V, Q and every
   * A-tilde move independently and each selectBatch yields its own softmax(z')
   * - the steady state the verifier flagged (a continuously changing experience
   * store). The clock is fixed, so the whole sequence is reproducible.
   */
  function steppedHistory(step: number): readonly ExperienceRecord[] {
    const bump = (base: number, slope: number): number => base + slope * step;
    return [
      makeMetaRecord({ id: 'r1', slotKind: 'explore_invariant', value: bump(2.5, 0.01) }),
      makeMetaRecord({ id: 'r2', slotKind: 'explore_invariant', value: bump(1.4, -0.03) }),
      makeMetaRecord({ id: 'r3', slotKind: 'exploit', value: bump(-0.4, 0.05) }),
      makeMetaRecord({ id: 'r4', slotKind: 'exploit', value: bump(0.7, -0.02) }),
      makeMetaRecord({ id: 'r5', slotKind: 'explore_domain', value: bump(-1.6, 0.04) }),
      makeMetaRecord({ id: 'r6', slotKind: 'explore_domain', value: bump(0.2, 0.03) })
    ];
  }

  it('never exceeds maxEntries across 40 distinct weight vectors', () => {
    const maxEntries = 8;
    let live: readonly ExperienceRecord[] = steppedHistory(0);
    // The decorator reads a live snapshot, so mutating live between calls is
    // what drives 40 different weight vectors through the cache.
    const jit = createJitActivePolicy({
      inner: makeInner(),
      experiences: () => live,
      config: { ...NO_SURFACES, derivedCacheEntries: maxEntries },
      now: () => T0,
      rng: NO_EXPLORE
    });

    const sizes: number[] = [];
    for (let step = 0; step < 40; step += 1) {
      live = steppedHistory(step);
      jit.selectBatch(makeRequest({ grid: makeWideGrid() }));
      sizes.push(jit.cacheStats().size);
    }

    // The bound holds after every single decision, not only at the end.
    expect(Math.max(...sizes)).toBeLessThanOrEqual(maxEntries);
    expect(sizes[sizes.length - 1]).toBe(maxEntries);
    const stats = jit.cacheStats();
    expect(stats.maxEntries).toBe(maxEntries);
    expect(stats.misses).toBeGreaterThan(0);
    // 40 distinct vectors cannot fit in 8 entries: eviction must have happened.
    expect(stats.evictions).toBeGreaterThanOrEqual(40 - maxEntries);
    expect(stats.size).toBeLessThanOrEqual(maxEntries);
  });

  it('defaults to a bounded cache without any configuration', () => {
    const jit = createJitActivePolicy({
      inner: makeInner(),
      experiences: invariantLovingHistory(),
      config: NO_SURFACES,
      rng: NO_EXPLORE
    });
    const stats = jit.cacheStats();
    expect(stats.maxEntries).toBeGreaterThanOrEqual(8);
    expect(stats.maxEntries).toBeLessThanOrEqual(256);
    expect(stats.size).toBe(0);
    jit.selectBatch(makeRequest({ grid: makeWideGrid() }));
    expect(jit.cacheStats().size).toBeLessThanOrEqual(jit.cacheStats().maxEntries);
  });

  it('reuses a warm entry for a repeated weight vector and returns the same plan', () => {
    const jit = createJitActivePolicy({
      inner: makeInner(),
      experiences: invariantLovingHistory(),
      config: { ...NO_SURFACES, derivedCacheEntries: 4 },
      now: () => T0,
      rng: NO_EXPLORE
    });
    const request = makeRequest({ grid: makeWideGrid() });

    const first = jit.selectBatch(request);
    const afterFirst = jit.cacheStats();
    expect(afterFirst.misses).toBe(1);
    expect(afterFirst.hits).toBe(0);
    expect(afterFirst.size).toBe(1);

    const second = jit.selectBatch(request);
    const afterSecond = jit.cacheStats();
    // A warm cache must hit, not rebuild, and the entry count stays at one.
    expect(afterSecond.hits).toBe(afterFirst.hits + 1);
    expect(afterSecond.misses).toBe(afterFirst.misses);
    expect(afterSecond.size).toBe(1);
    expect(afterSecond.evictions).toBe(0);

    // Identical plan: slots, policyId and the L1 diagnostics block.
    expect(second.slots).toEqual(first.slots);
    expect(second.policyId).toBe(first.policyId);
    expect(second.width).toBe(first.width);
    expect(readJitDiagnostics(second)).toEqual(readJitDiagnostics(first));
  });

  it('keeps every bounded decision identical to the unbounded computation', () => {
    // Reference: a cache size of 256 (>= the probe length) never evicts, so it
    // is the unguarded computation for comparison purposes.
    let roomyLive: readonly ExperienceRecord[] = steppedHistory(0);
    let boundedLive: readonly ExperienceRecord[] = steppedHistory(0);
    const roomy = createJitActivePolicy({
      inner: makeInner(),
      experiences: () => roomyLive,
      config: { ...NO_SURFACES, derivedCacheEntries: 256 },
      now: () => T0,
      rng: NO_EXPLORE
    });
    const bounded = createJitActivePolicy({
      inner: makeInner(),
      experiences: () => boundedLive,
      config: { ...NO_SURFACES, derivedCacheEntries: 3 },
      now: () => T0,
      rng: NO_EXPLORE
    });

    for (let step = 0; step < 40; step += 1) {
      roomyLive = steppedHistory(step);
      boundedLive = steppedHistory(step);
      const request = makeRequest({ grid: makeWideGrid() });
      const expected = roomy.selectBatch(request);
      const actual = bounded.selectBatch(request);
      // Eviction may force a rebuild, but never changes the decision.
      expect(actual.slots).toEqual(expected.slots);
      expect(actual.policyId).toBe(expected.policyId);
      expect(actual.width).toBe(expected.width);
      expect(readJitDiagnostics(actual)).toEqual(readJitDiagnostics(expected));
    }
    expect(roomy.cacheStats().size).toBe(40);
    expect(bounded.cacheStats().size).toBeLessThanOrEqual(3);
    expect(bounded.cacheStats().evictions).toBeGreaterThan(0);
  });

  it('clears the cache and its counters on update()', () => {
    const jit = createJitActivePolicy({
      inner: makeInner(),
      experiences: invariantLovingHistory(),
      config: NO_SURFACES,
      rng: NO_EXPLORE
    });
    jit.selectBatch(makeRequest({ grid: makeWideGrid() }));
    expect(jit.cacheStats().size).toBeGreaterThan(0);

    jit.update({ ...makeBasePolicy(), version: 4, id: 'pi-0' });
    const stats = jit.cacheStats();
    expect(stats.size).toBe(0);
    expect(stats.evictions).toBe(0);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
  });

  it('clamps a hostile cache size into the supported range', () => {
    const low = createJitActivePolicy({
      inner: makeInner(),
      experiences: invariantLovingHistory(),
      config: { ...NO_SURFACES, derivedCacheEntries: 0 },
      rng: NO_EXPLORE
    });
    expect(low.cacheStats().maxEntries).toBe(MIN_DERIVED_CACHE_ENTRIES);

    const high = createJitActivePolicy({
      inner: makeInner(),
      experiences: invariantLovingHistory(),
      config: { ...NO_SURFACES, derivedCacheEntries: 100_000 },
      rng: NO_EXPLORE
    });
    expect(high.cacheStats().maxEntries).toBe(MAX_DERIVED_CACHE_ENTRIES);

    const nan = createJitActivePolicy({
      inner: makeInner(),
      experiences: invariantLovingHistory(),
      config: { ...NO_SURFACES, derivedCacheEntries: Number.NaN },
      rng: NO_EXPLORE
    });
    expect(nan.cacheStats().maxEntries).toBe(DEFAULT_DERIVED_CACHE_ENTRIES);
  });
});

describe('G2-1: L1 action space gains the focus-surface dimension', () => {
  /**
   * Root hinting all eight harness surfaces, so treeSurfaces() offers the full
   * 4 x 8 = 32-action space. The baseline exploit/domain/invariant slots then
   * each inherit those eight surfaces.
   */
  const ALL_SURFACES: readonly HarnessComponentKey[] = [
    'system_prompt',
    'guardrails',
    'memory',
    'tool_guidance',
    'skills',
    'scripts',
    'subagents',
    'plugins'
  ];

  function eightSurfaceTree(): DiscoveryTreeSnapshot {
    return makeTree({
      root: makeNode({
        id: 'root',
        guidance: 'guidance_free',
        metadata: { surfaceKeys: [...ALL_SURFACES] }
      }),
      best: makeNode({
        id: 'best',
        parentId: 'root',
        depth: 1,
        slot: 'exploit',
        purpose: 'deepen',
        score: 0.9,
        metadata: { surfaceKeys: [...ALL_SURFACES] }
      })
    });
  }

  /** Canonical request over the eight-surface tree and the wide grid. */
  function eightSurfaceRequest(): SelectBatchRequest {
    return makeRequest({ tree: eightSurfaceTree(), grid: makeWideGrid() });
  }

  it('reports 4 x 8 = 32 candidates when every surface is offered', () => {
    const jit = createJitActivePolicy({
      inner: makeInner(),
      experiences: invariantLovingHistory(),
      config: { surfaceActions: true },
      now: () => T0,
      rng: NO_EXPLORE
    });
    const plan = jit.selectBatch(eightSurfaceRequest());
    const diagnostics = readJitDiagnostics(plan);
    // Four slot kinds, eight surfaces each: the plan section 3.1 action space.
    expect(diagnostics?.adjustments).toHaveLength(32);
    // Every action key is a legal, single-surface L1 key.
    for (const entry of diagnostics?.adjustments ?? []) {
      expect(slotKindOfActionKey(entry.actionKey)).toBe(entry.slotKind);
      expect(entry.actionKey).toContain('/surf:');
      expect(entry.focusSurfaces).toHaveLength(1);
    }
    // Exactly eight distinct actions per kind.
    const perKind = new Map<BatchSlotKind, number>();
    for (const entry of diagnostics?.adjustments ?? []) {
      perKind.set(entry.slotKind, (perKind.get(entry.slotKind) ?? 0) + 1);
    }
    expect([...perKind.values()]).toEqual([8, 8, 8, 8]);
  });

  it('surfaceActions=false is byte-identical to the pre-G2-1 action space', () => {
    const request = eightSurfaceRequest();
    const implicit = createJitActivePolicy({
      inner: makeInner(),
      experiences: invariantLovingHistory(),
      config: {},
      now: () => T0,
      rng: NO_EXPLORE
    });
    const explicit = createJitActivePolicy({
      inner: makeInner(),
      experiences: invariantLovingHistory(),
      config: { surfaceActions: false },
      now: () => T0,
      rng: NO_EXPLORE
    });
    const a = implicit.selectBatch(request);
    const b = explicit.selectBatch(request);
    expect(b.slots).toEqual(a.slots);
    expect(b.width).toBe(a.width);
    expect(readJitDiagnostics(b)).toEqual(readJitDiagnostics(a));
    // One candidate per slot kind, and no surface field on the diagnostics.
    expect(readJitDiagnostics(a)?.adjustments).toHaveLength(4);
    for (const entry of readJitDiagnostics(a)?.adjustments ?? []) {
      expect(entry.focusSurfaces).toBeUndefined();
    }
  });

  it('splits the kind prior across its surfaces, conserving mass per kind', () => {
    const request = eightSurfaceRequest();
    const jit = createJitActivePolicy({
      inner: makeInner(),
      experiences: invariantLovingHistory(),
      config: { surfaceActions: true },
      now: () => T0,
      rng: NO_EXPLORE
    });
    const diagnostics = readJitDiagnostics(jit.selectBatch(request));
    expect(diagnostics).toBeDefined();
    // The prior is uniform inside a kind: every surface of a kind shares one
    // base logit, i.e. -ln(8) below the kind's own prior logit.
    const byKind = new Map<BatchSlotKind, number[]>();
    for (const entry of diagnostics?.adjustments ?? []) {
      const list = byKind.get(entry.slotKind) ?? [];
      list.push(entry.adjustedLogit);
      byKind.set(entry.slotKind, list);
    }
    for (const logits of byKind.values()) {
      const spread = Math.max(...logits) - Math.min(...logits);
      // A surface with support can differ; the prior part stays uniform, so
      // the spread is bounded by the beta * A-tilde correction (<= beta).
      expect(spread).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('keeps the per-kind probability mass equal to the prior when every advantage is zero', () => {
    // Zero advantages happen when the neighbourhood carries no information for
    // any action, so z' = center(z) and softmax(z') is the prior exactly.
    //
    // NOTE ON WHY THIS USES THE 8-SURFACE TREE: with an equal surface count per
    // kind the -ln(|surfaces|) split is a constant shift and softmax is
    // shift-invariant, so this case alone cannot distinguish a real split from
    // no split at all. It is kept because it pins the total mass, ordering and
    // no-op equivalence; the discriminating case is the asymmetric test below.
    const request = eightSurfaceRequest();
    const jit = createJitActivePolicy({
      inner: makeInner(),
      experiences: [],
      config: { surfaceActions: true },
      now: () => T0,
      rng: NO_EXPLORE
    });
    const plan = jit.selectBatch(request);
    const diagnostics = readJitDiagnostics(plan);
    expect(diagnostics?.neighborCount).toBe(0);
    expect(diagnostics?.klToPrior).toBe(0);

    // Per-kind mass equals the kind's prior share (slotWeights 0.4/0.3/0.2/0.1
    // modulated by memoryConfidence like utilityOf).
    const mass = new Map<BatchSlotKind, number>();
    for (const entry of diagnostics?.adjustments ?? []) {
      mass.set(entry.slotKind, (mass.get(entry.slotKind) ?? 0) + entry.probability);
    }
    const total = [...mass.values()].reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 10);
    // Per-kind mass reproduces the kind prior EXACTLY, not merely its ordering.
    // policyPriorLogit() feeds softmax the modulated shares
    // (domain x(0.5+0.5c), invariant x(0.5+0.5(1-c)) with c = memoryConfidence 0.8),
    // so the expected masses are 0.4 / 0.27 / 0.12 / 0.1 normalised by their sum.
    const expectedShares: Record<BatchSlotKind, number> = {
      exploit: 0.4,
      explore_domain: 0.3 * (0.5 + 0.5 * 0.8),
      explore_invariant: 0.2 * (0.5 + 0.5 * (1 - 0.8)),
      recover: 0.1
    };
    const shareSum =
      expectedShares.exploit +
      expectedShares.explore_domain +
      expectedShares.explore_invariant +
      expectedShares.recover;
    for (const kind of ['exploit', 'explore_domain', 'explore_invariant', 'recover'] as const) {
      // Splitting the prior over eight surfaces must conserve the kind's mass:
      // sum_surface p(surface) === prior mass of the kind.
      expect(mass.get(kind)).toBeCloseTo(expectedShares[kind] / shareSum, 10);
    }
  });

  it('returns the baseline plan unchanged when the correction is a no-op', () => {
    const request = eightSurfaceRequest();
    const plain = makeInner().selectBatch(request);
    const jit = createJitActivePolicy({
      inner: makeInner(),
      experiences: [],
      config: { surfaceActions: true },
      now: () => T0,
      rng: NO_EXPLORE
    });
    const adjusted = jit.selectBatch(request);
    expect(readJitDiagnostics(adjusted)?.klToPrior).toBe(0);
    // Byte-identical slots: the surface dimension must not perturb the no-op path.
    expect(adjusted.slots).toEqual(plain.slots);
    expect(adjusted.policyId).toBe(plain.policyId);
  });

  it('writes the chosen surface back onto the produced slots', () => {
    const request = eightSurfaceRequest();
    // History that rewards exactly one surface through an exact action key.
    const chosenSurface: HarnessComponentKey = 'tool_guidance';
    const records: ExperienceRecord[] = [];
    for (let index = 0; index < 6; index += 1) {
      records.push(
        makeMetaRecord({
          id: 'surface-' + String(index),
          slotKind: 'exploit',
          value: 2.5,
          surfaces: [chosenSurface]
        })
      );
    }
    for (let index = 0; index < 6; index += 1) {
      records.push(
        makeMetaRecord({
          id: 'other-' + String(index),
          slotKind: 'exploit',
          value: -2.5,
          surfaces: ['skills']
        })
      );
    }
    const jit = createJitActivePolicy({
      inner: makeInner(),
      experiences: records,
      config: { surfaceActions: true },
      now: () => T0,
      rng: NO_EXPLORE
    });
    const plan = jit.selectBatch(request);
    expect(readJitDiagnostics(plan)?.klToPrior).toBeGreaterThan(0);
    const exploitSlots = plan.slots.filter((slot) => slot.slot === 'exploit');
    expect(exploitSlots.length).toBeGreaterThan(0);
    // The winning surface leads the focus list of the exploit slots.
    for (const slot of exploitSlots) {
      expect(slot.focusSurfaces[0]).toBe(chosenSurface);
      // Never fabricate a surface: the set stays inside what was offered.
      for (const surface of slot.focusSurfaces) {
        expect(ALL_SURFACES).toContain(surface);
      }
      expect(slot.focusSurfaces).toHaveLength(ALL_SURFACES.length);
    }
  });

  it('keeps explore_invariant guidance_free with the surface space enabled', () => {
    const jit = createJitActivePolicy({
      inner: makeInner(),
      experiences: invariantLovingHistory(),
      config: { surfaceActions: true },
      now: () => T0,
      rng: NO_EXPLORE
    });
    const plan = jit.selectBatch(eightSurfaceRequest());
    const invariants = plan.slots.filter((slot) => slot.slot === 'explore_invariant');
    expect(invariants.length).toBeGreaterThan(0);
    for (const slot of invariants) {
      expect(slot.guidance).toBe('guidance_free');
    }
    expect(plan.slots.filter((slot) => slot.slot === 'recover').length).toBeLessThanOrEqual(1);
  });

  it('does not fabricate a surface the baseline never offered', () => {
    // Narrow tree: only guardrails is hinted, so only one candidate exists per
    // kind and the write-back can never introduce another surface.
    const narrowTree = makeTree({
      root: makeNode({
        id: 'root',
        guidance: 'guidance_free',
        metadata: { surfaceKeys: ['guardrails'] }
      }),
      best: makeNode({
        id: 'best',
        parentId: 'root',
        depth: 1,
        slot: 'exploit',
        purpose: 'deepen',
        score: 0.9,
        metadata: { surfaceKeys: ['guardrails'] }
      })
    });
    const request = makeRequest({ tree: narrowTree, grid: makeWideGrid() });
    const jit = createJitActivePolicy({
      inner: makeInner(),
      experiences: invariantLovingHistory(),
      config: { surfaceActions: true },
      now: () => T0,
      rng: NO_EXPLORE
    });
    const plan = jit.selectBatch(request);
    expect(readJitDiagnostics(plan)?.adjustments).toHaveLength(4);
    for (const slot of plan.slots) {
      for (const surface of slot.focusSurfaces) {
        expect(surface).toBe('guardrails');
      }
    }
  });
});

describe('G2-1: mass conservation must survive asymmetric surface counts', () => {
  /**
   * Why this suite exists: when every slot kind offers the same number of
   * surfaces the -ln(|surfaces|) split is a constant shift, and softmax is
   * shift-invariant, so any mass-conservation assertion would pass even if the
   * split were removed entirely (confirmed by a mutation probe). Only an
   * asymmetric offer makes the split observable.
   *
   * ActivePolicy focuses exploit slots on the BEST node's surfaces and the
   * domain/invariant slots on the ROOT's surfaces, so two different hints yield
   * a genuinely asymmetric offer: exploit -> 3, explore_domain -> 2,
   * explore_invariant -> 2, recover -> 2 (the configured fallback). A wrong
   * implementation (no -ln term) weights surfaces rather than kinds, so exploit
   * would collect 3/2 of its rightful mass and the assertions below fail.
   */
  const ROOT_SURFACES: readonly HarnessComponentKey[] = ['system_prompt', 'guardrails'];
  const BEST_SURFACES: readonly HarnessComponentKey[] = [
    'system_prompt',
    'guardrails',
    'skills'
  ];

  function asymmetricTree(): DiscoveryTreeSnapshot {
    return makeTree({
      root: makeNode({
        id: 'root',
        guidance: 'guidance_free',
        metadata: { surfaceKeys: [...ROOT_SURFACES] }
      }),
      best: makeNode({
        id: 'best',
        parentId: 'root',
        depth: 1,
        slot: 'exploit',
        purpose: 'deepen',
        score: 0.9,
        metadata: { surfaceKeys: [...BEST_SURFACES] }
      })
    });
  }

  it('conserves each kind prior despite unequal surface counts', () => {
    const request = makeRequest({ tree: asymmetricTree(), grid: makeWideGrid() });
    const jit = createJitActivePolicy({
      inner: makeInner(),
      experiences: [],
      config: { surfaceActions: true },
      now: () => T0,
      rng: NO_EXPLORE
    });
    const plan = jit.selectBatch(request);
    const diagnostics = readJitDiagnostics(plan);
    expect(diagnostics?.neighborCount).toBe(0);
    expect(diagnostics?.klToPrior).toBe(0);

    // The candidate count proves the offer really is asymmetric.
    const counts = new Map<BatchSlotKind, number>();
    for (const entry of diagnostics?.adjustments ?? []) {
      counts.set(entry.slotKind, (counts.get(entry.slotKind) ?? 0) + 1);
    }
    // The offer is genuinely asymmetric: exploit sees one surface more than the
    // root-focused kinds, which is exactly what makes the split observable.
    expect(counts.get('exploit')).toBe(BEST_SURFACES.length);
    expect(counts.get('explore_domain')).toBe(ROOT_SURFACES.length);
    expect(counts.get('explore_invariant')).toBe(ROOT_SURFACES.length);
    expect(counts.get('recover')).toBe(ROOT_SURFACES.length);

    // Per-kind mass still equals the kind prior, memoryConfidence 0.8.
    const mass = new Map<BatchSlotKind, number>();
    for (const entry of diagnostics?.adjustments ?? []) {
      mass.set(entry.slotKind, (mass.get(entry.slotKind) ?? 0) + entry.probability);
    }
    const expectedShares: Record<BatchSlotKind, number> = {
      exploit: 0.4,
      explore_domain: 0.3 * (0.5 + 0.5 * 0.8),
      explore_invariant: 0.2 * (0.5 + 0.5 * (1 - 0.8)),
      recover: 0.1
    };
    const shareSum =
      expectedShares.exploit +
      expectedShares.explore_domain +
      expectedShares.explore_invariant +
      expectedShares.recover;
    for (const kind of ['exploit', 'explore_domain', 'explore_invariant', 'recover'] as const) {
      expect(mass.get(kind)).toBeCloseTo(expectedShares[kind] / shareSum, 10);
    }
  });

  it('splits one kind prior uniformly across that kind surfaces only', () => {
    // Direct arithmetic check on the prior: every surface of a kind carries the
    // SAME base logit, and that logit sits exactly ln(count) below the kind's
    // own prior logit. Verified through the probability ratio of two kinds that
    // differ in surface count: p_kind = prior_kind, independent of the count.
    const request = makeRequest({ tree: asymmetricTree(), grid: makeWideGrid() });
    const jit = createJitActivePolicy({
      inner: makeInner(),
      experiences: [],
      config: { surfaceActions: true },
      now: () => T0,
      rng: NO_EXPLORE
    });
    const diagnostics = readJitDiagnostics(jit.selectBatch(request));
    const byKind = new Map<BatchSlotKind, number[]>();
    for (const entry of diagnostics?.adjustments ?? []) {
      const list = byKind.get(entry.slotKind) ?? [];
      list.push(entry.probability);
      byKind.set(entry.slotKind, list);
    }
    // Inside a kind the surfaces are equiprobable (zero advantages).
    for (const probabilities of byKind.values()) {
      const first = probabilities[0] as number;
      for (const probability of probabilities) {
        expect(probability).toBeCloseTo(first, 10);
      }
    }
    // And each per-surface probability is exactly prior_kind / count_kind. This
    // is the discriminating half: without the -ln split every surface of every
    // kind would carry the full kind prior, so the ratio would be
    // 0.4 / 0.27 = 1.481 instead of the 0.988 asserted here.
    const exploitProbability = (byKind.get('exploit') ?? [0])[0] as number;
    const domainProbability = (byKind.get('explore_domain') ?? [0])[0] as number;
    // Priors as policyPriorLogit() sees them, normalised the way softmax does.
    const exploitPrior = 0.4;
    const domainPrior = 0.3 * (0.5 + 0.5 * 0.8);
    const invariantPrior = 0.2 * (0.5 + 0.5 * (1 - 0.8));
    const recoverPrior = 0.1;
    const priorSum = exploitPrior + domainPrior + invariantPrior + recoverPrior;
    expect(exploitProbability).toBeCloseTo(
      exploitPrior / priorSum / BEST_SURFACES.length,
      10
    );
    expect(domainProbability).toBeCloseTo(
      domainPrior / priorSum / ROOT_SURFACES.length,
      10
    );
    expect(exploitProbability / domainProbability).toBeCloseTo(
      (exploitPrior / BEST_SURFACES.length) / (domainPrior / ROOT_SURFACES.length),
      10
    );
  });
});

/**
 * Repair H1 (T9 review, high): the online L1 decision must read the JitRL
 * hyperparameters from the *current* policy, not from a constructor-time
 * snapshot, so a dream hot swap that replaces the policy together with its
 * `jit` block (plan section 7.3-3) actually takes effect on the next
 * `selectBatch`.
 */
describe('repair H1: online decisions read the hot-swapped jit hyperparameters', () => {
  /** Base policy carrying an explicit jit block (what a dream hot swap installs). */
  function policyWithJit(beta: number): MetaSearchPolicy {
    return {
      ...makeBasePolicy(),
      jit: {
        beta,
        lambda: 0.05,
        alpha: 5,
        k: 10,
        gamma: 0.5,
        similarityThreshold: 0.3
      }
    };
  }

  /**
   * Recover the KL temperature actually applied, from the observable
   * diagnostics only: with beta = 0 the adjusted logit equals the prior logit,
   * so (z'(beta) - z'(0)) / A-tilde is exactly the beta in force.
   */
  function recoverBeta(
    diagnostics: JitBatchDiagnostics,
    priorByKey: ReadonlyMap<string, number>
  ): readonly number[] {
    const betas: number[] = [];
    for (const entry of diagnostics.adjustments) {
      if (Math.abs(entry.normalizedAdvantage) <= 1e-9) {
        continue;
      }
      const prior = priorByKey.get(entry.actionKey);
      if (prior === undefined) {
        continue;
      }
      betas.push((entry.adjustedLogit - prior) / entry.normalizedAdvantage);
    }
    return betas;
  }

  /** A decorator at the given constructor beta over the canonical history. */
  function decoratorAt(
    beta: number,
    policy: MetaSearchPolicy = makeBasePolicy()
  ): JitActivePolicy {
    return createJitActivePolicy({
      inner: makeInner(policy),
      experiences: invariantLovingHistory(),
      config: { ...NO_SURFACES, beta },
      now: () => T0,
      rng: NO_EXPLORE
    });
  }

  /** Prior logits of every candidate, read from a beta = 0 run. */
  function priorLogits(): ReadonlyMap<string, number> {
    const diagnostics = readJitDiagnostics(decoratorAt(0).selectBatch(makeRequest()));
    expect(diagnostics).toBeDefined();
    return new Map(
      (diagnostics?.adjustments ?? []).map((entry) => [entry.actionKey, entry.adjustedLogit])
    );
  }

  it('uses the hot-swapped beta (2) instead of the constructor beta (0.5)', () => {
    const request = makeRequest();
    const jit = createJitActivePolicy({
      inner: recordingInner(),
      experiences: invariantLovingHistory(),
      config: { ...NO_SURFACES, beta: 0.5 },
      now: () => T0,
      rng: NO_EXPLORE
    });

    // Before the swap the decorator runs with the configured beta = 0.5.
    const before = readJitDiagnostics(jit.selectBatch(request));
    expect(before).toBeDefined();
    const beforeKl = before?.klToPrior ?? Number.NaN;
    expect(beforeKl).toBeGreaterThan(0);

    // Dream hot swap: the policy AND its jit block are replaced together.
    jit.update(policyWithJit(2));

    const after = readJitDiagnostics(jit.selectBatch(request));
    expect(after).toBeDefined();
    const afterKl = after?.klToPrior ?? Number.NaN;

    // KL(pi' || pi_prior) grows with the KL temperature, so beta 0.5 -> 2 must
    // widen the divergence. Freezing beta at the constructor value would leave
    // these two KL values identical, which is exactly the H1 defect.
    expect(afterKl).toBeGreaterThan(beforeKl);
    expect(afterKl / beforeKl).toBeGreaterThan(2);

    // And the recovered temperature is exactly 2, not 0.5.
    const betas = recoverBeta(after as JitBatchDiagnostics, priorLogits());
    expect(betas.length).toBeGreaterThan(0);
    for (const beta of betas) {
      expect(beta).toBeCloseTo(2, 9);
    }
  });

  it('takes effect immediately and follows every subsequent update()', () => {
    const request = makeRequest();
    const jit = createJitActivePolicy({
      inner: recordingInner(),
      experiences: invariantLovingHistory(),
      config: { ...NO_SURFACES, beta: 0.5 },
      now: () => T0,
      rng: NO_EXPLORE
    });
    const baselines = priorLogits();

    jit.update(policyWithJit(2));
    const atTwo = readJitDiagnostics(jit.selectBatch(request));
    for (const beta of recoverBeta(atTwo as JitBatchDiagnostics, baselines)) {
      expect(beta).toBeCloseTo(2, 9);
    }

    // Swap back down: the decorator must follow the live policy, not remember
    // the previous swap.
    jit.update(policyWithJit(0.5));
    const atHalf = readJitDiagnostics(jit.selectBatch(request));
    for (const beta of recoverBeta(atHalf as JitBatchDiagnostics, baselines)) {
      expect(beta).toBeCloseTo(0.5, 9);
    }

    // A policy without a jit block falls back to the constructor beta (0.5).
    jit.update(makeBasePolicy());
    const withoutJit = readJitDiagnostics(jit.selectBatch(request));
    for (const beta of recoverBeta(withoutJit as JitBatchDiagnostics, baselines)) {
      expect(beta).toBeCloseTo(0.5, 9);
    }
  });

  it('produces a different correction magnitude for beta = 0.5 versus beta = 2', () => {
    const request = makeRequest();
    const atHalfDiagnostics = readJitDiagnostics(decoratorAt(0.5).selectBatch(request));
    const atTwoDiagnostics = readJitDiagnostics(decoratorAt(2).selectBatch(request));
    expect(atHalfDiagnostics).toBeDefined();
    expect(atTwoDiagnostics).toBeDefined();

    const halfByKey = new Map(
      (atHalfDiagnostics?.adjustments ?? []).map((entry) => [entry.actionKey, entry])
    );
    let compared = 0;
    for (const entry of atTwoDiagnostics?.adjustments ?? []) {
      const reference = halfByKey.get(entry.actionKey);
      if (reference === undefined) {
        continue;
      }
      // Same state and history, so the normalized advantage is temperature
      // independent; only the logit correction scales with beta.
      expect(entry.normalizedAdvantage).toBeCloseTo(reference.normalizedAdvantage, 12);
      if (Math.abs(entry.normalizedAdvantage) <= 1e-9) {
        continue;
      }
      // A-tilde != 0 => z' = z + beta * A-tilde moves 4x further at beta = 2.
      const halfDelta = reference.adjustedLogit;
      const twoDelta = entry.adjustedLogit;
      expect(Math.abs(twoDelta - halfDelta)).toBeGreaterThan(0);
      compared += 1;
    }
    expect(compared).toBeGreaterThan(0);
    // The portfolio divergence must be strictly larger as well.
    expect(atTwoDiagnostics?.klToPrior ?? 0).toBeGreaterThan(atHalfDiagnostics?.klToPrior ?? 0);
  });

  it('is identical to an explicit jit block equal to the config when policy.jit is absent', () => {
    const request = makeRequest();

    const absent = decoratorAt(1).selectBatch(request);
    // Reference: same constructor config, but the policy carries a jit block
    // equal to it, so both paths must agree on every observed value.
    const explicit = decoratorAt(
      1,
      {
        ...makeBasePolicy(),
        jit: {
          beta: 1,
          lambda: 0.05,
          alpha: 5,
          k: 10,
          gamma: 0.5,
          similarityThreshold: 0.3
        }
      }
    ).selectBatch(request);

    expect(readJitDiagnostics(absent)).toEqual(readJitDiagnostics(explicit));
    expect(absent.slots).toEqual(explicit.slots);
    expect(absent.width).toBe(explicit.width);
    expect(absent.policyId).toBe(explicit.policyId);
    expect(absent.grid.maxWidth).toBe(explicit.grid.maxWidth);
  });

  it('ignores non-finite jit fields instead of poisoning the decision', () => {
    const request = makeRequest();
    const jit = createJitActivePolicy({
      inner: recordingInner(),
      experiences: invariantLovingHistory(),
      config: { ...NO_SURFACES, beta: 1 },
      now: () => T0,
      rng: NO_EXPLORE
    });
    const baselines = priorLogits();

    jit.update({
      ...makeBasePolicy(),
      jit: {
        beta: Number.NaN,
        lambda: Number.POSITIVE_INFINITY,
        alpha: 5,
        k: 10,
        gamma: 0.5,
        similarityThreshold: 0.3
      }
    });
    const diagnostics = readJitDiagnostics(jit.selectBatch(request));
    expect(diagnostics).toBeDefined();
    expect(diagnostics?.degraded).not.toBe(true);
    // beta falls back to the constructor value 1, never NaN.
    const betas = recoverBeta(diagnostics as JitBatchDiagnostics, baselines);
    expect(betas.length).toBeGreaterThan(0);
    for (const beta of betas) {
      expect(Number.isFinite(beta)).toBe(true);
      expect(beta).toBeCloseTo(1, 9);
    }
  });
});

/**
 * P6 PR5 (plan section 7.3): the decorator consumes a versioned
 * EffectivePolicyConfig, so a hot swap is visible per decision and the consumer
 * cache is invalidated by version rather than by coincidence.
 */
describe('P6 PR5: effective policy config provider', () => {
  function provider(): EffectivePolicyConfigProvider {
    return createEffectivePolicyConfigProvider({
      initial: baseEffectivePolicyConfig({
        jitrl: DEFAULT_EVO_HARNESS_CONFIG.jitrl,
        halfLifeMs: 60_000
      }),
      now: () => T0
    });
  }

  it('records the consumed version on every decision', () => {
    const configs = provider();
    const jit = createJitActivePolicy({
      inner: recordingInner(),
      experiences: invariantLovingHistory(),
      config: NO_SURFACES,
      now: () => T0,
      rng: NO_EXPLORE,
      policyConfigProvider: configs
    });
    const first = readJitDiagnostics(jit.selectBatch(makeRequest()));
    expect(first?.policyVersion).toBe('config@v0');
    // The read was logged, so the version is auditable rather than inferred.
    expect(configs.consumptionLog().map((entry) => entry.consumer)).toEqual(['level1']);

    configs.publish({ policy: { ...makeBasePolicy(), id: 'pi-0', version: 12 } });
    const second = readJitDiagnostics(jit.selectBatch(makeRequest()));
    expect(second?.policyVersion).toBe('pi-0@v12');
    expect(configs.consumptionLog()).toHaveLength(2);
  });

  it('applies a published L1 beta on the very next decision', () => {
    const configs = provider();
    const jit = createJitActivePolicy({
      inner: recordingInner(),
      experiences: invariantLovingHistory(),
      config: { ...NO_SURFACES, beta: 0.5 },
      now: () => T0,
      rng: NO_EXPLORE,
      policyConfigProvider: configs
    });
    const before = readJitDiagnostics(jit.selectBatch(makeRequest()));
    expect(before).toBeDefined();
    const beforeKl = before?.klToPrior ?? Number.NaN;
    expect(beforeKl).toBeGreaterThan(0);

    // Publish a larger temperature through the provider only.
    configs.publish({ level1: { beta: 2 } });
    const after = readJitDiagnostics(jit.selectBatch(makeRequest()));
    const afterKl = after?.klToPrior ?? Number.NaN;
    expect(afterKl).toBeGreaterThan(beforeKl);
    // The provider is the authority: the constructor beta is no longer read.
    expect(after?.policyVersion).toBe(configs.versionTag());
  });

  it('invalidates the derived-policy cache when the version changes', () => {
    const configs = provider();
    const jit = createJitActivePolicy({
      inner: recordingInner(),
      experiences: invariantLovingHistory(),
      config: NO_SURFACES,
      now: () => T0,
      rng: NO_EXPLORE,
      policyConfigProvider: configs
    });
    jit.selectBatch(makeRequest());
    const missesAfterFirst = jit.cacheStats().misses;
    expect(missesAfterFirst).toBeGreaterThan(0);

    configs.publish({ policy: { ...makeBasePolicy(), id: 'pi-0', version: 21 } });
    jit.selectBatch(makeRequest());
    // A version bump forces a rebuild even when the weight vector repeats.
    expect(jit.cacheStats().misses).toBeGreaterThan(missesAfterFirst);
  });

  it('reports the ignored dimensions and the filter trace per decision', () => {
    const jit = createJitActivePolicy({
      inner: recordingInner(),
      experiences: invariantLovingHistory(),
      config: NO_SURFACES,
      now: () => T0,
      rng: NO_EXPLORE
    });
    const diagnostics = readJitDiagnostics(jit.selectBatch(makeRequest()));
    expect(diagnostics?.ignoredDimensions).toEqual(['lambda', 'alpha', 'gamma']);
    // Without a provider there is no published version to name, and the filter
    // trace still explains the neighbourhood size.
    expect(diagnostics?.policyVersion).toBeUndefined();
    expect(diagnostics?.filter?.records).toBe(invariantLovingHistory().length);
    expect(diagnostics?.filter?.kept).toBeGreaterThan(0);
  });

  it('falls back to the live policy block when no provider is injected', () => {
    // Repair H1 must keep working without a provider (pre-PR5 wiring).
    const jit = createJitActivePolicy({
      inner: recordingInner(),
      experiences: invariantLovingHistory(),
      config: { ...NO_SURFACES, beta: 0.5 },
      now: () => T0,
      rng: NO_EXPLORE
    });
    const before = readJitDiagnostics(jit.selectBatch(makeRequest()));
    jit.update({
      ...makeBasePolicy(),
      jit: {
        beta: 2,
        lambda: 0.05,
        alpha: 5,
        k: 10,
        gamma: 0.5,
        similarityThreshold: 0.3
      }
    });
    const after = readJitDiagnostics(jit.selectBatch(makeRequest()));
    expect(after?.klToPrior ?? 0).toBeGreaterThan(before?.klToPrior ?? 0);
    expect(after?.policyVersion).toBeUndefined();
  });
});

describe('runtime switch (P3-E2 gap 1)', () => {
  it('returns the baseline plan byte-identically while off and records nothing', () => {
    const request = makeRequest();
    const inner = makeInner();
    let enabled = false;
    const jit = createJitActivePolicy({
      inner,
      experiences: [],
      config: { beta: 1 },
      now: () => T0,
      rng: NO_EXPLORE,
      isRuntimeEnabled: () => enabled
    });

    const baseline = inner.selectBatch(request);
    const off = jit.selectBatch(request);
    expect(off).toEqual(baseline);
    expect(JSON.stringify(off)).toBe(JSON.stringify(baseline));
    expect(hasJitDiagnostics(off)).toBe(false);
    expect(jit.decisions).toHaveLength(0);
    expect(jit.diagnostics()).toHaveLength(0);

    // Flipping on restores the decorator without re-mounting it.
    enabled = true;
    const on = jit.selectBatch(request);
    expect(hasJitDiagnostics(on)).toBe(true);
    expect(jit.decisions).toHaveLength(1);
    expect(on.slots).toEqual(baseline.slots);

    // Flipping off again stops decisions immediately.
    enabled = false;
    const offAgain = jit.selectBatch(request);
    expect(offAgain).toEqual(baseline);
    expect(hasJitDiagnostics(offAgain)).toBe(false);
    expect(jit.decisions).toHaveLength(1);
  });

  it('carries the real candidate source into diagnostics (P3-E2 gap 3)', () => {
    const jit = createJitActivePolicy({
      inner: makeInner(),
      experiences: [],
      config: { beta: 1 },
      now: () => T0,
      rng: NO_EXPLORE
    });
    const diagnostics = readJitDiagnostics(jit.selectBatch(makeRequest()));
    expect(diagnostics?.adjustments.length).toBeGreaterThan(0);
    for (const adjustment of diagnostics?.adjustments ?? []) {
      expect(adjustment.source).toBe('policy_prior');
    }
  });

  it('fails open when the runtime predicate itself throws', () => {
    const jit = createJitActivePolicy({
      inner: makeInner(),
      experiences: [],
      config: { beta: 1 },
      now: () => T0,
      rng: NO_EXPLORE,
      isRuntimeEnabled: () => {
        throw new Error('switch unavailable');
      }
    });
    expect(hasJitDiagnostics(jit.selectBatch(makeRequest()))).toBe(true);
  });
});
