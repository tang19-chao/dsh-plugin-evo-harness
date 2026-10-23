/**
 * P3-C2: memory-augmented candidates, invariant hard isolation, support gating.
 *
 * Acceptance covered here:
 *   - plan section 6.6: the top-2 unknown, positive-return memory actions join
 *     the candidate set with baseLogit 0 and source 'memory_augmented';
 *   - plan section 7.1: an explore_invariant slot NEVER sees a memory-augmented
 *     candidate, and a recover slot is never augmented either;
 *   - rehydration reachability: no lesson source (Phase 3) => every augmentation
 *     is dropped with a diagnostic and nothing is fabricated;
 *   - minSupportForStrongPrior gates the advantage contribution.
 */
import { describe, expect, it } from 'vitest';
import type {
  JitCandidate,
  LessonExecutionPatch,
  ScoredExperience
} from '../../../src/types/contracts';
import {
  DEFAULT_MAX_AUGMENTED,
  DEFAULT_MIN_SUPPORT_FOR_STRONG_PRIOR,
  augmentCandidates,
  gateAdvantageBySupport,
  guidanceFilterForSlot,
  isAugmentationForbidden,
  isMetaActionKey,
  metaActionKey,
  rehydratePatch,
  type AugmentDiagnostic,
  type LessonPatchSource
} from '../../../src/jitrl/candidate-augmenter';
import { abstractMetaState } from '../../../src/jitrl/state-abstraction';

const T0 = 1_700_000_000_000;

const STATE = abstractMetaState({
  task: { id: 'task-l2', prompt: 'Fix the failing build.', taskSignature: 'fix-build' },
  round: 1,
  parentDepth: 1,
  memoryConfidence: 0.5,
  referenceStatus: 'missing'
});

/** One L2 experience record at an arbitrary action key. */
function record(
  id: string,
  actionKey: string,
  value: number,
  overrides: { readonly guidance?: 'memory' | 'guidance_free'; readonly nodeId?: string } = {}
): ScoredExperience {
  return {
    record: {
      id,
      level: 'proposal',
      state: STATE,
      actionKey,
      reward: value,
      return: value,
      rewardSources: { surrogate: value },
      guidance: overrides.guidance ?? 'memory',
      policyId: 'pi-0',
      sessionId: 'session-l2',
      treeId: 'tree-l2',
      nodeId: overrides.nodeId ?? id,
      createdAt: T0 - 100,
      redacted: true
    },
    similarity: 0.9,
    weight: 0.9
  };
}

function candidate(actionKey: string): JitCandidate<string> {
  return { actionKey, baseLogit: 1, source: 'llm', payload: actionKey };
}

/** Registry that lets a test wire a deterministic lesson source. */
function lessonSource(
  byNode: Readonly<Record<string, LessonExecutionPatch>> = {},
  byPatch: Readonly<Record<string, LessonExecutionPatch>> = {}
): LessonPatchSource {
  return {
    findByNodeId: (nodeId) => byNode[nodeId],
    findByPatchId: (patchId) => byPatch[patchId]
  };
}

const SHORT_DIFF: LessonExecutionPatch = {
  summary: 'add a guardrail precondition',
  componentDiffs: {
    guardrails: JSON.stringify({ kind: 'guardrails', toolPreconditions: [{ toolName: 'shell', rule: 'deny' }] })
  },
  patchId: 'patch-short'
};

