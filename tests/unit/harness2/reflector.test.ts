import { describe, expect, it } from 'vitest';
import {
  HARNESS_COMPONENT_KEYS,
  type CanonicalLesson,
  type CompositionResult,
  type DiscoveryTreeSnapshot,
  type EightSurfacePatch,
  type ProbeTrajectory,
  type ReflectionRequest
} from '../../../src/types/contracts';
import { createEvidenceReflector, type HarnessReflectorOptions } from '../../../src/harness2/reflector';
import { createDeterministicIdFactory } from '../../../src/harness2/shared';
import {
  fixedClock,
  makeAssessment,
  makeComposition,
  makeLesson,
  makeNode,
  makePatch,
  makeRecall,
  makeReflectionRequest,
  makeTrajectory,
  makeTree,
  promptText,
  requestAt,
  scriptedModel
} from './fixtures';

const HEADERS = JSON.stringify({
  lessons: [
    {
      candidateId: 'traj_node_b',
      title: 'Mount a migration script for schema-first tasks',
      whenToApply: ['needsSchemaPreflight=true'],
      whenNotToApply: ['do not apply while the schema is unknown']
    },
    {
      candidateId: 'traj_node_c',
      title: 'Avoid unquoted identifier guardrail rules',
      whenToApply: ['needsIdentifierQuoting=true'],
      whenNotToApply: ['do not apply when identifiers are already pre-quoted']
    }
  ]
});

function referenceTrajectory(): ProbeTrajectory {
  return makeTrajectory({
    id: 'traj_reference',
    role: 'reference',
    branchId: 'branch_ref',
    branchNamespace: 'probe_sess_1_branch_ref',
    patchId: 'patch_ref',
    patchOrigin: 'reference',
    surfaceKeys: [],
    status: 'failed',
    metrics: { steps: 9, toolCalls: 7, toolErrors: 3, durationMs: 3000 },
    deliverable: undefined,
    failureSignals: [{ kind: 'syntax_error', message: 'generated script failed to parse' }],
    error: { name: 'SyntaxError', message: 'generated script failed to parse' }
  });
}

function successTrajectory(): ProbeTrajectory {
  return makeTrajectory({
    id: 'traj_node_b',
    nodeId: 'node_b',
    branchId: 'branch_b',
    branchNamespace: 'probe_sess_1_branch_b',
    patchId: 'patch_node_b',
    patchOrigin: 'invariant',
    surfaceKeys: ['scripts'],
    status: 'succeeded',
    metrics: { steps: 3, toolCalls: 2, toolErrors: 0, durationMs: 700 },
    deliverable: { content: 'schema diff plus rollback steps', format: 'markdown' }
  });
}

function failureTrajectory(): ProbeTrajectory {
  return makeTrajectory({
    id: 'traj_node_c',
    nodeId: 'node_c',
    branchId: 'branch_c',
    branchNamespace: 'probe_sess_1_branch_c',
    patchId: 'patch_node_c',
    surfaceKeys: ['guardrails'],
    status: 'failed',
    metrics: { steps: 12, toolCalls: 10, toolErrors: 5, durationMs: 4200 },
    deliverable: undefined,
    failureSignals: [{ kind: 'tool_error', message: 'quoting helper crashed' }],
    error: { name: 'ToolError', message: 'quoting helper crashed' }
  });
}

function successPatch(): EightSurfacePatch {
  return makePatch({
    id: 'patch_node_b',
    branchId: 'branch_b',
    origin: 'invariant',
    guidance: 'guidance_free',
    label: 'explore_invariant:scripts',
    purpose: 'explore',
    edits: {
      scripts: {
        kind: 'scripts',
        scripts: [{ path: 'tools/migrate.py', language: 'python', code: 'print(1)' }]
      }
    }
  });
}

function failurePatch(): EightSurfacePatch {
  return makePatch({
    id: 'patch_node_c',
    branchId: 'branch_c',
    origin: 'domain',
    guidance: 'memory',
    label: 'explore_domain:guardrails',
    purpose: 'explore',
    edits: { guardrails: { kind: 'guardrails', appendRules: ['Always quote identifiers.'] } }
  });
}

