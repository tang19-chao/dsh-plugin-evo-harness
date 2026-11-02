#!/usr/bin/env node
/**
 * Build freshness evidence (rev5 P0-5): the src-tree digest and stamp recipe.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * `pnpm run build` exiting 0 proves only that esbuild ran on SOME source tree.
 * Before this module the repository had no way to answer the question a gate
 * actually has: "was the artifact in `lib/` produced from the `src/` bytes that
 * are on disk right now?" A stale `lib/index.js` (built before the last source
 * edit) can pass every import/export smoke check, which is the same class of
 * defect as an expired attestation: perfectly self-consistent, about the wrong
 * bytes.
 *
 * FRESHNESS RECIPE (FROZEN - changing it changes every recorded stamp)
 * -------------------------------------------------------------------
 *   srcTreeSha256 = SHA256( concat over files of
 *                     "<posix-path>" + "\0" + SHA256(canonical LF bytes) + "\n" )
 *   dependencySha256 = SHA256( concat over files of
 *                     "<posix-path>" + "\0" + SHA256(raw bytes) + "\n" )
 *                     over `package.json` and `pnpm-lock.yaml` (schema 1.1.0)
 *
 *   - the file set is every `src/**\/*.ts` file (recursive), so a new module,
 *     a deletion, a rename and a content edit all change the digest;
 *   - (1.1.0) the DEPENDENCY file set is `package.json` + `pnpm-lock.yaml`:
 *     esbuild bundles the dependencies INTO `lib/index.js` (build.mjs has no
 *     `external`/`packages` field), so a dependency bump without a rebuild
 *     changes the artifact identity while leaving the src tree untouched -
 *     the stamp must see it too, or "dep bump + smoke, no rebuild" passes
 *     as fresh;
 *   - paths are POSIX-relative to the repository root (`src/a/b.ts`), sorted by
 *     ordinal (UTF-16 code-unit) comparison, so the digest is locale- and
 *     OS-independent;
 *   - the bytes are hashed RAW, exactly as read from disk. The repository
 *     content policy is LF and is enforced on committed blobs by
 *     `check:encoding`, but a Windows checkout with `core.autocrlf=true` can
 *     still present CRLF on disk; the digest then describes the bytes THIS
 *     build actually consumed, which is the honest freshness question. It is
 *     not a cross-machine artifact digest - that identity is the commit
 *     attestation's job (`scripts/eval/final-attestation.mjs` hashes object
 *     database blobs, not the worktree);
 *   - the composite is a single SHA256 over the concatenation, and the stamp
 *     also records the file count and the per-file digests so a reviewer can
 *     re-derive it.
 *
 * `commit` is `git rev-parse HEAD` at build time. (1.1.0) a recorded commit
 * that no longer matches HEAD is a staleness reason (`commit-mismatch`): the
 * stamp describes the artifact AS BUILT AT THAT COMMIT, so an old artifact
 * presented under a moved HEAD is the same "self-consistent evidence about
 * the wrong bytes" failure this module exists to catch. When git cannot
 * answer on either side (a tarball without `.git`), there is nothing to
 * compare against: the comparison is skipped (`commit.matches: null`) and the
 * stamp records `commit: null` with the reason instead of failing the build.
 *
 * STAMP: `lib/build-stamp.json` (machine-readable, written by `scripts/build.mjs`
 * and read by `scripts/eval/smoke-build.mjs --status`).
 *
 * CLI:
 *   node scripts/build-manifest.mjs [--status] [--json] [--cwd <dir>] [--help]
 *   exit 0 = fresh; exit 1 = stale (fail-closed, with named reasons).
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

/** Schema version of the stamp written by this module. */
export const BUILD_STAMP_SCHEMA_VERSION = '1.1.0';
/** POSIX-relative path of the machine-readable stamp inside a repository. */
export const BUILD_STAMP_PATH = 'lib/build-stamp.json';
/** POSIX-relative path of the build artifact asserted by the smoke gate. */
export const BUILD_ARTIFACT_PATH = 'lib/index.js';

/**
 * Dependency identity files folded into the stamp (schema 1.1.0): the bundle
 * inlines them, so their bytes are part of the artifact's identity.
 */
