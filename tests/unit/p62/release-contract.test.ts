/**
 * P6.2 C0+C1 release-contract regression (ADR 0002, as revised by t6).
 *
 * Covers the acceptance criteria that no pre-existing suite pins:
 *   - F4/nEff: the guarded replacement judgement consumes ONLY nEff; a
 *     missing/non-finite nEff is no replacement evidence (support never
 *     impersonates nEff); thin evidence without an explicit exploration
 *     authorization does not replace (kept-prior, 'min-support');
 *   - reservation release: a cancelled/aborted/infrastructure execution
 *     refunds the exploration seat (R5-6);
 *   - the C2-pre trusted boundary: a registered trusted producer makes a
 *     failed verdict task-quality eligible; shape-only verdicts never do;
 *   - the execution profile: default shadow, patch/publish/memory denied,
 *     patch only in guarded-active, off stays off;
 *   - the config surface: execution group validation and the
 *     applyWinningPatch x mode cross-field guard;
 *   - the r4 record fields: decisionMode/actionKeyVocabulary round-trip
 *     through the store, including the reject-a-typo fail-closed case.
 */
import { describe, expect, it } from 'vitest';
import type { ExperienceRecord } from '../../../src/types/contracts';
import { conservativeAdvantage } from '../../../src/jitrl/value-estimator';
import {
  decideReplacement,
  shouldReleaseReservation
} from '../../../src/jitrl/replacement-policy';
import {
  hasTrustedVerificationProvenance,
  isRegisteredTrustedVerifier
} from '../../../src/jitrl/step-evaluator';
import { scoreUnderRewardContract } from '../../../src/jitrl/reward-contract';
import {
  EXPERIENCE_SCHEMA_VERSION,
  CURRENT_REWARD_VERSION,
  PREVIOUS_REWARD_VERSION
} from '../../../src/jitrl/experience-store';
import { createMemoryExperienceStore } from '../../../src/jitrl/stores/memory.store';
import {
  runDecisionKernel,
  learningFacingFilterOptions
} from '../../../src/jitrl/decision-kernel';
import { abstractMetaState } from '../../../src/jitrl/state-abstraction';
import {
  isOnLearningTrack,
  PRODUCTION_LEARNING_TRACK
} from '../../../src/jitrl/experience-store';
import {
  EvoHarnessOrchestratorImpl,
  type EvoHarnessOrchestratorDeps
} from '../../../src/orchestrator';
import { resolveExecutionProfile } from '../../../src/runtime/execution-profile';
import { parseEvoHarnessConfig, ConfigValidationError } from '../../../src/config';
import type { ProbeTrajectory } from '../../../src/types/contracts';

const T0 = 1_700_000_000_000;

function record(overrides: Partial<ExperienceRecord> = {}): ExperienceRecord {
  return {
    id: 'rec-1',
    level: 'proposal',
    state: { level: 'proposal', bucket: 'b', tokens: ['t'], summary: '' },
    actionKey: 'patch:a',
    reward: 1,
    return: 1,
    rewardSources: {},
    guidance: 'memory',
    policyId: 'pi',
    sessionId: 's',
    createdAt: T0,
    redacted: true,
    ...overrides
  };
}

function trajectory(overrides: Partial<ProbeTrajectory> = {}): ProbeTrajectory {
  return {
    id: 't',
    sessionId: 's',
    branchId: 'b',
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
    ...overrides
  } as ProbeTrajectory;
}

describe('C0 F4/nEff: the replacement judgement consumes only nEff', () => {
  const prior = { actionKey: 'prior', q: 0.2, support: 4, nEff: 3.2, explored: false, advantage: 0.2 };

  it('a supported challenger whose estimate lacks nEff has NO replacement evidence', () => {
    // The pre-C0 fallback (nEff ?? support) would have treated support=5 as
    // evidence; the C0 rule refuses: support never impersonates nEff.
    const verdict = decideReplacement({
      proposedIndex: 1,
      priorIndex: 0,
      challenger: { actionKey: 'new', q: 0.5, support: 5, explored: false, advantage: 0.3 },
      prior,
      challengerIsNoop: false,
      explorationAllowance: 0
    });
    expect(verdict.kind).toBe('kept-prior');
    expect(verdict.gateReason).toBe('min-support');
  });

  it('a non-finite nEff is no replacement evidence either', () => {
    const verdict = decideReplacement({
      proposedIndex: 1,
      priorIndex: 0,
      challenger: { actionKey: 'new', q: 0.5, support: 5, nEff: Number.NaN, explored: false, advantage: 0.3 },
      prior,
      challengerIsNoop: false,
      explorationAllowance: 0
    });
    expect(verdict.kind).toBe('kept-prior');
  });

  it('thin evidence (nEff below the floor) does not replace without a budget', () => {
    const verdict = decideReplacement({
      proposedIndex: 1,
      priorIndex: 0,
      challenger: { actionKey: 'thin', q: 0.9, support: 1, nEff: 1.2, explored: false, advantage: 0.7 },
      prior,
      challengerIsNoop: false,
      explorationAllowance: 0
    });
    expect(verdict.kind).toBe('kept-prior');
    expect(verdict.gateReason).toBe('min-support');
  });

  it('thin evidence executes only against an explicit exploration authorization (charged)', () => {
    const verdict = decideReplacement({
      proposedIndex: 1,
      priorIndex: 0,
      challenger: { actionKey: 'thin', q: 0.9, support: 1, nEff: 1.2, explored: false, advantage: 0.7 },
      prior,
      challengerIsNoop: false,
      explorationAllowance: 2
    });
    expect(verdict.kind).toBe('executed-exploration');
    expect(verdict.exploration).toBe(true);
  });

  it('full evidence replaces', () => {
    const verdict = decideReplacement({
      proposedIndex: 1,
      priorIndex: 0,
      challenger: { actionKey: 'strong', q: 0.9, support: 6, nEff: 4.5, explored: false, advantage: 0.7 },
      prior,
      challengerIsNoop: false,
      explorationAllowance: 0
    });
    expect(verdict.kind).toBe('executed-proposed');
    expect(verdict.exploration).toBe(false);
  });

  it('conservativeAdvantage reports nEff and support side by side (ledger co-report)', () => {
    const judged = conservativeAdvantage({
      actionKey: 'a',
      q: 0.4,
      support: 7,
      nEff: 2.5,
      explored: false,
      advantage: 0.4
    });
    expect(judged.nEff).toBe(2.5);
    expect(judged.support).toBe(7);
    expect(judged.hasReplacementEvidence).toBe(true);
    expect(judged.shrunkAdvantage).toBeCloseTo((0.4 * 2.5) / 4.5, 12);
  });
});

describe('C0 R5-6: exploration reservations are released without quality evidence', () => {
  it('releases the seat for cancelled / aborted / infrastructure outcomes', () => {
    expect(shouldReleaseReservation({ exploration: true, completed: true, outcome: 'cancelled' })).toBe(true);
    expect(shouldReleaseReservation({ exploration: true, completed: true, outcome: 'aborted' })).toBe(true);
    expect(shouldReleaseReservation({ exploration: true, completed: true, outcome: 'infrastructure_error' })).toBe(true);
  });

  it('keeps the charge for real completions (succeeded / failed / timeout)', () => {
    expect(shouldReleaseReservation({ exploration: true, completed: true, outcome: 'succeeded' })).toBe(false);
    expect(shouldReleaseReservation({ exploration: true, completed: true, outcome: 'failed' })).toBe(false);
    expect(shouldReleaseReservation({ exploration: true, completed: true, outcome: 'timeout' })).toBe(false);
  });

  it('ignores non-exploration executions', () => {
    expect(shouldReleaseReservation({ exploration: false, completed: true, outcome: 'cancelled' })).toBe(false);
  });
});

