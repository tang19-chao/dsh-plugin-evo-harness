/**
 * PR-4A five-arm orthogonal experiment engine.
 *
 * Protocol: `docs/reports/pr4a-five-arm-experiment-preregistration.md`
 * (`PR4A-EVAL-PREREG-20261027-V2`). This module implements the FIVE arms of V2
 * §3.1 — NOT the superseded V1 definitions (advice channel / single-pool mixing
 * are absent here by design; they live only in the prereg's Appendix A as
 * out-of-family counterexamples).
 *
 *   因子设计（2×2 + 1 参照）
 *     Arm-0  track=process       gate=off   updates=off   (冻结参照; 不入主效应)
 *     Arm-1  track=process       gate=off   updates=on
 *     Arm-2  track=process       gate=on    updates=on
 *     Arm-3  track=task-quality  gate=off   updates=on
 *     Arm-4  track=task-quality  gate=on    updates=on
 *
 * HOW EACH FACTOR IS REALISED (and why this keeps the cells orthogonal):
 *
 *   TRACK — the track factor decides whether the arm consumes TRUSTED VERDICT
 *   evidence at all. A host-owned verification runner (src/verification) issues
 *   a real receipt bound to the artifact digest; a quality arm injects that
 *   runner's producer identity into the scorer's injectable `trustedProducers`
 *   seam, which makes `taskQualityEvidence` true and the record's natural
 *   `learningTrack` = 'task-quality'. A process arm injects nothing, which is
 *   exactly the production default (structurally empty producer registry), so
 *   its records are process observations. Neither arm fabricates a track label:
 *   the label is DERIVED by the production scorer from the receipt.
 *
 *   GATE — the gate factor is the ONLY thing that changes between (1,2) and
 *   between (3,4): whether `decideReplacement` (the production conservative
 *   $n_{eff}$ gate) intercepts the final choice. Both gate arms call the SAME
 *   function with the SAME production constants, and `explorationAllowance` is
 *   pinned to 0 in all five arms (V2 §3.2), so the gate factor cannot smuggle in
 *   a second change ("may this also explore on budget?").
 *
 * NOTHING here writes back to a store the arm does not own, and no arm reads
 * another arm's store (V2 §5.4).
 */

import { performance } from 'node:perf_hooks';

import { createMemoryExperienceStore } from '../../src/jitrl/stores/memory.store';
import { abstractProposalState } from '../../src/jitrl/state-abstraction';
import { normalizePatchSignature } from '../../src/jitrl/action-normalizer';
import { verbalizedLogit } from '../../src/jitrl/logit-sources';
import {
  classifyTrajectoryOutcome,
  isLearningOutcome,
  scoreTrajectorySignals
} from '../../src/jitrl/step-evaluator';
import {
  CURRENT_PROVENANCE_VERSION,
  EXPERIENCE_SCHEMA_VERSION,
  isOnLearningTrack
} from '../../src/jitrl/experience-store';
import {
  normalizeLayerDecisionConfig,
  runDecisionKernel,
  seedFromParts,
  type LayerDecisionConfig
} from '../../src/jitrl/decision-kernel';
import { decideReplacement, type ReplacementVerdict } from '../../src/jitrl/replacement-policy';
import type { ActionValueEstimate } from '../../src/jitrl/value-estimator';
import { createHostOwnedVerificationRunner } from '../../src/verification/host-runner';
import { verifyAndAttach } from '../../src/verification/attach';
import {
  registerAuthenticatedQualityRecord,
  clearQualityRecordRegistry,
  isAuthenticatedQualityRecord
} from '../../src/verification/quality-provenance';
import { artifactOf } from '../../src/verification/artifact-digest';
import type { HostVerificationSeam } from '../../src/verification/types';
import type {
  EightSurfacePatch,
  ExperienceRecord,
  GuidanceMode,
  LearningTrack,
  ProbeTask,
  ProbeTrajectory,
  TrajectoryStep
} from '../../src/types/contracts';
import type { TokenMetric } from '../../src/ledger/types';
import { calculateUsageCost } from '../../src/ledger/pricing';
import type { ModelRateCard } from '../../src/ledger/types';

import {
  EVAL_TASKS,
  FAIR_DEFAULT_BETA,
  FAIR_DEFAULT_K,
  FAIR_DEFAULT_ROUNDS,
  FAIR_DEFAULT_SEED,
  FAIR_DEFAULT_SIMILARITY,
  coverageOf,
  createRng,
  fairPoolDigest,
  fairPoolForDecision,
  fairSnapshotDigest,
  hashString,
  makeClock,
  type EvalTask,
  type FairPoolCandidate
} from './jitrl-eval-lib.ts';

// ---------------------------------------------------------------------------
// protocol constants (V2 §5.3) — every one of these is pre-registered
// ---------------------------------------------------------------------------

export const PROTOCOL_ID = 'PR4A-EVAL-PREREG-20261027-V2';

/** L (V2 §5.3): episodes per task. */
export const PR4A_EPISODES = 5;
/** R (V2 §5.3): rounds per episode (WITHIN-task deepening, never a sample). */
export const PR4A_ROUNDS = FAIR_DEFAULT_ROUNDS;
/** N (V2 §5.3): paired analysis units. */
export const PR4A_TASKS = EVAL_TASKS.length;
/** Exploration allowance pinned to 0 for ALL arms (V2 §3.2). */
export const PR4A_EXPLORATION_ALLOWANCE = 0;
/**
 * V2 §5.3 / §9.4: the OFFLINE NOTIONAL guardrail. This is NOT a financial cap
 * and NOT an authorization — it only stops a runaway fixture from producing an
 * absurd report. The name carries the disclaimers on purpose.
 */
export const OFFLINE_NOTIONAL_BUDGET_MICROS = 100_000;
/**
 * V2 §10.2 item 2: the second half of the (offline, nominal) guardrail trigger.
 * Like the micros threshold this is a runaway-fixture stopper, NOT a budget.
 */
export const OFFLINE_NOTIONAL_TOKEN_BUDGET = 500_000;
/** V2 §5.3: local wall-clock guardrail (NOT a remote cost ceiling). */
export const LOCAL_TASK_WALLCLOCK_MS = 60_000;
/** V2 §5.3: per-invocation local timeout. */
export const LOCAL_CALL_TIMEOUT_MS = 10_000;

/** The five arms, exactly as V2 §3.1/§3.2 defines them. */
export type Pr4aArmId = 'Arm-0' | 'Arm-1' | 'Arm-2' | 'Arm-3' | 'Arm-4';

export interface Pr4aArmSpec {
  readonly id: Pr4aArmId;
  readonly label: string;
  /** The single learning track this arm retrieves from and writes to. */
  readonly track: LearningTrack;
  /** Whether executed probes are written back as experience. */
  readonly writesBack: boolean;
  /** Whether the production conservative gate intercepts the final choice. */
  readonly conservativeGate: boolean;
  /** Factor role; `reference` never enters a main-effect estimate (V2 §3.3). */
  readonly role: 'reference' | 'factorial';
  readonly description: string;
}

export const PR4A_ARMS: readonly Pr4aArmSpec[] = [
  {
    id: 'Arm-0',
    label: 'Arm-0 frozen reference (process, gate off, no write-back)',
    track: 'process',
    writesBack: false,
    conservativeGate: false,
    role: 'reference',
    description:
      'the same selection channel and pool as Arm-1, but the experience snapshot never changes (final digest == initial digest)'
  },
  {
    id: 'Arm-1',
    label: 'Arm-1 process track, gate OFF',
    track: 'process',
    writesBack: true,
    conservativeGate: false,
    role: 'factorial',
    description: 'process observations are written back; a deviation from the prior is never intercepted'
  },
  {
    id: 'Arm-2',
    label: 'Arm-2 process track, gate ON (production nEff)',
    track: 'process',
    writesBack: true,
    conservativeGate: true,
    role: 'factorial',
    description:
      'identical to Arm-1 except decideReplacement may keep the prior; same function, same production constants as Arm-4'
  },
  {
    id: 'Arm-3',
    label: 'Arm-3 trusted task-quality track, gate OFF',
    track: 'task-quality',
    writesBack: true,
    conservativeGate: false,
    role: 'factorial',
    description:
      'only host-authenticated task-quality records are retrieved/written; a deviation from the prior is never intercepted'
  },
  {
    id: 'Arm-4',
    label: 'Arm-4 trusted task-quality track, gate ON (production nEff)',
    track: 'task-quality',
    writesBack: true,
    conservativeGate: true,
    role: 'factorial',
    description: 'identical to Arm-3 except decideReplacement may keep the prior; the SAME gate as Arm-2'
  }
];

export function armSpec(id: Pr4aArmId): Pr4aArmSpec {
  const found = PR4A_ARMS.find((entry) => entry.id === id);
  if (found === undefined) throw new RangeError('unknown PR-4A arm: ' + id);
  return found;
}

// ---------------------------------------------------------------------------
// cost accounting: three-state precision (V2 §9)
// ---------------------------------------------------------------------------

/**
 * Token measurement with an explicit precision label.
 *
 * Our harness has NO tokenizer (the fair-eval library documents a chars/4
 * estimator), so nothing here may ever claim `measured`.
 */
export interface Pr4aTokenCount {
  readonly tokens: number;
  readonly precision: 'measured' | 'estimated' | 'unknown';
}

