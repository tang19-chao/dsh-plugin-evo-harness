#!/usr/bin/env node
/**
 * Clean-tree / test-input gate (rev5 P0-4, A-t9-7).
 *
 * WHY THIS GATE EXISTS
 * --------------------
 * CI runs the test suite and then `check:docs` against the JSON report that run
 * produced. That chain is only evidence if the bytes under test are the bytes
 * that were checked out:
 *
 *   - a MODIFIED or DELETED tracked file means the suite judged something the
 *     commit does not contain (the classic "fixed it locally, pushed the test"
 *     failure - green here, red for everyone else);
 *   - an UNEXPECTED untracked file can change what is collected (a stray
 *     `*.test.ts` under `tests/`) or what a gate reads (a pre-existing
 *     `test-results.json` consumed by `check:docs` instead of the fresh run);
 *   - a tracked test INPUT that is absent from the index means a clean clone
 *     cannot reproduce the run at all.
 *
 * So this gate is deliberately run BEFORE the test step in CI. It fails closed:
 * every tracked change is a failure (there is no "expected modification"), and
 * only a small EXPLICIT allow list of known GENERATED artifacts
 * (`test-results.json`, `lib/`, `attestation.json`, `coverage/`) may appear as
 * untracked. The allow list is validated itself: a rule that could cover
 * `src/`, `tests/`, `scripts/` or `package.json` is rejected before any status
 * is read, so nobody can whitelist source or test bytes into a "clean" tree.
 *
 * WHY IT IS NOT PART OF `pnpm run verify`
 * ---------------------------------------
 * This round's worktree is intentionally uncommitted across many concurrent
 * tasks (rev5 contract G12), so running this gate in the local `verify` script
 * would make every local verification permanently red. It runs in CI before the
 * tests, or explicitly: `pnpm run check:clean-tree`. That boundary is recorded
 * in the runbook (`docs/runbooks/build-freshness-and-clean-tree.md`).
 *
 * `--require-tracked <path>` is the "test inputs" half: it checks that at least
 * one tracked entry exists under the given path (a file, or a directory such as
 * `tests/`), so a checkout that lost a fixture manifest or an entire input
 * directory fails by name instead of failing later as an unexplained ENOENT.
 *
 * Usage:
 *   node scripts/eval/check-clean-tree.mjs [--cwd <dir>] [--json]
 *        [--allow <rule>]... [--require-tracked <path>]...
 *
 *   --allow <rule>          extra untracked allowance (exact path, directory
 *                           ending in `/`, or `*`/`**` glob). Added to the
 *                           default generated-artifact list.
 *   --require-tracked <p>   require `git ls-files -- <p>` to be non-empty.
 *
 * Exit codes: 0 = clean (all tracked changes absent, untracked only allowed
 * items, required inputs tracked); 1 = any failure, named on stderr.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitEvidenceError } from './lib/git-objects.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

/**
 * Known GENERATED artifacts that may be untracked when CI runs this gate.
 * Everything else untracked is a failure. These are files a build/test step in
 * the same job creates; none of them is source, test or gate input.
 */
export const DEFAULT_ALLOW = Object.freeze(['test-results.json', 'lib/', 'attestation.json', 'coverage/']);

/** Exact tracked paths that may never be covered by an allowance. */
const PROTECTED_EXACT = Object.freeze(['package.json', 'pnpm-lock.yaml', '.gitattributes']);
/** Top-level directories that may never be covered by an allowance. */
const PROTECTED_ROOTS = Object.freeze(['src', 'tests', 'scripts']);

