/**
 * JitRL closed-form logit adjuster and decision composition (plan section 6.4).
 *
 * Ownership: src/jitrl/** (Phase 1 kernel, P1-3).
 *
 * The KL-regularised objective
 *
 *   max_pi' E_{a ~ pi'}[A(s, a)] - (1 / beta) KL(pi' || pi_prior)
 *
 * has the analytic solution pi'(a|s) proportional to pi_prior(a|s) *
 * exp(beta * A(s, a)), which in logit space is the additive correction
 *
 *   z'(s, a) = z(s, a) + beta * A-tilde(s, a).
 *
 * Section 6.4 requires one engineering guard: the prior logit scale produced by
 * the logit sources may not match beta * A-tilde in [-beta, beta], so the base
 * logits are centred per decision before the correction. Centring leaves the
 * softmax unchanged, so this only makes the reported z' and KL comparable across
 * decisions. KL(pi' || pi_prior) is returned as a diagnostic; it is 0 when all
 * advantages are 0, and grows with beta.
 *
 * Empty neighbourhoods are a supported cold-start state, never an error:
 * V = 0, every A-tilde = 0, so the chosen action equals the prior argmax and
 * klToPrior is 0. Invalid numeric inputs and empty candidate sets are rejected.
 */

import { DEFAULT_EVO_HARNESS_CONFIG } from '../config';
import type {
  AbstractState,
  ExperienceRecord,
  GuidanceMode,
  JitAdjustment,
  JitCandidate,
  JitDecision,
  JitLevel,
  ScoredExperience
} from '../types/contracts';
import { retrieveNeighbors } from './retriever';
import {
  ADVANTAGE_EPSILON,
  estimateActionValues,
  estimateStateValue,
  normalizeAdvantages,
  selectNeighbors,
  type ValueEstimatorConfig
} from './value-estimator';

/** Kernel defaults mirror the frozen plugin config; callers should pass config values. */
const JIT_DEFAULTS = DEFAULT_EVO_HARNESS_CONFIG.jitrl;

/** Composition knobs shared by decide() and composeDecision(). */
export interface ComposeOptions {
  /** KL temperature multiplying the normalized advantage (config `jitrl.beta`). */
  readonly beta?: number;
  /** argmax (deterministic default) or sample from softmax(z'). */
  readonly selection?: 'argmax' | 'sample';
  /** Exploration probability for unsupported actions. */
  readonly lambda?: number;
  /** Exploration bonus scale. */
  readonly alpha?: number;
  /** Unsupported-action value policy. */
  readonly unseenFallback?: 'zero' | 'baseline';
  /** Injected randomness; required to be deterministic in tests. */
  readonly rng?: () => number;
}

/** Options for decide(); add either a record snapshot or pre-scored neighbours. */
export interface DecideOptions extends ComposeOptions {
  /** Raw experience snapshot; retrieval runs inside decide(). */
  readonly experiences?: readonly ExperienceRecord[];
  /** Already-scored neighbours (e.g. from a store query); skips retrieval. */
  readonly neighbors?: readonly ScoredExperience[];
  /** Retrieval overrides; default to the frozen plugin configuration. */
  readonly k?: number;
  readonly similarityThreshold?: number;
  readonly level?: JitLevel;
  readonly guidanceFilter?: GuidanceMode;
  readonly before?: number;
  readonly now?: number;
  readonly halfLifeMs?: number;
}

/**
 * Numerically stable softmax. Non-finite logits are rejected: +Infinity would
 * produce NaN and -Infinity a degenerate distribution, both hiding caller bugs.
 */
export function softmax(logits: readonly number[]): readonly number[] {
  if (logits.length === 0) {
    return [];
  }
  let max = -Infinity;
  for (const logit of logits) {
    if (!Number.isFinite(logit)) {
      throw new RangeError('softmax: logits must be finite numbers');
    }
    if (logit > max) {
      max = logit;
    }
  }
  const exponentials: number[] = [];
  let total = 0;
  for (const logit of logits) {
    const value = Math.exp(logit - max);
    exponentials.push(value);
    total += value;
  }
  if (!(total > 0) || !Number.isFinite(total)) {
    throw new RangeError('softmax: logits produced an invalid normaliser');
  }
  return exponentials.map((value) => value / total);
}

/** Subtract the per-decision mean logit; softmax is invariant to this shift. */
export function centerLogits(logits: readonly number[]): readonly number[] {
  if (logits.length === 0) {
    return [];
  }
  let total = 0;
  for (const logit of logits) {
    if (!Number.isFinite(logit)) {
      throw new RangeError('centerLogits: logits must be finite numbers');
    }
    total += logit;
  }
  const mean = total / logits.length;
  return logits.map((logit) => logit - mean);
}

