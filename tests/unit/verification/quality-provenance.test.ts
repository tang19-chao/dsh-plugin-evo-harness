/**
 * C2b (ADR 0004 §2.3 + C2b independent review F2/F3/F4/F11): unit tests for the
 * host-authenticated quality record provenance, the v3 canonical digest, the
 * complete-binding requirement, and the per-(runId, recordId) registry.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  ARTIFACT_DIGEST_SHAPE,
  clearQualityRecordRegistry,
  computeQualityRecordDigest,
  isAuthenticatedQualityRecord,
  isCompleteQualityBinding,
  missingQualityBindingFields,
  qualityProvenanceRegistry,
  registerAuthenticatedQualityRecord,
  unregisterAuthenticatedQualityRecord,
  type QualityProvenanceContext
} from '../../../src/verification/quality-provenance';
import type { ExperienceRecord } from '../../../src/types/contracts';

const T0 = 1_700_000_000_000;

/** A complete host binding: every member present, artifact digest sha256:64hex. */
function fullContext(overrides: Partial<QualityProvenanceContext> = {}): QualityProvenanceContext {
  return {
    artifactDigest: 'sha256:' + 'a'.repeat(64),
    verifierId: 'runner-1',
    verifierVersion: '1.0.0',
    verificationId: 'v-1',
    testSetId: 'ts-1',
    envId: 'env-node',
    runId: 'run-1',
    sessionId: 'session-1',
    trajectoryId: 'traj-1',
    taskId: 'task-123',
    role: 'candidate',
    ...overrides
  };
}

function createSampleRecord(overrides: Partial<ExperienceRecord> = {}): ExperienceRecord {
  return {
    id: 'exp-qual-1',
    level: 'meta',
    state: { bucket: 'b1', level: 'meta', tokens: ['tokA', 'tokB'], summary: 'test-summary-secret' },
    actionKey: 'slot:invariant',
    reward: 1.0,
    return: 1.0,
    observedReturn: 1.0,
    learningTrack: 'task-quality',
    learningEligible: true,
    guidance: 'guidance_free',
    rewardSources: {
      outcomeEligible: 1,
      verificationVerdict: 1,
      verificationTrusted: 1,
      verificationAuditOnly: 0
    },
    trajectoryId: 'traj-1',
    runId: 'run-1',
    sessionId: 'session-1',
    policyId: 'policy-1',
    treeId: 'tree-1',
    experienceSchemaVersion: 1,
    rewardVersion: 'reward-v1',
    provenanceVersion: 'prov-v1',
    createdAt: T0,
    redacted: true,
    ...overrides
  };
}