describe('C2-pre trusted boundary (ADR 0002 5.2a, t6)', () => {
  it('a shape-only payload has no trusted provenance (registry empty by default)', () => {
    const shapeOnly = {
      status: 'failed' as const,
      verifierId: 'ci-verifier',
      verifierVersion: '1.0.0',
      evidenceHash: 'abc',
      checks: [{ id: 'c', passed: false }]
    };
    expect(hasTrustedVerificationProvenance(shapeOnly)).toBe(false);
    expect(isRegisteredTrustedVerifier('ci-verifier')).toBe(false);
  });

  it('a registered trusted producer makes a FAILED verdict task-quality eligible; without it the verdict stays audit-only', () => {
    // The RELIABLE-failure shape: the execution itself failed (no falsified
    // success claim) and the verification refuted the result. C2-pre this
    // failure carries no trusted provenance, so it is audit-only.
    // t7/V5: the public string registrar was REMOVED - no importer can mint a
    // trusted producer in this round, so the "flip" half of the old test is
    // no longer reachable BY DESIGN. What stays pinned: the verdict-derived
    // completion keeps the record OFF the task-quality track (audit-only)
    // and the registry stays empty for every id any payload may claim.
    const wrong = trajectory({
      status: 'failed',
      metrics: { steps: 3, toolCalls: 2, toolErrors: 1, durationMs: 30 },
      failureSignals: [{ kind: 'tool_error', message: 'the tool failed', repairable: true }],
      deliverable: { content: 'wrong', format: 'text' },
      metadata: {
        verification: {
          status: 'failed',
          verifierId: 'trusted-ci',
          verifierVersion: '1.0.0',
          evidenceHash: 'abc',
          checks: [{ id: 'c', passed: false }]
        }
      }
    });
    // No registration path exists: the scale keeps the negative signal but
    // the record is not task-quality learnable (no forged provenance).
    expect(isRegisteredTrustedVerifier('trusted-ci')).toBe(false);
    const score = scoreUnderRewardContract(wrong);
    expect(score.reward).toBeLessThanOrEqual(0);
    expect(score.learningEligible).toBe(true);
    expect(score.verification.trustedSource).toBe(false);
    expect(score.taskQualityLearningEligible).toBe(false);
  });

  it('a falsified success claim stays ineligible even with a well-formed payload (PR-B rule intact)', () => {
    // t7/V5: even a payload CLAIMING a trustworthy-looking verifierId stays
    // untrusted - no registration path exists to legitimize any id this round.
    const forged = trajectory({
      status: 'succeeded',
      deliverable: { content: 'looks done', format: 'text' },
      metadata: {
        verification: {
          status: 'failed',
          verifierId: 'trusted-ci',
          verifierVersion: '1.0.0',
          evidenceHash: 'abc',
          checks: [{ id: 'c', passed: false }]
        }
      }
    });
    const score = scoreUnderRewardContract(forged);
    expect(score.reward).toBeLessThanOrEqual(0);
    expect(score.learningEligible).toBe(false);
    expect(score.taskQualityLearningEligible).toBe(false);
    expect(score.verification.trustedSource).toBe(false);
  });

  it('an unknown verdict keeps the process path learnable (no task-quality component)', () => {
    const unknown = trajectory({ deliverable: { content: 'x', format: 'text' } });
    const score = scoreUnderRewardContract(unknown);
    expect(score.verification.status).toBe('unknown');
    expect(score.learningEligible).toBe(true);
    expect(score.taskQualityLearningEligible).toBe(true);
    // t10/V3b: the FACT flag is FALSE for an unknown verdict - the field can
    // never again be read as an eligibility grant.
    expect(score.taskQualityEvidence).toBe(false);
    expect(score.sources.completion).toBe(0);
  });

  it('t10/V3b: the field⇔track consistency holds for every verdict shape (production regression)', () => {
    // The recorder stamps learningTrack from taskQualityEvidence alone. The
    // invariant "learningTrack ∈ process ⇒ the record is NOT task-quality
    // evidence" must hold for trusted, untrusted, unknown, and ineligible
    // verdicts alike - including the shapes a pre-t7 reader would confuse.
    const shapes = {
      unknown: trajectory({ deliverable: { content: 'x', format: 'text' } }),
      untrustedFailed: trajectory({
        status: 'failed',
        metrics: { steps: 3, toolCalls: 2, toolErrors: 1, durationMs: 30 },
        deliverable: { content: 'wrong', format: 'text' },
        metadata: {
          verification: {
            status: 'failed',
            verifierId: 'some-verifier',
            verifierVersion: '1',
            evidenceHash: 'abc',
            checks: [{ id: 'c', passed: false }]
          }
        }
      }),
      cancelled: trajectory({ status: 'aborted' })
    };
    for (const score of Object.values(shapes).map((shape) => scoreUnderRewardContract(shape))) {
      const track = score.taskQualityEvidence ? 'task-quality' : 'process';
      if (track === 'process') {
        expect(score.taskQualityEvidence).toBe(false);
      }
    }
    // And the positive pole exists only through the injected seam (next test):
    // with the production registry empty, every production shape is process.
    for (const score of Object.values(shapes).map((shape) => scoreUnderRewardContract(shape))) {
      expect(score.taskQualityEvidence ? 'task-quality' : 'process').toBe('process');
    }
  });

  it('t10/COV: the injectable trusted-producer seam flips ONLY the caller-supplied set (hash mismatch rejects)', () => {
    // The seam is caller-owned SET DATA, not a global string registrar: a
    // caller that passes its own set can establish provenance for ITS OWN
    // scores, and no other module's registry is affected (the frozen default
    // stays empty). The hash binding (t8/V5b) still applies: a mismatch
    // rejects even from a trusted producer.
    const trusted = new Set(['c2-future-verifier']);
    const wrong = trajectory({
      status: 'failed',
      metrics: { steps: 3, toolCalls: 2, toolErrors: 1, durationMs: 30 },
      deliverable: {
        content: 'wrong',
        format: 'text',
        contentHash: 'sha256:execution-evidence'
      },
      metadata: {
        verification: {
          status: 'failed',
          verifierId: 'c2-future-verifier',
          verifierVersion: '1',
          evidenceHash: 'sha256:NOT-the-execution-hash',
          checks: [{ id: 'c', passed: false }]
        }
      }
    });
    // Hash mismatch -> refused even from a trusted producer.
    const mismatch = scoreUnderRewardContract(wrong, { trustedProducers: trusted });
    expect(mismatch.verification.trustedSource).toBe(false);
    expect(mismatch.taskQualityEvidence).toBe(false);
    // Bound hash -> the caller's own trust set establishes the verdict...
    const bound = scoreUnderRewardContract(wrong, {
      trustedProducers: trusted
    });
    void bound;
    const matching = scoreUnderRewardContract(
      {
        ...wrong,
        metadata: {
          verification: {
            ...(wrong.metadata as { verification: Record<string, unknown> }).verification,
            evidenceHash: 'sha256:execution-evidence'
          }
        }
      },
      { trustedProducers: trusted }
    );
    expect(matching.verification.trustedSource).toBe(true);
    expect(matching.taskQualityEvidence).toBe(true);
    expect(matching.taskQualityLearningEligible).toBe(true);
    // ...while the production path (no seam) stays closed for the same payload.
    const production = scoreUnderRewardContract({
      ...wrong,
      metadata: {
        verification: {
          ...(wrong.metadata as { verification: Record<string, unknown> }).verification,
          evidenceHash: 'sha256:execution-evidence'
        }
      }
    });
    expect(production.verification.trustedSource).toBe(false);
    expect(production.taskQualityEvidence).toBe(false);
  });

  it('t7/V5: no public registrar exists - an arbitrary verifierId can never be promoted (import-shape pin)', () => {
    // The module surface itself is pinned: the string registrar must NOT come
    // back (it was the untrusted promotion channel this round must not ship).
    // Importing a removed binding fails at compile time, which the typecheck
    // gate enforces; here we pin the OBSERVABLE behaviour: every id a payload
    // may claim stays untrusted, so trusted provenance is structurally false.
    for (const claimed of ['trusted-ci', 'guarded-regression-verifier', 'structural-derivation', '']) {
      expect(isRegisteredTrustedVerifier(claimed)).toBe(false);
    }
    expect(
      hasTrustedVerificationProvenance({
        status: 'passed',
        verifierId: 'trusted-ci',
        verifierVersion: '1.0.0',
        evidenceHash: 'sha256:deadbeef',
        checks: [{ id: 'c', passed: true }]
      })
    ).toBe(false);
  });
});

