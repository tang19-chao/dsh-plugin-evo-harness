/**
 * A4-5 (rev6 audit): the production TRUSTED-VERIFICATION seam.
 *
 * WHAT THIS TEST PINS
 * -------------------
 *  - The host-owned runner is injected through the documented `deps.verification`
 *    seam (no config field fabricates one).
 *  - A PASS artifact and a FAIL artifact both reach `verification.status`
 *    `passed`/`failed` in the run's verification views and persist as trusted
 *    reward marks (`verificationTrusted=1`), with a real reward difference.
 *  - A self-declared `metadata.verification` payload is NEVER promoted:
 *    with the host seam it is replaced by the host receipt (a claimed pass on a
 *    failing artifact becomes `failed`); without any seam it stays
 *    `trustedSource=false`, is not task-quality evidence and makes the probe
 *    not-evaluable.
 *  - An enabled runner whose `trustedProducers` set is EMPTY gets the
 *    `conservative-degraded` diagnostic, not the "registry-authenticated"
 *    message.
 *
 * WHAT THIS TEST DOES NOT DO (A4-5 scope)
 * ---------------------------------------
 * There is no worktree / read-only-tool verification runner in this repository
 * and the host has no injection point for one. The runner below is the
 * host-owned deterministic check runner the seam already accepts; this test
 * verifies the SEAM, not a runner implementation that would have to be invented.
 */
import { describe, expect, it } from 'vitest';

import { createHostOwnedVerificationRunner, verifyAndAttach } from '../../src/verification';
import { classifyProbeEvaluability } from '../../src/jitrl/text-probe-evaluation';
import { scoreTrajectorySignals } from '../../src/jitrl/step-evaluator';
import type {
  AbstractState,
  ExperienceRecord,
  IsolatedBranchContext,
  JitCandidate,
  JitDecision,
  JitLevel,
  ProbeExecutionResult,
  ProbeTrajectory
} from '../../src/types/contracts';
import { createMemoryExperienceStore } from '../../src/jitrl/stores/memory.store';
import { parseEvoHarnessConfig } from '../../src/config';
import { buildE2E, e2eConfig, makeClock } from './fixtures';
import type { OrchestratorJitRl } from '../../src/orchestrator';

const PASS_ARTIFACT = 'artifact: host check PASS';
const FAIL_ARTIFACT = 'artifact: host check FAIL';
const REFERENCE_ARTIFACT = 'reference artifact: host check FAIL';

/** Reference FAILS; the first candidate PASSES; the second candidate FAILS. */
function createArtifactRunner(now: () => number): {
  (context: IsolatedBranchContext): Promise<ProbeExecutionResult>;
  readonly calls: string[];
} {
  const calls: string[] = [];
  let candidateIndex = 0;
  const run = async (context: IsolatedBranchContext): Promise<ProbeExecutionResult> => {
    const isReference =
      context.patch.purpose === 'initial' && Object.keys(context.patch.edits).length === 0;
    if (isReference) {
      calls.push('reference');
      return {
        status: 'failed',
        steps: [
          { index: 0, at: now(), kind: 'model', text: 'reference attempt' },
          { index: 1, at: now(), kind: 'error', text: 'the reference build failed' }
        ],
        toolErrors: [],
        failureSignals: [{ kind: 'tool_error', message: 'reference failed', repairable: true }],
        deliverable: { content: REFERENCE_ARTIFACT, format: 'text' }
      };
    }
    const index = candidateIndex;
    candidateIndex += 1;
    calls.push(index === 0 ? 'candidate-pass' : 'candidate-fail');
    const passed = index === 0;
    return {
      status: 'succeeded',
      steps: [
        { index: 0, at: now(), kind: 'message', text: passed ? 'compliant attempt' : 'non-compliant attempt' },
        { index: 1, at: now(), kind: 'result', text: passed ? 'checks pass' : 'checks fail' }
      ],
      toolErrors: [],
      failureSignals: [],
      deliverable: { content: passed ? PASS_ARTIFACT : FAIL_ARTIFACT, format: 'text' }
    };
  };
  return Object.assign(run, { calls });
}