describe('C2b Quality Provenance & Content Digest Authentication (v3)', () => {
  beforeEach(() => {
    clearQualityRecordRegistry();
  });

  describe('canonical digest framing (F3)', () => {
    it('computes deterministic content digest over canonical fields', () => {
      const digest1 = computeQualityRecordDigest(createSampleRecord(), fullContext());
      const digest2 = computeQualityRecordDigest(createSampleRecord(), fullContext());
      expect(digest1).toBe(digest2);
      expect(digest1.startsWith('sha256:')).toBe(true);
    });

    it('changes content digest if tokens are in different order (order-normalized)', () => {
      const rec1 = createSampleRecord({ state: { bucket: 'b1', level: 'meta', tokens: ['tokA', 'tokB'], summary: 'test' } });
      const rec2 = createSampleRecord({ state: { bucket: 'b1', level: 'meta', tokens: ['tokB', 'tokA'], summary: 'test' } });
      expect(computeQualityRecordDigest(rec1, fullContext())).toBe(computeQualityRecordDigest(rec2, fullContext()));
    });

    it('preserves privacy: state summary text is excluded from content digest', () => {
      const rec1 = createSampleRecord({ state: { bucket: 'b1', level: 'meta', tokens: ['tokA'], summary: 'sensitive prompt text 1' } });
      const rec2 = createSampleRecord({ state: { bucket: 'b1', level: 'meta', tokens: ['tokA'], summary: 'sensitive prompt text 2' } });
      expect(computeQualityRecordDigest(rec1, fullContext())).toBe(computeQualityRecordDigest(rec2, fullContext()));
    });

    it.each([
      ['observedReturn', { observedReturn: 999 }],
      ['return', { return: -3.5 }],
      ['reward', { reward: 2.25 }],
      ['createdAt', { createdAt: T0 + 987_654 }],
      ['guidance', { guidance: 'memory' as const }],
      ['learningTarget', { learningTarget: 0.75 }],
      ['attributionBaseline', { attributionBaseline: 0.5 }],
      ['outcome', { outcome: 'succeeded' as const }],
      ['decisionId', { decisionId: 'd-42' }],
      ['experienceSchemaVersion', { experienceSchemaVersion: 99 }],
      ['rewardVersion', { rewardVersion: 'reward-vX' }],
      ['provenanceVersion', { provenanceVersion: 'prov-vX' }],
      ['sessionId', { sessionId: 'session-2' }],
      ['treeId', { treeId: 'tree-2' }],
      ['scopeKey', { scopeKey: 'scope-2' }],
      ['trajectoryId', { trajectoryId: 'traj-2' }],
      ['runId', { runId: 'run-2' }],
      ['policyId', { policyId: 'policy-2' }]
    ])('digest changes when %s is tampered', (_field, overrides) => {
      const base = createSampleRecord();
      const tampered = createSampleRecord(overrides);
      expect(computeQualityRecordDigest(base, fullContext())).not.toBe(
        computeQualityRecordDigest(tampered, fullContext())
      );
    });

    it('digest changes when a rewardSources entry is added, removed or altered', () => {
      const base = createSampleRecord();
      const added = createSampleRecord({ rewardSources: { ...base.rewardSources, tool: 0.5 } });
      const altered = createSampleRecord({
        rewardSources: { outcomeEligible: 1, verificationVerdict: 1, verificationTrusted: 1, verificationAuditOnly: 1 }
      });
      const baseDigest = computeQualityRecordDigest(base, fullContext());
      expect(computeQualityRecordDigest(added, fullContext())).not.toBe(baseDigest);
      expect(computeQualityRecordDigest(altered, fullContext())).not.toBe(baseDigest);
    });

    it('digest is insertion-order independent for rewardSources (canonical JSON)', () => {
      const left = createSampleRecord({
        rewardSources: { outcomeEligible: 1, verificationTrusted: 1, verificationVerdict: 1, verificationAuditOnly: 0 }
      });
      const right = createSampleRecord();
      expect(computeQualityRecordDigest(left, fullContext())).toBe(
        computeQualityRecordDigest(right, fullContext())
      );
    });

    it('digest covers every member of the host binding', () => {
      const base = createSampleRecord();
      const baseDigest = computeQualityRecordDigest(base, fullContext());
      for (const field of [
        'artifactDigest',
        'verifierId',
        'verifierVersion',
        'verificationId',
        'testSetId',
        'envId',
        'runId',
        'sessionId',
        'trajectoryId',
        'taskId',
        'role'
      ] as const) {
        const tamperedContext = fullContext({ [field]: field + '-tampered' });
        expect(computeQualityRecordDigest(base, tamperedContext)).not.toBe(baseDigest);
      }
    });
  });

  describe('complete host binding requirement (F11)', () => {
    it('accepts a complete binding and rejects every partial one', () => {
      expect(isCompleteQualityBinding(fullContext())).toBe(true);
      const complete = fullContext();
      for (const field of [
        'artifactDigest',
        'verifierId',
        'verifierVersion',
        'verificationId',
        'testSetId',
        'envId',
        'runId',
        'sessionId',
        'trajectoryId',
        'taskId',
        'role'
      ] as const) {
        const partial: Record<string, unknown> = { ...complete };
        delete partial[field];
        expect(isCompleteQualityBinding(partial as unknown as QualityProvenanceContext)).toBe(false);
        expect(missingQualityBindingFields(partial as unknown as QualityProvenanceContext)).toContain(field);
      }
      expect(isCompleteQualityBinding(undefined)).toBe(false);
    });

    it('rejects a non-sha256:64hex artifact digest shape', () => {
      const short = fullContext({ artifactDigest: 'sha256:abc123' });
      const fnv = fullContext({ artifactDigest: 'fnv1a:deadbeef' });
      const prefixless = fullContext({ artifactDigest: 'a'.repeat(64) });
      const uppercase = fullContext({ artifactDigest: 'sha256:' + 'A'.repeat(64) });
      expect(ARTIFACT_DIGEST_SHAPE.test(short.artifactDigest ?? '')).toBe(false);
      expect(isCompleteQualityBinding(short)).toBe(false);
      expect(isCompleteQualityBinding(fnv)).toBe(false);
      expect(isCompleteQualityBinding(prefixless)).toBe(false);
      expect(isCompleteQualityBinding(uppercase)).toBe(false);
    });

    it('register throws on an incomplete binding instead of minting trust', () => {
      const rec = createSampleRecord();
      expect(() => registerAuthenticatedQualityRecord(rec)).toThrow(TypeError);
      expect(() =>
        registerAuthenticatedQualityRecord(rec, {
          artifactDigest: 'sha256:' + 'a'.repeat(64),
          verifierId: 'runner-1'
        })
      ).toThrow(TypeError);
      expect(qualityProvenanceRegistry.size()).toBe(0);
    });

    it('register throws when the record runId is missing or contradicts the binding', () => {
      const noRun = createSampleRecord({ runId: undefined });
      expect(() => registerAuthenticatedQualityRecord(noRun, fullContext())).toThrow(/runId/);
      const wrongRun = createSampleRecord({ runId: 'run-other' });
      expect(() => registerAuthenticatedQualityRecord(wrongRun, fullContext())).toThrow(/runId/);
      const wrongSession = createSampleRecord({ sessionId: 'session-other' });
      expect(() => registerAuthenticatedQualityRecord(wrongSession, fullContext())).toThrow(/sessionId/);
      expect(qualityProvenanceRegistry.size()).toBe(0);
    });
  });

  describe('registry lifecycle (F2/F4)', () => {
    it('registers an authentic quality record in the active run with full host binding', () => {
      const rec = createSampleRecord();
      const digest = registerAuthenticatedQualityRecord(rec, fullContext());
      expect(digest.startsWith('sha256:')).toBe(true);
      expect(qualityProvenanceRegistry.size()).toBe(1);
      expect(isAuthenticatedQualityRecord(rec)).toBe(true);
      expect(qualityProvenanceRegistry.getEntry('exp-qual-1', 'run-1')).toBeDefined();
      expect(qualityProvenanceRegistry.getEntry('exp-qual-1', 'run-other')).toBeUndefined();
    });

    it('rejects an unregistered record (e.g. restored from disk across restart without registration)', () => {
      const rec = createSampleRecord();
      // Not registered
      expect(isAuthenticatedQualityRecord(rec)).toBe(false);
    });

    it('a same-id record from ANOTHER run never authenticates (cross-run identity)', () => {
      const recRunA = createSampleRecord({ id: 'counter-1', runId: 'run-A' });
      registerAuthenticatedQualityRecord(recRunA, fullContext({ runId: 'run-A' }));
      expect(isAuthenticatedQualityRecord(recRunA)).toBe(true);

      // A different run registering the same deterministic id EVICTS the first
      // run's registration (one authoritative registration per record id, F4),
      // so the old-run record is no longer trusted evidence.
      const recRunB = createSampleRecord({ id: 'counter-1', runId: 'run-B', reward: 5, return: 5, observedReturn: 5 });
      registerAuthenticatedQualityRecord(recRunB, fullContext({ runId: 'run-B' }));
      expect(isAuthenticatedQualityRecord(recRunA)).toBe(false);
      expect(isAuthenticatedQualityRecord(recRunB)).toBe(true);
      expect(qualityProvenanceRegistry.size()).toBe(1);
      expect(qualityProvenanceRegistry.getEntry('counter-1', 'run-B')?.supersededRuns).toEqual(['run-A']);
      // And a same-id record WITHOUT a run identity (restored shape) is foreign.
      expect(isAuthenticatedQualityRecord({ ...recRunA, runId: undefined } as unknown as ExperienceRecord)).toBe(false);
    });

    it('re-registering the same (runId, id) replaces the entry and cleans the digest index (F4)', () => {
      const rec = createSampleRecord({ id: 'online-evo-1' });
      registerAuthenticatedQualityRecord(rec, fullContext());
      const firstDigest = qualityProvenanceRegistry.getEntry('online-evo-1', 'run-1')?.digest;
      expect(firstDigest).toBeDefined();

      const rewritten = createSampleRecord({
        id: 'online-evo-1',
        reward: 2,
        return: 2,
        observedReturn: 2,
        createdAt: T0 + 10_000
      });
      registerAuthenticatedQualityRecord(rewritten, fullContext());
      // The old content is no longer authentic under the new registration...
      expect(isAuthenticatedQualityRecord(rec)).toBe(false);
      expect(isAuthenticatedQualityRecord(rewritten)).toBe(true);
      // ...and the superseded digest is GONE from the audit index, not stale.
      expect(qualityProvenanceRegistry.registeredDigests()).toHaveLength(1);
      expect(qualityProvenanceRegistry.registeredDigests()[0]).not.toBe(firstDigest);
    });

    it('unregister removes exactly one (runId, id) registration (register-on-success rollback)', () => {
      const keep = createSampleRecord({ id: 'keep-1' });
      const drop = createSampleRecord({ id: 'drop-1' });
      registerAuthenticatedQualityRecord(keep, fullContext());
      registerAuthenticatedQualityRecord(drop, fullContext());
      expect(unregisterAuthenticatedQualityRecord('drop-1', 'run-1')).toBe(true);
      expect(unregisterAuthenticatedQualityRecord('drop-1', 'run-1')).toBe(false);
      expect(isAuthenticatedQualityRecord(keep)).toBe(true);
      expect(isAuthenticatedQualityRecord(drop)).toBe(false);
      expect(qualityProvenanceRegistry.size()).toBe(1);
    });

    it('clears all registrations upon registry reset (lifecycle isolation)', () => {
      const rec = createSampleRecord();
      registerAuthenticatedQualityRecord(rec, fullContext());
      expect(isAuthenticatedQualityRecord(rec)).toBe(true);

      clearQualityRecordRegistry();
      expect(qualityProvenanceRegistry.size()).toBe(0);
      expect(qualityProvenanceRegistry.registeredDigests()).toHaveLength(0);
      expect(isAuthenticatedQualityRecord(rec)).toBe(false);
    });
  });

  describe('tamper evidence', () => {
    it('detects tampering with reward or return or observedReturn', () => {
      const rec = createSampleRecord({ reward: -1.0, return: -1.0, observedReturn: -1.0 });
      registerAuthenticatedQualityRecord(rec, fullContext());
      expect(isAuthenticatedQualityRecord(rec)).toBe(true);

      expect(isAuthenticatedQualityRecord({ ...rec, reward: 1.0 })).toBe(false);
      expect(isAuthenticatedQualityRecord({ ...rec, return: 1.0 })).toBe(false);
      expect(isAuthenticatedQualityRecord({ ...rec, observedReturn: 1.0 })).toBe(false);
    });

    it('detects tampering with createdAt and guidance (F3 causal/guidance fields)', () => {
      const rec = createSampleRecord({ guidance: 'memory' });
      registerAuthenticatedQualityRecord(rec, fullContext());
      expect(isAuthenticatedQualityRecord(rec)).toBe(true);
      expect(isAuthenticatedQualityRecord({ ...rec, createdAt: T0 + 999_999_999 })).toBe(false);
      expect(isAuthenticatedQualityRecord({ ...rec, guidance: 'guidance_free' })).toBe(false);
    });

    it('detects tampering with actionKey', () => {
      const rec = createSampleRecord();
      registerAuthenticatedQualityRecord(rec, fullContext());

      const tampered = { ...rec, actionKey: 'slot:other' };
      expect(isAuthenticatedQualityRecord(tampered)).toBe(false);
    });

    it('detects tampering with state tokens or bucket', () => {
      const rec = createSampleRecord();
      registerAuthenticatedQualityRecord(rec, fullContext());

      const tamperedBucket = { ...rec, state: { ...rec.state, bucket: 'b2' } };
      expect(isAuthenticatedQualityRecord(tamperedBucket)).toBe(false);

      const tamperedTokens = { ...rec, state: { ...rec.state, tokens: ['tokA', 'tokX'] } };
      expect(isAuthenticatedQualityRecord(tamperedTokens)).toBe(false);
    });

    it('detects tampering with experienceSchemaVersion or rewardVersion', () => {
      const rec = createSampleRecord({ experienceSchemaVersion: 1, rewardVersion: 'r4-exact' });
      registerAuthenticatedQualityRecord(rec, fullContext());
      expect(isAuthenticatedQualityRecord(rec)).toBe(true);

      expect(isAuthenticatedQualityRecord({ ...rec, experienceSchemaVersion: 2 })).toBe(false);
      expect(isAuthenticatedQualityRecord({ ...rec, rewardVersion: 'r3-legacy' })).toBe(false);
    });

    it('detects tampering with taskId, sessionId, treeId or scopeKey', () => {
      const rec = createSampleRecord({ sessionId: 'session-1', treeId: 'tree-A', scopeKey: 'scope-A' });
      registerAuthenticatedQualityRecord(rec, fullContext({ taskId: 'task-123' }));
      expect(isAuthenticatedQualityRecord(rec)).toBe(true);

      expect(isAuthenticatedQualityRecord({ ...rec, sessionId: 'sess-B' })).toBe(false);
      expect(isAuthenticatedQualityRecord({ ...rec, treeId: 'tree-B' })).toBe(false);
      expect(isAuthenticatedQualityRecord({ ...rec, scopeKey: 'scope-B' })).toBe(false);
      expect(isAuthenticatedQualityRecord({ ...rec, taskId: 'task-fake' } as ExperienceRecord)).toBe(false);
    });

    it('rejects a record whose content no longer matches its registered binding identities', () => {
      const rec = createSampleRecord();
      registerAuthenticatedQualityRecord(rec, fullContext());
      // Any identity-field drift vs the binding invalidates authentication even
      // when the digest framing itself did not change.
      expect(isAuthenticatedQualityRecord({ ...rec, trajectoryId: 'traj-other' })).toBe(false);
      expect(isAuthenticatedQualityRecord({ ...rec, taskId: 'task-other' })).toBe(false);
    });

    it('rejects if verification marks are not trusted', () => {
      const rec = createSampleRecord({
        rewardSources: {
          outcomeEligible: 1,
          verificationVerdict: 1,
          verificationTrusted: 0 // Not trusted!
        }
      });
      registerAuthenticatedQualityRecord(rec, fullContext());
      expect(isAuthenticatedQualityRecord(rec)).toBe(false);
    });

    it('rejects if learningEligible is false (audit-only)', () => {
      const rec = createSampleRecord({ learningEligible: false });
      registerAuthenticatedQualityRecord(rec, fullContext());
      expect(isAuthenticatedQualityRecord(rec)).toBe(false);
    });
  });
});
