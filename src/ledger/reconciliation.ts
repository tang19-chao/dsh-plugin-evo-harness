/**
 * PR-3B: external bill reconciliation (ADR-0004 §8.3).
 *
 * WHY THIS EXISTS
 * ---------------
 * An internal ledger is a claim about what we THINK we spent. Only the provider's
 * own bill is evidence of what was actually charged. This module compares the two
 * and produces an auditable verdict — it never silently adjusts the ledger to
 * match the bill, because "the bill is right" is itself a claim that may be wrong
 * (a billing bug, a shared account, a proration).
 *
 * The state machine (§8.3):
 *
 *     PendingReconciliation
 *        ├── ReconciledExact               difference === 0
 *        ├── ReconciledWithinTolerance     |difference| <= tolerance
 *        ├── Disputed                      |difference| > tolerance
 *        └── Unresolved                     no bill line for a settled call
 *
 *     Disputed → ManualResolved             a human decided (records the ruling)
 *
 * DESIGN NOTES
 * ------------
 * - TOLERANCE IS NOT A LICENSE TO ROUND. It absorbs sub-micro rounding and
 *   proration noise (default 500µ = $0.0005). Anything larger is a real
 *   discrepancy and must be visible as `Disputed`, not absorbed.
 * - A MISSING bill line is `Unresolved`, never `ReconciledExact` with 0: absence
 *   of evidence is not evidence of zero spend.
 * - The ledger's own figure is never overwritten here. `applyTo` produces a
 *   PROPOSED adjustment that a caller may apply deliberately.
 * - Pure: no I/O, no clock, no randomness. The caller supplies the bill.
 */

/** Default tolerance: 500 micro-dollars ($0.0005). */
export const DEFAULT_RECONCILIATION_TOLERANCE_MICROS = 500;

/** One line of the provider's external bill. */
export interface ExternalBillLine {
  /** The provider-side identifier. Matched to `callId` or a recorded `providerCallId`. */
  readonly providerCallId?: string;
  /** Our call id, when the bill can be joined directly. */
  readonly callId?: string;
  /** Amount actually charged, in micro-dollars. */
  readonly chargedMicros: number;
  /** Provider's own invoice/reference id, retained for audit. */
  readonly invoiceRef?: string;
}

/** Our own settled figure for one call. */
export interface InternalLedgerLine {
  readonly callId: string;
  /**
   * The provider-side id the call index persisted when late usage arrived
   * (LEDGER-12, `LedgerCallIdentity.providerCallId`). A bill exposing only
   * provider ids can then be matched — without it, such a bill is 100%
   * unresolved no matter how accurate the ledger is.
   */
  readonly providerCallId?: string;
  readonly incurredCostMicros: number;
  readonly pool?: 'general' | 'verification';
}

export type ReconciliationState =
  | 'reconciled_exact'
  | 'reconciled_within_tolerance'
  | 'disputed'
  | 'unresolved'
  | 'manual_resolved';

/** Verdict for one call. */
export interface ReconciliationVerdict {
  readonly callId: string;
  readonly state: ReconciliationState;
  /** Our figure (never modified by this module). */
  readonly internalMicros: number;
  /** Provider figure, or undefined when the bill had no line for this call. */
  readonly externalMicros: number | undefined;
  /** `external - internal`; undefined when there is no external figure. */
  readonly differenceMicros: number | undefined;
  readonly withinTolerance: boolean;
  readonly reason: string;
}

/** Aggregate result of reconciling a whole bill. */
export interface ReconciliationReport {
  readonly toleranceMicros: number;
  readonly matched: number;
  readonly exact: number;
  readonly withinTolerance: number;
  readonly disputed: number;
  readonly unresolved: number;
  readonly verdicts: readonly ReconciliationVerdict[];
  /** Calls present in our ledger but absent from the bill (unresolved). */
  readonly missingFromBill: readonly string[];
  /** Bill lines with no matching internal call (possible double-billing). */
  readonly unknownToLedger: readonly ExternalBillLine[];
  /**
   * Bill keys that appeared more than once. First occurrence wins for matching,
   * but the duplicates are still surfaced: a duplicated invoice line is a
   * billing defect, not something to silently drop.
   */
  readonly duplicateBillKeys: readonly string[];
  /**
   * Net difference across all MATCHED calls, in micro-dollars.
   * Positive means the provider charged more than we recorded.
   */
  readonly netDifferenceMicros: number;
  readonly allSettled: boolean;
}

