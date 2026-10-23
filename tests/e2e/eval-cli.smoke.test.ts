/**
 * Smoke test for the documented evaluation entry point (P6 PR1, plan section 4
 * R7 and Gate 0).
 *
 * Why a subprocess: the e2e ablation suite imports the evaluation library
 * directly, so it can stay green while the command users actually type is
 * broken. That is exactly what happened - `node scripts/eval-jitrl.mjs --json`
 * died with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX (a TypeScript parameter property
 * in src/dsh-bridge/branch.ts under Node's strip-only mode) while every
 * in-process test passed.
 *
 * This suite therefore spawns the real command as a child process, exactly as a
 * user or CI step would, and asserts:
 *   1. exit code 0 and parseable JSON carrying `protocol` and `metrics`
 *      (plus `timing`, so the report is the real protocol output, not a stub);
 *   2. a non-zero exit for an invalid argument (the CLI's error path stays
 *      wired to a failing exit code rather than silently succeeding).
 *
 * It is red on the pre-fix implementation: the old script imported the `.ts`
 * library through a `node:module` resolver and crashed before printing anything.
 *
 * Windows notes: the executable is `process.execPath` and the script path is an
 * absolute path with forward slashes, so no shell, PATH lookup or `node.cmd`
 * shim is involved. Timeouts are generous (the protocol itself takes a few
 * seconds; a cold esbuild precompile of the evaluation library adds a little).
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

/** Repository-relative entry point, resolved to an absolute POSIX-style path. */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\\/g, '/');
const CLI = REPO_ROOT + 'scripts/eval-jitrl.mjs';
const BUILD_EVAL = REPO_ROOT + 'scripts/eval/build-eval.mjs';

/** Generous budget: protocol + possible cold build, with headroom for slow CI. */
const CLI_TIMEOUT_MS = 180_000;

interface CliResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run the CLI with `process.execPath` and resolve with the real exit status.
 *
 * `execFile` is used instead of `execFileSync` so a non-zero exit is a value,
 * not an exception, and stderr stays attached to the assertion message.
 */
function runCli(args: readonly string[]): Promise<CliResult> {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      {
        cwd: REPO_ROOT,
        timeout: CLI_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8'
      },
      (error, stdout, stderr) => {
        // With a non-zero exit, `error` carries the code; a timeout or spawn
        // failure leaves it undefined, which the assertions below must see.
        const status = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
        resolvePromise({
          status,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : ''
        });
      }
    );
  });
}

/** The report fields this suite depends on, typed for the assertions. */
interface SmokeReport {
  readonly harness?: unknown;
  readonly protocol?: { readonly episodes?: unknown; readonly taskCount?: unknown };
  readonly metrics?: {
    readonly id?: unknown;
    readonly avg?: unknown;
    readonly final?: unknown;
    readonly safety?: Record<string, unknown>;
  }[];
  readonly timing?: { readonly totalMs?: unknown };
}

describe('eval CLI: the documented command runs as written', () => {
  it('exists at the documented path', () => {
    expect(existsSync(CLI), 'missing entry point: ' + CLI).toBe(true);
  });

  it(
    'node scripts/eval-jitrl.mjs --json exits 0 with a parseable report',
    async () => {
      const result = await runCli(['--json']);
      expect(
        result.status,
        'default eval CLI must succeed without any --experimental-* flag\nstderr: ' +
          result.stderr.slice(0, 4_000)
      ).toBe(0);

      // stdout must be JSON only: a stray log line would break machine consumers.
      let report: SmokeReport;
      try {
        report = JSON.parse(result.stdout) as SmokeReport;
      } catch (error) {
        throw new Error(
          'stdout of the default eval CLI is not valid JSON: ' +
            (error instanceof Error ? error.message : String(error)) +
            '\nfirst 1_000 chars:\n' +
            result.stdout.slice(0, 1_000)
        );
      }

      expect(report.protocol, 'report must carry protocol').toBeDefined();
      expect(report.protocol?.episodes).toBe(5);
      expect(report.protocol?.taskCount).toBeGreaterThan(0);
      expect(Array.isArray(report.metrics), 'report must carry a metrics array').toBe(true);
      expect(report.metrics?.length ?? 0).toBeGreaterThan(0);
      expect(report.timing?.totalMs, 'report must carry timing').toBeDefined();

      // B0-B3 are the documented comparison groups; the CLI smoke is not a
      // numbers gate (that is tests/e2e/jitrl-ablation.test.ts), so only the
      // presence and shape of those rows is asserted here.
      const ids = (report.metrics ?? []).map((row) => row.id);
      for (const id of ['B0', 'B1', 'B2', 'B3']) {
        expect(ids, 'missing condition ' + id).toContain(id);
      }
      for (const row of report.metrics ?? []) {
        expect(typeof row.avg, 'condition ' + String(row.id) + ' must report Avg').toBe('number');
        expect(typeof row.final, 'condition ' + String(row.id) + ' must report Final').toBe('number');
        expect(row.safety, 'condition ' + String(row.id) + ' must report safety').toBeDefined();
      }
    },
    CLI_TIMEOUT_MS
  );

  it(
    'rejects an unknown argument with a non-zero exit code',
    async () => {
      const result = await runCli(['--json', '--definitely-not-a-flag']);
      expect(
        result.status,
        'an invalid argument must not exit 0\nstdout: ' + result.stdout.slice(0, 1_000)
      ).not.toBe(0);
      expect(result.stderr).toMatch(/unknown argument/i);
      // The documented JSON mode must not print a report when it failed.
      expect(result.stdout.trim()).toBe('');
    },
    CLI_TIMEOUT_MS
  );
});

