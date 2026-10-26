# t16 独立复审报告：appliedJit 报告修复（t10 F-1 关闭确认）

| 项 | 值 |
| --- | --- |
| 任务 | t16（review round 1）— 复审 appliedJit 报告修复 |
| 复审者 | evidence-reviewer（t10 F-1 的原报告者，非 t15 实现者） |
| attempt | 1 / `d4022fa0-8851-4e10-ad29-df6b02406707` |
| 被复审任务 | t15（attempt 1，`719e6b70-27e1-49bf-adad-7bb39168ac07`） |
| 原始缺陷 | t10 F-1（medium）：deny 下 `lastReplay.appliedJit` 谎报「发生过 jit 热替换」 |
| 契约口径 | ADR-0003 §3.2（deny 语义六项合取）、§3.5-3（不得假 published）、§3.6-4（旧实现必失败）、§4.7 |
| 复审裁定 | **PASS**（F-1 关闭），无新增缺陷 |

> **复审立场**：不接受 t15 的自述与自测作为证据。三件事必须**独立**成立：
> ① 用 **t10 原始探针**（同一份未改动的生产装配探针）复核关闭；
> ② 修好的字段必须**非空洞** —— 即在授权分支上确实**会**出现，否则「恒 undefined」也能让反例通过；
> ③ 用**四字段一致性**判断修复质量（F-1 的本质是 `appliedJit` 与 `published`/`selected` 互相矛盾），而不是只看一个字段变成 `undefined`。

---

## 1. 修复内容（读源码，不读自述）

`src/index.ts:1271`（三行，单点收敛）：

```diff
-      const appliedJit = jitOn && report.improved ? holder?.policy?.jit : undefined;
+      const appliedJit =
+        jitOn && report.publication?.publish === true
+          ? holder?.policy?.jit
+          : undefined;
```

**为什么这修的是根因而不是症状**：原判据是 `improved` + **当前策略已存在的** `jit` 块，两个输入都与「是否真的 apply」无关；新判据把它绑定到 `report.publication?.publish === true`，而该字段在 t4 之后**严格等于 `applied`**（`offline-dreamer.ts:1898`，`publication.publish` 与 `shadow.published` 同源于 `applied`）。因此 `appliedJit` 现在与 `published` 同源，三段链条闭合：`applied → publication.publish → appliedJit`。

`?.` 可选链是必要的：手建 dreamer 的 `replay()` 返回类型是 `IOfflineDreamer`，其 `publication` 可能不存在；`=== true` 保证缺字段时 fail-closed 为 `undefined`。我核对了 `src/index.ts:382` 的字段契约「present only when a swap happened」——新实现与该措辞**字面一致**，不需要改文档。

---

## 2. 独立复核 A：t10 原始探针在生产装配上复跑（探针未改一字）

直接重跑 **t10 当时写的那份** `work/_t10-diag-appliedJit.ts`（本次仅重新 bundle，源码零改动），输出 `work/_t16-appliedJit.json`：

| 分支 | `update()` 真实调用数 | publish | live `jit` 前后 | `statusAppliedJit` |
| --- | --- | --- | --- | --- |
| **预置 jit 的存量策略**（t2 §F6 恢复形态） | **0** | false | 逐字节相同 | **`null`（不存在）** ← 修复前为 `{beta:1.25,lambda:0.04}` |
| 无 jit 块的策略（对照） | 0 | false | 相同 | `null` |

**非空洞前提成立**：两臂 `improved=true`，即候选**确实赢了**、确实走到了发布闸；`undefined` 不是因为「没赢所以没有 swap」。**F-1 在生产装配形态上关闭。**

---

## 3. 独立复核 B：四字段一致性 + 授权正控（自建 `work/_t16-review.ts`）

驱动**真实生产装配**（`buildOrchestratorDeps` + `createEvoHarnessOrchestrator` + 真实 `PolicyStore` + 真实 `agent/status` 监听器），每条用例先预置一条含 `jit` 块的真实 revision（`pi-seed@4`）使「不变」非空。

### 3.1 deny 臂：4 模式 × jitKernel{on,off} = 8 条

