# P4 / P5 独立评审（T9）

- 评审对象：HEAD `84cbc1a` 工作树（未提交改动即本轮交付面）
- 判据：`<plan-doc>` §3.3 / §7.1 / §7.2 / §7.3 / §7.4 / §9 / §10 / §11-R8
- 方式：只读。逐条读**实现代码路径**（不采信测试名与任务自述），关键点做调用方/被调方双向核对（grep 确认函数是否真被生产路径调用）
- 本轮未修改任何产品代码、测试与 README

## 0. 结论

**needs_revision**

安全类硬约束（advisor 永不 deny、镜像仅聚合、关闸零 MCP 调用、invariant 增广隔离、重放因果截断）在代码层面成立，可以保留。但存在 **2 条 high**：

- **H1**：Phase 4「超参随候选一起热替换」只对离线重放生效，**在线 L1 决策仍用构造期的 β**，双环的"同步超参"未兑现（§7.3-1/3）。
- **H2**：L3 顾问在**生产路径上没有任何 `host_tool` 经验来源**（`tools/post-execute` 只计数），因此真实插件里 advisor 恒为 `noop('no_neighbors')`；T7 的"生产可达"只证明了管道接通，未证明能产生一次真实判定。

另有 6 条 medium（invariant L2 检索过滤的防御缺口、300 token 预算的度量口径、replay 漂移计数口径、`/evo jit off` 不覆盖 L3/镜像、§9.1 跨任务不相交未实现、advisor scope 默认 host-local 的侧门风险），详见 §2。

---

## 1. 逐项结论（含证据行号）

### 1.1 §7.1 非对称引导不可被绕过 —— **部分通过**

| 检查点 | 结论 | 证据 |
| :-- | :-- | :-- |
| invariant 槽位**不得增广** | **通过** | `src/jitrl/candidate-augmenter.ts:223-225`（`isAugmentationForbidden` 同时覆盖 `explore_invariant` 与 `recover`）；`:255-265` 在读取邻域**之前**直接返回原候选集并记 `augment_isolated`；orchestrator 调用点在 `src/orchestrator.ts:1914-1920` |
| 增广入口在生产路径可达 | **通过** | `src/orchestrator.ts:1766-1779`（`augmentCandidates` 真调用，带 `slotKind`），`:1781-1795` 无条件产出汇总诊断 |
| invariant 记录的 guidance 归属 | **通过** | `src/orchestrator.ts:436-441` `slotProvenance()` 对 `explore_invariant` 硬钉 `guidance_free`，`:1704` 落库时使用它 |
| invariant 提案侧 memory 为 null | **通过** | `src/harness2/proposer.ts:110-133`（`memoryAllowed = memoryRequested && !invariantSlot && !slotGuidanceFree`）；orchestrator 侧 `src/orchestrator.ts:1585-1588` 返回 `{mode:'invariant', memory:null}` |
| **invariant 的 L2 检索只取 `guidance_free`** | **不通过（M1）** | 决策过滤用 `input.slot.guidance`（`src/orchestrator.ts:1936-1938`），而其它三处都用 slot 种类硬钉。专用守卫 `guidanceFilterForSlot()`（`src/jitrl/candidate-augmenter.ts:370-372`）**生产路径零调用**（全仓仅其自身单测引用） |
| L3 不得成为记忆泄漏侧门 | **部分（M6）** | 顾问文本只含统计量（`src/jitrl/host-advisor.ts:379-392`、`:410-470`）；但 `advisorScope` 默认空 = host-local（`src/index.ts:1354-1357` → `src/cordis-seams/dsh-hook-host-adapter.ts:540-557` 空 scope 时 `return true`），因此 advice 会注入**所有** dispatch，包括 invariant 探针 fork 的 `agent/pre-step` |

**M1 细节**：`BatchSlotPlan.guidance` 的类型是 `GuidanceMode`（`src/types/contracts.ts:1087`），自定义策略（`options.deps.policy` 是被支持的注入面，见 `src/index.ts:942-946`）完全可以返回 `{slot:'explore_invariant', guidance:'memory'}`。此时：增广被 `slotKind` 拦住（安全）、proposer 被 `slot.slot` 拦住（安全）、落库被 `slotProvenance` 纠正（安全），**唯独 L2 决策会以 `guidanceFilter:'memory'` 检索**，把记忆经验带进 invariant 的候选选择。§7.1 要求的正是"不可绕过"，四处守卫里有一处口径不同即为缺口。

