/**
 * rev5 P2-2: a text-only probe is NOT EVALUABLE by this harness, and says so.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The Gate-4 rows that promise task benefit (`9.4-3`) need an executable
 * observable: a build that can be rebuilt, a test that can be run, a command
 * whose exit code means something. A probe whose deliverable is prose ("explain
 * the design", "summarise the diff") has no such observable, so any score the
 * harness computed for it would be a judgment call dressed up as a measurement.
 *
 * The honest answer is a FIRST-CLASS third state: `not-evaluable`, with a stable
 * reason code. This module is deliberately TOTAL and MONOTONE:
 *   - it never throws (a caller cannot mistake an exception for an evaluation);
 *   - it never returns a score, a reward or a `passed` flag — the type has none,
 *     so a "text probe passed" cannot be constructed from this module at all;
 *   - it reports what it saw (`executableDeliverables`, `textDeliverables`) so a
 *     reader can check the classification instead of trusting it.
 *
 * The `not-evaluable` state is NOT a failure and MUST NOT be counted as one:
 * treating it as a failure would bias the offline dreamer against text tasks,
 * which is the opposite of the honesty this state buys. Consumers map it to
 * "no signal", never to a failure.
 *
 * rev6 audit A4-3: the MAIN scoring chain now calls
 * {@link classifyProbeEvaluability}. `ExperienceRecord.reward` must stay a
 * finite number, so the recorder persists `reward: 0` together with the
 * explicit `rewardSources.notEvaluable: 1` marker and the numeric reason code,
 * `learningEligible: false`, and `learningTarget: 0`. A reader can therefore
 * always distinguish "not measured" from "measured as zero"; no unknown sample
 * enters the learning set.
 */

import type { ProbeTrajectory } from '../types/contracts';
import type { TrustedVerificationStatus } from './step-evaluator';

/** Stable reason codes; a caller may branch on these but should not string-match prose. */
export const TEXT_PROBE_REASONS = [
  /** The probe declared no deliverable this harness can execute. */
  'no-executable-deliverable',
  /** The probe declared deliverables, but every one of them is text. */
  'text-only-deliverables',
  /**
   * rev6 audit A4-3: the probe produced an executable artifact (producedFiles),
   * but no host-trusted verifier exists to judge it. The harness must not
   * pretend it measured task quality on an unverified artifact.
   */
  'no-trusted-verifier',
  /** The caller asked for an evaluation of something that is not a probe. */
  'invalid-probe'
] as const;
export type TextProbeReason = (typeof TEXT_PROBE_REASONS)[number];

/**
 * Stable NUMERIC code for a reason. `ExperienceRecord.rewardSources` is a
 * numeric bag (the frozen contract), so a persisted "this record was not
 * evaluable" mark must not smuggle prose into it. The mapping is append-only:
 * existing values never move, so an old record stays readable.
 */
export const TEXT_PROBE_REASON_CODES: Readonly<Record<TextProbeReason, number>> = {
  'text-only-deliverables': 1,
  'no-executable-deliverable': 2,
  'no-trusted-verifier': 3,
  'invalid-probe': 4
};

/** Numeric code for one reason (total; unknown input maps to 0). */
export function textProbeReasonCode(reason: TextProbeReason | undefined): number {
  if (reason === undefined) {
    return 0;
  }
  const code = TEXT_PROBE_REASON_CODES[reason];
  return code === undefined ? 0 : code;
}

/** The single status this evaluator can produce. */
export type TextProbeStatus = 'not-evaluable';

/** What the evaluator observed about the probe's deliverables. */
export interface TextProbeObservation {
  readonly executableDeliverables: number;
  readonly textDeliverables: number;
  /** True when the probe declared at least one non-empty prompt. */
  readonly hasPrompt: boolean;
}

/** The evaluation result. There is no score or pass flag, and reward is the literal 0 (never positive) by design. */
export interface TextProbeEvaluation {
  readonly status: TextProbeStatus;
  readonly evaluable: false;
  readonly reason: TextProbeReason;
  /** One human-readable sentence that names the missing observable. */
  readonly detail: string;
  /** What was observed, so the classification is checkable. */
  readonly observed: TextProbeObservation;
  /** Always 0: no reward may be derived from a not-evaluable probe. */
  readonly reward: 0;
}

