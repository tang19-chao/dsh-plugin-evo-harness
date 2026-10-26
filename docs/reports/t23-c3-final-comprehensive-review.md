# t23 终态 C3 全路径独立综合评审

| 项 | 值 |
| --- | --- |
| 任务 | t23（review round 2）— 终态 C3 全路径独立综合评审 |
| 评审者 | evidence-reviewer（t11 F-1/F-2、t19 的原报告者，非 t6/t17/t21 实现者） |
| attempt | 1 / `75069797-6c33-414b-9882-a089864c2a6c` |
| 被评审范围 | t6（基础契约）→ t17（F-1/F-2 修复）→ t21（Scenario 9–11 测试接线）的**全部当前字节** |
| 契约口径 | ADR-0003 §7.2（独立契约理由）、§7.3（计价语义，含 §7.3.5 未知成本非零保守与 §7.3.6 花费≠证据）、§7.4（reserve/settle 生命周期）、§7.5（离线 fixture 确定性/零网络零费用）、§7.6（范围）、§8.1（六态词汇）、§8.2（证据口径） |
| 裁定 | **PASS**（终态 C3 契约成立），附 2 项 low、1 项需 t12 知悉的指纹漂移 |

> **评审立场**：这是终态综合评审，不是增量复审。所以三件事必须同时做到：
> ① **逐文件**审阅并哈希绑定 `src/ledger`(5) + `scripts/fixtures/ledger`(4) + `tests/unit/ledger`(3) 共 **12 个文件**，不留 unaudited path；
> ② 把 t11→t17→t19→t21 四轮的**旧 verdict** 全部重新绑到**当前字节**上，并用 t12 记录的指纹做交叉核对 —— 对不上就查到底，不含糊；
> ③ 对「契约完成」与「生产未接线」做**真实区分**，不用「已交付」这种可以两头读的措辞。

---

## 1. 逐文件审阅与哈希绑定（12 个文件，无 umaudited path）

### 1.1 `src/ledger/**`（5 文件）

