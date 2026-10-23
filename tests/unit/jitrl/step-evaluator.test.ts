/**
 * P1-5: fused multi-signal step evaluator. Covers the section 6.5 signal
 * mappings, the weighted clip fusion, hand-computed discounted returns,
 * the full LLM cost-gating table, anonymized prompt construction with
 * privacy redaction, malformed-JSON fallback, repeated tool error
 * detection, both user directions, and determinism with no model.
 */
import { describe, expect, it } from 'vitest';
import {
  combineStepRewards,
  createStepEvaluator,
  discountedReturn,
  surrogateSignal,
  turnSignalForStatus,
  redactAbsolutePaths,
  redactCommonSecrets,
  userSignal,
  type StepEvaluationInput,
  type StepEvaluatorOptions,
  type UserFeedbackKind
} from '../../../src/jitrl/step-evaluator';
import {
  type IModelAdapter,
  type ModelRequest,
  type ModelResponse,
  type ProbeTask,
  type ProbeTrajectory,
  type TrajectoryStep,
  type TrajectoryStepKind
} from '../../../src/types/contracts';
import type { JitRlRewardConfig } from '../../../src/config';

const REWARD: JitRlRewardConfig = {
  llmEvaluator: true,
  weights: { llm: 0.4, surrogate: 0.3, tool: 0.2, turn: 0.1, user: 0.0 },
  clip: [-3, 3]
};

const TASK: ProbeTask = { id: 'task-1', prompt: 'add a regression test' };

function makeStep(index: number, kind: TrajectoryStepKind, extra: Partial<TrajectoryStep> = {}): TrajectoryStep {
  return { index, at: index, kind, ...extra };
}

function makeTrajectory(overrides: Partial<ProbeTrajectory> = {}): ProbeTrajectory {
  const steps = overrides.steps ?? [];
  const toolErrors = overrides.toolErrors ?? [];
  return {
    id: 'traj-1',
    sessionId: 'session-1',
    branchId: 'branch-1',
    branchNamespace: 'ns',
    role: 'candidate',
    status: 'succeeded',
    patchId: 'patch-1',
    patchOrigin: 'domain',
    surfaceKeys: ['system_prompt'],
    startedAt: 0,
    endedAt: 10,
    metrics: { steps: steps.length, toolCalls: 0, toolErrors: toolErrors.length, durationMs: 10 },
    steps,
    toolErrors,
    failureSignals: [],
    memoryRecallIds: [],
    ...overrides
  };
}

function fakeModel(
  handler: (request: ModelRequest) => ModelResponse
): IModelAdapter & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    complete: async (request) => {
      requests.push(request);
      return handler(request);
    }
  };
}

function judgeModel(responseText: string): IModelAdapter & { requests: ModelRequest[] } {
  return fakeModel(() => ({ text: responseText }));
}

const NO_MODEL_OPTIONS: StepEvaluatorOptions = { reward: REWARD };

describe('section 6.5 signal mappings', () => {
  it('maps user feedback to both directions', () => {
    expect(userSignal('adopt')).toBe(3);
    expect(userSignal('rollback')).toBe(-3);
    expect(userSignal('reject')).toBe(-3);
  });

  it('maps terminal statuses onto turn signals', () => {
    expect(turnSignalForStatus('succeeded')).toBe(1);
    expect(turnSignalForStatus('failed')).toBe(-2);
    expect(turnSignalForStatus('timeout')).toBe(-1);
    expect(turnSignalForStatus('aborted')).toBe(0);
  });

  it('maps surrogate s_v linearly onto [-3, 3] with clamping', () => {
    expect(surrogateSignal(0)).toBe(-3);
    expect(surrogateSignal(0.5)).toBe(0);
    expect(surrogateSignal(1)).toBe(3);
    expect(surrogateSignal(2)).toBe(3);
    expect(surrogateSignal(-1)).toBe(-3);
  });
});

