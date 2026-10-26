# t11 独立评审报告：C2a 与 C3 契约

| 项 | 值 |
| --- | --- |
| 任务 | t11（review round 1）— 独立评审 C2a 与 C3 契约 |
| 评审者 | evidence-reviewer |
| attempt | 1 / `c9e3afd3-cfc8-403d-8800-179f44e70925` |
| 被评审任务 | t5（C2a 实现）、t6（C3 实现）；前置 t8（C2a 独立验证）、t9/t13（C3 验证与字节复核） |
| 契约口径 | ADR-0003 §4（C2a：T1–T6 / §4.2 字段 / §4.3 真值表 / §4.4 双回执 / §4.5 默认退化 / §4.6 枚举 / §4.6a 三精度 / §4.7 幂等）、§5（字段/两门/support）、§7（C3：§7.3 计价 / §7.4 生命周期 / §7.5 fixture / §7.6 范围）、§8.2 证据口径 |
| 评审裁定 | **PASS**，附 3 项不阻塞缺陷（C3 2 项 + C2a 1 项） |
| 前置条件 | t13 已关闭 C3 字节与 README 计数缺口，本 verdict 绑定其**之后**的当前字节（§6） |

> **评审立场**：不以形状/布尔值当证据。C2a 的结论必须来自**真实宿主 runner + 真实 artifact + 真实 scorer**；C3 的结论必须来自**逐笔金额算术**，而不是「有保守字段」。
>
> **独立性来源**：t5/t8 主要验证**正常路径**与**已列举的反例类别**。本评审反过来做三件它们没做的事：
> ① 用**分支自报的完整合法回执**（真的 verifierId + 真的 digest + 完整 binding）去撞 attach，看哪些字段会被替换、哪些会被透传；
> ② 追问 `verificationAudit` 这个**宿主审计通道**本身能否被分支伪造（t8 只测了 `metadata.verification`）；
> ③ 对 C3 做**算术对账 + 生命周期错序**（reserve 在 settle 之后再发一次），而不是重跑 fixture 剧本。

---

## 1. 门禁结果（全部独立复跑，exit 0）

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `pnpm exec vitest run tests/unit/verification tests/unit/ledger tests/unit/cordis-seams/trajectory-collector-c2a.test.ts tests/e2e/c2a-trusted-verification.test.ts` | **exit 0** — 8 files / **81 tests** passed |
| 2 | `node scripts/eval/guarded-regression.mjs --json` | **exit 0** — `{total:33, passed:33, failed:0}`；**8 条 C2a 专项探针全 passed** |
| 3 | `pnpm run typecheck` | **exit 0** — `tsc --noEmit`，0 error |
| 4 | `pnpm test` | **exit 0** — **85 files / 1647 tests** passed |
| 5 | `pnpm run check:docs` | **exit 0** — Unit 73/1493、E2E 12/154、Total **85/1647**，与 README 逐项一致 |

---

## 2. C2a：可信来源能否被伪造（自建探针 `work/_t11-verify.ts` + `_t11-followup.ts`）

探针 `work/_t11-verify.json` / `_t11-followup.json`。每条用例都尽量给**最强伪造**：真 verifierId、真 digest、完整 8 字段 binding、`kind:'host-runner'`、逐项合法的 checks。

| # | 伪造形态 | attach 判定 | scorer 结论 | ADR 条款 |
| --- | --- | --- | --- | --- |
| **1a** | 分支自报**完整合法回执**（真 id + 真 digest + 完整 binding），**有 seam** | `attached=true, authenticated=true`；**分支的 `checks:['forged']` 被替换为宿主的 `['json-ok']`** | `trustedSource` 只反映**宿主**真回执 | T2 ✅ |
| **1a'** | **同一份伪造轨迹，无 seam** | 不 attach | `trustedSource=false`、`taskQualityEvidence=false`；分支自报的 `status='passed'` **不产生任何证据** | T2/§4.5.1 ✅ |
| **1b** | 伪造合法回执 + **artifact 缺失**（空 content、无 producedFiles） | `artifact-missing`，`attached=false`，`metadata.verification` **被剥离** | `trustedSource=false`、`taskQualityEvidence=false` | §4.6 R-a ✅ |
| **1c** | 伪造**宿主审计通道** `metadata.verificationAudit`（无 seam） | 见 **F-3** | `verificationTrusted` 仍 0 | T2 部分 |
| **1e** | 伪造 `verificationAudit` + **有 seam** | 宿主 mark **覆盖**分支 mark（`authenticated=true, auditOnly=false, verdict` 来自宿主） | — | T2 ✅ |
| **1f** | runner 返回**未注册**回执 | `unregistered-receipt`，`attached=false` | — | T1/T2 ✅ |

