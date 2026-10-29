# P3-C 集成尾巴 A：两阶段结算与迟到 usage 接线（t2，attempt 1）

> 本报告只覆盖 t2 的授权写入范围：
> `src/ledger/two-phase.ts`（新建，接线所需导出）、`src/ledger/index.ts`（导出一行）、
> `src/dsh-bridge/agent-loop-executor.ts`、`src/dsh-bridge/metered-model-adapter.ts`、
> `tests/unit/ledger/p3c-two-phase-wiring.test.ts`（新建）、
> `tests/unit/dsh-bridge/p3c-two-phase-bridge.test.ts`（新建）。
> 未触碰：`src/index.ts`、`src/orchestrator.ts`、`src/config.ts`、CI 门禁脚本、`README.md`（见 §6.3）、
> 任何既有报告（含 `docs/reports/p3-c-usage.md`，见 §9 末条）、`package.json`、`.agent-teams/`、`node_modules/`。

## 1. 目标

把 P3-C（t6）已实现但**未接生产**的两阶段结算真正接到生产消费方：
`settle({interim:true})` + `reconcileLateUsage` 必须由真实的模型调用路径使用，
而不是只被 ledger 单测覆盖。

依据（已读）：`docs/reports/p3-c-usage.md` §7.1（缺口登记 + 4 条接线契约）、
`src/ledger/reservation-manager.ts`（reserve / settle / settleInterim / reconcileLateUsage / recoverFromWal）、
`src/ledger/wal.ts`、`src/ledger/reconciliation.ts`、`src/ledger/assembly.ts`。

## 2. 改动前的缺口（复核确认）

复核 §7.1 的登记，逐条在代码中确认（不是照抄报告）：

| 缺口 | 复核结论 |
| --- | --- |
| 消费方一步式结算，无 interim | 确认。`agent-loop-executor.ts` 5 处 `ledgerManager.settle({outcome, usage})`；`metered-model-adapter.ts` 2 处。全部 `interim` 缺省=false |
| 无"迟到 usage"入口 | 确认。两个文件都没有任何调用 `reconcileLateUsage` 的路径；ledger 侧的 `callToReservation` 只活在进程内存里（`recoverFromWal` 才会重建），且结算后即删除 |
| 取消/超时未区分"远端是否已停" | 确认。取消/超时用 `outcome: 'cancelled'/'timed_out'` 走**final** settle，等于宣称远端已终止（与 ADR-0004 §5.1 相反）；座位虽因 `isRemoteTerminationConfirmed` 被保留，但金额已记账，迟到 usage 只能靠"再次 settle 同一 callId"（replay，不调整金额）或新开 callId（重复记账） |
| 路径乙（跨 callId 重复记账）无防线 | 确认。ledger 无法区分"两个 callId"与"两次调用"；没有任何宿主侧入口按原 callId 归并 |

## 3. 设计

### 3.1 持久化 `callId -> reservationId`：`LedgerCallIndex`（`src/ledger/index.ts` 已导出）

- 落盘位置：与 WAL 同目录的 `ledger.calls.jsonl`（append-only JSONL）；目录可由 `storageDir` 显式给出，
  或**从 manager 的 WAL 路径推导**（`ledgerStorageDirOf`），所以"预建 manager 注入"这条老路径也能持久化。
- 每条记录 = 一个生命周期事件（`reserve` / `interim` / `final` / `reconcile` / `new-attempt`），
  `load()` 重放出每个 callId 的最新身份。写盘后 `fsync`（与 `LedgerWalWriter.append` 同样的 Windows `openSync('a')` 处理）。
- 身份除了 `callId/reservationId` 还固化 **reserve 时刻的 rate card**：final settle 之后 manager 已删除
  reservation 记录，若不持久化卡，迟到 usage 会被今天的默认卡重新定价（违反 ADR-0004 §8.1 时间冻结）。
- 进程内保留上限 `DEFAULT_MAX_RETAINED_CALLS=4096`，**只淘汰已终结（settled/reconciled）的身份**，
  in-flight（reserved/interim）永不淘汰；淘汰数通过 `evicted` 可见（不静默）。
- 与 WAL 相同的合规守卫：禁止写入 `.agent-teams`（`INDEX_STORAGE_FORBIDDEN`）。
- 两个消费方共享同一个协调器（`twoPhaseSettlementFor`，按 manager 的 WeakMap 单例）；
  若同一 manager 被要求第二个不同目录 → `INDEX_CONFIG_CONFLICT`（不静默取一个）。

### 3.2 `TwoPhaseSettlement`：唯一被允许的调用生命周期

`beginCall` → `settleCall` → `reconcileLateUsage`（或显式 `bookNewAttempt`）。

**interim/final 的选择由 outcome 在协调器内部决定**：

