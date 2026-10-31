/**
 * rev6 R1-2 (t9): the write-back EVIDENCE GATE, judged against its frozen rules.
 *
 * WHAT THIS SUITE IS FOR
 * ----------------------
 * `docs/reports/rev6-jitrl-intervention-preregistration.md` §5 freezes two
 * admission routes (G-A verified fail->pass, G-B preregistered convergence) and
 * §8 lists four negative controls that must go red. Those are the contract; this
 * file turns each clause into an assertion that can FAIL.
 *
 * The gate's whole purpose is to be UNIMPRESSED by a good-looking reward. So the
 * two asymmetric rules get special attention, because they are the ones a
 * well-meaning future edit would "simplify":
 *
 *   1. a counterexample is NOT outvoted (one verifier mismatch vetoes G-B no
 *      matter how good the pass-rate looks) - `maxCounterexamples: 0`;
 *   2. a `passed` verdict WITHOUT a trusted receipt is not a pass, and a
 *      trusted pass with no prior failure has nothing to have repaired.
 *
 * Deliberately NOT asserted here: the production wiring in `src/orchestrator.ts`.
 * That is a different claim ("the gate's verdict actually reaches the persisted
 * record") and lives in `tests/unit/orchestrator/writeback-intervention.test.ts`,
 * where the orchestrator is driven for real.
 */
import { describe, expect, it } from 'vitest';
import {
  WRITEBACK_ADMISSION_ROUTES,
  WRITEBACK_CONVERGENCE_RULES,
  WRITEBACK_REFUSAL_REASONS,
  accumulateWritebackSummary,
  applyWritebackVerdict,
  emptyWritebackGateSummary,
  indexWritebackHistory,
  judgeWriteback,
  writebackHistoryEntryOf,
  writebackRefusalCode,
  writebackRouteCode,
  type WritebackGateTrajectoryView,
  type WritebackHistoryEntry
} from '../../../src/jitrl/writeback-gate';

/** A baseline view: nothing verified, nothing trusted, record learnable. */
function view(overrides: Partial<WritebackGateTrajectoryView> = {}): WritebackGateTrajectoryView {
  return {
    actionKey: 'action-a',
    trustedSource: false,
    verificationStatus: 'unknown',
    verifierRewardMismatch: false,
    forceAuditOnly: false,
    recordLearningEligible: true,
    ...overrides
  };
}

/** Build history entries for one actionKey: `verified` passes out of `support`. */
function history(
  actionKey: string,
  support: number,
  verified: number,
  counterexamples = 0
): WritebackHistoryEntry[] {
  const entries: WritebackHistoryEntry[] = [];
  for (let index = 0; index < support; index += 1) {
    entries.push({
      actionKey,
      verified: index < verified,
      counterexample: index < counterexamples
    });
  }
  return entries;
}

describe('rev6 R1-2: the preregistered thresholds are the ones in force', () => {
  it('G-B floor is support>=3, verifiedRate>=0.80, counterexamples==0', () => {
    // These numbers are frozen in the PREREGISTRATION (§5). If someone tunes them
    // "to make the run look better", the preregistration is void and this must
    // fail loudly rather than silently re-defining the criterion.
    expect(WRITEBACK_CONVERGENCE_RULES.minSupport).toBe(3);
    expect(WRITEBACK_CONVERGENCE_RULES.minVerifiedRate).toBe(0.8);
    expect(WRITEBACK_CONVERGENCE_RULES.maxCounterexamples).toBe(0);
  });

  it('there are exactly two admission routes and eight refusal reasons', () => {
    expect(WRITEBACK_ADMISSION_ROUTES).toEqual(['kept-fail-to-pass', 'kept-verified-convergence']);
    expect(WRITEBACK_REFUSAL_REASONS.length).toBe(8);
    // Stable numeric codes: 0 means "no code", so every reason must be >= 1 and
    // distinct, otherwise a ledger mark could not identify the refusal.
    const codes = WRITEBACK_REFUSAL_REASONS.map((reason) => writebackRefusalCode(reason));
    expect(new Set(codes).size).toBe(codes.length);
    expect(Math.min(...codes)).toBe(1);
    expect(writebackRefusalCode(undefined)).toBe(0);
  });

  it('route codes are 1 and 2, with 0 reserved for "audited only"', () => {
    expect(writebackRouteCode('kept-fail-to-pass')).toBe(1);
    expect(writebackRouteCode('kept-verified-convergence')).toBe(2);
    expect(writebackRouteCode(undefined)).toBe(0);
  });
});

