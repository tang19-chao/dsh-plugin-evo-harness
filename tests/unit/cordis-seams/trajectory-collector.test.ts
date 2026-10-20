import { describe, expect, it } from 'vitest';
import {
  TrajectoryCollector,
  computeTrajectoryMetrics,
  deriveFailureSignals,
  orderSurfaceKeys,
  reindexSteps,
  toTrajectoryError
} from '../../../src/cordis-seams';
import type { FailureSignal, ToolErrorRecord, TrajectoryStep } from '../../../src/types/contracts';
import { makeClock, makePatch, makeSteps } from './fixtures';

function makeCollector(overrides: Partial<ConstructorParameters<typeof TrajectoryCollector>[0]> = {}) {
  return new TrajectoryCollector({
    id: 'traj-1',
    sessionId: 'sess-1',
    branchId: 'br-1',
    branchNamespace: 'harness2:probe_br-1',
    role: 'candidate',
    patch: makePatch(),
    surfaceKeys: ['plugins', 'system_prompt'],
    now: makeClock(1_000, 10),
    memoryRecallIds: ['lesson-1'],
    ...overrides
  });
}

describe('computeTrajectoryMetrics', () => {
  it('derives steps, toolCalls, toolErrors and duration from observed data', () => {
    const metrics = computeTrajectoryMetrics({
      steps: makeSteps(),
      toolErrors: [{ toolName: 'shell', message: 'exit 1' }],
      startedAt: 1_000,
      endedAt: 1_250,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      deliverable: { content: 'abcdef' }
    });

    expect(metrics).toEqual({
      steps: 3,
      toolCalls: 1,
      toolErrors: 1,
      durationMs: 250,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      deliverableChars: 6
    });
  });

  it('never reports a negative duration and omits unknown token usage', () => {
    const metrics = computeTrajectoryMetrics({
      steps: [],
      toolErrors: [],
      startedAt: 500,
      endedAt: 100
    });

    expect(metrics).toEqual({ steps: 0, toolCalls: 0, toolErrors: 0, durationMs: 0 });
    expect(metrics.inputTokens).toBeUndefined();
    expect(metrics.deliverableChars).toBeUndefined();
  });
});

describe('deriveFailureSignals', () => {
  it('maps timeout status, tool errors, missing deliverables and error names', () => {
    const toolErrors: ToolErrorRecord[] = [
      { toolName: 'shell', message: 'exit 1', code: 'E1', stepIndex: 2, retryable: true }
    ];

    const timeoutSignals = deriveFailureSignals({
      status: 'timeout',
      toolErrors,
      explicit: []
    });
    expect(timeoutSignals.map((signal) => signal.kind)).toEqual(['timeout', 'tool_error']);
    expect(timeoutSignals[1]?.toolName).toBe('shell');

    const noDeliverable = deriveFailureSignals({
      status: 'succeeded',
      toolErrors: [],
      explicit: []
    });
    expect(noDeliverable.map((signal) => signal.kind)).toEqual(['no_deliverable']);

    const importFailure = deriveFailureSignals({
      status: 'failed',
      error: { name: 'Error', message: 'Cannot find module zzz' },
      toolErrors: [],
      explicit: []
    });
    expect(importFailure[0]?.kind).toBe('import_error');

    const syntaxFailure = deriveFailureSignals({
      status: 'failed',
      error: { name: 'SyntaxError', message: 'unexpected token' },
      toolErrors: [],
      explicit: []
    });
    expect(syntaxFailure[0]?.kind).toBe('syntax_error');
  });

  it('collapses duplicate explicit signals', () => {
    const explicit: FailureSignal[] = [
      { kind: 'tool_error', message: 'exit 1', toolName: 'shell' },
      { kind: 'tool_error', message: 'exit 1', toolName: 'shell' }
    ];

    const signals = deriveFailureSignals({
      status: 'failed',
      toolErrors: [{ toolName: 'shell', message: 'exit 1' }],
      explicit
    });

    expect(signals).toHaveLength(1);
  });
});