**关键结论（对应验收项 1「任意分支 metadata 不能伪造可信来源」）：成立。** 三条独立证据：
1. 伪造回执即使**每个字段都真**，无 seam 时 `trustedSource=false`；
2. 有 seam 时被判可信的**只有宿主注册表里那一个对象**（`registered !== receipt` 即拒，`attach.ts:361-368`），分支声明的 checks 被整体替换；
3. scorer 的 `trustedSource` 还要求 `verdict-derived completion + 注入的 producer 集合 + digest 等于 `deliverable.contentHash``（`step-evaluator.ts:909-917,932-936`），而该 digest 由**宿主覆盖写入**（T3），分支无法自证。

**「错绑和异常不能成为可靠通过」**：`artifact-missing` / `unregistered-receipt` / `stale-artifact` / `binding-mismatch` / `run-mismatch` / `test-set-mismatch` / `env-mismatch` / `digest-mismatch` / `implicit-payload` / `contradictory-verdict` / `execution-not-completed` / `reference-receipt-missing` 全部走 `attached=false` + `auditOnly=true`（或 falsified 的 `attached=true, auditOnly=true`），且都带**具体 reasonCode**——符合 §4.6a(3)「不能只看 `trustedSource===false`」。我逐条读了 `attach.ts:298-465` 的判定顺序，未发现任何「先 attach 再校验」的次序漏洞。

**默认装配不可伪造**（`_t11-followup.json` → `FA_q3_productionPath`）：collector **自己构造** metadata（`trajectory-collector.ts:334` 的 `{ metadata: { diagnostics } }`），**从不转发** `result.metadata`。即生产默认路径没有注入伪造 payload 的入口。ADR §4.5.2 也成立：`src/config.ts` 无 runner 开关，`src/index.ts:1769-1783` 只**读取** deps 写诊断。

---

## 3. C2a：eligibility / reward / track 是否可能被伪造改变

`_t11-followup.json` → `FA_q2_scorer` / `FA_q4_orchestrator`：

- **scorer 侧不可能**：即使同时伪造 `metadata.verification` **和** `verificationAudit`，`trustedSource=false`、`taskQualityEvidence=false`（空 producer 注册表 + digest 不匹配）。
- **recorder 侧 eligibility 不可被伪造翻转为「可学」**：`consumptionEligible = evaluation.taskQualityLearningEligible && !forcedAuditOnly`（`orchestrator.ts:2297`），其中 `evaluation` 来自 scorer、`forcedAuditOnly` 只被**加强**（`forceAuditOnly===true || reasonCode==='falsified-success-claim'`）。伪造 mark 把 `auditOnly` 写成 `false` 只能**取消**加强，不能凭空创造 `taskQualityLearningEligible`。实测：伪造场景下 `consumptionEligible=true`（因为该 trajectory 本身就是 succeeded+succeeded 的正常可学形态），但 `evaluation.verification.trustedSource=false`，因此 `learningTrack='process'`——**可信来源仍然没被伪造**。
- **support / nEff 隔离成立**：审计记录 `learningEligible:false` 在 `learningEligibleOnly` 查询中命中 0（`recorder-marks.test.ts:292-332` 断言 `verificationAuditOnly:1` 且 `learningRecords` 为空、`filterExperienceSnapshot` 为空）。

---

## 4. C3：逐笔算术对账（`work/_t11-verify.json` → `C3`）

