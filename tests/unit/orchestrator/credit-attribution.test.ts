/**
 * P6 PR4 / R4: per-execution credit attribution (plan sections 4 R4, 6.1-6.6).
 *
 * The defect these tests pin down (plan section R4):
 *   - `recordOnlineExperience` evaluated ONE trajectory (the composer's winner)
 *     and copied its discounted return onto every action of the LAST L1 batch;
 *   - every L2 selection of the run got the same return;
 *   - every L2 record was stamped with the FINAL winning nodeId instead of the
 *     node that actually executed that selection;
 *   - a run with no winner recorded nothing, so a failed run left no negative
 *     sample at all.
 *
 * Every assertion below is written so the PRE-FIX implementation fails it. The
 * six discriminating cases required by plan section 6.6 are:
 *   1. same batch, succeeded and failed slots get DIFFERENT targets (never a
 *      shared winner return);
 *   2. an action that ran before the final round still has a record;
 *   3. a run with no winner still records its executed failures;
 *   4. L2 actionKey / nodeId / trajectoryId match the execution one-to-one;
 *   5. probe completion order does not change the experience set or the decision
 *      window;
 *   6. reverting to "copy the winner's return" makes these tests fail (the
 *      structural guard at the bottom asserts no shared-returnG shape exists).
 */
import { describe, expect, it } from 'vitest';
import {
  createEvoHarnessOrchestrator,
  type EvoHarnessOrchestrator,
  type EvoHarnessOrchestratorDeps,
  type EvoHarnessStageEvent,
  type OrchestratorJitRl
} from '../../../src/orchestrator';
import { createDefaultConfig, parseEvoHarnessConfig } from '../../../src/config';
import { createDiscoveryTreePool } from '../../../src/dream-rsi';
import {
  createMemoryExperienceStore,
  type MemoryExperienceStore
} from '../../../src/jitrl/stores/memory.store';
import {
  EXPERIENCE_SCHEMA_VERSION,
  classifyExperienceVersion,
  mirrorVisibleRecords,
  partitionByVersion
} from '../../../src/jitrl/experience-store';
import {
  CURRENT_PROVENANCE_VERSION,
  CURRENT_REWARD_VERSION
} from '../../../src/jitrl/experience-store';
import {
  COMPLETION_SIGNAL,
  MISSING_DELIVERABLE_SIGNAL,
  classifyTrajectoryOutcome,
  isLearningOutcome,
  scoreTrajectorySignals
} from '../../../src/jitrl/step-evaluator';
import {
  REWARD_CONTRACT,
  estimatorTargetLine,
  scoreUnderRewardContract
} from '../../../src/jitrl/reward-contract';
import { migrateExperienceRecords, partitionExperienceRecords } from '../../../src/jitrl/backfill';
import type {
  AbstractState,
  BatchPlan,
  BatchSlotKind,
  BatchSlotPlan,
  BranchExecutor,
  CanonicalLesson,
  CompositionResult,
  EightSurfacePatch,
  ExperienceRecord,
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
  JitCandidate,
  JitDecision,
  JitLevel,
  MemoryIsolationHandle,
  MemoryRecallQuery,
  MemoryRecallResult,
  MemoryScope,
  MetaSearchPolicy,
  ProbeBranchRequest,
  ProbeExecutionResult,
  ProbeTrajectory,
  ProposedPatch,
  ProposedPatchSet,
  ProposeRequest,
  SearchGridPlan,
  SelectBatchRequest,
  StepReward,
  SurfacePatchDisposer
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
  id: 'pr4-policy',
  version: 7,
  createdAt: 0,
  maxWidth: 4,
  maxDepth: 2,
  slotWeights: {
    exploit: 0.25,
    explore_domain: 0.25,
    explore_invariant: 0.25,
    recover: 0.25
  },
  earlyStopThreshold: 0.8,
  minMemoryConfidenceForSkip: 0.9
};

const TASK = { id: 'task-pr4-credit', prompt: 'attribute credit per execution' } as const;

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

/** Outcome per slot, keyed by the slot's branchId, so tests control each probe. */
type SlotOutcome = 'succeed' | 'fail' | 'timeout' | 'abort' | 'cancel' | 'infra';

interface SeamsHarness {
  readonly seams: ICordisSeamManager;
  /** branchId -> the trajectory that branch produced (last write wins). */
  readonly trajectories: Map<string, ProbeTrajectory>;
  /** Every branch executed, in launch order. */
  readonly executed: string[];
}

function makeSeams(
  now: () => number,
  outcomeOf: (branchId: string) => SlotOutcome,
  /** Called before a branch settles; lets a test delay one probe. */
  onProbe?: (branchId: string, round: number) => Promise<void> | undefined
): SeamsHarness {
  let trajectorySeq = 0;
  const trajectories = new Map<string, ProbeTrajectory>();
  const executed: string[] = [];
  const seams: ICordisSeamManager = {
    async runInIsolatedBranch(request: ProbeBranchRequest): Promise<ProbeTrajectory> {
      const branchId = request.branchId ?? 'branch';
      const isReference = request.role === 'reference';
      const outcome = isReference ? 'fail' : outcomeOf(branchId);
      executed.push(branchId);
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
      const pending = onProbe?.(branchId, 0);
      if (pending !== undefined) {
        await pending;
      }
      const result: ProbeExecutionResult = await request.executor(context);
      const endedAt = now();
      trajectorySeq += 1;
      const trajectory = makeTrajectory({
        id: 'traj-' + String(trajectorySeq),
        branchId,
        request,
        result,
        outcome,
        startedAt,
        endedAt
      });
      trajectories.set(branchId, trajectory);
      return trajectory;
    },
    async applyPermanentPatch(patch: EightSurfacePatch): Promise<SurfacePatchDisposer> {
      return { patchId: patch.id, active: true, dispose: async () => undefined };
    },
    listActiveBranches: () => [],
    dispose: async () => undefined
  } as unknown as ICordisSeamManager;
  return { seams, trajectories, executed };
}

function makeTrajectory(input: {
  readonly id: string;
  readonly branchId: string;
  readonly request: ProbeBranchRequest;
  readonly result: ProbeExecutionResult;
  readonly outcome: SlotOutcome;
  readonly startedAt: number;
  readonly endedAt: number;
}): ProbeTrajectory {
  const base = {
    id: input.id,
    sessionId: input.request.sessionId,
    branchId: input.branchId,
    branchNamespace: 'mock',
    role: input.request.role ?? 'candidate',
    patchId: input.request.patch.id,
    patchOrigin: input.request.patch.origin,
    surfaceKeys: Object.keys(input.request.patch.edits) as HarnessComponentKey[],
    ...(input.request.treeId === undefined ? {} : { treeId: input.request.treeId }),
    ...(input.request.nodeId === undefined ? {} : { nodeId: input.request.nodeId }),
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    memoryRecallIds: input.request.memoryRecallIds ?? []
  };
  const steps = input.result.steps ?? [];
  const toolErrors = input.result.toolErrors ?? [];
  switch (input.outcome) {
    case 'succeed':
      return {
        ...base,
        status: 'succeeded',
        metrics: { steps: steps.length, toolCalls: 1, toolErrors: 0, durationMs: 10 },
        steps,
        toolErrors,
        deliverable: { content: 'done', format: 'text' },
        failureSignals: []
      } as ProbeTrajectory;
    case 'timeout':
      return {
        ...base,
        status: 'timeout',
        metrics: { steps: steps.length, toolCalls: 2, toolErrors: 1, durationMs: 10 },
        steps,
        toolErrors,
        failureSignals: [{ kind: 'timeout', message: 'the probe timed out' }]
      } as ProbeTrajectory;
    case 'abort':
      return {
        ...base,
        status: 'aborted',
        metrics: { steps: steps.length, toolCalls: 1, toolErrors: 0, durationMs: 10 },
        steps,
        toolErrors,
        failureSignals: [],
        error: { name: 'AbortError', message: 'the run was aborted' }
      } as ProbeTrajectory;
    case 'cancel':
      return {
        ...base,
        status: 'failed',
        metrics: { steps: steps.length, toolCalls: 1, toolErrors: 0, durationMs: 10 },
        steps,
        toolErrors,
        failureSignals: [{ kind: 'unknown', message: 'cancelled by user' }],
        error: { name: 'UserCancelledError', message: 'the user cancelled this run' }
      } as ProbeTrajectory;
    case 'infra':
      return {
        ...base,
        status: 'failed',
        metrics: { steps: steps.length, toolCalls: 0, toolErrors: 0, durationMs: 0 },
        steps,
        toolErrors,
        failureSignals: [{ kind: 'unknown', message: 'ECONNREFUSED while reaching the host' }],
        error: { name: 'EvoHarnessPluginError', message: 'the branch executor failed' }
      } as ProbeTrajectory;
    case 'fail':
    default:
      return {
        ...base,
        status: 'failed',
        metrics: { steps: steps.length, toolCalls: 2, toolErrors: 1, durationMs: 10 },
        steps,
        toolErrors,
        failureSignals: [{ kind: 'tool_error', message: 'the tool failed', repairable: true }]
      } as ProbeTrajectory;
  }
}

