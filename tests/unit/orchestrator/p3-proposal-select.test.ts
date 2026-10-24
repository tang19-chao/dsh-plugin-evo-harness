/**
 * P3-D: jit_proposal_select + evaluate_steps/record_experience.
 *
 * Acceptance from the task brief:
 *  - K = 3 with memory favouring candidate 2 => candidate 2 is selected and
 *    exactly ONE probe runs (the probe budget never scales with K);
 *  - K = 1 => no 'jit_proposal_select' stage and a single probe;
 *  - JitRL disabled => no stage is emitted and no record is written;
 *  - enabled => the store grows by 1 L1 + 1 L2 sample per round;
 *  - 'evaluate_steps' runs after 'reflect'; since P6.1-D every record's return
 *    is the trajectory-signal score of the executed probe (the winner's step
 *    vector rides along as the auxiliary rewardSources.stepJudge entry);
 *  - the 18-stage order is the documented one.
 */
import { describe, expect, it } from 'vitest';
import { createEvoHarnessOrchestrator } from '../../../src/orchestrator';
import type {
  EvoHarnessOrchestrator,
  EvoHarnessOrchestratorDeps,
  EvoHarnessStageEvent,
  OrchestratorJitRl
} from '../../../src/orchestrator';
import { EVO_HARNESS_STAGES } from '../../../src/orchestrator';
import { createDefaultConfig, parseEvoHarnessConfig } from '../../../src/config';
import { createDiscoveryTreePool } from '../../../src/dream-rsi';
import {
  createMemoryExperienceStore,
  createStoreOptimizer,
  normalizePatchSignature,
  verbalizedLogit
} from '../../../src/jitrl';
import { abstractProposalState } from '../../../src/jitrl/state-abstraction';
import { createJitActivePolicy, slotKindOfActionKey } from '../../../src/jitrl/jit-active-policy';
import {
  CURRENT_REWARD_VERSION,
  EXPERIENCE_SCHEMA_VERSION
} from '../../../src/jitrl/experience-store';
import { scoreUnderRewardContract } from '../../../src/jitrl/reward-contract';
import type { LessonPatchSource } from '../../../src/jitrl/candidate-augmenter';
import type {
  BatchPlan,
  BatchSlotKind,
  BatchSlotPlan,
  BranchExecutor,
  CanonicalLesson,
  CompositionResult,
  EightSurfacePatch,
  FailureDiagnosis,
  GuidanceMode,
  IActivePolicy,
  ICordisSeamManager,
  IHarnessComposer,
  IHarnessProposer,
  IHarnessReflector,
  IMemoryBridge,
  IOfflineDreamer,
  IStepEvaluator,
  ISurrogateScorer,
  IsolatedBranchContext,
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
  ProposedPatchSet,
  SearchGridPlan,
  SelectBatchRequest,
  StepReward,
  SurfacePatchDisposer,
  SurrogateScoreRequest
} from '../../../src/types/contracts';
import type { HarnessComponentKey } from '../../../src/types/contracts';

// ---------------------------------------------------------------------------
// deterministic primitives
// ---------------------------------------------------------------------------

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

const POLICY: MetaSearchPolicy = {
  id: 'p3-policy',
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

const TASK = { id: 'task-p3-select', prompt: 'select one of K proposals' } as const;

const RECALL_CONFIDENCE = 0.2;

function makeRecall(query: { readonly scope: MemoryScope }): MemoryRecallResult {
  return {
    query: query as never,
    scope: query.scope,
    driverKind: 'vector_fact',
    lessons: [],
    positiveLessons: [],
    negativeLessons: [],
    suppressedLessons: [],
    confidence: RECALL_CONFIDENCE,
    degraded: false,
    diagnostics: [],
    recalledAt: 0
  } as unknown as MemoryRecallResult;
}

function makeMemoryBridge(): IMemoryBridge {
  const descriptor = {
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
  } as unknown as IMemoryBridge['descriptor'];
  const commitResult = (lesson: CanonicalLesson): never =>
    ({
      accepted: true,
      persisted: true,
      lessonId: lesson.id,
      namespace: 'mock',
      driverKind: 'vector_fact',
      violations: [],
      at: 0
    }) as never;
  return {
    descriptor,
    initialize: async () => descriptor,
    recall: async (query: MemoryRecallQuery) => makeRecall(query as { scope: MemoryScope }),
    commit: async (lesson: CanonicalLesson) => commitResult(lesson),
    isolate: async (scope: MemoryScope): Promise<MemoryIsolationHandle> =>
      ({
        scope,
        namespace: 'mock-branch',
        active: true,
        release: async () => undefined
      }) as unknown as MemoryIsolationHandle,
    promote: async (lesson: CanonicalLesson) => commitResult(lesson),
    prune: async () => ({ scanned: 0, removedIds: [], dryRun: false }),
    dispose: async () => undefined
  } as unknown as IMemoryBridge;
}

function makeSeams(now: () => number, probes: string[]): ICordisSeamManager {
  let trajectorySeq = 0;
  return {
    async runInIsolatedBranch(request: ProbeBranchRequest): Promise<ProbeTrajectory> {
      probes.push(request.patch.id);
      const branchId = request.branchId ?? 'branch';
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
      } as ProbeTrajectory;
    },
    async applyPermanentPatch(patch: EightSurfacePatch): Promise<SurfacePatchDisposer> {
      return { patchId: patch.id, active: true, dispose: async () => undefined };
    },
    listActiveBranches: () => [],
    dispose: async () => undefined
  } as unknown as ICordisSeamManager;
}

/** Minimal trajectory for scoreTrajectorySignals with the executed shape filled in. */
function makeMinimalTrajectory(): ProbeTrajectory {
  return {
    id: 'traj-executed-shape',
    sessionId: 'session-p3',
    branchId: 'branch-0',
    branchNamespace: 'mock',
    role: 'candidate',
    status: 'succeeded',
    patchId: 'patch-k1',
    patchOrigin: 'domain',
    surfaceKeys: ['guardrails'],
    startedAt: 0,
    endedAt: 10,
    metrics: { steps: 1, toolCalls: 0, toolErrors: 0, durationMs: 10 },
    steps: [],
    toolErrors: [],
    failureSignals: [],
    memoryRecallIds: []
  } as ProbeTrajectory;
}

