#!/usr/bin/env node
/**
 * Commit attestation (PR-1 rewrite).
 *
 * WHAT CHANGED FROM THE PRE-PR-1 VERSION
 * --------------------------------------
 * The old script hashed the WORKING TREE (`fs.readFileSync`) and described the
 * code surface with `git diff` (also the working tree). Both are unreproducible
 * across line-ending settings: with `core.autocrlf=true` the worktree carries
 * CRLF while the object database carries LF, so identical commits digest
 * differently. ADR 0003's appendix is the recorded casualty (14 of 15 digests
 * are CRLF worktree digests; see `work/t1-baseline-audit.md` §5 F-1). The old
 * script also warned-and-continued on every git failure, so a broken repository
 * produced a manifest full of empty-string digests that looked like evidence.
 *
 * This version implements the PR-1 rules:
 *   1. commit object authority  - digests anchor to `<ref>^{commit}` AND its
 *      root tree `<commit>^{tree}`; a ref that names a tree is rejected;
 *   2. raw blob bytes           - content via `git cat-file --batch`, never `fs`
 *      on repository content (only the output file is written with `fs`);
 *   3. explicit ref + base      - the ref used is recorded (`refExplicit`),
 *      `--base` is ancestry-verified with `git merge-base --is-ancestor`;
 *   4. no silent worktree fallback - a dirty tracked tree fails unless
 *      `--allow-dirty` is passed, and it is then recorded as a defect flag in
 *      the environment block (never in the digest);
 *   5. core vs environment split - `compositeSha256` covers `path:blobSha256`
 *      lines; `bindingSha256` covers commit+tree+composite; node/platform/arch,
 *      timestamps and worktree state live in `environment`, unhashed;
 *   6. re-verifiable - `--verify <file>` recomputes from the object database and
 *      fails on ANY non-environment difference: commit/tree identity, recorded
 *      base and ancestry, roots, file count, per-file blob id / mode / bytes /
 *      sha256 / encoding / exception flag, the encoding policy block and the
 *      digest ALGORITHM itself. An attestation nobody can re-check is a claim.
 *      `declaredEol` / `declaredTextUnset` are attribute labels: they are
 *      compared when the attested commit contains a `.gitattributes`, because
 *      only then is there a commit-bound answer (see `--verify` notes).
 *   7. explicit TARGET          - `--expect-commit <40-hex>` (generate or
 *      verify) and `--strict` (verify) make the question "is this record about
 *      the revision I mean?" answerable instead of assumed. Re-verifying an old
 *      record proves only that the record is internally consistent with its own
 *      commit; without a target check, a stale record verifies green forever.
 *   8. gate-constrained record path - `CANONICAL_RECORD_PATH` names the ONE
 *      record the attestation-target gate (ADR 0005 decision D1) constrains.
 *      It is exported so `scripts/eval/check-attestation-target.mjs` reuses
 *      this module's constant instead of copying the path (single source of
 *      truth), and it is the default `--out` of generate mode, so "what
 *      `pnpm run attest` writes" and "what the gate reads" agree by
 *      construction. A record stored under any other name carries no gate
 *      meaning (ADR 0005 §1.2/§1.6.5).
 *
 * SELF-REFERENCE BOUNDARY (why a record cannot cover its own commit)
 * ------------------------------------------------------------------
 *   A record can only describe the commit it was generated FROM. If you commit
 *   the record, the commit that CONTAINS it is not covered by it: covering that
 *   commit would require its digest to include the record's own bytes, which
 *   contain the digest. Consequently:
 *     - "the repository contains docs/reports/final-attestation.json" does NOT
 *       mean "HEAD is attested"; the record names the commit it was made from.
 *     - `--verify` (no target flags) answers "does the recorded evidence still
 *       describe its own commit?" - the honest historical question. Add
 *       `--expect-commit <sha>` or `--strict` to ask "does it describe THIS
 *       revision?", which is the question a release gate actually has.
 *   No target SHA is ever fabricated, backfilled or rewritten: the target checks
 *   compare recorded vs requested and FAIL on a mismatch.
 *
 * ENCODING POLICY
 *   Every digested blob must be plain LF text unless THE ATTESTED COMMIT's
 *   `.gitattributes` declares it `-text` (answers come from
 *   `git check-attr --source=<commit>`, or from the commit tree on git < 2.40).
 *   A CRLF or BOM fixture that is not declared is a hard error
 *   (`encoding-policy-violation`) rather than a silently unstable digest.
 *   An untracked or modified worktree `.gitattributes` cannot change the result,
 *   and a bare clone re-checks identically. Declared exceptions are listed in
 *   `encoding.exceptions` and in each record.
 *
 * USAGE
 *   node scripts/eval/final-attestation.mjs [--ref <ref>] [--base <ref>]
 *        [--expect-commit <40-hex>] [--out <path>] [--allow-dirty] [--json] [--cwd <dir>]
 *   node scripts/eval/final-attestation.mjs --verify <file> [--expect-commit <40-hex>] [--strict] [--cwd <dir>]
 *   node scripts/eval/final-attestation.mjs --help
 *
 * EXIT CODES
 *   0  manifest produced / recorded manifest verified (and, when a target was
 *      requested, the target matches)
 *   1  evidence error (bad ref, non-ancestor base, dirty tree without
 *      --allow-dirty, encoding policy violation, git failure), verification
 *      mismatch, target mismatch (`attestation-target-mismatch`), HEAD mismatch
 *      under `--strict` (`attestation-head-mismatch`), or an invalid/unknown
 *      argument
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GitEvidenceError,
  assertAncestor,
  buildCanonicalManifest,
  compareManifests,
  gitVersion,
  readCommitBlobAtPath,
  resolveCommit,
  trackedWorktreeChanges,
  untrackedPaths
} from './lib/git-objects.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

/** Roots that enter the digest. Kept here so CLI, tests and CI agree. */
export const ATTESTED_ROOTS = Object.freeze(['src', 'tests', 'scripts']);

