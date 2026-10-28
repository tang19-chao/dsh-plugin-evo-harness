/**
 * Diagnosis probe: why does Arm-4's gate never fire when Arm-2's does?
 *
 * V2 §7.2 states that an EMPTY gate-intervention distribution in Arm-2/Arm-4 is
 * a BLOCKING DEFECT ("gate not wired"), not a benign zero. So this must be
 * explained from data, not assumed away.
 */

import { loadPr4aLib } from './pr4a-build.mjs';

const lib = await loadPr4aLib();
const order = lib.pr4aTaskOrder();

for (const id of ['Arm-1', 'Arm-2', 'Arm-3', 'Arm-4']) {
  lib.resetArmTrust();
  const { arm, ledger } = await lib.runPr4aArmWithLedger({ armId: id, taskOrder: order });
  const proposed = ledger.filter((row) => row.proposedDeviation);
  const supportedProposals = proposed.filter((row) => row.challengerSupport > 0);
  const measured = ledger.filter((row) => row.challengerNEff !== null);
  const rewardMean =
    arm.tasks.length === 0
      ? 0
      : arm.tasks.reduce((sum, task) => sum + task.meanCoverage, 0) / arm.tasks.length;
  console.log('=== ' + id);
  console.log('  spec: track=' + arm.spec.track + ' gate=' + String(arm.spec.conservativeGate));
  console.log('  policyChangeRate=' + arm.policyChangeRate.toFixed(4) +
    ' proposedDeviations=' + String(proposed.length) +
    ' supportedProposals=' + String(supportedProposals.length));
  console.log('  gate applied=' + String(arm.gate.applied) + ' keptPrior=' + String(arm.gate.keptPrior) +
    ' reasons=' + JSON.stringify(arm.gate.reasons));
  // §3.4: the four challenger fields are unconditional, so the count must be 180
  // on EVERY learning arm - gate off included. A smaller number is the defect.
  console.log('  ledger rows with a measured challenger nEff=' + String(measured.length) + '/' + String(ledger.length));
  console.log('  meanSupport=' + arm.meanSupport.toFixed(3) + ' meanNEff=' + arm.meanNEff.toFixed(3) +
    ' meanChallengerNEff=' + arm.meanChallengerNEff.toFixed(3) +
    ' meanCoverage=' + rewardMean.toFixed(3));
  console.log('  records=' + String(arm.recordsAppended) + ' trusted=' + String(arm.verification.trustedVerdicts) +
    ' auditOnly=' + String(arm.verification.auditOnly) +
    ' rowTrackMismatch=' + String(arm.learningTrackRows.mismatched));
  // sample of the first few proposed deviations, if any
  for (const row of proposed.slice(0, 3)) {
    console.log('    dev ' + row.taskId + ' r' + row.run + '/' + row.round +
      ' prior=' + String(row.priorChoice) + ' proposed=' + String(row.chosenChoice) +
      ' exec=' + String(row.executedIndex) + ' gateEvaluated=' + String(row.gateEvaluated) +
      ' support=' + String(row.challengerSupport) +
      ' nEff=' + String(row.challengerNEff) + ' A=' + row.challengerAdvantage.toFixed(4) +
      ' verdict=' + row.gateVerdict + ' reason=' + String(row.gateReason));
  }
}
