# ADR 0002：P6.2 发布契约与默认安全形态（C0+C1 冻结）

| 项 | 值 |
| --- | --- |
| 状态 | **accepted**（采纳，作为 P6.2 首轮 C0+C1 实现、验证与独立评审共同遵守的发布契约） |
| 日期 | 2026-10-25 |
| 代码基线 | commit `d2f8025`（`d2f80254a51a9e927100d02b00703badcb963ffe`，干净工作树） |
| 决策来源 | 用户提供的 P6.2 与 HarnessPro 融合方案；PR-A/PR-B 评审报告（均 PASS，见 `docs/reports/p62-review-round1-pr-a.md`、`docs/reports/p62-review-round1-pr-b.md`，绑定 `a5bd889`/`d2f8025`）；ADR 0001（D1–D4 裁定延续有效） |
| 决策者 | P6.2 收口团队 p62-safe-release-closure（captain 批准执行） |
| 影响范围 | r4 奖励契约原子切换、统一 evaluation 派生、nEff/替换证据全链、执行模式与权限默认值、验证门禁与状态页语义 |
| 修订 | **t6（2026-10-25）**：①删除 R1 对 `applyWinningPatch` 默认 true 的豁免——本轮默认装配禁用永久 patch 应用/自动发布/真实 memory，显式区分宿主 baseline 与基础 evo search，off 不变；②收紧 C2 前可信边界——C2 前仅有 verification shape，shape-only passed/failed 不建立 task-quality 学习资格，可靠失败学习留作 C2 未完成项；③unknown 不以 mixed task-quality reward 参与学习；④r4 切换在可信生产者缺席时定性为保守隔离；⑤门禁统一七条（negative-result-diag 升主列、guarded-regression 须支持 --json）。r4 数值标尺（含 ±1 映射）不变 |

## 1. 背景

基线 `d2f8025` 上，PR-A（F1 统一学习资格谓词 + F2 surrogate 隔离与 rescore 认证链）与 PR-B（F3 verifier-first 计分 + F4 保守替换证据）均已独立评审 PASS。PR-B 评审确认三项遗留移交**发布边界轮**（即本轮）处理：

1. **r4 未 bump**：`CURRENT_REWARD_VERSION` 仍为 `r3/unified-signals-v1`（`src/jitrl/experience-store.ts:82`），过渡窗口内 r3 戳记录混合两种 completion 语义（F-B2，窗口越长约脏）；
2. **conservativeGate 默认 off**：首害形状（ci-04\|2\|2 类零证据改选）的拦截常驻通道只有奖励侧单通道（F-B1）；
3. **持久 action-key 词表未切**：在线键仍为 slot-shape 签名，语义键仅作 decision mark（`src/orchestrator.ts:2378`–:2385）。

本 ADR 一次裁定范围（R0）、执行模式（R1）、权限分层（R2）、r4 标尺与原子切换（R3）、统一 evaluation 派生（R4）、替换证据契约（R5）、研究路径冻结（R6）、C2 边界（R7）、显式字段与重启/replay 兼容（R8）、验证与状态契约（R9），供 t4（实现）、t2（验证）、t5（独立评审）、t3（集成）共同遵守；实现与验收均不得各自演绎或超出。

## 2. R0：发布范围——本轮仅 C0+C1

- **C0（契约/字段/资格修复）**：nEff 估算全链贯通（orchestrator/L1/L2/replay 保留 nEff）、guarded 替换判定 nEff 缺失 fail-closed、统一 evaluation 对象派生 reward/eligibility/taskSuccess/executionSuccess 并被 recorder 消费、决策模式/actionKey 词表/rewardVersion 显式落记录。
- **C1（默认安全形态 + r4 原子切换）**：默认装配为 baseline 执行 + shadow 无副作用记录；guarded-active 仅显式启用；publish/memory/patch 三层权限默认 fail-closed；reward 契约按第 5 节一次性原子切到 r4。
- **本轮不实施**：C2–C4、真实模型/付费调用、真实 memory 写入、任何发布或部署（含 git commit/push——除非用户另行明确要求）。C2–C4 的前置条件由集成任务（t3）按源方案登记为计划项，**不得标为完成**；D（部署/真实试验决定）需用户另行授权。

