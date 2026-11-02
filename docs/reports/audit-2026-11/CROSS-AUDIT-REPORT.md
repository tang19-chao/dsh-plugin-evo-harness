# dsh-plugin-evo-harness 交叉审计报告（两轮迭代验证）

- 审计对象：https://github.com/tang19-chao/dsh-plugin-evo-harness（本地工作树，HEAD = `4b5b92c`，main）
- 审计日期：2026-11-01
- 审计方式：**两轮多智能体交叉审核**
  - **第一轮（11 个并行领域审计代理）**：core / jitrl-core / jitrl-infra / ledger / verification+dsh-bridge / memory-bridge+cordis-seams / dream-rsi+persistence / 测试套件质量 / 文档-代码一致性 / 安全 / 构建-CI-门禁 / 跨模块集成，各自独立读取代码并产出结构化发现。
  - **第二轮（6 个对抗式复核代理）**：对第一轮全部 119 条发现逐条重读引用代码、主动寻找反证（守卫/调用方/测试/文档）、必要时用临时可执行探针复现；裁决为 CONFIRMED / DOWNGRADED / UPGRADED / REFUTED，并补充 9 条新发现。
- 本报告 = 第二轮裁决后的最终汇总。逐条细节见 `round1/*.md`（第一轮 12 份）与 `round2/*.md`（第二轮 6 份）。

---

## 1. 执行摘要

**总体结论**：该仓库的工程纪律异常扎实——证据链（attestation/指纹/门禁）经独立重算**真实可复验**，文档**无捏造证据**，测试套件（163 文件 / 2956 用例全绿）大多为强断言而非陪跑。但交叉审计在**生产装配路径、凭据脱敏、资金台账、数据持久化**四个面各发现一个 P0 级真实缺陷，另有 8 条 P1。值得强调：这些 P0 全部位于"自研逻辑层"，而仓库引以为傲的门禁/证据层（p62 gates）反而是最干净的部分——因为所有 e2e 测试都注入 `options.model`/`options.runBranch`，恰恰绕过了生产挂载路径（cordis.patch.yml）。

**严重度分布（第二轮裁决后，合并重复项）**：

| 严重度 | 数量 | 含义 |
| --- | ---: | --- |
| P0 | 3 | 生产路径功能性断裂 / 凭据泄漏 / 资金双扣 |
| P1 | 9 | 真实缺陷，影响行为或数据 |
| P2 | 42 | 有实际风险的逻辑缺口（详见 §6） |
| P3 | ~70 | 卫生/健壮性/文档漂移（详见 §7） |
| 被驳回 | 3 | 二轮复现反证，从清单剔除（见 §8，如实保留） |

**客观验证基线（本机实测，非转述）**：
- `pnpm run typecheck` → exit 0（tsc --noEmit 无错误）
- `pnpm test` → **163 文件 / 2956 用例全绿**，exit 0
- `pnpm run check:docs` → SUCCESS（README 计数 163/2956 与实测机械一致；78/78 配置叶）
- 独立重算 `docs/reports/final-attestation.json` 复合摘要（对 `1b7920e` 的 257 个 blob）与记录**逐字节一致**（二轮 docs 代理完成）
- CI `.github/workflows/ci.yml` 与 README 声称的门禁矩阵一致（7 个 job 均有对应 package script）

---

## 2. P0 — 三个必须立即修复的缺陷（全部经二轮独立复现/双重确认）

### P0-1（原 CORE-1/INT-1，二轮升级 P1→P0）生产挂载路径上，异步解析的 ctx.llm 模型与分支执行器从未送达编排器 —— 每个 run 静默降级为 `no_probe`
- **位置**：`src/index.ts:2350-2358`（`forwardingModel`/`forwardingBranch` 定义，全仓 **零调用点**）、`src/index.ts:2120`（proposer/composer/reflector 用 `missingModelAdapter()` 构建）、`src/index.ts:2202`（runBranch 链）、`src/index.ts:2921-2926`（`holder` 只写不读）
- **证据链**：
  1. `grep -rn "forwardingModel\|forwardingBranch" src/ tests/` → 只有定义，无调用。
  2. git 考古：commit `7e73b3f` 曾接线（`model: forwardingModel(holder, ...)`，旧文件 731-732 行），commit **`7307d7d`**（10-23 JitRL P4/P5 合并）把整个 `bridgeOptions` 块删除并直接传 `options` → 接线在重构中丢失，helpers 与注释成为孤儿。`src/index.ts:2334-2344` 的注释仍在声称"orchestrator 收到稳定的 FORWARDING 协作者对象"。
  3. **决定性**：随仓发布的宿主挂载清单 `cordis.patch.yml` 明言"所有注入点（model adapter、MCP clients、runBranch）在挂载时由 src/dsh-bridge 从宿主解析"——**正是这条断掉的路径**。在真实 DSH 宿主上，`resolveDshCollaborators` 把解析结果写入 `holder` 后无人读取，编排器永远持有 `missingModelAdapter()`（每次 propose 抛 `no model adapter was injected`）和 `unconfiguredBranchExecutor`（每个 probe 失败）→ 所有 run 以 `no_probe` 终止，同时诊断日志还在打印 "model route in effect: …" 的假象。
  4. 为什么 2956 个测试全绿：所有 e2e 均直接注入 `options.model`/`options.runBranch`（`tests/e2e/plugin-entry.test.ts:37,98,213`），断线路径零覆盖。
