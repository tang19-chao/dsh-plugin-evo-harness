/**
 * End-to-end self-evolution orchestrator (ARCHITECTURE.md section 7).
 *
 * Lifecycle, in the documented order:
 *   1. initialize          - bind the memory backend (auto-discovery)
 *   2. recall              - governed recall for the incoming task
 *   3. plan_grid           - active policy pi_t plans width/depth/budget
 *   4. reference_probe     - baseline run without scaffold edits (contrast anchor)
 *   5. select_batch        - three-way slot portfolio per round (needs the
 *                            reference node in the tree)
 *   6. propose             - Harness2 dual-track proposal (domain vs invariant)
 *   7. probe               - isolated Cordis branch execution of the candidate
 *   8. classify            - four-way failure taxonomy for the probe
 *   9. score               - verifier-free surrogate score s_v
 *  10. compose             - anonymous behavioral contrast, pick H*
 *  11. reflect             - evidence-chain CanonicalLesson extraction
 *  12. commit              - governed memory commit of the lessons
 *  13. apply_patch         - permanently mount the winning scaffold
 *  14. offline_dream       - zero-execution replay every N completed tasks
 *  15. finalize            - EvoHarnessRunResult for the host
 *
 * Every collaborator is injected (no host, network, sandbox or LLM import), so
 * the orchestrator is deterministic under a fixed clock/id factory and fully
 * testable with fakes. The lifecycle trace is exposed through
 * result.metadata.lifecycle and lastTrace() for end-to-end assertions.
 *
 * Budget accounting: plan_grid's budget bounds candidate rollouts (probesRun
 * counts every isolated branch execution, including the reference anchor).
 */
import type { EvoHarnessConfig } from './config';
import { HARNESS_COMPONENT_KEYS } from './types/contracts';
import type {
  AbstractState,
  ActionKeyVocabulary,
  BatchPlan,
  BatchSlotPlan,
  BranchExecutor,
  CanonicalLesson,
  CompositionResult,
  DecisionMode,
  DiscoveryNode,
  DreamReplayReport,
  EvoHarnessRunOutcome,
  EvoHarnessRunRequest,
  EightSurfacePatch,
  EvoHarnessRunResult,
  ExperienceOutcome,
  ExperienceRecord,
  FailureCategory,
  FailureDiagnosis,
  IActivePolicy,
  ICordisSeamManager,
  IDiscoveryTreePool,
  IEvoHarnessOrchestrator,
  IHarnessComposer,
  IHarnessProposer,
  IHarnessReflector,
  IExperienceStore,
  IMemoryBridge,
  IStepEvaluator,
  JitCandidate,
  JitDecision,
  JitLevel,
  GuidanceMode,
  LearningTrack,
  HarnessComponentKey,
  IOfflineDreamer,
  ISurrogateScorer,
  MemoryIsolationHandle,
  MemoryRecallResult,
  MemoryScope,
  MetaSearchPolicy,
  ProbeCandidate,
  ProbeTask,
  ProbeTrajectory,
  ProposedPatch,
  ProposedPatchSet,
  ProposeRequest,
  ProposerGuidance,
  RunBudgetOverride,
  ScoredExperience,
  SearchGridPlan,
  SelectBatchRequest,
  SurfacePatchDisposer,
  StepReward,
  SurrogateScore
} from './types/contracts';
// Pure, dependency-free JitRL helpers (no kernel wiring): the L2 selector needs
// the same state abstraction and prior-logit projection the L1 decorator uses,
// so both levels agree on what a "state" and a "prior" are.
import {
  normalizeMetaAction,
  normalizePatchSignature,
  semanticEditKindOf,
  type SemanticEditKind
} from './jitrl/action-normalizer';
import { verbalizedLogit } from './jitrl/logit-sources';
import { abstractMetaState, abstractProposalState } from './jitrl/state-abstraction';
import {
  augmentCandidates,
  guidanceFilterForSlot,
  type LessonPatchSource,
  type RehydratedAction
} from './jitrl/candidate-augmenter';
import {
  classifyTrajectoryOutcome,
  isLearningOutcome
} from './jitrl/step-evaluator';
import {
  decideReplacement,
  shouldReleaseReservation
} from './jitrl/replacement-policy';
import { conservativeAdvantage } from './jitrl/value-estimator';
import { CURRENT_PROVENANCE_VERSION, EXPERIENCE_SCHEMA_VERSION } from './jitrl/experience-store';
import {
  REWARD_CONTRACT,
  estimatorTargetLine,
  scoreUnderRewardContract
} from './jitrl/reward-contract';
import type { JitRuntimeControl, JitSurface } from './jitrl/runtime-control';
import { recordModeOf, resolveExecutionProfile, type ExecutionProfile } from './runtime/execution-profile';
import {
  accumulateVerificationSummary,
  readVerificationDisposition,
  readVerificationView,
  verificationRewardMarks,
  verificationSourceDescription,
  isCompleteQualityBinding,
  qualityProvenanceRegistry,
  registerAuthenticatedQualityRecord,
  unregisterAuthenticatedQualityRecord,
  verifyAndAttach,
  type QualityProvenanceContext,
  type HostVerificationSeam,
  type VerificationDisposition,
  type VerificationRunSummary,
  type VerificationView
} from './verification';
import { createDiscoveryTree } from './dream-rsi';
import type {
  DiscoveryTree,
  DiscoveryTreeOptions,
  DreamReplayReportWithShadow,
  IFailureTaxonomy
} from './dream-rsi';

/**
 * C2b F11: narrow a recorder-derived verification context to a COMPLETE host
 * binding, or undefined.
 *
 * Returns the context unchanged when every binding member is present and the
 * artifact digest is the exact host-recomputed shape (sha256:<64 lowercase
 * hex>); undefined otherwise. The recorder never fabricates placeholders, so a
 * partial verification simply yields no registrable binding.
 */
function completeQualityBindingContext(
  candidate: QualityProvenanceContext
): QualityProvenanceContext | undefined {
  return isCompleteQualityBinding(candidate) ? candidate : undefined;
}

/** Ordered lifecycle stages recorded for every run. */
export const EVO_HARNESS_STAGES = [
  'initialize',
  'recall',
  'plan_grid',
  'select_batch',
  'jit_meta_adjust',
  'reference_probe',
  'propose',
  'jit_proposal_select',
  'probe',
  'classify',
  'score',
  'compose',
  'reflect',
  'evaluate_steps',
  'record_experience',
  'commit',
  'apply_patch',
  'offline_dream',
  'finalize'
] as const;
export type EvoHarnessStage = (typeof EVO_HARNESS_STAGES)[number];

/** Detail payload handed to the optional stage observer. */
export interface EvoHarnessStageEvent {
  readonly stage: EvoHarnessStage;
  readonly runId: string;
  readonly round?: number;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/**
 * Durable completed-task cadence used for offline dreaming.
 *
 * `PolicyStore` from src/persistence satisfies this shape directly, so a host
 * that wants the dream cadence to survive a restart injects the store here. When
 * it is absent the orchestrator falls back to its in-process counter.
 */
export interface OrchestratorTaskCounter {
  /** True when the persisted count has reached `everyNTasks`. */
  shouldDream(everyNTasks: number): boolean;
  /** Persist one completed task; resolves with the new total. */
  recordCompletedTask(by?: number): Promise<number>;
  /** Persist one offline dream (audit counter); optional. */
  recordDream?(by?: number): Promise<number>;
}

/** Every collaborator the orchestration needs; all are injected. */
export interface EvoHarnessOrchestratorDeps {
  readonly config: EvoHarnessConfig;
  readonly memory: IMemoryBridge;
  readonly seams: ICordisSeamManager;
  readonly policy: IActivePolicy;
  readonly proposer: IHarnessProposer;
  readonly composer: IHarnessComposer;
  readonly reflector: IHarnessReflector;
  readonly scorer: ISurrogateScorer;
  readonly taxonomy: IFailureTaxonomy;
  readonly dreamer: IOfflineDreamer;
  readonly treePool: IDiscoveryTreePool;
  /** Host-provided task runner executed inside an isolated branch. */
  readonly runBranch: BranchExecutor;
  /**
   * Durable completed-task counter for the dream cadence. Without it the cadence
   * restarts from zero in every process.
   */
  readonly taskCounter?: OrchestratorTaskCounter;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly createTree?: (options: DiscoveryTreeOptions) => DiscoveryTree;
  /** Scope lessons are read from and committed into; defaults to session scope. */
  readonly commitScope?: (sessionId: string) => MemoryScope;
  /** Candidate policy generator for offline dreaming. */
  readonly candidatePolicies?: (
    baseline: MetaSearchPolicy,
    count: number
  ) => readonly MetaSearchPolicy[];
  /**
   * P6.2 C1 + t7/V1 (ADR 0002 R2): REQUEST the permanent mount of the winning
   * scaffold. Defaults to false (fail-closed). This flag alone NEVER mounts:
   * the resolved execution profile's patch permission (guarded-active only)
   * must ALSO allow it. A mount happens iff both hold.
   */
  readonly applyWinningPatch?: boolean;
  /**
   * P6.2 PR-B / F4 + t7/V2: request the conservative L2 replacement gate (the
   * prior-deviation evidence vetoes described in selectProposal). Defaults to
   * false. Only valid together with an execution profile whose mode is
   * 'guarded-active'; any other combination is rejected at construction
   * (fail-closed) because shadow/baseline/off must never intercept selection.
   */
  readonly conservativeGate?: boolean;
  /**
   * P6.2 C1 (ADR 0002 R1/R2): the resolved execution profile. The plugin
   * entrypoint resolves config.execution + permissions into this shape;
   * absent means "hand-built orchestrator, conservative defaults": shadow
   * records, patch layer denied (permanent mounts off), publish/memory
   * denied. The orchestrator NEVER derives permissions from anywhere else.
   */
  readonly executionProfile?: ExecutionProfile;
  /**
   * C2a (ADR 0003 §4.1/§4.5): the host-owned trusted-verification seam.
   *
   * Absent (or `enabled: false`) means "no host runner": every trajectory keeps
   * the pre-C2a shape (structural fallback only), no receipt is attached, no
   * audit marks are written - byte-identical to the default assembly. There is
   * deliberately NO config field that produces this seam; only an explicit host
   * injection does (same discipline as `ExecutionProfileInput.memoryRealWrites`).
   */
  readonly verification?: HostVerificationSeam;
  /**
   * Optional JitRL kernel surface (plan Phase 3: L2 selection and online
   * experience recording). Structural on purpose: the orchestrator never
   * imports src/jitrl/**, and a host without JitRL pays nothing. Absent means
   * both stages below are silent no-ops, byte-identical to the pre-Phase-3
   * lifecycle.
   */
  readonly jitrl?: OrchestratorJitRl;
  /**
   * The single JitRL runtime control the plugin entrypoint owns (P6 PR2).
   *
   * Injected rather than imported so the orchestrator stays free of the entry
   * module and a host can still drive the orchestrator directly. Absent means
   * "no volatile switch is wired": the orchestrator then falls back to the
   * static `jitrl.config.enabled`/`levels`, which is exactly the pre-PR2
   * behaviour for hosts that construct it by hand.
   *
   * When present it is authoritative for every surface: `/evo jit off` flips it
   * and `selectProposal`/`recordOnlineExperience` must stop, even though
   * `kernel.config.enabled` (configured) is still true.
   */
  readonly jitRuntime?: JitRuntimeControl;
  readonly onStage?: (event: EvoHarnessStageEvent) => void;
}

/**
 * The narrow JitRL surface the orchestrator needs: the experience store, the
 * closed-form optimizer and the step evaluator. Mirrors JitRl from
 * src/jitrl/index.ts without importing it.
 */
export interface OrchestratorJitRl {
  readonly store: Pick<IExperienceStore, 'append' | 'query' | 'size'>;
  readonly optimizer: {
    decide<T>(
      level: JitLevel,
      state: AbstractState,
      candidates: readonly JitCandidate<T>[],
      options?: { readonly guidanceFilter?: GuidanceMode; readonly rng?: () => number }
    ): Promise<JitDecision<T>>;
  };
  /** Optional richer evaluator; evaluate() from IStepEvaluator is enough. */
  readonly stepEvaluator?: IStepEvaluator;
  /**
   * Optional lesson lookup for memory augmentation (plan section 6.6). Phase 3
   * wires none: rehydration is lossy by construction, so absence is expected and
   * the augmentation call still runs (documented no-op) instead of being skipped.
   */
  readonly lessonSource?: LessonPatchSource;
  readonly config: {
    readonly enabled: boolean;
    readonly levels: readonly JitLevel[];
    readonly gamma: number;
    /** K for the proposal call; L2 selection only runs when K > 1. */
    readonly candidateCount: number;
    /** Retrieval breadth/threshold; the L2 neighbour query mirrors the decision. */
    readonly k?: number;
    readonly similarityThreshold?: number;
    /** Config augmentFromMemory; absent means enabled. */
    readonly augmentFromMemory?: boolean;
    /** Config minSupportForStrongPrior. */
    readonly minSupportForStrongPrior?: number;
  };
}

/** Orchestrator facade: frozen contract plus deterministic test accessors. */
export interface EvoHarnessOrchestrator extends IEvoHarnessOrchestrator {
  readonly runCount: number;
  readonly treePool: IDiscoveryTreePool;
  isDisposed(): boolean;
  lastTrace(): readonly EvoHarnessStage[];
  lastComposition(): CompositionResult | null;
  /**
   * C2a (ADR-0003 §4.2): the host-authenticated verification views of the last
   * run (empty when no host runner is configured).
   */
  lastVerificationViews(): readonly VerificationView[];
  lastLessons(): readonly CanonicalLesson[];
  lastPlan(): SearchGridPlan | null;
  dreamReports(): readonly DreamReplayReport[];
  activePatchIds(): readonly string[];
  /**
   * C1.1 (ADR-0003 §3.5): Orchestrator-owned unified dream entrypoint.
   */
  triggerDream(diagnostics?: string[]): Promise<DreamReplayReportWithShadow | null>;
  /**
   * t8/R5 (ADR 0002 R5-6): the explicit exploration budget is part of the
   * public handle. `grant(n)` adds n seats (returns the new total), `revoke()`
   * zeroes the allowance, `remaining()` reports what is left. This is the ONLY
   * public authorization path for under-evidenced deviations; the default
   * allowance is 0 (fail-closed) and the patch permission can still deny
   * budget execution entirely (V2b).
   */
  grantExplorationBudget(count: number): number;
  revokeExplorationBudget(): void;
  explorationBudgetRemaining(): number;
}

interface RunBudget {
  readonly maxOnlineRolloutBudget: number;
  readonly maxWidth: number;
  readonly maxDepth: number;
}

function clampPositiveInt(value: number | undefined, maximum: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.floor(value), maximum));
}

function resolveBudget(
  override: RunBudgetOverride | undefined,
  config: EvoHarnessConfig
): RunBudget {
  const dream = config.dreamRsi;
  return {
    maxOnlineRolloutBudget: clampPositiveInt(
      override?.maxOnlineRolloutBudget,
      dream.maxOnlineRolloutBudget,
      dream.maxOnlineRolloutBudget
    ),
    maxWidth: clampPositiveInt(override?.maxWidth, dream.maxWidth, dream.maxWidth),
    maxDepth: clampPositiveInt(override?.maxDepth, dream.maxDepth, dream.maxDepth)
  };
}

/**
 * L1 JitRL diagnostics carried by a batch plan.
 *
 * Kept as a local structural read instead of an import so the orchestrator stays
 * independent of src/jitrl/**: the decorator is injected through IActivePolicy
 * and a host that never enables JitRL pays nothing. Shape mirrors
 * jit-active-policy.JitBatchDiagnostics on the fields the trace uses.
 */
interface BatchJitDiagnostics {
  readonly stateValue: number;
  readonly neighborCount: number;
  readonly klToPrior: number;
  readonly degraded?: boolean;
  readonly degradedReason?: string;
}

/**
 * Rebuild the L1 abstract state for one selectBatch call.
 *
 * The decorator keeps its own state private (it publishes only the numeric
 * diagnostics in metadata), so the orchestrator derives the identical state from
 * the same public inputs it handed to selectBatch: abstractMetaState is pure and
 * its fields degrade deterministically, so this is the same object the L1
 * decision used - not an invented one. Recording it keeps the L1 neighbourhood
 * growing with causal (before-cutoff) ordering.
 */
function buildL1State(request: SelectBatchRequest): AbstractState {
  const metadata = isPlainRecord(request.metadata) ? request.metadata : undefined;
  const parentId = request.previousBestNodeId;
  const parent = parentId === undefined ? undefined : request.tree.nodes[parentId];
  const category = parent?.failure?.category;
  return abstractMetaState({
    task: request.task,
    round: finiteOr(request.round, 0),
    parentDepth: parent === undefined ? 0 : finiteOr(parent.depth, 0),
    ...(parent?.slot === undefined ? {} : { parentSlot: parent.slot }),
    // abstractMetaState re-validates the category and falls back to 'none', so an
    // unknown taxonomy entry can never leak into the state.
    ...(category === undefined ? {} : { parentFailure: { category } }),
    memoryConfidence: finiteOr(request.memoryConfidence, 0),
    referenceStatus: isReferenceStatus(metadata?.referenceStatus)
      ? metadata.referenceStatus
      : 'missing',
    ...(typeof metadata?.referenceToolErrorRate === 'number' &&
    Number.isFinite(metadata.referenceToolErrorRate)
      ? { referenceToolErrorRate: metadata.referenceToolErrorRate }
      : {})
  });
}

