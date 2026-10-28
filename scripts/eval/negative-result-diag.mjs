/**
 * P6.1-E: negative-result explanation harness (plan sections 7.1 / 8.1-8.4).
 *
 * Purpose: the fair-eval negative result (C3-online - C3-frozen verifiedRate
 * = -0.250 on the same-task protocol, episodes:5, rounds:3, docs/reports/
 * p6-fair-eval.md section 5) is a VALID result but must not be read as "the
 * algorithm principle failed". This script explains it at the DECISION level:
 *
 *   1. reproduce the -0.250 frame (same pool, seed, episodes, rounds);
 *   2. capture the decision-level ledger (payload-free structured fields);
 *   3. locate the FIRST decision that deviated from the prior and made the
 *      verifiable outcome worse (not a total-mean comparison);
 *   4. emit one replayable minimal counterexample per failed task;
 *   5. probe the preregistered hypotheses H1-H6 ONE CHANGE AT A TIME;
 *   6. account offline counterfactuals separately from the fair-arm budget.
 *
 * Every number this script prints comes from a real run of the same engine
 * that produced docs/reports/p6-fair-eval.md. No reward is guessed for a
 * candidate that never executed: the ledger carries only observed outcomes.
 *
 * Usage:
 *   node scripts/eval/negative-result-diag.mjs            human summary
 *   node scripts/eval/negative-result-diag.mjs --json     machine-readable
 *   node scripts/eval/negative-result-diag.mjs --assert   fail (exit 1) if the
 *                                                        historical frame drifted
 *
 * ASSERTIONS (PR-1)
 * -----------------
 * Before PR-1 this script only PRINTED its findings, so a regression that moved
 * the reproduction away from the historical -0.250 still exited 0 — the gate
 * reported "pass" no matter what. `--assert` turns the recorded historical facts
 * into real checks. It is opt-in so the historical diagnostic output stays
 * byte-identical for readers and existing callers.
 *
 * The rules themselves live in `./lib/negative-result-assertions.mjs` (a pure,
 * shebang-free module) so they can be unit-tested against mutated copies of the
 * real result. That split matters here: vitest does not strip a `#!` line when
 * the transformed file has CRLF endings, so this CLI cannot be imported by a
 * test on a `core.autocrlf=true` checkout — the pure module can, and the CLI
 * wiring is asserted through a child process instead.
 *
 *   A1  the reproduction frame matches history within tolerance
 *       (|meanDelta - (-0.250)| < 0.05, the script's own `matchesHistorical`,
 *       plus the recorded anchor itself);
 *   A2  the degraded-task list is non-empty (the negative result is about
 *       specific tasks, not a flat mean shift);
 *   A3  every minimal counterexample carries a replayable anchor
 *       (task id + replay coordinates + observed outcome);
 *   A4  the decision ledger is payload-free (no prompt/patch/deliverable text);
 *   A5  no hypothesis claims a confirmed root cause (they are hypotheses), and
 *       the report still states that boundary in so many words;
 *   A6  the strategy gates did NOT silently pass (H4 benefit gate stays unmet,
 *       i.e. the probe is not promoted to a default).
 */

import { loadEvalLib } from './build-eval.mjs';
import { evaluateAssertions } from './lib/negative-result-assertions.mjs';

const lib = await loadEvalLib();
const {
  runFairEngineWithLedger,
  fairArm,
  fairFixedPoolDigest,
  fairPoolForDecision,
  EVAL_TASKS,
  FAIR_DEFAULT_EPISODES,
  FAIR_DEFAULT_ROUNDS,
  FAIR_DEFAULT_SEED,
  FAIR_DEFAULT_K,
  FAIR_DEFAULT_BETA,
  FAIR_DEFAULT_SIMILARITY,
  round
} = lib;

/** Arithmetic mean (mirrors the lib's internal helper, not exported there). */
const mean = (values) => (values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length);

// ---------------------------------------------------------------------------
// protocol frame (identical to docs/reports/p6-fair-eval.md section 2)
// ---------------------------------------------------------------------------

const EPISODES = FAIR_DEFAULT_EPISODES; // 5
const ROUNDS = FAIR_DEFAULT_ROUNDS; // 3
const SEED = FAIR_DEFAULT_SEED;
const K = FAIR_DEFAULT_K;
const BETA = FAIR_DEFAULT_BETA;
const THRESHOLD = FAIR_DEFAULT_SIMILARITY;

