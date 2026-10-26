# ADR 0003：P6.2 第二轮发布边界、可信验证与成本台账契约（C1.1 + C2a + C3 准备）

| 项 | 值 |
| --- | --- |
| 状态 | **accepted**（采纳，作为本轮 C1.1 / C2a 实现、独立验证与独立评审共同遵守的契约；C3 部分仅为**契约与离线 fixture 准备**，不含生产接线） |
| 日期 | 2026-10-26 |
| 代码基线 | HEAD `9ea9b7edacb199884df2020df879f4e59ed66d73`（`9ea9b7e feat(p6.2): close C0+C1 release contract and safe defaults`）；工作树仅含 3 份未跟踪文档（`docs/reports/c2a-trusted-verification-wiring-audit.md`、`docs/reports/t2-dreamer-release-effect-matrix.md`、本 ADR），`git diff \| git hash-object --stdin` = `e69de29b`（空 blob；见 §13.2 注） |
| 决策来源 | ①用户提供的 P6.2 下一轮计划（ADR-0003 / C1.1 / C2a / C3 准备 / C2b·C4·D 不做）；②t2 只读审计 `docs/reports/t2-dreamer-release-effect-matrix.md`（Dreamer 发布效果点覆盖矩阵 + captain 裁定 §0 R1–R6）；③t3 只读审计 `docs/reports/c2a-trusted-verification-wiring-audit.md`（C2a 生产接线与资格冲突 C-1…C-10 + §7 R1–R6）；④ADR 0002（C0+C1 冻结口径，本轮不修改其文本）；⑤ADR 0001 D1/D4（权限分层与 shadow 口径延续）；⑥captain 2026-10-26 三轮裁定（R1 发布受体归属 / R2 记录字段与消费门 / R3 双回执 / R4 rescore 冻结 / R5 双闸 / R6 证据口径） |
| 决策者 | 本轮收口团队 `p62-c11-c2a-closure`（captain 批准执行） |
| 影响范围 | Dreamer 发布受体的权限归属与真实 apply 边界、idle 入口可审计性、`decideReplayPublication` 的 holdout 语义、可信验证来源认证与回执绑定、失败资格（保守 A）、`learningEligible` 字段与消费门分离、rescore/backfill seam 冻结、C3 成本台账数据契约与离线 fixture、状态词汇与门禁口径 |
| 修订 | **初版 + rev.2（t1 attempt 3 复核修订）+ rev.3（captain 精度增补）**，均为 2026-10-26。**rev.2** 对初版做了 7 处**契约性**更正，全部基于对 HEAD `9ea9b7e` 的逐行复验（记录见 §13）：①**撤回**初版「`off` ⇒ 停 dream 重放」的冻结要求（与 ADR 0002 §3「off 语义逐字不变」冲突，改登记项并已裁定为"不变"）；②补入第 5 处冲突旧测试 `runtime-control.test.ts:319-421`；③写明 `TrustedVerification` 定义在 `src/jitrl/step-evaluator.ts`（不在任何 inScope）故回执扩展字段只能"随附"而非改类型；④写明「`failed` 执行 + trusted `passed`」只有 attach 侧可见（scorer 会先降级为 `unknown`），audit-only 判定必须落在 attach/recorder；⑤钉住 `isLearningOutcome('timeout')===true` 已被既有测试固定，超时门**不得**改该谓词；⑥补 `shadow.comparisons[].selected` 须与真实 applied 恒等；⑦收紧 `holdoutTreeCount` 与 PB-5 的措辞。**rev.3** 按 captain 指令增补 §4.6 `artifact-missing` 与 §4.6a 三条精度（空 checks 须 attach 侧拒绝、禁 FNV 等同 sha256 断言、旧 artifact/错绑须断言 attach 原因码），并把 §13.4 的三项开放项按 captain 裁定升格为**验收依据**。**不修订 ADR 0002 正文**：ADR 0002 仍是 C0+C1 的冻结契约；本 ADR 只对其 `publish` 层定义、`learningEligible` 字段口径、`publish 无调用点` 三项事实做**本轮范围内的精化**，并明确 ADR 0002 §7 的 A1–A5 文本待裁定项**仍归 captain**（本轮不借机改写 accepted ADR） |

> **术语约定（本 ADR 全文）**
> - **宿主 baseline**：宿主自身行为不受 Jit 影响（Jit 零拦截零注入）——与 ADR 0002 §3 同义。
> - **基础 evo search**：隔离分支内可回滚的探测与 L1/L2 建议调整——**不是** `patch` 层权限对象（ADR 0002 t6 裁定延续）。
> - **publish（发布）**：任何使**在线生效的策略/配置对象或持久化 revision 发生改变**的动作。本轮把「基础 Dream-RSI 的在线热替换 + 持久 revision」**明确归入 publish 层**（见 §3.1，captain R1）。
> - **patch（补丁）**：任何**永久**八面 scaffold 挂载（含 winning patch），ADR 0002 §4 语义不变。
> - **trusted 回执**：由**宿主自有 runner 实例**在本轮运行内登记、并绑定宿主重算 artifact 摘要的回执对象（§4.2）。它不是「`verifierId` 字符串在白名单里」。
> - **audit-only**：记录保留以用于审计/诊断，但不进入任何学习邻域（`learningEligible:false`，reward 列 0，原因可读）。

---

## 1. 背景：为什么需要第二个 ADR

ADR 0002 冻结了 C0+C1，并把 `publish` 定义为「发布/热更新策略」，默认 deny、本轮任何路径不解锁；但它在**执行受体**层面留了空白：`permissions.publish` 在生产代码里只被读取两次——`src/index.ts:1761` 的诊断串与 `src/orchestrator.ts:2437` 的记录字段——**没有任何执行点**。ADR 0002 §6-③ 因此诚实地写着「publish 无调用点，权限位是报表常量」。

本轮两份只读审计证明这个空白不是无害的：

| 编号 | 事实（HEAD `9ea9b7e`，可复现） | 证据 |
| --- | --- | --- |
| **P-1** | 默认装配（`execution.mode=shadow`、`publish.allowed=false`）下，任务周期的 Dreamer **真实热替换在线策略并写入一条持久 revision**：`pi-0@3 → pi-0::dream-2@4`，`policy.history.jsonl` 0→1。四种模式（含 `off`）、普通与 Jit-wired 两种 Dreamer 全部一致 | t2 §3.1/§3.2、`work/t2-dreamer-probe/entries.json`/`effect.json` |
| **P-2** | 同一次 dream 同时报告 `publication.publish=true`、`shadow.published=true`、reason 为「the candidate strictly improved the replayed hypervolume」——与 `publish.allowed=false` 并存 | t2 §3.1 |
| **P-3** | idle 入口（`agent/status`→`idle`）同样热替换并写 revision，且**不进入 `dreamReports`、不调用 `recordDream`**——该发布对状态面与审计不可见 | t2 §3.3、`work/t2-dreamer-probe/idle.json` |
| **P-4** | **生产装配从不传值** `holdoutTreeCount`（`src/**` 对该字段只有 `offline-dreamer.ts` 自身的定义/消费，全仓零传值点；唯一传值在测试 `offline-dreamer.test.ts:1020,1091`），`validatedOnHoldout` 恒 `undefined`，`decideReplayPublication` 的 holdout 半边**在生产中恒为惰性**：`publish` 完全由 `improved` 决定 | t2 §3.4；`src/jitrl/decision-kernel.ts:1189-1203`、`src/dream-rsi/offline-dreamer.ts:1562,1664,1765,1818-1832` |
| **P-5** | 生产链路**没有 verdict 注入通道**：`TrajectoryCollector.finalize` 只写 `diagnostics` 到 `metadata`（`src/cordis-seams/trajectory-collector.ts:288,332,334`），丢弃 `ProbeExecutionResult.metadata`；`readTrustedVerification` 在生产无任何写入者 | t3 §1-1、`work/_t3-c2a-probe.out.json` P1 |
| **P-6** | 生产 deliverable 不带 `contentHash`（`src/dsh-bridge/agent-loop-executor.ts:498-500`），`expectedEvidenceHash` 恒 `undefined`，`hasTrustedVerificationProvenance` 的 hash 比对分支被**跳过**——只凭「`verifierId` ∈ 调用方注入集合 + 自报 hash 非空」即可判 trusted | t3 §1-2、探针 P2；`src/jitrl/step-evaluator.ts:526-544,909-912` |
| **P-7** | `timeout` + trusted `failed` 会得到 `taskQualityEvidence=true`，被盖成 `learningTrack='task-quality'`、reward `-0.6833`——把「超时」冒充成「可靠任务失败」 | t3 §3 C-3、探针 P3/P3b；`src/jitrl/step-evaluator.ts:679-681,841-843,936` |
| **P-8** | `ExperienceRecord.learningEligible` 一名两义：契约写 outcome 否决（`src/types/contracts.ts:1442-1443`、`src/jitrl/reward-contract.ts:503`），记录器写的是 task-quality 消费门（`src/orchestrator.ts:2180,2302`）；shape-only verdict 使本可走 process 轨道的记录整体不可学 | t3 §3 C-1、探针 P4 |
| **P-9** | reference 与 candidate **非同卷**：baseline 与每条 probe 的 `scoreUnderRewardContract` 都不传 trusted 集合；只认证 candidate 时 `learningTarget=0.5`，两侧都认证时 `0.9167`——差异来自验证覆盖不对称，不是 patch 效果 | t3 §3 C-4、探针 P5；`src/orchestrator.ts:2128,2166` |
| **P-10** | `buildRescoredBackfillRecord` 在 provenance 校验通过后**无条件**写 `learningEligible:true`，而 provenance 里的 `verifierId` 只是文本解析出的字符串，不与任何宿主注册表绑定；产物 `r4/verifier-first-v1@rescore-v1` 在认证表内 | t3 §2.6 C-9；`src/jitrl/backfill.ts:598,630,641`、`src/jitrl/reward-contract.ts:246-262` |

因此本轮需要一份新契约：把 publish 的执行受体钉死（C1.1），把「可信」从 shape 提升为**来源**（C2a），并为后续 C3 冻结可测试的成本数据基础（只契约 + 离线 fixture）。**本 ADR 不重开 C0+C1 的数值标尺，也不修改 ADR 0002 正文。**

---

## 2. R0：本轮范围与硬边界