| 项 | 断言 | 实测 | 判定 |
| --- | --- | --- | --- |
| **cacheRead 防重复计费** | `inputIncludesCacheRead=true` ⇒ 净输入 = input − cacheRead | 1,000,000−400,000=**600,000**；缓存读 400,000×0.1=40,000；输出 1,000,000×2=2,000,000 ⇒ **2,640,000** | ✅ 与手算逐位一致 |
| **reasoning 防重复计费** | `outputIncludesReasoning=true` 且单独计价 ⇒ 净输出 = output − reasoning，reasoning 单独计 | 700,000×2=1,400,000 + 300,000×3=900,000 ⇒ **2,300,000** | ✅ |
| **未知成本保守上界** | 语义未声明 ⇒ `provenance='unknown'`、`conservative=true`、金额 ≥ 下限 | total=**5,000**（= `conservativeFallbackCostMicros`），surcharge=5,000 | ✅ 非零 |
| **幂等结算** | 二次 settle 返回首发结果、不二次扣减 | 两次均 7,000；`isIdempotentReplay=true`；池 settled 仍 7,000 | ✅ |
| **seat 释放 ≠ 金额退款** | incurred(5,000) > reserved(1,000) ⇒ 席位释放但退款 0 | `seatReleased=true`、`amountRefundedMicros=**0**` | ✅ 两者可分离 |
| **fail-closed 不透支** | 余量不足拒绝 | 池 1,000 中先占 900，再要 200 ⇒ **拒绝**，`insufficient_budget`，余量仍 100 | ✅ 无透支 |
| **验证池专款专用** | 通用池耗尽不得挪用验证池 | 通用 100 池拒绝 500；验证池 10,000 仍成功 grant 5,000 | ✅ |
| **异常执行 audit-only** | cancelled/timed_out/infrastructure_error/failed 一律 audit-only 且**照实记花费** | 四者 `auditOnly=true, qualityEvidence=false, incurred=1,234>0`；仅 succeeded 为 `auditOnly=false, qualityEvidence=true` | ✅ 违反 §4.3 的组合不存在 |
| **六阶段** | probe/reference/compose/reflect/judge/dream 全覆盖 | fixture 剧本 + 测试覆盖 | ✅ |

**范围与零接线（ADR §7.6）**：
- `git diff --stat -- src/jitrl/reward-contract.ts src/jitrl/step-evaluator.ts src/types/contracts.ts src/dsh-bridge/model.ts src/dsh-bridge/agent-loop-executor.ts` → **空**（r4 与冻结契约零改动）。
- `src/ledger/**` 对 `reward|learningTarget|contractWeightsHash|REWARD_CONTRACT` **零引用**（grep 空）。
- `src/ledger` 在 `src/ledger` **之外零 import**（grep 空）⇒ **无生产接线**，与 §7.1「不接线上选择、不改模型路由、不产生真实付费调用」一致。
- 无任何「节省/收益」措辞进入契约或状态面。

---

## 5. 发现（findings）

### F-1（medium）C3：`settle({actualCostMicros: 0})` 绕过 §7.3.5 的「绝不允许静默记 0」，并伪造 `provenance`

**事实**（`work/_t11-followup2.json`）：

| 用例 | 输入 | incurred | provenance | conservative | 判定 |
| --- | --- | --- | --- | --- | --- |
| **Q1** | `actualCostMicros: 0`，**无 usage** | **0** | **`estimated`** | **false** | 既没有 usage 也没有估算，却盖 `estimated` 且 `conservative=false` |
| **Q2** | `actualCostMicros: 0` + **明确 unknown usage** | **0** | `unknown` | `true` | **自相矛盾**：自称未知且保守，金额却是 0（下限未施加） |
| Q3（对照） | 无 `actualCostMicros`、无 usage | 5,000 | `unknown` | `true` | ✅ 正路径正确落到下限 |

**根因** `src/ledger/reservation-manager.ts:265-283`：`actualCostMicros` 分支**直接构造** `costCalc`，绕过 `calculateUsageCost`，于是：
- `provenance: usage ? (usage.countingSemantics ? 'measured' : 'unknown') : 'estimated'` —— 无 usage 时硬盖 `'estimated'`，而**没有任何估算发生**；
- `conservative: usage?.inputTokens.precision === 'unknown'` —— 只看输入精度，**完全跳过** §7.3.5 的地板。

