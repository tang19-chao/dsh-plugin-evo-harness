/**
 * ADR 0005 §4 (D4): docs-gate contract tests for the configuration reference
 * and the failed/pending refusal of `check:docs`.
 *
 * What is pinned, and why:
 *  - The gate must walk the REAL `DEFAULT_EVO_HARNESS_CONFIG` (75 leaves at
 *    the time of writing; arrays count as ONE leaf with a `[]` suffix) plus the
 *    three `MODEL_ROUTE_DEFAULTS` fields, and must fail when the README
 *    Configuration reference is missing a leaf, documents a stale leaf, or
 *    drifts a documented default value. The count 78 is asserted here ONLY as
 *    an observation pin (explain text), never as the gate's criterion — the
 *    gate itself hard-codes no number.
 *  - The gate must REFUSE a report that carries failing tests
 *    (`numFailedTests > 0`) or pending/skipped tests (`numPendingTests > 0`):
 *    the README claims "passing tests", so a failing run must never mint green
 *    documentation counts. The refusal fires even when the counts happen to
 *    MATCH the report, which is exactly the hole ADR 0005 F-14 describes.
 *  - Cleanup invariants: consumed root reports, temporary Vitest reports and
 *    temporary gate artifacts are never left behind in the fixture repo.
 *
 * HOW the tests drive the gate: the gate is executed as a CHILD PROCESS
 * (`node scripts/verify-readme-counts.mjs ...`) with `cwd` pointed at a
 * per-test fixture directory under the OS temp dir, exactly as CI would run
 * it. No test mutates the real repository; the real README is only READ.
 *
 * Flag surface used here (documented in the gate header):
 *  - `--docs-only` verifies only the configuration reference (no report);
 *  - `--report <file>` consumes an existing report (never deleted);
 *  - `--readme <file>` verifies an alternative README;
 *  - `--dump-leaves` prints the traversed leaf paths as JSON.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_EVO_HARNESS_CONFIG } from '../../../src/config';
import { MODEL_ROUTE_DEFAULTS } from '../../../src/dsh-bridge/model-config';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const gateScript = path.join(repoRoot, 'scripts', 'verify-readme-counts.mjs');
const realReadme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

/** Temp dirs created by this suite; removed in afterAll. */
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs.reverse()) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Read-only leaf traversal mirroring the gate's contract (test-side oracle). */
function collectLeaves(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) {
    return [prefix + '[]'];
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      collectLeaves(child, prefix ? prefix + '.' + key : key)
    );
  }
  return [prefix];
}

const expectedLeaves: string[] = [
  ...collectLeaves(DEFAULT_EVO_HARNESS_CONFIG).filter((leaf) => leaf !== ''),
  ...Object.keys(MODEL_ROUTE_DEFAULTS).map((key) => 'modelRoute.' + key)
];

/**
 * Build a Configuration reference whose rows are generated from the REAL
 * defaults, so a fixture is always initially consistent (a negative test then
 * perturbs exactly one row).
 */
function buildReferenceRows(): string[] {
  const defaults = DEFAULT_EVO_HARNESS_CONFIG as unknown as Record<string, unknown>;
  const rows: string[] = [];
  const format = (value: unknown): string => {
    if (Array.isArray(value)) {
      return JSON.stringify(value);
    }
    if (typeof value === 'object' && value !== null) {
      return JSON.stringify(value);
    }
    if (typeof value === 'string') {
      return JSON.stringify(value);
    }
    return String(value);
  };
  const walk = (value: unknown, prefix: string): void => {
    if (Array.isArray(value)) {
      rows.push('| `' + prefix + '[]` | `' + format(value) + '` | meaning |');
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        walk(child, prefix ? prefix + '.' + key : key);
      }
      return;
    }
    rows.push('| `' + prefix + '` | `' + format(value) + '` | meaning |');
  };
  walk(defaults, '');
  for (const [key, value] of Object.entries(MODEL_ROUTE_DEFAULTS)) {
    rows.push('| `modelRoute.' + key + '` | `' + format(value) + '` | second-level settings page |');
  }
  return rows;
}

