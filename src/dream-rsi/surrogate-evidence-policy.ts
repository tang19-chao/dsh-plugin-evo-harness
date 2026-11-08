/**
 * rev6 R1-3 (t10) + rev6 A4-2 (B4): the surrogate DE-SELF-REFERENCE evidence
 * policy.
 *
 * THE DEFECT THIS MODULE ADDRESSES
 * -----------------------------------
 * The verifier-free surrogate reward is
 *
 *   s = w1·selected + w2·adoptionRatio + w3·stepEfficiency − w4·toolErrorRate
 *
 * with shipped defaults `(0.4, 0.3, 0.2, 0.1)`. The first two signals are read
 * from the COMPOSER'S OWN verdict, so `w1 + w2 = 0.7` of the scale is the
 * composer grading its own pick. The rev5 counterexample
 * (`tests/unit/dream-rsi/surrogate-self-reference.test.ts`) demonstrates the
 * consequence: a node the composer picks wrongly (18 steps, 0.5 tool-error rate,
 * deliverable FAILS an independent check) outranks the node that passes it.
 * The surrogate reproduces the composer's error instead of checking it.
 *
 * WHAT THIS MODULE IS
 * -------------------
 * The evidence-policy layer that re-weights the two evidence-bearing signals so
 * the ranking follows the verifiable evidence rather than the composer's
 * opinion. The frozen ONLINE scorer (`scoreSurrogate`) is untouched: its
 * weights and clamp stay byte-identical, and online active-policy selection
 * keeps using it exactly as before.
 *
 * rev6 A4-2 wires strategy B into the DREAM input only: the orchestrator
 * records `metadata.dreamEvidence.dreamScore` from
 * `scoreWithEvidencePolicy(..., { trustedProducers })`, and offline replay
 * consumes that value (`replayNodeScore`). The trusted-reader overload is what
 * keeps a self-declared `metadata.verification` payload from steering Dream.
 *
 * TWO CANDIDATE STRATEGIES (preregistration §1.1, contract §5.5 Do.1)
 * ------------------------------------------------------------------
 *   A  `verified-weight-floor`  Raise the evidence-bearing weights (efficiency,
 *      tool-error penalty) to a floor and let `selection`/`adoption` take the
 *      remainder. Simple, but its re-ranking could in principle be driven by the
 *      arithmetic of the re-weighting rather than by evidence - which is exactly
 *      what the evidence-equal negative control is there to detect.
 *   B  `verified-only-selection`  Keep the frozen weights but make the
 *      composer-derived `I(H*)` term count ONLY when the node carries a
 *      verifiable verdict. Where there is no verifiable evidence, the term is 0
 *      rather than "whatever the composer said".
 *
 * Both are evaluated against the same counterexample; the SHADOW report states
 * which one is selected and why (preregistration §4). Strategy B is now the
 * production DREAM strategy (A4-2); strategy A remains research-only. Neither
 * changes the online scorer.
 *
 * THE LOAD-BEARING ASYMMETRY
 * --------------------------
 * Strategy B is the one that can be argued from the evidence rule itself ("the
 * composer's opinion is admissible only where it can be checked"), while A is a
 * calibration choice. But B alone is not sufficient either: it still counts
 * `adoption`, which is also composer-derived. The module therefore exposes the
 * evidence-bearing decision as a NAMED verdict (`admissionOf`) so a caller -
 * and the shadow report - can see exactly which term was admitted, rather than
 * inferring it from a numeric delta.
 */
import type { ProbeTrajectory, SurrogateScoreWeights } from '../types/contracts';
import {
  hasTrustedVerificationProvenance,
  verificationFromTrajectory
} from '../jitrl/step-evaluator';
import {
  DEFAULT_SURROGATE_WEIGHTS,
  clamp01,
  computeSurrogateSignals,
  normalizeSurrogateWeights,
  scoreSurrogate,
  type SurrogateScorerOptions
} from './surrogate-scorer';

/** The two preregistered strategies (never both enabled at once). */
export const EVIDENCE_POLICY_STRATEGIES = [
  /** A: raise the verifiable-signal weights to a floor. */
  'verified-weight-floor',
  /** B: count the composer's `I(H*)` only when a verifiable verdict exists. */
  'verified-only-selection'
] as const;
export type EvidencePolicyStrategy = (typeof EVIDENCE_POLICY_STRATEGIES)[number];

/** The default strategy for shadow evaluation (preregistration §4 selects by data). */
export const DEFAULT_EVIDENCE_POLICY_STRATEGY: EvidencePolicyStrategy = 'verified-only-selection';