```ts
settleCall(request) {                                              // src/ledger/two-phase.ts:623
  const interim = !isRemoteTerminationConfirmed(request.outcome);  // :632
  const result = this.manager.settle({ ...request, interim });     // :633-636（interim 写在 spread 之后）
  ...
}
```

即取消 / 超时 / 本地中止 / 流中断 / 基础设施错误 → interim（钱与座位都留着，等对账）；
只有能证明远端已终止的结果才 final。`requiresInterimSettlement(outcome)` 把这条线导出并被测试逐一钉死。

**这条保证的精确边界（不含糊其辞）**：

| 层面 | 是否成立 | 依据 |
| --- | --- | --- |
| 通过 `settleCall` 时，能否把未确认的结果强制成 final | **不能（行为级结构性）** | `interim` 写在 spread 之后，调用方在 request 里传 `interim:false` 会被覆盖（two-phase.ts:632-636） |
| 传 `interim` 是否在**编译期**被拒绝 | **否（不是类型级）** | 参数类型仍是 `SettleRequest`，它带可选 `interim`：能编译，只是被忽略 |
| 消费方能否绕过协调器、直接调 `manager.settle/reserve` | **能（可编译）** | 桥文件里仍持有原始 manager 的活引用：executor `:503/:514/:1325`、adapter `:359/:360/:375` |
| 绕过之后有没有东西拦住 | **有：测试（外加代码形状）；没有静态门禁** | NC6（§6）把 `settleLedgerCall` 改成 `ledgerManager!.settle({ ...request, interim: false })` → bridge 套件 **7 条红**，含 `expected 'reserved' to be 'interim_settled'`、`expected 500 to be +0` |

准确说法是：**"协调器内部不可能写错（行为级），桥级是约定级 + 测试拦截"，不是"类型级不可能写错"。**
若要把桥级也做成结构性/类型级，有两个**待批准**的加固（会改变已验收字节，本任务未实施）：

- **A（小）**：`settleCall(request: Omit<SettleRequest, 'interim'>)` —— 传 `interim` 变成编译错误。只堵"传错"，不堵绕过。
- **B（中）**：桥文件不再持有 manager 引用（只用 `twoPhaseSettlementFor(...)` 的返回值），并把 `LedgerReservationManager` 从两个桥文件的 import 中去掉；再加一条静态门禁（`src/dsh-bridge/**` 不得出现 manager 的 `.settle(`/`.reserve(`）。这样"绕过"必须先重新接线才可能，并由门禁拦住。

### 3.3 迟到 usage 的归并 + 路径乙封死

```ts
reconcileLateUsage(event)   // 永不 reserve
  ├─ index.lookup(originCallId) === undefined  → 抛 LATE_USAGE_UNKNOWN_CALL（未预留、未结算、池不变）
  ├─ identity.state === 'reserved'             → 抛 LATE_USAGE_BEFORE_TERMINATION（激活中的预留不许对账）
  └─ 否则 → manager.reconcileLateUsage({callId: identity.callId, ...})  （按原 callId，冻结卡计价）
bookNewAttempt(event)       // 唯一允许新开 callId 的路径
  ├─ 缺 marker 或 reason 为空 → 抛 NEW_ATTEMPT_MARKER_REQUIRED
  └─ 否则 → 派生 callId = origin + '#new-attempt-N'，outcome 固定 'failed'（auditOnly=true、qualityEvidence=false），
            身份记录 originCallId + marker + reason，供对账区分
```

另加一条不变量：若 index 认识某 callId 而 ledger 没有它的状态（重启后未 `recoverFromWal()`），
`beginCall` / `reconcileLateUsage` 都抛 `CALL_STATE_UNAVAILABLE`，避免同一身份被重新预占而"一分为二"。

### 3.4 接线点（两个文件都改）

