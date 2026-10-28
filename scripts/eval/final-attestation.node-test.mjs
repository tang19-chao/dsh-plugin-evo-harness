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
 * P1 ADDENDUM (ADR 0005 decision D1, task t2) - the per-commit gate
 * ----------------------------------------------------------------
 * The primitives above are per-RECORD checks. The D1 contract adds a
 * per-COMMIT classification, implemented by
 * `scripts/eval/check-attestation-target.mjs` and exercised by the appended
 * suites at the bottom of this file: the full T0-T8 topology table
 * (ordinary vs evidence commits, marker shape, record purity, merge/stacked
 * rejection, missing record, ancestry bound) plus the two degenerate-design
 * refutations the ADR requires. The gate reuses `verifyAttestation` and the
 * shared `CANONICAL_RECORD_PATH` / `ATTESTATION_TARGET_MARKER` constants, so
 * the primitives pinned here and the gate judged in CI cannot drift apart.
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
import {
  ATTESTATION_TARGET_MARKER,
  CANONICAL_RECORD_PATH,
  verifyAttestation
} from './final-attestation.mjs';
import { checkAttestationTarget } from './check-attestation-target.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const CLI = path.join(__dirname, 'final-attestation.mjs');
const GATE_CLI = path.join(__dirname, 'check-attestation-target.mjs');

const MARKER = ATTESTATION_TARGET_MARKER; // 'Attestation-Target: first-parent'

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

// ---------------------------------------------------------------------------
// P1 ADDENDUM (ADR 0005 decision D1, task t2): the attestation-target gate.
// Everything below judges COMMITS via `check-attestation-target.mjs`.
// ---------------------------------------------------------------------------

/** The canonical record path inside a fixture repo. */
function canonicalRecordPath(dir) {
  return path.join(dir, CANONICAL_RECORD_PATH);
}

/** A code commit touching `src/`; returns the new HEAD id. */
function codeCommit(dir, message = 'code change') {
  const name = `c${Date.now()}-${Math.floor(Math.random() * 1e9)}.ts`;
  fs.writeFileSync(path.join(dir, 'src', name), `export const ${name.replace(/\W/g, '_')} = 3;\n`, 'utf8');
  git(dir, ['add', path.join('src', name)]);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

/**
 * Generate a canonical record for the CURRENT HEAD into the canonical path
 * (mimicking `pnpm run attest` on a clean tree).
 */
function generateCanonicalRecord(dir) {
  const out = canonicalRecordPath(dir);
  const result = runCli(['--ref', 'HEAD', '--out', out, '--cwd', dir]);
  assert.equal(result.status, 0, `record generation failed: ${result.stderr}${result.stdout}`);
  return out;
}

/**
 * Commit the canonical record file. Shapes:
 *   - `{ withMarker: true }`  : body + blank line + `Attestation-Target:
 *     first-parent` trailer (a real T1 evidence commit);
 *   - `{ markerLines: [...] }`: body + blank line + arbitrary trailer lines
 *     (T8 duplicated/unsupported fixtures);
 *   - default                 : an ordinary record commit (no marker).
 * Returns the new HEAD id.
 */
function commitCanonicalRecord(dir, { withMarker = false, messageLines = [], markerLines = null } = {}) {
  git(dir, ['add', CANONICAL_RECORD_PATH]);
  /** @type {string[]} */
  let message;
  if (withMarker) {
    const body = messageLines.length > 0 ? messageLines : ['record update'];
    message = [...body, '', MARKER];
  } else if (markerLines !== null) {
    const body = messageLines.length > 0 ? messageLines : ['record update'];
    message = [...body, '', ...markerLines];
  } else {
    message = messageLines.length > 0 ? messageLines : ['commit the canonical record'];
  }
  git(dir, ['commit', '-q', '-m', message.join('\n')]);
  return git(dir, ['rev-parse', 'HEAD']);
}

/** Run the gate CLI, returning status + streams instead of throwing. */
function runGateCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [GATE_CLI, ...args], {
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

/** Run the gate in-process (the same function the CLI drives). */
function runGate(dir, ref) {
  return checkAttestationTarget({ cwd: dir, ...(ref === undefined ? {} : { ref }) });
}

/**
 * Standard T1 construction: C (code) -> record for C -> E (marker + record-only).
 * Returns both ids.
 */
function makeEvidencePair(dir) {
  const c = codeCommit(dir, 'code commit C');
  generateCanonicalRecord(dir);
  const e = commitCanonicalRecord(dir, { withMarker: true, messageLines: [`record for ${c.slice(0, 7)}`] });
  return { c, e };
}

/**
 * Create a ROOT commit object via plumbing only (no worktree/index change) so a
 * T7 fixture can name a commit that exists in the object database but is NOT an
 * ancestor of HEAD.
 */
function makeOrphanRootCommit(dir) {
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: dir,
    input: 'export const orphan = 1;\n',
    encoding: 'utf8',
    env: gitEnv()
  }).trim();
  const tree = execFileSync('git', ['mktree'], {
    cwd: dir,
    input: `100644 blob ${blob}\torphan.ts\n`,
    encoding: 'utf8',
    env: gitEnv()
  }).trim();
  return execFileSync('git', ['commit-tree', tree, '-m', 'island root commit'], {
    cwd: dir,
    encoding: 'utf8',
    env: gitEnv()
  }).trim();
}

