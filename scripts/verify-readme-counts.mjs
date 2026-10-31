#!/usr/bin/env node
/**
 * Mechanical README/docs hygiene gate (PR-1, extended by the P1 docs contract,
 * ADR 0005 §4 decision D4).
 *
 * The gate refuses (exit 1) when:
 *   1. LICENSE / CHANGELOG / README is missing or malformed;
 *   2. the README test-count claims disagree with the Vitest report consumed by
 *      this run (root `test-results.json`, `--report <path>`, or a fresh
 *      temporary Vitest run written to the OS temp dir);
 *   3. the consumed report carries FAILING tests (`numFailedTests > 0`) or
 *      PENDING/SKIPPED/TODO tests (`numPendingTests > 0`) — the README wording
 *      is "passing tests", so a failing run must never be able to mint green
 *      documentation counts. This check runs BEFORE the count comparison, so a
 *      report with failures can never produce a count-only green light.
 *   3b. (J-1, rev5 P0-3) the report is not evidence of a COMPLETE, SUCCESSFUL
 *      run. A count-complete report can still describe a broken run: a dead
 *      worker or an unhandled rejection sets `success=false`, a file that
 *      failed to collect adds `numFailedTestSuites`, and `numTodoTests` counts
 *      tests that did not run. Each of those is refused BY NAME. A report that
 *      omits `success`, `numFailedTestSuites` or `numTodoTests` is refused as
 *      `partial-report` instead of being read as green: absent evidence is not
 *      evidence of success. `unhandledErrors` is optional because Vitest
 *      3.2.7's JSON reporter omits the key when there are none (measured); if
 *      present it must be an array and a non-empty array fails. This is the
 *      J-1 gap in `docs/reports/p2-p6-integration-round.md` row 15; the old
 *      gate only looked at failed/pending assertion counts and let the
 *      injections through.
 *   4. the Configuration reference does not document EVERY default leaf: the
 *      gate bundles `src/config.ts` and `src/dsh-bridge/model-config.ts` with
 *      esbuild, walks the REAL `DEFAULT_EVO_HARNESS_CONFIG` (arrays count as
 *      ONE leaf and are suffixed `[]`, matching the documented paths) plus the
 *      three `MODEL_ROUTE_DEFAULTS` fields, and fails on any missing, stale or
 *      drifted row. The leaf set is never hard-coded — the count is printed as
 *      an observation, the traversal is the criterion.
 *
 * CLI:
 *   node scripts/verify-readme-counts.mjs               full gate (CI mode)
 *   node scripts/verify-readme-counts.mjs --report p    consume an existing
 *                                                       report file (NOT deleted)
 *   node scripts/verify-readme-counts.mjs --readme p    verify a different README
 *   node scripts/verify-readme-counts.mjs --docs-only   skip report/count checks,
 *                                                       verify leaves only
 *   node scripts/verify-readme-counts.mjs --dump-leaves print the traversed leaf
 *                                                       paths as JSON and exit 0
 *
 * Cleanup invariants: the temporary Vitest report (when generated) and the
 * temporary esbuild bundle (always, work/ is a scratch dir) are deleted on
 * exit — success, failure, SIGINT or SIGTERM. A root `test-results.json` that
 * was consumed is deleted as before. External `--report` files are never
 * deleted.
 *
 * Exit codes: 0 = every check passed, 1 = any check failed.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const readmePath = path.join(rootDir, 'README.md');
const licensePath = path.join(rootDir, 'LICENSE');
const changelogPath = path.join(rootDir, 'CHANGELOG.md');
const rootTestResultsPath = path.join(rootDir, 'test-results.json');
const tempReportFile = path.join(
  os.tmpdir(),
  `dsh-evo-test-results-${process.pid}-${Date.now()}.json`
);
const workDir = path.join(rootDir, 'work');
const bundleStamp = `${process.pid}-${Date.now()}`;
const tempBundleEntry = path.join(workDir, `docs-verify-entry-${bundleStamp}.mjs`);
const tempBundleOut = path.join(workDir, `docs-verify-config-${bundleStamp}.mjs`);

let tempReportCreated = false;
let rootReportConsumed = false;
let tempBundleCreated = false;

function cleanup() {
  if (tempReportCreated && fs.existsSync(tempReportFile)) {
    try {
      fs.unlinkSync(tempReportFile);
    } catch {}
  }
  if (tempBundleCreated) {
    for (const file of [tempBundleEntry, tempBundleOut]) {
      if (fs.existsSync(file)) {
        try {
          fs.unlinkSync(file);
        } catch {}
      }
    }
  }
  if (rootReportConsumed && fs.existsSync(rootTestResultsPath)) {
    try {
      fs.unlinkSync(rootTestResultsPath);
    } catch {}
  }
  // Safety check: ensure repository root has no lingering test-results.json
  if (fs.existsSync(rootTestResultsPath)) {
    try {
      fs.unlinkSync(rootTestResultsPath);
    } catch {}
  }
}

process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(1);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(1);
});

/**
 * Recursive leaf walk over a frozen config object. Arrays count as ONE leaf
 * (documented with a `[]` suffix, matching the reference table), plain objects
 * recurse with dot-joined paths, everything else is a leaf. This is the single
 * definition of "a documented leaf" shared by the gate and the README table.
 */
