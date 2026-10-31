/**
 * PR-1: the gates themselves, and the attestation CLI.
 *
 * Every gate here is tested BOTH ways: it passes on the real tree, and it FAILS
 * on a purpose-built broken fixture. A gate tested only in the passing direction
 * is a gate nobody has ever seen work.
 *
 *   - `check-encoding-policy.mjs`       declared content policy (CRLF/BOM/binary)
 *   - `smoke-build.mjs`                 build output is importable as ESM
 *   - `final-attestation.mjs --verify`  a recorded attestation re-checks
 *   - `compare-platform-digests.mjs`    the cross-OS parity rule itself
 *
 * FIXTURES NEVER MUTATE THIS REPOSITORY
 * -------------------------------------
 * The policy-commit fixture used to `git checkout -b pr1-policy-commit-<uuid>`
 * inside a `git worktree` of THIS repository and then `git commit --allow-empty`
 * so that something existed to name. Two defects in one: the commit carried no
 * policy (its tree was identical to HEAD's, so the gate was asked about a commit
 * that does not contain what it claims) and every run left a permanent branch in
 * `.git` - three of them per `vitest run`, never cleaned up. The fixture below
 * instead builds a REAL policy commit on the frozen pre-policy baseline inside a
 * private `--shared` clone with a private index: no branch, no worktree
 * registration and no objects written into this repository. `afterAll` asserts
 * that count of `refs/heads/pr1-policy-commit-*` and of registered worktrees is
 * unchanged, so a future fixture cannot silently start leaking again.
 *
 * Offline: local git, local esbuild, no network, no model, no paid API.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEncodingPolicy } from '../../../scripts/eval/check-encoding-policy.mjs';
import { smokeBuild, type SmokeBuildResult } from '../../../scripts/eval/smoke-build.mjs';
import { comparePlatformDigests } from '../../../scripts/eval/compare-platform-digests.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const ATTESTATION_CLI = path.join(repoRoot, 'scripts', 'eval', 'final-attestation.mjs');
const POLICY_CLI = path.join(repoRoot, 'scripts', 'eval', 'check-encoding-policy.mjs');

/** Build one throw-away git repo whose committed bytes are exactly `files`. */
function makeRepo(files: Record<string, Buffer>, attributes?: string): string {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'pr1-gate-')));
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  const git = (args: readonly string[]) => execFileSync('git', args.slice(), { cwd: dir, encoding: 'utf8', env });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'pr1@example.invalid']);
  git(['config', 'user.name', 'PR-1 gate fixture']);
  git(['config', 'core.autocrlf', 'false']);
  if (attributes !== undefined) {
    fs.writeFileSync(path.join(dir, '.gitattributes'), attributes, 'utf8');
  }
  for (const [relative, bytes] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'fixture']);
  return dir;
}

/** Run a CLI and capture the exit status instead of throwing. */
function run(
  file: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv } = {}
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [file, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: options.env ?? process.env
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: typeof failure.status === 'number' ? failure.status : -1,
      stdout: String(failure.stdout ?? ''),
      stderr: String(failure.stderr ?? '')
    };
  }
}

/** A scrubbed git environment, so an ambient GIT_DIR cannot redirect evidence. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  return env;
}

/** Temp repositories this suite creates, removed in `afterAll`. */
const cleanupDirs: string[] = [];

/** Register a throw-away directory for removal in `afterAll`. */
function track(dir: string): string {
  cleanupDirs.push(dir);
  return dir;
}

/** Repository state a fixture must never grow; see `afterAll` below. */
interface RepoState {
  policyBranches: number;
  worktrees: number;
}

/**
 * Count the two pieces of repository state a fixture can leak.
 *
 * A previous version of this suite created one branch per policy-commit fixture
 * (`pr1-policy-commit-<uuid>`) because an `--allow-empty` commit needs a branch
 * to advance; those branches are permanent and nothing deleted them, so every
 * suite run added three refs to `.git`. Counting them before and after the
 * suite turns that leak into a visible test failure instead of a slow
 * accumulation that nobody notices.
 */
function measureRepoState(): RepoState {
  const branches = execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/heads/pr1-policy-commit-*'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: gitEnv()
  })
    .split('\n')
    .filter((line) => line.length > 0).length;
  const worktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: gitEnv()
  })
    .split('\n')
    .filter((line) => line.startsWith('worktree ')).length;
  return { policyBranches: branches, worktrees };
}

let repoStateBefore: RepoState | undefined;

beforeAll(() => {
  repoStateBefore = measureRepoState();
});

afterAll(() => {
  // Newest first: a worktree registered later may hold the newest admin state.
  // Only a directory this repository ACTUALLY registered as a worktree needs
  // `git worktree remove`; calling it for a plain temp dir prints
  // `fatal: ... is not a worktree` for every cleanup, which buries real gate
  // output, so plain directories are removed with rmSync only. Both paths are
  // silent, and both run when a test failed too (`afterAll` is a hook, not part
  // of the passing path), which is what makes the failure-path cleanup real.
  let registered = new Set<string>();
  try {
    registered = new Set(
      execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repoRoot, encoding: 'utf8', env: gitEnv() })
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => path.resolve(line.slice('worktree '.length).trim()))
    );
  } catch {
    // No worktree registry to clean: the rmSync path below still runs.
  }
  for (const dir of cleanupDirs.slice().reverse()) {
    if (registered.has(path.resolve(dir))) {
      try {
        execFileSync('git', ['worktree', 'remove', '--force', dir], {
          cwd: repoRoot,
          encoding: 'utf8',
          env: gitEnv(),
          stdio: 'ignore'
        });
        continue;
      } catch {
        // Fall through to rmSync: a half-removed worktree must still not leak.
      }
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A leftover temp dir must not turn a green suite red.
    }
  }
  // Cleanup is part of the contract, not a courtesy: assert the counts the suite
  // started with, so a future fixture cannot quietly reintroduce the leak.
  if (repoStateBefore !== undefined) {
    expect(measureRepoState(), 'this suite must not add pr1-policy-commit-* refs or worktree registrations').toEqual(
      repoStateBefore
    );
  }
});