/**
 * The verifiable-weight floor for strategy A.
 *
 * WHY THESE NUMBERS: they are a RE-NORMALIZATION of the frozen defaults, not a
 * new tuned vector. The frozen ratio between the two evidence-bearing signals is
 * efficiency : toolErrorPenalty = 0.2 : 0.1 = 2 : 1. The floor keeps that ratio
 * and assigns the evidence-bearing block 0.75 of the total, leaving 0.25 for the
 * composer-derived block (split in its own frozen 0.4 : 0.3 = 4 : 3 ratio).
 * Every number is therefore DERIVED from the frozen default, and the test suite
 * asserts the derivation rather than the constants.
 */
export const VERIFIED_WEIGHT_FLOOR = {
  /** Share of the scale given to the evidence-bearing block. */
  evidenceShare: 0.75,
  /** Frozen ratio efficiency : toolErrorPenalty = 0.2 : 0.1. */
  efficiencyToPenaltyRatio: 2,
  /** Frozen ratio selection : adoption = 0.4 : 0.3. */
  selectionToAdoptionRatio: 4 / 3
} as const;

/** The weights strategy A produces, derived from the frozen defaults. */
export function verifiedWeightFloorWeights(
  base: SurrogateScoreWeights = DEFAULT_SURROGATE_WEIGHTS,
  floor = VERIFIED_WEIGHT_FLOOR
): SurrogateScoreWeights {
  const composerShare = 1 - floor.evidenceShare;
  const evidenceBlock = floor.evidenceShare;
  const composerBlock = composerShare;
  // evidence block split by the frozen 2:1 ratio
  const efficiency = evidenceBlock * (floor.efficiencyToPenaltyRatio / (floor.efficiencyToPenaltyRatio + 1));
  const toolErrorPenalty = evidenceBlock * (1 / (floor.efficiencyToPenaltyRatio + 1));
  // composer block split by the frozen 4:3 ratio
  const selection = composerBlock * (floor.selectionToAdoptionRatio / (floor.selectionToAdoptionRatio + 1));
  const adoption = composerBlock * (1 / (floor.selectionToAdoptionRatio + 1));
  // `base` participates only through the ratios above; asserting it is the frozen
  // vector is the caller's job (the suite does it).
  void base;
  return { selection, adoption, efficiency, toolErrorPenalty };
}

/**
 * What a verifiable verdict says about a node, read ONLY from the trajectory.
 *
 * `verified` is true when the trajectory carries a trust-shaped verification
 * payload whose status is `passed`. This is deliberately narrow: `unknown`/absent
 * verdicts are NOT evidence, and a `failed` verdict is evidence of the opposite
 * direction. It never reads the composition.
 */
export type VerifiableVerdict = 'passed' | 'failed' | 'unknown';

export function verifiableVerdictOf(trajectory: ProbeTrajectory): VerifiableVerdict {
  const metadata = trajectory.metadata as Record<string, unknown> | undefined;
  const candidate = metadata === undefined ? undefined : metadata['verification'];
  if (candidate === null || typeof candidate !== 'object') {
    return 'unknown';
  }
  const status = (candidate as Record<string, unknown>)['status'];
  if (status === 'passed') {
    return 'passed';
  }
  if (status === 'failed') {
    return 'failed';
  }
  return 'unknown';
}

/**
 * rev6 audit A4-2: the TRUSTED verdict reader used by the production Dream
 * path.
 *
 * `verifiableVerdictOf` above reads the SHAPE of `metadata.verification`. That
 * is sufficient for the shadow research fixture, but it is exactly the
 * self-declaration channel the trust boundary forbids in production: a branch
 * (or a host-injected seam) could attach `{status:'passed'}` and steer Dream.
 * This reader instead resolves the verdict through the SAME two conditions the
 * online scorer uses:
 *
 *   1. `verificationFromTrajectory` (explicit payload wins; structural fallback
 *      otherwise), and
 *   2. `hasTrustedVerificationProvenance`: a caller-supplied producer set must
 *      contain the verifierId, the evidence hash must be non-empty, and - when
 *      the deliverable carries one - it must match the deliverable's own
 *      `contentHash` (the execution-evidence binding).
 *
 * Anything short of that reads as `unknown`. The caller supplies the producer
 * set; this module never invents or widens trust.
 */
export function trustedVerifiableVerdictOf(
  trajectory: ProbeTrajectory,
  trustedProducers: ReadonlySet<string>
): VerifiableVerdict {
  const verification = verificationFromTrajectory(trajectory);
  const deliverable = trajectory.deliverable;
  const expectedEvidenceHash =
    deliverable !== undefined && deliverable.content.length > 0
      ? deliverable.contentHash
      : undefined;
  const trusted = hasTrustedVerificationProvenance(
    verification,
    expectedEvidenceHash,
    trustedProducers
  );
  if (!trusted) {
    return 'unknown';
  }
  if (verification.status === 'passed') {
    return 'passed';
  }
  if (verification.status === 'failed') {
    return 'failed';
  }
  return 'unknown';
}

