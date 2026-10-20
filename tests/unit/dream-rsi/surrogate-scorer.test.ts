import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SURROGATE_WEIGHTS,
  clamp01,
  computeSurrogateSignals,
  createSurrogateScorer,
  normalizeSurrogateWeights,
  scoreSurrogate
} from '../../../src/dream-rsi/surrogate-scorer';
import type { DiscoveryNode, SurrogateScoreWeights } from '../../../src/types/contracts';
import { fixedClock, makeComposition, makeTrajectory } from './fixtures';

const SELECTION_ONLY: SurrogateScoreWeights = {
  selection: 1,
  adoption: 0,
  efficiency: 0,
  toolErrorPenalty: 0
};
const ADOPTION_ONLY: SurrogateScoreWeights = {
  selection: 0,
  adoption: 1,
  efficiency: 0,
  toolErrorPenalty: 0
};
const EFFICIENCY_ONLY: SurrogateScoreWeights = {
  selection: 0,
  adoption: 0,
  efficiency: 1,
  toolErrorPenalty: 0
};
const PENALTY_ONLY: SurrogateScoreWeights = {
  selection: 0,
  adoption: 0,
  efficiency: 0,
  toolErrorPenalty: 1
};

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

describe('clamp01 and weight normalization', () => {
  it('clamps arbitrary numbers into [0, 1]', () => {
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('ships the frozen configuration defaults', () => {
    expect(DEFAULT_SURROGATE_WEIGHTS).toEqual({
      selection: 0.4,
      adoption: 0.3,
      efficiency: 0.2,
      toolErrorPenalty: 0.1
    });
  });

  it('normalizes, coerces and falls back on invalid weights', () => {
    const normalized = normalizeSurrogateWeights({
      selection: 2,
      adoption: 2,
      efficiency: 0,
      toolErrorPenalty: 0
    });
    expect(normalized.normalized).toBe(true);
    expect(normalized.weights.selection).toBeCloseTo(0.5, 10);
    expect(normalized.weights.adoption).toBeCloseTo(0.5, 10);
    expect(normalized.diagnostics.join(' ')).toContain('normalized');

    const coerced = normalizeSurrogateWeights({
      selection: -1,
      adoption: 1,
      efficiency: 0,
      toolErrorPenalty: 0
    });
    expect(coerced.weights.selection).toBe(0);
    expect(coerced.weights.adoption).toBe(1);
    expect(coerced.diagnostics.join(' ')).toContain('coerced');

    const fallback = normalizeSurrogateWeights({
      selection: 0,
      adoption: 0,
      efficiency: 0,
      toolErrorPenalty: 0
    });
    expect(fallback.weights).toEqual(DEFAULT_SURROGATE_WEIGHTS);
    expect(fallback.diagnostics.join(' ')).toContain('defaults');

    const exact = normalizeSurrogateWeights(DEFAULT_SURROGATE_WEIGHTS);
    expect(exact.normalized).toBe(false);
    expect(exact.diagnostics).toEqual([]);
  });
});

describe('surrogate signals', () => {
  it('derives selection and adoption from the composer verdict', () => {
    const target = node({ id: 'n1', branchId: 'b1' });
    const request = {
      node: target,
      trajectory: makeTrajectory({ nodeId: 'n1', branchId: 'b1' }),
      composition: makeComposition({
        selectedNodeId: 'n1',
        selectedBranchId: 'b1',
        adoptionRatios: { b1: 0.75 }
      }),
      weights: DEFAULT_SURROGATE_WEIGHTS
    };
    const { signals, evidence } = computeSurrogateSignals(request);
    expect(signals.selected).toBe(true);
    expect(signals.adoptionRatio).toBeCloseTo(0.75, 10);
    expect(evidence.join(' ')).toContain('adoptionRatio');
    expect(evidence.join(' ')).toContain('selected=1');
  });

  it('marks non-selected nodes and clamps out-of-range adoption', () => {
    const request = {
      node: node({ id: 'n2', branchId: 'b2' }),
      trajectory: makeTrajectory({ branchId: 'b2' }),
      composition: makeComposition({
        selectedNodeId: 'n1',
        selectedBranchId: 'b1',
        adoptionRatios: { b2: 4 }
      }),
      weights: DEFAULT_SURROGATE_WEIGHTS
    };
    const { signals } = computeSurrogateSignals(request);
    expect(signals.selected).toBe(false);
    expect(signals.adoptionRatio).toBe(1);
  });

  it('falls back to assessments and node adoption ratios', () => {
    const viaAssessment = computeSurrogateSignals({
      node: node({ id: 'n3', branchId: 'b3' }),
      trajectory: makeTrajectory({ branchId: 'b3' }),
      composition: makeComposition({
        assessments: [
          {
            alias: 'A',
            branchId: 'b3',
            nodeId: 'n3',
            selected: false,
            adoptionRatio: 0.33,
            contrasts: [],
            rationale: 'ok'
          }
        ]
      }),
      weights: DEFAULT_SURROGATE_WEIGHTS
    });
    expect(viaAssessment.signals.adoptionRatio).toBeCloseTo(0.33, 10);

    const viaNode = computeSurrogateSignals({
      node: node({ adoptionRatio: 0.2 }),
      trajectory: makeTrajectory(),
      weights: DEFAULT_SURROGATE_WEIGHTS
    });
    expect(viaNode.signals.adoptionRatio).toBeCloseTo(0.2, 10);

    const none = computeSurrogateSignals({
      node: node(),
      trajectory: makeTrajectory({ status: 'failed' }),
      weights: DEFAULT_SURROGATE_WEIGHTS
    });
    expect(none.signals.adoptionRatio).toBe(0);
    expect(none.signals.selected).toBe(false);
  });

  it('computes step efficiency against a reference run', () => {
    const cheaper = computeSurrogateSignals({
      node: node(),
      trajectory: makeTrajectory({ metrics: { steps: 4, toolCalls: 4 } }),
      referenceTrajectory: makeTrajectory({ id: 'ref', metrics: { steps: 8, toolCalls: 8 } }),
      weights: DEFAULT_SURROGATE_WEIGHTS
    });
    expect(cheaper.signals.stepEfficiency).toBe(1);

    const pricier = computeSurrogateSignals({
      node: node(),
      trajectory: makeTrajectory({ metrics: { steps: 16, toolCalls: 16 } }),
      referenceTrajectory: makeTrajectory({ id: 'ref', metrics: { steps: 8, toolCalls: 8 } }),
      weights: DEFAULT_SURROGATE_WEIGHTS
    });
    expect(pricier.signals.stepEfficiency).toBeCloseTo(0.5, 10);
  });

  it('uses the documented baseline when no reference exists', () => {
    const atBaseline = computeSurrogateSignals({
      node: node(),
      trajectory: makeTrajectory({ metrics: { steps: 10, toolCalls: 3 } }),
      weights: DEFAULT_SURROGATE_WEIGHTS
    });
    expect(atBaseline.signals.stepEfficiency).toBe(1);
    const longRun = computeSurrogateSignals({
      node: node(),
      trajectory: makeTrajectory({ metrics: { steps: 21, toolCalls: 3 } }),
      weights: DEFAULT_SURROGATE_WEIGHTS
    });
    expect(longRun.signals.stepEfficiency).toBeCloseTo(11 / 22, 10);
  });

  it('computes the tool error rate from metrics, not just the error list', () => {
    const metricsOnly = computeSurrogateSignals({
      node: node(),
      trajectory: makeTrajectory({ metrics: { steps: 6, toolCalls: 4, toolErrors: 2 } }),
      weights: DEFAULT_SURROGATE_WEIGHTS
    });
    expect(metricsOnly.signals.toolErrorRate).toBeCloseTo(0.5, 10);

    const noCalls = computeSurrogateSignals({
      node: node(),
      trajectory: makeTrajectory({ metrics: { steps: 1, toolCalls: 0, toolErrors: 0 } }),
      weights: DEFAULT_SURROGATE_WEIGHTS
    });
    expect(noCalls.signals.toolErrorRate).toBe(0);
  });
});

describe('surrogate scoring', () => {
  it('uses the selection signal', () => {
    const selected = scoreSurrogate({
      node: node(),
      trajectory: makeTrajectory(),
      composition: makeComposition({ selectedNodeId: 'n1' }),
      weights: SELECTION_ONLY
    });
    expect(selected.score).toBe(1);

    const notSelected = scoreSurrogate({
      node: node(),
      trajectory: makeTrajectory({ status: 'failed' }),
      composition: makeComposition({ selectedNodeId: 'other' }),
      weights: SELECTION_ONLY
    });
    expect(notSelected.score).toBe(0);
  });

  it('uses the adoption signal', () => {
    const score = scoreSurrogate({
      node: node({ adoptionRatio: 0.25 }),
      trajectory: makeTrajectory(),
      weights: ADOPTION_ONLY
    });
    expect(score.score).toBeCloseTo(0.25, 10);
  });

  it('uses the efficiency signal', () => {
    const score = scoreSurrogate({
      node: node(),
      trajectory: makeTrajectory({ metrics: { steps: 5, toolCalls: 5 } }),
      referenceTrajectory: makeTrajectory({ id: 'ref', metrics: { steps: 5, toolCalls: 5 } }),
      weights: EFFICIENCY_ONLY
    });
    expect(score.score).toBeCloseTo(1, 10);
  });

  it('uses the tool-error penalty signal', () => {
    const score = scoreSurrogate({
      node: node(),
      trajectory: makeTrajectory({ metrics: { steps: 4, toolCalls: 4, toolErrors: 4 } }),
      weights: PENALTY_ONLY
    });
    expect(score.score).toBe(0);
    expect(score.signals.toolErrorRate).toBe(1);
  });

  it('combines all four signals with the default weights', () => {
    const score = scoreSurrogate({
      node: node({ adoptionRatio: 0.5 }),
      trajectory: makeTrajectory({ metrics: { steps: 5, toolCalls: 4, toolErrors: 1 } }),
      referenceTrajectory: makeTrajectory({ id: 'ref', metrics: { steps: 10, toolCalls: 8 } }),
      composition: makeComposition({ selectedNodeId: 'n1', adoptionRatios: { b1: 0.5 } }),
      weights: DEFAULT_SURROGATE_WEIGHTS
    });
    // 0.4 * 1 + 0.3 * 0.5 + 0.2 * 1 - 0.1 * 0.25 = 0.725
    expect(score.score).toBeCloseTo(0.725, 10);
    expect(score.signals.selected).toBe(true);
    expect(score.weights).toEqual(DEFAULT_SURROGATE_WEIGHTS);
    expect(score.nodeId).toBe('n1');
    expect(score.evidence.join(' ')).toContain('clamped');
    expect(score.evidence.join(' ')).toContain('toolErrorRate');
  });

  it('clamps scores into [0, 1]', () => {
    const oversized = scoreSurrogate({
      node: node({ adoptionRatio: 1 }),
      trajectory: makeTrajectory({ metrics: { steps: 1, toolCalls: 4, toolErrors: 0 } }),
      composition: makeComposition({ selectedNodeId: 'n1', adoptionRatios: { b1: 1 } }),
      referenceTrajectory: makeTrajectory({ id: 'ref', metrics: { steps: 8, toolCalls: 8 } }),
      weights: { selection: 1, adoption: 1, efficiency: 1, toolErrorPenalty: 0 }
    });
    expect(oversized.score).toBe(1);

    const negative = scoreSurrogate({
      node: node(),
      trajectory: makeTrajectory({ status: 'failed', metrics: { steps: 30, toolCalls: 4, toolErrors: 4 } }),
      referenceTrajectory: makeTrajectory({ id: 'ref', metrics: { steps: 2, toolCalls: 2 } }),
      composition: makeComposition({ selectedNodeId: 'other' }),
      weights: { selection: 0, adoption: 1, efficiency: 0, toolErrorPenalty: 1 }
    });
    expect(negative.score).toBe(0);
  });

  it('honours an injected clock and default weights', () => {
    const scorer = createSurrogateScorer({ now: fixedClock(100), baselineSteps: 4 });
    const score = scorer.score({
      node: node({ adoptionRatio: 0.1 }),
      trajectory: makeTrajectory({ metrics: { steps: 3, toolCalls: 2 } }),
      weights: DEFAULT_SURROGATE_WEIGHTS
    });
    expect(score.computedAt).toBe(101);
    expect(score.score).toBeGreaterThanOrEqual(0);
    expect(score.score).toBeLessThanOrEqual(1);
  });
});
