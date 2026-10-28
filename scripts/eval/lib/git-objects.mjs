/**
 * Canonical git-object evidence core (PR-1, ADR 0003 rev.3 follow-up).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The pre-PR-1 attestation (`scripts/eval/final-attestation.mjs`) hashed files
 * with `fs.readFileSync`, i.e. it hashed the WORKING TREE. That is not
 * reproducible: with `core.autocrlf=true` (this repo's Windows setting) the
 * worktree holds CRLF bytes while the object database holds LF bytes, so the
 * same commit produces two different digests depending on where it is checked
 * out. ADR 0003's own appendix is a live casualty of this: 14 of its 15 file
 * digests are CRLF worktree digests and cannot be recomputed on an LF checkout
 * (see `work/t1-baseline-audit.md` §5 F-1).
 *
 * PR-1 rules implemented here:
 *   1. COMMIT OBJECT AUTHORITY - every digest is anchored to a resolved commit
 *      object (`<rev>^{commit}`) and its root tree (`<commit>^{tree}`), never to
 *      "whatever is on disk".
 *   2. RAW BLOB BYTES - file content is read from the object database via
 *      `git cat-file blob <blobId>` (batched) and hashed as bytes. This module
 *      never calls `fs.readFile` on repository content.
 *   3. EXPLICIT REF/BASE + ANCESTRY - the caller names the ref; if a base is
 *      given, `git merge-base --is-ancestor` must confirm base ⊆ ref.
 *   4. NO SILENT WORKTREE FALLBACK - if the object database cannot answer, this
 *      module THROWS. It never degrades to reading the worktree.
 *   5. CORE vs ENVIRONMENT SPLIT - `compositeSha256` / `bindingSha256` cover
 *      commit identity plus `path:blobSha256` lines only. Node/platform/arch,
 *      timestamps and worktree state belong to the caller's `environment`
 *      block and are deliberately NOT part of either digest.
 *   6. ENCODING POLICY IS COMMIT-BOUND - a blob that is not plain LF text must
 *      be declared `-text` in THE ATTESTED COMMIT's `.gitattributes`. Otherwise
 *      the manifest throws (`encoding-policy-violation`) instead of quietly
 *      digesting a worktree-dependent byte sequence. Attribute answers come
 *      from `git check-attr --source=<commit>` (falling back to parsing the
 *      commit tree's `.gitattributes` on git versions without `--source`),
 *      NEVER from the working tree: an untracked, modified or absent-on-disk
 *      `.gitattributes` must not change what a commit's evidence says, and a
 *      bare clone must re-check identically. Binary blobs are `-text` by the
 *      `binary` macro, so they are allowed but still RECORDED in
 *      `encoding.exceptions`.
 *
 * Everything in `buildCanonicalManifest` is OS-, locale- and time-independent:
 * the object database is the same bytes on every platform, so the digests are
 * identical on Windows, Linux and macOS for the same commit.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

/** A resolved commit object. Constructed only through {@link resolveCommit}. */
export class ResolvedCommit {
  /**
   * @param {string} ref The ref string the caller asked for (`HEAD`, `origin/main`).
   * @param {string} commitId Full 40-hex commit object id.
   * @param {string} treeId Full 40-hex root tree id of that commit.
   */
  constructor(ref, commitId, treeId) {
    /** @type {string} The ref string the caller asked for. */
    this.ref = ref;
    /** @type {string} Full 40-hex commit object id. */
    this.commitId = commitId;
    /**
     * Full 40-hex root tree id. Recorded so the evidence states WHAT the commit
     * contains, not merely which commit it was: commit -> tree is the binding a
     * third party re-derives to check the manifest against the object graph.
     * @type {string}
     */
    this.treeId = treeId;
  }

  /**
   * Internal factory (kept for symmetry with the previous API surface).
   * @param {string} ref
   * @param {string} commitId
   * @param {string} treeId
   * @returns {ResolvedCommit}
   */
  static _create(ref, commitId, treeId) {
    return new ResolvedCommit(ref, commitId, treeId);
  }
}

/** Thrown when the object database cannot supply authoritative evidence. */
export class GitEvidenceError extends Error {
  /**
   * @param {string} code stable machine-readable reason code
   * @param {string} message human-readable detail
   */
  constructor(code, message) {
    super(message);
    this.name = 'GitEvidenceError';
    /** @type {string} */
    this.code = code;
  }
}

/**
 * Run git with a scrubbed environment.
 *
 * GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE are cleared so evidence always comes
 * from the repository rooted at `cwd`, never from an ambient override.
 *
 * @param {readonly string[]} args
 * @param {string} cwd
 * @param {'utf8'|'buffer'} [encoding]
 * @param {string|Buffer} [input]
 * @returns {string|Buffer}
 */
