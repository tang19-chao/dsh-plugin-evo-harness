# PR2 评审（第 2 轮）— t21 修复后的 dreamJit 面与 off 全链路复评

| 项 | 值 |
| :-- | :-- |
| 被评任务 | t21「repair-round-2（修 t10 的 F1：dreamJit 无消费点）」 |
| 评审任务 | t22（attempt `0333a39b-c98c-424c-a1e7-8b689bf46faa`） |
| 评审人 | gate-reviewer |
| 被评字节（结论绑定） | `src/index.ts` **34194918**（21:56:10）、`src/jitrl/runtime-control.ts` **2a5aebce**、`tests/unit/jitrl/runtime-control.test.ts` **2fc34a34**、`src/orchestrator.ts` **ff67ea0b**、`src/dream-rsi/offline-dreamer.ts` **adb2015b**、`tests/e2e/jit-control.test.ts` **25d5f1d6**（sha256 前 8 位，评审后复核未变） |
| 环境 | `7307d7d` + 共享工作树；Node `v22.23.1` |
| 结论 | **pass** — 上一轮 F1（dreamJit 只有常量、off 下 Jit 重放仍跑）已真实关闭；off 全链路与 configured/runtimeEnabled 分离无回退；红证据成立 |

方法：只读代码 + 评审人自写探针（生产插件入口）；红证据在 `%TEMP%` 克隆内做变异。除 `docs/reports/` 外未改仓库文件。

---

## 1. F1 关闭验证：`dreamJit` 现在有真实消费点

**静态**：全仓 `'dreamJit'` 出现三处 —— 常量 `runtime-control.ts:45`，以及两个**生产消费点**：
- `index.ts:1280` `return runtimeControl.isEnabled('dreamJit');`（`DreamReplayRecorder.hookAttached` getter，状态页读的就是它）
- `index.ts:1519` `isJitRuntimeEnabled: () => jitWiring.wiring.runtimeControl.isEnabled('dreamJit')`（注入 `createJitWiredDreamer`）

**运行时（我自跑，`dreamEveryNTasks:1`，走 `plugin.run`）**：

```
[7a] dream ON  triggered=true reports=1 state={"hookAttached":true,"lastReplay":{"hookCalls":24,"candidates":4}}
[7b] dream OFF triggered=true reports=2 state={"hookAttached":false,"lastReplay":{"hookCalls":0,"candidates":0}}
     dStore=0 offDiagnostic=true
[7c] dream ON  triggered=true reports=3 state={"hookAttached":true,"lastReplay":{"hookCalls":48,"candidates":4}}
```

- off 后 **重放钩子 0 次调用、候选列表为空、`hookAttached=false`**，且诊断明确写明 "the dreamJit runtime surface is off; …"（不是把"重放无数据"当作正常）。
- **基础 Dream-RSI 未被关闭**：off 期间 `dreamTriggered=true` 且 `dreamReports` 1→2 → 梦循环照常运行（方案 §4 R1 明确要求），这正是上一轮担心的"别把基础能力一起关掉"的边界。

## 2. F1 的另一半：Jit 超参热替换被单独钉住

- 代码：off 分支不传 `jitHook`（走 `offline-dreamer` 的 `hook === undefined` legacy 分支，不参与 `orderFrontierWithJitHook` 排序），并把 `applyPolicy` 覆写为 `withoutJitPerturbation(policy, holder?.policy?.jit)`（`index.ts:1139-1151`，helper 在 `:1002-1012`：incumbent 有 `jit` 块则钉回，否则整字段丢弃）；`appliedJit` 在 off 时强制 `undefined`（`:1162`）。
- 作者新增的专用测试（`runtime-control.test.ts:318-421`）**不是空断言**：先断言 `report.improved === true`（宽浅 baseline `maxWidth 4/maxDepth 1` vs 窄深 candidate `maxWidth 1/maxDepth 4`、candidate `jit.beta=2`），再断言 `swapped.maxDepth === 4`（基础策略确实换入）**且** `swapped.jit?.beta === 1`（钉回 incumbent 的 1/0.05）。
- 我的独立佐证（见 §5 变异）：把 gate 回退后该测试立刻失败为 `expected 2 to be 1`，说明"扰动确实会泄漏进在线策略"是真实风险，钉住逻辑与断言都有效。

## 3. off 全链路复评（无回退）

同一探针（`candidateCount=3` + 假 mirror + 3 候选 proposer）：

```
[1] ON  stages=["jit_meta_adjust","jit_proposal_select","evaluate_steps","record_experience"] dCandidates=2 storeSize=4 mirrorCallTool=4
[2] off json={"enabled":false,"persisted":false} runtime={"configured":true,"runtimeEnabled":false,"generation":2}
    plugin.jitrl.enabled=true  hostAdvisor.runtimeEnabled=false
[3] OFF outcome=composed failure=undefined probesRun=2 stages=[] dCandidates=0 dStore=0 dMirrorCallTool=0
[4] ON again stages=[四阶段全部回来] dCandidates=1 dStore=2 runtime={"configured":true,"runtimeEnabled":true,"generation":3}
[5] dispose 后 runtimeEnabled=false generation=4；jit on 被拒 {"enabled":false}
[6] 执行中 off：candidates=1、仅 jit_meta_adjust（翻闸前已发生）、storeSize=0、diagnostic flagged=true
```

