/**
 * rev6 R1-2: the writeback EVIDENCE GATE (t9).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The historical negative result is a writeback problem, not a scoring problem:
 * `C3-online − C3-frozen` verifiedRate mean Δ = −0.250 with
 * `deviationStats = { total: 36, harmful: 18, gateFired: 0 }`
 * (`docs/reports/p6-fair-eval.md`, 2026-10-29). `gateFired: 0` is the operative
 * number: every executed probe was written into L2 experience unconditionally,
 * so a harmful deviation was trained in exactly like a beneficial one, and the
 * L2 selectors then had a neighbour set poisoned by its own unverified claims.
 *
 * The gate below answers ONE question per executed trajectory:
 *
 *   "Does this execution carry EVIDENCE that would justify letting it steer L2
 *    selection?"
 *
 * and it answers it from the trajectory's OWN verification marks plus the
 * snapshot's own history - never from a Composer self-assessment, never from a
 * surrogate score, never from "it looked reasonable". A `yes` requires one of
 * two PREREGISTERED routes (frozen in
 * `docs/reports/rev6-jitrl-intervention-preregistration.md` §5, sha256
 * `a9d97aa4…`, written before any sampling; the script re-reads it at run time
 * and reports the digest it actually consumed, so this comment is a pointer, not
 * a second source of truth):
 *
 *   G-A  VERIFIED FAIL→PASS: a host-TRUSTED `passed` receipt for this actionKey,
 *        AND a prior `failed` record for the SAME actionKey in the snapshot. The
 *        half-evidence cases are explicitly refused: trusted-but-never-failed
 *        (nothing was repaired) and failed-then-passed-without-a-trusted-receipt
 *        (the "repair" is unverified).
 *   G-B  PREREGISTERED CONVERGENCE: support ≥ 3 independent records for the
 *        actionKey, verified pass-rate ≥ 0.80, and ZERO counterexamples. A
 *        counterexample is `verifierRewardMismatch === true` (the verifier and
 *        the reward disagreed) or `forceAuditOnly === true` (the host itself
 *        said this execution may not train) - ONE of either vetoes the route
 *        regardless of how good the pass-rate looks. That asymmetry is
 *        deliberate: a poisonous record is not outvoted.
 *
 * Everything else is ADMITTED TO AUDIT ONLY: the record still persists (the
 * negative samples must not be deleted - that was the original sin of hiding
 * harm), it carries `learningEligible: false` and `learningTarget: 0`, and it
 * never participates in L2 ordering.
 *
 * FAIL-CLOSED RULES THAT MATTER
 * -----------------------------
 *   - an ABSENT gate config means OFF (the historical path, byte-identical);
 *   - an unreadable/malformed snapshot history is NOT "no counterexamples" -
 *     an unusable history refuses G-B (`history-unusable`);
 *   - a missing/non-finite reward or an unknown verification status is never
 *     counted as a pass;
 *   - the gate NEVER invents a positive reward: `admitted` records keep the
 *     reward they were scored with, and `audited` records are forced to
 *     `learningTarget: 0` with `learningEligible: false`.
 *
 * This module is pure and dependency-light so the online path, the eval script
 * and the unit tests all execute the SAME rule set rather than a test-local copy.
 */
import type { ExperienceRecord } from '../types/contracts';

/** The two preregistered admission routes (preregistration §5). */
export const WRITEBACK_ADMISSION_ROUTES = [
  /** G-A: host-trusted pass that repairs a recorded failure of the same actionKey. */
  'kept-fail-to-pass',
  /** G-B: preregistered convergence (support/verified-rate/no-counterexample). */
  'kept-verified-convergence'
] as const;
export type WritebackAdmissionRoute = (typeof WRITEBACK_ADMISSION_ROUTES)[number];

/** Every way an execution can be refused admission to L2 ordering. */
export const WRITEBACK_REFUSAL_REASONS = [
  /** G-A failed: the receipt is not host-trusted, so the "repair" is unverified. */
  'rejected-untrusted-receipt',
  /** G-A failed: trusted and passed, but no prior failure of this actionKey. */
  'rejected-no-prior-failure',
  /** G-B failed: fewer than the preregistered support floor. */
  'rejected-insufficient-support',
  /** G-B failed: verified pass-rate below the preregistered floor. */
  'rejected-low-verified-rate',
  /** G-B vetoed: at least one counterexample (verifier mismatch / force-audit-only). */
  'rejected-verifier-mismatch',
  /** The trajectory carries no verification verdict at all. */
  'rejected-no-verdict',
  /** The snapshot could not be read, so G-B cannot be evaluated (fail-closed). */
  'history-unusable',
  /** The record is already learning-ineligible for its own reasons (audit-only). */
  'rejected-record-ineligible'
] as const;
export type WritebackRefusalReason = (typeof WRITEBACK_REFUSAL_REASONS)[number];

