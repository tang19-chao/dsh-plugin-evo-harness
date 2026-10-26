/**
 * C2a (ADR 0003 §4.2/§4.3): the attach side - registry authentication, the
 * bounded rejection codes, and the frozen eligibility truth table.
 *
 * These are the "no forged verdict" tests: whatever a branch, an executor or a
 * caller claims, only a receipt this runner instance registered (bound to the
 * host-recomputed digest and the four-part binding) is ever attached; everything
 * else is audit-only with a bounded reason code.
 */
import { describe, expect, it } from 'vitest';
import { artifactDigestOf, artifactOf } from '../../../src/verification/artifact-digest';
import { createHostOwnedVerificationRunner } from '../../../src/verification/host-runner';
import {
  readVerificationDisposition,
  readVerificationView,
  verificationRewardMarks,
  verifyAndAttach,
  type HostVerificationReceipt,
  type HostVerificationRunner,
  type HostVerificationSeam,
  type VerificationDisposition
} from '../../../src/verification';
import { scoreUnderRewardContract } from '../../../src/jitrl/reward-contract';
import type { ProbeTrajectory, TrajectoryRole } from '../../../src/types/contracts';

const HOST_ID = 'c2a-verifier';
const HOST_VERSION = '1.0.0';
const TEST_SET = 'tests@v1';
const ENV = 'env-local-1';
const RUN = 'run-attach';
const TASK = 'task-c2a';

function trajectory(overrides: Partial<ProbeTrajectory> = {}): ProbeTrajectory {
  return {
    id: 'traj-attach',
    sessionId: 'sess-attach',
    branchId: 'branch',
    branchNamespace: 'ns',
    role: 'candidate',
    status: 'succeeded',
    patchId: 'p',
    patchOrigin: 'domain',
    surfaceKeys: [],
    startedAt: 0,
    endedAt: 10,
    metrics: { steps: 2, toolCalls: 1, toolErrors: 0, durationMs: 10 },
    steps: [],
    toolErrors: [],
    failureSignals: [],
    memoryRecallIds: [],
    deliverable: { content: '{"ok":true,"value":42}', format: 'json' },
    ...overrides
  } as ProbeTrajectory;
}

function runner() {
  return createHostOwnedVerificationRunner({
    verifierId: HOST_ID,
    verifierVersion: HOST_VERSION,
    testSetId: TEST_SET,
    envId: ENV,
    cases: [
      {
        taskId: TASK,
        checks: [
          {
            id: 'json-ok',
            run: (artifact) => {
              const parsed: unknown = JSON.parse(artifact.content);
              return (
                parsed !== null &&
                typeof parsed === 'object' &&
                (parsed as { ok?: unknown }).ok === true
              );
            }
          }
        ]
      }
    ]
  });
}

function seam(host: HostVerificationRunner): HostVerificationSeam {
  return { runner: host };
}

const candidate = (
  overrides: Partial<ProbeTrajectory> = {},
  role: TrajectoryRole = 'candidate'
): ProbeTrajectory => trajectory({ id: 'traj-' + role, role, ...overrides });

