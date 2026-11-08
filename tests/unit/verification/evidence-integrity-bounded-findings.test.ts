/**
 * rev8 audit fix: BOUNDED evidence-integrity findings (production blocker).
 *
 * THE DEFECT
 *   `findings` was the one unbounded field of a persisted mark. Every string
 *   field had a 500-character cap, but the LIST had no cap anywhere:
 *
 *     - `readCarriedEvidenceIntegrityMark` accepted a BRANCH-CONTROLLED list of
 *       any length and `quarantineTrajectory` re-persisted it verbatim;
 *     - `scanTrajectoryEvidenceIntegrity` produced one finding per scanned
 *       surface, so a branch returning N steps produced N findings;
 *     - `scanPatchEvidenceIntegrity` produced one finding per colliding path;
 *     - `treeEvidenceIntegrityMark` concatenated one list per trajectory;
 *     - `mergeEvidenceIntegrityMarks` unioned two lists with a linear scan per
 *       element (quadratic).
 *
 *   The persistence layer has no byte guard either — it compacted on RECORD
 *   COUNT — so a single run's tree-pool record could be tens of megabytes
 *   (measured: 31 MB record, 521 MB log at 560 records).
 *
 * THE FIX (each of the five routes is capped at EVIDENCE_INTEGRITY_MAX_FINDINGS)
 *   The tests below pin:
 *     - the cap actually holds on every route, at a scale far beyond it;
 *     - kind coverage survives truncation (a truncated mark still names every
 *       kind that fired, so the quarantine classification cannot be weakened);
 *     - the elided count is REPORTED, never silently swallowed;
 *     - a malformed carried entry still voids the whole mark (fail-closed
 *       validation is unchanged by the cap);
 *     - a small mark is byte- and shape-identical to the pre-cap output;
 *     - the deny-only direction is unchanged: a clean/foreign claim is still
 *       absent, and a bounded mark is still `contaminated: true`.
 *
 * These are NEGATIVE tests in the sense the audit asks for: they feed inputs
 * that used to grow the output without bound and assert the output stays
 * bounded.
 */
import { describe, expect, it } from 'vitest';

import {
  EVIDENCE_INTEGRITY_MAX_FINDINGS,
  EVIDENCE_INTEGRITY_MAX_TEXT,
  EVIDENCE_INTEGRITY_VERSION,
  createEvidenceIntegrityFindingSet,
  mergeEvidenceIntegrityMarks,
  quarantineTrajectory,
  readCarriedEvidenceIntegrityMark,
  readEvidenceIntegrityMark,
  scanPatchEvidenceIntegrity,
  scanTrajectoryEvidenceIntegrity,
  type EvidenceIntegrityMark,
  type EvidenceIntegrityPolicy
} from '../../../src/verification/evidence-integrity';
import { snapshotWithEvidenceIntegrityMark, treeEvidenceIntegrityMark } from '../../../src/orchestrator';
import type { EightSurfacePatch, ProbeTrajectory } from '../../../src/types/contracts';

const CRITERIA = [
  {
    id: 'k1',
    text: 'the reconciliation ledger must record every disputed invoice line verbatim including the reversal timestamp and the operator initials'
  },
  {
    id: 'k2',
    text: 'the migration script must abort before writing whenever the checksum manifest disagrees with the fetched artifact digest'
  }
] as const;
const FULL_KEY = CRITERIA.map((entry) => entry.text).join('\n');
const POLICY: EvidenceIntegrityPolicy = { answerKey: { criteria: CRITERIA, visibleText: [] } };

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function countByKind(findings: readonly { readonly kind: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of findings) {
    counts[finding.kind] = (counts[finding.kind] ?? 0) + 1;
  }
  return counts;
}

function carriedOf(findings: readonly unknown[], extra: Record<string, unknown> = {}): unknown {
  return {
    trajectory: {
      evidenceIntegrity: {
        version: EVIDENCE_INTEGRITY_VERSION,
        contaminated: true,
        withheld: true,
        findings,
        ...extra
      }
    }
  };
}

