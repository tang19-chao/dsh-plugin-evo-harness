/**
 * Phase 4 dual-loop tests: JitRL hyperparameter perturbation, the synchronous
 * replay hook, causal truncation and monotone hot-swap (plan sections 7.3, 8-P4).
 *
 * Every fixture here is synthetic: no host, no network, no sandbox, no LLM. The
 * "adapter" hook below is the closed-form correction an integrator would wire to
 * src/jitrl/logit-adjuster.ts; it lives in the test so the acceptance numbers are
 * readable and independent of the kernel's own configuration defaults.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_JIT_BETAS,
  DEFAULT_JIT_KS,
  DEFAULT_JIT_LAMBDAS,
  DEFAULT_JIT_SIMILARITY_THRESHOLDS,
  JIT_IGNORED_DIMENSIONS,
  causalCutoffFor,
  causalExperienceSnapshot,
  createModelPolicyGenerator,
  createOfflineDreamer,
  defaultJitHyperparams,
  generateCandidatePolicies,
  jitHyperparamIssues,
  replayPolicy,
  replayTree,
  resolveJitPerturbationGrid,
  sanitizeJitHyperparams,
  toPolicyEvaluation,
  type JitHyperparams
} from '../../../src/dream-rsi/offline-dreamer';
import { createActivePolicy } from '../../../src/dream-rsi/active-policy';
import { createDiscoveryTree } from '../../../src/dream-rsi/discovery-tree';
import type {
  BatchSlotKind,
  DiscoveryTreeSnapshot,
  ExperienceRecord,
  IModelAdapter,
  JitReplayHook,
  JitReplayHookDiagnostics,
  JitReplayHookInput,
  MetaSearchPolicy,
  OfflineDreamRequest
} from '../../../src/types/contracts';
import { fixedClock, makePolicy } from './fixtures';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The four slot kinds, in the frozen contract order. */
const ALL_SLOTS: readonly BatchSlotKind[] = [
  'exploit',
  'explore_domain',
  'explore_invariant',
  'recover'
];

/** The three addressable search tracks (recovery is not a portfolio track). */
const SEARCH_SLOTS: readonly BatchSlotKind[] = [
  'exploit',
  'explore_domain',
  'explore_invariant'
];

/**
 * Trade-off weights used by the acceptance fixture: a heavy invariant prior that
 * the hook has to overcome before the domain branch becomes attractive.
 */
const TRADE_OFF_WEIGHTS: Readonly<Record<BatchSlotKind, number>> = {
  exploit: 0.2,
  explore_domain: 0.1,
  explore_invariant: 0.7,
  recover: 0.1
};

/** The candidate's own jit record used by the acceptance fixture. */
const ACCEPTANCE_JIT: JitHyperparams = {
  beta: 1,
  lambda: 0.05,
  alpha: 5,
  k: 10,
  gamma: 0.5,
  similarityThreshold: 0.3
};

/** The evidence that makes beta=2 the true optimum in the acceptance fixture. */
const ACCEPTANCE_EVIDENCE: Readonly<Record<BatchSlotKind, number>> = {
  exploit: 0.9,
  explore_domain: 0,
  explore_invariant: 0,
  recover: 0
};

/** A hook vector that ignores every prior and orders strictly by recorded score. */
const EXPLOIT_ONLY: Readonly<Record<BatchSlotKind, number>> = {
  exploit: 1,
  explore_domain: 0,
  explore_invariant: 0,
  recover: 0
};

interface TreeParts {
  addNode(input: {
    id: string;
    parentId?: string;
    patchOrigin?: 'reference' | 'domain' | 'invariant';
    purpose?: 'initial' | 'explore' | 'deepen' | 'repair';
    guidance?: 'memory' | 'guidance_free';
    status?: 'proposed' | 'succeeded' | 'failed' | 'pruned';
    score?: number;
    createdAt?: number;
  }): void;
  snapshot(): DiscoveryTreeSnapshot;
}

/** Discovery tree with a fixed root id ('root') and a deterministic creation time. */
function createTree(options: { id: string; createdAt: number }): TreeParts {
  const tree = createDiscoveryTree({
    id: options.id,
    sessionId: 'session-1',
    taskId: 'task-1',
    rootPatchId: 'patch-root',
    createdAt: options.createdAt,
    idFactory: () => 'root',
    clock: fixedClock(options.createdAt)
  });
  return {
    addNode: (input) => {
      tree.addNode({
        id: input.id,
        parentId: input.parentId ?? null,
        branchId: options.id + ':' + input.id,
        patchId: 'patch-' + input.id,
        patchOrigin: input.patchOrigin ?? 'reference',
        purpose: input.purpose ?? 'initial',
        guidance: input.guidance ?? 'memory',
        status: input.status ?? 'proposed',
        ...(input.score === undefined ? {} : { score: input.score }),
        ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt })
      });
    },
    snapshot: () => tree.snapshot()
  };
}

/**
 * The acceptance tree.
 *
 * `X` is the branch the uncorrected portfolio prefers: it is invariant-guided
 * (`guidance_free`) and as old as the root, so it collects the recency bonus and
 * the invariant bonus. `X1` is a cheap follow-up below `X` (score 0.4). `Y` is a
 * single high-score domain leaf created last, so it has no recency bonus at all.
 *
 * The prior puts X far ahead of Y (0.83 vs 0.20 with TRADE_OFF_WEIGHTS). A
 * beta-corrected portfolio flips that ordering only from beta >= ~1.7: at beta=2
 * the exploit share dominates, Y wins the frontier, and its recorded score of 1.0
 * makes the replayed policy early-stop after one candidate probe instead of
 * crawling down the low-value branch. That is why the true optimum is beta=2.
 */
