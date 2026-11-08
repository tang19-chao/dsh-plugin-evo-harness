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
 *   2b. (rev5 P0-5) asserts the artifact was built from the CURRENT `src/`
 *      tree: `lib/build-stamp.json` must record the same `srcTreeSha256` (the
 *      frozen recipe in `scripts/build-manifest.mjs`) and the same artifact
 *      sha256/bytes. A stamp that is missing, unreadable or describes other
 *      bytes FAILS with named reasons (`artifact-missing`, `stamp-missing`,
 *      `stamp-invalid`, `src-tree-mismatch`, `dependency-mismatch`,
 *      `artifact-mismatch`, `commit-mismatch`) instead of letting an expired
 *      artifact pass the import smoke test. With `--skip-build` the SAME check
 *      runs, so an old `lib/` can no longer be certified by skipping the build;
 *   3. imports it with a plain `node` ESM import and asserts the documented
 *      public surface is present and callable - including the DEFAULT export
 *      the host mount actually calls (cordis.patch.yml: "DSH resolves the entry
 *      by the Node-resolvable package name below ... then calls its default
 *      `{ name, inject, Config, apply }` export");
 *   4. asserts the import is side-effect-free enough to load without a host:
 *      importing must not throw, and `apply`/`createEvoHarnessPlugin` must be
 *      functions (the Cordis entry points);
 *   5. leaks nothing: no `lib/` copy is written outside the repository.
 *
 * rev8 dual-artifact (ADDITIVE steps 6-8; the plugin steps above keep their
 * exact order and semantics):
 *   6. asserts the MCP entry `lib/mcp/server.js` exists and is non-empty
 *      (the second build artifact, an ESM bundle of src/mcp/server.ts);
 *   7. asserts it can be LOADED by a plain `node` child process - the probe
 *      imports the module and reports the named exports it observes. Loading
 *      proves the bundle resolves its (inlined) SDK imports and parses;
 *   8. asserts the load is import-PURE: the probe's process must not occupy
 *      the stdio channels merely by importing (no data listener attached to
 *      stdin, no bytes written to stdout/stderr by the import itself) and
 *      must not create files in a scratch data directory (the adapter's
 *      key/data handling is lazy - importing must touch nothing). The direct-
 *      execution guard in src/mcp/server.ts keeps `node lib/mcp/server.js`
 *      as the ONLY path that starts the stdio transport; an import starts
 *      nothing. A process that fails one of these checks fails the gate with
 *      a named step.
 *
 * Offline: no network, no model, no host, no paid API.
 *
 * Usage:
 *   node scripts/eval/smoke-build.mjs               build, then smoke
 *   node scripts/eval/smoke-build.mjs --status      freshness status only (no build)
 *   node scripts/eval/smoke-build.mjs --skip-build  smoke the existing artifact
 *   node scripts/eval/smoke-build.mjs --json        machine-readable summary
 *
 * Exit codes: 0 = artifact built/importable AND fresh, 1 = any step failed
 * (including a stale artifact in `--status` mode).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { computeBuildStatus, formatBuildStatus } from '../build-manifest.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');
const artifact = path.join(rootDir, 'lib', 'index.js');
const mcpArtifact = path.join(rootDir, 'lib', 'mcp', 'server.js');

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
 * rev8: the named export surface the MCP entry must expose for the tests and
 * the deployment docs. The stdio entry itself is a side-effect-free factory:
 * importing the module must never START the transport.
 */
export const REQUIRED_MCP_EXPORTS = Object.freeze([
  'createEvoMcpServer',
  'serveEvoMcpStdio',
  'EVO_TOOL_NAMES',
  'EVO_MCP_SERVER_NAME'
]);