## 3. R1：执行模式契约（baseline / shadow / guarded-active / off）

| 模式 | 执行 | 记录 | 副作用 | 默认 |
| --- | --- | --- | --- | --- |
| **baseline（宿主）** | 宿主自身的控制执行：Jit 不拦截、不注入、不探测，宿主原行为逐字节不变 | 仅审计级过程记录（如既有 evaluation 记录） | 无 Jit 副作用 | — |
| **shadow** | baseline 执行逐字节不变 | 额外记录建议：每次 L2 决策的 prior/proposed/executed 三元组、建议强度（shrunk/calibrated）、nEff/support、gateReason | **零**：不 applyPatch、不 publishPolicy、不 writeMemory、不改先验执行 | **默认形态**（默认插件装配 = baseline 执行 + shadow 记录，延续 ADR 0001 D4） |
| **guarded-active** | 保守门生效：第 6 节证据规则下的替换与显式探索预算执行 | shadow 全部记录 + decisionMode=guarded-active + 探索计费 | 仅证据充分替换或显式预算内的偏离执行；publish/memory 仍按 R2 禁止 | **显式启用**（缺省 fail-closed，绝不默认） |
| **off** | PR2 RuntimeControl 七面活动全部停止 | 无 | 无（语义与本轮之前逐字不变） | — |

约束：
- shadow ≠ off（D4 口径延续）：shadow 是 baseline 执行 + 建议记录；off 必须停止七面活动，不得把 shadow 实现成变相 off，也不得把 off 实现成仍记录。
- **默认装配禁用永久 patch 应用、自动发布与真实 memory（t6 修订，废除 t1 对 `applyWinningPatch` 默认 true 的豁免）**：默认插件装配下**不**永久应用 winning patch（基线 `applyWinningPatch: true`，`src/index.ts:1618`，本轮默认装配必须显式禁用）、不自动发布策略、不写真实 memory。evo search 基础流（发现/组合/隔离分支内的探测与回滚式挂载）可与 shadow 共存——隔离分支内的可回滚探测**不是**"永久 patch 应用"权限的对象；但探测结束后的**永久挂载/发布**在默认装配下禁止，仅在 guarded-active（patch 层）及授权（publish/memory 层）下发生。
- **显式区分"宿主 baseline"与"基础 evo search"**：前者指宿主自身行为不受 Jit 影响（Jit 零拦截零注入）；后者指 evo 发现流在隔离分支内运行的可回滚探测。两者的"无副作用"口径不同：宿主 baseline=宿主行为逐字节不变；evo search=分支内可回滚、探测后不残留永久变更。状态页与验证报告不得将两者混称为一个"baseline"。
- guarded-active 依赖 r4 邻域成立（版本隔离就绪）才可启用；实现必须保证默认装配（不含显式开关）与 baseline/shadow 行为等价。

## 4. R2：权限分层（publish / memory / patch），默认 fail-closed

三层权限彼此独立，**不得隐式跃迁**（ADR 0001 D4 延续）：

| 权限 | 含义 | 默认 | 解锁条件 |
| --- | --- | --- | --- |
| **patch** | 任何**永久**八面 patch 应用：Jit 偏离替换、探索预算执行、winning patch 的探测后永久挂载（基线 `applyWinningPatch: true`，`src/index.ts:1618`——本轮默认装配显式禁用，t6 修订） | **deny** | 仅 guarded-active 显式启用 + 第 6 节证据规则（充分证据替换，或显式可撤销探索预算）。隔离分支内的可回滚探测不属于本层权限对象 |
| **publish** | 发布/热更新策略（publishPolicy 类动作） | **deny** | holdout 非劣证据 + 显式授权 + 匹配 artifact 三者齐备；任一缺失即拒绝。本轮**任何路径都不解锁** |
| **memory** | 真实记忆写入（writeMemory / mirror 落真实 namespace） | **deny** | 本轮一律不真实写入（含验证与评审过程）；mirror 维持 ADR 0001 D4 默认关闭 |

