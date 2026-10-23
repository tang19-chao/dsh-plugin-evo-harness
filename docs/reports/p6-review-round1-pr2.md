# PR2（R1）独立评审报告 — Gate 1 第 1 轮

| 项 | 值 |
| :-- | :-- |
| 被评任务 | t1「PR2 / R1：统一 RuntimeControl，让 jit off 覆盖全部 JitRL 面」 |
| 评审任务 | t10（attempt `c85a499b-714b-4bf5-96f7-5d3cc741cc4f`） |
| 评审人 | gate-reviewer |
| 评审对象 | commit `7307d7d` + 共享工作树未提交改动；Node `v22.23.1` |
| 结论 | **needs_revision**：六个面（meta/proposal/advisor/onlineRecord/hostRecord/mirror）的 off 语义经评审人自跑确认真实生效；**第七个面 `dreamJit` 只有常量、没有消费点**，实测 `jit off` 下离线 Jit 重放仍在跑并参与梦境前沿排序，且热替换路径未受控。 |

方法：只读代码 + 评审人自行构造并运行 off 场景。除 `docs/reports/` 外未改仓库文件；探针写在 `node_modules/.cache/review-t10/`（gitignored，评审后已删）。

---

## 1. 评审人自跑的 off 场景（当前树，真实数据）

探针：esbuild 打包 `tests/e2e/fixtures.buildE2E` + 自写 3 候选 proposer + 计数用假 mirror，走真实插件入口 `plugin.run` / `plugin.runFromCommand('jit off')`。

```
[1] ON   outcome=composed stages=["jit_meta_adjust","jit_proposal_select","evaluate_steps","record_experience"]
         candidates=2 storeSize=4 mirrorCallTool=4
[2] off  cmd json={"enabled":false,"persisted":false}
         runtime={"configured":true,"runtimeEnabled":false,"generation":2}
         plugin.jitrl.enabled=true   hostAdvisor.runtimeEnabled=false
[3] OFF  outcome=composed failure=undefined probesRun=2 stages=[]
         dCandidates=0 dPropose=1 dStore=0 dMirrorCallTool=0 diagnosticsHasLifecycleFailed=false
         OFF trace: initialize > recall > plan_grid > reference_probe > select_batch > propose > probe >
                    classify > score > compose > reflect > commit > apply_patch > finalize
[4] ON again json={"enabled":true,"persisted":false} outcome=composed
         stages=[四个阶段全部回来] dCandidates=1 dStore=2 dMirrorCallTool=4
         runtime={"configured":true,"runtimeEnabled":true,"generation":3}
[5] dispose 后 runtime={"configured":true,"runtimeEnabled":false,"generation":4}
         jit on json={"enabled":false,"persisted":false}   ← 无法复活
[6] 执行中 off（在 proposeCandidates 内部翻闸）outcome=composed candidates=1
         stages=["jit_meta_adjust"]（该阶段在翻闸前已完成）storeSize=0 runtimeEnabled=false
[7] off 下触发梦境 dreamTriggered=true dreamReports=1
         lastReplay={"hookCalls":24,"improved":false,...} dStore=0 traceHasOfflineDream=true
```

对照方案 §4 R1 的验收：**off 后无 jit 调整阶段、无 K 候选调用、经验增量 0、镜像后端调用 0、普通进化仍完成**——全部满足（[3]）。[6] 说明"执行中关闭"的边界正确：已发出的模型调用不撤销（candidates=1），但其结果不发布（无 proposal_select/evaluate/record，storeSize=0）。[5] 说明 dispose 是永久关闭。

[7] 是**本轮唯一的失败点**，见 §5。

---

## 2. configured 与 runtimeEnabled 分离

- `plugin.jitrl.enabled === true`（configured 语义，来自 `kernel.config.levels`）而 `plugin.jitrl.runtime.runtimeEnabled === false`（[2]），两者未混用；`EvoHarnessJitRlStatus.runtime` 是控制器的实时快照（`src/index.ts:1743,1777`）。
- `jit status` 文本走命令控制器的 `controller.isEnabled()`（`src/jitrl/commands.ts:174`）而非 `plugin.jitrl.enabled`；`hostAdvisor.runtimeEnabled` 读同一控制器的 `'advisor'` 面（`src/index.ts:1766`；`src/index.ts:1731` 的无内核分支硬编码 false，语义正确）。
- `runtime-control.ts:106-119` 的语义与单元测试一致：`configured=false` 时 `setEnabled(true)` 不生效且 generation 不动（`tests/unit/jitrl/runtime-control.test.ts:43-50`）。
- L1 装饰器读的是一个 legacy 镜像对象（`src/index.ts:1144-1151` 的 `runtimeEnabled.enabled`），但该对象**只有一个写者**：命令控制器 `setEnabled`（`src/index.ts:1889-1891`）+ dispose（`:2260-2261`）；`runtimeControl.setEnabled` 在全仓也只有 `:1889` 一个调用点，未发现第二条改状态路径（无漂移）。

## 3. 消费点复核（是否存在仍由 `kernel.config.enabled` 决定运行时开关的路径）

