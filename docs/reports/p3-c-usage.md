# P3-C 交付报告：usage、语义来源与取消/恢复结算（t6，attempt 1）

- **状态**：完成
- **日期**：2026-10-29
- **写者**：p3-metering（P3 全阶段计量工程师）
- **上位契约**：ADR-0003 §7.3（三态计量/语义显式声明）、ADR-0004 §5.3/§6/§8.3（两阶段结算/迟到对账/WAL 恢复/对账状态机）、docs/reports/p2-p6-remaining-work.md §4 P3-C

---

## 1. 问题（改动前）

| 问题 | 位置 | 后果 |
| --- | --- | --- |
| 语义默认值按"模型族"猜测：`dshUsageToProviderPayload` 第二参缺省时回落 DEFAULT_DSH_COUNTING_SEMANTICS | src/ledger/pricing.ts:232 | 未声明语义的用量被当成 DeepSeek 语义结算并记 measured——违反"语义只能来自 provider/宿主元数据或明确 unknown" |
| cacheRead 不可得时维度被静默当作 0/免费 | src/ledger/pricing.ts | 保守地板费可能被误读为"cache 实测为零"；成本低估不可见 |
| cost 无维度级 provenance，报告层无 measured/estimated/unknown 分列 | src/ledger/types.ts | "estimated 冒充 measured"不可检出 |
| PR-4A 反向门禁把"本轮恰好无 tokenizer"写死为永久规则 | scripts/eval/verify-pr4a-artifacts.mjs:1344/1380 | 将来真测出成本会被正确结果拦下 |

## 2. 实现（全部在 src/ledger/ 与授权的 verifier 内）

### 2.1 语义来源：只认显式 provider/宿主元数据

- `dshUsageToProviderPayload(usage, semantics?)` **删除默认语义**：调用方未提供即无 countingSemantics → provenance unknown + 保守地板（ADR-0003 §7.3.2）。显式传入则逐字携带。
- 新增 `ProviderUsagePayload.unreportedMetrics?: readonly UsageMetricName[]`：provider 未上报的维度**显式列出**（不是静默 0）。
- 类型层新增 `CostCalculation.dimensionProvenance`（input/output/cacheRead/cacheWrite/reasoning 五维各自 provenance）。

### 2.2 cacheRead 不可得 → unknown，不是 measured 0

- `CostCalculation.cacheReadUnavailable?: boolean`：provider 未上报 cacheRead（或 precision 非 measured）时为 true；
- auditNote 追加 "cacheRead unavailable; cacheRead cost is unknown, not a measured zero"（countingSemantics 缺省审计行保留）。

### 2.3 usage report：三态分列 + 闭合规则（新模块 src/ledger/usage-report.ts）

- `summarizeUsageAccounting(events)` / `summarizeCostProvenance(costs)` → `UsageAccountingReport`：measured / estimated / unknown 三个**独立桶**（calls、costMicros、calls 份额 share），外加 cacheReadUnknownCalls 与三个桶的成本总量字段。
- `validateUsageAccountingReport` 闭合规则：counts 求和=totalCalls、shares 求和=1、桶成本求和=totalCostMicros、无负值。**规则本身不要求 measured=0 也不要求 >0**——这就是替代旧反向门禁的形状：能力靠声明，数据靠闭合。

### 2.4 两阶段结算 / 迟到对账 / WAL 恢复（生产路径 = ledger manager 的 reserve/settle(interim)/reconcileLateUsage/recoverFromWal）

既有实现（ADR-0004 §5.3/§6）保持不变，本任务以 6 条新测试把关键幂等性质钉死：取消/超时 interim 结算后，同一份迟到 usage **只结算一次**（二次 reconcile 金额不变、池不变、守恒成立）；WAL 重启重建唯一结算值且重启后再对账不重复记账；崩溃悬挂预留 recover 后 pending_reconciliation → reconcile 一次；unknown 语义透传到报告的 unknown 桶。

