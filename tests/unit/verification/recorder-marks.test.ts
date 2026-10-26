/**
 * C2a (ADR 0003 §5.1-§5.3): the PRODUCTION recorder consumes the host verdict.
 *
 * These tests drive the real `recordOnlineExperience` (no rule duplication) over
 * trajectories that went through the real `verifyAndAttach` path, and read the
 * records back from a real experience store. They pin:
 *   - the two gates (`outcomeEligible` vs `consumptionEligible`) and the
 *     audit-only encoding (`learningEligible:false` + reward 0) that keeps an
 *     unauthenticated verdict out of every learning neighbourhood, support and
 *     nEff count;
 *   - the task-quality track stamp for host-authenticated verdicts, and the
 *     honest `process` stamp for everything else;
 *   - the persisted `rewardSources` marks (the only repr. the frozen record
 *     contract allows, C2a-O1);
 *   - idempotency (one trajectory => one record) and the unchanged r4 scale;
 *   - the no-seam default: no marks, no track change, the old stage literal.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryExperienceStore } from '../../../src/jitrl/stores/memory.store';
import { LEARNING_CONSUMER_FILTER, filterExperienceSnapshot } from '../../../src/jitrl/decision-kernel';
import { PRODUCTION_LEARNING_TRACK, isOnLearningTrack } from '../../../src/jitrl/experience-store';
import { REWARD_CONTRACT, contractWeightsHash, scoreUnderRewardContract } from '../../../src/jitrl/reward-contract';
import { EvoHarnessOrchestratorImpl, type EvoHarnessOrchestratorDeps } from '../../../src/orchestrator';
import { resolveExecutionProfile } from '../../../src/runtime/execution-profile';
import {
  createHostOwnedVerificationRunner,
  readVerificationView,
  verifyAndAttach,
  type HostVerificationSeam
} from '../../../src/verification';
import type { ExperienceRecord, ProbeTrajectory } from '../../../src/types/contracts';

const T0 = 1_700_000_000_000;
const RUN = 'run-recorder';
const TASK = 'task-c2a';
const HOST_ID = 'c2a-verifier';

function trajectory(overrides: Partial<ProbeTrajectory> = {}): ProbeTrajectory {
  return {
    id: 'traj-recorder',
    sessionId: 'sess-recorder',
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

function hostRunner() {
  return createHostOwnedVerificationRunner({
    verifierId: HOST_ID,
    verifierVersion: '1.0.0',
    testSetId: 'tests@v1',
    envId: 'env-local-1',
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

interface Harness {
  readonly store: ReturnType<typeof createMemoryExperienceStore>;
  readonly appended: ExperienceRecord[];
  readonly record: (input: {
    readonly executed: readonly unknown[];
    readonly reference: ProbeTrajectory;
    readonly selectedNodeId?: string | null;
    readonly stage?: (name: string, detail?: Readonly<Record<string, unknown>>) => void;
  }) => Promise<number>;
  readonly stages: { readonly name: string; readonly detail?: Readonly<Record<string, unknown>> }[];
}

function harness(seam: HostVerificationSeam | undefined): Harness {
  const store = createMemoryExperienceStore({ now: () => T0 + 1000 });
  const appended: ExperienceRecord[] = [];
  const stages: { name: string; detail?: Readonly<Record<string, unknown>> }[] = [];
  const kernel = {
    config: { enabled: true, levels: ['meta', 'proposal'], gamma: 0.9, candidateCount: 3 },
    store: {
      append: async (records: readonly ExperienceRecord[]) => {
        appended.push(...records);
        await store.append(records);
      },
      query: (query: never) => store.query(query),
      size: () => store.size()
    },
    stepEvaluator: { evaluate: async () => [] }
  };
  const deps = {
    config: { probe: { maxConcurrentProbes: 1, probeTimeoutMs: 1000 } },
    memory: {},
    seams: {},
    policy: {},
    proposer: {},
    composer: {},
    reflector: {},
    scorer: {},
    taxonomy: {},
    dreamer: {},
    treePool: {},
    runBranch: async () => ({}),
    jitrl: kernel,
    executionProfile: resolveExecutionProfile({ mode: 'shadow' }),
    ...(seam === undefined ? {} : { verification: seam })
  } as unknown as EvoHarnessOrchestratorDeps;
  const orch = new EvoHarnessOrchestratorImpl(deps);
  const internals = orch as unknown as {
    recordOnlineExperience: (input: never) => Promise<number>;
  };
  return {
    store,
    appended,
    stages,
    record: async (input) => {
      const result = await internals.recordOnlineExperience({
        kernel,
        task: { id: TASK, prompt: 'verify the artifact' },
        sessionId: 'sess-recorder',
        executed: input.executed,
        reference: input.reference,
        selectedNodeId: input.selectedNodeId ?? null,
        policyId: 'pi',
        runId: RUN,
        treeId: 'tree-recorder',
        round: 1,
        stage: (name: string, detail?: Readonly<Record<string, unknown>>) => {
          stages.push({ name, detail });
          input.stage?.(name, detail);
        },
        diagnostics: []
      } as never);
      return result;
    }
  };
}

function probeEntry(entry: ProbeTrajectory, overrides: Record<string, unknown> = {}): unknown {
  return {
    round: 1,
    slotIndex: 0,
    slot: { slot: 'exploit', slotIndex: 0, branchId: entry.branchId, guidance: 'memory' },
    l1State: { level: 'meta', bucket: 'b', tokens: ['t'], summary: '' },
    nodeId: 'n1',
    parentNodeId: 'root',
    branchId: entry.branchId,
    actionKey: 'slot:exploit',
    guidance: 'memory',
    trajectory: entry,
    ...overrides
  };
}

async function learningRecords(
  store: ReturnType<typeof createMemoryExperienceStore>,
  level: 'meta' | 'proposal' = 'meta'
): Promise<readonly ExperienceRecord[]> {
  const rows = await store.query({
    level,
    state: { level, bucket: 'b', tokens: ['t'], summary: '' },
    k: 10,
    similarityThreshold: 0,
    learningEligibleOnly: true
  });
  return rows.map((row) => row.record);
}

/** The orchestrator passes `{ round, detail }` as the stage payload. */
function recordStageDetail(
  stages: readonly { readonly name: string; readonly detail?: Readonly<Record<string, unknown>> }[]
): Readonly<Record<string, unknown>> | undefined {
  const entry = stages.find((candidate) => candidate.name === 'record_experience');
  const payload = entry?.detail as { readonly detail?: Readonly<Record<string, unknown>> } | undefined;
  return payload?.detail;
}

