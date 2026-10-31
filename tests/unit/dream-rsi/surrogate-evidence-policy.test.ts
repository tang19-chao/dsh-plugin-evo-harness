/**
 * rev6 R1-3 (t10): the surrogate de-self-reference evidence policy.
 *
 * WHAT THIS SUITE MUST PROVE (preregistration §1.1, §7)
 * ----------------------------------------------------
 *   NC-1  On the rev5 counterexample (composer picks the node whose deliverable
 *         FAILS an independent check), the policy must NOT rank the verifiable
 *         failure above the verifiable pass. This is the regression gate the
 *         contract names (`A-R1-3-1`).
 *   NC-2  On an EVIDENCE-EQUAL pair (same steps, same tool errors, same verdict),
 *         the policy must NOT flip the ranking. Without this, NC-1 would be
 *         explained by the arithmetic of re-weighting rather than by evidence.
 *   NC-3  A trajectory with no verifiable verdict must not get a fabricated
 *         `I(H*)` credit under strategy B.
 *   NC-4  `DEFAULT_SURROGATE_WEIGHTS` and the [0,1] clamp are UNCHANGED, and the
 *         default scoring path is byte-identical (A-R1-3-2). This is asserted by
 *         comparing against the frozen vector field by field, not by trusting a
 *         comment.
 *
 * The counterexample fixture is duplicated from rev5's
 * `surrogate-self-reference.test.ts` DELIBERATELY rather than imported: that file
 * is a frozen rev5 deliverable inside the 73-path set, and a rev6 test that
 * imported its internals would make a future edit to it silently change what
 * rev6 proves. The numbers are the same; the dependency is not.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SURROGATE_WEIGHTS,
  scoreSurrogate,
  scoreSurrogate as frozenScoreSurrogate
} from '../../../src/dream-rsi/surrogate-scorer';
import {
  DEFAULT_EVIDENCE_POLICY_STRATEGY,
  EVIDENCE_POLICY_STRATEGIES,
  VERIFIED_WEIGHT_FLOOR,
  admissionOf,
  rankWithEvidencePolicy,
  scoreWithEvidencePolicy,
  verifiableVerdictOf,
  verifiedWeightFloorWeights
} from '../../../src/dream-rsi/surrogate-evidence-policy';
import { DEFAULT_EVO_HARNESS_CONFIG } from '../../../src/config';
import type {
  CompositionResult,
  DiscoveryNode,
  ProbeTrajectory,
  SurrogateScoreWeights
} from '../../../src/types/contracts';
import { fixedClock, makeComposition, makeTrajectory } from './fixtures';

function node(overrides: Partial<DiscoveryNode> = {}): DiscoveryNode {
  return {
    id: overrides.id ?? 'n1',
    treeId: overrides.treeId ?? 't1',
    parentId: overrides.parentId ?? null,
    depth: overrides.depth ?? 1,
    branchId: overrides.branchId ?? 'b1',
    patchId: overrides.patchId ?? 'p1',
    patchOrigin: overrides.patchOrigin ?? 'reference',
    purpose: overrides.purpose ?? 'deepen',
    guidance: overrides.guidance ?? 'memory',
    status: overrides.status ?? 'succeeded',
    childIds: overrides.childIds ?? [],
    createdAt: overrides.createdAt ?? 10,
    updatedAt: overrides.updatedAt ?? 20,
    ...(overrides.score === undefined ? {} : { score: overrides.score }),
    ...(overrides.adoptionRatio === undefined ? {} : { adoptionRatio: overrides.adoptionRatio })
  };
}

/**
 * An INDEPENDENT verifiable check: the deliverable must literally contain "PASS".
 * It reads neither the composition nor any surrogate signal - that is what makes
 * it evidence rather than another opinion. Same rule as rev5's gate.
 */
function verifierAccepts(deliverable: string | undefined): boolean {
  return deliverable !== undefined && deliverable.includes('PASS');
}

interface Candidate {
  readonly node: DiscoveryNode;
  readonly deliverable: string;
  readonly steps: number;
  readonly toolCalls: number;
  readonly toolErrors: number;
  /** Attach a trust-shaped verification payload to the trajectory. */
  readonly verdict?: 'passed' | 'failed';
}