describe('rev6 R1-2: G-A verified fail->pass (the specific evidence)', () => {
  it('admits a trusted pass that repairs a recorded failure of the same action', () => {
    const verdict = judgeWriteback(
      view({ verificationStatus: 'passed', trustedSource: true }),
      indexWritebackHistory(history('action-a', 2, 0))
    );
    expect(verdict.admitted).toBe(true);
    expect(verdict.route).toBe('kept-fail-to-pass');
    expect(verdict.trustedReceipt).toBe(true);
    expect(verdict.priorFailure).toBe(true);
  });

  it('REFUSES a pass whose receipt is not host-trusted (half-evidence)', () => {
    const verdict = judgeWriteback(
      view({ verificationStatus: 'passed', trustedSource: false }),
      indexWritebackHistory(history('action-a', 2, 0))
    );
    expect(verdict.admitted).toBe(false);
    expect(verdict.refusal).toBe('rejected-untrusted-receipt');
    // The refusal is specific: trustedReceipt false, priorFailure true.
    expect(verdict.trustedReceipt).toBe(false);
    expect(verdict.priorFailure).toBe(true);
  });

  it('REFUSES a trusted pass with no prior failure (nothing was repaired)', () => {
    const verdict = judgeWriteback(
      view({ verificationStatus: 'passed', trustedSource: true }),
      indexWritebackHistory(history('action-a', 2, 2))
    );
    expect(verdict.admitted).toBe(false);
    expect(verdict.refusal).toBe('rejected-no-prior-failure');
    expect(verdict.priorFailure).toBe(false);
  });

  it('pairs on actionKey, not on the run: a failure of a DIFFERENT action is no evidence', () => {
    const verdict = judgeWriteback(
      view({ actionKey: 'action-b', verificationStatus: 'passed', trustedSource: true }),
      indexWritebackHistory(history('action-a', 3, 0))
    );
    expect(verdict.admitted).toBe(false);
    expect(verdict.refusal).toBe('rejected-no-prior-failure');
    // ...and the support the verdict reports is for ITS key, not the neighbour's.
    expect(verdict.support).toBe(0);
  });
});

describe('rev6 R1-2: G-B preregistered convergence (the accumulated evidence)', () => {
  it('admits at exactly the floor (support=3, verifiedRate=1.0, no counterexample)', () => {
    const verdict = judgeWriteback(
      view({ verificationStatus: 'failed' }),
      indexWritebackHistory(history('action-a', 3, 3))
    );
    expect(verdict.admitted).toBe(true);
    expect(verdict.route).toBe('kept-verified-convergence');
    expect(verdict.support).toBe(3);
    expect(verdict.verifiedRate).toBe(1);
  });

  it('admits at the exact rate boundary 0.80 (4 of 5)', () => {
    const verdict = judgeWriteback(
      view({ verificationStatus: 'failed' }),
      indexWritebackHistory(history('action-a', 5, 4))
    );
    expect(verdict.admitted).toBe(true);
    expect(verdict.verifiedRate).toBeCloseTo(0.8, 10);
  });

  it('REFUSES one below the rate boundary (3 of 4 = 0.75)', () => {
    const verdict = judgeWriteback(
      view({ verificationStatus: 'failed' }),
      indexWritebackHistory(history('action-a', 4, 3))
    );
    expect(verdict.admitted).toBe(false);
    expect(verdict.refusal).toBe('rejected-low-verified-rate');
  });

  it('REFUSES below the support floor even at a perfect rate (2 of 2)', () => {
    const verdict = judgeWriteback(
      view({ verificationStatus: 'failed' }),
      indexWritebackHistory(history('action-a', 2, 2))
    );
    expect(verdict.admitted).toBe(false);
    expect(verdict.refusal).toBe('rejected-insufficient-support');
  });

  it('a SINGLE counterexample vetoes G-B even at a perfect pass rate (not outvoted)', () => {
    // The asymmetry that matters: 9 verified passes + 1 verifier mismatch must
    // NOT converge. If this ever passes, the gate can be poisoned by a single
    // bad record diluted in volume - the exact failure the negative result
    // documented.
    const verdict = judgeWriteback(
      view({ verificationStatus: 'failed' }),
      indexWritebackHistory(history('action-a', 10, 9, 1))
    );
    expect(verdict.admitted).toBe(false);
    expect(verdict.refusal).toBe('rejected-verifier-mismatch');
    expect(verdict.counterexamples).toBe(1);
    expect(verdict.verifiedRate).toBeCloseTo(0.9, 10);
  });

  it('the current run\'s own verdict does not have to be "passed" for G-B', () => {
    // G-B is about the accumulated record, not about this one execution: a
    // mostly-good action may fail once and still be worth keeping. The rate
    // floor, not the current verdict, is what controls admission.
    const verdict = judgeWriteback(
      view({ verificationStatus: 'failed' }),
      indexWritebackHistory(history('action-a', 5, 4))
    );
    expect(verdict.admitted).toBe(true);
  });
});

