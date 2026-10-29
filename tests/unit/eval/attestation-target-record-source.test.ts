/**
 * R-06 — record-source binding for the attestation-target gate.
 *
 * The gate reads the canonical record from the WORKING TREE
 * (`readCanonicalRecord` / `verifyAttestation` use `fs.readFileSync`) while
 * every content check recomputes from the OBJECT DATABASE. On a clean checkout
 * (CI) the two agree byte for byte; on a dirty worktree they can disagree, and
 * then the gate would judge bytes that are not committed evidence.
 *
 * What is pinned here (all against REAL git fixtures and the REAL CLI, never a
 * mock):
 *  - evidence commit + clean worktree -> PASS, and the record-source note says
 *    the worktree bytes equal the HEAD blob;
 *  - evidence commit + drifted worktree record -> FAIL CLOSED with
 *    `attestation-record-worktree-drift` (the commit declared that its only
 *    content is this record, so uncommitted bytes invalidate the declaration);
 *    the CLI exit code is 1, proving fail-closed end to end;
 *  - ordinary commit keeps the documented "regenerate locally, commit later"
 *    posture (ADR 0005 §1.6.2): an uncommitted or reformatted worktree record is
 *    only NOTED (worktree/HEAD comparison), and the VERDICT is unchanged.
 *
 * The gate is driven as a CHILD PROCESS (`--json --cwd <fixture>`), exactly as
 * CI drives it, so the assertion covers the real exit-code contract too.
 * Each case spawns git + the real attestation generator, so the per-test budget
 * is above vitest's 5s default (measured 3.5-4.8s each on this machine).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const attestationCli = path.join(repoRoot, 'scripts', 'eval', 'final-attestation.mjs');
const gateCli = path.join(repoRoot, 'scripts', 'eval', 'check-attestation-target.mjs');
const MARKER = 'Attestation-Target: first-parent';
/**
 * The canonical record path (single source: `final-attestation.mjs`). Pinned as
 * a literal here because the JavaScript gate scripts ship no TypeScript
 * declaration for this constant; `final-attestation.node-test.mjs` asserts the
 * literal and the exported constant agree.
 */
const CANONICAL_RECORD_PATH = 'docs/reports/final-attestation.json';
/** Real git + generator work per case; above the 5s default on purpose. */
const CASE_TIMEOUT_MS = 60_000;

/** Temp repositories created by this suite; removed in afterAll. */
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** The structured result contract the gate's `--json` mode prints. */
interface GateResult {
  mode: 'ordinary' | 'evidence' | null;
  ok: boolean;
  targetOk: boolean;
  failures: { code: string; detail: string }[];
  notes: string[];
  verifyNotes: string[];
}

/** A scrubbed git environment, so an ambient GIT_DIR cannot redirect evidence. */
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

/** Run git in `cwd`, returning trimmed stdout. */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args.slice(), { cwd, encoding: 'utf8', env: gitEnv() }).trim();
}

/**
 * A throw-away repository with a `src/` tree (the attestation digest roots are
 * `src`, `tests`, `scripts`). `core.autocrlf=false` keeps the committed
 * bytes exactly what the fixture writes.
 */
function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-target-r06-'));
  tempDirs.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'fixture@example.invalid']);
  git(dir, ['config', 'user.name', 'R-06 fixture']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'src', 'b.ts'), 'export const b = 2;\n', 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'first']);
  return dir;
}