**为什么是 medium 而非 blocker**：C3 本轮**无生产接线**（§4 已证零 import），不产生真实费用；且 `actualCostMicros` 是契约里合法的「provider 回传的精确账单」入口。但：
1. 它正是 ADR 唯一点名的硬约束（§7.3.5「**绝不允许**静默记 0——0 会让预算与收益结论失真」）的**唯一绕过路径**；
2. Q2 留下一个**自我矛盾**的记录：`conservative=true` 却说金额是 0，任何下游按 `conservative` 判「已保守兜底」的代码都会被骗；
3. 现有 30 条 ledger 单测对 `actualCostMicros` 只测 5,000–20,000 的正值，**零覆盖 0 与 unknown 组合**。

**建议修复**（C3 inScope，约 4 行）：在 `actualCostMicros` 分支内，(a) 若 `provenance==='unknown'` 则 `totalCostMicros = Math.max(actual, fallbackFloor)` 并置 `conservative=true`；(b) 无 usage 时 provenance 应为 `'unknown'` 而非 `'estimated'`（没有估算就没有 `estimated`）；(c) 补一条 fixture：`actualCostMicros:0 + unknown usage` ⇒ `incurred >= floor` 且 `conservative===true`（旧实现失败）。

### F-2（medium）C3：`reserve()` 在 `callId` 已结算后仍被授予，其冻结额度**永久不可回收**

**事实**（`work/_t11-verify.json` → `reserveAfterSettleLeak`、`_t11-followup.json` → `FB_leak`）：

```
初始池 25,000
reserve(z,10,000,seat)  → settle(z, incurred=10,000)     → 剩余 15,000，reserved 0，seat 0
reserve(z,10,000,seat)  → **授予**（duplicate_active_call 未触发）  → 剩余 5,000，reserved 10,000，seat 1
settle(z, …)            → **isIdempotentReplay=true**，不扣减、不释放   → reserved 10,000 永久滞留，seat 1 滞留
第三个不同 callId(y)     → **拒绝**（insufficient_seats）
```

**根因**：`duplicate_active_call` 检查用 `callToReservation`（`reservation-manager.ts:109`），而 `settle` 会把它删掉（`:375`）；但 `settledCalls` 仍持有该 `callId`（`:392`）。于是「已结算的 callId 可再次 reserve」，而它的 `settle` 被幂等守卫（`:229-235`）**在扣减之前**拦截，导致该 reservation 再也不会进入 `settle` 的释放路径。

**为何是 medium**：逐项核对安全性——**不会透支**（`overspend=false`，settled 10,000 ≤ 池 25,000），**失败是 fail-closed 的**（第三个调用被拒而非放行）。但它造成两个会计后果：
1. `reserved=10,000` 永不计入 `settled` 也永不归还，`getBudgetStatus()` 此后**永远**报一个无法解释的 `reserved` 残值；
2. 该额度**无公开 API 可回收**（`releaseSeat` 只能还席位，金额须经 `settle`，而 `settle` 被幂等吞掉）。

ADR §7.4 冻结「同一 callId 重复 settle 返回首次结果、不二次扣减」——这一条**满足**；但同表还冻结「任一步缺失都必须可诊断」，而滞留额度**不可诊断**。这是契约完整性的缺口，不是安全缺口。

**建议修复**（C3 inScope，1–2 行）：`reserve()` 在 `duplicate_active_call` 之外**再查一次 `settledCalls`**，已结算则拒绝并给出有界原因（如复用 `duplicate_active_call`，或新增 `already_settled`）；并补 fixture 断言「settle 后再 reserve 必须被拒，`reserved` 恒为 0」。

### F-3（medium）C2a：`metadata.verificationAudit`（宿主审计通道）在**无 seam 时不被认证**，分支可伪造其内容并影响持久化标记

**事实**（`work/_t11-followup.json` → `FA_q1_marks` / `FA_q4_orchestrator`）：

