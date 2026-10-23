/**
 * P1-6: contracts v2 additions for JitRL. Pins the new type surface at
 * compile time (readonly fields, closed unions, generic payload carriers)
 * and verifies the additive-only evolution rules: CONTRACT_SCHEMA_VERSION
 * advanced to 2 without renaming or removing any version 1 export.
 */
import { describe, expect, it } from 'vitest';
import {
  CONTRACT_SCHEMA_VERSION,
  type AbstractState,
  type EightSurfacePatch,
  type ExperienceQuery,
  type ExperienceRecord,
  type GuidanceMode,
  type IExperienceStore,
  type IHarnessProposer,
  type IJitPolicyOptimizer,
  type IStepEvaluator,
  type JitAdjustment,
  type JitCandidate,
  type JitDecision,
  type JitLevel,
  type MetaSearchPolicy,
  type ModelPurpose,
  type ModelRequest,
  type ModelResponse,
  type ProbeTask,
  type ProbeTrajectory,
  type ProposedPatch,
  type ProposedPatchSet,
  type ProposeRequest,
  type ScoredExperience,
  type StepReward
} from '../../../src/types/contracts';

/**
 * Compile-time existence proof for pre-existing version 1 exports: the
 * alias fails to compile if any of them is renamed or removed.
 */
type V1ExportsStillPresent = [
  EightSurfacePatch,
  ProbeTask,
  ProbeTrajectory,
  MetaSearchPolicy,
  ModelRequest,
  ModelResponse,
  ProposeRequest,
  GuidanceMode,
  ProposedPatch,
  IHarnessProposer
];
const v1ExportsStillPresent: V1ExportsStillPresent = null as unknown as V1ExportsStillPresent;
void v1ExportsStillPresent;

const state: AbstractState = {
  level: 'meta',
  bucket: 'signature|complex|exploit',
  tokens: ['signature', 'complex'],
  summary: 'demo state'
};

const record: ExperienceRecord = {
  id: 'exp-1',
  level: 'proposal',
  state: { ...state, level: 'proposal' },
  actionKey: 'patch:abc',
  reward: 1.5,
  return: 2.25,
  rewardSources: { llm: 1.0, tool: 0.5 },
  guidance: 'memory',
  policyId: 'policy-1',
  sessionId: 'session-1',
  treeId: 'tree-1',
  nodeId: 'node-1',
  createdAt: 1_700_000_000_000,
  redacted: true
};

const candidate: JitCandidate<{ patchId: string }> = {
  actionKey: 'patch:abc',
  baseLogit: 0.25,
  source: 'memory_augmented',
  payload: { patchId: 'p-1' }
};

const adjustment: JitAdjustment<{ patchId: string }> = {
  candidate,
  q: null,
  advantage: 0.5,
  normalizedAdvantage: 0.5,
  adjustedLogit: 0.75,
  probability: 0.5,
  support: 3,
  explored: false
};

const decision: JitDecision<{ patchId: string }> = {
  level: 'proposal',
  stateValue: 0.25,
  neighborCount: 10,
  adjustments: [adjustment],
  chosen: adjustment,
  klToPrior: 0.01,
  rationale: 'prior kept'
};

const scored: ScoredExperience = { record, similarity: 0.9 };
const weighted: ScoredExperience = { record, similarity: 0.9, weight: 0.8 };

const request: ModelRequest = {
  purpose: 'evaluate_steps',
  messages: [{ role: 'user', content: 'score this step' }],
  logprobs: { topK: 5 }
};

const response: ModelResponse = {
  text: 'ok',
  tokenLogprobs: [{ token: 'x', logprob: -0.1, top: [{ token: 'y', logprob: -0.2 }] }]
};

type CandidateCountField = ProposeRequest['candidateCount'];
const candidateCount: CandidateCountField = 3;

// P3-A: additive proposal-set surface. The empty patch keeps this test
// dependency-free; only shape matters here.
const emptyPatch: EightSurfacePatch = {
  id: 'patch-1',
  sessionId: 'session-1',
  branchId: 'branch-1',
  origin: 'reference',
  purpose: 'initial',
  guidance: 'memory',
  label: 'label',
  rationale: 'rationale',
  edits: {},
  createdAt: 0
};

const proposed: ProposedPatch = {
  patch: emptyPatch,
  rationale: 'single candidate',
  focusSurfaces: ['guardrails'],
  confidence: 0.8
};

const proposedSet: ProposedPatchSet = {
  candidates: [proposed, { ...proposed, confidence: 0.4 }]
};

// Optional method check: a propose-only implementation must still satisfy the
// interface, and an implementation may add proposeCandidates without changing it.
const singleCandidateProposer: IHarnessProposer = {
  propose: async () => proposed
};