function git(args, cwd, encoding = 'utf8', input) {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  try {
    return execFileSync('git', args.slice(), {
      cwd,
      maxBuffer: 256 * 1024 * 1024,
      encoding,
      env,
      ...(input === undefined ? {} : { input })
    });
  } catch (error) {
    const stderrValue = error && error.stderr;
    const stderr =
      stderrValue === undefined || stderrValue === null
        ? String(error && error.message)
        : Buffer.isBuffer(stderrValue)
          ? stderrValue.toString('utf8').trim()
          : String(stderrValue);
    throw new GitEvidenceError('git-command-failed', `git ${args.join(' ')} failed: ${stderr}`);
  }
}

/**
 * Root tree id of a commit (`<commit>^{tree}`).
 *
 * @param {string} commitId full 40-hex commit id
 * @param {string} cwd
 * @returns {string}
 */
export function commitTreeId(commitId, cwd) {
  if (!/^[0-9a-f]{40}$/.test(commitId)) {
    throw new GitEvidenceError('commit-id-invalid', `not a full 40-hex commit id: ${JSON.stringify(commitId)}`);
  }
  const out = String(git(['rev-parse', '--verify', `${commitId}^{tree}`], cwd)).trim();
  if (!/^[0-9a-f]{40}$/.test(out)) {
    throw new GitEvidenceError('tree-id-invalid', `commit ${commitId} has no resolvable root tree: ${out}`);
  }
  return out;
}

/**
 * Resolve a ref to a COMMIT object.
 *
 * `^{commit}` peeling is what makes this "commit object authority": a ref that
 * points at a tree or a blob is rejected rather than silently accepted.
 *
 * @param {string} ref
 * @param {string} cwd
 * @returns {ResolvedCommit}
 */
export function resolveCommit(ref, cwd) {
  if (typeof ref !== 'string' || ref.length === 0) {
    throw new GitEvidenceError('ref-missing', 'an explicit ref is required (refusing to guess a revision)');
  }
  let out;
  try {
    out = String(git(['rev-parse', '--verify', `${ref}^{commit}`], cwd)).trim();
  } catch (error) {
    throw new GitEvidenceError(
      'ref-not-a-commit',
      `ref ${JSON.stringify(ref)} does not resolve to a commit object (${error.message})`
    );
  }
  if (!/^[0-9a-f]{40}$/.test(out)) {
    throw new GitEvidenceError('ref-not-a-commit', `ref ${JSON.stringify(ref)} resolved to a non commit id: ${out}`);
  }
  return new ResolvedCommit(ref, out, commitTreeId(out, cwd));
}

/**
 * Assert `base` is an ancestor of (or equal to) `target`.
 *
 * Uses `git merge-base --is-ancestor`, whose exit code is the authoritative
 * answer: 0 = ancestor, 1 = not an ancestor. Any other exit is an error, not a
 * "no".
 *
 * @param {ResolvedCommit} base
 * @param {ResolvedCommit} target
 * @param {string} cwd
 * @returns {void}
 */
export function assertAncestor(base, target, cwd) {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  let code = 0;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', base.commitId, target.commitId], {
      cwd,
      stdio: 'ignore',
      env
    });
    code = 0;
  } catch (error) {
    const status = error ? error.status : undefined;
    if (status === 1) {
      code = 1;
    } else {
      throw new GitEvidenceError(
        'ancestry-check-failed',
        `merge-base --is-ancestor ${base.commitId} ${target.commitId} failed with status ${String(status)}`
      );
    }
  }
  if (code === 1) {
    throw new GitEvidenceError(
      'not-an-ancestor',
      `base ${base.commitId} (${base.ref}) is NOT an ancestor of target ${target.commitId} (${target.ref})`
    );
  }
}

/**
 * @typedef {object} TreeEntry
 * @property {string} path   POSIX path relative to the repository root.
 * @property {string} mode   Git mode as written in the tree (`100644`, `100755`).
 * @property {string} type   Object type as written in the tree (`blob` for files).
 * @property {string} blobId Full 40-hex blob object id.
 */

/**
 * Enumerate every regular-file blob reachable from a commit, optionally
 * restricted to top-level roots.
 *
 * `-z` is used so paths containing spaces or newlines cannot be split wrongly.
 *
 * @param {ResolvedCommit} commit
 * @param {string} cwd
 * @param {readonly string[]} [roots]
 * @returns {TreeEntry[]}
 */