function fixtureReadme(referenceRows: string[]): string {
  return [
    '# Fixture',
    '',
    '## Configuration reference',
    '',
    'Defaults live in src/config.ts.',
    '',
    '| Option | Default | Meaning |',
    '| :--- | :--- | :--- |',
    ...referenceRows,
    '',
    '## How it works',
    '',
    'reports `1` test files and `2` passing tests for `pnpm run test`',
    '',
    '| Command | Scope | Suites |',
    '| :--- | :--- | :--- |',
    '| `pnpm run test:unit` | `tests/unit` | 1 files, 2 tests |',
    '| `pnpm run test:e2e` | `tests/e2e` | 0 files, 0 tests |',
    '| `pnpm run test` | everything | 1 files, 2 tests |',
    ''
  ].join('\n');
}

function makeFixtureDir(label: string, readme: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-leaves-' + label + '-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'README.md'), readme, 'utf8');
  return dir;
}

/**
 * A report file name shaped like the real Vitest JSON (absolute, forward
 * slashes after the gate's own normalization), so the gate's legacy
 * `includes('/tests/unit/')` unit/e2e split sees the fixture the same way it
 * sees a live report.
 */
const fixtureReportFile = '/virtual/tests/unit/a.test.ts';

interface GateRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run the gate against a fixture repo. Fixture paths are injected through
 * `cwd` + `--readme`/`--report` RELATIVE paths, so no argv ever contains the
 * temp-dir absolute path (the `--`-argument mis-parse guard is exercised by
 * dedicated tests below).
 */
