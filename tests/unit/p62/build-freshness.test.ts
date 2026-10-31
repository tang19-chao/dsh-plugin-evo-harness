/**
 * rev5 P0-5 / A-t9-11..15: build stamp recipe, stale diagnosis, and the
 * prepare/build wiring.
 *
 * The rule under test is content-based freshness, not mtime:
 *
 *   srcTreeSha256 = SHA256(concat("<posix-path>\\0<SHA256(raw bytes)>\\n"))
 *   over every src/**\/*.ts file, sorted ordinally by path.
 *
 * Every transition is exercised in a throw-away repository:
 *   fresh -> edit src -> stale -> rebuild stamp -> fresh
 *   touch mtime only -> still fresh (content, not timestamps)
 *   delete artifact -> stale + artifact absent
 *   replace artifact without rebuilding -> stale (artifact-mismatch)
 *   delete/malform the stamp -> stale (stamp-missing / stamp-invalid)
 *
 * The recipe is also recomputed INDEPENDENTLY in this file, so a change to the
 * implementation that silently changes the digest definition fails here rather
 * than invalidating every recorded stamp unnoticed.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILD_ARTIFACT_PATH,
  BUILD_STAMP_PATH,
  computeBuildStatus,
  computeSrcTreeSha256,
  writeBuildStamp
} from '../../../scripts/build-manifest.mjs';
import { smokeBuild } from '../../../scripts/eval/smoke-build.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const manifestCli = path.join(repoRoot, 'scripts', 'build-manifest.mjs');

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

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

function git(dir: string, args: readonly string[]): string {
  return execFileSync('git', args.slice(), { cwd: dir, encoding: 'utf8', env: gitEnv() }).trim();
}

function sha256(bytes: Buffer | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

interface Fixture {
  dir: string;
  files: Record<string, string>;
}

/** A tiny source tree plus a plausible artifact (no build is run here). */
function makeFixture(options: { git?: boolean } = {}): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-freshness-'));
  tempDirs.push(dir);
  const files: Record<string, string> = {
    'src/index.ts': 'export const index = 1;\n',
    'src/nested/b.ts': 'export const b = 2;\n',
    'src/c.ts': 'export const c = 3;\n',
    'src/ignore.js': 'export const ignored = 0;\n'
  };
  for (const [relative, text] of Object.entries(files)) {
    const absolute = path.join(dir, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, text, 'utf8');
  }
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, BUILD_ARTIFACT_PATH), 'export const built = true;\n', 'utf8');
  if (options.git === true) {
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'rev5@example.invalid']);
    git(dir, ['config', 'user.name', 'rev5 build fixture']);
    git(dir, ['config', 'core.autocrlf', 'false']);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'fixture']);
  }
  return { dir, files };
}

/** Independent oracle for the frozen composite recipe. */
function expectedSrcTreeSha256(dir: string, relativePaths: readonly string[]): string {
  const sorted = [...relativePaths].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const lines = sorted.map((relative) => {
    const bytes = fs.readFileSync(path.join(dir, relative));
    return relative + '\u0000' + sha256(bytes) + '\n';
  });
  return sha256(Buffer.from(lines.join(''), 'utf8'));
}

function statusOf(dir: string) {
  return computeBuildStatus({ cwd: dir });
}

describe('build stamp: the src-tree digest recipe is frozen and independently reproducible', () => {
  it('hashes every src/**/*.ts file, sorted by POSIX path, and nothing else', () => {
    const { dir } = makeFixture();
    const summary = computeSrcTreeSha256({ cwd: dir });
    expect(summary.fileCount).toBe(3);
    expect(summary.files.map((file) => file.path)).toEqual(['src/c.ts', 'src/index.ts', 'src/nested/b.ts']);
    expect(summary.srcTreeSha256).toBe(
      expectedSrcTreeSha256(dir, ['src/index.ts', 'src/nested/b.ts', 'src/c.ts'])
    );
    // A non-TS file under src/ is not part of the file set.
    expect(summary.files.some((file) => file.path === 'src/ignore.js')).toBe(false);
  });

  it('changes when a source byte changes, and only then', () => {
    const { dir } = makeFixture();
    const before = computeSrcTreeSha256({ cwd: dir }).srcTreeSha256;
    fs.appendFileSync(path.join(dir, 'src', 'c.ts'), '// one more line\n', 'utf8');
    const after = computeSrcTreeSha256({ cwd: dir }).srcTreeSha256;
    expect(after).not.toBe(before);
    // Recomputing without changes is stable.
    expect(computeSrcTreeSha256({ cwd: dir }).srcTreeSha256).toBe(after);
  });

  it('includes a new file and a deletion (the file SET is part of the digest)', () => {
    const { dir } = makeFixture();
    const before = computeSrcTreeSha256({ cwd: dir }).srcTreeSha256;
    fs.writeFileSync(path.join(dir, 'src', 'd.ts'), 'export const d = 4;\n', 'utf8');
    const added = computeSrcTreeSha256({ cwd: dir }).srcTreeSha256;
    expect(added).not.toBe(before);
    fs.rmSync(path.join(dir, 'src', 'd.ts'));
    expect(computeSrcTreeSha256({ cwd: dir }).srcTreeSha256).toBe(before);
  });
});