- 任何权限判定缺失证据、配置不明、对象无版本或 artifact 不匹配时，**一律按拒绝处理**（fail-closed），不得按"看起来合理"放行。
- 权限不因层级叠加而自动获得：guarded-active 开启只解锁 patch 层的证据内执行，不解锁 publish/memory。

## 5. R3：r4 奖励契约——沿用 verifier-first 数值标尺，一次性原子切换

### 5.1 标尺冻结（数值域不变）

r4 = `r4/verifier-first-v1`（PR-B 预注册常量 `REWARD_CONTRACT_VERSION_PR_B`，`src/jitrl/reward-contract.ts:570`）。**沿用当前 verifier-first 数值标尺，本轮不引入任何新权重/新聚合**：

- 聚合 `trajectory-signals-v1`（`scoreTrajectorySignals` 融合），权重 `{completion:0.5, steps:0.1, tool:0.1, turn:0.3}`，clip `[-3,3]`；
- completion 由**验证判定**（verdict，status 字段）决定：passed→+1、failed→−1、unknown→0（succeeded 且无交付物仍保历史 MISSING −1）——本条只描述**数值映射**（标尺冻结）；C2 前 verdict 的**可信性边界**见 5.2a：`isTrustedVerification` 校验的是载荷 **shape**（结构完整性），不是来源可信；
- 可信 failed 的词典序钳制：reward 钳 ≤0（`step-evaluator.ts:751`–:753 与 `scoreUnderRewardContract` 双层）；
- 正向 tool 项二元化（一次封顶），错误惩罚照旧累积；
- F4 常量同幅冻结：`minEffectiveSamples=2`、`shrinkageK=2`、`ADVANTAGE_SCALE=3`。改动任一常量即视为标尺变更，需新的 ADR 裁定，不得在本轮顺手调参。

### 5.2 版本语义与隔离

- r3 的 completion 奖励"文本存在"，r4 奖励"验证判定"——同一版本号下两种语义的过渡窗口由本切换**终结**。
- 认证表采用 PR-B 预注册的**双向空表**（`reward-contract.ts:577`–:583）：r3↔r4 互不兼容，唯一例外是 r4 自己从保全证据重算的 `r4/verifier-first-v1@rescore-v1` 副本（六字段 provenance 链必须完整，缺一即 fail-closed 退回 audit-only）。
- 旧 r3、r2、surrogate（`r3/backfill-tree-v1`）、missing/future 版本记录，经 PR-A 精确契约 ID 谓词**自动排除**在 r4 邻域之外；不做批量迁移，不原地改写审计日志。
- **无版本对象不自动升级为 r4**：已持久化的 unversioned/legacy 记录永不补戳；仅"当前生产者新产生、三个版本字段全缺"的在途记录可在 append 时盖当前戳（`src/jitrl/index.ts:241`–:262 既有语义保留）。一条 r4 记录必须由 r4 scorer 产出，禁止任何"relabel 即升级"。

### 5.2a C2 前的可信边界：verification shape ≠ 可信来源（t6 修订）

PR-B 交付的是 **`TrustedVerification` 契约的 shape**（status/verifierId/verifierVersion/evidenceHash/checks/implicit + `isTrustedVerification` 结构校验）；"可信"一词在 C2 前只描述**载荷结构完整**，不证明**来源可信**——结构校验挡不住一个自称 verifierId 的任意载荷。C2 前因此：

