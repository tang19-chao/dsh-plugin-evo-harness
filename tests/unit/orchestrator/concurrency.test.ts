/**
 * P0-3: concurrent probe wave + deterministic commit.
 *
 * The orchestrator must run one batch's slots through a bounded concurrent probe
 * wave (config.probe.maxConcurrentProbes), then commit classify/score/tree writes
 * and trace entries strictly in slotIndex order. These tests use a slow mock
 * BranchExecutor so wall-clock overlap is observable, and an injected seam manager
 * that simply forwards to it.
 */
import { describe, expect, it } from 'vitest';
import { createEvoHarnessOrchestrator } from '../../../src/orchestrator';
import type {
  EvoHarnessOrchestrator,
  EvoHarnessOrchestratorDeps,
  EvoHarnessStageEvent
} from '../../../src/orchestrator';
import { parseEvoHarnessConfig } from '../../../src/config';
import { createDiscoveryTree, createDiscoveryTreePool } from '../../../src/dream-rsi';
import type { DiscoveryTree, DiscoveryTreeOptions, ProbeNodeRecord } from '../../../src/dream-rsi';
import type {
  BatchPlan,
  BatchSlotPlan,
  BranchExecutor,
  CanonicalLesson,
  CompositionResult,
  DiscoveryNode,
  DreamReplayReport,
  FailureDiagnosis,
  IActivePolicy,
  ICordisSeamManager,
  IHarnessComposer,
  IHarnessProposer,
  IHarnessReflector,
  IMemoryBridge,
  IOfflineDreamer,
  ISurrogateScorer,
  IsolatedBranchContext,
  MemoryBridgeDescriptor,
  MemoryCommitOptions,
  MemoryCommitResult,
  MemoryIsolationHandle,
  MemoryRecallQuery,
  MemoryRecallResult,
  MemoryScope,
  MetaSearchPolicy,
  ProbeBranchRequest,
  ProbeExecutionResult,
  ProbeTrajectory,
  ProposeRequest,
  ProposedPatch,
  SearchGridPlan,
  SelectBatchRequest,
  SurfacePatchDisposer,
  SurrogateScoreRequest
} from '../../../src/types/contracts';
import type { HarnessComponentKey } from '../../../src/types/contracts';

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function makeClock(start = 1_700_000_000_000): () => number {
  let current = start;
  return (): number => {
    current += 1;
    return current;
  };
}

function makeIdFactory(prefix: string): () => string {
  let counter = 0;
  return (): string => {
    counter += 1;
    return prefix + '-' + String(counter);
  };
}

function makeRecall(query: MemoryRecallQuery): MemoryRecallResult {
  return {
    query,
    scope: query.scope,
    driverKind: 'vector_fact',
    lessons: [],
    positiveLessons: [],
    negativeLessons: [],
    suppressedLessons: [],
    confidence: 0.2,
    degraded: false,
    diagnostics: [],
    recalledAt: 0
  };
}

interface MemoryStats {
  isolated: number;
  released: number;
  maxActive: number;
}

function makeMemoryBridge(): { bridge: IMemoryBridge; stats: MemoryStats } {
  const stats: MemoryStats = { isolated: 0, released: 0, maxActive: 0 };
  let active = 0;
  const descriptor: MemoryBridgeDescriptor = {
    driverKind: 'vector_fact',
    serverId: null,
    backendLabel: 'mock',
    capabilities: {
      metadataFiltering: true,
      namespaces: true,
      negativePolarity: true,
      temporal: false,
      supportsPrune: false
    },
    boundAt: 0,
    diagnostics: []
  };
  const commitResult = (lesson: CanonicalLesson): MemoryCommitResult => ({
    accepted: true,
    persisted: true,
    lessonId: lesson.id,
    namespace: 'mock',
    driverKind: 'vector_fact',
    violations: [],
    at: 0
  });
  const bridge: IMemoryBridge = {
    descriptor,
    initialize: async () => descriptor,
    recall: async (query) => makeRecall(query),
    commit: async (lesson: CanonicalLesson, _options: MemoryCommitOptions) =>
      commitResult(lesson),
    isolate: async (scope: MemoryScope): Promise<MemoryIsolationHandle> => {
      stats.isolated += 1;
      active += 1;
      stats.maxActive = Math.max(stats.maxActive, active);
      let live = true;
      return {
        scope,
        namespace: 'mock-branch',
        get active(): boolean {
          return live;
        },
        release: async (): Promise<void> => {
          if (!live) {
            return;
          }
          live = false;
          active -= 1;
          stats.released += 1;
        }
      };
    },
    promote: async (lesson: CanonicalLesson) => commitResult(lesson),
    prune: async () => ({ scanned: 0, removedIds: [], dryRun: false }),
    dispose: async () => undefined
  };
  return { bridge, stats };
}