- **修复方案**：在 `buildOrchestratorDeps` 中恢复转发接线：`model: forwardingModel(holder, () => missingModelAdapter())`、`runBranch: forwardingBranch(holder, resolvedRunBranch)`（helper 已存在；同时按 INT-10 把 runBranch 四级回退链解析一次、两处共用）。**必须补一条 e2e**：伪造 `ctx.llm` 且不注入 `options.model`，断言 `probesRun > 0`。修复后重跑 `pnpm run attest` 重生成目标提交记录。

### P0-2（原 JINFRA-1，二轮实证确认）脱敏器 `keyword_secret` 吞掉锚词、凭据本体裸奔进经验日志与记忆镜像
- **位置**：`src/jitrl/redaction.ts:53`（组合 matcher 的 `keyword_secret` 分支）
- **证据**（二轮把真实模块 esbuild 打包后直接运行验证）：
  ```
  redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.…')
    => '<secret> eyJhbGciOiJIUzI1NiJ9.…'        ← JWT 原样泄漏
  'authorization: Basic dXNlcjphYmNkZWZnaGlqaw==' → Basic 凭据泄漏
  'token = Bearer eyJ…'                          → 泄漏
  ```
  根因：正则交替的最左匹配——`keyword_secret` 的值段 `[^\s"';,]+` 恰好吞掉 `Bearer`，JWT 本体不再匹配任何模式；定点复跑永不自愈。裸 `Bearer <jwt>` 能被捕获（这正是测试只测了它而漏掉的原因）。`redactSecrets` 是任务提示词分词前（state-abstraction.ts:473,515,537）、工具名/错误类（host-tool-experience.ts:171,183,535）、advisory 片段（host-advisor.ts:161）的**唯一**清洗层 → 泄漏的凭据进入 JSONL 经验日志与记忆镜像，且记录上盖着 `redacted: true` 的假章。
- **修复方案**：在 `keyword_secret` 消费到 `bearer`/`basic`/`digest` 作值时，把匹配延伸到后续 token 段；或在 keyword 替换后对残余文本**再跑一遍** `bearer_token`。注意保留对 `x-api-key: AKIA…` 的既有覆盖（二轮发现该形态目前靠最左匹配"意外"工作，修复不得回退它）。补 `Authorization: Bearer <jwt>` 形态的测试。

### P0-3（原 LEDGER-1，两轮均用可执行 repro 确认）`bookNewAttempt` 无重投递幂等 —— 同一笔用量按次双扣
- **位置**：`src/ledger/two-phase.ts:749`
- **证据**：
  ```ts
  const callId = event.originCallId + '#new-attempt-' + String(this.index.newAttempts().length + 1);
  ```
  callId 由**计数器派生**而非事件派生，`beginCall+settleCall` 每次全量入账；manager 的幂等按 callId 键控（reservation-manager.ts:713-720），第二次尝试天然绕过。两轮 repro 均确认：同一事件调用两次 → `#new-attempt-1/2` 两条、`settledMicros = 2×3,000µ`；对**已对账**的 origin 再重投还会叠加双扣（对账侧 delta 记 0）。生产可达：`agent-loop-executor.ts:1419`、`metered-model-adapter.ts:652`。延迟用量投递在设计上明确是 at-least-once（`reconcileLateUsage` 自己就是重投安全的），唯独这个逃生口没有保护。
- **修复方案**：callId 改为由事件确定性派生（如 `originCallId + '#new-attempt-' + hash(originCallId|reason|providerCallId)`），已跟踪/已结算则直接返回既有结算；或同一 originCallId 拒绝第二次 new-attempt（reason 不同除外）。加"同事件重投不产生新分录"的单测。

---

## 3. P1 — 八条真实缺陷 + 一条二轮新增

### P1-1（原 INT-2，二轮确认）`deps.proposer` 注入而 composer/reflector 未注入时，`model as IModelAdapter` 把 `undefined` 强转进下游 → 判定时裸 `TypeError`
- `src/index.ts:2120` 三元式在注入 proposer 时强制 `model = undefined`（即使 `options.model` 已提供也被丢弃），composer.ts:571 的 `createMeteredModelAdapter(undefined,…)` 在 `complete()` 处 `TypeError: Cannot read properties of undefined`。
- **修复**：模型独立解析：`const model = options.model ?? missingModelAdapter();` 不与 proposer 是否注入耦合；补单测 `createEvoHarnessPlugin({ deps:{proposer}, model })` 断言 composer 的 judge 调用可达该 model。

### P1-2（原 JINFRA-2，二轮确认）JSONL 经验存储 append 与 compact/purge/flush 并发无互斥 —— 可把已应答成功的记录从持久层抹掉
- `jsonl.store.ts:299-310` append 先 `appendDurable` 再插索引；`compact/purge/flush`（321-378）**快照索引后**执行多跳异步 IO（mkdir/open/write/fsync/close/rename）再 rename 覆盖整份日志。窗口内 append 的字节被 rename 丢弃：内存索引有、磁盘没有，重启即失。生产可达：`/evo jit reset`（index.ts:2810-2827）与 L3 collector 的 append 同一事件循环、无任何锁。
- **修复**：加内部 promise 链互斥（`this.queue = this.queue.then(op)` 包住所有变更方法），或 compact/purge 前在同一链内重读合并文件。补 append-vs-rewrite 交错测试。

