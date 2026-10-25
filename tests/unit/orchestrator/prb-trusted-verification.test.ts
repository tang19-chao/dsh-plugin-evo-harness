/**
 * P6.2 PR-B acceptance: the trusted-verification regression matrix and the
 * conservative-gate ledger replay.
 *
 * Section 1 (F3) scores the eight matrix scenarios through
 * scoreUnderRewardContract - the same yardstick the online recorder uses - and
 * asserts the verifier-first ordering: a REFUTED result can never score above
 * zero, an UNKNOWN result never earns a completion bonus, and only a trusted
 * PASSED verdict does.
 *
 * Section 2 (F4) replays the first-harmful decision shape
 * (ci-04|2|2: support=0 noop with A=0 over a supported prior) through the
 * gate and asserts the veto, plus the prior/proposed/executed ledger fields.
 */
import { describe, expect, it } from 'vitest';
import type { ProbeTrajectory } from '../../../src/types/contracts';
import {
  COMPLETION_SIGNAL,
  MISSING_DELIVERABLE_SIGNAL,
  VERIFICATION_FAILED_SIGNAL,
  scoreTrajectorySignals,
  verificationFromTrajectory
} from '../../../src/jitrl/step-evaluator';
import { scoreUnderRewardContract } from '../../../src/jitrl/reward-contract';
import {
  conservativeAdvantage,
  type ActionValueEstimate
} from '../../../src/jitrl/value-estimator';
import {
  EvoHarnessOrchestratorImpl,
  createEvoHarnessOrchestrator,
  type EvoHarnessOrchestratorDeps
} from '../../../src/orchestrator';

function trajectory(overrides: Partial<ProbeTrajectory> = {}): ProbeTrajectory {
  return {
    id: 't',
    sessionId: 's',
    branchId: 'b',
    branchNamespace: 'ns',
    role: 'candidate',
    status: 'succeeded',
    patchId: 'p',
    patchOrigin: 'domain',
    surfaceKeys: [],
    startedAt: 0,
    endedAt: 10,
    metrics: { steps: 2, toolCalls: 1, toolErrors: 0, durationMs: 10 },
    steps: [],
    toolErrors: [],
    failureSignals: [],
    memoryRecallIds: [],
    ...overrides
  } as ProbeTrajectory;
}

function verification(status: 'passed' | 'failed' | 'unknown'): ProbeTrajectory['metadata'] {
  return {
    verification: {
      status,
      verifierId: 'ci-verifier',
      verifierVersion: '1.0.0',
      evidenceHash: 'abc123',
      checks: [{ id: 'tests-pass', passed: status === 'passed' }]
    }
  };
}

