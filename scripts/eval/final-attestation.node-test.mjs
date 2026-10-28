/**
 * PR-1 commit attestation: TARGET checks and the self-reference boundary.
 * Independent `node:test` suite (`*.node-test.mjs`, so Vitest does not collect it).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `tests/unit/p62/commit-attestation.test.ts` and `evidence-gates.test.ts` pin the
 * manifest/digest rules and the `--verify` self-consistency path. They could not
 * catch the defect this suite targets, because the defect was not in the digests:
 *
 *   `--verify docs/reports/final-attestation.json` exits 0 while the recorded
 *   commit is an OLD one (84a3d82) and HEAD has moved on (0410d78). Every field
 *   matches, because the record is internally consistent - it is simply not
 *   about the revision anybody is asking about. Worse, `--ref` was silently
 *   IGNORED under `--verify`, so a caller who passed a target believed they had
 *   checked one.
 *
 * So this suite builds throw-away repositories and asserts, through BOTH the
 * exported functions and the CLI:
 *   - generation refuses a revision that is not the requested target;
 *   - `--verify --expect-commit <sha>` passes only for that commit and fails
 *     with a stable code naming BOTH ids otherwise;
 *   - `--strict` fails when HEAD is not the attested commit;
 *   - plain `--verify` still verifies a HISTORICAL record (the property
 *     `pnpm run attest:verify` depends on);
 *   - a target check never rewrites the record (no fabricated/backfilled SHA);
 *   - `--verify --ref` is refused rather than silently ignored;
 *   - the self-reference boundary is documented in `--help` and observable:
 *     a record cannot cover the commit that contains it.
 *
 * Offline: local git only (no network, no model), and every fixture lives in
 * `os.tmpdir()`, so the repository's own `docs/reports/final-attestation.json`
 * is never read or written.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyAttestation } from './final-attestation.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const CLI = path.join(__dirname, 'final-attestation.mjs');

/** Temp repositories created here, removed in `after`. */
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

/** A scrubbed git environment, so an ambient GIT_DIR cannot redirect evidence. */
function gitEnv() {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

/** Run git in `cwd`, returning trimmed stdout. */
function git(cwd, args) {
  return execFileSync('git', args.slice(), { cwd, encoding: 'utf8', env: gitEnv() }).trim();
}

/**
 * Build a throw-away repository with a `src/` tree (the roots the attestation
 * digests are `src`, `tests`, `scripts`). `core.autocrlf=false` keeps the
 * committed bytes exactly what the fixture writes, so a digest mismatch can only
 * come from the code under test.
 */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr1-attest-node-'));
  tempDirs.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'pr1@example.invalid']);
  git(dir, ['config', 'user.name', 'PR-1 fixture']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'src', 'b.ts'), 'export const b = 2;\n', 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'first']);
  return dir;
}

/** Commit one more file, moving HEAD forward, and return the new commit id. */
function addCommit(dir, name) {
  fs.writeFileSync(path.join(dir, 'src', name), `export const ${name.replace(/\W/g, '_')} = 3;\n`, 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', `add ${name}`]);
  return git(dir, ['rev-parse', 'HEAD']);
}

/** Generate an attestation into `<repo>/attestation.json` and return its path. */
function generate(repo, extraArgs = []) {
  const out = path.join(repo, 'attestation.json');
  const result = runCli(['--ref', 'HEAD', '--out', out, '--cwd', repo, ...extraArgs]);
  assert.equal(result.status, 0, `generation failed: ${result.stderr}${result.stdout}`);
  return out;
}

/** Run the CLI, returning status + streams instead of throwing. */
function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      status: typeof error.status === 'number' ? error.status : -1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? '')
    };
  }
}

