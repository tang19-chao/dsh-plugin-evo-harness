# P6_STATUS — dsh-plugin-evo-harness P6.1 状态表

> 本表是 P6.1 迭代的最终集成状态（源方案第 11 节要求的"一个稳定提交，一份最新状态表"）。
> 本版为 **P6.1-G3 终态绑定修正**（t21，在 t19/G2 基础上更正 t8 报告哈希并补登 content-complete 代码面指纹；历史计数按"历史报告保留旧数字"原则标注，不回写）。
> 旧报告保留历史不被覆盖；`needs_revision` 不被改写成已完成；每项 verdict 只对其记录的绑定字节成立。
> **历史状态标记（2026-10-28，rev.4 集成轮 t9）**：本表为 P6.1 迭代的历史终态快照（截至 t21，74 files / 1450 tests 时点）。
> 后续 P6.2（C0+C1 / C2a / C3）终态见 `docs/P62_STATUS.md`；2026-10-28 P0 修复批的事实以 `docs/P62_STATUS.md` §2.1/§4 与 `DEVELOPMENT_LOG.md` §10 为准。
> 本表全部计数与指纹为历史值，按「历史报告保留旧数字」原则不回写、不重算。

## 0. 本次验收环境（t19 终态刷新时点）

| 项 | 值 |
| --- | --- |
| 代码提交 SHA | `7bce33ee9d102a6a05a35f080f606a8fd388e114`（git rev-parse HEAD，P6.1 基线；P6.1 改动位于工作树，见下指纹） |
| 工作树 diff 指纹 | 全树 `5028716ac167f2fc318c9a04ff2768fb697c9073`（`git diff HEAD \| git hash-object --stdin`，含本表同步的 README；首版 t13 为 `58d78843…`）；**代码面 tracked**（git diff HEAD -- src/ tests/ scripts/）`24d4cbd0d6784f89bcb8f007cd6904ec6da53e97`；**代码面 content-complete** `8c26b67179e9efa4c5c069bbe165f2058361d99db77781dc20edac9b331a36fa`（gate-reviewer 终态实测，src/tests/scripts 全部 176 文件按「相对路径:sha256」排序后取 sha256）。**口径**：两个 git-diff 指纹均只覆盖 HEAD 已跟踪文件、不含未跟踪新增（reward-contract/reward-version-isolation/provenance-chain/negative-result-diag/host-smoke 等），**终态状态表的代码面绑定以 content-complete 指纹为准** |
| 验收机器 | win32/x64，Node `v22.23.1`，pnpm `11.7.0` |
| 全量测试计数 | **74 files / 1450 tests passed**（unit 63/1303，e2e 11/147），与 README 一致（check:docs 机械校验通过）。历史：t13 首版 73/1443、R1 时 72/1387（历史报告保留旧数字） |
| 报告绑定方式 | 各评审/报告绑定"代码提交 SHA + 文件 sha256（+工作树 diff 指纹）"；本状态表在纯文档提交生成，不自引用含自身内容的最终 commit hash（见 §6） |