function acceptanceTree(): DiscoveryTreeSnapshot {
  const tree = createTree({ id: 'tree-acceptance', createdAt: 900 });
  tree.addNode({
    id: 'X',
    parentId: 'root',
    patchOrigin: 'invariant',
    purpose: 'explore',
    guidance: 'guidance_free',
    status: 'succeeded',
    score: 0.2,
    createdAt: 900
  });
  tree.addNode({
    id: 'X1',
    parentId: 'X',
    purpose: 'deepen',
    status: 'succeeded',
    score: 0.4,
    createdAt: 1100
  });
  tree.addNode({
    id: 'Y',
    parentId: 'root',
    patchOrigin: 'domain',
    purpose: 'explore',
    status: 'succeeded',
    score: 1,
    createdAt: 1100
  });
  return tree.snapshot();
}

/** Simple wide tree: three shallow, equally-scored children below a scoreless root. */
function threeSiblingTree(): DiscoveryTreeSnapshot {
  const tree = createTree({ id: 'tree-wide', createdAt: 1000 });
  for (const id of ['a', 'b', 'c']) {
    tree.addNode({
      id,
      parentId: 'root',
      status: 'succeeded',
      score: 0.1,
      createdAt: 1000
    });
  }
  return tree.snapshot();
}

function policy(overrides: Partial<MetaSearchPolicy> = {}): MetaSearchPolicy {
  return makePolicy({
    id: 'pi-0',
    version: 1,
    maxWidth: 1,
    maxDepth: 2,
    earlyStopThreshold: 0.8,
    slotWeights: TRADE_OFF_WEIGHTS,
    jit: { ...ACCEPTANCE_JIT },
    ...overrides
  });
}

/** Closed-form share correction, mirroring logit-adjuster's softmax solution. */
function correctedShares(
  input: JitReplayHookInput,
  evidence: Readonly<Record<BatchSlotKind, number>>
): Record<BatchSlotKind, number> {
  let priorTotal = 0;
  for (const kind of SEARCH_SLOTS) {
    priorTotal += input.slotWeights[kind] ?? 0;
  }
  const prior = (kind: BatchSlotKind): number =>
    priorTotal > 0 ? (input.slotWeights[kind] ?? 0) / priorTotal : 1 / SEARCH_SLOTS.length;
  const raw: Record<BatchSlotKind, number> = {
    exploit: prior('exploit') * Math.exp(input.jit.beta * (evidence.exploit ?? 0)),
    explore_domain:
      prior('explore_domain') * Math.exp(input.jit.beta * (evidence.explore_domain ?? 0)),
    explore_invariant:
      prior('explore_invariant') * Math.exp(input.jit.beta * (evidence.explore_invariant ?? 0)),
    recover: input.slotWeights.recover ?? 0
  };
  let total = 0;
  for (const kind of ALL_SLOTS) {
    total += raw[kind];
  }
  return {
    exploit: raw.exploit / total,
    explore_domain: raw.explore_domain / total,
    explore_invariant: raw.explore_invariant / total,
    recover: raw.recover / total
  };
}

/** Per-call diagnostics emitted by the adapter hook. */
function adapterDiagnostics(
  input: JitReplayHookInput,
  evidence: Readonly<Record<BatchSlotKind, number>>,
  klToPrior = 0.5,
  stateValue = 0.25
): JitReplayHookDiagnostics {
  const adjustments = SEARCH_SLOTS.map((slot) => {
    const base = input.slotWeights[slot] ?? 0;
    return {
      actionKey: slot,
      slot,
      baseWeight: base,
      adjustedWeight: base,
      q: null,
      advantage: evidence[slot] ?? 0,
      normalizedAdvantage: evidence[slot] ?? 0,
      support: input.experiences.length,
      explored: false
    };
  });
  return {
    level: 'meta',
    stateValue,
    neighborCount: input.experiences.length,
    klToPrior,
    adjustments
  };
}

/**
 * The adapter hook: resize every search share by exp(beta * A) in the closed
 * form of plan section 6.4, then report the causal neighbour count. Cold-start
 * (no neighbours) is a normal path: the prior weights are returned unchanged.
 */
function adapterHook(
  evidence: Readonly<Record<BatchSlotKind, number>>,
  seen?: JitReplayHookInput[]
): JitReplayHook {
  return (input) => {
    seen?.push(input);
    if (input.experiences.length === 0) {
      return {
        slotWeights: input.slotWeights,
        diagnostics: adapterDiagnostics(input, evidence, 0, 0)
      };
    }
    return {
      slotWeights: correctedShares(input, evidence),
      diagnostics: adapterDiagnostics(input, evidence)
    };
  };
}

function makeExperience(
  id: string,
  createdAt: number,
  overrides: Partial<ExperienceRecord> = {}
): ExperienceRecord {
  return {
    id,
    level: 'meta',
    state: {
      level: 'meta',
      bucket: 'meta|sig:search|cx:moderate',
      tokens: ['sig:search', 'cx:moderate'],
      summary: 'synthetic state'
    },
    actionKey: 'exploit|system_prompt',
    reward: 0.5,
    return: 0.5,
    rewardSources: { surrogate: 0.5 },
    guidance: 'memory',
    policyId: 'pi-0',
    sessionId: 'session-1',
    createdAt,
    redacted: true,
    ...overrides
  };
}

function dreamRequest(overrides: Partial<OfflineDreamRequest> = {}): OfflineDreamRequest {
  return {
    trees: overrides.trees ?? [acceptanceTree()],
    baselinePolicy: overrides.baselinePolicy ?? policy(),
    candidatePolicies: overrides.candidatePolicies ?? [],
    ...(overrides.rhoPreferences === undefined ? {} : { rhoPreferences: overrides.rhoPreferences }),
    ...(overrides.minReplayTrees === undefined
      ? {}
      : { minReplayTrees: overrides.minReplayTrees })
  };
}

// ---------------------------------------------------------------------------
// 1. Hyperparameter perturbation (plan section 7.3-1)
// ---------------------------------------------------------------------------