/**
 * Options accepted by the evidence policy in addition to the frozen scorer
 * options. `trustedProducers` is OPTIONAL so the research/shadow callers keep
 * the historical shape-only behaviour; production MUST pass a set (an empty set
 * when no host seam exists) to get the trusted reader. That distinction is
 * deliberate: absence means "legacy research mode", never "trust everything".
 */
export interface EvidencePolicyOptions extends SurrogateScorerOptions {
  readonly trustedProducers?: ReadonlySet<string>;
}

 /**
 * THE ADMISSION RULE (the one decision this module makes).
 *
 * The composer's two terms (`selection` = its `I(H*)` pick, `adoption` = its own
 * adoption ratio) are COMposer OPINION. They may move the ranking only when the
 * verifiable evidence CORROBORATES them, i.e. only when a verifiable verdict
 * exists AND says `passed`.
 *
 * WHY "CORROBORATED" AND NOT MERELY "HAS A VERDICT": an earlier version gated on
 * "any verifiable verdict exists", and it did NOT fix the counterexample - the
 * composer's pick carried a `failed` verdict, so its 0.7-worth of composer terms
 * was still admitted and it still outranked the node that passed. A verifier that
 * says FAILED is evidence AGAINST, and it must switch the composer terms OFF
 * rather than merely being "present". This is the load-bearing rule.
 *
 * `unknown` (no verdict) is also not corroboration: an uncheckable opinion gets
 * no credit, which is what stops strategy B from inventing `I(H*)` where nothing
 * can be checked.
 *
 * Both strategies share THIS rule; they differ only in the weights applied to the
 * terms that survive it (see `scoreWithEvidencePolicy`).
 */
export interface EvidenceAdmission {
  readonly verdict: VerifiableVerdict;
  /**
   * True only when the verdict came from host-trusted provenance (registered
   * producer + evidence hash bound to the deliverable). The legacy shape reader
   * always reports false, so a Dream gate can never mistake a self-declared
   * payload for verified evidence.
   */
  readonly trusted: boolean;
  /** True when the composer's `I(H*)` term is counted. */
  readonly admitSelection: boolean;
  /** True when the composer's adoption term is counted. */
  readonly admitAdoption: boolean;
  /** Human-readable reason, carried into evidence. */
  readonly reason: string;
}

export function admissionOf(
  trajectory: ProbeTrajectory,
  strategy: EvidencePolicyStrategy,
  trustedProducers?: ReadonlySet<string>
): EvidenceAdmission {
  const usingTrustedReader = trustedProducers !== undefined;
  const verdict = usingTrustedReader
    ? trustedVerifiableVerdictOf(trajectory, trustedProducers)
    : verifiableVerdictOf(trajectory);
  const corroborated = verdict === 'passed';
  const trusted = usingTrustedReader && (verdict === 'passed' || verdict === 'failed');
  const source = usingTrustedReader ? 'host-trusted ' : '';
  const reason = corroborated
    ? 'the ' + source + 'verifiable verdict is `passed`, so the composer terms are corroborated and admissible'
    : verdict === 'failed'
      ? 'the ' + source + 'verifiable verdict is `failed`: the composer opinion is REFUTED by evidence, so its terms are zeroed'
      : 'no verifiable verdict: an uncheckable composer opinion gets no credit, so its terms are zeroed';
  void strategy;
  return {
    verdict,
    trusted,
    admitSelection: corroborated,
    admitAdoption: corroborated,
    reason
  };
}

/** Result of scoring one node under an evidence policy. */
export interface PolicyScore {
  /** Score the DEFAULT scorer would produce (the baseline, for comparison). */
  readonly baselineScore: number;
  /** Score under the evidence policy. */
  readonly policyScore: number;
  /** The delta, so a caller can see the size of the re-weighting. */
  readonly delta: number;
  /** Which terms were admitted, and why. */
  readonly admission: EvidenceAdmission;
  /** The weights actually used. */
  readonly weights: SurrogateScoreWeights;
}

/**
 * Score one node under the evidence policy WITHOUT changing the default path.
 *
 * HOW: it calls the frozen `scoreSurrogate` with explicitly constructed weights
 * and, for strategy B, zeroes the composer signals by passing weights whose
 * selection/adoption entries are 0 when no verdict exists. The frozen scorer
 * itself is untouched - this module is the only place that decides the weights.
 */
