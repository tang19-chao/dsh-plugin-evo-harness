/**
 * rev8 evidence-integrity trio (upstream harness2 #67 / #72 / #118 / #175).
 *
 * Pinned behaviours:
 *   - #72  missing-trajectory sentinels are rejected as evidence;
 *   - #118 answer-key TEXT is matched on 10-word shingles (>=3 passages from
 *          >=half the criteria, minus visible text and quoted passages) and
 *          NO message ever carries the matched words;
 *   - #175 a component path colliding with an answer-key segment is refused
 *          (exact segment match under any directory: `skills/tests/SKILL.md`
 *          collides, `skills/run_tests/SKILL.md` and `scripts/tests.py` do not);
 *   - the quarantine record is a safe replacement: neutral note, no deliverable,
 *          findings report counts and ids only.
 */
import { describe, expect, it } from 'vitest';
import {
  ANSWER_KEY_MIN_FRACTION,
  ANSWER_KEY_MIN_SHARED,
  ANSWER_KEY_SHINGLE_WORDS,
  EVIDENCE_INTEGRITY_VERSION,
  MISSING_TRAJECTORY_PREFIXES,
  buildAnswerKeyIndex,
  evidenceIntegrityPolicyDigest,
  evidenceShingles,
  findAnswerKeyPathCollisions,
  isMissingTrajectorySentinel,
  patchEvidencePaths,
  quarantineTrajectory,
  readEvidenceIntegrityMark,
  scanAnswerKeyText,
  scanPatchEvidenceIntegrity,
  scanTrajectoryEvidenceIntegrity,
  type AnswerKeyCriterion,
  type EvidenceIntegrityPolicy
} from '../../../src/verification/evidence-integrity';
import type { EightSurfacePatch, ProbeTrajectory } from '../../../src/types/contracts';

const CRITERIA: readonly AnswerKeyCriterion[] = [
  {
    id: 'c1',
    text: 'the reconciliation report must list the signed total of every ledger row including credits and refunds before closing the period'
  },
  {
    id: 'c2',
    text: 'the filing timeline must start the statutory waiting period before the financing condition lapses and state the order of both steps'
  },
  {
    id: 'c3',
    text: 'every counterparty whose consent is required must be listed with the clause of the agreement that requires their consent'
  }
];

const FULL_KEY = CRITERIA.map((criterion) => criterion.text).join('\n');
const TASK_PROMPT = 'Prepare the quarterly reconciliation package for the audit committee.';
const DOCUMENT_QUOTING_ONE =
  'Exhibit B. ' + CRITERIA[1]!.text + ' End of exhibit.';

function policy(overrides: Partial<EvidenceIntegrityPolicy> = {}): EvidenceIntegrityPolicy {
  return {
    taskId: 'task-1',
    answerKey: { criteria: CRITERIA, visibleText: [TASK_PROMPT] },
    ...overrides
  };
}

function trajectoryOf(overrides: Partial<ProbeTrajectory> = {}): ProbeTrajectory {
  return {
    id: 'traj-x',
    sessionId: 'sess',
    branchId: 'br',
    branchNamespace: 'ns',
    role: 'candidate',
    status: 'succeeded',
    patchId: 'patch-1',
    patchOrigin: 'domain',
    surfaceKeys: [],
    startedAt: 1,
    endedAt: 10,
    metrics: { steps: 0, toolCalls: 0, toolErrors: 0, durationMs: 9 },
    steps: [],
    toolErrors: [],
    failureSignals: [],
    memoryRecallIds: [],
    ...overrides
  };
}

describe('#72: missing-trajectory sentinels', () => {
  it('recognises every upstream sentinel prefix and empty renders', () => {
    expect(MISSING_TRAJECTORY_PREFIXES).toEqual([
      '(no trajectory',
      '(no parseable events in trajectory)',
      '(failed to read trajectory:',
      '(trajectory unavailable:'
    ]);
    expect(isMissingTrajectorySentinel('')).toBe(true);
    expect(isMissingTrajectorySentinel('   \n ')).toBe(true);
    expect(isMissingTrajectorySentinel('(no parseable events in trajectory)')).toBe(true);
    expect(isMissingTrajectorySentinel('(failed to read trajectory: OSError)')).toBe(true);
    expect(isMissingTrajectorySentinel(undefined)).toBe(true);
    // Embedded mentions are not sentinel renders: only the prefix counts.
    expect(isMissingTrajectorySentinel('the run printed (no parseable events in trajectory) earlier')).toBe(false);
    expect(isMissingTrajectorySentinel('a complete trajectory body')).toBe(false);
  });

  it('a sentinel deliverable is not evidence; a real deliverable is', () => {
    const contaminated = scanTrajectoryEvidenceIntegrity(
      trajectoryOf({ deliverable: { content: '(no parseable events in trajectory)' } }),
      policy()
    );
    expect(contaminated?.findings.map((finding) => finding.kind)).toContain('missing-trajectory-sentinel');

    const clean = scanTrajectoryEvidenceIntegrity(
      trajectoryOf({ deliverable: { content: 'the signed total is 42.00' } }),
      policy()
    );
    expect(clean).toBeUndefined();
  });
});