/**
 * The ONE record the attestation-target gate (ADR 0005 decision D1) constrains,
 * POSIX-relative to the repository root.
 *
 * Exported as the single source of truth for `check-attestation-target.mjs`,
 * which must not write its own copy of the path. It intentionally equals the
 * generate-mode `--out` default, so the record `pnpm run attest` produces is
 * the record the gate reads. Records under any other name are NOT attestation
 * evidence for gate purposes (ADR 0005 §1.2 canonical-path rule).
 *
 * @type {'docs/reports/final-attestation.json'}
 */
export const CANONICAL_RECORD_PATH = 'docs/reports/final-attestation.json';

/**
 * The only marker value the evidence-commit rule accepts (ADR 0005 §1.2/D1).
 *
 * Exported for the same reason: the checker and the tests must compare against
 * this constant, never against a hand-typed string that could drift.
 *
 * @type {'first-parent'}
 */
export const ATTESTATION_TARGET_MARKER = 'Attestation-Target: first-parent';

const COMMIT_HEX = /^[0-9a-f]{40}$/;

/**
 * Validate a target commit argument.
 *
 * Deliberately strict and separate from resolution: `--expect-commit` is a
 * TARGET, so a branch name or an abbreviated SHA is not acceptable - a target
 * that can move or collide is not a target. A full 40-hex id is required.
 *
 * @param {unknown} value
 * @param {string} flag
 * @returns {string}
 */
function requireFullCommitId(value, flag) {
  if (typeof value !== 'string' || !COMMIT_HEX.test(value)) {
    throw new GitEvidenceError(
      'expect-commit-invalid',
      `${flag} requires a full 40-hex commit id (a target must not be a moving ref or an abbreviation), got ${JSON.stringify(value)}`
    );
  }
  return value;
}

/**
 * Parser kept deliberately small and strict: unknown flags are errors.
 *
 * A flag whose VALUE is missing is an error too. Before this, `--expect-commit`
 * or `--verify` as the last argument left the option `undefined`, so the run
 * silently degraded to "no target check" / "generate a fresh record" - a
 * fail-open in exactly the place a target check is supposed to fail closed.
 */