/**
 * rev8: the child-process probe the mcp steps run. Written to a scratch dir
 * and executed with `node <probe.mjs> <artifact.mjs> <scratch-data-dir>`; it
 * imports the artifact (through pathToFileURL, Windows-safe) and reports WHAT
 * THE IMPORT DID through stdout JSON:
 *   - exportNames: the module namespace's own keys;
 *   - stdinHasDataListeners / stdinFlowingChanged: whether the import attached
 *     to the process' stdin (a stdio transport would);
 *   - filesCreated: a recursive listing of the child's cwd (the scratch dir)
 *     MINUS the probe module itself, taken after the import. A data dir the
 *     import creates lands here because the child's cwd IS the scratch dir
 *     (must stay empty apart from the probe file: the adapter's key/data
 *     handling is lazy, and the assembly is built lazily, so importing must
 *     not create a data dir).
 *   - Any byte the import writes to stderr is a purity failure the parent
 *     reads from the pipe (stdout must stay protocol-only: one JSON object).
 * The probe writes NOTHING itself and imports nothing beyond node builtins.
 */
const MCP_PROBE_SCRIPT = [
  'import fs from "node:fs";',
  'import path from "node:path";',
  'import { pathToFileURL } from "node:url";',
  'const artifactPath = process.argv[2];',
  'const selfPath = path.resolve(process.argv[1]);',
  'const stdinDataBefore = process.stdin.listenerCount("data");',
  'const readableFlowingBefore = process.stdin.readableFlowing;',
  'const report = (payload) => process.stdout.write(JSON.stringify(payload));',
  'try {',
  '  const namespace = await import(pathToFileURL(artifactPath).href);',
  '  const listFiles = (dir) => {',
  '    let out = [];',
  '    let entries;',
  '    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }',
  '    for (const entry of entries) {',
  '      const full = path.join(dir, entry.name);',
  '      if (full === selfPath) continue;',
  '      if (entry.isDirectory()) out = out.concat(listFiles(full));',
  '      else out.push(full);',
  '    }',
  '    return out;',
  '  };',
  '  report({',
  '    ok: true,',
  '    exportNames: Object.keys(namespace).sort(),',
  '    stdinHasDataListeners: process.stdin.listenerCount("data") > stdinDataBefore,',
  '    stdinFlowingChanged: process.stdin.readableFlowing !== readableFlowingBefore,',
  '    filesCreated: listFiles(process.cwd())',
  '  });',
  '} catch (error) {',
  '  report({ ok: false, error: String(error && error.message ? error.message : error) });',
  '}',
  ''
].join('\n');

/**
 * rev8: run the import-purity probe against the MCP artifact in a CHILD
 * PROCESS (so no vitest transform is involved, mirroring the gate's own ESM
 * import step). The child's stdout is protocol-only (the probe's JSON); any
 * byte written to stdout/stderr by the import itself is a purity failure the
 * parent sees as malformed output or pipe traffic.
 *
 * @param {string} artifactPath absolute path to lib/mcp/server.js
 * @returns {{ok: boolean, detail: string, parsed: any, stdout: string, stderr: string, status: number|null}}
 */
export function probeMcpImport(artifactPath) {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-mcp-import-probe-'));
  const probePath = path.join(scratchDir, 'mcp-import-probe.mjs');
  try {
    fs.writeFileSync(probePath, MCP_PROBE_SCRIPT, 'utf8');
    const result = spawnSync(process.execPath, [probePath, artifactPath], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
      // The child's cwd IS the scratch dir: a module that writes relative to
      // process.cwd() on import lands inside the watched dir (never the
      // repository or the caller's directory), where filesCreated catches it.
      cwd: scratchDir
    });
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    let parsed = null;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      // stdout that is not pure JSON means the import wrote to stdout - the
      // stdio-occupation failure shape this probe exists to catch.
    }
    if (result.status !== 0) {
      return {
        ok: false,
        detail: 'probe process exited ' + String(result.status) + ' (stderr: ' + stderr.slice(0, 400) + ')',
        parsed,
        stdout,
        stderr,
        status: result.status
      };
    }
    if (parsed === null || parsed.ok !== true) {
      const errorText = parsed !== null && typeof parsed.error === 'string' ? parsed.error : stdout.slice(0, 400);
      return {
        ok: false,
        detail: 'import failed or stdout was not a single JSON object: ' + errorText,
        parsed,
        stdout,
        stderr,
        status: result.status
      };
    }
    return { ok: true, detail: 'ok', parsed, stdout, stderr, status: result.status };
  } finally {
    try {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      // A leftover scratch dir must not fail the gate.
    }
  }
}