/** Run git with a scrubbed environment; any failure is a named error. */
function git(args, cwd) {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  try {
    return String(
      execFileSync('git', args.slice(), {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    );
  } catch (error) {
    const stderr = error && /** @type {any} */ (error).stderr;
    const detail = stderr === undefined || stderr === null ? String(error && error.message) : String(stderr).trim();
    throw new GitEvidenceError('git-command-failed', `git ${args.join(' ')} failed: ${detail}`);
  }
}

/** Translate a simple `*`/`**`/`?` allowance into a regular expression. */
function allowanceRegex(pattern) {
  let out = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
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
    } else {
      out += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(out + '$');
}

/** Is `entryPath` protected source/test/input content? */
export function isProtectedPath(entryPath) {
  const normalized = entryPath.replace(/\\/g, '/');
  if (PROTECTED_EXACT.includes(normalized)) {
    return true;
  }
  return PROTECTED_ROOTS.some((root) => normalized === root || normalized.startsWith(root + '/'));
}

/**
 * Validate one allowance rule BEFORE it is used. A rule that can cover source,
 * tests, scripts or package metadata is a policy error, not a clean tree.
 *
 * @param {string} rule
 * @returns {{kind: 'exact'|'directory'|'glob', value: string}}
 */
export function validateAllowance(rule) {
  if (typeof rule !== 'string' || rule.trim().length === 0) {
    throw new GitEvidenceError('allow-rule-invalid', 'an allowance rule must be a non-empty string');
  }
  const normalized = rule.trim().replace(/^\.\//, '').replace(/\\/g, '/');
  if (normalized === '.' || normalized === '' || normalized === '/' || normalized === '**' || normalized === '*') {
    throw new GitEvidenceError(
      'allow-rule-invalid',
      `allowance ${JSON.stringify(rule)} would cover every untracked path, including source and tests`
    );
  }
  const withoutTrailingSlash = normalized.replace(/\/+$/, '');
  if (isProtectedPath(withoutTrailingSlash)) {
    throw new GitEvidenceError(
      'allow-rule-covers-protected-path',
      `allowance ${JSON.stringify(rule)} names protected content (${PROTECTED_ROOTS.join('/, ')}/, ${PROTECTED_EXACT.join(', ')}); ` +
        'generated artifacts only may be allowed'
    );
  }
  // A wildcard rule must not be able to match protected paths either. Test it
  // against representative paths so `*` or `*.json` cannot smuggle package.json
  // or source files into the allow list.
  if (normalized.includes('*') || normalized.includes('?')) {
    const regex = allowanceRegex(normalized);
    if (
      regex.test('package.json') ||
      regex.test('src/index.ts') ||
      regex.test('tests/unit/a.test.ts') ||
      regex.test('scripts/eval/a.mjs')
    ) {
      throw new GitEvidenceError(
        'allow-rule-covers-protected-path',
        `allowance ${JSON.stringify(rule)} is a wildcard that can match protected content; ` +
          'use the exact generated-artifact path (or a directory ending in `/`)'
      );
    }
  }
  if (normalized.endsWith('/')) {
    return { kind: 'directory', value: normalized };
  }
  return { kind: normalized.includes('*') || normalized.includes('?') ? 'glob' : 'exact', value: normalized };
}

/** Does one validated allowance match an untracked path? */
function allowanceMatches(allowance, entryPath) {
  const normalized = entryPath.replace(/\\/g, '/');
  if (allowance.kind === 'exact') {
    return normalized === allowance.value;
  }
  if (allowance.kind === 'directory') {
    const prefix = allowance.value;
    return normalized === prefix.slice(0, -1) || normalized.startsWith(prefix);
  }
  return allowanceRegex(allowance.value).test(normalized);
}

/**
 * Parse `git status --porcelain=v1 -z --untracked-files=all`.
 *
 * Format: `XY PATH\0`, with a second `ORIG_PATH\0` after rename/copy entries.
 * Ignored files never appear (we do not pass --ignored), so `.gitignore`d
 * scratch space such as `work/` is not a failure.
 *
 * @param {string} cwd
 * @returns {{status: string, path: string}[]}
 */
export function readStatusEntries(cwd) {
  const raw = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd);
  const tokens = raw.split('\u0000');
  /** @type {{status: string, path: string}[]} */
  const entries = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token.length === 0) {
      continue;
    }
    const status = token.slice(0, 2);
    const entryPath = token.slice(3).replace(/\\/g, '/');
    if (entryPath.length === 0) {
      throw new GitEvidenceError('status-malformed', `unexpected git status entry: ${JSON.stringify(token)}`);
    }
    entries.push({ status, path: entryPath });
    // Rename/Copy entries carry the original path as the next NUL field.
    if (status.startsWith('R') || status.startsWith('C')) {
      index += 1;
    }
  }
  return entries;
}

/**
 * Judge the working tree of `cwd`.
 *
 * @param {{cwd?: string, allow?: readonly string[], requireTracked?: readonly string[]}} [options]
 * @returns {{
 *   ok: boolean,
 *   failures: {code: string, detail: string}[],
 *   trackedChanges: {status: string, path: string}[],
 *   untracked: string[],
 *   allowed: string[],
 *   unexpected: string[],
 *   requiredInputs: {path: string, tracked: boolean}[],
 *   allow: string[]
 * }}
 */
