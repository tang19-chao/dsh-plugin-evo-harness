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
 * Every case runs the REAL verifier in a throw-away repo root (the verifier
 * anchors on process.cwd()), with a copy of the frozen artifact + report +
 * ledgers. Unrelated assertions fail because the fixture has no src/ tree; the
 * assertions under test are read from the verifier's own status file.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const VERIFIER = join(REPO_ROOT, 'scripts', 'eval', 'verify-pr4a-artifacts.mjs');
const ARTIFACT = join(REPO_ROOT, 'work', 'pr4a-five-arm-eval.json');
const REPORT_MD = join(REPO_ROOT, 'docs', 'reports', 'pr4a-five-arm-eval-report.md');
const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface Failure { readonly id: string; readonly detail?: string }

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'p4a-provenance-gate-'));
  tempRoots.push(root);
  mkdirSync(join(root, 'work'), { recursive: true });
  mkdirSync(join(root, 'docs', 'reports'), { recursive: true });
  copyFileSync(ARTIFACT, join(root, 'work', 'pr4a-five-arm-eval.json'));
  copyFileSync(REPORT_MD, join(root, 'docs', 'reports', 'pr4a-five-arm-eval-report.md'));
  for (const file of readdirSync(join(REPO_ROOT, 'work'))) {
    if (/^pr4a-ledger-.*[.]jsonl$/.test(file)) {
      copyFileSync(join(REPO_ROOT, 'work', file), join(root, 'work', file));
    }
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