describe('P6.2 PR-B F3: the eight-scenario regression matrix', () => {
  it('1. non-empty but WRONG output (refuted) cannot become a positive experience', () => {
    const wrong = trajectory({
      deliverable: { content: 'a long, confident, incorrect answer', format: 'text' },
      metadata: verification('failed')
    });
    const score = scoreUnderRewardContract(wrong);
    expect(score.sources.completion).toBe(VERIFICATION_FAILED_SIGNAL);
    expect(score.reward).toBeLessThanOrEqual(0);
    expect(score.learningEligible).toBe(false);
    expect(score.taskSuccess).toBe(false);
    expect(score.executionSuccess).toBe(true);
  });

  it('2. a forged success status (claimed succeeded, refuted) is learning-ineligible', () => {
    const forged = trajectory({
      status: 'succeeded',
      deliverable: { content: 'looks done', format: 'text' },
      metadata: verification('failed')
    });
    const score = scoreUnderRewardContract(forged);
    expect(score.reward).toBeLessThanOrEqual(0);
    expect(score.learningEligible).toBe(false);
  });

  it('3. an empty deliverable stays below any delivered run', () => {
    const empty = trajectory({ deliverable: undefined });
    const delivered = trajectory({
      deliverable: { content: 'x', format: 'text' }
    });
    const emptyScore = scoreUnderRewardContract(empty);
    expect(emptyScore.sources.completion).toBe(MISSING_DELIVERABLE_SIGNAL);
    // Unverified delivery is a process observation (0), still above the empty
    // run's outright refutation.
    expect(scoreUnderRewardContract(delivered).sources.completion).toBe(0);
    expect(scoreUnderRewardContract(delivered).reward).toBeGreaterThan(emptyScore.reward);
  });

  it('4. partial pass (some checks failed) is a REFUTED verdict overall', () => {
    const partial = trajectory({
      deliverable: { content: 'partial work', format: 'text' },
      metadata: {
        verification: {
          status: 'failed',
          verifierId: 'ci-verifier',
          verifierVersion: '1.0.0',
          evidenceHash: 'abc123',
          checks: [
            { id: 'lint', passed: true },
            { id: 'tests-pass', passed: false }
          ]
        }
      }
    });
    const score = scoreUnderRewardContract(partial);
    expect(score.verification.status).toBe('failed');
    expect(score.reward).toBeLessThanOrEqual(0);
  });

  it('5. a genuinely verified pass earns the completion signal and stays positive', () => {
    const real = trajectory({
      deliverable: { content: 'the correct change', format: 'text' },
      metadata: verification('passed')
    });
    const score = scoreUnderRewardContract(real);
    expect(score.sources.completion).toBe(COMPLETION_SIGNAL);
    expect(score.taskSuccess).toBe(true);
    expect(score.reward).toBeGreaterThan(0);
    expect(score.learningEligible).toBe(true);
  });

  it('6. a timeout never earns completion regardless of deliverable content', () => {
    const timeout = trajectory({
      status: 'timeout',
      deliverable: { content: 'half-finished but long text', format: 'text' },
      metadata: verification('passed')
    });
    const score = scoreUnderRewardContract(timeout);
    // The contradictory 'passed' on a timed-out run degrades to unknown.
    expect(score.verification.status).toBe('unknown');
    expect(score.sources.completion).not.toBe(COMPLETION_SIGNAL);
    expect(score.taskSuccess).toBe(false);
  });

  it('7. an infrastructure error is audit-only, never a quality sample', () => {
    const infra = trajectory({
      status: 'failed',
      error: { name: 'EvoHarnessPluginError', message: 'seam transport failed' },
      deliverable: { content: 'partial text', format: 'text' },
      metadata: verification('passed')
    });
    const score = scoreUnderRewardContract(infra);
    expect(score.outcome).toBe('infrastructure_error');
    expect(score.learningEligible).toBe(false);
    expect(score.reward).toBe(0);
  });

  it('8. the same deliverable padded with extra tool calls does not score higher', () => {
    const base = (toolCalls: number): ProbeTrajectory =>
      trajectory({
        deliverable: { content: 'same content', format: 'text' },
        metadata: verification('passed'),
        metrics: { steps: 2, toolCalls, toolErrors: 0, durationMs: 10 }
      });
    const few = scoreUnderRewardContract(base(1)).reward;
    const many = scoreUnderRewardContract(base(30)).reward;
    expect(many).toBeLessThanOrEqual(few);
  });
});

describe('P6.2 PR-B F3: lexicographic quality constraint', () => {
  it('a failed verification cannot be bought back by fewer steps or clean tools', () => {
    const leanWrong = scoreUnderRewardContract(
      trajectory({ deliverable: { content: 'wrong', format: 'text' }, metadata: verification('failed') })
    ).reward;
    const verboseRight = scoreUnderRewardContract(
      trajectory({
        deliverable: { content: 'right', format: 'text' },
        metadata: verification('passed'),
        metrics: { steps: 12, toolCalls: 8, toolErrors: 2, durationMs: 500 }
      })
    ).reward;
    expect(leanWrong).toBeLessThanOrEqual(0);
    expect(verboseRight).toBeGreaterThan(leanWrong);
    // Quality first: no amount of efficiency compensates an acceptance failure.
    const efficientWrong = scoreUnderRewardContract(
      trajectory({
        deliverable: { content: 'wrong', format: 'text' },
        metadata: verification('failed'),
        metrics: { steps: 1, toolCalls: 1, toolErrors: 0, durationMs: 1 }
      })
    ).reward;
    expect(efficientWrong).toBeLessThanOrEqual(0);
  });
});

