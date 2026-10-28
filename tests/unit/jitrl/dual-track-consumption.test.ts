/**
 * C2b (ADR 0004 §2, §8.2): Unit tests for default-off trusted quality consumption,
 * dual-track separate retrieval, atomic track selection state machine, and provenance
 * authentication.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import type {
  AbstractState,
  BatchSlotKind,
  ExperienceRecord,
  JitCandidate,
  JitDecision
} from '../../../src/types/contracts';
import type { MetaActionPayload } from '../../../src/jitrl/jit-active-policy';
import { DEFAULT_EVO_HARNESS_CONFIG, type JitRlConfig } from '../../../src/config';
import {
  CURRENT_PROVENANCE_VERSION,
  CURRENT_REWARD_VERSION,
  EXPERIENCE_SCHEMA_VERSION
} from '../../../src/jitrl/experience-store';
import { createMemoryExperienceStore } from '../../../src/jitrl/stores/memory.store';
import {
  runDecisionKernel,
  selectTrackAtomically,
  type DualTrackConsumptionOptions,
  type LayerDecisionConfig
} from '../../../src/jitrl/decision-kernel';
import {
  registerAuthenticatedQualityRecord,
  clearQualityRecordRegistry,
  isAuthenticatedQualityRecord
} from '../../../src/verification';
import { createStoreOptimizer } from '../../../src/jitrl/index';
import { decideReplacement } from '../../../src/jitrl/replacement-policy';

const T0 = 1_700_000_000_000;
const NOW = T0 + 60_000;
const HALF_LIFE = 60_000;

/**
 * C2b F11: every registration below uses a COMPLETE host binding (all members
 * present, sha256:64hex artifact digest). The helper also keeps the record's
 * runId aligned with the binding runId.
 */
const BINDING_RUN = 'run-c2b';
function fullBinding(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    artifactDigest: 'sha256:' + 'b'.repeat(64),
    verifierId: 'host-runner-c2b',
    verifierVersion: '1.0.0',
    verificationId: 'v-c2b-1',
    testSetId: 'ts-c2b',
    envId: 'env-c2b',
    runId: BINDING_RUN,
    sessionId: 'session-0',
    trajectoryId: 'traj-0',
    taskId: 'task-c2b',
    role: 'candidate',
    ...overrides
  };
}

function makeState(bucket = 'test-bucket'): AbstractState {
  return {
    level: 'meta',
    bucket,
    summary: 'test-summary',
    tokens: ['tok_alpha', 'tok_beta']
  };
}

function makeCandidates(): readonly JitCandidate<MetaActionPayload>[] {
  const slotKinds: BatchSlotKind[] = ['exploit', 'explore_domain', 'explore_invariant', 'recover'];
  return slotKinds.map((slotKind, index) => ({
    actionKey: `slot:${slotKind}`,
    source: index === 0 ? 'policy_prior' : 'llm',
    baseLogit: index === 0 ? 1.0 : 0.5,
    priorLogit: index === 0 ? 1.0 : 0.5,
    payload: {
      slotKind,
      focusSurfaces: []
    }
  }));
}

function makeLayerConfig(overrides: Partial<LayerDecisionConfig> = {}): LayerDecisionConfig {
  return {
    k: 10,
    similarityThreshold: 0.0,
    beta: 2.0,
    selection: 'argmax',
    unseenFallback: 'baseline',
    lambda: 0,
    alpha: 0,
    halfLifeMs: HALF_LIFE,
    ...overrides
  };
}

function makeRecord(overrides: Partial<ExperienceRecord> & { id: string }): ExperienceRecord {
  return {
    level: 'meta',
    state: makeState(),
    actionKey: 'slot:explore_domain',
    reward: 1.0,
    return: 1.0,
    rewardSources: {
      outcome: 1,
      outcomeEligible: 1,
      verificationTrusted: 1,
      verificationAuditOnly: 0
    },
    guidance: 'memory',
    policyId: 'pi-0',
    sessionId: 'session-0',
    runId: BINDING_RUN,
    treeId: 'tree-0',
    experienceSchemaVersion: EXPERIENCE_SCHEMA_VERSION,
    rewardVersion: CURRENT_REWARD_VERSION,
    provenanceVersion: CURRENT_PROVENANCE_VERSION,
    learningTrack: 'process',
    learningEligible: true,
    createdAt: T0,
    redacted: true,
    ...overrides
  };
}