function tree(): DiscoveryTreeSnapshot {
  return makeTree([
    makeNode({
      id: 'node_b',
      branchId: 'branch_b',
      patchId: 'patch_node_b',
      patchOrigin: 'invariant',
      guidance: 'guidance_free',
      status: 'succeeded',
      slot: 'explore_invariant'
    }),
    makeNode({
      id: 'node_c',
      branchId: 'branch_c',
      patchId: 'patch_node_c',
      patchOrigin: 'domain',
      guidance: 'memory',
      status: 'failed',
      slot: 'explore_domain'
    })
  ]);
}

function composition(overrides: Partial<CompositionResult> = {}): CompositionResult {
  return makeComposition({
    selectedBranchId: 'branch_b',
    selectedNodeId: 'node_b',
    selectedTrajectoryId: 'traj_node_b',
    selectedPatch: successPatch(),
    assessments: [
      makeAssessment({ alias: 'candidate_A', branchId: 'branch_b', nodeId: 'node_b', selected: true, adoptionRatio: 0.82 }),
      makeAssessment({
        alias: 'candidate_B',
        branchId: 'branch_c',
        nodeId: 'node_c',
        selected: false,
        adoptionRatio: 0.2,
        rejectedReason: 'tool error'
      })
    ],
    adoptionRatios: { candidate_A: 0.82, candidate_B: 0.2 },
    ...overrides
  });
}

function baseRequest(overrides: Partial<ReflectionRequest> = {}): ReflectionRequest {
  const reference = referenceTrajectory();
  return makeReflectionRequest({
    tree: tree(),
    composition: composition(),
    trajectories: [reference, successTrajectory(), failureTrajectory()],
    referenceTrajectory: reference,
    recall: makeRecall(),
    metadata: { candidatePatches: [successPatch(), failurePatch()] },
    ...overrides
  });
}

function makeReflector(script: readonly (string | Error)[], overrides: Partial<HarnessReflectorOptions> = {}) {
  const model = scriptedModel(script);
  const reflector = createEvidenceReflector({
    model,
    now: fixedClock(),
    newId: createDeterministicIdFactory('reflect-test'),
    ...overrides
  });
  return { model, reflector };
}

/** Returns the CCG elements that are missing or structurally invalid. */
function lessonViolations(lesson: CanonicalLesson): string[] {
  const problems: string[] = [];
  if (lesson.title.trim().length === 0) problems.push('title');
  if (lesson.whenToApply.length === 0) problems.push('whenToApply');
  if (lesson.whenNotToApply.length === 0) problems.push('whenNotToApply');
  if (lesson.subFunctions.length === 0) problems.push('subFunctions');
  for (const surface of lesson.subFunctions) {
    if (!HARNESS_COMPONENT_KEYS.includes(surface)) problems.push('subFunctions:' + surface);
  }
  if (lesson.executionPatch.summary.trim().length === 0) problems.push('executionPatch.summary');
  if (lesson.verificationEvidence.referenceFailure.trim().length === 0) problems.push('verificationEvidence.referenceFailure');
  if (lesson.verificationEvidence.candidateSuccess.trim().length === 0) problems.push('verificationEvidence.candidateSuccess');
  const delta = lesson.verificationEvidence.metricsDelta;
  if (typeof delta.stepsDiff !== 'number' || typeof delta.toolErrorsDiff !== 'number') problems.push('metricsDelta');
  if (lesson.confidence === undefined || lesson.confidence < 0 || lesson.confidence > 1) problems.push('confidence');
  return problems;
}