/**
 * KL(actual || reference) in nats. Zero actual mass contributes nothing; a
 * positive actual mass over zero reference mass is infinite (never clamped).
 * Tiny negative values from floating-point rounding are clamped to 0.
 */
export function klDivergence(
  actual: readonly number[],
  reference: readonly number[]
): number {
  if (actual.length !== reference.length) {
    throw new RangeError('klDivergence: distributions must have the same length');
  }
  if (actual.length === 0) {
    return 0;
  }
  let divergence = 0;
  for (let index = 0; index < actual.length; index += 1) {
    const p = actual[index] as number;
    const q = reference[index] as number;
    if (!Number.isFinite(p) || !Number.isFinite(q) || p < 0 || q < 0) {
      throw new RangeError('klDivergence: probabilities must be finite and >= 0');
    }
    if (p === 0) {
      continue;
    }
    if (q === 0) {
      return Infinity;
    }
    divergence += p * Math.log(p / q);
  }
  return divergence < 0 ? 0 : divergence;
}

function validateBeta(beta: number): void {
  if (!Number.isFinite(beta) || beta < 0) {
    throw new RangeError("adjustLogits: beta must be a finite number >= 0");
  }
}

/**
 * Closed-form correction: centre the base logits per decision, normalize the
 * raw advantages (A-tilde), then return center(z) + beta * A-tilde. The result
 * is shift-invariant for softmax; it is exposed so tests and diagnostics can
 * inspect the exact kernel arithmetic.
 */
export function adjustLogits<T>(
  candidates: readonly JitCandidate<T>[],
  advantages: readonly number[],
  beta: number
): readonly number[] {
  if (candidates.length !== advantages.length) {
    throw new RangeError('adjustLogits: candidates and advantages must have the same length');
  }
  validateBeta(beta);
  const centered = centerLogits(candidates.map((candidate) => candidate.baseLogit));
  const normalized = normalizeAdvantages(advantages, ADVANTAGE_EPSILON);
  return centered.map((logit, index) => logit + beta * (normalized[index] as number));
}

/** Deterministic argmax with an ascending actionKey tie-break. */
function argmaxIndex<T>(
  candidates: readonly JitCandidate<T>[],
  values: readonly number[]
): number {
  let best = 0;
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index] as number;
    const bestValue = values[best] as number;
    if (value > bestValue) {
      best = index;
      continue;
    }
    if (
      value === bestValue &&
      (candidates[index] as JitCandidate<T>).actionKey <
        (candidates[best] as JitCandidate<T>).actionKey
    ) {
      best = index;
    }
  }
  return best;
}

/** Inverse-CDF sampling; a draw of exactly 1 selects the last candidate. */
function sampleIndex(probabilities: readonly number[], rng: () => number): number {
  const draw = rng();
  if (!Number.isFinite(draw)) {
    throw new RangeError('decide: rng() must return a finite number');
  }
  const clamped = draw <= 0 ? 0 : draw >= 1 ? 1 - Number.EPSILON : draw;
  let cumulative = 0;
  for (let index = 0; index < probabilities.length; index += 1) {
    cumulative += probabilities[index] as number;
    if (clamped < cumulative) {
      return index;
    }
  }
  return probabilities.length - 1;
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(6) : String(value);
}

/**
 * Compose a decision from already-scored neighbours: estimate V/Q/A-tilde,
 * apply the closed-form correction, then select. The pure core of decide().
 */