describe('rev6 R1-2: fail-closed edges', () => {
  it('REFUSES a record that already declares itself ineligible', () => {
    const verdict = judgeWriteback(
      view({
        verificationStatus: 'passed',
        trustedSource: true,
        recordLearningEligible: false
      }),
      indexWritebackHistory(history('action-a', 3, 0))
    );
    expect(verdict.admitted).toBe(false);
    expect(verdict.refusal).toBe('rejected-record-ineligible');
  });

  it('REFUSES a trajectory with no verdict at all', () => {
    const verdict = judgeWriteback(
      view({ verificationStatus: 'unknown' }),
      indexWritebackHistory(history('action-a', 5, 5))
    );
    expect(verdict.admitted).toBe(false);
    expect(verdict.refusal).toBe('rejected-no-verdict');
  });

  it('UNREADABLE history is not empty history: G-B is refused, not silently evaluated', () => {
    // `undefined` records means "could not read", and the difference is the whole
    // point: an empty history would report `rejected-insufficient-support`, which
    // reads as a measured finding. Unusable history reports `history-unusable`.
    const unusable = indexWritebackHistory(undefined);
    expect(unusable.usable).toBe(false);
    const verdict = judgeWriteback(view({ verificationStatus: 'failed' }), unusable);
    expect(verdict.admitted).toBe(false);
    expect(verdict.refusal).toBe('history-unusable');

    // Whereas a genuinely EMPTY (cold) store IS usable and reports support 0.
    const empty = indexWritebackHistory([]);
    expect(empty.usable).toBe(true);
    const coldVerdict = judgeWriteback(view({ verificationStatus: 'failed' }), empty);
    expect(coldVerdict.refusal).toBe('rejected-insufficient-support');
    expect(coldVerdict.support).toBe(0);
  });

  it('G-A still works on unusable history (G-B is the route that needs the denominator)', () => {
    // A fail->pass pair needs no history, so refusing it because the store could
    // not be enumerated would be over-strict rather than fail-closed.
    const verdict = judgeWriteback(
      view({ verificationStatus: 'passed', trustedSource: true }),
      indexWritebackHistory(history('action-a', 2, 0))
    );
    expect(verdict.admitted).toBe(true);
    expect(verdict.route).toBe('kept-fail-to-pass');
  });

  it('an untrusted "passed" in HISTORY is not a verified pass', () => {
    // The history index is fed by the caller's own projection; this asserts the
    // production rule (`writebackHistoryEntryOf`) that untrusted passes do not
    // count, so a bucket cannot be saturated by self-asserted verdicts.
    const verifiedEntry = writebackHistoryEntryOf('action-a', {
      trustedSource: true,
      verificationStatus: 'passed',
      verifierRewardMismatch: false,
      forceAuditOnly: false
    });
    const untrustedEntry = writebackHistoryEntryOf('action-a', {
      trustedSource: false,
      verificationStatus: 'passed',
      verifierRewardMismatch: false,
      forceAuditOnly: false
    });
    expect(verifiedEntry.verified).toBe(true);
    expect(untrustedEntry.verified).toBe(false);
  });

  it('forceAuditOnly and verifier mismatch both count as counterexamples', () => {
    const forced = writebackHistoryEntryOf('action-a', {
      trustedSource: true,
      verificationStatus: 'passed',
      verifierRewardMismatch: false,
      forceAuditOnly: true
    });
    const mismatch = writebackHistoryEntryOf('action-a', {
      trustedSource: true,
      verificationStatus: 'failed',
      verifierRewardMismatch: true,
      forceAuditOnly: false
    });
    expect(forced.counterexample).toBe(true);
    expect(mismatch.counterexample).toBe(true);
  });
});

