# t19 独立复审报告：C3 成本与预算生命周期修复（t11 F-1/F-2 关闭确认）

| 项 | 值 |
| --- | --- |
| 任务 | t19（review round 1）— 复审 C3 成本与预算生命周期修复 |
| 复审者 | evidence-reviewer（t11 F-1/F-2 的原报告者，非 t17 实现者） |
| attempt | 1 / `3d714991-fede-44bc-8f96-b96b3ab6b0dc` |
| 被复审任务 | t17（attempt 2，`f1f7f6b0-baa8-4102-bc3f-141d8992f4ee`） |
| 原始缺陷 | t11 F-1（medium）：`settle({actualCostMicros:0})` 绕过 §7.3.5 保守地板并伪造 provenance；t11 F-2（medium）：已结算 callId 再 reserve 造成不可回收的额度与席位滞留 |
| 契约口径 | ADR-0003 §7.3（计价语义，尤其 §7.3.5 未知成本非零保守）、§7.4（reserve/settle 生命周期）、§7.5（离线 fixture）、§7.6（范围）、§8.2 证据口径 |
| 复审裁定 | **PASS**（F-1 与 F-2 均关闭），附 1 项 low（dead fixture，非阻塞） |

> **复审立场**：t17 的交付说明声称"修复 + 新增 fixture"。我把这两件事**分别**验证：
> ① 修复本身用**独立重算**验（不重跑其 fixture），并且**双向**验 —— 既要证明「0 被抬到地板」，也要证明「合法的 0 不被抬」（否则就是拿一个 overcharge 缺陷换另一个）；
> ② fixture 声称则用「**有没有测试真的调用它**」验 —— 写了不等于跑过。

---

## 1. 修复内容（读源码，不读自述）

### F-1：`actualCostMicros` 分支（`reservation-manager.ts:280-345`）

原缺陷的**两个**根因都被拆开处理：

| 子情形 | 修复前 | 修复后 |
| --- | --- | --- |
| **无 usage** | `provenance:'estimated'`（**凭空估算**，没有任何估算发生）+ `total = rawMicros`（0 保持 0） | `provenance:'unknown'` + `total = Math.max(rawMicros, fallbackFloor)` + `conservative:true` + 精确 `surcharge = total − raw` |
| **有 usage 但 unknown** | `provenance:'unknown'` 但 `conservative` 只看输入精度、**完全不施加地板** ⇒ 出现「conservative=true 且金额=0」的自相矛盾 | `aggregatePrecision(...)` 定 provenance，`conservative = isUnknown`，unknown 时同样施加地板 |
| **有 usage 且已声明/measured** | — | `conservative=false`，`total = rawMicros`（**不施加地板**） |

`fallbackFloor = effectiveRateCard ? max(1, rateCard.conservativeFallbackCostMicros) : 10_000`
——注意 `max(1, ...)` 与无 rate card 时的 `10_000` 兜底，都保证了 ADR「严格大于 0」这一条。

### F-2：`reserve()` 前置检查（`reservation-manager.ts:105-134`）

```ts
if (this.callToReservation.has(callId))  → duplicate_active_call   // 既有，保留
if (this.settledCalls.has(callId))       → call_already_settled    // 新增
```

新枚举 `'call_already_settled'` 已进入 `types.ts:242` 的公开 `ReserveRejectionReason` 联合类型（我核对过：不是只在实现里用的私有字符串）。

**为什么这样修是对的**：原缺陷的机理是 `duplicate_active_call` 查 `callToReservation`，而 `settle()` 会删掉该键（`:375`）却把 `settledCalls` 留着（`:392`）。于是「已结算的 callId 可再 reserve」，而新 reservation 的 `settle` 又被幂等守卫在**扣减之前**拦截 ⇒ 额度与席位永久滞留。在 `reserve()` 入口补查 `settledCalls` 直接堵住产生路径，而不是去改幂等语义。

---

## 2. 独立复核 F-1（10 个子用例，逐笔重算）

`work/_t19-review.ts` → `work/_t19-review.json`。rate card 地板 = 10,000u。