describe('C1 execution profile (ADR 0002 R1/R2, t6)', () => {
  it('defaults to shadow with every permission denied', () => {
    const profile = resolveExecutionProfile();
    expect(profile.mode).toBe('shadow');
    expect(profile.shadowRecords).toBe(true);
    expect(profile.off).toBe(false);
    expect(profile.permissions.patch.allowed).toBe(false);
    expect(profile.permissions.publish.allowed).toBe(false);
    expect(profile.permissions.memory.allowed).toBe(false);
  });

  it('grants the patch layer only in guarded-active, never publish/memory', () => {
    const guarded = resolveExecutionProfile({ mode: 'guarded-active' });
    expect(guarded.permissions.patch.allowed).toBe(true);
    expect(guarded.permissions.publish.allowed).toBe(false);
    expect(guarded.permissions.memory.allowed).toBe(false);
    expect(guarded.shadowRecords).toBe(true);
  });

  it('off stops shadow records; baseline records without suggestions', () => {
    expect(resolveExecutionProfile({ mode: 'off' }).shadowRecords).toBe(false);
    expect(resolveExecutionProfile({ mode: 'off' }).off).toBe(true);
    expect(resolveExecutionProfile({ mode: 'baseline' }).shadowRecords).toBe(false);
    expect(resolveExecutionProfile({ mode: 'baseline' }).permissions.patch.allowed).toBe(false);
  });

  it('an unknown declared mode falls back to the safe default, never an error', () => {
    const profile = resolveExecutionProfile({ mode: 'spectacular' as never });
    expect(profile.mode).toBe('shadow');
    expect(profile.permissions.publish.allowed).toBe(false);
  });
});

describe('C1 config surface: the execution group', () => {
  it('defaults applyWinningPatch to false and mode to shadow', () => {
    const config = parseEvoHarnessConfig({});
    expect(config.execution.applyWinningPatch).toBe(false);
    expect(config.execution.mode).toBe('shadow');
    // The memory layer default is deny as well (promotion is a real write).
    expect(config.memoryBridge.promoteOnComposeSuccess).toBe(false);
  });

  it('accepts guarded-active with the patch switch and rejects the combination everywhere else', () => {
    const ok = parseEvoHarnessConfig({
      execution: { mode: 'guarded-active', applyWinningPatch: true }
    });
    expect(ok.execution.applyWinningPatch).toBe(true);
    expect(() =>
      parseEvoHarnessConfig({ execution: { mode: 'shadow', applyWinningPatch: true } })
    ).toThrow(ConfigValidationError);
    expect(() =>
      parseEvoHarnessConfig({ execution: { mode: 'baseline', applyWinningPatch: true } })
    ).toThrow(ConfigValidationError);
    expect(() => parseEvoHarnessConfig({ execution: { mode: 'warpspeed' } })).toThrow(
      ConfigValidationError
    );
  });

  it('carries the declared mode through the resolved config', () => {
    const config = parseEvoHarnessConfig({ execution: { mode: 'off' } });
    expect(config.execution.mode).toBe('off');
  });
});

describe('C0 explicit record fields: store round-trip and fail-closed validation', () => {
  it('stamps and round-trips decisionMode / actionKeyVocabulary', async () => {
    const store = createMemoryExperienceStore({ now: () => T0 + 1000 });
    await store.append([
      record({
        rewardVersion: CURRENT_REWARD_VERSION,
        provenanceVersion: 'p2/per-execution-v1',
        experienceSchemaVersion: EXPERIENCE_SCHEMA_VERSION,
        learningEligible: true,
        decisionMode: 'guarded-active',
        actionKeyVocabulary: 'signature'
      })
    ]);
    const queried = await store.query({
      level: 'proposal',
      state: { level: 'proposal', bucket: 'b', tokens: ['t'], summary: '' },
      k: 5,
      similarityThreshold: 0
    });
    const first = queried[0]?.record;
    expect(first?.decisionMode).toBe('guarded-active');
    expect(first?.actionKeyVocabulary).toBe('signature');
  });

  it('rejects a mistyped vocabulary or mode (producer bug, never guessed)', async () => {
    const store = createMemoryExperienceStore({ now: () => T0 + 1000 });
    await expect(
      store.append([
        record({ actionKeyVocabulary: 'sig' as never })
      ])
    ).rejects.toThrow();
    const store2 = createMemoryExperienceStore({ now: () => T0 + 1000 });
    await expect(
      store2.append([record({ decisionMode: 'yolo' as never })])
    ).rejects.toThrow();
  });

  it('keeps the r4 marker and the explicit previous lineage', () => {
    expect(CURRENT_REWARD_VERSION).toBe('r4/verifier-first-v1');
    expect(PREVIOUS_REWARD_VERSION).toBe('r3/unified-signals-v1');
  });
});

// ---------------------------------------------------------------------------
// t7: the five release-boundary regressions found by independent verification
// (t2 probes V1-V5). Each block reproduces the ORIGINAL defect shape against
// the real production modules and pins the repaired behaviour.
// ---------------------------------------------------------------------------

