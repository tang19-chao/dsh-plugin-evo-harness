# P2–P6 集成尾巴 B：宿主接线（预算提醒 / 成本来源 / 授权账本 / 工具面）

- 任务：`t3`（team `p2-p6-integration`，member `integrator-core`）
- 写范围：`src/index.ts`、`src/orchestrator.ts`、`src/config.ts`、`src/jitrl/jit-active-policy.ts`（仅暴露所需选项）、`tests/unit/`、本文件
- 取样时刻：2026-10-30T00:17–00:31+08:00
- 结论速览：**四项里 1 项已接线落地、1 项交付"组装规则 + 负例"但构造点刻意不填数、2 项判定为本轮做不到并给出最小补丁草案。默认配置下宿主行为零变化（影子对照为正式测试内断言）。**

---

## 0. 一句话结论（供复核者先看这条）

| # | 子项 | 状态 | 判据 |
| --- | --- | --- | --- |
| W1 | 预算提醒接到宿主可达点 | **已落地** | 默认 false；关则零对象；开则生效；影子对照绿 |
| W2 | `costObservations` 真实来源 | **FAILED（未接线）** — 组装规则 + 12 条负例已交付，但构造点**刻意不填数**，生产路径零取用 | 非 measured 使整轴不可用；不伪造数据 |
| W3 | 授权账本接真实调用点 | **未执行（需裁定）** | 需改 `dsh-bridge/**` 多调用点，超写范围 |
| W4 | 工具面 allowlist 生产开关 | **未执行（需裁定）** | 同上；且默认"不下发"已由现状满足 |

"已落地"的定义按本轮复核者的机械判据：**(a) 公开导出面是否新增名字；(b) `src/index.ts` 是否真的取用它们。** 只有 (a) 有导出而 (b) 无取用，才算"仍库层就绪"。

---

## 1. W1 预算提醒：已落地

### 1.1 问题（上一轮的 handoff）

`src/index.ts:1575` 是全仓**唯一**生产构造点（`kernel.createJitActivePolicy({...})`）。它此前**不传 `budget`**，所以 P6 的预算档/提醒/Pareto 轴虽然机制完备，宿主却永远无法打开——`docs/adr/0007` §7.4 与 `docs/reports/p6-pareto-budget.md` §1 都把它登记为 `未落地（handoff）`。

### 1.2 一个必须偏离 ADR 原文的设计裁定

ADR 0007 §7.4 给出的配置叶示例是**带默认值**的：

```ts
budget: { tier: 'medium', reminder: { enabled: false } },
```

**照抄这一行会破坏本任务自己的验收判据。** 推导：

1. 一旦 `config.jitrl.budget` 有默认值，`src/index.ts` 就会**无条件**把 `budget` 传给装饰器；
2. `budgetGate()` 每次决策都跑（`jit-active-policy.ts:1016` 只在 `this.budget === undefined` 时早退）；
3. 于是**每个决策的 `metadata.jit` 都会多出一个 `budget` 键**；
4. 这正是"默认配置下宿主行为与改动前完全一致"所禁止的。

所以本任务只加**可选叶、不加默认叶**：`JitRlConfig.budget?: { tier?, reminder?: { enabled? } }`，默认**不存在**。

这不是绕过 ADR，而是从验收判据反推实现形态：ADR 0007 L171 本身已记录队长裁定 A"**不新增** `src/config.ts` 配置叶"，L140 那个块是"叶长什么样"的示例形态，不是"默认值必须存在"的要求。

**副作用（实测确认，非推测）**：不加默认叶 ⇒ 默认叶计数不变（仍 78 = 75 config + 3 modelRoute）⇒ README 配置参考表无需改动 ⇒ `check:docs` 的配置门保持绿。

### 1.3 改动

**`src/config.ts`**