| 项 | 本轮做 | 本轮不做 |
| --- | --- | --- |
| **C1.1 发布边界补漏** | 实现：publish 执行受体 deny、真实 apply 边界授权、holdout 语义收紧、idle 可审计、冲突旧测试按本 ADR 修正 | 不扩修普通 Dreamer 的 `config.jitrl.dream` 接线（§3.8，登记项）；不改 patch/memory 层 |
| **C2a 可信本地验证最小闭环** | 实现：宿主自有 runner、回执绑定、来源认证、统一 evaluation/recorder 接线、保守 A 失败资格、双回执同卷 | 不做 C2b（质量消费者接线）、不做真实模型/付费调用、不写真实 memory |
| **C3 成本台账** | **仅**数据契约（`src/ledger/**`）+ 离线 fixture 与单测（`tests/unit/ledger/**`、`scripts/fixtures/ledger/**`） | 不接线上选择、不改模型路由、不做动态路由/输出折叠、不宣称节省、不产生真实费用 |
| **C4 / D** | 不做，不预判，不标完成 | 部署、真实试验决定、`git commit`/`git push` |

**越界即回 captain 重新裁定**（沿用 ADR 0002 §11.2 机制）。任何实现/验证/评审不得自行扩大范围来「顺手修好」。

---

## 3. R1：C1.1——热更新发布、shadow 与真实 apply 边界

### 3.1 publish 层的执行受体清单（冻结）

「基础 Dream-RSI 在线热替换」与「持久 revision」**同属 publish 层**（captain R1）。publish 的执行受体在本轮冻结为下表，**全部默认 deny，且本轮任何路径都不解锁**：

| # | 受体 | 位置（HEAD 锚点） | 默认 | 本轮结论 |
| --- | --- | --- | --- | --- |
| **PB-1** | 任务周期 dream 的 `applyPolicy`（普通 Dreamer） | `src/orchestrator.ts:3148-3186` → `src/index.ts:1650-1668` → `src/dream-rsi/offline-dreamer.ts:1678-1684,1844-1846` | 现状**执行** | deny：实际 apply 次数 0 |
| **PB-2** | 任务周期 dream 的 `applyPolicy`（Jit-wired Dreamer，含 `/evo jit off` 分支的覆写） | `src/index.ts:1216-1250,1654-1668` | 现状**执行** | deny：同上 |
| **PB-3** | idle 入口 dream 的 `applyPolicy` | `src/index.ts:2751-2763` → `src/host-triggers.ts:565-613` | 现状**执行** | deny：同上 |
| **PB-4** | 持久化策略 revision（`policy.current.json` / `policy.history.jsonl`） | `src/persistence/policy.store.ts:344-347,493-498`（只由 `ActivePolicy.update` 触达） | 现状**写入** | deny：增量 0（PB-1…3 归零即自然归零；不得另开写入通道） |
| **PB-5** | L1 生效配置 provider 的 `publish()` | `src/jitrl/decision-kernel.ts:503-570` | **生产无装配点**（`src/**` 内只有定义与 `src/jitrl/index.ts:62` 的 re-export；唯一调用点全在 `tests/unit/jitrl/*`） | 本轮不接线；登记为「无生产受体」事实 |
| **PB-6** | 报告字段 `publication.publish` / `shadow.published` | `src/dream-rsi/offline-dreamer.ts:1853`、`src/jitrl/decision-kernel.ts:1150-1159` | 现状与事实**不一致** | 必须与真实 apply 结果**恒等**：未实际应用即 `false` |

**不属于 publish 层（本轮不动，防止误伤）**：`patch` 层的永久八面挂载（`applyWinningPatch`，`src/orchestrator.ts:1748-1769`，仍由 guarded-active + 证据门控）、`memory` 层的 commit/promote/mirror（`src/orchestrator.ts:3046-3056`，仍恒 deny 且调用点不调桥）、`offline_dream` 的**重放本身**（读多写少，见 §3.4）、`/evo jit off` 的 hook 开关（PR2 F1 语义不变）。

### 3.2 deny 语义（可判定，不接受「权限位为 false」当证据）

在**同一 effective profile**（`publish.allowed === false`，四模式全部成立）下，对 PB-1…PB-4 的每个受体必须同时成立：

1. `applyPolicy` / `activePolicy.update` **实际调用次数 = 0**（不是「callback 未注册」，而是「注册了也不被调用」）；
2. `policy.current.json` 内容逐字节不变，`policy.history.jsonl` 行数增量 = 0；
3. 活动策略对象身份（`id` + `version`）前后一致；`policy.jit` 块前后一致（防止「无 revision 但内存被改写」）；
4. `publication.publish === false` **且** `shadow.published === false`；
5. `improved === true` 仍可成立、`suggestedPolicyId` 仍指向候选（**建议能力不得被一起关掉**）；
6. `publication.reason` 必须点名拒绝它的闸（枚举与优先级见 §3.3 B 层合成规则），不得用「shadow mode」冒充「授权拒绝」。

**反空洞要求**：验收夹具必须是**真实改进深树**（4 个浅层兄弟 + 一条 3 层可下钻分支，t2 §3.1 夹具形状），且测试必须先断言 `improved === true` 作为前置；否则「apply 次数 0」可能只是因为候选没赢，属于空洞通过。

### 3.3 三道闸与两层判定（缺一不放行，且本轮三道全部关闭）

captain R5：**上层派生与真实 apply 边界授权必须同时做，不能只移除 callback**。为同时满足「不重开已通过的内核语义」与「真实边界必须自证」，判定拆成**两层**，文件所有权也按层划分：

| 层 | 位置 | 判定内容 | 谁改 |
| --- | --- | --- | --- |
| **A 证据层（纯函数）** | `src/jitrl/decision-kernel.ts` 的 `decideReplayPublication` | 「这个候选在证据上**可发布**吗」——只看 `improved` / `shadowMode` / `validatedOnHoldout` | t4（inScope） |
| **B 执行层（真实边界）** | `src/dream-rsi/offline-dreamer.ts` 的 apply 点 + `src/index.ts` 的装配 | 「这次**真的**应用了吗」——授权 + apply 目标 + 证据三者同时成立才调用 `applyPolicy`，并据此写报告字段 | t4（inScope） |

三道闸（分属两层，缺一不放行）：

| 闸 | 层 | 内容 | 本轮状态 | 允许放行的条件（未来） |
| --- | --- | --- | --- | --- |
| **G1 授权** | B | publish 授权是**显式输入**（dreamer 选项 `publishAuthorized`，缺省 `false`），由 effective profile 的 `permissions.publish.allowed` 派生并显式传递；`shadowMode` 单值**不得**再作为唯一闸 | 恒 `false`（`src/runtime/execution-profile.ts:119-122`） | 仅当显式 profile override 授予（生产无 config 形状可产生，同 `memoryRealWrites` 纪律） |
| **G2 真实边界** | B | 在**真实 apply 点**（`offline-dreamer.ts:1844-1846`）二次校验：`verdict.publish && publishAuthorized && applyPolicy !== undefined`；任一缺失即不调用、并输出可见诊断 | 二次校验恒拒绝 | G1 ∧ G3 同时成立 |
| **G3 证据** | A | 只有**显式** `validatedOnHoldout === true` 才算发布证据；`undefined`/`false` 一律不可发布 | 生产恒 `undefined` ⇒ 拒绝 | 显式配置 holdout 且候选在留出集上仍严格胜出 |

**A 层真值表（captain R2，冻结；`publish` 在此层含义是「证据上可发布」，不是「已授权」）**

| `improved` | `shadowMode` | `validatedOnHoldout` | `publish` | `reason` 必须为 |
| --- | --- | --- | --- | --- |
| false | 任意 | 任意 | **false** | `not-improved`（保持既有措辞「did not beat baseline」） |
| true | `true` | 任意 | **false** | `shadow-mode`（保持既有措辞「shadow mode: …」） |
| true | 非 `true` | `undefined` | **false** | **`holdout-missing`** ← 唯一收紧点 |
| true | 非 `true` | `false` | **false** | `holdout-failed`（保持既有措辞「held-out」） |
| true | 非 `true` | `true` | **true**（证据通过） | `evidence-ok`（措辞可沿用「strictly improved」） |

**B 层合成规则（报告字段必须等于事实）**

```
applied      = verdict.publish && publishAuthorized === true && applyPolicy !== undefined
reported     = applied
```

- `publication.publish === reported`、`shadow.published === reported`（**不得假 published**）。
- `reported === false` 时 `reason` 必须点名是哪一闸拒绝：`publish-denied`（G1 未授权）/ `no-apply-target`（G2 无 apply 目标）/ A 层原因（`holdout-missing`、`holdout-failed`、`shadow-mode`、`not-improved`）。`shadowMode=true` 的手建 dreamer 仍报 `shadow-mode`（既有断言不变）。
- **`shadow.comparisons[].selected` 必须跟着 `reported` 走**（rev.2 新增）：该字段今日由 `publication.publish` 派生（`offline-dreamer.ts:1859-1862`），**不是** `applied`。若只改报告字段而不改这里，deny 后 `publication.publish` 已是 `false` 所以 `selected` 自然为 false——**但只要将来 G1 授权、A 层通过而 G2 无 apply 目标**，`selected` 就会再次谎报「入选」。因此 t4 必须把 `selected` 的派生源从 `publication.publish` 改为 **`applied`**（与 `reported` 同源），让三个字段（`publication.publish` / `shadow.published` / `comparisons[].selected`）**恒等**。既有断言不受影响：`offline-dreamer.test.ts:1006-1009`、`:1137-1139` 都断言 `selected===false`，`:1066` 的 `selected===true` 分支只在 `publish===true` 时进入。
- **两层都改才算修复**：只做 B 层（不移除 callback 但恒不调用）会留下「A 层说可发布、B 层不发布」的分裂；只做 A 层（改内核）挡不住手建 dreamer 与未来显式 holdout 路径。

**对既有内核用例的影响（t4 必须核对）**：`tests/unit/jitrl/decision-kernel-parity.test.ts:1245-1276` 四条断言**全部保持通过**——`{improved:true, shadowMode:true}` 仍 `false` 且 reason 含「shadow mode」；`{improved:true, validatedOnHoldout:false}` 仍 `false` 且 reason 含「held-out」；`{improved:false}` 仍 `false`；`{improved:true, validatedOnHoldout:true}` 在 A 层仍 `true`（授权由 B 层拒绝）。该测试文件**不在 t4 inScope**，因此本 ADR 特意把授权放在 B 层，避免要求 t4 修改它。t2 §0.1 列出的「唯一翻转点」正是**新增**的 `holdout-missing` 分支（既有用例未覆盖该输入）。

**为什么 `{improved:true, validatedOnHoldout:true}` 在 A 层保留 `true`**：该函数是纯证据判定，`validatedOnHoldout:true` 是「显式留出验证通过」的合法输入；把它也改成 `false` 会让 A 层无法表达「证据通过但未授权」，从而使 B 层的 `publish-denied` 诊断失去判别力。**授权不是证据**，两者必须分开可测。