describe('rehydratePatch', () => {
  it('returns undefined when no lesson source is wired (the Phase 3 state)', () => {
    // This is the documented reachability answer: with no lesson store every
    // augmentation is dropped and nothing is fabricated.
    expect(rehydratePatch({ nodeId: 'node-1' }, undefined)).toBeUndefined();
    expect(rehydratePatch({ nodeId: 'node-1', treeId: 'tree-l2' }, undefined)).toBeUndefined();
    expect(rehydratePatch({}, undefined)).toBeUndefined();
  });

  it('returns undefined when the source has no lesson for the node', () => {
    expect(rehydratePatch({ nodeId: 'node-1' }, lessonSource())).toBeUndefined();
  });

  it('rebuilds a short, complete componentDiff into structured edits', () => {
    const rehydrated = rehydratePatch({ nodeId: 'node-short' }, lessonSource({ 'node-short': SHORT_DIFF }));
    expect(rehydrated).toBeDefined();
    expect(rehydrated?.sourcePatchId).toBe('patch-short');
    expect(rehydrated?.summary).toBe('add a guardrail precondition');
    expect(rehydrated?.edits.guardrails).toEqual({
      kind: 'guardrails',
      toolPreconditions: [{ toolName: 'shell', rule: 'deny' }]
    });
  });

  it('rejects a truncated componentDiff instead of guessing the missing tail', () => {
    // The reflector stores surfaceEditSummary(), which is a 400-char truncation
    // of the JSON. A long edit therefore does not parse back.
    const truncated: LessonExecutionPatch = {
      summary: 'long edit',
      componentDiffs: {
        skills: '{"kind":"skills","skills":[{"name":"migrate","markdown":"' + 'x'.repeat(500) + '"'
      },
      patchId: 'patch-long'
    };
    expect(rehydratePatch({ nodeId: 'node-long' }, lessonSource({ 'node-long': truncated }))).toBeUndefined();
  });

  it('rejects a patch whose diffs carry no known surface', () => {
    const alien: LessonExecutionPatch = {
      summary: 'alien surface',
      componentDiffs: { not_a_surface: JSON.stringify({ kind: 'nope' }) }
    };
    expect(rehydratePatch({ nodeId: 'node-alien' }, lessonSource({ 'node-alien': alien }))).toBeUndefined();
  });

  it('falls back to the patch-id lookup when the node lookup misses', () => {
    const rehydrated = rehydratePatch(
      { nodeId: 'patch-short' },
      lessonSource({}, { 'patch-short': SHORT_DIFF })
    );
    expect(rehydrated?.sourcePatchId).toBe('patch-short');
  });
});

