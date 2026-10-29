#!/usr/bin/env node
/**
 * Attestation-target gate (ADR 0005, decision D1 / P1 task t2).
 *
 * WHAT QUESTION THIS ANSWERS
 * --------------------------
 * A commit attestation record can only describe the commit it was generated
 * FROM (`scripts/eval/final-attestation.mjs` header, SELF-REFERENCE BOUNDARY).
 * Once a record is committed, the commit that CONTAINS it is never covered by
 * it. So a CI gate has to decide, per commit, WHICH question it is allowed to
 * ask - and the answer differs by commit kind:
 *
 *   - ordinary commit: the canonical record describes some OLDER commit and
 *     must be self-consistent with it, and that commit must be an ANCESTOR of
 *     HEAD. The gate does NOT claim HEAD is attested (the fingerprint jobs
 *     answer that, per ADR 0005 §1.7), and it does NOT invent a parent target
 *     for ordinary commits.
 *   - evidence commit: a commit that declares `Attestation-Target:
 *     first-parent` as a git trailer. Its ONLY allowed content is the updated
 *     canonical record, its recorded `commit.commitId` must equal `HEAD^1`,
 *     and its parent must be an ordinary (unmarked) code commit. Only here is
 *     `HEAD^` binding - and it is DERIVED, not guessed: the commit itself
 *     declares the evidence rule, the checker mechanically derives the parent
 *     and three-way-checks record vs parent vs ancestry.
 *
 * The rejected alternatives (ADR 0005 §1.1) are exactly the two degenerate
 * designs this gate avoids:
 *   - unconditional `--strict` for every commit = always red (a record never
 *     describes the commit that contains it), and
 *   - unconditional `--expect-commit HEAD^1` for every commit = a lax guess
 *     that ordinary commits fail (their record legitimately points further
 *     back) and that never asks what a commit claims to be.
 * Both were prototype-refuted (13/13 probe, ADR 0005 §8.2).
 *
 * CLASSIFICATION (T0–T8; all reason codes are stable strings)
 * ----------------------------------------------------------
 *   T0 ordinary commit, record self-consistent + ancestor            -> PASS
 *   T1 evidence commit, record-only, target = HEAD^1                 -> PASS
 *   T2 evidence commit with wrong target                             -> FAIL attestation-target-mismatch
 *   T3 evidence commit carrying code changes                         -> FAIL attestation-evidence-impure
 *   T4 evidence commit that is a merge (or root)                     -> FAIL attestation-evidence-merge
 *   T5 evidence commit stacked on another evidence commit            -> FAIL attestation-evidence-stacked
 *   T6 canonical record missing/unreadable/shapeless                 -> FAIL attestation-record-missing
 *   T7 ordinary commit whose record names a non-ancestor             -> FAIL attestation-record-not-ancestor
 *   T8 marker duplicated / unsupported value                         -> FAIL attestation-marker-duplicated / attestation-marker-unsupported
 *   R-06 evidence commit judging uncommitted/drifted record bytes    -> FAIL attestation-record-not-committed / attestation-record-worktree-drift
 *      (ordinary commits NOTE the same comparison; the verdict is unchanged)
 *
 * DESIGN RULES (ADR 0005 §1.4, hard constraints)
 * ----------------------------------------------
 *   1. Reuses `verifyAttestation` from `final-attestation.mjs` (import, no
 *      shell-out, no copied verification logic). `CANONICAL_RECORD_PATH` and
 *      `ATTESTATION_TARGET_MARKER` come from the same module: one source of
 *      truth for the path and the marker.
 *   2. Never changes `final-attestation.mjs` semantics: plain `--verify` stays
 *      historical self-consistency; `--strict` stays "record describes HEAD";
 *      no implicit follow-the-parent mode is added anywhere.
 *   3. Every git failure is a named failure (never skip, never degrade).
 *   4. Reads the record file plus the OBJECT DATABASE only; writes NOTHING
 *      (JSON goes to stdout).
 *   5. `--cwd` is supported: the evidence root defaults to the repository this
 *      script ships in, and fixtures MUST pass `--cwd` explicitly, otherwise
 *      the gate would judge THIS repository and produce a plausible-looking
 *      wrong answer (ADR 0005 §8.2 implementation note).
 *   6. The marker is parsed with `git interpret-trailers --parse` (git >= 2.40)
 *      on `%B`, so only a real trailer block counts: a body sentence quoting
 *      `Attestation-Target: first-parent` does NOT make a commit an evidence
 *      commit.
 *   7. (R-06) Record-source binding: the record is READ from the working tree
 *      but every content check recomputes from the OBJECT DATABASE, so the gate
 *      explicitly compares the worktree bytes with the judged commit's blob
 *      (`git ls-tree` + `git cat-file`). An EVIDENCE commit fails with
 *      `attestation-record-not-committed` (no blob at the path) or
 *      `attestation-record-worktree-drift` (bytes differ) — an evidence commit
 *      must judge its own committed bytes, fail-closed. An ORDINARY commit keeps
 *      the documented "regenerate locally, commit later" posture (ADR §1.6.2):
 *      the comparison is only a NOTE, never a verdict change.
 *
 * EXIT CODES
 *   0  the commit's rule holds (mode ordinary or evidence, per above)
 *   1  gate failure with a stable reason code (T2–T8, or a named git/parse
 *      failure such as `ref-not-a-commit` / `git-command-failed`)
 *
 * USAGE
 *   node scripts/eval/check-attestation-target.mjs [--cwd <dir>] [--json]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import {
  CANONICAL_RECORD_PATH,
  verifyAttestation
} from './final-attestation.mjs';
import {
  GitEvidenceError,
  assertAncestor,
  readCommitBlobAtPath,
  resolveCommit,
  sha256Bytes
} from './lib/git-objects.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

/**
 * The exact marker line the evidence-commit rule accepts (ADR 0005 §1.2).
 *
 * Pinned here as a literal AND re-exported indirectly through the test's own
 * import from `final-attestation.mjs`; the node:test suite asserts the two
 * spellings agree, so a drift between this literal and the shared constant
 * turns the suite red instead of silently changing the gate.
 */