与第 1 轮（t10）我记录的数字逐项一致，未见修复带来的回退；`configured`（`plugin.jitrl.enabled=true`）与 `runtimeEnabled=false` 仍严格分离（[2]）。

## 4. 消费点与禁止项

- 七个面的生产消费点全部读同一个控制：`hostRecord`（`index.ts:1826/1828`）、`advisor`（`:1839`）、`mirror`（`:1956/1961`，调用后端前再读一次）、`dreamJit`（`:1280/1519`）、状态面 `runtime`/`hostAdvisor.runtimeEnabled`（`:1260/1884/1907/1918`）、命令控制器（`:2025`）；orchestrator 侧 `surfaceEnabled('onlineRecord')` ×3、`surfaceEnabled('proposal')` ×2、generation 重读（`orchestrator.ts:1796/1849/1990/2116/2156`）。未发现由 `kernel.config.enabled` 决定运行时开关的路径。
- 未新增用户可关 invariant 隔离的生产开关：修复只新增工厂内部可选参数 `isJitRuntimeEnabled`（缺省=旧行为）并消费既有控制；`config.ts`/`contracts.ts` 无新增开关（grep `dreamJit|invariantIsolation|disableInvariant` 仅命中既有接口名 `DreamJitDiagnostics`）。

## 5. 红证据（回退修复必须变红）

克隆 `7307d7d` 并覆盖当前工作树 `src/tests/scripts`（克隆内 `index.ts` sha 与仓库一致 = 34194918），在克隆内把 gate 回退成恒真（`jitRuntimeOn` 的 `return check() === true;` → `return true;`，sha 90b671b6），跑作者的新测试：

```
 × F1 (dreamJit): off: the dream still triggers and reports, but no Jit replay happens
   → expected 36 to be +0
 × F1 (dreamJit): off: a winning replay still updates the basic policy but cannot install Jit perturbation
   → expected 2 to be 1
 Test Files 1 failed (1)   Tests 2 failed | 18 passed (20)   MUTATION_EXIT=1
```

当前字节同一文件：**20 passed**；连同 `tests/e2e/jit-control.test.ts`(5) 共 **25 passed，退出码 0**。回退后失败的正是两条 F1 断言（钩子调用数 36≠0、扰动 beta 2≠1），判别力成立。

> 交叉印证：t21 自己在团队记忆里记录的"仅回退 hook 门控"矩阵给出**相同的失败值**（`expected 36 to be +0`、`expected 2 to be 1`），与我的独立变异运行逐值一致；其"仅回退 jit 钉住（保留 hook 门控）"为 1 failed，说明两条断言覆盖面不同、互不替代。

## 6. 验收清单

| 验收项 | 结果 | 证据 |
| :-- | :-- | :-- |
| 复核控制接口与所有消费点，无 `kernel.config.enabled` 运行时路径 | **passed** | §4（七面消费点列表；orchestrator 三处/两处 + generation 重读） |
| 自跑 off：无 jit_meta_adjust/evaluate_steps/record_experience、proposeCandidates 未调用、storeSize 增量 0、mirror 调用 0 | **passed** | §3 [3]：`stages=[] dCandidates=0 dStore=0 dMirrorCallTool=0`，`outcome=composed` |
| configured 与 runtimeEnabled 分开 | **passed** | §3 [2]：`runtime={configured:true,runtimeEnabled:false}` 与 `plugin.jitrl.enabled=true` 并存；状态/命令面读控制 |
| off 未连带关闭 Harness²/基础 Dream-RSI，普通任务仍完成 | **passed** | §1 [7b]：off 下 `dreamTriggered=true`、`dreamReports` +1、`dStore=0`；§3 [3] composed/probesRun=2 |
| 回归测试在回退修复后会失败（红证据） | **passed** | §5：变异后 2 failed | 18 passed（exit 1），失败点即两条 F1 断言 |
| 未新增用户可关 invariant 隔离的生产开关 | **passed** | §4（仅内部可选参数 + 消费既有控制；config/contracts 无新增开关） |
| （补充）上一轮 F1：`dreamJit` 必须有真实消费且 off 停 Jit 重放/热替换 | **passed** | §1、§2：消费点 2 处；off 时 hookCalls=0/candidates=0/hookAttached=false/appliedJit=undefined，热替换被钉回 |

## 7. 观察与边界

- 我的夹具里 incumbent 无 `jit` 块（`policyJit=undefined`），因此我实测走的是 `withoutJitPerturbation` 的"整字段丢弃"分支；"incumbent 有 jit 块则钉回原值"分支由作者测试覆盖（断言 beta 1/0.05），并用我的变异测试证明该断言非空转。
- 未跑全量 `pnpm test`/`typecheck`/`build`（共享工作树含其他 PR 在途改动，无法归因）；本轮定向跑 25 用例 + 自写探针。
- 未接真实 DSH 宿主/真实模型；`stepEvaluator`、轨迹与梦境均为脚本夹具（Gate 4 范围）。
- 评审后复核：`index.ts`=34194918、`runtime-control.test.ts`=2fc34a34 未再变动。未修改仓库 `src/**`、`tests/**`、`scripts/**`；探针、克隆与临时 junction 已清理。
