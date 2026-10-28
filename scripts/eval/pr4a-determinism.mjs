#!/usr/bin/env node
/**
 * Determinism check (V2 §4.1.4).
 *
 * The protocol requires that a second execution with the same seed produces
 * BYTE-identical metrics and ledgers. The generatedAt / localWallClockMs fields
 * are wall-clock observations and are excluded by construction - they are not
 * measurements of the experiment.
 *
 * Runs the experiment twice IN THIS PROCESS and compares:
 *   - every arm's metric block (JSON, with wall-clock fields removed)
 *   - every ledger row sequence
 *   - the snapshot digests
 *
 * exit 0 = deterministic; exit 1 = not deterministic.
 */

import { loadPr4aReport } from './pr4a-build.mjs';

const lib = await loadPr4aReport();

function stripTiming(value) {
  if (Array.isArray(value)) return value.map(stripTiming);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      if (key === 'localWallClockMs' || key === 'generatedAt') continue;
      out[key] = stripTiming(inner);
    }
    return out;
  }
  return value;
}

const first = await lib.runPr4aExperiment({ codeBaseline: 'determinism-probe' });
const second = await lib.runPr4aExperiment({ codeBaseline: 'determinism-probe' });

const problems = [];

// 1. metric blocks byte-identical
const a = JSON.stringify(stripTiming(first.report));
const b = JSON.stringify(stripTiming(second.report));
if (a !== b) {
  problems.push('metric blocks differ between two runs (lengths ' + String(a.length) + ' vs ' + String(b.length) + ')');
}

// 2. ledgers byte-identical, per arm
for (const [armId, rows] of first.ledgers) {
  const other = second.ledgers.get(armId);
  if (other === undefined) {
    problems.push('ledger missing on second run for ' + armId);
    continue;
  }
  const left = rows.map((row) => JSON.stringify(row)).join('\n');
  const right = other.map((row) => JSON.stringify(row)).join('\n');
  if (left !== right) problems.push('ledger differs for ' + armId);
}

// 3. snapshot digests stable
for (let i = 0; i < first.report.arms.length; i += 1) {
  const left = first.report.arms[i];
  const right = second.report.arms[i];
  if (left.initialSnapshotDigest !== right.initialSnapshotDigest) {
    problems.push('initial snapshot digest differs for ' + left.armId);
  }
  if (left.finalSnapshotDigest !== right.finalSnapshotDigest) {
    problems.push('final snapshot digest differs for ' + left.armId);
  }
}

if (problems.length === 0) {
  console.log('[determinism] SUCCESS: two runs are byte-identical (timing excluded)');
  process.exitCode = 0;
} else {
  console.error('[determinism] FAIL: ' + String(problems.length) + ' difference(s)');
  for (const problem of problems) console.error('  - ' + problem);
  process.exitCode = 1;
}