/**
 * Retrieval defaults for the L2 neighbour query. These mirror the values
 * createJitRl resolves from config.jitrl (k 10, similarityThreshold 0.3) so the
 * augmentation pass and the decision see the same neighbourhood; the orchestrator
 * must not import src/config.ts, so the numbers are mirrored here instead.
 */
const DEFAULT_PROPOSAL_K = 10;
const DEFAULT_PROPOSAL_SIMILARITY = 0.3;

function isRecordValue(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** True when the augmenter produced this payload (rehydrated, not proposed). */
function isRehydratedAction(payload: unknown): payload is RehydratedAction {
  return isRecordValue(payload) && isRecordValue(payload['edits']) && typeof payload['summary'] === 'string';
}

/**
 * Rebuild a ProposedPatch from a rehydrated memory action (plan section 6.6).
 *
 * The augmenter deliberately returns no patch object, because a rehydrated action
 * is a lesson's structural edits rather than something the proposer wrote. This
 * adapter only repackages those edits; it never invents, completes or repairs a
 * payload. Surface entries that are not objects are dropped, and a payload with
 * no usable surface yields undefined so the caller falls back instead of probing
 * a fabricated patch.
 *
 * The patch id is generated (lesson diffs carry no id of their own) and
 * normalizePatchSignature ignores ids, so the action key stays stable.
 */
function patchFromAugmented(
  payload: unknown,
  context: {
    readonly actionKey: string;
    readonly sessionId: string;
    readonly slot: BatchSlotPlan;
    readonly id: string;
    readonly createdAt: number;
  }
): ProposedPatch | undefined {
  if (!isRehydratedAction(payload)) {
    return undefined;
  }
  const edits: Partial<Record<HarnessComponentKey, unknown>> = {};
  for (const [key, value] of Object.entries(payload.edits)) {
    if (isHarnessComponentKey(key) && value !== undefined && value !== null) {
      edits[key] = value;
    }
  }
  const surfaces = Object.keys(edits);
  if (surfaces.length === 0) {
    return undefined;
  }
  const patch = {
    id: context.id,
    sessionId: context.sessionId,
    branchId: context.slot.branchId,
    origin: context.slot.origin,
    purpose: 'explore',
    guidance: context.slot.guidance,
    label: 'memory-augmented',
    rationale:
      payload.summary.length > 0
        ? payload.summary
        : 'memory-augmented action rehydrated from a lesson',
    edits,
    ...(payload.sourcePatchId === undefined ? {} : { parentPatchIds: [payload.sourcePatchId] }),
    createdAt: context.createdAt
  };
  return {
    patch: patch as unknown as EightSurfacePatch,
    rationale: patch.rationale,
    focusSurfaces: surfaces as readonly HarnessComponentKey[],
    confidence: 0.5,
    expectedStepsDelta: 0
  };
}

/** Runtime member check for the eight surface keys. */
function isHarnessComponentKey(value: string): value is HarnessComponentKey {
  return (HARNESS_COMPONENT_KEYS as readonly string[]).includes(value);
}

/**
 * L1 action key of one scheduled slot.
 *
 * Contract (t25): an online L1 record MUST be keyed the same way the L1
 * candidate space keys its actions, i.e. normalizeMetaAction(slot, surfaces).
 * A portfolio-level key such as 'meta:batch:...' has no counterpart among the
 * candidates, so alignNeighbors drops the record and the live support never
 * grows. An invalid slot/surface pair (a programmer error upstream) degrades to
 * the kind-only key rather than throwing inside the recording path.
 */
function slotActionKey(slot: BatchSlotPlan): string {
  try {
    return normalizeMetaAction(slot.slot, slot.focusSurfaces);
  } catch {
    return normalizeMetaAction(slot.slot, []);
  }
}

/**
 * True guidance provenance of one scheduled slot (plan section 7.1).
 *
 * 'explore_invariant' is first-principles exploration by definition, so it is
 * hard-pinned to 'guidance_free' regardless of what a custom policy claims;
 * every other slot reports the guidance the policy actually ran it with. Writing
 * a constant would make memory-guided samples look like invariant evidence and
 * empty the guidance filter of its meaning.
 */
function slotProvenance(slot: BatchSlotPlan): GuidanceMode {
  if (slot.slot === 'explore_invariant') {
    return 'guidance_free';
  }
  return slot.guidance === 'guidance_free' ? 'guidance_free' : 'memory';
}

/** Clamp into [min, max]; a non-finite value collapses to 0. */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(max, Math.max(min, value));
}

/**
 * P6.1-D RewardContract: the winner's step-evaluator vector, kept as ONE
 * auxiliary `stepJudge` entry (mean of the per-step rewards). It never defines
 * the primary target, so a missing or failed evaluation cannot change what
 * rewardVersion means. Clipped to the reward range so the auxiliary field stays
 * comparable to the primary scale for calibration sampling.
 */
function winnerStepSummary(rewards: readonly StepReward[] | undefined): number {
  if (rewards === undefined || rewards.length === 0) {
    return 0;
  }
  const perStep = rewards.map((entry) => entry.reward);
  const mean = perStep.reduce((total, value) => total + value, 0) / Math.max(1, perStep.length);
  return clamp(mean, -3, 3);
}

/** Non-array object guard (ContractMetadata is a plain record). */
function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Reference probe outcomes accepted as the L1 state's reference status. */
function isReferenceStatus(value: unknown): value is 'succeeded' | 'failed' | 'missing' {
  return value === 'succeeded' || value === 'failed' || value === 'missing';
}

function readJitBatchDiagnostics(plan: BatchPlan): BatchJitDiagnostics | undefined {
  const metadata = plan.metadata;
  if (metadata === undefined) {
    return undefined;
  }
  const raw = metadata['jit'];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const stateValue = record.stateValue;
  const neighborCount = record.neighborCount;
  const klToPrior = record.klToPrior;
  return {
    stateValue: typeof stateValue === 'number' && Number.isFinite(stateValue) ? stateValue : 0,
    neighborCount:
      typeof neighborCount === 'number' && Number.isFinite(neighborCount) ? neighborCount : 0,
    klToPrior: typeof klToPrior === 'number' && Number.isFinite(klToPrior) ? klToPrior : 0,
    ...(record.degraded === true ? { degraded: true } : {}),
    ...(typeof record.degradedReason === 'string'
      ? { degradedReason: record.degradedReason }
      : {})
  };
}

/** True when the request carries the blocking evidence auto_fallback needs. */
export function autoFallbackRequested(request: EvoHarnessRunRequest): boolean {
  const metadata = request.metadata;
  if (metadata === undefined) {
    return false;
  }
  if (metadata.autoFallback === true || metadata.blocked === true) {
    return true;
  }
  const signals = metadata.failureSignals;
  if (Array.isArray(signals) && signals.length > 0) {
    return true;
  }
  const errors = metadata.toolErrors;
  return Array.isArray(errors) && errors.length > 0;
}

/** Narrow a possibly non-finite number to a finite one. */
function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.name + ': ' + error.message;
  }
  return String(error);
}

function nodeStatusFor(status: ProbeTrajectory['status']): 'succeeded' | 'failed' {
  return status === 'succeeded' ? 'succeeded' : 'failed';
}

/**
 * Deduplication key for one appended experience record (plan section 6.2:
 * "记录去重"). It combines the identity of the action with the identity of the
 * execution, so re-entering the recorder cannot double-count a probe while two
 * genuinely different executions of the same action still both count.
 */
function experienceDedupKey(record: ExperienceRecord): string {
  return [
    record.level,
    record.actionKey,
    record.treeId ?? '',
    record.nodeId ?? '',
    record.trajectoryId ?? '',
    String(record.round ?? '')
  ].join('\u0000');
}

/** One L2 selection made for an admitted candidate (online experience sample). */
interface PreparedSelection {
  readonly state: AbstractState;
  readonly actionKey: string;
  /** Stable id of the L2 decision that chose this action (plan section 6.1). */
  readonly decisionId: string;
  /** Index the decision chose, and how many candidates it was offered. */
  readonly chosenIndex: number;
  readonly offered: number;
  /**
   * P6.2 PR-B / F4: the prior choice (highest baseLogit), the decision's raw
   * proposal and the index actually EXECUTED after the conservative gate.
   * Attempted deviation (proposed != prior) and actual deviation
   * (executed != prior) are therefore separable in every record.
   */
  readonly priorIndex?: number;
  readonly proposedIndex?: number;
  /** Gate reason when the executed index is not the decision's raw choice. */
  readonly gateReason?: 'min-support' | 'implicit-zero-advantage' | 'exploration-budget' | 'proposer-fallback' | 'patch-permission';
  /** True when this execution was charged to the explicit exploration budget. */
  readonly exploration?: boolean;
  /**
   * t8/R4 (ADR 0002 R1 shadow 行): the challenger's measured replacement
   * strength (nEff/support co-report, shrunk + calibrated suggestion) for
   * EVERY L2 decision - gate open or closed. estimation stays separated from
   * replacement: this is what the suggestion WAS, not whether it replaced.
   */
  readonly challenger?: {
    readonly nEff: number;
    readonly support: number;
    readonly shrunkAdvantage: number;
    readonly calibratedAdvantage: number;
    readonly implicitZeroAdvantage: boolean;
  };
  /**
   * F4-4: the semantic edit kind(s) of the executed patch (constructive /
   * destructive / neutral), from semanticEditKindOf. Persisted next to the
   * action key so "harmful noop / destructive edit was chosen" is queryable
   * without changing the store's action-key vocabulary.
   */
  readonly semanticKind?: string;
}

/**
 * t8/R4: stable numeric encoding of the L2 gate outcome for the shadow
 * record's `rewardSources.gateReason` mark (rewardSources is numeric-only).
 * 0 means "no gate applied / executed as proposed". The mapping is frozen:
 * renumbering would silently reinterpret persisted records.
 */
export const GATE_REASON_CODES = {
  none: 0,
  'min-support': 1,
  'implicit-zero-advantage': 2,
  'exploration-budget': 3,
  'proposer-fallback': 4,
  // t10/R1b: a suggested deviation that did not execute because the patch
  // permission is denied (shadow/baseline; the prior executed instead).
  'patch-permission': 5
} as const;

/** t8/R4: the numeric code of one gate outcome (unknown -> none). */
export function gateReasonCodeOf(reason: string | undefined): number {
  if (reason === undefined) {
    return GATE_REASON_CODES.none;
  }
  const code = (GATE_REASON_CODES as Readonly<Record<string, number>>)[reason];
  return code === undefined ? GATE_REASON_CODES.none : code;
}

/** One proposal admitted into a round's concurrent probe wave. */
interface PreparedProbe {
  readonly slot: BatchSlotPlan;
  readonly node: DiscoveryNode;
  readonly proposed: ProposedPatch;
  readonly executionPatch: EightSurfacePatch;
  /** Present only when L2 chose this candidate out of K (see PreparedSelection). */
  readonly selection?: PreparedSelection;
}

/**
 * One probe that ACTUALLY EXECUTED and whose execution status was committed to
 * the discovery tree (plan section 6.2).
 *
 * This is the unit of credit attribution: it carries its own trajectory, its own
 * node/branch and the exact slot it ran for, so nothing is shared between
 * siblings. A candidate that never ran has no entry here and therefore can never
 * receive a measured reward.
 */
interface ExecutedProbe {
  readonly round: number;
  readonly slotIndex: number;
  readonly slot: BatchSlotPlan;
  /** The L1 abstract state of the round that scheduled this slot. */
  readonly l1State: AbstractState;
  readonly nodeId: string;
  readonly parentNodeId: string;
  readonly branchId: string;
  /** L1 action key in the L1 candidate vocabulary (normalizeMetaAction). */
  readonly actionKey: string;
  /** True guidance provenance of the slot (never the claimed one). */
  readonly guidance: GuidanceMode;
  readonly trajectory: ProbeTrajectory;
  readonly selection?: PreparedSelection;
}

/**
 * Order a batch's slots by slotIndex, falling back to the policy's plan order
 * for ties. Proposals, trace entries, probes and tree commits all follow this
 * order, so concurrent completion can never reorder observable state.
 */
function orderBatchSlots(slots: readonly BatchSlotPlan[]): readonly BatchSlotPlan[] {
  return slots
    .map((slot, planIndex) => ({ slot, planIndex }))
    .sort(
      (left, right) =>
        left.slot.slotIndex - right.slot.slotIndex || left.planIndex - right.planIndex
    )
    .map((entry) => entry.slot);
}

/** Probe concurrency from config, clamped to the documented 1-16 range. */
function resolveProbeConcurrency(config: EvoHarnessConfig): number {
  const configured = config.probe?.maxConcurrentProbes;
  if (configured === undefined || !Number.isFinite(configured)) {
    return 1;
  }
  return Math.max(1, Math.min(Math.floor(configured), 16));
}

/**
 * Run task factories with at most `limit` in flight, starting them in array
 * order and returning every settlement in input order.
 *
 * A rejection stops queued tasks from starting (matching the serial loop, which
 * never reached later slots after a probe threw) while every already-started
 * task still settles, so isolated-branch cleanup can never be abandoned. The
 * caller inspects the settled array and rethrows the first failure.
 */