export function checkCleanTree(options = {}) {
  const cwd = options.cwd ?? rootDir;
  const allowRules = [...DEFAULT_ALLOW, ...(options.allow ?? [])];
  const allowances = allowRules.map(validateAllowance);
  const requiredPaths = [...(options.requireTracked ?? [])];

  const entries = readStatusEntries(cwd);
  const trackedChanges = entries.filter((entry) => entry.status !== '??');
  const untracked = entries.filter((entry) => entry.status === '??').map((entry) => entry.path);

  /** @type {string[]} */
  const allowed = [];
  /** @type {string[]} */
  const unexpected = [];
  for (const entryPath of untracked) {
    if (allowances.some((allowance) => allowanceMatches(allowance, entryPath))) {
      allowed.push(entryPath);
    } else {
      unexpected.push(entryPath);
    }
  }
  // Defence in depth: even if a rule slipped through validation, an allowed
  // path that IS protected content is a failure, never a pass.
  const protectedAllowed = allowed.filter((entryPath) => isProtectedPath(entryPath));

  /** @type {{code: string, detail: string}[]} */
  const failures = [];
  for (const entry of trackedChanges) {
    failures.push({
      code: 'tracked-change',
      detail: `${entry.status.trim() || entry.status} ${entry.path}: a tracked file differs from the commit, so the suite would judge bytes the commit does not contain`
    });
  }
  for (const entryPath of unexpected) {
    failures.push({
      code: 'untracked-unexpected',
      detail: `${entryPath}: untracked and not a listed generated artifact; a stray test or a stale report can change what the suite/gate sees`
    });
  }
  for (const entryPath of protectedAllowed) {
    failures.push({
      code: 'allowlist-covers-protected-path',
      detail: `${entryPath}: the allowance matched protected content; source/tests/scripts/package.json may never be allowed`
    });
  }

  /** @type {{path: string, tracked: boolean}[]} */
  const requiredInputs = [];
  for (const requiredPath of requiredPaths) {
    if (typeof requiredPath !== 'string' || requiredPath.length === 0) {
      failures.push({ code: 'require-tracked-invalid', detail: '--require-tracked requires a non-empty path' });
      continue;
    }
    let trackedEntries;
    try {
      trackedEntries = git(['ls-files', '-z', '--', requiredPath], cwd).split('\u0000').filter((entry) => entry.length > 0);
    } catch (error) {
      failures.push({
        code: 'required-input-unreadable',
        detail: `${requiredPath}: could not ask git for tracked entries (${error instanceof Error ? error.message : String(error)})`
      });
      continue;
    }
    const tracked = trackedEntries.length > 0;
    requiredInputs.push({ path: requiredPath, tracked });
    if (!tracked) {
      failures.push({
        code: 'required-input-not-tracked',
        detail: `${requiredPath}: no tracked entries under this path; a clean clone cannot reproduce the test input`
      });
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    trackedChanges,
    untracked,
    allowed,
    unexpected,
    requiredInputs,
    allow: allowRules
  };
}

const USAGE = [
  'Clean-tree / test-input gate (rev5 P0-4).',
  '',
  'USAGE',
  '  node scripts/eval/check-clean-tree.mjs [--cwd <dir>] [--json]',
  '       [--allow <rule>]... [--require-tracked <path>]...',
  '',
  'DEFAULT ALLOWANCES (generated artifacts only)',
  '  ' + DEFAULT_ALLOW.join(', '),
  '',
  'FAILURE CODES',
  '  tracked-change, untracked-unexpected, allowlist-covers-protected-path,',
  '  required-input-not-tracked, allow-rule-covers-protected-path',
  '',
  'Boundary: this gate is NOT part of `pnpm run verify` (the rev5 worktree is',
  'uncommitted by design); it runs in CI before the tests, or explicitly via',
  '`pnpm run check:clean-tree`.'
].join('\n');

const isDirectExecution = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectExecution) {
  const rawArgv = process.argv.slice(2);
  let cwd = rootDir;
  let json = false;
  /** @type {string[]} */
  const allow = [];
  /** @type {string[]} */
  const requireTracked = [];
  /** @type {string[]} */
  const unknown = [];
  for (let index = 0; index < rawArgv.length; index += 1) {
    const arg = rawArgv[index];
    if (arg === '--cwd' || arg === '--allow' || arg === '--require-tracked') {
      const value = rawArgv[index + 1];
      if (value === undefined) {
        console.error(`[clean-tree] argument-value-missing: ${arg} requires a value`);
        process.exit(1);
      }
      if (arg === '--cwd') {
        cwd = value;
      } else if (arg === '--allow') {
        allow.push(value);
      } else {
        requireTracked.push(value);
      }
      index += 1;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else {
      unknown.push(arg);
    }
  }
  if (unknown.length > 0) {
    console.error('[clean-tree] unknown-argument: ' + unknown.join(' '));
    process.exit(1);
  }
  try {
    const result = checkCleanTree({ cwd, allow, requireTracked });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('[clean-tree] tracked changes: ' + String(result.trackedChanges.length));
      console.log(
        '[clean-tree] untracked: ' +
          String(result.untracked.length) +
          ' (allowed: ' +
          String(result.allowed.length) +
          ', unexpected: ' +
          String(result.unexpected.length) +
          ')'
      );
      if (result.requiredInputs.length > 0) {
        console.log(
          '[clean-tree] required inputs tracked: ' +
            result.requiredInputs.map((input) => input.path + '=' + String(input.tracked)).join(', ')
        );
      }
      for (const failure of result.failures) {
        console.error('[clean-tree] FAIL ' + failure.code + ': ' + failure.detail);
      }
      console.log(
        result.ok
          ? '[clean-tree] OK: the checkout is clean and every required test input is tracked'
          : '[clean-tree] FAIL'
      );
    }
    if (!result.ok) {
      process.exit(1);
    }
  } catch (error) {
    if (error instanceof GitEvidenceError) {
      console.error('[clean-tree] ' + error.code + ': ' + error.message);
    } else {
      console.error('[clean-tree] error: ' + (error instanceof Error ? error.message : String(error)));
    }
    process.exit(1);
  }
}