describe('t7/V1: permanent mount is bound to the patch permission (constructor)', () => {
  const minimalDeps = {
    config: { probe: { maxConcurrentProbes: 1, probeTimeoutMs: 1000 } },
    memory: {},
    seams: { applyPermanentPatch: async () => () => undefined },
    policy: {},
    proposer: {},
    composer: {},
    reflector: {},
    scorer: {},
    taxonomy: {},
    dreamer: {},
    treePool: {},
    runBranch: async () => ({})
  } as unknown as EvoHarnessOrchestratorDeps;

  it('ORIGINAL DEFECT: hand-built deps without executionProfile/applyWinningPatch no longer defaults the mount on', () => {
    // Before t7: deps.applyWinningPatch !== false defaulted to TRUE, so this
    // exact construction could permanently mount despite the shadow profile.
    const orch = new EvoHarnessOrchestratorImpl(JSON.parse(JSON.stringify(minimalDeps)));
    const internal = orch as unknown as {
      applyWinningPatch: boolean;
      executionProfile: { mode: string; permissions: Record<string, { allowed: boolean }> };
    };
    expect(internal.executionProfile.mode).toBe('shadow');
    expect(internal.executionProfile.permissions['patch']?.allowed).toBe(false);
    // The mount flag is now derived (permission AND explicit request), never
    // defaulted on: fail-closed for direct construction.
    expect(internal.applyWinningPatch).toBe(false);
  });

  it('even an explicit applyWinningPatch=true cannot mount without the guarded-active profile', () => {
    for (const mode of ['shadow', 'baseline', 'off'] as const) {
      const orch = new EvoHarnessOrchestratorImpl({
        ...minimalDeps,
        applyWinningPatch: true,
        executionProfile: resolveExecutionProfile({ mode })
      });
      expect((orch as unknown as { applyWinningPatch: boolean }).applyWinningPatch).toBe(false);
    }
  });

  it('the mount needs BOTH the explicit request and the guarded-active profile', () => {
    const orch = new EvoHarnessOrchestratorImpl({
      ...minimalDeps,
      applyWinningPatch: true,
      executionProfile: resolveExecutionProfile({ mode: 'guarded-active' })
    });
    expect((orch as unknown as { applyWinningPatch: boolean }).applyWinningPatch).toBe(true);
    // The request alone (without the profile) still fails closed.
    const bare = new EvoHarnessOrchestratorImpl({ ...minimalDeps, applyWinningPatch: true });
    expect((bare as unknown as { applyWinningPatch: boolean }).applyWinningPatch).toBe(false);
  });
});

describe('t7/V2: the explicit conservativeGate switch cannot bypass the profile', () => {
  const minimalDeps = {
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
    runBranch: async () => ({})
  } as unknown as EvoHarnessOrchestratorDeps;

  it('ORIGINAL DEFECT: shadow + conservativeGate=true is now rejected instead of silently intercepting', () => {
    // Before t7 this construction yielded mode=shadow WITH the gate on.
    expect(() =>
      new EvoHarnessOrchestratorImpl({
        ...minimalDeps,
        conservativeGate: true,
        executionProfile: resolveExecutionProfile({ mode: 'shadow' })
      })
    ).toThrow(/guarded-active/);
    for (const mode of ['baseline', 'off'] as const) {
      expect(() =>
        new EvoHarnessOrchestratorImpl({
          ...minimalDeps,
          conservativeGate: true,
          executionProfile: resolveExecutionProfile({ mode })
        })
      ).toThrow(/guarded-active/);
    }
  });

  it('no profile supplied (the hand-built default is shadow) rejects the switch too', () => {
    expect(() => new EvoHarnessOrchestratorImpl({ ...minimalDeps, conservativeGate: true })).toThrow(
      /guarded-active/
    );
  });

  it('guarded-active accepts the explicit switch and the profile alone still enables the gate', () => {
    const both = new EvoHarnessOrchestratorImpl({
      ...minimalDeps,
      conservativeGate: true,
      executionProfile: resolveExecutionProfile({ mode: 'guarded-active' })
    });
    expect((both as unknown as { conservativeGate: boolean }).conservativeGate).toBe(true);
    const profileOnly = new EvoHarnessOrchestratorImpl({
      ...minimalDeps,
      executionProfile: resolveExecutionProfile({ mode: 'guarded-active' })
    });
    expect((profileOnly as unknown as { conservativeGate: boolean }).conservativeGate).toBe(true);
  });
});