describe('c2a attach: the frozen truth table (ADR 0003 §4.3)', () => {
  it('succeeded + trusted passed => attached, task-quality eligible positive', async () => {
    const host = runner();
    const { trajectory: verified, disposition } = await verifyAndAttach({
      seam: seam(host),
      trajectory: candidate(),
      runId: RUN,
      taskId: TASK
    });
    expect(disposition?.attached).toBe(true);
    expect(disposition?.authenticated).toBe(true);
    expect(disposition?.auditOnly).toBe(false);
    expect(disposition?.verdict).toBe('passed');
    expect(disposition?.reasonCode).toBeUndefined();
    const view = readVerificationView(verified);
    expect(view?.receipt?.verifierId).toBe(HOST_ID);
    // T3: the host digest is written into the trajectory, so the scorer's
    // existing expectedEvidenceHash branch actually runs.
    expect(verified.deliverable?.contentHash).toBe(artifactDigestOf(artifactOf(candidate())!));
    const score = scoreUnderRewardContract(verified, { trustedProducers: host.trustedProducers });
    expect(score.verification.trustedSource).toBe(true);
    expect(score.taskQualityEvidence).toBe(true);
    expect(score.sources.completion).toBe(1);
  });

  it('failed execution + trusted failed => attached trusted negative sample (reliable failure learning)', async () => {
    const host = runner();
    const wrong = candidate({
      id: 'traj-failed-exec',
      status: 'failed',
      deliverable: { content: '{"ok":false}', format: 'json' },
      error: { name: 'ToolError', message: 'the build failed' }
    });
    const { trajectory: verified, disposition } = await verifyAndAttach({
      seam: seam(host),
      trajectory: wrong,
      runId: RUN,
      taskId: TASK
    });
    expect(disposition?.attached).toBe(true);
    expect(disposition?.auditOnly).toBe(false);
    expect(disposition?.verdict).toBe('failed');
    const score = scoreUnderRewardContract(verified, { trustedProducers: host.trustedProducers });
    expect(score.verification.trustedSource).toBe(true);
    expect(score.taskQualityEvidence).toBe(true);
    expect(score.reward).toBeLessThanOrEqual(0);
  });

  it('succeeded + trusted failed => attached but audit-only (falsified success claim, verdict kept)', async () => {
    const host = runner();
    const wrong = candidate({ id: 'traj-falsified', deliverable: { content: '{"ok":false}', format: 'json' } });
    const { trajectory: verified, disposition } = await verifyAndAttach({
      seam: seam(host),
      trajectory: wrong,
      runId: RUN,
      taskId: TASK
    });
    expect(disposition?.attached).toBe(true);
    expect(disposition?.auditOnly).toBe(true);
    expect(disposition?.reasonCode).toBe('falsified-success-claim');
    expect(disposition?.verdict).toBe('failed');
    // The receipt is visible to the scorer (so it can falsify the claim), but the
    // consumption gate keeps it audit-only.
    const score = scoreUnderRewardContract(verified, { trustedProducers: host.trustedProducers });
    expect(score.verification.status).toBe('failed');
    expect(score.learningEligible).toBe(false);
    expect(score.taskQualityLearningEligible).toBe(false);
    // ...and the reason is readable for audit.
    expect(readVerificationView(verified)?.disposition.reasonCode).toBe('falsified-success-claim');
  });

  it('failed execution + trusted passed => contradictory-verdict, NEVER attached', async () => {
    const host = runner();
    // The branch CLAIMS the task succeeded while its execution failed.
    const contradictory = candidate({ id: 'traj-contradictory', status: 'failed' });
    const { trajectory: verified, disposition } = await verifyAndAttach({
      seam: seam(host),
      trajectory: contradictory,
      runId: RUN,
      taskId: TASK
    });
    expect(disposition?.attached).toBe(false);
    expect(disposition?.reasonCode).toBe('contradictory-verdict');
    expect(disposition?.verdict).toBe('passed');
    // The scorer cannot see the receipt, so its pre-scoring "passed on failed
    // execution" downgrade can never mask this row (ADR rev.2 F4).
    expect(verified.metadata?.['verification']).toBeUndefined();
    expect(readVerificationView(verified)?.receipt).toBeUndefined();
  });

  it('timeout + trusted failed => execution-not-completed, audit-only, verdict/reason preserved', async () => {
    const host = runner();
    const timedOut = candidate({
      id: 'traj-timeout',
      status: 'timeout',
      deliverable: { content: '{"ok":false}', format: 'json' },
      failureSignals: [{ kind: 'timeout', message: 'probe exceeded its budget', repairable: false }]
    });
    const { trajectory: verified, disposition } = await verifyAndAttach({
      seam: seam(host),
      trajectory: timedOut,
      runId: RUN,
      taskId: TASK
    });
    expect(disposition?.attached).toBe(false);
    expect(disposition?.auditOnly).toBe(true);
    expect(disposition?.reasonCode).toBe('execution-not-completed');
    expect(disposition?.verdict).toBe('failed');
    expect(readVerificationView(verified)?.disposition.reason).toContain('timeout');
    // The scorer would otherwise treat timeout+trusted failed as task-quality
    // evidence; the gate must have removed the receipt from its view.
    const score = scoreUnderRewardContract(verified, { trustedProducers: host.trustedProducers });
    expect(score.taskQualityEvidence).toBe(false);
    expect(score.verification.status).toBe('unknown');
  });

  it('aborted / cancelled / infrastructure executions are all audit-only', async () => {
    const host = runner();
    const cases: readonly ProbeTrajectory[] = [
      candidate({
        id: 'traj-aborted',
        status: 'aborted',
        deliverable: { content: '{"ok":false}', format: 'json' }
      }),
      candidate({
        id: 'traj-cancelled',
        status: 'failed',
        deliverable: { content: '{"ok":false}', format: 'json' },
        error: { name: 'UserCancelledError', message: 'cancelled by user' }
      }),
      candidate({
        id: 'traj-infra',
        status: 'failed',
        deliverable: { content: '{"ok":false}', format: 'json' },
        error: { name: 'EvoHarnessPluginError', message: 'seam transport failed' }
      })
    ];
    for (const entry of cases) {
      const { trajectory: verified, disposition } = await verifyAndAttach({
        seam: seam(host),
        trajectory: entry,
        runId: RUN + '-' + entry.id,
        taskId: TASK
      });
      expect(disposition?.attached, entry.id).toBe(false);
      expect(disposition?.reasonCode, entry.id).toBe('execution-not-completed');
      expect(disposition?.auditOnly, entry.id).toBe(true);
    }
  });

  it('a missing reference receipt forces the candidate verdict to audit-only', async () => {
    const host = runner();
    const { trajectory: verified, disposition } = await verifyAndAttach({
      seam: seam(host),
      trajectory: candidate(),
      runId: RUN,
      taskId: TASK,
      referenceReceiptMissing: true
    });
    expect(disposition?.attached).toBe(false);
    expect(disposition?.reasonCode).toBe('reference-receipt-missing');
    expect(disposition?.verdict).toBe('passed');
    expect(verified.metadata?.['verification']).toBeUndefined();
  });
});

