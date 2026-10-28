#!/usr/bin/env node
/**
 * Encoding and line-ending policy gate (PR-1).
 *
 * WHY THIS GATE EXISTS
 * --------------------
 * ADR 0003's appendix recorded 15 file digests. 14 of them were computed from
 * the WORKING TREE on a `core.autocrlf=true` Windows checkout, so they cannot be
 * reproduced on an LF checkout - the same commit, two answers. That defect was
 * only discovered when a later task tried to re-verify the appendix
 * (`work/t1-baseline-audit.md` §5 F-1).
 *
 * Two separate things are needed to stop it recurring, and this gate checks the
 * second one:
 *   1. EVIDENCE comes from the object database (`git cat-file`), which is
 *      LF-normalised regardless of checkout - implemented in
 *      `scripts/eval/lib/git-objects.mjs`.
 *   2. CONTENT is declared: every tracked blob that is not plain LF text must be
 *      an explicit, commented `-text` (or `binary`) declaration in THE COMMITTED
 *      `.gitattributes`. Otherwise the bytes a checkout produces depend on the
 *      machine, and a digest over them is not portable evidence.
 *
 * THE POLICY IS READ FROM THE COMMIT, NOT FROM THE WORKTREE
 * ----------------------------------------------------------
 * The first version of this gate read `.gitattributes` with `fs.readFileSync`,
 * i.e. the file on disk. When `.gitattributes` is untracked (or locally edited)
 * that is a FALSE PASS: the gate blesses blobs using a policy the commit does
 * not contain, and the manifest it protects then depends on whose machine
 * happened to have the file. This gate therefore asks
 * `git check-attr --source=<commit>` (or parses the commit tree's
 * `.gitattributes` on git < 2.40). An untracked or modified worktree copy cannot
 * change the answer, and a bare clone (no worktree at all) re-checks
 * identically.
 *
 * WHAT THIS GATE REFUSES
 * ----------------------
 *   - a blanket `* text=auto` / `* text` rule: it would renormalise the whole
 *     repository, rewriting historical blobs, invalidating every existing digest
 *     and producing a mass diff nobody reviews. PR-1 deliberately does not do
 *     that; nor may a later change do it silently;
 *   - any tracked blob with CRLF, a lone CR, a BOM or NUL bytes that is not
 *     declared `-text`;
 *   - a commit whose tree has no `.gitattributes` at all (no committed policy is
 *     not a policy). A locally present but uncommitted file does NOT count.
 *
 * Usage:
 *   node scripts/eval/check-encoding-policy.mjs              human summary
 *   node scripts/eval/check-encoding-policy.mjs --json       machine-readable
 *   node scripts/eval/check-encoding-policy.mjs --ref <ref>  inspect another commit
 *
 * Exit codes: 0 = policy holds for the inspected commit, 1 = violation(s) found.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GitEvidenceError,
  classifyBytes,
  listTreeBlobs,
  readAttributes,
  readBlobsBatch,
  readCommitBlobAtPath,
  resolveCommit
} from './lib/git-objects.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../..');

/** Rules that would renormalise every path: forbidden without a reviewed plan. */
const BLANKET_RULES = [/^\*\s+text\s*=\s*auto\s*$/i, /^\*\s+text\s*$/i, /^\*\s+-text\s*$/i];

/**
 * @typedef {object} Violation
 * @property {string} kind
 * @property {string} detail
 */

/**
 * Inspect the encoding policy of the commit named by `options.ref`.
 *
 * `options.cwd` and `options.ref` exist so a test can point the SAME code at a
 * throw-away repository that contains an undeclared CRLF fixture, or at a
 * specific commit. Without that seam the gate would only ever be exercised on a
 * clean tree, i.e. only in the direction that passes - which is exactly the
 * "a gate that cannot fail" defect PR-1 set out to remove.
 *
 * @param {{ref?: string, cwd?: string}} [options]
 * @returns {{violations: Violation[], checked: number, exceptions: string[], attributesPresent: boolean, declaredRules: string[], commitId: string}}
 */