export function scoreWithEvidencePolicy(
  request: Parameters<typeof scoreSurrogate>[0],
  strategy: EvidencePolicyStrategy = DEFAULT_EVIDENCE_POLICY_STRATEGY,
  options: EvidencePolicyOptions = {}
): PolicyScore {
  const baselineScore = scoreSurrogate(request, options).score;
  // rev6 audit A4-2: production passes a producer SET (possibly empty) to use
  // the trusted reader; an omitted set keeps the historical shape reader for
  // research/shadow callers.
  const admission = admissionOf(request.trajectory, strategy, options.trustedProducers);

  let weights: SurrogateScoreWeights;
  if (strategy === 'verified-weight-floor') {
    // Strategy A re-WEIGHTS, it does not gate: it always uses the derived floor
    // weights, and the composer terms simply become small. That is the strategy
    // whose re-ranking could be arithmetic rather than evidence-driven, which is
    // why NC-2 (evidence-equal) exists to detect it.
    weights = verifiedWeightFloorWeights();
  } else {
    // Strategy B keeps the FROZEN weights and switches the composer terms off
    // unless the verifier corroborated them.
    //
    // THE NORMALIZATION TRAP THIS MUST AVOID (this is where the first
    // implementation failed): `normalizeSurrogateWeights` RE-SCALES any vector
    // that does not sum to 1. Zeroing the two composer entries leaves
    // (0, 0, 0.2, 0.1), which sums to 0.3 and is therefore renormalized to
    // (0, 0, 0.667, 0.333) - i.e. the evidence terms get INFLATED by 3.3x.
    // Compared against a corroborated node still scored at the frozen
    // (0.4, 0.3, 0.2, 0.1), the two candidates are then measured on DIFFERENT
    // scales, and the refuted node's 0.667-weighted efficiency can still beat the
    // corroborated node's 0.2-weighted one. The counterexample survived - which
    // is exactly what the failing test caught.
    //
    // THE FIX: keep the surviving entries at their frozen ABSOLUTE weights and
    // redistribute NOTHING. A gated-off term contributes 0 because its weight is
    // 0 AND its signal is irrelevant; the remaining terms keep their frozen
    // absolute size, so both candidates are always measured on the SAME scale.
    // Because the vector no longer sums to 1, the marker below makes that
    // explicit rather than letting a silent renormalization hide it.
    // rev6 audit A4-2 follow-up: the base vector must be the EFFECTIVE vector
// `scoreSurrogate` uses, not the compiled default. A host may legally override
// `dreamRsi.surrogateWeights` (README configuration reference), and before this
// fix strategy B silently ignored it: `baselineScore` used the request weights
// while `policyScore` used DEFAULT_SURROGATE_WEIGHTS, so the two were on
// different scales and a "corroborated" candidate's delta was not 0.
const effectiveWeights = normalizeSurrogateWeights(
  request.weights,
  options.defaultWeights ?? DEFAULT_SURROGATE_WEIGHTS
).weights;
weights = {
  selection: admission.admitSelection ? effectiveWeights.selection : 0,
  adoption: admission.admitAdoption ? effectiveWeights.adoption : 0,
  efficiency: effectiveWeights.efficiency,
  toolErrorPenalty: effectiveWeights.toolErrorPenalty
};
  }

  // Score with the FROZEN weights semantics: the surviving terms keep their
  // absolute frozen size. `scoreSurrogate` would renormalize a non-unit vector,
  // so this module computes the weighted sum ITSELF for the gated (strategy B)
  // path and documents it, instead of silently inheriting a scale change.
  const computed = computeSurrogateSignals(request, options);
  const raw =
    weights.selection * (computed.signals.selected ? 1 : 0) +
    weights.adoption * computed.signals.adoptionRatio +
    weights.efficiency * computed.signals.stepEfficiency -
    weights.toolErrorPenalty * computed.signals.toolErrorRate;
  const policyScore = clamp01(raw);

  return {
    baselineScore,
    policyScore,
    // The delta is the gate/re-weighting's own effect. When the policy keeps every
    // frozen weight (a corroborated candidate under strategy B), it is exactly 0 -
    // reported honestly rather than forced to differ.
    delta: policyScore - baselineScore,
    admission,
    weights
  };
}

/**
 * Rank candidates under a strategy. Sibling of the test helper, exported so the
 * shadow report and the suites rank by the SAME rule rather than by a local copy.
 */
export function rankWithEvidencePolicy(
  requests: readonly Parameters<typeof scoreSurrogate>[0][],
  strategy: EvidencePolicyStrategy = DEFAULT_EVIDENCE_POLICY_STRATEGY,
  options: EvidencePolicyOptions = {}
): readonly { readonly nodeId: string; readonly score: number; readonly admission: EvidenceAdmission }[] {
  return requests
    .map((request) => {
      const result = scoreWithEvidencePolicy(request, strategy, options);
      return { nodeId: request.node.id, score: result.policyScore, admission: result.admission };
    })
    .sort((left, right) => right.score - left.score);
}

/** Re-export the frozen defaults so callers can assert equality without importing twice. */
export { DEFAULT_SURROGATE_WEIGHTS, computeSurrogateSignals, scoreSurrogate };
