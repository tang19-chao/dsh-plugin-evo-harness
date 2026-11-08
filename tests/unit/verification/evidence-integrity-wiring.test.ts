/**
 * rev8 evidence-integrity trio — the ORCHESTRATOR-LEVEL wiring contracts
 * (audit fixes W3/W4).
 *
 * These are the two places the audit found a CONSUMER WITHOUT A PRODUCER, and
 * one place where the consumer's input field did not exist:
 *
 *   W3  `judgeWriteback` declared 9 refusal codes, but the recorder never put
 *       `contaminated` into the signals object and never persisted a
 *       contamination mark, so the ninth code had no producer. The tests below
 *       pin the persisted SCALAR encoding (`evidenceContaminated: 1`) and the
 *       exact verdict both routes must produce.
 *   W4  `isVerifiedTree` read `tree.metadata.evidenceIntegrity`, but nothing
 *       wrote that key. The tests below pin the aggregation helper, the
 *       additive snapshot shape, and the fact that the tree-level mark
 *       OUTRANKS a node-level verified block.
 *
 * The marks fed to the helpers here are produced by the REAL
 * `TrajectoryCollector` / `scanPatchEvidenceIntegrity` under a REAL policy —
 * not hand-written literals — so "mark present" and "mark forged-free" are the
 * same shape the production collectors emit.
 */
import { describe, expect, it } from 'vitest';
import { TrajectoryCollector } from '../../../src/cordis-seams/trajectory-collector';
import {
  EVIDENCE_INTEGRITY_VERSION,
  readEvidenceIntegrityMark,
  type EvidenceIntegrityMark
} from '../../../src/verification/evidence-integrity';
import {
  judgeWriteback,
  writebackHistoryEntryOf,
  writebackIntegrityViewOf,
  writebackRefusalCode,
  type WritebackGateTrajectoryView,
  type WritebackHistoryEntry
} from '../../../src/jitrl/writeback-gate';
import { indexWritebackHistory } from '../../../src/jitrl/writeback-gate';
import {
  snapshotWithEvidenceIntegrityMark,
  treeEvidenceIntegrityMark
} from '../../../src/orchestrator';
import { DREAM_EVIDENCE_STRATEGY, isVerifiedTree } from '../../../src/dream-rsi/verified-tree-gate';
import type { DiscoveryNode, DiscoveryTreeSnapshot } from '../../../src/types/contracts';

// ---------------------------------------------------------------------------
// a REAL mark from a REAL collector (sentinel route: needs no answer key)
// ---------------------------------------------------------------------------

function realSentinelMark(): EvidenceIntegrityMark {
  const collector = new TrajectoryCollector({
    id: 'traj-ei',
    sessionId: 'sess-ei',
    branchId: 'br-ei',
    branchNamespace: 'ns-ei',
    role: 'candidate',
    patch: {
      id: 'patch-ei',
      sessionId: 'sess-ei',
      branchId: 'br-ei',
      origin: 'domain',
      guidance: 'memory',
      purpose: 'explore',
      label: 'probe patch',
      rationale: 'test fixture',
      edits: {},
      createdAt: 1_000
    },
    now: () => 1_000,
    // Even an EMPTY policy arms the unconditional sentinel scan.
    evidenceIntegrity: {}
  });
  const trajectory = collector.finalize({
    status: 'succeeded',
    endedAt: 1_100,
    result: {
      status: 'succeeded',
      deliverable: { content: '(no trajectory: renderer produced no events)', format: 'text' }
    }
  });
  const mark = readEvidenceIntegrityMark(trajectory.metadata);
  expect(mark, 'the real collector must have persisted a mark').toBeDefined();
  return mark as EvidenceIntegrityMark;
}

// ---------------------------------------------------------------------------
// W4: tree-level aggregation
// ---------------------------------------------------------------------------

/** A snapshot whose one scored node carries a fully trusted evidence block. */
function verifiedSnapshot(): DiscoveryTreeSnapshot {
  return {
    id: 'tree-verified',
    sessionId: 'sess-ei',
    taskId: 'task-ei',
    rootId: 'node-1',
    nodes: {
      'node-1': {
        id: 'node-1',
        treeId: 'tree-verified',
        parentId: null,
        depth: 0,
        branchId: 'br-1',
        patchId: 'patch-1',
        patchOrigin: 'domain',
        purpose: 'explore',
        guidance: 'memory',
        status: 'succeeded',
        score: 0.9,
        childIds: [],
        createdAt: 1,
        updatedAt: 1,
        metadata: {
          dreamEvidence: {
            verdict: 'passed',
            trusted: true,
            dreamScore: 0.9,
            strategy: DREAM_EVIDENCE_STRATEGY,
            verifierId: 'host-verifier',
            evidenceHash: 'sha256:evidence'
          }
        }
      }
    },
    stats: { nodeCount: 1, maxDepth: 0, maxWidth: 1, scoredNodes: 1, completedNodes: 1 },
    completed: true,
    createdAt: 1,
    updatedAt: 1
  };
}

