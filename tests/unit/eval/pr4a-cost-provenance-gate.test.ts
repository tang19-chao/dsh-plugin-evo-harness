/**
 * P3-C: the PR-4A cost/token provenance gate must PROVE a measurement claim,
 * not forbid measurement forever.
 *
 * The frozen artifact predates a tokenizer and carries no capability
 * declaration, so the historical judgement is unchanged: measured count 0 and no
 * field may claim precision 'measured'. A future artifact that really can
 * measure declares `measurement: { tokenizer: true }`; only then may measured
 * data appear, and then it MUST appear (zero measured calls under a declaration
 * is a broken capture, never a silent pass).
 *
 * TEST INPUTS ARE TRACKED (rev5 P0-1). The inputs used to live in the gitignored
 * `work/` scratch directory, so a clean checkout failed all five cases with
 * `ENOENT … work/pr4a-five-arm-eval.json`. They now live in
 * `tests/fixtures/pr4a/`, described by `fixture-manifest.json` with a per-file
 * sha256. The manifest is the CONTRACT, not documentation: every listed file is
 * read from disk, its size and sha256 are re-measured, and any mismatch (or a
 * missing file) THROWS. A missing input is never a skip, a `return` or an
 * empty-result pass.
 *
 * `PR4A_FIXTURE_DIR` may point the suite at another copy of the set (used by the
 * A-t8-2 minimality deletion experiment); the manifest travels with the copy, so
 * the same integrity check applies. The default is the in-repo fixture set.
 *
 * Every case runs the REAL verifier in a throw-away repo root (the verifier
 * anchors on process.cwd()), with a copy of the frozen artifact + report +
 * ledgers. Unrelated assertions fail because the fixture has no src/ tree; the
 * assertions under test are read from the verifier's own status file.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const VERIFIER = join(REPO_ROOT, 'scripts', 'eval', 'verify-pr4a-artifacts.mjs');
const REPORT_MD = join(REPO_ROOT, 'docs', 'reports', 'pr4a-five-arm-eval-report.md');

/** The tracked fixture set: the only place the P3-C inputs may come from. */
const FIXTURE_ROOT = resolve(process.env.PR4A_FIXTURE_DIR ?? join(REPO_ROOT, 'tests', 'fixtures', 'pr4a'));
const MANIFEST = join(FIXTURE_ROOT, 'fixture-manifest.json');

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A verifier check failure, as the verifier writes it to its status file. */
interface Failure {
  readonly id: string;
  readonly detail?: string;
}

interface FixtureEntry {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly optional: boolean;
}

interface FixtureManifest {
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly files: readonly FixtureEntry[];
}

/** sha256 over the RAW bytes: what the manifest freezes, never a re-encoding. */
function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Read the fixture manifest and verify EVERY listed file against it.
 *
 * This is deliberately eager (called once at module load) and deliberately
 * fatal: a missing manifest, a missing REQUIRED file, a size or digest mismatch,
 * or a non-plain-LF byte all throw at import time, so the suite cannot report a
 * green pass it did not earn. There is no `if (!exists) return`.
 *
 * `optional` is MEASURED, not decorative: it marks a file whose deletion leaves
 * these five cases green (A-t8-2 deletion experiment, recorded in the manifest's
 * `deletionExperiment`). Such a file is kept because it is the reproducible
 * input for the verifier assertions named in its `servesAssertions`, so its
 * ABSENCE is tolerated here while its DRIFT is still fatal: a present file must
 * always match the frozen bytes. A checkout must still carry the WHOLE set —
 * tests/unit/meta/no-work-dependency.test.ts asserts exactly that — so
 * `optional` can never be read as "may be missing from the repository".
 */
