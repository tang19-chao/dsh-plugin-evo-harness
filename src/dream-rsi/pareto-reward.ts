/**
 * Pareto budget-attainment reward for offline dream replays (rev8, plan §6.1 P2).
 *
 * Port of the upstream dream-rsi ranking fitness -
 * dream_rsi/learning/heuristic_search/eval.py `_trace_auc` (lines 468-497) and
 * `_pareto_summary` (lines 500-595) - adapted to the local zero-execution
 * replay data model:
 *
 *  - This module is pure math and free of replay types: callers hand over
 *    per-trace (budget, best) points across the rho preferences, the trace's
 *    own score ceiling (`runBest`) and its exhaustive probe reference
 *    (`evaluatedNodes`). offline-dreamer.ts builds those inputs from
 *    PolicyReplayRun outcomes and projects the summary onto the dream report.
 *  - The sequential-round penalty weight (lambda) is EXPLICITLY injected by
 *    the caller; nothing here derives it from configuration or environment.
 *  - Upstream defaults a trace's parallel penalty to 1.0 when its points carry
 *    no effective sequential rounds. That default is deliberately NOT copied:
 *    an absent measurement is reported as 'unknown' instead of a fabricated
 *    0/1, and the reward degrades to 'unknown' with it. The legacy
 *    scalarized-utility hypervolume (PolicyEvaluation.hypervolume) stays the
 *    selection criterion either way.
 *  - The AUC here is a DIFFERENT quantity from PolicyEvaluation.hypervolume
 *    (the mean scalarized utility over rho). Both belong to the hypervolume
 *    family but have different units and meanings; they live in separate
 *    fields and are never substituted for each other.
 *
 * Semantics (upstream `_trace_auc` docstring): points are (budget, attainment)
 * with attainment = best / runBest in [0, 1]. The non-dominated frontier keeps
 * the cheapest budget for each attainment level and integrates the area it
 * dominates versus the exhaustive reference (refBudget, attain=0), normalized
 * to [0, 1]. Reaching the ceiling with few probes -> ~1; needing the full
 * exhaustive budget (parallel-refine) -> ~0; never scoring -> 0.
 */

/** Minimum evaluated (probeable) nodes for a trace to carry budget<->attainment signal. */
export const MIN_EVALUATED_NODES_FOR_AUC = 2;

/**
 * Default sequential-round penalty weight (upstream
 * DRSI_REPLAY_PARALLELISM_PENALTY default, eval.py DEFAULT_PARALLELISM_PENALTY).
 * Used only when the caller does not inject an explicit weight.
 */
export const DEFAULT_SEQUENTIAL_PENALTY_WEIGHT = 0.05;

/** One (rho, budget, best) observation of a replayed trace. */
export interface ParetoPointInput {
  /** Budget preference label the point was observed at (diagnostic only). */
  readonly rho: number;
  /** Probes the replay charged at this preference. */
  readonly budget: number;
  /** Raw best score the replay reached at this preference (not normalized). */
  readonly best: number;
  /**
   * Effective sequential rounds the replay recorded at this preference
   * (upstream effective_sequential_rounds). Absent means "not measured":
   * the point contributes no ratio to the sequential penalty instead of a
   * fabricated one.
   */
  readonly effectiveSequentialRounds?: number;
}

/** Per-trace inputs of the pareto reward. */
export interface ParetoTraceInput {
  readonly treeId: string;
  /**
   * The trace's own score ceiling (upstream run_best): the best
   * replay-creditable score over all of the trace's nodes. Attainment is
   * normalized by this per trace, so one easy trace cannot saturate another
   * trace's curve.
   */
  readonly runBest: number;
  /**
   * Exhaustive candidate-probe reference (upstream n_evaluated): the number of
   * probeable nodes a full visit would charge. Traces below
   * {@link MIN_EVALUATED_NODES_FOR_AUC} are skipped - with fewer, budget equals
   * exhaustive for any policy and the normalized AUC is forced to 0.
   */
  readonly evaluatedNodes: number;
  readonly points: readonly ParetoPointInput[];
}

/** One frontier point of a trace's budget<->attainment curve. */
export interface ParetoFrontierPoint {
  readonly rho: number;
  readonly budget: number;
  readonly attain: number;
}

/** Per-trace reward detail. */
export interface ParetoTraceReward {
  readonly treeId: string;
  readonly runBest: number;
  readonly evaluatedNodes: number;
  readonly auc: number;
  readonly frontier: readonly ParetoFrontierPoint[];
  /**
   * Mean over this trace's points of effectiveSequentialRounds / budget.
   * 'unknown' when no point carries a trusted rounds measurement - never a
   * fabricated 0/1.
   */
  readonly sequentialPenalty: number | 'unknown';
}