### P1-3（原 JINFRA-3，二轮确认）`ExperienceQuery.policyId/driftRho` 合约被 store 查询静默忽略；检索器文档与实现相反；advisor 在截断后才漂移、无饱和停止
- `experience-store.ts:1206-1311`（executeExperienceQuery）从不读取这两个字段；`retriever.ts:326-329` 声称"store 会应用同一 §7.3-4 因子"为假；host-advisor.ts:368-387 在 top-k 截断后用 `applyDrift` 重加权且无 `driftFactorFor` 的饱和停止 → 陈旧策略记录可凭 0.80 权重挤掉当前策略 0.75 记录，两套 §7.3-4 实现静默分歧。
- **修复**：在 `executeExperienceQuery` 真正实现 policyId/driftRho（同 bucket 当前策略计数、切片前加权、回填 `driftWeight`），或删字段改由 advisor 取大池重排；同步修正 retriever 文档字符串。

### P1-4（原 JITRL-1，二轮确认+修正）writeback-gate G-A"先前失败"被任何 `verified:false` 记录满足 —— 代码无法表达 `failed`，偏离冻结预注册
- `writeback-gate.ts:273-275`：`priorFailure = bucket.some(e => e.actionKey === … && !e.verified && !e.counterexample)`；entry schema 无 verdict 字段。冻结预注册 §5（sha256 已核）要求"先前执行留有 `verification.status === 'failed'` 记录"。二轮修正：生产历史读取排除 `learningEligible===false`，故 180 条无 verdict 记录场景主要经**离线 eval 脚本**（它把全部 prior 推入）与 gate-off 历史触发；首次带可信 `passed` 回执即可走 `kept-fail-to-pass`，正是 header 声明要拒绝的半证据情形。
- **修复**：给 `WritebackHistoryEntry` 增加 `status: 'passed'|'failed'|'unknown'`，`priorFailure = … e.status === 'failed' …`；更新夹具并补"prior unknown / prior untrusted-passed 不得满足 G-A"反例。

### P1-5（原 LEDGER-2，两轮 repro 确认）ledger 结算与 call-index 落盘之间的崩溃窗口：资金永久锁死、延迟用量永久被拒
- `two-phase.ts:655-667`：`manager.settle` fsync WAL 后、`index.recordInterim` fsync 索引前崩溃 → 重放后 settle 重试返回 `isIdempotentReplay=true` **再次跳过索引写**，身份永远停在 `'reserved'`；`reconcileLateUsage` 永远抛 `LATE_USAGE_BEFORE_TERMINATION`，1 万 µs 锁死。repro 还确认 `beginCall` 同窗（`CALL_NOT_TRACKED`、资金滞留）。全仓无任何自愈路径（`assertManagerAlignedWithIndex` 只测镜像向分歧）。二轮新增同族发现 **R2-1(P2)**：崩溃恢复的在途调用即使 WAL+索引一致也无法经合法生命周期入账。
- **修复**：`settleCall` 遇 `isIdempotentReplay && identity.state==='reserved'` 时仍执行 `recordInterim/recordFinal`（幂等追加）；`beginCall` 先记索引映射再 `manager.reserve`；或恢复扫描从 `EVENT_RESERVED` 载荷回填索引身份。

### P1-6（原 MEM-1，两轮均端到端复现）记忆桥 fail-open 归因：无标签外来 lesson 被归入所请求命名空间并跨会话/分支浮出
- `lesson-codec.ts:674-679` 无标签文本经 `namespaceHint/defaultNamespace` 归入请求命名空间；`governance-polyfill.ts:346-351` 命名空间匹配即 `visible:true`，**不查 lesson 自身 sessionId**（该检查只在无命名空间回退分支）。repro：外来 `sessionId:'s-1'` 的未标签 lesson 被 `bridge.recall(scope:{s-2,b-9})` 零抑制浮出。graph_entity 召回根本不传命名空间参数（graph-entity.driver.ts:54-57），客户端防火墙是唯一隔离层且 fail-open。定 P1 而非 P0：本桥自写记录总是带标签，泄漏需外来/无标签 lesson 内容——而这正是防火墙存在的意义。
- **修复**：`isLessonVisibleInScope` 在命名空间匹配时仍强制 `lesson.sessionId === scope.sessionId`（合法写入必带）；对仅靠 hint/default 归因的记录标记 unverified-origin 并限 global 可见。

### P1-7（原 DREAM-1，二轮用真实持久层复现且比一轮更糟）重启后树 id 归零，持久发现树被确定性覆盖销毁 —— 做梦重放语料每重启一次就毁一次
- `index.ts:2028-2031` 的 `newId` 序列不随重启播种（持久任务计数器只用于 shouldDream），树 id 重启即 `tree-evo-1`；`tree-pool.store.ts:474-494` 同 id 不同快照 = upsert 覆盖（新快照胜出），诊断只进创建时快照、到不了 `persistence.diagnostics`（二轮 NEW-2）。二轮 repro：重启后**第一个完成任务就把持久树换掉**，跨三次重开验证。
- **修复**：启动时用持久状态播种 id 序列（`policyStore.counters.completedTasks`），或 newId 混入每 boot 随机/session token，或树 id 含 sessionId；同时让 `PersistentTreePool.add` 对同 id 异快照按 `createdAt` 拒绝旧覆新。补重启-恢复 e2e。

### P1-8（原 DOCS-1，二轮确认）README 声称"运行时依赖：无"，实际声明并静态导入 `@deepseek-ai/schemastery`（且被打进 bundle）
- `README.md:38` vs `package.json:62-64`、`src/index.ts:20`（静态 import，模块加载即消费）；`model-config.ts:24-25` 自己的 header 都写明该依赖；二轮物理确认 schemastery 内联于 `lib/index.js`（1,215,633 字节、22 处出现、零 import 语句）。devDependencies 括号里也漏了 esbuild。
- **修复**：改写该行为"运行时依赖：`@deepseek-ai/schemastery`（配置 schema）"；check:docs 的文档卫生扩展到 Requirements 表。

