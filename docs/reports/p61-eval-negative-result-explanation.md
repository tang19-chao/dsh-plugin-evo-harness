# P6.1-E 负收益解释报告：决策级诊断、最小反例与预注册假设判别

> 本文是 **负收益解释**（P6.1 源文档 §7.1/§8.1–8.4 的 E 工作项），不是收益报告。
> 每个数字都来自 `node scripts/eval/negative-result-diag.mjs`（复现命令见 §9）对
> `scripts/eval/jitrl-eval-lib.ts` 同一引擎的一次真实执行，没有手写估值，没有包装收益。
> 绑定工作树：基线 `7bce33e` + 在途 P6.1 改动（`git status` 见 §9 的复现说明）。

## 0. 一句话结论（先说负的）

**同任务协议（episodes:5, rounds:3）下 C3-online 相对 C3-frozen 的验证通过率差
−0.250 复现成立（均值差 −0.250，胜/平/负 0/7/5）。它不是算法原理失败的证明**：
决策级台账显示，负收益由 5 个任务在 run1–run2 的**低支持错误改选**引发（run1 的
14 次偏离全部 support ≤ 1，其中 18 次偏离在先验已满覆盖的坐标上把可验证结果从
1 降下来）；noop 组获得正回报自举后，run3–run4 以 support 1→2 的正支持继续复现
同样错误（run4 的 6 次偏离全部 support=2）。
§5 的六条预注册假设各自给出最小对照与判别结果或 not-run 状态；**它们全部是假设，
不是已确认根因**。H3/H4 的单变量探针把负收益完全收窄（Δ 0），但按 §8 的双门槛，
它们仍然只是探针，不是生产默认值。

## 1. −0.250 复现口径

| 项 | 值 |
| :-- | :-- |
| 对照臂 | C3-online（kernel 选择 + 在线写经验） vs C3-frozen（同初始快照冻结） |
| 协议 | same-task：每任务冷启动独立库，因果截断 `before=clock()` |
| episodes / rounds | **5 / 3**（与 `docs/reports/p6-fair-eval.md` §2 相同） |
| 候选池 | 固定 K=3（窄 A / 窄 B / 合并 C），跨臂逐 (task, run, round) 同池 |
| seed / k / beta / threshold | `0x5eed1a` (6221082) / 10 / 1 / 0.3 |
| 任务集 | 12 个离线合成任务（ci-fix / schema-migration / test-authoring） |
| 主指标 | 任务验证通过率（覆盖率 = 1，等价“验收器通过”），配对单位是任务 |
| 复测均值差 | **−0.250**（区间口径见历史报告 §5；本次胜/平/负 **0/7/5**） |

复现与历史值一致（`matchesHistorical: true`）。池指纹 witness（脚本输出
`frame.poolDigests`，ci-01，三轮）：`75d57bdc → b73b0a8b → bd56d73e`；
锚点任务 ci-04 的三轮池指纹为 `be05e090 → 73ba2b59 → 650d0bfa`（其 round-2 池
`650d0bfa` 即 §3.4 counterfactual 所用池）。两者都是脚本确定性输出的原值。

## 2. 决策级诊断台账（payload-free，180 条）

台账在离线受控重放中落地（`runFairEngineWithLedger({diagnostics:{ledger:true}})`），
每个决策点一条，共 180 条（12 任务 × 5 run × 3 round）。**结构化字段、不含原文**：

| 字段 | 语义 |
| :-- | :-- |
| `taskGroup` / `task` / `run` / `round` | 决策坐标（家族 / 任务 / episode / 深化轮） |
| `stateBucket` / `stateFingerprint` | 抽象状态桶 + token 集指纹（`meta\|sig\|cx\|slot\|guidance` 形态） |
| `candidatePoolDigest` / `candidateActionKeys` | 决策点池指纹 + 全部候选的规范化 action key |
| `priorChoice` / `chosenChoice` / `deviated` / `minSupportGateFired` | 先验选择 vs 实选与偏离标记 |
| `neighborIds` / `neighborVersions` / `similarity` / `weight` | 检索近邻（rank 序）及其 rewardVersion 戳 |
| `support` / `q` / `v` / `advantage` / `adjustedLogit` / `kl` | 内核算术（Q/V/A/z′/KL/support） |
| `rewardModelVersion` / `targetField` | 本臂写回所用标尺版本 + 近邻实际消费的目标字段计数 |
| `observedOutcome` / `observedReturn` / `observedCoverage` / `observedVerified` | **实际执行** probe 的观测结果（无 counterfactual） |

