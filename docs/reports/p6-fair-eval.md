# P6 公平评测报告（PR6 / R6）：同 K、同候选池的 C0–C4

> 本文件由 `runFairEval({ episodes: 5, rounds: 3 }) → renderFairMarkdown()（复现步骤见 §15）` 生成；§3 起的每个数字都来自该命令的一次真实执行，没有手写估值。

## 1. 这份报告修的是什么

R6 缺陷（方案 §4 R6）：B1/B2 的 `candidateCount=1`，B3 是 3，且 B3 的第三个候选是**双表面合并**候选。
因此 “B3 > B1” 同时包含三件事：候选集合更丰富、有了一个选择器、以及共享经验被累积。
它**不能**归因给 JitRL 的 logit 修正，也不能反推 L2 无效。本报告先把候选池固定下来，再只改选择渠道与是否写经验。

C0–C4（方案 §8.1）全部使用**同一个 K=3 候选池**与同一套先验置信度（与在线 proposer 的 `kCandidateShapes` / `kConfidences` 同一实现），
并在每个决策点记录池指纹；跨臂池指纹的一致性由 `tests/e2e/jitrl-ablation.test.ts` 断言。

| 组 | 选择渠道 | 经验更新 | 说明 |
| :-- | :-- | :-- | :-- |
| C0 | prior | 冻结（no-learning） | same K=3 pool; the highest-prior candidate is always taken; no experience is written |
| C1 | random | 冻结（no-learning） | same K=3 pool; uniform choice from a fixed seed; no experience is written |
| C2 | advice | 在线更新 | same K=3 pool and the same retrieval; statistics go into the prompt, the logit is NOT corrected |
| C3-frozen | kernel | 冻结（no-learning） | same K=3 pool; JitRL L2 selects; decisions are recorded but the experience snapshot never changes |
| C3-online | kernel | 在线更新 | same K=3 pool; JitRL L2 selects and every executed probe is written back with its own attribution |
| C4 | kernel | 在线更新 | same K=3 pool; L1 allocates the slot kind, L2 selects the candidate, both levels learn |

## 2. 协议与可复现性

| 项 | 值 |
| :-- | :-- |
| 生成时间（本地） | 2026-10-24 00:46:04 (UTC+08) |
| 代码版本 | `7307d7d+dirty`（工作树） |
| 每任务执行次数 L | 5 |
| 每次执行内轮数（深化预算） | 3 |
| 候选池 | 固定 K=3；窄 A / 窄 B / 双表面合并 C（与在线 proposer 同一规则） |
| 决策内核 | `src/jitrl/decision-kernel.ts` 的 `runDecisionKernel`（与在线同一套过滤／检索／Q／V／logit 修正） |
| 随机性 | 每决策 `seedFromParts(6221082, taskId, run, round, channel)`；任务集指纹 0xfe348428 |
| 确定性 | true（同参数两次运行的指标块逐字节相同，CI 断言；§9 的墙钟与生成时间不在该块内） |
| 环境 | 与 B0–B3 相同的确定性合成 runner（内存、无网络、无真实模型） |

公平臂是**重放**：候选池由任务表固定，不由模型在线生成；因此“在线生成候选”只出现在 §10 的独立系统级项目里，两者不逐行比较。

## 3. 协议一：同任务适应（每任务冷启动独立库）