describe('augmentCandidates', () => {
  it('adds the top-2 unknown positive-return memory actions with baseLogit 0', () => {
    const existing = candidate('guardrails:precondition(shell)');
    const neighbors = [
      record('m1', 'tool_guidance:rewrite(edit_file)', 2.4),
      record('m2', 'skills:mount(migrate)', 1.8),
      record('m3', 'scripts:mount(check)', 0.5),
      record('m4', 'plugins:middleware(after_tool:audit)', 3.1)
    ];
    const result = augmentCandidates([existing], neighbors, {
      lessonSource: lessonSource({
        m1: { ...SHORT_DIFF, patchId: 'p1' },
        m2: { ...SHORT_DIFF, patchId: 'p2' },
        m3: { ...SHORT_DIFF, patchId: 'p3' },
        m4: { ...SHORT_DIFF, patchId: 'p4' }
      }),
      minSupportForStrongPrior: 1
    });
    // top-2 by return: m4 (3.1) then m1 (2.4).
    expect(result.augmented).toBe(2);
    expect(result.candidates[0]).toBe(existing);
    const added = result.candidates.slice(1);
    expect(added.map((entry) => entry.actionKey)).toEqual([
      'plugins:middleware(after_tool:audit)',
      'tool_guidance:rewrite(edit_file)'
    ]);
    for (const entry of added) {
      expect(entry.baseLogit).toBe(0);
      expect(entry.source).toBe('memory_augmented');
    }
  });

  it('never duplicates an action key the proposer already offered', () => {
    const known = candidate('tool_guidance:rewrite(edit_file)');
    const neighbors = [record('m1', 'tool_guidance:rewrite(edit_file)', 2.4)];
    const result = augmentCandidates([known], neighbors, {
      lessonSource: lessonSource({ m1: SHORT_DIFF }),
      minSupportForStrongPrior: 1
    });
    expect(result.augmented).toBe(0);
    expect(result.candidates).toHaveLength(1);
  });

  it('ignores actions with non-positive return', () => {
    const neighbors = [
      record('m1', 'skills:mount(bad)', -1),
      record('m2', 'skills:mount(zero)', 0)
    ];
    const result = augmentCandidates([candidate('a')], neighbors, {
      lessonSource: lessonSource({ m1: SHORT_DIFF, m2: SHORT_DIFF }),
      minSupportForStrongPrior: 1
    });
    expect(result.augmented).toBe(0);
  });

  it('never seeds an L2 candidate from L1 meta experience', () => {
    const meta = record('m1', 'skills:mount(x)', 3);
    const crossLevel = { ...meta, record: { ...meta.record, level: 'meta' as const } };
    const result = augmentCandidates([candidate('a')], [crossLevel], {
      lessonSource: lessonSource({ m1: SHORT_DIFF }),
      minSupportForStrongPrior: 1
    });
    expect(result.augmented).toBe(0);
  });

  it('drops an action whose patch cannot be rehydrated and records why', () => {
    const diagnostics: AugmentDiagnostic[] = [];
    const result = augmentCandidates([candidate('a')], [record('m1', 'skills:mount(x)', 2)], {
      // No lesson source: unreachable rehydration, the Phase 3 state.
      minSupportForStrongPrior: 1,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });
    expect(result.augmented).toBe(0);
    expect(result.candidates).toHaveLength(1);
    const codes = diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain('augment_rehydrate_failed');
  });

  it('honours augmentFromMemory = false', () => {
    const result = augmentCandidates([candidate('a')], [record('m1', 'skills:mount(x)', 2)], {
      augmentFromMemory: false,
      lessonSource: lessonSource({ m1: SHORT_DIFF }),
      minSupportForStrongPrior: 1
    });
    expect(result.augmented).toBe(0);
    expect(result.candidates).toHaveLength(1);
  });

  it('adds nothing when the neighbourhood is empty', () => {
    const result = augmentCandidates([candidate('a')], []);
    expect(result.augmented).toBe(0);
    expect(result.diagnostics).toEqual([]);
  });
});

describe('plan section 7.1: invariant hard isolation', () => {
  it('forbids augmentation for explore_invariant and recover', () => {
    expect(isAugmentationForbidden('explore_invariant')).toBe(true);
    expect(isAugmentationForbidden('recover')).toBe(true);
    expect(isAugmentationForbidden('exploit')).toBe(false);
    expect(isAugmentationForbidden('explore_domain')).toBe(false);
    expect(isAugmentationForbidden(undefined)).toBe(false);
  });

  it('returns the candidate set untouched for an invariant slot even with high-G memory', () => {
    const diagnostics: AugmentDiagnostic[] = [];
    const base = [candidate('slot:explore_invariant/surf:guardrails')];
    const neighbors = [
      record('h1', 'skills:mount(high)', 3),
      record('h2', 'skills:mount(higher)', 3.5)
    ];
    const result = augmentCandidates(base, neighbors, {
      slotKind: 'explore_invariant',
      lessonSource: lessonSource({ h1: SHORT_DIFF, h2: SHORT_DIFF }),
      minSupportForStrongPrior: 1,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });
    expect(result.isolated).toBe(true);
    expect(result.augmented).toBe(0);
    expect(result.candidates).toHaveLength(1);
    // The proof the plan asks for: no memory_augmented source anywhere.
    expect(result.candidates.some((entry) => entry.source === 'memory_augmented')).toBe(false);
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain('augment_isolated');
  });

  it('also isolates recover slots (plan section 7.1 table: no augmentation)', () => {
    const result = augmentCandidates([candidate('a')], [record('m1', 'skills:mount(x)', 2)], {
      slotKind: 'recover',
      lessonSource: lessonSource({ m1: SHORT_DIFF }),
      minSupportForStrongPrior: 1
    });
    expect(result.isolated).toBe(true);
    expect(result.augmented).toBe(0);
  });

  it('does augment exploit and explore_domain slots', () => {
    for (const slotKind of ['exploit', 'explore_domain'] as const) {
      const result = augmentCandidates([candidate('a')], [record('m1', 'skills:mount(x)', 2)], {
        slotKind,
        lessonSource: lessonSource({ m1: SHORT_DIFF }),
        minSupportForStrongPrior: 1
      });
      expect(result.isolated).toBe(false);
      expect(result.augmented).toBe(1);
    }
  });

  it('pins the guidance filter the invariant track must retrieve with', () => {
    // Section 7.1: invariant slots only ever see guidance_free experience.
    expect(guidanceFilterForSlot('explore_invariant')).toBe('guidance_free');
    expect(guidanceFilterForSlot('exploit')).toBeUndefined();
    expect(guidanceFilterForSlot('explore_domain')).toBeUndefined();
    expect(guidanceFilterForSlot('recover')).toBeUndefined();
  });
});