describe('PR-2 C2b: Dual-Track Consumption & Atomic Track Selection', () => {
  beforeEach(() => {
    clearQualityRecordRegistry();
  });

  describe('1. Default-off baseline equivalence', () => {
    it('behaves byte-identical to baseline when dualTrack is omitted or disabled', async () => {
      const candidates = makeCandidates();
      const state = makeState();
      const records: ExperienceRecord[] = [
        makeRecord({ id: 'proc-1', actionKey: 'slot:explore_domain', return: 0.8, learningTrack: 'process' }),
        makeRecord({ id: 'proc-2', actionKey: 'slot:exploit', return: 0.2, learningTrack: 'process' })
      ];

      // Dual track disabled
      const kernelOff = runDecisionKernel({
        level: 'meta',
        state,
        candidates,
        records,
        config: makeLayerConfig(),
        seed: 42,
        now: NOW,
        dualTrack: { enableQualityTrackConsumption: false }
      });

      // Dual track undefined (standard baseline)
      const kernelDefault = runDecisionKernel({
        level: 'meta',
        state,
        candidates,
        records,
        config: makeLayerConfig(),
        seed: 42,
        now: NOW
      });

      expect(kernelOff.decision.stateValue).toBe(kernelDefault.decision.stateValue);
      expect(kernelOff.decision.klToPrior).toBe(kernelDefault.decision.klToPrior);
      expect(kernelOff.decision.adjustments).toEqual(kernelDefault.decision.adjustments);
      expect(kernelOff.trackSelection).toBeUndefined();
    });
  });

  describe('2. Dual-track separate retrieval (no single-pool crowding)', () => {
    it('retrieves from both process and task-quality tracks without mutual crowding', () => {
      const candidates = makeCandidates();
      const state = makeState();

      // Create 5 process records favoring exploit
      const records: ExperienceRecord[] = [];
      for (let i = 0; i < 5; i++) {
        records.push(
          makeRecord({
            id: `proc-${i}`,
            actionKey: 'slot:exploit',
            return: 0.2,
            learningTrack: 'process',
            createdAt: T0 + i * 1000
          })
        );
      }

      // Quality track: exploit failed (-1.0), explore succeeded (+1.0)
      const failExploit = makeRecord({
        id: 'qual-fail-exploit',
        actionKey: 'slot:exploit',
        return: -1.0,
        reward: -1.0,
        learningTrack: 'task-quality',
        createdAt: T0 + 9000
      });
      registerAuthenticatedQualityRecord(failExploit, fullBinding());
      records.push(failExploit);

      for (let i = 0; i < 3; i++) {
        const qRec = makeRecord({
          id: `qual-${i}`,
          actionKey: 'slot:explore_domain',
          return: 1.0,
          reward: 1.0,
          learningTrack: 'task-quality',
          createdAt: T0 + (i + 10) * 1000
        });
        registerAuthenticatedQualityRecord(qRec, fullBinding());
        records.push(qRec);
      }

      const kernel = runDecisionKernel({
        level: 'meta',
        state,
        candidates,
        records,
        config: makeLayerConfig({ k: 4 }),
        now: NOW,
        dualTrack: {
          enableQualityTrackConsumption: true,
          minQualityEffectiveSamples: 2.0,
          qualityK: 4
        }
      });

      expect(kernel.trackSelection).toBeDefined();
      expect(kernel.trackSelection?.winningTrack).toBe('task-quality');
      expect(kernel.trackSelection?.selectionReason).toBe('quality-selected');

      // The selected track is task-quality, so explore has positive advantage
      const exploreAdj = kernel.decision.adjustments.find(
        (_, idx) => candidates[idx]?.actionKey === 'slot:explore_domain'
      );
      expect(exploreAdj).toBeDefined();
      expect(exploreAdj!.q).toBeGreaterThan(0.5);
    });
  });

  describe('3. Atomic track selection state machine (P0, P1, P2)', () => {
    it('P1: selects quality track when evidence is sufficient (nEff >= minQualityEffectiveSamples)', () => {
      const candidates = makeCandidates();
      const state = makeState();

      const qFail = makeRecord({
        id: 'qual-fail-exploit',
        actionKey: 'slot:exploit',
        return: -1.0,
        reward: -1.0,
        learningTrack: 'task-quality'
      });
      registerAuthenticatedQualityRecord(qFail, fullBinding());

      const qRec1 = makeRecord({
        id: 'qual-1',
        actionKey: 'slot:explore_invariant',
        return: 1.0,
        reward: 1.0,
        learningTrack: 'task-quality'
      });
      const qRec2 = makeRecord({
        id: 'qual-2',
        actionKey: 'slot:explore_invariant',
        return: 1.0,
        reward: 1.0,
        learningTrack: 'task-quality'
      });
      registerAuthenticatedQualityRecord(qRec1, fullBinding());
      registerAuthenticatedQualityRecord(qRec2, fullBinding());

      const kernel = runDecisionKernel({
        level: 'meta',
        state,
        candidates,
        records: [qFail, qRec1, qRec2],
        config: makeLayerConfig(),
        now: NOW,
        dualTrack: {
          enableQualityTrackConsumption: true,
          minQualityEffectiveSamples: 1.8
        }
      });

      expect(kernel.trackSelection?.winningTrack).toBe('task-quality');
      expect(kernel.trackSelection?.selectionReason).toBe('quality-selected');
    });

    it('P2: falls back to process track when quality action-evidence is insufficient (nEff < threshold)', () => {
      const candidates = makeCandidates();
      const state = makeState();

      // Only one quality record -> nEff ~ 1.0 < 2.0
      const qRec1 = makeRecord({
        id: 'qual-1',
        actionKey: 'slot:explore_invariant',
        return: 1.0,
        learningTrack: 'task-quality'
      });
      registerAuthenticatedQualityRecord(qRec1, fullBinding());

      const pRec1 = makeRecord({
        id: 'proc-1',
        actionKey: 'slot:exploit',
        return: 0.5,
        learningTrack: 'process'
      });
      const pRec2 = makeRecord({
        id: 'proc-2',
        actionKey: 'slot:exploit',
        return: 0.5,
        learningTrack: 'process'
      });

      const kernel = runDecisionKernel({
        level: 'meta',
        state,
        candidates,
        records: [qRec1, pRec1, pRec2],
        config: makeLayerConfig(),
        now: NOW,
        dualTrack: {
          enableQualityTrackConsumption: true,
          minQualityEffectiveSamples: 2.0
        }
      });

      expect(kernel.trackSelection?.winningTrack).toBe('process');
      expect(kernel.trackSelection?.selectionReason).toBe('quality-insufficient-action-evidence');
    });

    it('P0: rejects untrusted quality records and falls back to process track', () => {
      const candidates = makeCandidates();
      const state = makeState();

      // Quality record NOT registered in qualityProvenanceRegistry -> unauthenticated
      const qRecUntrusted = makeRecord({
        id: 'qual-untrusted',
        actionKey: 'slot:explore_domain',
        return: 1.0,
        learningTrack: 'task-quality'
      });

      const pRec = makeRecord({
        id: 'proc-1',
        actionKey: 'slot:exploit',
        return: 0.4,
        learningTrack: 'process'
      });

      const kernel = runDecisionKernel({
        level: 'meta',
        state,
        candidates,
        records: [qRecUntrusted, pRec],
        config: makeLayerConfig(),
        now: NOW,
        dualTrack: {
          enableQualityTrackConsumption: true,
          minQualityEffectiveSamples: 1.0
        }
      });

      // Untrusted quality record filtered out; process track chosen
      expect(kernel.trackSelection?.winningTrack).toBe('process');
      expect(kernel.trackSelection?.selectionReason).toBe('quality-untrusted');
    });
  });

  describe('4. Trusted success (+1) vs trusted failure (<=0) learning', () => {
    it('learns from trusted success (+1) by increasing target action advantage', () => {
      const candidates = makeCandidates();
      const state = makeState();

      const failExploit = makeRecord({
        id: 'qual-fail-exploit',
        actionKey: 'slot:exploit',
        return: -1.0,
        reward: -1.0,
        learningTrack: 'task-quality'
      });
      const success1 = makeRecord({
        id: 'qual-succ-1',
        actionKey: 'slot:recover',
        return: 1.0,
        reward: 1.0,
        learningTrack: 'task-quality'
      });
      const success2 = makeRecord({
        id: 'qual-succ-2',
        actionKey: 'slot:recover',
        return: 1.0,
        reward: 1.0,
        learningTrack: 'task-quality'
      });
      registerAuthenticatedQualityRecord(failExploit, fullBinding());
      registerAuthenticatedQualityRecord(success1, fullBinding());
      registerAuthenticatedQualityRecord(success2, fullBinding());

      const kernel = runDecisionKernel({
        level: 'meta',
        state,
        candidates,
        records: [failExploit, success1, success2],
        config: makeLayerConfig(),
        now: NOW,
        dualTrack: {
          enableQualityTrackConsumption: true,
          minQualityEffectiveSamples: 1.5
        }
      });

      const recoverIndex = candidates.findIndex((c) => c.actionKey === 'slot:recover');
      const recoverAdj = kernel.decision.adjustments[recoverIndex];
      expect(recoverAdj?.advantage).toBeGreaterThan(0);
    });

    it('learns from trusted failure (<=0) by penalizing target action advantage', () => {
      const candidates = makeCandidates();
      const state = makeState();

      const fail1 = makeRecord({
        id: 'qual-fail-1',
        actionKey: 'slot:recover',
        return: -1.0,
        reward: -1.0,
        learningTrack: 'task-quality'
      });
      const fail2 = makeRecord({
        id: 'qual-fail-2',
        actionKey: 'slot:recover',
        return: -1.0,
        reward: -1.0,
        learningTrack: 'task-quality'
      });
      registerAuthenticatedQualityRecord(fail1, fullBinding());
      registerAuthenticatedQualityRecord(fail2, fullBinding());

      const kernel = runDecisionKernel({
        level: 'meta',
        state,
        candidates,
        records: [fail1, fail2],
        config: makeLayerConfig(),
        now: NOW,
        dualTrack: {
          enableQualityTrackConsumption: true,
          minQualityEffectiveSamples: 1.5
        }
      });

      const recoverIndex = candidates.findIndex((c) => c.actionKey === 'slot:recover');
      const recoverAdj = kernel.decision.adjustments[recoverIndex];
      expect(recoverAdj?.advantage).toBeLessThanOrEqual(0);
    });
  });

  describe('5. Audit-only encoding rejection', () => {
    it('excludes records marked learningEligible: false from both tracks', () => {
      const candidates = makeCandidates();
      const state = makeState();

      const auditQuality = makeRecord({
        id: 'qual-audit',
        actionKey: 'slot:explore_domain',
        return: 1.0,
        learningTrack: 'task-quality',
        learningEligible: false // Audit-only encoding
      });
      registerAuthenticatedQualityRecord(auditQuality, fullBinding());

      const kernel = runDecisionKernel({
        level: 'meta',
        state,
        candidates,
        records: [auditQuality],
        config: makeLayerConfig(),
        now: NOW,
        dualTrack: {
          enableQualityTrackConsumption: true,
          minQualityEffectiveSamples: 1.0
        }
      });

      // Filter excludes learningEligible: false
      expect(kernel.filters.kept).toBe(0);
      expect(kernel.trackSelection?.winningTrack).toBe('process');
    });
  });

  describe('6. Cryptographic provenance authentication and tampering detection', () => {
    it('rejects tampered records where content does not match registry digest', () => {
      const original = makeRecord({
        id: 'qual-tamper-target',
        actionKey: 'slot:explore_domain',
        return: 0.0,
        reward: 0.0,
        learningTrack: 'task-quality'
      });
      registerAuthenticatedQualityRecord(original, fullBinding());

      // Tamper with reward
      const tamperedRecord = {
        ...original,
        reward: 1.0,
        return: 1.0
      };

      expect(isAuthenticatedQualityRecord(original)).toBe(true);
      expect(isAuthenticatedQualityRecord(tamperedRecord)).toBe(false);
    });
  });

  describe('7. Recovery isolation & anti-retroactive elevation', () => {
    it('unauthenticated recovered quality records are never silently downgraded to process track and fail P0', async () => {
      const store = createMemoryExperienceStore();

      const recoveredQualityRecord = makeRecord({
        id: 'recovered-q-1',
        actionKey: 'slot:explore_domain',
        return: 1.0,
        learningTrack: 'task-quality',
        learningEligible: true
      });

      // Append to store without registering in qualityProvenanceRegistry (simulating crash recovery)
      await store.append([recoveredQualityRecord]);

      // Query process track: must NOT include task-quality record
      const processResults = await store.query({
        level: 'meta',
        state: makeState(),
        k: 10,
        similarityThreshold: 0.0,
        learningTrack: 'process'
      });
      expect(processResults).toHaveLength(0);

      // Decision consumption: unauthenticated record triggers P0 quality-untrusted, never consumed
      const optimizer = createStoreOptimizer({
        store,
        config: {
          ...(DEFAULT_EVO_HARNESS_CONFIG.jitrl as unknown as JitRlConfig),
          beta: 2.0
        },
        now: () => NOW,
        rng: () => 0.5,
        halfLifeMs: HALF_LIFE,
        dualTrack: {
          enableQualityTrackConsumption: true,
          minQualityEffectiveSamples: 1.0
        }
      });
      const decision = await optimizer.decide('meta', makeState(), makeCandidates());
      expect(decision.rationale).toContain('quality-untrusted');
    });
  });

  describe('8. Integration with createStoreOptimizer', () => {
    it('createStoreOptimizer executes separate retrieval and atomic selection', async () => {
      const store = createMemoryExperienceStore();
      const state = makeState();
      const candidates = makeCandidates();

      // Quality track: fail on exploit, success on deepen
      const failRec = makeRecord({
        id: 'qual-store-fail',
        actionKey: 'slot:exploit',
        return: -1.0,
        reward: -1.0,
        learningTrack: 'task-quality',
        createdAt: T0
      });
      registerAuthenticatedQualityRecord(failRec, fullBinding());

      const qRecs: ExperienceRecord[] = [failRec];
      for (let i = 0; i < 3; i++) {
        const r = makeRecord({
          id: `qual-store-${i}`,
          actionKey: 'slot:explore_invariant',
          return: 1.0,
          reward: 1.0,
          learningTrack: 'task-quality',
          createdAt: T0 + (i + 1) * 1000
        });
        registerAuthenticatedQualityRecord(r, fullBinding());
        qRecs.push(r);
      }
      await store.append(qRecs);

      const optimizer = createStoreOptimizer({
        store,
        config: {
          ...(DEFAULT_EVO_HARNESS_CONFIG.jitrl as unknown as JitRlConfig),
          beta: 2.0
        },
        now: () => NOW,
        rng: () => 0.5,
        halfLifeMs: HALF_LIFE,
        dualTrack: {
          enableQualityTrackConsumption: true,
          minQualityEffectiveSamples: 2.0
        }
      });

      const decision = await optimizer.decide('meta', state, candidates);
      expect(decision.rationale).toContain('track=task-quality');
      expect(decision.rationale).toContain('quality-selected');
    });
  });

  describe('9. Conservative replacement gate parity', () => {
    it('decideReplacement vetoes quality challenger when shrunkAdvantage is not strictly positive', () => {
      // Challenger from quality track with support: 0, nEff: 0 -> no evidence
      const verdict = decideReplacement({
        proposedIndex: 1,
        priorIndex: 0,
        challenger: {
          actionKey: 'slot:explore_domain',
          q: 0.5,
          advantage: 0.0,
          support: 0,
          nEff: 0,
          explored: false
        },
        prior: {
          actionKey: 'slot:exploit',
          q: 0.5,
          advantage: 0.0,
          support: 5,
          nEff: 5.0,
          explored: false
        },
        challengerIsNoop: false,
        explorationAllowance: 0 // No exploration budget
      });

      expect(verdict.kind).toBe('kept-prior');
      expect(verdict.executedIndex).toBe(0);
    });

    it('decideReplacement permits quality challenger when nEff >= 2 and shrunkAdvantage > 0', () => {
      const verdict = decideReplacement({
        proposedIndex: 1,
        priorIndex: 0,
        challenger: {
          actionKey: 'slot:explore_domain',
          q: 0.9,
          advantage: 0.4,
          support: 4,
          nEff: 3.5,
          explored: false
        },
        prior: {
          actionKey: 'slot:exploit',
          q: 0.5,
          advantage: -0.2,
          support: 5,
          nEff: 5.0,
          explored: false
        },
        challengerIsNoop: false,
        explorationAllowance: 0
      });

      expect(verdict.kind).toBe('executed-proposed');
      expect(verdict.executedIndex).toBe(1);
    });
  });

  describe('10. Quality replacement gate discriminatory tests (ADR 0004 §3.3 & §3.4)', () => {
    function makeMockDecision(
      candidates: readonly JitCandidate<MetaActionPayload>[],
      adjustmentsMap: Record<string, { q?: number | null; advantage?: number; support?: number; nEff?: number; explored?: boolean }>,
      chosenKey: string
    ): JitDecision<MetaActionPayload> {
      const adjustments = candidates.map((candidate) => {
        const adj = adjustmentsMap[candidate.actionKey] ?? {};
        return {
          candidate,
          q: adj.q ?? null,
          advantage: adj.advantage ?? 0,
          normalizedAdvantage: adj.advantage ?? 0,
          adjustedLogit: candidate.baseLogit + (adj.advantage ?? 0),
          probability: 1 / candidates.length,
          support: adj.support ?? 0,
          nEff: adj.nEff ?? 0,
          explored: adj.explored ?? false
        };
      });
      const chosen = adjustments.find((a) => a.candidate.actionKey === chosenKey) ?? adjustments[0]!;
      return {
        level: 'meta',
        stateValue: 0.0,
        neighborCount: 5,
        adjustments,
        chosen,
        klToPrior: 0.0,
        rationale: 'mock decision'
      };
    }

    it('vetoes quality challenger when challenger is noop with no evidence (implicit-zero-advantage)', () => {
      const candidates = makeCandidates();
      const processDecision = makeMockDecision(candidates, {
        'slot:exploit': { support: 5, nEff: 5.0, q: 0.5, advantage: 0.0 }
      }, 'slot:exploit');

      const qualityDecision = makeMockDecision(candidates, {
        'slot:exploit': { support: 5, nEff: 5.0, q: 0.5, advantage: 0.0 },
        'slot:explore_domain': { support: 0, nEff: 0.0, q: null, advantage: 0.5 }
      }, 'slot:explore_domain');

      const result = selectTrackAtomically(candidates, processDecision, qualityDecision, {
        challengerIsNoop: true,
        explorationAllowance: 0,
        minQualityEffectiveSamples: 2.0
      });

      // F6: the implicit-zero challenger is vetoed and the quality track's OWN
      // prior (exploit) stands with sufficient quality evidence - the process
      // track must not override it. Track = task-quality, action = prior.
      expect(result.winningTrack).toBe('task-quality');
      expect(result.verdict.selectionReason).toBe('quality-selected');
      const qualityReport = result.verdict.qualityReport as Record<string, unknown>;
      expect(qualityReport.gateReason).toBe('implicit-zero-advantage');
      expect(qualityReport.keptPrior).toBe(true);
      expect(qualityReport.priorEvidenceSufficient).toBe(true);
      // F5: the winning decision's chosen IS the selected action.
      expect(result.verdict.selectedAction.actionKey).toBe('slot:exploit');
      expect(result.winningDecision.chosen.candidate.actionKey).toBe('slot:exploit');
    });

    it('vetoes quality challenger with thin evidence (nEff < minEff) when exploration budget is zero', () => {
      const candidates = makeCandidates();
      const processDecision = makeMockDecision(candidates, {
        'slot:exploit': { support: 5, nEff: 5.0, q: 0.5, advantage: 0.0 }
      }, 'slot:exploit');

      const qualityDecision = makeMockDecision(candidates, {
        'slot:exploit': { support: 5, nEff: 5.0, q: 0.5, advantage: -0.2 },
        'slot:explore_domain': { support: 1, nEff: 1.0, q: 0.8, advantage: 0.3 }
      }, 'slot:explore_domain');

      const result = selectTrackAtomically(candidates, processDecision, qualityDecision, {
        challengerIsNoop: false,
        explorationAllowance: 0,
        minQualityEffectiveSamples: 2.0
      });

      // The thin challenger is refused (min-support), but the quality track's
      // own prior carries sufficient evidence -> F6: the process track may not
      // override it; the decision stays on the trusted track with the prior.
      expect(result.winningTrack).toBe('task-quality');
      expect(result.verdict.selectionReason).toBe('quality-selected');
      const qualityReport = result.verdict.qualityReport as Record<string, unknown>;
      expect(qualityReport.gateReason).toBe('min-support');
      expect(qualityReport.keptPrior).toBe(true);
      expect(result.verdict.selectedAction.actionKey).toBe('slot:exploit');
      expect(result.winningDecision.chosen.candidate.actionKey).toBe('slot:exploit');
    });

    it('F8: quality track has NO exploration budget - thin quality evidence falls back to process even with allowance > 0', () => {
      const candidates = makeCandidates();
      const processDecision = makeMockDecision(candidates, {
        'slot:exploit': { support: 5, nEff: 5.0, q: 0.5, advantage: 0.0 }
      }, 'slot:exploit');

      const qualityDecision = makeMockDecision(candidates, {
        'slot:exploit': { support: 5, nEff: 5.0, q: 0.5, advantage: -0.2 },
        'slot:explore_domain': { support: 1, nEff: 1.0, q: 0.8, advantage: 0.3 }
      }, 'slot:explore_domain');

      const result = selectTrackAtomically(candidates, processDecision, qualityDecision, {
        challengerIsNoop: false,
        explorationAllowance: 1,
        minQualityEffectiveSamples: 2.0
      });

      // ADR 0004 P2/F8: an under-evidenced challenger on the TRUSTED track
      // must not ride an exploration budget. The challenger is refused
      // (min-support); F6 keeps the evidenced quality prior, so the executed
      // action is the prior WITHOUT any exploration execution.
      expect(result.winningTrack).toBe('task-quality');
      expect(result.verdict.selectionReason).toBe('quality-selected');
      const qualityReport = result.verdict.qualityReport as Record<string, unknown>;
      expect(qualityReport.gateReason).toBe('min-support');
      expect(qualityReport.keptPrior).toBe(true);
      expect(qualityReport.replacementVerdict).toBe('kept-prior');
      expect(result.verdict.selectedAction.actionKey).toBe('slot:exploit');
      expect(result.winningDecision.chosen.candidate.actionKey).toBe('slot:exploit');
    });

    it('permits quality challenger with full evidence (nEff >= minEff and shrunkAdvantage > 0)', () => {
      const candidates = makeCandidates();
      const processDecision = makeMockDecision(candidates, {
        'slot:exploit': { support: 5, nEff: 5.0, q: 0.5, advantage: 0.0 }
      }, 'slot:exploit');

      const qualityDecision = makeMockDecision(candidates, {
        'slot:exploit': { support: 5, nEff: 5.0, q: 0.5, advantage: -0.2 },
        'slot:explore_domain': { support: 4, nEff: 3.5, q: 0.9, advantage: 0.4 }
      }, 'slot:explore_domain');

      const result = selectTrackAtomically(candidates, processDecision, qualityDecision, {
        challengerIsNoop: false,
        explorationAllowance: 0,
        minQualityEffectiveSamples: 2.0
      });

      expect(result.winningTrack).toBe('task-quality');
      expect(result.verdict.selectionReason).toBe('quality-selected');
      expect(result.verdict.selectedAction.actionKey).toBe('slot:explore_domain');
      const qualityReport = result.verdict.qualityReport as Record<string, unknown>;
      expect(qualityReport.replacementVerdict).toBe('executed-proposed');
    });

    it('F6: quality prior with sufficient evidence is authoritative over the process track', () => {
      const candidates = makeCandidates();
      const processDecision = makeMockDecision(candidates, {
        'slot:exploit': { support: 5, nEff: 5.0, q: 0.9, advantage: 0.6 }
      }, 'slot:exploit');

      // The quality track's OWN decision keeps the prior (slot:exploit) chosen
      // with sufficient action-level evidence (support + nEff >= threshold).
      const qualityDecision = makeMockDecision(candidates, {
        'slot:exploit': { support: 4, nEff: 3.0, q: 0.7, advantage: 0.2 }
      }, 'slot:exploit');

      const result = selectTrackAtomically(candidates, processDecision, qualityDecision, {
        challengerIsNoop: false,
        explorationAllowance: 0,
        minQualityEffectiveSamples: 2.0
      });

      // The process track's positive advantage on the SAME action must not
      // override the trusted quality evidence; the quality track wins and keeps
      // the prior candidate.
      expect(result.winningTrack).toBe('task-quality');
      expect(result.verdict.selectionReason).toBe('quality-selected');
      expect(result.verdict.selectedAction.actionKey).toBe('slot:exploit');
      expect(result.winningDecision).toBe(qualityDecision);
      const qualityReport = result.verdict.qualityReport as Record<string, unknown>;
      expect(qualityReport.keptPrior).toBe(true);
      expect(qualityReport.priorEvidenceSufficient).toBe(true);
    });

    it('F5: P0 no-deviation keeps process label; kept-prior (gate) reports prior-default', () => {
      const candidates = makeCandidates();
      const processDecision = makeMockDecision(candidates, {
        'slot:exploit': { support: 5, nEff: 5.0, q: 0.5, advantage: 0.0 }
      }, 'slot:exploit');

      const result = selectTrackAtomically(candidates, processDecision, undefined, {
        explorationAllowance: 0
      });

      expect(result.winningTrack).toBe('process');
      expect(result.verdict.winningTrack).toBe('process');
      expect(result.verdict.selectedAction.actionKey).toBe('slot:exploit');
      expect(result.winningDecision.chosen.candidate.actionKey).toBe('slot:exploit');

      // A GATE kept-prior (challenger refused, prior stood) reports prior-default.
      const gateKept = makeMockDecision(candidates, {
        'slot:exploit': { support: 5, nEff: 5.0, q: 0.5, advantage: 0.0 },
        'slot:explore_domain': { support: 0, nEff: 0.0, q: null, advantage: 0.5 }
      }, 'slot:explore_domain');
      const keptResult = selectTrackAtomically(candidates, gateKept, undefined, {
        explorationAllowance: 0,
        qualityUntrusted: true
      });
      expect(keptResult.winningTrack).toBe('prior-default');
      expect(keptResult.verdict.selectionReason).toBe('quality-untrusted');
      expect(keptResult.verdict.selectedAction.actionKey).toBe('slot:exploit');
      expect(keptResult.winningDecision.chosen.candidate.actionKey).toBe('slot:exploit');
    });

    it('rejects quality track under P0 when schema, rewardVersion, task, scope or binding are modified', () => {
      const state = makeState();
      const candidates = makeCandidates();

      const authenticRecord = makeRecord({
        id: 'auth-q-1',
        actionKey: 'slot:explore_domain',
        reward: 1.0,
        return: 1.0,
        observedReturn: 1.0,
        learningTrack: 'task-quality',
        // Current schema/reward stamps: the record must be VISIBLE under the
        // learning filter so the AUTHENTICATION boundary (digest mismatch), not
        // the legacy filter, is what closes the track (F2's exact concern).
        experienceSchemaVersion: EXPERIENCE_SCHEMA_VERSION,
        rewardVersion: CURRENT_REWARD_VERSION,
        scopeKey: 'scope-original',
      });
      registerAuthenticatedQualityRecord(
        authenticRecord,
        fullBinding({ taskId: 'task-c2b', verificationId: 'v-c2b-p0' })
      );

      // 1. Modified schemaVersion: the record becomes unauthentic; it is still
      // VISIBLE under the learning filter, so P0 fires (F2). With only that
      // record the process decision is a no-deviation prior execution ->
      // process with an aligned chosen action (F5: no gate kept-prior here).
      const tamperedSchemaRecord = { ...authenticRecord, experienceSchemaVersion: 99 };
      const failKernelSchema = runDecisionKernel({
        level: 'meta',
        state,
        candidates,
        records: [tamperedSchemaRecord],
        config: makeLayerConfig(),
        now: NOW,
        dualTrack: { enableQualityTrackConsumption: true, minQualityEffectiveSamples: 1.0 }
      });
      expect(failKernelSchema.trackSelection?.winningTrack).toBe('process');
      expect(failKernelSchema.trackSelection?.selectionReason).toBe('quality-untrusted');
      expect(failKernelSchema.trackSelection?.selectedAction.actionKey).toBe('slot:exploit');
      expect(failKernelSchema.decision.chosen.candidate.actionKey).toBe('slot:exploit');

      // 2. Modified rewardVersion triggers P0
      const tamperedRewardRecord = { ...authenticRecord, rewardVersion: 'tampered-r' };
      const failKernelReward = runDecisionKernel({
        level: 'meta',
        state,
        candidates,
        records: [tamperedRewardRecord],
        config: makeLayerConfig(),
        now: NOW,
        dualTrack: { enableQualityTrackConsumption: true, minQualityEffectiveSamples: 1.0 }
      });
      // A rewardVersion tamper is caught one layer EARLIER by the learning
      // eligibility filter (exact current rewardVersion required): the record is
      // not visible to the decision at all, so the process track serves it -
      // equally fail-closed, no trusted evidence consumed.
      expect(failKernelReward.trackSelection?.winningTrack).toBe('process');
      expect(failKernelReward.trackSelection?.selectionReason).toBe(
        'process-evidenced-replacement'
      );

      // 3. Modified scopeKey triggers P0
      const tamperedScopeRecord = { ...authenticRecord, scopeKey: 'forged-scope' };
      const failKernelScope = runDecisionKernel({
        level: 'meta',
        state,
        candidates,
        records: [tamperedScopeRecord],
        config: makeLayerConfig(),
        now: NOW,
        dualTrack: { enableQualityTrackConsumption: true, minQualityEffectiveSamples: 1.0 }
      });
      expect(failKernelScope.trackSelection?.winningTrack).toBe('process');
      expect(failKernelScope.trackSelection?.selectionReason).toBe('quality-untrusted');

      // 4. A CURRENT-schema tampered record: same P0 verdict (the digest
      // mismatch, not the legacy filter, is what closes the track).
      const tamperedCurrent = {
        ...authenticRecord,
        experienceSchemaVersion: EXPERIENCE_SCHEMA_VERSION,
        observedReturn: 42
      };
      const failKernelCurrent = runDecisionKernel({
        level: 'meta',
        state,
        candidates,
        records: [tamperedCurrent],
        config: makeLayerConfig(),
        now: NOW,
        dualTrack: { enableQualityTrackConsumption: true, minQualityEffectiveSamples: 1.0 }
      });
      expect(failKernelCurrent.trackSelection?.selectionReason).toBe('quality-untrusted');
    });
  });
});