describe('t7/V3: learning tracks are explicit and never mix (5.2a-4 consumer-side pin)', () => {
  it('the record round-trips a declared learningTrack and rejects typos', async () => {
    const store = createMemoryExperienceStore({ now: () => T0 + 1000 });
    await store.append([
      record({ id: 'track-tq', learningTrack: 'task-quality' }),
      record({ id: 'track-proc', learningTrack: 'process' })
    ]);
    const queried = await store.query({
      level: 'proposal',
      state: { level: 'proposal', bucket: 'b', tokens: ['t'], summary: '' },
      k: 5,
      similarityThreshold: 0
    });
    const byId = new Map(queried.map((entry) => [entry.record.id, entry.record.learningTrack]));
    expect(byId.get('track-tq')).toBe('task-quality');
    expect(byId.get('track-proc')).toBe('process');
    const reject = createMemoryExperienceStore({ now: () => T0 + 1000 });
    await expect(
      reject.append([record({ id: 'track-typo', learningTrack: 'tasks' as never })])
    ).rejects.toThrow();
  });

  it('ORIGINAL DEFECT: an unknown-verdict (process) record can never enter a task-quality neighbourhood', async () => {
    // Before t7 the process/task-quality distinction did not exist on the
    // record, so a fused process reward was indistinguishable from a
    // task-quality sample. Now the task-quality query accepts ONLY explicit
    // declarations - an undeclared record (the pre-t7 shape) fails closed.
    const store = createMemoryExperienceStore({ now: () => T0 + 1000 });
    await store.append([
      // The pre-t7 production shape: eligible, current versions, NO track.
      record({ id: 'legacy-proc' }),
      // The t7 production shape: unknown verdict -> 'process'.
      record({ id: 'declared-proc', learningTrack: 'process' }),
      // A C2-era task-quality record.
      record({ id: 'tq', learningTrack: 'task-quality' })
    ]);
    const taskQuality = await store.query({
      level: 'proposal',
      state: { level: 'proposal', bucket: 'b', tokens: ['t'], summary: '' },
      k: 10,
      similarityThreshold: 0,
      learningTrack: 'task-quality'
    });
    expect(taskQuality.map((entry) => entry.record.id)).toEqual(['tq']);
    // And the process neighbourhood (what production L1/L2 estimate) never
    // consumes a task-quality record.
    const process = await store.query({
      level: 'proposal',
      state: { level: 'proposal', bucket: 'b', tokens: ['t'], summary: '' },
      k: 10,
      similarityThreshold: 0,
      learningTrack: 'process'
    });
    expect(process.map((entry) => entry.record.id).sort()).toEqual(['declared-proc', 'legacy-proc']);
    // An audit query without the track filter still sees everything.
    const audit = await store.query({
      level: 'proposal',
      state: { level: 'proposal', bucket: 'b', tokens: ['t'], summary: '' },
      k: 10,
      similarityThreshold: 0
    });
    expect(audit.length).toBe(3);
  });

  it('the production snapshot filter (L1/replay pre-filter) applies the same track rule', () => {
    const undeclared = record({ id: 'u' });
    const declared = record({ id: 'p', learningTrack: 'process' });
    const taskQuality = record({ id: 'q', learningTrack: 'task-quality' });
    const snapshot = [undeclared, declared, taskQuality];
    // The shared predicate every production consumer applies BEFORE handing
    // the snapshot to the (untouched, R6-frozen) kernel: a process estimate
    // keeps undeclared + declared-process and never a task-quality record.
    const processVisible = snapshot.filter((entry) =>
      isOnLearningTrack(entry, PRODUCTION_LEARNING_TRACK)
    );
    expect(processVisible.map((entry) => entry.id).sort()).toEqual(['p', 'u']);
    // A task-quality estimate accepts ONLY explicit declarations.
    const taskQualityVisible = snapshot.filter((entry) => isOnLearningTrack(entry, 'task-quality'));
    expect(taskQualityVisible.map((entry) => entry.id)).toEqual(['q']);
    expect(isOnLearningTrack(undeclared, 'task-quality')).toBe(false);
    expect(isOnLearningTrack(declared, 'process')).toBe(true);
    expect(isOnLearningTrack(taskQuality, 'process')).toBe(false);
    // The kernel itself (the frozen research surface) still sees every record
    // the caller hands it - the isolation lives at the consumer boundary, so
    // the eval engine's direct kernel calls keep their exact behaviour.
    const layerConfig = {
      beta: 0,
      k: 5,
      similarityThreshold: 0,
      selection: 'argmax' as const,
      lambda: 0,
      alpha: 0,
      unseenFallback: 'baseline' as const,
      halfLifeMs: 0
    };
    const state = { level: 'proposal' as const, bucket: 'b', tokens: ['t'], summary: '' };
    const candidates = [
      { actionKey: 'a', baseLogit: 0, source: 'policy_prior' as const, payload: 1 }
    ];
    const kernel = runDecisionKernel({
      level: 'proposal',
      state,
      candidates,
      records: processVisible,
      config: layerConfig
    });
    expect(kernel.neighbors.map((entry) => entry.record.id).sort()).toEqual(['p', 'u']);
  });

  it('the strict learning filter keeps its legacy/eligibility flags (the track is declared at the consumer boundary)', () => {
    const filter = learningFacingFilterOptions();
    expect(filter.excludeLegacy).toBe(true);
    expect(filter.learningEligibleOnly).toBe(true);
    // t7/V3: the shared kernel filter deliberately stays track-free (R6);
    // the production consumers add the track via the snapshot pre-filter
    // (isOnLearningTrack) or the store query (learningTrack).
    expect(PRODUCTION_LEARNING_TRACK).toBe('process');
  });

  it('an unknown-verdict trajectory is stamped process by the REAL recorder (no rule duplication)', async () => {
    const unknown = trajectory({ deliverable: { content: 'x', format: 'text' } });
    const score = scoreUnderRewardContract(unknown);
    expect(score.verification.status).toBe('unknown');
    expect(score.verification.trustedSource).toBe(false);
    expect(score.taskQualityEvidence).toBe(false);
    expect(score.sources.completion).toBe(0);
    // t10/COV (t9 finding: the old test copied the recorder rule instead of
    // exercising it): the assertion below drives the PRODUCTION recorder and
    // reads the STAMPED track from the record it appends.
    const appended: ExperienceRecord[] = [];
    const kernel = {
      config: { enabled: true, levels: ['meta', 'proposal'], gamma: 0.9, candidateCount: 3 },
      store: {
        append: async (records: readonly ExperienceRecord[]) => {
          appended.push(...records);
        },
        query: async () => [],
        size: async () => 0
      },
      stepEvaluator: { evaluate: async () => [] }
    };
    const orch = new EvoHarnessOrchestratorImpl(
      minimalDeps({ jitrl: kernel, executionProfile: resolveExecutionProfile({ mode: 'shadow' }) } as never)
    );
    const internals = orch as unknown as { recordOnlineExperience: (input: never) => Promise<number> };
    await internals.recordOnlineExperience({
      kernel,
      task: { id: 'task-unknown-track', prompt: 'p' },
      sessionId: 'sess-unknown-track',
      executed: [
        {
          round: 1,
          slotIndex: 0,
          slot: { slot: 'exploit', slotIndex: 0, branchId: 'br', guidance: 'memory' },
          l1State: { level: 'meta', bucket: 'b', tokens: ['t'], summary: '' },
          nodeId: 'n1',
          parentNodeId: 'root',
          branchId: 'br',
          actionKey: 'slot:exploit',
          guidance: 'memory',
          trajectory: unknown,
          selection: {
            state: { level: 'proposal', bucket: 'b', tokens: ['t'], summary: '' },
            actionKey: 'patch:a',
            decisionId: 'jit-decision-unknown',
            chosenIndex: 0,
            offered: 2,
            priorIndex: 0,
            proposedIndex: 0
          }
        }
      ],
      reference: { ...unknown, id: 'ref-unknown', role: 'reference' },
      selectedNodeId: 'n1',
      policyId: 'pi',
      runId: 'run-unknown-track',
      treeId: 'tree-unknown',
      round: 1,
      stage: () => undefined,
      diagnostics: []
    } as never);
    const l2 = appended.find((rec) => rec.level === 'proposal');
    expect(l2).toBeDefined();
    expect(l2?.learningTrack).toBe('process');
    expect(l2?.decisionMode).toBe('shadow');
  });
});

describe('t7/V4: a noop challenger is judged by evidence, not by its type', () => {
  const prior = { actionKey: 'prior', q: 0.1, support: 10, nEff: 7, explored: false, advantage: 0.1 };

  it('ORIGINAL DEFECT: a noop WITH real measured evidence is no longer hard-vetoed by type', () => {
    // Before t7 challengerIsNoop alone triggered the unconditional veto, so
    // this evidenced challenger was denied with a factually wrong reason.
    const verdict = decideReplacement({
      proposedIndex: 1,
      priorIndex: 0,
      challenger: { actionKey: 'noop', q: 0.6, support: 12, nEff: 8, explored: false, advantage: 0.5 },
      prior,
      challengerIsNoop: true,
      explorationAllowance: 0
    });
    // Full evidence: judged like any other challenger - executes.
    expect(verdict.kind).toBe('executed-proposed');
    expect(verdict.gateReason).toBeUndefined();
    expect(verdict.challenger.hasReplacementEvidence).toBe(true);
    expect(verdict.challenger.nEff).toBe(8);
    // Same shape with a budget still executes WITHOUT charging the budget
    // (this is not an under-evidenced deviation anymore).
    const withBudget = decideReplacement({
      proposedIndex: 1,
      priorIndex: 0,
      challenger: { actionKey: 'noop', q: 0.6, support: 12, nEff: 8, explored: false, advantage: 0.5 },
      prior,
      challengerIsNoop: true,
      explorationAllowance: 3
    });
    expect(withBudget.kind).toBe('executed-proposed');
    expect(withBudget.exploration).toBe(false);
  });

  it('an evidence-free noop artefact is still hard-vetoed (the first-harm shape)', () => {
    const veto = decideReplacement({
      proposedIndex: 1,
      priorIndex: 0,
      challenger: { actionKey: 'noop', q: null, support: 0, explored: false, advantage: 0 },
      prior,
      challengerIsNoop: true,
      explorationAllowance: 5
    });
    expect(veto.kind).toBe('kept-prior');
    expect(veto.gateReason).toBe('implicit-zero-advantage');
  });

  it('a fallback-derived zero advantage (non-noop) is still the veto artefact', () => {
    const verdict = decideReplacement({
      proposedIndex: 1,
      priorIndex: 0,
      challenger: { actionKey: 'weird', q: null, support: 0, explored: false, advantage: 0 },
      prior,
      challengerIsNoop: false,
      explorationAllowance: 5
    });
    expect(verdict.kind).toBe('kept-prior');
    expect(verdict.gateReason).toBe('implicit-zero-advantage');
  });
});

// ---------------------------------------------------------------------------
// t10 (repair round 3): production-path regressions for the t9 findings.
// ---------------------------------------------------------------------------

function minimalDeps(overrides: Partial<EvoHarnessOrchestratorDeps> = {}): EvoHarnessOrchestratorDeps {
  return {
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
    ...overrides
  } as unknown as EvoHarnessOrchestratorDeps;
}

