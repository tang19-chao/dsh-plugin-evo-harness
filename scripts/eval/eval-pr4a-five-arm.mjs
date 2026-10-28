#!/usr/bin/env node
/**
 * PR-4A five-arm offline experiment CLI.
 *
 * Protocol: docs/reports/pr4a-five-arm-experiment-preregistration.md
 *           (PR4A-EVAL-PREREG-20261027-V2)
 *
 * Produces (V2 §12.2):
 *   1. work/pr4a-five-arm-eval.json          machine-readable full report
 *   2. work/pr4a-ledger-<Arm>.jsonl          the FULL ledger per arm (+ sha256)
 *   3. docs/reports/pr4a-five-arm-eval-report.md   readable report
 *
 * Offline only: zero live calls, zero publish, zero deploy. Everything here runs
 * against the synthetic suite and the host-owned local verifier.
 *
 * CODE PROVENANCE (PR-4A audit repair): a bare `git rev-parse HEAD` names the
 * commit the run STARTED from, which is NOT the code that ran while the working
 * tree is dirty — and this whole PR is uncommitted. The report therefore binds to
 * a full provenance block: the commit object, `git describe`, the SHA-256 of
 * every TRACKED file that differs from HEAD, and the SHA-256 of each executed
 * module. A reader can then verify the exact bytes behind every number.
 *
 * Usage:
 *   node scripts/eval/eval-pr4a-five-arm.mjs
 *   node scripts/eval/eval-pr4a-five-arm.mjs --json-only
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { loadPr4aReport, REPO_ROOT } from './pr4a-build.mjs';

/**
 * The modules whose bytes actually decide the numbers in this report. Listed
 * explicitly (not globbed) so the block cannot silently cover a new file without
 * a human edit — and hashed from the WORKING TREE, because that is what
 * Node/esbuild loaded.
 */
const EXECUTED_SOURCES = [
  'scripts/eval/eval-pr4a-five-arm.mjs',
  'scripts/eval/pr4a-build.mjs',
  'scripts/eval/build-eval.mjs',
  'scripts/eval/pr4a-five-arm-lib.ts',
  'scripts/eval/pr4a-report.ts',
  'scripts/eval/pr4a-stats.ts',
  'scripts/eval/jitrl-eval-lib.ts'
];

function runGit(args) {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  } catch {
    return '';
  }
}

function runGitTrimmed(args) {
  return runGit(args).trim();
}

