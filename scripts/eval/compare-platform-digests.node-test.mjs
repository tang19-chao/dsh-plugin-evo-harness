/**
 * PR-1 cross-OS parity rule: independent `node:test` suite.
 *
 * WHY A SECOND SUITE (and why `*.node-test.mjs`)
 * ----------------------------------------------
 * `tests/unit/p62/evidence-gates.test.ts` already pins the parity rule through
 * Vitest. This file is deliberately NOT collected by Vitest (the `node-test`
 * suffix keeps it out of the `**\/*.{test,spec}.*` glob), so it can be run with
 * plain `node --test` on a machine with no dev dependencies installed - which is
 * the same property that makes the evidence scripts auditable by a third party.
 * It adds the checks that were MISSING before the rev4 P0 repair:
 *
 *   - the platform set is CLOSED: unknown names, case variants, other OS
 *     versions, a fourth record and a duplicate OS record are failures;
 *   - `--expect-commit` turns "the three platforms agree" into "the three
 *     platforms agree on the revision I mean", which is the only way to catch a
 *     stale artifact directory (three consistent records of the WRONG commit);
 *   - the CLI (not just the exported function) exits non-zero and says why.
 *
 * Offline: local filesystem only, no git, no network.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PARITY_PLATFORMS, comparePlatformDigests } from './compare-platform-digests.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, 'compare-platform-digests.mjs');

const COMPOSITE = 'c'.repeat(64);
const BINDING = 'd'.repeat(64);
const COMMIT = 'a'.repeat(40);

/** Temp directories created here, removed in `after`. */
const tempDirs = [];

after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A leftover temp dir must not turn a green suite red.
    }
  }
});

/** A throw-away directory. */
function tempDir(prefix = 'pr1-parity-node-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * Write one `attestation.json` per entry of `records`.
 *
 * The key is the DIRECTORY name (so a test can build `attestation-ubuntu-latest`,
 * `ubuntu-latest`, `foo`, a case variant, ...), the value overrides record fields.
 */
function makeParityDir(records) {
  const dir = tempDir();
  for (const [directoryName, record] of Object.entries(records)) {
    const target = path.join(dir, directoryName);
    fs.mkdirSync(target, { recursive: true });
    if (record === null) {
      // A directory with no record at all (not evidence about a platform).
      continue;
    }
    fs.writeFileSync(
      path.join(target, 'attestation.json'),
      JSON.stringify(
        {
          schemaVersion: '2.1.0',
          kind: 'commit-attestation',
          commit: { commitId: COMMIT, treeId: 'b'.repeat(40) },
          fileCount: 206,
          compositeSha256: COMPOSITE,
          bindingSha256: BINDING,
          ...record
        },
        null,
        2
      ),
      'utf8'
    );
  }
  return dir;
}

/** The three CI artifact directories, agreeing on `commit`. */
function threePlatforms(commit = COMMIT) {
  return {
    'attestation-ubuntu-latest': { commit: { commitId: commit, treeId: 'b'.repeat(40) } },
    'attestation-macos-latest': { commit: { commitId: commit, treeId: 'b'.repeat(40) } },
    'attestation-windows-latest': { commit: { commitId: commit, treeId: 'b'.repeat(40) } }
  };
}

/** Run the CLI, returning status + streams instead of throwing. */
function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error;
    return {
      status: typeof failure.status === 'number' ? failure.status : -1,
      stdout: String(failure.stdout ?? ''),
      stderr: String(failure.stderr ?? '')
    };
  }
}

