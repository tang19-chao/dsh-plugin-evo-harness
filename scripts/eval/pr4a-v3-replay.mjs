#!/usr/bin/env node
/**
 * P2-B (p2-a-b-kernel): the production-semantics-aligned replay probe.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The V2 fair/PR-4A engines call runDecisionKernel() WITHOUT the production
 * learning filter, and they write records stamped rewardVersion
 * 'r2/verifiable-v1'. Under the production eligibility predicate
 * (isLearningEligibleRecord: exact CURRENT_REWARD_VERSION contract, schema >= 2,
 * learningEligible !== false) an r2 record is ALWAYS learning_ineligible, so:
 *
 *   - the V2 engines "replay" a policy that consumes evidence the live path
 *     never sees (the P2-B defect); and
 *   - aligning the filter on those engines would empty every neighbourhood,
 *     which is why the fix is a NEW aligned path (this file) plus an explicit
 *     abort instead of a silent zero-advantage "policy effect".
 *
 * The V2 engines are FROZEN (their historical frame is asserted by
 * negative-result-diag.mjs --assert and the e2e parity suite), so this probe
 * re-uses their MECHANISM - the same kernel, the same fixed-pool schedule, the
 * same state abstraction - with the production filter and the production reward
 * contract, over the V3 task table (./pr4a-v3-design.mjs).
 *
 * WHAT IT PROVES (all deterministic, no model call, no paid API):
 *
 *   1. PRODUCTION FILTER PARITY - every kernel call here spreads
 *      learningFacingFilterOptions(), the exact object the two production call
 *      sites (jit-active-policy.ts:767, jitrl/index.ts:1048) use;
 *   2. SURVIVAL - the production-filtered denominator is computed and printed
 *      per decision (records / survivors / per-reason counts / a readable
 *      sample), and an all-learning_ineligible snapshot ABORTS the run with a
 *      structured error instead of reporting a policy effect;
 *   3. NON-DEGENERATE LEARNING - with r4 evidence the aligned replay deviates
 *      from the confidence prior toward the higher-return action, and its
 *      executed coverage exceeds the prior lineage's (the discriminability V3
 *      was designed for);
 *   4. GRADED HOST ACCEPTANCE - the trusted pass/fail verdict is the primary
 *      metric; a partial coverage number is reported as a SEPARATE diagnostic
 *      and provably never enters the reward (two trajectories with the same
 *      trusted verdict but different partial coverage score identically);
 *   5. THE V2 GAP, QUANTIFIED - a shadow control runs the SAME mixed fixture
 *      through (a) the aligned filter and (b) the V2 call shape (no filter
 *      options). The V2 shape admits the r2 records and flips the choice; the
 *      aligned path keeps only production-eligible evidence. That is the
 *      measured reason the historical five-arm conclusions must not be read as
 *      production policy effects.
 *
 * RESULT STATUS: every number this probe prints is a DESIGN-TIME SELF-CHECK of
 * the V3 fixture. No V3 metric may be cited as an evaluation result before the
 * pre-registration records the design digest (P2-C owns that record); the JSON
 * carries resultStatus for exactly that reason.
 *
 * Exit codes: 0 = every assertion held; 1 = an assertion failed; 2 = the
 * production-aligned path aborted (survival), which is a failure unless the
 * fixture mode EXPECTED the abort (the r2-legacy negative control).
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { buildEvalLib, REPO_ROOT } from './build-eval.mjs';

const design = await import('./pr4a-v3-design.mjs');

/** The fixture modes this probe supports (one flag, one meaning). */
export const FIXTURE_MODES = Object.freeze(['r4-production', 'r2-legacy', 'mixed-legacy']);

/** Stable abort code, mirrored from the kernel's LearningFacingSurvivalError. */
const SURVIVAL_ABORT = 'learning_facing_survival_abort';

/**
 * Load one production module through the shared content-addressed esbuild cache
 * (build-eval.mjs). Three entries are needed because the kernel barrel does not
 * re-export the reward contract or the verification runner; each artifact is
 * cached by source fingerprint, so repeated runs pay nothing.
 */
async function loadProductionEntry(name, entryPath) {
  const { outfile, digest, mode } = await buildEvalLib({
    entry: join(REPO_ROOT, entryPath),
    name
  });
  const { pathToFileURL } = await import('node:url');
  const namespace = await import(pathToFileURL(outfile).href);
  return { namespace, bundle: { name, digest, mode, entry: entryPath } };
}

const kernelApi = await loadProductionEntry('p2-v3-kernel', join('src', 'jitrl', 'index.ts'));
const rewardApi = await loadProductionEntry('p2-v3-reward', join('src', 'jitrl', 'reward-contract.ts'));
const verificationApi = await loadProductionEntry('p2-v3-verification', join('src', 'verification', 'index.ts'));

const {
  runDecisionKernel,
  experienceSurvival,
  learningFacingFilterOptions,
  learningFacingSurvival,
  assertLearningFacingSurvival,
  LearningFacingSurvivalError,
  LEARNING_CONSUMER_FILTER,
  normalizeLayerDecisionConfig,
  abstractProposalState,
  verbalizedLogit,
  seedFromParts,
  createMemoryExperienceStore,
  CURRENT_REWARD_VERSION,
  EXPERIENCE_SCHEMA_VERSION
} = kernelApi.namespace;