### P1-9（二轮新增 VCI-1）同一重构还删掉了 `deferredClients` 供给 —— resolveDshCollaborators 构建的 tools-backed MCP 客户端同样到不了记忆桥与 JitRL 镜像
- commit `7307d7d` 删除 `bridgeOptions` 时把 clients 转发一并删除：记忆桥只从 `options.clients/listClients` 构建（index.ts:2055-2066，bridge.ts:131 初始化时一次性读取），JitRL 镜像同样（index.ts:1907）。生产挂载依赖宿主自动发现时**记忆自动发现死路**；目前被 P0-1 掩盖（run 都到不了记忆写路径）。修复 P0-1 时必须同步处理，否则问题转移而非消失。
- **修复**：与 P0-1 同一改动面：holder 中保存 clients，`forwardingClients`/惰性注入到 bridge 构建处；补"仅宿主解析、无 options.clients"的 e2e。

---

## 4. 二轮裁决统计与方法可信度

| 第二轮报告 | 覆盖发现 | CONFIRMED | DOWNGRADED | UPGRADED | REFUTED | 二轮新增 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| verify-core-integration.md | 19 | 17 | 0 | 1（CORE-1→P0） | 0 | 1（VCI-1 P1） |
| verify-ledger.md | 12 | 11 | 1（LEDGER-3→P2） | 0 | 0 | 2（R2-1 P2、R2-3 P3） |
| verify-jitrl.md | 25 | 22 | 2 | 0 | 1（JINFRA-7） | 3（含 x-api-key 修复约束） |
| verify-verification-security.md | 19 | 14 | 4 | 0 | 1（VERIF-7） | 3（NEW-1 P3-info 等） |
| verify-memory-dream.md | 23 | 19 | 4 | 0 | 0 | 3（NEW-1/2/3 P3） |
| verify-tests-docs-buildci.md | 21 | 13 | 7 | 0 | 1 部分（TEST-1 降级） | 1（GATE-1 子缺口） |
| **合计** | **119** | **96** | **18** | **1** | **3** | **13** |

二轮复核的关键反证手段：真实模块 esbuild 打包后直跑（脱敏 P0-2）、真实持久层重启 repro（DREAM-1）、真实 ledger 模块 14 个 vitest repro（LEDGER 全系）、git -p 考古定位接线丢失提交（P0-1/VCI-1）、SHA256 核对冻结预注册（JITRL-1）。三项被驳回均附完整反证代码，见 §8。

---

## 5. 交叉主题（对"开发过程"的审核结论）

1. **"测试全绿"与"生产路径可用"之间存在结构性缝隙。** 所有 e2e 都注入 `options.model`/`options.runBranch`，恰好绕过 cordis.patch.yml 声明的生产解析路径；TEST-2 证实 e2e 的 probe 结果全部由 `ScriptedRunner` 罐头化，"真实执行器+真实 seam manager+真实编排器"的组合从未在自动套件里跑过。P0-1/VCI-1 正藏在这条缝里。
2. **重构丢接线的模式出现过不止一次。** `7307d7d` 一次合并同时丢掉 model/branch/clients 三条转发（P0-1、VCI-1），且孤儿 helper 与虚假注释遗留至今。仓库的自我评审流程（T9 独立评审、变异自检）抓住了多数逻辑缺陷，但没有机制守护"装配完整性"——建议引入"插件挂载冒烟"门禁（伪造宿主 ctx 的最小 e2e）。
3. **文档诚实度高于平均水平，但滞后维护。** 无捏造证据（attestation 独立重算一致、时间线与 git 完全吻合、负结果如实保留）；但存在 1 条 P1 反事实（DOCS-1"无运行时依赖"）与多条"已修仍标未修"（DOCS-2/3：代码已修、状态表未更新——修复只登记在别的文档里）。
4. **门禁层（p62 gates）是全仓最干净的部分。** 二轮确认 mutation-gate、clean-tree、negative-result、parity、attestation-target 均无同义反复、可失败、双向验证；`no-work-dependency` 元测试甚至用子进程度量门禁真实退出码。相对地，**自研业务逻辑层**（ledger 两阶段、JSONL 存储并发、scope registry、writeback 语义）集中了几乎全部 P0/P1——精确复现了"评审越多处越干净、越少处越破"的分布。
5. **安全攻击面小且守住了底线**：无 eval/new Function、src 零网络调用、CI 用 `pull_request`+SHA 钉版+`persist-credentials: false`、无硬编码密钥、monkey-patch 无原型污染、 disposers LIFO/幂等。仅有的两个 P2（SEC-1 lessonId 路径未消毒、SEC-2 任务文本直传 `args.url`）都依赖后端语义才可利用。

---

## 6. P2 清单（42 项，按域分组；`确认` = 二轮裁决）