const MARKER_EXACT_LINE = 'Attestation-Target: first-parent';
const MARKER_SEPARATOR = ': ';
const MARKER_KEY = MARKER_EXACT_LINE.slice(0, MARKER_EXACT_LINE.indexOf(MARKER_SEPARATOR));
const MARKER_VALUE = MARKER_EXACT_LINE.slice(MARKER_EXACT_LINE.indexOf(MARKER_SEPARATOR) + MARKER_SEPARATOR.length);

/**
 * Run git with a scrubbed environment, throwing a named error on any failure.
 *
 * GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE are cleared so evidence always comes
 * from the repository rooted at `cwd`, never from an ambient override (same
 * policy as `scripts/eval/lib/git-objects.mjs`). Every command used here emits
 * UTF-8 text.
 *
 * @param {string[]} args
 * @param {string} cwd
 * @param {string} [input] stdin payload (used for `interpret-trailers --parse`)
 * @returns {string}
 */
function git(args, cwd, input) {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  try {
    return String(
      execFileSync('git', args.slice(), {
        cwd,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        env,
        ...(input === undefined ? {} : { input })
      })
    );
  } catch (error) {
    const stderrValue = error && /** @type {any} */ (error).stderr;
    const stderr =
      stderrValue === undefined || stderrValue === null
        ? String(/** @type {any} */ (error).message)
        : Buffer.isBuffer(stderrValue)
          ? stderrValue.toString('utf8').trim()
          : String(stderrValue);
    throw new GitEvidenceError('git-command-failed', `git ${args.join(' ')} failed: ${stderr}`);
  }
}

/**
 * Extract the marker trailer lines from a commit message.
 *
 * `git interpret-trailers --parse` prints ONLY the trailer block; we filter its
 * lines for the marker KEY and compare the normalized line exactly. This
 * yields the ADR's cases: none / one supported / one unsupported / duplicated.
 * A prose sentence in the body never reaches this filter because --parse does
 * not emit body lines.
 *
 * @param {string} commitId
 * @param {string} cwd
 * @returns {string[]} every marker line git's own trailer parser emitted
 */
function parseMarkerLines(commitId, cwd) {
  const message = git(['log', '-1', '--format=%B', commitId], cwd);
  const trailers = git(['interpret-trailers', '--parse'], cwd, message);
  return trailers
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith(`${MARKER_KEY}:`));
}

/**
 * Parent commit ids of one commit (`git rev-list --parents -n 1`).
 *
 * @param {string} commitId
 * @param {string} cwd
 * @returns {string[]} empty for a root commit
 */