| 文件 | 变更（行号为交付版本） |
| --- | --- |
| `agent-loop-executor.ts` | ① 构造期建立协调器 `:516`；② `AgentLoopExecutor` 暴露 `callIdentities/reconcileLateUsage/bookNewAttempt` `:332-345`；③ `runBranch` 内 `settleLedgerCall` 统一走协调器 `:601`（失败改为 diagnostic，不再静默吞掉）；④ single_call 与 agent_loop 的 reserve 改 `settlement.beginCall` `:788`/`:957`；⑤ 5 处 settle 全部走协调器（取消/超时→interim 自动）；⑥ 结果 metadata 增加 `ledgerCalls`（callId/reservationId/state）`:638`；⑦ 决策解析失败也必须关闭 ledger call `:1039`；⑧ `describe()` 增加两阶段与索引持久化状态 |
| `metered-model-adapter.ts` | ① 构造期建立协调器 `:377`；② reserve 改 `beginCall` `:487`；③ 成功路径 `:589` 与异常路径 `:540` 的 settle 走协调器；④ `ModelCallRecord` 增加 `reservationId` / `settlement: 'final'|'interim'|'none'` / `heldCostMicros`；⑤ `stats()` 的 `costMicros` 改为"每 callId 权威记账额"（interim 不记账、reconcile 覆盖而不是相加），并新增 `lateUsageSettlements`；⑥ 暴露 `callIdentities/lateUsageSettlements/reconcileLateUsage/bookNewAttempt` `:630-647` |
| `src/ledger/two-phase.ts`（新建） | `LedgerCallIndex` `:217`、`TwoPhaseSettlement` `:571`、`reconcileLateUsage` `:659`、`bookNewAttempt` `:713`、`twoPhaseSettlementFor` `:828`、`requiresInterimSettlement` `:855` |
| `src/ledger/index.ts` | 新增 `export * from './two-phase.js'`（接线所需导出） |

**没有任何新增 option key**：协调器从既有 `agentLoop.ledger` / `MeteredModelOptions.ledgerManager` 推导，
`OPTION_KEYS` 的 26 键契约与 `src/config.ts` 根键均未触碰（既有静态门禁测试继续通过）。

## 4. 验收 → 确定性测试映射

| # | 验收项 | 测试（文件） |
| --- | --- | --- |
| 1 | 同一 callId 重复 settle：只结算一次，计数不增加 | `repeated settle on the same callId is a replay: one settlement, no re-booking`（ledger）；`does not settle the same callId twice when the id factory repeats it`（adapter，第二次被 `METERED_MODEL_BUDGET_DENIED` 拒绝，`settleCount` 仍为 1） |
| 2 | 取消后迟到 usage：按原 callId 调整，不新增记账 | `holds the money at cancellation and books it exactly once from the late usage`（executor，含座位释放）；`treats a timeout the same way`；`holds the cost on an AbortError and books it from the late usage`（adapter，`reserveAttempts` 恒为 1） |
| 3 | 跨 callId 重复记账负例：新开 callId 被封死/显式拒绝 | `REFUSES late usage for an unknown origin and reserves nothing (path 乙 closed)`（ledger）；`refuses an unknown origin (even WITH a marker) and books nothing` + `books a marked new attempt only through bookNewAttempt, and labels it`（bridge） |
| 4 | WAL 重启恢复：不重复记账 | `replays one settled figure and a second reconcile stays a no-op`（ledger，真实临时目录 + 真实 `recoverFromWal`）；`recovers the ledger, finds the persisted identity and stays a no-op`（bridge，新 manager + 新 executor）；`refuses to fork an identity when the ledger state was NOT recovered` |
| 5 | observe 模式下行为不变 | `changes nothing observable in the trajectory versus no ledger at all`（bridge：status/步骤/失败信号与无 ledger 基线逐一相同、无 `budget_exhausted` 失败信号、只有 observation；并证明 interim+reconcile 记的金额与一步式 settle **完全相等**） |

补充被钉死的性质（同一批测试内）：
`prices late usage with the card FROZEN at reserve time`、`REFUSES late usage for a call that has not terminated yet`、
`REFUSES settling a callId that was never opened through beginCall`、`writes the mapping beside the WAL BEFORE any settlement`、
`refuses two different index locations for one ledger manager`、`refuses to keep its mapping inside the team collaboration directory`、
`maps every outcome to the ADR-0004 §5.1 side of the line`、`still CLOSES the ledger call when the planner returns a malformed decision`、
`says "unmetered" instead of silently doing nothing when the ledger is off`（executor + adapter 各一条）、
`keeps the confirmed-call path final`。

## 5. 可复算证据

全部命令在仓库根目录执行，采样时刻为本地时区（Asia/Shanghai）。