- `JitRlConfig` 新增可选成员 `budget?: JitRlBudgetConfig`（含长注释说明为何**没有**默认值）。
- 新增 `JitRlBudgetConfig` 接口：`tier?: 'lite' | 'medium' | 'heavy'`、`reminder?: { enabled?: boolean }`。
- `JITRL_KEYS` 增加 `'budget'`；新增 `JITRL_BUDGET_KEYS`、`JITRL_BUDGET_REMINDER_KEYS`、`JITRL_BUDGET_TIERS_ALLOWED`。
- `buildConfig` 内对 `jitrl.budget` 与 `jitrl.budget.reminder` 递归 `collectUnknownKeys`。
- `validateJitRlGroup` 仅在 `jitrl.budget !== undefined` 时校验：**缺席 = 未配置，不是无效**，不推 issue。

**`src/index.ts`**

- 新增 `export function resolveBudgetHookConfig(budget, costObservations?): BudgetHookConfig | undefined`：
  - `budget === undefined` ⇒ 返回 `undefined`（默认路径）；
  - `reminder.enabled` 只在**字面量 `true`** 时才是 `true`；块存在但字段缺席 ⇒ `false`（装饰器只认 `=== true`，`jit-active-policy.ts:1040`）。
- `buildJitRlWiring` 内构造装饰器时增加一行展开：
  ```ts
  ...(budgetHook === undefined ? {} : { budget: budgetHook })
  ```
  缺席时**不产生任何键**，装饰器对象与改动前逐字节相同。

### 1.4 证据

**影子对照（正式测试内断言，非 probe）**

```
命令: pnpm exec vitest run tests/unit/jitrl/p6-host-wiring.test.ts
退出码: 0
取样: 2026-10-30T00:25:10+08:00
关键输出:
  HOST-WIRING SLOTS_DIGEST=a8c207ca083336b1a2828f88f428fa68a53a30ca37fad098157b3bcbdbbd16a1 PASS
  HOST-WIRING DIAG_DIGEST=f2c0737a844a6a3d007de0c78092fafb1afe8a0825dad98eb91cc840c63b647a PASS
  Tests  32 passed (32)
```

两个 pinned 值与 `tests/unit/jitrl/p6-pareto-budget.test.ts:254/257` 在**改动前**固化的值逐字节相同 ⇒ 默认配置下 `BatchPlan` 与 `metadata.jit` 零变化。

> 说明：上一轮 captain 记录过一个临时 probe 的 digest `43248a70…` / 5004 B。那个 probe 测的是**整次 e2e run** 的摘要，与这里的**装饰器决策摘要**是两个不同夹具，**不可互相替代**。本报告只用后者，因为它是装饰器层面的判据；前者已随 probe 文件删除而作废（文件已删，见 §5）。

**开 / 关两态（`tests/unit/jitrl/p6-host-wiring.test.ts`）**

| 性质 | 断言 |
| --- | --- |
| 关则零对象 | `resolveBudgetHookConfig(undefined) === undefined`；`reminder.enabled` 缺省 ⇒ `enabled: false`，永不 `true`；sink 零调用；`budget.reminder` 键**不存在**——由 `hasOwnProperty(budget,'reminder') === false` 与 `JSON.stringify(budget)` 不含 `'reminder'` 双重断言（不是 `enabled:false` 的对象） |
| 默认配置零诊断键 | 默认构造下 `metadata.jit` **没有** `budget` 键：`hasOwnProperty(diagnostics,'budget') === false` 且 `JSON.stringify(diagnostics)` 不含 `'budget'` |
| 开则生效 | `tier:'lite'`（上限 2）配 4 槽计划 ⇒ 恰好 1 条 `BudgetReminder`，`unit:'probes'`，`observedProbes === plan.width` |
| 不超档不提醒 | `tier:'heavy'`（上限 8）配同一 4 槽计划 ⇒ 0 条 |
| 只 ask 不 deny | 开/关两态 `executionSurface(onPlan) === executionSurface(offPlan)` **逐字节相同** |
| sink 抛错不失败决策 | `onReminder` 抛错 ⇒ 计划仍正常产出 |
| 独立性（结构） | 四种 execution mode（`baseline`/`shadow`/`guarded-active`/`off`）下 `resolveBudgetHookConfig` 输出**完全相同** ⇒ 结构上不可能读 mode |
| 独立性（行为） | `guarded-active + applyWinningPatch:true` 但无 budget 叶 ⇒ 无提醒；有 budget 叶但 `applyWinningPatch:false` ⇒ 有提醒 |
| 配置校验负例 | 未知 tier ⇒ `invalid_enum`；`enabled:'yes'` ⇒ `invalid_type`；拼错键 `reminderr` ⇒ `unknown_key`；`budget:'on'` ⇒ `invalid_type` |

