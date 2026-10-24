/**
 * RewardContract: the single reward yardstick for one reward version (P6.1-D,
 * plan sections 7.2 / 7.3 / 7.4).
 *
 * This is deliberately a LIGHTWEIGHT DEFINITION module - types, constants and
 * pure helpers only. It is NOT a reinforcement-learning framework: no new
 * estimator, optimizer, trainer or model class lives here. It exists to pin
 * down, in one greppable place, the answers to four questions the old code
 * answered differently depending on which trajectory was being scored:
 *
 *   1. What is the primary verifiable success signal, and on which scale is
 *      every candidate AND the reference scored under one rewardVersion?
 *   2. Which persisted field does learning consume by default?
 *   3. What role may the LLM judge play without changing the yardstick?
 *   4. What must happen when the scoring rule changes?
 *
 * The defect this module closes (P6.1 source doc section 7.2): under the same
 * `rewardVersion = 'r2/verifiable-v1'` the online recorder used TWO
 * aggregations for the same trajectory - the composer's winner got the
 * step-by-step evaluator plus a discounted return, every sibling and the
 * reference got `scoreTrajectorySignals()` - so one trajectory could measure
 * 0.19 on one path and 0.20 on the other. A winner/loser identity must never
 * change the measurement scale.
 */

import type { ExperienceRecord } from '../types/contracts';
import type { ProbeTrajectory } from '../types/contracts';
import {
  TOOL_SUCCESS_SIGNAL,
  fuseVerifiableSignals,
  scoreTrajectorySignals,
  type TrajectorySignalScore
} from './step-evaluator';

/**
 * The reward model version stamped on every record written by this contract.
 *
 * Kept in one place: `CURRENT_REWARD_VERSION` in ./experience-store.ts is the
 * persisted marker, and this module is where its MEANING is defined. The two
 * must never drift apart (see {@link REWARD_CONTRACT}).
 */
export const REWARD_CONTRACT_VERSION = 'r3/unified-signals-v1' as const;

/**
 * The one low-cost aggregation every executed trajectory - winner or not - is
 * scored with under {@link REWARD_CONTRACT_VERSION}: the deterministic,
 * model-free `scoreTrajectorySignals()` fusion (tool / completion / steps /
 * turn sources). The reference baseline uses the identical function, so
 * `learningTarget = observedReturn - baseline` compares like with like.
 */
export const REWARD_CONTRACT_AGGREGATION = 'trajectory-signals-v1' as const;

/**
 * The persisted field learning consumes BY DEFAULT under this contract.
 *
 * `observedReturn` is the verifier-first quantity: what this trajectory
 * verifiably achieved on the shared scale. `learningTarget` (the gain against
 * the reference baseline) is still PERSISTED for analysis, but it is an
 * ablation arm, not the default input. Whether gain should REPLACE
 * observedReturn is decided by a fair trial, not by this contract (P6.1
 * section 7.2: do not silently rewrite every return into a gain).
 */
export const REWARD_CONTRACT_LEARNING_TARGET_FIELD = 'observedReturn' as const;

/** Fields a consumer may read off a record, in contract-preference order. */
export type RewardContractTargetField =
  | 'observedReturn'
  | 'learningTarget'
  | 'return';

/**
 * The RewardContract itself: a frozen, versioned description of the reward
 * yardstick. Every field is data (strings/numbers), so it can be embedded in
 * diagnostics, reports and tests without dragging behaviour along.
 */
export const REWARD_CONTRACT = {
  /** Must equal the persisted rewardVersion stamped on new records. */
  version: REWARD_CONTRACT_VERSION,
  /**
   * Primary verifiable success signal: for deliverable/test-acceptance tasks
   * the verifier result decides (a completed run that produced the required
   * deliverable scores above the same run without it); `scoreTrajectorySignals`
   * encodes this as the `completion` source (+1 deliverable / -1 claimed
   * success without one).
   */
  primarySignal: 'verifier-first (deliverable/completion, then outcome)',
  /** The one aggregation shared by winners, non-winners and the reference. */
  aggregation: REWARD_CONTRACT_AGGREGATION,
  /**
   * LLM judge policy: auxiliary only. Judge output may ride along as a
   * separate rewardSources entry or calibrate via consistent sampling, but it
   * never defines the primary target and never changes what rewardVersion
   * means (a missing or failed judge leaves the yardstick intact).
   */
  judgePolicy: 'auxiliary-only',
  /** Learning consumes observedReturn; learningTarget is the ablation arm. */
  learningTargetField: REWARD_CONTRACT_LEARNING_TARGET_FIELD,
  /**
   * Relative-to-reference returns are only meaningful when state/difficulty are
   * comparable: the reference is the same task's own baseline probe, scored by
   * the same aggregation. Cross-task or cross-difficulty gains are not
   * comparable and must not be averaged together as if they were.
   */
  comparability: 'same-task reference, same aggregation, same rewardVersion',
  /**
   * Changing the scoring rule REQUIRES incrementing the version. When the old
   * objective is incompatible (records scored on the old scale would poison
   * the new one), experience is REBUILT from source material into a new sink;
   * the audit log is never rewritten in place (see backfill.ts marked-copy
   * migration, which is the existing rebuild mechanism).
   */
  upgradeRule: 'bump rewardVersion; rebuild incompatible experience, never rewrite the audit log in place'
} as const;