/** A code commit touching `src/`; returns the new HEAD id. */
function codeCommit(dir: string, message = 'code change'): string {
  const name = `c${Date.now()}-${Math.floor(Math.random() * 1e9)}.ts`;
  fs.writeFileSync(path.join(dir, 'src', name), `export const ${name.replace(/\W/g, '_')} = 3;\n`, 'utf8');
  git(dir, ['add', path.join('src', name)]);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

/** Generate the canonical record for the CURRENT HEAD into the canonical path. */
function generateCanonicalRecord(dir: string): void {
  const out = path.join(dir, CANONICAL_RECORD_PATH);
  execFileSync(process.execPath, [attestationCli, '--ref', 'HEAD', '--out', out, '--cwd', dir], {
    encoding: 'utf8',
    env: gitEnv()
  });
  expect(fs.existsSync(out)).toBe(true);
}

/** Commit the canonical record; `withMarker` makes it an evidence commit. */
function commitCanonicalRecord(dir: string, options: { withMarker?: boolean; message?: string } = {}): string {
  git(dir, ['add', CANONICAL_RECORD_PATH]);
  const message = options.withMarker
    ? `record update\n\n${MARKER}`
    : (options.message ?? 'commit the canonical record');
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

/** The canonical evidence topology: C (code) -> record for C -> E (marker). */
function makeEvidencePair(dir: string): { c: string; e: string } {
  const c = codeCommit(dir, 'code commit C');
  generateCanonicalRecord(dir);
  const e = commitCanonicalRecord(dir, { withMarker: true });
  return { c, e };
}

/**
 * Run the real CLI against a fixture. The exit code and the JSON `ok` flag are
 * asserted to agree: a named failure must never exit 0.
 */
function runGate(dir: string): { status: number | null; result: GateResult; raw: string } {
  const run = spawnSync(process.execPath, [gateCli, '--json', '--cwd', dir], {
    encoding: 'utf8',
    env: gitEnv()
  });
  const raw = String(run.stdout ?? '');
  let result: GateResult;
  try {
    result = JSON.parse(raw) as GateResult;
  } catch {
    throw new Error('the gate did not print a JSON result: ' + raw + String(run.stderr ?? ''));
  }
  expect(run.status).toBe(result.ok ? 0 : 1);
  return { status: run.status, result, raw };
}

describe('R-06: the judged record bytes are bound to the judged commit', () => {
  it(
    'evidence commit on a clean worktree passes and notes the blob binding',
    () => {
      const dir = makeRepo();
      makeEvidencePair(dir);
      const { result } = runGate(dir);
      expect(result.ok).toBe(true);
      expect(result.mode).toBe('evidence');
      expect(result.failures).toEqual([]);
      // The worktree bytes equal the judged commit's blob.
      expect(result.notes.some((note) => note.startsWith('record source: worktree bytes == HEAD blob'))).toBe(true);
    },
    CASE_TIMEOUT_MS
  );

  it(
    'evidence commit with a drifted worktree record FAILS CLOSED (attestation-record-worktree-drift)',
    () => {
      const dir = makeRepo();
      makeEvidencePair(dir);
      // Drift the working-tree copy AFTER the record commit: the commit still
      // contains exactly the record (T3 purity holds), but the bytes the gate
      // reads are no longer the committed ones.
      const record = JSON.parse(fs.readFileSync(path.join(dir, CANONICAL_RECORD_PATH), 'utf8')) as {
        schemaVersion: string;
        commit: { commitId: string };
      };
      record.schemaVersion = '0.0.0-drifted';
      fs.writeFileSync(path.join(dir, CANONICAL_RECORD_PATH), JSON.stringify(record, null, 2) + '\n', 'utf8');
      const { status, result } = runGate(dir);
      expect(result.ok).toBe(false);
      expect(status).toBe(1); // fail-closed end to end
      const drift = result.failures.find((failure) => failure.code === 'attestation-record-worktree-drift');
      expect(drift).toBeDefined();
      expect(drift?.detail).toContain('worktree sha256=');
      expect(drift?.detail).toContain('committed blob');
      expect(result.targetOk).toBe(false);
    },
    CASE_TIMEOUT_MS
  );

  it(
    'evidence commit that does not carry the record FAILS CLOSED (attestation-record-not-committed)',
    () => {
      const dir = makeRepo();
      // Topology: C (code) -> record commit (ordinary) -> evidence commit that
      // DELETES the record. The evidence commit's change set is still exactly
      // the canonical path (a deletion), so T3 purity holds; the worktree copy
      // is restored afterwards, so T6's readability check also passes. What must
      // NOT pass is judging bytes the evidence commit does not contain.
      codeCommit(dir, 'code commit C');
      generateCanonicalRecord(dir);
      commitCanonicalRecord(dir);
      const recordBytes = fs.readFileSync(path.join(dir, CANONICAL_RECORD_PATH));
      git(dir, ['rm', '-q', CANONICAL_RECORD_PATH]);
      git(dir, ['commit', '-q', '-m', 'remove the record\n\n' + MARKER]);
      // Restore the working-tree copy only (the commit still has no blob here).
      fs.mkdirSync(path.dirname(path.join(dir, CANONICAL_RECORD_PATH)), { recursive: true });
      fs.writeFileSync(path.join(dir, CANONICAL_RECORD_PATH), recordBytes);
      const { status, result } = runGate(dir);
      expect(result.mode).toBe('evidence');
      expect(result.ok).toBe(false);
      expect(status).toBe(1);
      const notCommitted = result.failures.find((failure) => failure.code === 'attestation-record-not-committed');
      expect(notCommitted).toBeDefined();
      expect(notCommitted?.detail).toContain('has no');
      expect(notCommitted?.detail).toContain('blob');
    },
    CASE_TIMEOUT_MS
  );

  it(
    'ordinary commit keeps the regenerate-locally posture: an uncommitted record is a NOTE, not a failure',
    () => {
      const dir = makeRepo();
      generateCanonicalRecord(dir); // records the first commit
      codeCommit(dir, 'code commit after the record');
      // The record exists ONLY in the worktree now (ADR 0005 §1.6.2 posture):
      // HEAD has no record blob at all.
      const { result } = runGate(dir);
      expect(result.mode).toBe('ordinary');
      // The comparison is surfaced, by name.
      expect(result.notes.some((note) => note.startsWith('record source: NOT committed at'))).toBe(true);
      // ...and the VERDICT is unchanged (self-consistency + ancestry still hold).
      expect(result.ok).toBe(true);
      expect(result.failures).toEqual([]);
    },
    CASE_TIMEOUT_MS
  );

  it(
    'ordinary commit with a reformatted worktree record keeps its verdict (observation only)',
    () => {
      const dir = makeRepo();
      codeCommit(dir);
      generateCanonicalRecord(dir);
      commitCanonicalRecord(dir);
      // Cosmetic-only rewrite: same parsed content, different bytes -> the gate
      // must NOTE the drift WITHOUT changing the ordinary verdict.
      const record = fs.readFileSync(path.join(dir, CANONICAL_RECORD_PATH), 'utf8');
      fs.writeFileSync(path.join(dir, CANONICAL_RECORD_PATH), record.replace(/\n/g, '\r\n'), 'utf8');
      const { result } = runGate(dir);
      expect(result.mode).toBe('ordinary');
      expect(result.notes.some((note) => note.startsWith('record source: worktree sha256='))).toBe(true);
      // No verdict change: the ordinary rule still holds (self-consistency +
      // ancestry), exactly as before R-06.
      expect(result.ok).toBe(true);
    },
    CASE_TIMEOUT_MS
  );
});
