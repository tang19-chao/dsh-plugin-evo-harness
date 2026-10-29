/**
 * CLI-argument handling regression tests for the P2-B V3 replay probe
 * (p2-a-b-kernel).
 *
 * The bug this file pins: --out= carries a PATH, and the CLI used the raw
 * argument token as that path. A run with --out=work/x.json therefore created a
 * literal directory named "--out=work" beside the repository root (the flag
 * prefix became the first path segment) - garbage that lands OUTSIDE any task's
 * write scope and looks like nothing happened, because the JSON was also written
 * successfully. The fix strips the prefix, fails closed on an empty value BEFORE
 * any replay work runs, and resolves the path so the written path is the
 * reported path.
 *
 * These tests run the real CLI in a child process against a temp directory. That
 * is deliberately not a unit call into an exported helper: the defect lived in
 * the argument-to-path boundary, so the test must exercise that boundary end to
 * end.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const CLI = join(REPO_ROOT, 'scripts', 'eval', 'pr4a-v3-replay.mjs');

const workdir = mkdtempSync(join(tmpdir(), 'p2-v3-replay-cli-'));

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

/** Run the CLI; --out is joined against the temp workdir so the repo stays clean. */
function runCli(args: readonly string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024
  });
}

/** True when a file or directory whose NAME starts with the flag prefix exists under dir. */
function flagPrefixGarbage(dir: string): string[] {
  const offenders: string[] = [];
  const walk = (current: string, relativeName: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const name = relativeName === '' ? entry.name : relativeName + '/' + entry.name;
      if (entry.name.startsWith('--out=') || entry.name.startsWith('--fixture=') || entry.name.startsWith('--json')) {
        offenders.push(name);
      }
      if (entry.isDirectory()) {
        walk(join(current, entry.name), name);
      }
    }
  };
  walk(dir, '');
  return offenders;
}

describe('pr4a-v3-replay CLI: --out is a path, never a literal file name', () => {
  it(
    'writes the payload to the requested path and leaves no --out= prefixed garbage',
    () => {
      const target = join(workdir, 'nested', 'dir', 'replay.json');
      const result = runCli(['--fixture=r4-production', '--out=' + target]);
      // The probe is deterministic and offline; a nonzero exit here is a fixture
      // problem, not the behaviour under test.
      expect(result.status, result.stderr).toBe(0);

      // The requested path exists and is valid JSON with the stable header.
      expect(existsSync(target)).toBe(true);
      const payload = JSON.parse(readFileSync(target, 'utf8')) as { resultStatus: string; probe: string };
      expect(payload.probe).toBe('pr4a-v3-replay');
      expect(payload.resultStatus).toBe('design-time-self-check-not-a-result');

      // THE regression: no file or directory anywhere under the temp workdir (and
      // by construction none in the repo) carries a flag prefix as its name.
      expect(flagPrefixGarbage(workdir)).toEqual([]);
      expect(existsSync(join(workdir, '--out=' + target))).toBe(false);
      // The temp dir holds ONLY the requested artifact tree.
      expect(readdirSync(join(workdir, 'nested', 'dir'))).toEqual(['replay.json']);
    },
    300_000
  );

  it('fails closed on --out= with an empty value: nonzero exit and no file written', () => {
    const result = runCli(['--fixture=r4-production', '--out=']);
    // A user error must stop the run, not silently write to the current directory.
    expect(result.status).not.toBe(0);
    expect(String(result.stderr)).toContain('invalid --out=');
    // Nothing was created for the empty target - neither a file in cwd nor a
    // flag-named entry anywhere under the temp workdir.
    expect(existsSync(join(REPO_ROOT, '--out='))).toBe(false);
    expect(flagPrefixGarbage(workdir)).toEqual([]);
  });
});