const multiCandidateProposer: IHarnessProposer = {
  propose: async () => proposed,
  proposeCandidates: async () => proposedSet
};

type IsOptional<T, K extends keyof T> = {} extends Pick<T, K> ? true : false;
const candidateCountIsOptional: IsOptional<ProposeRequest, 'candidateCount'> = true;

const basePolicy: MetaSearchPolicy = {
  id: 'policy-1',
  version: 1,
  createdAt: 0,
  maxWidth: 4,
  maxDepth: 3,
  slotWeights: { exploit: 1, explore_domain: 1, explore_invariant: 1, recover: 1 },
  earlyStopThreshold: 0.8,
  minMemoryConfidenceForSkip: 0.75
};

const policyWithJit: MetaSearchPolicy = {
  ...basePolicy,
  jit: { beta: 1, lambda: 0.05, alpha: 5, k: 10, gamma: 0.5, similarityThreshold: 0.3 }
};

const LEVELS: readonly JitLevel[] = ['meta', 'proposal', 'host_tool'];

const PURPOSES: readonly ModelPurpose[] = [
  'propose',
  'compose',
  'reflect',
  'dream_policy',
  'probe',
  'evaluate_steps',
  'abstract_state'
];

// Minimal dependency-free implementations: the new contracts must stay
 // implementable by the kernel modules without runtime dependencies.
const noopStore: IExperienceStore = {
  append: async () => undefined,
  query: async () => [],
  size: async () => 0,
  compact: async () => 0,
  export: () => (async function* generatedExperience() {})()
};

const noopEvaluator: IStepEvaluator = {
  evaluate: async () => []
};

const noopOptimizer: IJitPolicyOptimizer = {
  decide: async <T>(
    level: JitLevel,
    decideState: AbstractState,
    candidates: readonly JitCandidate<T>[]
  ): Promise<JitDecision<T>> => {
    const first: JitCandidate<T> | undefined = candidates[0];
    if (first === undefined) {
      throw new Error('no candidates');
    }
    void decideState;
    const chosen: JitAdjustment<T> = {
      candidate: first,
      q: null,
      advantage: 0,
      normalizedAdvantage: 0,
      adjustedLogit: first.baseLogit,
      probability: 1,
      support: 0,
      explored: false
    };
    return {
      level,
      stateValue: 0,
      neighborCount: 0,
      adjustments: [chosen],
      chosen,
      klToPrior: 0,
      rationale: 'noop'
    };
  }
};

/**
 * Compile-time assertions. Each @ts-expect-error line fails `tsc --noEmit`
 * (and therefore `pnpm run typecheck`) if the guarded rule is loosened. The
 * body never runs, so the violations stay out of the runtime behaviour.
 */
function contractCompileTimeAssertions(): void {
  // @ts-expect-error AbstractState fields are readonly
  state.bucket = 'mutated';
  // @ts-expect-error tokens is a readonly array
  state.tokens.push('extra');
  // @ts-expect-error 'planning' is not a JitLevel
  const invalidLevel: JitLevel = 'planning';
  // @ts-expect-error unknown purposes are rejected at compile time
  const invalidPurpose: ModelPurpose = 'guess';
  // @ts-expect-error guidance is the closed GuidanceMode union
  const invalidGuidance: ExperienceRecord = { ...record, guidance: 'memory_plus' };
  // @ts-expect-error redacted is required
  const missingRedacted: ExperienceRecord = { ...record, redacted: undefined };
  // @ts-expect-error source is a closed three-value union
  const invalidSource: JitCandidate<{ patchId: string }> = { ...candidate, source: 'hallucinated' };
  // @ts-expect-error q must be a number or null, never undefined
  const invalidQ: JitAdjustment<{ patchId: string }> = { ...adjustment, q: undefined };
  const payload: { patchId: string } = decision.chosen.candidate.payload;
  void payload;
  // @ts-expect-error the payload keeps its generic TPayload type
  const wrongPayload: number = decision.chosen.candidate.payload;
  // @ts-expect-error similarity is readonly
  scored.similarity = 1.0;
  const invalidLogprobs: ModelRequest = {
    purpose: 'abstract_state',
    messages: [],
    // @ts-expect-error logprobs.topK must be a number
    logprobs: { topK: '5' }
  };
  const invalidTokenLogprobs: ModelResponse = {
    text: 'ok',
    // @ts-expect-error tokenLogprobs entries need a string token
    tokenLogprobs: [{ token: 7, logprob: -0.1 }]
  };
  // @ts-expect-error candidateCount must be a number when present
  const invalidCandidateCount: CandidateCountField = '3';
  const invalidJit: MetaSearchPolicy = {
    ...basePolicy,
    // @ts-expect-error jit.k must be a number
    jit: { beta: 1, lambda: 0.05, alpha: 5, k: '10', gamma: 0.5, similarityThreshold: 0.3 }
  };
  // @ts-expect-error ProposedPatchSet.candidates is a readonly array
  proposedSet.candidates.push(proposed);
  // @ts-expect-error ProposedPatch.confidence must be a number
  const invalidConfidence: ProposedPatch = { ...proposed, confidence: '0.8' };
  // @ts-expect-error candidateCount stays optional but is never null
  const invalidNullCandidateCount: CandidateCountField = null;
}
void contractCompileTimeAssertions;

