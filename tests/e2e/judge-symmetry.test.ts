/**
 * rev6 audit A4-4 / A6 H6' — symmetric LLM step judging.
 *
 * Two independent facts are pinned:
 *
 * 1. PRODUCTION WIRING: `buildJitRlWiring` (the single construction point used
 *    by `createEvoHarnessPlugin`) builds the kernel with `judgePolicy: 'all'`,
 *    so a ONE-step, unselected probe is judged. Before A4-4 the cost gate
 *    (`steps >= 3 || selected || composed || Δsurrogate > 0.2`) skipped exactly
 *    that shape, which made the auxiliary judge signal a function of the
 *    Composer's choice.
 *
 * 2. ORCHESTRATOR SYMMETRY: `recordOnlineExperience` calls the evaluator once
 *    per EXECUTED probe (not once for the winner), and every record - winner,
 *    sibling, audit-only - carries its OWN `rewardSources.stepJudge`. The test
 *    uses distinct per-call judge scores, so a copied winner vector or a
 *    winner-only call cannot pass.
 *
 * The primary reward is untouched: it still comes from
 * `scoreUnderRewardContract` (M3 keeps asserting that equality), and the judge
 * mean is auxiliary only.
 */
import { describe, expect, it } from 'vitest';

import { parseEvoHarnessConfig } from '../../src/config';
import { createActivePolicyFromDefaults } from '../../src/dream-rsi';
import { buildJitRlWiring, createEvoHarnessPlugin } from '../../src/index';
import { createStepEvaluator } from '../../src/jitrl/step-evaluator';
import {
  createMemoryExperienceStore,
  type MemoryExperienceStore
} from '../../src/jitrl/stores/memory.store';
import type {
  AbstractState,
  ExperienceRecord,
  IModelAdapter,
  IStepEvaluator,
  JitCandidate,
  JitDecision,
  JitLevel,
  ModelRequest,
  ModelResponse,
  ProbeTask,
  ProbeTrajectory,
  StepReward
} from '../../src/types/contracts';
import {
  buildE2E,
  createFakeContext,
  createPatchAwareHostLlm,
  createScriptedRunner,
  e2eConfig,
  makeClock,
  makeIdFactory,
  mem0LikeServer
} from './fixtures';

function oneStepTrajectory(id: string): ProbeTrajectory {
  return {
    id,
    sessionId: 's-judge',
    branchId: 'b-' + id,
    branchNamespace: 'ns',
    role: 'candidate',
    status: 'succeeded',
    patchId: 'p',
    patchOrigin: 'domain',
    surfaceKeys: ['system_prompt'],
    startedAt: 0,
    endedAt: 1,
    metrics: { steps: 1, toolCalls: 0, toolErrors: 0, durationMs: 1 },
    steps: [{ index: 0, at: 1, kind: 'message', text: 'single step' }],
    toolErrors: [],
    failureSignals: [],
    memoryRecallIds: [],
    deliverable: { content: 'judge me', format: 'text' }
  };
}

/**
 * Judge fake: returns one score per step, distinct per CALL. The call sequence
 * is the only ordering the evaluator can observe, so distinct values make a
 * "copy the first result" implementation fail.
 */
function createJudgeModel(): IModelAdapter & { readonly requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  let call = 0;
  const propose = {
    rationale: 'judge-symmetry proposal',
    focusSurfaces: ['system_prompt'],
    confidence: 0.7,
    expectedStepsDelta: -1,
    edits: {
      system_prompt: { kind: 'system_prompt', mode: 'append', content: 'judge-symmetry marker' }
    }
  };
  return {
    requests,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      if (request.purpose === 'evaluate_steps') {
        requests.push(request);
        const callIndex = call;
        call += 1;
        const prompt = request.messages.map((message) => message.content).join('\n');
        const indices = [...prompt.matchAll(/- step (\d+):/g)].map((match) => Number(match[1]));
        const score = callIndex % 2 === 0 ? 2 : -2;
        return {
          text: JSON.stringify({
            steps: (indices.length > 0 ? indices : [0]).map((stepIndex) => ({
              stepIndex,
              score
            }))
          }),
          finishReason: 'stop',
          model: 'judge-fake'
        };
      }
      if (request.purpose === 'propose') {
        return { text: JSON.stringify(propose), finishReason: 'stop', model: 'judge-fake' };
      }
      if (request.purpose === 'compose') {
        const text = request.messages.map((message) => message.content).join('\n');
        const aliases = [...new Set(text.match(/candidate_[A-Z]/g) ?? [])];
        return {
          text: JSON.stringify({
            ranking: aliases,
            assessments: aliases.map((alias) => ({ alias, rationale: 'ranked' }))
          }),
          finishReason: 'stop',
          model: 'judge-fake'
        };
      }
      if (request.purpose === 'reflect') {
        return { text: JSON.stringify({ lessons: [] }), finishReason: 'stop', model: 'judge-fake' };
      }
      return { text: JSON.stringify({ policies: [] }), finishReason: 'stop', model: 'judge-fake' };
    }
  };
}

