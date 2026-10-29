/**
 * JitRL step evaluator (plan section 6.5; P1-5).
 *
 * Fuses per-step signals into a clipped reward r_t =
 * clip(sum(w_s * signal_s), clip[0], clip[1]) and exposes the discounted
 * return G_t = discountedReturn(rewards, gamma, t) as a standalone helper:
 * - llm: a -3..+3 judge score (purpose 'evaluate_steps', anonymized
 *   candidate, strict JSON with a clamped neutral fallback on malformed
 *   output), gated by the plan's cost rules;
 * - surrogate: s_v in [0, 1] mapped linearly to [-3, +3];
 * - tool: per tool step, error -2, success +0.5, repeated identical error
 *   -3 (identity = tool name + message);
 * - turn: completed +1, error -2, max-tokens/budget -1, aborted 0, taken
 *   from the terminal trajectory status and applied to the final step;
 * - user: adopt +3, rollback or reject -3, applied to the final step.
 *
 * The evaluator is fully deterministic: no Date.now, no Math.random, and
 * it must work with no model client injected at all - that low-cost path
 * is the default in tests and CI. Injected clock/rng are accepted for
 * determinism symmetry and reserved for future latency-aware or
 * stochastic gating paths; v1 outputs never read them.
 */

import {
  type ExperienceOutcome,
  type FailureSignal,
  type IModelAdapter,
  type IStepEvaluator,
  type ModelRequest,
  type ProbeTask,
  type ProbeTrajectory,
  type StepReward,
  type TrajectoryStatus,
  type TrajectoryStep
} from '../types/contracts';
// P3-B: the LLM step judge is metered and stage-labelled like every other call.
import { createMeteredModelAdapter, type MeteredModelOptions } from '../dsh-bridge/metered-model-adapter';
import type { JitRlPrivacyConfig, JitRlRewardConfig, JitRlRewardWeightsConfig } from '../config';
import { clamp01 } from './logit-sources';
import { redactAbsolutePaths, redactSecrets } from './redaction';

/** Tool signal values (plan section 6.5). */
export const TOOL_SUCCESS_SIGNAL = 0.5;
export const TOOL_ERROR_SIGNAL = -2;
export const TOOL_REPEATED_ERROR_SIGNAL = -3;
/** Judge score bounds (plan section 6.5, llm row). */
export const JUDGE_SCORE_MIN = -3;
export const JUDGE_SCORE_MAX = 3;
/** Surrogate s_v in [0, 1] maps linearly onto [-3, 3]. */
export const SURROGATE_SCALE = 6;
/** Cost gate: |delta s_v| against the reference above this justifies the judge. */
export const SURROGATE_DELTA_GATE = 0.2;
/** Cost gate: judge runs when the trajectory has at least this many steps. */
export const MIN_STEPS_FOR_LLM_JUDGE = 3;

/** Host user feedback kinds feeding the user signal. */
export type UserFeedbackKind = 'adopt' | 'rollback' | 'reject';

/** User signal: adopt +3, rollback or reject -3 (plan section 6.5). */
export function userSignal(kind: UserFeedbackKind): number {
  return kind === 'adopt' ? 3 : -3;
}

/**
 * Turn signal mapped from the terminal trajectory status: succeeded maps to
 * the host's 'completed' (+1), failed to 'error' (-2), timeout to the
 * 'max-tokens'/budget exhaustion (-1) and aborted to 0.
 */
export function turnSignalForStatus(status: TrajectoryStatus): number {
  switch (status) {
    case 'succeeded':
      return 1;
    case 'failed':
      return -2;
    case 'timeout':
      return -1;
    case 'aborted':
      return 0;
  }
}

/** Surrogate signal: s_v in [0, 1] linearly onto [-3, +3]. */
export function surrogateSignal(score01: number): number {
  return clamp01(score01) * SURROGATE_SCALE - SURROGATE_SCALE / 2;
}

/**
 * Fuse weighted signals into one clipped reward. Unknown source names
 * (for example the 'evaluated' marker) have no weight and contribute
 * nothing; non-finite signal values are skipped.
 */
export function combineStepRewards(
  sources: Readonly<Record<string, number>>,
  weights: JitRlRewardWeightsConfig,
  clip: readonly [number, number]
): number {
  let total = 0;
  const lookup = weights as unknown as Readonly<Record<string, number | undefined>>;
  for (const [name, value] of Object.entries(sources)) {
    const weight = lookup[name];
    if (weight === undefined || !Number.isFinite(value)) {
      continue;
    }
    total += weight * value;
  }
  const min = Number.isFinite(clip[0]) ? clip[0] : JUDGE_SCORE_MIN;
  const max = Number.isFinite(clip[1]) ? clip[1] : -JUDGE_SCORE_MIN;
  return Math.min(max, Math.max(min, total));
}

/**
 * Discounted return G_t = sum_{u >= t} gamma^(u - t) * r_u. Gamma is
 * clamped into [0, 1], out-of-range start indices yield 0, and non-finite
 * reward entries are treated as 0 so the arithmetic stays deterministic.
 */
export function discountedReturn(
  rewards: readonly number[],
  gamma: number,
  fromStep: number
): number {
  const g = clamp01(gamma);
  if (!Number.isInteger(fromStep) || fromStep < 0 || fromStep >= rewards.length) {
    return 0;
  }
  let total = 0;
  let factor = 1;
  for (let index = fromStep; index < rewards.length; index += 1) {
    const value = rewards[index];
    if (value !== undefined && Number.isFinite(value)) {
      total += factor * value;
    }
    factor *= g;
  }
  return total;
}

// Repair B2: secret/path redaction now lives in the shared ./redaction
// module so state abstraction and this evaluator cannot drift. The two
// helpers below are thin compatibility exports over that implementation.
export { redactAbsolutePaths } from './redaction';