describe('c2a recorder: host-authenticated verdicts become task-quality records', () => {
  it('trusted passed => task-quality positive record with the host marks', async () => {
    const host = hostRunner();
    const seam: HostVerificationSeam = { runner: host };
    const raw = trajectory({ id: 'traj-positive' });
    const attached = await verifyAndAttach({ seam, trajectory: raw, runId: RUN, taskId: TASK });
    const h = harness(seam);
    const reference = await verifyAndAttach({
      seam,
      trajectory: trajectory({
        id: 'traj-reference',
        role: 'reference',
        status: 'failed',
        deliverable: { content: '{"ok":false}', format: 'json' },
        error: { name: 'ToolError', message: 'the baseline build failed' }
      }),
      runId: RUN,
      taskId: TASK
    });
    const written = await h.record({
      executed: [probeEntry(attached.trajectory)],
      reference: reference.trajectory
    });
    expect(written).toBe(1);
    const record = h.appended[0];
    expect(record).toBeDefined();
    expect(record?.learningTrack).toBe('task-quality');
    expect(record?.learningEligible).toBe(true);
    expect(record?.outcome).toBe('succeeded');
    expect(record?.reward).toBeGreaterThan(0);
    expect(record?.observedReturn).toBe(record?.reward);
    expect(record?.rewardSources).toMatchObject({
      outcomeEligible: 1,
      verificationVerdict: 1,
      verificationTrusted: 1,
      verificationAuditOnly: 0
    });
    // The trusted-producer set the recorder forwarded made the hash binding real.
    expect(readVerificationView(attached.trajectory)?.receipt?.verifierId).toBe(HOST_ID);
    // ADR §4.4 same-volume: the recorder scored the BASELINE through the same
    // predicate and the same producer set as the candidate. The numeric value is
    // set-independent by construction; what the set decides is CONSUMPTION, so
    // the same-volume proof is that the baseline is task-quality eligible here
    // and would be audit-only without the set.
    const verifiedBaseline = scoreUnderRewardContract(reference.trajectory, {
      trustedProducers: host.trustedProducers
    });
    const unverifiedBaseline = scoreUnderRewardContract(reference.trajectory);
    expect(record?.attributionBaseline).toBeCloseTo(verifiedBaseline.reward, 12);
    expect(verifiedBaseline.taskQualityLearningEligible).toBe(true);
    expect(unverifiedBaseline.taskQualityLearningEligible).toBe(false);
    // ADR §5.4 honesty: the record IS task-quality, yet every production
    // consumer pins the process track, so it is written-but-not-consumed.
    expect(isOnLearningTrack(record!, PRODUCTION_LEARNING_TRACK)).toBe(false);
    expect(await learningRecords(h.store)).toHaveLength(1);
  });

  it('a trusted failed verdict on a succeeded run is audit-only (ADR A) and unreadable to consumers', async () => {
    const host = hostRunner();
    const seam: HostVerificationSeam = { runner: host };
    const attached = await verifyAndAttach({
      seam,
      trajectory: trajectory({
        id: 'traj-falsified',
        deliverable: { content: '{"ok":false}', format: 'json' }
      }),
      runId: RUN,
      taskId: TASK
    });
    expect(attached.disposition?.reasonCode).toBe('falsified-success-claim');
    const h = harness(seam);
    const reference = await verifyAndAttach({
      seam,
      trajectory: trajectory({ id: 'traj-ref', role: 'reference' }),
      runId: RUN,
      taskId: TASK
    });
    await h.record({ executed: [probeEntry(attached.trajectory)], reference: reference.trajectory });
    const record = h.appended[0];
    expect(record?.learningEligible).toBe(false);
    expect(record?.reward).toBe(0);
    expect(record?.observedReturn).toBe(0);
    expect(record?.learningTarget).toBe(0);
    expect(record?.learningTrack).toBe('process');
    // The verdict and the reason survive for audit...
    expect(record?.rewardSources).toMatchObject({
      outcomeEligible: 1,
      verificationVerdict: 2,
      verificationTrusted: 1,
      verificationAuditOnly: 1
    });
    expect(readVerificationView(attached.trajectory)?.disposition.reason).toContain('refuted');
    // ...but the record enters NO learning neighbourhood, NO support, NO nEff.
    expect(await learningRecords(h.store)).toHaveLength(0);
    const snapshot = filterExperienceSnapshot(h.appended, {
      level: 'proposal',
      ...LEARNING_CONSUMER_FILTER
    });
    expect(snapshot).toHaveLength(0);
  });

  it('timeout + trusted failed never becomes reliable-failure evidence', async () => {
    const host = hostRunner();
    const seam: HostVerificationSeam = { runner: host };
    const attached = await verifyAndAttach({
      seam,
      trajectory: trajectory({
        id: 'traj-timeout',
        status: 'timeout',
        deliverable: { content: '{"ok":false}', format: 'json' },
        failureSignals: [{ kind: 'timeout', message: 'budget exhausted' }]
      }),
      runId: RUN,
      taskId: TASK
    });
    expect(attached.disposition?.reasonCode).toBe('execution-not-completed');
    const h = harness(seam);
    const reference = await verifyAndAttach({
      seam,
      trajectory: trajectory({ id: 'traj-ref2', role: 'reference' }),
      runId: RUN,
      taskId: TASK
    });
    await h.record({ executed: [probeEntry(attached.trajectory)], reference: reference.trajectory });
    const record = h.appended[0];
    expect(record?.outcome).toBe('timeout');
    expect(record?.learningEligible).toBe(false);
    expect(record?.learningTrack).toBe('process');
    expect(record?.reward).toBe(0);
    expect(record?.rewardSources).toMatchObject({ verificationVerdict: 2, verificationAuditOnly: 1 });
    expect(await learningRecords(h.store)).toHaveLength(0);
  });

  it('a one-sided run (no reference receipt) is audit-only even for a verified candidate', async () => {
    const host = hostRunner();
    const seam: HostVerificationSeam = { runner: host };
    const attached = await verifyAndAttach({
      seam,
      trajectory: trajectory({ id: 'traj-one-sided' }),
      runId: RUN,
      taskId: TASK,
      referenceReceiptMissing: true
    });
    expect(attached.disposition?.reasonCode).toBe('reference-receipt-missing');
    const h = harness(seam);
    await h.record({
      executed: [probeEntry(attached.trajectory)],
      reference: trajectory({ id: 'traj-ref3', role: 'reference' })
    });
    expect(h.appended[0]?.learningEligible).toBe(false);
    expect(h.appended[0]?.reward).toBe(0);
    expect(await learningRecords(h.store)).toHaveLength(0);
  });

  it('t18: a forged verificationAudit cannot force audit-only or inject marks', async () => {
    // The reachable shape t11/F-3 measured: a trajectory that arrives with a
    // hand-written audit disposition (three booleans plus a claimed verdict and
    // `forceAuditOnly`), which pre-hardening would have flipped the record to
    // audit-only and written a `verificationVerdict` mark that contradicts the
    // real (unknown) scorer verdict.
    const forged = trajectory({
      id: 'traj-forged-audit',
      metadata: {
        verificationAudit: {
          kind: 'host-runner',
          attached: false,
          authenticated: true,
          auditOnly: true,
          forceAuditOnly: true,
          verdict: 'failed',
          reasonCode: 'execution-not-completed',
          reason: 'forged: pretend the host refused this probe'
        }
      }
    });
    // No verification seam: the forged mark must stay unknown.
    const h = harness(undefined);
    await h.record({
      executed: [probeEntry(forged)],
      reference: trajectory({ id: 'traj-forged-ref', role: 'reference' })
    });
    const record = h.appended[0];
    expect(record).toBeDefined();
    // No forged marks and no forged audit encoding: the record keeps the plain
    // process shape it would have had with a clean trajectory.
    expect(record?.rewardSources).not.toHaveProperty('verificationVerdict');
    expect(record?.rewardSources).not.toHaveProperty('verificationAuditOnly');
    expect(record?.rewardSources).not.toHaveProperty('outcomeEligible');
    expect(record?.learningEligible).toBe(true);
    expect(record?.learningTrack).toBe('process');
    expect(record?.reward).not.toBe(0);
    const detail = recordStageDetail(h.stages);
    expect(detail?.['trustedVerificationSource']).toBe(
      'shape-only (C2-pre: no trusted producer registered)'
    );
    expect(detail?.['notLearningEligible']).toBe(0);
  });

  it('idempotency: the same trajectory never produces a second record', async () => {
    const host = hostRunner();
    const seam: HostVerificationSeam = { runner: host };
    const attached = await verifyAndAttach({
      seam,
      trajectory: trajectory({ id: 'traj-idem' }),
      runId: RUN,
      taskId: TASK
    });
    const h = harness(seam);
    const reference = await verifyAndAttach({
      seam,
      trajectory: trajectory({ id: 'traj-ref-idem', role: 'reference' }),
      runId: RUN,
      taskId: TASK
    });
    const first = await h.record({
      executed: [probeEntry(attached.trajectory)],
      reference: reference.trajectory
    });
    const second = await h.record({
      executed: [probeEntry(attached.trajectory)],
      reference: reference.trajectory
    });
    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(h.appended).toHaveLength(1);
  });

  it('with no seam the record is byte-identical to the C2-pre shape (no marks, old literal)', async () => {
    const h = harness(undefined);
    const raw = trajectory({ id: 'traj-no-seam' });
    const reference = trajectory({ id: 'traj-ref-no-seam', role: 'reference' });
    await h.record({ executed: [probeEntry(raw)], reference });
    const record = h.appended[0];
    expect(record?.learningEligible).toBe(true);
    expect(record?.learningTrack).toBe('process');
    expect(record?.rewardSources).not.toHaveProperty('verificationVerdict');
    expect(record?.rewardSources).not.toHaveProperty('outcomeEligible');
    const stage = recordStageDetail(h.stages);
    expect(stage?.['trustedVerificationSource']).toBe(
      'shape-only (C2-pre: no trusted producer registered)'
    );
  });

  it('with a seam the stage detail reports the real host source, not a constant claim', async () => {
    const host = hostRunner();
    const seam: HostVerificationSeam = { runner: host };
    const attached = await verifyAndAttach({
      seam,
      trajectory: trajectory({ id: 'traj-stage' }),
      runId: RUN,
      taskId: TASK
    });
    const h = harness(seam);
    const reference = await verifyAndAttach({
      seam,
      trajectory: trajectory({ id: 'traj-ref-stage', role: 'reference' }),
      runId: RUN,
      taskId: TASK
    });
    await h.record({ executed: [probeEntry(attached.trajectory)], reference: reference.trajectory });
    const detail = recordStageDetail(h.stages);
    const source = String(detail?.['trustedVerificationSource']);
    expect(source).toContain('host-runner:c2a-verifier@1.0.0');
    // The reference receipt counts too: one candidate + one reference.
    expect(source).toMatch(/trusted=\d+, audit-only=\d+/);
  });
});