function parentIds(commitId, cwd) {
  const out = git(['rev-list', '--parents', '-n', '1', commitId], cwd).trim().split(/\s+/);
  if (out.length < 1 || out[0] !== commitId) {
    throw new GitEvidenceError(
      'parents-unresolvable',
      `git rev-list --parents -n 1 returned an unexpected shape for ${commitId}`
    );
  }
  return out.slice(1);
}

/**
 * Paths changed by a commit, NUL-delimited (-z), so spaces/newlines in names
 * cannot split wrongly. Merge commits never reach this function (T4 rejects
 * them first) because plain diff-tree is silent on merges.
 *
 * @param {string} commitId
 * @param {string} cwd
 * @returns {string[]}
 */
function changedPaths(commitId, cwd) {
  return git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', commitId], cwd)
    .split('\u0000')
    .filter((entry) => entry.length > 0);
}

/**
 * Read the canonical record, refusing to continue without it (T6).
 *
 * A missing/unreadable/shapeless record is REPORTED (`recordMissing`) rather
 * than thrown: every judged topology must return the same structured result
 * shape. A record that parses and names a commit returns `recordMissing: null`.
 *
 * @param {string} cwd
 * @returns {{record: any, recordedCommitId: string, recordMissing: string|null}}
 */
function readCanonicalRecord(cwd) {
  const recordPath = path.resolve(cwd, CANONICAL_RECORD_PATH);
  let bytes;
  try {
    bytes = fs.readFileSync(recordPath);
  } catch (error) {
    return {
      record: null,
      recordedCommitId: null,
      recordMissing:
        `${CANONICAL_RECORD_PATH} is missing or unreadable (${error instanceof Error ? error.message : String(error)}); ` +
        'the gate never proceeds without the canonical record (T6)'
    };
  }
  let record;
  try {
    record = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    return {
      record: null,
      recordedCommitId: null,
      recordMissing:
        `${CANONICAL_RECORD_PATH} is not valid JSON (${error instanceof Error ? error.message : String(error)}); ` +
        'an unreadable record is a missing record for gate purposes (T6)'
    };
  }
  const recordedCommit = record !== null && typeof record === 'object' ? record.commit : undefined;
  const recordedCommitId =
    recordedCommit !== null &&
    typeof recordedCommit === 'object' &&
    typeof recordedCommit.commitId === 'string'
      ? recordedCommit.commitId
      : null;
  if (recordedCommitId === null) {
    return {
      record,
      recordedCommitId: null,
      bytes: null,
      recordMissing:
        `${CANONICAL_RECORD_PATH} has no commit.commitId; a record without a target is not evidence (T6)`
    };
  }
  return { record, recordedCommitId, bytes, recordMissing: null };
}

/**
 * R-06: bind the record bytes the gate READS to the commit it JUDGES.
 *
 * `readCanonicalRecord` and `verifyAttestation` read the record from the
 * WORKING TREE (`fs.readFileSync`), while every content check recomputes from
 * the OBJECT DATABASE. On a clean checkout (CI) the two agree byte for byte; on
 * a dirty worktree they can disagree, and then the gate would judge bytes that
 * are not committed evidence. This helper compares the worktree bytes against
 * the blob at the judged commit:
 *
 *   - `committed === null`      : the judged commit has NO record at
 *     \`CANONICAL_RECORD_PATH\` — the evidence bytes exist only on disk
 *     (`attestation-record-not-committed`);
 *   - \`bytes differ\`           : the worktree record drifted from the judged
 *     commit's blob (`attestation-record-worktree-drift`).
 *
 * Failure codes are consumed ONLY where the ADR requires the judged bytes to be
 * the commit's own (evidence mode, whose declared content is exactly this
 * record); ordinary mode keeps reading the worktree record (the documented
 * "regenerate locally, commit later" posture, ADR §1.6.2) and reports the
 * comparison as a NOTE instead.
 *
 * @param {{commitId: string}} commit the judged commit (`resolveCommit` result)
 * @param {Buffer|null} worktreeBytes the bytes the gate read from disk
 * @param {string} cwd
 * @returns {{ok: true, note: string} | {ok: false, code: string, detail: string, note: string}}
 */