| # | 命令 | 退出码 | 关键输出 | 取样时刻 |
| --- | --- | --- | --- | --- |
| 1 | `pnpm exec tsc --noEmit` | **0** | （无错误） | 22:44:11；改名修复后 22:50:49 复验 0 |
| 2 | `pnpm exec vitest run tests/unit/ledger tests/unit/dsh-bridge --reporter=basic` | **0** | Test Files 17 passed (17) ／ Tests 279 passed (279) | 22:40:10；负控制还原后 22:44:27 复验同值 |
| 3 | `node scripts/eval/metering-coverage.mjs` | **0** | `[metering-coverage] OK: 97 file(s) scanned, 4 allow-listed model call(s), 0 unmetered call(s).` | 22:44:11 → 22:44:38（最终确认批次） |
| 4 | `pnpm exec vitest run tests/unit --reporter=basic` | **0** | Test Files 115 passed (115) ／ Tests **2293** passed (2293) | 22:40:36 → 22:42:04；改名修复后 22:53:55 → 22:55:11 复验同值 |
| 4b | `node scripts/eval/smoke-build.mjs`（check:build-smoke，**强制真构建**） | **0** | `SUCCESS: the bundle builds and imports as ESM`；`export-surface: 70 named exports`；artifact 1181944 bytes | 22:50:49 → 22:51:0x |
| 5 | `pnpm exec vitest run tests/e2e --reporter=basic` | **0** | Test Files 14 passed (14) ／ Tests **168** passed (168) | 22:42:08 → 22:42:30 |
| 6 | 基线（改动前）同 #2 | **0** | Test Files 15 passed (15) ／ Tests 247 passed (247) | 22:22:26 |
| 7 | 单文件：`vitest run tests/unit/ledger/p3c-two-phase-wiring.test.ts` | **0** | 18 passed (18) | 22:32:31 |
| 8 | 单文件：`vitest run tests/unit/dsh-bridge/p3c-two-phase-bridge.test.ts` | **0** | 14 passed (14) | 22:40:10 批次内 |
| 9 | 全部负控制还原后的同批复验（tsc + 门禁 + #2 套件） | **0 / 0 / 0** | `TSC_EXIT=0`、`GATE_EXIT=0`、`Tests 279 passed (279)` | 22:44:11 → 22:44:38 |
| 10 | `node scripts/verify-readme-counts.mjs`（check:docs） | **1** | README 计数与实测不符：`127/2429` vs `129/2461`、`113/2261` vs `115/2293` | 22:55:20 → 22:56:36 |
| 11 | `node scripts/eval/metering-coverage.mjs`（改名修复后） | **0** | `OK: 97 file(s) scanned, 4 allow-listed model call(s), 0 unmetered call(s).` | 22:50 批次 |
| 12 | 负控制 NC6（绕过协调器的 interim 判定，最终字节上执行） | **红→还原 0** | `guard-removed: True` / `mutant-went-red: True` / `restore-identical: True`；bridge 套件 7 红 | 23:01:03 → 23:01:14 |

**队长独立复核（2026-10-29T23:00 前后，队长自述）**：`tsc --noEmit` → 0；
`vitest tests/unit/ledger tests/unit/dsh-bridge` → 17 files / 279 passed（与本报告一致）；
`src/ledger/two-phase.ts` 存在（34514 B）；`check:build-smoke` → **真构建**（`build: pnpm run build exited 0`，非 skip）。

交付文件（sha256，采样于 22:43 前后）：

| 文件 | 行数 | sha256 |
| --- | --- | --- |
| src/ledger/two-phase.ts（新建） | 865 | `5ec6b7cb77f164ca5efa257fc419d4a8ac8e5c69df27f292f2111ef5bd42ecda` |
| src/ledger/index.ts | 27 | `b90ac193afa243e7485edefcf579722c35acc5a1aca88cfd5e8443060a0fc2c8` |
| src/dsh-bridge/agent-loop-executor.ts | 1374 | `2a978c4b981d6363afb9fe004747db096c70b0e7b39bdaf5638bc026f8d24269` |
| src/dsh-bridge/metered-model-adapter.ts | 673 | `68518d304e32ad96448e3f685fb205e523acf524649b14404185851da332622c` |
| tests/unit/ledger/p3c-two-phase-wiring.test.ts（新建） | 495 | `7081bad4c937775359f63d5271a3af2bd64f4fe736e79be972683635c607fba1` |
| tests/unit/dsh-bridge/p3c-two-phase-bridge.test.ts（新建） | 622 | `1ffc5fae6b68e6755c74eca561d9b5c2e201f08678889979647da9bace90ec76` |

## 6. 负控制实测（6 条，全部真红；NC6 由队长复核问题新增）

纪律来源：`docs/NEGATIVE-CONTROL-RUNBOOK.md`。执行器：`work/neg-control.p3c-two-phase.ps1`，
片段/变异体：`work/neg-control.snippets/nc*.{snippet,variant}.txt`，产物：`work/neg-control.<slug>.{keep-bak,red.log,anchor}`。

**与 runbook 的一处刻意加强**：runbook 的 slug 只由目标相对路径决定，同一目标做第二次变异会复用
bak/red/anchor（runbook 自己记录的"同目标两次不同变异互相认证"）。本任务把 label 并入 slug 哈希
（`sha256(relpath + '#' + label)`），因此同一文件的两个变异物理隔离；红的身份键仍是 runbook 要求的两维
（`target` + `snippet-sha256`），并在 anchor 里落盘。

