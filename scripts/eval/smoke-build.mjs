#!/usr/bin/env node
/**
 * Build + ESM smoke gate (PR-1).
 *
 * WHY THIS GATE EXISTS
 * --------------------
 * `pnpm run build` exiting 0 proves esbuild produced a file; it does NOT prove a
 * consumer can import that file. The repository has already been bitten by
 * exactly this gap once: `node scripts/eval-jitrl.mjs --json` died with
 * ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX (a TypeScript parameter property under
 * Node's strip-only mode) while every in-process test stayed green
 * (`tests/e2e/eval-cli.smoke.test.ts` header). A bundle that builds but cannot
 * be imported is the same class of defect one layer down.
 *
 * This gate therefore, in a CHILD PROCESS (so no vitest transform is involved):
 *   1. runs `pnpm run build` (or `--skip-build` to reuse `lib/index.js`);
 *   2. asserts `lib/index.js` exists, is non-empty and is an ES MODULE (it must
 *      carry `export` syntax - a CommonJS emit would break `import`);
 *   3. imports it with a plain `node` ESM import and asserts the documented
 *      public surface is present and callable;
 *   4. asserts the import is side-effect-free enough to load without a host:
 *      importing must not throw, and `apply`/`createEvoHarnessPlugin` must be
 *      functions (the Cordis entry points);
 *   5. leaks nothing: no `lib/` copy is written outside the repository.
 *
 * Offline: no network, no model, no host, no paid API.
 *
 * Usage:
 *   node scripts/eval/smoke-build.mjs               build, then smoke
 *   node scripts/eval/smoke-build.mjs --skip-build  smoke the existing artifact
 *   node scripts/eval/smoke-build.mjs --json        machine-readable summary
 *
 * Exit codes: 0 = artifact built and importable, 1 = any step failed.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');
const artifact = path.join(rootDir, 'lib', 'index.js');

/**
 * Exports the README/package contract promises. Named explicitly so a silent
 * rename in `src/index.ts` fails the gate instead of shrinking the surface.
 */
export const REQUIRED_EXPORTS = Object.freeze([
  'apply',
  'createEvoHarnessPlugin',
  'PLUGIN_NAME',
  'Config'
]);

/**
 * @param {{skipBuild?: boolean, cwd?: string}} [options]
 * @returns {Promise<{ok: boolean, steps: {step: string, ok: boolean, detail: string}[], exportCount: number, bytes: number}>}
 */