/** Aggregate pareto reward of one policy over a set of traces. */
export interface ParetoRewardSummary {
  /**
   * Mean per-trace normalized budget<->attainment AUC in [0, 1]. 0 when no
   * trace qualified (see `note` and `skippedTraces` for why).
   */
  readonly auc: number;
  /**
   * Mean per-trace sequential penalty. Numeric only when EVERY scored trace
   * carries trusted rounds; otherwise 'unknown' (a partial mean would present
   * the instrumented subset as the policy's cost over all traces).
   */
  readonly sequentialPenalty: number | 'unknown';
  /** The effective penalty weight lambda (echoed so it is auditable). */
  readonly sequentialPenaltyWeight: number;
  /** auc - weight * sequentialPenalty; 'unknown' whenever the penalty is. */
  readonly reward: number | 'unknown';
  /** Static method description for audit trails. */
  readonly method: string;
  readonly scoredTraces: readonly ParetoTraceReward[];
  readonly skippedTraces: readonly {
    readonly treeId: string;
    readonly reason: string;
  }[];
  /** Present when nothing was scored, saying why. */
  readonly note?: string;
}

/** Options of {@link computeParetoReward}. */
export interface ParetoRewardOptions {
  /**
   * Sequential-round penalty weight lambda, explicitly injected by the caller.
   * Non-finite or negative values fall back to
   * {@link DEFAULT_SEQUENTIAL_PENALTY_WEIGHT} (mirroring the upstream env parse
   * fallback); the effective value is echoed on the summary.
   */
  readonly sequentialPenaltyWeight: number;
}

/** Clamp a score ratio into [0, 1]; NaN and negatives fold to 0. */
function clampUnit(value: number): number {
  if (!(value > 0)) {
    return 0;
  }
  return value > 1 ? 1 : value;
}

function mean(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return values.length > 0 ? total / values.length : 0;
}

/**
 * Resolve the explicitly injected penalty weight: finite and >= 0 passes
 * through, anything else falls back to the documented default.
 */
export function resolveSequentialPenaltyWeight(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return DEFAULT_SEQUENTIAL_PENALTY_WEIGHT;
  }
  return value;
}

/**
 * Convert recorded per-round batch sizes into effective sequential rounds:
 * sum over batches of ceil(batch / maxParallelism). This is the upstream
 * conversion (tests/test_learning.py:258-261). A non-positive parallelism is
 * treated as serial (1); non-positive batches contribute nothing (a round that
 * probed nothing is not a round).
 */
export function batchesToSequentialRounds(
  batchSizes: readonly number[],
  maxParallelism: number
): number {
  const workers = Number.isFinite(maxParallelism)
    ? Math.max(1, Math.floor(maxParallelism))
    : 1;
  let rounds = 0;
  for (const batch of batchSizes) {
    if (!Number.isFinite(batch) || batch <= 0) {
      continue;
    }
    rounds += Math.ceil(batch / workers);
  }
  return rounds;
}

/**
 * Normalized budget<->attainment AUC for ONE trace across the rho preferences.
 *
 * Faithful port of upstream `_trace_auc` (eval.py:468-497): keep the
 * non-dominated frontier (cheapest budget per attainment level, strictly
 * increasing attainment over ascending budget) and integrate the area it
 * dominates versus the exhaustive reference (refBudget, attain=0), normalized
 * by refBudget.
 */
export function traceBudgetAttainmentAuc(
  points: readonly ParetoPointInput[],
  runBest: number,
  refBudget: number
): { auc: number; frontier: readonly ParetoFrontierPoint[] } {
  if (!(refBudget > 0) || !(runBest > 0) || points.length === 0) {
    return { auc: 0, frontier: [] };
  }
  // Best attainment per budget; ties on both budget and attainment keep the
  // first rho seen (upstream's stable sort keeps input order the same way).
  const bestByBudget = new Map<number, { attain: number; rho: number }>();
  const ordered = [...points].sort((left, right) => {
    const byBudget = left.budget - right.budget;
    if (byBudget !== 0) {
      return byBudget;
    }
    return right.best - left.best;
  });
  for (const point of ordered) {
    if (!Number.isFinite(point.budget) || !Number.isFinite(point.best) || point.budget < 0) {
      continue;
    }
    const attain = clampUnit(point.best / runBest);
    const existing = bestByBudget.get(point.budget);
    if (existing === undefined || attain > existing.attain) {
      bestByBudget.set(point.budget, { attain, rho: point.rho });
    }
  }
  const budgets = [...bestByBudget.keys()].sort((left, right) => left - right);
  const frontier: ParetoFrontierPoint[] = [];
  let amax = -1;
  for (const budget of budgets) {
    const entry = bestByBudget.get(budget);
    if (entry === undefined) {
      continue;
    }
    if (entry.attain > amax) {
      // Strictly better attainment than anything cheaper -> on the frontier.
      frontier.push({ rho: entry.rho, budget, attain: entry.attain });
      amax = entry.attain;
    }
  }
  let hypervolume = 0;
  let prevAttain = 0;
  for (const point of frontier) {
    hypervolume += (point.attain - prevAttain) * Math.max(0, refBudget - point.budget);
    prevAttain = point.attain;
  }
  return { auc: hypervolume / refBudget, frontier };
}