---

## 2. W2 `costObservations` 真实来源：**FAILED（未接线）**

> **判定口径（先读这条，避免误用）**：本项在 `agent_teams_update_task` 的 `acceptanceResults` 里被标为 **`status: "failed"`**，不是 "passed"、也不是 "部分完成"。
> 理由按复核者的机械判据：**(a) 公开导出面** —— `assembleMeasuredCostObservations` 已导出；**(b) `src/index.ts` 是否真的取用** —— **没有**，生产构造点刻意不传 `costObservations`。
> 有 (a) 无 (b) = **仍属"库层就绪、宿主不可达"**，与上一轮 W1 未接线时的状态同类。
> **下一个读者请注意：不要因为本函数已导出、已测试，就认为成本轴在生产中可用。它不可用。**

### 2.1 交付了什么

新增 `export function assembleMeasuredCostObservations(events, describe)`：把 P3 账本的 `UsageLedgerEvent[]` 组装成 `CostObservation[]`，**只在全部事件都是 measured 时**返回数组，否则返回 `undefined`（整轴不可用）。

四条 fail-closed 分支（都是 `return undefined`，**没有一条是 `continue`**）：

1. 事件集为空 ⇒ 轴不可用（空集无法做成本比较）；
2. **任何一条** `cost.provenance !== 'measured'` ⇒ **整轴**不可用（ADR 0007 §6.2：不剔点）；
3. 任何一条 `auditOnly` 或 `!qualityEvidence` ⇒ 整轴不可用；
4. `describe()` 返回 `undefined`，或 probes/quality 非有限/越界 ⇒ 整轴不可用（**不把缺失数据默认成 0**）。

### 2.2 为什么构造点**刻意不填数**（这是本项最重要的判断）

`src/index.ts` 的装饰器构造点**没有**把任何观测传进 `costObservations`。三个独立原因，任一条都足以否决：

1. **结构**：`BudgetHookConfig.costObservations` 是**构造期数组**。装饰器在 plugin mount 时构造一次，早于任何探针运行；即便读到活的 `ledgerManager.getLedgerEvents()`，捕获到的也只是**空快照**。要按决策取活视图，必须把该字段改成 provider 函数。
2. **写范围**：改那个字段要动 `src/jitrl/jit-active-policy.ts`，而它的字节被 `PINNED_DECORATOR_SHA256`（`tests/unit/jitrl/p6-pareto-budget.test.ts:865`）钉死为 P6 的可复现还原见证。为接线的便利去改它，等于**破坏一个已交付的 P6 交付物**。
3. **数据**：P3 账本记录**每次调用的成本**与一个 `qualityEvidence` **布尔**，但**没有任何质量数值**。`CostObservation` 需要 `(probes, quality)` 二元组，这一层**没有真实来源**。

所以轴保持 `unavailable`。这正是 ADR 0007 §6.2 要求的 fail-closed 结果——**一个伪造或 estimated 的观测，比一个诚实的"不可用"坏得多**。

> 这条与上一轮 `cacheRead` 的纪律同源：**宁可交付 `undefined` 也不填假数据。**

### 2.3 证据

```
命令: pnpm exec vitest run tests/unit/jitrl/p6-host-wiring.test.ts
退出码: 0
取样: 2026-10-30T00:25:10+08:00
Tests  32 passed (32)   # 其中 12 条属于本项
```

负例矩阵（全部断言 `undefined`，即整轴不可用）：

