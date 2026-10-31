# rev6 R1-1 预注册：JitRL 写回证据门干预（C3-online vs C3-frozen）

- **任务**：rev6 `t9`（R1-1 预注册 + R1-2 门控）
- **本文件写于任何 rev6 采样之前**。冻结顺序的机器判据见 §9（`rev6-jitrl-intervention.mjs --json` 会回报本文件 sha256 与首次采样时刻，二者必须满足 `preregisteredBeforeFirstSample === true`）。
- **历史基线（不可改，只读引用）**：`docs/reports/p6-fair-eval.md` 的 `C3-online − C3-frozen` verifiedRate 均值差 **−0.250**（12 任务、episodes=5、rounds=3、seed 6221082、k=10；CI95 `[−0.417, −0.083]`，胜/平/负 0/7/5），`deviationStats = {total:36, harmful:18, gateFired:0}`。
- **本预注册只新增实验版本与数据文件**；不重算、不改写、不"修正"上述任何数字（G7/G14）。

---

## 1. 假设（先于采样写死，不可事后改）

| # | 假设 | 方向 | 主要判据 |
| --- | --- | --- | --- |
| H1 | 证据门会把**无证据/不可验证**的写回从 L2 选择中剔除，从而减少有害偏离被训练进经验库 | 定向（门的机制正确性） | `admittedToL2` 中 `verdict !== 'kept-verified-convergence' && verdict !== 'kept-fail-to-pass'` 的条数 = **0** |
| H2 | 门开（`gate:on`）相对门关（`gate:off`）在同一池、同种子、同预算下，`C3-online` 的 verifiedRate **不再出现超过容忍界的退化** | 双侧，容忍界见 §4 | `Δ = C3-online(off) − C3-online(on)` 的 CI95 **下界 ≥ −0.05** |
| H0（零假设，必须写出来） | 门对 C3 的 verifiedRate 无可判别的改善 | —— | CI 跨 0 或下界 < −0.05 ⇒ **不得**声称改善，只能写"未达容忍界判别力"或负结果 |

**H2 的方向说明（重要，防误读）**：本实验比较的是「**同一 C3-online 机制**在门开/门关两个写回策略下」的表现，差值符号定义为 `off − on`（**门关减门开**，即"门带来的退化减少量"）。负值 = 门开更差。因此"H2 成立"要求下界 ≥ −0.05（门没有把东西弄坏），而**不是**要求显著为正——**一个把写回全掐死的门也会让差值变正**，所以 §4 另设**覆盖率下界**来否决这种退化方案。

---

## 2. 任务集（按名字冻结，不按索引）

- 池：`scripts/eval/jitrl-eval-lib.ts` 的 `EVAL_TASKS`，共 **12** 个任务；`suiteSeed()` 实测 `4264854568`（任务 id + required 面的哈希，任务集一变种子就变）。
- 任务 id（**逐字冻结**，顺序即池顺序）：
  `ci-01, ci-02, ci-03, ci-04, mig-01, mig-02, mig-03, mig-04, test-01, test-02, test-03, test-04`
- 家族：`ci-fix`(4) / `schema-migration`(4) / `test-authoring`(4)。
- **不得增删任务**：增删即改变池与种子，本预注册失效（需新预注册 + 新版本号）。

---

## 3. 候选池与旋钮（一次只改一个变量）

| 项 | 冻结值 | 说明 |
| --- | --- | --- |
| K（候选池宽度） | **10** | `FAIR_DEFAULT_K`；与历史 −0.250 同一值 |
| beta | `1` | `FAIR_DEFAULT_BETA` |
| similarityThreshold | `0.3` | `FAIR_DEFAULT_SIMILARITY` |
| episodes | **5** | 每任务 episode 数（历史同值） |
| rounds | **3** | 每 episode 轮数（历史同值） |
| seed | **6221082** (`0x5eed1a`) | 与历史实验**同一**种子，保证可配对 |
| arms | `C3-frozen`, `C3-online` | **只这两个**；不新增 Arm-5（N-7） |
| protocol | `same-task`（cold store per task） | 与历史 −0.250 同一协议 |

**唯一被操纵的自变量** = `writebackGate`：`off`（历史行为，每条 executed 写回都进 L2）vs `on`（证据门，见 §5）。其余全部冻结。

---

## 4. 主要终点、区间与容忍界