function emptyTrajectory(metadata: unknown = undefined): ProbeTrajectory {
  return {
    id: 'traj-bound',
    sessionId: 'sess-bound',
    branchId: 'br-bound',
    branchNamespace: 'ns-bound',
    role: 'candidate',
    status: 'failed',
    patchId: 'patch-bound',
    patchOrigin: 'domain',
    surfaceKeys: [],
    startedAt: 1,
    endedAt: 2,
    metrics: { steps: 0, toolCalls: 0, toolErrors: 0, durationMs: 1 },
    steps: [],
    toolErrors: [],
    failureSignals: [],
    memoryRecallIds: [],
    ...(metadata === undefined ? {} : { metadata })
  } as ProbeTrajectory;
}

describe('bounded findings: the carried channel (branch-controlled list)', () => {
  it('accepts a list far beyond the cap but persists only a bounded sample', () => {
    const findings = Array.from({ length: 20_000 }, (_, index) => ({
      kind: 'answer-key-text',
      location: 'steps[' + String(index) + ']',
      criterionId: 'k1'
    }));
    const mark = readCarriedEvidenceIntegrityMark(carriedOf(findings));

    expect(mark?.contaminated).toBe(true);
    expect(mark?.withheld).toBe(true);
    expect(mark?.findings.length).toBeLessThanOrEqual(EVIDENCE_INTEGRITY_MAX_FINDINGS);
    // The elided remainder is reported, not silently swallowed.
    expect((mark?.findings.length ?? 0) + (mark?.droppedFindings ?? 0)).toBe(20_000);
    // The persisted mark stays small: the pre-fix mark was 2.57 MB for this.
    expect(bytes(mark)).toBeLessThan(64 * 1024);
  });

  it('reports its own elided count without letting it UNDERSTATE the total', () => {
    // A shape-legal bounded mark declares 5 elided; this pass elides the rest.
    const findings = Array.from({ length: 200 }, (_, index) => ({
      kind: 'answer-key-text',
      location: 'steps[' + String(index) + ']'
    }));
    const mark = readCarriedEvidenceIntegrityMark(
      carriedOf(findings, { droppedFindings: 5 })
    );
    expect((mark?.findings.length ?? 0) + (mark?.droppedFindings ?? 0)).toBe(205);
  });

  it('keeps EVERY kind that fired even when the first kinds flood the budget', () => {
    // 500 sentinel findings arrive first; the answer-key-text fact must survive.
    const findings = [
      ...Array.from({ length: 500 }, () => ({
        kind: 'missing-trajectory-sentinel',
        location: 'deliverable'
      })),
      { kind: 'answer-key-text', location: 'deliverable', criterionId: 'k1' },
      { kind: 'answer-key-path', location: 'patch', collidingPath: 'skills/tests/SKILL.md' }
    ];
    const mark = readCarriedEvidenceIntegrityMark(carriedOf(findings));
    const kinds = countByKind(mark?.findings ?? []);
    expect(kinds['missing-trajectory-sentinel']).toBeGreaterThan(0);
    expect(kinds['answer-key-text']).toBe(1);
    expect(kinds['answer-key-path']).toBe(1);
    expect(mark?.findings.length).toBeLessThanOrEqual(EVIDENCE_INTEGRITY_MAX_FINDINGS);
  });

  it('still voids the whole mark on ONE malformed entry, however long the list', () => {
    const findings = [
      ...Array.from({ length: 500 }, (_, index) => ({
        kind: 'answer-key-text',
        location: 'steps[' + String(index) + ']'
      })),
      // Beyond the cap: validation must not be skipped just because the budget
      // is exhausted, so this still fails the whole claim closed.
      { kind: 'not-a-kind', location: 'deliverable' }
    ];
    expect(readCarriedEvidenceIntegrityMark(carriedOf(findings))).toBeUndefined();
  });

  it('leaves a small mark byte- and shape-identical (no droppedFindings key added)', () => {
    const mark = readCarriedEvidenceIntegrityMark(
      carriedOf([
        {
          kind: 'answer-key-text',
          location: 'deliverable',
          criterionId: 'k1',
          sharedPassages: 4,
          matchedCriteria: 2,
          totalCriteria: 2
        }
      ])
    );
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
      ]
    });
    expect(Object.keys(mark ?? {})).not.toContain('droppedFindings');
  });
});

