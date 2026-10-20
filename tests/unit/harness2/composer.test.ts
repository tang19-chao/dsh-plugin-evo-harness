import { describe, expect, it } from 'vitest';
import type { ComposeRequest, ContrastDimension, ProbeCandidate, ProbeTrajectory } from '../../../src/types/contracts';
import {
  CONTRAST_DIMENSIONS,
  computeBehavioralContrasts,
  createAnonymousComposer,
  scoreCandidateEvidence
} from '../../../src/harness2/composer';
import { createDeterministicIdFactory } from '../../../src/harness2/shared';
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

function composeRequest(script: readonly (string | Error)[]) {
  const model = scriptedModel(script);
  const composer = createAnonymousComposer({
    model,
    now: fixedClock(),
    newId: createDeterministicIdFactory('compose-test')
  });
  const candidates = candidateSet();
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