export function checkEncodingPolicy(options = {}) {
  const cwd = options.cwd ?? rootDir;
  const ref = options.ref ?? 'HEAD';
  /** @type {Violation[]} */
  const violations = [];

  // ---- 0. bind the whole check to one commit --------------------------------
  const commit = resolveCommit(ref, cwd);

  // ---- 1. the policy file must be IN THE COMMIT and must not be a blanket ---
  const policyFile = readCommitBlobAtPath(commit, '.gitattributes', cwd);
  const attributesPresent = policyFile !== null;
  /** @type {string[]} */
  const declaredRules = [];
  if (!attributesPresent) {
    violations.push({
      kind: 'attributes-missing',
      detail:
        `commit ${commit.commitId} (${ref}) has no .gitattributes in its tree: there is no committed content ` +
        'policy, so checkout bytes are machine-dependent. A .gitattributes that exists only on disk (untracked ' +
        'or modified) is deliberately ignored here - it would let one machine bless what the commit does not declare'
    });
  } else {
    const text = /** @type {{bytes: Buffer}} */ (policyFile).bytes.toString('utf8');
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith('#')) {
        continue;
      }
      declaredRules.push(line);
      for (const pattern of BLANKET_RULES) {
        if (pattern.test(line)) {
          violations.push({
            kind: 'blanket-renormalise',
            detail:
              `'.gitattributes' contains a blanket rule "${line}". A repo-wide renormalise rewrites every historical ` +
              'blob, invalidates every recorded digest and lands as an unreviewable mass diff. Declare narrow, commented ' +
              'rules instead (PR-1 .gitattributes header).'
          });
        }
      }
    }
    if (declaredRules.length === 0) {
      violations.push({ kind: 'attributes-empty', detail: '.gitattributes declares no rule' });
    }
  }

  // ---- 2. every tracked blob must be LF-only text, or declared -text --------
  // Inspected even when the policy file is missing: a missing policy AND an
  // undeclared CRLF blob are two independent facts and both belong in the report.
  let checked = 0;
  /** @type {string[]} */
  const exceptions = [];
  const entries = listTreeBlobs(commit, cwd);
  const blobs = readBlobsBatch(
    entries.map((entry) => entry.blobId),
    cwd
  );
  // Attributes come from the same commit. With no committed .gitattributes every
  // answer is `unspecified`, so nothing can be excused.
  const attributes = readAttributes(
    entries.map((entry) => entry.path),
    cwd,
    commit.commitId
  );
  for (const entry of entries) {
    const bytes = blobs.get(entry.blobId);
    if (bytes === undefined) {
      throw new GitEvidenceError('blob-missing', `object database returned no bytes for ${entry.path}`);
    }
    checked += 1;
    const classified = classifyBytes(bytes);
    if (classified.kind === 'text-lf') {
      continue;
    }
    const declared = attributes.get(entry.path) ?? { text: 'unspecified', eol: 'unspecified' };
    if (declared.text === 'unset') {
      exceptions.push(`${entry.path} (${classified.kind}, ${bytes.length}B)`);
      continue;
    }
    const detail =
      `${entry.path}: committed bytes are ${classified.kind}` +
      (classified.kind === 'text-crlf'
        ? ` (${classified.crlf} CRLF, ${classified.loneCr} lone CR)`
        : classified.kind === 'text-bom'
          ? ` (BOM ${classified.bom})`
          : ` (${classified.nul} NUL byte(s))`) +
      `, but the commit's .gitattributes says text=${declared.text} eol=${declared.eol}. ` +
      'A checkout of this path is machine-dependent, so any digest over it is not portable. ' +
      "Declare it '-text' (or 'binary') in the COMMITTED .gitattributes, with a comment explaining why the bytes must be exact.";
    violations.push({ kind: 'undeclared-non-lf-blob', detail });
  }

  return { violations, checked, exceptions, attributesPresent, declaredRules, commitId: commit.commitId };
}

const __filename = fileURLToPath(import.meta.url);
const isDirectExecution = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectExecution) {
  /** @type {{json: boolean, ref: string}} */
  const options = { json: false, ref: 'HEAD' };
  const unknown = [];
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--ref') {
      options.ref = argv[++index];
    } else {
      unknown.push(arg);
    }
  }
  if (unknown.length > 0) {
    console.error('[encoding-policy] unknown argument(s): ' + unknown.join(' '));
    process.exitCode = 1;
  } else if (typeof options.ref !== 'string' || options.ref.length === 0) {
    console.error('[encoding-policy] --ref requires a non-empty value');
    process.exitCode = 1;
  } else {
    try {
      const result = checkEncodingPolicy({ ref: options.ref });
      if (options.json) {
        console.log(JSON.stringify({ ok: result.violations.length === 0, ...result }, null, 2));
      } else {
        console.log('[encoding-policy] commit: ' + result.commitId);
        console.log('[encoding-policy] .gitattributes in commit: ' + (result.attributesPresent ? 'present' : 'MISSING'));
        console.log('[encoding-policy] declared rules: ' + String(result.declaredRules.length));
        console.log('[encoding-policy] tracked blobs inspected: ' + String(result.checked));
        console.log('[encoding-policy] declared -text exceptions: ' + String(result.exceptions.length));
        for (const exception of result.exceptions) {
          console.log('  exception: ' + exception);
        }
        if (result.violations.length === 0) {
          console.log('[encoding-policy] SUCCESS: every tracked blob is LF text or an explicit -text exception');
        } else {
          console.error('[encoding-policy] FAIL: ' + String(result.violations.length) + ' violation(s)');
          for (const violation of result.violations) {
            console.error('  [' + violation.kind + '] ' + violation.detail);
          }
        }
      }
      if (result.violations.length > 0) {
        process.exitCode = 1;
      }
    } catch (error) {
      if (error instanceof GitEvidenceError) {
        console.error('[encoding-policy] ' + error.code + ': ' + error.message);
      } else {
        console.error('[encoding-policy] unexpected error: ' + (error instanceof Error ? error.message : String(error)));
      }
      process.exitCode = 1;
    }
  }
}