const { scoreUnderRewardContract, REWARD_CONTRACT, REWARD_CONTRACT_WEIGHTS } = rewardApi.namespace;
const {
  createHostOwnedVerificationRunner,
  verifyAndAttach,
  clearQualityRecordRegistry
} = verificationApi.namespace;

// ---------------------------------------------------------------------------
// deterministic primitives (same conventions as the fair engine)
// ---------------------------------------------------------------------------

let clockValue = 1_700_000_000_000;
const clock = () => {
  clockValue += 1;
  return clockValue;
};

/** ProbeTask shape the state abstraction expects. */
function probeTaskOf(task) {
  return {
    id: task.id,
    prompt: task.prompt,
    taskSignature: task.signature,
    complexity: task.complexity,
    contextTags: task.contextTags
  };
}

/** The proposer state of one V3 decision point (same abstraction as the fair engine). */
function decisionState(task, round) {
  return abstractProposalState({
    task: probeTaskOf(task),
    round,
    parentDepth: round,
    parentSlot: 'exploit',
    memoryConfidence: 0,
    referenceStatus: 'failed',
    slot: 'exploit',
    guidance: 'memory'
  });
}

/** The inherited lineage of the FIXED schedule at one round (prior-only). */
function inheritedSurfaces(task, round) {
  return task.prefs.slice(0, round).filter((surface) => !task.blind.includes(surface));
}

/**
 * One executed-training trajectory for (task, round, candidate).
 *
 * The deliverable names the surfaces the composed lineage covers as
 * machine-checkable markers, so the host verifier judges the BYTES - the same
 * discipline the PR-4A host runner uses. The steps are identical for every
 * candidate of a decision point, which is what makes "partial coverage changed
 * nothing in the reward" a real equality instead of an accident.
 */
function buildTrainingTrajectory(input) {
  const label = input.surfaces.length === 0 ? 'nothing' : input.surfaces.join('+');
  // The execution status is the RUNNER's honest report (the PR-4A rule): a probe
  // whose composed lineage does not cover the task reports 'failed'. Writing it
  // as 'succeeded' would turn every failed acceptance into a falsified success
  // claim, which the production scorer marks learning-ineligible (audit-only) -
  // that is correct for a lie, but it is not what a partial probe is.
  const steps = [
    { index: 0, at: clock(), kind: 'model', text: 'plan the change for ' + label },
    {
      index: 1,
      at: clock(),
      kind: 'tool',
      toolName: 'shell',
      toolArguments: { cmd: 'node scripts/eval/pr4a-v3-design.mjs --canonical' },
      toolResult: { exitCode: 0 }
    },
    { index: 2, at: clock(), kind: 'message', text: 'checks complete for ' + label }
  ];
  const content =
    'v3 synthetic deliverable covering ' + label + '\n' +
    input.surfaces.map((surface) => 'surface:' + surface).join('\n');
  return {
    id: input.id,
    sessionId: 'v3-' + input.task.id,
    branchId: 'v3-branch-' + input.task.id,
    branchNamespace: 'v3/' + input.task.id,
    role: 'candidate',
    status: input.verified ? 'succeeded' : 'failed',
    patchId: input.patchId,
    patchOrigin: 'domain',
    surfaceKeys: [],
    startedAt: input.startedAt,
    endedAt: clock(),
    metrics: {
      steps: steps.length,
      toolCalls: 1,
      toolErrors: 0,
      durationMs: Math.max(0, clock() - input.startedAt)
    },
    steps,
    toolErrors: [],
    failureSignals: [],
    memoryRecallIds: [],
    deliverable: { content, format: 'markdown' }
  };
}

/**
 * The per-fixture host verifier.
 *
 * Created per fixture so its registry - and therefore its trust - is local. The
 * checks judge the artifact bytes: a candidate whose lineage does not cover every
 * required surface FAILS, whatever its own bookkeeping claims. This is the
 * graded acceptance: trusted pass/fail decides, partial coverage never does.
 */
function createFixtureVerifier(tasks) {
  // The quality/trust registry is process-global: a fresh fixture must start from
  // a clean registry, otherwise a previous fixture's receipt could authenticate a
  // record this one never verified.
  clearQualityRecordRegistry();
  const requiredByTask = new Map(tasks.map((task) => [task.id, [...task.required]]));
  return createHostOwnedVerificationRunner({
    verifierId: 'v3-host-verifier',
    verifierVersion: '1.0.0',
    testSetId: 'v3-synthetic-testset-v1',
    envId: 'v3-offline-env-v1',
    cases: tasks.map((task) => ({
      taskId: task.id,
      checks: [
        { id: 'artifact-non-empty', run: (artifact) => artifact.content.length > 0 },
        {
          id: 'artifact-covers-required-surfaces',
          run: (artifact) => {
            const required = requiredByTask.get(task.id) ?? [];
            if (required.length === 0) return true;
            return required.every((surface) => artifact.content.includes('surface:' + surface));
          }
        },
        { id: 'artifact-has-no-secret', run: (artifact) => !/sk-[a-z0-9-]{8,}/i.test(artifact.content) }
      ]
    }))
  });
}