function compareRecordSource(commit, worktreeBytes, cwd) {
  const committed = readCommitBlobAtPath(commit, CANONICAL_RECORD_PATH, cwd);
  if (committed === null) {
    return {
      ok: false,
      code: 'attestation-record-not-committed',
      detail:
        `commit ${commit.commitId} has no '${CANONICAL_RECORD_PATH}' blob, but the gate read '${CANONICAL_RECORD_PATH}' from the working tree; ` +
        'bytes that exist only on disk are not committed evidence, so the gate refuses to judge them (R-06)',
      note: `record source: NOT committed at ${commit.commitId} (judged from the working tree only)`
    };
  }
  const worktreeSha = worktreeBytes === null ? null : sha256Bytes(worktreeBytes);
  const committedSha = sha256Bytes(committed.bytes);
  if (worktreeBytes === null || !worktreeBytes.equals(committed.bytes)) {
    return {
      ok: false,
      code: 'attestation-record-worktree-drift',
      detail:
        `the working-tree '${CANONICAL_RECORD_PATH}' does not match the blob committed at ${commit.commitId}` +
        ` (worktree sha256=${String(worktreeSha)}, committed blob ${committed.blobId} sha256=${committedSha}); ` +
        'the gate judges COMMITTED evidence, so the drifted working-tree copy is refused (R-06)',
      note: `record source: worktree sha256=${String(worktreeSha)} != committed ${committed.blobId}`
    };
  }
  return {
    ok: true,
    note: `record source: worktree bytes == HEAD blob ${committed.blobId} (sha256 ${committedSha})`
  };
}

/**
 * Classify and judge the commit at `ref` under the ADR 0005 D1 rules.
 *
 * @param {{cwd: string, ref?: string}} options
 * @returns {{
 *   mode: 'ordinary'|'evidence'|null,
 *   ref: string,
 *   headCommitId: string|null,
 *   markerLines: string[],
 *   recordedCommitId: string|null,
 *   parentCommitId: string|null,
 *   contentOk: boolean,
 *   targetOk: boolean,
 *   ok: boolean,
 *   failures: {code: string, detail: string}[],
 *   notes: string[],
 *   verifyNotes: string[]
 * }}
 */