| 项 | 冻结口径 |
| --- | --- |
| 主要终点 | `verifiedRate`（任务级二值：该任务在该协议下是否 verified 通过） |
| 副终点 | `meanCoverage`（防"把写回掐死换取不退化"的退化方案） |
| 配对单位 | **同一任务的 `(C3-frozen, C3-online, gate)` 三元组**；配对样本数 = 任务数 = **12** |
| 独立分析单元 | **任务**。episodes/rounds **不是**独立样本（N-7 禁止把 episodes/rounds 当独立样本） |
| n | 12 对（不可通过增加 episodes 来提高 n） |
| 区间方法 | 配对 t 区间（双侧 95%），`sd`/`se` 从**任务级配对差值**计算；同时报 bootstrap(10,000, seed 6221082) 的 2.5/97.5 分位作为稳健性对照 |
| α | 0.05 双侧 |
| 多重校正 | 两个终点（verifiedRate 主、meanCoverage 副）用 **Holm–Bonferroni**（m=2）；主终点单独报未校正区间供审阅 |
| 容忍界 | 主终点 CI95 **下界 ≥ −0.05**（与历史实验同界） |
| 覆盖率否决线 | `C3-online(gate:on)` 的 `meanCoverage` 相对 `gate:off` **下降不得超过 0.10**；超过即判"门把有证据的写回也掐死了"，H2 不成立 |
| 功效（先验，诚实登记） | n=12、α=0.05、SD 由历史实测 `0.296` 推算，双侧配对 t 的 80% 功效可检出 \|Δ\|≈**0.19**。故本实验**只能**判别"量级 ≥ 0.19 的退化是否存在"，**不能**判别更小的效应；报告必须写这句 |
| 停止规则 | 单次运行，**不做**中途查看/序贯停止/加采样；若出现崩溃或输入不可读 ⇒ 判 `blocked`，不得补采样凑结果 |

---

## 5. 证据门规则（R1-2 的判据，先于实现冻结）

一条 executed 写回**进入 L2 选择**当且仅当满足下列**任一**条件：

- **G-A 可验证 Fail→Pass**：该轨迹携带**宿主可信**回执（`trustedSource === true`）且 `verification.status === 'passed'`，并且其**同一 `actionKey` 的先前执行**在快照中留有 `verification.status === 'failed'` 记录（即存在可验证的 fail→pass 转变）。半条证据（可信但无先前失败 / 有先前失败但回执不可信）**不合格**。
- **G-B 预注册收敛**：同一 `actionKey` 在快照中有 **support ≥ 3** 条独立执行记录，且其中 verified 通过率 **≥ 0.80**，且**反例数 = 0**（任何 `verifierRewardMismatch === true` 或 `forceAuditOnly === true` 的记录都算反例，一条即否决）。

不满足任一 ⇒ 该写回**只写审计**（`learningEligible: false`，`learningTarget: 0`，保留 `reward` 供审计），**不参与 L2 排序**。**不得**用 Composer 自评、surrogate 打分、或"看起来合理"替代 verifier 证据构造正奖励。

门关（`gate:off`）时**完全走历史路径**（默认字节级等价）。

---

## 6. 要记录的观测量（每任务 + 聚合）

`gateFired`（开/关各自的拦截条数）、`admittedToL2`、`auditedOnly`、每个拒绝的原因码分布、`coverage`（meanCoverage）、`verifiedRate`、候选排序（L2 选中 actionKey 序列）、`verifiedRate`（被选中者中 verified 的比例）、反例坐标 `(taskId, runId/episode, round, slotIndex, actionKey)`。

---

## 7. 判读规则（防"把不可判别写成收益"）

| 观测 | 允许的结论措辞 | **禁止**的措辞 |
| --- | --- | --- |
| 主终点 CI95 下界 ≥ −0.05 且覆盖率否决线未破 | "门开时未再出现超过容忍界的退化" | "收益为正"/"改善 X%"/"解决了 −0.250" |
| 主终点 CI 跨 0 或下界 < −0.05 | "未达容忍界判别力"/"负结果（保留）" | 任何正向表述 |
| 覆盖率下降 > 0.10 | "门过度收紧，写回被掐死" ⇒ H2 **不成立** | 用 verifiedRate 不退化来掩盖 |
| 门在合成池从未触发（`gateFired=0`） | "该池无可用证据，门退化为恒等，本池**不可判别**" | 把恒等当成功 |

`−0.250` 与 `deviationStats{36,18,0}` **只作历史引用**（带 `docs/reports/p6-fair-eval.md` 与 2026-10-29 时点语境），不得作为本实验的结果。

---

## 8. 负控制（必须在结果报告里出现）

| NC | 变异 | 期望 |
| --- | --- | --- |
| NC-1 | 注入一条 `learningEligible:true & learningTarget>0` 但**无任何证据**的 L2 记录 | 门必须红（把"无证据写回进入 L2 的数量 = 0"变成退出码） |
| NC-2 | 把 G-A 的 `trustedSource` 置 false（保留 passed + 先前 failed） | 必须拒绝（`rejected-untrusted-receipt`） |
| NC-3 | 在 G-B 的 support 里塞一条 `verifierRewardMismatch:true` | 必须拒绝（`rejected-verifier-mismatch`），即便通过率仍 ≥0.80 |
| NC-4 | 门关（`gate:off`） | 必须与历史路径字节级等价（`admittedToL2 === 全部 executed`，`gateFired === 0`） |

---

## 9. 冻结顺序的可证判据（A-R1-1-1）