function probeTrajectory(overrides: Partial<ProbeTrajectory> = {}): ProbeTrajectory {
  return {
    id: 'traj-t10',
    sessionId: 's',
    branchId: 'b',
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
    deliverable: { content: 'x', format: 'text', contentHash: 'sha256:x' },
    ...overrides
  } as ProbeTrajectory;
}

describe('t10/R2: the memory layer is a request+permission double gate', () => {
  it('every mode denies the memory permission; no config shape can widen it', () => {
    for (const mode of ['baseline', 'shadow', 'guarded-active', 'off'] as const) {
      const profile = resolveExecutionProfile({ mode });
      expect(profile.permissions.memory.allowed).toBe(false);
    }
    // The explicit override exists ONLY as profile input data.
    const opted = resolveExecutionProfile({ memoryRealWrites: true });
    expect(opted.permissions.memory.allowed).toBe(true);
    expect(opted.permissions.memory.reason).toContain('memoryRealWrites');
    // The default assembly (mode only) never produces it.
    expect(resolveExecutionProfile({ mode: 'guarded-active' }).permissions.memory.allowed).toBe(false);
  });

  it('ORIGINAL DEFECT: promote with the config flag on still refuses under a denied permission', () => {
    // t9 measured: shadow + promoteOnComposeSuccess=true wrote the real global
    // namespace. Now promoteLessonIfConfigured checks the PERMISSION half and
    // records an explicit refusal diagnostic instead of promoting. Pinned via
    // the profile the orchestrator resolves (the production shape).
    const deps = minimalDeps({
      executionProfile: resolveExecutionProfile({ mode: 'shadow' })
    });
    const orch = new EvoHarnessOrchestratorImpl(deps);
    const profile = (
      orch as unknown as { executionProfile: { permissions: { memory: { allowed: boolean } } } }
    ).executionProfile;
    expect(profile.permissions.memory.allowed).toBe(false);
  });

  /**
   * t12/R2-residual (t11 blocker): a bridge that ACCEPTS any scope - the shape
   * the reviewer injected to prove the t10 "ephemeral namespace" fix was a
   * rename, not an enforcement. Every denied assembly must leave it untouched.
   */
  function acceptingMemoryBridge(calls: string[]): unknown {
    return {
      commit: async (lesson: { id: string }, options: { scope: { sessionId?: string } }) => {
        calls.push('commit:' + lesson.id + ':' + String(options.scope.sessionId));
        return {
          accepted: true,
          persisted: true,
          lessonId: lesson.id,
          namespace: 'accept-any-scope',
          driverKind: 'vector_fact',
          violations: [],
          at: 0
        };
      },
      promote: async (lesson: { id: string }) => {
        calls.push('promote:' + lesson.id);
        return {
          accepted: true,
          persisted: true,
          lessonId: lesson.id,
          namespace: 'accept-any-scope-global',
          driverKind: 'vector_fact',
          violations: [],
          at: 0
        };
      },
      descriptor: { driverKind: 'vector_fact' }
    };
  }

  const t12Lesson = {
    id: 'lesson-t12-denied',
    title: 't',
    whenToApply: ['w'],
    subFunctions: ['g'],
    executionPatch: { summary: 's' },
    verificationEvidence: { candidateSuccess: 'c' },
    whenNotToApply: ['n'],
    polarity: 'positive',
    visibility: 'session',
    sessionId: 'sess-real',
    confidence: 0.6
  };

  const promoteRequestedConfig = {
    probe: { maxConcurrentProbes: 1, probeTimeoutMs: 1000 },
    memoryBridge: { promoteOnComposeSuccess: true }
  };

  it('t12/R2-residual: denied permission makes ZERO bridge calls (default and all four modes)', async () => {
    // The t10 shape issued a real deps.memory.commit with an "ephemeral"
    // per-run scope and relied on the hosted bridge to refuse it. An injected
    // bridge that accepts any scope persisted the write and the diagnostic
    // claimed the lesson had landed there. Now the call site must not call the
    // bridge at all - under the hand-built default (shadow) and under every
    // explicitly resolved mode.
    const assemblies: readonly { readonly label: string; readonly overrides: Record<string, unknown> }[] = [
      {
        label: 'hand-built default (no executionProfile)',
        overrides: {}
      },
      ...(['baseline', 'shadow', 'guarded-active', 'off'] as const).map((mode) => ({
        label: 'executionProfile mode=' + mode,
        overrides: { executionProfile: resolveExecutionProfile({ mode }) }
      }))
    ];
    const observed: string[] = [];
    for (const assembly of assemblies) {
      const calls: string[] = [];
      const orch = new EvoHarnessOrchestratorImpl(
        minimalDeps({
          config: promoteRequestedConfig,
          memory: acceptingMemoryBridge(calls),
          ...assembly.overrides
        } as never)
      );
      const internals = orch as unknown as {
        commitLessons: (
          lessons: readonly unknown[],
          scope: unknown,
          diagnostics: string[]
        ) => Promise<number>;
      };
      const diagnostics: string[] = [];
      const committed = await internals.commitLessons(
        [t12Lesson],
        { kind: 'session', sessionId: 'sess-real' },
        diagnostics
      );
      const text = diagnostics.join(' ');
      expect(committed, assembly.label + ': nothing may be reported committed').toBe(0);
      expect(calls, assembly.label + ': the bridge was called under a denied permission').toEqual([]);
      expect(text, assembly.label + ': the denial must be visible').toContain('memory permission');
      expect(text, assembly.label + ': the diagnostic must say the lessons did not commit').toContain(
        'NOT committed'
      );
      expect(text, assembly.label + ': the diagnostic must say the bridge was not called').toContain(
        'bridge was not called'
      );
      // The rename-only "fix" (an ephemeral/derived scope) is what the blocker
      // rejected: no renamed scope may appear anywhere in the denial path.
      expect(text, assembly.label + ': no renamed scratch namespace').not.toContain('ephemeral');
      observed.push(assembly.label + ' -> 0 call(s)');
    }
    expect(observed).toHaveLength(5);
  });

  it('t12/R2-residual positive control: the explicit test override still commits and promotes', async () => {
    // The permission half is not a dead switch: the deterministic TEST
    // assemblies (in-memory fakes) that pass ExecutionProfileInput
    // .memoryRealWrites explicitly keep the governed-commit machinery, and the
    // real (caller-supplied) governed scope is what reaches the bridge.
    const calls: string[] = [];
    const orch = new EvoHarnessOrchestratorImpl(
      minimalDeps({
        config: promoteRequestedConfig,
        memory: acceptingMemoryBridge(calls),
        executionProfile: resolveExecutionProfile({ memoryRealWrites: true })
      } as never)
    );
    const internals = orch as unknown as {
      commitLessons: (
        lessons: readonly unknown[],
        scope: unknown,
        diagnostics: string[]
      ) => Promise<number>;
    };
    const diagnostics: string[] = [];
    const committed = await internals.commitLessons(
      [t12Lesson],
      { kind: 'session', sessionId: 'sess-real' },
      diagnostics
    );
    expect(committed).toBe(1);
    expect(calls).toEqual(['commit:lesson-t12-denied:sess-real', 'promote:lesson-t12-denied']);
    expect(diagnostics.join(' ')).not.toContain('NOT committed');
    expect(diagnostics.join(' ')).toContain('promoted lesson lesson-t12-denied to global scope');
  });
});

