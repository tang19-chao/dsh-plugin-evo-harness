/**
 * rev5 P0-4 / A-t9-7..9: the clean-tree / test-input gate, both directions.
 *
 * The gate is only useful if it is seen working. Every fixture here builds a
 * throw-away git repository and stages exactly one condition:
 *   - clean                                         -> exit 0
 *   - modified tracked file                         -> exit 1 (tracked-change)
 *   - deleted tracked file                          -> exit 1 (tracked-change)
 *   - unexpected untracked file                     -> exit 1 (untracked-unexpected)
 *   - listed generated artifact (test-results.json,
 *     lib/index.js)                                 -> exit 0 (explicit allowance)
 *   - ignored scratch space (work/)                 -> exit 0 (not in status)
 *   - allowance naming tests/ or src/               -> refused before reading status
 *   - required test input absent from the index     -> exit 1 (required-input-not-tracked)
 *
 * The runner itself is exercised through the CLI (exit codes and named reasons),
 * because CI reads the exit code, not the exported function.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkCleanTree,
  isProtectedPath,
  validateAllowance
} from '../../../scripts/eval/check-clean-tree.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const gateScript = path.join(repoRoot, 'scripts', 'eval', 'check-clean-tree.mjs');

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

/** A committed repository with `tests/` and `src/` content and `work/` ignored. */
function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-tree-'));
  tempDirs.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'rev5@example.invalid']);
  git(dir, ['config', 'user.name', 'rev5 clean-tree fixture']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  fs.mkdirSync(path.join(dir, 'tests', 'unit'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests', 'unit', 'a.test.ts'), 'export const a = 1;\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"fixture"}\n', 'utf8');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'work/\n', 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'fixture']);
  return dir;
}

interface GateRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runGate(dir: string, extraArgs: readonly string[] = []): GateRun {
  const result = spawnSync(process.execPath, [gateScript, '--cwd', dir, ...extraArgs], {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('clean-tree gate: every failure direction is observable', () => {
  it('passes on a clean checkout and names zero changes', () => {
    const dir = makeRepo();
    const result = checkCleanTree({ cwd: dir });
    expect(result.ok, JSON.stringify(result.failures)).toBe(true);
    expect(result.trackedChanges).toEqual([]);
    expect(result.untracked).toEqual([]);
    const run = runGate(dir);
    expect({ status: run.status, stderr: run.stderr }).toMatchObject({ status: 0 });
    expect(run.stdout).toContain('untracked: 0');
    expect(run.stdout).toContain('OK: the checkout is clean');
  });

  it('fails a modified tracked file and names the path', () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'tests', 'unit', 'a.test.ts'), 'export const a = 2;\n', 'utf8');
    const result = checkCleanTree({ cwd: dir });
    expect(result.ok).toBe(false);
    expect(result.failures.map((failure) => failure.code)).toContain('tracked-change');
    expect(result.failures.some((failure) => failure.detail.includes('tests/unit/a.test.ts'))).toBe(true);
    const run = runGate(dir);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('tracked-change');
    expect(run.stderr).toContain('tests/unit/a.test.ts');
  });

  it('fails a deleted tracked file', () => {
    const dir = makeRepo();
    fs.rmSync(path.join(dir, 'src', 'a.ts'));
    const result = checkCleanTree({ cwd: dir });
    expect(result.ok).toBe(false);
    expect(result.failures.map((failure) => failure.code)).toContain('tracked-change');
    expect(result.failures.some((failure) => failure.detail.includes('src/a.ts'))).toBe(true);
  });

  it('fails an unexpected untracked file, including a stray test', () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'tests', 'unit', 'stray.test.ts'), 'export const stray = 1;\n', 'utf8');
    const result = checkCleanTree({ cwd: dir });
    expect(result.ok).toBe(false);
    expect(result.failures.map((failure) => failure.code)).toContain('untracked-unexpected');
    expect(result.failures.some((failure) => failure.detail.includes('tests/unit/stray.test.ts'))).toBe(true);
    const run = runGate(dir);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('untracked-unexpected');
  });

  it('passes listed generated artifacts through the explicit allowance', () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'test-results.json'), '{}\n', 'utf8');
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.writeFileSync(path.join(dir, 'lib', 'index.js'), 'export {};\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'attestation.json'), '{}\n', 'utf8');
    const result = checkCleanTree({ cwd: dir });
    expect(result.ok, JSON.stringify(result.failures)).toBe(true);
    expect(result.allowed.sort()).toEqual(['attestation.json', 'lib/index.js', 'test-results.json']);
    expect(result.unexpected).toEqual([]);
    expect(runGate(dir).status).toBe(0);
  });

  it('does not count ignored scratch space (work/)', () => {
    const dir = makeRepo();
    fs.mkdirSync(path.join(dir, 'work'));
    fs.writeFileSync(path.join(dir, 'work', 'scratch.json'), '{}\n', 'utf8');
    const result = checkCleanTree({ cwd: dir });
    expect(result.ok, JSON.stringify(result.failures)).toBe(true);
    expect(result.untracked).toEqual([]);
  });
});