五门禁实跑结果（t19，最终冻结树）：

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm run typecheck` | 0 | tsc --noEmit 无错误 |
| `pnpm test` | 0 | 74 files / 1450 tests 全绿（Duration 13.78s） |
| `pnpm run check:docs` | 0 | README 计数与 Vitest 实测一致（74/1450） |
| `pnpm run build` | 0 | esbuild bundle 产出 lib/index.js |
| `node scripts/eval-jitrl.mjs --json` | 0 | 默认 CLI 正常退出，**不需要 experimental flag** |

注：计数增长（73/1443 → 74/1450，+1 file/+7 tests）来自 t17 新增 `tests/unit/jitrl/reward-version-isolation.test.ts`；t18 无代码变更。README 由 t19 按实测同步，check:docs 由红转绿——文档计数同步，不是测试强度变化。R1 四文件 sha256 终态复核**全部未变**：adapter `4C938EE057FE16E9`、host-tool-experience `D95372629F876A57`、eight-surfaces `423686FE4C38B4E6`、provenance-chain `A56BDD2AC376FB3C`（t17/t18 不触 A 线判定面，D1 结论按 R1 文件指纹继续有效）。

## 1. P6.1 工作项状态（每项六字段）

### A 线：安全契约（F9 + provenance）

| 工作项 | implementation | tests | review verdict | reviewed SHA（绑定） | accepted limitation | next action |
| --- | --- | --- | --- | --- | --- | --- |
| **A0**（t1）ADR 0001：D1 严格默认 + D2/D3/D4 边界 | `docs/adr/0001-p61-security-contract-and-boundary-rulings.md`（accepted，2026-10-24）：D1 Option 1 五行×三列契约表、不留隐式 host-local 例外、不新增默认开启 allowAnonymous=true、host-session scope 显式登记为兼容路径；D2/D3/D4 边界确认；§2.3 含 R1-O1 边界声明（t16 补记） | typecheck exit 0（纯文档）；D1 契约表与 P6.1 源文档第 3 节逐字一致 | 无独立评审（设计裁定输入；R1/R2/R3 均以其为设计依据复核代码） | ADR sha256 `409413174357C5F6…`（t16 补 O1 声明后重绑） | D3 decisionId 共用为已接受限制；D2 声明非间接通道穷尽 | 若 ADR 字节再变（如后续裁定增补），owner 以新 sha256 重绑 |
| **A1**（t2）F9 严格默认实现 | `dsh-hook-host-adapter.ts` 匿名放行分支删除→fail-closed + `scopeUnknownSkipped` 计数；`host-tool-experience.ts` 删 unknown-bucket `guidance:'memory'` 写入→`scope_unknown_skipped` 计数（无载荷）；仅 sessionId 降级；受信登记后恢复；注释/测试名/README D1 段同步 | 匿名 `{name:'bash'}` 默认 dispatch 无 advice 但执行 allow；typecheck 0 / test 全绿 / check:docs 通过（当时 71/1370） | **pass**（R1/t10） | adapter `4C938EE057FE16E9`、host-tool-exp `D95372629F876A57`、R1 报告绑定 + 最终 diff 指纹 `fd1b4d2f…` | 评审 O1：collector 独立使用（无 registry 注入）时 sessionId+branchId 判 isKnown——生产路径总注入 registry（`index.ts` :1452–:1461/:1349–:1358，t16 格式修正后行号），已在 ADR §2.3 声明为模块独立测试口径，非 D1 违规 | 无（收口完成） |
| **A2**（t3）真实 provenance 链测试 | `tests/e2e/provenance-chain.test.ts`（6 场景，740 行）：patch.origin+guidance → seam-manager → mountEightSurfaces → adapter mount spec → ScopeRegistry → pre/post → collector → store；全文件零手工 registry.register | M1 删 eight-surfaces provenance 展开→4/6 红；M2 删 collector 未知拒绝分支→scenario 4 红；恢复全绿；R1 独立重放两变异均复现红 | **pass**（R1/t10，含独立变异重放） | eight-surfaces `423686FE4C38B4E6`、provenance-chain `A56BDD2AC376FB3C`（R1 复核 match=True） | runInIsolatedBranch 的 executor 内断言失败会被 branch error boundary 吞为 status:'failed'，测试必须断言 trajectory.status（已在场景 1/2 落实） | 无（收口完成） |
| **A1b**（t15）index.ts 状态诊断 D1 口径 | attach 诊断串 `, host-local` → `registry-resolved scope (D1 strict default…)`；describeThrownClass() 有界类 | typecheck/test 通过 | R1-F2 resolved（由本项修复） | index.ts `D407AAD3EA05145A`（R1 绑定） | — | 无 |
| **A1c**（t16）O3 格式收口 + ADR O1 声明 | index.ts 44 hunks 纯格式零行为（41 whitespace-only + 3 处 t15 已核验）；ADR §2.3 补 O1 边界声明 | verdict=pass（captain 转达） | pass | ADR 重绑至 `409413174357C5F6…` | — | 无 |
| **R1**（t10）安全契约评审 round 1 | 评审报告 `docs/reports/p61-review-round1-security.md`：验收 8/8 passed，独立变异重放（自建隔离副本）确认判别力 | typecheck 0 / test 72/1387 / check:docs 0（评审时点） | **pass** | HEAD `7bce33e…` + 最终 diff 指纹 `fd1b4d2f…`；报告 sha256 `2A398BBD5D02F367` | F1(medium) README 计数漂移——resolved（评审收尾同步）；F2(low) host-local 残留——resolved（t15）；O1 low / O2 info / O3 info 观察（O1 已进 ADR，O2 见 next action，O3 已由 t16 修） | O2：adapter 侧 `scopeUnknownSkipped` 未进插件 status 快照（collector 侧诊断线已进 diagnostics）——登记为后续 next-action，非缺陷 |

### B 线：mirror 无载荷诊断

| 工作项 | implementation | tests | review verdict | reviewed SHA（绑定） | accepted limitation | next action |
| --- | --- | --- | --- | --- | --- | --- |
| **B1**（t4）mirror 结构化诊断白名单 | `bridge.store.ts`：诊断仅白名单字段（code/phase/operation/retryable/correlationId/errorClass 枚举/serverRef/namespaceRef）；error.message/content/args/note body 不进任何可见出口；`Error.name`/外部 code 映射枚举或 bounded unknown；删除示例串专用匹配 | bridge.store.test 36 + redaction.test 51 通过（真实 mirror() 路径，canary 变体） | **pass**（R2/t11） | bridge.store `BAF7B4F4ED664CEB`（t11 consolidated re-bind）；R2 报告绑定 diff 指纹 `34ce3e74…`→重绑 `fd1b4d2f…` | O3(info)：serverRef/ns 短哈希非匿名化，仅作关联引用（代码注释已声明） | 无（收口完成） |
| **B2**（t14）host-advisor describeError 无正文化 | `host-advisor.ts` describeError 有界 class + 注释 | host-advisor.test 44 用例 | R2 一并 pass（captain 追加：8 例 canary × 双路由 + noop 无正文载荷零回显） | host-advisor `106D7685A8C48386` | — | 无 |
| **R2**（t11）mirror 评审 round 1 | 评审报告 `docs/reports/p61-review-round1-mirror.md`：16 例真实 mirror() 重放三出口仅白名单线、反证封堵来自白名单而非正则（sanitize 单用 15 canary 可见）、密钥脱敏/掩码未回退、tokenizer 消费端复核 | tests/unit/jitrl 601/601（评审时点） | **pass** | HEAD + diff 指纹 `fd1b4d2fca01db08ce7a506ebe93f4958471c0fd`（consolidated re-bind，含 bridge.store 注释块 +6 行的算术证明：10 锚点全且仅 +6） | O1(low, inScope 外)：`index.ts` mirror() 意外抛出（非后端路径）时 error.message 拼入插件 diagnostics——非活跃回显通道（mirror() 内部已收敛全部后端失败），t15 范围已按 F9/B 口径处理；O2(info) 陈旧注释已由 t16 关闭 | 无（open 项均为 info/low 观察且已有处置） |

### C 线：PR5 复评收口

| 工作项 | implementation | tests | review verdict | reviewed SHA（绑定） | accepted limitation | next action |
| --- | --- | --- | --- | --- | --- | --- |
| **C**（t5）PR5 共同内核复评 | 复评报告 `docs/reports/p61-review-round2-pr5.md`：旧 PR5 High（learning filter opt-in 未接线）在 L1/L2/replay/M3 生产路径闭环，标记 **RESOLVED**；在线/replay 相同可比输入对齐（精度 1e-12）；版本不兼容不混合估计；L3 过滤契约成立 | learning-filter-wiring 14 passed；tests/unit/jitrl 601/601 | **pass**（绑定 SHA 复评，非照抄旧报告） | HEAD `7bce33e…`；consolidated re-bind 指纹 `fd1b4d2f…`（gate-reviewer 四点算术证明：README 仅计数、bridge.store 仅注释） | t2 的 host-tool-experience 工作树改动属 ADR D1 口径更新——验收 6「L3 生产者」按 D1 口径复述：匿名观测→`scope_unknown_skipped` 计数（无载荷、不进可学习轨道），已知 scope 的归因链/level:host_tool/G_t=r_t 未变 | 无（旧发现有正式 resolved 记录） |

### D 线：RewardContract

| 工作项 | implementation | tests | review verdict | reviewed SHA（绑定） | accepted limitation | next action |
| --- | --- | --- | --- | --- | --- | --- |
| **D**（t6）RewardContract 统一奖励标尺 | `src/jitrl/reward-contract.ts`（轻量契约：可验证成功信号、同版本同尺度、judge 仅辅助、明确 target 字段、版本化）；orchestrator 赢家/非赢家/reference 分叉统一为 scoreUnderRewardContract；新记录 rewardVersion=r3/unified-signals-v1；return=observedReturn（verifier 优先），gain 仅辅助对照 | 7.4 六条判别测试全绿；R3 独立变异重放（M1 恢复赢家私有标尺→2 红；M2 gain 优先→2 红；M3 删 estimatorTarget→1 红）证明判别力 | **pass**（R3/t12） | reward-contract `69A7272305C330D3`→t17 后 `AFD5B2564A503F4D`、orchestrator `84E0B163CB132977`、value-estimator `98F7A7F0C3A32C46`；diff 指纹 t13 `58d78843…`→终态代码面 `24d4cbd0…` | R3-F1(medium) 已由 **D2/t17 修复 closed**（见下） | 无（F1 经 D2 修复关闭） |
| **D2**（t17）R3-F1 修复：rewardVersion 升级接线与兼容隔离 | ①`CURRENT_REWARD_VERSION` 由 `r2/verifiable-v1` 指向契约版本 `r3/unified-signals-v1`（新增 `PREVIOUS_REWARD_VERSION` 显式保留 r2 lineage）；②`isLearningEligible()` 增加 rewardVersion 兼容判定（fail-closed：缺失/未知版本不训练），`backfill.ts` 迁移隔离含版本条件；③`value-estimator.ts` re-export 契约面（REWARD_CONTRACT/readLearningTarget/estimatorTargetLine） | 新增 `tests/unit/jitrl/reward-version-isolation.test.ts`：r2/r3 不混入同一邻域均值、版本 bump 触发 requiresExperienceRebuild fail-closed（marked-copy 隔离、不原地改写审计日志）、isLearningEligible 跨版本隔离——每条断言按"修复前实现必红"书写 | 修复完成（t17 completed）；R3-F1 状态 **closed**（captain 协调确认，gate-reviewer 最终 re-bind 见 §6） | experience-store `FFCFC6B53402594C`、reward-contract `AFD5B2564A503F4D`、value-estimator `98F7A7F0C3A32C46`（未变，仅 re-export）、backfill `2746C71A27DAA08A`、新测试 `BCB5954D46BD440B`；终态代码面指纹 `24d4cbd0…` | 本轮合成评测 per-task 冷启动库不触发真实升级路径（R3 已声明，非新限制） | 无 |
| **R3**（t12）RewardContract + 负收益解释评审 | 评审报告 `docs/reports/p61-review-round1-reward-eval.md`：验收 9/9 passed；t8 独立重放逐字段一致 | typecheck 0 / test 73/1443（评审时点，历史计数） | **pass** | 评审绑定 diff 指纹 `58d78843…`（gate-reviewer FINAL re-bind 值）；t8 报告（t18 修复后终态）`2952461A8AAA625C` | F1(medium)→**closed by t17**；F2/F3(low)→**closed by t18** | 无（三条 findings 均已修复关闭） |

### E 线：负收益解释

| 工作项 | implementation | tests | review verdict | reviewed SHA（绑定） | accepted limitation | next action |
| --- | --- | --- | --- | --- | --- | --- |
| **E**（t8）负收益解释（台账+最小反例+假设判别） | `docs/reports/p61-eval-negative-result-explanation.md` + `scripts/eval/negative-result-diag.mjs` + eval-lib additive 诊断旋钮：−0.250 复现（0/7/5）；首害决策 ci-04\|2\|2（support=0 改选 noop，验收 1.000→0.667，融合奖励 +0.30——verifier/reward 不一致的直接证据）；H1–H6 一次只改一项判别（H3/H4 各自把负收益收窄到零，标注为假设非根因）；counterfactual 单独记账；H4 双门槛收益未过保持探针 | node scripts/eval-jitrl.mjs --json exit 0；tsc 0；jitrl-ablation 24/24（默认路径逐字节不变）；R3 独立重放 2 次 + 自写探针逐字段一致 | **pass**（R3/t12 一并评审） | 首版报告 `F053582AB7399FE4`（R3 评审对象）→t18 修复后终态 `2952461A8AAA625C`（gate-reviewer 终态实测更正；前记 `181A7BCC…` 为 t18 修正前快照，作废）、脚本 `10FBFC1D1D24D13E`、eval lib `74B36BD35B564693` | 负结果（−0.250）是有效研究结论，不包装收益、不归因模型能力不足；小合成集不承诺统计显著性 | F2/F3 已由 E2/t18 修复 closed；H6 结构性核对 not-run(behavioural) 归 Gate 4 |
| **E2**（t18）R3-F2/F3 修复：负收益报告证据完整性收口 | 仅改 `docs/reports/p61-eval-negative-result-explanation.md`。F2：§1 witness 指纹替换为脚本确定性输出（ci-01: 75d57bdc→b73b0a8b→bd56d73e；ci-04: be05e090→73ba2b59→650d0bfa，标注反例锚点池）。F3-a：+0.88 补来源——H1 探针台账 ci-04\|2\|2 实选 guardrails:append(1) 观测回报 0.8833333333333333（§9 命令 5 可一行重放，H0 同坐标 +0.30/noop），修正因果表述。F3-b：§9 明确 JSON 只含计数(180)+4 条样例。F3-c：§9 五条命令全部实跑并记退出码，no-op stub 删除。另修 R3 未列的过时陈述（36 次偏离 support 范围实为 0..2），新增 §10 23 项数字核对清单 23/23 OK | node scripts/eval-jitrl.mjs --json exit 0；vitest jitrl-ablation 24/24 不回归；tsc exit 0；diag 脚本两次运行哈希一致 | 修复完成（t18 completed）；R3-F2/F3 状态 **closed**（captain 协调确认） | 修复后报告 sha256 `2952461A8AAA625C`（gate-reviewer 终态实测更正；前记 `181A7BCC…` 为修正前快照）；终态代码面指纹 `24d4cbd0…` | —（纯报告修复，无代码变更） | 无 |
| **E3**（t20）eval 双臂标尺常量显式化（gate-reviewer 发现修复） | `scripts/eval/jitrl-eval-lib.ts`：显式常量 `FAIR_R2_SCALE_VERSION`（:2557）/`FAIR_R3_SCALE_VERSION` 与 `writeRewardVersion` 选择逻辑（:2665），r2 臂沿用 scoreTrajectorySignals 权重并显式盖 r2 戳——消除"eval 标签与实际标尺脱钩"的面 | A/B 双跑 297 个数值叶一致（r2/r3 臂唯一差异=rewardVersion 标签）、41 个标签恢复 | 修复完成（t20 completed）；gate-reviewer 发现的 eval 标签脱钩 **closed** | eval-lib `7AD5ED6C5D2F9783`（t20 后）；终态代码面指纹 `24d4cbd0…` | — | 无 |

### F 线：真实宿主 smoke

| 工作项 | implementation | tests | review verdict | reviewed SHA（绑定） | accepted limitation | next action |
| --- | --- | --- | --- | --- | --- | --- |
| **F**（t9）宿主 smoke harness + 受控 smoke + shadow RC | `tests/e2e/host-smoke/`（manifest/samples/report-template/assemble/probe/degradation/mcp-*，40 测试）+ `scripts/host-smoke/`（run/in-host/build）+ RC 报告 `docs/reports/p61-host-smoke-rc.md`；真实宿主 DeepSeek Harness 0.2.1-rc.2（cordis 4.0.5/node 24.21.0/electron 44.7.0）实跑 **20 行：18 passed / 0 failed / 2 not-run** | harness.test 40 用例；子进程 exit 0、120s 内、无残留进程；manifest/行校验 0 problem | 无独立评审（F 线为 smoke 证据交付；RC 分层结论见下） | 报告 sha256 `390DE8D80C2A4093`；固定 commit `7bce33e…`（dirty worktree 声明） | **Gate 4 not-passed**（:95 gate4.blockedBy）：①真实模型调用/memory 写入需显式授权（环境+账号+预算）未获→9.4-2/9.4-3 如实 not-run；②宿主 4 个 hook 均不提供 branchId（身份=payload sessionId 或 agent/pre-step carrier-this）→D1 §2.5 host-session scope 登记路径未在分支感知宿主上证明；③安全契约需先在本表收口。实测事实：turn/end 是 durable session 事件非 hook（manifest.durableEvents 单列）；ctx.off/ctx.fork 不存在；ctx.on disposer 调用即注销 | 见 §3 发布阻塞项：授权环境、分支感知宿主、D 线 F1 修复 |

RC 分层结论（:27–:31，无一行全绿覆盖）：工程可运行 2/0/0 · 安全契约 12/0/0 · 学习语义 1/0/0 · 真实宿主兼容 3/0/0 · 任务收益 0/0/**2**（not-run）。

## 2. 三份评审汇总

| 评审 | 报告 | verdict | 关键 open findings |
| --- | --- | --- | --- |
| R1（t10）安全契约 | p61-review-round1-security.md | **pass**（8/8） | 无 open 阻塞项；O1 已进 ADR §2.3、O2 登记 next-action、O3 已由 t16 修 |
| R2（t11）mirror | p61-review-round1-mirror.md | **pass** | 无 open 阻塞项（O1 low 属 t15 范围已处置；O2/O3 info） |
| R3（t12）Reward + 负收益 | p61-review-round1-reward-eval.md | **pass**（9/9） | **无 open findings**——F1(medium) closed by t17（upgradeRule 接线+版本隔离+判别测试）、F2/F3(low) closed by t18（报告证据完整性）；另 gate-reviewer 发现的 eval 标签脱钩 closed by t20（FAIR_R2_SCALE_VERSION 显式化，A/B 双跑 297 数值叶一致、41 标签恢复） |

## 3. 发布阻塞项与非阻塞项（对齐源方案 11.3）

### 3.1 阻塞扩大启用（Gate 4 前必须关闭）

1. ~~**RewardContract upgradeRule 未接线**（R3-F1，medium）~~ **已关闭（t17/P6.1-D2）**：CURRENT_REWARD_VERSION 已指向契约版本 r3/unified-signals-v1；isRewardVersionCompatible 接线 isLearningEligible/L2 邻域（fail-closed）；backfill rewardVersionIsolated 隔离 + marked-copy 审计；reward-version-isolation 判别用例落地。证据：experience-store `FFCFC6B53402594C`、backfill `2746C71A27DAA08A`、新测试 `BCB5954D46BD440B`。**操作备忘**：存量 r2 经验日志升级前先跑 migrate 落盘审计副本（版本 bump 走 requiresExperienceRebuild fail-closed 隔离，不原地改写审计日志）。
2. **真实宿主身份契约未知**（F 线实测）：宿主 4 hook 均无 branchId，D1 §2.5 host-session scope 登记路径未证明——需分支感知宿主或宿主适配层显式登记。
3. **真实模型调用/真实 memory 写入未授权**（F 线 9.4-2/9.4-3 not-run）：需用户显式授权（环境+账号+预算）。
4. **任务收益证据缺位**：reward 标尺刚统一（r3），负收益已解释但改善策略（H4 门槛）双门槛未过——按 ADR D4，扩大自动在线修正/热替换默认启用前需预定义的非劣/收益证据、足够覆盖与成本上限。

### 3.2 阻塞学习收益宣传（非启用阻塞）

- 负结果（−0.250）已解释（首害决策 + H1–H6 判别）但未在真实任务上复验；无独立真实任务收益与成本证据前，不得宣传学习收益。

### 3.3 非阻塞且需记录（accepted limitations）

- D3：meta/proposal 共用 L2 decisionId（ADR 0001 §4，仅新增按 decisionId 聚合消费者时重评）。
- 历史报告保留旧数字（71/1370、72/1387、73/1443 等），本表终态口径为 74/1450。
- 研究结果为负是有效结论；暂不引入 embedding；未支持更多 memory driver。
- R2-O3：serverRef/ns 短哈希非加密匿名化，仅诊断关联。
- R1-O2：adapter 侧 scopeUnknownSkipped 未进插件 status 快照（collector 侧诊断线可达）——next-action。
- t17 边界：本轮合成评测 per-task 冷启动库不触发真实 r2→r3 升级路径（判别测试以构造用例覆盖，R3 原声明保留）。

### 3.4 默认关闭状态确认

| 开关 | 默认状态 | 依据 |
| --- | --- | --- |
| L3（host advisor gate） | **默认关闭** | ADR D4；开启仅限测试 namespace |
| mirror（memory bridge 镜像） | **默认关闭** | ADR D4；开启仅限测试 namespace |
| 自动 Jit 热替换 / 自动在线修正 | **未默认启用**（baseline 执行 + shadow 建议） | ADR D4；R3-F1 已由 t17 修复关闭，但按 D4 扩大默认启用仍需 §3.1 其余三项 + 收益证据 |

## 4. Node 版本与 engines 承诺口径

- `engines.node`：`>=20.19.0`（package.json；构建 target node20）。
- **本轮实际验证清单**：本机全量门禁（typecheck/test/check:docs/build/CLI）在 **Node v22.23.1** 通过；t9 宿主内 smoke 在宿主自带 **node 24.21.0**（electron 44.7.0）通过；P6.1 源方案轮在 Linux Node v24.14.1 跑过门禁与默认 CLI。
- **不外推**：Node 20.x 与 24.x 的其余小版本、以及 engines 下限 20.19.0 本身，未经 CI 矩阵复验，不作"全部支持"声明；Node 22 与 engines 最低承诺按 CI/实际测试清单分别标注（当前缺 Node 20.x 的 CI 实跑记录）。

## 5. CI 增强清单（回归新增项，按源方案 11.2；本轮已落实的标 ✅，未实现的登记为 CI job 建议）

1. ✅ **provenance 真实挂载 + 匿名默认路径回归**：`tests/e2e/provenance-chain.test.ts`（6 场景，零手工 registry.register；变异判别力经 R1 独立重放证明）。
2. ✅ **arbitrary payload echo 测试**：`tests/unit/jitrl/bridge.store.test.ts` + `redaction.test.ts`（canary 变体，不依赖固定 RAW_PAYLOAD 字样；R2 反证封堵来自白名单而非正则）。
3. ✅ **实际学习 target 消费测试**：7.4 判别测试第 ⑥ 条（estimator 日志写明 target 字段与版本；R3-M3 变异红证明判别力）。
4. ✅ **冻结输入的生产/公平引擎一致性测试**：`tests/e2e/jitrl-ablation.test.ts` 24 用例（t8 additive 旋钮默认路径逐字节不变）。
5. ◻ **关键契约少量定向 mutation job**（未实现，登记为 CI 建议）：最小集 = ①eight-surfaces provenance 展开（R1-M1：4/6 红）②collector 未知拒绝分支（R1-M2：scenario 4 红）③orchestrator 赢家标尺分叉（R3-M1：2 红）④readLearningTarget gain 回退（R3-M2：2 红）。每项已在评审中人工重放，CI 化只需把上述变异步骤做成 job；不要求全项目变异测试。

## 6. 报告绑定与自引用固定点声明

- 各评审/报告绑定"代码提交 SHA（`7bce33e…`）+ 文件 sha256（+代码面指纹）"。历史绑定链：t5/t11 consolidated `fd1b4d2fca01db08ce7a506ebe93f4958471c0fd` → t12/R3 FINAL re-bind `58d78843410caa7c9782adce80da118ba2477806` → **终态（gate-reviewer 最终 re-bind，t21 登记）：全树 `5028716ac167f2fc318c9a04ff2768fb697c9073`、代码面 tracked `24d4cbd0d6784f89bcb8f007cd6904ec6da53e97`、代码面 content-complete `8c26b67179e9efa4c5c069bbe165f2058361d99db77781dc20edac9b331a36fa`（176 文件）**。R1（t10）/R2（t11）/R3（t12）三评审 verdict 绑定至上述终态指纹；逐文件复核见 t10/t11/t12 终态 supplement。
- **指纹口径说明（P6.1-G3/t21 修正）**：两个 git-diff 指纹（全树/代码面 tracked）只覆盖 HEAD 已跟踪文件，不含 P6.1 新增的未跟踪文件（src/jitrl/reward-contract.ts、tests/unit/jitrl/reward-version-isolation.test.ts、tests/e2e/provenance-chain.test.ts、tests/e2e/host-smoke/、scripts/eval/negative-result-diag.mjs、scripts/host-smoke/ 等）；content-complete 指纹的 recipe 为「src/tests/scripts 全部 176 文件按 相对路径:sha256 排序后取 sha256」，**评审与发布校验的代码面绑定以它为准**。被引用文档 sha256 终态：t8 负收益报告 `2952461A8AAA625C`（更正，前记 181A7BCC 为 t18 修正前快照）、三份评审报告 `2A398BBD5D02F367`（R1）/`C20127F5E02F8D99`（R2）/`C697C6905668353E`（R3）均不变；P6_STATUS.md 自身在本轮修改后重算自哈希并于交付说明记录（不自引用为固定点）。
- 本状态表及其引用的报告在**纯文档提交**中生成；不把包含自身内容的最终 commit hash 自引用成固定点。校验方式：发布前重算 content-complete 代码面指纹（recipe 见上）确认与绑定值 `8c26b671…` 一致；文档提交不改变被审字节。
- 历史报告（`p6-*.md`、`docs/reports/p61-*` 各轮）一律保留，不覆盖；本表汇总其结论但不改写任何 needs_revision 历史。

## 7. P6.1 总评（终态）

安全契约按 ADR 0001 收口完成（D1 严格默认全链落地且经独立变异验证、provenance 链有守护测试、mirror 诊断无载荷、PR5 复评 resolved）；RewardContract 统一了评分标尺（r3）并完成升级接线与跨版本隔离（R3-F1 closed）；负收益得到决策级解释且报告证据完整（R3-F2/F3 closed）；真实宿主受控 smoke 18/20 通过并如实留下 2 项 not-run。三份评审（R1/R2/R3）全部 pass 且无 open findings。剩余工作集中于 §3.1 的三项 Gate 4 前置（分支感知宿主、真实授权、收益证据）。下一轮成功的标准不是"学习曲线一定向上"，而是：安全策略不含隐式例外，测试能抓断链，经验和目标可解释，负结果可复现，真实宿主边界可验证。