| 负例 | 构造 |
| --- | --- |
| 一条 estimated 使整轴不可用 | 2 条 measured + 1 条 estimated ⇒ `undefined`（**不是**返回那 2 条） |
| 一条 unknown 使整轴不可用 | 1 measured + 1 unknown ⇒ `undefined` |
| 空事件集 | `[]` ⇒ `undefined` |
| audit-only 事件 | `auditOnly:true` ⇒ `undefined` |
| 非质量证据事件 | `qualityEvidence:false` ⇒ `undefined` |
| 缺 (probes, quality) | `describe()` 返回 `undefined` ⇒ `undefined`（不默认成 0） |
| quality 越界 | `1.5` / `-0.1` ⇒ `undefined` |
| probes 非有限 | `NaN` ⇒ `undefined` |

正向用例：2 条真 measured 事件 ⇒ `evaluateBudgetGate` 报 `costAxisProvenance:'measured'`、`costAxisRejected:0`、前沿 `['b']`、被支配 `['a']`（`b` = 1 probe / 0.9 quality 在**两轴上都**严格优于 `a` = 4 / 0.2）。

> 记录一条自查：我最初把这条断言写成 `['a','b']`，测试红了。**是我的预期错，不是代码错**——`b` 确实严格支配 `a`。已改为 `['b']` / `['a']`，并在断言旁写明理由。

---

## 3. W3 授权账本接线：未执行（需裁定）

### 3.1 为什么做不到

`createProbeAuthorizationLedger().authorize()` 要"接到真实调用点"，需要在这五类动作的**每一个真实发生处**显式调用：`external-tool-call`、`memory-write`、`multi-step-probe`、`real-host-smoke`、`paid-model-call`（ADR 0006 §4.3）。

这些调用点分布在：

- `src/dsh-bridge/agent-loop-executor.ts`（工具执行 `:1391` 附近、模型调用）
- `src/orchestrator.ts`（`memory.isolate` `:3223`、`memory.promote` `:3419`、`runInIsolatedBranch` `:3233`）
- `src/dsh-bridge/metered-model-adapter.ts`

**均不在本任务写范围**（写范围只有 `src/index.ts`、`src/orchestrator.ts`、`src/config.ts`、`src/jitrl/jit-active-policy.ts`）。

其中 `src/orchestrator.ts` 虽在写范围内，但五类动作里 `external-tool-call` 与 `paid-model-call` 的**真实发生处**在 `dsh-bridge/**`；只在 orchestrator 接一半，会得到"部分路径受控、部分路径裸奔"的**伪安全**——比不接更危险，因为它会让审计者以为已经受控。

### 3.2 最小补丁草案（交下一轮）

1. 在 `buildOrchestratorDeps` 里创建 `const probeAuth = createProbeAuthorizationLedger({ now })`，作为新字段 `probeAuthorization` 挂到 `EvoHarnessOrchestratorDeps`（**可选**，缺席即不检查，保持默认零变化）。
2. 在 `src/orchestrator.ts` 三个调用点前插入 `authorize({ kind, branchId, sessionId })`，`allowed === false` 时按既有 fail-closed 路径记录诊断并跳过该动作（**不抛错**，避免改变默认失败语义）。
3. `src/dsh-bridge/**` 的两个调用点由下一个有该写范围的任务接。
4. 五类动作各一条"默认拒绝"用例（零 grant ⇒ `no-grant`；session-only grant 授权 branch ⇒ `session-cannot-authorize-branch`）。

### 3.3 现状为什么仍然安全

五类动作**当前都不发生**：本轮纪律明确禁止真实外部工具调用、真实记忆写入、真实宿主 smoke、真实付费模型调用。所以"未接线"不等于"已放行"——只是这条规则仍停留在**口头约定**而非**可失败关闭的代码**。这一点必须如实登记，不能算作已交付。

---

## 4. W4 工具面 allowlist 生产开关：未执行（需裁定）

### 4.1 为什么做不到

`src/index.ts:1766` 构造 `createCordisSeamManager({...})` 时**不传** `toolFace` / `toolAllowlist`，因此生产路径不下发 allowlist。

"默认不下发（保持现状）"这条验收项**当前已经满足**——它是既有事实，不需要我改动。但"生产开关"（哪个分支下发什么 allowlist）需要：