| 组 | 选择 | 经验 | 验证通过率 | 失败率 | 预算内完成 | 平均覆盖率 | Final | Final−Avg | probes/任务 | 模型调用/任务 | KL 均值 | L1 KL 均值 | 策略改变率 |
| :-- | :-- | :-- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| C0 | prior | 冻结 | 1.000 | 0.000 | 1.000 | 1.000 | 1.000 | 0.000 | 15.00 | 15.00 | 0.000 | 0.000 | 0.000 |
| C1 | random | 冻结 | 0.567 | 0.433 | 1.000 | 0.753 | 0.681 | -0.072 | 15.00 | 15.00 | 0.000 | 0.000 | 0.656 |
| C2 | advice | 写经验 | 0.967 | 0.033 | 1.000 | 0.967 | 0.833 | -0.133 | 15.00 | 15.00 | 0.068 | 0.000 | 0.011 |
| C3-frozen | kernel | 冻结 | 1.000 | 0.000 | 1.000 | 1.000 | 1.000 | 0.000 | 15.00 | 15.00 | 0.000 | 0.000 | 0.000 |
| C3-online | kernel | 写经验 | 0.750 | 0.250 | 1.000 | 0.908 | 0.847 | -0.061 | 15.00 | 15.00 | 0.061 | 0.000 | 0.200 |
| C4 | kernel | 写经验 | 0.750 | 0.250 | 1.000 | 0.908 | 0.847 | -0.061 | 15.00 | 15.00 | 0.061 | 0.000 | 0.200 |

主指标是**任务验证通过率**（覆盖率 = 1，即该任务的必需表面全部被改到，等价于“验收器通过”）、失败率与预算内完成率；
覆盖率与 Final−Avg 保留用于与 p5 报告对齐。`KL 均值` 只是分配分布相对先验的变化量，非零只证明**分布变了**，不证明变好。

### 3.1 冻结与在线使用同一初始快照（可核对）

| 组 | 初始快照记录数 | 初始指纹 | 终态指纹 | 新增记录 | 冻结 |
| :-- | --: | :-- | :-- | --: | :-- |
| C0 | 0 | `empty` | `empty` | 0 | 是 |
| C1 | 0 | `empty` | `empty` | 0 | 是 |
| C2 | 0 | `empty` | `77d2af6a` | 180 | 否 |
| C3-frozen | 0 | `empty` | `empty` | 0 | 是 |
| C3-online | 0 | `empty` | `a1d9545c` | 180 | 否 |
| C4 | 0 | `empty` | `bf1de31d` | 360 | 否 |

C3 的两版初始指纹分别为 `empty` 与 `empty`，**相同**；冻结版终态与初始 一致。

### 3.2 C2 的 prompt advice 通道（A1）活动量

- advice 渲染 token（单独计费）：9115；advice 给出推荐：108 次；无行达到 minSupport 而回退先验：72 次；因此改变选择的比例：0.011。
- C2 的 KL 均值 0.068 是 **logit 修正本会产生的**分布变化，C2 并不据此选择（它只把同样的检索统计渲染进 prompt）。

## 4. 全序列学习曲线（不再只看两端）

| 组 | run1 | run2 | run3 | run4 | run5 |
| :-- | --: | --: | --: | --: | --: |
| C0 coverage | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |
| C1 coverage | 0.903 | 0.764 | 0.694 | 0.722 | 0.681 |
| C2 coverage | 1.000 | 1.000 | 1.000 | 1.000 | 0.833 |
| C3-frozen coverage | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |
| C3-online coverage | 1.000 | 1.000 | 0.847 | 0.847 | 0.847 |
| C4 coverage | 1.000 | 1.000 | 0.847 | 0.847 | 0.847 |
| C0 verified | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |
| C1 verified | 0.750 | 0.500 | 0.500 | 0.583 | 0.500 |
| C2 verified | 1.000 | 1.000 | 1.000 | 1.000 | 0.833 |
| C3-frozen verified | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |
| C3-online verified | 1.000 | 1.000 | 0.583 | 0.583 | 0.583 |
| C4 verified | 1.000 | 1.000 | 0.583 | 0.583 | 0.583 |

`verified` 行是每个 run 序号上的任务验证通过率（跨任务平均）。
Final−Avg 只比较首末，本表把中间轮次也列出来，避免用两端掩盖中间退化。

## 5. 配对差值与不确定性

