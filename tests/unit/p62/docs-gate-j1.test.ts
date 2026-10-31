/**
 * rev5 P0-3 / J-1: the documentation gate must refuse a report that is
 * count-complete but describes a BROKEN run.
 *
 * THE GAP THIS PINS (measured on HEAD 97e38db before this fix)
 * -----------------------------------------------------------
 * `scripts/verify-readme-counts.mjs` only looked at `numFailedTests`,
 * `numPendingTests` and per-assertion statuses. A report whose counts matched
 * the README exactly but which carried `success=false`, `numFailedTestSuites=1`,
 * a non-empty `unhandledErrors`, or `numTodoTests=1` produced exit 0 and
 * "documentation gate fully green". That is exactly the case CI hits when a
 * worker dies, an unhandled rejection escapes, a suite fails to collect, or a
 * test is left as todo without changing the passing-test counts
 * (`docs/reports/p2-p6-integration-round.md` row 15, J-1).
 *
 * WHAT IS ASSERTED, AND WHY EACH CASE IS A NEGATIVE CONTROL
 * ---------------------------------------------------------
 *   - a normal report exits 0 and says the gate is fully green;
 *   - each of the four run-level injections exits 1 and NAMES the reason;
 *   - a count mismatch still exits 1 (the pre-existing regression guard);
 *   - a report that omits any run-level field exits 1 as `partial-report`
 *     (absent evidence is not evidence of success — captain ruling C-10).
 *
 * NO HARD-CODED COUNTS
 * --------------------
 * The synthetic report is built FROM the README's current numbers at test time
 * (and asserted to close), so the suite keeps working after later tasks add or
 * remove tests. The gate's README count check is only satisfied when the report
 * totals equal the README — the fixture therefore cannot accidentally pass by
 * using a stale 130/2493 snapshot.
 *
 * The gate is executed as a child process against a temp report file, exactly
 * as CI would run it. The repository's own README is only READ, and explicit
 * `--report` files are never deleted by the gate.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const gateScript = path.join(repoRoot, 'scripts', 'verify-readme-counts.mjs');
const realReadmePath = path.join(repoRoot, 'README.md');
const realReadme = fs.readFileSync(realReadmePath, 'utf8');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-gate-j1-'));

afterAll(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // A leftover temp dir must not turn a green suite red.
  }
});

interface ReadmeCounts {
  summaryFiles: number;
  summaryTests: number;
  unitFiles: number;
  unitTests: number;
  e2eFiles: number;
  e2eTests: number;
  totalFiles: number;
  totalTests: number;
}

/**
 * Read the README's own numbers with the SAME row shapes the gate parses. A
 * missing row is a hard failure: the fixture cannot silently fall back to a
 * number.
 */
function readmeCounts(): ReadmeCounts {
  const summary = realReadme.match(/reports\s+`(\d+)`\s+test files and\s+`(\d+)`\s+passing tests for\s+`pnpm run test`/i);
  const unit = realReadme.match(/\|\s*`pnpm run test:unit`\s*\|\s*`tests\/unit`\s*\|\s*(\d+)\s+files,\s*(\d+)\s+tests\s*\|/i);
  const e2e = realReadme.match(/\|\s*`pnpm run test:e2e`\s*\|\s*`tests\/e2e`\s*\|\s*(\d+)\s+files,\s*(\d+)\s+tests\s*\|/i);
  const total = realReadme.match(/\|\s*`pnpm run test`\s*\|\s*everything\s*\|\s*(\d+)\s+files,\s*(\d+)\s+tests\s*\|/i);
  if (summary === null || unit === null || e2e === null || total === null) {
    throw new Error('README count rows are missing; the J-1 fixture cannot derive current counts');
  }
  return {
    summaryFiles: Number(summary[1]),
    summaryTests: Number(summary[2]),
    unitFiles: Number(unit[1]),
    unitTests: Number(unit[2]),
    e2eFiles: Number(e2e[1]),
    e2eTests: Number(e2e[2]),
    totalFiles: Number(total[1]),
    totalTests: Number(total[2])
  };
}

interface Assertion {
  fullName: string;
  title: string;
  status: 'passed';
}

interface TestFileResult {
  name: string;
  status: 'passed' | 'failed';
  assertionResults: Assertion[];
}

interface VitestReport {
  numTotalTestSuites: number;
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  numTodoTests: number;
  success: boolean;
  numFailedTestSuites: number;
  unhandledErrors: unknown[];
  testResults: TestFileResult[];
}