### 3.4 四模式 × 两个入口的语义表（冻结）

| 模式 | dream 重放 | 建议报告 | publish | 说明 |
| --- | --- | --- | --- | --- |
| **off** | **本轮不冻结**（见下「off 与重放」） | 若重放则同 shadow 形态 | **deny** | 七面停止（ADR 0002 §3）；**publish 仍 deny**；重放去留登记为 C1.1-O1，本轮不改变其语义 |
| **baseline** | 运行 | 诊断级 | deny | 宿主行为不变；不产生 shadow 建议标记（`shadowRecords=false` 既有语义） |
| **shadow（默认）** | 运行 | **产生**（suggested/incumbent/comparisons/holdout/boundary） | deny | 宿主 baseline 行为不变 + 建议记录；**基础 evo search 的 L1/L2 建议调整仍运行**（ADR 0002 t10 裁定延续，不因本轮收紧而停摆） |
| **guarded-active** | 运行 | 产生 | **仍 deny** | guarded-active 只解锁 patch 层证据门控；publish 本轮任何模式不解锁（ADR 0002 §4 + 本轮 R1） |

**四模式唯一共同结论：publish 一律 deny。** 本 ADR 只冻结这一条（captain R1「四模式全 deny」），**不冻结** `off` 对基础 dream 重放的去留。

**`execution.mode=off` 与 `/evo jit off` 是两个不同的开关，不得混用**：

- `/evo jit off`（`dreamJit` 运行时面，PR2 F1 语义）⇒ **只**停 Jit hook 注入与 Jit 超参热替换；基础 Dream-RSI 重放**必须继续**（既有断言 `tests/unit/jitrl/runtime-control.test.ts:259-315` 要求 `dreamTriggered===true` 且 `dreamReports` 增长）。**这条是冻结的既有语义，本轮不动。**
- `execution.mode=off`（声明式，ADR 0002 §3 的第四模式）⇒ 停**全部七面**（`src/orchestrator.ts:1895-1912` 的 `surfaceEnabled` 已由 `this.executionProfile.off` 短路）。**它对基础 dream 重放的去留，ADR 0002 §3 只写了「语义与本轮之前逐字不变」，而本轮之前的行为是「off 仍重放并发布」**（t2 §3.1 实测 `off` 行 `dreamTriggered=true`、`publish=true`）。因此：
  - 本轮**只**把 `off` 下的 `publish` 关掉（与其余三模式一致，R1 的直接后果），**不**顺手改变 `off` 是否重放；
  - 「`off` 是否应当停止 dream 重放」登记为 **C1.1-O1**，属**语义扩张**，须 captain 另行裁定后另开工作项（ADR 0002 §11.2 越界机制），t4 **不得**自行实现。
- **若 captain 后续裁定 `off` 停止重放**，两条实现纪律依然成立（预登记，避免返工）：①**不得**用 `surfaceEnabled('dreamJit')` 作为 `off` 的短路条件（该函数混入了运行时开关，用它会顺带杀掉 `/evo jit off` 场景下必须继续的重放）；短路必须直读 `this.executionProfile.off`，加在 `runDream` 与 idle dream 入口之前；②必须同时补一条 `execution.mode=off` 的 `dreamTriggered` 断言（既有测试只覆盖 `/evo jit off`，无 `off` 模式断言；实测确认见 §13.1-F1 证据列）。

### 3.5 shadow 与 deny 的可审计性（含 idle，captain R3）

1. **两个入口必须收敛到同一条 orchestrator 拥有的 dream 路径**：idle 不得绕过 orchestrator 直接 `deps.dreamer.replay`（`src/index.ts:2751-2763`）。推荐实现是在 orchestrator facade（`src/orchestrator.ts:302-303` 的公开面）新增一个 dream 入口，由 `src/index.ts` 的 `dreamRun` 调用；**不需要改 `src/host-triggers.ts`**（不在本轮 inScope）。
2. 一次 dream 无论来自哪个入口，都必须可审计：`dreamReports` 有对应条目、`recordDream` 计数一致、诊断行含 `publication.publish` 与 reason。
3. **不得假 published**：`publication.publish` / `shadow.published` 必须等于真实应用结果（§3.2-4）。仅「移除 applyPolicy」而不改报告值，会产出「报告说发布了、实际没发」——本轮明确禁止这种修法（t2 §5 已实证）。
4. deny 下的建议必须仍可读：`suggestedPolicyId`、`incumbentPolicyId`、`comparisons[].delta/improved`、`selectionTreeIds`/`holdoutTreeIds`、`boundary` 全部保留。

### 3.6 冲突旧测试的修正口径（captain R1）

以下 **5 处**既有测试把「improved 即热替换」当作**期望行为**，须按本 ADR 修正为「improved 但 publish deny」。清单与 t2 §0（R1 行）逐项一致（初版误记 4 处，rev.2 补入第 5 处）：

| # | 位置 | 今日断言 | deny 后必须变成 |
| --- | --- | --- | --- |
| 1 | `tests/unit/dream-rsi/offline-dreamer.test.ts:515-537` | `applied.length === 1` | `applied.length === 0` |
| 2 | `tests/unit/dream-rsi/offline-dreamer.test.ts:539-558` | `activePolicy.update` 被调 | 未被调 |
| 3 | `tests/unit/dream-rsi/jit-dream.test.ts:922-975` | 两轮 beta 热替换（`applied).toHaveLength(1)`、`active.policy.jit.beta===2`） | 零热替换；`improved` 与 `suggestedPolicyId` 仍成立 |
| 4 | `tests/unit/dream-rsi/dream-rsi-pipeline.test.ts:227-278` | `appliedPolicyIds` 递增到 `['pi-0@1','pi-deep@2']`、`active.policy.version===2` | 保持 `['pi-0@1']`、`version===1` |
| 5 | **`tests/unit/jitrl/runtime-control.test.ts:319-421`** | `applied).toHaveLength(1)`、`swapped.id==='pi-deep'`、`maxDepth===4`（夹具**未配 holdout**，今日真实 apply） | 见下方「保留判别力」的等价形态之一 |

**（5）的特殊性**：该用例同时承担「Jit 扰动不得泄漏进在线策略」这一**独立安全性质**（断言 `swapped.jit.beta===1 / lambda===0.05`，即 `/evo jit off` 下 pin 住 incumbent 的 jit 块）。它的**非空洞前提**是「候选真的赢了、applyPolicy 真的被调」。deny 后 `applyPolicy` 不再被调，若只把 `applied` 改成 0，该安全断言的判别力会一并消失（空数组上无法断言 jit 未被污染）。**必须**选下列等价形态之一保留判别力：

- **(i) 授权正控形态（推荐）**：同一夹具改为显式授予 publish（仅测试 profile override）+ 显式 holdout 通过 ⇒ 真实 apply 发生，此时继续断言 `swapped.jit.beta===1`（扰动未泄漏）；**另加**一条 deny 形态断言 `applied.length===0`。
- **(ii) 纯 deny 形态**：断言 `applied.length===0` 且 `activePolicy.policy.jit` 与 `improved`/`suggestedPolicyId` 仍成立，并在注释中明确「jit 泄漏由 (i) 或 `jit-dream.test.ts` 的 pinning 用例覆盖」，不得留下无人覆盖的静默缺口。

其余修正纪律：

1. **不弱化**任何安全断言：`runtime-control.test.ts:319-421` 的「Jit 扰动不得泄漏进在线策略」必须保留判别力（按上述 (i)/(ii)）。
2. 每个修正后的用例必须保留**非空洞前提**：`improved === true` 与 `suggestedPolicyId === 候选 id` 仍被断言。
3. 需要一条**授权正控**：显式授予 publish（仅测试 profile override，生产不可达）+ 显式 holdout 通过 ⇒ 真实 apply 发生、revision +1、`publication.publish === true`。正控证明修复不是「硬编码永不发布」。
4. 需要**旧实现必失败**的反例：同一夹具在 HEAD 实现上 `publish===true` 且策略被改写；修复后 `publish===false` 且零写入。
5. **不需要改的**：`offline-dreamer.test.ts:966-1013`（`shadowMode:true`）、`:1015-1071`、`:1073-1117`（显式 `holdoutTreeCount:1`）、`decision-kernel-parity.test.ts:1245-1276` 四条**全部保持通过**（§3.3 已逐条核对）。t2 §0.1 的 B 表把 `dream-rsi-pipeline.test.ts:227-278` 标为「不涉及发布」，指的是**另一个用例** `:227` 的 `improved=false` 断言段；同一 `it` 块内的 `:267-277` 才是热替换断言（即上表第 4 行）。t4 按**行号**而不是按 `it` 块标题定位。

### 3.7 本轮只保证什么（诚实边界）

- 本轮只保证：**deny 下无策略对象变更、无 `policy.jit` 变更、无策略持久化 revision 变更**。
- 本轮**不**保证：dream 重放对 `tree-pool.jsonl` 的日志增长（t2 §9-4 实测每次 dream 净增 1 条 `kind:'tree'` 记录，属审计日志膨胀、不改重放语义）——登记为已知限制，不在 C1.1 修。
- 本轮**不**保证：多进程/多实例并发 dream 的 revision 竞争（t2 §9-1 未探测）——登记为未覆盖项。
- 本轮**不**保证：`execution.mode=off` 是否应停止 dream 重放（C1.1-O1，须 captain 另行裁定，见 §3.4）。
- 宿主若绕过插件直接调用 `ActivePolicy.update`，属宿主自有代码，不在插件发布受体范围内；状态页与报告不得据此声称「插件已阻止一切发布」。

**关于「`holdoutTreeCount` 在 `src/**` 零引用」的精确化**：该说法**只在「零*传值*引用」的意义上成立，措辞必须收紧**。实测（t1 rev.2 复核）：`src/dream-rsi/offline-dreamer.ts` **自有**该字段的定义与消费（`:1562` 声明、`:1664` 归一化、`:1765` 切分），但**全仓无任何装配点传值**——`src/index.ts:1642-1668` 的 `dreamBase` 不含它，`createJitWiredDreamer` 也不补，唯一传值点是 `tests/unit/dream-rsi/offline-dreamer.test.ts:1020,1091`。因此正确表述是「**生产装配零传值引用**」，而非「`src/**` 零引用」。这条区别有判别意义：`holdoutTreeCount` 是**已实现、已单测、但生产不可达**的能力（`offline-dreamer.ts:1818-1832` 的 holdout 验证分支永远走不到），G3 的 `holdout-missing` 才是生产中的**唯一必然结果**。状态页与验证报告必须按此措辞，不得写成「holdout 未实现」。

### 3.8 登记项（本轮不修，captain R4）