| # | 变异（目标文件） | 变异串真的消失 | 变异后文件 sha256 | 测试结果 | 红日志/证据 |
| --- | --- | --- | --- | --- | --- |
| NC1 | `const interim = !isRemoteTerminationConfirmed(request.outcome);` → `const interim = false;`（src/ledger/two-phase.ts） | `guard-removed: True` | `d486db00fa18ba864602c65d4ed161c80d0ea8b4cb33a67602879b56168e85d0` | **红**：`expected 'final' to be 'interim'`（2 条：取消 interim、重复 settle replay） | `work/neg-control.81547e0b965f.red.log` @22:51:17 |
| NC2 | 未知 origin 的 throw 整块 → 静默 `bookNewAttempt`（two-phase.ts） | `guard-removed: True` | `ed0d09a2f7f76786b867a9021cc03dfb585bcbd4a85d678689aaf591e5bb8abc` | **红**：`expected undefined to be 'LATE_USAGE_UNKNOWN_CALL'`（1 条，正是"路径乙封死"那条） | `work/neg-control.4e7498993b5b.red.log` @22:51:29 |
| NC3 | append 的落盘分支 → 永不落盘（`=== undefined \|\| true`）（two-phase.ts） | `guard-removed: True` | `0386ddfee53e993c6899ed96da694369e3403b1575c7cae23b3d0cf2188c163d` | **红**：持久化 3 条（文件/身份缺失 → `expected undefined to be 'res_call-restart_...'`） | `work/neg-control.4bd54e27f8e6.red.log` @22:51:36 |
| NC4 | `const rateCard = identity.rateCard ?? event.rateCard;` → `event.rateCard;`（two-phase.ts） | `guard-removed: True` | `052bd55bf810cda69d024991a39b46cf9ec8893ed08e112d8403ef28dc7e6684` | **红**：`expected 30000 to be 3000`（正好是 10× 昂贵卡，证明冻结卡生效） | `work/neg-control.d900532905cb.red.log` @22:51:43 |
| NC5 | executor 的 reserve 绕过协调器：`settlement.beginCall({` → `ledgerManager!.reserve({`（agent-loop-executor.ts） | `guard-removed: True` | `936fc371c38e6c172e0674775dd1019368fca00f77e1930b72aca9c1ace61146` | **红**：8 条（`ledgerCalls` 为空 `expected [] to have a length of 1`、座位/索引缺失等） | `work/neg-control.1f5b06724a8c.red.log`（22:42:40 重做，见下） |
| NC6 | **绕过协调器的 interim 判定**：`settleLedgerCall` 改为 `ledgerManager!.settle({ ...request, interim: false })`（agent-loop-executor.ts） | `guard-removed: True` | `532ffd93c62d58f80b82d2402593fc01ec785282d037efdae60d0cf9c38304f8` | **红**：7 条，含 `expected 'reserved' to be 'interim_settled'`、`expected 500 to be +0`、`expected 'reserved' to be 'settled'` | `work/neg-control.1f5b06724a8c.red.log` 同目录新 slug；@23:01:03 |

规则 3.5 的顺序被遵守：**先判断退出码，只有真红才写日志**；日志首行含 `target=<relpath>;snippet-sha256=<hash>;label=<label>`。
"变异真的生效"用两重检查：内容必须变（`MUTATION-DID-NOT-APPLY` 保护）**且**目标串必须消失
（`MUTATION-LEFT-GUARD-INTACT` 保护）。NC3 第一版变异就是被第二重检查拦下的：那次变体保留了原片段
（在其后追加 `return;`），检查报 `MUTATION-LEFT-GUARD-INTACT`、**文件未被写入**，随后改成
`=== undefined || true`（原片段确实消失）才重新执行 —— 这条过程本身就是该检查非空的证据。

**还原**：每条都用"先取的按目标隔离副本"按字节还原，`restore-identical: True`（red/anchor 全部落盘）。
变异运行时刻（red.log/anchor 的落盘时间）：NC1 22:51:17、NC2 22:51:29、NC3 22:51:36、NC4 22:51:43、NC5 22:42:47、NC6 23:01:03。

**两次重做的原因（诚实记录，不掩盖）**：
- 我第一次执行 NC5 之后又做了两处合法编辑（`assertDecision` 失败也必须关闭 ledger call、以及对应新测试），
  于是 NC5 的 anchor 与最终交付字节不再相同（runbook 规则 4 的"还原后又编辑"形状）。→ 在最终字节上重做 NC5。
- 随后又发现并修复了 §6.2 的门禁缺陷（`two-phase.ts` 改名），于是 NC1–NC4 的 anchor 同样失效。→
  在最终字节上把 NC1–NC4 全部重做（22:51:17–22:51:43）。
  两次重做都是"改完代码就把负控制重新对最终字节做一遍"，而不是让旧 anchor 继续背书。