1. **shape-only passed 不晋升为可信任务成功**：`taskSuccess` 字段照 R4 由 verdict 派生（数值口径不变），但其语义是"载荷声称 passed"；在无可信生产者背书时**不得**作为可信任务成功消费、不得据以扩大启用或宣传收益。
2. **shape-only passed/failed 不建立 task-quality 学习资格**：只有 verdict 不够；记录进入 task-quality 学习还需第 6 节的资格条件（来源可信 + execution 证据一致）。
3. **failed 的负样本资格要求可信 provenance**：failed 成为**可学习负样本**的条件是其载荷具备可信 provenance（可信生产者 + evidenceHash 绑定 + 与执行证据一致）。本轮（C2 缺席、无真实 verifier 生产者）**无法证明**该条件，因此 failed 一律 **audit-only**；**"可靠失败学习"（trusted-failure learning）明确留作 C2 未完成项**，C2 交付可信生产者后按本条解禁。
4. **unknown 不以 mixed task-quality reward 参与学习**：unknown 是过程观测，其执行级信号（tool/steps/turn）的**过程**价值另记（process 轨道/audit），**不得**以混合了 task-quality 源（completion）的 fused reward 进入任务质量训练——标尺上 completion=0 已保证 fused 不含任务质量成分，本条再钉住消费侧：unknown 记录不得作为 task-quality 样本被消费。
5. 状态页与验证报告如实区分："verifier-first shape 已交付"与"可信验证来源已交付"（后者 C2 前 = 否）。

### 5.4 r4 切换的定性：可信生产者缺席时是保守隔离，不代表 C2 已交付（t6 修订）

r4 原子切换在本轮的作用是**版本语义清理 + 保守隔离**：终结 r3 戳下两种 completion 语义的过渡窗口，并把所有旧版本记录隔离出学习邻域。它**不是**"可信验证已上线"的证明——C2 前 r4 的 verdict 字段仍可能来自 shape-only 载荷，其可信性上限由 5.2a 约束。C2 交付可信生产者之前，r4 邻域内**没有**来自真实验证的任务质量证据；任何"r4 = verifier-first 已生效"的表述必须附带本条定性。

### 5.3 原子切换清单（一次变更集，不允许半切换状态）

scorer（契约文档与常量指向）、`CURRENT_REWARD_VERSION`、兼容认证表、rescore 通道（`RESCORE_REWARD_VERSION_PR_B` 生效）、生产者盖戳、默认装配 wiring、测试 fixture，**七处同一切换**；切换后 PR-A 谓词令所有旧 r3 邻域即刻失效（`requiresExperienceRebuild` 语义：generation bump ⇒ 重建而非重解释）。过渡期 r3 记录是否经 rescore 通道抢救，**本轮可选、不强制**；不抢救即自然隔离。

## 6. R4：统一 evaluation 派生（单一来源）

每条已执行轨迹产生**一个** evaluation 对象（`TrajectorySignalScore` 契约），由它派生四个字段，全链只消费不重算：

- `reward`：第 5.1 节标尺下的融合值；
- `learningEligible`：资格判定（见下）；
- `taskSuccess = (verification status === 'passed')`——数值派生规则；C2 前其可信性上限受 5.2a 约束（shape-only passed 不晋升为可信任务成功）；
- `executionSuccess = (trajectory.status === 'succeeded')`——两者**分列**，不得合并为一个"成功"。

资格与证据语义（**不得擅自改为 +1/−1，不得引入新的 ±1 契约**）：

