# P2-D：L1 机制诊断与五臂重跑口径

| 项 | 值 |
| --- | --- |
| **文档类型** | 机制诊断 + 可复现运行口径（**不改写任何历史报告**） |
| **协议编号** | `P2-L1-MECHANISM-20261029` |
| **合成测试基线** | HEAD `feb8465ded73ca48a770054c587990b93f54e21e`（干净固定 revision；夹具测试在此 revision 上跑） |
| **历史五臂产物基线** | `84a3d828ed2a27eef765c8b9c4950da4a9ee7287`（`describe = 84a3d82-dirty`，见 `work/pr4a-five-arm-eval.json` 的 `codeProvenance`） |
| **夹具** | `tests/fixtures/p2-l1/p2-l1-mechanism-cells.json`（sha256 `1750efe0892c76696c78c98c9afcaac6a6b9ad473b3ca3ff990a27b40584a387`） |
| **测试** | `tests/unit/eval/p2-l1-mechanism.test.ts`（12 用例，确定性） |
| **授权边界** | 零真实付费调用、零真实宿主 smoke、零外部工具/记忆写入；真实重跑**未执行（需授权）** |

---

## 1. 结论边界（先读这一节）

1. **夹具侧已复现机制**：在**同一个**生产决策内核（`runDecisionKernel` → `composeDecision` → `estimateActionValues`）上，用四格判别性夹具证明：
   - 单动作支持时 **q ≡ V**（位级相等）、**advantage 恒为 0**、**KL = 0**；
   - 多动作支持且收益有差异时 **KL > 0 可恢复**；
   - **KL = 0 有两个不同成因**：单动作支持坍缩（秩 1）与奖励饱和；二者用 `(supportRank, betweenGroupReturnVariance)` 可分离。
2. **生产根因尚未测量**：本文件**没有**测量生产宿主 L1 路径。历史上的"零改选"发生在**离线合成重放**（`work/pr4a-ledger-Arm-*.jsonl`），它是夹具，不是生产；生产 L1 的实际支持结构从未被落盘观测。
3. **历史报告不改写**：`docs/reports/pr4a-five-arm-eval-report.md` 的正文、数字与标签保持原样。本文件是对其 §6.2「奖励在该合成夹具中趋于饱和」这一**笼统归因**的**补充判别**：在不修改历史文本的前提下，给出可复算的机制分解，并明确"饱和"只被列为两个候选成因之一，而不是已测定的原因。
4. **禁止的表述**：不得把本文件的夹具结论写成"生产根因已确认"；不得把历史台账的归因写成"奖励饱和已被证明"；不得把同进程执行称作沙箱。

---

## 2. 判别性合成夹具（四格）

夹具输入：`meta` 层决策点、4 个 slot-kind 候选（`slot:exploit/explore_domain/explore_invariant/recover`，baseLogit 全 0）、`lambda=0`、`alpha=0`、`unseenFallback='baseline'`、`selection='argmax'`、`halfLifeMs=0`（无衰减，权重 = Jaccard = 1）。所有记录与决策状态同 bucket/tokens，生产过滤 `learningFacingFilterOptions()` 生效。

| 夹具格 | 支持结构 | returns | q ≡ V？ | 全部 advantage = 0？ | KL | 机制 |
| --- | --- | --- | --- | --- | --- | --- |
| `cold-start-no-evidence` | 0 邻居 | — | 无支持动作，q=null | 是（fallback Q=V） | 0 | 无证据 |
| `single-action-support-heterogeneous-returns` | **秩 1**（3 条全在 `slot:exploit`） | **异质** 2.5 / 2.2 / 2.4 | **位级相等** | **是（精确 0）** | **0** | **支持坍缩** |
| `multi-action-support-saturated-returns` | 秩 2（3×exploit + 2×recover） | **同值** 1.0 ×5 | 是 | 是（精确 0） | 0 | **奖励饱和** |
| `multi-action-support-heterogeneous-returns` | 秩 2 | 异质 2.5/2.2/2.4 + 0.1/0.4 | 否 | 否 | **0.139692605** | 可恢复 |