describe('W4: treeEvidenceIntegrityMark aggregates only real, contaminated marks', () => {
  it('returns undefined when no trajectory carries a contaminated mark (clean shape preserved)', () => {
    expect(treeEvidenceIntegrityMark([])).toBeUndefined();
    // A trajectory with no metadata at all (the pre-rev8 shape).
    expect(treeEvidenceIntegrityMark([{ metadata: undefined } as never])).toBeUndefined();
    // A trajectory whose metadata carries an unrelated bag.
    expect(treeEvidenceIntegrityMark([{ metadata: { diagnostics: ['x'] } } as never])).toBeUndefined();
  });

  it('returns undefined for a mark that reads as absent (version mismatch is not trust)', () => {
    const forged = {
      metadata: {
        evidenceIntegrity: {
          version: 'rev9-future',
          contaminated: true,
          withheld: true,
          findings: []
        }
      }
    };
    expect(treeEvidenceIntegrityMark([forged as never])).toBeUndefined();
  });

  it('carries the real finding detail (kinds and paths, never matched words)', () => {
    const mark = realSentinelMark();
    const aggregated = treeEvidenceIntegrityMark([{ metadata: { evidenceIntegrity: mark } } as never]);
    expect(aggregated?.version).toBe(EVIDENCE_INTEGRITY_VERSION);
    expect(aggregated?.contaminated).toBe(true);
    expect(aggregated?.withheld).toBe(true);
    expect(aggregated?.findings.map((finding) => finding.kind)).toEqual([
      'missing-trajectory-sentinel'
    ]);
  });

  it('merges findings from several trajectories (reference contamination stays visible)', () => {
    const first = realSentinelMark();
    const second: EvidenceIntegrityMark = {
      ...first,
      findings: [
        { kind: 'answer-key-path', location: 'patch', collidingPath: 'skills/tests/SKILL.md' }
      ]
    };
    const aggregated = treeEvidenceIntegrityMark([
      { metadata: { evidenceIntegrity: first } } as never,
      { metadata: { evidenceIntegrity: second } } as never,
      { metadata: undefined } as never
    ]);
    expect(aggregated?.findings.map((finding) => finding.kind)).toEqual([
      'missing-trajectory-sentinel',
      'answer-key-path'
    ]);
  });
});