/** Backward-compatible alias over the shared redactSecrets implementation. */
export function redactCommonSecrets(text: string): string {
  return redactSecrets(text);
}

const DEFAULT_EVALUATOR_PRIVACY: JitRlPrivacyConfig = {
  redactSecrets: true,
  storeRawText: false
};

const PROMPT_TEXT_LIMIT = 200;

function truncate(text: string): string {
  return text.length <= PROMPT_TEXT_LIMIT ? text : text.slice(0, PROMPT_TEXT_LIMIT) + '...';
}

/**
 * Prompt-safe rendering of one text blob: raw text is withheld unless
 * privacy.storeRawText is set, absolute paths are always stripped, and
 * secrets are stripped when privacy.redactSecrets is set.
 */
function promptText(text: string, privacy: JitRlPrivacyConfig): string {
  if (!privacy.storeRawText) {
    return '(raw text withheld)';
  }
  const withoutPaths = redactAbsolutePaths(text);
  return privacy.redactSecrets ? redactSecrets(withoutPaths) : withoutPaths;
}

/** Options for the fused step evaluator. */
export interface StepEvaluatorOptions {
  readonly reward: JitRlRewardConfig;
  readonly privacy?: JitRlPrivacyConfig;
  readonly model?: IModelAdapter;
  /** P3-B metering wiring (ledger/registry); absent records calls without cost. */
  readonly metering?: MeteredModelOptions;
  /**
   * Returns s_v in [0, 1] for a trajectory (and its reference), or undefined
   * when no surrogate value is available. The L1 integration adapts the
   * existing ISurrogateScorer to this narrow shape.
   */
  readonly surrogate?: (trajectory: ProbeTrajectory, reference?: ProbeTrajectory) => number | undefined;
  /** Injected for determinism; reserved for future latency-aware paths. */
  readonly clock?: () => number;
  /** Injected for determinism; reserved for future stochastic gating. */
  readonly rng?: () => number;
}

/** Richer input for evaluateSteps beyond the frozen IStepEvaluator contract. */
export interface StepEvaluationInput {
  readonly trajectory: ProbeTrajectory;
  readonly task: ProbeTask;
  readonly reference?: ProbeTrajectory;
  /** Composer selection hint: justifies the judge cost. */
  readonly selected?: boolean;
  /** Composition hint: justifies the judge cost. */
  readonly composed?: boolean;
  /** Host user feedback, applied to the final step. */
  readonly user?: UserFeedbackKind;
}

/** IStepEvaluator plus the richer entry point and diagnostics getter. */
export interface JitStepEvaluator extends IStepEvaluator {
  evaluateSteps(input: StepEvaluationInput): Promise<readonly StepReward[]>;
  diagnostics(): readonly string[];
}

interface JudgeOutcome {
  readonly ok: boolean;
  readonly scores: ReadonlyMap<number, number>;
}

function parseJudgeJson(text: string): JudgeOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, scores: new Map<number, number>() };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, scores: new Map<number, number>() };
  }
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.steps)) {
    return { ok: false, scores: new Map<number, number>() };
  }
  const scores = new Map<number, number>();
  for (const entry of record.steps) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const item = entry as Record<string, unknown>;
    const stepIndex = item.stepIndex;
    const score = item.score;
    if (typeof stepIndex !== 'number' || !Number.isFinite(stepIndex) || typeof score !== 'number' || !Number.isFinite(score)) {
      continue;
    }
    scores.set(stepIndex, Math.min(JUDGE_SCORE_MAX, Math.max(JUDGE_SCORE_MIN, score)));
  }
  return { ok: true, scores };
}

function stepSummary(step: TrajectoryStep, trajectory: ProbeTrajectory, privacy: JitRlPrivacyConfig): string {
  const parts: string[] = [step.kind];
  if (step.kind === 'tool' && step.toolName !== undefined) {
    parts.push(step.toolName);
  }
  const inlineError = step.error;
  const recordedError = trajectory.toolErrors.find((entry) => entry.stepIndex === step.index);
  const error = inlineError ?? (recordedError === undefined ? undefined : { name: 'ToolError', message: recordedError.message, code: recordedError.code });
  if (error !== undefined) {
    parts.push('error ' + error.name + ': ' + truncate(promptText(error.message, privacy)));
  }
  if (step.text !== undefined) {
    parts.push(truncate(promptText(step.text, privacy)));
  }
  return parts.join(' | ');
}

function buildJudgePrompt(input: StepEvaluationInput, privacy: JitRlPrivacyConfig): string {
  const steps = [...input.trajectory.steps].sort((a, b) => a.index - b.index);
  const lines: string[] = [
    'You judge the quality of each step of an anonymized candidate run.',
    'Return ONLY minified JSON of shape',
    '{"steps":[{"stepIndex":0,"result":"short","usefulness":0.5,"certainty":0.5,"score":1.5}]}',
    'with every score in [-3, 3]. Identities, patch origins and surfaces are withheld.'
  ];
  lines.push('Task: ' + truncate(promptText(input.task.prompt, privacy)));
  if (input.reference !== undefined) {
    lines.push('A reference run exists (identity withheld).');
  }
  lines.push('Steps:');
  for (const step of steps) {
    lines.push('- step ' + String(step.index) + ': ' + stepSummary(step, input.trajectory, privacy));
  }
  return lines.join('\n');
}

function toolErrorIdentity(step: TrajectoryStep, trajectory: ProbeTrajectory): string | undefined {
  if (step.error !== undefined) {
    return (step.toolName ?? 'tool') + '|' + step.error.message;
  }
  const recorded = trajectory.toolErrors.find((entry) => entry.stepIndex === step.index);
  if (recorded !== undefined) {
    return recorded.toolName + '|' + recorded.message;
  }
  return undefined;
}

