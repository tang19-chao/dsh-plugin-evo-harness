# t13 — 可观测性与 modelRoute 校验链路独立审核（round 1）

- **被审对象**：t5（适配器/契约来源 + effort 校验）与 t7（入口 status 接线），以 t7 为 reviewedTaskId；t5 无 output 记录，其语义由我从工作树直接核验
- **审核人**：architect-reviewer（独立于实现者与验证者；本报告只新增 `docs/reports/t13-observability-and-route-review.md`，未改动任何实现路径）
- **契约**：ADR 0005 §3.6–§3.7（route effort 单一来源 + 可观测性来源/collect-or-omit）
- **结论**：**verdict = PASS**（两项验收全部核实；2 条 low/info 观察，均不阻塞）
- **日期**：2026-10-29；基线 HEAD `722625c`（P1 改动在工作树未提交）

---

## 1. 审核方法（独立重放；t5 无 output 记录，全部从工作树核验）

1. **逐行读三个文件的 diff**：`src/types/contracts.ts`（+40：`HostAdvisorObservabilityCounters`）、`src/host-triggers.ts`（+127：`DshHostAdvisorStatusMapping`/`mapHostAdvisorStatus`/`ModelRouteEffortError`/`assertModelRouteEffort`/`splitModelRoute` 校验）、`src/cordis-seams/dsh-hook-host-adapter.ts`（+72：`advisorObservability` 两个新事件点、`Required` 快照类型、`hostAdvisorStats` 展开），以及 t7 的 `src/index.ts` 接线 hunk。
2. **自建运行时探针**（`work/_t13_review/probe.ts` → esbuild bundle，**34/34**）：内联复刻最小 hook fixture（不 import vitest），驱动**真实** `createEvoHarnessPlugin` + 真实 hook 适配器 + 真实 `apply`：
   - 未采集（in-memory 适配器）：对象与 JSON 中**所有计数键缺失**；
   - 真实 hook 适配器、零活动：**7 个计数全部以 0 出现**（测得零）；
   - 匿名 gate dispatch：considered=1 / scopeUnknownSkipped=1 / skipped=1；
   - 声明 scope 不匹配：considered=1 / excludedByDeclaration=1 / skipped=1；
   - scope 匹配的 gate dispatch：considered=1、skipped=0、noop=1；
   - advisory 模式：advisory=1、considered=1、skipped=0，且 advice 文本正常注入；
   - **canary**：把 `CANARY-T13-DO-NOT-LEAK` 放进 tool args 与 pre-step messages，序列化 `status`/`jitrl`/`diagnostics` 后**不出现**；
   - **部分采集**：注入只返回 `{considered:3}` 的适配器 → `considered=3` 且其余计数键**缺失**（不是 0）；
   - effort 矩阵：`high/max/low` 原样接受；`ultra/MAX/' max'/med/'0'` 全部 `ModelRouteEffortError`；`42/true/{secret}` 非字符串拒绝且消息不含 payload（对象显示 `[object]`）；`undefined/null/''` absent-like → 默认 `max`；程序化 `options.route` 同样拒绝 `ultra`。
3. **编译期见证**（同一探针文件跑 `tsc --strict`，exit 0 即所有 `@ts-expect-error` 都被真实错误"消费"）：可选计数 → `EvoHarnessHostAdvisorStatus` 缺省可构造；计数写字符串 → TS2322；`DshHostAdvisorStatsSnapshot` 缺任一计数 → 报错（适配器快照 Required）；`EvoHarnessModelRouteEffort = 'ultra'` → 报错。
4. **独立复跑**：t5/t7 四个专属套件 **66/66**；全量 Vitest **103 文件 / 2092 用例全绿**（我本人跑）；`git diff --check` exit 0。
5. **t4 非回归**：`plugin-options-shape` 27/27 + 我在 t12 建的独立 47 期望配置探针复跑 **47/47**（混合拒绝/ctx.config/裸 config/26 键）。
6. **下游消费核对**：`src/**` 内除状态构造外**没有**消费者对这些计数做算术/派生（grep），可选类型化不会破坏内部逻辑。

---

## 2. 验收逐项核实

### 2.1 "可观测性来源、类型与 modelRoute effort 校验正确，未采集与零发生可区分" — **passed**

**来源（真实事件点，非派生）**——逐条读码 + 实测：

