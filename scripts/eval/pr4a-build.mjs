/**
 * Build wrapper for the PR-4A entry points.
 *
 * The evaluation library is TypeScript that Node cannot load directly (see
 * build-eval.mjs for the full rationale: non-erasable syntax in transitively
 * imported modules). The PR-4A modules therefore reuse the SAME
 * content-addressed esbuild cache instead of inventing a second mechanism, so
 * "how the eval code is loaded" stays a single documented fact.
 *
 * `loadPr4aLib` / `loadPr4aReport` return the compiled artifact's
 * `bundleFingerprint` alongside the module namespace. The cache key is a SHA-256
 * over every TypeScript source the bundle can reach plus the esbuild version,
 * Node target and bundling mode, so it identifies the EXACT compiled artifact
 * that produced the numbers — the second half of "which code ran", next to the
 * per-source working-tree digests the report already prints.
 */

import { buildEvalLib, REPO_ROOT } from './build-eval.mjs';

export { REPO_ROOT };
import { join } from 'node:path';

/** Build (or reuse) the compiled PR-4A engine and import it. */
export async function loadPr4aLib() {
  const { outfile, digest, mode, esbuildVersion, rebuilt } = await buildEvalLib({
    entry: join(REPO_ROOT, 'scripts', 'eval', 'pr4a-five-arm-lib.ts'),
    name: 'pr4a-five-arm-lib'
  });
  const { pathToFileURL } = await import('node:url');
  const namespace = await import(pathToFileURL(outfile).href);
  return {
    ...namespace,
    bundleFingerprint: {
      entry: 'scripts/eval/pr4a-five-arm-lib.ts',
      artifact: outfile,
      digest,
      mode,
      esbuildVersion,
      rebuilt
    }
  };
}

/** Build (or reuse) the compiled PR-4A report module and import it. */
export async function loadPr4aReport() {
  const { outfile, digest, mode, esbuildVersion, rebuilt } = await buildEvalLib({
    entry: join(REPO_ROOT, 'scripts', 'eval', 'pr4a-report.ts'),
    name: 'pr4a-report'
  });
  const { pathToFileURL } = await import('node:url');
  const namespace = await import(pathToFileURL(outfile).href);
  return {
    ...namespace,
    bundleFingerprint: {
      entry: 'scripts/eval/pr4a-report.ts',
      artifact: outfile,
      digest,
      mode,
      esbuildVersion,
      rebuilt
    }
  };
}