| 判定 | 语义 | 处理 |
| --- | --- | --- |
| failed（verdict，C2 前仅 shape 校验） | 潜在负证据 | 数值上 completion=−1、reward 钳 ≤0、永不为正样本（标尺不变）。**学习资格（t6 收紧）**：仅当载荷具备**可信 provenance**（可信生产者 + evidenceHash 绑定 + 与执行证据一致）才是可学习负样本；本轮无真实可信生产者、无法证明该条件，一律 **audit-only**。**可靠失败学习留作 C2 未完成项** |
| unknown（无验证/载荷畸形/结构回退/shape-only 无法归因） | 过程观测 | completion=0。**不以 mixed task-quality reward 参与学习（t6 收紧）**：其执行级信号的过程价值另记（process 轨道/audit）；不得把含 completion 源的 fused reward 当作任务质量样本消费；不得改为 −1 |
| infra / cancelled / aborted | 无质量证据 | `isLearningOutcome` 判 false，audit-only，**不学习**；不得改为 ±1 |
| noop 轨迹 | 按证据判断 | 与其他轨迹同一 evaluation：其验证判定决定 reward 数值、其证据状况决定资格；不得因"类型是 noop"加分或扣分 |

C2 前的**净效果**：task-quality 学习轨道上没有来自验证的证据可用（passed 无来源背书、failed 无可信 provenance、unknown 无任务质量成分）；学习面上实际可用的只有非验证来源的既有资格路径。这是保守形态，不是缺陷——解禁路径就是 C2（补可信生产者），届时按 5.2a 第 3 条恢复 failed 负样本资格、按第 1 条恢复 passed 的可信任务成功语义。

recorder（在线经验写入）消费同一 evaluation；winner/非 winner/reference 同尺同源（P6.1 已裁定，延续）。

## 7. R5：替换证据契约（nEff 全链 + 保守替换 + 探索记账）

1. **nEff 全链保留**：orchestrator/L1/L2/replay 的估算对象贯穿携带 nEff（Kish 有效样本量，权重集中时它低于原始条数）；台账共报 support 与 nEff。
2. **nEff 缺失 ⇒ guarded fail-closed**：guarded 替换判定**只认 nEff**；缺失或非有限时按"无替换证据"处理，**不得以 support 冒充 nEff**（本条收紧 PR-B 的 `estimate.nEff ?? support` 回退——该回退不得出现在替换判定路径；support 仅作台账共报字段）。研究冻结路径（`normalizeAdvantages` 等）不因此改动。
3. **薄证据默认不替换**：nEff 低于地板（2）或无完整替换证据的挑战者，shrunk advantage 为 0——只能打平，不能赢；其建议强度仍照实记录（estimation 与 replacement 分离）。
4. **双侧证据比较**：prior 与 challenger 同一证据标准过秤；零优势/零支持伪迹（implicit-zero-advantage、noop 无构造性证据）在 prior 持有真实证据时**硬否决**（gateReason='implicit-zero-advantage'）。
5. **noop 按证据判断**：排除 noop 替换的依据是"它无法携带编辑证据"，不是类型标签；noop 不受额外惩罚，其轨迹按 R4 正常计分（C2 前其 failed/unknown 同样按收紧后的资格口径处理）。
6. **探索 reservation 记账**：预算默认 0（fail-closed）；`grant(n)/revoke()` 显式可撤销；每个靠预算执行的欠证据偏离**计费并标记 exploration**；**取消/infra 失败的执行释放预留**（该执行无质量证据，座位退回，记录 audit-only）；真实完成的执行（C2 前无论 verdict 如何均无 task-quality 学习资格，见 5.2a）计费成立。台账可见剩余额度。
7. **guarded-active 下每次决策恒报三元组** prior/proposed/executed（含无偏离情形），attempted 与 actual 可从每条记录数出（PR-B 已落地，延续）。

## 8. R6：研究路径冻结——research-v1 不变

- 公平评测引擎（`scripts/eval/jitrl-eval-lib.ts`）两臂常量 `FAIR_R2_SCALE_VERSION`/`FAIR_R3_SCALE_VERSION` **保持显式且不继承生产常量**（P6.1-E3 裁定延续）；研究臂**不随 r4 切换**，如需 r4 研究臂属新增 ablation，本轮不做。
- `normalizeAdvantages` 冻结语义（论文复现/parity 测试钉住）、`tests/e2e/jitrl-ablation.test.ts`、`node scripts/eval/negative-result-diag.mjs` 的历史复现（meanDelta=−0.25、退化任务清单 ci-04/mig-01/mig-02/mig-04/test-03）**必须原样保留**——C0+C1 的改动对研究复现路径是加性的，既有研究测试不修改断言强度。
- 负结果是有效结论（D4 延续）：不得因 C1 机制证明而改写历史负收益记录或宣传收益。