export function checkAttestationTarget(options) {
  const cwd = options.cwd;
  const ref = options.ref ?? 'HEAD';

  // Resolve HEAD first: every rule below is about THIS commit. A ref that does
  // not resolve is a named failure, never a skip (ADR §1.4.4).
  const head = resolveCommit(ref, cwd);
  const headCommitId = head.commitId;

  // ---- T8: marker shape (checked before anything else) ---------------------
  const markerLines = parseMarkerLines(headCommitId, cwd);
  if (markerLines.length > 1) {
    return gateFailure('evidence', ref, headCommitId, markerLines, 'attestation-marker-duplicated');
  }
  if (markerLines.length === 1 && markerLines[0] !== MARKER_EXACT_LINE) {
    return gateFailure('evidence', ref, headCommitId, markerLines, 'attestation-marker-unsupported');
  }

  // ---- T6: the canonical record must exist and name a commit ---------------
  // A record-shape failure is a RESULT, not an exception: `checkAttestationTarget`
  // is the library surface, so every judged topology returns the same structured
  // shape (the CLI turns `ok:false` into exit 1 either way). The mode reported
  // here is the marker classification determined above ('ordinary' when the
  // commit carries no marker, 'evidence' otherwise); T6 applies to both.
  const { recordedCommitId, bytes: recordBytes, recordMissing } = readCanonicalRecord(cwd);
  if (recordMissing !== null) {
    return gateFailure(markerLines.length === 0 ? 'ordinary' : 'evidence', ref, headCommitId, markerLines, 'attestation-record-missing', {
      detailOverride: recordMissing
    });
  }

  // ---- R-06: the bytes this gate reads must be the judged commit's bytes ----
  // The recordSource failure is consumed per mode below: evidence mode FAILS on
  // it (its declared content is exactly this record, so uncommitted or drifted
  // bytes invalidate the declared topology), ordinary mode keeps the
  // "regenerate locally, commit later" posture and only notes the divergence.
  const recordSource = compareRecordSource(head, recordBytes, cwd);

  if (markerLines.length === 0) {
    // ---- T0 / T7: ordinary commit --------------------------------------
    // Self-consistency via the SHARED verifier with NO target flags (the
    // historical semantics are reused verbatim; no parent target is invented
    // for ordinary commits), then the ancestor bound (T7).
    const verify = verifyAttestation(CANONICAL_RECORD_PATH, { cwd });
    /** @type {{code: string, detail: string}[]} */
    const failures = [];
    if (!verify.contentOk) {
      failures.push(contentMismatchFailure(verify.differences, 'its own commit'));
    }
    try {
      // `assertAncestor` reads only `commitId`; the ref label is for the error
      // message only, and the ancestry answer comes from
      // `git merge-base --is-ancestor`.
      assertAncestor({ ref: CANONICAL_RECORD_PATH, commitId: recordedCommitId, treeId: '' }, head, cwd);
    } catch (error) {
      if (error instanceof GitEvidenceError && error.code === 'not-an-ancestor') {
        failures.push({
          code: 'attestation-record-not-ancestor',
          detail:
            `the record attests ${recordedCommitId}, which is NOT an ancestor of HEAD ${headCommitId}; ` +
            'rewritten history or a foreign record is not evidence about this line of development (T7)'
        });
      } else {
        throw error;
      }
    }
    return {
      mode: 'ordinary',
      ref,
      headCommitId,
      markerLines,
      recordedCommitId,
      parentCommitId: null,
      contentOk: verify.contentOk,
      targetOk: failures.length === 0,
      ok: failures.length === 0,
      failures,
      notes: [
        `ordinary: HEAD ${headCommitId} is NOT covered by this record; the record binds its own commit ` +
          `${recordedCommitId} only (self-consistency + ancestry, ADR 0005 §1.3 T0)`,
        // R-06: ordinary mode keeps the documented "regenerate locally, commit
        // later" posture, so the worktree/HEAD comparison is OBSERVATION only -
        // it never changes the verdict.
        recordSource.note
      ],
      verifyNotes: verify.notes
    };
  }

  // ---- evidence commit: T4 / T5 / T3 / T2 / T1 ----------------------------
  const parents = parentIds(headCommitId, cwd);
  if (parents.length !== 1) {
    return gateFailure('evidence', ref, headCommitId, markerLines, 'attestation-evidence-merge', {
      parentCount: parents.length
    });
  }
  const parent = parents[0];

  // T5: the FIRST-PARENT semantics require the parent to be a code commit.
  const parentMarkers = parseMarkerLines(parent, cwd);
  if (parentMarkers.length > 0) {
    return gateFailure('evidence', ref, headCommitId, markerLines, 'attestation-evidence-stacked', {
      parent
    });
  }

  // T3: purity - the ONLY allowed change is the canonical record.
  const changes = changedPaths(headCommitId, cwd);
  const impure = changes.filter((entry) => entry !== CANONICAL_RECORD_PATH);
  if (changes.length === 0 || impure.length > 0) {
    return gateFailure('evidence', ref, headCommitId, markerLines, 'attestation-evidence-impure', {
      parent,
      changes
    });
  }

  // R-06 (fail-closed): an evidence commit declares that its ONLY content is
  // this record, so the bytes being judged must be exactly the bytes the commit
  // contains. Uncommitted or worktree-drifted bytes would let a gate PASS on
  // evidence the commit never carried - refuse them with a named code.
  if (!recordSource.ok) {
    return gateFailure('evidence', ref, headCommitId, markerLines, recordSource.code, {
      parent,
      detailOverride: recordSource.detail
    });
  }

  // T1/T2: three-way binding - the record must name exactly HEAD^1 (expectCommit)
  // AND re-verify against it (content) via the SHARED verifier.
  const verify = verifyAttestation(CANONICAL_RECORD_PATH, { cwd, expectCommit: parent });
  /** @type {{code: string, detail: string}[]} */
  const failures = [];
  for (const mismatch of verify.targetMismatches) {
    failures.push({ code: mismatch.code, detail: mismatch.detail });
  }
  if (!verify.contentOk) {
    failures.push(contentMismatchFailure(verify.differences, `the target parent ${parent}`));
  }

  return {
    mode: 'evidence',
    ref,
    headCommitId,
    markerLines,
    recordedCommitId,
    parentCommitId: parent,
    contentOk: verify.contentOk,
    targetOk: failures.length === 0,
    ok: failures.length === 0,
    failures,
    notes: [
      `evidence: parent=${parent} (HEAD^1) is covered by this record ` +
        '(marker + record-only + non-merge + unmarked parent, ADR 0005 §1.3 T1)',
      // R-06: on PASS the binding is still stated explicitly, so a reviewer can
      // see that the judged bytes were the commit's own bytes.
      recordSource.note
    ],
    verifyNotes: verify.notes
  };
}