/** The previous reward scale, kept referenced so upgrades stay explicit. */
export const PREVIOUS_REWARD_CONTRACT_VERSION = 'r2/verifiable-v1' as const;

/**
 * The weight record the contract's aggregation fuses. Calibrated so that the
 * discriminating cases of P6.1 section 7.4 hold on this scale:
 *   - completion (verifier-first deliverable signal) is the strongest term:
 *     a delivered run scores above the same run without its deliverable, and a
 *     claimed success without a deliverable lands BELOW zero;
 *   - turn (terminal outcome) keeps failed/timeout runs negative;
 *   - steps (budget efficiency) bounds padding;
 *   - tool quality is a minor term, and {@link scoreUnderRewardContract} caps
 *     its positive part so call-count stuffing cannot inflate the score.
 * Changing these weights changes the scale and REQUIRES a rewardVersion bump.
 */
export const REWARD_CONTRACT_WEIGHTS: Readonly<Record<string, number>> = {
  completion: 0.5,
  steps: 0.1,
  tool: 0.1,
  turn: 0.3
};

/**
 * THE single yardstick of this contract version (plan sections 7.2/7.3):
 * score one trajectory - winner, non-winner or reference baseline - on the
 * contract's aggregation. Every caller that must measure a trajectory for
 * reward/learning purposes goes through here, so the scale cannot fork per
 * role again. Pure, deterministic and model-free.
 *
 * Two contract-level bounds are applied on top of the raw signal fusion:
 *   - the positive tool term is BINARY (one clean-tool bonus at most):
 *     stuffing a trajectory with meaningless successful calls cannot raise
 *     the objective (P6.1 section 7.4-4). Error penalties still accumulate.
 *   - the reward stays clipped to [-3, 3].
 */
export function scoreUnderRewardContract(
  trajectory: ProbeTrajectory
): TrajectorySignalScore {
  const signal = scoreTrajectorySignals(trajectory, {
    weights: REWARD_CONTRACT_WEIGHTS
  });
  if (!signal.learningEligible) {
    return signal;
  }
  const sources = { ...signal.sources };
  if (typeof sources.tool === 'number' && sources.tool > TOOL_SUCCESS_SIGNAL) {
    sources.tool = TOOL_SUCCESS_SIGNAL;
  }
  const reward = fuseVerifiableSignals(sources, REWARD_CONTRACT_WEIGHTS, [-3, 3]);
  return {
    ...signal,
    sources,
    reward: Math.min(3, Math.max(-3, reward))
  };
}

/**
 * The generation number of a reward version string (`r3/x` -> 3), or undefined
 * for an unknown/missing shape. Pure parse; the fail-closed interpretation of
 * `undefined` lives in the callers.
 */
export function rewardVersionGeneration(version: string): number | undefined {
  const match = /^r(\d+)\//.exec(version);
  if (match === null || match[1] === undefined) {
    return undefined;
  }
  const generation = Number(match[1]);
  return Number.isInteger(generation) && generation > 0 ? generation : undefined;
}

/**
 * Monotonicity check for a rewardVersion bump.
 *
 * Versions compare by their generation prefix (`rN/...`): `r3/...` strictly
 * follows `r2/...`. An unknown shape is not comparable and therefore never
 * "compatible", which fails closed.
 */
export function isRewardVersionBump(
  previous: string,
  next: string
): boolean {
  const before = rewardVersionGeneration(previous);
  const after = rewardVersionGeneration(next);
  if (before === undefined || after === undefined) {
    return false;
  }
  return after > before;
}

