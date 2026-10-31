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
 * "no signal", never to reward 0.
 */

/** Stable reason codes; a caller may branch on these but should not string-match prose. */
export const TEXT_PROBE_REASONS = [
  /** The probe declared no deliverable this harness can execute. */
  'no-executable-deliverable',
  /** The probe declared deliverables, but every one of them is text. */
  'text-only-deliverables',
  /** The caller asked for an evaluation of something that is not a probe. */
  'invalid-probe'
] as const;
export type TextProbeReason = (typeof TEXT_PROBE_REASONS)[number];

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