/** Assert a gate result carries a specific failure code. */
function assertGateFailure(result, code) {
  assert.equal(result.ok, false, `expected ${code}, got ok`);
  const codes = result.failures.map((failure) => failure.code);
  assert.ok(codes.includes(code), `expected ${code}, got ${JSON.stringify(result.failures)}`);
}

describe('gate: shared constants come from the single source of truth', () => {
  it('exports the canonical record path and the exact marker', () => {
    assert.equal(CANONICAL_RECORD_PATH, 'docs/reports/final-attestation.json');
    assert.equal(MARKER, 'Attestation-Target: first-parent');
  });

  it('the gate accepts exactly the shared marker (a T1 fixture passes and an off-by-one value fails)', () => {
    // Drift guard: the gate's internal marker literal is exercised against the
    // SHARED constant through real commits - a marker the constant names passes
    // (mode evidence), and any other value is T8-rejected.
    const dir = makeRepo();
    const { c } = makeEvidencePair(dir);
    const result = runGate(dir);
    assert.equal(result.mode, 'evidence');
    assert.equal(result.ok, true, JSON.stringify(result.failures));
    assert.equal(result.parentCommitId, c);
  });
});

describe('gate T0: ordinary commit = self-consistency + ancestry, no invented parent binding', () => {
  it('passes when the record describes HEAD^1 and no marker is present, and invents NO parent target', () => {
    const dir = makeRepo();
    const c = codeCommit(dir);
    generateCanonicalRecord(dir); // records C
    const head = commitCanonicalRecord(dir); // ordinary record commit
    assert.notEqual(head, c);
    const result = runGate(dir);
    assert.equal(result.mode, 'ordinary');
    assert.equal(result.ok, true, JSON.stringify(result.failures));
    assert.equal(result.recordedCommitId, c);
    assert.equal(result.parentCommitId, null, 'no parent binding may be invented for ordinary commits');
    assert.ok(result.notes[0].includes('NOT covered'), JSON.stringify(result.notes));
  });

  it('passes when the record is TWO commits old (the lax always-HEAD^ guess would be red here)', () => {
    const dir = makeRepo();
    const first = git(dir, ['rev-parse', 'HEAD']);
    generateCanonicalRecord(dir); // records FIRST
    commitCanonicalRecord(dir); // ordinary commit carrying the record
    codeCommit(dir, 'code commit 1');
    codeCommit(dir, 'code commit 2');
    const result = runGate(dir);
    assert.equal(result.mode, 'ordinary');
    assert.equal(result.ok, true, JSON.stringify(result.failures));
    assert.equal(result.recordedCommitId, first);
    assert.notEqual(
      result.recordedCommitId,
      git(dir, ['rev-parse', 'HEAD^1']),
      'the record points further back than HEAD^1: unconditional HEAD^ binding is refuted'
    );
  });

  it('FAILS T7 when the recorded commit is not an ancestor of HEAD (foreign record)', () => {
    const dir = makeRepo();
    generateCanonicalRecord(dir); // records the first commit
    commitCanonicalRecord(dir);
    // A root commit that exists in THIS object database but is not reachable
    // from HEAD (simulates rewritten history / an imported record).
    const island = makeOrphanRootCommit(dir);
    const record = readRecord(canonicalRecordPath(dir));
    record.commit.commitId = island;
    fs.writeFileSync(canonicalRecordPath(dir), JSON.stringify(record, null, 2) + '\n', 'utf8');
    codeCommit(dir, 'advance head');
    const result = runGate(dir);
    assertGateFailure(result, 'attestation-record-not-ancestor');
    const notAncestor = result.failures.find((failure) => failure.code === 'attestation-record-not-ancestor');
    assert.ok(notAncestor.detail.includes(island), notAncestor.detail);
  });
});

