/**
 * P3-2 (rev5 t12): surrogate SELF-REFERENCE counterexample.
 *
 * THE DEFECT THIS PINS
 * --------------------
 * The verifier-free surrogate reward is
 *
 *   s = w1·selected + w2·adoptionRatio + w3·stepEfficiency − w4·toolErrorRate
 *
 * with the shipped defaults w = (0.4, 0.3, 0.2, 0.1). The first two signals are
 * read from the Composer's OWN verdict (selectedNodeId / adoptionRatios), so a
 * node the Composer picks wrong still scores high: the surrogate reproduces the
 * Composer's error instead of checking it. That is self-reference.
 *
 * THE COUNTEREXAMPLE (Composer wrong, verifiable evidence opposite)
 * ----------------------------------------------------------------
 *   node X (Composer's pick): selected, adoption 1.0 — but 18 steps and a 0.5
 *     tool-error rate; its deliverable FAILS an independent content check.
 *   node Y (not picked): unselected, adoption 0 — but 5 steps, no tool errors;
 *     its deliverable PASSES the same content check.
 *
 *   full weights   rank X first (w1+w2 = 0.7 of the score is Composer opinion)
 *   de-w1/w2       rank Y first (only the evidence-bearing terms remain)
 *
 * The "de-w1/w2" comparison is the audit instrument. It is NOT itself the
 * adjustment rule: the re-ranking is accepted ONLY because an independent
 * verifier says the same thing. A negative control proves this: when the two
 * candidates are EVIDENCE-EQUAL, deleting w1/w2 produces a tie and does not
 * flip the ranking — so the flip above is driven by the verifiable difference,
 * not by the arithmetic of weight deletion.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SURROGATE_WEIGHTS,
  createSurrogateScorer,
  normalizeSurrogateWeights,
  scoreSurrogate
} from '../../../src/dream-rsi/surrogate-scorer';
import { DEFAULT_EVO_HARNESS_CONFIG } from '../../../src/config';
import type {
  CompositionResult,
  DiscoveryNode,
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

/** The de-w1/w2 weights: the Composer-derived signals are removed. */
const EVIDENCE_ONLY_WEIGHTS: SurrogateScoreWeights = {
  selection: 0,
  adoption: 0,
  efficiency: DEFAULT_SURROGATE_WEIGHTS.efficiency,
  toolErrorPenalty: DEFAULT_SURROGATE_WEIGHTS.toolErrorPenalty
};

/**
 * An INDEPENDENT, verifiable check: the deliverable must literally contain
 * "PASS". It never reads the Composer, the node selection or any surrogate
 * signal — that is what makes it evidence rather than another opinion.
 */
function verifierAccepts(deliverable: { readonly content: string } | undefined): boolean {
  return deliverable !== undefined && deliverable.content.includes('PASS');
}

interface Candidate {
  readonly node: DiscoveryNode;
  readonly deliverable: string;
  readonly steps: number;
  readonly toolCalls: number;
  readonly toolErrors: number;
}

function scoreCandidate(
  candidate: Candidate,
  composition: CompositionResult,
  weights: SurrogateScoreWeights
) {
  return scoreSurrogate({
    node: candidate.node,
    trajectory: makeTrajectory({
      nodeId: candidate.node.id,
      branchId: candidate.node.branchId,
      deliverable: { content: candidate.deliverable, format: 'text' },
      metrics: {
        steps: candidate.steps,
        toolCalls: candidate.toolCalls,
        toolErrors: candidate.toolErrors
      }
    }),
    composition,
    weights
  });
}

function rankedByScore(
  candidates: readonly Candidate[],
  composition: CompositionResult,
  weights: SurrogateScoreWeights
): string[] {
  return candidates
    .map((candidate) => ({ id: candidate.node.id, score: scoreCandidate(candidate, composition, weights).score }))
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.id);
}

// ---------------------------------------------------------------------------
// the counterexample
// ---------------------------------------------------------------------------

const composerPick: Candidate = {
  node: node({ id: 'n-composer-pick', branchId: 'b-pick' }),
  deliverable: 'result: FAIL (assertion failed in check_contract)',
  steps: 18,
  toolCalls: 6,
  toolErrors: 3
};

