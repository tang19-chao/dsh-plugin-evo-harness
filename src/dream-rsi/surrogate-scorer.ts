/**
 * Dream-RSI verifier-free surrogate scorer.
 *
 * Ownership: src/dream-rsi/** (Wave 1, Dream-RSI layer).
 *
 * Open-world tasks have no ground-truth verifier, so the offline replay stage
 * needs a scalar reward per node (ARCHITECTURE.md 5.2):
 *
 *   s_v = w1 * I(v selected as final H*) + w2 * AdoptionRatio(v)
 *       + w3 * StepEfficiency(v) - w4 * ToolErrorRate(v)
 *
 * All four signals are normalized to [0, 1] and the final score is clamped to
 * [0, 1] per the frozen contract (contracts.ts host assumption 5).
 */

import type {
  CompositionResult,
  DiscoveryNode,
  ISurrogateScorer,
  ProbeTrajectory,
  SurrogateScore,
  SurrogateScoreRequest,
  SurrogateScoreWeights,
  SurrogateSignals
} from '../types/contracts';
import { DEFAULT_EVO_HARNESS_CONFIG } from '../config';

/** Clamp any number into [0, 1]; NaN becomes 0, infinities saturate. */
export function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

/** Normalized weights shipped in the frozen default configuration. */
export const DEFAULT_SURROGATE_WEIGHTS: SurrogateScoreWeights = {
  selection: DEFAULT_EVO_HARNESS_CONFIG.dreamRsi.surrogateWeights.selection,
  adoption: DEFAULT_EVO_HARNESS_CONFIG.dreamRsi.surrogateWeights.adoption,
  efficiency: DEFAULT_EVO_HARNESS_CONFIG.dreamRsi.surrogateWeights.efficiency,
  toolErrorPenalty: DEFAULT_EVO_HARNESS_CONFIG.dreamRsi.surrogateWeights.toolErrorPenalty
};

/** Step count that counts as "efficient" when no reference run exists. */
export const DEFAULT_BASELINE_STEPS = 10;

/** Scorer options. */
export interface SurrogateScorerOptions {
  readonly defaultWeights?: SurrogateScoreWeights;
  readonly baselineSteps?: number;
  readonly now?: () => number;
}

/** Effective weights plus any sanitization diagnostics. */
export interface EffectiveWeights {
  readonly weights: SurrogateScoreWeights;
  readonly normalized: boolean;
  readonly diagnostics: readonly string[];
}