const baseOptions = (spec, extras = {}) => ({
  spec,
  tasks: EVAL_TASKS,
  episodes: EPISODES,
  rounds: ROUNDS,
  seed: SEED,
  k: K,
  beta: BETA,
  similarityThreshold: THRESHOLD,
  protocol: 'same-task',
  initialSnapshot: [],
  storeMode: 'per-task',
  updates: spec.updates,
  experienceSource: spec.updates ? 'self' : 'none',
  ...extras
});

/** Paired per-task delta between two arm results (verifiedRate). */
function pairedDelta(left, right) {
  const byId = new Map(right.tasks.map((task) => [task.taskId, task]));
  const rows = [];
  for (const task of left.tasks) {
    const other = byId.get(task.taskId);
    if (other !== undefined) {
      rows.push({
        taskId: task.taskId,
        left: task.verifiedRate,
        right: other.verifiedRate,
        delta: round(task.verifiedRate - other.verifiedRate)
      });
    }
  }
  return {
    pairs: rows.length,
    meanDelta: round(mean(rows.map((row) => row.delta))),
    wins: rows.filter((row) => row.delta > 1e-9).length,
    ties: rows.filter((row) => Math.abs(row.delta) <= 1e-9).length,
    losses: rows.filter((row) => row.delta < -1e-9).length,
    rows
  };
}

/** Degradation profile: not just the total mean (plan section 8.4). */
function degradationProfile(deltaRows) {
  const degraded = deltaRows.filter((row) => row.delta < -1e-9);
  const improved = deltaRows.filter((row) => row.delta > 1e-9);
  return {
    degradedTaskShare: round(deltaRows.length === 0 ? 0 : degraded.length / deltaRows.length),
    degradedTasks: degraded.map((row) => row.taskId),
    improvedTasks: improved.map((row) => row.taskId),
    meanGainWhenImproved: round(mean(improved.map((row) => row.delta))),
    meanLossWhenDegraded: round(mean(degraded.map((row) => row.delta)))
  };
}

// ---------------------------------------------------------------------------
// 1. reproduce the negative-result frame: C3-online vs C3-frozen
// ---------------------------------------------------------------------------

const frozen = await runFairEngineWithLedger(baseOptions(fairArm('C3-frozen'), { diagnostics: { ledger: true } }));
const online = await runFairEngineWithLedger(baseOptions(fairArm('C3-online'), { diagnostics: { ledger: true } }));
const reproduction = pairedDelta(online.arm, frozen.arm);
const profile = degradationProfile(reproduction.rows);

// ---------------------------------------------------------------------------
// 2. the first harmful deviation (decision-level, not a mean)
// ---------------------------------------------------------------------------

/**
 * For every task/run/round of the online arm, recompute what the FROZEN arm
 * observed at the same coordinates. A deviation is "harmful" when the prior
 * choice, executed by the frozen arm at the same coordinates, reached a
 * better verifiable outcome (coverage) than the deviating choice did online.
 * The FIRST such decision in (task, run, round) order is the minimal
 * counterexample anchor; everything before it behaved like the prior.
 */
function firstHarmfulDeviations(ledger, frozenArm) {
  // Prior coverage at (task, round) reconstructed from the task table: the
  // frozen arm's empty store yields zero advantages, so its argmax is the
  // highest-prior candidate every round (verified below against run.chosen),
  // which makes the frozen lineage exactly prefs.slice(0, round + 1).
  const coverageOf = lib.coverageOf;
  const priorCoverageAt = (taskId, roundIndex) => {
    const spec = EVAL_TASKS.find((task) => task.id === taskId);
    if (spec === undefined) {
      return 0;
    }
    return coverageOf(spec, spec.prefs.slice(0, roundIndex + 1));
  };
  // Verify the frozen arm never deviated from the prior (the reconstruction
  // above is only valid then).
  for (const task of frozenArm.arm.tasks) {
    for (const run of task.runs) {
      for (let roundIndex = 0; roundIndex < run.chosen.length; roundIndex += 1) {
        if (run.chosen[roundIndex] !== run.priorChoice[roundIndex]) {
          throw new Error('frozen arm deviated from the prior at ' + task.taskId + ' run ' + run.runIndex + ' round ' + roundIndex + '; prior-coverage reconstruction is invalid');
        }
      }
    }
  }
  const events = [];
  for (const entry of ledger) {
    if (!entry.deviated || entry.minSupportGateFired) {
      continue;
    }
    const key = entry.task + '|' + String(entry.run) + '|' + String(entry.round);
    const priorCoverage = priorCoverageAt(entry.task, entry.round);
    // Harmful = the VERIFIER outcome got worse at the same coordinates (the
    // acceptance target is the verifier, not the fused return): the prior
    // lineage reached full coverage here, the deviating lineage did not.
    // A reward-scale drop with equal verifier outcome is H1 evidence, not a
    // harmful deviation by itself.
    const harmful = priorCoverage > 0.999 && entry.observedCoverage < 0.999;
    events.push({
      key,
      task: entry.task,
      run: entry.run,
      round: entry.round,
      priorChoice: entry.priorChoice,
      chosenChoice: entry.chosenChoice,
      priorActionKey: entry.candidateActionKeys[entry.priorChoice] ?? 'unknown',
      chosenActionKey: entry.actionKey,
      support: entry.support,
      q: entry.q,
      v: entry.v,
      advantage: entry.advantage,
      adjustedLogit: entry.adjustedLogit,
      kl: entry.kl,
      neighborCount: entry.neighborIds.length,
      neighborVersions: [...new Set(entry.neighborVersions)],
      targetField: entry.targetField,
      priorCoverageAtSameCoordinates: priorCoverage,
      chosenObservedOutcome: entry.observedOutcome,
      chosenObservedReturn: entry.observedReturn,
      chosenObservedCoverage: entry.observedCoverage,
      chosenObservedVerified: entry.observedVerified,
      verifierRewardMismatch:
        priorCoverage > 0.999 && entry.observedCoverage < 0.999 && entry.observedReturn > 0,
      harmful
    });
  }
  return events;
}