- 在 `CordisSeamManagerOptions` 增加策略来源；
- 在 `seam-manager.ts:315` 的 per-branch install 处按分支选择 allowlist；
- 决定策略从哪来（配置叶？host 注入？），这本身需要一次裁定。

`src/cordis-seams/**` 不在写范围。

### 4.2 最小补丁草案（交下一轮）

1. 在 `EvoHarnessPluginOptions` 增加可选 `toolAllowlist?: readonly string[]`（**会改变 26 键公开面**，需 ADR 0005 §3.1 同步，故必须裁定）。
2. `buildCordisSeamManager` 仅在传入时透传；缺席 ⇒ 现状。
3. 一条"缺席则 `policyFor()` 返回 `no-policy`（放行）"的用例 + 一条"传入则未列名工具被拒"的用例。

### 4.3 一条必须保留的风险提示

`no-policy` 是**放行**（`docs/reports/p4-c-toolface.md` §7.2-2 已登记）。工具面是**进程内协作围栏，不是沙箱**（`src/cordis-seams/tool-face.ts` 模块头明写）。任何把它当沙箱的表述都是错的。

---

## 5. 清理与过程纪律

| 项 | 处置 |
| --- | --- |
| `tests/unit/integration/host-wiring-baseline.probe.test.ts` | **已删除**（captain 列为 blocker：它被 vitest 收集、让 `check:docs` 计数漂移）。复核：`Test-Path` → `False` |
| `src/jitrl/jit-active-policy.ts` | **未改动**（mtime `2026-10-29 11:58:04`，早于本任务 23:20 开始时刻；其 +352 行属上一轮 P6 未提交改动） |
| `src/orchestrator.ts` | **未改动**（本任务无需要） |
| `README.md` | **未改动**（属 doc-sync 写范围） |
| `.agent-teams/`、`work/` 生产文件 | `.agent-teams/` 未触碰；`work/` 仅写负控制证据（见 §6） |

**改动文件清单（3 个，全部在写范围内）**：

```
 M src/config.ts
 M src/index.ts
?? tests/unit/jitrl/p6-host-wiring.test.ts
```

---

## 6. 负控制（按 `docs/NEGATIVE-CONTROL-RUNBOOK.md` 全程执行）

**目标**：`src/index.ts`；**slug** `a2a171449d86`（relpath SHA-256 前 12 位）
**变异**：把 `assembleMeasuredCostObservations` 的 fail-closed 分支 `if (event.cost.provenance !== 'measured') {` 改成 `if (false) {`
**snippet-sha256**：`90356ad7d56a8fd13b2cde1de694b82678448095598c9165379039061c86a814`

| 规则 | 要求 | 实测输出 |
| --- | --- | --- |
| 1 前置 | `git status --porcelain -- src/index.ts` | ` M src/index.ts` |
| 2 副本 | 三产物按目标隔离 | `work/neg-control.a2a171449d86.{keep-bak,red.log,h1}` |
| 3 变异生效 | 两检查 | `guard-removed: True`（检查 2 通过：目标串已消失） |
| 3.5 落盘红 | 先判退出码后写日志 | `mutant-went-red: True`，`red-log-bytes=8542`（最终树复跑值） |
| 4a 还原 | 分两次调用 | `restore-identical: True`，锚点已写 |
| 4b 验证 | 独立进程 | `hash-unchanged-since-restore: True` / `red-was-recorded: True` / `red-target-matches: True` / `red-snippet-matches: True` / **`evidence-valid: True`** |

**变异确实被抓到，且抓它的是正确的用例**（红日志摘录）：

```
❯ tests/unit/jitrl/p6-host-wiring.test.ts (32 tests | 3 failed)
 × NEGATIVE: ONE estimated observation collapses the WHOLE axis (not a filtered subset)
 × NEGATIVE: ONE unknown observation collapses the WHOLE axis
 × an unavailable axis reports costAxisProvenance unavailable and produces no pareto
 Tests  3 failed | 29 passed (32)
```