**数学依据（为什么单动作支持必然 q ≡ V）**：V 是全部选中邻居学习目标的加权均值；当所有邻居同属一个 actionKey 时，该组的加权均值与全体加权均值是**同一输入序列的同一个计算**，因此 `q - V` 精确为 0（不是"接近 0"）。不支持动作在 `unseenFallback='baseline'` 下取有效 Q = V，advantage 也精确为 0。于是 `normalizeAdvantages` 全 0 ⇒ `z' = center(z) + beta·0 = center(z)` ⇒ softmax 与先验完全相同 ⇒ `KL(π'‖π_prior) = 0`、argmax 落回先验。**奖励值再大也无法改变这一点**。

**可恢复性**：多动作 + 异质收益格在 beta∈{0,0.5,1,2} 上 KL 严格递增（beta=0 时为 0），说明"可恢复"是参数化性质，不是偶然。

**判别观测量（必须与 KL 一起落盘）**：

| 观测量 | 定义 |
| --- | --- |
| `supportRank` | 检索邻域中携带自身 Q 的**不同 actionKey 数** |
| `betweenGroupReturnVariance` | `Σ_g (n_g/n)·(mean_g − mean)²`（按 actionKey 分组的组间收益方差） |

三格的观测对分别是 `(1, 0)`、`(2, 0)`、`(2, >0)`——**KL 无法区分前两者，这个二元组可以**。

**保守门与结构零正交（重要）**：在秩 1 格里，被支持动作的 `nEff = 3 ≥ 2` ⇒ `hasReplacementEvidence = true`，但 `shrunkAdvantage = 0`。也就是说：**证据门槛（nEff）无法探测支持坍缩**；一个"门控开启"的臂完全可能"证据充分"却永远不偏离先验。这解释了为什么不能把"门控臂零改选"读成"门控未接线"或"奖励饱和"。

**夹具测试证据**（12/12 全绿，确定性：`lambda=0` + 两个不同常量 rng 输出逐位一致）：

```bash
node node_modules/vitest/vitest.mjs run tests/unit/eval/p2-l1-mechanism.test.ts
# 12 passed
```

---

## 3. 历史五臂台账的机制归因（只读、可复算、不改写历史）

### 3.1 被分析的产物与其指纹（工作树 SHA-256）

| 产物 | sha256 | 字节 |
| --- | --- | --- |
| `work/pr4a-five-arm-eval.json` | `f22bdb14a637c08f24576e6325a0cf3ff03e19551bd72eca10e9512dd1c55acb` | 365314 |
| `work/pr4a-ledger-Arm-0.jsonl` | `9c182a32b880039f55dee5a67a93cd65f32cddda5b92867312ffb1e25ce303ee` | 137930 |
| `work/pr4a-ledger-Arm-1.jsonl` | `cb0066107443534ea17a138e8da55c689dd410a782c0bbf0d7a30c29b7f49911` | 151523 |
| `work/pr4a-ledger-Arm-2.jsonl` | `12335caabdadf08ffb0d06d480f341e59f88746586e8cb98f5dcd0944266262f` | 152493 |
| `work/pr4a-ledger-Arm-3.jsonl` | `3e0257753aec88cd413e99786c78b35c275e29bd713bc1f29ff459f053888b1c` | 152721 |
| `work/pr4a-ledger-Arm-4.jsonl` | `301b7976366e5ad41ad8d964b232056050aa47bbd5923978eb9f5f5bfbf527a4` | 152721 |

> 这些是**未跟踪的离线产物**，对应 `84a3d828-dirty`（不是当前 HEAD）。它们**不是**生产观测。

### 3.2 归因表（180 行/臂）

每行按被跟踪的三个候选（`chosenChoice` / `priorChoice` / `challengerIndex`，池 K=3）统计支持度分布：