/** Slot the mock policy schedules; guidance decides the recorded provenance. */
interface MockSlotSpec {
  readonly kind: BatchSlotKind;
  readonly guidance: GuidanceMode;
}

const DEFAULT_SLOTS: readonly MockSlotSpec[] = [
  { kind: 'explore_domain', guidance: 'memory' }
];

function makePolicy(options: {
  readonly slots?: readonly MockSlotSpec[];
  readonly maxDepth?: number;
} = {}): IActivePolicy {
  const slots = options.slots ?? DEFAULT_SLOTS;
  return {
    policy: POLICY,
    planGrid: (): SearchGridPlan => ({
      maxWidth: POLICY.maxWidth,
      maxDepth: options.maxDepth ?? 1,
      budget: 8,
      skipProbing: false,
      stopCondition: 'max_depth',
      complexity: 'moderate',
      rationale: 'mock grid plan',
      policyId: POLICY.id
    }),
    selectBatch: (request: SelectBatchRequest): BatchPlan => {
      const planned: BatchSlotPlan[] = slots.map((spec, slotIndex) => ({
        slot: spec.kind,
        slotIndex,
        branchId: 'branch-' + String(slotIndex),
        parentNodeId: request.tree.rootId,
        origin: spec.kind === 'explore_invariant' ? 'invariant' : 'domain',
        guidance: spec.guidance,
        focusSurfaces: ['guardrails'],
        rationale: 'mock slot ' + spec.kind
      }));
      return {
        round: request.round,
        grid: request.grid,
        policyId: POLICY.id,
        width: planned.length,
        slots: planned,
        createdAt: 0
      };
    },
    update: () => undefined
  };
}

/**
 * Three STRUCTURALLY distinct patches.
 *
 * normalizePatchSignature deliberately encodes only edit structure (never the
 * rule text), so two candidates that differ only in payload collapse to the same
 * action key. Distinct shapes are what give the L2 selector three real options:
 *  - 'guardrails-1': one appended rule
 *  - 'guardrails-2': two appended rules (different structural count)
 *  - 'system-prompt': a different surface entirely
 */
function patchVariant(id: string, shape: 'guardrails-1' | 'guardrails-2' | 'system-prompt', now: () => number): EightSurfacePatch {
  const edits =
    shape === 'guardrails-1'
      ? { guardrails: { kind: 'guardrails', appendRules: ['rule-' + id] } }
      : shape === 'guardrails-2'
        ? { guardrails: { kind: 'guardrails', appendRules: ['rule-' + id, 'rule-' + id + '-b'] } }
        : { system_prompt: { kind: 'system_prompt', mode: 'append', content: 'prompt-' + id } };
  return {
    id,
    sessionId: 'session-p3',
    branchId: 'branch-0',
    origin: 'domain',
    purpose: 'explore',
    guidance: 'memory',
    label: id,
    rationale: 'mock proposal ' + id,
    edits,
    createdAt: now()
  } as unknown as EightSurfacePatch;
}

interface CountingProposer extends IHarnessProposer {
  readonly proposeCalls: number;
  readonly candidateCalls: number;
  readonly requests: readonly ProposeRequest[];
}

function makeProposer(
  now: () => number,
  candidatesPerCall: number
): { readonly proposer: CountingProposer; readonly patches: readonly EightSurfacePatch[] } {
  const patches = [
    patchVariant('patch-k1', 'guardrails-1', now),
    patchVariant('patch-k2', 'guardrails-2', now),
    patchVariant('patch-k3', 'system-prompt', now)
  ];
  const requests: ProposeRequest[] = [];
  const state = { propose: 0, candidate: 0 };
  const proposer: CountingProposer = {
    get proposeCalls() {
      return state.propose;
    },
    get candidateCalls() {
      return state.candidate;
    },
    get requests() {
      return requests;
    },
    async propose(request: ProposeRequest): Promise<ProposedPatch> {
      state.propose += 1;
      requests.push(request);
      return {
        patch: patches[0] as EightSurfacePatch,
        rationale: 'single proposal',
        focusSurfaces: request.slot.focusSurfaces,
        confidence: 0.6,
        expectedStepsDelta: -1
      };
    },
    async proposeCandidates(request: ProposeRequest): Promise<ProposedPatchSet> {
      state.candidate += 1;
      requests.push(request);
      return {
        candidates: patches.slice(0, candidatesPerCall).map((patch, index) => ({
          patch,
          rationale: 'candidate ' + String(index),
          focusSurfaces: request.slot.focusSurfaces,
          confidence: [0.9, 0.6, 0.4][index] ?? 0.4,
          expectedStepsDelta: -1
        }))
      };
    }
  };
  return { proposer, patches };
}

function makeComposer(): IHarnessComposer {
  return {
    async compose(request): Promise<CompositionResult> {
      const winner =
        request.candidates.find((candidate) => candidate.trajectory.status === 'succeeded') ?? null;
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
      } as unknown as CompositionResult;
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
      } as unknown as ReturnType<ISurrogateScorer['score']>;
    }
  };
}

function makeReflector(): IHarnessReflector {
  return {
    async reflect() {
      return { lessons: [], positiveCount: 0, negativeCount: 0, diagnostics: [] };
    }
  } as unknown as IHarnessReflector;
}

function makeDreamer(): IOfflineDreamer {
  return {
    async replay() {
      throw new Error('offline dreaming must not run in these tests');
    }
  } as unknown as IOfflineDreamer;
}

const NO_FAILURE: FailureDiagnosis = {
  category: 'none',
  confidence: 0.9,
  repairable: false,
  recommendedAction: 'deepen',
  evidence: ['mock taxonomy'],
  signals: []
};