**只有 3 条 fail-closed 用例红，其余 29 条仍绿**——说明这 3 条真的在守那条 `return`，不是被别的机制顺带带红。

还原后复跑（独立调用，2026-10-30T00:26:13+08:00）：

```
命令: pnpm exec vitest run tests/unit/jitrl/p6-host-wiring.test.ts tests/unit/jitrl/p6-pareto-budget.test.ts
退出码: 0
Test Files  2 passed (2)
Tests  65 passed (65)
```

**交付物哈希核对**（防止"备份 == 还原的那份"但交付物已漂移，即 runbook §0 第 1 条）：

```
(Get-FileHash work/neg-control.a2a171449d86.keep-bak -Algorithm SHA256) -> 084af5a5b3b477d7f5c0bf1968f8ecec5e73b48d70b34fc201b62b5069492726
(Get-FileHash src/index.ts -Algorithm SHA256)                          -> 084af5a5b3b477d7f5c0bf1968f8ecec5e73b48d70b34fc201b62b5069492726
```

两者相同 ⇒ **交付物就是被还原的那份**，不是"还原后又编辑过"。

**变异空间自陈**：本轮只对一个目标（`src/index.ts`）、一处守卫（measured 判据）做了负控制。未覆盖：`reminder.enabled === true` 判据、`budget === undefined` 早退、`auditOnly`/`qualityEvidence` 分支。**这四项是【未知】而非【通过】**——没有负控制证据证明删掉它们会让测试变红。

---

## 7. 门禁实测

全部取样于 2026-10-30T00:26–00:31+08:00，命令与退出码原样记录。

| 门禁 | 命令 | 退出码 | 关键输出 |
| --- | --- | --- | --- |
| 类型 | `pnpm run typecheck` | **0** | `tsc 5.9.3`，无输出 |
| 编码 | `pnpm run check:encoding` | **0** | `SUCCESS: every tracked blob is LF text or an explicit -text exception` |
| 构建冒烟 | `pnpm run check:build-smoke` | **0** | `export-surface: 72 named exports`；`SUCCESS` |
| 负结果 | `pnpm run check:negative-result` | **0** | `A1..A6 PASS - the historical negative result is intact` |
| 变异 | `pnpm run check:mutation` | **0** | `verdict: PASS`；M1–M4 全部 `KILLED`；`worktree zero-residue: OK` |
| 文档 | `pnpm run check:docs` | **1** | **红，但原因只有 README 计数漂移**（见 §7.1） |
| 配置叶门 | `node scripts/verify-readme-counts.mjs --docs-only` | **0** | `78 documented row(s) vs 78 expected` + `OK` |
| 相关套件 | `pnpm exec vitest run tests/unit/config tests/unit/jitrl tests/unit/integration` | **0** | `Test Files 42 passed (42)` / `Tests 958 passed (958)`（该次取样在加入 2 条断言前；最终树为 32 用例，见 §9） |

### 7.1 `check:docs` 红的因果归属（改前改后各取样一次）

**改前基线**（`work/neg-control.docs-baseline.before.log`，1831 B）：

```
exit 1
  Summary test files mismatch: README has 127, Vitest has 129
  Summary passing tests mismatch: README has 2429, Vitest has 2461
  Config reference coverage: 78 documented row(s) vs 78 expected   <- 绿
```

**改后**：

```
exit 1
  Summary test files mismatch: README has 127, Vitest has 130
  Summary passing tests mismatch: README has 2429, Vitest has 2491
  Config reference coverage: 78 documented row(s) vs 78 expected   <- 仍绿
```

**结论**：两次的**失败条目集合完全相同**（都是 README 计数漂移），**配置叶门两次都是 78 vs 78 绿**。所以我的改动**没有引入配置侧新红**；计数侧的差额全部归因于我的两个文件操作（算式见 §7.2）。

### 7.2 测试计数差额的完整归因（+29 用例，文件净变化 0）

| 时点 | 来源 | Unit 文件 | Unit 用例 |
| --- | --- | --- | --- |
| 23:31 | auditor t1 读数 | 116 | 2294 |
| 00:27 | 本任务读数 | 116 | 2323 |