async function settleWithConcurrency<T>(
  tasks: readonly (() => Promise<T>)[],
  limit: number
): Promise<readonly PromiseSettledResult<T>[]> {
  if (tasks.length === 0) {
    return [];
  }
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  const width = Math.max(1, Math.min(Math.floor(limit), tasks.length));
  let next = 0;
  let aborted = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (aborted) {
        return;
      }
      const index = next;
      next += 1;
      const task = tasks[index];
      if (task === undefined) {
        return;
      }
      try {
        results[index] = { status: 'fulfilled', value: await task() };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
        aborted = true;
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}

/**
 * Severity ranking for failure resolution. Lower wins.
 */
const FAILURE_CATEGORY_RANK: Readonly<Record<FailureCategory, number>> = {
  hard_unrecoverable: 0,
  repeatedly_unpromising: 1,
  repairable_implementation: 2,
  weak_underexplored: 3,
  none: 4
};

/**
 * Rank-based, order-independent precedence for the failure handed to the next
 * selectBatch round:
 *  1. hard_unrecoverable always wins over every other category, so a hard failure
 *     from any earlier slot or round still stops the run;
 *  2. repeatedly_unpromising then beats repairable_implementation and the weaker
 *     remaining categories (it must not abort the run itself - the stop gate only
 *     fires on hard_unrecoverable);
 *  3. repairable_implementation beats weak_underexplored/none, so a later weak
 *     sibling cannot hide the repairable failure ActivePolicy.findRecoveryTarget
 *     needs to schedule a recover slot;
 *  4. equal ranks keep the most recent diagnosis.
 * A lower-ranked incoming diagnosis never replaces a higher-ranked accumulated one.
 */
export function resolvePreviousFailure(
  current: FailureDiagnosis | undefined,
  incoming: FailureDiagnosis
): FailureDiagnosis {
  if (current === undefined) {
    return incoming;
  }
  const currentRank = FAILURE_CATEGORY_RANK[current.category];
  const incomingRank = FAILURE_CATEGORY_RANK[incoming.category];
  if (incomingRank < currentRank) {
    return incoming;
  }
  if (incomingRank > currentRank) {
    return current;
  }
  return incoming;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * Evidence-backed orchestrator. Construct with createEvoHarnessOrchestrator.
 */
export class EvoHarnessOrchestratorImpl implements EvoHarnessOrchestrator {
  /**
   * P6.2 PR-B / F4-5: per-orchestrator-instance exploration budget. A
   * DEVIATION from the prior that lacks full replacement evidence may only
   * execute while this budget lasts; each such execution is tagged
   * exploration in the record. Defaults to ZERO (fail-closed): exploration
   * must be SEPARATELY granted - `grantExplorationBudget(n)` is the explicit,
   * revocable allocation - so the online path never silently explores through
   * the "unknown action happens to have zero advantage" hole.
   */
  static readonly EXPLORATION_BUDGET = 0;

  private readonly deps: EvoHarnessOrchestratorDeps;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly createTree: (options: DiscoveryTreeOptions) => DiscoveryTree;
  private readonly candidatePolicies: (
    baseline: MetaSearchPolicy,
    count: number
  ) => readonly MetaSearchPolicy[];
  private readonly applyWinningPatch: boolean;
  private readonly patchDisposers: SurfacePatchDisposer[] = [];
  private readonly dreams: DreamReplayReport[] = [];
  private trace: EvoHarnessStage[] = [];
  private composition: CompositionResult | null = null;
  /**
   * C2a (ADR 0003 §4.2): the host-authenticated trajectory views of the last
   * run - "which trajectory got which verdict, authenticated how, and why not".
   * Cleared at the start of every run, exactly like `trace`/`composition`.
   */
  private verificationView: VerificationView[] = [];
  private lessons: readonly CanonicalLesson[] = [];
  private plan: SearchGridPlan | null = null;
  private count = 0;
  private disposed = false;
  /**
   * Dedup ledger for online experience (plan section 6.2). Scoped to this
   * orchestrator instance: it prevents re-entering the recorder from appending
   * the same execution twice, and it is bounded by the number of probes the
   * process actually ran.
   */
  private readonly appendedExperienceKeys: Set<string> = new Set();
  /**
   * C2b F4: quality records whose pre-commit registration must be ROLLED BACK
   * if the append fails or the batch is discarded. Register-then-commit means a
   * failed append could otherwise leave a never-persisted record trusted in the
   * process-global registry; the rollback list is consumed by the recorder's
   * commit step (register-on-success).
   */
  private readonly unregisteredQualityRecords: ExperienceRecord[] = [];
  /**
   * P6.2 PR-B / F4-5: the EXPLICIT, revocable exploration budget.
   *
   * Every deviation from the prior that survives the conservative gate but
   * lacks full replacement evidence is charged here and tagged
   * `exploration: true` on its record. When the budget is spent, such
   * deviations fall back to the prior - there is no implicit zero-advantage
   * exploration path left. `revokeExplorationBudget()` zeroes the allowance
   * and `grantExplorationBudget(n)` grants one (the "revocable" half: an
   * operator or a supervision surface can move it without restarting).
   */
  private explorationAllowance = EvoHarnessOrchestratorImpl.EXPLORATION_BUDGET;
  /**
   * t8/R5 (ADR 0002 R5-6): per-execution reservation ledger. A released seat
   * is keyed by the executed trajectory id and remembered, so re-entering the
   * recorder (dedup path, off mid-flight) can never refund the SAME cancelled
   * execution twice - the accounting is idempotent per execution key and the
   * budget can never exceed what was actually granted plus released-once.
   */
  private readonly releasedReservationKeys: Set<string> = new Set();
  /** P6.2 PR-B / F4: whether the conservative L2 gate intercepts deviations. */
  private readonly conservativeGate: boolean;
  /** P6.2 C1: the resolved execution profile (fail-closed defaults when absent). */
  private readonly executionProfile: ExecutionProfile;

  constructor(deps: EvoHarnessOrchestratorDeps) {
    if (deps === undefined || deps === null || deps.config === undefined) {
      throw new Error('EvoHarnessOrchestrator requires orchestrator dependencies');
    }
    this.deps = deps;
    this.now = deps.now ?? ((): number => Date.now());
    this.newId = deps.newId ?? ((): string => 'run-' + String(this.count + 1));
    this.createTree = deps.createTree ?? createDiscoveryTree;
    // Offline dreaming is driven by the dreamer's own PolicyGenerator (the
    // deterministic or model-backed one); the orchestrator only forwards an
    // explicit override. config.dreamRsi.candidatePoliciesCount still bounds the
    // produced count through the dreamer's policyCount option.
    this.candidatePolicies = deps.candidatePolicies ?? (() => []);
    // P6.2 C1 + t7/V1 (ADR 0002 R2): applyWinningPatch alone NEVER grants the
    // permanent mount. The resolved execution profile's patch permission is the
    // authority; deps.applyWinningPatch is only the caller's additional request
    // (default FALSE - fail-closed for hand-built orchestrators, matching the
    // default assembly). A mount happens only when BOTH allow it:
    //   profile.permissions.patch.allowed (guarded-active only) AND
    //   deps.applyWinningPatch === true.
    const resolvedProfile = deps.executionProfile ?? resolveExecutionProfile();
    this.executionProfile = resolvedProfile;
    this.applyWinningPatch =
      deps.applyWinningPatch === true && resolvedProfile.permissions.patch.allowed;
    // P6.2 C1 (ADR 0002 R1) + t7/V2: the conservative gate IS the
    // guarded-active channel. An explicit deps.conservativeGate=true is only
    // accepted when the resolved profile declares 'guarded-active' - the
    // pre-C1 "hand-built opt-in" that let a shadow/off profile intercept
    // execution was an invalid combination and now FAILS CLOSED (constructor
    // throws, no silent downgrade: the caller must fix the assembly).
    if (deps.conservativeGate === true && resolvedProfile.mode !== 'guarded-active') {
      throw new Error(
        'EvoHarnessOrchestrator: deps.conservativeGate=true requires executionProfile mode ' +
          "'guarded-active' (ADR 0002 R1/V2: shadow/baseline/off must never intercept selection); " +
          'got mode ' +
          String(resolvedProfile.mode)
      );
    }
    this.conservativeGate =
      deps.conservativeGate === true || this.executionProfile.mode === 'guarded-active';
    this.treePool = deps.treePool;
  }

  /** The resolved execution profile (status-page / diagnostics surface). */
  executionProfileSnapshot(): ExecutionProfile {
    return this.executionProfile;
  }

  readonly treePool: IDiscoveryTreePool;

  get runCount(): number {
    return this.count;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  lastTrace(): readonly EvoHarnessStage[] {
    return this.trace;
  }

  /**
   * C2a (ADR 0003 §4.2): the host-authenticated trajectory views of the last
   * run, in verification order (reference first). This is the status-page
   * window onto "which probe was verified, by whom, and what happened to the
   * verdict" - never a claim of real-world benefit.
   */
  lastVerificationViews(): readonly VerificationView[] {
    return this.verificationView;
  }

  lastComposition(): CompositionResult | null {
    return this.composition;
  }

  lastLessons(): readonly CanonicalLesson[] {
    return this.lessons;
  }

  lastPlan(): SearchGridPlan | null {
    return this.plan;
  }

  /** Remaining explicit exploration budget (P6.2 PR-B / F4-5). */
  explorationBudgetRemaining(): number {
    return this.explorationAllowance;
  }

  /**
   * Grant an explicit, revocable exploration allowance (P6.2 PR-B / F4-5).
   *
   * Returns the number actually granted. This is the ONLY way the online path
   * may execute an under-evidenced deviation: the default allowance is 0, so
   * without a grant every such decision falls back to the prior (fail-closed,
   * no implicit exploration).
   */
  grantExplorationBudget(count: number): number {
    if (!Number.isFinite(count) || count <= 0) {
      return this.explorationAllowance;
    }
    this.explorationAllowance += Math.floor(count);
    return this.explorationAllowance;
  }

  /** Revoke the exploration budget back to zero (the revocable half). */
  revokeExplorationBudget(): void {
    this.explorationAllowance = 0;
  }

  // t10/DEAD (t9 finding): settleExplorationReservation was REMOVED. It had no
  // caller and bypassed the releasedReservationKeys idempotency ledger, so a
  // future caller could have double-refunded one cancelled execution. The ONLY
  // reservation settlement path is recordOnlineExperience (keyed by the
  // executed trajectory id; the T8-R5 probe pins the idempotency).

  dreamReports(): readonly DreamReplayReport[] {
    return this.dreams;
  }

  /**
   * C1.1 (ADR-0003 §3.5): Orchestrator-owned unified dream entrypoint.
   * Records replay reports in dreamReports(), increments taskCounter.recordDream(),
   * and emits publication status in diagnostics.
   */
  async triggerDream(diagnostics?: string[]): Promise<DreamReplayReportWithShadow | null> {
    const diag = diagnostics ?? [];
    const report = await this.runDream(this.deps.config, diag);
    if (report !== null) {
      const recordDream = this.deps.taskCounter?.recordDream;
      if (recordDream !== undefined) {
        try {
          await recordDream.call(this.deps.taskCounter);
        } catch (error) {
          diag.push('dream counter update failed: ' + errorMessage(error));
        }
      }
    }
    return report;
  }

  activePatchIds(): readonly string[] {
    return this.patchDisposers.filter((disposer) => disposer.active).map((disposer) => disposer.patchId);
  }

  /** Run the full self-evolution lifecycle for one task. */
  async run(request: EvoHarnessRunRequest): Promise<EvoHarnessRunResult> {
    const config = this.deps.config;
    const startedAt = this.now();
    const runId = request.runId !== undefined && request.runId.length > 0 ? request.runId : this.newId();
    const sessionId = request.sessionId;
    const task = request.task;
    const diagnostics: string[] = [];
    const trace: EvoHarnessStage[] = [];
    this.trace = trace;
    this.composition = null;
    this.lessons = [];
    this.plan = null;
    // C2a: the host-authenticated verification views are per-run state.
    this.verificationView = [];

    let probesRun = 0;
    let lessonsCommitted = 0;
    let rounds = 0;
    let stopReason = 'not_started';
    let referenceStatus: string | null = null;
    let driverKind = 'unbound';
    let appliedPatchId: string | undefined;
    let dreamTriggered = false;

    const stage = (name: EvoHarnessStage, detail?: Readonly<Record<string, unknown>>): void => {
      trace.push(name);
      this.deps.onStage?.(
        detail === undefined
          ? { stage: name, runId }
          : { stage: name, runId, detail }
      );
    };
    const result = (
      outcome: EvoHarnessRunOutcome,
      extra: Partial<EvoHarnessRunResult> = {}
    ): EvoHarnessRunResult => ({
      runId,
      sessionId,
      taskId: task.id,
      outcome,
      trigger: request.trigger,
      probesRun,
      lessonsCommitted,
      diagnostics,
      startedAt,
      endedAt: this.now(),
      metadata: {
        lifecycle: [...trace],
        stopReason,
        rounds,
        referenceStatus,
        memoryDriverKind: driverKind,
        dreamTriggered,
        ...(appliedPatchId === undefined ? {} : { appliedPatchId })
      },
      ...extra
    });

    if (this.disposed) {
      diagnostics.push('orchestrator has been disposed');
      stage('finalize');
      return result('failed', { failure: { category: 'hard_unrecoverable', message: 'orchestrator disposed' } });
    }
    if (!config.enabled) {
      diagnostics.push('plugin disabled (config.enabled=false); the run was skipped');
      stage('finalize');
      return result('skipped');
    }
    if (request.trigger === 'auto_fallback' && config.triggerMode === 'slash_command') {
      diagnostics.push('triggerMode=slash_command: auto_fallback is disabled; the run was skipped');
      stage('finalize');
      return result('skipped');
    }
    if (request.trigger === 'auto_fallback' && !autoFallbackRequested(request)) {
      diagnostics.push('auto_fallback trigger observed no blocking signal; the run was skipped');
      stage('finalize');
      return result('skipped');
    }

    try {
      stage('initialize');
      const descriptor = await this.deps.memory.initialize();
      driverKind = descriptor.driverKind;
      diagnostics.push(
        'memory backend: ' + descriptor.backendLabel + ' (' + descriptor.driverKind + ')'
      );

      stage('recall');
      const scope = this.scopeFor(sessionId);
      const recall = await this.deps.memory.recall({
        scope,
        text: task.prompt,
        limit: config.memoryBridge.recallLimit,
        includeNegative: config.memoryBridge.enableNegativeFirewall,
        ...(task.taskSignature === undefined ? {} : { taskSignature: task.taskSignature }),
        ...(task.contextTags === undefined ? {} : { contextTags: task.contextTags })
      });
      diagnostics.push(
        'recall: ' +
          String(recall.positiveLessons.length) +
          ' positive / ' +
          String(recall.negativeLessons.length) +
          ' negative lesson(s), confidence ' +
          String(recall.confidence)
      );

      const budget = resolveBudget(request.budgetOverride, config);
      const basePolicy = this.deps.policy.policy;
      const runPolicy: MetaSearchPolicy = {
        ...basePolicy,
        maxWidth: Math.min(basePolicy.maxWidth, budget.maxWidth),
        maxDepth: Math.min(basePolicy.maxDepth, budget.maxDepth)
      };

      stage('plan_grid');
      const grid = this.deps.policy.planGrid({
        task,
        memoryConfidence: recall.confidence,
        budgetRemaining: budget.maxOnlineRolloutBudget,
        currentDepth: 0,
        exploredNodes: 0,
        previousFailures: [],
        policy: runPolicy
      });
      this.plan = grid;
      diagnostics.push('plan_grid: ' + grid.rationale);

      if (grid.skipProbing || request.dryRun === true) {
        stopReason = grid.skipProbing ? 'plan_grid_skip' : 'dry_run';
        diagnostics.push(
          grid.skipProbing
            ? 'plan_grid decided to skip probing for this task'
            : 'dry run requested: planning completed without probing'
        );
        stage('finalize');
        return result('no_probe', { treeId: undefined });
      }

      const referencePatch = this.referencePatch(sessionId, runId);
      const tree = this.createTree({
        id: 'tree-' + runId,
        sessionId,
        taskId: task.id,
        rootPatchId: referencePatch.id,
        rootBranchId: 'reference-' + runId,
        rootPatchOrigin: 'reference',
        rootPurpose: 'initial',
        rootGuidance: 'guidance_free',
        policyId: runPolicy.id,
        clock: this.now,
        idFactory: this.newId
      });
      const rootNode = tree.getNode(tree.rootId);
      if (rootNode === undefined) {
        throw new Error('discovery tree root node is missing');
      }

      stage('reference_probe');
      const referenceProbe = await this.deps.seams.runInIsolatedBranch({
        sessionId,
        task,
        patch: referencePatch,
        executor: this.deps.runBranch,
        branchId: 'reference-' + runId,
        role: 'reference',
        treeId: tree.id,
        nodeId: rootNode.id,
        memoryRecallIds: recall.lessons.map((lesson) => lesson.id),
        timeoutMs: config.probe.probeTimeoutMs
      });
      // C2a (ADR 0003 §4.4): the reference goes through the SAME verification
      // rules as every candidate, so the baseline and the probe are scored on
      // one volume. A reference without a trusted receipt forces the whole
      // run's candidate verdicts to audit-only (fail-closed, §4.4.2).
      const referenceVerification = await this.verifyTrajectory(referenceProbe, {
        runId,
        taskId: task.id,
        referenceReceiptMissing: false,
        diagnostics
      });
      const reference = referenceVerification.trajectory;
      const referenceHasReceipt = referenceVerification.disposition?.attached === true;
      probesRun += 1;
      referenceStatus = reference.status;
      tree.recordProbe(rootNode.id, {
        trajectoryId: reference.id,
        status: nodeStatusFor(reference.status),
        metadata: { role: 'reference' }
      });
      const trajectories: ProbeTrajectory[] = [reference];
      const candidates: ProbeCandidate[] = [];
      // nodeId -> the patch that node actually executed, so a child can reuse its
      // parent's cumulative edits (root-to-parent) with a single map read instead of
      // re-walking or re-reading the tree.
      const cumulativePatches = new Map<string, EightSurfacePatch>();
      let previousFailure: FailureDiagnosis | undefined;
      let previousBestNodeId: string | undefined;
      let bestScore = -1;
      let candidateProbes = 0;
      let stagnantRounds = 0;
      let composition: CompositionResult | null = null;
      const maxRounds = Math.max(1, Math.min(grid.maxDepth, budget.maxDepth));
      // Online experience bookkeeping (plan Phase 3 / P6 PR4). The wave below is
      // the commit barrier: a probe enters `executed` only after its execution
      // status was committed to the tree, and every entry carries its OWN
      // trajectory, node, slot index and L1 state. Nothing is shared between
      // siblings, so completion order cannot leak one action's outcome into
      // another (plan sections 6.2 and 6.4).
      const executed: ExecutedProbe[] = [];
      /** L1 state of the round currently being planned (per-round, not global). */
      const l1StateByRound = new Map<number, AbstractState>();
      let stop = false;

      while (!stop && rounds < maxRounds) {
        rounds += 1;
        // Progress is measured per round: the composer re-evaluates every earlier
        // candidate, so a stale winner would otherwise look like progress forever.
        const scoreBeforeRound = bestScore;
        const winnerBeforeRound = composition === null ? null : composition.selectedNodeId;
        stage('select_batch', { round: rounds });
        const batchRequest: SelectBatchRequest = {
          task,
          sessionId,
          tree: tree.snapshot(),
          grid,
          memoryConfidence: recall.confidence,
          round: rounds,
          ...(previousBestNodeId === undefined ? {} : { previousBestNodeId }),
          ...(previousFailure === undefined ? {} : { previousFailure })
        };
        const batch: BatchPlan = this.deps.policy.selectBatch(batchRequest);
        // L1 JitRL diagnostics (plan section 4.3): the decorator attaches them to
        // the batch plan, so the stage appears only when a Jit correction ran.
        // A plain ActivePolicy never sets metadata.jit and keeps the trace
        // byte-identical to the pre-JitRL lifecycle.
        const jitDiagnostics = readJitBatchDiagnostics(batch);
        if (jitDiagnostics !== undefined) {
          stage('jit_meta_adjust', {
            round: rounds,
            detail: {
              stateValue: jitDiagnostics.stateValue,
              neighborCount: jitDiagnostics.neighborCount,
              klToPrior: jitDiagnostics.klToPrior,
              degraded: jitDiagnostics.degraded === true
            }
          });
          if (jitDiagnostics.degraded === true) {
            diagnostics.push(
              'round ' +
                String(rounds) +
                ': jit_meta_adjust was degraded to the unadjusted plan (' +
                String(jitDiagnostics.degradedReason ?? 'unspecified') +
                ')'
            );
          }
        }
        if (batch.slots.length === 0) {
          diagnostics.push('round ' + String(rounds) + ': the active policy selected no slots');
          break;
        }

        // Admission phase. Proposals stay sequential and in slotIndex order
        // because each one reads the pre-round tree/recall state; the expensive
        // isolated probe executions below are what runs in parallel. Each admitted
        // slot reserves one candidate-rollout unit up front, so the wave can never
        // launch more probes than the remaining grid/config budget allows.
        const prepared: PreparedProbe[] = [];
        for (const slot of orderBatchSlots(batch.slots)) {
          // The plan_grid budget bounds candidate rollouts. The reference anchor is
          // instrumentation for the contrast, not an exploration rollout, so it is
          // charged to probesRun but never to the exploration budget; otherwise a
          // memory-confident plan with budget 1 could not evolve anything.
          const reservedProbes = candidateProbes + prepared.length;
          if (reservedProbes >= grid.budget || reservedProbes >= budget.maxOnlineRolloutBudget) {
            stopReason = 'budget_exhausted';
            stop = true;
            break;
          }
          const parentNode = tree.getNode(slot.parentNodeId) ?? rootNode;
          const guidance = this.guidanceForSlot(slot, recall, config);
          // Round >= 2 exploit/recover slots deepen or repair an already probed
          // candidate, so the proposer must see what that parent actually changed.
          // The reference root is never a candidate, so nothing is passed for it.
          const parentCandidate = candidates.find(
            (candidate) => candidate.nodeId === parentNode.id
          );

          stage('propose', { round: rounds, detail: { slot: slot.slot } });
          let proposed: ProposedPatch;
          let selection:
            | {
                readonly chosen: number;
                readonly offered: number;
                readonly priorIndex?: number;
                readonly proposedIndex?: number;
                readonly gateReason?: PreparedSelection['gateReason'];
                readonly exploration?: boolean;
                readonly semanticKind?: string;
                readonly challenger?: PreparedSelection['challenger'];
              }
            | undefined;
          try {
            // L2: when the proposer can emit K candidates and JitRL covers the
            // 'proposal' level, one of them is chosen here BEFORE probing. The
            // probe budget is untouched: K candidates still cost exactly one probe.
            const picked = await this.selectProposal({
              sessionId,
              task,
              slot,
              guidance,
              parentNode,
              parentCandidate,
              reference,
              recall,
              rounds,
              grid,
              diagnostics
            });
            if (picked !== undefined) {
              proposed = picked.proposed;
              selection = {
                chosen: picked.chosen,
                offered: picked.offered,
                ...(picked.priorIndex === undefined ? {} : { priorIndex: picked.priorIndex }),
                ...(picked.proposedIndex === undefined ? {} : { proposedIndex: picked.proposedIndex }),
                ...(picked.gateReason === undefined ? {} : { gateReason: picked.gateReason }),
                ...(picked.exploration === undefined ? {} : { exploration: picked.exploration }),
                ...(picked.semanticKind === undefined ? {} : { semanticKind: picked.semanticKind }),
                ...(picked.challenger === undefined ? {} : { challenger: picked.challenger })
              };
            } else {
              // No L2 decision ran (single candidate / fallback paths): the
              // prior/proposed/executed triple stays absent, which the ledger
              // counts read as "no decision" rather than "no deviation".
              proposed = await this.deps.proposer.propose({
                task,
                sessionId,
                slot,
                guidance,
                parentNode,
                ...(parentCandidate === undefined ? {} : { parentPatch: parentCandidate.patch }),
                referenceTrajectory: reference,
                enabledSurfaces: config.enabledSurfaces,
                attemptIndex: slot.slotIndex + 1,
                totalBudget: grid.budget
              });
            }
          } catch (error) {
            diagnostics.push(
              'proposal failed for slot ' + slot.slot + ': ' + errorMessage(error)
            );
            continue;
          }
          if (selection !== undefined) {
            stage('jit_proposal_select', {
              round: rounds,
              detail: {
                slot: slot.slot,
                chosen: selection.chosen,
                offered: selection.offered
              }
            });
          }

          const node: DiscoveryNode = tree.addNode({
            parentId: parentNode.id,
            branchId: slot.branchId,
            patchId: proposed.patch.id,
            patchOrigin: proposed.patch.origin,
            purpose: proposed.patch.purpose,
            guidance: proposed.patch.guidance,
            status: 'probing',
            slot: slot.slot,
            round: rounds
          });

          // The proposer only returns the child delta, but a probe must run against
          // the whole scaffold: every ancestor edit merged root-to-parent (later
          // patches overriding earlier ones) and then overlaid by this round's edits.
          // The cumulative entry is reused by children, a missing entry falls back to
          // the parent's incremental patch, and the lookup is a single map read, so
          // repeated ids or a cyclic parent chain cannot loop. A candidate without a
          // parent (the reference root) still executes exactly its own patch object.
          const inheritedEdits =
            parentCandidate === undefined
              ? undefined
              : (cumulativePatches.get(parentCandidate.nodeId) ?? parentCandidate.patch).edits;
          const executionPatch: EightSurfacePatch =
            inheritedEdits === undefined
              ? proposed.patch
              : {
                  ...proposed.patch,
                  edits: { ...inheritedEdits, ...proposed.patch.edits }
                };
          if (!cumulativePatches.has(node.id)) {
            cumulativePatches.set(node.id, executionPatch);
          }
          // L2 sample: the abstract proposal state plus the signature of the patch
          // actually chosen, so the store can grow a proposal neighbourhood. The
          // decisionId identifies THIS decision, not the run's final winner.
          const selectionState: PreparedSelection | undefined =
            selection === undefined
              ? undefined
              : {
                  state: abstractProposalState({
                    task,
                    round: rounds,
                    parentDepth: finiteOr(parentNode.depth, 0),
                    parentSlot: slot.slot,
                    memoryConfidence: finiteOr(recall.confidence, 0),
                    referenceStatus: reference.status === 'succeeded' ? 'succeeded' : 'failed',
                    slot: slot.slot,
                    guidance: slot.guidance,
                    ...(parentCandidate === undefined
                      ? {}
                      : { parentPatchSignature: normalizePatchSignature(parentCandidate.patch) })
                  }),
                  actionKey: normalizePatchSignature(proposed.patch),
                  decisionId: 'jit-decision-' + runId + '-r' + String(rounds) + '-s' + String(slot.slotIndex),
                  chosenIndex: selection.chosen,
                  offered: selection.offered,
                  ...(selection.priorIndex === undefined ? {} : { priorIndex: selection.priorIndex }),
                  ...(selection.proposedIndex === undefined ? {} : { proposedIndex: selection.proposedIndex }),
                  ...(selection.gateReason === undefined ? {} : { gateReason: selection.gateReason }),
                  ...(selection.exploration === undefined ? {} : { exploration: selection.exploration }),
                  ...(selection.semanticKind === undefined ? {} : { semanticKind: selection.semanticKind }),
                  ...(selection.challenger === undefined ? {} : { challenger: selection.challenger })
                };
          prepared.push({ slot, node, proposed, executionPatch, ...(selectionState === undefined ? {} : { selection: selectionState }) });
        }

        // The L1 state of THIS round, captured once and reused by every probe of
        // the wave. It is the state that produced this batch (not a later round's)
        // and it is keyed by round, so an earlier round's slots keep their own
        // state when the run reaches a later round (plan section 6.2: never
        // `l1Samples.at(-1)`).
        if (prepared.length > 0) {
          l1StateByRound.set(rounds, buildL1State(batchRequest));
        }

        if (prepared.length > 0) {
          // Probe phase: bounded concurrency, launched in slotIndex order. The
          // 'probe' trace entries therefore always appear in plan order even though
          // completion order is arbitrary.
          const settled = await settleWithConcurrency(
            prepared.map(
              (entry) => async (): Promise<ProbeTrajectory> => {
                stage('probe', { round: rounds, detail: { nodeId: entry.node.id } });
                return await this.probeCandidate({
                  sessionId,
                  task,
                  slot: entry.slot,
                  patchId: entry.executionPatch.id,
                  patch: entry.executionPatch,
                  nodeId: entry.node.id,
                  treeId: tree.id,
                  referenceTrajectoryId: reference.id,
                  recallIds: recall.lessons.map((lesson) => lesson.id),
                  runId,
                  referenceReceiptMissing: !referenceHasReceipt,
                  diagnostics
                });
              }
            ),
            resolveProbeConcurrency(config)
          );

          // A rejected probe fails the run exactly like the serial loop did, but
          // only after every already-started peer has settled (so branch isolation
          // is released). Roll back the budget to serial accounting: probes before
          // the first failure are charged like a serial prefix, while the failing
          // slot and any started-but-not-run reservations are released instead of
          // silently consuming rollout budget.
          const firstFailure = settled.findIndex((entry) => entry.status === 'rejected');
          if (firstFailure >= 0) {
            for (let index = 0; index < firstFailure; index += 1) {
              const outcome = settled[index];
              if (outcome !== undefined && outcome.status === 'fulfilled') {
                probesRun += 1;
                candidateProbes += 1;
                trajectories.push(outcome.value);
              }
            }
            const failed = settled[firstFailure];
            throw failed !== undefined && failed.status === 'rejected'
              ? failed.reason
              : new Error('probe failed without a rejection reason');
          }

          // Commit phase: strictly in slotIndex order. Classify/score/tree writes
          // and trace entries are identical to the serial implementation, so a
          // concurrent probe that finishes first can never reorder tree state.
          for (let index = 0; index < prepared.length; index += 1) {
            const entry = prepared[index];
            const outcome = settled[index];
            if (entry === undefined || outcome === undefined || outcome.status !== 'fulfilled') {
              throw new Error('probe wave did not settle slot index ' + String(index));
            }
            const { slot, node, proposed } = entry;
            const trajectory = outcome.value;
            probesRun += 1;
            candidateProbes += 1;
            trajectories.push(trajectory);
            stage('classify', { round: rounds, detail: { nodeId: node.id } });
            // Lineage comes from the node's ancestor chain, not from the previous
            // sibling, so repeated-failure counting accumulates across depths and
            // 'repeatedly_unpromising' (threshold 3) is reachable.
            const lineage: readonly FailureDiagnosis[] = tree
              .ancestorsOf(node.id)
              .map((ancestor) => ancestor.failure)
              .filter(
                (failure): failure is FailureDiagnosis =>
                  failure !== undefined && failure.category !== 'none'
              );
            const diagnosis: FailureDiagnosis = this.deps.taxonomy.diagnose({
              trajectory,
              node,
              attemptIndex: lineage.length + 1,
              previousDiagnoses: lineage,
              hasUnexploredDirections: rounds < maxRounds,
              maxDepthReached: rounds >= maxRounds
            });

            stage('score', { round: rounds, detail: { nodeId: node.id } });
            // Score a snapshot whose status already reflects the probe outcome. The
            // tree node is still 'probing' until recordProbe, and with no composition
            // yet a non-succeeded node zeroes the selection signal, so only the
            // efficiency + error-penalty terms could score (a hard 0.2 ceiling).
            const probeStatus = nodeStatusFor(trajectory.status);
            const scoredNode: DiscoveryNode = { ...node, status: probeStatus };
            const score: SurrogateScore = this.deps.scorer.score({
              node: scoredNode,
              trajectory,
              referenceTrajectory: reference,
              weights: config.dreamRsi.surrogateWeights
            });

            tree.recordProbe(node.id, {
              trajectoryId: trajectory.id,
              status: probeStatus,
              score: score.score,
              ...(diagnosis.category === 'none' ? {} : { failure: diagnosis }),
              // surfaceKeys is what ActivePolicy.surfacesFromMetadata reads to focus
              // exploit/recover slots on the surfaces that actually moved.
              metadata: { slot: slot.slot, surfaceKeys: [...trajectory.surfaceKeys] }
            });
            // The execution status is now COMMITTED, so this probe becomes a
            // credit-attribution unit (plan section 6.2: never record a "success
            // sample" before the probe is known to have finished). It carries its
            // own trajectory/node/slot, so a sibling's outcome can never be
            // copied onto it - including when it failed and the run has no winner.
            const l1State = l1StateByRound.get(rounds);
            if (l1State !== undefined) {
              executed.push({
                round: rounds,
                slotIndex: slot.slotIndex,
                slot,
                l1State,
                nodeId: node.id,
                parentNodeId: node.parentId ?? tree.rootId,
                branchId: trajectory.branchId,
                actionKey: slotActionKey(slot),
                guidance: slotProvenance(slot),
                trajectory,
                ...(entry.selection === undefined ? {} : { selection: entry.selection })
              });
            }
            candidates.push({
              nodeId: node.id,
              branchId: trajectory.branchId,
              patch: proposed.patch,
              trajectory
            });
            // Only a succeeded candidate may become the exploitation parent: a failed
            // run still scores above 0 through the efficiency term and must never be
            // deepened by ActivePolicy.resolveBestNode.
            if (probeStatus === 'succeeded' && score.score > bestScore) {
              bestScore = score.score;
              previousBestNodeId = node.id;
            }
            if (diagnosis.category !== 'none') {
              // Retain the failure: ActivePolicy.findRecoveryTarget needs it to
              // schedule a recover slot even when a sibling slot just succeeded.
              // Precedence keeps a repairable failure visible to the next round.
              previousFailure = resolvePreviousFailure(previousFailure, diagnosis);
            }
          }
        }

        if (candidates.length === 0) {
          diagnostics.push('no candidate probe completed; probing stops');
          break;
        }

        stage('compose', { round: rounds });
        composition = await this.deps.composer.compose({
          task,
          sessionId,
          candidates,
          reference,
          policyId: runPolicy.id,
          metadata: { round: rounds, referenceStatus: reference.status }
        });
        this.composition = composition;

        // Re-score every candidate against the composition that now exists and
        // persist the final surrogate score plus the adoption ratio, then derive
        // bestScore/previousBestNodeId from those final values. This is what turns
        // the selection (0.4) and adoption (0.3) signals on at all.
        // The pre-compose best was scored without a composition, so it carried a
        // phantom +0.4 selection bonus. Recompute both values from -1 over the final
        // scores so a losing candidate cannot keep the exploitation pointer.
        let bestFinalScore = -1;
        previousBestNodeId = undefined;
        for (const candidate of candidates) {
          const currentNode = tree.getNode(candidate.nodeId);
          if (currentNode === undefined) {
            continue;
          }
          const finalScore: SurrogateScore = this.deps.scorer.score({
            node: currentNode,
            trajectory: candidate.trajectory,
            referenceTrajectory: reference,
            composition,
            weights: config.dreamRsi.surrogateWeights
          });
          const assessment = composition.assessments.find(
            (entry) => entry.nodeId === candidate.nodeId
          );
          tree.updateNode(candidate.nodeId, {
            score: finalScore.score,
            ...(assessment === undefined ? {} : { adoptionRatio: assessment.adoptionRatio })
          });
          if (candidate.trajectory.status === 'succeeded' && finalScore.score > bestFinalScore) {
            bestFinalScore = finalScore.score;
            previousBestNodeId = candidate.nodeId;
          }
        }
        bestScore = bestFinalScore;

        // A round improves only when the best final score rose or the overall winner
        // changed; re-selecting an earlier winner is not progress.
        const improvedThisRound =
          bestScore > scoreBeforeRound + 1e-9 ||
          (composition.selectedNodeId !== null && composition.selectedNodeId !== winnerBeforeRound);
        if (improvedThisRound) {
          stagnantRounds = 0;
        } else {
          stagnantRounds += 1;
        }

        if (grid.stopCondition === 'first_success' && candidates.some((candidate) => candidate.trajectory.status === 'succeeded')) {
          stopReason = 'first_success';
          stop = true;
          break;
        }
        if (candidateProbes >= grid.budget || candidateProbes >= budget.maxOnlineRolloutBudget) {
          stopReason = 'budget_exhausted';
          stop = true;
          break;
        }
        // Only a hard-unrecoverable diagnosis ends the whole task. A repeatedly
        // unpromising lineage means 'explore elsewhere' for that lineage, so the run
        // keeps probing other directions (the policy keeps it out of exploit/recover).
        if (previousFailure !== undefined && previousFailure.category === 'hard_unrecoverable') {
          stopReason = 'failure_taxonomy:' + previousFailure.category;
          stop = true;
          break;
        }
        if (stagnantRounds >= 2) {
          stopReason = 'diminishing_returns';
          stop = true;
          break;
        }
        if (rounds >= maxRounds) {
          stopReason = 'max_depth';
          stop = true;
        }
      }

      if (stopReason === 'not_started') {
        stopReason = stop ? 'stopped' : 'rounds_completed';
      }

      let selectedNodeId: string | undefined;
      let selectedBranchId: string | undefined;
      let selectedTrajectoryId: string | undefined;
      let composedPatchId: string | undefined;

      if (candidates.length > 0 && composition !== null) {
        stage('reflect');
        const reflection = await this.deps.reflector.reflect({
          task,
          sessionId,
          tree: tree.snapshot(),
          composition,
          trajectories,
          referenceTrajectory: reference,
          recall,
          scope,
          // The reflector needs the candidate patch bodies to attach
          // executionPatch.componentDiffs (and to syntax-audit embedded scripts).
          metadata: { candidatePatches: candidates.map((candidate) => candidate.patch) }
        });
        this.lessons = reflection.lessons;

        // Phase 3 online learning, rewritten by P6 PR4: every probe that actually
        // executed gets its own record (see recordOnlineExperience). The write is
        // a CROSS-RUN barrier (plan section 6.4): it happens once, after reflect,
        // and the next run sees it - never a sibling within the same wave.
        const recorded = await this.recordOnlineExperience({
          kernel: this.deps.jitrl,
          task,
          sessionId,
          executed,
          reference,
          selectedNodeId: composition.selectedNodeId,
          policyId: runPolicy.id,
          runId,
          treeId: tree.id,
          round: rounds,
          stage,
          diagnostics
        });
        if (recorded > 0) {
          diagnostics.push('jitrl: appended ' + String(recorded) + ' online experience record(s)');
        }

        stage('commit');
        lessonsCommitted = await this.commitLessons(reflection.lessons, scope, diagnostics);

        stage('apply_patch');
        const winningPatch = composition.composedPatch ?? composition.selectedPatch;
        // t7/V1 (ADR 0002 R2): the mount requires BOTH the caller's explicit
        // applyWinningPatch request AND the execution profile's patch
        // permission (guarded-active only). The profile check is repeated HERE
        // - at the single permanent-mount call site - so the permission is
        // enforced even if the constructor flag ever drifts: defense in depth,
        // and the diagnostic makes a denied mount visible instead of silent.
        if (
          winningPatch !== null &&
          this.applyWinningPatch &&
          this.executionProfile.permissions.patch.allowed
        ) {
          // Roll back the scaffold mounted by an earlier run() before mounting the
          // new winner, so a long-lived host never stacks prompt segments,
          // middleware or skills across successive runs.
          await this.disposeMountedPatches(diagnostics);
          const disposer = await this.deps.seams.applyPermanentPatch(winningPatch);
          this.patchDisposers.push(disposer);
          composedPatchId = winningPatch.id;
          appliedPatchId = winningPatch.id;
          diagnostics.push('permanently mounted scaffold ' + winningPatch.id);
        } else if (winningPatch !== null && this.applyWinningPatch) {
          diagnostics.push(
            'apply_patch: winning patch NOT mounted - the execution profile denies the ' +
              'patch layer (' +
              this.executionProfile.permissions.patch.reason +
              ')'
          );
        }
        selectedNodeId = composition.selectedNodeId ?? undefined;
        selectedBranchId = composition.selectedBranchId ?? undefined;
        selectedTrajectoryId = composition.selectedTrajectoryId ?? undefined;
      }

      tree.setCompleted(true);
      this.treePool.add(tree.snapshot());
      this.count += 1;
      // Record the completed task in the durable counter (when one is injected)
      // before deciding to dream, so the cadence is continuous across restarts.
      const counter = this.deps.taskCounter;
      if (counter !== undefined) {
        try {
          await counter.recordCompletedTask();
        } catch (error) {
          diagnostics.push('task counter update failed: ' + errorMessage(error));
        }
      }

      if (this.shouldDream(config)) {
        stage('offline_dream');
        const dream = await this.triggerDream(diagnostics);
        if (dream !== null) {
          dreamTriggered = true;
        }
      }

      stage('finalize');
      const outcome: EvoHarnessRunOutcome =
        candidates.length === 0
          ? 'no_probe'
          : composition !== null &&
              (composition.selectedPatch !== null || composition.composedPatch !== null)
            ? 'composed'
            : 'probed';

      return result(outcome, {
        treeId: tree.id,
        ...(selectedNodeId === undefined ? {} : { selectedNodeId }),
        ...(selectedBranchId === undefined ? {} : { selectedBranchId }),
        ...(selectedTrajectoryId === undefined ? {} : { selectedTrajectoryId }),
        ...(composedPatchId === undefined ? {} : { composedPatchId })
      });
    } catch (error) {
      diagnostics.push('lifecycle failed: ' + errorMessage(error));
      stage('finalize');
      return result('failed', {
        failure: { category: 'hard_unrecoverable', message: errorMessage(error) }
      });
    }
  }

  /**
   * Dispose every permanent patch mounted by an earlier run and clear the list.
   * Inactive disposers are skipped and a throwing disposer is recorded as a
   * diagnostic instead of aborting the run.
   */
  private async disposeMountedPatches(diagnostics: string[]): Promise<void> {
    const mounted = this.patchDisposers.splice(0, this.patchDisposers.length);
    for (const disposer of mounted) {
      if (!disposer.active) {
        continue;
      }
      try {
        await disposer.dispose();
      } catch (error) {
        diagnostics.push(
          'failed to roll back permanent patch ' + disposer.patchId + ': ' + errorMessage(error)
        );
      }
    }
  }

  /** Release permanent patches and any retained collaborator state. */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const disposer of this.patchDisposers) {
      if (!disposer.active) {
        continue;
      }
      try {
        await disposer.dispose();
      } catch {
        // Disposal is best effort; the seam layer already reported the failure.
      }
    }
    this.patchDisposers.length = 0;
    try {
      await this.deps.seams.dispose();
    } catch {
      // ignore
    }
    try {
      await this.deps.memory.dispose();
    } catch {
      // ignore
    }
  }

  private scopeFor(sessionId: string): MemoryScope {
    const scope = this.deps.commitScope?.(sessionId);
    return scope ?? { kind: 'session', sessionId };
  }

  /**
   * True when the injected runtime control permits `surface` right now.
   *
   * Without a wired control the caller falls back to its own static checks (the
   * pre-PR2 behaviour for hosts that build the orchestrator by hand). With one,
   * the VOLATILE state wins: `configured`/`kernel.config.enabled` staying true
   * never implies the surface may act, because `/evo jit off` only flips the
   * control. A throwing control fails closed - an error must never re-enable an
   * external effect.
   */
  private surfaceEnabled(surface: JitSurface): boolean {
    // t8/R1 (ADR 0002 §3): a DECLARED mode 'off' stops the Jit surfaces this
    // orchestrator drives (L2 selection, online record, mirror gating) on top
    // of the volatile PR2 control. Static declaration and runtime command are
    // distinct stop paths: either one alone halts the surface (fail-closed).
    if (this.executionProfile.off) {
      return false;
    }
    const control = this.deps.jitRuntime;
    if (control === undefined) {
      return true;
    }
    try {
      return control.isEnabled(surface);
    } catch {
      return false;
    }
  }

  /**
   * Current control generation (0 when no control is wired).
   *
   * Captured before an external effect and re-read afterwards: a change means
   * the switch moved while the effect was in flight. The effect itself is never
   * withdrawn (a sent model call cannot be unsent), but its result must not be
   * published as a decision, appended as experience or mirrored.
   */
  private runtimeGeneration(): number {
    const control = this.deps.jitRuntime;
    if (control === undefined) {
      return 0;
    }
    try {
      return control.snapshot().generation;
    } catch {
      return 0;
    }
  }

  private referencePatch(sessionId: string, runId: string): {
    id: string;
    sessionId: string;
    branchId: string;
    origin: 'reference';
    purpose: 'initial';
    guidance: 'guidance_free';
    label: string;
    rationale: string;
    edits: Record<string, never>;
    createdAt: number;
  } {
    return {
      id: 'patch-reference-' + runId,
      sessionId,
      branchId: 'reference-' + runId,
      origin: 'reference',
      purpose: 'initial',
      guidance: 'guidance_free',
      label: 'reference-run',
      rationale: 'baseline run used as the behavioral-contrast anchor',
      edits: {},
      createdAt: this.now()
    };
  }

  private guidanceForSlot(
    slot: BatchSlotPlan,
    recall: MemoryRecallResult,
    config: EvoHarnessConfig
  ): ProposerGuidance {
    if (!config.dreamRsi.enableAsymmetricGuidance) {
      return { mode: 'domain', memory: recall };
    }
    if (slot.slot === 'explore_invariant' || slot.guidance === 'guidance_free') {
      return { mode: 'invariant', memory: null };
    }
    return { mode: 'domain', memory: recall };
  }

  /**
   * evaluate_steps + record_experience (plan Phase 3 / gap G2-3): score the
   * winning trajectory, then append one L1 and one L2 sample per round.
   *
   * Silent no-op when the kernel is absent, JitRL is disabled, or no candidate
   * was selected: the pre-Phase-3 lifecycle stays byte-identical. Cost gating is
   * the evaluator's own (plan section 6.5) - the orchestrator adds none.
   *
   * Returns the number of records appended (0 when nothing was written).
   */
  /**
   * evaluate_steps + record_experience (plan Phase 3 / gap G2-3; rewritten by
   * P6 PR4 / plan sections 6.1-6.5).
   *
   * WHAT CHANGED AND WHY
   * --------------------
   * The pre-PR4 implementation evaluated ONE trajectory (the composer's final
   * winner) and then copied its discounted return onto every action of the LAST
   * L1 batch and onto every L2 selection the run had accumulated. That is the
   * "copy the winner's return" defect of plan section R4:
   *   - `l1Samples.at(-1)` dropped every earlier round;
   *   - a failed slot in the same batch received the winner's positive return;
   *   - a run with no winner recorded nothing at all (no negative sample);
   *   - every L2 record was stamped with the winner's nodeId instead of the node
   *     that actually executed the selection.
   *
   * The rewrite attributes credit PER EXECUTED PROBE. `input.executed` holds one
   * entry per probe whose execution status was committed to the tree, each with
   * its own trajectory, node, slot index, L1 state and (when L2 chose it) its own
   * selection. Consequences:
   *   - every executed action gets its own reward, return and learning target;
   *   - a candidate that never ran has no entry, so it can never receive a
   *     measured reward;
   *   - a run without a winner still records its executed failures;
   *   - L2 actionKey/nodeId/trajectoryId all come from the same executed probe.
   *
   * WHEN LEARNING HAPPENS (plan section 6.4)
   * ----------------------------------------
   * The commit barrier is the WAVE: `input.executed` is only populated after a
   * round's parallel probes have all settled and their statuses were committed in
   * slotIndex order, so completion order cannot influence the record set. The
   * write itself happens once, after `reflect`, which makes this explicitly
   * CROSS-RUN learning (the plan's documented fallback): the store grows between
   * runs, never inside one. Every round's records are written, not just the last
   * round's, so "cross-run" loses nothing.
   *
   * COST (plan section 6.3)
   * -----------------------
   * The (possibly model-backed) step evaluator is called at most ONCE per run, for
   * the composer's winner, exactly as before. Every other executed probe is scored
   * from verifiable signals already present in its trajectory (tool status,
   * repeated errors, completion, step count, failure type), so per-slot scoring
   * never multiplies the model bill. No LLM judge is introduced by this round.
   *
   * Silent no-op when the kernel is absent or JitRL is disabled/off.
   * Returns the number of records appended (0 when nothing was written).
   */
  private async recordOnlineExperience(input: {
    readonly kernel: OrchestratorJitRl | undefined;
    readonly task: ProbeTask;
    readonly sessionId: string;
    readonly executed: readonly ExecutedProbe[];
    readonly reference: ProbeTrajectory;
    readonly selectedNodeId: string | null;
    readonly policyId: string;
    readonly runId: string;
    readonly treeId: string;
    readonly round: number;
    readonly stage: (name: EvoHarnessStage, detail?: Readonly<Record<string, unknown>>) => void;
    readonly diagnostics: string[];
  }): Promise<number> {
    const kernel = input.kernel;
    const evaluator = kernel?.stepEvaluator;
    if (kernel === undefined || !kernel.config.enabled || evaluator === undefined) {
      return 0;
    }
    // P6 PR2: `kernel.config.enabled` is CONFIGURED. The volatile control is
    // authoritative, so `/evo jit off` stops scoring and appending even though
    // the kernel stays configured (plan R1: the experience store kept growing).
    if (!this.surfaceEnabled('onlineRecord')) {
      return 0;
    }
    if (input.executed.length === 0) {
      input.diagnostics.push('jitrl: no executed probe, nothing to attribute');
      return 0;
    }

    // Deterministic attribution order: round, then slotIndex, then nodeId. This
    // is the wave-commit order, so a probe that finished first can never reorder
    // the experience set (plan section 6.4).
    const ordered = [...input.executed].sort((left, right) => {
      if (left.round !== right.round) {
        return left.round - right.round;
      }
      if (left.slotIndex !== right.slotIndex) {
        return left.slotIndex - right.slotIndex;
      }
      return left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0;
    });

    // The composer's winner still justifies the (possibly model-backed) step
    // evaluation: its per-step vector is an AUXILIARY signal under the
    // RewardContract (judge-policy), it no longer defines the winner's primary
    // target. A run without a winner evaluates nothing and still records every
    // executed probe from verifiable signals.
    const winner = ordered.find((probe) => probe.nodeId === input.selectedNodeId);
    let winnerRewards: readonly StepReward[] | undefined;
    if (winner !== undefined) {
      input.stage('evaluate_steps', { round: input.round, detail: { nodeId: winner.nodeId } });
      // Snapshot the switch before the (external) model-backed evaluation. The
      // evaluator may spend a real model call; if `/evo jit off` lands while it is
      // in flight, that call is not withdrawn, but its result must not become
      // training data (plan P6 section 5.1 "执行中关闭").
      const generationBeforeEvaluate = this.runtimeGeneration();
      try {
        const rewards = await evaluator.evaluate(winner.trajectory, {
          task: input.task,
          reference: input.reference
        });
        if (rewards.length > 0) {
          winnerRewards = rewards;
        } else {
          input.diagnostics.push(
            'evaluate_steps produced no steps for the winner; its verifiable signals are used instead'
          );
        }
      } catch (error) {
        // A failed evaluation must not delete the run's negative samples: the
        // winner falls back to the same verifiable signals as its siblings.
        input.diagnostics.push(
          'evaluate_steps failed: ' + errorMessage(error) + '; verifiable signals are used instead'
        );
      }
      if (
        !this.surfaceEnabled('onlineRecord') ||
        this.runtimeGeneration() !== generationBeforeEvaluate
      ) {
        input.diagnostics.push(
          'jitrl: JitRL was switched while evaluate_steps was in flight; the step rewards were discarded and no experience was recorded'
        );
        return 0;
      }
    } else {
      input.diagnostics.push(
        'jitrl: the run has no winning candidate; ' +
          String(ordered.length) +
          ' executed probe(s) are recorded from their own verifiable signals'
      );
    }

    // P6.1-D RewardContract: ONE yardstick per rewardVersion. The baseline (the
    // reference run, the comparable same-task context of plan section 6.3) is
    // scored by the SAME aggregation as every candidate below, so the
    // learningTarget contrast compares like with like.
    //
    // C2a (ADR 0003 §4.4): BOTH roles are scored with the SAME host-owned
    // trusted-producer set and both carry their own host receipt, so the
    // contrast measures the patch, not a one-sided verification coverage. With
    // no seam this argument is undefined and the call is byte-identical.
    const trustedProducers = this.verificationTrustedProducers();
    const scoreOptions =
      trustedProducers === undefined ? {} : { trustedProducers };
    const baseline = clamp(scoreUnderRewardContract(input.reference, scoreOptions).reward, -3, 3);
    // C2a: the run's verification summary for the stage detail (factual, not a
    // constant claim). No seam => the exact pre-C2a literal is emitted below.
    let verificationSummary: VerificationRunSummary = accumulateVerificationSummary(
      { trusted: 0, auditOnly: 0, reasonCodes: [] },
      readVerificationDisposition(input.reference)
    );
    const createdAt = this.now();
    const records: ExperienceRecord[] = [];
    const outcomes: string[] = [];
    let ineligible = 0;
    let notTaskQuality = 0;
    // P6.2 C0 (ADR R8): the mode/vocabulary stamps are resolved ONCE per run
    // from the execution profile, so every record of the run declares the same
    // explicit decisionMode (baseline/shadow/guarded-active).
    const mode: DecisionMode = recordModeOf(this.executionProfile.mode);
    const actionKeyVocabulary: ActionKeyVocabulary = 'signature';
    let releasedReservations = 0;

    for (const probe of ordered) {
      // R5-6: a budget-charged execution whose outcome carries no quality
      // evidence (cancel/abort/infra) releases its reserved seat.
      // t8/R5: the refund is IDEMPOTENT per executed trajectory - the release
      // key is remembered, so a re-entered recorder (dedup / off mid-flight)
      // can never refund the same cancelled execution twice.
      if (probe.selection?.exploration === true) {
        const releaseKey = 'release\u0000' + probe.trajectory.id;
        if (!this.releasedReservationKeys.has(releaseKey)) {
          const wasReleased = shouldReleaseReservation({
            exploration: true,
            completed: true,
            outcome: classifyTrajectoryOutcome(probe.trajectory)
          });
          if (wasReleased) {
            this.releasedReservationKeys.add(releaseKey);
            this.explorationAllowance += 1;
            releasedReservations += 1;
          }
        }
      }
      // P6.2 C0 (ADR 0002 R4): ONE evaluation object per executed trajectory;
      // the record consumes it (reward / outcome / eligibility) instead of
      // re-deriving anything. The winner's step rewards remain an AUXILIARY
      // stepJudge source (judge-policy), never the yardstick.
      const evaluation = scoreUnderRewardContract(probe.trajectory, scoreOptions);
      const outcome = evaluation.outcome;
      outcomes.push(outcome);
      // t10/V3b (t9 finding): the recorder reads the SEPARATED flags instead of
      // re-deriving the rule through a && chain:
      //   - `learningEligible` is the outcome-level process eligibility;
      //   - `taskQualityLearningEligible` is the CONSUMPTION gate (the process
      //     path keeps unknown-verdict records trainable; a verdict-derived
      //     completion trains only from a trusted source);
      //   - `taskQualityEvidence` is the verdict-side FACT (true only for a
      //     trusted verdict-derived completion; unknown/untrusted ALWAYS false).
      // The learning track is stamped from the evaluation directly: process
      // ⇔ NOT taskQualityEvidence, so the field⇔track consistency the
      // regression asserts is structural, not incidental.
      //
      // C2a (ADR 0003 §5.1-§5.2, captain option (a) - zero behaviour change):
      // TWO explicitly named gates. `outcomeEligible` is the OUTCOME-level
      // process eligibility (`isLearningOutcome`, i.e. not cancel/abort/infra);
      // `consumptionEligible` is the task-quality consumption gate. The LEARNING
      // branch writes `learningEligible = consumptionEligible && outcomeEligible`
      // (always true there, i.e. exactly `evaluation.learningEligible` as the ADR
      // requires), and the AUDIT branch keeps the audit-only encoding
      // `learningEligible: false` + reward 0 so a shape-only verdict can never
      // become a learnable positive sample and never counts as support/nEff.
      //
      // C2a (ADR 0003 §4.3): the truth-table rows that are audit-only REGARDLESS
      // of the process gate (abnormal execution, contradictory verdict,
      // falsified success claim, missing reference receipt) arrive as
      // `forceAuditOnly` on the host disposition and veto consumption here.
      const verificationDisposition = readVerificationDisposition(probe.trajectory);
      const outcomeKind = classifyTrajectoryOutcome(probe.trajectory);
      const outcomeEligible = isLearningOutcome(outcomeKind);
      const forcedAuditOnly =
        verificationDisposition?.forceAuditOnly === true ||
        verificationDisposition?.reasonCode === 'falsified-success-claim';
      const consumptionEligible = evaluation.taskQualityLearningEligible && !forcedAuditOnly;
      const eligible = consumptionEligible;
      if (!eligible && outcomeEligible) {
        notTaskQuality += 1;
      }
      if (!eligible) {
        ineligible += 1;
      }
      // C2a: the host-authenticated view of this trajectory (undefined when no
      // seam is configured, in which case NO verification marks are persisted).
      verificationSummary = accumulateVerificationSummary(verificationSummary, verificationDisposition);
      const verificationMarks = verificationRewardMarks({
        disposition: verificationDisposition,
        verdict: evaluation.verification.status,
        trustedSource: evaluation.verification.trustedSource,
        outcomeEligible,
        consumed: consumptionEligible
      });
      // P6.2 t7/V3 + t10/V3b (ADR 0002 5.2a-4): the EXPLICIT learning track,
      // stamped from the evaluation's own separated fields. The task-quality
      // track requires the FACT flag (trusted verdict-derived completion only);
      // every other learnable record is a process observation. The invariant
      // "learningTrack ∈ process ⇒ taskQualityEvidence === false" is therefore
      // structural and pinned by the production regression (field⇔track).
      const learningTrack: LearningTrack = evaluation.taskQualityEvidence
        ? 'task-quality'
        : 'process';
      const isWinner = winnerRewards !== undefined && probe.nodeId === input.selectedNodeId;
      let reward: number;
      let observedReturn: number;
      let rewardSources: Readonly<Record<string, number>>;
      // P6.2 PR-B / F4-3: prior/proposed/executed as SEPARATE persisted marks.
      // rewardSources is an open record, so the decision triple rides along
      // with every record (a present key always carries its index; a missing
      // key means the field was not decided). Attempted deviation
      // (proposed != prior) and actual deviation (executed != prior) can now
      // be counted independently from the store - the review's requirement
      // that the two never be conflated.
      //
      // t8/R1 (ADR 0002 §3): the suggestion triple is the SHADOW record
      // content. A run in a mode without shadow records ('baseline'/'off')
      // keeps its records audit-level: outcome/reward/eligibility persist,
      // but no suggestion marks and no gate strength are attached, so the
      // declared mode stays readable from the record shape itself.
      const shadowMarks = this.executionProfile.shadowRecords;
      const decisionMarks: Readonly<Record<string, number>> =
        probe.selection !== undefined && shadowMarks
          ? {
              ...(probe.selection.priorIndex === undefined ? {} : { decisionPriorIndex: probe.selection.priorIndex }),
              ...(probe.selection.proposedIndex === undefined
                ? {}
                : { decisionProposedIndex: probe.selection.proposedIndex }),
              decisionExecutedIndex: probe.selection.chosenIndex,
              ...(probe.selection.exploration === true ? { exploration: 1 } : {}),
              // t8/R4 (ADR 0002 R1 shadow 行): the per-decision replacement
              // strength - challenger nEff/support co-report plus the shrunk
              // and calibrated suggestion strength - rides EVERY shadow
              // record, gate open or closed, so the suggestion strength is
              // retrievable per record without parsing diagnostics.
              ...(probe.selection.challenger === undefined
                ? {}
                : {
                    gateNeff: probe.selection.challenger.nEff,
                    gateSupport: probe.selection.challenger.support,
                    gateShrunkAdvantage: probe.selection.challenger.shrunkAdvantage,
                    gateCalibratedAdvantage: probe.selection.challenger.calibratedAdvantage,
                    ...(probe.selection.challenger.implicitZeroAdvantage
                      ? { gateImplicitZeroAdvantage: 1 }
                      : {}),
                    // t8/R4: the gate outcome as a stable numeric code (see
                    // GATE_REASON_CODES); 0 = no gate applied / executed as
                    // proposed.
                    gateReason: gateReasonCodeOf(probe.selection.gateReason)
                  })
            }
          : {};
      if (!eligible) {
        // Audit-only: user cancellation / abort / infrastructure failure say
        // nothing about action quality (plan section 6.2), and - C2-pre (ADR
        // 0002 5.2a) - so does any shape-only verdict. Neutral reward, zero
        // learning target, `learningEligible: false`. The failed verdict keeps
        // its scale-level negative signal in the reward column for audit, but
        // no provenance is forged to make it learnable (trusted-failure
        // learning is the explicit C2 unfinished item).
        //
        // C2a (ADR 0003 §5.1): this `learningEligible: false` is the AUDIT-ONLY
        // ENCODING, not an outcome veto - the two are distinguished by the
        // `outcomeEligible` mark below (1 = audit encoding, 0 = outcome veto).
        reward = 0;
        observedReturn = 0;
        rewardSources = { outcome: 1, ...verificationMarks, ...decisionMarks };
      } else {
        // P6.1-D RewardContract: ONE primary target for every executed probe -
        // winner or not - under the same rewardVersion. The composer's winner
        // no longer gets a private step-evaluator + discounted-return scale;
        // its per-step vector survives only as an auxiliary rewardSources entry
        // (judge-policy: auxiliary field, never the yardstick), so the same
        // trajectory measures the same whether or not it won composition.
        reward = clamp(evaluation.reward, -3, 3);
        observedReturn = clamp(evaluation.reward, -3, 3);
        rewardSources = {
          ...(isWinner ? { ...evaluation.sources, stepJudge: winnerStepSummary(winnerRewards) } : evaluation.sources),
          ...verificationMarks,
          ...decisionMarks
        };
      }
      const learningTarget = eligible ? clamp(observedReturn - baseline, -3, 3) : 0;
      const decisionId = probe.selection?.decisionId ?? 'jit-meta-decision-' + input.runId + '-r' + String(probe.round);
      const association = {
        round: probe.round,
        slotIndex: probe.slotIndex,
        nodeId: probe.nodeId,
        parentNodeId: probe.parentNodeId,
        branchId: probe.branchId,
        trajectoryId: probe.trajectory.id,
        decisionId,
        runId: input.runId,
        policyVersion: input.policyId + '@v' + String(finiteOr(this.deps.policy.policy?.version, 1)),
        // P6.2 C1 (ADR 0002 R3): the ATOMIC r4 switch - the producer stamp is
        // now the preregistered verifier-first id. r3 records are isolated
        // automatically by the exact-id predicate; no relabel, no migration.
        // C2-pre caveat (ADR 0002 5.2a/5.4): r4 here means conservative
        // isolation + version-semantic cleanup, not trusted verification.
        rewardVersion: REWARD_CONTRACT.version,
        provenanceVersion: CURRENT_PROVENANCE_VERSION,
        experienceSchemaVersion: EXPERIENCE_SCHEMA_VERSION,
        // P6.2 C0 (ADR 0002 R8): the explicit decision fields. The vocabulary
        // stays the persisted slot-shape signature default (the semantic key
        // remains a decision mark, not a store key - R8).
        decisionMode: mode,
        actionKeyVocabulary,
        // P6.2 t7/V3 (ADR 0002 5.2a-4): the explicit learning track this
        // record's reward belongs to (see the per-probe derivation above).
        learningTrack,
        observedReturn,
        attributionBaseline: baseline,
        learningTarget,
        outcome,
        // C2a (ADR 0003 §5.1/§5.2): the learning branch writes the two-gate
        // conjunction (in this branch both gates are true, i.e. exactly
        // `evaluation.learningEligible`); the audit branch wrote `false` above.
        learningEligible: eligible && outcomeEligible
      } as const;

      const isTaskQualityRecord = learningTrack === 'task-quality' && eligible && outcomeEligible;
      // C2b F11 (ADR 0004 §2.2/§2.3 + ADR 0003 T3/T4): a quality record is only
      // registrable with a COMPLETE host binding - every binding member present
      // and an artifact digest of the exact host-recomputed shape
      // sha256:<64 lowercase hex>. A partial context is undefined here, and
      // register() throws on it, so an unverifiable verdict can never mint a
      // trusted quality record.
      const qualityBindingContext = isTaskQualityRecord
        ? completeQualityBindingContext(
            {
              artifactDigest: verificationDisposition?.artifactDigest,
              verifierId: verificationDisposition?.verifierId,
              verifierVersion: verificationDisposition?.verifierVersion,
              verificationId: verificationDisposition?.verificationId,
              testSetId: verificationDisposition?.testSetId,
              envId: verificationDisposition?.envId,
              runId: input.runId,
              sessionId: input.sessionId,
              trajectoryId: probe.trajectory.id,
              taskId: input.task?.id,
              role: probe.trajectory.role
            }
          )
        : undefined;
      // L1: this executed action's own record, in the L1 candidate key vocabulary
      // and with the guidance provenance of the slot that actually ran it.
      const l1Record: ExperienceRecord = {
        id: 'online-' + this.newId(),
        level: 'meta',
        state: probe.l1State,
        actionKey: probe.actionKey,
        reward,
        return: observedReturn,
        rewardSources,
        guidance: probe.guidance,
        policyId: input.policyId,
        sessionId: input.sessionId,
        treeId: input.treeId,
        ...association,
        createdAt,
        redacted: true
      };
      if (qualityBindingContext !== undefined) {
        registerAuthenticatedQualityRecord(l1Record, qualityBindingContext);
      }
      records.push(l1Record);

      // L2: ONLY when this exact proposal was chosen by the L2 decision AND
      // actually executed. The node/trajectory pair is the one that ran, never
      // the run's final winner (plan section 6.2).
      if (probe.selection !== undefined) {
        const l2Record: ExperienceRecord = {
          id: 'online-' + this.newId(),
          level: 'proposal',
          state: probe.selection.state,
          actionKey: probe.selection.actionKey,
          reward,
          return: observedReturn,
          rewardSources,
          guidance: probe.guidance,
          policyId: input.policyId,
          sessionId: input.sessionId,
          treeId: input.treeId,
          ...association,
          createdAt,
          redacted: true
        };
        if (qualityBindingContext !== undefined) {
          registerAuthenticatedQualityRecord(l2Record, qualityBindingContext);
        }
        records.push(l2Record);
      }
    }

    // Record deduplication (plan section 6.2): the same (level, actionKey, node,
    // trajectory, round) must never be appended twice, even if the recorder is
    // re-entered. Node ids are unique per tree, so this cannot suppress a
    // legitimate repeat across runs.
    const deduped: ExperienceRecord[] = [];
    for (const record of records) {
      const key = experienceDedupKey(record);
      if (this.appendedExperienceKeys.has(key)) {
        continue;
      }
      this.appendedExperienceKeys.add(key);
      deduped.push(record);
    }
    if (deduped.length === 0) {
      input.diagnostics.push('jitrl: every candidate record was already appended; nothing written');
      return 0;
    }

    // Last re-read immediately before the write: everything above was pure
    // computation, so re-checking here is what makes "no append after off"
    // independent of how long the evaluation took.
    if (!this.surfaceEnabled('onlineRecord')) {
      input.diagnostics.push(
        'jitrl: JitRL is off; ' +
          String(deduped.length) +
          ' scored record(s) were discarded instead of appended'
      );
      // C2b F4: a discarded batch must not leave pre-commit registrations
      // trusted in the registry - the record was never persisted.
      for (const record of deduped) {
        if (record.learningTrack !== 'task-quality') {
          continue;
        }
        const recordRunId = record.runId;
        if (recordRunId === undefined || recordRunId.length === 0) {
          continue;
        }
        unregisterAuthenticatedQualityRecord(record.id, recordRunId);
      }
      return 0;
    }

    // P6.2 PR-B: attempted vs actual deviation, reported separately (F4-3).
    // attempted = the kernel's raw proposal differed from the prior; actual =
    // what finally executed differed from the prior. Reporting only the actual
    // rate would hide the gate's effect; reporting only the attempted rate
    // would claim deviations that never ran.
    const decisionsWithPrior = ordered.filter(
      (probe) => probe.selection !== undefined && probe.selection.priorIndex !== undefined
    );
    const attemptedDeviations = decisionsWithPrior.filter(
      (probe) =>
        probe.selection !== undefined &&
        probe.selection.proposedIndex !== undefined &&
        probe.selection.priorIndex !== probe.selection.proposedIndex
    ).length;
    const actualDeviations = decisionsWithPrior.filter(
      (probe) =>
        probe.selection !== undefined && probe.selection.priorIndex !== probe.selection.chosenIndex
    ).length;
    const explorationCharged = decisionsWithPrior.filter(
      (probe) => probe.selection?.exploration === true
    ).length;

    input.stage('record_experience', {
      round: input.round,
      detail: {
        records: deduped.length,
        executed: ordered.length,
        rounds: new Set(ordered.map((probe) => probe.round)).size,
        outcomes,
        notLearningEligible: ineligible,
        // P6.2 C0/t6: executions whose verdict carried no trusted provenance
        // and were therefore audit-only on the task-quality track (the C2
        // unfinished item: trusted-failure learning).
        notTaskQualityEligible: notTaskQuality,
        // P6.2 C0 (R5-6): budget seats released because the execution carried
        // no quality evidence (cancel/abort/infra).
        explorationReservationsReleased: releasedReservations,
        explorationBudgetRemaining: this.explorationAllowance,
        // P6.2 C0 (ADR 0002 R8): the run's declared decision fields.
        decisionMode: mode,
        actionKeyVocabulary,
        attributionBaseline: baseline,
        // P6.2 C1 (ADR 0002 R3): the run's reward yardstick after the atomic
        // r4 switch, plus the honest C2-pre trust marker (5.2a/5.4): the
        // verdict fields are shape-validated, not trusted-source.
        rewardVersion: REWARD_CONTRACT.version,
        rewardScale: REWARD_CONTRACT.aggregation,
        verifierFirstRule: 'verifier-first-completion-v1',
        // C2a (ADR 0003 §4.5): with no seam this stays the exact pre-C2a
        // literal (default-assembly equivalence); with a seam it reports what
        // actually happened this run (trusted / audit-only counts + reasons).
        trustedVerificationSource: verificationSourceDescription(
          this.deps.verification,
          verificationSummary
        ),
        rewardTargetField: REWARD_CONTRACT.learningTargetField,
        // What the value estimator will consume from these records.
        estimatorTarget: estimatorTargetLine(deduped, REWARD_CONTRACT.version),
        // P6.2 PR-B / F4-3: the decision ledger summary of this run.
        l2Decisions: decisionsWithPrior.length,
        attemptedDeviations,
        actualDeviations,
        explorationCharged,
        // P6.2 C1 (ADR 0002 R2): the resolved layer permissions of this run.
        permissions: {
          patch: this.executionProfile.permissions.patch.allowed,
          publish: this.executionProfile.permissions.publish.allowed,
          memory: this.executionProfile.permissions.memory.allowed
        },
        // F4-4: semantic edit kinds executed this run (destructive choices are
        // separately countable from the stage log).
        semanticKinds: [
          ...new Set(
            decisionsWithPrior.map((probe) => probe.selection?.semanticKind ?? '').filter((kind) => kind !== '')
          )
        ]
      }
    });
    // C2b F4: remember which pending quality registrations belong to this
    // append batch. Registration happens only AFTER the store commit succeeds;
    // a failed or discarded append leaves nothing trusted in the registry
    // (pending-commit semantics: register-on-success).
    const pendingQualityRegistrations: Array<{
      readonly record: ExperienceRecord;
      readonly context: QualityProvenanceContext;
    }> = [];
    for (const record of deduped) {
      if (record.learningTrack !== 'task-quality') {
        continue;
      }
      const recordRunId = record.runId;
      if (recordRunId === undefined || recordRunId.length === 0) {
        continue;
      }
      const entry = qualityProvenanceRegistry.getEntry(record.id, recordRunId);
      if (entry === undefined) {
        continue;
      }
      pendingQualityRegistrations.push({ record, context: entry.context });
      // Roll back the pre-commit registration: until the append succeeds the
      // record is NOT trusted evidence (register-on-success semantics).
      this.unregisteredQualityRecords.push(record);
      unregisterAuthenticatedQualityRecord(record.id, recordRunId);
    }
    try {
      await kernel.store.append(deduped);
    } catch (error) {
      input.diagnostics.push('record_experience failed: ' + errorMessage(error));
      return 0;
    }
    // Commit succeeded: (re-)register every quality record that shipped. The
    // pre-commit entries were rolled back above, so this is the single point
    // where the batch becomes trusted.
    for (const pending of pendingQualityRegistrations) {
      registerAuthenticatedQualityRecord(pending.record, pending.context);
    }
    return deduped.length;
  }

  /**
   * Memory augmentation for one L2 candidate set (plan section 6.6, gap G2-2).
   *
   * The pass ALWAYS runs, so a run without a lesson source is still observable:
   * with no source the augmenter rehydration-fails deterministically, returns the
   * input candidates unchanged and reports why. Retrieval mirrors the decision's
   * own neighbour query (same level, k and similarityThreshold); when the store
   * cannot answer, an empty neighbourhood is passed so the call still happens.
   *
   * Section 7.1 isolation is enforced inside the augmenter from the slot kind, so
   * this method never decides who may be augmented.
   */
  private async augmentProposalCandidates(input: {
    readonly kernel: OrchestratorJitRl;
    readonly state: AbstractState;
    readonly candidates: readonly JitCandidate<ProposedPatch>[];
    readonly slot: BatchSlotPlan;
    readonly diagnostics: string[];
  }): Promise<{ readonly candidates: readonly JitCandidate<ProposedPatch>[]; readonly augmented: number }> {
    const config = input.kernel.config;
    let neighbors: readonly ScoredExperience[] = [];
    try {
      neighbors = await input.kernel.store.query({
        level: 'proposal',
        state: input.state,
        k: finiteOr(config.k, DEFAULT_PROPOSAL_K),
        similarityThreshold: finiteOr(config.similarityThreshold, DEFAULT_PROPOSAL_SIMILARITY)
      });
    } catch (error) {
      input.diagnostics.push(
        'proposal augment: neighbour retrieval failed, using an empty neighbourhood (' +
          errorMessage(error) +
          ')'
      );
    }

    const result = augmentCandidates(input.candidates, neighbors, {
      slotKind: input.slot.slot,
      // Absent config keeps the kernel defaults, matching createJitRl's behaviour.
      ...(config.augmentFromMemory === undefined
        ? {}
        : { augmentFromMemory: config.augmentFromMemory }),
      ...(config.minSupportForStrongPrior === undefined
        ? {}
        : { minSupportForStrongPrior: config.minSupportForStrongPrior }),
      // Phase 3 wires no lesson store; absence is the documented no-op path.
      ...(this.deps.jitrl?.lessonSource === undefined
        ? {}
        : { lessonSource: this.deps.jitrl.lessonSource })
    });

    for (const diagnostic of result.diagnostics) {
      input.diagnostics.push('proposal augment: ' + diagnostic.code + ': ' + diagnostic.message);
    }
    // One summary line so the pass is visible even when nothing was augmented.
    input.diagnostics.push(
      'proposal augment: ' +
        String(input.candidates.length) +
        ' candidate(s), ' +
        String(result.augmented) +
        ' augmented, isolated=' +
        String(result.isolated) +
        ' (neighbours ' +
        String(neighbors.length) +
        ')'
    );
    return { candidates: result.candidates, augmented: result.augmented };
  }

  /**
   * L2 selection (plan Phase 3): choose exactly ONE of the K proposals before
   * probing, so the probe budget is unchanged (K candidates still cost 1 probe).
   *
   * Returns undefined when the stage must stay silent: no kernel, L2 disabled,
   * no multi-candidate proposer, or a single candidate - in all of those the
   * pre-Phase-3 path is reproduced byte for byte.
   */
  private async selectProposal(input: {
    readonly sessionId: string;
    readonly task: ProbeTask;
    readonly slot: BatchSlotPlan;
    readonly guidance: ProposerGuidance;
    readonly parentNode: DiscoveryNode;
    readonly parentCandidate: ProbeCandidate | undefined;
    readonly reference: ProbeTrajectory;
    readonly recall: MemoryRecallResult;
    readonly rounds: number;
    readonly grid: SearchGridPlan;
    readonly diagnostics: string[];
  }): Promise<
    | {
        readonly proposed: ProposedPatch;
        readonly chosen: number;
        readonly offered: number;
        readonly priorIndex?: number;
        readonly proposedIndex?: number;
        readonly gateReason?: PreparedSelection['gateReason'];
        readonly exploration?: boolean;
        readonly semanticKind?: string;
        /** t8/R4: the measured challenger strength (every deviation, gate or not). */
        readonly challenger?: PreparedSelection['challenger'];
      }
    | undefined
  > {
    const kernel = this.deps.jitrl;
    if (kernel === undefined || !kernel.config.enabled || !kernel.config.levels.includes('proposal')) {
      return undefined;
    }
    // P6 PR2: `kernel.config.enabled` is CONFIGURED, not live. The volatile
    // control is authoritative, so `/evo jit off` stops the K-candidate path even
    // though the kernel stays configured (plan R1 root cause).
    if (!this.surfaceEnabled('proposal')) {
      return undefined;
    }
    // t10/R1b (ADR 0002 §3 baseline 行, option ①): a DECLARED baseline run has
    // Jit make NO selection: the K-candidate Jit decision is skipped and the
    // pre-existing single propose() path runs exactly as a Jit-unconfigured
    // assembly - Jit intercepts nothing (the mode contract: "Jit 不拦截、不注
    // 入、不探测，宿主原行为逐字节不变"). The probe still runs through the
    // baseline evo search (discovery/probing are the host's own flow, R1's
    // "基础 evo search" carve-out) and records audit-level experience.
    if (this.executionProfile.mode === 'baseline') {
      return undefined;
    }
    // K == 1 means there is nothing to choose between: stay on the single-call
    // propose() path so the model is never invoked twice for one proposal.
    if (!Number.isFinite(kernel.config.candidateCount) || kernel.config.candidateCount <= 1) {
      return undefined;
    }
    const proposer = this.deps.proposer;
    if (typeof proposer.proposeCandidates !== 'function') {
      return undefined;
    }
    const request: ProposeRequest = {
      task: input.task,
      sessionId: input.sessionId,
      slot: input.slot,
      guidance: input.guidance,
      parentNode: input.parentNode,
      ...(input.parentCandidate === undefined ? {} : { parentPatch: input.parentCandidate.patch }),
      referenceTrajectory: input.reference,
      enabledSurfaces: this.deps.config.enabledSurfaces,
      attemptIndex: input.slot.slotIndex + 1,
      totalBudget: input.grid.budget,
      candidateCount: kernel.config.candidateCount
    };
    let set: ProposedPatchSet;
    // Snapshot before the K-candidate model call: `/evo jit off` may land while
    // it is in flight. The call is not withdrawn, but the resulting choice must
    // not be published as a Jit decision (plan P6 section 5.1).
    const generationBeforePropose = this.runtimeGeneration();
    try {
      set = await proposer.proposeCandidates(request);
    } catch (error) {
      input.diagnostics.push(
        'jit_proposal_select: the multi-candidate proposer failed, fell back to propose(): ' +
          errorMessage(error)
      );
      return undefined;
    }
    const switchMoved =
      this.runtimeGeneration() !== generationBeforePropose || !this.surfaceEnabled('proposal');
    const offered = Array.isArray(set?.candidates) ? set.candidates : [];
    if (offered.length === 0) {
      return undefined;
    }
    // The proposer already returned; nothing above produced an external effect.
    // Dropping the set here is what keeps a mid-flight `jit off` from turning a
    // finished model call into a published decision.
    if (switchMoved) {
      input.diagnostics.push(
        'jit_proposal_select: JitRL was switched while the multi-candidate proposer was in flight; ' +
          String(offered.length) +
          ' candidate(s) were discarded and the single propose() path is used instead'
      );
      return undefined;
    }

    // One node must be created per chosen patch, so patches that normalize to the
    // same signature cannot be told apart in the tree or the experience store.
    // P6.2 PR-B / F4-4: the SEMANTIC key (normalizeSemanticActionKey) is the
    // next L2 action vocabulary - it encodes edit type + semantic direction +
    // targets so a correct append and a destructive forbid never share a Q
    // bucket (see the conflict-rate tests). Persisting it into the store is a
    // vocabulary switch that belongs to the release PR (it would orphan every
    // existing record, including the eval replay corpus), so the online path
    // keeps the slot-shape signature here and carries the semantic key as the
    // decision's semantic mark (decisionSemanticKind in rewardSources).
    const candidates: JitCandidate<ProposedPatch>[] = [];
    const byKey = new Map<string, ProposedPatch>();
    for (let index = 0; index < offered.length; index += 1) {
      const candidate = offered[index];
      if (candidate === undefined) {
        continue;
      }
      let actionKey: string;
      try {
        actionKey = normalizePatchSignature(candidate.patch);
      } catch (error) {
        input.diagnostics.push('jit_proposal_select: candidate ' + String(index) + ' has no usable signature (' + errorMessage(error) + '); dropped');
        continue;
      }
      const unique = byKey.has(actionKey) ? actionKey + '#' + String(index) : actionKey;
      if (byKey.has(actionKey)) {
        input.diagnostics.push('jit_proposal_select: candidate ' + String(index) + ' duplicates signature ' + actionKey + '; key disambiguated');
      }
      byKey.set(unique, candidate);
      candidates.push({
        actionKey: unique,
        baseLogit: verbalizedLogit(candidate.confidence),
        source: 'llm',
        payload: candidate
      });
    }
    if (candidates.length === 0) {
      return undefined;
    }
    // The state is needed by BOTH the augmentation pass and the decision, so it is
    // derived before the single-candidate shortcut below.
    const state = abstractProposalState({
      task: input.task,
      round: input.rounds,
      parentDepth: finiteOr(input.parentNode.depth, 0),
      parentSlot: input.slot.slot,
      memoryConfidence: finiteOr(input.recall.confidence, 0),
      referenceStatus: input.reference.status === 'succeeded' ? 'succeeded' : 'failed',
      slot: input.slot.slot,
      guidance: input.slot.guidance,
      ...(input.parentCandidate === undefined
        ? {}
        : { parentPatchSignature: normalizePatchSignature(input.parentCandidate.patch) })
    });

    // Plan section 6.6: memory augmentation. The call ALWAYS happens, even when no
    // lesson source is wired, so the pass is observable instead of silently
    // skipped; with no source rehydration deterministically fails and the
    // candidate set is returned unchanged (plus an 'augment_rehydrate_failed'
    // diagnostic). Plan section 7.1 isolation is enforced INSIDE the augmenter
    // from the slot kind, so an invariant/recover slot can never be augmented.
    const augmented = await this.augmentProposalCandidates({
      kernel,
      state,
      candidates,
      slot: input.slot,
      diagnostics: input.diagnostics
    });
    const decisionCandidates = augmented.candidates;

    // Exactly one usable candidate and nothing augmented: reuse it. Calling
    // propose() again would add a second model call for a choice that does not exist.
    if (decisionCandidates.length === 1) {
      const only = decisionCandidates[0];
      const payload = only?.payload;
      if (payload === undefined) {
        return undefined;
      }
      return { proposed: payload, chosen: 0, offered: 1 };
    }

    let decision: JitDecision<ProposedPatch>;
    try {
      // Plan section 7.1: the invariant track must never read external memory.
      // The slot KIND decides the filter - never `slot.guidance`, which a
      // pluggable policy supplies and could therefore mislabel. The other three
      // guards (augmentation, proposer, record provenance) already pin by kind;
      // this keeps the fourth one on the same footing instead of trusting the
      // caller. Non-invariant kinds yield undefined, so they keep reading the
      // slot's own guidance exactly as before.
      const pinnedGuidance = guidanceFilterForSlot(input.slot.slot);
      decision = await kernel.optimizer.decide('proposal', state, decisionCandidates, {
        guidanceFilter: pinnedGuidance ?? input.slot.guidance
      });
    } catch (error) {
      input.diagnostics.push(
        'jit_proposal_select: the L2 optimizer failed, kept the first candidate (' + errorMessage(error) + ')'
      );
      return undefined;
    }

    const chosenKey = decision.chosen.candidate.actionKey;
    // A memory-augmented winner carries a rehydrated payload, not a proposer
    // patch: rebuild a patch from the lesson's own edits (never invented content).
    const chosen =
      byKey.get(chosenKey) ??
      patchFromAugmented(decision.chosen.candidate.payload, {
        actionKey: chosenKey,
        sessionId: input.sessionId,
        slot: input.slot,
        id: 'patch-memory-' + this.newId(),
        createdAt: this.now()
      });
    if (chosen === undefined) {
      input.diagnostics.push('jit_proposal_select: the chosen action does not map to a candidate; kept the first');
      return undefined;
    }
    // Index/count come from the DECISION set (proposer candidates plus any
    // memory-augmented ones); a negative index is reported honestly as such.
    const chosenIndex = decisionCandidates.findIndex((entry) => entry.actionKey === chosenKey);
    const rejected = decisionCandidates
      .filter((entry) => entry.actionKey !== chosenKey)
      .map((entry) => entry.actionKey);

    const priorIndex = decisionCandidates.reduce(
      (best, entry, index, all) =>
        entry.baseLogit > (all[best]?.baseLogit ?? Number.NEGATIVE_INFINITY) ? index : best,
      0
    );
    const proposedIndex = chosenIndex;
    let executedIndex = chosenIndex;
    let gateReason: PreparedSelection['gateReason'] | undefined;
    let exploration = false;

    // -----------------------------------------------------------------
    // P6.2 PR-B / F4 + C0: conservative replacement gate (estimation != replace).
    //
    // The gate is DISABLED by default (deps.conservativeGate = false): the
    // frozen e2e baseline calibrates the online path WITHOUT interception, and
    // the release assembly enables it through the guarded-active mode wiring.
    // The decision RULES live in ./jitrl/replacement-policy.ts (decideReplacement)
    // so the online path, the tests and the guarded regression script all run
    // the same rule set:
    //   1. hard veto: a zero-advantage/no-evidence artefact (fallback-derived
    //      A=0, or a noop that edits nothing) over an evidenced prior;
    //   2. an unsupported challenger executes only against the explicit,
    //      revocable exploration budget;
    //   3. thin-but-measured (nEff below floor): prior stands, strength recorded.
    // C0 (ADR 0002 R5-2): the judgement consumes ONLY nEff - a challenger
    // whose estimate carries no nEff has NO replacement evidence (support
    // never impersonates nEff).
    //
    // t8/R4 (ADR 0002 R1 shadow 行): the challenger's SUGGESTION STRENGTH is
    // measured for EVERY deviation - gate open or closed - because the shadow
    // record must carry nEff/support/shrunk/calibrated per decision. The gate
    // only decides whether the suggestion may REPLACE; estimation always runs.
    //
    // t8/V2b (ADR 0002 R2): the exploration budget is part of the patch layer.
    // When the resolved profile denies the patch permission, the allowance is
    // passed as 0 - an under-evidenced deviation can never ride the budget in
    // a mode where the patch layer is denied (fail-closed, R2).
    // -----------------------------------------------------------------
    let challengerStrength: PreparedSelection['challenger'] | undefined;
    if (proposedIndex !== priorIndex) {
      const proposedAdjustment = decision.adjustments[proposedIndex];
      const priorAdjustment = decision.adjustments[priorIndex];
      const challengerEstimate = {
        actionKey: chosenKey,
        q: proposedAdjustment?.q ?? null,
        support: proposedAdjustment?.support ?? 0,
        ...(proposedAdjustment?.nEff === undefined ? {} : { nEff: proposedAdjustment.nEff }),
        explored: proposedAdjustment?.explored ?? false,
        advantage: proposedAdjustment?.advantage ?? 0
      };
      const priorEstimate = {
        actionKey: decisionCandidates[priorIndex]?.actionKey ?? 'prior',
        q: priorAdjustment?.q ?? null,
        support: priorAdjustment?.support ?? 0,
        ...(priorAdjustment?.nEff === undefined ? {} : { nEff: priorAdjustment.nEff }),
        explored: priorAdjustment?.explored ?? false,
        advantage: priorAdjustment?.advantage ?? 0
      };
      // Estimation half (t8/R4): always measured, even when the gate is off.
      const measured = conservativeAdvantage(challengerEstimate);
      challengerStrength = {
        nEff: measured.nEff,
        support: measured.support,
        shrunkAdvantage: measured.shrunkAdvantage,
        calibratedAdvantage: measured.calibratedAdvantage,
        implicitZeroAdvantage: measured.implicitZeroAdvantage
      };
      if (this.conservativeGate) {
        // A noop cannot carry evidence by construction (it edits nothing), and a
        // zero-advantage challenger with NO support is exactly the F4 artefact:
        // its A = 0 comes from the 'baseline' fallback, not from experience.
        const challengerIsNoop = Object.keys(
          (decisionCandidates[proposedIndex]?.payload?.patch?.edits ?? {}) as Record<string, unknown>
        ).length === 0;
        const verdict = decideReplacement({
          proposedIndex,
          priorIndex,
          challenger: challengerEstimate,
          prior: priorEstimate,
          challengerIsNoop,
          explorationAllowance: this.executionProfile.permissions.patch.allowed
            ? this.explorationAllowance
            : 0
        });
        if (verdict.kind === 'kept-prior') {
          executedIndex = verdict.executedIndex;
          gateReason = verdict.gateReason;
        } else if (verdict.kind === 'executed-exploration') {
          this.explorationAllowance -= 1;
          exploration = true;
        }
        // P6.2 C0: the calibrated advantage genuinely participated - the verdict
        // (and its strength) rides the decision diagnostics for the ledger.
        input.diagnostics.push(
          'jit_proposal_select: replacement verdict=' +
            verdict.kind +
            (verdict.gateReason === undefined ? '' : ' reason=' + verdict.gateReason) +
            ' challenger nEff=' +
            String(verdict.challenger.nEff) +
            '/' +
            String(verdict.challenger.support) +
            ' shrunk=' +
            verdict.challenger.shrunkAdvantage.toFixed(6) +
            ' calibrated=' +
            verdict.challenger.calibratedAdvantage.toFixed(6)
        );
      } else {
        // t8/R4: the gate is closed (shadow default) - the strength is still
        // measured and will ride the shadow record; the diagnostic states that
        // no gate intercepted the decision. (t10/R1b scope note: the captain's
        // ruling wires ONLY baseline to execute the prior unconditionally;
        // shadow keeps the t6-frozen "基础 evo search 共存" behaviour, which the
        // ADR §3 revision task tracks separately.)
        input.diagnostics.push(
          'jit_proposal_select: suggestion strength (gate closed) challenger nEff=' +
            String(measured.nEff) +
            '/' +
            String(measured.support) +
            ' shrunk=' +
            measured.shrunkAdvantage.toFixed(6) +
            ' calibrated=' +
            measured.calibratedAdvantage.toFixed(6)
        );
      }
    }

    const executedKey = decisionCandidates[executedIndex]?.actionKey ?? chosenKey;
    const executedPatch =
      executedIndex === proposedIndex
        ? chosen
        : (byKey.get(executedKey) ??
          patchFromAugmented(decisionCandidates[executedIndex]?.payload, {
            actionKey: executedKey,
            sessionId: input.sessionId,
            slot: input.slot,
            id: 'patch-memory-' + this.newId(),
            createdAt: this.now()
          })) ?? chosen;
    if (executedIndex !== proposedIndex) {
      input.diagnostics.push(
        'jit_proposal_select: conservative gate fell back to the prior candidate ' +
          String(priorIndex) +
          ' (proposed ' +
          String(proposedIndex) +
          ' rejected: ' +
          String(gateReason) +
          ')'
      );
    } else if (exploration) {
      input.diagnostics.push(
        'jit_proposal_select: under-evidenced deviation charged to the exploration budget (' +
          String(this.explorationAllowance) +
          ' left)'
      );
    }
    input.diagnostics.push(
      'jit_proposal_select: selected candidate ' +
        String(executedIndex) +
        ' of ' +
        String(decisionCandidates.length) +
        ' (probability ' +
        String(decision.adjustments[executedIndex]?.probability ?? decision.chosen.probability) +
        ', klToPrior ' +
        String(decision.klToPrior) +
        (exploration ? ', exploration' : '') +
        '); not probed: ' +
        decisionCandidates
          .filter((_, index) => index !== executedIndex)
          .map((entry) => entry.actionKey)
          .join(', ')
    );
    // F4-4: semantic edit kind(s) of the executed patch, recorded beside the
    // action key (see PreparedSelection.semanticKind).
    const executedEdits = (executedPatch.patch?.edits ?? {}) as Record<string, unknown>;
    const semanticKinds = [
      ...new Set(
        Object.keys(executedEdits)
          .map((surface) =>
            semanticEditKindOf(surface as HarnessComponentKey, executedEdits[surface])
          )
          .filter((kind): kind is SemanticEditKind => kind !== undefined)
      )
    ];
    return {
      proposed: executedPatch,
      chosen: executedIndex,
      offered: decisionCandidates.length,
      // F4-3: ALWAYS report the full prior/proposed/executed triple for an L2
      // decision, including the no-deviation case (proposed === executed ===
      // prior) - attempted and actual deviation must be countable from every
      // record, not only the deviating ones.
      priorIndex,
      proposedIndex,
      ...(gateReason === undefined ? {} : { gateReason }),
      ...(exploration ? { exploration: true } : {}),
      ...(semanticKinds.length === 0 ? {} : { semanticKind: semanticKinds.join('+') }),
      // t8/R4: the measured strength rides the decision even when no gate ran.
      ...(challengerStrength === undefined ? {} : { challenger: challengerStrength })
    };
  }

  /** Run one candidate inside an isolated branch with branch-scoped memory. */
  private async probeCandidate(input: {
    readonly sessionId: string;
    readonly task: ProbeTask;
    readonly slot: BatchSlotPlan;
    readonly patchId: string;
    readonly patch: ProbeCandidate['patch'];
    readonly nodeId: string;
    readonly treeId: string;
    readonly referenceTrajectoryId: string;
    readonly recallIds: readonly string[];
    /** C2a (ADR 0003 §4.1): the run identity the host binding is scoped to. */
    readonly runId: string;
    /** C2a (ADR 0003 §4.4.2): no reference receipt => candidate receipt audit-only. */
    readonly referenceReceiptMissing: boolean;
    readonly diagnostics: string[];
  }): Promise<ProbeTrajectory> {
    const config = this.deps.config;
    let handle: MemoryIsolationHandle | undefined;
    try {
      handle = await this.deps.memory.isolate({
        kind: 'branch',
        sessionId: input.sessionId,
        branchId: input.slot.branchId
      });
    } catch (error) {
      input.diagnostics.push('branch memory isolation unavailable: ' + errorMessage(error));
    }

    try {
      const probe = await this.deps.seams.runInIsolatedBranch({
        sessionId: input.sessionId,
        task: input.task,
        patch: input.patch,
        executor: this.deps.runBranch,
        branchId: input.slot.branchId,
        role: 'candidate',
        treeId: input.treeId,
        nodeId: input.nodeId,
        referenceTrajectoryId: input.referenceTrajectoryId,
        memoryRecallIds: input.recallIds,
        timeoutMs: config.probe.probeTimeoutMs
      });
      // C2a: verify BEFORE the trajectory enters the tree, the composer or the
      // recorder, so every downstream consumer sees the same authenticated
      // digest/verdict pair (no re-collection, no branch self-declaration).
      const verified = await this.verifyTrajectory(probe, {
        runId: input.runId,
        taskId: input.task.id,
        referenceReceiptMissing: input.referenceReceiptMissing,
        diagnostics: input.diagnostics
      });
      return verified.trajectory;
    } finally {
      if (handle !== undefined) {
        try {
          await handle.release();
        } catch (error) {
          input.diagnostics.push('branch memory isolation release failed: ' + errorMessage(error));
        }
      }
    }
  }

  /**
   * C2a (ADR 0003 §4.1-§4.4): run the host-owned verifier over one probe and
   * return the trajectory every later stage must use.
   *
   * No seam => the trajectory is returned untouched and no disposition exists,
   * which is what keeps the default assembly byte-identical (§4.5.1).
   */
  private async verifyTrajectory(
    trajectory: ProbeTrajectory,
    input: {
      readonly runId: string;
      readonly taskId: string;
      readonly referenceReceiptMissing: boolean;
      readonly diagnostics: string[];
    }
  ): Promise<{ readonly trajectory: ProbeTrajectory; readonly disposition: VerificationDisposition | undefined }> {
    const result = await verifyAndAttach({
      seam: this.deps.verification,
      trajectory,
      runId: input.runId,
      taskId: input.taskId,
      referenceReceiptMissing: input.referenceReceiptMissing,
      diagnostics: input.diagnostics
    });
    // C2a: record the host view for the run (status page / independent
    // verification), regardless of whether a receipt was attached.
    const view = readVerificationView(result.trajectory);
    if (view !== undefined) {
      this.verificationView = [...this.verificationView, view];
    }
    return { trajectory: result.trajectory, disposition: result.disposition };
  }

  /**
   * The trusted-producer set the scorer consumes as its second necessary
   * condition (ADR 0003 §4.1). `undefined` with no seam keeps the scorer's own
   * frozen default (the empty registry).
   */
  private verificationTrustedProducers(): ReadonlySet<string> | undefined {
    const seam = this.deps.verification;
    if (seam === undefined || seam.enabled === false) {
      return undefined;
    }
    return seam.runner.trustedProducers;
  }

  private async commitLessons(
    lessons: readonly CanonicalLesson[],
    scope: MemoryScope,
    diagnostics: string[]
  ): Promise<number> {
    // t10/R2 + t12/R2-residual (t11 blocker finding; ADR 0002 §4): the memory
    // layer is a REQUEST + PERMISSION double gate, exactly like the patch layer
    // (t7/V1).
    //
    //   REQUEST half  - the caller asked for a real backend write
    //                   (promoteOnComposeSuccess=true, or a mirror config).
    //   PERMISSION    - executionProfile.permissions.memory.allowed. It is
    //                   half  CONST false for every mode this round (ADR §4:
    //                   "memory 本轮一律不真实写入"), so the real-namespace
    //                   paths below are structurally unreachable until the
    //                   captain re-adjudicates the permission - a config flag
    //                   alone can never widen it (fail-closed, no implicit
    //                   permission loss).
    //
    // t12/R2-residual: a DENIED permission means the memory bridge is NOT
    // CALLED AT ALL. The t10 revision still issued a real `deps.memory.commit`
    // request with an "ephemeral" per-run scope and relied on the host bridge
    // to refuse it (the default warehouse bridge answers 'scope_violation');
    // an injected bridge that accepts any scope (deps.memory is a public
    // seam) then persisted a write the profile had denied, and the run
    // diagnostic even claimed the lesson had landed in that namespace. There
    // is no renamed/derived scope that fixes this: only skipping the call
    // does. The denial is therefore enforced HERE, in front of the bridge, and
    // is reported as a diagnostic that says exactly that.
    //
    // The governed session-scope commit below is the plugin's lesson-store
    // write path (asserted by the e2e suites). It runs ONLY under an explicit
    // memory-allowed profile - the `ExecutionProfileInput.memoryRealWrites`
    // override the deterministic TEST assemblies pass in (in-memory fake
    // backends); no config field and no default wiring produces that shape.
    const memoryPermission = this.executionProfile.permissions.memory;
    if (!memoryPermission.allowed) {
      diagnostics.push(
        'memory permission: ' +
          String(lessons.length) +
          ' lesson(s) NOT committed - real memory writes are denied (' +
          memoryPermission.reason +
          '); the memory bridge was not called and promote/mirror stay structurally unreachable'
      );
      return 0;
    }
    let committed = 0;
    for (const lesson of lessons) {
      try {
        const outcome = await this.deps.memory.commit(lesson, {
          scope,
          enforceGovernance: true
        });
        if (outcome.accepted && outcome.persisted) {
          committed += 1;
          await this.promoteLessonIfConfigured(lesson, scope, diagnostics);
          continue;
        }
        const reasons = outcome.violations.map((violation) => violation.code).join(', ');
        diagnostics.push(
          'lesson ' + lesson.id + ' was not persisted' + (reasons.length === 0 ? '' : ': ' + reasons)
        );
      } catch (error) {
        diagnostics.push('lesson ' + lesson.id + ' commit failed: ' + errorMessage(error));
      }
    }
    return committed;
  }

  /**
   * promoteOnComposeSuccess: a committed positive lesson is re-stamped into the
   * global namespace so later sessions can recall it. Promotion problems are
   * diagnostics and never abort the run; the false setting is respected.
   *
   * t10/R2 (t9 blocker): the config flag is only the REQUEST half. The
   * PERMISSION half is the execution profile's memory permission - denied in
   * every mode this round (ADR §4), so promotion is structurally unreachable
   * and the real global namespace receives nothing until the captain
   * re-adjudicates. t12 keeps this check as defense in depth: the only caller
   * (commitLessons) now returns BEFORE the bridge when the permission is
   * denied, so this branch is belt-and-braces, not the enforcement point.
   */
  private async promoteLessonIfConfigured(
    lesson: CanonicalLesson,
    scope: MemoryScope,
    diagnostics: string[]
  ): Promise<void> {
    if (!this.deps.config.memoryBridge.promoteOnComposeSuccess) {
      return;
    }
    if (lesson.polarity !== 'positive' || scope.kind === 'global') {
      return;
    }
    // t10/R2: the PERMISSION half. Config flag + denied permission = refusal
    // with an explicit diagnostic (never a real-namespace write).
    if (!this.executionProfile.permissions.memory.allowed) {
      diagnostics.push(
        'memory permission: promotion of lesson ' +
          lesson.id +
          ' REFUSED - promoteOnComposeSuccess=true is only the request half; the execution profile denies real-namespace writes this round (' +
          this.executionProfile.permissions.memory.reason +
          ')'
      );
      return;
    }
    try {
      const promotion = await this.deps.memory.promote(lesson, {
        from: scope,
        to: { kind: 'global' }
      });
      if (!promotion.accepted || !promotion.persisted) {
        const reasons = promotion.violations.map((violation) => violation.code).join(', ');
        diagnostics.push(
          'lesson ' + lesson.id + ' was not promoted to global' +
            (reasons.length === 0 ? '' : ': ' + reasons)
        );
        return;
      }
      diagnostics.push('promoted lesson ' + lesson.id + ' to global scope');
    } catch (error) {
      diagnostics.push('lesson ' + lesson.id + ' promotion failed: ' + errorMessage(error));
    }
  }

  /** True when the completed-task cadence for offline dreaming has been hit. */
  private shouldDream(config: EvoHarnessConfig): boolean {
    const every = config.dreamRsi.offlineDreamTriggerEveryNTasks;
    // A durable counter is authoritative: it already includes the task recorded
    // above, so a restarted process continues the cadence instead of resetting.
    const counter = this.deps.taskCounter;
    if (counter !== undefined) {
      return counter.shouldDream(every);
    }
    return every > 0 && this.count % every === 0;
  }

  /** Zero-execution replay of the retained trees; updates pi_t when improved. */
  private async runDream(
    config: EvoHarnessConfig,
    diagnostics: string[]
  ): Promise<DreamReplayReportWithShadow | null> {
    try {
      const baseline = this.deps.policy.policy;
      const trees = this.treePool.list();
      const report = (await this.deps.dreamer.replay({
        trees,
        baselinePolicy: baseline,
        candidatePolicies: this.candidatePolicies(baseline, config.dreamRsi.candidatePoliciesCount)
      })) as DreamReplayReportWithShadow;
      this.dreams.push(report);
      // P4: a dreamer wired to the JitRL kernel reports how many replay hook
      // calls it made and which candidate jit hyperparameters were simulated.
      // Additive diagnostics only: no new stage, no reordering, and a plain
      // dreamer simply exposes no accessor.
      const dreamDiagnostics = (
        this.deps.dreamer as { lastDreamDiagnostics?: () => readonly string[] }
      ).lastDreamDiagnostics;
      if (typeof dreamDiagnostics === 'function') {
        for (const line of dreamDiagnostics()) {
          diagnostics.push(line);
        }
      }
      const pub = report.publication;
      diagnostics.push(
        'offline dream: replayed ' +
          String(report.replayedTreeIds.length) +
          ' tree(s), improved=' +
          String(report.improved) +
          ', selected ' +
          report.selectedPolicyId +
          (pub !== undefined
            ? ', published=' + String(pub.publish) + ', reason=' + pub.reason
            : '')
      );
      return report;
    } catch (error) {
      diagnostics.push('offline dream failed: ' + errorMessage(error));
      return null;
    }
  }
}

/** Factory for the orchestrator facade. */
export function createEvoHarnessOrchestrator(
  deps: EvoHarnessOrchestratorDeps
): EvoHarnessOrchestrator {
  return new EvoHarnessOrchestratorImpl(deps);
}

/** Narrowing helper used by the plugin entrypoint when reading host payloads. */
export function readOrchestratorMetadata(
  source: unknown
): Readonly<Record<string, unknown>> | undefined {
  return asRecord(source);
}