**必须怎么修**：`src/orchestrator.ts:1937` 改为 `guidanceFilter: guidanceFilterForSlot(input.slot.slot) ?? input.slot.guidance`，或直接 `slotProvenance(input.slot)`；并补一条对抗用例（自定义策略把 invariant 标成 `memory`，断言检索到的邻居 `guidance` 全为 `guidance_free`）。
**严重度**：medium（需要非默认策略触发；但 §7.1 是硬约束，且修复成本极低）

**M6 细节**：`advisorInScope` 在三个 scope 字段全空时返回 `true`（`dsh-hook-host-adapter.ts:541-547`），这是"host-local"的刻意语义，但 L3 的注入面是宿主 prompt，而 invariant 探针在 fork 分支里同样会走 `agent/pre-step`。默认配置下 `hostAdvisor.enabled=false`，所以当前不构成实际泄漏；一旦开启且未显式给 `hostAdvisorScope`，就与 §7.1 冲突。
**必须怎么修**：`attachHostAdvisor` 在 scope 为空时至少绑定到探针 branchId/sessionId（`src/index.ts:1354` 已经有该值来源），或文档 + 配置校验强制要求 scope。
**严重度**：medium（默认关闭，实验特性）

### 1.2 §7.4 Composer 匿名性 —— **通过（有 1 条残余通道，low）**

- 判官 prompt 由 `buildJudgeMessages()` 逐行拼装（`src/harness2/composer.ts:399-479`），内容只有：任务 prompt（`:419`）、`taskSignature`（`:420-421`）、别名、`metrics`（`:430-438`）、`stepsSummary`（`:439-444`）、`producedFiles`（`:445-447`）、deliverable（`:448-449`）、行为对比（`:452-470`）。**没有任何 Q / Ã / V̂ / KL / source / policyId 字段**。
- 候选身份经 `identifiersOf()`（`:350-374`，收集 branchId/nodeId/patch.id/trajectory.id/patchId/branchNamespace）后由 `redactIdentifiers()` 从 deliverable 与 steps 中抹除（`:376-397`）。
- `policyId` 确实进入了 `ComposeRequest`（`src/orchestrator.ts:1292`），但只在**产出的 patch metadata** 里回写（`src/harness2/composer.ts:841`），不进 prompt —— 与 §7.4"composer 输出 assessments 之后 JitRL 才作为离线统计读取"一致。
- 残余通道（low）：`stepsSummary` 会把 step 文本截断 80 字符带入判官（`src/harness2/shared.ts` 的 `summarizeTrajectorySteps`）。若宿主把 `<jitrl_advice>` 注入进主会话、模型又在 step 文本里复述，统计量会以自然语言间接进入判官。当前探针轨迹由 branch executor 生成、不含宿主 additionalContexts，因此现状不触发。
- 未发现"Q/Ã 进入 composer prompt"的路径，**不采信测试名，已按上述代码路径核对**。

### 1.3 §7.2 负证据防火墙 —— **通过**

- `renderAdvice()`（`src/jitrl/host-advisor.ts:410-470`）：`recommendable` 只取 `normalizedAdvantage > 0`（`:412-414`），`avoidable` 只取 `< 0`（`:415`）；组装时推荐行在 `<jitrl_advice>` 主体，负证据一律进 `<anti_patterns_to_avoid>`（`:425-440`）。
- 无正优势时输出 `recommend none (...)`（`:430-431`），截断兜底块同为 `recommend none`（`:132-143`），**不存在"把负优势写成推荐"的分支**。
- 单测断言了结构性判据而非文本巧合：`tests/unit/jitrl/host-advisor.test.ts:219-228`（`edit` 必在 anti 标签之后、`/recommend[^\n]*edit/` 必须为 false、`antiPatterns` 行不得以 `recommend` 开头）。
- 一处 low：gate 的 `reason` 把负统计量写进了**给用户的 ask 文案**（`src/jitrl/host-advisor.ts:642-658`）。§7.2 约束的是 prompt 渲染，ask reason 是用户面而非模型面，**判定不违规**，但如按最严解释可考虑改为仅给 `suggestedActionKey`。

