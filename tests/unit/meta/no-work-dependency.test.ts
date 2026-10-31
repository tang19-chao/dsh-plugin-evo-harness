/**
 * rev5 P0-2: NO test or probe may read its INPUT from the gitignored `work/`
 * directory, and a missing input must FAIL instead of being silently skipped.
 *
 * THE DEFECT THIS PINS
 * --------------------
 * `work/` is `.gitignore`d (`.gitignore:8`), so a clean checkout has no such
 * directory. Five P3-C cases read `work/pr4a-five-arm-eval.json` and therefore
 * failed every run in a fresh clone with `ENOENT`, while the same tree was green
 * on the machine that happened to have the scratch directory. That is the exact
 * shape G5 forbids: evidence that depends on an untracked file.
 *
 * WHAT IS ASSERTED, AND HOW EACH ASSERTION CAN FAIL
 * -------------------------------------------------
 *   1. DISCRIMINATION (positive): the scanner, pointed at a synthetic tree with
 *      the defect planted in the shape that actually shipped — a path BUILT in a
 *      helper and READ in another statement — reports it, names the file and the
 *      line, and the statement is the one carrying the input.
 *   2. DISCRIMINATION (negative): the same scanner on a clean tree (temp-root
 *      reads, repo-root WRITES, `work/` as file CONTENT, a drive-letter path)
 *      reports ZERO input findings. Without this the positive case could be a
 *      scanner that flags everything.
 *   3. TEMP-ROOT RESOLUTION: a path rooted at `mkdtempSync(...)` is not a
 *      finding even though it contains `work`, and an UNRESOLVABLE root IS a
 *      finding (fail-closed) — this is what stops "rename the anchor variable"
 *      from being a way to silence the check.
 *   4. THIS REPOSITORY: every current repo-root read is pinned by
 *      `file#snippetHash` with a written reason; an unpinned one fails, and so
 *      does a stale pin (so the allowlist cannot rot into decoration).
 *   5. NO SILENT SKIP: the P3-C suite contains no `skip`/`todo`, and deleting its
 *      manifest or a required fixture makes the suite exit NON-ZERO (measured by
 *      running vitest on a copy of the test, not by grepping for a keyword).
 *   6. FIXTURE SET COMPLETENESS: every file the manifest lists is present and its
 *      sha256 matches, so `optional` in the manifest cannot be read as "may be
 *      missing from the checkout".
 *
 * The allowlist is DATA, and it is compared in BOTH directions. A new
 * `join(REPO_ROOT, 'work', ...)` read therefore fails this suite until someone
 * writes down why it is legitimate.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import {
  compareAllowlist,
  inputFindings,
  scanWorkPathUses,
  type WorkAllowEntry
} from './work-path-scanner';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURE_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'pr4a');
const GATE_TEST = 'tests/unit/eval/pr4a-cost-provenance-gate.test.ts';
const VITEST_ENTRY = join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTemp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

/** Write a synthetic source file into a fixture tree (creating its directories). */
function plant(root: string, relativePath: string, text: string): void {
  const full = join(root, ...relativePath.split('/'));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text, 'utf8');
}

/**
 * The repo-root reads the CURRENT tree is allowed to contain, each with a reason.
 *
 * Every entry is `file#snippetHash`. The snippet hash covers the whole statement,
 * so re-indenting or renaming an unrelated local keeps the pin, while changing
 * the READ ITSELF (a different file, a different anchor) breaks it — which is the
 * point: the pin authorises THIS input, not the neighbourhood it sits in.
 *
 * SCOPE. Only `scripts/eval/verify-pr4a-artifacts.mjs` needs a pin, and that is
 * the honest finding rather than a concession:
 *   - it is the PRODUCTION consumer of `work/` (its CLI contract IS the work/
 *     drop), not a test fixture, and `scripts/**` is outside t8's write scope;
 *   - its OWN unit test (`tests/unit/p62/pr4a-artifact-verifier.test.ts`) builds
 *     a throw-away root with `mkdtempSync` for every case, so the test reads its
 *     status file from a TEMP root — the scanner proves that and reports
 *     `temp-root`, which is why no test pin is needed here.
 * The frozen P3-C gate suite reads only `tests/fixtures/pr4a/` and copies into a
 * temp root, so the shipped P0-1 defect is genuinely gone rather than blessed.
 */