const verifiedGood: Candidate = {
  node: node({ id: 'n-verified', branchId: 'b-good' }),
  deliverable: 'result: PASS (all contract assertions hold)',
  steps: 5,
  toolCalls: 6,
  toolErrors: 0
};

const composition: CompositionResult = makeComposition({
  selectedNodeId: composerPick.node.id,
  selectedBranchId: composerPick.node.branchId,
  adoptionRatios: { [composerPick.node.id]: 1 }
});

describe('P3-2: the full-weight surrogate reproduces a wrong Composer verdict', () => {
  it('the Composer pick outranks the verifiably-correct node', () => {
    const ranking = rankedByScore([composerPick, verifiedGood], composition, DEFAULT_SURROGATE_WEIGHTS);
    expect(ranking).toEqual([composerPick.node.id, verifiedGood.node.id]);
  });

  it('the evidence says the OPPOSITE: the pick fails, the unpicked node passes', () => {
    expect(verifierAccepts({ content: composerPick.deliverable })).toBe(false);
    expect(verifierAccepts({ content: verifiedGood.deliverable })).toBe(true);
    // the surrogate sees only the Composer for these two signals
    const picked = scoreCandidate(composerPick, composition, DEFAULT_SURROGATE_WEIGHTS);
    expect(picked.signals.selected).toBe(true);
    expect(picked.signals.adoptionRatio).toBe(1);
    expect(picked.evidence.join('\n')).toContain('composition selectedNodeId=n-composer-pick');
    const unpicked = scoreCandidate(verifiedGood, composition, DEFAULT_SURROGATE_WEIGHTS);
    expect(unpicked.signals.selected).toBe(false);
    expect(unpicked.signals.adoptionRatio).toBe(0);
  });

  it('the score gap is dominated by the Composer-derived terms', () => {
    const picked = scoreCandidate(composerPick, composition, DEFAULT_SURROGATE_WEIGHTS);
    const unpicked = scoreCandidate(verifiedGood, composition, DEFAULT_SURROGATE_WEIGHTS);
    // w1 + w2 = 0.7 of the scale is pure Composer opinion in the wrong direction
    expect(picked.score - unpicked.score).toBeGreaterThan(0.5);
    expect(picked.weights).toEqual(DEFAULT_SURROGATE_WEIGHTS);
  });
});

