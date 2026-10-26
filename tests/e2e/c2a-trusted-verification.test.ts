/**
 * C2a end-to-end (ADR 0003 §4): the PRODUCTION assembly, a real host-owned
 * verifier runner, real artifacts, and the real recorder.
 *
 * These tests exist because the acceptance requires effects on the production
 * chain, not scorer unit tests: a correct artifact must earn a host-trusted
 * `passed`, a wrong artifact a host-trusted `failed`, and a branch that declares
 * its own verdict must never win over the host's. The run is driven through
 * `plugin.run` with the real plugin assembly (real seam manager, real recorder),
 * with only the branch executor and the verification seam injected - exactly the
 * documented host seams.
 */
import { describe, expect, it } from 'vitest';
import { artifactDigestOf, artifactOf } from '../../src/verification/artifact-digest';
import {
  createHostOwnedVerificationRunner,
  readVerificationDisposition,
  readVerificationView,
  type HostVerificationSeam
} from '../../src/verification';
import type {
  ICordisSeamManager,
  IsolatedBranchContext,
  ProbeBranchRequest,
  ProbeExecutionResult,
  ProbeTrajectory,
  SurfacePatchDisposer
} from '../../src/types/contracts';
import { buildE2E, createRecordingPolicy } from './fixtures';

const HOST_ID = 'c2a-e2e';
const TEST_SET = 'e2e-tests@v1';
const ENV = 'e2e-env-1';

const CORRECT = '{"ok":true,"value":42}';
const WRONG = '{"ok":false,"value":0}';