function parseArgs(argv) {
  const options = {
    ref: 'HEAD',
    refExplicit: false,
    base: undefined,
    out: 'docs/reports/final-attestation.json',
    allowDirty: false,
    json: false,
    verify: undefined,
    expectCommit: undefined,
    strict: false,
    cwd: rootDir
  };
  const unknown = [];
  /** @type {string[]} */
  const missingValue = [];
  /** Read the value of a value-taking flag, recording a missing one. */
  const valueOf = (flag, index) => {
    const value = argv[index + 1];
    if (value === undefined) {
      missingValue.push(flag);
      return undefined;
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--ref':
        options.ref = valueOf(arg, i);
        // An explicit ref is EVIDENCE (it says which revision was attested);
        // the implicit default is recorded as such instead of being implied.
        options.refExplicit = true;
        i += 1;
        break;
      case '--base':
        options.base = valueOf(arg, i);
        i += 1;
        break;
      case '--out':
        options.out = valueOf(arg, i);
        i += 1;
        break;
      case '--verify':
        options.verify = valueOf(arg, i);
        i += 1;
        break;
      case '--expect-commit':
        options.expectCommit = valueOf(arg, i);
        i += 1;
        break;
      case '--cwd':
        // Evidence root. Defaults to the repository this script ships in, so the
        // documented invocations are unchanged; an explicit value lets a reviewer
        // (or a test) point the same rules at another clone without copying files.
        options.cwd = valueOf(arg, i);
        i += 1;
        break;
      case '--strict':
        options.strict = true;
        break;
      case '--allow-dirty':
        options.allowDirty = true;
        break;
      case '--json':
        options.json = true;
        break;
      default:
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
  if (typeof options.ref !== 'string' || options.ref.length === 0) {
    throw new GitEvidenceError('ref-missing', '--ref requires a non-empty value');
  }
  if (typeof options.cwd !== 'string' || options.cwd.length === 0) {
    throw new GitEvidenceError('cwd-missing', '--cwd requires a non-empty directory path');
  }
  if (options.verify !== undefined && (typeof options.verify !== 'string' || options.verify.length === 0)) {
    throw new GitEvidenceError('verify-missing', '--verify requires a path');
  }
  if (options.expectCommit !== undefined) {
    requireFullCommitId(options.expectCommit, '--expect-commit');
  }
  // `--ref` used to be silently IGNORED under `--verify` (the record's own
  // commit was always re-checked), which made `--verify x --ref HEAD` look like
  // a target check while checking nothing. Refuse the combination instead of
  // pretending: `--verify` + `--expect-commit` is the supported target form.
  if (options.verify !== undefined && options.refExplicit) {
    throw new GitEvidenceError(
      'verify-ref-conflict',
      '--ref selects the revision to ATTEST (generate mode); it is not a target check and is not honoured with --verify. ' +
        'Use --verify <file> --expect-commit <40-hex> to require a specific revision, or --strict to require HEAD.'
    );
  }
  if (options.strict && options.verify === undefined) {
    throw new GitEvidenceError(
      'strict-requires-verify',
      '--strict is a verification target check (it requires the record to describe the checked-out HEAD); it has no meaning while generating. ' +
        'Use --expect-commit <40-hex> to require a target at generation time.'
    );
  }
  return options;
}

/**
 * Compute the attestation for one commit.
 *
 * `cwd` exists so a test (or a reviewer with a second clone) can point the same
 * code at another repository. It defaults to the repository this script ships
 * in, so the CLI behaves exactly as before.
 *
 * @param {{ref?: string, refExplicit?: boolean, base?: string, allowDirty?: boolean, expectCommit?: string, cwd?: string}} [options]
 * @returns {any} core manifest + unhashed environment block
 */
export function generateAttestation(options = {}) {
  const ref = options.ref ?? 'HEAD';
  const allowDirty = options.allowDirty === true;
  const cwd = options.cwd ?? rootDir;

  // ---- 1/3: commit object authority + explicit ancestry ---------------------
  const target = resolveCommit(ref, cwd);
  const expectCommit =
    options.expectCommit === undefined ? undefined : requireFullCommitId(options.expectCommit, '--expect-commit');
  // Fail fast on a wrong target, BEFORE doing the expensive work: attesting a
  // revision nobody asked for produces a perfectly valid record of the wrong
  // thing, which is worse than no record.
  if (expectCommit !== undefined && target.commitId !== expectCommit) {
    throw new GitEvidenceError(
      'attestation-target-mismatch',
      `--ref ${JSON.stringify(target.ref)} resolved to ${target.commitId}, but --expect-commit is ${expectCommit}; ` +
        'refusing to attest a revision that is not the requested target'
    );
  }
  const base = options.base === undefined ? undefined : resolveCommit(options.base, cwd);
  if (base !== undefined) {
    assertAncestor(base, target, cwd);
  }

  // ---- 4: no silent worktree fallback --------------------------------------
  const trackedChanges = trackedWorktreeChanges(cwd);
  if (trackedChanges.length > 0 && !allowDirty) {
    throw new GitEvidenceError(
      'dirty-worktree',
      'tracked working-tree changes present; an attestation must describe a commit. ' +
        'Commit/stash them, or pass --allow-dirty to record the defect explicitly.\n' +
        trackedChanges.join('\n')
    );
  }

  // ---- 2/5/6: raw blob bytes, core digest separated from environment --------
  const manifest = buildCanonicalManifest(target, cwd, ATTESTED_ROOTS);

  const core = {
    schemaVersion: '2.1.0',
    kind: 'commit-attestation',
    commit: {
      ref: target.ref,
      refExplicit: options.refExplicit === true,
      commitId: target.commitId,
      treeId: target.treeId,
      base:
        base === undefined
          ? null
          : {
              ref: base.ref,
              commitId: base.commitId,
              treeId: base.treeId,
              ancestryVerified: true,
              method: 'git merge-base --is-ancestor'
            }
    },
    algorithm: manifest.algorithm,
    encoding: manifest.encoding,
    roots: manifest.roots,
    fileCount: manifest.fileCount,
    compositeSha256: manifest.compositeSha256,
    bindingSha256: manifest.bindingSha256,
    files: manifest.files
  };

  // Environment is metadata ONLY. It never enters compositeSha256 or
  // bindingSha256, so the same commit attests identically on Windows, Linux and
  // macOS - and cross-OS evidence can be compared by digest alone.
  const environment = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    git: gitVersion(cwd),
    worktree: {
      trackedChanges: trackedChanges.length,
      trackedChangePaths: trackedChanges,
      allowDirty,
      dirtyAtGeneration: trackedChanges.length > 0,
      untracked: untrackedPaths(cwd),
      note: 'worktree facts are recorded for audit only and are NOT part of compositeSha256/bindingSha256'
    }
  };

  return { ...core, environment };
}

/**
 * Recompute the attestation and compare it with a recorded one.
 *
 * The RECORDED COMMIT ID is what gets recomputed, not whatever the recorded ref
 * points at today: a branch is a moving label, and an old attestation must stay
 * checkable after `main` has advanced. If the recorded ref no longer resolves to
 * the recorded commit, that is reported as an informational `notes` entry (the
 * branch moved, which is normal) rather than as a mismatch - only a difference
 * inside the evidence itself is a failure.
 *
 * TARGET CHECKS (`--expect-commit` / `--strict`) are a SEPARATE axis from that
 * content comparison, and both must hold for `ok`:
 *   - `expectCommit`  the record must name exactly this commit. This is the only
 *     way to distinguish "verified" from "verified the wrong thing": a stale
 *     record is internally consistent and passes content comparison forever.
 *   - `strict`        the record must describe the checked-out HEAD. This is the
 *     release-gate question ("is the tree I am about to ship attested?").
 * Neither check rewrites the record; a mismatch is reported with both sides and
 * the caller decides. Plain `--verify` (no target) keeps the historical
 * self-consistency semantics that `pnpm run attest:verify` relies on.
 *
 * A recorded `base` is recomputed too (its commit is re-resolved and its
 * ancestry re-verified), so "base was an ancestor when this was generated" is
 * evidence a verifier can re-derive rather than a free-text claim.
 *
 * `.gitattributes` is read from the ATTESTED COMMIT. When that commit has no
 * committed policy file, the record's per-file attribute labels (`declaredEol`,
 * `declaredTextUnset`) cannot be re-derived from the commit alone; they are
 * reported as a note and not compared. Every declaration-independent field is
 * still compared strictly.
 *
 * @param {string} recordedPath path to a JSON attestation (resolved against `cwd`)
 * @param {{expectCommit?: string, strict?: boolean, cwd?: string}} [options]
 * @returns {{ok: boolean, contentOk: boolean, differences: string[], targetMismatches: {code: string, detail: string}[], targetChecks: {expectCommit: {expected: string, actual: string, ok: boolean} | null, strict: {headCommitId: string | null, actual: string, ok: boolean} | null}, headCommitId: string | undefined, notes: string[], recorded: any, current: any, attributeLabelsCompared: boolean}}
 */
export function verifyAttestation(recordedPath, options = {}) {
  const cwd = options.cwd ?? rootDir;
  const strict = options.strict === true;
  const expectCommit =
    options.expectCommit === undefined ? undefined : requireFullCommitId(options.expectCommit, '--expect-commit');
  const absolute = path.resolve(cwd, recordedPath);
  const recorded = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  const recordedCommit = recorded?.commit ?? {};
  if (typeof recordedCommit.commitId !== 'string') {
    throw new GitEvidenceError('record-shape-invalid', `${recordedPath} has no commit.commitId`);
  }
  /** @type {string[]} */
  const notes = [];
  const recordedBaseId =
    recordedCommit.base !== null &&
    typeof recordedCommit.base === 'object' &&
    typeof recordedCommit.base.commitId === 'string'
      ? recordedCommit.base.commitId
      : undefined;
  const current = generateAttestation({
    ref: recordedCommit.commitId,
    refExplicit: false,
    ...(recordedBaseId === undefined ? {} : { base: recordedBaseId }),
    allowDirty: true,
    cwd
  });

  // Attribute labels are commit-bound only when the commit actually contains a
  // `.gitattributes`. Commits that predate the policy carry no such file, so the
  // recorded labels are generation-time annotations; they are noted, not failed.
  const attributePolicy = readCommitBlobAtPath(current.commit, '.gitattributes', cwd);
  const attributeLabelsCompared = attributePolicy !== null;
  if (!attributeLabelsCompared) {
    notes.push(
      `informational: commit ${recordedCommit.commitId} has no committed .gitattributes; ` +
        'per-file declaredEol/declaredTextUnset labels are not commit-bound and are not compared'
    );
  }

  const comparison = compareManifests(recorded, current, { compareAttributeLabels: attributeLabelsCompared });
  /** @type {string[]} */
  const differences = [...comparison.differences];
  if (typeof recordedCommit.ref === 'string' && recordedCommit.ref.length > 0) {
    try {
      const stillPoints = resolveCommit(recordedCommit.ref, cwd);
      if (stillPoints.commitId !== recordedCommit.commitId) {
        notes.push(
          `informational: ref '${recordedCommit.ref}' now resolves to ${stillPoints.commitId}, ` +
            `not the recorded ${recordedCommit.commitId} (the branch moved; the record was re-checked against its own commit id)`
        );
      }
    } catch {
      notes.push(`informational: ref '${recordedCommit.ref}' no longer resolves in this repository`);
    }
  }

  // ---- target checks: separate axis, both must hold for `ok` ---------------
  /** @type {{code: string, detail: string}[]} */
  const targetMismatches = [];
  /** @type {{expectCommit: {expected: string, actual: string, ok: boolean} | null, strict: {headCommitId: string | null, actual: string, ok: boolean} | null}} */
  const targetChecks = { expectCommit: null, strict: null };

  if (expectCommit !== undefined) {
    const matches = recordedCommit.commitId === expectCommit;
    targetChecks.expectCommit = { expected: expectCommit, actual: recordedCommit.commitId, ok: matches };
    if (!matches) {
      targetMismatches.push({
        code: 'attestation-target-mismatch',
        detail:
          `the record attests commit ${recordedCommit.commitId}, but --expect-commit is ${expectCommit}; ` +
          'an older record is not evidence about a newer (or different) target'
      });
    }
  }

  /** @type {string | undefined} */
  let headCommitId;
  try {
    headCommitId = resolveCommit('HEAD', cwd).commitId;
  } catch {
    headCommitId = undefined;
  }
  if (strict) {
    const matchesHead = headCommitId !== undefined && headCommitId === recordedCommit.commitId;
    targetChecks.strict = { headCommitId: headCommitId ?? null, actual: recordedCommit.commitId, ok: matchesHead };
    if (!matchesHead) {
      targetMismatches.push({
        code: 'attestation-head-mismatch',
        detail:
          `--strict requires the record to describe the checked-out HEAD (${headCommitId ?? 'HEAD does not resolve in this repository'}), ` +
          `but the record attests ${recordedCommit.commitId}; a record never covers the commit that contains it, so the checked-out revision is NOT attested`
      });
    }
  } else if (headCommitId !== undefined && headCommitId !== recordedCommit.commitId) {
    // The plain-verify path stays honest without failing: say what it did NOT check.
    notes.push(
      `informational: HEAD is ${headCommitId}, not the recorded ${recordedCommit.commitId}; ` +
        'this check re-derived the recorded commit only and does NOT cover the checked-out revision ' +
        '(pass --strict, or --expect-commit <sha>, to require a target)'
    );
  }

  return {
    ok: differences.length === 0 && targetMismatches.length === 0,
    contentOk: differences.length === 0,
    differences,
    targetMismatches,
    targetChecks,
    headCommitId,
    notes,
    recorded,
    current,
    attributeLabelsCompared
  };
}

/** Help text. Kept in one place so `--help` cannot drift from the header. */
export function attestationUsageText() {
  return [
    'Commit attestation (PR-1: raw blob bytes, re-verifiable).',
    '',
    'USAGE',
    '  node scripts/eval/final-attestation.mjs [--ref <ref>] [--base <ref>]',
    '       [--expect-commit <40-hex>] [--out <path>] [--allow-dirty] [--json] [--cwd <dir>]',
    '  node scripts/eval/final-attestation.mjs --verify <file> [--expect-commit <40-hex>] [--strict] [--cwd <dir>]',
    '',
    '  --cwd <dir>             evidence root (default: the repository this script ships in)',
    '',
    'GENERATE',
    '  --ref <ref>             revision to attest (default HEAD; recorded as refExplicit)',
    '  --base <ref>            ancestry-verified base, recorded in the manifest',
    '  --expect-commit <sha>   refuse to generate unless --ref resolves to exactly this commit',
    '  --allow-dirty           record a dirty tracked tree as a defect flag (never in the digest)',
    '',
    'VERIFY',
    '  --verify <file>         recompute the record from the object database and compare',
    '  --expect-commit <sha>   require the record to name exactly this commit; a mismatch',
    '                          exits 1 with `attestation-target-mismatch`',
    '  --strict                require the record to describe the checked-out HEAD; a',
    '                          mismatch exits 1 with `attestation-head-mismatch`',
    '',
    'SELF-REFERENCE BOUNDARY (read this before trusting a record)',
    '  A record can only describe the commit it was generated FROM. Committing the',
    '  record does NOT extend coverage: the commit that contains it is not covered,',
    '  because its digest would have to include the record bytes that contain the',
    '  digest. So "the repo contains an attestation" never means "HEAD is attested".',
    '  Plain --verify proves the record is consistent with ITS OWN commit; add',
    '  --expect-commit or --strict to prove it is about the revision you mean.',
    '  A target SHA is never fabricated, backfilled or rewritten: the target checks',
    '  compare recorded vs requested and fail on a mismatch.',
    '',
    'EXIT CODES',
    '  0  manifest produced / recorded manifest verified, and any requested target matched',
    '  1  evidence error, content mismatch, target mismatch, HEAD mismatch under --strict,',
    '     or an invalid/unknown argument'
  ].join('\n');
}

const isDirectExecution = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectExecution) {
  const rawArgv = process.argv.slice(2);
  if (rawArgv.includes('--help') || rawArgv.includes('-h')) {
    console.log(attestationUsageText());
    process.exit(0);
  }
  let options;
  try {
    options = parseArgs(rawArgv);
  } catch (error) {
    // Print the stable reason code, not just the class name: CI greps for it.
    if (error instanceof GitEvidenceError) {
      console.error(`[attestation] ${error.code}: ${error.message}`);
    } else {
      console.error(`[attestation] ${error instanceof Error ? error.name : 'error'}: ${String(error instanceof Error ? error.message : error)}`);
    }
    process.exit(1);
  }

  if (options.verify !== undefined) {
    try {
      const result = verifyAttestation(options.verify, {
        ...(options.expectCommit === undefined ? {} : { expectCommit: options.expectCommit }),
        strict: options.strict,
        cwd: options.cwd
      });
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              verified: result.ok,
              contentVerified: result.contentOk,
              path: options.verify,
              commitId: result.recorded?.commit?.commitId,
              compositeSha256: result.recorded?.compositeSha256,
              bindingSha256: result.recorded?.bindingSha256,
              headCommitId: result.headCommitId ?? null,
              targetChecks: result.targetChecks,
              targetMismatches: result.targetMismatches,
              attributeLabelsCompared: result.attributeLabelsCompared,
              differences: result.differences,
              notes: result.notes
            },
            null,
            2
          )
        );
      } else if (result.contentOk && result.targetMismatches.length === 0) {
        console.log(`OK ${options.verify}: commit ${result.recorded.commit.commitId} matches the object database.`);
        console.log(`  compositeSha256: ${result.recorded.compositeSha256}`);
        console.log(`  bindingSha256:   ${result.recorded.bindingSha256 || '(absent: schema < 2.1.0)'}`);
        if (result.targetChecks.expectCommit !== null) {
          console.log(`  target:          ${result.targetChecks.expectCommit.expected} (--expect-commit matched)`);
        }
        if (result.targetChecks.strict !== null) {
          console.log(`  strict:          HEAD ${result.targetChecks.strict.headCommitId} is the attested commit`);
        }
        for (const note of result.notes) {
          console.log(`  ${note}`);
        }
      } else if (!result.contentOk) {
        console.error(`MISMATCH ${options.verify}: ${result.differences.length} difference(s)`);
        for (const difference of result.differences) {
          console.error(`  ${difference}`);
        }
        for (const mismatch of result.targetMismatches) {
          console.error(`[attestation] ${mismatch.code}: ${mismatch.detail}`);
        }
      } else {
        // Content is self-consistent, but the record is about a different
        // revision than the one that was requested: say so, and name both sides.
        console.error(`TARGET MISMATCH ${options.verify}: ${result.targetMismatches.length} target check(s) failed`);
        for (const mismatch of result.targetMismatches) {
          console.error(`[attestation] ${mismatch.code}: ${mismatch.detail}`);
        }
        for (const note of result.notes) {
          console.error(`  ${note}`);
        }
      }
      if (!result.ok) {
        process.exit(1);
      }
    } catch (error) {
      if (error instanceof GitEvidenceError) {
        console.error(`[attestation] ${error.code}: ${error.message}`);
      } else {
        console.error('[attestation] verification failed:', error);
      }
      process.exit(1);
    }
  } else {
    try {
      const manifest = generateAttestation(options);
      // The output path is relative to the evidence root, so `--cwd <clone>`
      // writes into that clone instead of this checkout.
      const outputPath = path.resolve(options.cwd, options.out);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

      if (options.json) {
        console.log(JSON.stringify(manifest, null, 2));
      } else {
        console.log('=== Commit Attestation (PR-1: raw blob bytes) ===');
        console.log(`Ref:               ${manifest.commit.ref}${manifest.commit.refExplicit ? '' : ' (implicit default)'}`);
        console.log(`Commit:            ${manifest.commit.commitId}`);
        console.log(`Tree:              ${manifest.commit.treeId}`);
        if (manifest.commit.base !== null) {
          console.log(`Base:              ${manifest.commit.base.commitId} (ancestor verified)`);
        }
        console.log(`Files:             ${manifest.fileCount} (${manifest.roots.join(' + ')})`);
        console.log(`Composite SHA-256: ${manifest.compositeSha256}`);
        console.log(`Binding SHA-256:   ${manifest.bindingSha256}`);
        if (manifest.encoding.exceptionCount > 0) {
          console.log(`Encoding excepts:  ${manifest.encoding.exceptionCount} declared '-text' path(s)`);
        }
        if (options.expectCommit !== undefined) {
          console.log(`Target:            ${options.expectCommit} (--expect-commit matched)`);
        }
        console.log(
          `Environment:       node ${manifest.environment.node} / ${manifest.environment.platform}-${manifest.environment.arch}`
        );
        console.log(`Worktree tracked:  ${manifest.environment.worktree.trackedChanges} change(s)`);
        console.log(`Output:            ${path.relative(options.cwd, outputPath)}`);
        console.log(
          'Note:              this record describes the commit above only. Once committed it does NOT cover the commit that contains it; ' +
            'verify a target with --expect-commit <sha> or --strict.'
        );
      }
    } catch (error) {
      if (error instanceof GitEvidenceError) {
        console.error(`[attestation] ${error.code}: ${error.message}`);
      } else {
        console.error('[attestation] unexpected error:', error);
      }
      process.exit(1);
    }
  }
}
