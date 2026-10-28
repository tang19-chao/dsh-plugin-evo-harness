/**
 * PR-1: commit-object evidence and cross-platform fingerprinting.
 *
 * These tests pin the properties that make an attestation reproducible. They
 * exist because the pre-PR-1 attestation hashed the WORKING TREE, which is CRLF
 * on a `core.autocrlf=true` checkout and LF elsewhere — so the same commit
 * produced two different digests. ADR 0003's appendix is the recorded casualty
 * (`work/t1-baseline-audit.md` §5 F-1).
 *
 * The rules under test (PR-1):
 *   1. commit object authority   - digests anchor to `<ref>^{commit}` + `<commit>^{tree}`
 *   2. raw blob bytes            - content via `git cat-file`, never `fs`
 *   3. explicit ref + base       - `--base` is ancestry-verified
 *   4. no silent worktree fallback - failures throw, never degrade to disk
 *   5. core vs environment split - environment facts never enter the digest
 *   6. encoding policy          - non-LF blobs need an explicit `-text`
 *   7. re-verifiable            - a recorded attestation can be re-checked
 *
 * The tests that need a *misbehaving* repository build one in a temp directory:
 * a gate asserted only on a clean tree is only ever exercised in the direction
 * that passes.
 *
 * All tests are offline: local git object database only, no network, no model.
 */
import { describe, expect, it, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GitEvidenceError,
  assertAncestor,
  buildCanonicalManifest,
  classifyBytes,
  commitTreeId,
  listTreeBlobs,
  readAttributes,
  readBlobBytes,
  readBlobsBatch,
  resolveCommit,
  sha256Bytes,
  trackedWorktreeChanges
} from '../../../scripts/eval/lib/git-objects.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

/** Temp repositories created by this suite, removed in `afterAll`. */
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A leftover temp dir must not turn a green suite red.
    }
  }
});

/** A scrubbed git environment, so an ambient GIT_DIR cannot redirect evidence. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

/** Run git in `cwd`, returning stdout as a string. */
function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args.slice(), { cwd, encoding: 'utf8', env: gitEnv() }).trim();
}

/**
 * Build a throw-away repository.
 *
 * `files` maps a POSIX path to raw bytes, so a fixture can carry CRLF, a BOM or
 * NUL bytes without depending on how this checkout stores them.
 */
function makeRepo(files: Record<string, Buffer>, attributes?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr1-evidence-'));
  tempDirs.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'pr1@example.invalid']);
  git(dir, ['config', 'user.name', 'PR-1 fixture']);
  // Disable conversion so the committed bytes are exactly what the fixture says.
  git(dir, ['config', 'core.autocrlf', 'false']);
  if (attributes !== undefined) {
    fs.writeFileSync(path.join(dir, '.gitattributes'), attributes, 'utf8');
  }
  for (const [relative, bytes] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'fixture']);
  return dir;
}

function head() {
  return resolveCommit('HEAD', repoRoot);
}

function fileEntry(entryPath: string) {
  const entry = listTreeBlobs(head(), repoRoot).find((candidate) => candidate.path === entryPath);
  if (entry === undefined) {
    throw new Error(`test fixture file not found in tree: ${entryPath}`);
  }
  return entry;
}

