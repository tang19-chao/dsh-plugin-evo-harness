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
import type {
  BatchPlan,
  BatchSlotPlan,
  BranchExecutor,
  CanonicalLesson,
  CompositionResult,
  DiscoveryNode,
  DreamReplayReport,
  EvoHarnessRunOutcome,
  EvoHarnessRunRequest,
  EvoHarnessRunResult,
  FailureDiagnosis,
  IActivePolicy,
  ICordisSeamManager,
  IDiscoveryTreePool,
  IEvoHarnessOrchestrator,
  IHarnessComposer,
  IHarnessProposer,
  IHarnessReflector,
  IMemoryBridge,
  IOfflineDreamer,
  ISurrogateScorer,
  MemoryIsolationHandle,
  MemoryRecallResult,
  MemoryScope,
  MetaSearchPolicy,
  ProbeCandidate,
  ProbeTask,
  ProbeTrajectory,
  ProposerGuidance,
  RunBudgetOverride,
  SearchGridPlan,
  SurfacePatchDisposer,
  SurrogateScore
} from './types/contracts';
import {
  createDiscoveryTree,
  isTerminalFailure
} from './dream-rsi';
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
  'reference_probe',
  'propose',
  'probe',
  'classify',
  'score',
  'compose',
  'reflect',
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
  readonly onStage?: (event: EvoHarnessStageEvent) => void;
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.name + ': ' + error.message;
  }
  return String(error);
}

function nodeStatusFor(status: ProbeTrajectory['status']): 'succeeded' | 'failed' {
  return status === 'succeeded' ? 'succeeded' : 'failed';
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
      let previousFailure: FailureDiagnosis | undefined;
      let previousBestNodeId: string | undefined;
      let bestScore = -1;
      let candidateProbes = 0;
      let stagnantRounds = 0;
      let composition: CompositionResult | null = null;
      const maxRounds = Math.max(1, Math.min(grid.maxDepth, budget.maxDepth));
      let stop = false;

      while (!stop && rounds < maxRounds) {
        rounds += 1;
        stage('select_batch', { round: rounds });
        const batch: BatchPlan = this.deps.policy.selectBatch({
          task,
          sessionId,
          tree: tree.snapshot(),
          grid,
          memoryConfidence: recall.confidence,
          round: rounds,
          ...(previousBestNodeId === undefined ? {} : { previousBestNodeId }),
          ...(previousFailure === undefined ? {} : { previousFailure })
        });
        if (batch.slots.length === 0) {
          diagnostics.push('round ' + String(rounds) + ': the active policy selected no slots');
          break;
        }

        for (const slot of batch.slots) {
          // The plan_grid budget bounds candidate rollouts. The reference anchor is
          // instrumentation for the contrast, not an exploration rollout, so it is
          // charged to probesRun but never to the exploration budget; otherwise a
          // memory-confident plan with budget 1 could not evolve anything.
          if (candidateProbes >= grid.budget || candidateProbes >= budget.maxOnlineRolloutBudget) {
            stopReason = 'budget_exhausted';
            stop = true;
            break;
          }
          const parentNode = tree.getNode(slot.parentNodeId) ?? rootNode;
          const guidance = this.guidanceForSlot(slot, recall, config);

          stage('propose', { round: rounds, detail: { slot: slot.slot } });
          let proposed;
          try {
            proposed = await this.deps.proposer.propose({
              task,
              sessionId,
              slot,
              guidance,
              parentNode,
              referenceTrajectory: reference,
              enabledSurfaces: config.enabledSurfaces,
              attemptIndex: slot.slotIndex + 1,
              totalBudget: grid.budget
            });
          } catch (error) {
            diagnostics.push(
              'proposal failed for slot ' + slot.slot + ': ' + errorMessage(error)
            );
            continue;
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

          stage('probe', { round: rounds, detail: { nodeId: node.id } });
          const trajectory = await this.probeCandidate({
            sessionId,
            task,
            slot,
            patchId: proposed.patch.id,
            patch: proposed.patch,
            nodeId: node.id,
            treeId: tree.id,
            referenceTrajectoryId: reference.id,
            recallIds: recall.lessons.map((lesson) => lesson.id),
            diagnostics
          });
          probesRun += 1;
          candidateProbes += 1;
          trajectories.push(trajectory);

          stage('classify', { round: rounds });
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

          stage('score', { round: rounds });
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
          if (score.score > bestScore) {
            bestScore = score.score;
            previousBestNodeId = node.id;
          }
          if (diagnosis.category !== 'none') {
            // Retain the failure: ActivePolicy.findRecoveryTarget needs it to
            // schedule a recover slot even when a sibling slot just succeeded.
            previousFailure = diagnosis;
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
        let bestFinalScore = bestScore;
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
          if (finalScore.score > bestFinalScore) {
            bestFinalScore = finalScore.score;
            previousBestNodeId = candidate.nodeId;
          }
        }
        bestScore = bestFinalScore;

        const selected = composition.assessments.some((assessment) => assessment.selected);
        if (selected) {
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
        if (previousFailure !== undefined && isTerminalFailure(previousFailure)) {
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

        stage('commit');
        lessonsCommitted = await this.commitLessons(reflection.lessons, scope, diagnostics);

        stage('apply_patch');
        const winningPatch = composition.composedPatch ?? composition.selectedPatch;
        if (winningPatch !== null && this.applyWinningPatch) {
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

      if (this.shouldDream(config)) {
        stage('offline_dream');
        const dream = await this.runDream(config, diagnostics);
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