describe('gate T1: canonical evidence commit passes and binds HEAD^1 (not HEAD)', () => {
  it('passes: marker + record-only + non-merge + unmarked parent, target = HEAD^1', () => {
    const dir = makeRepo();
    const { c, e } = makeEvidencePair(dir);
    const result = runGate(dir);
    assert.equal(result.mode, 'evidence');
    assert.equal(result.ok, true, JSON.stringify(result.failures));
    assert.equal(result.recordedCommitId, c);
    assert.equal(result.parentCommitId, c);
    assert.equal(result.headCommitId, e);
    assert.ok(result.notes[0].includes(`parent=${c}`), JSON.stringify(result.notes));
    assert.ok(result.notes[0].includes('is covered'), JSON.stringify(result.notes));
    // The self-reference boundary holds inside the PASS: the record covers the
    // PARENT, never the commit that contains it.
    assert.notEqual(result.recordedCommitId, e);
  });

  it('CLI --json carries mode/parent/recorded and exits 0', () => {
    const dir = makeRepo();
    const { c } = makeEvidencePair(dir);
    const result = runGateCli(['--json', '--cwd', dir]);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.mode, 'evidence');
    assert.equal(parsed.ok, true);
    assert.equal(parsed.parentCommitId, c);
    assert.equal(parsed.recordedCommitId, c);
    assert.equal(parsed.targetOk, true);
    assert.deepEqual(parsed.failures, []);
  });

  it('a body sentence quoting the marker does NOT make an ordinary commit an evidence commit', () => {
    const dir = makeRepo();
    const c = codeCommit(dir);
    generateCanonicalRecord(dir);
    const head = commitCanonicalRecord(dir, {
      messageLines: [`This change references ${MARKER} in prose only.`]
    });
    const result = runGate(dir);
    assert.equal(result.mode, 'ordinary', 'a prose mention must not create an evidence commit');
    assert.equal(result.ok, true, JSON.stringify(result.failures));
    assert.equal(result.headCommitId, head);
    assert.equal(result.recordedCommitId, c);
  });
});

describe('gate T2: evidence commit with a wrong target fails', () => {
  it('fails when the record names an OLDER commit than HEAD^1', () => {
    const dir = makeRepo();
    const first = git(dir, ['rev-parse', 'HEAD']);
    generateCanonicalRecord(dir); // records FIRST
    codeCommit(dir, 'code commit C'); // HEAD^1 becomes C
    commitCanonicalRecord(dir, { withMarker: true });
    const result = runGate(dir);
    assertGateFailure(result, 'attestation-target-mismatch');
    const target = result.failures.find((failure) => failure.code === 'attestation-target-mismatch');
    assert.ok(target.detail.includes(first), target.detail);
  });

  it('fails when the record names a NEWER commit than HEAD^1', () => {
    const dir = makeRepo();
    const { e } = makeEvidencePair(dir);
    codeCommit(dir, 'code commit after E');
    const record = readRecord(canonicalRecordPath(dir));
    record.commit.commitId = e; // lie: names E, which is not this commit's parent
    fs.writeFileSync(canonicalRecordPath(dir), JSON.stringify(record, null, 2) + '\n', 'utf8');
    commitCanonicalRecord(dir, { withMarker: true });
    const result = runGate(dir);
    assertGateFailure(result, 'attestation-target-mismatch');
  });
});

describe('gate T3: evidence commit carrying non-record changes fails purity', () => {
  it('fails when a code file rides along with the record', () => {
    const dir = makeRepo();
    codeCommit(dir, 'code commit C');
    generateCanonicalRecord(dir);
    fs.writeFileSync(path.join(dir, 'src', 'extra.ts'), 'export const extra = 1;\n', 'utf8');
    git(dir, ['add', '-A']);
    // The marker must be a real trailer block (body + blank line + trailer);
    // a subject-only message is NOT a trailer block, so `-m MARKER` alone
    // would make this an ordinary commit and the purity rule would not fire.
    git(dir, ['commit', '-q', '-m', `record update\n\n${MARKER}`]);
    const result = runGate(dir);
    assertGateFailure(result, 'attestation-evidence-impure');
    const impure = result.failures.find((failure) => failure.code === 'attestation-evidence-impure');
    assert.ok(impure.detail.includes('src/extra.ts'), impure.detail);
  });

  it('fails when the evidence commit touches a non-canonical record name', () => {
    const dir = makeRepo();
    codeCommit(dir, 'code commit C');
    generateCanonicalRecord(dir);
    const sidecar = path.join(dir, 'docs', 'reports', 'final-attestation-old.json');
    fs.writeFileSync(sidecar, `{"commit":{"commitId":"${'a'.repeat(40)}"}}\n`, 'utf8');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', `record update\n\n${MARKER}`]);
    const result = runGate(dir);
    assertGateFailure(result, 'attestation-evidence-impure');
  });

  it('fails on an EMPTY evidence commit (marker without any change)', () => {
    const dir = makeRepo();
    codeCommit(dir, 'code commit C');
    generateCanonicalRecord(dir);
    git(dir, ['commit', '-q', '--allow-empty', '-m', `empty\n\n${MARKER}`]);
    const result = runGate(dir);
    assertGateFailure(result, 'attestation-evidence-impure');
  });
});