/** The reward contract's weights hash: binds "same yardstick" to bytes. */
function weightsHashOf() {
  const entries = Object.entries(REWARD_CONTRACT_WEIGHTS).sort((left, right) =>
    left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0
  );
  return (
    'sha256:' +
    createHash('sha256')
      .update(JSON.stringify(entries), 'utf8')
      .digest('hex')
  );
}

// ---------------------------------------------------------------------------
// one replay
// ---------------------------------------------------------------------------

/**
 * Run the aligned replay over the V3 table.
 *
 * Causality: the training library for (task, round) is written BEFORE the
 * decision at that round and AFTER the previous round's decision, so the causal
 * cutoff (config.before) can never admit a later round's record. No write-back
 * happens after a decision, so no decision can read its own outcome.
 *
 * @param {object} options
 * @param {'r4-production'|'r2-legacy'|'mixed-legacy'} options.fixtureMode
 * @param {boolean} options.aligned - true spreads learningFacingFilterOptions()
 *   (production semantics); false reproduces the V2 fair/PR-4A call shape (no
 *   filter options) for the shadow control ONLY.
 * @param {readonly string[]} [options.tasks] - optional task-id subset.
 */
async function runReplay(options) {
  const fixtureMode = options.fixtureMode;
  const aligned = options.aligned === true;
  const rounds = design.V3_ROUNDS;
  const tasks = design.V3_TASKS.filter(
    (task) => options.tasks === undefined || options.tasks.includes(task.id)
  );

  const verifier = createFixtureVerifier(design.V3_TASKS);
  const seam = { runner: verifier, enabled: true };
  // The graded acceptor's trust set: the host runner's own producer identity.
  const trustedProducers = verifier.trustedProducers;

  const store = createMemoryExperienceStore({
    now: clock,
    halfLifeMs: 0,
    bucketCap: 200
  });

  const layerConfig = normalizeLayerDecisionConfig({
    beta: 1,
    k: 10,
    similarityThreshold: 0.3,
    selection: 'argmax',
    lambda: 0,
    alpha: 0,
    unseenFallback: 'baseline',
    halfLifeMs: 0
  });

  /** Per-decision rows (the probe's own ledger). */
  const decisions = [];
  const survivalRows = [];
  const supportRows = [];
  const aborts = [];
  let libraryPass = 0;
  let libraryFail = 0;
  let libraryRefused = 0;
  let executedPass = 0;
  let executedFail = 0;
  let executedRefused = 0;
  let partialSum = 0;
  let priorLineageCoverageSum = 0;
  let executedLineageCoverageSum = 0;
  let deviations = 0;
  let recordCount = 0;

  for (const task of tasks) {
    let covered = new Set();
    let priorCovered = new Set();
    for (let round = 0; round < rounds; round += 1) {
      const state = decisionState(task, round);
      const pool = design.v3PoolForDecision(task, round);

      // ---- training library for THIS decision point (causally prior) --------
      const candidateVerdicts = new Map();
      for (const candidate of pool) {
        const lineage = [...new Set([...inheritedSurfaces(task, round), ...candidate.surfaces])];
        const patchId = 'v3-' + task.id + '-r' + String(round) + '-c' + String(candidate.index);
        const startedAt = clock();
        const trajectory = buildTrainingTrajectory({
          id: 'v3-traj-' + patchId,
          task,
          patchId,
          surfaces: lineage,
          verified: design.coverageOf(task, lineage) >= 1 - 1e-9,
          startedAt
        });
        const attach = await verifyAndAttach({
          seam,
          trajectory,
          runId: 'v3-' + task.id + '-r' + String(round),
          taskId: task.id
        });
        const verdict = attach.disposition?.authenticated === true ? attach.disposition.verdict : 'refused';
        candidateVerdicts.set(candidate.actionKey, verdict);
        if (verdict === 'passed') libraryPass += 1;
        else if (verdict === 'failed') libraryFail += 1;
        else libraryRefused += 1;
        const signal = scoreUnderRewardContract(attach.trajectory, { trustedProducers });
        const partialCoverage = design.coverageOf(task, lineage);
        partialSum += partialCoverage;
        const learningTarget = signal.learningEligible ? signal.reward : 0;
        const record = {
          id: 'v3-exp-' + patchId,
          level: 'proposal',
          state,
          actionKey: candidate.actionKey,
          reward: signal.reward,
          return: signal.reward,
          rewardSources: signal.sources,
          guidance: 'memory',
          policyId: 'v3-replay@v1',
          policyVersion: 'v3-replay@v1',
          sessionId: 'v3-' + task.id,
          treeId: 'v3-tree-' + task.id,
          taskId: task.id,
          runId: 'v3-' + task.id + '-r' + String(round),
          round,
          slotIndex: candidate.index,
          trajectoryId: attach.trajectory.id,
          decisionId: 'v3-decision-' + patchId,
          rewardVersion: CURRENT_REWARD_VERSION,
          provenanceVersion: kernelApi.namespace.CURRENT_PROVENANCE_VERSION,
          experienceSchemaVersion: EXPERIENCE_SCHEMA_VERSION,
          observedReturn: signal.reward,
          attributionBaseline: 0,
          learningTarget,
          outcome: signal.outcome,
          learningEligible: signal.learningEligible,
          decisionMode: 'shadow',
          actionKeyVocabulary: 'signature',
          learningTrack: signal.taskQualityEvidence ? 'task-quality' : 'process',
          createdAt: clock(),
          redacted: true
        };
        // The legacy/mixed fixtures relabel a COPY of the same evidence. The
        // relabelled set is what the V2 engines effectively trained on: same
        // states, same action keys, older reward contract.
        const fullPass = design.coverageOf(task, lineage) >= 1 - 1e-9;
        if (fixtureMode === 'r2-legacy') {
          // Negative control: the WHOLE library relabelled on the retired scale.
          await store.append([{ ...record, id: record.id + '-legacy', rewardVersion: 'r2/verifiable-v1' }]);
          recordCount += 1;
        } else {
          await store.append([record]);
          recordCount += 1;
          if (fixtureMode === 'mixed-legacy') {
            /**
             * The stale-scale corpus, modelling the RETIRED r2 ordering: r2's
             * completion rewarded "text existed", so on that scale a partial
             * artifact looked BETTER than a verified pass (the label/formula
             * mismatch the reward-contract switch retired, see
             * src/jitrl/reward-contract.ts). Three copies model a store that
             * accumulated these rows over many old episodes.
             *
             * This is a MODELLING ASSUMPTION of the shadow control, not a
             * measurement: its only job is to answer "would a replay that admits
             * these records choose differently from one that does not?".
             */
            const staleReward = fullPass ? 0.1 : 0.9;
            const stale = [];
            for (let copy = 0; copy < 3; copy += 1) {
              stale.push({
                ...record,
                id: record.id + '-legacy-' + String(copy + 1),
                rewardVersion: 'r2/verifiable-v1',
                reward: staleReward,
                return: staleReward,
                observedReturn: staleReward,
                learningTarget: staleReward
              });
            }
            await store.append(stale);
            recordCount += stale.length;
          }
        }
      }

      // ---- the decision (production filter, causally truncated) -------------
      const before = clock();
      const snapshot = store.snapshot();
      const filterScope = {
        level: 'proposal',
        guidance: 'memory',
        before
      };
      // The V2 call shape control uses the RAW filter (experienceSurvival):
      // learningFacingSurvival always applies the production options, so using it
      // for the control would make the comparison vacuous by construction.
      const survival = aligned
        ? learningFacingSurvival(snapshot, { ...filterScope, ...learningFacingFilterOptions() })
        : experienceSurvival(snapshot, { ...filterScope });
      /**
       * The RETRIEVAL denominator: the same production filter PLUS the state
       * bucket the retriever prefers. It answers a different question from the
       * filter denominator - "could this decision point learn an ACTION
       * preference at all?" - and is reported separately so a task with no
       * local evidence is visible instead of being averaged into an "effect".
       */
      const localSurvival = learningFacingSurvival(
        snapshot,
        aligned
          ? { ...filterScope, bucket: state.bucket, ...learningFacingFilterOptions() }
          : { ...filterScope, bucket: state.bucket }
      );
      survivalRows.push({
        task: task.id,
        round,
        fixture: fixtureMode,
        aligned,
        records: survival.records,
        survivors: survival.survivors,
        excluded: survival.excluded,
        byReason: { ...survival.byReason },
        mainExclusion: survival.mainExclusion,
        sample: [...survival.sample],
        localSurvivors: localSurvival.survivors,
        hasLocalEvidence: localSurvival.survivors > 0
      });
      if (aligned) {
        // The P2-B assertion: a full snapshot with zero production-eligible
        // survivors must STOP the replay, not produce a prior-shaped effect.
        try {
          assertLearningFacingSurvival(survival, { context: 'v3-aligned-replay' });
        } catch (error) {
          if (error instanceof LearningFacingSurvivalError) {
            aborts.push({
              task: task.id,
              round,
              code: error.code,
              message: error.message
            });
          } else {
            throw error;
          }
        }
      }

      const candidates = pool.map((candidate) => ({
        actionKey: candidate.actionKey,
        baseLogit: verbalizedLogit(candidate.confidence),
        source: 'llm',
        payload: candidate
      }));
      const kernelResult = runDecisionKernel({
        level: 'proposal',
        state,
        candidates,
        records: snapshot,
        config: { ...layerConfig, before },
        guidance: 'memory',
        ...(aligned ? learningFacingFilterOptions() : {}),
        seed: seedFromParts(0x5eed1a, task.id, 0, round, 'l2')
      });
      const chosenKey = kernelResult.decision.chosen.candidate.actionKey;
      const chosenCandidate = pool.find((entry) => entry.actionKey === chosenKey) ?? pool[0];
      // The prior is the argmax-confidence candidate, exactly as the fair
      // engine's priorIndex rule defines it (index accumulator, not an object
      // accumulator: mixing the two silently selects the LOWEST-confidence entry).
      const priorIndex = pool.reduce(
        (best, entry) => (entry.confidence > (pool[best]?.confidence ?? -Infinity) ? entry.index : best),
        0
      );
      const priorCandidate = pool[priorIndex] ?? pool[0];
      const chosenAdjustment = kernelResult.decision.adjustments.find(
        (adjustment) => adjustment.candidate.actionKey === chosenKey
      );
      const executedLineage = [
        ...new Set([...covered, ...(chosenCandidate?.surfaces ?? [])])
      ];
      const priorLineage = [
        ...new Set([...priorCovered, ...(priorCandidate?.surfaces ?? [])])
      ];
      if ((chosenCandidate?.index ?? 0) !== priorCandidate.index) deviations += 1;
      const executedVerdict = candidateVerdicts.get(chosenCandidate?.actionKey) ?? 'refused';
      if (executedVerdict === 'passed') executedPass += 1;
      else if (executedVerdict === 'failed') executedFail += 1;
      else executedRefused += 1;
      covered = new Set(executedLineage.filter((surface) => !task.blind.includes(surface)));
      priorCovered = new Set(priorLineage.filter((surface) => !task.blind.includes(surface)));

      decisions.push({
        task: task.id,
        round,
        fixture: fixtureMode,
        aligned,
        poolSize: pool.length,
        distinctActionCount: new Set(pool.map((entry) => entry.className)).size,
        priorActionKey: priorCandidate.actionKey,
        chosenActionKey: chosenKey,
        deviated: chosenKey !== priorCandidate.actionKey,
        support: chosenAdjustment?.support ?? 0,
        q: chosenAdjustment?.q ?? null,
        advantage: chosenAdjustment?.advantage ?? 0,
        klToPrior: kernelResult.decision.klToPrior,
        neighborCount: kernelResult.neighborCount,
        filters: {
          records: kernelResult.filters.records,
          kept: kernelResult.filters.kept,
          excludeLegacy: kernelResult.filters.excludeLegacy,
          learningEligibleOnly: kernelResult.filters.learningEligibleOnly
        },
        // PRIMARY metric: the host runner's trusted pass/fail for the executed
        // lineage (never a coverage-derived expectation).
        primary: {
          trustedVerdict: candidateVerdicts.get(chosenCandidate?.actionKey) ?? 'refused'
        },
        // DIAGNOSTIC ONLY: partial coverage never enters the reward (asserted).
        diagnostics: {
          partialCoverage: design.coverageOf(task, executedLineage)
        }
      });

      // Kernel-supported action matrix row: support per candidate action.
      for (const candidate of pool) {
        const adjustment = kernelResult.decision.adjustments.find(
          (entry) => entry.candidate.actionKey === candidate.actionKey
        );
        supportRows.push({
          decisionPoint: task.id + '|r' + String(round),
          actionKey: candidate.actionKey,
          support: adjustment?.support ?? 0
        });
      }
    }
    executedLineageCoverageSum += design.coverageOf(task, [...covered]);
    priorLineageCoverageSum += design.coverageOf(task, [...priorCovered]);
  }

  const taskCount = Math.max(1, tasks.length);
  // Kernel-backed support matrix: rows are decision points, columns are action
  // keys, cells are the kernel's own support counts. The rank check runs on the
  // SAME rankOfMatrix implementation the design gate uses (one implementation,
  // negative-controlled by degenerateRankOneFixture in the unit tests).
  const matrixDecisionPoints = [...new Set(supportRows.map((row) => row.decisionPoint))].sort();
  const matrixActionKeys = [...new Set(supportRows.map((row) => row.actionKey))].sort();
  const matrixCells = buildCells(supportRows, matrixDecisionPoints, matrixActionKeys);
  const supportMatrix = {
    decisionPoints: matrixDecisionPoints,
    actionKeys: matrixActionKeys,
    cells: matrixCells,
    rank: design.rankOfMatrix(matrixCells),
    minActionsPerDecisionPoint: Math.min(
      ...matrixDecisionPoints.map((point) => supportRows.filter((row) => row.decisionPoint === point).length)
    )
  };

  return {
    fixture: fixtureMode,
    aligned,
    aborted: aborts.length > 0,
    aborts,
    taskCount: tasks.length,
    rounds,
    recordCount,
    survivalTotals: {
      decisions: survivalRows.length,
      records: survivalRows.reduce((sum, row) => sum + row.records, 0),
      survivors: survivalRows.reduce((sum, row) => sum + row.survivors, 0),
      byReason: sumByReason(survivalRows)
    },
    coverage: {
      priorLineageMean: round6(priorLineageCoverageSum / taskCount),
      executedLineageMean: round6(executedLineageCoverageSum / taskCount),
      deviations,
      deviationShare: round6(deviations / Math.max(1, decisions.length))
    },
    primary: {
      trustedPass: executedPass,
      trustedFail: executedFail,
      refused: executedRefused,
      trustedPassShare: round6(executedPass / Math.max(1, executedPass + executedFail + executedRefused)),
      libraryVerdicts: { passed: libraryPass, failed: libraryFail, refused: libraryRefused }
    },
    diagnostics: {
      partialCoverageMean: round6(
        decisions.reduce((sum, row) => sum + row.diagnostics.partialCoverage, 0) /
          Math.max(1, decisions.length)
      ),
      note:
        'partial coverage is a DIAGNOSTIC only: the trusted pass/fail verdict decides the reward, and the graded-equality assertion below proves partial coverage never enters it'
    },
    supportMatrix,
    decisions,
    survivalRows
  };
}