/**
 * True when a record stamped with `recordVersion` may still join a learning
 * neighbourhood scored under `current` (P6.1-D2 / R3 F1-b).
 *
 * Compatibility is GENERATION equality, not string equality:
 * `r3/backfill-tree-v1` is the same reward-model generation as
 * `r3/unified-signals-v1` (the suffix names the producer, not a different
 * calibration), so a rebuilt cold-start record stays usable. Anything else
 * fails closed:
 *   - an older generation (`r2/*` under r3) is a different yardstick and must
 *     be quarantined by the upgrade path, never averaged with current records;
 *   - a newer generation means this code predates the record's contract;
 *   - a missing/unknown version carries no proof of compatibility.
 *
 * This is the production wiring point of the contract's upgrade rule: the
 * experience store's learning filter and the backfill migration both call it.
 */
export function isRewardVersionCompatible(
  recordVersion: string | undefined,
  current: string = REWARD_CONTRACT.version
): boolean {
  if (typeof recordVersion !== 'string' || recordVersion.length === 0) {
    return false;
  }
  const recordGeneration = rewardVersionGeneration(recordVersion);
  const currentGeneration = rewardVersionGeneration(current);
  if (recordGeneration === undefined || currentGeneration === undefined) {
    return false;
  }
  // Any generation difference (up or down) is an incompatible yardstick.
  return (
    recordGeneration === currentGeneration &&
    // Belt and braces: an explicit bump in either direction is incompatible
    // even if the generations somehow compared equal (defensive; unreachable
    // for well-formed versions).
    !isRewardVersionBump(recordVersion, current) &&
    !isRewardVersionBump(current, recordVersion)
  );
}

/**
 * True when switching from `previous` to `next` invalidates existing
 * experience and therefore requires a REBUILD (new sink) instead of an
 * in-place reinterpretation.
 *
 * A same-generation suffix change (a pure relabel) is not a rebuild; a
 * generation bump is, because the numeric scale itself changed. Anything not
 * provably safe fails closed to "rebuild".
 */
export function requiresExperienceRebuild(
  previous: string,
  next: string
): boolean {
  if (previous === next) {
    return false;
  }
  // A generation bump (r2 -> r3) changes the scale: rebuild.
  if (isRewardVersionBump(previous, next)) {
    return true;
  }
  // Anything else (downgrade, unknown shape, cross-lineage label) is not a
  // provably compatible reinterpretation: fail closed to rebuild.
  return true;
}

/**
 * The learning value one record contributes to an estimate, as defined by the
 * contract: the default consumed field is observedReturn, falling back to
 * `return` only on records that predate the field (legacy shapes), and never
 * silently falling back to learningTarget (that is the ablation arm).
 */
export function readLearningTarget(record: ExperienceRecord): number {
  if (typeof record.observedReturn === 'number' && Number.isFinite(record.observedReturn)) {
    return record.observedReturn;
  }
  return Number.isFinite(record.return) ? record.return : Number.NaN;
}

/**
 * Which field {@link readLearningTarget} actually took for this record -
 * 'observedReturn' when present, 'return' for legacy records, undefined when
 * neither is finite (the caller skips such a neighbour).
 */
export function consumedTargetFieldOf(
  record: ExperienceRecord
): RewardContractTargetField | undefined {
  if (typeof record.observedReturn === 'number' && Number.isFinite(record.observedReturn)) {
    return 'observedReturn';
  }
  if (Number.isFinite(record.return)) {
    return 'return';
  }
  return undefined;
}

/**
 * The payload-free estimator log line required by P6.1 section 7.4-6: it must
 * state WHICH target field the estimate actually read and under WHICH reward
 * version - not merely exist inside a JSONL record.
 *
 * `sampledFrom` is the neighbour set the estimate averaged; the line reports
 * how many neighbours contributed each consumed field, so a mixed-neighbourhood
 * estimate (some records falling back to `return`) is visible in the log.
 */
export function estimatorTargetLine(
  sampledFrom: readonly ExperienceRecord[],
  rewardVersion: string = REWARD_CONTRACT.version
): string {
  const counts = new Map<string, number>();
  for (const record of sampledFrom) {
    const field = consumedTargetFieldOf(record);
    if (field === undefined) {
      counts.set('skipped(non-finite)', (counts.get('skipped(non-finite)') ?? 0) + 1);
      continue;
    }
    counts.set(field, (counts.get(field) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([field, count]) => field + '=' + String(count)).sort();
  return (
    'value-estimator: target field ' + REWARD_CONTRACT.learningTargetField +
    ' (contract default); consumed [' + (parts.length > 0 ? parts.join(', ') : 'none') +
    ']; rewardVersion=' + rewardVersion
  );
}
