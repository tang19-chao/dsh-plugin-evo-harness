/**
 * Report-target resolution and the frozen-report guard (rev5 C-3/C-9).
 *
 * What is pinned here:
 *   - `--out` resolves against the repository root (never the process cwd);
 *   - the default target stays the frozen rc1 path (backwards compatible);
 *   - writing the EXISTING frozen report is refused with a named error unless
 *     `--force`; a frozen target that does not exist is not protected;
 *   - the runner-level refusal actually happens: `node scripts/host-smoke/run.mjs`
 *     with no `--out` exits 1 before doing any work and leaves the frozen
 *     report untouched.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The runner's report-path helpers are plain JavaScript (the runner must execute
 * under the installed host's Node with no build step), so this suite reaches
 * them through `createRequire` and pins the API with a LOCAL interface. The
 * contract therefore lives where it is consumed — the test — instead of adding
 * a hand-written `.d.mts` next to the script.
 */
interface ReportPathApi {
  readonly FROZEN_RC1_RELATIVE: string;
  readonly DEFAULT_REPORT_RELATIVE: string;
  readonly RC2_RELATIVE: string;
  /** t33: every frozen report the guard protects, in match order. */
  readonly FROZEN_REPORT_RELATIVES: readonly string[];
  /** t33: which frozen report (if any) a target resolves to. */
  frozenReportMatch(repoRoot: string, targetPath: string): string | undefined;
  resolveReportPath(
    repoRoot: string,
    options?: { out?: string; env?: Record<string, string | undefined> }
  ): { path: string; source: 'flag' | 'env' | 'default' };
  inspectFrozenReportTarget(
    repoRoot: string,
    targetPath: string,
    exists?: (candidate: string) => boolean
  ): { frozen: boolean; reason: string | null; frozenPath: string };
  assertReportTargetWritable(input: {
    repoRoot: string;
    targetPath: string;
    force?: boolean;
    exists?: (candidate: string) => boolean;
  }): { path: string; frozen: boolean; forced: boolean };
  parseReportArgs(argv: readonly string[]): { out?: string; force: boolean; problems: string[] };
}

const requireFromHere = createRequire(import.meta.url);
const {
  DEFAULT_REPORT_RELATIVE,
  FROZEN_RC1_RELATIVE,
  FROZEN_REPORT_RELATIVES,
  RC2_RELATIVE,
  assertReportTargetWritable,
  frozenReportMatch,
  inspectFrozenReportTarget,
  parseReportArgs,
  resolveReportPath
} = requireFromHere('../../../scripts/host-smoke/report-path.mjs') as ReportPathApi;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

describe('parseReportArgs', () => {
  it('parses --out <path> and --out=<path>', () => {
    expect(parseReportArgs(['--out', 'docs/reports/host-smoke-rc2.md'])).toEqual({
      out: 'docs/reports/host-smoke-rc2.md',
      force: false,
      problems: []
    });
    expect(parseReportArgs(['--out=docs/reports/host-smoke-rc2.md']).out).toBe('docs/reports/host-smoke-rc2.md');
  });

  it('flags a missing --out value instead of silently continuing', () => {
    expect(parseReportArgs(['--out']).problems).toContain('--out requires a path');
    expect(parseReportArgs(['--out', '--no-write']).problems).toContain('--out requires a path');
    expect(parseReportArgs(['--out=']).problems).toContain('--out requires a path');
  });

  it('parses --force', () => {
    expect(parseReportArgs(['--force']).force).toBe(true);
  });
});