describe('pure fusion helpers', () => {
  it('combines weighted signals and clips the result', () => {
    expect(combineStepRewards({ llm: 3, tool: 0.5 }, REWARD.weights, REWARD.clip)).toBeCloseTo(1.3, 10);
    expect(combineStepRewards({ llm: 100 }, REWARD.weights, REWARD.clip)).toBe(3);
    expect(combineStepRewards({ llm: -100 }, REWARD.weights, REWARD.clip)).toBe(-3);
    expect(combineStepRewards({ evaluated: 1 }, REWARD.weights, REWARD.clip)).toBe(0);
    expect(combineStepRewards({}, REWARD.weights, REWARD.clip)).toBe(0);
    expect(combineStepRewards({ llm: Number.NaN }, REWARD.weights, REWARD.clip)).toBe(0);
  });

  it('computes hand-checked discounted returns', () => {
    const rewards = [1, -2, 3];
    expect(discountedReturn(rewards, 0.5, 0)).toBeCloseTo(0.75, 10);
    expect(discountedReturn(rewards, 0.5, 1)).toBeCloseTo(-0.5, 10);
    expect(discountedReturn(rewards, 0.5, 2)).toBeCloseTo(3, 10);
    expect(discountedReturn(rewards, 0, 0)).toBe(1);
    expect(discountedReturn(rewards, 1, 0)).toBe(2);
    expect(discountedReturn(rewards, 0.5, -1)).toBe(0);
    expect(discountedReturn(rewards, 0.5, 3)).toBe(0);
  });
});

