#!/usr/bin/env node
/**
 * Bundle the host-smoke harness entry (P6.1-F).
 *
 * Why bundle at all: the smoke must run the *shipped* TypeScript sources, but
 * the installed DSH runtime is an Electron-as-node binary whose module resolver
 * has no access to this repository's `node_modules` layout (and must not: the
 * host packages have to come from the installation). esbuild converts the plugin
 * sources into one CJS file; the host packages are then resolved at runtime from
 * the asar by `scripts/host-smoke/run.mjs`.
 *
 * The output is written under the OS temp directory, never into the repository:
 * a build artifact in the tree would (a) be swept up by `tsc --noEmit`
 * project-wide typechecking and (b) look like a deliverable.
 *
 * Usage: node scripts/host-smoke/build-harness-entry.mjs [--out <file>]
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

/** Workspace-relative entry the manifest/report refer to. */
export const BUNDLE_ENTRY = 'tests/e2e/host-smoke/bundle-entry.ts';

/** Default output path (OS temp; never the repository). */
export function defaultOutFile() {
  return path.join(os.tmpdir(), 'dsh-evo-p61-host-smoke', 'harness.cjs');
}

async function main() {
  const outIndex = process.argv.indexOf('--out');
  const outFile = outIndex >= 0 && process.argv[outIndex + 1] !== undefined
    ? path.resolve(process.argv[outIndex + 1])
    : defaultOutFile();
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  const entry = path.join(repoRoot, BUNDLE_ENTRY);
  if (!fs.existsSync(entry)) {
    console.error('[host-smoke] bundle entry not found: ' + entry);
    process.exitCode = 1;
    return;
  }

  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    // The plugin's only runtime import outside its own sources is schemastery,
    // which the bundle must inline: the host runtime does not resolve the
    // repository's dev dependencies.
    outfile: outFile,
    logLevel: 'warning',
    sourcemap: false
  });

  const size = fs.statSync(outFile).size;
  console.log('[host-smoke] bundled ' + BUNDLE_ENTRY + ' -> ' + outFile + ' (' + String(size) + ' bytes)');
  // Machine-readable line the runner parses.
  console.log('HOSTSMOKE_BUNDLE=' + outFile);
}

await main();