/** Structural input: anything a probe-like object might carry. */
export interface TextProbeInput {
  readonly prompt?: unknown;
  readonly task?: unknown;
  /** Explicit executable deliverables (commands, tests, artifacts). */
  readonly executableDeliverables?: readonly unknown[];
  /** Explicit text deliverables (documents, explanations). */
  readonly textDeliverables?: readonly unknown[];
}

function countDeliverables(value: readonly unknown[] | undefined): number {
  if (!Array.isArray(value)) {
    return 0;
  }
  return value.filter((entry) => typeof entry === 'string' ? entry.trim().length > 0 : entry !== null && entry !== undefined).length;
}

/**
 * Evaluate a text-only probe. Total: every input produces a `not-evaluable`
 * result, including `undefined`.
 */
export function evaluateTextProbe(input?: TextProbeInput | null): TextProbeEvaluation {
  const probe = input === null || typeof input !== 'object' ? {} : input;
  const prompt = (probe as TextProbeInput).prompt;
  const task = (probe as TextProbeInput).task;
  const executableDeliverables = countDeliverables((probe as TextProbeInput).executableDeliverables);
  const textDeliverables = countDeliverables((probe as TextProbeInput).textDeliverables);
  const hasPrompt =
    (typeof prompt === 'string' && prompt.trim().length > 0) ||
    (task !== null && typeof task === 'object');

  const observed: TextProbeObservation = { executableDeliverables, textDeliverables, hasPrompt };
  const base = { status: 'not-evaluable' as const, evaluable: false as const, observed, reward: 0 as const };

  if (!hasPrompt) {
    return {
      ...base,
      reason: 'invalid-probe',
      detail: 'the input carries neither a prompt nor a task, so there is nothing to evaluate'
    };
  }
  if (executableDeliverables === 0 && textDeliverables > 0) {
    return {
      ...base,
      reason: 'text-only-deliverables',
      detail:
        'every declared deliverable is text; this harness can only score executable observables, so the probe is not evaluable'
    };
  }
  return {
    ...base,
    reason: 'no-executable-deliverable',
    detail:
      'no executable deliverable was declared; a task-benefit score would be a judgment call, so the probe is not evaluable'
  };
}

/**
 * What the MAIN scoring chain observed about one executed trajectory.
 *
 * Deliberately mirrors the fields the recorder already has (`evaluation` from
 * `scoreUnderRewardContract`), so the classifier never re-derives a verdict.
 */
export interface ProbeEvaluabilityObservation {
  /** Files the probe actually produced (an executable/checkable artifact). */
  readonly executableDeliverables: number;
  /** 1 when the probe produced non-empty text, 0 otherwise. */
  readonly textDeliverables: number;
  readonly hasDeliverable: boolean;
}

/** The main-chain classification: `evaluated` or an explicit `not-evaluable`. */
export interface ProbeEvaluability {
  readonly status: 'evaluated' | 'not-evaluable';
  readonly evaluable: boolean;
  /** Present only for `not-evaluable`; never a failure reason. */
  readonly reason?: TextProbeReason;
  /** Human-readable sentence naming the observable (or its absence). */
  readonly detail: string;
  readonly observed: ProbeEvaluabilityObservation;
  /** True only when the verdict came from host-trusted provenance. */
  readonly trusted: boolean;
  readonly verificationStatus: TrustedVerificationStatus;
}

/** Structural input for {@link classifyProbeEvaluability}. */
export interface ProbeEvaluabilityInput {
  readonly trajectory: ProbeTrajectory;
  readonly verification: {
    readonly status: TrustedVerificationStatus;
    /** `evaluation.verification.trustedSource` (host receipt + producer + hash). */
    readonly trustedSource: boolean;
    /** `evaluation.verification.implicit` (structural derivation, no verifier). */
    readonly implicit: boolean;
  };
}