export function composeDecision<T>(
  level: JitLevel,
  state: AbstractState,
  neighbors: readonly ScoredExperience[],
  candidates: readonly JitCandidate<T>[],
  options: ComposeOptions = {}
): JitDecision<T> {
  if (level !== state.level) {
    throw new RangeError('decide: level must match state.level');
  }
  if (candidates.length === 0) {
    throw new RangeError('decide: candidates must not be empty');
  }
  const seenActionKeys = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate.actionKey !== 'string' || candidate.actionKey.length === 0) {
      throw new RangeError('decide: every candidate needs a non-empty actionKey');
    }
    if (seenActionKeys.has(candidate.actionKey)) {
      throw new RangeError(
        'decide: duplicate candidate actionKey ' + candidate.actionKey
      );
    }
    seenActionKeys.add(candidate.actionKey);
    if (!Number.isFinite(candidate.baseLogit)) {
      throw new RangeError(
        'decide: candidate ' + candidate.actionKey + ' has a non-finite baseLogit'
      );
    }
  }

  const beta = options.beta ?? JIT_DEFAULTS.beta;
  validateBeta(beta);
  const selection = options.selection ?? JIT_DEFAULTS.selection;
  if (selection !== 'argmax' && selection !== 'sample') {
    throw new RangeError("decide: selection must be 'argmax' or 'sample'");
  }
  const rng = options.rng ?? Math.random;
  const estimatorConfig: ValueEstimatorConfig = {
    lambda: options.lambda ?? JIT_DEFAULTS.exploration.lambda,
    alpha: options.alpha ?? JIT_DEFAULTS.exploration.alpha,
    unseenFallback: options.unseenFallback ?? JIT_DEFAULTS.unseenFallback
  };

  const selectedNeighbors = selectNeighbors(state, neighbors);
  const stateValue = estimateStateValue(selectedNeighbors);
  const estimates = estimateActionValues(
    state,
    neighbors,
    candidates,
    estimatorConfig,
    rng
  );
  const rawAdvantages = estimates.map((estimate) => estimate.advantage);
  const normalized = normalizeAdvantages(rawAdvantages, ADVANTAGE_EPSILON);
  const adjustedLogits = adjustLogits(candidates, rawAdvantages, beta);
  const probabilities = softmax(adjustedLogits);
  const priorProbabilities = softmax(
    centerLogits(candidates.map((candidate) => candidate.baseLogit))
  );
  const klToPrior = klDivergence(probabilities, priorProbabilities);
  const chosenIndex =
    selection === 'sample'
      ? sampleIndex(probabilities, rng)
      : argmaxIndex(candidates, adjustedLogits);

  const adjustments: JitAdjustment<T>[] = candidates.map((candidate, index) => {
    const estimate = estimates[index] as (typeof estimates)[number];
    return {
      candidate,
      q: estimate.q,
      advantage: estimate.advantage,
      normalizedAdvantage: normalized[index] as number,
      adjustedLogit: adjustedLogits[index] as number,
      probability: probabilities[index] as number,
      support: estimate.support,
      // P6.2 C0 (ADR 0002 R5): nEff rides every adjustment so the guarded
      // replacement judgement (and any ledger consumer) reads the EFFECTIVE
      // evidence; support stays reported alongside it for the ledger.
      nEff: estimate.nEff,
      explored: estimate.explored
    };
  });
  const chosen = adjustments[chosenIndex] as JitAdjustment<T>;

  const rationale = [
    'jit ' + level + ':',
    'neighbors=' + selectedNeighbors.length,
    'V=' + formatNumber(stateValue),
    'selection=' + selection,
    'chosen=' + chosen.candidate.actionKey,
    'q=' + (chosen.q === null ? 'null' : formatNumber(chosen.q)),
    'A=' + formatNumber(chosen.advantage),
    'At=' + formatNumber(chosen.normalizedAdvantage),
    "z'=" + formatNumber(chosen.adjustedLogit),
    'p=' + formatNumber(chosen.probability),
    'support=' + chosen.support,
    'explored=' + chosen.explored,
    'kl=' + formatNumber(klToPrior)
  ].join(' ');

  return {
    level,
    stateValue,
    neighborCount: selectedNeighbors.length,
    adjustments,
    chosen,
    klToPrior,
    rationale
  };
}

/**
 * Full decision path: retrieve neighbours (unless supplied pre-scored), then
 * compose the closed-form correction. Never throws on an empty neighbourhood;
 * an empty experience pool is the cold-start path.
 */
export function decide<T>(
  level: JitLevel,
  state: AbstractState,
  candidates: readonly JitCandidate<T>[],
  options: DecideOptions = {}
): JitDecision<T> {
  if (options.experiences !== undefined && options.neighbors !== undefined) {
    throw new TypeError('decide: pass exactly one of experiences or neighbors');
  }

  let neighbors: readonly ScoredExperience[];
  if (options.neighbors !== undefined) {
    neighbors = options.neighbors;
  } else if (options.experiences !== undefined) {
    neighbors = retrieveNeighbors(options.experiences, state, {
      k: options.k ?? JIT_DEFAULTS.k,
      similarityThreshold:
        options.similarityThreshold ?? JIT_DEFAULTS.similarityThreshold,
      level,
      guidanceFilter: options.guidanceFilter,
      before: options.before,
      now: options.now,
      halfLifeMs: options.halfLifeMs
    });
  } else {
    throw new TypeError('decide: pass exactly one of experiences or neighbors');
  }

  return composeDecision(level, state, neighbors, candidates, options);
}