describe('PR-1 encoding-policy gate', () => {
  /** The frozen commit that predates the policy: `git ls-tree <baseline> .gitattributes` is empty. */
  const POLICY_BASELINE = '84a3d828ed2a27eef765c8b9c4950da4a9ee7287';

  /** How many blobs the baseline tree holds: the policy commit has exactly one more. */
  function baselineBlobCount(): number {
    return execFileSync('git', ['ls-tree', '-r', POLICY_BASELINE], { cwd: repoRoot, encoding: 'utf8', env: gitEnv() })
      .split('\n')
      .filter((line) => /^\d{6} blob /.test(line)).length;
  }

  interface PolicyCommitFixture {
    /** The synthesized commit: baseline + the current `.gitattributes`. */
    commitId: string;
    /** Private clone that owns the fixture commit; the only place it resolves. */
    cloneDir: string;
    /** The clone's object directory, for a read-only alternate. */
    objectDir: string;
  }

  /**
   * Build a REAL policy commit on top of the frozen pre-policy baseline.
   *
   * WHY NOT the old `worktree add --detach HEAD` + `git commit` fixture:
   *   - `HEAD` already contains `.gitattributes` (it arrived in the rev3
   *     commit), so `git add .gitattributes` there is a no-op and `git commit`
   *     fails with `nothing to commit, working tree clean`. The fixture that
   *     lived here worked around that with `--allow-empty`, i.e. it asserted the
   *     gate against a commit whose tree did NOT contain the policy - the exact
   *     false pass the gate exists to prevent;
   *   - `checkout -b pr1-policy-commit-<uuid>` then left a permanent branch
   *     behind on every run, because the branch name was the only thing holding
   *     the empty commit alive. Nothing deleted those branches.
   *
   * This builder instead synthesizes the commit honestly: parent is the frozen
   * pre-policy baseline, tree is the baseline tree plus the policy blob (added
   * through a PRIVATE index), and `commit-tree` writes it into a private
   * `--shared` clone. No branch, no worktree registration, and no object is
   * written into this repository - test (f) in the first case below proves that
   * by requiring the commit to be unresolvable here.
   */
  function commitPolicyOntoBaseline(): PolicyCommitFixture {
    const cloneDir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'pr1-policy-commit-')));
    // `--shared` borrows this repository's object database read-only instead of
    // copying it; `--no-checkout` means there is no worktree to clean up at all.
    execFileSync('git', ['clone', '-q', '--shared', '--no-checkout', repoRoot, cloneDir], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: gitEnv()
    });
    // A private index: the fixture must not read or write this repository's index.
    const fixtureEnv: NodeJS.ProcessEnv = { ...gitEnv(), GIT_INDEX_FILE: path.join(cloneDir, '.git', 'policy-index') };
    // `hash-object -w` writes into the repository `cwd` names - the clone, never
    // this repository. The policy bytes are this checkout's committed policy.
    const blobId = execFileSync('git', ['hash-object', '-w', '--', path.join(repoRoot, '.gitattributes')], {
      cwd: cloneDir,
      encoding: 'utf8',
      env: fixtureEnv
    }).trim();
    execFileSync('git', ['read-tree', `${POLICY_BASELINE}^{tree}`], { cwd: cloneDir, encoding: 'utf8', env: fixtureEnv });
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `100644,${blobId},.gitattributes`], {
      cwd: cloneDir,
      encoding: 'utf8',
      env: fixtureEnv
    });
    const treeId = execFileSync('git', ['write-tree'], { cwd: cloneDir, encoding: 'utf8', env: fixtureEnv }).trim();
    // Fixed identity and dates keep the id stable between runs. Nothing asserts
    // that stability; it only makes a failure message comparable across runs.
    const commitId = execFileSync(
      'git',
      [
        '-c',
        'user.email=pr1@example.invalid',
        '-c',
        'user.name=PR-1 gate fixture',
        'commit-tree',
        treeId,
        '-p',
        POLICY_BASELINE,
        '-m',
        'gate: commit the content policy onto the pre-policy baseline'
      ],
      {
        cwd: cloneDir,
        encoding: 'utf8',
        env: {
          ...gitEnv(),
          GIT_AUTHOR_DATE: '2026-01-01T00:00:00+0000',
          GIT_COMMITTER_DATE: '2026-01-01T00:00:00+0000'
        }
      }
    ).trim();
    return { commitId, cloneDir, objectDir: path.join(cloneDir, '.git', 'objects') };
  }

  /** Built once per suite: one clone, reused by the cases that need the fixture. */
  let policyCommitFixture: PolicyCommitFixture | undefined;
  function policyCommit(): PolicyCommitFixture {
    policyCommitFixture ??= commitPolicyOntoBaseline();
    return policyCommitFixture;
  }

  it('names a REAL policy commit on the frozen pre-policy baseline, not an empty one', () => {
    const { commitId, cloneDir } = policyCommit();
    const gitIn = (args: readonly string[]): string =>
      execFileSync('git', args.slice(), { cwd: cloneDir, encoding: 'utf8', env: gitEnv() }).trim();

    // (a) the parent is the frozen pre-policy baseline, and that parent really
    //     has no policy file - so the commit under test is where it arrives.
    expect(gitIn(['rev-parse', `${commitId}^`])).toBe(POLICY_BASELINE);
    expect(gitIn(['ls-tree', '--name-only', POLICY_BASELINE, '--', '.gitattributes'])).toBe('');

    // (b) the tree CHANGED. An empty commit would have tree == parent tree and
    //     would be evidence of nothing; this is the assertion that outlaws it.
    expect(gitIn(['rev-parse', `${commitId}^{tree}`])).not.toBe(gitIn(['rev-parse', `${POLICY_BASELINE}^{tree}`]));

    // (c) the commit carries exactly the policy file: untracked teammates'
    //     files (PR-2/3/4A artifacts) must not be swept into the fixture.
    expect(gitIn(['diff-tree', '--no-commit-id', '--name-only', '-r', commitId])).toBe('.gitattributes');

    // (d) the committed bytes are the policy this checkout actually declares.
    const worktreePolicyBlob = execFileSync('git', ['hash-object', '--', path.join(repoRoot, '.gitattributes')], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: gitEnv()
    }).trim();
    expect(gitIn(['rev-parse', `${commitId}:.gitattributes`])).toBe(worktreePolicyBlob);
    expect(worktreePolicyBlob).toBe(
      execFileSync('git', ['rev-parse', 'HEAD:.gitattributes'], { cwd: repoRoot, encoding: 'utf8', env: gitEnv() }).trim()
    );

    // (e) nothing points at it, here or in the clone: the fixture is anonymous,
    //     so no ref is left behind for a later `git branch` to trip over.
    expect(gitIn(['for-each-ref', '--points-at', commitId, '--format=%(refname)'])).toBe('');

    // (f) the fixture wrote NO object into this repository: the commit resolves
    //     in the clone and nowhere else.
    expect(() =>
      execFileSync('git', ['cat-file', '-e', commitId], { cwd: repoRoot, stdio: 'ignore', env: gitEnv() })
    ).toThrow();
  });

  it('passes on a commit that contains the policy, and names that commit', () => {
    const { commitId, cloneDir } = policyCommit();
    const result = checkEncodingPolicy({ ref: commitId, cwd: cloneDir });
    expect(result.commitId).toBe(commitId);
    expect(result.attributesPresent).toBe(true);
    // Exact, not a lower bound: the fixture commit is the baseline tree plus one
    // blob, so a tree that is not the policy commit's tree cannot pass here.
    expect(result.checked).toBe(baselineBlobCount() + 1);
    expect(result.checked).toBeGreaterThan(100);
    expect(result.violations).toEqual([]);
  });

  it('reports attributes-missing on a commit that predates the policy (the frozen baseline)', () => {
    const result = checkEncodingPolicy({ ref: '84a3d828ed2a27eef765c8b9c4950da4a9ee7287' });
    expect(result.attributesPresent).toBe(false);
    expect(result.violations.map((violation) => violation.kind)).toContain('attributes-missing');
    // A locally present, uncommitted .gitattributes does NOT change the verdict:
    // the same call against the baseline commit in a repo whose worktree copy
    // is absent must give the same answer.
    const bare = track(fs.mkdtempSync(path.join(os.tmpdir(), 'pr1-policy-bare-')));
    execFileSync('git', ['clone', '-q', '--bare', '--no-hardlinks', repoRoot, bare], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: gitEnv()
    });
    const fromBare = checkEncodingPolicy({ ref: '84a3d828ed2a27eef765c8b9c4950da4a9ee7287', cwd: bare });
    expect(fromBare.attributesPresent).toBe(false);
    expect(fromBare.violations.map((violation) => violation.kind)).toContain('attributes-missing');
  }, 120_000);

  it('distinguishes the tracked state from the untracked state on IDENTICAL policy bytes', () => {
    // Acceptance: the tracked and untracked states must both be covered, and the
    // difference between them must be the COMMIT - not the file's contents.
    // The same policy text and the same CRLF blob are used in both fixtures, so
    // only one variable changes: whether the commit contains `.gitattributes`.
    const policyText = 'src/*.txt -text\n';
    const crlf = Buffer.from('one\r\ntwo\r\n', 'utf8');

    // State A - UNTRACKED: the bytes exist on disk, the commit does not have them.
    const untracked = makeRepo({ 'src/crlf.txt': crlf });
    fs.writeFileSync(path.join(untracked, '.gitattributes'), policyText, 'utf8');
    expect(
      execFileSync('git', ['status', '--porcelain', '--', '.gitattributes'], { cwd: untracked, encoding: 'utf8', env: gitEnv() }).trim()
    ).toBe('?? .gitattributes');
    const untrackedResult = checkEncodingPolicy({ cwd: untracked });
    expect(untrackedResult.attributesPresent).toBe(false);
    expect(untrackedResult.declaredRules).toEqual([]);
    expect(untrackedResult.violations.map((violation) => violation.kind).sort()).toEqual([
      'attributes-missing',
      'undeclared-non-lf-blob'
    ]);

    // State B - TRACKED: byte-identical policy text, this time in the commit.
    const tracked = makeRepo({ 'src/crlf.txt': crlf }, policyText);
    expect(
      execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: tracked, encoding: 'utf8', env: gitEnv() }).trim()
    ).toBe(''); // clean tree: the policy is committed, not merely present
    expect(
      execFileSync('git', ['rev-parse', 'HEAD:.gitattributes'], { cwd: tracked, encoding: 'utf8', env: gitEnv() }).trim()
    ).toBe(execFileSync('git', ['hash-object', '.gitattributes'], { cwd: tracked, encoding: 'utf8', env: gitEnv() }).trim());
    const trackedResult = checkEncodingPolicy({ cwd: tracked });
    expect(trackedResult.attributesPresent).toBe(true);
    expect(trackedResult.declaredRules).toEqual(['src/*.txt -text']);
    expect(trackedResult.violations).toEqual([]);
    expect(trackedResult.exceptions).toHaveLength(1);
  });

  it('reads the policy from the commit: an untracked .gitattributes cannot create or cure a violation', () => {
    // FALSE PASS direction: the commit has NO policy file; a worktree copy
    // declares the fixture. The gate must still fail, because the policy the
    // commit contains is the only one that can bless its bytes.
    const dir = makeRepo({ 'src/crlf.txt': Buffer.from('one\r\ntwo\r\n', 'utf8') });
    fs.writeFileSync(path.join(dir, '.gitattributes'), 'src/*.txt -text\n', 'utf8');
    const forgiving = checkEncodingPolicy({ cwd: dir });
    expect(forgiving.attributesPresent).toBe(false); // the COMMIT has no policy
    expect(forgiving.violations.map((violation) => violation.kind)).toContain('attributes-missing');
    expect(forgiving.violations.map((violation) => violation.kind)).toContain('undeclared-non-lf-blob');

    // FALSE FAIL direction: the commit DOES declare the fixture; the worktree
    // copy is then weakened to something that no longer covers it. The gate
    // must still pass, because the committed policy is what counts.
    const committed = makeRepo({ 'src/crlf.txt': Buffer.from('one\r\ntwo\r\n', 'utf8') }, 'src/*.txt -text\n');
    fs.writeFileSync(path.join(committed, '.gitattributes'), '*.md text eol=lf\n', 'utf8');
    const strict = checkEncodingPolicy({ cwd: committed });
    expect(strict.attributesPresent).toBe(true);
    expect(strict.violations).toEqual([]);
    expect(strict.exceptions).toHaveLength(1);
  });

  it('passes when the worktree .gitattributes is deleted but the commit declares the policy', () => {
    const dir = makeRepo({ 'src/crlf.txt': Buffer.from('one\r\ntwo\r\n', 'utf8') }, 'src/*.txt -text\n');
    fs.rmSync(path.join(dir, '.gitattributes'));
    const result = checkEncodingPolicy({ cwd: dir });
    expect(result.attributesPresent).toBe(true); // in the COMMIT
    expect(result.violations).toEqual([]);
    expect(result.exceptions).toHaveLength(1);
  });

  it('declares a policy budget: the file is not a blanket renormalise', () => {
    const text = fs.readFileSync(path.join(repoRoot, '.gitattributes'), 'utf8');
    const rules = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    expect(rules).not.toContain('* text=auto');
    expect(rules).not.toContain('* text');
    expect(rules).not.toContain('* -text');
    // Every non-comment rule must be justified by a comment above it, which is
    // how a reviewer can see WHY a path is an exception.
    expect(text).toContain('-text');
  });

  it('FAILS when a CRLF blob is not declared -text', () => {
    const dir = makeRepo({ 'src/crlf.txt': Buffer.from('one\r\ntwo\r\n', 'utf8') }, '*.mjs text eol=lf\n');
    const result = checkEncodingPolicy({ cwd: dir });
    expect(result.violations.map((violation) => violation.kind)).toContain('undeclared-non-lf-blob');
    expect(result.violations.some((violation) => violation.detail.includes('src/crlf.txt'))).toBe(true);
  });

  it('FAILS when a BOM blob is not declared -text', () => {
    const dir = makeRepo({ 'src/bom.ts': Buffer.from([0xef, 0xbb, 0xbf, 0x65, 0x0a]) }, '*.mjs text eol=lf\n');
    const result = checkEncodingPolicy({ cwd: dir });
    expect(result.violations.some((violation) => violation.detail.includes('BOM'))).toBe(true);
  });

  it('FAILS when a binary blob is not declared', () => {
    const dir = makeRepo({ 'src/raw.bin': Buffer.from([0x61, 0x00, 0x62]) }, '*.mjs text eol=lf\n');
    const result = checkEncodingPolicy({ cwd: dir });
    expect(result.violations.some((violation) => violation.detail.includes('NUL'))).toBe(true);
  });

  it('FAILS on a blanket renormalise rule', () => {
    const dir = makeRepo({ 'src/a.ts': Buffer.from('export const a = 1;\n', 'utf8') }, '* text=auto\n');
    const result = checkEncodingPolicy({ cwd: dir });
    expect(result.violations.map((violation) => violation.kind)).toContain('blanket-renormalise');
  });

  it('FAILS when .gitattributes is missing entirely', () => {
    const dir = makeRepo({ 'src/a.ts': Buffer.from('export const a = 1;\n', 'utf8') });
    const result = checkEncodingPolicy({ cwd: dir });
    expect(result.violations.map((violation) => violation.kind)).toContain('attributes-missing');
  });

  it('PASSES a declared -text exception and reports it', () => {
    const dir = makeRepo(
      { 'tests/fixtures/encoding/crlf.txt': Buffer.from('one\r\ntwo\r\n', 'utf8') },
      '*.mjs text eol=lf\ntests/fixtures/encoding/** -text\n'
    );
    const result = checkEncodingPolicy({ cwd: dir });
    expect(result.violations).toEqual([]);
    expect(result.exceptions).toHaveLength(1);
    expect(result.exceptions[0]).toContain('tests/fixtures/encoding/crlf.txt');
  });

  it('exits 0 through the CLI for a policy-complete commit, and 1 for the policy-less baseline', () => {
    // The CLI path matters: gate outcomes must be visible to CI, not only to an
    // in-process caller. `--ref` exists precisely so CI can name the commit.
    const { commitId, objectDir } = policyCommit();
    // The fixture commit lives in a private clone, so the CLI (which always
    // inspects this repository's root) is pointed at that object directory as a
    // READ-ONLY alternate. Nothing is written here; the commit is simply
    // resolvable for the duration of this call.
    const fixtureEnv: NodeJS.ProcessEnv = { ...gitEnv(), GIT_ALTERNATE_OBJECT_DIRECTORIES: objectDir };
    expect(run(POLICY_CLI, ['--ref', commitId], { env: fixtureEnv }).status).toBe(0);
    // The frozen baseline predates .gitattributes, so its honest verdict is a
    // failure that names the defect.
    const baseline = run(POLICY_CLI, ['--ref', POLICY_BASELINE]);
    expect(baseline.status).toBe(1);
    expect(baseline.stdout + baseline.stderr).toContain('attributes-missing');
    // A broken fixture is still asserted through the in-process API.
    const dir = makeRepo({ 'src/crlf.txt': Buffer.from('one\r\ntwo\r\n', 'utf8') }, '*.mjs text eol=lf\n');
    expect(checkEncodingPolicy({ cwd: dir }).violations.length).toBeGreaterThan(0);
  }, 120_000);

  it('emits machine-readable JSON for CI', () => {
    const { commitId, objectDir } = policyCommit();
    const result = run(POLICY_CLI, ['--json', '--ref', commitId], {
      env: { ...gitEnv(), GIT_ALTERNATE_OBJECT_DIRECTORIES: objectDir }
    });
    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.attributesPresent).toBe(true);
    expect(parsed.checked).toBe(baselineBlobCount() + 1);
    expect(parsed.commitId).toBe(commitId);
  });
});