export function collectDefaultLeaves(value, prefix = '', out = []) {
  if (Array.isArray(value)) {
    out.push(prefix + '[]');
    return out;
  }
  if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) {
      collectDefaultLeaves(value[key], prefix ? prefix + '.' + key : key, out);
    }
    return out;
  }
  out.push(prefix);
  return out;
}

function normalizeDefaultText(text) {
  return text.replace(/\s+/g, '');
}

/**
 * Parse the Configuration reference section of a README: every table row whose
 * first cell is a backticked path and whose second cell is a backticked value
 * becomes `{ path, defaultValueText }`. Separator and header rows never match
 * because they carry no backticks. Prose mentions of a key are not rows.
 */
export function extractReadmeLeafRows(readmeContent) {
  const sectionStart = readmeContent.indexOf('## Configuration reference');
  if (sectionStart === -1) {
    return [];
  }
  const nextHeading = readmeContent.indexOf('\n## ', sectionStart + 1);
  const section =
    nextHeading === -1 ? readmeContent.slice(sectionStart) : readmeContent.slice(sectionStart, nextHeading);
  const rowRegex = /^\|\s*`([^`]+)`\s*\|\s*`([^`]*)`\s*\|/;
  const rows = [];
  for (const line of section.split(/\r?\n/)) {
    const match = rowRegex.exec(line);
    if (match === null) {
      continue;
    }
    rows.push({ path: match[1].trim(), defaultValueText: match[2].trim() });
  }
  return rows;
}

/**
 * Build a tiny esbuild bundle that re-exports the REAL frozen defaults
 * (`DEFAULT_EVO_HARNESS_CONFIG` from src/config.ts and `MODEL_ROUTE_DEFAULTS`
 * from src/dsh-bridge/model-config.ts) and import it. The gate therefore reads
 * the same source the runtime reads — a hand-copied defaults table in this
 * script could drift silently, which is exactly what this gate exists to
 * prevent.
 */
async function loadRealDefaults() {
  const require = createRequire(import.meta.url);
  const esbuild = require('esbuild');
  fs.mkdirSync(workDir, { recursive: true });
  const configSource = path.join(rootDir, 'src', 'config.ts').split(path.sep).join('/');
  const modelConfigSource = path
    .join(rootDir, 'src', 'dsh-bridge', 'model-config.ts')
    .split(path.sep)
    .join('/');
  fs.writeFileSync(
    tempBundleEntry,
    'import { DEFAULT_EVO_HARNESS_CONFIG } from ' +
      JSON.stringify(configSource) +
      ';\n' +
      'import { MODEL_ROUTE_DEFAULTS } from ' +
      JSON.stringify(modelConfigSource) +
      ';\n' +
      'export { DEFAULT_EVO_HARNESS_CONFIG, MODEL_ROUTE_DEFAULTS };\n',
    'utf8'
  );
  esbuild.buildSync({
    entryPoints: [tempBundleEntry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: tempBundleOut,
    logLevel: 'silent'
  });
  tempBundleCreated = true;
  const bundleUrl = pathToFileURL(tempBundleOut).href;
  return import(bundleUrl);
}

/**
 * Compare the traversed default leaves against the README reference rows.
 * Returns { ok, expectedCount, rowCount, missing, stale, mismatches } where
 * `missing` are documented-leaf paths absent from the README, `stale` are rows
 * that name no real leaf, and `mismatches` are rows whose Default column does
 * not equal the real default (whitespace-insensitive JSON literal comparison).
 */
export function verifyDocsLeaves(readmeContent, defaults, modelRouteDefaults) {
  const expected = new Map();
  for (const leafPath of collectDefaultLeaves(defaults)) {
    if (leafPath !== '') {
      expected.set(leafPath, JSON.stringify(defaultsAtPath(defaults, leafPath)));
    }
  }
  for (const key of Object.keys(modelRouteDefaults)) {
    expected.set('modelRoute.' + key, JSON.stringify(modelRouteDefaults[key]));
  }

  const rows = extractReadmeLeafRows(readmeContent);
  const rowPaths = new Set(rows.map((row) => row.path));

  const missing = [...expected.keys()].filter((leafPath) => !rowPaths.has(leafPath)).sort();
  const stale = rows
    .map((row) => row.path)
    .filter((leafPath) => !expected.has(leafPath))
    .sort();
  const mismatches = rows
    .filter((row) => expected.has(row.path))
    .map((row) => ({
      path: row.path,
      expected: expected.get(row.path),
      actual: normalizeDefaultText(row.defaultValueText)
    }))
    .filter((row) => row.expected !== row.actual)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    ok: missing.length === 0 && stale.length === 0 && mismatches.length === 0,
    expectedCount: expected.size,
    rowCount: rows.length,
    missing,
    stale,
    mismatches
  };
}

/** Resolve a dot/`[]`-suffixed leaf path back to its value (for comparison). */
function defaultsAtPath(defaults, leafPath) {
  const segments = leafPath.split('.');
  let current = defaults;
  for (const segment of segments) {
    if (segment.endsWith('[]')) {
      current = current[segment.slice(0, -2)];
    } else {
      current = current[segment];
    }
  }
  return current;
}

/**
 * Collect the full names of assertions whose status is one of `statuses`, for
 * printing when the failed/pending gate fires.
 */
function collectAssertionNames(testReport, statuses) {
  const wanted = new Set(statuses);
  const names = [];
  for (const file of testReport.testResults || []) {
    for (const assertion of file.assertionResults || []) {
      if (wanted.has(assertion.status)) {
        const where = typeof file.name === 'string' ? ' [' + file.name.replace(/\\/g, '/') + ']' : '';
        names.push(String(assertion.fullName || assertion.title || 'unnamed test') + where);
      }
    }
  }
  return names;
}

function parseCli(argv) {
  const options = { report: undefined, readme: undefined, docsOnly: false, dumpLeaves: false };
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--report') {
      options.report = argv[index + 1];
      index += 1;
    } else if (flag === '--readme') {
      options.readme = argv[index + 1];
      index += 1;
    } else if (flag === '--docs-only') {
      options.docsOnly = true;
    } else if (flag === '--dump-leaves') {
      options.dumpLeaves = true;
    } else {
      throw new Error('Unknown flag: ' + flag);
    }
  }
  return options;
}