describe('jit hyperparameter perturbation', () => {
  it('sweeps only beta/k/similarityThreshold and inherits the ignored dimensions', () => {
    const baseline = policy();
    const first = generateCandidatePolicies(baseline, 6, { now: () => 11 });
    const second = generateCandidatePolicies(baseline, 6, { now: () => 11 });
    expect(first).toHaveLength(6);
    expect(second.map((entry) => entry.jit)).toEqual(first.map((entry) => entry.jit));
    // P6 PR5 (plan section 7.2): index i takes betas[i % 3], ks[i % 3] and
    // similarityThresholds[i % 3]; the three swept dimensions move together and
    // are never merged element-wise with the baseline record.
    expect(first.map((entry) => entry.jit?.beta)).toEqual([0.5, 1, 2, 0.5, 1, 2]);
    expect(first.map((entry) => entry.jit?.k)).toEqual([5, 10, 20, 5, 10, 20]);
    expect(first.map((entry) => entry.jit?.similarityThreshold)).toEqual([
      0.2, 0.3, 0.5, 0.2, 0.3, 0.5
    ]);
    // The ignored dimensions are inherited verbatim, and saying so is auditable
    // through metadata.jitIgnored rather than being an implicit no-op.
    for (const candidate of first) {
      expect(candidate.jit?.lambda).toBe(baseline.jit?.lambda);
      expect(candidate.jit?.alpha).toBe(baseline.jit?.alpha);
      expect(candidate.jit?.gamma).toBe(baseline.jit?.gamma);
      expect(candidate.metadata?.jitIgnored).toEqual(['lambda', 'alpha', 'gamma']);
    }
    // A changed dimension must be reported explicitly, not left implicit.
    expect(first[0]?.metadata?.jitK).toBe(5);
    expect(first[0]?.metadata?.jitSimilarityThreshold).toBe(0.2);
    expect(DEFAULT_JIT_BETAS).toEqual([0.5, 1, 2]);
    expect(DEFAULT_JIT_KS).toEqual([5, 10, 20]);
    expect(DEFAULT_JIT_SIMILARITY_THRESHOLDS).toEqual([0.2, 0.3, 0.5]);
    // The lambda grid still exists for backwards compatibility, but it is not
    // what produced the candidates above.
    expect(DEFAULT_JIT_LAMBDAS).toEqual([0.02, 0.05, 0.1]);
  });

  it('is a pure function of its inputs and produces only legal jit records', () => {
    const baseline = policy();
    const candidates = generateCandidatePolicies(baseline, 8, { now: () => 7 });
    for (const candidate of candidates) {
      expect(jitHyperparamIssues(candidate.jit)).toEqual([]);
      expect(Number.isFinite(candidate.jit?.beta)).toBe(true);
      expect(candidate.jit?.beta).toBeGreaterThanOrEqual(0);
      expect(candidate.jit?.lambda).toBeGreaterThanOrEqual(0);
      expect(candidate.jit?.lambda).toBeLessThanOrEqual(1);
      expect(Number.isInteger(candidate.jit?.k)).toBe(true);
    }
    const again = generateCandidatePolicies(baseline, 8, { now: () => 7 });
    expect(JSON.stringify(again)).toBe(JSON.stringify(candidates));
  });

  it('inherits the kernel defaults when the baseline carries no jit record', () => {
    const bare = makePolicy({ id: 'pi-bare', maxWidth: 1, maxDepth: 2 });
    expect(bare.jit).toBeUndefined();
    const candidates = generateCandidatePolicies(bare, 3, { now: () => 1 });
    const defaults = defaultJitHyperparams();
    // Index 0 lands on the first grid point of every swept dimension; the
    // inherited dimensions keep the kernel default verbatim.
    expect(candidates[0]?.jit?.beta).toBe(DEFAULT_JIT_BETAS[0]);
    expect(candidates[0]?.jit?.k).toBe(DEFAULT_JIT_KS[0]);
    expect(candidates[0]?.jit?.similarityThreshold).toBe(
      DEFAULT_JIT_SIMILARITY_THRESHOLDS[0]
    );
    expect(candidates[0]?.jit?.lambda).toBe(defaults.lambda);
    expect(candidates[0]?.jit?.alpha).toBe(defaults.alpha);
    expect(candidates[0]?.jit?.gamma).toBe(defaults.gamma);
    expect(candidates[0]?.metadata?.jitIgnored).toEqual(['lambda', 'alpha', 'gamma']);
  });

  it('keeps the baseline jit untouched when perturbation is switched off', () => {
    const baseline = policy();
    const candidates = generateCandidatePolicies(baseline, 3, {
      now: () => 1,
      jitGrid: { hyperparamPerturbation: false }
    });
    for (const candidate of candidates) {
      expect(candidate.jit).toEqual(baseline.jit);
    }
    const bare = makePolicy({ id: 'pi-bare' });
    const bareCandidates = generateCandidatePolicies(bare, 2, {
      now: () => 1,
      jitGrid: { hyperparamPerturbation: false }
    });
    for (const candidate of bareCandidates) {
      expect(candidate.jit).toBeUndefined();
    }
  });

  it('drops invalid grid entries and falls back to the built-in grids when empty', () => {
    const grid = resolveJitPerturbationGrid({
      candidateJitBetas: [1, Number.NaN, -2, 2, 2],
      candidateJitKs: [0, 3.5, 7],
      candidateJitSimilarityThresholds: [-0.5, 0.4, 2],
      candidateJitLambdas: []
    });
    expect(grid.enabled).toBe(true);
    expect(grid.betas).toEqual([1, 2]);
    // k must stay a positive integer and a threshold must stay inside [0, 1]:
    // both are retriever preconditions, so an illegal grid point is dropped
    // rather than silently clamped into the search space.
    expect(grid.ks).toEqual([7]);
    expect(grid.similarityThresholds).toEqual([0.4]);
    // The legacy lambda grid is still resolved (backwards compatibility) but is
    // reported as ignored, which is what makes "not searched" auditable.
    expect(grid.lambdas).toEqual([...DEFAULT_JIT_LAMBDAS]);
    expect(grid.ignored.map((entry) => entry.dimension)).toEqual([
      'lambda',
      'alpha',
      'gamma'
    ]);
    expect(resolveJitPerturbationGrid({ hyperparamPerturbation: false })).toEqual({
      enabled: false,
      betas: [],
      ks: [],
      similarityThresholds: [],
      lambdas: [],
      ignored: grid.ignored
    });
  });
});

