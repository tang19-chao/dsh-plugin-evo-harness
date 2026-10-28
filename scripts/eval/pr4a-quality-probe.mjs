/**
 * Why do the quality arms never deviate from the prior?
 *
 * A degenerate cell is a legitimate finding, but only if the MECHANISM is
 * described accurately. This probe prints the reward/adjustment structure the
 * quality track actually sees, so the report can say why instead of guessing.
 */

import { loadPr4aLib } from './pr4a-build.mjs';

const lib = await loadPr4aLib();
const order = lib.pr4aTaskOrder();

lib.resetArmTrust();
const { arm, ledger } = await lib.runPr4aArmWithLedger({ armId: 'Arm-3', taskOrder: order });

console.log('[quality] policyChangeRate=' + arm.policyChangeRate.toFixed(4));
console.log('[quality] meanSupport=' + arm.meanSupport.toFixed(3) + ' meanNEff=' + arm.meanNEff.toFixed(3));
console.log('[quality] trustedVerdicts=' + String(arm.verification.trustedVerdicts) + '/' + String(arm.recordsAppended));
console.log('[quality] auditOnly executions=' + String(arm.verification.auditOnly) +
  ' writeAccounting=' + JSON.stringify(arm.writeAccounting) +
  ' rowTrackMismatch=' + String(arm.learningTrackRows.mismatched));

// Distribution of chosen vs prior and of the advantage the track computed.
const rows = ledger;
const byRound = new Map();
for (const row of rows) {
  const key = 'r' + row.round;
  const bucket = byRound.get(key) ?? { total: 0, deviated: 0, advSum: 0, supportSum: 0 };
  bucket.total += 1;
  if (row.proposedDeviation) bucket.deviated += 1;
  bucket.advSum += row.advantage;
  bucket.supportSum += row.challengerSupport;
  byRound.set(key, bucket);
}
console.log('[quality] per-round deviation rate and mean advantage:');
for (const [key, bucket] of [...byRound.entries()].sort()) {
  console.log(
    '   ' + key +
      ' total=' + String(bucket.total) +
      ' deviated=' + String(bucket.deviated) +
      ' meanAdvantage=' + (bucket.advSum / bucket.total).toFixed(4) +
      ' meanSupport=' + (bucket.supportSum / bucket.total).toFixed(2)
  );
}

// Is the prior always the argmax? Compare prior index distribution.
const priorCounts = new Map();
for (const row of rows) priorCounts.set(row.priorChoice, (priorCounts.get(row.priorChoice) ?? 0) + 1);
console.log('[quality] priorChoice distribution: ' + JSON.stringify([...priorCounts.entries()].sort()));

// Sample a mid-run decision to show support/advantage per candidate shape.
const sample = rows.filter((row) => row.round === 1 && row.run === 3).slice(0, 3);
for (const row of sample) {
  console.log(
    '   sample ' + row.taskId + ' support=' + String(row.challengerSupport) +
      ' adv=' + row.advantage.toFixed(4) + ' q=' + String(row.q) +
      ' v=' + row.v.toFixed(4) + ' prior=' + String(row.priorChoice) +
      ' proposed=' + String(row.chosenChoice) + ' exec=' + String(row.executedIndex)
  );
}

// Arm-1 for contrast: it DOES deviate, so the difference is the track, not the pool.
lib.resetArmTrust();
const a1 = await lib.runPr4aArmWithLedger({ armId: 'Arm-1', taskOrder: order });
console.log('');
console.log('[process] Arm-1 policyChangeRate=' + a1.arm.policyChangeRate.toFixed(4) +
  ' meanSupport=' + a1.arm.meanSupport.toFixed(3) + ' meanNEff=' + a1.arm.meanNEff.toFixed(3));
const a2 = await lib.runPr4aArmWithLedger({ armId: 'Arm-2', taskOrder: order });
console.log('[process] Arm-2 policyChangeRate=' + a2.arm.policyChangeRate.toFixed(4) +
  ' gateKept=' + String(a2.arm.gate.keptPrior));