普通（非 Jit-wired）Dreamer 忽略 `config.jitrl.dream`（`src/index.ts:1668` 未传 `generatePolicies`，候选恒用冻结默认网格），且会把默认 `jit` 块写进活动策略（`src/dream-rsi/offline-dreamer.ts:377-382`）——这是**独立配置接线缺陷**，本轮只登记，不借 C1.1 扩大重写。R1 生效后该链条的「写入在线策略」后果自然断开（无 publish 即无 `applyPolicy`），但「候选网格不消费配置」本身仍需后续修复。

---

## 4. R2：C2a——可信本地验证边界

### 4.1 「可信」的定义（替换「verifierId 白名单」）

**可信 = 宿主自有 runner 实例在本轮运行内登记、并绑定宿主重算 artifact 摘要的回执。** 冻结为 6 条：

| # | 规则 | 依据 |
| --- | --- | --- |
| **T1** | 回执**只能**由宿主 runner 实例产生，并在该实例的 per-run 注册表按 `(runId, trajectoryId, role)` 登记 | t3 §4.2；关闭 C-5/C-7 |
| **T2** | `attach` **只接受注册表命中对象**；分支/执行器自报 payload 永不获得信任；collector **不得**透传 `ProbeExecutionResult.metadata` | `src/cordis-seams/trajectory-collector.ts:288,332,334` |
| **T3** | artifact 摘要由**宿主重算**（`node:crypto` sha256 over artifact bytes），回执 `evidenceHash` 必须等于它，并写入 `trajectory.deliverable.contentHash`——使既有 `expectedEvidenceHash` 比对分支**真正生效**；**不改** evidenceHash 的旧语义 | `src/jitrl/step-evaluator.ts:909-912,540`；关闭 C-6 |
| **T4** | 绑定四元组必须齐全且一致：`taskId` + `testSetId` + `envId` + `runId`（另含 `trajectoryId`/`role`）；任一缺失或不匹配即拒绝（`binding-mismatch`） | t3 §4.2 `VerificationBinding` |
| **T5** | 显式 `implicit:true` 的 payload **永不**可信；attach 只写非 implicit 回执 | 关闭 C-10 |
| **T6** | runner 零网络、零模型、零 memory/patch/publish；回执与记录不含绝对路径/秘密（沿用既有 redaction 口径） | t3 §4.4 I8/H2 |

`trustedProducers` 注入接缝形状保留，但它**不再是来源认证**：生产装配把它设为 runner 持有的集合，且只作为 scorer 的**第二个必要条件**。生产轨迹不带 `metadata.verification`（T2），因此该集合在生产中**单独无法**使任何 payload 变 trusted——这是纵深防御，不是认证机制本身。**不得**恢复任何模块级字符串注册器（ADR 0002 t7/V5 结论延续）。

### 4.2 最小可读字段集（回答「是否需要加宽 t5 范围」）

**结论：本轮不需要加宽 t5 到 `src/types/contracts.ts`。** 最小可读字段落在三个不持久化的载体 + 一个已存在的持久化字段上：

| 字段 | 载体 | 必需性 | 说明 |
| --- | --- | --- | --- |
| `verificationId` | `trajectory.metadata.verification`（回执本体） | **必需** | 回执唯一 id（`<verifierId>@<verifierVersion>#<runId>#<trajectoryId>` 形态即可，t5 定格式） |
| `verifierId` / `verifierVersion` | 同上 | **必需** | 既有 `TrustedVerification` 字段，不新增 |
| `status` (`passed`/`failed`/`unknown`) | 同上 | **必需** | 既有字段 |
| `evidenceHash`（= artifactDigest） | 同上 + 写回 `deliverable.contentHash` | **必需** | T3 |
| `checks[]`（`id`+`passed`） | 同上 | **必需** | 既有字段（空数组拒绝） |
| `binding`（taskId/testSetId/envId/runId/trajectoryId/role） | 同上（回执的一部分） | **必需** | T4 |
| `kind: 'host-runner'` | 同上 | **必需** | 区分宿主回执与结构兜底 |
| `termination`（`succeeded`/`failed`/`timeout`/`aborted`/`cancelled`/`infrastructure_error`） | **已存在**：`ExperienceRecord.outcome`（`src/types/contracts.ts:1440-1443`）与 `TrajectorySignalScore.outcome` | **已具备，无需新增** | 执行终止状态 |
| `verdict` + `trusted` + `auditOnly`（数值标记） | `ExperienceRecord.rewardSources`：`verificationVerdict`(0/1/2)、`verificationTrusted`(0/1)、`verificationAuditOnly`(0/1)、`outcomeEligible`(0/1) | **必需** | 已实测可持久化并 round-trip（t3 探针 P7） |
| 拒绝原因（有界枚举） | `trajectory.metadata.verificationAudit.reasonCode` + stage detail + 诊断行 | **必需** | 枚举见 §4.6 |
| 可读 reason 文本 | 同上（**有界**，不回显载荷/路径） | 必需 | 与 reasonCode 配套 |

**为什么不加宽**：①持久化记录的资格权威已经是结构性的（`learningEligible`/`learningTrack`/`rewardVersion`），再加一个可读 `verificationId` 目前**没有消费者**；②`ProbeTrajectory` 本身不进入经验存储，回执的可读溯源天然属于轨迹/诊断层；③新增持久化字段会引入新的 schema 面与 PII/路径泄漏风险，而本轮零消费者收益。

**硬约束（rev.2 新增，避免 t5 直接撞墙）：`TrustedVerification` 接口定义在 `src/jitrl/step-evaluator.ts:556-564`，而该文件不在任何任务的 inScope 内**（t5 outOfScope 明确列入 `src/jitrl/step-evaluator.ts`；它也从未出现在 `src/types/contracts.ts` 中）。由此产生三条**不可绕过**的结论：

1. 上表新增的 `verificationId` / `binding` / `kind` 三个字段**不可能**通过改 `TrustedVerification` 类型来声明——t5 不得尝试，也不得为了加字段而把 `step-evaluator.ts` 纳入范围（那是越界，须回 captain）。
2. **正确形态是「随附」而非「扩展类型」**：`trajectory.metadata` 的类型是开放的 `ContractMetadata = Readonly<Record<string, unknown>>`（`src/types/contracts.ts:109`、`:424`），因此 t5 在 attach 时把回执作为一个**结构化对象**写入 `metadata.verification`，其**运行期形状是既有 `TrustedVerification` 的超集**（额外带 `verificationId`/`binding`/`kind`）。`readTrustedVerification` 走 `isTrustedVerification` 的**结构化校验**（`:587-623`，逐字段检查且**不拒绝多余键**），所以超集对象仍能通过校验并进入 scoring——这是这条路径唯一成立的原因，也是 T3/T4 能落地的前提。
3. **但超集字段在 scorer 侧是「不可读」的**：`step-evaluator.ts` 不认识 `binding`，故 `VerificationBinding` 的**一致性校验（T4）必须由宿主 attach 侧自己完成**，不能寄望 scorer 帮忙。换句话说：**认证（binding/kind/registry）是 t5 的职责，评分（reward/eligibility）才是 scorer 的职责**；t5 必须在 attach 前完成全部 binding 校验，并把结论编码进 `metadata.verificationAudit` 与 `rewardSources` 数值标记。

**若 captain 仍要求持久化可读 id**：最小加宽是给 `ExperienceRecord` 增加**恰好两个可选字段** `verificationId?: string` 与 `verificationReasonCode?: string`（有界枚举），同步 `experience-store.ts` 的 `normalizeRecord`/`toExperienceRecord` round-trip，`experienceSchemaVersion` **不 bump**、缺失即按 undeclared 处理（fail-closed，绝不据此提升 track）。**不得**新增 `verificationTrusted?: boolean` 之类「信任位」——信任是判定，不是载荷，落库即可能被误读或被伪造写入。注意这条加宽需要 `src/types/contracts.ts`，**t5 当前不在范围内**，须 captain 显式加宽（§9 已登记）。

### 4.3 失败资格：保守 A（captain 修订版，**outcome 级**）

t3 原建议「仅 `status==='succeeded'` 可承载 task-quality」**已被 captain 收窄修正**：真实 `outcome=failed` + trusted `failed` 是 C2 要恢复的**可靠失败学习正例**，不能一并排除。冻结真值表：

| `outcome` | trusted 回执 | 记录形态 | `learningEligible` | `learningTrack` | reward 列 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| `succeeded` | trusted `passed` | 可信正样本 | **true** | `task-quality` | 融合值（completion=+1） | C2a 的核心正例 |
| `succeeded` | trusted `failed` | falsified success claim | **false**（审计编码） | `process` | **0** | 保守 A：声称成功但被可信证伪 → audit-only，保留 verdict/原因 |
| `failed` | trusted `failed` | **可信负样本** | **true** | `task-quality` | 融合值且 **≤ 0**（词典序钳制不变） | **可靠失败学习的正例**（C2 目标）；本轮消费者仍锁 process，见 §5.4 |
| `failed` | trusted `passed` | 矛盾 | **false** | `process` | 0 | 执行失败而验证通过 = 不可归因，audit-only |
| `timeout` / `aborted` / `cancelled` / `infrastructure_error` | 任意（含 trusted） | **异常执行** | **false**（outcome 否决） | `process` | **0** | **必须 audit-only**；保留 `outcome`/`termination`/verdict/原因（关闭 C-3） |
| 任意 | 无 trusted 回执（默认：无 runner） | shape-only | 见 §5.2 | `process` | 见 §5.2 | 未认证 verdict-derived completion **不得**进 reward 列 |

**关键实现约束：本表的判定必须落在 attach 侧（t5），不能指望 scorer 侧自动成立。** 理由是可判定的：`verificationFromTrajectory`（`src/jitrl/step-evaluator.ts:674-685`）在把显式回执交给 scoring 之前，**已把「非 `succeeded` 执行 + `passed`」降级为 `unknown`**（`:679-681`）。因此：

1. **`failed` 执行 + trusted `passed`（上表第 4 行）在 scorer 侧根本不可见**——它到达 `scoreUnderRewardContract` 时已经是 `unknown`，而 `unknown` 走的是「无 verdict」的 process 路径（completion=0），**不会**得到本表要求的 `process` + reward 0 + 审计标记。**必须**由 attach 侧在 attach 之前就判为矛盾并直接走审计通道（reasonCode `contradictory-verdict`），否则该行无法实现。
2. 同理，`succeeded` + trusted `failed` 的 `falsifiedSuccessClaim`（`step-evaluator.ts:841-843`）在 scorer 侧**已成立**，但 reward 钳制只把正 reward 归零（`:896-898`），`eligible` 的最终值仍由 recorder 消费门决定，因此**仍需** recorder 侧写审计编码。
3. `timeout` 的漏点（§4.3 约束 1）**不得**通过修改 `isLearningOutcome` 关闭：既有测试已把 `isLearningOutcome('timeout') === true` 钉死（`tests/unit/orchestrator/credit-attribution.test.ts:1253`），改它会破既有契约。超时门**只能**在 attach 侧或 recorder 侧的「异常执行」判定里实现，且该判定必须与 `isLearningOutcome` 分开命名（避免读者误以为两者同义）。