describe('parity: the platform set is a CLOSED three-OS set', () => {
  it('exports exactly the three target OS names, frozen', () => {
    assert.deepEqual(
      PARITY_PLATFORMS.map((platform) => platform.os),
      ['ubuntu-latest', 'macos-latest', 'windows-latest']
    );
    assert.equal(Object.isFrozen(PARITY_PLATFORMS), true);
    for (const platform of PARITY_PLATFORMS) {
      assert.equal(Object.isFrozen(platform), true);
    }
  });

  it('accepts the CI artifact layout (attestation-<os>) when all three agree', () => {
    const result = comparePlatformDigests(makeParityDir(threePlatforms()));
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.rows.length, 3);
    assert.equal(result.uniqueComposites, 1);
    assert.equal(result.uniqueBindings, 1);
    assert.deepEqual(result.platformSet, ['macos-latest', 'ubuntu-latest', 'windows-latest']);
    assert.deepEqual(result.missingPlatforms, []);
    assert.deepEqual(result.unknownDirectories, []);
  });

  it('accepts the bare OS names (a hand-assembled directory)', () => {
    const dir = makeParityDir({
      'ubuntu-latest': {},
      'macos-latest': {},
      'windows-latest': {}
    });
    const result = comparePlatformDigests(dir);
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.rows.length, 3);
  });

  it('REJECTS mixing the two naming conventions in one comparison', () => {
    // Both conventions are accepted, but a comparison must pick ONE. If the rule
    // silently preferred one, the other record would be ignored while the claim
    // still said "three platforms".
    const dir = makeParityDir({
      'attestation-ubuntu-latest': {},
      'macos-latest': {},
      'attestation-windows-latest': {}
    });
    const result = comparePlatformDigests(dir);
    assert.equal(result.ok, false);
    assert.match(result.reason, /mixed-naming-convention/);
  });

  it('REJECTS an unrecognised directory even when the three real records agree', () => {
    // Pre-repair, `foo`/`bar`/`baz` were happily compared: the rule never asked
    // WHICH platforms it was looking at, so any three agreeing files passed.
    const dir = makeParityDir({ foo: {}, bar: {}, baz: {} });
    const result = comparePlatformDigests(dir);
    assert.equal(result.ok, false);
    assert.match(result.reason, /unknown-platform-directory/);
    assert.deepEqual(result.unknownDirectories.sort(), ['bar', 'baz', 'foo']);
    assert.equal(result.rows.length, 0);
  });

  it('REJECTS a case variant of a real OS name', () => {
    const records = threePlatforms();
    delete records['attestation-ubuntu-latest'];
    records['attestation-Ubuntu-latest'] = {};
    const result = comparePlatformDigests(makeParityDir(records));
    assert.equal(result.ok, false);
    assert.match(result.reason, /unknown-platform-directory/);
    assert.match(result.reason, /attestation-Ubuntu-latest/);
  });

  it('REJECTS another OS version of a real platform (ubuntu-22.04 is not the claim)', () => {
    const records = threePlatforms();
    delete records['attestation-ubuntu-latest'];
    records['attestation-ubuntu-22.04'] = {};
    const result = comparePlatformDigests(makeParityDir(records));
    assert.equal(result.ok, false);
    assert.match(result.reason, /unknown-platform-directory/);
  });

  it('REJECTS a fourth record: it would silently widen a three-OS claim', () => {
    const records = { ...threePlatforms(), 'attestation-freebsd-latest': {} };
    const result = comparePlatformDigests(makeParityDir(records));
    assert.equal(result.ok, false);
    assert.match(result.reason, /unknown-platform-directory/);
    assert.match(result.reason, /freebsd/);
  });

  it('REJECTS a second record for an OS already seen', () => {
    // Two ubuntu records (CI artifact + a hand-made one) is not "more evidence":
    // the rule would have to pick one, and picking silently is the bug.
    const dir = makeParityDir({
      'attestation-ubuntu-latest': {},
      'ubuntu-latest': {},
      'attestation-macos-latest': {},
      'attestation-windows-latest': {}
    });
    const result = comparePlatformDigests(dir);
    assert.equal(result.ok, false);
    assert.match(result.reason, /duplicate-platform/);
    assert.equal(result.duplicatePlatforms.length, 1);
  });

  it('FAILS (with the missing names) when only two platforms are present', () => {
    const dir = makeParityDir({
      'attestation-ubuntu-latest': {},
      'attestation-macos-latest': {}
    });
    const result = comparePlatformDigests(dir);
    assert.equal(result.ok, false);
    assert.match(result.reason, /at least 3 platform attestations/);
    assert.match(result.reason, /missing: windows-latest/);
  });

  it('REJECTS a minPlatforms that would weaken the fixed set', () => {
    const dir = makeParityDir({
      'attestation-ubuntu-latest': {},
      'attestation-macos-latest': {}
    });
    const result = comparePlatformDigests(dir, { minPlatforms: 2 });
    assert.equal(result.ok, false);
    assert.match(result.reason, /platform-set-fixed/);
  });

  it('ignores subdirectories that carry no record', () => {
    const records = { ...threePlatforms(), junk: null };
    const result = comparePlatformDigests(makeParityDir(records));
    assert.equal(result.ok, true, result.reason);
  });

  it('fails with a diagnosable reason when the directory does not exist', () => {
    const result = comparePlatformDigests(path.join(tempDir(), 'does-not-exist'));
    assert.equal(result.ok, false);
    assert.match(result.reason, /unreadable-directory/);
  });
});