describe('minSupportForStrongPrior', () => {
  it('clamps the advantage to 0 below the support threshold', () => {
    expect(gateAdvantageBySupport(2.5, 1, 3)).toBe(0);
    expect(gateAdvantageBySupport(2.5, 2, 3)).toBe(0);
    expect(gateAdvantageBySupport(2.5, 3, 3)).toBe(2.5);
    expect(gateAdvantageBySupport(2.5, 10, 3)).toBe(2.5);
    expect(gateAdvantageBySupport(-2.5, 1, 3)).toBe(0);
  });

  it('defaults to the frozen threshold and tolerates hostile inputs', () => {
    expect(DEFAULT_MIN_SUPPORT_FOR_STRONG_PRIOR).toBe(3);
    expect(gateAdvantageBySupport(1, 2)).toBe(0);
    expect(gateAdvantageBySupport(1, 3)).toBe(1);
    expect(gateAdvantageBySupport(Number.NaN, 99, 3)).toBe(0);
    expect(gateAdvantageBySupport(1, 99, Number.NaN)).toBe(1);
    expect(gateAdvantageBySupport(1, 99, -5)).toBe(1);
  });

  it('skips a memory action whose support is below the threshold, with a reason', () => {
    const diagnostics: AugmentDiagnostic[] = [];
    const result = augmentCandidates([candidate('a')], [record('m1', 'skills:mount(rare)', 3)], {
      lessonSource: lessonSource({ m1: SHORT_DIFF }),
      minSupportForStrongPrior: 3,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });
    expect(result.augmented).toBe(0);
    const codes = diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain('augment_low_support');
  });

  it('accepts an action once its support reaches the threshold', () => {
    const neighbors = [
      record('m1', 'skills:mount(common)', 2),
      record('m2', 'skills:mount(common)', 1.5),
      record('m3', 'skills:mount(common)', 1.2)
    ];
    const result = augmentCandidates([candidate('a')], neighbors, {
      lessonSource: lessonSource({ m1: SHORT_DIFF, m2: SHORT_DIFF, m3: SHORT_DIFF }),
      minSupportForStrongPrior: 3
    });
    expect(result.augmented).toBe(1);
    expect(result.candidates[1]?.actionKey).toBe('skills:mount(common)');
  });
});

describe('action key helpers', () => {
  it('builds L1 keys through the existing normalizer', () => {
    expect(metaActionKey('exploit')).toBe('slot:exploit');
    expect(metaActionKey('explore_invariant', ['guardrails'])).toBe(
      'slot:explore_invariant/surf:guardrails'
    );
  });

  it('recognises L1 keys and rejects L2/L3 ones', () => {
    expect(isMetaActionKey('slot:exploit')).toBe(true);
    expect(isMetaActionKey('slot:recover/surf:memory')).toBe(true);
    expect(isMetaActionKey('skills:mount(x)')).toBe(false);
    expect(isMetaActionKey('tool:shell(cmd=pnpm*)')).toBe(false);
  });

  it('keeps the documented default augmentation width', () => {
    expect(DEFAULT_MAX_AUGMENTED).toBe(2);
  });
});