| 文件 | sha256 | 字节 | 本轮审阅要点 |
| --- | --- | --- | --- |
| `index.ts` | `dbcf706f4f4959e7…` | 398 | 纯 barrel（`export *` ×4），无逻辑 |
| `types.ts` | `1d6dad849522ed34…` | 9,610 | 契约全集；`ReserveRejectionReason` 含 `call_already_settled`（t17 新增）；`conservativeFallbackCostMicros` 文档写明「必须严格 > 0」 |
| `pricing.ts` | `4831a17d7a520eeb…` | 7,231 | `calculateUsageCost`：cacheRead/reasoning 去重、三态精度传播、unknown 地板。**本轮未被任何后续任务修改**（哈希=t13 基线） |
| `ledger-event.ts` | `333959a84e60fde0…` | 2,183 | `isMandatoryAuditOnlyOutcome` 把 cancelled/timed_out/infra/**failed** 一律锁 audit-only；`qualityEvidence` 还要求 `provenance !== 'unknown' && !conservative` |
| `reservation-manager.ts` | `18ca2b20a2bfe288…` | 17,081 | reserve/settle/releaseSeat + 池与席位；t17 的 F-1/F-2 修复在此 |

### 1.2 `scripts/fixtures/ledger/**`（4 文件）

| 文件 | sha256 | 字节 | 要点 |
| --- | --- | --- | --- |
| `index.ts` | `b7dda524f808eebf…` | 168 | barrel |
| `sample-rate-cards.ts` | `f2f09b78e1b31c3184…` | 2,664 | 4 张合成费率卡（OpenAI/Anthropic/DeepSeek/fallback），地板分别 10k/50k/20k/25k micros，全部 > 0 |
| `synthetic-payloads.ts` | `9f5286ac720a1f1d…` | 3,707 | 6 阶段 payload + 4 类边界（unknown / partially unknown / cancelled incurred） |
| `scenarios.ts` | `54a3110d02493875…` | 17,169 | **11 个场景函数**（1–8 基础 + 9/10/11 t17 新增） |

### 1.3 `tests/unit/ledger/**`（3 文件，共 36 测试）

| 文件 | sha256 | 字节 | `it()` 数 |
| --- | --- | --- | --- |
| `offline-fixtures.test.ts` | `96189b6a00824d36…` | 6,699 | **12**（Scenario 1–11 + 1 条 r4 边界） |
| `pricing.test.ts` | `28f7d90bdff4aae9…` | 8,430 | **10** |
| `reservation-manager.test.ts` | `0839750086a59646…` | 15,133 | **14** |

**合计 12 + 10 + 14 = 36**，与 `vitest` 实测 `3 files / 36 tests` **精确一致**。

---

## 2. 旧 verdict 重绑（关闭「未绑定当前字节」）

### 2.1 t11（评审）→ 已过期，本轮为新结论

t11 的 verdict 绑的是 `types 556dbd78 / reservation 428b8ff0 / scenarios defd8565 / offline-test b7b93264`。当前值分别为
`1d6dad84 / 18ca2b20 / 54a3110d / 96189b6a` —— **四个全变**。t11 的 pass 已不成立，本报告即其终态替代。

### 2.2 t19（复审）→ 增量结论仍有效，但需扩展到全 12 文件

t19 只覆盖 `reservation-manager` / `types` 与「场景是否被调用」。本轮在同一字节上**重新执行了 t19 的独立探针**（`work/_t23-c3-recheck.json`），结论不变：

```
verdict = F1_F2_CLOSED_NO_REGRESSION, failures = 0
F1a (0+无usage): incurred=10000, provenance=unknown, conservative=true, surcharge=10000
F1c (0+measured): incurred=0,    provenance=measured, conservative=false   ← 反向对照仍成立
F2  (重复reserve): reason=call_already_settled, reserved=0, seatsOccupied=0
```

### 2.3 t21（测试接线）→ **本轮首次独立确认 Y-1 已真正关闭**

t19 的 Y-1 是「Scenario 9/10/11 是死 fixture」。t21 声称已接入。我不采信自述，用**两种方法**验证：

1. **静态**：`scenarios.ts` 定义 **11** 个 `run*Scenario` 函数；对每个函数名在 `tests/unit/ledger/*.ts` 中 grep → **11 个全部 testRefs=2**（import + 调用）。
2. **计数**：`offline-fixtures.test.ts` 从 9 个 `it()` 增至 **12** 个，新增三个正是 Scenario 9/10/11。

并读了三条新测试的断言强度：

| 场景 | 断言要点 | 判别力 |
| --- | --- | --- |
| S9 | `isStrictlyNonZeroConservative===true`、`incurred>0`、`provenance==='unknown'`、`conservative===true` | 修复前（`estimated` + 0）**必失败** |
| S10 | `isSelfConsistent`、`surcharge>0`、`incurred===surcharge` | 修复前（conservative=true 且 0）**必失败** |
| S11 | `rejectionReason==='call_already_settled'`、`noLedgerLeakage`、`unaffectedCallGranted` | 修复前（该枚举不存在、泄漏发生）**必失败** |

**Y-1 关闭**，且不是靠删改旧用例换来的（原 9 项「原样保留、零弱化」我抽查了 Scenario 1–8 的断言，无改写）。

### 2.4 t12（集成）的指纹 ↔ 当前字节（**一处漂移，已精确定位**）

| t12 记录 | 我的实测 | 结论 |
| --- | --- | --- |
| HEAD `9ea9b7e…` | `9ea9b7edacb199884df2020df879f4e59ed66d73` | ✅ 一致 |
| Tracked Diff SHA-1 `846c85ee…` | 全树 `c28d10a4…`；**排除 `docs/P62_STATUS.md` 后 = `846c85ee…`** | ⚠️ 见下 |
| Tracked Diff SHA-256 `bd6fad15…` (96,795B, 11 files) | 全树 `f9bb02c1…` (129,600B, **12** files) | ⚠️ 同源 |
| 代码组合指纹 `c631c281…` (205 files) | **`c631c281…`（205 files）精确复现** | ✅ 一致 |

**漂移定位（唯一原因，不是多个）**：`docs/P62_STATUS.md` 在 t12 计算指纹**之后 40 秒**被编辑（closure report mtime `4:08:36` < P62_STATUS mtime `4:09:16`）。我用 `git diff -- . ':(exclude)docs/P62_STATUS.md'` 重算，SHA-1 **精确得到 `846c85ee…`** —— 即除了这一个文件，t12 的指纹对当前字节仍然成立。

**代码组合指纹的复现**：t12 报告只写了「排序 `path:sha256` 组合后 SHA-256」，未给分隔符/换行/路径形态。我穷举了 12 种变体，**`相对路径` + `:` + `行排序` + `无尾换行`** 精确命中 `c631c281…`，且文件数 205 与记录一致 ⇒ **该指纹可信，且可复算**。

---

## 3. 语义要求逐项独立验证（`work/_t23-c3-recheck.json` + `_t23-determinism.json`）

### 3.1 零/未知成本保守地板

| 用例 | incurred | provenance | conservative | surcharge |
| --- | --- | --- | --- | --- |
| `actualCost 0` 无 usage | **10,000** | unknown | true | 10,000 |
| `actualCost 0` + unknown usage | **10,000** | unknown | true | 10,000 |
| 无 rate card，`actualCost 0` | **10,000**（硬编码兜底） | unknown | true | 10,000 |
| rate card 地板声明为 1 | **1**（地板取自卡，非常量） | — | — | — |
| `actualCost 3,000` < 地板 | **10,000** | — | — | **7,000（精确）** |
| 五种零成本组合扫描 | — | — | — | **无一** `conservative && total===0` |

### 3.2 **真实 measured 零（反向对照，最能防「用 overcharge 换 silent-zero」）**

`actualCost 0` + 显式 `countingSemantics` + `measured` 精度 ⇒ **incurred = 0、provenance = `measured`、conservative = false**。

若地板被错误地施加到**所有**零成本，这里就会变成 10,000 —— 那等于对 provider 真报的 0 多收一个地板，缺陷方向反转。实测保持 0 ⇒ **地板范围严格限定在 `unknown`**，与 ADR §7.3.5 原文「**unknown** 必须落到保守上界」逐字一致。

反方向也验了：`actualCost 20,000` > 地板 ⇒ **不被向下夹**、无虚假附加费。

### 3.3 防重复计价（逐笔手算复核）

| 项 | 实测 | 手算 |
| --- | --- | --- |
| cacheRead 去重（`inputIncludesCacheRead`） | netInput=600,000；total=**2,640,000** | 600,000×1 + 400,000×0.1 + 1,000,000×2 = 2,640,000 ✅ |
| reasoning 去重（单独计价） | netOutput=700,000；total=**2,300,000** | 700,000×2 + 300,000×3 = 2,300,000 ✅ |
| 纯未知地板（非 actualCost 路径） | 10,000 / unknown / true | = 卡上地板 ✅ |

### 3.4 幂等

| 项 | 实测 |
| --- | --- |
| 地板**之上** 20,000 → 再 settle | 20,000，`isIdempotentReplay=true` |
| 地板**之下** 7,000 → 再 settle | 首次**抬到 10,000**；replay 返回 **10,000**（不是后来传入的 99,999） |
| t17 新检查是否破坏幂等 | 否（settle→reserve(拒)→settle 仍幂等且返回首发值） |

### 3.5 池隔离与 fail-closed

| 项 | 实测 |
| --- | --- |
| 通用池 fail-closed | 池 1,000 占 900 后拒 200，`insufficient_budget`，余量仍 100（**不透支**） |
| 验证池专款专用 | 通用池耗尽后验证池仍可 grant 5,000 |

### 3.6 重复预留拒绝

| 项 | 实测 |
| --- | --- |
| 已结算 callId 再 reserve | `granted=false`、`call_already_settled` |
| 是否滞留 | `reservationId===undefined`、`reserved=0`、`seats.occupied=0` ⇒ **零泄漏** |
| 是否误伤 | 另一 callId 正常授予 + 占 1 席 |
| **活跃** reservation 再 reserve | 仍报 `duplicate_active_call`（新检查**未遮蔽**既有原因码 —— 否则会掩盖真实并发冲突） |
| 拒绝是否产生副作用 | ledger 事件数不变（纯读） |

### 3.7 花费 ≠ 质量证据（§7.3.6）

`cancelled / timed_out / infrastructure_error / failed` 四者 `auditOnly=true` 且 `qualityEvidence=false`，但 `incurred > 0` **照实记录**；`succeeded` 为 `qualityEvidence=true`。`ledger-event.ts` 还额外要求 `provenance !== 'unknown' && !conservative` 才给 `qualityEvidence` —— 即**未知成本的成功调用也不是质量证据**。

---

## 4. 离线 fixture 确定性与零副作用（§7.5）

t21 的场景用 `Date.now()` 生成 callId，所以**字节级**确定性不可能。我改为验证**真正重要**的层：**金额是否可复现**。

| 场景 | 两次运行金额投影（phase/outcome/incurred/total/provenance/conservative/auditOnly/qualityEvidence/token/net/breakdown） | 一致 |
| --- | --- | --- |
| Scenario 5 全 6 阶段 | 6 条事件 | **✅** |
| Scenario 1 重复计费 | — | **✅** |
| Scenario 3 未知 usage | — | **✅** |
| Scenario 9 零成本 | — | **✅** |
| Scenario 11 重复预留 | — | **✅** |

同时**如实记录**：`eventId` 确实跨运行变化（实测样本 `evt_probe_unknown_usage_call_1793045792980_…`）。这不是缺陷 —— ADR §7.5 要求的是「合成数字、不读真实账单」，且**没有任何测试断言 timestamp/eventId**（我 grep 过，零命中），所以套件不会因此变成时间相关。

**零网络零费用**：对 `src/ledger/` 五个文件扫描 `node:http|https|fetch(|node:fs|net|dns|child_process` → **0 命中**。

---

## 5. 范围与「契约完成 vs 生产未接线」的真实区分

| 检查 | 实测 | 判定 |
| --- | --- | --- |
| `src/ledger` 在自身之外是否被 import | **0 处**（`src/*.ts` + `src/**/*.ts` grep） | **零生产接线** |
| ledger/测试内是否有 r4 引用 | 生产与 fixture **0 处**；唯一提及在测试的「边界断言」内 | r4 未耦合 |
| `reward-contract.ts` / `contracts.ts` / `dsh-bridge/model*.ts` diff | **空** | 冻结契约未动 |
| 是否新增动态路由 / 输出折叠 | 无相关代码 | ✅ |
| 是否真实付费调用 | 全为合成 micros；零网络扫描通过 | ✅ |
| 是否宣称收益 / 节省 / 已部署 | 报告与状态表均为「契约与 fixture」措辞，无收益声明 | ✅ |
| 是否 commit/push | 无 | ✅ |

**「契约完成」的准确定义（本报告采用 ADR §8.1 六态）**：
`implemented` ✅ ／ `wired` ❌（无生产接线）／ `default_enabled` ❌ ／ `independently_verified` ✅（本报告）／ `release_authorized` ❌ ／ `actually_applied` ❌。

即：**C3 本轮交付的是「可测试的数据基础」，不是「可用的成本门禁」**。任何把 ledger 读成「已在生产记账/省钱」的表述都是错的。t12 的收口报告与 `P62_STATUS` 在这点上措辞正确（明确写了「保持零生产接线」）。

---

## 6. 门禁（全部 exit 0）

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `pnpm exec vitest run tests/unit/ledger` | **exit 0** — 3 files / **36 tests**（12+10+14） |
| 2 | `pnpm run typecheck` | **exit 0** — 0 error |
| 3 | `pnpm test` | **exit 0** — **86 files / 1666 tests** |
| 4 | `pnpm run check:docs` | **exit 0** — Unit 74/1509、E2E 12/157、Total **86/1666**，README 逐项一致 |
| 5 | `node scripts/eval/guarded-regression.mjs --json` | **exit 0** — `{total:33, passed:33, failed:0}` |

测试计数三方一致：文件内 `it()` 手工计数 36 ↔ vitest 实测 36 ↔ README `74 files/1509`（unit）与全量 86/1666。

---

## 7. 发现

### Z-1（low）r4 边界测试在文件内是**空转**的

`offline-fixtures.test.ts:152` 的 `'Contract boundary: r4 learningTarget and reward weights remain completely untouched'` 遍历 `manager.getLedgerEvents()`。但 `beforeEach` **每次都重建 manager**，而该用例自己不做任何 reserve/settle ⇒ `events` 为空数组 ⇒ `for` 循环体**一次都不执行**。

实测（`work/_t23-boundary.json`）：在文件顺序下该用例拿到的 `eventCount = 0`，`wouldIterateNothing = true`。

**为什么仍是 low**：① 断言谓词本身有效（我注入 `{learningTarget:1}` 后谓词**能**捕获）；② r4 属性由**更强的独立证据**保证：`src/ledger` 与 fixture 对 `reward|learningTarget|contractWeightsHash|REWARD_CONTRACT` **零引用**，且 `reward-contract.ts`/`contracts.ts`/`model*.ts` **diff 为空**；③ 不影响任何金额或资格的结论。
**建议**（一行）：把该用例改成先跑一个场景（如 `runAllPhasesWorkflowScenario(manager)`）再遍历，或直接删掉这条空转用例、把 r4 边界交给「零引用 + 空 diff」的机械审计。

### Z-2（low）fixture 场景用 `Date.now()` 生成 callId，字节级不可复现

11 个场景均用 `` `zero_no_usage_${Date.now()}` `` 之类生成 callId，`ledger-event.ts:24` 与 `reservation-manager.ts:177` 也用 `Date.now()`。

**为什么是 low**：① **金额投影两次运行完全一致**（§4 五个场景全 ✅），审计关切的数值可复现成立；② 无任何测试断言 id/timestamp，套件不因此变成时间相关；③ ADR §7.5 只要求「合成数字、不读真实账单」。
**建议**（可选）：若将来要把 ledger 事件当跨进程对照的黄金文件，再引入可注入 `now()`（与仓库既有 `now?: () => number` 惯例一致）。

### Z-3（需 t12 知悉，非 C3 缺陷）`docs/P62_STATUS.md` 在 t12 指纹计算之后被编辑

如 §2.4 精确定位：整个工作树 diff 的 SHA-1/SHA-256 与 t12 记录**对不上**（`c28d10a4…` vs `846c85ee…`；12 files/129,600B vs 11 files/96,795B），**唯一原因**是 `P62_STATUS.md` 在 t12 算完指纹 40 秒后被写。排除该文件后指纹**精确复原**，代码组合指纹（205 files）也**精确复原**。

**后果**：`P62_STATUS.md:19` 仍写着「（96,795 bytes，11 files modified）」，与当前工作树不符 —— 一个**自指的陈旧数字**。

**建议**：由于 `P62_STATUS.md` 本身就是 t12 指纹覆盖的对象，任何对它的再编辑都会让指纹自失效。可行做法二选一：① 在状态表里把「工作树 diff 指纹」改为**排除该文档**的口径并标注；② 在最终定稿时把 `P62_STATUS.md` **最后**写、写完后重算并回填。**不阻塞 C3**，但若不处理，t12 的「指纹绑定」在审计意义上不成立。

---

## 8. 结论

| 验收项 | 判定 | 依据 |
| --- | --- | --- |
| `src/ledger`、`scripts/fixtures/ledger`、`tests/unit/ledger` 全部当前文件均经逐文件审阅与哈希绑定 | **PASS** | §1：**12 个文件**（5+4+3）逐一列出 sha256 与字节数并给出审阅要点，无 unaudited path；`index.ts`/`types.ts`/`pricing.ts`/`ledger-event.ts`/`reservation-manager.ts` 与 4 个 fixture、3 个测试文件全覆盖 |
| 零/未知成本保守地板、真实 measured 零、防重复计价、幂等、池隔离、重复预留拒绝均正确 | **PASS** | §3 六组：地板（a–f 含无卡兜底与地板取自卡）、**measured 零反向对照**（保持 0，证明未用 overcharge 换 silent-zero）+ 高于地板不向下夹、cacheRead 2,640,000 与 reasoning 2,300,000 手算吻合、两地板区幂等、fail-closed 不透支 + 池隔离、重复预留 `call_already_settled` 零泄漏且不遮蔽 active 码 |
| Scenario 1–12 均实际被测试调用，ledger 36 项与全量 1666 项测试一致 | **PASS**（精度见下） | 场景**函数**为 **11 个**（1–8 基础 + 9/10/11），**11 个全部**被测试引用（testRefs=2）；`offline-fixtures.test.ts` 共 **12 个 `it()`** = 11 场景 + 1 条 r4 边界 ⇒ 验收措辞里的「Scenario 1–12」实为「12 条用例」，非 12 个场景，本报告按实测事实记录。ledger 36（12+10+14）↔ vitest 36 ↔ README unit 74/1509、全量 86/1666 三方一致 |
| 无生产接线/r4/路由/付费改动，报告真实区分契约完成与生产未接线 | **PASS** | §5：`src/ledger` 自身之外 **0 import**；r4 生产与 fixture 零引用、冻结契约 diff 为空；零网络扫描通过；无收益/部署宣称。§5 末按 ADR §8.1 明确给出六态：`implemented ✅ / wired ❌ / default_enabled ❌ / independently_verified ✅ / release_authorized ❌ / actually_applied ❌`，即**交付的是可测试数据基础，不是可用成本门禁** |

**verdict = pass**。终态 C3 全路径成立：基础契约（t6）、两处缺陷修复（t17）、死 fixture 接线（t21）**三者在同一份当前字节上互相自洽**，且 t11 的过期 verdict 已由本报告替代、t19 的增量结论已在新字节上复跑确认。

**登记项**：Z-1（low，r4 边界用例空转）、Z-2（low，fixture 用 `Date.now()` 故字节级不可复现但金额可复现）、Z-3（**需 t12 知悉**：`P62_STATUS.md` 在指纹后被写，导致其自指的「96,795B / 11 files」陈旧；排除该文件后指纹与代码组合指纹均精确复原）。

**未做**：真实付费模型调用、真实 memory、部署、commit/push；未评 C1.1（t10/t16）、C2a（t20）、C4。