`node scripts/eval/rev6-jitrl-intervention.mjs --json` 输出必含：

```
preregistration: { path, sha256, mtimeMs }
firstSampleAtMs
preregisteredBeforeFirstSample  // === mtimeMs <= firstSampleAtMs
```

判据：`preregisteredBeforeFirstSample === true` 且本文件 sha256 在结果报告里逐字符出现。若为 false，整个 R1 结果作废。

**本文件 sha256（落盘后由脚本计算并写入结果报告，不在本文件内自指）。**

### 9.1 采样前实测到的**结构事实**（决定本实验的判读边界）

在写任何实现之前，我核对了 fair-engine 是否会**产生**门所需的证据，结论是**不会**，并且这不因实现方式而改变：

| 事实 | 实测依据 |
| --- | --- |
| `scripts/eval/jitrl-eval-lib.ts` **从不**写 `metadata.verification`（全文 2 处 `metadata`，都在 `surfaceKeys` 上） | 因此 `readTrustedVerification` 恒返回 `undefined` |
| 该文件**从不**传 `trustedProducers`（全文 0 处） | 因此 `trustedSource` 恒 `false` |
| 于是 `verificationFromTrajectory` 恒走 `deriveStructuralVerification`，其 docstring 明写 "**never 'passed'**" | 合成池里 `verification.status ∈ {unknown, failed}` |

**推论（必须写进结果报告，而不是当成成功）**：

1. G-A 需要 `trustedSource === true`，在上述池中**不可能成立**；
2. G-B 的 `verified` 定义为 `trustedSource && passed`，故其 `verifiedRate` 恒为 **0**，`minVerifiedRate=0.80` 永远不满足；
3. ⇒ 门在该池中必然**拒绝全部写回**。这与"证据门有效"是**两件不同的事**：前者是"池里没有证据"，后者是"门能判别有证据与无证据"。把"全拒"读成"门有效"就是本预注册 §7 明确禁止的那一类误读。

**因此本预注册预先声明两种臂，并分别限定结论**（不事后追加）：

| 臂 | 构造 | 允许得出的结论 | 禁止的结论 |
| --- | --- | --- | --- |
| **A-asis（as-is）** | 生产装配原样，无 trusted producer seam | "该合成池**无可用证据**，门退化为恒等拒绝；本池对 H1/H2 **不可判别**（`not-evaluable`）" | 任何"门改善了 C3"表述 |
| **A-seam（instrumented）** | 研究用注入一个**显式 trusted producer 集合**（`scoreTrajectorySignals` 的 `trustedProducers` 参数，其 docstring 明写仅供 test/research caller），并由实验脚本自己给每条轨迹附**合成 receipt** | "在**声明为合成**的证据形态下，门的判别行为与对 C3 的影响" | 声称真实收益、真实宿主证据、"修复了 −0.250" |

A-seam **不是** mock 冒充真实收益：整轮 fair-eval 本来就是确定性合成 runner（`p6-fair-eval.md` §2 自述"synthetic-suite"），A-seam 只是让"证据有无"这个自变量在该合成环境里**变得可表达**；它产出的所有数字都必须带 `synthetic: true` 标记。

**主终点配对选择（先于采样写死）**：
- H1（门机制正确性）用 **两条臂** 共同判定：A-asis 证明"无证据必拒"（拒绝率 100%），A-seam 证明"有证据才放行"（放行集 = 满足 G-A/G-B 的那部分）。
- H2（对 C3 的影响）**只在 A-seam 上有判别力**，因为只有那里门会部分放行；A-asis 上 `off == on` 按定义（双方都不写回）→ 报告为 `not-evaluable`，**不计入 H2**。
- 主终点配套：A-seam 的 `writingBackRate`（放行 / judged）必须 **> 0 且 < 1**；等于 0 或 1 都说明门在该池是恒等函数，H2 判 `not-evaluable`。此判据防"把恒等当成功"。

---

## 10. 明确不做（避免越权）

- 不 commit / 不 push / 不打 tag（N-1）。
- 不写真实记忆（N-2）；不开 `guarded-active`（N-3）；不 publish（N-4）。
- 不改 `docs/reports/p6-fair-eval.md`、pr4a 预注册与 fixture、`−0.250`、`deviationStats`（G7/G14/N-6）。
- 不新增 Arm-5、不把 episodes/rounds 当成独立样本（N-7）。
- 不声明"−0.250 已被修复/收益已恢复"。

---

## 11. 失效条件

出现任一条即本预注册失效，需新版本（`v2`）与新 sha256，且旧版本保留：

1. 任务池增删或 `suiteSeed()` 变化；
2. K/beta/similarity/episodes/rounds/seed 任一变更；
3. 主要终点、区间方法、α、多重校正、容忍界、覆盖率否决线任一变更；
4. 门规则 G-A/G-B 的阈值（support≥3、verifiedRate≥0.80、反例=0）或判定顺序变更；
5. 采样开始后修改本文件。