describe('build stamp: commit and artifact evidence', () => {
  it('records the HEAD commit, the artifact sha256/bytes and the src digest', () => {
    const { dir } = makeFixture({ git: true });
    const head = git(dir, ['rev-parse', 'HEAD']);
    const stamp = writeBuildStamp({ cwd: dir });
    const written = JSON.parse(fs.readFileSync(path.join(dir, BUILD_STAMP_PATH), 'utf8'));
    expect(written).toEqual(stamp);
    expect(written.kind).toBe('build-stamp');
    expect(written.srcTreeSha256).toBe(computeSrcTreeSha256({ cwd: dir }).srcTreeSha256);
    expect(written.srcFileCount).toBe(3);
    expect(written.commit).toBe(head);
    expect(written.artifact).toMatchObject({
      path: BUILD_ARTIFACT_PATH,
      bytes: fs.statSync(path.join(dir, BUILD_ARTIFACT_PATH)).size,
      sha256: sha256(fs.readFileSync(path.join(dir, BUILD_ARTIFACT_PATH)))
    });
    expect(written.algorithm.compositeHash).toContain('SHA256');
  });

  it('records commit=null (with the reason) when there is no git repository, instead of failing the build', () => {
    const { dir } = makeFixture();
    const stamp = writeBuildStamp({ cwd: dir });
    expect(stamp.commit).toBeNull();
    expect(stamp.commitError).toContain('HEAD is not resolvable');
  });

  it('reports a HEAD move separately from freshness (the bytes did not change)', () => {
    const { dir } = makeFixture({ git: true });
    writeBuildStamp({ cwd: dir });
    git(dir, ['commit', '-q', '--allow-empty', '-m', 'advance HEAD without touching src']);
    const status = statusOf(dir);
    expect(status.stale).toBe(false);
    expect(status.commit.recorded).not.toBe(status.commit.head);
    expect(status.commit.matches).toBe(false);
  });
});