/**
 * Regression tests for the two PR1 findings raised by the round-1 review
 * (docs/reports/p6-review-round1-pr1.md, PR1-L1 and PR1-L2).
 *
 * Both are exercised through the real code path rather than by re-implementing
 * the logic here: L1 runs the documented CLI with an overridden cache directory
 * (the exact scenario the reviewer reproduced), L2 drives `buildEvalLib` with a
 * synthetic cache and inspects which files survive pruning.
 */
describe('eval CLI: cache directory and pruning regressions', () => {
  it(
    'PR1-L1: an artifact in a cache directory outside node_modules still imports',
    async () => {
      // A temp directory outside the repository's node_modules: this is the
      // case that previously died with
      //   ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'
      // because the bundle kept npm dependencies external while its location
      // had no bare-specifier resolution root.
      const externalCache = mkdtempSync(join(tmpdir(), 'dsh-eval-cache-'));
      try {
        const result = await new Promise<CliResult>((resolvePromise) => {
          execFile(
            process.execPath,
            [CLI, '--json'],
            {
              cwd: REPO_ROOT,
              env: { ...process.env, DSH_EVAL_CACHE_DIR: externalCache },
              timeout: CLI_TIMEOUT_MS,
              maxBuffer: 32 * 1024 * 1024,
              windowsHide: true,
              encoding: 'utf8'
            },
            (error, stdout, stderr) => {
              const status = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
              resolvePromise({
                status,
                stdout: typeof stdout === 'string' ? stdout : '',
                stderr: typeof stderr === 'string' ? stderr : ''
              });
            }
          );
        });

        expect(
          result.status,
          'an out-of-tree DSH_EVAL_CACHE_DIR must still produce a runnable artifact\nstderr: ' +
            result.stderr.slice(0, 2_000)
        ).toBe(0);
        expect(result.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND/);

        const report = JSON.parse(result.stdout) as SmokeReport;
        expect(report.protocol?.episodes).toBe(5);
        expect(report.metrics?.length ?? 0).toBeGreaterThan(0);
      } finally {
        rmSync(externalCache, { recursive: true, force: true });
      }
    },
    CLI_TIMEOUT_MS
  );

  it(
    'PR1-L2: pruning removes the oldest artifacts, not the newest',
    async () => {
      const { buildEvalLib } = await import(pathToFileURL(BUILD_EVAL).href);

      const cacheDir = mkdtempSync(join(tmpdir(), 'dsh-eval-prune-'));
      try {
        // The cap is 12 artifacts; create 13 with strictly increasing mtime so
        // "oldest" and "newest" are unambiguous. With the old comparison the
        // two newest were removed and stale ones kept - the inverse of intent.
        const base = Date.now() - 100 * 60 * 1000;
        const primePrefix = 'prime.';
        for (let index = 0; index < 13; index += 1) {
          const name = primePrefix + String(index).padStart(2, '0') + '.mjs';
          const absolute = join(cacheDir, name);
          writeFileSync(absolute, 'export const marker = ' + String(index) + ';\n', 'utf8');
          const stamp = (base + index * 60 * 1000) / 1000;
          utimesSync(absolute, stamp, stamp);
        }

        // Building into the same cache with the matching name triggers pruning.
        const result = await buildEvalLib({ name: 'prime', cacheDir });
        expect(existsSync(result.outfile), 'the fresh artifact must survive').toBe(true);

        const survivors = readdirSync(cacheDir)
          .filter((name) => name.startsWith(primePrefix) && name !== primePrefix + result.digest.slice(0, 20) + '.mjs')
          .sort();
        // 13 spares + keep, cap 12 => two spares are dropped, and they must be
        // the two oldest (prime.00 and prime.01).
        expect(survivors.length).toBe(11);
        expect(survivors).not.toContain('prime.00.mjs');
        expect(survivors).not.toContain('prime.01.mjs');
        // The newest spare must still be there: pruning the freshest artifacts
        // is exactly the bug being regressed against.
        expect(survivors).toContain('prime.12.mjs');
      } finally {
        rmSync(cacheDir, { recursive: true, force: true });
      }
    },
    CLI_TIMEOUT_MS
  );

  it(
    'PR1-L1: the default cache directory keeps the compact external bundle',
    async () => {
      // The default/CI path must keep the reviewed behaviour: dependencies stay
      // external there (smaller artifact) because node_modules is resolvable.
      const { buildEvalLib } = await import(pathToFileURL(BUILD_EVAL).href);
      const cacheDir = REPO_ROOT + 'node_modules/.cache/dsh-plugin-evo-harness';
      const result = await buildEvalLib({ cacheDir });
      expect(result.mode).toBe('external');
      expect(existsSync(result.outfile)).toBe(true);
    },
    CLI_TIMEOUT_MS
  );
});
