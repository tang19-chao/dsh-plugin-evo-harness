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
  type IModelAdapter,
  type IStepEvaluator,
  type ModelRequest,
  type ProbeTask,
  type ProbeTrajectory,
  type StepReward,
  type TrajectoryStatus,
  type TrajectoryStep
} from '../types/contracts';
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

/**
 * Create the fused multi-signal step evaluator. One LLM judge call is made
 * per evaluation at most, only when the cost gate passes, the reward config
 * enables it and a model adapter is injected. Every failure degrades to the
 * deterministic low-cost path with a diagnostic.
 */
export function createStepEvaluator(options: StepEvaluatorOptions): JitStepEvaluator {
  const privacy = options.privacy ?? DEFAULT_EVALUATOR_PRIVACY;
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
    if (gate && llmAvailable && options.model !== undefined) {
      try {
        const response = await options.model.complete({
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