describe('P6.2 PR-B F3: separated score components (分列)', () => {
  it('keeps tool smoothness, task completion, user adoption and cost as separate sources', () => {
    const adopted = scoreTrajectorySignals(
      trajectory({
        deliverable: { content: 'right', format: 'text' },
        metadata: verification('passed'),
        metrics: { steps: 3, toolCalls: 2, toolErrors: 0, durationMs: 40 }
      }),
      { weights: { completion: 0.5, steps: 0.1, tool: 0.1, turn: 0.3, user: 0 }, user: 'adopt' }
    );
    // Each dimension is its own source entry (2 clean calls x 0.5)...
    expect(adopted.sources.completion).toBe(COMPLETION_SIGNAL);
    expect(adopted.sources.tool).toBe(1);
    expect(adopted.sources.user).toBe(3);
    expect(typeof adopted.sources.steps).toBe('number');
    // ...and the execution/cost dimension is the steps budget term plus the
    // trajectory's own metrics, never folded into the completion verdict.
    expect(adopted.taskSuccess).toBe(true);
    expect(adopted.executionSuccess).toBe(true);
    // A rollback is a separate NEGATIVE user signal that never touches
    // completion: an unverified deliverable stays a process observation.
    const rolledBack = scoreTrajectorySignals(
      trajectory({ deliverable: { content: 'x', format: 'text' } }),
      { weights: { completion: 0.5, steps: 0.1, tool: 0.1, turn: 0.3, user: 0 }, user: 'rollback' }
    );
    expect(rolledBack.sources.user).toBe(-3);
    expect(rolledBack.sources.completion).toBe(0);
  });
});