/** Preregistered G-B thresholds. FROZEN (preregistration §5 / §11.4). */
export const WRITEBACK_CONVERGENCE_RULES = {
  /** Independent records required for the same actionKey. */
  minSupport: 3,
  /** Verified pass rate required over those records. */
  minVerifiedRate: 0.8,
  /** Counterexamples tolerated. Zero, by design: poisoning is not outvoted. */
  maxCounterexamples: 0
} as const;

/** The outcome of judging ONE executed trajectory. */
export interface WritebackGateVerdict {
  /** True iff the record may participate in L2 selection. */
  readonly admitted: boolean;
  /** Set when admitted: which preregistered route fired. */
  readonly route?: WritebackAdmissionRoute;
  /** Set when refused: the first (most specific) reason that fired. */
  readonly refusal?: WritebackRefusalReason;
  /** Support observed for this actionKey in the snapshot (G-B denominator). */
  readonly support: number;
  /** Verified pass-rate observed over that support (0 when support is 0). */
  readonly verifiedRate: number;
  /** Counterexamples observed over that support. */
  readonly counterexamples: number;
  /**
   * True when the receipt was host-trusted (G-A's first half). Reported even
   * when refused, so "trusted but nothing to repair" is visible in the audit.
   */
  readonly trustedReceipt: boolean;
  /** True when a prior failure of the SAME actionKey exists (G-A's second half). */
  readonly priorFailure: boolean;
}

/** Per-run roll-up; the numbers the result report is generated from. */
export interface WritebackGateSummary {
  /** True when the gate was configured; false = historical path, byte-identical. */
  readonly enabled: boolean;
  /** Executions judged. */
  readonly judged: number;
  /** Executions admitted to L2 ordering. */
  readonly admitted: number;
  /** Executions written for audit only. */
  readonly auditedOnly: number;
  /** How many times the gate REFUSED something it would have admitted when off. */
  readonly gateFired: number;
  /** Refusal reason counts (only non-zero entries). */
  readonly refusalCounts: Readonly<Partial<Record<WritebackRefusalReason, number>>>;
  /** Admission route counts (only non-zero entries). */
  readonly routeCounts: Readonly<Partial<Record<WritebackAdmissionRoute, number>>>;
}

/** A minimal read-only view of the trajectory signals the gate is allowed to read. */
export interface WritebackGateTrajectoryView {
  /** The action key this execution belongs to (the G-A pairing key). */
  readonly actionKey: string;
  /** Host-trusted receipt flag (`verification.trustedSource === true`). */
  readonly trustedSource: boolean;
  /** Verification verdict kind; `unknown` when the trajectory carries none. */
  readonly verificationStatus: 'passed' | 'failed' | 'partial' | 'unknown';
  /** Host disposition: the verifier and the reward disagreed. */
  readonly verifierRewardMismatch: boolean;
  /** Host disposition: this execution may not train regardless of verdict. */
  readonly forceAuditOnly: boolean;
  /** The record's own learning eligibility (false = already audit-only). */
  readonly recordLearningEligible: boolean;
}

/** An empty summary for the off path (and for the "no executions" path). */
export function emptyWritebackGateSummary(enabled: boolean): WritebackGateSummary {
  return {
    enabled,
    judged: 0,
    admitted: 0,
    auditedOnly: 0,
    gateFired: 0,
    refusalCounts: {},
    routeCounts: {}
  };
}

/** One history entry, derived from the snapshot the L2 decision would see. */
export interface WritebackHistoryEntry {
  readonly actionKey: string;
  readonly verified: boolean;
  readonly counterexample: boolean;
}

