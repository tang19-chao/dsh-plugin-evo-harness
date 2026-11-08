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

// ---------------------------------------------------------------------------
// rev8 evidence-integrity trio (#67 / #72 / #118 / #175)
// ---------------------------------------------------------------------------

const ANSWER_CRITERIA = [
  {
    id: 'c1',
    text: 'the reconciliation report must list the signed total of every ledger row including credits and refunds before closing the period'
  },
  {
    id: 'c2',
    text: 'the filing timeline must start the statutory waiting period before the financing condition lapses and state the order of both steps'
  },
  {
    id: 'c3',
    text: 'every counterparty whose consent is required must be listed with the clause of the agreement that requires their consent'
  }
] as const;
const FULL_KEY = ANSWER_CRITERIA.map((entry) => entry.text).join('\n');

function makeIntegrityCollector(
  overrides: Partial<ConstructorParameters<typeof TrajectoryCollector>[0]> = {}
) {
  return makeCollector({
    evidenceIntegrity: {
      taskId: 'task-1',
      answerKey: { criteria: ANSWER_CRITERIA, visibleText: [] }
    },
    ...overrides
  });
}

describe('rev8 #67: the two artifact channels fail independently', () => {
  it('a deliverable-channel failure keeps the full trajectory (upstream #67 direction 2)', () => {
    const collector = makeCollector();
    collector.appendStep({ kind: 'model', text: 'plan' });
    collector.appendStep({ kind: 'result', text: 'body' });
    collector.recordDeliverableFault(new Error('deliverable extraction failed'));

    const trajectory = collector.finalize({ status: 'succeeded', endedAt: 1_100 });

    // The execution status stays truthful; the artifact channel reports its own failure.
    expect(trajectory.status).toBe('succeeded');
    expect(trajectory.steps.map((step) => step.text)).toEqual(['plan', 'body']);
    expect(trajectory.deliverable).toBeUndefined();
    expect(trajectory.failureSignals.map((signal) => signal.code)).toContain('evidence-render-failed');
    expect(trajectory.failureSignals.map((signal) => signal.kind)).toContain('no_deliverable');
  });

  it('a trajectory-channel failure keeps a rendered deliverable (upstream #67 direction 1)', () => {
    const collector = makeCollector();
    collector.appendStep({ kind: 'model', text: 'plan' });
    collector.recordTrajectoryFault(new Error('trajectory render failed'));

    const trajectory = collector.finalize({
      status: 'succeeded',
      endedAt: 1_100,
      result: { status: 'succeeded', deliverable: { content: 'artifact body', format: 'text' } }
    });

    expect(trajectory.status).toBe('succeeded');
    expect(trajectory.deliverable?.content).toBe('artifact body');
    expect(trajectory.failureSignals.map((signal) => signal.code)).toContain('evidence-render-failed');
    expect(trajectory.failureSignals.map((signal) => signal.message)).toContain('trajectory render failed');
  });

  it('a throwing result getter on one channel cannot erase the other channels', () => {
    const collector = makeCollector();
    collector.appendStep({ kind: 'model', text: 'kept step' });
    const hostileResult = {
      get steps() {
        return [{ index: 9, at: 1, kind: 'model' as const, text: 'executor step' }];
      },
      get deliverable(): never {
        throw new Error('deliverable extraction failed');
      }
    } as unknown as NonNullable<Parameters<typeof collector.finalize>[0]>['result'];

    const trajectory = collector.finalize({ status: 'succeeded', endedAt: 1_100, result: hostileResult });

    // The steps that read successfully survive; the failing channel is a fault.
    expect(trajectory.steps.map((step) => step.text)).toContain('kept step');
    expect(trajectory.steps.map((step) => step.text)).toContain('executor step');
    expect(trajectory.deliverable).toBeUndefined();
    expect(trajectory.failureSignals.map((signal) => signal.code)).toContain('evidence-render-failed');
  });

  it('a recorded terminal error cannot be swallowed by a later success', () => {
    const collector = makeCollector();
    collector.recordError(new Error('late terminal failure'));

    const trajectory = collector.finalize({ status: 'succeeded', endedAt: 1_100 });

    expect(trajectory.status).toBe('failed');
    expect(trajectory.error?.message).toBe('late terminal failure');
  });

  it('the same demotion applies to an executor error declared with a succeeded status', () => {
    const collector = makeCollector();
    const trajectory = collector.finalize({
      status: 'succeeded',
      endedAt: 1_100,
      result: { status: 'succeeded', error: { name: 'Error', message: 'settled after the flag' } }
    });

    expect(trajectory.status).toBe('failed');
  });
});