const REWARD_SOURCE_KEYS = ['llm', 'surrogate', 'tool', 'turn', 'user'] as const;

function rationaleFor(sources: Readonly<Record<string, number>>): string {
  const names = REWARD_SOURCE_KEYS.filter((key) => sources[key] !== undefined);
  const list = names.length > 0 ? names.join('+') : 'none';
  return sources.evaluated === 1
    ? 'llm judge ran; fused ' + list
    : 'llm gated out; low-cost ' + list;
}

// ---------------------------------------------------------------------------
// P6 PR4: verifiable per-trajectory credit (plan sections 6.2 and 6.3)
// ---------------------------------------------------------------------------
//
// The online recorder must give EVERY executed probe its own result, whether it
// won or lost, and must never invent one for a candidate that never ran. The
// signals below are read from the trajectory itself (tool status, repeated
// errors, completion, step count, failure type), so the same trajectory always
// scores the same way and no model call is involved. That is the "first step"
// the plan asks for; the optional LLM judge stays a separate, cost-gated path
// inside createStepEvaluator.

/** Step-efficiency signal scale: -1 at or above the budget, +1 at 1 step. */
export const STEP_BUDGET_SIGNAL_SCALE = 1;
/** Default step budget used when the caller does not supply one. */
export const DEFAULT_STEP_BUDGET = 12;

/**
 * Narrow infrastructure-failure markers. Deliberately small: an unclassified
 * failure is NOT infrastructure (it stays attributable to the action), because
 * mislabelling a real model failure as infrastructure would silently delete a
 * negative sample.
 */
const INFRASTRUCTURE_ERROR_NAMES: readonly string[] = [
  'EvoHarnessPluginError',
  'EvoHarnessSeamError'
];

const INFRASTRUCTURE_MESSAGE = /(no branch executor|ECONNREFUSED|ECONNRESET|ENOTFOUND|EPIPE|EACCES|EMFILE|EAGAIN)/;

/** True when the failure came from the harness/transport, not from the model. */
export function isInfrastructureFailure(trajectory: ProbeTrajectory): boolean {
  const name = trajectory.error?.name;
  if (name !== undefined && INFRASTRUCTURE_ERROR_NAMES.includes(name)) {
    return true;
  }
  if (name === 'AbortError' || name === 'TimeoutError') {
    return false;
  }
  if (trajectory.error !== undefined && INFRASTRUCTURE_MESSAGE.test(trajectory.error.message)) {
    return true;
  }
  for (const signal of trajectory.failureSignals) {
    if (signal.kind === 'unknown' && INFRASTRUCTURE_MESSAGE.test(signal.message)) {
      return true;
    }
  }
  return false;
}

/**
 * True when the host reported a USER cancellation rather than a harness abort.
 *
 * A plain `AbortError` is NOT a user cancellation: it is the harness stopping a
 * run (timeout, budget, teardown), which the plan keeps as `aborted`. Only an
 * explicit user marker (a cancellation error name, or a message that says the
 * user withdrew the run) counts - that is the one case where the plan says
 * "用户主动取消不自动当成动作质量差".
 */
export function isUserCancellation(trajectory: ProbeTrajectory): boolean {
  const name = trajectory.error?.name;
  if (name === 'CancelledError' || name === 'UserCancelledError') {
    return true;
  }
  const message = trajectory.error?.message;
  if (message !== undefined && /user (cancel|abort)|cancelled by user|cancel requested/i.test(message)) {
    return true;
  }
  for (const signal of trajectory.failureSignals) {
    if (/user (cancel|abort)|cancelled by user|cancel requested/i.test(signal.message)) {
      return true;
    }
  }
  return false;
}

/**
 * Classify how one executed probe ended (plan section 6.2).
 *
 * The five failure modes stay distinguishable because they mean different
 * things to the learner:
 *   - timeout: the action consumed its budget -> a real negative sample;
 *   - failed: the action itself went wrong -> a real negative sample;
 *   - aborted: the run was stopped from outside -> no evidence about quality;
 *   - cancelled: the user withdrew it -> no evidence about quality;
 *   - infrastructure_error: the harness/transport broke -> not a model failure.
 */
export function classifyTrajectoryOutcome(
  trajectory: ProbeTrajectory,
  hint: { readonly cancelled?: boolean } = {}
): ExperienceOutcome {
  if (hint.cancelled === true || isUserCancellation(trajectory)) {
    return 'cancelled';
  }
  switch (trajectory.status) {
    case 'succeeded':
      return 'succeeded';
    case 'timeout':
      return 'timeout';
    case 'aborted':
      return 'aborted';
    case 'failed':
      break;
  }
  if (isInfrastructureFailure(trajectory)) {
    return 'infrastructure_error';
  }
  // A failed run that exhausted its budget or timed out is a timeout, not a
  // generic failure: the plan keeps the two apart.
  const timedOut = trajectory.failureSignals.some(
    (signal) => signal.kind === 'timeout' || signal.kind === 'budget_exhausted'
  );
  return timedOut ? 'timeout' : 'failed';
}

/**
 * True when an outcome may train the policy. A cancelled or aborted execution
 * says nothing about action quality, and an infrastructure failure is not a
 * model failure (plan section 6.2), so both are audit-only.
 */
export function isLearningOutcome(outcome: ExperienceOutcome): boolean {
  return outcome !== 'cancelled' && outcome !== 'aborted' && outcome !== 'infrastructure_error';
}

