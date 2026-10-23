import { describe, expect, it } from 'vitest';
import type { ComposeRequest, ContrastDimension, ProbeCandidate, ProbeTrajectory } from '../../../src/types/contracts';
import {
  CONTRAST_DIMENSIONS,
  computeBehavioralContrasts,
  createAnonymousComposer,
  scoreCandidateEvidence,
  ADVICE_LEAKAGE_RISK_RECORD
} from '../../../src/harness2/composer';
import { createDeterministicIdFactory, stripStructuredAdvice } from '../../../src/harness2/shared';
import { fixedClock, makeCandidate, makePatch, makeTask, makeTrajectory, promptText, requestAt, scriptedModel } from './fixtures';

const JUDGE_VERDICT = JSON.stringify({
  ranking: ['candidate_A', 'candidate_B', 'candidate_C'],
  assessments: [
    { alias: 'candidate_A', rationale: 'completed the task' },
    { alias: 'candidate_B', rationale: 'completed with fewer resources', rejectedReason: 'ranked below candidate_A' },
    { alias: 'candidate_C', rationale: 'did not finish', rejectedReason: 'candidate C errored out' }
  ]
});

function referenceTrajectory(): ProbeTrajectory {
  return makeTrajectory({
    id: 'traj_reference',
    role: 'reference',
    branchId: 'branch_ref',
    branchNamespace: 'probe_sess_1_branch_ref',
    status: 'failed',
    patchId: 'patch_ref',
    patchOrigin: 'reference',
    surfaceKeys: [],
    metrics: { steps: 10, toolCalls: 8, toolErrors: 4, durationMs: 2000 },
    deliverable: undefined,
    failureSignals: [{ kind: 'syntax_error', message: 'unexpected token in generated script' }],
    error: { name: 'SyntaxError', message: 'unexpected token in generated script' }
  });
}

/** alpha is wasteful, beta is efficient, gamma crashed. */
function candidateSet(): readonly ProbeCandidate[] {
  const alpha = makeCandidate({
    nodeId: 'node_a',
    branchId: 'branch_a',
    patch: makePatch({ id: 'patch_node_a', branchId: 'branch_a', origin: 'domain', guidance: 'memory' }),
    trajectory: makeTrajectory({
      id: 'traj_node_a',
      nodeId: 'node_a',
      branchId: 'branch_a',
      branchNamespace: 'probe_sess_1_branch_a',
      patchId: 'patch_node_a',
      status: 'succeeded',
      metrics: { steps: 30, toolCalls: 26, toolErrors: 12, durationMs: 9000 },
      // The deliverable deliberately names its own branch so the test can prove redaction.
      deliverable: { content: 'result for branch_a written by node_a', format: 'text' },
      failureSignals: [{ kind: 'repeated_failure', message: 'retried the same failing command' }]
    })
  });
  const beta = makeCandidate({
    nodeId: 'node_b',
    branchId: 'branch_b',
    patch: makePatch({
      id: 'patch_node_b',
      branchId: 'branch_b',
      origin: 'invariant',
      guidance: 'guidance_free',
      purpose: 'explore',
      label: 'explore_invariant:scripts'
    }),
    trajectory: makeTrajectory({
      id: 'traj_node_b',
      nodeId: 'node_b',
      branchId: 'branch_b',
      branchNamespace: 'probe_sess_1_branch_b',
      patchId: 'patch_node_b',
      patchOrigin: 'invariant',
      status: 'succeeded',
      metrics: { steps: 3, toolCalls: 2, toolErrors: 0, durationMs: 500 },
      deliverable: {
        content: 'migration plan with schema diff, rollback steps and verification queries',
        format: 'markdown'
      }
    })
  });
  const gamma = makeCandidate({
    nodeId: 'node_c',
    branchId: 'branch_c',
    patch: makePatch({ id: 'patch_node_c', branchId: 'branch_c' }),
    trajectory: makeTrajectory({
      id: 'traj_node_c',
      nodeId: 'node_c',
      branchId: 'branch_c',
      branchNamespace: 'probe_sess_1_branch_c',
      patchId: 'patch_node_c',
      status: 'failed',
      metrics: { steps: 12, toolCalls: 10, toolErrors: 5, durationMs: 4000 },
      deliverable: undefined,
      failureSignals: [{ kind: 'tool_error', message: 'sandbox tool crashed' }],
      error: { name: 'ToolError', message: 'sandbox tool crashed' }
    })
  });
  return [alpha, beta, gamma];
}

