/**
 * JitRL value estimator (plan sections 6.3 and 6.4).
 *
 * Ownership: src/jitrl/** (Phase 1 kernel, P1-3).
 *
 * Given the weighted neighbourhood produced by retriever.ts, estimate
 *
 *   V(s)      = weighted mean of neighbour returns
 *   Q(s, a)   = weighted mean of returns for that action, or an optimistic
 *               exploration bonus V(s) + alpha / max(1, |N(s)|), or the
 *               configured unseen-action fallback
 *   A(s, a)   = Q(s, a) - V(s)
 *   A-tilde   = A / (max |A| + epsilon)
 *
 * The paper uses an unweighted mean; this plugin adds the half-life decay from
 * section 6.3 by consuming the retriever weights. The paper's Q = 0 fallback is
 * kept as 'zero' (used for the Figure 2 reproduction), while the plugin default
 * is 'baseline' (Q = V, A = 0) because plugin returns live in [-3, 3] and a
 * zero fallback would silently encourage exploration whenever V < 0.
 *
 * Numeric policy: record returns and weights must be finite. Non-finite
 * neighbour records are skipped (they cannot be averaged); weightedMean() and
 * normalizeAdvantages() instead reject non-finite arguments with RangeError so
 * programmer errors are not silently clamped. The random draw is injectable and
 * must be finite.
 *
 * RewardContract (P6.1-D): the value averaged below is the CONTRACT's learning
 * target - observedReturn first, `return` only as the legacy-record fallback -
 * never the gain (learningTarget) field, which is the ablation arm. The
 * consumed field and rewardVersion are observable through estimatorTargetLine()
 * so a decision log can state what was actually read (P6.1 section 7.4-6),
 * instead of that fact living only inside the persisted JSONL.
 */

import type {
  AbstractState,
  ExperienceRecord,
  JitCandidate,
  ScoredExperience
} from '../types/contracts';
import {
  REWARD_CONTRACT,
  consumedTargetFieldOf,
  estimatorTargetLine,
  readLearningTarget
} from './reward-contract';

export {
  /** Contract answers "which field is consumed by default" (observedReturn). */
  REWARD_CONTRACT,
  /** Contract-default learning value of one record (observedReturn -> return). */
  readLearningTarget,
  /** Which of the contract target fields a concrete record was read from. */
  consumedTargetFieldOf,
  /** Payload-free estimator log line naming the consumed field + version. */
  estimatorTargetLine
};

/** Fixed normalisation epsilon from plan section 6.4. */
export const ADVANTAGE_EPSILON = 1e-6;

/** Unseen-action policy knobs (config `jitrl.exploration` plus the fallback). */
export interface ValueEstimatorConfig {
  /** Probability of optimistic exploration for an unsupported action. */
  readonly lambda: number;
  /** Optimism bonus scale; Q = V + alpha / max(1, |N(s)|). */
  readonly alpha: number;
  /** Value of an unsupported action: 'zero' (paper) or 'baseline' (Q = V). */
  readonly unseenFallback: 'zero' | 'baseline';
}

/** Per-candidate estimate consumed by logit-adjuster.ts. */
export interface ActionValueEstimate {
  readonly actionKey: string;
  /** Q estimate; null when the action has no support and was not explored. */
  readonly q: number | null;
  /** Number of usable neighbours for this action. */
  readonly support: number;
  /** True when optimistic exploration produced this Q value. */
  readonly explored: boolean;
  /** A = Q - V, using the effective unseen-action value when Q is null. */
  readonly advantage: number;
}

/**
 * Weighted arithmetic mean. Arrays must be non-empty or both empty; an empty
 * input has no evidence and returns 0. All values and weights must be finite
 * and weights non-negative. When every weight is zero (e.g. fully decayed
 * neighbours) the arithmetic mean is used so the call still has a value.
 */