约束：

1. **异常执行门是 outcome 级，不是 `status==='succeeded'` 级**（captain 修正）。`timeout` 是当前唯一漏格（`src/jitrl/step-evaluator.ts:841-843` 只对 `succeeded` 判伪），必须由 C2a 的 attach 侧（或装配侧等价边界）关闭；`aborted/cancelled/infra` 已由 `isLearningOutcome`（`:417-419`）先行否决。
2. **不暗改 r4**：本表只影响 eligibility/track，**不改变** `REWARD_CONTRACT.version`/aggregation/weights/clip/`contractWeightsHash()`，不引入任何新的 ±1 契约。`failed` 的 −1 与词典序钳制沿用 ADR 0002 §5.1。
3. 超时/取消/infra **不冒充可靠任务失败**：其 verdict 即使为 trusted `failed` 也只作审计；诊断与记录必须能读出「这是超时，不是失败」。
4. **不新增「信任位」到持久化记录**：verdict/trusted/auditOnly 只以 `rewardSources` 的**数值**标记表达（`verificationVerdict` 0/1/2、`verificationTrusted` 0/1、`verificationAuditOnly` 0/1、`outcomeEligible` 0/1）。已实测这些自定义数值键可经 append→query 原样 round-trip（`experience-store.ts:384-394`、`:653`；t3 探针 P7），**无需**加宽 `types/contracts.ts` 或 `reward-contract.ts`。

### 4.4 双回执同卷（captain R3，关闭 C-4/P-9）

1. **reference 与 candidate 必须各出一份 trusted 回执**，同一 `testSetId`/`envId`/`runId` 绑定、同一 `trustedProducers` 集合参与打分（`src/orchestrator.ts:2128` 与 `:2166` 两处**都**传集合）。
2. **缺 reference 回执 ⇒ candidate 回执仅审计**（fail-closed）：该 run 的 `learningTarget` 不得基于「只认证了 candidate」的不对称比较；reasonCode = `reference-receipt-missing`。
3. `learningTarget = candidate.observedReturn − reference.observedReturn` 的等式保持不变，但其**可比性前提**由本条保证。
4. 验收必须有 E1/E2 探针：两侧都有回执时 `learningTarget` 只反映 patch 差异；只有一侧时该 run 的记录为 audit-only。

### 4.5 默认退化与等价性（deny-by-default）

1. **无 runner ⇒ 无 attach ⇒ 与 HEAD 逐字节等价**（既有 25 条 guarded regression + 全量测试不变）。
2. **无 config 形状可开启 runner**：`src/config.ts` 不新增字段（本轮不在 t5 范围）；只有宿主显式注入 runner 才生效（同 `memoryRealWrites` 的「配置形状不可加宽」纪律）。
3. 有 runner 但集合为空 ⇒ 回执 shape-only ⇒ 无 task-quality 记录（保守退化）。

### 4.6 拒绝原因枚举（有界、可测）

`no-runner`、`artifact-missing`、`malformed-receipt`、`implicit-payload`、`unregistered-receipt`、`digest-mismatch`、`binding-mismatch`、`test-set-mismatch`、`env-mismatch`、`run-mismatch`、`stale-artifact`、`execution-not-completed`、`falsified-success-claim`、`contradictory-verdict`、`reference-receipt-missing`、`duplicate-receipt`、`runner-error`、`runner-timeout`。

原因码必须**进记录/诊断**（§4.2），且**不得**包含载荷正文、绝对路径或秘密。

**`artifact-missing` 的适用边界（captain 2026-10-26 新增）**：artifact 为空、缺失或不可定位时，宿主**无法重算 digest**，必须立即以 `artifact-missing` 拒绝，**不得**退化为「跳过 digest 校验、只凭形状 + verifierId 判可信」。理由：`hasTrustedVerificationProvenance` 的 hash 比对分支是**条件性**的（`step-evaluator.ts:540`：`expectedEvidenceHash !== undefined` 才比对），一旦 host 侧不产出 digest，比对分支就被跳过，只剩「id ∈ 集合 + 自报 hash 非空」——这正是 P-6 / C-7 的漏洞形态。因此 `artifact-missing` 是**必需的 fail-closed 出口**，不是可选诊断。

### 4.6a 三条精度约束（captain 2026-10-26 下达；t5 实现与 t8 验收共同遵守）

这三条都是「**看起来已经通过、实际没有判别力**」的陷阱，必须显式写进验收矩阵：

#### (1) 空 `checks` 必须在 attach 侧拒绝（scorer 不会替你拒绝）

**事实**：`isTrustedVerification`（`src/jitrl/step-evaluator.ts:587-623`）对 `checks` 只做 `Array.isArray` + 逐项形状校验，**没有非空校验**。实测（t1 rev.3 探针 `work/_t1-checks-probe.ts`）结果：

| payload | `isTrustedVerification` |
| --- | --- |
| `checks: []`（空数组） | **`true`** ← 形状校验**通过** |
| `checks: [{id:'c1',passed:true}]` | `true` |
| 缺 `checks` 字段 | `false` |
| `checks: [{id:'',passed:true}]` | `false` |
| `evidenceHash: ''` | `false` |

**结论**：`checks: []` 是**结构合法**的。若 t5 只在 attach 侧检查 `isTrustedVerification`，一个**没跑任何检查**的回执会被当成可信回执。**t5 必须在 attach 侧自行拒绝空 `checks`**（reasonCode `malformed-receipt`），不得依赖 `step-evaluator.ts`——该文件不在 t5 范围内，**也不应**为它扩大范围。

#### (2) **不得**断言 FNV `hashString` 与宿主 sha256 跨轨迹相等

**事实**：仓库存在两套完全不同的摘要，且**都叫 `contentHash` 语义**：

| 摘要 | 实现 | 长度/强度 | 在哪条路径上 |
| --- | --- | --- | --- |
| `hashString()` | 32 位 **FNV-1a**，`src/harness2/shared.ts:104-111` | 8 hex，**非密码学** | `deliverableOf()` 填入 `deliverable.contentHash`（`shared.ts:228-237`），仅被 `src/harness2/composer.ts:186,189,383` 用于**展示/去重** |
| 宿主 artifact digest | `node:crypto` **sha256**（t3 §4.2 设计 `src/verification/artifact-digest.ts`） | 64 hex，密码学 | attach 时写入 `trajectory.deliverable.contentHash`（T3） |

`deliverableOf` 的两个分支：无 deliverable 时返回占位 `hashString('')`；有 deliverable 但**未带** `contentHash` 时补 `hashString(content)`——两者都是 **FNV**。而生产轨迹的 deliverable 由 `agent-loop-executor.ts:500` / `branch.ts:204` 构造，**均不写 `contentHash`**（P-6 的根因）。

**约束**：
- **不得**写「`deliverableOf` 已经算好 `contentHash`，宿主只需比对」——那是 FNV，与宿主 sha256 **必然不等**；
- **不得**断言「同一 artifact 的 FNV 值 == host sha256 值」或「跨轨迹二者相等」。这类断言**恒假**，写成测试会永久失败，写进报告则是错误结论；
- attach 侧的规则是**覆盖**而非比对：宿主重算 sha256 后**写入** `deliverable.contentHash`（若已存在则由 T3 覆盖为宿主值），使 `expectedEvidenceHash`（`step-evaluator.ts:909-912`）取到的是宿主摘要，比对分支才真正生效；
- 若某条验收需要「FNV 与 sha256 一致」才能通过，说明该验收写错了，应改为「attach 后 `deliverable.contentHash` 等于宿主 sha256」。

#### (3) 旧 artifact / 错绑必须断言 **attach 侧原因码**，不能只看 scorer 的 `trustedSource`

**事实**：`trustedSource=false` 是**多因一果**的终态——`hasTrustedVerificationProvenance`（`:526-544`）在「`implicit:true`」「id 不在集合」「hash 空」「hash 不等于 `expectedEvidenceHash`」四种情形下**都**返回 `false`。因此「`trustedSource===false`」**无法区分**：

- 旧 artifact（digest 不匹配 → 应为 `stale-artifact` / `digest-mismatch`）；
- 错绑 test set / env / run（→ `test-set-mismatch` / `env-mismatch` / `run-mismatch`）；
- 未注册回执（→ `unregistered-receipt`）；
- 根本没有 runner（→ `no-runner`）。

**约束**：t8 对 B2（旧 artifact）、B3（异 task / 旧 test set）等用例，必须**同时**断言 attach 侧产出的**具体 reasonCode**（来自 §4.6 枚举），而**不能**只断言 `trustedSource===false`。否则这些用例会在「什么都没做」的实现上**空洞通过**（没 runner 时 `trustedSource` 天然 false）。

对应地，t5 必须让这些拒绝路径**产出可读原因**（`metadata.verificationAudit.reasonCode` + stage detail + 诊断行），而不是静默降级为 `undefined`。

### 4.7 幂等与确定性

1. **一次轨迹一份回执**：同一 `trajectoryId` 的第二个 verdict 不新增记录、不覆盖首写（首写为准）；重复投递走既有去重键（`src/orchestrator.ts:2351-2359`）。
2. **runner 确定性**：同 artifact + 同 test set + 同 env ⇒ digest 与 verdict 深度相等。
3. **跨 run 重放拒绝**：上一轮回执喂给新 run 必须失败（T1 注册表键含 `runId`）。

---

## 5. R3：`learningEligible` 字段与消费门分离（captain 最终选择：方案 a，零行为变化）

### 5.1 字段语义（本轮冻结）

- `ExperienceRecord.learningEligible` 的契约语义 = **「该记录是否可训练」**（消费谓词的唯一开关，`src/jitrl/reward-contract.ts:499-515`）。
- 它的 `false` 有**两种原因**，必须可区分：
  1. **outcome 否决**（cancel/abort/infra）——ADR 0002 既有语义；
  2. **审计编码**（未认证的 verdict-derived completion、falsified success claim、异常执行带 verdict）——**本轮新增明确**。
- **`learningEligible:false` 是审计编码时，它不是 outcome 否决。** 该事实由 `rewardSources.outcomeEligible`（0/1）承载：`outcomeEligible=1` 且 `learningEligible=false` ⇒ 审计编码；两者皆 0 ⇒ outcome 否决。**不得**把 `learningEligible:false` 一律读作「执行失败」。
- 消费侧**不变**：任何 `learningEligible===false` 一律排除（`learningEligibleOnly` 谓词、快照预过滤、分区/镜像路径）。这是**零行为变化**的关键。