/** One arm's cost block (V2 §9.2), with an explicit denominator. */
export interface Pr4aCostBlock {
  /** V2 §9.2: the denominator every share below is computed over. */
  readonly denominator: 'decision-points';
  readonly decisionPoints: number;
  readonly modelCalls: number;
  /** Six token fields, each carrying its own precision (V2 §9.3). */
  readonly inputTokens: Pr4aTokenCount;
  readonly outputTokens: Pr4aTokenCount;
  readonly reasoningTokens: Pr4aTokenCount;
  readonly cacheReadTokens: Pr4aTokenCount;
  readonly cacheWriteTokens: Pr4aTokenCount;
  readonly totalTokens: Pr4aTokenCount;
  /** Counts of decision points per precision state, and their shares. */
  readonly measured: { readonly count: number; readonly share: number };
  readonly estimated: { readonly count: number; readonly share: number };
  readonly unknown: { readonly count: number; readonly share: number };
  /**
   * V2 §9.1: NOTIONAL micros. Not a spend, not a dollar amount. The rate card is
   * an offline fixture and no real provider is called.
   */
  readonly notionalCostMicros: number;
  /** V2 §9.1: the conservative-floor surcharge, reported SEPARATELY. */
  readonly conservativeSurchargeMicros: number;
  readonly rateCardId: string;
  readonly rateCardVersion: string;
  /** V2 §9.1: hard assertion — this round issues no live call. */
  readonly liveCalls: 0;
  /** V2 §9.1: hard assertion — no real currency is spent. */
  readonly incurredRealUsd: 0;
  /** V2 §5.3: local wall clock, kept strictly OUT of the cost claim. */
  readonly localWallClockMs: number;
  readonly estimator: string;
}

/** The offline fixture rate card. Explicitly labelled a fixture. */
export const PR4A_RATE_CARD: ModelRateCard = {
  modelId: 'pr4a-offline-fixture-model',
  inputRatePerMillion: 550_000,
  cacheReadRatePerMillion: 140_000,
  cacheWriteRatePerMillion: 550_000,
  outputRatePerMillion: 2_190_000,
  reasoningRatePerMillion: 2_190_000,
  reasoningSeparatelyBilled: true,
  conservativeFallbackCostMicros: 20_000
};

export const PR4A_RATE_CARD_VERSION = 'pr4a-fixture-rc-20261027-v1';

/** The documented estimator string (no tokenizer in this harness). */
export const PR4A_TOKEN_ESTIMATOR =
  'chars/4 over the exact rendered prompt text (no tokenizer in this harness) — every token count is ESTIMATED, never measured';

// ---------------------------------------------------------------------------
// safety events and execution control (V2 §10)
// ---------------------------------------------------------------------------

/**
 * Execution-control events (V2 §10.2). They stop or censor EXECUTION; they never
 * rewrite a finding (§10.1), and a censored execution is never counted as a
 * failed one (§6.4).
 *
 * `label` carries the protocol's prose name for the same event so the report can
 * print the §10.2 wording without inventing a second vocabulary:
 *   guardrail-stop -> offline notional guardrail (NOT a financial cap)
 *   futility-stop  -> early-stopped-for-harm (§10.2 item 3)
 *   runner-timeout -> TIMEOUT-ISOLATION: learningEligible=false, auditOnly=true
 */
export type Pr4aExecutionControlEvent =
  | {
      readonly kind: 'guardrail-stop';
      readonly label: 'offline-notional-guardrail';
      readonly armId: Pr4aArmId;
      readonly notionalCostMicros: number;
      readonly totalTokens: number;
      readonly thresholdMicros: number;
      readonly thresholdTokens: number;
    }
  | {
      readonly kind: 'futility-stop';
      readonly label: 'early-stopped-for-harm';
      readonly armId: Pr4aArmId;
      readonly consecutiveZeroTasks: number;
    }
  | {
      readonly kind: 'runner-timeout';
      readonly label: 'timeout-isolation';
      readonly armId: Pr4aArmId;
      readonly taskId: string;
      readonly runIndex: number;
      readonly round: number;
      readonly elapsedMs: number;
      readonly learningEligible: false;
      readonly auditOnly: true;
    }
  | { readonly kind: 'safety-violation'; readonly label: 'security-gate'; readonly detail: string };

/** Why an executed decision did or did not produce a stored learning record. */
export type Pr4aWriteDisposition =
  | 'written'
  | 'not-written-reference'
  | 'audit-only-not-learning-outcome'
  | 'audit-only-unauthenticated'
  | 'audit-only-quality-label-on-process-arm';

/** Why an episode was censored (excluded from the denominator, never failed). */
export type Pr4aCensorReason = 'runner-timeout' | 'guardrail-stop';

/** One decision-level ledger row (V2 §4.1), payload-free. */
export interface Pr4aLedgerEntry {
  readonly armId: Pr4aArmId;
  readonly track: LearningTrack;
  readonly taskId: string;
  readonly run: number;
  readonly round: number;
  readonly stateBucket: string;
  readonly stateFingerprint: string;
  readonly poolDigest: string;
  readonly priorChoice: number;
  /** The decision kernel's raw proposal, BEFORE the conservative gate (§3.1). */
  readonly chosenChoice: number;
  readonly executedIndex: number;
  /** executedIndex !== priorIndex (accepted / rejected deviation). */
  readonly deviated: boolean;
  /** chosenChoice !== priorIndex (a deviation was PROPOSED, gate or not). */
  readonly proposedDeviation: boolean;
  /** True only when the gate's verdict was allowed to change the action. */
  readonly gateEvaluated: boolean;
  readonly gateReason: string | null;
  readonly gateVerdict: 'kept-prior' | 'executed-proposed' | 'executed-exploration' | 'not-applied';
  /** Support / nEff of the EXECUTED candidate (the action that ran). */
  readonly support: number;
  readonly nEff: number | null;
  readonly q: number | null;
  readonly v: number;
  readonly advantage: number;
  /**
   * UNCONDITIONAL challenger measurement (V2 §3.4 / §7.2).
   *
   * `decideReplacement` is the production judge and it reports nEff, support,
   * shrunk and calibrated advantage for the proposed action. A gate-OFF arm
   * still calls it and still persists these four fields: "gate off" means the
   * verdict may not change the action, NOT that the strength of the proposal
   * goes unmeasured. Leaving them null on gate-off arms (the draft's defect)
   * makes the two gate cells incomparable in exactly the dimension the gate
   * factor is supposed to move.
   */
  readonly challengerIndex: number;
  readonly challengerSupport: number;
  readonly challengerNEff: number | null;
  readonly challengerAdvantage: number;
  readonly challengerShrunkAdvantage: number;
  readonly challengerCalibratedAdvantage: number;
  readonly challengerHasReplacementEvidence: boolean;
  readonly priorSupport: number;
  readonly priorNEff: number | null;
  /** Per-row write accounting (§5.2/§6.3): audit-only is a recorded outcome. */
  readonly writeDisposition: Pr4aWriteDisposition;
  readonly learningTrackWritten: LearningTrack | null;
  /** §6.1: the host verdict, not the harness's self-report. */
  readonly hostVerdict: 'passed' | 'failed' | 'refused' | 'absent';
  readonly observedVerified: boolean;
  readonly observedCoverage: number;
}

/** One episode-level observation. */
export interface Pr4aRunObservation {
  readonly runIndex: number;
  /** §6.1 host verdict of the last completed round; null when censored. */
  readonly verified: boolean | null;
  /** The coverage substitute, kept only as an explicit cross-check. */
  readonly coverageVerified: boolean;
  readonly coverage: number;
  /** Every round's chosen index (diagnostic, NOT an independent sample). */
  readonly chosen: readonly number[];
  readonly priorChoice: readonly number[];
  readonly roundCoverage: readonly number[];
  readonly policyChanged: boolean;
  readonly censored: boolean;
  readonly censoredReason: Pr4aCensorReason | null;
  readonly abandonedAtRound: number | null;
  readonly roundsCompleted: number;
}

/** One task's result within one arm. */
export interface Pr4aTaskResult {
  readonly taskId: string;
  readonly familyId: string;
  readonly requiredSurfaces: number;
  readonly oracleCoverage: number;
  readonly runs: readonly Pr4aRunObservation[];
  /** 'not-run-control-stop' = an execution-control stop removed it (§10.4). */
  readonly status: 'completed' | 'not-run-control-stop';
  readonly notRunReason: string | null;
  /** §8.1.4: usable episodes (censored executions are excluded, not failed). */
  readonly availableEpisodes: number;
  readonly censoredEpisodes: number;
  /** §6.1/§7.1: mean host verdict over the AVAILABLE episodes; null when none. */
  readonly verifiedRate: number | null;
  /**
   * DIAGNOSTIC ONLY (§6.1, Appendix B): the same mean computed from the
   * synthetic `coverage >= 1` substitute instead of the host verdict. The
   * pre-registration forbids using the substitute as the metric, so it is
   * carried here only to be printed next to the host figure and diffed.
   */
  readonly coverageSubstituteRate: number | null;
  readonly meanCoverage: number;
  /** Distinct values across theL episodes — the §8.1 replication check. */
  readonly distinctRunValues: number;
  readonly withinRunVariance: number;
  /** False for a task no analysis may include (not-run / fully censored). */
  readonly analysisIncluded: boolean;
}

