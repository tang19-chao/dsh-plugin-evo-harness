/**
 * rev8 dual-artifact build contract (plan §5.1/§5.6).
 *
 * WHAT THIS FILE PINS
 *   The build now produces TWO artifacts from one recipe:
 *     - lib/index.js        the plugin entry (unchanged: `main`/`exports`,
 *                           the default export the Cordis host mounts);
 *     - lib/mcp/server.js   the MCP stdio entry (src/mcp/server.ts bundled
 *                           ESM node20 with the same esbuild options).
 *   The stamp describes the second artifact ADDITIVELY (`artifactMcp` block,
 *   same {path, bytes, sha256} shape); every pre-existing stamp field and
 *   freshness reason keeps its exact semantics, and the MCP block's absence
 *   never makes a stamp stale BY ITSELF (only `requireMcpArtifact: true`
 *   adds the named `mcp-artifact-*` reasons).
 *
 * TEST DISCIPLINE (mirrors build-freshness.test.ts)
 *   - No real `pnpm run build` here (the workflow runs the full build): every
 *     fixture is a throw-away directory whose artifact bytes are synthetic
 *     module sources that import nothing and are built by esbuild IN THE
 *     FIXTURE via the same options build.mjs uses - so the probe exercises a
 *     REAL bundled artifact, not a string.
 *   - The import-purity probe runs in a CHILD PROCESS (spawnSync), exactly as
 *     scripts/eval/smoke-build.mjs runs it - no vitest transform involved.
 *   - The probe fixtures synthesize the three behaviours the gate must
 *     distinguish: (a) a pure module (import touches nothing), (b) a module
 *     that occupies stdin on import (a stdio transport started at module
 *     scope - the exact defect the guard in src/mcp/server.ts prevents),
 *     (c) a module that writes a data file on import.
 *   - Negative controls fail with their NAMED step; positive controls pass.
 *
 * Offline: no network, no model, no host, no paid API, no real build of the
 * repository (esbuild runs on fixture sources inside os.tmpdir() only).
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  BUILD_ARTIFACT_PATH,
  BUILD_MCP_ARTIFACT_PATH,
  BUILD_STAMP_PATH,
  BUILD_STAMP_SCHEMA_VERSION,
  buildStamp,
  computeBuildStatus,
  writeBuildStamp
} from '../../../scripts/build-manifest.mjs';
import { probeMcpImport, REQUIRED_MCP_EXPORTS, runMcpSmokeSteps } from '../../../scripts/eval/smoke-build.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

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

function track(dir: string): string {
  tempDirs.push(dir);
  return dir;
}

function sha256(bytes: Buffer | string): string {
  const crypto = require_('node:crypto') as { createHash: (algorithm: string) => { update: (data: Buffer | string) => { digest: (encoding: string) => string } } };
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** The require handle for CJS-only modules (esbuild, node:crypto helpers). */
const require_ = createRequire(import.meta.url);

/**
 * A fixture repository: src/ + package.json + both artifact slots. The two
 * artifact sources are REAL esbuild-bundled ESM modules (the same options
 * build.mjs uses), so the import probe observes a genuine bundle.
 *
 * `mcpArtifactSource` synthesizes the import-time behaviour under test; the
 * default is the pure module the real src/mcp/server.ts ships as.
 */
function makeFixture(options: { mcpArtifactSource?: string; withStamp?: boolean } = {}): string {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'dual-artifact-')));
  const files: Record<string, string> = {
    'src/index.ts': 'export const PLUGIN_NAME = "fixture";\nexport default { name: PLUGIN_NAME };\n',
    'src/mcp/server.ts': options.mcpArtifactSource ?? PURE_MCP_FIXTURE,
    'package.json': '{"name":"fixture","type":"module"}\n'
  };
  for (const [relative, text] of Object.entries(files)) {
    const absolute = path.join(dir, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, text, 'utf8');
  }
  // Build both fixtures with the SAME esbuild options scripts/build.mjs uses
  // (bundle ESM node20, external sourcemap) so the probe sees a real bundle.
  const esbuild = require_(path.join(repoRoot, 'node_modules', 'esbuild')) as {
    buildSync: (options: Record<string, unknown>) => unknown;
  };
  for (const [entryRel, outRel] of [
    ['src/index.ts', BUILD_ARTIFACT_PATH],
    ['src/mcp/server.ts', BUILD_MCP_ARTIFACT_PATH]
  ] as const) {
    esbuild.buildSync({
      entryPoints: [path.join(dir, entryRel)],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      outfile: path.join(dir, outRel),
      sourcemap: 'external',
      logLevel: 'silent'
    });
  }
  if (options.withStamp !== false) {
    writeBuildStamp({ cwd: dir });
  }
  return dir;
}