const deviations = firstHarmfulDeviations(online.decisionLedger, frozen);
const firstHarmful = deviations.find((event) => event.harmful) ?? null;

// ---------------------------------------------------------------------------
// 3. minimal counterexample per failed task (replayable, payload-free)
// ---------------------------------------------------------------------------

function minimalCounterexample(taskId, ledger, frozenArm) {
  const entries = ledger.filter(
    (entry) => entry.task === taskId && entry.deviated && !entry.minSupportGateFired
  );
  if (entries.length === 0) {
    return null;
  }
  const first = entries[0];
  const frozenTask = frozenArm.arm.tasks.find((task) => task.taskId === taskId);
  return {
    replay: {
      arm: 'C3-online',
      protocol: 'same-task',
      episodes: EPISODES,
      rounds: ROUNDS,
      seed: SEED,
      k: K,
      beta: BETA,
      similarityThreshold: THRESHOLD,
      taskGroup: first.taskGroup,
      task: first.task,
      run: first.run,
      round: first.round,
      poolDigest: first.candidatePoolDigest,
      poolDigestsByRound: [0, 1, 2].map((roundIndex) => fairFixedPoolDigest(EVAL_TASKS.find((t) => t.id === taskId), roundIndex)),
      candidateActionKeys: first.candidateActionKeys,
      priorChoice: first.priorChoice,
      chosenChoice: first.chosenChoice,
      stateBucket: first.stateBucket,
      stateFingerprint: first.stateFingerprint,
      neighborIds: first.neighborIds,
      neighborVersions: first.neighborVersions,
      similarity: first.similarity,
      weight: first.weight,
      support: first.support,
      q: first.q,
      v: first.v,
      advantage: first.advantage,
      adjustedLogit: first.adjustedLogit,
      kl: first.kl,
      rewardModelVersion: first.rewardModelVersion,
      targetField: first.targetField
    },
    observed: {
      onlineChosenOutcome: first.observedOutcome,
      onlineChosenReturn: first.observedReturn,
      onlineChosenCoverage: first.observedCoverage,
      onlineChosenVerified: first.observedVerified,
      frozenPriorChosenAtSameCoordinates:
        frozenTask?.runs.find((run) => run.runIndex === first.run)?.chosen[first.round] ?? null
    },
    verifierRewardMismatch: first.verifierRewardMismatch === true
      ? 'the fused reward stayed positive while the verifier failed at the same coordinates (reward/acceptance-objective mismatch evidence)'
      : null,
    noCounterfactual: 'unexecuted candidates carry no reward; only executed-probe outcomes are recorded'
  };
}

const failedTasks = reproduction.rows
  .filter((row) => row.delta < -1e-9)
  .map((row) => row.taskId);
const counterexamples = failedTasks.map((taskId) => ({
  taskId,
  counterexample: minimalCounterexample(taskId, online.decisionLedger, frozen)
}));

// ---------------------------------------------------------------------------
// 4. preregistered hypotheses H1-H6, ONE CHANGE AT A TIME (plan section 8.2)
// ---------------------------------------------------------------------------

