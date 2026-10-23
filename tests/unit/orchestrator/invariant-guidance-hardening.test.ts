/**
 * Repair M1 (T9 review, medium): plan section 7.1 requires the invariant track to
 * never read external memory. Three of the four guards already pin that by slot
 * *kind* (augmentation, proposer, record provenance); the L2 retrieval filter used
 * to read `slot.guidance` - a value the pluggable `MetaSearchPolicy` supplies - so
 * a custom policy could declare `{slot: 'explore_invariant', guidance: 'memory'}`
 * and pull memory-sourced experience into the invariant candidate choice.
 *
 * These cases drive the REAL orchestrator with such a policy and assert on the
 * filter handed to the L2 optimizer. They fail against the pre-repair code and
 * pass once the filter is pinned by slot kind.
 */
import { describe, expect, it } from 'vitest';
import {
  createEvoHarnessOrchestrator,
  type EvoHarnessOrchestratorDeps,
  type OrchestratorJitRl
} from '../../../src/orchestrator';
import { createDefaultConfig, parseEvoHarnessConfig } from '../../../src/config';
import { createDiscoveryTreePool } from '../../../src/dream-rsi';
import { createMemoryExperienceStore } from '../../../src/jitrl/stores/memory.store';
import type { ActivePolicy } from '../../../src/dream-rsi/active-policy';
import type {
  BatchPlan,
  BatchSlotKind,
  BatchSlotPlan,
  BranchExecutor,
  DiscoveryTreeSnapshot,
  GuidanceMode,
  IHarnessProposer,
  JitCandidate,
  JitDecision,
  JitLevel,
  MetaSearchPolicy,
  PlanGridRequest,
  SearchGridPlan,
  SelectBatchRequest
} from '../../../src/types/contracts';

/** One guidanceFilter the orchestrator handed to the L2 optimizer. */
interface DecisionCall {
  readonly level: JitLevel;
  readonly guidanceFilter: GuidanceMode | undefined;
}

const T0 = 1_700_000_000_000;

const POLICY: MetaSearchPolicy = {
  id: 'pi-m1',
  version: 1,
  createdAt: T0,
  maxWidth: 2,
  maxDepth: 1,
  slotWeights: { exploit: 1, explore_domain: 1, explore_invariant: 1, recover: 1 },
  earlyStopThreshold: 0.9,
  minMemoryConfidenceForSkip: 0.5
};

/**
 * A policy that schedules one slot of the requested kind but deliberately
 * mislabels its guidance, which is exactly the side door M1 describes.
 */
function policyScheduling(kind: BatchSlotKind, guidance: GuidanceMode): ActivePolicy {
  const base: ActivePolicy = {
    policy: POLICY,
    appliedPolicyIds: [],
    planGrid: (_request: PlanGridRequest): SearchGridPlan => ({
      maxWidth: POLICY.maxWidth,
      maxDepth: 1,
      budget: 4,
      skipProbing: false,
      stopCondition: 'max_depth',
      complexity: 'moderate',
      rationale: 'm1 grid',
      policyId: POLICY.id
    }),
    selectBatch: (request: SelectBatchRequest): BatchPlan => {
      const slots: BatchSlotPlan[] = [
        {
          slot: kind,
          slotIndex: 0,
          branchId: 'branch-' + kind,
          parentNodeId: request.tree.rootId,
          origin: 'domain',
          // The mislabelled guidance the invariant guard must ignore.
          guidance,
          focusSurfaces: ['system_prompt'],
          rationale: 'm1 slot'
        }
      ];
      return {
        round: request.round,
        grid: request.grid,
        policyId: POLICY.id,
        width: slots.length,
        slots,
        createdAt: T0
      };
    },
    update: (): void => undefined
  };
  return base;
}