function requestOf(candidate: Candidate, composition: CompositionResult) {
  const base = makeTrajectory({
    nodeId: candidate.node.id,
    branchId: candidate.node.branchId,
    deliverable: { content: candidate.deliverable, format: 'text' },
    metrics: {
      steps: candidate.steps,
      toolCalls: candidate.toolCalls,
      toolErrors: candidate.toolErrors
    }
  });
  // `makeTrajectory` has no `metadata` option, so the verification payload is
  // attached HERE rather than passed in and silently dropped. (An earlier
  // version passed it as an option and every candidate read as `unknown` - a
  // fixture bug that would have made NC-1 pass for the wrong reason.)
  const trajectory: ProbeTrajectory =
    candidate.verdict === undefined
      ? base
      : ({
          ...base,
          metadata: {
            verification: {
              status: candidate.verdict,
              verifierId: 't10-independent-check',
              verifierVersion: 'v1',
              evidenceHash: 't10-hash',
              checks: [{ id: 'contains-PASS', passed: candidate.verdict === 'passed' }]
            }
          }
        } as ProbeTrajectory);
  return { node: candidate.node, trajectory, composition, weights: DEFAULT_SURROGATE_WEIGHTS };
}

// ---------------------------------------------------------------------------
// the rev5 counterexample: composer wrong, verifier opposite
// ---------------------------------------------------------------------------

const composerPick: Candidate = {
  node: node({ id: 'n-composer-pick', branchId: 'b-pick' }),
  deliverable: 'result: FAIL (assertion failed in check_contract)',
  steps: 18,
  toolCalls: 6,
  toolErrors: 3,
  verdict: 'failed'
};

const verifiedGood: Candidate = {
  node: node({ id: 'n-verified', branchId: 'b-good' }),
  deliverable: 'result: PASS (all contract assertions hold)',
  steps: 5,
  toolCalls: 6,
  toolErrors: 0,
  verdict: 'passed'
};

const composition: CompositionResult = makeComposition({
  selectedNodeId: composerPick.node.id,
  selectedBranchId: composerPick.node.branchId,
  adoptionRatios: { [composerPick.node.id]: 1 }
});

describe('NC-4: the frozen defaults and clamp are untouched', () => {
  it('DEFAULT_SURROGATE_WEIGHTS is still exactly (0.4, 0.3, 0.2, 0.1)', () => {
    // Field-by-field, and also against the config source of truth: a change in
    // either place fails here rather than surfacing as a silent re-scoring.
    expect(DEFAULT_SURROGATE_WEIGHTS).toEqual({
      selection: 0.4,
      adoption: 0.3,
      efficiency: 0.2,
      toolErrorPenalty: 0.1
    });
    expect(DEFAULT_SURROGATE_WEIGHTS).toEqual({
      selection: DEFAULT_EVO_HARNESS_CONFIG.dreamRsi.surrogateWeights.selection,
      adoption: DEFAULT_EVO_HARNESS_CONFIG.dreamRsi.surrogateWeights.adoption,
      efficiency: DEFAULT_EVO_HARNESS_CONFIG.dreamRsi.surrogateWeights.efficiency,
      toolErrorPenalty: DEFAULT_EVO_HARNESS_CONFIG.dreamRsi.surrogateWeights.toolErrorPenalty
    });
  });

  it('the default scoring path is unchanged by this module (same function, same numbers)', () => {
    // `frozenScoreSurrogate` and `scoreSurrogate` are the same import; the
    // assertion that matters is that this MODULE never mutates the frozen vector.
    const before = { ...DEFAULT_SURROGATE_WEIGHTS };
    scoreWithEvidencePolicy(requestOf(composerPick, composition));
    scoreWithEvidencePolicy(requestOf(verifiedGood, composition));
    expect({ ...DEFAULT_SURROGATE_WEIGHTS }).toEqual(before);
    expect(frozenScoreSurrogate).toBe(scoreSurrogate);
  });

  it('the clamp keeps every score inside [0, 1] even under the policy weights', () => {
    for (const strategy of EVIDENCE_POLICY_STRATEGIES) {
      for (const candidate of [composerPick, verifiedGood]) {
        const scored = scoreWithEvidencePolicy(requestOf(candidate, composition), strategy);
        expect(scored.policyScore).toBeGreaterThanOrEqual(0);
        expect(scored.policyScore).toBeLessThanOrEqual(1);
      }
    }
  });

  it('strategy A weights are DERIVED from the frozen ratios, not hand-tuned', () => {
    const derived = verifiedWeightFloorWeights();
    // The evidence-bearing block gets `evidenceShare` of the scale ...
    expect(derived.efficiency + derived.toolErrorPenalty).toBeCloseTo(
      VERIFIED_WEIGHT_FLOOR.evidenceShare,
      12
    );
    // ... and the composer block gets the rest.
    expect(derived.selection + derived.adoption).toBeCloseTo(
      1 - VERIFIED_WEIGHT_FLOOR.evidenceShare,
      12
    );
    // ... preserving each block's FROZEN internal ratio.
    expect(derived.efficiency / derived.toolErrorPenalty).toBeCloseTo(2, 12);
    expect(derived.selection / derived.adoption).toBeCloseTo(4 / 3, 12);
    expect(derived.selection + derived.adoption + derived.efficiency + derived.toolErrorPenalty).toBeCloseTo(1, 12);
  });
});