describe('gate T4: a merge commit with the marker fails', () => {
  it('fails with attestation-evidence-merge', () => {
    const dir = makeRepo();
    const base = git(dir, ['rev-parse', 'HEAD']);
    codeCommit(dir, 'main side');
    git(dir, ['checkout', '-q', '-b', 'feature', base]);
    fs.writeFileSync(path.join(dir, 'src', 'feat.ts'), 'export const feat = 1;\n', 'utf8');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'feature work']);
    generateCanonicalRecord(dir);
    commitCanonicalRecord(dir); // record rides on the feature branch (ordinary there)
    const featureTip = git(dir, ['rev-parse', 'HEAD']);
    git(dir, ['checkout', '-q', 'main']);
    git(dir, ['merge', '--no-ff', '--no-edit', '-m', `merge evidence branch\n\n${MARKER}`, featureTip]);
    assert.equal(git(dir, ['log', '-1', '--format=%B', 'HEAD']).includes(MARKER), true, 'fixture must carry the marker');
    const result = runGate(dir);
    assertGateFailure(result, 'attestation-evidence-merge');
  });
});

describe('gate T5: evidence stacked on evidence fails', () => {
  it('fails when the parent of an evidence commit is itself marked', () => {
    const dir = makeRepo();
    makeEvidencePair(dir); // C -> E (valid)
    generateCanonicalRecord(dir); // regenerate the record for E
    commitCanonicalRecord(dir, { withMarker: true }); // E2 on top of E
    const result = runGate(dir);
    assertGateFailure(result, 'attestation-evidence-stacked');
    const stacked = result.failures.find((failure) => failure.code === 'attestation-evidence-stacked');
    assert.ok(stacked.detail.includes('parent'), stacked.detail);
  });
});

describe('gate T6: missing/unreadable record fails without proceeding', () => {
  it('fails with attestation-record-missing when the record file is absent', () => {
    const dir = makeRepo();
    codeCommit(dir, 'no record committed here');
    const result = runGate(dir);
    assertGateFailure(result, 'attestation-record-missing');
  });

  it('fails with attestation-record-missing when the record is invalid JSON', () => {
    const dir = makeRepo();
    codeCommit(dir, 'code commit C');
    fs.mkdirSync(path.dirname(canonicalRecordPath(dir)), { recursive: true });
    fs.writeFileSync(canonicalRecordPath(dir), '{not json', 'utf8');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'commit a broken record']);
    const result = runGate(dir);
    assertGateFailure(result, 'attestation-record-missing');
  });

  it('fails with attestation-record-missing when the record has no commit.commitId', () => {
    const dir = makeRepo();
    codeCommit(dir, 'code commit C');
    fs.mkdirSync(path.dirname(canonicalRecordPath(dir)), { recursive: true });
    fs.writeFileSync(canonicalRecordPath(dir), '{"schemaVersion":"2.1.0"}\n', 'utf8');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'commit a shapeless record']);
    const result = runGate(dir);
    assertGateFailure(result, 'attestation-record-missing');
  });
});

describe('gate T8: marker shape', () => {
  it('fails with attestation-marker-duplicated on two marker trailers', () => {
    const dir = makeRepo();
    codeCommit(dir, 'code commit C');
    generateCanonicalRecord(dir);
    commitCanonicalRecord(dir, { markerLines: [MARKER, MARKER] });
    const result = runGate(dir);
    assertGateFailure(result, 'attestation-marker-duplicated');
  });

  it('fails with attestation-marker-unsupported on a non-first-parent value', () => {
    const dir = makeRepo();
    codeCommit(dir, 'code commit C');
    generateCanonicalRecord(dir);
    commitCanonicalRecord(dir, { markerLines: ['Attestation-Target: HEAD^'] });
    const result = runGate(dir);
    assertGateFailure(result, 'attestation-marker-unsupported');
    const unsupported = result.failures.find((failure) => failure.code === 'attestation-marker-unsupported');
    assert.ok(unsupported.detail.includes('HEAD^'), unsupported.detail);
  });
});

