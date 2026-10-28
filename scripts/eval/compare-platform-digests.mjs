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
 * digest fails, fewer than three platforms fails - which is what
 * `tests/unit/p62/evidence-gates.test.ts` and
 * `scripts/eval/compare-platform-digests.node-test.mjs` do.
 *
 * WHAT "PARITY" REQUIRES (deliberately strict)
 * --------------------------------------------
 *   - EXACTLY ONE record per target OS and no other records. The accepted
 *     directory names are a CLOSED set:
 *       attestation-ubuntu-latest / attestation-macos-latest / attestation-windows-latest
 *     (the artifact names CI produces) or the same three OS names without the
 *     `attestation-` prefix (a hand-assembled directory) - ONE convention for a
 *     given comparison, never a mixture of the two. `foo`, `bar`,
 *     `Ubuntu-Latest` (case), `ubuntu-22.04`, `freebsd`, a fourth record, a
 *     SECOND record for an OS already seen, or two conventions in one directory
 *     are failures, not extra data: an unrecognised name means the comparison no
 *     longer knows what it is comparing, and a fourth record would silently widen
 *     a three-OS claim. Two matching digests do not support the "same on
 *     Windows, Linux and macOS" claim; the matrix is three-way for a reason, so
 *     a missing leg is a failure, not a smaller sample.
 *   - every record is attributable: a full 40-hex commit id, a positive integer
 *     file count, and SHA-256 composite/binding digests that are exactly 64
 *     lowercase hex characters. An empty or malformed digest cannot be compared
 *     meaningfully (the old check treated '' as a value).
 *   - one composite, one binding, one file count and one commit id across all
 *     platforms.
 *   - OPTIONAL, AND THE POINT OF `--expect-commit <40-hex>`: when given, every
 *     record must ALSO name that commit. Agreement alone cannot distinguish
 *     "the three platforms attested the intended revision" from "the three
 *     platforms consistently attested the WRONG one" - the second case is what
 *     a stale artifact directory produces, and it passes every equality check.
 *     CI knows the pushed SHA; passing it here is what turns the target
 *     revision from an assumption into a checked fact.
 *
 * WHAT PARITY DOES NOT PROVE (say it out loud)
 * --------------------------------------------
 *   - it compares FRESHLY COMPUTED manifests on each OS. It does not prove that
 *     the attestation recorded in the repository
 *     (`docs/reports/final-attestation.json`) still matches its commit - that is
 *     `final-attestation.mjs --verify` (`pnpm run attest:verify` in CI), which
 *     runs on one platform and checks the recorded artifact against the object
 *     database.
 *   - without `--expect-commit` it cannot rule out three records that agree on
 *     the same wrong revision.
 *   - a record is generated FROM a commit, so no record can describe the commit
 *     that contains it (see `final-attestation.mjs --help`).
 *
 * USAGE
 *   node scripts/eval/compare-platform-digests.mjs <dir> [--expect-commit <40-hex>] [--json]
 *   node scripts/eval/compare-platform-digests.mjs --help
 *
 *   <dir> contains one subdirectory per platform, each holding `attestation.json`
 *   (this is the layout actions/download-artifact produces with
 *   `pattern: attestation-*`).
 *
 * EXIT CODES
 *   0  exactly the three target platforms, one identical composite, binding,
 *      file count and commit (and that commit equals `--expect-commit` when given)
 *   1  a digest/count/commit differs, the record set is not the closed three-OS
 *      set, a record is malformed, the target commit is missing/mismatched, or an
 *      argument is invalid/unknown
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);

const SHA256_HEX = /^[0-9a-f]{64}$/;
const COMMIT_HEX = /^[0-9a-f]{40}$/;

/**
 * The closed set: one record per entry, and nothing else. Exported so a caller
 * (CI wiring, a test, a reviewer's probe) can name the same set the rule uses
 * instead of re-typing it and drifting.
 */
