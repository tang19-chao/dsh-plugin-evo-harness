/**
 * P2-D: L1 mechanism diagnosis on a discriminating synthetic fixture.
 *
 * Protocol: docs/reports/p2-l1-mechanism.md (P2-L1-MECHANISM-20261029).
 * Fixture:  tests/fixtures/p2-l1/p2-l1-mechanism-cells.json.
 *
 * WHY THIS EXISTS (P2-D acceptance): the historical five-arm report attributed
 * the zero-deviation state of the quality-track arms to "reward saturation".
 * That attribution is not measurable from KL alone, because TWO structurally
 * different mechanisms both force klToPrior === 0 through the production
 * kernel:
 *
 *   M-support  single-action support collapse: all evidence sits on one action
 *              key, so the group mean IS the state mean (q === V bitwise) and
 *              every advantage is exactly 0 - even when the returns are
 *              heterogeneous (NOT saturated);
 *   M-saturate saturated returns: per-action means coincide with V because the
 *              observed rewards are identical.
 *
 * The fixture therefore holds four cells and asserts the mechanism through the
 * PRODUCTION path (runDecisionKernel: filter -> retrieve -> project ->
 * estimate -> compose). Every assertion is deterministic: no clock, no
 * randomness (lambda is pinned to 0 and the injectable rng is a constant), no
 * I/O beyond reading this fixture.
 *
 * BOUNDARY (must not be crossed by a reader of this file): these cells prove
 * the mechanism on the FIXTURE side only. Whether the production L1 path is in
 * which cell is a measurement question (P2-C pre-registers the ledger fields
 * needed to answer it); this file must never be cited as that measurement.
 */
import { describe, expect, it } from 'vitest';

import fixture from '../../fixtures/p2-l1/p2-l1-mechanism-cells.json';
import {
  abstractMetaState,
  type JitReferenceStatus
} from '../../../src/jitrl/state-abstraction';
import {
  learningFacingFilterOptions,
  runDecisionKernel,
  type LayerDecisionConfig
} from '../../../src/jitrl/decision-kernel';
import { conservativeAdvantage } from '../../../src/jitrl/value-estimator';
import {
  CURRENT_REWARD_VERSION,
  EXPERIENCE_SCHEMA_VERSION
} from '../../../src/jitrl/experience-store';
import type {
  BatchSlotKind,
  ExperienceRecord,
  JitCandidate,
  JitDecision,
  ProbeTask
} from '../../../src/types/contracts';

const T0 = 1_700_000_000_000;
const RNG_NEVER_USED_DRAW = 0.999;

interface CellRecord {
  readonly actionKey: string;
  readonly return: number;
}

interface CellExpected {
  readonly neighborCount: number;
  readonly supportRank: number;
  readonly supportedActionKeys: readonly string[];
  readonly stateValue: number;
  readonly allAdvantagesZero: boolean;
  readonly klToPrior: number;
  readonly chosenActionKey: string;
}

interface FixtureCell {
  readonly id: string;
  readonly hypothesis: string;
  readonly records: readonly CellRecord[];
  readonly expected: CellExpected;
}

const cells = fixture.cells as readonly FixtureCell[];

/**
 * Narrow a fixture string to the contract's literal union, failing closed on an
 * unknown value. A blind cast (or 'as any') would let a typo in the fixture
 * silently change the abstract state - and therefore the mechanism under test -
 * without any compile-time or runtime signal.
 */
const TASK_COMPLEXITIES = ['trivial', 'simple', 'moderate', 'complex', 'unknown'] as const;
const REFERENCE_STATUSES = ['succeeded', 'failed', 'timeout', 'aborted', 'missing'] as const;

function asTaskComplexity(value: string): NonNullable<ProbeTask['complexity']> {
  const found = TASK_COMPLEXITIES.find((entry) => entry === value);
  if (found === undefined) {
    throw new Error('p2-l1 fixture: unknown complexity ' + JSON.stringify(value));
  }
  return found;
}

function asReferenceStatus(value: string): JitReferenceStatus {
  const found = REFERENCE_STATUSES.find((entry) => entry === value);
  if (found === undefined) {
    throw new Error('p2-l1 fixture: unknown referenceStatus ' + JSON.stringify(value));
  }
  return found;
}