const hypotheses = [];

// H1 reward/acceptance mismatch: same pool, same seed, ONLY the reward scale
// changes (r2-fair historical scale -> r3/unified-signals-v1 contract scale).
{
  const probe = await runFairEngineWithLedger(
    baseOptions(fairArm('C3-online'), {
      diagnostics: { rewardScale: 'r3-contract' }
    })
  );
  const delta = pairedDelta(probe.arm, frozen.arm);
  hypotheses.push({
    id: 'H1',
    hypothesis: '奖励与验收目标不一致（现目标 vs 统一 verifier 目标）',
    change: '仅换奖励标尺：scoreTrajectorySignals 默认权重 -> scoreUnderRewardContract (r3/unified-signals-v1)',
    minimalContrast: '同池同 seed 同 episodes/rounds；唯一变化是奖励标尺',
    verifiedRate: probe.arm.verifiedRate,
    deltaVsFrozen: delta.meanDelta,
    verdict:
      Math.abs(delta.meanDelta - reproduction.meanDelta) < 0.05
        ? 'cannot-exclude: 换统一标尺后与历史 -0.250 同量级，标尺差异不能单独解释负收益'
        : 'scale-sensitive: 标尺改变了负收益幅度（记录为再校准证据，不当作已确认根因）',
    note: 'r3 标尺（completion .5 / turn .3 / steps .1 / tool .1，tool 正项二值化）是 t6 落地的统一分尺；该对比本身即「学习信号重校准」的最小反例素材'
  });
}

// H2 state too coarse... in the OPPOSITE direction here: the historical state
// carries run-indexed tokens (round/depth/pslot/parent_patch_signature) that
// fragment retrieval across runs. 'coarse' removes them; if that HELPS, the
// historical state was too FINE (over-indexed), which is the same hypothesis
// evaluated from the other side.
{
  const probe = await runFairEngineWithLedger(
    baseOptions(fairArm('C3-online'), {
      diagnostics: { stateMode: 'coarse' }
    })
  );
  const delta = pairedDelta(probe.arm, frozen.arm);
  const neighborHit = probe.arm.health.neighborHitRate;
  hypotheses.push({
    id: 'H2',
    hypothesis: 'state 太粗/太细（状态抽象粒度）',
    change: '仅改状态：剥离 round:/depth:/pslot:/parent_patch_signature: 等 run 索引 token（历史状态对同一任务跨 run 过细，检索碎片化）',
    minimalContrast: '同池同 seed；唯一变化是 L2 状态 token 集',
    verifiedRate: probe.arm.verifiedRate,
    deltaVsFrozen: delta.meanDelta,
    neighborHitRate: neighborHit,
    meanSupport: probe.arm.health.meanSupport,
    verdict:
      delta.meanDelta > reproduction.meanDelta + 0.05
        ? 'supports: 放宽状态粒度后负收益收窄，历史 state 粒度是负收益的促成因素之一（假设，非已确认根因）'
        : 'cannot-exclude: 放宽粒度没有收窄负收益，state 粒度不是主因',
    note: '历史状态的 round:/depth: token 使 run k 的决策检索不到 run < k 的同任务记录（neighborHitRate 可见），学习窗口被切成孤立片段'
  });
}

// H3 actionKey over-structuring: the pool-slot edit signature fragments the
// support of semantically identical edits. 'surfaces' canonicalizes the key.
{
  const probe = await runFairEngineWithLedger(
    baseOptions(fairArm('C3-online'), {
      diagnostics: { actionKeyMode: 'surfaces' }
    })
  );
  const delta = pairedDelta(probe.arm, frozen.arm);
  hypotheses.push({
    id: 'H3',
    hypothesis: 'actionKey 过度结构化（支持被语义相同的编辑切碎）',
    change: '仅改 action key：normalizePatchSignature 槽位形状 -> surfaces:<sorted surfaces> 规范键',
    minimalContrast: '同池同 seed；唯一变化是 L2 候选的 action key',
    verifiedRate: probe.arm.verifiedRate,
    deltaVsFrozen: delta.meanDelta,
    meanSupport: probe.arm.health.meanSupport,
    verdict:
      delta.meanDelta > reproduction.meanDelta + 0.05
        ? 'supports: 规范化键后负收益收窄，键碎片化是促成因素之一（假设，非已确认根因）'
        : 'cannot-exclude: 规范化键没有收窄负收益，键碎片化不是主因',
    note: '判定关注 meanSupport 与负收益幅度是否同向变化'
  });
}