export function weightedMean(
  values: readonly number[],
  weights: readonly number[]
): number {
  if (values.length !== weights.length) {
    throw new RangeError('weightedMean: values and weights must have the same length');
  }
  if (values.length === 0) {
    return 0;
  }
  let weightedSum = 0;
  let totalWeight = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] as number;
    const weight = weights[index] as number;
    if (!Number.isFinite(value)) {
      throw new RangeError('weightedMean: values must be finite numbers');
    }
    if (!Number.isFinite(weight) || weight < 0) {
      throw new RangeError('weightedMean: weights must be finite and >= 0');
    }
    if (weight > 0) {
      weightedSum += value * weight;
      totalWeight += weight;
    }
  }
  if (totalWeight > 0) {
    return weightedSum / totalWeight;
  }
  let plainSum = 0;
  for (const value of values) {
    plainSum += value;
  }
  return plainSum / values.length;
}

/**
 * Effective retrieval weight for one neighbour: the retriever-provided weight
 * when present, otherwise its similarity. Returns 0 for unusable entries.
 */
function neighborWeight(neighbor: ScoredExperience): number {
  const weight = neighbor.weight;
  if (weight !== undefined && Number.isFinite(weight) && weight >= 0) {
    return weight;
  }
  const similarity = neighbor.similarity;
  return Number.isFinite(similarity) && similarity >= 0 ? similarity : 0;
}

/**
 * Neighbours usable for a decision at `state`: same level (cross-level
 * experience must never leak into L1/L2/L3 decisions), finite return, and a
 * strictly positive retrieval weight.
 */
export function selectNeighbors(
  state: AbstractState,
  neighbors: readonly ScoredExperience[]
): readonly ScoredExperience[] {
  const selected: ScoredExperience[] = [];
  for (const neighbor of neighbors) {
    if (neighbor.record.level !== state.level) {
      continue;
    }
    if (!Number.isFinite(neighbor.record.return)) {
      continue;
    }
    if (!(neighborWeight(neighbor) > 0)) {
      continue;
    }
    selected.push(neighbor);
  }
  return selected;
}

/**
 * Weighted state value V-hat over the supplied neighbours. Low-level helper:
 * callers that need level filtering should pass selectNeighbors() output.
 * Empty neighbours mean no evidence and yield 0 (all advantages then 0).
 *
 * The averaged quantity is the RewardContract learning target
 * (readLearningTarget: observedReturn, `return` fallback) - NOT the gain field.
 */
export function estimateStateValue(
  neighbors: readonly ScoredExperience[]
): number {
  const returns: number[] = [];
  const weights: number[] = [];
  for (const neighbor of neighbors) {
    const target = readLearningTarget(neighbor.record);
    if (!Number.isFinite(target)) {
      continue;
    }
    const weight = neighborWeight(neighbor);
    if (!Number.isFinite(weight) || weight < 0) {
      continue;
    }
    returns.push(target);
    weights.push(weight);
  }
  return weightedMean(returns, weights);
}

function validateConfig(config: ValueEstimatorConfig): void {
  if (!Number.isFinite(config.lambda) || config.lambda < 0 || config.lambda > 1) {
    throw new RangeError('estimateActionValues: lambda must be a finite number in [0, 1]');
  }
  if (!Number.isFinite(config.alpha) || config.alpha < 0) {
    throw new RangeError('estimateActionValues: alpha must be a finite number >= 0');
  }
  if (config.unseenFallback !== 'zero' && config.unseenFallback !== 'baseline') {
    throw new RangeError(
      "estimateActionValues: unseenFallback must be 'zero' or 'baseline'"
    );
  }
}

/**
 * Estimate Q, support and advantage for every candidate.
 *
 * Supported actions use the weighted mean of their group. Unsupported actions
 * consume exactly one rng draw in candidate order: with probability lambda they
 * receive the optimistic bonus V + alpha / max(1, |N(s)|); otherwise q stays
 * null and the configured fallback (0 or V) defines the effective Q used for
 * the advantage. The returned array follows the candidate order.
 */