/**
 * rev6 audit A4-3 (B6): classify one MAIN-CHAIN probe as evaluable or not.
 *
 * WHY THIS EXISTS ON THE MAIN PATH
 * --------------------------------
 * `evaluateTextProbe` above is an honest verdict, but before A4-3 it was only
 * reachable through the plugin handle. The recorder kept scoring prose as a
 * process sample, so the same run could claim "text probes are not evaluable"
 * in one API and still let an unverified text deliverable train L2 through
 * another. This classifier is the single main-chain decision.
 *
 * THE RULE (fail-closed, and never a failure verdict):
 *   1. a host-TRUSTED `passed`/`failed` verdict => `evaluated`. The verdict is
 *      the observable; it also covers a trusted failure, which is real evidence.
 *   2. the STRUCTURAL fallback's `failed` (claimed success with no deliverable)
 *      => `evaluated`. It is a deterministic refutation that needs no runner.
 *   3. an executable artifact (`producedFiles` > 0) with no trusted verdict =>
 *      `not-evaluable` / `no-trusted-verifier`: the harness cannot judge the
 *      artifact, so it must not pretend it did.
 *   4. text-only content with no trusted verdict => `not-evaluable` /
 *      `text-only-deliverables`; no content at all => `no-executable-deliverable`.
 *
 * `not-evaluable` is NOT a failure: consumers map it to reward/learningTarget 0
 * and `learningEligible: false`, never to a negative score.
 */
export function classifyProbeEvaluability(input: ProbeEvaluabilityInput): ProbeEvaluability {
  const trajectory = input.trajectory;
  const deliverable = trajectory.deliverable;
  const producedFiles = Array.isArray(deliverable?.producedFiles)
    ? deliverable.producedFiles.filter((entry) => typeof entry === 'string' && entry.trim().length > 0).length
    : 0;
  const hasContent =
    deliverable !== undefined && typeof deliverable.content === 'string' && deliverable.content.trim().length > 0;
  const observed: ProbeEvaluabilityObservation = {
    executableDeliverables: producedFiles,
    textDeliverables: hasContent ? 1 : 0,
    hasDeliverable: deliverable !== undefined
  };
  const verification = input.verification;
  const trusted = verification.trustedSource === true &&
    (verification.status === 'passed' || verification.status === 'failed');
  const base = {
    observed,
    trusted,
    verificationStatus: verification.status
  } as const;
  if (trusted) {
    return {
      ...base,
      status: 'evaluated',
      evaluable: true,
      detail:
        'a host-trusted verdict (' +
        verification.status +
        ') is the observable, so the probe is evaluable'
    };
  }
  if (verification.implicit === true && verification.status === 'failed') {
    return {
      ...base,
      status: 'evaluated',
      evaluable: true,
      detail:
        'the structural fallback deterministically refuted the claimed success (no deliverable), which is evidence enough to evaluate'
    };
  }
  if (producedFiles > 0) {
    return {
      ...base,
      status: 'not-evaluable',
      evaluable: false,
      reason: 'no-trusted-verifier',
      detail:
        'the probe produced an executable artifact, but no host-trusted verifier exists to judge it; the harness cannot claim it measured task quality'
    };
  }
  if (hasContent) {
    return {
      ...base,
      status: 'not-evaluable',
      evaluable: false,
      reason: 'text-only-deliverables',
      detail:
        'every deliverable is text and no host-trusted verdict exists; the harness can only score executable observables'
    };
  }
  return {
    ...base,
    status: 'not-evaluable',
    evaluable: false,
    reason: 'no-executable-deliverable',
    detail:
      'no executable deliverable and no host-trusted verdict exist; a task-benefit score would be a judgment call'
  };
}

/**
 * True only for a result this module could produce; a guard for callers that
 * receive a plain object from a plugin boundary.
 */
export function isNotEvaluable(value: unknown): value is TextProbeEvaluation {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as { status?: unknown; evaluable?: unknown; reward?: unknown };
  return record.status === 'not-evaluable' && record.evaluable === false && record.reward === 0;
}