function loadVerifiedFixtures(): Map<string, string> {
  if (!existsSync(MANIFEST)) {
    throw new Error(
      'PR-4A fixture manifest is missing: ' + MANIFEST + '. The P3-C inputs are TRACKED fixtures; ' +
        'a checkout that lacks them cannot judge the artifact. Restore tests/fixtures/pr4a/ (never re-point the test at a gitignored work/ path).'
    );
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as FixtureManifest;
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('PR-4A fixture manifest lists no files: ' + MANIFEST);
  }
  if (manifest.fileCount !== manifest.files.length) {
    throw new Error(
      'PR-4A fixture manifest is inconsistent: fileCount=' +
        String(manifest.fileCount) +
        ' but files[] carries ' +
        String(manifest.files.length)
    );
  }
  const byName = new Map<string, string>();
  for (const entry of manifest.files) {
    const absolute = join(FIXTURE_ROOT, entry.path);
    if (!existsSync(absolute)) {
      if (entry.optional) {
        // A file the deletion experiment proved is NOT an input to these five
        // cases may be absent here (A-t8-2). Its presence is still required in a
        // checkout, which the fixture-set completeness case in
        // tests/unit/meta/no-work-dependency.test.ts enforces.
        continue;
      }
      throw new Error(
        'PR-4A fixture is missing: ' +
          entry.path +
          ' (expected at ' +
          absolute +
          '). A missing REQUIRED fixture input FAILS this suite; it is never skipped.'
      );
    }
    const bytes = readFileSync(absolute);
    if (bytes.length !== entry.bytes) {
      throw new Error(
        'PR-4A fixture byte length drifted: ' + entry.path + ' expected ' + String(entry.bytes) + ', measured ' + String(bytes.length)
      );
    }
    const digest = sha256(bytes);
    if (digest !== entry.sha256) {
      throw new Error(
        'PR-4A fixture sha256 drifted: ' + entry.path + ' expected ' + entry.sha256 + ', measured ' + digest
      );
    }
    // The frozen bytes are plain LF text. A digest mismatch already fails above,
    // but a `core.autocrlf` checkout or a BOM should be NAMED as the cause
    // instead of surfacing only as an opaque hash difference. Any CR at all is a
    // violation here, not merely a CRLF pair, and a BOM is checked explicitly.
    if (bytes.includes(0)) {
      throw new Error('PR-4A fixture is not plain LF text: ' + entry.path + ' carries a NUL byte');
    }
    if (bytes.includes(0x0d)) {
      throw new Error(
        'PR-4A fixture is not plain LF text: ' + entry.path + ' carries a CR byte (a CRLF checkout would rewrite the frozen digest)'
      );
    }
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      throw new Error('PR-4A fixture is not plain LF text: ' + entry.path + ' starts with a UTF-8 BOM');
    }
    byName.set(entry.path, absolute);
  }
  return byName;
}

const FIXTURES = loadVerifiedFixtures();
/** The artifact under judgement: required by the manifest, verified above. */
const ARTIFACT: string = (() => {
  const resolved = FIXTURES.get('pr4a-five-arm-eval.json');
  if (resolved === undefined) {
    throw new Error('PR-4A fixture manifest must list pr4a-five-arm-eval.json (the artifact under judgement)');
  }
  return resolved;
})();
/** Every ledger the manifest declares, keyed by its file name. */
const LEDGERS = [...FIXTURES.entries()].filter(([name]) => /^pr4a-ledger-.+[.]jsonl$/.test(name));

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'p4a-provenance-gate-'));
  tempRoots.push(root);
  mkdirSync(join(root, 'work'), { recursive: true });
  mkdirSync(join(root, 'docs', 'reports'), { recursive: true });
  // The throw-away root is the verifier's cwd, so IT is what must hold work/:
  // the frozen inputs are COPIED INTO the temp root, never read from the repo's
  // gitignored work/.
  copyFileSync(ARTIFACT, join(root, 'work', 'pr4a-five-arm-eval.json'));
  copyFileSync(REPORT_MD, join(root, 'docs', 'reports', 'pr4a-five-arm-eval-report.md'));
  for (const [name, source] of LEDGERS) {
    copyFileSync(source, join(root, 'work', name));
  }
  return root;
}