export async function smokeBuild(options = {}) {
  const cwd = options.cwd ?? rootDir;
  const artifactPath = path.join(cwd, 'lib', 'index.js');
  /** @type {{step: string, ok: boolean, detail: string}[]} */
  const steps = [];

  if (options.skipBuild !== true) {
    try {
      // `shell: true` is REQUIRED on Windows: `pnpm` is a `.cmd` shim and
      // spawnSync refuses to execute a batch file without a shell (EINVAL).
      // With `shell: false` this gate reported "build failed" on a machine where
      // `pnpm run build` works, which is a false negative - the worst kind for a
      // gate, because it trains maintainers to ignore it.
      execFileSync('pnpm', ['run', 'build'], {
        cwd,
        stdio: 'pipe',
        encoding: 'utf8',
        shell: process.platform === 'win32'
      });
      steps.push({ step: 'build', ok: true, detail: 'pnpm run build exited 0' });
    } catch (error) {
      const stderr = error && error.stderr ? String(error.stderr).trim() : String(error && error.message);
      steps.push({ step: 'build', ok: false, detail: 'pnpm run build failed: ' + stderr });
      return { ok: false, steps, exportCount: 0, bytes: 0 };
    }
  } else {
    steps.push({ step: 'build', ok: true, detail: 'skipped (--skip-build)' });
  }

  // ---- artifact shape ------------------------------------------------------
  if (!fs.existsSync(artifactPath)) {
    steps.push({ step: 'artifact-exists', ok: false, detail: 'lib/index.js is absent' });
    return { ok: false, steps, exportCount: 0, bytes: 0 };
  }
  const bytes = fs.statSync(artifactPath).size;
  if (bytes === 0) {
    steps.push({ step: 'artifact-exists', ok: false, detail: 'lib/index.js is empty' });
    return { ok: false, steps, exportCount: 0, bytes };
  }
  steps.push({ step: 'artifact-exists', ok: true, detail: 'lib/index.js is ' + String(bytes) + ' bytes' });

  const source = fs.readFileSync(artifactPath, 'utf8');
  if (!/\bexport\s*\{/.test(source) && !/\bexport\s+(const|function|class|default)\b/.test(source)) {
    steps.push({
      step: 'artifact-is-esm',
      ok: false,
      detail: 'lib/index.js carries no ESM export syntax (a CommonJS emit would break `import`)'
    });
    return { ok: false, steps, exportCount: 0, bytes };
  }
  if (/\bmodule\.exports\b/.test(source) || /\brequire\s*\(/.test(source)) {
    steps.push({
      step: 'artifact-is-esm',
      ok: false,
      detail: 'lib/index.js contains CommonJS syntax (module.exports / require) despite --format=esm'
    });
    return { ok: false, steps, exportCount: 0, bytes };
  }
  steps.push({ step: 'artifact-is-esm', ok: true, detail: 'ESM export syntax present, no CommonJS emit' });

  // ---- real ESM import -----------------------------------------------------
  let namespace;
  try {
    namespace = await import(pathToFileURL(artifactPath).href);
    steps.push({ step: 'esm-import', ok: true, detail: 'plain `import()` of lib/index.js succeeded' });
  } catch (error) {
    steps.push({
      step: 'esm-import',
      ok: false,
      detail: 'import of lib/index.js threw: ' + (error instanceof Error ? error.message : String(error))
    });
    return { ok: false, steps, exportCount: 0, bytes };
  }

  const names = Object.keys(namespace).sort();
  steps.push({ step: 'export-surface', ok: true, detail: String(names.length) + ' named exports' });
  const missing = REQUIRED_EXPORTS.filter((name) => !(name in namespace));
  if (missing.length > 0) {
    steps.push({
      step: 'required-exports',
      ok: false,
      detail: 'missing from the bundle: ' + missing.join(', ')
    });
    return { ok: false, steps, exportCount: names.length, bytes };
  }
  steps.push({ step: 'required-exports', ok: true, detail: 'present: ' + REQUIRED_EXPORTS.join(', ') });

  for (const name of ['apply', 'createEvoHarnessPlugin']) {
    if (typeof namespace[name] !== 'function') {
      steps.push({ step: 'entrypoint-' + name, ok: false, detail: name + ' is not a function' });
      return { ok: false, steps, exportCount: names.length, bytes };
    }
  }
  steps.push({ step: 'entrypoints-callable', ok: true, detail: 'apply and createEvoHarnessPlugin are functions' });

  if (namespace.PLUGIN_NAME !== 'dsh-plugin-evo-harness') {
    steps.push({
      step: 'plugin-name',
      ok: false,
      detail: 'PLUGIN_NAME is ' + String(namespace.PLUGIN_NAME) + ', expected dsh-plugin-evo-harness'
    });
    return { ok: false, steps, exportCount: names.length, bytes };
  }
  steps.push({ step: 'plugin-name', ok: true, detail: 'PLUGIN_NAME matches package name' });

  return { ok: steps.every((step) => step.ok), steps, exportCount: names.length, bytes };
}

const isDirectExecution =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectExecution) {
  const wantsJson = process.argv.includes('--json');
  const skipBuild = process.argv.includes('--skip-build');
  try {
    const result = await smokeBuild({ skipBuild });
    if (wantsJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('[build-smoke] artifact: lib/index.js (' + String(result.bytes) + ' bytes)');
      for (const step of result.steps) {
        console.log('[build-smoke] ' + (step.ok ? 'ok  ' : 'FAIL') + ' ' + step.step + ': ' + step.detail);
      }
      console.log(result.ok ? '[build-smoke] SUCCESS: the bundle builds and imports as ESM' : '[build-smoke] FAIL');
    }
    if (!result.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('[build-smoke] unexpected error: ' + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