- **-1 用例 / -1 文件**：删除 `tests/unit/integration/host-wiring-baseline.probe.test.ts`（复核：`Test-Path` → `False`）
- **+30 用例 / +1 文件**：新增 `tests/unit/jitrl/p6-host-wiring.test.ts`（当时 30 条；captain 要求加强断言后增至 **32** 条，见 §9）

文件：`-1 + 1 = 0` ⇒ 116 → 116 ✓
用例：`2294 - 1 + 30 = 2323` ✓（与实测逐位相同；加强断言后最终树为 **2325**，差额 +2 来自同一文件）

两份报告**口径相同、互相自洽**，无第三方漂移。

### 7.3 公开导出面

`export-surface: 72 named exports`（改动前 70）。新增两个：`resolveBudgetHookConfig`、`assembleMeasuredCostObservations`。二者都**同时**满足复核者的两条机械判据：(a) 在 `import()` 产物里 `'X' in ns` 为真；(b) `src/index.ts` 内真的取用（`buildJitRlWiring` 调用前者）。

> 注意：`assembleMeasuredCostObservations` 满足 (a) 但在生产路径上**不被取用**（§2.2 解释了为何）。按复核者的严格判据，它属于"有导出无取用"——**W2 的正式判定是 `failed`（未接线），不是"部分完成"**。报告 §0 的表格与本节标题都按 `failed` 登记。

---

## 8. 明确未执行（需裁定 / 需授权）

| 项 | 状态 | 理由 | 需要什么 |
| --- | --- | --- | --- |
| 授权账本接真实调用点 | **未执行（需裁定）** | 真实调用点在 `dsh-bridge/**`，超写范围；只接一半会造成伪安全 | 扩展写范围到 `src/dsh-bridge/**`，或拆成独立任务 |
| 工具面 allowlist 生产开关 | **未执行（需裁定）** | 需改 `cordis-seams/**`；且"策略从哪来"本身需裁定；新增 option key 会破 26 键公开面 | ADR 0005 §3.1 同步 + 写范围扩展 |
| `costObservations` 活视图（= W2 未接线的根因） | **未执行（需裁定）** | 需把 `BudgetHookConfig.costObservations` 改成 provider 函数，会破坏 `PINNED_DECORATOR_SHA256`；且账本无质量数值 | 队长裁定是否允许动 P6 pinned 文件；裁定前 W2 保持 `failed` |
| 真实宿主 smoke | **未执行（需授权）** | 本轮纪律明令禁止 | 显式授权 |
| 真实付费模型调用 / 真实外部工具调用 / 真实记忆写入 | **未执行（需授权）** | 同上 | 显式授权 |

**没有为了凑齐四项而放宽任何 fail-closed 判据。** 相反，W2 的结论是"宁可交付 `undefined` 也不填假数据"。


---

## 9. 队长追加要求的逐条回应（证据形态）

队长在复核后追加了三条要求。逐条给出**可判定的答案**，不是措辞。

### 9.1 影子对照必须在正式测试内（非 probe）— 已满足

在 `tests/unit/jitrl/p6-host-wiring.test.ts` 的 `describe('default configuration: the decorator is byte-identical to the pre-wiring build')` 里，直接断言：

```ts
expect(slotsDigest).toBe(PINNED_SLOTS_DIGEST);        // a8c207ca…d16a1
expect(diagnosticsDigest).toBe(PINNED_DIAGNOSTICS_DIGEST); // f2c0737a…b647a
```

两条 pinned 值取自 `tests/unit/jitrl/p6-pareto-budget.test.ts:254/257`（**改动前**固化），并且测试同时 `console.log` 打印实际值与 PASS/FAIL，所以复核者既能看断言、也能看数字。默认配置路径由 `makeDecorator()` 覆盖（不传 `budget`），与生产默认路径同构。

### 9.2 「零 reminder 对象」必须是 `toBeUndefined` 级 — 已加强为三重断言

原先只有 `expect(budget?.reminder).toBeUndefined()`（第 322 行）。按队长要求，现补为三层，**任何一层单独成立都不够**：