/** Step evaluator with a fixed, hand-checkable reward vector. */
function makeStepEvaluator(rewards: readonly number[], calls: ProbeTrajectory[]): IStepEvaluator {
  return {
    async evaluate(trajectory: ProbeTrajectory): Promise<readonly StepReward[]> {
      calls.push(trajectory);
      return rewards.map((reward, index) => ({
        stepIndex: index,
        reward,
        sources: { surrogate: reward, tool: 0 }
      }));
    }
  } as IStepEvaluator;
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

interface HarnessOptions {
  readonly candidatesPerCall?: number;
  readonly jitrl?: {
    readonly enabled: boolean;
    readonly levels: readonly ('meta' | 'proposal' | 'host_tool')[];
    readonly candidateCount: number;
  };
  readonly stepRewards?: readonly number[];
  readonly seedForCandidate?: number;
  /** Slots the mock policy schedules (guidance drives recorded provenance). */
  readonly slots?: readonly MockSlotSpec[];
  /** Rounds the plan allows; > 1 lets a second L1 decision observe round 1. */
  readonly maxDepth?: number;
  readonly maxOnlineRolloutBudget?: number;
  /**
   * Wrap the policy in the real L1 decorator. Needed by the t25 tests: they must
   * observe how a recorded sample lands in a later decision's support.
   */
  readonly withDecorator?: boolean;
  /** t30: test-only lesson source so the augmentation path can actually augment. */
  readonly lessonSource?: LessonPatchSource;
  /** t30: config augmentFromMemory override (false disables augmentation). */
  readonly augmentFromMemory?: boolean;
  readonly minSupportForStrongPrior?: number;
}

interface Harness {
  readonly orchestrator: EvoHarnessOrchestrator;
  readonly events: EvoHarnessStageEvent[];
  readonly proposer: CountingProposer;
  readonly patches: readonly EightSurfacePatch[];
  readonly probes: string[];
  readonly store: ReturnType<typeof createMemoryExperienceStore>;
  readonly evaluatorCalls: ProbeTrajectory[];
  readonly deps: EvoHarnessOrchestratorDeps;
  /** t30: diagnostics the orchestrator emitted on the last run (per run). */
  readonly runDiagnostics: readonly (readonly string[])[];
  /** t30: stages the augmenter reported, captured from orchestrator diagnostics. */
  readonly augmentNotices: readonly string[];
  /** L1 decisions the decorator recorded, in call order (empty without it). */
  readonly jitDecisions: readonly { readonly adjustments: readonly { readonly actionKey: string; readonly support: number }[] }[];
  readonly decorator: { readonly decisions: readonly unknown[] } | undefined;
}

const CLOCK_START = 1_700_000_000_000;

function makeHarness(options: HarnessOptions = {}): Harness {
  const now = makeClock(CLOCK_START);
  const events: EvoHarnessStageEvent[] = [];
  const probes: string[] = [];
  const evaluatorCalls: ProbeTrajectory[] = [];
  const defaults = createDefaultConfig();
  const jitrlConfig = options.jitrl ?? {
    enabled: true,
    levels: ['meta', 'proposal'] as const,
    candidateCount: 3
  };

  const resolvedDepth = options.maxDepth ?? 1;
  const config = parseEvoHarnessConfig({
    triggerMode: 'always',
    probe: { maxConcurrentProbes: 1, probeTimeoutMs: 5_000 },
    dreamRsi: {
      maxOnlineRolloutBudget: options.maxOnlineRolloutBudget ?? 4,
      maxWidth: 2,
      maxDepth: resolvedDepth,
      offlineDreamTriggerEveryNTasks: 100,
      candidatePoliciesCount: 2
    },
    logging: { level: 'silent' }
  });

  const { proposer, patches } = makeProposer(now, options.candidatesPerCall ?? 3);
  const store = createMemoryExperienceStore({ now, halfLifeMs: 1_000_000_000 });
  const optimizer = createStoreOptimizer({
    store,
    config: defaults.jitrl,
    halfLifeMs: 1_000_000_000,
    now,
    rng: () => 0.5
  });
  const jitSurface: OrchestratorJitRl = {
    store,
    optimizer,
    stepEvaluator: makeStepEvaluator(options.stepRewards ?? [1, 2], evaluatorCalls),
    config: {
      enabled: jitrlConfig.enabled,
      levels: [...jitrlConfig.levels],
      gamma: defaults.jitrl.gamma,
      candidateCount: jitrlConfig.candidateCount,
      k: defaults.jitrl.k,
      similarityThreshold: defaults.jitrl.similarityThreshold,
      augmentFromMemory: options.augmentFromMemory ?? defaults.jitrl.augmentFromMemory,
      minSupportForStrongPrior:
        options.minSupportForStrongPrior ?? defaults.jitrl.minSupportForStrongPrior
    },
    ...(options.lessonSource === undefined ? {} : { lessonSource: options.lessonSource })
  };

  const runBranch: BranchExecutor = async (context) => {
    const patch = context.patch as EightSurfacePatch;
    const reference = Object.keys(patch.edits).length === 0;
    if (reference) {
      return {
        status: 'failed',
        steps: [{ index: 0, at: now(), kind: 'error', text: 'baseline failed' }],
        toolErrors: [],
        failureSignals: [{ kind: 'tool_error', message: 'baseline failed', repairable: true }]
      } as unknown as ProbeExecutionResult;
    }
    return {
      status: 'succeeded',
      steps: [{ index: 0, at: now(), kind: 'message', text: 'recovered' }],
      deliverable: { content: 'recovered', format: 'text' },
      toolErrors: [],
      failureSignals: []
    } as unknown as ProbeExecutionResult;
  };

  const basePolicy = makePolicy({
    ...(options.slots === undefined ? {} : { slots: options.slots }),
    maxDepth: resolvedDepth
  });
  // t25: the real L1 decorator reads the live store snapshot, so a sample this
  // run records is visible to the next round's decision.
  const decorator =
    options.withDecorator === true
      ? createJitActivePolicy({
          inner: basePolicy,
          experiences: () => store.snapshot(),
          now,
          config: {
            beta: defaults.jitrl.beta,
            k: defaults.jitrl.k,
            similarityThreshold: defaults.jitrl.similarityThreshold,
            selection: defaults.jitrl.selection,
            lambda: defaults.jitrl.exploration.lambda,
            alpha: defaults.jitrl.exploration.alpha,
            unseenFallback: defaults.jitrl.unseenFallback,
            halfLifeMs: 1_000_000_000
          }
        })
      : undefined;

  const deps: EvoHarnessOrchestratorDeps = {
    config,
    memory: makeMemoryBridge(),
    seams: makeSeams(now, probes),
    policy: decorator ?? basePolicy,
    proposer,
    composer: makeComposer(),
    reflector: makeReflector(),
    scorer: makeScorer(now),
    taxonomy: { diagnose: () => NO_FAILURE },
    dreamer: makeDreamer(),
    treePool: createDiscoveryTreePool(),
    runBranch,
    now,
    newId: makeIdFactory('p3'),
    applyWinningPatch: false,
    jitrl: jitSurface,
    onStage: (event) => events.push(event)
  };

  const capturedDiagnostics: string[][] = [];
  const inner = createEvoHarnessOrchestrator(deps);
  // Wrap run() so every test can read the diagnostics the orchestrator produced
  // (the augmentation notices live there, not on the run result's metadata).
  const orchestrator = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'run') {
        return async (request: unknown): Promise<unknown> => {
          const result = await (target.run as (value: unknown) => Promise<unknown>)(request);
          const lines = (result as { diagnostics?: readonly string[] } | undefined)?.diagnostics;
          capturedDiagnostics.push(lines === undefined ? [] : [...lines]);
          return result;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    }
  }) as EvoHarnessOrchestrator;

  return {
    orchestrator,
    events,
    proposer,
    patches,
    probes,
    store,
    evaluatorCalls,
    deps,
    // Live getter: diagnostics belong to one run() result, so the tests read them
    // from the run they just awaited.
    get runDiagnostics(): readonly (readonly string[])[] {
      return capturedDiagnostics;
    },
    get augmentNotices(): readonly string[] {
      return capturedDiagnostics
        .flat()
        .filter((line) => line.startsWith('proposal augment:'));
    },
    // Live getter: the decorator's history is appended during run(), so a value
    // captured at construction would always be empty.
    get jitDecisions(): readonly {
      readonly adjustments: readonly { readonly actionKey: string; readonly support: number }[];
    }[] {
      return (decorator?.decisions ?? []) as readonly {
        readonly adjustments: readonly { readonly actionKey: string; readonly support: number }[];
      }[];
    },
    decorator: decorator as { readonly decisions: readonly unknown[] } | undefined
  };
}