| # | 输入 | incurred | provenance | conservative | surcharge | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| **F1-a** | `actualCost 0`，**无 usage**（原缺陷） | **10,000** | **unknown** | **true** | 10,000 | ✅ 非零、不再假盖 estimated |
| **F1-b** | `actualCost 0` + **unknown usage**（原自相矛盾） | **10,000** | unknown | true | 10,000 | ✅ 「conservative 且为 0」不再出现 |
| **F1-c** | `actualCost 0` + **已声明/measured usage** | **0** | **measured** | **false** | — | ✅ **反向对照**（见下） |
| **F1-d** | `actualCost 0`，**完全无 rate card** | 10,000 | unknown | true | 10,000 | ✅ 硬编码兜底地板生效 |
| **F1-e** | `actualCost 0`，rate card 地板声明为 **1** | **1** | — | — | — | ✅ 地板取自 rate card 而非常量 |
| **F1-f** | `actualCost 3,000` < 地板，无 usage | 10,000 | — | — | **7,000** | ✅ surcharge 精确 = 地板 − raw |
| **F1-g** | `actualCost 20,000` > 地板 + unknown usage | **20,000** | — | true | **undefined** | ✅ **不被向下夹**、不产生虚假附加费 |
| **F1-h** | `actualCost 0` + usage 为 estimated 但**无语义声明** | 10,000 | unknown | true | — | ✅ 未声明语义强制 unknown 后仍地板 |
| **F1-i** | 五种零成本组合自洽扫描 | — | — | — | — | ✅ 五种组合**无一**出现 `conservative && total===0` |
| **F1-j** | `actualCost 0` + `timed_out` | 10,000 | — | — | — | ✅ auditOnly=true、qualityEvidence=false，但花费照实记录 |

### 2.1 F1-c 是这次复审最重要的一条：**双向**验证

只证明「0 被抬到地板」是不够的 —— 一个把**所有**零成本都抬到地板的实现同样能让 F1-a/F1-b 通过，但那会把「provider 真的报了 0 token / 0 成本」这种情况**多收 10,000u**，等于用一个 overcharge 缺陷换掉一个 silent-zero 缺陷。