样例（ci-01 run0 round0，冷启动）：`neighborIds=[]`、`q=null`、`kl=0`、
`observedOutcome=succeeded`、`observedReturn=0.30` —— 先验直达，零偏离。

无原文进入台账：没有 prompt 文本、没有 patch 内容、没有交付物正文；
只有坐标、哈希、池指纹与内核算术。

## 3. 第一次有害改选：定位与最小反例

“有害”定义为**决策级**判定，不是总均值比较：同一 (task, round) 坐标上，先验
谱系已达成可验证满覆盖（coverage = 1），而实选谱系的可验证结果变差
（coverage < 1）。奖励尺度回落不计为有害（那是 §5 H1 的证据）。

### 3.1 首个有害决策（按 task → run → round 字典序）

```text
ci-04 | run2 | round2
  prior   idx0 guardrails:append(1)   （先验谱系在该坐标 coverage = 1.000，verified）
  chosen  idx1 noop                   support=0  Q=null  V=0.266687  A=0  z'=-0.10199  KL=0.122363
  observed: outcome=succeeded  return=+0.30  coverage=0.667  verified=false
  verifier-reward mismatch: TRUE —— 融合奖励为正而验收器失败
```

### 3.2 失败任务的最小反例（每任务一条，可重放）

5 个退化任务（ci-04, mig-01, mig-02, mig-04, test-03；每个的 verifiedRate 从
1.000 掉到 0.400，Δ = −0.600），每条反例含完整重放参数（arm/protocol/episodes/
rounds/seed/k/beta/threshold/坐标/池指纹/候选键/近邻/算术）。共性模式：

| taskId | 首害坐标 (run, round) | 实选键 | support | Q | 先验坐标覆盖 | 实测覆盖 |
| :-- | :-- | :-- | --: | :-: | :-: | :-: |
| ci-04 | run1, round2 | `guardrails:append(1)#2` | 0 | null | 1.000 | 1.000（无实害，后续 run 才塌） |
| mig-01 | run1, round1 | `skills:mount(eval-skill-exploit-3)+tool_guidance:rewrite(shell)` | 0 | null | 1.000 | 1.000 |
| mig-02 | run1, round2 | `skills:mount(eval-skill-exploit-3)` | 0 | null | 1.000 | 1.000 |
| mig-04 | run1, round2 | `tool_guidance:rewrite(shell)#2` | 0 | null | 1.000 | 1.000 |
| test-03 | run1, round2 | `tool_guidance:rewrite(shell)#2` | 0 | null | 1.000 | 1.000 |

（表内“实测覆盖”是该次实选的即时观测；run1 的部分改选仍满覆盖，真正的验证
塌陷发生在 run2 的 noop 改选上——`ci-04|2|2` 是全序列首个可验证变差点。）

### 3.3 机制（由台账逐条核对，非推测）

1. **run1 起出现低支持偏离**：36 次偏离的 support 范围 0..2，其中 run1 的 14 次
   全部 `support < 2`（最小 0）。空组候选在 `unseenFallback='baseline'` 下取
   A = 0；当受支持动作的组均值小幅低于 V（A < 0）时，**未支持的候选反而赢下
   argmax**。
2. **noop 的正回报自举**：run2 的 noop 改选在 r2 标尺下仍拿 +0.30（部分修复
   status=succeeded + 交付物存在 + 工具一次成功），这写回了 noop 组；
   run3/run4 的 ci-04|2 noop 以 `support=1→2, Q=0.30, A=+0.0260→+0.0247`
   **带正支持地**继续赢（台账实测）。
3. **验证塌陷集中在 run2**：run0 12/12 verified（零偏离），run1 12/12（14 次低
   支持偏离但未破坏满覆盖），**run2 7/12**，run3/run4 7/12（noop 支持增长后错误
   固化）。退化任务比例 5/12 = 0.4167；退化任务平均损失 −0.600，改善任务平均
   收益 +0（没有任务因学习变好）。