interface SeamProbeCall {
  readonly branchId: string;
  readonly patchId: string;
  readonly role: string;
}

/**
 * Seam manager that delegates to the injected BranchExecutor and materializes a
 * ProbeTrajectory from its result.
 */
function makeSeams(now: () => number): {
  seams: ICordisSeamManager;
  calls: SeamProbeCall[];
} {
  const calls: SeamProbeCall[] = [];
  let trajectorySeq = 0;
  const seams: ICordisSeamManager = {
    async runInIsolatedBranch(request: ProbeBranchRequest): Promise<ProbeTrajectory> {
      const branchId = request.branchId ?? 'branch';
      calls.push({ branchId, patchId: request.patch.id, role: request.role ?? 'candidate' });
      const startedAt = now();
      const context: IsolatedBranchContext = {
        branchId,
        sessionId: request.sessionId,
        namespace: 'mock',
        task: request.task,
        patch: request.patch,
        mountedSurfaces: Object.keys(request.patch.edits) as HarnessComponentKey[],
        signal: new AbortController().signal
      };
      const result: ProbeExecutionResult = await request.executor(context);
      const endedAt = now();
      trajectorySeq += 1;
      return {
        id: 'traj-' + String(trajectorySeq),
        sessionId: request.sessionId,
        branchId,
        branchNamespace: 'mock',
        role: request.role ?? 'candidate',
        status: result.status ?? 'succeeded',
        patchId: request.patch.id,
        patchOrigin: request.patch.origin,
        surfaceKeys: Object.keys(request.patch.edits) as HarnessComponentKey[],
        ...(request.treeId === undefined ? {} : { treeId: request.treeId }),
        ...(request.nodeId === undefined ? {} : { nodeId: request.nodeId }),
        ...(request.referenceTrajectoryId === undefined
          ? {}
          : { referenceTrajectoryId: request.referenceTrajectoryId }),
        startedAt,
        endedAt,
        metrics: {
          steps: result.steps?.length ?? 0,
          toolCalls: 0,
          toolErrors: result.toolErrors?.length ?? 0,
          durationMs: Math.max(0, endedAt - startedAt)
        },
        steps: result.steps ?? [],
        toolErrors: result.toolErrors ?? [],
        failureSignals: result.failureSignals ?? [],
        memoryRecallIds: request.memoryRecallIds ?? []
      };
    },
    async applyPermanentPatch(patch): Promise<SurfacePatchDisposer> {
      return {
        patchId: patch.id,
        active: true,
        dispose: async () => undefined
      };
    },
    listActiveBranches: () => [],
    dispose: async () => undefined
  };
  return { seams, calls };
}

const POLICY: MetaSearchPolicy = {
  id: 'mock-policy',
  version: 1,
  createdAt: 0,
  maxWidth: 4,
  maxDepth: 1,
  slotWeights: {
    exploit: 0.25,
    explore_domain: 0.25,
    explore_invariant: 0.25,
    recover: 0.25
  },
  earlyStopThreshold: 0.8,
  minMemoryConfidenceForSkip: 0.9
};

/**
 * Policy that schedules exactly one slot per requested slotIndex, but returns
 * them in the supplied (possibly scrambled) array order to prove the orchestrator
 * orders by slotIndex rather than by array position.
 */
