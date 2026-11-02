/**
 * VERIF-3 regression: the same-process branch executor must NOT record a
 * cancellation as a `timeout` failure signal.
 *
 * The agent-loop executor encodes the deliberate rule "cancellation settles
 * status 'aborted' (and deliberately does NOT claim the 'timeout' signal kind);
 * a real wall-clock overrun settles 'timeout'" (agent-loop-executor.ts header,
 * BOUNDING section). branch.ts violated it on all three cancellation paths,
 * counting a user abort in the timeout failure family with nothing but the
 * status to disambiguate.
 *
 * Consumer sync (verified by reading, pinned here by status-first behaviour):
 *   - src/jitrl/step-evaluator.ts classifyTrajectoryOutcome switches on
 *     trajectory.status FIRST ('aborted' returns before any signal kind is
 *     consulted), so the kind change cannot flip an outcome;
 *   - src/dream-rsi/failure-taxonomy.ts routes status 'aborted' to
 *     hard_unrecoverable unconditionally, and 'timeout'/'unknown' are BOTH in
 *     WEAK_FAILURE_SIGNALS, so the category cannot flip either.
 *
 * MUST BE RED before the fix: every cancellation path wrote kind 'timeout'.
 */
import { describe, expect, it } from 'vitest';
import { createBranchExecutor } from '../../../src/dsh-bridge/branch';
import { classifyTrajectoryOutcome } from '../../../src/jitrl/step-evaluator';
import type {
  FailureSignal,
  IModelAdapter,
  IsolatedBranchContext,
  ModelRequest,
  ModelResponse,
  ProbeExecutionResult,
  TrajectoryRole
} from '../../../src/types/contracts';

function makeContext(overrides: Partial<IsolatedBranchContext> = {}): IsolatedBranchContext {
  return {
    branchId: 'br-cancel',
    sessionId: 'sess-cancel',
    namespace: 'harness2:probe_br-cancel',
    task: {
      id: 'task-cancel',
      prompt: 'probe task',
      taskSignature: 'sig-cancel',
      complexity: 'moderate',
      contextTags: []
    },
    patch: {
      id: 'patch-cancel',
      sessionId: 'sess-cancel',
      branchId: 'source-branch',
      origin: 'reference',
      purpose: 'initial',
      guidance: 'memory',
      label: 'cancel-probe',
      rationale: 'exercise the cancellation paths',
      createdAt: 1,
      edits: {}
    },
    mountedSurfaces: [],
    signal: new AbortController().signal,
    ...overrides
  };
}

/** The signal kinds recorded on a result. */
function signalKindsOf(result: ProbeExecutionResult): readonly FailureSignal['kind'][] {
  return (result.failureSignals ?? []).map((signal) => signal.kind);
}

/**
 * Lift a branch result into the ProbeTrajectory shape the outcome classifier
 * consumes (the classifier reads status, failureSignals and error; the identity
 * fields are inert but required by the type).
 */
function trajectoryOf(result: ProbeExecutionResult): Parameters<typeof classifyTrajectoryOutcome>[0] {
  return {
    id: 'traj-cancel',
    sessionId: 'sess-cancel',
    branchId: 'br-cancel',
    branchNamespace: 'harness2:probe_br-cancel',
    role: 'candidate' as TrajectoryRole,
    status: result.status ?? 'failed',
    patchId: 'patch-cancel',
    patchOrigin: 'reference',
    surfaceKeys: [],
    startedAt: 0,
    endedAt: 1,
    metrics: {
      steps: (result.steps ?? []).length,
      toolCalls: 0,
      toolErrors: (result.toolErrors ?? []).length,
      durationMs: 1
    },
    steps: result.steps ?? [],
    toolErrors: result.toolErrors ?? [],
    failureSignals: result.failureSignals ?? [],
    memoryRecallIds: [],
    ...(result.error === undefined ? {} : { error: result.error })
  };
}