**规则 4b 的跨进程复核**（在所有合法编辑完成后执行；NC6 加入后于 `PHASE_B_AT=2026-10-29T23:02:19` 复核，
结果如下（6 条全部 `evidence-valid=True`，`ALL_EVIDENCE_VALID=True`））：

```
nc1-interim-guard-removed       | hash-unchanged-since-restore=True | red-recorded=True | red-target-matches=True | red-snippet-matches=True | evidence-valid=True
nc2-unknown-origin-not-refused  | hash-unchanged-since-restore=True | red-recorded=True | red-target-matches=True | red-snippet-matches=True | evidence-valid=True
nc3-mapping-not-persisted       | hash-unchanged-since-restore=True | red-recorded=True | red-target-matches=True | red-snippet-matches=True | evidence-valid=True
nc4-frozen-card-dropped         | hash-unchanged-since-restore=True | red-recorded=True | red-target-matches=True | red-snippet-matches=True | evidence-valid=True
nc5-executor-bypasses-call-index| hash-unchanged-since-restore=True | red-recorded=True | red-target-matches=True | red-snippet-matches=True | evidence-valid=True
nc6-settle-bypasses-interim-decision | hash-unchanged-since-restore=True | red-recorded=True | red-target-matches=True | red-snippet-matches=True | evidence-valid=True
ALL_EVIDENCE_VALID=True
two-phase.ts sha256 = 5ec6b7cb77f164ca5efa257fc419d4a8ac8e5c69df27f292f2111ef5bd42ecda
agent-loop-executor.ts sha256 = 2a978c4b981d6363afb9fe004747db096c70b0e7b39bdaf5638bc026f8d24269
```

即：交付字节与"还原那一刻"逐字节相同，且每份红日志的身份键（target + snippet-sha256）与本次变异一致 ——
不存在"上一次实验的日志给这一次背书"。

### 6.2 阻断性发现：私有方法名 `require` 击穿 build/ESM 冒烟门禁（已修复）

**现象**：`check:build-smoke`（`scripts/eval/smoke-build.mjs`，也被 `tests/unit/p62/evidence-gates.test.ts` 调用）
在**强制真构建**下红：

```
[build-smoke] ok   build: pnpm run build exited 0
[build-smoke] ok   artifact-exists: lib/index.js is 1181458 bytes
[build-smoke] FAIL artifact-is-esm: lib/index.js contains CommonJS syntax (module.exports / require) despite --format=esm
```

**根因（本任务引入，已定位到字节）**：`LedgerCallIndex` 原有一个私有方法叫 `require(callId)`；
esbuild 把成员名原样保留到 ESM 产物里（`return this.require(identity.callId);` 等 9 处），
而门禁用朴素正则 `/\brequire\s*\(/` 判"是否含 CommonJS 语法"→ 误判。
**修复**：改名为 `mustFindIdentity`（并避免在注释里留下同形 token），产物恢复 ESM 判定、70 个命名导出、`import()` 成功。

**更值得记录的第二个问题（措辞已按队长复核意见修正）**：门禁脚本**本身是对的**——
`scripts/eval/smoke-build.mjs:173` 只有在显式传 `--skip-build` 时才跳过构建（默认必构建）；
真正的绕过发生在**测试**里：`tests/unit/p62/evidence-gates.test.ts:534` 传
`smokeBuild({ skipBuild: fs.existsSync(artifact) })` —— `lib/index.js` 一旦存在就复用旧产物。
于是**改动后的整套单测里这条检查曾经是"通过"的**，它拿的是旧字节；我是用**强制真构建**
（`node scripts/eval/smoke-build.mjs`）才把缺陷逼红的。

**准确说法**：门禁是对的（默认必构建），**是测试自己绕过了门禁**。后果是真的：我第一次的
私有方法名 `require` 就是这么被漏过的。队长已把它登记为 doc-sync 的待办（加断言：`skipBuild`
只允许用于显式声明"复用已有产物"的场景，或在测试里强制真构建）；本任务不改它（不在授权范围）。

### 6.3 跨范围请求：README 计数（check:docs）

`node scripts/verify-readme-counts.mjs` 在改名修复后仍然红，原因是**测试计数**（不是代码）：

| README 位置 | 现值 | 应为 |
| --- | --- | --- |
| `README.md:105` | `127` test files / `2429` passing tests | `129` / `2461` |
| `README.md:429` | `113 files, 2261 tests` | `115 files, 2293 tests` |
| `README.md:431` | `127 files, 2429 tests` | `129 files, 2461 tests` |

差值正好是本任务新增的 2 个测试文件 / 32 条测试（2293 unit + 168 e2e = 2461；115 unit + 14 e2e = 129）。
**README.md 不在 t2 的授权写入范围内**，因此我没有修改它 —— 这是一次**跨范围修改请求**，
已随任务完成报告发给 lead/队长。