// ---------------------------------------------------------------------------
// 2. jit validation and model-path sanitisation
// ---------------------------------------------------------------------------

describe('jit sanitisation on the model path', () => {
  it('validates a jit record structurally', () => {
    expect(jitHyperparamIssues(ACCEPTANCE_JIT)).toEqual([]);
    expect(jitHyperparamIssues(undefined)).toEqual([]);
    expect(jitHyperparamIssues(null)).toEqual(['jit must be a record']);
    expect(jitHyperparamIssues({ ...ACCEPTANCE_JIT, beta: -1 }).length).toBeGreaterThan(0);
    expect(jitHyperparamIssues({ ...ACCEPTANCE_JIT, lambda: 2 }).length).toBeGreaterThan(0);
    expect(jitHyperparamIssues({ ...ACCEPTANCE_JIT, gamma: 5 }).length).toBeGreaterThan(0);
    expect(jitHyperparamIssues({ ...ACCEPTANCE_JIT, k: 0 }).length).toBeGreaterThan(0);
    expect(jitHyperparamIssues({ ...ACCEPTANCE_JIT, k: 2.5 }).length).toBeGreaterThan(0);
    expect(
      jitHyperparamIssues({ ...ACCEPTANCE_JIT, similarityThreshold: -0.1 }).length
    ).toBeGreaterThan(0);
    expect(jitHyperparamIssues({ ...ACCEPTANCE_JIT, alpha: 'x' }).length).toBeGreaterThan(0);
  });

  it('keeps valid fields and falls back per field with a diagnostic', () => {
    const fallback = ACCEPTANCE_JIT;
    const resolved = sanitizeJitHyperparams(
      { beta: 2, lambda: 'nope', alpha: -3, k: 2.7, gamma: 0.25, similarityThreshold: 1 },
      fallback
    );
    expect(resolved.jit.beta).toBe(2);
    expect(resolved.jit.lambda).toBe(fallback.lambda);
    expect(resolved.jit.alpha).toBe(fallback.alpha);
    expect(resolved.jit.k).toBe(2);
    expect(resolved.jit.gamma).toBe(0.25);
    expect(resolved.jit.similarityThreshold).toBe(1);
    // Exactly the three unusable fields are reported: lambda (wrong type),
    // alpha (negative) and k (fractional).
    expect(resolved.diagnostics).toHaveLength(3);
    expect(resolved.diagnostics.join(' ')).toContain('jit.lambda');
    expect(resolved.diagnostics.join(' ')).toContain('jit.alpha');
    expect(resolved.diagnostics.join(' ')).toContain('jit.k');
    expect(jitHyperparamIssues(resolved.jit)).toEqual([]);
    const nonRecord = sanitizeJitHyperparams(7, fallback);
    expect(nonRecord.jit).toEqual(fallback);
    expect(nonRecord.diagnostics).toHaveLength(1);
  });

  it('preserves a model-proposed jit record instead of dropping it', async () => {
    const baseline = policy();
    const adapter: IModelAdapter = {
      complete: async () => ({
        text:
          '[{"maxWidth": 2, "maxDepth": 2, "earlyStopThreshold": 0.7, "jit": {"beta": 2, "lambda": 0.1, "alpha": 5, "k": 10, "gamma": 0.5, "similarityThreshold": 0.3}}]'
      })
    };
    const generator = createModelPolicyGenerator(adapter, { now: () => 21 });
    const generated = await generator(baseline, 3, dreamRequest());
    expect(generated).toHaveLength(1);
    expect(generated[0]?.jit?.beta).toBe(2);
    expect(generated[0]?.jit?.lambda).toBe(0.1);
    expect(generated[0]?.metadata?.jitSource).toBe('model');
    expect(generated[0]?.metadata?.jitDiagnostics).toBeUndefined();
  });

  it('degrades a malformed model jit record to the baseline and records why', async () => {
    const baseline = policy();
    const adapter: IModelAdapter = {
      complete: async () => ({
        text:
          '[{"maxWidth": 2, "maxDepth": 2, "jit": {"beta": "2", "lambda": 9, "alpha": 4, "k": 3, "gamma": 0.1, "similarityThreshold": 0.2}}]'
      })
    };
    const generator = createModelPolicyGenerator(adapter, { now: () => 21 });
    const generated = await generator(baseline, 3, dreamRequest());
    expect(generated).toHaveLength(1);
    // beta and lambda are unusable, so they fall back to the baseline; the rest is kept.
    expect(generated[0]?.jit?.beta).toBe(baseline.jit?.beta);
    expect(generated[0]?.jit?.lambda).toBe(baseline.jit?.lambda);
    expect(generated[0]?.jit?.alpha).toBe(4);
    expect(generated[0]?.jit?.k).toBe(3);
    expect(generated[0]?.metadata?.jitSource).toBe('baseline');
    expect(generated[0]?.metadata?.jitDiagnostics).toEqual(
      expect.arrayContaining([
        expect.stringContaining('jit.beta'),
        expect.stringContaining('jit.lambda')
      ])
    );
    expect(jitHyperparamIssues(generated[0]?.jit)).toEqual([]);
  });

  it('keeps the baseline jit when the model omits the field', async () => {
    const baseline = policy();
    const adapter: IModelAdapter = {
      complete: async () => ({ text: '[{"maxWidth": 3, "maxDepth": 1}]' })
    };
    const generator = createModelPolicyGenerator(adapter, { now: () => 21 });
    const generated = await generator(baseline, 3, dreamRequest());
    expect(generated[0]?.jit).toEqual(baseline.jit);
    expect(generated[0]?.metadata?.jitSource).toBe('baseline');
  });
});

// ---------------------------------------------------------------------------
// 3. Causal truncation (plan section 7.3-2)
// ---------------------------------------------------------------------------