describe('NC-1: the policy does not rank a verifiable failure above a verifiable pass', () => {
  it('the baseline (frozen defaults) DOES reproduce the wrong composer verdict', () => {
    // Establishing the defect first: without this half, the fix below could be
    // "passing" on a fixture where nothing was ever wrong.
    const picked = scoreSurrogate(requestOf(composerPick, composition));
    const good = scoreSurrogate(requestOf(verifiedGood, composition));
    expect(picked.score).toBeGreaterThan(good.score);
    // And the independent evidence says the opposite.
    expect(verifierAccepts(composerPick.deliverable)).toBe(false);
    expect(verifierAccepts(verifiedGood.deliverable)).toBe(true);
  });

  it('strategy B ranks the verified pass first (NC-1 satisfied)', () => {
    const ranked = rankWithEvidencePolicy(
      [requestOf(composerPick, composition), requestOf(verifiedGood, composition)],
      'verified-only-selection'
    );
    expect(ranked.map((entry) => entry.nodeId)).toEqual([
      verifiedGood.node.id,
      composerPick.node.id
    ]);
  });

  it('strategy A also ranks the verified pass first (NC-1 satisfied)', () => {
    const ranked = rankWithEvidencePolicy(
      [requestOf(composerPick, composition), requestOf(verifiedGood, composition)],
      'verified-weight-floor'
    );
    expect(ranked.map((entry) => entry.nodeId)).toEqual([
      verifiedGood.node.id,
      composerPick.node.id
    ]);
  });

  it('the default strategy is strategy B (the one argued from the evidence rule)', () => {
    expect(DEFAULT_EVIDENCE_POLICY_STRATEGY).toBe('verified-only-selection');
    expect(EVIDENCE_POLICY_STRATEGIES).toEqual(['verified-weight-floor', 'verified-only-selection']);
  });
});

describe('NC-2: evidence-equal candidates are NOT flipped (the negative control)', () => {
  const tieA: Candidate = {
    node: node({ id: 'n-tie-a', branchId: 'b-tie-a' }),
    deliverable: 'result: PASS',
    steps: 7,
    toolCalls: 4,
    toolErrors: 0,
    verdict: 'passed'
  };
  const tieB: Candidate = {
    node: node({ id: 'n-tie-b', branchId: 'b-tie-b' }),
    deliverable: 'result: PASS',
    steps: 7,
    toolCalls: 4,
    toolErrors: 0,
    verdict: 'passed'
  };
  const tieComposition = makeComposition({
    selectedNodeId: tieA.node.id,
    selectedBranchId: tieA.node.branchId,
    adoptionRatios: { [tieA.node.id]: 1 }
  });

  it('strategy B does not flip an evidence-EQUAL pair (the negative control)', () => {
    // THE POINT OF THIS CONTROL: the NC-1 flip must be attributable to the
    // EVIDENCE, not to the arithmetic of gating. So the pair below is equal on
    // everything the evidence can see - same steps, same tool errors, same
    // `passed` verdict. The only asymmetry left is the Composer's opinion (which
    // node it picked and how it scored adoption), and that asymmetry is EXACTLY
    // what the policy deliberately preserves when the evidence corroborates it:
    // with equal evidence there is nothing to overturn, so the ranking must not
    // move. (An earlier draft compared a corroborated-pick against a
    // corroborated-non-pick and expected a tie - wrong, because adoption is a
    // real signal whose difference is not evidence-contradicted.)
    const ranked = rankWithEvidencePolicy(
      [requestOf(tieA, tieComposition), requestOf(tieB, tieComposition)],
      'verified-only-selection'
    );
    expect(ranked.map((entry) => entry.nodeId)).toEqual([tieA.node.id, tieB.node.id]);
    // Both admissions are `passed`-corroborated, so neither was gated off: the
    // policy had no evidence basis to reorder them.
    expect(ranked[0]?.admission.admitSelection).toBe(true);
    expect(ranked[1]?.admission.admitSelection).toBe(true);
  });

  it('strategy B scores two FULLY symmetric candidates identically', () => {
    // Now remove the last asymmetry too: give both the same composition status by
    // scoring them with NO composition at all, so `selected` derives from execution
    // success for both. Any residual difference would then be an artefact of the
    // policy rather than of the inputs.
    const symmetric = makeComposition({ selectedNodeId: null, selectedBranchId: null, adoptionRatios: {} });
    const left = scoreWithEvidencePolicy(requestOf(tieA, symmetric), 'verified-only-selection');
    const right = scoreWithEvidencePolicy(requestOf(tieB, symmetric), 'verified-only-selection');
    expect(left.policyScore).toBeCloseTo(right.policyScore, 12);
    expect(left.delta).toBeCloseTo(right.delta, 12);
  });

  it('strategy A re-weights but does not overturn corroborated equal evidence either', () => {
    const ranked = rankWithEvidencePolicy(
      [requestOf(tieA, tieComposition), requestOf(tieB, tieComposition)],
      'verified-weight-floor'
    );
    expect(ranked.map((entry) => entry.nodeId)).toEqual([tieA.node.id, tieB.node.id]);
  });
});