/** Slot the mock policy schedules. */
interface MockSlotSpec {
  readonly kind: BatchSlotKind;
  readonly guidance: GuidanceMode;
}

const DOMAIN_SLOT: readonly MockSlotSpec[] = [{ kind: 'explore_domain', guidance: 'memory' }];

/**
 * Policy that schedules a per-round slot portfolio.
 *
 * `rounds` maps round number -> the slots to schedule in that round, so a test
 * can put a succeeded and a failed action in the SAME batch and then a different
 * batch in a later round.
 */
function makePolicy(options: {
  readonly rounds: Readonly<Record<number, readonly MockSlotSpec[]>>;
  readonly maxDepth: number;
}): IActivePolicy {
  return {
    policy: POLICY,
    planGrid: (): SearchGridPlan => ({
      maxWidth: POLICY.maxWidth,
      maxDepth: options.maxDepth,
      budget: 12,
      skipProbing: false,
      stopCondition: 'max_depth',
      complexity: 'moderate',
      rationale: 'pr4 grid plan',
      policyId: POLICY.id
    }),
    selectBatch: (request: SelectBatchRequest): BatchPlan => {
      const specs = options.rounds[request.round] ?? [];
      const planned: BatchSlotPlan[] = specs.map((spec, slotIndex) => ({
        slot: spec.kind,
        slotIndex,
        branchId: 'r' + String(request.round) + '-branch-' + String(slotIndex),
        parentNodeId: request.tree.rootId,
        origin: spec.kind === 'explore_invariant' ? 'invariant' : 'domain',
        guidance: spec.guidance,
        focusSurfaces: ['guardrails'],
        rationale: 'pr4 slot ' + spec.kind
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

/** Structurally distinct patch shapes so the action keys differ. */
function patchVariant(
  id: string,
  shape: 'guardrails-1' | 'guardrails-2' | 'system-prompt',
  now: () => number,
  slotIndex = 0
): EightSurfacePatch {
  const edits =
    shape === 'guardrails-1'
      ? { guardrails: { kind: 'guardrails', appendRules: ['rule-' + id] } }
      : shape === 'guardrails-2'
        ? { guardrails: { kind: 'guardrails', appendRules: ['rule-' + id, 'rule-' + id + '-b'] } }
        : { system_prompt: { kind: 'system_prompt', mode: 'append', content: 'prompt-' + id } };
  return {
    id,
    sessionId: 'session-pr4',
    branchId: 'branch-' + String(slotIndex),
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
}

function makeProposer(now: () => number): {
  readonly proposer: CountingProposer;
  readonly patches: readonly EightSurfacePatch[];
} {
  const patches = [
    patchVariant('patch-a', 'guardrails-1', now),
    patchVariant('patch-b', 'guardrails-2', now),
    patchVariant('patch-c', 'system-prompt', now)
  ];
  const state = { propose: 0, candidate: 0 };
  const proposer: CountingProposer = {
    get proposeCalls() {
      return state.propose;
    },
    get candidateCalls() {
      return state.candidate;
    },
    async propose(request: ProposeRequest): Promise<ProposedPatch> {
      state.propose += 1;
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
      return {
        candidates: patches.map((patch, index) => ({
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

/**
 * Composer that always picks the FIRST succeeded candidate, or reports no
 * winner at all when every candidate failed.
 */
function makeComposer(): IHarnessComposer {
  return {
    async compose(request): Promise<CompositionResult> {
      const winner =
        request.candidates.find((candidate) => candidate.trajectory.status === 'succeeded') ?? null;
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
        adoptionRatios: Object.fromEntries(
          request.candidates.map((candidate) => [
            candidate.nodeId,
            candidate.nodeId === winner?.nodeId ? 1 : 0.4
          ])
        ),
        rationale: 'mock composition',
        evaluatedAt: 0
      } as unknown as CompositionResult;
    }
  };
}

function makeScorer(now: () => number): ISurrogateScorer {
  return {
    score(request) {
      const succeeded = request.node.status === 'succeeded';
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

/** Step evaluator that records which trajectory it saw and returns a fixed vector. */
function makeStepEvaluator(
  rewards: readonly number[],
  calls: ProbeTrajectory[]
): IStepEvaluator {
  return {
    async evaluate(trajectory: ProbeTrajectory): Promise<readonly StepReward[]> {
      calls.push(trajectory);
      return rewards.map((reward, index) => ({
        stepIndex: index,
        reward,
        sources: { surrogate: reward }
      }));
    }
  } as IStepEvaluator;
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

interface HarnessOptions {
  readonly rounds: Readonly<Record<number, readonly MockSlotSpec[]>>;
  readonly maxDepth?: number;
  readonly outcomes: Readonly<Record<string, SlotOutcome>>;
  readonly stepRewards?: readonly number[];
  readonly candidatesPerCall?: number;
  readonly candidateCount?: number;
  /** Delay a specific branch so completion order can be permuted. */
  readonly delay?: (branchId: string) => Promise<void> | undefined;
  /** P6.1-D ②: replace the step evaluator with one that always rejects. */
  readonly evaluatorThrows?: boolean;
  /** P6.1-D ②: replace the step evaluator with one returning no steps. */
  readonly evaluatorEmpty?: boolean;
}

interface Harness {
  readonly orchestrator: EvoHarnessOrchestrator;
  readonly events: EvoHarnessStageEvent[];
  readonly store: MemoryExperienceStore;
  readonly evaluatorCalls: ProbeTrajectory[];
  readonly seams: SeamsHarness;
  readonly diagnostics: readonly (readonly string[])[];
}

const CLOCK_START = 1_700_000_000_000;

function makeHarness(options: HarnessOptions): Harness {
  const now = makeClock(CLOCK_START);
  const events: EvoHarnessStageEvent[] = [];
  const evaluatorCalls: ProbeTrajectory[] = [];
  const defaults = createDefaultConfig();
  const config = parseEvoHarnessConfig({
    triggerMode: 'always',
    probe: { maxConcurrentProbes: 4, probeTimeoutMs: 5_000 },
    dreamRsi: {
      maxOnlineRolloutBudget: 12,
      maxWidth: 4,
      maxDepth: options.maxDepth ?? 2,
      offlineDreamTriggerEveryNTasks: 1_000,
      candidatePoliciesCount: 2
    },
    logging: { level: 'silent' }
  });

  const { proposer } = makeProposer(now);
  const store = createMemoryExperienceStore({ now, halfLifeMs: 1_000_000_000 });
  const jitSurface: OrchestratorJitRl = {
    store,
    optimizer: {
      async decide<T>(
        level: JitLevel,
        _state: AbstractState,
        candidates: readonly JitCandidate<T>[]
      ): Promise<JitDecision<T>> {
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
        return {
          level,
          stateValue: 0,
          neighborCount: 0,
          adjustments,
          chosen: adjustments[0] as (typeof adjustments)[number],
          klToPrior: 0,
          rationale: 'pr4 stub'
        };
      }
    },
    stepEvaluator:
      options.evaluatorThrows === true
        ? ({
            async evaluate(): Promise<readonly StepReward[]> {
              throw new Error('judge provider down');
            }
          } as IStepEvaluator)
        : options.evaluatorEmpty === true
          ? ({
              async evaluate(): Promise<readonly StepReward[]> {
                return [];
              }
            } as IStepEvaluator)
          : makeStepEvaluator(options.stepRewards ?? [1, 2], evaluatorCalls),
    config: {
      enabled: true,
      levels: ['meta', 'proposal'],
      gamma: defaults.jitrl.gamma,
      candidateCount: options.candidateCount ?? 1,
      k: defaults.jitrl.k,
      similarityThreshold: defaults.jitrl.similarityThreshold,
      augmentFromMemory: false,
      minSupportForStrongPrior: defaults.jitrl.minSupportForStrongPrior
    }
  };

  const seams = makeSeams(now, (branchId) => options.outcomes[branchId] ?? 'succeed', options.delay);

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
      steps: [{ index: 0, at: now(), kind: 'message', text: 'ran' }],
      deliverable: { content: 'ok', format: 'text' },
      toolErrors: [],
      failureSignals: []
    } as unknown as ProbeExecutionResult;
  };

  const deps: EvoHarnessOrchestratorDeps = {
    config,
    memory: makeMemoryBridge(),
    seams: seams.seams,
    policy: makePolicy({ rounds: options.rounds, maxDepth: options.maxDepth ?? 2 }),
    proposer,
    composer: makeComposer(),
    reflector: makeReflector(),
    scorer: makeScorer(now),
    taxonomy: { diagnose: () => NO_FAILURE },
    dreamer: makeDreamer(),
    treePool: createDiscoveryTreePool(),
    runBranch,
    now,
    newId: makeIdFactory('pr4'),
    applyWinningPatch: false,
    jitrl: jitSurface,
    onStage: (event) => events.push(event)
  };

  const capturedDiagnostics: string[][] = [];
  const inner = createEvoHarnessOrchestrator(deps);
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
    store,
    evaluatorCalls,
    seams,
    get diagnostics(): readonly (readonly string[])[] {
      return capturedDiagnostics;
    }
  };
}

function onlineRecords(store: MemoryExperienceStore): readonly ExperienceRecord[] {
  return store.snapshot().filter((record) => record.id.startsWith('online-'));
}

function metaRecords(store: MemoryExperienceStore): readonly ExperienceRecord[] {
  return onlineRecords(store).filter((record) => record.level === 'meta');
}

function proposalRecords(store: MemoryExperienceStore): readonly ExperienceRecord[] {
  return onlineRecords(store).filter((record) => record.level === 'proposal');
}

// ---------------------------------------------------------------------------
// 6.6 (1): the same batch's succeeded and failed slots get DIFFERENT targets
// ---------------------------------------------------------------------------

describe('6.6 (1): a batch never shares one winner return', () => {
  it('gives the failed slot its own negative target instead of the winner return', async () => {
    const harness = makeHarness({
      rounds: {
        1: [
          { kind: 'explore_domain', guidance: 'memory' },
          { kind: 'explore_domain', guidance: 'memory' }
        ]
      },
      maxDepth: 1,
      outcomes: { 'r1-branch-0': 'succeed', 'r1-branch-1': 'fail' },
      // A strongly positive winner vector: the pre-fix code copied its return to
      // BOTH slots, so the failed slot came out positive too.
      stepRewards: [3, 3]
    });

    await harness.orchestrator.run({
      sessionId: 'session-pr4',
      task: TASK as never,
      trigger: 'always'
    });

    const meta = metaRecords(harness.store);
    // Both executed slots are recorded: the batch has two real actions.
    expect(meta).toHaveLength(2);

    const succeeded = meta.find((record) => record.nodeId?.includes('') === true && record.return > 0);
    const failed = meta.find((record) => record !== succeeded);
    expect(succeeded).toBeDefined();
    expect(failed).toBeDefined();

    // The winner's return came from the step evaluator...
    expect(harness.evaluatorCalls).toHaveLength(1);
    expect(succeeded?.outcome).toBe('succeeded');
    expect(succeeded?.return).toBeGreaterThan(0);

    // ...and the failed slot has its OWN, different return. This is the core
    // assertion: the pre-fix code made these two values identical.
    expect(failed?.outcome).not.toBe('succeeded');
    expect(failed?.return).not.toBeCloseTo(succeeded?.return ?? 0, 6);
    expect(failed?.return).toBeLessThan(0);

    // The learning targets differ too, and each is derived from its own return.
    expect(succeeded?.learningTarget).not.toBeCloseTo(failed?.learningTarget ?? 0, 6);
    for (const record of meta) {
      expect(record.attributionBaseline).toBeTypeOf('number');
      expect(record.learningTarget).toBeTypeOf('number');
      // learningTarget = observedReturn - attributionBaseline (clipped).
      expect(record.learningTarget).toBeCloseTo(
        Math.max(-3, Math.min(3, (record.observedReturn ?? 0) - (record.attributionBaseline ?? 0))),
        6
      );
    }
  });

  it('scores a succeeded sibling from its own verifiable signals, not the winner vector', async () => {
    // Two succeeding slots: the composer picks the first as winner, so only that
    // one gets the (model-backed) step vector. P6.1-D: the winner's step vector
    // is AUXILIARY (rewardSources.stepJudge), so both records' primary targets
    // come from the SAME verifiable-signal aggregation of each one's own
    // trajectory - identical trajectories therefore measure identically, and a
    // sibling can never inherit the winner's evaluator vector.
    const harness = makeHarness({
      rounds: {
        1: [
          { kind: 'explore_domain', guidance: 'memory' },
          { kind: 'explore_domain', guidance: 'memory' }
        ]
      },
      maxDepth: 1,
      outcomes: { 'r1-branch-0': 'succeed', 'r1-branch-1': 'succeed' },
      stepRewards: [3, 3]
    });

    await harness.orchestrator.run({
      sessionId: 'session-pr4',
      task: TASK as never,
      trigger: 'always'
    });

    const meta = metaRecords(harness.store);
    expect(meta).toHaveLength(2);
    // Exactly one evaluation happened (cost is not multiplied per slot).
    expect(harness.evaluatorCalls).toHaveLength(1);
    const winnerTrajectoryId = harness.evaluatorCalls[0]?.id;
    const winnerRecord = meta.find((record) => record.trajectoryId === winnerTrajectoryId);
    const siblingRecord = meta.find((record) => record.trajectoryId !== winnerTrajectoryId);
    expect(winnerRecord).toBeDefined();
    expect(siblingRecord).toBeDefined();
    // The sibling's primary target is its OWN verifiable-signal score...
    expect(siblingRecord?.observedReturn).toBe(siblingRecord?.return);
    expect(siblingRecord?.rewardSources.stepJudge).toBeUndefined();
    // ...identical to the winner's because the trajectories are identical and
    // the yardstick is one (this is the P6.1-D fix: no winner-private scale).
    expect(siblingRecord?.return).toBeCloseTo(winnerRecord?.return ?? Number.NaN, 12);
    // The winner's evaluator vector survives ONLY as the auxiliary entry.
    expect(winnerRecord?.rewardSources.stepJudge).toBeCloseTo(3, 12);
    // And the primary scale is the RewardContract aggregation, not the
    // evaluator mean.
    const expected = scoreUnderRewardContract(
      harness.seams.trajectories.get('r1-branch-0') as ProbeTrajectory
    ).reward;
    expect(winnerRecord?.return).toBeCloseTo(expected, 12);
  });
});

// ---------------------------------------------------------------------------
// 6.6 (2): an action from an earlier round still has a record
// ---------------------------------------------------------------------------

describe('6.6 (2): every round is recorded, not just the last', () => {
  it('keeps round 1 records when the run reaches round 2', async () => {
    const harness = makeHarness({
      rounds: {
        1: [{ kind: 'explore_domain', guidance: 'memory' }],
        2: [{ kind: 'exploit', guidance: 'memory' }]
      },
      maxDepth: 2,
      outcomes: {
        'r1-branch-0': 'succeed',
        'r2-branch-0': 'fail'
      },
      stepRewards: [2]
    });

    await harness.orchestrator.run({
      sessionId: 'session-pr4',
      task: TASK as never,
      trigger: 'always'
    });

    const meta = metaRecords(harness.store);
    // Both rounds ran, so both actions must be present. The pre-fix code kept
    // only `l1Samples.at(-1)`, i.e. round 2, and silently dropped round 1.
    const rounds = meta.map((record) => record.round).sort();
    expect(rounds).toEqual([1, 2]);

    const roundOne = meta.find((record) => record.round === 1);
    expect(roundOne).toBeDefined();
    expect(roundOne?.actionKey).toContain('explore_domain');
    // Round 1's action really was a success: the record must say so, and its
    // return must not be the (failed) round 2 action's return.
    expect(roundOne?.outcome).toBe('succeeded');
    const roundTwo = meta.find((record) => record.round === 2);
    expect(roundTwo?.outcome).not.toBe('succeeded');
    expect(roundOne?.return).not.toBeCloseTo(roundTwo?.return ?? 0, 6);
  });
});

// ---------------------------------------------------------------------------
// 6.6 (3): a run with no winner still records its executed failures
// ---------------------------------------------------------------------------

describe('6.6 (3): no winner still leaves explainable failures', () => {
  it('records every executed failure when the composer selects nothing', async () => {
    const harness = makeHarness({
      rounds: {
        1: [
          { kind: 'explore_domain', guidance: 'memory' },
          { kind: 'recover', guidance: 'memory' }
        ]
      },
      maxDepth: 1,
      outcomes: { 'r1-branch-0': 'fail', 'r1-branch-1': 'timeout' },
      stepRewards: [3, 3]
    });

    const result = await harness.orchestrator.run({
      sessionId: 'session-pr4',
      task: TASK as never,
      trigger: 'always'
    });

    const meta = metaRecords(harness.store);
    // Pre-fix: `selectedNodeId === null` returned 0, so a failed run left NO
    // negative sample. Now both executed failures are recorded.
    expect(meta).toHaveLength(2);
    for (const record of meta) {
      expect(record.outcome).not.toBe('succeeded');
      expect(record.learningEligible).toBe(true);
      expect(record.return).toBeLessThanOrEqual(0);
      // Explainable: the record says how it ended and carries its own evidence.
      expect(record.rewardSources).toBeTypeOf('object');
    }
    // The outcomes stay distinguishable: a timeout is not a plain failure.
    const outcomes = meta.map((record) => record.outcome).sort();
    expect(outcomes).toEqual(['failed', 'timeout']);
    // No step evaluation was spent on a run without a winner.
    expect(harness.evaluatorCalls).toHaveLength(0);
    expect(result.outcome).not.toBe('composed');
  });

  it('never fabricates a reward for a candidate that did not execute', async () => {
    // Three proposals are offered (K=3) but only ONE is probed. The two that
    // never ran must not appear in the store at all.
    const harness = makeHarness({
      rounds: { 1: [{ kind: 'explore_domain', guidance: 'memory' }] },
      maxDepth: 1,
      outcomes: { 'r1-branch-0': 'succeed' },
      stepRewards: [1],
      candidateCount: 3
    });

    await harness.orchestrator.run({
      sessionId: 'session-pr4',
      task: TASK as never,
      trigger: 'always'
    });

    const proposal = proposalRecords(harness.store);
    // Exactly one L2 record: the one proposal that was chosen AND executed.
    expect(proposal).toHaveLength(1);
    // Its trajectory is the one that actually ran, not a synthesized id.
    const executedTrajectoryIds = new Set(
      [...harness.seams.trajectories.values()].map((trajectory) => trajectory.id)
    );
    for (const record of proposal) {
      expect(executedTrajectoryIds.has(record.trajectoryId ?? '')).toBe(true);
    }
    // No record carries an empty or invented trajectory.
    for (const record of onlineRecords(harness.store)) {
      expect(record.trajectoryId).toBeTypeOf('string');
      expect(record.trajectoryId?.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 6.6 (4): L2 actionKey / nodeId / trajectoryId match the execution
// ---------------------------------------------------------------------------

describe('6.6 (4): L2 association matches the execution one-to-one', () => {
  it('links each L2 record to the node and trajectory that executed it', async () => {
    const harness = makeHarness({
      rounds: {
        1: [
          { kind: 'explore_domain', guidance: 'memory' },
          { kind: 'explore_domain', guidance: 'memory' }
        ]
      },
      maxDepth: 1,
      outcomes: { 'r1-branch-0': 'fail', 'r1-branch-1': 'succeed' },
      stepRewards: [2],
      candidateCount: 3
    });

    await harness.orchestrator.run({
      sessionId: 'session-pr4',
      task: TASK as never,
      trigger: 'always'
    });

    const proposal = proposalRecords(harness.store);
    expect(proposal.length).toBeGreaterThan(0);

    // Build the executed-truth map: branchId -> (trajectoryId, nodeId).
    const truth = new Map<string, { trajectoryId: string; nodeId: string | undefined }>();
    for (const [branchId, trajectory] of harness.seams.trajectories) {
      truth.set(branchId, { trajectoryId: trajectory.id, nodeId: trajectory.nodeId });
    }

    for (const record of proposal) {
      // The record's trajectory must be a REAL executed trajectory...
      const executed = [...truth.values()].find(
        (entry) => entry.trajectoryId === record.trajectoryId
      );
      expect(executed).toBeDefined();
      // ...and its nodeId must be the node that executed that trajectory, NOT
      // the run's final winner (the pre-fix bug stamped every L2 record with
      // `input.selectedNodeId`).
      expect(record.nodeId).toBe(executed?.nodeId);
      // The action key belongs to the same execution.
      expect(record.actionKey.length).toBeGreaterThan(0);
      expect(record.branchId).toBeTypeOf('string');
      expect(record.decisionId).toContain('jit-decision-');
    }

    // Cross-check against the tree: each L2 nodeId is the node whose recorded
    // trajectoryId equals the record's trajectoryId.
    const tree = harness.orchestrator.treePool.list()[0];
    expect(tree).toBeDefined();
    for (const record of proposal) {
      const node = Object.values(tree?.nodes ?? {}).find((entry) => entry.id === record.nodeId);
      expect(node).toBeDefined();
      expect(node?.trajectoryId).toBe(record.trajectoryId);
    }
  });

  it('keeps the failed sibling L2 record pointing at the failed node, not the winner', async () => {
    const harness = makeHarness({
      rounds: {
        1: [
          { kind: 'explore_domain', guidance: 'memory' },
          { kind: 'explore_domain', guidance: 'memory' }
        ]
      },
      maxDepth: 1,
      outcomes: { 'r1-branch-0': 'fail', 'r1-branch-1': 'succeed' },
      stepRewards: [2],
      candidateCount: 3
    });

    await harness.orchestrator.run({
      sessionId: 'session-pr4',
      task: TASK as never,
      trigger: 'always'
    });

    const proposal = proposalRecords(harness.store);
    expect(proposal).toHaveLength(2);
    const nodeIds = new Set(proposal.map((record) => record.nodeId));
    // Two distinct nodes: the pre-fix code wrote the SAME winner nodeId twice.
    expect(nodeIds.size).toBe(2);
    const trajectoryIds = new Set(proposal.map((record) => record.trajectoryId));
    expect(trajectoryIds.size).toBe(2);
    // Each record's node/trajectory pair agrees with the tree.
    const tree = harness.orchestrator.treePool.list()[0];
    for (const record of proposal) {
      const node = Object.values(tree?.nodes ?? {}).find((entry) => entry.id === record.nodeId);
      expect(node?.trajectoryId).toBe(record.trajectoryId);
    }
  });
});

// ---------------------------------------------------------------------------
// 6.6 (5): completion order does not change the experience set
// ---------------------------------------------------------------------------

describe('6.6 (5): completion order cannot change the outcome', () => {
  async function runWithOrder(
    delayBranch: string | undefined
  ): Promise<{
    readonly records: readonly string[];
    readonly trace: readonly string[];
  }> {
    const harness = makeHarness({
      rounds: {
        1: [
          { kind: 'explore_domain', guidance: 'memory' },
          { kind: 'explore_domain', guidance: 'memory' }
        ]
      },
      maxDepth: 1,
      outcomes: { 'r1-branch-0': 'succeed', 'r1-branch-1': 'fail' },
      stepRewards: [2],
      ...(delayBranch === undefined
        ? {}
        : {
            delay: (branchId: string) =>
              branchId === delayBranch
                ? new Promise<void>((resolve) => setTimeout(resolve, 5))
                : undefined
          })
    });
    await harness.orchestrator.run({
      sessionId: 'session-pr4',
      task: TASK as never,
      trigger: 'always'
    });
    const records = onlineRecords(harness.store)
      .map((record) =>
        [
          record.level,
          record.actionKey,
          record.nodeId ?? '',
          record.trajectoryId ?? '',
          record.round ?? '',
          record.outcome ?? '',
          record.return.toFixed(6),
          record.learningTarget?.toFixed(6) ?? ''
        ].join('|')
      )
      .sort();
    return { records, trace: harness.events.map((event) => event.stage) };
  }

  it('produces an identical experience set whichever sibling finishes first', async () => {
    const slotZeroFirst = await runWithOrder(undefined);
    const slotOneFirst = await runWithOrder('r1-branch-1');

    expect(slotOneFirst.records).toEqual(slotZeroFirst.records);
    // The decision window is unchanged too: same stages, same count.
    expect(slotOneFirst.trace).toEqual(slotZeroFirst.trace);
  });
});

// ---------------------------------------------------------------------------
// 6.2: outcome classification and eligibility
// ---------------------------------------------------------------------------

describe('6.2: cancelled / aborted / infrastructure are not action-quality evidence', () => {
  it('marks a user cancellation audit-only with a zero learning target', async () => {
    const harness = makeHarness({
      rounds: { 1: [{ kind: 'explore_domain', guidance: 'memory' }] },
      maxDepth: 1,
      outcomes: { 'r1-branch-0': 'cancel' },
      stepRewards: [2]
    });
    await harness.orchestrator.run({
      sessionId: 'session-pr4',
      task: TASK as never,
      trigger: 'always'
    });
    const meta = metaRecords(harness.store);
    expect(meta).toHaveLength(1);
    expect(meta[0]?.outcome).toBe('cancelled');
    expect(meta[0]?.learningEligible).toBe(false);
    expect(meta[0]?.learningTarget).toBe(0);
    // It is kept for audit: the record exists and is explainable.
    expect(meta[0]?.rewardSources).toBeTypeOf('object');
  });

  it('marks an infrastructure failure audit-only and an abort audit-only', async () => {
    const infra = makeHarness({
      rounds: { 1: [{ kind: 'explore_domain', guidance: 'memory' }] },
      maxDepth: 1,
      outcomes: { 'r1-branch-0': 'infra' },
      stepRewards: [2]
    });
    await infra.orchestrator.run({
      sessionId: 'session-pr4',
      task: TASK as never,
      trigger: 'always'
    });
    const infraMeta = metaRecords(infra.store);
    expect(infraMeta[0]?.outcome).toBe('infrastructure_error');
    expect(infraMeta[0]?.learningEligible).toBe(false);

    const aborted = makeHarness({
      rounds: { 1: [{ kind: 'explore_domain', guidance: 'memory' }] },
      maxDepth: 1,
      outcomes: { 'r1-branch-0': 'abort' },
      stepRewards: [2]
    });
    await aborted.orchestrator.run({
      sessionId: 'session-pr4',
      task: TASK as never,
      trigger: 'always'
    });
    const abortMeta = metaRecords(aborted.store);
    expect(abortMeta[0]?.outcome).toBe('aborted');
    expect(abortMeta[0]?.learningEligible).toBe(false);
  });

  it('classifies the five terminal modes distinctly in the pure helper', () => {
    const now = (): number => CLOCK_START;
    const request = {
      sessionId: 'session-pr4',
      task: TASK,
      patch: patchVariant('p', 'guardrails-1', now),
      executor: async () => ({}) as never
    } as unknown as ProbeBranchRequest;
    const make = (outcome: SlotOutcome): ProbeTrajectory =>
      makeTrajectory({
        id: 't',
        branchId: 'b',
        request,
        result: { status: 'succeeded' } as ProbeExecutionResult,
        outcome,
        startedAt: 0,
        endedAt: 1
      });

    expect(classifyTrajectoryOutcome(make('succeed'))).toBe('succeeded');
    expect(classifyTrajectoryOutcome(make('fail'))).toBe('failed');
    expect(classifyTrajectoryOutcome(make('timeout'))).toBe('timeout');
    expect(classifyTrajectoryOutcome(make('abort'))).toBe('aborted');
    expect(classifyTrajectoryOutcome(make('cancel'))).toBe('cancelled');
    expect(classifyTrajectoryOutcome(make('infra'))).toBe('infrastructure_error');
    // Eligibility: only real execution outcomes train the policy.
    expect(isLearningOutcome('succeeded')).toBe(true);
    expect(isLearningOutcome('failed')).toBe(true);
    expect(isLearningOutcome('timeout')).toBe(true);
    expect(isLearningOutcome('aborted')).toBe(false);
    expect(isLearningOutcome('cancelled')).toBe(false);
    expect(isLearningOutcome('infrastructure_error')).toBe(false);
  });

  it('scores a failed trajectory from verifiable signals without any model call', () => {
    const request = {
      sessionId: 'session-pr4',
      task: TASK,
      patch: patchVariant('p', 'guardrails-1', () => CLOCK_START),
      executor: async () => ({}) as never
    } as unknown as ProbeBranchRequest;
    const failed = makeTrajectory({
      id: 't-fail',
      branchId: 'b',
      request,
      result: { status: 'succeeded' } as ProbeExecutionResult,
      outcome: 'fail',
      startedAt: 0,
      endedAt: 1
    });
    const score = scoreTrajectorySignals(failed);
    expect(score.outcome).toBe('failed');
    expect(score.learningEligible).toBe(true);
    expect(score.reward).toBeLessThan(0);
    expect(score.sources).toHaveProperty('turn');
  });
});

// ---------------------------------------------------------------------------
// 6.1: association chain fields and versions
// ---------------------------------------------------------------------------

describe('6.1: the association chain is persisted', () => {
  it('stamps every new record with the full chain and the current versions', async () => {
    const harness = makeHarness({
      rounds: { 1: [{ kind: 'explore_domain', guidance: 'memory' }] },
      maxDepth: 1,
      outcomes: { 'r1-branch-0': 'succeed' },
      stepRewards: [1],
      candidateCount: 3
    });
    await harness.orchestrator.run({
      sessionId: 'session-pr4',
      task: TASK as never,
      trigger: 'always'
    });

    const records = onlineRecords(harness.store);
    expect(records.length).toBeGreaterThanOrEqual(2);
    for (const record of records) {
      expect(record.decisionId).toBeTypeOf('string');
      expect(record.runId).toBeTypeOf('string');
      expect(record.round).toBe(1);
      expect(record.slotIndex).toBeTypeOf('number');
      expect(record.treeId).toBeTypeOf('string');
      expect(record.nodeId).toBeTypeOf('string');
      expect(record.parentNodeId).toBeTypeOf('string');
      expect(record.trajectoryId).toBeTypeOf('string');
      expect(record.branchId).toBeTypeOf('string');
      expect(record.level).toBeTypeOf('string');
      expect(record.actionKey.length).toBeGreaterThan(0);
      expect(record.guidance).toBeTypeOf('string');
      expect(record.policyVersion).toBe(POLICY.id + '@v7');
      // P6.1-D: the RewardContract version (bumped from r2/verifiable-v1 when
      // the winner-only scoring fork was removed; the bump rule lives in
      // src/jitrl/reward-contract.ts).
      expect(record.rewardVersion).toBe(REWARD_CONTRACT.version);
      // P6.1-D2 / R3 F1-a: the store's persisted version constant now POINTS
      // AT the contract, so the orchestrator's stamp and the store's marker are
      // one source of truth (previously the store stayed on r2 while records
      // were written r3 - that split is what this assertion used to pin).
      expect(record.rewardVersion).toBe(CURRENT_REWARD_VERSION);
      expect(record.provenanceVersion).toBe(CURRENT_PROVENANCE_VERSION);
      expect(record.experienceSchemaVersion).toBe(EXPERIENCE_SCHEMA_VERSION);
      expect(record.observedReturn).toBeTypeOf('number');
      expect(record.attributionBaseline).toBeTypeOf('number');
      expect(record.learningTarget).toBeTypeOf('number');
    }
  });

  it('round-trips every association field through the durable JSONL store', async () => {
    // The persisted format must carry the chain: the store normalizes each
    // field, so a silent drop would be a data-loss bug on restart.
    const { createJsonlExperienceStore } = await import('../../../src/jitrl/stores/jsonl.store');
    const files = new Map<string, string>();
    const fs = {
      async appendDurable(filePath: string, contents: string): Promise<void> {
        files.set(filePath, (files.get(filePath) ?? '') + contents);
      },
      async readText(filePath: string): Promise<string | undefined> {
        return files.get(filePath);
      },
      async replaceAtomic(filePath: string, contents: string): Promise<void> {
        files.set(filePath, contents);
      }
    };
    const store = await createJsonlExperienceStore({ filePath: '/tmp/pr4.jsonl', fs });
    const record: ExperienceRecord = {
      id: 'online-pr4',
      level: 'proposal',
      state: { level: 'proposal', bucket: 'b', tokens: ['t'], summary: '' },
      actionKey: 'slot:explore_domain',
      reward: -1,
      return: -1,
      rewardSources: { turn: -1 },
      guidance: 'memory',
      policyId: POLICY.id,
      sessionId: 'session-pr4',
      treeId: 'tree-1',
      nodeId: 'node-1',
      branchId: 'branch-1',
      scopeKey: 'session-pr4::branch-1',
      decisionId: 'jit-decision-run-1-r1-s0',
      runId: 'run-1',
      round: 1,
      slotIndex: 0,
      parentNodeId: 'root',
      trajectoryId: 'traj-1',
      policyVersion: 'pr4-policy@v7',
      rewardVersion: CURRENT_REWARD_VERSION,
      provenanceVersion: CURRENT_PROVENANCE_VERSION,
      experienceSchemaVersion: EXPERIENCE_SCHEMA_VERSION,
      observedReturn: -1,
      attributionBaseline: 0.5,
      learningTarget: -1.5,
      outcome: 'failed',
      learningEligible: true,
      createdAt: 1,
      redacted: true
    };
    await store.append([record]);
    const reopened = await createJsonlExperienceStore({ filePath: '/tmp/pr4.jsonl', fs });
    const loaded = reopened.snapshot();
    expect(loaded).toHaveLength(1);
    const restored = loaded[0];
    for (const field of [
      'decisionId',
      'runId',
      'round',
      'slotIndex',
      'parentNodeId',
      'trajectoryId',
      'branchId',
      'scopeKey',
      'policyVersion',
      'rewardVersion',
      'provenanceVersion',
      'experienceSchemaVersion',
      'observedReturn',
      'attributionBaseline',
      'learningTarget',
      'outcome',
      'learningEligible'
    ] as const) {
      expect(restored?.[field]).toEqual(record[field]);
    }
  });
});

// ---------------------------------------------------------------------------
// 6.5: legacy isolation and the reversible migration
// ---------------------------------------------------------------------------

describe('6.5: legacy records are isolated, not rewritten', () => {
  function legacyRecord(id: string): ExperienceRecord {
    return {
      id,
      level: 'meta',
      state: { level: 'meta', bucket: 'b', tokens: ['t'], summary: '' },
      actionKey: 'slot:exploit',
      reward: 2,
      return: 2,
      rewardSources: { surrogate: 2 },
      guidance: 'memory',
      policyId: POLICY.id,
      sessionId: 'session-legacy',
      treeId: 'tree-legacy',
      nodeId: 'node-legacy',
      createdAt: 1,
      redacted: true
    };
  }

  function currentRecord(id: string): ExperienceRecord {
    return {
      ...legacyRecord(id),
      experienceSchemaVersion: EXPERIENCE_SCHEMA_VERSION,
      rewardVersion: CURRENT_REWARD_VERSION,
      provenanceVersion: CURRENT_PROVENANCE_VERSION,
      outcome: 'succeeded',
      learningEligible: true,
      observedReturn: 2,
      attributionBaseline: 1,
      learningTarget: 1,
      trajectoryId: 'traj-current',
      round: 1,
      slotIndex: 0
    };
  }

  it('classifies a record without a schema version as legacy', () => {
    expect(classifyExperienceVersion(legacyRecord('l1'))).toBe('legacy');
    expect(classifyExperienceVersion(currentRecord('c1'))).toBe('current');
    expect(
      classifyExperienceVersion({ ...currentRecord('c2'), learningEligible: false })
    ).toBe('ineligible');
  });

  it('excludes legacy records from a version-filtered query but keeps them readable', async () => {
    const store = createMemoryExperienceStore({ now: () => 100 });
    await store.append([legacyRecord('legacy-1'), currentRecord('current-1')]);
    const state = { level: 'meta' as const, bucket: 'b', tokens: ['t'], summary: '' };

    const all = await store.query({ level: 'meta', state, k: 10, similarityThreshold: 0 });
    expect(all.map((entry) => entry.record.id).sort()).toEqual(['current-1', 'legacy-1']);

    const learning = await store.query({
      level: 'meta',
      state,
      k: 10,
      similarityThreshold: 0,
      excludeLegacy: true
    });
    expect(learning.map((entry) => entry.record.id)).toEqual(['current-1']);

    // Audit access is preserved: the legacy record is still in the store.
    expect(await store.size('meta')).toBe(2);
  });

  it('migrates by producing marked copies and never rewrites the source', async () => {
    const source = [legacyRecord('legacy-1'), legacyRecord('legacy-2'), currentRecord('current-1')];
    const before = JSON.stringify(source);

    const dryRun = await migrateExperienceRecords({ records: source });
    expect(dryRun.current).toBe(1);
    expect(dryRun.legacy).toBe(2);
    expect(dryRun.excludedFromLearning).toBe(2);
    expect(dryRun.marked).toHaveLength(2);
    for (const marked of dryRun.marked) {
      expect(marked.rewardVersion).toBe('legacy');
      expect(marked.learningEligible).toBe(false);
      // Same id and payload: it is a copy, not a rewrite.
      expect(source.some((record) => record.id === marked.id)).toBe(true);
    }
    // The input array is byte-identical after the pass.
    expect(JSON.stringify(source)).toBe(before);

    // apply=true writes ONLY to the injected audit sink.
    const appended: ExperienceRecord[] = [];
    const applied = await migrateExperienceRecords({
      records: source,
      apply: true,
      auditSink: { append: async (batch) => void appended.push(...batch) }
    });
    expect(applied.marked).toHaveLength(2);
    expect(appended.map((record) => record.id).sort()).toEqual(['legacy-1', 'legacy-2']);
    expect(JSON.stringify(source)).toBe(before);
  });

  it('rolls the migration back by dropping the audit sink', async () => {
    const source = [legacyRecord('legacy-1'), currentRecord('current-1')];
    // The rollback is structural: the source was never modified, so the
    // pre-migration state is still exactly what a reader sees.
    await migrateExperienceRecords({ records: source, apply: true });
    const partition = partitionExperienceRecords(source);
    expect(partition.learning.map((record) => record.id)).toEqual(['current-1']);
    expect(partition.auditOnly.map((record) => record.id)).toEqual(['legacy-1']);
    // Re-partitioning the untouched source restores the same split.
    expect(partitionExperienceRecords(source).learning).toHaveLength(1);
  });

  it('keeps legacy aggregates out of the mirror snapshot', async () => {
    const snapshot = [legacyRecord('legacy-1'), currentRecord('current-1'), currentRecord('current-2')];
    const visible = mirrorVisibleRecords(snapshot);
    expect(visible.current.map((record) => record.id).sort()).toEqual(['current-1', 'current-2']);
    expect(visible.legacyExcluded).toBe(1);
    expect(visible.isolated).toBe(true);
    expect(visible.rewardVersion).toBe(CURRENT_REWARD_VERSION);

    // A clean snapshot reports no isolation.
    const clean = mirrorVisibleRecords([currentRecord('current-3')]);
    expect(clean.isolated).toBe(false);
    expect(clean.legacyExcluded).toBe(0);
  });

  it('partitions a mixed snapshot by version in the pure store helper', () => {
    const partitioned = partitionByVersion([legacyRecord('l'), currentRecord('c')]);
    expect(partitioned.learning).toHaveLength(1);
    expect(partitioned.legacy).toHaveLength(1);
    expect(partitioned.ineligible).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6.4: the write barrier and deduplication
// ---------------------------------------------------------------------------

describe('6.4: the commit barrier and deduplication', () => {
  it('writes once per run and is explicit about cross-run visibility', async () => {
    const harness = makeHarness({
      rounds: {
        1: [{ kind: 'explore_domain', guidance: 'memory' }],
        2: [{ kind: 'exploit', guidance: 'memory' }]
      },
      maxDepth: 2,
      outcomes: { 'r1-branch-0': 'succeed', 'r2-branch-0': 'succeed' },
      stepRewards: [1]
    });
    await harness.orchestrator.run({
      sessionId: 'session-pr4',
      task: TASK as never,
      trigger: 'always'
    });
    const stages = harness.events.map((event) => event.stage);
    // Exactly ONE record_experience stage for the whole run: the barrier is the
    // run's commit point (documented as cross-run learning).
    expect(stages.filter((stage) => stage === 'record_experience')).toHaveLength(1);
    // Every round still landed, so "cross-run" loses nothing.
    const rounds = new Set(metaRecords(harness.store).map((record) => record.round));
    expect([...rounds].sort()).toEqual([1, 2]);
  });

  it('does not append the same execution twice', async () => {
    const harness = makeHarness({
      rounds: { 1: [{ kind: 'explore_domain', guidance: 'memory' }] },
      maxDepth: 1,
      outcomes: { 'r1-branch-0': 'succeed' },
      stepRewards: [1]
    });
    await harness.orchestrator.run({
      sessionId: 'session-pr4',
      task: TASK as never,
      trigger: 'always'
    });
    const ids = onlineRecords(harness.store).map((record) => record.id);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = onlineRecords(harness.store).map((record) =>
      [record.level, record.actionKey, record.nodeId, record.trajectoryId, record.round].join('|')
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// ---------------------------------------------------------------------------
// 6.6 (6): the structural guard against "copy the winner's return"
// ---------------------------------------------------------------------------

describe('6.6 (6): reverting to a shared winner return must fail', () => {
  /**
   * The pre-fix shape was: ONE `returnG` computed from the winner, assigned to
   * every L1 record of the last batch and to every L2 record. These assertions
   * fail immediately if that shape comes back, because they require the returns
   * inside one batch to differ and to be derived per execution.
   */
  it('never lets two different executions share one return value', async () => {
    const harness = makeHarness({
      rounds: {
        1: [
          { kind: 'explore_domain', guidance: 'memory' },
          { kind: 'explore_domain', guidance: 'memory' }
        ]
      },
      maxDepth: 1,
      outcomes: { 'r1-branch-0': 'succeed', 'r1-branch-1': 'fail' },
      stepRewards: [3, 3],
      candidateCount: 3
    });
    await harness.orchestrator.run({
      sessionId: 'session-pr4',
      task: TASK as never,
      trigger: 'always'
    });

    const records = onlineRecords(harness.store);
    // Group by round: a single shared `returnG` would make every group a
    // one-element set.
    const byRound = new Map<number, Set<number>>();
    for (const record of records) {
      const round = record.round ?? 0;
      const set = byRound.get(round) ?? new Set<number>();
      set.add(Number(record.return.toFixed(6)));
      byRound.set(round, set);
    }
    for (const [round, returns] of byRound) {
      expect(returns.size, 'round ' + String(round) + ' shares one return').toBeGreaterThan(1);
    }

    // And every record's return must equal its own observedReturn, i.e. it was
    // computed for that execution instead of copied from another.
    for (const record of records) {
      expect(record.return).toBeCloseTo(record.observedReturn ?? Number.NaN, 6);
    }

    // The winner's step vector appears exactly once (on the winner's own
    // record), never replicated across the batch.
    const winnerTrajectoryId = harness.evaluatorCalls[0]?.id;
    const withWinnerVector = records.filter(
      (record) => record.trajectoryId === winnerTrajectoryId
    );
    expect(withWinnerVector.length).toBeGreaterThan(0);
    for (const record of withWinnerVector) {
      expect(record.return).toBeGreaterThan(0);
    }
    const others = records.filter((record) => record.trajectoryId !== winnerTrajectoryId);
    expect(others.length).toBeGreaterThan(0);
    for (const record of others) {
      expect(record.return).toBeLessThanOrEqual(0);
    }
  });

  it('does not carry a winner return across rounds', async () => {
    const harness = makeHarness({
      rounds: {
        1: [{ kind: 'explore_domain', guidance: 'memory' }],
        2: [{ kind: 'exploit', guidance: 'memory' }]
      },
      maxDepth: 2,
      outcomes: { 'r1-branch-0': 'fail', 'r2-branch-0': 'succeed' },
      stepRewards: [3, 3]
    });
    await harness.orchestrator.run({
      sessionId: 'session-pr4',
      task: TASK as never,
      trigger: 'always'
    });
    const meta = metaRecords(harness.store);
    const roundOne = meta.find((record) => record.round === 1);
    const roundTwo = meta.find((record) => record.round === 2);
    // Round 1 failed; round 2 won. A copied return would make them equal.
    expect(roundOne?.outcome).toBe('failed');
    expect(roundTwo?.outcome).toBe('succeeded');
    expect(roundOne?.return).toBeLessThan(0);
    expect(roundTwo?.return).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// P6.1-D (plan section 7.4): the six discriminating RewardContract cases
// ---------------------------------------------------------------------------

describe('P6.1-D 7.4: one RewardContract, one yardstick', () => {
  // ①相同轨迹不因是否 composer 赢家而得到不同主目标
  it('① the same trajectory scores the same primary target whether or not it is the composer winner', async () => {
    // Two IDENTICAL succeeded siblings: identical metrics, steps, deliverable
    // and outcome. The composer picks the first as winner, so exactly one of
    // them is "the winner". Under the RewardContract their primary targets
    // (reward / observedReturn) must be EQUAL - the pre-P6.1-D fork gave the
    // winner the step-evaluator mean and the sibling the signal score.
    const harness = makeHarness({
      rounds: {
        1: [
          { kind: 'explore_domain', guidance: 'memory' },
          { kind: 'explore_domain', guidance: 'memory' }
        ]
      },
      maxDepth: 1,
      outcomes: { 'r1-branch-0': 'succeed', 'r1-branch-1': 'succeed' },
      // A step vector deliberately different from the signal score so the old
      // fork produced visibly different numbers.
      stepRewards: [3, 3]
    });
    await harness.orchestrator.run({
      sessionId: 'session-p61d',
      task: TASK as never,
      trigger: 'always'
    });

    const meta = metaRecords(harness.store);
    expect(meta).toHaveLength(2);
    // The winner was still evaluated exactly once (cost is unchanged)...
    expect(harness.evaluatorCalls).toHaveLength(1);
    const winnerTrajectoryId = harness.evaluatorCalls[0]?.id;
    const winnerRecord = meta.find((record) => record.trajectoryId === winnerTrajectoryId);
    const siblingRecord = meta.find((record) => record.trajectoryId !== winnerTrajectoryId);
    expect(winnerRecord).toBeDefined();
    expect(siblingRecord).toBeDefined();

    // ...but the primary target is identical: same trajectory, same scale.
    expect(winnerRecord?.reward).toBeCloseTo(siblingRecord?.reward ?? Number.NaN, 12);
    expect(winnerRecord?.observedReturn).toBeCloseTo(siblingRecord?.observedReturn ?? Number.NaN, 12);
    expect(winnerRecord?.return).toBeCloseTo(siblingRecord?.return ?? Number.NaN, 12);
    // And that scale is the RewardContract aggregation, not the evaluator
    // mean (stepRewards [3,3] would give 3 under the old winner path).
    const expected = scoreUnderRewardContract(
      harness.seams.trajectories.get('r1-branch-0') as ProbeTrajectory
    ).reward;
    expect(winnerRecord?.reward).toBeCloseTo(expected, 12);
    // The winner's step vector survives ONLY as the auxiliary stepJudge source.
    expect(winnerRecord?.rewardSources.stepJudge).toBeCloseTo(3, 12);
    expect(siblingRecord?.rewardSources.stepJudge).toBeUndefined();
    // Every record is stamped with the contract version and one scale.
    for (const record of meta) {
      expect(record.rewardVersion).toBe(REWARD_CONTRACT.version);
    }
  });

  // ②judge 缺失或失败不改变 rewardVersion 隐含语义
  it('② a missing or failed judge leaves the rewardVersion semantics unchanged', async () => {
    const runOnce = async (
      mode: 'healthy' | 'throws' | 'empty'
    ): Promise<readonly ExperienceRecord[]> => {
      const harness = makeHarness({
        rounds: { 1: [{ kind: 'explore_domain', guidance: 'memory' }] },
        maxDepth: 1,
        outcomes: { 'r1-branch-0': 'succeed' },
        stepRewards: [3, 3],
        ...(mode === 'healthy' ? {} : mode === 'throws' ? { evaluatorThrows: true } : { evaluatorEmpty: true })
      });
      await harness.orchestrator.run({
        sessionId: 'session-p61d',
        task: TASK as never,
        trigger: 'always'
      });
      return metaRecords(harness.store);
    };

    const healthy = await runOnce('healthy');
    const throwing = await runOnce('throws');
    const empty = await runOnce('empty');
    expect(healthy).toHaveLength(1);
    expect(throwing).toHaveLength(1);
    expect(empty).toHaveLength(1);

    // Same yardstick, same version, same primary target in all three cases:
    // the judge is an auxiliary field; its failure (or absence) cannot change
    // what the rewardVersion means.
    const expected = healthy[0]?.reward;
    for (const records of [throwing, empty]) {
      const record = records[0];
      expect(record?.rewardVersion).toBe(healthy[0]?.rewardVersion);
      expect(record?.reward).toBeCloseTo(expected ?? Number.NaN, 12);
      expect(record?.observedReturn).toBeCloseTo(healthy[0]?.observedReturn ?? Number.NaN, 12);
      expect(record?.learningTarget).toBeCloseTo(healthy[0]?.learningTarget ?? Number.NaN, 12);
      expect(record?.rewardSources.stepJudge).toBeUndefined();
    }
    // Only the healthy judge produced the auxiliary entry.
    expect(healthy[0]?.rewardSources.stepJudge).toBeTypeOf('number');
  });

  // ③任务要求交付物时缺交付物不能与验证完成得相同目标
  it('③ a succeeded run without the required deliverable cannot match the verified one', () => {
    const request = {
      sessionId: 'session-p61d',
      task: TASK,
      patch: patchVariant('p61d', 'guardrails-1', () => CLOCK_START),
      executor: async () => ({}) as never
    } as unknown as ProbeBranchRequest;
    const make = (delivered: boolean): ProbeTrajectory =>
      ({
        ...makeTrajectory({
          id: delivered ? 't-delivered' : 't-empty',
          branchId: 'b',
          request,
          result: { status: 'succeeded' } as ProbeExecutionResult,
          outcome: 'succeed',
          startedAt: 0,
          endedAt: 1
        }),
        ...(delivered ? {} : { deliverable: undefined })
      }) as ProbeTrajectory;

    const delivered = scoreUnderRewardContract(make(true));
    const empty = scoreUnderRewardContract(make(false));
    expect(delivered.reward).toBeGreaterThan(empty.reward);
    expect(delivered.sources.completion).toBe(COMPLETION_SIGNAL);
    expect(empty.sources.completion).toBe(MISSING_DELIVERABLE_SIGNAL);
  });

  // ④增加无意义成功工具调用不应无限提高任务质量目标
  it('④ padding with meaningless successful tool calls cannot inflate the target', () => {
    const request = {
      sessionId: 'session-p61d',
      task: TASK,
      patch: patchVariant('p61d', 'guardrails-1', () => CLOCK_START),
      executor: async () => ({}) as never
    } as unknown as ProbeBranchRequest;
    const make = (toolCalls: number, steps: number): ProbeTrajectory =>
      makeTrajectory({
        id: 't-pad-' + String(toolCalls),
        branchId: 'b',
        request,
        result: { status: 'succeeded' } as ProbeExecutionResult,
        outcome: 'succeed',
        startedAt: 0,
        endedAt: 1
      }) as ProbeTrajectory & { metrics: { steps: number; toolCalls: number } };
    // The signal scorer derives tool stats from trajectory.metrics; rebuild it.
    const padded = (toolCalls: number, steps: number): ProbeTrajectory => {
      const base = make(toolCalls, steps);
      return {
        ...base,
        metrics: { ...base.metrics, toolCalls, toolErrors: 0, steps }
      };
    };

    const scores = [1, 5, 20, 100].map((calls) => scoreUnderRewardContract(padded(calls, 2)).reward);
    // Not monotonic in call count: the step-budget term and the clip bound the
    // total, so padding cannot raise the objective without bound...
    expect(Math.max(...scores)).toBeLessThanOrEqual(3);
    // ...and beyond a handful of calls MORE padding does not help: the step
    // efficiency penalty and the clip dominate.
    expect(scores[3] ?? 0).toBeLessThanOrEqual(scores[1] ?? 3);
  });

  // ⑤cancelled/infra error 不进入质量学习
  it('⑤ cancelled and infrastructure trajectories never enter quality learning', async () => {
    const cancelled = makeHarness({
      rounds: { 1: [{ kind: 'explore_domain', guidance: 'memory' }] },
      maxDepth: 1,
      outcomes: { 'r1-branch-0': 'cancel' },
      stepRewards: [3, 3]
    });
    await cancelled.orchestrator.run({
      sessionId: 'session-p61d',
      task: TASK as never,
      trigger: 'always'
    });
    // candidateCount defaults to 1, so exactly the L1 record exists.
    const cancelledRecords = onlineRecords(cancelled.store);
    expect(cancelledRecords).toHaveLength(1);
    for (const record of cancelledRecords) {
      expect(record.outcome).toBe('cancelled');
      expect(record.learningEligible).toBe(false);
      expect(record.learningTarget).toBe(0);
      expect(record.reward).toBe(0);
    }

    const infra = makeHarness({
      rounds: { 1: [{ kind: 'explore_domain', guidance: 'memory' }] },
      maxDepth: 1,
      outcomes: { 'r1-branch-0': 'infra' },
      stepRewards: [3, 3]
    });
    await infra.orchestrator.run({
      sessionId: 'session-p61d',
      task: TASK as never,
      trigger: 'always'
    });
    for (const record of onlineRecords(infra.store)) {
      expect(record.outcome).toBe('infrastructure_error');
      expect(record.learningEligible).toBe(false);
      expect(record.learningTarget).toBe(0);
    }
  });

  // ⑥estimator 日志写明实际读取的 target 字段及版本（不能只在 JSONL 展示）
  it('⑥ the estimator log names the consumed target field and the reward version', async () => {
    const harness = makeHarness({
      rounds: { 1: [{ kind: 'explore_domain', guidance: 'memory' }] },
      maxDepth: 1,
      outcomes: { 'r1-branch-0': 'succeed' },
      stepRewards: [2]
    });
    await harness.orchestrator.run({
      sessionId: 'session-p61d',
      task: TASK as never,
      trigger: 'always'
    });

    // The record_experience stage detail carries the estimator's target line
    // OUTSIDE the JSONL: field + version are visible without reading records.
    const event = harness.events.find((entry) => entry.stage === 'record_experience');
    expect(event).toBeDefined();
    const payload = event?.detail as { readonly detail?: Record<string, unknown> } | undefined;
    const detail = payload?.detail;
    expect(detail?.rewardVersion).toBe(REWARD_CONTRACT.version);
    expect(detail?.rewardScale).toBe(REWARD_CONTRACT.aggregation);
    expect(detail?.rewardTargetField).toBe(REWARD_CONTRACT.learningTargetField);
    const line = String(detail?.estimatorTarget);
    expect(line).toContain('target field ' + REWARD_CONTRACT.learningTargetField);
    expect(line).toContain('observedReturn=');
    expect(line).toContain('rewardVersion=' + REWARD_CONTRACT.version);

    // The same line can be derived for an arbitrary neighbour set (the value
    // estimator's own view), proving the fact does not live only in JSONL.
    const records = onlineRecords(harness.store);
    const derived = estimatorTargetLine(records, REWARD_CONTRACT.version);
    expect(derived).toContain('rewardVersion=' + REWARD_CONTRACT.version);
    expect(derived).toContain('observedReturn=' + String(records.length));
  });
});