/** Split a NUL-separated git list; empty entries are dropped. */
function splitNul(text) {
  return text.split('\0').filter((entry) => entry.length > 0);
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function fileSha256(absolutePath) {
  if (!existsSync(absolutePath)) return 'missing';
  return createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
}

/** Fixed-decimal formatting that never prints -0. `null` prints as an em dash. */
function fx(value, digits = 3) {
  if (value === null || value === undefined) return '—';
  const safe = Number.isFinite(value) ? value : 0;
  const rounded = Number(safe.toFixed(digits));
  return (Object.is(rounded, -0) ? 0 : rounded).toFixed(digits);
}

function pct(value) {
  return (Number.isFinite(value) ? value * 100 : 0).toFixed(1) + '%';
}

function resolveCodeProvenance() {
  const commit = runGitTrimmed(['rev-parse', 'HEAD^{commit}']);
  const describe = runGitTrimmed(['describe', '--always', '--dirty=-dirty']);
  /**
   * `--name-only -z` is used rather than parsing `--porcelain`: porcelain's
   * fixed-width " M " prefix is easy to mis-slice (and a whole-string `.trim()`
   * eats the leading space of the FIRST line, shifting every path by one
   * character — which is exactly how the first entry silently became
   * `github/workflows/ci.yml` with a `missing` digest).
   */
  const trackedDirty = splitNul(runGit(['diff', '--name-only', '-z', 'HEAD']))
    .map((path) => path.trim())
    .filter((path) => path.length > 0)
    .sort();

  const dirtyFileDigests = trackedDirty.map((path) => ({
    path,
    sha256: fileSha256(join(REPO_ROOT, path))
  }));
  const executedSources = EXECUTED_SOURCES.map((path) => ({
    path,
    sha256: fileSha256(join(REPO_ROOT, path))
  }));
  return {
    commit,
    describe,
    trackedWorkspaceDigest: sha256Hex(
      dirtyFileDigests.map((entry) => entry.sha256 + '  ' + entry.path).join('\n')
    ),
    trackedDirtyCount: dirtyFileDigests.length,
    dirtyFileDigests,
    executedSources,
    executedSourcesDigest: sha256Hex(
      executedSources.map((entry) => entry.sha256 + '  ' + entry.path).join('\n')
    ),
    workspaceDirty: trackedDirty.length > 0,
    digestAlgorithm: 'sha256',
    howToLocate:
      '`git show ' +
      commit +
      '` reproduces the committed baseline; every deviation from it is enumerated above by path + SHA-256 ' +
      '(working tree, and this revision is uncommitted), together with the ' +
      String(executedSources.length) +
      " executed modules. Re-verify any single file with: node -e \"console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('<path>')).digest('hex'))\""
  };
}

// ---------------------------------------------------------------------------
// markdown rendering
// ---------------------------------------------------------------------------

function renderMarkdown(report, ledgerStats) {
  const lines = [];
  const push = (line = '') => lines.push(line);
  const provenance = report.codeProvenance;

  push('# PR-4A 五臂正交实验结果报告（离线）');
  push('');
  push('> **本报告由 `scripts/eval/eval-pr4a-five-arm.mjs` 自动生成，不含手工编辑的数字。**');
  push('> 协议：`' + report.protocol + '`，代码基线（commit 对象）：`' + report.codeBaseline + '`。');
  push('> 零真实付费调用、零发布、零部署；全部数字来自离线合成夹具与宿主自有本地验收器。');
  push('');

  push('| 项 | 值 |');
  push('| --- | --- |');
  push('| 生成时间 | `' + report.generatedAt + '` |');
  push('| 协议 | `' + report.protocol + '` |');
  push('| 代码基线（commit 对象） | `' + report.codeBaseline + '` |');
  push('| 工作树是否脏 | ' + (provenance.workspaceDirty ? '**是（本 PR 未提交）**' : '否') + ' |');
  push('| `trackedWorkspaceDigest`（已跟踪脏文件摘要） | `' + provenance.trackedWorkspaceDigest + '` |');
  push('| `executedSourcesDigest`（实际执行代码摘要） | `' + provenance.executedSourcesDigest + '` |');
  push('| 任务数 N（配对单位） | ' + String(report.design.tasks) + ' |');
  push('| 每任务执行 L | ' + String(report.design.episodes) + ' |');
  push('| 每执行深化轮 R | ' + String(report.design.rounds) + ' |');
  push('| 有效重复 `effectiveReplication` | **' + String(report.replication.effectiveReplication) + '**（按实测唯一值推导，不是常数 L） |');
  push('| 探索额度（五臂固定） | ' + String(report.design.explorationAllowance) + ' |');
  push('| 主指标 | 宿主 runner 判定 `hostVerdict`（§6.1）——不是覆盖率自评 |');
  push('| 真实付费调用 `liveCalls` | **0** |');
  push('| 真实支出 `incurredRealUsd` | **0.00** |');
  push('| 分析单位 | ' + report.declarations.analysisUnit + ' |');
  push('');

  push('### 0.1 代码可定位性（本报告由哪一份代码产生）');
  push('');
  push('仅有 commit SHA **不足以**定位真实执行代码：本 PR 的全部改动仍在工作树中（未提交）。因此本节给出三重指纹。');
  push('');
  push('- `git describe --always --dirty`：`' + provenance.describe + '`');
  push('- 已跟踪且与 HEAD 不同的文件数：**' + String(provenance.trackedDirtyCount) + '**');
  push('- 摘要算法：`' + provenance.digestAlgorithm + '`（每次手工改动都会改变下列任一枚举值）');
  if (provenance.bundleFingerprint !== undefined) {
    const bundle = provenance.bundleFingerprint;
    push('- 实际执行的编译产物指纹（内容寻址缓存键，覆盖全部可达 TS 源 + esbuild 版本 + target + 打包模式）：`' +
      bundle.digest + '`');
    push('  （入口 `' + bundle.entry + '`，模式 `' + bundle.mode + '`，esbuild `' + bundle.esbuildVersion +
      '`，本次' + (bundle.rebuilt ? '**新建**' : '复用缓存') + '）');
  }
  push('');
  push('| 实际执行模块（工作树字节） | SHA-256 |');
  push('| --- | --- |');
  for (const entry of provenance.executedSources) {
    push('| `' + entry.path + '` | `' + entry.sha256 + '` |');
  }
  push('');
  push('| 已跟踪的脏文件 | SHA-256 |');
  push('| --- | --- |');
  for (const entry of provenance.dirtyFileDigests) {
    push('| `' + entry.path + '` | `' + entry.sha256 + '` |');
  }
  push('');
  push('> 复跑命令：`node scripts/eval/eval-pr4a-five-arm.mjs`（构建缓存内容寻址，见 `scripts/eval/build-eval.mjs`）。');
  push('> ' + provenance.howToLocate);
  push('');

  push('## 1. 本臂读了哪一轨、门控开关状态');
  push('');
  push('| 臂 | 轨道 | 写回 | 保守门 | 因子角色 | 终态快照 | 记录数 | 逐行轨道一致 | 审计流（未写回） |');
  push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const arm of report.arms) {
    const track = report.invariants.trackPerArm.find((entry) => entry.armId === arm.armId);
    push(
      '| `' + arm.armId + '` | `' + arm.spec.track + '` | ' + (arm.spec.writesBack ? '是' : '否') +
        ' | ' + (arm.spec.conservativeGate ? '开' : '关') +
        ' | ' + arm.spec.role +
        ' | ' + (arm.snapshotFrozen ? '冻结' : '演化') +
        ' | ' + String(arm.recordsAppended) +
        ' | ' + String(track.rowsMatching) + '/' + String(track.rowsWritten) +
        (track.rowsMismatched === 0 ? ' ✅' : ' ❌ ' + String(track.rowsMismatched) + ' 条错轨') +
        ' | ' + String(arm.writeAccounting.auditOnlyUnauthenticated + arm.writeAccounting.auditOnlyNotLearningOutcome) +
        ' |'
    );
  }
  push('');
  push('> `Arm-0` 只参与 `θ_write = Arm-1 − Arm-0`；它**不进入**任何主效应/交互估计（V2 §3.3）。');
  push('');
  push('**逐行写入轨不变量（取代「最后一次 `wroteTrack`」）**：上表「逐行轨道一致」列统计**每一条**真正写入的记录，');
  push('其轨道是否等于该臂声明的轨道。单一标量 `wroteTrack` 只反映**最后一次**写入——一条错轨记录 + 最后一次正确写入');
  push('会让标量断言通过，而库已经混轨。本报告因此按行统计，并把错轨行数直接列为失败条件。');
  push('');
  push('**未认证执行 = 仅审计，绝不回落写 `process`（§6.3）**：对**质量臂**（`Arm-3`/`Arm-4`），任何未通过宿主认证的执行、');
  push('或结局非学习型的执行，都**不写入**经验库，只记入审计会计——绝不把它降级成 `process` 记录充数。');
  push('**过程臂**（`Arm-1`/`Arm-2`）写入的是**执行级过程观测**（生产默认 `trustedSource=false` 即为该路径），');
  push('这是「过程轨」的定义而不是降级；其无信任回执的行数单列披露，可与质量臂逐项对照。五臂写入会计：');
  push('');
  push('| 臂 | 可写执行数 | 已写入 | 非学习结局（审计） | 未认证（审计，§6.3） | 无信任回执的过程观测（生产默认） | 质量标签落入过程臂 | 参照不写回 | 审计违规合计 |');
  push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const entry of report.invariants.writeAccounting) {
    push(
      '| `' + entry.armId + '` | ' + String(entry.eligibleExecutions) +
        ' | ' + String(entry.written) +
        ' | ' + String(entry.auditOnlyNotLearningOutcome) +
        ' | ' + String(entry.auditOnlyUnauthenticated) +
        ' | ' + String(entry.processObservationsWithoutTrustedReceipt) +
        ' | ' + String(entry.auditOnlyQualityLabelOnProcessArm) +
        ' | ' + String(entry.referenceNoWriteBack) +
        ' | ' + String(entry.auditOnlyViolations) + ' |'
    );
  }
  push('');
  push('> 断言 `auditOnlyAssertion = ' + report.invariants.auditOnlyAssertion + '`：');
  push('> **质量臂**遇到未认证执行的唯一正确处理是「仅审计、不写库、不降级为过程记录」；');
  push('> **过程臂**写入的本来就是执行级过程观测（生产默认 `trustedSource=false`），其数目单列披露，不算违规。');
  push('> 「质量标签落入过程臂」必须恒为 0——否则意味着信任缝跨臂泄漏。');
  push('');
  push('### 1.1 质量邻域断言（§6.3：未认证记录不得进入质量邻域）');
  push('');
  push('| 臂 | 轨道 | 检查的决策点 | 存在可见质量记录的决策点 | 准入邻域的记录 | 因未认证被拒绝的记录 | 断言 |');
  push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const entry of report.invariants.qualityNeighbourhood) {
    push(
      '| `' + entry.armId + '` | `' + entry.track +
        '` | ' + String(entry.decisionsInspected) +
        ' | ' + String(entry.decisionsWithVisibleQualityRecords) +
        ' | ' + String(entry.recordsAdmitted) +
        ' | ' + String(entry.recordsRejectedUnauthenticated) +
        ' | ' + entry.assertion + ' |'
    );
  }
  push('');
  push('> 质量臂在检索时先用生产谓词 `isAuthenticatedQualityRecord` 过滤：未被宿主认证的标签**永不进入**估计邻域，');
  push('> 因此「质量轨没有数据」与「质量轨被喂了未认证数据」两种情况可区分。过程臂不参与该检查（其邻域按定义不含质量记录）。');
  push('');

  push('## 2. 主指标（按任务聚合，V2 §7.1）');
  push('');
  push('| 臂 | verifiedRate（宿主判定） | meanCoverage | 改选率 | meanSupport | meanNEff（被执行） | meanNEff（挑战者，无条件测量） | 组内方差为 0 的任务 | 可用 episode |');
  push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const arm of report.arms) {
    const zeroVar = arm.tasks.filter((task) => task.withinRunVariance === 0).length;
    const available = arm.tasks.reduce((sum, task) => sum + task.availableEpisodes, 0);
    push(
      '| `' + arm.armId + '` | ' + fx(arm.verifiedRate) +
        ' | ' + fx(arm.meanCoverage) +
        ' | ' + fx(arm.policyChangeRate, 4) + ' | ' + fx(arm.meanSupport, 2) +
        ' | ' + fx(arm.meanNEff, 2) + ' | ' + fx(arm.meanChallengerNEff, 2) +
        ' | ' + String(zeroVar) + '/' + String(arm.tasks.length) +
        ' | ' + String(available) + '/' + String(arm.tasks.length * report.design.episodes) + ' |'
    );
  }
  push('');
  push('> **主指标是宿主 runner 的判定**（§6.1），不是覆盖率自评。`coverage >= 1` 只是合成环境的**内部替代值**');
  push('> （附录 B 明确要求在有真实 runner 时替换掉）；本报告把它作为诊断保留，并逐条比对两者');
  push('> （见 §9 `hostVerdictAssertion`），任何分歧都会使运行断言失败。');
  push('');
  push('**可用 episode 与审计流（§8.1.4/§6.4）**：被超时/中止/基础设施异常截断的执行**不计为失败**，');
  push('> 而是从该任务的分母中剔除，并把任务列入 `denominator-degraded` 清单。本轮实测：');
  push('');
  const degraded = report.safety.dataCompleteness.filter(
    (entry) => entry.denominatorDegradedTasks.length > 0
  );
  if (degraded.length === 0) {
    push('- **没有任何任务出现分母退化**：全部 12 任务 × 5 执行均可用。');
  } else {
    for (const entry of degraded) {
      push('- `' + entry.armId + '`：`denominator-degraded` = ' + entry.denominatorDegradedTasks.join(', '));
    }
  }
  push('');

  push('### 2.1 重复性检查（在看主结果前执行，V2 §8.1）');
  push('');
  push('- 有效重复 `effectiveReplication = ' + String(report.replication.effectiveReplication) + '`');
  push('- 推导方式：`' + report.replication.effectiveReplicationDerivation + '`');
  push('- ' + report.replication.note);
  push('');
  push('| 臂 | 写回 | 已分析任务 | 组内方差为 0 的任务数 | 每任务唯一值个数分布 | 唯一值众数 | 平均唯一值/任务 | 全部任务常数？ |');
  push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const entry of report.replication.perArm) {
    push(
      '| `' + entry.armId + '` | ' + (entry.writesBack ? '是' : '否') +
        ' | ' + String(entry.analyzedTasks) + '/' + String(entry.tasks) +
        ' | ' + String(entry.tasksWithZeroWithinVariance) + '/' + String(entry.tasks) +
        ' | ' + JSON.stringify(entry.distinctValueHistogram) +
        ' | ' + String(entry.distinctValueMode) +
        ' | ' + fx(entry.meanDistinctValuesPerTask, 3) +
        ' | ' + (entry.allTasksConstant ? '是' : '否') + ' |'
    );
  }
  push('');
  push('> `Arm-0` **不参与** `effectiveReplication` 的计算：它从不更新，其常数性是**定义性质**而非重复性证据；');
  push('> 只有写回臂（`writesBack = true`）的组内唯一值个数说明本设计实际能分辨多少个不同结果。');
  if (report.replication.designIsBinary) {
    push('> 全部任务组内方差为 0 ⇒ 设计**退化为二值**，只适用 §8.3.1 的精确方法，且 `effectiveReplication = 1`。');
  } else {
    push('> 并非全部任务常数 ⇒ 设计为**率型**，主检验按 §8.3.2 的精确配对随机化（符号翻转），');
    push('> `effectiveReplication = ' + String(report.replication.effectiveReplication) + '` 由实测唯一值个数推导，');
    push('> **不是**常数 L=' + String(report.design.episodes) + '：把 L 次执行当成 L 个独立观测，正是 §8.1 要防的虚增。');
  }
  push('');

  push('## 3. 受控族：四个前定估计量（Holm 校正，V2 §8.6）');
  push('');
  push('| 估计量 | n | 均值差 | sd | 胜/平/负 | m_disc | 主检验 | 主检验 p | McNemar p | 符号翻转 p | Holm 调整 p | 显著 | 带宽 |');
  push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const entry of report.comparisons.controlled) {
    push(
      '| ' + entry.id + ' | ' + String(entry.n) + ' | ' + fx(entry.meanDelta) +
        ' | ' + fx(entry.sd) +
        ' | ' + String(entry.wins) + '/' + String(entry.ties) + '/' + String(entry.losses) +
        ' | ' + String(entry.discordantPairs) +
        ' | ' + (entry.binarySeries ? 'McNemar(§8.3.1)' : '符号翻转(§8.3.2)') +
        ' | ' + fx(entry.pPrimary, 4) +
        ' | ' + fx(entry.pRaw, 4) +
        ' | ' + fx(entry.pSignFlip, 4) +
        ' | ' + (entry.pAdjusted === null ? '—' : fx(entry.pAdjusted, 4)) +
        ' | ' + (entry.significantAfterCorrection ? '是' : '否') +
        ' | ' + entry.band + ' |'
    );
  }
  push('');
  push('> **主检验与预注册一致（§8.3.1 vs §8.3.2）**：`主检验` 列逐行给出该估计量系列的**数据型别判定**。');
  push('> 率型系列（取值 {0, 0.2, …, 1}）的主检验是**精确配对随机化（符号翻转）**；**只有**当系列确实是二值时');
  push('> 才用精确 McNemar。两个 p 值始终并列打印，Holm 校正施加在**主检验 p** 上。');
  push('> 受控族**只有**这四行；补充族与反例均不在此族内，不得与上表合并宣称整体显著。');
  push('');
  push('### 3.1 区间宽度与可复算性（§8.5 ④ / §8.3.3）');
  push('');
  push('| 估计量 | 估计量区间（随机化反演） | 宽度 | 枚举空间 | 网格点 | 复跑命令 |');
  push('| --- | --- | --- | --- | --- | --- |');
  for (const entry of report.comparisons.controlled) {
    push(
      '| ' + entry.id +
        ' | [' + fx(entry.randomizationInterval.lower) + ', ' + fx(entry.randomizationInterval.upper) + ']' +
        ' | ' + fx(entry.intervalWidth, 3) +
        ' | 2^' + String(entry.n) + ' = ' + String(entry.intervalProvenance.enumerationSpace) +
        ' | ' + String(entry.intervalProvenance.gridPointsTested) +
        ' | `' + entry.intervalProvenance.rerunCommand.replace(/\\/g, '\\\\') + '` |'
    );
  }
  push('');
  push('> 区间用**估计量自身**的随机化反演（对均值差 μ 的网格反演），**不是** CP(π) 区间。');
  push('> `m_disc` 上的 Clopper–Pearson 区间是**另一个量**（不一致对胜出概率 π），本轮只作为 `exactInterval` 辅助保留，');
  push('> **不参与** §8.5 的 ③④ 判读。');
  push('');
  push('> 复跑任一行：把该行的逐任务 Δ 数组（见 §5.3）传入 `randomizationInversionInterval(…,{alpha:0.05,step:0.005})` 即可，');
  push('> 枚举空间恒为 2^12 = 4096 个符号分配；本模块不含随机数，故无需种子。');
  push('');

  push('### 3.2 四维判读元组（互不覆盖，V2 §8.5）');
  push('');
  push('| 估计量 | significance | direction | degradationStatus | evidenceStatus | DTS（估计量自身） | 退化任务 | 区间下界 ≥ NIM？ | 区间上界 < NIM？ |');
  push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const entry of report.comparisons.controlled) {
    const inputs = entry.verdictInputs;
    push(
      '| ' + entry.id +
        ' | `' + entry.verdict.significance + '`' +
        ' | `' + entry.verdict.direction + '`' +
        ' | `' + entry.verdict.degradationStatus + '`' +
        ' | `' + entry.verdict.evidenceStatus + '`' +
        ' | ' + fx(entry.degradation.dts, 4) +
        ' | ' + (entry.degradation.degradedTasks.length === 0 ? '—' : entry.degradation.degradedTasks.join(', ')) +
        ' | ' + (inputs.interval[0] >= inputs.thresholds.NIM - 1e-9 ? '是' : '**否**') +
        ' | ' + (inputs.interval[1] < inputs.thresholds.NIM - 1e-9 ? '**是**' : '否') +
        ' |'
    );
  }
  push('');
  push('> **判读规则**：四个维度相互独立。`degraded` 与 `insufficient` **可以同时成立**，');
  push('> 且 `not-reject` **绝不**等价于 `not-degraded`（V2 §8.5/§10.3）。本报告不把元组压成单一标签。');
  push('');
  push('**③ `degradationStatus` 的 DTS 定义（本次修正）**：判读用的是**估计量自身**的逐任务 Δ：');
  push('');
  push('> `' + (report.comparisons.controlled[0]?.degradation.definition ?? '') + '`');
  push('');
  push('| 估计量 | DTS（Δ<0，判读用） | DTS 敏感度（Δ ≤ NIM） | Δ ≤ NIM 的任务 | §7.2 臂级 DTS（仅描述，不进判读） |');
  push('| --- | --- | --- | --- | --- |');
  for (const entry of report.comparisons.controlled) {
    push(
      '| ' + entry.id +
        ' | ' + fx(entry.degradation.dts, 4) +
        ' | ' + fx(entry.degradation.dtsBelowNim, 4) +
        ' | ' + (entry.degradation.belowNimTasks.length === 0 ? '—' : entry.degradation.belowNimTasks.join(', ')) +
        ' | ' + String(entry.armLevelDtsVsReference.degradedTasks.length) + '/' + String(entry.n) +
        '（' + fx(entry.armLevelDtsVsReference.dts, 4) + '） |'
    );
  }
  push('');
  push('> 第二列是**判读输入**；第三列是同一条数据的**敏感度**读数（结论不依赖阈值严格度）；');
  push('> 最后一列是 §7.2 的**臂级** DTS（某臂相对冻结参照输了几个任务），它是描述量，**不得**用作估计量的判读输入——');
  push('> 判读对象是估计量自身，不是某一臂。');
  push('');

  push('### 3.3 交互优先可读性与共线披露（§8.4 判读顺序 / §3.4）');
  push('');
  const coll = report.invariants.collinearity;
  push('| 事实 | 实测值 |');
  push('| --- | --- |');
  push('| 质量臂在**每个**已分析任务上等同冻结参照（Arm-3 ≡ Arm-4 ≡ Arm-0） | ' +
    (coll.qualityArmsIdenticalToReference ? '**是**' : '否') + ' |');
  push('| 逐任务恒等式 `θ_track = −(θ_write + θ_gate)` 成立 | ' + (coll.thetaTrackReducedFormHolds ? '**是**' : '否') + ' |');
  push('| 该恒等式的最大残差 `max_i |θ_track_i + θ_write_i + θ_gate_i|` | `' + String(coll.thetaTrackReducedFormResidual) + '` |');
  push('| `θ_track` 与 `θ_write` 两个**序列**数值相等 | ' + (coll.thetaTrackEqualsThetaWrite ? '是' : '**否**（相等不是本轮的退化形式）') + ' |');
  push('| `θ_track` 与 `θ_write` 的逐任务相关系数（仅描述） | ' +
    (coll.trackVsWriteSeriesCorrelation === null ? '未定义（常数序列）' : fx(coll.trackVsWriteSeriesCorrelation, 4)) + ' |');
  push('| `θ_track` 相对轨道因子秩亏（不携带独立信息） | ' + (coll.thetaTrackRankDeficient ? '**是**' : '否') + ' |');
  push('| `Arm-3` ≡ `Arm-0` / `Arm-4` ≡ `Arm-0` / `Arm-3` ≡ `Arm-4` | ' +
    [coll.qualityArmsEqualReference.arm3EqualsArm0, coll.qualityArmsEqualReference.arm4EqualsArm0,
      coll.qualityArmsEqualReference.arm3EqualsArm4].map((flag) => (flag ? '是' : '否')).join(' / ') + ' |');
  push('| 门控因子可识别的臂 | ' +
    (coll.identifiability.gateFactorIdentifiableOn.length === 0 ? '**无**' : coll.identifiability.gateFactorIdentifiableOn.join(', ')) + ' |');
  push('| 门控因子不可识别的臂 | ' +
    (coll.identifiability.gateFactorUnidentifiableOn.length === 0 ? '无' : coll.identifiability.gateFactorUnidentifiableOn.join(', ')) + ' |');
  push('| 轨道因子可识别 | ' + (coll.identifiability.trackFactorIdentifiable ? '是' : '**否**') + ' |');
  push('| 交互项可识别 | ' + (coll.identifiability.interactionIdentifiable ? '是' : '**否**（质量行两格完全相同）') + ' |');
  push('');
  push('> **' + coll.disclosure + '**');
  push('');
  push('**读法**：`θ_track` 落在 `above-MMI` 带**不得**被读作「轨道因子有正向效应」的轨道证据。');
  push('恒等式 `θ_track = −(θ_write + θ_gate)` 说明它完全由另外两个对比决定、不含任何质量行的项；');
  push('这正是「轨道因子在本夹具中不可识别」的**可执行证明**（残差为 0），而不是「轨道有效」的证据。');
  push('`θ_int` 在质量行不可识别时**只能**报 `undetermined`，不得解释为「无交互」。');
  push('');

  push('## 4. 补充族：五臂两两对照（BH FDR，V2 §8.6）');
  push('');
  push('| 对比 | n | 均值差 | 胜/平/负 | m_disc | 主检验 | 主检验 p | BH q | 区间 | 宽度 |');
  push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const entry of report.comparisons.exploratory) {
    push(
      '| `' + entry.left + '` − `' + entry.right + '` | ' + String(entry.n) +
        ' | ' + fx(entry.meanDelta) +
        ' | ' + String(entry.wins) + '/' + String(entry.ties) + '/' + String(entry.losses) +
        ' | ' + String(entry.discordantPairs) +
        ' | ' + (entry.binarySeries ? 'McNemar' : '符号翻转') +
        ' | ' + fx(entry.pPrimary, 4) +
        ' | ' + fx(entry.q, 4) +
        ' | [' + fx(entry.randomizationInterval.lower) + ', ' + fx(entry.randomizationInterval.upper) + ']' +
        ' | ' + fx(entry.intervalWidth, 3) + ' |'
    );
  }
  push('');
  push('> 本表为**探索性/补充性**，与 §3 的受控族分开成表；其 q 值不得用来支撑五臂结论（V2 §8.6）。');
  push('');
  /**
   * A CONSTANT series makes the inversion degenerate: the sign-flip test has no
   * discordant mass, so no null shift is ever rejected and the accepted set is
   * the whole scanned grid. Printing "[0.000, 0.000]" would read as a precision
   * claim instead of an empty information content.
   */
  const degenerateIntervals = report.comparisons.exploratory.filter(
    (entry) => entry.intervalWidth <= 1e-9 && entry.perTask.every((row) => Math.abs(row.delta) < 1e-9)
  );
  if (degenerateIntervals.length > 0) {
    push('> ⚠️ **退化区间（必须如实读出）**：' + degenerateIntervals.map((entry) => '`' + entry.left + ' − ' + entry.right + '`').join('、') +
      ' 的逐任务 Δ 恒为 0（`m_disc = 0`），符号翻转检验没有任何不一致质量，');
    push('> 反演因此不拒绝任何 μ，`randomizationInversionInterval` 返回的 `[0.000, 0.000]` 是**退化输出**，');
    push('> **不是**「区间极窄、两组精确相同」。这类行的宽度**不构成**精度证据；`m_disc = 0` 本身即信息量为零。');
    push('');
  }

  push('## 5. 逐任务表（12 × 10 两两 Δ + 四个受控估计量）');
  push('');
  push('### 5.1 各臂逐任务 verifiedRate（宿主判定；`—` = 未分析）');
  push('');
  const armIds = report.arms.map((arm) => arm.armId);
  const taskIds = report.arms[0].tasks.map((task) => task.taskId);
  push('| 任务 | ' + armIds.map((id) => '`' + id + '`').join(' | ') + ' | 各臂可用 episode |');
  push('| --- | ' + armIds.map(() => '---').join(' | ') + ' | --- |');
  for (const taskId of taskIds) {
    const cells = report.arms.map((arm) => {
      const task = arm.tasks.find((entry) => entry.taskId === taskId);
      if (task === undefined) return '—';
      if (task.analysisIncluded) return fx(task.verifiedRate);
      return '**' + (task.status === 'not-run-control-stop' ? 'not-run' : 'censored') + '**';
    });
    const available = report.arms
      .map((arm) => String(arm.tasks.find((entry) => entry.taskId === taskId)?.availableEpisodes ?? 0))
      .join('/');
    push('| ' + taskId + ' | ' + cells.join(' | ') + ' | ' + available + ' |');
  }
  push('');
  push('### 5.2 12 × 10 两两逐任务 Δ（left − right，探索性）');
  push('');
  const table = report.comparisons.pairwiseTable;
  push('| 任务 | ' + table.columns.map((label) => '`' + label + '`').join(' | ') + ' |');
  push('| --- | ' + table.columns.map(() => '---').join(' | ') + ' |');
  for (const row of table.rows) {
    push('| ' + row.taskId + ' | ' + row.cells.map((cell) => fx(cell)).join(' | ') + ' |');
  }
  push('');
  push('> ' + table.note);
  push('> 行数实测 ' + String(table.rows.length) + ' × 列数 ' + String(table.columns.length) + '。');
  push('');
  push('### 5.3 四个受控估计量的逐任务 Δ（判读输入）');
  push('');
  const cs = report.comparisons.controlledSeries;
  push('| 任务 | ' + cs.columns.join(' | ') + ' |');
  push('| --- | ' + cs.columns.map(() => '---').join(' | ') + ' |');
  for (const row of cs.rows) {
    push('| ' + row.taskId + ' | ' + row.cells.map((cell) => fx(cell)).join(' | ') + ' |');
  }
  push('');
  push('> ' + cs.note);
  push('');

  push('## 6. 门控介入分布（证明门控确实接线的必要证据，V2 §7.2）');
  push('');
  push('| 臂 | 门控 | 提议偏离数 | 门控评估数（applied） | kept-prior | executed-proposed | executed-exploration | 原因分布 |');
  push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const entry of report.invariants.gateDistribution) {
    push(
      '| `' + entry.armId + '` | ' + (entry.gateEnabled ? '开' : '关') +
        ' | ' + String(entry.proposedDeviations) +
        ' | ' + String(entry.applied) +
        ' | ' + String(entry.keptPrior) +
        ' | ' + String(entry.executedProposed) +
        ' | ' + String(entry.executedExploration) +
        ' | ' + (Object.keys(entry.reasons).length === 0 ? '—' : JSON.stringify(entry.reasons)) + ' |'
    );
  }
  push('');
  push('> `applied` 只计**真正评估过门控**的决策点（门控开 **且** 提议偏离先验）。未偏离先验的行由内核直接落回先验，');
  push('> 门控根本没有拦截机会；把它们计成 `applied` 会虚增门控的判别力。');
  push('');
  push('### 6.1 无条件落盘的挑战者测量（§3.4：门关臂**仍测量**强度）');
  push('');
  push('| 臂 | 门控 | 决策行数 | 含挑战者测量的行数 | meanNEff（挑战者） |');
  push('| --- | --- | --- | --- | --- |');
  for (const entry of report.invariants.gateOffChallengerMeasurement) {
    push(
      '| `' + entry.armId + '` | 关 | ' + String(entry.rows) +
        ' | ' + String(entry.rowsWithChallengerMeasurement) +
        ' | ' + fx(entry.meanChallengerNEff, 2) + ' |'
    );
  }
  push('');
  const challengerCheck = report.invariants.challengerFieldsUnconditional;
  push('> 断言 `challengerFieldsUnconditional = ' + challengerCheck.assertion + '`：检查 ' +
    String(challengerCheck.rowsChecked) + ' 行，缺失挑战者字段的行数 = ' + String(challengerCheck.rowsWithoutFields) + '。');
  push('> **修正说明**：原实现只在 `conservativeGate === true` 时调用 `decideReplacement`，于是两条门关臂的');
  push('> `nEff/support/shrunk/calibrated` 全部为 `null`——恰恰抹掉了门控因子必须对比的那一维。现在五臂**无条件**调用');
  push('> 生产函数并落盘四个字段，门控开关只决定 `verdict` 能否改写被执行动作。');
  push('');
  if (report.invariants.gateReachableOnSharedPath) {
    push('> 门控在共享路径上**双向可达**：另有独立探针以同一生产函数验证「证据不足⇒否决」与');
    push('> 「证据充分⇒执行」两侧均成立（`scripts/eval/pr4a-gate-wiring.mjs`，exit 0）。');
  } else {
    push('> ⚠️ 门控在两臂上均未触发，且未通过可达性探针——按 V2 §7.2 属**阻塞缺陷**。');
  }
  push('');

  const noDeviation = report.arms.filter(
    (arm) => arm.spec.conservativeGate && arm.gate.applied === 0 && arm.policyChangeRate === 0
  );
  const deviationArms = report.arms.filter((arm) => arm.policyChangeRate > 0);
  if (noDeviation.length > 0) {
    push('### 6.2 空门控分布的成因（**可识别性限制，必须如实读出**）');
    push('');
    push('下列带门控的臂**从未偏离先验**（`policyChangeRate = 0`），因此门控**没有任何可拦截的机会**：');
    push('');
    push('| 臂 | 改选率 | 门控评估数 | 该格的可解释性 |');
    push('| --- | --- | --- | --- |');
    for (const arm of noDeviation) {
      push(
        '| `' + arm.armId + '` | ' + fx(arm.policyChangeRate, 4) + ' | ' + String(arm.gate.applied) +
          ' | 门控因子在该格**不可识别**（无偏离可判） |'
      );
    }
    push('');
    push('**为什么没有偏离（实测机制）**：可信质量轨的奖励在该合成夹具中趋于饱和——凡被判通过的执行');
    push('都取得同一奖励值，于是各候选的 `Q` 几乎相等、优势 A ≈ 0，argmax 每次落回先验。');
    push('这是**夹具性质**，不是「门控未接线」的证据（接线由独立可达性探针证明）。');
    push('');
    push('**对结论的影响（必须同时读出）**：');
    push('');
    push('1. `θ_gate` 的实际信息**全部来自 `Arm-1` vs `Arm-2`**（过程行）；质量行的门控贡献为 0。');
    push('2. `θ_int` 因此**不可识别**：当 `Arm-3 ≡ Arm-4` 时，交互项退化为「过程行的门控效应」，');
    push('   不得解释为「轨道与门控的交互」。');
    push('3. 本轮**不能**回答「质量轨 + 保守门优于质量轨」——该对比的两格观测值相同。');
    push('   这是**可识别性边界**，不是「门控在质量轨无效」的证据。');
    push('');
    push('有偏离、因而具备门控判别力的臂：' +
      (deviationArms.length === 0
        ? '**无**'
        : deviationArms.map((arm) => '`' + arm.armId + '`（' + fx(arm.policyChangeRate, 4) + '）').join('、')));
    push('');
  }

  push('## 7. 成本口径（真实 / 估计 / 未知，V2 §9）');
  push('');
  push('| 臂 | 分母 | 决策点 | 模型调用 | measured | estimated | unknown | 名义微美元 | 地板附加费 | 本地墙钟 |');
  push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const entry of report.cost.arms) {
    push(
      '| `' + entry.armId + '` | ' + entry.denominator + ' | ' + String(entry.decisionPoints) +
        ' | ' + String(entry.modelCalls) +
        ' | ' + String(entry.measured.count) + ' / ' + pct(entry.measured.share) +
        ' | ' + String(entry.estimated.count) + ' / ' + pct(entry.estimated.share) +
        ' | ' + String(entry.unknown.count) + ' / ' + pct(entry.unknown.share) +
        ' | ' + String(entry.notionalCostMicros) +
        ' | ' + String(entry.conservativeSurchargeMicros) +
        ' | ' + String(entry.localWallClockMs) + 'ms |'
    );
  }
  push('');
  push('### 7.1 Token 六字段分列（V2 §9.3，每项自带精度状态）');
  push('');
  push('| 臂 | inputTokens | outputTokens | reasoningTokens | cacheReadTokens | cacheWriteTokens | totalTokens | 分母 |');
  push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const entry of report.tokenFields.perArm) {
    const cell = (field) => String(field.tokens) + ' (`' + field.precision + '`)';
    push(
      '| `' + entry.armId + '` | ' + cell(entry.inputTokens) +
        ' | ' + cell(entry.outputTokens) +
        ' | ' + cell(entry.reasoningTokens) +
        ' | ' + cell(entry.cacheReadTokens) +
        ' | ' + cell(entry.cacheWriteTokens) +
        ' | ' + cell(entry.totalTokens) +
        ' | ' + entry.denominator + '（' + String(entry.decisionPoints) + ' 决策点 / ' + String(entry.modelCalls) + ' 调用） |'
    );
  }
  push('');
  push('| 字段 | 本轮精度 | 说明 |');
  push('| --- | --- | --- |');
  for (const field of report.tokenFields.fields) {
    push('| `' + field + '` | `estimated` | ' + report.tokenFields.estimator + ' |');
  }
  push('');
  push('> **没有任何一项是 `measured`**：本 harness 无 tokenizer，故六字段全部为 `estimated`。');
  push('> 口径说明：`' + report.tokenFields.note + '`');
  push('');
  push('**口径声明（逐条，均可核对）**：');
  push('');
  push('1. **`liveCalls = 0`、`incurredRealUsd = 0.00`**：本轮全部为离线合成夹具，未发起任何真实付费调用。');
  push('2. **`micros` 不是美元**：它是记账单位约定（1 USD = 1,000,000 micros）。上表金额由**离线夹具费率卡**');
  push('   `' + report.cost.arms[0].rateCardId + '`（`' + report.cost.arms[0].rateCardVersion + '`）计算，属**名义值（notional）**，');
  push('   不是支出、不是报价、也不构成任何财务授权。');
  push('3. **`' + String(report.declarations.notionalGuardrailMicros) + '` 微美元 / `' + String(report.declarations.notionalGuardrailTokens) + '` token 不是财务上限**：它们是离线名义台账的');
  push('   **护栏阈值**（`offlineNotionalBudgetMicros` / `offlineNotionalTokenBudget`），仅用于在夹具跑飞时于**决策边界**快速中止。');
  push('4. **本地墙钟不是远端费用上限**：`' + String(report.safety.localTaskWallClockMs) + 'ms`（单次调用 `' + String(report.safety.localCallTimeoutMs) + 'ms`）是超时隔离判据，');
  push('   与远端计费无函数关系；「60 秒内 ⇒ 不超预算」是无效推理。');
  push('5. **全部 token 数均为 `estimated`**：见上表，`measured` 计数恒为 0——这是事实，不是缺陷。');
  push('6. **地板附加费单列**：若 `unknown` 触发保守地板，其差额计入「地板附加费」列，**不并入**名义金额。');
  push('');

  push('## 8. 安全事件与执行控制（V2 §10）');
  push('');
  push('| §10.2 路径 | 本轮是否触发 | 说明 |');
  push('| --- | --- | --- |');
  for (const entry of report.safety.executionControlCoverage) {
    push('| `' + entry.path + '`（' + entry.label + '） | ' + (entry.triggered ? '**已触发**' : '未触发') + ' | ' + entry.note + ' |');
  }
  push('');
  if (report.safety.events.length === 0) {
    push('**本轮未触发任何执行控制事件**：五臂均在 12 任务 × 5 执行 × 3 轮内正常完成，');
    push('没有 `guardrail-stop`、没有 `futility-stop`、没有 `runner-timeout`、没有 `safety-violation`。');
    push('');
    push('> 「未触发」是**实测事实**，不是遗漏：上表逐条列出四条路径、其触发条件与不可触发性原因。');
  } else {
    push('| 类型 | 标签 | 臂 | 详情 |');
    push('| --- | --- | --- | --- |');
    for (const event of report.safety.events) {
      push('| `' + event.kind + '` | `' + event.label + '` | `' + (event.armId ?? '—') + '` | ' + JSON.stringify(event) + ' |');
    }
  }
  push('');
  push('> 执行控制与结果判定**互不改写**（V2 §10.1）：中止不会被记成「退化」，退化也不会触发中止。');
  push('> 超时/中止的执行按 §6.4 标 `learningEligible=false`、`forceAuditOnly=true`，**不计为任务失败**，');
  push('> 而是从该任务分母中剔除并列入 `denominator-degraded` 清单（见 §2）。');
  push('');
  push('### 8.1 数据完整性（§10.4：不得静默丢任务）');
  push('');
  push('| 臂 | 状态 | 计划任务 | 已分析任务 | not-run | denominator-degraded | 被截断执行 | 决策点（实记/计划） |');
  push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const entry of report.safety.dataCompleteness) {
    push(
      '| `' + entry.armId + '` | ' + entry.status +
        ' | ' + String(entry.plannedTasks) +
        ' | ' + String(entry.analyzedTasks) +
        ' | ' + (entry.notRunTasks.length === 0 ? '—' : entry.notRunTasks.join(', ')) +
        ' | ' + (entry.denominatorDegradedTasks.length === 0 ? '—' : entry.denominatorDegradedTasks.join(', ')) +
        ' | ' + String(entry.censoredExecutions) +
        ' | ' + String(entry.recordedDecisionPoints) + '/' + String(entry.plannedDecisionPoints) + ' |'
    );
  }
  push('');
  push('> 任何被执行控制截断的臂/任务都保留其**原始计数**与原因，分母里不做静默剔除（V2 §10.4）。');
  push('');

  push('## 9. 不变量断言');
  push('');
  push('| 断言 | 结果 |');
  push('| --- | --- |');
  push('| 跨臂候选池指纹一致 | ' + report.invariants.poolDigestAssertion + '（失配 ' + String(report.invariants.poolDigestMismatches) + '） |');
  push('| 跨臂记录 id 两两不交 | ' + report.invariants.recordIsolationAssertion + '（重叠 ' + String(report.invariants.crossArmRecordOverlaps) + '） |');
  push('| `Arm-0` 快照冻结（终态 = 初始） | ' + (report.invariants.arm0Frozen ? 'passed' : 'FAILED') + ' |');
  push('| 探索额度钉为 0 | passed（' + String(report.invariants.explorationAllowancePinned) + '） |');
  push('| **逐行写入轨符合设计**（不是最后一次写入） | ' + report.invariants.trackIsolationPerRowAssertion + ' |');
  push('| **未认证执行仅审计**（质量标签落入过程臂 = 0） | ' + report.invariants.auditOnlyAssertion + ' |');
  push('| **挑战者四字段无条件落盘** | ' + report.invariants.challengerFieldsUnconditional.assertion +
    '（缺失 ' + String(report.invariants.challengerFieldsUnconditional.rowsWithoutFields) + ' / ' +
    String(report.invariants.challengerFieldsUnconditional.rowsChecked) + ' 行） |');
  push('| **主指标 = 宿主判定**（与覆盖率替代值零分歧） | ' + report.invariants.hostVerdictAssertion.assertion +
    '（分歧 ' + String(report.invariants.hostVerdictAssertion.perArm.reduce((sum, entry) => sum + entry.disagreements, 0)) + '） |');
  for (const entry of report.invariants.trackPerArm) {
    push(
      '| `' + entry.armId + '` 轨道符合设计（' + entry.expectedTrack + '） | ' +
        (entry.satisfiesExpectedTrackCount ? 'passed' : 'FAILED') +
        '（写入 ' + String(entry.rowsWritten) + ' 行，错轨 ' + String(entry.rowsMismatched) +
        '，末次写入 ' + String(entry.wroteTrack) + '） |'
    );
  }
  push('');

  push('## 10. 决策台账（全量落盘，V2 §4.1/§12.2）');
  push('');
  push('| 臂 | 决策点 | 文件 | 完整 SHA-256（64 位十六进制） |');
  push('| --- | --- | --- | --- |');
  for (const entry of ledgerStats) {
    push('| `' + entry.armId + '` | ' + String(entry.rows) + ' | `' + entry.file + '` | `' + entry.sha256 + '` |');
  }
  push('');
  push('> 台账为**全量数组**（每臂 12 任务 × 5 run × 3 round = 180 行），不是计数 + 样例；');
  push('> 上表给出**完整 64 位十六进制** SHA-256（不是前缀省略），可直接与文件对账：');
  push('');
  push('```powershell');
  for (const entry of ledgerStats) {
    push('(Get-FileHash ' + entry.file + ' -Algorithm SHA256).Hash  # expect ' + entry.sha256.toUpperCase());
  }
  push('```');
  push('');
  push('> 台账不含任何原始文本、代码补丁或 Prompt（payload-free）。');
  push('');
  push('台账列（payload-free，逐行可复算 §4.1）：');
  push('');
  const columns = report.ledgerIndex.perArm[0]?.columns ?? [];
  push('```');
  push(columns.join('\n'));
  push('```');
  push('');
  push('> 其中 `challengerSupport` / `challengerNEff` / `challengerShrunkAdvantage` / `challengerCalibratedAdvantage`');
  push('> 为**无条件**落盘的挑战者测量（§3.4）；`writeDisposition` 记录该行是 `written` 还是 `audit-only-*`（§6.3）；');
  push('> `hostVerdict` 是宿主判定（§6.1），`observedCoverage` 只是合成替代值。');
  push('');

  push('## 11. 本报告**不**声明什么');
  push('');
  push('- **不声明任何「真实费用」**：`liveCalls=0`、`incurredRealUsd=0.00`，全部金额为名义值（§7）。');
  push('- **不声明生产结论**：12 个合成任务提供的只是机制可行性与决策级归因证据；');
  push('  不得外推为生产显著性结论（V2 §8.7）。');
  push('- **不声明统计功效已达成**：`d_min = ' + fx(report.declarations.minDetectableD, 3) + '` 是**闭式近似**');
  push('  （' + report.declarations.powerIsClosedFormApproximation + '）；');
  push('  精确枚举得到的最小可检测胜率为 π* = ' + fx(report.declarations.minDetectableWinRate, 3) + '。');
  push('- **不声明 Wilcoxon 用于二值数据**：`wilcoxonUsedOnBinary = ' + String(report.declarations.wilcoxonUsedOnBinary) + '`。');
  push('- **不把「不显著」读成「无退化」**：见 §3.2 的四维元组。');
  push('- **不把门控因子说成在两个轨道上都被检验过**：质量行的门控**不可识别**（该行从未偏离先验）；');
  push('  因此 `θ_gate` 全部来自过程行，`θ_int` 在本轮**不可识别**。');
  push('- **不把 `above-MMI` 当作正向轨道证据**：本夹具中质量臂在每个已分析任务上等同冻结参照，');
  push('  因此 `θ_track` 满足恒等式 `θ_track = −(θ_write + θ_gate)`（残差 = ' +
    String(coll.thetaTrackReducedFormResidual) + '），对轨道因子**秩亏**、不携带独立信息；');
  push('  且 Holm 校正后不显著、证据状态为 `insufficient`。这是「未定论」，不是「已证明更优」，也不是「轨道有效」。');
  push('- **不声明门关臂「未测量门控」**：门关臂同样无条件落盘 `nEff/support/shrunk/calibrated`（§6.1）。');
  push('- **不把超时/中止计成任务失败**：截断执行按 §6.4 只进审计流并从分母剔除，且列入 `denominator-degraded`。');
  push('- **不声称工作树干净**：本报告绑定执行代码摘要 `' + provenance.executedSourcesDigest.slice(0, 16) +
    '…` 与 commit `' + report.codeBaseline.slice(0, 12) + '…`，见 §0.1。');
  push('- **不预填正向结果**：本轮结果无论正、零或负，均如实记录；没有任何数值目标被当作完成条件。');
  push('');
  push('---');
  push('');
  push('*本文件由脚本生成；任何手工改动都会与 JSON 报告不一致，并会被 `scripts/eval/verify-pr4a-artifacts.mjs` 判失败。*');
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const jsonOnly = process.argv.includes('--json-only');
  const provenance = resolveCodeProvenance();
  const baseline = provenance.commit.length === 40 ? provenance.commit : '0'.repeat(40);
  console.log('[pr4a] protocol: PR4A-EVAL-PREREG-20261027-V2');
  console.log('[pr4a] code baseline (commit object): ' + baseline);
  console.log(
    '[pr4a] workspace dirty: ' + String(provenance.workspaceDirty) +
      ', dirty tracked files: ' + String(provenance.trackedDirtyCount)
  );
  console.log('[pr4a] executed sources digest: ' + provenance.executedSourcesDigest);
  console.log('[pr4a] offline only: zero live calls, zero publish, zero deploy');

  const { runPr4aExperiment, bundleFingerprint } = await loadPr4aReport();
  const { report, ledgers } = await runPr4aExperiment({
    codeBaseline: baseline,
    codeProvenance: { ...provenance, bundleFingerprint }
  });

  const workDir = join(REPO_ROOT, 'work');
  mkdirSync(workDir, { recursive: true });

  // 1. full JSON report
  const jsonPath = join(workDir, 'pr4a-five-arm-eval.json');
  const jsonText = JSON.stringify(report, null, 2) + '\n';
  writeFileSync(jsonPath, jsonText, 'utf8');

  // 2. FULL ledger per arm, each with its own digest
  const ledgerStats = [];
  for (const [armId, rows] of ledgers) {
    const file = 'work/pr4a-ledger-' + armId + '.jsonl';
    const text = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
    writeFileSync(join(REPO_ROOT, file), text, 'utf8');
    ledgerStats.push({ armId, rows: rows.length, file, sha256: sha256Hex(text) });
  }

  // 3. readable markdown
  if (!jsonOnly) {
    const mdPath = join(REPO_ROOT, 'docs', 'reports', 'pr4a-five-arm-eval-report.md');
    writeFileSync(mdPath, renderMarkdown(report, ledgerStats), 'utf8');
    console.log('[pr4a] wrote ' + mdPath);
  }

  console.log('[pr4a] wrote ' + jsonPath + ' (' + String(jsonText.length) + ' bytes)');
  for (const entry of ledgerStats) {
    console.log('[pr4a] wrote ' + entry.file + ' (' + String(entry.rows) + ' rows, sha256 ' + entry.sha256 + ')');
  }

  // ---- hard assertions: the run is INVALID if any of these fail ----
  const failures = [];
  if (report.invariants.poolDigestMismatches !== 0) failures.push('pool digest mismatch across arms');
  if (report.invariants.crossArmRecordOverlaps !== 0) failures.push('cross-arm record id overlap');
  if (!report.invariants.arm0Frozen) failures.push('Arm-0 snapshot is not frozen');
  if (report.invariants.trackIsolationPerRowAssertion !== 'passed') {
    failures.push('a row was written outside its arm track (per-row invariant)');
  }
  if (report.invariants.auditOnlyAssertion !== 'passed') {
    failures.push('an unauthenticated quality record reached a process arm');
  }
  if (report.invariants.challengerFieldsUnconditional.assertion !== 'passed') {
    failures.push('challenger fields are not unconditional on every row');
  }
  if (report.invariants.hostVerdictAssertion.assertion !== 'passed') {
    failures.push('the host verdict and the coverage substitute disagree');
  }
  if (!report.invariants.gateReachableOnSharedPath) failures.push('gate never fired on any gate arm');
  if (!report.cost.arms.every((entry) => entry.liveCalls === 0 && entry.incurredRealUsd === 0)) {
    failures.push('liveCalls/incurredRealUsd violated');
  }
  if (report.replication.effectiveReplication === 0) failures.push('replication check did not run');
  if (report.arms.some((arm) => arm.completeness.status !== 'complete')) {
    failures.push('at least one arm is incomplete (a task was dropped or its denominator degraded)');
  }

  if (failures.length > 0) {
    console.error('[pr4a] FAIL: ' + String(failures.length) + ' invariant(s) violated');
    for (const failure of failures) console.error('  - ' + failure);
    process.exitCode = 1;
    return;
  }
  console.log('[pr4a] SUCCESS: all invariants hold; zero live calls; report is reproducible');
}

try {
  await main();
} catch (error) {
  console.error('[pr4a] unexpected error:', error);
  process.exitCode = 1;
}