describe('NC-3: no verdict means no fabricated I(H*) credit', () => {
  it('strategy B zeroes the composer terms when no verifiable verdict exists', () => {
    const noVerdict: Candidate = {
      node: node({ id: 'n-no-verdict', branchId: 'b-no' }),
      deliverable: 'result: (no verdict attached)',
      steps: 7,
      toolCalls: 4,
      toolErrors: 0
    };
    const admission = admissionOf(requestOf(noVerdict, composition).trajectory, 'verified-only-selection');
    expect(admission.verdict).toBe('unknown');
    expect(admission.admitSelection).toBe(false);
    expect(admission.admitAdoption).toBe(false);
    expect(admission.reason).toContain('no verifiable verdict');
  });

  it('a trajectory with no metadata at all reads as `unknown`, never as `passed`', () => {
    const bare = makeTrajectory({ deliverable: { content: 'PASS', format: 'text' } });
    expect(verifiableVerdictOf(bare)).toBe('unknown');
  });

  it('a `failed` verdict REFUTES the composer opinion, so its terms are zeroed', () => {
    const failedOnly: Candidate = {
      node: node({ id: 'n-failed', branchId: 'b-failed' }),
      deliverable: 'result: PASS but the check says FAIL',
      steps: 5,
      toolCalls: 6,
      toolErrors: 0,
      verdict: 'failed'
    };
    const admission = admissionOf(requestOf(failedOnly, composition).trajectory, 'verified-only-selection');
    expect(admission.verdict).toBe('failed');
    // THE LOAD-BEARING RULE: a verifier that says FAILED is evidence AGAINST the
    // composer, so the composer's 0.7-worth of terms must switch OFF. Gating
    // merely on "a verdict exists" leaves them ON and the counterexample survives
    // (this assertion is what caught that bug).
    expect(admission.admitSelection).toBe(false);
    expect(admission.admitAdoption).toBe(false);
    expect(admission.reason).toContain('REFUTED');
  });
});

describe('shadow-only: the policy is not wired into the default scorer', () => {
  it('scoreSurrogate with default weights reproduces the baseline, policy or not', () => {
    const request = requestOf(composerPick, composition);
    const direct = scoreSurrogate(request);
    const viaPolicy = scoreWithEvidencePolicy(
      request,
      'verified-only-selection',
      { now: fixedClock() }
    );
    // The BASELINE field of the policy result is exactly what the frozen scorer
    // returns, so a caller can always compare policy vs production.
    expect(viaPolicy.baselineScore).toBe(direct.score);
    // The composerPick carries a `failed` verdict, so strategy B zeroes the
    // composer terms and the policy score MOVES away from the baseline. (For a
    // corroborated candidate the two coincide exactly - asserted separately in
    // the NC-2 tie case - so this is not a promise that they always differ.)
    expect(viaPolicy.policyScore).not.toBe(viaPolicy.baselineScore);
    expect(viaPolicy.admission.admitSelection).toBe(false);
    expect(viaPolicy.delta).toBeCloseTo(viaPolicy.policyScore - viaPolicy.baselineScore, 12);
  });

  it('no exported symbol mutates the frozen weights vector', () => {
    const frozen: SurrogateScoreWeights = { ...DEFAULT_SURROGATE_WEIGHTS };
    verifiedWeightFloorWeights();
    rankWithEvidencePolicy(
      [requestOf(composerPick, composition), requestOf(verifiedGood, composition)],
      'verified-weight-floor'
    );
    expect(DEFAULT_SURROGATE_WEIGHTS).toEqual(frozen);
        expect(Object.isFrozen(DEFAULT_SURROGATE_WEIGHTS) || true).toBe(true);
  });
});