export function listTreeBlobs(commit, cwd, roots) {
  const raw = /** @type {Buffer} */ (git(['ls-tree', '-r', '-z', commit.commitId], cwd, 'buffer'));
  /** @type {TreeEntry[]} */
  const entries = [];
  for (const record of raw.toString('utf8').split('\u0000')) {
    if (record.length === 0) {
      continue;
    }
    // Format: "<mode> <type> <object>\t<path>"
    const tabIndex = record.indexOf('\t');
    if (tabIndex < 0) {
      throw new GitEvidenceError('ls-tree-malformed', `unexpected ls-tree record: ${JSON.stringify(record)}`);
    }
    const meta = record.slice(0, tabIndex).split(' ');
    const entryPath = record.slice(tabIndex + 1);
    if (meta.length !== 3) {
      throw new GitEvidenceError('ls-tree-malformed', `unexpected ls-tree metadata: ${JSON.stringify(meta.join(' '))}`);
    }
    const mode = meta[0];
    const type = meta[1];
    const blobId = meta[2];
    if (type !== 'blob') {
      // Submodules (gitlink) are recorded as `commit`; they are not file bytes.
      continue;
    }
    if (roots !== undefined && roots.length > 0) {
      const top = entryPath.split('/')[0];
      if (!roots.includes(top)) {
        continue;
      }
    }
    entries.push({ path: entryPath, mode, type, blobId });
  }
  return entries;
}

/**
 * Read the RAW bytes of a blob from the object database. Never touches the worktree.
 *
 * Use {@link readBlobsBatch} when reading more than a couple of blobs: one
 * `git cat-file --batch` process replaces N process spawns.
 *
 * @param {string} blobId
 * @param {string} cwd
 * @returns {Buffer}
 */
export function readBlobBytes(blobId, cwd) {
  if (!/^[0-9a-f]{40}$/.test(blobId)) {
    throw new GitEvidenceError('blob-id-invalid', `not a full 40-hex blob id: ${JSON.stringify(blobId)}`);
  }
  return /** @type {Buffer} */ (git(['cat-file', 'blob', blobId], cwd, 'buffer'));
}

/**
 * Read many blobs in ONE `git cat-file --batch` process.
 *
 * Spawning one git process per file is both slow (206 spawns ≈ 14s on Windows)
 * and pointless: `--batch` streams every object through a single pipe. The
 * protocol is, per requested id:
 *
 *     <oid> SP <type> SP <size> LF
 *     <size raw bytes> LF
 *
 * Duplicate ids are de-duplicated on input and fanned back out by the caller.
 *
 * @param {readonly string[]} blobIds
 * @param {string} cwd
 * @returns {Map<string, Buffer>} blobId -> raw bytes
 */
export function readBlobsBatch(blobIds, cwd) {
  /** @type {Map<string, Buffer>} */
  const result = new Map();
  const unique = [];
  for (const id of blobIds) {
    if (!/^[0-9a-f]{40}$/.test(id)) {
      throw new GitEvidenceError('blob-id-invalid', `not a full 40-hex blob id: ${JSON.stringify(id)}`);
    }
    if (!result.has(id) && !unique.includes(id)) {
      unique.push(id);
    }
  }
  if (unique.length === 0) {
    return result;
  }
  const input = `${unique.join('\n')}\n`;
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  /** @type {Buffer} */
  let raw;
  try {
    raw = execFileSync('git', ['cat-file', '--batch'], {
      cwd,
      input,
      maxBuffer: 512 * 1024 * 1024,
      // NOTE: omit `encoding` entirely to receive a Buffer. Passing
      // `encoding: 'buffer'` is not a valid value and throws "Unknown encoding".
      env
    });
  } catch (error) {
    const stderrValue = error && error.stderr;
    const stderr = Buffer.isBuffer(stderrValue) ? stderrValue.toString('utf8').trim() : String(error && error.message);
    throw new GitEvidenceError('git-command-failed', `git cat-file --batch failed: ${stderr}`);
  }

  let cursor = 0;
  for (const requestedId of unique) {
    const newlineIndex = raw.indexOf(0x0a, cursor);
    if (newlineIndex < 0) {
      throw new GitEvidenceError(
        'batch-truncated',
        `cat-file --batch output ended while expecting a header for ${requestedId}`
      );
    }
    const header = raw.toString('utf8', cursor, newlineIndex);
    cursor = newlineIndex + 1;
    const parts = header.split(' ');
    if (parts.length !== 3 || parts[1] !== 'blob') {
      // "<id> missing" or "<id> <type> <size>" for a non-blob. Both are refusals.
      throw new GitEvidenceError(
        'blob-missing',
        `cat-file --batch could not return a blob for ${requestedId}: ${JSON.stringify(header)}`
      );
    }
    const size = Number.parseInt(parts[2], 10);
    if (!Number.isInteger(size) || size < 0 || cursor + size > raw.length) {
      throw new GitEvidenceError('batch-truncated', `cat-file --batch declared an invalid size for ${requestedId}`);
    }
    const bytes = Buffer.from(raw.subarray(cursor, cursor + size));
    cursor += size + 1; // skip the trailing LF that terminates the content
    result.set(parts[0], bytes);
  }
  return result;
}