### 1.4 §7.3 Dream-RSI × JitRL 双环 —— **部分通过**

| 子项 | 结论 | 证据 |
| :-- | :-- | :-- |
| 1 超参纳入候选并扰动 | **通过** | `src/dream-rsi/offline-dreamer.ts:239-277`（`DEFAULT_JIT_BETAS=[0.5,1,2]`、`DEFAULT_JIT_LAMBDAS=[0.02,0.05,0.1]`、`resolveJitPerturbationGrid`）；`src/index.ts:787-794` 把 `config.jitrl.dream` 作为网格注入 |
| 2 重放时模拟 JitRL + 因果截断 | **通过（真实路径）** | `src/dream-rsi/offline-dreamer.ts:814-816`（`causalCutoffFor(tree)` → `causalExperienceSnapshot(...)`）→ `:680-698` 逐前沿节点调 hook；`causalExperienceSnapshot` 语义见 `:493-508`（含边界、保序、拷贝）。插件侧每轮重放取**实时**快照：`src/index.ts:800-841` |
| 3 单调不退化 + 热替换对象含 π 与超参 | **部分（H1）** | 单调性成立：`:1598-1606` 仅 `hypervolume > baseline + epsilon` 才 `applyPolicy`；但"超参随 π 一起被**在线**消费"不成立，见下 |
| 4 漂移降权 | **部分（M3）** | 语义与纯函数正确（`src/jitrl/retriever.ts:89-122`、`:291-302`），但 replay 侧的计数口径与 §7.3-4 不一致 |

**H1（high）——热替换的超参不被在线决策读取**

- 热替换确实把候选的 `jit` 一起交给了 `activePolicy.update()`（`src/dream-rsi/offline-dreamer.ts:1604-1605`；单测 `tests/unit/dream-rsi/jit-dream.test.ts:905-913` 断言 `active.policy.jit.beta === 2`）。
- 但在线 L1 装饰器的 β 在**构造时**被冻结：`src/jitrl/jit-active-policy.ts:369-386`（`resolveConfig`）→ `:498`（`this.config = resolveConfig(...)`）→ `:575-582`（`composeDecision` 用 `this.config.beta`）。内核构造时传入的是 `config.jitrl.beta`（`src/jitrl/index.ts:380`），之后**没有任何代码再读 `policy.jit`**：全仓 `policy.jit` / `jit.beta` 的读取只出现在 `src/dream-rsi/offline-dreamer.ts`（重放）与 `src/jitrl/index.ts:778`（replay hook）。
- 后果：做梦把 π 换成 β=2 之后，**在线元调度仍以 β=1.0（配置默认）运行**。§7.3-3 明确"替换对象包括 π 和 JitRL 超参"，§8 Phase 4 验收"热替换到 β∈[1.5,2.5]"在**在线**语义上未达成；现有 p4-wiring 只断言 `lastReplay.candidates` 的 β 网格（`tests/unit/integration/p4-wiring.test.ts:60-72`），未断言在线决策使用的 β。
- **必须怎么修**：让 `JitActivePolicy` 在每次 `selectBatch` 时从 `this.base.policy.jit` 解析 β/k/lambda（`jit` 缺失才回落到构造期配置），并在 `update()` 后使派生策略缓存失效（`DerivedPolicyCache.reset()` 已在 `:531-533` 调用，但配置快照需同时刷新）。补一条 e2e：做梦热替换后，同一 session 的下一次 `jit_meta_adjust` 的 KL/权重必须与 β=2 的计算一致（可用注入 rng 的确定性对照）。
- **严重度**：high

**M3（medium）——replay 漂移的"同 bucket 达到 k 条"口径与 §7.3-4 不一致**

- 规范语义：`currentBucketCount` 是**同 (level, bucket)** 的当前策略记录数（`src/jitrl/retriever.ts:107-122` 从 `bucketRecords` 统计，注释与单测都按同 bucket）。
- replay 实现：`src/jitrl/index.ts:695-703` 在 `levelRecords`（**整层**，含所有 bucket）上统计 `record.policyId === input.policyId`，再喂给 `driftFactorFor`（`:704-714`）。
- 后果：整层计数 ≥ 同 bucket 计数，漂移会**比规范更早停止**（旧策略经验被少降权），在 bucket 分布分散时偏差可观。
- **必须修**：按 `(level, state.bucket)` 分组统计后再构造 `DriftContext`；补一条用例：同一层内其它 bucket 有 k 条新经验、但目标 bucket 为 0 条时，旧经验仍须被降权。
- **严重度**：medium