## 9. R7：C2 边界——只补可信验证来源，不改 r4

C2（后续轮）**只增加**可信验证的**生产者**（可信 verifier 接入 `TrustedVerification` 契约：status/verifierId/verifierVersion/evidenceHash/checks/implicit），**不更改** r4 数值标尺、资格语义、词典序钳制或版本认证表。本轮交付的只是契约 **shape** 与结构校验，来源可信性自 C2 始成立（见 5.2a）。C2 交付后：passed 按 5.2a-1 恢复可信任务成功语义；failed 按 5.2a-3 恢复可学习负样本资格（即可靠失败学习解禁）；新验证来源按同一 evaluation 派生规则进入，不得绕过 R4 直接改 reward。本轮不实施 C2。

## 10. R8：显式字段与重启/replay 兼容

- 每条 L2 决策/经验记录**显式携带**：`decisionMode`（baseline/shadow/guarded-active）、`actionKeyVocabulary`（signature/semantic）、`rewardVersion`。
- replay/restart 以记录声明的口径重建邻域，缺省 fail-closed（不猜模式、不猜词表、不猜版本）；同一日志重载必须复现同一邻域集合。
- **默认词表维持 slot-shape 签名**（不孤儿化既有记录与 eval replay 语料）；语义词表（`normalizeSemanticActionKey`）仅在显式声明下使用，不同词表的桶不得混估（同 r4 版本隔离精神）。

## 11. R9：验证与状态契约

### 11.1 全量门禁（七条统一口径，t6 修订；t2 独立实跑并记录退出码与关键计数）

| # | 命令 | 通过标准 |
| --- | --- | --- |
| 1 | `pnpm run typecheck` | exit 0 |
| 2 | `pnpm test` | exit 0，全绿；README 计数同步 |
| 3 | `pnpm run check:docs` | exit 0（不得与另一全量 vitest 并发争用） |
| 4 | `pnpm run build` | exit 0，产出 lib/index.js |
| 5 | `node scripts/eval/negative-result-diag.mjs --json` | exit 0，JSON 可解析，历史负结果未被抹去（meanDelta=−0.25、退化任务清单原样） |
| 6 | `node scripts/eval-jitrl.mjs --json` | exit 0，默认 CLI 正常 |
| 7 | `node scripts/eval/guarded-regression.mjs --json`（本轮新增） | exit 0；**必须支持 `--json`**（机器可读输出，供 t2 绑定证据）；覆盖 F1/F2/F4、r3/r4 隔离、shadow 无副作用、holdout/授权/回滚、reservation 清理 |

### 11.2 实现文件范围（冻结；越界须回 captain 重新裁定）

`src/types/contracts.ts`、`src/jitrl/logit-adjuster.ts`、`src/jitrl/value-estimator.ts`、`src/jitrl/replacement-policy.ts`（新增）、`src/jitrl/reward-contract.ts`、`src/jitrl/experience-store.ts`、`src/jitrl/index.ts`、`src/jitrl/step-evaluator.ts`、`src/jitrl/decision-kernel.ts`、`src/orchestrator.ts`、`src/config.ts`、`src/index.ts`、`src/dream-rsi/offline-dreamer.ts`、`src/runtime/execution-profile.ts`（新增）、`tests/`、`scripts/eval/guarded-regression.mjs`（新增）、`docs/adr/0002-*.md`、`docs/P62_STATUS.md`。

注：`src/jitrl/action-normalizer.ts`（语义键函数，PR-B 已交付并经评审）不在改动范围；`src/cordis-seams/**` 等安全契约面不在本轮触碰。