describe('clean-tree gate: the allowance itself cannot cover source or tests', () => {
  it('classifies protected paths', () => {
    for (const protectedPath of ['package.json', 'src/a.ts', 'tests/unit/a.test.ts', 'scripts/eval/a.mjs']) {
      expect(isProtectedPath(protectedPath)).toBe(true);
    }
    for (const generatedPath of ['test-results.json', 'lib/index.js', 'attestation.json', 'coverage/x.json']) {
      expect(isProtectedPath(generatedPath)).toBe(false);
    }
  });

  it('refuses allowances that name protected content', () => {
    for (const rule of ['src/', 'src/**', 'tests/', 'tests/unit/', 'scripts/**', 'package.json', 'tests/fixtures/x.json']) {
      expect(() => validateAllowance(rule), rule).toThrowError(/protected content|wildcard/);
    }
  });

  it('refuses wildcards that could match package.json or source', () => {
    for (const rule of ['*', '**', '*.json']) {
      expect(() => validateAllowance(rule), rule).toThrowError(/every untracked path|wildcard/);
    }
    // A narrow generated-artifact wildcard is still fine.
    expect(validateAllowance('attestation-*.json')).toMatchObject({ kind: 'glob' });
  });

  it('fails through the CLI when --allow names protected content', () => {
    const dir = makeRepo();
    const run = runGate(dir, ['--allow', 'tests/']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('allow-rule-covers-protected-path');
  });
});

describe('clean-tree gate: required test inputs must be tracked', () => {
  it('passes when the required path has tracked entries', () => {
    const dir = makeRepo();
    const result = checkCleanTree({ cwd: dir, requireTracked: ['tests', 'package.json'] });
    expect(result.ok, JSON.stringify(result.failures)).toBe(true);
    expect(result.requiredInputs).toEqual([
      { path: 'tests', tracked: true },
      { path: 'package.json', tracked: true }
    ]);
  });

  it('fails when a required input is not in the index, and names it', () => {
    const dir = makeRepo();
    const result = checkCleanTree({ cwd: dir, requireTracked: ['tests/fixtures/pr4a/fixture-manifest.json'] });
    expect(result.ok).toBe(false);
    expect(result.failures).toContainEqual(
      expect.objectContaining({ code: 'required-input-not-tracked' })
    );
    const run = runGate(dir, ['--require-tracked', 'tests/fixtures/missing.json']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('required-input-not-tracked');
  });
});

describe('clean-tree gate: machine-readable output surface', () => {
  it('emits JSON with the failure codes and the allowance list', () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 2;\n', 'utf8');
    const run = runGate(dir, ['--json']);
    expect(run.status).toBe(1);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.failures.map((failure: { code: string }) => failure.code)).toContain('tracked-change');
    expect(parsed.allow).toContain('test-results.json');
  });

  it('--help documents the failure codes and the verify boundary', () => {
    const result = spawnSync(process.execPath, [gateScript, '--help'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('tracked-change');
    expect(result.stdout).toContain('required-input-not-tracked');
    expect(result.stdout).toContain('NOT part of `pnpm run verify`');
  });

  it('refuses an unknown argument instead of ignoring it', () => {
    const dir = makeRepo();
    const run = runGate(dir, ['--not-a-flag']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('unknown-argument');
  });
});