function composeRequest(
  script: readonly (string | Error)[],
  candidates: readonly ProbeCandidate[] = candidateSet()
) {
  const model = scriptedModel(script);
  const composer = createAnonymousComposer({
    model,
    now: fixedClock(),
    newId: createDeterministicIdFactory('compose-test')
  });
  const request: ComposeRequest = {
    task: makeTask(),
    sessionId: 'sess_1',
    candidates,
    reference: referenceTrajectory(),
    policyId: 'policy_1'
  };
  return { model, composer, request, candidates };
}

describe('Harness² composer / anonymity', () => {
  it('shows the judge only aliases, behavior and redacted text', async () => {
    const { model, composer, request } = composeRequest([JUDGE_VERDICT]);
    await composer.compose(request);

    const judgeRequest = requestAt(model);
    const prompt = promptText(model);

    expect(judgeRequest.purpose).toBe('compose');
    expect(judgeRequest.responseFormat).toBe('json');
    expect(judgeRequest.metadata?.anonymous).toBe(true);
    expect(prompt).toContain('candidate_A');
    expect(prompt).toContain('candidate_B');
    expect(prompt).toContain('candidate_C');
    for (const identifier of ['branch_a', 'node_a', 'patch_node_a', 'branch_ref', 'traj_reference', 'branch_c']) {
      expect(prompt).not.toContain(identifier);
    }
    expect(prompt).toContain('[redacted]');
    expect(prompt).toContain('Behavioral contrast vs reference');
  });
});