### 3.4 离线 counterfactual（合成环境全候选执行；**单独记账**）

对锚点 `ci-04|2|2` 的 K=3 池做合成表全候选执行（**不进入公平臂预算、不写入任何
经验记录、不写成生产已观测经验**；未执行候选在公平臂台账里没有也不得有 reward）：

| candidate | action key | 先验置信 | 若执行：合成覆盖 | 若执行：验收 |
| --: | :-- | :-: | :-: | :-: |
| 0（先验） | `guardrails:append(1)` | 0.55 | 1.000 | 通过 |
| 1（实选） | `noop` | 0.45 | 0.667 | **不通过** |
| 2 | `guardrails:append(1)#2` | 0.50 | 1.000 | 通过 |

即：该决策点存在两个满覆盖候选，学习信号把它们排到了 noop 之后。
counterfactual 的边界声明：全候选执行只在合成表上成立，不给未执行候选补
LLM 猜测 reward。

## 4. 复盘口径：不只挑总均值

| 维度 | 值 |
| :-- | :-- |
| 退化任务比例 | **5/12（0.4167）**，非全任务均匀退化 |
| 退化任务平均收益 | **−0.600**（verifiedRate 1.000 → 0.400） |
| 改善任务平均收益 | **+0.000**（无任务改善；学习没有带来任何正例） |
| 学习曲线（verified） | run0 1.000 → run1 1.000 → **run2 0.583** → run3 0.583 → run4 0.583 |
| 总均值差 | −0.250（5 × 0.600 ÷ 12，全部由 5 个任务的 run2 塌陷贡献） |

总均值 −0.250 是 5 个任务在同一步塌陷的算术结果，不是 12 个任务上的均匀退化。

## 5. 预注册假设判别（一次只改一项）

预注册于查看任何探针结果之前（假设集来自 P6.1 源文档 §8.2 表；每项只改一个
变量，同池同 seed 同 episodes/rounds，对照均为同一冻结臂）。**以下全部是假设
判别，不是已确认根因**。

### H1 奖励与验收目标不一致（现目标 vs 统一 verifier 目标）

- **最小对照**：仅换奖励标尺——公平引擎历史标尺（`scoreTrajectorySignals` 默认
  权重，r2 口径）→ t6 统一 RewardContract 标尺（`scoreUnderRewardContract`，
  r3/unified-signals-v1：completion .5 / turn .3 / steps .1 / tool .1，tool 正项
  二值化）。池、seed、任务、内核全部不变。
- **结果**：verifiedRate 0.8167，Δ = **−0.1833**（历史 −0.250）；`meanSupport`
  1.52 → 1.83。负收益幅度收窄约 27%。**+0.88 的来源**：H1 探针（r3 标尺）自己的
  台账在坐标 `ci-04|2|2` 实选了 `guardrails:append(1)`（而非 H0 实测的 `noop`），
  其部分修复观测回报为 +0.883（0.8833333333333333，探针台账条目，可由
  `node --input-type=module -e` 重放 `diagnostics:{rewardScale:'r3-contract',ledger:true}`
  并过滤 `task==='ci-04'&&run===2&&round===2` 复核；H0 同坐标台账值为 +0.30）。
  注意：H1 探针因标尺改变而改变自身轨迹，其 Δ 与轨迹变化互为因果，这正是判别
  只取"幅度是否收窄"而不取单点奖励的原因。标尺差异改变 noop 自举速度
  （同一 noop 轨迹的候选回报排序可被翻转），从而改变负收益幅度。
- **判别**：`scale-sensitive`——标尺差异**改变了负收益幅度**（这就是 t6 统一分尺
  的“学习信号重校准”最小反例素材：±3 赢家偏置 → 0.93/−0.47 对比度，同一轨迹
  在两条路径下的回报排序可以翻转），但单换标尺**不能消除**负收益，因此标尺
  不是充分根因；同时 H0 主台账在 `ci-04|2|2` 的 **verifier-reward mismatch
  （奖励 +0.30 / 验收失败）**是“现目标与验收目标不一致”的直接证据。
  **不可排除**：若在 r3 标尺下重训（重放库按 upgradeRule 重建，不混估），
  负收益形态可能不同。
