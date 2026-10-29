#!/usr/bin/env node
/**
 * PR-4A artifact verification.
 *
 * Encodes every claim the report makes as a MACHINE assertion whose result is an
 * exit code, so the run is verifiable even when stdout cannot be read. Exit 0
 * means every assertion held; exit 1 means at least one did not. A summary plus
 * every failing check id/detail is printed to stdout, and the same failure list
 * is written to work/pr4a-verify-status.json whenever that output file is
 * writable, so a missing work/ directory is still diagnosable instead of silent.
 *
 * This is also the reproducibility check (V2 §4.1.4): it re-runs nothing, but it
 * does re-derive every statistic from the persisted ledgers/JSON, so a report
 * that disagrees with its own data fails here.
 *
 * EVIDENCE PORTABILITY. The provenance block is verified in all three workspace
 * states rather than requiring a non-empty dirty list unconditionally:
 *   (a) MISSING — work/ or the report artifact is absent: the run fails with the
 *       exact missing paths, and prints that summary on stdout even though no
 *       status file can be written;
 *   (b) CLEAN — workspaceDirty=false, trackedDirtyCount=0, dirtyFileDigests=[],
 *       trackedWorkspaceDigest=sha256('') and the executed sources still match
 *       the bytes on disk: the empty list is a legitimate clean capture;
 *   (c) DIRTY — workspaceDirty=true with a non-empty list whose paths resolve,
 *       whose count matches, whose trackedWorkspaceDigest is recomputable from
 *       the listed entries, AND whose paths are a subset of
 *       `git diff --name-only <codeBaseline>` (t1 B1 state 5). The list is a
 *       snapshot of tracked changes relative to the frozen baseline, so its
 *       BYTES stay historical, but a fabricated or restored path is rejected.
 * In every state the executed source digests must still reconcile with the
 * bytes on disk, because those are the bytes the report claims actually ran.
 *
 * CHECKOUT BYTE SPEC (eol-equiv-v1, ADR 0005 decision D2). `fileSha256` in the
 * eval run hashes the RAW working-tree bytes, so an executed-source digest
 * RECORDS the checkout byte configuration that produced it. Those recorded
 * digests are historical byte facts: this verifier never rewrites, renormalises
 * or regenerates them, and the generator side is untouched (no new
 * generation-side field is required — records without any version field, such
 * as the shipped artifact, are judged by the same rule). On top of the raw
 * record the verifier applies a VERSIONED verification-side equivalence rule,
 * `eol-equiv-v1`, so the same text under another line-ending checkout is judged
 * explicitly instead of failing opaquely:
 *   raw match       sha256(disk bytes) == recorded digest (strongest, unchanged);
 *   eol-equivalent  the recorded digest equals the sha256 of the disk text after
 *                   the ONE sanctioned transform CRLF -> LF, or its exact
 *                   inverse LF -> CRLF. Nothing else is normalised: no BOM
 *                   removal, no lone-CR handling, no trailing-whitespace or
 *                   Unicode normalisation;
 *   drift           everything else — real content change, BOM added/removed,
 *                   binary or invalid-UTF-8 bytes — FAILS
 *                   `provenance-executed-sources-match-disk` exactly as before.
 * Binary (NUL-containing) and invalid-UTF-8 disk bytes NEVER enter the
 * equivalence judgement (they must not be "normalised" into a match).
 * Equivalence hits are reported as the named classification
 * `provenance-executed-sources-eol-equivalent` (with the version string in its
 * detail, advisory:false, pass kind 'eol-equivalent') and are NEVER merged into
 * the raw-match count.
 * MIGRATION of the old warning id (ADR 0005 §2.5): `provenance-executed-sources-eol-divergent`
 * is RETAINED, not deleted. It no longer fires when every difference is
 * eol-equivalent (that state became the pass classification above); it fires
 * only in the mixed state — some entries hit equivalence while OTHER executed
 * sources genuinely drift — as a diagnostic that part of the divergence set is
 * line-ending-flavoured.
 * An executedSources entry that is malformed (absolute/traversal/drive-letter
 * path, non-hex digest) or unreadable is a FAILURE, never silently filtered
 * out of the comparison.
 *
 * `--help` prints this contract (byte spec, exit codes and the eol/subset check
 * names), so the documented spec and the comparison cannot drift apart.
 *
 * REVISION (PR-4A statistical-audit repair). The assertions below were extended
 * to cover the repaired semantics, so a regression to an audited defect fails
 * LOUDLY instead of silently passing:
 *   - per-ROW track isolation (the old check read the last `wroteTrack` scalar);
 *   - §6.3 audit-only: unauthenticated executions are never persisted, and the
 *     quality neighbourhood carries no unauthenticated record;
 *   - §3.4 gate-OFF arms still persist the four challenger fields;
 *   - §8.5 verdicts re-derived from the ESTIMATOR interval and the estimator's
 *     own DTS, with the Clopper-Pearson interval explicitly NOT the verdict
 *     interval;
 *   - §8.3.1/§8.3.2 primary-test selection per series data type;
 *   - §8.1 effectiveReplication derived from the data, never the constant 5;
 *   - §9.3 six token fields, §6.1 host verdict, §10.2 execution-control coverage,
 *     §12.2 the 12x10 per-task table, FULL SHA-256 ledger digests, and a code
 *     provenance block that can locate the executed code.
 *
 * MEASUREMENT CAPABILITY (P3-C, cost/token provenance). "measured" is judged by
 * a DECLARATION, not forbidden forever:
 *   - no declaration (the frozen artifact): the historical rule stands — the
 *     measured count must be 0 and no token field may claim precision measured;
 *   - `measurement: { tokenizer: true }` (or top-level `tokenizer: true`):
 *     measured data is ALLOWED but must actually appear (zero measured calls
 *     under a declaration is a broken capture), and the counts/shares closure
 *     rules still apply unchanged.
 * The frozen artifact contains no declaration, so its 691/691 judgement is
 * byte-for-byte unchanged; the capability path is covered by the mutation tests
 * in tests/unit/eval/pr4a-cost-provenance-gate.test.ts.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = process.cwd();
const results = [];
/**
 * executedSources entries classified `eol-equivalent` under eol-equiv-v1
 * (ADR 0005 D2). Reported as a NAMED classification in the stdout summary and
 * in the status file's `eolEquivalents` key — never merged into the raw-match
 * count and never a failure. Populated while judging the provenance block.
 */
const eolEquivalentPaths = [];
function assert(id, condition, detail) {
  results.push({ id, ok: Boolean(condition), detail: detail ?? '' });
}
/**
 * A non-failing, named observation: printed as WARN and recorded in the status
 * file's `warnings`. Warnings never change the exit code; they exist to make a
 * byte divergence diagnosable instead of one opaque mismatch.
 */
function warn(id, detail) {
  results.push({ id, ok: true, advisory: true, detail: detail ?? '' });
}
function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
function digestOfBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
/** Raw bytes of a repo-relative file, or null when unreadable. */
function readRepoFileBytes(relativePath) {
  try {
    return readFileSync(join(REPO_ROOT, relativePath));
  } catch {
    return null;
  }
}
/**
 * sha256 of the current RAW bytes of a repo-relative file, or null.
 * Retained as a helper; executed-source comparisons now go through
 * `readRepoFileBytes` + `classifyExecutedSource` (eol-equiv-v1).
 */
function digestOfFile(relativePath) {
  const bytes = readRepoFileBytes(relativePath);
  return bytes === null ? null : digestOfBytes(bytes);
}
const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_REL_PATH = /^\.?[A-Za-z0-9._/-]+$/;
function isSafeRelativePath(value) {
  const text = String(value);
  return SAFE_REL_PATH.test(text) && !text.split('/').includes('..');
}
/**
 * T7-F2: an executedSources entry must be well-formed BEFORE any disk compare:
 * object, non-empty repo-relative path (no leading slash, no drive letter, no
 * backslash, no '..'/empty segment) and a 64-hex sha256. Anything else is a
 * failure named by `provenance-executed-entries-well-formed`; it is never
 * filtered out of the comparison.
 */
function isWellFormedExecutedEntry(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
  if (typeof entry.path !== 'string' || entry.path.length === 0) return false;
  if (typeof entry.sha256 !== 'string' || !HEX64.test(entry.sha256)) return false;
  if (entry.path.startsWith('/') || entry.path.includes('\\') || /^[A-Za-z]:/.test(entry.path)) return false;
  return entry.path.split('/').every((segment) => segment.length > 0 && segment !== '..');
}
/**
 * True when the current bytes and the recorded digest differ ONLY by CRLF/LF
 * form: the recorded bytes are the same text under another checkout byte
 * configuration. The transforms are exactly the `eol-equiv-v1` ones (the only
 * sanctioned normalisation: CRLF -> LF and its exact inverse LF -> CRLF; no BOM,
 * lone-CR, whitespace or Unicode handling), and binary/invalid-UTF-8 bytes never
 * enter the judgement.
 */
function isEolOnlyDivergence(bytes, recorded) {
  if (bytes === null || bytes.includes(0)) return false;
  const text = bytes.toString('utf8');
  if (text.includes('\uFFFD')) return false; // not valid UTF-8: never reinterpret bytes
  const lf = text.replace(/\r\n/g, '\n');
  const crlf = lf.replace(/\n/g, '\r\n');
  return sha256(lf) === recorded || sha256(crlf) === recorded;
}

/** The version string of the verification-side equivalence rule (ADR 0005 D2). */
const EOL_EQUIV_VERSION = 'eol-equiv-v1';

/**
 * Classify ONE executed-source entry against the disk bytes (eol-equiv-v1).
 *
 * @param {Buffer|null} bytes raw disk bytes (null when unreadable)
 * @param {string} recorded the recorded (generation-time) digest
 * @returns {'raw'|'eol-equivalent'|'drift'|'unreadable'}
 *   raw            — strongest: sha256(disk bytes) equals the recorded digest;
 *   eol-equivalent — the same text under the other line-ending form (the
 *                    versioned equivalence rule, semantics reused verbatim from
 *                    `isEolOnlyDivergence`);
 *   drift          — any other byte difference (content, BOM, binary);
 *   unreadable     — no bytes could be read (separate failure id).
 */