- `src/orchestrator.ts:1688`（evaluate/record 前置）与 `:1909`（selectProposal 前置）读 `kernel.config.enabled`——但它们是 **configured 前置**，紧随其后的 `surfaceEnabled('onlineRecord')`（`:1694,1724,1798`）与 `surfaceEnabled('proposal')`（`:1915,1955`）才是运行时判定；`surfaceEnabled` 走注入的 `deps.jitRuntime`（`:1577-1587`），异常时 fail-closed。
- 插件入口的编排器一定注入控制器（`src/index.ts:1415 jitRuntime: jitWiring.wiring.runtimeControl`）；`surfaceEnabled` 在**未注入**控制器的旧式手搓编排器上返回 true（`:1579-1581`），这是为保持既有单测语义的显式回落，插件路径不受影响。
- 其余面：`hostRecord`（`src/index.ts:1685,1687`）、`advisor`（`:1698`）、`mirror`（`:1815` 与调用后端前 `:1820` 各读一次）均走 `runtimeControl.isEnabled(...)`。
- `off→on`、`执行中 off`、`卸载`、`自动回退入口`：前三条已实测（[3][4][6][5]）；自动回退走同一条 `plugin.run` 路径（`src/index.ts:2023` 的 `trigger:'auto_fallback'` 复用同一编排器），未见独立开关。

## 4. 红证据（评审人自行回退验证）

`git clone --no-local --depth 1` → `CLONE_HEAD=7307d7d`（`Select-String` 确认克隆的 `src/orchestrator.ts` 中 `jitRuntime|surfaceEnabled` 命中数 = 0），把新 e2e 测试拷入克隆后运行：

```
 ❯ tests/e2e/jit-control.test.ts (5 tests | 5 failed)
   × stops L1/L2 decisions, scoring, recording and mirroring while evolution still completes
   × reports status from the volatile switch, not from configured availability
   × discards the K candidates returned by a proposal that finished after off
   × discards step rewards evaluated after off instead of appending them
   × dispose is a permanent off
   AssertionError: expected 2 to be 1 / expected [ 'initialize', 'recall', …(21) ] to not include 'record_experience'
 Test Files  1 failed (1)   Tests  5 failed (5)   REVERT_TEST_EXIT=1
```

同一克隆上跑**同一份探针**（用克隆自己的 src，源已确认为 pre-fix）复现方案附录 A 的泄漏签名：

```
[3] OFF stages=["jit_proposal_select","evaluate_steps","record_experience"]   ← 仍在跑
    dCandidates=1 dStore=2 mirrorCallTool=0
    OFF trace: ... propose > jit_proposal_select > probe > ... > evaluate_steps > record_experience > commit ...
[5] dispose 后 jit on json={"enabled":true}      ← 无永久关闭
[6] 执行中 off：四个阶段全在、storeSize=4        ← 无在途丢弃
```

即：**修复前 off 泄漏 L2 选择/评分/记录，修复后同一探针全部为 0**，判别力成立。备注：方案附录 A 记录的量级是「K 候选调用=2 / 经验增量=4」，我这次单轮 off 运行为「1 / 2」——量级随该次运行的候选轮数变化，泄漏**签名**一致（stages 非空 + storeSize 增长 + dispose 可复活）。

---

## 5. 阻塞发现：`dreamJit` 只是常量，没有消费点

**静态证据**：全仓 grep `'dreamJit'` 只命中 `src/jitrl/runtime-control.ts:45`（`JIT_SURFACES` 声明）。没有任何 `isEnabled('dreamJit')`；`OrchestratorImpl.runDream`（`src/orchestrator.ts:2225-2263`）没有任何运行时检查；`createJitWiredDreamer`（`src/index.ts:1008-1069`）每次 replay 都无条件注入 `jitHook`（`:1037-1043`，`hookAttached: true` 在 `:1009`/`:1161-1162` 写死）。

**实测证据**（当前树，`jit off` 之后触发一次梦境）：`lastReplay.hookCalls=24`、`traceHasOfflineDream=true`、`improved=false`（本次无热替换）。

**影响链（代码已确认）**：
1. 重放钩子不是纯观测——它的返回值**直接参与梦境前沿排序**：`src/dream-rsi/offline-dreamer.ts:723-727` 用 `call.weights` 计算 `frontierPriority(...)` 并写回 `lastWeights`。也就是说 `jit off` 期间，离线梦境仍被 JitRL 检索权重引导。
2. 热替换路径未受控：`offline-dreamer.ts:1604-1605` 在 `improved` 时 `await this.applyPolicy(bestCandidate.policy)`，而候选策略携带 Jit 扰动网格（`src/index.ts:989-996` 的 `jitGrid`，`hyperparamPerturbation: true`）产生的 beta/lambda（[7] 的 candidates 里可见 `beta 0.5/1/2`）。本次运行 `improved=false` 所以未观察到实际写入，但代码路径无任何开关。
3. 方案 §4 R1 的修复方向明确写着："离线 Jit 重放和热替换也必须明确受哪个开关管理"；当前答案是"没有任何开关管"。作者任务摘要声称"覆盖 meta/proposal/advisor/onlineRecord/hostRecord/mirror/**dreamJit** 七面"，这一面不成立。