**其他（通过项）**：因果截断在真实路径生效（不是只在测试里）——`replayPolicy` 对每棵树独立取 cutoff（`offline-dreamer.ts:814`），插件每轮重放重新取实时快照（`index.ts:838`），因此"重放看不到未来"成立。单调性：`improved` 仅按 hypervolume 严格大于（`:1598-1600`），未用 `isBetterEvaluation` 的 tie-break 放宽，符合"严格更优才替换"。

### 1.5 P5-a：gate 不可能 deny、≤300 tokens —— **deny 通过；token 部分通过（M2）**

- **deny 不可能（通过）**
  - 类型层：`HOST_ADVISOR_DECISION_KINDS = ['advisory','ask','noop']`（`src/types/contracts.ts:1572`），联合类型 `HostAdvisorDecision` 只含三种（`:1656-1659`）；编译期见证 `NoDenyDecisionKind`（`src/jitrl/host-advisor.ts:101-106`）。
  - 运行层：`evaluate()` 的四个出口（noop / advisory / ask）逐一核对（`:640-698`），无 deny 分支；适配器只转发 `kind==='ask'`（`src/cordis-seams/dsh-hook-host-adapter.ts:698-708`），外来 deny 被 `isBlockingDecision` 短路（`:743-745`、`:560-566`）或落到 `advisorCounters.noop`（`:709`）。
  - 用例：480 组参数扫描（`tests/unit/jitrl/host-advisor.test.ts:383-421`，断言 `checked` 总数，非空跑）+ 编译期 `@ts-expect-error`（`:444-454`）+ 接线层"外来 deny 降级"（`tests/unit/integration/p5-wiring.test.ts:162-180`）。
  - 注意：适配器自身仍会返回 `{kind:'deny'}`（`:685-688`），但来源是既有的 `denyRules`/`denyTools` 护栏，**不是 L3 顾问**，不违反 §3.3。
  - **L5（low）**：`src/config.ts:132` 与 `:136` 的配置注释写作 `'gate' may block host tool calls` / `below which 'gate' mode blocks the call`，与 §3.3"任何情况下都不自动 deny"相反。代码没错，注释会误导集成方把它当拦截器用。**必须修**：注释改为 "asks the user for approval; never denies"。

- **M2（medium）——"≤300 tokens" 是估算器口径，不是真实 token 数**
  - 预算判定全部基于 `estimateTokens()`（`src/jitrl/host-advisor.ts:117-129`：ASCII 每 4 字符 1 token，非 ASCII 每字符 1 token），`MAX_ADVISORY_TOKENS = 300`（`:80`），截断循环 `:447-467`，兜底 `:462-467`。
  - 该口径对**高熵 ASCII**（base64/哈希/长标识符）显著低估：一条 `recommend <64 字符 actionKey> (meanReturn=..., n=..., tilde=...)` 约 110 字符 → 估算 ~28 token，真实分词可到 ~100 token；满预算约 10 行时，真实 token 可达 ~1000。
  - 单测只做了自证式断言（`tests/unit/jitrl/host-advisor.test.ts:215`、`:264` 断言 `estimateTokens(text) ≤ 300`），**没有与真实 tokenizer 交叉校验**。
  - §8 Phase 5 写的是"注入的建议限制在 ≤ 300 tokens"，属对外硬承诺。当前实现保证的是"估算 token ≤ 300"。
  - **必须怎么修**：要么把 `MAX_ADVISORY_TOKENS` 按估算口径下调到保守等价（如 100）并在文档里改成"估算 ≤ 300 / 实际 ≤ 300 需真实 tokenizer"，要么在 `renderAdvice` 增加一个可选的真实 tokenizer 注入（默认回落到估算）并在有 tokenizer 时以真实计数判预算。
  - **严重度**：medium

### 1.6 P5-b：镜像载荷与关闸 —— **通过（2 条 low）**