/** The pure MCP-entry fixture: named exports, NO import-time side effects. */
const PURE_MCP_FIXTURE = [
  'export const EVO_MCP_SERVER_NAME = "evo";',
  'export const EVO_TOOL_NAMES = ["evo_status"];',
  'export function createEvoMcpServer() { return {}; }',
  'export function serveEvoMcpStdio() { return { close: async () => undefined }; }',
  ''
].join('\n');

/** The DEFECT fixture: starts a stdio transport at module scope. */
const STDIO_OCCUPYING_MCP_FIXTURE = [
  'process.stdin.on("data", () => {});',
  ...PURE_MCP_FIXTURE.split('\n'),
  ''
].join('\n');

/** The DEFECT fixture: writes into the current directory on import. */
const DATA_WRITING_MCP_FIXTURE = [
  'import fs from "node:fs";',
  'import path from "node:path";',
  'fs.mkdirSync(path.join(process.cwd(), "evo-harness-data"), { recursive: true });',
  'fs.writeFileSync(path.join(process.cwd(), "evo-harness-data", "runtime.json"), "{}", "utf8");',
  ...PURE_MCP_FIXTURE.split('\n'),
  ''
].join('\n');

describe('stamp: the artifactMcp block is additive (rev8 dual-artifact)', () => {
  it('describes both artifacts with the same {path, bytes, sha256} shape', () => {
    const dir = makeFixture();
    const stamp = writeBuildStamp({ cwd: dir });
    expect(stamp.artifactMcp).not.toBeNull();
    expect(stamp.artifactMcp).toMatchObject({
      path: BUILD_MCP_ARTIFACT_PATH,
      bytes: fs.statSync(path.join(dir, BUILD_MCP_ARTIFACT_PATH)).size
    });
    const mcpBlock: { sha256: string } | null = stamp.artifactMcp;
    expect(mcpBlock?.sha256).toBe(sha256(fs.readFileSync(path.join(dir, BUILD_MCP_ARTIFACT_PATH))));
    // The primary block keeps its exact shape and path.
    expect(stamp.artifact).toMatchObject({ path: BUILD_ARTIFACT_PATH });
    expect(stamp.schemaVersion).toBe(BUILD_STAMP_SCHEMA_VERSION);
  });

  it('keeps every pre-existing field readable and the fixture FRESH without requireMcpArtifact', () => {
    const dir = makeFixture();
    const status = computeBuildStatus({ cwd: dir });
    expect(status.stale, JSON.stringify(status.reasons)).toBe(false);
    expect(status.reasons).toEqual([]);
    expect(status.artifact).toBe('present');
    expect(status.artifactMcp).toBe('present');
    expect(status.commit.matches).toBeNull(); // no git in the fixture
  });

  it('a PRE-rev8 stamp (no artifactMcp key at all) still reads fresh - old stamps are not invalidated', () => {
    const dir = makeFixture({ withStamp: false });
    const stamp = buildStamp({ cwd: dir }) as unknown as Record<string, unknown>;
    delete stamp.artifactMcp;
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, BUILD_STAMP_PATH), JSON.stringify(stamp, null, 2) + '\n', 'utf8');
    const status = computeBuildStatus({ cwd: dir });
    expect(status.stale, JSON.stringify(status.reasons)).toBe(false);
    expect(status.reasons).toEqual([]);
  });

  it('a stamp with a MALFORMED artifactMcp block is stamp-invalid (fail-closed)', () => {
    const dir = makeFixture({ withStamp: false });
    const stamp = buildStamp({ cwd: dir }) as unknown as Record<string, unknown>;
    stamp.artifactMcp = { path: BUILD_MCP_ARTIFACT_PATH, bytes: 'not-a-number', sha256: 'zz' };
    fs.writeFileSync(path.join(dir, BUILD_STAMP_PATH), JSON.stringify(stamp, null, 2) + '\n', 'utf8');
    const status = computeBuildStatus({ cwd: dir });
    expect(status.stale).toBe(true);
    expect(status.reasons).toContain('stamp-invalid');
  });

  it('requireMcpArtifact adds mcp-artifact-missing ONLY for the absent second artifact (primary stays fresh)', () => {
    const dir = makeFixture({ withStamp: false });
    // Stamp describes both; then the MCP artifact is deleted.
    writeBuildStamp({ cwd: dir });
    fs.rmSync(path.join(dir, BUILD_MCP_ARTIFACT_PATH));
    const strict = computeBuildStatus({ cwd: dir, requireMcpArtifact: true });
    expect(strict.stale).toBe(true);
    expect(strict.reasons).toContain('mcp-artifact-missing');
    expect(strict.reasons).not.toContain('artifact-missing');
    expect(strict.reasons).not.toContain('src-tree-mismatch');
    // The DEFAULT call keeps the pre-rev8 semantics: NOT stale.
    const legacy = computeBuildStatus({ cwd: dir });
    expect(legacy.stale).toBe(false);
    expect(legacy.reasons).toEqual([]);
  });

  it('requireMcpArtifact catches a replaced MCP artifact (mcp-artifact-mismatch), including a pre-rev8 stamp', () => {
    // Case 1: the stamp describes the MCP artifact, the file changed after.
    const dir = makeFixture({ withStamp: false });
    writeBuildStamp({ cwd: dir });
    fs.writeFileSync(path.join(dir, BUILD_MCP_ARTIFACT_PATH), 'export const drifted = true;\n', 'utf8');
    const strict = computeBuildStatus({ cwd: dir, requireMcpArtifact: true });
    expect(strict.stale).toBe(true);
    expect(strict.reasons).toContain('mcp-artifact-mismatch');
    expect(strict.reasons).not.toContain('artifact-mismatch');

    // Case 2: the MCP file EXISTS but the stamp predates the block entirely.
    const dir2 = makeFixture({ withStamp: false });
    const stamp = buildStamp({ cwd: dir2 }) as unknown as Record<string, unknown>;
    delete stamp.artifactMcp;
    fs.writeFileSync(path.join(dir2, BUILD_STAMP_PATH), JSON.stringify(stamp, null, 2) + '\n', 'utf8');
    const strict2 = computeBuildStatus({ cwd: dir2, requireMcpArtifact: true });
    expect(strict2.stale).toBe(true);
    expect(strict2.reasons).toContain('mcp-artifact-mismatch');
  });
});

