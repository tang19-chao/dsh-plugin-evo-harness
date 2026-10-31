/**
 * Report-target resolution and the frozen-report guard (rev5 C-3 / C-9).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The P6.1-F runner used to hard-code its only output path to
 * `docs/reports/p61-host-smoke-rc.md`. That file is a FROZEN artifact: it is the
 * recorded real-host evidence of the first controlled smoke, and rev5 requires
 * its bytes to stay identical (`git hash-object` before/after). A `--out` option
 * alone would not remove the hazard, because the default (no flag) still targets
 * the frozen file: any later member who runs the runner "to see what happens"
 * silently replaces the frozen evidence.
 *
 * The guard is therefore fail-closed: writing to the tracked P6.1-F report is
 * refused unless the caller passes `--force`. The refusal is a named error, not
 * a warning, so a scripted run exits non-zero instead of overwriting.
 *
 * The functions here are pure (the filesystem predicate is injected) so the
 * guard can be unit-tested against temp trees without touching the repository's
 * frozen report.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The frozen P6.1-F real-host report, relative to the repository root. */
export const FROZEN_RC1_RELATIVE = 'docs/reports/p61-host-smoke-rc.md';

/** Where a run writes when no `--out`/env override is given (backwards compatible). */
export const DEFAULT_REPORT_RELATIVE = FROZEN_RC1_RELATIVE;

/** The rev5 host-smoke rc2 report path (frozen evidence as of rev6 t33). */
export const RC2_RELATIVE = 'docs/reports/host-smoke-rc2.md';

/**
 * EVERY frozen real-host report, relative to the repository root.
 *
 * t33 (structural hardening): before this list existed, the guard hard-coded a
 * single comparison against `FROZEN_RC1_RELATIVE`. `RC2_RELATIVE` was exported
 * but never consulted, so rc2 - recorded rev5 evidence - had NO overwrite
 * protection at all: a documented `--out docs/reports/host-smoke-rc2.md` example
 * was enough to destroy it. The list is the fix: adding a future frozen report
 * is one entry here, not a second hand-written comparison that can be forgotten.
 *
 * rc1 must stay FIRST: `frozenPath` reports the first match, and existing
 * callers/tests read that field expecting rc1 when the target is rc1.
 */
export const FROZEN_REPORT_RELATIVES = Object.freeze([
  FROZEN_RC1_RELATIVE,
  RC2_RELATIVE
]);

/**
 * The frozen report a target resolves to, or `undefined` when it is free.
 *
 * Comparison is on the RESOLVED absolute path, so `--out` tricks
 * (`./docs/../docs/...`, trailing separators, different cwd) cannot slip past.
 *
 * @param {string} repoRoot
 * @param {string} targetPath
 * @returns {string | undefined}
 */
export function frozenReportMatch(repoRoot, targetPath) {
  const resolvedTarget = path.resolve(targetPath);
  for (const relative of FROZEN_REPORT_RELATIVES) {
    if (resolvedTarget === path.resolve(repoRoot, relative)) {
      return relative;
    }
  }
  return undefined;
}

/**
 * Resolve the report target.
 *
 * Precedence: explicit `--out` value, then `HOSTSMOKE_OUT_PATH`, then the
 * backwards-compatible default (the frozen rc1 path). Relative paths resolve
 * against the repository root, never against the process cwd, so the same
 * command from any directory writes to the same place.
 *
 * @param {string} repoRoot
 * @param {{out?: string, env?: Record<string, string | undefined>}} [options]
 * @returns {{path: string, source: 'flag' | 'env' | 'default'}}
 */
export function resolveReportPath(repoRoot, options = {}) {
  const fromFlag = typeof options.out === 'string' && options.out.trim().length > 0 ? options.out.trim() : undefined;
  const fromEnv =
    typeof options.env?.HOSTSMOKE_OUT_PATH === 'string' && options.env.HOSTSMOKE_OUT_PATH.trim().length > 0
      ? options.env.HOSTSMOKE_OUT_PATH.trim()
      : undefined;
  const chosen = fromFlag ?? fromEnv;
  const source = fromFlag !== undefined ? 'flag' : fromEnv !== undefined ? 'env' : 'default';
  return { path: path.resolve(repoRoot, chosen ?? DEFAULT_REPORT_RELATIVE), source };
}