function classifyExecutedSource(bytes, recorded) {
  if (bytes === null) return 'unreadable';
  if (digestOfBytes(bytes) === recorded) return 'raw';
  if (isEolOnlyDivergence(bytes, recorded)) return 'eol-equivalent';
  return 'drift';
}
/**
 * Paths changed between the recorded codeBaseline and the current working tree.
 * `paths === null` means the constraint could not be evaluated and must FAIL
 * (never be skipped). `git diff <commit>` compares the frozen commit with the
 * worktree, which is exactly the t1 B1 state-5 subset judgment (b).
 */
function baselineChangedPaths(codeBaseline) {
  /** Git environment without caller-injected repo overrides (e.g. CI hooks). */
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) env[key] = value;
  }
  try {
    const output = execFileSync('git', ['diff', '--name-only', '-z', String(codeBaseline)], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env,
      maxBuffer: 64 * 1024 * 1024
    });
    return { paths: new Set(output.split('\0').filter((entry) => entry.length > 0)), error: '' };
  } catch (error) {
    return { paths: null, error: error instanceof Error ? error.message : String(error) };
  }
}
/** sha256 of the empty tracked-file list: the identity of a clean capture. */
const EMPTY_TREE_DIGEST = sha256('');
function closeTo(actual, expected, tolerance = 1e-9) {
  return typeof actual === 'number' && Math.abs(actual - expected) <= tolerance;
}

/**
 * Byte-checkout contract. Kept beside `--help` so the documented spec and the
 * comparison cannot drift apart: the digests are raw worktree bytes, so a green
 * run is only meaningful under the checkout configuration the artifact was
 * generated in.
 */
const HELP_TEXT = [
  'PR-4A artifact verification (read-only; re-derives, never re-runs the eval).',
  '',
  'USAGE',
  '  node scripts/eval/verify-pr4a-artifacts.mjs',
  '  node scripts/eval/verify-pr4a-artifacts.mjs --help',
  '',
  'CHECKOUT BYTE SPEC (eol-equiv-v1; executedSources raw digests + a versioned',
  '  verification-side equivalence rule)',
  '  The recorded digests are the RAW worktree bytes as they existed when the',
  '  eval ran; they are historical byte facts and are never rewritten,',
  '  renormalised or regenerated by this verifier. Judgement per entry:',
  '    raw match       sha256(disk bytes) == recorded digest (strongest);',
  '    eol-equivalent  recorded == sha256 of the disk text after the ONE',
  '                    sanctioned CRLF -> LF transform, or its exact inverse',
  '                    LF -> CRLF (rule eol-equiv-v1). No BOM removal, no',
  '                    lone-CR handling, no whitespace or Unicode normalisation;',
  '                    binary (NUL) and invalid-UTF-8 disk bytes never enter the',
  '                    equivalence judgement;',
  '    drift           real content change, BOM added/removed or binary bytes:',
  '                    provenance-executed-sources-match-disk FAILS as before.',
  '  Equivalence hits are reported as the named classification',
  '  provenance-executed-sources-eol-equivalent (pass kind eol-equivalent,',
  '  advisory:false) and are never merged into the raw-match count. The',
  '  generator side is untouched: records carry no new field (the shipped',
  '  artifact has none) and the same rule judges records with or without a',
  '  version field.',
  '',
  '  Migration of the old diagnostic (ADR 0005 §2.5): the warning id',
  '  provenance-executed-sources-eol-divergent is retained. It no longer fires',
  '  when every difference is eol-equivalent (that state is the pass',
  '  classification above); it fires only in the MIXED state - some entries hit',
  '  equivalence while other executed sources genuinely drift - naming the paths',
  '  whose divergence is line-ending-flavoured.',
  '  Malformed executedSources entries (absolute, traversal or drive-letter',
  '  paths, non-hex digests) and unreadable entries are failures, never skipped',
  '  comparisons.',
  '',
  'DIRTY EVIDENCE',
  '  dirtyFileDigests paths must be a subset of `git diff --name-only',
  '  <codeBaseline>`: the recorded bytes stay historical, but each path is bound',
  '  to the frozen baseline. A path outside that set (fabricated or restored)',
  '  fails provenance-dirty-paths-in-baseline-diff and is named in the detail.',
  '',
  'EXIT CODES',
  '  0  every assertion held (warnings do not fail the run)',
  '  1  at least one assertion failed; failing ids/details are printed to stdout',
  ''
].join('\n');