// H4 few-shot mis-switch: deviations with tiny support are the prime suspect.
// The gate falls back to the prior when support < 2 (the smallest deviation
// support observed on this suite).
{
  const observedSupports = online.decisionLedger
    .filter((entry) => entry.deviated && !entry.minSupportGateFired)
    .map((entry) => entry.support);
  const minObserved = observedSupports.length > 0 ? Math.min(...observedSupports) : null;
  const probe = await runFairEngineWithLedger(
    baseOptions(fairArm('C3-online'), {
      diagnostics: { minSupportToDeviate: 2, ledger: false }
    })
  );
  const delta = pairedDelta(probe.arm, frozen.arm);
  hypotheses.push({
    id: 'H4',
    hypothesis: '少量样本错误改选（低支持偏离）',
    change: '仅加门槛：偏离先验且 chosen.support < 2 时回退先验',
    minimalContrast: '同池同 seed；唯一变化是偏离的最小支持门槛',
    verifiedRate: probe.arm.verifiedRate,
    deltaVsFrozen: delta.meanDelta,
    minObservedDeviationSupport: minObserved,
    deviationCount: observedSupports.length,
    verdict:
      delta.meanDelta > reproduction.meanDelta + 0.05
        ? 'supports: 门槛挡住了低支持偏离后负收益收窄，少样本错误改选是促成因素之一（假设，非已确认根因）'
        : 'cannot-exclude: 最低门槛没有收窄负收益（或本套偏离的支持都不低于门槛），少样本改选不是主因',
    note: '判别证据同时在决策级台账：偏离决策的 support 分布'
  });
}

// H5 fixed-pool schedule favours the prior ceiling: the historical schedule
// offers the round-0 pool at every decision ('static'), removing the
// schedule's alignment with the prior deepening order.
{
  const probe = await runFairEngineWithLedger(
    baseOptions(fairArm('C3-online'), {
      diagnostics: { poolSchedule: 'static' }
    })
  );
  const delta = pairedDelta(probe.arm, frozen.arm);
  hypotheses.push({
    id: 'H5',
    hypothesis: 'fixed-pool schedule 对 prior 天花板偏好',
    change: '仅改池调度：prefs.slice(0, round) 谱系调度 -> 每个决策点都提供 round-0 池',
    minimalContrast: '同池构造规则同 seed；唯一变化是各轮的池内容',
    verifiedRate: probe.arm.verifiedRate,
    deltaVsFrozen: delta.meanDelta,
    verdict:
      delta.meanDelta > reproduction.meanDelta + 0.05
        ? 'supports: 调度改变后负收益收窄，谱系调度与先验偏好的耦合是促成因素之一（假设，非已确认根因）'
        : 'cannot-exclude: 池调度不是负收益主因',
    note: '冻结臂在该调度下同样只走先验，因此两臂差值仍只含经验更新的作用'
  });
}

// H6 replay vs production path difference: the fair replay calls
// runDecisionKernel directly with an in-memory store, while production routes
// through the orchestrator's recordOnlineExperience (r3 yardstick,
// estimatorTargetLine). This probe is a DOCUMENTED STRUCTURAL CHECK, not an
// arm: it reports the recorded differences (version stamps, filter flags,
// attribution) and marks the runtime-behaviour part not-run on this offline
// synthetic suite.
{
  const mixedVersions = new Set(
    online.decisionLedger.flatMap((entry) => entry.neighborVersions)
  );
  hypotheses.push({
    id: 'H6',
    hypothesis: '回放与生产路径差异',
    change: '结构性核对（非对照臂）：公平重放直接调用 runDecisionKernel + 内存 store；生产路径经 orchestrator.recordOnlineExperience（r3 标尺 + estimatorTargetLine + learning filter 显式接线）',
    minimalContrast: '核对两侧的 rewardVersion 戳、learning-filter 标志、归因字段与写入字段',
    observedDifferences: [
      '重放快照 per-task 冷启动且因果截断 before=clock()；生产快照为宿主会话当前快照',
      '重放记录 rewardVersion=CURRENT_REWARD_VERSION(r2/verifiable-v1)；生产新记录已切换 r3/unified-signals-v1（t6）——两侧库不可混估',
      '重放估算不经 estimatorTargetLine 日志面；生产每次 record 都 emit targetLine+rewardVersion（t6 接线）',
      '两侧共用同一 runDecisionKernel（PR5 复评已验证在线/replay 决策内核对齐至 1e-12，docs/reports/p61-review-round2-pr5.md）'
    ],
    ledgerNeighborVersions: [...mixedVersions],
    verdict: 'not-run (behavioural): 真实宿主行为差异需 Gate 4 受控 smoke；本轮只完成结构性核对，不把重放差值外推为生产结论',
    note: 'PR5 复评（t5）已把在线/replay 内核差异收口；本项剩余风险集中在奖励版本混估与宿主特有路径'
  });
}

