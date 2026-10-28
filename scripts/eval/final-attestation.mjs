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
 *        [--out <path>] [--allow-dirty] [--json]
 *   node scripts/eval/final-attestation.mjs --verify <file> [--ref <ref>]
 *
 * EXIT CODES
 *   0  manifest produced / recorded manifest verified
 *   1  evidence error (bad ref, non-ancestor base, dirty tree without
 *      --allow-dirty, encoding policy violation, git failure) OR verification
 *      mismatch
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

/** Parser kept deliberately small and strict: unknown flags are errors. */
function parseArgs(argv) {
  const options = {
    ref: 'HEAD',
    refExplicit: false,
    base: undefined,
    out: 'docs/reports/final-attestation.json',
    allowDirty: false,
    json: false,
    verify: undefined
  };
  const unknown = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--ref':
        options.ref = argv[++i];
        // An explicit ref is EVIDENCE (it says which revision was attested);
        // the implicit default is recorded as such instead of being implied.
        options.refExplicit = true;
        break;
      case '--base':
        options.base = argv[++i];
        break;
      case '--out':
        options.out = argv[++i];
        break;
      case '--verify':
        options.verify = argv[++i];
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
  if (unknown.length > 0) {
    throw new GitEvidenceError('unknown-argument', `unknown argument(s): ${unknown.join(' ')}`);
  }
  if (typeof options.ref !== 'string' || options.ref.length === 0) {
    throw new GitEvidenceError('ref-missing', '--ref requires a non-empty value');
  }
  if (options.verify !== undefined && (typeof options.verify !== 'string' || options.verify.length === 0)) {
    throw new GitEvidenceError('verify-missing', '--verify requires a path');
  }
  return options;
}

/**
 * Compute the attestation for one commit.
 *
 * @param {{ref?: string, refExplicit?: boolean, base?: string, allowDirty?: boolean}} [options]
 * @returns {any} core manifest + unhashed environment block
 */
export function generateAttestation(options = {}) {
  const ref = options.ref ?? 'HEAD';
  const allowDirty = options.allowDirty === true;

  // ---- 1/3: commit object authority + explicit ancestry ---------------------
  const target = resolveCommit(ref, rootDir);
  const base = options.base === undefined ? undefined : resolveCommit(options.base, rootDir);
  if (base !== undefined) {
    assertAncestor(base, target, rootDir);
  }

  // ---- 4: no silent worktree fallback --------------------------------------
  const trackedChanges = trackedWorktreeChanges(rootDir);
  if (trackedChanges.length > 0 && !allowDirty) {
    throw new GitEvidenceError(
      'dirty-worktree',
      'tracked working-tree changes present; an attestation must describe a commit. ' +
        'Commit/stash them, or pass --allow-dirty to record the defect explicitly.\n' +
        trackedChanges.join('\n')
    );
  }

  // ---- 2/5/6: raw blob bytes, core digest separated from environment --------
  const manifest = buildCanonicalManifest(target, rootDir, ATTESTED_ROOTS);

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
    git: gitVersion(rootDir),
    worktree: {
      trackedChanges: trackedChanges.length,
      trackedChangePaths: trackedChanges,
      allowDirty,
      dirtyAtGeneration: trackedChanges.length > 0,
      untracked: untrackedPaths(rootDir),
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
 * @param {string} recordedPath path to a JSON attestation
 * @returns {{ok: boolean, differences: string[], notes: string[], recorded: any, current: any, attributeLabelsCompared: boolean}}
 */
export function verifyAttestation(recordedPath) {
  const absolute = path.resolve(rootDir, recordedPath);
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
    allowDirty: true
  });

  // Attribute labels are commit-bound only when the commit actually contains a
  // `.gitattributes`. Commits that predate the policy carry no such file, so the
  // recorded labels are generation-time annotations; they are noted, not failed.
  const attributePolicy = readCommitBlobAtPath(current.commit, '.gitattributes', rootDir);
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
      const stillPoints = resolveCommit(recordedCommit.ref, rootDir);
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
  return { ok: differences.length === 0, differences, notes, recorded, current, attributeLabelsCompared };
}

const isDirectExecution = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectExecution) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
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
      const result = verifyAttestation(options.verify);
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              verified: result.ok,
              path: options.verify,
              commitId: result.recorded?.commit?.commitId,
              compositeSha256: result.recorded?.compositeSha256,
              bindingSha256: result.recorded?.bindingSha256,
              attributeLabelsCompared: result.attributeLabelsCompared,
              differences: result.differences,
              notes: result.notes
            },
            null,
            2
          )
        );
      } else if (result.ok) {
        console.log(`OK ${options.verify}: commit ${result.recorded.commit.commitId} matches the object database.`);
        console.log(`  compositeSha256: ${result.recorded.compositeSha256}`);
        console.log(`  bindingSha256:   ${result.recorded.bindingSha256 || '(absent: schema < 2.1.0)'}`);
        for (const note of result.notes) {
          console.log(`  ${note}`);
        }
      } else {
        console.error(`MISMATCH ${options.verify}: ${result.differences.length} difference(s)`);
        for (const difference of result.differences) {
          console.error(`  ${difference}`);
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
      const outputPath = path.resolve(rootDir, options.out);
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
        console.log(
          `Environment:       node ${manifest.environment.node} / ${manifest.environment.platform}-${manifest.environment.arch}`
        );
        console.log(`Worktree tracked:  ${manifest.environment.worktree.trackedChanges} change(s)`);
        console.log(`Output:            ${path.relative(rootDir, outputPath)}`);
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