describe('bounded findings: the host-owned scan routes', () => {
  it('caps the scan of an arbitrarily long steps array (one finding per surface)', () => {
    const steps = Array.from({ length: 5_000 }, (_, index) => ({
      index,
      at: 1_000 + index,
      kind: 'tool' as const,
      text: FULL_KEY
    }));
    const mark = scanTrajectoryEvidenceIntegrity({ steps, toolErrors: [], deliverable: undefined }, POLICY);
    expect(mark?.findings.length).toBeLessThanOrEqual(EVIDENCE_INTEGRITY_MAX_FINDINGS);
    expect((mark?.findings.length ?? 0) + (mark?.droppedFindings ?? 0)).toBe(5_000);
    // Still a real contamination verdict, still no key text in the mark.
    expect(mark?.contaminated).toBe(true);
    expect(JSON.stringify(mark)).not.toContain('reconciliation');
  });

  it('caps the patch scan with thousands of colliding component paths', () => {
    const patch = {
      id: 'patch-many',
      sessionId: 's',
      branchId: 'b',
      origin: 'domain',
      guidance: 'memory',
      purpose: 'explore',
      label: 'l',
      rationale: 'r',
      createdAt: 1,
      edits: {
        skills: {
          kind: 'skills',
          skills: Array.from({ length: 3_000 }, (_, index) => ({
            name: 'tests',
            markdown: '# ' + String(index)
          }))
        }
      }
    } as unknown as EightSurfacePatch;
    const mark = scanPatchEvidenceIntegrity(patch, { forbiddenPathSegments: ['tests'] });
    expect(mark?.findings.length).toBeLessThanOrEqual(EVIDENCE_INTEGRITY_MAX_FINDINGS);
    expect((mark?.findings.length ?? 0) + (mark?.droppedFindings ?? 0)).toBe(3_000);
    expect(mark?.findings.every((finding) => finding.kind === 'answer-key-path')).toBe(true);
  });

  it('caps the merge and does not go quadratic (dedupe is keyed)', () => {
    const left: EvidenceIntegrityMark = {
      version: EVIDENCE_INTEGRITY_VERSION,
      contaminated: true,
      withheld: true,
      findings: Array.from({ length: 5_000 }, (_, index) => ({
        kind: 'answer-key-text' as const,
        location: 'own[' + String(index) + ']'
      }))
    };
    const right: EvidenceIntegrityMark = {
      version: EVIDENCE_INTEGRITY_VERSION,
      contaminated: true,
      withheld: true,
      findings: Array.from({ length: 5_000 }, (_, index) => ({
        kind: 'answer-key-text' as const,
        location: 'carried[' + String(index) + ']'
      }))
    };
    const started = Date.now();
    const merged = mergeEvidenceIntegrityMarks(left, right);
    const elapsed = Date.now() - started;
    expect(merged?.findings.length).toBeLessThanOrEqual(EVIDENCE_INTEGRITY_MAX_FINDINGS);
    expect((merged?.findings.length ?? 0) + (merged?.droppedFindings ?? 0)).toBe(10_000);
    // 10k x 10k pairwise comparisons took ~1.8 s before; a keyed set is ~0.
    expect(elapsed).toBeLessThan(1_000);
  });

  it('still dedupes identical findings and keeps both distinct kinds', () => {
    const base: EvidenceIntegrityMark = {
      version: EVIDENCE_INTEGRITY_VERSION,
      contaminated: true,
      withheld: true,
      findings: [{ kind: 'answer-key-text', location: 'deliverable' }]
    };
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

  it('caps the cross-trajectory tree aggregation (the persisted record)', () => {
    const oversized: EvidenceIntegrityMark = {
      version: EVIDENCE_INTEGRITY_VERSION,
      contaminated: true,
      withheld: true,
      findings: Array.from({ length: 3_000 }, (_, index) => ({
        kind: 'answer-key-text' as const,
        location: 'steps[' + String(index) + ']'
      }))
    };
    const trajectories = Array.from({ length: 20 }, () => ({
      metadata: { evidenceIntegrity: oversized }
    }));
    const started = Date.now();
    const aggregated = treeEvidenceIntegrityMark(trajectories as never);
    expect(aggregated?.findings.length).toBeLessThanOrEqual(EVIDENCE_INTEGRITY_MAX_FINDINGS);
    expect(aggregated?.contaminated).toBe(true);
    // Concatenation is kept (no dedupe — two runs hitting one location are two
    // facts), so the cap is what bounds the stored list and the remainder is
    // reported instead of materialised.
    expect(aggregated?.findings.length).toBe(EVIDENCE_INTEGRITY_MAX_FINDINGS);
    expect((aggregated?.findings.length ?? 0) + (aggregated?.droppedFindings ?? 0)).toBe(60_000);
    expect(bytes(aggregated)).toBeLessThan(64 * 1024);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('bounds a LEGACY oversized persisted mark read back from disk', () => {
    const legacy = {
      version: EVIDENCE_INTEGRITY_VERSION,
      contaminated: true,
      withheld: true,
      findings: Array.from({ length: 30_000 }, (_, index) => ({
        kind: 'answer-key-text',
        location: 'steps[' + String(index) + ']'
      }))
    };
    const readBack = readEvidenceIntegrityMark({ evidenceIntegrity: legacy });
    expect(readBack?.contaminated).toBe(true);
    expect(readBack?.findings.length).toBeLessThanOrEqual(EVIDENCE_INTEGRITY_MAX_FINDINGS);
    expect((readBack?.findings.length ?? 0) + (readBack?.droppedFindings ?? 0)).toBe(30_000);
  });

  it('returns a within-cap persisted mark as the SAME object (no shape drift)', () => {
    const mark: EvidenceIntegrityMark = {
      version: EVIDENCE_INTEGRITY_VERSION,
      contaminated: true,
      withheld: true,
      findings: [{ kind: 'answer-key-text', location: 'deliverable' }]
    };
    expect(readEvidenceIntegrityMark({ evidenceIntegrity: mark })).toBe(mark);
  });

  it('reading a bounded mark twice is idempotent (the elided count cannot inflate)', () => {
    const mark = scanTrajectoryEvidenceIntegrity(
      {
        steps: Array.from({ length: 1_000 }, (_, index) => ({
          index,
          at: 1,
          kind: 'tool' as const,
          text: FULL_KEY
        })),
        toolErrors: [],
        deliverable: undefined
      },
      POLICY
    ) as EvidenceIntegrityMark;
    const first = readEvidenceIntegrityMark({ evidenceIntegrity: mark });
    const second = readEvidenceIntegrityMark({ evidenceIntegrity: first });
    // Same object on the second read: nothing to rebuild.
    expect(second).toBe(first);
    expect(first?.droppedFindings).toBe(mark.droppedFindings);
    expect((first?.findings.length ?? 0) + (first?.droppedFindings ?? 0)).toBe(1_000);
  });

  it('adds a declared droppedFindings to what it elides, counting the total once', () => {
    // 100 listed + 10 already declared = a true total of 110; the cap keeps 64
    // and must report 46, not 36 (which would lose the declared ten).
    const legacy = {
      version: EVIDENCE_INTEGRITY_VERSION,
      contaminated: true,
      withheld: true,
      droppedFindings: 10,
      findings: Array.from({ length: 100 }, (_, index) => ({
        kind: 'answer-key-text',
        location: 'steps[' + String(index) + ']'
      }))
    };
    const readBack = readEvidenceIntegrityMark({ evidenceIntegrity: legacy });
    expect(readBack?.findings).toHaveLength(EVIDENCE_INTEGRITY_MAX_FINDINGS);
    expect(readBack?.droppedFindings).toBe(46);
    expect((readBack?.findings.length ?? 0) + (readBack?.droppedFindings ?? 0)).toBe(110);
    // And a second read does not add the declared count again.
    expect(readEvidenceIntegrityMark({ evidenceIntegrity: readBack })?.droppedFindings).toBe(46);
  });
});

describe('bounded findings: the quarantine contract is unchanged', () => {
  it('a bounded mark still quarantines with the TOTAL finding count, not the sample', () => {
    const findings = Array.from({ length: 1_000 }, (_, index) => ({
      kind: 'answer-key-text',
      location: 'steps[' + String(index) + ']',
      criterionId: 'k1'
    }));
    const mark = readCarriedEvidenceIntegrityMark(carriedOf(findings));
    const quarantined = quarantineTrajectory(emptyTrajectory(), mark!);
    expect(quarantined.status).toBe('failed');
    expect(quarantined.failureSignals[0]?.code).toBe('evidence-contaminated');
    expect(quarantined.failureSignals[0]?.message).toContain('(1000 finding(s))');
    // The persisted mark on the quarantined trajectory is bounded too.
    const persisted = readEvidenceIntegrityMark(quarantined.metadata);
    expect(persisted?.findings.length).toBeLessThanOrEqual(EVIDENCE_INTEGRITY_MAX_FINDINGS);
    // No key text anywhere in the withheld record.
    expect(JSON.stringify(quarantined)).not.toContain('reconciliation');
  });

  it('a truncated mark still classifies sentinel-only vs key-text exactly as before', () => {
    // Sentinel-only: repairable, diagnostics survive.
    const sentinels = Array.from({ length: 500 }, () => ({
      kind: 'missing-trajectory-sentinel',
      location: 'deliverable'
    }));
    const sentinelMark = readCarriedEvidenceIntegrityMark(carriedOf(sentinels))!;
    const sentinelQuarantine = quarantineTrajectory(
      emptyTrajectory({ diagnostics: ['kept'] }),
      sentinelMark
    );
    expect(sentinelQuarantine.failureSignals[0]?.code).toBe('missing-trajectory-sentinel');
    expect(sentinelQuarantine.failureSignals[0]?.repairable).toBe(true);
    expect(sentinelQuarantine.metadata?.['diagnostics']).toEqual(['kept']);

    // Path-only: repairable, no diagnostics kept for a contaminated mark.
    const paths = Array.from({ length: 500 }, (_, index) => ({
      kind: 'answer-key-path',
      location: 'patch',
      collidingPath: 'skills/tests/' + String(index) + '.md'
    }));
    const pathMark = readCarriedEvidenceIntegrityMark(carriedOf(paths))!;
    const pathQuarantine = quarantineTrajectory(emptyTrajectory(), pathMark);
    expect(pathQuarantine.failureSignals[0]?.code).toBe('answer-key-path');
    expect(pathQuarantine.failureSignals[0]?.repairable).toBe(true);
  });

  it('the deny-only channel is untouched: clean/foreign claims still read as absent', () => {
    const clean = {
      trajectory: {
        evidenceIntegrity: {
          version: EVIDENCE_INTEGRITY_VERSION,
          contaminated: false,
          withheld: false,
          findings: []
        }
      }
    };
    expect(readCarriedEvidenceIntegrityMark(clean)).toBeUndefined();
    expect(
      readCarriedEvidenceIntegrityMark(
        carriedOf([{ kind: 'answer-key-text', location: 'deliverable' }], {
          version: 'rev0-foreign'
        })
      )
    ).toBeUndefined();
    expect(
      readCarriedEvidenceIntegrityMark(
        carriedOf([{ kind: 'answer-key-text', location: 'deliverable' }], { withheld: false })
      )
    ).toBeUndefined();
  });
});

describe('bounded findings: the accumulator itself', () => {
  it('never exceeds the cap and reports what it elided', () => {
    const set = createEvidenceIntegrityFindingSet();
    for (let index = 0; index < 10_000; index += 1) {
      set.offer({ kind: 'answer-key-text', location: 'steps[' + String(index) + ']' });
    }
    expect(set.findings.length).toBe(EVIDENCE_INTEGRITY_MAX_FINDINGS);
    expect(set.droppedFindings).toBe(10_000 - EVIDENCE_INTEGRITY_MAX_FINDINGS);
  });

  it('reserves a slot for an unseen kind regardless of arrival order', () => {
    const set = createEvidenceIntegrityFindingSet();
    for (let index = 0; index < 1_000; index += 1) {
      set.offer({ kind: 'answer-key-text', location: 'steps[' + String(index) + ']' });
    }
    set.offer({ kind: 'missing-trajectory-sentinel', location: 'deliverable' });
    set.offer({ kind: 'answer-key-path', location: 'patch', collidingPath: 'skills/tests/SKILL.md' });
    const kinds = countByKind(set.findings);
    expect(kinds['missing-trajectory-sentinel']).toBe(1);
    expect(kinds['answer-key-path']).toBe(1);
    expect(set.findings.length).toBeLessThanOrEqual(EVIDENCE_INTEGRITY_MAX_FINDINGS);
  });

  it('honours a list exactly at the cap without reporting elisions', () => {
    const set = createEvidenceIntegrityFindingSet();
    for (let index = 0; index < EVIDENCE_INTEGRITY_MAX_FINDINGS; index += 1) {
      set.offer({ kind: 'answer-key-text', location: 'steps[' + String(index) + ']' });
    }
    expect(set.findings).toHaveLength(EVIDENCE_INTEGRITY_MAX_FINDINGS);
    expect(set.droppedFindings).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// second pass: a count cap alone is NOT a byte bound.
//
// The first pass capped `findings.length` and left each finding's text fields
// unbounded. Measured on this tree before the per-field cap: ONE component path
// of 1 MB produced a 1,000,163 B finding; a legacy mark of 64 such findings
// (count-cap-compliant!) read back as 25,604,367 B and was re-persisted into the
// tree pool; a branch-supplied `step.index` reached 200,007 characters into a
// `location`. These tests pin both dimensions.
// ---------------------------------------------------------------------------

const HUGE = 'x'.repeat(200_000);

describe('bounded findings: per-field bytes (a count cap alone is not a byte bound)', () => {
  it('truncates an over-long location on the host-owned scan route', () => {
    // `step.index` is branch-supplied and lands in `location` verbatim.
    const mark = scanTrajectoryEvidenceIntegrity(
      {
        steps: [{ index: HUGE, at: 1, kind: 'tool', text: FULL_KEY }],
        toolErrors: [],
        deliverable: undefined
      } as never,
      POLICY
    );
    expect(mark?.findings).toHaveLength(1);
    expect(mark?.findings[0]?.location.length).toBeLessThanOrEqual(EVIDENCE_INTEGRITY_MAX_TEXT);
    // A hit is still a hit: truncation bounds the bytes, it never hides the fault.
    expect(mark?.findings[0]?.kind).toBe('answer-key-text');
    expect(bytes(mark)).toBeLessThan(8 * 1024);
  });

  it('truncates an over-long colliding component path on the patch route', () => {
    const patch = {
      id: 'patch-huge-path',
      sessionId: 's',
      branchId: 'b',
      origin: 'domain',
      guidance: 'memory',
      purpose: 'explore',
      label: 'l',
      rationale: 'r',
      createdAt: 1,
      edits: {
        scripts: {
          kind: 'scripts',
          scripts: [{ path: 'tests/' + HUGE + '.sh', contents: '' }]
        }
      }
    } as unknown as EightSurfacePatch;
    const mark = scanPatchEvidenceIntegrity(patch, { forbiddenPathSegments: ['tests'] });
    expect(mark?.findings).toHaveLength(1);
    expect(mark?.findings[0]?.collidingPath?.length).toBeLessThanOrEqual(EVIDENCE_INTEGRITY_MAX_TEXT);
    expect(bytes(mark)).toBeLessThan(8 * 1024);
  });

  it('bounds a legacy persisted mark whose findings are at the COUNT cap but huge', () => {
    // The exact shape that slipped through the first pass: 64 entries (allowed)
    // with 200 KB fields (allowed).
    const legacy = {
      version: EVIDENCE_INTEGRITY_VERSION,
      contaminated: true,
      withheld: true,
      findings: Array.from({ length: EVIDENCE_INTEGRITY_MAX_FINDINGS }, (_, index) => ({
        kind: 'answer-key-text',
        location: 'steps[' + String(index) + ']' + HUGE,
        criterionId: HUGE
      }))
    };
    const readBack = readEvidenceIntegrityMark({ evidenceIntegrity: legacy });
    expect(readBack?.findings).toHaveLength(EVIDENCE_INTEGRITY_MAX_FINDINGS);
    expect(bytes(readBack)).toBeLessThan(128 * 1024);
    // And it stays bounded when it becomes a persisted tree record.
    const aggregated = treeEvidenceIntegrityMark([{ metadata: { evidenceIntegrity: legacy } }] as never);
    expect(bytes(aggregated)).toBeLessThan(128 * 1024);
    expect(aggregated?.contaminated).toBe(true);
  });

  it('bounds the merge of two within-count-cap marks with huge fields', () => {
    const huge = (tag: string): EvidenceIntegrityMark => ({
      version: EVIDENCE_INTEGRITY_VERSION,
      contaminated: true,
      withheld: true,
      findings: Array.from({ length: EVIDENCE_INTEGRITY_MAX_FINDINGS }, (_, index) => ({
        kind: 'answer-key-text' as const,
        location: tag + String(index) + HUGE
      }))
    });
    const merged = mergeEvidenceIntegrityMarks(huge('a'), huge('b'));
    expect(merged?.findings.length).toBeLessThanOrEqual(EVIDENCE_INTEGRITY_MAX_FINDINGS);
    expect(bytes(merged)).toBeLessThan(128 * 1024);
  });

  it('holds the MULTIBYTE worst case to the documented ceiling, not to a guess', () => {
    // The cap counts CHARACTERS, and one character can be 3 UTF-8 bytes (4 for a
    // non-BMP emoji). All-CJK content is therefore the real worst case; the
    // ceiling below is the measured one, kept as the pin so a future "let it be
    // 5,000 chars" change cannot silently re-inflate the record.
    const wide = '漢'.repeat(50_000);
    const legacy = {
      version: EVIDENCE_INTEGRITY_VERSION,
      contaminated: true,
      withheld: true,
      findings: Array.from({ length: EVIDENCE_INTEGRITY_MAX_FINDINGS }, (_, index) => ({
        kind: 'answer-key-text',
        location: wide,
        criterionId: wide,
        collidingPath: wide
      }))
    };
    const readBack = readEvidenceIntegrityMark({ evidenceIntegrity: legacy });
    expect(readBack?.findings).toHaveLength(EVIDENCE_INTEGRITY_MAX_FINDINGS);
    expect(readBack?.findings[0]?.location.length).toBeLessThanOrEqual(EVIDENCE_INTEGRITY_MAX_TEXT);
    // Bounded and honest: ~288 KB of CJK, never tens of megabytes.
    expect(bytes(readBack)).toBeLessThan(320 * 1024);
    expect(bytes(readBack)).toBeGreaterThan(256 * 1024);
  });

  it('bounds the SINGLE-SIDED merge, which used to pass its input through verbatim', () => {
    // `merge(x, undefined)` returned `x` — the one path where this producer
    // could emit an unbounded mark (measured 900 findings / 90,040,479 B).
    const oversized: EvidenceIntegrityMark = {
      version: EVIDENCE_INTEGRITY_VERSION,
      contaminated: true,
      withheld: true,
      findings: Array.from({ length: 900 }, (_, index) => ({
        kind: 'answer-key-text' as const,
        location: 'x' + String(index) + HUGE
      }))
    };
    for (const merged of [
      mergeEvidenceIntegrityMarks(undefined, oversized),
      mergeEvidenceIntegrityMarks(oversized, undefined)
    ]) {
      expect(merged?.contaminated).toBe(true);
      expect(merged?.findings.length).toBeLessThanOrEqual(EVIDENCE_INTEGRITY_MAX_FINDINGS);
      expect(bytes(merged)).toBeLessThan(128 * 1024);
      expect((merged?.findings.length ?? 0) + (merged?.droppedFindings ?? 0)).toBe(900);
    }
    // Identity is preserved for a mark that is already within bounds.
    const small: EvidenceIntegrityMark = {
      version: EVIDENCE_INTEGRITY_VERSION,
      contaminated: true,
      withheld: true,
      findings: [{ kind: 'answer-key-text', location: 'deliverable' }]
    };
    expect(mergeEvidenceIntegrityMarks(small, undefined)).toBe(small);
    expect(mergeEvidenceIntegrityMarks(undefined, small)).toBe(small);
  });
});

describe('bounded findings: a persisted mark can never crash a consumer', () => {
  // `readEvidenceIntegrityMark` validated only the ENVELOPE. `findings: [null]`
  // was accepted and then threw on `.kind` in both consumers — a corrupt log
  // line could fail a whole run.
  for (const entry of [null, undefined, 'x', 7, {}, { kind: 'not-a-kind', location: 'l' }, {
    kind: 'answer-key-text'
  }]) {
    it('survives an unusable persisted entry: ' + String(JSON.stringify(entry)), () => {
      const bad = {
        version: EVIDENCE_INTEGRITY_VERSION,
        contaminated: true,
        withheld: true,
        findings: [entry]
      };
      const readBack = readEvidenceIntegrityMark({ evidenceIntegrity: bad });
      // The envelope is intact, so the mark is still read — the entry is not.
      expect(readBack?.contaminated).toBe(true);
      expect(readBack?.findings).toHaveLength(0);
      expect(readBack?.droppedFindings).toBe(1);
      // Neither consumer may throw.
      expect(() => treeEvidenceIntegrityMark([{ metadata: { evidenceIntegrity: bad } }] as never)).not.toThrow();
      expect(() => quarantineTrajectory(emptyTrajectory(), readBack as EvidenceIntegrityMark)).not.toThrow();
    });
  }

  it('keeps the usable entries of a mixed list and counts only the unusable ones', () => {
    const mixed = {
      version: EVIDENCE_INTEGRITY_VERSION,
      contaminated: true,
      withheld: true,
      findings: [
        { kind: 'answer-key-text', location: 'steps[0]' },
        null,
        { kind: 'answer-key-path', location: 'patch', collidingPath: 'skills/tests/SKILL.md' },
        'garbage'
      ]
    };
    const readBack = readEvidenceIntegrityMark({ evidenceIntegrity: mixed });
    expect(readBack?.findings.map((finding) => finding.kind)).toEqual([
      'answer-key-text',
      'answer-key-path'
    ]);
    expect(readBack?.droppedFindings).toBe(2);
  });
});

describe('bounded findings: contamination can never be laundered away', () => {
  // Deciding "did anything fire" on `findings.length` made a contaminated mark
  // with an empty or wholly-malformed list aggregate to `undefined`, which left
  // the tree snapshot metadata-ABSENT — i.e. verified-tree-gate saw a clean tree.
  it('a contaminated mark with an EMPTY list still yields a contaminated tree mark', () => {
    const metadata = {
      evidenceIntegrity: {
        version: EVIDENCE_INTEGRITY_VERSION,
        contaminated: true,
        withheld: true,
        findings: []
      }
    };
    const aggregated = treeEvidenceIntegrityMark([{ metadata }] as never);
    expect(aggregated).toBeDefined();
    expect(aggregated?.contaminated).toBe(true);
    expect(aggregated?.withheld).toBe(true);
    expect(aggregated?.findings).toHaveLength(0);
    // The snapshot therefore keeps a metadata bag instead of going absent.
    const snapshot = snapshotWithEvidenceIntegrityMark(
      { metadata: undefined } as never,
      aggregated
    );
    expect(snapshot.metadata).toBeDefined();
    expect(readEvidenceIntegrityMark(snapshot.metadata)?.contaminated).toBe(true);
  });

  it('a contaminated mark whose every entry is unusable still keeps the verdict', () => {
    const metadata = {
      evidenceIntegrity: {
        version: EVIDENCE_INTEGRITY_VERSION,
        contaminated: true,
        withheld: true,
        findings: [null, 'x', 7]
      }
    };
    const aggregated = treeEvidenceIntegrityMark([{ metadata }] as never);
    expect(aggregated?.contaminated).toBe(true);
    expect(aggregated?.droppedFindings).toBe(3);
  });

  it('a CLEAN mark still aggregates to absence (no false positive)', () => {
    const clean = {
      evidenceIntegrity: {
        version: EVIDENCE_INTEGRITY_VERSION,
        contaminated: false,
        withheld: false,
        findings: []
      }
    };
    expect(treeEvidenceIntegrityMark([{ metadata: clean }] as never)).toBeUndefined();
    expect(treeEvidenceIntegrityMark([] as never)).toBeUndefined();
    expect(treeEvidenceIntegrityMark([emptyTrajectory()] as never)).toBeUndefined();
  });
});