export const PARITY_PLATFORMS = Object.freeze([
  Object.freeze({ os: 'ubuntu-latest', artifactDirectory: 'attestation-ubuntu-latest' }),
  Object.freeze({ os: 'macos-latest', artifactDirectory: 'attestation-macos-latest' }),
  Object.freeze({ os: 'windows-latest', artifactDirectory: 'attestation-windows-latest' })
]);

/**
 * Accepted directory name -> canonical OS.
 *
 * Two naming conventions are accepted, and a comparison must use exactly ONE of
 * them: the artifact names CI produces (`attestation-<os>`) or the bare OS names
 * a human assembling a directory by hand tends to use. Both conventions are
 * CLOSED (any other name is an error) and mixing them is an error too - if the
 * rule silently preferred one convention, the other record would be ignored and
 * the comparison would no longer cover the platforms it claims to.
 */
const OS_BY_DIRECTORY_NAME = new Map();
for (const platform of PARITY_PLATFORMS) {
  OS_BY_DIRECTORY_NAME.set(platform.artifactDirectory, platform.os);
  OS_BY_DIRECTORY_NAME.set(platform.os, platform.os);
}

/** Which convention a directory name belongs to (`'artifact'` or `'bare-os'`). */
function namingConvention(directoryName) {
  return directoryName.startsWith('attestation-') ? 'artifact' : 'bare-os';
}

/** Ordinal (code-unit) comparison - locale-independent, so it is stable in CI. */
function ordinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * @typedef {object} PlatformRow
 * @property {string} platform  subdirectory name (e.g. `attestation-ubuntu-latest`)
 * @property {string} os        canonical OS (e.g. `ubuntu-latest`)
 * @property {string} compositeSha256
 * @property {string} bindingSha256
 * @property {number} fileCount
 * @property {string} [commitId]
 */

/**
 * Compare per-platform attestations.
 *
 * `minPlatforms` is retained for call-site compatibility, but it can no longer
 * WEAKEN the claim: the three-OS set is fixed, so any value other than 3 is
 * rejected instead of quietly accepting a smaller sample.
 *
 * @param {string} dir directory containing one `<platform>/attestation.json` per
 *   platform (the artifact directory layout produced by CI)
 * @param {{minPlatforms?: number, expectCommit?: string}} [options] `expectCommit`
 *   is a full 40-hex commit id that EVERY record must name
 * @returns {{ok: boolean, reason?: string, rows: PlatformRow[], uniqueComposites: number, uniqueBindings: number, expectedCommitId?: string, platformSet: string[], missingPlatforms: string[], duplicatePlatforms: string[], unknownDirectories: string[]}}
 */
