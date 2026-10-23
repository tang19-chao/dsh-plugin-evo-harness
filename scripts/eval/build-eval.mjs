#!/usr/bin/env node
/**
 * Build cache for the evaluation CLIs (P6 PR1 / plan section 4 R7).
 *
 * Why this exists: `scripts/eval-jitrl.mjs` used to `import()` the TypeScript
 * evaluation library directly and rely on Node 22's implicit type stripping.
 * That only works for erasable syntax, and the library transitively reaches
 * `src/dsh-bridge/branch.ts`, whose constructor uses TypeScript **parameter
 * properties** - a non-erasable construct. Node then fails before the protocol
 * starts:
 *
 *   SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]:
 *   TypeScript parameter property is not supported in strip-only mode
 *
 * Passing `--experimental-transform-types` fixes that one invocation, but the
 * documented command (`node scripts/eval-jitrl.mjs --json`) must work as
 * written, with no hidden flag. So the CLI now pre-compiles the evaluation
 * library with the esbuild that is already a devDependency, then imports the
 * compiled artifact. Node never sees TypeScript, so the supported-version
 * matrix no longer depends on a strip-only detail.
 *
 * The artifact is content-addressed: the cache key is a SHA-256 over every
 * TypeScript source the bundle can reach (src/** and scripts/eval/**), plus the
 * esbuild version, the Node target and package.json (dependency resolution can
 * change the output). A stale cache is therefore impossible without a matching
 * key, and no timestamp heuristics are involved.
 *
 * The compiled file lives under `node_modules/.cache/dsh-plugin-evo-harness/`
 * so it is ignored by git and sits inside the package resolution root, which
 * lets esbuild leave npm dependencies external and resolve them at runtime from
 * the repository's own node_modules.
 *
 * Portability of an overridden cache directory (P6 PR1-L1): `DSH_EVAL_CACHE_DIR`
 * may point anywhere, but a directory outside this repository's `node_modules`
 * has no bare-specifier resolution root, so an artifact that keeps npm
 * dependencies external would die with ERR_MODULE_NOT_FOUND. The bundling
 * strategy therefore follows the cache location - 'external' inside the
 * node_modules tree (the default, and what CI runs), 'self-contained' anywhere
 * else (dependencies inlined, ~3.5MB, importable from any directory). The mode
 * is part of the cache key, so the two variants never collide.
 *
 * Usage:
 *   import { loadEvalLib } from './build-eval.mjs'   // build-if-stale + import
 *   node scripts/eval/build-eval.mjs                 // build only, print path
 *   node scripts/eval/build-eval.mjs --print-path    // same, machine readable
 */

import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');
export const EVAL_LIB_ENTRY = join(HERE, 'jitrl-eval-lib.ts');

/** Node target for the artifact: matches package.json engines (>=20.19.0). */
const NODE_TARGET = 'node20';

/** Cache directory: inside node_modules so it is gitignored and resolvable. */
export function defaultCacheDir() {
  const override = process.env.DSH_EVAL_CACHE_DIR;
  return override === undefined || override.length === 0
    ? join(REPO_ROOT, 'node_modules', '.cache', 'dsh-plugin-evo-harness')
    : resolve(override);
}

/**
 * Whether an artifact written into `cacheDir` can resolve bare specifiers at
 * runtime, i.e. whether the directory sits inside this repository's
 * `node_modules` tree.
 *
 * This decides the bundling strategy (see `bundlingMode`). The documented
 * default (`<repo>/node_modules/.cache/dsh-plugin-evo-harness`) is inside the
 * tree, so npm dependencies stay external and the artifact stays small. An
 * override such as `DSH_EVAL_CACHE_DIR` pointing outside the tree has no
 * `node_modules` on its resolution chain, so external imports there fail with
 * ERR_MODULE_NOT_FOUND; those directories get a self-contained bundle instead.
 */
function isInsideRepositoryNodeModules(cacheDir) {
  const modulesRoot = join(REPO_ROOT, 'node_modules') + sep;
  const normalized = resolve(cacheDir) + sep;
  // Case-insensitive on Windows, case-sensitive elsewhere.
  const left = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  const right = process.platform === 'win32' ? modulesRoot.toLowerCase() : modulesRoot;
  return left.startsWith(right);
}