describe('LLM cost gating (plan section 6.5)', () => {
  it('never calls the judge with no model injected', async () => {
    const evaluator = createStepEvaluator(NO_MODEL_OPTIONS);
    const rewards = await evaluator.evaluateSteps({
      trajectory: makeTrajectory({ steps: [makeStep(0, 'message')] }),
      task: TASK
    });
    expect(rewards.map((reward) => reward.sources.evaluated)).toEqual([0]);
    expect(rewards[0]?.rationale).toContain('gated out');
    expect(evaluator.diagnostics()).toEqual([]);
  });

  it('skips the judge for short trajectories without hints', async () => {
    const model = judgeModel('{"steps":[]}');
    const evaluator = createStepEvaluator({ reward: REWARD, model });
    const rewards = await evaluator.evaluateSteps({
      trajectory: makeTrajectory({ steps: [makeStep(0, 'message')] }),
      task: TASK
    });
    expect(model.requests).toHaveLength(0);
    expect(rewards.map((reward) => reward.sources.evaluated)).toEqual([0]);
  });

  it('calls the judge once when there are at least three steps', async () => {
    const model = judgeModel('{"steps":[{"stepIndex":0,"score":2.5},{"stepIndex":1,"score":5},{"stepIndex":2,"score":-0.5}]}');
    const evaluator = createStepEvaluator({ reward: REWARD, model });
    const rewards = await evaluator.evaluateSteps({
      trajectory: makeTrajectory({
        steps: [makeStep(0, 'message'), makeStep(1, 'model'), makeStep(2, 'result')]
      }),
      task: TASK
    });
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.purpose).toBe('evaluate_steps');
    expect(model.requests[0]?.responseFormat).toBe('json');
    expect(rewards.map((reward) => reward.sources.evaluated)).toEqual([1, 1, 1]);
    expect(rewards.map((reward) => reward.sources.llm)).toEqual([2.5, 3, -0.5]);
    expect(rewards[0]?.reward).toBeCloseTo(1.0, 10);
    expect(rewards[1]?.reward).toBeCloseTo(1.2, 10);
    expect(rewards[2]?.reward).toBeCloseTo(-0.1, 10);
    expect(rewards[2]?.rationale).toBe('llm judge ran; fused llm+turn');
  });

  it('calls the judge when the selected or composed hint is set', async () => {
    const model = judgeModel('{"steps":[]}');
    const evaluator = createStepEvaluator({ reward: REWARD, model });
    const input: StepEvaluationInput = {
      trajectory: makeTrajectory({ steps: [makeStep(0, 'message')] }),
      task: TASK,
      selected: true
    };
    await evaluator.evaluateSteps(input);
    expect(model.requests).toHaveLength(1);
    await evaluator.evaluateSteps({ ...input, selected: undefined, composed: true });
    expect(model.requests).toHaveLength(2);
  });

  it('calls the judge when the surrogate delta against the reference exceeds 0.2', async () => {
    const model = judgeModel('{"steps":[]}');
    const sv = new Map<string, number>([['cand', 0.8], ['ref', 0.3]]);
    const surrogate = (trajectory: ProbeTrajectory): number | undefined => sv.get(trajectory.id);
    const evaluator = createStepEvaluator({ reward: REWARD, model, surrogate });
    const candidate = makeTrajectory({ id: 'cand', steps: [makeStep(0, 'message')] });
    const reference = makeTrajectory({ id: 'ref', steps: [makeStep(0, 'message')] });
    const rewards = await evaluator.evaluateSteps({ trajectory: candidate, task: TASK, reference });
    expect(model.requests).toHaveLength(1);
    expect(rewards[0]?.sources.surrogate).toBeCloseTo(1.8, 10);
  });

  it('skips the judge when the surrogate delta is small', async () => {
    const model = judgeModel('{"steps":[]}');
    const sv = new Map<string, number>([['cand', 0.5], ['ref', 0.4]]);
    const surrogate = (trajectory: ProbeTrajectory): number | undefined => sv.get(trajectory.id);
    const evaluator = createStepEvaluator({ reward: REWARD, model, surrogate });
    const rewards = await evaluator.evaluateSteps({
      trajectory: makeTrajectory({ id: 'cand', steps: [makeStep(0, 'message')] }),
      task: TASK,
      reference: makeTrajectory({ id: 'ref', steps: [makeStep(0, 'message')] })
    });
    expect(model.requests).toHaveLength(0);
    expect(rewards[0]?.sources.surrogate).toBe(0);
    expect(rewards[0]?.sources.evaluated).toBe(0);
  });

  it('respects reward.llmEvaluator = false even when the gate passes', async () => {
    const model = judgeModel('{"steps":[]}');
    const evaluator = createStepEvaluator({
      reward: { ...REWARD, llmEvaluator: false },
      model
    });
    const rewards = await evaluator.evaluateSteps({
      trajectory: makeTrajectory({ steps: [makeStep(0, 'message'), makeStep(1, 'model'), makeStep(2, 'result')] }),
      task: TASK
    });
    expect(model.requests).toHaveLength(0);
    expect(rewards.map((reward) => reward.sources.evaluated)).toEqual([0, 0, 0]);
  });

  it('degrades deterministically on malformed judge JSON', async () => {
    const model = judgeModel('not json at all');
    const evaluator = createStepEvaluator({ reward: REWARD, model });
    const rewards = await evaluator.evaluateSteps({
      trajectory: makeTrajectory({ steps: [makeStep(0, 'message'), makeStep(1, 'model'), makeStep(2, 'result')] }),
      task: TASK
    });
    expect(model.requests).toHaveLength(1);
    expect(rewards.map((reward) => reward.sources.evaluated)).toEqual([0, 0, 0]);
    expect(rewards.map((reward) => reward.sources.llm)).toEqual([undefined, undefined, undefined]);
    expect(evaluator.diagnostics().join(' ')).toContain('malformed');
  });

  it('degrades deterministically when the judge call throws', async () => {
    const model = fakeModel(() => {
      throw new Error('provider down');
    });
    const evaluator = createStepEvaluator({ reward: REWARD, model });
    const rewards = await evaluator.evaluateSteps({
      trajectory: makeTrajectory({ steps: [makeStep(0, 'message'), makeStep(1, 'model'), makeStep(2, 'result')] }),
      task: TASK
    });
    expect(model.requests).toHaveLength(1);
    expect(rewards[0]?.sources.evaluated).toBe(0);
    expect(evaluator.diagnostics()[0]).toContain('llm_judge_failed');
  });
});