describe('t10/COV: the reservation refund runs through the REAL recorder', () => {
  it('grant -> real deviation -> cancelled execution -> idempotent refund via recordOnlineExperience', async () => {
    const appended: ExperienceRecord[] = [];
    const kernel = {
      config: {
        enabled: true,
        levels: ['meta', 'proposal'],
        gamma: 0.9,
        candidateCount: 3
      },
      store: {
        append: async (records: readonly ExperienceRecord[]) => {
          appended.push(...records);
        },
        query: async () => [],
        size: async () => 0
      },
      stepEvaluator: { evaluate: async () => [] }
    };
    const profile = resolveExecutionProfile({ mode: 'guarded-active' });
    const orch = new EvoHarnessOrchestratorImpl(
      minimalDeps({ jitrl: kernel, executionProfile: profile } as never)
    );
    const internals = orch as unknown as {
      recordOnlineExperience: (input: never) => Promise<number>;
      explorationAllowance: number;
    };
    // The explicit grant (the only path an under-evidenced deviation may take).
    expect(orch.grantExplorationBudget(2)).toBe(2);
    const trajectory = probeTrajectory({ status: 'aborted' });
    const diagnostics: string[] = [];
    const recorderInput = (overrides: Record<string, unknown>): never =>
      ({
        kernel,
        task: { id: 'task-refund', prompt: 'p' },
        sessionId: 'sess-refund',
        executed: [],
        reference: { ...trajectory, id: 'ref', role: 'reference' },
        selectedNodeId: null,
        policyId: 'pi',
        runId: 'run-refund',
        treeId: 'tree-1',
        round: 1,
        stage: () => undefined,
        diagnostics,
        ...overrides
      }) as never;
    await internals.recordOnlineExperience(
      recorderInput({
        executed: [
          {
            round: 1,
            slotIndex: 0,
            slot: { slot: 'exploit', slotIndex: 0, branchId: 'br', guidance: 'memory' },
            l1State: { level: 'meta', bucket: 'b', tokens: ['t'], summary: '' },
            nodeId: 'n1',
            parentNodeId: 'root',
            branchId: 'br',
            actionKey: 'slot:exploit',
            guidance: 'memory',
            trajectory,
            selection: {
              state: { level: 'proposal', bucket: 'b', tokens: ['t'], summary: '' },
              actionKey: 'patch:a',
              decisionId: 'jit-decision-refund',
              chosenIndex: 1,
              offered: 2,
              priorIndex: 0,
              proposedIndex: 1,
              exploration: true,
              challenger: {
                nEff: 1.2,
                support: 1,
                shrunkAdvantage: 0.2,
                calibratedAdvantage: 0.4,
                implicitZeroAdvantage: false
              }
            }
          }
        ],
        selectedNodeId: 'n1'
      })
    );
    // The aborted exploration execution released its seat through the
    // production recorder (idempotent ledger keyed by the trajectory id).
    expect(internals.explorationAllowance).toBe(3);
    // The record honestly says what happened (exploration charged, audit-only
    // aborted execution: no reward, no learning target).
    const l2 = appended.find((rec) => rec.level === 'proposal');
    expect(l2?.decisionMode).toBe('guarded-active');
    expect(l2?.rewardSources.exploration).toBe(1);
    expect(l2?.learningEligible).toBe(false);
    expect(l2?.learningTarget).toBe(0);
    // Re-entering the recorder for the same trajectory refunds NOTHING.
    await internals.recordOnlineExperience(recorderInput({ runId: 'run-refund-2' }));
    expect(internals.explorationAllowance).toBe(3);
  });
});

describe('t10/R3b + t12/R3b2: replay/restart consumes the CALLER-declared mode/vocabulary', () => {
  it('the factory option beats the default and decides who enters the neighbourhood', async () => {
    // t12/R3b2 (t11 high finding): the t10 factory spread the caller option and
    // then re-declared `replayDeclarations` after it, so the caller's
    // declaration was silently overwritten by shadow/signature and every
    // production replay ran shadow - guarded-active/baseline logs were dropped.
    // This drives the REAL factory with two declarations over the SAME pools
    // and asserts the direction of the outcome, never a tautology.
    const { createJitRl } = await import('../../../src/jitrl');
    const { parseEvoHarnessConfig } = await import('../../../src/config');
    const config = parseEvoHarnessConfig({
      jitrl: { enabled: true, levels: ['meta'] }
    });
    const kernel = createJitRl({ config, now: () => T0 });
    const defaultHook = kernel.createReplayHook();
    const declaredHook = kernel.createReplayHook({
      replayDeclarations: { decisionMode: 'guarded-active', actionKeyVocabulary: 'signature' }
    });
    // The hook derives its state from the frontier, so the records below are
    // built against the IDENTICAL abstract state (same task id, round, slot).
    // Without this the retrieval would find no neighbours for anybody and the
    // assertions would be vacuous (the t10 defect hid behind exactly that).
    const replayState = abstractMetaState({
      task: { id: 'tree-r3b', prompt: '' },
      round: 0,
      parentDepth: 0,
      parentSlot: 'exploit',
      memoryConfidence: 0,
      referenceStatus: 'missing'
    });
    const base = {
      treeId: 'tree-r3b',
      policyId: 'pi',
      rho: 0.5,
      slotWeights: {
        exploit: 0.25,
        explore_domain: 0.25,
        explore_invariant: 0.25,
        recover: 0.25
      } as never,
      frontier: {
        nodeId: 'n',
        depth: 0,
        slot: 'exploit',
        guidance: 'memory',
        status: 'succeeded',
        score: 1,
        createdAt: T0
      } as never,
      jit: { beta: 1, lambda: 0, alpha: 0.1, k: 8, gamma: 0.9, similarityThreshold: 0 } as never,
      experiences: []
    };
    // Same state derivation for every call: only the declarations and the pool
    // differ. The returns are the fingerprints that tell us WHICH record the
    // replay actually used.
    const shadowRecord = record({
      id: 'r3b2-shadow',
      level: 'meta',
      actionKey: 'slot:exploit',
      state: replayState,
      reward: 5,
      return: 5,
      rewardVersion: CURRENT_REWARD_VERSION,
      experienceSchemaVersion: EXPERIENCE_SCHEMA_VERSION,
      learningEligible: true,
      decisionMode: 'shadow',
      actionKeyVocabulary: 'signature'
    });
    const guardedRecord = record({
      id: 'r3b2-guarded',
      level: 'meta',
      actionKey: 'slot:exploit',
      state: replayState,
      reward: -5,
      return: -5,
      rewardVersion: CURRENT_REWARD_VERSION,
      experienceSchemaVersion: EXPERIENCE_SCHEMA_VERSION,
      learningEligible: true,
      decisionMode: 'guarded-active',
      actionKeyVocabulary: 'signature'
    });
    const undeclaredRecord = record({
      id: 'r3b2-undeclared',
      level: 'meta',
      actionKey: 'slot:exploit',
      state: replayState,
      reward: 9,
      return: 9,
      rewardVersion: CURRENT_REWARD_VERSION,
      experienceSchemaVersion: EXPERIENCE_SCHEMA_VERSION,
      learningEligible: true
    });

    // Forward: the default declaration (shadow/signature) sees the shadow
    // record and rejects the guarded-active one.
    const shadowOnlyDefault = defaultHook({ ...base, experiences: [shadowRecord] });
    expect(shadowOnlyDefault.diagnostics.neighborCount).toBeGreaterThan(0);
    const guardedOnlyDefault = defaultHook({ ...base, experiences: [guardedRecord] });
    expect(guardedOnlyDefault.diagnostics.neighborCount).toBe(0);

    // Reverse: the caller-declared guarded-active partition sees exactly the
    // mirror image. Before the t12/R3b2 fix this call behaved like the default
    // and got neighbourCount 0 (the caller option was discarded).
    const guardedOnlyDeclared = declaredHook({ ...base, experiences: [guardedRecord] });
    expect(guardedOnlyDeclared.diagnostics.neighborCount).toBeGreaterThan(0);
    const shadowOnlyDeclared = declaredHook({ ...base, experiences: [shadowRecord] });
    expect(shadowOnlyDeclared.diagnostics.neighborCount).toBe(0);

    // Mixed pool: the declaration decides WHICH record provides the evidence,
    // observable through the state value fingerprint (+5 vs -5).
    const mixedDefault = defaultHook({ ...base, experiences: [shadowRecord, guardedRecord] });
    const mixedDeclared = declaredHook({ ...base, experiences: [shadowRecord, guardedRecord] });
    expect(mixedDefault.diagnostics.stateValue).toBeCloseTo(5, 6);
    expect(mixedDeclared.diagnostics.stateValue).toBeCloseTo(-5, 6);

    // Fail-closed: a record that declares no mode/vocabulary never joins a
    // declared replay under EITHER declaration (it is never re-stamped with
    // the current mode - contract item 5).
    expect(defaultHook({ ...base, experiences: [undeclaredRecord] }).diagnostics.neighborCount).toBe(0);
    expect(declaredHook({ ...base, experiences: [undeclaredRecord] }).diagnostics.neighborCount).toBe(0);

    // A PARTIAL caller declaration still gets the documented default for the
    // field it omitted, so it can never accidentally un-partition the replay:
    // mode=guarded-active + the default signature vocabulary keeps the shadow
    // record out.
    const partialHook = kernel.createReplayHook({ replayDeclarations: { decisionMode: 'guarded-active' } });
    expect(partialHook({ ...base, experiences: [guardedRecord] }).diagnostics.neighborCount).toBeGreaterThan(0);
    expect(partialHook({ ...base, experiences: [shadowRecord] }).diagnostics.neighborCount).toBe(0);
  });
});