describe('rev8 #72: missing-trajectory sentinels are rejected', () => {
  it('a sentinel deliverable is dropped, the steps survive, a signal fires', () => {
    const collector = makeCollector();
    collector.appendStep({ kind: 'model', text: 'the only real step' });

    const trajectory = collector.finalize({
      status: 'succeeded',
      endedAt: 1_100,
      result: {
        status: 'succeeded',
        deliverable: { content: '(no parseable events in trajectory)', format: 'text' }
      }
    });

    expect(trajectory.deliverable).toBeUndefined();
    expect(trajectory.steps.map((step) => step.text)).toEqual(['the only real step']);
    expect(trajectory.failureSignals.map((signal) => signal.code)).toContain('missing-trajectory-sentinel');
    // The sentinel text itself never enters the frozen record.
    expect(JSON.stringify(trajectory)).not.toContain('no parseable events');
  });

  it('an empty produced artifact is the same failure', () => {
    const collector = makeCollector();
    const trajectory = collector.finalize({
      status: 'succeeded',
      endedAt: 1_100,
      result: { status: 'succeeded', deliverable: { content: '   ' } }
    });
    expect(trajectory.deliverable).toBeUndefined();
    expect(trajectory.failureSignals.map((signal) => signal.code)).toContain('missing-trajectory-sentinel');
  });

  it('a real deliverable passes through untouched', () => {
    const collector = makeCollector();
    const trajectory = collector.finalize({
      status: 'succeeded',
      endedAt: 1_100,
      result: { status: 'succeeded', deliverable: { content: 'done' } }
    });
    expect(trajectory.deliverable?.content).toBe('done');
    expect(trajectory.failureSignals.map((signal) => signal.code)).not.toContain('missing-trajectory-sentinel');
  });
});

describe('rev8 #118: answer-key contamination is quarantined at finalize', () => {
  it('a deliverable carrying the task key is replaced by the neutral record', () => {
    const collector = makeIntegrityCollector();
    const trajectory = collector.finalize({
      status: 'succeeded',
      endedAt: 1_100,
      result: { status: 'succeeded', deliverable: { content: FULL_KEY, format: 'text' } }
    });
    const serialized = JSON.stringify(trajectory);

    expect(trajectory.status).toBe('failed');
    expect(trajectory.deliverable).toBeUndefined();
    expect(serialized).not.toContain('reconciliation');
    expect(trajectory.metadata?.['evidenceIntegrity']).toBeDefined();
    const mark = trajectory.metadata?.['evidenceIntegrity'] as { contaminated: boolean };
    expect(mark.contaminated).toBe(true);
    expect(trajectory.failureSignals[0]?.code).toBe('evidence-contaminated');
  });

  it('key text inside a JSON-escaped tool result is caught too', () => {
    const collector = makeIntegrityCollector();
    const trajectory = collector.finalize({
      status: 'succeeded',
      endedAt: 1_100,
      result: {
        status: 'succeeded',
        deliverable: { content: 'innocent summary' },
        steps: [
          {
            index: 0,
            at: 1_050,
            kind: 'tool',
            toolName: 'http',
            toolResult: JSON.stringify({ body: FULL_KEY })
          }
        ]
      }
    });

    expect(trajectory.status).toBe('failed');
    expect(JSON.stringify(trajectory)).not.toContain('reconciliation');
  });

  it('clean evidence with a policy passes through byte-identically (no mark, no quarantine)', () => {
    const collector = makeIntegrityCollector();
    const withPolicy = collector.finalize({
      status: 'succeeded',
      endedAt: 1_100,
      result: { status: 'succeeded', deliverable: { content: 'a clean answer' } }
    });
    const withoutPolicy = makeCollector().finalize({
      status: 'succeeded',
      endedAt: 1_100,
      result: { status: 'succeeded', deliverable: { content: 'a clean answer' } }
    });

    expect(withPolicy.metadata?.['evidenceIntegrity']).toBeUndefined();
    expect(withPolicy.status).toBe('succeeded');
    expect(withPolicy).toEqual(withoutPolicy);
  });

  it('a patch whose component path collides is refused even with clean content', () => {
    const collidingPatch = {
      ...makePatch(),
      id: 'patch-collide',
      edits: {
        ...makePatch().edits,
        skills: { kind: 'skills' as const, skills: [{ name: 'tests', markdown: '# x' }] }
      }
    };
    const collector = makeCollector({
      patch: collidingPatch,
      evidenceIntegrity: { taskId: 'task-1', forbiddenPathSegments: ['tests'] }
    });
    const trajectory = collector.finalize({ status: 'succeeded', endedAt: 1_100 });

    expect(trajectory.status).toBe('failed');
    expect(trajectory.failureSignals[0]?.code).toBe('answer-key-path');
    expect(trajectory.failureSignals[0]?.repairable).toBe(true);
    expect(trajectory.metadata?.['evidenceIntegrity']).toBeDefined();
  });
});