### 6.4 机制强度自评：`interim 由协调器推导`的保证强度（由 t2 实现者提出、队长复核）

**归属说明（措辞历经一次更正）**：这段自评的**判断由 t2 实现者自己做出并主动提出**（在被问及"这条保证是
类型级还是约定级"时，实现者修正了自己此前更强的表述）；队长只是在独立复核确认三点成立后，
要求把这段**原样收录**进报告，并给出了"把强度标清楚比声称更强更重要"的理由。
初版标题写成"应队长要求原样收录"，会把判断的归属放到队长一侧 —— 一份把贡献归属搞错的报告，
会让下一个读者误判这段自评的可靠性，故按队长建议更正为现标题（更正与原错误同址）。

> 准确说法是：**『interim 由协调器从 outcome 推导』是行为级结构性（不可覆盖）；但那不是类型级**——
> `settleCall` 的参数仍带可选 `interim`，传了能编译、被忽略；桥文件仍持有 manager 活引用，
> 绕过可编译，**拦住它的是代码形状 + NC6 的 7 条红**。

**为什么必须写在报告里（队长的理由，原样记录）**：一份报告如果只说"消费方无法忘记用 interim"，
下一个人会以为它是类型级保证，于是放心地绕过。**把强度标清楚，比声称更强更重要。**

队长逐条独立核实过的三个位置（结论：三点全部成立）：

| 断言 | 位置 | 核实结论 |
| --- | --- | --- |
| `interim` 在 spread 之后写入 → 覆盖调用方值 | `src/ledger/two-phase.ts:632-633` | ✅ |
| 参数类型仍带可选 `interim` → 无编译期信号 | `src/ledger/two-phase.ts:623` | ✅ |
| 桥文件仍持有 manager 活引用 → 绕过可编译 | `src/dsh-bridge/agent-loop-executor.ts:503`（adapter `:359`） | ✅ |

判据不是文档承诺，而是**可判别用例**：删掉协调器的判定（NC6）→ bridge 套件 7 条红，
具体到 `expected 'reserved' to be 'interim_settled'`。

**下一轮结构债（本任务不落地，队长裁定）**：

- **A（零成本一行）**：`settleCall(request: Omit<SettleRequest, 'interim'>)` —— 传 `interim` 变编译错误。只堵"传错"。
- **B（结构 + 门禁）**：桥文件不再持有 manager 引用、`LedgerReservationManager` 从两个桥文件 import 中去掉，
  新增静态门禁（`src/dsh-bridge/**` 不得出现 manager 的 `.settle(`/`.reserve(`）。堵住绕过。

**为什么不是现在做（队长的裁定理由，原样记录）**：B 会改动两个**已验收的桥文件**，而 `t1` 正在复核这两个文件；
此刻改会让 `t1` 验到一份已经不存在的字节 —— 上一轮正是在复核期间改文件被顶回（第 21 项错误）。
故 B 登记为**下一轮第一条结构债**，A 可在那之前单独落地。

### 6.1 变异空间（做了什么 / 没做什么；本节是附录，列在 6.4 之后）

做过（每条都真红，见上表）：① interim 判定；② 未知 origin 的拒绝；③ 映射落盘；④ 冻结费率卡；
⑤ 消费方绕过协调器（reserve 直连 manager）。

**没做**（标【未知】，不当"通过"）：

- **测试盲区未被证伪**：我不是穷尽变异。**已经做过的第 6 条（NC6）正是"在 `manager.settle` 调用处
  把 interim 覆盖成 false"**（7 红），所以这一条已从"未知"变成"已验证"；仍未检验的是例如
  "删掉 `index.recordReconciliation` 但保留 `manager.reconcileLateUsage`"（只影响身份状态，不影响金额）之类的组合。
  这类残余属于**未被检验的变异空间**，对应性质目前只由正向断言覆盖。
- **真实 provider 的迟到 usage 到达顺序**（usage 与 final response 的相对时序、同一次调用的多次
  增量 usage 事件）没有真实数据；只在契约层用构造 usage 验证【未知】。
- **多进程并发写同一 `ledger.calls.jsonl`** 未测试（append + fsync 是逐行原子追加的常见前提，
  但没有在本任务内证明；跨进程同时写不在我的授权范围内执行）。
- **座位长期保留的运行影响**（见 §8-1）没有实测。