export function estimateActionValues<T>(
  state: AbstractState,
  neighbors: readonly ScoredExperience[],
  candidates: readonly JitCandidate<T>[],
  config: ValueEstimatorConfig,
  rng: () => number = Math.random
): readonly ActionValueEstimate[] {
  validateConfig(config);
  const selected = selectNeighbors(state, neighbors);
  const stateValue = estimateStateValue(selected);

  const groups = new Map<string, ScoredExperience[]>();
  for (const neighbor of selected) {
    const key = neighbor.record.actionKey;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [neighbor]);
    } else {
      group.push(neighbor);
    }
  }

  const estimates: ActionValueEstimate[] = [];
  for (const candidate of candidates) {
    const group = groups.get(candidate.actionKey);
    if (group !== undefined && group.length > 0) {
      const q = estimateStateValue(group);
      estimates.push({
        actionKey: candidate.actionKey,
        q,
        support: group.length,
        explored: false,
        advantage: q - stateValue
      });
      continue;
    }

    const draw = rng();
    if (!Number.isFinite(draw)) {
      throw new RangeError('estimateActionValues: rng() must return a finite number');
    }
    const explored = draw < config.lambda;
    const optimistic =
      stateValue + config.alpha / Math.max(1, selected.length);
    const fallbackValue = config.unseenFallback === 'zero' ? 0 : stateValue;
    const effectiveQ = explored ? optimistic : fallbackValue;
    estimates.push({
      actionKey: candidate.actionKey,
      q: explored ? optimistic : null,
      support: 0,
      explored,
      advantage: effectiveQ - stateValue
    });
  }
  return estimates;
}

/**
 * A-tilde = A / (max |A| + epsilon), which keeps every normalized advantage in
 * (-1, 1). The epsilon guards division by zero when all advantages are 0 or the
 * candidate set holds a single action; a zero denominator yields zeros.
 */
export function normalizeAdvantages(
  values: readonly number[],
  epsilon: number = ADVANTAGE_EPSILON
): readonly number[] {
  if (!Number.isFinite(epsilon) || epsilon < 0) {
    throw new RangeError('normalizeAdvantages: epsilon must be a finite number >= 0');
  }
  if (values.length === 0) {
    return [];
  }
  let maxAbs = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new RangeError('normalizeAdvantages: advantages must be finite numbers');
    }
    const abs = Math.abs(value);
    if (abs > maxAbs) {
      maxAbs = abs;
    }
  }
  const denominator = maxAbs + epsilon;
  if (denominator <= 0) {
    return values.map(() => 0);
  }
  return values.map((value) => value / denominator);
}

/**
 * Estimate action values and return, alongside them, the RewardContract
 * diagnostics a decision log must carry (P6.1 section 7.4-6): which target
 * field the estimate actually consumed and under which rewardVersion. The
 * line is derived from the SAME neighbours the estimate averaged, so it cannot
 * drift from the arithmetic.
 */
export function estimateActionValuesWithContract<T>(
  state: AbstractState,
  neighbors: readonly ScoredExperience[],
  candidates: readonly JitCandidate<T>[],
  config: ValueEstimatorConfig,
  rng: () => number = Math.random,
  rewardVersion: string = REWARD_CONTRACT.version
): {
  readonly estimates: readonly ActionValueEstimate[];
  /** Payload-free line naming the consumed target field and rewardVersion. */
  readonly targetLine: string;
  /** The rewardVersion the line was rendered with. */
  readonly rewardVersion: string;
} {
  const estimates = estimateActionValues(state, neighbors, candidates, config, rng);
  const sampled = selectNeighbors(state, neighbors).map((entry) => entry.record);
  return {
    estimates,
    targetLine: estimatorTargetLine(sampled, rewardVersion),
    rewardVersion
  };
}
