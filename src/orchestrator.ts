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
  BatchPlan,
  BatchSlotPlan,
  BranchExecutor,
  CanonicalLesson,
  CompositionResult,
  DiscoveryNode,
  DreamReplayReport,
  EvoHarnessRunOutcome,
  EvoHarnessRunRequest,
  EightSurfacePatch,
  EvoHarnessRunResult,
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
import { normalizeMetaAction, normalizePatchSignature } from './jitrl/action-normalizer';
import { verbalizedLogit } from './jitrl/logit-sources';
import { abstractMetaState, abstractProposalState } from './jitrl/state-abstraction';
import {
  augmentCandidates,
  guidanceFilterForSlot,
  type LessonPatchSource,
  type RehydratedAction
} from './jitrl/candidate-augmenter';
import { discountedReturn } from './jitrl/step-evaluator';
import { createDiscoveryTree } from './dream-rsi';
import type {
  DiscoveryTree,
  DiscoveryTreeOptions,
  IFailureTaxonomy
} from './dream-rsi';

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
  /** Permanently mount the winning scaffold; defaults to true. */
  readonly applyWinningPatch?: boolean;
  /**
   * Optional JitRL kernel surface (plan Phase 3: L2 selection and online
   * experience recording). Structural on purpose: the orchestrator never
   * imports src/jitrl/**, and a host without JitRL pays nothing. Absent means
   * both stages below are silent no-ops, byte-identical to the pre-Phase-3
   * lifecycle.
   */
  readonly jitrl?: OrchestratorJitRl;
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
  lastLessons(): readonly CanonicalLesson[];
  lastPlan(): SearchGridPlan | null;
  dreamReports(): readonly DreamReplayReport[];
  activePatchIds(): readonly string[];
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

/** Per-source reward totals for one round (plan section 6.5 source names). */
function rewardSourcesOf(rewards: readonly StepReward[]): Readonly<Record<string, number>> {
  const totals: Record<string, number> = {};
  for (const reward of rewards) {
    for (const [source, value] of Object.entries(reward.sources)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        totals[source] = (totals[source] ?? 0) + value;
      }
    }
  }
  return totals;
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

/** One L2 selection made for an admitted candidate (online experience sample). */
interface PreparedSelection {
  readonly state: AbstractState;
  readonly actionKey: string;
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
  private lessons: readonly CanonicalLesson[] = [];
  private plan: SearchGridPlan | null = null;
  private count = 0;
  private disposed = false;

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
    this.applyWinningPatch = deps.applyWinningPatch !== false;
    this.treePool = deps.treePool;
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

  lastComposition(): CompositionResult | null {
    return this.composition;
  }

  lastLessons(): readonly CanonicalLesson[] {
    return this.lessons;
  }

  lastPlan(): SearchGridPlan | null {
    return this.plan;
  }