async function main() {
  const options = parseCli(process.argv);

  if (options.dumpLeaves) {
    const defaults = await loadRealDefaults();
    const defaultLeaves = collectDefaultLeaves(defaults.DEFAULT_EVO_HARNESS_CONFIG).filter((p) => p !== '');
    const modelRouteLeaves = Object.keys(defaults.MODEL_ROUTE_DEFAULTS).map((key) => 'modelRoute.' + key);
    console.log(
      JSON.stringify(
        { defaultLeaves, modelRouteLeaves, defaultLeafCount: defaultLeaves.length, modelRouteLeafCount: modelRouteLeaves.length },
        null,
        2
      )
    );
    return;
  }

  console.log('[docs-verify] Starting documentation and repository hygiene verification...');

  // 1. Check LICENSE
  if (!fs.existsSync(licensePath)) {
    console.error('[docs-verify] ERROR: LICENSE file is missing!');
    process.exitCode = 1;
    return;
  }
  const licenseContent = fs.readFileSync(licensePath, 'utf8');
  if (!licenseContent.includes('Apache License') || !licenseContent.includes('Version 2.0')) {
    console.error('[docs-verify] ERROR: LICENSE does not appear to be Apache-2.0!');
    process.exitCode = 1;
    return;
  }
  console.log('[docs-verify] ✓ LICENSE exists and verified as Apache-2.0.');

  // 2. Check CHANGELOG
  if (!fs.existsSync(changelogPath)) {
    console.error('[docs-verify] ERROR: CHANGELOG.md file is missing!');
    process.exitCode = 1;
    return;
  }
  const changelogContent = fs.readFileSync(changelogPath, 'utf8');
  if (!changelogContent.includes('# Changelog')) {
    console.error('[docs-verify] ERROR: CHANGELOG.md is invalid or empty!');
    process.exitCode = 1;
    return;
  }
  console.log('[docs-verify] ✓ CHANGELOG.md exists.');

  // 3. Read README
  const activeReadmePath = options.readme ?? readmePath;
  if (!fs.existsSync(activeReadmePath)) {
    console.error('[docs-verify] ERROR: README.md file is missing!');
    process.exitCode = 1;
    return;
  }
  const readmeContent = fs.readFileSync(activeReadmePath, 'utf8');

  let testReport = null;
  if (!options.docsOnly) {
    // 4. Get actual test counts from Vitest (root file, --report file, or a
    //    fresh temporary run). A report that carries failing or pending tests
    //    is refused BEFORE the count comparison: the README claims "passing
    //    tests", so a failing run must never mint a green count check.
    if (options.report !== undefined) {
      console.log(`[docs-verify] Reading provided test report: ${options.report}`);
      testReport = JSON.parse(fs.readFileSync(options.report, 'utf8'));
    } else if (fs.existsSync(rootTestResultsPath)) {
      console.log(`[docs-verify] Reading existing test report: ${rootTestResultsPath}`);
      testReport = JSON.parse(fs.readFileSync(rootTestResultsPath, 'utf8'));
      rootReportConsumed = true;
    } else {
      console.log(`[docs-verify] test-results.json not in root; generating test report in temporary location...`);
      const normalizedTemp = tempReportFile.replace(/\\/g, '/');
      try {
        execSync(`pnpm exec vitest run --reporter=json --outputFile="${normalizedTemp}"`, {
          cwd: rootDir,
          stdio: 'inherit'
        });
      } catch (runError) {
        // A FAILING vitest run still writes its JSON report. Those failures must
        // be reported as test failures (the F-14 branch below), not as a crash of
        // this gate: "the suite has a red test" and "the documentation gate broke"
        // demand opposite responses, and conflating them sends the reader hunting
        // the README over a test timeout.
        if (!fs.existsSync(tempReportFile)) {
          // UNTESTED SAFETY NET (see the ratchet in
          // tests/unit/config/readme-default-leaves.test.ts). Reaching this line
          // needs the inner vitest run to fail AND to write no report at all,
          // which no in-repo fixture can stage: the gate resolves rootDir from its
          // own __dirname, so the inner run is always this repository's real
          // suite. It is kept because the alternative (proceeding to readFileSync)
          // would raise ENOENT and surface as "Unexpected error during
          // verification" — the exact misattribution this try/catch exists to
          // remove. Deleting this guard therefore still fails CLOSED (main() exits
          // non-zero); what is lost is only the accurate "the inner run failed"
          // message.
          throw runError;
        }
        console.error(
          '[docs-verify] the inner vitest run exited non-zero; reading its report to name the failures'
        );
      }
      testReport = JSON.parse(fs.readFileSync(tempReportFile, 'utf8'));
      tempReportCreated = true;
    }

    const failedNames = collectAssertionNames(testReport, ['failed']);
    const pendingNames = collectAssertionNames(testReport, ['pending', 'skipped', 'todo']);
    const numFailed =
      typeof testReport.numFailedTests === 'number' ? testReport.numFailedTests : failedNames.length;
    const numPending =
      typeof testReport.numPendingTests === 'number' ? testReport.numPendingTests : pendingNames.length;

    if (numFailed > 0 || failedNames.length > 0) {
      console.error(
        `[docs-verify] FAIL: the consumed report carries ${numFailed} failed test(s). Refusing to verify README counts against a failing run.`
      );
      for (const name of failedNames) {
        console.error('  - failed: ' + name);
      }
      process.exitCode = 1;
      return;
    }
    if (numPending > 0 || pendingNames.length > 0) {
      console.error(
        `[docs-verify] FAIL: the consumed report carries ${numPending} pending/skipped test(s). Refusing to verify README counts against an incomplete run.`
      );
      for (const name of pendingNames) {
        console.error('  - pending: ' + name);
      }
      process.exitCode = 1;
      return;
    }
    console.log('[docs-verify] ✓ Report carries zero failed and zero pending tests.');

    // J-1 (rev5 P0-3): the report must describe a COMPLETE, SUCCESSFUL run.
    // A report can match every README count and still be evidence of a broken
    // run: vitest sets `success=false` when a worker dies or an unhandled
    // rejection escapes, `numFailedTestSuites>0` when a suite failed to
    // collect, `unhandledErrors` lists errors that never became a test
    // failure, and `numTodoTests>0` counts tests that never ran. Assertion
    // status alone cannot see any of those, which is exactly the gap recorded
    // in docs/reports/p2-p6-integration-round.md row 15 (J-1).
    //
    // Field PRESENCE is part of the evidence: `success`, `numFailedTestSuites`
    // and `numTodoTests` exist in every Vitest JSON reporter output, so a
    // report without them is not a report this gate can call green (see
    // tests/unit/config/readme-default-leaves.test.ts fixtures and
    // tests/unit/p62/docs-gate-j1.test.ts negative controls). `unhandledErrors`
    // is the exception: Vitest 3.2.7's JSON reporter OMITS the key when there
    // are none (measured key list on a green run), so absence means "none
    // reported by this reporter version"; when present it must be an array and
    // a non-empty array fails. `success=false` is the reporter-independent
    // backstop for errors that never became a test failure.
    const reportIntegrityFailures = [];
    const missingReportFields = [];
    if (typeof testReport.success !== 'boolean') {
      missingReportFields.push('success (boolean)');
    }
    if (typeof testReport.numFailedTestSuites !== 'number') {
      missingReportFields.push('numFailedTestSuites (number)');
    }
    if (typeof testReport.numTodoTests !== 'number') {
      missingReportFields.push('numTodoTests (number)');
    }
    if (testReport.unhandledErrors !== undefined && !Array.isArray(testReport.unhandledErrors)) {
      reportIntegrityFailures.push(
        'invalid-report: unhandledErrors is present but is not an array; the report shape cannot be trusted'
      );
    }
    if (missingReportFields.length > 0) {
      reportIntegrityFailures.push(
        'partial-report: the consumed report lacks ' +
          missingReportFields.join(', ') +
          '; a report without these fields cannot prove the run itself succeeded ' +
          '(J-1 fail-closed: absent evidence is not evidence of success)'
      );
    } else {
      if (testReport.success === false) {
        reportIntegrityFailures.push(
          'success=false: the Vitest run itself failed even though every counted assertion passed ' +
            '(a failed worker, an unhandled rejection or a collection error can leave the counts intact)'
        );
      }
      if (testReport.numFailedTestSuites > 0) {
        reportIntegrityFailures.push(
          `numFailedTestSuites=${testReport.numFailedTestSuites}: ` +
            `${testReport.numFailedTestSuites} test suite(s) failed, which the passing-test counts cannot show`
        );
      }
      if (Array.isArray(testReport.unhandledErrors) && testReport.unhandledErrors.length > 0) {
        const first = testReport.unhandledErrors[0];
        const firstMessage =
          first !== null && typeof first === 'object'
            ? String(first.message ?? first.name ?? '(no message)')
            : String(first);
        reportIntegrityFailures.push(
          `unhandledErrors=${testReport.unhandledErrors.length}: at least one unhandled error escaped the run ` +
            `(first: ${firstMessage.replace(/\s+/g, ' ').slice(0, 300)})`
        );
      }
      if (testReport.numTodoTests > 0) {
        reportIntegrityFailures.push(
          `numTodoTests=${testReport.numTodoTests}: ${testReport.numTodoTests} test(s) are marked todo and did not run`
        );
      }
    }
    if (reportIntegrityFailures.length > 0) {
      console.error(
        '[docs-verify] FAIL: the consumed report is not evidence of a complete, successful run (J-1):'
      );
      for (const failure of reportIntegrityFailures) {
        console.error('  - report-integrity: ' + failure);
      }
      const failedSuiteNames = (testReport.testResults || [])
        .filter((file) => file && file.status === 'failed')
        .map((file) => String(file.name).replace(/\\/g, '/'));
      for (const name of failedSuiteNames) {
        console.error('  - failed-suite: ' + name);
      }
      process.exitCode = 1;
      return;
    }
    console.log('[docs-verify] ✓ Report describes a complete, successful run (success=true, 0 failed suites, 0 unhandled errors, 0 todo tests).');

    // 5. Parse README numbers
    const summaryRegex = /reports\s+`(\d+)`\s+test files and\s+`(\d+)`\s+passing tests for\s+`pnpm run test`/i;
    const summaryMatch = readmeContent.match(summaryRegex);
    if (!summaryMatch) {
      console.error('[docs-verify] ERROR: Could not find test count summary in README.md!');
      process.exitCode = 1;
      return;
    }
    const readmeSummaryFiles = parseInt(summaryMatch[1], 10);
    const readmeSummaryTests = parseInt(summaryMatch[2], 10);

    const unitRegex = /\|\s*`pnpm run test:unit`\s*\|\s*`tests\/unit`\s*\|\s*(\d+)\s+files,\s*(\d+)\s+tests\s*\|/i;
    const unitMatch = readmeContent.match(unitRegex);
    if (!unitMatch) {
      console.error('[docs-verify] ERROR: Could not find pnpm run test:unit entry in README.md table!');
      process.exitCode = 1;
      return;
    }
    const readmeUnitFiles = parseInt(unitMatch[1], 10);
    const readmeUnitTests = parseInt(unitMatch[2], 10);

    const e2eRegex = /\|\s*`pnpm run test:e2e`\s*\|\s*`tests\/e2e`\s*\|\s*(\d+)\s+files,\s*(\d+)\s+tests\s*\|/i;
    const e2eMatch = readmeContent.match(e2eRegex);
    if (!e2eMatch) {
      console.error('[docs-verify] ERROR: Could not find pnpm run test:e2e entry in README.md table!');
      process.exitCode = 1;
      return;
    }
    const readmeE2eFiles = parseInt(e2eMatch[1], 10);
    const readmeE2eTests = parseInt(e2eMatch[2], 10);

    const totalRegex = /\|\s*`pnpm run test`\s*\|\s*everything\s*\|\s*(\d+)\s+files,\s*(\d+)\s+tests\s*\|/i;
    const totalMatch = readmeContent.match(totalRegex);
    if (!totalMatch) {
      console.error('[docs-verify] ERROR: Could not find pnpm run test (total) entry in README.md table!');
      process.exitCode = 1;
      return;
    }
    const readmeTotalFiles = parseInt(totalMatch[1], 10);
    const readmeTotalTests = parseInt(totalMatch[2], 10);

    console.log('[docs-verify] Parsed README metrics:');
    console.log(`  - Summary: ${readmeSummaryFiles} files, ${readmeSummaryTests} tests`);
    console.log(`  - Unit:    ${readmeUnitFiles} files, ${readmeUnitTests} tests`);
    console.log(`  - E2E:     ${readmeE2eFiles} files, ${readmeE2eTests} tests`);
    console.log(`  - Total:   ${readmeTotalFiles} files, ${readmeTotalTests} tests`);

    const testReportResults = testReport.testResults || [];
    const actualTotalFiles = testReportResults.length;
    const actualTotalTests = testReport.numTotalTests ?? testReportResults.reduce((acc, f) => acc + (f.assertionResults?.length || 0), 0);

    // R-04 (a): TEST-ROOT ATTRIBUTION. Every consumed test file must belong to
    // one of the two documented roots. A third root (eg. tests/integration/) is
    // named explicitly instead of being silently dropped from every count, which
    // is the failure mode this asserts against: unit + e2e would then appear to
    // close while a whole directory goes uncounted.
    const DOCUMENTED_TEST_ROOTS = ['/tests/unit/', '/tests/e2e/'];
    const unattributed = testReportResults
      .map((f) => String(f.name).replace(/\\/g, '/'))
      .filter((norm) => !DOCUMENTED_TEST_ROOTS.some((root) => norm.includes(root)));
    if (unattributed.length > 0) {
      console.error(
        `[docs-verify] FAIL: ${unattributed.length} test file(s) live outside the documented test roots (${DOCUMENTED_TEST_ROOTS.join(' | ')}).`
      );
      for (const name of unattributed) {
        console.error('  - unattributed-root: ' + name);
      }
      process.exitCode = 1;
    }

    const unitFiles = testReportResults.filter((f) => {
      const norm = f.name.replace(/\\/g, '/');
      return norm.includes('/tests/unit/');
    });
    const actualUnitFiles = unitFiles.length;
    const actualUnitTests = unitFiles.reduce((acc, f) => acc + (f.assertionResults?.length || 0), 0);

    const e2eFiles = testReportResults.filter((f) => {
      const norm = f.name.replace(/\\/g, '/');
      return norm.includes('/tests/e2e/');
    });
    const actualE2eFiles = e2eFiles.length;
    const actualE2eTests = e2eFiles.reduce((acc, f) => acc + (f.assertionResults?.length || 0), 0);

    console.log('[docs-verify] Actual Vitest run metrics:');
    console.log(`  - Unit:    ${actualUnitFiles} files, ${actualUnitTests} tests`);
    console.log(`  - E2E:     ${actualE2eFiles} files, ${actualE2eTests} tests`);
    console.log(`  - Total:   ${actualTotalFiles} files, ${actualTotalTests} tests`);

    // R-04 (b): THREE-WAY CLOSURE. Both sides must satisfy unit + e2e == total
    // (files AND tests), and the README summary line must equal its total row.
    // These assertions compare the sides to EACH OTHER, never to an absolute
    // number: a drifting count stays reported by the absolute checks below, so a
    // closure failure always means the parts genuinely do not add up.
    const closureErrors = [];
    if (readmeUnitFiles + readmeE2eFiles !== readmeTotalFiles) {
      closureErrors.push(
        `README counts do not close (files): unit (${readmeUnitFiles}) + e2e (${readmeE2eFiles}) != total (${readmeTotalFiles})`
      );
    }
    if (readmeUnitTests + readmeE2eTests !== readmeTotalTests) {
      closureErrors.push(
        `README counts do not close (tests): unit (${readmeUnitTests}) + e2e (${readmeE2eTests}) != total (${readmeTotalTests})`
      );
    }
    if (readmeSummaryFiles !== readmeTotalFiles) {
      closureErrors.push(
        `README summary line disagrees with the total row (files): summary (${readmeSummaryFiles}) != total (${readmeTotalFiles})`
      );
    }
    if (readmeSummaryTests !== readmeTotalTests) {
      closureErrors.push(
        `README summary line disagrees with the total row (tests): summary (${readmeSummaryTests}) != total (${readmeTotalTests})`
      );
    }
    if (actualUnitFiles + actualE2eFiles !== actualTotalFiles) {
      closureErrors.push(
        `Vitest counts do not close (files): unit (${actualUnitFiles}) + e2e (${actualE2eFiles}) != total (${actualTotalFiles})`
      );
    }
    if (actualUnitTests + actualE2eTests !== actualTotalTests) {
      closureErrors.push(
        `Vitest counts do not close (tests): unit (${actualUnitTests}) + e2e (${actualE2eTests}) != total (${actualTotalTests})`
      );
    }
    if (closureErrors.length > 0) {
      console.error('[docs-verify] FAIL: count closure:');
      for (const err of closureErrors) {
        console.error('  - count-closure: ' + err);
      }
      process.exitCode = 1;
    } else {
      console.log(
        '[docs-verify] ✓ Counts close: unit + e2e == total on the README side and the report side, and every test file is attributed to tests/unit or tests/e2e.'
      );
    }

    const errors = [];
    if (readmeSummaryFiles !== actualTotalFiles) {
      errors.push(`Summary test files mismatch: README has ${readmeSummaryFiles}, Vitest has ${actualTotalFiles}`);
    }
    if (readmeSummaryTests !== actualTotalTests) {
      errors.push(`Summary passing tests mismatch: README has ${readmeSummaryTests}, Vitest has ${actualTotalTests}`);
    }
    if (readmeUnitFiles !== actualUnitFiles) {
      errors.push(`Table unit test files mismatch: README has ${readmeUnitFiles}, Vitest has ${actualUnitFiles}`);
    }
    if (readmeUnitTests !== actualUnitTests) {
      errors.push(`Table unit tests mismatch: README has ${readmeUnitTests}, Vitest has ${actualUnitTests}`);
    }
    if (readmeE2eFiles !== actualE2eFiles) {
      errors.push(`Table e2e test files mismatch: README has ${readmeE2eFiles}, Vitest has ${actualE2eFiles}`);
    }
    if (readmeE2eTests !== actualE2eTests) {
      errors.push(`Table e2e tests mismatch: README has ${readmeE2eTests}, Vitest has ${actualE2eTests}`);
    }
    if (readmeTotalFiles !== actualTotalFiles) {
      errors.push(`Table total test files mismatch: README has ${readmeTotalFiles}, Vitest has ${actualTotalFiles}`);
    }
    if (readmeTotalTests !== actualTotalTests) {
      errors.push(`Table total tests mismatch: README has ${readmeTotalTests}, Vitest has ${actualTotalTests}`);
    }

    if (errors.length > 0) {
      console.error('[docs-verify] FAIL: Found discrepancies between README.md and test results:');
      for (const err of errors) {
        console.error(`  - ${err}`);
      }
      process.exitCode = 1;
      // Do not return: the configuration-reference check below still runs, so
      // one invocation reports every documentation defect class at once.
    } else {
      console.log('[docs-verify] SUCCESS: All README.md test counts match Vitest results exactly!');
    }
  } else {
    console.log('[docs-verify] --docs-only: skipping test-report/count checks (config-reference verification only).');
  }

  // 6. Configuration-reference completeness (ADR 0005 §4 D4): walk the REAL
  //    defaults, never a hand-copied table, and fail on missing, stale or
  //    drifted rows.
  const defaults = await loadRealDefaults();
  const leafResult = verifyDocsLeaves(readmeContent, defaults.DEFAULT_EVO_HARNESS_CONFIG, defaults.MODEL_ROUTE_DEFAULTS);
  console.log(
    `[docs-verify] Config reference coverage: ${leafResult.rowCount} documented row(s) vs ${leafResult.expectedCount} expected default leaf path(s) (arrays count as one leaf with a \`[]\` suffix).`
  );
  if (!leafResult.ok) {
    console.error('[docs-verify] FAIL: Configuration reference does not match the real defaults:');
    for (const missingPath of leafResult.missing) {
      console.error(`  - missing-leaf: ${missingPath} is a default leaf but has no reference row`);
    }
    for (const stalePath of leafResult.stale) {
      console.error(`  - stale-leaf: ${stalePath} is documented but is not a real default leaf`);
    }
    for (const mismatch of leafResult.mismatches) {
      console.error(
        `  - default-mismatch: ${mismatch.path} documents \`${mismatch.actual}\` but the real default is \`${mismatch.expected}\``
      );
    }
    process.exitCode = 1;
    return;
  }
  console.log('[docs-verify] ✓ Configuration reference documents every default leaf with the correct default value.');
  if (process.exitCode === 1) {
    console.error('[docs-verify] FAIL: see the discrepancy report above (counts and/or configuration reference).');
  } else {
    console.log('[docs-verify] SUCCESS: documentation gate fully green.');
  }
}

try {
  await main();
} catch (err) {
  console.error('[docs-verify] Unexpected error during verification:', err);
  process.exitCode = 1;
} finally {
  cleanup();
}
