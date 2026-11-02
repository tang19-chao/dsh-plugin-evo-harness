/**
 * rev6 cross-audit BUILD-2: the typecheck must cover `scripts/`, not just
 * `src/` + `tests/`.
 *
 * THE GAP THIS PINS
 * -----------------
 * `pnpm run typecheck` = `tsc --noEmit` over `tsconfig.json`, which used to
 * include only `src/**\/*.ts` and `tests/**\/*.ts`. The ~340 KB of shipped
 * TypeScript under `scripts/` (`eval/jitrl-eval-lib.ts` 198 KB,
 * `pr4a-five-arm-lib.ts` 75 KB, `pr4a-report.ts` 43 KB, `pr4a-stats.ts` 23 KB,
 * plus `fixtures/ledger/*.ts` that `tests/unit/ledger/offline-fixtures.test.ts`
 * imports) was transpiled by esbuild/vitest - neither of which typechecks -
 * so a type-level drift against `src/ledger/types.ts` was invisible to every
 * gate until it failed at runtime (or never failed, for type-only positions).
 *
 * WHY A STATIC TEST AND A REAL `tsc` RUN
 * --------------------------------------
 * The include list is a static fact, so a narrow assertion pins it cheaply.
 * But an include entry proves nothing about whether those files ACTUALLY
 * typecheck: a `// @ts-nocheck`, an unresolvable import or an `exclude` rule
 * could smuggle the same blindness back in. So one test also runs the real
 * compiler with `--listFilesOnly` and asserts every `scripts/**.ts` file on disk
 * appears in the program, and that none of the scripts carry a suppression
 * directive. The exit-code assertion itself belongs to `pnpm run typecheck`
 * (CI's Typecheck step) - running the full compiler here would double the
 * suite's cost for no extra discriminating power on this finding.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const tsconfigPath = path.join(repoRoot, 'tsconfig.json');
const tscEntry = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

interface TsConfig {
  include?: string[];
  exclude?: string[];
  compilerOptions?: Record<string, unknown>;
}

function readConfig(): TsConfig {
  return JSON.parse(fs.readFileSync(tsconfigPath, 'utf8')) as TsConfig;
}

/** Every `.ts`/`.mts` file under `scripts/`, POSIX-relative to the repo root. */
function scriptsTypeScriptFiles(): string[] {
  const files: string[] = [];
  const walk = (absolute: string, relative: string): void => {
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const childAbsolute = path.join(absolute, entry.name);
      const childRelative = relative + '/' + entry.name;
      if (entry.isDirectory()) {
        walk(childAbsolute, childRelative);
      } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.mts'))) {
        files.push(childRelative);
      }
    }
  };
  walk(path.join(repoRoot, 'scripts'), 'scripts');
  return files.sort();
}

describe('tsconfig: scripts/ is part of the typecheck program (rev6 BUILD-2)', () => {
  it('includes scripts/**/*.ts alongside src/ and tests/', () => {
    const config = readConfig();
    expect(config.include).toContain('src/**/*.ts');
    expect(config.include).toContain('tests/**/*.ts');
    expect(config.include).toContain('scripts/**/*.ts');
  });

  it('does not exclude scripts/ or its subdirectories', () => {
    // An exclude entry would silently restore the pre-fix blind spot; the
    // allowlisted excludes are build output and local scratch only.
    const config = readConfig();
    for (const pattern of config.exclude ?? []) {
      expect(pattern.startsWith('scripts'), 'scripts/ must not be excluded: ' + pattern).toBe(false);
    }
  });

  it('the shipped scripts TypeScript is not empty (the finding is about real files)', () => {
    // Guards against the test passing vacuously if scripts/ ever loses its TS.
    expect(scriptsTypeScriptFiles().length).toBeGreaterThan(0);
  });

  it('every scripts/**.ts file is in the real compiler program, with no suppression directive', () => {
    const onDisk = scriptsTypeScriptFiles();
    let listed: string;
    try {
      listed = execFileSync(process.execPath, [tscEntry, '--listFilesOnly', '-p', repoRoot], {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
      });
    } catch (error) {
      // `--listFilesOnly` exits non-zero when the program has errors, but the
      // file list is still printed; an empty stdout is the only unusable case.
      const stdout = (error as { stdout?: string }).stdout;
      if (typeof stdout !== 'string' || stdout.length === 0) {
        throw error;
      }
      listed = stdout;
    }
    const program = new Set(
      listed
        .split(/\r?\n/)
        .map((line) => line.trim().split(/[\\/]/).join('/'))
        .filter((line) => line.length > 0)
    );
    const missing = onDisk.filter((relative) => {
      // `--listFilesOnly` prints absolute paths; compare on the POSIX tail so
      // the assertion is separator- and checkout-location-independent.
      const suffix = '/' + relative;
      return ![...program].some((listedPath) => listedPath.endsWith(suffix));
    });
    expect(missing, 'scripts/ TypeScript outside the typecheck program: ' + missing.join(', ')).toEqual([]);

    for (const relative of onDisk) {
      const source = fs.readFileSync(path.join(repoRoot, relative), 'utf8');
      expect(source, relative + ' must not suppress type checking').not.toContain('@ts-nocheck');
      expect(source, relative + ' must not suppress type checking').not.toContain('@ts-ignore');
    }
  }, 120_000);
});