// ---------------------------------------------------------------------------
// 5. offline counterfactual: synthetic full-candidate execution (separate)
// ---------------------------------------------------------------------------

/**
 * OFFLINE COUNTERFACTUAL (plan section 8.2, separately accounted): for the
 * FIRST harmful deviation, execute ALL pool candidates in a throwaway
 * synthetic replay to see what the unchosen candidates would have done.
 *
 * This is a SYNTHETIC-ENVIRONMENT construction, NOT a production observation
 * and NOT part of the fair-arm budget: it does not touch any fair arm's store,
 * it is not written into any experience record, and it must not be reported as
 * "the policy could have observed X" - it is an analyst-side diagnostic.
 */
async function offlineCounterfactual(event) {
  if (event === null) {
    return null;
  }
  const taskSpec = EVAL_TASKS.find((task) => task.id === event.task);
  if (taskSpec === undefined) {
    return null;
  }
  const pool = fairPoolForDecision(taskSpec, event.round);
  // The inherited coverage at that decision = what the prior lineage had
  // already mounted by round N (prefs.slice(0, round) schedule).
  const inherited = taskSpec.prefs.slice(0, event.round);
  const rows = pool.map((candidate) => {
    const total = [...new Set([...inherited, ...candidate.surfaces])];
    const coverage = taskSpec.required.filter((surface) => total.includes(surface)).length /
      Math.max(1, taskSpec.required.length);
    return {
      candidateIndex: candidate.index,
      actionKey: candidate.actionKey,
      priorConfidence: candidate.confidence,
      syntheticCoverageIfExecuted: round(coverage),
      syntheticVerifiedIfExecuted: coverage >= 1 - 1e-9
    };
  });
  return {
    account: 'offline-counterfactual (synthetic environment; NOT in the fair-arm budget; NOT a production observation)',
    anchor: { task: event.task, run: event.run, round: event.round },
    anchorObserved: {
      chosenActionKey: event.chosenActionKey,
      chosenObservedCoverage: event.chosenObservedCoverage,
      chosenObservedVerified: event.chosenObservedVerified,
      priorCoverageAtSameCoordinates: event.priorCoverageAtSameCoordinates
    },
    poolExecution: rows,
    boundary:
      '全候选执行只在合成表上成立；不进入公平臂预算，不写成生产已观测经验，不给未执行候选补 LLM 猜测 reward'
  };
}

const counterfactual = await offlineCounterfactual(firstHarmful);

// ---------------------------------------------------------------------------
// 6. improvement strategy gates (double gate, preregistered on the validation
//    split of this suite) - reported as GATES, not as adopted changes
// ---------------------------------------------------------------------------

/**
 * Preregistered gates (fixed BEFORE looking at probe outcomes, on the mig-01..04
 * validation family of the same suite, matching docs/reports/p6-fair-eval.md
 * section 8's split):
 *   benefit gate:  validatedRate - frozenRate >= +0.25 on the validation split
 *                  (must recoup the observed -0.250 with margin);
 *   safety gate:   no task's verifiedRate may DROP below its frozen value, and
 *                  the degraded-task share must not exceed the historical one.
 * A strategy that fails either gate stays a hypothesis probe, never a default.
 */
function gateCheck(probeArm, frozenArm) {
  const validationIds = ['mig-01', 'mig-02', 'mig-03', 'mig-04'];
  const pick = (arm, id) => arm.tasks.find((task) => task.taskId === id);
  const rows = validationIds.map((id) => {
    const online = pick(probeArm, id);
    const frozenTask = pick(frozenArm.arm, id);
    return {
      taskId: id,
      probe: online?.verifiedRate ?? 0,
      frozen: frozenTask?.verifiedRate ?? 0
    };
  });
  const probeMean = round(mean(rows.map((row) => row.probe)));
  const frozenMean = round(mean(rows.map((row) => row.frozen)));
  const benefit = round(probeMean - frozenMean);
  const anyTaskRegressed = rows.some((row) => row.probe < row.frozen - 1e-9);
  return {
    validationSplit: validationIds.join(','),
    preregisteredBenefitGate: 'validation 验证通过率 - frozen >= +0.25',
    preregisteredSafetyGate: '任何验证任务不得低于 frozen，且退化任务比例不得超过历史值',
    probeMean,
    frozenMean,
    benefitDelta: benefit,
    benefitGatePassed: benefit >= 0.25,
    safetyGatePassed: !anyTaskRegressed,
    conclusion:
      benefit >= 0.25 && !anyTaskRegressed
        ? 'both gates passed on this synthetic validation split (still not a production default)'
        : 'at least one gate failed: the strategy stays a probe, not a default'
  };
}