describe('gate CLI: exit codes, JSON shape, named git failures', () => {
  it('--help documents both modes and the reason codes', () => {
    const result = runGateCli(['--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /ordinary commit/);
    assert.match(result.stdout, /evidence commit/);
    assert.match(result.stdout, /Attestation-Target: first-parent/);
    assert.match(result.stdout, /attestation-target-mismatch/);
    assert.match(result.stdout, /attestation-evidence-impure/);
    assert.match(result.stdout, /attestation-record-missing/);
    assert.match(result.stdout, /attestation-record-not-ancestor/);
  });

  it('exits 1 with a named code when HEAD does not resolve', () => {
    const detached = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-norev-'));
    tempDirs.push(detached);
    fs.writeFileSync(path.join(detached, 'placeholder.txt'), 'not a repo\n', 'utf8');
    const result = runGateCli(['--json', '--cwd', detached]);
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.mode, null);
    // `resolveCommit` is the first evidence call; on a directory with no git
    // repository it fails with the lib's named code, which the CLI reports
    // under the same JSON shape.
    assert.equal(parsed.failures[0].code, 'ref-not-a-commit');
  });

  it('refuses unknown arguments and value-less flags', () => {
    for (const args of [['--bogus'], ['--cwd']]) {
      const result = runGateCli(args);
      assert.equal(result.status, 1, `${JSON.stringify(args)} must fail`);
      assert.match(result.stderr, /unknown-argument|argument-value-missing/);
    }
  });

  it('human output names the failure code on stderr and exits 1', () => {
    const dir = makeRepo();
    codeCommit(dir, 'no record');
    const result = runGateCli(['--cwd', dir]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /attestation-record-missing/);
  });

  it('judges an explicit non-HEAD ref (the parent of an evidence commit is ordinary there)', () => {
    const dir = makeRepo();
    const { c } = makeEvidencePair(dir);
    const atParent = runGate(dir, c);
    assert.equal(atParent.mode, 'ordinary');
    assert.equal(atParent.ok, true, JSON.stringify(atParent.failures));
    assert.equal(atParent.recordedCommitId, c, 'the record names the judged commit itself');
  });
});

describe('gate invariants: record immutability and honest coverage claims', () => {
  it('never rewrites or creates the canonical record, pass or fail', () => {
    const dir = makeRepo();
    makeEvidencePair(dir);
    const before = fileSha256(canonicalRecordPath(dir));
    runGate(dir);
    assert.equal(fileSha256(canonicalRecordPath(dir)), before, 'a passing judgment must not rewrite the record');

    const other = makeRepo();
    codeCommit(other, 'no record');
    assertGateFailure(runGate(other), 'attestation-record-missing');
    assert.equal(fs.existsSync(canonicalRecordPath(other)), false, 'the gate must not create a record');
  });

  it('never claims HEAD is covered, in either mode (no --strict semantics leaked in)', () => {
    const dir = makeRepo();
    const { c, e } = makeEvidencePair(dir);
    const evidence = runGate(dir);
    assert.equal(evidence.ok, true);
    assert.equal(evidence.recordedCommitId, c);
    assert.notEqual(evidence.recordedCommitId, e, 'the record cannot cover the commit containing it');

    // Ordinary honesty: advance with a CODE commit (no marker) and regenerate
    // the record for the new HEAD (an UNCOMMITTED working-tree update, exactly
    // the ADR §1.6.2 posture): the judgment must stay ordinary and must say
    // explicitly that HEAD is NOT covered by the committed record.
    codeCommit(dir, 'code commit after the evidence commit');
    generateCanonicalRecord(dir);
    const ordinary = checkAttestationTarget({ cwd: dir });
    assert.equal(ordinary.mode, 'ordinary');
    assert.ok(ordinary.notes[0].includes('NOT covered'), JSON.stringify(ordinary.notes));
  });

  it('this repository\'s committed artifact is never read, written or regenerated', () => {
    const artifact = path.join(repoRoot, 'docs', 'reports', 'final-attestation.json');
    if (!fs.existsSync(artifact)) {
      return;
    }
    const before = fileSha256(artifact);
    const dir = makeRepo();
    makeEvidencePair(dir);
    runGate(dir);
    assert.equal(fileSha256(artifact), before, 'the committed attestation must never be regenerated by a test run');
  });
});