describe('Harness² reflector / canonical lesson extraction', () => {
  it('emits a complete positive lesson for the successful candidate', async () => {
    const { reflector } = makeReflector([HEADERS]);
    const result = await reflector.reflect(baseRequest());
    const positive = result.lessons.find((lesson) => lesson.polarity === 'positive');

    expect(positive).toBeDefined();
    expect(lessonViolations(positive as CanonicalLesson)).toEqual([]);
    expect(positive?.title).toBe('Mount a migration script for schema-first tasks');
    expect(positive?.subFunctions).toEqual(['scripts']);
    expect(positive?.whenToApply).toContain('taskSignature=db-migration');
    expect(positive?.whenToApply).toContain('needsSchemaPreflight=true');
    expect(positive?.whenNotToApply).toContain(
      'do not apply when the reference failure signals of this probe are absent from the target run'
    );
    expect(positive?.whenNotToApply).toContain('do not apply while the schema is unknown');
    expect(positive?.verificationEvidence.metricsDelta).toEqual({ stepsDiff: -6, toolErrorsDiff: -3 });
    expect(positive?.verificationEvidence.referenceTrajectoryId).toBe('traj_reference');
    expect(positive?.verificationEvidence.candidateTrajectoryId).toBe('traj_node_b');
    expect(positive?.verificationEvidence.referenceFailure).toContain('reference run did not complete');
    expect(positive?.verificationEvidence.referenceFailure).toContain('syntax_error');
    expect(positive?.verificationEvidence.candidateSuccess).toContain('candidate succeeded');
    expect(positive?.executionPatch.patchId).toBe('patch_node_b');
    expect(positive?.executionPatch.componentDiffs?.scripts).toContain('migrate.py');
    expect(positive?.visibility).toBe('session');
    expect(positive?.schemaVersion).toBe(1);
    expect(positive?.sourceTreeId).toBe('tree_1');
    expect(positive?.branchId).toBe('branch_b');
    expect(positive?.taskSignature).toBe('db-migration');
    expect(positive?.confidence).toBeGreaterThan(0.5);
    expect(result.positiveCount).toBe(1);
    expect(result.negativeCount).toBe(1);
  });

  it('emits a complete negative anti-pattern lesson for the failed candidate', async () => {
    const { reflector } = makeReflector([HEADERS]);
    const result = await reflector.reflect(baseRequest());
    const negative = result.lessons.find((lesson) => lesson.polarity === 'negative');

    expect(negative).toBeDefined();
    expect(lessonViolations(negative as CanonicalLesson)).toEqual([]);
    expect(negative?.title).toBe('Avoid unquoted identifier guardrail rules');
    expect(negative?.tags).toContain('anti_pattern');
    expect(negative?.subFunctions).toEqual(['guardrails']);
    expect(negative?.whenNotToApply.join(' | ')).toContain('anti-pattern warning only');
    expect(negative?.whenToApply).toContain('observedSignal=tool_error');
    expect(negative?.verificationEvidence.candidateSuccess).toContain('candidate did not complete');
    expect(negative?.verificationEvidence.metricsDelta).toEqual({ stepsDiff: 3, toolErrorsDiff: 2 });
    expect(negative?.executionPatch.componentDiffs?.guardrails).toContain('quote identifiers');
    expect(negative?.confidence).toBeLessThan(positiveConfidence(result));
  });

  it('records the composed H* component diffs on the selected winner dossier', async () => {
    const composedPatch = makePatch({
      id: 'patch_composed_h',
      branchId: 'branch_b',
      origin: 'composed',
      purpose: 'compose',
      guidance: 'memory',
      label: 'composed:exploit:scripts',
      sourceLessonIds: ['lesson_round1', 'lesson_round2'],
      edits: {
        system_prompt: { kind: 'system_prompt', mode: 'append', content: 'composed round one prompt' },
        guardrails: { kind: 'guardrails', formatContract: 'composed round two contract' },
        scripts: {
          kind: 'scripts',
          scripts: [{ path: 'tools/migrate.py', language: 'python', code: 'print(1)' }]
        }
      }
    });
    const { reflector } = makeReflector([HEADERS]);
    const result = await reflector.reflect(baseRequest({ composition: composition({ composedPatch }) }));

    // The composed id is freshly generated: no trajectory carries it, so the old patch-id
    // lookup could never find it and the winner lesson lost the merged ancestor diffs.
    expect(composedPatch.id).not.toBe('patch_node_b');
    expect(composedPatch.id).not.toBe('patch_node_c');
    expect(composedPatch.id).not.toBe('patch_ref');

    const winner = result.lessons.find((lesson) => lesson.metadata?.nodeId === 'node_b');
    expect(winner).toBeDefined();
    expect(lessonViolations(winner as CanonicalLesson)).toEqual([]);
    expect(Object.keys(winner?.executionPatch.componentDiffs ?? {}).sort()).toEqual([
      'guardrails',
      'scripts',
      'system_prompt'
    ]);
    expect(winner?.executionPatch.componentDiffs?.system_prompt).toContain('composed round one prompt');
    expect(winner?.executionPatch.componentDiffs?.guardrails).toContain('composed round two contract');
    // the winning trajectory's own patch id is still recorded for the evidence chain
    expect(winner?.executionPatch.patchId).toBe('patch_node_b');
  });

  it('keeps each non-winner dossier on its own incremental patch', async () => {
    const composedPatch = makePatch({
      id: 'patch_composed_h',
      branchId: 'branch_b',
      origin: 'composed',
      purpose: 'compose',
      guidance: 'memory',
      label: 'composed:exploit:scripts',
      edits: {
        system_prompt: { kind: 'system_prompt', mode: 'append', content: 'composed round one prompt' },
        guardrails: { kind: 'guardrails', formatContract: 'composed round two contract' },
        scripts: {
          kind: 'scripts',
          scripts: [{ path: 'tools/migrate.py', language: 'python', code: 'print(1)' }]
        }
      }
    });
    const { reflector } = makeReflector([HEADERS]);
    const result = await reflector.reflect(baseRequest({ composition: composition({ composedPatch }) }));

    // node_c is not selected, so it keeps its own failure patch (guardrails only).
    const loser = result.lessons.find((lesson) => lesson.metadata?.nodeId === 'node_c');
    expect(loser).toBeDefined();
    expect(Object.keys(loser?.executionPatch.componentDiffs ?? {})).toEqual(['guardrails']);
    expect(loser?.executionPatch.componentDiffs?.guardrails).toContain('quote identifiers');
    expect(loser?.executionPatch.componentDiffs?.system_prompt).toBeUndefined();
    expect(loser?.executionPatch.componentDiffs?.scripts).toBeUndefined();
  });

  it('falls back to the trajectory patch when composedPatch is null', async () => {
    const { reflector } = makeReflector([HEADERS]);
    const result = await reflector.reflect(
      baseRequest({ composition: composition({ composedPatch: null }) })
    );

    const winner = result.lessons.find((lesson) => lesson.metadata?.nodeId === 'node_b');
    expect(winner).toBeDefined();
    // exactly the pre-fix behaviour: the winner's own incremental patch, no composed merge
    expect(Object.keys(winner?.executionPatch.componentDiffs ?? {})).toEqual(['scripts']);
    expect(winner?.executionPatch.componentDiffs?.system_prompt).toBeUndefined();
  });

  it('keeps every CCG element when the model returns unusable prose', async () => {
    const { reflector } = makeReflector(['I am unable to produce JSON today.']);
    const result = await reflector.reflect(baseRequest());

    expect(result.lessons).toHaveLength(2);
    for (const lesson of result.lessons) {
      expect(lessonViolations(lesson)).toEqual([]);
    }
    expect(result.lessons[0]?.title).toContain('Adopt ');
    expect(result.lessons[1]?.title).toContain('Avoid ');
    expect(result.diagnostics.join(' | ')).toContain('deterministic headers');
  });

  it('sends a json reflect request that lists the mandatory clauses per dossier', async () => {
    const { model, reflector } = makeReflector([HEADERS]);
    await reflector.reflect(baseRequest());
    const reflectRequest = requestAt(model);
    const prompt = promptText(model);

    expect(reflectRequest.purpose).toBe('reflect');
    expect(reflectRequest.responseFormat).toBe('json');
    expect(prompt).toContain('candidateId=traj_node_b');
    expect(prompt).toContain('requiredWhenToApply:');
    expect(prompt).toContain('requiredWhenNotToApply:');
    expect(prompt).toContain('metricsDelta: stepsDiff=-6 toolErrorsDiff=-3');
  });
});