describe('causal experience truncation', () => {
  it('uses the tree creation time as the inclusive cutoff', () => {
    expect(causalCutoffFor(acceptanceTree())).toBe(900);
    expect(
      causalExperienceSnapshot(
        [
          makeExperience('past', 800),
          makeExperience('boundary', 900),
          makeExperience('future', 901)
        ],
        900
      ).map((record) => record.id)
    ).toEqual(['past', 'boundary']);
  });

  it('drops non-finite timestamps, preserves order and copies the selection', () => {
    const first = makeExperience('first', 900);
    const second = makeExperience('second', 700);
    const snapshot = [first, makeExperience('ghost', Number.NaN), second];
    const selected = causalExperienceSnapshot(snapshot, 900);
    expect(selected.map((record) => record.id)).toEqual(['first', 'second']);
    (selected as ExperienceRecord[]).pop();
    expect(snapshot).toHaveLength(3);
    expect(causalExperienceSnapshot(undefined, 900)).toEqual([]);
  });

  it('never lets a hook observe a record created after the tree', () => {
    const perCall: string[][] = [];
    const hook: JitReplayHook = (input) => {
      perCall.push(input.experiences.map((record) => record.id));
      return {
        slotWeights: input.slotWeights,
        diagnostics: adapterDiagnostics(input, ACCEPTANCE_EVIDENCE, 0, 0)
      };
    };
    const future = makeExperience('future', 1100, { return: 999, reward: 999 });
    const outcome = replayTree(acceptanceTree(), policy(), 1, {
      experiences: [makeExperience('past', 900), future],
      jitHook: hook
    });
    // Two layers are consulted at rho=1, and every call sees the same cut snapshot.
    expect(perCall.length).toBeGreaterThan(0);
    for (const snapshot of perCall) {
      expect(snapshot).toEqual(['past']);
    }
    expect(outcome.jitDiagnostics?.neighborsUsed).toBe(perCall.length);
    expect(JSON.stringify(outcome)).not.toContain('future');
  });

  it('ignores an out-of-window high-return record: the poisoned correction never runs', () => {
    // The tree starts at 900, so nothing created at 1100 may influence it. If the
    // future record were visible, the poison hook below would switch the whole
    // portfolio to exploit and flip the visited branch from X to Y.
    const poison: JitReplayHook = (input) => {
      const leaked = input.experiences.some((record) => record.id === 'future');
      return {
        slotWeights: leaked ? EXPLOIT_ONLY : input.slotWeights,
        diagnostics: adapterDiagnostics(input, ACCEPTANCE_EVIDENCE, 0, 0)
      };
    };
    const future = makeExperience('future', 1100, { return: 999, reward: 999 });
    const withFuture = replayTree(acceptanceTree(), policy(), 1, {
      experiences: [makeExperience('past', 900), future],
      jitHook: poison
    });
    const withoutFuture = replayTree(acceptanceTree(), policy(), 1, {
      experiences: [makeExperience('past', 900)],
      jitHook: poison
    });
    expect(withFuture).toEqual(withoutFuture);
    expect(withFuture.visitedNodeIds).toEqual(['root', 'X', 'X1']);
    expect(withFuture.quality).toBe(0.4);

    // Positive control: applied unconditionally, the same correction does flip the
    // branch, so the equality above is evidence of truncation, not of a dead hook.
    const always: JitReplayHook = (input) => ({
      slotWeights: EXPLOIT_ONLY,
      diagnostics: adapterDiagnostics(input, ACCEPTANCE_EVIDENCE, 0, 0)
    });
    const flipped = replayTree(acceptanceTree(), policy(), 1, { jitHook: always });
    expect(flipped.visitedNodeIds).toEqual(['root', 'Y']);
    expect(flipped.quality).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Hook degradation is field-for-field identical to the pre-hook behaviour
// ---------------------------------------------------------------------------

describe('hook degradation keeps the pre-change replay', () => {
  it('omits the additive diagnostics entirely when no hook is injected', () => {
    const outcome = replayTree(acceptanceTree(), policy(), 1);
    expect(Object.keys(outcome).sort()).toEqual([
      'cost',
      'earlyStopped',
      'evidence',
      'policyId',
      'probes',
      'quality',
      'rho',
      'treeId',
      'visitedNodeIds'
    ]);
    // Fixed fixture pinning the pre-Phase-4 output field for field.
    expect(outcome).toEqual({
      treeId: 'tree-acceptance',
      policyId: 'pi-0',
      rho: 1,
      probes: 2,
      cost: 2,
      quality: 0.4,
      visitedNodeIds: ['root', 'X', 'X1'],
      earlyStopped: false,
      evidence: [
        'rho=1.00 width=1 depth=2 budget=2 candidateProbes=2 visited=3 quality=0.4000',
        'normalizedCost=1.0000'
      ]
    });
    expect('jitDiagnostics' in outcome).toBe(false);
  });

  it('matches the hook-free replay field for field when the hook throws', () => {
    const legacy = replayTree(acceptanceTree(), policy(), 1, {
      experiences: [makeExperience('past', 900)]
    });
    const throwing: JitReplayHook = () => {
      throw new Error('kernel exploded');
    };
    const degraded = replayTree(acceptanceTree(), policy(), 1, {
      experiences: [makeExperience('past', 900)],
      jitHook: throwing
    });
    const { jitDiagnostics, evidence, ...rest } = degraded;
    const { evidence: legacyEvidence, ...legacyRest } = legacy;
    expect(rest).toEqual(legacyRest);
    expect(evidence.slice(0, legacyEvidence.length)).toEqual(legacyEvidence);
    expect(evidence.length).toBeGreaterThan(legacyEvidence.length);
    expect(evidence.join(' ')).toContain('degraded at layer 1');
    expect(evidence.join(' ')).toContain('kernel exploded');
    expect(jitDiagnostics?.degraded).toBe(true);
    expect(jitDiagnostics?.hookCalls).toBe(0);
  });

  it('treats an async (thenable) hook result as a degradation', () => {
    const legacy = replayTree(acceptanceTree(), policy(), 1);
    const thenable = (async (input: JitReplayHookInput) => ({
      slotWeights: input.slotWeights,
      diagnostics: adapterDiagnostics(input, ACCEPTANCE_EVIDENCE, 0, 0)
    })) as unknown as JitReplayHook;
    const degraded = replayTree(acceptanceTree(), policy(), 1, { jitHook: thenable });
    expect(degraded.probes).toBe(legacy.probes);
    expect(degraded.quality).toBe(legacy.quality);
    expect(degraded.visitedNodeIds).toEqual(legacy.visitedNodeIds);
    expect(degraded.earlyStopped).toBe(legacy.earlyStopped);
    expect(degraded.evidence.join(' ')).toContain('thenable');
    expect(degraded.jitDiagnostics?.degraded).toBe(true);
  });

  it('rejects malformed hook weights or missing diagnostics and keeps the prior', () => {
    const legacy = replayTree(acceptanceTree(), policy(), 1);
    const badWeights = (input: JitReplayHookInput) => ({
      slotWeights: { ...input.slotWeights, exploit: Number.NaN },
      diagnostics: adapterDiagnostics(input, ACCEPTANCE_EVIDENCE, 0, 0)
    });
    const forBad = replayTree(acceptanceTree(), policy(), 1, { jitHook: badWeights });
    expect(forBad.visitedNodeIds).toEqual(legacy.visitedNodeIds);
    expect(forBad.quality).toBe(legacy.quality);
    expect(forBad.evidence.join(' ')).toContain('invalid slot weights');
    expect(forBad.jitDiagnostics?.degraded).toBe(true);

    const missing = (() => ({
      slotWeights: EXPLOIT_ONLY
    })) as unknown as JitReplayHook;
    const forMissing = replayTree(acceptanceTree(), policy(), 1, { jitHook: missing });
    expect(forMissing.visitedNodeIds).toEqual(legacy.visitedNodeIds);
    expect(forMissing.evidence.join(' ')).toContain('no diagnostics');
    expect(forMissing.jitDiagnostics?.degraded).toBe(true);

    // A legal 0/1/0/0 vector is honoured, so the rejections above are strictness,
    // not a blanket refusal to let the hook re-order the frontier.
    const exploitOnly: JitReplayHook = (input) => ({
      slotWeights: EXPLOIT_ONLY,
      diagnostics: adapterDiagnostics(input, ACCEPTANCE_EVIDENCE, 0, 0)
    });
    const forLegal = replayTree(acceptanceTree(), policy(), 1, { jitHook: exploitOnly });
    expect(forLegal.jitDiagnostics?.degraded).toBe(false);
    expect(forLegal.visitedNodeIds).toEqual(['root', 'Y']);
  });

  it('falls back for the whole layer, not just the failing node', () => {
    const legacy = replayTree(threeSiblingTree(), policy({ maxWidth: 3, maxDepth: 1 }), 1);
    let calls = 0;
    const flaky: JitReplayHook = (input) => {
      calls += 1;
      if (calls === 2) {
        throw new Error('second node failed');
      }
      return {
        slotWeights: EXPLOIT_ONLY,
        diagnostics: adapterDiagnostics(input, ACCEPTANCE_EVIDENCE, 0, 0)
      };
    };
    const degraded = replayTree(threeSiblingTree(), policy({ maxWidth: 3, maxDepth: 1 }), 1, {
      jitHook: flaky
    });
    expect(degraded.visitedNodeIds).toEqual(legacy.visitedNodeIds);
    expect(degraded.quality).toBe(legacy.quality);
    expect(degraded.jitDiagnostics?.degraded).toBe(true);
    expect(degraded.jitDiagnostics?.hookCalls).toBe(1);
    expect(degraded.evidence.join(' ')).toContain('second node failed');
  });
});

// ---------------------------------------------------------------------------
// 5. Hook plumbing, diagnostics and the beta=2 acceptance fixture
// ---------------------------------------------------------------------------

describe('synchronous replay hook', () => {
  it('is called once per consulted frontier node and reports its diagnostics', () => {
    const experiences = [makeExperience('past-1', 900), makeExperience('past-2', 950)];
    const tree = threeSiblingTree();
    const seen: JitReplayHookInput[] = [];
    const outcome = replayTree(tree, policy({ maxWidth: 3, maxDepth: 1 }), 1, {
      experiences,
      jitHook: adapterHook(ACCEPTANCE_EVIDENCE, seen)
    });
    expect(seen).toHaveLength(3);
    expect(seen.map((input) => input.frontier.nodeId).sort()).toEqual(['a', 'b', 'c']);
    for (const input of seen) {
      expect(input.treeId).toBe('tree-wide');
      expect(input.policyId).toBe('pi-0');
      expect(input.rho).toBe(1);
      expect(input.jit.beta).toBe(1);
      expect(input.driftRho).toBe(0.7);
      expect(input.frontier.depth).toBe(1);
      expect(input.frontier.patchOrigin).toBe('reference');
      expect(input.frontier.guidance).toBe('memory');
    }
    const diagnostics = outcome.jitDiagnostics;
    expect(diagnostics?.hookCalls).toBe(3);
    expect(diagnostics?.neighborsUsed).toBe(6);
    expect(diagnostics?.meanKlToPrior).toBeCloseTo(0.5, 12);
    expect(diagnostics?.meanStateValue).toBeCloseTo(0.25, 12);
    expect(diagnostics?.driftRho).toBe(0.7);
    expect(diagnostics?.causalCutoff).toBe(tree.createdAt);
    expect(diagnostics?.degraded).toBe(false);
    expect(outcome.evidence.join(' ')).toContain('jit replay hook: calls=3');
    expect(outcome.evidence.join(' ')).toContain('causalCutoff=1000');
    expect(diagnostics?.evidence.join(' ')).toContain('meanKl=0.5000');
  });

  it('honours an explicit drift factor and a caller-provided cost ceiling', () => {
    const seen: JitReplayHookInput[] = [];
    const outcome = replayTree(threeSiblingTree(), policy({ maxWidth: 3, maxDepth: 1 }), 1, {
      experiences: [makeExperience('past', 900)],
      driftRho: 0.25,
      costCeiling: 8,
      jitHook: adapterHook(ACCEPTANCE_EVIDENCE, seen)
    });
    expect(seen[0]?.driftRho).toBe(0.25);
    expect(outcome.jitDiagnostics?.driftRho).toBe(0.25);
    expect(outcome.probes).toBe(3);
    expect(outcome.evidence.join(' ')).toContain('driftRho=0.25');
    expect(outcome.evidence.join(' ')).toContain('normalizedCost=0.3750');
  });

  it('supports the cold-start path: no neighbours means the prior is kept', () => {
    const outcome = replayTree(acceptanceTree(), policy({ jit: { ...ACCEPTANCE_JIT, beta: 2 } }), 0, {
      jitHook: adapterHook(ACCEPTANCE_EVIDENCE)
    });
    // rho=0 => width 1, depth 1, so the only frontier is the root's two children.
    expect(outcome.jitDiagnostics?.hookCalls).toBe(2);
    expect(outcome.jitDiagnostics?.neighborsUsed).toBe(0);
    expect(outcome.jitDiagnostics?.meanKlToPrior).toBe(0);
    // beta=2 with no evidence keeps the prior ordering: X stays selected.
    expect(outcome.visitedNodeIds).toEqual(['root', 'X']);
  });

  it('never mutates the caller experience snapshot', () => {
    const experiences = [makeExperience('past', 900)];
    const frozen = JSON.stringify(experiences);
    const mutating = ((input: JitReplayHookInput) => {
      (input.experiences as ExperienceRecord[]).length = 0;
      return {
        slotWeights: input.slotWeights,
        diagnostics: adapterDiagnostics(input, ACCEPTANCE_EVIDENCE, 0, 0)
      };
    }) as JitReplayHook;
    replayTree(threeSiblingTree(), policy({ maxWidth: 3, maxDepth: 1 }), 1, {
      experiences,
      jitHook: mutating
    });
    expect(JSON.stringify(experiences)).toBe(frozen);
  });

  it('forwards the hook through replayPolicy and keeps evaluations bounded', () => {
    const seen: JitReplayHookInput[] = [];
    const run = replayPolicy([acceptanceTree(), threeSiblingTree()], policy(), [0, 1], {
      experiences: [makeExperience('past', 900)],
      jitHook: adapterHook(ACCEPTANCE_EVIDENCE, seen)
    });
    expect(run.treeIds).toEqual(['tree-acceptance', 'tree-wide']);
    for (const bucket of Object.values(run.outcomes)) {
      for (const outcome of bucket) {
        expect(outcome.jitDiagnostics?.hookCalls).toBeGreaterThan(0);
      }
    }
    const evaluation = toPolicyEvaluation(run, run.maxProbes);
    expect(evaluation.hypervolume).toBeGreaterThanOrEqual(0);
    expect(evaluation.hypervolume).toBeLessThanOrEqual(1);
    expect(seen.length).toBeGreaterThan(0);
  });

  it('makes beta=2 the true optimum on the acceptance fixture', () => {
    const tree = acceptanceTree();
    const experiences = [makeExperience('prior-experience', 900)];
    const replay = (beta: number, withHook: boolean): ReturnType<typeof replayTree> =>
      replayTree(tree, policy({ jit: { ...ACCEPTANCE_JIT, beta } }), 1, {
        experiences,
        ...(withHook ? { jitHook: adapterHook(ACCEPTANCE_EVIDENCE) } : {})
      });

    // The beta correction is what flips the frontier from the invariant-strong
    // branch to the high-score domain leaf; only a large enough beta reaches it.
    const weak = replay(0.5, true);
    const medium = replay(1, true);
    const strong = replay(2, true);
    expect(weak.visitedNodeIds).toEqual(['root', 'X', 'X1']);
    expect(medium.visitedNodeIds).toEqual(['root', 'X', 'X1']);
    expect(weak.quality).toBe(0.4);
    expect(medium.quality).toBe(0.4);
    expect(strong.visitedNodeIds).toEqual(['root', 'Y']);
    expect(strong.quality).toBe(1);
    expect(strong.earlyStopped).toBe(true);
    expect(strong.probes).toBe(1);

    // Without the hook the hyperparameter cannot matter at all: beta is inert.
    for (const beta of [0.5, 1, 2]) {
      const inert = replay(beta, false);
      expect(inert.visitedNodeIds).toEqual(['root', 'X', 'X1']);
      expect(inert.quality).toBe(0.4);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Monotone hot-swap of pi and its jit hyperparameters
// ---------------------------------------------------------------------------

describe('dual-loop hot-swap', () => {
  it('reaches beta in [1.5, 2.5] after two dream rounds', async () => {
    const applied: MetaSearchPolicy[] = [];
    const active = createActivePolicy({ policy: policy() });
    const dreamer = createOfflineDreamer({
      now: () => 100,
      jitHook: adapterHook(ACCEPTANCE_EVIDENCE),
      experiences: [makeExperience('prior-experience', 900)],
      applyPolicy: (winner) => {
        applied.push(winner);
        active.update(winner);
      }
    });

    const roundOne = await dreamer.replay(
      dreamRequest({
        candidatePolicies: [
          policy({ id: 'pi-0::dream-1', version: 2, jit: { ...ACCEPTANCE_JIT, beta: 0.5, lambda: 0.02 } }),
          policy({ id: 'pi-0::dream-2', version: 2, jit: { ...ACCEPTANCE_JIT, beta: 1, lambda: 0.05 } }),
          policy({ id: 'pi-0::dream-3', version: 2, jit: { ...ACCEPTANCE_JIT, beta: 2, lambda: 0.1 } })
        ]
      })
    );
    expect(roundOne.improved).toBe(true);
    expect(roundOne.selectedPolicyId).toBe('pi-0::dream-3');
    expect(applied).toHaveLength(1);
    expect(applied[0]?.id).toBe('pi-0::dream-3');
    expect(applied[0]?.jit?.beta).toBe(2);
    expect(applied[0]?.jit?.lambda).toBe(0.1);
    // pi and its hyperparameters travel together.
    expect(applied[0]?.slotWeights).toEqual(TRADE_OFF_WEIGHTS);
    expect(active.policy.jit?.beta).toBe(2);

    const secondBaseline = active.policy;
    expect(secondBaseline.version).toBe(2);
    const roundTwo = await dreamer.replay(
      dreamRequest({
        baselinePolicy: secondBaseline,
        candidatePolicies: [
          policy({ id: 'pi-0::dream-4', version: 3, jit: { ...ACCEPTANCE_JIT, beta: 0.5, lambda: 0.02 } }),
          policy({ id: 'pi-0::dream-5', version: 3, jit: { ...ACCEPTANCE_JIT, beta: 1, lambda: 0.05 } }),
          policy({ id: 'pi-0::dream-6', version: 3, jit: { ...ACCEPTANCE_JIT, beta: 2, lambda: 0.1 } })
        ]
      })
    );
    // The incumbent already holds the optimum: no churn, no non-monotone swap.
    expect(roundTwo.improved).toBe(false);
    expect(roundTwo.selectedPolicyId).toBe(secondBaseline.id);
    expect(roundTwo.best).toEqual(roundTwo.baseline);
    expect(applied).toHaveLength(1);
    const inheritedBeta = active.policy.jit?.beta;
    expect(inheritedBeta).toBe(2);
    expect(inheritedBeta).toBeGreaterThanOrEqual(1.5);
    expect(inheritedBeta).toBeLessThanOrEqual(2.5);
  });

  it('keeps the baseline when no candidate is strictly better', async () => {
    const applyPolicy = vi.fn();
    const dreamer = createOfflineDreamer({
      now: () => 100,
      jitHook: adapterHook(ACCEPTANCE_EVIDENCE),
      experiences: [makeExperience('prior-experience', 900)],
      applyPolicy
    });
    const report = await dreamer.replay(
      dreamRequest({
        baselinePolicy: policy(),
        candidatePolicies: [policy({ id: 'pi-0::dream-same', version: 2 })]
      })
    );
    expect(report.improved).toBe(false);
    expect(report.selectedPolicyId).toBe('pi-0');
    expect(report.best).toEqual(report.baseline);
    expect(applyPolicy).not.toHaveBeenCalled();
  });

  it('filters candidates whose jit record is illegal', async () => {
    const dreamer = createOfflineDreamer({
      now: () => 100,
      jitHook: adapterHook(ACCEPTANCE_EVIDENCE),
      experiences: [makeExperience('prior-experience', 900)]
    });
    const report = await dreamer.replay(
      dreamRequest({
        candidatePolicies: [
          policy({ id: 'pi-0::dream-bad-k', version: 2, jit: { ...ACCEPTANCE_JIT, k: 0 } }),
          policy({ id: 'pi-0::dream-bad-beta', version: 2, jit: { ...ACCEPTANCE_JIT, beta: -1 } }),
          policy({
            id: 'pi-0::dream-ok',
            version: 2,
            jit: { ...ACCEPTANCE_JIT, beta: 2, lambda: 0.1 }
          })
        ]
      })
    );
    expect(report.candidateEvaluations.map((entry) => entry.policyId)).toEqual([
      'pi-0::dream-ok'
    ]);
    expect(report.improved).toBe(true);
    expect(report.selectedPolicyId).toBe('pi-0::dream-ok');
  });

  it('drives candidate generation from the jit grid by default', async () => {
    // The deterministic generator varies width/depth/profile and the swept jit
    // dimensions together, so this test proves the default path perturbs beta/k/
    // similarityThreshold by grid index and leaves the ignored ones alone; the
    // fixed-dimension beta acceptance lives in the section above.
    const generated = generateCandidatePolicies(policy(), 3, { now: () => 100 });
    expect(generated.map((entry) => entry.id)).toEqual([
      'pi-0::dream-1',
      'pi-0::dream-2',
      'pi-0::dream-3'
    ]);
    expect(generated.map((entry) => entry.jit?.beta)).toEqual([0.5, 1, 2]);
    expect(generated.map((entry) => entry.jit?.k)).toEqual([5, 10, 20]);
    expect(generated.map((entry) => entry.jit?.similarityThreshold)).toEqual([0.2, 0.3, 0.5]);
    // Not one candidate was ranked by the ignored dimensions.
    for (const entry of generated) {
      expect(entry.jit?.lambda).toBe(policy().jit?.lambda);
      expect(entry.jit?.alpha).toBe(policy().jit?.alpha);
      expect(entry.jit?.gamma).toBe(policy().jit?.gamma);
    }

    const dreamer = createOfflineDreamer({
      now: () => 100,
      jitHook: adapterHook(ACCEPTANCE_EVIDENCE),
      experiences: [makeExperience('prior-experience', 900)],
      policyCount: 3
    });
    const report = await dreamer.replay(dreamRequest({ candidatePolicies: [] }));
    expect(report.candidateEvaluations).toHaveLength(3);
    expect(report.candidateEvaluations.map((entry) => entry.policyId)).toEqual(
      generated.map((entry) => entry.id)
    );
    expect(report.improved).toBe(true);
    const winner = generated.find((entry) => entry.id === report.selectedPolicyId);
    expect(winner).toBeDefined();
    // The winner's hyperparameters are a point of the perturbed grid, not the baseline.
    expect([0.5, 1, 2]).toContain(winner?.jit?.beta);
    // The report restates which dimensions were not searched, so a reader does
    // not have to infer it from the grid.
    const withShadow = report as unknown as { readonly ignoredDimensions?: readonly { readonly dimension: string }[] };
    expect((withShadow.ignoredDimensions ?? []).map((entry) => entry.dimension)).toEqual(
      JIT_IGNORED_DIMENSIONS.map((entry) => entry.dimension)
    );
  });
});