| 计数 | 事件点（代码位置） | 实测 |
| --- | --- | --- |
| `considered` | `advisorInScope` 入口（每次进入资格判定 +1，与结果无关） | 匿名/声明 scope/在 scope 三种 dispatch 均 +1；advisor off 时不进入 → 0 |
| `excludedByDeclaration` | ①`isInvariantDispatch` 为真（含 **ScopeRegistry 的 trusted registration / guidance_free / host 声明**——该函数在 846-851 行即查询 registry）②显式 `hostAdvisorScope` 不匹配 | 声明 scope 不匹配 → 1；在 scope → 0（registry 路径与 `isInvariantDispatch` 同源，我核对后确认未被漏计） |
| `scopeUnknownSkipped` | D1 fail-closed 点（identity 不可证） | 匿名 dispatch → 1；声明 scope 场景 → 0 |
| `advisory/ask/noop` | 决策结果点（原有） | advisory 模式 → advisory=1；gate + noop 决策 → noop=1 |
| `skipped` | 4 处：runtime gate off（资格判定**之前**）×2；gate 未获 scope / 无名工具、advisory 未获 scope（资格判定**之后**）×2 | 匿名 gate：skipped=1 且 considered=1（见 O1） |

**类型（契约 ↔ 实现分层）**：公共契约 `HostAdvisorObservabilityCounters` 全部字段可选（"未采集"）；真实适配器方法返回 `DshHostAdvisorStatsSnapshot = Required<...>`（"测得零也是数字"）。编译期见证双向成立。`EvoHarnessHostAdvisorStatus extends HostAdvisorObservabilityCounters`，入口以 `mapHostAdvisorStatus` 展平，JSON 序列化自动丢弃缺失键。

**未采集 vs 零发生（三档实测）**：

| 来源 | 对象 | JSON | 语义 |
| --- | --- | --- | --- |
| 无 `hostAdvisorStats` 的 in-memory 适配器 | 7 个计数键**全部缺失** | 同样缺失 | 未采集 |
| 真实 hook 适配器、零活动 | 7 个键全部为 `0` | 保留 `0` | 测得零 |
| 只返回 `{considered:3}` 的部分来源 | `considered=3`，其余键**缺失** | 同样缺失 | 按字段采集（不是 0） |

**modelRoute effort（单一来源 + 严格）**：`MODEL_ROUTE_EFFORTS` 唯一来源（host-triggers 不另写词表）；宿主组 `splitModelRoute` 与程序化 `options.route` 两条路径共用 `assertModelRouteEffort`；`ultra/MAX/' max'/med/'0'` 全部具名拒绝（`model-route-effort-invalid`）；非字符串拒绝且**不回显对象 payload**；`undefined/null/''` 明确为 absent-like（默认 `max`，不是空串）。**没有静默回退分支**。

### 2.2 "入口 status 暴露无字段丢失、无敏感 payload，t4 配置反例未回退" — **passed**

| 检查 | 结果 |
| --- | --- |
| 字段完整性（真实 hook 适配器） | status 恰 12 键：`enabled/mode/attached/runtimeEnabled/diagnostics` + 7 个计数；原 4 个（advisory/ask/noop/skipped）无丢失，新增 scopeUnknownSkipped/considered/excludedByDeclaration 全部可见 |
| 动态性 | 同一 status getter 每次读取都取适配器实时快照（t7 用例 + 我的连续 dispatch 探针均验证计数递增） |
| 敏感 payload | 我把 canary 放进 tool args 与 pre-step messages：status/jitrl/diagnostics 序列化后无 canary、无 `secret`；t5 的 payload-free 用例另断言计数器对象恰为 7 个键、不含工具名/原因文本 |
| 错误消息 | `PluginOptionsShapeError`（t4）与 `ModelRouteEffortError` 均不回显对象 payload（对象 → `[object]`） |
| t4 配置反例 | `plugin-options-shape` 27/27 + 我的 47 期望探针 47/47：26 键穷举、ROOT_KEYS 不相交、混合拒绝、`ctx.config` 保留、裸 config/modelRoute 路径全部保持 |
| 全量回归 | 103 files / 2092 tests 全绿（无既有状态消费者被可选字段破坏；`tsc --noEmit` exit 0） |

---

## 3. 实现审查要点