describe('Harness² reflector / evidence edge cases', () => {
  it('measures deltas against a zero baseline when no reference run exists', async () => {
    const { reflector } = makeReflector([HEADERS]);
    const result = await reflector.reflect(
      baseRequest({ trajectories: [successTrajectory()], referenceTrajectory: undefined })
    );
    const lesson = result.lessons[0];

    expect(lesson?.verificationEvidence.referenceFailure).toContain('zero-execution baseline');
    expect(lesson?.verificationEvidence.metricsDelta).toEqual({ stepsDiff: 3, toolErrorsDiff: 0 });
    expect(lesson?.verificationEvidence.referenceTrajectoryId).toBeUndefined();
    expect(lesson?.verificationEvidence.candidateTrajectoryId).toBe('traj_node_b');
  });

  it('skips a candidate with no surface keys and no identifiable patch', async () => {
    const ghost = makeTrajectory({
      id: 'traj_ghost',
      nodeId: 'node_ghost',
      branchId: 'branch_ghost',
      patchId: 'patch_missing',
      surfaceKeys: []
    });
    const { reflector } = makeReflector([HEADERS]);
    const result = await reflector.reflect(
      baseRequest({
        tree: makeTree([]),
        composition: makeComposition(),
        trajectories: [referenceTrajectory(), successTrajectory(), ghost],
        metadata: {}
      })
    );

    expect(result.lessons).toHaveLength(1);
    expect(result.diagnostics.join(' | ')).toContain('unverifiable lesson');
  });

  it('returns an empty result with a diagnostic when there is nothing to reflect on', async () => {
    const { reflector } = makeReflector([]);
    const result = await reflector.reflect(makeReflectionRequest({ trajectories: [] }));
    expect(result.lessons).toEqual([]);
    expect(result.positiveCount).toBe(0);
    expect(result.negativeCount).toBe(0);
    expect(result.diagnostics.join(' | ')).toContain('nothing to reflect on');
  });

  it('flags a lesson that restates a recalled lesson and stays honest about it', async () => {
    const recall = makeRecall({
      positiveLessons: [
        makeLesson({ id: 'lesson_dup', title: 'Mount a migration script for schema-first tasks' })
      ],
      negativeLessons: []
    });
    const { reflector } = makeReflector([HEADERS]);
    const result = await reflector.reflect(baseRequest({ recall }));
    const positive = result.lessons.find((lesson) => lesson.polarity === 'positive');

    expect(result.diagnostics.join(' | ')).toContain('restates recalled lesson lesson_dup');
    expect(positive?.metadata?.recalledDuplicateOf).toBe('lesson_dup');
  });

  it('derives visibility and branch id from a branch scope', async () => {
    const { reflector } = makeReflector([HEADERS]);
    const result = await reflector.reflect(
      baseRequest({ scope: { kind: 'branch', sessionId: 'sess_1', branchId: 'branch_b' } })
    );
    for (const lesson of result.lessons) {
      expect(lesson.visibility).toBe('branch_private');
      expect(lesson.branchId).toBe('branch_b');
    }
  });

  it('is deterministic for identical inputs', async () => {
    const first = await makeReflector([HEADERS]).reflector.reflect(baseRequest());
    const second = await makeReflector([HEADERS]).reflector.reflect(baseRequest());
    expect(second).toEqual(first);
  });
});

function positiveConfidence(result: { lessons: readonly CanonicalLesson[] }): number {
  const positive = result.lessons.find((lesson) => lesson.polarity === 'positive');
  return positive?.confidence ?? 0;
}