### core / 集成
| ID | 确认 | 位置 | 摘要 | 修复要点 |
| --- | --- | --- | --- | --- |
| CORE-2 | ✅ | composer.ts:820 | "dimension wins"符号对 4/6 维度反向，错句进入 lesson 的 executionPatch.summary | 按维度方向化过滤；metadata.contrastDimensions 一并过滤 |
| CORE-3 | ✅ | composer.ts:494,633 | judge 返回空 ranking 被当有效裁决，按 branchId/nodeId 字典序发 1..n 名次并混入 15% 判定分 | 空 ranking 视为 judge 不可用；只对 judge 实际排名的别名混入 |
| CORE-4 | ✅ | orchestrator.ts:2193-2210 | writeback 历史读取缺 rewardVersion 精确匹配，与 L2 过滤口径不一致 | 复用 store 的 isLearningEligible 或补 `record.rewardVersion !== REWARD_CONTRACT.version` 跳过 |
| CORE-5(=INT-8) | ✅ | orchestrator.ts:2800-2812 | 经验去重键在 append 成功前登记，append 失败后重入被永久抑制 | 键登记移到 append resolve 之后，catch 里回滚 |
| INT-3 | ✅ | offline-dreamer.ts:352 / config.ts:597 | `candidateJitKs/…SimilarityThresholds` 被消费但 schema 禁止（unknown_key）；`candidateJitLambdas` 被文档声称使用实际从不消费 | schema 与消费者对齐（加键或删读取）；README 行改为"兼容保留不扫" |
| INT-4 | ✅ | index.ts:3276-3318 | `/evo` 双注册：两个独立 `if`，宿主同时暴露两种注册器时挂两次 | 回退块改 `else if` 或查重 `registeredCommands` |
| INT-5 | ✅ | config.ts:101-105 | `logging.level`/`includeTrajectorySummaries` 死配置（声明/校验/README 全有，无人读） | 接入 log() 或整组删除（含 README 行） |
| INT-6 | ✅ | real-benefit-controller.ts:1772; orchestrator.ts:2885 | 奖励合约身份字面量手抄两处（r4/verifier-first-v1 等），drift 风险 | 换用 `REWARD_CONTRACT.*` 导出；metadata key 加编译期见证测试 |
| INT-7 | ✅ | index.ts:3187 | `handleFallbackEvent` 的 run 未 `trackRun`，settle/dispose 不等待可中途打 abort | 与另两个入口一致包 trackRun |
| R2-1(二轮新) | ✅ | two-phase.ts | 崩溃恢复的在途调用经合法生命周期永久不可入账（settleCall→INVALID_SETTLEMENT_STATE） | 恢复扫描回填索引身份 + 允许对恢复态调用走 reconcile 路径 |