describe('parity: --expect-commit checks the TARGET revision', () => {
  it('passes when every record names the expected commit', () => {
    const dir = makeParityDir(threePlatforms());
    const result = comparePlatformDigests(dir, { expectCommit: COMMIT });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.expectedCommitId, COMMIT);
  });

  it('FAILS when three consistent records name a DIFFERENT commit (the stale-artifact case)', () => {
    // This is the defect: agreement alone cannot tell "the intended revision" from
    // "the same wrong revision on all three platforms". Every equality check
    // passes; only the target check can catch it.
    const wrong = 'e'.repeat(40);
    const dir = makeParityDir(threePlatforms(wrong));
    const agreementOnly = comparePlatformDigests(dir);
    assert.equal(agreementOnly.ok, true, 'fixture sanity: agreement alone passes');

    const result = comparePlatformDigests(dir, { expectCommit: COMMIT });
    assert.equal(result.ok, false);
    assert.match(result.reason, /target commit mismatch/);
    assert.match(result.reason, new RegExp(COMMIT));
    assert.match(result.reason, new RegExp(wrong));
    assert.equal(result.expectedCommitId, COMMIT);
  });

  it('FAILS when only one of the three names the expected commit', () => {
    const records = threePlatforms();
    records['attestation-windows-latest'] = { commit: { commitId: 'f'.repeat(40), treeId: 'b'.repeat(40) } };
    const result = comparePlatformDigests(makeParityDir(records), { expectCommit: COMMIT });
    assert.equal(result.ok, false);
    assert.match(result.reason, /target commit mismatch/);
    assert.match(result.reason, /attestation-windows-latest/);
  });

  it('REJECTS a non-40-hex target instead of comparing it', () => {
    const dir = makeParityDir(threePlatforms());
    for (const bad of ['HEAD', 'abc123', COMMIT.toUpperCase(), '']) {
      const result = comparePlatformDigests(dir, { expectCommit: bad });
      assert.equal(result.ok, false, `expectCommit=${JSON.stringify(bad)} must be rejected`);
      assert.match(result.reason, /expect-commit-invalid/);
    }
  });

  it('keeps the historical "agreement only" behaviour when no target is given', () => {
    // Backwards compatibility is deliberate: `pnpm run attest:verify` and the
    // Vitest parity suite rely on it. The help text says what it does not cover.
    const result = comparePlatformDigests(makeParityDir(threePlatforms('1'.repeat(40))));
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.expectedCommitId, undefined);
  });
});