- **载荷只含聚合（通过）**
  - `writeRow()` 只组装 `text / path / tags / metadata`（`src/jitrl/stores/bridge.store.ts:438-457`），metadata 键为白名单 9 项（`kind, namespace, level, bucket, actionKey, n, meanReturn, variance, updatedAt`），**无 record / reward / state / tokens / sessionId / summary**。
  - 全部自由文本先 `redactSecrets` 再 `redactAbsolutePaths`（`:162-164`），且 bucket/actionKey 在**生成笔记路径之前**就已脱敏（`:433-440`，路径 slug 由脱敏后的值构造），文档行整串再脱敏一次（`:435`）。
  - 单测覆盖密钥形状与路径体（`tests/unit/jitrl/bridge.store.test.ts` 的脱敏组）。
- **关闸零 MCP 调用（通过）**
  - store 侧：`enabled === false` 在任何 `client` 访问之前返回（`bridge.store.ts:324-332`）；空聚合同样零调用（`:329-332`）。
  - 插件侧：`syncJitMirror()` 在 `!resolved.jitrl.store.mirrorToMemoryBridge` 时提前 return（`src/index.ts:1453-1455`），`mirror.calls` 不加。
  - 用例：`tests/unit/integration/p5-wiring.test.ts:282-295` 断言 `listTools === 0 && callTool === 0 && calls === 0`；`bridge.store.test.ts` 的"关闸零触达"组。
- **M8（low）**：镜像诊断把 `client.serverId` 与后端 `error.message` 原样写入（`bridge.store.ts:408`、`:384`）。若后端 error 回显了写入参数（不少 MCP server 会这么干），脱敏链路被绕过。**必须修**：诊断前对 `serverId` 与 `errorMessage` 也走 `sanitizeText`，或只保留错误类型与行号。
- **M9（low）**：镜像只在 `run()`（`src/index.ts:1611`）与 `runFromCommand()`（`:1661`）之后同步，`handleFallbackEvent`（`:1664-1703`）不同步。`auto_fallback` 触发模式下经验增长但永不镜像。**必须修**：在 `handleFallbackEvent` 的 `finally` 前同样 `await syncJitMirror()`（或抽到统一的 run 收尾）。

### 1.7 §9 / §10 测试覆盖 —— **部分通过**（见 §3"测了但没测到位"）

- 论文图 2 数值复现、KL 单调、store 因果截断、hook 适配器 8 表面等 §10 条目均有对应用例（`tests/unit/jitrl/*`、`tests/unit/cordis-seams/*`），本轮抽跑 `tests/unit/jitrl` + `tests/unit/integration` + `tests/e2e/jitrl-ablation.test.ts`：**24 文件 / 509 用例全绿**（exit 0），`pnpm run typecheck` exit 0。
- 消融门禁具备判别力：`tests/e2e/jitrl-ablation.test.ts:131-136`（B1>B0、B3≥B1）、`:140`（各条件 Avg>0.5）、`:151-160`（β↑⇒KL↑）、`:172-186`（B0/B1 无决策无 store、B2/B3 有）、`:194-202`（三类泄漏为 0 **且** `invariantProbes>0`，避免零泄漏空断言）。
- **M4（medium）——§9.1 第 2 条"跨任务泛化只用不相交任务经验"未实现**：`scripts/eval/jitrl-eval-lib.ts:1338` 只为整个条件创建**一个** plugin，`:1385-1433` 顺序跑完 12 个任务且**全程不 purge**，因此后置任务会检索到前置任务的经验。B3 相对 B1 的 +0.067（`work/p5-eval-report.md` §10）因此混入了跨任务迁移收益。报告只声明"不能得出跨任务泛化的强度"（§10 末条），未标注**协议本身偏离 §9.1**。
  **必须修**：报告里明确写出"本轮为同分布累积，非 §9.1 的跨任务不相交设置"，或为每个任务新建 plugin/清空 store 后重跑一版。
- **M5（low）**：§9.2 的 A1/A4/A5/A6 未实现，报告 §7 已如实列出（`work/p5-eval-report.md` "本轮未实现的消融"），属诚实缺口而非缺陷；但 §7.1 因此**只有正向隔离断言、没有 A4 反例**，隔离的有效性缺少对照证据。