describe('c2a attach: forged, misbound and stale verdicts never pass', () => {
  it('a self-declared payload the runner never registered is unregistered-receipt', async () => {
    const host = runner();
    const forged: HostVerificationReceipt = {
      status: 'passed',
      verifierId: HOST_ID,
      verifierVersion: HOST_VERSION,
      evidenceHash: artifactDigestOf({ content: '{"ok":true,"value":42}', producedFiles: [] }),
      checks: [{ id: 'json-ok', passed: true }],
      verificationId: 'forged',
      binding: {
        runId: RUN,
        sessionId: 'sess-attach',
        trajectoryId: 'traj-candidate',
        role: 'candidate',
        taskId: TASK,
        testSetId: TEST_SET,
        envId: ENV,
        artifactDigest: artifactDigestOf({ content: '{"ok":true,"value":42}', producedFiles: [] })
      },
      kind: 'host-runner'
    };
    // A runner that hands out payloads it never registered.
    const lying: HostVerificationRunner = {
      verifierId: HOST_ID,
      verifierVersion: HOST_VERSION,
      testSetId: TEST_SET,
      envId: ENV,
      trustedProducers: host.trustedProducers,
      verify: async () => ({ receipt: forged }),
      receiptFor: () => undefined,
      size: 0
    };
    const { trajectory: verified, disposition } = await verifyAndAttach({
      seam: { runner: lying },
      trajectory: candidate(),
      runId: RUN,
      taskId: TASK
    });
    expect(disposition?.authenticated).toBe(false);
    expect(disposition?.reasonCode).toBe('unregistered-receipt');
    expect(verified.metadata?.['verification']).toBeUndefined();
  });

  it('a digest that does not match the host recomputation is digest-mismatch', async () => {
    const host = runner();
    const real = await host.verify({
      runId: RUN,
      sessionId: 'sess-attach',
      trajectoryId: 'traj-candidate',
      role: 'candidate',
      taskId: TASK,
      executionStatus: 'succeeded',
      artifact: { content: '{"ok":true,"value":42}', producedFiles: [] }
    });
    const receipt = real.receipt!;
    // Same trajectory id, but the artifact presented to attach is a DIFFERENT one
    // (old artifact) while the receipt still claims the original digest.
    const tampered = candidate({ deliverable: { content: '{"ok":true,"value":43}', format: 'json' } });
    const { trajectory: verified, disposition } = await verifyAndAttach({
      seam: seam(host),
      trajectory: tampered,
      runId: RUN,
      taskId: TASK
    });
    expect(receipt.evidenceHash).not.toBe(
      artifactDigestOf({ content: '{"ok":true,"value":43}', producedFiles: [] })
    );
    expect(disposition?.attached).toBe(false);
    expect(['digest-mismatch', 'stale-artifact', 'unregistered-receipt']).toContain(
      disposition?.reasonCode
    );
    expect(verified.metadata?.['verification']).toBeUndefined();
  });

  it('an old artifact for the same trajectory is stale-artifact', async () => {
    const host = runner();
    const first = candidate({ id: 'traj-stale', deliverable: { content: '{"ok":true}', format: 'json' } });
    const firstAttach = await verifyAndAttach({ seam: seam(host), trajectory: first, runId: RUN, taskId: TASK });
    expect(firstAttach.disposition?.attached).toBe(true);
    const second = candidate({ id: 'traj-stale', deliverable: { content: '{"ok":false}', format: 'json' } });
    const secondAttach = await verifyAndAttach({ seam: seam(host), trajectory: second, runId: RUN, taskId: TASK });
    expect(secondAttach.disposition?.reasonCode).toBe('stale-artifact');
    expect(secondAttach.disposition?.attached).toBe(false);
    expect(secondAttach.trajectory.metadata?.['verification']).toBeUndefined();
  });

  it('a receipt bound to another run is run-mismatch even from the runner own registry', async () => {
    const host = runner();
    const oldReceipt = (
      await host.verify({
        runId: RUN,
        sessionId: 'sess-attach',
        trajectoryId: 'traj-replay-target',
        role: 'candidate',
        taskId: TASK,
        executionStatus: 'succeeded',
        artifact: { content: '{"ok":true,"value":42}', producedFiles: [] }
      })
    ).receipt!;
    // A runner that keeps handing back the previous run's receipt for the new
    // trajectory id (the cross-run replay an attacker/host bug could produce).
    const replaying: HostVerificationRunner = {
      ...host,
      verify: async () => ({ receipt: oldReceipt }),
      receiptFor: () => oldReceipt
    };
    const { trajectory: verified, disposition } = await verifyAndAttach({
      seam: { runner: replaying },
      trajectory: candidate({ id: 'traj-replay-target' }),
      runId: 'run-other',
      taskId: TASK
    });
    expect(disposition?.attached).toBe(false);
    expect(disposition?.reasonCode).toBe('run-mismatch');
    expect(verified.metadata?.['verification']).toBeUndefined();
  });

  it('an inherited receipt is stripped when the host runner produces none (no replay channel)', async () => {
    const host = runner();
    const oldReceipt = (
      await host.verify({
        runId: RUN,
        sessionId: 'sess-attach',
        trajectoryId: 'traj-inherit',
        role: 'candidate',
        taskId: TASK,
        executionStatus: 'succeeded',
        artifact: { content: '{"ok":true,"value":42}', producedFiles: [] }
      })
    ).receipt!;
    // No deliverable => the host runner refuses with artifact-missing, so the
    // only verdict in play is the one the trajectory inherited. It must be gone.
    const inheriting = candidate({
      id: 'traj-inherit',
      deliverable: undefined,
      metadata: { verification: oldReceipt, branch: 'declared' }
    });
    const { trajectory: verified, disposition } = await verifyAndAttach({
      seam: seam(host),
      trajectory: inheriting,
      runId: 'run-other',
      taskId: TASK
    });
    expect(disposition?.reasonCode).toBe('artifact-missing');
    expect(disposition?.attached).toBe(false);
    expect(verified.metadata?.['verification']).toBeUndefined();
    expect(verified.metadata?.['branch']).toBe('declared');
    const score = scoreUnderRewardContract(verified, { trustedProducers: host.trustedProducers });
    expect(score.verification.trustedSource).toBe(false);
    // The inherited receipt is gone; the STRUCTURAL fallback decides (a claimed
    // success with no deliverable is the one structurally disprovable failure).
    expect(score.verification.status).toBe('failed');
    expect(score.verification.implicit).toBe(true);
  });

  it('a receipt whose digest does not match the artifact is digest-mismatch', async () => {
    const host = runner();
    const real = (
      await host.verify({
        runId: RUN,
        sessionId: 'sess-attach',
        trajectoryId: 'traj-candidate',
        role: 'candidate',
        taskId: TASK,
        executionStatus: 'succeeded',
        artifact: { content: '{"ok":true,"value":42}', producedFiles: [] }
      })
    ).receipt!;
    const foreignDigest = artifactDigestOf({ content: '{"ok":true,"value":99}', producedFiles: [] });
    const misbound = {
      ...real,
      evidenceHash: foreignDigest,
      binding: { ...real.binding, artifactDigest: foreignDigest }
    };
    const hybrid: HostVerificationRunner = {
      ...host,
      verify: async () => ({ receipt: misbound }),
      receiptFor: () => misbound
    };
    const { disposition } = await verifyAndAttach({
      seam: { runner: hybrid },
      trajectory: candidate(),
      runId: RUN,
      taskId: TASK
    });
    expect(disposition?.attached).toBe(false);
    expect(disposition?.reasonCode).toBe('digest-mismatch');
  });

  it('a foreign task is no-runner; a receipt bound to another trajectory is binding-mismatch', async () => {
    const host = runner();
    const noCase = await verifyAndAttach({
      seam: seam(host),
      trajectory: candidate({ id: 'traj-other-task' }),
      runId: RUN,
      taskId: 'task-other'
    });
    expect(noCase.disposition?.attached).toBe(false);
    expect(noCase.disposition?.reasonCode).toBe('no-runner');

    const real = (
      await host.verify({
        runId: RUN,
        sessionId: 'sess-attach',
        trajectoryId: 'traj-candidate',
        role: 'candidate',
        taskId: TASK,
        executionStatus: 'succeeded',
        artifact: { content: '{"ok":true,"value":42}', producedFiles: [] }
      })
    ).receipt!;
    const foreign = { ...real, binding: { ...real.binding, trajectoryId: 'traj-somewhere-else' } };
    const hybrid: HostVerificationRunner = {
      ...host,
      verify: async () => ({ receipt: foreign }),
      receiptFor: () => foreign
    };
    const { disposition } = await verifyAndAttach({
      seam: { runner: hybrid },
      trajectory: candidate(),
      runId: RUN,
      taskId: TASK
    });
    expect(disposition?.attached).toBe(false);
    expect(disposition?.reasonCode).toBe('binding-mismatch');
  });

  it('a receipt from another environment is env-mismatch', async () => {
    const host = runner();
    const real = (
      await host.verify({
        runId: RUN,
        sessionId: 'sess-attach',
        trajectoryId: 'traj-candidate',
        role: 'candidate',
        taskId: TASK,
        executionStatus: 'succeeded',
        artifact: { content: '{"ok":true,"value":42}', producedFiles: [] }
      })
    ).receipt!;
    const foreignEnv = { ...real, binding: { ...real.binding, envId: 'env-other' } };
    const hybrid: HostVerificationRunner = {
      ...host,
      verify: async () => ({ receipt: foreignEnv }),
      receiptFor: () => foreignEnv
    };
    const { disposition } = await verifyAndAttach({
      seam: { runner: hybrid },
      trajectory: candidate(),
      runId: RUN,
      taskId: TASK
    });
    expect(disposition?.attached).toBe(false);
    expect(disposition?.reasonCode).toBe('env-mismatch');
  });

  it('a small test-set mismatch is test-set-mismatch (receipt from another test set)', async () => {
    // A host runner whose CURRENT test set is newer than the receipt's: the
    // receipt object still exists in its registry, so identity passes and the
    // test-set check must catch it.
    const staleRunner = createHostOwnedVerificationRunner({
      verifierId: HOST_ID,
      verifierVersion: HOST_VERSION,
      testSetId: 'tests@v2',
      envId: ENV,
      cases: [{ taskId: TASK, checks: [{ id: 'json-ok', run: () => true }] }]
    });
    const receiptHost = runner();
    const oldReceipt = (
      await receiptHost.verify({
        runId: RUN,
        sessionId: 'sess-attach',
        trajectoryId: 'traj-candidate',
        role: 'candidate',
        taskId: TASK,
        executionStatus: 'succeeded',
        artifact: { content: '{"ok":true,"value":42}', producedFiles: [] }
      })
    ).receipt!;
    expect(oldReceipt.binding.testSetId).toBe('tests@v1');
    // Simulate the registry of `staleRunner` holding that older receipt.
    const hybrid: HostVerificationRunner = {
      ...staleRunner,
      verify: async () => ({ receipt: oldReceipt }),
      receiptFor: () => oldReceipt
    };
    const { disposition } = await verifyAndAttach({
      seam: { runner: hybrid },
      trajectory: candidate(),
      runId: RUN,
      taskId: TASK
    });
    expect(disposition?.attached).toBe(false);
    expect(disposition?.reasonCode).toBe('test-set-mismatch');
  });

  it('a malformed receipt (empty checks) is rejected even if the runner registered it', async () => {
    const host = runner();
    const real = (await host.verify({
      runId: RUN,
      sessionId: 'sess-attach',
      trajectoryId: 'traj-candidate',
      role: 'candidate',
      taskId: TASK,
      executionStatus: 'succeeded',
      artifact: { content: '{"ok":true,"value":42}', producedFiles: [] }
    })).receipt!;
    const malformed = { ...real, checks: [] } as unknown as HostVerificationReceipt;
    const hybrid: HostVerificationRunner = {
      ...host,
      verify: async () => ({ receipt: malformed }),
      receiptFor: () => malformed
    };
    const { disposition } = await verifyAndAttach({
      seam: { runner: hybrid },
      trajectory: candidate(),
      runId: RUN,
      taskId: TASK
    });
    expect(disposition?.attached).toBe(false);
    expect(disposition?.reasonCode).toBe('malformed-receipt');
  });

  it('an implicit payload is never trusted (implicit-payload)', async () => {
    const host = runner();
    const real = (await host.verify({
      runId: RUN,
      sessionId: 'sess-attach',
      trajectoryId: 'traj-candidate',
      role: 'candidate',
      taskId: TASK,
      executionStatus: 'succeeded',
      artifact: { content: '{"ok":true,"value":42}', producedFiles: [] }
    })).receipt!;
    const implicit = { ...real, implicit: true } as unknown as HostVerificationReceipt;
    const hybrid: HostVerificationRunner = {
      ...host,
      verify: async () => ({ receipt: implicit }),
      receiptFor: () => implicit
    };
    const { disposition } = await verifyAndAttach({
      seam: { runner: hybrid },
      trajectory: candidate(),
      runId: RUN,
      taskId: TASK
    });
    expect(disposition?.attached).toBe(false);
    expect(disposition?.reasonCode).toBe('implicit-payload');
  });
});