### jitrl-core / jitrl-infra
| ID | 确认 | 位置 | 摘要 | 修复要点 |
| --- | --- | --- | --- | --- |
| JITRL-2 | ✅ | logit-sources.ts:143 | 探索温度是 softmax no-op（log(share/T)=log(share)−log(T)，centerLogits 全消） | 改为 share^ (1/T) 归一或在 center 前施加；或删除该参数并在文档登记 |
| JITRL-3 | ✅ | writeback-gate.ts:360 | `applyWritebackVerdict` 从不清零 learningTarget，与注释/预注册相悖；生产在 orchestrator 内联重写 | helper 实现 target 置零并让生产复用 helper |
| JITRL-4 | ✅ | jitrl/index.ts:332-341 | `config.jitrl.logitSource` 死接线：AutoLogitSource 构建但无决策路径消费；metering 选项被丢 | 接入或删除配置面；metering 经 P2-LEDGER-9 一并补 |
| JITRL-5 | ✅ | writeback-gate.test.ts:254 | 测试名" unusable history"与夹具（可用索引）和真实行为（rejected-no-prior-failure）三方矛盾 | 修测试：传真正 unusable 夹具，断言拒绝路径 |
| JINFRA-4 | ✅ | scope-registry.ts:1381-1423 | host scope 重注册无版本化：旧 handle 的 dispose 删掉新注册；hostScopeOrder 重复 push | 套用 branch 注册的 version 方案；push 去重 |
| JINFRA-5 | ✅ | scope-registry.ts:975-1065 | 租约持有升级前冻结的 scope 快照：invariant 重注册后 lease.scope.allowAdvice 仍 true | lease.scope 改为 getter 读注册表，或重注册时刷新/失效租约 |
| JINFRA-6 | ✅ | scope-registry.ts:501-506 | `{branch:{id}}` 载体的 id 被读进 sessionIds，身份分类错 vocab（fail-closed 但污染 ADR 0006 词汇表） | branch 载体读入 branchIds；补载体形态测试 |
| JINFRA-8 | ✅ | redaction.ts:98-107 | redactAbsolutePaths 漏 UNC/`~/`/`/srv`/`/data`/`/media`/`/workspace`（实证） | 扩充模式；逐形态补测试 |
| JINFRA-9 | ✅ | jsonl.store.ts / index.ts | JSONL 日志无界增长：桶上限只作用于索引，compact()/flush() 无生产调用方 | dispose 时 flush 或 hydrate 时 compact；至少在配置文档声明无界属性 |
| LEDGER-3(降级) | ✅ | reservation-manager.ts:1137-1159 | reconcile 无 rate card 时静默记 0 并释放（与"绝不静默 0"合约相悖）；合法两阶段面会先拒绝故降级 | 无卡但有 usage 时记保守地板值 |
| LEDGER-4 | ✅ | usage-report.ts:80-88 | 报告按事件求和，对账过的调用双算（repro：报告 4,000µ vs 池 3,000µ），流入 getMeteringStatus/金丝雀证据 | 按 callId 聚合保留最新事件（镜像 adapter 的 bookedByCall） |
| LEDGER-5 | ✅ | metered-model-adapter.ts:341-344 | 非中止传输异常映射为远端确认的 `failed` → FINAL 结算记保守地板并释放席位（ECONNRESET 实测记 1,000µ） | 非 abort 异常映射为非远端确认 outcome（interim 持有资金/席位） |
| LEDGER-6 | ✅ | metered-model-adapter.ts:610-613 | 成功路径 settle 失败被吞、缺契约的 `settle_failed` 标记；settle 可在钱已动后抛 | 成功路径 catch 同样置 settleFailure 并记录 `error:'settle_failed'` |
| LEDGER-7 | ✅ | two-phase.ts:302-308 | 索引 load 对任意位置损坏行静默 continue（自己的注释要求 fail-closed；WAL 读取是对的） | 复制 WAL 规则：仅容忍最后一行截断，否则抛 INDEX_CORRUPT |
| LEDGER-8 | ✅ | reservation-manager.ts:982-996 | 状态/幂等缓存在 WAL append 之前变更：append 失败留下未记日志的钱动，重试视作已完成 | append-then-apply 或失败回滚/标记 unlogged |
| LEDGER-9 | ✅(机制修正) | jitrl/index.ts:332-341 | logit-probe 与 LLM-judge 无 ledger（真金白银零计量）；静态 coverage 门禁只数 `.complete(` 管不到。修正：阻塞点在 `AutoLogitSourceOptions` 与 index.ts 调用点，`createTokenLogprobSource/StepEvaluatorOptions` 本已支持 metering | 在 jitrl/index.ts 两处传入 options.metering（改动比一轮估计的小） |
| MEM-2 | ✅ | lingshu-mdcg.driver.ts:84 | `stg op=timeline` 回退完全不带命名空间参数，跨命名空间记录进入召回 | 回退分支补 namespace 变元 |
| MEM-3 | ✅ | drivers/*.ts | 四个驱动以**数组**发送分支 scope 的命名空间过滤，而后端 schema 声明标量（自家 mock 是 array-tolerant 才没暴露） | 分支 scope 改为逐命名空间标量查询或后端契约收敛；mock schema 改成真实形态 |
| MEM-4 | ✅ | lingshu 渲染路径 | 编解码往返损坏（实证）：fractional metricsDelta 截断、多行证据只剩首行、summary 内标题注入幽灵 whenNotToApply 子句 | 原生路径存结构化 form（frontmatter 路径本就无损）+ 读前校验 heading |
| MEM-5 | ✅ | memory-bridge 并发上限 | maxConcurrentBranches TOCTOU（检查与占位间有 await；cap 1 双执行 repro） | 占位与检查放入同一同步段 |
| TEST-1(降级) | ✅ | tests/ | clients.ts（376 行）零测试引用；model.ts 有一个真实测试（pr3a-metering-recovery 驱动 createLlmModelAdapter），"零测试"标题不成立但五个纯 helper 与流错误边角未测 | 补 chunkTypeOf/usageToTokens/finishReasonOf/throw-before-finish/重复 finish 用例 |
| TEST-2 | ✅ | tests/e2e/fixtures.ts:214 | e2e probe 结果全由 ScriptedRunner 罐头化；真实执行器×真实 seam manager×真实编排器组合从未运行 | 加一条接线 createAgentLoopExecutor 的 e2e（可复用 contract-smoke 的 waterfall 夹具） |
| TEST-3 | ✅ | concurrency.test.ts:584; experience-store.test.ts:516 | 墙钟性能断言（<200ms/<25ms）在负载 CI 上会假红，违背仓内"load is the variable"哲学 | 改下界断言或 CI 跳过 |
| DOCS-2 | ✅ | P62_STATUS.md / DEVELOPMENT_LOG.md | 三条"未修"残留实际已修（host-triggers.ts R-01 等），状态表未回写 | 状态表加"已由 X 关闭"回指 |
| DOCS-3 | ✅ | P62_STATUS.md:78 | C2b 矩阵行"全部未做"，而 C2b 已于 0410d78 落地并有测试；ADR 0004-c2b 仍是 draft 却被生产代码引用为合约 | 更新矩阵行 + ADR 状态流转 |
| BUILD-1 | ✅ | build-manifest.mjs:82-105 | 构建新鲜度只哈希 src/**/*.ts；schemastery 被 bundle 内联 → 依赖升级不重建也判 fresh | stamp 加入 package.json + lockfile 摘要；commit 对比纳入 stale 判定 |
| BUILD-2 | ✅ | tsconfig.json | include 仅 src/tests：~340KB scripts/ 下的 TS（eval 库等）从不 typecheck | include 加 scripts 或单独 tsconfig.sciprets.json 并入 CI |

### verification / security / dream
| ID | 确认 | 位置 | 摘要 | 修复要点 |
| --- | --- | --- | --- | --- |
| VERIF-1(降级) | ✅ | cache-observation.ts:504-530 | 符号检验方向未查（1 减/47 增仍 applicable）+ 1024+ 不一致对 NaN 溢出开闸（数学复现）；但生产零调用点（仅离线 eval 报告脚本），故 P2 | 方向性检验 + p 值用对数域/BigInt；顺带修复离线报告正确性 |
| VERIF-2 | ✅ | attach.ts:432-441 | 陈旧工件拒绝行是唯一在 `registered === receipt` 身份检查**之前**授予 `authenticated:true` 的路径 → 撒谎 runner 可伪造 verificationVerdict 标记 | 把该行移到身份检查之后（二轮确认生产 runner 在该路径返回注册对象，改动回归安全） |
| SEC-1 | ✅ | markdown-note.driver.ts:37-39 | lessonId 未消毒直拼 MCP 文件工具路径（script 路径反而有 isValidScriptPath 校验；`sanitizeFileToken` 存在但未被调用） | notePath 走 sanitizeFileToken/白名单；deny 越界路径 |
| DREAM-2 | ✅ | policy.store.ts / tree-pool.store.ts | writeFileAtomic 无 Windows rename 重试（EPERM 实测），错误被写队列吞为诊断 → 内存 2 vs 磁盘 1（repro） | EPERM/EACCES 有限重试 + 把 store 诊断接到 persistence.diagnostics（二轮 NEW-2 同根） |
| DREAM-4 | ✅ | active-policy.ts | planGrid 用 request.policy、selectBatch 跨 await 重读 this.current：空闲做梦热替换可造成单批次混用两版策略 | 批次内快照 policy；空闲触发与在途 run 互斥 |