describe('import-purity probe: the child-process contract (rev8)', () => {
  it('the REAL pure MCP entry exports the documented surface and stays import-pure', async () => {
    // The fixture bundles the PURE source through the same esbuild options the
    // production build uses, so this exercises a real bundle, not a string.
    const dir = makeFixture();
    const mcpArtifact = path.join(dir, BUILD_MCP_ARTIFACT_PATH);
    const probe = probeMcpImport(mcpArtifact);
    expect(probe.ok, probe.detail).toBe(true);
    const parsed = probe.parsed;
    expect(parsed, probe.detail).not.toBeNull();
    for (const name of REQUIRED_MCP_EXPORTS) {
      expect(parsed?.exportNames, 'missing export ' + name).toContain(name);
    }
    expect(parsed?.stdinHasDataListeners).toBe(false);
    expect(parsed?.stdinFlowingChanged).toBe(false);
    expect(parsed?.filesCreated).toEqual([]);
  });

  it('catches a module that occupies stdin on import (the stdio-transport-at-import defect)', () => {
    const dir = makeFixture({ mcpArtifactSource: STDIO_OCCUPYING_MCP_FIXTURE });
    const steps: { step: string; ok: boolean; detail: string }[] = [];
    const result = runMcpSmokeSteps({ steps }, { artifactPath: path.join(dir, BUILD_MCP_ARTIFACT_PATH) });
    expect(result.ok).toBe(false);
    const purity = steps.find((step) => step.step === 'mcp-import-pure');
    expect(purity?.ok).toBe(false);
    expect(purity?.detail).toContain('data listener to stdin');
  });

  it('catches a module that creates a data directory on import (cwd-relative writes land in the watched scratch dir)', () => {
    const dir = makeFixture({ mcpArtifactSource: DATA_WRITING_MCP_FIXTURE });
    const steps: { step: string; ok: boolean; detail: string }[] = [];
    const result = runMcpSmokeSteps({ steps }, { artifactPath: path.join(dir, BUILD_MCP_ARTIFACT_PATH) });
    expect(result.ok).toBe(false);
    const purity = steps.find((step) => step.step === 'mcp-import-pure');
    expect(purity?.ok).toBe(false);
    expect(purity?.detail).toContain('created files in the scratch data dir');
    expect(purity?.detail).toContain('evo-harness-data');
    // The probe's child runs with cwd=scratch, so NOTHING leaks into the repo
    // or the fixture dir (the pre-fix probe polluted the repo root).
    expect(fs.existsSync(path.join(repoRoot, 'evo-harness-data'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'evo-harness-data'))).toBe(false);
  });

  it('reports a named failure for an artifact that cannot be imported at all', () => {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'dual-artifact-broken-')));
    fs.mkdirSync(path.dirname(path.join(dir, BUILD_MCP_ARTIFACT_PATH)), { recursive: true });
    fs.writeFileSync(path.join(dir, BUILD_MCP_ARTIFACT_PATH), 'export const broken = (((;\n', 'utf8');
    const probe = probeMcpImport(path.join(dir, BUILD_MCP_ARTIFACT_PATH));
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain('import failed or stdout was not a single JSON object');
  });

  it('the runMcpSmokeSteps happy path runs all four mcp steps on the fixture bundle', () => {
    const dir = makeFixture();
    const steps: { step: string; ok: boolean; detail: string }[] = [];
    const result = runMcpSmokeSteps({ steps }, { artifactPath: path.join(dir, BUILD_MCP_ARTIFACT_PATH) });
    const stepNames = steps.map((step) => step.step);
    expect(stepNames).toEqual([
      'mcp-artifact-exists',
      'mcp-entry-loadable',
      'mcp-entry-exports',
      'mcp-import-pure'
    ]);
    expect(result.ok).toBe(true);
  });

  it('runMcpSmokeSteps with no override reports the REPO artifact honestly when absent', () => {
    // No artifact path override: the function must look at the repo's
    // lib/mcp/server.js and report its ACTUAL state, never a fabricated skip.
    const steps: { step: string; ok: boolean; detail: string }[] = [];
    const repoArtifact = path.join(repoRoot, BUILD_MCP_ARTIFACT_PATH);
    const exists = fs.existsSync(repoArtifact);
    const result = runMcpSmokeSteps({ steps });
    if (!exists) {
      expect(result.ok).toBe(false);
      expect(steps[0]?.step).toBe('mcp-artifact-exists');
      expect(steps[0]?.ok).toBe(false);
    } else {
      expect(steps[0]?.step).toBe('mcp-artifact-exists');
      expect(steps[0]?.ok).toBe(true);
    }
  });
});