### 1.8 生产可达性 —— **管道通过；决策不通过（H2）**

三条接线都能从 `createEvoHarnessPlugin` 真实入口到达：

| 接线 | 证据 |
| :-- | :-- |
| P4 重放 hook | `src/index.ts:1144-1155`（`createJitWiredDreamer`）→ `:835-841`（`jitHook: recordingHook`）→ `:821-823`（`kernel.createReplayHook`） |
| P5-a 顾问 attach | `src/index.ts:1350-1359`（`hostAdapterSource==='dsh-hooks'` 时 `attachHostAdvisor`）；适配器监听器 `dsh-hook-host-adapter.ts:674-769` |
| P5-b 镜像 | `src/index.ts:1450-1471`（`syncJitMirror`）→ 调用点 `:1611`、`:1661` |

**H2（high）——L3 顾问在生产路径上无经验来源**

- 顾问检索 `level:'host_tool'`（`src/jitrl/host-advisor.ts:505-511`），空邻域即 `noop('no_neighbors')`（`:580-583`）。
- 全仓 `level: 'host_tool'` 的出现点只有：契约（`contracts.ts:1271`）、状态抽象（`state-abstraction.ts:721`）、store 白名单（`experience-store.ts:58`）、顾问查询（`host-advisor.ts:510`）、以及**适配器构造请求**（`dsh-hook-host-adapter.ts:582`）。
- **没有任何地方把 `host_tool` 记录写入经验库**：`orchestrator.ts:1664-1712` 只写 `meta` 与 `proposal`；适配器的 `tools/post-execute` 只做计数（`dsh-hook-host-adapter.ts:721-730`，`counters.postExecute.applied/delegated`），不采集 `isError`/退出码，也不落经验。§3.3 明写"逐步奖励直接来自 `tools/post-execute` 的结果（isError、退出码）与 `turn/end` 的 reason.kind"——这条链路**未实现**。
- 因此：真实插件里 `kernel.createHostAdvisor()`（`src/jitrl/index.ts:408-415`）拿到的 store 永远查不到 `host_tool` 邻域，advisor 永远 `noop`。T7 的"gate 只回 ask"用例之所以能过，是因为它**注入了自带 retriever 的 advisor**（`tests/unit/integration/p5-wiring.test.ts:76-94`、`:114-160`），绕过了内核顾问与真实经验库。
- 另：`kernel.createHostAdvisor()` 这个分支**没有任何用例覆盖**（tests 里只调用带显式 `retriever`/`store` 的 `createHostAdvisor`）。
- **必须怎么修**：(a) 在 `tools/post-execute` 采集 `{toolName, isError, exitCode}` 并写入 `level:'host_tool'` 经验（actionKey = 工具名或规范化签名，state 由 `abstractHostState` 生成，reward 由 `step-evaluator` 的多信号融合给出）；(b) 补一条 e2e：走真实插件、先跑若干次 post-execute 生成 host_tool 经验，再断言 `agent/pre-step` 真的注入 `<jitrl_advice>`（而不是依赖注入 retriever）；(c) 覆盖 `kernel.createHostAdvisor()` 的默认路径。
- **严重度**：high（功能层面 P5-a 的"生产可用"不成立；安全层面无风险，因恒 noop）

**M7（medium）——`/evo jit off` 不关闭 L3 与镜像（独立复核 T8-F1，成立）**

- `setEnabled` 只翻转 `volatileJitEnabled` 与 L1 的 `runtimeEnabled`（`src/index.ts:1531-1536`）；L1 装饰器在 `selectBatch` 里读它（`src/jitrl/jit-active-policy.ts:549-555`）。
- L3 的开关是**构造期**读的 `config.hostAdvisor.enabled`（`src/index.ts:959`，顾问内部再判 `host-advisor.ts:703`）；镜像读 `resolved.jitrl.store.mirrorToMemoryBridge`（`src/index.ts:1453`）。二者都不看 volatile。
- 后果：`/evo jit off` 之后 `agent/pre-step` 仍注入 advice、`tools/pre-execute` 仍可 ask、run 结束仍会镜像。§11-R8"可通过 `/evo jit off` 一键关闭"对 L3/镜像未兑现。
- **必须怎么修**：`setEnabled(false)` 时同时（a）`hostAdapter.attachHostAdvisor` 可 detach 或给 advisor 一个 `isEnabled` 闸门；（b）`syncJitMirror` 前置 `volatileJitEnabled` 判断。补一条 e2e：`jit off` 后 pre-step 无 advice、pre-execute 无 ask、镜像 `calls` 不增。
- **严重度**：medium（默认关闭，故非安全阻塞）