### 5.2 两条分叉（recorder，`src/orchestrator.ts:2180,2245-2268,2302`）

| 分叉 | 条件 | 写什么 |
| --- | --- | --- |
| **学习分叉** | `evaluation.taskQualityLearningEligible === true` | `learningEligible = evaluation.learningEligible`；reward 列 = `evaluation.reward`；`learningTrack = taskQualityEvidence ? 'task-quality' : 'process'` |
| **审计分叉** | `taskQualityLearningEligible === false` | `learningEligible = false`（**审计编码**）；`reward = 0`、`observedReturn = 0`、`learningTarget = 0`；`learningTrack = 'process'`；`rewardSources` 加 `outcomeEligible` + verification 标记；stage detail 与诊断写 reasonCode |

**红线**：未认证的 verdict-derived completion **绝不能**把 shape-only 的 `+0.5` 之类融合值写成可学正样本。reward 列继续由 `taskQualityLearningEligible` 把守——这一条是 ADR 0002 §5.2a 保守隔离的延续，不是新收紧。

### 5.3 support / nEff 计数（冻结）

1. audit-only 记录（`learningEligible:false`）在 `learningEligibleOnly` 查询中**结构性排除**，因此**不进** support、**不进** nEff、不进任何学习邻域。
2. **零值审计编码不得充数**：为保留审计而写的 `reward=0` 记录一律带 `learningEligible:false`，绝不进入估计（因此无需新增过滤器）。
3. nEff 仍是同一过滤集上的 Kish 有效样本量（`src/jitrl/value-estimator.ts:249-253`）；support 仍是原始条数共报（`:252`），替换判定**只认 nEff**（`:446-485`，ADR 0002 R5-2 不变）。
4. **登记（不改）**：无 verdict 的 `unknown` 过程记录若其融合 reward 恰为 0，仍可能进入 support 并贡献 0 优势——这是冻结的研究路径语义（ADR 0002 R6）。本轮**不**改它，登记为 C2b 评审项。

### 5.4 本轮交付边界（诚实区分）

- C2a 交付的是**可信记录闭环**：可信回执 → 统一 evaluation → recorder → 记录带 `task-quality` track。
- **质量消费者尚未接线（C2b）**：生产 L1/L2/L3/replay/M3 一律以 `PRODUCTION_LEARNING_TRACK='process'` 预过滤（`src/jitrl/jit-active-policy.ts:745-747`、`src/jitrl/index.ts:500-509,597-610,880-895,971-979`），因此本轮写入的 `task-quality` 记录**写进去读不出**。这是**设计边界**，必须在状态页与报告中如实登记，**不得**声称「可信验证已生效于学习」。
- 必须有探针钉住**不泄漏**：task-quality 记录不得进入任何 process 邻域（既有 T7-V3 需补真实回执版本，见 §7）。

---

## 6. R4：rescore / backfill seam 本轮冻结（关闭 C-9/P-10）

1. `src/jitrl/backfill.ts` **本轮不修改**（不在任何任务 inScope）。
2. **不得借 C2a 的新生产者/新回执重标历史记录**：不得用 runner 的 `verifierId`、不得伪造 provenance、不得把旧记录 relabel 成 `task-quality`、不得把旧记录升到 r4 邻域。
3. 该 seam 的已知风险（`provenance.verifierId` 只是文本字符串即可得到 `learningEligible:true` + r4 兼容）**登记为 C2b / 独立 ADR 的收口项**；本轮的状态页必须写明「rescore 通道未与宿主回执绑定」。
4. 历史记录的处理口径不变：不批量迁移、不原地改写审计日志、旧 r3/r2/surrogate 自动隔离（ADR 0002 §5.2 延续）。

---

## 7. R5：C3 成本台账——仅数据契约与离线 fixture

### 7.1 目标与不做

**目标**：为后续 C3 实施冻结**可测试的数据基础**——计价输入语义、`reserve`/`settle` 生命周期、未知成本的保守语义、探索 seat 与金额退款的区分。

**不做**：不接线上选择、不改模型路由（`src/dsh-bridge/model-config.ts`）、不做动态路由/输出折叠、不产生真实付费调用、不宣称任何节省、不修改 `r4` 的 `learningTarget`。

### 7.2 为什么必须新建独立契约（而非复用 `TokenUsage`）

- 冻结的 `TokenUsage` 只有 `inputTokens/outputTokens/totalTokens`（`src/types/contracts.ts:324-328`），**丢弃**了 `cacheReadTokens`/`cacheWriteTokens`/`reasoningTokens`（`src/dsh-bridge/model.ts:231-247` 的 `usageToTokens` 只映射三个字段；`src/dsh-bridge/agent-loop-executor.ts:344-357` 的 `addUsage` 也只累加三个字段）。
- 因此「防 provider cache/reasoning 重复计价」**不能**靠既有 `TokenUsage` 完成：`src/ledger/**` 必须自带 provider 用量载荷与**计数语义声明**。

### 7.3 计价语义（冻结）

1. **不猜 provider 语义**：每条用量必须显式声明 `countingSemantics`（至少 `inputIncludesCacheRead`、`outputIncludesReasoning`）。语义未声明 ⇒ `provenance:'unknown'`。
2. **三态计量**：每个计数字段标注 `measured` | `estimated` | `unknown`。
3. **cacheRead / cacheWrite 独立费率**，且**不得**与 input 重复计费（按声明的子集关系扣除）。
4. **reasoning 只在费率表声明其单独计价时计费**；若 `outputIncludesReasoning=true` 则**不得**再加一次。
5. **未知成本非零保守**：`unknown` 必须落到**保守上界**金额（`conservative:true`），**绝不允许**静默记 0——0 会让预算与收益结论失真。
6. **已发生花费 ≠ 质量证据**：取消/超时/infra 已产生的花费照实结算（`incurred`），但对应记录仍 audit-only（§4.3），两者互不推导。

### 7.4 `reserve` / `settle` 生命周期（冻结）

| 规则 | 内容 |
| --- | --- |
| 并发 | 每个 `callId` 一个独立 `reservationId`；并发调用互不覆盖 |
| 幂等 | 同一 `callId` 重复 `settle` 返回首次结果、不二次扣减 |
| 共享总预算 | 剩余额度不足时 `reserve` **fail-closed** 拒绝；不得透支 |
| 验证保留额度 | 与探索 seat 是**两个独立额度池**，不得互相挪用 |
| **seat 释放 ≠ 金额退款** | 取消/infra 释放探索 **seat**（`src/jitrl/replacement-policy.ts:213-230` 的既有语义）**不**意味着 provider 退钱；账本必须分列 `seatReleased` 与 `amountRefunded` |
| 结算顺序 | `reserve → (执行) → settle(incurred) → 可选 release(seat)`；任一步缺失都必须可诊断 |

### 7.5 离线 fixture（确定性，零网络零费用）

必须覆盖：**重复计费**（同一 `callId` 两次计价）、**二次扣减**（settle 后再 settle）、**未知 usage 的保守金额**、**取消后已发生花费**、**全流程 phase 序列**（probe/reference/compose/reflect/judge/dream）。全部使用合成数字，不读真实账单。

### 7.6 范围

`src/ledger/**`、`tests/unit/ledger/**`、`scripts/fixtures/ledger/**`。**不得**改 `src/index.ts`、`src/orchestrator.ts`、`src/jitrl/**`、`src/verification/**`、`src/dsh-bridge/model.ts`。

---

## 8. R6：状态词汇与门禁契约

### 8.1 本轮状态词汇（六态，不得跳读）

`implemented → wired → default_enabled → independently_verified → release_authorized → actually_applied`

| 状态 | 定义 |
| --- | --- |
| implemented | 实现 + 测试在工作树 |
| wired | 已进入生产装配路径（默认形态实际经过该代码） |
| default_enabled | 默认装配下该行为**实际开启** |
| independently_verified | 独立验证者在确定工作树上复跑门禁并绑定 diff 指纹 |
| **release_authorized** | 显式授权（G1/G2/G3 齐备）——**本轮恒 false** |
| **actually_applied** | 真实发布/部署——**本轮恒 false** |

**released 恒为否**（ADR 0002 §11.3 延续）。**publish 相关项一律 `release_authorized=✗`、`actually_applied=✗`**；`permissions.publish` 现在**有**执行受体（§3.1），因此状态页不得再写「publish 无调用点」，但也不得写「发布门已生效」——准确表述是「发布受体已接线并恒拒绝」。

### 8.2 门禁（七条沿用 + 三组专项）

七条沿用 ADR 0002 §11.1（`typecheck` / `test` / `check:docs` / `build` / `negative-result-diag` / `eval-jitrl` / `guarded-regression --json`），并新增：

| 组 | 覆盖 | 归属 |
| --- | --- | --- |
| **C1.1 发布受体** | 四模式 × {普通, Jit-wired} × {任务周期, idle} × Jit on/off：`applyPolicy` 次数 0、策略对象不变、revision 增量 0、`publish/shadow.published=false`、`improved/suggested` 非空洞、`off` 不重放、授权正控有效、`holdout-missing` 拒绝 | t4 实现 → t7 独立验证 → t10 评审 |
| **C2a 可信来源** | 真实正确/错误 artifact 经生产链得到 trusted passed/failed；伪造/错绑/旧 artifact/异 test set/异 env/异 run/空 checks 全部拒绝；timeout+trusted failed audit-only；succeeded+trusted failed audit-only；failed+trusted failed 为可信负样本；缺 reference 回执降级；未认证 verdict 不进 `learningEligibleOnly`、不进 support/nEff；task-quality 不泄漏进 process | t5 实现 → t8 独立验证 → t11 评审 |
| **C3 契约** | 契约与离线 fixture 单测（重复计费/二次扣减/未知成本/取消结算/全流程 phase）；无生产接线越界；r4 与 `learningTarget` 未被触碰 | t6 实现 → t9 独立验证 → t11 评审 |

**证据口径（captain R6）**：不得以权限布尔值当效果证据；C1.1 的最小证据集 = 策略对象身份/版本 + `policy.current.json`/`policy.history.jsonl` 磁盘增量 + `publication.publish`/`shadow.published`/`improved`/`suggestedPolicyId` 四个字段。C2a 的最小证据集 = 真实 artifact 的正反例 + 回执绑定字段 + 记录 track/eligibility/reward 列 + 拒绝原因码。

---

## 9. R7：文件范围（冻结；越界回 captain）