### 2.5 PR-4A 反向门禁修复（队长裁定 A，范围 scripts/eval/verify-pr4a-artifacts.mjs + tests/unit/eval 新测试）

形状：断言从"必须是 0"改为"必须被证明"——

- artifact **无声明**（默认，冻结产物即如此）：保留原规则 measured.count === 0 且六字段不得 precision measured（id 不变：cost-measured-zero / token-no-measured）；
- artifact **声明** `measurement:{tokenizer:true}`（或顶层 tokenizer:true）：允许 measured > 0，但 (a) counts 求和必须闭合 decisionPoints（既有 cost-counts-match）、(b) shares 求和必须 =1（既有 cost-shares-sum-1）、(c) 每个字段 precision 必须三态之一，且 (d) **measured 计数必须 >0**——声明了能力却 0 实测 = 破损采集，新 id cost-measured-capability / token-measured-capability 明确红。
- 两条原硬断言仅移入 else 分支；**冻结产物执行的同名断言数不变**（实测 checked=691 passed=691，见 §4）。

## 3. 负控制实测（三条，全部真红；tests/unit/eval/pr4a-cost-provenance-gate.test.ts）

| # | 变异 | 期望 | 结果 |
| --- | --- | --- | --- |
| 1 | 声明 tokenizer 但 measured.count 仍为 0 | cost-measured-capability:Arm-0 红 | ✅ exit 1，断言命中 |
| 2 | 无声明但某字段 precision 改 'measured' | token-no-measured:Arm-0 红（既有规则保留） | ✅ exit 1 |
| 3 | counts 求和 ≠ decisionPoints | cost-counts-match 红 + cost-measured-zero 红 | ✅ exit 1（既有规则仍然有效） |
| + | 正控制：声明能力 + 全量 measured 数据 | 两个 capability 检查通过、closure 通过 | ✅ 无失败 |
| 基线 | 无声明冻结产物 | 与改前判定完全一致 | ✅（下表 verifier） |

## 4. 可复算证据

| # | 命令 | 退出码 | 关键输出 |
| --- | --- | --- | --- |
| 1 | `pnpm exec tsc --noEmit` | **0** | （无错误） |
| 2 | `pnpm exec vitest run tests/unit/ledger --reporter=basic` | **0** | Test Files 12 passed (12) ／ Tests 193 passed (193) |
| 3 | `node scripts/eval/verify-pr4a-artifacts.mjs` | **0** | checked=691 passed=691 failed=0 ／ PASS |
| 4 | `pnpm exec vitest run tests/unit/ledger/p3c-usage-report.test.ts tests/unit/ledger/p3c-cancellation-recovery.test.ts tests/unit/eval/pr4a-cost-provenance-gate.test.ts` | **0** | 10 + 6 + 5 = 21 passed (21) |

## 5. 新增测试清单（21 条）

**tests/unit/ledger/p3c-usage-report.test.ts（10 条）**：无语义→unknown 且 unreportedMetrics 列出；显式语义逐字携带；无语义结算 provenance unknown+conservative；cacheRead 维度 unknown/auditNote；cacheRead 实测时 false；三桶分离（calls/成本/份额互不合并，measured≠estimated）；closure 通过；cacheReadUnknownCalls 计数；空事件；坏报告被 validate 捕获。

**tests/unit/ledger/p3c-cancellation-recovery.test.ts（6 条，全部为真实路径）**：这些测试用 `mkdtempSync(join(tmpdir(), 'p3c-recovery-'))` 建**真实临时目录**、经 t4 工厂 `createLedgerReservationManager` 建**真实 manager**、写**真实 WAL 文件**（ledger.events.jsonl / ledger.snapshot.json），并用 `recoverFromWal()` **真实重放**；全文无 `vi.mock`/`jest.mock`/fake 桩，仅 callId 与 usage 数据为构造值。因此它们证明的是**接线正确**（真实 WAL + 真实 factory + 真实 recoverFromWal），不只是算法正确。覆盖：cancelled 与 timed_out 各一条（interim→held→迟到对账一次→二次 no-op→守恒）；WAL 重启重建单一结算值+重启后再对账 no-op+守恒；崩溃悬挂→pending_reconciliation→一次 reconcile→二次 no-op；unknown 语义→报告 unknown 桶（measured=0）；实测语义→measured 桶。