---

## 2. 问题清单（按严重度）

| ID | 严重度 | 文件:行号 | 问题 | 必须怎么修 |
| :-- | :-- | :-- | :-- | :-- |
| H1 | **high** | `src/jitrl/jit-active-policy.ts:369-386,498,575-582`；`src/jitrl/index.ts:380` | 热替换的 `jit` 超参不被在线 L1 消费，β 在构造期冻结；§7.3-3"替换对象包括 π 与超参"只对重放成立 | 每次 `selectBatch` 从 `base.policy.jit` 解析 β/k/λ，`update()` 后刷新配置快照与派生缓存；补在线 β 生效的 e2e |
| H2 | **high** | `src/cordis-seams/dsh-hook-host-adapter.ts:721-730`；`src/jitrl/host-advisor.ts:505-511,580-583` | 无任何 `host_tool` 经验生产者，生产路径 advisor 恒 noop；§3.3 的 post-execute→奖励链路未实现；p5-wiring 用注入 retriever 绕过内核 | 在 post-execute 采集并落 `host_tool` 经验；补真实链路 e2e；覆盖 `kernel.createHostAdvisor()` |
| M1 | medium | `src/orchestrator.ts:1936-1938`；`src/jitrl/candidate-augmenter.ts:370-372` | invariant 的 L2 检索用 `slot.guidance` 而非 slot 种类硬钉；专用守卫 `guidanceFilterForSlot` 生产零调用 | 改用 `slotProvenance`/`guidanceFilterForSlot`；补对抗用例 |
| M2 | medium | `src/jitrl/host-advisor.ts:80,117-129,447-467` | ≤300 tokens 是估算器口径；高熵 ASCII 可低估 3–4×，实际可远超 300 | 下调保守阈值或注入真实 tokenizer 并按其计数 |
| M3 | medium | `src/jitrl/index.ts:695-703`；对照 `src/jitrl/retriever.ts:107-122` | replay 漂移按整层计数，非 §7.3-4 的"同 bucket 达 k 条"，降权提前停止 | 按 `(level,bucket)` 分组计数；补跨 bucket 用例 |
| M4 | medium | `scripts/eval/jitrl-eval-lib.ts:1338,1385-1433` | §9.1 跨任务不相交未实现，12 任务共享一个经验库；报告未标注协议偏离 | 报告显式声明，或按任务隔离后重跑 |
| M6 | medium | `src/index.ts:1354-1357`；`dsh-hook-host-adapter.ts:541-547` | advisor scope 默认 host-local，advice 会注入 invariant 探针 fork 的 pre-step（§7.1 侧门） | 未给 scope 时绑定到探针 branch/session，或强制要求 scope |
| M7 | medium | `src/index.ts:959,1453,1531-1536` | `/evo jit off` 不关闭 L3 顾问与镜像（复核 T8-F1 成立） | 给 advisor/mirror 加 volatile 闸门；补 off 后零动作用例 |
| L1 | low | `src/jitrl/host-advisor.ts:642-658` | gate 的 ask reason 把负统计量写给用户（非模型面，判定不违规） | 可只给 `suggestedActionKey` |
| L2 | low | `src/harness2/shared.ts` `summarizeTrajectorySteps`（经 `composer.ts:393-395` 入 prompt） | 若模型在 step 文本复述 advice，统计量可间接进判官 | 对 steps 里的 `<jitrl_advice>` 段做剥离 |
| L3 | low | `src/jitrl/stores/bridge.store.ts:384,408` | 镜像诊断含未脱敏 `serverId` 与后端 error message | 诊断前同样 `sanitizeText` |
| L4 | low | `src/index.ts:1664-1703` | `auto_fallback` 路径不同步镜像 | 统一 run 收尾处同步 |
| L5 | low | `src/config.ts:132,136` | 配置注释写 `gate may block host tool calls` / "below which gate mode blocks the call"，与 §3.3"任何情况下都不自动 deny"相反，易误导集成方 | 改为 "asks the user for approval; never denies" |