/**
 * Bundling strategy for an artifact.
 *
 *   'external'  - npm dependencies are imported at runtime from this repo's
 *                 node_modules. Small artifact, but only correct when the
 *                 cache directory can resolve them.
 *   'self-contained' - npm dependencies are inlined into the artifact, so the
 *                 file works from any directory (temp dirs, other drives).
 *                 Slightly larger artifact (~3.4MB -> ~3.5MB) and a little
 *                 slower to import; the default path deliberately avoids it.
 *
 * Trade-off: we could always bundle and drop the mode switch, but the default
 * path is the hot path (every CLI run and every CI run), and keeping npm
 * dependencies external there preserves byte-identical behaviour with the
 * reviewed PR1 implementation and a smaller artifact. The switch costs nothing
 * at runtime and removes the "move the cache dir and it breaks" failure.
 */
function bundlingMode(cacheDir) {
  return isInsideRepositoryNodeModules(cacheDir) ? 'external' : 'self-contained';
}

/** Recursively collect `.ts` files below `dir` (sorted, POSIX-relative). */
function collectTypeScriptSources(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
          continue;
        }
        walk(absolute);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        found.push(absolute);
      }
    }
  };
  walk(dir);
  return found.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * Content fingerprint of everything the bundle's output depends on.
 *
 * Sources are hashed by repository-relative POSIX path plus bytes, so renaming
 * a file invalidates the cache exactly like editing it does. Tests are excluded
 * (they never enter the bundle), but the whole of `src/**` is included because
 * the evaluation library imports the plugin entry point.
 *
 * The bundling mode is part of the key: 'external' and 'self-contained' produce
 * different bytes from the same sources, so they must never share a filename.
 */
