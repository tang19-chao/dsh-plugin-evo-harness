#!/usr/bin/env node
/**
 * Cross-OS fingerprint parity (PR-1).
 *
 * WHY THIS EXISTS
 * ---------------
 * PR-1 hashes the git OBJECT DATABASE instead of the working tree, so the same
 * commit must produce the same digest on Windows, Linux and macOS. That claim is
 * only evidence if something MEASURES it on every supported platform and FAILS
 * on a difference - otherwise it is a hope with a comment attached.
 *
 * CI therefore runs `final-attestation.mjs` on ubuntu/macos/windows and uploads
 * one record per platform; this script compares them. Keeping the rule in a
 * shipped, importable module (rather than an inline `bash` block in the YAML)
 * means it can be tested BOTH ways - identical digests pass, one differing
 * digest fails, fewer than three platforms fails - which is exactly what
 * `tests/unit/p62/evidence-gates.test.ts` does.
 *
 * WHAT "PARITY" REQUIRES (deliberately strict)
 * --------------------------------------------
 *   - at least THREE platform records. Two matching digests do not support the
 *     "same on Windows, Linux and macOS" claim; the matrix is three-way for a
 *     reason, so a missing leg is a failure, not a smaller sample.
 *   - every record is attributable: a full 40-hex commit id, a positive integer
 *     file count, and SHA-256 composite/binding digests that are exactly 64
 *     lowercase hex characters. An empty or malformed digest cannot be compared
 *     meaningfully (the old check treated '' as a value).
 *   - one composite, one binding, one file count and one commit id across all
 *     platforms.
 *
 * Note what parity does NOT prove: it compares a FRESHLY COMPUTED manifest on
 * each OS. It does not prove that the attestation recorded in the repository
 * still matches its commit - that is `final-attestation.mjs --verify`
 * (`pnpm run attest:verify` in CI), which runs on one platform and checks the
 * recorded artifact against the object database.
 *
 * USAGE
 *   node scripts/eval/compare-platform-digests.mjs <dir> [--json]
 *
 *   <dir> contains one subdirectory per platform, each holding `attestation.json`
 *   (this is the layout actions/download-artifact produces with
 *   `pattern: attestation-*`).
 *
 * EXIT CODES
 *   0  at least three attributable platforms, one identical composite, binding,
 *      file count and commit
 *   1  a digest/count/commit differs, a record is malformed, or fewer than three
 *      platforms were supplied
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

const SHA256_HEX = /^[0-9a-f]{64}$/;
const COMMIT_HEX = /^[0-9a-f]{40}$/;

/**
 * @typedef {object} PlatformRow
 * @property {string} platform  subdirectory name (e.g. `attestation-ubuntu-latest`)
 * @property {string} compositeSha256
 * @property {string} bindingSha256
 * @property {number} fileCount
 * @property {string} [commitId]
 */

/**
 * Compare per-platform attestations.
 *
 * @param {string} dir directory containing one `<platform>/attestation.json` per
 *   platform (the artifact directory layout produced by CI)
 * @param {{minPlatforms?: number}} [options]
 * @returns {{ok: boolean, reason?: string, rows: PlatformRow[], uniqueComposites: number, uniqueBindings: number}}
 */