- **可排除结论**：不能把 −0.250 直接归因给 r2 标尺本身（r3 下仍为负）。

### H2 state 太粗（状态抽象粒度）

- **最小对照**：仅改状态——剥离 L2 状态里的 run 索引 token
  （`round:` / `depth:` / `pslot:` / `parent_patch_signature:`）。历史状态让同一
  任务跨 run 的状态互异，早期 run 的记录对后续 run 只能靠桶内松弛命中。
- **结果**：verifiedRate 0.8167，Δ = **−0.1833**；`neighborHitRate` 不变
  （0.9333），`meanSupport` 1.52 → 1.31，策略改变率 0.200 → 0.1778。
- **判别**：`supports`——放宽粒度收窄了负收益（−0.250 → −0.1833），历史状态
  粒度是促成因素之一；但没有归零，不是充分根因。
- **可排除结论**：不能说“state 完全没问题”；也不能说“只改 state 就够”。

### H3 actionKey 过度结构化

- **最小对照**：仅改 action key——池槽位的 patch 签名形状（如
  `guardrails:append(1)` 与语义等价的 `guardrails:append(1)#2` 是两个键）→
  `surfaces:<sorted surfaces>` 规范键（同槽位冲突加 `#index` 后缀以保持内核
  唯一键约束）。
- **结果**：verifiedRate **1.000**，Δ = **0.000**——负收益完全消失；
  `meanSupport` 1.52 → 1.22（键合并后组更小但不再有“零支持但 A=0”的假赢家）。
- **判别**：`supports`——键碎片化是本套负收益的**直接机制**：重复键拆出的
  `#2` 变体零支持却按 baseline 回退拿到 A = 0，在受支持动作 A < 0 时赢下
  argmax，产生错误改选。
- **可排除结论**：在**这套任务与这个池**上，键过度结构化足以单独产生全部
  负收益。**不外推**：这是 12 个合成任务上的机制结论，不是已确认生产根因。

### H4 少量样本错误改选（低支持偏离）

- **最小对照**：仅加门槛——偏离先验且 `chosen.support < 2` 时回退先验。
  预注册依据：run1–run2（负收益形成窗口）的全部 24 次偏离 support = 0（台账实测）；
  run3/run4 的 12 次固化偏离 support 1..2，但它们是同一 noop 自举的延续，不是新改选。
- **结果**：verifiedRate **1.000**，Δ = **0.000**（与历史 −0.250 相差 0.25）；
  策略改变率 0.200 → 0（本套偏离全部被门槛挡下）。
- **判别**：`supports`——少样本错误改选是负收益的**直接机制**；与 H3 互为
  同一现象的两个面（键碎片化制造零支持假赢家，低支持门槛在行为端拦截）。
- **可排除结论**：同 H3——本套任务内充分，不外推。

### H5 fixed-pool schedule 对 prior 天花板偏好

- **最小对照**：仅改池调度——`prefs.slice(0, round)` 谱系调度（round 越深池越
  退化：round2 池是 `[guardrails, noop, guardrails#2]`）→ 每个决策点都提供
  round-0 池（static）。
- **结果**：verifiedRate **0.25**，Δ = **−0.75**——**远差于**历史。
- **判别**：`cannot-exclude (as primary cause)`——谱系调度确实制造了 noop 这类
  退化候选（它给 H3/H4 提供了舞台），但把它换成 static 池反而放大伤害
  （round-0 池在 round≥1 上全是无增益候选），说明**调度本身不是负收益主因；
  负收益主因是在给定池上的低支持改选规则**。
- **可排除结论**：可以排除“只要换调度就能修好”。

### H6 回放与生产路径差异

