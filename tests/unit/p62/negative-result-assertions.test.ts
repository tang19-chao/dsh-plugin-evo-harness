/**
 * PR-1: historical negative-result assertions must be able to FAIL.
 *
 * These tests exist because the pre-PR-1 `negative-result-diag.mjs` only
 * PRINTED its findings and always exited 0. A gate that cannot fail is not a
 * gate — it would report "pass" even if the recorded historical result drifted.
 *
 * Each test mutates an in-memory copy of the real result and asserts that the
 * corresponding A-rule produces a failure. That proves the assertions are
 * falsifiable rather than vacuous.
 *
 * Architecture note: the rules live in `scripts/eval/lib/negative-result-assertions.mjs`
 * (a pure, shebang-free module). The CLI itself cannot be imported by a test on
 * this checkout: vitest 3.2.7 does not strip a `#!` line when the file it
 * transforms has CRLF endings, so importing `negative-result-diag.mjs` fails with
 * `SyntaxError: Invalid or unexpected token` regardless of the file's content.
 * The CLI wiring is therefore asserted through a CHILD PROCESS, which is also
 * how a user runs it.
 *
 * Offline: no network, no model, no paid API.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASSERTION_IDS,
  affirmsConfirmedRootCause,
  evaluateAssertions
} from '../../../scripts/eval/lib/negative-result-assertions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const CLI = path.join(repoRoot, 'scripts', 'eval', 'negative-result-diag.mjs');

/** Run the real diagnostic once per file and reuse it: the engine is ~1s. */
const realResult = (() => {
  const output = execFileSync(process.execPath, [CLI, '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  });
  return JSON.parse(output) as any;
})();

/** A deep copy, so one test's mutation cannot leak into the next. */
function copyResult(): any {
  return JSON.parse(JSON.stringify(realResult));
}

/** Run the CLI in a child process and capture status + stdout/stderr. */
function runCli(args: readonly string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: typeof failure.status === 'number' ? failure.status : -1,
      stdout: String(failure.stdout ?? ''),
      stderr: String(failure.stderr ?? '')
    };
  }
}