describe('resolveReportPath', () => {
  it('defaults to the frozen rc1 path relative to the repo root', () => {
    const resolved = resolveReportPath(repoRoot, {});
    expect(resolved.source).toBe('default');
    expect(resolved.path).toBe(path.resolve(repoRoot, FROZEN_RC1_RELATIVE));
    expect(DEFAULT_REPORT_RELATIVE).toBe(FROZEN_RC1_RELATIVE);
  });

  it('resolves a relative --out against the repo root, not the cwd', () => {
    const resolved = resolveReportPath(repoRoot, { out: 'docs/reports/host-smoke-rc2.md' });
    expect(resolved.source).toBe('flag');
    expect(resolved.path).toBe(path.resolve(repoRoot, RC2_RELATIVE));
  });

  it('keeps flag precedence over the env override', () => {
    const resolved = resolveReportPath(repoRoot, {
      out: 'docs/reports/flag.md',
      env: { HOSTSMOKE_OUT_PATH: 'docs/reports/env.md' }
    });
    expect(resolved.source).toBe('flag');
    expect(resolved.path).toBe(path.resolve(repoRoot, 'docs/reports/flag.md'));

    const fromEnv = resolveReportPath(repoRoot, { env: { HOSTSMOKE_OUT_PATH: 'docs/reports/env.md' } });
    expect(fromEnv.source).toBe('env');
    expect(fromEnv.path).toBe(path.resolve(repoRoot, 'docs/reports/env.md'));
  });
});

describe('inspectFrozenReportTarget / assertReportTargetWritable', () => {
  it('does not protect a target that is not a frozen path', () => {
    // t33: this assertion used to use RC2_RELATIVE as its "not frozen" example.
    // That was exactly the defect - rc2 IS frozen rev5 evidence and had no
    // protection. A genuinely free target is used instead, so this still pins
    // the "non-frozen targets pass" branch without pinning the bug.
    const freeRelative = 'docs/reports/host-smoke-rc4.md';
    const verdict = inspectFrozenReportTarget(repoRoot, path.resolve(repoRoot, freeRelative), () => true);
    expect(verdict.frozen).toBe(false);
    expect(verdict.reason).toBe(null);
    expect(() => assertReportTargetWritable({ repoRoot, targetPath: path.resolve(repoRoot, freeRelative), force: false })).not.toThrow();
    // rc2 must now sit on the PROTECTED side of this same boundary.
    expect(inspectFrozenReportTarget(repoRoot, path.resolve(repoRoot, RC2_RELATIVE), () => true).frozen).toBe(true);
  });

  it('does not protect a frozen path that does not exist', () => {
    const verdict = inspectFrozenReportTarget(repoRoot, path.resolve(repoRoot, FROZEN_RC1_RELATIVE), () => false);
    expect(verdict.frozen).toBe(false);
    expect(verdict.reason).toContain('absent');
  });

  it('refuses to overwrite the existing frozen report without --force', () => {
    expect(() => assertReportTargetWritable({ repoRoot, targetPath: path.resolve(repoRoot, FROZEN_RC1_RELATIVE), force: false })).toThrowError(
      /frozen P6\.1-F real-host report/
    );
    let code;
    try {
      assertReportTargetWritable({ repoRoot, targetPath: path.resolve(repoRoot, FROZEN_RC1_RELATIVE), force: false });
    } catch (error) {
      code = (error as NodeJS.ErrnoException).code;
    }
    expect(code).toBe('frozen-report-protected');
  });

  it('allows the frozen target with --force and reports it as forced', () => {
    const verdict = assertReportTargetWritable({ repoRoot, targetPath: path.resolve(repoRoot, FROZEN_RC1_RELATIVE), force: true });
    expect(verdict).toEqual({ path: path.resolve(repoRoot, FROZEN_RC1_RELATIVE), frozen: true, forced: true });
  });
});