describe('tool and turn anchors', () => {
  it('scores tool success, first error and repeated identical error', async () => {
    const evaluator = createStepEvaluator({
      reward: { ...REWARD, llmEvaluator: false }
    });
    const trajectory = makeTrajectory({
      steps: [
        makeStep(0, 'tool', { toolName: 'shell' }),
        makeStep(1, 'tool', { toolName: 'shell', error: { name: 'ToolError', message: 'boom' } }),
        makeStep(2, 'tool', { toolName: 'shell' }),
        makeStep(3, 'message', { text: 'done' })
      ],
      toolErrors: [{ toolName: 'shell', message: 'boom', stepIndex: 2 }]
    });
    const rewards = await evaluator.evaluateSteps({ trajectory, task: TASK });
    expect(rewards.map((reward) => reward.sources.tool)).toEqual([0.5, -2, -3, undefined]);
    expect(rewards.map((reward) => reward.sources.turn)).toEqual([undefined, undefined, undefined, 1]);
    expect(rewards[0]?.reward).toBeCloseTo(0.1, 10);
    expect(rewards[1]?.reward).toBeCloseTo(-0.4, 10);
    expect(rewards[2]?.reward).toBeCloseTo(-0.6, 10);
    expect(rewards[3]?.reward).toBeCloseTo(0.1, 10);
    expect(rewards[2]?.rationale).toBe('llm gated out; low-cost tool');
  });

  it('applies the user signal to the final step in both directions', async () => {
    const evaluator = createStepEvaluator({
      reward: { ...REWARD, llmEvaluator: false, weights: { ...REWARD.weights, user: 0.5 } }
    });
    const kinds: readonly UserFeedbackKind[] = ['adopt', 'rollback', 'reject'];
    for (const kind of kinds) {
      const rewards = await evaluator.evaluateSteps({
        trajectory: makeTrajectory({ steps: [makeStep(0, 'message')] }),
        task: TASK,
        user: kind
      });
      expect(rewards[0]?.sources.user).toBe(kind === 'adopt' ? 3 : -3);
      // The final step also carries the turn anchor (succeeded -> +1 * 0.1).
      expect(rewards[0]?.reward).toBeCloseTo(kind === 'adopt' ? 1.6 : -1.4, 10);
    }
  });
});

describe('privacy and anonymization', () => {
  const secretPrompt = 'inspect C:\\Users\\Admin\\secret.txt and api_key=sk-1234567890abcd; password=hunter2';

  it('redacts paths and secrets in the judge prompt and withholds identities', async () => {
    const model = judgeModel('{"steps":[]}');
    const evaluator = createStepEvaluator({
      reward: REWARD,
      model,
      privacy: { redactSecrets: true, storeRawText: true }
    });
    await evaluator.evaluateSteps({
      trajectory: makeTrajectory({
        steps: [
          makeStep(0, 'message', { text: 'read C:\\Users\\Admin\\notes.txt then token=ghp_abcdefghijklmnopqrstuvwxyz' }),
          makeStep(1, 'model'),
          makeStep(2, 'result')
        ]
      }),
      task: { id: 'task-1', prompt: secretPrompt }
    });
    const prompt = model.requests[0]?.messages[0]?.content ?? '';
    expect(prompt).not.toContain('C:\\Users');
    expect(prompt).toContain('<path>');
    expect(prompt).toContain('<secret>');
    expect(prompt).not.toContain('patch-1');
    expect(prompt).not.toContain('branch-1');
    expect(prompt).not.toContain('session-1');
  });

  it('withholds raw text entirely when storeRawText is false', async () => {
    const model = judgeModel('{"steps":[]}');
    const evaluator = createStepEvaluator({ reward: REWARD, model });
    await evaluator.evaluateSteps({
      trajectory: makeTrajectory({
        steps: [makeStep(0, 'message', { text: 'C:\\secret.txt' }), makeStep(1, 'model'), makeStep(2, 'result')]
      }),
      task: TASK
    });
    const prompt = model.requests[0]?.messages[0]?.content ?? '';
    expect(prompt).toContain('(raw text withheld)');
    expect(prompt).not.toContain('secret.txt');
  });

  it('keeps diagnostics free of text content', async () => {
    const model = judgeModel('garbage');
    const evaluator = createStepEvaluator({ reward: REWARD, model });
    await evaluator.evaluateSteps({
      trajectory: makeTrajectory({ steps: [makeStep(0, 'message', { text: 'C:\\secret.txt' }), makeStep(1, 'model'), makeStep(2, 'result')] }),
      task: { id: 'task-1', prompt: secretPrompt }
    });
    for (const line of evaluator.diagnostics()) {
      expect(line).not.toContain('secret');
      expect(line).not.toContain('C:\\');
    }
  });

  it('redacts absolute paths and secrets as standalone helpers', () => {
    expect(redactAbsolutePaths('see /usr/local/bin/x and C:\\Temp\\a')).toBe('see <path> and <path>');
    expect(redactCommonSecrets('api_key=abcd1234 ok')).toBe('<secret> ok');
    expect(redactCommonSecrets('api_key=abcd1234 ok')).not.toContain('abcd1234');
    expect(redactCommonSecrets('plain text')).toBe('plain text');
  });
});