| 臂 | 轨道 | 零支持行 | **单候选支持** | **多候选支持** | 多候选支持且 advantage=0 | 支持行中 q≡V（位级） | 改选数 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Arm-0 | process（冻结） | 180 | 0 | 0 | 0 | 0 | 0 |
| Arm-1 | process | 20 | 122 | **38** | **0** | 46 | 56 |
| Arm-2 | process | 12 | 123 | **45** | **0** | 49 | 10 |
| Arm-3 | task-quality | 36 | **144** | **0** | **0** | **144** | 0 |
| Arm-4 | task-quality | 36 | **144** | **0** | **0** | **144** | 0 |

复算命令（POSIX shell；输出与上表一致）：

```bash
node -e "const fs=require('fs');for(const a of['Arm-1','Arm-2','Arm-3','Arm-4']){const rows=fs.readFileSync('work/pr4a-ledger-'+a+'.jsonl','utf8').trim().split('\n').map(JSON.parse);let zero=0,one=0,multi=0,multiZero=0,qv=0;for(const r of rows){const es=[[r.chosenChoice,r.support],[r.priorChoice,r.priorSupport],[r.challengerIndex,r.challengerSupport]].filter(e=>Number.isInteger(e[0]));const ws=es.filter(e=>(e[1]??0)>0);const d=new Set(ws.map(e=>e[0]));if(ws.length===0)zero++;else if(d.size>=2){multi++;if(Math.abs(r.advantage)<=1e-12)multiZero++;}else one++;if(r.support>0&&Math.abs(r.advantage)<=1e-12&&Math.abs(r.q-r.v)<=1e-12)qv++;}console.log(a,JSON.stringify({zeroSupport:zero,singleCandidateSupport:one,multiCandidateSupport:multi,multiCandidateZeroAdvantage:multiZero,supportedRowsWithQEqualsV:qv}))}"
```

### 3.3 机制读数（可判别的结论与不可判别的边界）

**可判别的结论（每条都由上面的表直接读出）**：

1. **质量轨臂（Arm-3/Arm-4）的零 advantage 与"候选支持秩 1"在每一行同时出现**：144 个有支持的行**全部**是单候选支持，且 `advantage` 精确为 0、`q ≡ v` 位级相等。按 §2 的机制，秩 1 足以**结构性地**把 q 钉在 V 上——不需要任何"奖励饱和"假设。
2. **同一夹具几何下，多候选支持从不产生零 advantage**：Arm-1 的 38 行、Arm-2 的 45 行多候选支持行中，`advantage = 0` 的行数为 **0**。如果"奖励饱和"是主导机制，应当能在多候选支持的行里看到 advantage≈0；实测一例也没有。
3. 因此历史的"零改选"机制归因应改为：**质量轨在该离线重放中的候选支持矩阵退化为秩 1（支持坍缩）**；"奖励饱和"作为解释既无必要、也无台账证据支持。

**不可判别的边界（必须同时读出）**：

- 台账只记录**被跟踪的三个候选**的支持度，不记录逐邻居 actionKey 列表；"单候选支持"是候选级观测，不是邻居级证明。单支持组内部的 returns 是否恒定（严格意义的"饱和"）**无法**从台账区分。
- 但这不是弱点而是要点：**饱和不是解释零 advantage 所必需的，零 advantage 只出现在秩 1 行**；把二者混为一谈才是原报告的问题。
- 历史产物来自 `84a3d828-dirty` 的离线重放，**不是生产**。生产 L1 的机制仍未测量。

### 3.4 与历史报告的关系

- `docs/reports/pr4a-five-arm-eval-report.md`（blob `b6c477804529e5fb99501c04c3c676a62e290986`）**未被修改**；其 §6.2 原文保留。
- 本节的归因是**追加的诊断**，不是对历史标签的改写：历史报告仍按 V2 协议给出结论；本文件只把"奖励饱和"从"结论"降级为"两个候选成因之一，且在本轮产物中不可支持"。
- 任何后续报告引用本节时必须同时引用 §1 的边界与 §3.3 的"不可判别"段。