/** Turn/status signal for an outcome (mirrors turnSignalForStatus). */
export function turnSignalForOutcome(outcome: ExperienceOutcome): number {
  switch (outcome) {
    case 'succeeded':
      return 1;
    case 'failed':
      return -2;
    case 'timeout':
      return -1;
    case 'aborted':
    case 'cancelled':
    case 'infrastructure_error':
      return 0;
  }
}

// ---------------------------------------------------------------------------
// P6.2 PR-B / F3: the trusted verifier interface and task-vs-execution split
// ---------------------------------------------------------------------------
//
// The pre-PR-B completion condition was `deliverable.content.length > 0`: any
// non-empty text earned COMPLETION_SIGNAL (+1), so a fluent-but-wrong
// deliverable scored ~+0.9333 and became a POSITIVE training sample. Nothing
// in the trajectory can tell "correct" from "confidently wrong" - only a
// verifier can. PR-B therefore defines the verifier contract here (the true
// leaf module: reward-contract.ts imports this file, never the reverse) and
// makes the completion source a function of the VERIFIER status:
//
//   passed   -> +1 (a trusted verifier accepted the task result)
//   failed   -> -1 and the fused reward is lexicographically clamped <= 0, so
//               no amount of tool-smoothness / step-efficiency / text presence
//               can buy back a positive score ("一次少调用不能抵消验收失败")
//   unknown  ->  no completion bonus at all; the run stays a PROCESS
//               observation (it may train on execution-level signals, but it
//               never records a task success)
//
// Fail-closed rules:
//   - a verification payload that is missing or malformed is UNKNOWN, never
//     passed (the model's self-reported status proves nothing);
//   - the structural fallback (no verifier wired) NEVER returns 'passed' -
//     without a verifier, task success is unprovable, only disprovable;
//   - execution success (`trajectory.status === 'succeeded'`) and task success
//     (verification passed) are carried as SEPARATE fields on the score.
//   - C2-PRE (ADR 0002 5.2a, t6 revision): shape-validated passed/failed
//     verdicts establish NO task-quality learning evidence by themselves - the
//     trustedSource/taskQualityEvidence fields below are the consumer-side
//     pin. failed-without-trusted-provenance stays a scale-level negative
//     signal but is audit-only on the task-quality track (trusted-failure
//     learning is the explicit C2 unfinished item). t10/V3b: the FACT flag
//     (taskQualityEvidence: trusted verdict-derived completion only) is
//     separated from the CONSUMPTION gate (taskQualityLearningEligible: the
//     process path keeps unknown-verdict records trainable), so the field
//     semantics can never be conflated again.

/** Verifier verdict for one executed trajectory's task result. */
export type TrustedVerificationStatus = 'passed' | 'failed' | 'unknown';

/**
 * C2-pre trust boundary (ADR 0002 5.2a, t6 revision; V5 hardening): verification
 * SHAPE is not verification SOURCE. `isTrustedVerification` validates payload
 * structure only - it cannot stop an arbitrary payload from claiming any
 * verifierId. Trust therefore needs an explicit, fail-closed producer registry:
 * a verdict proves nothing beyond "the payload claims it" until its verifierId
 * was registered here by a trusted producer.
 *
 * V5 (t7): the registry is FROZEN EMPTY for the whole C0+C1 round. The public
 * string registrar that previously lived here was REMOVED - any importer could
 * mint a trusted producer with a plain string, which is exactly the untrusted
 * promotion channel C0+C1 must not ship (ADR 0002 R7: this round delivers
 * contract shape + structural validation ONLY; source trust begins at C2,
 * implemented behind a trusted service/receipt boundary, not a module-level
 * string set). Until C2 lands, `hasTrustedVerificationProvenance` is
 * structurally false for every payload: there is no registration path.
 */
const TRUSTED_VERIFIER_PRODUCERS: ReadonlySet<string> = new Set<string>();

/**
 * C2 entry point PLACEHOLDER (ADR 0002 5.2a/R7; V5): deliberately NOT
 * implemented this round. C2 will deliver trusted verification producers
 * through a trusted service / receipt boundary that verifies producer
 * identity cryptographically or via a host-controlled allowlist configured
 * outside the plugin's import graph. Do NOT add a string-based registrar
 * here; that would re-open the arbitrary-promotion hole this fix closes.
 */

/** True when the verifierId belongs to a registered trusted producer. */
export function isRegisteredTrustedVerifier(verifierId: string): boolean {
  return TRUSTED_VERIFIER_PRODUCERS.has(verifierId);
}

/**
 * True when a verification payload carries TRUSTED provenance (ADR 0002 5.2a):
 * an explicit (non-structural) payload, a verifierId that belongs to the
 * caller-supplied trusted producer set, and a bound evidence hash.
 *
 * t8/V5b: when `expectedEvidenceHash` is supplied (the hash of the execution
 * evidence the verdict claims to have judged), the payload's evidenceHash
 * must MATCH it exactly - a claimed-but-unbound hash establishes nothing.
 *
 * t10/V5+COV: the producer set is an INJECTED PARAMETER (defaults to the
 * frozen empty registry). There is no global string registrar: trust is owned
 * by the caller that supplies the set, and the production path supplies
 * nothing (structurally empty, C2-pre). C2 will replace this parameter with
 * the trusted service/receipt boundary.
 */
export function hasTrustedVerificationProvenance(
  verification: TrustedVerification,
  expectedEvidenceHash?: string,
  trustedProducers: ReadonlySet<string> = TRUSTED_VERIFIER_PRODUCERS
): boolean {
  if (verification.implicit === true) {
    return false;
  }
  if (!trustedProducers.has(verification.verifierId)) {
    return false;
  }
  if (typeof verification.evidenceHash !== 'string' || verification.evidenceHash.length === 0) {
    return false;
  }
  if (expectedEvidenceHash !== undefined && verification.evidenceHash !== expectedEvidenceHash) {
    return false;
  }
  return true;
}