/** Gate intervention distribution (V2 §7.2) — proof the gate actually fired. */
export interface Pr4aGateStats {
  readonly applied: number;
  readonly keptPrior: number;
  readonly executedProposed: number;
  readonly executedExploration: number;
  readonly reasons: Readonly<Record<string, number>>;
  /** Decisions where a deviation was PROPOSED (gate arms: applied ⊆ proposed). */
  readonly proposedDeviations: number;
}

/** Per-arm result. */
export interface Pr4aArmResult {
  readonly armId: Pr4aArmId;
  readonly spec: Pr4aArmSpec;
  readonly protocol: 'same-task-cold-start';
  readonly episodes: number;
  readonly rounds: number;
  readonly seed: number;
  readonly tasks: readonly Pr4aTaskResult[];
  /** §6.1: mean host verdict over analyzed tasks (null when none). */
  readonly verifiedRate: number | null;
  readonly meanCoverage: number;
  readonly finalMinusAvgCoverage: number;
  readonly policyChangeRate: number;
  readonly klMean: number;
  readonly meanSupport: number;
  readonly meanNEff: number;
  readonly meanChallengerNEff: number;
  readonly gate: Pr4aGateStats;
  readonly cost: Pr4aCostBlock;
  readonly initialSnapshotDigest: string;
  readonly finalSnapshotDigest: string;
  readonly snapshotFrozen: boolean;
  readonly recordsAppended: number;
  /**
   * Track actually written. Kept for the single-track arms, but NOTE: this is a
   * CONVENIENCE field (the last non-null row). The invariant that matters is
   * per ROW (`learningTrackRows`), because one wrong row is a mixed-track store
   * even when the last write happened to be right.
   */
  readonly wroteTrack: LearningTrack | null;
  /** Per-row tally of the track actually written (§5.2 track isolation). */
  readonly learningTrackRows: {
    readonly written: number;
    readonly matching: number;
    readonly mismatched: number;
    readonly nullRows: number;
  };
  /** Per-row write accounting (§5.2/§6.3): written vs audit-only. */
  readonly writeAccounting: {
    readonly eligibleExecutions: number;
    readonly written: number;
    readonly auditOnlyNotLearningOutcome: number;
    readonly auditOnlyUnauthenticated: number;
    readonly auditOnlyQualityLabelOnProcessArm: number;
    readonly referenceNoWriteBack: number;
    readonly processObservationsWithoutTrustedReceipt: number;
    readonly writtenByTrack: Readonly<Record<string, number>>;
  };
  /**
   * §6.3 QUALITY-NEIGHBOURHOOD ASSERTION: at every decision point, how many
   * retrieved quality records were unauthenticated. A quality arm must never
   * have read such a record into its estimate; the counts below are the evidence.
   */
  readonly qualityNeighbourhood: {
    readonly decisionsInspected: number;
    readonly decisionsWithVisibleQualityRecords: number;
    readonly recordsAdmitted: number;
    readonly recordsRejectedUnauthenticated: number;
    readonly assertion: 'passed' | 'FAILED';
  };
  /** §10.4 completeness: nothing is dropped silently. */
  readonly completeness: {
    readonly status: 'complete' | 'incomplete';
    readonly plannedTasks: number;
    readonly analyzedTasks: number;
    readonly notRunTasks: readonly string[];
    readonly denominatorDegradedTasks: readonly string[];
    readonly censoredExecutions: number;
    readonly recordedDecisionPoints: number;
    readonly plannedDecisionPoints: number;
  };
  readonly storeRecordIds: readonly string[];
  readonly verification: {
    readonly receiptsIssued: number;
    readonly trustedVerdicts: number;
    readonly passed: number;
    readonly failed: number;
    readonly refused: number;
    readonly auditOnly: number;
    readonly refusalReasons: Readonly<Record<string, number>>;
    /** §6.1 cross-check: host verdict vs coverage substitute disagreements. */
    readonly hostCoverageAgreements: number;
    readonly hostCoverageDisagreements: number;
  };
  readonly controlEvents: readonly Pr4aExecutionControlEvent[];
  readonly notes: readonly string[];
  /**
   * Total count of §6.3 violations on this arm: quality labels that reached a
   * process estimate, plus unauthenticated quality records found inside a
   * quality arm's neighbourhood. MUST be 0; the report and the CLI assert it.
   */
  readonly auditOnlyViolations: number;
  /** Set when the arm could not run at all (V2 §3.6 capability gate). */
  readonly notRun?: { readonly reason: string; readonly blockingAnchor: string };
}

// ---------------------------------------------------------------------------
// the host-owned verifier (V2 §6)
// ---------------------------------------------------------------------------

/**
 * A host-owned runner whose checks judge the ARTIFACT BYTES, not the arm's
 * self-report. The check verifies that every required surface's marker is
 * present in the deliverable content — i.e. the verdict is derived from the
 * artifact the host received, which is what makes the receipt meaningful.
 *
 * The runner is created per arm so its registry (and therefore its trust) is
 * arm-local: no arm can redeem another arm's receipt.
 */
function createArmVerifier(taskIds: readonly string[], requiredByTask: ReadonlyMap<string, readonly string[]>) {
  return createHostOwnedVerificationRunner({
    verifierId: 'pr4a-host-verifier',
    verifierVersion: '1.0.0',
    testSetId: 'pr4a-synthetic-testset-v1',
    envId: 'pr4a-offline-env-v1',
    cases: taskIds.map((taskId) => ({
      taskId,
      checks: [
        {
          id: 'artifact-non-empty',
          run: (artifact) => artifact.content.length > 0
        },
        {
          id: 'artifact-covers-required-surfaces',
          run: (artifact) => {
            const required = requiredByTask.get(taskId) ?? [];
            if (required.length === 0) return true;
            // The synthetic deliverable names the surfaces it covers; the host
            // judges the bytes, not the arm's bookkeeping.
            return required.every((surface) => artifact.content.includes('surface:' + surface));
          }
        },
        {
          id: 'artifact-has-no-secret',
          run: (artifact) => !/sk-[a-z0-9-]{8,}/i.test(artifact.content)
        }
      ]
    }))
  });
}

// ---------------------------------------------------------------------------
// trajectory helpers
// ---------------------------------------------------------------------------

function failedSteps(now: () => number, label: string): readonly TrajectoryStep[] {
  return [
    { index: 0, at: now(), kind: 'model', text: 'plan the change for ' + label },
    {
      index: 1,
      at: now(),
      kind: 'tool',
      toolName: 'shell',
      toolArguments: { cmd: 'npm test' },
      error: { name: 'ToolError', message: 'exit 1' }
    },
    { index: 2, at: now(), kind: 'error', text: 'the build failed' }
  ];
}

function succeededSteps(now: () => number, label: string): readonly TrajectoryStep[] {
  return [
    { index: 0, at: now(), kind: 'model', text: 'plan the complete change for ' + label },
    {
      index: 1,
      at: now(),
      kind: 'tool',
      toolName: 'shell',
      toolArguments: { cmd: 'npm test' },
      toolResult: { exitCode: 0 }
    },
    { index: 2, at: now(), kind: 'message', text: 'all checks pass with ' + label }
  ];
}

function buildTrajectory(input: {
  readonly id: string;
  readonly taskId: string;
  readonly patchId: string;
  readonly surfaces: readonly string[];
  readonly verified: boolean;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly now: () => number;
  readonly role?: 'reference' | 'candidate';
}): ProbeTrajectory {
  const label = input.surfaces.length === 0 ? 'nothing' : input.surfaces.join('+');
  const steps = input.verified ? succeededSteps(input.now, label) : failedSteps(input.now, label);
  // The artifact carries the covered surfaces as machine-checkable markers, so
  // the host check above can judge the BYTES rather than the arm's claim.
  const content = input.verified
    ? 'synthetic deliverable covering ' + label + '\n' + input.surfaces.map((s) => 'surface:' + s).join('\n')
    : '';
  return {
    id: input.id,
    sessionId: 'pr4a-' + input.taskId,
    branchId: 'pr4a-branch-' + input.taskId,
    branchNamespace: 'pr4a/' + input.taskId,
    role: input.role ?? 'candidate',
    status: input.verified ? 'succeeded' : 'failed',
    patchId: input.patchId,
    patchOrigin: 'domain',
    surfaceKeys: [],
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    metrics: {
      steps: steps.length,
      toolCalls: steps.filter((step) => step.kind === 'tool').length,
      toolErrors: input.verified ? 0 : 1,
      durationMs: Math.max(0, input.endedAt - input.startedAt)
    },
    steps,
    toolErrors: input.verified
      ? []
      : [{ toolName: 'shell', message: 'exit 1', code: 'E1', stepIndex: 1, retryable: true }],
    failureSignals: input.verified
      ? []
      : [{ kind: 'tool_error', message: 'exit 1', toolName: 'shell', repairable: true }],
    memoryRecallIds: [],
    ...(input.verified
      ? {
          deliverable: {
            content,
            format: 'markdown' as const
          }
        }
      : {})
  };
}