describe('Harness² composer / evidence-backed selection', () => {
  it('selects the evidence-supported successful candidate and reports adoption ratios', async () => {
    const { composer, request, candidates } = composeRequest([JUDGE_VERDICT]);
    const result = await composer.compose(request);
    const beta = candidates[1];
    expect(beta).toBeDefined();

    expect(result.selectedNodeId).toBe('node_b');
    expect(result.selectedBranchId).toBe('branch_b');
    expect(result.selectedTrajectoryId).toBe('traj_node_b');
    expect(result.selectedPatch?.id).toBe('patch_node_b');
    expect(result.selectedPatch?.origin).toBe('invariant');

    expect(result.composedPatch).not.toBeNull();
    expect(result.composedPatch?.origin).toBe('composed');
    expect(result.composedPatch?.purpose).toBe('compose');
    expect(result.composedPatch?.guidance).toBe('guidance_free');
    expect(result.composedPatch?.parentPatchIds).toEqual(['patch_node_b']);
    expect(result.composedPatch?.sessionId).toBe('sess_1');
    expect(result.composedPatch?.edits.guardrails?.kind).toBe('guardrails');

    // Single round: the winner has no parentPatchIds and no candidate matches reference.patchId,
    // so the composed H* is byte-for-byte the winning patch's edits and lessons.
    expect(result.composedPatch?.edits).toEqual(beta?.patch.edits);
    expect(result.composedPatch?.sourceLessonIds).toEqual(beta?.patch.sourceLessonIds ?? []);
    expect(result.composedPatch?.metadata?.basePatchId).toBeUndefined();
    expect(result.composedPatch?.metadata?.baseResolution).toBeUndefined();
    expect(result.composedPatch?.rationale ?? '').not.toContain(' over ');

    expect(result.assessments).toHaveLength(3);
    expect(result.assessments.filter((assessment) => assessment.selected)).toHaveLength(1);
    for (const assessment of result.assessments) {
      expect(assessment.adoptionRatio).toBeGreaterThanOrEqual(0);
      expect(assessment.adoptionRatio).toBeLessThanOrEqual(1);
      expect(Number.isFinite(assessment.adoptionRatio)).toBe(true);
      const dimensions = assessment.contrasts.map((contrast) => contrast.dimension);
      expect(dimensions).toEqual([...CONTRAST_DIMENSIONS]);
      for (const contrast of assessment.contrasts) {
        expect(contrast.evidence.length).toBeGreaterThan(0);
      }
      expect(result.adoptionRatios[assessment.alias]).toBe(assessment.adoptionRatio);
    }
    const gamma = result.assessments.find((assessment) => assessment.nodeId === 'node_c');
    expect(gamma?.selected).toBe(false);
    expect(gamma?.adoptionRatio).toBeLessThan(1);
    expect(result.rationale).toContain('selected candidate_B');
  });

  it('never selects a failed candidate even when the judge ranks it first', async () => {
    const verdict = JSON.stringify({
      ranking: ['candidate_C', 'candidate_A', 'candidate_B'],
      assessments: [{ alias: 'candidate_C', rationale: 'looks promising', rejectedReason: 'process crashed' }]
    });
    const { composer, request } = composeRequest([verdict]);
    const result = await composer.compose(request);

    expect(result.selectedNodeId).toBe('node_b');
    const gamma = result.assessments.find((assessment) => assessment.nodeId === 'node_c');
    expect(gamma?.selected).toBe(false);
    expect(gamma?.rejectedReason).toBe('process crashed');
    const evidenceC = scoreCandidateEvidence(request.reference, request.candidates[2]!.trajectory);
    expect(gamma?.adoptionRatio).not.toBeCloseTo(evidenceC, 10);
  });

  it('keeps deterministic selection when the judge is unavailable', async () => {
    const { composer, request } = composeRequest([new Error('model offline')]);
    const result = await composer.compose(request);
    expect(result.selectedNodeId).toBe('node_b');
    expect(result.rationale).toContain('evidence-only');
    const alpha = result.assessments.find((assessment) => assessment.nodeId === 'node_a');
    expect(alpha?.adoptionRatio).toBeCloseTo(
      scoreCandidateEvidence(request.reference, request.candidates[0]!.trajectory),
      10
    );
  });

  it('reports null selection and null composition when nothing succeeded', async () => {
    const { composer, request } = composeRequest([
      JSON.stringify({ ranking: ['candidate_C'], assessments: [] })
    ]);
    const allFailed = request.candidates.map((candidate) =>
      makeCandidate({
        nodeId: candidate.nodeId,
        branchId: candidate.branchId,
        patch: candidate.patch,
        trajectory: { ...candidate.trajectory, status: 'timeout' as const, deliverable: undefined }
      })
    );
    const result = await composer.compose({ ...request, candidates: allFailed });
    expect(result.selectedPatch).toBeNull();
    expect(result.composedPatch).toBeNull();
    expect(result.selectedBranchId).toBeNull();
    expect(result.assessments).toHaveLength(allFailed.length);
    expect(result.rationale).toContain('no successful candidate');
    expect(result.adoptionRatios.candidate_A).toBeLessThanOrEqual(1);
  });

  it('returns an explicit empty composition when no candidates are supplied', async () => {
    const { composer, request } = composeRequest([]);
    const result = await composer.compose({ ...request, candidates: [] });
    expect(result.selectedPatch).toBeNull();
    expect(result.composedPatch).toBeNull();
    expect(result.assessments).toEqual([]);
    expect(result.adoptionRatios).toEqual({});
    expect(result.rationale).toContain('no candidates');
  });

  it('exposes every adoption ratio under the alias, branchId and nodeId keys', async () => {
    const { composer, request } = composeRequest([JUDGE_VERDICT]);
    const result = await composer.compose(request);

    expect(Object.keys(result.adoptionRatios).sort()).toEqual(
      [
        'branch_a',
        'branch_b',
        'branch_c',
        'candidate_A',
        'candidate_B',
        'candidate_C',
        'node_a',
        'node_b',
        'node_c'
      ].sort()
    );
    // The alias -> assessment mapping the judge and audits rely on is unchanged.
    expect(result.assessments.map((assessment) => assessment.alias)).toEqual([
      'candidate_A',
      'candidate_B',
      'candidate_C'
    ]);
    expect(result.assessments.map((assessment) => assessment.nodeId)).toEqual(['node_a', 'node_b', 'node_c']);
    for (const assessment of result.assessments) {
      const byAlias = result.adoptionRatios[assessment.alias];
      expect(byAlias).toBe(assessment.adoptionRatio);
      expect(result.adoptionRatios[assessment.branchId]).toBe(byAlias);
      expect(result.adoptionRatios[assessment.nodeId]).toBe(byAlias);
    }
  });

  it('keeps the three-key mapping collision-safe when identities overlap', async () => {
    const slow = makeCandidate({
      nodeId: 'node_x',
      branchId: 'branch_x',
      trajectory: makeTrajectory({
        id: 'traj_node_x',
        nodeId: 'node_x',
        branchId: 'branch_x',
        patchId: 'patch_node_x',
        status: 'succeeded',
        metrics: { steps: 30, toolCalls: 26, toolErrors: 12, durationMs: 9000 },
        deliverable: { content: 'slow result', format: 'text' }
      })
    });
    const fast = makeCandidate({
      nodeId: 'node_y',
      // Deliberate collision: this branch id equals the other candidate's node id.
      branchId: 'node_x',
      trajectory: makeTrajectory({
        id: 'traj_node_y',
        nodeId: 'node_y',
        branchId: 'node_x',
        patchId: 'patch_node_y',
        status: 'succeeded',
        metrics: { steps: 3, toolCalls: 2, toolErrors: 0, durationMs: 500 },
        deliverable: { content: 'fast result', format: 'text' }
      })
    });
    const { model, composer, request } = composeRequest([JUDGE_VERDICT], [slow, fast]);
    const result = await composer.compose(request);

    const slowAssessment = result.assessments.find((assessment) => assessment.nodeId === 'node_x');
    const fastAssessment = result.assessments.find((assessment) => assessment.nodeId === 'node_y');
    expect(slowAssessment?.alias).toBe('candidate_A');
    expect(fastAssessment?.alias).toBe('candidate_B');

    // The colliding key keeps the first writer (candidate_A's own node id).
    expect(result.adoptionRatios.node_x).toBe(slowAssessment?.adoptionRatio);
    expect(result.adoptionRatios.node_x).not.toBe(fastAssessment?.adoptionRatio);
    expect(result.adoptionRatios.branch_x).toBe(slowAssessment?.adoptionRatio);
    expect(result.adoptionRatios.node_y).toBe(fastAssessment?.adoptionRatio);
    expect(result.adoptionRatios.candidate_B).toBe(fastAssessment?.adoptionRatio);
    expect(result.rationale).toContain('adoption key collisions kept the first writer: node_x');

    // Anonymisation is unchanged: the judge still saw aliases only.
    const prompt = promptText(model);
    expect(prompt).toContain('candidate_A');
    expect(prompt).not.toContain('node_x');
    expect(prompt).not.toContain('branch_x');
  });

  it('merges a multi-round winner onto its lineage parent patch', async () => {
    const parentPatch = makePatch({
      id: 'patch_parent',
      branchId: 'branch_parent',
      purpose: 'deepen',
      label: 'exploit:guardrails+skills',
      sourceLessonIds: ['lesson_parent'],
      edits: {
        guardrails: { kind: 'guardrails', formatContract: 'parent contract' },
        skills: { kind: 'skills', skills: [{ name: 'parent-skill', markdown: '# parent', activate: true }] }
      }
    });
    const childPatch = makePatch({
      id: 'patch_child',
      branchId: 'branch_child',
      purpose: 'deepen',
      label: 'exploit:guardrails+scripts',
      parentPatchIds: ['patch_parent'],
      sourceLessonIds: ['lesson_child'],
      edits: {
        guardrails: { kind: 'guardrails', formatContract: 'child contract' },
        scripts: { kind: 'scripts', scripts: [{ path: 'tools/child.py', language: 'python', code: 'print(2)' }] }
      }
    });
    const parentCandidate = makeCandidate({
      nodeId: 'node_parent',
      branchId: 'branch_parent',
      patch: parentPatch,
      trajectory: makeTrajectory({
        id: 'traj_parent',
        nodeId: 'node_parent',
        branchId: 'branch_parent',
        patchId: 'patch_parent',
        status: 'succeeded',
        metrics: { steps: 30, toolCalls: 26, toolErrors: 12, durationMs: 9000 },
        deliverable: { content: 'round one result', format: 'text' }
      })
    });
    const childCandidate = makeCandidate({
      nodeId: 'node_child',
      branchId: 'branch_child',
      patch: childPatch,
      trajectory: makeTrajectory({
        id: 'traj_child',
        nodeId: 'node_child',
        branchId: 'branch_child',
        patchId: 'patch_child',
        status: 'succeeded',
        metrics: { steps: 3, toolCalls: 2, toolErrors: 0, durationMs: 500 },
        deliverable: { content: 'round two result that keeps the round one edit', format: 'text' }
      })
    });

    const { composer, request } = composeRequest([JUDGE_VERDICT], [parentCandidate, childCandidate]);
    const result = await composer.compose(request);
    const composed = result.composedPatch;

    // branch_child sorts first, so the child is candidate_A and also wins on evidence.
    expect(result.selectedPatch?.id).toBe('patch_child');
    expect(composed).not.toBeNull();
    expect(Object.keys(composed?.edits ?? {})).toEqual(['guardrails', 'skills', 'scripts']);
    // The child overrides the surface both rounds edit ...
    expect(composed?.edits.guardrails?.kind).toBe('guardrails');
    expect(composed?.edits.guardrails?.formatContract).toBe('child contract');
    // ... while the parent-only and child-only surfaces both survive.
    expect(composed?.edits.skills?.kind).toBe('skills');
    expect(composed?.edits.skills?.skills[0]?.name).toBe('parent-skill');
    expect(composed?.edits.scripts?.kind).toBe('scripts');
    expect(composed?.parentPatchIds).toEqual(['patch_parent', 'patch_child']);
    expect(composed?.sourceLessonIds).toEqual(['lesson_parent', 'lesson_child']);
    expect(composed?.metadata?.basePatchId).toBe('patch_parent');
    expect(composed?.metadata?.baseResolution).toBe('parent');
    expect(composed?.rationale).toContain('over parent patch patch_parent');
  });

  it('merges a depth-3 chain in ancestry order so the earliest round survives', async () => {
    const roundOne = makePatch({
      id: 'patch_round1',
      branchId: 'branch_round1',
      purpose: 'deepen',
      label: 'exploit:system_prompt',
      sourceLessonIds: ['lesson_round1'],
      edits: { system_prompt: { kind: 'system_prompt', mode: 'append', content: 'round one prompt' } }
    });
    const roundTwo = makePatch({
      id: 'patch_round2',
      branchId: 'branch_round2',
      purpose: 'deepen',
      label: 'exploit:system_prompt+guardrails',
      parentPatchIds: ['patch_round1'],
      sourceLessonIds: ['lesson_round2'],
      edits: {
        system_prompt: { kind: 'system_prompt', mode: 'append', content: 'round two prompt' },
        guardrails: { kind: 'guardrails', formatContract: 'round two contract' }
      }
    });
    const roundThree = makePatch({
      id: 'patch_round3',
      branchId: 'branch_round3',
      purpose: 'deepen',
      label: 'exploit:skills',
      parentPatchIds: ['patch_round2'],
      sourceLessonIds: ['lesson_round3'],
      edits: { skills: { kind: 'skills', skills: [{ name: 'round-three-skill', markdown: '# r3', activate: true }] } }
    });
    const chain = [
      { patch: roundOne, steps: 30, toolErrors: 12, durationMs: 9000, deliverableChars: 7 },
      { patch: roundTwo, steps: 12, toolErrors: 3, durationMs: 3000, deliverableChars: 200 },
      { patch: roundThree, steps: 3, toolErrors: 0, durationMs: 500, deliverableChars: 2000 }
    ].map((entry, index) => {
      const nodeId = 'node_round' + String(index + 1);
      const branchId = 'branch_round' + String(index + 1);
      return makeCandidate({
        nodeId,
        branchId,
        patch: entry.patch,
        trajectory: makeTrajectory({
          id: 'traj_round' + String(index + 1),
          nodeId,
          branchId,
          patchId: entry.patch.id,
          status: 'succeeded',
          metrics: {
            steps: entry.steps,
            toolCalls: entry.steps,
            toolErrors: entry.toolErrors,
            durationMs: entry.durationMs
          },
          deliverable: { content: 'r'.repeat(entry.deliverableChars), format: 'text' }
        })
      });
    });

    const { composer, request } = composeRequest([JUDGE_VERDICT], chain);
    const result = await composer.compose(request);
    const composed = result.composedPatch;

    // The third round wins on evidence despite the judge ranking candidate_A (round one) first.
    expect(result.selectedPatch?.id).toBe('patch_round3');
    expect(composed).not.toBeNull();
    // All three rounds contribute; the earliest round's system_prompt edit is not dropped.
    expect(Object.keys(composed?.edits ?? {})).toEqual(['system_prompt', 'guardrails', 'skills']);
    expect(composed?.edits.system_prompt?.content).toBe('round two prompt');
    expect(composed?.edits.guardrails?.formatContract).toBe('round two contract');
    expect(composed?.edits.skills?.skills[0]?.name).toBe('round-three-skill');
    expect(composed?.parentPatchIds).toEqual(['patch_round1', 'patch_round2', 'patch_round3']);
    expect(composed?.sourceLessonIds).toEqual(['lesson_round1', 'lesson_round2', 'lesson_round3']);
    expect(composed?.metadata?.lineageIds).toEqual(['patch_round1', 'patch_round2']);
    expect(composed?.metadata?.lineageDepth).toBe(2);
    expect(composed?.metadata?.baseResolution).toBe('lineage');
    expect(composed?.metadata?.basePatchId).toBe('patch_round2');
    expect(composed?.rationale).toContain('over lineage depth 2 [patch_round1 -> patch_round2]');
  });

  it('terminates deterministically on cyclic, duplicate and missing parent ids', async () => {
    const loopA = makePatch({
      id: 'patch_loop_a',
      branchId: 'branch_loop_a',
      label: 'loop:system_prompt',
      parentPatchIds: ['patch_loop_b'],
      sourceLessonIds: ['lesson_a'],
      edits: { system_prompt: { kind: 'system_prompt', mode: 'append', content: 'loop a' } }
    });
    const loopB = makePatch({
      id: 'patch_loop_b',
      branchId: 'branch_loop_b',
      label: 'loop:guardrails',
      parentPatchIds: ['patch_loop_a'],
      sourceLessonIds: ['lesson_b'],
      edits: { guardrails: { kind: 'guardrails', formatContract: 'loop b contract' } }
    });
    const buildLoopCandidate = (
      patch: typeof loopA,
      index: number,
      steps: number,
      status: 'succeeded' | 'failed' = 'succeeded'
    ) => {
      const nodeId = 'node_loop_' + String(index);
      const branchId = 'branch_loop_' + String(index);
      return makeCandidate({
        nodeId,
        branchId,
        patch,
        trajectory: makeTrajectory({
          id: 'traj_loop_' + String(index),
          nodeId,
          branchId,
          patchId: patch.id,
          status,
          metrics: { steps, toolCalls: steps, toolErrors: 0, durationMs: 500 },
          deliverable: { content: 'loop result ' + String(index), format: 'text' }
        })
      });
    };
    // Cyclic pair: a -> b -> a. Selecting the better-scoring a must not loop forever.
    const cyclicRun = composeRequest([JUDGE_VERDICT], [
      buildLoopCandidate(loopB, 1, 30, 'failed'),
      buildLoopCandidate(loopA, 2, 3)
    ]);
    const cyclic = await cyclicRun.composer.compose(cyclicRun.request);
    // Branch naming decides the alias order, so assert on the selected patch rather than the alias.
    expect(cyclic.selectedPatch?.id).toBe('patch_loop_a');
    expect(cyclic.composedPatch?.parentPatchIds).toEqual(['patch_loop_b', 'patch_loop_a']);
    expect(cyclic.composedPatch?.sourceLessonIds).toEqual(['lesson_b', 'lesson_a']);
    expect(cyclic.composedPatch?.metadata?.lineageDepth).toBe(1);
    expect(cyclic.composedPatch?.rationale).toContain('over parent patch patch_loop_b');
    expect(Object.keys(cyclic.composedPatch?.edits ?? {})).toEqual(['guardrails', 'system_prompt']);

    // Duplicate parent ids and a parent that is not a candidate are ignored, not merged twice.
    const duplicated = makePatch({
      id: 'patch_dup',
      branchId: 'branch_dup',
      label: 'exploit:skills',
      parentPatchIds: ['patch_missing', 'patch_loop_b', 'patch_loop_b'],
      sourceLessonIds: ['lesson_dup'],
      edits: { skills: { kind: 'skills', skills: [{ name: 'dup-skill', markdown: '# dup', activate: true }] } }
    });
    const dupRun = composeRequest([JUDGE_VERDICT], [
      buildLoopCandidate(loopB, 1, 30, 'failed'),
      buildLoopCandidate(loopA, 2, 20, 'failed'),
      buildLoopCandidate(duplicated, 3, 3)
    ]);
    const dup = await dupRun.composer.compose(dupRun.request);

    expect(dup.selectedPatch?.id).toBe('patch_dup');
    expect(dup.composedPatch?.parentPatchIds).toEqual(['patch_loop_a', 'patch_loop_b', 'patch_dup']);
    expect(dup.composedPatch?.sourceLessonIds).toEqual(['lesson_a', 'lesson_b', 'lesson_dup']);
    expect(dup.composedPatch?.metadata?.lineageDepth).toBe(2);
    expect(dup.composedPatch?.metadata?.baseResolution).toBe('lineage');
    expect(Object.keys(dup.composedPatch?.edits ?? {})).toEqual(['system_prompt', 'guardrails', 'skills']);
    expect(dup.composedPatch?.rationale).toContain('over lineage depth 2 [patch_loop_a -> patch_loop_b]');
  });

  it('falls back to the reference scaffold when the winner has no lineage', async () => {
    const referencePatch = makePatch({
      id: 'patch_ref',
      branchId: 'branch_ref2',
      purpose: 'initial',
      label: 'reference:skills',
      sourceLessonIds: ['lesson_ref'],
      edits: {
        skills: { kind: 'skills', skills: [{ name: 'reference-skill', markdown: '# reference', activate: true }] }
      }
    });
    const winnerPatch = makePatch({
      id: 'patch_winner',
      branchId: 'branch_winner',
      origin: 'invariant',
      guidance: 'guidance_free',
      label: 'explore_invariant:guardrails',
      sourceLessonIds: ['lesson_winner'],
      edits: { guardrails: { kind: 'guardrails', appendRules: ['Cite files.'] } }
    });
    const referenceCandidate = makeCandidate({
      nodeId: 'node_ref_candidate',
      branchId: 'branch_ref2',
      patch: referencePatch,
      trajectory: makeTrajectory({
        id: 'traj_ref_candidate',
        nodeId: 'node_ref_candidate',
        branchId: 'branch_ref2',
        patchId: 'patch_ref',
        status: 'succeeded',
        metrics: { steps: 30, toolCalls: 26, toolErrors: 12, durationMs: 9000 },
        deliverable: { content: 'reference scaffold result', format: 'text' }
      })
    });
    const winnerCandidate = makeCandidate({
      nodeId: 'node_winner',
      branchId: 'branch_winner',
      patch: winnerPatch,
      trajectory: makeTrajectory({
        id: 'traj_winner',
        nodeId: 'node_winner',
        branchId: 'branch_winner',
        patchId: 'patch_winner',
        status: 'succeeded',
        metrics: { steps: 3, toolCalls: 2, toolErrors: 0, durationMs: 500 },
        deliverable: { content: 'winner result that keeps the reference scaffold skill', format: 'text' }
      })
    });

    const { composer, request } = composeRequest([JUDGE_VERDICT], [referenceCandidate, winnerCandidate]);
    const result = await composer.compose(request);
    const composed = result.composedPatch;

    // branch_ref2 sorts first, so the reference-scaffold candidate is candidate_A; the winner
    // still wins on evidence although the judge ranked candidate_A first.
    expect(result.selectedPatch?.id).toBe('patch_winner');
    expect(composed?.parentPatchIds).toEqual(['patch_ref', 'patch_winner']);
    expect(composed?.sourceLessonIds).toEqual(['lesson_ref', 'lesson_winner']);
    expect(composed?.metadata?.basePatchId).toBe('patch_ref');
    expect(composed?.metadata?.baseResolution).toBe('reference');
    expect(composed?.rationale).toContain('over reference patch patch_ref');
    expect(composed?.edits.skills?.skills[0]?.name).toBe('reference-skill');
    expect(composed?.edits.guardrails?.appendRules).toEqual(['Cite files.']);
  });

  it('is deterministic for identical inputs', async () => {
    const firstRun = composeRequest([JUDGE_VERDICT]);
    const first = await firstRun.composer.compose(firstRun.request);
    const secondRun = composeRequest([JUDGE_VERDICT]);
    const second = await secondRun.composer.compose(secondRun.request);
    expect(second).toEqual(first);
  });
});