describe('TrajectoryCollector', () => {
  it('builds a ProbeTrajectory with collector steps, ordered surfaces and metadata', () => {
    const collector = makeCollector();
    collector.appendStep({ kind: 'model', text: 'plan' });
    collector.appendStep({ kind: 'tool', toolName: 'shell' });
    collector.recordToolError({ toolName: 'shell', message: 'exit 1' });
    collector.recordDiagnostic('cleanup released resources with 0 failure(s)');

    const trajectory = collector.finalize({ status: 'succeeded', endedAt: 1_100 });

    expect(trajectory.id).toBe('traj-1');
    expect(trajectory.branchId).toBe('br-1');
    expect(trajectory.branchNamespace).toBe('harness2:probe_br-1');
    expect(trajectory.role).toBe('candidate');
    expect(trajectory.status).toBe('succeeded');
    expect(trajectory.patchId).toBe('patch-1');
    expect(trajectory.patchOrigin).toBe('reference');
    expect(trajectory.surfaceKeys).toEqual(['system_prompt', 'plugins']);
    expect(trajectory.memoryRecallIds).toEqual(['lesson-1']);
    expect(trajectory.steps.map((step) => step.index)).toEqual([0, 1]);
    expect(trajectory.metrics.toolCalls).toBe(1);
    expect(trajectory.metrics.toolErrors).toBe(1);
    expect(trajectory.metadata?.diagnostics).toEqual(['cleanup released resources with 0 failure(s)']);
  });

  it('reindexes executor-provided steps and merges executor signals', () => {
    const collector = makeCollector();
    collector.recordToolError({ toolName: 'collector', message: 'pre-existing' });

    const trajectory = collector.finalize({
      endedAt: 1_200,
      result: {
        status: 'failed',
        steps: [
          { index: 7, at: 1, kind: 'model' },
          { index: 9, at: 2, kind: 'error' }
        ],
        toolErrors: [{ toolName: 'shell', message: 'exit 1' }],
        failureSignals: [{ kind: 'budget_exhausted', message: 'out of budget' }],
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }
      }
    });

    expect(trajectory.status).toBe('failed');
    expect(trajectory.steps.map((step) => step.index)).toEqual([0, 1]);
    expect(trajectory.toolErrors).toHaveLength(2);
    expect(trajectory.failureSignals.map((signal) => signal.kind)).toContain('budget_exhausted');
    expect(trajectory.metrics.totalTokens).toBe(3);
  });

  it('defaults to failed when an error was recorded without an explicit status', () => {
    const collector = makeCollector();
    collector.recordError(new Error('executor blew up'));

    const trajectory = collector.finalize({ endedAt: 1_300 });

    expect(trajectory.status).toBe('failed');
    expect(trajectory.error?.message).toBe('executor blew up');
    expect(trajectory.failureSignals.map((signal) => signal.kind)).toContain('unknown');
  });

  it('is idempotent and refuses surface updates after finalize', () => {
    const collector = makeCollector();
    const first = collector.finalize({ endedAt: 1_400 });
    collector.setSurfaceKeys(['memory']);
    const second = collector.finalize({ status: 'timeout', endedAt: 9_999 });

    expect(second).toBe(first);
    expect(second.surfaceKeys).toEqual(['system_prompt', 'plugins']);
  });
});

describe('helpers', () => {
  it('orders and dedupes surface keys into mount order', () => {
    expect(orderSurfaceKeys(['plugins', 'system_prompt', 'plugins'])).toEqual([
      'system_prompt',
      'plugins'
    ]);
  });

  it('reindexes steps only when needed', () => {
    const steps: TrajectoryStep[] = [
      { index: 0, at: 1, kind: 'model' },
      { index: 5, at: 2, kind: 'model' }
    ];
    const reindexed = reindexSteps(steps);

    expect(reindexed[0]).toBe(steps[0]);
    expect(reindexed.map((step) => step.index)).toEqual([0, 1]);
  });

  it('normalizes unknown thrown values', () => {
    expect(toTrajectoryError('plain string')).toEqual({ name: 'Error', message: 'plain string' });
    expect(toTrajectoryError({ a: 1 }).message).toBe('{"a":1}');
    expect(toTrajectoryError(new Error('boom')).name).toBe('Error');
  });
});