---

## 4. V3 台账必须新增的字段（让下一次直接可归因）

为把本文件的判别从"事后推断"变成"运行时记录"，V3 台账（P2-B 对齐重放器）每个决策行必须新增：

| 字段 | 含义 | 用途 |
| --- | --- | --- |
| `perCandidateSupport` | 每个候选（含未入选）的 `support` / `nEff` 数组 | 直接读出支持秩，不再依赖 chosen/prior/challenger 三行 |
| `distinctSupportedActionCount` | 支持度 >0 的不同 actionKey 数 | = `supportRank`，与 §2 机制对齐 |
| `betweenGroupReturnVariance` | 邻域按 actionKey 分组的组间收益方差 | 与 supportRank 组成判别二元组 |
| `klToPrior` | L1/L2 决策的 KL | 现有台账缺此列；机制对比需要 |

这些字段是**诊断列**，不进入 V2/V3 的 Holm 族或主指标（P2-C 预注册 §6 的报告结构不因此改变；新增列只服务机制归因）。

---

## 5. 既有五臂对照的可复现运行口径（离线、零付费）

> 以下只给**运行口径**，不是本轮执行结果；历史报告的数字来自 `84a3d828-dirty`，当前 HEAD 重跑会生成**新**产物，不得覆盖或改写历史报告。

| # | 命令 | 说明 | 预期 |
| --- | --- | --- | --- |
| R1 | `node scripts/eval/eval-pr4a-five-arm.mjs` | V2 五臂离线实验（合成 proposer + mock adapter，零真实调用） | 生成 `work/pr4a-five-arm-eval.json`、5 个 ledger、markdown 报告（覆盖同名产物；**历史报告在 docs/reports 下，不被覆盖**，除非显式指定输出） |
| R2 | `node scripts/eval/eval-pr4a-five-arm.mjs --json-only` | 只产出机器可解析 JSON | 同上，跳过 markdown |
| R3 | `node scripts/eval/verify-pr4a-artifacts.mjs` | 产物↔报告一致性（176 断言） | exit 0 |
| R4 | `node scripts/eval/pr4a-stats.verify.mjs` | V2 统计表 + V3 预注册层自检 | exit 0（含 V3 10 行汇总） |
| R5 | `node scripts/eval/negative-result-diag.mjs --assert` | 历史负结果门禁（A1..A6） | exit 0；**不得修改** |
| R6 | `node node_modules/vitest/vitest.mjs run tests/unit/eval/p2-l1-mechanism.test.ts` | 本文件 §2 的夹具（确定性） | 12/12 |

**确定性口径**：R1 在固定种子/参数下应逐字节可复现（V2 §4.1.4）。若重跑产物与上表 digest 不同，属**预期**（不同 revision / 不同引擎字节），必须作为新产物登记，禁止把新旧数字混表。

**真实付费重跑未执行（需授权）**：

> 申请对 V2 五臂（或 V3 单臂）执行**真实付费模型**重跑：范围 12 任务 × L=5 × R=3、单臂预算上限与 provider/费率卡另行确认；执行前需 P2-C 预注册（`docs/reports/p2-preregistration-v3.md`）已登记任务表 digest、holdout 防火墙通过；执行后只新增报告，不改写 `docs/reports/pr4a-five-arm-eval-report.md`。

---

## 6. 复核命令与退出码

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `node node_modules/vitest/vitest.mjs run tests/unit/eval/p2-l1-mechanism.test.ts` | 0 | `12 passed` |
| `node scripts/eval/pr4a-stats.verify.mjs` | 0 | `SUCCESS` + V3 汇总（floor / power / coverage / split / task-table） |
| §3.2 的 `node -e` 归因命令 | 0 | 与上表逐格一致的 `zeroSupport/singleCandidateSupport/multiCandidateSupport/...` |
| `node scripts/eval/verify-pr4a-artifacts.mjs` | 0 | 176/176 |
| `node scripts/eval/negative-result-diag.mjs --assert` | 0 | A1..A6 PASS |