| 任务 | inScope（冻结） |
| --- | --- |
| t1（本 ADR） | `docs/adr/0003-*.md` |
| t4（C1.1 实现） | `src/index.ts`、`src/orchestrator.ts`、`src/dream-rsi/offline-dreamer.ts`、`src/jitrl/decision-kernel.ts`、`tests/unit/p62/release-contract.test.ts`、`tests/unit/jitrl/runtime-control.test.ts`、`tests/unit/dream-rsi`、`scripts/eval/guarded-regression.mjs` |
| t5（C2a 实现） | `src/verification`、`src/index.ts`、`src/orchestrator.ts`、`src/cordis-seams/trajectory-collector.ts`、`src/jitrl/index.ts`、`tests/unit/verification`、`tests/unit/cordis-seams`、`tests/unit/p62`、`tests/e2e`、`scripts/eval/guarded-regression.mjs` |
| t6（C3 契约） | `src/ledger`、`tests/unit/ledger`、`scripts/fixtures/ledger` |
| t7/t8/t9（验证） | 只读 + 证据文件（`work/`，gitignored） |
| t10/t11（评审） | 只读 + 评审报告 |
| t12（集成） | `docs/P62_STATUS.md`、`docs/reports/**`（ADR 0002/0003 正文不改） |

**共享面纪律**：`src/index.ts` / `src/orchestrator.ts` 同时属于 t4 与 t5，t5 必须在 t4 落地后读取其最终改动再接线，只做最小局部改动，不回退 C1.1 修复、不做无关格式化。

**明确不在本轮范围**：`src/types/contracts.ts`（除 captain 另行批准 §4.2 的两字段加宽）、`src/jitrl/step-evaluator.ts`、`src/jitrl/reward-contract.ts`、`src/jitrl/backfill.ts`、`src/jitrl/experience-store.ts`、`src/dsh-bridge/model.ts`、`src/host-triggers.ts`、`docs/adr/0002-*.md`。

---

## 10. 本 ADR 明确不做

- 不修改 ADR 0002 正文；ADR 0002 §7 的 A1–A5 文本待裁定项仍归 captain（本轮不借机改写 accepted ADR）。
- 不改 r4 数值标尺（version/aggregation/weights/clip/F4 常量/`contractWeightsHash()`）；不引入任何新的 ±1 契约；trust 只影响 eligibility/track。
- 不把 shape-only verdict 当可信来源；不让未认证 verdict 进入 reward 列或学习邻域。
- 不借 C2a 重标历史记录、不迁移、不改写审计日志、不恢复字符串注册器。
- 不实施 C2b（质量消费者接线）、C4、真实模型/付费调用、真实 memory 写入、部署、`git commit`/`git push`。
- 不把「权限位为 false」当作发布已阻止的证据，也不把「移除 callback」当作修复（假 published 被明确禁止）。
- 不为通过验证降低测试强度或改写报告措辞。

---

## 11. 与工作项的对应

| 工作项 | 与本 ADR 的关系 |
| --- | --- |
| t1（本 ADR） | 契约冻结输入，非代码变更 |
| t2（Dreamer 发布效果审计） | 提供 P-1…P-4 与 §3 的受体清单、夹具形状、反证与 R2 波及面预检 |
| t3（C2a 接线审计） | 提供 P-5…P-10、C-1…C-10 与 §4 的 runner 设计、验收矩阵 |
| t4（C1.1 实现） | 落地 §3（PB-1…PB-4、三道闸、holdout 真值表、idle 收敛、冲突测试修正、授权正控）。**不含** `off` 是否重放（登记 C1.1-O1，须 captain 另裁，见 §3.4） |
| t5（C2a 实现） | 落地 §4（T1–T6、保守 A 真值表、双回执、原因码）与 §5（分叉、审计编码、support/nEff） |
| t6（C3 契约） | 落地 §7（计价语义、reserve/settle、离线 fixture），不接线 |
| t7/t8/t9（独立验证） | 按 §8.2 三组专项 + 七条门禁，用 §8.2 证据口径 |
| t10/t11（独立评审） | 以本 ADR 为唯一契约口径；发现实现与契约不一致即 needs_revision |
| t12（集成） | 六态状态页、当前工作树 attestation、七门禁复跑、历史报告标注为历史快照 |

---

## 12. 参考

- ADR 0001（`docs/adr/0001-p61-security-contract-and-boundary-rulings.md`）：D1 严格默认、D4 权限分层与 shadow 口径。
- ADR 0002（`docs/adr/0002-p62-release-contract-and-default-safe-shape.md`）：C0+C1 冻结口径（§3 模式表、§4 权限分层、§5.2a C2 前可信边界、§5.4 保守隔离、§7 替换证据、§11 门禁与五状态）。
- t2 审计：`docs/reports/t2-dreamer-release-effect-matrix.md`（§0 captain R1–R6、§2 真实 apply/update 链、§3.1–§3.7 实测、§5 反证、§7 覆盖矩阵）。
- t3 审计：`docs/reports/c2a-trusted-verification-wiring-audit.md`（§2 现状追踪、§3 C-1…C-10、§4 runner 设计、§5 验收矩阵、§7 R1–R6）。
- 关键代码锚点（HEAD `9ea9b7e`）：`src/dream-rsi/offline-dreamer.ts:1678-1684,1844-1846,1853`；`src/jitrl/decision-kernel.ts:1150-1203`；`src/index.ts:1216-1250,1642-1668,2751-2763`；`src/orchestrator.ts:302-303,1748-1769,2128,2166,2180,2245-2268,2302,2351-2359,2399-2447,3046-3056,3148-3186`；`src/host-triggers.ts:565-613`；`src/cordis-seams/trajectory-collector.ts:288,332,334`；`src/dsh-bridge/agent-loop-executor.ts:344-357,495-503`；`src/dsh-bridge/model.ts:108-116,231-247`；`src/jitrl/step-evaluator.ts:384-419,495,526-544,587-623,674-685,841-843,896-898,909-936`；`src/jitrl/experience-store.ts:249-251,309-317,327,1165`；`src/jitrl/reward-contract.ts:246-262,499-515`；`src/jitrl/backfill.ts:602-643`；`src/jitrl/value-estimator.ts:249-253,446-485`；`src/jitrl/jit-active-policy.ts:597-600,745-747`；`src/jitrl/index.ts:500-509,597-610,880-895,971-979`；`src/persistence/policy.store.ts:344-347,493-498`；`src/runtime/execution-profile.ts:100-133`；`src/config.ts:530,1056-1062`；`src/types/contracts.ts:324-328,402-425,1398-1472`；`src/jitrl/replacement-policy.ts:213-230`。

---

## 13. rev.2 / rev.3 复核与增补记录（t1 attempt 3）

本节记录 rev.2 相对初版所做的**全部契约性更正**及其可复现证据。目的不是辩解，而是让 t4/t5/t7/t8/t10/t11 能**判断自己读到的是哪一版**，并避免把初版的措辞当作已冻结事实。

### 13.1 更正清单

| # | 严重度 | 初版的问题 | rev.2 的处理 | 证据 |
| --- | --- | --- | --- | --- |
| **F1** | **blocker** | §3.4 把「`execution.mode=off` ⇒ 停 dream 重放」写成冻结要求，并给 t4 下达实现指令。这与 ADR 0002 §3「off 语义与本轮之前**逐字不变**」**直接冲突**：t2 实测本轮之前 `off` 下 `dreamTriggered=true` 且 `publish=true`，即 off 从未停止重放。按初版实现会**改动已冻结的 ADR 0002 语义**，且无人授权 | 撤回该冻结；本轮只关 `off` 下的 `publish`；「off 是否停止重放」登记 **C1.1-O1** 交 captain 另裁。同时**保留**两条预登记实现纪律（不用 `surfaceEnabled('dreamJit')` 短路、须补 `off` 的 `dreamTriggered` 断言），使 captain 若裁定"停"时 t4 不必返工 | ADR 0002 §3 表行「off … 无（语义与本轮之前逐字不变）」；t2 §3.1 `off` 行（`dreamTriggered=true`、`publish=true`）；`src/orchestrator.ts:1789-1801`（dream 调用点无 off 短路） |
| **F2** | **high** | §3.6 冲突测试清单只列 **4** 处，漏了 `runtime-control.test.ts:319-421`——而它**正是** t2 §0 R1 行点名的第 5 处，且夹具未配 holdout、今日真实 apply。t4 按初版清单修完仍会红 | 补为 **5 处**（含行级说明），并专门处理该用例的**双重身份**：它同时承担「Jit 扰动不得泄漏」这一独立安全性质，deny 后 `applyPolicy` 不再被调、安全断言的判别力会消失，故给出 (i) 授权正控 / (ii) 纯 deny 两种等价形态 | `tests/unit/jitrl/runtime-control.test.ts:397-421`（`applied).toHaveLength(1)`、`swapped.jit.beta===1`）；t2 §0 R1 行原句 |
| **F3** | **high** | §4.2 要求回执携带 `verificationId`/`binding`/`kind` 三个**新字段**，但 `TrustedVerification` 定义在 `src/jitrl/step-evaluator.ts:556-564`，该文件**不在任何任务 inScope**（t5 outOfScope 明确列入）。t5 会在"改类型=越界 / 不改类型=字段无处声明"之间卡死 | 新增「硬约束」段：三字段以**超集随附**方式写入开放的 `metadata`（`ContractMetadata = Record<string, unknown>`），并明确 **binding 校验必须由 attach 侧自做**（scorer 不认识 `binding`）；不新增对 `step-evaluator.ts` 的范围要求 | `src/jitrl/step-evaluator.ts:556-564`（接口定义处）；`src/types/contracts.ts:109,424`（开放 metadata）；`step-evaluator.ts:587-623`（`isTrustedVerification` 不拒绝多余键） |
| **F4** | **high** | §4.3 真值表把「`failed` 执行 + trusted `passed`」写成 scorer 可得的矛盾格，实际上 `verificationFromTrajectory` 在 scoring 前已把它降级为 `unknown`，该格**在 scorer 侧不可达**，按初版实现会静默落成 process+completion 0 而非 audit-only | §4.3 新增「关键实现约束」3 条：矛盾格必须由 attach 侧在 attach 前判定（`contradictory-verdict`）；`falsifiedSuccessClaim` 仍需 recorder 写审计编码；超时门**不得**改 `isLearningOutcome`。约束 1 同步改写 | `src/jitrl/step-evaluator.ts:674-685,679-681`（降级逻辑）、`:841-843`、`:896-898`；t3 探针 P3/P3b |
| **F5** | **medium** | 「`holdoutTreeCount` 在 `src/**` 零引用」措辞不实：`offline-dreamer.ts` 自身有定义与消费（`:1562,1664,1765`），仅**无传值点**。P-4 与 §3.7 均按错误措辞表述 | P-4 与 §3.7 改为「**生产装配零传值引用**」，并说明判别意义（能力已实现、已单测、生产不可达 ⇒ `holdout-missing` 是唯一必然结果） | `git grep holdoutTreeCount -- src` 仅命中 `offline-dreamer.ts` 4 行；传值点仅 `offline-dreamer.test.ts:1020,1091` |
| **F6** | **medium** | 初版未覆盖 `shadow.comparisons[].selected`：它今日由 `publication.publish` 派生而非 `applied`。deny 下碰巧为 false，但**将来 G1 授权 + G2 无 apply 目标**时会再次谎报「入选」 | §3.3 B 层新增一条：`selected` 的派生源改为 `applied`，使三字段恒等；并核对既有断言不受影响 | `src/dream-rsi/offline-dreamer.ts:1859-1862`；`offline-dreamer.test.ts:1006-1009,1066,1137-1139` |
| **F7** | **low** | PB-5 写「全仓无 `createEffectivePolicyConfigProvider(` 调用」不精确（`src/jitrl/index.ts:62` 有 re-export，测试有调用） | 改为「`src/**` 内只有定义与 re-export；唯一调用点全在 `tests/unit/jitrl/*`」 | `git grep createEffectivePolicyConfigProvider -- src tests` |