function sanitizeWeight(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Repair weights so the surrogate stays a convex combination: negative and
 * non-finite entries become 0, an all-zero vector falls back to the frozen
 * defaults, and a vector that does not sum to 1 is normalized.
 */
export function normalizeSurrogateWeights(
  weights: SurrogateScoreWeights,
  fallback: SurrogateScoreWeights = DEFAULT_SURROGATE_WEIGHTS
): EffectiveWeights {
  const diagnostics: string[] = [];
  const selection = sanitizeWeight(weights.selection);
  const adoption = sanitizeWeight(weights.adoption);
  const efficiency = sanitizeWeight(weights.efficiency);
  const toolErrorPenalty = sanitizeWeight(weights.toolErrorPenalty);
  const sum = selection + adoption + efficiency + toolErrorPenalty;
  if (sum <= 0) {
    diagnostics.push('all surrogate weights were zero or invalid; using defaults');
    return { weights: fallback, normalized: false, diagnostics };
  }
  if (
    weights.selection !== selection ||
    weights.adoption !== adoption ||
    weights.efficiency !== efficiency ||
    weights.toolErrorPenalty !== toolErrorPenalty
  ) {
    diagnostics.push('negative or non-finite surrogate weights coerced to 0');
  }
  if (Math.abs(sum - 1) <= 1e-9) {
    return {
      weights: { selection, adoption, efficiency, toolErrorPenalty },
      normalized: false,
      diagnostics
    };
  }
  diagnostics.push('surrogate weights did not sum to 1; normalized by ' + sum.toFixed(6));
  return {
    weights: {
      selection: selection / sum,
      adoption: adoption / sum,
      efficiency: efficiency / sum,
      toolErrorPenalty: toolErrorPenalty / sum
    },
    normalized: true,
    diagnostics
  };
}

function adoptionFromComposition(
  node: DiscoveryNode,
  composition: CompositionResult
): number | undefined {
  const ratios = composition.adoptionRatios;
  const byBranch = ratios[node.branchId];
  if (typeof byBranch === 'number') {
    return byBranch;
  }
  const byNode = ratios[node.id];
  if (typeof byNode === 'number') {
    return byNode;
  }
  return undefined;
}

function resolveSelection(
  node: DiscoveryNode,
  trajectory: ProbeTrajectory,
  composition: CompositionResult | undefined
): { selected: boolean; evidence: string } {
  if (composition !== undefined) {
    const selected =
      composition.selectedNodeId === node.id ||
      (composition.selectedBranchId !== null && composition.selectedBranchId === node.branchId);
    return {
      selected,
      evidence:
        'selected=' +
        (selected ? '1' : '0') +
        ' (composition selectedNodeId=' +
        String(composition.selectedNodeId) +
        ', selectedBranchId=' +
        String(composition.selectedBranchId) +
        ')'
    };
  }
  const selected = node.status === 'succeeded' && trajectory.status === 'succeeded';
  return {
    selected,
    evidence:
      'selected=' +
      (selected ? '1' : '0') +
      ' (no composition; succeeded=' +
      String(node.status === 'succeeded' && trajectory.status === 'succeeded') +
      ')'
  };
}

/** Compute the four normalized surrogate signals plus human-readable evidence. */
export function computeSurrogateSignals(
  request: SurrogateScoreRequest,
  options: SurrogateScorerOptions = {}
): { readonly signals: SurrogateSignals; readonly evidence: readonly string[] } {
  const baselineSteps =
    options.baselineSteps !== undefined && options.baselineSteps > 0
      ? options.baselineSteps
      : DEFAULT_BASELINE_STEPS;
  const trajectory = request.trajectory;
  const metrics = trajectory.metrics;
  const evidence: string[] = [];
  const selection = resolveSelection(request.node, trajectory, request.composition);
  evidence.push(selection.evidence);

  let adoptionRaw = 0;
  if (request.composition !== undefined) {
    const fromComposition = adoptionFromComposition(request.node, request.composition);
    if (fromComposition !== undefined) {
      adoptionRaw = fromComposition;
      evidence.push('adoptionRatio=' + String(adoptionRaw) + ' (composition)');
    } else {
      const fromAssessment = request.composition.assessments.find(
        (assessment) => assessment.nodeId === request.node.id || assessment.branchId === request.node.branchId
      );
      if (fromAssessment !== undefined) {
        adoptionRaw = fromAssessment.adoptionRatio;
        evidence.push('adoptionRatio=' + String(adoptionRaw) + ' (assessment)');
      } else {
        evidence.push('adoptionRatio=0 (node absent from composition)');
      }
    }
  } else if (request.node.adoptionRatio !== undefined) {
    adoptionRaw = request.node.adoptionRatio;
    evidence.push('adoptionRatio=' + String(adoptionRaw) + ' (node)');
  } else {
    evidence.push('adoptionRatio=0 (no composition or node ratio)');
  }
  const adoptionRatio = clamp01(adoptionRaw);

  const steps = Math.max(0, Math.floor(metrics.steps));
  const referenceSteps = request.referenceTrajectory?.metrics.steps;
  let stepEfficiency: number;
  if (referenceSteps !== undefined && referenceSteps > 0) {
    stepEfficiency = clamp01(referenceSteps / Math.max(1, steps));
    evidence.push(
      'stepEfficiency=' +
        stepEfficiency.toFixed(4) +
        ' (candidate ' +
        String(steps) +
        ' steps vs reference ' +
        String(referenceSteps) +
        ')'
    );
  } else {
    stepEfficiency = clamp01((baselineSteps + 1) / (steps + 1));
    evidence.push(
      'stepEfficiency=' +
        stepEfficiency.toFixed(4) +
        ' (candidate ' +
        String(steps) +
        ' steps vs baseline ' +
        String(baselineSteps) +
        ')'
    );
  }

  const errorCount = Math.max(metrics.toolErrors, trajectory.toolErrors.length);
  const toolCalls = Math.max(metrics.toolCalls, 0);
  const denominator = Math.max(1, toolCalls, errorCount);
  const toolErrorRate = clamp01(errorCount / denominator);
  evidence.push(
    'toolErrorRate=' +
      toolErrorRate.toFixed(4) +
      ' (' +
      String(errorCount) +
      ' errors over ' +
      String(denominator) +
      ' calls)'
  );

  return {
    signals: {
      selected: selection.selected,
      adoptionRatio,
      stepEfficiency,
      toolErrorRate
    },
    evidence
  };
}

/** Score one node from its trajectory and the composer verdict. */
export function scoreSurrogate(
  request: SurrogateScoreRequest,
  options: SurrogateScorerOptions = {}
): SurrogateScore {
  const effective = normalizeSurrogateWeights(
    request.weights,
    options.defaultWeights ?? DEFAULT_SURROGATE_WEIGHTS
  );
  const computed = computeSurrogateSignals(request, options);
  const signals = computed.signals;
  const weights = effective.weights;
  const selectedTerm = weights.selection * (signals.selected ? 1 : 0);
  const adoptionTerm = weights.adoption * signals.adoptionRatio;
  const efficiencyTerm = weights.efficiency * signals.stepEfficiency;
  const penaltyTerm = weights.toolErrorPenalty * signals.toolErrorRate;
  const raw = selectedTerm + adoptionTerm + efficiencyTerm - penaltyTerm;
  const score = clamp01(raw);
  const evidence: string[] = [...computed.evidence, ...effective.diagnostics];
  evidence.push(
    'terms: selection=' +
      selectedTerm.toFixed(4) +
      ' adoption=' +
      adoptionTerm.toFixed(4) +
      ' efficiency=' +
      efficiencyTerm.toFixed(4) +
      ' toolErrorPenalty=-' +
      penaltyTerm.toFixed(4)
  );
  evidence.push('raw=' + raw.toFixed(6) + ' clamped=' + score.toFixed(6));
  const now = options.now ?? ((): number => Date.now());
  return {
    nodeId: request.node.id,
    score,
    signals,
    weights,
    computedAt: now(),
    evidence
  };
}

class SurrogateScorerImpl implements ISurrogateScorer {
  private readonly options: SurrogateScorerOptions;

  constructor(options: SurrogateScorerOptions) {
    this.options = options;
  }

  score(request: SurrogateScoreRequest): SurrogateScore {
    return scoreSurrogate(request, this.options);
  }
}

/** Create the post-hoc surrogate scorer. */
export function createSurrogateScorer(
  options: SurrogateScorerOptions = {}
): ISurrogateScorer {
  return new SurrogateScorerImpl(options);
}