**tests/unit/eval/pr4a-cost-provenance-gate.test.ts（5 条）**：冻结产物基线 + 三条变异负控制 + 能力正控制（§3）。

## 6. 改动文件清单

| 文件 | 变更 |
| --- | --- |
| src/ledger/types.ts | UsageMetricName；unreportedMetrics；dimensionProvenance；cacheReadUnavailable |
| src/ledger/pricing.ts | 删除语义默认猜测；unreportedMetrics；dimensionProvenance/cacheReadUnavailable/auditNote |
| src/ledger/usage-report.ts | 新增（UsageAccountingReport 三桶分列 + validate 闭合规则） |
| src/ledger/index.ts | 导出 usage-report |
| scripts/eval/verify-pr4a-artifacts.mjs | 反向门禁→能力证明形状（含头注）；**授权自队长（本任务范围内）** |
| tests/unit/ledger/p3c-usage-report.test.ts / p3c-cancellation-recovery.test.ts | 新增 16 条 |
| tests/unit/eval/pr4a-cost-provenance-gate.test.ts | 新增 5 条（PR-4A 门禁相关测试） |
| docs/reports/p3-c-usage.md | 本报告 |

未触碰：scripts/eval/pr4a-five-arm-lib.ts:1582 的历史事实（measuredCount=0 保留）、docs/reports/pr4a-five-arm-eval-report.md 的全部历史数字与标签、src/dsh-bridge/**（消费方接线不在本任务范围）、CI、package.json。

## 7. 授权边界与未执行项

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 修改 scripts/eval/verify-pr4a-artifacts.mjs | **已获队长授权（裁定 A，限定形状）** | 冻结产物 691/691 实测不变；三条变异负控制实测真红；未改该脚本其他部分。 |
| 生产消费方（agent-loop-executor / metered-adapter）改用 interim+reconcile 两阶段 | **明确缺口登记（见 §7.1）** | ledger API 已就绪并有幂等测试，但生产消费方仍是一步式结算；这是真实缺口，不是"范围外"一笔带过。 |
| 真实付费调用 / 真实宿主 smoke | **未执行（需授权）** | 全部验证为注入式离线路径 + WAL 临时目录；授权申请文本："申请以 agentLoop.ledger.enabled=true 跑一次真实探针 smoke 验证两阶段结算与迟到对账在真实 provider 流上的行为。" |

### 7.1 缺口登记：生产消费方尚未接入两阶段结算（P3-C 遗留）

**谁会受影响**：所有启用 ledger 的生产模型调用——`src/dsh-bridge/agent-loop-executor.ts`（single_call 与 agent_loop 的 settle 调用）与 `src/dsh-bridge/metered-model-adapter.ts`（call 的 settle）。当前它们在拿到 response 后**一步式** `settle(outcome, usage)`，没有 interim 阶段，也没有迟到 usage 的接入口。

**两条独立的重复记账失效路径（必须分开看）**：

- **路径甲（同一 callId）**：同一 callId 先一步式 settle，随后迟到 reconcile 到达。ledger 侧已保证 idempotent：`settle` 对已结算 callId 返回 `isIdempotentReplay`；`reconcileLateUsage` 对已结算记录按 delta 调整（同数据 delta=0）。若消费方错误地再次 `settle` 同 callId，也只是 replay，不重复扣款。**失效后果**：若消费方把 reconcile 的增量结果再次以**新 callId** 记账，问题就升级为路径乙，而不是路径甲。
- **路径乙（跨 callId）——真正的危险**：消费方收到迟到 usage 时**不按原 callId 归并，而是新开 reserve+settle**。此时 ledger 的一切幂等保护全部无效，因为从 ledger 视角这是**两次不同调用**，两次都合法记账。**失效后果：重复记账，成本与 Pareto 轴被高估。**

**接线必须遵守的契约**（供实现两阶段的人照做）：

1. reserve 时生成 `callId` 并把 `callId → reservationId` 持久化保存（至少活到该调用终止后的对账窗口）；
2. 取消/超时只允许对**同一 callId** 调 `settle({interim:true})`，不得用新 callId；
3. 迟到 usage **必须**用原 callId 调 `reconcileLateUsage`，**禁止**新开 reserve/settle；
4. 只有能证明原 callId 已不可达（例如跨进程且映射未持久化）时才允许新开，且必须在该调用上显式标注 `new-attempt` 并在报告中记录，供对账区分；
5. 调用终止后再次到达的 usage 仍走 reconcile，不再 settle。

**接线所需的改动点清单**：

- `src/dsh-bridge/agent-loop-executor.ts`：两处 `settle(...)`（single_call / agent_loop）改为 `settle({interim:true})`；把 `callId/reservationId` 写入 branch/trajectory metadata 并在取消/超时分支保留；
- `src/dsh-bridge/metered-model-adapter.ts`：`call()` 的 settle 改为 interim，并暴露 `callId/reservationId` 供上层归并；
- 宿主事件入口：当前没有"迟到 usage"事件入口（provider 回调/宿主对账事件），需要新增一个**按 callId 归并**的入口调用 `reconcileLateUsage`；
- 完成上述接线后，把本登记改为已完成，并在 `tests/unit/dsh-bridge` 增加"取消→interim→迟到 usage→一次 reconcile"的接线级测试。

## 8. 遗留风险

1. 删除语义默认值后，若未来有调用方依赖"隐式 DeepSeek 语义"，其用量会变为 unknown/conservative——这是显式的行为变化（也是本任务的验收目标）；当前仅 src/dsh-bridge/model.ts（宿主元数据）显式传语义，行为不受影响。
2. cacheReadUnavailable 仅在 pricing 层标注并进报告计数；把 cacheRead 缺失升级为"整体 provenance unknown"属于更激进的语义收紧，未实施（现有 ADR 文本只要求维度级保持 unknown）；如需收紧，在 t6 之后的语义任务中单独裁定。
3. usage-report 的闭合规则与 PR-4A 门禁共享形状但各自独立实现；若未来 verifier 要消费 UsageAccountingReport，需保持字段名同步（tests/unit/eval 的正控制测试会拦截漂移）。
4. WAL/对账测试覆盖 interim→reconcile 与 crash→reconcile 两条路径；多条迟到 usage 分批到达（增量对账）属既有 delta 语义，本任务未新增场景（已在 pr3a 套件覆盖迟到调和基础行为）。
5. tsc 全仓绿依赖并行队友文件（tests/unit/eval/p2-preregistration-v3.test.ts 等）当前处于可编译状态；本任务文件始终 0 错误。

## 9. 结论

- 计量数字现在可追溯：语义只来自显式元数据，缺省即 unknown；cacheRead 缺失在维度级与报告级都可见，不再是 measured 0。
- estimated 与 measured 在**类型层**（UsageAccountingReport 三桶）与**报告层**（本报告 §5 测试 + p3c-usage-report 套件）均分列，闭合规则由 validateUsageAccountingReport 承担。
- 取消/超时两阶段、迟到 usage 一次结算、WAL 恢复不重复记账全部由 6 条确定性测试钉死。
- 旧 PR-4A 反向门禁改为"能力声明 + 闭合证明"，冻结产物 691/691 不变，三条变异负控制实测真红。