describe('build freshness: stale transitions are content-based', () => {
  it('reports stale before any stamp exists', () => {
    const { dir } = makeFixture();
    const status = statusOf(dir);
    expect(status.stale).toBe(true);
    expect(status.reasons).toContain('stamp-missing');
    expect(status.artifact).toBe('present');
  });

  it('is fresh after a stamp is written, goes stale on a src edit, and fresh after a rebuild', () => {
    const { dir } = makeFixture();
    writeBuildStamp({ cwd: dir });
    const fresh = statusOf(dir);
    expect(fresh.stale, JSON.stringify(fresh)).toBe(false);
    expect(fresh.reasons).toEqual([]);
    expect(fresh.srcTreeSha256.recorded).toBe(fresh.srcTreeSha256.current);

    fs.appendFileSync(path.join(dir, 'src', 'index.ts'), '// edited after build\n', 'utf8');
    const stale = statusOf(dir);
    expect(stale.stale).toBe(true);
    expect(stale.reasons).toContain('src-tree-mismatch');
    expect(stale.srcTreeSha256.recorded).not.toBe(stale.srcTreeSha256.current);

    writeBuildStamp({ cwd: dir });
    expect(statusOf(dir).stale).toBe(false);
  });

  it('does NOT use mtime: touching a source file leaves the tree fresh', () => {
    const { dir } = makeFixture();
    writeBuildStamp({ cwd: dir });
    const target = path.join(dir, 'src', 'index.ts');
    const now = new Date();
    fs.utimesSync(target, now, new Date(now.getTime() + 60_000));
    expect(statusOf(dir).stale).toBe(false);
  });

  it('reports stale with artifact absent when lib/index.js is missing', () => {
    const { dir } = makeFixture();
    writeBuildStamp({ cwd: dir });
    fs.rmSync(path.join(dir, BUILD_ARTIFACT_PATH));
    const status = statusOf(dir);
    expect(status.stale).toBe(true);
    expect(status.artifact).toBe('absent');
    expect(status.reasons).toContain('artifact-missing');
  });

  it('reports stale artifact-mismatch when the artifact is replaced without a rebuild', () => {
    const { dir } = makeFixture();
    writeBuildStamp({ cwd: dir });
    fs.writeFileSync(path.join(dir, BUILD_ARTIFACT_PATH), 'export const built = false;\n', 'utf8');
    const status = statusOf(dir);
    expect(status.stale).toBe(true);
    expect(status.reasons).toContain('artifact-mismatch');
  });

  it('reports stamp-invalid for a malformed stamp instead of reading it as fresh', () => {
    const { dir } = makeFixture();
    writeBuildStamp({ cwd: dir });
    fs.writeFileSync(path.join(dir, BUILD_STAMP_PATH), '{not json\n', 'utf8');
    const status = statusOf(dir);
    expect(status.stale).toBe(true);
    expect(status.reasons).toContain('stamp-invalid');
  });

  it('the smoke gate refuses a stale artifact under --skip-build', async () => {
    const { dir } = makeFixture();
    writeBuildStamp({ cwd: dir });
    fs.appendFileSync(path.join(dir, 'src', 'index.ts'), '// stale now\n', 'utf8');
    const result = await smokeBuild({ skipBuild: true, cwd: dir });
    expect(result.ok).toBe(false);
    expect(result.stale).toBe(true);
    const freshnessStep = result.steps.find((step) => step.step === 'build-freshness');
    expect(freshnessStep?.ok).toBe(false);
    expect(freshnessStep?.detail).toContain('stale: true');
  });
});

describe('build freshness: CLI surface for CI', () => {
  it('exits 0 and prints stale: false for a fresh tree', () => {
    const { dir } = makeFixture();
    writeBuildStamp({ cwd: dir });
    const result = spawnSync(process.execPath, [manifestCli, '--cwd', dir], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('stale: false');
    expect(result.stdout).toContain('artifact: present');
  });

  it('exits 1 and prints stale: true plus the reason for a changed src tree', () => {
    const { dir } = makeFixture();
    writeBuildStamp({ cwd: dir });
    fs.appendFileSync(path.join(dir, 'src', 'c.ts'), '// drift\n', 'utf8');
    const result = spawnSync(process.execPath, [manifestCli, '--cwd', dir], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('stale: true');
    expect(result.stdout).toContain('src-tree-mismatch');
  });

  it('prints artifact: absent and stale: true when lib/index.js is missing', () => {
    const { dir } = makeFixture();
    writeBuildStamp({ cwd: dir });
    fs.rmSync(path.join(dir, BUILD_ARTIFACT_PATH));
    const result = spawnSync(process.execPath, [manifestCli, '--cwd', dir, '--json'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.artifact).toBe('absent');
    expect(parsed.stale).toBe(true);
    expect(parsed.reasons).toContain('artifact-missing');
    expect(parsed.artifactPath).toBe(BUILD_ARTIFACT_PATH);
  });
});

describe('build wiring: package.json prepare and the canonical build script', () => {
  it('build/prepare/status commands are wired to the shipped scripts', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(pkg.scripts.build).toBe('node scripts/build.mjs');
    expect(pkg.scripts.prepare).toBe('pnpm run build');
    expect(pkg.scripts['build:status']).toContain('scripts/build-manifest.mjs');
    expect(pkg.scripts['check:build-smoke']).toContain('scripts/eval/smoke-build.mjs');
    // The build wrapper and the freshness module both exist and are the ones the
    // commands name (a typo in package.json must fail here, not in CI).
    expect(fs.existsSync(path.join(repoRoot, 'scripts', 'build.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, 'scripts', 'build-manifest.mjs'))).toBe(true);
  });
});