describe('#118: answer-key text matching', () => {
  it('freezes the upstream thresholds', () => {
    expect(ANSWER_KEY_SHINGLE_WORDS).toBe(10);
    expect(ANSWER_KEY_MIN_SHARED).toBe(3);
    expect(ANSWER_KEY_MIN_FRACTION).toBe(0.5);
  });

  it('matches the whole key and reports counts without the words', () => {
    const index = buildAnswerKeyIndex(CRITERIA, [TASK_PROMPT]);
    expect(index.size).toBeGreaterThan(0);
    const hit = scanAnswerKeyText(FULL_KEY, index);
    expect(hit).toBeDefined();
    expect(hit?.matchedCriteria).toBe(3);
    expect(hit?.totalCriteria).toBe(3);
    expect(hit?.sharedPassages).toBeGreaterThanOrEqual(ANSWER_KEY_MIN_SHARED);
    // No criterion text ever appears in the hit shape.
    expect(JSON.stringify(hit)).not.toContain('reconciliation');
    expect(JSON.stringify(hit)).not.toContain('counterparty');
  });

  it('matches a key printed inside a JSON-escaped tool result', () => {
    const index = buildAnswerKeyIndex(CRITERIA, [TASK_PROMPT]);
    const escaped = JSON.stringify({ tool_result: FULL_KEY });
    const hit = scanAnswerKeyText(escaped, index);
    expect(hit?.matchedCriteria).toBe(3);
  });

  it('a document one criterion quotes is NOT the key (breadth test)', () => {
    const index = buildAnswerKeyIndex(CRITERIA, [TASK_PROMPT]);
    expect(scanAnswerKeyText(DOCUMENT_QUOTING_ONE, index)).toBeUndefined();
  });

  it('a short leak of one passage is not the key', () => {
    const index = buildAnswerKeyIndex(CRITERIA, [TASK_PROMPT]);
    const tenWords = CRITERIA[0]!.text.split(/\s+/).slice(0, 10).join(' ');
    expect(scanAnswerKeyText(tenWords, index)).toBeUndefined();
  });

  it('quoted passages inside a criterion are dropped before shingling', () => {
    // Single-line like upstream's own fixture: the quoted span is one run of text.
    const quoted = { id: 'q', text: 'Quotes the clause "' + FULL_KEY.replace(/\n/g, ' ') + '" exactly.' };
    const index = buildAnswerKeyIndex([quoted]);
    expect(index.size).toBe(0);
    expect(scanAnswerKeyText(FULL_KEY, index)).toBeUndefined();
  });

  it('visible text (the task prompt and its sources) never counts as the key', () => {
    const index = buildAnswerKeyIndex(CRITERIA, [TASK_PROMPT, FULL_KEY]);
    expect(index.size).toBe(0);
    expect(scanAnswerKeyText(FULL_KEY, index)).toBeUndefined();
  });

  it('shingles are exactly 10 normalized words', () => {
    const { tokens } = { tokens: FULL_KEY.toLowerCase().match(/[a-z0-9]+(?:[.,'][a-z0-9]+)*/g) ?? [] };
    const shingles = evidenceShingles(FULL_KEY);
    expect(shingles.size).toBe(Math.max(0, tokens.length - ANSWER_KEY_SHINGLE_WORDS + 1));
  });
});

describe('#175: answer-key path collisions', () => {
  it('matches an exact segment under any directory and rejects near misses', () => {
    const collisions = findAnswerKeyPathCollisions(
      ['skills/tests/SKILL.md', 'skills/run_tests/SKILL.md', 'scripts/tests.py', 'sub_agents/reference/AGENT.md'],
      ['tests', 'reference']
    );
    expect(collisions).toEqual(['skills/tests/SKILL.md', 'sub_agents/reference/AGENT.md']);
  });

  it('normalizes windows separators', () => {
    expect(findAnswerKeyPathCollisions(['skills\\tests\\SKILL.md'], ['tests'])).toEqual([
      'skills/tests/SKILL.md'
    ]);
  });

  it('an empty forbidden list matches nothing', () => {
    expect(findAnswerKeyPathCollisions(['skills/tests/SKILL.md'], [])).toEqual([]);
  });

  it('extracts the component paths a patch would create', () => {
    const patch = {
      id: 'p',
      edits: {
        skills: { kind: 'skills', skills: [{ name: 'tests' }, { name: 'run_tests' }] },
        subagents: { kind: 'subagents', agents: [{ name: 'reference' }] },
        scripts: {
          kind: 'scripts',
          scripts: [{ path: 'scripts\\tests.py', language: 'python', code: '' }]
        }
      }
    } as unknown as EightSurfacePatch;
    expect(patchEvidencePaths(patch)).toEqual([
      'skills/tests/SKILL.md',
      'skills/run_tests/SKILL.md',
      'sub_agents/reference/AGENT.md',
      'scripts/tests.py'
    ]);
  });

  it('a colliding patch produces a mark with the colliding path; a clean patch is undefined', () => {
    const pathPolicy = policy({ answerKey: undefined, forbiddenPathSegments: ['tests', 'reference'] });
    const colliding = {
      id: 'p',
      edits: { skills: { kind: 'skills', skills: [{ name: 'tests' }] } }
    } as unknown as EightSurfacePatch;
    const mark = scanPatchEvidenceIntegrity(colliding, pathPolicy);
    expect(mark?.contaminated).toBe(true);
    expect(mark?.findings[0]?.kind).toBe('answer-key-path');
    expect(mark?.findings[0]?.collidingPath).toBe('skills/tests/SKILL.md');

    const clean = {
      id: 'p',
      edits: { skills: { kind: 'skills', skills: [{ name: 'run_tests' }] } }
    } as unknown as EightSurfacePatch;
    expect(scanPatchEvidenceIntegrity(clean, pathPolicy)).toBeUndefined();
  });
});

describe('the persisted mark', () => {
  it('round-trips through metadata and rejects foreign versions', () => {
    const mark = scanTrajectoryEvidenceIntegrity(
      trajectoryOf({ deliverable: { content: FULL_KEY } }),
      policy()
    );
    expect(mark?.version).toBe(EVIDENCE_INTEGRITY_VERSION);
    const restored = readEvidenceIntegrityMark({ evidenceIntegrity: mark });
    expect(restored).toEqual(mark);

    expect(readEvidenceIntegrityMark({})).toBeUndefined();
    expect(
      readEvidenceIntegrityMark({ evidenceIntegrity: { ...mark, version: 'forged-v1' } })
    ).toBeUndefined();
    expect(
      readEvidenceIntegrityMark({
        evidenceIntegrity: { ...mark, contaminated: 'yes', withheld: true }
      })
    ).toBeUndefined();
    expect(readEvidenceIntegrityMark(undefined)).toBeUndefined();
  });

  it('the policy digest never carries criterion text', () => {
    const digest = evidenceIntegrityPolicyDigest(policy());
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(digest).not.toContain('reconciliation');
    expect(evidenceIntegrityPolicyDigest(policy())).toBe(evidenceIntegrityPolicyDigest(policy()));
  });
});

describe('quarantine: the withheld replacement', () => {
  it('replaces answer-key-contaminated evidence with a neutral note and keeps no matched words', () => {
    const source = trajectoryOf({
      status: 'succeeded',
      steps: [{ index: 0, at: 2, kind: 'result', text: FULL_KEY }],
      deliverable: { content: FULL_KEY },
      toolErrors: [{ toolName: 'fetch', message: FULL_KEY }],
      metadata: { diagnostics: ['cleanup released resources with 0 failure(s)'] }
    });
    const mark = scanTrajectoryEvidenceIntegrity(source, policy())!;
    const quarantined = quarantineTrajectory(source, mark);
    const serialized = JSON.stringify(quarantined);

    expect(quarantined.status).toBe('failed');
    expect(quarantined.deliverable).toBeUndefined();
    expect(quarantined.steps).toHaveLength(1);
    expect(quarantined.steps[0]?.kind).toBe('system');
    expect(quarantined.toolErrors).toEqual([]);
    expect(serialized).not.toContain('reconciliation');
    expect(serialized).not.toContain('counterparty');
    expect(quarantined.failureSignals[0]?.code).toBe('evidence-contaminated');
    expect(quarantined.failureSignals[0]?.repairable).toBe(false);
    expect(quarantined.error?.name).toBe('EvidenceIntegrityError');
    expect(readEvidenceIntegrityMark(quarantined.metadata)?.contaminated).toBe(true);
    expect(quarantined.id).toBe('traj-x');
    expect(quarantined.startedAt).toBe(1);
  });

  it('a sentinel-only quarantine keeps repairability and safe diagnostics', () => {
    const source = trajectoryOf({
      deliverable: { content: '(failed to read trajectory: OSError)' },
      metadata: { diagnostics: ['branch cleanup released resources with 0 failure(s)'] }
    });
    const mark = scanTrajectoryEvidenceIntegrity(source, policy())!;
    const quarantined = quarantineTrajectory(source, mark);
    expect(quarantined.failureSignals[0]?.code).toBe('missing-trajectory-sentinel');
    expect(quarantined.failureSignals[0]?.repairable).toBe(true);
    expect(quarantined.metadata?.['diagnostics']).toEqual([
      'branch cleanup released resources with 0 failure(s)'
    ]);
  });

  it('a path-only quarantine is repairable (rename the component)', () => {
    const source = trajectoryOf({});
    const mark = {
      version: EVIDENCE_INTEGRITY_VERSION,
      contaminated: true,
      withheld: true,
      findings: [{ kind: 'answer-key-path' as const, location: 'patch', collidingPath: 'skills/tests/SKILL.md' }]
    };
    const quarantined = quarantineTrajectory(source, mark);
    expect(quarantined.failureSignals[0]?.code).toBe('answer-key-path');
    expect(quarantined.failureSignals[0]?.repairable).toBe(true);
  });
});