| 用例 | improved | publish | shadow.published | comparisons.selected | **appliedJit** | history Δ | current hash | live jit | 四字段一致 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline/jit=on | true | false | false | 全 false | **absent** | 0 | 不变 | 不变 | ✅ |
| baseline/jit=off | true | false | false | 全 false | **absent** | 0 | 不变 | 不变 | ✅ |
| shadow/jit=on | true | false | false | 全 false | **absent** | 0 | 不变 | 不变 | ✅ |
| shadow/jit=off | true | false | false | 全 false | **absent** | 0 | 不变 | 不变 | ✅ |
| guarded-active/jit=on | true | false | false | 全 false | **absent** | 0 | 不变 | 不变 | ✅ |
| guarded-active/jit=off | true | false | false | 全 false | **absent** | 0 | 不变 | 不变 | ✅ |
| off/jit=on | true | false | false | 全 false | **absent** | 0 | 不变 | 不变 | ✅ |
| off/jit=off | true | false | false | 全 false | **absent** | 0 | 不变 | 不变 | ✅ |

`update()` 实际调用 **0**、`appliedPolicyIds` JSON 不变、live policy `{id,version,jit}` 逐字节不变 → **C1.1 原安全性质无回退**。
四字段（`publish` / `shadow.published` / `comparisons[].selected` / `appliedJit` 是否存在）**全部一致**，0 违例 —— 这正是 F-1 描述的「同一份状态里互相矛盾」不再成立。

### 3.2 idle 臂（第二入口）

| 用例 | dreamReports | publish | appliedJit | history Δ | 一致 |
| --- | --- | --- | --- | --- | --- |
| idle/shadow | 1 | false | **absent** | 0 | ✅ |
| idle/baseline | 1 | false | **absent** | 0 | ✅ |

idle 同样收敛为「无热替换、无矛盾报告」。

### 3.3 授权正控臂（证明不是硬编码 `undefined`）

同一生产装配，唯一变量是 profile override（`mode:'baseline'`，`shadowRecords=false` 以便 A 层走到 holdout 闸）+ 显式 `publishAuthorized` + `holdoutTreeCount:1` + **两棵树**（holdout 取尾，一棵树时验证不会执行）：

| 项 | 实测 |
| --- | --- |
| improved | **true** |
| publication.publish | **true**（reason: "the candidate strictly improved the replayed hypervolume"） |
| shadow.published | **true** |
| 真实 apply 次数 | **1** |
| **appliedJit** | **`{beta:1, lambda:0.04}`（存在）** |
| appliedJit == 被应用策略的 jit 块 | **true** |
| live policy 终态 | `pi-seed::dream-2 @ v5`，jit `{beta:1, lambda:0.04, k:10, …}` |
| history Δ / current hash 变化 | **+1** / **改变** |
| 四字段一致 | ✅ |

**结论**：`appliedJit` 在授权分支上真实出现，且值等于**新应用策略**的 jit 块 —— 修复**不是**把字段硬编码成 `undefined`。这与 t15 自述的 `{beta:2, lambda:0.1}` 数值不同（那是用手建 dreamer + 候选 jit 测的），但**性质相同**：都等于「确实被应用的策略」的 jit 块。我用 `appliedJit === appliedPolicy.jit` 而不是比对某个字面量，正是为了避免把具体数值当契约。

---

## 4. 门禁

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `pnpm exec vitest run tests/unit/jitrl/runtime-control.test.ts tests/unit/p62/release-contract.test.ts tests/unit/dream-rsi` | **exit 0** — 9 files / **249 tests** passed |
| 2 | `node scripts/eval/guarded-regression.mjs --json` | **exit 0** — `{total:33, passed:33, failed:0}`；`C1.1-publish-receptor-boundary` detail 三项全 true |
| 3 | `pnpm run typecheck` | **exit 0** — 0 error |
| 4 | `pnpm test`（全量） | **2 failed** / 1658 passed —— **见下方归因，与 t15 无关** |
| 5 | `pnpm test --exclude 'tests/unit/ledger/**'` | **exit 0** — 83 files / **1630 tests** passed |
| 6 | `pnpm run check:docs` | **exit 1** —— **见下方归因，与 t15 无关** |