---

## 7. P3 清单（~70 项，压缩表；细目与逐条修复见对应 round-1/round-2 报告）

- **core**：CORE-6 recordModeOf 注释反写实现；CORE-7 judge 权重未归一化（15% 上限仅默认值非不变量）；CORE-8 `'stopped'` 不可达 + `rounds_completed` 名不副实；CORE-9 reflector 去重诊断指向被替换 lesson 的 id。
- **集成**：INT-8/CORE-5 同源（P3 口径）；INT-9 `unregisteredQualityRecords` 只写不读且注释虚假；INT-10 forwardingBranch 回退链双源（修 P0-1 时收敛）。
- **jitrl-core**：JITRL-6 verifierRewardMismatch 结构性恒 false；JITRL-7 selectNeighbors 以 legacy `return` 门槛而 estimator 消费 observedReturn；JITRL-8(降级) 复合授权缺口；JITRL-9 backfill appended 计数含去重丢弃；JITRL-10 `reset <bucket>` 无 `--confirm`。
- **jitrl-infra**：JINFRA-10(降级) 无目录 fsync（header 声明未被证伪，改措辞）；JINFRA-11 撕尾诊断以 UTF-16 单位冒充字节；JINFRA-12 三处诊断数组无界；JINFRA-13 版本字典序 max（r10<r2）；JINFRA-14 strict 后端被强制 `text` 属性违背自身 docstring；JINFRA-15 TypeError 误标 retryable transport（undici 部分可辩护）。
- **ledger**：LEDGER-10 未上报 reasoning/cacheWrite 不降级 provenance；LEDGER-11 无跨进程预算执行（共享 storageDir 双进程各给全额）；LEDGER-12 providerCallId 账单永不匹配（映射数据被上游丢弃）；R2-3(二轮新) bookNewAttempt 无卡时记 0。
- **verification/dsh-bridge**：VERIF-3(降级) 取消记为 timeout 信号（两处消费者实际不敏感）；VERIF-4 pre-try throw 可拒绝 runBranch 违"never rejects"合约；VERIF-5 settleCall 抛出吞掉并丢 ledgerCallRefs；VERIF-6 非整数 metadata budget 静默禁用计时器；VERIF-8 raceTimeout 只 abandon 不 cancel（迟到回执仍可注册）；VERIF-9 catch 对 aborted 流也 FINAL 结算（与 executor 的 INTERIM 不一致）；VERIF-10 canary"measured"用量用双重计数的 gross 和；VERIF-11 合成测试回执自封（v1 有 `allowed:false` 遏制）；VERIF-12 重复 producedFiles 破坏"每文件集合一个摘要"；NEW-1(二轮) verdictInfo 配对矛盾（当前工件摘要配对早期工件的 verdict）。
- **security**：SEC-2(降级) 任务文本直传 `args.url`（build_context 仅在 search_notes 缺席时绑定，SSRF 依后端语义）；SEC-3 verify-readme-counts 的 execSync 插值（自生成路径，风险=TMP 环境变量元字符）；SEC-4 diagnostics/ 未 gitignore；SEC-5 experienceFilePath 无容器化检查（集成方控制面）；SEC-6 Windows 保留设备名通过 sanitizeProfileName；SEC-7 asar 助手硬编码机器路径（未跟踪文件）。
- **memory/seams**：MEM-6(降级) 重复 branchId 共享命名空间（插件自身派发不可达，外部调用者加固）；MEM-7(降级) tool-face 白名单 30 分钟 TTL 后失效（被探针 ≤10min 超时掩护）；MEM-8 isolate 双句柄计数；MEM-9 markdown-note 有 prune 能力却被 capabilities 门跳过；MEM-10 enforceGovernance 死合约面；MEM-11 DisposableRegistry 无 deadline（一个挂起 disposer 拖死整个 LIFO 回滚）；MEM-12 finalize 合并不对称（现接线潜在）。
- **dream/persistence**：DREAM-3(降级) 无环校验缺失（treeFromSnapshot 零 src 调用方，全潜伏）；DREAM-5 步进效率对 ≤baseline 全饱和（设计疣，测试钉住）；DREAM-6 bestNodeOf NaN 毒化；DREAM-7 历史修剪重盖审计时间戳；DREAM-8 sweepTempFiles 误删含 `.tmp-` 子串的任意文件；DREAM-9 计数器内存读改写+`a` 模式追加（单主机假设未声明）；DREAM-10 无目录 fsync（声明措辞）；DREAM-11 ADR 建议值 2 vs 实现 1（有意偏离，已文档化）。
- **tests**：TEST-4(降级) ledger-event 两导出有内部生产调用方，仅无直接测试；TEST-5 元测试三次嵌套 vitest 子进程（重、脆、10 分钟超时）；TEST-6(降级) 三处 no-throw 断言实际都有配套行为断言。
- **docs**：DOCS-4 README 称仅一个可选无默认键，`jitrl.budget` 是第二个；DOCS-5 两份 ADR 共用编号 0004；DOCS-6 Project layout 树缺 6 个 src 模块与 scripts/ 全家。
- **build/CI**：GATE-1(降级) smoke-build 从不断言 default export（源级测试已钉 3/4 成员，残余暴露=bundle 层）；CI-1 metering-coverage 门禁无具名 CI/脚本入口；CI-2 smoke-build 默认模式自证新鲜；CI-3 engines>=20.19 下限从未实测（CI=22/24）；CI-4 host-smoke 超时不收割 MCP 孙进程；CI-5 run.mjs 陈旧 t31 注释。
- **memory 二轮新**：NEW-1 默认 newId 双前缀（evo-evo-1，化妆性）；NEW-2 创建时诊断快照到不了 persistence.diagnostics（DREAM-1/2 的放大器）；NEW-3 createIsolatedBranch→toolFace.install 间有 await 的一处细节修正。
- **jitrl 二轮新**：离线门禁判定与生产门禁读取不同历史（资格过滤分歧）；facade 版本盖章允许无 verdict 的 host-tool 记录进入 writeback 历史；修复 JINFRA-1 时须保住 `x-api-key: AKIA…` 的既有覆盖。

