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
 *
 * P6.2 PR-B / F3 adds one lexicographic bound: when the resolved trusted
 * verification is 'failed', the reward is clamped to <= 0, so no amount of
 * tool smoothness or step efficiency can compensate an acceptance failure
 * ("一次少调用不能抵消验收失败"). The completion source itself is now
 * verifier-decided inside scoreTrajectorySignals.
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
  const clamped =
    signal.verification.status === 'failed' && reward > 0 ? 0 : Math.min(3, Math.max(-3, reward));
  return {
    ...signal,
    sources,
    reward: clamped
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
 * P6.2 PR-A / F2: the EXPLICIT compatibilities of {@link isRewardVersionExact}.
 *
 * Compatibility is decided by exact contract-id membership, never by parsing
 * meaning out of a `rN/` prefix: two suffixes within one generation may name
 * producers whose targets are NOT the same function (the r3 backfill rebuild
 * maps a surrogate tree score onto a clip and follows the discounted best
 * successor, while the online r3 contract fuses tool/completion/steps/turn of
 * one executed trajectory - different sources, different horizon). Bumping the
 * shared numeric prefix does not re-derive one into the other, so prefix
 * equality must not make them interchangeable.
 *
 * The ONLY other id that may join an online `r3/unified-signals-v1`
 * neighbourhood is a record RE-SCORED under this exact contract from preserved
 * original execution evidence (`r3/unified-signals-v1@rescore-v1`), which the
 * rescore helper below stamps together with the evidence hash chain.
 *
 * Adding an entry here is an auditable, deliberate act: the entry must name the
 * producer AND why its target is the same defined objective (same aggregation,
 * same horizon, same weights hash), not merely the same generation number.
 */
export const REWARD_CONTRACT_COMPATIBLE_IDS: Readonly<Record<string, readonly string[]>> = {
  // The online contract trusts only itself...
  [REWARD_CONTRACT_VERSION]: [
    // ...and rescored copies that were computed BY this contract's scorer from
    // preserved original execution evidence (see rescoreUnderCurrentContract).
    'r3/unified-signals-v1@rescore-v1'
  ],
  // 'r3/backfill-tree-v1' is deliberately ABSENT: a surrogate-only tree
  // rebuild is target-heterogeneous with the online contract (F2) and is
  // quarantined as surrogatePrior/audit-only instead of being mixed in.
  'r3/backfill-tree-v1': [],
  // Rescored records trust their base contract id only.
  'r3/unified-signals-v1@rescore-v1': ['r3/unified-signals-v1']
};

/** Reward version stamped on records rescored under the current contract. */
export const RESCORE_REWARD_VERSION = 'r3/unified-signals-v1@rescore-v1' as const;

/**
 * The exact-contract compatibility rule (P6.2 PR-A / F2).
 *
 * `recordVersion` may join a neighbourhood scored under `current` ONLY when
 *   - it is the exact same contract id, or
 *   - `current` lists `recordVersion` in its explicitly certified
 *     compatibility table ({@link REWARD_CONTRACT_COMPATIBLE_IDS}) - which is
 *     data an engineer authored, not a parsed prefix.
 *
 * Everything else fails closed: an older generation, a same-generation
 * producer with a different target (the F2 surrogate backfill case), a future
 * version, a missing or malformed id - none of them prove the record's numbers
 * are on this contract's scale, so none of them may train.
 *
 * Compatibility is symmetric by construction: the table maps every certified
 * pair in both directions, so `isRewardVersionExact(a, b) ===
 * isRewardVersionExact(b, a)` (asserted by tests).
 */
export function isRewardVersionExact(
  recordVersion: string | undefined,
  current: string = REWARD_CONTRACT.version
): boolean {
  if (typeof recordVersion !== 'string' || recordVersion.length === 0) {
    return false;
  }
  if (recordVersion === current) {
    return true;
  }
  return (
    REWARD_CONTRACT_COMPATIBLE_IDS[current]?.includes(recordVersion) === true ||
    REWARD_CONTRACT_COMPATIBLE_IDS[recordVersion]?.includes(current) === true
  );
}

/**
 * The contract id a record must carry to train the policy under `current`.
 *
 * Learning consumers that want to state the accepted set (diagnostics,
 * migration planners) read this instead of re-deriving it: the current id plus
 * every id the table certifies for it.
 */
export function strictTargetContractIds(
  current: string = REWARD_CONTRACT.version
): readonly string[] {
  const certified = REWARD_CONTRACT_COMPATIBLE_IDS[current] ?? [];
  return [current, ...certified].sort();
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
 * neighbourhood scored under `current` (P6.1-D2 / R3 F1-b, P6.2 PR-A / F2).
 *
 * P6.2 PR-A: this is EXACT contract-id matching (or a certified table entry),
 * NOT generation equality. `r3/backfill-tree-v1` and `r3/unified-signals-v1`
 * share the `r3` prefix but define different targets (surrogate tree rebuild
 * vs online trajectory aggregation), so the prefix proves nothing. Anything
 * else fails closed:
 *   - an older generation (`r2/*` under r3) is a different yardstick and must
 *     be quarantined by the upgrade path, never averaged with current records;
 *   - a newer generation means this code predates the record's contract;
 *   - a missing/unknown version carries no proof of compatibility.
 *
 * This is the production wiring point of the contract's upgrade rule: the
 * experience store's learning filter and the backfill migration both call it.
 * See {@link isRewardVersionExact} for the underlying rule.
 */
export function isRewardVersionCompatible(
  recordVersion: string | undefined,
  current: string = REWARD_CONTRACT.version
): boolean {
  return isRewardVersionExact(recordVersion, current);
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

// ---------------------------------------------------------------------------
// P6.2 PR-A / F2: rescored records and their evidence chain
// ---------------------------------------------------------------------------

/** FNV-1a over a string; stable across runs and platforms (payload hashes). */
function stableHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash >>> 0).toString(16);
}

/** Weights-hash of the contract's fused aggregation (change => new scale). */
export function contractWeightsHash(): string {
  return stableHash(JSON.stringify(REWARD_CONTRACT_WEIGHTS));
}

/**
 * The minimum experience schema a learning consumer accepts (P6.2 PR-A).
 *
 * Declared here, in the leaf contract module, so the single eligibility
 * predicate below has no import cycle with the store that persists the
 * records; `EXPERIENCE_SCHEMA_VERSION` in ./experience-store.ts is asserted
 * equal to this constant by tests, so the two can never drift apart. A record
 * whose `experienceSchemaVersion` is absent (or below this) is LEGACY: it may
 * be read for audit, but it must not train.
 */
export const LEARNING_MIN_EXPERIENCE_SCHEMA_VERSION = 2 as const;

/**
 * THE single learning-eligibility predicate (P6.2 PR-A / F1).
 *
 * Lives in this leaf module (imported by both the decision kernel and the
 * experience store, which therefore cannot cycle) and is re-exported as
 * `isLearningEligibleExperience` from ./decision-kernel.ts - the name every
 * learning consumer imports. Every learning-facing consumer - store.query's
 * `learningEligibleOnly`, the snapshot consumers L1/L2/L3, the replay kernel,
 * the M3 fresh count and the partition/migration planners - must delegate to
 * THIS function, never keep a private copy of "strict filtering".
 *
 * A record may train only when all of:
 *   1. `learningEligible !== false` (cancellation / infrastructure veto);
 *   2. its experience schema version is at least
 *      {@link LEARNING_MIN_EXPERIENCE_SCHEMA_VERSION} (missing = legacy);
 *   3. its rewardVersion is EXACTLY the current contract id, or an explicitly
 *      certified compatible id ({@link REWARD_CONTRACT_COMPATIBLE_IDS}); a
 *      missing version proves nothing and fails closed, and a same-generation
 *      producer with a different target (the surrogate backfill) is not
 *      compatible.
 */
export function isLearningEligibleRecord(
  record: Readonly<Pick<ExperienceRecord, 'learningEligible' | 'experienceSchemaVersion' | 'rewardVersion'>>,
  currentRewardVersion: string = REWARD_CONTRACT.version
): boolean {
  if (record.learningEligible === false) {
    return false;
  }
  const schemaVersion = record.experienceSchemaVersion;
  if (
    schemaVersion === undefined ||
    !Number.isFinite(schemaVersion) ||
    schemaVersion < LEARNING_MIN_EXPERIENCE_SCHEMA_VERSION
  ) {
    return false;
  }
  return isRewardVersionExact(record.rewardVersion, currentRewardVersion);
}

/**
 * The provenance a rescored record must carry so "rebuilt from original
 * execution evidence under the current contract" is checkable, not asserted.
 *
 * P6.2 PR-A / F2 requires every rescore to preserve: the hash of the source
 * trajectory it was computed from, the contract id it was scored under, the
 * aggregation and horizon actually used, the weights hash of that aggregation,
 * and the identity of the verifier that accepted the evidence.
 */
export interface RescoreProvenance {
  /** Hash of the original executed trajectory the rescore consumed. */
  readonly sourceTrajectoryHash: string;
  /** Contract id the rescore scored under (must be the current contract). */
  readonly targetContractId: string;
  /** Aggregation actually applied (e.g. REWARD_CONTRACT_AGGREGATION). */
  readonly aggregation: string;
  /** Horizon of the aggregation (single trajectory, no discounting). */
  readonly horizon: string;
  /** Hash of the aggregation weights (binds the numeric scale). */
  readonly weightsHash: string;
  /** Identity of the verifier that accepted the original evidence. */
  readonly verifierId: string;
}

/**
 * True when the provenance chain is complete and points at the CURRENT
 * contract with the contract's own aggregation and weights hash.
 *
 * This is the gate a rescored record must pass before it may carry
 * {@link RESCORE_REWARD_VERSION}: the certified-compatibility table entry is
 * only meaningful because every record stamped `@rescore-v1` was checked here.
 * An incomplete or foreign provenance fails closed (the record must stay
 * surrogatePrior/audit-only instead).
 */
export function isValidRescoreProvenance(
  provenance: Partial<RescoreProvenance> | undefined
): provenance is RescoreProvenance {
  if (provenance === undefined || provenance === null) {
    return false;
  }
  const fields: readonly (keyof RescoreProvenance)[] = [
    'sourceTrajectoryHash',
    'targetContractId',
    'aggregation',
    'horizon',
    'weightsHash',
    'verifierId'
  ];
  for (const field of fields) {
    const value = (provenance as Record<string, unknown>)[field];
    if (typeof value !== 'string' || value.length === 0) {
      return false;
    }
  }
  return (
    provenance.targetContractId === REWARD_CONTRACT.version &&
    provenance.aggregation === REWARD_CONTRACT_AGGREGATION &&
    provenance.weightsHash === contractWeightsHash()
  );
}

// ---------------------------------------------------------------------------
// P6.2 PR-B / F3: verifier-first scoring on top of the contract
// ---------------------------------------------------------------------------

/**
 * F3's verifier-first completion rule, expressed as a named marker reported in
 * the record_experience stage detail and available to diagnostics.
 *
 * The contract's weights hash does not change: `completion` keeps its 0.5
 * weight. What changes is WHICH trajectories earn the completion source - the
 * trusted verification verdict decides, not `deliverable.content.length > 0`
 * (see ./step-evaluator.ts `scoreTrajectorySignals`).
 */
export const REWARD_CONTRACT_VERIFIER_FIRST = 'verifier-first-completion-v1' as const;

/**
 * The PREREGISTERED next reward contract id for the verifier-first scale (F3).
 *
 * PR-B delivers the scoring behaviour (verdict-decided completion, lexicographic
 * clamp on failed verification, falsified-claim ineligibility) while the
 * persisted rewardVersion stays on `r3/unified-signals-v1`: the store constant
 * (CURRENT_REWARD_VERSION in ./experience-store.ts) and its version pins are
 * owned by the release-boundary PR, and PR-B's scope forbids touching them.
 * When that PR adopts the new scale it moves CURRENT_REWARD_VERSION here and
 * every r3 record is excluded from the r4 neighbourhood automatically by the
 * PR-A predicate - the compatibility table below is pre-authored so the
 * adoption cannot accidentally certify a cross-boundary mix:
 * r3's completion rewarded text presence, so an r3 observedReturn encodes
 * "text existed", never "the task was verified".
 */
export const REWARD_CONTRACT_VERSION_PR_B = 'r4/verifier-first-v1' as const;

/**
 * Pre-authored compatibility certification for the r4 adoption (EMPTY both
 * ways). See {@link REWARD_CONTRACT_VERSION_PR_B} for why nothing crosses the
 * r3/r4 boundary except the rescore copy computed BY the r4 scorer itself.
 */
export const REWARD_CONTRACT_COMPATIBLE_IDS_PR_B: Readonly<Record<string, readonly string[]>> = {
  [REWARD_CONTRACT_VERSION_PR_B]: ['r4/verifier-first-v1@rescore-v1'],
  'r3/unified-signals-v1': [],
  'r3/unified-signals-v1@rescore-v1': [],
  'r3/backfill-tree-v1': [],
  'r4/verifier-first-v1@rescore-v1': [REWARD_CONTRACT_VERSION_PR_B]
};

/**
 * PR-B rescore stamp: a record re-scored under the r4 verifier-first contract
 * from preserved original execution evidence carries this id (the r4 analogue
 * of {@link RESCORE_REWARD_VERSION}).
 */
export const RESCORE_REWARD_VERSION_PR_B = 'r4/verifier-first-v1@rescore-v1' as const;
