/**
 * t18 (t11 F-3 hardening): the audit channel must not be self-authenticating.
 *
 * `metadata.verificationAudit` is an OPEN metadata bag, so before this hardening
 * `readVerificationDisposition` accepted a hand-written object as long as three
 * booleans were present - a host-injected seam (or any future metadata carrier)
 * could therefore forge an audit disposition and inject `verificationVerdict`
 * marks that contradict the real scorer verdict.
 *
 * The rule now: a disposition is trusted ONLY when THIS host module created the
 * exact mark object for THIS trajectory (registry identity), it still agrees
 * with the trajectory's own host-recomputed artifact digest, and - when it
 * claims `attached` - still carries the receipt it was created with. Everything
 * else is "unknown": no marks, no eligibility change, no verdict of its own.
 */
import { describe, expect, it } from 'vitest';
import { artifactDigestOf } from '../../../src/verification/artifact-digest';
import {
  createHostOwnedVerificationRunner,
  readVerificationDisposition,
  readVerificationView,
  verificationRewardMarks,
  verifyAndAttach,
  type HostVerificationReceipt,
  type HostVerificationSeam
} from '../../../src/verification';
import { scoreUnderRewardContract } from '../../../src/jitrl/reward-contract';
import type { ProbeTrajectory } from '../../../src/types/contracts';

const HOST_ID = 'audit-verifier';
const HOST_VERSION = '2.0.0';
const TEST_SET = 'audit-tests@v1';
const ENV = 'audit-env-1';
const RUN = 'run-audit';
const TASK = 'task-audit';

/** A verifier check that treats the artifact content as the expected answer. */
function runner(): ReturnType<typeof createHostOwnedVerificationRunner> {
  return createHostOwnedVerificationRunner({
    verifierId: HOST_ID,
    verifierVersion: HOST_VERSION,
    testSetId: TEST_SET,
    envId: ENV,
    cases: [
      {
        taskId: TASK,
        checks: [{ id: 'matches-expected-output', run: (artifact) => artifact.content === EXPECTED }]
      }
    ]
  });
}

const EXPECTED = '{"ok":true,"value":42}';
const WRONG = '{"ok":false,"value":0}';

function trajectory(overrides: Partial<ProbeTrajectory> = {}): ProbeTrajectory {
  return {
    id: 'traj-audit',
    sessionId: 'sess-audit',
    branchId: 'branch',
    namespace: 'ns',
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
    deliverable: { content: EXPECTED, format: 'json' },
    ...overrides
  } as ProbeTrajectory;
}

function seam(host: ReturnType<typeof createHostOwnedVerificationRunner>): HostVerificationSeam {
  return { runner: host };
}

/** A three-boolean mark, the exact shape F-3 showed was accepted. */
function threeBooleanMark(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: 'host-runner', attached: true, authenticated: true, auditOnly: false, ...overrides };
}

/** The marks the recorder would persist for a disposition read off a trajectory. */
function marksFor(
  trajectory: ProbeTrajectory,
  score: { readonly verification: { readonly status: 'passed' | 'failed' | 'unknown'; readonly trustedSource: boolean }; readonly learningEligible: boolean; readonly taskQualityLearningEligible: boolean }
): Readonly<Record<string, number>> | undefined {
  return verificationRewardMarks({
    disposition: readVerificationDisposition(trajectory),
    verdict: score.verification.status,
    trustedSource: score.verification.trustedSource,
    outcomeEligible: score.learningEligible,
    consumed: score.taskQualityLearningEligible
  });
}