describe('c2a attach: host runner failures and default degradation', () => {
  it('a throwing runner is runner-error (no verdict, no record)', async () => {
    const { disposition, trajectory: verified } = await verifyAndAttach({
      seam: {
        runner: {
          verifierId: HOST_ID,
          verifierVersion: HOST_VERSION,
          testSetId: TEST_SET,
          envId: ENV,
          trustedProducers: new Set([HOST_ID]),
          verify: async () => {
            throw new Error('runner exploded');
          },
          receiptFor: () => undefined,
          size: 0
        }
      },
      trajectory: candidate(),
      runId: RUN,
      taskId: TASK
    });
    expect(disposition?.attached).toBe(false);
    expect(disposition?.reasonCode).toBe('runner-error');
    expect(disposition?.auditOnly).toBe(true);
    expect(verified.metadata?.['verification']).toBeUndefined();
  });

  it('a slow runner is runner-timeout when the seam declares a budget', async () => {
    const { disposition } = await verifyAndAttach({
      seam: {
        timeoutMs: 5,
        runner: {
          verifierId: HOST_ID,
          verifierVersion: HOST_VERSION,
          testSetId: TEST_SET,
          envId: ENV,
          trustedProducers: new Set([HOST_ID]),
          verify: () => new Promise(() => undefined),
          receiptFor: () => undefined,
          size: 0
        }
      },
      trajectory: candidate(),
      runId: RUN,
      taskId: TASK
    });
    expect(disposition?.reasonCode).toBe('runner-timeout');
    expect(disposition?.auditOnly).toBe(true);
  });

  it('a missing artifact is artifact-missing and never reaches the runner', async () => {
    const host = runner();
    let called = 0;
    const counting: HostVerificationRunner = {
      ...host,
      verify: async (request) => {
        called += 1;
        return host.verify(request);
      }
    };
    const { disposition } = await verifyAndAttach({
      seam: { runner: counting },
      trajectory: candidate({ deliverable: { content: '', format: 'text' } }),
      runId: RUN,
      taskId: TASK
    });
    expect(disposition?.reasonCode).toBe('artifact-missing');
    expect(called).toBe(0);
  });

  it('no seam (and a disabled seam) leaves the trajectory byte-identical', async () => {
    const original = candidate({ metadata: { kept: 1 } });
    const absent = await verifyAndAttach({
      seam: undefined,
      trajectory: original,
      runId: RUN,
      taskId: TASK
    });
    expect(absent.disposition).toBeUndefined();
    expect(absent.trajectory).toBe(original);
    const disabled = await verifyAndAttach({
      seam: { runner: runner(), enabled: false },
      trajectory: original,
      runId: RUN,
      taskId: TASK
    });
    expect(disabled.disposition).toBeUndefined();
    expect(disabled.trajectory).toBe(original);
  });

  it('an empty producer set still yields an authenticated receipt (consumer-side degradation)', async () => {
    const host = runner();
    const { trajectory: verified, disposition } = await verifyAndAttach({
      seam: seam(host),
      trajectory: candidate(),
      runId: RUN,
      taskId: TASK
    });
    expect(disposition?.authenticated).toBe(true);
    // The scorer's second necessary condition is NOT met when the caller passes
    // an empty set: shape-only, no task-quality evidence (ADR §4.5.3).
    const score = scoreUnderRewardContract(verified, { trustedProducers: new Set<string>() });
    expect(score.verification.trustedSource).toBe(false);
    expect(score.taskQualityLearningEligible).toBe(false);
  });
});