/**
 * Build the G-B history from a snapshot.
 *
 * WHAT COUNTS AS SUPPORT: one persisted record whose actionKey matches. Callers
 * must pass the ALREADY-FILTERED snapshot (level/bucket/guidance/causal cutoff/
 * learning eligibility applied), because G-B is about the evidence L2 would
 * actually consult - a record the decision cannot see must not vote.
 *
 * WHAT COUNTS AS VERIFIED: `verification.status === 'passed'` AND a trusted
 * receipt. An untrusted `passed` is not a pass; this is the same asymmetry as
 * G-A and it is the reason a hostile/self-asserted verdict cannot saturate a
 * bucket.
 */
export function writebackHistoryEntryOf(
  actionKey: string,
  signals: Pick<WritebackGateTrajectoryView, 'trustedSource' | 'verificationStatus' | 'verifierRewardMismatch' | 'forceAuditOnly'>
): WritebackHistoryEntry {
  const verified = signals.trustedSource && signals.verificationStatus === 'passed';
  return {
    actionKey,
    verified,
    counterexample: signals.verifierRewardMismatch || signals.forceAuditOnly
  };
}

/** Indexed history for O(1) per-verdict lookups. */
export interface WritebackHistoryIndex {
  readonly entries: ReadonlyMap<string, readonly WritebackHistoryEntry[]>;
  /** True when the caller supplied a usable snapshot (not `undefined`). */
  readonly usable: boolean;
}

/**
 * Index a snapshot for the gate.
 *
 * `records === undefined` means "the caller could not read history". That is
 * NOT the same as "history is empty": G-B is refused with `history-unusable`
 * rather than being silently evaluated against a fabricated empty set. An
 * explicitly EMPTY array is usable (a cold store is legitimate).
 */
export function indexWritebackHistory(
  records: readonly WritebackHistoryEntry[] | undefined
): WritebackHistoryIndex {
  if (records === undefined) {
    return new WritebackHistoryIndexImpl(new Map(), false);
  }
  const entries = new Map<string, WritebackHistoryEntry[]>();
  for (const entry of records) {
    if (typeof entry.actionKey !== 'string' || entry.actionKey.length === 0) {
      continue;
    }
    const bucket = entries.get(entry.actionKey);
    if (bucket === undefined) {
      entries.set(entry.actionKey, [entry]);
    } else {
      bucket.push(entry);
    }
  }
  return new WritebackHistoryIndexImpl(entries, true);
}

class WritebackHistoryIndexImpl implements WritebackHistoryIndex {
  readonly entries: ReadonlyMap<string, readonly WritebackHistoryEntry[]>;
  readonly usable: boolean;
  constructor(entries: ReadonlyMap<string, readonly WritebackHistoryEntry[]>, usable: boolean) {
    this.entries = entries;
    this.usable = usable;
  }
}

/** Thresholds are injectable ONLY so tests can prove the frozen defaults are used. */
export type WritebackGateRules = typeof WRITEBACK_CONVERGENCE_RULES;

/**
 * Judge ONE executed trajectory against the preregistered routes.
 *
 * Order of evaluation matters and is part of the frozen contract:
 *   1. record-ineligible (the record already declares itself audit-only);
 *   2. no-verdict (nothing to reason about);
 *   3. G-A  fail->pass  (the cheapest, most specific evidence);
 *   4. G-B  convergence (support / verified-rate / counterexamples);
 *   5. first refusal reason wins, so the report can name why, not just "no".
 */