/**
 * The trusted verification record (P6.2 PR-B / F3; review section 6).
 *
 * `status` is the verdict; `verifierId`/`verifierVersion` identify the judge;
 * `evidenceHash` binds the verdict to the evidence it judged (deliverable
 * hash, test output digest, ...); `checks` carries the per-check detail so
 * "partial pass" stays observable instead of collapsing into the verdict.
 * `implicit: true` marks the deterministic structural derivation (no external
 * verifier ran) - see {@link verificationFromTrajectory}.
 */
export interface TrustedVerification {
  readonly status: TrustedVerificationStatus;
  readonly verifierId: string;
  readonly verifierVersion: string;
  readonly evidenceHash: string;
  readonly checks: readonly { readonly id: string; readonly passed: boolean }[];
  /** True when derived structurally (no external verifier), not by a trusted judge. */
  readonly implicit?: boolean;
}

/** verifierId of the deterministic structural fallback derivation. */
export const STRUCTURAL_VERIFIER_ID = 'structural-derivation' as const;
/** verifierVersion of the deterministic structural fallback derivation. */
export const STRUCTURAL_VERIFIER_VERSION = 'v1' as const;

/** Completion signal: a TRUSTED verifier accepted the task result (F3). */
export const COMPLETION_SIGNAL = 1;
/** Completion signal: the run claimed success but produced no deliverable. */
export const MISSING_DELIVERABLE_SIGNAL = -1;
/** Completion signal: a trusted verifier REFUTED the task result (F3). */
export const VERIFICATION_FAILED_SIGNAL = -1;

/**
 * Structural, fail-closed validation of a verification payload.
 *
 * A payload may claim 'passed' only with the complete shape (status in the
 * three-value set, non-empty verifier identity, evidence hash, and a checks
 * list whose entries carry an id and a boolean verdict). Anything else - a
 * string, a partial object, a payload with an unknown status - is rejected,
 * which the caller interprets as "no trusted verification present".
 */
export function isTrustedVerification(
  value: unknown
): value is TrustedVerification {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    record['status'] !== 'passed' &&
    record['status'] !== 'failed' &&
    record['status'] !== 'unknown'
  ) {
    return false;
  }
  for (const field of ['verifierId', 'verifierVersion', 'evidenceHash'] as const) {
    const entry = record[field];
    if (typeof entry !== 'string' || entry.length === 0) {
      return false;
    }
  }
  if (!Array.isArray(record['checks'])) {
    return false;
  }
  for (const check of record['checks']) {
    if (check === null || typeof check !== 'object') {
      return false;
    }
    const entry = check as Record<string, unknown>;
    if (typeof entry['id'] !== 'string' || entry['id'].length === 0) {
      return false;
    }
    if (typeof entry['passed'] !== 'boolean') {
      return false;
    }
  }
  return true;
}

/** Read a trusted verification a host attached to trajectory metadata, if any. */
export function readTrustedVerification(
  trajectory: ProbeTrajectory
): TrustedVerification | undefined {
  const metadata = trajectory.metadata as Record<string, unknown> | undefined;
  const candidate = metadata === undefined ? undefined : metadata['verification'];
  return isTrustedVerification(candidate) ? candidate : undefined;
}

/**
 * Derive the verification verdict from the trajectory alone (no model).
 *
 * Deliberately conservative:
 *   - 'failed' ONLY for the structurally disprovable case: the run claims
 *     `succeeded` while producing no deliverable at all (the pre-existing
 *     claimed-success-without-evidence case);
 *   - 'unknown' for everything else - including every successful run with a
 *     deliverable, because content presence proves nothing about correctness.
 *   - never 'passed': without a trusted verifier, task success is not provable.
 */
export function deriveStructuralVerification(
  trajectory: ProbeTrajectory
): TrustedVerification {
  const claimedSuccessWithoutDeliverable =
    trajectory.status === 'succeeded' &&
    (trajectory.deliverable === undefined || trajectory.deliverable.content.length === 0);
  return {
    status: claimedSuccessWithoutDeliverable ? 'failed' : 'unknown',
    verifierId: STRUCTURAL_VERIFIER_ID,
    verifierVersion: STRUCTURAL_VERIFIER_VERSION,
    evidenceHash: trajectory.deliverable?.contentHash ?? '',
    checks: [
      {
        id: 'deliverable-present',
        passed: !claimedSuccessWithoutDeliverable
      }
    ],
    implicit: true
  };
}

/**
 * THE verification resolution rule (F3): an explicitly attached trusted
 * verification wins; otherwise the structural fallback decides.
 *
 * One guard: a trusted 'passed' attached to a run whose execution FAILED is a
 * contradiction (the verification cannot have accepted a result that never
 * completed), so it degrades to 'unknown' rather than rewarding the claim.
 */
export function verificationFromTrajectory(
  trajectory: ProbeTrajectory
): TrustedVerification {
  const explicit = readTrustedVerification(trajectory);
  if (explicit !== undefined) {
    if (explicit.status === 'passed' && trajectory.status !== 'succeeded') {
      return { ...explicit, status: 'unknown' };
    }
    return explicit;
  }
  return deriveStructuralVerification(trajectory);
}