describe('c2a attach: persisted audit marks', () => {
  it('marks carry the two-gate facts and stay absent without a seam', async () => {
    const host = runner();
    const trusted = await verifyAndAttach({
      seam: seam(host),
      trajectory: candidate({ id: 'traj-marks-ok' }),
      runId: RUN,
      taskId: TASK
    });
    const disposition = readVerificationDisposition(trusted.trajectory);
    expect(disposition).toBeDefined();
    const marks = verificationRewardMarks({
      disposition,
      verdict: 'passed',
      trustedSource: true,
      outcomeEligible: true,
      consumed: true
    });
    expect(marks).toEqual({
      outcomeEligible: 1,
      verificationVerdict: 1,
      verificationTrusted: 1,
      verificationAuditOnly: 0
    });
    const auditMarks = verificationRewardMarks({
      disposition,
      verdict: 'failed',
      trustedSource: false,
      outcomeEligible: true,
      consumed: false
    });
    // An AUTHENTICATED disposition reports the HOST verdict (1 = passed here),
    // not the consumer-side status: the record keeps the real verdict even when
    // the record itself is audit-only.
    expect(auditMarks).toEqual({
      outcomeEligible: 1,
      verificationVerdict: 1,
      verificationTrusted: 0,
      verificationAuditOnly: 1
    });
    // A REJECTED (unauthenticated) receipt reports the consumer-side verdict
    // instead, so a rejected "passed" claim never appears as a record verdict.
    const rejected: VerificationDisposition = {
      attached: false,
      authenticated: false,
      auditOnly: true,
      reasonCode: 'digest-mismatch',
      reason: 'evidence hash mismatch',
      verdict: 'passed'
    };
    expect(
      verificationRewardMarks({
        disposition: rejected,
        verdict: 'unknown',
        trustedSource: false,
        outcomeEligible: true,
        consumed: true
      })
    ).toEqual({
      outcomeEligible: 1,
      verificationVerdict: 0,
      verificationTrusted: 0,
      verificationAuditOnly: 0
    });
    // No disposition => no marks at all (default assembly writes nothing).
    expect(
      verificationRewardMarks({
        disposition: undefined,
        verdict: 'unknown',
        trustedSource: false,
        outcomeEligible: true,
        consumed: true
      })
    ).toBeUndefined();
  });
});