export function judgeWriteback(
  signals: WritebackGateTrajectoryView,
  history: WritebackHistoryIndex,
  rules: WritebackGateRules = WRITEBACK_CONVERGENCE_RULES
): WritebackGateVerdict {
  const bucket = history.entries.get(signals.actionKey) ?? [];
  const support = bucket.length;
  const verifiedCount = bucket.reduce((sum, entry) => sum + (entry.verified ? 1 : 0), 0);
  const counterexamples = bucket.reduce((sum, entry) => sum + (entry.counterexample ? 1 : 0), 0);
  const verifiedRate = support === 0 ? 0 : verifiedCount / support;
  const trustedReceipt = signals.trustedSource === true;
  const priorFailure = bucket.some(
    (entry) => entry.actionKey === signals.actionKey && !entry.verified && !entry.counterexample
  );

  const base = { support, verifiedRate, counterexamples, trustedReceipt, priorFailure } as const;

  // 1. The record already says it may not train. Nothing the gate decides can
  //    make it trainable: eligibility is a veto, never a floor to raise.
  if (!signals.recordLearningEligible) {
    return { admitted: false, refusal: 'rejected-record-ineligible', ...base };
  }

  // 2. No verdict at all: there is no evidence to reason about.
  if (signals.verificationStatus === 'unknown') {
    return { admitted: false, refusal: 'rejected-no-verdict', ...base };
  }

  // 3. G-A: a trusted pass that repairs a recorded failure of the same action.
  if (signals.verificationStatus === 'passed') {
    if (!trustedReceipt) {
      // Keep the most specific reason: the receipt is present but not trusted.
      return { admitted: false, refusal: 'rejected-untrusted-receipt', ...base };
    }
    if (!priorFailure) {
      return { admitted: false, refusal: 'rejected-no-prior-failure', ...base };
    }
    return { admitted: true, route: 'kept-fail-to-pass', ...base };
  }

  // 4. G-B: preregistered convergence. Note that G-B is reachable for a `failed`
  //    verdict as well: 12 of 12 verified records with one failure and zero
  //    counterexamples is still convergence, and refusing it would keep the gate
  //    from ever learning from a mostly-good action. The pass-rate floor is what
  //    controls that, not the current verdict.
  if (!history.usable) {
    return { admitted: false, refusal: 'history-unusable', ...base };
  }
  if (counterexamples > rules.maxCounterexamples) {
    return { admitted: false, refusal: 'rejected-verifier-mismatch', ...base };
  }
  if (support < rules.minSupport) {
    return { admitted: false, refusal: 'rejected-insufficient-support', ...base };
  }
  if (verifiedRate < rules.minVerifiedRate) {
    return { admitted: false, refusal: 'rejected-low-verified-rate', ...base };
  }
  return { admitted: true, route: 'kept-verified-convergence', ...base };
}

/** Fold one verdict into a running summary (pure; returns a new summary). */
export function accumulateWritebackSummary(
  summary: WritebackGateSummary,
  verdict: WritebackGateVerdict | undefined
): WritebackGateSummary {
  if (verdict === undefined) {
    return summary;
  }
  const refusalCounts = { ...summary.refusalCounts };
  const routeCounts = { ...summary.routeCounts };
  if (verdict.admitted) {
    if (verdict.route !== undefined) {
      routeCounts[verdict.route] = (routeCounts[verdict.route] ?? 0) + 1;
    }
  } else if (verdict.refusal !== undefined) {
    refusalCounts[verdict.refusal] = (refusalCounts[verdict.refusal] ?? 0) + 1;
  }
  return {
    enabled: summary.enabled,
    judged: summary.judged + 1,
    admitted: summary.admitted + (verdict.admitted ? 1 : 0),
    auditedOnly: summary.auditedOnly + (verdict.admitted ? 0 : 1),
    // `gateFired` counts REFUSALS - the deviations the historical run trained in.
    gateFired: summary.gateFired + (verdict.admitted ? 0 : 1),
    refusalCounts,
    routeCounts
  };
}

/**
 * Apply a verdict to the record the store will receive.
 *
 * CONTRACT: this never raises a reward and never mints a positive target. An
 * admitted record is returned UNCHANGED (the gate is not a scorer). A refused
 * record keeps its scored `reward` for audit, but is forced to a zero learning
 * target and explicit ineligibility, so the L2 filter drops it and no consumer
 * can read a gain from it.
 */
export function applyWritebackVerdict<T extends Pick<ExperienceRecord, 'reward' | 'learningEligible'>>(
  record: T,
  verdict: WritebackGateVerdict
): T & Pick<ExperienceRecord, 'learningEligible'> {
  if (verdict.admitted) {
    return { ...record, learningEligible: record.learningEligible };
  }
  return { ...record, learningEligible: false };
}

/** Reason-code helper: a stable numeric code for ledger marks (0 = admitted). */
export function writebackRefusalCode(refusal: WritebackRefusalReason | undefined): number {
  if (refusal === undefined) {
    return 0;
  }
  const index = WRITEBACK_REFUSAL_REASONS.indexOf(refusal);
  return index < 0 ? 0 : index + 1;
}

/** Route-code helper: a stable numeric code for ledger marks (0 = audited only). */
export function writebackRouteCode(route: WritebackAdmissionRoute | undefined): number {
  if (route === undefined) {
    return 0;
  }
  const index = WRITEBACK_ADMISSION_ROUTES.indexOf(route);
  return index < 0 ? 0 : index + 1;
}