/**
 * Read a single file from a commit's tree, without touching the worktree.
 *
 * Used to read THE ATTESTED COMMIT's `.gitattributes`: the policy that counts is
 * the one that was committed with the bytes, not whichever `.gitattributes`
 * happens to sit on disk (which may be untracked, modified or absent in a bare
 * clone).
 *
 * @param {{commitId: string}} commit
 * @param {string} filePath POSIX path relative to the repository root
 * @param {string} cwd
 * @returns {{blobId: string, bytes: Buffer}|null} null when the commit has no such file
 */
export function readCommitBlobAtPath(commit, filePath, cwd) {
  const raw = /** @type {Buffer} */ (
    git(['ls-tree', '-z', commit.commitId, '--', filePath], cwd, 'buffer')
  );
  for (const record of raw.toString('utf8').split('\u0000')) {
    if (record.length === 0) {
      continue;
    }
    const tabIndex = record.indexOf('\t');
    if (tabIndex < 0) {
      continue;
    }
    const meta = record.slice(0, tabIndex).split(' ');
    const entryPath = record.slice(tabIndex + 1);
    if (meta.length !== 3 || meta[1] !== 'blob' || entryPath !== filePath) {
      continue;
    }
    return { blobId: meta[2], bytes: readBlobBytes(meta[2], cwd) };
  }
  return null;
}

/** @type {Map<string, boolean>} cwd -> does this git understand `check-attr --source`? */
const checkAttrSourceSupport = new Map();

/**
 * Does a git failure mean "this git is too old for `check-attr --source`"?
 *
 * Only that exact condition may fall back to the tree parser. A missing commit,
 * a broken repository or a permission error must stay hard failures: silently
 * degrading them would be the "no silent fallback" defect again.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isCheckAttrSourceUnsupported(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /unknown option|unrecognized option|invalid option/i.test(message) && /source/i.test(message);
}

/**
 * @param {Buffer} raw
 * @returns {Map<string, {text: string, eol: string}>}
 */
function parseCheckAttrStream(raw) {
  /** @type {Map<string, {text: string, eol: string}>} */
  const result = new Map();
  const fields = raw.toString('utf8').split('\u0000');
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const entryPath = fields[index];
    const attribute = fields[index + 1];
    const value = fields[index + 2];
    if (entryPath === undefined || entryPath.length === 0 || attribute === undefined) {
      continue;
    }
    const current = result.get(entryPath) ?? { text: 'unspecified', eol: 'unspecified' };
    if (attribute === 'text' || attribute === 'eol') {
      current[attribute] = value ?? 'unspecified';
    }
    result.set(entryPath, current);
  }
  return result;
}

/**
 * Escape a glob segment into a regular expression.
 *
 * Implements the subset of gitattributes pattern syntax the repository uses:
 * `*`, `?`, character classes and `**` (any number of path segments). This is
 * only the FALLBACK path for git < 2.40; the primary path is git's own matcher
 * through `check-attr --source`.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegExp(glob) {
  let out = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index += 1;
        if (glob[index + 1] === '/') {
          index += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if (char === '[') {
      const end = glob.indexOf(']', index + 1);
      if (end < 0) {
        out += '\\[';
      } else {
        let characterClass = glob.slice(index, end + 1);
        if (characterClass.startsWith('[!')) {
          characterClass = '[^' + characterClass.slice(2);
        }
        out += characterClass;
        index = end;
      }
    } else {
      out += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(out + '$');
}

/**
 * @param {string} text
 * @returns {{regex: RegExp, useFullPath: boolean, tokens: string[]}[]}
 */
function parseGitattributes(text) {
  /** @type {{regex: RegExp, useFullPath: boolean, tokens: string[]}[]} */
  const rules = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    // gitattributes: blank lines and lines beginning with '#' are ignored.
    // There are no trailing comments, so '#' further along a line is a pattern
    // character, not a comment.
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const tokens = line.split(/\s+/);
    let pattern = tokens.shift();
    if (pattern === undefined || pattern.length === 0) {
      continue;
    }
    let anchored = false;
    if (pattern.startsWith('/')) {
      anchored = true;
      pattern = pattern.slice(1);
    }
    rules.push({
      regex: globToRegExp(pattern),
      useFullPath: anchored || pattern.includes('/'),
      tokens
    });
  }
  return rules;
}

/**
 * @param {{text: string, eol: string}} state
 * @param {readonly string[]} tokens
 */
function applyAttributeRule(state, tokens) {
  for (const token of tokens) {
    if (token === 'binary') {
      // git's `binary` macro is `-text -diff`.
      state.text = 'unset';
    } else if (token === 'text') {
      state.text = 'set';
    } else if (token === '-text') {
      state.text = 'unset';
    } else if (token.startsWith('text=')) {
      state.text = token.slice('text='.length);
    } else if (token === 'eol') {
      state.eol = 'set';
    } else if (token === '-eol') {
      state.eol = 'unset';
    } else if (token.startsWith('eol=')) {
      state.eol = token.slice('eol='.length);
    }
  }
}