const ALLOWED_REPO_ROOT_READS: readonly WorkAllowEntry[] = [
  {
    identityKey: 'scripts/eval/verify-pr4a-artifacts.mjs#fb6cfddf6be831d3',
    kind: 'repo-root-input',
    reason:
      'the PR-4A verifier is the PRODUCTION consumer of work/: its artifact contract IS the work/ drop ' +
      '(work/pr4a-five-arm-eval.json + work/pr4a-verify-status.json output). It is not a test fixture — it is ' +
      'the tool the frozen report describes — and its own unit test runs it in a throw-away root. Changing it ' +
      'belongs to scripts/** (t12) and would invalidate the frozen report digests.'
  },
  {
    identityKey: 'scripts/eval/verify-pr4a-artifacts.mjs#ee5a0ffe916538cd',
    kind: 'repo-root-input',
    reason:
      'same file, the per-arm LEDGER existence probe inside the section-8 ledger loop: the verifier must ' +
      'report a missing work/pr4a-ledger-<Arm>.jsonl as a named failure id, so it has to look for it in work/. ' +
      'Reporting that absence is the opposite of a silent skip.'
  }
];

describe('work-path scanner: it can actually SEE the shipped defect', () => {
  it('reports a repo-root work read that is BUILT in one statement and READ in another', () => {
    const root = makeTemp('work-scan-positive-');
    plant(
      root,
      'tests/unit/eval/planted.test.ts',
      [
        "import { copyFileSync, readFileSync } from 'node:fs';",
        "import { dirname, join, resolve } from 'node:path';",
        "import { fileURLToPath } from 'node:url';",
        '',
        "const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');",
        "const ARTIFACT = join(REPO_ROOT, 'work', 'pr4a-five-arm-eval.json');",
        '',
        'export function readIt(): string {',
        "  return readFileSync(join(REPO_ROOT, 'work', 'ledger.jsonl'), 'utf8');",
        '}',
        '',
        'export function copyIt(target: string): void {',
        '  copyFileSync(ARTIFACT, target);',
        '}',
        ''
      ].join('\n')
    );

    const findings = inputFindings(scanWorkPathUses(root));

    // The indirect defect: the literal is on the ARTIFACT declaration line, and
    // the READ happens three statements later.
    const indirect = findings.find((finding) => finding.pathExpression.includes('pr4a-five-arm-eval.json'));
    expect(indirect, JSON.stringify(findings, null, 2)).toBeDefined();
    expect(indirect?.file).toBe('tests/unit/eval/planted.test.ts');
    expect(indirect?.line).toBe(6); // the declaration that introduced the input
    expect(indirect?.consumer).toBe('copyFileSync');
    expect(indirect?.kind).toBe('repo-root-input');
    expect(indirect?.root).toBe('repo');

    // The direct defect is reported too, at its own read line.
    const direct = findings.find((finding) => finding.pathExpression.includes('ledger.jsonl'));
    expect(direct?.line).toBe(9);
    expect(direct?.consumer).toBe('readFileSync');

    expect(findings.map((finding) => finding.identityKey)).toEqual(
      expect.arrayContaining([indirect?.identityKey, direct?.identityKey])
    );
  });

  it('reports ZERO findings on a tree that only reads temp dirs and writes under the repo', () => {
    const root = makeTemp('work-scan-negative-');
    plant(
      root,
      'tests/unit/eval/clean.test.ts',
      [
        "import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';",
        "import { tmpdir } from 'node:os';",
        "import { join } from 'node:path';",
        '',
        "const REPO_ROOT = '/repo';",
        '',
        'export function scratch(): string {',
        "  const dir = mkdtempSync(join(tmpdir(), 'clean-'));",
        "  mkdirSync(join(dir, 'work'), { recursive: true });",
        "  writeFileSync(join(dir, 'work', 'x.json'), '{}');",
        "  return readFileSync(join(dir, 'work', 'x.json'), 'utf8');",
        '}',
        '',
        'export function repoOutput(): void {',
        "  mkdirSync(join(REPO_ROOT, 'work', 'tmp'), { recursive: true });",
        "  writeFileSync(join(REPO_ROOT, 'work', 'tmp', 'out.json'), '{}');",
        '}',
        '',
        'export function content(): string {',
        "  return ['work/', 'pr4a-ledger-<Arm>.jsonl'].join(' ');",
        '}',
        '',
        'export const PROMPT = \'Implement JSON parser in C:\\\\work\\\\a.ts\';',
        ''
      ].join('\n')
    );

    const occurrences = scanWorkPathUses(root);
    const findings = inputFindings(occurrences);

    expect(findings, JSON.stringify(occurrences.filter((o) => o.kind !== 'content'), null, 2)).toEqual([]);
    // Non-vacuity: the scan DID see the temp-root and repo-root uses; it simply
    // classified them correctly. A scanner that returned nothing would fail here.
    const kinds = new Set(occurrences.map((occurrence) => occurrence.kind));
    expect([...kinds].sort()).toEqual(expect.arrayContaining(['repo-root-output', 'temp-root']));
  });

  it('treats an UNRESOLVABLE root as a finding (fail-closed) and a temp root as none', () => {
    const root = makeTemp('work-scan-roots-');
    plant(
      root,
      'tests/unit/eval/roots.test.ts',
      [
        "import { mkdtempSync, readFileSync } from 'node:fs';",
        "import { tmpdir } from 'node:os';",
        "import { join } from 'node:path';",
        '',
        'declare const mysteryRoot: string;',
        '',
        'export function fromTemp(): string {',
        '  const dir = mkdtempSync(join(tmpdir(), \'r-\'));',
        "  return readFileSync(join(dir, 'work', 'a.json'), 'utf8');",
        '}',
        '',
        'export function fromUnknown(): string {',
        "  return readFileSync(join(mysteryRoot, 'work', 'b.json'), 'utf8');",
        '}',
        ''
      ].join('\n')
    );

    const findings = inputFindings(scanWorkPathUses(root));

    // Exactly one: the unprovable root. The temp-root read is not a finding.
    expect(findings).toHaveLength(1);
    expect(findings[0]?.pathExpression).toContain('b.json');
    expect(findings[0]?.root).toBe('unresolved');
    expect(findings[0]?.kind).toBe('unresolved-root-input');
  });

  it('does not mistake a drive-letter path or a prose mention for a repository input', () => {
    const root = makeTemp('work-scan-content-');
    plant(
      root,
      'tests/unit/eval/content.test.ts',
      [
        "import { readFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        '',
        "const REPO_ROOT = '/repo';",
        '',
        'export function windowsPath(): string {',
        "  return readFileSync(join(REPO_ROOT, 'docs', 'C:\\\\work\\\\a.ts'), 'utf8');",
        '}',
        '',
        'export const NOTE = \'the parser already has active work scheduled\';',
        ''
      ].join('\n')
    );

    expect(inputFindings(scanWorkPathUses(root))).toEqual([]);
  });

  it('detects the EXACT historical defect (the code that shipped in HEAD 97e38db)', () => {
    // Verbatim copy of the two offending regions of the pre-fix P3-C gate, so the
    // positive case cannot be dismissed as "a bug shaped to suit the scanner".
    // The old code read work/ in three places: the artifact copy, the ledger
    // directory listing, and the per-ledger copy inside that listing.
    const root = makeTemp('work-scan-historical-');
    plant(
      root,
      'tests/unit/eval/pr4a-cost-provenance-gate.test.ts',
      [
        "import { copyFileSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';",
        "import { tmpdir } from 'node:os';",
        "import { dirname, join, resolve } from 'node:path';",
        "import { fileURLToPath } from 'node:url';",
        '',
        "const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');",
        "const ARTIFACT = join(REPO_ROOT, 'work', 'pr4a-five-arm-eval.json');",
        '',
        'function makeRoot(): string {',
        "  const root = mkdtempSync(join(tmpdir(), 'p4a-provenance-gate-'));",
        "  mkdirSync(join(root, 'work'), { recursive: true });",
        "  copyFileSync(ARTIFACT, join(root, 'work', 'pr4a-five-arm-eval.json'));",
        "  for (const file of readdirSync(join(REPO_ROOT, 'work'))) {",
        "    if (/^pr4a-ledger-.*[.]jsonl$/.test(file)) {",
        "      copyFileSync(join(REPO_ROOT, 'work', file), join(root, 'work', file));",
        '    }',
        '  }',
        '  return root;',
        '}',
        ''
      ].join('\n')
    );

    const findings = inputFindings(scanWorkPathUses(root));
    // Three repo-root reads, and NO false positive on the temp-root copies that
    // sit beside them in the same function — that pairing is the whole test.
    expect(findings.map((finding) => finding.consumer)).toEqual(['copyFileSync', 'readdirSync', 'copyFileSync']);
    expect(findings.map((finding) => finding.root)).toEqual(['repo', 'repo', 'repo']);
    // Measured, not guessed: line 7 is the ARTIFACT declaration (reported where
    // the input is INTRODUCED, not where it is copied), 13 the work/ listing, 15
    // the per-ledger copy inside that listing.
    expect(findings.map((finding) => finding.line)).toEqual([7, 13, 15]);
  });
});