describe('rev6 R1-2: the negative controls from preregistration §8', () => {
  it('NC-1/N-2/N-3 all land on a distinct, named refusal', () => {
    // The three positive-evidence negatives §8 asks for, asserted in one place
    // so a missing case is visible: untrusted receipt / mismatch veto.
    const nc2 = judgeWriteback(
      view({ verificationStatus: 'passed', trustedSource: false }),
      indexWritebackHistory(history('action-a', 3, 0))
    );
    expect(nc2.refusal).toBe('rejected-untrusted-receipt');
    const nc3 = judgeWriteback(
      view({ verificationStatus: 'failed' }),
      indexWritebackHistory(history('action-a', 5, 5, 1))
    );
    expect(nc3.refusal).toBe('rejected-verifier-mismatch');
  });
});

describe('rev6 R1-2: the summary is the evidence the report quotes', () => {
  it('counts admitted/audited/fired and keeps judged === admitted + audited', () => {
    let summary = emptyWritebackGateSummary(true);
    const admitted = judgeWriteback(
      view({ verificationStatus: 'passed', trustedSource: true }),
      indexWritebackHistory(history('action-a', 2, 0))
    );
    const refused = judgeWriteback(
      view({ actionKey: 'action-b', verificationStatus: 'unknown' }),
      indexWritebackHistory([])
    );
    summary = accumulateWritebackSummary(summary, admitted);
    summary = accumulateWritebackSummary(summary, refused);

    expect(summary.judged).toBe(2);
    expect(summary.admitted).toBe(1);
    expect(summary.auditedOnly).toBe(1);
    expect(summary.gateFired).toBe(1);
    expect(summary.judged).toBe(summary.admitted + summary.auditedOnly);
    expect(summary.routeCounts['kept-fail-to-pass']).toBe(1);
    expect(summary.refusalCounts['rejected-no-verdict']).toBe(1);
  });

  it('the OFF summary reports enabled:false with zero everything', () => {
    const summary = emptyWritebackGateSummary(false);
    expect(summary.enabled).toBe(false);
    expect(summary.judged).toBe(0);
    expect(summary.gateFired).toBe(0);
  });

  it('undefined verdicts do not move the counters', () => {
    const summary = accumulateWritebackSummary(emptyWritebackGateSummary(true), undefined);
    expect(summary.judged).toBe(0);
  });
});

describe('rev6 R1-2: applying a verdict never mints a positive reward', () => {
  it('an admitted record is returned unchanged (the gate is not a scorer)', () => {
    const record = { reward: 1.25, learningEligible: true };
    const applied = applyWritebackVerdict(record, judgeWriteback(
      view({ verificationStatus: 'passed', trustedSource: true }),
      indexWritebackHistory(history('action-a', 2, 0))
    ));
    expect(applied.reward).toBe(1.25);
    expect(applied.learningEligible).toBe(true);
  });

  it('an audited record keeps its reward for audit but is forced INELIGIBLE', () => {
    const record = { reward: 2.5, learningEligible: true };
    const applied = applyWritebackVerdict(record, judgeWriteback(
      view({ verificationStatus: 'unknown' }),
      indexWritebackHistory([])
    ));
    // The reward stays (hiding harm was the original defect) ...
    expect(applied.reward).toBe(2.5);
    // ... but the record can no longer train, so no consumer reads a gain.
    expect(applied.learningEligible).toBe(false);
  });

  it('an already-ineligible record can never be RAISED by an admitted verdict', () => {
    const record = { reward: 0, learningEligible: false };
    const applied = applyWritebackVerdict(record, judgeWriteback(
      view({ verificationStatus: 'passed', trustedSource: true, recordLearningEligible: false }),
      indexWritebackHistory(history('action-a', 2, 0))
    ));
    expect(applied.learningEligible).toBe(false);
  });
});
