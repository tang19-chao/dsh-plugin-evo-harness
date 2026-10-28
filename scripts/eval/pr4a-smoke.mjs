/**
 * Smoke probe: run each arm once and print the facts that would invalidate the
 * experiment if they were wrong.
 *
 * This is NOT the deliverable — it is the fast falsification check run BEFORE
 * the full report is built, so a broken engine surfaces here instead of inside a
 * 900-row artifact that looks plausible.
 */

import { loadPr4aLib } from './pr4a-build.mjs';

const lib = await loadPr4aLib();
const arms = ['Arm-0', 'Arm-1', 'Arm-2', 'Arm-3', 'Arm-4'];
const order = lib.pr4aTaskOrder();

console.log('[smoke] protocol: ' + lib.PROTOCOL_ID);
console.log('[smoke] shared execution order: ' + order.join(','));
console.log('');

const results = [];
for (const id of arms) {
  lib.resetArmTrust();
  const started = Date.now();
  const { arm, ledger } = await lib.runPr4aArmWithLedger({ armId: id, taskOrder: order });
  const elapsed = Date.now() - started;
  results.push({ arm, ledger });
  console.log(
    id.padEnd(6) +
      ' VR=' + arm.verifiedRate.toFixed(3) +
      ' cov=' + arm.meanCoverage.toFixed(3) +
      ' rec=' + String(arm.recordsAppended).padStart(3) +
      ' track=' + String(arm.wroteTrack) +
      ' gate=' + String(arm.gate.applied).padStart(3) +
      ' kept=' + String(arm.gate.keptPrior).padStart(3) +
      ' trusted=' + String(arm.verification.trustedVerdicts).padStart(3) +
      ' rcpt=' + String(arm.verification.receiptsIssued).padStart(3) +
      ' frozen=' + String(arm.snapshotFrozen) +
      ' ledger=' + String(ledger.length).padStart(3) +
      ' notional=' + String(arm.cost.notionalCostMicros) + 'u' +
      ' ' + String(elapsed) + 'ms'
  );
  if (arm.notes.length > 0) console.log('       notes: ' + arm.notes.join(' | '));
}

console.log('');
console.log('=== invariance checks ===');

// 1. every arm must produce the same pool digests at the same coordinates
const poolByArm = results.map((entry) => {
  const map = new Map();
  for (const row of entry.ledger) map.set(row.taskId + '|' + row.run + '|' + row.round, row.poolDigest);
  return map;
});
let poolMismatch = 0;
const firstPool = poolByArm[0];
for (let i = 1; i < poolByArm.length; i += 1) {
  for (const [key, digest] of firstPool) {
    const other = poolByArm[i].get(key);
    if (other !== undefined && other !== digest) poolMismatch += 1;
  }
}
console.log('pool digest mismatches across arms: ' + String(poolMismatch) + ' (must be 0)');

// 2. record ids must be disjoint across arms (V2 §5.4.4)
let overlaps = 0;
for (let i = 0; i < results.length; i += 1) {
  for (let j = i + 1; j < results.length; j += 1) {
    const left = new Set(results[i].arm.storeRecordIds);
    for (const id of results[j].arm.storeRecordIds) {
      if (left.has(id)) overlaps += 1;
    }
  }
}
console.log('cross-arm record id overlaps: ' + String(overlaps) + ' (must be 0)');

// 3. Arm-0 must be frozen
const arm0 = results[0].arm;
console.log(
  'Arm-0 frozen: records=' + String(arm0.recordsAppended) +
    ' initial=' + arm0.initialSnapshotDigest +
    ' final=' + arm0.finalSnapshotDigest +
    ' equal=' + String(arm0.initialSnapshotDigest === arm0.finalSnapshotDigest)
);

// 4. tracks must match the design — PER ROW, since the last-write scalar
//    (`wroteTrack`) still passes when a single early row went to the wrong track.
for (const entry of results) {
  const expected = entry.arm.spec.track;
  const rows = entry.arm.learningTrackRows;
  const ok = entry.arm.spec.writesBack ? rows.mismatched === 0 : rows.written === 0;
  console.log(
    entry.arm.armId + ' track ' + String(entry.arm.wroteTrack) + ' expected ' + expected +
      ' -> ' + (ok ? 'OK' : 'MISMATCH') +
      ' (rows written=' + String(rows.written) +
      ' matching=' + String(rows.matching) +
      ' mismatched=' + String(rows.mismatched) +
      ' ; audit-only violations=' + String(entry.arm.auditOnlyViolations) + ')'
  );
}

// 4b. §3.4: the four challenger fields exist on EVERY row, gate off included.
for (const entry of results) {
  const measurable = entry.ledger.filter(
    (row) =>
      typeof row.challengerSupport === 'number' &&
      typeof row.challengerShrunkAdvantage === 'number' &&
      typeof row.challengerCalibratedAdvantage === 'number'
  ).length;
  console.log(
    entry.arm.armId + ' challenger fields on ' + String(measurable) + '/' + String(entry.ledger.length) +
      ' rows (must be all rows except the frozen reference, which has no write-back)'
  );
}

// 5. gate arms must actually intercept (V2 §7.2 blocking defect if empty)
for (const entry of results) {
  if (!entry.arm.spec.conservativeGate) continue;
  const applied = entry.arm.gate.applied;
  console.log(
    entry.arm.armId + ' gate applied=' + String(applied) + ' keptPrior=' + String(entry.arm.gate.keptPrior) +
      ' reasons=' + JSON.stringify(entry.arm.gate.reasons)
  );
}

// 6. zero live cost assertion
for (const entry of results) {
  if (entry.arm.cost.liveCalls !== 0 || entry.arm.cost.incurredRealUsd !== 0) {
    console.log('ZERO-COST VIOLATION in ' + entry.arm.armId);
  }
}
console.log('liveCalls=0 and incurredRealUsd=0 on all arms: ' +
  String(results.every((entry) => entry.arm.cost.liveCalls === 0 && entry.arm.cost.incurredRealUsd === 0)));