/**
 * Aggregate per-trace pareto inputs into the reward summary.
 *
 * Faithful port of upstream `_pareto_summary` (eval.py:500-595) with two
 * deliberate divergences, both honesty-preserving:
 *  1. A trace with no trusted sequential-round measurement contributes an
 *     'unknown' penalty instead of upstream's fabricated 1.0 default.
 *  2. The summary penalty is numeric only when EVERY scored trace has a
 *     numeric penalty; a mean over a subset would present the instrumented
 *     traces' cost as the policy's cost over all of them.
 */
export function computeParetoReward(
  traces: readonly ParetoTraceInput[],
  options: ParetoRewardOptions
): ParetoRewardSummary {
  const weight = resolveSequentialPenaltyWeight(options.sequentialPenaltyWeight);
  const method =
    'mean per-trace normalized budget<->attainment AUC minus ' +
    'lambda-weighted sequential-round penalty';
  const scored: ParetoTraceReward[] = [];
  const skipped: { treeId: string; reason: string }[] = [];
  for (const trace of traces) {
    if (!Number.isFinite(trace.runBest) || trace.runBest <= 0) {
      skipped.push({
        treeId: trace.treeId,
        reason: 'runBest<=0 (degenerate or all-fail trace); attainment cannot be normalized'
      });
      continue;
    }
    if (
      !Number.isFinite(trace.evaluatedNodes) ||
      trace.evaluatedNodes < MIN_EVALUATED_NODES_FOR_AUC
    ) {
      skipped.push({
        treeId: trace.treeId,
        reason:
          'fewer than ' +
          String(MIN_EVALUATED_NODES_FOR_AUC) +
          ' evaluated nodes; budget equals exhaustive for any policy so the normalized AUC is forced to 0'
      });
      continue;
    }
    const usablePoints = trace.points.filter(
      (point) =>
        Number.isFinite(point.budget) &&
        Number.isFinite(point.best) &&
        point.budget >= 0 &&
        point.best >= 0
    );
    if (usablePoints.length === 0) {
      skipped.push({
        treeId: trace.treeId,
        reason: 'no finite (budget, best) points to score'
      });
      continue;
    }
    const { auc, frontier } = traceBudgetAttainmentAuc(
      usablePoints,
      trace.runBest,
      trace.evaluatedNodes
    );
    const ratios: number[] = [];
    for (const point of usablePoints) {
      const rounds = point.effectiveSequentialRounds;
      if (rounds !== undefined && Number.isFinite(rounds) && rounds >= 0 && point.budget > 0) {
        ratios.push(rounds / point.budget);
      }
    }
    scored.push({
      treeId: trace.treeId,
      runBest: trace.runBest,
      evaluatedNodes: trace.evaluatedNodes,
      auc,
      frontier,
      sequentialPenalty: ratios.length > 0 ? mean(ratios) : 'unknown'
    });
  }
  if (scored.length === 0) {
    return {
      auc: 0,
      sequentialPenalty: 'unknown',
      sequentialPenaltyWeight: weight,
      reward: 'unknown',
      method,
      scoredTraces: [],
      skippedTraces: skipped,
      note:
        'no trace with runBest>0 and evaluatedNodes>=' +
        String(MIN_EVALUATED_NODES_FOR_AUC) +
        ' to score'
    };
  }
  let allPenaltiesKnown = true;
  let penaltySum = 0;
  for (const trace of scored) {
    if (typeof trace.sequentialPenalty === 'number') {
      penaltySum += trace.sequentialPenalty;
    } else {
      allPenaltiesKnown = false;
    }
  }
  const meanAuc = mean(scored.map((trace) => trace.auc));
  const summaryPenalty: number | 'unknown' = allPenaltiesKnown
    ? penaltySum / scored.length
    : 'unknown';
  return {
    auc: meanAuc,
    sequentialPenalty: summaryPenalty,
    sequentialPenaltyWeight: weight,
    reward:
      typeof summaryPenalty === 'number' ? meanAuc - weight * summaryPenalty : 'unknown',
    method,
    scoredTraces: scored,
    skippedTraces: skipped
  };
}
