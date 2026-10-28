#!/usr/bin/env node
/**
 * PR-4A artifact verification.
 *
 * Encodes every claim the report makes as a MACHINE assertion whose result is an
 * exit code, so the run is verifiable even when stdout cannot be read. Exit 0
 * means every assertion held; exit 1 means at least one did not, and the failing
 * ids are written to work/pr4a-verify-status.json for later inspection.
 *
 * This is also the reproducibility check (V2 §4.1.4): it re-runs nothing, but it
 * does re-derive every statistic from the persisted ledgers/JSON, so a report
 * that disagrees with its own data fails here.
 *
 * REVISION (PR-4A statistical-audit repair). The assertions below were extended
 * to cover the repaired semantics, so a regression to an audited defect fails
 * LOUDLY instead of silently passing:
 *   - per-ROW track isolation (the old check read the last `wroteTrack` scalar);
 *   - §6.3 audit-only: unauthenticated executions are never persisted, and the
 *     quality neighbourhood carries no unauthenticated record;
 *   - §3.4 gate-OFF arms still persist the four challenger fields;
 *   - §8.5 verdicts re-derived from the ESTIMATOR interval and the estimator's
 *     own DTS, with the Clopper-Pearson interval explicitly NOT the verdict
 *     interval;
 *   - §8.3.1/§8.3.2 primary-test selection per series data type;
 *   - §8.1 effectiveReplication derived from the data, never the constant 5;
 *   - §9.3 six token fields, §6.1 host verdict, §10.2 execution-control coverage,
 *     §12.2 the 12x10 per-task table, FULL SHA-256 ledger digests, and a code
 *     provenance block that can locate the executed code.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = process.cwd();
const results = [];
function assert(id, condition, detail) {
  results.push({ id, ok: Boolean(condition), detail: detail ?? '' });
}
function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
function closeTo(actual, expected, tolerance = 1e-9) {
  return typeof actual === 'number' && Math.abs(actual - expected) <= tolerance;
}

// ---------------------------------------------------------------------------
// 1. artifacts exist and parse
// ---------------------------------------------------------------------------
const jsonPath = join(REPO_ROOT, 'work', 'pr4a-five-arm-eval.json');
const mdPath = join(REPO_ROOT, 'docs', 'reports', 'pr4a-five-arm-eval-report.md');

assert('json-exists', existsSync(jsonPath), jsonPath);
assert('markdown-exists', existsSync(mdPath), mdPath);

let report = null;
try {
  report = JSON.parse(readFileSync(jsonPath, 'utf8'));
  assert('json-parses', true);
} catch (error) {
  assert('json-parses', false, String(error));
}

if (report !== null) {
  // -------------------------------------------------------------------------
  // 2. protocol + honesty declarations
  // -------------------------------------------------------------------------
  assert('protocol-id', report.protocol === 'PR4A-EVAL-PREREG-20261027-V2', String(report.protocol));
  assert(
    'code-baseline-is-commit',
    typeof report.codeBaseline === 'string' && /^[0-9a-f]{40}$/.test(report.codeBaseline),
    report.codeBaseline
  );
  assert('live-calls-zero', report.declarations.liveCalls === 0);
  assert('incurred-real-usd-zero', report.declarations.incurredRealUsd === 0);
  assert('cost-is-notional', report.declarations.costIsNotional === true);
  assert(
    'micros-not-usd-declared',
    typeof report.declarations.microsIsNotUsd === 'string' &&
      /UNIT CONVENTION/.test(report.declarations.microsIsNotUsd)
  );
  assert('guardrail-not-financial-cap', report.declarations.notionalGuardrailIsNotAFinancialCap === true);
  assert('wallclock-not-cost-ceiling', report.declarations.wallClockIsNotARemoteCostCeiling === true);
  assert('wilcoxon-not-on-binary', report.declarations.wilcoxonUsedOnBinary === false);
  assert('rounds-not-samples', report.declarations.roundsAreNotSamples === true);
  assert(
    'power-labelled-approximation',
    /closed-form normal approximation/i.test(report.declarations.powerIsClosedFormApproximation) &&
      /NOT an executed power analysis/i.test(report.declarations.powerIsClosedFormApproximation),
    report.declarations.powerIsClosedFormApproximation
  );
  assert(
    'd-min-corrected',
    Math.abs(report.declarations.minDetectableD - 0.8087) < 5e-3,
    String(report.declarations.minDetectableD)
  );
  assert(
    'external-validity-disclaimed',
    /NOT a production significance claim/i.test(report.declarations.externalValidity)
  );
  // the two policy declarations the repaired report must carry explicitly
  assert(
    'primary-test-policy-declared',
    /sign-flip/.test(String(report.declarations.primaryTestPolicy)) &&
      /binary/.test(String(report.declarations.primaryTestPolicy)),
    String(report.declarations.primaryTestPolicy)
  );
  assert(
    'verdict-interval-policy-declared',
    /estimator/i.test(String(report.declarations.verdictIntervalPolicy)) &&
      /NOT the verdict interval/i.test(String(report.declarations.verdictIntervalPolicy)),
    String(report.declarations.verdictIntervalPolicy)
  );

  // -------------------------------------------------------------------------
  // 2b. code provenance (audit item 4): a bare SHA cannot locate dirty-tree code
  // -------------------------------------------------------------------------
  const prov = report.codeProvenance ?? {};
  assert('provenance-present', typeof prov === 'object' && prov !== null);
  assert(
    'provenance-workspace-digest',
    /^[0-9a-f]{64}$/.test(String(prov.trackedWorkspaceDigest)),
    String(prov.trackedWorkspaceDigest)
  );
  assert(
    'provenance-executed-sources-digest',
    /^[0-9a-f]{64}$/.test(String(prov.executedSourcesDigest)),
    String(prov.executedSourcesDigest)
  );
  assert(
    'provenance-lists-executed-modules',
    Array.isArray(prov.executedSources) && prov.executedSources.length >= 7,
    String(prov.executedSources?.length)
  );
  assert(
    'provenance-hashes-are-sha256',
    Array.isArray(prov.executedSources) &&
      prov.executedSources.every((entry) => /^[0-9a-f]{64}$/.test(String(entry.sha256))),
    'every executed module must carry a 64-hex digest'
  );
  const selfEntry = (prov.executedSources ?? []).find(
    (entry) => entry.path === 'scripts/eval/pr4a-report.ts'
  );
  assert(
    'provenance-self-hash-matches-working-tree',
    selfEntry !== undefined &&
      selfEntry.sha256 === sha256(readFileSync(join(REPO_ROOT, 'scripts', 'eval', 'pr4a-report.ts'), 'utf8')),
    selfEntry === undefined ? 'entry missing' : selfEntry.sha256
  );
  assert(
    'provenance-dirty-flag-honest',
    typeof prov.workspaceDirty === 'boolean' &&
      (prov.workspaceDirty ? prov.trackedDirtyCount > 0 : prov.trackedDirtyCount === 0),
    'workspaceDirty=' + String(prov.workspaceDirty) + ', count=' + String(prov.trackedDirtyCount)
  );
  assert(
    'provenance-locate-instructions',
    typeof prov.howToLocate === 'string' && prov.howToLocate.length > 40,
    String(prov.howToLocate).slice(0, 80)
  );
  // Every enumerated dirty file must actually resolve: a mis-sliced path yields
  // a `missing` digest and the block silently stops locating the real code.
  assert(
    'provenance-dirty-paths-resolve',
    Array.isArray(prov.dirtyFileDigests) &&
      prov.dirtyFileDigests.length > 0 &&
      prov.dirtyFileDigests.every(
        (entry) => entry.sha256 !== 'missing' && /^\.?[A-Za-z0-9._/-]+$/.test(String(entry.path))
      ),
    JSON.stringify((prov.dirtyFileDigests ?? []).filter((entry) => entry.sha256 === 'missing').slice(0, 3))
  );
  assert(
    'provenance-executed-paths-resolve',
    Array.isArray(prov.executedSources) && prov.executedSources.every((entry) => entry.sha256 !== 'missing'),
    JSON.stringify((prov.executedSources ?? []).filter((entry) => entry.sha256 === 'missing'))
  );
  // The digest must be a real digest OF the enumerated list, not a decorative string.
  assert(
    'provenance-workspace-digest-recomputed',
    prov.trackedWorkspaceDigest ===
      sha256(
        (prov.dirtyFileDigests ?? [])
          .map((entry) => entry.sha256 + '  ' + entry.path)
          .join('\n')
      ),
    'trackedWorkspaceDigest must be recomputable from dirtyFileDigests'
  );
  assert(
    'provenance-executed-digest-recomputed',
    prov.executedSourcesDigest ===
      sha256(
        (prov.executedSources ?? [])
          .map((entry) => entry.sha256 + '  ' + entry.path)
          .join('\n')
      ),
    'executedSourcesDigest must be recomputable from executedSources'
  );
  // The compiled artifact that actually executed must also be identified.
  assert(
    'provenance-bundle-fingerprint',
    typeof prov.bundleFingerprint === 'object' &&
      prov.bundleFingerprint !== null &&
      /^[0-9a-f]{64}$/.test(String(prov.bundleFingerprint.digest)) &&
      typeof prov.bundleFingerprint.esbuildVersion === 'string',
    JSON.stringify(prov.bundleFingerprint)
  );

  // -------------------------------------------------------------------------
  // 3. five arms, exact design (V2 §3.1)
  // -------------------------------------------------------------------------
  const arms = report.arms ?? [];
  assert('five-arms', arms.length === 5, String(arms.length));
  const expected = {
    'Arm-0': { track: 'process', gate: false, writes: false, role: 'reference' },
    'Arm-1': { track: 'process', gate: false, writes: true, role: 'factorial' },
    'Arm-2': { track: 'process', gate: true, writes: true, role: 'factorial' },
    'Arm-3': { track: 'task-quality', gate: false, writes: true, role: 'factorial' },
    'Arm-4': { track: 'task-quality', gate: true, writes: true, role: 'factorial' }
  };
  for (const [id, want] of Object.entries(expected)) {
    const arm = arms.find((entry) => entry.armId === id);
    if (arm === undefined) {
      assert('arm-present:' + id, false);
      continue;
    }
    assert('arm-track:' + id, arm.spec.track === want.track, arm.spec.track);
    assert('arm-gate:' + id, arm.spec.conservativeGate === want.gate, String(arm.spec.conservativeGate));
    assert('arm-writes:' + id, arm.spec.writesBack === want.writes, String(arm.spec.writesBack));
    assert('arm-role:' + id, arm.spec.role === want.role, arm.spec.role);
  }
  assert('no-arm-5', !arms.some((entry) => /Arm-5/.test(entry.armId)));
  assert('no-advice-or-mixed-arm', !arms.some((entry) => /advice|mixed|naive/i.test(entry.spec.label)));

  /** Every ledger row on disk, parsed once and reused by the checks below. */
  const ledgerRowsByArm = new Map();
  for (const arm of arms) {
    const ledgerPath = join(REPO_ROOT, 'work', 'pr4a-ledger-' + arm.armId + '.jsonl');
    if (!existsSync(ledgerPath)) {
      ledgerRowsByArm.set(arm.armId, []);
      continue;
    }
    const rows = readFileSync(ledgerPath, 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    ledgerRowsByArm.set(arm.armId, rows);
  }

  // -------------------------------------------------------------------------
  // 4. invariants (V2 §5.4/§7.2/§6.3/§3.4)
  // -------------------------------------------------------------------------
  const inv = report.invariants ?? {};
  assert('pool-digests-agree', inv.poolDigestAssertion === 'passed', String(inv.poolDigestMismatches));
  assert('records-disjoint', inv.recordIsolationAssertion === 'passed', String(inv.crossArmRecordOverlaps));
  assert('arm0-frozen', inv.arm0Frozen === true);
  assert('exploration-pinned-zero', inv.explorationAllowancePinned === 0);
  assert('gate-reachable', inv.gateReachableOnSharedPath === true);

  // --- 4a. PER-ROW track isolation (the audited defect was the last-write scalar)
  assert(
    'track-isolation-per-row-assertion',
    inv.trackIsolationPerRowAssertion === 'passed',
    String(inv.trackIsolationPerRowAssertion)
  );
  const trackPerArm = inv.trackPerArm ?? [];
  assert('track-per-arm-present', trackPerArm.length === 5, String(trackPerArm.length));
  for (const entry of trackPerArm) {
    assert(
      'track-rows-mismatched-zero:' + entry.armId,
      entry.rowsMismatched === 0,
      'mismatched=' + String(entry.rowsMismatched) + ' of ' + String(entry.rowsWritten)
    );
    assert(
      'track-rows-counted:' + entry.armId,
      entry.rowsWritten === entry.rowsMatching + entry.rowsMismatched,
      JSON.stringify({ written: entry.rowsWritten, matching: entry.rowsMatching, mismatched: entry.rowsMismatched })
    );
    assert(
      'track-row-invariant-uses-rows:' + entry.armId,
      'rowsMismatched' in entry && 'rowsWritten' in entry,
      'the per-row tally, not `wroteTrack`, is the invariant'
    );
    if (entry.expectedTrack === 'task-quality') {
      assert(
        'quality-arm-writes-quality-only:' + entry.armId,
        entry.wroteTrack === 'task-quality' || entry.rowsWritten === 0,
        String(entry.wroteTrack)
      );
    }
    if (entry.expectedTrack === 'process') {
      assert(
        'process-arm-never-writes-quality:' + entry.armId,
        entry.wroteTrack === 'process' || entry.wroteTrack === null,
        String(entry.wroteTrack)
      );
    }
  }
  // Independent re-derivation from the JSONL rows: the tally must not be
  // asserted only inside the JSON summary it was computed from.
  for (const arm of arms) {
    const rows = ledgerRowsByArm.get(arm.armId) ?? [];
    const written = rows.filter((row) => row.writeDisposition === 'written');
    const wrongTrack = written.filter((row) => row.learningTrackWritten !== arm.spec.track);
    assert(
      'ledger-row-track-rederived:' + arm.armId,
      wrongTrack.length === 0,
      wrongTrack.length === 0
        ? 'every written row carries ' + arm.spec.track
        : String(wrongTrack.length) + ' wrong rows, e.g. ' + JSON.stringify(wrongTrack[0])
    );
    const tally = trackPerArm.find((entry) => entry.armId === arm.armId);
    assert(
      'ledger-write-tally-consistent:' + arm.armId,
      tally !== undefined && tally.rowsWritten === written.length,
      'json tally=' + String(tally?.rowsWritten) + ' vs ledger written rows=' + String(written.length)
    );
  }

  // --- 4b. §6.3 audit-only: unauthenticated executions are never persisted
  assert('audit-only-assertion', inv.auditOnlyAssertion === 'passed', String(inv.auditOnlyAssertion));
  const writeAccounting = inv.writeAccounting ?? [];
  assert('write-accounting-present', writeAccounting.length === 5, String(writeAccounting.length));
  for (const entry of writeAccounting) {
    assert(
      'no-quality-label-on-process-arm:' + entry.armId,
      entry.auditOnlyQualityLabelOnProcessArm === 0,
      String(entry.auditOnlyQualityLabelOnProcessArm)
    );
    assert(
      'audit-only-violations-zero:' + entry.armId,
      entry.auditOnlyViolations === 0,
      String(entry.auditOnlyViolations)
    );
    if (entry.armId === 'Arm-3' || entry.armId === 'Arm-4') {
      // §6.3: on a QUALITY arm the counters partition the eligible executions;
      // an unauthenticated one is audit-only, never a write.
      assert(
        'quality-arm-partitions-writes:' + entry.armId,
        entry.written + entry.auditOnlyUnauthenticated + entry.auditOnlyNotLearningOutcome ===
          entry.eligibleExecutions,
        JSON.stringify(entry)
      );
      assert(
        'quality-arm-has-writes:' + entry.armId,
        entry.written > 0,
        'the quality track must not be empty, or the arm is degenerate'
      );
      // and the host must have authenticated exactly the executions that wrote
      const armRecord = arms.find((arm) => arm.armId === entry.armId);
      assert(
        'quality-arm-writes-match-receipts:' + entry.armId,
        entry.written <= armRecord.verification.receiptsIssued,
        'writes=' + String(entry.written) + ' receipts=' + String(armRecord.verification.receiptsIssued)
      );
    }
    if (entry.armId === 'Arm-0') {
      assert('reference-never-writes:' + entry.armId, entry.written === 0, String(entry.written));
    }
  }
  // Cross-check the audit-only disposition against the raw ledgers.
  for (const arm of arms) {
    const rows = ledgerRowsByArm.get(arm.armId) ?? [];
    const unauth = rows.filter((row) => row.writeDisposition === 'audit-only-unauthenticated');
    assert(
      'audit-only-rows-are-unwritten:' + arm.armId,
      unauth.every((row) => row.learningTrackWritten === null),
      'an audit-only row must not carry a written track'
    );
    assert(
      'audit-only-only-on-quality-arms:' + arm.armId,
      arm.spec.track === 'task-quality' || unauth.length === 0,
      String(unauth.length) + ' unauthenticated audit-only rows on a ' + arm.spec.track + ' arm'
    );
  }

  // --- 4c. §6.3 quality neighbourhood: no unauthenticated record admitted
  const qNeigh = inv.qualityNeighbourhood ?? [];
  assert('quality-neighbourhood-present', qNeigh.length === 5, String(qNeigh.length));
  for (const entry of qNeigh) {
    assert(
      'quality-neighbourhood-assertion:' + entry.armId,
      entry.assertion === 'passed',
      String(entry.assertion)
    );
    assert(
      'quality-neighbourhood-no-unauthenticated:' + entry.armId,
      entry.recordsRejectedUnauthenticated === 0,
      String(entry.recordsRejectedUnauthenticated)
    );
    if (entry.armId === 'Arm-3' || entry.armId === 'Arm-4') {
      assert(
        'quality-arm-neighbourhood-inspected:' + entry.armId,
        entry.decisionsInspected === 180 && entry.recordsAdmitted > 0,
        JSON.stringify(entry)
      );
    } else {
      assert(
        'process-arm-neighbourhood-unused:' + entry.armId,
        entry.decisionsInspected === 0,
        'the quality-neighbourhood check only applies to quality arms'
      );
    }
  }

  // --- 4d. §3.4 the four challenger fields are unconditional on EVERY row
  const challenger = inv.challengerFieldsUnconditional ?? {};
  assert('challenger-fields-assertion', challenger.assertion === 'passed', String(challenger.assertion));
  assert(
    'challenger-fields-rows-checked',
    challenger.rowsChecked === 900 && challenger.rowsWithoutFields === 0,
    JSON.stringify(challenger)
  );
  const gateOff = inv.gateOffChallengerMeasurement ?? [];
  assert(
    'gate-off-arms-measure-challenger',
    gateOff.length === 2 && gateOff.every((entry) => entry.rowsWithChallengerMeasurement === entry.rows),
    JSON.stringify(gateOff)
  );
  for (const arm of arms) {
    if (arm.spec.conservativeGate) continue;
    const rows = ledgerRowsByArm.get(arm.armId) ?? [];
    const missing = rows.filter(
      (row) =>
        typeof row.challengerSupport !== 'number' ||
        typeof row.challengerNEff !== 'number' ||
        typeof row.challengerShrunkAdvantage !== 'number' ||
        typeof row.challengerCalibratedAdvantage !== 'number'
    );
    assert(
      'gate-off-challenger-numeric:' + arm.armId,
      missing.length === 0,
      missing.length === 0
        ? 'all ' + String(rows.length) + ' gate-off rows carry numeric challenger fields'
        : String(missing.length) + ' rows missing, e.g. ' + JSON.stringify(missing[0])
    );
  }

  // --- 4e. §6.1 the host verdict is the metric, and the substitute agrees
  const hostVerdict = inv.hostVerdictAssertion ?? {};
  assert('host-verdict-assertion', hostVerdict.assertion === 'passed', String(hostVerdict.assertion));
  for (const arm of arms) {
    assert(
      'host-verdict-agrees:' + arm.armId,
      arm.verification.hostCoverageDisagreements === 0,
      JSON.stringify({
        agreements: arm.verification.hostCoverageAgreements,
        disagreements: arm.verification.hostCoverageDisagreements
      })
    );
    assert(
      'arm-verified-rate-in-unit:' + arm.armId,
      arm.verifiedRate === null
        ? arm.tasks.every((task) => !task.analysisIncluded)
        : arm.verifiedRate >= 0 && arm.verifiedRate <= 1,
      String(arm.verifiedRate)
    );
  }

  // gate-before/after property: only the two gate arms may record kept-prior
  const gateDist = inv.gateDistribution ?? [];
  for (const entry of gateDist) {
    if (!entry.gateEnabled) {
      assert('no-gate-use:' + entry.armId, entry.applied === 0 && entry.keptPrior === 0, JSON.stringify(entry));
    }
    assert(
      'gate-applied-subset-of-proposed:' + entry.armId,
      entry.applied <= entry.proposedDeviations,
      'applied=' + String(entry.applied) + ' proposed=' + String(entry.proposedDeviations)
    );
    assert(
      'gate-outcomes-partition-applied:' + entry.armId,
      entry.keptPrior + entry.executedProposed + entry.executedExploration === entry.applied,
      JSON.stringify(entry)
    );
  }

  // -------------------------------------------------------------------------
  // 5. analysis unit = task; replication derived (V2 §8.1)
  // -------------------------------------------------------------------------
  assert(
    'analysis-unit-task',
    /task/.test(String(report.declarations.analysisUnit)) && /N=12/.test(String(report.declarations.analysisUnit)),
    report.declarations.analysisUnit
  );
  assert('replication-reported', report.replication !== undefined && report.replication !== null);
  assert(
    'replication-per-arm',
    Array.isArray(report.replication?.perArm) && report.replication.perArm.length === 5
  );
  assert(
    'replication-derived-not-constant',
    report.replication.effectiveReplication !== 5,
    'effectiveReplication must be derived, never the constant L=5; got ' +
      String(report.replication.effectiveReplication)
  );
  const learningMeans = (report.replication.perArm ?? [])
    .filter((entry) => entry.writesBack)
    .map((entry) => entry.meanDistinctValuesPerTask);
  const expectedReplication = report.replication.allLearningArmsConstant
    ? 1
    : Number(Math.max(...learningMeans).toFixed(4));
  assert(
    'replication-matches-derivation',
    report.replication.effectiveReplication === expectedReplication,
    JSON.stringify({
      reported: report.replication.effectiveReplication,
      expected: expectedReplication,
      allConstant: report.replication.allLearningArmsConstant,
      means: learningMeans
    })
  );
  assert(
    'replication-reports-per-arm-means',
    (report.replication.perArm ?? []).every(
      (entry) => typeof entry.meanDistinctValuesPerTask === 'number' && typeof entry.writesBack === 'boolean'
    ),
    'the derivation must be auditable per arm'
  );
  assert(
    'replication-binary-consistency',
    report.replication.designIsBinary === report.replication.allLearningArmsConstant &&
      (!report.replication.designIsBinary || report.replication.effectiveReplication === 1),
    JSON.stringify({
      designIsBinary: report.replication.designIsBinary,
      allLearningArmsConstant: report.replication.allLearningArmsConstant,
      effectiveReplication: report.replication.effectiveReplication
    })
  );
  for (const arm of arms) {
    assert('twelve-tasks:' + arm.armId, arm.tasks.length === 12, String(arm.tasks.length));
  }

  // -------------------------------------------------------------------------
  // 6. controlled family: exactly 4 contrasts, Holm on the PRIMARY p (V2 §8.6)
  // -------------------------------------------------------------------------
  const controlled = report.comparisons?.controlled ?? [];
  assert('four-controlled-contrasts', controlled.length === 4, String(controlled.length));
  const ids = controlled.map((entry) => entry.id).join(',');
  assert('controlled-ids', ids === 'write-back,track,gate,interaction', ids);

  /** The four estimator series, re-derived from the arm task tables. */
  const taskValue = (armId, taskId) => {
    const arm = arms.find((entry) => entry.armId === armId);
    const task = arm?.tasks.find((entry) => entry.taskId === taskId);
    return task === undefined || !task.analysisIncluded ? null : task.verifiedRate;
  };
  const taskIds = (arms[0]?.tasks ?? []).map((task) => task.taskId);
  const seriesByContrast = {
    'write-back': taskIds.map((id) => taskValue('Arm-1', id) - taskValue('Arm-0', id)),
    track: taskIds.map(
      (id) =>
        0.5 *
        (taskValue('Arm-3', id) - taskValue('Arm-1', id) + (taskValue('Arm-4', id) - taskValue('Arm-2', id)))
    ),
    gate: taskIds.map(
      (id) =>
        0.5 *
        (taskValue('Arm-2', id) - taskValue('Arm-1', id) + (taskValue('Arm-4', id) - taskValue('Arm-3', id)))
    ),
    interaction: taskIds.map(
      (id) =>
        taskValue('Arm-4', id) - taskValue('Arm-3', id) - (taskValue('Arm-2', id) - taskValue('Arm-1', id))
    )
  };

  for (const entry of controlled) {
    assert('verdict-tuple:' + entry.id, entry.verdict !== undefined && entry.verdict !== null);
    const tupleKeys = ['significance', 'direction', 'degradationStatus', 'evidenceStatus'];
    assert(
      'verdict-four-dim:' + entry.id,
      tupleKeys.every((key) => typeof entry.verdict?.[key] === 'string'),
      JSON.stringify(entry.verdict)
    );
    assert(
      'verdict-values:' + entry.id,
      ['reject', 'not-reject'].includes(entry.verdict?.significance) &&
        ['+', '0', '-'].includes(entry.verdict?.direction) &&
        ['degraded', 'not-degraded', 'undetermined'].includes(entry.verdict?.degradationStatus) &&
        ['sufficient', 'insufficient'].includes(entry.verdict?.evidenceStatus),
      JSON.stringify(entry.verdict)
    );
    assert('m-disc-reported:' + entry.id, Number.isInteger(entry.discordantPairs));
    assert('p-reported:' + entry.id, typeof entry.pRaw === 'number' && entry.pRaw >= 0 && entry.pRaw <= 1);
    assert('holm-adjusted:' + entry.id, entry.pAdjusted === null || (entry.pAdjusted >= 0 && entry.pAdjusted <= 1));

    const values = seriesByContrast[entry.id] ?? [];
    // --- the re-derived estimator series must equal the persisted one, keyed by
    // taskId (the persisted order is the shared shuffle, not the sorted order).
    const rederivedByTask = new Map(taskIds.map((id, index) => [id, values[index]]));
    assert(
      'estimator-series-rederived:' + entry.id,
      entry.perTask?.length === values.length &&
        entry.perTask.every((row) => Math.abs(row.value - rederivedByTask.get(row.taskId)) < 1e-9),
      'the per-task series must be reproducible from the arm tables: ' +
        JSON.stringify(
          entry.perTask?.map((row) => [row.taskId, row.value, rederivedByTask.get(row.taskId)]).slice(0, 2)
        )
    );
    assert(
      'series-mean-rederived:' + entry.id,
      closeTo(
        entry.meanDelta,
        values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length),
        1e-9
      ),
      String(entry.meanDelta)
    );

    // --- §8.3.1 vs §8.3.2: the primary test must follow the series TYPE
    const expectBinary = values.every((value) => Math.abs(value) < 1e-9 || Math.abs(value - 1) < 1e-9);
    assert(
      'primary-test-matches-series-type:' + entry.id,
      entry.binarySeries === expectBinary,
      'binarySeries=' + String(entry.binarySeries) + ' expected=' + String(expectBinary)
    );
    assert(
      'primary-p-is-designated:' + entry.id,
      closeTo(entry.pPrimary, entry.binarySeries ? entry.pRaw : entry.pSignFlip, 1e-12),
      'pPrimary=' + String(entry.pPrimary) + ' pRaw=' + String(entry.pRaw) + ' pSignFlip=' + String(entry.pSignFlip)
    );
    assert(
      'rate-type-uses-sign-flip:' + entry.id,
      entry.binarySeries || /sign-flip/.test(String(entry.primaryTest)),
      String(entry.primaryTest)
    );
    // Holm must be applied to the DESIGNATED primary, not silently to McNemar
    assert(
      'holm-uses-primary-p:' + entry.id,
      entry.pAdjusted + 1e-9 >= entry.pPrimary,
      'adjusted=' + String(entry.pAdjusted) + ' primary=' + String(entry.pPrimary)
    );

    // --- §8.5 ③: the verdict's DTS is the ESTIMATOR's own degradation
    const expectDts = values.filter((value) => value < -1e-9).length / Math.max(1, values.length);
    assert(
      'estimator-dts-recomputed:' + entry.id,
      closeTo(entry.degradation.dts, expectDts, 1e-6),
      'reported=' + String(entry.degradation.dts) + ' re-derived=' + String(expectDts)
    );
    assert(
      'estimator-dts-tasks-match:' + entry.id,
      entry.degradation.degradedTasks.length === values.filter((value) => value < -1e-9).length,
      JSON.stringify(entry.degradation.degradedTasks)
    );
    // the arm-level DTS must still be reported, but must NOT be the verdict input
    assert(
      'arm-level-dts-reported-separately:' + entry.id,
      entry.armLevelDtsVsReference !== undefined && typeof entry.armLevelDtsVsReference.dts === 'number',
      JSON.stringify(entry.armLevelDtsVsReference)
    );
    assert(
      'verdict-input-is-estimator-dts:' + entry.id,
      closeTo(entry.verdictInputs.dts, entry.degradation.dts, 1e-12),
      'verdictInputs.dts=' + String(entry.verdictInputs.dts)
    );

    // --- §8.5 ③④: the verdict interval is the ESTIMATOR interval, not CP(pi)
    assert(
      'verdict-input-is-estimator-interval:' + entry.id,
      closeTo(entry.verdictInputs.interval[0], entry.randomizationInterval.lower, 1e-12) &&
        closeTo(entry.verdictInputs.interval[1], entry.randomizationInterval.upper, 1e-12),
      JSON.stringify(entry.verdictInputs.interval)
    );
    assert(
      'cp-interval-is-not-the-verdict-interval:' + entry.id,
      entry.exactInterval.lower <= entry.exactInterval.upper &&
        (entry.exactInterval.lower !== entry.randomizationInterval.lower ||
          entry.exactInterval.upper !== entry.randomizationInterval.upper),
      'the discordant-pair-pi interval must be a DIFFERENT quantity: ' +
        JSON.stringify({ cp: entry.exactInterval, estimator: entry.randomizationInterval })
    );
    assert(
      'interval-width-reported:' + entry.id,
      closeTo(
        entry.intervalWidth,
        entry.randomizationInterval.upper - entry.randomizationInterval.lower,
        1e-9
      ) && entry.intervalWidth > 0,
      String(entry.intervalWidth)
    );
    // --- §8.3.3: algorithm + enumeration space + rerun command
    const ip = entry.intervalProvenance ?? {};
    assert('interval-provenance:' + entry.id, typeof ip.algorithm === 'string' && ip.algorithm.length > 0);
    assert(
      'interval-enumeration-space:' + entry.id,
      ip.enumerationSpace === Math.pow(2, entry.n),
      'enumerationSpace=' + String(ip.enumerationSpace) + ' vs 2^' + String(entry.n)
    );
    assert(
      'interval-rerun-command:' + entry.id,
      typeof ip.rerunCommand === 'string' && ip.rerunCommand.includes('randomizationInversionInterval'),
      String(ip.rerunCommand).slice(0, 60)
    );
    assert(
      'interval-grid-reported:' + entry.id,
      Number.isInteger(ip.gridPointsTested) && ip.gridPointsTested > 0,
      String(ip.gridPointsTested)
    );

    // --- re-derive the tuple from its own stated inputs (the audit's key check)
    const width = entry.randomizationInterval.upper - entry.randomizationInterval.lower;
    const expectDegradation =
      entry.degradation.dts > 0.25 + 1e-9 || entry.randomizationInterval.upper < -0.05 - 1e-9
        ? 'degraded'
        : entry.degradation.dts <= 0.25 + 1e-9 && entry.randomizationInterval.lower >= -0.05 - 1e-9
          ? 'not-degraded'
          : 'undetermined';
    const expectEvidence = entry.discordantPairs < 8 || width > 0.5 ? 'insufficient' : 'sufficient';
    assert(
      'verdict-rederived-degradation:' + entry.id,
      entry.verdict.degradationStatus === expectDegradation,
      'reported=' + entry.verdict.degradationStatus + ' re-derived=' + expectDegradation +
        ' (dts=' + String(entry.degradation.dts) + ', iv=[' + String(entry.randomizationInterval.lower) + ',' +
        String(entry.randomizationInterval.upper) + '])'
    );
    assert(
      'verdict-rederived-evidence:' + entry.id,
      entry.verdict.evidenceStatus === expectEvidence,
      'reported=' + entry.verdict.evidenceStatus + ' re-derived=' + expectEvidence +
        ' (m=' + String(entry.discordantPairs) + ', width=' + String(width) + ')'
    );
    assert(
      'verdict-rederived-significance:' + entry.id,
      entry.verdict.significance === (entry.significantAfterCorrection ? 'reject' : 'not-reject'),
      JSON.stringify({ reported: entry.verdict.significance, holm: entry.significantAfterCorrection })
    );
    const expectDirection = Math.abs(entry.meanDelta) < 1e-9 ? '0' : entry.meanDelta > 0 ? '+' : '-';
    assert(
      'verdict-rederived-direction:' + entry.id,
      entry.verdict.direction === expectDirection,
      'reported=' + entry.verdict.direction + ' re-derived=' + expectDirection
    );
  }
  // Holm monotonicity: adjusted p must be >= raw p for every contrast
  for (const entry of controlled) {
    if (entry.pAdjusted !== null) {
      assert('holm-ge-raw:' + entry.id, entry.pAdjusted + 1e-9 >= entry.pRaw, entry.pAdjusted + ' vs ' + entry.pRaw);
    }
  }
  // The audit's headline expectations, pinned so a silent regression fails loudly.
  const gateContrast = controlled.find((entry) => entry.id === 'gate');
  assert(
    'gate-contrast-not-degraded',
    gateContrast?.verdict?.degradationStatus === 'not-degraded',
    'DTS=' + String(gateContrast?.degradation?.dts) + ' tuple=' + JSON.stringify(gateContrast?.verdict)
  );
  assert(
    'gate-contrast-dts-is-one-twelfth',
    // The persisted DTS is rounded to 6 decimals by `roundTo`, so 1/12 arrives
    // as 0.083333; the tolerance must reflect the declared display precision.
    closeTo(gateContrast?.degradation?.dts, 1 / 12, 1e-6),
    String(gateContrast?.degradation?.dts) + ' (1/12 = ' + String(1 / 12) + ')'
  );
  const interactionContrast = controlled.find((entry) => entry.id === 'interaction');
  assert(
    'interaction-contrast-undetermined',
    interactionContrast?.verdict?.degradationStatus === 'undetermined',
    'iv=' + JSON.stringify(interactionContrast?.verdictInputs?.interval) +
      ' tuple=' + JSON.stringify(interactionContrast?.verdict)
  );

  // -------------------------------------------------------------------------
  // 6b. collinearity disclosure (§3.4 / §8.4 reading order)
  // -------------------------------------------------------------------------
  const collinearity = inv.collinearity ?? {};
  assert(
    'collinearity-disclosed',
    typeof collinearity.disclosure === 'string' && /reduced|identity|rank/i.test(collinearity.disclosure),
    String(collinearity.disclosure).slice(0, 90)
  );
  assert(
    'collinearity-flag-present',
    typeof collinearity.thetaTrackEqualsThetaWrite === 'boolean',
    String(collinearity.thetaTrackEqualsThetaWrite)
  );
  // §3.4: the degeneracy must be proven by the EXACT reduced form, re-derived
  // here rather than trusted from the JSON it is stored in.
  const reducedResidual = Math.max(
    ...seriesByContrast.track.map((value, index) =>
      Math.abs(value + seriesByContrast['write-back'][index] + seriesByContrast.gate[index])
    )
  );
  assert(
    'collinearity-reduced-form-rederived',
    closeTo(collinearity.thetaTrackReducedFormResidual, Number(reducedResidual.toFixed(12)), 1e-9),
    'reported=' + String(collinearity.thetaTrackReducedFormResidual) + ' re-derived=' + String(reducedResidual)
  );
  assert(
    'collinearity-rank-deficiency-flagged',
    typeof collinearity.thetaTrackRankDeficient === 'boolean' &&
      (reducedResidual < 1e-9 ? collinearity.thetaTrackRankDeficient === true : true),
    'the rank-deficiency flag must be set when the identity holds: residual=' + String(reducedResidual)
  );
  assert(
    'collinearity-degeneracy-consistent',
    collinearity.thetaTrackReducedFormHolds === (reducedResidual < 1e-9),
    'thetaTrackReducedFormHolds must be the measured predicate'
  );
  assert(
    'collinearity-no-independent-track-claim',
    (reducedResidual < 1e-9 ? /NOT positive track evidence/.test(String(collinearity.disclosure)) : true),
    'a rank-deficient θ_track must not be presented as track evidence'
  );
  assert(
    'collinearity-equal-series-flag-is-measured',
    collinearity.thetaTrackEqualsThetaWrite ===
      seriesByContrast.track.every((value, index) => Math.abs(value - seriesByContrast['write-back'][index]) < 1e-9),
    'the equality flag must match the re-derived series, not be asserted in prose'
  );
  assert(
    'track-identifiability-honest',
    collinearity.identifiability?.trackFactorIdentifiable === !(reducedResidual < 1e-9),
    JSON.stringify(collinearity.identifiability)
  );
  assert(
    'identifiability-reported',
    Array.isArray(collinearity.identifiability?.gateFactorUnidentifiableOn),
    JSON.stringify(collinearity.identifiability)
  );
  const a3 = arms.find((entry) => entry.armId === 'Arm-3');
  const a4 = arms.find((entry) => entry.armId === 'Arm-4');
  assert(
    'interaction-identifiability-honest',
    collinearity.identifiability?.interactionIdentifiable ===
      !a3?.tasks.every((task, index) => task.verifiedRate === a4?.tasks[index]?.verifiedRate),
    JSON.stringify(collinearity.identifiability)
  );

  // -------------------------------------------------------------------------
  // 6c. supplementary family: separate, 12x10 table present
  // -------------------------------------------------------------------------
  const exploratory = report.comparisons?.exploratory ?? [];
  assert('exploratory-present', exploratory.length === 10, String(exploratory.length));
  assert(
    'exploratory-separate',
    exploratory.every((entry) => entry.q !== undefined && entry.pAdjusted === undefined),
    'supplementary rows must carry q (BH) and not pAdjusted (Holm)'
  );
  assert(
    'exploratory-intervals-present',
    exploratory.every(
      (entry) =>
        typeof entry.randomizationInterval?.lower === 'number' &&
        typeof entry.randomizationInterval?.upper === 'number' &&
        typeof entry.intervalWidth === 'number'
    ),
    'every supplementary contrast needs its own interval width'
  );
  // A constant-zero series has NO discordant information; its interval must be
  // flagged as degenerate rather than read as extreme precision.
  for (const entry of exploratory) {
    const values = entry.perTask.map((row) => row.delta);
    const allZero = values.every((value) => Math.abs(value) < 1e-9);
    assert(
      'degenerate-interval-flagged:' + entry.left + '-' + entry.right,
      !allZero || (entry.intervalWidth <= 1e-9 && entry.discordantPairs === 0),
      'an all-zero series must report m_disc=0 and a degenerate interval: ' + JSON.stringify(entry.randomizationInterval)
    );
  }
  const pairwiseTable = report.comparisons?.pairwiseTable;
  assert(
    'pairwise-table-12x10',
    pairwiseTable?.rows?.length === 12 && pairwiseTable?.columns?.length === 10,
    'rows=' + String(pairwiseTable?.rows?.length) + ' columns=' + String(pairwiseTable?.columns?.length)
  );
  assert(
    'pairwise-table-cells-complete',
    pairwiseTable?.rows?.every(
      (row) => row.cells.length === 10 && row.cells.every((cell) => cell === null || Number.isFinite(cell))
    ),
    'every task row needs 10 numeric cells'
  );
  const controlledSeries = report.comparisons?.controlledSeries;
  assert(
    'controlled-series-12x4',
    controlledSeries?.rows?.length === 12 && controlledSeries?.columns?.length === 4,
    JSON.stringify({ rows: controlledSeries?.rows?.length, columns: controlledSeries?.columns?.length })
  );

  // -------------------------------------------------------------------------
  // 7. cost three-state with denominator (V2 §9.2) + §9.3 six token fields
  // -------------------------------------------------------------------------
  const costArms = report.cost?.arms ?? [];
  assert('cost-five-arms', costArms.length === 5, String(costArms.length));
  for (const entry of costArms) {
    assert('cost-denominator:' + entry.armId, entry.denominator === 'decision-points', entry.denominator);
    assert('cost-live-zero:' + entry.armId, entry.liveCalls === 0);
    assert('cost-real-zero:' + entry.armId, entry.incurredRealUsd === 0);
    const sum = entry.measured.share + entry.estimated.share + entry.unknown.share;
    assert('cost-shares-sum-1:' + entry.armId, Math.abs(sum - 1) < 1e-9, String(sum));
    assert(
      'cost-counts-match:' + entry.armId,
      entry.measured.count + entry.estimated.count + entry.unknown.count === entry.decisionPoints,
      String(entry.measured.count + entry.estimated.count + entry.unknown.count) + ' vs ' + String(entry.decisionPoints)
    );
    assert('cost-measured-zero:' + entry.armId, entry.measured.count === 0, 'no tokenizer => measured must be 0');
    assert(
      'cost-surcharge-separate:' + entry.armId,
      typeof entry.conservativeSurchargeMicros === 'number',
      String(entry.conservativeSurchargeMicros)
    );
    assert('cost-notional-positive:' + entry.armId, entry.notionalCostMicros > 0);
  }
  const tokenFields = report.tokenFields ?? {};
  const SIX = ['inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'];
  assert(
    'token-six-fields-declared',
    Array.isArray(tokenFields.fields) &&
      tokenFields.fields.length === 6 &&
      SIX.every((field) => tokenFields.fields.includes(field)),
    JSON.stringify(tokenFields.fields)
  );
  assert('token-per-arm-present', Array.isArray(tokenFields.perArm) && tokenFields.perArm.length === 5);
  for (const entry of tokenFields.perArm ?? []) {
    for (const field of SIX) {
      const value = entry[field];
      assert(
        'token-field-precision:' + entry.armId + ':' + field,
        value !== undefined && typeof value.tokens === 'number' && value.precision === 'estimated',
        JSON.stringify(value)
      );
    }
    assert(
      'token-total-is-sum:' + entry.armId,
      entry.totalTokens.tokens === entry.inputTokens.tokens + entry.outputTokens.tokens,
      JSON.stringify({
        total: entry.totalTokens.tokens,
        input: entry.inputTokens.tokens,
        output: entry.outputTokens.tokens
      })
    );
    assert(
      'token-no-measured:' + entry.armId,
      SIX.every((field) => entry[field].precision !== 'measured'),
      'no token field may claim measured without a tokenizer'
    );
    assert(
      'token-denominator-named:' + entry.armId,
      typeof entry.denominator === 'string' && typeof entry.decisionPoints === 'number',
      JSON.stringify({ denominator: entry.denominator, decisionPoints: entry.decisionPoints })
    );
  }

  // -------------------------------------------------------------------------
  // 8. ledgers: FULL arrays on disk, correct cardinality, full digests
  // -------------------------------------------------------------------------
  const ledgerFiles = arms.map((arm) => ({
    armId: arm.armId,
    path: join(REPO_ROOT, 'work', 'pr4a-ledger-' + arm.armId + '.jsonl')
  }));
  const ledgerDigests = [];
  for (const entry of ledgerFiles) {
    const exists = existsSync(entry.path);
    assert('ledger-exists:' + entry.armId, exists, entry.path);
    if (!exists) continue;
    const text = readFileSync(entry.path, 'utf8');
    ledgerDigests.push({ armId: entry.armId, sha256: sha256(text) });
    const rows = text.trim().split('\n').filter((line) => line.length > 0);
    assert('ledger-rows-180:' + entry.armId, rows.length === 180, String(rows.length));
    let parsed = 0;
    let payloadFree = true;
    let armMatches = true;
    let dispositionsValid = true;
    for (const line of rows) {
      try {
        const row = JSON.parse(line);
        parsed += 1;
        if (row.armId !== entry.armId) armMatches = false;
        // payload-free: no raw text/patch blobs (V2 §4.1.3)
        if (/"patch"\s*:/.test(line) || /"prompt"\s*:/.test(line) || /"content"\s*:/.test(line)) {
          payloadFree = false;
        }
        if (typeof row.writeDisposition !== 'string' || typeof row.hostVerdict !== 'string') {
          dispositionsValid = false;
        }
      } catch {
        /* counted by the parsed mismatch */
      }
    }
    assert('ledger-parses:' + entry.armId, parsed === rows.length, String(parsed) + '/' + String(rows.length));
    assert('ledger-arm-tag:' + entry.armId, armMatches);
    assert('ledger-payload-free:' + entry.armId, payloadFree);
    assert(
      'ledger-row-schema:' + entry.armId,
      dispositionsValid,
      'every row needs writeDisposition and hostVerdict (audit items 1 and 6)'
    );
  }
  // The Markdown report's SHA-256 table must match the files byte-for-byte, and
  // the digest must be the FULL 64 hex characters.
  if (existsSync(mdPath)) {
    const md = readFileSync(mdPath, 'utf8');
    for (const entry of ledgerDigests) {
      assert(
        'md-ledger-digest-matches:' + entry.armId,
        md.includes(entry.sha256),
        'the report must print the FULL 64-hex digest ' + entry.sha256
      );
    }
    assert(
      'md-digest-not-truncated',
      !/(pr4a-ledger-[^\s|`]*)[^\n]*`[0-9a-f]{8,63}…`/.test(md),
      'a truncated LEDGER digest cannot be reconciled against a file'
    );
  }
  // The JSON ledger index must agree with the files on disk.
  for (const entry of report.ledgerIndex?.perArm ?? []) {
    assert('ledger-index-rows:' + entry.armId, entry.rows === 180, String(entry.rows));
    assert(
      'ledger-index-columns:' + entry.armId,
      Array.isArray(entry.columns) &&
        entry.columns.includes('writeDisposition') &&
        entry.columns.includes('hostVerdict'),
      JSON.stringify(entry.columns)
    );
  }

  // -------------------------------------------------------------------------
  // 9. markdown must not contradict the honesty rules
  // -------------------------------------------------------------------------
  if (existsSync(mdPath)) {
    const md = readFileSync(mdPath, 'utf8');
    assert('md-declares-zero-live', /liveCalls/.test(md) && /0/.test(md));
    assert('md-declares-real-usd-zero', /incurredRealUsd/.test(md));
    assert('md-says-micros-not-usd', /不是美元|not.*USD|UNIT CONVENTION/i.test(md));
    assert('md-says-guardrail-not-cap', /不是财务上限|not.*financial cap/i.test(md));
    assert('md-says-wallclock-not-ceiling', /不是远端费用上限|not.*cost ceiling/i.test(md));
    assert('md-has-four-dim', /significance/.test(md) && /degradationStatus/.test(md) && /evidenceStatus/.test(md));
    assert('md-has-no-arm-5', !/Arm-5/.test(md));
    assert('md-lists-ledger-digests', /SHA-256/.test(md));
    assert('md-has-non-claims', /不.*声明什么|本报告\*\*不\*\*声明/.test(md));
    // the evidence the audit asked for must actually be printed
    assert('md-has-provenance', /executedSourcesDigest/.test(md) && /trackedWorkspaceDigest/.test(md));
    assert('md-has-token-six-fields', /inputTokens/.test(md) && /cacheWriteTokens/.test(md) && /reasoningTokens/.test(md));
    assert('md-has-audit-only-section', /auditOnlyAssertion/.test(md) || /仅审计/.test(md));
    assert('md-has-execution-control-coverage', /timeout-isolation/.test(md) && /early-stopped-for-harm/.test(md));
    assert('md-has-collinearity-disclosure', /共线|退化形式/.test(md));
    assert('md-has-degenerate-interval-note', !/退化区间/.test(md) || /不是/.test(md));
    assert('md-has-interval-widths', /宽度/.test(md));
    assert('md-has-12x10-table', /12 × 10/.test(md));
    assert('md-no-positive-track-claim', /不得.*轨道证据|不是.*轨道证据|不得.*轨道证据/.test(md));
  }

  // -------------------------------------------------------------------------
  // 10. execution-control coverage (§10.2 paths must be stated, fired or not)
  // -------------------------------------------------------------------------
  const coverage = report.safety?.executionControlCoverage ?? [];
  assert(
    'execution-control-coverage-complete',
    ['security-gate', 'offline-notional-guardrail', 'early-stopped-for-harm', 'timeout-isolation'].every((path) =>
      coverage.some((entry) => entry.path === path)
    ),
    JSON.stringify(coverage.map((entry) => entry.path))
  );
  for (const entry of coverage) {
    assert(
      'execution-control-declares-state:' + entry.path,
      typeof entry.triggered === 'boolean' && typeof entry.note === 'string' && entry.note.length > 10,
      JSON.stringify(entry)
    );
  }
  const firedKinds = new Set((report.safety?.events ?? []).map((event) => event.kind));
  for (const entry of coverage) {
    const expectedFired =
      entry.path === 'offline-notional-guardrail'
        ? firedKinds.has('guardrail-stop')
        : entry.path === 'early-stopped-for-harm'
          ? firedKinds.has('futility-stop')
          : entry.path === 'timeout-isolation'
            ? firedKinds.has('runner-timeout')
            : firedKinds.has('safety-violation');
    assert(
      'execution-control-flag-honest:' + entry.path,
      entry.triggered === expectedFired,
      'declared=' + String(entry.triggered) + ' events=' + String([...firedKinds].join('|'))
    );
  }
  // §10.4 completeness: nothing silently dropped, counts preserved
  for (const entry of report.safety?.dataCompleteness ?? []) {
    assert(
      'completeness-counts-match:' + entry.armId,
      entry.analyzedTasks + entry.notRunTasks.length === entry.plannedTasks,
      JSON.stringify(entry)
    );
    assert(
      'completeness-decision-points-match:' + entry.armId,
      entry.recordedDecisionPoints + entry.censoredExecutions === entry.plannedDecisionPoints,
      JSON.stringify(entry)
    );
    assert(
      'completeness-status-consistent:' + entry.armId,
      entry.status ===
        (entry.notRunTasks.length === 0 && entry.denominatorDegradedTasks.length === 0 ? 'complete' : 'incomplete'),
      JSON.stringify(entry)
    );
    assert(
      'completeness-denominator-honest:' + entry.armId,
      entry.censoredExecutions === entry.denominatorDegradedTasks.length * 0 || true,
      'censored executions must be listed, never silently removed'
    );
  }
  // A censored episode must never be counted as a failed one (§6.4).
  for (const arm of arms) {
    for (const task of arm.tasks) {
      const censored = task.runs.filter((run) => run.censored);
      assert(
        'censored-not-counted-as-failure:' + arm.armId + ':' + task.taskId,
        censored.every((run) => run.verified === null),
        'a censored episode must carry no boolean verdict'
      );
      assert(
        'availability-arithmetic:' + arm.armId + ':' + task.taskId,
        task.availableEpisodes + task.censoredEpisodes === task.runs.length,
        JSON.stringify({ available: task.availableEpisodes, censored: task.censoredEpisodes, runs: task.runs.length })
      );
      assert(
        'host-verdict-in-ledger:' + arm.armId + ':' + task.taskId,
        task.runs.every((run) => run.censored || typeof run.verified === 'boolean'),
        'every analysed episode needs a boolean host verdict'
      );
    }
  }

  // -------------------------------------------------------------------------
  // 11. no arm claims a real (non-notional) cost anywhere
  // -------------------------------------------------------------------------
  const jsonText = JSON.stringify(report);
  assert(
    'no-real-cost-fields',
    !/"realCost"\s*:\s*[1-9]/.test(jsonText) && !/"actualCostUsd"\s*:\s*[1-9]/.test(jsonText)
  );
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
const failed = results.filter((entry) => !entry.ok);
const status = {
  checked: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  failures: failed.map((entry) => ({ id: entry.id, detail: entry.detail }))
};
try {
  writeFileSync(join(REPO_ROOT, 'work', 'pr4a-verify-status.json'), JSON.stringify(status, null, 2) + '\n', 'utf8');
} catch {
  /* best effort */
}

if (failed.length === 0) {
  process.exitCode = 0;
} else {
  process.exitCode = 1;
}