function makePolicy(slotIndexes: readonly number[], budget: number): IActivePolicy {
  return {
    policy: POLICY,
    planGrid: (): SearchGridPlan => ({
      maxWidth: POLICY.maxWidth,
      maxDepth: 1,
      budget,
      skipProbing: false,
      stopCondition: 'max_depth',
      complexity: 'moderate',
      rationale: 'mock grid plan',
      policyId: POLICY.id
    }),
    selectBatch: (request: SelectBatchRequest): BatchPlan => {
      const slots: BatchSlotPlan[] = slotIndexes.map((slotIndex) => ({
        slot: 'explore_domain',
        slotIndex,
        branchId: 'branch-' + String(slotIndex),
        parentNodeId: request.tree.rootId,
        origin: 'domain',
        guidance: 'memory',
        focusSurfaces: ['guardrails'],
        rationale: 'mock slot ' + String(slotIndex)
      }));
      return {
        round: request.round,
        grid: request.grid,
        policyId: POLICY.id,
        width: slots.length,
        slots,
        createdAt: 0
      };
    },
    update: () => undefined
  };
}

function makeProposer(
  now: () => number,
  proposedSlotIndexes: number[]
): IHarnessProposer {
  return {
    async propose(request: ProposeRequest): Promise<ProposedPatch> {
      const slotIndex = request.slot.slotIndex;
      proposedSlotIndexes.push(slotIndex);
      return {
        patch: {
          id: 'patch-slot-' + String(slotIndex),
          sessionId: request.sessionId,
          branchId: request.slot.branchId,
          origin: request.slot.origin,
          purpose: 'explore',
          guidance: request.slot.guidance,
          label: 'slot-' + String(slotIndex),
          rationale: 'mock proposal for slot ' + String(slotIndex),
          edits: {
            guardrails: { kind: 'guardrails', appendRules: ['rule-' + String(slotIndex)] }
          },
          createdAt: now()
        },
        rationale: 'mock proposal',
        focusSurfaces: request.slot.focusSurfaces,
        confidence: 0.7,
        expectedStepsDelta: -1
      };
    }
  };
}

function makeComposer(): IHarnessComposer {
  return {
    async compose(request): Promise<CompositionResult> {
      const winner =
        request.candidates.find((candidate) => candidate.trajectory.status === 'succeeded') ??
        null;
      const adoptionRatios: Record<string, number> = {};
      for (const candidate of request.candidates) {
        adoptionRatios[candidate.nodeId] = candidate.nodeId === winner?.nodeId ? 1 : 0.4;
      }
      return {
        selectedBranchId: winner?.branchId ?? null,
        selectedNodeId: winner?.nodeId ?? null,
        selectedTrajectoryId: winner?.trajectory.id ?? null,
        selectedPatch: winner?.patch ?? null,
        composedPatch: winner?.patch ?? null,
        assessments: request.candidates.map((candidate) => ({
          alias: 'candidate_' + candidate.nodeId,
          branchId: candidate.branchId,
          nodeId: candidate.nodeId,
          selected: candidate.nodeId === winner?.nodeId,
          adoptionRatio: candidate.nodeId === winner?.nodeId ? 1 : 0.4,
          contrasts: [],
          rationale: 'mock assessment'
        })),
        adoptionRatios,
        rationale: 'mock composition',
        evaluatedAt: 0
      };
    }
  };
}

function makeScorer(now: () => number): ISurrogateScorer {
  return {
    score(request: SurrogateScoreRequest) {
      const succeeded =
        request.node.status === 'succeeded' && request.trajectory.status === 'succeeded';
      return {
        nodeId: request.node.id,
        score: succeeded ? 0.9 : 0.2,
        signals: {
          selected: request.composition !== undefined && succeeded,
          adoptionRatio: request.composition === undefined ? 0 : succeeded ? 1 : 0.4,
          stepEfficiency: 1,
          toolErrorRate: 0
        },
        weights: request.weights,
        computedAt: now(),
        evidence: ['mock score']
      };
    }
  };
}

const NO_FAILURE: FailureDiagnosis = {
  category: 'none',
  confidence: 0.9,
  repairable: false,
  recommendedAction: 'deepen',
  evidence: ['mock taxonomy'],
  signals: []
};