export function comparePlatformDigests(dir, options = {}) {
  /** @type {PlatformRow[]} */
  const rows = [];
  /** @type {string[]} */
  const unknownDirectories = [];
  /** @type {string[]} */
  const duplicatePlatforms = [];
  /** @type {Map<string, string[]>} convention -> directory names seen */
  const conventions = new Map();
  const expectedCommitId = options.expectCommit;

  const uniqueComposites = () => new Set(rows.map((row) => row.compositeSha256)).size;
  const uniqueBindings = () => new Set(rows.map((row) => row.bindingSha256)).size;
  const snapshot = (reason) => {
    const platformSet = rows.map((row) => row.os).sort(ordinal);
    const present = new Set(platformSet);
    return {
      ...(reason === undefined ? {} : { reason }),
      ok: reason === undefined,
      rows,
      uniqueComposites: uniqueComposites(),
      uniqueBindings: uniqueBindings(),
      ...(expectedCommitId === undefined ? {} : { expectedCommitId }),
      platformSet,
      missingPlatforms: PARITY_PLATFORMS.map((platform) => platform.os).filter((os) => !present.has(os)),
      duplicatePlatforms,
      unknownDirectories
    };
  };

  // Arguments first: an incoherent request must not be answered by whichever
  // directory error happens to be found first.
  const requestedMinPlatforms = options.minPlatforms;
  if (requestedMinPlatforms !== undefined && requestedMinPlatforms !== PARITY_PLATFORMS.length) {
    return snapshot(
      `platform-set-fixed: the cross-OS claim is exactly one record for each of ` +
        `${PARITY_PLATFORMS.map((platform) => platform.os).join(', ')}; ` +
        `minPlatforms=${String(requestedMinPlatforms)} cannot be honoured`
    );
  }
  if (expectedCommitId !== undefined && (typeof expectedCommitId !== 'string' || !COMMIT_HEX.test(expectedCommitId))) {
    return snapshot(
      `expect-commit-invalid: --expect-commit must be a full 40-hex commit id, got ${JSON.stringify(expectedCommitId)}`
    );
  }

  const absolute = path.resolve(dir);
  let entries;
  try {
    entries = fs.readdirSync(absolute, { withFileTypes: true });
  } catch (error) {
    return snapshot(
      `unreadable-directory: ${absolute} (${error instanceof Error ? error.message : String(error)})`
    );
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(absolute, entry.name, 'attestation.json');
    if (!fs.existsSync(candidate)) {
      // A directory without a record is not evidence about a platform. (The
      // CI artifact layout can carry sibling files; only records are counted.)
      continue;
    }
    const os = OS_BY_DIRECTORY_NAME.get(entry.name);
    if (os === undefined) {
      unknownDirectories.push(entry.name);
      continue;
    }
    const existing = rows.find((row) => row.os === os);
    if (existing !== undefined) {
      duplicatePlatforms.push(`${entry.name} (second record for ${os}; first was ${existing.platform})`);
      continue;
    }
    let record;
    try {
      record = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    } catch (error) {
      return snapshot(
        `record-unparseable: ${entry.name}/attestation.json is not valid JSON ` +
          `(${error instanceof Error ? error.message : String(error)})`
      );
    }
    rows.push({
      platform: entry.name,
      os,
      compositeSha256: String(record?.compositeSha256 ?? ''),
      bindingSha256: String(record?.bindingSha256 ?? ''),
      fileCount: Number(record?.fileCount ?? 0),
      commitId: typeof record?.commit?.commitId === 'string' ? record.commit.commitId : undefined
    });
    const convention = namingConvention(entry.name);
    conventions.set(convention, [...(conventions.get(convention) ?? []), entry.name]);
  }
  rows.sort((left, right) => ordinal(left.platform, right.platform));

  // Closed set first: what is being compared must be exactly the three-OS claim.
  if (unknownDirectories.length > 0) {
    return snapshot(
      `unknown-platform-directory: ${unknownDirectories.map((name) => `'${name}'`).join(', ')} is not part of the ` +
        `three-OS claim (accepted: ${[...OS_BY_DIRECTORY_NAME.keys()].join(', ')}); ` +
        'an unrecognised directory means this comparison no longer knows what it is comparing'
    );
  }
  if (duplicatePlatforms.length > 0) {
    return snapshot(
      `duplicate-platform: ${duplicatePlatforms.join('; ')}; exactly one record per OS is required`
    );
  }
  if (conventions.size > 1) {
    return snapshot(
      `mixed-naming-convention: ${[...conventions.entries()]
        .map(([convention, names]) => `${convention} (${names.join(', ')})`)
        .join(' vs ')}; use ONE convention (either attestation-<os> for every platform or the bare <os> names), ` +
        'otherwise the accepted set is ambiguous'
    );
  }
  const present = new Set(rows.map((row) => row.os));
  const missingPlatforms = PARITY_PLATFORMS.map((platform) => platform.os).filter((os) => !present.has(os));
  if (missingPlatforms.length > 0) {
    return snapshot(
      `expected at least ${PARITY_PLATFORMS.length} platform attestations (one for each of ` +
        `${PARITY_PLATFORMS.map((platform) => platform.os).join(', ')}), found ${rows.length} ` +
        `(missing: ${missingPlatforms.join(', ')})`
    );
  }

  // Shape next: comparing empty or truncated digests would make two records
  // "equal" for the wrong reason (the pre-repair code treated '' as a value).
  for (const row of rows) {
    if (!SHA256_HEX.test(row.compositeSha256)) {
      return snapshot(
        `${row.platform} has no valid compositeSha256 (expected 64 lowercase hex characters, got ${JSON.stringify(row.compositeSha256)})`
      );
    }
    if (!SHA256_HEX.test(row.bindingSha256)) {
      return snapshot(
        `${row.platform} has no valid bindingSha256 (expected 64 lowercase hex characters, got ${JSON.stringify(row.bindingSha256)}); ` +
          'a schema < 2.1.0 record must be regenerated with the PR-1 tooling'
      );
    }
    if (!Number.isInteger(row.fileCount) || row.fileCount <= 0) {
      return snapshot(
        `${row.platform} reports fileCount=${String(row.fileCount)}; a positive integer is required (an empty manifest proves nothing)`
      );
    }
    if (typeof row.commitId !== 'string' || !COMMIT_HEX.test(row.commitId)) {
      return snapshot(
        `${row.platform} has no valid commit id (expected 40 lowercase hex characters, got ${JSON.stringify(row.commitId)})`
      );
    }
  }

  // The target check runs BEFORE the equality checks on purpose: when the
  // expected commit is known, "every record names it" is the stronger, more
  // specific statement, and a stale directory should be reported as a wrong
  // TARGET rather than as a difference among platforms.
  if (expectedCommitId !== undefined) {
    const offenders = rows.filter((row) => row.commitId !== expectedCommitId);
    if (offenders.length > 0) {
      return snapshot(
        `target commit mismatch: expected ${expectedCommitId}, but ` +
          `${offenders.map((row) => `${row.platform} attested ${row.commitId ?? '(none)'}`).join('; ')} ` +
          '(agreement across platforms does not prove the revision is the intended one)'
      );
    }
  }

  if (uniqueComposites() !== 1) {
    return snapshot('composite digests differ across operating systems');
  }
  if (uniqueBindings() !== 1) {
    return snapshot('binding digests differ across operating systems');
  }
  const uniqueFileCounts = new Set(rows.map((row) => row.fileCount));
  if (uniqueFileCounts.size !== 1) {
    return snapshot('file counts differ across operating systems');
  }
  const commitIds = new Set(rows.map((row) => row.commitId ?? ''));
  if (commitIds.size !== 1) {
    return snapshot('the platforms attested DIFFERENT commits (check out the same SHA everywhere)');
  }
  return snapshot(undefined);
}

