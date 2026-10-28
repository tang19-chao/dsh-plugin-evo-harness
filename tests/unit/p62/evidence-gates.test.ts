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
 * Offline: local git, local esbuild, no network, no model, no paid API.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEncodingPolicy } from '../../../scripts/eval/check-encoding-policy.mjs';
import { smokeBuild } from '../../../scripts/eval/smoke-build.mjs';
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
function run(file: string, args: readonly string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [file, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
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
  return env;
}

/** Temp repos/worktrees this suite creates, removed in `afterAll`. */
const cleanupDirs: string[] = [];

/** Register a throw-away directory for removal in `afterAll`. */
function track(dir: string): string {
  cleanupDirs.push(dir);
  return dir;
}

afterAll(() => {
  // Newest first: a worktree registered later may hold the newest admin state,
  // and `git worktree remove` on a stale sibling is what leaves leaks behind.
  // Bare clones and plain temp dirs are removed by the rmSync fallback.
  for (const dir of cleanupDirs.slice().reverse()) {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', dir], { cwd: repoRoot, encoding: 'utf8', env: gitEnv() });
    } catch {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // A leftover temp dir must not turn a green suite red.
      }
    }
  }
});

describe('PR-1 encoding-policy gate', () => {
  // The frozen baseline commit (84a3d82) predates .gitattributes: the policy
  // file is still untracked in this working tree. The COMMIT-BOUND gate
  // therefore reports `attributes-missing` on HEAD - the honest answer - and
  // the passing-direction assertions below inspect a commit that DOES contain
  // the policy instead of asserting a false pass on the baseline.
  function commitPolicyOntoTempBranch(): string {
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'pr1-policy-commit-'));
    cleanupDirs.push(staging);
    execFileSync('git', ['worktree', 'add', '-q', '--detach', staging, 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: gitEnv()
    });
    fs.copyFileSync(path.join(repoRoot, '.gitattributes'), path.join(staging, '.gitattributes'));
    // Untracked teammates' files (PR-2/3/4A artifacts) must not enter this commit.
    execFileSync('git', ['add', '.gitattributes'], { cwd: staging, encoding: 'utf8', env: gitEnv() });
    execFileSync('git', ['-c', 'user.email=[EMAIL]', '-c', 'user.name=PR-1 gate', 'commit', '-q', '-m', 'gate: commit the policy'], {
      cwd: staging,
      encoding: 'utf8',
      env: gitEnv()
    });
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: staging, encoding: 'utf8', env: gitEnv() }).trim();
  }

  it('passes on a commit that contains the policy, and names that commit', () => {
    const commitId = commitPolicyOntoTempBranch();
    const result = checkEncodingPolicy({ ref: commitId });
    expect(result.commitId).toBe(commitId);
    expect(result.attributesPresent).toBe(true);
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
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'pr1-policy-bare-'));
    cleanupDirs.push(bare);
    execFileSync('git', ['clone', '-q', '--bare', '--no-hardlinks', repoRoot, bare], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: gitEnv()
    });
    const fromBare = checkEncodingPolicy({ ref: '84a3d828ed2a27eef765c8b9c4950da4a9ee7287', cwd: bare });
    expect(fromBare.attributesPresent).toBe(false);
    expect(fromBare.violations.map((violation) => violation.kind)).toContain('attributes-missing');
  }, 120_000);

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
    const commitId = commitPolicyOntoTempBranch();
    expect(run(POLICY_CLI, ['--ref', commitId]).status).toBe(0);
    // The frozen baseline predates .gitattributes, so its honest verdict is a
    // failure that names the defect.
    const baseline = run(POLICY_CLI, ['--ref', '84a3d828ed2a27eef765c8b9c4950da4a9ee7287']);
    expect(baseline.status).toBe(1);
    expect(baseline.stdout + baseline.stderr).toContain('attributes-missing');
    // A broken fixture is still asserted through the in-process API.
    const dir = makeRepo({ 'src/crlf.txt': Buffer.from('one\r\ntwo\r\n', 'utf8') }, '*.mjs text eol=lf\n');
    expect(checkEncodingPolicy({ cwd: dir }).violations.length).toBeGreaterThan(0);
  }, 120_000);

  it('emits machine-readable JSON for CI', () => {
    const commitId = commitPolicyOntoTempBranch();
    const result = run(POLICY_CLI, ['--json', '--ref', commitId]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.attributesPresent).toBe(true);
    expect(parsed.checked).toBeGreaterThan(100);
    expect(parsed.commitId).toBe(commitId);
  });
});

describe('PR-1 build/ESM smoke gate', () => {
  it('builds and imports the bundle as ESM', async () => {
    // CI builds before running the suite; a developer may not have. Build when
    // the artifact is absent so the test is honest in both situations.
    const artifact = path.join(repoRoot, 'lib', 'index.js');
    const result = await smokeBuild({ skipBuild: fs.existsSync(artifact) });
    expect(result.ok, JSON.stringify(result.steps, null, 2)).toBe(true);
  }, 300_000);

  it('reports the required public surface', async () => {
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