function fingerprint(entry, mode) {
  const hash = createHash('sha256');
  const sources = [
    ...collectTypeScriptSources(join(REPO_ROOT, 'src')),
    ...collectTypeScriptSources(HERE)
  ];
  for (const file of sources) {
    const key = relative(REPO_ROOT, file).split(sep).join('/');
    hash.update('file\0' + key + '\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  const packageJson = join(REPO_ROOT, 'package.json');
  hash.update('package.json\0' + readFileSync(packageJson, 'utf8') + '\0');
  hash.update('entry\0' + relative(REPO_ROOT, entry).split(sep).join('/') + '\0');
  hash.update('target\0' + NODE_TARGET + '\0');
  hash.update('mode\0' + mode + '\0');
  return hash.digest('hex');
}

/**
 * Prune older artifacts of the same entry so the cache cannot grow forever.
 *
 * Two rules, both race-safe:
 *   - anything older than a day is removed; and
 *   - beyond `MAX_ARTIFACTS` the oldest leftovers are removed once they are at
 *     least `QUIET_AGE_MS` old.
 *
 * The age guards matter: a concurrent process may be between `build` and
 * `import` with an artifact of a *different* fingerprint (a test worker and a
 * shell command racing on different sources), and deleting that file would
 * turn a benign race into a hard failure. A CLI run takes a few seconds, so an
 * artifact untouched for minutes is provably not in that window.
 */
const PRUNE_AGE_MS = 24 * 60 * 60 * 1000;
const QUIET_AGE_MS = 5 * 60 * 1000;
const MAX_ARTIFACTS = 12;

function pruneStaleArtifacts(cacheDir, prefix, keep) {
  let entries;
  try {
    entries = readdirSync(cacheDir);
  } catch {
    return;
  }
  const now = Date.now();
  const candidates = [];
  for (const name of entries) {
    if (name === keep || !name.startsWith(prefix) || !name.endsWith('.mjs')) {
      continue;
    }
    const absolute = join(cacheDir, name);
    try {
      candidates.push({ absolute, ageMs: now - statSync(absolute).mtimeMs });
    } catch {
      // Vanished between readdir and stat: nothing to do.
    }
  }
  // Oldest first: index 0 is the oldest artifact, the last index is the newest.
  // Pruning must delete from the *front* of this order - deleting the youngest
  // would throw away the artifacts most likely to be reused (the current
  // fingerprint's neighbours) while stale ones accumulate forever.
  candidates.sort((left, right) => right.ageMs - left.ageMs);
  for (let index = 0; index < candidates.length; index += 1) {
    const { absolute, ageMs } = candidates[index];
    const tooOld = ageMs > PRUNE_AGE_MS;
    // `keep` is already excluded from `candidates`, so it counts as one of the
    // retained files: the cache may hold MAX_ARTIFACTS-1 spares plus `keep`.
    const overCap = candidates.length > MAX_ARTIFACTS - 1 && index < candidates.length - (MAX_ARTIFACTS - 1);
    if (!tooOld && !(overCap && ageMs > QUIET_AGE_MS)) {
      continue;
    }
    try {
      rmSync(absolute, { force: true });
    } catch {
      // Another process may be reading it; leaving it is safe.
    }
  }
}

/**
 * Build (or reuse) the compiled evaluation library and return its absolute
 * path. Throws with an actionable message if esbuild is missing.
 */
export async function buildEvalLib(options = {}) {
  const entry = options.entry ?? EVAL_LIB_ENTRY;
  const name = options.name ?? 'jitrl-eval-lib';
  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch (error) {
    throw new Error(
      'esbuild is required to precompile the evaluation library (it is a devDependency). ' +
        'Run `pnpm install` first. Original error: ' +
        (error instanceof Error ? error.message : String(error))
    );
  }

  const cacheDir = options.cacheDir ?? defaultCacheDir();
  mkdirSync(cacheDir, { recursive: true });
  const mode = options.mode ?? bundlingMode(cacheDir);
  const digest = fingerprint(entry, mode);
  const prefix = name + '.';
  const outfile = join(cacheDir, prefix + digest.slice(0, 20) + '.mjs');

  let rebuilt = false;
  let existed = true;
  try {
    statSync(outfile);
  } catch {
    existed = false;
  }
  if (!existed) {
    // Build to a process-unique sibling first, then rename. Two concurrent CLIs
    // (a test worker and a shell command) then cannot observe a half-written
    // artifact; duplicate work of an identical build is harmless.
    const temporary = outfile + '.' + String(process.pid) + '.tmp';
    try {
      await esbuild.build({
        absWorkingDir: REPO_ROOT,
        entryPoints: [entry],
        outfile: temporary,
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: NODE_TARGET,
        // npm dependencies stay external only when the artifact can resolve
        // them (cache dir inside this repo's node_modules); anywhere else they
        // are inlined so the file is self-contained.
        packages: mode === 'external' ? 'external' : 'bundle',
        // Keep stack traces readable: failures should point at the .ts sources.
        sourcemap: 'inline',
        legalComments: 'none',
        logLevel: 'silent'
      });
    } catch (error) {
      rmSync(temporary, { force: true });
      // `logLevel: 'silent'` suppresses esbuild's own pretty-printer, so a
      // syntax error would otherwise surface as a bare message. Re-print the
      // structured diagnostics here: a broken source file must be obvious.
      const diagnostics = Array.isArray(error?.errors) ? error.errors : [];
      const detail = diagnostics
        .map((entry) => {
          const where = entry.location
            ? relative(REPO_ROOT, entry.location.file).split(sep).join('/') + ':' + String(entry.location.line)
            : '(unknown location)';
          return '  ' + where + ': ' + String(entry.text ?? 'build error');
        })
        .join('\n');
      throw new Error(
        'failed to precompile the evaluation library with esbuild' +
          (detail.length > 0 ? ':\n' + detail : ': ' + (error instanceof Error ? error.message : String(error)))
      );
    }
    try {
      renameSync(temporary, outfile);
      rebuilt = true;
    } catch (error) {
      // A concurrent process may have produced the same content-addressed file.
      rmSync(temporary, { force: true });
      try {
        statSync(outfile);
      } catch {
        throw error;
      }
    }
  }
  pruneStaleArtifacts(cacheDir, prefix, prefix + digest.slice(0, 20) + '.mjs');
  return { outfile, rebuilt, digest, cacheDir, mode, esbuildVersion: esbuild.version };
}

/** Build if stale, then import the compiled evaluation library. */
export async function loadEvalLib(options = {}) {
  const { outfile } = await buildEvalLib(options);
  return import(pathToFileURL(outfile).href);
}

/** Write a small provenance stamp next to the artifact (debugging aid only). */
function writeStamp(result, entry) {
  const stamp = {
    entry: relative(REPO_ROOT, entry).split(sep).join('/'),
    artifact: relative(REPO_ROOT, result.outfile).split(sep).join('/'),
    digest: result.digest,
    mode: result.mode,
    esbuild: result.esbuildVersion,
    nodeTarget: NODE_TARGET,
    generatedAt: new Date().toISOString()
  };
  writeFileSync(join(result.cacheDir, 'last-build.json'), JSON.stringify(stamp, null, 2) + '\n', 'utf8');
  return stamp;
}

// Direct invocation: precompile and report what happened.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const printPathOnly = process.argv.includes('--print-path');
  const result = await buildEvalLib();
  const stamp = writeStamp(result, EVAL_LIB_ENTRY);
  if (printPathOnly) {
    console.log(result.outfile);
  } else {
    console.log('eval lib ' + (result.rebuilt ? 'built' : 'reused (cache hit)') + ': ' + stamp.artifact);
    console.log('digest: ' + result.digest);
    console.log('mode: ' + result.mode + ', esbuild: ' + result.esbuildVersion + ', target: ' + NODE_TARGET);
  }
}
