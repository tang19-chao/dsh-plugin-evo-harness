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
import {
  EVO_HARNESS_STAGES,
  MAX_CARRIED_PROPOSAL_FAILURES,
  carryProposalFailure,
  proposalFailureSignalOf
} from '../../../src/orchestrator';
import { DshModelStreamError } from '../../../src/dsh-bridge/model';
import { MeteredModelError } from '../../../src/dsh-bridge/metered-model-adapter';
import { Harness2ProposalError } from '../../../src/harness2/proposer';
import { createDefaultConfig, parseEvoHarnessConfig } from '../../../src/config';
import { TEXT_PROBE_SURFACES } from '../../../src/runtime/surface-evaluability';
import { createDiscoveryTreePool, classifyFailure } from '../../../src/dream-rsi';
import type { FailureDiagnosisRequest, IFailureTaxonomy } from '../../../src/dream-rsi';
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
import { createHostOwnedVerificationRunner } from '../../../src/verification';
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
  PlanGridRequest,
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
        // PR-B fixture fidelity: the executor's deliverable is part of the
        // executed trajectory. Dropping it here turned every successful run
        // into "claimed success without a deliverable" (structural verdict
        // failed), which the C2-pre eligibility rules keep audit-only.
        ...(result.deliverable === undefined ? {} : { deliverable: result.deliverable }),
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

/**
 * A3 fixture: a patch whose ONLY edit is a generated script. No text probe can
 * execute it, so the orchestrator must skip it before node/probe/write-back.
 * (The real proposer would drop it once allowedSurfaces is restricted; this
 * fixture exercises the orchestrator guard that also covers injected proposers
 * and memory-augmented lessons.)
 */