describe('VERIF-3: cancellation failure signals are not timeouts', () => {
  it('records kind "unknown" (not "timeout") when the branch is aborted before dispatch', async () => {
    const controller = new AbortController();
    controller.abort();
    let dialed = 0;
    const executor = createBranchExecutor({}, {
      model: {
        async complete(): Promise<ModelResponse> {
          dialed += 1;
          return { text: 'never reached', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        }
      }
    });

    const result = await executor.runBranch(makeContext({ signal: controller.signal }));

    expect(result.status).toBe('aborted');
    expect(dialed).toBe(0);
    expect(signalKindsOf(result)).not.toContain('timeout');
    const aborted = (result.failureSignals ?? []).find(
      (signal) => signal.message === 'the probe branch was aborted before dispatch'
    );
    expect(aborted?.kind).toBe('unknown');
    // Consumer sync: the status-first classifier still says aborted (an aborted
    // run carries no evidence about quality), regardless of the signal kind.
    expect(classifyTrajectoryOutcome(trajectoryOf(result))).toBe('aborted');
  });

  it('records kind "unknown" (not "timeout") when a cooperative adapter surfaces the mid-flight abort', async () => {
    const controller = new AbortController();
    // A cooperative adapter: it relays the caller signal and rejects with an
    // abort-shaped error while the call is in flight. The executor's catch
    // block runs with cancelled=true — the live mid-flight cancellation path
    // (the response-path `if (cancelled)` check in branch.ts is defensive:
    // relayAbort always rejects the deadline promise, so a settled response and
    // a later-processed abort cannot both reach it).
    const executor = createBranchExecutor({}, {
      model: {
        complete(_request: ModelRequest): Promise<ModelResponse> {
          return new Promise<ModelResponse>((_resolve, reject) => {
            const onAbort = (): void => {
              const error = new Error('the model call was aborted');
              error.name = 'AbortError';
              reject(error);
            };
            if (controller.signal.aborted) {
              onAbort();
              return;
            }
            controller.signal.addEventListener('abort', onAbort, { once: true });
          });
        }
      }
    });

    setTimeout(() => controller.abort(new Error('the caller withdrew the probe')), 10);
    const result = await executor.runBranch(makeContext({ signal: controller.signal }));

    expect(result.status).toBe('aborted');
    expect(signalKindsOf(result)).not.toContain('timeout');
    const cancelled = (result.failureSignals ?? []).find((signal) =>
      signal.message.startsWith('the probe branch was cancelled:')
    );
    expect(cancelled?.kind).toBe('unknown');
    expect(classifyTrajectoryOutcome(trajectoryOf(result))).toBe('aborted');
  });

  it('records kind "unknown" (not "timeout") when a cancelled call throws through the catch path', async () => {
    const controller = new AbortController();
    // A non-cooperative adapter that never settles: the hard Promise.race
    // deadline rejects when the caller aborts, so the rejection surfaces
    // through the executor's catch block with cancelled=true.
    const executor = createBranchExecutor({}, {
      model: {
        complete: (): Promise<ModelResponse> => new Promise<ModelResponse>(() => undefined)
      }
    });

    setTimeout(() => controller.abort(new Error('the caller withdrew the probe')), 10);
    const result = await executor.runBranch(makeContext({ signal: controller.signal }));

    expect(result.status).toBe('aborted');
    expect(signalKindsOf(result)).not.toContain('timeout');
    const cancelled = (result.failureSignals ?? []).find((signal) =>
      signal.message.startsWith('the probe branch was cancelled:')
    );
    expect(cancelled?.kind).toBe('unknown');
    expect(classifyTrajectoryOutcome(trajectoryOf(result))).toBe('aborted');
  });

  it('still records kind "timeout" for a REAL wall-clock overrun (the discipline keeps both apart)', async () => {
    const executor = createBranchExecutor({}, {
      model: {
        complete: (): Promise<ModelResponse> => new Promise<ModelResponse>(() => undefined)
      },
      probeTimeoutMs: 15
    });

    const result = await executor.runBranch(makeContext());

    expect(result.status).toBe('timeout');
    const timedOut = (result.failureSignals ?? []).find((signal) =>
      signal.message.startsWith('the probe exceeded its wall-clock budget')
    );
    expect(timedOut?.kind).toBe('timeout');
    expect(signalKindsOf(result)).not.toContain('unknown');
  });
});