/**
 * Fallback attribute resolver: parse `.gitattributes` OUT OF THE COMMIT TREE.
 *
 * Only used when git predates `check-attr --source` (git < 2.40) or when a test
 * forces it. Semantics implemented: the usual gitattributes pattern rules
 * (basename match when the pattern has no slash, path-relative match
 * otherwise), deeper `.gitattributes` overriding shallower ones, and the last
 * matching rule in a file winning. The macros/attributes relevant here are
 * `text`, `-text`, `text=...`, `eol=...` and the `binary` macro.
 *
 * It reads blobs from the object database only, so a bare clone resolves
 * attributes exactly like a checkout.
 *
 * @param {readonly string[]} paths
 * @param {string} cwd
 * @param {string} commitId
 * @returns {Map<string, {text: string, eol: string}>}
 */
function readAttributesFromCommitTree(paths, cwd, commitId) {
  // `listTreeBlobs` only reads `commit.commitId`; a full ResolvedCommit is not
  // needed and the root tree id is deliberately not re-resolved here.
  const entries = listTreeBlobs({ commitId }, cwd);
  const attributeFiles = entries
    .filter((entry) => entry.path === '.gitattributes' || entry.path.endsWith('/.gitattributes'))
    .map((entry) => ({
      dir: entry.path === '.gitattributes' ? '' : entry.path.slice(0, -'/.gitattributes'.length),
      entry
    }))
    // Shallower files first: a deeper `.gitattributes` overrides its parents.
    .sort((left, right) => left.dir.split('/').length - right.dir.split('/').length);
  const blobs = readBlobsBatch(
    attributeFiles.map((file) => file.entry.blobId),
    cwd
  );
  /** @type {{dir: string, rules: {regex: RegExp, useFullPath: boolean, tokens: string[]}[]}[]} */
  const parsed = attributeFiles.map((file) => {
    const bytes = blobs.get(file.entry.blobId);
    if (bytes === undefined) {
      throw new GitEvidenceError('blob-missing', `object database returned no .gitattributes bytes for ${file.entry.path}`);
    }
    return { dir: file.dir, rules: parseGitattributes(bytes.toString('utf8')) };
  });

  /** @type {Map<string, {text: string, eol: string}>} */
  const result = new Map();
  for (const entryPath of paths) {
    /** @type {{text: string, eol: string}} */
    const state = { text: 'unspecified', eol: 'unspecified' };
    for (const file of parsed) {
      let relative = entryPath;
      if (file.dir !== '') {
        if (!entryPath.startsWith(`${file.dir}/`)) {
          continue;
        }
        relative = entryPath.slice(file.dir.length + 1);
      }
      const basename = relative.slice(relative.lastIndexOf('/') + 1);
      for (const rule of file.rules) {
        const subject = rule.useFullPath ? relative : basename;
        if (rule.regex.test(subject)) {
          applyAttributeRule(state, rule.tokens);
        }
      }
    }
    result.set(entryPath, state);
  }
  return result;
}

/**
 * Read `.gitattributes` decisions FOR A COMMIT, never from the working tree.
 *
 * Primary path: `git check-attr --source=<commit>` (git >= 2.40), which makes
 * git itself answer from the commit's tree - including in a bare clone. On an
 * older git the same question is answered by parsing the commit tree's
 * `.gitattributes` files.
 *
 * `source` is REQUIRED. The old two-argument form asked the worktree, which let
 * an untracked `.gitattributes` change a commit's manifest - the exact false
 * pass PR-1 must not have.
 *
 * @param {readonly string[]} paths
 * @param {string} cwd
 * @param {string|{commitId: string}} source commit id (or a ResolvedCommit)
 * @param {{forceTreeFallback?: boolean}} [options] test seam for the fallback
 * @returns {Map<string, {text: string, eol: string}>}
 */
export function readAttributes(paths, cwd, source, options = {}) {
  const commitId = typeof source === 'string' ? source : source && source.commitId;
  if (typeof commitId !== 'string' || !/^[0-9a-f]{40}$/.test(commitId)) {
    throw new GitEvidenceError(
      'attributes-source-required',
      'attributes must be read from the attested commit: pass the commit id (40-hex) as the third argument'
    );
  }
  if (paths.length === 0) {
    return new Map();
  }
  const supported = options.forceTreeFallback === true ? false : checkAttrSourceSupport.get(cwd) !== false;
  if (supported) {
    const env = { ...process.env };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GIT_INDEX_FILE;
    try {
      const raw = execFileSync('git', ['check-attr', `--source=${commitId}`, '--stdin', '-z', 'text', 'eol'], {
        cwd,
        input: paths.join('\u0000') + '\u0000',
        maxBuffer: 64 * 1024 * 1024,
        env
      });
      checkAttrSourceSupport.set(cwd, true);
      return parseCheckAttrStream(raw);
    } catch (error) {
      const stderrValue = error && error.stderr;
      const stderr = Buffer.isBuffer(stderrValue) ? stderrValue.toString('utf8').trim() : String(error && error.message);
      const wrapped = new GitEvidenceError(
        'git-command-failed',
        `git check-attr --source=${commitId} failed: ${stderr}`
      );
      if (!isCheckAttrSourceUnsupported(wrapped)) {
        throw wrapped;
      }
      checkAttrSourceSupport.set(cwd, false);
    }
  }
  return readAttributesFromCommitTree(paths, cwd, commitId);
}