| 对比 | 指标 | 配对任务数 | 均值差 | 标准差 | 95% 区间 | 胜/平/负 |
| :-- | :-- | --: | --: | --: | :-- | :-- |
| C3-online − C3-frozen | verifiedRate | 12 | -0.250 | 0.296 | [-0.417, -0.083] | 0/7/5 |
| C3-online − C3-frozen | meanCoverage | 12 | -0.092 | 0.112 | [-0.155, -0.029] | 0/7/5 |
| C2 − C0 | verifiedRate | 12 | -0.033 | 0.074 | [-0.075, +0.009] | 0/10/2 |
| C2 − C0 | meanCoverage | 12 | -0.033 | 0.074 | [-0.075, +0.009] | 0/10/2 |
| C4 − C3-online | verifiedRate | 12 | 0.000 | 0.000 | [0.000, 0.000] | 0/12/0 |
| C4 − C3-online | meanCoverage | 12 | 0.000 | 0.000 | [0.000, 0.000] | 0/12/0 |
| C1 − C0 | verifiedRate | 12 | -0.433 | 0.213 | [-0.554, -0.313] | 0/0/12 |
| C1 − C0 | meanCoverage | 12 | -0.247 | 0.170 | [-0.344, -0.151] | 0/0/12 |
| C3-online − C0 | verifiedRate | 12 | -0.250 | 0.296 | [-0.417, -0.083] | 0/7/5 |
| C3-online − C0 | meanCoverage | 12 | -0.092 | 0.112 | [-0.155, -0.029] | 0/7/5 |

配对单位是任务（同一任务在两个臂上的差值），区间是正态近似；12 个合成任务只提供**可行性证据**，不承诺显著性（方案 §8.3）。

### 5.1 本轮测得的事实（直接由上面的数字推出，不做外推）

- **在协议一（同任务冷启动）中，L2 的 logit 修正相对“仅先验”**：Δ 验证通过率 = -0.250（95% 区间 [-0.417, -0.083]）。**不高于仅先验**；这是允许通过的零/负结果，说明该合成环境的 K=3 池加上先验已经能覆盖必需表面，学习带来的偏离反而有代价。
- **随机选择（固定 seed）**：Δ = -0.433，胜/平/负 0/0/12。这说明先验本身携带信息：候选不是无差别可换的。
- **C3 冻结 vs 在线（同初始快照）**：Δ = -0.250，胜/平/负 0/7/5。冻结臂全程使用同一快照（终态指纹 = 初始指纹），因此这里的差值**只**包含经验更新的作用，不含候选集合变化。
- **协议二（donor 冻结 vs 目标适应）**：Δ = +0.200（95% 区间 [-0.216, +0.616]，4 个目标任务，胜/平/负 2/1/1）。区间跨越 0：样本量下这只能作为可行性证据，不能当作跨任务泛化结论。

## 6. 协议二：跨任务迁移（donor 冻结 vs 目标适应）

| 组 | 选择 | 经验 | 验证通过率 | 平均覆盖率 | Final | probes/任务 | KL 均值 |
| :-- | :-- | :-- | --: | --: | --: | --: | --: |
| C0（cross-task-adaptation） | prior | donor 冻结 | 1.000 | 1.000 | 1.000 | 15.00 | 0.000 |
| C2（cross-task-adaptation） | advice | 目标写回 | 0.550 | 0.650 | 0.375 | 15.00 | 0.090 |
| C3-frozen（cross-task-zeroshot） | kernel | donor 冻结 | 0.600 | 0.708 | 0.625 | 15.00 | 0.115 |
| C3-online（cross-task-adaptation） | kernel | 目标写回 | 0.800 | 0.900 | 0.917 | 15.00 | 0.094 |

zero-shot 与 adaptation 分开报告：前者只在 donor 库上检索且不写任何目标经验，后者在**同一个初始快照**上允许目标学习。
共享一库的旧口径不能代表上述任一能力，也不能同时代表两者（方案 §8.2）。

- **C3-online − C3-frozen（verifiedRate）**：+0.200，95% 区间 [-0.216, +0.616]，胜/平/负 2/1/1。
- **C3-online − C3-frozen（meanCoverage）**：+0.192，95% 区间 [-0.086, +0.469]，胜/平/负 2/1/1。
- **C3-online − C0（verifiedRate）**：-0.200，95% 区间 [-0.440, +0.040]，胜/平/负 0/2/2。

