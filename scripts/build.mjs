#!/usr/bin/env node
/**
 * Canonical build entry point (rev5 P0-5).
 *
 * `pnpm run build` runs THIS script rather than a bare esbuild command so a
 * successful build always leaves two pieces of evidence next to the artifact:
 *
 *   1. `lib/index.js`          - the ESM bundle (`main`/`exports` of package.json);
 *   2. `lib/build-stamp.json`  - `srcTreeSha256` (the frozen recipe documented in
 *                                `scripts/build-manifest.mjs`), the file count and
 *                                per-file digests, plus the HEAD commit the build
 *                                was made at and the artifact's own sha256/bytes.
 *
 * WHY: an artifact without a stamp cannot be distinguished from a stale one.
 * `pnpm run check:build-smoke` refuses a `lib/index.js` whose stamp does not
 * describe the current `src/` tree, so "build once, edit src, forget to
 * rebuild, smoke test passes" is no longer a green outcome.
 *
 * The esbuild options are byte-for-byte the ones package.json used before this
 * script existed (bundle ESM, node20, external sourcemap, warning log level), so
 * the artifact bytes and the public surface are unchanged. No network, no host,
 * no model.
 *
 * Usage: node scripts/build.mjs   (also runs as `pnpm run build` / `prepare`)
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_ARTIFACT_PATH, BUILD_STAMP_PATH, writeBuildStamp } from './build-manifest.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const esbuild = require('esbuild');

async function main() {
  const outfile = path.join(rootDir, BUILD_ARTIFACT_PATH);
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(rootDir, 'src', 'index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile,
    sourcemap: 'external',
    logLevel: 'warning'
  });

  const stamp = writeBuildStamp({ cwd: rootDir });
  const stampPath = path.join(rootDir, BUILD_STAMP_PATH);
  console.log('[build] artifact: ' + BUILD_ARTIFACT_PATH + ' (' + String(stamp.artifact?.bytes ?? 0) + ' bytes)');
  console.log('[build] srcTreeSha256: ' + stamp.srcTreeSha256 + ' (' + String(stamp.srcFileCount) + ' src/**/*.ts files)');
  console.log('[build] commit: ' + (stamp.commit ?? 'unavailable (' + String(stamp.commitError) + ')'));
  console.log('[build] stamp: ' + path.relative(rootDir, stampPath).split(path.sep).join('/'));
}

await main();