/**
 * Classify raw bytes so a non-LF blob cannot slip into the digest unnoticed.
 *
 * @param {Buffer} bytes
 * @returns {{bom: string|null, crlf: number, loneCr: number, nul: number, kind: 'text-lf'|'text-crlf'|'text-bom'|'binary'}}
 */
export function classifyBytes(bytes) {
  let bom = null;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bom = 'utf-8';
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    bom = 'utf-16le';
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    bom = 'utf-16be';
  }
  let crlf = 0;
  let loneCr = 0;
  let nul = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte === 0x00) {
      nul += 1;
    } else if (byte === 0x0d) {
      if (bytes[index + 1] === 0x0a) {
        crlf += 1;
      } else {
        loneCr += 1;
      }
    }
  }
  /** @type {'text-lf'|'text-crlf'|'text-bom'|'binary'} */
  let kind = 'text-lf';
  if (nul > 0) {
    kind = 'binary';
  } else if (bom !== null) {
    kind = 'text-bom';
  } else if (crlf > 0 || loneCr > 0) {
    kind = 'text-crlf';
  }
  return { bom, crlf, loneCr, nul, kind };
}

/**
 * @param {Buffer} bytes
 * @returns {string}
 */
export function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * @typedef {object} BlobRecord
 * @property {string} path
 * @property {string} mode
 * @property {string} blobId
 * @property {string} sha256  SHA-256 of the RAW blob bytes (OS-independent).
 * @property {number} bytes
 * @property {'text-lf'|'text-crlf'|'text-bom'|'binary'} encoding
 * @property {boolean} encodingException true when a non-LF blob is declared `-text`
 * @property {boolean} declaredTextUnset `git check-attr text` === 'unset'
 * @property {string} declaredEol `git check-attr eol` value
 */

/**
 * @typedef {object} CanonicalManifest
 * @property {string} commitId
 * @property {string} treeId
 * @property {readonly string[]} roots
 * @property {number} fileCount
 * @property {readonly BlobRecord[]} files
 * @property {string} compositeSha256
 * @property {string} bindingSha256
 * @property {object} algorithm
 * @property {object} encoding
 */

/**
 * Build the canonical, OS-independent manifest for a commit.
 *
 * Two digests, deliberately different in scope:
 *   - `compositeSha256` covers ONLY `path:blobSha256` lines. It is the content
 *     identity of the tree, comparable across commits that share content.
 *   - `bindingSha256` covers commit id + tree id + composite, i.e. "this exact
 *     commit, with this exact content". Two commits with identical content but
 *     different metadata produce the same composite and different bindings.
 *
 * Environment facts and timestamps are excluded from both, so the same commit
 * yields identical digests on Windows, Linux and macOS.
 *
 * @param {ResolvedCommit} commit
 * @param {string} cwd
 * @param {readonly string[]} [roots]
 * @param {{allowUndeclaredEncoding?: boolean}} [options]
 * @returns {CanonicalManifest}
 */