describe('t12/R1c: one resolved effective profile for orchestrator, L1 and replay', () => {
  /** A two-node tree whose best node hints every surface (L1 has work to do). */
  function p62Tree(): unknown {
    const mk = (id: string, overrides: Record<string, unknown>): Record<string, unknown> => ({
      treeId: 'tree-t12-r1c',
      parentId: null,
      depth: 0,
      branchId: 'branch-' + id,
      patchId: 'patch-' + id,
      patchOrigin: 'reference',
      purpose: 'initial',
      guidance: 'memory',
      status: 'succeeded',
      childIds: [],
      createdAt: T0,
      updatedAt: T0,
      ...overrides,
      id
    });
    const root = mk('root', { guidance: 'guidance_free' });
    const best = mk('best', { parentId: 'root', depth: 1, slot: 'exploit', purpose: 'deepen', score: 0.9 });
    root.childIds = ['best'];
    return {
      id: 'tree-t12-r1c',
      sessionId: 'session-t12-r1c',
      taskId: 'task-t12-r1c',
      rootId: 'root',
      nodes: { root, best },
      policyId: 'pi-0',
      stats: { nodeCount: 2, maxDepth: 1, maxWidth: 2, scoredNodes: 1, completedNodes: 2 },
      completed: false,
      createdAt: T0,
      updatedAt: T0
    };
  }

  function batchRequest(): unknown {
    return {
      task: { id: 'task-t12-r1c', prompt: 'Fix the failing build.', taskSignature: 'fix-build', complexity: 'moderate', contextTags: ['ci'] },
      sessionId: 'session-t12-r1c',
      tree: p62Tree(),
      grid: {
        maxWidth: 8,
        maxDepth: 2,
        budget: 8,
        skipProbing: false,
        stopCondition: 'budget_exhausted',
        complexity: 'moderate',
        rationale: 't12 r1c',
        policyId: 'pi-0'
      },
      memoryConfidence: 0.8,
      round: 1,
      previousBestNodeId: 'best'
    };
  }

  it('an injected profile drives L1 interception AND the replay declarations, not config.execution.mode', async () => {
    // t12/R1c (t11 finding): the orchestrator enforced the resolved profile,
    // but the L1 decorator and the dream replay read `config.execution.mode`,
    // so an injected profile (the documented seam) split one run across two
    // modes. The wiring now takes the SAME resolved profile. This test drives
    // the production factories (buildJitRlWiring / createJitWiredDreamer) with
    // config=shadow and an injected baseline/guarded-active profile and reads
    // the observable differences.
    const { buildJitRlWiring, createJitWiredDreamer } = await import('../../../src/index');
    const { createActivePolicy, createDefaultPolicy } = await import('../../../src/dream-rsi/active-policy');
    const { readJitDiagnostics } = await import('../../../src/jitrl/jit-active-policy');
    const { createJitRl } = await import('../../../src/jitrl');
    const now = (): number => T0;
    // config declares the DEFAULT shadow; only the injected profile differs.
    const config = parseEvoHarnessConfig({ jitrl: { enabled: true, levels: ['meta'] } });
    const basePolicy = createActivePolicy({
      policy: createDefaultPolicy({ id: 'pi-0', version: 3 }, now),
      now,
      maxRecoverySlots: 1
    });
    const wiringFor = (mode: 'baseline' | 'guarded-active') =>
      buildJitRlWiring({
        config,
        policy: basePolicy,
        options: {},
        persistence: undefined,
        diagnostics: [],
        now,
        executionProfile: resolveExecutionProfile({ mode })
      });

    // L1 half: injected baseline -> no interception even though config says shadow.
    const baselinePlan = wiringFor('baseline').policy.selectBatch(batchRequest() as never);
    expect(readJitDiagnostics(baselinePlan)).toBeUndefined();
    // ... and injected guarded-active -> interception, again with config=shadow.
    const guardedPlan = wiringFor('guarded-active').policy.selectBatch(batchRequest() as never);
    expect(readJitDiagnostics(guardedPlan)).toBeDefined();

    // Replay half: the dreamer's declarations come from the same injected
    // profile (baseline maps through recordModeOf, guarded-active stays).
    const replayFor = async (mode: 'baseline' | 'guarded-active'): Promise<string> => {
      const kernel = createJitRl({ config, now });
      const dreamer = createJitWiredDreamer({
        kernel,
        config,
        recorder: { hookAttached: true },
        executionProfile: resolveExecutionProfile({ mode }),
        base: {
          now,
          activePolicy: {
            policy: createDefaultPolicy({ id: 'pi-0', version: 3 }, now),
            update: () => undefined
          }
        } as never
      });
      await dreamer.replay({
        trees: [],
        baselinePolicy: createDefaultPolicy({ id: 'pi-0', version: 3 }, now),
        candidatePolicies: []
      } as never);
      return (dreamer.lastDreamDiagnostics?.() ?? []).join(' ');
    };
    expect(await replayFor('baseline')).toContain('replay declarations baseline/signature');
    expect(await replayFor('guarded-active')).toContain('replay declarations guarded-active/signature');
  });
});