---

## 8. 被驳回的发现（如实保留，含反证）

| 原 ID | 一轮主张 | 二轮反证 | 处置 |
| --- | --- | --- | --- |
| JINFRA-7 | 镜像 note 路径消歧 hash 基于消毒后 slug，`task|simple` vs `task-simple` 同 hash 互覆 | 实证：sanitizeText 保留 `\|`/空格，两对样本 hash **不同**（1rpn599 vs 1gpzy32），路径不同；仅刻意的 redaction 合并才碰撞 | 剔除 |
| VERIF-7 | clean-attach 未消费记录会落 `verificationAuditOnly: 0` | attach.ts:611-615 认证宿主裁决恒胜出、receipt.status 受类型约束恒 passed/failed → verdictDerived 恒真、标记恒 1；attach.test.ts:744-756 钉死 | 剔除 |
| TEST-1（部分） | model.ts+clients.ts 零测试引用 | pr3a-metering-recovery.test.ts:32-190 真实驱动 createLlmModelAdapter/drainDshStream（fake host ctx）；model.ts 非零覆盖。clients.ts 零引用成立 | 降级 P2 并改写 |

---

## 9. 修复路线图（优先级排序）

**第 0 批（立即，1-2 天）**
1. P0-1 + P1-9（同一改动面）：恢复 holder 转发（model/branch/**clients**），收敛 INT-10 回退链，加"伪造 ctx.llm 的挂载冒烟 e2e"作为永久门禁（并入 `pnpm run verify`）。修 P1-1（model 独立解析）属同一文件顺手完成。
2. P0-2：redaction 延伸匹配 + `x-api-key` 回归用例 + `Authorization: Bearer` 形态测试。
3. P0-3：bookNewAttempt 确定性 callId + 重投幂等测试。
4. P1-7：id 序列播种 + tree-pool 拒绝旧覆新 + 重启恢复 e2e。

**第 1 批（本迭代内）**
5. 资金面集中修：P1-5（幂等重放补索引写）、LEDGER-5（传输异常 interim）、LEDGER-8（append-then-apply）、LEDGER-7（索引 fail-closed）、LEDGER-4（按 callId 聚合）、LEDGER-6（settle_failed 标记）、LEDGER-9/R2-1（jitrl 计量接线与恢复路径）。
6. 存储并发面：P1-2（JSONL 变更互斥）、MEM-5（TOCTOU 同步化）、DREAM-2（EPERM 重试+诊断接线）。
7. 语义对齐面：P1-4（G-A verdict 字段）、P1-3（store 实现 drift 合约）、JINFRA-5/4/6（registry 版本化/租约刷新/载体分类）、CORE-4（历史读取加 rewardVersion）。
8. P1-6：防火墙强制 lesson 级 sessionId。
9. P1-8 + DOCS-2/3：文档三处校正（无运行时依赖行、已修残留回写、C2b 矩阵行）。

**第 2 批（加固，次迭代）**
10. TEST-2 的真实执行器 e2e、TEST-1 残余（clients.ts + 流错误边角）、TEST-3 移除墙钟断言。
11. P2 其余项按域批量处理（每项都已在 §6 给出修复要点）。
12. 过程改进：把"挂载冒烟"与"import 路径覆盖检查"（防 model.ts/clients.ts 式盲区再发）纳入 ADR 0005 的门禁族；对"重构删代码"增加孤儿符号门禁（`forwardingModel` 式零调用导出报警）。

**验证方式**：每批修复后跑 `pnpm run verify` + `check:docs` + `check:mutation`；第 0 批完成后重跑 `pnpm run attest` 在目标提交重生成记录（SELF-REFERENCE BOUNDARY：evidence 提交单独提交）。

---

## 10. 附录：审计产出物

- 第一轮（12 份，`round1/`）：core.md、jitrl-core.md、jitrl-infra.md、ledger.md、verification-bridge.md、memory-seams.md、dream-persistence.md、tests.md、docs.md、security.md、build-ci.md、integration.md
- 第二轮（6 份，`round2/`）：verify-core-integration.md、verify-jitrl.md、verify-ledger.md、verify-verification-security.md、verify-memory-dream.md、verify-tests-docs-buildci.md
- 本报告：`CROSS-AUDIT-REPORT.md`
- 所有临时 repro 脚本均已清理；除 diagnostics/ 下新增审计文件外未改动任何工作树文件。