### 4.1 门禁 4/6 的失败归因（重要：不是 t15 造成）

全量跑的唯一失败是 **2 条 `tests/unit/ledger/reservation-manager.test.ts` 用例**：

```
FAIL ... > marks failed executions as auditOnly=true and qualityEvidence=false
AssertionError: expected 10000 to be 5000
```

**归因证据（三条独立）**：
1. **t15 的 inScope 只含 `src/index.ts`、`tests/unit/jitrl/runtime-control.test.ts`、`tests/unit/p62/release-contract.test.ts`**，从未触及 `src/ledger/**` 或 `tests/unit/ledger/**`。
2. **账本源文件在我 t11 之后已漂移**：`src/ledger/types.ts` `556dbd78 → 1d6dad84`、`src/ledger/reservation-manager.ts` `428b8ff0 → 000c1748`（t11 记录的指纹）。
3. 该失败**恰好是 t17 修复我 t11 F-1 的中间态**：t17 正在给 `actualCostMicros` 分支加保守地板（`Math.max(rawMicros, fallbackFloor)`，floor=10,000），于是旧用例断言的 `5,000` 被提升为 `10,000`。**这是「旧用例未同步」的预期中间态，正说明 F-1 已被 t17 修掉**。

`check:docs` 的 exit 1 是同一原因的下游：它内部重跑全量 vitest，vitest 非零退出 → 校验脚本抛错（`verify-readme-counts.mjs:147`）。**排除 ledger 后 83 files / 1630 tests 全绿**，即 t15 本身对全仓无任何回归。

> **给 t12 的交接**：t17 完成后必须同步更新那 2 条 ledger 用例的期望值（或改为断言 `>= conservativeFallbackCostMicros`），否则 t12 的 `pnpm test` 与 `check:docs` 两条门禁必红。这是 t17 的收尾责任，不构成本复审的阻塞项。

### 4.2 一处覆盖缺口（low，非阻塞，登记）

`scripts/eval/guarded-regression.mjs` **没有** `appliedJit` 相关断言（grep 空）。即：guarded regression 这个「门禁见证」不覆盖 F-1 这一族「状态字段必须等于事实」的缺陷。t15 把它固在了两条单测里（`runtime-control` 的反例 + 正控、`release-contract` 的 8 组合反例），覆盖已经足够；但若希望对同类问题有跨门禁见证，可在 `C1.1-publish-receptor-boundary` 探针里补一句 `appliedJit` 存在性断言。**不阻塞**。

---

## 5. 范围与权限审计

| 检查 | 结果 |
| --- | --- |
| t15 改动文件集 | 恰为 inScope 三文件：`src/index.ts`（`d2693183`）、`tests/unit/jitrl/runtime-control.test.ts`（`475404a8`）、`tests/unit/p62/release-contract.test.ts`（`7a66e6dd`）——**逐项与其交付说明一致** |
| 是否越界改 outOfScope | ✅ 未改：`src/orchestrator.ts`（`de6439b0`）、`src/dream-rsi/offline-dreamer.ts`（`d7b1346b`）、`src/jitrl/decision-kernel.ts`（`fdf68a44`）、`README.md`（`df913ced`）——**四个哈希与 t11 记录逐一相同**，证明 t15 未顺手改动 |
| 是否开放发布权限 | ✅ `execution-profile.ts:119-122` `publish.allowed` 仍为**字面量 `false`**，四模式共享同一分支 |
| 是否新增 config 开关 | ✅ `src/config.ts` 无 publish/verification/runner 字段（仅注释提及） |
| `ExecutionProfileInput` | ✅ 仍只有 `mode` / `memoryRealWrites` |
| 是否改动 `shadowMode` 派生（t10 F-2 登记项） | ✅ 未改，F-2 仍为前向风险登记 |
| 字段契约是否被加宽 | ✅ 未新增字段；`appliedJit` 语义与 `src/index.ts:382` 措辞一致 |
| 是否 commit/push | ✅ 无 |