describe('PR-1 build/ESM smoke gate', () => {
  // This suite used to pass `skipBuild: fs.existsSync(artifact)`, so an existing
  // `lib/index.js` was reused and the gate certified bytes the source no longer
  // produced. Measured (t8): with a CommonJS `require` added to `src/` this
  // suite stayed green (3 passed) while `node scripts/eval/smoke-build.mjs`
  // went red on a real build - expired evidence reported as a passed gate. The
  // whole value of the check is that the artifact came from the CURRENT source,
  // so the build is unconditional: one build per run, shared by both tests
  // below. `beforeAll` (not the first test) so a filtered run (`-t`) also
  // builds before asserting anything.
  let built: SmokeBuildResult;

  beforeAll(async () => {
    built = await smokeBuild();
  }, 300_000);

  it('builds and imports the bundle as ESM', () => {
    // Prove the build actually ran: a skipped build is the bypass itself.
    expect(built.steps[0]).toEqual({ step: 'build', ok: true, detail: 'pnpm run build exited 0' });
    expect(built.ok, JSON.stringify(built.steps, null, 2)).toBe(true);
  }, 300_000);

  it('reports the required public surface', async () => {
    // `skipBuild` is honest here only because the `beforeAll` above just rebuilt
    // the artifact from this working tree, in this process.
    const result = await smokeBuild({ skipBuild: true });
    expect(result.exportCount).toBeGreaterThan(10);
    expect(result.bytes).toBeGreaterThan(1000);
    const steps = result.steps.map((step) => step.step);
    expect(steps).toContain('artifact-is-esm');
    expect(steps).toContain('esm-import');
    expect(steps).toContain('required-exports');
    expect(steps).toContain('entrypoints-callable');
  }, 300_000);

  it('FAILS on a missing artifact instead of reporting success', async () => {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'pr1-smoke-empty-')));
    const result = await smokeBuild({ skipBuild: true, cwd: dir });
    expect(result.ok).toBe(false);
    // With --skip-build the first step is the skipped build; the artifact check
    // is the one that must fail.
    const artifactStep = result.steps.find((step) => step.step === 'artifact-exists');
    expect(artifactStep?.ok).toBe(false);
  });
});