| 层 | 断言 | 防的是什么 |
| --- | --- | --- |
| L1 | `resolveBudgetHookConfig(undefined) === undefined` 且 `not.toEqual({})` | 空对象会被传进装饰器并**触发** gate（`{}` 也是"存在"） |
| L2 | `hasOwnProperty(budget, 'reminder') === false` + `JSON.stringify(budget)` 不含 `'reminder'` | "产生一个 `enabled:false` 的对象再被下游忽略"这种伪关闭 |
| L3 | 默认构造下 `hasOwnProperty(diagnostics,'budget') === false` + `JSON.stringify(diagnostics)` 不含 `'budget'` | 默认配置下 `metadata.jit` **根本没有** `budget` 键 |

L3 是"关闭时零对象"最字面的形式：不是空对象、不是 `enabled:false` 的对象，而是**键不存在**，`JSON.stringify` 会整键丢弃。

用例数因此从 30 → **32**。

### 9.3 改动前后 `check:docs` 的 mismatch 条目比对 — 条目集合相同

| | 改前（`work/neg-control.docs-baseline.before.log`） | 改后 |
| --- | --- | --- |
| 退出码 | 1 | 1 |
| 失败条目种类 | README 计数漂移（6 条） | README 计数漂移（6 条） |
| Summary 文件 | README 127 / Vitest 129 | README 127 / Vitest 130 |
| Summary 用例 | README 2429 / Vitest 2461 | README 2429 / Vitest 2491 |
| 配置叶门 | **78 vs 78 绿** | **78 vs 78 绿** |

**失败条目集合完全相同**（都是同一组 README 计数漂移），**配置叶门两次都是绿**。数值差额全部归因于我的两个文件操作（§7.2 的算式）。⇒ **没有引入新的失败类别**。

### 9.4 关于 `tests/unit/jitrl/p6-pareto-budget.test.ts`

**未重建、未修改。** 证据：

```
Get-Item tests/unit/jitrl/p6-pareto-budget.test.ts | Select LastWriteTime
  -> 2026/10/29 12:35:17     (本任务 23:20 开始，早 10h45m)
Length -> 36099
```

它以 `??` 出现在 `git status` 里，是因为上一轮 P6 交付**整轮未提交**（本仓惯例：整轮不 commit），不是因为我动过它。它内部的两条 pinned sha256 见证（`PINNED_DECORATOR_SHA256` / `PINNED_ADR_SHA256`）在本任务全程保持通过（`Tests 33 passed`）。

同理，`src/jitrl/jit-active-policy.ts` 的 +352 行也是上一轮未提交改动（mtime `2026-10-29 11:58:04`），**本任务未触碰**。

### 9.5 最终树复跑的负控制

加强断言后我**重做了整轮负控制**（不是复用旧日志），因为测试文件变了：

- slug 相同（目标仍是 `src/index.ts`），snippet-sha256 相同（守卫未变）
- `guard-removed: True` / `mutant-went-red: True` / `red-log-bytes=8542`
- 被杀死的仍是**同样 3 条** fail-closed 用例，其余 **29 条仍绿**（`Tests 3 failed | 29 passed (32)`）
- `restore-identical: True`；4b 独立进程：`evidence-valid: True`
- 最终哈希：备份 = 交付物 = `084af5a5b3b477d7f5c0bf1968f8ecec5e73b48d70b34fc201b62b5069492726`

---

## 10. 复核者如何一条命令重跑

```powershell
# 影子对照 + 开/关两态 + 成本轴负例（32 用例，含两条 pinned digest）
pnpm exec vitest run tests/unit/jitrl/p6-host-wiring.test.ts

# P6 原始交付未被破坏（33 用例，含 decorator 源码 sha256 见证）
pnpm exec vitest run tests/unit/jitrl/p6-pareto-budget.test.ts

# 配置叶计数仍 78（我的改动没有引入默认叶）
node scripts/verify-readme-counts.mjs --docs-only

# 负控制证据（4b 独立进程校验，应打印 evidence-valid: True）
& work/neg-control.rule4b.ps1
```