function makeReflector(): IHarnessReflector {
  return {
    async reflect() {
      return { lessons: [], positiveCount: 0, negativeCount: 0, diagnostics: [] };
    }
  };
}

function makeDreamer(): IOfflineDreamer {
  return {
    async replay(): Promise<DreamReplayReport> {
      throw new Error('offline dreaming must not run in these tests');
    }
  };
}

interface HarnessOptions {
  readonly slotIndexes: readonly number[];
  readonly maxConcurrentProbes: number;
  readonly maxOnlineRolloutBudget?: number;
  readonly planBudget: number;
  readonly runBranch: BranchExecutor;
}

interface Harness {
  readonly orchestrator: EvoHarnessOrchestrator;
  readonly events: EvoHarnessStageEvent[];
  readonly proposedSlotIndexes: number[];
  readonly recordProbeOrder: string[];
  readonly memoryStats: MemoryStats;
  readonly seamCalls: SeamProbeCall[];
  readonly treePool: ReturnType<typeof createDiscoveryTreePool>;
}

function makeHarness(options: HarnessOptions): Harness {
  const now = makeClock();
  const events: EvoHarnessStageEvent[] = [];
  const proposedSlotIndexes: number[] = [];
  const recordProbeOrder: string[] = [];
  const memory = makeMemoryBridge();
  const { seams, calls } = makeSeams(now);
  const treePool = createDiscoveryTreePool();
  const { runBranch, ...rest } = options;

  const createTree = (treeOptions: DiscoveryTreeOptions): DiscoveryTree => {
    const tree = createDiscoveryTree(treeOptions);
    return new Proxy(tree, {
      get(target, property) {
        if (property === 'recordProbe') {
          return (nodeId: string, record: ProbeNodeRecord): DiscoveryNode => {
            recordProbeOrder.push(nodeId);
            return target.recordProbe(nodeId, record);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  };

  const config = parseEvoHarnessConfig({
    triggerMode: 'always',
    probe: {
      maxConcurrentProbes: options.maxConcurrentProbes,
      probeTimeoutMs: 5_000
    },
    dreamRsi: {
      maxOnlineRolloutBudget: options.maxOnlineRolloutBudget ?? 8,
      maxWidth: 4,
      maxDepth: 1,
      offlineDreamTriggerEveryNTasks: 100,
      candidatePoliciesCount: 2
    },
    logging: { level: 'silent' }
  });

  const deps: EvoHarnessOrchestratorDeps = {
    config,
    memory: memory.bridge,
    seams,
    policy: makePolicy(rest.slotIndexes, rest.planBudget),
    proposer: makeProposer(now, proposedSlotIndexes),
    composer: makeComposer(),
    reflector: makeReflector(),
    scorer: makeScorer(now),
    taxonomy: { diagnose: () => NO_FAILURE },
    dreamer: makeDreamer(),
    treePool,
    runBranch,
    now,
    newId: makeIdFactory('mock-id'),
    createTree,
    applyWinningPatch: false,
    onStage: (event) => events.push(event)
  };
  return {
    orchestrator: createEvoHarnessOrchestrator(deps),
    events,
    proposedSlotIndexes,
    recordProbeOrder,
    memoryStats: memory.stats,
    seamCalls: calls,
    treePool
  };
}

function referenceResult(): ProbeExecutionResult {
  return {
    status: 'failed',
    steps: [{ index: 0, at: 0, kind: 'error', text: 'baseline failed' }],
    toolErrors: [],
    failureSignals: [{ kind: 'tool_error', message: 'baseline failed', repairable: true }]
  };
}

function succeededResult(now: () => number): ProbeExecutionResult {
  return {
    status: 'succeeded',
    steps: [{ index: 0, at: now(), kind: 'message', text: 'recovered' }],
    deliverable: { content: 'recovered', format: 'text' },
    toolErrors: [],
    failureSignals: []
  };
}

function isReferenceRun(context: IsolatedBranchContext): boolean {
  return context.patch.purpose === 'initial' && Object.keys(context.patch.edits).length === 0;
}

/** Event node ids for one stage, in emission order. */
function nodeIdsFor(events: readonly EvoHarnessStageEvent[], stage: string): string[] {
  return events
    .filter((event) => event.stage === stage)
    .map((event) => {
      // Stage calls pass { round, detail: { nodeId } }, so nodeId is nested one
      // level below the event payload; accept a flat payload as well.
      const payload = event.detail;
      const nested = payload?.['detail'];
      const nodeId =
        nested !== null && typeof nested === 'object'
          ? (nested as Record<string, unknown>)['nodeId']
          : payload?.['nodeId'];
      return String(nodeId ?? '');
    });
}

function firstIndex(trace: readonly string[], stage: string): number {
  return trace.indexOf(stage);
}

const TASK = { id: 'task-concurrency', prompt: 'concurrent probe batch' } as const;

describe('orchestrator concurrent probe wave', () => {
  it('runs 4 slow slots in parallel and commits tree writes and trace in slotIndex order', async () => {
    let active = 0;
    let maxActive = 0;
    const candidateExecutions: string[] = [];
    const now = makeClock();
    const runBranch: BranchExecutor = async (context) => {
      if (isReferenceRun(context)) {
        return referenceResult();
      }
      active += 1;
      maxActive = Math.max(maxActive, active);
      candidateExecutions.push(context.branchId);
      try {
        // ~100ms per slot: serial would take >= 400ms, concurrency 4 ~= 100ms.
        await delay(100);
        return succeededResult(now);
      } finally {
        active -= 1;
      }
    };

    const harness = makeHarness({
      // Scrambled plan array; slotIndex remains the commit key.
      slotIndexes: [2, 0, 3, 1],
      maxConcurrentProbes: 4,
      planBudget: 8,
      runBranch
    });

    const startedAt = Date.now();
    const result = await harness.orchestrator.run({
      sessionId: 'session-concurrency',
      task: TASK,
      trigger: 'always'
    });
    const elapsedMs = Date.now() - startedAt;

    // 1. real overlap: 4 probes of ~100ms complete well under the 200ms bar.
    expect(result.outcome).toBe('composed');
    expect(candidateExecutions).toHaveLength(4);
    expect(maxActive).toBe(4);
    expect(elapsedMs).toBeLessThan(200);
    expect(result.probesRun).toBe(5); // reference anchor + 4 candidates

    // 2. admission/proposals follow slotIndex, not the scrambled array order.
    expect(harness.proposedSlotIndexes).toEqual([0, 1, 2, 3]);

    // 3. tree writes, classify/score trace and the probe trace all follow the
    //    tree's own child order, which is slotIndex order.
    const tree = harness.treePool.list()[0];
    expect(tree).toBeDefined();
    const root = tree?.nodes[tree.rootId];
    expect(root?.childIds).toHaveLength(4);
    const childOrder = [...(root?.childIds ?? [])];
    expect(nodeIdsFor(harness.events, 'probe')).toEqual(childOrder);
    expect(nodeIdsFor(harness.events, 'classify')).toEqual(childOrder);
    expect(nodeIdsFor(harness.events, 'score')).toEqual(childOrder);
    expect(harness.recordProbeOrder).toEqual([tree?.rootId, ...childOrder]);

    // 4. lifecycle stages keep their documented relative order.
    const trace = [...harness.orchestrator.lastTrace()];
    expect(firstIndex(trace, 'propose')).toBeGreaterThanOrEqual(0);
    expect(firstIndex(trace, 'probe')).toBeGreaterThan(firstIndex(trace, 'propose'));
    expect(firstIndex(trace, 'classify')).toBeGreaterThan(firstIndex(trace, 'probe'));
    expect(firstIndex(trace, 'score')).toBeGreaterThan(firstIndex(trace, 'classify'));
    expect(firstIndex(trace, 'compose')).toBeGreaterThan(firstIndex(trace, 'score'));
  });

  it('caps active probes at config.probe.maxConcurrentProbes', async () => {
    let active = 0;
    let maxActive = 0;
    const now = makeClock();
    const runBranch: BranchExecutor = async (context) => {
      if (isReferenceRun(context)) {
        return referenceResult();
      }
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await delay(40);
        return succeededResult(now);
      } finally {
        active -= 1;
      }
    };

    const harness = makeHarness({
      slotIndexes: [0, 1, 2, 3],
      maxConcurrentProbes: 2,
      planBudget: 8,
      runBranch
    });

    const startedAt = Date.now();
    const result = await harness.orchestrator.run({
      sessionId: 'session-cap',
      task: TASK,
      trigger: 'always'
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.outcome).toBe('composed');
    expect(result.probesRun).toBe(5);
    expect(maxActive).toBe(2);
    // two waves of 40ms cannot finish in one wave's time
    expect(elapsedMs).toBeGreaterThanOrEqual(70);
    const tree = harness.treePool.list()[0];
    expect(tree?.nodes[tree.rootId]?.childIds).toHaveLength(4);
  });

  it('fails a concurrent wave only after peers settle and rolls back the failed budget', async () => {
    let active = 0;
    let maxActive = 0;
    const candidateExecutions: string[] = [];
    const now = makeClock();
    const runBranch: BranchExecutor = async (context) => {
      if (isReferenceRun(context)) {
        return referenceResult();
      }
      active += 1;
      maxActive = Math.max(maxActive, active);
      candidateExecutions.push(context.branchId);
      try {
        if (context.branchId === 'branch-1') {
          await delay(20);
          throw new Error('probe exploded');
        }
        await delay(50);
        return succeededResult(now);
      } finally {
        active -= 1;
      }
    };

    const harness = makeHarness({
      slotIndexes: [0, 1, 2, 3],
      maxConcurrentProbes: 4,
      planBudget: 8,
      runBranch
    });

    const result = await harness.orchestrator.run({
      sessionId: 'session-failure',
      task: TASK,
      trigger: 'always'
    });

    // The rejection fails the run as the serial loop did ...
    expect(result.outcome).toBe('failed');
    expect(result.failure?.message).toContain('probe exploded');
    expect(result.diagnostics.join(' ')).toContain('lifecycle failed');
    // ... but every already-started peer was awaited (all 4 candidates ran).
    expect(maxActive).toBe(4);
    expect(candidateExecutions).toHaveLength(4);
    // Serial budget accounting: only probes before the first failure are charged;
    // the failing probe and later completed reservations are rolled back.
    expect(result.probesRun).toBe(2); // reference anchor + slot 0
    // Branch isolation handles were released even on the failure path.
    expect(harness.memoryStats.isolated).toBe(4);
    expect(harness.memoryStats.released).toBe(4);
    // A failed run retains no completed tree.
    expect(harness.treePool.size()).toBe(0);
  });

  it('launches no more probes than the remaining rollout budget', async () => {
    let maxActive = 0;
    let active = 0;
    const candidateExecutions: string[] = [];
    const now = makeClock();
    const runBranch: BranchExecutor = async (context) => {
      if (isReferenceRun(context)) {
        return referenceResult();
      }
      active += 1;
      maxActive = Math.max(maxActive, active);
      candidateExecutions.push(context.branchId);
      try {
        await delay(20);
        return succeededResult(now);
      } finally {
        active -= 1;
      }
    };

    const harness = makeHarness({
      slotIndexes: [0, 1, 2, 3],
      maxConcurrentProbes: 4,
      // the frozen config clamps plan_grid's budget down to 2 candidate rollouts
      maxOnlineRolloutBudget: 2,
      planBudget: 4,
      runBranch
    });

    const result = await harness.orchestrator.run({
      sessionId: 'session-budget',
      task: TASK,
      trigger: 'always'
    });

    expect(result.metadata?.stopReason).toBe('budget_exhausted');
    expect(result.probesRun).toBe(3); // reference anchor + 2 admitted candidates
    expect(harness.proposedSlotIndexes).toEqual([0, 1]);
    expect(candidateExecutions).toHaveLength(2);
    expect(maxActive).toBe(2);
    const tree = harness.treePool.list()[0];
    expect(tree?.nodes[tree.rootId]?.childIds).toHaveLength(2);
  });
});