const DEPENDENCY_MANIFEST_FILES = Object.freeze(['package.json', 'pnpm-lock.yaml']);

const SHA256_HEX = /^[0-9a-f]{64}$/;
const COMMIT_HEX = /^[0-9a-f]{40}$/;

/** @param {Buffer} bytes @returns {string} lowercase hex SHA-256 */
function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * Recursively list every `*.ts` file under `<cwd>/src`, POSIX-relative and
 * ordinally sorted.
 *
 * @param {string} cwd
 * @returns {string[]}
 */
function listSourceFiles(cwd) {
  const srcDir = path.join(cwd, 'src');
  /** @type {string[]} */
  const files = [];
  /** @param {string} absolute @param {string} relative */
  const walk = (absolute, relative) => {
    const entries = fs.readdirSync(absolute, { withFileTypes: true });
    for (const entry of entries) {
      const childAbsolute = path.join(absolute, entry.name);
      const childRelative = relative.length === 0 ? entry.name : relative + '/' + entry.name;
      if (entry.isDirectory()) {
        walk(childAbsolute, childRelative);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        files.push('src/' + childRelative);
      }
    }
  };
  if (!fs.existsSync(srcDir)) {
    return files;
  }
  walk(srcDir, '');
  return files.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * Compute the frozen `srcTreeSha256` recipe plus the per-file evidence.
 *
 * @param {{cwd?: string}} [options]
 * @returns {{srcTreeSha256: string, fileCount: number, files: {path: string, bytes: number, sha256: string}[]}}
 */
export function computeSrcTreeSha256(options = {}) {
  const cwd = options.cwd ?? rootDir;
  /** @type {{path: string, bytes: number, sha256: string}[]} */
  const files = [];
  /** @type {string[]} */
  const lines = [];
  for (const relative of listSourceFiles(cwd)) {
    const bytes = fs.readFileSync(path.join(cwd, relative));
    const digest = sha256Hex(bytes);
    files.push({ path: relative, bytes: bytes.length, sha256: digest });
    lines.push(relative + '\u0000' + digest + '\n');
  }
  return {
    srcTreeSha256: sha256Hex(Buffer.from(lines.join(''), 'utf8')),
    fileCount: files.length,
    files
  };
}

/**
 * Compute the 1.1.0 dependency digest over `package.json` + `pnpm-lock.yaml`
 * (same line recipe as the src tree, over the dependency file set). A file
 * that does not exist is skipped on BOTH sides, so the comparison stays
 * defined for stripped-down trees; a file present on one side only still
 * changes the digest and reports a mismatch (fail-closed).
 *
 * @param {{cwd?: string}} [options]
 * @returns {{dependencySha256: string, fileCount: number, files: {path: string, bytes: number, sha256: string}[]}}
 */
export function computeDependencySha256(options = {}) {
  const cwd = options.cwd ?? rootDir;
  /** @type {{path: string, bytes: number, sha256: string}[]} */
  const files = [];
  /** @type {string[]} */
  const lines = [];
  for (const relative of DEPENDENCY_MANIFEST_FILES) {
    const absolute = path.join(cwd, relative);
    if (!fs.existsSync(absolute)) {
      continue;
    }
    const bytes = fs.readFileSync(absolute);
    const digest = sha256Hex(bytes);
    files.push({ path: relative, bytes: bytes.length, sha256: digest });
    lines.push(relative + '\u0000' + digest + '\n');
  }
  return {
    dependencySha256: sha256Hex(Buffer.from(lines.join(''), 'utf8')),
    fileCount: files.length,
    files
  };
}

/**
 * Resolve `HEAD` without letting an ambient GIT_DIR/GIT_WORK_TREE redirect the
 * answer, and without throwing: a missing repository is recorded, not fatal.
 *
 * @param {string} cwd
 * @returns {{commit: string|null, error: string|null}}
 */
function readHeadCommit(cwd) {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  try {
    const out = String(
      execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
        cwd,
        encoding: 'utf8',
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    ).trim();
    if (!COMMIT_HEX.test(out)) {
      return { commit: null, error: 'git rev-parse HEAD returned a non-commit id: ' + out };
    }
    return { commit: out, error: null };
  } catch (error) {
    const stderr = error && /** @type {any} */ (error).stderr;
    const detail = stderr === undefined || stderr === null ? String(error && error.message) : String(stderr).trim();
    return { commit: null, error: 'HEAD is not resolvable in this directory (' + detail + ')' };
  }
}

/**
 * Build (but do not write) the stamp for a repository.
 *
 * @param {{cwd?: string, artifactPath?: string}} [options]
 * @returns {any} the stamp object
 */
export function buildStamp(options = {}) {
  const cwd = options.cwd ?? rootDir;
  const artifactRelative = (options.artifactPath ?? BUILD_ARTIFACT_PATH).split(path.sep).join('/');
  const source = computeSrcTreeSha256({ cwd });
  const dependencies = computeDependencySha256({ cwd });
  const artifactAbsolute = path.join(cwd, artifactRelative);
  let artifact = null;
  if (fs.existsSync(artifactAbsolute)) {
    const bytes = fs.readFileSync(artifactAbsolute);
    artifact = { path: artifactRelative, bytes: bytes.length, sha256: sha256Hex(bytes) };
  }
  const head = readHeadCommit(cwd);
  return {
    schemaVersion: BUILD_STAMP_SCHEMA_VERSION,
    kind: 'build-stamp',
    srcTreeSha256: source.srcTreeSha256,
    srcFileCount: source.fileCount,
    srcFiles: source.files,
    dependencySha256: dependencies.dependencySha256,
    dependencyFileCount: dependencies.fileCount,
    dependencyFiles: dependencies.files,
    artifact,
    commit: head.commit,
    commitError: head.error,
    commitSource: 'git rev-parse --verify HEAD^{commit}',
    algorithm: {
      fileSet: 'src/**/*.ts (recursive)',
      dependencyFileSet: 'package.json + pnpm-lock.yaml (schema 1.1.0)',
      pathFormat: 'POSIX relative to the repository root',
      sorting: 'ordinal by path (UTF-16 code unit order, locale-independent)',
      lineFormat: '<path> NUL <sha256(raw bytes)> LF',
      compositeHash: 'SHA256(concat(lines))',
      normalization: 'none: raw file bytes are hashed exactly as read'
    },
    builtAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch
  };
}

/**
 * Build the stamp and write it to `<cwd>/lib/build-stamp.json`.
 *
 * @param {{cwd?: string, artifactPath?: string, stampPath?: string}} [options]
 * @returns {any} the written stamp
 */
export function writeBuildStamp(options = {}) {
  const cwd = options.cwd ?? rootDir;
  const stampRelative = (options.stampPath ?? BUILD_STAMP_PATH).split(path.sep).join('/');
  const stamp = buildStamp({
    cwd,
    ...(options.artifactPath === undefined ? {} : { artifactPath: options.artifactPath })
  });
  const stampAbsolute = path.join(cwd, stampRelative);
  fs.mkdirSync(path.dirname(stampAbsolute), { recursive: true });
  fs.writeFileSync(stampAbsolute, JSON.stringify(stamp, null, 2) + '\n', 'utf8');
  return stamp;
}

/**
 * Read and shape-check a stamp. A malformed stamp is reported, never treated as
 * fresh: an unreadable stamp is missing evidence.
 *
 * @param {string} absolutePath
 * @returns {{stamp: any, error: string|null}}
 */
function readStamp(absolutePath) {
  let raw;
  try {
    raw = fs.readFileSync(absolutePath, 'utf8');
  } catch (error) {
    return {
      stamp: null,
      error: 'stamp-missing: ' + (error instanceof Error ? error.message : String(error))
    };
  }
  let stamp;
  try {
    stamp = JSON.parse(raw);
  } catch (error) {
    return { stamp: null, error: 'stamp-invalid: not JSON (' + (error instanceof Error ? error.message : String(error)) + ')' };
  }
  if (stamp === null || typeof stamp !== 'object') {
    return { stamp: null, error: 'stamp-invalid: not an object' };
  }
  if (stamp.kind !== 'build-stamp') {
    return { stamp: null, error: 'stamp-invalid: kind is ' + JSON.stringify(stamp.kind) };
  }
  if (stamp.schemaVersion !== BUILD_STAMP_SCHEMA_VERSION) {
    // An unknown stamp schema cannot be interpreted by this reader: refuse it
    // (fail-closed) instead of silently comparing a subset of the evidence.
    return {
      stamp: null,
      error:
        'stamp-invalid: schemaVersion ' +
        JSON.stringify(stamp.schemaVersion ?? null) +
        ' is not the known version ' +
        BUILD_STAMP_SCHEMA_VERSION +
        ' (rebuild to regenerate the stamp)'
    };
  }
  if (typeof stamp.srcTreeSha256 !== 'string' || !SHA256_HEX.test(stamp.srcTreeSha256)) {
    return { stamp: null, error: 'stamp-invalid: srcTreeSha256 is not a 64-hex digest' };
  }
  if (typeof stamp.srcFileCount !== 'number' || !Number.isInteger(stamp.srcFileCount) || stamp.srcFileCount < 0) {
    return { stamp: null, error: 'stamp-invalid: srcFileCount is not a non-negative integer' };
  }
  if (typeof stamp.dependencySha256 !== 'string' || !SHA256_HEX.test(stamp.dependencySha256)) {
    return { stamp: null, error: 'stamp-invalid: dependencySha256 is not a 64-hex digest' };
  }
  if (stamp.commit !== null && (typeof stamp.commit !== 'string' || !COMMIT_HEX.test(stamp.commit))) {
    return { stamp: null, error: 'stamp-invalid: commit is neither null nor a 40-hex id' };
  }
  if (stamp.artifact !== null) {
    if (
      typeof stamp.artifact !== 'object' ||
      typeof stamp.artifact.path !== 'string' ||
      typeof stamp.artifact.bytes !== 'number' ||
      typeof stamp.artifact.sha256 !== 'string' ||
      !SHA256_HEX.test(stamp.artifact.sha256)
    ) {
      return { stamp: null, error: 'stamp-invalid: artifact block is malformed' };
    }
  }
  return { stamp, error: null };
}

/**
 * Compare the artifact/stamp on disk with the CURRENT `src` tree.
 *
 * Stale reasons are named codes, never a bare boolean:
 *   - `artifact-missing`      `lib/index.js` does not exist;
 *   - `stamp-missing`         `lib/build-stamp.json` does not exist;
 *   - `stamp-invalid`         the stamp cannot be parsed/shape-checked (this
 *                             includes an unknown stamp schemaVersion);
 *   - `src-tree-mismatch`     the recorded srcTreeSha256 != the current one
 *                             (content edit, add, delete or rename);
 *   - `dependency-mismatch`   the recorded dependencySha256 (package.json +
 *                             pnpm-lock.yaml, schema 1.1.0) != the current one
 *                             (a dependency bump without a rebuild);
 *   - `artifact-mismatch`     the artifact's sha256/bytes differ from the stamp
 *                             (the file was replaced without a rebuild);
 *   - `commit-mismatch`       the stamp names a commit that is no longer HEAD
 *                             (schema 1.1.0): an old artifact presented under
 *                             a moved HEAD is stale evidence. Skipped when
 *                             either side has no commit to compare.
 *
 * `stale` is TRUE whenever any reason is present.
 *
 * @param {{cwd?: string, artifactPath?: string, stampPath?: string}} [options]
 * @returns {{
 *   ok: boolean,
 *   stale: boolean,
 *   reasons: string[],
 *   artifact: 'present'|'absent',
 *   artifactPath: string,
 *   artifactBytes: number|null,
 *   artifactSha256: string|null,
 *   stampPath: string,
 *   stampPresent: boolean,
 *   srcTreeSha256: {current: string, recorded: string|null, currentFileCount: number},
 *   dependencySha256: {current: string, recorded: string|null, currentFileCount: number},
 *   commit: {recorded: string|null, head: string|null, matches: boolean|null},
 *   detail: string
 * }}
 */
export function computeBuildStatus(options = {}) {
  const cwd = options.cwd ?? rootDir;
  const artifactRelative = (options.artifactPath ?? BUILD_ARTIFACT_PATH).split(path.sep).join('/');
  const stampRelative = (options.stampPath ?? BUILD_STAMP_PATH).split(path.sep).join('/');
  const artifactAbsolute = path.join(cwd, artifactRelative);
  const stampAbsolute = path.join(cwd, stampRelative);

  const source = computeSrcTreeSha256({ cwd });
  const dependencies = computeDependencySha256({ cwd });
  /** @type {string[]} */
  const reasons = [];

  const artifactPresent = fs.existsSync(artifactAbsolute);
  let artifactBytes = null;
  let artifactSha256 = null;
  if (artifactPresent) {
    const bytes = fs.readFileSync(artifactAbsolute);
    artifactBytes = bytes.length;
    artifactSha256 = sha256Hex(bytes);
  } else {
    reasons.push('artifact-missing');
  }

  const { stamp, error: stampError } = readStamp(stampAbsolute);
  if (stampError !== null) {
    reasons.push(stampError.split(':')[0]);
  } else {
    if (stamp.srcTreeSha256 !== source.srcTreeSha256) {
      reasons.push('src-tree-mismatch');
    }
    if (stamp.dependencySha256 !== dependencies.dependencySha256) {
      reasons.push('dependency-mismatch');
    }
    if (
      artifactPresent &&
      (stamp.artifact === null ||
        stamp.artifact.sha256 !== artifactSha256 ||
        stamp.artifact.bytes !== artifactBytes)
    ) {
      reasons.push('artifact-mismatch');
    }
  }

  const head = readHeadCommit(cwd);
  const recordedCommit = stamp !== null && typeof stamp.commit === 'string' ? stamp.commit : null;
  const commitComparable = recordedCommit !== null && head.commit !== null;
  const commitMatches = commitComparable ? recordedCommit === head.commit : null;
  if (commitMatches === false) {
    reasons.push('commit-mismatch');
  }

  const detailParts = [];
  if (reasons.includes('artifact-missing')) {
    detailParts.push('lib/index.js is absent; run `pnpm run build`');
  }
  if (reasons.includes('stamp-missing')) {
    detailParts.push('lib/build-stamp.json is absent; run `pnpm run build`');
  }
  if (reasons.includes('stamp-invalid')) {
    detailParts.push('lib/build-stamp.json is unreadable/malformed; run `pnpm run build`');
  }
  if (reasons.includes('src-tree-mismatch')) {
    detailParts.push(
      'src/ changed since the last build (recorded ' +
        String(stamp?.srcTreeSha256).slice(0, 12) +
        '…, current ' +
        source.srcTreeSha256.slice(0, 12) +
        '…); run `pnpm run build`'
    );
  }
  if (reasons.includes('dependency-mismatch')) {
    detailParts.push(
      'package.json/pnpm-lock.yaml changed since the last build (recorded ' +
        String(stamp?.dependencySha256).slice(0, 12) +
        '…, current ' +
        dependencies.dependencySha256.slice(0, 12) +
        '…); the bundle inlines the dependencies, so run `pnpm run build`'
    );
  }
  if (reasons.includes('artifact-mismatch')) {
    detailParts.push('lib/index.js does not match the stamp; run `pnpm run build`');
  }
  if (reasons.includes('commit-mismatch')) {
    detailParts.push(
      'HEAD is ' +
        String(head.commit) +
        ' but the stamp names ' +
        String(recordedCommit) +
        '; the artifact was built at another commit, so run `pnpm run build`'
    );
  }
  if (detailParts.length === 0) {
    detailParts.push('lib/index.js matches the current src tree, dependency set and commit');
  }

  return {
    ok: reasons.length === 0,
    stale: reasons.length > 0,
    reasons,
    artifact: artifactPresent ? 'present' : 'absent',
    artifactPath: artifactRelative,
    artifactBytes,
    artifactSha256,
    stampPath: stampRelative,
    stampPresent: stamp !== null,
    srcTreeSha256: {
      current: source.srcTreeSha256,
      recorded: stamp === null ? null : String(stamp.srcTreeSha256),
      currentFileCount: source.fileCount
    },
    dependencySha256: {
      current: dependencies.dependencySha256,
      recorded: stamp === null ? null : String(stamp.dependencySha256),
      currentFileCount: dependencies.fileCount
    },
    commit: { recorded: recordedCommit, head: head.commit, matches: commitMatches },
    detail: detailParts.join('; ')
  };
}

/**
 * Human-readable status lines. Kept here (not in the CLI) so callers that embed
 * the status in another gate can print the same evidence.
 *
 * @param {ReturnType<typeof computeBuildStatus>} status
 * @returns {string[]}
 */
export function formatBuildStatus(status) {
  const lines = [
    '[build-status] artifact: ' +
      status.artifact +
      (status.artifact === 'present'
        ? ' (' + status.artifactPath + ', ' + String(status.artifactBytes) + ' bytes, sha256 ' + String(status.artifactSha256) + ')'
        : ' (' + status.artifactPath + ')'),
    '[build-status] stamp: ' +
      (status.stampPresent ? status.stampPath : 'absent (' + status.stampPath + ')') +
      (status.commit.recorded === null ? '' : ' (commit ' + status.commit.recorded + ')'),
    '[build-status] srcTreeSha256: current=' +
      status.srcTreeSha256.current +
      ' recorded=' +
      String(status.srcTreeSha256.recorded),
    '[build-status] stale: ' + String(status.stale) + (status.stale ? ' [' + status.reasons.join(', ') + ']' : '')
  ];
  if (status.commit.matches === false) {
    lines.push(
      '[build-status] commit-mismatch: HEAD is ' +
        String(status.commit.head) +
        ', the stamp names ' +
        String(status.commit.recorded) +
        ' (schema 1.1.0 counts this as stale evidence)'
    );
  }
  lines.push('[build-status] ' + status.detail);
  return lines;
}

const usage = [
  'Build freshness evidence (src tree digest + dependency digest + build stamp).',
  '',
  'USAGE',
  '  node scripts/build-manifest.mjs [--status] [--json] [--cwd <dir>]',
  '',
  'FRESHNESS RECIPE (frozen, schema 1.1.0)',
  '  srcTreeSha256 = SHA256(concat("<posix-path>\\0<SHA256(raw bytes)>\\n"))',
  '  over every src/**/*.ts file, sorted ordinally by path.',
  '  dependencySha256 = same recipe over package.json + pnpm-lock.yaml',
  '  (the bundle inlines the dependencies, so their bytes are identity).',
  '  The stamp names the commit it was built at; a moved HEAD is stale.',
  '',
  'EXIT CODES',
  '  0  fresh (artifact matches the current src tree, dependency set and commit)',
  '  1  stale, with named reasons (artifact-missing, stamp-missing,',
  '     stamp-invalid, src-tree-mismatch, dependency-mismatch,',
  '     artifact-mismatch, commit-mismatch)'
].join('\n');

const isDirectExecution = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectExecution) {
  const rawArgv = process.argv.slice(2);
  if (rawArgv.includes('--help') || rawArgv.includes('-h')) {
    console.log(usage);
    process.exit(0);
  }
  let cwd = rootDir;
  let json = false;
  /** @type {string[]} */
  const unknown = [];
  for (let index = 0; index < rawArgv.length; index += 1) {
    const arg = rawArgv[index];
    if (arg === '--status') {
      // Accepted for symmetry with the smoke gate; status is the only mode.
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--cwd') {
      const value = rawArgv[index + 1];
      if (value === undefined) {
        console.error('[build-status] argument-value-missing: --cwd requires a value');
        process.exit(1);
      }
      cwd = value;
      index += 1;
    } else {
      unknown.push(arg);
    }
  }
  if (unknown.length > 0) {
    console.error('[build-status] unknown-argument: ' + unknown.join(' '));
    process.exit(1);
  }
  try {
    const status = computeBuildStatus({ cwd });
    if (json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      for (const line of formatBuildStatus(status)) {
        console.log(line);
      }
    }
    process.exit(status.stale ? 1 : 0);
  } catch (error) {
    console.error('[build-status] error: ' + (error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}
