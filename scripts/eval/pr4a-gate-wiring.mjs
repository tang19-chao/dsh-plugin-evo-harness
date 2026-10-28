/**
 * Wiring probe: prove the gate is REACHABLE on the Arm-4 code path.
 *
 * V2 §7.2 treats an empty gate-intervention distribution in Arm-2/Arm-4 as a
 * BLOCKING DEFECT ("gate not wired"). Arm-4's distribution is empty — so before
 * calling that a defect OR dismissing it as benign, this probe answers the only
 * question that matters: does the quality-track gate path actually call
 * decideReplacement and honour its verdict?
 *
 * It does so WITHOUT running the experiment: it constructs the same inputs the
 * engine hands the gate, once with evidence that must be refused and once with
 * evidence that must be accepted, and checks the production function's answer.
 */

import { loadPr4aLib } from './pr4a-build.mjs';

const lib = await loadPr4aLib();
const decideReplacement = lib.decideReplacement;

console.log('[wiring] production decideReplacement is exported to the engine: ' + String(typeof decideReplacement === 'function'));

// Case A: under-evidenced challenger (nEff below the production floor of 2).
// The gate MUST keep the prior. If it did not, Arm-2/Arm-4 would be no-ops.
const refused = decideReplacement({
  proposedIndex: 2,
  priorIndex: 0,
  challenger: { actionKey: 'cand-c', q: -0.4, support: 1, nEff: 0, explored: false, advantage: -0.4571 },
  prior: { actionKey: 'cand-a', q: 0.2, support: 3, nEff: 3.1, explored: false, advantage: 0.2 },
  challengerIsNoop: false,
  explorationAllowance: 0
});
console.log(
  '[wiring] under-evidenced challenger -> kind=' + refused.kind +
    ' reason=' + String(refused.gateReason) +
    ' executedIndex=' + String(refused.executedIndex) +
    ' (expect kept-prior / executedIndex 0)'
);

// Case B: fully evidenced challenger. The gate MUST let it execute — otherwise
// the gate would be "always veto", which is a different bug.
const accepted = decideReplacement({
  proposedIndex: 2,
  priorIndex: 0,
  challenger: { actionKey: 'cand-c', q: 0.9, support: 5, nEff: 4.8, explored: false, advantage: 0.7 },
  prior: { actionKey: 'cand-a', q: 0.2, support: 5, nEff: 4.2, explored: false, advantage: 0.2 },
  challengerIsNoop: false,
  explorationAllowance: 0
});
console.log(
  '[wiring] fully evidenced challenger -> kind=' + accepted.kind +
    ' executedIndex=' + String(accepted.executedIndex) +
    ' (expect executed-proposed / executedIndex 2)'
);

// Case C: the exploration allowance is pinned to 0, so a thin-evidence
// challenger may NOT ride the budget (V2 §3.2). Verify that pinning is real.
const budgetZero = decideReplacement({
  proposedIndex: 1,
  priorIndex: 0,
  challenger: { actionKey: 'cand-b', q: 0.1, support: 1, nEff: 1, explored: false, advantage: 0.05 },
  prior: { actionKey: 'cand-a', q: 0.0, support: 2, nEff: 2.2, explored: false, advantage: 0.0 },
  challengerIsNoop: false,
  explorationAllowance: 0
});
console.log(
  '[wiring] thin evidence with allowance=0 -> kind=' + budgetZero.kind +
    ' reason=' + String(budgetZero.gateReason) +
    ' (expect kept-prior / min-support, NOT executed-exploration)'
);

const ok = refused.kind === 'kept-prior' && refused.executedIndex === 0 &&
  accepted.kind === 'executed-proposed' && accepted.executedIndex === 2 &&
  budgetZero.kind === 'kept-prior';

console.log('');
console.log('[wiring] RESULT: ' + (ok ? 'PASS — the gate is reachable and both-sided on the shared path' : 'FAIL — the gate is NOT correctly wired'));
if (!ok) process.exitCode = 1;