function runnerFor(taskId: string, verifierId = 'verification-seam-host') {
  return createHostOwnedVerificationRunner({
    verifierId,
    verifierVersion: 'v1',
    testSetId: 'verification-seam-tests-v1',
    envId: 'verification-seam-env-v1',
    cases: [
      {
        taskId,
        checks: [
          {
            id: 'artifact-contains-PASS',
            run: (artifact) => artifact.content.includes('PASS')
          }
        ]
      }
    ]
  });
}

/** Deterministic optimizer/evaluator stubs: this test is about verification, not L2. */
function createSignalJit(
  store: ReturnType<typeof createMemoryExperienceStore>,
  config: ReturnType<typeof parseEvoHarnessConfig>
): OrchestratorJitRl {
  return {
    store,
    optimizer: {
      async decide<T>(
        level: JitLevel,
        _state: AbstractState,
        candidates: readonly JitCandidate<T>[]
      ): Promise<JitDecision<T>> {
        const probability = 1 / Math.max(1, candidates.length);
        const adjustments = candidates.map((candidate) => ({
          candidate,
          q: null,
          advantage: 0,
          normalizedAdvantage: 0,
          adjustedLogit: candidate.baseLogit,
          probability,
          support: 0,
          explored: false
        }));
        return {
          level,
          stateValue: 0,
          neighborCount: 0,
          adjustments,
          chosen: adjustments[0] as (typeof adjustments)[number],
          klToPrior: 0,
          rationale: 'verification-seam stub'
        };
      }
    },
    stepEvaluator: {
      async evaluate(): Promise<readonly never[]> {
        return [];
      }
    },
    config: {
      enabled: true,
      levels: ['meta', 'proposal'],
      gamma: config.jitrl.gamma,
      candidateCount: 1,
      k: config.jitrl.k,
      similarityThreshold: config.jitrl.similarityThreshold,
      augmentFromMemory: false,
      minSupportForStrongPrior: config.jitrl.minSupportForStrongPrior
    }
  };
}

function onlineRecords(store: ReturnType<typeof createMemoryExperienceStore>): readonly ExperienceRecord[] {
  return store.snapshot().filter((record) => record.id.startsWith('online-') && record.level === 'meta');
}

function selfDeclaredTrajectory(content: string): ProbeTrajectory {
  return {
    id: 'traj-self-declared',
    sessionId: 'sess-self-declared',
    branchId: 'branch-self-declared',
    branchNamespace: 'harness2:probe_branch-self-declared',
    role: 'candidate',
    status: 'succeeded',
    patchId: 'patch-self-declared',
    patchOrigin: 'domain',
    surfaceKeys: ['guardrails'],
    startedAt: 0,
    endedAt: 1,
    metrics: { steps: 1, toolCalls: 0, toolErrors: 0, durationMs: 1 },
    steps: [{ index: 0, at: 0, kind: 'message', text: 'self-declared completion' }],
    toolErrors: [],
    failureSignals: [],
    memoryRecallIds: [],
    deliverable: { content, format: 'text' },
    metadata: {
      verification: {
        status: 'passed',
        verifierId: 'verification-seam-host',
        verifierVersion: 'v1',
        evidenceHash: 'sha256:' + '0'.repeat(64),
        checks: [{ id: 'self-declared', passed: true }]
      }
    }
  };
}