/** One deterministic, verifiable score for a trajectory that has no step list. */
export interface TrajectorySignalScore {
  readonly outcome: ExperienceOutcome;
  /**
   * Outcome-level learning eligibility (the pre-existing, frozen semantics the
   * research/eval paths consume): false for cancelled/aborted/infrastructure
   * outcomes and falsified success claims. NOT the C2-pre task-quality gate -
   * see {@link taskQualityLearningEligible}.
   */
  readonly learningEligible: boolean;
  /** Fused reward from the verifiable signals only (clipped). */
  readonly reward: number;
  readonly sources: Readonly<Record<string, number>>;
  readonly rationale: string;
  /** Execution success: the run itself completed (status 'succeeded'). */
  readonly executionSuccess: boolean;
  /**
   * Task success: the verification verdict says 'passed'. C2-pre (ADR 0002
   * 5.2a-1) this means "the payload CLAIMS passed" - without a registered
   * trusted producer it must NOT be consumed as trusted task success.
   */
  readonly taskSuccess: boolean;
  /** The resolved verification verdict and who produced it. */
  readonly verification: {
    readonly status: TrustedVerificationStatus;
    readonly verifierId: string;
    readonly implicit: boolean;
    /**
     * C2-pre (5.2a): true when the verdict carries trusted provenance
     * (registered producer + evidence hash). The production path cannot
     * produce this until C2 registers a real verifier, so every verdict the
     * default assembly sees is shape-only (trustedSource: false).
     */
    readonly trustedSource: boolean;
  };
  /**
   * C2-pre task-quality learning gate (ADR 0002 5.2a-2/3/4, t6 revision):
   * whether this trajectory's fused reward may be consumed as a TASK-QUALITY
   * training sample. Two tracks, pinned separately:
   *   - a verdict-derived completion source (shape-only passed +1 / failed -1)
   *     is task-quality evidence; without trusted provenance it is NOT
   *     learnable (audit-only: the scale-level negative signal stays in the
   *     reward column, but trusted-failure learning is the explicit C2
   *     unfinished item - no provenance is forged);
   *   - an 'unknown' verdict contributes completion=0, so the fused value
   *     carries NO task-quality component; such a trajectory trains through
   *     the pre-existing non-verification (process) eligibility path exactly
   *     as before (ADR 0002 R4 net effect: "学习面上实际可用的只有非验证来
   *     源的既有资格路径"). This keeps the frozen research/ablation path
   *     additive (R6).
   * The online recorder consults these flags instead of re-deriving the rule.
   */
  readonly taskQualityLearningEligible: boolean;
  /**
   * t10/V3b (t9 finding): TRUE-ONLY task-quality evidence flag, kept beside the
   * eligibility flag so the two can never be conflated again.
   *
   * `taskQualityEvidence` is the verdict-side FACT: true ONLY when a trusted
   * source produced a verdict-derived completion (trustedSource && passed/
   * failed). unknown/untrusted verdicts are ALWAYS false - an unknown verdict
   * contributes no task-quality component (completion=0), and the old
   * "eligible && !verdictDerived" shape made this field read as an eligibility
   * grant when it was really the absence of a task-quality component.
   *
   * `taskQualityLearningEligible` (above) remains the CONSUMPTION gate: it is
   * true when the record may be trained on (the process path for unknown
   * verdicts) and false only for non-learnable executions and untrusted
   * verdict-derived completions. Consumers that want "is this record task
   * quality evidence" must read `taskQualityEvidence`, never the eligibility
   * flag; the consistency invariant (process track ⇒ NOT task-quality
   * evidence) is asserted by the production regression.
   */
  readonly taskQualityEvidence: boolean;
}

/**
 * Default weights for the verifiable-signal fusion. `completion` and `steps`
 * are additive source names on top of the frozen llm/surrogate/tool/turn/user
 * set, so a caller can override them without touching the config contract.
 */
export const VERIFIABLE_SIGNAL_WEIGHTS: Readonly<Record<string, number>> = {
  completion: 0.5,
  steps: 0.2,
  tool: 0.2,
  turn: 0.1
};

/**
 * Fuse verifiable signals into one clipped reward. Structurally identical to
 * combineStepRewards but over an open weight record, because the completion and
 * steps sources are not part of the frozen JitRlRewardWeightsConfig.
 */
export function fuseVerifiableSignals(
  sources: Readonly<Record<string, number>>,
  weights: Readonly<Record<string, number>> = VERIFIABLE_SIGNAL_WEIGHTS,
  clip: readonly [number, number] = [-3, 3]
): number {
  let total = 0;
  for (const [name, value] of Object.entries(sources)) {
    const weight = weights[name];
    if (weight === undefined || !Number.isFinite(weight) || !Number.isFinite(value)) {
      continue;
    }
    total += weight * value;
  }
  const min = Number.isFinite(clip[0]) ? clip[0] : -3;
  const max = Number.isFinite(clip[1]) ? clip[1] : 3;
  return Math.min(max, Math.max(min, total));
}

/**
 * Deterministic fallback scoring for a trajectory the step evaluator could not
 * break into steps (for example a failed run with zero recorded steps). Only
 * verifiable signals are used, so a failed action still gets an explainable
 * negative record instead of disappearing (plan section 6.2).
 *
 * P6.2 PR-B / F3: the completion source is now VERIFIER-DECIDED (see
 * {@link verificationFromTrajectory}). A non-empty deliverable alone no longer
 * earns +1 - only a trusted verification 'passed' does, and a 'failed'
 * verification lexicographically clamps the fused reward to <= 0 so tool
 * smoothness can never buy back a positive score.
 */