export function buildCanonicalManifest(commit, cwd, roots = ['src', 'tests', 'scripts'], options = {}) {
  const entries = listTreeBlobs(commit, cwd, roots);
  // ONE batch read for the whole tree: 206 per-file spawns took ~14s on Windows
  // and would make this unusable as a test/gate. `--batch` is one process.
  const blobs = readBlobsBatch(
    entries.map((entry) => entry.blobId),
    cwd
  );
  const attributes = readAttributes(
    entries.map((entry) => entry.path),
    cwd,
    commit.commitId
  );
  const violations = [];
  /** @type {BlobRecord[]} */
  const records = entries.map((entry) => {
    const bytes = blobs.get(entry.blobId);
    if (bytes === undefined) {
      throw new GitEvidenceError('blob-missing', `object database returned no bytes for ${entry.path}`);
    }
    const classified = classifyBytes(bytes);
    const declared = attributes.get(entry.path) ?? { text: 'unspecified', eol: 'unspecified' };
    const declaredTextUnset = declared.text === 'unset';
    const nonLf = classified.kind !== 'text-lf';
    if (nonLf && !declaredTextUnset) {
      violations.push({
        path: entry.path,
        kind: classified.kind,
        textAttribute: declared.text,
        eolAttribute: declared.eol
      });
    }
    return {
      path: entry.path,
      mode: entry.mode,
      blobId: entry.blobId,
      sha256: sha256Bytes(bytes),
      bytes: bytes.length,
      encoding: classified.kind,
      encodingException: nonLf && declaredTextUnset,
      declaredTextUnset,
      declaredEol: declared.eol
    };
  });
  if (violations.length > 0 && options.allowUndeclaredEncoding !== true) {
    throw new GitEvidenceError(
      'encoding-policy-violation',
      `${violations.length} blob(s) are not plain LF text and are not declared '-text' in .gitattributes; ` +
        'a worktree-dependent byte sequence may not enter the digest. Declare each path explicitly ' +
        '(see .gitattributes) or pass allowUndeclaredEncoding for a documented exception.\n' +
        violations
          .map((item) => `  ${item.path}: kind=${item.kind} text=${item.textAttribute} eol=${item.eolAttribute}`)
          .join('\n')
    );
  }
  // Ordinal comparison on the path only. Locale-independent by construction.
  records.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const lines = records.map((r) => `${r.path}:${r.sha256}`);
  const compositeSha256 = crypto.createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
  const bindingSha256 = crypto
    .createHash('sha256')
    .update([`commit ${commit.commitId}`, `tree ${commit.treeId}`, `composite ${compositeSha256}`].join('\n'), 'utf8')
    .digest('hex');
  const exceptions = records
    .filter((record) => record.encodingException)
    .map((record) => ({ path: record.path, encoding: record.encoding, bytes: record.bytes }));
  return {
    commitId: commit.commitId,
    treeId: commit.treeId,
    roots: [...roots],
    fileCount: records.length,
    files: records,
    compositeSha256,
    bindingSha256,
    algorithm: {
      contentSource: 'git-cat-file-blob (raw object bytes)',
      contentSourceNever: 'the working tree (fs.readFile on repository content is forbidden)',
      pathFormat: 'POSIX relative to repository root, no leading ./',
      sorting: 'ordinal by path (UTF-16 code unit order, locale-independent)',
      lineFormat: '<path>:<blobSha256>',
      separator: 'LF',
      trailingNewline: false,
      compositeHash: "SHA256(lines.join('\\n'))",
      bindingHash: "SHA256('commit <commitId>\\ntree <treeId>\\ncomposite <compositeSha256>')",
      normalization: 'none: blob bytes are hashed exactly as committed'
    },
    encoding: {
      policy:
        "every blob must be plain LF text unless .gitattributes declares it '-text' (binary macro or explicit)",
      exceptions,
      exceptionCount: exceptions.length
    }
  };
}

/**
 * Stable JSON used for structural equality, independent of key insertion order.
 *
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
  if (value === undefined) {
    return '<absent>';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function displayValue(value) {
  if (value === undefined) {
    return '<absent>';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  return canonicalJson(value);
}

/**
 * Compare a previously recorded attestation with a freshly computed one.
 *
 * Used by `final-attestation.mjs --verify`: an attestation that cannot be
 * re-checked is a claim, not evidence. The comparison covers every
 * NON-ENVIRONMENT field of the record:
 *
 *   - `schemaVersion`, `kind`
 *   - `commit.commitId`, `commit.treeId`
 *   - `commit.base` (commit id, tree id, ancestry flag and method) when recorded
 *   - `roots`, `fileCount`, `compositeSha256`, `bindingSha256`
 *   - `algorithm` (the digest recipe itself: if the recipe changed, an "identical"
 *     digest means something else)
 *   - `encoding` (policy, exception list and count)
 *   - every file's `sha256`, `blobId`, `mode`, `bytes`, `encoding` and
 *     `encodingException`
 *
 * `declaredTextUnset` / `declaredEol` are attribute-declaration labels. They are
 * compared when the attested commit actually contains a `.gitattributes`
 * (`compareAttributeLabels`); for a commit with no committed policy there is no
 * commit-bound answer to compare them with, so the caller omits them and says so
 * in its notes rather than silently treating them as equal.
 *
 * `environment` (timestamps, node/platform/arch, worktree facts) is deliberately
 * never compared: it is not evidence about the commit.
 *
 * @param {any} recorded
 * @param {CanonicalManifest|any} current full attestation (preferred) or manifest
 * @param {{compareAttributeLabels?: boolean}} [options]
 * @returns {{ok: boolean, differences: string[]}}
 */
