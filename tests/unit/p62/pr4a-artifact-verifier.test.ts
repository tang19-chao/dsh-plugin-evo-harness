/**
 * PR-4A artifact verifier — workspace evidence semantics (P0-B).
 *
 * The verifier must decide the provenance block deterministically in THREE
 * workspace states, and must be diagnosable in every one of them:
 *
 *   1. MISSING   — `work/` (or the report artifact) does not exist. The run has
 *                  to fail with named check ids/details on stdout even though
 *                  the status file cannot be written, and must not create work/.
 *   2. CLEAN     — `workspaceDirty=false`, `trackedDirtyCount=0`, an EMPTY
 *                  `dirtyFileDigests`, `trackedWorkspaceDigest=sha256('')`, and
 *                  executed sources that still reconcile with the files on
 *                  disk. The empty list is legitimate evidence here — the old
 *                  unconditional `dirtyFileDigests.length > 0` rule rejected it.
 *   3. DIRTY     — `workspaceDirty=true` with a NON-empty list whose paths
 *                  resolve, whose list digest is recomputable, and whose paths
 *                  are a subset of `git diff --name-only <codeBaseline>` (the
 *                  t1 B1 state-5 binding; this fixture therefore builds a real
 *                  throw-away git repo with a baseline commit).
 *
 * Negative counterparts make the acceptance non-vacuous: a dirty flag with an
 * empty list, a `missing`/traversal path, an executed module mutated after
 * capture, malformed executedSources entries, an unreadable executed module,
 * and a fabricated dirty path outside the codeBaseline diff must each fail with
 * a specific id + detail naming the offending entry.
 *
 * T7 repairs covered here:
 *   - F1 (checkout bytes): a recorded CRLF digest placed on disk as LF bytes must
 *     produce the named `provenance-executed-sources-eol-divergent` warning (and
 *     still fail `provenance-executed-sources-match-disk`, because the recorded
 *     bytes do not describe this checkout). NOTE: this diagnosis recognises the
 *     two byte forms of the SAME text under ONE checkout configuration; it is
 *     NOT a portability guarantee across different `core.autocrlf` checkouts.
 *     The documented spec (header + `--help`) is `git -c core.autocrlf=false
 *     checkout` for both generation and verification.
 *   - F2 (anchor bypass): traversal/absolute/drive-letter/non-hex entries must
 *     fail `provenance-executed-entries-well-formed` with the entry named; an
 *     unreadable entry must fail `provenance-executed-all-entries-checked`
 *     instead of being skipped.
 *   - F3 (baseline binding): a dirty entry that is not in the codeBaseline diff
 *     must fail `provenance-dirty-paths-in-baseline-diff` and name that path.
 *
 * The fixture reports are intentionally minimal: the verifier's OTHER report
 * assertions (arms, comparisons, ledgers, markdown) fail on the fixture, so each
 * case asserts on the `provenance-*` checks only. The live artifact is verified
 * by running `node scripts/eval/verify-pr4a-artifacts.mjs` in the repository
 * root, which is deliberately NOT spawned from this unit test (it would rewrite
 * the repo's own work/pr4a-verify-status.json on every vitest run).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const VERIFIER = join(REPO_ROOT, 'scripts', 'eval', 'verify-pr4a-artifacts.mjs');

/** sha256 over the UTF-8 text, exactly as the verifier computes list digests. */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** A syntactically valid 64-hex digest used where the bytes are irrelevant. */
const HASH = '0123456789abcdef'.repeat(4);

interface ExecutedSource {
  path: string;
  sha256: string;
}

interface DirtyEntry {
  path: string;
  sha256: string;
}

interface ProvenanceFixture {
  workspaceDirty: boolean;
  trackedDirtyCount: number;
  dirtyFileDigests: DirtyEntry[];
  trackedWorkspaceDigest: string;
  executedSources: ExecutedSource[];
  executedSourcesDigest: string;
  howToLocate: string;
  bundleFingerprint: {
    entry: string;
    artifact: string;
    digest: string;
    esbuildVersion: string;
    mode: string;
    rebuilt: boolean;
  };
}

interface StatusFailure {
  id: string;
  detail: string;
}

interface VerificationStatus {
  checked: number;
  passed: number;
  failed: number;
  /** Non-failing named observations such as the eol-only diagnosis. */
  warnings?: StatusFailure[];
  failures: StatusFailure[];
}

