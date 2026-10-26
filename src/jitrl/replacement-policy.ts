/**
 * P6.2 C0 replacement policy (ADR 0002 R5/R6; new module, 11.2 scope).
 *
 * The conservative L2 replacement gate previously lived inline inside
 * selectProposal (src/orchestrator.ts, PR-B). This module extracts the DECISION
 * RULES into one pure, dependency-free place so the online path, the tests and
 * the guarded regression script all execute the SAME rule set instead of a
 * test-local copy:
 *
 *   1. the replacement judgement consumes ONLY nEff (fail-closed: a missing or
 *      non-finite nEff is "no replacement evidence"; support never impersonates
 *      nEff - it stays a ledger co-report);
 *   2. thin evidence (below the floor, or incomplete) never replaces: the
 *      shrunk advantage is 0, the challenger can tie but not win;
 *   3. a zero-advantage/no-evidence artefact over an evidenced prior is HARD
 *      VETOED (gateReason 'implicit-zero-advantage');
 *   4. an unsupported challenger executes only against the explicit, revocable
 *      exploration budget, charged on real completions and RELEASED when the
 *      execution has no quality evidence (cancel/abort/infra);
 *   5. noop is judged by evidence, not by its type label: a noop challenger is
 *      the implicit-zero artefact ONLY when it carries no constructive
 *      replacement evidence (it edits nothing, so it cannot accumulate any);
 *      a noop WITH real measured evidence (support + nEff above the floor) is
 *      judged by that evidence exactly like any other challenger (V4, R5-5).
 *
 * Estimation stays separated from replacement: the suggestion strength
 * (shrunk/calibrated advantage) is reported exactly as measured even when the
 * replacement is refused.
 */

import { conservativeAdvantage, type ActionValueEstimate } from './value-estimator';
import type { ExperienceOutcome } from '../types/contracts';

/** The four gate outcomes an L2 deviation can receive. */
export const REPLACEMENT_GATE_REASONS = [
  'implicit-zero-advantage',
  'exploration-budget',
  'min-support'
] as const;
export type ReplacementGateReason = (typeof REPLACEMENT_GATE_REASONS)[number];

/** How a proposed deviation from the prior was resolved. */
export type ReplacementVerdictKind =
  /** The proposed challenger executed as-is (full evidence, or budget charge). */
  | 'executed-proposed'
  /** The proposed challenger executed against the exploration budget. */
  | 'executed-exploration'
  /** The prior stood (gate veto or missing budget/evidence). */
  | 'kept-prior';

/** One replacement judgement, fully replayable from the ledger fields. */
export interface ReplacementVerdict {
  readonly kind: ReplacementVerdictKind;
  /** Index executed after the gate (prior index or proposed index). */
  readonly executedIndex: number;
  /** Set when the executed index is not the decision's raw choice. */
  readonly gateReason?: ReplacementGateReason;
  /** True when this execution was charged to the exploration budget. */
  readonly exploration: boolean;
  /**
   * The challenger's full conservative judgement (nEff/support co-report plus
   * the shrunk/calibrated suggestion strength), so the ledger can show that
   * the calibrated advantage ACTUALLY participated in the guarded decision
   * instead of being computed and discarded. Always present for a deviation.
   */
  readonly challenger: {
    readonly nEff: number;
    readonly support: number;
    readonly hasReplacementEvidence: boolean;
    readonly shrunkAdvantage: number;
    readonly calibratedAdvantage: number;
    readonly implicitZeroAdvantage: boolean;
  };
}

/**
 * One optimistic-exploration reservation (ADR 0002 R5-6).
 *
 * A deviation executed on the budget reserves one seat. The seat is CHARGED
 * (kept) when the execution really completed - succeeded, failed or timeout:
 * under the C2-pre eligibility rules such an execution carries no task-quality
 * evidence either way (5.2a), but the probe was still spent, so the budget is
 * consumed. The seat is RELEASED when the execution has no quality evidence at
 * all (cancelled / aborted / infrastructure): the run says nothing about the
 * action, so the seat returns.
 */
export interface ExplorationReservation {
  /** True when the deviation actually executed on the budget. */
  readonly exploration: boolean;
  /** True when the execution completed for real (charge stands). */
  readonly completed: boolean;
  /** Outcome class the recorder derived for the executed trajectory. */
  readonly outcome?: ExperienceOutcome;
}

/**
 * Decide a proposed deviation from the prior (the conservative gate, R5).
 *
 * Inputs are the raw decision-kernel adjustments plus the noop check the
 * caller performs (a noop challenger cannot carry constructive replacement
 * evidence because it edits nothing). Pure: no budget mutation happens here;
 * the caller applies the returned verdict to its allowance.
 *
 * Order (total, asserted by the regression suite):
 *   1. hard veto: implicit-zero artefact (fallback-derived A=0, or an
 *      evidence-free noop) over a prior that holds real evidence or strictly
 *      more support - even when a budget exists (R5-4: the artefact veto is
 *      unconditional; V4: the noop joins the artefact class ONLY when it has
 *      no constructive replacement evidence);
 *   2. under-evidenced challenger (no support, or nEff below the floor) with
 *      explicit budget available: execute on the budget (exploration=true,
 *      charged and revocable; R5-3/R5-6: thin evidence may execute ONLY under
 *      an explicit exploration authorization);
 *   3. under-evidenced challenger, no budget: prior stands (fail-closed);
 *   4. full evidence: the kernel's choice executes.
 */