- 一个**只有 3 个布尔字段**的对象（`{kind, attached:true, authenticated:true, auditOnly:false}`，**无 verifierId、无 digest、无 binding**）就能被 `readVerificationDisposition` 接受（`Q5_minimalForgedDisposition.accepted=true`）；
- 伪造 `verdict:'passed'` 后，`verificationRewardMarks` 产出 **`verificationVerdict: 1`（=passed）**，而真实 scorer verdict 是 `unknown`；`verificationTrusted` 仍正确为 0；
- 无 seam 时 `verifyAndAttach` 按 §4.5.1 **原样返回**轨迹（这是刻意的逐字节等价），**因此没有覆盖分支的 mark**。

**可达性（关键分层，决定严重度）**：
| 路径 | 可伪造？ | 依据 |
| --- | --- | --- |
| 默认生产装配（collector） | **否** | collector 自建 metadata，不转发 `result.metadata`（`FA_q3`） |
| 宿主注入 `deps.seams` | **是** | 实测经注入 seams 管理器可让 `verificationVerdict=1` 落库（`FA_q4`） |

**为什么是 medium 而非 blocker / 也不判 needs_revision**：
1. **验收项 1 明确要求的是「不能伪造可信来源」——这一条成立**：`verificationTrusted` 仍为 0、`taskQualityEvidence=false`、eligibility 与 track **均未被翻转**（§2/§3 已证）。被污染的只是**审计侧标记**。
2. 默认装配不可达；可达路径要求宿主**自己**注入 seams 后再伪造自己的 metadata——即宿主攻击自身，不构成越权提权。
3. 但它确实违反 ADR §4.2「拒绝原因码必须进记录/诊断」的精神与 §4.6a(3) 的同一纪律（**不能把分支自报的字段当宿主事实**）：`readVerificationDisposition` 没有任何「我这个 mark 是宿主写的」证明，与 `metadata.verification` 走 `isTrustedVerification`+注册表对象同一性（T2 的正解）形成不对称。

**建议修复**（C2a inScope，低成本）：让 `markOf()` 写入一个**宿主签名**（如 `verificationId` + `artifactDigest` + 一个由 runner 持有的 `markToken`，或简单地在 `readVerificationDisposition` 里要求 `mark.verifierId`/`mark.artifactDigest`/`mark.verificationId` **齐全**才接受——与 `isHostVerificationReceipt` 同级别的形状门槛），并补一条反例：无 seam + 分支伪造 `verificationAudit` ⇒ `verificationRewardMarks` 必须为 `undefined`。

---

## 6. 字节绑定（本 verdict 的对象）

HEAD `9ea9b7e` + 工作树。t13 复核的 **12 项 C3 文件当前 SHA-256 与 t13 记录 100% 吻合**（我逐个重算）：

| 文件 | sha256（节选） | 与 t13 |
| --- | --- | --- |
| `src/ledger/types.ts` | `556dbd780f09b1d1…` | MATCH |
| `src/ledger/pricing.ts` | `4831a17d7a520eeb…` | MATCH |
| `src/ledger/reservation-manager.ts` | `428b8ff00b3eff0b…` | MATCH |
| `src/ledger/ledger-event.ts` | `333959a84e60fde0…` | MATCH |
| `src/ledger/index.ts` | `dbcf706f4f4959e7…` | MATCH |
| `scripts/fixtures/ledger/{index,sample-rate-cards,scenarios,synthetic-payloads}.ts` | `b7dda524…/f2f09b78…/defd8565…/9f5286ac…` | MATCH |
| `tests/unit/ledger/{offline-fixtures,pricing,reservation-manager}.test.ts` | `b7b93264…/28f7d90b…/a709d95a…` | MATCH |

**README**：t13 记录的是 `a927498a…`（80 files/1596），当前为 **`df913ceda2c185eaf9fe43a97744e00f00504b20dbef3022dbb93f490421e00c`**（27,463B）。README 在 t13 之后被 t5 同步为 **85 files/1647 tests**，`check:docs` 实测**逐项一致** ⇒ **t13 遗留的「README 计数」缺口已关闭**（变化的只有计数数字，与 C3 的 12 个文件无关）。

