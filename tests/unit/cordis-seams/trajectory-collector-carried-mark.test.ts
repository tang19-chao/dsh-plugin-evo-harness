/**
 * rev8 W2-propagation: the collector's carried-mark trust boundary.
 *
 * The OUTER `TrajectoryCollector` must keep a contamination fact the INNER
 * collector already acted on (the inner quarantined the content, so the outer
 * re-scan cannot rediscover it), WITHOUT becoming a branch-controlled verdict
 * channel. These tests pin the asymmetry:
 *
 *   - a well-formed DENY mark (`contaminated === true`) is merged with the
 *     host's own re-scan and the frozen trajectory carries a mark;
 *   - a "clean" claim, a foreign version, a malformed findings list, a
 *     `withheld: false` claim or a mark parked on any other metadata key is
 *     INERT — the host-owned scan still runs and stays authoritative;
 *   - the merge never removes an outer finding (patch/sentinel rejection is
 *     preserved) and the persisted mark is rebuilt from known fields only.
 */
import { describe, expect, it } from 'vitest';
import { TrajectoryCollector } from '../../../src/cordis-seams/trajectory-collector';
import {
  EVIDENCE_INTEGRITY_VERSION,
  mergeEvidenceIntegrityMarks,
  readCarriedEvidenceIntegrityMark,
  readEvidenceIntegrityMark,
  type EvidenceIntegrityMark,
  type EvidenceIntegrityPolicy
} from '../../../src/verification/evidence-integrity';
import { writebackIntegrityViewOf } from '../../../src/jitrl/writeback-gate';
import type { EightSurfacePatch, ProbeExecutionResult } from '../../../src/types/contracts';
import { makeClock, makePatch } from './fixtures';

const ANSWER_CRITERIA = [
  {
    id: 'k1',
    text: 'the reconciliation ledger must record every disputed invoice line verbatim including the reversal timestamp and the operator initials'
  },
  {
    id: 'k2',
    text: 'the migration script must abort before writing whenever the checksum manifest disagrees with the fetched artifact digest'
  }
] as const;
const FULL_KEY = ANSWER_CRITERIA.map((entry) => entry.text).join('\n');

const POLICY: EvidenceIntegrityPolicy = {
  taskId: 'task-carried',
  answerKey: { criteria: ANSWER_CRITERIA, visibleText: [] }
};

/** A traversal-shaped patch (`skills/<name>/SKILL.md` becomes a path). */
function collidingPatch(): EightSurfacePatch {
  const base = makePatch();
  return {
    ...base,
    id: 'patch-carried-collide',
    edits: {
      ...base.edits,
      skills: { kind: 'skills' as const, skills: [{ name: 'tests', markdown: '# x' }] }
    }
  };
}

function collector(overrides: Partial<ConstructorParameters<typeof TrajectoryCollector>[0]> = {}) {
  return new TrajectoryCollector({
    id: 'traj-carried',
    sessionId: 'sess-carried',
    branchId: 'br-carried',
    branchNamespace: 'harness2:probe_br-carried',
    role: 'candidate',
    patch: makePatch(),
    now: makeClock(1_000, 5),
    evidenceIntegrity: POLICY,
    ...overrides
  });
}

/** The exact mark shape `quarantineTrajectory` writes on the inner side. */
function contaminatedMark(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: EVIDENCE_INTEGRITY_VERSION,
    contaminated: true,
    withheld: true,
    findings: [
      {
        kind: 'answer-key-text',
        location: 'deliverable',
        criterionId: 'k1',
        sharedPassages: 4,
        matchedCriteria: 2,
        totalCriteria: 2
      }
    ],
    ...overrides
  };
}

/** The result shape the agent-loop bridge returns after an inner quarantine. */
function carriedResult(
  metadata: unknown,
  overrides: Partial<ProbeExecutionResult> = {}
): ProbeExecutionResult {
  return {
    status: 'failed',
    steps: [
      {
        index: 0,
        at: 1_100,
        kind: 'system',
        text: '(withheld: this evidence carries task answer-key material, so neither its trajectory nor its output may be read. Draw no conclusion from their absence.)'
      }
    ],
    toolErrors: [],
    failureSignals: [
      { kind: 'unknown', message: 'evidence withheld: answer-key contamination detected (1 finding(s))', code: 'evidence-contaminated', repairable: false }
    ],
    error: { name: 'EvidenceIntegrityError', message: 'evidence withheld: answer-key contamination detected' },
    metadata: { mode: 'single_call', trajectory: metadata },
    ...overrides
  };
}