function metaState() {
  const input = fixture.decision.stateInput;
  const task: ProbeTask = {
    id: input.task.id,
    prompt: input.task.prompt,
    taskSignature: input.task.taskSignature,
    complexity: asTaskComplexity(input.task.complexity),
    contextTags: [...input.task.contextTags]
  };
  return abstractMetaState({
    task,
    round: input.round,
    parentDepth: input.parentDepth,
    memoryConfidence: input.memoryConfidence,
    referenceStatus: asReferenceStatus(input.referenceStatus)
  });
}

function kernelConfig(overrides: Partial<LayerDecisionConfig> = {}): LayerDecisionConfig {
  return {
    beta: fixture.decision.kernelConfig.beta,
    k: fixture.decision.kernelConfig.k,
    similarityThreshold: fixture.decision.kernelConfig.similarityThreshold,
    selection: fixture.decision.kernelConfig.selection as 'argmax' | 'sample',
    lambda: fixture.decision.kernelConfig.lambda,
    alpha: fixture.decision.kernelConfig.alpha,
    unseenFallback: fixture.decision.kernelConfig.unseenFallback as 'zero' | 'baseline',
    halfLifeMs: fixture.decision.kernelConfig.halfLifeMs,
    ...overrides
  };
}

function candidates(): readonly JitCandidate<BatchSlotKind>[] {
  return fixture.decision.candidates.map((candidate) => ({
    actionKey: candidate.actionKey,
    baseLogit: candidate.baseLogit,
    source: 'policy_prior' as const,
    payload: candidate.payload as BatchSlotKind
  }));
}

function recordsFor(cell: FixtureCell): readonly ExperienceRecord[] {
  const state = metaState();
  return cell.records.map((entry, index) => ({
    id: 'p2l1-' + cell.id + '-' + String(index),
    level: 'meta' as const,
    state,
    actionKey: entry.actionKey,
    reward: entry.return,
    return: entry.return,
    rewardSources: { surrogate: entry.return },
    guidance: 'memory' as const,
    policyId: 'pi-p2l1',
    sessionId: 'session-p2l1',
    treeId: 'tree-p2l1',
    nodeId: 'n-' + String(index),
    createdAt: T0,
    redacted: true,
    experienceSchemaVersion: EXPERIENCE_SCHEMA_VERSION,
    rewardVersion: CURRENT_REWARD_VERSION,
    learningEligible: true
  }));
}

/** Run the production kernel on one cell with a constant injectable rng. */
function runCell(
  cell: FixtureCell,
  draw: number = RNG_NEVER_USED_DRAW,
  beta: number = fixture.decision.kernelConfig.beta
): ReturnType<typeof runDecisionKernel<BatchSlotKind>> {
  return runDecisionKernel<BatchSlotKind>({
    level: 'meta',
    state: metaState(),
    candidates: candidates(),
    records: recordsFor(cell),
    config: kernelConfig({ beta }),
    projectNeighbors: undefined,
    // Production L1 wraps decisions in learningFacingFilterOptions() (P2-B);
    // the fixture must reproduce the mechanism UNDER that filter, not around it.
    ...learningFacingFilterOptions(),
    seed: 20261029,
    rng: () => draw
  });
}

/** Distinct action keys among neighbours that carry their own Q (support rank). */
function supportRankOf(decision: JitDecision<BatchSlotKind>): number {
  const supported = decision.adjustments.filter((entry) => entry.support > 0);
  return new Set(supported.map((entry) => entry.candidate.actionKey)).size;
}

/** Between-group return variance of the retrieved neighbours (fixture doc). */
function betweenGroupVariance(neighbors: readonly { record: ExperienceRecord }[]): number {
  if (neighbors.length === 0) return 0;
  const groups = new Map<string, number[]>();
  for (const neighbor of neighbors) {
    const list = groups.get(neighbor.record.actionKey) ?? [];
    list.push(neighbor.record.return);
    groups.set(neighbor.record.actionKey, list);
  }
  const all = neighbors.map((neighbor) => neighbor.record.return);
  const mean = all.reduce((sum, value) => sum + value, 0) / all.length;
  let variance = 0;
  for (const values of groups.values()) {
    const groupMean = values.reduce((sum, value) => sum + value, 0) / values.length;
    variance += (values.length / all.length) * (groupMean - mean) ** 2;
  }
  return variance;
}

