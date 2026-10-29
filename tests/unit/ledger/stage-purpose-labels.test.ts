/**
 * P3-B: purpose labelling through the REAL stage factories.
 *
 * The load-bearing assertion: probe traffic is 'probe', judging is 'compose',
 * and the two can never be swapped silently. Every stage records its call in a
 * shared registry, so one run has a single auditable call log.
 */
import { describe, expect, it } from 'vitest';
import { createDeterministicIdFactory } from '../../../src/harness2/shared';
import { createAnonymousComposer } from '../../../src/harness2/composer';
import { createEvidenceReflector } from '../../../src/harness2/reflector';
import { createDualTrackProposer } from '../../../src/harness2/proposer';
import {
  ModelCallRegistry,
  type MeteringStage
} from '../../../src/dsh-bridge';
import type { ModelRequest, ModelResponse } from '../../../src/types/contracts';
import {
  fixedClock,
  makeCandidate,
  makePatch,
  makeProposeRequest,
  makeReflectionRequest,
  makeTask,
  makeTrajectory,
  promptText,
  proposalJson,
  requestAt,
  scriptedModel
} from '../harness2/fixtures';

const JUDGE_VERDICT = JSON.stringify({
  ranking: ['candidate_A'],
  assessments: [{ alias: 'candidate_A', rationale: 'completed the task' }]
});

/** Scripted model that only answers a known prompt shape. */
function stageModel(reply: string): { model: ReturnType<typeof scriptedModel>; calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  const model = scriptedModel([reply]);
  return { model, calls };
}

const REFERENCE = makeTrajectory({
  id: 'traj_reference',
  role: 'reference',
  branchId: 'branch_ref',
  branchNamespace: 'probe_sess_branch_ref',
  status: 'failed',
  patchId: 'patch_ref',
  patchOrigin: 'reference',
  surfaceKeys: [],
  metrics: { steps: 10, toolCalls: 8, toolErrors: 4, durationMs: 2000 }
});

function singleCandidate() {
  return makeCandidate({
    nodeId: 'node_a',
    branchId: 'branch_a',
    patch: makePatch({ id: 'patch_node_a', branchId: 'branch_a' }),
    trajectory: makeTrajectory({
      id: 'traj_node_a',
      nodeId: 'node_a',
      branchId: 'branch_a',
      branchNamespace: 'probe_sess_branch_a',
      patchId: 'patch_node_a',
      status: 'succeeded',
      metrics: { steps: 3, toolCalls: 2, toolErrors: 0, durationMs: 500 },
      deliverable: { content: 'done', format: 'text' }
    })
  });
}

describe('purpose labelling: probe is never compose', () => {
  it('labels the anonymous judge call as compose', async () => {
    const registry = new ModelCallRegistry();
    const model = scriptedModel([JUDGE_VERDICT]);
    const composer = createAnonymousComposer({
      model,
      now: fixedClock(),
      newId: createDeterministicIdFactory('compose-test'),
      metering: { registry }
    });
    const request = {
      task: makeTask(),
      sessionId: 'sess_p3b',
      candidates: [singleCandidate()],
      reference: REFERENCE,
      policyId: 'policy_p3b'
    };
    await composer.compose(request);
    expect(requestAt(model).purpose).toBe('compose');
    expect(promptText(model)).toContain('candidate_A');
    expect(registry.countsByPurpose()).toEqual({ compose: 1 });
    expect(registry.snapshot()[0]?.stage).toBe('compose');
  });

  it('labels the proposer call as propose', async () => {
    const registry = new ModelCallRegistry();
    const model = scriptedModel([proposalJson()]);
    const proposer = createDualTrackProposer({
      model,
      now: fixedClock(),
      newId: createDeterministicIdFactory('propose-test'),
      metering: { registry }
    });
    await proposer.propose(makeProposeRequest({ sessionId: 'sess_p3b', attemptIndex: 0 }));
    expect(requestAt(model).purpose).toBe('propose');
    expect(registry.countsByPurpose()).toEqual({ propose: 1 });
    expect(registry.snapshot()[0]?.stage).toBe('propose');
  });

  it('labels the reflector header call as reflect', async () => {
    const registry = new ModelCallRegistry();
    const model = scriptedModel([JSON.stringify({ lessons: [] })]);
    const reflector = createEvidenceReflector({
      model,
      now: fixedClock(),
      newId: createDeterministicIdFactory('reflect-test'),
      metering: { registry }
    });
    await reflector.reflect(makeReflectionRequest({
      sessionId: 'sess_p3b',
      trajectories: [REFERENCE, singleCandidate().trajectory]
    } as never));
    expect(requestAt(model).purpose).toBe('reflect');
    expect(registry.countsByPurpose()).toEqual({ reflect: 1 });
    expect(registry.snapshot()[0]?.stage).toBe('reflect');
  });
});

describe('one registry across stages: the shared call log', () => {
  it('separates probe from compose counts in one registry', () => {
    const registry = new ModelCallRegistry();
    registry.record({
      callId: 'p1',
      stage: 'probe',
      purpose: 'probe',
      ledgerPhase: 'probe',
      outcome: 'succeeded',
      durationMs: 1,
      reservedMicros: 0,
      provenance: 'none'
    });
    registry.record({
      callId: 'c1',
      stage: 'compose',
      purpose: 'compose',
      ledgerPhase: 'compose',
      outcome: 'succeeded',
      durationMs: 1,
      reservedMicros: 0,
      provenance: 'none'
    });
    expect(registry.countsByPurpose()).toEqual({ probe: 1, compose: 1 });
    expect(registry.totalCostMicros()).toBe(0);
  });
});