/** The same deterministic optimizer stub the credit-attribution suite uses. */
function optimizerStub(): {
  decide<T>(
    level: JitLevel,
    state: AbstractState,
    candidates: readonly JitCandidate<T>[]
  ): Promise<JitDecision<T>>;
} {
  return {
    async decide<T>(
      level: JitLevel,
      _state: AbstractState,
      candidates: readonly JitCandidate<T>[]
    ): Promise<JitDecision<T>> {
      const probability = 1 / Math.max(1, candidates.length);
      const adjustments = candidates.map((candidate) => ({
        candidate,
        q: null,
        advantage: 0,
        normalizedAdvantage: 0,
        adjustedLogit: candidate.baseLogit,
        probability,
        support: 0,
        explored: false
      }));
      return {
        level,
        stateValue: 0,
        neighborCount: 0,
        adjustments,
        chosen: adjustments[0] as (typeof adjustments)[number],
        klToPrior: 0,
        rationale: 'judge-symmetry stub'
      };
    }
  };
}

function metaRecords(store: MemoryExperienceStore): readonly ExperienceRecord[] {
  return store.snapshot().filter((record) => record.level === 'meta' && record.id.startsWith('online-'));
}

describe('production wiring: judgePolicy all reaches a one-step probe', () => {
  it('buildJitRlWiring judges a one-step, unselected trajectory', async () => {
    const config = parseEvoHarnessConfig({
      jitrl: { enabled: true, levels: ['meta', 'proposal'], candidateCount: 1 }
    });
    const now = makeClock();
    const policy = createActivePolicyFromDefaults({}, { now });
    const model = createJudgeModel();
    const wiring = buildJitRlWiring({
      config,
      policy,
      options: { model },
      persistence: undefined,
      diagnostics: [],
      now
    });
    const kernel = wiring.wiring.kernel;
    expect(kernel).toBeDefined();
    const rewards = await kernel?.stepEvaluator.evaluateSteps({
      trajectory: oneStepTrajectory('prod-one-step'),
      task: { id: 'task-judge', prompt: 'judge this' }
    });
    // A one-step trajectory has no selected/composed/delta hint and is below
    // MIN_STEPS_FOR_LLM_JUDGE; only `all` would call the judge here.
    expect(model.requests.filter((request) => request.purpose === 'evaluate_steps')).toHaveLength(1);
    expect(rewards?.[0]?.sources.evaluated).toBe(1);
    expect(rewards?.[0]?.sources.llm).toBe(2);
  });
});