describe('W4: the snapshot mark is additive and outranks node-level verification', () => {
  it('a branch-supplied "clean" declaration in result.metadata is not a scan input', () => {
    // The trust direction the audit demands: the scan inputs are HOST-owned.
    // A branch that claims its own evidence is clean cannot suppress the scan,
    // and the persisted mark is the collector's, not the branch's.
    const criteria = [
      {
        id: 'host-1',
        text: 'the reconciliation ledger must record every disputed invoice line verbatim including the reversal timestamp and the operator initials'
      },
      {
        id: 'host-2',
        text: 'the migration script must abort before writing whenever the checksum manifest disagrees with the fetched artifact digest'
      }
    ];
    const collector = new TrajectoryCollector({
      id: 'traj-forged-clean',
      sessionId: 'sess-forged',
      branchId: 'br-forged',
      branchNamespace: 'ns-forged',
      role: 'candidate',
      patch: {
        id: 'patch-forged',
        sessionId: 'sess-forged',
        branchId: 'br-forged',
        origin: 'domain',
        guidance: 'memory',
        purpose: 'explore',
        label: 'probe patch',
        rationale: 'test fixture',
        edits: {},
        createdAt: 1_000
      },
      now: () => 1_000,
      evidenceIntegrity: { answerKey: { criteria, visibleText: [] } }
    });
    const trajectory = collector.finalize({
      status: 'succeeded',
      endedAt: 1_100,
      result: {
        status: 'succeeded',
        steps: [{ index: 0, at: 1_000, kind: 'model', text: 'ok' }],
        deliverable: { content: criteria.map((entry) => entry.text).join('\n'), format: 'text' },
        metadata: {
          evidenceIntegrity: {
            version: EVIDENCE_INTEGRITY_VERSION,
            contaminated: false,
            withheld: false,
            findings: []
          }
        }
      }
    });

    const mark = readEvidenceIntegrityMark(trajectory.metadata);
    expect(mark?.contaminated).toBe(true);
    expect(mark?.findings.map((finding) => finding.kind)).toContain('answer-key-text');
    // The forged "clean" declaration is not copied anywhere: the persisted mark
    // is the host-armed scan's own verdict.
    expect(mark?.findings.length).toBeGreaterThan(0);
  });

  it('leaves the snapshot byte-identical when the mark is absent (no metadata key added)', () => {
    const snapshot = verifiedSnapshot();
    expect(snapshotWithEvidenceIntegrityMark(snapshot, undefined)).toBe(snapshot);
    expect(snapshotWithEvidenceIntegrityMark(snapshot, undefined).metadata).toBeUndefined();
  });

  it('preserves existing metadata while adding the mark', () => {
    const snapshot: DiscoveryTreeSnapshot = {
      ...verifiedSnapshot(),
      metadata: { anchorNodeId: 'node-1', prefixOnly: true }
    };
    const marked = snapshotWithEvidenceIntegrityMark(snapshot, realSentinelMark());
    expect(marked.metadata?.['anchorNodeId']).toBe('node-1');
    expect(marked.metadata?.['prefixOnly']).toBe(true);
    expect(readEvidenceIntegrityMark(marked.metadata)?.contaminated).toBe(true);
  });

  it('the verified-tree gate refuses a tree whose mark is contaminated even when its node block is trusted', () => {
    const snapshot = verifiedSnapshot();
    // Baseline: without a tree-level mark this snapshot IS a verified tree.
    expect(isVerifiedTree(snapshot, { trustedProducers: new Set(['host-verifier']) })).toBe(true);

    const marked = snapshotWithEvidenceIntegrityMark(snapshot, realSentinelMark());
    expect(isVerifiedTree(marked, { trustedProducers: new Set(['host-verifier']) })).toBe(false);
  });

  it('a node-level `contaminated: true` evidence block is refused on its own (dreamEvidenceFor propagation)', () => {
    const snapshot = verifiedSnapshot();
    const trustedBlock = (snapshot.nodes['node-1']?.metadata?.['dreamEvidence'] ?? {}) as Record<
      string,
      unknown
    >;
    const baseNode = snapshot.nodes['node-1'] as DiscoveryNode;
    const contaminatedNode: DiscoveryTreeSnapshot = {
      ...snapshot,
      nodes: {
        'node-1': {
          ...baseNode,
          metadata: {
            dreamEvidence: { ...trustedBlock, contaminated: true }
          }
        }
      }
    };
    // Same trusted verdict/score/producer — only the propagated contamination
    // flag differs, and that is enough to exclude the node from evidence.
    expect(isVerifiedTree(contaminatedNode, { trustedProducers: new Set(['host-verifier']) })).toBe(
      false
    );
    // A non-boolean flag is not a fact: the block reads as absent, so it cannot
    // verify either (fail-closed, never "truthy means contaminated only").
    const malformed: DiscoveryTreeSnapshot = {
      ...snapshot,
      nodes: {
        'node-1': {
          ...baseNode,
          metadata: { dreamEvidence: { ...trustedBlock, contaminated: 'yes' } }
        }
      }
    };
    expect(isVerifiedTree(malformed, { trustedProducers: new Set(['host-verifier']) })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// W3: the write-back gate's contamination input and history encoding
// ---------------------------------------------------------------------------

function view(overrides: Partial<WritebackGateTrajectoryView> = {}): WritebackGateTrajectoryView {
  return {
    actionKey: 'action-1',
    trustedSource: true,
    verificationStatus: 'passed',
    verifierRewardMismatch: false,
    forceAuditOnly: false,
    recordLearningEligible: true,
    ...overrides
  };
}

function history(entries: readonly WritebackHistoryEntry[]) {
  return indexWritebackHistory(entries);
}

describe('W3: writebackIntegrityViewOf reads the collector mark (never a branch claim)', () => {
  it('projects a real contaminated mark to `contaminated: true`', () => {
    const mark = realSentinelMark();
    expect(writebackIntegrityViewOf({ metadata: { evidenceIntegrity: mark } })).toEqual({
      contaminated: true
    });
  });

  it('projects an absent or unreadable mark to `contaminated: false`', () => {
    expect(writebackIntegrityViewOf({ metadata: undefined })).toEqual({ contaminated: false });
    expect(
      writebackIntegrityViewOf({
        metadata: { evidenceIntegrity: { version: 'rev9-future', contaminated: true } }
      })
    ).toEqual({ contaminated: false });
  });
});

describe('W3: a learning-eligible contaminated execution is refused with the ninth code', () => {
  it('fires `rejected-contaminated-evidence` with stable numeric code 9', () => {
    const verdict = judgeWriteback(view({ contaminated: true }), history([]));
    expect(verdict.admitted).toBe(false);
    expect(verdict.refusal).toBe('rejected-contaminated-evidence');
    expect(writebackRefusalCode(verdict.refusal)).toBe(9);
  });

  it('sits after record-ineligible and before no-verdict (frozen evaluation order)', () => {
    // The record's own veto wins: it can never be made trainable.
    expect(
      judgeWriteback(
        view({ contaminated: true, recordLearningEligible: false }),
        history([])
      ).refusal
    ).toBe('rejected-record-ineligible');
    // Contamination is more specific than "no verdict": it must not be
    // laundered into the vague reason.
    expect(
      judgeWriteback(
        view({ contaminated: true, verificationStatus: 'unknown', trustedSource: false }),
        history([])
      ).refusal
    ).toBe('rejected-contaminated-evidence');
  });
});

describe('W3: persisted contamination bars G-A and G-B in later runs', () => {
  it('the scalar encoding decodes to a counterexample entry', () => {
    const entry = writebackHistoryEntryOf('action-1', {
      trustedSource: true,
      verificationStatus: 'passed',
      verifierRewardMismatch: false,
      forceAuditOnly: false,
      contaminated: true
    });
    expect(entry.contaminated).toBe(true);
    expect(entry.counterexample).toBe(true);
    // The verdict columns still describe what was recorded; the contamination
    // flag is an independent veto, not a rewrite of the verdict.
    expect(entry.status).toBe('passed');
    expect(entry.verified).toBe(true);
  });

  it('a contaminated "failed" record cannot satisfy G-A prior-failure', () => {
    // Current execution looks perfect: trusted pass, learning-eligible.
    // The ONLY prior record is a FAILED-but-contaminated one.
    const prior = writebackHistoryEntryOf('action-1', {
      trustedSource: true,
      verificationStatus: 'failed',
      verifierRewardMismatch: false,
      forceAuditOnly: false,
      contaminated: true
    });
    const verdict = judgeWriteback(view(), history([prior]));
    expect(verdict.admitted).toBe(false);
    expect(verdict.priorFailure).toBe(false);
    expect(verdict.refusal).toBe('rejected-no-prior-failure');
  });

  it('a bucket of contaminated passes vetoes G-B (poisoning is not outvoted)', () => {
    const contaminatedBucket = [0, 1, 2].map(() =>
      writebackHistoryEntryOf('action-1', {
        trustedSource: true,
        verificationStatus: 'passed',
        verifierRewardMismatch: false,
        forceAuditOnly: false,
        contaminated: true
      })
    );
    // Current run: a trusted failure (not a pass, so G-A does not apply; not
    // `unknown`, so the no-verdict refusal does not mask G-B).
    const verdict = judgeWriteback(
      view({ verificationStatus: 'failed' }),
      history(contaminatedBucket)
    );
    expect(verdict.admitted).toBe(false);
    expect(verdict.support).toBe(3);
    expect(verdict.counterexamples).toBe(3);
    // The counterexample veto is the route that fires (zero tolerated).
    expect(verdict.refusal).toBe('rejected-verifier-mismatch');

    // CONTROL: the SAME bucket without the contamination flags clears G-B, so
    // the CONTAMINATION is provably what vetoed the route (not the verdict, the
    // support or the pass-rate).
    const cleanBucket = [0, 1, 2].map(() =>
      writebackHistoryEntryOf('action-1', {
        trustedSource: true,
        verificationStatus: 'passed',
        verifierRewardMismatch: false,
        forceAuditOnly: false
      })
    );
    const clean = judgeWriteback(view({ verificationStatus: 'failed' }), history(cleanBucket));
    expect(clean.admitted).toBe(true);
    expect(clean.route).toBe('kept-verified-convergence');
    expect(clean.counterexamples).toBe(0);
  });
});