export function comparePlatformDigests(dir, options = {}) {
  const minPlatforms = options.minPlatforms ?? 3;
  const absolute = path.resolve(dir);
  /** @type {PlatformRow[]} */
  const rows = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(absolute, entry.name, 'attestation.json');
    if (!fs.existsSync(candidate)) {
      continue;
    }
    const record = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    rows.push({
      platform: entry.name,
      compositeSha256: String(record?.compositeSha256 ?? ''),
      bindingSha256: String(record?.bindingSha256 ?? ''),
      fileCount: Number(record?.fileCount ?? 0),
      commitId: typeof record?.commit?.commitId === 'string' ? record.commit.commitId : undefined
    });
  }
  rows.sort((left, right) => (left.platform < right.platform ? -1 : left.platform > right.platform ? 1 : 0));
  const uniqueComposites = new Set(rows.map((row) => row.compositeSha256)).size;
  const uniqueBindings = new Set(rows.map((row) => row.bindingSha256)).size;

  if (rows.length < minPlatforms) {
    return {
      ok: false,
      reason: `expected at least ${minPlatforms} platform attestations, found ${rows.length}`,
      rows,
      uniqueComposites,
      uniqueBindings
    };
  }

  // Shape first: comparing empty or truncated digests would make two records
  // "equal" for the wrong reason (the pre-repair code treated '' as a value).
  for (const row of rows) {
    if (!SHA256_HEX.test(row.compositeSha256)) {
      return {
        ok: false,
        reason: `${row.platform} has no valid compositeSha256 (expected 64 lowercase hex characters, got ${JSON.stringify(row.compositeSha256)})`,
        rows,
        uniqueComposites,
        uniqueBindings
      };
    }
    if (!SHA256_HEX.test(row.bindingSha256)) {
      return {
        ok: false,
        reason:
          `${row.platform} has no valid bindingSha256 (expected 64 lowercase hex characters, got ${JSON.stringify(row.bindingSha256)}); ` +
          'a schema < 2.1.0 record must be regenerated with the PR-1 tooling',
        rows,
        uniqueComposites,
        uniqueBindings
      };
    }
    if (!Number.isInteger(row.fileCount) || row.fileCount <= 0) {
      return {
        ok: false,
        reason: `${row.platform} reports fileCount=${String(row.fileCount)}; a positive integer is required (an empty manifest proves nothing)`,
        rows,
        uniqueComposites,
        uniqueBindings
      };
    }
    if (typeof row.commitId !== 'string' || !COMMIT_HEX.test(row.commitId)) {
      return {
        ok: false,
        reason: `${row.platform} has no valid commit id (expected 40 lowercase hex characters, got ${JSON.stringify(row.commitId)})`,
        rows,
        uniqueComposites,
        uniqueBindings
      };
    }
  }

  if (uniqueComposites !== 1) {
    return { ok: false, reason: 'composite digests differ across operating systems', rows, uniqueComposites, uniqueBindings };
  }
  if (uniqueBindings !== 1) {
    return { ok: false, reason: 'binding digests differ across operating systems', rows, uniqueComposites, uniqueBindings };
  }
  const uniqueFileCounts = new Set(rows.map((row) => row.fileCount));
  if (uniqueFileCounts.size !== 1) {
    return { ok: false, reason: 'file counts differ across operating systems', rows, uniqueComposites, uniqueBindings };
  }
  const commitIds = new Set(rows.map((row) => row.commitId ?? ''));
  if (commitIds.size !== 1) {
    return {
      ok: false,
      reason: 'the platforms attested DIFFERENT commits (check out the same SHA everywhere)',
      rows,
      uniqueComposites,
      uniqueBindings
    };
  }
  return { ok: true, rows, uniqueComposites, uniqueBindings };
}

const isDirectExecution =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectExecution) {
  const wantsJson = process.argv.includes('--json');
  const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const target = positional[0];
  if (target === undefined) {
    console.error('[parity] usage: node scripts/eval/compare-platform-digests.mjs <dir> [--json]');
    process.exit(1);
  }
  try {
    const result = comparePlatformDigests(target, { minPlatforms: 3 });
    if (wantsJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`[parity] platforms: ${result.rows.length}`);
      for (const row of result.rows) {
        console.log(
          `  ${row.platform}: commit ${row.commitId ?? '?'} ${row.fileCount} files ` +
            `composite ${row.compositeSha256} binding ${row.bindingSha256}`
        );
      }
      if (result.ok) {
        console.log('[parity] SUCCESS: one commit, one composite, one binding and one file count across every platform');
      } else {
        console.error(`[parity] FAIL: ${result.reason}`);
      }
    }
    if (!result.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`[parity] unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}