describe('work-path scanner: this repository', () => {
  it('has no UNPINNED repo-root work input', () => {
    const { unlisted } = compareAllowlist(scanWorkPathUses(REPO_ROOT), ALLOWED_REPO_ROOT_READS);
    expect(
      unlisted.map((finding) => `${finding.file}:${finding.line}  ${finding.consumer}  ${JSON.stringify(finding.literal)}`),
      'a new read of the gitignored work/ directory: make the input a tracked fixture ' +
        '(tests/fixtures/**) or, if it is genuinely not a fixture (a temp root, or a production ' +
        'tool whose artifact contract IS work/), add a pinned entry with a reason to ' +
        'ALLOWED_REPO_ROOT_READS in this file.'
    ).toEqual([]);
  });

  it('has no STALE pin (every allowlist entry still matches a real read)', () => {
    const { stale } = compareAllowlist(scanWorkPathUses(REPO_ROOT), ALLOWED_REPO_ROOT_READS);
    expect(
      stale.map((entry) => `${entry.identityKey} (${entry.kind})`),
      'an allowlist entry no longer matches any read: the code moved or the pin rotted. ' +
        'Re-derive the pin from the current scan instead of leaving a dead entry behind.'
    ).toEqual([]);
  });

  it('pins only repo-root-INPUT kinds (an allowlist may never bless a write-only use)', () => {
    for (const entry of ALLOWED_REPO_ROOT_READS) {
      expect(['repo-root-input', 'unresolved-root-input']).toContain(entry.kind);
      // Every reason must say WHY, not restate the entry: a pin whose "reason"
      // is a label is a rubber stamp, so a minimum length is asserted.
      expect(entry.reason.length, `${entry.identityKey} needs a real reason`).toBeGreaterThan(120);
    }
  });

  it('classifies the P3-C gate test itself as reading only TRACKED fixtures and temp roots', () => {
    const occurrences = scanWorkPathUses(REPO_ROOT).filter((occurrence) => occurrence.file === GATE_TEST);
    // Non-vacuity: the file DOES mention work/ (the verifier's throw-away root
    // has to contain one), so an empty result would mean the file moved.
    expect(occurrences.length).toBeGreaterThan(0);
    expect(inputFindings(occurrences)).toEqual([]);
    for (const occurrence of occurrences) {
      expect(['temp-root', 'content', 'path-value']).toContain(occurrence.kind);
    }
  });

  /**
   * The WRITE side of G5, pinned with its reason.
   *
   * G5 permits `work/` as an OUTPUT/temp directory; what it forbids is reading
   * pre-existing content from it. The repository has exactly two such writes, and
   * both are recorded here so "work/ is mentioned somewhere" cannot silently
   * become "work/ is used as an input somewhere":
   *   - `tests/unit/persistence/fixtures.ts` creates `work/persistence-tmp` per
   *     test (`mkdtemp`) and deletes it afterwards. It never reads what is already
   *     there, so a missing directory is fine (`mkdir -p`) and a leftover one is
   *     irrelevant. NOT migrated to `os.tmpdir()` on purpose: the comment in that
   *     file records that the repo-relative location is what keeps the suites
   *     working under a workspace-write sandbox, and A-t8-6 only requires the
   *     migration if the fixture is changed for another reason.
   *   - `scripts/verify-readme-counts.mjs` writes its temporary esbuild bundle
   *     under `work/` and deletes it; `scripts/eval/eval-pr4a-five-arm.mjs`
   *     writes the eval artifacts there (that IS its output contract).
   */
  it('records every repo-root work WRITE with its reason (writes are allowed by G5)', () => {
    const writes = scanWorkPathUses(REPO_ROOT).filter(
      (occurrence) => occurrence.kind === 'repo-root-output'
    );
    const writeFiles = [...new Set(writes.map((occurrence) => occurrence.file))].sort();
    expect(writeFiles).toEqual([
      'scripts/eval/eval-pr4a-five-arm.mjs',
      'scripts/eval/verify-pr4a-artifacts.mjs',
      'scripts/verify-readme-counts.mjs',
      'tests/unit/persistence/fixtures.ts'
    ]);
    // The persistence fixture is the only TEST-side writer, and it is a temp-dir
    // creator: assert that it is mkdir/mkdtemp and never a read of the repo work/.
    const persistence = writes.filter((occurrence) => occurrence.file === 'tests/unit/persistence/fixtures.ts');
    expect(persistence.length).toBeGreaterThan(0);
    for (const occurrence of persistence) {
      expect(['mkdirSync', 'mkdir', 'mkdtempSync', 'mkdtemp']).toContain(occurrence.consumer);
    }
    const persistenceSource = readFileSync(join(REPO_ROOT, 'tests', 'unit', 'persistence', 'fixtures.ts'), 'utf8');
    expect(persistenceSource).not.toMatch(/readFileSync|readdirSync|readFile\(|copyFileSync/);
  });
});

describe('the P3-C suite fails closed instead of skipping', () => {
  /** Run vitest on the gate test with `env` overrides; returns exit code + output. */
  function runGateSuite(env: Record<string, string> = {}): { status: number | null; output: string } {
    const result = spawnSync(process.execPath, [VITEST_ENTRY, 'run', GATE_TEST], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      timeout: 600_000,
      maxBuffer: 64 * 1024 * 1024
    });
    return { status: result.status, output: (result.stdout ?? '') + (result.stderr ?? '') };
  }

  it('contains no skip/todo marker (a skipped evidence test would look green)', () => {
    const text = readFileSync(join(REPO_ROOT, ...GATE_TEST.split('/')), 'utf8');
    const markers = [/it[.]skip/, /describe[.]skip/, /test[.]skip/, /[.]todo[(]/, /it[.]todo/];
    const hits = markers.filter((marker) => marker.test(text)).map((marker) => String(marker));
    expect(hits, 'the gate must FAIL on a missing input, never be skipped').toEqual([]);
  });

  it('exits NON-ZERO when the fixture manifest is missing', () => {
    const copy = makeTemp('work-gate-nomanifest-');
    cpSync(FIXTURE_DIR, copy, { recursive: true });
    rmSync(join(copy, 'fixture-manifest.json'));
    const result = runGateSuite({ PR4A_FIXTURE_DIR: copy });
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain('PR-4A fixture manifest is missing');
  });

  it('exits NON-ZERO when the REQUIRED artifact is missing', () => {
    const copy = makeTemp('work-gate-noartifact-');
    cpSync(FIXTURE_DIR, copy, { recursive: true });
    rmSync(join(copy, 'pr4a-five-arm-eval.json'));
    const result = runGateSuite({ PR4A_FIXTURE_DIR: copy });
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain('PR-4A fixture is missing');
  });

  it('exits NON-ZERO when a fixture byte drifts (sha256 mismatch)', () => {
    const copy = makeTemp('work-gate-drift-');
    cpSync(FIXTURE_DIR, copy, { recursive: true });
    const target = join(copy, 'pr4a-five-arm-eval.json');
    writeFileSync(target, readFileSync(target, 'utf8').replace('PR4A-EVAL-PREREG-20261027-V2', 'PR4A-EVAL-PREREG-20261027-V3'), 'utf8');
    const result = runGateSuite({ PR4A_FIXTURE_DIR: copy });
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toMatch(/sha256 drifted|byte length drifted/);
  });
});

describe('the frozen fixture set is complete in a checkout', () => {
  interface ManifestEntry {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly optional: boolean;
  }
  interface Manifest {
    readonly fileCount: number;
    readonly totalBytes: number;
    readonly files: readonly ManifestEntry[];
  }

  const manifestPath = join(FIXTURE_DIR, 'fixture-manifest.json');

  it('lists every fixture file, with a digest that matches the bytes on disk', () => {
    expect(existsSync(manifestPath), 'fixture-manifest.json must be tracked with the fixtures').toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;

    // A checkout must contain the WHOLE set: `optional` records the A-t8-2
    // deletion-experiment result (not an input to the five cases), never a
    // licence to omit a file from the repository.
    expect(manifest.files).toHaveLength(manifest.fileCount);
    let total = 0;
    for (const entry of manifest.files) {
      const absolute = join(FIXTURE_DIR, ...entry.path.split('/'));
      expect(existsSync(absolute), `${entry.path} must be present in the checkout`).toBe(true);
      const bytes = readFileSync(absolute);
      expect(bytes.length, `${entry.path} byte length`).toBe(entry.bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), `${entry.path} sha256`).toBe(entry.sha256);
      total += bytes.length;
    }
    expect(total).toBe(manifest.totalBytes);
  });

  it('keeps every fixture file plain LF text (no CR, no NUL, no BOM)', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    for (const entry of manifest.files) {
      const bytes = readFileSync(join(FIXTURE_DIR, ...entry.path.split('/')));
      expect(bytes.includes(0x00), `${entry.path} must not contain NUL`).toBe(false);
      expect(bytes.includes(0x0d), `${entry.path} must not contain CR`).toBe(false);
      const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
      expect(bom, `${entry.path} must not start with a BOM`).toBe(false);
    }
  });

  it('holds no file the manifest does not describe (no untracked extra inputs)', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    const described = new Set(manifest.files.map((entry) => entry.path));
    // `.gitattributes` is policy, not a fixture; every other file must be listed.
    const allowedExtra = new Set(['fixture-manifest.json', '.gitattributes']);
    const present = execFileSync('git', ['ls-files', '--others', '--cached', '--exclude-standard', '--', 'tests/fixtures/pr4a'], {
      cwd: REPO_ROOT,
      encoding: 'utf8'
    })
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => line.split('/').pop() ?? '')
      .filter((name) => !allowedExtra.has(name));
    for (const name of present) {
      expect(described.has(name), `${name} sits in tests/fixtures/pr4a but is not in the manifest`).toBe(true);
    }
  });

  it('declares the frozen bytes eol=lf so a core.autocrlf checkout cannot rewrite them', () => {
    // git resolves the effective attribute; asking it is stronger than reading
    // the .gitattributes text, because it also proves the pattern actually binds.
    const output = execFileSync('git', ['check-attr', 'text', 'eol', '--'].concat(
      ['pr4a-five-arm-eval.json', 'pr4a-ledger-Arm-0.jsonl'].map((name) => join('tests', 'fixtures', 'pr4a', name))
    ), { cwd: REPO_ROOT, encoding: 'utf8' });
    for (const line of output.trim().split('\n')) {
      expect(line, 'every frozen fixture must be declared text eol=lf').not.toContain('unspecified');
    }
    expect(output).toContain('eol: lf');
  });
});