## 7. donor 隔离与来源清单

| 项 | 值 |
| :-- | :-- |
| donor 任务 | ci-01, ci-02, ci-03, ci-04, mig-01, mig-02, mig-03, mig-04 |
| 测试目标 | test-01, test-02, test-03, test-04 |
| 交集 | **空**（测试目标不在 donor 库） |
| 近重复对（Jaccard ≥ 0.8） | **无** |

| taskId | familyId | repoId | signature | split | donor 角色 | 经验来源 | 本任务记录数 | 可见库记录数 | 记录时间窗 (ms) |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | --: | --: | :-- |
| ci-01 | ci-fix | synthetic/ci-fix | ci-fix-publish | single | target | self | 15 | 0 | 1700000000013..1700000000115 |
| ci-02 | ci-fix | synthetic/ci-fix | ci-fix-flaky | single | target | self | 15 | 0 | 1700000000128..1700000000230 |
| ci-03 | ci-fix | synthetic/ci-fix | ci-fix-lint | single | target | self | 15 | 0 | 1700000000242..1700000000340 |
| ci-04 | ci-fix | synthetic/ci-fix | ci-fix-cache | single | target | self | 15 | 0 | 1700000000353..1700000000463 |
| mig-01 | schema-migration | synthetic/schema-migration | migration-account | single | target | self | 15 | 0 | 1700000000476..1700000000584 |
| mig-02 | schema-migration | synthetic/schema-migration | migration-session | single | target | self | 15 | 0 | 1700000000597..1700000000707 |
| mig-03 | schema-migration | synthetic/schema-migration | migration-rollback | single | target | self | 15 | 0 | 1700000000720..1700000000822 |
| mig-04 | schema-migration | synthetic/schema-migration | migration-index | single | target | self | 15 | 0 | 1700000000835..1700000000945 |
| test-01 | test-authoring | synthetic/test-authoring | tests-retry | single | target | self | 15 | 0 | 1700000000957..1700000001055 |
| test-02 | test-authoring | synthetic/test-authoring | tests-pagination | single | target | self | 15 | 0 | 1700000001068..1700000001170 |
| test-03 | test-authoring | synthetic/test-authoring | tests-smoke | single | target | self | 15 | 0 | 1700000001183..1700000001293 |
| test-04 | test-authoring | synthetic/test-authoring | tests-memory | single | target | self | 15 | 0 | 1700000001305..1700000001403 |
| ci-01 | ci-fix | synthetic/ci-fix | ci-fix-publish | train | donor | self | 15 | 120 | 1700000000013..1700000000115 |
| ci-02 | ci-fix | synthetic/ci-fix | ci-fix-flaky | train | donor | self | 15 | 120 | 1700000000127..1700000000235 |
| ci-03 | ci-fix | synthetic/ci-fix | ci-fix-lint | train | donor | self | 15 | 120 | 1700000000247..1700000000345 |
| ci-04 | ci-fix | synthetic/ci-fix | ci-fix-cache | train | donor | self | 15 | 120 | 1700000000358..1700000000467 |
| mig-01 | schema-migration | synthetic/schema-migration | migration-account | train | donor | self | 15 | 120 | 1700000000480..1700000000586 |
| mig-02 | schema-migration | synthetic/schema-migration | migration-session | train | donor | self | 15 | 120 | 1700000000599..1700000000710 |
| mig-03 | schema-migration | synthetic/schema-migration | migration-rollback | train | donor | self | 15 | 120 | 1700000000723..1700000000825 |
| mig-04 | schema-migration | synthetic/schema-migration | migration-index | train | donor | self | 15 | 120 | 1700000000838..1700000000948 |
| test-01 | test-authoring | synthetic/test-authoring | tests-retry | test | target | donor | 15 | 120 | 1700000000012..1700000000110 |
| test-02 | test-authoring | synthetic/test-authoring | tests-pagination | test | target | donor | 15 | 120 | 1700000000123..1700000000225 |
| test-03 | test-authoring | synthetic/test-authoring | tests-smoke | test | target | donor | 15 | 120 | 1700000000238..1700000000347 |
| test-04 | test-authoring | synthetic/test-authoring | tests-memory | test | target | donor | 15 | 120 | 1700000000359..1700000000457 |