/** A clean fixture has no dirty entries, so its codeBaseline is never diffed;
 * this value only has to be a syntactically valid 40-hex commit id. */
const FIXTURE_BASELINE = '0'.repeat(40);

/**
 * The seven modules the real provenance block enumerates; contents are fixture
 * bytes, but `scripts/eval/pr4a-report.ts` must exist so the verifier's
 * self-hash check can reconcile against a working tree.
 */
const EXECUTED_MODULES: ReadonlyArray<readonly [string, string]> = [
  ['scripts/eval/eval-pr4a-five-arm.mjs', '// fixture: five-arm entry\n'],
  ['scripts/eval/pr4a-build.mjs', '// fixture: build helper\n'],
  ['scripts/eval/build-eval.mjs', '// fixture: eval bundler\n'],
  ['scripts/eval/pr4a-five-arm-lib.ts', 'export const armLib = 1;\n'],
  ['scripts/eval/pr4a-report.ts', 'export const report = "fixture";\n'],
  ['scripts/eval/pr4a-stats.ts', 'export const stats = 1;\n'],
  ['scripts/eval/jitrl-eval-lib.ts', 'export const lib = 1;\n']
];

const createdRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pr4a-verify-'));
  createdRoots.push(root);
  return root;
}

afterAll(() => {
  for (const root of createdRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeRepoFile(root: string, relativePath: string, content: string): void {
  const full = join(root, ...relativePath.split('/'));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

/** Run git inside the throw-away fixture repo (no user/system config leaks). */
function runGit(cwd: string, args: readonly string[]): string {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) env[key] = value;
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  return execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim();
}

/**
 * Build a real baseline commit in the fixture root. T7-F3 requires the verifier
 * to check `git diff --name-only <codeBaseline>`, so dirty fixtures need an
 * actual frozen baseline, not a pseudo-SHA. Files passed in `baselineFiles` are
 * committed; the caller then modifies them to form the dirty worktree.
 */
function initBaselineRepo(root: string, baselineFiles: Record<string, string>): string {
  for (const [path, content] of Object.entries(baselineFiles)) writeRepoFile(root, path, content);
  runGit(root, ['init', '-q']);
  runGit(root, ['config', 'user.name', 'PR-4A Fixture']);
  runGit(root, ['config', 'user.email', 'fixture@example.invalid']);
  runGit(root, ['config', 'core.autocrlf', 'false']);
  runGit(root, ['config', 'commit.gpgsign', 'false']);
  runGit(root, ['add', '-A']);
  runGit(root, ['commit', '-q', '-m', 'baseline']);
  return runGit(root, ['rev-parse', 'HEAD']);
}

/** The list digest is `sha256(sha + "  " + path, one per line)` — exactly the
 * derivation the verifier performs, so recomputation can be checked. */
function digestOfList(entries: ReadonlyArray<{ path: string; sha256: string }>): string {
  return sha256(entries.map((entry) => `${entry.sha256}  ${entry.path}`).join('\n'));
}

function writeExecutedSources(root: string): ExecutedSource[] {
  return EXECUTED_MODULES.map(([path, content]) => {
    writeRepoFile(root, path, content);
    return { path, sha256: sha256(content) };
  });
}

function buildCleanProvenance(root: string): ProvenanceFixture {
  const executedSources = writeExecutedSources(root);
  return {
    workspaceDirty: false,
    trackedDirtyCount: 0,
    dirtyFileDigests: [],
    trackedWorkspaceDigest: sha256(''),
    executedSources,
    executedSourcesDigest: digestOfList(executedSources),
    howToLocate:
      'Re-run every module in executedSources at codeBaseline; the working tree was clean so the list is empty.',
    bundleFingerprint: {
      entry: 'scripts/eval/pr4a-report.ts',
      artifact: '/tmp/pr4a-report.fixture.mjs',
      digest: HASH,
      esbuildVersion: '0.28.2',
      mode: 'external',
      rebuilt: false
    }
  };
}

interface DirtyFixture {
  provenance: ProvenanceFixture;
  /** Commit id the dirty entries are a change relative to (real git baseline). */
  baseline: string;
}

function buildDirtyProvenance(root: string, dirtyFiles: Record<string, string>): DirtyFixture {
  const executedSources = writeExecutedSources(root);
  const baselineFiles: Record<string, string> = {};
  for (const [path, content] of Object.entries(dirtyFiles)) {
    // Baseline bytes differ from the dirty bytes for every path, so every
    // recorded entry is a genuine change relative to the baseline commit.
    baselineFiles[path] = '/* baseline capture */\n' + content;
  }
  const baseline = initBaselineRepo(root, baselineFiles);
  const dirtyFileDigests = Object.entries(dirtyFiles).map(([path, content]) => {
    writeRepoFile(root, path, content);
    return { path, sha256: sha256(content) };
  });
  return {
    baseline,
    provenance: {
      workspaceDirty: true,
      trackedDirtyCount: dirtyFileDigests.length,
      dirtyFileDigests,
      trackedWorkspaceDigest: digestOfList(dirtyFileDigests),
      executedSources,
      executedSourcesDigest: digestOfList(executedSources),
      howToLocate:
        'Re-run every module in executedSources at codeBaseline, then re-apply the recorded dirtyFileDigests in order.',
      bundleFingerprint: {
        entry: 'scripts/eval/pr4a-report.ts',
        artifact: '/tmp/pr4a-report.fixture.mjs',
        digest: HASH,
        esbuildVersion: '0.28.2',
        mode: 'external',
        rebuilt: false
      }
    }
  };
}

/**
 * Write a minimal report that reaches the provenance block. Other report fields
 * are absent on purpose: this suite covers workspace semantics, not the report.
 */
function writeArtifact(root: string, provenance: ProvenanceFixture, codeBaseline = FIXTURE_BASELINE): void {
  const report = {
    protocol: 'FIXTURE-PR4A-PROVENANCE',
    codeBaseline,
    declarations: {},
    replication: {
      perArm: [],
      effectiveReplication: 1,
      allLearningArmsConstant: true,
      designIsBinary: true
    },
    arms: [],
    codeProvenance: provenance
  };
  mkdirSync(join(root, 'work'), { recursive: true });
  writeFileSync(join(root, 'work', 'pr4a-five-arm-eval.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runVerifier(root: string): RunResult {
  const result = spawnSync(process.execPath, [VERIFIER], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function readStatus(root: string): VerificationStatus | null {
  const file = join(root, 'work', 'pr4a-verify-status.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as VerificationStatus;
}

function provenanceFailures(root: string): StatusFailure[] {
  return (readStatus(root)?.failures ?? []).filter((failure) => failure.id.startsWith('provenance-'));
}

describe('PR-4A artifact verifier — workspace evidence semantics', () => {
  it('MISSING work/: exit 1 with named ids/details on stdout, no status file, no work/ creation', () => {
    const root = makeRoot();
    const run = runVerifier(root);

    expect(run.status).toBe(1);
    expect(run.stderr).toBe('');
    // Exactly the four pre-report checks: missing directory, both artifacts, and
    // the failed parse.
    expect(run.stdout).toContain('[verify-pr4a-artifacts] checked=4 passed=0 failed=4');
    expect(run.stdout).toContain('FAIL work-directory-exists :: ');
    expect(run.stdout).toContain('FAIL json-exists :: ');
    expect(run.stdout).toContain(join(root, 'work', 'pr4a-five-arm-eval.json'));
    expect(run.stdout).toContain('FAIL markdown-exists :: ');
    expect(run.stdout).toMatch(/FAIL json-parses :: Error: ENOENT/);
    // The status file cannot exist, so stdout must say so instead of failing silent.
    expect(run.stdout).toContain('status file NOT written');
    expect(run.stdout).toContain('[verify-pr4a-artifacts] FAIL (');
    expect(readStatus(root)).toBeNull();
    expect(existsSync(join(root, 'work'))).toBe(false);
  });

  it('MISSING artifact in an existing work/: directory check passes and the status file records the failure', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'work'), { recursive: true });
    const run = runVerifier(root);

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('checked=4 passed=1 failed=3');
    expect(run.stdout).not.toContain('FAIL work-directory-exists');
    expect(run.stdout).toContain('FAIL json-exists');
    const status = readStatus(root);
    expect(status?.failed).toBe(3);
    expect(status?.failures.map((failure) => failure.id)).toEqual([
      'json-exists',
      'markdown-exists',
      'json-parses'
    ]);
    expect(run.stdout).toContain('status file: work/pr4a-verify-status.json');
  });

  it('CLEAN capture: empty dirtyFileDigests is accepted when the tree is clean and executed sources match disk', () => {
    const root = makeRoot();
    writeArtifact(root, buildCleanProvenance(root));
    const run = runVerifier(root);

    // The fixture has no arms/comparisons/ledgers, so unrelated checks fail; the
    // provenance contract itself must be fully satisfied.
    expect(run.status).toBe(1);
    expect(provenanceFailures(root)).toEqual([]);
    expect(run.stdout).not.toContain('FAIL provenance-');
    expect(readStatus(root)?.checked).toBeGreaterThan(30);
  });

  it('CLEAN-looking but dirty: empty dirtyFileDigests is rejected with a named contradiction', () => {
    const root = makeRoot();
    const provenance = buildCleanProvenance(root);
    provenance.workspaceDirty = true;
    provenance.trackedDirtyCount = 1;
    writeArtifact(root, provenance);
    const run = runVerifier(root);

    const failures = readStatus(root)?.failures ?? [];
    const contradiction = failures.find((failure) => failure.id === 'provenance-empty-dirty-only-when-clean');
    expect(contradiction).toBeDefined();
    expect(contradiction?.detail).toContain('workspaceDirty=true');
    expect(contradiction?.detail).toContain('trackedDirtyCount=1');
    expect(contradiction?.detail).toContain('trackedWorkspaceDigest=sha256("")');
    expect(contradiction?.detail).toContain(sha256(''));
    const countMismatch = failures.find((failure) => failure.id === 'provenance-dirty-count-matches-list');
    expect(countMismatch?.detail).toBe('trackedDirtyCount=1 vs dirtyFileDigests.length=0');
    expect(run.stdout).toContain('FAIL provenance-empty-dirty-only-when-clean');
  });

  it('CLEAN capture with an executed source mutated after capture is rejected with recorded vs disk bytes', () => {
    const root = makeRoot();
    const provenance = buildCleanProvenance(root);
    writeArtifact(root, provenance);
    writeRepoFile(root, 'scripts/eval/build-eval.mjs', '// mutated after the evidence run\n');
    const run = runVerifier(root);

    const failures = readStatus(root)?.failures ?? [];
    const mismatch = failures.find((failure) => failure.id === 'provenance-executed-sources-match-disk');
    expect(mismatch).toBeDefined();
    const detail = JSON.parse(mismatch?.detail ?? '{}') as {
      mismatches: Array<{ path: string; recorded: string; disk: string; eolOnly: boolean }>;
    };
    const mutated = detail.mismatches.find((entry) => entry.path === 'scripts/eval/build-eval.mjs');
    expect(mutated).toBeDefined();
    expect(mutated?.recorded).toMatch(/^[0-9a-f]{64}$/);
    expect(mutated?.disk).toMatch(/^[0-9a-f]{64}$/);
    expect(mutated?.recorded).not.toBe(mutated?.disk);
    // A content change is NOT an eol-only divergence.
    expect(mutated?.eolOnly).toBe(false);
    // The self-hash of pr4a-report.ts is untouched, so only the drifted module fails.
    expect(failures.some((failure) => failure.id === 'provenance-self-hash-matches-working-tree')).toBe(false);
    expect(run.stdout).toContain('FAIL provenance-executed-sources-match-disk');
  });

  it('DIRTY capture: a non-empty list whose paths resolve, digest is recomputable and all paths are in the baseline diff is accepted', () => {
    const root = makeRoot();
    const { provenance, baseline } = buildDirtyProvenance(root, {
      'src/index.ts': 'export const one = 1;\n',
      'README.md': '# fixture readme\n'
    });
    writeArtifact(root, provenance, baseline);
    const run = runVerifier(root);

    expect(run.status).toBe(1);
    expect(provenanceFailures(root)).toEqual([]);
    expect(run.stdout).not.toContain('FAIL provenance-');
  });

  it('DIRTY capture with a stale dirty digest still verifies: bytes are historical, paths stay baseline-bound', () => {
    const root = makeRoot();
    const { provenance, baseline } = buildDirtyProvenance(root, {
      'src/index.ts': 'export const one = 1;\n',
      'README.md': '# fixture readme\n'
    });
    writeArtifact(root, provenance, baseline);
    // A dirty tracked file legitimately moves on after the evidence run (the
    // parallel remediation edits such files); the recorded digest binds the
    // historical entry, not today's bytes, so this must NOT fail provenance. The
    // PATH is still in the codeBaseline diff, so the F3 subset check stays green.
    writeRepoFile(root, 'src/index.ts', 'export const one = 2;\n');
    const run = runVerifier(root);

    expect(provenanceFailures(root)).toEqual([]);
    expect(run.stdout).not.toContain('FAIL provenance-');
  });

  it('DIRTY capture with a missing digest or traversal path is rejected by provenance-dirty-paths-resolve', () => {
    const root = makeRoot();
    const { provenance, baseline } = buildDirtyProvenance(root, { 'src/index.ts': 'export const one = 1;\n' });
    // Keep the list digest internally recomputable so ONLY the path/digest rule
    // can explain the failure.
    provenance.dirtyFileDigests.push({ path: '../escape.txt', sha256: HASH });
    provenance.dirtyFileDigests[0] = { path: 'src/index.ts', sha256: 'missing' };
    provenance.trackedDirtyCount = provenance.dirtyFileDigests.length;
    provenance.trackedWorkspaceDigest = digestOfList(provenance.dirtyFileDigests);
    writeArtifact(root, provenance, baseline);
    const run = runVerifier(root);

    const failures = readStatus(root)?.failures ?? [];
    const resolution = failures.find((failure) => failure.id === 'provenance-dirty-paths-resolve');
    expect(resolution).toBeDefined();
    expect(resolution?.detail).toContain('src/index.ts');
    expect(resolution?.detail).toContain('missing');
    expect(resolution?.detail).toContain('../escape.txt');
    expect(failures.some((failure) => failure.id === 'provenance-workspace-digest-recomputed')).toBe(false);
    expect(run.stdout).toContain('FAIL provenance-dirty-paths-resolve');
  });

  it('EOL-only divergence at a recorded CRLF source gets a named warning, not one opaque mismatch', () => {
    const root = makeRoot();
    const provenance = buildCleanProvenance(root);
    const eolModule = 'scripts/eval/build-eval.mjs';
    const diskText = readFileSync(join(root, eolModule), 'utf8');
    // The recorded digest describes the CRLF form; the fixture keeps LF bytes on
    // disk. That is exactly the cross-checkout shape T7-F1 measured.
    const crlfDigest = sha256(diskText.replace(/\n/g, '\r\n'));
    provenance.executedSources = provenance.executedSources.map((entry) =>
      entry.path === eolModule ? { ...entry, sha256: crlfDigest } : entry
    );
    provenance.executedSourcesDigest = digestOfList(provenance.executedSources);
    writeArtifact(root, provenance);
    const run = runVerifier(root);

    // Named eol diagnosis on stdout and in the status file.
    expect(run.stdout).toContain('WARN provenance-executed-sources-eol-divergent');
    expect(run.stdout).toContain(eolModule);
    const status = readStatus(root);
    expect(status?.warnings?.some((warning) => warning.id === 'provenance-executed-sources-eol-divergent')).toBe(true);
    // Raw bytes still differ: the recorded evidence does not describe this
    // checkout, so the failure stays — now with a precise reason.
    const mismatch = status?.failures.find((failure) => failure.id === 'provenance-executed-sources-match-disk');
    expect(mismatch).toBeDefined();
    const detail = JSON.parse(mismatch?.detail ?? '{}') as {
      mismatches: Array<{ path: string; eolOnly: boolean }>;
    };
    const divergent = detail.mismatches.find((entry) => entry.path === eolModule);
    expect(divergent?.eolOnly).toBe(true);
    expect(status?.failures.some((failure) => failure.id === 'provenance-executed-all-entries-checked')).toBe(false);
    // NOTE: this diagnosis recognises the two byte forms of the SAME text under
    // ONE checkout byte configuration. It is NOT a portability guarantee across
    // different core.autocrlf checkouts: generating or verifying under another
    // configuration still changes raw bytes. The documented spec is
    // `git -c core.autocrlf=false checkout` for generation AND verification.
  });

  it('REJECTS malformed executedSources entries with a named check instead of filtering them out of the comparison', () => {
    const root = makeRoot();
    const provenance = buildCleanProvenance(root);
    provenance.executedSources = [
      ...provenance.executedSources,
      { path: '../fabricated-module.mjs', sha256: 'b'.repeat(64) },
      { path: '/tmp/absolute-module.mjs', sha256: 'c'.repeat(64) },
      { path: 'C:/drive-module.mjs', sha256: 'd'.repeat(64) },
      { path: 'scripts/eval/pr4a-build.mjs', sha256: 'zz-not-hex' }
    ];
    provenance.executedSourcesDigest = digestOfList(provenance.executedSources);
    writeArtifact(root, provenance);
    const run = runVerifier(root);
    const failures = readStatus(root)?.failures ?? [];

    const malformed = failures.find((failure) => failure.id === 'provenance-executed-entries-well-formed');
    expect(malformed).toBeDefined();
    expect(malformed?.detail).toContain('../fabricated-module.mjs');
    expect(malformed?.detail).toContain('/tmp/absolute-module.mjs');
    expect(malformed?.detail).toContain('C:/drive-module.mjs');
    expect(malformed?.detail).toContain('zz-not-hex');
    // "Cannot be compared" is a failure, not a skipped entry.
    expect(failures.some((failure) => failure.id === 'provenance-executed-all-entries-checked')).toBe(true);
    expect(run.status).toBe(1);
  });

  it('treats an executed source it cannot read as a failure, never a skipped comparison', () => {
    const root = makeRoot();
    const provenance = buildCleanProvenance(root);
    const missingModule = 'scripts/eval/never-written-module.mjs';
    provenance.executedSources = [...provenance.executedSources, { path: missingModule, sha256: 'b'.repeat(64) }];
    provenance.executedSourcesDigest = digestOfList(provenance.executedSources);
    writeArtifact(root, provenance);
    runVerifier(root);

    const failures = readStatus(root)?.failures ?? [];
    const allChecked = failures.find((failure) => failure.id === 'provenance-executed-all-entries-checked');
    expect(allChecked).toBeDefined();
    expect(allChecked?.detail).toContain(missingModule);
    expect(failures.some((failure) => failure.id === 'provenance-executed-sources-match-disk')).toBe(true);
    // The entry is well-formed but unreadable, so only the "all checked" rule fires.
    expect(failures.some((failure) => failure.id === 'provenance-executed-entries-well-formed')).toBe(false);
  });

  it('REJECTS a dirty entry that is not part of the codeBaseline change set', () => {
    const root = makeRoot();
    const { provenance, baseline } = buildDirtyProvenance(root, { 'src/index.ts': 'export const one = 1;\n' });
    const fabricated = 'src/fabricated-never-existed.ts';
    provenance.dirtyFileDigests.push({ path: fabricated, sha256: 'a'.repeat(64) });
    provenance.trackedDirtyCount = provenance.dirtyFileDigests.length;
    provenance.trackedWorkspaceDigest = digestOfList(provenance.dirtyFileDigests);
    writeArtifact(root, provenance, baseline);
    runVerifier(root);

    const failures = readStatus(root)?.failures ?? [];
    const subset = failures.find((failure) => failure.id === 'provenance-dirty-paths-in-baseline-diff');
    expect(subset).toBeDefined();
    expect(subset?.detail).toContain(fabricated);
    expect(subset?.detail).toContain(baseline);
    // The fabricated entry is well-formed, so only the baseline binding catches it.
    expect(failures.some((failure) => failure.id === 'provenance-dirty-paths-resolve')).toBe(false);
  });

  it('documents the checkout byte spec and the named checks in --help', () => {
    const root = makeRoot();
    const result = spawnSync(process.execPath, [VERIFIER, '--help'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000
    });
    expect(result.status).toBe(0);
    const stdout = result.stdout ?? '';
    expect(stdout).toContain('CHECKOUT BYTE SPEC');
    expect(stdout).toContain('core.autocrlf=false');
    expect(stdout).toContain('git -c core.autocrlf=false checkout');
    expect(stdout).toContain('provenance-executed-sources-eol-divergent');
    expect(stdout).toContain('provenance-executed-sources-match-disk');
    expect(stdout).toContain('provenance-dirty-paths-in-baseline-diff');
    // --help is a contract print, not a verification run: no status artifact.
    expect(readStatus(root)).toBeNull();
  });
});