function toProbeTask(taskSpec: EvalTask): ProbeTask {
  return {
    id: taskSpec.id,
    prompt: taskSpec.prompt,
    taskSignature: taskSpec.signature,
    complexity: taskSpec.complexity,
    contextTags: taskSpec.contextTags
  };
}

/** Token estimate for one rendered text (documented chars/4 heuristic). */
function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// one arm
// ---------------------------------------------------------------------------

export interface Pr4aArmRunOptions {
  readonly armId: Pr4aArmId;
  readonly seed?: number;
  readonly episodes?: number;
  readonly rounds?: number;
  /** The shared execution order (V2 §5.4.3): every arm sees the same shuffle. */
  readonly taskOrder?: readonly string[];
  readonly tasks?: readonly EvalTask[];
  readonly now?: () => number;
}

/**
 * Run ONE arm over the task suite.
 *
 * Cold start (V2 §5.2 protocol 1): the store starts EMPTY for every arm, so the
 * initial snapshot is `empty` by construction and nothing is injected. Each arm
 * accumulates only its own track's records.
 */
/** One arm's result plus its decision-level ledger. */
export interface Pr4aArmRun {
  readonly arm: Pr4aArmResult;
  readonly ledger: readonly Pr4aLedgerEntry[];
}

/**
 * Run ONE arm over the task suite and return the arm result WITH its ledger.
 *
 * The ledger is returned rather than stashed on the arm object: the report needs
 * to dump it in full (V2 §12.2 requires the complete array on disk, and §0.2 R-12
 * closed the "save only counts + samples" loophole).
 */
export async function runPr4aArmWithLedger(options: Pr4aArmRunOptions): Promise<Pr4aArmRun> {
  const { arm, ledger } = await runPr4aArmInternal(options);
  return { arm, ledger };
}

/** Convenience wrapper for callers that only need the metrics. */
export async function runPr4aArm(options: Pr4aArmRunOptions): Promise<Pr4aArmResult> {
  const { arm } = await runPr4aArmInternal(options);
  return arm;
}