function scriptsOnlyPatch(now: () => number): EightSurfacePatch {
  return {
    id: 'patch-scripts-only',
    sessionId: 'session-p3',
    branchId: 'branch-0',
    origin: 'domain',
    purpose: 'explore',
    guidance: 'memory',
    label: 'scripts-only',
    rationale: 'mock proposal that a text probe cannot evaluate',
    edits: {
      scripts: {
        kind: 'scripts',
        scripts: [{ path: 'probe.sh', language: 'bash', code: 'echo probe' }]
      }
    },
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
  candidatesPerCall: number,
  proposalPatches?: readonly EightSurfacePatch[]
): { readonly proposer: CountingProposer; readonly patches: readonly EightSurfacePatch[] } {
  const patches = proposalPatches ?? [
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
  /**
   * A3 fixtures: replace the proposer's patch set. Used by the
   * non-evaluable-surface test, which needs a scripts-only proposal the real
   * proposer could never emit once `allowedSurfaces` is restricted.
   */
  readonly proposalPatches?: readonly EightSurfacePatch[];
  /**
   * A3 fixture: override the config surface list. Used by the empty-intersection
   * test, where every enabled surface is non-evaluable.
   */
  readonly enabledSurfaces?: readonly HarnessComponentKey[];
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
  /**
   * rev6 A4-3: install a real host verifier so records are EVALUABLE and can
   * enter the L1 neighbourhood. Without it, text probes are audit-only by
   * contract and a support assertion would be testing the absence of data.
   */
  readonly trustedVerifier?: boolean;
  /**
   * rev8 §3.1 gap 2 fixture: replace the whole proposer (scripted failures).
   * Used by the proposal-failure-carries-to-plan_grid tests, which need a
   * proposer whose error class and failure code the test controls exactly.
   */
  readonly proposer?: IHarnessProposer;
  /**
   * rev8 §3.1 gap 2 fixture: wrap the mock policy (planGrid recorder) so a test
   * can observe the previousFailures array each plan_grid call received.
   */
  readonly policy?: IActivePolicy;
  /**
   * rev8 §3.1 gap 2 fixture: taxonomy override so a test can classify the
   * dropped-proposal signal with the REAL classifier while still recording
   * every diagnosis request.
   */
  readonly taxonomy?: IFailureTaxonomy;
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
    ...(options.enabledSurfaces === undefined
      ? {}
      : { enabledSurfaces: [...options.enabledSurfaces] }),
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

  const { proposer, patches } = makeProposer(
    now,
    options.candidatesPerCall ?? 3,
    options.proposalPatches
  );
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
        failureSignals: [{ kind: 'tool_error', message: 'baseline failed', repairable: true }],
        ...(options.trustedVerifier === true
          ? { deliverable: { content: 'baseline-bad', format: 'text' as const } }
          : {})
      } as unknown as ProbeExecutionResult;
    }
    return {
      status: 'succeeded',
      steps: [{ index: 0, at: now(), kind: 'message', text: 'recovered' }],
      deliverable: {
        content: options.trustedVerifier === true ? 'candidate-ok' : 'recovered',
        format: 'text'
      },
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
          // A4-3: a trusted verdict puts the record on the task-quality track,
          // which the L1 process-only neighbourhood deliberately excludes. This
          // test is about the quality track being CONSUMABLE, so it opts into
          // the documented dual-track consumption switch.
          ...(options.trustedVerifier === true
            ? {
                dualTrack: {
                  enableQualityTrackConsumption: true,
                  // The support test observes the SECOND run, so exactly one
                  // quality record exists at that decision. The production
                  // default (2) would correctly treat that as insufficient and
                  // fall back to the empty process track; this test is about
                  // the key alignment, so it exercises the track with the
                  // documented 1-sample floor.
                  minQualityEffectiveSamples: 1
                }
              }
            : {}),
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
    policy: options.policy ?? (decorator ?? basePolicy),
    // rev8 §3.1 gap 2: a test can inject a scripted proposer (controlled error
    // class + failure code); the counting default stays for existing tests.
    proposer: options.proposer ?? proposer,
    composer: makeComposer(),
    reflector: makeReflector(),
    scorer: makeScorer(now),
    // rev8 §3.1 gap 2: a test can inject a REAL recording taxonomy; the
    // historical constant fallback stays the default so existing assertions
    // are byte-identical.
    taxonomy: options.taxonomy ?? { diagnose: () => NO_FAILURE },
    dreamer: makeDreamer(),
    treePool: createDiscoveryTreePool(),
    runBranch,
    now,
    newId: makeIdFactory('p3'),
    applyWinningPatch: false,
    jitrl: jitSurface,
    ...(options.trustedVerifier === true
      ? {
          verification: {
            runner: createHostOwnedVerificationRunner({
              verifierId: 'p3-host',
              verifierVersion: 'v1',
              testSetId: 'p3-tests-v1',
              envId: 'p3-env-v1',
              cases: [
                {
                  taskId: TASK.id,
                  checks: [
                    {
                      id: 'artifact-is-candidate-ok',
                      run: (artifact) => artifact.content === 'candidate-ok'
                    }
                  ]
                }
              ]
            })
          }
        }
      : {}),
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

    // P6.2 PR-B / F4-3: the prior/proposed/executed triple rides on every L2
    // record (decision marks in rewardSources), so attempted deviation and
    // actual deviation are countable separately from the store.
    const sources = proposal[0]?.rewardSources as Record<string, number | undefined>;
    expect(sources?.decisionPriorIndex).toBeDefined();
    expect(sources?.decisionProposedIndex).toBeDefined();
    expect(sources?.decisionExecutedIndex).toBeDefined();
    expect(sources?.decisionExecutedIndex).toBe(sources?.decisionProposedIndex);
    // No exploration was charged (the gate is off and no budget was granted).
    expect(sources?.exploration).toBeUndefined();
  });

  it('P6.2 PR-B F4-3: reports attempted and actual deviation separately in the stage detail', async () => {
    const harness = makeHarness({ candidatesPerCall: 3 });
    // Seed the same contrast the chosen-key test uses, so the L2 decision
    // genuinely runs and the ledger counters have one decision to count.
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
    await harness.store.append([
      {
        id: 'seed-proposal-1-negative',
        experienceSchemaVersion: EXPERIENCE_SCHEMA_VERSION,
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
        actionKey: normalizePatchSignature(favored),
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
    const record = (
      harness.events
        .filter((event) => event.stage === 'record_experience')
        .at(-1)?.detail as { readonly detail?: Record<string, unknown> } | undefined
    )?.detail;
    expect(record).toBeDefined();
    expect(record?.l2Decisions).toBe(1);
    expect(typeof record?.attemptedDeviations).toBe('number');
    expect(typeof record?.actualDeviations).toBe('number');
    expect(record?.explorationCharged).toBe(0);
    // The verifier-first rule is visible on the stage detail.
    expect(record?.verifierFirstRule).toBe('verifier-first-completion-v1');
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

    // The evaluator saw this run's single executed probe exactly once (A4-4
    // evaluates every probe; this fixture has one).
    expect(harness.evaluatorCalls).toHaveLength(1);

    // P6.1-D RewardContract: every executed probe - winner included - is
    // scored by the SAME trajectory-signal aggregation; the winner's step
    // vector survives only as the auxiliary rewardSources.stepJudge entry.
    //
    // rev6 A4-3: the fixture's deliverable is TEXT and no verifier is injected,
    // so the main chain correctly classifies the probe as `not-evaluable`: the
    // frozen reward column stays 0 (it must be finite) and the record is
    // audit-only. This replaced the old expectation that unreferenced prose
    // earned a ~0.383 process score.
    const expected = 0;
    const online = harness.store.snapshot().filter((record) => record.id.startsWith('online-'));
    expect(online.length).toBeGreaterThan(0);
    for (const record of online) {
      expect(record.return).toBeCloseTo(expected, 12);
      expect(record.reward).toBeCloseTo(expected, 12);
      expect(record.learningEligible).toBe(false);
      expect(record.rewardSources.notEvaluable).toBe(1);
      // P6.2 C0: explicit decision fields on every record (ADR R8).
      expect(record.decisionMode).toBe('shadow');
      expect(record.actionKeyVocabulary).toBe('signature');
      expect(record.rewardVersion).toBe('r4/verifier-first-v1');
    }
    // The judge's step vector is still visible, as the auxiliary entry only.
    const winnerRecord = online.find((record) => record.rewardSources.stepJudge !== undefined);
    expect(winnerRecord?.rewardSources.stepJudge).toBeCloseTo(
      (rewards[0] as number + (rewards[1] as number)) / 2,
      12
    );
  });

  it('keeps a claimed-success-without-deliverable run audit-only under the C2-pre rule (t6)', async () => {
    // The structural fallback marks "succeeded but nothing delivered" as a
    // FAILED verdict. The -1 completion is a verdict-derived task-quality
    // source, and C2-pre it is NOT learnable (no trusted provenance): the
    // record stays audit-only instead of becoming a negative training sample.
    // Trusted-failure learning is the explicit C2 unfinished item.
    const harness = makeHarness({ candidatesPerCall: 1 });
    // Strip the deliverable after the seam: simulate a claimed success with
    // no deliverable reaching the recorder.
    const originalRun = harness.orchestrator.run.bind(harness.orchestrator);
    const seams = harness.deps.seams as unknown as {
      runInIsolatedBranch: (request: ProbeBranchRequest) => Promise<ProbeTrajectory>;
    };
    const originalProbe = seams.runInIsolatedBranch.bind(seams);
    seams.runInIsolatedBranch = async (request) => {
      const trajectory = await originalProbe(request);
      if (request.role === 'candidate') {
        const { deliverable: _dropped, ...rest } = trajectory as ProbeTrajectory & {
          deliverable?: unknown;
        };
        return rest as ProbeTrajectory;
      }
      return trajectory;
    };
    void originalRun;
    await harness.orchestrator.run({
      sessionId: 'session-c2pre',
      task: TASK as never,
      trigger: 'always'
    });
    const online = harness.store
      .snapshot()
      .filter((record) => record.id.startsWith('online-'));
    expect(online.length).toBeGreaterThan(0);
    for (const record of online) {
      // Audit-only: no learning target, no trainability, but the negative
      // scale signal stays visible in the reward column.
      expect(record.learningEligible).toBe(false);
      expect(record.learningTarget).toBe(0);
    }
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
      withDecorator: true,
      // A4-3: an executable, host-verified artifact is what makes the record
      // learnable and therefore visible as L1 support.
      trustedVerifier: true,
      // The trusted record must support the action the L1 prior also chooses;
      // otherwise the quality track correctly reports insufficient evidence on
      // the prior and falls back to the empty process track.
      slots: [{ kind: 'exploit', guidance: 'memory' }]
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

// ---------------------------------------------------------------------------
// A3: proposer surface restriction + non-evaluable patch skip
// ---------------------------------------------------------------------------

describe('A3 evaluability: proposer only sees text-probe evaluable surfaces', () => {
  it('passes enabledSurfaces ∩ TEXT_PROBE_EVALUABLE to the single proposer', async () => {
    const harness = makeHarness({
      candidatesPerCall: 1,
      jitrl: { enabled: true, levels: ['meta'], candidateCount: 1 }
    });
    await harness.orchestrator.run({
      sessionId: 'session-p3',
      task: TASK as never,
      trigger: 'always'
    });

    expect(harness.proposer.requests).toHaveLength(1);
    const surfaces = harness.proposer.requests[0]?.enabledSurfaces;
    expect(surfaces).toBeDefined();
    expect([...(surfaces ?? [])]).toEqual([...TEXT_PROBE_SURFACES]);
    for (const excluded of ['scripts', 'subagents', 'plugins'] as const) {
      expect(surfaces ?? []).not.toContain(excluded);
    }
  });

  it('passes the same intersection to the K-candidate proposer', async () => {
    const harness = makeHarness({ candidatesPerCall: 3 });
    await harness.orchestrator.run({
      sessionId: 'session-p3',
      task: TASK as never,
      trigger: 'always'
    });

    expect(harness.proposer.candidateCalls).toBeGreaterThan(0);
    for (const request of harness.proposer.requests) {
      expect([...(request.enabledSurfaces ?? [])]).toEqual([...TEXT_PROBE_SURFACES]);
    }
  });

  it('skips the whole run when enabledSurfaces has no text-probe evaluable surface', async () => {
    const harness = makeHarness({
      enabledSurfaces: ['scripts', 'subagents', 'plugins'],
      jitrl: { enabled: true, levels: ['meta'], candidateCount: 1 }
    });
    const result = await harness.orchestrator.run({
      sessionId: 'session-p3',
      task: TASK as never,
      trigger: 'always'
    });

    expect(result.outcome).toBe('skipped');
    expect(result.probesRun).toBe(0);
    expect(result.metadata?.stopReason).toBe('no_evaluable_surfaces');
    expect(
      result.diagnostics.some((line) =>
        line.startsWith('probe surfaces:') && line.includes('no text-probe evaluable surface')
      )
    ).toBe(true);
    // No reference probe, no proposer call, no experience.
    expect(harness.probes).toEqual([]);
    expect(harness.proposer.requests).toHaveLength(0);
    expect(await harness.store.size()).toBe(0);
  });

  it('skips a scripts-only proposal before node creation, probing or write-back', async () => {
    const harness = makeHarness({
      candidatesPerCall: 1,
      proposalPatches: [scriptsOnlyPatch(() => CLOCK_START)],
      jitrl: { enabled: true, levels: ['meta'], candidateCount: 1 }
    });
    const result = await harness.orchestrator.run({
      sessionId: 'session-p3',
      task: TASK as never,
      trigger: 'always'
    });

    // The reference still ran; not a single candidate probe did.
    expect(result.probesRun).toBe(1);
    expect(candidateProbes(harness.probes)).toEqual([]);
    expect(result.outcome).toBe('no_probe');
    expect(result.metadata?.stopReason).toBe('proposals_not_evaluable');
    expect(
      result.diagnostics.some((line) =>
        line.startsWith('proposal-not-evaluable:') &&
        line.includes('scripts') &&
        line.includes('no node was added')
      )
    ).toBe(true);

    // No node was created beyond the reference root.
    const tree = result.treeId === undefined ? undefined : harness.orchestrator.treePool.get(result.treeId);
    expect(tree).toBeDefined();
    expect(tree?.stats.nodeCount).toBe(1);

    // No online experience was written: the store is byte-identical (empty).
    expect(await harness.store.size()).toBe(0);
    expect(harness.evaluatorCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// rev8 plan §3.1 gap 2 (harness2 #110 companion): a dropped proposal is fed to
// the failure taxonomy and carried into the NEXT run's plan_grid.
//
// Deterministic contract:
//  - run 1's plan_grid still sees previousFailures: [] (nothing has failed yet);
//  - the proposer's transport error is classified through the SAME injected
//    taxonomy the probes use (one diagnose() call per dropped slot);
//  - a transport-class failure (stream abort / gateway 429) maps to kind
//    'unknown' + retryable, so the REAL classifier must NOT report
//    hard_unrecoverable - a flapping gateway is never a model refusal and never
//    stops the run;
//  - the metered adapter's typed METERED_MODEL_* denial maps to 'model_refusal',
//    which the REAL classifier DOES report as hard_unrecoverable - the two
//    failure classes stay distinguishable end to end;
//  - run 2's plan_grid receives the carried diagnoses in previousFailures and
//    the result metadata carries an additive proposerFailures count block;
//  - a run with no proposal failure clears the carry (previousFailures: []).
// ---------------------------------------------------------------------------

/** Wraps the file's mock policy, recording every plan_grid request. */
function makePlanGridRecordingPolicy(base: IActivePolicy): IActivePolicy & {
  readonly planGridRequests: PlanGridRequest[];
} {
  const planGridRequests: PlanGridRequest[] = [];
  return {
    planGridRequests,
    get policy(): MetaSearchPolicy {
      return base.policy;
    },
    planGrid(request: PlanGridRequest): SearchGridPlan {
      planGridRequests.push(request);
      return base.planGrid(request);
    },
    selectBatch(request: SelectBatchRequest): BatchPlan {
      return base.selectBatch(request);
    },
    update(policy: MetaSearchPolicy): void {
      base.update(policy);
    }
  };
}

/** Taxonomy over the REAL classifier, recording every diagnosis request. */
function makeRecordingRealTaxonomy(): IFailureTaxonomy & {
  readonly requests: FailureDiagnosisRequest[];
} {
  const requests: FailureDiagnosisRequest[] = [];
  return {
    requests,
    diagnose(request: FailureDiagnosisRequest) {
      requests.push(request);
      return classifyFailure(request);
    }
  };
}

/** A proposer that throws the SAME scripted error for every slot. */
function makeFailingProposer(errors: readonly unknown[]): IHarnessProposer {
  let call = 0;
  return {
    async propose(): Promise<ProposedPatch> {
      const error = errors[Math.min(call, errors.length - 1)];
      call += 1;
      throw error;
    }
  };
}

describe('proposal failures feed the failure taxonomy and the next plan_grid (rev8 §3.1 gap 2)', () => {
  it('carries a transport-class proposal failure into the next run plan_grid without hard_unrecoverable', async () => {
    const basePolicy = makePolicy();
    const policy = makePlanGridRecordingPolicy(basePolicy);
    const taxonomy = makeRecordingRealTaxonomy();
    // One stream abort (the #110/#13 transport surface), forever: every slot of
    // every round fails the same deterministic way.
    const harness = makeHarness({
      proposer: makeFailingProposer([
        new DshModelStreamError('cut off mid-stream', 'aborted')
      ]),
      policy,
      taxonomy,
      jitrl: { enabled: true, levels: ['meta'], candidateCount: 1 }
    });

    const first = await harness.orchestrator.run({
      sessionId: 'session-p3',
      task: TASK as never,
      trigger: 'always'
    });
    void first;
    expect(policy.planGridRequests.length).toBeGreaterThanOrEqual(1);
    // Run 1 planned BEFORE any proposal ran: empty carry, byte-identical to rev6.
    expect(policy.planGridRequests[0]?.previousFailures).toEqual([]);

    // The dropped slot reached the REAL classifier with exactly one typed signal.
    expect(taxonomy.requests.length).toBeGreaterThanOrEqual(1);
    const firstSignals = taxonomy.requests[0]?.signals ?? [];
    const signal = firstSignals[0];
    expect(signal?.kind).toBe('unknown');
    expect(signal?.retryable).toBe(true);
    expect(signal?.message).toContain('cut off mid-stream');

    // The transport signal must NOT be hard_unrecoverable: a flapping gateway
    // is neither a model refusal nor a budget exhaustion.
    const diagnosis = classifyFailure({ signals: signal === undefined ? [] : [signal] });
    expect(diagnosis.category).not.toBe('hard_unrecoverable');

    // Run 2: plan_grid receives run 1's proposal-failure diagnoses.
    await harness.orchestrator.run({
      sessionId: 'session-p3',
      task: TASK as never,
      trigger: 'always'
    });
    expect(policy.planGridRequests.length).toBeGreaterThanOrEqual(2);
    const carried = policy.planGridRequests[1]?.previousFailures ?? [];
    expect(carried.length).toBeGreaterThanOrEqual(1);
    expect(carried.every((failure) => failure.category !== 'none')).toBe(true);
    // The diagnosis was produced through the injected taxonomy, not invented.
    expect(carried[0]?.signals.map((entry) => entry.kind)).toContain('unknown');
  });

  it('keeps a typed metered budget denial distinguishable from a transport failure', async () => {
    const taxonomy = makeRecordingRealTaxonomy();
    const harness = makeHarness({
      proposer: makeFailingProposer([
        new MeteredModelError('METERED_MODEL_BUDGET_DENIED', 'ledger refused the reservation')
      ]),
      taxonomy,
      jitrl: { enabled: true, levels: ['meta'], candidateCount: 1 }
    });

    const first = await harness.orchestrator.run({
      sessionId: 'session-p3',
      task: TASK as never,
      trigger: 'always'
    });
    // The typed denial rides as model_refusal (never as transport retryable),
    // and the REAL classifier routes it to hard_unrecoverable exactly like a
    // refused probe.
    const firstSignals = taxonomy.requests[0]?.signals ?? [];
    const signal = firstSignals[0];
    expect(signal?.kind).toBe('model_refusal');
    expect(signal?.code).toBe('METERED_MODEL_BUDGET_DENIED');
    expect(signal?.retryable).toBeUndefined();
    const diagnosis = classifyFailure({ signals: signal === undefined ? [] : [signal] });
    expect(diagnosis.category).toBe('hard_unrecoverable');

    // The additive metadata block counts the refusal class honestly.
    const metadata = first.metadata as
      | { proposerFailures?: { total: number; refusalClass: number; transportClass: number } }
      | undefined;
    expect(metadata?.proposerFailures?.total).toBeGreaterThanOrEqual(1);
    expect(metadata?.proposerFailures?.refusalClass).toBe(metadata?.proposerFailures?.total);
    expect(metadata?.proposerFailures?.transportClass).toBe(0);
  });

  it('does not carry a not-evaluable proposal and clears the carry after a clean run', async () => {
    const basePolicy = makePolicy();
    const policy = makePlanGridRecordingPolicy(basePolicy);
    const harness = makeHarness({
      proposalPatches: [scriptsOnlyPatch(() => CLOCK_START)],
      policy,
      jitrl: { enabled: true, levels: ['meta'], candidateCount: 1 }
    });

    const notEvaluableRun = await harness.orchestrator.run({
      sessionId: 'session-p3',
      task: TASK as never,
      trigger: 'always'
    });
    expect(notEvaluableRun.metadata?.stopReason).toBe('proposals_not_evaluable');
    // A3 keeps its own route: unevaluable proposals are not proposer failures
    // and must never enter the failure carry.
    expect(policy.planGridRequests.length).toBeGreaterThanOrEqual(1);

    // A clean second run plans with an empty previousFailures array again: the
    // carry was never populated by the A3 skip above.
    const cleanHarness = makeHarness({
      policy,
      jitrl: { enabled: true, levels: ['meta'], candidateCount: 1 }
    });
    await cleanHarness.orchestrator.run({
      sessionId: 'session-p3',
      task: TASK as never,
      trigger: 'always'
    });
    const secondPlan = policy.planGridRequests.at(-1);
    expect(secondPlan?.previousFailures).toEqual([]);
    const cleanResult = await cleanHarness.orchestrator.run({
      sessionId: 'session-p3',
      task: TASK as never,
      trigger: 'always'
    });
    expect((cleanResult.metadata as Record<string, unknown>).proposerFailures).toBeUndefined();
  });

  it('bounds the carry at MAX_CARRIED_PROPOSAL_FAILURES (oldest dropped)', () => {
    const carried: FailureDiagnosis[] = [];
    const make = (n: number): FailureDiagnosis => ({
      category: 'weak_underexplored',
      confidence: 0.5,
      repairable: false,
      recommendedAction: 'deepen',
      evidence: ['carry probe ' + String(n)],
      signals: []
    });
    for (let index = 0; index < MAX_CARRIED_PROPOSAL_FAILURES + 3; index += 1) {
      carryProposalFailure(carried, make(index));
    }
    expect(carried).toHaveLength(MAX_CARRIED_PROPOSAL_FAILURES);
    // The OLDEST entries were dropped; the newest 8 remain, in order.
    expect(carried[0]?.evidence[0]).toBe('carry probe 3');
    expect(carried[MAX_CARRIED_PROPOSAL_FAILURES - 1]?.evidence[0]).toBe(
      'carry probe ' + String(MAX_CARRIED_PROPOSAL_FAILURES + 2)
    );
  });

  it('maps failure classes exactly: signal vocabulary is the single source of truth', () => {
    const transport = proposalFailureSignalOf(
      new DshModelStreamError('gateway stalled', 'error', 'RATE_LIMIT')
    );
    expect(transport.kind).toBe('unknown');
    expect(transport.retryable).toBe(true);
    expect(transport.code).toBe('RATE_LIMIT');

    const httpTransport = proposalFailureSignalOf(
      Object.assign(new Error('gateway 503'), { name: 'GatewayHttpError', status: 503 })
    );
    expect(httpTransport.kind).toBe('unknown');
    expect(httpTransport.retryable).toBe(true);

    const denial = proposalFailureSignalOf(
      new MeteredModelError('METERED_MODEL_PURPOSE_MISMATCH', 'wrong purpose')
    );
    expect(denial.kind).toBe('model_refusal');
    expect(denial.code).toBe('METERED_MODEL_PURPOSE_MISMATCH');

    const parse = proposalFailureSignalOf(
      new Harness2ProposalError('proposal_unparseable', 'not json', 'detail')
    );
    expect(parse.kind).toBe('invalid_patch');
    expect(parse.code).toBe('proposal_unparseable');

    const unknown = proposalFailureSignalOf(new Error('something else'));
    expect(unknown.kind).toBe('unknown');
    expect(unknown.retryable).toBeUndefined();
    expect(unknown.code).toBeUndefined();

    // The message is bounded; a hostile error body cannot bloat the diagnosis.
    const hostile = proposalFailureSignalOf(new Error('x'.repeat(5_000)));
    expect(hostile.message.length).toBeLessThanOrEqual(241);
  });

  // rev8 integration fix (independent-review P0): a run whose proposals were
  // dropped attaches `metadata.proposerFailures` via the result() helper's
  // `extra` spread. Before the fix the extra.metadata object REPLACED the
  // built-in lifecycle metadata, so exactly the runs that most need their stage
  // trace (the ones with dropped proposals) lost metadata.lifecycle /
  // stopReason / rounds — a direct violation of the plan §5.2 evo_run_poll
  // contract (result=EvoHarnessRunResult with metadata.lifecycle) and of the
  // job-book stage-trace semantics. The merge must keep both.
  it('keeps metadata.lifecycle intact on a run whose proposals were dropped', async () => {
    // The REAL classifier (like the sibling gap-2 tests): the file-default
    // taxonomy answers NO_FAILURE ('none'), which diagnoseProposalFailure
    // correctly drops, so no metadata block would ever attach. The bug under
    // test needs a run that DOES carry proposerFailures.
    const taxonomy = makeRecordingRealTaxonomy();
    const harness = makeHarness({
      proposer: makeFailingProposer([
        new DshModelStreamError('cut off mid-stream', 'aborted')
      ]),
      taxonomy,
      jitrl: { enabled: true, levels: ['meta'], candidateCount: 1 }
    });

    const result = await harness.orchestrator.run({
      sessionId: 'session-p3',
      task: TASK as never,
      trigger: 'always'
    });
    const metadata = result.metadata as
      | {
          lifecycle?: unknown[];
          stopReason?: unknown;
          rounds?: unknown;
          referenceStatus?: unknown;
          memoryDriverKind?: unknown;
          dreamTriggered?: unknown;
          proposerFailures?: { total: number };
        }
      | undefined;

    // The proposer-failure block is present (the trigger for the old bug)…
    expect(metadata?.proposerFailures?.total).toBeGreaterThanOrEqual(1);
    // …and the lifecycle block survived the merge, every key populated.
    expect(Array.isArray(metadata?.lifecycle)).toBe(true);
    expect((metadata?.lifecycle as unknown[]).length).toBeGreaterThan(0);
    expect((metadata?.lifecycle as unknown[]).at(-1)).toBe('finalize');
    expect(typeof metadata?.stopReason).toBe('string');
    expect(typeof metadata?.rounds).toBe('number');
    expect(metadata?.referenceStatus).not.toBeNull();
    expect(typeof metadata?.memoryDriverKind).toBe('string');
    expect(typeof metadata?.dreamTriggered).toBe('boolean');
  });

  // rev8 integration fix (independent-review P1): the run-level cancel signal
  // must reach the proposer requests. The proposer's retry/abort channel reads
  // `request.metadata.signal` (requestAbortSignal); without the forwarding a
  // cancelled run kept its in-flight proposal retrying (backoff sleeps, model
  // re-calls) even though every probe had already turned 'aborted'.
  it('forwards the run signal to the proposer request metadata', async () => {
    const harness = makeHarness({
      jitrl: { enabled: true, levels: ['meta'], candidateCount: 1 }
    });
    const controller = new AbortController();

    await harness.orchestrator.run({
      sessionId: 'session-p3',
      task: TASK as never,
      trigger: 'always',
      signal: controller.signal
    });

    // The K-candidate path (candidateCount=1 here falls back to propose())…
    const proposer = harness.proposer;
    expect(proposer.requests.length).toBeGreaterThanOrEqual(1);
    expect(proposer.requests[0]?.metadata?.signal).toBe(controller.signal);

    // …and the multi-candidate path too (candidateCount=3 default slots).
    const multiHarness = makeHarness({});
    const multiController = new AbortController();
    await multiHarness.orchestrator.run({
      sessionId: 'session-p3',
      task: TASK as never,
      trigger: 'always',
      signal: multiController.signal
    });
    const multiProposer = multiHarness.proposer;
    const candidateRequest = multiProposer.requests.find(
      (request) => request.candidateCount !== undefined
    );
    expect(candidateRequest).toBeDefined();
    expect(candidateRequest?.metadata?.signal).toBe(multiController.signal);

    // No request carries a foreign signal.
    for (const request of multiProposer.requests) {
      const signal = request.metadata?.signal;
      expect(signal === undefined || signal === multiController.signal).toBe(true);
    }
  });

  // The signal capture is run-scoped: a SECOND run on the same orchestrator
  // (without a signal) must not see the first run's signal on its proposals.
  it('does not leak the previous run signal into a later signal-less run', async () => {
    const harness = makeHarness({
      jitrl: { enabled: true, levels: ['meta'], candidateCount: 1 }
    });
    const controller = new AbortController();
    await harness.orchestrator.run({
      sessionId: 'session-p3',
      task: TASK as never,
      trigger: 'always',
      signal: controller.signal
    });
    await harness.orchestrator.run({
      sessionId: 'session-p3',
      task: TASK as never,
      trigger: 'always'
    });
    const secondRunRequests = harness.proposer.requests.slice(-1);
    expect(secondRunRequests.length).toBeGreaterThanOrEqual(1);
    expect(secondRunRequests[0]?.metadata?.signal).toBeUndefined();
  });
});