/**
 * rev8: the additive MCP-entry smoke steps (existence, loadability, import
 * purity). Run AFTER the plugin steps; each failure returns the step list so
 * far, mirroring the early-return discipline of the plugin steps.
 *
 * @param {{steps: {step: string, ok: boolean, detail: string}[]}} accumulator
 * @param {{artifactPath?: string}} [paths] - override the MCP artifact path
 *        (tests point this at a fixture bundle; production uses the repo's
 *        lib/mcp/server.js)
 * @returns {{steps: {step: string, ok: boolean, detail: string}[], ok: boolean}}
 */
export function runMcpSmokeSteps(accumulator, paths = {}) {
  const steps = accumulator.steps;
  const artifactPath = paths.artifactPath ?? mcpArtifact;

  // ---- 6. the MCP artifact exists ------------------------------------------
  if (!fs.existsSync(artifactPath)) {
    steps.push({ step: 'mcp-artifact-exists', ok: false, detail: 'lib/mcp/server.js is absent (the dual-artifact build produces it next to lib/index.js)' });
    return { steps, ok: false };
  }
  const mcpBytes = fs.statSync(artifactPath).size;
  if (mcpBytes === 0) {
    steps.push({ step: 'mcp-artifact-exists', ok: false, detail: 'lib/mcp/server.js is empty' });
    return { steps, ok: false };
  }
  steps.push({ step: 'mcp-artifact-exists', ok: true, detail: 'lib/mcp/server.js is ' + String(mcpBytes) + ' bytes' });

  // ---- 7. it is loadable by a plain node child ------------------------------
  const probe = probeMcpImport(artifactPath);
  if (!probe.ok) {
    steps.push({ step: 'mcp-entry-loadable', ok: false, detail: 'node could not load lib/mcp/server.js: ' + probe.detail });
    return { steps, ok: false };
  }
  steps.push({ step: 'mcp-entry-loadable', ok: true, detail: 'plain node import of lib/mcp/server.js succeeded (' + String(probe.parsed.exportNames.length) + ' named exports)' });

  // ---- 7b. the documented export surface -----------------------------------
  const missingMcpExports = REQUIRED_MCP_EXPORTS.filter((name) => !probe.parsed.exportNames.includes(name));
  if (missingMcpExports.length > 0) {
    steps.push({ step: 'mcp-entry-exports', ok: false, detail: 'missing from the MCP bundle: ' + missingMcpExports.join(', ') });
    return { steps, ok: false };
  }
  steps.push({ step: 'mcp-entry-exports', ok: true, detail: 'present: ' + REQUIRED_MCP_EXPORTS.join(', ') });

  // ---- 8. the import is PURE (no stdio occupation, no data-dir writes) ------
  const purityProblems = [];
  if (probe.parsed.stdinHasDataListeners === true) {
    purityProblems.push('the import attached a data listener to stdin (a stdio transport started on import)');
  }
  if (probe.parsed.stdinFlowingChanged === true) {
    purityProblems.push('the import changed stdin\'s flowing state (a stdio transport started on import)');
  }
  if (probe.parsed.filesCreated.length > 0) {
    purityProblems.push('the import created files in the scratch data dir: ' + probe.parsed.filesCreated.join(', '));
  }
  if (probe.stderr.length > 0) {
    purityProblems.push('the import wrote to stderr: ' + probe.stderr.slice(0, 200));
  }
  if (purityProblems.length > 0) {
    steps.push({ step: 'mcp-import-pure', ok: false, detail: purityProblems.join('; ') });
    return { steps, ok: false };
  }
  steps.push({ step: 'mcp-import-pure', ok: true, detail: 'import occupied no stdio channel, created no data files, wrote nothing to stderr' });

  return { steps, ok: true };
}