describe('rev8 W2-propagation: a carried inner-collector mark is honoured', () => {
  it('keeps the mark on the outer frozen trajectory even though the content is already neutral', () => {
    const trajectory = collector().finalize({
      result: carriedResult({ evidenceIntegrity: contaminatedMark() })
    });

    expect(trajectory.status).toBe('failed');
    expect(trajectory.deliverable).toBeUndefined();
    const mark = readEvidenceIntegrityMark(trajectory.metadata);
    expect(mark?.contaminated).toBe(true);
    expect(mark?.withheld).toBe(true);
    expect(mark?.findings.map((finding) => finding.kind)).toEqual(['answer-key-text']);
    // The write-back gate / rewardSources history veto now get their input.
    expect(writebackIntegrityViewOf(trajectory)).toEqual({ contaminated: true });
  });

  it('honours the carried mark even when the outer collector has no policy of its own', () => {
    // A host that injects its own unarmed seam manager must still not lose a
    // contamination fact produced by an armed inner collector: the direction is
    // deny-only, so honouring it cannot raise anything.
    const trajectory = collector({ evidenceIntegrity: undefined }).finalize({
      result: carriedResult({
        evidenceIntegrity: contaminatedMark({
          findings: [{ kind: 'missing-trajectory-sentinel', location: 'deliverable' }]
        })
      })
    });
    expect(trajectory.status).toBe('failed');
    const mark = readEvidenceIntegrityMark(trajectory.metadata);
    expect(mark?.contaminated).toBe(true);
    expect(mark?.findings.map((finding) => finding.kind)).toEqual(['missing-trajectory-sentinel']);
  });

  it('merges the carried findings with the outer patch rejection (both stay visible)', () => {
    const trajectory = collector({
      patch: collidingPatch(),
      evidenceIntegrity: { taskId: 'task-carried', forbiddenPathSegments: ['tests'] }
    }).finalize({ result: carriedResult({ evidenceIntegrity: contaminatedMark() }) });

    const mark = readEvidenceIntegrityMark(trajectory.metadata);
    expect(mark?.contaminated).toBe(true);
    const kinds = mark?.findings.map((finding) => finding.kind) ?? [];
    expect(kinds).toContain('answer-key-text'); // from the inner collector
    expect(kinds).toContain('answer-key-path'); // the outer's own rejection
    expect(mark?.findings.map((finding) => finding.collidingPath)).toContain('skills/tests/SKILL.md');
    expect(mark?.taskId).toBe('task-carried');
  });

  it('keeps the outer sentinel rejection when the two marks describe different hits', () => {
    const trajectory = collector().finalize({
      result: carriedResult(
        // The inner collector withheld an answer-key hit...
        { evidenceIntegrity: contaminatedMark() },
        // ...while the outer still sees the raw #72 sentinel deliverable.
        { deliverable: { content: '(no trajectory: renderer produced no events)', format: 'text' } }
      )
    });
    const mark = readEvidenceIntegrityMark(trajectory.metadata);
    const kinds = new Set(mark?.findings.map((finding) => finding.kind));
    expect(kinds.has('missing-trajectory-sentinel')).toBe(true);
    expect(kinds.has('answer-key-text')).toBe(true);
  });
});