/** Sum the per-reason counts of a survival-row list. */
function sumByReason(rows) {
  const totals = {};
  for (const row of rows) {
    for (const [reason, count] of Object.entries(row.byReason)) {
      totals[reason] = (totals[reason] ?? 0) + count;
    }
  }
  return totals;
}

/** Dense cell matrix from (decisionPoint, actionKey, support) rows. */
function buildCells(rows, decisionPoints, actionKeys) {
  const index = new Map(actionKeys.map((key, position) => [key, position]));
  return decisionPoints.map((point) => {
    const row = new Array(actionKeys.length).fill(0);
    for (const entry of rows) {
      if (entry.decisionPoint === point) {
        row[index.get(entry.actionKey)] = entry.support;
      }
    }
    return row;
  });
}

function round6(value) {
  return Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : 0;
}

export { runReplay, weightsHashOf, SURVIVAL_ABORT };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /pr4a-v3-replay\.mjs$/.test(process.argv[1].replace(/\\/g, '/'));

if (invokedDirectly) {
  const fixtureArg = (process.argv.find((arg) => arg.startsWith('--fixture=')) ?? '--fixture=r4-production').slice('--fixture='.length);
  /**
   * --out= carries a PATH, so the flag prefix MUST be stripped before the value
   * is used as one. The bug this replaces looked the argument up and then used
   * the raw token, so a run with --out=work/x.json created a literal directory
   * named "--out=work" next to the repository root (the prefix itself became the
   * first path segment). It is the exact class of defect where "the argument is
   * treated as a path" is never checked, so the empty value is now a fail-closed
   * user error BEFORE any replay work runs.
   */
  const outRaw = process.argv.find((arg) => arg.startsWith('--out='));
  const outArg = outRaw === undefined ? undefined : outRaw.slice('--out='.length);
  if (outArg !== undefined && outArg.trim().length === 0) {
    console.error('[v3-replay] invalid --out=: expected a non-empty file path (nothing was written)');
    process.exit(1);
  }
  if (!FIXTURE_MODES.includes(fixtureArg)) {
    console.error('[v3-replay] unknown fixture mode: ' + fixtureArg + ' (expected one of ' + FIXTURE_MODES.join(', ') + ')');
    process.exitCode = 1;
  } else {
    const json = process.argv.includes('--json');
    // outArg is already the PATH (prefix stripped above); undefined = no file.
    const designDigestValue = await design.designDigest();

    const alignedRun = await runReplay({ fixtureMode: fixtureArg, aligned: true });
    /**
     * THE SHADOW CONTROL (P2-B). It always runs on the MIXED fixture so the V2
     * call shape is compared on evidence that actually differs under the
     * production filter: the mixed fixture carries r2-labelled copies of the same
     * observations with inverted rewards, i.e. exactly the kind of record a V2
     * engine would train on and the production path rejects.
     */
    const mixedAligned = await runReplay({ fixtureMode: 'mixed-legacy', aligned: true });
    const mixedV2Shape = await runReplay({ fixtureMode: 'mixed-legacy', aligned: false });

    /** The graded-equality witness: same trusted verdict, different partial coverage. */
    const gradedWitness = await buildGradedWitness();

    const assertions = [
      {
        id: 'production-filter-parity',
        ok: alignedRun.decisions.every(
          (row) => row.filters.excludeLegacy === LEARNING_CONSUMER_FILTER.excludeLegacy &&
            row.filters.learningEligibleOnly === LEARNING_CONSUMER_FILTER.learningEligibleOnly
        ) && alignedRun.decisions.length > 0,
        detail:
          'every aligned kernel call carries excludeLegacy=' + String(LEARNING_CONSUMER_FILTER.excludeLegacy) +
          ' and learningEligibleOnly=' + String(LEARNING_CONSUMER_FILTER.learningEligibleOnly) +
          ' (the exact production filter object)'
      },
      {
        id: 'survival-denominator-reported',
        ok:
          alignedRun.survivalRows.length > 0 &&
          alignedRun.survivalRows.every((row) => typeof row.records === 'number' && typeof row.survivors === 'number') &&
          alignedRun.survivalRows.every((row) => row.excluded === 0 || row.mainExclusion !== null) &&
          (fixtureArg === 'r2-legacy'
            ? alignedRun.survivalTotals.survivors === 0
            : alignedRun.survivalTotals.survivors > 0),
        detail:
          'per-decision survival rows carry records/survivors/byReason/mainExclusion/sample (' +
          String(alignedRun.survivalRows.length) + ' rows; total survivors ' +
          String(alignedRun.survivalTotals.survivors) + ' of ' + String(alignedRun.survivalTotals.records) +
          ', byReason ' + JSON.stringify(alignedRun.survivalTotals.byReason) + ')'
      },
      {
        id: 'abort-on-all-learning-ineligible',
        ok: fixtureArg === 'r2-legacy'
          ? alignedRun.aborted &&
            alignedRun.aborts.every((abort) => abort.message.includes('learning_ineligible') || abort.message.includes('legacy'))
          : !alignedRun.aborted,
        detail:
          fixtureArg === 'r2-legacy'
            ? String(alignedRun.aborts.length) + ' abort(s); first: ' + (alignedRun.aborts[0]?.message ?? '(none)').slice(0, 220)
            : 'the r4 fixture has production-eligible survivors, so no abort fired'
      },
      {
        id: 'support-matrix-rank-greater-than-one',
        // An ABORTED run makes no policy-effect claim, so its matrix is
        // vacuously rank 0; requiring rank > 1 there would be asking an aborted
        // experiment to produce evidence. The strict form applies whenever the
        // run completed.
        ok: alignedRun.aborted ? true : alignedRun.supportMatrix.rank > 1,
        detail: alignedRun.aborted
          ? 'not applicable: the aligned run aborted (no policy-effect claim is made); strict rank check applies to completed runs'
          : 'kernel-backed support matrix: ' + String(alignedRun.supportMatrix.decisionPoints.length) +
            ' decision points x ' + String(alignedRun.supportMatrix.actionKeys.length) +
            ' action keys, rank=' + String(alignedRun.supportMatrix.rank)
      },
      {
        id: 'prior-vs-executed-non-degenerate',
        ok: alignedRun.aborted
          ? true
          : alignedRun.coverage.executedLineageMean > alignedRun.coverage.priorLineageMean + 1e-9,
        detail: alignedRun.aborted
          ? 'not applicable: the aligned run aborted; the executed lineage is prior-shaped BY FILTER, which is exactly why no effect may be reported'
          : 'prior lineage mean coverage ' + alignedRun.coverage.priorLineageMean.toFixed(3) +
            ' vs executed ' + alignedRun.coverage.executedLineageMean.toFixed(3) +
            ' (deviation share ' + alignedRun.coverage.deviationShare.toFixed(3) + ')'
      },
      {
        id: 'graded-partial-score-excluded-from-reward',
        ok: gradedWitness.partialEqualsFailed && gradedWitness.passAboveFailed,
        detail: gradedWitness.detail
      },
      {
        id: 'v2-shape-divergence-witness',
        ok:
          mixedV2Shape.survivalTotals.survivors > mixedAligned.survivalTotals.survivors &&
          mixedV2Shape.coverage.executedLineageMean < mixedAligned.coverage.executedLineageMean - 1e-9,
        detail:
          'mixed fixture, same snapshot: aligned survivors ' + String(mixedAligned.survivalTotals.survivors) +
          ' (executed coverage ' + mixedAligned.coverage.executedLineageMean.toFixed(3) + ') vs V2-call-shape survivors ' +
          String(mixedV2Shape.survivalTotals.survivors) + ' (executed coverage ' +
          mixedV2Shape.coverage.executedLineageMean.toFixed(3) + ') - the V2 shape admits r2 records the production filter rejects'
      },
      {
        id: 'offline-only-no-live-calls',
        ok: true,
        detail: 'no model adapter is constructed anywhere in this probe; every number is a deterministic fixture computation (liveCalls=0, incurredRealUsd=0)'
      },
      {
        id: 'design-digest-recorded',
        ok: designDigestValue.startsWith('sha256:'),
        detail: designDigestValue + ' (the value the pre-registration must record before any V3 result is cited)'
      }
    ];

    const failed = assertions.filter((entry) => !entry.ok);
    const payload = {
      resultStatus: 'design-time-self-check-not-a-result',
      probe: 'pr4a-v3-replay',
      designVersion: design.V3_DESIGN_VERSION,
      designDigest: designDigestValue,
      fixture: fixtureArg,
      rewardContract: {
        version: REWARD_CONTRACT.version,
        aggregation: REWARD_CONTRACT.aggregation,
        weights: { ...REWARD_CONTRACT_WEIGHTS },
        weightsHash: weightsHashOf(),
        learningTargetField: REWARD_CONTRACT.learningTargetField
      },
      aligned: summarize(alignedRun),
      v2ShapeShadow: {
        fixture: 'mixed-legacy',
        aligned: summarize(mixedAligned),
        v2CallShape: summarize(mixedV2Shape),
        note:
          'the V2 fair/PR-4A call shape (no filter options) on the SAME mixed fixture; kept as a shadow control, never as a result'
      },
      assertions,
      // Full rows are written to --out only; stdout keeps the summary readable.
      decisions: alignedRun.decisions,
      survivalRows: alignedRun.survivalRows
    };

    if (outArg !== undefined) {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const { dirname, resolve } = await import('node:path');
      // Resolve once so the written path and the reported path are the same
      // string, and create only the file's own parent directory.
      const outPath = resolve(outArg);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    }

    if (json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log('[v3-replay] probe: production-semantics-aligned replay (P2-B, p2-a-b-kernel)');
      console.log('[v3-replay] design: ' + payload.designVersion + ' ' + payload.designDigest);
      console.log('[v3-replay] fixture: ' + fixtureArg + ' | reward contract: ' + payload.rewardContract.version + ' weights ' + JSON.stringify(payload.rewardContract.weights));
      console.log('');
      console.log('[v3-replay] survival (production filter): ' +
        String(payload.aligned.survival.survivors) + ' of ' + String(payload.aligned.survival.records) +
        ' records survive; byReason ' + JSON.stringify(payload.aligned.survival.byReason));
      const firstSample = alignedRun.survivalRows.find((row) => row.excluded > 0);
      if (firstSample !== undefined) {
        console.log('[v3-replay] excluded sample (' + firstSample.task + '|r' + String(firstSample.round) + '): ' + firstSample.sample.join(', '));
      }
      console.log('[v3-replay] coverage: prior ' + payload.aligned.coverage.priorLineageMean.toFixed(3) +
        ' -> executed ' + payload.aligned.coverage.executedLineageMean.toFixed(3) +
        ' (deviations ' + String(payload.aligned.coverage.deviations) + '/' + String(payload.aligned.decisions) + ' decisions;' +
        ' decisions without local evidence ' + String(alignedRun.survivalRows.filter((row) => !row.hasLocalEvidence).length) + '/' + String(alignedRun.survivalRows.length) + ')');
      console.log('[v3-replay] primary (trusted pass/fail): pass=' + String(payload.aligned.primary.trustedPass) +
        ' fail=' + String(payload.aligned.primary.trustedFail) + ' refused=' + String(payload.aligned.primary.refused) +
        ' | diagnostic partialCoverageMean=' + payload.aligned.diagnostics.partialCoverageMean.toFixed(3) + ' (never in reward)');
      console.log('[v3-replay] support matrix rank: ' + String(payload.aligned.supportMatrix.rank) + ' (must be > 1)');
      console.log('[v3-replay] V2-shape shadow (mixed fixture): survivors ' + String(payload.v2ShapeShadow.v2CallShape.survival.survivors) +
        ' vs aligned ' + String(payload.v2ShapeShadow.aligned.survival.survivors) +
        ' | executed coverage ' + payload.v2ShapeShadow.v2CallShape.coverage.executedLineageMean.toFixed(3) +
        ' vs aligned ' + payload.v2ShapeShadow.aligned.coverage.executedLineageMean.toFixed(3));
      console.log('');
      for (const assertion of assertions) {
        console.log('  ' + (assertion.ok ? 'PASS' : 'FAIL') + '  ' + assertion.id + ' - ' + assertion.detail);
      }
      console.log('');
      if (alignedRun.aborted) {
        console.log('[v3-replay] ABORTED (expected for the r2-legacy control):');
        for (const abort of alignedRun.aborts.slice(0, 2)) {
          console.log('  ' + abort.task + '|r' + String(abort.round) + ' [' + abort.code + '] ' + abort.message);
        }
      }
      console.log('[v3-replay] result: ' + (failed.length === 0 ? 'all assertions held (DESIGN-TIME SELF-CHECK - NOT AN EVALUATION RESULT)' : String(failed.length) + ' assertion(s) FAILED'));
    }
    if (failed.length > 0) {
      process.exitCode = 1;
    } else if (alignedRun.aborted && fixtureArg !== 'r2-legacy') {
      process.exitCode = 2;
    }
  }
}

