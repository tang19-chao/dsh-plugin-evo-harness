#!/usr/bin/env node
/**
 * Canonical build entry point (rev5 P0-5; rev8 dual-artifact).
 *
 * `pnpm run build` runs THIS script rather than a bare esbuild command so a
 * successful build always leaves evidence next to the artifacts:
 *
 *   1. `lib/index.js`          - the ESM bundle (`main`/`exports` of package.json),
 *                                the plugin entry the Cordis host mounts;
 *   2. `lib/mcp/server.js`     - (rev8, second entry) the MCP stdio server bundle
 *                                (src/mcp/server.ts), ESM node20, same options;
 *   3. `lib/build-stamp.json`  - `srcTreeSha256` (the frozen recipe documented in
 *                                `scripts/build-manifest.mjs`), the file count and
 *                                per-file digests, plus the HEAD commit the build
 *                                was made at and each artifact's own sha256/bytes
 *                                (the second artifact in the additive
 *                                `artifactMcp` block).
 *
 * WHY: an artifact without a stamp cannot be distinguished from a stale one.
 * `pnpm run check:build-smoke` refuses a `lib/index.js` whose stamp does not
 * describe the current `src/` tree, so "build once, edit src, forget to
 * rebuild, smoke test passes" is no longer a green outcome.
 *
 * The esbuild options are byte-for-byte the ones package.json used before this
 * script existed (bundle ESM, node20, external sourcemap, warning log level), so
 * the artifact bytes and the public surface are unchanged. The rev8 second entry
 * reuses EXACTLY the same options: both artifacts are standalone ESM bundles for
 * Node 20 (the @modelcontextprotocol/server dependency is inlined into
 * lib/mcp/server.js by the same bundle step - the plugin bundle already inlines
 * its dependencies, and neither entry is `external`). No network, no host,
 * no model.
 *
 * Usage: node scripts/build.mjs   (also runs as `pnpm run build` / `prepare`)
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILD_ARTIFACT_PATH,
  BUILD_MCP_ARTIFACT_PATH,
  BUILD_STAMP_PATH,
  writeBuildStamp
} from './build-manifest.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const esbuild = require('esbuild');

/**
 * The build recipe: one shared set of esbuild options over the two entry
 * points. Order matters for evidence: the plugin artifact is built FIRST with
 * the byte-identical options it has always had, so a failure in the new second
 * entry can never leave the plugin artifact missing (the pre-rev8 failure
 * shape).
 */
const BUILD_ENTRIES = Object.freeze([
  { entry: path.join(rootDir, 'src', 'index.ts'), outfile: BUILD_ARTIFACT_PATH },
  { entry: path.join(rootDir, 'src', 'mcp', 'server.ts'), outfile: BUILD_MCP_ARTIFACT_PATH }
]);

/** Resolved absolute outfile for a POSIX-relative artifact path. */
function outfileOf(relativeOutfile) {
  return path.join(rootDir, relativeOutfile);
}

/** Build one entry; returns the artifact's own size in bytes. */
async function buildEntry({ entry, outfile }) {
  const absoluteOutfile = outfileOf(outfile);
  fs.mkdirSync(path.dirname(absoluteOutfile), { recursive: true });
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: absoluteOutfile,
    sourcemap: 'external',
    logLevel: 'warning'
  });
  return fs.statSync(absoluteOutfile).size;
}

/**
 * Build both artifacts and write the stamp. Exported for tests; the CLI path
 * below stays the single production caller.
 *
 * @returns {Promise<{stamp: any, artifacts: {outfile: string, bytes: number}[]}>}
 */
export async function buildArtifacts() {
  /** @type {{outfile: string, bytes: number}[]} */
  const artifacts = [];
  for (const entrySpec of BUILD_ENTRIES) {
    artifacts.push({ outfile: entrySpec.outfile, bytes: await buildEntry(entrySpec) });
  }
  const stamp = writeBuildStamp({ cwd: rootDir });
  return { stamp, artifacts };
}

async function main() {
  const { stamp, artifacts } = await buildArtifacts();
  const stampPath = path.join(rootDir, BUILD_STAMP_PATH);
  for (const artifact of artifacts) {
    console.log('[build] artifact: ' + artifact.outfile + ' (' + String(artifact.bytes) + ' bytes)');
  }
  console.log('[build] srcTreeSha256: ' + stamp.srcTreeSha256 + ' (' + String(stamp.srcFileCount) + ' src/**/*.ts files)');
  console.log('[build] commit: ' + (stamp.commit ?? 'unavailable (' + String(stamp.commitError) + ')'));
  console.log('[build] stamp: ' + path.relative(rootDir, stampPath).split(path.sep).join('/'));
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  await main();
}
