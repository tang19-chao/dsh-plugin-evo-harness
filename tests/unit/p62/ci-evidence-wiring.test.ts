/**
 * rev5 P0-4: CI wiring is part of the evidence contract, so it is pinned here.
 *
 * A gate that exists but is never executed is decoration. These assertions keep
 * the three rev5 wiring claims true as the workflow is edited:
 *
 *   1. the clean-tree / test-input gate runs BEFORE the test step in the same
 *      job that later runs `check:docs` (otherwise a stale report or a dirty
 *      checkout can be judged as if it were the commit);
 *   2. every `--expect-commit` target check uses `${{ github.sha }}`, and the
 *      attestation-target job asserts the self-reference boundary instead of
 *      claiming the checked-out revision is covered;
 *   3. CI never regenerates the canonical record (no `--out
 *      docs/reports/final-attestation.json`): a record is generated from a
 *      commit, so regenerating it in the same CI run would fabricate coverage.
 *
 * This is a static contract test, not a YAML parser: it looks for the exact
 * command fragments the workflow must contain and their order in the file.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ciPath = path.join(repoRoot, '.github', 'workflows', 'ci.yml');
const ci = fs.readFileSync(ciPath, 'utf8');

describe('CI: the clean-tree gate runs before the tests that feed check:docs', () => {
  it('wires check-clean-tree with the required test-input paths', () => {
    expect(ci).toContain('node scripts/eval/check-clean-tree.mjs');
    for (const required of ['--require-tracked package.json', '--require-tracked src', '--require-tracked tests', '--require-tracked scripts']) {
      expect(ci, `CI must require tracked input: ${required}`).toContain(required);
    }
  });

  it('runs the clean-tree gate before the vitest step and before check:docs', () => {
    const cleanIndex = ci.indexOf('check-clean-tree.mjs');
    const testIndex = ci.indexOf('pnpm exec vitest run --reporter=default --reporter=json --outputFile=test-results.json');
    const docsIndex = ci.indexOf('pnpm run check:docs');
    expect(cleanIndex).toBeGreaterThan(-1);
    expect(testIndex).toBeGreaterThan(-1);
    expect(docsIndex).toBeGreaterThan(-1);
    expect(cleanIndex, 'clean-tree must run before the test step').toBeLessThan(testIndex);
    expect(cleanIndex, 'clean-tree must run before check:docs').toBeLessThan(docsIndex);
  });

  it('the gate is NOT in `pnpm run verify` (the rev5 worktree is uncommitted by design)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(pkg.scripts.verify).toBe('pnpm run typecheck && pnpm run test');
    expect(pkg.scripts.verify).not.toContain('clean-tree');
    // But it is an explicit, documented command for CI and humans.
    expect(pkg.scripts['check:clean-tree']).toContain('check-clean-tree.mjs');
  });
});

describe('CI: attestation targets use github.sha and never fabricate HEAD coverage', () => {
  it('binds fingerprint generation and parity comparison to the triggered revision', () => {
    expect(ci).toContain('--ref "${{ github.sha }}" --expect-commit "${{ github.sha }}"');
    const expectCommitUses = ci.match(/--expect-commit "\$\{\{ github\.sha \}\}"/g) ?? [];
    expect(expectCommitUses.length).toBeGreaterThanOrEqual(2);
  });

  it('asserts the self-reference boundary with github.sha in the target job', () => {
    expect(ci).toContain('Assert the canonical record does not claim to cover this revision');
    expect(ci).toContain('self-reference violation');
    expect(ci).toContain('Assert the self-reference boundary is documented');
    expect(ci).toContain('grep -q "SELF-REFERENCE BOUNDARY"');
  });

  it('never regenerates the canonical record inside CI', () => {
    expect(ci).not.toContain('--out docs/reports/final-attestation.json');
    // It verifies the recorded evidence instead.
    expect(ci).toContain('pnpm run attest:verify');
    expect(ci).toContain('node scripts/eval/check-attestation-target.mjs --json');
  });

  it('runs the independent node:test attestation suite', () => {
    expect(ci).toContain('node --test scripts/eval/compare-platform-digests.node-test.mjs scripts/eval/final-attestation.node-test.mjs');
  });
});

describe('CI: build freshness is executed in the main verify job', () => {
  it('runs the smoke gate (which now refuses stale artifacts)', () => {
    expect(ci).toContain('node scripts/eval/smoke-build.mjs');
    // The freshness explanation must stay attached to the step, so a future
    // edit cannot drop the check while keeping the step name.
    expect(ci).toContain('freshness included');
    expect(ci).toContain('lib/build-stamp.json');
  });
});