describe('PR-1 A-rules: the historical negative result is actually asserted', () => {
  it('accepts the real, unmodified result', () => {
    const { ok, failures } = evaluateAssertions(realResult);
    expect(failures).toEqual([]);
    expect(ok).toBe(true);
  });

  it('pins the historical frame the assertions defend', () => {
    // If the anchor itself moved, every A1 assertion below would be testing a
    // different claim than the one the report makes.
    expect(realResult.reproduction.meanDelta).toBe(-0.25);
    expect(realResult.reproduction.historical).toBe(-0.25);
    expect(realResult.reproduction.matchesHistorical).toBe(true);
    expect(realResult.reproduction.degradation.degradedTasks).toEqual([
      'ci-04',
      'mig-01',
      'mig-02',
      'mig-04',
      'test-03'
    ]);
  });

  it('A1 fails when the reproduction drifts out of the historical frame', () => {
    const data = copyResult();
    data.reproduction.matchesHistorical = false;
    const { ok, failures } = evaluateAssertions(data);
    expect(ok).toBe(false);
    expect(failures.some((failure) => failure.startsWith('A1 historical-frame-drift'))).toBe(true);
  });

  it('A1 fails when the recorded anchor is silently edited', () => {
    const data = copyResult();
    data.reproduction.historical = -0.2;
    const { ok, failures } = evaluateAssertions(data);
    expect(ok).toBe(false);
    expect(failures.some((failure) => failure.includes('recorded historical anchor'))).toBe(true);
  });

  it('A2 fails when the per-task degradation evidence disappears', () => {
    const data = copyResult();
    data.reproduction.degradation.degradedTasks = [];
    const { ok, failures } = evaluateAssertions(data);
    expect(ok).toBe(false);
    expect(failures.some((failure) => failure.startsWith('A2 no-degraded-tasks'))).toBe(true);
  });

  it('A3 fails when a counterexample loses its replay payload', () => {
    const data = copyResult();
    data.minimalCounterexamples = [{ taskId: 'some-task' }];
    const { ok, failures } = evaluateAssertions(data);
    expect(ok).toBe(false);
    expect(failures.some((failure) => failure.startsWith('A3 counterexample-not-replayable'))).toBe(true);
  });

  it('A3 fails when a replay anchor is missing its coordinates', () => {
    const data = copyResult();
    data.minimalCounterexamples[0].counterexample.replay = undefined;
    const { ok, failures } = evaluateAssertions(data);
    expect(ok).toBe(false);
    expect(failures.some((failure) => failure.includes('has no replay coordinates'))).toBe(true);
  });

  it('A3 fails when a replay anchor drops a required coordinate', () => {
    const data = copyResult();
    delete data.minimalCounterexamples[0].counterexample.replay.chosenChoice;
    const { ok, failures } = evaluateAssertions(data);
    expect(ok).toBe(false);
    expect(failures.some((failure) => failure.includes('is missing replay.chosenChoice'))).toBe(true);
  });

  it('A4 fails when the decision ledger starts carrying payload', () => {
    const data = copyResult();
    data.decisionLedger = { fields: ['taskId', 'prompt', 'patchBody'] };
    const { ok, failures } = evaluateAssertions(data);
    expect(ok).toBe(false);
    expect(failures.some((failure) => failure.startsWith('A4 ledger-not-payload-free'))).toBe(true);
  });

  it('A5 fails when a hypothesis asserts a confirmed root cause', () => {
    const data = copyResult();
    data.hypotheses = [{ id: 'H99', verdict: '已确认根因：candidate filter bug' }];
    const { ok, failures } = evaluateAssertions(data);
    expect(ok).toBe(false);
    expect(failures.some((failure) => failure.startsWith('A5 hypothesis-claims-root-cause'))).toBe(true);
  });

  it('A5 does NOT fail on a legitimate disclaimer', () => {
    // This exact sentence is in the real report. The first draft of the rule
    // regex-matched 已确认根因 and false-positived on it.
    const data = copyResult();
    data.hypotheses = [{ id: 'H1', verdict: '（假设，非已确认根因）' }];
    expect(evaluateAssertions(data).ok).toBe(true);
  });

  it('A5 does NOT fail on a cross-clause negation', () => {
    // Chinese prose negates across a comma: this is the real H1 verdict shape.
    const data = copyResult();
    data.hypotheses = [{ id: 'H1', verdict: 'scale-sensitive: 标尺改变了负收益幅度（记录为再校准证据，不当作已确认根因）' }];
    expect(evaluateAssertions(data).ok).toBe(true);
  });

  it('A5 does NOT fail on an honest abstention', () => {
    // The second draft of the rule required a disclaimer marker and therefore
    // false-positived on these two real verdicts.
    const data = copyResult();
    data.hypotheses = [
      { id: 'H5', verdict: 'cannot-exclude: 池调度不是负收益主因' },
      { id: 'H6', verdict: 'not-run (behavioural): 真实宿主行为差异需 Gate 4 受控 smoke' }
    ];
    expect(evaluateAssertions(data).ok).toBe(true);
  });

  it('A5 decision procedure is pinned directly', () => {
    expect(affirmsConfirmedRootCause('已确认根因：x')).toBe(true);
    expect(affirmsConfirmedRootCause('这是已确认根因')).toBe(true);
    expect(affirmsConfirmedRootCause('（假设，非已确认根因）')).toBe(false);
    expect(affirmsConfirmedRootCause('不当作已确认根因')).toBe(false);
    expect(affirmsConfirmedRootCause('未确认，已确认根因不成立')).toBe(false);
    expect(affirmsConfirmedRootCause('cannot-exclude')).toBe(false);
    expect(affirmsConfirmedRootCause('')).toBe(false);
  });

  it('A5b fails when the structural hypothesis disclaimer disappears', () => {
    const data = copyResult();
    data.boundaries = data.boundaries.filter((line: string) => !line.includes('已确认根因'));
    const { ok, failures } = evaluateAssertions(data);
    expect(ok).toBe(false);
    expect(failures.some((failure) => failure.startsWith('A5 boundary-disclaimer-missing'))).toBe(true);
  });

  it('A6 fails when the H4 benefit gate silently starts passing', () => {
    const data = copyResult();
    data.improvementStrategyGates = {
      ...(data.improvementStrategyGates ?? {}),
      h4GateOnValidationSplit: { benefitGatePassed: true, safetyGatePassed: true }
    };
    const { ok, failures } = evaluateAssertions(data);
    expect(ok).toBe(false);
    expect(failures.some((failure) => failure.startsWith('A6 strategy-gate-silently-passed'))).toBe(true);
  });

  it('exposes the assertion ids it enforces', () => {
    expect(Object.keys(ASSERTION_IDS)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6']);
  });
});

describe('PR-1 CLI wiring: --assert is a real gate, --json is unchanged', () => {
  it('exits 0 with a pass summary on the real tree', () => {
    const result = runCli(['--assert']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('A1..A6 PASS');
  });

  it('exits 0 and still emits the full diagnostic JSON in --assert --json', () => {
    const result = runCli(['--assert', '--json']);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.assertions).toEqual({ ok: true, failures: [] });
    // The diagnostic body must NOT be replaced by the assertion summary: a gate
    // that stops printing its evidence cannot be audited.
    expect(parsed.reproduction.meanDelta).toBe(-0.25);
    expect(parsed.frame.taskCount).toBe(12);
    expect(Array.isArray(parsed.minimalCounterexamples)).toBe(true);
  });

  it('keeps the pre-PR-1 --json output shape (no assertion block added)', () => {
    const plain = runCli(['--json']);
    expect(plain.status).toBe(0);
    const parsed = JSON.parse(plain.stdout);
    expect(parsed.assertions).toBeUndefined();
    expect(Object.keys(parsed).sort()).toEqual([
      'boundaries',
      'decisionLedger',
      'deviationStats',
      'firstHarmfulDeviation',
      'frame',
      'harness',
      'hypotheses',
      'improvementStrategyGates',
      'minimalCounterexamples',
      'offlineCounterfactual',
      'reproduction'
    ]);
  });

  it('an unknown flag does not silently change the output mode', () => {
    // Flags are additive: an unrecognised one must not switch behaviour, so a
    // typo in CI cannot turn the gate into a no-op.
    const result = runCli(['--definitely-not-a-flag']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('negative-result explanation');
    expect(result.stdout).not.toContain('assertions (PR-1)');
  });
});
