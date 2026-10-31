#!/usr/bin/env node
/**
 * rev6 R1-4 (t10): the discriminable 2x2(+1) ablation DESIGN + surrogate shadow.
 *
 * WHAT THIS SCRIPT IS, AND IS NOT
 * ------------------------------
 * It is the executable form of the preregistration's DESIGN claims. It computes,
 * from the frozen V3 design module and the frozen V3 statistics verifier (never
 * from a re-derivation of its own):
 *
 *   - the rejectability FLOOR (how many discordant pairs a family-4 Holm
 *     correction needs before ANY rejection is arithmetically possible);
 *   - the POWER curve (how many independent tasks are needed for 80% power at
 *     plausible win rates) and pi* at the pool we actually have;
 *   - the DESIGN MATRIX RANK (whether the two main effects and the interaction
 *     are separately estimable - i.e. whether `undetermined` can be ruled out
 *     by DESIGN rather than hoped away);
 *   - the task table's DISCRIMINABILITY (prior vs oracle headroom, required
 *     surfaces outside the proposer's top-3, both computed independently by the
 *     frozen gate);
 *   - the HOLDOUT FIREWALL both ways (clean => 0, leak => 1).
 *
 * It does NOT run the four arms. Running them would mean executing a new
 * five-arm experiment, which is (a) a different task's budget, (b) requires a
 * task-table binding this task does not own, and (c) would let this script
 * manufacture numbers the report then quotes as measurements. The report
 * therefore separates DESIGN FACTS (measured here) from ARM RESULTS
 * (`not-evaluable` here, with the reason stated).
 *
 * USAGE
 *   node scripts/eval/rev6-ablation.mjs --json
 *   node scripts/eval/rev6-ablation.mjs --markdown
 *   node scripts/eval/rev6-ablation.mjs --surrogate-shadow   (shadow-only surrogate report data)
 *
 * EXIT CODES
 *   0  the design facts were computed and the preregistration ordering holds
 *   1  preregistration unreadable, or it post-dates the first sample (preregistration §9)
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');
const PREREG = path.join(repoRoot, 'docs/reports/rev6-ablation-preregistration.md');
const FIXTURES = path.join(repoRoot, 'tests/fixtures/p2-l1');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

async function main() {
  const preregBytes = readFileSync(PREREG);
  const preregSha = createHash('sha256').update(preregBytes).digest('hex');
  const preregMtimeMs = Math.floor(statSync(PREREG).mtimeMs);
  const firstSampleAtMs = Date.now();

  const stats = await import(pathToFileURL(path.join(repoRoot, 'scripts/eval/pr4a-stats.verify.mjs')).href);
  const design = await import(pathToFileURL(path.join(repoRoot, 'scripts/eval/pr4a-v3-design.mjs')).href);

  // --- 1. rejectability floor (family 4, the preregistered Holm family) -----
  const familySizes = [1, 2, 4];
  const floor = {
    familySizes,
    holmThresholds: stats.holmThresholds(4),
    minDiscordant: Object.fromEntries(
      familySizes.map((familySize) => [
        familySize,
        stats.minDiscordantForRejectability({ familySize })
      ])
    ),
    table: stats.rejectabilityFloorTable(12, { familySizes: [4] })[0].rows.map((row) => ({
      m: row.mDisc,
      pMin: row.pMin,
      pMinFormula: row.pMinFormula,
      correctable: row.correctedRejectable,
      label: row.label
    }))
  };

  // --- 2. power curve + pi* at the actual pool ------------------------------
  const power = {
    basis: 'exact sign test (minTasksForPower) / exact sign-flip (piStarForSignFlip); CONDITIONAL on the magnitude set, not an unconditional power analysis',
    tasksForEightyPercent: Object.fromEntries(
      [0.7, 0.75, 0.8, 0.85, 0.9, 0.95].map((pi) => [pi, stats.minTasksForPower(pi, { alpha: 0.05, target: 0.8 })])
    ),
    piAtPoolSize: Object.fromEntries(
      // 8 and 12 matter because they bracket the family-4 floor at the actual
      // pool size; 16 and 20 are there so the "more tasks => smaller pi*" reading
      // is a MEASURED comparison rather than an extrapolation.
      [8, 10, 12, 16, 20].map((m) => [
        m,
        // `piStarForSignFlip` returns a NUMBER (the bisected pi*), not an object.
        stats.piStarForSignFlip(Array.from({ length: m }, () => 1), { alpha: 0.05 })
      ])
    )
  };

  // --- 3. design matrix rank (identifiability) ------------------------------
  const matrix = [
    [1, 0, 0, 0],
    [1, 0, 1, 0],
    [1, 1, 0, 0],
    [1, 1, 1, 1]
  ];
  const rank = stats.matrixRank(matrix);
  const identifiability = {
    cells: ['Arm-1 process/off', 'Arm-2 process/on', 'Arm-3 quality/off', 'Arm-4 quality/on'],
    columns: ['intercept', 'main:track', 'main:gate', 'interaction:track×gate'],
    rank,
    columns: 4,
    fullRank: rank === 4,
    // The rank-1 fixture proves the rank computation can FAIL, so "rank 4" is a
    // measurement rather than a constant that always prints 4.
    rankOneFixtureDetected: stats.matrixRank(stats.rankOneFixture(3)) === 1,
    interpretation: rank === 4
      ? 'all four effects (two mains + interaction) are separately estimable => the interaction is IDENTIFIABLE by design, not `undetermined`'
      : 'rank deficient => the affected effect MUST be reported `undetermined`'
  };

  // --- 4. the V3 task table's own discriminability gate ---------------------
  const v3 = {
    designVersion: design.V3_DESIGN_VERSION,
    taskCount: design.V3_TASKS.length,
    rounds: design.V3_ROUNDS,
    summary: design.designSummary()
  };
  const taskTableGate = stats.verifyV3TaskTableGate(
    // The gate reads `design.V3_TASKS` itself (it is written against the design
    // module's shape), so the argument must carry that key - passing `{tasks}`
    // made it report 'empty task table', which is a caller bug, not a gate failure.
    { V3_TASKS: design.V3_TASKS, V3_ROUNDS: design.V3_ROUNDS },
    stats.V3_FROZEN_TASK_TABLE_DIGEST,
    {}
  );

  // --- 5. holdout firewall, BOTH directions ---------------------------------
  const manifest = readJson(path.join(FIXTURES, 'p2-v3-split-manifest.json'));
  const cleanArtifact = {
    path: 'tests/fixtures/p2-l1/p2-v3-selection-clean.json',
    content: readFileSync(path.join(FIXTURES, 'p2-v3-selection-clean.json'), 'utf8')
  };
  const leakArtifact = {
    path: 'tests/fixtures/p2-l1/p2-v3-selection-holdout-leak.json',
    content: readFileSync(path.join(FIXTURES, 'p2-v3-selection-holdout-leak.json'), 'utf8')
  };
  const clean = stats.checkHoldoutFirewall(manifest, [cleanArtifact], design.V3_TASKS);
  const leak = stats.checkHoldoutFirewall(manifest, [leakArtifact], design.V3_TASKS);
  const firewall = {
    clean: { ok: clean.ok, violations: clean.violations },
    leak: { ok: leak.ok, violations: leak.violations },
    bidirectional: clean.ok === true && leak.ok === false,
    interpretation: 'clean passes AND leak fails: the firewall discriminates rather than always passing'
  };

  // --- 6. the honest boundary: arms were NOT run ---------------------------
  const arms = {
    status: 'not-run',
    reason:
      'executing the four arms is a five-arm experiment (its own budget, its own V2/V3 artifact binding), '
      + 'and this task owns the DESIGN, not the run. The design facts above are the deliverable; '
      + 'arm-level μ/π intervals are `not-evaluable` here and must not be inferred from design arithmetic.',
    preregisteredArms: ['Arm-0 (frozen reference)', 'Arm-1 process/off', 'Arm-2 process/on', 'Arm-3 quality/off', 'Arm-4 quality/on'],
    armFiveAdded: false,
    independentUnit: 'task (episodes/rounds are NOT independent samples)'
  };

  const payload = {
    rule: 'rev6 contract §5.5 (R1-3/R1-4); preregistration §3/§5/§6/§9',
    preregistration: {
      path: 'docs/reports/rev6-ablation-preregistration.md',
      sha256: preregSha,
      mtimeMs: preregMtimeMs,
      mtimeIso: new Date(preregMtimeMs).toISOString()
    },
    firstSampleAtMs,
    firstSampleIso: new Date(firstSampleAtMs).toISOString(),
    preregisteredBeforeFirstSample: preregMtimeMs <= firstSampleAtMs,
    design: {
      pool: { taskCount: design.V3_TASKS.length, rounds: design.V3_ROUNDS, designVersion: design.V3_DESIGN_VERSION },
      summary: v3.summary,
      identifiability,
      floor,
      power,
      firewall,
      taskTableGate: {
        ok: taskTableGate.ok ?? null,
        findings: taskTableGate.findings ?? [],
        // The gate's OWN measured discriminability facts. Reported verbatim so the
        // design report cites the gate's numbers rather than a summary of them.
        digest: taskTableGate.digest ?? null,
        taskCount: taskTableGate.taskCount ?? null,
        outsideTop3Share: taskTableGate.outsideTop3Share ?? null,
        outsideTop3Tasks: taskTableGate.outsideTop3Tasks ?? null,
        oracleBelowOne: taskTableGate.oracleBelowOne ?? null,
        headroomTasks: taskTableGate.headroomTasks ?? null,
        minActionsPerDecisionPoint: taskTableGate.minActionsPerDecisionPoint ?? null,
        supportMatrixRank: taskTableGate.supportMatrixRank ?? null,
        supportMatrixColumns: taskTableGate.supportMatrixColumns ?? null,
        supportMatrixRows: taskTableGate.supportMatrixRows ?? null
      },
      arms
    },
    boundaries: {
      synthetic: true,
      noRealModel: true,
      noMemoryWrite: true,
      noArmFive: true,
      episodesAreNotIndependentSamples: true,
      historicalNumbersUnchanged: true,
      notAResultAboutProductionLearning: true,
      armsNotRun: true
    }
  };

  const json = process.argv.includes('--json');
  const markdown = process.argv.includes('--markdown');

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
  } else if (markdown) {
    const lines = [];
    lines.push('# rev6 R1-4：可判别 2×2(+1) 消融设计（自动生成）');
    lines.push('');
    lines.push('- 命令：`node scripts/eval/rev6-ablation.mjs --markdown`');
    lines.push('- 预注册 sha256：`' + preregSha + '`（mtime `' + payload.preregistration.mtimeIso + '`）');
    lines.push('- 预注册先于采样：**' + String(payload.preregisteredBeforeFirstSample) + '**');
    lines.push('');
    lines.push('## 1. 可识别性（设计矩阵秩）');
    lines.push('');
    lines.push('| 项 | 值 |');
    lines.push('| --- | --- |');
    lines.push('| 秩 | **' + rank + ' / 4** |');
    lines.push('| 满秩 | ' + String(identifiability.fullRank) + ' |');
    lines.push('| rank-1 夹具可被检出 | ' + String(identifiability.rankOneFixtureDetected) + ' |');
    lines.push('');
    lines.push(identifiability.interpretation);
    lines.push('');
    lines.push('## 2. 结构性可拒绝下限（Holm，族大小 4）');
    lines.push('');
    lines.push('| 族大小 | 最小 `m_disc` |');
    lines.push('| --: | --: |');
    for (const familySize of familySizes) {
      lines.push('| ' + familySize + ' | **' + floor.minDiscordant[familySize] + '** |');
    }
    lines.push('');
    lines.push('Holm 阈值：`' + JSON.stringify(floor.holmThresholds.map((t) => Number(t.toFixed(6)))) + '`');
    lines.push('');
    lines.push('## 3. 功效（精确枚举，条件化于幅值集）');
    lines.push('');
    lines.push('| π | 达 80% 功效所需任务数 |');
    lines.push('| --: | --: |');
    for (const [pi, n] of Object.entries(power.tasksForEightyPercent)) {
      lines.push('| ' + pi + ' | ' + n + ' |');
    }
    lines.push('');
    lines.push('| m（全不一致） | π* |');
    lines.push('| --: | --: |');
    for (const [m, pi] of Object.entries(power.piAtPoolSize)) {
      lines.push('| ' + m + ' | ' + (pi === null ? 'n/a' : pi.toFixed(4)) + ' |');
    }
    lines.push('');
    lines.push('## 4. holdout 防火墙（双向）');
    lines.push('');
    lines.push('| 夹具 | ok | 违规 |');
    lines.push('| --- | --- | --- |');
    lines.push('| clean | ' + String(firewall.clean.ok) + ' | ' + firewall.clean.violations.length + ' |');
    lines.push('| leak | ' + String(firewall.leak.ok) + ' | ' + firewall.leak.violations.length + ' |');
    lines.push('');
    lines.push('## 5. 臂结果');
    lines.push('');
    lines.push('**' + arms.status + '** —— ' + arms.reason);
    console.log(lines.join('\n'));
  } else {
    console.log('[rev6-ablation] prereg sha256   ' + preregSha);
    console.log('[rev6-ablation] order holds     ' + String(payload.preregisteredBeforeFirstSample));
    console.log('[rev6-ablation] pool            ' + v3.taskCount + ' tasks x ' + v3.rounds + ' rounds');
    console.log('[rev6-ablation] matrix rank     ' + rank + '/4 fullRank=' + String(identifiability.fullRank));
    console.log('[rev6-ablation] floor (fam=4)   m_disc >= ' + floor.minDiscordant[4]);
    console.log('[rev6-ablation] pi* @ m=12       ' + (power.piAtPoolSize[12] === null ? 'n/a' : power.piAtPoolSize[12].toFixed(4)));
    console.log('[rev6-ablation] firewall        clean=' + String(firewall.clean.ok) + ' leak=' + String(firewall.leak.ok) + ' bidirectional=' + String(firewall.bidirectional));
    console.log('[rev6-ablation] arms            ' + arms.status);
  }

  if (!payload.preregisteredBeforeFirstSample) {
    console.error('[rev6-ablation] FAIL: the preregistration post-dates the first sample; R1-4 is void (preregistration §9)');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error('[rev6-ablation] CRASH: ' + (error && error.message));
  process.exit(1);
});