- **适配器快照类型**：`DshHostAdvisorStats = HostAdvisorObservabilityCounters`（可选契约）+ `DshHostAdvisorStatsSnapshot = Required<...>`（真实适配器）；`hostAdvisorStats()` 返回后者，结构性适配器只满足前者时入口仍可安全读取（t7 用 `typeof adapter.hostAdvisorStats === 'function'` 探测）。
- **映射规则**：`mapHostAdvisorStatus(fixed, stats?)` —— `stats` 存在则原样展开（`{...stats}`），缺失则 `counters={}`；`hostAdvisorJitStatus` 展平后返回，保持公开 FLAT 形状（既有消费者读 `hostAdvisor.advisory` 不变，只是缺失时键不存在）。
- **无派生**：considered/excludedByDeclaration/scopeUnknownSkipped 各自独立累加，没有从别的计数推算；`advisorInScope` 单次调用内 considered 只 +1。
- **effort 层**：`ModelRouteEffortError` 带稳定 `code`/`value`/`allowed`；`assertModelRouteEffort` 先放行 absent-like，再严格匹配枚举，最后拒绝非字符串；`splitModelRoute` 只在键**存在**时校验（缺席保持默认语义）——与 ADR §3.6 "缺省是默认、显式非法是错误"一致。
- **范围**：t5 未触碰 `src/index.ts`；t7 在 t4 最新文件上增量、未回退键表/判定/witness（t4 套件 + 我的 t12 探针复跑通过）。

---

## 4. 观察（low/info，不阻塞）

- **O1（low，公开契约文字与实际语义不一致）**：`src/types/contracts.ts` 的 `skipped` 注释写"advisor off / runtime gate / other skips that **never reached the eligibility decision**"，但实测（我也复现了 t7 的记录）**匿名 gate dispatch 同时 considered=1、skipped=1**，声明 scope 外同样如此；即 `skipped` 的 4 个累加点中有 2 个发生在资格判定**之后**（gate 未获 scope/无名工具、advisory 未获 scope），与注释相反。计数本身真实、独立、未派生（不违反 ADR §3.7 的"真实事件点"要求），t7 的用例也已按实测断言并就地注明。**建议**把注释改为："skipped — decisions suppressed by the advisor path: the runtime gate fired BEFORE eligibility, or the dispatch was ineligible AFTER it (out of declared scope / unprovable identity / unnamed tool); a dispatch may therefore be counted in both `considered` and `skipped`."（一行注释，属 t5 文件；t16 的写范围不含 src，若要修需一个极小 t5 follow-up，或由 t16 明确记录为已知语义。）
- **O2（low，防御性边界）**：`mapHostAdvisorStatus` 用 `{...stats}` 原样转发，入口再展平到公开 status；我注入一个返回 `{considered:1, toolName:'CANARY-ADAPTER-EXTRA'}` 的结构性适配器，**额外字段确实进入了公开 status**。当前真实适配器只返回 7 个计数（t5 的 payload-free 用例钉住键集），所以现状无泄漏；但"入口只暴露计数"这一契约目前依赖**来源自觉**而非入口白名单。**建议**（后续加固）：`mapHostAdvisorStatus` 按键白名单（7 个计数）挑字段，或入口侧显式 pick，保证公共形状由入口控制。
- **O3（info）**：工作树中 `src/host-triggers.ts`、`src/types/contracts.ts`、`src/cordis-seams/dsh-hook-host-adapter.ts` 为 CRLF（`git` 提示提交时归一 LF）；`git diff` 仍为内容级 diff（40/127/72 行，无整文件 EOL 噪声），`.gitattributes` 的 `*.ts text eol=lf` 保证提交 blob 为 LF，`check:encoding` 读提交 blob 通过——不是缺陷，仅提醒 t9/t16 取证时不要用工作树字节。

**无 blocker / 无 high / 无 medium findings；验收两条均满足。**

---

## 5. 复现方式