describe('rev8 W2-propagation: the carried channel is deny-only', () => {
  it('ignores a forged CLEAN claim and still runs the host-owned scan', () => {
    const trajectory = collector().finalize({
      status: 'succeeded',
      result: {
        status: 'succeeded',
        steps: [{ index: 0, at: 1_050, kind: 'result', text: 'done' }],
        deliverable: { content: FULL_KEY, format: 'text' },
        metadata: {
          trajectory: {
            evidenceIntegrity: {
              version: EVIDENCE_INTEGRITY_VERSION,
              contaminated: false,
              withheld: false,
              findings: []
            }
          }
        }
      }
    });
    // The forged clean claim changed nothing: the host scan caught the key.
    expect(trajectory.status).toBe('failed');
    const mark = readEvidenceIntegrityMark(trajectory.metadata);
    expect(mark?.contaminated).toBe(true);
    expect(mark?.findings.map((finding) => finding.kind)).toContain('answer-key-text');
    expect(JSON.stringify(trajectory)).not.toContain(ANSWER_CRITERIA[0].text);
  });

  it('ignores a clean claim on clean content (no mark, no quarantine)', () => {
    const trajectory = collector().finalize({
      status: 'succeeded',
      result: {
        status: 'succeeded',
        deliverable: { content: 'a clean answer', format: 'text' },
        metadata: {
          trajectory: {
            evidenceIntegrity: {
              version: EVIDENCE_INTEGRITY_VERSION,
              contaminated: false,
              withheld: false,
              findings: []
            }
          }
        }
      }
    });
    expect(trajectory.status).toBe('succeeded');
    expect(readEvidenceIntegrityMark(trajectory.metadata)).toBeUndefined();
    expect(writebackIntegrityViewOf(trajectory)).toEqual({ contaminated: false });
  });

  it('ignores a foreign version, a withheld:false claim and malformed findings', () => {
    const malformed: Readonly<Record<string, unknown>>[] = [
      { evidenceIntegrity: contaminatedMark({ version: 'rev0-foreign' }) },
      { evidenceIntegrity: contaminatedMark({ withheld: false }) },
      { evidenceIntegrity: contaminatedMark({ contaminated: 'true' }) },
      { evidenceIntegrity: contaminatedMark({ findings: [] }) },
      { evidenceIntegrity: contaminatedMark({ findings: [{ kind: 'not-a-kind', location: 'deliverable' }] }) },
      { evidenceIntegrity: contaminatedMark({ findings: [{ kind: 'answer-key-text' }] }) },
      { evidenceIntegrity: contaminatedMark({ findings: [{ kind: 'answer-key-text', location: '' }] }) },
      // Not the documented channel: arbitrary result metadata is never read.
      { evidenceIntegrityDirectlyOnMetadata: contaminatedMark() }
    ];
    for (const metadata of malformed) {
      const trajectory = collector().finalize({
        status: 'succeeded',
        result: {
          status: 'succeeded',
          deliverable: { content: 'a clean answer', format: 'text' },
          metadata
        }
      });
      expect(trajectory.status, JSON.stringify(metadata)).toBe('succeeded');
      expect(readEvidenceIntegrityMark(trajectory.metadata)).toBeUndefined();
      // The unrelated metadata bag is still dropped (c2a).
      expect(trajectory.metadata?.['trajectory']).toBeUndefined();
    }
  });

  it('rejects a mark parked at the top level of result metadata', () => {
    const trajectory = collector().finalize({
      status: 'succeeded',
      result: {
        status: 'succeeded',
        deliverable: { content: 'a clean answer', format: 'text' },
        metadata: { evidenceIntegrity: contaminatedMark() }
      }
    });
    expect(trajectory.status).toBe('succeeded');
    expect(readEvidenceIntegrityMark(trajectory.metadata)).toBeUndefined();
  });

  it('drops unknown finding fields instead of persisting them', () => {
    const trajectory = collector().finalize({
      result: carriedResult({
        evidenceIntegrity: contaminatedMark({
          findings: [
            {
              kind: 'answer-key-text',
              location: 'deliverable',
              criterionId: 'k1',
              injectedPayload: 'must-not-survive',
              nested: { a: 1 }
            }
          ]
        })
      })
    });
    const serialized = JSON.stringify(trajectory.metadata);
    expect(serialized).not.toContain('must-not-survive');
    expect(serialized).not.toContain('nested');
    expect(readEvidenceIntegrityMark(trajectory.metadata)?.findings[0]?.criterionId).toBe('k1');
  });
});

describe('readCarriedEvidenceIntegrityMark', () => {
  it('returns undefined unless the claim is a well-formed denial', () => {
    expect(readCarriedEvidenceIntegrityMark(undefined)).toBeUndefined();
    expect(readCarriedEvidenceIntegrityMark({})).toBeUndefined();
    expect(readCarriedEvidenceIntegrityMark({ trajectory: 'not-an-object' })).toBeUndefined();
    expect(readCarriedEvidenceIntegrityMark({ trajectory: {} })).toBeUndefined();
    expect(readCarriedEvidenceIntegrityMark({ trajectory: { evidenceIntegrity: contaminatedMark() } })).toBeDefined();
  });

  it('rebuilds the mark from known fields only', () => {
    const mark = readCarriedEvidenceIntegrityMark({
      trajectory: {
        evidenceIntegrity: contaminatedMark({ taskId: 'task-carried', foreignField: 'x' })
      }
    });
    expect(mark).toEqual({
      version: EVIDENCE_INTEGRITY_VERSION,
      contaminated: true,
      withheld: true,
      findings: [
        {
          kind: 'answer-key-text',
          location: 'deliverable',
          criterionId: 'k1',
          sharedPassages: 4,
          matchedCriteria: 2,
          totalCriteria: 2
        }
      ],
      taskId: 'task-carried'
    });
    expect(mark === undefined ? undefined : Object.keys(mark)).not.toContain('foreignField');
  });
});

describe('mergeEvidenceIntegrityMarks', () => {
  const base: EvidenceIntegrityMark = {
    version: EVIDENCE_INTEGRITY_VERSION,
    contaminated: true,
    withheld: true,
    findings: [{ kind: 'answer-key-text', location: 'deliverable' }]
  };

  it('unions findings and dedupes identical ones', () => {
    const merged = mergeEvidenceIntegrityMarks(base, {
      ...base,
      findings: [
        { kind: 'answer-key-text', location: 'deliverable' },
        { kind: 'answer-key-path', location: 'patch', collidingPath: 'skills/tests/SKILL.md' }
      ]
    });
    expect(merged?.findings).toHaveLength(2);
    expect(merged?.findings.map((finding) => finding.kind)).toEqual([
      'answer-key-text',
      'answer-key-path'
    ]);
  });

  it('never downgrades a contaminated claim', () => {
    const merged = mergeEvidenceIntegrityMarks(base, undefined);
    expect(merged).toBe(base);
    expect(mergeEvidenceIntegrityMarks(undefined, base)).toBe(base);
    expect(mergeEvidenceIntegrityMarks(undefined, undefined)).toBeUndefined();
  });
});