function traceOf(events: readonly EvoHarnessStageEvent[]): string[] {
  return events.map((event) => event.stage);
}

function candidateProbes(probes: readonly string[]): string[] {
  return probes.filter((id) => !id.startsWith('patch-reference'));
}

// ---------------------------------------------------------------------------
// stage contract
// ---------------------------------------------------------------------------

describe('EVO_HARNESS_STAGES (19 stages)', () => {
  it('places the three new stages in the documented order', () => {
    // 16 pre-existing stages (the plan's 15 plus jit_meta_adjust from Phase 2)
    // plus the three Phase 3 stages.
    expect(EVO_HARNESS_STAGES).toHaveLength(19);
    const proposeAt = EVO_HARNESS_STAGES.indexOf('propose');
    expect(EVO_HARNESS_STAGES[proposeAt + 1]).toBe('jit_proposal_select');
    expect(EVO_HARNESS_STAGES[proposeAt + 2]).toBe('probe');
    const reflectAt = EVO_HARNESS_STAGES.indexOf('reflect');
    expect(EVO_HARNESS_STAGES[reflectAt + 1]).toBe('evaluate_steps');
    expect(EVO_HARNESS_STAGES[reflectAt + 2]).toBe('record_experience');
    expect(EVO_HARNESS_STAGES[reflectAt + 3]).toBe('commit');
  });
});

// ---------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------

