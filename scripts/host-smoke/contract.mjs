#!/usr/bin/env node
/**
 * P4-C contract/fake-host smoke wrapper (FAKE path only).
 *
 * The real artifact is the runnable repository test
 * `tests/e2e/host-smoke/contract-smoke.test.ts` (vitest). This wrapper runs that
 * suite with vitest and prints a machine-readable summary plus the real-host
 * smoke items that stay NOT-RUN until authorized. It contains no smoke logic of
 * its own, never starts a DSH host, never spawns an Electron process and never
 * makes an external tool call or a memory write.
 *
 * Exit codes: 0 = the contract suite is green; 1 = any test failed.
 * Usage: node scripts/host-smoke/contract.mjs [--json]
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const asJson = process.argv.includes('--json');
const suite = 'tests/e2e/host-smoke/contract-smoke.test.ts';

const REAL_HOST_ITEMS = [
  'sibling probes on a real installed host',
  'concurrent / reused sessions on a real installed host',
  'expired leases on a real installed host',
  'cleanup on a real installed host',
  'mount non-leakage on a real installed host'
];

// Windows resolves `pnpm` to a .cmd shim, which Node cannot spawn without a
// shell; the repository path contains no spaces, so a shell is safe here.
const run = spawnSync('pnpm', ['exec', 'vitest', 'run', suite, '--reporter=json'], {
  cwd: repoRoot,
  encoding: 'utf8',
  windowsHide: true,
  shell: process.platform === 'win32'
});

let summary = { files: 0, tests: 0, failed: 0, passed: 0 };
try {
  const line = (run.stdout ?? '')
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.startsWith('{'));
  if (line !== undefined) {
    const parsed = JSON.parse(line);
    summary = {
      files: parsed.numTotalTestSuites ?? 0,
      tests: parsed.numTotalTests ?? 0,
      passed: parsed.numPassedTests ?? 0,
      failed: parsed.numFailedTests ?? 0
    };
  }
} catch {
  // fall through to the raw exit code
}

const notRun = [
  {
    item: 'real-host smoke',
    status: 'not-run',
    reason: 'requires explicit authorization (ADR 0006 D-P4-5 / team rules: no real host smoke)',
    scenarios: REAL_HOST_ITEMS
  }
];

const result = {
  gate: 'p4c-contract-smoke-v1',
  fake: { path: 'in-process fixture (no DSH runtime, no network, no LLM)', suite, ...summary },
  real: notRun,
  passed: run.status === 0 && summary.failed === 0 && summary.passed > 0
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('[contract-smoke] suite: ' + suite);
  console.log('[contract-smoke] files=' + summary.files + ' tests=' + summary.tests + ' passed=' + summary.passed + ' failed=' + summary.failed);
  console.log('[contract-smoke] real-host smoke: not-run (requires authorization) - ' + REAL_HOST_ITEMS.length + ' scenarios');
  console.log('[contract-smoke] ' + (result.passed ? 'PASS (fake path only)' : 'FAIL'));
}

process.exit(result.passed ? 0 : 1);