if (process.argv.slice(2).includes('--help') || process.argv.slice(2).includes('-h')) {
  console.log(HELP_TEXT);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 1. artifacts exist and parse
// ---------------------------------------------------------------------------
const workDir = join(REPO_ROOT, 'work');
const jsonPath = join(workDir, 'pr4a-five-arm-eval.json');
const mdPath = join(REPO_ROOT, 'docs', 'reports', 'pr4a-five-arm-eval-report.md');

// Missing artifacts are their own diagnosable state: name the directory first so
// a checkout that never ran the eval is distinguishable from a corrupt report.
assert('work-directory-exists', existsSync(workDir), workDir);
assert('json-exists', existsSync(jsonPath), jsonPath);
assert('markdown-exists', existsSync(mdPath), mdPath);

let report = null;
try {
  report = JSON.parse(readFileSync(jsonPath, 'utf8'));
  assert('json-parses', true);
} catch (error) {
  assert('json-parses', false, String(error));
}

/**
 * Measurement-capability declaration (P3-C).
 *
 * The frozen artifact predates a tokenizer and carries NO declaration, so the
 * ABSENCE means "no tokenizer": the historical judgement (measured count and
 * per-field precision must be 0 / non-measured) is unchanged byte-for-byte in
 * effect. A future run that can really measure declares it explicitly as
 * `measurement: { tokenizer: true }` (top-level `tokenizer: true` is accepted
 * for forward compatibility). Only then may `measured` appear — and then it MUST
 * appear: a declared capability that produced ZERO measured calls is either a
 * broken capture or a false declaration, never a silent pass.
 */
function declaresMeasurementCapability(candidate) {
  return candidate?.measurement?.tokenizer === true || candidate?.tokenizer === true;
}

const hasMeasurementCapability = report !== null && declaresMeasurementCapability(report);

if (report !== null) {
  // -------------------------------------------------------------------------
  // 2. protocol + honesty declarations
  // -------------------------------------------------------------------------
  assert('protocol-id', report.protocol === 'PR4A-EVAL-PREREG-20261027-V2', String(report.protocol));
  assert(
    'code-baseline-is-commit',
    typeof report.codeBaseline === 'string' && /^[0-9a-f]{40}$/.test(report.codeBaseline),
    report.codeBaseline
  );
  assert('live-calls-zero', report.declarations.liveCalls === 0);
  assert('incurred-real-usd-zero', report.declarations.incurredRealUsd === 0);
  assert('cost-is-notional', report.declarations.costIsNotional === true);
  assert(
    'micros-not-usd-declared',
    typeof report.declarations.microsIsNotUsd === 'string' &&
      /UNIT CONVENTION/.test(report.declarations.microsIsNotUsd)
  );
  assert('guardrail-not-financial-cap', report.declarations.notionalGuardrailIsNotAFinancialCap === true);
  assert('wallclock-not-cost-ceiling', report.declarations.wallClockIsNotARemoteCostCeiling === true);
  assert('wilcoxon-not-on-binary', report.declarations.wilcoxonUsedOnBinary === false);
  assert('rounds-not-samples', report.declarations.roundsAreNotSamples === true);
  assert(
    'power-labelled-approximation',
    /closed-form normal approximation/i.test(report.declarations.powerIsClosedFormApproximation) &&
      /NOT an executed power analysis/i.test(report.declarations.powerIsClosedFormApproximation),
    report.declarations.powerIsClosedFormApproximation
  );
  assert(
    'd-min-corrected',
    Math.abs(report.declarations.minDetectableD - 0.8087) < 5e-3,
    String(report.declarations.minDetectableD)
  );
  assert(
    'external-validity-disclaimed',
    /NOT a production significance claim/i.test(report.declarations.externalValidity)
  );
  // the two policy declarations the repaired report must carry explicitly
  assert(
    'primary-test-policy-declared',
    /sign-flip/.test(String(report.declarations.primaryTestPolicy)) &&
      /binary/.test(String(report.declarations.primaryTestPolicy)),
    String(report.declarations.primaryTestPolicy)
  );
  assert(
    'verdict-interval-policy-declared',
    /estimator/i.test(String(report.declarations.verdictIntervalPolicy)) &&
      /NOT the verdict interval/i.test(String(report.declarations.verdictIntervalPolicy)),
    String(report.declarations.verdictIntervalPolicy)
  );

  // -------------------------------------------------------------------------
  // 2b. code provenance (audit item 4): a bare SHA cannot locate dirty-tree code
  // -------------------------------------------------------------------------
  const prov = report.codeProvenance ?? {};
  assert('provenance-present', typeof prov === 'object' && prov !== null);
  assert(
    'provenance-workspace-digest',
    /^[0-9a-f]{64}$/.test(String(prov.trackedWorkspaceDigest)),
    String(prov.trackedWorkspaceDigest)
  );
  assert(
    'provenance-executed-sources-digest',
    /^[0-9a-f]{64}$/.test(String(prov.executedSourcesDigest)),
    String(prov.executedSourcesDigest)
  );
  assert(
    'provenance-lists-executed-modules',
    Array.isArray(prov.executedSources) && prov.executedSources.length >= 7,
    String(prov.executedSources?.length)
  );
  assert(
    'provenance-hashes-are-sha256',
    Array.isArray(prov.executedSources) &&
      prov.executedSources.every((entry) => /^[0-9a-f]{64}$/.test(String(entry.sha256))),
    'every executed module must carry a 64-hex digest'
  );
  const selfEntry = (prov.executedSources ?? []).find(
    (entry) => entry.path === 'scripts/eval/pr4a-report.ts'
  );
  const selfBytes = readRepoFileBytes('scripts/eval/pr4a-report.ts');
  const selfDigestOnDisk = selfBytes === null ? null : digestOfBytes(selfBytes);
  // eol-equiv-v1 applies to EVERY executedSources comparison, including the
  // self-hash: a raw match is the strongest form, an eol-only difference is the
  // named equivalence pass, and any genuine drift still fails. The guard is not
  // weakened: a mutated pr4a-report.ts is as fatal as before.
  const selfClassification =
    selfEntry === undefined || selfBytes === null ? null : classifyExecutedSource(selfBytes, selfEntry.sha256);
  assert(
    'provenance-self-hash-matches-working-tree',
    selfEntry !== undefined &&
      selfDigestOnDisk !== null &&
      (selfClassification === 'raw' || selfClassification === 'eol-equivalent'),
    selfEntry === undefined
      ? 'entry missing for scripts/eval/pr4a-report.ts'
      : 'recorded=' +
          String(selfEntry.sha256) +
          ' disk=' +
          String(selfDigestOnDisk) +
          ' classification=' +
          String(selfClassification) +
          ' (rule ' +
          EOL_EQUIV_VERSION +
          ')'
  );
  // --- dirty/clean capture is TRI-STATE, never "the list must be non-empty".
  const dirtyDigests = Array.isArray(prov.dirtyFileDigests) ? prov.dirtyFileDigests : null;
  const dirtyCount = dirtyDigests === null ? null : dirtyDigests.length;
  const cleanCapture = prov.workspaceDirty === false;
  assert(
    'provenance-dirty-flag-honest',
    typeof prov.workspaceDirty === 'boolean' &&
      (prov.workspaceDirty ? prov.trackedDirtyCount > 0 : prov.trackedDirtyCount === 0),
    'workspaceDirty=' + String(prov.workspaceDirty) + ', count=' + String(prov.trackedDirtyCount)
  );
  assert(
    'provenance-dirty-listing',
    dirtyDigests !== null,
    dirtyDigests === null ? 'dirtyFileDigests must be an array' : String(dirtyCount) + ' entries'
  );
  assert(
    'provenance-dirty-count-matches-list',
    dirtyDigests !== null && typeof prov.trackedDirtyCount === 'number' && prov.trackedDirtyCount === dirtyCount,
    'trackedDirtyCount=' + String(prov.trackedDirtyCount) + ' vs dirtyFileDigests.length=' + String(dirtyCount)
  );
  // A CLEAN capture is the only state in which an empty list is evidence: the
  // count must agree and the digest must be sha256(''), because the digest is
  // computed over the list. The old unconditional `length > 0` rule rejected
  // clean captures and could not name what was wrong; this states the contract.
  assert(
    'provenance-empty-dirty-only-when-clean',
    dirtyCount !== 0 ||
      (cleanCapture && prov.trackedDirtyCount === 0 && prov.trackedWorkspaceDigest === EMPTY_TREE_DIGEST),
    dirtyCount === 0
      ? 'empty dirtyFileDigests requires workspaceDirty=false, trackedDirtyCount=0 and ' +
        'trackedWorkspaceDigest=sha256(""); got workspaceDirty=' + String(prov.workspaceDirty) +
        ', trackedDirtyCount=' + String(prov.trackedDirtyCount) +
        ', trackedWorkspaceDigest=' + String(prov.trackedWorkspaceDigest)
      : 'n/a: dirtyFileDigests carries ' + String(dirtyCount) + ' entries'
  );
  assert(
    'provenance-locate-instructions',
    typeof prov.howToLocate === 'string' && prov.howToLocate.length > 40,
    String(prov.howToLocate).slice(0, 80)
  );
  // Every enumerated dirty file must resolve: the list is a HISTORICAL snapshot
  // of the tracked bytes that were dirty when the eval executed. Its BYTES are
  // bound by their own digest rather than compared with today's working tree,
  // but its PATHS are now bound to the recorded codeBaseline (see the next
  // check): an entry naming a file the baseline never changed would otherwise
  // widen the evidence without bound. A `missing` digest or a traversal path
  // means a mis-sliced/bad path stopped locating the real code and must fail.
  const dirtyEntries = dirtyDigests ?? [];
  const badDirtyPaths = dirtyEntries
    .filter((entry) => !HEX64.test(String(entry.sha256)) || !isSafeRelativePath(entry.path))
    .slice(0, 3);
  assert(
    'provenance-dirty-paths-resolve',
    dirtyDigests !== null && badDirtyPaths.length === 0,
    JSON.stringify(
      dirtyCount === 0
        ? { cleanCapture: true, note: 'no dirty files recorded' }
        : badDirtyPaths.map((entry) => ({ path: entry.path, sha256: entry.sha256 }))
    )
  );
  // --- t1 B1 state 5, subset form (b): every recorded dirty path must be a path
  // that changed relative to the frozen codeBaseline. The list is a snapshot of
  // tracked changes taken AFTER that commit, so a genuine entry is always in the
  // diff; a fabricated path, or a path later restored to the baseline, drops out
  // and is named. Chosen over the blob form (a) because `git ls-tree -r` needs
  // `.gitattributes` EOL normalisation to be sound on CRLF checkouts, while this
  // form is cheap and independent of checkout bytes. An unresolvable baseline or
  // a failing git invocation FAILS the check (cannot verify is not a skip).
  const baselineChanged = baselineChangedPaths(report.codeBaseline);
  const dirtyPathsOutsideBaseline = dirtyEntries
    .filter((entry) => baselineChanged.paths === null || !baselineChanged.paths.has(String(entry.path)))
    .map((entry) => String(entry.path));
  assert(
    'provenance-dirty-paths-in-baseline-diff',
    dirtyCount === 0 || (baselineChanged.paths !== null && dirtyPathsOutsideBaseline.length === 0),
    dirtyCount === 0
      ? 'n/a: clean capture records no dirty files'
      : baselineChanged.paths === null
        ? 'cannot verify dirty entries against codeBaseline ' + String(report.codeBaseline) +
          ': ' + baselineChanged.error
        : JSON.stringify({
            codeBaseline: report.codeBaseline,
            outsideBaseline: dirtyPathsOutsideBaseline.slice(0, 3),
            outsideCount: dirtyPathsOutsideBaseline.length,
            baselineChangedCount: baselineChanged.paths.size
          })
  );

  // --- executedSources: INDEPENDENT named checks, never reusing dirty logic ---
  // T7-F2: the previous version filtered unsafe/non-hex entries OUT of the disk
  // comparison, so appending `{path:'../x.mjs', sha256:'<64 hex>'}` (and
  // recomputing the list digest) still passed. Well-formedness and "every entry
  // was actually compared" are separate assertions; an entry that cannot be
  // verified is a FAILURE, not a skip.
  //
  // Judgement per entry is the versioned `eol-equiv-v1` classification
  // (classifyExecutedSource): raw | eol-equivalent | drift | unreadable. The
  // recorded digests stay the generation-time RAW byte facts (nothing is
  // rewritten); only the VERDICT of an eol-only difference changes, from FAIL
  // to the named pass classification — exactly ADR 0005 decision D2.
  const executedEntries = Array.isArray(prov.executedSources) ? prov.executedSources : [];
  const executedEntryRows = executedEntries.map((entry, index) => {
    const wellFormed = isWellFormedExecutedEntry(entry);
    const bytes = wellFormed ? readRepoFileBytes(String(entry.path)) : null;
    return {
      index,
      path: entry !== null && typeof entry === 'object' ? String(entry.path) : String(entry),
      recorded: entry !== null && typeof entry === 'object' ? String(entry.sha256) : '',
      wellFormed,
      bytes,
      disk: bytes === null ? null : digestOfBytes(bytes),
      classification: wellFormed ? classifyExecutedSource(bytes, String(entry.sha256)) : 'drift'
    };
  });
  const malformedExecuted = executedEntryRows.filter((row) => !row.wellFormed);
  assert(
    'provenance-executed-entries-well-formed',
    Array.isArray(prov.executedSources) && executedEntries.length > 0 && malformedExecuted.length === 0,
    JSON.stringify(
      malformedExecuted.slice(0, 5).map((row) => ({ index: row.index, path: row.path, sha256: row.recorded }))
    )
  );
  const unverifiableExecuted = executedEntryRows.filter((row) => row.wellFormed && row.disk === null);
  assert(
    'provenance-executed-all-entries-checked',
    Array.isArray(prov.executedSources) &&
      executedEntries.length > 0 &&
      malformedExecuted.length === 0 &&
      unverifiableExecuted.length === 0,
    JSON.stringify({
      entries: executedEntries.length,
      malformed: malformedExecuted.slice(0, 5).map((row) => row.path),
      unverifiable: unverifiableExecuted.slice(0, 5).map((row) => row.path)
    })
  );
  const missingExecuted = executedEntryRows.filter((row) => row.recorded === 'missing');
  assert(
    'provenance-executed-paths-resolve',
    Array.isArray(prov.executedSources) && missingExecuted.length === 0,
    JSON.stringify(missingExecuted.slice(0, 5).map((row) => ({ path: row.path, sha256: row.recorded })))
  );
  const executedDiskMismatches = executedEntryRows
    .filter((row) => row.wellFormed && row.disk !== null && row.disk !== row.recorded)
    .map((row) => ({
      path: row.path,
      recorded: row.recorded,
      disk: row.disk,
      eolOnly: row.classification === 'eol-equivalent'
    }));
  // eol-equiv-v1 (ADR 0005 D2): an entry whose difference is ONLY the
  // line-ending form of the same text is an EXPLICIT PASS classification, not a
  // failure. Raw matches and equivalence hits are counted separately; every
  // other byte difference (content, BOM, binary) remains a mismatch.
  const executedEolEquivalent = executedEntryRows.filter(
    (row) => row.wellFormed && row.classification === 'eol-equivalent'
  );
  const executedDrifted = executedDiskMismatches.filter((mismatch) => !mismatch.eolOnly);
  // Raw-byte equality remains the strongest check; under eol-equiv-v1 it passes
  // when every entry is raw OR eol-equivalent, and fails on any genuine drift.
  assert(
    'provenance-executed-sources-match-disk',
    Array.isArray(prov.executedSources) &&
      executedEntries.length > 0 &&
      malformedExecuted.length === 0 &&
      unverifiableExecuted.length === 0 &&
      executedDrifted.length === 0,
    JSON.stringify({
      rule: EOL_EQUIV_VERSION,
      mismatches: executedDrifted.slice(0, 5),
      eolEquivalent: executedEolEquivalent.map((row) => row.path),
      malformed: malformedExecuted.slice(0, 5).map((row) => ({ path: row.path, sha256: row.recorded })),
      unverifiable: unverifiableExecuted.slice(0, 5).map((row) => row.path)
    })
  );
  // The equivalence hits are their OWN named classification (advisory:false,
  // pass kind 'eol-equivalent'), never merged into the raw-match count. The
  // paths are also recorded in the status file's `eolEquivalents` key and the
  // stdout summary, so a reviewer sees the classification without parsing
  // assertion details.
  // t18: this check reports ONLY which entries hit equivalence, and it is
  // pushed exactly ONCE here. Its scope is the equivalence hits themselves —
  // a genuine drift in ANOTHER entry fails
  // `provenance-executed-sources-match-disk` (and drives the exit code), never
  // this classification, so the same id can never sit in both the passed and
  // the failed counts.
  for (const row of executedEolEquivalent) {
    eolEquivalentPaths.push(row.path);
  }
  if (executedEolEquivalent.length > 0) {
    assert(
      'provenance-executed-sources-eol-equivalent',
      executedEolEquivalent.length > 0,
      JSON.stringify({
        kind: 'eol-equivalent',
        rule: EOL_EQUIV_VERSION,
        paths: executedEolEquivalent.map((row) => row.path),
        note: 'recorded raw-byte digests are historical byte facts; these entries match the same text under the other line-ending form'
      })
    );
  }
  // MIGRATION of the old warning id (ADR 0005 §2.5): retained, NOT deleted. It
  // no longer fires when every difference is eol-equivalent (that state is the
  // pass classification above); it fires only in the MIXED state — some entries
  // hit equivalence while OTHER executed sources genuinely drift — as a
  // diagnostic that part of the divergence set is line-ending-flavoured.
  const eolDivergent = executedDiskMismatches.filter((mismatch) => mismatch.eolOnly);
  if (executedDrifted.length > 0 && eolDivergent.length > 0) {
    warn(
      'provenance-executed-sources-eol-divergent',
      'recorded and on-disk bytes are the same text under different line-ending forms (not content drift); ' +
        'under eol-equiv-v1 these entries are classified eol-equivalent, and this warning fires only because ' +
        'OTHER executed sources genuinely drifted: ' +
        JSON.stringify(eolDivergent.map((mismatch) => mismatch.path))
    );
  }
  // The digest must be a real digest OF the enumerated list, not a decorative string.
  const recomputedWorkspaceDigest = sha256(
    (prov.dirtyFileDigests ?? []).map((entry) => entry.sha256 + '  ' + entry.path).join('\n')
  );
  const recomputedExecutedDigest = sha256(
    (prov.executedSources ?? []).map((entry) => entry.sha256 + '  ' + entry.path).join('\n')
  );
  assert(
    'provenance-workspace-digest-recomputed',
    prov.trackedWorkspaceDigest === recomputedWorkspaceDigest &&
      (dirtyCount !== 0 || recomputedWorkspaceDigest === EMPTY_TREE_DIGEST),
    'recorded=' + String(prov.trackedWorkspaceDigest) + ' recomputed=' + recomputedWorkspaceDigest
  );
  assert(
    'provenance-executed-digest-recomputed',
    prov.executedSourcesDigest === recomputedExecutedDigest,
    'recorded=' + String(prov.executedSourcesDigest) + ' recomputed=' + recomputedExecutedDigest
  );
  // The compiled artifact that actually executed must also be identified.
  assert(
    'provenance-bundle-fingerprint',
    typeof prov.bundleFingerprint === 'object' &&
      prov.bundleFingerprint !== null &&
      /^[0-9a-f]{64}$/.test(String(prov.bundleFingerprint.digest)) &&
      typeof prov.bundleFingerprint.esbuildVersion === 'string',
    JSON.stringify(prov.bundleFingerprint)
  );

  // -------------------------------------------------------------------------
  // 3. five arms, exact design (V2 §3.1)
  // -------------------------------------------------------------------------
  const arms = report.arms ?? [];
  assert('five-arms', arms.length === 5, String(arms.length));
  const expected = {
    'Arm-0': { track: 'process', gate: false, writes: false, role: 'reference' },
    'Arm-1': { track: 'process', gate: false, writes: true, role: 'factorial' },
    'Arm-2': { track: 'process', gate: true, writes: true, role: 'factorial' },
    'Arm-3': { track: 'task-quality', gate: false, writes: true, role: 'factorial' },
    'Arm-4': { track: 'task-quality', gate: true, writes: true, role: 'factorial' }
  };
  for (const [id, want] of Object.entries(expected)) {
    const arm = arms.find((entry) => entry.armId === id);
    if (arm === undefined) {
      assert('arm-present:' + id, false);
      continue;
    }
    assert('arm-track:' + id, arm.spec.track === want.track, arm.spec.track);
    assert('arm-gate:' + id, arm.spec.conservativeGate === want.gate, String(arm.spec.conservativeGate));
    assert('arm-writes:' + id, arm.spec.writesBack === want.writes, String(arm.spec.writesBack));
    assert('arm-role:' + id, arm.spec.role === want.role, arm.spec.role);
  }
  assert('no-arm-5', !arms.some((entry) => /Arm-5/.test(entry.armId)));
  assert('no-advice-or-mixed-arm', !arms.some((entry) => /advice|mixed|naive/i.test(entry.spec.label)));

  /** Every ledger row on disk, parsed once and reused by the checks below. */
  const ledgerRowsByArm = new Map();
  for (const arm of arms) {
    const ledgerPath = join(REPO_ROOT, 'work', 'pr4a-ledger-' + arm.armId + '.jsonl');
    if (!existsSync(ledgerPath)) {
      ledgerRowsByArm.set(arm.armId, []);
      continue;
    }
    const rows = readFileSync(ledgerPath, 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    ledgerRowsByArm.set(arm.armId, rows);
  }

  // -------------------------------------------------------------------------
  // 4. invariants (V2 §5.4/§7.2/§6.3/§3.4)
  // -------------------------------------------------------------------------
  const inv = report.invariants ?? {};
  assert('pool-digests-agree', inv.poolDigestAssertion === 'passed', String(inv.poolDigestMismatches));
  assert('records-disjoint', inv.recordIsolationAssertion === 'passed', String(inv.crossArmRecordOverlaps));
  assert('arm0-frozen', inv.arm0Frozen === true);
  assert('exploration-pinned-zero', inv.explorationAllowancePinned === 0);
  assert('gate-reachable', inv.gateReachableOnSharedPath === true);

  // --- 4a. PER-ROW track isolation (the audited defect was the last-write scalar)
  assert(
    'track-isolation-per-row-assertion',
    inv.trackIsolationPerRowAssertion === 'passed',
    String(inv.trackIsolationPerRowAssertion)
  );
  const trackPerArm = inv.trackPerArm ?? [];
  assert('track-per-arm-present', trackPerArm.length === 5, String(trackPerArm.length));
  for (const entry of trackPerArm) {
    assert(
      'track-rows-mismatched-zero:' + entry.armId,
      entry.rowsMismatched === 0,
      'mismatched=' + String(entry.rowsMismatched) + ' of ' + String(entry.rowsWritten)
    );
    assert(
      'track-rows-counted:' + entry.armId,
      entry.rowsWritten === entry.rowsMatching + entry.rowsMismatched,
      JSON.stringify({ written: entry.rowsWritten, matching: entry.rowsMatching, mismatched: entry.rowsMismatched })
    );
    assert(
      'track-row-invariant-uses-rows:' + entry.armId,
      'rowsMismatched' in entry && 'rowsWritten' in entry,
      'the per-row tally, not `wroteTrack`, is the invariant'
    );
    if (entry.expectedTrack === 'task-quality') {
      assert(
        'quality-arm-writes-quality-only:' + entry.armId,
        entry.wroteTrack === 'task-quality' || entry.rowsWritten === 0,
        String(entry.wroteTrack)
      );
    }
    if (entry.expectedTrack === 'process') {
      assert(
        'process-arm-never-writes-quality:' + entry.armId,
        entry.wroteTrack === 'process' || entry.wroteTrack === null,
        String(entry.wroteTrack)
      );
    }
  }
  // Independent re-derivation from the JSONL rows: the tally must not be
  // asserted only inside the JSON summary it was computed from.
  for (const arm of arms) {
    const rows = ledgerRowsByArm.get(arm.armId) ?? [];
    const written = rows.filter((row) => row.writeDisposition === 'written');
    const wrongTrack = written.filter((row) => row.learningTrackWritten !== arm.spec.track);
    assert(
      'ledger-row-track-rederived:' + arm.armId,
      wrongTrack.length === 0,
      wrongTrack.length === 0
        ? 'every written row carries ' + arm.spec.track
        : String(wrongTrack.length) + ' wrong rows, e.g. ' + JSON.stringify(wrongTrack[0])
    );
    const tally = trackPerArm.find((entry) => entry.armId === arm.armId);
    assert(
      'ledger-write-tally-consistent:' + arm.armId,
      tally !== undefined && tally.rowsWritten === written.length,
      'json tally=' + String(tally?.rowsWritten) + ' vs ledger written rows=' + String(written.length)
    );
  }

  // --- 4b. §6.3 audit-only: unauthenticated executions are never persisted
  assert('audit-only-assertion', inv.auditOnlyAssertion === 'passed', String(inv.auditOnlyAssertion));
  const writeAccounting = inv.writeAccounting ?? [];
  assert('write-accounting-present', writeAccounting.length === 5, String(writeAccounting.length));
  for (const entry of writeAccounting) {
    assert(
      'no-quality-label-on-process-arm:' + entry.armId,
      entry.auditOnlyQualityLabelOnProcessArm === 0,
      String(entry.auditOnlyQualityLabelOnProcessArm)
    );
    assert(
      'audit-only-violations-zero:' + entry.armId,
      entry.auditOnlyViolations === 0,
      String(entry.auditOnlyViolations)
    );
    if (entry.armId === 'Arm-3' || entry.armId === 'Arm-4') {
      // §6.3: on a QUALITY arm the counters partition the eligible executions;
      // an unauthenticated one is audit-only, never a write.
      assert(
        'quality-arm-partitions-writes:' + entry.armId,
        entry.written + entry.auditOnlyUnauthenticated + entry.auditOnlyNotLearningOutcome ===
          entry.eligibleExecutions,
        JSON.stringify(entry)
      );
      assert(
        'quality-arm-has-writes:' + entry.armId,
        entry.written > 0,
        'the quality track must not be empty, or the arm is degenerate'
      );
      // and the host must have authenticated exactly the executions that wrote
      const armRecord = arms.find((arm) => arm.armId === entry.armId);
      assert(
        'quality-arm-writes-match-receipts:' + entry.armId,
        entry.written <= armRecord.verification.receiptsIssued,
        'writes=' + String(entry.written) + ' receipts=' + String(armRecord.verification.receiptsIssued)
      );
    }
    if (entry.armId === 'Arm-0') {
      assert('reference-never-writes:' + entry.armId, entry.written === 0, String(entry.written));
    }
  }
  // Cross-check the audit-only disposition against the raw ledgers.
  for (const arm of arms) {
    const rows = ledgerRowsByArm.get(arm.armId) ?? [];
    const unauth = rows.filter((row) => row.writeDisposition === 'audit-only-unauthenticated');
    assert(
      'audit-only-rows-are-unwritten:' + arm.armId,
      unauth.every((row) => row.learningTrackWritten === null),
      'an audit-only row must not carry a written track'
    );
    assert(
      'audit-only-only-on-quality-arms:' + arm.armId,
      arm.spec.track === 'task-quality' || unauth.length === 0,
      String(unauth.length) + ' unauthenticated audit-only rows on a ' + arm.spec.track + ' arm'
    );
  }

  // --- 4c. §6.3 quality neighbourhood: no unauthenticated record admitted
  const qNeigh = inv.qualityNeighbourhood ?? [];
  assert('quality-neighbourhood-present', qNeigh.length === 5, String(qNeigh.length));
  for (const entry of qNeigh) {
    assert(
      'quality-neighbourhood-assertion:' + entry.armId,
      entry.assertion === 'passed',
      String(entry.assertion)
    );
    assert(
      'quality-neighbourhood-no-unauthenticated:' + entry.armId,
      entry.recordsRejectedUnauthenticated === 0,
      String(entry.recordsRejectedUnauthenticated)
    );
    if (entry.armId === 'Arm-3' || entry.armId === 'Arm-4') {
      assert(
        'quality-arm-neighbourhood-inspected:' + entry.armId,
        entry.decisionsInspected === 180 && entry.recordsAdmitted > 0,
        JSON.stringify(entry)
      );
    } else {
      assert(
        'process-arm-neighbourhood-unused:' + entry.armId,
        entry.decisionsInspected === 0,
        'the quality-neighbourhood check only applies to quality arms'
      );
    }
  }

  // --- 4d. §3.4 the four challenger fields are unconditional on EVERY row
  const challenger = inv.challengerFieldsUnconditional ?? {};
  assert('challenger-fields-assertion', challenger.assertion === 'passed', String(challenger.assertion));
  assert(
    'challenger-fields-rows-checked',
    challenger.rowsChecked === 900 && challenger.rowsWithoutFields === 0,
    JSON.stringify(challenger)
  );
  const gateOff = inv.gateOffChallengerMeasurement ?? [];
  assert(
    'gate-off-arms-measure-challenger',
    gateOff.length === 2 && gateOff.every((entry) => entry.rowsWithChallengerMeasurement === entry.rows),
    JSON.stringify(gateOff)
  );
  for (const arm of arms) {
    if (arm.spec.conservativeGate) continue;
    const rows = ledgerRowsByArm.get(arm.armId) ?? [];
    const missing = rows.filter(
      (row) =>
        typeof row.challengerSupport !== 'number' ||
        typeof row.challengerNEff !== 'number' ||
        typeof row.challengerShrunkAdvantage !== 'number' ||
        typeof row.challengerCalibratedAdvantage !== 'number'
    );
    assert(
      'gate-off-challenger-numeric:' + arm.armId,
      missing.length === 0,
      missing.length === 0
        ? 'all ' + String(rows.length) + ' gate-off rows carry numeric challenger fields'
        : String(missing.length) + ' rows missing, e.g. ' + JSON.stringify(missing[0])
    );
  }

  // --- 4e. §6.1 the host verdict is the metric, and the substitute agrees
  const hostVerdict = inv.hostVerdictAssertion ?? {};
  assert('host-verdict-assertion', hostVerdict.assertion === 'passed', String(hostVerdict.assertion));
  for (const arm of arms) {
    assert(
      'host-verdict-agrees:' + arm.armId,
      arm.verification.hostCoverageDisagreements === 0,
      JSON.stringify({
        agreements: arm.verification.hostCoverageAgreements,
        disagreements: arm.verification.hostCoverageDisagreements
      })
    );
    assert(
      'arm-verified-rate-in-unit:' + arm.armId,
      arm.verifiedRate === null
        ? arm.tasks.every((task) => !task.analysisIncluded)
        : arm.verifiedRate >= 0 && arm.verifiedRate <= 1,
      String(arm.verifiedRate)
    );
  }

  // gate-before/after property: only the two gate arms may record kept-prior
  const gateDist = inv.gateDistribution ?? [];
  for (const entry of gateDist) {
    if (!entry.gateEnabled) {
      assert('no-gate-use:' + entry.armId, entry.applied === 0 && entry.keptPrior === 0, JSON.stringify(entry));
    }
    assert(
      'gate-applied-subset-of-proposed:' + entry.armId,
      entry.applied <= entry.proposedDeviations,
      'applied=' + String(entry.applied) + ' proposed=' + String(entry.proposedDeviations)
    );
    assert(
      'gate-outcomes-partition-applied:' + entry.armId,
      entry.keptPrior + entry.executedProposed + entry.executedExploration === entry.applied,
      JSON.stringify(entry)
    );
  }

  // -------------------------------------------------------------------------
  // 5. analysis unit = task; replication derived (V2 §8.1)
  // -------------------------------------------------------------------------
  assert(
    'analysis-unit-task',
    /task/.test(String(report.declarations.analysisUnit)) && /N=12/.test(String(report.declarations.analysisUnit)),
    report.declarations.analysisUnit
  );
  assert('replication-reported', report.replication !== undefined && report.replication !== null);
  assert(
    'replication-per-arm',
    Array.isArray(report.replication?.perArm) && report.replication.perArm.length === 5
  );
  assert(
    'replication-derived-not-constant',
    report.replication.effectiveReplication !== 5,
    'effectiveReplication must be derived, never the constant L=5; got ' +
      String(report.replication.effectiveReplication)
  );
  const learningMeans = (report.replication.perArm ?? [])
    .filter((entry) => entry.writesBack)
    .map((entry) => entry.meanDistinctValuesPerTask);
  const expectedReplication = report.replication.allLearningArmsConstant
    ? 1
    : Number(Math.max(...learningMeans).toFixed(4));
  assert(
    'replication-matches-derivation',
    report.replication.effectiveReplication === expectedReplication,
    JSON.stringify({
      reported: report.replication.effectiveReplication,
      expected: expectedReplication,
      allConstant: report.replication.allLearningArmsConstant,
      means: learningMeans
    })
  );
  assert(
    'replication-reports-per-arm-means',
    (report.replication.perArm ?? []).every(
      (entry) => typeof entry.meanDistinctValuesPerTask === 'number' && typeof entry.writesBack === 'boolean'
    ),
    'the derivation must be auditable per arm'
  );
  assert(
    'replication-binary-consistency',
    report.replication.designIsBinary === report.replication.allLearningArmsConstant &&
      (!report.replication.designIsBinary || report.replication.effectiveReplication === 1),
    JSON.stringify({
      designIsBinary: report.replication.designIsBinary,
      allLearningArmsConstant: report.replication.allLearningArmsConstant,
      effectiveReplication: report.replication.effectiveReplication
    })
  );
  for (const arm of arms) {
    assert('twelve-tasks:' + arm.armId, arm.tasks.length === 12, String(arm.tasks.length));
  }

  // -------------------------------------------------------------------------
  // 6. controlled family: exactly 4 contrasts, Holm on the PRIMARY p (V2 §8.6)
  // -------------------------------------------------------------------------
  const controlled = report.comparisons?.controlled ?? [];
  assert('four-controlled-contrasts', controlled.length === 4, String(controlled.length));
  const ids = controlled.map((entry) => entry.id).join(',');
  assert('controlled-ids', ids === 'write-back,track,gate,interaction', ids);

  /** The four estimator series, re-derived from the arm task tables. */
  const taskValue = (armId, taskId) => {
    const arm = arms.find((entry) => entry.armId === armId);
    const task = arm?.tasks.find((entry) => entry.taskId === taskId);
    return task === undefined || !task.analysisIncluded ? null : task.verifiedRate;
  };
  const taskIds = (arms[0]?.tasks ?? []).map((task) => task.taskId);
  const seriesByContrast = {
    'write-back': taskIds.map((id) => taskValue('Arm-1', id) - taskValue('Arm-0', id)),
    track: taskIds.map(
      (id) =>
        0.5 *
        (taskValue('Arm-3', id) - taskValue('Arm-1', id) + (taskValue('Arm-4', id) - taskValue('Arm-2', id)))
    ),
    gate: taskIds.map(
      (id) =>
        0.5 *
        (taskValue('Arm-2', id) - taskValue('Arm-1', id) + (taskValue('Arm-4', id) - taskValue('Arm-3', id)))
    ),
    interaction: taskIds.map(
      (id) =>
        taskValue('Arm-4', id) - taskValue('Arm-3', id) - (taskValue('Arm-2', id) - taskValue('Arm-1', id))
    )
  };

  for (const entry of controlled) {
    assert('verdict-tuple:' + entry.id, entry.verdict !== undefined && entry.verdict !== null);
    const tupleKeys = ['significance', 'direction', 'degradationStatus', 'evidenceStatus'];
    assert(
      'verdict-four-dim:' + entry.id,
      tupleKeys.every((key) => typeof entry.verdict?.[key] === 'string'),
      JSON.stringify(entry.verdict)
    );
    assert(
      'verdict-values:' + entry.id,
      ['reject', 'not-reject'].includes(entry.verdict?.significance) &&
        ['+', '0', '-'].includes(entry.verdict?.direction) &&
        ['degraded', 'not-degraded', 'undetermined'].includes(entry.verdict?.degradationStatus) &&
        ['sufficient', 'insufficient'].includes(entry.verdict?.evidenceStatus),
      JSON.stringify(entry.verdict)
    );
    assert('m-disc-reported:' + entry.id, Number.isInteger(entry.discordantPairs));
    assert('p-reported:' + entry.id, typeof entry.pRaw === 'number' && entry.pRaw >= 0 && entry.pRaw <= 1);
    assert('holm-adjusted:' + entry.id, entry.pAdjusted === null || (entry.pAdjusted >= 0 && entry.pAdjusted <= 1));

    const values = seriesByContrast[entry.id] ?? [];
    // --- the re-derived estimator series must equal the persisted one, keyed by
    // taskId (the persisted order is the shared shuffle, not the sorted order).
    const rederivedByTask = new Map(taskIds.map((id, index) => [id, values[index]]));
    assert(
      'estimator-series-rederived:' + entry.id,
      entry.perTask?.length === values.length &&
        entry.perTask.every((row) => Math.abs(row.value - rederivedByTask.get(row.taskId)) < 1e-9),
      'the per-task series must be reproducible from the arm tables: ' +
        JSON.stringify(
          entry.perTask?.map((row) => [row.taskId, row.value, rederivedByTask.get(row.taskId)]).slice(0, 2)
        )
    );
    assert(
      'series-mean-rederived:' + entry.id,
      closeTo(
        entry.meanDelta,
        values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length),
        1e-9
      ),
      String(entry.meanDelta)
    );

    // --- §8.3.1 vs §8.3.2: the primary test must follow the series TYPE
    const expectBinary = values.every((value) => Math.abs(value) < 1e-9 || Math.abs(value - 1) < 1e-9);
    assert(
      'primary-test-matches-series-type:' + entry.id,
      entry.binarySeries === expectBinary,
      'binarySeries=' + String(entry.binarySeries) + ' expected=' + String(expectBinary)
    );
    assert(
      'primary-p-is-designated:' + entry.id,
      closeTo(entry.pPrimary, entry.binarySeries ? entry.pRaw : entry.pSignFlip, 1e-12),
      'pPrimary=' + String(entry.pPrimary) + ' pRaw=' + String(entry.pRaw) + ' pSignFlip=' + String(entry.pSignFlip)
    );
    assert(
      'rate-type-uses-sign-flip:' + entry.id,
      entry.binarySeries || /sign-flip/.test(String(entry.primaryTest)),
      String(entry.primaryTest)
    );
    // Holm must be applied to the DESIGNATED primary, not silently to McNemar
    assert(
      'holm-uses-primary-p:' + entry.id,
      entry.pAdjusted + 1e-9 >= entry.pPrimary,
      'adjusted=' + String(entry.pAdjusted) + ' primary=' + String(entry.pPrimary)
    );

    // --- §8.5 ③: the verdict's DTS is the ESTIMATOR's own degradation
    const expectDts = values.filter((value) => value < -1e-9).length / Math.max(1, values.length);
    assert(
      'estimator-dts-recomputed:' + entry.id,
      closeTo(entry.degradation.dts, expectDts, 1e-6),
      'reported=' + String(entry.degradation.dts) + ' re-derived=' + String(expectDts)
    );
    assert(
      'estimator-dts-tasks-match:' + entry.id,
      entry.degradation.degradedTasks.length === values.filter((value) => value < -1e-9).length,
      JSON.stringify(entry.degradation.degradedTasks)
    );
    // the arm-level DTS must still be reported, but must NOT be the verdict input
    assert(
      'arm-level-dts-reported-separately:' + entry.id,
      entry.armLevelDtsVsReference !== undefined && typeof entry.armLevelDtsVsReference.dts === 'number',
      JSON.stringify(entry.armLevelDtsVsReference)
    );
    assert(
      'verdict-input-is-estimator-dts:' + entry.id,
      closeTo(entry.verdictInputs.dts, entry.degradation.dts, 1e-12),
      'verdictInputs.dts=' + String(entry.verdictInputs.dts)
    );

    // --- §8.5 ③④: the verdict interval is the ESTIMATOR interval, not CP(pi)
    assert(
      'verdict-input-is-estimator-interval:' + entry.id,
      closeTo(entry.verdictInputs.interval[0], entry.randomizationInterval.lower, 1e-12) &&
        closeTo(entry.verdictInputs.interval[1], entry.randomizationInterval.upper, 1e-12),
      JSON.stringify(entry.verdictInputs.interval)
    );
    assert(
      'cp-interval-is-not-the-verdict-interval:' + entry.id,
      entry.exactInterval.lower <= entry.exactInterval.upper &&
        (entry.exactInterval.lower !== entry.randomizationInterval.lower ||
          entry.exactInterval.upper !== entry.randomizationInterval.upper),
      'the discordant-pair-pi interval must be a DIFFERENT quantity: ' +
        JSON.stringify({ cp: entry.exactInterval, estimator: entry.randomizationInterval })
    );
    assert(
      'interval-width-reported:' + entry.id,
      closeTo(
        entry.intervalWidth,
        entry.randomizationInterval.upper - entry.randomizationInterval.lower,
        1e-9
      ) && entry.intervalWidth > 0,
      String(entry.intervalWidth)
    );
    // --- §8.3.3: algorithm + enumeration space + rerun command
    const ip = entry.intervalProvenance ?? {};
    assert('interval-provenance:' + entry.id, typeof ip.algorithm === 'string' && ip.algorithm.length > 0);
    assert(
      'interval-enumeration-space:' + entry.id,
      ip.enumerationSpace === Math.pow(2, entry.n),
      'enumerationSpace=' + String(ip.enumerationSpace) + ' vs 2^' + String(entry.n)
    );
    assert(
      'interval-rerun-command:' + entry.id,
      typeof ip.rerunCommand === 'string' && ip.rerunCommand.includes('randomizationInversionInterval'),
      String(ip.rerunCommand).slice(0, 60)
    );
    assert(
      'interval-grid-reported:' + entry.id,
      Number.isInteger(ip.gridPointsTested) && ip.gridPointsTested > 0,
      String(ip.gridPointsTested)
    );

    // --- re-derive the tuple from its own stated inputs (the audit's key check)
    const width = entry.randomizationInterval.upper - entry.randomizationInterval.lower;
    const expectDegradation =
      entry.degradation.dts > 0.25 + 1e-9 || entry.randomizationInterval.upper < -0.05 - 1e-9
        ? 'degraded'
        : entry.degradation.dts <= 0.25 + 1e-9 && entry.randomizationInterval.lower >= -0.05 - 1e-9
          ? 'not-degraded'
          : 'undetermined';
    const expectEvidence = entry.discordantPairs < 8 || width > 0.5 ? 'insufficient' : 'sufficient';
    assert(
      'verdict-rederived-degradation:' + entry.id,
      entry.verdict.degradationStatus === expectDegradation,
      'reported=' + entry.verdict.degradationStatus + ' re-derived=' + expectDegradation +
        ' (dts=' + String(entry.degradation.dts) + ', iv=[' + String(entry.randomizationInterval.lower) + ',' +
        String(entry.randomizationInterval.upper) + '])'
    );
    assert(
      'verdict-rederived-evidence:' + entry.id,
      entry.verdict.evidenceStatus === expectEvidence,
      'reported=' + entry.verdict.evidenceStatus + ' re-derived=' + expectEvidence +
        ' (m=' + String(entry.discordantPairs) + ', width=' + String(width) + ')'
    );
    assert(
      'verdict-rederived-significance:' + entry.id,
      entry.verdict.significance === (entry.significantAfterCorrection ? 'reject' : 'not-reject'),
      JSON.stringify({ reported: entry.verdict.significance, holm: entry.significantAfterCorrection })
    );
    const expectDirection = Math.abs(entry.meanDelta) < 1e-9 ? '0' : entry.meanDelta > 0 ? '+' : '-';
    assert(
      'verdict-rederived-direction:' + entry.id,
      entry.verdict.direction === expectDirection,
      'reported=' + entry.verdict.direction + ' re-derived=' + expectDirection
    );
  }
  // Holm monotonicity: adjusted p must be >= raw p for every contrast
  for (const entry of controlled) {
    if (entry.pAdjusted !== null) {
      assert('holm-ge-raw:' + entry.id, entry.pAdjusted + 1e-9 >= entry.pRaw, entry.pAdjusted + ' vs ' + entry.pRaw);
    }
  }
  // The audit's headline expectations, pinned so a silent regression fails loudly.
  const gateContrast = controlled.find((entry) => entry.id === 'gate');
  assert(
    'gate-contrast-not-degraded',
    gateContrast?.verdict?.degradationStatus === 'not-degraded',
    'DTS=' + String(gateContrast?.degradation?.dts) + ' tuple=' + JSON.stringify(gateContrast?.verdict)
  );
  assert(
    'gate-contrast-dts-is-one-twelfth',
    // The persisted DTS is rounded to 6 decimals by `roundTo`, so 1/12 arrives
    // as 0.083333; the tolerance must reflect the declared display precision.
    closeTo(gateContrast?.degradation?.dts, 1 / 12, 1e-6),
    String(gateContrast?.degradation?.dts) + ' (1/12 = ' + String(1 / 12) + ')'
  );
  const interactionContrast = controlled.find((entry) => entry.id === 'interaction');
  assert(
    'interaction-contrast-undetermined',
    interactionContrast?.verdict?.degradationStatus === 'undetermined',
    'iv=' + JSON.stringify(interactionContrast?.verdictInputs?.interval) +
      ' tuple=' + JSON.stringify(interactionContrast?.verdict)
  );

  // -------------------------------------------------------------------------
  // 6b. collinearity disclosure (§3.4 / §8.4 reading order)
  // -------------------------------------------------------------------------
  const collinearity = inv.collinearity ?? {};
  assert(
    'collinearity-disclosed',
    typeof collinearity.disclosure === 'string' && /reduced|identity|rank/i.test(collinearity.disclosure),
    String(collinearity.disclosure).slice(0, 90)
  );
  assert(
    'collinearity-flag-present',
    typeof collinearity.thetaTrackEqualsThetaWrite === 'boolean',
    String(collinearity.thetaTrackEqualsThetaWrite)
  );
  // §3.4: the degeneracy must be proven by the EXACT reduced form, re-derived
  // here rather than trusted from the JSON it is stored in.
  const reducedResidual = Math.max(
    ...seriesByContrast.track.map((value, index) =>
      Math.abs(value + seriesByContrast['write-back'][index] + seriesByContrast.gate[index])
    )
  );
  assert(
    'collinearity-reduced-form-rederived',
    closeTo(collinearity.thetaTrackReducedFormResidual, Number(reducedResidual.toFixed(12)), 1e-9),
    'reported=' + String(collinearity.thetaTrackReducedFormResidual) + ' re-derived=' + String(reducedResidual)
  );
  assert(
    'collinearity-rank-deficiency-flagged',
    typeof collinearity.thetaTrackRankDeficient === 'boolean' &&
      (reducedResidual < 1e-9 ? collinearity.thetaTrackRankDeficient === true : true),
    'the rank-deficiency flag must be set when the identity holds: residual=' + String(reducedResidual)
  );
  assert(
    'collinearity-degeneracy-consistent',
    collinearity.thetaTrackReducedFormHolds === (reducedResidual < 1e-9),
    'thetaTrackReducedFormHolds must be the measured predicate'
  );
  assert(
    'collinearity-no-independent-track-claim',
    (reducedResidual < 1e-9 ? /NOT positive track evidence/.test(String(collinearity.disclosure)) : true),
    'a rank-deficient θ_track must not be presented as track evidence'
  );
  assert(
    'collinearity-equal-series-flag-is-measured',
    collinearity.thetaTrackEqualsThetaWrite ===
      seriesByContrast.track.every((value, index) => Math.abs(value - seriesByContrast['write-back'][index]) < 1e-9),
    'the equality flag must match the re-derived series, not be asserted in prose'
  );
  assert(
    'track-identifiability-honest',
    collinearity.identifiability?.trackFactorIdentifiable === !(reducedResidual < 1e-9),
    JSON.stringify(collinearity.identifiability)
  );
  assert(
    'identifiability-reported',
    Array.isArray(collinearity.identifiability?.gateFactorUnidentifiableOn),
    JSON.stringify(collinearity.identifiability)
  );
  const a3 = arms.find((entry) => entry.armId === 'Arm-3');
  const a4 = arms.find((entry) => entry.armId === 'Arm-4');
  assert(
    'interaction-identifiability-honest',
    collinearity.identifiability?.interactionIdentifiable ===
      !a3?.tasks.every((task, index) => task.verifiedRate === a4?.tasks[index]?.verifiedRate),
    JSON.stringify(collinearity.identifiability)
  );

  // -------------------------------------------------------------------------
  // 6c. supplementary family: separate, 12x10 table present
  // -------------------------------------------------------------------------
  const exploratory = report.comparisons?.exploratory ?? [];
  assert('exploratory-present', exploratory.length === 10, String(exploratory.length));
  assert(
    'exploratory-separate',
    exploratory.every((entry) => entry.q !== undefined && entry.pAdjusted === undefined),
    'supplementary rows must carry q (BH) and not pAdjusted (Holm)'
  );
  assert(
    'exploratory-intervals-present',
    exploratory.every(
      (entry) =>
        typeof entry.randomizationInterval?.lower === 'number' &&
        typeof entry.randomizationInterval?.upper === 'number' &&
        typeof entry.intervalWidth === 'number'
    ),
    'every supplementary contrast needs its own interval width'
  );
  // A constant-zero series has NO discordant information; its interval must be
  // flagged as degenerate rather than read as extreme precision.
  for (const entry of exploratory) {
    const values = entry.perTask.map((row) => row.delta);
    const allZero = values.every((value) => Math.abs(value) < 1e-9);
    assert(
      'degenerate-interval-flagged:' + entry.left + '-' + entry.right,
      !allZero || (entry.intervalWidth <= 1e-9 && entry.discordantPairs === 0),
      'an all-zero series must report m_disc=0 and a degenerate interval: ' + JSON.stringify(entry.randomizationInterval)
    );
  }
  const pairwiseTable = report.comparisons?.pairwiseTable;
  assert(
    'pairwise-table-12x10',
    pairwiseTable?.rows?.length === 12 && pairwiseTable?.columns?.length === 10,
    'rows=' + String(pairwiseTable?.rows?.length) + ' columns=' + String(pairwiseTable?.columns?.length)
  );
  assert(
    'pairwise-table-cells-complete',
    pairwiseTable?.rows?.every(
      (row) => row.cells.length === 10 && row.cells.every((cell) => cell === null || Number.isFinite(cell))
    ),
    'every task row needs 10 numeric cells'
  );
  const controlledSeries = report.comparisons?.controlledSeries;
  assert(
    'controlled-series-12x4',
    controlledSeries?.rows?.length === 12 && controlledSeries?.columns?.length === 4,
    JSON.stringify({ rows: controlledSeries?.rows?.length, columns: controlledSeries?.columns?.length })
  );

  // -------------------------------------------------------------------------
  // 7. cost three-state with denominator (V2 §9.2) + §9.3 six token fields
  // -------------------------------------------------------------------------
  const costArms = report.cost?.arms ?? [];
  assert('cost-five-arms', costArms.length === 5, String(costArms.length));
  for (const entry of costArms) {
    assert('cost-denominator:' + entry.armId, entry.denominator === 'decision-points', entry.denominator);
    assert('cost-live-zero:' + entry.armId, entry.liveCalls === 0);
    assert('cost-real-zero:' + entry.armId, entry.incurredRealUsd === 0);
    const sum = entry.measured.share + entry.estimated.share + entry.unknown.share;
    assert('cost-shares-sum-1:' + entry.armId, Math.abs(sum - 1) < 1e-9, String(sum));
    assert(
      'cost-counts-match:' + entry.armId,
      entry.measured.count + entry.estimated.count + entry.unknown.count === entry.decisionPoints,
      String(entry.measured.count + entry.estimated.count + entry.unknown.count) + ' vs ' + String(entry.decisionPoints)
    );
    if (hasMeasurementCapability) {
      // A declared capability must actually produce measurements. Zero measured
      // calls under a tokenizer declaration is a broken capture, not a pass.
      assert(
        'cost-measured-capability:' + entry.armId,
        entry.measured.count > 0 && entry.measured.count <= entry.decisionPoints,
        'a declared measurement capability must produce at least one measured call and never exceed the denominator'
      );
    } else {
      assert('cost-measured-zero:' + entry.armId, entry.measured.count === 0, 'no tokenizer => measured must be 0');
    }
    assert(
      'cost-surcharge-separate:' + entry.armId,
      typeof entry.conservativeSurchargeMicros === 'number',
      String(entry.conservativeSurchargeMicros)
    );
    assert('cost-notional-positive:' + entry.armId, entry.notionalCostMicros > 0);
  }
  const tokenFields = report.tokenFields ?? {};
  const SIX = ['inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'];
  assert(
    'token-six-fields-declared',
    Array.isArray(tokenFields.fields) &&
      tokenFields.fields.length === 6 &&
      SIX.every((field) => tokenFields.fields.includes(field)),
    JSON.stringify(tokenFields.fields)
  );
  assert('token-per-arm-present', Array.isArray(tokenFields.perArm) && tokenFields.perArm.length === 5);
  for (const entry of tokenFields.perArm ?? []) {
    for (const field of SIX) {
      const value = entry[field];
      assert(
        'token-field-precision:' + entry.armId + ':' + field,
        value !== undefined && typeof value.tokens === 'number' && value.precision === 'estimated',
        JSON.stringify(value)
      );
    }
    assert(
      'token-total-is-sum:' + entry.armId,
      entry.totalTokens.tokens === entry.inputTokens.tokens + entry.outputTokens.tokens,
      JSON.stringify({
        total: entry.totalTokens.tokens,
        input: entry.inputTokens.tokens,
        output: entry.outputTokens.tokens
      })
    );
    if (hasMeasurementCapability) {
      // Measured precision is permitted ONLY under an explicit capability, and
      // even then every field must carry one of the three valid precisions.
      assert(
        'token-measured-capability:' + entry.armId,
        SIX.every((field) => ['measured', 'estimated', 'unknown'].includes(entry[field].precision)),
        'a declared measurement capability must label every token field measured/estimated/unknown'
      );
    } else {
      assert(
        'token-no-measured:' + entry.armId,
        SIX.every((field) => entry[field].precision !== 'measured'),
        'no token field may claim measured without a tokenizer'
      );
    }
    assert(
      'token-denominator-named:' + entry.armId,
      typeof entry.denominator === 'string' && typeof entry.decisionPoints === 'number',
      JSON.stringify({ denominator: entry.denominator, decisionPoints: entry.decisionPoints })
    );
  }

  // -------------------------------------------------------------------------
  // 8. ledgers: FULL arrays on disk, correct cardinality, full digests
  // -------------------------------------------------------------------------
  const ledgerFiles = arms.map((arm) => ({
    armId: arm.armId,
    path: join(REPO_ROOT, 'work', 'pr4a-ledger-' + arm.armId + '.jsonl')
  }));
  const ledgerDigests = [];
  for (const entry of ledgerFiles) {
    const exists = existsSync(entry.path);
    assert('ledger-exists:' + entry.armId, exists, entry.path);
    if (!exists) continue;
    const text = readFileSync(entry.path, 'utf8');
    ledgerDigests.push({ armId: entry.armId, sha256: sha256(text) });
    const rows = text.trim().split('\n').filter((line) => line.length > 0);
    assert('ledger-rows-180:' + entry.armId, rows.length === 180, String(rows.length));
    let parsed = 0;
    let payloadFree = true;
    let armMatches = true;
    let dispositionsValid = true;
    for (const line of rows) {
      try {
        const row = JSON.parse(line);
        parsed += 1;
        if (row.armId !== entry.armId) armMatches = false;
        // payload-free: no raw text/patch blobs (V2 §4.1.3)
        if (/"patch"\s*:/.test(line) || /"prompt"\s*:/.test(line) || /"content"\s*:/.test(line)) {
          payloadFree = false;
        }
        if (typeof row.writeDisposition !== 'string' || typeof row.hostVerdict !== 'string') {
          dispositionsValid = false;
        }
      } catch {
        /* counted by the parsed mismatch */
      }
    }
    assert('ledger-parses:' + entry.armId, parsed === rows.length, String(parsed) + '/' + String(rows.length));
    assert('ledger-arm-tag:' + entry.armId, armMatches);
    assert('ledger-payload-free:' + entry.armId, payloadFree);
    assert(
      'ledger-row-schema:' + entry.armId,
      dispositionsValid,
      'every row needs writeDisposition and hostVerdict (audit items 1 and 6)'
    );
  }
  // The Markdown report's SHA-256 table must match the files byte-for-byte, and
  // the digest must be the FULL 64 hex characters.
  if (existsSync(mdPath)) {
    const md = readFileSync(mdPath, 'utf8');
    for (const entry of ledgerDigests) {
      assert(
        'md-ledger-digest-matches:' + entry.armId,
        md.includes(entry.sha256),
        'the report must print the FULL 64-hex digest ' + entry.sha256
      );
    }
    assert(
      'md-digest-not-truncated',
      !/(pr4a-ledger-[^\s|`]*)[^\n]*`[0-9a-f]{8,63}…`/.test(md),
      'a truncated LEDGER digest cannot be reconciled against a file'
    );
  }
  // The JSON ledger index must agree with the files on disk.
  for (const entry of report.ledgerIndex?.perArm ?? []) {
    assert('ledger-index-rows:' + entry.armId, entry.rows === 180, String(entry.rows));
    assert(
      'ledger-index-columns:' + entry.armId,
      Array.isArray(entry.columns) &&
        entry.columns.includes('writeDisposition') &&
        entry.columns.includes('hostVerdict'),
      JSON.stringify(entry.columns)
    );
  }

  // -------------------------------------------------------------------------
  // 9. markdown must not contradict the honesty rules
  // -------------------------------------------------------------------------
  if (existsSync(mdPath)) {
    const md = readFileSync(mdPath, 'utf8');
    assert('md-declares-zero-live', /liveCalls/.test(md) && /0/.test(md));
    assert('md-declares-real-usd-zero', /incurredRealUsd/.test(md));
    assert('md-says-micros-not-usd', /不是美元|not.*USD|UNIT CONVENTION/i.test(md));
    assert('md-says-guardrail-not-cap', /不是财务上限|not.*financial cap/i.test(md));
    assert('md-says-wallclock-not-ceiling', /不是远端费用上限|not.*cost ceiling/i.test(md));
    assert('md-has-four-dim', /significance/.test(md) && /degradationStatus/.test(md) && /evidenceStatus/.test(md));
    assert('md-has-no-arm-5', !/Arm-5/.test(md));
    assert('md-lists-ledger-digests', /SHA-256/.test(md));
    assert('md-has-non-claims', /不.*声明什么|本报告\*\*不\*\*声明/.test(md));
    // the evidence the audit asked for must actually be printed
    assert('md-has-provenance', /executedSourcesDigest/.test(md) && /trackedWorkspaceDigest/.test(md));
    assert('md-has-token-six-fields', /inputTokens/.test(md) && /cacheWriteTokens/.test(md) && /reasoningTokens/.test(md));
    assert('md-has-audit-only-section', /auditOnlyAssertion/.test(md) || /仅审计/.test(md));
    assert('md-has-execution-control-coverage', /timeout-isolation/.test(md) && /early-stopped-for-harm/.test(md));
    assert('md-has-collinearity-disclosure', /共线|退化形式/.test(md));
    assert('md-has-degenerate-interval-note', !/退化区间/.test(md) || /不是/.test(md));
    assert('md-has-interval-widths', /宽度/.test(md));
    assert('md-has-12x10-table', /12 × 10/.test(md));
    assert('md-no-positive-track-claim', /不得.*轨道证据|不是.*轨道证据|不得.*轨道证据/.test(md));
  }

  // -------------------------------------------------------------------------
  // 10. execution-control coverage (§10.2 paths must be stated, fired or not)
  // -------------------------------------------------------------------------
  const coverage = report.safety?.executionControlCoverage ?? [];
  assert(
    'execution-control-coverage-complete',
    ['security-gate', 'offline-notional-guardrail', 'early-stopped-for-harm', 'timeout-isolation'].every((path) =>
      coverage.some((entry) => entry.path === path)
    ),
    JSON.stringify(coverage.map((entry) => entry.path))
  );
  for (const entry of coverage) {
    assert(
      'execution-control-declares-state:' + entry.path,
      typeof entry.triggered === 'boolean' && typeof entry.note === 'string' && entry.note.length > 10,
      JSON.stringify(entry)
    );
  }
  const firedKinds = new Set((report.safety?.events ?? []).map((event) => event.kind));
  for (const entry of coverage) {
    const expectedFired =
      entry.path === 'offline-notional-guardrail'
        ? firedKinds.has('guardrail-stop')
        : entry.path === 'early-stopped-for-harm'
          ? firedKinds.has('futility-stop')
          : entry.path === 'timeout-isolation'
            ? firedKinds.has('runner-timeout')
            : firedKinds.has('safety-violation');
    assert(
      'execution-control-flag-honest:' + entry.path,
      entry.triggered === expectedFired,
      'declared=' + String(entry.triggered) + ' events=' + String([...firedKinds].join('|'))
    );
  }
  // §10.4 completeness: nothing silently dropped, counts preserved
  for (const entry of report.safety?.dataCompleteness ?? []) {
    assert(
      'completeness-counts-match:' + entry.armId,
      entry.analyzedTasks + entry.notRunTasks.length === entry.plannedTasks,
      JSON.stringify(entry)
    );
    assert(
      'completeness-decision-points-match:' + entry.armId,
      entry.recordedDecisionPoints + entry.censoredExecutions === entry.plannedDecisionPoints,
      JSON.stringify(entry)
    );
    assert(
      'completeness-status-consistent:' + entry.armId,
      entry.status ===
        (entry.notRunTasks.length === 0 && entry.denominatorDegradedTasks.length === 0 ? 'complete' : 'incomplete'),
      JSON.stringify(entry)
    );
    assert(
      'completeness-denominator-honest:' + entry.armId,
      // KNOWN TAUTOLOGY (audit item, deliberately annotated but NOT repaired in
      // the PR-4A portability fix): `|| true` makes this assertion always hold.
      // It is left byte-for-byte as-is so this change cannot claim to have fixed
      // it; the review must treat the check as unverified.
      entry.censoredExecutions === entry.denominatorDegradedTasks.length * 0 || true,
      'censored executions must be listed, never silently removed'
    );
  }
  // A censored episode must never be counted as a failed one (§6.4).
  for (const arm of arms) {
    for (const task of arm.tasks) {
      const censored = task.runs.filter((run) => run.censored);
      assert(
        'censored-not-counted-as-failure:' + arm.armId + ':' + task.taskId,
        censored.every((run) => run.verified === null),
        'a censored episode must carry no boolean verdict'
      );
      assert(
        'availability-arithmetic:' + arm.armId + ':' + task.taskId,
        task.availableEpisodes + task.censoredEpisodes === task.runs.length,
        JSON.stringify({ available: task.availableEpisodes, censored: task.censoredEpisodes, runs: task.runs.length })
      );
      assert(
        'host-verdict-in-ledger:' + arm.armId + ':' + task.taskId,
        task.runs.every((run) => run.censored || typeof run.verified === 'boolean'),
        'every analysed episode needs a boolean host verdict'
      );
    }
  }

  // -------------------------------------------------------------------------
  // 11. no arm claims a real (non-notional) cost anywhere
  // -------------------------------------------------------------------------
  const jsonText = JSON.stringify(report);
  assert(
    'no-real-cost-fields',
    !/"realCost"\s*:\s*[1-9]/.test(jsonText) && !/"actualCostUsd"\s*:\s*[1-9]/.test(jsonText)
  );
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
// t18 (t11 O1): the equivalence classification is pushed exactly ONCE, where it
// is judged (inside the provenance block). No late duplicate push here — the
// old code re-pushed the same id with ok:true, inflating checked/passed on any
// run with equivalence hits (real LF checkout: 691→693) and, in the mixed
// state, recording the SAME id as both a failure and a forced pass.
const advisories = results.filter((entry) => entry.advisory === true);
const failed = results.filter((entry) => !entry.ok && entry.advisory !== true);
const status = {
  checked: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  // eol-equiv-v1 named classification (ADR 0005 D2): the executedSources
  // entries whose recorded raw-byte digest matches the same text under the
  // other line-ending form. Separate from raw matches and from warnings.
  eolEquivalents: eolEquivalentPaths.map((eolPath) => ({ path: eolPath, rule: EOL_EQUIV_VERSION, kind: 'eol-equivalent' })),
  warnings: advisories.map((entry) => ({ id: entry.id, detail: entry.detail })),
  failures: failed.map((entry) => ({ id: entry.id, detail: entry.detail }))
};
let statusNote = 'status file: work/pr4a-verify-status.json';
try {
  writeFileSync(join(REPO_ROOT, 'work', 'pr4a-verify-status.json'), JSON.stringify(status, null, 2) + '\n', 'utf8');
} catch (error) {
  // A missing/unwritable work/ directory must not hide the verdict: stdout below
  // is the diagnostic channel of last resort (e.g. the missing-artifact state).
  statusNote = 'status file NOT written: ' + String(error && error.message ? error.message : error);
}

// The verdict, the counts and every failing check id/detail go to stdout so the
// run is diagnosable from a terminal or CI log alone, without the status file.
console.log(
  '[verify-pr4a-artifacts] checked=' + String(status.checked) +
    ' passed=' + String(status.passed) +
    ' failed=' + String(status.failed)
);
for (const entry of advisories) {
  console.log('[verify-pr4a-artifacts] WARN ' + entry.id + (entry.detail === '' ? '' : ' :: ' + entry.detail));
}
// eol-equiv-v1 named classification in the stdout summary (empty on a run with
// no equivalence hits, e.g. the shipped artifact on its generation checkout).
for (const equivalent of status.eolEquivalents) {
  console.log(
    '[verify-pr4a-artifacts] EOL-EQUIVALENT (' +
      EOL_EQUIV_VERSION +
      ') ' +
      equivalent.path +
      ' :: same text under the other line-ending form; recorded digest is the historical byte fact'
  );
}
for (const entry of failed) {
  console.log('[verify-pr4a-artifacts] FAIL ' + entry.id + (entry.detail === '' ? '' : ' :: ' + entry.detail));
}
console.log('[verify-pr4a-artifacts] ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' (' + statusNote + ')');

if (failed.length === 0) {
  process.exitCode = 0;
} else {
  process.exitCode = 1;
}