/** Help text. Kept in one place so `--help` cannot drift from the header. */
function usageText() {
  return [
    'Cross-OS fingerprint parity (PR-1).',
    '',
    'USAGE',
    '  node scripts/eval/compare-platform-digests.mjs <dir> [--expect-commit <40-hex>] [--json]',
    '  node scripts/eval/compare-platform-digests.mjs --help',
    '',
    '  <dir> holds one subdirectory per platform, each containing attestation.json',
    '  (the actions/download-artifact layout with `pattern: attestation-*`).',
    '',
    'REQUIRED PLATFORM SET (closed)',
    '  Exactly one record for each of ubuntu-latest, macos-latest, windows-latest,',
    '  named EITHER `attestation-<os>` (CI artifacts) OR `<os>` (hand-assembled) -',
    '  one convention per comparison, never a mixture. Unknown directories, case',
    '  variants, other OS versions and a second record for an OS already seen are',
    '  failures; so is a fourth record.',
    '',
    'TARGET COMMIT',
    '  --expect-commit <40-hex>  every record must name this commit, else exit 1.',
    '  Without it, parity only proves the three records AGREE - it cannot rule out',
    '  three records that agree on the same WRONG revision. Pass the pushed SHA.',
    '',
    'WHAT THIS DOES NOT PROVE',
    '  Parity does not prove the commit matches the attestation committed in the',
    '  repository (docs/reports/final-attestation.json); that is',
    '  `final-attestation.mjs --verify <file> --expect-commit <sha>`.',
    '',
    'EXIT CODES',
    '  0  the three target platforms agree on one commit, composite, binding and file',
    '     count (and that commit equals --expect-commit when given)',
    '  1  a difference, a non-three-OS record set, a malformed record, a target',
    '     mismatch, or an invalid/unknown argument'
  ].join('\n');
}