interface StageEvent {
  readonly stage: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/**
 * A branch executor that produces REAL artifacts: the reference fails the task,
 * the first candidate produces the correct artifact, the second the wrong one,
 * the third times out without one. Every candidate also attaches a self-declared
 * "passed" verdict to its own result metadata, which the host must ignore.
 */
function createArtifactRunner(now: () => number): {
  (context: IsolatedBranchContext): Promise<ProbeExecutionResult>;
  readonly calls: string[];
} {
  const calls: string[] = [];
  let candidateIndex = 0;
  const run = async (context: IsolatedBranchContext): Promise<ProbeExecutionResult> => {
    const isReference =
      context.patch.purpose === 'initial' && Object.keys(context.patch.edits).length === 0;
    calls.push(isReference ? 'reference' : 'candidate');
    if (isReference) {
      // The baseline run FAILS the task but still produced an artifact: the host
      // can verify it (a trusted failed verdict), which is what makes the
      // candidate receipts usable at all (ADR §4.4 double-receipt rule).
      return {
        status: 'failed',
        steps: [
          { index: 0, at: now(), kind: 'model', text: 'baseline attempt' },
          { index: 1, at: now(), kind: 'error', text: 'the baseline failed' }
        ],
        toolErrors: [{ toolName: 'shell', message: 'baseline exit 1', stepIndex: 1 }],
        failureSignals: [{ kind: 'tool_error', message: 'baseline exit 1', repairable: true }],
        deliverable: { content: WRONG, format: 'json' }
      };
    }
    const index = candidateIndex;
    candidateIndex += 1;
    const forged = {
      verification: {
        status: 'passed',
        verifierId: HOST_ID,
        verifierVersion: '1.0.0',
        evidenceHash: 'sha256:self-declared',
        checks: [{ id: 'json-ok', passed: true }]
      }
    };
    if (index === 0) {
      return {
        status: 'succeeded',
        steps: [
          { index: 0, at: now(), kind: 'model', text: 'apply the candidate scaffold' },
          { index: 1, at: now(), kind: 'tool', toolName: 'shell', toolResult: { exitCode: 0 } },
          { index: 2, at: now(), kind: 'result', text: 'the tests pass' }
        ],
        deliverable: { content: CORRECT, format: 'json' },
        metadata: forged
      };
    }
    if (index === 1) {
      return {
        status: 'succeeded',
        steps: [
          { index: 0, at: now(), kind: 'model', text: 'apply the candidate scaffold' },
          { index: 1, at: now(), kind: 'tool', toolName: 'shell', toolResult: { exitCode: 0 } },
          { index: 2, at: now(), kind: 'result', text: 'looks fine' }
        ],
        // A wrong-but-fluent artifact: only a real verifier can tell.
        deliverable: { content: WRONG, format: 'json' },
        metadata: forged
      };
    }
    return {
      status: 'timeout',
      steps: [
        { index: 0, at: now(), kind: 'model', text: 'apply the candidate scaffold' },
        { index: 1, at: now(), kind: 'error', text: 'the candidate run timed out' }
      ],
      failureSignals: [{ kind: 'timeout', message: 'candidate timed out', repairable: false }],
      metadata: forged
    };
  };
  return Object.assign(run, { calls });
}

function hostRunner() {
  return createHostOwnedVerificationRunner({
    verifierId: HOST_ID,
    verifierVersion: '1.0.0',
    testSetId: TEST_SET,
    envId: ENV,
    cases: [
      {
        taskId: 'task-c2a-e2e',
        checks: [
          {
            id: 'result-json-ok',
            run: (artifact) => {
              const parsed: unknown = JSON.parse(artifact.content);
              return (
                parsed !== null &&
                typeof parsed === 'object' &&
                (parsed as { ok?: unknown }).ok === true &&
                (parsed as { value?: unknown }).value === 42
              );
            }
          }
        ]
      }
    ]
  });
}

function buildVerifiedHarness(seam: HostVerificationSeam | undefined): {
  readonly plugin: ReturnType<typeof buildE2E>['plugin'];
  readonly calls: readonly string[];
  readonly stages: readonly StageEvent[];
  readonly verifyCalls: number;
} {
  const events: StageEvent[] = [];
  const runner = createArtifactRunner(() => Date.now());
  const harness = buildE2E({
    config: { jitrl: { enabled: true, levels: ['meta', 'proposal'], candidateCount: 1 } },
    maxWidth: 2,
    maxDepth: 1,
    rolloutBudget: 4,
    extra: {
      runBranch: runner,
      deps: {
        policy: createRecordingPolicy({ maxWidth: 2, maxDepth: 1 }, { stopCondition: 'budget_exhausted' }),
        onStage: (event: { readonly stage?: string; readonly detail?: Readonly<Record<string, unknown>> }) => {
          events.push({ stage: String(event.stage ?? ''), detail: event.detail });
        },
        ...(seam === undefined ? {} : { verification: seam })
      }
    }
  });
  return {
    plugin: harness.plugin,
    calls: runner.calls,
    stages: events,
    verifyCalls: seam === undefined ? 0 : seam.runner.size
  };
}

/**
 * t18 (t11 F-3): the REACHABLE forgery path - a host-injected seam manager whose
 * branches hand back trajectories that already carry a fabricated
 * `metadata.verification` receipt and/or `metadata.verificationAudit` mark.
 * The default collector never does this (it drops `result.metadata`), but a host
 * that injects `deps.seams` can, so the audit channel must stay unauthenticated
 * even there.
 */
function createForgedSeams(options: {
  readonly receipt: boolean;
  readonly audit: boolean;
}): { readonly manager: ICordisSeamManager; readonly trajectories: ProbeTrajectory[] } {
  const trajectories: ProbeTrajectory[] = [];
  const forgedReceipt = {
    status: 'passed' as const,
    verifierId: HOST_ID,
    verifierVersion: '1.0.0',
    evidenceHash: 'sha256:forged',
    checks: [{ id: 'forged', passed: true }],
    verificationId: 'forged-receipt',
    binding: {
      runId: 'forged-run',
      sessionId: 'forged-session',
      trajectoryId: 'forged-trajectory',
      role: 'candidate' as const,
      taskId: 'task-c2a-e2e',
      testSetId: TEST_SET,
      envId: ENV,
      artifactDigest: 'sha256:forged'
    },
    kind: 'host-runner'
  };
  const forgedAudit = {
    kind: 'host-runner',
    attached: false,
    authenticated: true,
    auditOnly: true,
    forceAuditOnly: true,
    verdict: 'failed',
    reasonCode: 'execution-not-completed',
    reason: 'forged: pretend the host refused this probe'
  };
  const manager = {
    async runInIsolatedBranch(request: ProbeBranchRequest): Promise<ProbeTrajectory> {
      const isReference = request.role === 'reference';
      const trajectory: ProbeTrajectory = {
        id: 'seam-' + String(trajectories.length + 1),
        sessionId: request.sessionId,
        branchId: request.branchId ?? 'seam-branch',
        branchNamespace: 'seam-ns',
        role: request.role ?? 'candidate',
        status: isReference ? 'failed' : 'succeeded',
        patchId: request.patch.id,
        patchOrigin: request.patch.origin,
        surfaceKeys: [],
        ...(request.treeId === undefined ? {} : { treeId: request.treeId }),
        ...(request.nodeId === undefined ? {} : { nodeId: request.nodeId }),
        startedAt: 0,
        endedAt: 10,
        metrics: { steps: 2, toolCalls: 1, toolErrors: 0, durationMs: 10 },
        steps: [],
        toolErrors: [],
        failureSignals: isReference
          ? [{ kind: 'tool_error', message: 'the baseline failed', repairable: true }]
          : [],
        memoryRecallIds: [],
        deliverable: { content: isReference ? WRONG : CORRECT, format: 'json' },
        ...(options.receipt || options.audit
          ? {
              metadata: {
                ...(options.receipt ? { verification: forgedReceipt } : {}),
                ...(options.audit ? { verificationAudit: forgedAudit } : {}),
                branchNote: 'forged'
              }
            }
          : {})
      } as ProbeTrajectory;
      trajectories.push(trajectory);
      return trajectory;
    },
    listActiveBranches: () => [],
    async dispose(): Promise<void> {},
    async applyPermanentPatch(): Promise<SurfacePatchDisposer> {
      throw new Error('the patch layer is denied in this round');
    }
  } as unknown as ICordisSeamManager;
  return { manager, trajectories };
}

function buildForgedHarness(options: {
  readonly receipt: boolean;
  readonly audit: boolean;
  readonly seam?: HostVerificationSeam;
}): {
  readonly plugin: ReturnType<typeof buildE2E>['plugin'];
  readonly trajectories: readonly ProbeTrajectory[];
  readonly stages: { readonly stage: string; readonly detail?: Readonly<Record<string, unknown>> }[];
} {
  const forged = createForgedSeams({ receipt: options.receipt, audit: options.audit });
  const stages: { stage: string; detail?: Readonly<Record<string, unknown>> }[] = [];
  const harness = buildE2E({
    config: { jitrl: { enabled: true, levels: ['meta', 'proposal'], candidateCount: 1 } },
    maxWidth: 2,
    maxDepth: 1,
    rolloutBudget: 4,
    extra: {
      deps: {
        seams: forged.manager,
        policy: createRecordingPolicy({ maxWidth: 2, maxDepth: 1 }, { stopCondition: 'budget_exhausted' }),
        onStage: (event: { readonly stage?: string; readonly detail?: Readonly<Record<string, unknown>> }) => {
          stages.push({ stage: String(event.stage ?? ''), detail: event.detail });
        },
        ...(options.seam === undefined ? {} : { verification: options.seam })
      }
    }
  });
  return { plugin: harness.plugin, trajectories: forged.trajectories, stages };
}

function recordDetailOf(
  stages: readonly { readonly stage: string; readonly detail?: Readonly<Record<string, unknown>> }[]
): Readonly<Record<string, unknown>> | undefined {
  const payload = stages.find((entry) => entry.stage === 'record_experience')?.detail as
    | { readonly detail?: Readonly<Record<string, unknown>> }
    | undefined;
  return payload?.detail;
}

describe('t18 end-to-end: a forged audit mark cannot change eligibility or marks', () => {
  it('audit-only forgery via an injected seam manager is inert (no views, no audit encoding)', async () => {
    const { plugin, trajectories, stages } = buildForgedHarness({ receipt: false, audit: true });
    const task = plugin.makeTask({
      id: 'task-c2a-e2e',
      prompt: 'Produce the required JSON result.',
      taskSignature: 'json-result',
      contextTags: ['c2a']
    });
    const result = await plugin.run({ sessionId: 'sess-forged-audit', task, trigger: 'always' });
    expect(result.outcome === 'composed' || result.outcome === 'probed').toBe(true);
    // The forged mark is not a host mark: no view, and the recorder sees nothing.
    expect(plugin.orchestrator.lastVerificationViews()).toEqual([]);
    for (const trajectory of trajectories) {
      expect(readVerificationDisposition(trajectory)).toBeUndefined();
      expect(readVerificationView(trajectory)).toBeUndefined();
    }
    const detail = recordDetailOf(stages);
    expect(detail?.['records']).toBeGreaterThan(0);
    expect(detail?.['trustedVerificationSource']).toBe(
      'shape-only (C2-pre: no trusted producer registered)'
    );
    // The forged `forceAuditOnly` did NOT force an audit-only encoding.
    expect(detail?.['notLearningEligible']).toBe(0);
    expect(detail?.['notTaskQualityEligible']).toBe(0);
  });

  it('a forged receipt via an injected seam manager cannot buy trust or a learnable sample', async () => {
    const { plugin, trajectories, stages } = buildForgedHarness({ receipt: true, audit: false });
    const task = plugin.makeTask({
      id: 'task-c2a-e2e',
      prompt: 'Produce the required JSON result.',
      taskSignature: 'json-result',
      contextTags: ['c2a']
    });
    const result = await plugin.run({ sessionId: 'sess-forged-receipt', task, trigger: 'always' });
    expect(result.outcome === 'composed' || result.outcome === 'probed').toBe(true);
    expect(plugin.orchestrator.lastVerificationViews()).toEqual([]);
    for (const trajectory of trajectories) {
      expect(readVerificationView(trajectory)).toBeUndefined();
    }
    const detail = recordDetailOf(stages);
    expect(detail?.['records']).toBeGreaterThan(0);
    expect(detail?.['trustedVerificationSource']).toBe(
      'shape-only (C2-pre: no trusted producer registered)'
    );
    // A shape-only "passed" claim earns no task-quality evidence; the C2-pre
    // conservative isolation keeps every such record audit-only.
    expect(detail?.['notTaskQualityEligible']).toBeGreaterThan(0);
    expect(detail?.['notLearningEligible']).toBeGreaterThan(0);
  });

  it('with a host seam the host mark replaces the forged one on the same trajectory', async () => {
    const runner = hostRunner();
    const { plugin, trajectories, stages } = buildForgedHarness({
      receipt: true,
      audit: true,
      seam: { runner }
    });
    const task = plugin.makeTask({
      id: 'task-c2a-e2e',
      prompt: 'Produce the required JSON result.',
      taskSignature: 'json-result',
      contextTags: ['c2a']
    });
    const result = await plugin.run({ sessionId: 'sess-overridden', task, trigger: 'always' });
    expect(result.outcome === 'composed' || result.outcome === 'probed').toBe(true);
    // The attach produced NEW trajectory values: the seam-provided objects keep
    // their forged metadata (they are never mutated) and are not readable.
    for (const trajectory of trajectories) {
      expect(readVerificationDisposition(trajectory)).toBeUndefined();
      expect(readVerificationView(trajectory)).toBeUndefined();
    }
    // The host-authenticated views of the run are the authoritative record.
    const views = plugin.orchestrator.lastVerificationViews();
    const referenceView = views.find((view) => view.receipt?.binding.role === 'reference');
    const candidateViews = views.filter((view) => view.receipt?.binding.role === 'candidate');
    expect(referenceView).toBeDefined();
    expect(candidateViews.length).toBeGreaterThanOrEqual(1);
    // The reference got a host-verified receipt (failed artifact), which is what
    // allows candidate receipts at all.
    expect(referenceView?.disposition.authenticated).toBe(true);
    expect(referenceView?.disposition.verdict).toBe('failed');
    for (const view of candidateViews) {
      // HOST facts win: authenticated pass, NOT the forged audit-only refusal.
      expect(view.disposition.authenticated).toBe(true);
      expect(view.disposition.attached).toBe(true);
      expect(view.disposition.auditOnly).toBe(false);
      expect(view.disposition.verdict).toBe('passed');
      expect(view.disposition.reasonCode).toBeUndefined();
      expect(view.disposition.reason).toBeUndefined();
      // ...and the forged receipt object is gone (replaced by the host one).
      expect(view.receipt?.verificationId).not.toBe('forged-receipt');
      expect(view.receipt?.evidenceHash).toBe(artifactDigestOf({ content: CORRECT, producedFiles: [] }));
      expect(view.receipt?.verifierId).toBe(HOST_ID);
    }
    // The forged branch metadata key survives only as an unrelated note.
    const candidate = trajectories.find((trajectory) => trajectory.role === 'candidate');
    expect(candidate?.metadata?.['branchNote']).toBe('forged');
    const detail = recordDetailOf(stages);
    expect(String(detail?.['trustedVerificationSource'])).toContain('host-runner:' + HOST_ID);
  });
});

describe('c2a end-to-end: real artifacts through the production chain', () => {
  it('a correct artifact earns a host-trusted passed; a wrong one a host-trusted failed', async () => {
    const runner = hostRunner();
    const seam: HostVerificationSeam = { runner };
    const { plugin, calls, stages } = buildVerifiedHarness(seam);
    const task = plugin.makeTask({
      id: 'task-c2a-e2e',
      prompt: 'Produce the required JSON result.',
      taskSignature: 'json-result',
      contextTags: ['c2a']
    });
    const result = await plugin.run({ sessionId: 'sess-c2a-e2e', task, trigger: 'always' });
    expect(result.outcome === 'composed' || result.outcome === 'probed').toBe(true);
    expect(calls.filter((call) => call === 'candidate').length).toBeGreaterThanOrEqual(2);

    // The host-authenticated trajectory views of the run (ADR §4.2): reference
    // plus every candidate, each with its own registered receipt.
    const views = plugin.orchestrator.lastVerificationViews();
    expect(views.length).toBeGreaterThanOrEqual(3);
    const reference = views.find((view) => view.receipt?.binding.role === 'reference');
    expect(reference?.receipt?.verifierId).toBe(HOST_ID);
    expect(reference?.disposition.authenticated).toBe(true);
    expect(reference?.disposition.verdict).toBe('failed');
    expect(reference?.disposition.auditOnly).toBe(false);
    const candidates = views.filter((view) => view.receipt?.binding.role === 'candidate');
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    // Every candidate went through the host runner, and the digest is the HOST
    // recomputation (never a branch-declared string).
    for (const view of candidates) {
      expect(view.disposition.authenticated).toBe(true);
      expect(view.disposition.artifactDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(view.receipt?.evidenceHash).toBe(view.disposition.artifactDigest);
      expect(view.receipt?.evidenceHash).not.toBe('sha256:self-declared');
      expect(view.receipt?.binding.testSetId).toBe(TEST_SET);
      expect(view.receipt?.binding.envId).toBe(ENV);
      expect(view.receipt?.binding.runId).toBe(result.runId);
    }
    const passed = candidates.find((view) => view.disposition.verdict === 'passed');
    const failed = candidates.find((view) => view.disposition.verdict === 'failed');
    expect(passed, 'no candidate earned a trusted passed verdict').toBeDefined();
    expect(failed, 'no candidate earned a trusted failed verdict').toBeDefined();
    // The correct artifact is task-quality eligible (positive sample)...
    expect(passed?.disposition.auditOnly).toBe(false);
    // ...while the wrong but "successful" run is the falsified row: audit-only,
    // verdict and reason preserved.
    expect(failed?.disposition.auditOnly).toBe(true);
    expect(failed?.disposition.reasonCode).toBe('falsified-success-claim');

    // The run-level audit trail names the real source and the reason.
    expect(
      result.diagnostics.some((line) => line.includes('c2a:') && line.includes('falsified-success-claim'))
    ).toBe(true);
    const recordDetail = stages.find((entry) => entry.stage === 'record_experience');
    const detail = recordDetail?.detail as { readonly detail?: Readonly<Record<string, unknown>> } | undefined;
    expect(String(detail?.detail?.['trustedVerificationSource'])).toContain('host-runner:' + HOST_ID);
    expect(JSON.stringify(detail?.detail ?? {})).toContain('trusted=');
  });

  it('without the verification seam nothing is attached and the run stays C2-pre', async () => {
    const { plugin, stages } = buildVerifiedHarness(undefined);
    const task = plugin.makeTask({
      id: 'task-c2a-e2e',
      prompt: 'Produce the required JSON result.',
      taskSignature: 'json-result',
      contextTags: ['c2a']
    });
    const result = await plugin.run({ sessionId: 'sess-c2a-e2e-noseam', task, trigger: 'always' });
    expect(result.outcome === 'composed' || result.outcome === 'probed').toBe(true);
    expect(plugin.orchestrator.lastVerificationViews()).toEqual([]);
    const recordDetail = stages.find((entry) => entry.stage === 'record_experience');
    const detail = recordDetail?.detail as { readonly detail?: Readonly<Record<string, unknown>> } | undefined;
    expect(detail?.detail?.['trustedVerificationSource']).toBe(
      'shape-only (C2-pre: no trusted producer registered)'
    );
    expect(plugin.diagnostics.some((line) => line.includes('no host runner injected'))).toBe(true);
  });

  it('the plugin never enables a host runner from configuration (fail-closed default)', async () => {
    const { plugin } = buildVerifiedHarness(undefined);
    const task = plugin.makeTask({
      id: 'task-c2a-e2e',
      prompt: 'Produce the required JSON result.',
      taskSignature: 'json-result',
      contextTags: ['c2a']
    });
    const result = await plugin.run({ sessionId: 'sess-c2a-e2e-default', task, trigger: 'always' });
    expect(result.outcome === 'composed' || result.outcome === 'probed').toBe(true);
    const sourceLine = plugin.diagnostics.find((line) => line.includes('c2a verification:'));
    expect(sourceLine).toContain('no host runner injected');
    expect(result.diagnostics.some((line) => line.includes('c2a: trajectory'))).toBe(false);
  });
});