/** Tree with a root plus one succeeded child, enough to plan against. */
function makeTree(): DiscoveryTreeSnapshot {
  const node = (
    id: string,
    parentId: string | null,
    depth: number
  ): DiscoveryTreeSnapshot['nodes'][string] => ({
    id,
    treeId: 'tree-m1',
    parentId,
    depth,
    branchId: 'branch-' + id,
    patchId: 'patch-' + id,
    patchOrigin: 'domain',
    purpose: 'initial',
    guidance: 'memory',
    status: 'succeeded',
    childIds: [],
    createdAt: T0,
    updatedAt: T0
  });
  const nodes: Record<string, DiscoveryTreeSnapshot['nodes'][string]> = {
    root: { ...node('root', null, 0), childIds: ['best'] },
    best: node('best', 'root', 1)
  };
  return {
    id: 'tree-m1',
    sessionId: 'session-m1',
    taskId: 'task-m1',
    rootId: 'root',
    nodes,
    policyId: POLICY.id,
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

/** Deterministic clock shared by every stub below. */
function makeClock(): () => number {
  let tick = T0;
  return () => {
    tick += 1;
    return tick;
  };
}

/** Monotonic id factory so patches/branches/trees never collide. */
function makeIdFactory(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return 'm1-' + String(next);
  };
}

/** Proposer returning K structurally distinct candidates. */
function makeProposer(): IHarnessProposer {
  return {
    propose: async () => {
      throw new Error('propose() must not be used when K = 3');
    },
    proposeCandidates: async (request) => ({
      candidates: [0, 1, 2].map((index) => ({
        patch: {
          id: 'patch-c' + String(index),
          sessionId: request.sessionId,
          branchId: 'branch-c' + String(index),
          origin: 'domain' as const,
          purpose: 'initial' as const,
          guidance: 'memory' as const,
          label: 'c' + String(index),
          rationale: 'r' + String(index),
          // Structurally distinct so the patch signatures differ.
          edits:
            index === 0
              ? { guardrails: { kind: 'guardrails' as const, appendRules: ['one'] } }
              : index === 1
                ? { guardrails: { kind: 'guardrails' as const, appendRules: ['one', 'two'] } }
                : {
                    system_prompt: {
                      kind: 'system_prompt' as const,
                      mode: 'append' as const,
                      content: 'x'
                    }
                  },
          createdAt: T0
        },
        rationale: 'r' + String(index),
        focusSurfaces: ['system_prompt' as const],
        confidence: 0.5
      }))
    })
  };
}

/** Run one task through the real orchestrator and collect the L2 filter calls. */
async function runOnce(options: {
  readonly slotKind: BatchSlotKind;
  readonly slotGuidance: GuidanceMode;
}): Promise<readonly DecisionCall[]> {
  const now = makeClock();
  const newId = makeIdFactory();
  const decisionCalls: DecisionCall[] = [];
  const config = parseEvoHarnessConfig({
    triggerMode: 'always',
    probe: { maxConcurrentProbes: 1, probeTimeoutMs: 5_000 },
    dreamRsi: {
      maxOnlineRolloutBudget: 4,
      maxWidth: 2,
      maxDepth: 1,
      offlineDreamTriggerEveryNTasks: 1_000,
      candidatePoliciesCount: 2
    },
    jitrl: { enabled: true, levels: ['meta', 'proposal'], candidateCount: 3 },
    logging: { level: 'silent' }
  });
  const defaults = createDefaultConfig();
  const store = createMemoryExperienceStore({ now, halfLifeMs: 1_000_000_000 });

  const jitSurface: OrchestratorJitRl = {
    store,
    optimizer: {
      decide: async <T>(
        level: JitLevel,
        _state: unknown,
        candidates: readonly JitCandidate<T>[],
        decideOptions?: { readonly guidanceFilter?: GuidanceMode }
      ): Promise<JitDecision<T>> => {
        decisionCalls.push({ level, guidanceFilter: decideOptions?.guidanceFilter });
        const chance = 1 / Math.max(1, candidates.length);
        const adjustments = candidates.map((candidate) => ({
          candidate,
          q: null,
          advantage: 0,
          normalizedAdvantage: 0,
          adjustedLogit: candidate.baseLogit,
          probability: chance,
          support: 0,
          explored: false
        }));
        const chosen = adjustments[0] as (typeof adjustments)[number];
        return {
          level,
          stateValue: 0,
          neighborCount: 0,
          adjustments,
          chosen,
          klToPrior: 0,
          rationale: 'm1 stub'
        };
      }
    },
    config: {
      enabled: true,
      levels: ['meta', 'proposal'],
      gamma: defaults.jitrl.gamma,
      candidateCount: 3,
      k: defaults.jitrl.k,
      similarityThreshold: defaults.jitrl.similarityThreshold,
      augmentFromMemory: defaults.jitrl.augmentFromMemory,
      minSupportForStrongPrior: defaults.jitrl.minSupportForStrongPrior
    }
  };

  const runBranch: BranchExecutor = async () => ({
    status: 'succeeded',
    steps: [],
    deliverable: { content: 'ok', format: 'text' },
    toolErrors: [],
    failureSignals: []
  });

  const deps: EvoHarnessOrchestratorDeps = {
    config,
    memory: createStubMemoryBridge(),
    seams: createStubSeams(),
    policy: policyScheduling(options.slotKind, options.slotGuidance),
    proposer: makeProposer(),
    composer: {
      compose: async () => ({
        selectedBranchId: null,
        selectedNodeId: null,
        selectedTrajectoryId: null,
        selectedPatch: null,
        composedPatch: null,
        assessments: [],
        adoptionRatios: {},
        rationale: 'stub',
        evaluatedAt: T0
      })
    },
    reflector: {
      reflect: async () => ({
        lessons: [],
        positiveCount: 0,
        negativeCount: 0,
        diagnostics: []
      })
    },
    scorer: {
      score: () => ({
        nodeId: 'best',
        score: 0.8,
        signals: { selected: true, adoptionRatio: 0, stepEfficiency: 1, toolErrorRate: 0 },
        weights: { selection: 1, adoption: 0, efficiency: 0, toolErrorPenalty: 0 },
        computedAt: T0,
        evidence: []
      })
    },
    taxonomy: {
      diagnose: () => ({
        category: 'none',
        confidence: 1,
        repairable: false,
        recommendedAction: 'stop',
        evidence: [],
        signals: []
      })
    },
    dreamer: {
      replay: async (request) => {
        const empty = {
          policyId: request.baselinePolicy.id,
          hypervolume: 0,
          meanQuality: 0,
          meanCost: 0,
          perRho: {},
          treesEvaluated: 0
        };
        return {
          ranAt: T0,
          baseline: empty,
          candidateEvaluations: [],
          best: empty,
          improved: false,
          selectedPolicyId: request.baselinePolicy.id,
          replayedTreeIds: [],
          rhoPreferences: []
        };
      }
    },
    treePool: createDiscoveryTreePool(),
    runBranch,
    now,
    newId,
    applyWinningPatch: false,
    jitrl: jitSurface
  };

  const orchestrator = createEvoHarnessOrchestrator(deps);
  try {
    await orchestrator.run({
      sessionId: 'session-m1',
      task: {
        id: 'task-m1',
        prompt: 'Fix the failing build in the release train.',
        taskSignature: 'fix-build-m1',
        complexity: 'moderate',
        contextTags: ['ci']
      },
      trigger: 'always'
    });
  } finally {
    await orchestrator.dispose();
  }
  return decisionCalls.filter((call) => call.level === 'proposal');
}

/** Minimal governed-memory stub: recall yields nothing, commits are no-ops. */
function createStubMemoryBridge(): EvoHarnessOrchestratorDeps['memory'] {
  return {
    descriptor: {
      driverKind: 'unbound',
      serverId: null,
      backendLabel: 'stub',
      capabilities: {
        metadataFiltering: false,
        namespaces: false,
        negativePolarity: false,
        temporal: false,
        supportsPrune: false
      },
      boundAt: T0,
      diagnostics: []
    },
    initialize: async () => ({
      driverKind: 'unbound',
      serverId: null,
      backendLabel: 'stub',
      capabilities: {
        metadataFiltering: false,
        namespaces: false,
        negativePolarity: false,
        temporal: false,
        supportsPrune: false
      },
      boundAt: T0,
      diagnostics: []
    }),
    recall: async (query) => ({
      query,
      scope: query.scope,
      driverKind: 'unbound',
      lessons: [],
      positiveLessons: [],
      negativeLessons: [],
      suppressedLessons: [],
      confidence: 0,
      degraded: true,
      diagnostics: [],
      recalledAt: T0
    }),
    commit: async (_lesson, options) => ({
      accepted: true,
      persisted: false,
      lessonId: 'lesson-m1',
      namespace: 'stub',
      driverKind: 'unbound',
      violations: [],
      at: options.dryRun === true ? T0 : T0
    }),
    isolate: async (scope) => ({
      scope,
      namespace: 'stub',
      active: true,
      release: async () => undefined
    }),
    promote: async (lesson, options) => ({
      accepted: true,
      persisted: false,
      lessonId: lesson.id,
      namespace: 'stub',
      driverKind: 'unbound',
      violations: [],
      at: options.to === undefined ? T0 : T0
    }),
    prune: async () => ({ scanned: 0, removedIds: [], dryRun: true }),
    dispose: async () => undefined
  };
}

/** Minimal seam manager: one synchronous successful probe per branch. */
function createStubSeams(): EvoHarnessOrchestratorDeps['seams'] {
  return {
    runInIsolatedBranch: async (request) => ({
      id: 'traj-' + request.patch.id,
      sessionId: request.sessionId,
      branchId: request.branchId ?? 'branch-probe',
      branchNamespace: 'stub',
      role: request.role ?? 'candidate',
      status: 'succeeded',
      patchId: request.patch.id,
      patchOrigin: request.patch.origin,
      surfaceKeys: [],
      startedAt: T0,
      endedAt: T0 + 1,
      metrics: { steps: 1, toolCalls: 0, toolErrors: 0, durationMs: 1 },
      steps: [],
      toolErrors: [],
      failureSignals: [],
      memoryRecallIds: []
    }),
    applyPermanentPatch: async () => ({
      patchId: 'patch-applied',
      active: true,
      dispose: async () => undefined
    }),
    listActiveBranches: () => [],
    dispose: async () => undefined
  };
}

describe('repair M1: the invariant L2 filter is pinned by slot kind', () => {
  it('ignores a mislabelled invariant slot and filters to guidance_free', async () => {
    // The side door: a custom policy declares the invariant slot as 'memory'.
    const calls = await runOnce({ slotKind: 'explore_invariant', slotGuidance: 'memory' });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.guidanceFilter).toBe('guidance_free');
    }
  });

  it('pins the filter by kind regardless of what the slot guidance claims', async () => {
    const asMemory = await runOnce({ slotKind: 'explore_invariant', slotGuidance: 'memory' });
    const asFree = await runOnce({
      slotKind: 'explore_invariant',
      slotGuidance: 'guidance_free'
    });
    const filters = new Set([...asMemory, ...asFree].map((call) => call.guidanceFilter));
    // Both spellings collapse onto the single hard-pinned value.
    expect([...filters]).toEqual(['guidance_free']);
  });

  it('leaves the non-invariant slots reading the slot guidance', async () => {
    const domain = await runOnce({ slotKind: 'explore_domain', slotGuidance: 'memory' });
    expect(domain.length).toBeGreaterThan(0);
    for (const call of domain) {
      expect(call.guidanceFilter).toBe('memory');
    }

    const exploit = await runOnce({ slotKind: 'exploit', slotGuidance: 'memory' });
    expect(exploit.length).toBeGreaterThan(0);
    for (const call of exploit) {
      expect(call.guidanceFilter).toBe('memory');
    }
  });

  it('keeps a guidance_free non-invariant slot guidance_free (no widening)', async () => {
    const calls = await runOnce({ slotKind: 'explore_domain', slotGuidance: 'guidance_free' });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.guidanceFilter).toBe('guidance_free');
    }
  });
});