/** Build a synthetic report whose counts exactly match the README. */
function baseReport(): VitestReport {
  const counts = readmeCounts();
  // The README stays internally closed across count updates (pinned by
  // readme-default-leaves.test.ts); assert it here so this fixture never
  // manufactures a report the gate could never accept.
  expect(counts.unitFiles + counts.e2eFiles).toBe(counts.totalFiles);
  expect(counts.unitTests + counts.e2eTests).toBe(counts.totalTests);
  expect(counts.summaryFiles).toBe(counts.totalFiles);
  expect(counts.summaryTests).toBe(counts.totalTests);

  const makeFiles = (prefix: 'unit' | 'e2e', fileCount: number, testCount: number): TestFileResult[] => {
    const files: TestFileResult[] = [];
    for (let index = 0; index < fileCount; index += 1) {
      // All leftover assertions go into the first file; the rest get one. The
      // gate only sums assertionResults, so the shape stays realistic enough
      // for its root attribution (each name contains the documented root).
      const assertionCount = index === 0 ? testCount - (fileCount - 1) : 1;
      const assertions: Assertion[] = [];
      for (let inner = 0; inner < Math.max(assertionCount, 1); inner += 1) {
        const title = `${prefix} case ${index}-${inner}`;
        assertions.push({ fullName: title, title, status: 'passed' });
      }
      files.push({
        name: `/virtual/tests/${prefix}/${prefix}-${index}.test.ts`,
        status: 'passed',
        assertionResults: assertions
      });
    }
    return files;
  };

  const testResults = [
    ...makeFiles('unit', counts.unitFiles, counts.unitTests),
    ...makeFiles('e2e', counts.e2eFiles, counts.e2eTests)
  ];
  return {
    numTotalTestSuites: testResults.length,
    numTotalTests: counts.totalTests,
    numPassedTests: counts.totalTests,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    success: true,
    numFailedTestSuites: 0,
    unhandledErrors: [],
    testResults
  };
}

interface GateRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run the gate with an explicit report file; the real README is the reference. */
function runGate(reportFile: string): GateRun {
  const result = spawnSync(
    process.execPath,
    [gateScript, '--report', reportFile, '--readme', realReadmePath],
    { cwd: tempDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Write a report (cloned from the base) under a case-specific name. */
function writeReport(name: string, report: VitestReport): string {
  const file = path.join(tempDir, name);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
  return name;
}

/** Assert a negative control: exit 1, named reason, and no green light. */
function expectRed(run: GateRun, reason: RegExp): void {
  expect(run.status, `expected exit 1; stderr=${run.stderr}`).toBe(1);
  expect(run.stderr).toMatch(reason);
  expect(run.stdout).not.toContain('documentation gate fully green.');
  expect(run.stdout).not.toContain('match Vitest results exactly');
}

describe('J-1: count-complete reports of broken runs are refused', () => {
  it('exits 0 and says fully green for a complete, successful report', () => {
    const report = baseReport();
    // Fixture sanity: the counts really match the README (otherwise the pass
    // below would be a count-mismatch accident, not the normal path).
    expect(report.numTotalTests).toBe(readmeCounts().summaryTests);
    const file = writeReport('normal.json', report);
    const run = runGate(file);
    expect({ status: run.status, stderr: run.stderr }).toMatchObject({ status: 0 });
    expect(run.stdout).toContain('Report describes a complete, successful run');
    expect(run.stdout).toContain('documentation gate fully green.');
    // An explicit --report file is never deleted by the gate.
    expect(fs.existsSync(path.join(tempDir, file))).toBe(true);
  });

  it('refuses success=false even when every count matches', () => {
    const report = baseReport();
    report.success = false;
    expectRed(runGate(writeReport('success-false.json', report)), /success=false/);
  });

  it('refuses numFailedTestSuites > 0 even when no assertion failed', () => {
    const report = baseReport();
    report.numFailedTestSuites = 1;
    // Make the fixture internally plausible: a suite that failed to collect
    // carries no failed assertion, which is precisely why the assertion-count
    // check could not see it.
    report.testResults[0]!.status = 'failed';
    expectRed(runGate(writeReport('failed-suites.json', report)), /numFailedTestSuites=1/);
  });

  it('refuses a non-empty unhandledErrors array', () => {
    const report = baseReport();
    report.unhandledErrors = [{ name: 'Error', message: 'worker crashed after the last assertion' }];
    expectRed(runGate(writeReport('unhandled.json', report)), /unhandledErrors=1.*worker crashed/s);
  });

  it('refuses numTodoTests > 0 (a test that did not run)', () => {
    const report = baseReport();
    report.numTodoTests = 1;
    expectRed(runGate(writeReport('todo.json', report)), /numTodoTests=1/);
  });

  it('refuses a report that omits the run-level fields (partial-report)', () => {
    const report = baseReport() as unknown as Record<string, unknown>;
    delete report.success;
    const run = runGate(writeReport('partial.json', report as unknown as VitestReport));
    expectRed(run, /partial-report/);
    expect(run.stderr).toContain('success (boolean)');
  });

  it('accepts a report that omits unhandledErrors (Vitest 3.2.7 omits it when none)', () => {
    // Measured on Vitest 3.2.7: a green JSON report has no `unhandledErrors`
    // key at all. Requiring the key would make the gate reject every real run,
    // so absence means "none reported by this reporter version"; when present
    // it must be an array (the next test).
    const report = baseReport() as unknown as Record<string, unknown>;
    delete report.unhandledErrors;
    const run = runGate(writeReport('no-unhandled-key.json', report as unknown as VitestReport));
    expect({ status: run.status, stderr: run.stderr }).toMatchObject({ status: 0 });
    expect(run.stdout).toContain('documentation gate fully green.');
  });

  it('refuses a non-array unhandledErrors instead of treating it as empty', () => {
    const report = baseReport() as unknown as Record<string, unknown>;
    report.unhandledErrors = 'not-an-array';
    const run = runGate(writeReport('invalid-unhandled.json', report as unknown as VitestReport));
    expectRed(run, /invalid-report/);
    expect(run.stderr).toContain('not an array');
  });

  it('still refuses a count mismatch (pre-existing regression guard)', () => {
    const report = baseReport();
    report.numTotalTests += 1;
    expectRed(runGate(writeReport('count-mismatch.json', report)), /Summary passing tests mismatch/);
  });
});