describe('PR-1 §1: commit object authority', () => {
  it('resolves a ref to a full 40-hex commit id', () => {
    const commit = head();
    expect(commit.commitId).toMatch(/^[0-9a-f]{40}$/);
    expect(commit.ref).toBe('HEAD');
  });

  it('peels a ref to the commit even when it could name a tree', () => {
    expect(head().commitId).toBe(git(repoRoot, ['rev-parse', 'HEAD']));
  });

  it('records the root tree id, matching git rev-parse <commit>^{tree}', () => {
    const commit = head();
    expect(commit.treeId).toMatch(/^[0-9a-f]{40}$/);
    expect(commit.treeId).toBe(git(repoRoot, ['rev-parse', `${commit.commitId}^{tree}`]));
    expect(commitTreeId(commit.commitId, repoRoot)).toBe(commit.treeId);
  });

  it('rejects a tree-ish ref instead of silently accepting it', () => {
    try {
      resolveCommit('HEAD:src', repoRoot);
      throw new Error('expected resolveCommit to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(GitEvidenceError);
      expect((error as GitEvidenceError).code).toBe('ref-not-a-commit');
    }
  });

  it('rejects an empty ref rather than guessing a revision', () => {
    try {
      resolveCommit('', repoRoot);
      throw new Error('expected resolveCommit to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(GitEvidenceError);
      expect((error as GitEvidenceError).code).toBe('ref-missing');
    }
  });

  it('rejects a nonexistent ref', () => {
    try {
      resolveCommit('refs/heads/this-branch-does-not-exist', repoRoot);
      throw new Error('expected resolveCommit to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(GitEvidenceError);
      expect((error as GitEvidenceError).code).toBe('ref-not-a-commit');
    }
  });

  it('rejects a non-commit id passed to commitTreeId', () => {
    expect(() => commitTreeId('not-a-commit', repoRoot)).toThrow(GitEvidenceError);
  });
});

describe('PR-1 §2: raw blob bytes, never the worktree', () => {
  it('reads content from the object database with no CR bytes', () => {
    // The object database is LF-normalised regardless of `core.autocrlf`.
    const entry = fileEntry('src/index.ts');
    const bytes = readBlobBytes(entry.blobId, repoRoot);
    expect(bytes.filter((byte) => byte === 0x0d)).toHaveLength(0);
  });

  it('agrees with git rev-parse on the blob id for a path', () => {
    const entry = fileEntry('src/index.ts');
    expect(entry.blobId).toBe(git(repoRoot, ['rev-parse', 'HEAD:src/index.ts']));
  });

  it('hashes exactly the blob bytes', () => {
    const entry = fileEntry('src/index.ts');
    const bytes = readBlobBytes(entry.blobId, repoRoot);
    expect(sha256Bytes(bytes)).toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
  });

  it('batch reads agree with single reads', () => {
    const entries = listTreeBlobs(head(), repoRoot, ['src']).slice(0, 8);
    const batched = readBlobsBatch(
      entries.map((entry) => entry.blobId),
      repoRoot
    );
    for (const entry of entries) {
      expect(batched.get(entry.blobId)).toEqual(readBlobBytes(entry.blobId, repoRoot));
    }
  });

  it('would differ from a worktree hash when the policy converts line endings', () => {
    // This is the regression PR-1 exists to prevent: a checkout that converts
    // line endings produces a different digest from the committed blob.
    //
    // The divergence is constructed HERE (`*.log text eol=crlf` makes git write
    // CRLF into the worktree while the blob stays LF) instead of being observed
    // on this repository's own checkout. The old version of this test only ran
    // when the host had `core.autocrlf=true` AND the file was not normalised -
    // and since `.gitattributes` now pins `*.ts` to `eol=lf`, the interesting
    // branch became unreachable, i.e. the test silently stopped testing the
    // defect on the very machine that used to exhibit it. A fixture that makes
    // the bytes differ by construction is honest on every platform.
    const dir = makeRepo({ 'src/a.log': Buffer.from('one\r\ntwo\r\n', 'utf8') }, '*.log text eol=crlf\n');
    // Force a fresh checkout: the bytes below are what the POLICY produces, not
    // what happened to be on disk when the fixture was written.
    git(dir, ['rm', '-q', '--cached', '-r', '.']);
    git(dir, ['reset', '-q', '--hard']);

    const commit = resolveCommit('HEAD', dir);
    const entry = listTreeBlobs(commit, dir, ['src']).find((candidate) => candidate.path === 'src/a.log');
    if (entry === undefined) {
      throw new Error('fixture file not found in tree: src/a.log');
    }
    const blobBytes = readBlobBytes(entry.blobId, dir);
    const worktreeBytes = fs.readFileSync(path.join(dir, 'src', 'a.log'));

    // Different on disk ... (2 CRLF pairs in the checkout, none in the blob)
    expect(worktreeBytes.filter((byte) => byte === 0x0d)).toHaveLength(2);
    expect(blobBytes.filter((byte) => byte === 0x0d)).toHaveLength(0);
    expect(worktreeBytes.length).not.toBe(blobBytes.length);

    // ... same digest, because the digest reads the object database. A manifest
    // that hashed the checkout would equal `worktreeSha` instead.
    const manifest = buildCanonicalManifest(commit, dir, ['src']);
    const recorded = manifest.files.find((file) => file.path === 'src/a.log');
    expect(recorded?.sha256).toBe(sha256Bytes(blobBytes));
    expect(recorded?.sha256).not.toBe(sha256Bytes(worktreeBytes));
  });

  it('the committed policy makes this checkout deterministic: an LF-declared file IS the blob', () => {
    // Mirror statement of the fixture above, applied to the real repository: the
    // committed policy says `*.ts text eol=lf`, which makes the checkout of a
    // `.ts` file LF on every host - so here the checkout and the blob must be
    // byte-identical. The earlier revision of the suite could not state either
    // direction: it decided "is the policy committed?" with
    // `git cat-file -e HEAD:.gitattributes === ''`, and that helper THROWS when
    // the path is absent, so its `false` branch was dead code on every machine.
    const commit = head();
    const entry = fileEntry('src/index.ts');
    const blobBytes = readBlobBytes(entry.blobId, repoRoot);

    // The evidence is the blob, always (asserted independently of the checkout).
    const manifest = buildCanonicalManifest(commit, repoRoot, ['src']);
    const recorded = manifest.files.find((file) => file.path === 'src/index.ts');
    expect(recorded?.sha256).toBe(sha256Bytes(blobBytes));

    // The determinism claim is read from the COMMIT, not from host config.
    const attributes = readAttributes(['src/index.ts'], repoRoot, commit.commitId).get('src/index.ts');
    expect(attributes?.text).toBe('set');
    expect(attributes?.eol).toBe('lf');

    // A locally edited copy is a legitimate development state; the policy claim
    // is about a clean checkout. Everything above still holds when it is dirty.
    const dirty = (() => {
      try {
        git(repoRoot, ['diff', '--quiet', 'HEAD', '--', 'src/index.ts']);
        return false;
      } catch {
        return true;
      }
    })();
    if (dirty) {
      return;
    }
    const worktreeBytes = fs.readFileSync(path.join(repoRoot, 'src', 'index.ts'));
    expect(worktreeBytes.filter((byte) => byte === 0x0d)).toHaveLength(0);
    expect(worktreeBytes.equals(blobBytes)).toBe(true);
  });

  it('produces the SAME manifest digest from two independent temp checkouts', () => {
    // The cross-platform claim, proven locally without a second OS: two clones
    // with opposite checkout settings must digest identically, because the
    // digest never reads the checkout.
    const source = makeRepo({
      'src/a.ts': Buffer.from('export const a = 1;\n', 'utf8'),
      'src/b.ts': Buffer.from('export const b = 2;\n', 'utf8')
    });
    const commitId = git(source, ['rev-parse', 'HEAD']);
    const crlfClone = fs.mkdtempSync(path.join(os.tmpdir(), 'pr1-clone-crlf-'));
    const lfClone = fs.mkdtempSync(path.join(os.tmpdir(), 'pr1-clone-lf-'));
    tempDirs.push(crlfClone, lfClone);
    for (const [dir, setting] of [
      [crlfClone, 'true'],
      [lfClone, 'false']
    ] as const) {
      execFileSync('git', ['clone', '-q', '--no-hardlinks', source, '.'], {
        cwd: dir,
        env: gitEnv(),
        encoding: 'utf8'
      });
      git(dir, ['config', 'core.autocrlf', setting]);
      // Force a re-checkout so the worktree bytes actually differ.
      git(dir, ['rm', '-q', '--cached', '-r', '.']);
      git(dir, ['reset', '-q', '--hard']);
    }
    const crlfWorktree = fs.readFileSync(path.join(crlfClone, 'src', 'a.ts'));
    const lfWorktree = fs.readFileSync(path.join(lfClone, 'src', 'a.ts'));
    expect(crlfWorktree.length).not.toBe(lfWorktree.length); // different on disk...
    const crlfManifest = buildCanonicalManifest(resolveCommit(commitId, crlfClone), crlfClone, ['src']);
    const lfManifest = buildCanonicalManifest(resolveCommit(commitId, lfClone), lfClone, ['src']);
    expect(crlfManifest.compositeSha256).toBe(lfManifest.compositeSha256); // ...same digest
    expect(crlfManifest.bindingSha256).toBe(lfManifest.bindingSha256);
  });
});

describe('PR-1 §3: explicit base with ancestry verification', () => {
  it('accepts a commit as its own ancestor', () => {
    expect(() => assertAncestor(head(), head(), repoRoot)).not.toThrow();
  });

  it('accepts the parent commit as an ancestor of HEAD', () => {
    const parent = resolveCommit('HEAD~1', repoRoot);
    expect(() => assertAncestor(parent, head(), repoRoot)).not.toThrow();
  });

  it('rejects a descendant used as a base (reversed direction)', () => {
    const parent = resolveCommit('HEAD~1', repoRoot);
    try {
      assertAncestor(head(), parent, repoRoot);
      throw new Error('expected assertAncestor to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(GitEvidenceError);
      expect((error as GitEvidenceError).code).toBe('not-an-ancestor');
    }
  });

  it('rejects an unrelated branch as a base', () => {
    const dir = makeRepo({ 'a.txt': Buffer.from('one\n', 'utf8') });
    git(dir, ['checkout', '-q', '-b', 'side']);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'side']);
    git(dir, ['checkout', '-q', 'main']);
    fs.writeFileSync(path.join(dir, 'c.txt'), 'three\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'main again']);
    const side = resolveCommit('side', dir);
    const main = resolveCommit('main', dir);
    try {
      assertAncestor(side, main, dir);
      throw new Error('expected assertAncestor to throw for unrelated histories');
    } catch (error) {
      expect(error).toBeInstanceOf(GitEvidenceError);
      expect((error as GitEvidenceError).code).toBe('not-an-ancestor');
    }
  });
});

describe('PR-1 §4: no silent worktree fallback', () => {
  it('rejects a malformed blob id instead of reading the file from disk', () => {
    try {
      readBlobBytes('deadbeef', repoRoot);
      throw new Error('expected readBlobBytes to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(GitEvidenceError);
      expect((error as GitEvidenceError).code).toBe('blob-id-invalid');
    }
  });

  it('throws on a well-formed but absent blob instead of degrading', () => {
    try {
      readBlobBytes('0'.repeat(40), repoRoot);
      throw new Error('expected readBlobBytes to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(GitEvidenceError);
      expect((error as GitEvidenceError).code).toBe('git-command-failed');
    }
  });

  it('reads evidence from the requested repo even when GIT_DIR points elsewhere', () => {
    // The scrub matters: without it, an ambient GIT_DIR would silently answer
    // from a different repository and the evidence would describe the wrong tree.
    const dir = makeRepo({ 'only-here.txt': Buffer.from('unique\n', 'utf8') });
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(repoRoot, '.git');
    try {
      // `[]` means "no root filter" (listTreeBlobs treats an empty list as
      // unfiltered), so the fixture's top-level file is the discriminator.
      const manifest = buildCanonicalManifest(resolveCommit('HEAD', dir), dir, []);
      const paths = manifest.files.map((file) => file.path);
      expect(paths).toContain('only-here.txt');
      expect(paths).not.toContain('src/index.ts');
    } finally {
      if (previous === undefined) {
        delete process.env.GIT_DIR;
      } else {
        process.env.GIT_DIR = previous;
      }
    }
  });

  it('reports tracked worktree changes so callers can refuse to attest', () => {
    const changes = trackedWorktreeChanges(repoRoot);
    expect(Array.isArray(changes)).toBe(true);
    // The suite must not assert a specific count: it runs both on a clean tree
    // (CI) and on a dirty development tree. It asserts the SHAPE, which is what
    // the attestation depends on.
    for (const line of changes) {
      expect(typeof line).toBe('string');
      expect(line.length).toBeGreaterThan(0);
    }
  });
});

describe('PR-1 §5: canonical manifest, core separated from environment', () => {
  it('is deterministic across two builds of the same commit', () => {
    const first = buildCanonicalManifest(head(), repoRoot);
    const second = buildCanonicalManifest(head(), repoRoot);
    expect(first.compositeSha256).toBe(second.compositeSha256);
    expect(first.bindingSha256).toBe(second.bindingSha256);
    expect(first.fileCount).toBe(second.fileCount);
  });

  it('computes the composite from path:sha256 lines only', () => {
    const manifest = buildCanonicalManifest(head(), repoRoot);
    const recomputed = crypto
      .createHash('sha256')
      .update(manifest.files.map((file) => `${file.path}:${file.sha256}`).join('\n'), 'utf8')
      .digest('hex');
    expect(manifest.compositeSha256).toBe(recomputed);
  });

  it('derives the binding digest from commit + tree + composite', () => {
    const manifest = buildCanonicalManifest(head(), repoRoot);
    const recomputed = crypto
      .createHash('sha256')
      .update(
        [`commit ${manifest.commitId}`, `tree ${manifest.treeId}`, `composite ${manifest.compositeSha256}`].join('\n'),
        'utf8'
      )
      .digest('hex');
    expect(manifest.bindingSha256).toBe(recomputed);
    expect(manifest.bindingSha256).not.toBe(manifest.compositeSha256);
  });

  it('separates content identity from commit identity', () => {
    // Two commits with the same content must share a composite and differ in
    // binding. If they did not, the composite would be a commit-metadata hash
    // wearing a content hash's name.
    //
    // The second commit is built with `git commit-tree` on the SAME tree rather
    // than by adding/removing a file and committing twice: that version churned
    // the worktree and was intermittently flaky under parallel workers, and a
    // flaky evidence test is worse than no test - it teaches people to re-run.
    const dir = makeRepo({ 'src/a.ts': Buffer.from('export const a = 1;\n', 'utf8') });
    const first = buildCanonicalManifest(resolveCommit('HEAD', dir), dir, ['src']);
    const treeId = git(dir, ['rev-parse', 'HEAD^{tree}']);
    const parentId = git(dir, ['rev-parse', 'HEAD']);
    const secondCommitId = git(dir, ['commit-tree', treeId, '-p', parentId, '-m', 'same tree, different commit id']);
    git(dir, ['update-ref', 'refs/heads/second', secondCommitId]);
    const second = buildCanonicalManifest(resolveCommit('second', dir), dir, ['src']);
    expect(first.commitId).not.toBe(second.commitId);
    expect(first.treeId).toBe(second.treeId);
    expect(first.compositeSha256).toBe(second.compositeSha256);
    expect(first.bindingSha256).not.toBe(second.bindingSha256);
  });

  it('contains no environment facts in the digest inputs', () => {
    const manifest = buildCanonicalManifest(head(), repoRoot);
    // The manifest carries an `algorithm` description but no timestamp, node
    // version, platform or arch: those live in the caller's environment block.
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain(process.version);
    expect(serialized).not.toContain(`"${process.platform}"`);
    expect(serialized).not.toContain(`"${process.arch}"`);
  });

  it('sorts files ordinally by path', () => {
    const manifest = buildCanonicalManifest(head(), repoRoot);
    const paths = manifest.files.map((file) => file.path);
    expect(paths).toEqual([...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it('enumerates only the declared roots', () => {
    const manifest = buildCanonicalManifest(head(), repoRoot);
    expect(manifest.files.length).toBeGreaterThan(0);
    for (const file of manifest.files) {
      expect(file.path).toMatch(/^(src|tests|scripts)\//);
    }
  });

  it('reports a stable file count for src+tests+scripts', () => {
    const manifest = buildCanonicalManifest(head(), repoRoot);
    expect(manifest.fileCount).toBe(manifest.files.length);
    expect(manifest.fileCount).toBeGreaterThan(100);
  });

  it('records the blob id for every file so the manifest is re-derivable', () => {
    const manifest = buildCanonicalManifest(head(), repoRoot, ['src']);
    for (const file of manifest.files.slice(0, 10)) {
      expect(file.blobId).toBe(git(repoRoot, ['rev-parse', `HEAD:${file.path}`]));
    }
  });
});

describe('PR-1 §6: encoding policy is explicit, not assumed', () => {
  it('classifies LF, CRLF, BOM and binary bytes distinctly', () => {
    expect(classifyBytes(Buffer.from('a\nb\n', 'utf8')).kind).toBe('text-lf');
    expect(classifyBytes(Buffer.from('a\r\nb\r\n', 'utf8')).kind).toBe('text-crlf');
    expect(classifyBytes(Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0a])).kind).toBe('text-bom');
    expect(classifyBytes(Buffer.from([0x61, 0x00, 0x62])).kind).toBe('binary');
    expect(classifyBytes(Buffer.from('a\nb\r\n', 'utf8')).crlf).toBe(1);
    expect(classifyBytes(Buffer.from('a\rb\r\n', 'utf8')).loneCr).toBe(1);
  });

  it('refuses an undeclared CRLF blob instead of digesting a checkout artifact', () => {
    const dir = makeRepo(
      { 'src/crlf.txt': Buffer.from('one\r\ntwo\r\n', 'utf8') },
      '*.mjs text eol=lf\n'
    );
    try {
      buildCanonicalManifest(resolveCommit('HEAD', dir), dir, ['src']);
      throw new Error('expected an encoding-policy-violation');
    } catch (error) {
      expect(error).toBeInstanceOf(GitEvidenceError);
      expect((error as GitEvidenceError).code).toBe('encoding-policy-violation');
    }
  });

  it('refuses an undeclared BOM blob', () => {
    const dir = makeRepo(
      { 'src/bom.ts': Buffer.from([0xef, 0xbb, 0xbf, 0x65, 0x78, 0x70, 0x6f, 0x72, 0x74, 0x0a]) },
      '*.mjs text eol=lf\n'
    );
    try {
      buildCanonicalManifest(resolveCommit('HEAD', dir), dir, ['src']);
      throw new Error('expected an encoding-policy-violation');
    } catch (error) {
      expect(error).toBeInstanceOf(GitEvidenceError);
      expect((error as GitEvidenceError).code).toBe('encoding-policy-violation');
    }
  });

  it('accepts a declared -text exception and records it', () => {
    const dir = makeRepo(
      {
        'src/crlf.txt': Buffer.from('one\r\ntwo\r\n', 'utf8'),
        'src/bom.txt': Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0a]),
        'src/binary.bin': Buffer.from([0x61, 0x00, 0x62])
      },
      'tests/fixtures/encoding/** -text\nsrc/*.txt -text\nsrc/*.bin binary\n'
    );
    const manifest = buildCanonicalManifest(resolveCommit('HEAD', dir), dir, ['src']);
    expect(manifest.encoding.exceptionCount).toBe(3);
    const exceptions = manifest.encoding.exceptions.map((entry) => entry.path).sort();
    expect(exceptions).toEqual(['src/binary.bin', 'src/bom.txt', 'src/crlf.txt']);
    for (const file of manifest.files) {
      expect(file.encodingException).toBe(true);
      expect(file.declaredTextUnset).toBe(true);
    }
  });

  it('fails closed: an escape hatch must be asked for explicitly', () => {
    const dir = makeRepo({ 'src/crlf.txt': Buffer.from('one\r\ntwo\r\n', 'utf8') }, '*.mjs text eol=lf\n');
    const manifest = buildCanonicalManifest(resolveCommit('HEAD', dir), dir, ['src'], {
      allowUndeclaredEncoding: true
    });
    expect(manifest.fileCount).toBe(1);
    expect(manifest.files[0]?.encoding).toBe('text-crlf');
    expect(manifest.files[0]?.encodingException).toBe(false);
  });

  it('the real repository declares no undeclared non-LF blob in the digested roots', () => {
    const manifest = buildCanonicalManifest(head(), repoRoot);
    const undeclared = manifest.files.filter((file) => file.encoding !== 'text-lf' && !file.encodingException);
    expect(undeclared.map((file) => file.path)).toEqual([]);
  });
});

describe('PR-1 §8: the encoding policy is bound to the ATTESTED COMMIT', () => {
  it('resolves attributes from the commit tree, not the working tree', () => {
    // The commit declares the fixture -text; the on-disk copy is then modified
    // (uncommitted) to no longer declare it. The commit-bound answer must not
    // move: what was evidence at generation time stays evidence at review time.
    const dir = makeRepo({ 'src/crlf.txt': Buffer.from('one\r\ntwo\r\n', 'utf8') }, 'src/*.txt -text\n');
    fs.writeFileSync(path.join(dir, '.gitattributes'), '*.md text eol=lf\n', 'utf8');
    const commit = resolveCommit('HEAD', dir);
    const attrs = readAttributes(['src/crlf.txt'], dir, commit.commitId);
    expect(attrs.get('src/crlf.txt')?.text).toBe('unset');
    expect(attrs.get('src/crlf.txt')?.eol).toBe('unspecified');
  });

  it('refuses the worktree-bound (two-argument) attribute read', () => {
    const dir = makeRepo({ 'src/a.ts': Buffer.from('export const a = 1;\n', 'utf8') }, '*.ts text eol=lf\n');
    // The type contract makes the omission a compile error; at runtime the
    // guard below is what stands between a caller and a worktree answer.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const worktreeBound = readAttributes as unknown as (paths: string[], cwd: string) => Map<string, unknown>;
    try {
      worktreeBound(['src/a.ts'], dir);
      throw new Error('expected readAttributes to throw without a commit source');
    } catch (error) {
      expect(error).toBeInstanceOf(GitEvidenceError);
      expect((error as GitEvidenceError).code).toBe('attributes-source-required');
    }
    // A ref string is not enough either: it must be the RESOLVED 40-hex commit.
    try {
      readAttributes(['src/a.ts'], dir, 'HEAD');
      throw new Error('expected readAttributes to throw for a non-resolved source');
    } catch (error) {
      expect(error).toBeInstanceOf(GitEvidenceError);
      expect((error as GitEvidenceError).code).toBe('attributes-source-required');
    }
  });

  it('an UNTRACKED .gitattributes cannot bless an undeclared CRLF blob (no false pass)', () => {
    // The defect class this pins: the first gate version read .gitattributes
    // from disk, so a file the commit does not contain could decide what the
    // commit's evidence says. Here the worktree copy declares the exception;
    // the commit does not. The manifest must still refuse.
    const dir = makeRepo({ 'src/crlf.txt': Buffer.from('one\r\ntwo\r\n', 'utf8') });
    fs.writeFileSync(path.join(dir, '.gitattributes'), 'src/*.txt -text\n', 'utf8');
    const status = git(dir, ['status', '--porcelain']);
    expect(status).toContain('?? .gitattributes'); // really untracked, not committed
    try {
      buildCanonicalManifest(resolveCommit('HEAD', dir), dir, ['src']);
      throw new Error('expected an encoding-policy-violation despite the untracked .gitattributes');
    } catch (error) {
      expect(error).toBeInstanceOf(GitEvidenceError);
      expect((error as GitEvidenceError).code).toBe('encoding-policy-violation');
    }
  });

  it('a committed policy keeps protecting blobs after the on-disk copy is weakened', () => {
    // Mirror image of the false pass: the commit declares the exception, the
    // worktree copy is edited to drop it. The manifest must still accept the
    // blob and still RECORD the exception - policy travels with the commit.
    const dir = makeRepo({ 'src/crlf.txt': Buffer.from('one\r\ntwo\r\n', 'utf8') }, 'src/*.txt -text\n');
    fs.writeFileSync(path.join(dir, '.gitattributes'), '*.md text eol=lf\n', 'utf8');
    const manifest = buildCanonicalManifest(resolveCommit('HEAD', dir), dir, ['src']);
    expect(manifest.encoding.exceptionCount).toBe(1);
    expect(manifest.encoding.exceptions[0]?.path).toBe('src/crlf.txt');
  });

  it('honours the policy of the COMMIT BEING ATTESTED, not of HEAD', () => {
    // Commit 1: an undeclared CRLF fixture (a violation at that commit).
    // Commit 2: the fixture plus the declaring .gitattributes (clean at HEAD).
    const dir = makeRepo({ 'src/crlf.txt': Buffer.from('one\r\ntwo\r\n', 'utf8') });
    fs.writeFileSync(path.join(dir, '.gitattributes'), 'src/*.txt -text\n', 'utf8');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'declare the fixture']);
    const first = resolveCommit('HEAD~1', dir);
    const headCommit = resolveCommit('HEAD', dir);
    expect(() => buildCanonicalManifest(first, dir, ['src'])).toThrow(GitEvidenceError);
    const manifest = buildCanonicalManifest(headCommit, dir, ['src']);
    expect(manifest.encoding.exceptionCount).toBe(1);
  });

  it('the tree fallback parser agrees with `git check-attr --source` on the same commit', () => {
    // The fallback exists for git < 2.40. It must not have its own opinion:
    // on one repository, both paths must give the same answer for every path.
    const dir = makeRepo(
      {
        'src/a.ts': Buffer.from('export const a = 1;\n', 'utf8'),
        'src/keep.bin': Buffer.from([0x61, 0x00, 0x62]),
        'tests/fixtures/encoding/crlf.txt': Buffer.from('x\r\ny\r\n', 'utf8'),
        'tests/fixtures/encoding/nested/deep.txt': Buffer.from('deep\r\n', 'utf8'),
        'docs/readme.md': Buffer.from('# doc\n', 'utf8')
      },
      [
        '# comment line (must be ignored)',
        '*.ts text eol=lf',
        '*.md text eol=lf',
        'src/*.bin binary',
        'tests/fixtures/encoding/** -text',
        ''
      ].join('\n')
    );
    const commit = resolveCommit('HEAD', dir);
    const paths = [
      'src/a.ts',
      'src/keep.bin',
      'tests/fixtures/encoding/crlf.txt',
      'tests/fixtures/encoding/nested/deep.txt',
      'docs/readme.md'
    ];
    const viaGit = readAttributes(paths, dir, commit.commitId);
    const viaFallback = readAttributes(paths, dir, commit.commitId, { forceTreeFallback: true });
    for (const entryPath of paths) {
      expect(viaFallback.get(entryPath), entryPath).toEqual(viaGit.get(entryPath));
    }
    // And the answers are the semantically right ones, not merely self-consistent.
    expect(viaGit.get('tests/fixtures/encoding/crlf.txt')?.text).toBe('unset');
    expect(viaGit.get('src/a.ts')?.text).toBe('set');
    expect(viaGit.get('src/a.ts')?.eol).toBe('lf');
  });

  it('re-checks identically in a bare clone (no worktree, no on-disk policy file)', () => {
    // A third party with only the object database must reach the same verdict:
    // no working tree, therefore no .gitattributes on disk at all, and the
    // attributes still come from the commit.
    const source = makeRepo(
      {
        'src/a.ts': Buffer.from('export const a = 1;\n', 'utf8'),
        'src/crlf.txt': Buffer.from('one\r\ntwo\r\n', 'utf8')
      },
      '*.ts text eol=lf\nsrc/*.txt -text\n'
    );
    const commitId = git(source, ['rev-parse', 'HEAD']);
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'pr1-bare-'));
    tempDirs.push(bare);
    execFileSync('git', ['clone', '-q', '--bare', '--no-hardlinks', source, bare], {
      cwd: source,
      env: gitEnv(),
      encoding: 'utf8'
    });
    expect(fs.existsSync(path.join(bare, '.gitattributes'))).toBe(false); // genuinely no worktree
    const fromSource = buildCanonicalManifest(resolveCommit(commitId, source), source, ['src']);
    const fromBare = buildCanonicalManifest(resolveCommit(commitId, bare), bare, ['src']);
    expect(fromBare.compositeSha256).toBe(fromSource.compositeSha256);
    expect(fromBare.bindingSha256).toBe(fromSource.bindingSha256);
    expect(fromBare.fileCount).toBe(fromSource.fileCount);
    expect(fromBare.encoding.exceptionCount).toBe(1);
    expect(fromBare.files.find((file) => file.path === 'src/crlf.txt')?.encodingException).toBe(true);
  });
});

describe('PR-1 §7: evidence tooling is available and offline', () => {
  it('has a working git binary', () => {
    expect(git(repoRoot, ['--version'])).toMatch(/^git version /);
  });

  it('does not import any network or model module', () => {
    for (const modulePath of [
      'scripts/eval/lib/git-objects.mjs',
      'scripts/eval/lib/negative-result-assertions.mjs',
      'scripts/eval/check-encoding-policy.mjs'
    ]) {
      const source = fs.readFileSync(path.join(repoRoot, modulePath), 'utf8');
      for (const forbidden of ['http://', 'https://', 'node:http', 'node:https', 'node:net', 'fetch(']) {
        expect(source, `${modulePath} must stay offline`).not.toContain(forbidden);
      }
    }
  });

  it('never reads repository content with fs in the evidence core', () => {
    // A regression here is exactly the F-1 defect: the digest silently becomes
    // a function of the checkout. The module must not import `node:fs` and must
    // not CALL any fs read - a mention inside the explanatory header is fine
    // (it documents the defect being fixed), a call is not.
    const source = fs.readFileSync(path.join(repoRoot, 'scripts/eval/lib/git-objects.mjs'), 'utf8');
    const withoutComments = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(withoutComments).not.toContain("'node:fs'");
    expect(withoutComments).not.toContain('"node:fs"');
    expect(withoutComments).not.toContain('readFileSync');
    expect(withoutComments).not.toContain('readFile(');
    expect(withoutComments).not.toContain('createReadStream');
  });

  it('the encoding policy still holds with the worktree .gitattributes removed entirely', () => {
    // Strongest form of commit binding: even with NO .gitattributes on disk
    // (not merely an untracked one), the committed policy still answers, because
    // `check-attr --source=<commit>` / the tree parser never look at the worktree.
    const dir = makeRepo(
      {
        'src/a.ts': Buffer.from('export const a = 1;\n', 'utf8'),
        'src/crlf.txt': Buffer.from('one\r\ntwo\r\n', 'utf8')
      },
      '*.ts text eol=lf\nsrc/*.txt -text\n'
    );
    fs.rmSync(path.join(dir, '.gitattributes'));
    const manifest = buildCanonicalManifest(resolveCommit('HEAD', dir), dir, ['src']);
    expect(manifest.fileCount).toBe(2);
    expect(manifest.encoding.exceptionCount).toBe(1);
    expect(manifest.files.find((file) => file.path === 'src/crlf.txt')?.encodingException).toBe(true);
  });
});