describe('orchestrator symmetry: every executed probe is judged and keeps its own mean', () => {
  it('judge calls equal executed probes; stepJudge differs per probe; primary reward unchanged', async () => {
    const now = makeClock();
    const store = createMemoryExperienceStore({ now, halfLifeMs: 1_000_000_000 });
    const judgeModel = createJudgeModel();
    const evaluatorCalls: ProbeTrajectory[] = [];
    const inner = createStepEvaluator({
      reward: parseEvoHarnessConfig(e2eConfig()).jitrl.reward,
      model: judgeModel,
      judgePolicy: 'all'
    });
    const recordingEvaluator: IStepEvaluator & {
      evaluateSteps(input: { trajectory: ProbeTrajectory; task: ProbeTask }): Promise<readonly StepReward[]>;
    } = {
      async evaluate(trajectory, context) {
        evaluatorCalls.push(trajectory);
        return inner.evaluate(trajectory, context);
      },
      async evaluateSteps(input) {
        evaluatorCalls.push(input.trajectory);
        return inner.evaluateSteps(input);
      }
    };
    const config = parseEvoHarnessConfig(e2eConfig({ dreamEveryNTasks: 100 }));
    const stages: { stage: string; detail?: Readonly<Record<string, unknown>> }[] = [];
    const server = mem0LikeServer();
    const plugin = createEvoHarnessPlugin(
      {
        config: e2eConfig({
          dreamEveryNTasks: 100,
          config: { jitrl: { enabled: true, levels: ['meta', 'proposal'], candidateCount: 1 } }
        }),
        model: judgeModel,
        clients: [server.client],
        runBranch: createScriptedRunner(now),
        now,
        newId: makeIdFactory('judge-symmetry'),
        deps: {
          jitrl: {
            store,
            optimizer: optimizerStub(),
            stepEvaluator: recordingEvaluator,
            config: {
              enabled: config.jitrl.enabled,
              levels: config.jitrl.levels,
              gamma: config.jitrl.gamma,
              candidateCount: 1,
              k: config.jitrl.k,
              similarityThreshold: config.jitrl.similarityThreshold,
              augmentFromMemory: false,
              minSupportForStrongPrior: config.jitrl.minSupportForStrongPrior
            }
          },
          onStage: (event) => stages.push({ stage: event.stage, detail: event.detail })
        }
      },
      {}
    );

    const result = await plugin.run({
      sessionId: 'sess-judge-symmetry',
      task: plugin.makeTask({ id: 'task-judge-symmetry', prompt: 'Fix the failing build.' }),
      trigger: 'always'
    });
    expect(result.outcome).toBe('composed');

    const records = metaRecords(store);
    expect(records.length).toBeGreaterThan(0);
    // One evaluator call per executed probe, and one judge model call per
    // evaluator call (all policy + model available).
    expect(evaluatorCalls).toHaveLength(records.length);
    const judgeRequests = judgeModel.requests.filter(
      (request) => request.purpose === 'evaluate_steps'
    );
    expect(judgeRequests).toHaveLength(evaluatorCalls.length);

    // Every record, winner or sibling or audit-only, carries its own numeric
    // stepJudge. A winner-only implementation leaves the siblings undefined.
    for (const record of records) {
      expect(record.rewardSources.stepJudge, record.id).toBeTypeOf('number');
    }
    const values = records.map((record) => record.rewardSources.stepJudge);
    // The fake returns 2 on the first call and -2 on the second, so equal
    // values would prove a copied winner vector.
    expect(new Set(values).size).toBe(new Set(evaluatorCalls.map((entry) => entry.id)).size);

    // Primary target remains the RewardContract aggregation, never the judge
    // mean: all candidates here are text-only and unverified, so A4-3 marks
    // them not-evaluable and the primary reward is 0.
    expect(records.every((record) => record.reward === 0)).toBe(true);
    expect(records.every((record) => record.learningEligible === false)).toBe(true);
    expect(records.every((record) => record.rewardSources.notEvaluable === 1)).toBe(true);

    const stage = stages.find((entry) => entry.stage === 'evaluate_steps');
    const stageDetail = stage?.detail as
      | { readonly detail?: Readonly<Record<string, unknown>> }
      | undefined;
    expect(stageDetail?.detail).toMatchObject({ probes: records.length });
    await plugin.dispose();
  });

  it('uses the ctx.llm-only model for the judge (the documented DSH mount)', async () => {
    // A4-4 / B3: the kernel used to be built before the ctx.llm adapter was
    // resolved, and only `options.model` reached createJitRl. On the documented
    // DSH path (no options.model) `llmAvailable` was therefore always false and
    // the `all` policy judged nothing. The forwarding adapter now bridges the
    // deferred model into the kernel.
    const host = createPatchAwareHostLlm();
    const { ctx } = createFakeContext();
    const stages: { stage: string; detail?: Readonly<Record<string, unknown>> }[] = [];
    const plugin = createEvoHarnessPlugin(
      {
        config: e2eConfig({
          dreamEveryNTasks: 100,
          config: { jitrl: { enabled: true, levels: ['meta', 'proposal'], candidateCount: 1 } }
        }),
        now: makeClock(),
        deps: {
          onStage: (event) => {
            stages.push({ stage: event.stage, ...(event.detail === undefined ? {} : { detail: event.detail }) });
          }
        }
      },
      { ...ctx, llm: host }
    );
    await plugin.collaborators;

    const result = await plugin.run({
      sessionId: 'sess-judge-ctx-llm',
      task: plugin.makeTask({ id: 'task-judge-ctx-llm', prompt: 'Fix the failing build.' }),
      trigger: 'always'
    });
    expect(result.outcome).toBe('composed');
    expect(result.probesRun).toBeGreaterThan(1);

    const evaluateStage = stages.find((entry) => entry.stage === 'evaluate_steps');
    const stageDetail = evaluateStage?.detail as
      | { readonly detail?: Readonly<Record<string, unknown>> }
      | undefined;
    const probes = stageDetail?.detail?.['probes'];
    expect(probes).toBe(result.probesRun - 1);
    // One judge dispatch per executed candidate probe, through ctx.llm.
    expect(host.judgePrompts).toHaveLength(Number(probes));
    await plugin.dispose();
  });
});