/**
 * @param {{skipBuild?: boolean, cwd?: string}} [options]
 * @returns {Promise<{ok: boolean, steps: {step: string, ok: boolean, detail: string}[], exportCount: number, bytes: number, mcpBytes: number, stale: boolean, freshness: import('../build-manifest.mjs').BuildStatus | null}>}
 */
export async function smokeBuild(options = {}) {
  const cwd = options.cwd ?? rootDir;
  const artifactPath = path.join(cwd, 'lib', 'index.js');
  const mcpArtifactPath = path.join(cwd, 'lib', 'mcp', 'server.js');
  /** @type {{step: string, ok: boolean, detail: string}[]} */
  const steps = [];

  /** The result shape shared by every early return (mcpBytes: 0 = unknown). */
  const outcome = (ok, stale, freshness) => ({
    ok,
    steps,
    exportCount: 0,
    bytes: fs.existsSync(artifactPath) ? fs.statSync(artifactPath).size : 0,
    mcpBytes: fs.existsSync(mcpArtifactPath) ? fs.statSync(mcpArtifactPath).size : 0,
    stale,
    freshness
  });

  if (options.skipBuild !== true) {
    try {
      // `shell: true` is REQUIRED on Windows: `pnpm` is a `.cmd` shim and
      // spawnSync refuses to execute a batch file without a shell (EINVAL).
      // With `shell: false` this gate reported "build failed" on a machine where
      // `pnpm run build` works, which is a false negative - the worst kind for a
      // gate, because it trains maintainers to ignore it.
      //
      // rev6 CI pinning: the build child MUST see `CI=true` no matter what the
      // invoking environment says. pnpm (and build tools behind it) change
      // behavior when CI is set - reporter modes, update notifiers, cache and
      // failure paths - so a gate that inherits the caller's CI value produces
      // different evidence from a developer shell than from a CI job. The rest
      // of the environment is inherited wholesale: PATH (the pnpm shim itself),
      // HOME/USERPROFILE, SystemRoot/ComSpec and pnpm's config variables must
      // survive so the same build runs in a shell, a CI job, and this suite.
      execFileSync('pnpm', ['run', 'build'], {
        cwd,
        stdio: 'pipe',
        encoding: 'utf8',
        shell: process.platform === 'win32',
        env: { ...process.env, CI: 'true' }
      });
      steps.push({ step: 'build', ok: true, detail: 'pnpm run build exited 0' });
    } catch (error) {
      const stderr = error && error.stderr ? String(error.stderr).trim() : String(error && error.message);
      steps.push({ step: 'build', ok: false, detail: 'pnpm run build failed: ' + stderr });
      return outcome(false, true, null);
    }
  } else {
    steps.push({ step: 'build', ok: true, detail: 'skipped (--skip-build)' });
  }

  // ---- artifact shape ------------------------------------------------------
  if (!fs.existsSync(artifactPath)) {
    steps.push({ step: 'artifact-exists', ok: false, detail: 'lib/index.js is absent' });
    return outcome(false, true, null);
  }
  const bytes = fs.statSync(artifactPath).size;
  if (bytes === 0) {
    steps.push({ step: 'artifact-exists', ok: false, detail: 'lib/index.js is empty' });
    return outcome(false, true, null);
  }
  steps.push({ step: 'artifact-exists', ok: true, detail: 'lib/index.js is ' + String(bytes) + ' bytes' });

  // ---- build freshness (rev5 P0-5; rev8 dual-artifact fail-closed) ---------
  // The artifact is only evidence if it came from THESE sources. This check is
  // content-based (src tree digest + artifact sha256), never mtime-based, and
  // it also runs under --skip-build so "reuse whatever is in lib/" cannot
  // certify an expired build.
  //
  // rev8: the SECOND artifact is stamp-verified too, whenever it exists on
  // disk (`requireMcpArtifact` adds exactly the mcp-artifact-mismatch
  // comparison against the stamp's artifactMcp block - a replaced
  // lib/mcp/server.js is stale evidence, not a fresh import; a stamp that
  // predates the block with the file present is its own mismatch). When the
  // file is ABSENT the freshness check keeps the pre-rev8 primary-only
  // semantics (a fixture repository's) and the mcp-artifact-exists step below
  // fails by name instead - so a missing OR replaced second artifact can never
  // pass this gate.
  const freshness = computeBuildStatus({
    cwd,
    requireMcpArtifact: fs.existsSync(mcpArtifactPath)
  });
  if (freshness.stale) {
    steps.push({
      step: 'build-freshness',
      ok: false,
      detail:
        'stale: true [' +
        freshness.reasons.join(', ') +
        '] - ' +
        freshness.detail
    });
    return outcome(false, true, freshness);
  }
  steps.push({
    step: 'build-freshness',
    ok: true,
    detail:
      'stale: false (srcTreeSha256 ' +
      freshness.srcTreeSha256.current.slice(0, 16) +
      '…, ' +
      String(freshness.srcTreeSha256.currentFileCount) +
      ' src files; recorded artifact ' +
      String(freshness.artifactBytes) +
      ' bytes)'
  });

  const source = fs.readFileSync(artifactPath, 'utf8');
  if (!/\bexport\s*\{/.test(source) && !/\bexport\s+(const|function|class|default)\b/.test(source)) {
    steps.push({
      step: 'artifact-is-esm',
      ok: false,
      detail: 'lib/index.js carries no ESM export syntax (a CommonJS emit would break `import`)'
    });
    return outcome(false, false, freshness);
  }
  if (/\bmodule\.exports\b/.test(source) || /\brequire\s*\(/.test(source)) {
    steps.push({
      step: 'artifact-is-esm',
      ok: false,
      detail: 'lib/index.js contains CommonJS syntax (module.exports / require) despite --format=esm'
    });
    return outcome(false, false, freshness);
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
    return outcome(false, false, freshness);
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
    return outcome(false, false, freshness);
  }
  steps.push({ step: 'required-exports', ok: true, detail: 'present: ' + REQUIRED_EXPORTS.join(', ') });

  for (const name of ['apply', 'createEvoHarnessPlugin']) {
    if (typeof namespace[name] !== 'function') {
      steps.push({ step: 'entrypoint-' + name, ok: false, detail: name + ' is not a function' });
      return outcome(false, false, freshness);
    }
  }
  steps.push({ step: 'entrypoints-callable', ok: true, detail: 'apply and createEvoHarnessPlugin are functions' });

  if (namespace.PLUGIN_NAME !== 'dsh-plugin-evo-harness') {
    steps.push({
      step: 'plugin-name',
      ok: false,
      detail: 'PLUGIN_NAME is ' + String(namespace.PLUGIN_NAME) + ', expected dsh-plugin-evo-harness'
    });
    return outcome(false, false, freshness);
  }
  steps.push({ step: 'plugin-name', ok: true, detail: 'PLUGIN_NAME matches package name' });

  // ---- default export (the mount surface, rev6 cross-audit GATE-1) ---------
  // cordis.patch.yml mounts the plugin through its DEFAULT export: "DSH
  // resolves the entry by the Node-resolvable package name below ... then
  // calls its default `{ name, inject, Config, apply }` export"
  // (src/index.ts: `export const plugin = { name: PLUGIN_NAME, inject,
  // Config, apply }; export default plugin;`). A bundle that drops or
  // reshapes the default export would pass every named-export check above
  // while breaking exactly the mount path this gate exists to protect, so the
  // default object is asserted member-by-member against the named exports.
  const pluginDefault = namespace.default;
  if (pluginDefault === null || typeof pluginDefault !== 'object') {
    steps.push({
      step: 'default-export',
      ok: false,
      detail:
        'the default export is ' +
        (pluginDefault === null ? 'null' : typeof pluginDefault) +
        ', expected the { name, inject, Config, apply } plugin object (cordis.patch.yml mount contract)'
    });
    return outcome(false, false, freshness);
  }
  const expectedDefaultMembers = {
    name: namespace.PLUGIN_NAME,
    inject: namespace.inject,
    Config: namespace.Config,
    apply: namespace.apply
  };
  // Two failures, named separately: a member can be ABSENT from the default
  // object while the named export exists (the bundle dropped it), and an
  // absent member would otherwise compare `undefined === undefined` and pass
  // silently - exactly the shape of gap the round-2 audit found for `inject`.
  const absent = Object.keys(expectedDefaultMembers).filter((member) => !(member in pluginDefault));
  const drifted = Object.keys(expectedDefaultMembers).filter(
    (member) => member in pluginDefault && pluginDefault[member] !== expectedDefaultMembers[member]
  );
  if (absent.length > 0 || drifted.length > 0) {
    const problems = [];
    if (absent.length > 0) {
      problems.push('absent from the default export: ' + absent.join(', '));
    }
    if (drifted.length > 0) {
      problems.push('not matching the named exports: ' + drifted.join(', '));
    }
    steps.push({
      step: 'default-export',
      ok: false,
      detail:
        'default export member(s) ' +
        problems.join('; ') +
        ' (cordis.patch.yml default { name, inject, Config, apply })'
    });
    return outcome(false, false, freshness);
  }
  steps.push({
    step: 'default-export',
    ok: true,
    detail: 'default export is the { name, inject, Config, apply } plugin object matching the named exports'
  });

  // ---- rev8 dual-artifact: the MCP stdio entry (additive steps 6-8) ---------
  // The plugin surface above is asserted UNCHANGED first: a failure there
  // returns before the MCP steps, so the MCP steps can never mask a plugin
  // regression (and a caller that only cares about the plugin artifact sees
  // the same steps it always did).
  //
  // The artifact path is the CALLER's `cwd`, not this module's repo root:
  // smokeBuild({ cwd: dir }) must smoke dir's OWN second artifact - including
  // reporting its ABSENCE, which silently probed the repo root's artifact
  // before the path was scoped (a fixture without the dual build passed on
  // the strength of the repo's file). The repo path stays the default inside
  // runMcpSmokeSteps for the direct-CLI caller.
  runMcpSmokeSteps({ steps }, { artifactPath: mcpArtifactPath });
  return {
    ok: steps.every((step) => step.ok),
    steps,
    exportCount: names.length,
    bytes,
    mcpBytes: fs.existsSync(mcpArtifactPath) ? fs.statSync(mcpArtifactPath).size : 0,
    stale: false,
    freshness
  };
}

const isDirectExecution =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectExecution) {
  const wantsJson = process.argv.includes('--json');
  const skipBuild = process.argv.includes('--skip-build');
  const statusOnly = process.argv.includes('--status');
  try {
    if (statusOnly) {
      // `--status` answers ONLY the freshness question (no build, no import):
      // `stale: true` + `artifact: absent` for a missing lib/index.js, with
      // named reasons. Exit 1 when stale, so CI cannot read it as green.
      const status = computeBuildStatus({ cwd: rootDir });
      if (wantsJson) {
        console.log(JSON.stringify(status, null, 2));
      } else {
        for (const line of formatBuildStatus(status)) {
          console.log(line);
        }
        console.log('[build-smoke] stale: ' + String(status.stale));
        console.log('[build-smoke] artifact: ' + status.artifact);
      }
      if (status.stale) {
        process.exitCode = 1;
      }
    } else {
      const result = await smokeBuild({ skipBuild });
      if (wantsJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log('[build-smoke] artifact: lib/index.js (' + String(result.bytes) + ' bytes)');
        for (const step of result.steps) {
          console.log('[build-smoke] ' + (step.ok ? 'ok  ' : 'FAIL') + ' ' + step.step + ': ' + step.detail);
        }
        console.log('[build-smoke] stale: ' + String(result.stale));
        console.log(result.ok ? '[build-smoke] SUCCESS: the bundle builds and imports as ESM' : '[build-smoke] FAIL');
      }
      if (!result.ok) {
        process.exitCode = 1;
      }
    }
  } catch (error) {
    console.error('[build-smoke] unexpected error: ' + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