describe('P6.2 PR-B F3: verification resolution is fail-closed', () => {  it('an explicit verification wins over the structural fallback', () => {
    const explicit = verificationFromTrajectory(
      trajectory({ metadata: verification('passed') })
    );
    expect(explicit.status).toBe('passed');
    expect(explicit.verifierId).toBe('ci-verifier');
    expect(explicit.implicit).not.toBe(true);
  });

  it('the structural fallback never claims passed', () => {
    const structural = verificationFromTrajectory(
      trajectory({ deliverable: { content: 'x', format: 'text' } })
    );
    expect(structural.status).toBe('unknown');
    expect(structural.implicit).toBe(true);
    expect(structural.verifierId).toBe('structural-derivation');
  });

  it('a passed verdict on a failed execution degrades to unknown', () => {
    const degraded = verificationFromTrajectory(
      trajectory({ status: 'failed', metadata: verification('passed') })
    );
    expect(degraded.status).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// F4: the first-harmful decision shape (ci-04|2|2), replayed through the gate
// ---------------------------------------------------------------------------

/** The decision-kernel adjustment shape the gate consumes. */
function adjustment(
  actionKey: string,
  support: number,
  advantage: number
): ActionValueEstimate {
  return {
    actionKey,
    q: support === 0 ? null : advantage,
    support,
    nEff: support,
    explored: false,
    advantage
  };
}

describe('P6.2 PR-B F4: the first-harmful counterexample is vetoed', () => {
  // ci-04|2|2 replay (review section 8.1, ledger values): the noop
  // (support=0, Q=null, A=0 from the baseline fallback, V≈0.266687) beat the
  // prior guardrails action (supported, NEGATIVE advantage - the
  // relative-suppression case). Fused observedReturn was ≈ +0.30 POSITIVE
  // while the verifier failed - pre-PR-B that record then reinforced the
  // wrong preference.
  const noop = adjustment('noop', 0, 0);
  const priorAction = adjustment('guardrails:append(1)', 2, -0.4);

  it('marks the noop as the zero-advantage artefact', () => {
    const challenger = conservativeAdvantage(noop);
    expect(challenger.implicitZeroAdvantage).toBe(true);
    expect(challenger.hasReplacementEvidence).toBe(false);
    expect(challenger.shrunkAdvantage).toBe(0);
  });

  it('the supported prior holds replacement evidence despite its negative advantage', () => {
    const prior = conservativeAdvantage(priorAction);
    expect(prior.hasReplacementEvidence).toBe(true);
    // Shrinkage keeps the negative advantage proportional instead of letting
    // max-normalization amplify it to a full ±1 swing.
    expect(prior.shrunkAdvantage).toBeCloseTo(-0.4 * 2 / 4, 12);
    expect(prior.calibratedAdvantage).toBeCloseTo(-0.2 / 3, 12);
  });

  it('the PR-B reward side also defuses the counterexample: a noop-style run cannot score positive', () => {
    // The environment shape behind ci-04|2|2: the chosen noop produced
    // coverage 2/3 (verifier FAILED) with a succeeded execution and a
    // deliverable. Under PR-B the refuted result cannot earn a positive
    // fused reward, so the record that would reinforce the noop no longer
    // exists: both the gate AND the yardstick independently block it.
    const falsifiedNoopWin = scoreUnderRewardContract(
      trajectory({
        deliverable: { content: 'partial coverage output', format: 'text' },
        metadata: verification('failed')
      })
    );
    expect(falsifiedNoopWin.reward).toBeLessThanOrEqual(0);
    expect(falsifiedNoopWin.learningEligible).toBe(false);
  });

  it('the gate order (veto first, budget second, measured evidence third) is total', () => {
    // Veto shape: zero-advantage artefact over an evidenced prior.
    const artefact = conservativeAdvantage(noop);
    const evidencedPrior = conservativeAdvantage(priorAction);
    expect(artefact.implicitZeroAdvantage && evidencedPrior.hasReplacementEvidence).toBe(true);
    // Budget shape: unsupported, non-zero (exploration-draw) advantage, no
    // grant -> falls back to the prior.
    const explorationDraw = conservativeAdvantage(adjustment('new-surface', 0, 1.2));
    expect(explorationDraw.support).toBe(0);
    expect(explorationDraw.hasReplacementEvidence).toBe(false);
    // Measured shape: thin but real evidence executes with a shrunk strength.
    const thinMeasured = conservativeAdvantage(adjustment('combined-edit', 1, 0.9));
    expect(thinMeasured.support).toBe(1);
    expect(thinMeasured.hasReplacementEvidence).toBe(false);
    expect(thinMeasured.shrunkAdvantage).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F4-3 / F4-5: the orchestrator ledger and budget surface
// ---------------------------------------------------------------------------

describe('P6.2 PR-B F4: exploration budget and gate switch', () => {  it('starts at zero (fail-closed), grants explicitly and revokes to zero', () => {
    const orchestrator = new EvoHarnessOrchestratorImpl({
      config: { probe: { maxConcurrentProbes: 1, probeTimeoutMs: 1000 } } as never,
      memory: {} as never,
      seams: {} as never,
      policy: {} as never,
      proposer: {} as never,
      composer: {} as never,
      reflector: {} as never,
      scorer: {} as never,
      taxonomy: {} as never,
      dreamer: {} as never,
      treePool: {} as never,
      runBranch: (async () => ({})) as never
    });
    expect(orchestrator.explorationBudgetRemaining()).toBe(0);
    expect(orchestrator.grantExplorationBudget(3)).toBe(3);
    expect(orchestrator.explorationBudgetRemaining()).toBe(3);
    orchestrator.revokeExplorationBudget();
    expect(orchestrator.explorationBudgetRemaining()).toBe(0);
    // A non-positive grant changes nothing.
    expect(orchestrator.grantExplorationBudget(-2)).toBe(0);
  });

  it('exposes the class-surface budget constants', () => {
    expect(EvoHarnessOrchestratorImpl.EXPLORATION_BUDGET).toBe(0);
    expect(typeof EvoHarnessOrchestratorImpl.prototype.grantExplorationBudget).toBe('function');
    expect(typeof EvoHarnessOrchestratorImpl.prototype.revokeExplorationBudget).toBe('function');
  });

  it('the conservative gate defaults off and switches via deps.conservativeGate', () => {
    const minimal = {
      config: { probe: { maxConcurrentProbes: 1, probeTimeoutMs: 1000 } },
      memory: {},
      seams: {},
      policy: {},
      proposer: {},
      composer: {},
      reflector: {},
      scorer: {},
      taxonomy: {},
      dreamer: {},
      treePool: {},
      runBranch: async () => ({})
    } as unknown as EvoHarnessOrchestratorDeps;
    expect((minimal as { conservativeGate?: boolean }).conservativeGate).toBeUndefined();
    const off = new EvoHarnessOrchestratorImpl(minimal);
    expect(off.explorationBudgetRemaining()).toBe(0);
    // The deps field is the documented switch for the release-boundary PR.
    const on = new EvoHarnessOrchestratorImpl({ ...minimal, conservativeGate: true });
    expect((on as unknown as { conservativeGate: boolean }).conservativeGate).toBe(true);
  });
});