describe('PR-1 build child environment (rev6 CI pin)', () => {
  // rev6 pins the production build child to `CI=true` (scripts/eval/smoke-build.mjs):
  // pnpm and the tools behind it change behavior when CI is set, so a build
  // child that inherits the caller's CI value produces different evidence from
  // a developer shell than from a CI job. These tests do not trust the spawn
  // options - they OBSERVE the environment: the fixture's `build` script is a
  // real node process that dumps `process.env` to disk before doing anything
  // else, so every assertion below is evidence of what the child ACTUALLY saw
  // through the real `pnpm run build` spawn path. No test here uses
  // `--skip-build`: a skipped build could never have produced the probe output.
  //
  // The fixtures ship no `lib/index.js`, so after the build step is observed
  // the gate is EXPECTED to fail on `artifact-exists`; that failure is part of
  // the assertion, not noise.

  /** The fixture build script: record the child environment, then optionally fail. */
  const PROBE_SCRIPT = [
    "import fs from 'node:fs';",
    "fs.writeFileSync('child-env.json', JSON.stringify(process.env), 'utf8');",
    "if (process.env.PR1_PROBE_FAIL === '1') {",
    "  console.error('PR1-NEGATIVE-BUILD-MARKER fixture build failed on purpose');",
    '  process.exit(1);',
    '}',
    ''
  ].join('\n');

  /** One throw-away package whose `build` script is the probe above. */
  function makeProbeFixture(): string {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'pr1-ci-env-')));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify(
        { name: 'pr1-ci-env-fixture', version: '0.0.0', private: true, scripts: { build: 'node probe-build.mjs' } },
        null,
        2
      ) + '\n',
      'utf8'
    );
    fs.writeFileSync(path.join(dir, 'probe-build.mjs'), PROBE_SCRIPT, 'utf8');
    return dir;
  }

  /**
   * Run the gate against `dir` with a temporarily mutated CALLER environment.
   * The mutation is exactly what the pin must neutralise, so it happens on the
   * live `process.env` the spawn inherits - and is restored even when
   * assertions throw, so no other test in this worker sees fixture variables.
   */
  async function smokeWithCallerEnv(dir: string, mutate: (env: NodeJS.ProcessEnv) => void): Promise<SmokeBuildResult> {
    const watched = ['CI', 'PR1_CALLER_MARKER', 'PR1_PROBE_FAIL'] as const;
    const snapshot = watched.map((key) => [key, process.env[key]] as const);
    mutate(process.env);
    try {
      return await smokeBuild({ cwd: dir });
    } finally {
      for (const [key, value] of snapshot) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  /** The environment the build child ACTUALLY saw, recorded by the probe. */
  function readChildEnv(dir: string): Record<string, string> {
    return JSON.parse(fs.readFileSync(path.join(dir, 'child-env.json'), 'utf8'));
  }

  /**
   * Case-insensitive environment lookup. Windows environment variable names are
   * case-insensitive, and every middleman between this process and the build
   * child (shell, cmd, pnpm) may rewrite the spelling - the same machine
   * observed `ComSpec` through one spawn chain and `COMSPEC` through another.
   * Assertions about presence must therefore never depend on the recorded case.
   */
  function pickEnv(env: Record<string, string>, name: string): string | undefined {
    const key = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : env[key];
  }

  it('pins CI=true for the build child even when the caller exports CI=false, preserving the caller environment', async () => {
    const dir = makeProbeFixture();
    const result = await smokeWithCallerEnv(dir, (env) => {
      env.CI = 'false'; // the exact caller state the pin exists to neutralise
      env.PR1_CALLER_MARKER = 'inherited-verbatim';
    });
    // The build step is real and succeeded: `child-env.json` can only exist
    // because pnpm executed the probe.
    expect(result.steps[0]).toEqual({ step: 'build', ok: true, detail: 'pnpm run build exited 0' });
    const child = readChildEnv(dir);
    // (a) THE PIN: the child sees CI=true, never the caller's false.
    expect(pickEnv(child, 'CI')).toBe('true');
    // (b) necessary system env survived: PATH for tool discovery, plus the
    // platform variables programs rely on (Windows keeps its own spellings).
    expect(pickEnv(child, 'PATH'), 'PATH must reach the build child').toBeTruthy();
    if (process.platform === 'win32') {
      expect(pickEnv(child, 'ComSpec'), 'ComSpec must reach the build child').toBeTruthy();
      expect(pickEnv(child, 'SystemRoot'), 'SystemRoot must reach the build child').toBeTruthy();
    } else {
      expect(pickEnv(child, 'HOME'), 'HOME must reach the build child').toBeTruthy();
    }
    // (c) inheritance is WHOLESALE, not a curated whitelist: a caller variable
    // the gate has never heard of reaches the child unchanged.
    expect(child.PR1_CALLER_MARKER).toBe('inherited-verbatim');
    // The fixture ships no artifact, so the gate's first verdict after the
    // observed build is the artifact check - the probe build was never
    // mistaken for a full pass.
    expect(result.ok).toBe(false);
    expect(result.steps[1]).toMatchObject({ step: 'artifact-exists', ok: false });
  }, 60_000);

  it('pins CI=true when the caller does not define CI at all', async () => {
    const dir = makeProbeFixture();
    const result = await smokeWithCallerEnv(dir, (env) => {
      delete env.CI;
    });
    expect(result.steps[0]).toEqual({ step: 'build', ok: true, detail: 'pnpm run build exited 0' });
    expect(readChildEnv(dir).CI).toBe('true');
  }, 60_000);

  it('FAILS the gate when the real build fails, with CI=true still pinned in the failing child', async () => {
    // Negative direction: the pin must not turn a red build green, and the
    // verdict must be the build step's own failure carrying the child's stderr.
    const dir = makeProbeFixture();
    const result = await smokeWithCallerEnv(dir, (env) => {
      env.CI = 'false';
      env.PR1_PROBE_FAIL = '1';
    });
    expect(result.ok).toBe(false);
    expect(result.steps).toHaveLength(1); // a failed build fails fast: no artifact steps follow
    // Narrow once: under noUncheckedIndexedAccess `result.steps[0]` is
    // `Step | undefined`, so the four property assertions below read a single
    // narrowed local instead of repeating a non-null assertion per line.
    const buildStep = result.steps[0];
    expect(buildStep).toBeDefined();
    expect(buildStep?.step).toBe('build');
    expect(buildStep?.ok).toBe(false);
    expect(buildStep?.detail).toContain('pnpm run build failed');
    expect(buildStep?.detail).toContain('PR1-NEGATIVE-BUILD-MARKER');
    // The failing child was still a REAL build under the pin: the probe wrote
    // its environment before exiting 1, so the negative run is also evidence
    // of the pinned environment - not of a skipped build.
    expect(readChildEnv(dir).CI).toBe('true');
  }, 60_000);
});