async function runPr4aArmInternal(
  options: Pr4aArmRunOptions
): Promise<{ readonly arm: Pr4aArmResult; readonly ledger: readonly Pr4aLedgerEntry[] }> {
  const spec = armSpec(options.armId);
  const allTasks = options.tasks ?? EVAL_TASKS;
  const seed = options.seed ?? FAIR_DEFAULT_SEED;
  const episodes = options.episodes ?? PR4A_EPISODES;
  const rounds = options.rounds ?? PR4A_ROUNDS;

  // §5.4.3 deterministic shuffle: the SAME order for every arm.
  const byId = new Map(allTasks.map((task) => [task.id, task] as const));
  const orderedIds = options.taskOrder ?? allTasks.map((task) => task.id);
  const tasks = orderedIds
    .map((id) => byId.get(id))
    .filter((task): task is EvalTask => task !== undefined);

  const requiredByTask = new Map(
    allTasks.map((task) => [task.id, [...task.required]] as const)
  );

  // Per-arm isolated store (V2 §5.4.1): its own instance, its own records.
  const clock = options.now ?? makeClock(1_700_000_000_000);
  const store = createMemoryExperienceStore({ now: clock, halfLifeMs: 30 * 24 * 60 * 60 * 1000, bucketCap: 200 });

  // Per-arm verifier: its registry — and therefore its trust — is arm-local.
  const verifier = createArmVerifier(
    allTasks.map((task) => task.id),
    requiredByTask
  );
  const seam: HostVerificationSeam = { runner: verifier, enabled: true };
  /**
   * THE TRACK FACTOR. A quality arm injects the verifier's producer identity, so
   * the scorer's `trustedSource` becomes true and a verdict-derived completion
   * yields `taskQualityEvidence` → `learningTrack='task-quality'`. A process arm
   * injects NOTHING, which is the production default (empty registry) — so its
   * records are process observations and no quality label is fabricated.
   */
  const trustedProducers: ReadonlySet<string> | undefined =
    spec.track === 'task-quality' ? verifier.trustedProducers : undefined;

  const layerConfig: LayerDecisionConfig = normalizeLayerDecisionConfig({
    beta: FAIR_DEFAULT_BETA,
    k: FAIR_DEFAULT_K,
    similarityThreshold: FAIR_DEFAULT_SIMILARITY,
    selection: 'argmax',
    lambda: 0,
    alpha: 5,
    unseenFallback: 'baseline',
    halfLifeMs: 30 * 24 * 60 * 60 * 1000
  });

  const ledger: Pr4aLedgerEntry[] = [];
  const controlEvents: Pr4aExecutionControlEvent[] = [];
  const taskResults: Pr4aTaskResult[] = [];
  const storeRecordIds: string[] = [];
  const notes: string[] = [];

  let decisionPoints = 0;
  let changedChoices = 0;
  let totalRounds = 0;
  const klValues: number[] = [];
  const supportValues: number[] = [];
  const nEffValues: number[] = [];
  const challengerNEffValues: number[] = [];
  const gateStats = {
    applied: 0,
    keptPrior: 0,
    executedProposed: 0,
    executedExploration: 0,
    proposedDeviations: 0,
    reasons: {} as Record<string, number>
  };
  const verificationStats = {
    receiptsIssued: 0,
    trustedVerdicts: 0,
    passed: 0,
    failed: 0,
    refused: 0,
    auditOnly: 0,
    hostCoverageAgreements: 0,
    hostCoverageDisagreements: 0,
    refusalReasons: {} as Record<string, number>
  };
  /**
   * §5.2/§6.3 per-ROW write accounting. A single `wroteTrack` scalar cannot
   * express "some rows were written to the wrong track" - it reports only the
   * LAST write, so a store with one bad row and a correct final row passes the
   * invariant while violating track isolation. These counters are the invariant.
   */
  const writeAccounting = {
    eligibleExecutions: 0,
    written: 0,
    auditOnlyNotLearningOutcome: 0,
    /** Quality arms only (§6.3): no authenticated receipt => audit-only. */
    auditOnlyUnauthenticated: 0,
    auditOnlyQualityLabelOnProcessArm: 0,
    referenceNoWriteBack: 0,
    /**
     * Process arms legitimately persist execution-level observations without a
     * trusted verdict (that IS the production process path: `scoreTrajectorySignals`
     * with an empty producer registry yields `trustedSource=false` process
     * evidence). Counted separately so the report can state the fact instead of
     * hiding it inside a single "written" number.
     */
    processObservationsWithoutTrustedReceipt: 0,
    writtenByTrack: {} as Record<string, number>
  };
  let inputTokens = 0;
  let outputTokens = 0;
  let poolPromptTokens = 0;
  let evaluationTokens = 0;
  let modelCalls = 0;
  let recordsAppended = 0;
  let wroteTrack: LearningTrack | null = null;
  let learningTrackRowsWritten = 0;
  let learningTrackRowsMatching = 0;
  let learningTrackRowsMismatched = 0;
  let learningTrackRowsNull = 0;
  let consecutiveZeroTasks = 0;
  let futilityStopped = false;
  let guardrailStopped = false;
  let plannedDecisionPoints = 0;
  const qualityNeighbourhood = {
    decisionsInspected: 0,
    decisionsWithVisibleQualityRecords: 0,
    recordsAdmitted: 0,
    recordsRejectedUnauthenticated: 0
  };
  const wallStarted = performance.now();

  const initialSnapshotDigest = fairSnapshotDigest([]);

  for (const taskSpec of tasks) {
    if (futilityStopped || guardrailStopped) break;
    const taskStarted = performance.now();
    const runs: Pr4aRunObservation[] = [];
    let taskCensored = false;

    for (let runIndex = 0; runIndex < episodes; runIndex += 1) {
      let covered = new Set<string>();
      let parentSignature: string | undefined;
      let score = 0;
      let runPolicyChanged = false;
      let runCensored = false;
      let runCensoredReason: Pr4aCensorReason | null = null;
      let abandonedAtRound: number | null = null;
      let lastHostVerdict: boolean | null = null;
      let lastCoverageVerified = false;
      const chosen: number[] = [];
      const priorChoice: number[] = [];
      const roundCoverage: number[] = [];
      const runPoolTokens: number[] = [];

      for (let round = 0; round < rounds; round += 1) {
        plannedDecisionPoints += 1;
        const elapsed = performance.now() - taskStarted;
        if (elapsed > LOCAL_TASK_WALLCLOCK_MS) {
          /**
           * §10.2 item 4 / §6.4: TIMEOUT-ISOLATION. The execution is CENSORED -
           * it is neither a pass nor a failure, and the whole episode leaves the
           * metric denominator (an unfinished lineage's host verdict would be a
           * fact about a truncated artifact, not about the task).
           */
          controlEvents.push({
            kind: 'runner-timeout',
            label: 'timeout-isolation',
            armId: spec.id,
            taskId: taskSpec.id,
            runIndex,
            round,
            elapsedMs: Math.round(elapsed),
            learningEligible: false,
            auditOnly: true
          });
          notes.push(
            'task ' +
              taskSpec.id +
              ' run ' +
              String(runIndex) +
              ' round ' +
              String(round) +
              ' hit the ' +
              String(LOCAL_TASK_WALLCLOCK_MS) +
              'ms LOCAL wall-clock guardrail: episode censored (audit-only, NOT a task failure)'
          );
          runCensored = true;
          runCensoredReason = 'runner-timeout';
          abandonedAtRound = round;
          taskCensored = true;
          break;
        }

        // ---- pre-decision nominal guardrail (§10.2 item 2) -----------------
        // Checked BEFORE the decision so an arm can only ever stop at a decision
        // boundary. Checking after the loop would either leave already-decided
        // rows in the ledger of an "aborted" arm, or force the trigger date to be
        // invented (the draft's defect).
        const projectedTokens = inputTokens + outputTokens + 40 + 48;
        const projectedCost = calculateUsageCost(
          {
            inputTokens: { tokens: inputTokens + 40, precision: 'estimated' as const },
            outputTokens: { tokens: outputTokens + 48, precision: 'estimated' as const },
            cacheReadTokens: { tokens: 0, precision: 'estimated' as const },
            cacheWriteTokens: { tokens: 0, precision: 'estimated' as const },
            reasoningTokens: { tokens: 0, precision: 'estimated' as const },
            totalTokens: { tokens: projectedTokens, precision: 'estimated' as const },
            countingSemantics: {
              inputIncludesCacheRead: true,
              outputIncludesReasoning: true,
              semanticTag: 'pr4a-offline-fixture'
            }
          },
          PR4A_RATE_CARD
        ).totalCostMicros;
        if (
          projectedCost > OFFLINE_NOTIONAL_BUDGET_MICROS ||
          projectedTokens > OFFLINE_NOTIONAL_TOKEN_BUDGET
        ) {
          controlEvents.push({
            kind: 'guardrail-stop',
            label: 'offline-notional-guardrail',
            armId: spec.id,
            notionalCostMicros: projectedCost,
            totalTokens: projectedTokens,
            thresholdMicros: OFFLINE_NOTIONAL_BUDGET_MICROS,
            thresholdTokens: OFFLINE_NOTIONAL_TOKEN_BUDGET
          });
          notes.push(
            'arm stopped at a decision boundary: projected notional ' +
              String(projectedCost) +
              ' micros / ' +
              String(projectedTokens) +
              ' tokens exceeds the OFFLINE NOTIONAL guardrail (' +
              String(OFFLINE_NOTIONAL_BUDGET_MICROS) +
              ' micros / ' +
              String(OFFLINE_NOTIONAL_TOKEN_BUDGET) +
              ' tokens) — a runaway-fixture stopper, NOT a financial cap'
          );
          runCensored = true;
          runCensoredReason = 'guardrail-stop';
          abandonedAtRound = round;
          taskCensored = true;
          guardrailStopped = true;
          break;
        }

        const pool = fairPoolForDecision(taskSpec, round);
        const poolDigest = fairPoolDigest(pool);
        const before = clock();
        const config: LayerDecisionConfig = { ...layerConfig, before };
        const priorIndex = pool.reduce(
          (best, entry) =>
            entry.confidence > (pool[best]?.confidence ?? Number.NEGATIVE_INFINITY) ? entry.index : best,
          0
        );
        priorChoice.push(priorIndex);

        // Token accounting: the rendered pool prompt this arm would have sent.
        const poolPromptText = pool
          .map((entry) => 'candidate_' + String.fromCharCode(65 + entry.index) + ':' + entry.surfaces.join('+'))
          .join('\n');
        const poolTokens = estimateTokens(poolPromptText);
        runPoolTokens.push(poolTokens);
        poolPromptTokens += poolTokens;

        const guidance: GuidanceMode = 'memory';
        const rawState = abstractProposalState({
          task: toProbeTask(taskSpec),
          round,
          parentDepth: round,
          parentSlot: 'exploit',
          memoryConfidence: 0,
          referenceStatus: 'failed' as const,
          slot: 'exploit',
          guidance,
          ...(parentSignature === undefined ? {} : { parentPatchSignature: parentSignature })
        });
        const state = { ...rawState, summary: rawState.tokens.join(' ') };

        const seenKeys = new Set<string>();
        const candidates = pool.map((entry) => {
          let actionKey = normalizePatchSignature(entry.patch) || entry.actionKey;
          if (seenKeys.has(actionKey)) actionKey = actionKey + '#' + String(entry.index);
          seenKeys.add(actionKey);
          return {
            actionKey,
            baseLogit: verbalizedLogit(entry.confidence),
            source: 'llm' as const,
            payload: entry
          };
        });

        const snapshot = store.snapshot();
        /**
         * TRACK-ISOLATED RETRIEVAL (V2 §1 invariant 4). The production predicate
         * decides visibility: a process arm sees process (and undeclared) records
         * and NEVER a task-quality record; a quality arm sees only declared
         * task-quality records. This is the same rule the production query path
         * uses, so the arm cannot diverge from it.
         */
        const visible = snapshot.filter((record) => isOnLearningTrack(record, spec.track));
        /**
         * §6.3 QUALITY NEIGHBOURHOOD: a quality arm retrieves ONLY records whose
         * label is authenticated; an unauthenticated label is inert (the kernel
         * would drop it) and would make "the quality track had no data"
         * indistinguishable from "the quality track was fed junk".
         */
        let admitted: readonly ExperienceRecord[] = visible;
        if (spec.track === 'task-quality') {
          const authenticated = visible.filter((record) => isAuthenticatedQualityRecord(record));
          qualityNeighbourhood.decisionsInspected += 1;
          if (visible.length > 0) qualityNeighbourhood.decisionsWithVisibleQualityRecords += 1;
          qualityNeighbourhood.recordsAdmitted += authenticated.length;
          qualityNeighbourhood.recordsRejectedUnauthenticated += visible.length - authenticated.length;
          admitted = authenticated;
        }

        const kernelResult = runDecisionKernel<FairPoolCandidate>({
          level: 'proposal',
          state,
          candidates,
          records: admitted,
          config,
          guidance,
          seed: seedFromParts(seed, taskSpec.id, runIndex, round, 'l2')
        });

        const proposedIndex = candidates.findIndex(
          (entry) => entry.actionKey === kernelResult.decision.chosen.candidate.actionKey
        );
        const rawChosenIndex = proposedIndex >= 0 ? proposedIndex : priorIndex;
        let executedIndex = rawChosenIndex;
        let gateVerdict: Pr4aLedgerEntry['gateVerdict'] = 'not-applied';
        let gateReason: string | null = null;

        /**
         * ---------------- THE GATE FACTOR ----------------
         *
         * `decideReplacement` is the production conservative n_eff judge, and it
         * is invoked UNCONDITIONALLY — on gate-OFF arms too. The antecedent of
         * this block used to be `spec.conservativeGate && …`, which made the
         * gate-off cells report `nEff = null` and no shrunk/calibrated advantage
         * at all: the four challenger fields disappeared precisely in the cells
         * that must be COMPARABLE with the gate-on cells. V2 §3.2 pins the
         * allowance to 0 rather than skipping the judgement, and §3.4 says a
         * gate-off arm still MEASURES the strength (only the interception is
         * disabled). So the judgement always runs; the factor decides only
         * whether `verdict.kind` may move `executedIndex`.
         */
        const challengerAdjustment = kernelResult.decision.adjustments[rawChosenIndex];
        const priorAdjustment = kernelResult.decision.adjustments[priorIndex];
        const challengerEstimate: ActionValueEstimate = {
          actionKey: candidates[rawChosenIndex]?.actionKey ?? 'unknown',
          q: challengerAdjustment?.q ?? null,
          support: challengerAdjustment?.support ?? 0,
          ...(challengerAdjustment?.nEff === undefined ? {} : { nEff: challengerAdjustment.nEff }),
          explored: challengerAdjustment?.explored ?? false,
          advantage: challengerAdjustment?.advantage ?? 0
        };
        const priorEstimate: ActionValueEstimate = {
          actionKey: candidates[priorIndex]?.actionKey ?? 'unknown',
          q: priorAdjustment?.q ?? null,
          support: priorAdjustment?.support ?? 0,
          ...(priorAdjustment?.nEff === undefined ? {} : { nEff: priorAdjustment.nEff }),
          explored: priorAdjustment?.explored ?? false,
          advantage: priorAdjustment?.advantage ?? 0
        };
        const challengerIsNoop =
          Object.keys((pool[rawChosenIndex]?.patch?.edits ?? {}) as Record<string, unknown>).length === 0;
        const verdict: ReplacementVerdict = decideReplacement({
          proposedIndex: rawChosenIndex,
          priorIndex,
          challenger: challengerEstimate,
          prior: priorEstimate,
          challengerIsNoop,
          // V2 §3.2: pinned to 0 for every arm — this is what keeps the gate
          // factor from also switching on budgeted exploration.
          explorationAllowance: PR4A_EXPLORATION_ALLOWANCE
        });
        /**
         * The gate only EVALUATED when a deviation from the prior was proposed;
         * `verdict` is total, so a no-deviation row still reports
         * `executed-proposed` and would otherwise inflate `applied` with rows no
         * gate could ever have intercepted.
         */
        const gateEvaluated = spec.conservativeGate && rawChosenIndex !== priorIndex;
        if (rawChosenIndex !== priorIndex) gateStats.proposedDeviations += 1;
        if (gateEvaluated) {
          gateStats.applied += 1;
          gateVerdict = verdict.kind;
          if (verdict.kind === 'kept-prior') {
            gateReason = verdict.gateReason ?? null;
            gateStats.keptPrior += 1;
            if (gateReason !== null) {
              gateStats.reasons[gateReason] = (gateStats.reasons[gateReason] ?? 0) + 1;
            }
          } else if (verdict.kind === 'executed-exploration') {
            gateStats.executedExploration += 1;
          } else {
            gateStats.executedProposed += 1;
          }
        }
        // THE GATE FACTOR: only an enabled, evaluated gate may move the action.
        if (gateEvaluated && verdict.kind !== 'executed-proposed') {
          executedIndex = verdict.executedIndex;
        }
        // Measured on EVERY row, gate off included (the four unconditional fields).
        const challengerShrunkAdvantage = verdict.challenger.shrunkAdvantage;
        const challengerCalibratedAdvantage = verdict.challenger.calibratedAdvantage;
        const challengerNEffValue = Number.isFinite(verdict.challenger.nEff)
          ? verdict.challenger.nEff
          : null;
        const challengerSupport = verdict.challenger.support;
        const challengerHasReplacementEvidence = verdict.challenger.hasReplacementEvidence;
        const priorNEffValue =
          priorAdjustment?.nEff !== undefined && Number.isFinite(priorAdjustment.nEff)
            ? priorAdjustment.nEff
            : null;

        // Execute the composed lineage.
        const total = new Set<string>([...covered, ...(pool[executedIndex]?.surfaces ?? [])]);
        const totalSurfaces = ['guardrails', 'tool_guidance', 'skills'].filter((surface) => total.has(surface));
        const coverage = coverageOf(taskSpec, totalSurfaces);
        const verified = coverage >= 1 - 1e-9;
        const patchId = 'pr4a-' + taskSpec.id + '-run' + String(runIndex) + '-r' + String(round) + '-c' + String(executedIndex);
        const probeStarted = clock();
        const trajectory = buildTrajectory({
          id: 'pr4a-traj-' + patchId,
          taskId: taskSpec.id,
          patchId,
          surfaces: totalSurfaces,
          verified,
          startedAt: probeStarted,
          endedAt: clock(),
          now: clock
        });

        // ---------------- HOST VERIFICATION (V2 §6) ----------------
        const runId = 'pr4a-' + taskSpec.id + '-run' + String(runIndex);
        const attachResult = await verifyAndAttach({
          seam,
          trajectory,
          runId,
          taskId: taskSpec.id
        });
        const verifiedTrajectory = attachResult.trajectory;
        const disposition = attachResult.disposition;
        if (disposition?.authenticated === true) {
          verificationStats.receiptsIssued += 1;
          if (disposition.verdict === 'passed') verificationStats.passed += 1;
          if (disposition.verdict === 'failed') verificationStats.failed += 1;
        } else if (disposition?.reasonCode !== undefined) {
          verificationStats.refused += 1;
          verificationStats.refusalReasons[disposition.reasonCode] =
            (verificationStats.refusalReasons[disposition.reasonCode] ?? 0) + 1;
        }
        // The §6.4 audit-only classification is a HOST fact (`disposition.auditOnly`),
        // counted independently of whether a receipt exists.
        if (disposition?.auditOnly === true) verificationStats.auditOnly += 1;

        /**
         * THE HOST VERDICT is the primary metric (V2 §6.1/§7.1): the analysis may
         * only consume what the host runner decided. The `coverage >= 1` value
         * below is the SYNTHETIC SUBSTITUTE the prereg's Appendix B explicitly
         * says must be replaced under a real runner — so it is kept, but only as
         * a cross-check that is reported and never used as the metric.
         */
        const hostVerdictKind: Pr4aLedgerEntry['hostVerdict'] =
          disposition?.authenticated === true && disposition.verdict === 'passed'
            ? 'passed'
            : disposition?.authenticated === true && disposition.verdict === 'failed'
              ? 'failed'
              : disposition === undefined
                ? 'absent'
                : 'refused';
        const hostVerified = hostVerdictKind === 'passed';
        if (hostVerified === verified) verificationStats.hostCoverageAgreements += 1;
        else verificationStats.hostCoverageDisagreements += 1;
        lastHostVerdict = hostVerified;
        lastCoverageVerified = verified;

        /**
         * SCORE with the arm's own trust posture. The track factor is realised
         * HERE: passing the producer set makes a verdict-derived completion
         * trusted, which the scorer turns into task-quality evidence.
         */
        const signal = scoreTrajectorySignals(
          verifiedTrajectory,
          trustedProducers === undefined ? {} : { trustedProducers }
        );
        if (signal.taskQualityEvidence) verificationStats.trustedVerdicts += 1;

        evaluationTokens += estimateTokens(
          'task=' + taskSpec.signature + '\nprobe=candidate_' + String(executedIndex) + '\nverified=' + String(verified)
        );
        modelCalls += 1;
        inputTokens += poolTokens + 40;
        outputTokens += 48;

        score = Math.max(score, coverage);
        roundCoverage.push(coverage);
        chosen.push(executedIndex);
        if (executedIndex !== priorIndex) {
          runPolicyChanged = true;
          changedChoices += 1;
        }

        // ---------------- WRITE-BACK (V2 §5.2/§6.3) ----------------
        /**
         * §6.3: on a QUALITY arm an execution that is not host-authenticated is
         * AUDIT-ONLY — it must never be persisted, and it must never be silently
         * downgraded to a process record. The antecedent used to be only
         * `spec.writesBack && isLearningOutcome(...)`, so an unauthenticated
         * quality-labelled run was appended as a process record: the exact shape
         * of the forbidden fallback.
         *
         * Process arms are deliberately NOT gated on `authenticated`: their
         * records are execution-level process observations, which by construction
         * carry `trustedSource=false` (the production default — an empty producer
         * registry). Requiring a trusted verdict there would make the process
         * track empty and redefine the arm.
         */
        const outcomeKind = classifyTrajectoryOutcome(verifiedTrajectory);
        const learningOutcome = isLearningOutcome(outcomeKind);
        const qualityArmNeedsReceipt = spec.track === 'task-quality';
        if (spec.writesBack) writeAccounting.eligibleExecutions += 1;
        let learningTrackWritten: LearningTrack | null = null;
        let writeDisposition: Pr4aWriteDisposition;
        if (!spec.writesBack) {
          writeDisposition = 'not-written-reference';
          writeAccounting.referenceNoWriteBack += 1;
        } else if (!learningOutcome) {
          writeDisposition = 'audit-only-not-learning-outcome';
          writeAccounting.auditOnlyNotLearningOutcome += 1;
        } else if (qualityArmNeedsReceipt && disposition?.authenticated !== true) {
          writeDisposition = 'audit-only-unauthenticated';
          writeAccounting.auditOnlyUnauthenticated += 1;
        } else {
          const derivedTrack: LearningTrack = signal.taskQualityEvidence ? 'task-quality' : 'process';
          if (derivedTrack === 'task-quality' && spec.track !== 'task-quality') {
            // A process arm cannot mint a quality record: its producer set is
            // empty, so this would mean the trust seam leaked across arms.
            writeDisposition = 'audit-only-quality-label-on-process-arm';
            writeAccounting.auditOnlyQualityLabelOnProcessArm += 1;
          } else {
            if (spec.track === 'process' && disposition?.authenticated !== true) {
              writeAccounting.processObservationsWithoutTrustedReceipt += 1;
            }
            /**
             * V2 §5.4.4 requires the five arms' record id sets to be pairwise
             * disjoint. The arm id is therefore part of the identity: without it
             * every arm would mint the same ids for the same coordinates and the
             * disjointness assertion would fail — which is exactly how this was
             * caught.
             */
            const recordId = 'pr4a-exp-' + spec.id + '-' + patchId;
            const observedReturn = signal.reward;
            const learningTarget = signal.learningEligible ? observedReturn : 0;
            const marks = {
              ...signal.sources,
              ...(disposition === undefined
                ? {}
                : {
                    outcomeEligible: 1,
                    verificationVerdict:
                      disposition.verdict === 'passed' ? 1 : disposition.verdict === 'failed' ? 2 : 0,
                    verificationTrusted: signal.verification.trustedSource ? 1 : 0,
                    verificationAuditOnly: disposition.auditOnly ? 1 : 0
                  })
            };
            const record: ExperienceRecord = {
              id: recordId,
              level: 'proposal',
              state,
              actionKey: candidates[executedIndex]?.actionKey ?? 'unknown',
              reward: observedReturn,
              return: observedReturn,
              rewardSources: marks,
              guidance,
              policyId: 'pr4a-policy@v2',
              policyVersion: 'pr4a-policy@v2',
              sessionId: 'pr4a-' + taskSpec.id,
              treeId: 'pr4a-tree-' + taskSpec.id,
              taskId: taskSpec.id,
              runId,
              round,
              slotIndex: executedIndex,
              trajectoryId: verifiedTrajectory.id,
              decisionId: 'pr4a-decision-' + patchId,
              rewardVersion: 'r2/verifiable-v1',
              provenanceVersion: CURRENT_PROVENANCE_VERSION,
              experienceSchemaVersion: EXPERIENCE_SCHEMA_VERSION,
              observedReturn,
              attributionBaseline: 0,
              learningTarget,
              outcome: signal.outcome,
              learningEligible: signal.learningEligible,
              decisionMode: 'shadow',
              actionKeyVocabulary: 'signature',
              // The track is DERIVED from the production scorer, never asserted by
              // this harness. For a process arm `taskQualityEvidence` is false by
              // construction (no producer set), so the label stays honest.
              learningTrack: derivedTrack,
              createdAt: clock(),
              redacted: true
            } as ExperienceRecord;

            // A task-quality record must be REGISTERED to be authenticated; an
            // unregistered label is inert (the kernel drops it) and would falsely
            // look like "the quality track had no data".
            if (record.learningTrack === 'task-quality') {
              /**
               * Reachable only when the host authenticated this execution: the
               * branch above already diverted every unauthenticated quality-arm
               * run to `audit-only-unauthenticated`. The check is repeated here
               * as a fail-closed guard so a future edit cannot silently register
               * a record whose receipt the host never authenticated.
               */
              const receiptDisposition = disposition;
              if (receiptDisposition === undefined || receiptDisposition.authenticated !== true) {
                throw new Error(
                  'PR-4A invariant: a task-quality record was registered without a host-authenticated receipt (' +
                    recordId +
                    ')'
                );
              }
              registerAuthenticatedQualityRecord(record, {
                artifactDigest: receiptDisposition.artifactDigest,
                verifierId: receiptDisposition.verifierId,
                verifierVersion: receiptDisposition.verifierVersion,
                verificationId: receiptDisposition.verificationId,
                testSetId: receiptDisposition.testSetId,
                envId: receiptDisposition.envId,
                taskId: taskSpec.id,
                runId,
                sessionId: 'pr4a-' + taskSpec.id,
                trajectoryId: verifiedTrajectory.id,
                role: 'candidate'
              });
              // Fail-closed self-check: if the registry did not authenticate the
              // record we just built, the write must not happen at all.
              if (!isAuthenticatedQualityRecord(record)) {
                throw new Error(
                  'PR-4A invariant: a task-quality record was not authenticated by the quality registry (' +
                    recordId +
                    ')'
                );
              }
            }

            await store.append([record]);
            recordsAppended += 1;
            storeRecordIds.push(recordId);
            learningTrackWritten = record.learningTrack ?? null;
            writeDisposition = 'written';
            writeAccounting.written += 1;
            writeAccounting.writtenByTrack[String(learningTrackWritten)] =
              (writeAccounting.writtenByTrack[String(learningTrackWritten)] ?? 0) + 1;
            if (learningTrackWritten !== null) wroteTrack = learningTrackWritten;
          }
        }
        /**
         * §5.2 PER-ROW track invariant (not the last write): every row that
         * actually wrote must have written ITS OWN arm's declared track. A store
         * with one wrong row is a mixed-track store even if the final write was
         * correct, which is exactly what a single `wroteTrack` scalar hides.
         */
        if (writeDisposition === 'written') {
          learningTrackRowsWritten += 1;
          if (learningTrackWritten === spec.track) learningTrackRowsMatching += 1;
          else learningTrackRowsMismatched += 1;
        } else {
          learningTrackRowsNull += 1;
        }

        // ---------------- LEDGER (V2 §4.1) ----------------
        const chosenAdjustment = kernelResult.decision.adjustments[executedIndex];
        ledger.push({
          armId: spec.id,
          track: spec.track,
          taskId: taskSpec.id,
          run: runIndex,
          round,
          stateBucket: state.bucket,
          stateFingerprint: hashString(state.tokens.join('|')).toString(16).padStart(8, '0'),
          poolDigest,
          priorChoice: priorIndex,
          chosenChoice: rawChosenIndex,
          executedIndex,
          deviated: executedIndex !== priorIndex,
          proposedDeviation: rawChosenIndex !== priorIndex,
          gateEvaluated,
          gateReason,
          gateVerdict,
          support: chosenAdjustment?.support ?? 0,
          nEff:
            chosenAdjustment?.nEff !== undefined && Number.isFinite(chosenAdjustment.nEff)
              ? chosenAdjustment.nEff
              : null,
          q: chosenAdjustment?.q ?? null,
          v: kernelResult.decision.stateValue,
          advantage: chosenAdjustment?.advantage ?? 0,
          challengerIndex: rawChosenIndex,
          challengerSupport,
          challengerNEff: challengerNEffValue,
          challengerAdvantage: challengerEstimate.advantage,
          challengerShrunkAdvantage,
          challengerCalibratedAdvantage,
          challengerHasReplacementEvidence,
          priorSupport: priorAdjustment?.support ?? 0,
          priorNEff: priorNEffValue,
          writeDisposition,
          learningTrackWritten,
          hostVerdict: hostVerdictKind,
          observedVerified: hostVerified,
          observedCoverage: coverage
        });
        decisionPoints += 1;
        totalRounds += 1;
        klValues.push(kernelResult.decision.klToPrior);
        supportValues.push(chosenAdjustment?.support ?? 0);
        if (chosenAdjustment?.nEff !== undefined) nEffValues.push(chosenAdjustment.nEff);
        if (challengerNEffValue !== null) challengerNEffValues.push(challengerNEffValue);

        covered = total;
        parentSignature = normalizePatchSignature(pool[executedIndex]?.patch ?? ({} as EightSurfacePatch));
      }

      runs.push({
        runIndex,
        verified: runCensored ? null : lastHostVerdict,
        coverageVerified: lastCoverageVerified,
        coverage: score,
        chosen,
        priorChoice,
        roundCoverage,
        policyChanged: runPolicyChanged,
        censored: runCensored,
        censoredReason: runCensoredReason,
        abandonedAtRound,
        roundsCompleted: chosen.length
      });
    }

    /**
     * §8.1.4: the analysis denominator is the AVAILABLE episodes. A censored
     * execution is excluded (never counted as a failure) and the task is listed
     * in `denominator-degraded` instead.
     */
    const available = runs.filter(
      (run): run is Pr4aRunObservation & { readonly verified: boolean } =>
        !run.censored && run.verified !== null
    );
    const values: number[] = available.map((run) => (run.verified ? 1 : 0));
    const coverageValues: number[] = available.map((run) => (run.coverageVerified ? 1 : 0));
    const verifiedRate =
      values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
    const coverageSubstituteRate =
      coverageValues.length === 0 ? null : coverageValues.reduce((a, b) => a + b, 0) / coverageValues.length;
    const meanCoverage =
      available.length === 0
        ? 0
        : available.reduce((a, b) => a + b.coverage, 0) / available.length;
    const withinVariance =
      values.length < 2 || verifiedRate === null
        ? 0
        : values.reduce((sum, value) => sum + (value - verifiedRate) ** 2, 0) / values.length;
    const analysisIncluded = !taskCensored && verifiedRate !== null;
    /**
     * A control stop that removes a WHOLE task is §10.4's `incomplete` case: the
     * task keeps its row with the reason, and the arm reports its original
     * counts (analysisIncluded = false) instead of silently shrinking the
     * denominator.
     */
    const taskStatus: Pr4aTaskResult['status'] = taskCensored ? 'not-run-control-stop' : 'completed';
    const notRunReason =
      taskCensored && !guardrailStopped
        ? 'timeout-isolation: every episode of this task was censored by the local wall-clock guardrail'
        : taskCensored
          ? 'offline-notional-guardrail: the arm stopped at this task\'s decision boundary'
          : null;

    taskResults.push({
      taskId: taskSpec.id,
      familyId: taskSpec.family,
      requiredSurfaces: taskSpec.required.length,
      oracleCoverage: 1,
      runs,
      status: taskStatus,
      notRunReason,
      availableEpisodes: available.length,
      censoredEpisodes: runs.length - available.length,
      verifiedRate,
      coverageSubstituteRate,
      meanCoverage,
      distinctRunValues: new Set(values).size,
      withinRunVariance: withinVariance,
      analysisIncluded
    });

    /**
     * §10.2 item 3: the futility stop fires on 3 consecutive tasks whose
     * verified rate is the observed 0.00 (not the "1.00 → 0.00 plus destructive
     * error" wording, which describes harm that this fixture never produces).
     * The wording difference is disclosed in the report rather than papered over.
     */
    consecutiveZeroTasks = verifiedRate === 0 ? consecutiveZeroTasks + 1 : 0;
    if (consecutiveZeroTasks >= 3) {
      controlEvents.push({
        kind: 'futility-stop',
        label: 'early-stopped-for-harm',
        armId: spec.id,
        consecutiveZeroTasks
      });
      notes.push(
        'futility stop after ' +
          String(consecutiveZeroTasks) +
          ' consecutive zero-verification tasks (V2 §10.2 item 3 "early-stopped-for-harm")'
      );
      futilityStopped = true;
    }
  }

  // V2 §5.4.4: prove the store is this arm's alone.
  const finalSnapshot = store.snapshot();
  const finalSnapshotDigest = fairSnapshotDigest(finalSnapshot);

  // ---- cost, three-state (V2 §9) ----
  const finalTrajectoryCount = Math.max(1, decisionPoints);
  const usage = {
    inputTokens: { tokens: inputTokens, precision: 'estimated' as const },
    outputTokens: { tokens: outputTokens, precision: 'estimated' as const },
    cacheReadTokens: { tokens: 0, precision: 'estimated' as const },
    cacheWriteTokens: { tokens: 0, precision: 'estimated' as const },
    reasoningTokens: { tokens: 0, precision: 'estimated' as const },
    totalTokens: { tokens: inputTokens + outputTokens, precision: 'estimated' as const },
    // The harness knows its OWN counting semantics, so declaring them is honest.
    // (Omitting them would force 'unknown' + a conservative floor — which would
    // overstate the notional figure rather than describe it.)
    countingSemantics: { inputIncludesCacheRead: true, outputIncludesReasoning: true, semanticTag: 'pr4a-offline-fixture' }
  };
  const cost = calculateUsageCost(usage, PR4A_RATE_CARD);
  const measuredCount = 0;
  const estimatedCount = decisionPoints;
  const unknownCount = 0;
  const totalCost = Math.max(1, finalTrajectoryCount);

  const costBlock: Pr4aCostBlock = {
    denominator: 'decision-points',
    decisionPoints,
    modelCalls,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    totalTokens: usage.totalTokens,
    measured: { count: measuredCount, share: measuredCount / totalCost },
    estimated: { count: estimatedCount, share: estimatedCount / totalCost },
    unknown: { count: unknownCount, share: unknownCount / totalCost },
    notionalCostMicros: cost.totalCostMicros,
    conservativeSurchargeMicros: cost.breakdown.conservativeSurchargeMicros ?? 0,
    rateCardId: PR4A_RATE_CARD.modelId,
    rateCardVersion: PR4A_RATE_CARD_VERSION,
    liveCalls: 0,
    incurredRealUsd: 0,
    localWallClockMs: Math.round(performance.now() - wallStarted),
    estimator: PR4A_TOKEN_ESTIMATOR
  };

  /**
   * §10.2 item 2, post-hoc half: if the arm's FINAL notional total already
   * exceeds the guardrail, report the event with the measured number — but do
   * NOT pretend the arm stopped there (the pre-decision check above is what
   * stops execution, and a post-hoc trip that never fired must be reported as
   * "measured, not triggered"). Conflating the two is how a guardrail gets
   * counted as a path the run never took.
   */
  if (costBlock.notionalCostMicros > OFFLINE_NOTIONAL_BUDGET_MICROS) {
    const alreadyReported = controlEvents.some((event) => event.kind === 'guardrail-stop');
    if (!alreadyReported) {
      controlEvents.push({
        kind: 'guardrail-stop',
        label: 'offline-notional-guardrail',
        armId: spec.id,
        notionalCostMicros: costBlock.notionalCostMicros,
        totalTokens: costBlock.totalTokens.tokens,
        thresholdMicros: OFFLINE_NOTIONAL_BUDGET_MICROS,
        thresholdTokens: OFFLINE_NOTIONAL_TOKEN_BUDGET
      });
    }
    notes.push(
      'final notional total ' +
        String(costBlock.notionalCostMicros) +
        ' micros exceeds the offline notional guardrail (' +
        String(OFFLINE_NOTIONAL_BUDGET_MICROS) +
        ') — a runaway-fixture stopper, NOT a financial limit and NOT an incurred spend'
    );
  }

  const analyzedTasks = taskResults.filter((task) => task.analysisIncluded);
  const allTaskValues = analyzedTasks.map((task) => task.verifiedRate ?? 0);
  const armVerifiedRate =
    allTaskValues.length === 0 ? null : allTaskValues.reduce((a, b) => a + b, 0) / allTaskValues.length;
  const armMeanCoverage =
    analyzedTasks.length === 0
      ? 0
      : analyzedTasks.reduce((a, b) => a + b.meanCoverage, 0) / analyzedTasks.length;
  const notRunTasks = taskResults
    .filter((task) => !task.analysisIncluded)
    .map((task) => task.taskId);
  const denominatorDegradedTasks = taskResults
    .filter((task) => task.analysisIncluded && task.availableEpisodes < episodes)
    .map((task) => task.taskId);

  /**
   * §6.4 AUDIT-ONLY ACCOUNTING. Two different red lines, both required:
   *   (a) a QUALITY arm must never persist an unauthenticated execution, and
   *       must never admit an unauthenticated quality record into its estimate;
   *   (b) NO arm may let a quality label reach an estimate on a process track.
   * A process arm writing execution-level process observations without a trusted
   * verdict is (a) the production default, and (b) something the report states
   * explicitly via `processObservationsWithoutTrustedReceipt` — not a violation.
   */
  const auditOnlyViolations =
    writeAccounting.auditOnlyQualityLabelOnProcessArm + qualityNeighbourhood.recordsRejectedUnauthenticated;

  return {
    arm: {
      armId: spec.id,
      spec,
      protocol: 'same-task-cold-start',
      episodes,
      rounds,
      seed,
      tasks: taskResults,
      verifiedRate: armVerifiedRate,
      meanCoverage: armMeanCoverage,
      finalMinusAvgCoverage: 0,
      policyChangeRate: totalRounds === 0 ? 0 : changedChoices / totalRounds,
      klMean: klValues.length === 0 ? 0 : klValues.reduce((a, b) => a + b, 0) / klValues.length,
      meanSupport:
        supportValues.length === 0 ? 0 : supportValues.reduce((a, b) => a + b, 0) / supportValues.length,
      meanNEff: nEffValues.length === 0 ? 0 : nEffValues.reduce((a, b) => a + b, 0) / nEffValues.length,
      // §3.4: the UNCONDITIONAL challenger measurement, so a gate-off arm can be
      // described in the same terms as a gate-on arm.
      meanChallengerNEff:
        challengerNEffValues.length === 0
          ? 0
          : challengerNEffValues.reduce((a, b) => a + b, 0) / challengerNEffValues.length,
      gate: {
        applied: gateStats.applied,
        keptPrior: gateStats.keptPrior,
        executedProposed: gateStats.executedProposed,
        executedExploration: gateStats.executedExploration,
        proposedDeviations: gateStats.proposedDeviations,
        reasons: gateStats.reasons
      },
      cost: costBlock,
      initialSnapshotDigest,
      finalSnapshotDigest,
      snapshotFrozen: recordsAppended === 0 && finalSnapshotDigest === initialSnapshotDigest,
      recordsAppended,
      wroteTrack,
      learningTrackRows: {
        written: learningTrackRowsWritten,
        matching: learningTrackRowsMatching,
        mismatched: learningTrackRowsMismatched,
        nullRows: learningTrackRowsNull
      },
      writeAccounting: {
        eligibleExecutions: writeAccounting.eligibleExecutions,
        written: writeAccounting.written,
        auditOnlyNotLearningOutcome: writeAccounting.auditOnlyNotLearningOutcome,
        auditOnlyUnauthenticated: writeAccounting.auditOnlyUnauthenticated,
        auditOnlyQualityLabelOnProcessArm: writeAccounting.auditOnlyQualityLabelOnProcessArm,
        referenceNoWriteBack: writeAccounting.referenceNoWriteBack,
        processObservationsWithoutTrustedReceipt:
          writeAccounting.processObservationsWithoutTrustedReceipt,
        writtenByTrack: writeAccounting.writtenByTrack
      },
      qualityNeighbourhood: {
        ...qualityNeighbourhood,
        // §6.3: a quality arm must have admitted records ONLY from the
        // authenticated registry, and must never have found an unauthenticated
        // quality record inside its visible neighbourhood (writes are gated on
        // authentication, so a rejection here means a foreign record appeared).
        assertion: qualityNeighbourhood.recordsRejectedUnauthenticated === 0 ? 'passed' : 'FAILED'
      },
      completeness: {
        status: notRunTasks.length === 0 && denominatorDegradedTasks.length === 0 ? 'complete' : 'incomplete',
        plannedTasks: tasks.length,
        analyzedTasks: analyzedTasks.length,
        notRunTasks,
        denominatorDegradedTasks,
        censoredExecutions: taskResults.reduce((sum, task) => sum + task.censoredEpisodes, 0),
        recordedDecisionPoints: decisionPoints,
        plannedDecisionPoints
      },
      storeRecordIds,
      verification: {
        receiptsIssued: verificationStats.receiptsIssued,
        trustedVerdicts: verificationStats.trustedVerdicts,
        passed: verificationStats.passed,
        failed: verificationStats.failed,
        refused: verificationStats.refused,
        auditOnly: verificationStats.auditOnly,
        hostCoverageAgreements: verificationStats.hostCoverageAgreements,
        hostCoverageDisagreements: verificationStats.hostCoverageDisagreements,
        refusalReasons: verificationStats.refusalReasons
      },
      controlEvents,
      notes,
      auditOnlyViolations
    },
    ledger
  };
}

/** Reset the quality registry between arms so trust cannot leak across arms. */
export function resetArmTrust(): void {
  clearQualityRecordRegistry();
}

/** The deterministic execution order shared by all arms (V2 §5.4.3). */
export function pr4aTaskOrder(seed = FAIR_DEFAULT_SEED): readonly string[] {
  const ids = EVAL_TASKS.map((task) => task.id);
  const rng = createRng(seedFromParts(seed, 'pr4a', 'task-order'));
  const shuffled = [...ids];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const left = shuffled[i];
    const right = shuffled[j];
    if (left === undefined || right === undefined) continue;
    shuffled[i] = right;
    shuffled[j] = left;
  }
  return shuffled;
}

export { artifactOf, decideReplacement };