```bash
# 1) t5/t7 专属套件（66）
pnpm exec vitest run tests/unit/seams/status-observability.test.ts tests/unit/seams/status-observability-contract.test.ts tests/unit/config/model-route-effort.test.ts tests/unit/config/plugin-options-shape.test.ts
# 2) 独立运行时探针（34 期望；真实入口 + 真实 hook 适配器 + canary + 部分采集）
pnpm exec esbuild work/_t13_review/probe.ts --bundle --format=esm --platform=node --outfile=work/_t13_review/probe.mjs
node work/_t13_review/probe.mjs
# 3) 编译期见证（可选计数 / Required 快照 / effort 枚举 / 反例）
.\node_modules\.bin\tsc.cmd --noEmit --strict --skipLibCheck --module esnext --moduleResolution bundler --target es2022 --types node --allowImportingTsExtensions work/_t13_review/probe.ts
# 4) t4 非回归 + 全量
node work/_t12_review/probe.mjs
pnpm exec vitest run --reporter=dot
```

---

## 6. 附录（t20 提交前复验，2026-10-29）：t19 收口后的字节变化与本审核结论的关系

> 本节由集成复验任务 t20 追加（仅追加，不回写 §1–§5）。t13 的正式 round-1 裁定仍以 §2/§4 为准；是否需要 reviewer 重出裁定由 captain 决定。

### 6.1 审核后发生的字节变化（t19）

- 改动路径：`src/types/contracts.ts`（mtime 2026-10-29 06:20:59）。t19 在台账中**无 output 记录**，故本节从工作树 + §4 O1 保留的旧措辞反推其改动。
- 改动内容：`HostAdvisorObservabilityCounters` 的文档注释中 `skipped` 一段被重写。§4 O1 引用的旧措辞（"advisor off / runtime gate / other skips that **never reached the eligibility decision**"）已不存在；新措辞为：`skipped` 既包含资格判定**之前**的跳过（advisor off / 运行时闸门关闭），也包含**部分资格判定之后**的 out-of-scope 与无名工具路径（它们已被计入 `considered` 却从未到达 advisor），并声明 `skipped` 与结果计数（advisory/ask/noop）**每个 dispatch 互斥**。
- 类型面零改动：字段集合仍为 7 个可选计数（advisory / ask / noop / skipped / scopeUnknownSkipped / considered / excludedByDeclaration），未增删字段、未改可选性；tsc exit 0。

### 6.2 新措辞与真实计数点的独立核对（读代码，不采信自述）

`src/cordis-seams/dsh-hook-host-adapter.ts`：

- `considered += 1` 在 `advisorInScope()` 内（第 880 行）；`excludedByDeclaration` 在 887/907。
- `skipped` 共 5 个累加点：**1096**（pre-execute：advisor 已挂载、未 dispose、运行时闸门关闭 → 资格判定之前）、**1099**（gate：`!advisorInScope` → 判定之后）、**1120**（gate：`toolName === undefined` 无名工具 → 判定之后）、**1173**（pre-step：运行时闸门关闭 → 判定之前）、**1177**（pre-step：`!advisorInScope` → 判定之后）。→ 5 点中 3 点在资格判定之后，**新注释「after a partial eligibility run」的描述与代码一致**（旧注释「never reached the eligibility decision」确实与 1099/1120/1177 相反）。
- 互斥性核对：pre-execute 每个 dispatch 只会走 1096 / 1099 / 1104 / 1114·1117 / 1120 之一；pre-step 只会走 1173 / 1177 / 1184 / 1190 / 1193 之一 → 与「skipped 与 outcome 计数每 dispatch 互斥」一致。

### 6.3 对 §2/§3/§4 结论的影响

- §4 **O1（low，「公开契约文字与实际语义不一致」）判定为已闭环**：导致矛盾的旧措辞已被替换，新措辞可逐点对回真实累加点。
- §2.1 / §2.2 / §3 结论**不回退**：t5/t7 的 collect-or-omit 与 route effort 语义未变；相关套件（status-observability 12 + status-observability-contract 12 + model-route-effort 15 + plugin-options-shape 27）在全量 **2094** 用例中全绿，tsc exit 0。
- **残余（新登记，low/info，未修）**：新注释把资格判定之前的跳过写成「advisor off **or** the runtime gate closed」两个原因，但本适配器里 advisor 未挂载（`hostAdvisor.enabled=false` → `advisor === undefined`）时**根本不计数**：pre-execute 的第 1095/1097 行条件均不成立，pre-step 在 1166 行提前 return，`skipped` 也不会 +1。因此可观测到的「判定前跳过」只有运行时闸门（`/evo jit off`）一种；"advisor off" 不是本适配器的 skipped 来源。建议把该短语收敛（一行注释，属 t5 文件；`src/` **不在 t20 写范围**，未擅自修改）。