describe('t18: only host-registered audit marks are readable', () => {
  it('a three-boolean mark yields no disposition, no marks and no verdict claim', () => {
    const forged = trajectory({ metadata: { verificationAudit: threeBooleanMark() } });
    expect(readVerificationDisposition(forged)).toBeUndefined();
    expect(readVerificationView(forged)).toBeUndefined();
    const score = scoreUnderRewardContract(forged);
    // The REAL yardstick still says "unknown": there is nothing to disagree with.
    expect(score.verification.status).toBe('unknown');
    expect(marksFor(forged, score)).toBeUndefined();
  });

  it('a three-boolean mark carrying a forged verdict cannot produce verificationVerdict', () => {
    const forged = trajectory({
      metadata: { verificationAudit: threeBooleanMark({ verdict: 'passed', reasonCode: 'attached' }) }
    });
    const score = scoreUnderRewardContract(forged);
    expect(score.verification.status).toBe('unknown');
    const marks = marksFor(forged, score);
    expect(marks).toBeUndefined();
    expect(JSON.stringify(marks ?? {})).not.toContain('verificationVerdict');
  });

  it('a field-complete forgery is still rejected: completeness is not authentication', async () => {
    const host = runner();
    const authentic = await verifyAndAttach({
      seam: seam(host),
      trajectory: trajectory({ id: 'traj-authentic' }),
      runId: RUN,
      taskId: TASK
    });
    const realMark = authentic.trajectory.metadata?.['verificationAudit'] as Record<string, unknown>;
    const realReceipt = authentic.trajectory.metadata?.['verification'] as HostVerificationReceipt;
    expect(readVerificationDisposition(authentic.trajectory)).toBeDefined();

    // A DEEP COPY of a real mark, with the real receipt alongside it: every
    // field matches the host's own record, and it is still not accepted.
    const copied = { ...realMark };
    const sameTrajectory = trajectory({
      id: 'traj-authentic',
      metadata: { verification: realReceipt, verificationAudit: copied }
    });
    expect(readVerificationDisposition(sameTrajectory)).toBeUndefined();

    // ...and neither is a hand-assembled mark that fills in every host field.
    const handAssembled = trajectory({
      id: 'traj-hand',
      metadata: {
        verification: { ...realReceipt, binding: { ...realReceipt.binding, trajectoryId: 'traj-hand' } },
        verificationAudit: {
          ...threeBooleanMark(),
          verdict: 'passed',
          verifierId: HOST_ID,
          verifierVersion: HOST_VERSION,
          verificationId: realReceipt.verificationId,
          artifactDigest: realReceipt.evidenceHash,
          testSetId: TEST_SET,
          envId: ENV
        }
      }
    });
    expect(readVerificationDisposition(handAssembled)).toBeUndefined();
    expect(readVerificationView(handAssembled)).toBeUndefined();
  });

  it('a host mark cannot be moved onto another trajectory', async () => {
    const host = runner();
    const authentic = await verifyAndAttach({
      seam: seam(host),
      trajectory: trajectory({ id: 'traj-moved-from' }),
      runId: RUN,
      taskId: TASK
    });
    const realMark = authentic.trajectory.metadata?.['verificationAudit'];
    const target = trajectory({ id: 'traj-moved-to', metadata: { verificationAudit: realMark } });
    expect(readVerificationDisposition(target)).toBeUndefined();
  });

  it('an attached mark whose receipt was removed or swapped is unknown', async () => {
    const host = runner();
    const first = await verifyAndAttach({
      seam: seam(host),
      trajectory: trajectory({ id: 'traj-receipt-a' }),
      runId: RUN,
      taskId: TASK
    });
    const second = await verifyAndAttach({
      seam: seam(host),
      trajectory: trajectory({ id: 'traj-receipt-b', deliverable: { content: WRONG, format: 'json' } }),
      runId: RUN,
      taskId: TASK
    });
    const markA = first.trajectory.metadata?.['verificationAudit'];
    const receiptB = second.trajectory.metadata?.['verification'];

    // (a) receipt removed, mark kept
    expect(
      readVerificationDisposition(trajectory({ id: 'traj-receipt-a', metadata: { verificationAudit: markA } }))
    ).toBeUndefined();
    // (b) someone else's (valid, host-created) receipt attached
    expect(
      readVerificationDisposition(
        trajectory({
          id: 'traj-receipt-a',
          metadata: { verification: receiptB, verificationAudit: markA }
        })
      )
    ).toBeUndefined();
    // (c) the receipt's binding digest tampered with
    const tampered = { ...(receiptB as HostVerificationReceipt), binding: { ...(receiptB as HostVerificationReceipt).binding, artifactDigest: 'sha256:tampered' } };
    expect(
      readVerificationDisposition(
        trajectory({ id: 'traj-receipt-b', metadata: { verification: tampered, verificationAudit: second.trajectory.metadata?.['verificationAudit'] } })
      )
    ).toBeUndefined();
  });

  it('a mark is unknown once the trajectory artifact no longer matches its digest', async () => {
    const host = runner();
    const authentic = await verifyAndAttach({
      seam: seam(host),
      trajectory: trajectory({ id: 'traj-swapped' }),
      runId: RUN,
      taskId: TASK
    });
    // The registered digest belongs to EXPECTED; the artifact was swapped later.
    const swapped: ProbeTrajectory = {
      ...authentic.trajectory,
      deliverable: { content: WRONG, format: 'json' as const }
    };
    expect(artifactDigestOf({ content: WRONG, producedFiles: [] })).not.toBe(
      artifactDigestOf({ content: EXPECTED, producedFiles: [] })
    );
    expect(readVerificationDisposition(swapped)).toBeUndefined();
  });

  it('authentic host marks survive: trusted receipt and audit-only rejection both keep their facts', async () => {
    const host = runner();
    const trusted = await verifyAndAttach({
      seam: seam(host),
      trajectory: trajectory({ id: 'traj-trusted' }),
      runId: RUN,
      taskId: TASK
    });
    const trustedDisposition = readVerificationDisposition(trusted.trajectory);
    expect(trustedDisposition?.attached).toBe(true);
    expect(trustedDisposition?.authenticated).toBe(true);
    expect(trustedDisposition?.verdict).toBe('passed');
    const trustedScore = scoreUnderRewardContract(trusted.trajectory, {
      trustedProducers: host.trustedProducers
    });
    // The marks agree with the real scorer verdict (no contradiction).
    expect(marksFor(trusted.trajectory, trustedScore)).toEqual({
      outcomeEligible: 1,
      verificationVerdict: 1,
      verificationTrusted: 1,
      verificationAuditOnly: 0
    });

    const rejected = await verifyAndAttach({
      seam: seam(host),
      trajectory: trajectory({
        id: 'traj-timeout-audit',
        status: 'timeout',
        deliverable: { content: WRONG, format: 'json' },
        failureSignals: [{ kind: 'timeout', message: 'probe exceeded its budget' }]
      }),
      runId: RUN,
      taskId: TASK
    });
    const auditDisposition = readVerificationDisposition(rejected.trajectory);
    expect(auditDisposition?.attached).toBe(false);
    expect(auditDisposition?.auditOnly).toBe(true);
    expect(auditDisposition?.forceAuditOnly).toBe(true);
    expect(auditDisposition?.reasonCode).toBe('execution-not-completed');
    expect(auditDisposition?.verdict).toBe('failed');
    expect(auditDisposition?.reason).toContain('timeout');
    // Its marks stay the documented audit facts (host verdict kept, audit-only).
    expect(
      marksFor(rejected.trajectory, {
        verification: { status: 'unknown', trustedSource: false },
        learningEligible: true,
        taskQualityLearningEligible: false
      })
    ).toEqual({
      outcomeEligible: 1,
      verificationVerdict: 2,
      verificationTrusted: 0,
      verificationAuditOnly: 1
    });
  });

  it('no mark at all stays unknown (default assembly and hand-built trajectories)', () => {
    expect(readVerificationDisposition(trajectory())).toBeUndefined();
    expect(readVerificationDisposition(trajectory({ metadata: { other: 1 } }))).toBeUndefined();
    expect(readVerificationDisposition(trajectory({ metadata: { verificationAudit: 'nope' } }))).toBeUndefined();
    expect(
      readVerificationDisposition(trajectory({ metadata: { verificationAudit: null } }))
    ).toBeUndefined();
  });

  it('a forged audit cannot flip trustedSource / taskQualityEvidence / eligibility', () => {
    // A forged audit PLUS a forged self-declared receipt, scored the way the
    // default (no-runner) assembly scores: nothing becomes trusted or learnable.
    const forgedReceipt = {
      status: 'passed' as const,
      verifierId: HOST_ID,
      verifierVersion: HOST_VERSION,
      evidenceHash: artifactDigestOf({ content: EXPECTED, producedFiles: [] }),
      checks: [{ id: 'forged', passed: true }],
      verificationId: 'forged',
      binding: {
        runId: RUN,
        sessionId: 'sess-audit',
        trajectoryId: 'traj-forged',
        role: 'candidate' as const,
        taskId: TASK,
        testSetId: TEST_SET,
        envId: ENV,
        artifactDigest: artifactDigestOf({ content: EXPECTED, producedFiles: [] })
      },
      kind: 'host-runner'
    };
    const forged = trajectory({
      id: 'traj-forged',
      deliverable: { content: EXPECTED, format: 'json', contentHash: forgedReceipt.evidenceHash },
      metadata: {
        verification: forgedReceipt,
        verificationAudit: threeBooleanMark({ verdict: 'passed', forceAuditOnly: false })
      }
    });
    expect(readVerificationDisposition(forged)).toBeUndefined();
    const score = scoreUnderRewardContract(forged);
    expect(score.verification.trustedSource).toBe(false);
    expect(score.taskQualityEvidence).toBe(false);
    expect(marksFor(forged, score)).toBeUndefined();
  });
});