- **结构性核对**（非对照臂；判别行为差异需要真实宿主，**not-run**）：
  - 重放直接调用 `runDecisionKernel` + 内存 store、per-task 冷启动、`before`
    因果截断；生产经 orchestrator `recordOnlineExperience`（t6 后 r3 标尺 +
    `estimatorTargetLine` 每次落盘 emit）。
  - **版本不可混估**：重放记录 `rewardVersion=r2/verifiable-v1`（台账
    `neighborVersions` 全部一致），生产新记录已切换 r3/unified-signals-v1；
    跨版本混合估计按 RewardContract upgradeRule 禁止。
    （P6.1-E3 标签核对：t17 曾把生产常量 `CURRENT_REWARD_VERSION` 升 r3，
    而 r2-fair 重放臂的写盘标签继承该常量，短暂出现过"r2 标尺打分、r3 标签"
    的脱钩；P6.1-E3 已显式化为 `FAIR_R2_SCALE_VERSION='r2/verifiable-v1'`
    （两臂各写各的标尺常量，不再继承生产常量），并复跑 diag 核对台账
    `neighborVersions` 恢复 r2 且 297 个数值叶零变化——本条表述因此重新为真。）
  - 内核本体在线/replay 已对齐至 1e-12（`docs/reports/p61-review-round2-pr5.md`）。
- **判别**：`not-run (behavioural)`——真实宿主行为差异归 Gate 4 受控 smoke；
  本轮不把重放差值外推为生产结论。
- **可排除结论**：可以排除“回放与生产用了两个不同决策内核”（PR5 复评已闭环）。

## 6. 改善策略：收益 + 安全双门槛（预先在验证集固定）

改善策略只有在**解释原因之后**才考虑（本报告 §5 即解释部分）。门槛在验证集
（同套件的 mig-01..04 家族，与公平评测 §8 切分一致）上**预先固定**：

- **收益门槛**：验证集验证通过率相对冻结臂 **≥ +0.25**（须收复观测到的 −0.250
  并有余量）；
- **安全门槛**：任何验证任务不得低于冻结臂，且退化任务比例不得超过历史值。

| 候选策略 | 状态 | 门槛核验 |
| :-- | :-- | :-- |
| 最低有效支持门槛（H4 正式化） | 已测（同池同 seed） | 收益门槛 **未过**（验证集 Δ = 0 < +0.25）：它只“止血”，不产生收益；安全门槛通过。**保持探针，不设默认** |
| 先验回退（偏离后按 KL/支持度回退） | not-run | 需先有 H1 标尺重校准后的复跑基线 |
| KL 上限（限制 z′ 偏离） | not-run | 同上 |
| 受限 beta（温度约束） | not-run | 同上 |
| 验证集 shadow（不发布只记录） | not-run | Gate 4 之后 |

双门槛口径的诚实结论：**当前没有任何策略同时通过两道门槛**；H3/H4 的 Δ=0 是
“回到先验水平”，不是“学会变好”。此外按纪律声明：**不重放训练集调参最优点当
独立验证**（公平评测 §8 的 27 点网格并列已说明该配置无信息），**小合成集不承诺
统计显著性**（12/4 任务只是可行性证据）。

## 7. 边界与不变式

- 负结果是**有效结果**，不阻塞研究交付；但按 ADR D4 阻塞扩大默认启用，也阻塞
  学习收益宣传（本报告就是该边界的第一份证据文件）。
- 本报告**不把负结果归因为模型能力不足**，也不解读为算法原理失败：台账显示
  失败模式是**可指认的选择规则缺陷**（零支持假赢家 + 低支持改选 + 部分修复的
  正回报自举），全部有最小反例。
- 离线 counterfactual 单独记账；真实任务只记录实际执行结果；不给未执行候选补
  LLM 猜测 reward。
- 所有判别都在合成集上；生产收益结论仍然不可得（需真实宿主/真实仓库任务集，
  Gate 4）。
- `pnpm run typecheck` exit 0；`node scripts/eval-jitrl.mjs --json` exit 0
  （B0–B3 与安全门禁不变，本轮未改动 `src/**` 与历史报告）。

## 8. 交付物与代码落点

- 诊断脚本：`scripts/eval/negative-result-diag.mjs`（人类摘要 / `--json` 两种输出）。
- 引擎扩展（全部 additive，默认逐字节保持历史行为；CI parity 断言只看默认路径）：
  `scripts/eval/jitrl-eval-lib.ts` 新增 `FairDiagKnobs` / `FairDecisionLedgerEntry` /
  `runFairEngineWithLedger`。旋钮：`ledger` / `rewardScale`(H1) / `stateMode`(H2) /
  `actionKeyMode`(H3) / `minSupportToDeviate`(H4) / `poolSchedule`(H5)。