## 7. 授权边界与未执行项

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 真实付费模型调用 | **未执行（需授权）** | 全部验证为注入式 fake model（hanging/aborting/measured）+ 真实 WAL 临时目录 + 真实 factory。授权申请文本："申请以 `agentLoop.ledger.enabled=true` 对一次真实 provider 调用执行 cancel→interim→迟到 usage→reconcile 的 smoke，以核对真实流上的 usage 时序与 `ledger.calls.jsonl` 的落盘时序。" |
| 真实宿主 smoke（Cordis 宿主挂载） | **未执行（需授权）** | 替代验证：`tests/e2e` 全绿（168 条，含 `plugin-entry`/`persistence-restart`）+ 本任务两条接线级套件。真实宿主事件入口（provider 回调）不在本任务授权范围。 |
| 真实外部工具调用 / 记忆写入 | **未执行（需授权）** | 本任务不涉及；工具运行时是记录型 fake。 |
| CI 门禁语义 / 拓扑规则 / 阈值 | **未改动** | 未触碰任何 CI 脚本与基线报告；`metering-coverage` 门禁在两个桥文件上仍 0 未计费调用（见 §5 #3）。 |
| 负控制产物 | **新增（work/ 下）** | 按 runbook 规则 5 必须落盘红证据；`work/` 已被 `.gitignore` 忽略，未修改/删除任何既有 work/ 文件。 |

## 8. 遗留风险

1. **取消后座位保留是设计结果，不是泄漏**：interim 时座位按 ADR-0004 §5.1 保留（`seatsRetainedPendingRemote`），
   只有迟到 usage 到达、或显式 `releaseSeat(callId)`、或外部账单对账才会释放。若宿主**永不投递**迟到 usage，
   座位会一直占着（`describe()`/告警可见）。缓解路径已存在（`manager.releaseSeat`），但"何时允许释放"是
   产品判断，本任务没有替宿主决定。
2. **调用方必须投递迟到 usage**：接线只提供了入口；真实 provider 事件→入口的适配器（宿主侧）不在本任务范围。
   未接线前，取消调用的金额停在 reserved 上（可审计、可见，不会静默丢失，但报告里的 settled 会偏小）。
3. **索引保留窗口**：默认 4096 个终态身份（只淘汰终态，淘汰计数可见）。窗口之外的迟到 usage 会走
   `LATE_USAGE_UNKNOWN_CALL`，需要显式 `bookNewAttempt`（带 marker），否则被拒绝 —— 这是有意的 fail-closed。
4. **observe 模式的记账时点改变**：取消调用的金额现在在 reconcile 时入账（此前在 settle 时入账）。
   总额相等（§4-5 有等价性测试），但"到账时间"变了；依赖"取消后立刻能看到 settledMicros"的下游需要知道这一点。

## 9. 结论

- §7.1 的 4 条接线契约全部落地在**生产代码路径**上，且有 32 条新测试（18 + 14）钉死；
  其中 **6 条**负控制全部真红、按字节还原（并在每次合法改动后重新对最终字节执行）。
- 交付不改任何会计语义（金额移动仍然只在 `LedgerReservationManager` 内），不新增 option key，
  不改 CI/门禁脚本、不改历史报告。
- **本轮实测拦下一个会击穿 `check:build-smoke` 的私有方法名**（§6.2），修复后真构建下门禁 SUCCESS。
  经队长复核，准确描述是：**门禁本身正确（默认必构建），是 `evidence-gates.test.ts:534` 传
  `skipBuild: existsSync(artifact)` 自己绕过了它**（登记给 doc-sync，本任务未改）。
- "消费方无法忘记用 interim"的**精确边界**见 §3.2：协调器内部是行为级不可覆盖；桥级是
  约定级 + 测试拦截（NC6 证明绕过会立刻 7 红），**不是**类型级。这段**机制强度自评**（判断由 t2
  实现者提出、队长复核）收录于 §6.4，含队长逐条核实的三个位置与下一轮结构债 A/B 的方案；
  加固 A/B 本任务不落地（理由：B 会改动 t1 正在复核的两个桥文件，会让复核对象变成一份不存在的字节）。
- **`check:docs` 仍需一次跨范围修改**：README 的三处测试计数（§6.3）——不在 t2 授权范围，已请求 lead。
  在此之前本条门禁是红的，且红的原因是文档计数，不是代码。
- 未执行项（真实付费调用 / 真实宿主 smoke）已按授权边界登记，并给出契约级替代验证。

**§7.1 登记的处置（越界说明）**：§7.1 原文要求"完成上述接线后，把本登记改为已完成"，
但 t2 的授权写入范围**不含** `docs/reports/p3-c-usage.md`（该文件是上一轮已跟踪交付）。
因此我没有修改它，而是以本报告作为该缺口的完成凭据：§7.1 的 4 条契约在此逐条落地并有测试与负控制证据。
把 `p3-c-usage.md` §7.1 标注为"已完成（见 `p3-c-two-phase-wiring.md`）"属于**跨范围修改**，
需要 lead/队长决定（已通过任务报告同步该建议）。