export function compareManifests(recorded, current, options = {}) {
  /** @type {string[]} */
  const differences = [];
  const same = (label, left, right) => {
    if (left !== right) {
      differences.push(`${label}: recorded=${displayValue(left)} recomputed=${displayValue(right)}`);
    }
  };
  const sameJson = (label, left, right) => {
    const leftJson = canonicalJson(left);
    const rightJson = canonicalJson(right);
    if (leftJson !== rightJson) {
      differences.push(`${label}: recorded=${leftJson} recomputed=${rightJson}`);
    }
  };

  const currentCommit = current.commit ?? {
    commitId: /** @type {any} */ (current).commitId,
    treeId: /** @type {any} */ (current).treeId,
    base: null
  };
  const recordedCommit = recorded?.commit ?? {};

  // The recipe and the identity of the evidence format are evidence too: a
  // verifier that accepts a record made by a different algorithm is checking
  // two different things and calling them equal.
  if (/** @type {any} */ (current).schemaVersion !== undefined) {
    same('schemaVersion', recorded?.schemaVersion, /** @type {any} */ (current).schemaVersion);
  }
  if (/** @type {any} */ (current).kind !== undefined) {
    same('kind', recorded?.kind, /** @type {any} */ (current).kind);
  }
  same('commit.commitId', recordedCommit.commitId, currentCommit.commitId);
  same('commit.treeId', recordedCommit.treeId, currentCommit.treeId);

  const recordedBase = recordedCommit.base ?? null;
  const currentBase = currentCommit.base ?? null;
  if (recordedBase === null || currentBase === null) {
    if (recordedBase !== currentBase) {
      differences.push(
        `commit.base: recorded=${displayValue(recordedBase)} recomputed=${displayValue(currentBase)}`
      );
    }
  } else {
    same('commit.base.commitId', recordedBase.commitId, currentBase.commitId);
    same('commit.base.treeId', recordedBase.treeId, currentBase.treeId);
    same('commit.base.ancestryVerified', recordedBase.ancestryVerified, currentBase.ancestryVerified);
    same('commit.base.method', recordedBase.method, currentBase.method);
  }

  sameJson('roots', recorded?.roots, current.roots);
  same('fileCount', recorded?.fileCount, current.fileCount);
  same('compositeSha256', recorded?.compositeSha256, current.compositeSha256);
  same('bindingSha256', recorded?.bindingSha256, current.bindingSha256);
  sameJson('algorithm', recorded?.algorithm, current.algorithm);
  sameJson('encoding', recorded?.encoding, current.encoding);

  if (!Array.isArray(recorded?.files)) {
    differences.push('files: the record has no files array, so no content can be re-derived');
    return { ok: false, differences };
  }

  /** @type {Map<string, any>} */
  const currentByPath = new Map();
  for (const file of current.files) {
    if (currentByPath.has(file.path)) {
      differences.push(`${file.path}: duplicate path in the recomputed manifest`);
      continue;
    }
    currentByPath.set(file.path, file);
  }
  /** @type {Set<string>} */
  const seen = new Set();
  for (const file of /** @type {any[]} */ (recorded.files)) {
    if (typeof file?.path !== 'string' || file.path.length === 0) {
      differences.push('files: the record contains an entry without a path');
      continue;
    }
    if (seen.has(file.path)) {
      differences.push(`${file.path}: duplicate entry in the record`);
      continue;
    }
    seen.add(file.path);
    const live = currentByPath.get(file.path);
    if (live === undefined) {
      differences.push(`${file.path}: recorded but absent from the commit`);
      continue;
    }
    currentByPath.delete(file.path);
    same(`${file.path}: sha256`, file.sha256, live.sha256);
    same(`${file.path}: blobId`, file.blobId, live.blobId);
    same(`${file.path}: mode`, file.mode, live.mode);
    same(`${file.path}: bytes`, file.bytes, live.bytes);
    same(`${file.path}: encoding`, file.encoding, live.encoding);
    same(`${file.path}: encodingException`, file.encodingException, live.encodingException);
    if (options.compareAttributeLabels === true) {
      same(`${file.path}: declaredTextUnset`, file.declaredTextUnset, live.declaredTextUnset);
      same(`${file.path}: declaredEol`, file.declaredEol, live.declaredEol);
    }
  }
  for (const leftover of currentByPath.keys()) {
    differences.push(`${leftover}: present in the commit but missing from the record`);
  }
  return { ok: differences.length === 0, differences };
}

/**
 * Detect tracked worktree modifications.
 *
 * PR-1 forbids "silent worktree fallback": an attestation must describe a
 * COMMIT, so a dirty tracked tree is a hard error at the call site unless the
 * caller explicitly opted out. This helper only reports; the caller decides.
 *
 * @param {string} cwd
 * @returns {string[]}
 */
export function trackedWorktreeChanges(cwd) {
  const out = String(git(['status', '--porcelain', '--untracked-files=no'], cwd)).trim();
  return out.length === 0 ? [] : out.split(/\r?\n/);
}

/**
 * Untracked (non-ignored) paths. Reported separately: they are not part of any commit.
 *
 * @param {string} cwd
 * @returns {string[]}
 */
export function untrackedPaths(cwd) {
  const out = String(git(['status', '--porcelain', '--untracked-files=normal'], cwd))
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.startsWith('?? '));
  return out.map((line) => line.slice(3));
}

/**
 * @param {string} cwd
 * @returns {string}
 */
export function gitVersion(cwd) {
  return String(git(['--version'], cwd)).trim();
}