- 台账字段与 P6.1 验收清单逐项对应（含 `rewardModelVersion`/`targetField`，与 t6
  的 estimatorTargetLine 口径一致）。

## 9. 如何复现

以下命令全部为本次（2026-10-25）实际执行过并记录退出码的命令；在静止的同类
工作树上重跑应得到逐字节相同的指标输出（引擎确定性已由 CI 断言覆盖）。

```bash
# 1) 决策级诊断（本文全部数字的来源；--json 可得机读版）
node scripts/eval/negative-result-diag.mjs          # 人类摘要，实测 exit 0
node scripts/eval/negative-result-diag.mjs --json > work/p61-e-diag.json
#    实测 exit 0；连跑两次文件哈希一致（确定性复核）

# 2) 默认评测命令门禁（验收命令）
node scripts/eval-jitrl.mjs --json                  # 实测 exit 0

# 3) 类型检查
pnpm exec tsc --noEmit                              # 实测 exit 0

# 4) 公平臂回归（确认 additive 旋钮不改变默认路径）
pnpm exec vitest run tests/e2e/jitrl-ablation.test.ts   # 实测 24/24 passed

# 5) F3-a 来源复核：H1 探针台账在 ci-04|2|2 的观测回报（+0.883）
node --input-type=module -e "const {loadEvalLib}=await import('./scripts/eval/build-eval.mjs');const lib=await loadEvalLib();const r=await lib.runFairEngineWithLedger({spec:lib.fairArm('C3-online'),tasks:lib.EVAL_TASKS,episodes:5,rounds:3,seed:0x5eed1a,k:10,beta:1,similarityThreshold:0.3,protocol:'same-task',initialSnapshot:[],storeMode:'per-task',updates:true,experienceSource:'self',diagnostics:{rewardScale:'r3-contract',ledger:true}});const e=r.decisionLedger.filter(x=>x.task==='ci-04'&&x.run===2&&x.round===2)[0];console.log(e.observedReturn, e.candidateActionKeys[e.chosenChoice]);"
#    实测输出：0.8833333333333333 guardrails:append(1)（H0 主台账同坐标为 +0.30/noop）
```

说明：**历史 −0.250 口径**的原始对照由 `runFairEval({episodes:5,rounds:3})`
生成（见 `docs/reports/p6-fair-eval.md` §15 的生成命令与本报告 §1 的协议表）；
本报告的全部数字以命令 1 的输出为准，两处口径在 §1 已核对一致
（`matchesHistorical: true`）。

**机读输出范围（F3-b 更正）**：本次执行保存的 `work/p61-e-diag.json` 包含完整
复现框（frame：协议参数、池指纹 witness）、`reproduction`（逐任务配对差值）、
`deviationStats`、`firstHarmfulDeviation`（完整字段）、5 条最小反例、6 条假设
判别结果、counterfactual 表与门槛核验；其 `decisionLedger` 字段只含**计数
（180）+ 前 4 条样例**，不是全量台账——全量 180 条台账在脚本进程内
（`runFairEngineWithLedger(...).decisionLedger`），需要全量时按命令 5 的形态
导入并读取该数组，不要把该 JSON 当作全量台账导出。

**工作树说明**：本报告生成时工作树含其他 P6.1 在途成员的 `src/**` 改动
（reward-contract r3、host-advisor、bridge.store 等）。本任务只改动
`scripts/eval/` 与本文件；`node scripts/eval-jitrl.mjs --json` 在该工作树上
实测 exit 0。`src/**` 后续变化时，§9 的命令需在静止工作树上重跑。

## 10. 报告数字与脚本输出逐项核对清单（P6.1-E2 修复后复核）