function mutate(root: string, change: (report: any) => void): void {
  const path = join(root, 'work', 'pr4a-five-arm-eval.json');
  const report = JSON.parse(readFileSync(path, 'utf8'));
  change(report);
  writeFileSync(path, JSON.stringify(report), 'utf8');
}

function run(root: string): { exit: number; failures: Failure[]; stdout: string } {
  const result = spawnSync(process.execPath, [VERIFIER], { cwd: root, encoding: 'utf8' });
  const statusPath = join(root, 'work', 'pr4a-verify-status.json');
  const status = existsSync(statusPath)
    ? (JSON.parse(readFileSync(statusPath, 'utf8')) as { failures?: Failure[] })
    : { failures: [] };
  return {
    exit: result.status ?? -1,
    failures: status.failures ?? [],
    stdout: result.stdout ?? ''
  };
}

function failedIds(runResult: { failures: readonly Failure[] }): readonly string[] {
  return runResult.failures.map((failure) => failure.id);
}

function expectTargetedFailure(runResult: { failures: readonly Failure[] }, id: string): void {
  expect(failedIds(runResult)).toContain(id);
}

describe('PR-4A provenance gate: the frozen artifact is judged exactly as before', () => {
  it('keeps cost-measured-zero and token-no-measured passing without a declaration', () => {
    const root = makeRoot();
    const result = run(root);
    const ids = failedIds(result);
    expect(ids).not.toContain('cost-measured-zero:Arm-0');
    expect(ids).not.toContain('token-no-measured:Arm-0');
    expect(ids).not.toContain('cost-counts-match:Arm-0');
    expect(ids).not.toContain('cost-shares-sum-1:Arm-0');
  });
});

describe('PR-4A provenance gate: a declared capability is PROVEN, not assumed', () => {
  it('MUTATION 1: declares a tokenizer but reports zero measured calls -> RED', () => {
    const root = makeRoot();
    mutate(root, (report) => {
      report.measurement = { tokenizer: true };
    });
    const result = run(root);
    expect(result.exit).toBe(1);
    expectTargetedFailure(result, 'cost-measured-capability:Arm-0');
  });

  it('MUTATION 2: no tokenizer declaration but a field claims precision measured -> RED', () => {
    const root = makeRoot();
    mutate(root, (report) => {
      report.tokenFields.perArm[0].cacheReadTokens.precision = 'measured';
    });
    const result = run(root);
    expect(result.exit).toBe(1);
    expectTargetedFailure(result, 'token-no-measured:Arm-0');
  });

  it('MUTATION 3: counts no longer sum to the denominator -> RED (existing rule intact)', () => {
    const root = makeRoot();
    mutate(root, (report) => {
      report.cost.arms[0].measured = { count: 1, share: 0 };
      report.cost.arms[0].estimated = { count: 180, share: 1 };
      report.cost.arms[0].unknown = { count: 0, share: 0 };
    });
    const result = run(root);
    expect(result.exit).toBe(1);
    expectTargetedFailure(result, 'cost-counts-match:Arm-0');
    // The no-declaration measured-zero rule still fires alongside it.
    expectTargetedFailure(result, 'cost-measured-zero:Arm-0');
  });

  it('POSITIVE: a declared capability with measured data passes both capability checks', () => {
    const root = makeRoot();
    mutate(root, (report) => {
      report.measurement = { tokenizer: true };
      for (const arm of report.cost.arms) {
        arm.measured = { count: arm.decisionPoints, share: 1 };
        arm.estimated = { count: 0, share: 0 };
        arm.unknown = { count: 0, share: 0 };
      }
      for (const arm of report.tokenFields.perArm) {
        for (const field of ['inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']) {
          arm[field].precision = 'measured';
        }
      }
    });
    const result = run(root);
    const ids = failedIds(result);
    expect(ids.filter((id) => id.startsWith('cost-measured-capability:'))).toEqual([]);
    expect(ids.filter((id) => id.startsWith('token-measured-capability:'))).toEqual([]);
    expect(ids).not.toContain('cost-counts-match:Arm-0');
    expect(ids).not.toContain('cost-shares-sum-1:Arm-0');
  });
});