`repoId` 是派生值：合成任务集没有真实仓库，repoId = `synthetic/<family>`；真实仓库基准仍需 §8.4 的第 2/3 类任务集。
“可见库记录数”是决策时能检索到的初始快照大小；“本任务记录数”是该任务自己的 session 写下的经验条数（zero-shot 为 0）。
时间窗来自注入的单调时钟，可逐条与经验记录的 `createdAt` 对齐。

## 8. 协议三：离线策略选择

| 切分 | 任务 |
| :-- | :-- |
| train | ci-01, ci-02, ci-03, ci-04 |
| validation | mig-01, mig-02, mig-03, mig-04 |
| test | test-01, test-02, test-03, test-04 |

选择只读 train（`selectionInputs=train`），测试集不参与超参选择。
选中配置：k=4, beta=0.5, similarityThreshold=0.2。

| 候选超参 | train 验证通过率 | train 平均覆盖率 |
| :-- | --: | --: |
| k=4,beta=0.5,threshold=0.2 | 0.583 | 0.833 |
| k=4,beta=0.5,threshold=0.3 | 0.583 | 0.833 |
| k=4,beta=0.5,threshold=0.5 | 0.583 | 0.833 |
| k=4,beta=1,threshold=0.2 | 0.583 | 0.833 |
| k=4,beta=1,threshold=0.3 | 0.583 | 0.833 |
| k=4,beta=1,threshold=0.5 | 0.583 | 0.833 |
| k=4,beta=2,threshold=0.2 | 0.583 | 0.833 |
| k=4,beta=2,threshold=0.3 | 0.583 | 0.833 |
| k=4,beta=2,threshold=0.5 | 0.583 | 0.833 |
| k=10,beta=0.5,threshold=0.2 | 0.583 | 0.833 |
| k=10,beta=0.5,threshold=0.3 | 0.583 | 0.833 |
| k=10,beta=0.5,threshold=0.5 | 0.583 | 0.833 |
| k=10,beta=1,threshold=0.2 | 0.583 | 0.833 |
| k=10,beta=1,threshold=0.3 | 0.583 | 0.833 |
| k=10,beta=1,threshold=0.5 | 0.583 | 0.833 |
| k=10,beta=2,threshold=0.2 | 0.583 | 0.833 |
| k=10,beta=2,threshold=0.3 | 0.583 | 0.833 |
| k=10,beta=2,threshold=0.5 | 0.583 | 0.833 |
| k=20,beta=0.5,threshold=0.2 | 0.583 | 0.833 |
| k=20,beta=0.5,threshold=0.3 | 0.583 | 0.833 |
| k=20,beta=0.5,threshold=0.5 | 0.583 | 0.833 |
| k=20,beta=1,threshold=0.2 | 0.583 | 0.833 |
| k=20,beta=1,threshold=0.3 | 0.583 | 0.833 |
| k=20,beta=1,threshold=0.5 | 0.583 | 0.833 |
| k=20,beta=2,threshold=0.2 | 0.583 | 0.833 |
| k=20,beta=2,threshold=0.3 | 0.583 | 0.833 |
| k=20,beta=2,threshold=0.5 | 0.583 | 0.833 |

| 集合 | 验证通过率 | 平均覆盖率 | 曲线 |
| :-- | --: | --: | :-- |
| validation | 0.333 | - | - |
| test | 0.667 | 0.875 | 0.917 → 0.917 → 0.792 |

本次 27 个候选配置在 train 上**并列**（0.583），
因此“选中”只说明选择流程可跑通、切分无泄漏，**不说明任何超参有效**；这也是不允许把该配置写成生产默认值的原因。