describe('A4-5: host verification seam reaches status, marks and reward', () => {
  it('PASS/FAIL artifacts produce passed/failed views, trusted marks and a reward difference', async () => {
    const now = makeClock();
    const store = createMemoryExperienceStore({ now, halfLifeMs: 1_000_000_000 });
    const config = parseEvoHarnessConfig(
      e2eConfig({
        dreamEveryNTasks: 100,
        config: { jitrl: { enabled: true, levels: ['meta', 'proposal'], candidateCount: 1 } }
      })
    );
    const artifactRunner = createArtifactRunner(now);
    const harness = buildE2E({
      dreamEveryNTasks: 100,
      config: { jitrl: { enabled: true, levels: ['meta', 'proposal'], candidateCount: 1 } },
      maxWidth: 2,
      maxDepth: 1,
      rolloutBudget: 4,
      extra: {
        runBranch: artifactRunner,
        deps: {
          jitrl: createSignalJit(store, config),
          verification: { runner: runnerFor('task-verification-seam') }
        }
      }
    });

    const result = await harness.plugin.run({
      sessionId: 'sess-verification-seam',
      task: harness.plugin.makeTask({ id: 'task-verification-seam', prompt: 'Fix the build.' }),
      trigger: 'always'
    });

    expect(result.outcome).toBe('composed');
    expect(result.probesRun).toBeGreaterThanOrEqual(3);
    // The runner saw the reference plus both candidates.
    expect(artifactRunner.calls).toContain('reference');
    expect(artifactRunner.calls).toContain('candidate-pass');
    expect(artifactRunner.calls).toContain('candidate-fail');

    const views = harness.plugin.orchestrator.lastVerificationViews();
    expect(views.length).toBeGreaterThanOrEqual(3);
    for (const view of views) {
      expect(view.disposition.attached).toBe(true);
      expect(view.disposition.authenticated).toBe(true);
      expect(['passed', 'failed']).toContain(view.disposition.verdict ?? '');
    }
    const passedView = views.find((view) => view.disposition.verdict === 'passed');
    const failedView = views.find((view) => view.disposition.verdict === 'failed');
    expect(passedView).toBeDefined();
    expect(failedView).toBeDefined();
    // The verdict is bound to the host-recomputed artifact digest, never a
    // self-declared claim.
    expect(passedView?.disposition.artifactDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(passedView?.receipt?.evidenceHash).toBe(passedView?.disposition.artifactDigest);

    const records = onlineRecords(store);
    const passed = records.find((record) => record.rewardSources.verificationVerdict === 1);
    const failed = records.find((record) => record.rewardSources.verificationVerdict === 2);
    expect(passed, 'no trusted-pass record').toBeDefined();
    expect(failed, 'no trusted-fail record').toBeDefined();
    expect(passed?.rewardSources.verificationTrusted).toBe(1);
    expect(failed?.rewardSources.verificationTrusted).toBe(1);
    expect(passed?.reward ?? 0).toBeGreaterThan(failed?.reward ?? 0);
    expect(passed?.rewardSources.notEvaluable).toBeUndefined();
    expect(failed?.rewardSources.notEvaluable).toBeUndefined();
    await harness.plugin.dispose();
  });

  it('an enabled runner with an EMPTY producer set is reported conservative-degraded', () => {
    const hostRunner = runnerFor('task-verification-degraded');
    const degraded = {
      ...hostRunner,
      trustedProducers: new Set<string>()
    };
    const harness = buildE2E({
      dreamEveryNTasks: 100,
      config: { jitrl: { enabled: false } },
      extra: {
        deps: {
          verification: { runner: degraded }
        }
      }
    });
    const diagnostics = harness.plugin.diagnostics.join('\n');
    expect(diagnostics).toContain('c2a verification: host-owned runner verification-seam-host@v1 active but conservative-degraded');
    expect(diagnostics).toContain('trustedProducers is EMPTY');
    expect(diagnostics).not.toContain('verdicts are registry-authenticated, not shape-only');
  });

  it('an empty producer set is audit-only in the RUN SUMMARY and persisted marks, not trusted', async () => {
    const now = makeClock();
    const store = createMemoryExperienceStore({ now, halfLifeMs: 1_000_000_000 });
    const config = parseEvoHarnessConfig(
      e2eConfig({
        dreamEveryNTasks: 100,
        config: { jitrl: { enabled: true, levels: ['meta', 'proposal'], candidateCount: 1 } }
      })
    );
    const hostRunner = runnerFor('task-verification-empty-producers');
    const degraded = { ...hostRunner, trustedProducers: new Set<string>() };
    const artifactRunner = createArtifactRunner(now);
    const stages: { readonly stage: string; readonly detail?: Readonly<Record<string, unknown>> }[] = [];
    const harness = buildE2E({
      dreamEveryNTasks: 100,
      config: { jitrl: { enabled: true, levels: ['meta', 'proposal'], candidateCount: 1 } },
      maxWidth: 2,
      maxDepth: 1,
      rolloutBudget: 4,
      extra: {
        runBranch: artifactRunner,
        deps: {
          jitrl: createSignalJit(store, config),
          verification: { runner: degraded },
          onStage: (event) => {
            stages.push({
              stage: event.stage,
              ...(event.detail === undefined ? {} : { detail: event.detail })
            });
          }
        }
      }
    });

    const result = await harness.plugin.run({
      sessionId: 'sess-verification-empty-producers',
      task: harness.plugin.makeTask({ id: 'task-verification-empty-producers', prompt: 'Fix the build.' }),
      trigger: 'always'
    });
    expect(result.outcome).toBe('composed');

    // The host authenticated the receipts, but the CONSUMER producer set is
    // empty: the run summary must say trusted=0 / audit-only=N. The old summary
    // counted host authentication as consumer trust and reported trusted=N.
    const lifecycle = stages;
    const entry = lifecycle.find((item) => item.stage === 'record_experience');
    const outer = entry?.detail as { readonly detail?: Readonly<Record<string, unknown>> } | undefined;
    const nested = outer?.detail as { readonly trustedVerificationSource?: string } | undefined;
    const source = String(nested?.trustedVerificationSource ?? '');
    expect(source).toContain('host-runner:verification-seam-host@v1');
    expect(source).toContain('trusted=0');
    expect(source).toMatch(/audit-only=[1-9]/);

    const records = onlineRecords(store);
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.rewardSources.verificationTrusted ?? 0).toBe(0);
      expect(record.rewardSources.verificationAuditOnly).toBe(1);
    }
    await harness.plugin.dispose();
  });
});