export function decideReplacement(input: {
  /** Index the decision kernel proposed. */
  readonly proposedIndex: number;
  /** Index of the prior (highest base logit). */
  readonly priorIndex: number;
  /** The proposed challenger's estimate (from the same decision). */
  readonly challenger: ActionValueEstimate;
  /** The prior's estimate (same evidence standard, two-sided comparison). */
  readonly prior: ActionValueEstimate;
  /** True when the proposed patch edits nothing (cannot carry evidence). */
  readonly challengerIsNoop: boolean;
  /** Remaining explicit exploration allowance at decision time. */
  readonly explorationAllowance: number;
}): ReplacementVerdict {
  if (input.proposedIndex === input.priorIndex) {
    // No deviation: the triple (prior/proposed/executed) still reports, but no
    // gate applies and no budget is touched. The challenger report mirrors the
    // input estimate so the ledger shape stays total.
    const same = conservativeAdvantage(input.challenger);
    return {
      kind: 'executed-proposed',
      executedIndex: input.proposedIndex,
      exploration: false,
      challenger: {
        nEff: same.nEff,
        support: same.support,
        hasReplacementEvidence: same.hasReplacementEvidence,
        shrunkAdvantage: same.shrunkAdvantage,
        calibratedAdvantage: same.calibratedAdvantage,
        implicitZeroAdvantage: same.implicitZeroAdvantage
      }
    };
  }
  const challenger = conservativeAdvantage(input.challenger);
  const prior = conservativeAdvantage(input.prior);
  const challengerReport = {
    nEff: challenger.nEff,
    support: challenger.support,
    hasReplacementEvidence: challenger.hasReplacementEvidence,
    shrunkAdvantage: challenger.shrunkAdvantage,
    calibratedAdvantage: challenger.calibratedAdvantage,
    implicitZeroAdvantage: challenger.implicitZeroAdvantage
  };
  // V4 (t7, ADR 0002 R5-5): a noop is the implicit-zero ARTEFACT only when it
  // carries NO constructive replacement evidence - "it edits nothing" means it
  // cannot ACCUMULATE evidence, so in practice a noop arrives here with
  // support=0 / no nEff. But the exclusion basis is the missing evidence, never
  // the type label: a caller that somehow holds REAL measured evidence for the
  // noop action (store support + nEff above the floor) must be judged by that
  // evidence like any other challenger ("noop 不因类型失去有效证据", R5-5).
  // The fallback-derived-advantage flag stays evidence-derived and untouched.
  const zeroAdvantageArtefact =
    challenger.implicitZeroAdvantage ||
    (input.challengerIsNoop && !challenger.hasReplacementEvidence);
  if (zeroAdvantageArtefact && (prior.hasReplacementEvidence || prior.support > challenger.support)) {
    // The first-harmful shape (ci-04|2|2): a no-evidence challenger riding a
    // fallback-derived advantage over an evidenced prior. Hard veto, always.
    return {
      kind: 'kept-prior',
      executedIndex: input.priorIndex,
      gateReason: 'implicit-zero-advantage',
      exploration: false,
      challenger: challengerReport
    };
  }
  if (!challenger.hasReplacementEvidence) {
    // Under-evidenced (support=0, or thin-but-measured with nEff below the
    // floor). The veto shape above already handled the artefact case; what
    // remains executes ONLY against the explicit, revocable budget (R5-3:
    // "薄证据无显式探索授权不替换"; R5-6: charged and tagged exploration).
    // Without a grant the prior stands - there is NO implicit exploration path.
    if (input.explorationAllowance > 0) {
      return {
        kind: 'executed-exploration',
        executedIndex: input.proposedIndex,
        exploration: true,
        challenger: challengerReport
      };
    }
    return {
      kind: 'kept-prior',
      executedIndex: input.priorIndex,
      gateReason: challenger.support === 0 ? 'exploration-budget' : 'min-support',
      exploration: false,
      challenger: challengerReport
    };
  }
  return {
    kind: 'executed-proposed',
    executedIndex: input.proposedIndex,
    exploration: false,
    challenger: challengerReport
  };
}

/**
 * Reservation accounting for one budget-charged execution (R5-6): true when
 * the seat must be RELEASED (execution has no quality evidence: cancellation,
 * external abort or infrastructure failure), false when the charge stands
 * (the execution really completed). Audit-only either way, per the ADR.
 */
export function shouldReleaseReservation(reservation: ExplorationReservation): boolean {
  if (!reservation.exploration) {
    return false;
  }
  if (!reservation.completed) {
    return true;
  }
  return (
    reservation.outcome === 'cancelled' ||
    reservation.outcome === 'aborted' ||
    reservation.outcome === 'infrastructure_error'
  );
}