/**
 * A human ruling on a disputed line (the `ManualResolved` terminal state).
 *
 * The ruling records BOTH figures and the decision, so a later reader can tell
 * whether the ledger, the bill, or neither was accepted.
 */
export interface ManualResolution {
  readonly callId: string;
  readonly decision: 'accept-internal' | 'accept-external' | 'accept-neither';
  /** The figure the operator accepted, when one was accepted. */
  readonly acceptedMicros?: number;
  readonly note: string;
  readonly resolvedAt: number;
}

/**
 * Reconcile our settled ledger against an external bill.
 *
 * Matching is dual-key (LEDGER-12): a bill line joins an internal line by our
 * `callId` (preferred — the strongest join) or, failing that, by the
 * `providerCallId` the call index persisted when late usage arrived. The two
 * identifiers live in SEPARATE namespaces: our callIds and the provider's ids
 * are different vocabularies, so a line is indexed and matched under each key
 * it actually carries. A bill line that matches nothing is reported as
 * `unknownToLedger` rather than dropped: it is the signature of double-billing
 * or a mis-joined export.
 */
export function reconcileWithExternalBill(params: {
  readonly internal: readonly InternalLedgerLine[];
  readonly external: readonly ExternalBillLine[];
  readonly toleranceMicros?: number;
}): ReconciliationReport {
  const tolerance =
    params.toleranceMicros === undefined
      ? DEFAULT_RECONCILIATION_TOLERANCE_MICROS
      : Math.max(0, Math.floor(params.toleranceMicros));

  const billByCallId = new Map<string, ExternalBillLine>();
  const billByProviderId = new Map<string, ExternalBillLine>();
  const billLines: ExternalBillLine[] = [];
  const duplicateBillKeys: string[] = [];
  const seenBillKeys = new Set<string>();
  for (const line of params.external) {
    if (line.callId === undefined && line.providerCallId === undefined) {
      continue;
    }
    const callKey = line.callId === undefined ? undefined : 'callId:' + line.callId;
    const providerKey = line.providerCallId === undefined ? undefined : 'provider:' + line.providerCallId;
    if (callKey !== undefined && seenBillKeys.has(callKey)) {
      // First occurrence wins; a duplicate key is itself a defect worth
      // surfacing, and silently summing it would inflate the comparison.
      duplicateBillKeys.push(line.callId as string);
      continue;
    }
    if (providerKey !== undefined && seenBillKeys.has(providerKey)) {
      duplicateBillKeys.push(line.providerCallId as string);
      continue;
    }
    if (callKey !== undefined) {
      seenBillKeys.add(callKey);
      billByCallId.set(line.callId as string, line);
    }
    if (providerKey !== undefined) {
      seenBillKeys.add(providerKey);
      billByProviderId.set(line.providerCallId as string, line);
    }
    billLines.push(line);
  }

  const verdicts: ReconciliationVerdict[] = [];
  const missingFromBill: string[] = [];
  /** Bill lines that ARE some internal line's match target (dual-key join). */
  const matchedBillLines = new Set<ExternalBillLine>();
  let exact = 0;
  let withinTolerance = 0;
  let disputed = 0;
  let unresolved = 0;
  let netDifferenceMicros = 0;

  for (const entry of params.internal) {
    // Dual-key join (LEDGER-12): our callId wins when the bill exposes it;
    // otherwise the provider-side id recorded on the identity decides.
    const billLine =
      billByCallId.get(entry.callId) ??
      (entry.providerCallId === undefined ? undefined : billByProviderId.get(entry.providerCallId));
    if (billLine !== undefined) {
      matchedBillLines.add(billLine);
    }

    if (billLine === undefined) {
      unresolved += 1;
      missingFromBill.push(entry.callId);
      verdicts.push({
        callId: entry.callId,
        state: 'unresolved',
        internalMicros: entry.incurredCostMicros,
        externalMicros: undefined,
        differenceMicros: undefined,
        withinTolerance: false,
        reason:
          'no line in the external bill for this call; absence of evidence is not evidence of zero spend'
      });
      continue;
    }

    const difference = billLine.chargedMicros - entry.incurredCostMicros;
    netDifferenceMicros += difference;

    if (difference === 0) {
      exact += 1;
      verdicts.push({
        callId: entry.callId,
        state: 'reconciled_exact',
        internalMicros: entry.incurredCostMicros,
        externalMicros: billLine.chargedMicros,
        differenceMicros: 0,
        withinTolerance: true,
        reason: 'the external bill matches the ledger exactly'
      });
      continue;
    }

    if (Math.abs(difference) <= tolerance) {
      withinTolerance += 1;
      verdicts.push({
        callId: entry.callId,
        state: 'reconciled_within_tolerance',
        internalMicros: entry.incurredCostMicros,
        externalMicros: billLine.chargedMicros,
        differenceMicros: difference,
        withinTolerance: true,
        reason: `difference of ${difference}u is within the ${tolerance}u tolerance (rounding / proration)`
      });
      continue;
    }

    disputed += 1;
    verdicts.push({
      callId: entry.callId,
      state: 'disputed',
      internalMicros: entry.incurredCostMicros,
      externalMicros: billLine.chargedMicros,
      differenceMicros: difference,
      withinTolerance: false,
      reason:
        `difference of ${difference}u exceeds the ${tolerance}u tolerance; ` +
        'requires a manual ruling rather than silent adjustment'
    });
  }

  const unknownToLedger: ExternalBillLine[] = [];
  for (const line of billLines) {
    // Unknown to the ledger = nobody's match target. Matching BY key alone is
    // not enough: a duplicate bill line carrying a claimed providerCallId would
    // otherwise vanish instead of surfacing as a double-billing signature.
    if (!matchedBillLines.has(line)) {
      unknownToLedger.push(line);
    }
  }

  const matched = exact + withinTolerance + disputed;
  return {
    toleranceMicros: tolerance,
    matched,
    exact,
    withinTolerance,
    disputed,
    unresolved,
    verdicts,
    missingFromBill,
    unknownToLedger,
    duplicateBillKeys: [...new Set(duplicateBillKeys)].sort(),
    netDifferenceMicros,
    // "All settled" means every internal call found a bill line AND nothing was
    // disputed. Unresolved or unknown lines keep a bill from being settled.
    allSettled: unresolved === 0 && disputed === 0 && unknownToLedger.length === 0
  };
}