---

## 3. 测了但没测到位

1. **L3 生产链路**：`tests/unit/integration/p5-wiring.test.ts` 的三条 P5-a 用例都注入了自带 `retriever` 的 advisor（`:76-94`、`:120`、`:201`），**从未**走 `kernel.createHostAdvisor()`（`src/jitrl/index.ts:408-415`）。后果：H2（无 host_tool 经验）被测试结构完整掩盖。
2. **在线超参**：`tests/unit/integration/p4-wiring.test.ts:60-72` 只断言重放候选的 β 网格与 `driftRho` 透传；没有任何用例断言**热替换后在线 `jit_meta_adjust` 用的是新 β**。后果：H1 未被发现。
3. **300 token**：`tests/unit/jitrl/host-advisor.test.ts:215,264` 用 `estimateTokens` 断言 `estimateTokens ≤ 300`，属自证；无真实 tokenizer 交叉校验。
4. **invariant 隔离的对抗面**：`tests/unit/orchestrator/p3-proposal-select.test.ts:1072-1127,1232-1252` 全在"合法策略"下（`guidance:'guidance_free'`）。没有"自定义策略把 invariant 标成 `memory`"的用例，因此 M1 未被捕获；`guidanceFilterForSlot()` 只有自身单测（`candidate-augmenter.test.ts:299-302`），生产零调用却无人发现。
5. **replay 漂移口径**：`tests/unit/jitrl/retriever.test.ts` 的 37 例只覆盖 retriever 纯函数（同 bucket 语义正确）；`src/jitrl/index.ts` 里 replay 侧的跨 bucket 计数**无任何断言**，M3 因此漏网。
6. **`/evo jit off`**：测试集里没有 `setEnabled(false)` → advisor/mirror 的断言（T8 用手写探针才发现 M7）。`tests/unit/integration/p5-wiring.test.ts:182-191` 只覆盖"构造时关闭"，不覆盖"运行时关闭"。
7. **§9.1 跨任务隔离**：消融用例（`tests/e2e/jitrl-ablation.test.ts:88-111`）只校验协议自洽与确定性，不校验"任务间经验不相交"，M4 因此漏网。
8. **镜像脱敏的失败面**：`bridge.store.test.ts` 覆盖了 bucket/actionKey 里的密钥，但没覆盖"后端 error 回显载荷 → 诊断"这条路径（L3）。

---

## 4. 复核过的通过项（附证据，供下游引用）

- **advisor 永不 deny**：`contracts.ts:1572,1656-1659`；`host-advisor.ts:101-106`；`dsh-hook-host-adapter.ts:698-708,743-745`；`host-advisor.test.ts:383-421,444-454`。
- **负证据只进 anti_patterns**：`host-advisor.ts:410-470`；`host-advisor.test.ts:219-228`。
- **镜像仅聚合 + 关闸零调用**：`bridge.store.ts:324-332,423-457`；`index.ts:1453-1455`；`p5-wiring.test.ts:282-295`。
- **invariant 不增广 + 记录 guidance 硬钉**：`candidate-augmenter.ts:223-265`；`orchestrator.ts:436-441,1704,1914-1920`；`p3-proposal-select.test.ts:1232-1252`。
- **重放因果截断在真实路径**：`offline-dreamer.ts:493-508,814-816`；`index.ts:800-841`；`jit-dream.test.ts:533-621`。
- **单调不退化**：`offline-dreamer.ts:1598-1606`；`jit-dream.test.ts:938-957`。
- **composer 匿名性（直接通道）**：`composer.ts:350-397,399-479,841`。
- **门禁**：`pnpm run typecheck` exit 0；`vitest run tests/unit/jitrl tests/unit/integration tests/e2e/jitrl-ablation.test.ts` → 24 文件 / 509 用例全绿。

---

## 5. 复现命令

```
pnpm run typecheck
pnpm exec vitest run tests/unit/jitrl tests/unit/integration tests/e2e/jitrl-ablation.test.ts
```

（本轮未执行全量 `pnpm run test`，全量计数以 T8 的 61 文件 / 1114 用例为准，本轮不重复背书。）