边界：the selected configuration is a synthetic-suite optimum from a 27-point train-only grid; it is NOT promoted to a production default (plan section 8.3)。

## 9. 成本口径：相同 probe 数 ≠ 相同总成本

| 组 | probes 总数 | 池生成次数 | 候选生成 token | 评估 token | prompt advice token | 模型调用 | 墙钟 (ms) | 失败 probe | 重试 |
| :-- | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| C0 | 180 | 180 | 11800 | 3095 | 0 | 180 | 29.36 | 0 | 0 |
| C1 | 180 | 180 | 11800 | 3115 | 0 | 180 | 17.07 | 21 | 0 |
| C2 | 180 | 180 | 11800 | 3098 | 9115 | 180 | 55.01 | 6 | 0 |
| C3-frozen | 180 | 180 | 11800 | 3095 | 0 | 180 | 22.03 | 0 | 0 |
| C3-online | 180 | 180 | 11800 | 3101 | 0 | 180 | 48.24 | 0 | 0 |
| C4 | 180 | 180 | 11800 | 3101 | 0 | 180 | 78.33 | 0 | 0 |

token 口径：chars/4 over the exact rendered prompt text (no tokenizer in this harness)；probe 数、失败数与墙钟是实测。
重试口径：the fair replay runner is deterministic and in-memory, so no retryable infrastructure failure occurs; probe failures are task failures, not transport failures。

所有公平臂的 probes/任务相同（每轮恰好一个 probe），但成本并不相同：C2 额外渲染 prompt advice 文本（token 列可见），
C4 额外跑 L1 元决策（墙钟与决策数可见，但不新增模型调用）。这就是“相同 probe 数不等于相同总成本”的可核对面。

## 10. 在线生成候选（独立评测项，不是公平臂）

the live plugin pipeline is the ONLY place where candidates are generated online: candidateCount differs (B1/B2 = 1, B3 = 3) and the third B3 candidate merges two surfaces, so these numbers are a system-level item and are NOT attributed to the JitRL logit correction (plan R6)

| 组 | 候选数 | Avg | Final | Final−Avg | 解出率 | probes/任务 | 模型调用/任务 | 墙钟 (ms) |
| :-- | --: | --: | --: | --: | --: | --: | --: | --: |
| B1 | 1 | 0.889 | 0.889 | 0.000 | 0.667 | 7.00 | 3.00 | - |
| B2 | 1 | 0.889 | 0.889 | 0.000 | 0.667 | 7.00 | 4.00 | - |
| B3 | 3 | 0.892 | 0.819 | -0.072 | 0.750 | 7.00 | 3.98 | - |

这组数字来自**当前工作树**的同一实现与同一任务集；`docs/reports/p5-eval-report.md` 与 `docs/reports/p6-eval-baseline.md` 是在 PR4（逐执行归因）／PR5（决策内核）落地**之前**测得的，
因此它们的 B3 数值与本表可能不同——本报告不重写那两份历史数字，也不把差异当作收益或退化证据。无论哪次测量，B0–B3 仍然**只能**说明“更丰富的候选＋选择＋经验”的组合效果（R6）。

本表绑定 §2 的生成时间与该次工作树字节；`src/**` 在本报告生成后若再变化，必须按 §15 重跑整份报告（公平臂 §3–§9 同样依赖 `src/jitrl/decision-kernel.ts` 等被评字节）。

## 11. 顺序依赖

| 组 | 协议 | 顺序 | 最大 |Δ| | 均值 Δ | 变化任务数 | 说明 |
| :-- | :-- | :-- | --: | --: | --: | :-- |
| C3-online | cross-task-adaptation | suite vs reversed | 0.400 | -0.100 | 3 | per-task outcome changed with the order: the shared store is order dependent (reported, not hidden) |
| C3-online | same-task | suite vs reversed | 0.000 | 0.000 | 0 | cold-start per-task stores make the protocol order independent (as required) |

## 12. 指标口径与安全边界