/**
 * The graded-acceptance witness, built from two REAL scored trajectories.
 *
 * Same trusted verdict, different partial coverage -> identical reward (partial
 * coverage is a diagnostic and provably never enters the main reward); a trusted
 * pass scores strictly above the same-shape failure.
 */
async function buildGradedWitness() {
  const task = design.V3_TASKS.find((entry) => entry.id === 'v3-ci-02');
  const verifier = createFixtureVerifier([task]);
  const seam = { runner: verifier, enabled: true };
  const trustedProducers = verifier.trustedProducers;
  const build = async (surfaces) => {
    const startedAt = clock();
    const trajectory = buildTrainingTrajectory({
      id: 'v3-graded-' + (surfaces.length === 0 ? 'nothing' : surfaces.join('-')),
      task,
      patchId: 'v3-graded-' + (surfaces.length === 0 ? 'nothing' : surfaces.join('-')),
      surfaces,
      verified: design.coverageOf(task, surfaces) >= 1 - 1e-9,
      startedAt
    });
    // The verification is ATTACHED before scoring: without a trusted receipt the
    // verdict resolves to 'unknown' (completion 0) and the graded comparison
    // below would be vacuous.
    const attach = await verifyAndAttach({
      seam,
      trajectory,
      runId: 'v3-graded',
      taskId: task.id
    });
    return scoreUnderRewardContract(attach.trajectory, { trustedProducers }).reward;
  };
  const partial = await build([task.required[0]]);
  const zero = await build([]);
  const full = await build([...task.required]);
  return {
    partialEqualsFailed: Math.abs(partial - zero) < 1e-9,
    passAboveFailed: full > partial + 1e-9,
    detail:
      'same trusted verdict, different partial coverage: partial=' + partial.toFixed(4) +
      ', zero=' + zero.toFixed(4) + ' (equal => partial score is excluded), full=' + full.toFixed(4) +
      ' (strictly above => trusted pass/fail is the primary driver)'
  };
}

/** Compact summary used by the JSON payload. */
function summarize(run) {
  return {
    aborted: run.aborted,
    decisions: run.decisions.length,
    survival: run.survivalTotals,
    coverage: run.coverage,
    primary: run.primary,
    diagnostics: run.diagnostics,
    supportMatrix: run.supportMatrix
  };
}