/**
 * Parse CLI arguments. Unknown flags are ERRORS: silently ignoring a
 * misspelled `--expect-commit` would disable the target check while looking
 * like it ran - the exact defect class this script is being hardened against.
 *
 * A flag whose VALUE is missing is an error too, not "the flag was absent":
 * `--expect-commit` at the end of argv must fail loudly rather than quietly
 * downgrade the run to "no target check".
 *
 * @param {readonly string[]} argv
 * @returns {{options: {dir?: string, json: boolean, expectCommit?: string}, unknown: string[], missingValue: string[]}}
 */
function parseCliArgs(argv) {
  /** @type {{dir?: string, json: boolean, expectCommit?: string}} */
  const options = { json: false };
  /** @type {string[]} */
  const unknown = [];
  /** @type {string[]} */
  const missingValue = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--expect-commit') {
      const value = argv[++index];
      if (value === undefined) {
        missingValue.push(arg);
      } else {
        options.expectCommit = value;
      }
    } else if (arg.startsWith('--expect-commit=')) {
      options.expectCommit = arg.slice('--expect-commit='.length);
    } else if (arg.startsWith('-')) {
      unknown.push(arg);
    } else if (options.dir === undefined) {
      options.dir = arg;
    } else {
      // A second positional would silently be ignored today; make it visible.
      unknown.push(arg);
    }
  }
  return { options, unknown, missingValue };
}

const isDirectExecution =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectExecution) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usageText());
    process.exit(0);
  }
  const { options, unknown, missingValue } = parseCliArgs(argv);
  if (missingValue.length > 0) {
    console.error(`[parity] expect-commit-invalid: ${missingValue.join(', ')} requires a value (see --help)`);
    process.exit(1);
  }
  if (unknown.length > 0) {
    console.error(`[parity] unknown-argument: ${unknown.join(' ')} (see --help)`);
    process.exit(1);
  }
  if (options.dir === undefined) {
    console.error(
      '[parity] usage: node scripts/eval/compare-platform-digests.mjs <dir> [--expect-commit <40-hex>] [--json] (see --help)'
    );
    process.exit(1);
  }
  if (options.expectCommit !== undefined && !COMMIT_HEX.test(options.expectCommit)) {
    console.error(
      `[parity] expect-commit-invalid: --expect-commit must be a full 40-hex commit id, got ${JSON.stringify(options.expectCommit)}`
    );
    process.exit(1);
  }
  try {
    const result = comparePlatformDigests(options.dir, {
      minPlatforms: PARITY_PLATFORMS.length,
      ...(options.expectCommit === undefined ? {} : { expectCommit: options.expectCommit })
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`[parity] platforms: ${result.rows.length} (${result.platformSet.join(', ')})`);
      for (const row of result.rows) {
        console.log(
          `  ${row.platform}: commit ${row.commitId ?? '?'} ${row.fileCount} files ` +
            `composite ${row.compositeSha256} binding ${row.bindingSha256}`
        );
      }
      if (result.expectedCommitId !== undefined) {
        console.log(`[parity] expected commit: ${result.expectedCommitId}`);
      }
      if (result.ok) {
        console.log(
          '[parity] SUCCESS: one commit, one composite, one binding and one file count across every platform' +
            (result.expectedCommitId === undefined
              ? ' (no --expect-commit was given, so the revision itself was NOT checked)'
              : `, and every record names the expected commit ${result.expectedCommitId}`)
        );
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