describe('P2-D L1 mechanism: the production kernel on the discriminating fixture', () => {
  it('pins the fixture so the cells cannot drift silently', () => {
    expect(fixture.fixtureVersion).toBe('p2-l1-mechanism-v1');
    expect(cells.map((cell) => cell.id)).toEqual([
      'cold-start-no-evidence',
      'single-action-support-heterogeneous-returns',
      'multi-action-support-saturated-returns',
      'multi-action-support-heterogeneous-returns'
    ]);
  });

  it.each(cells.map((cell) => [cell.id, cell] as const))(
    'cell %s: reproduces its pre-registered mechanism expectations',
    (_id, cell) => {
      const result = runCell(cell);
      const decision = result.decision;

      expect(result.neighbors).toHaveLength(cell.expected.neighborCount);
      expect(decision.neighborCount).toBe(cell.expected.neighborCount);
      expect(decision.stateValue).toBeCloseTo(cell.expected.stateValue, 12);
      expect(supportRankOf(decision)).toBe(cell.expected.supportRank);
      expect(decision.chosen.candidate.actionKey).toBe(cell.expected.chosenActionKey);

      const advantages = decision.adjustments.map((entry) => entry.advantage);
      if (cell.expected.allAdvantagesZero) {
        for (const advantage of advantages) {
          expect(advantage).toBe(0);
        }
      } else {
        expect(advantages.some((advantage) => advantage !== 0)).toBe(true);
      }
      expect(decision.klToPrior).toBeCloseTo(cell.expected.klToPrior, 9);
    }
  );

  it('single-action support: q === V bitwise for the supported action (the P2-D core identity)', () => {
    const cell = cells[1]!;
    const decision = runCell(cell).decision;
    const supported = decision.adjustments.filter((entry) => entry.support > 0);
    expect(supported).toHaveLength(1);
    for (const entry of supported) {
      expect(entry.q).not.toBeNull();
      expect(entry.q).toBe(decision.stateValue);
    }
    // Returns are heterogeneous inside the group, so the identity is structural,
    // not a saturation artefact.
    const returns = new Set(cell.records.map((entry) => entry.return));
    expect(returns.size).toBeGreaterThan(1);
    // The policy cannot move at all.
    expect(decision.klToPrior).toBe(0);
    for (const entry of decision.adjustments) {
      expect(entry.normalizedAdvantage).toBe(0);
      expect(entry.adjustedLogit).toBe(entry.candidate.baseLogit);
      expect(entry.probability).toBe(0.25);
    }
  });

  it('multi-action support with heterogeneous returns recovers KL > 0 through the same production path', () => {
    const cell = cells[3]!;
    const decision = runCell(cell).decision;
    expect(decision.klToPrior).toBeGreaterThan(0);
    const supported = decision.adjustments.filter((entry) => entry.support > 0);
    expect(supported).toHaveLength(2);
    // The unsupported actions still fall back to Q = V (baseline): their
    // advantage is exactly the structural zero.
    const unsupported = decision.adjustments.filter((entry) => entry.support === 0);
    for (const entry of unsupported) {
      expect(entry.q).toBeNull();
      expect(entry.advantage).toBe(0);
    }
  });

  it('KL alone cannot discriminate the two zero cells; (supportRank, between-group variance) can', () => {
    const single = runCell(cells[1]!);
    const saturated = runCell(cells[2]!);
    const heterogeneous = runCell(cells[3]!);

    expect(single.decision.klToPrior).toBe(0);
    expect(saturated.decision.klToPrior).toBe(0);

    const observable = (result: ReturnType<typeof runDecisionKernel<BatchSlotKind>>) => ({
      supportRank: supportRankOf(result.decision),
      varianceZero: betweenGroupVariance(result.neighbors) === 0
    });
    const singleObs = observable(single);
    const saturatedObs = observable(saturated);
    const heteroObs = observable(heterogeneous);

    // Same KL, different mechanism signatures.
    expect(singleObs).toEqual({ supportRank: 1, varianceZero: true });
    expect(saturatedObs).toEqual({ supportRank: 2, varianceZero: true });
    expect(heteroObs).toEqual({ supportRank: 2, varianceZero: false });
    expect(JSON.stringify(singleObs)).not.toBe(JSON.stringify(saturatedObs));
  });

  it('recoverability is parametric: KL(beta) === 0 at beta = 0 and strictly increases with beta', () => {
    const cell = cells[3]!;
    const betas = fixture.betaSweep.betas;
    const kls = betas.map((beta) => runCell(cell, RNG_NEVER_USED_DRAW, beta).decision.klToPrior);
    expect(betas[0]).toBe(0);
    expect(kls[0]).toBe(0);
    for (let index = 1; index < betas.length; index += 1) {
      expect(kls[index]!).toBeGreaterThan(kls[index - 1]!);
    }
  });

  it('the kernel KL reproduces an independent closed-form recomputation from q and V', () => {
    // Cross-check that does NOT read klToPrior from the kernel: recompute the
    // closed-form correction from the returned q/V exactly as the kernel's own
    // contract states it (A-tilde = A / (max|A| + 1e-6), z' = center(z) +
    // beta * A-tilde, uniform prior). Pinning the fixture constant alone could
    // hide a joint drift of fixture and kernel; this cannot.
    const cell = cells[3]!;
    const decision = runCell(cell).decision;
    const advantages = decision.adjustments.map((entry) => entry.advantage);
    const maxAbs = Math.max(...advantages.map((value) => Math.abs(value)));
    const denominator = maxAbs + 1e-6;
    const baseLogits = decision.adjustments.map((entry) => entry.candidate.baseLogit);
    const centered = baseLogits.map((value) => value - baseLogits.reduce((sum, v) => sum + v, 0) / baseLogits.length);
    const adjusted = centered.map(
      (value, index) => value + fixture.decision.kernelConfig.beta * (advantages[index]! / denominator)
    );
    const max = Math.max(...adjusted);
    const exponentials = adjusted.map((value) => Math.exp(value - max));
    const total = exponentials.reduce((sum, value) => sum + value, 0);
    const probabilities = exponentials.map((value) => value / total);
    let kl = 0;
    for (const probability of probabilities) {
      if (probability > 0) {
        kl += probability * Math.log(probability / 0.25);
      }
    }
    expect(kl).toBeCloseTo(decision.klToPrior, 12);
    expect(kl).toBeCloseTo(cell.expected.klToPrior, 12);
  });

  it('is deterministic: two runs with different injectable rng constants agree bitwise', () => {
    for (const cell of cells) {
      const a = runCell(cell, 0);
      const b = runCell(cell, RNG_NEVER_USED_DRAW);
      const key = (result: ReturnType<typeof runDecisionKernel<BatchSlotKind>>) =>
        JSON.stringify({
          stateValue: result.decision.stateValue,
          kl: result.decision.klToPrior,
          chosen: result.decision.chosen.candidate.actionKey,
          adjustments: result.decision.adjustments.map((entry) => ({
            key: entry.candidate.actionKey,
            q: entry.q,
            a: entry.advantage,
            n: entry.normalizedAdvantage,
            z: entry.adjustedLogit,
            p: entry.probability,
            s: entry.support
          }))
        });
      expect(key(a)).toBe(key(b));
    }
  });

  it('the conservative evidence gate is orthogonal to the structural zero (why gate-on arms can still not deviate)', () => {
    const single = runCell(cells[1]!).decision;
    const supported = single.adjustments.find((entry) => entry.support > 0)!;
    const judgement = conservativeAdvantage({
      actionKey: supported.candidate.actionKey,
      q: supported.q,
      support: supported.support,
      nEff: supported.nEff,
      explored: supported.explored,
      advantage: supported.advantage
    });
    // Evidence EXISTS (nEff = 3 >= 2), yet the advantage is structurally 0:
    // hasReplacementEvidence is true while the shrunk advantage stays 0, so a
    // gate-on arm can still end up keeping the prior. The n_eff floor cannot
    // detect support collapse; only the (supportRank, variance) observables can.
    expect(judgement.hasReplacementEvidence).toBe(true);
    expect(judgement.shrunkAdvantage).toBe(0);
    expect(judgement.support).toBe(3);

    // Cold start: the unsupported fallback artefact is flagged.
    const cold = runCell(cells[0]!).decision;
    const fallback = conservativeAdvantage({
      actionKey: cold.adjustments[0]!.candidate.actionKey,
      q: cold.adjustments[0]!.q,
      support: cold.adjustments[0]!.support,
      nEff: cold.adjustments[0]!.nEff,
      explored: cold.adjustments[0]!.explored,
      advantage: cold.adjustments[0]!.advantage
    });
    expect(fallback.implicitZeroAdvantage).toBe(true);
    expect(fallback.hasReplacementEvidence).toBe(false);
    expect(fallback.shrunkAdvantage).toBe(0);
  });
});