/**
 * Is `targetPath` a frozen real-host report, and does it currently exist?
 *
 * `exists` is injected so tests can exercise both branches without a real
 * frozen file. A frozen target that does NOT exist is not protected: writing the
 * first copy is not a destructive act.
 *
 * t33: the check is now driven by `FROZEN_REPORT_RELATIVES` rather than a single
 * hard-coded rc1 comparison, so rc2 is protected by the same rule. `frozenPath`
 * keeps its previous meaning for rc1 (the rc1 test and run.mjs read it), and
 * additionally reports the matching rc2 path when that is the target.
 *
 * @param {string} repoRoot
 * @param {string} targetPath
 * @param {(candidate: string) => boolean} [exists]
 * @returns {{frozen: boolean, reason: string | null, frozenPath: string}}
 */
export function inspectFrozenReportTarget(repoRoot, targetPath, exists = fs.existsSync) {
  const matchedRelative = frozenReportMatch(repoRoot, targetPath);
  // `frozenPath` keeps reporting rc1 when the target is rc1 (existing contract),
  // and reports the matched frozen path otherwise.
  const frozenPath = path.resolve(repoRoot, matchedRelative ?? FROZEN_RC1_RELATIVE);
  if (matchedRelative === undefined) {
    return { frozen: false, reason: null, frozenPath };
  }
  if (!exists(frozenPath)) {
    return {
      frozen: false,
      reason:
        matchedRelative +
        ' is a frozen real-host report but it is absent, so this write creates it rather than overwriting evidence',
      frozenPath
    };
  }
  return {
    frozen: true,
    reason:
      matchedRelative +
      ' is the frozen P6.1-F real-host report; overwriting it destroys the recorded evidence ' +
      '(rev5 C-3/C-9; rc2 is frozen as of rev6 t33). Write the new run with ' +
      '--out <new path>, or pass --force to replace it on purpose.',
    frozenPath
  };
}

/**
 * Fail-closed write authorisation for one report target.
 *
 * Throws an Error whose `code` is `frozen-report-protected` when the target is
 * the existing frozen report and `force !== true`.
 *
 * @param {{repoRoot: string, targetPath: string, force?: boolean, exists?: (candidate: string) => boolean}} input
 * @returns {{path: string, frozen: boolean, forced: boolean}}
 */
export function assertReportTargetWritable(input) {
  const verdict = inspectFrozenReportTarget(input.repoRoot, input.targetPath, input.exists);
  const forced = verdict.frozen && input.force === true;
  if (verdict.frozen && !forced) {
    const error = new Error(verdict.reason);
    // Named so a caller (and a test) can distinguish this refusal from any other
    // I/O failure.
    error.code = 'frozen-report-protected';
    throw error;
  }
  return { path: input.targetPath, frozen: verdict.frozen, forced };
}

/**
 * Parse `--out <path>` / `--out=<path>` / `--force` out of argv.
 *
 * Parsing is separate from authorisation so the runner's argument surface is
 * testable without spawning a host.
 *
 * @param {readonly string[]} argv
 * @returns {{out?: string, force: boolean, problems: string[]}}
 */
export function parseReportArgs(argv) {
  const problems = [];
  let out;
  let force = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--force') {
      force = true;
      continue;
    }
    if (arg === '--out') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        problems.push('--out requires a path');
      } else {
        out = value;
        index += 1;
      }
      continue;
    }
    if (arg.startsWith('--out=')) {
      const value = arg.slice('--out='.length);
      if (value.length === 0) {
        problems.push('--out requires a path');
      } else {
        out = value;
      }
    }
  }
  return { ...(out === undefined ? {} : { out }), force, problems };
}