describe('determinism and contract adapter', () => {
  it('returns identical rewards on repeated evaluations without a model', async () => {
    const evaluator = createStepEvaluator(NO_MODEL_OPTIONS);
    const input = {
      trajectory: makeTrajectory({ steps: [makeStep(0, 'tool', { toolName: 'shell' }), makeStep(1, 'message')] }),
      task: TASK
    };
    const first = await evaluator.evaluateSteps(input);
    const second = await evaluator.evaluateSteps(input);
    expect(first).toEqual(second);
    expect(first.map((reward) => reward.reward)).toEqual([0.1, 0.1]);
  });

  it('returns no rewards and makes no calls for empty trajectories', async () => {
    const model = judgeModel('{"steps":[]}');
    const evaluator = createStepEvaluator({ reward: REWARD, model });
    const rewards = await evaluator.evaluateSteps({
      trajectory: makeTrajectory({ steps: [] }),
      task: TASK
    });
    expect(rewards).toEqual([]);
    expect(model.requests).toHaveLength(0);
  });

  it('implements the frozen IStepEvaluator adapter over the rich path', async () => {
    const evaluator = createStepEvaluator(NO_MODEL_OPTIONS);
    const trajectory = makeTrajectory({ steps: [makeStep(0, 'message')] });
    const viaContract = await evaluator.evaluate(trajectory, { task: TASK });
    const viaRich = await evaluator.evaluateSteps({ trajectory, task: TASK });
    expect(viaContract).toEqual(viaRich);
  });
});

describe('judge prompt hardening (repair B2)', () => {
  it('removes keyword, hyphenated sk- and Bearer secrets from the judge prompt', async () => {
    const model = judgeModel('{"steps":[]}');
    const evaluator = createStepEvaluator({
      reward: REWARD,
      model,
      privacy: { redactSecrets: true, storeRawText: true }
    });
    await evaluator.evaluateSteps({
      trajectory: makeTrajectory({
        steps: [
          makeStep(0, 'message', { text: 'echo password hunter2' }),
          makeStep(1, 'model', { text: 'used sk-live-ABCDEF1234567890' }),
          makeStep(2, 'result', { text: 'Bearer abc.def.ghi presented' })
        ]
      }),
      task: { id: 'task-b2', prompt: 'echo password hunter2 and used sk-live-ABCDEF1234567890' }
    });
    const prompt = model.requests[0]?.messages[0]?.content ?? '';
    expect(prompt).not.toContain('password hunter2');
    expect(prompt).not.toContain('sk-live-');
    expect(prompt).not.toContain('Bearer abc.def.ghi');
    expect(prompt).toContain('<secret>');
  });

  it('removes PEM private-key blocks from the judge prompt', async () => {
    const model = judgeModel('{"steps":[]}');
    const evaluator = createStepEvaluator({
      reward: REWARD,
      model,
      privacy: { redactSecrets: true, storeRawText: true }
    });
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234\n-----END RSA PRIVATE KEY-----';
    await evaluator.evaluateSteps({
      trajectory: makeTrajectory({
        steps: [makeStep(0, 'message', { text: pem }), makeStep(1, 'model'), makeStep(2, 'result')]
      }),
      task: { id: 'task-pem', prompt: 'rotate the deployment key material' }
    });
    const prompt = model.requests[0]?.messages[0]?.content ?? '';
    expect(prompt).not.toContain('PRIVATE KEY');
    expect(prompt).not.toContain('MIIEpA');
  });

  it('leaves clean step text untouched when no secret is present', async () => {
    const model = judgeModel('{"steps":[]}');
    const evaluator = createStepEvaluator({
      reward: REWARD,
      model,
      privacy: { redactSecrets: true, storeRawText: true }
    });
    await evaluator.evaluateSteps({
      trajectory: makeTrajectory({
        steps: [makeStep(0, 'message', { text: 'build passed' }), makeStep(1, 'model'), makeStep(2, 'result')]
      }),
      task: { id: 'task-clean', prompt: 'run the suite' }
    });
    const prompt = model.requests[0]?.messages[0]?.content ?? '';
    expect(prompt).toContain('build passed');
    expect(prompt).not.toContain('<secret>');
  });
});