describe('JitRL contracts v2 (P1-6)', () => {
  it('advances CONTRACT_SCHEMA_VERSION to 2 without removing v1 exports', () => {
    expect(CONTRACT_SCHEMA_VERSION).toBe(2);
  });

  it('covers the closed JitLevel union', () => {
    expect(LEVELS).toEqual(['meta', 'proposal', 'host_tool']);
  });

  it('covers the extended ModelPurpose union', () => {
    expect(PURPOSES).toContain('evaluate_steps');
    expect(PURPOSES).toContain('abstract_state');
  });

  it('accepts a full experience query shape against the store contract', async () => {
    const records: readonly ExperienceRecord[] = [record];
    await noopStore.append(records);
    await expect(noopStore.size('meta')).resolves.toBe(0);
    await expect(noopStore.size()).resolves.toBe(0);
    const query: ExperienceQuery = {
      level: 'proposal',
      state: record.state,
      k: 10,
      similarityThreshold: 0.3,
      guidanceFilter: 'memory',
      before: 1_700_000_000_000
    };
    await expect(noopStore.query(query)).resolves.toEqual([]);
    await expect(noopStore.compact({ maxPerBucket: 200 })).resolves.toBe(0);
    let exported = 0;
    for await (const entry of noopStore.export()) {
      exported += 1;
      void entry;
    }
    expect(exported).toBe(0);
  });

  it('keeps the generic payload type on optimizer decisions', async () => {
    const decided = await noopOptimizer.decide('meta', state, [
      { actionKey: 'widen', baseLogit: 0.5, source: 'policy_prior', payload: 1 }
    ]);
    expect(decided.chosen.candidate.payload).toBe(1);
    expect(decided.rationale).toBe('noop');
  });

  it('implements the step evaluator contract with a minimal fake', async () => {
    // The fake ignores its arguments; the heavy trajectory/task shapes are
    // pinned by the V1ExportsStillPresent tuple above.
    const rewards: readonly StepReward[] = await noopEvaluator.evaluate(
      null as unknown as ProbeTrajectory,
      { task: null as unknown as ProbeTask }
    );
    expect(rewards).toEqual([]);
  });

  it('keeps MetaSearchPolicy.jit optional and additive', () => {
    expect(basePolicy.jit).toBeUndefined();
    expect(policyWithJit.jit).toEqual({
      beta: 1,
      lambda: 0.05,
      alpha: 5,
      k: 10,
      gamma: 0.5,
      similarityThreshold: 0.3
    });
    expect(scored.weight).toBeUndefined();
    expect(weighted.weight).toBe(0.8);
  });

  it('carries request/response logprob fields additively', () => {
    expect(request.logprobs).toEqual({ topK: 5 });
    expect(response.tokenLogprobs).toEqual([
      { token: 'x', logprob: -0.1, top: [{ token: 'y', logprob: -0.2 }] }
    ]);
    expect(candidateCount).toBe(3);
  });
});

describe('L2 proposal-set increment (P3-A)', () => {
  it('keeps a propose-only implementation valid and leaves the optional method absent', async () => {
    expect(singleCandidateProposer.proposeCandidates).toBeUndefined();
    await expect(singleCandidateProposer.propose({} as ProposeRequest)).resolves.toBe(
      proposed
    );
  });

  it('supports an implementation that adds the optional multi-candidate path', async () => {
    const result = await multiCandidateProposer.proposeCandidates?.(
      {} as ProposeRequest
    );
    expect(result?.candidates).toHaveLength(2);
    expect(result?.candidates.map((candidate) => candidate.confidence)).toEqual([
      0.8, 0.4
    ]);
    expect(result?.candidates[0]?.patch).toBe(emptyPatch);
  });

  it('pins the new payload shape without requiring candidateCount', () => {
    expect(candidateCountIsOptional).toBe(true);
    expect(candidateCount).toBe(3);
    expect(proposedSet.candidates[0]?.focusSurfaces).toEqual(['guardrails']);
  });
});