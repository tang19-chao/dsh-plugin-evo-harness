#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

let tempReportCreated = false;
let rootReportConsumed = false;

function cleanup() {
  if (tempReportCreated && fs.existsSync(tempReportFile)) {
    try {
      fs.unlinkSync(tempReportFile);
    } catch {}
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

function main() {
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
  if (!fs.existsSync(readmePath)) {
    console.error('[docs-verify] ERROR: README.md file is missing!');
    process.exitCode = 1;
    return;
  }
  const readmeContent = fs.readFileSync(readmePath, 'utf8');

  // 4. Parse README numbers
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

  // 5. Get actual test counts from Vitest
  let testReport;
  if (fs.existsSync(rootTestResultsPath)) {
    console.log(`[docs-verify] Reading existing test report: ${rootTestResultsPath}`);
    testReport = JSON.parse(fs.readFileSync(rootTestResultsPath, 'utf8'));
    rootReportConsumed = true;
  } else {
    console.log(`[docs-verify] test-results.json not in root; generating test report in temporary location...`);
    const normalizedTemp = tempReportFile.replace(/\\/g, '/');
    execSync(`pnpm exec vitest run --reporter=json --outputFile="${normalizedTemp}"`, {
      cwd: rootDir,
      stdio: 'inherit'
    });
    testReport = JSON.parse(fs.readFileSync(tempReportFile, 'utf8'));
    tempReportCreated = true;
  }

  const testResults = testReport.testResults || [];
  const actualTotalFiles = testResults.length;
  const actualTotalTests = testReport.numTotalTests ?? testResults.reduce((acc, f) => acc + (f.assertionResults?.length || 0), 0);

  const unitFiles = testResults.filter((f) => {
    const norm = f.name.replace(/\\/g, '/');
    return norm.includes('/tests/unit/');
  });
  const actualUnitFiles = unitFiles.length;
  const actualUnitTests = unitFiles.reduce((acc, f) => acc + (f.assertionResults?.length || 0), 0);

  const e2eFiles = testResults.filter((f) => {
    const norm = f.name.replace(/\\/g, '/');
    return norm.includes('/tests/e2e/');
  });
  const actualE2eFiles = e2eFiles.length;
  const actualE2eTests = e2eFiles.reduce((acc, f) => acc + (f.assertionResults?.length || 0), 0);

  console.log('[docs-verify] Actual Vitest run metrics:');
  console.log(`  - Unit:    ${actualUnitFiles} files, ${actualUnitTests} tests`);
  console.log(`  - E2E:     ${actualE2eFiles} files, ${actualE2eTests} tests`);
  console.log(`  - Total:   ${actualTotalFiles} files, ${actualTotalTests} tests`);

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
    return;
  }

  console.log('[docs-verify] SUCCESS: All README.md test counts match Vitest results exactly!');
}

try {
  main();
} catch (err) {
  console.error('[docs-verify] Unexpected error during verification:', err);
  process.exitCode = 1;
} finally {
  cleanup();
}