| # | 报告数字/陈述 | 脚本输出依据 | 一致 |
| --: | :-- | :-- | :-- |
| 1 | −0.250 复现（0/7/5） | `reproduction.meanDelta=-0.25`，`wins/ties/losses=0/7/5` | ✔ |
| 2 | 池指纹 witness（ci-01） | `frame.poolDigests = 75d57bdc/b73b0a8b/bd56d73e` | ✔ |
| 3 | ci-04 池指纹链 | `minimalCounterexamples[ci-04].replay.poolDigestsByRound = be05e090/73ba2b59/650d0bfa` | ✔ |
| 4 | 180 条台账 | `decisionLedger.entries=180`（JSON 仅含计数+4 样例，见 §9 F3-b 更正） | ✔ |
| 5 | 台账样例 ci-01 run0 round0 | `neighborIds=[]`，`q=null`，`kl=0`，`observedOutcome=succeeded`，`observedReturn=0.30` | ✔ |
| 6 | 首害 `ci-04\|2\|2` 算术字段 | priorActionKey=`guardrails:append(1)`，chosen=`noop`，support=0，q=null，v=0.266687，A=0，z'=-0.10199，KL=0.122363 | ✔ |
| 7 | 同坐标观测 | outcome=succeeded，return=+0.30，coverage=0.667，verified=false，mismatch=true | ✔ |
| 8 | 5 个退化任务 | `degradation.degradedTasks=[ci-04,mig-01,mig-02,mig-04,test-03]` | ✔ |
| 9 | 退化任务比例 5/12=0.4167 | `degradation.degradedTaskShare=0.4167` | ✔ |
| 10 | 退化任务平均 −0.600 / 改善 +0.000 | `meanLossWhenDegraded=-0.6`，`meanGainWhenImproved=0` | ✔ |
| 11 | run1 首偏离坐标/键/support | ci-04 r2 `guardrails:append(1)#2` s0；mig-01 r1 `skills:mount(eval-skill-exploit-3)+tool_guidance:rewrite(shell)` s0；mig-02 / mig-04 / test-03 同 §3.2 表 | ✔ |
| 12 | 偏离分布 | 36 总 / 18 有害；run1=14 / run2=10 / run3=6 / run4=6；support 范围 0..2；run1+run2 的 24 次 support=0 | ✔ |
| 13 | noop 自举 | ci-04\|3\|2 noop s=1 A=+0.0260；ci-04\|4\|2 noop s=2 Q=0.30 A=+0.0247（台账实测） | ✔ |
| 14 | 学习曲线 verified | run0 1.000 / run1 1.000 / run2 0.583 / run3 0.583 / run4 0.583（即 12/12, 12/12, 7/12, 7/12, 7/12） | ✔ |
| 15 | H1 Δ −0.1833，verifiedRate 0.8167，meanSupport 1.52→1.83 | `hypotheses[H1]` + 探针 health | ✔ |
| 16 | H1 +0.883 来源 | H1 探针台账 ci-04\|2\|2：`0.8833333333333333 guardrails:append(1)`（§9 命令 5 实测复现） | ✔ |
| 17 | H2 Δ −0.1833，meanSupport 1.31，策略改变率 0.1778 | `hypotheses[H2]` + 探针 health | ✔ |
| 18 | H3 Δ 0，verifiedRate 1.000，meanSupport 1.22 | `hypotheses[H3]` | ✔ |
| 19 | H4 Δ 0，verifiedRate 1.000，策略改变率 0 | `hypotheses[H4]` | ✔ |
| 20 | H5 Δ −0.75，verifiedRate 0.25 | `hypotheses[H5]` | ✔ |
| 21 | H6 not-run(behavioural) | `hypotheses[H6].verdict` | ✔ |
| 22 | counterfactual 表 | cand0 0.55 cov 1.000 / cand1 0.45 cov 0.667 / cand2 0.50 cov 1.000 | ✔ |
| 23 | H4 双门槛验证集 Δ=0，收益门槛未过 | `improvementStrategyGates.h4GateOnValidationSplit.benefitDelta=0`，`benefitGatePassed=false` | ✔ |

清单中每项均在 t18 修复轮次以 `node scripts/eval/negative-result-diag.mjs --json`
的重新执行输出逐项核对（两次执行文件哈希一致）；修复仅动本文件，未改任何
脚本或引擎代码，故输出与本轮核对基准相同。
