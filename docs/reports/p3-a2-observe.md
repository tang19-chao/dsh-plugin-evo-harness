# P3-A2 交付报告：observe 零副作用语义与硬限额独立开关（t13，attempt 1）

- **状态**：完成
- **日期**：2026-10-29
- **写者**：p3-metering（P3 全阶段计量工程师）
- **上位契约**：docs/reports/p2-p6-remaining-work.md §4 P3-A（"默认 observe 不得因预算拒绝、截断、改写工具结果或把探针结局改为 failed"）、t4 交付报告（装配路径）、ADR-0004 §9.2

---

## 1. 实现

### 1.1 observe / enforce 是 ledger 的显式模式（默认 observe）

- `LedgerMeteringMode = 'observe' | 'enforce'`（types.ts）；manager 构造器接受 meteringMode（**直接构造默认 'enforce'**，保证 t4 之前全部会计测试契约不变）；装配路径**默认 'observe'**。
- observe 的语义（reservation-manager.reserve）：**从不拒绝**预算/席位/准入；资源不预留（reservedCostMicros=0）、不占席位；把"本会拒绝的原因"写入 `ReserveResult.observedRejection` 与命名 alert（observe-budget-exceeded / observe-seat-exceeded，新增 LimitAlertKind）；settle 照常记账，池可透支可见（ADR-0004 §5.3-3）。
- **独立开关**：装配层 `meteringMode = enforceHardBounds === true ? 'enforce' : 'observe'`——硬限额只由 `agentLoop.ledger.enforceHardBounds` 这一个显式 opt-in 打开；ledger 源码不读 executionProfile / permissions / guarded-active（§5 有源码级证明）。t4 时期的 `LEDGER_HARD_BOUNDS_NOT_WIRED` 拒绝已按本任务验收移除（当时是"未接线"的 fail-closed 占位）。
- 观测出口：**新通道**，不进 failureSignals（§4）。executor 把 observe 期间的 would-be denial 写入 `result.observations`（新增 ProbeObservation 契约字段，只新增可选字段）。
- 状态可区分（要求 3）：manager 新增 `getMeteringStatus()`（mode/metered:true/reserveAttempts/reserveGranted/observedDenials/settleCount/measuredCalls/estimatedCalls/unknownCalls/totalCostMicros）与 `getUsageAccounting()`（复用 t6 的三桶分列）。

### 1.2 executor 的极小改动（队长两次授权，范围见 §7）

- 仅两处 reserve 分支追加 observe 观测块（只加不删）：若 `reserveRes.observedRejection !== undefined` 则 push 一条 ProbeObservation（kind='budget_exhausted'，stage='single_call'|'agent_loop'，details 含 callId/rejection/meteringMode）。
- `toProbeExecutionResult` 增加第三参 observations 并在非空时挂到 result.observations。
- **failureSignals 完全未被触碰**（§4 给出为什么不能碰）。

## 2. 四条 observe 保证：测试名与断言（tests/unit/ledger/p3a2-observe.test.ts）

| 保证 | 测试名 | 关键断言 |
| --- | --- | --- |
| 1. 不因预算拒绝 | `GUARANTEE 1: does not deny a call because the budget is exhausted` | generalBudgetMicros=0 + observe：status==='succeeded'；planner.requests>0；tools.calls>0；result.observations 含 kind='budget_exhausted'；failureSignals **不含** budget_exhausted |
| 2. 不截断 | `GUARANTEE 2: does not truncate the tool result` | 工具返回 50,000 字符：result step toolResult 与 text **逐字节等于** LONG_RESULT，长度 50,000 |
| 3. 不改写工具结果 | `GUARANTEE 3: does not rewrite the tool result` | 工具返回对象 {stdout,exitCode,nested}：step.toolResult toEqual 且 toBe（同一引用），未复制/未改写 |
| 4. 结局与无计量一致 | `GUARANTEE 4: does not change the probe status versus no ledger` | observe(0 预算) vs 无 ledger 两个 run：status、step kinds 序列、deliverable.content、failureSignal kinds **全部相等**；唯一差异是 observations（observe 有、baseline 无） |