const strategyGates = {
  note:
    '改善策略双门槛（收益 + 安全）：只有解释原因之后才考虑最低有效支持/先验回退/KL 上限/受限 beta/验证集 shadow；门槛在验证集上预先固定',
  candidates: [
    { strategy: '最低有效支持门槛（H4 的门槛，正式化）', probe: 'H4' },
    { strategy: '先验回退（偏离后按 KL/支持度回退）', probe: 'not-run（先在 H4/H2/H3 中解释原因）' },
    { strategy: 'KL 上限（限制 z\' 偏离）', probe: 'not-run（需先有 H1 标尺重校准后的复跑基线）' },
    { strategy: '受限 beta（温度约束）', probe: 'not-run（同上）' },
    { strategy: '验证集 shadow（不发布，只记录）', probe: 'not-run（Gate 4 后）' }
  ],
  h4GateOnValidationSplit: null,
  boundary: '不重放训练集调参最优点当独立验证；小合成集不承诺统计显著性'
};

// Fill the H4 gate measurement (the only probe with a measured strategy).
{
  const probe = await runFairEngineWithLedger(
    baseOptions(fairArm('C3-online'), {
      diagnostics: { minSupportToDeviate: 2, ledger: false }
    })
  );
  strategyGates.h4GateOnValidationSplit = gateCheck(probe.arm, frozen);
}

// ---------------------------------------------------------------------------
// 7. assemble the machine-readable result
// ---------------------------------------------------------------------------

const result = {
  harness: 'dsh-plugin-evo-harness negative-result explanation (P6.1-E)',
  frame: {
    protocol: 'same-task (C3-online vs C3-frozen, same initial snapshot per task)',
    episodes: EPISODES,
    rounds: ROUNDS,
    seed: SEED,
    k: K,
    beta: BETA,
    similarityThreshold: THRESHOLD,
    taskCount: EVAL_TASKS.length,
    poolDigests: [0, 1, 2].map((roundIndex) => ({
      round: roundIndex,
      digest: fairFixedPoolDigest(EVAL_TASKS[0], roundIndex),
      note: 'pool of ci-01 shown as witness; every arm sees the same (task, round) pool'
    })),
    sourceReport: 'docs/reports/p6-fair-eval.md section 5'
  },
  reproduction: {
    meanDelta: reproduction.meanDelta,
    wins: reproduction.wins,
    ties: reproduction.ties,
    losses: reproduction.losses,
    historical: -0.25,
    matchesHistorical: Math.abs(reproduction.meanDelta - -0.25) < 0.05,
    degradation: profile,
    perTask: reproduction.rows
  },
  decisionLedger: {
    entries: online.decisionLedger.length,
    payloadFree: 'no prompt text, no patch content, no raw deliverable text; hashes, digests and kernel arithmetic only',
    fields: [
      'taskGroup', 'task', 'run', 'round', 'stateBucket', 'stateFingerprint',
      'candidatePoolDigest', 'actionKey', 'priorChoice', 'chosenChoice',
      'neighborIds', 'neighborVersions', 'similarity', 'weight', 'support',
      'q', 'v', 'advantage', 'adjustedLogit', 'kl', 'rewardModelVersion',
      'targetField', 'observedOutcome', 'observedReturn'
    ],
    sample: online.decisionLedger.slice(0, 4)
  },
  firstHarmfulDeviation: firstHarmful,
  deviationStats: {
    total: deviations.length,
    harmful: deviations.filter((event) => event.harmful).length,
    gateFired: online.decisionLedger.filter((entry) => entry.minSupportGateFired).length
  },
  minimalCounterexamples: counterexamples,
  hypotheses,
  offlineCounterfactual: counterfactual,
  improvementStrategyGates: strategyGates,
  boundaries: [
    '负结果是有效结果，不是算法原理失败的证明（ADR D4）',
    '所有判别都是假设检验，不是已确认根因；每一项都有最小对照',
    '离线 counterfactual 单独记账：不进入公平臂预算，不写成生产已观测经验',
    '真实任务只记录实际执行结果；不给未执行候选补 LLM 猜测 reward',
    '不重放训练集调参最优点当独立验证；小合成集不承诺统计显著性',
    '报告退化任务比例与平均收益，不只挑总均值',
    '合成任务集结论不能外推为生产收益（需 Gate 4 真实宿主受控 smoke）'
  ]
};

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