C2a 字节：`src/verification/{types,artifact-digest,host-runner,attach,index}.ts` = `3a5efe99…/8bdfac77…/97ff4c19…/f9ac2703…/a5361efc…`。

**漂移登记（与本任务无关但必须知情）**：`src/index.ts` 在我上一轮 t10 之后已变更（`d2693183…`，123,288B）：t10 的 F-1（状态面 `appliedJit` 谎报热替换）**已被修复**——现为 `appliedJit = jitOn && report.publication?.publish === true ? holder?.policy?.jit : undefined`；我用原探针复跑，预置 jit 的存量策略在 deny 下现在得到 `statusAppliedJit=null`（原为 `{beta:1.25,lambda:0.04}`）。**F-1 关闭。**

---

## 7. 越界审计（ADR §7.6 / §9）

| 检查 | 结果 |
| --- | --- |
| C3 是否只动 `src/ledger/**`、`tests/unit/ledger/**`、`scripts/fixtures/ledger/**` | ✅ 是 |
| 是否改 `src/index.ts` / `src/orchestrator.ts` / `src/jitrl/**` / `src/verification/**` / `src/dsh-bridge/model.ts` | ✅ 未改（diff 为空） |
| 是否触碰 r4（`REWARD_CONTRACT`/`learningTarget`/`contractWeightsHash`） | ✅ 零引用、零改动 |
| 是否新增动态路由 / 输出折叠 / 真实付费调用 | ✅ 无（纯离线合成） |
| 是否宣称节省或收益 | ✅ 无 |
| C2a 是否加宽 `types/contracts.ts` / `step-evaluator.ts` / `reward-contract.ts` | ✅ 未加宽（超集随附写开放 metadata，C2a-O1 遵守） |
| C2a 是否改 `trajectory-collector.ts` | ✅ 有意零改动（T2 依赖它不转发 `result.metadata`，实测成立） |
| `src/config.ts` 是否有 runner 开关 | ✅ 无（§4.5.2 遵守） |

---

## 8. 结论

| 验收项 | 判定 | 依据 |
| --- | --- | --- |
| 任意分支 metadata 不能伪造可信来源，错绑和异常不能成为可靠通过 | **PASS** | §2：真 id + 真 digest + 完整 binding 的伪造回执，无 seam ⇒ `trustedSource=false`；有 seam ⇒ checks 被宿主整体替换、只认注册表对象；artifact-missing/未注册/stale/各类 mismatch 全拒且带具体 reasonCode。§3：eligibility/reward/track 无法被伪造翻转。附 F-3（仅污染审计标记，不污染可信来源） |
| ADR A 与 r4 冻结被遵守，reference/candidate 同卷且 evaluation 单一 | **PASS** | §4：`reward-contract.ts`/`step-evaluator.ts`/`contracts.ts`/`model.ts` diff 为空；ledger 零 r4 引用。§4.4 双回执：reference 与 candidate **各经一次** `verifyAndAttach`（`orchestrator.ts:1269`、`:3145`），两处打分**都**传同一个 `trustedProducers`（`:2211-2214`、`:2258`），缺 reference 回执 ⇒ candidate 全部 `reference-receipt-missing` 审计（`:1276` → `:1554`） |
| C3 数据契约完整保守且无生产接线、真实付费或收益宣称 | **PASS**（附 F-1/F-2） | §4 九项逐笔算术对账全过；零 import ⇒ 无生产接线；零付费/零网络；无收益措辞。F-1（`actualCostMicros:0` 绕过保守地板并伪造 provenance）与 F-2（已结算 callId 再 reserve 造成不可回收滞留额度）为契约边界缺口，**不导致透支**，建议 C3 定稿前修复 |

**verdict = pass**。C2a 的「可信来源」边界在默认装配下**真实不可伪造**，错绑/异常均 fail-closed 且可诊断；C3 的计价与生命周期主路径算术正确、范围干净。三项发现均为契约边界或审计侧问题，不影响本轮的三条安全结论（无可信来源伪造、无 r4 改动、无生产接线/真实付费）。

**本轮未做**：真实付费模型调用、真实 memory、部署、commit/push；未评 C1.1（见 `docs/reports/t10-c11-review.md`）；未评审 C4。