describe('the repository artifacts themselves (fresh from the current src tree)', () => {
  /**
   * The REAL repository build is run by the workflow; this block asserts the
   * artifacts on disk right now. If lib/ has not been built yet the block
   * reports the absence honestly instead of faking a skip.
   */
  it('lib/mcp/server.js exists, is loadable and import-pure (when the repo is built)', () => {
    const mcpArtifact = path.join(repoRoot, BUILD_MCP_ARTIFACT_PATH);
    if (!fs.existsSync(mcpArtifact)) {
      // Honest skip: the dual-artifact build has not run in this checkout yet.
      // Reported as a failure named for what it is, not a silent pass.
      throw new Error('lib/mcp/server.js is absent - run `pnpm run build` (dual-artifact) before this suite');
    }
    const probe = probeMcpImport(mcpArtifact);
    expect(probe.ok, probe.detail).toBe(true);
    const parsed = probe.parsed;
    expect(parsed, probe.detail).not.toBeNull();
    for (const name of REQUIRED_MCP_EXPORTS) {
      expect(parsed?.exportNames, 'missing export ' + name).toContain(name);
    }
    expect(parsed?.stdinHasDataListeners).toBe(false);
    expect(parsed?.stdinFlowingChanged).toBe(false);
    expect(parsed?.filesCreated).toEqual([]);
  });

  it('the repo stamp (when present) describes both artifacts; its absence is not faked', () => {
    const stampPath = path.join(repoRoot, BUILD_STAMP_PATH);
    if (!fs.existsSync(stampPath)) {
      throw new Error('lib/build-stamp.json is absent - run `pnpm run build` before this suite');
    }
    const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
    expect(stamp.kind).toBe('build-stamp');
    // After the dual-artifact build both blocks are described.
    expect(stamp.artifact?.path).toBe(BUILD_ARTIFACT_PATH);
    expect(stamp.artifactMcp?.path).toBe(BUILD_MCP_ARTIFACT_PATH);
    expect(stamp.artifactMcp?.sha256).toBe(sha256(fs.readFileSync(path.join(repoRoot, BUILD_MCP_ARTIFACT_PATH))));
  });
});

describe('the direct-execution guard in src/mcp/server.ts', () => {
  it('importing the bundled artifact does NOT start the stdio server (source-level guard pinned)', async () => {
    // The source itself pins the guard: importing must never call main().
    // This reads the SOURCE (not the bundle) so the guard cannot be silently
    // deleted while the bundle keeps passing.
    const source = fs.readFileSync(path.join(repoRoot, 'src', 'mcp', 'server.ts'), 'utf8');
    expect(source).toContain('invokedDirectly');
    expect(source).toMatch(/import\.meta\.url === entryUrl/);
    // The guard is what makes the probe's purity assertion possible at all.
    expect(source).toMatch(/if \(invokedDirectly\)\s*\{\s*main\(\);\s*\}/);
  });

  it('node lib/mcp/server.js IS the server path: a bare spawn starts stdio (out of scope here)', () => {
    // Documented non-goal: starting the real server needs a scripted MCP
    // client and is covered by tests/mcp/handshake.test.ts. This test only
    // pins that the ASK's requirement ("stdio occupation must be checked for
    // import") is about IMPORT, not about a deliberate run.
    const source = fs.readFileSync(path.join(repoRoot, 'src', 'mcp', 'server.ts'), 'utf8');
    expect(source).toContain('export function main()');
  });
});