---

## 6. 字节绑定（本 verdict 的对象）

HEAD `9ea9b7e` + 工作树，t15 之后：

| 文件 | sha256 | 说明 |
| --- | --- | --- |
| `src/index.ts` | `d2693183c90b7a2a287ef3542c60d88a49ba02130ce82de955b2b9a11d8feb4c` (123,288B) | 唯一生产改动 |
| `tests/unit/jitrl/runtime-control.test.ts` | `475404a8779000c21c69dd047d54b166ff99dc060b3f2df6327533fe88db383a` (33,578B) | 反例 + 双正控 |
| `tests/unit/p62/release-contract.test.ts` | `7a66e6ddd2213f78fb7095d88b71bc6aa409cd614d8df12e1b0680240c4c95c9` (78,617B) | 8 组合反例 |

**并发漂移声明（必须登记，影响 t12）**：在我复审期间，**t17（ledger）与 t18（verification）正在并行改文件**，实测：
- `src/ledger/types.ts` `556dbd78 → 1d6dad84`、`src/ledger/reservation-manager.ts` `428b8ff0 → 000c1748`、新增 `tests/unit/verification/audit-provenance.test.ts`（9 tests）、`src/verification/attach.ts` `f9ac2703 → a98d17a8`。
- 因此本 verdict **只绑定上表三个文件与 `src/index.ts` 的 C1.1 行为**；对 ledger/verification 的结论不覆盖（它们分别是 t19/t20 的对象）。
- 我曾观测到一次瞬时的 `typecheck` 失败（`audit-provenance.test.ts` 重复 import），在 t18 落定后已恢复 **exit 0** —— 属并行编辑的中间态，非 t15 缺陷。

---

## 7. 结论

| 验收项 | 判定 | 依据 |
| --- | --- | --- |
| t10 F-1 由非空洞生产形态反例证明关闭 | **PASS** | §2：**t10 原始探针未改一字**复跑，预置 jit 的存量策略在 deny 下 `statusAppliedJit` 由 `{beta:1.25,lambda:0.04}` 变为 **不存在**，而两臂 `improved=true`（候选确实赢了）；§3.1 八条生产装配用例全部 absent |
| deny 下 apply/update/revision 仍为零，appliedJit 与 published/selected 一致 | **PASS** | §3.1：`update()` 0 次、`history` Δ=0、`current.json` 哈希不变、live `{id,version,jit,appliedPolicyIds}` 逐字节不变；四字段（publish / shadow.published / selected / appliedJit 存在性）**8/8 一致，0 违例**；§3.2 idle 两模式同样一致 |
| 授权+holdout 正控真实 apply 且 appliedJit 正确 | **PASS** | §3.3：真实 apply 1 次、`publish=true`、`history +1`、`current.json` 改变，且 **`appliedJit === 被应用策略的 jit 块`** —— 证明非硬编码 `undefined` |
| 相关门禁通过且未开放权限或扩大范围 | **PASS** | §4：专项 249 tests / guarded 33/33 / typecheck 0 error / 排除并发 ledger 后全量 83 files 1630 tests 全绿；§4.1 已证明全量 2 败与 `check:docs` exit 1 均归因 t17 的 ledger 中间态（t15 零触及）；§5 权限仍字面量 deny、三文件 inScope、四个 outOfScope 文件哈希与 t11 逐一相同 |

**verdict = pass**。t10 F-1 **关闭**，且是以「非空洞 + 四字段一致 + 正控可放行」三重证明关闭的，不是靠把字段钉死成 `undefined`。C1.1 原有安全性质（四模式 deny 下零 apply/零 revision/策略与 jit 块不变）**无回退**。

**未做**：真实付费调用、真实 memory、部署、commit/push；未评 C2a/C3（并行中的 t18/t17 属 t20/t19）。

**给 t12 的两条交接**：① t17 完成时须同步那 2 条 ledger 用例期望值，否则 `pnpm test`/`check:docs` 恒红（§4.1）；② `guarded-regression` 无 `appliedJit` 断言，可选补一条（§4.2，low）。