/**
 * Build the proposed ledger adjustment for one verdict.
 *
 * Returns `undefined` when no adjustment is warranted (exact match, within
 * tolerance, or unresolved). This deliberately does NOT mutate anything: the
 * caller decides whether to book the difference, and the report keeps the
 * original ledger figure intact.
 */
export function proposeAdjustment(
  verdict: ReconciliationVerdict
): { readonly callId: string; readonly deltaMicros: number; readonly basis: string } | undefined {
  if (verdict.state !== 'disputed' && verdict.state !== 'manual_resolved') {
    return undefined;
  }
  if (verdict.differenceMicros === undefined || verdict.differenceMicros === 0) {
    return undefined;
  }
  return {
    callId: verdict.callId,
    deltaMicros: verdict.differenceMicros,
    basis:
      verdict.state === 'manual_resolved'
        ? 'manual ruling accepted an external figure'
        : 'disputed difference proposed for explicit booking'
  };
}

/**
 * Record a human ruling on a disputed line (`Disputed` → `ManualResolved`).
 *
 * `accept-neither` keeps the ledger figure and marks the line as a known,
 * documented disagreement — which is the honest outcome when neither side can be
 * substantiated.
 */
export function applyManualResolution(
  verdict: ReconciliationVerdict,
  resolution: ManualResolution
): ReconciliationVerdict {
  if (verdict.state !== 'disputed') {
    throw new Error(
      `cannot apply a manual resolution to a verdict in state "${verdict.state}"; ` +
        'only a disputed line needs a ruling'
    );
  }
  const accepted =
    resolution.decision === 'accept-external'
      ? (verdict.externalMicros ?? verdict.internalMicros)
      : resolution.decision === 'accept-internal'
        ? verdict.internalMicros
        : resolution.acceptedMicros ?? verdict.internalMicros;

  return {
    ...verdict,
    state: 'manual_resolved',
    differenceMicros: accepted - verdict.internalMicros,
    withinTolerance: false,
    reason:
      `manual resolution (${resolution.decision}): ${resolution.note} ` +
      `[internal=${verdict.internalMicros}u, external=${String(verdict.externalMicros)}u, accepted=${accepted}u]`
  };
}