/**
 * Build the content-mismatch failure with a bounded difference listing.
 *
 * @param {string[]} differences
 * @param {string} what the record should describe
 * @returns {{code: string, detail: string}}
 */
function contentMismatchFailure(differences, what) {
  const shown = differences.slice(0, 10);
  return {
    code: 'attestation-content-mismatch',
    detail:
      `the canonical record does not describe ${what} (${differences.length} difference(s)); first differences:\n  ` +
      shown.join('\n  ') +
      (differences.length > shown.length ? `\n  … and ${differences.length - shown.length} more` : '')
  };
}

/**
 * Build a failure result for checks that happen before/without verification.
 *
 * @param {'evidence'} mode
 * @param {string} ref
 * @param {string} headCommitId
 * @param {string[]} markerLines
 * @param {string} code
 * @param {{parent?: string, parentCount?: number, changes?: string[], detailOverride?: string}} [extra]
 * @returns {ReturnType<typeof checkAttestationTarget>}
 */
function gateFailure(mode, ref, headCommitId, markerLines, code, extra = {}) {
  const detail =
    extra.detailOverride !== undefined ? extra.detailOverride : FAILURE_DETAIL[code](headCommitId, markerLines, extra);
  return {
    mode,
    ref,
    headCommitId,
    markerLines,
    recordedCommitId: null,
    parentCommitId: extra.parent ?? null,
    contentOk: false,
    targetOk: false,
    ok: false,
    failures: [{ code, detail }],
    notes:
      code === 'attestation-record-missing'
        ? [`FAIL ${code}; the gate never proceeds without the canonical record (ADR 0005 D1, T6)`]
        : [`${mode}: FAIL ${code}; this commit is not acceptable evidence under ADR 0005 D1`],
    verifyNotes: []
  };
}

/** Stable detail text per pre-verification failure code. */
const FAILURE_DETAIL = {
  'attestation-marker-duplicated': (headCommitId, markerLines) =>
    `commit ${headCommitId} carries ${markerLines.length} 'Attestation-Target:' trailer lines ` +
    `(${markerLines.join(' | ')}); exactly one marker with value '${MARKER_VALUE}' is allowed (T8)`,
  'attestation-marker-unsupported': (headCommitId, markerLines) =>
    `commit ${headCommitId} declares ${JSON.stringify(markerLines[0] ?? '')}; ` +
    `the only supported marker is ${JSON.stringify(MARKER_EXACT_LINE)} (T8)`,
  'attestation-evidence-merge': (headCommitId, _markerLines, extra) =>
    `commit ${headCommitId} declares an attestation target but has ${extra.parentCount ?? 0} parent(s); ` +
    'an evidence commit must be non-merge with exactly one first parent (T4)',
  'attestation-evidence-stacked': (headCommitId, _markerLines, extra) =>
    `commit ${headCommitId} declares an attestation target but its first parent ${extra.parent ?? '(unknown)'} ` +
    'also carries the marker; first-parent semantics require the parent to be a code commit (T5)',
  'attestation-evidence-impure': (headCommitId, _markerLines, extra) =>
    `commit ${headCommitId} declares an attestation target but changes ` +
    `${JSON.stringify(extra.changes ?? [])}; the only allowed change set is ` +
    `[${JSON.stringify(CANONICAL_RECORD_PATH)}] (T3)`
};

/**
 * Human-readable summary for non-JSON output.
 *
 * @param {ReturnType<typeof checkAttestationTarget>} result
 * @returns {string[]}
 */
function humanLines(result) {
  const lines = [
    `${result.ok ? 'PASS' : 'FAIL'} (${result.mode}) ${CANONICAL_RECORD_PATH}:`,
    `  HEAD:            ${result.headCommitId ?? '(unresolvable)'}`,
    `  recorded commit: ${result.recordedCommitId ?? '(unreadable)'}`
  ];
  if (result.mode === 'evidence' && result.parentCommitId !== null) {
    lines.push(`  parent (HEAD^1): ${result.parentCommitId}`);
  }
  for (const failure of result.failures) {
    lines.push(`  [${failure.code}] ${failure.detail}`);
  }
  for (const note of result.notes) {
    lines.push(`  ${note}`);
  }
  return lines;
}