describe('parity: attributable-record checks still fail closed', () => {
  it('FAILS on a differing composite', () => {
    const records = threePlatforms();
    records['attestation-windows-latest'] = { compositeSha256: 'e'.repeat(64) };
    const result = comparePlatformDigests(makeParityDir(records));
    assert.equal(result.ok, false);
    assert.match(result.reason, /composite digests differ/);
  });

  it('FAILS on a differing binding', () => {
    const records = threePlatforms();
    records['attestation-windows-latest'] = { bindingSha256: 'e'.repeat(64) };
    const result = comparePlatformDigests(makeParityDir(records));
    assert.equal(result.ok, false);
    assert.match(result.reason, /binding digests differ/);
  });

  it('FAILS on a malformed digest rather than comparing it', () => {
    const records = threePlatforms();
    records['attestation-windows-latest'] = { compositeSha256: 'zz-not-a-digest' };
    const result = comparePlatformDigests(makeParityDir(records));
    assert.equal(result.ok, false);
    assert.match(result.reason, /has no valid compositeSha256/);
  });

  it('FAILS on fileCount=0 (an empty manifest proves nothing)', () => {
    const records = threePlatforms();
    records['attestation-windows-latest'] = { fileCount: 0 };
    const result = comparePlatformDigests(makeParityDir(records));
    assert.equal(result.ok, false);
    assert.match(result.reason, /fileCount=0/);
  });

  it('FAILS on differing file counts even when the digests match', () => {
    const records = threePlatforms();
    records['attestation-macos-latest'] = { fileCount: 205 };
    const result = comparePlatformDigests(makeParityDir(records));
    assert.equal(result.ok, false);
    assert.match(result.reason, /file counts differ/);
  });

  it('FAILS on a malformed commit id', () => {
    const records = threePlatforms();
    records['attestation-windows-latest'] = { commit: { commitId: 'abc', treeId: 'b'.repeat(40) } };
    const result = comparePlatformDigests(makeParityDir(records));
    assert.equal(result.ok, false);
    assert.match(result.reason, /no valid commit id/);
  });
});

describe('parity: CLI contract', () => {
  it('exits 0 and prints the target when --expect-commit matches', () => {
    const dir = makeParityDir(threePlatforms());
    const result = runCli([dir, '--expect-commit', COMMIT, '--json']);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.expectedCommitId, COMMIT);
  });

  it('exits 1 and names both commits when --expect-commit does not match', () => {
    const dir = makeParityDir(threePlatforms('e'.repeat(40)));
    const result = runCli([dir, '--expect-commit', COMMIT]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /target commit mismatch/);
    assert.match(result.stderr, new RegExp(COMMIT));
    assert.match(result.stderr, new RegExp('e'.repeat(40)));
  });

  it('exits 1 for an unknown platform directory', () => {
    const result = runCli([makeParityDir({ foo: {}, bar: {}, baz: {} })]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown-platform-directory/);
  });

  it('exits 1 for a malformed --expect-commit', () => {
    const dir = makeParityDir(threePlatforms());
    for (const bad of ['HEAD', 'abc123']) {
      const result = runCli([dir, '--expect-commit', bad]);
      assert.equal(result.status, 1, `--expect-commit ${bad} must fail`);
      assert.match(result.stderr, /expect-commit-invalid/);
    }
  });

  it('exits 1 on an unknown flag instead of silently ignoring it', () => {
    // A misspelled `--expect-commit` that is ignored would disable the target
    // check while looking like it ran - the exact defect being repaired.
    const result = runCli([makeParityDir(threePlatforms()), '--expect-commmit', COMMIT]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown-argument/);
  });

  it('exits 1 when a value-taking flag has no value', () => {
    // Fail-open to avoid: a trailing `--expect-commit` used to leave the option
    // undefined, so the run silently downgraded to "no target check".
    const dir = makeParityDir(threePlatforms());
    for (const args of [[dir, '--expect-commit'], ['--expect-commit']]) {
      const result = runCli(args);
      assert.equal(result.status, 1, `${JSON.stringify(args)} must fail`);
      assert.match(result.stderr, /expect-commit-invalid/);
    }
  });

  it('exits 1 with usage when no directory is given', () => {
    const result = runCli([]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /usage/);
  });

  it('--help documents the closed set, the target check and what parity does NOT prove', () => {
    const result = runCli(['--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /--expect-commit/);
    assert.match(result.stdout, /ubuntu-latest/);
    assert.match(result.stdout, /macos-latest/);
    assert.match(result.stdout, /windows-latest/);
    // The two honest limitations must be in the help, not only in a comment.
    assert.match(result.stdout, /WRONG revision/);
    assert.match(result.stdout, /final-attestation\.mjs --verify/);
  });
});