### 13.2 rev.2 逐项复验结果（全部通过）

| 项 | 复验方式 | 结果 |
| --- | --- | --- |
| 文件摘要绑定 | 对附录 15 个文件重算 SHA-256 前 16 位 | **与附录逐项一致**（含 `offline-dreamer.ts 42811c38795a91f5`、`decision-kernel.ts 69647913db8c399e`） |
| HEAD / 工作树 | `git rev-parse HEAD`、`git status --porcelain`、`git diff \| git hash-object --stdin` | HEAD `9ea9b7e…`；工作树仅 3 份未跟踪文档（t2/t3 报告 + 本 ADR）；diff 为**空 blob** `e69de29b`（非"空树" `4b825dc6`，见下注） |
| A 层四条既有断言 | 逐行核对 `decision-kernel-parity.test.ts:1245-1276` | 与 §3.3 结论一致，`holdout-missing` 是**唯一**新增分支 |
| 冲突测试 5 处 | 逐处读原文断言 | 5 处全部确认为「improved 即热替换」期望；`offline-dreamer.test.ts:966-1013/1015-1071/1073-1117` 三处**不冲突** |
| `isLearningOutcome('timeout')` | `tests/unit/orchestrator/credit-attribution.test.ts:1253` | 断言 `true` —— 故超时门不可改该谓词（F4） |
| 受影响的 4 个测试文件 | `vitest run` 四个文件（dream-rsi 三个 + runtime-control） | **4 files / 98 tests 全绿**，证明基线未被本轮文档修订影响 |
| 文档门禁 | `pnpm run check:docs` | **exit 0**（README 77 files / 1562 tests 与实测一致） |
| 越界检查 | `git status --porcelain` | 只新增 `docs/adr/0003-*.md`；`src/**`、`tests/**`、`scripts/**`、ADR 0002、P62_STATUS、既有报告**零改动** |

> **注（附录措辞更正）**：附录「工作树」行初版写 `git diff | git hash-object --stdin` = **空树哈希**。实测该管道对空输入返回的是**空 blob** `e69de29bb2d1d6434b8b29ae775ad8c2e48c5391`；空**树**哈希 `4b825dc642cb6eb9a060e54bf8d69288fbee4904` 需要用 `git hash-object -t tree /dev/null` 取得。两者含义相同（工作树无已跟踪改动），但引用的常量不同，故按实测更正。

### 13.3 rev.2 之后的冻结边界（交接要点）

1. **C1.1**：publish 四模式全 deny（含 `off`）是**唯一**新增冻结；`off` 的重放去留**不在**本轮契约内（C1.1-O1）。
2. **C2a**：真值表不变（保守 A、outcome 级、`failed`+trusted `failed` 保留为可靠失败学习正例）；但**实现落点**被明确钉到 attach 侧（F4），且回执字段以**超集随附**形态落地（F3）。
3. **r4 未暗改**：本轮所有更正都不触碰 `REWARD_CONTRACT.version/aggregation/weights/clip/contractWeightsHash()`；trust 只影响 eligibility/track。
4. **t4/t5 若发现本 ADR 仍有与 HEAD 不符之处**：不得自行"顺手修好"，按 §2 越界机制回 captain 重新裁定。

### 13.4 已裁定事项（captain 2026-10-26 确认；**作为 t7/t8/t10/t11 验收依据**）

三项开放项已由 captain 按 rev.2 默认建议**裁定完毕**，**不再是待定项**。t7/t8 验收与 t10/t11 评审一律以下表为准：

| id | 事项 | **裁定** | 对下游的约束 |
| --- | --- | --- | --- |
| **C1.1-O1** | `execution.mode=off` 是否应停止基础 dream 重放 | **不变**（off 仍重放，本轮只在 off 下关掉 `publish`） | t4 **不得**实现 off 的 dream 短路；t7 **不得**要求 `off` 下 `dreamTriggered===false`。若将来要停，属语义扩张，须改 ADR 0002 §3 并另开工作项 |
| **C2a-O1** | 是否要求持久化可读 `verificationId` / `verificationReasonCode` | **不加宽**（`src/types/contracts.ts` 与 `src/jitrl/reward-contract.ts` 保持不动） | t5 **不得**加宽类型；可审计表达只用 `rewardSources` 数值标记 + `metadata.verificationAudit` + stage detail/诊断。t8 **不得**以「记录里读不到 `verificationId`」判失败 |
| **C2a-O2** | `binding` 一致性校验的最终归属 | **attach 侧（t5）** | t5 必须在 attach 前自做 `taskId`/`testSetId`/`envId`/`runId` 一致性校验；t8 验收点在 attach 侧（scorer 不读 `binding`，见 §4.2 硬约束） |

**裁定后的固定口径（t7/t8 可直接引用）**：

1. `off` 的唯一变化是 `publish` 变 deny——其余 dream 行为与 HEAD 一致，`dreamTriggered` 仍为 `true`。
2. C2a 的可审计性**不依赖**任何新增持久化字段；若某验收项只能靠新字段证明，说明该验收项写错了。
3. 所有拒绝原因必须能在 `metadata.verificationAudit`（reasonCode + 有界 reason 文本）、stage detail、诊断行**三处之一**读到。
4. §4.6a 的三条精度（空 checks / 禁 FNV≡sha256 断言 / 断言 attach 原因码）是**硬性验收前提**，不是建议。

> 历史说明：本节 rev.2 标题为「仍需 captain 裁定的事项」，三项标为「本轮默认」。captain 于 2026-10-26 按该默认建议裁定，故「默认」列已升格为「裁定」并补入下游约束，不再保留待定状态，以免 t7/t8 误读。

### 13.5 rev.3 增补（captain 2026-10-26 精度要求）

captain 在原报告基础上追加了 `artifact-missing` 原因码与三条精度要求。已全部落到 §4.6 / §4.6a，并逐条用探针验证：

| 项 | 落点 | 验证方式 | 结果 |
| --- | --- | --- | --- |
| `artifact-missing` 作为必需 fail-closed 出口 | §4.6 末段 | 对照 `step-evaluator.ts:540` 的条件性比对分支 | hash 比对仅在 `expectedEvidenceHash !== undefined` 时发生 ⇒ 无 digest 时必须主动拒绝，否则退回 P-6 漏洞 |
| 空 `checks` 在 attach 侧拒绝 | §4.6a(1) | 运行时探针 `work/_t1-checks-probe.ts`（esbuild 打包后 node 执行） | `isTrustedVerification({checks: []}) === true` —— **形状校验接受空 checks**，故必须 attach 侧自拒 |
| 不得断言 FNV `hashString` ≡ 宿主 sha256 | §4.6a(2) | 源码核对 `harness2/shared.ts:104-111`（32 位 FNV-1a）、`:228-237`（`deliverableOf` 用 FNV 填充），调用点仅 `composer.ts:186,189,383`（展示/去重） | 两者算法与强度不同，断言相等**恒假**；attach 必须**覆盖**写入而非比对 |
| 旧 artifact / 错绑断言 attach 原因码 | §4.6a(3) | 源码核对 `step-evaluator.ts:526-544` | `trustedSource=false` 有 4 种互不相同的原因，无法区分「旧 artifact / 错绑 / 未注册 / 无 runner」⇒ 只断言布尔值是**空洞通过** |

> rev.3 未改动任何已冻结语义（§3 三闸、§4.3 保守 A、§5 分叉、§7 C3 契约、§13.4 三项裁定均不变），只补齐**验收判别力**相关的精度约束。

---

## 附：证据绑定（本 ADR 提交时点）

| 项 | 值 |
| --- | --- |
| HEAD | `9ea9b7edacb199884df2020df879f4e59ed66d73` |
| 工作树 | 仅 3 份未跟踪文档（t2 报告、t3 报告、本 ADR）；`git diff \| git hash-object --stdin` = `e69de29bb2d1d6434b8b29ae775ad8c2e48c5391`（**空 blob**；空**树**哈希为 `4b825dc6…`，两者含义相同，见 §13.2 注） |
| `src/orchestrator.ts` | `85268ed056cf29ff` |
| `src/index.ts` | `f686a36f4002a964` |
| `src/dream-rsi/offline-dreamer.ts` | `42811c38795a91f5` |
| `src/jitrl/decision-kernel.ts` | `69647913db8c399e` |
| `src/jitrl/step-evaluator.ts` | `50acb8b6fe8d8794` |
| `src/jitrl/reward-contract.ts` | `6c42f29e1c212e66` |
| `src/jitrl/experience-store.ts` | `058582da5f397454` |
| `src/jitrl/backfill.ts` | `14d9d5da4dc896ab` |
| `src/jitrl/jit-active-policy.ts` | `f528cf00d93e43c3` |
| `src/runtime/execution-profile.ts` | `69e8a44145b69ade` |
| `src/cordis-seams/trajectory-collector.ts` | `2935f349dd02d9f7` |
| `src/dsh-bridge/agent-loop-executor.ts` | `7da8b4187b8e94ae` |
| `src/dsh-bridge/model.ts` | `5bf6314ab665ce57` |
| `scripts/eval/guarded-regression.mjs` | `b0aa51220f63d70a` |

> 本 ADR 自身只新增 `docs/adr/0003-publish-verification-and-cost-contract.md`；未改 `src/**`、`tests/**`、`scripts/**`、`docs/adr/0002-*.md`、`docs/P62_STATUS.md`、既有报告，未 commit/push。

---