describe('Harness² composer / pure contrast scoring', () => {
  it('computes one contrast per dimension and clamps absolute scores into [0, 1]', () => {
    const reference = referenceTrajectory();
    const candidate = candidateSet()[1]!.trajectory;
    const contrasts = computeBehavioralContrasts(reference, candidate);
    expect(contrasts.map((contrast) => contrast.dimension)).toEqual([...CONTRAST_DIMENSIONS]);
    const score = scoreCandidateEvidence(reference, candidate);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
    const dimensions: readonly ContrastDimension[] = CONTRAST_DIMENSIONS;
    expect(dimensions).toHaveLength(6);
  });

  it('still scores a candidate when no reference trajectory exists', () => {
    const candidate = candidateSet()[1]!.trajectory;
    const contrasts = computeBehavioralContrasts(undefined, candidate);
    for (const contrast of contrasts) {
      expect(contrast.referenceValue).toBeNull();
      expect(contrast.delta).toBeUndefined();
    }
    const score = scoreCandidateEvidence(undefined, candidate);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});
describe('L2 composer input stripping and free-text canary risk recording', () => {
  it('strips structured <jitrl_advice> and <anti_patterns_to_avoid> blocks from steps and deliverables', async () => {
    const rawStepText = 'running task <jitrl_advice mode="advisory" level="host_tool" neighbors="4">recommend write_note</jitrl_advice> done';
    const cleaned = stripStructuredAdvice(rawStepText);
    expect(cleaned).toBe('running task  done');
    expect(cleaned).not.toContain('<jitrl_advice');
    expect(cleaned).not.toContain('recommend write_note');

    const rawDeliverable = '<anti_patterns_to_avoid>avoid bash</anti_patterns_to_avoid>final deliverable content';
    const cleanedDeliverable = stripStructuredAdvice(rawDeliverable);
    expect(cleanedDeliverable).toBe('final deliverable content');
    expect(cleanedDeliverable).not.toContain('<anti_patterns_to_avoid>');

    // End-to-end composer test: candidate steps containing structured advice are stripped in judge prompt
    const candidateWithAdvice = makeCandidate({
      nodeId: 'node_adv',
      branchId: 'branch_adv',
      patch: makePatch({ id: 'patch_adv', branchId: 'branch_adv', origin: 'domain', guidance: 'memory' }),
      trajectory: makeTrajectory({
        id: 'traj_adv',
        nodeId: 'node_adv',
        branchId: 'branch_adv',
        status: 'succeeded',
        metrics: { steps: 2, toolCalls: 1, toolErrors: 0, durationMs: 100 },
        steps: [
          {
            index: 0,
            at: 0,
            kind: 'tool',
            toolName: 'read_file',
            text: 'inspecting code <jitrl_advice neighbors="3">recommend write_note</jitrl_advice>'
          }
        ],
        deliverable: {
          content: '<anti_patterns_to_avoid>avoid bash</anti_patterns_to_avoid>clean output',
          format: 'text',
          contentHash: 'hash_adv'
        }
      })
    });

    const { model, composer, request } = composeRequest([JUDGE_VERDICT], [candidateWithAdvice]);
    await composer.compose(request);

    const judgePrompt = promptText(model);
    expect(judgePrompt).not.toContain('<jitrl_advice');
    expect(judgePrompt).not.toContain('recommend write_note');
    expect(judgePrompt).not.toContain('<anti_patterns_to_avoid>');
    expect(judgePrompt).toContain('inspecting code');
    expect(judgePrompt).toContain('clean output');
  });

  it('canary/adversarial test: proves free-text restatement risk is explicitly recorded rather than claimed eliminated', async () => {
    // Model restates advisory statistics in free prose without XML tags
    const freeTextCanary = 'CANARY_ADVICE_LEAK: the advisor recommended avoiding bash with meanReturn -0.85';

    const candidateWithCanary = makeCandidate({
      nodeId: 'node_canary',
      branchId: 'branch_canary',
      patch: makePatch({ id: 'patch_canary', branchId: 'branch_canary', origin: 'domain', guidance: 'memory' }),
      trajectory: makeTrajectory({
        id: 'traj_canary',
        nodeId: 'node_canary',
        branchId: 'branch_canary',
        status: 'succeeded',
        metrics: { steps: 1, toolCalls: 1, toolErrors: 0, durationMs: 50 },
        steps: [
          {
            index: 0,
            at: 0,
            kind: 'model',
            text: freeTextCanary
          }
        ]
      })
    });

    const { model, composer, request } = composeRequest([JUDGE_VERDICT], [candidateWithCanary]);
    await composer.compose(request);

    const judgePrompt = promptText(model);

    // XML tag stripping cannot remove unstructured prose restatements:
    // the canary text remains visible in the judge prompt
    expect(judgePrompt).toContain('CANARY_ADVICE_LEAK');
    expect(judgePrompt).toContain('meanReturn -0.85');

    // Therefore, L2 policy explicitly records and disclaims this residual risk
    // instead of claiming that XML stripping eliminated all advice leakage:
    expect(ADVICE_LEAKAGE_RISK_RECORD.policy).toBe('L2_structured_advice_stripping');
    expect(ADVICE_LEAKAGE_RISK_RECORD.residualRisk).toBe(
      'free_text_restatement_cannot_be_eliminated_by_xml_stripping_alone'
    );
  });
});