function runGate(cwd: string, args: string[]): GateRun {
  const result = spawnSync(process.execPath, [gateScript, ...args], {
    cwd,
    encoding: 'utf8'
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Assert the gate left no temp/consumed report residue in the fixture repo. */
function assertNoResidue(cwd: string): void {
  expect(fs.existsSync(path.join(cwd, 'test-results.json'))).toBe(false);
  const workDir = path.join(cwd, 'work');
  if (fs.existsSync(workDir)) {
    const leftovers = fs
      .readdirSync(workDir)
      .filter((name) => name.startsWith('docs-verify-') || name.startsWith('dsh-evo-test-results-'));
    expect(leftovers).toEqual([]);
  }
}

describe('readme default-leaf docs gate (ADR 0005 §4 D4)', () => {
  it('walks the real defaults into 78 documented leaf paths (75 DEFAULT + 3 modelRoute, arrays as one)', () => {
    // The gate criterion is the traversal, never the number; this pin exists
    // so a silent change of the leaf COUNT is at least observable here.
    expect(expectedLeaves).toHaveLength(78);
    expect(expectedLeaves.filter((leaf) => leaf.startsWith('modelRoute.'))).toEqual([
      'modelRoute.provider',
      'modelRoute.model',
      'modelRoute.reasoningEffort'
    ]);
    // Arrays are ONE leaf with a [] suffix, matching the documented paths.
    expect(expectedLeaves).toContain('enabledSurfaces[]');
    expect(expectedLeaves).toContain('dreamRsi.rhoPreferences[]');
    expect(expectedLeaves).toContain('jitrl.levels[]');
    expect(expectedLeaves).toContain('jitrl.dream.candidateJitBetas[]');
    expect(expectedLeaves).toContain('jitrl.dream.candidateJitLambdas[]');
    // The 40 previously undocumented leaves are all part of the traversal.
    expect(expectedLeaves).toContain('dreamRsi.holdoutTreeCount');
    expect(expectedLeaves).toContain('execution.mode');
    expect(expectedLeaves).toContain('execution.applyWinningPatch');
    expect(expectedLeaves.filter((leaf) => leaf.startsWith('jitrl.'))).toHaveLength(37);
  });

  it('the shipped README documents every default leaf with the real default values', () => {
    const dir = makeFixtureDir('real', realReadme);
    const run = runGate(dir, ['--docs-only', '--readme', 'README.md']);
    expect({ status: run.status, stderr: run.stderr }).toMatchObject({ status: 0 });
    expect(run.stdout).toContain('Config reference coverage: 78 documented row(s) vs 78 expected');
    expect(run.stdout).toContain('documents every default leaf');
    // D4 §2: the corrected promoteOnComposeSuccess default must be false.
    expect(realReadme).toContain('| `memoryBridge.promoteOnComposeSuccess` | `false` |');
    // D4 §3: the modelRoute rows must state their host-only applicability.
    expect(realReadme).toContain('second-level settings page');
    expect(realReadme).toContain('**not** a root key of');
    // D4 §1: the previously missing groups must have real rows.
    expect(realReadme).toContain('| `execution.mode` |');
    expect(realReadme).toContain('| `execution.applyWinningPatch` |');
    expect(realReadme).toContain('| `dreamRsi.holdoutTreeCount` |');
    expect(realReadme).toContain('| `jitrl.enabled` |');
    assertNoResidue(dir);
  });

  it('fails and names the leaf when a documented leaf is missing', () => {
    const rows = buildReferenceRows().filter((row) => !row.startsWith('| `jitrl.enabled`'));
    const dir = makeFixtureDir('missing', fixtureReadme(rows));
    const run = runGate(dir, ['--docs-only', '--readme', 'README.md']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('missing-leaf: jitrl.enabled');
    expect(run.stderr).toContain('does not match the real defaults');
    assertNoResidue(dir);
  });

  it('fails and names the row when a stale leaf is documented', () => {
    const rows = [
      ...buildReferenceRows(),
      '| `memoryBridge.promoteOnComposeSuccessOld` | `true` | stale |'
    ];
    const dir = makeFixtureDir('stale', fixtureReadme(rows));
    const run = runGate(dir, ['--docs-only', '--readme', 'README.md']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('stale-leaf: memoryBridge.promoteOnComposeSuccessOld');
    assertNoResidue(dir);
  });

  it('fails and prints both sides when a documented default value drifts', () => {
    const rows = buildReferenceRows().map((row) =>
      row.startsWith('| `memoryBridge.promoteOnComposeSuccess`')
        ? row.replace('`false`', '`true`')
        : row
    );
    const dir = makeFixtureDir('drift', fixtureReadme(rows));
    const run = runGate(dir, ['--docs-only', '--readme', 'README.md']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('default-mismatch: memoryBridge.promoteOnComposeSuccess');
    expect(run.stderr).toContain('the real default is `false`');
    assertNoResidue(dir);
  });

  it('refuses a report with numFailedTests > 0 even when the counts would match', () => {
    const dir = makeFixtureDir('failed', fixtureReadme(buildReferenceRows()));
    // Counts deliberately MATCH the report: README summary 2 files / 4 tests,
    // and the report carries 2 files / 4 tests / 1 failure / 0 pending.
    fs.writeFileSync(
      path.join(dir, 'README.md'),
      fixtureReadme(buildReferenceRows()).replace(
        'reports `1` test files and `2` passing tests for `pnpm run test`',
        'reports `2` test files and `3` passing tests for `pnpm run test`'
      ),
      'utf8'
    );
    fs.writeFileSync(
      path.join(dir, 'failed-report.json'),
      JSON.stringify({
        numTotalTests: 4,
        numPassedTests: 3,
        numFailedTests: 1,
        numPendingTests: 0,
        testResults: [
          {
            name: fixtureReportFile,
            assertionResults: [
              { fullName: 'a passes', status: 'passed', title: 'a passes' },
              { fullName: 'b fails loudly', status: 'failed', title: 'b fails loudly' }
            ]
          },
          {
            name: fixtureReportFile,
            assertionResults: [
              { fullName: 'c passes', status: 'passed', title: 'c passes' },
              { fullName: 'd passes', status: 'passed', title: 'd passes' }
            ]
          }
        ]
      }),
      'utf8'
    );
    const run = runGate(dir, ['--report', 'failed-report.json']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('carries 1 failed test(s)');
    expect(run.stderr).toContain('b fails loudly');
    // No count-based green light may be minted from a failing report.
    expect(run.stdout).not.toContain('match Vitest results exactly');
    expect(run.stdout).not.toContain('[docs-verify] SUCCESS');
    assertNoResidue(dir);
    // An explicit --report file is never deleted by the gate.
    expect(fs.existsSync(path.join(dir, 'failed-report.json'))).toBe(true);
  });

  it('refuses a report with pending tests (numPendingTests > 0)', () => {
    const dir = makeFixtureDir('pending', fixtureReadme(buildReferenceRows()));
    fs.writeFileSync(
      path.join(dir, 'pending-report.json'),
      JSON.stringify({
        numTotalTests: 2,
        numPassedTests: 1,
        numFailedTests: 0,
        numPendingTests: 1,
        testResults: [
          {
            name: fixtureReportFile,
            assertionResults: [
              { fullName: 'a passes', status: 'passed', title: 'a passes' },
              { fullName: 'b is skipped', status: 'skipped', title: 'b is skipped' }
            ]
          }
        ]
      }),
      'utf8'
    );
    const run = runGate(dir, ['--report', 'pending-report.json']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('pending/skipped test(s)');
    expect(run.stderr).toContain('b is skipped');
    expect(run.stdout).not.toContain('[docs-verify] SUCCESS');
    assertNoResidue(dir);
  });

  it('accepts an all-green report and verifies the counts against it', () => {
    const dir = makeFixtureDir('green', fixtureReadme(buildReferenceRows()));
    // README claims 1 file / 2 tests; the report says exactly that.
    fs.writeFileSync(
      path.join(dir, 'green-report.json'),
      JSON.stringify({
        numTotalTests: 2,
        numPassedTests: 2,
        numFailedTests: 0,
        numPendingTests: 0,
        testResults: [
          {
            name: fixtureReportFile,
            assertionResults: [
              { fullName: 'a passes', status: 'passed', title: 'a passes' },
              { fullName: 'b passes', status: 'passed', title: 'b passes' }
            ]
          }
        ]
      }),
      'utf8'
    );
    const run = runGate(dir, ['--report', 'green-report.json', '--readme', 'README.md']);
    expect({ status: run.status, stderr: run.stderr }).toMatchObject({ status: 0 });
    expect(run.stdout).toContain('zero failed and zero pending tests');
    expect(run.stdout).toContain('match Vitest results exactly');
    assertNoResidue(dir);
    expect(fs.existsSync(path.join(dir, 'green-report.json'))).toBe(true);
  });

  it('exposes the traversed leaf paths through --dump-leaves (fixture-free)', () => {
    const dir = makeFixtureDir('dump', fixtureReadme(buildReferenceRows()));
    const run = runGate(dir, ['--dump-leaves']);
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout) as {
      defaultLeaves: string[];
      modelRouteLeaves: string[];
      defaultLeafCount: number;
      modelRouteLeafCount: number;
    };
    expect(parsed.defaultLeafCount).toBe(75);
    expect(parsed.modelRouteLeafCount).toBe(3);
    expect(parsed.modelRouteLeaves).toEqual([
      'modelRoute.provider',
      'modelRoute.model',
      'modelRoute.reasoningEffort'
    ]);
    expect(parsed.defaultLeaves).toContain('dreamRsi.holdoutTreeCount');
    expect(parsed.defaultLeaves).toContain('jitrl.privacy.redactSecrets');
    assertNoResidue(dir);
  });

  it('treats a literal `--` argument as a file name (no flag parsing in values)', () => {
    const rows = buildReferenceRows().filter((row) => !row.startsWith('| `logging.level`'));
    const dir = makeFixtureDir('dashdash', fixtureReadme(rows));
    // A file literally named `--docs-only` exists in the fixture; passing it as
    // the --readme VALUE proves values are consumed verbatim: the gate must
    // fail on the missing leaf, not crash on an unknown flag.
    fs.writeFileSync(path.join(dir, '--docs-only'), fixtureReadme(rows), 'utf8');
    const run = runGate(dir, ['--docs-only', '--readme', '--docs-only']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('missing-leaf: logging.level');
    expect(run.stderr).not.toContain('Unknown flag');
    assertNoResidue(dir);
  });
});

/**
 * R-04: the three-way count-closure and test-root attribution checks.
 *
 * What is pinned, and why:
 *  - The gate asserts unit + e2e == total on BOTH sides (README and report) and
 *    that the summary line equals the table total — WITHOUT depending on any
 *    absolute number, so the assertions stay meaningful while the counts move.
 *  - EVERY consumed test file must live under `tests/unit/` or `tests/e2e/`:
 *    a third test root means the documented two-suite breakdown cannot describe
 *    the real run, and the gate must fail by NAME instead of silently dropping
 *    those files from every count it verifies.
 *  - The shipped README must close TODAY (its own unit + e2e == total), which is
 *    what makes the closure assertion a regression guard rather than a tautology.
 */
describe('count closure and test-root attribution (R-04)', () => {
  /** Read the README's own unit/e2e/total numbers with the gate's row shapes. */
  function readmeCounts(readme: string): {
    summary: [number, number];
    unit: [number, number];
    e2e: [number, number];
    total: [number, number];
  } {
    const summary = readme.match(/reports\s+`(\d+)`\s+test files and\s+`(\d+)`\s+passing tests for\s+`pnpm run test`/i);
    const unit = readme.match(/\|\s*`pnpm run test:unit`\s*\|\s*`tests\/unit`\s*\|\s*(\d+)\s+files,\s*(\d+)\s+tests\s*\|/i);
    const e2e = readme.match(/\|\s*`pnpm run test:e2e`\s*\|\s*`tests\/e2e`\s*\|\s*(\d+)\s+files,\s*(\d+)\s+tests\s*\|/i);
    const total = readme.match(/\|\s*`pnpm run test`\s*\|\s*everything\s*\|\s*(\d+)\s+files,\s*(\d+)\s+tests\s*\|/i);
    expect(summary).not.toBeNull();
    expect(unit).not.toBeNull();
    expect(e2e).not.toBeNull();
    expect(total).not.toBeNull();
    return {
      summary: [Number(summary![1]), Number(summary![2])],
      unit: [Number(unit![1]), Number(unit![2])],
      e2e: [Number(e2e![1]), Number(e2e![2])],
      total: [Number(total![1]), Number(total![2])]
    };
  }

  it('the shipped README closes today: unit + e2e == total, and the summary equals the total row', () => {
    const counts = readmeCounts(realReadme);
    expect(counts.unit[0] + counts.e2e[0]).toBe(counts.total[0]);
    expect(counts.unit[1] + counts.e2e[1]).toBe(counts.total[1]);
    expect(counts.summary[0]).toBe(counts.total[0]);
    expect(counts.summary[1]).toBe(counts.total[1]);
  });

  it('fails and names the file when a test file lives in a third test root', () => {
    const dir = makeFixtureDir('third-root', fixtureReadme(buildReferenceRows()));
    // README numbers deliberately MATCH the report, so the ONLY failures are the
    // two new assertion classes (attribution + report-side closure).
    fs.writeFileSync(
      path.join(dir, 'README.md'),
      fixtureReadme(buildReferenceRows())
        .replace('reports `1` test files and `2` passing tests for `pnpm run test`', 'reports `2` test files and `4` passing tests for `pnpm run test`')
        .replace('| `pnpm run test:unit` | `tests/unit` | 1 files, 2 tests |', '| `pnpm run test:unit` | `tests/unit` | 1 files, 2 tests |')
        .replace('| `pnpm run test` | everything | 1 files, 2 tests |', '| `pnpm run test` | everything | 2 files, 4 tests |'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(dir, 'third-root-report.json'),
      JSON.stringify({
        numTotalTests: 4,
        numPassedTests: 4,
        numFailedTests: 0,
        numPendingTests: 0,
        testResults: [
          {
            name: fixtureReportFile,
            assertionResults: [
              { fullName: 'a passes', status: 'passed', title: 'a passes' },
              { fullName: 'b passes', status: 'passed', title: 'b passes' }
            ]
          },
          {
            name: '/virtual/tests/integration/b.test.ts',
            assertionResults: [
              { fullName: 'c passes', status: 'passed', title: 'c passes' },
              { fullName: 'd passes', status: 'passed', title: 'd passes' }
            ]
          }
        ]
      }),
      'utf8'
    );
    const run = runGate(dir, ['--report', 'third-root-report.json', '--readme', 'README.md']);
    expect(run.status).toBe(1);
    // 1. attribution: the third-root file is named, never silently dropped.
    expect(run.stderr).toContain('outside the documented test roots');
    expect(run.stderr).toContain('unattributed-root: /virtual/tests/integration/b.test.ts');
    // 2. report-side closure: unit + e2e can no longer equal the total.
    expect(run.stderr).toContain('Vitest counts do not close');
    // The README-side numbers matched the report, so no README absolute-number
    // mismatch is manufactured here beyond the closure itself.
    assertNoResidue(dir);
  });

  it('fails when the README counts do not close (unit + e2e != total)', () => {
    const dir = makeFixtureDir('unclosed', fixtureReadme(buildReferenceRows()));
    // unit claims 1 test but the report says 2, and the README rows then cannot
    // close: 1 + 0 != 2. Both the equality check and the closure check fire.
    fs.writeFileSync(
      path.join(dir, 'README.md'),
      fixtureReadme(buildReferenceRows()).replace('| `pnpm run test:unit` | `tests/unit` | 1 files, 2 tests |', '| `pnpm run test:unit` | `tests/unit` | 1 files, 1 tests |'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(dir, 'green-report.json'),
      JSON.stringify({
        numTotalTests: 2,
        numPassedTests: 2,
        numFailedTests: 0,
        numPendingTests: 0,
        testResults: [
          {
            name: fixtureReportFile,
            assertionResults: [
              { fullName: 'a passes', status: 'passed', title: 'a passes' },
              { fullName: 'b passes', status: 'passed', title: 'b passes' }
            ]
          }
        ]
      }),
      'utf8'
    );
    const run = runGate(dir, ['--report', 'green-report.json', '--readme', 'README.md']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('README counts do not close (tests): unit (1) + e2e (0) != total (2)');
    expect(run.stderr).toContain('Table unit tests mismatch');
    assertNoResidue(dir);
  });

  it('reports the closure line when the two documented roots close exactly', () => {
    const dir = makeFixtureDir('closed', fixtureReadme(buildReferenceRows()));
    fs.writeFileSync(
      path.join(dir, 'green-report.json'),
      JSON.stringify({
        numTotalTests: 2,
        numPassedTests: 2,
        numFailedTests: 0,
        numPendingTests: 0,
        testResults: [
          {
            name: fixtureReportFile,
            assertionResults: [
              { fullName: 'a passes', status: 'passed', title: 'a passes' },
              { fullName: 'b passes', status: 'passed', title: 'b passes' }
            ]
          }
        ]
      }),
      'utf8'
    );
    const run = runGate(dir, ['--report', 'green-report.json', '--readme', 'README.md']);
    expect({ status: run.status, stderr: run.stderr }).toMatchObject({ status: 0 });
    expect(run.stdout).toContain('Counts close: unit + e2e == total');
    assertNoResidue(dir);
  });

  /**
   * KNOWN COVERAGE GAP RATCHET — NOT a claim that the branch is exercised.
   *
   * The gate's inner-run try/catch has two exits: (a) vitest fails AND leaves a
   * report -> name the failures and continue; (b) vitest fails and leaves NO
   * report -> rethrow. (a) is pinned by the two tests above. (b) cannot be staged
   * from a fixture: the gate resolves `rootDir` from its own `__dirname`, so the
   * inner run is always this repository's real, currently-green suite, and no argv
   * or cwd a test may pass can redirect it.
   *
   * So instead of a fake test, this ratchet pins the guard's TEXT: if someone
   * deletes the rethrow, the assertion below goes red and they must come here and
   * read why it existed. Deleting it still fails CLOSED (proceeding would raise
   * ENOENT and main() exits non-zero) — what is lost is only the accurate
   * "the inner run failed" message, which is exactly the misattribution the
   * try/catch was added to remove.
   *
   * RELEASE CONDITION: delete this ratchet in the SAME change that gives the gate
   * an injectable command or rootDir (at which point branch (b) becomes stageable
   * and must get a real test), or that removes the guard.
   */
  it('keeps the untestable no-report rethrow guard, and says why (ratchet)', () => {
    const source = fs.readFileSync(gateScript, 'utf8');
    expect(source).toContain('if (!fs.existsSync(tempReportFile)) {');
    expect(source).toContain('throw runError;');
    // The guard must live INSIDE the catch, not in the happy path.
    const catchIndex = source.indexOf('} catch (runError) {');
    expect(catchIndex).toBeGreaterThan(-1);
    expect(source.indexOf('if (!fs.existsSync(tempReportFile)) {')).toBeGreaterThan(catchIndex);
  });
});