**注意边界**：这不违反方案 §4 R1 验收里列出的四条（无 Jit 决策阶段、无 K 候选、无新经验、无镜像），实测 `dStore=0`；所以它不是"经验/镜像泄漏"，而是"整条链路覆盖"与"七面"声明的缺口。修复时也不能把整个梦境关掉——方案同句要求"关闭 Jit 不应顺带关闭基础 Dream-RSI"。

---

## 6. 验收清单逐项

| 验收项 | 结果 | 证据 |
| :-- | :-- | :-- |
| 复核控制接口与全部消费点，确认无仍由 `kernel.config.enabled` 决定运行时开关的路径 | **passed**（六个已接线面） | §3；`orchestrator.ts:1688/1909` 仅为 configured 前置，运行时判定在 `:1694/1724/1798/1915/1955` |
| 自跑 off 场景：无 jit 阶段、proposeCandidates 未调用、storeSize 增量 0、mirror 调用 0 | **passed** | §1 [3]：`stages=[]`、`dCandidates=0`、`dStore=0`、`dMirrorCallTool=0`，`outcome=composed` |
| configured 与 runtimeEnabled 分开，未把 `plugin.jitrl.enabled` 当 volatile | **passed** | §2；[2] `configured=true` 与 `runtimeEnabled=false` 并存 |
| off 未连带关闭 Harness²/基础 Dream-RSI，普通任务仍能完成 | **passed** | [3] `composed`/`probesRun=2`/单候选 `propose` 仍被调用；[7] `dreamTriggered=true`、`dreamReports=1` |
| 回归测试回退修复后必红 | **passed** | §4：克隆 `7307d7d` 上 5/5 失败；同探针复现泄漏签名 |
| 未新增用户可关 invariant 隔离的生产开关 | **passed** | PR2 只加"整条 Jit 的运行时开关"（`runtime-control.ts`），未触碰 invariant 隔离；无 L4/新记忆后端；`§12` 禁止项未被触及 |
| （补充）"七面覆盖"是否成立 | **failed** | §5：`dreamJit` 无消费点，off 下重放钩子仍 24 次调用并引导前沿排序 |

---

## 7. 可执行修复项

**F1 / high — 把 `dreamJit` 面真正接上（或明确降级声明）**
位置：`src/index.ts:1008-1069`（`createJitWiredDreamer`）、`src/orchestrator.ts:2225-2263`（`runDream`）。
修法：把运行时判定传进梦境包装器（例如 `isJitRuntimeEnabled: () => runtimeControl.isEnabled('dreamJit')`），在每次 replay 时：`jit off` → **不注入 `jitHook`**（走 `offline-dreamer` 的无钩子 legacy 形态，`offline-dreamer.ts:329,807` 已支持 `jitHook === undefined`），并且**不把 Jit 扰动网格生成的候选策略热替换进在线策略**（跳过 `applyPolicy`，或只应用保留当前 `jit` 块的策略）。**基础 Dream-RSI 必须继续运行**（仍在 `dreamEveryNTasks` 触发、仍产生 `dreamReports`），因为方案要求 off 不连带关闭基础 Dream-RSI。
验收测试：`jit off` 后触发梦境 → `plugin.jitrl.dream.lastReplay.hookCalls === 0`（或 `hookAttached` 为 false）+ `dreamReports().length === 1` + `dreamTriggered === true`；`jit on` 后 `hookCalls > 0`。若选择"不接开关、只改声明"的路线，则必须在 `runtime-control.ts:38-46` 与状态面删除/改写 `dreamJit`，并说明离线重放由哪个开关管理——方案 §4 R1 不允许"不受任何开关管理"。

**F2 / medium — 补"消费点"测试，别只钉常量**
`tests/unit/jitrl/runtime-control.test.ts:71-84` 只遍历 `JIT_SURFACES` 断言同一个布尔；它无法发现某个面没有消费者（本轮就是这么漏掉的）。要求：对每个面至少一条"该面被生产路径读取"的行为测试（F1 的梦境用例即 `dreamJit` 的那一条）。

**观察项（无动作）**：L1 装饰器读的 legacy 镜像对象是第二份状态，但写者唯一且 dispose 同步；`surfaceEnabled` 在未注入控制器时返回 true 是显式的旧行为回落，插件路径始终注入。两者都不构成本轮问题。

---

## 8. 边界声明

- 未跑全量 `pnpm test`/`typecheck`/`build`（共享工作树含其他 PR 未提交改动，无法归因）；本次定向跑了 `tests/e2e/jit-control.test.ts` + `tests/unit/jitrl/runtime-control.test.ts`（当前树 18 用例全绿，退出码 0）。
- 探针使用仓库 e2e 夹具与假 mirror/MCP 客户端，未接真实 DSH 宿主或真实 MCP 后端（属 Gate 4）；"没有 Jit 决策/经验/镜像"的结论限于该夹具可观测面。
- 未修改 `src/**`、`tests/**`、`scripts/**`；探针、克隆与临时 junction 已清理，仓库 `node_modules` 完整性已复核。