export function scoreTrajectorySignals(
  trajectory: ProbeTrajectory,
  options: {
    readonly weights?: Readonly<Record<string, number>>;
    readonly clip?: readonly [number, number];
    readonly stepBudget?: number;
    readonly cancelled?: boolean;
    /** Optional host user feedback, kept a SEPARATE source (F3: 分列). */
    readonly user?: UserFeedbackKind;
    /**
     * t10/COV (t9 finding): the INJECTABLE trusted-producer seam (C2's
     * eventual binding point; test/research callers only this round). This is
     * a caller-supplied SET OBJECT - not a global string registrar - so trust
     * is scoped to the caller that owns the set, and no importing module can
     * widen another caller's trust. The production wiring (scoreUnderRewardContract
     * and the online recorder) passes NOTHING, which keeps the effective
     * registry empty (C2-pre). A C2 implementation will replace this seam with
     * the trusted service/receipt boundary; the parameter shape (a set of
     * producer ids bound to evidence-hash checks) is what it will fill.
     */
    readonly trustedProducers?: ReadonlySet<string>;
  } = {}
): TrajectorySignalScore {
  const outcome = classifyTrajectoryOutcome(trajectory, {
    ...(options.cancelled === undefined ? {} : { cancelled: options.cancelled })
  });
  const verification = verificationFromTrajectory(trajectory);
  // F3: a trusted verification that REFUTED the task result while the run
  // claims success is a falsified success claim: the record keeps its
  // execution-level signals (it still says something about tool usage), but it
  // must not train the policy as a positive task experience. A cancelled /
  // aborted / infrastructure run was already ineligible.
  const falsifiedSuccessClaim =
    verification.status === 'failed' && trajectory.status === 'succeeded';
  const eligible = isLearningOutcome(outcome) && !falsifiedSuccessClaim;
  const weights = options.weights ?? { tool: 0.2, turn: 0.1 };
  const clip = options.clip ?? [-3, 3];
  const sources: Record<string, number> = {};
  // Tool status and repeated errors, counted exactly like the step path.
  const seen = new Set<string>();
  for (const error of trajectory.toolErrors) {
    const identity = error.toolName + '|' + error.message;
    sources.tool = (sources.tool ?? 0) + (seen.has(identity) ? TOOL_REPEATED_ERROR_SIGNAL : TOOL_ERROR_SIGNAL);
    seen.add(identity);
  }
  const toolCalls = trajectory.metrics.toolCalls;
  const toolErrors = Math.max(trajectory.metrics.toolErrors, trajectory.toolErrors.length);
  const successfulCalls = Math.max(0, toolCalls - toolErrors);
  if (successfulCalls > 0) {
    sources.tool = (sources.tool ?? 0) + TOOL_SUCCESS_SIGNAL * successfulCalls;
  }
  // F3 completion: the VERDICT decides, not content presence. 'unknown' earns
  // no completion signal at all (the run is a process observation); 'failed'
  // earns -1; only 'passed' earns +1. The claimed-success-without-deliverable
  // case is carried by the structural fallback as 'failed'.
  if (verification.status === 'passed') {
    sources.completion = COMPLETION_SIGNAL;
  } else if (verification.status === 'failed') {
    sources.completion = VERIFICATION_FAILED_SIGNAL;
  } else if (trajectory.status === 'succeeded') {
    // Explicit trusted 'failed' maps above; the structural fallback already
    // marks claimed-success-without-deliverable as failed. An 'unknown'
    // verification on a succeeded run with NO deliverable still deserves the
    // historical missing-deliverable penalty: the run produced nothing.
    sources.completion =
      trajectory.deliverable === undefined || trajectory.deliverable.content.length === 0
        ? MISSING_DELIVERABLE_SIGNAL
        : 0;
  }
  // Step count against a budget, as a cheap efficiency signal in [-1, 1].
  const budget = Math.max(1, options.stepBudget ?? DEFAULT_STEP_BUDGET);
  const steps = Math.max(0, trajectory.metrics.steps);
  sources.steps = steps === 0 ? 0 : 1 - 2 * Math.min(1, steps / budget);
  sources.turn = turnSignalForOutcome(outcome);
  // F3 分列: user adoption is its own source, never folded into completion or
  // tool. Execution cost is already carried separately by the `steps` budget
  // term and trajectory.metrics (durationMs/tokens), not as a quality source.
  if (options.user !== undefined) {
    sources.user = userSignal(options.user);
  }
  // The fused value only uses weighted sources; unknown names contribute 0, so
  // a caller with the frozen llm/surrogate/tool/turn/user weights still works.
  let reward = eligible ? fuseVerifiableSignals(sources, weights, clip) : 0;
  // F3 lexicographic quality constraint: a FAILED verification is a quality
  // gate violation, and no amount of efficiency (fewer steps, clean tools)
  // may compensate it. The reward is clamped to <= 0 - the run cannot record a
  // positive success experience on the shared scale.
  if (verification.status === 'failed' && eligible && reward > 0) {
    reward = 0;
  }
  // C2-pre trusted-source boundary (ADR 0002 5.2a, t6): the production path
  // carries only shape-validated payloads, so trustedSource is false unless a
  // REGISTERED trusted producer signed the verdict (C2's entry point). Shape
  // alone never proves the source.
  //
  // t8/V5b: the provenance judgement is BOUND to the execution evidence - the
  // payload's evidenceHash must match the trajectory deliverable's own
  // contentHash when one exists. A verdict claiming an unbound (or foreign)
  // hash establishes nothing even from a registered producer; C2 inherits this
  // binding instead of trusting a self-declared string.
  const executionEvidenceHash =
    trajectory.deliverable !== undefined && trajectory.deliverable.content.length > 0
      ? trajectory.deliverable.contentHash
      : undefined;
  const trustedSource = hasTrustedVerificationProvenance(
    verification,
    executionEvidenceHash,
    options.trustedProducers
  );
  // C2-pre task-quality gate (5.2a-2/3/4): a verdict-derived completion source
  // (shape-only passed/failed) is task-quality evidence but is NOT learnable
  // without trusted provenance - it stays audit-only (trusted-failure learning
  // is the explicit C2 unfinished item, no provenance is forged). An 'unknown'
  // verdict contributes completion=0, so the fused value carries no task
  // quality at all and the record trains through the pre-existing process
  // eligibility path unchanged (R4 net effect; keeps the frozen research path
  // additive, R6).
  const verdictDerivedCompletion =
    verification.status === 'passed' || verification.status === 'failed';
  // Consumption gate: trainability of the record's fused reward. The process
  // path keeps unknown-verdict records trainable (completion=0); a
  // verdict-derived completion is trainable ONLY from a trusted source (C2-pre
  // the production path never has one).
  const taskQualityLearningEligible = eligible && (!verdictDerivedCompletion || trustedSource);
  // t10/V3b: the verdict-side FACT, true only for trusted verdict-derived
  // completions. Unknown/untrusted verdicts are ALWAYS false - the field can
  // never be read as an eligibility grant again.
  const taskQualityEvidence = eligible && verdictDerivedCompletion && trustedSource;
  return {
    outcome,
    learningEligible: eligible,
    reward,
    sources,
    rationale:
      'verifiable signals only (' +
      Object.keys(sources).join('+') +
      '); outcome ' +
      outcome +
      '; verification ' +
      verification.status +
      (verification.implicit === true ? ' (structural)' : ' by ' + verification.verifierId) +
      (trustedSource ? '' : ' (shape-only, C2-pre)') +
      (eligible ? '' : '; not learning eligible') +
      (eligible && !taskQualityLearningEligible
        ? '; verdict-derived completion not task-quality eligible (C2-pre)'
        : ''),
    executionSuccess: trajectory.status === 'succeeded',
    taskSuccess: verification.status === 'passed',
    verification: {
      status: verification.status,
      verifierId: verification.verifierId,
      implicit: verification.implicit === true,
      trustedSource
    },
    taskQualityLearningEligible,
    taskQualityEvidence
  };
}