---

## 7. 依赖、脆弱性与"红了找谁"（verifier 必读）

| 依赖 | 说明 | 若红了该找谁 |
| --- | --- | --- |
| `src/jitrl/decision-kernel.ts`、`value-estimator.ts`、`logit-adjuster.ts`、`retriever.ts`、`state-abstraction.ts` | 本文件的夹具**直接 import 生产内核**（`runDecisionKernel`）并断言 `q ≡ V`（位级）、`advantage === 0`（精确）、`KL === 0 / KL > 0`、beta 单调性。P2-B 正在改 `src/jitrl/**`；若其改动破坏这些性质，`tests/unit/eval/p2-l1-mechanism.test.ts` 会红。 | **这是判别面正常工作，不是夹具坏了**。先看 §2 的数学依据：单组支持时 q 与 V 是同一输入序列的同一计算，位级相等是结构性事实；多组异质收益的 KL>0 同理。红灯说明内核语义变了，应找 **p2-kernel（P2-B 属主）** 确认是否是有意变更，并由其决定是否同步更新 V2/V3 的机制声明。 |
| `scripts/eval/pr4a-v3-design.mjs`（p2-kernel） | `tests/unit/eval/p2-preregistration-v3.test.ts` 绑定其 `V3_TASKS` 与 `designDigest()`；表内容变化会触发 `task-table-digest` 失败（这是冻结闸门的设计意图）。 | 表变更（bump version + 新 digest）⇒ 找 **p2-kernel** 与 **lead** 走 §1 的重新冻结流程；不得静默改。 |
| 统计层 `scripts/eval/pr4a-stats.ts`（V2，字节不变） | V3 层只 import、不修改；MMI/NIM/DTS/宽度门槛全部沿用。 | 若 V2 表自检红 ⇒ 找 **lead**（V2 协议冻结面）。 |
| README 计数门 `pnpm run check:docs` | **不是本文件的测试**：新增测试导致 README 的 103 files/2094 tests 与实际 111 files/2207 tests 漂移；README 由 lead 单独维护。 | 找 **lead**（README 属主）。 |

## 8. 未执行项（明确列出，不留无声缺口）

| 项 | 状态 | 覆盖方式 |
| --- | --- | --- |
| `pnpm run check:mutation` | **未执行** | 变异目标在 `src/**`（P2-B/P3 属主范围），本任务的写入面不含变异目标；由 **t12 全量门禁**覆盖。 |
| 真实付费模型重跑（五臂或 V3） | **未执行（需授权）** | 授权申请文本见 §5；未授权前不得产生任何真实调用。 |
| 真实宿主 smoke / 真实外部工具 / 记忆写入 | **未执行（需授权）** | 同上；本文件只做离线合成夹具与本地枚举。 |
| `check:docs` | **repo 级红（非本任务缺陷）** | README 计数刷新由 lead 处理（见 §7）。 |

## 9. 签核清单

- [x] 夹具侧机制已复现：单动作支持 ⇒ `q ≡ V`（位级）、`advantage = 0`（精确）、`KL = 0`；
- [x] 多动作支持 + 异质收益 ⇒ `KL > 0`，且随 beta 单调可恢复；
- [x] KL=0 的两种成因用 `(supportRank, betweenGroupReturnVariance)` 分离；
- [x] 保守门（nEff）与结构零正交（证据充分但 shrunkAdvantage=0）已被测试钉住；
- [x] 历史台账机制归因可复算（一次性命令），并给出不可判别边界；
- [x] 明确区分"夹具侧已复现"与"生产根因尚未测量"；
- [x] 历史报告未改写；真实付费重跑标记为未执行（需授权）。