/**
 * Parser kept deliberately small and strict: unknown flags are errors and a
 * value-taking flag without a value is an error (no silent degradation).
 *
 * @param {string[]} argv
 * @returns {{cwd: string, json: boolean, help: boolean}}
 */
function parseArgs(argv) {
  const options = { cwd: rootDir, json: false, help: false };
  /** @type {string[]} */
  const unknown = [];
  /** @type {string[]} */
  const missingValue = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--cwd') {
      const value = argv[index + 1];
      if (value === undefined) {
        missingValue.push(arg);
      } else {
        options.cwd = value;
      }
      index += 1;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      unknown.push(arg);
    }
  }
  if (missingValue.length > 0) {
    throw new GitEvidenceError(
      'argument-value-missing',
      `${missingValue.join(', ')} requires a value; refusing to continue with the flag silently dropped`
    );
  }
  if (unknown.length > 0) {
    throw new GitEvidenceError('unknown-argument', `unknown argument(s): ${unknown.join(' ')}`);
  }
  if (typeof options.cwd !== 'string' || options.cwd.length === 0) {
    throw new GitEvidenceError('cwd-missing', '--cwd requires a non-empty directory path');
  }
  return options;
}

const USAGE_TEXT = [
  'Attestation-target gate (ADR 0005 decision D1).',
  '',
  'USAGE',
  '  node scripts/eval/check-attestation-target.mjs [--cwd <dir>] [--json]',
  '',
  'Judges the commit at HEAD under the evidence-commit contract:',
  '  ordinary commit : the canonical record is self-consistent with its own',
  '                    commit AND that commit is an ancestor of HEAD. No parent',
  '                    binding is invented for ordinary commits; HEAD coverage',
  '                    is NOT claimed (the fingerprint jobs answer that).',
  '  evidence commit : trailer Attestation-Target: first-parent + record-only',
  '                    change set + non-merge + unmarked parent; the record must',
  '                    name exactly HEAD^1 and re-verify against it.',
  '',
  'Exit 0 = the commit passes its rule; exit 1 = a stable reason code names the',
  'failure (attestation-target-mismatch, attestation-evidence-impure,',
  'attestation-evidence-merge, attestation-evidence-stacked,',
  'attestation-record-missing, attestation-record-not-ancestor,',
  'attestation-marker-duplicated, attestation-marker-unsupported,',
  'attestation-record-not-committed, attestation-record-worktree-drift,',
  'attestation-content-mismatch).',
  'R-06: an evidence commit must judge its own committed record bytes',
  '(no blob at the path / worktree drift = fail); an ordinary commit only',
  'NOTES the worktree/HEAD comparison.'
].join('\n');

const isDirectExecution = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectExecution) {
  const rawArgv = process.argv.slice(2);
  /** @type {ReturnType<typeof parseArgs>} */
  let options;
  try {
    options = parseArgs(rawArgv);
  } catch (error) {
    // Print the stable reason code, not just the class name: CI greps for it.
    if (error instanceof GitEvidenceError) {
      console.error(`[attestation-target] ${error.code}: ${error.message}`);
    } else {
      console.error(
        `[attestation-target] ${error instanceof Error ? error.name : 'error'}: ` +
          String(error instanceof Error ? error.message : error)
      );
    }
    process.exit(1);
  }
  if (options.help) {
    console.log(USAGE_TEXT);
    process.exit(0);
  }
  try {
    const result = checkAttestationTarget({ cwd: options.cwd });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.ok) {
      console.log(humanLines(result).join('\n'));
    } else {
      // A FAIL summary is a diagnostic: it goes to stderr (like the lib-error
      // path), keeping stdout clean for a future machine consumer of the
      // human mode and matching `final-attestation.mjs`'s convention.
      console.error(humanLines(result).join('\n'));
    }
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    // Named failures (record missing, ref unresolvable, git failure) keep the
    // same JSON shape so a machine consumer sees a stable contract.
    if (error instanceof GitEvidenceError) {
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              mode: null,
              ref: 'HEAD',
              headCommitId: null,
              markerLines: [],
              recordedCommitId: null,
              parentCommitId: null,
              contentOk: false,
              targetOk: false,
              ok: false,
              failures: [{ code: error.code, detail: error.message }],
              notes: [],
              verifyNotes: []
            },
            null,
            2
          )
        );
      } else {
        console.error(`[attestation-target] ${error.code}: ${error.message}`);
      }
      process.exit(1);
    }
    throw error;
  }
}