describe('jit_proposal_select (K proposals, one probe)', () => {
  it('sends K candidates in one call, selects the memory-favoured one and probes once', async () => {
    const harness = makeHarness({ candidatesPerCall: 3 });
    const favored = harness.patches[1] as EightSurfacePatch;

    // Seed one proposal experience that matches the exact state the orchestrator
    // will derive, keyed to candidate 2 (index 1). Its return dominates, so the
    // argmax must pick it.
    const state = abstractProposalState({
      task: TASK as never,
      round: 1,
      parentDepth: 0,
      parentSlot: 'explore_domain',
      memoryConfidence: RECALL_CONFIDENCE,
      referenceStatus: 'failed',
      slot: 'explore_domain',
      guidance: 'memory'
    });
    // A CONTRAST, not a single hint: with unseenFallback 'baseline' an unobserved
    // action inherits the state value, so one positive neighbour would merely tie
    // with the other candidates and the prior logit would decide. A negative
    // neighbour for candidate 1 plus a positive one for candidate 2 makes memory
    // the decisive evidence. Timestamps are recent so half-life decay keeps them.
    await harness.store.append([
      {
        id: 'seed-proposal-1-negative',
        experienceSchemaVersion: EXPERIENCE_SCHEMA_VERSION,
        // P6.1-D2: a learning-facing seed carries the current reward contract
        // version so it survives the strict learning filter.
        rewardVersion: CURRENT_REWARD_VERSION,
        level: 'proposal',
        state,
        actionKey: normalizePatchSignature(harness.patches[0] as EightSurfacePatch),
        reward: -3,
        return: -3,
        rewardSources: { surrogate: 1 },
        guidance: 'memory',
        policyId: POLICY.id,
        sessionId: 'session-p3',
        treeId: 'tree-seed',
        createdAt: CLOCK_START,
        redacted: true
      },
      {
        id: 'seed-proposal-2-positive',
        experienceSchemaVersion: EXPERIENCE_SCHEMA_VERSION,
        rewardVersion: CURRENT_REWARD_VERSION,
        level: 'proposal',
        state,
        actionKey: normalizePatchSignature(favored as EightSurfacePatch),
        reward: 3,
        return: 3,
        rewardSources: { surrogate: 1 },
        guidance: 'memory',
        policyId: POLICY.id,
        sessionId: 'session-p3',
        treeId: 'tree-seed',
        createdAt: CLOCK_START,
        redacted: true
      }
    ]);

    const result = await harness.orchestrator.run({
      sessionId: 'session-p3',
      task: TASK as never,
      trigger: 'always'
    });
    void result;

    const trace = traceOf(harness.events);
    expect(trace).toContain('jit_proposal_select');
    // The stage is emitted after propose and before probe.
    const proposeAt = trace.indexOf('propose');
    const selectAt = trace.indexOf('jit_proposal_select');
    const probeAt = trace.indexOf('probe');
    expect(selectAt).toBeGreaterThan(proposeAt);
    expect(probeAt).toBeGreaterThan(selectAt);

    // Exactly ONE candidate probe: K candidates must not scale the probe budget.
    const chosen = candidateProbes(harness.probes);
    expect(chosen).toHaveLength(1);
    expect(chosen[0]).toBe(favored.id);
    // The multi-candidate path was used; propose() was never needed.
    expect(harness.proposer.candidateCalls).toBeGreaterThan(0);
    expect(harness.proposer.proposeCalls).toBe(0);
    expect(harness.proposer.requests[0]?.candidateCount).toBe(3);
  });

  it('records one L1 and one L2 sample per round with the chosen action key', async () => {
    const harness = makeHarness({ candidatesPerCall: 3 });
    const favored = harness.patches[1] as EightSurfacePatch;
    const state = abstractProposalState({
      task: TASK as never,
      round: 1,
      parentDepth: 0,
      parentSlot: 'explore_domain',
      memoryConfidence: RECALL_CONFIDENCE,
      referenceStatus: 'failed',
      slot: 'explore_domain',
      guidance: 'memory'
    });
    // A CONTRAST, not a single hint: with unseenFallback 'baseline' an unobserved
    // action inherits the state value, so one positive neighbour would merely tie
    // with the other candidates and the prior logit would decide. A negative
    // neighbour for candidate 1 and a positive one for candidate 2 make memory the
    // decisive evidence.
    await harness.store.append([
      {
        id: 'seed-proposal-1-negative',
        experienceSchemaVersion: EXPERIENCE_SCHEMA_VERSION,
        // P6.1-D2: a learning-facing seed carries the current reward contract
        // version so it survives the strict learning filter.
        rewardVersion: CURRENT_REWARD_VERSION,
        level: 'proposal',
        state,
        actionKey: normalizePatchSignature(harness.patches[0] as EightSurfacePatch),
        reward: -3,
        return: -3,
        rewardSources: { surrogate: 1 },
        guidance: 'memory',
        policyId: POLICY.id,
        sessionId: 'session-p3',
        treeId: 'tree-seed',
        createdAt: CLOCK_START,
        redacted: true
      },
      {
        id: 'seed-proposal-2-positive',
        experienceSchemaVersion: EXPERIENCE_SCHEMA_VERSION,
        rewardVersion: CURRENT_REWARD_VERSION,
        level: 'proposal',
        state,
        actionKey: normalizePatchSignature(favored as EightSurfacePatch),
        reward: 3,
        return: 3,
        rewardSources: { surrogate: 1 },
        guidance: 'memory',
        policyId: POLICY.id,
        sessionId: 'session-p3',
        treeId: 'tree-seed',
        createdAt: CLOCK_START,
        redacted: true
      }
    ]);

    await harness.orchestrator.run({
      sessionId: 'session-p3',
      task: TASK as never,
      trigger: 'always'
    });

    // 2 seeded (the contrast) + 1 L1 + 1 L2.
    expect(await harness.store.size()).toBe(4);
    expect(await harness.store.size('meta')).toBe(1);
    expect(await harness.store.size('proposal')).toBe(3);

    const online = harness.store
      .snapshot()
      .filter((record) => record.id.startsWith('online-'));
    const meta = online.filter((record) => record.level === 'meta');
    const proposal = online.filter((record) => record.level === 'proposal');
    expect(meta).toHaveLength(1);
    expect(proposal).toHaveLength(1);
    expect(proposal[0]?.actionKey).toBe(normalizePatchSignature(favored as EightSurfacePatch));
    expect(proposal[0]?.state.level).toBe('proposal');
    expect(proposal[0]?.redacted).toBe(true);
    // t25: the key follows the L1 candidate contract (normalizeMetaAction), not
    // the portfolio spelling that alignNeighbors would drop.
    expect(meta[0]?.actionKey.startsWith('slot:')).toBe(true);
    expect(slotKindOfActionKey(meta[0]?.actionKey ?? '')).toBeDefined();
  });

  it('reuses the single-candidate result instead of calling propose() again', async () => {
    const harness = makeHarness({ candidatesPerCall: 1 });
    await harness.orchestrator.run({
      sessionId: 'session-p3',
      task: TASK as never,
      trigger: 'always'
    });
    // K = 3 in config, but the proposer only produced one usable candidate: the
    // multi-candidate call is reused, so the model is never asked twice.
    expect(harness.proposer.candidateCalls).toBe(1);
    expect(harness.proposer.proposeCalls).toBe(0);
    expect(candidateProbes(harness.probes)).toHaveLength(1);
  });

  it('stays on propose() and emits no stage when candidateCount is 1', async () => {
    const harness = makeHarness({
      candidatesPerCall: 3,
      jitrl: { enabled: true, levels: ['meta', 'proposal'], candidateCount: 1 }
    });
    await harness.orchestrator.run({
      sessionId: 'session-p3',
      task: TASK as never,
      trigger: 'always'
    });
    expect(traceOf(harness.events)).not.toContain('jit_proposal_select');
    expect(harness.proposer.proposeCalls).toBe(1);
    expect(harness.proposer.candidateCalls).toBe(0);
    expect(candidateProbes(harness.probes)).toHaveLength(1);
  });

  it('is silent when the proposal level is not enabled', async () => {
    const harness = makeHarness({
      candidatesPerCall: 3,
      jitrl: { enabled: true, levels: ['meta'], candidateCount: 3 }
    });
    await harness.orchestrator.run({
      sessionId: 'session-p3',
      task: TASK as never,
      trigger: 'always'
    });
    expect(traceOf(harness.events)).not.toContain('jit_proposal_select');
    expect(harness.proposer.proposeCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// evaluate_steps + record_experience
// ---------------------------------------------------------------------------

describe('evaluate_steps and record_experience', () => {
  it('runs after reflect and writes the hand-computed discounted return', async () => {
    const rewards = [1, 2];
    const harness = makeHarness({ candidatesPerCall: 1, stepRewards: rewards });
    await harness.orchestrator.run({
      sessionId: 'session-p3',
      task: TASK as never,
      trigger: 'always'
    });

    const trace = traceOf(harness.events);
    const reflectAt = trace.indexOf('reflect');
    const evaluateAt = trace.indexOf('evaluate_steps');
    const recordAt = trace.indexOf('record_experience');
    const commitAt = trace.indexOf('commit');
    expect(reflectAt).toBeGreaterThanOrEqual(0);
    expect(evaluateAt).toBeGreaterThan(reflectAt);
    expect(recordAt).toBeGreaterThan(evaluateAt);
    expect(commitAt).toBeGreaterThan(recordAt);

    // The evaluator saw the composer's winning trajectory exactly once.
    expect(harness.evaluatorCalls).toHaveLength(1);

    // P6.1-D RewardContract: every executed probe - winner included - is
    // scored by the SAME trajectory-signal aggregation (the winner's step
    // vector survives only as the auxiliary rewardSources.stepJudge entry), so
    // the expected return is the verifiable-signal reward of the executed
    // trajectory, not the discounted step-evaluator return.
    //
    // The runBranch fixture returns status 'succeeded' with one message step
    // and zero tool calls, and makeSeams does not copy the executor's
    // deliverable onto the trajectory, so the executed shape is a claimed
    // success without a deliverable (completion = -1) - scored exactly as the
    // contract says such a run must be scored.
    const executedShape = {
      ...makeMinimalTrajectory(),
      status: 'succeeded' as const,
      metrics: { steps: 1, toolCalls: 0, toolErrors: 0, durationMs: 10 },
      steps: [{ index: 0, at: 1, kind: 'message' as const, text: 'recovered' }],
      deliverable: undefined,
      failureSignals: []
    };
    const expected = Math.min(3, Math.max(-3, scoreUnderRewardContract(executedShape).reward));
    const online = harness.store.snapshot().filter((record) => record.id.startsWith('online-'));
    expect(online.length).toBeGreaterThan(0);
    for (const record of online) {
      expect(record.return).toBeCloseTo(expected, 12);
      expect(record.reward).toBeCloseTo(expected, 12);
    }
    // The judge's step vector is still visible, as the auxiliary entry only.
    const winnerRecord = online.find((record) => record.rewardSources.stepJudge !== undefined);
    expect(winnerRecord?.rewardSources.stepJudge).toBeCloseTo(
      (rewards[0] as number + (rewards[1] as number)) / 2,
      12
    );
  });

  it('is silent when JitRL is disabled: no stages, no records', async () => {
    const harness = makeHarness({
      candidatesPerCall: 1,
      jitrl: { enabled: false, levels: ['meta', 'proposal'], candidateCount: 3 }
    });
    await harness.orchestrator.run({
      sessionId: 'session-p3',
      task: TASK as never,
      trigger: 'always'
    });
    const trace = traceOf(harness.events);
    expect(trace).not.toContain('jit_proposal_select');
    expect(trace).not.toContain('evaluate_steps');
    expect(trace).not.toContain('record_experience');
    expect(await harness.store.size()).toBe(0);
    expect(harness.evaluatorCalls).toHaveLength(0);
    // The probe still ran: disabling JitRL must not disable evolution.
    expect(candidateProbes(harness.probes)).toHaveLength(1);
  });

  it('omits both stages when no kernel is injected at all', async () => {
    const harness = makeHarness({ candidatesPerCall: 1 });
    const deps = { ...harness.deps };
    delete (deps as { jitrl?: unknown }).jitrl;
    const orchestrator = createEvoHarnessOrchestrator(deps);
    await orchestrator.run({ sessionId: 'session-p3', task: TASK as never, trigger: 'always' });
    expect(candidateProbes(harness.probes)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// t25 / P3-D2: the online L1 sample must be USABLE by a later L1 decision.
// ---------------------------------------------------------------------------

describe('online L1 samples are matchable by the L1 candidate contract', () => {
  it('keys each online L1 record with normalizeMetaAction so support survives alignNeighbors', async () => {
    const harness = makeHarness({ candidatesPerCall: 1 });
    await harness.orchestrator.run({
      sessionId: 'session-p3',
      task: TASK as never,
      trigger: 'always'
    });

    const online = harness.store.snapshot().filter((record) => record.id.startsWith('online-'));
    const meta = online.filter((record) => record.level === 'meta');
    expect(meta.length).toBeGreaterThan(0);

    // The contract: an L1 record's action key MUST be one the L1 candidate space
    // can produce, i.e. 'slot:<kind>' or 'slot:<kind>/surf:<...>'. A portfolio key
    // cannot be aligned by alignNeighbors (slotKindOfActionKey only parses the
    // 'slot:' prefix) and the record is silently dropped before it can add support.
    for (const record of meta) {
      expect(slotKindOfActionKey(record.actionKey)).toBeDefined();
      expect(record.actionKey.startsWith('slot:')).toBe(true);
      // The state must be the same abstract state the decision used, so the
      // Janccard/GuidanceFilter path can even see it.
      expect(record.state.level).toBe('meta');
    }
  });

  it('turns the previous run of the session into L1 support for the probed slot', async () => {
    // The online recorder runs after the round loop, so a single run() cannot
    // observe its own sample. The observable contract is across two runs in ONE
    // session: run 1 has no live support; run 2's L1 decision must align run 1's
    // record onto the candidate that represents the action that actually ran.
    //
    // Against the pre-t25 'meta:batch:...' key this stays 0 forever, because
    // alignNeighbors() drops every record whose key slotKindOfActionKey cannot
    // parse - which is exactly the silent online-learning failure.
    const harness = makeHarness({
      candidatesPerCall: 1,
      withDecorator: true
    });

    const first = await harness.orchestrator.run({
      sessionId: 'session-p3',
      task: TASK as never,
      trigger: 'always'
    });
    void first;

    const supportAfterFirstRun = Math.max(
      0,
      ...harness.jitDecisions.flatMap((decision) =>
        decision.adjustments.map((adjustment) => adjustment.support)
      )
    );
    // First run: nothing recorded yet, so no live support exists.
    expect(supportAfterFirstRun).toBe(0);

    const second = await harness.orchestrator.run({
      sessionId: 'session-p3',
      task: TASK as never,
      trigger: 'always'
    });
    void second;

    const decisions = harness.jitDecisions;
    // The second run made at least one more L1 decision, and it saw the sample
    // the first run recorded for the probed action.
    const maxSupport = Math.max(
      0,
      ...decisions.flatMap((decision) => decision.adjustments.map((a) => a.support))
    );
    expect(maxSupport).toBeGreaterThanOrEqual(1);
    // The supported action is the one the online path actually keyed, i.e. the
    // slot kind the mock policy schedules, spelled with the L1 contract.
    const supported = decisions
      .flatMap((decision) => decision.adjustments)
      .filter((adjustment) => adjustment.support >= 1);
    expect(supported.length).toBeGreaterThan(0);
    for (const adjustment of supported) {
      expect(adjustment.actionKey.startsWith('slot:')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// t25 / P3-D2: guidance must record true provenance (plan section 7.1).
// ---------------------------------------------------------------------------

describe('online records carry real guidance provenance', () => {
  it('writes guidance_free for an invariant slot and memory for a memory slot', async () => {
    const invariant = makeHarness({ candidatesPerCall: 1, slots: [{ kind: 'explore_invariant', guidance: 'guidance_free' }] });
    await invariant.orchestrator.run({
      sessionId: 'session-p3',
      task: TASK as never,
      trigger: 'always'
    });
    const invariantRecords = invariant.store.snapshot().filter((r) => r.id.startsWith('online-'));
    expect(invariantRecords.length).toBeGreaterThan(0);
    expect(invariantRecords.every((record) => record.guidance === 'guidance_free')).toBe(true);

    const memory = makeHarness({ candidatesPerCall: 1, slots: [{ kind: 'explore_domain', guidance: 'memory' }] });
    await memory.orchestrator.run({
      sessionId: 'session-p3',
      task: TASK as never,
      trigger: 'always'
    });
    const memoryRecords = memory.store.snapshot().filter((r) => r.id.startsWith('online-'));
    expect(memoryRecords.length).toBeGreaterThan(0);
    expect(memoryRecords.every((record) => record.guidance === 'memory')).toBe(true);
  });

  it('does not return memory guidance records to an invariant-filtered retrieval', async () => {
    const harness = makeHarness({ candidatesPerCall: 1 });
    await harness.orchestrator.run({
      sessionId: 'session-p3',
      task: TASK as never,
      trigger: 'always'
    });
    const online = harness.store.snapshot().filter((r) => r.id.startsWith('online-'));
    const meta = online.find((record) => record.level === 'meta');
    expect(meta).toBeDefined();
    if (meta === undefined) {
      return;
    }

    const invariantView = await harness.store.query({
      level: 'meta',
      state: meta.state,
      k: 10,
      similarityThreshold: 0,
      guidanceFilter: 'guidance_free'
    });
    const memoryView = await harness.store.query({
      level: 'meta',
      state: meta.state,
      k: 10,
      similarityThreshold: 0,
      guidanceFilter: 'memory'
    });
    // The two views must differ: if every online record is mislabelled
    // 'guidance_free', the memory view is empty and the filter carries no
    // information (plan section 7.1 isolation leak).
    expect(memoryView.length).toBeGreaterThan(0);
    expect(invariantView.length).toBe(0);
  });
});
// ---------------------------------------------------------------------------
// t30 / FIX2: memory augmentation (plan section 6.6, gap G2-2) is REACHABLE.
//
// Before this fix augmentCandidates had exactly one importer in the repo - its
// own unit test - so 'memory_augmented' candidates could never appear in a real
// run and the section 7.1 isolation inside that module was never exercised.
// These tests fail if the production wiring is removed.
// ---------------------------------------------------------------------------

/**
 * Test-only lesson store. rehydratePatch JSON.parses every componentDiff, because
 * the reflector stores them as (truncated) JSON strings - so the fixture must do
 * the same instead of handing over objects.
 */
const LESSON_SOURCE: LessonPatchSource = {
  findByNodeId: () => ({
    nodeId: 'seed-node',
    patchId: 'seed-patch',
    componentDiffs: {
      guardrails: JSON.stringify({ kind: 'guardrails', formatContract: 'Return minified JSON only.' })
    }
  } as never),
  findByPatchId: () => ({
    nodeId: 'seed-node',
    patchId: 'seed-patch',
    componentDiffs: {
      guardrails: JSON.stringify({ kind: 'guardrails', formatContract: 'Return minified JSON only.' })
    }
  } as never)
};

/** Proposal state matching the slot the mock policy schedules. */
function augmentState(slot: BatchSlotKind, guidance: GuidanceMode) {
  return abstractProposalState({
    task: TASK as never,
    round: 1,
    parentDepth: 0,
    parentSlot: slot,
    memoryConfidence: RECALL_CONFIDENCE,
    referenceStatus: 'failed',
    slot,
    guidance
  });
}

/**
 * Only the one-line summaries carry the ', N augmented' text; the isolations and
 * rehydrate notices are separate diagnostics, so tests must filter first.
 */
function augmentSummaries(harness: Harness): readonly string[] {
  return harness.augmentNotices.filter((line) => line.includes('candidate(s)'));
}

/** One neighbouring proposal experience that gives memory something to offer. */
async function seedAugmentableNeighbour(
  harness: Harness,
  actionKey: string,
  slot: BatchSlotKind = 'explore_domain',
  guidance: GuidanceMode = 'memory'
): Promise<void> {
  await harness.store.append([
    {
      id: 'seed-augmentable',
      experienceSchemaVersion: EXPERIENCE_SCHEMA_VERSION,
      level: 'proposal',
      state: augmentState(slot, guidance),
      actionKey,
      reward: 3,
      return: 3,
      rewardSources: { surrogate: 1 },
      guidance,
      policyId: POLICY.id,
      sessionId: 'session-p3',
      treeId: 'tree-seed',
      nodeId: 'seed-node',
      createdAt: CLOCK_START,
      redacted: true
    }
  ]);
}

describe('memory augmentation is wired into the L2 selection path', () => {
  it('invokes the augmenter once per L2 decision and reports it observably', async () => {
    // No lesson source, but a neighbour clears the support gate: the call must
    // still happen and report the deterministic rehydration failure, instead of
    // being silently skipped.
    const harness = makeHarness({ candidatesPerCall: 3, minSupportForStrongPrior: 1 });
    await seedAugmentableNeighbour(harness, 'slot:explore_domain/surf:memory');
    await harness.orchestrator.run({
      sessionId: 'session-p3',
      task: TASK as never,
      trigger: 'always'
    });

    // The pass is observable: a summary line per L2 decision that ran, emitted
    // even when nothing at all could be augmented.
    const summaries = augmentSummaries(harness);
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.every((line) => line.includes('augmented'))).toBe(true);
    // Reached the augmenter, but there is no lesson store in this phase.
    expect(harness.augmentNotices.some((line) => line.includes('augment_rehydrate_failed'))).toBe(true);
    expect(summaries.every((line) => line.includes(', 0 augmented'))).toBe(true);
  });

  it('never augments an explore_invariant slot and records the isolated diagnostic', async () => {
    const harness = makeHarness({
      candidatesPerCall: 3,
      lessonSource: LESSON_SOURCE,
      slots: [{ kind: 'explore_invariant', guidance: 'guidance_free' }]
    });
    await harness.orchestrator.run({
      sessionId: 'session-p3',
      task: TASK as never,
      trigger: 'always'
    });

    // The isolation marker comes from the augmenter itself (section 7.1).
    expect(harness.augmentNotices.some((line) => line.includes('augment_isolated'))).toBe(true);
    expect(harness.augmentNotices.some((line) => line.includes('isolated=true'))).toBe(true);
    // Nothing was augmented even though a working lesson source was wired.
    const summaries = augmentSummaries(harness);
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.every((line) => line.includes(', 0 augmented'))).toBe(true);
    expect(harness.augmentNotices.some((line) => line.includes('augment_rehydrate_failed'))).toBe(false);
  });

  it('CAN produce a memory_augmented candidate for a non-invariant slot with a lesson source', async () => {
    // minSupportForStrongPrior is lowered to 1 because the fixture seeds a single
    // neighbour (support 1); the default gate of 3 would legitimately refuse it.
    const harness = makeHarness({
      candidatesPerCall: 3,
      lessonSource: LESSON_SOURCE,
      minSupportForStrongPrior: 1
    });
    // Seed a neighbour whose action key is NOT among the proposer candidates, so
    // the augmenter treats it as new evidence and may append it.
    await seedAugmentableNeighbour(harness, 'slot:explore_domain/surf:memory');

    await harness.orchestrator.run({
      sessionId: 'session-p3',
      task: TASK as never,
      trigger: 'always'
    });

    // The augmented candidate entered the decision's candidate set: the decision
    // reports more candidates than the proposer offered, and augmentation added one.
    const summaries = augmentSummaries(harness);
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.some((line) => line.includes(', 1 augmented'))).toBe(true);
    // Rehydration succeeded from the stubbed lesson source, so there is no failure
    // notice on this path - and the augmented candidate was offered to the decision.
    expect(harness.augmentNotices.some((line) => line.includes('augment_rehydrate_failed'))).toBe(false);
    expect(harness.augmentNotices.some((line) => line.includes('augment_low_support'))).toBe(false);
  });

  it('does not augment at all when augmentFromMemory is false', async () => {
    const harness = makeHarness({
      candidatesPerCall: 3,
      lessonSource: LESSON_SOURCE,
      augmentFromMemory: false,
      minSupportForStrongPrior: 1
    });
    await seedAugmentableNeighbour(harness, 'slot:explore_domain/surf:memory');

    await harness.orchestrator.run({
      sessionId: 'session-p3',
      task: TASK as never,
      trigger: 'always'
    });

    const summaries = augmentSummaries(harness);
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.every((line) => line.includes(', 0 augmented'))).toBe(true);
    // The master switch short-circuits before any rehydration work.
    expect(harness.augmentNotices.some((line) => line.includes('augment_rehydrate_failed'))).toBe(false);
    expect(harness.augmentNotices.some((line) => line.includes('augment_isolated'))).toBe(false);
  });
});