实测：`actualCost 0` + `inputTokens/outputTokens` 均为 `measured` 且**显式声明了 countingSemantics` ⇒ `provenance='measured'`、`conservative=false`、`incurred=0`。

**结论：地板的适用范围被正确限定在 `unknown` 成本，而不是「所有零成本」。** ADR §7.3.5 的原文是「**unknown** 必须落到保守上界」，本次实现与之逐字对齐。

---

## 3. 独立复核 F-2（6 个子用例）

| # | 场景 | 实测 | 判定 |
| --- | --- | --- | --- |
| **F2-a** | settle 后对同一 callId 再 reserve | `granted=false`、`rejectionReason='call_already_settled'` | ✅ 明确拒绝 |
| **F2-b** | 该拒绝是否留下痕迹 | `reservationId===undefined`；`reserved` 仍 0；`seats.occupied` 仍 0 | ✅ **零滞留**（t11 F-2 的原始症状消失） |
| **F2-c** | 另一个 callId 是否被误伤 | `granted=true`，正常占用 1 席位 | ✅ 无误伤 |
| **F2-d** | settle → reserve(拒) → **再次 settle** | `isIdempotentReplay=true`、返回**首发**值（不是后来传入的 99,999）、`settledMicros` 不变 | ✅ 幂等语义未回退 |
| **F2-e** | **活跃中** reservation 再 reserve | `rejectionReason='duplicate_active_call'` | ✅ 新检查**没有遮蔽**既有原因码 |
| **F2-f** | 拒绝是否产生副作用 | ledger 事件数 1 → 1（不变） | ✅ 拒绝是纯读操作 |

**F2-e 值得单独说明**：新增 `settledCalls` 检查如果不小心放在 `callToReservation` 之前、或复用了同一个原因码，会让「同一活跃 call 重复请求」被误报成 `call_already_settled`，从而掩盖真实的并发冲突。实测两条分支各报各的码。

---

## 4. 原 C3 语义无回退（R 组，逐项重算）

| 项 | 实测 | 判定 |
| --- | --- | --- |
| cacheRead 防重复计费 | 1,000,000−400,000=**600,000** 净输入 → **2,640,000** | ✅ 与 t11 手算一致 |
| reasoning 防重复计费 | **700,000** 净输出 → **2,300,000** | ✅ |
| 纯未知成本地板（非 actualCost 路径） | **10,000**，provenance unknown、conservative true | ✅ |
| 幂等结算（**地板之上**） | 20,000 → 20,000，`isIdempotentReplay=true` | ✅ |
| 幂等结算（**地板之下**） | 7,000 → **先抬到 10,000**；replay 返回 **10,000**（不是 99,999） | ✅ 抬一次、之后按抬后值幂等 |
| seat 释放 ≠ 金额退款 | `seatReleased=true`、`refund=0`（incurred ≥ reserved） | ✅ |
| fail-closed 不透支 | 池 1,000 占 900 后拒 200，`insufficient_budget`，余量仍 100 | ✅ |
| 验证池专款专用 | 通用池耗尽后验证池仍可 grant | ✅ |
| 异常执行 audit-only | cancelled/timed_out/infra/failed 四者 `auditOnly=true && !qualityEvidence`；succeeded 为 `qualityEvidence=true` | ✅ |

> **一处我自己的探针 bug（如实记录）**：R 组最初用 `actualCost 7,000` 断言「幂等返回 7,000」，结果失败 —— 因为修复后 7,000 会被**正确地**抬到 10,000。这是我的断言沿用了修复前的期望，不是实现缺陷。我把它拆成两条（地板之上验幂等、地板之下验「抬一次且按抬后值幂等」）后通过。**这条失败本身反过来证明了 F-1 修得是生效的。**

---

## 5. 门禁（全部 exit 0）

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `pnpm exec vitest run tests/unit/ledger` | **exit 0** — 3 files / **33 tests** |
| 2 | `node scripts/eval/guarded-regression.mjs --json` | **exit 0** — `{total:33, passed:33, failed:0}` |
| 3 | `pnpm run typecheck` | **exit 0** — 0 error |
| 4 | `pnpm test` | **exit 0** — **86 files / 1663 tests** |
| 5 | `pnpm run check:docs` | **exit 0** — Unit 74/1506、E2E 12/157、Total **86/1663**，与 README 逐项一致 |

与 t16 时点对比：当时那 2 条 ledger 失败与 `check:docs` exit 1 **现已全部消失**，证实 t16 报告的归因（t17 中间态）正确。

---

## 6. 范围与无接线审计（ADR §7.6）

| 检查 | 结果 |
| --- | --- |
| t17 实际改动的文件 | **恰为 4 个**，与其交付说明逐一吻合：`src/ledger/types.ts`（`1D6DAD84`）、`src/ledger/reservation-manager.ts`（`18CA2B20`）、`scripts/fixtures/ledger/scenarios.ts`（`54A3110D`）、`tests/unit/ledger/reservation-manager.test.ts`（`08397500`） |
| 未改动的 ledger 文件 | `pricing.ts`（`4831A17D`）、`ledger-event.ts`（`333959A8`）、`index.ts`（`DBFC706F`）—— 三个哈希与 t13 基线**完全相同** |
| 是否触碰 outOfScope | ✅ `src/index.ts`（`D2693183`）、`src/orchestrator.ts`（`DE6439B0`）、`src/verification/attach.ts`（`A98D17A8`）哈希与 t20 记录**逐一相同**；`src/jitrl/reward-contract.ts` 等冻结文件 diff 为空 |
| r4 是否被触碰 | ✅ `src/ledger/**` 对 `reward|learningTarget|contractWeightsHash|REWARD_CONTRACT` **零引用** |
| 是否新增生产接线 | ✅ `src/ledger` 在 `src/ledger` 之外**零 import** ⇒ 仍为纯数据契约 |
| 是否真实付费调用 / 动态路由 / 输出折叠 | ✅ 无（纯离线合成数字） |
| 是否宣称收益或节省 | ✅ 无 |
| 是否 commit/push | ✅ 无 |

---

## 7. 发现

### Y-1（low，非阻塞）t17 新增的三条离线 fixture 场景是**死代码**，无任何测试调用

**事实**（`work/_t19-fixtures.json`）：

t17 在 `scenarios.ts` 新增了 `runActualCostZeroWithoutUsageScenario`（Scenario 9）、`runActualCostZeroWithUnknownUsageScenario`（Scenario 10）、`runReserveAfterSettleRejectedScenario`（Scenario 11）。我逐个**实际执行**了它们 —— 三条**逻辑全部正确**：

| 场景 | 执行结果 |
| --- | --- |
| S9 | `incurred=10,000`、provenance `unknown`、conservative `true`、`isStrictlyNonZeroConservative=true` |
| S10 | `incurred=10,000`、surcharge 10,000、`isSelfConsistent=true` |
| S11 | 首次 reserve 授予、reReserve 拒绝且 `call_already_settled`、无关 callId 正常、`noLedgerLeakage=true` |

但它们**没有任何调用者**（全仓 grep，仅命中自身定义处）：

```
runActualCostZeroWithoutUsageScenario   → 0 个测试引用
runActualCostZeroWithUnknownUsageScenario → 0 个测试引用
runReserveAfterSettleRejectedScenario   → 0 个测试引用
```

`tests/unit/ledger/offline-fixtures.test.ts` 只导入并测试了 Scenario 1–8，**没有 9/10/11**。

**为什么记 low 而非 needs_revision**：
1. **F-1/F-2 的实际判别力不在 fixture 层**：`reservation-manager.test.ts` 里 t17 新增的 3 条专用用例是**真判别性**的 —— 我核对过它们断言 `incurred===10,000` + `provenance==='unknown'` + `conservative===true` + `surcharge===10,000`，以及 `reReserve.rejectionReason==='call_already_settled'` + `reserved===0` + `seats.occupied===0` + 其他 callId 不受阻。这些断言在修复前的实现上**必然失败**，所以覆盖真实存在。
2. 死 fixture 不造成安全或正确性风险，只是**冗余代码**，且会让「§7.5 六阶段/边界场景覆盖」看起来比实际更全。
3. 它属于 t17 交付说明中「新增 Scenario 9/10/11」这一句的**证据强度**问题，而不是缺陷。

**建议**（一行级）：在 `offline-fixtures.test.ts` 里补 3 个 `it(...)` 调用这三个场景（它们已经做完了断言计算并返回 `isStrictlyNonZeroConservative` / `isSelfConsistent` / `noLedgerLeakage`，测试只需 `expect(res.X).toBe(true)`），或在 t12 状态页把 fixture 覆盖表述收窄为「Scenario 1–8 有测试执行，9–11 为预留」。

---

## 8. 结论

| 验收项 | 判定 | 依据 |
| --- | --- | --- |
| zero/unknown 不再绕过保守非零地板且 provenance/conservative 自洽 | **PASS** | §2：F1-a/b/d/h 四条零成本用例全部落到 10,000 地板、provenance `unknown`、conservative `true`、surcharge 精确；F1-e 证明地板取自 rate card 而非常量；F1-f 证明 surcharge = 地板−raw 精确；F1-i 五种组合无一出现「conservative 且 0」。**F1-c 反向对照**证明地板的适用范围被正确限定在 unknown，未把 measured 的合法 0 多收成 10,000；F1-g 证明高于地板的成本不被向下夹 |
| settled callId 再 reserve 明确拒绝且无额度或座位滞留 | **PASS** | §3：F2-a 明确 `call_already_settled`；F2-b 无 `reservationId`、`reserved=0`、`seats.occupied=0`（t11 F-2 原始症状消失）；F2-c 不误伤其他 callId；F2-d 幂等未回退且返回首发值；F2-e 活跃 reservation 仍报 `duplicate_active_call`（新检查未遮蔽既有码）；F2-f 拒绝无副作用 |
| 正反例非空洞，原 C3 算术/预算/离线范围无回退 | **PASS** | §4 九项逐一重算全过（含 cacheRead/reasoning 去重、地板之上与之下两种幂等、seat≠refund、fail-closed、池隔离、异常 audit-only）；§6 范围恰 4 文件、三个未改 ledger 文件哈希与 t13 基线相同、r4 零引用、零生产 import。附 Y-1（low）：新增 fixture 场景 9–11 逻辑正确但无测试调用 |
| 相关门禁通过且未生产接线 | **PASS** | §5 五门禁全 exit 0（33 led tests / 33 guarded / typecheck / 86 files 1663 tests / check:docs）；§6 `src/ledger` 在自身之外零 import ⇒ 无生产接线；无付费/收益宣称；未 commit/push |

**verdict = pass**。t11 F-1 **与** F-2 **均关闭**，且都是以「逐笔重算 + 双向对照 + 无反回退」三重证明关闭的。修复的最小性也成立：只改 4 个文件、未碰任何冻结契约、未引入生产接线。

**唯一登记项 Y-1（low）**：`scenarios.ts` 里 t17 新增的 Scenario 9/10/11 逻辑正确但**无测试调用**，属冗余代码；建议补 3 条调用或在状态页收窄表述。不影响 F-1/F-2 的覆盖真实性（判别力在 `reservation-manager.test.ts`）。

**未做**：真实付费模型调用、真实 memory、部署、commit/push；未评 C1.1（t10/t16 已结）、C2a（t20 已结）、C4。