- 主指标：任务验证通过率、失败率、预算内完成率（本次每臂的 probes/run 固定为 3，预算内完成率因此是上限检查，而不是虚构的差异）；
- 辅助指标：成本／延迟、工具错误率与错误重复、检索命中率、有效样本支持（meanSupport）、KL、策略改变率；
- 安全：本次公平重放不构造 invariant 探针，也不提供任何可关闭 invariant 隔离的生产开关；A4 消融若要做只能放隔离 benchmark fixture 且不流入发布包（方案 §8.5）；
- Embedding（A6）后置：先证明现有状态与标签可靠，再谈更贵检索。

## 13. 与 p5-eval-report.md 的差异，以及仍然不可得的结论

- 本文件**不修改** `docs/reports/p5-eval-report.md` 的历史数字；B0–B3 保留为历史组合对照，另见 `docs/reports/p6-eval-baseline.md` 的固定基线。
- p5 的 “B3 > B1 / L2 候选选择有效” 在本报告中按 R6 重新表述：那是**候选集合+选择+共享经验的组合效果**，不是 JitRL logit 修正的单独贡献；
  C0–C4 才是同 K、同候选池下唯一可归因于选择渠道与经验更新的对照。
- p5 的 “12 个任务共用一个插件实例/经验库” 不能声称跨任务泛化；本报告把同任务适应（协议一）与跨任务迁移（协议二，donor 冻结 vs 目标适应）拆开报告，并有 donor 交集/近重复断言。
- **仍然不可得**：真实模型/真实 DSH 宿主/真实 MCP 后端上的收益；真实仓库任务集（JobBench/LAB/WorkBuddy-Bench）上的效果；真实 LLM judge 的影响；embedding 检索对比；
  以及任何“生产默认超参已调优”的结论（方案 §8.3–§8.4 明确要求先修归因、再谈超参与外推）。

## 14. 边界声明

- 合成离线任务集上的机制结论，不是真实仓库任务收益（plan §8.4：没有真实模型/宿主条件，只交付到可复现 harness）
- C2 的 advice token 是渲染文本的 char/4 估算；本 harness 没有 tokenizer，也没有真实模型调用
- A4（可关 invariant 隔离）不提供生产开关；如需消融只能放隔离 benchmark fixture，本 PR 未做
- A6（embedding 检索）按 plan §8.5 后置，未评估
- 策略选择得到的是合成集最优超参，不是生产默认值（plan §8.3）
- KL 非零只证明分布变了；本报告不把它当作收益证据
- 本报告生成时工作树包含其他并行 PR 的在途改动；若 `pnpm run typecheck` 因他人在途文件为红，`pnpm run eval:jitrl:baseline` 的基线门禁也会一并失效——必须在工作树静止后统一重跑（t8 的职责），不能把在途红灯当成 PR6 的结论

## 15. 如何复现

```bash
# 1) 预编译评测库（与默认 CLI 同一条路径；不需要任何 --experimental-* 参数）
node scripts/eval/build-eval.mjs

# 2) 运行公平对照并重新生成本文件（episodes=5, rounds=3）
node --input-type=module -e "const {loadEvalLib}=await import('./scripts/eval/build-eval.mjs');const lib=await loadEvalLib();const r=await lib.runFairEval({episodes:5,rounds:3});process.stdout.write(lib.renderFairMarkdown(r,{commit:'<sha>',generatedAt:'<time>',command:'runFairEval({episodes:5,rounds:3})'}))" > docs/reports/p6-fair-eval.md

# 3) 门禁：类型检查 + 协议/公平对照断言
pnpm run typecheck
pnpm exec vitest run tests/e2e/jitrl-ablation.test.ts
```

CI 断言覆盖：池指纹跨臂一致、C3 冻结/在线初始快照相同且冻结臂终态 = 初始、donor 与测试目标交集为空且无近重复、
成本字段齐全且“相同 probe 数 ≠ 相同总成本”、打乱任务顺序后同任务协议不变、同参数两次运行指标块逐字节一致。