/**
 * Create the fused multi-signal step evaluator. One LLM judge call is made
 * per evaluation at most, only when the cost gate passes, the reward config
 * enables it and a model adapter is injected. Every failure degrades to the
 * deterministic low-cost path with a diagnostic.
 */
export function createStepEvaluator(options: StepEvaluatorOptions): JitStepEvaluator {
  const privacy = options.privacy ?? DEFAULT_EVALUATOR_PRIVACY;
  const meteredModel =
    options.model === undefined
      ? undefined
      : createMeteredModelAdapter(options.model, 'evaluate_steps', options.metering);
  const diagnostics: string[] = [];
  // clock/rng are accepted for injection symmetry; v1 outputs never read them.
  void options.clock;
  void options.rng;

  async function evaluateSteps(input: StepEvaluationInput): Promise<readonly StepReward[]> {
    const steps = [...input.trajectory.steps].sort((a, b) => a.index - b.index);
    if (steps.length === 0) {
      return [];
    }
    const weights = options.reward.weights;
    const clip = options.reward.clip;
    const candidateSv = options.surrogate?.(input.trajectory, input.reference);
    const referenceSv = input.reference === undefined ? undefined : options.surrogate?.(input.reference);
    const deltaGate =
      candidateSv !== undefined &&
      referenceSv !== undefined &&
      Math.abs(candidateSv - referenceSv) > SURROGATE_DELTA_GATE;
    const gate =
      steps.length >= MIN_STEPS_FOR_LLM_JUDGE || input.selected === true || input.composed === true || deltaGate;
    const llmAvailable = options.reward.llmEvaluator && options.model !== undefined;

    let judge: JudgeOutcome = { ok: false, scores: new Map<number, number>() };
    if (gate && llmAvailable && options.model !== undefined && meteredModel !== undefined) {
      try {
        const response = await meteredModel.call({
          purpose: 'evaluate_steps',
          messages: [{ role: 'user', content: buildJudgePrompt(input, privacy) }],
          temperature: 0,
          responseFormat: 'json'
        });
        judge = parseJudgeJson(response.text);
        if (!judge.ok) {
          diagnostics.push('llm_judge: malformed JSON; neutral fallback applied');
        }
      } catch (error) {
        diagnostics.push('llm_judge_failed: ' + (error instanceof Error ? error.name : 'unknown'));
      }
    }
    const judgeRan = gate && llmAvailable && judge.ok;

    const seenToolErrors = new Set<string>();
    const lastPosition = steps.length - 1;
    const rewards = steps.map((step, position) => {
      const sources: Record<string, number> = { evaluated: judgeRan ? 1 : 0 };
      if (step.kind === 'tool') {
        const identity = toolErrorIdentity(step, input.trajectory);
        if (identity === undefined) {
          sources.tool = TOOL_SUCCESS_SIGNAL;
        } else if (seenToolErrors.has(identity)) {
          sources.tool = TOOL_REPEATED_ERROR_SIGNAL;
        } else {
          sources.tool = TOOL_ERROR_SIGNAL;
          seenToolErrors.add(identity);
        }
      }
      if (position === lastPosition) {
        sources.turn = turnSignalForStatus(input.trajectory.status);
        if (candidateSv !== undefined) {
          sources.surrogate = surrogateSignal(candidateSv);
        }
        if (input.user !== undefined) {
          sources.user = userSignal(input.user);
        }
      }
      if (judgeRan) {
        sources.llm = judge.scores.get(step.index) ?? 0;
      }
      return {
        stepIndex: step.index,
        reward: combineStepRewards(sources, weights, clip),
        sources,
        rationale: rationaleFor(sources)
      };
    });
    return rewards;
  }

  return {
    evaluate: (trajectory, context) =>
      evaluateSteps({ trajectory, task: context.task, reference: context.reference }),
    evaluateSteps,
    diagnostics: () => [...diagnostics]
  };
}