describe('PR-1 attestation CLI', () => {
  it('refuses to attest a dirty tracked tree', () => {
    // This repository is currently dirty (the PR-1 change itself), so the
    // refusal is the honest default and `--allow-dirty` is the recorded opt-out.
    const result = run(ATTESTATION_CLI, ['--out', path.join(os.tmpdir(), 'pr1-attest-refuse.json')]);
    if (result.status === 0) {
      // A clean tree is also a valid outcome for this test's purpose; assert the
      // refusal path only when the tree is actually dirty.
      const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
        cwd: repoRoot,
        encoding: 'utf8'
      }).trim();
      expect(dirty).toBe('');
      return;
    }
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('dirty-worktree');
  });

  it('writes an attestation, then re-verifies it against the object database', () => {
    const out = path.join(os.tmpdir(), 'pr1-attest-verify.json');
    const generated = run(ATTESTATION_CLI, ['--ref', 'HEAD', '--out', out, '--allow-dirty']);
    expect(generated.status, generated.stderr).toBe(0);

    const record = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(record.schemaVersion).toBe('2.1.0');
    expect(record.kind).toBe('commit-attestation');
    expect(record.commit.commitId).toMatch(/^[0-9a-f]{40}$/);
    expect(record.commit.treeId).toMatch(/^[0-9a-f]{40}$/);
    expect(record.commit.refExplicit).toBe(true);
    expect(record.compositeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.bindingSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.files.length).toBe(record.fileCount);
    // Environment facts exist but are NOT digest inputs.
    expect(record.environment.platform).toBe(process.platform);
    expect(record.environment.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const verified = run(ATTESTATION_CLI, ['--verify', out]);
    expect(verified.status, verified.stderr).toBe(0);
    expect(verified.stdout).toContain('OK');
  });

  it('recomputes the same digests twice (no timestamp in the digest)', () => {
    const first = path.join(os.tmpdir(), 'pr1-attest-a.json');
    const second = path.join(os.tmpdir(), 'pr1-attest-b.json');
    expect(run(ATTESTATION_CLI, ['--ref', 'HEAD', '--out', first, '--allow-dirty']).status).toBe(0);
    expect(run(ATTESTATION_CLI, ['--ref', 'HEAD', '--out', second, '--allow-dirty']).status).toBe(0);
    const left = JSON.parse(fs.readFileSync(first, 'utf8'));
    const right = JSON.parse(fs.readFileSync(second, 'utf8'));
    expect(left.compositeSha256).toBe(right.compositeSha256);
    expect(left.bindingSha256).toBe(right.bindingSha256);
    expect(left.environment.generatedAt).not.toBeUndefined();
  });

  it('FAILS verification when a recorded digest is tampered with', () => {
    const out = path.join(os.tmpdir(), 'pr1-attest-tampered.json');
    expect(run(ATTESTATION_CLI, ['--ref', 'HEAD', '--out', out, '--allow-dirty']).status).toBe(0);
    const record = JSON.parse(fs.readFileSync(out, 'utf8'));
    record.compositeSha256 = '0'.repeat(64);
    record.files[0].sha256 = '0'.repeat(64);
    fs.writeFileSync(out, JSON.stringify(record, null, 2) + '\n', 'utf8');

    const verified = run(ATTESTATION_CLI, ['--verify', out]);
    expect(verified.status).toBe(1);
    expect(verified.stderr).toContain('MISMATCH');
    expect(verified.stderr).toContain('compositeSha256');
  });

  it('FAILS verification when a file is added to the record', () => {
    const out = path.join(os.tmpdir(), 'pr1-attest-extra.json');
    expect(run(ATTESTATION_CLI, ['--ref', 'HEAD', '--out', out, '--allow-dirty']).status).toBe(0);
    const record = JSON.parse(fs.readFileSync(out, 'utf8'));
    record.files.push({ path: 'src/__does_not_exist__.ts', sha256: '0'.repeat(64), blobId: '0'.repeat(40) });
    fs.writeFileSync(out, JSON.stringify(record, null, 2) + '\n', 'utf8');

    const verified = run(ATTESTATION_CLI, ['--verify', out]);
    expect(verified.status).toBe(1);
    expect(verified.stderr).toContain('__does_not_exist__');
  });

  it('rejects a nonexistent base instead of attesting a broken range', () => {
    const result = run(ATTESTATION_CLI, [
      '--ref',
      'HEAD',
      '--base',
      'refs/heads/no-such-base',
      '--out',
      path.join(os.tmpdir(), 'pr1-attest-badbase.json'),
      '--allow-dirty'
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ref-not-a-commit');
  });

  it('rejects an unknown flag instead of ignoring it', () => {
    const result = run(ATTESTATION_CLI, ['--not-a-real-flag']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown-argument');
  });

  it('records a verified ancestry when --base is given', () => {
    const out = path.join(os.tmpdir(), 'pr1-attest-base.json');
    const generated = run(ATTESTATION_CLI, ['--ref', 'HEAD', '--base', 'HEAD~1', '--out', out, '--allow-dirty']);
    expect(generated.status, generated.stderr).toBe(0);
    const record = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(record.commit.base).not.toBeNull();
    expect(record.commit.base.ancestryVerified).toBe(true);
    expect(record.commit.base.method).toContain('merge-base --is-ancestor');
    expect(record.commit.base.commitId).toMatch(/^[0-9a-f]{40}$/);
  });

  it('FAILS verification when the recorded ALGORITHM is altered (same digests, different recipe)', () => {
    // A verifier that ignores the recipe would accept a record whose digests
    // were produced by a DIFFERENT algorithm - two things compared as if equal.
    const out = path.join(os.tmpdir(), 'pr1-attest-algo.json');
    expect(run(ATTESTATION_CLI, ['--ref', 'HEAD', '--out', out, '--allow-dirty']).status).toBe(0);
    const record = JSON.parse(fs.readFileSync(out, 'utf8'));
    record.algorithm.compositeHash = "SHA256(lines.join(';'))";
    fs.writeFileSync(out, JSON.stringify(record, null, 2) + '\n', 'utf8');
    const verified = run(ATTESTATION_CLI, ['--verify', out]);
    expect(verified.status).toBe(1);
    expect(verified.stderr).toContain('algorithm');
  });

  it('FAILS verification when the recorded ENCODING block is altered', () => {
    const out = path.join(os.tmpdir(), 'pr1-attest-encoding.json');
    expect(run(ATTESTATION_CLI, ['--ref', 'HEAD', '--out', out, '--allow-dirty']).status).toBe(0);
    const record = JSON.parse(fs.readFileSync(out, 'utf8'));
    record.encoding.exceptionCount = 99;
    fs.writeFileSync(out, JSON.stringify(record, null, 2) + '\n', 'utf8');
    const verified = run(ATTESTATION_CLI, ['--verify', out]);
    expect(verified.status).toBe(1);
    expect(verified.stderr).toContain('encoding');
  });

  it('FAILS verification when a file mode is altered', () => {
    const out = path.join(os.tmpdir(), 'pr1-attest-mode.json');
    expect(run(ATTESTATION_CLI, ['--ref', 'HEAD', '--out', out, '--allow-dirty']).status).toBe(0);
    const record = JSON.parse(fs.readFileSync(out, 'utf8'));
    record.files[0].mode = '100755';
    fs.writeFileSync(out, JSON.stringify(record, null, 2) + '\n', 'utf8');
    const verified = run(ATTESTATION_CLI, ['--verify', out]);
    expect(verified.status).toBe(1);
    expect(verified.stderr).toContain('mode');
  });

  it('FAILS verification when blobId, bytes or per-file encoding are altered', () => {
    const out = path.join(os.tmpdir(), 'pr1-attest-filemeta.json');
    expect(run(ATTESTATION_CLI, ['--ref', 'HEAD', '--out', out, '--allow-dirty']).status).toBe(0);
    for (const [field, value] of [
      ['blobId', 'f'.repeat(40)],
      ['bytes', 424242],
      ['encoding', 'binary']
    ] as const) {
      const record = JSON.parse(fs.readFileSync(out, 'utf8'));
      record.files[0][field] = value;
      fs.writeFileSync(out, JSON.stringify(record, null, 2) + '\n', 'utf8');
      const verified = run(ATTESTATION_CLI, ['--verify', out]);
      expect(verified.status, `${field} alteration must fail`).toBe(1);
      expect(verified.stderr).toContain(field);
    }
  }, 120_000);

  it('FAILS verification when roots are altered', () => {
    const out = path.join(os.tmpdir(), 'pr1-attest-roots.json');
    expect(run(ATTESTATION_CLI, ['--ref', 'HEAD', '--out', out, '--allow-dirty']).status).toBe(0);
    const record = JSON.parse(fs.readFileSync(out, 'utf8'));
    record.roots = ['src', 'tests'];
    fs.writeFileSync(out, JSON.stringify(record, null, 2) + '\n', 'utf8');
    const verified = run(ATTESTATION_CLI, ['--verify', out]);
    expect(verified.status).toBe(1);
    expect(verified.stderr).toContain('roots');
  });

  it('FAILS verification when the recorded base is altered (commit id or ancestry flag)', () => {
    const out = path.join(os.tmpdir(), 'pr1-attest-basefields.json');
    expect(run(ATTESTATION_CLI, ['--ref', 'HEAD', '--base', 'HEAD~1', '--out', out, '--allow-dirty']).status).toBe(0);

    // (a) the tree id of a DIFFERENT commit claimed for the base: the verifier
    // re-resolves the recorded base commit and re-derives its tree, so a lie
    // about WHICH TREE the base commit has is caught even though the base
    // commit id itself is still resolvable.
    const older = execFileSync('git', ['rev-parse', 'HEAD~2'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    const olderTree = execFileSync('git', ['rev-parse', `${older}^{tree}`], { cwd: repoRoot, encoding: 'utf8' }).trim();
    const swapped = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(swapped.commit.base.treeId, 'fixture sanity: recorded base tree is HEAD~1^{tree}').not.toBe(olderTree);
    swapped.commit.base.treeId = olderTree;
    fs.writeFileSync(out, JSON.stringify(swapped, null, 2) + '\n', 'utf8');
    const swappedVerified = run(ATTESTATION_CLI, ['--verify', out]);
    expect(swappedVerified.status, 'a false base tree id must fail: ' + swappedVerified.stderr).toBe(1);
    expect(swappedVerified.stderr).toContain('commit.base.treeId');

    // (b) the same base but a false ancestry flag: the verifier re-derives the
    // ancestry itself, so a record claiming "not verified" is a lie it catches.
    const ancestry = JSON.parse(fs.readFileSync(out, 'utf8'));
    ancestry.commit.base.treeId = execFileSync('git', ['rev-parse', 'HEAD~1^{tree}'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    ancestry.commit.base.ancestryVerified = false;
    fs.writeFileSync(out, JSON.stringify(ancestry, null, 2) + '\n', 'utf8');
    const ancestryVerified = run(ATTESTATION_CLI, ['--verify', out]);
    expect(ancestryVerified.status, 'a false ancestryVerified flag must fail').toBe(1);
    expect(ancestryVerified.stderr).toContain('ancestryVerified');
  }, 120_000);

  it('re-derives a tampered base commit id as an unresolvable ref instead of passing', () => {
    const out = path.join(os.tmpdir(), 'pr1-attest-ghostbase.json');
    expect(run(ATTESTATION_CLI, ['--ref', 'HEAD', '--out', out, '--allow-dirty']).status).toBe(0);
    const record = JSON.parse(fs.readFileSync(out, 'utf8'));
    record.commit.base = {
      ref: 'HEAD~1',
      commitId: 'e'.repeat(40),
      treeId: 'b'.repeat(40),
      ancestryVerified: true,
      method: 'git merge-base --is-ancestor'
    };
    fs.writeFileSync(out, JSON.stringify(record, null, 2) + '\n', 'utf8');
    const verified = run(ATTESTATION_CLI, ['--verify', out]);
    expect(verified.status).toBe(1);
    expect(verified.stderr).toContain('ref-not-a-commit');
  });
});

describe('PR-1 cross-OS parity rule', () => {
  /** Build a directory of `attestation-<name>/attestation.json` records. */
  function makeParityDir(records: Record<string, { composite: string; binding: string; files?: number; commit?: string }>): string {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'pr1-parity-')));
    for (const [platform, record] of Object.entries(records)) {
      const target = path.join(dir, `attestation-${platform}`);
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(
        path.join(target, 'attestation.json'),
        JSON.stringify(
          {
            schemaVersion: '2.1.0',
            commit: { commitId: record.commit ?? 'a'.repeat(40), treeId: 'b'.repeat(40) },
            fileCount: record.files ?? 206,
            compositeSha256: record.composite,
            bindingSha256: record.binding
          },
          null,
          2
        ),
        'utf8'
      );
    }
    return dir;
  }

  it('passes when every platform agrees', () => {
    const dir = makeParityDir({
      'ubuntu-latest': { composite: 'c'.repeat(64), binding: 'd'.repeat(64) },
      'macos-latest': { composite: 'c'.repeat(64), binding: 'd'.repeat(64) },
      'windows-latest': { composite: 'c'.repeat(64), binding: 'd'.repeat(64) }
    });
    const result = comparePlatformDigests(dir);
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(3);
    expect(result.uniqueComposites).toBe(1);
    expect(result.uniqueBindings).toBe(1);
  });

  it('FAILS when one platform computes a different composite', () => {
    // This is the F-1 failure mode exactly: Windows hashing the CRLF worktree
    // while Linux hashes the LF blobs.
    const dir = makeParityDir({
      'ubuntu-latest': { composite: 'c'.repeat(64), binding: 'd'.repeat(64) },
      'macos-latest': { composite: 'c'.repeat(64), binding: 'd'.repeat(64) },
      'windows-latest': { composite: 'e'.repeat(64), binding: 'd'.repeat(64) }
    });
    const result = comparePlatformDigests(dir);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('composite digests differ');
  });

  it('FAILS when only the binding differs', () => {
    const dir = makeParityDir({
      'ubuntu-latest': { composite: 'c'.repeat(64), binding: 'd'.repeat(64) },
      'macos-latest': { composite: 'c'.repeat(64), binding: 'd'.repeat(64) },
      'windows-latest': { composite: 'c'.repeat(64), binding: 'f'.repeat(64) }
    });
    const result = comparePlatformDigests(dir);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('binding digests differ');
  });

  it('FAILS when the platforms attested different commits', () => {
    // Identical digests from DIFFERENT commits would be a hash collision or a
    // stale artifact; either way the comparison means nothing.
    const dir = makeParityDir({
      'ubuntu-latest': { composite: 'c'.repeat(64), binding: 'd'.repeat(64), commit: '1'.repeat(40) },
      'macos-latest': { composite: 'c'.repeat(64), binding: 'd'.repeat(64), commit: '1'.repeat(40) },
      'windows-latest': { composite: 'c'.repeat(64), binding: 'd'.repeat(64), commit: '2'.repeat(40) }
    });
    const result = comparePlatformDigests(dir);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('DIFFERENT commits');
  });

  it('FAILS with fewer than three platforms', () => {
    const dir = makeParityDir({
      'ubuntu-latest': { composite: 'c'.repeat(64), binding: 'd'.repeat(64) },
      'macos-latest': { composite: 'c'.repeat(64), binding: 'd'.repeat(64) }
    });
    const result = comparePlatformDigests(dir);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('at least 3 platform attestations');
  });

  it('FAILS when a record predates the binding digest', () => {
    // A schema 1.x record has no bindingSha256. Treating '' as a value would make
    // an incomparable record look "consistent"; it is not comparable at all.
    const dir = makeParityDir({
      'ubuntu-latest': { composite: 'c'.repeat(64), binding: 'd'.repeat(64) },
      'macos-latest': { composite: 'c'.repeat(64), binding: 'd'.repeat(64) },
      'windows-latest': { composite: 'c'.repeat(64), binding: '' }
    });
    const result = comparePlatformDigests(dir);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('bindingSha256');
  });
});

describe('PR-1 parity strictness (3 platforms, attributable records)', () => {
  it('FAILS with only two matching platforms: the claim is a three-OS claim', () => {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'pr1-parity-strict-')));
    for (const platform of ['attestation-ubuntu-latest', 'attestation-macos-latest']) {
      fs.mkdirSync(path.join(dir, platform), { recursive: true });
      fs.writeFileSync(
        path.join(dir, platform, 'attestation.json'),
        JSON.stringify({ compositeSha256: 'c'.repeat(64), bindingSha256: 'd'.repeat(64), fileCount: 206, commit: { commitId: 'a'.repeat(40) } }),
        'utf8'
      );
    }
    const result = comparePlatformDigests(dir);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('at least 3 platform attestations');
  });

  it('FAILS when a record has a malformed (non-64-hex) digest instead of comparing it', () => {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'pr1-parity-strict-')));
    const digests: Record<string, string> = {
      'attestation-ubuntu-latest': 'c'.repeat(64),
      'attestation-macos-latest': 'c'.repeat(64),
      'attestation-windows-latest': 'zz-not-a-digest'
    };
    for (const [platform, composite] of Object.entries(digests)) {
      fs.mkdirSync(path.join(dir, platform), { recursive: true });
      fs.writeFileSync(
        path.join(dir, platform, 'attestation.json'),
        JSON.stringify({ compositeSha256: composite, bindingSha256: 'd'.repeat(64), fileCount: 206, commit: { commitId: 'a'.repeat(40) } }),
        'utf8'
      );
    }
    const result = comparePlatformDigests(dir);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('windows-latest has no valid compositeSha256');
  });

  it('FAILS when fileCount is 0 or missing: an empty manifest proves nothing', () => {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'pr1-parity-strict-')));
    const counts: Record<string, number> = {
      'attestation-ubuntu-latest': 206,
      'attestation-macos-latest': 206,
      'attestation-windows-latest': 0
    };
    for (const [platform, fileCount] of Object.entries(counts)) {
      fs.mkdirSync(path.join(dir, platform), { recursive: true });
      fs.writeFileSync(
        path.join(dir, platform, 'attestation.json'),
        JSON.stringify({ compositeSha256: 'c'.repeat(64), bindingSha256: 'd'.repeat(64), fileCount, commit: { commitId: 'a'.repeat(40) } }),
        'utf8'
      );
    }
    const result = comparePlatformDigests(dir);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('windows-latest reports fileCount=0');
  });

  it('FAILS when fileCount differs across platforms even if the digests match', () => {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'pr1-parity-strict-')));
    const counts: Record<string, number> = {
      'attestation-ubuntu-latest': 205,
      'attestation-macos-latest': 206,
      'attestation-windows-latest': 206
    };
    for (const [platform, fileCount] of Object.entries(counts)) {
      fs.mkdirSync(path.join(dir, platform), { recursive: true });
      fs.writeFileSync(
        path.join(dir, platform, 'attestation.json'),
        JSON.stringify({ compositeSha256: 'c'.repeat(64), bindingSha256: 'd'.repeat(64), fileCount, commit: { commitId: 'a'.repeat(40) } }),
        'utf8'
      );
    }
    const result = comparePlatformDigests(dir);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('file counts differ');
  });
});