describe('A4-5: a self-declared payload is never promoted to trusted/passed', () => {
  it('with the host seam the host receipt replaces the self-declared pass (failing artifact => failed)', async () => {
    const runner = runnerFor('task-self-declared');
    const result = await verifyAndAttach({
      seam: { runner },
      trajectory: selfDeclaredTrajectory('self-declared claim that fails the host check'),
      runId: 'run-self-declared',
      taskId: 'task-self-declared',
      diagnostics: []
    });

    expect(result.disposition).toBeDefined();
    expect(result.disposition?.attached).toBe(true);
    expect(result.disposition?.authenticated).toBe(true);
    expect(result.disposition?.verdict).toBe('failed');
    expect(result.trajectory.metadata?.['verification']).toMatchObject({
      status: 'failed',
      verifierId: 'verification-seam-host',
      kind: 'host-runner'
    });
    const persisted = result.trajectory.metadata?.['verification'] as { evidenceHash?: string } | undefined;
    expect(persisted?.evidenceHash).not.toBe('sha256:' + '0'.repeat(64));
    // The scorer sees the host verdict, not the claim.
    const score = scoreTrajectorySignals(result.trajectory, {
      trustedProducers: runner.trustedProducers
    });
    expect(score.verification.status).toBe('failed');
    expect(score.verification.trustedSource).toBe(true);
    // Succeeded execution + trusted failed verdict is a falsified claim: the
    // reward is not consumed as a positive task-quality sample.
    expect(score.taskQualityEvidence).toBe(false);
    expect(score.taskQualityLearningEligible).toBe(false);
  });

  it('without any seam the claim stays shape-only: not trusted, not task-quality, not evaluable', async () => {
    const trajectory = selfDeclaredTrajectory('claims passed with no host runner');
    const result = await verifyAndAttach({
      seam: undefined,
      trajectory,
      runId: 'run-no-seam',
      taskId: 'task-no-seam',
      diagnostics: []
    });
    // The default path returns the trajectory untouched (byte-identical), but
    // the claim still proves nothing.
    expect(result.trajectory).toBe(trajectory);
    const score = scoreTrajectorySignals(trajectory);
    expect(score.verification.status).toBe('passed');
    expect(score.verification.trustedSource).toBe(false);
    expect(score.taskQualityEvidence).toBe(false);
    expect(score.taskQualityLearningEligible).toBe(false);
    const evaluability = classifyProbeEvaluability({
      trajectory,
      verification: {
        status: score.verification.status,
        trustedSource: score.verification.trustedSource,
        implicit: score.verification.implicit
      }
    });
    expect(evaluability.evaluable).toBe(false);
    expect(evaluability.reason).toBe('text-only-deliverables');
  });
});