  dreamReports(): readonly DreamReplayReport[] {
    return this.dreams;
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
      const reference = await this.deps.seams.runInIsolatedBranch({
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
      // Online experience bookkeeping (plan Phase 3): the L1 batch state of the
      // round that produced the winning candidate, plus the L2 selections made
      // for the candidates that actually reached the composer.
      const l1Samples: {
        readonly state: AbstractState;
        readonly round: number;
        /** One entry per scheduled slot, keyed exactly like an L1 candidate. */
        readonly slots: readonly {
          readonly nodeId: string;
          readonly actionKey: string;
          readonly guidance: GuidanceMode;
        }[];
      }[] = [];
      const l2Samples: {
        readonly state: AbstractState;
        readonly actionKey: string;
        readonly slot: BatchSlotPlan;
      }[] = [];
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
          let selection: { readonly chosen: number; readonly offered: number } | undefined;
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
              selection = { chosen: picked.chosen, offered: picked.offered };
            } else {
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
          // actually chosen, so the store can grow a proposal neighbourhood.
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
                  actionKey: normalizePatchSignature(proposed.patch)
                };
          prepared.push({ slot, node, proposed, executionPatch, ...(selectionState === undefined ? {} : { selection: selectionState }) });
        }

        // The L1 sample for this round is the state that produced this batch (not a
        // later round's), with ONE entry per action that actually ran, so the
        // return is attributed to the action it belongs to and each record is
        // matchable by the L1 candidate contract.
        if (prepared.length > 0) {
          l1Samples.push({
            state: buildL1State(batchRequest),
            round: rounds,
            slots: prepared.map((entry) => ({
              nodeId: entry.node.id,
              actionKey: slotActionKey(entry.slot),
              guidance: slotProvenance(entry.slot)
            }))
          });
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

        for (const entry of prepared) {
          if (entry.selection !== undefined) {
            l2Samples.push({ ...entry.selection, slot: entry.slot });
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

        // Phase 3 online learning: score the winning candidate's trajectory step by
        // step, then append the L1 and L2 samples so the in-process neighbourhood
        // grows during the run instead of only through the cold-start backfill.
        const recorded = await this.recordOnlineExperience({
          kernel: this.deps.jitrl,
          task,
          sessionId,
          candidates,
          reference,
          selectedNodeId: composition.selectedNodeId,
          l1Samples,
          l2Samples,
          policyId: runPolicy.id,
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
        if (winningPatch !== null && this.applyWinningPatch) {
          // Roll back the scaffold mounted by an earlier run() before mounting the
          // new winner, so a long-lived host never stacks prompt segments,
          // middleware or skills across successive runs.
          await this.disposeMountedPatches(diagnostics);
          const disposer = await this.deps.seams.applyPermanentPatch(winningPatch);
          this.patchDisposers.push(disposer);
          composedPatchId = winningPatch.id;
          appliedPatchId = winningPatch.id;
          diagnostics.push('permanently mounted scaffold ' + winningPatch.id);
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
        const dream = await this.runDream(config, diagnostics);
        if (dream !== null) {
          dreamTriggered = true;
          const recordDream = this.deps.taskCounter?.recordDream;
          if (recordDream !== undefined) {
            try {
              await recordDream.call(this.deps.taskCounter);
            } catch (error) {
              diagnostics.push('dream counter update failed: ' + errorMessage(error));
            }
          }
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
  private async recordOnlineExperience(input: {
    readonly kernel: OrchestratorJitRl | undefined;
    readonly task: ProbeTask;
    readonly sessionId: string;
    readonly candidates: readonly ProbeCandidate[];
    readonly reference: ProbeTrajectory;
    readonly selectedNodeId: string | null;
    readonly l1Samples: readonly {
      readonly state: AbstractState;
      readonly round: number;
      readonly slots: readonly {
        readonly nodeId: string;
        readonly actionKey: string;
        readonly guidance: GuidanceMode;
      }[];
    }[];
    readonly l2Samples: readonly {
      readonly state: AbstractState;
      readonly actionKey: string;
      readonly slot: BatchSlotPlan;
    }[];
    readonly policyId: string;
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
    // The composer's winner is the trajectory that carries the evidence; without
    // one there is nothing to evaluate and nothing to record.
    const selected = input.candidates.find(
      (candidate) => candidate.nodeId === input.selectedNodeId
    );
    if (selected === undefined) {
      input.diagnostics.push('jitrl: no selected candidate, nothing to evaluate');
      return 0;
    }

    input.stage('evaluate_steps', { round: input.round, detail: { nodeId: selected.nodeId } });
    let rewards: readonly StepReward[];
    try {
      rewards = await evaluator.evaluate(selected.trajectory, {
        task: input.task,
        reference: input.reference
      });
    } catch (error) {
      input.diagnostics.push('evaluate_steps failed: ' + errorMessage(error));
      return 0;
    }
    if (rewards.length === 0) {
      input.diagnostics.push('evaluate_steps produced no steps; nothing recorded');
      return 0;
    }

    const perStep = rewards.map((reward) => reward.reward);
    const returnG = discountedReturn(perStep, kernel.config.gamma, 0);
    const createdAt = this.now();
    const scores = rewards.map((reward) => reward.reward);
    const meanReward = scores.reduce((total, value) => total + value, 0) / scores.length;
    const records: ExperienceRecord[] = [];

    // L1: one record per action that ran this round, in the L1 candidate key
    // vocabulary, carrying that action's own guidance provenance. Support for an
    // action therefore grows only from runs that actually took it.
    const l1 = input.l1Samples.at(-1);
    if (l1 !== undefined) {
      for (const action of l1.slots) {
        records.push({
          id: 'online-' + this.newId(),
          level: 'meta',
          state: l1.state,
          actionKey: action.actionKey,
          reward: clamp(meanReward, -3, 3),
          return: returnG,
          rewardSources: rewardSourcesOf(rewards),
          guidance: action.guidance,
          policyId: input.policyId,
          sessionId: input.sessionId,
          treeId: input.treeId,
          nodeId: action.nodeId,
          createdAt,
          redacted: true
        });
      }
    }

    for (const selection of input.l2Samples) {
      if (selection === undefined) {
        continue;
      }
      records.push({
        id: 'online-' + this.newId(),
        level: 'proposal',
        state: selection.state,
        actionKey: selection.actionKey,
        reward: clamp(meanReward, -3, 3),
        return: returnG,
        rewardSources: rewardSourcesOf(rewards),
        // The L2 sample inherits the provenance of the slot/proposal that ran it.
        guidance: slotProvenance(selection.slot),
        policyId: input.policyId,
        sessionId: input.sessionId,
        treeId: input.treeId,
        ...(input.selectedNodeId === null ? {} : { nodeId: input.selectedNodeId }),
        createdAt,
        redacted: true
      });
    }
    if (records.length === 0) {
      return 0;
    }

    input.stage('record_experience', {
      round: input.round,
      detail: { records: records.length, return: returnG, steps: perStep.length }
    });
    try {
      await kernel.store.append(records);
    } catch (error) {
      input.diagnostics.push('record_experience failed: ' + errorMessage(error));
      return 0;
    }
    return records.length;
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
  }): Promise<{ readonly proposed: ProposedPatch; readonly chosen: number; readonly offered: number } | undefined> {
    const kernel = this.deps.jitrl;
    if (kernel === undefined || !kernel.config.enabled || !kernel.config.levels.includes('proposal')) {
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
    try {
      set = await proposer.proposeCandidates(request);
    } catch (error) {
      input.diagnostics.push(
        'jit_proposal_select: the multi-candidate proposer failed, fell back to propose(): ' +
          errorMessage(error)
      );
      return undefined;
    }
    const offered = Array.isArray(set?.candidates) ? set.candidates : [];
    if (offered.length === 0) {
      return undefined;
    }

    // One node must be created per chosen patch, so patches that normalize to the
    // same signature cannot be told apart in the tree or the experience store.
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
    input.diagnostics.push(
      'jit_proposal_select: selected candidate ' +
        String(chosenIndex) +
        ' of ' +
        String(decisionCandidates.length) +
        ' (probability ' +
        String(decision.chosen.probability) +
        ', klToPrior ' +
        String(decision.klToPrior) +
        '); not probed: ' +
        rejected.join(', ')
    );
    return { proposed: chosen, chosen: chosenIndex, offered: decisionCandidates.length };
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
      return await this.deps.seams.runInIsolatedBranch({
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

  private async commitLessons(
    lessons: readonly CanonicalLesson[],
    scope: MemoryScope,
    diagnostics: string[]
  ): Promise<number> {
    let committed = 0;
    for (const lesson of lessons) {
      try {
        const outcome = await this.deps.memory.commit(lesson, { scope, enforceGovernance: true });
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
  ): Promise<DreamReplayReport | null> {
    try {
      const baseline = this.deps.policy.policy;
      const trees = this.treePool.list();
      const report = await this.deps.dreamer.replay({
        trees,
        baselinePolicy: baseline,
        candidatePolicies: this.candidatePolicies(baseline, config.dreamRsi.candidatePoliciesCount)
      });
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
      diagnostics.push(
        'offline dream: replayed ' +
          String(report.replayedTreeIds.length) +
          ' tree(s), improved=' +
          String(report.improved) +
          ', selected ' +
          report.selectedPolicyId
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