describe('c2a recorder: the r4 yardstick itself is untouched', () => {
  it('trust changes eligibility/track, never the numeric scale', async () => {
    const host = hostRunner();
    const seam: HostVerificationSeam = { runner: host };
    const attached = await verifyAndAttach({
      seam,
      trajectory: trajectory({ id: 'traj-scale' }),
      runId: RUN,
      taskId: TASK
    });
    const h = harness(seam);
    const reference = await verifyAndAttach({
      seam,
      trajectory: trajectory({ id: 'traj-ref-scale', role: 'reference' }),
      runId: RUN,
      taskId: TASK
    });
    await h.record({ executed: [probeEntry(attached.trajectory)], reference: reference.trajectory });
    const record = h.appended[0];
    expect(REWARD_CONTRACT.version).toBe('r4/verifier-first-v1');
    expect(REWARD_CONTRACT.aggregation).toBe('trajectory-signals-v1');
    // The persisted weights hash is what a review can diff against HEAD.
    expect(contractWeightsHash()).toBe(contractWeightsHash());
    expect(record?.rewardVersion).toBe('r4/verifier-first-v1');
    // The recorded reward is exactly the shared yardstick value (clamped), not a
    // verification-specific bonus.
    expect(record?.observedReturn).toBe(record?.reward);
  });
});