### 11.3 五状态生命周期与 reviewed SHA（P62_STATUS 登记）

每项能力按五状态推进，**状态之间不得跳读**：

1. **delivered**：实现+测试已落到工作树；
2. **wired**：已接入生产默认装配路径（默认形态实际经过该代码，非仅类/类型存在）;
3. **default-enabled**：默认装配下该行为实际开启（区别于 wired-but-off）;
4. **independently-verified**：t2 在确定工作树上独立跑门禁+guarded regression 并绑定 diff 指纹记录证据;
5. **released**：已发布/部署——**本轮恒为否**。

t5 评审绑定 reviewed SHA（HEAD + 工作树 diff 指纹 + 关键文件 sha256）；状态页由 t3 终态更新，反映**默认安全形态**而非宣称真实收益。

## 12. 与工作项的对应

| 工作项 | 与本 ADR 的关系 |
| --- | --- |
| t1（本 ADR + P62_STATUS 初版） | 契约冻结输入，非代码变更 |
| t6（本 ADR 修订 + P62_STATUS 同步） | 修正 t1 的自相矛盾：废除 applyWinningPatch 豁免、收紧 C2 前可信边界（shape≠来源、failed 需可信 provenance、unknown 不入 task-quality 学习）、r4 切换定性为保守隔离、门禁统一七条（见文头"修订"行与 §3/§5.2a/§5.4/§6/§9/§11.1 的 t6 修订标注） |
| t4（实现 C0+C1） | 落地 R1–R8 与 11.2 范围（含 t6 修订后的口径）；不重写 PR-A/B 既有 helper |
| t2（独立验证） | 执行 11.1 门禁与 guarded regression；核对生产默认装配与历史负收益 |
| t5（独立评审） | 核对本 ADR 与实现/验证的一致性，产出 reviewed SHA |
| t3（集成收口） | 终态更新 P62_STATUS 五状态、登记 C2/C3 前置条件、C4 入口与 D 授权边界 |

## 13. 本 ADR 明确不做

- 不实施 C2–C4，不做真实模型/付费调用、真实 memory 写入、发布或部署（含 git commit/push，除非用户另行明确要求）。
- 默认装配不禁用任何永久 patch 应用、自动发布或真实 memory（t6 修订后口径）：永久 patch 应用（含 winning patch 挂载）默认禁止，仅 guarded-active + 证据规则解锁。
- C2 前不把 shape-only verdict 当可信来源：passed 不晋升可信任务成功、failed 无可信 provenance 不入负样本（audit-only）、unknown 不入 task-quality 学习；不据此扩大启用或宣传收益。
- 不改 verifier-first 数值标尺、权重、clip、F4 常量；不把 unknown/infra/cancel 擅改为 +1/−1，不引入任何新的 ±1 契约（r4 标尺内既有映射除外）。
- 不改研究复现路径语义与研究臂版本戳；不抹去或改写历史负收益。
- 不默认开启 guarded-active/publish/memory/mirror/L3 gate（后两者延续 ADR 0001 D4 默认关闭）。
- 不为通过验证降低测试强度或改写报告措辞。

## 14. 参考

- ADR 0001（`docs/adr/0001-p61-security-contract-and-boundary-rulings.md`）：D1 严格默认、D4 权限分层与 shadow 口径。
- PR-A 评审：`docs/reports/p62-review-round1-pr-a.md`（F1/F2 契约、谓词唯一性、五输入×四入口矩阵）。
- PR-B 评审：`docs/reports/p62-review-round1-pr-b.md`（F3 语义、F4 证据规则、三条诚实边界与 r4 预注册）。
- 关键代码锚点：`src/jitrl/experience-store.ts:82`、`src/jitrl/reward-contract.ts:544`–:590、`src/jitrl/step-evaluator.ts:440`–:776、`src/jitrl/value-estimator.ts:343`–:472、`src/orchestrator.ts:783`–:900/:2360`–:2664、`src/jitrl/index.ts:235`–:263。
