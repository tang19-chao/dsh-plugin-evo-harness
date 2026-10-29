#!/usr/bin/env node
/**
 * P2-B follow-up (t2 review): the PR-4A five-arm smoke INVARIANT, as a runnable
 * entry point instead of a sentence in a report.
 *
 * Why this exists. The P2-B changes touch src/jitrl/decision-kernel.ts and
 * src/jitrl/index.ts. Both edits are additive (new exports, one default-OFF
 * option), so the frozen V2 five-arm engine must produce the SAME numbers after
 * the change. That claim was verified once by capturing the smoke output before
 * and after the edit and comparing it line by line (wall-clock timing removed).
 * A one-off comparison in a chat message is not evidence a reviewer can re-run,
 * so this script turns it into a command:
 *
 *   node scripts/eval/pr4a-smoke-invariant.mjs
 *     -> runs scripts/eval/pr4a-smoke.mjs in a child process, strips the
 *        per-line wall-clock suffix, hashes the normalized text and compares it
 *        with the digest PINNED below.
 *
 *   node scripts/eval/pr4a-smoke-invariant.mjs --baseline work/p2-kernel-smoke-before.txt
 *     -> the historical pair comparison: current run vs a captured earlier run,
 *        printing both normalized digests and the exact line-difference count.
 *
 * WHAT IS PINNED: the numbered OUTPUT of the five arms (verifiedRate, mean
 * coverage, record counts, track labels, gate applied/kept counts, trusted
 * receipts, footprint digests, ledger length, notional micros) - never wall-clock
 * time, never a generated timestamp. The normalization removes only the trailing
 * "<n>ms" field, so a real behaviour change cannot hide behind it.
 *
 * This is a DIAGNOSTIC entry point. It reads the existing CI gate
 * (scripts/eval/pr4a-smoke.mjs) and changes no gate semantics; a mismatch means
 * "the frozen frame moved and the historical five-arm numbers must be
 * re-attributed", which is exactly the release condition of the known-gap ratchet
 * in tests/unit/jitrl/production-replay-survival.test.ts.
 *
 * Offline only: the five-arm engine is a deterministic fixture (liveCalls=0,
 * incurredRealUsd=0); this script issues no model call and no network request.
 *
 * Exit codes: 0 = the normalized output matches the pinned/expected digest;
 *             1 = it does not (or the diff is non-empty); 2 = the smoke could
 *             not be captured (child failed / unreadable baseline).
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');
const SMOKE_ENTRY = join(HERE, 'pr4a-smoke.mjs');

/**
 * The normalized digest of the five-arm smoke at the P1 baseline (feb8465) AND
 * after the P2-B additive change: the two runs were byte-identical once timing
 * was removed, which is the whole point of this pin.
 */
export const PINNED_SMOKE_DIGEST =
  '0654a6cbc0eb41dec9e2658b10bfab826f11f974a724e36620c14da83402d423';

/**
 * Normalize a captured smoke output: drop the trailing "<n>ms" wall clock from
 * every line, trim trailing whitespace, drop trailing blank lines and unify line
 * endings. Nothing else is touched: every number that describes the experiment
 * stays in the compared text.
 */
export function normalizeSmokeOutput(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+\d+ms\s*$/, '').replace(/\s+$/, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.join('\n');
}

/** SHA-256 (hex) of the normalized smoke text. */
export function smokeDigest(text) {
  return createHash('sha256').update(normalizeSmokeOutput(text), 'utf8').digest('hex');
}

/** Lines present on exactly one side, after normalization. */
export function smokeLineDiff(leftText, rightText) {
  const left = normalizeSmokeOutput(leftText).split('\n');
  const right = normalizeSmokeOutput(rightText).split('\n');
  const remaining = new Map();
  for (const line of left) {
    remaining.set(line, (remaining.get(line) ?? 0) + 1);
  }
  const onlyRight = [];
  for (const line of right) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) {
      remaining.set(line, count - 1);
    } else {
      onlyRight.push(line);
    }
  }
  const onlyLeft = [];
  for (const [line, count] of remaining) {
    for (let index = 0; index < count; index += 1) {
      onlyLeft.push(line);
    }
  }
  return { onlyLeft, onlyRight, count: onlyLeft.length + onlyRight.length };
}

/** Run the smoke CLI once and return its stdout. */
export function captureSmoke() {
  const result = spawnSync(process.execPath, [SMOKE_ENTRY], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  });
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').slice(0, 2000);
    throw new Error(
      'pr4a smoke exited with status ' + String(result.status) + (detail.length === 0 ? '' : ': ' + detail)
    );
  }
  return result.stdout ?? '';
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /pr4a-smoke-invariant\.mjs$/.test(process.argv[1].replace(/\\/g, '/'));

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const captureArg = argv.find((arg) => arg.startsWith('--capture='));
  const baselineArg = argv.find((arg) => arg.startsWith('--baseline='));

  try {
    const captured = captureSmoke();
    if (captureArg !== undefined) {
      writeFileSync(captureArg.slice('--capture='.length), captured, 'utf8');
    }
    const currentDigest = smokeDigest(captured);

    const payload = {
      probe: 'pr4a-smoke-invariant',
      pinnedDigest: PINNED_SMOKE_DIGEST,
      currentDigest,
      normalization: 'strip trailing "<n>ms" per line, trim trailing whitespace, drop trailing blank lines, LF join',
      mode: baselineArg === undefined ? 'pinned' : 'paired-baseline'
    };

    let ok = true;
    let diff = null;
    if (baselineArg !== undefined) {
      const baselinePath = baselineArg.slice('--baseline='.length);
      const baselineText = readFileSync(baselinePath, 'utf8');
      diff = smokeLineDiff(baselineText, captured);
      payload.baseline = {
        path: baselinePath,
        digest: smokeDigest(baselineText)
      };
      payload.lineDiff = diff.count;
      ok = diff.count === 0 && payload.baseline.digest === currentDigest;
    } else {
      ok = currentDigest === PINNED_SMOKE_DIGEST;
    }
    payload.ok = ok;

    if (json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log('[smoke-invariant] normalization: ' + payload.normalization);
      console.log('[smoke-invariant] pinned digest:   sha256:' + PINNED_SMOKE_DIGEST);
      console.log('[smoke-invariant] current digest:  sha256:' + currentDigest);
      if (baselineArg !== undefined) {
        console.log('[smoke-invariant] baseline digest: sha256:' + payload.baseline.digest + '  (' + payload.baseline.path + ')');
        console.log('[smoke-invariant] line differences: ' + String(diff?.count ?? 0) + ' (timing removed)');
        if ((diff?.onlyLeft.length ?? 0) > 0) {
          console.log('  only in baseline:');
          for (const line of (diff?.onlyLeft ?? []).slice(0, 10)) console.log('    - ' + line);
        }
        if ((diff?.onlyRight.length ?? 0) > 0) {
          console.log('  only in current run:');
          for (const line of (diff?.onlyRight ?? []).slice(0, 10)) console.log('    + ' + line);
        }
      }
      console.log(
        '[smoke-invariant] ' +
          (ok
            ? 'PASS: the frozen five-arm frame is unchanged (timing excluded)'
            : 'FAIL: the frozen five-arm frame MOVED - re-attribute the historical five-arm numbers (see the known-gap ratchet)')
      );
    }
    if (!ok) process.exitCode = 1;
  } catch (error) {
    console.error('[smoke-invariant] cannot capture the smoke: ' + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 2;
  }
}