describe('runner-level guard (real invocation, no report written)', () => {
  it('refuses the default target before doing any work', () => {
    const before = fs.statSync(path.join(repoRoot, FROZEN_RC1_RELATIVE)).mtimeMs;
    const run = spawnSync(process.execPath, ['scripts/host-smoke/run.mjs'], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000
    });
    // The refusal is loud and non-zero; no report is written.
    expect(run.status).not.toBe(0);
    expect((run.stderr ?? '') + (run.stdout ?? '')).toContain('REFUSED');
    expect((run.stderr ?? '') + (run.stdout ?? '')).toContain('--out');
    expect(fs.statSync(path.join(repoRoot, FROZEN_RC1_RELATIVE)).mtimeMs).toBe(before);
  });

  it('still reports readiness with --check and never writes', () => {
    const before = fs.statSync(path.join(repoRoot, FROZEN_RC1_RELATIVE)).mtimeMs;
    // `--check` reports `readiness ok=false` when no installed DSH host is
    // found. A CI runner has no DSH installation, so asserting `ok=true`
    // against the developer machine made this test environment-dependent.
    // Pin host discovery to a throwaway installation instead: the assertion
    // then tests the readiness logic, not whether the machine happens to have
    // DeepSeek Harness installed.
    const fakeHostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-host-smoke-fake-host-'));
    fs.mkdirSync(path.join(fakeHostHome, 'resources', 'app.asar'), { recursive: true });
    fs.writeFileSync(
      path.join(fakeHostHome, 'resources', 'app.asar', 'package.json'),
      JSON.stringify({ name: 'deepseek-harness', version: '0.0.0-test' }) + '\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(fakeHostHome, process.platform === 'win32' ? 'DeepSeek Harness.exe' : 'DeepSeek Harness'),
      '',
      'utf8'
    );
    try {
      const run = spawnSync(process.execPath, ['scripts/host-smoke/run.mjs', '--check'], {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60_000,
        env: { ...process.env, HOSTSMOKE_DSH_HOME: fakeHostHome }
      });
      expect(run.status).toBe(0);
      expect(run.stdout ?? '').toContain('readiness ok=true');
      expect(fs.statSync(path.join(repoRoot, FROZEN_RC1_RELATIVE)).mtimeMs).toBe(before);
    } finally {
      fs.rmSync(fakeHostHome, { recursive: true, force: true });
    }
  });

  it('keeps a temp-tree rc1 protected and its absence unprotected', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-host-smoke-report-path-'));
    try {
      const frozen = path.join(temp, FROZEN_RC1_RELATIVE);
      fs.mkdirSync(path.dirname(frozen), { recursive: true });
      fs.writeFileSync(frozen, '# frozen\n', 'utf8');
      // Present -> protected; absent -> not protected (a first copy is fine).
      expect(inspectFrozenReportTarget(temp, frozen).frozen).toBe(true);
      fs.rmSync(frozen);
      expect(inspectFrozenReportTarget(temp, frozen).frozen).toBe(false);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// t33: rc2 is frozen evidence too.
//
// THE DEFECT THIS PINS
// --------------------
// `RC2_RELATIVE` existed but the guard only ever compared against
// `FROZEN_RC1_RELATIVE`, so rc2 had NO overwrite protection: the documented
// `--out docs/reports/host-smoke-rc2.md` example would have replaced recorded
// rev5 evidence with no refusal at all.
//
// These assertions run against the REAL repository tree (not a temp copy) for
// the frozen-path cases, because the hazard is specifically about the two real
// files. A temp tree is still used for the "absent frozen file" branch, where a
// real deletion would obviously be wrong.
// ---------------------------------------------------------------------------
describe('t33 frozen-report coverage: rc1 AND rc2 are both protected', () => {
  it('declares exactly the two frozen reports, rc1 first', () => {
    // rc1 must stay first: `frozenPath` reports the first match and existing
    // callers read that field expecting rc1 when the target is rc1.
    expect([...FROZEN_REPORT_RELATIVES]).toEqual([FROZEN_RC1_RELATIVE, RC2_RELATIVE]);
  });

  it('matches both frozen paths by resolved path, not by string prefix', () => {
    expect(frozenReportMatch(repoRoot, path.join(repoRoot, FROZEN_RC1_RELATIVE))).toBe(FROZEN_RC1_RELATIVE);
    expect(frozenReportMatch(repoRoot, path.join(repoRoot, RC2_RELATIVE))).toBe(RC2_RELATIVE);
    // A `..` detour still resolves to the same file, so it must still match.
    const detour = path.join(repoRoot, 'docs', 'reports', '..', 'reports', RC2_RELATIVE.split('/').pop() as string);
    expect(frozenReportMatch(repoRoot, detour)).toBe(RC2_RELATIVE);
    // A lookalike that is NOT the frozen file stays free.
    expect(frozenReportMatch(repoRoot, path.join(repoRoot, 'docs/reports/host-smoke-rc4.md'))).toBeUndefined();
  });

  it('REFUSES rc1 without --force, with the named error', () => {
    const target = path.join(repoRoot, FROZEN_RC1_RELATIVE);
    expect(inspectFrozenReportTarget(repoRoot, target).frozen).toBe(true);
    let code: string | undefined;
    try {
      assertReportTargetWritable({ repoRoot, targetPath: target });
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('frozen-report-protected');
  });

  it('REFUSES rc2 without --force, with the same named error', () => {
    const target = path.join(repoRoot, RC2_RELATIVE);
    const verdict = inspectFrozenReportTarget(repoRoot, target);
    expect(verdict.frozen, 'rc2 is recorded rev5 evidence and must be protected').toBe(true);
    // The reason must name rc2, not rc1: a wrong name sends the reader to the
    // wrong file.
    expect(verdict.reason ?? '').toContain(RC2_RELATIVE);
    let code: string | undefined;
    try {
      assertReportTargetWritable({ repoRoot, targetPath: target });
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('frozen-report-protected');
  });

  it('ALLOWS rc4 (a new report path) without --force', () => {
    // rc4 is the documented target for new runs; it may not exist yet.
    const target = path.join(repoRoot, 'docs/reports/host-smoke-rc4.md');
    expect(inspectFrozenReportTarget(repoRoot, target).frozen).toBe(false);
    const allowed = assertReportTargetWritable({ repoRoot, targetPath: target });
    expect(allowed.frozen).toBe(false);
    expect(allowed.forced).toBe(false);
  });

  it('allows EITHER frozen file with an explicit --force, and reports forced:true', () => {
    for (const relative of FROZEN_REPORT_RELATIVES) {
      const target = path.join(repoRoot, relative);
      const forced = assertReportTargetWritable({ repoRoot, targetPath: target, force: true });
      expect(forced.frozen, relative + ' is frozen').toBe(true);
      expect(forced.forced, relative + ' must report forced').toBe(true);
    }
  });

  it('still protects rc1 alone when rc2 is absent (absence is per-file)', () => {
    // Injected `exists` so no real file is touched: rc2 "absent" while rc1
    // "present" must leave rc1 protected and rc2 unprotected-but-harmless.
    const present = (candidate: string): boolean => path.resolve(candidate) === path.resolve(repoRoot, FROZEN_RC1_RELATIVE);
    expect(inspectFrozenReportTarget(repoRoot, path.join(repoRoot, FROZEN_RC1_RELATIVE), present).frozen).toBe(true);
    const rc2Absent = inspectFrozenReportTarget(repoRoot, path.join(repoRoot, RC2_RELATIVE), present);
    expect(rc2Absent.frozen, 'a frozen path that does not exist is not protected').toBe(false);
    expect(rc2Absent.reason ?? '').toContain(RC2_RELATIVE);
  });

  it('leaves the real rc1/rc2 bytes untouched (the guard is read-only)', () => {
    // Guards must not have side effects; this also catches an accidental write
    // during resolution.
    for (const relative of FROZEN_REPORT_RELATIVES) {
      const target = path.join(repoRoot, relative);
      if (fs.existsSync(target)) {
        const before = fs.statSync(target).size;
        inspectFrozenReportTarget(repoRoot, target);
        try {
          assertReportTargetWritable({ repoRoot, targetPath: target });
        } catch {
          // expected refusal
        }
        expect(fs.statSync(target).size, relative + ' must not change').toBe(before);
      }
    }
  });
});