每条失败时单独定位：1 看 observations/failureSignals、2/3 看单一断言、4 用逐字段 diff 对照 baseline。

## 3. 硬限额：现状 / 改了什么 / 如何证明独立（要求 2）

**现状（改前）**：enforceHardBounds=true 在 t4 被装配层显式拒绝（LEDGER_HARD_BOUNDS_NOT_WIRED），硬限额完全未接线；**没有任何其他开关被复用**（不存在"复用 guarded-active"的现状需要纠正）。

**改了什么**：装配层将 enforceHardBounds=true 解析为 meteringMode='enforce' 并传给 manager；observe 为默认。其它一律不动：executor 的 fail 路径保持原样，只在 observe 之外生效。

**如何证明独立（三层）**：

1. 行为层（p3a2-observe.test.ts `hard limits are independent of every other permission switch`）：同一配置对象塞入 `execution:{mode:'guarded-active'}` + enforceHardBounds:false → observe；塞入 `execution:{mode:'shadow'}` + enforceHardBounds:true → enforce。
2. 源码层：strip 注释后断言 src/ledger/** **不含** `guarded-active`、`executionProfile`、`applyWinningPatch`、`permissions.`（测试 `never reads an execution/permission profile in the ledger source`）。
3. 对照层（t4 bridge 测试的 observe/enforce 同 fixture 对照，见 §6）：observe 放行且 planner/tools >0，enforce 在 planner/tools=0 时即拒。

## 4. 为什么这条观测不进 failureSignals（封死这条路）

failureSignals 有四个真实消费方，把 observe 观测写进去等价于改写结局：

| 消费方 | 位置 | 被污染的后果 |
| --- | --- | --- |
| composer 鲁棒性评分 | src/harness2/composer.ts:260-273 `robustnessDimension`：score=clamp01(1/(1+signals+toolErrors/2)) | signals 加一 → 鲁棒性得分下降 → 进入候选评分与 Pareto 对比 |
| step-evaluator | src/jitrl/step-evaluator.ts:343/369/410 | 步骤评估与超时判定把观测当失败 |
| failure taxonomy | src/dream-rsi/failure-taxonomy.ts:135-165 | 正常 run 被归类进失败分类 |
| proposer/reflector 提示词 | src/harness2/proposer.ts:169、reflector.ts:184-202 | 观测文本进入提示词/反思 |

且 composer 只数数量不看 kind，扣分**不可见**。因此观测走独立通道 `result.observations`（contracts 只新增可选字段），断言做成对照：observations 含 budget_exhausted **且** failureSignals 不含。下一个想偷懒的人：这条路被封死，理由如上。

## 5. 行为变更及其影响（必须披露）

**谁受影响**：所有**设置了预算但使用默认 observe** 的宿主（agentLoop.ledger.enabled=true 且未开 enforceHardBounds）。未启用 ledger 的宿主零影响。

**同一配置前后对照**（generalBudgetMicros=0、observe，来自 t4 bridge 测试同一 fixture）：

| 指标 | 改前（fail-closed） | 改后（observe） |
| --- | --- | --- |
| runBranch status | failed（EvoHarnessLedgerError） | succeeded |
| planner.requests | 0 | 2 |
| tools.calls | 0 | 1 |
| budget_exhausted 位置 | failureSignals（强制） | result.observations（仅观测） |
| 实际花费记账 | 无调用 | settle 照记（池可透支可见） |

**迁移建议**：想要旧"预算硬拒绝"行为的宿主显式设置 `agentLoop.ledger.enforceHardBounds: true`（这是唯一开关，独立于 guarded-active/execution.mode/applyWinningPatch）。

**为什么这是要求不是选择**：清单原文 §4 P3-A——"默认 observe 不得因预算拒绝、截断、改写工具结果或把探针结局改为 failed"。

**可观测出口（宿主据此告警）**：

1. `result.observations`（kind='budget_exhausted'，details.rejection/phase）——trajectory/result 级，每次触发都在；
2. ledger 命名 alert：`manager.getAlertsOfKind('observe-budget-exceeded')`（进程级计数），另有 `getMeteringStatus().observedDenials` 累计；
3. **failureSignals 与 status 在 observe 下不变**（这是与改前的本质区别，也是防"静默失效"的对照点）。

宿主告警样例：

```json
{ "alert": "observe-budget-exceeded", "detail": "call \"br-7\" would have been denied for budget (10000u requested); observe mode proceeds and books actual spend at settle", "source": "manager.getAlertsOfKind('observe-budget-exceeded')" }
```

## 6. 状态可区分（要求 3）

`tests/unit/ledger/p3a2-observe.test.ts`：

- `has no assembly at all when the ledger is not enabled`：未启用 → `assembleAgentLoopLedger` 返回 undefined（"没有计量"）；
- `reports metered=true with zero calls once the ledger is assembled`：有 ledger 但 0 次调用 → `getMeteringStatus()` 精确等于 {mode:'observe',metered:true,reserveAttempts:0,…,measuredCalls:0,unknownCalls:0,totalCostMicros:0}（"0 次调用"≠"没有计量"）；
- `keeps unknown semantics UNKNOWN in the status`：无语义结算 → status.unknownCalls=1、measuredCalls=0，`getUsageAccounting().unknown.calls=1`；
- `reports observed denials and takes no seat in observe mode`：maxConcurrencySeats=0 → granted、observedRejection='insufficient_seats'、occupiedSeatCount=0、status.observedDenials=1、alert observe-seat-exceeded；
- `records observed budget exhaustion as a named alert`：observe-budget-exceeded 恰好 1 条。

## 7. 可复算证据

| # | 命令 | 退出码 | 关键输出 |
| --- | --- | --- | --- |
| 1 | `pnpm exec tsc --noEmit` | **0** | （无错误） |
| 2 | `pnpm exec vitest run tests/unit/ledger tests/unit/dsh-bridge --reporter=basic` | **0** | Test Files 15 passed (15) ／ Tests 247 passed (247) |
| 3 | `pnpm exec vitest run tests/unit/ledger/p3a2-observe.test.ts --reporter=basic` | **0** | Test Files 1 passed (1) ／ Tests 12 passed (12) |

## 8. 测试清单（新增 12 + 受权更新 2 + 连带更新 3）

- 新增 p3a2-observe.test.ts 12 条（§2 四条保证 + enforce 对照 + 状态 5 条 + 独立性 2 条）。
- 受权更新 tests/unit/dsh-bridge/agent-loop-ledger-assembly.test.ts 的 158-177 it 块 → observe/enforce 对照两条。**"其余未动"的准确口径与验证**见 §8.1（该文件 t4 基线为 **19 条 it**，替换 1 条、新增 1 条对照，现 20 条；**18 条未动**）。observe 断言 observations 含 budget_exhausted、details.rejection、status succeeded、**failureSignals 不含 budget_exhausted**、planner/tools >0；enforce 断言 failed/EvoHarnessLedgerError/failureSignals 含 budget_exhausted/planner=0/tools=0。
- 连带更新（同一行为变更的直接后果）：tests/unit/ledger/assembly.test.ts 的 enforceHardBounds 测试改为"两模式 + 0 预算观测/拒绝"断言、defaults 测试改为 observe 语义（reserve 0、settle 0、status.measuredCalls=0/unknownCalls=1）并新增 enforce 会计对照；tests/unit/ledger/p3c-cancellation-recovery.test.ts 的 makeManager 显式 `enforceHardBounds:true`（它测的是结算/恢复会计，observe 语义有自己的套件）；tests/unit/ledger/metered-model-adapter.test.ts 的预算拒绝测试显式 `enforceHardBounds:true`（拒绝是 enforce 行为，observe 有自己的保证）。

### 8.1 "其余未动"的验证方式（t4 bridge 套件的 18 条基线）

- **基线数**：t4 验收运行打印 `tests/unit/dsh-bridge/agent-loop-ledger-assembly.test.ts (19 tests)`（t4 报告 §4-B / 验收证据）。本任务把 158-177 那一个 it 块替换为 observe/enforce **两条**：19 − 1 + 2 = 20（当前实测 `20 tests`），即 **18 条 t4 基线用例未动**。
- **改动方式**：对**该文件**的写入有且仅有一次单块替换（old/new 都在本次会话记录中，old_string 即 §8 引用的原 it 块全文）；其余任何行未触碰。
- **可比对哈希（供此后任何一次"顺手改"的永久基线）**：把当前文件中两个 P3-A2 替换块（标题以 `'observe mode: zero budget` 与 `'enforce mode: the same fixture` 开头的 it 块）整体摘除后，其余内容的

  ```
  sha256 = caf5ea5c8c0b452145c7cd28d8ba63d457eff4a77769dbd89f67c554111c023c
  ```

  复算命令（Node）：

  ```
  node -e "const fs=require('fs'),c=require('crypto');const t=fs.readFileSync('tests/unit/dsh-bridge/agent-loop-ledger-assembly.test.ts','utf8');const parts=t.split(/\n  it\(/);const kept=[parts[0]];for(let i=1;i<parts.length;i++){const h=parts[i].slice(0,90);if(h.startsWith("'observe mode: zero budget")||h.startsWith("'enforce mode: the same fixture"))continue;kept.push(parts[i]);}console.log(c.createHash('sha256').update(kept.join('\n  it('),'utf8').digest('hex'))"
  ```

  任何人对这 18 条基线用例的改动都会改变该哈希；改动这两个替换块不影响它。
- **诚实披露**：该文件是未跟踪新文件（无 git blob 基线），因此"改动前逐字节哈希"无法回溯产生；上表哈希是**从现在起**的基线，t4 证据的保留由"单块替换 + 19→20 计数恒等式 + 18 条用例名清单"三者共同证明。18 条用例名（t4 原名，未动）：creates a manager from config and still runs a full probe on a normal budget；fails at construction time for an invalid enabled configuration；refuses both wiring styles at once instead of silently preferring one；rejects an invalid ledger config at mount time；mounts with a valid ledger configuration and exposes the plugin surface；keeps the pre-P3-A default working and reports ledger OFF；treats { enabled: false } as unmetered, never as an error；keeps the legacy pre-built manager injection optional and working；registers exactly 26 public option keys, including agentLoop；introduces no 27th option key for the ledger；introduces no new src/config.ts root key (check:docs leaf count unchanged)；keeps agentLoop an OPTION, never a frozen config section；types the ledger entry as the assembly config (compile-time witness)；src/dsh-bridge has no direct construction and no deep manager import；tests/unit/dsh-bridge has no direct construction；the executor goes through the barrel and the single assembly function；NEGATIVE CONTROL: the scanner really reports a violating file；the new ledger assembly suite also goes through the factory (rule for NEW tests)。

## 9. 改动文件清单

| 文件 | 变更 |
| --- | --- |
| src/ledger/types.ts | LedgerMeteringMode、ReserveResult.observed/observedRejection、LedgerMeteringStatus |
| src/ledger/reservation-manager.ts | meteringMode 选项（直接构造默认 enforce）、observe 分支（不拒绝/不预留/不占席）、计数器与 getMeteringMode/getMeteringStatus/getUsageAccounting |
| src/ledger/limits.ts | 新增 LimitAlertKind：observe-seat-exceeded / observe-budget-exceeded |
| src/ledger/assembly.ts | meteringMode 解析（默认 observe，enforceHardBounds 唯一开关）、传参、describe 输出 mode |
| src/types/contracts.ts | **仅新增** ProbeObservation 接口与 ProbeExecutionResult.observations?: 可选字段 |
| src/dsh-bridge/agent-loop-executor.ts | **受权**：两处 reserve 分支观测块 + observations 透传（只加不删） |
| tests/unit/ledger/p3a2-observe.test.ts | 新增 12 条 |
| tests/unit/dsh-bridge/agent-loop-ledger-assembly.test.ts | **受权**：158-177 it 块替换为 observe/enforce 对照（其余 15 条未动） |
| tests/unit/ledger/assembly.test.ts / p3c-cancellation-recovery.test.ts / metered-model-adapter.test.ts | 行为变更的连带更新（见 §8） |
| docs/reports/p3-a2-observe.md | 本报告 |

## 10. 授权边界与未执行项

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 修改 src/dsh-bridge/agent-loop-executor.ts（两处观测块 + observations 透传） | **已获队长授权**（第一次授权条件 1 必需；第二次授权明确形状） | 只加不删；failureSignals 未触碰。 |
| 修改 src/types/contracts.ts（observations 可选字段） | **已获队长授权** | 仅新增可选字段与类型，未改既有字段语义。 |
| 修改 tests/unit/dsh-bridge/agent-loop-ledger-assembly.test.ts | **已获队长授权** | 仅 158-177 it 块 + 相邻 enforce 用例；其余 15 条未动。 |
| 真实付费调用 / 真实宿主 smoke | **未执行（需授权）** | 全部为注入式 fake；授权申请文本："申请以默认 observe + enforceHardBounds 两种配置各跑一次真实宿主 smoke，验证观测出口与硬限额拒绝在真实 provider 流上的表现。" |

## 11. 集成轮必做清单（行为变更的收尾动作，非风险陈述）

集成轮（P6/verifier 之前）**应当做的三件事**：

1. **把 observe-budget-exceeded 接进宿主状态面**：数据源已就绪——`manager.getAlertsOfKind('observe-budget-exceeded')`（每次触发的命名 alert）与 `getMeteringStatus().observedDenials`（累计）。落到宿主可见的状态行/告警，宿主才能"看见自己踩到了什么"；样例见 §5.3。
2. **在升级说明中标注该行为变更**：默认 observe 下 `generalBudgetMicros` 不再硬拒绝调用（改前 planner 0 次 → 改后 2 次，见 §5 对照表）；升级文档必须写明，否则是新的静默失效。
3. **依赖硬拒绝的宿主显式开 `enforceHardBounds: true`**：这是唯一开关（独立于 guarded-active/execution.mode/applyWinningPatch，§3 三层证明）；不配置即回落 observe。

## 11.1 其余遗留风险

1. observe 模式不预留资金，settle 直接记账：池余额可透支（overdraft 按既有契约可见，conservation 仍平衡）；enforce 模式无此现象。
2. `getMeteringStatus()` 的计数器是进程内累计，不进 WAL；跨进程持久化计数属 P3-C/持久化任务。
3. tsc 全仓绿依赖并行队友文件（cordis-seams 等在制错误已消）当时的可编译状态；本任务文件始终 0 错误。

## 12. 结论

- 默认 observe 严格零行为影响：四条保证各有独立确定性测试，同一 fixture 与无计量 run 全字段一致，唯一差异是专用观测通道。
- 硬限额由 `enforceHardBounds` 独立显式 opt-in，源码级证明不读任何执行/权限开关；observe/enforce 同 fixture 对照测试落在 t4 bridge 套件内。
- 无 ledger / 有 ledger 0 调用 / unknown 语义三态在 status 层可区分，unknown 永不冒充 measured。