/** Read a JSON record. */
function readRecord(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** sha256 of a file's bytes, used to prove a record was not rewritten. */
function fileSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

describe('attestation: generation refuses a revision that is not the target', () => {
  it('generates when --ref resolves to exactly --expect-commit', () => {
    const repo = makeRepo();
    const head = git(repo, ['rev-parse', 'HEAD']);
    const out = path.join(repo, 'attestation.json');
    const result = runCli(['--ref', 'HEAD', '--expect-commit', head, '--out', out, '--cwd', repo]);
    assert.equal(result.status, 0, result.stderr);
    const record = readRecord(out);
    assert.equal(record.commit.commitId, head);
    assert.match(result.stdout, /--expect-commit matched/);
  });

  it('REFUSES to generate for a different commit, and writes no record', () => {
    const repo = makeRepo();
    const head = git(repo, ['rev-parse', 'HEAD']);
    const wrong = '1'.repeat(40);
    assert.notEqual(wrong, head);
    const out = path.join(repo, 'attestation.json');
    const result = runCli(['--ref', 'HEAD', '--expect-commit', wrong, '--out', out, '--cwd', repo]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /attestation-target-mismatch/);
    assert.match(result.stderr, new RegExp(head));
    assert.match(result.stderr, new RegExp(wrong));
    // A valid record of the WRONG revision is worse than no record: nothing written.
    assert.equal(fs.existsSync(out), false, 'a target mismatch must not leave an attestation behind');
  });

  it('REFUSES a moving ref or an abbreviated SHA as the target', () => {
    const repo = makeRepo();
    const out = path.join(repo, 'attestation.json');
    for (const bad of ['HEAD', 'main', 'abc123', '']) {
      const result = runCli(['--ref', 'HEAD', '--expect-commit', bad, '--out', out, '--cwd', repo]);
      assert.equal(result.status, 1, `--expect-commit ${JSON.stringify(bad)} must be refused`);
      assert.match(result.stderr, /expect-commit-invalid/);
      assert.equal(fs.existsSync(out), false);
    }
  });
});

describe('attestation: --verify --expect-commit checks the TARGET revision', () => {
  it('passes when the record names the expected commit', () => {
    const repo = makeRepo();
    const head = git(repo, ['rev-parse', 'HEAD']);
    const out = generate(repo);
    const result = runCli(['--verify', out, '--expect-commit', head, '--cwd', repo]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--expect-commit matched/);
  });

  it('FAILS with both ids when the record names a different commit', () => {
    const repo = makeRepo();
    const out = generate(repo);
    const recorded = readRecord(out).commit.commitId;
    const newer = addCommit(repo, 'later.ts');
    assert.notEqual(newer, recorded);

    const result = runCli(['--verify', out, '--expect-commit', newer, '--cwd', repo]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /attestation-target-mismatch/);
    assert.match(result.stderr, new RegExp(recorded), 'must name the recorded commit');
    assert.match(result.stderr, new RegExp(newer), 'must name the expected commit');
    // The failure is a TARGET failure, not a content failure: the record is intact.
    // (The content path prints `MISMATCH <file>: N difference(s)`; the target path
    // prints `TARGET MISMATCH`, so asserting on "difference(s)" separates the axes.)
    assert.match(result.stderr, /TARGET MISMATCH/);
    assert.doesNotMatch(result.stderr, /difference\(s\)/, 'a target mismatch must not be reported as a content mismatch');
  });

  it('never rewrites the record when the target check fails (no fabricated SHA)', () => {
    const repo = makeRepo();
    const out = generate(repo);
    const before = fileSha256(out);
    const recorded = readRecord(out).commit.commitId;
    const newer = addCommit(repo, 'later.ts');
    const result = runCli(['--verify', out, '--expect-commit', newer, '--cwd', repo]);
    assert.equal(result.status, 1);
    assert.equal(fileSha256(out), before, 'verification must not modify the record');
    assert.equal(readRecord(out).commit.commitId, recorded);
  });

  it('still reports CONTENT mismatches on their own axis', () => {
    const repo = makeRepo();
    const out = generate(repo);
    const record = readRecord(out);
    record.compositeSha256 = '0'.repeat(64);
    fs.writeFileSync(out, JSON.stringify(record, null, 2) + '\n', 'utf8');

    const result = runCli(['--verify', out, '--expect-commit', record.commit.commitId, '--cwd', repo]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /MISMATCH/);
    assert.match(result.stderr, /compositeSha256/);
  });

  it('REFUSES a value-taking flag with no value instead of dropping it silently', () => {
    // Fail-open to avoid: `--expect-commit` as the last argv entry used to leave
    // the option undefined, so the target check silently did not run.
    for (const args of [
      ['--verify', 'some.json', '--expect-commit'],
      ['--verify', 'some.json', '--cwd'],
      ['--ref', 'HEAD', '--expect-commit'],
      ['--verify']
    ]) {
      const result = runCli(args);
      assert.equal(result.status, 1, `${JSON.stringify(args)} must fail`);
      assert.match(result.stderr, /argument-value-missing|verify-missing/, `args=${JSON.stringify(args)}`);
    }
  });

  it('exposes the two axes separately in-process', () => {
    const repo = makeRepo();
    const out = generate(repo);
    const recorded = readRecord(out).commit.commitId;
    const result = verifyAttestation(out, { cwd: repo });
    assert.equal(result.ok, true);
    assert.equal(result.contentOk, true);
    assert.deepEqual(result.differences, []);
    assert.deepEqual(result.targetMismatches, []);
    assert.equal(result.targetChecks.expectCommit, null);
    assert.equal(result.targetChecks.strict, null);

    const wrongTarget = verifyAttestation(out, { cwd: repo, expectCommit: '2'.repeat(40) });
    assert.equal(wrongTarget.contentOk, true, 'the record itself is still consistent');
    assert.equal(wrongTarget.ok, false, 'but it is not evidence about the requested target');
    assert.equal(wrongTarget.targetMismatches.length, 1);
    assert.equal(wrongTarget.targetMismatches[0].code, 'attestation-target-mismatch');
    assert.deepEqual(wrongTarget.targetChecks.expectCommit, {
      expected: '2'.repeat(40),
      actual: recorded,
      ok: false
    });
  });
});

describe('attestation: --strict requires the record to describe the checked-out HEAD', () => {
  it('passes when HEAD is the attested commit', () => {
    const repo = makeRepo();
    const head = git(repo, ['rev-parse', 'HEAD']);
    const out = generate(repo);
    const result = runCli(['--verify', out, '--strict', '--cwd', repo]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /strict:/);
    assert.match(result.stdout, new RegExp(head));
  });

  it('FAILS when HEAD has moved past the attested commit', () => {
    const repo = makeRepo();
    const out = generate(repo);
    const recorded = readRecord(out).commit.commitId;
    const newer = addCommit(repo, 'later.ts');
    const result = runCli(['--verify', out, '--strict', '--cwd', repo]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /attestation-head-mismatch/);
    assert.match(result.stderr, new RegExp(recorded));
    assert.match(result.stderr, new RegExp(newer));
    assert.match(result.stderr, /NOT attested/);
  });

  it('refuses --strict while generating (it is a verification check)', () => {
    const repo = makeRepo();
    const out = path.join(repo, 'attestation.json');
    const result = runCli(['--ref', 'HEAD', '--out', out, '--strict', '--cwd', repo]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /strict-requires-verify/);
    assert.equal(fs.existsSync(out), false);
  });
});

describe('attestation: plain --verify keeps verifying historical records', () => {
  it('exits 0 for a record whose commit is behind HEAD, and SAYS what it did not check', () => {
    // This is the property `pnpm run attest:verify` relies on: an old record must
    // stay re-checkable after `main` advances. The honesty requirement is that the
    // output states HEAD is not covered, instead of implying it is.
    const repo = makeRepo();
    const out = generate(repo);
    const recorded = readRecord(out).commit.commitId;
    const newer = addCommit(repo, 'later.ts');
    const result = runCli(['--verify', out, '--cwd', repo]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /OK/);
    assert.match(result.stdout, new RegExp(recorded));
    assert.match(result.stdout, /does NOT cover the checked-out revision/);
    assert.match(result.stdout, new RegExp(newer));
  });

  it('keeps verifying a record whose branch ref has moved (re-checked against its own commit id)', () => {
    const repo = makeRepo();
    const out = generate(repo);
    addCommit(repo, 'later.ts');
    const result = verifyAttestation(out, { cwd: repo });
    assert.equal(result.ok, true);
    assert.equal(result.contentOk, true);
    assert.ok(
      result.notes.some((note) => note.includes('the branch moved')),
      `expected a branch-moved note, got ${JSON.stringify(result.notes)}`
    );
  });

  it('REFUSES --verify combined with --ref instead of silently ignoring the ref', () => {
    // Pre-repair, `--verify x --ref HEAD` exited 0 having checked the RECORDED
    // commit - a target check that checked nothing.
    const repo = makeRepo();
    const out = generate(repo);
    const result = runCli(['--verify', out, '--ref', 'HEAD', '--cwd', repo]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /verify-ref-conflict/);
    assert.match(result.stderr, /--expect-commit/);
  });
});

describe('attestation: the self-reference boundary is documented and observable', () => {
  it('--help states that a record cannot cover the commit containing it', () => {
    const result = runCli(['--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /SELF-REFERENCE BOUNDARY/);
    assert.match(result.stdout, /does NOT cover the commit that contains it|commit that contains it is not covered/);
    assert.match(result.stdout, /never means "HEAD is attested"/);
    // The three target mechanisms must be documented, not just implemented.
    assert.match(result.stdout, /--expect-commit/);
    assert.match(result.stdout, /--strict/);
    // And the no-fabrication promise.
    assert.match(result.stdout, /never fabricated, backfilled or rewritten/);
  });

  it('the generated record names its own commit, not HEAD-at-commit-time-of-the-next-commit', () => {
    // Concretely: generate for commit 1, commit the record (as a file) in commit
    // 2, and show that commit 2 is NOT covered - its digest cannot appear in a
    // record that lives inside it.
    const repo = makeRepo();
    const out = generate(repo);
    const recorded = readRecord(out).commit.commitId;
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'commit the record']);
    const containerCommit = git(repo, ['rev-parse', 'HEAD']);
    assert.notEqual(containerCommit, recorded);

    // The record still verifies against its own commit...
    assert.equal(verifyAttestation(out, { cwd: repo }).ok, true);
    // ...and is NOT evidence about the commit that contains it.
    const strict = verifyAttestation(out, { cwd: repo, strict: true });
    assert.equal(strict.ok, false);
    assert.equal(strict.targetMismatches[0].code, 'attestation-head-mismatch');
    assert.equal(strict.targetChecks.strict.headCommitId, containerCommit);
    assert.equal(strict.targetChecks.strict.actual, recorded);
    assert.equal(strict.contentOk, true, 'the boundary is about targets, not about corruption');
  });

  it('a mismatch report names both sides, so nobody has to guess which SHA is which', () => {
    const repo = makeRepo();
    const out = generate(repo);
    const recorded = readRecord(out).commit.commitId;
    const newer = addCommit(repo, 'later.ts');
    const result = runCli(['--verify', out, '--expect-commit', newer, '--json', '--cwd', repo]);
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.verified, false);
    assert.equal(parsed.contentVerified, true);
    assert.equal(parsed.commitId, recorded);
    assert.equal(parsed.headCommitId, newer);
    assert.deepEqual(parsed.targetChecks.expectCommit, { expected: newer, actual: recorded, ok: false });
    assert.equal(parsed.targetMismatches.length, 1);
    assert.equal(parsed.targetMismatches[0].code, 'attestation-target-mismatch');
  });
});

describe('attestation: the repository artifact is not touched by this suite', () => {
  it('does not modify docs/reports/final-attestation.json', () => {
    const artifact = path.join(repoRoot, 'docs', 'reports', 'final-attestation.json');
    if (!fs.existsSync(artifact)) {
      // Nothing to protect on a tree that has no committed artifact.
      return;
    }
    const before = fileSha256(artifact);
    const repo = makeRepo();
    generate(repo);
    runCli(['--verify', path.join(repo, 'attestation.json'), '--cwd', repo]);
    runCli(['--verify', artifact, '--expect-commit', '3'.repeat(40)]);
    assert.equal(fileSha256(artifact), before, 'the committed attestation must not be rewritten by a test run');
  });
});