function renderHuman(data) {
  const lines = [];
  lines.push('P6.1-E negative-result explanation (decision-level)');
  lines.push('');
  lines.push('frame: C3-online vs C3-frozen, same-task protocol, episodes=' + data.frame.episodes + ' rounds=' + data.frame.rounds + ' seed=' + data.frame.seed);
  lines.push('reproduction: meanDelta=' + data.reproduction.meanDelta + ' (historical -0.250, matches=' + data.reproduction.matchesHistorical + ')');
  lines.push('  wins/ties/losses: ' + data.reproduction.wins + '/' + data.reproduction.ties + '/' + data.reproduction.losses);
  lines.push('  degraded tasks: ' + data.reproduction.degradation.degradedTaskShare + ' (' + data.reproduction.degradation.degradedTasks.join(', ') + ')');
  lines.push('  mean loss when degraded: ' + data.reproduction.degradation.meanLossWhenDegraded + '; mean gain when improved: ' + data.reproduction.degradation.meanGainWhenImproved);
  lines.push('');
  lines.push('decision ledger: ' + data.decisionLedger.entries + ' entries (payload-free)');
  const first = data.firstHarmfulDeviation;
  if (first === null) {
    lines.push('first harmful deviation: none found (every deviation matched or beat the prior outcome)');
  } else {
    lines.push('first harmful deviation: ' + first.key);
    lines.push('  prior ' + first.priorActionKey + ' (idx ' + first.priorChoice + ', prior coverage at same coordinates ' + first.priorCoverageAtSameCoordinates + ')');
    lines.push('  chose ' + first.chosenActionKey + ' (idx ' + first.chosenChoice + ') support=' + first.support + ' Q=' + first.q + ' V=' + first.v + ' A=' + first.advantage + " z'=" + first.adjustedLogit + ' KL=' + first.kl);
    lines.push('  observed outcome=' + first.chosenObservedOutcome + ' return=' + first.chosenObservedReturn + ' coverage=' + first.chosenObservedCoverage + ' verified=' + first.chosenObservedVerified);
    lines.push('  neighborVersions=' + first.neighborVersions.join(',') + ' targetField=' + first.targetField);
  }
  lines.push('');
  lines.push('deviations: ' + data.deviationStats.total + ' total, ' + data.deviationStats.harmful + ' harmful');
  lines.push('');
  lines.push('hypotheses (one change at a time):');
  for (const h of data.hypotheses) {
    lines.push('  ' + h.id + ' ' + h.hypothesis);
    lines.push('    change: ' + h.change);
    if (h.verifiedRate !== undefined) {
      lines.push('    verifiedRate=' + h.verifiedRate + ' deltaVsFrozen=' + h.deltaVsFrozen + ' verdict=' + h.verdict);
    } else {
      lines.push('    verdict=' + h.verdict);
    }
  }
  lines.push('');
  lines.push('minimal counterexamples: ' + data.minimalCounterexamples.length + ' failed task(s)');
  lines.push('offline counterfactual: ' + (data.offlineCounterfactual === null ? 'no harmful anchor' : data.offlineCounterfactual.account));
  lines.push('strategy gates: ' + (data.improvementStrategyGates.h4GateOnValidationSplit?.conclusion ?? 'not measured'));
  return lines.join('\n');
}

const json = process.argv.includes('--json');
const assertMode = process.argv.includes('--assert');

// The A1..A6 rules live in ./lib/negative-result-assertions.mjs (imported above)
// so they can be unit-tested against mutated copies of this result.

if (assertMode) {
  const { ok, failures } = evaluateAssertions(result);
  if (json) {
    console.log(JSON.stringify({ ...result, assertions: { ok, failures } }, null, 2));
  } else {
    console.log(renderHuman(result));
    console.log('');
    console.log('assertions (PR-1):');
    if (ok) {
      console.log('  A1..A6 PASS - the historical negative result is intact');
    } else {
      for (const failure of failures) {
        console.log('  FAIL ' + failure);
      }
    }
  }
  if (!ok) {
    process.exitCode = 1;
  }
} else if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(renderHuman(result));
}