describe('P3-2: the de-w1/w2 comparison is the audit, not the adjustment', () => {
  it('removing w1/w2 flips the ranking to agree with the verifier', () => {
    const full = rankedByScore([composerPick, verifiedGood], composition, DEFAULT_SURROGATE_WEIGHTS);
    const deW12 = rankedByScore([composerPick, verifiedGood], composition, EVIDENCE_ONLY_WEIGHTS);
    expect(full).toEqual([composerPick.node.id, verifiedGood.node.id]);
    expect(deW12).toEqual([verifiedGood.node.id, composerPick.node.id]);
    // the evidence-based verdict (computed without the Composer) is the SAME
    // ordering: this is what licenses the re-ranking, not the arithmetic.
    const evidenceOrder = [verifiedGood, composerPick]
      .filter((candidate) => verifierAccepts({ content: candidate.deliverable }))
      .map((candidate) => candidate.node.id);
    expect(evidenceOrder).toEqual([verifiedGood.node.id]);
  });

  it('the de-w1/w2 weights are a normalization of the frozen defaults, not a new tuned vector', () => {
    const effective = normalizeSurrogateWeights(EVIDENCE_ONLY_WEIGHTS);
    expect(effective.normalized).toBe(true);
    expect(effective.weights.selection).toBe(0);
    expect(effective.weights.adoption).toBe(0);
    // the remaining two keep their frozen RATIO (0.2 : 0.1)
    expect(effective.weights.efficiency / effective.weights.toolErrorPenalty).toBeCloseTo(2, 12);
    expect(effective.weights.efficiency + effective.weights.toolErrorPenalty).toBeCloseTo(1, 12);
    // and the shipped defaults are untouched
    expect(DEFAULT_SURROGATE_WEIGHTS).toEqual({
      selection: DEFAULT_EVO_HARNESS_CONFIG.dreamRsi.surrogateWeights.selection,
      adoption: DEFAULT_EVO_HARNESS_CONFIG.dreamRsi.surrogateWeights.adoption,
      efficiency: DEFAULT_EVO_HARNESS_CONFIG.dreamRsi.surrogateWeights.efficiency,
      toolErrorPenalty: DEFAULT_EVO_HARNESS_CONFIG.dreamRsi.surrogateWeights.toolErrorPenalty
    });
    expect(DEFAULT_SURROGATE_WEIGHTS).toEqual({
      selection: 0.4,
      adoption: 0.3,
      efficiency: 0.2,
      toolErrorPenalty: 0.1
    });
  });

  it('NEGATIVE CONTROL: when the candidates are evidence-equal, de-w1/w2 does NOT flip', () => {
    // Same steps, same tool-error count, same (unselected) Composer status:
    // the only difference is the Composer's pick. If deleting w1/w2 flipped
    // this pair, the "audit" would be a free re-ranking, not evidence.
    const tieA: Candidate = {
      node: node({ id: 'n-tie-a', branchId: 'b-tie-a' }),
      deliverable: 'result: PASS',
      steps: 7,
      toolCalls: 4,
      toolErrors: 0
    };
    const tieB: Candidate = {
      node: node({ id: 'n-tie-b', branchId: 'b-tie-b' }),
      deliverable: 'result: PASS',
      steps: 7,
      toolCalls: 4,
      toolErrors: 0
    };
    const tieComposition = makeComposition({
      selectedNodeId: tieA.node.id,
      selectedBranchId: tieA.node.branchId,
      adoptionRatios: { [tieA.node.id]: 1 }
    });
    const full = rankedByScore([tieA, tieB], tieComposition, DEFAULT_SURROGATE_WEIGHTS);
    expect(full).toEqual([tieA.node.id, tieB.node.id]);
    const deW12 = rankedByScore([tieA, tieB], tieComposition, EVIDENCE_ONLY_WEIGHTS);
    // exact tie: the comparator keeps the input order, and no evidence-driven
    // difference exists to justify a re-ranking.
    const scores = [tieA, tieB].map((candidate) => scoreCandidate(candidate, tieComposition, EVIDENCE_ONLY_WEIGHTS).score);
    expect(scores[0]).toBeCloseTo(scores[1] ?? Number.NaN, 12);
    expect(deW12).toEqual([tieA.node.id, tieB.node.id]);
    expect(verifierAccepts({ content: tieA.deliverable }) && verifierAccepts({ content: tieB.deliverable })).toBe(true);
  });
});

describe('P3-2: the scorer keeps its frozen contract while exposing the defect', () => {
  it('every score stays clamped to [0, 1] under adversarial weights', () => {
    const adversarial: SurrogateScoreWeights = {
      selection: 5,
      adoption: 5,
      efficiency: 0,
      toolErrorPenalty: 0
    };
    const scored = scoreCandidate(composerPick, composition, adversarial);
    expect(scored.score).toBeLessThanOrEqual(1);
    expect(scored.score).toBeGreaterThanOrEqual(0);
    expect(scored.weights.selection + scored.weights.adoption).toBeCloseTo(1, 12);
  });

  it('createSurrogateScorer uses the same evidence-preserving path', () => {
    const scorer = createSurrogateScorer({ now: fixedClock() });
    const full = scorer.score({
      node: composerPick.node,
      trajectory: makeTrajectory({
        nodeId: composerPick.node.id,
        branchId: composerPick.node.branchId,
        deliverable: { content: composerPick.deliverable, format: 'text' },
        metrics: { steps: composerPick.steps, toolCalls: composerPick.toolCalls, toolErrors: composerPick.toolErrors }
      }),
      composition,
      weights: DEFAULT_SURROGATE_WEIGHTS
    });
    expect(full.score).toBeGreaterThan(0.5);
    expect(full.evidence.join('\n')).toContain('terms: selection=');
    // The evidence trail names who asserted "selected" — the Composer, not a
    // verifier. That is the self-reference the report must disclose.
    expect(full.evidence.join('\n')).toContain('(composition selectedNodeId=');
  });
});
