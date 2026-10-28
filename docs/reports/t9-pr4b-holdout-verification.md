# t9 / t18 — PR-4B 留出不足静默缩小：修复验证报告

| 项 | 值 |
| --- | --- |
| 任务 | t18（attempt 3，`d813168f-3013-47e3-85f9-14e382f52ad6`）— 修复 PR-4B 审查缺陷「留出不足静默缩小」 |
| 执行者 | pr4b-repair-v2 |
| 缺陷来源 | PR-4B 独立审查发现：`splitDreamerHoldout` 请求不足时静默 shrink |
| 契约口径 | ADR 0004 §4.4（insufficient evidence = fail-closed，不是静默缩小）；src/config.ts `validateHoldoutTreeCount`（"a clamped holdout would be an undisclosed shrink of the validation set"）；ADR 0003 §3.3 G3（`validatedOnHoldout !== true ⇒ publish:false, holdout-missing`） |
| 裁定 | **已修复并验证**（实现自测全绿；本文件为执行者验证记录，非独立评审，self-review 不算 review pass） |

---

## 1. 缺陷（复现于修复前源码）

`splitDreamerHoldout(pool, 5)` 在 4 树池、最新组持 3 树时返回：

```
status: 'ok', hasSufficientEvidence: true, holdoutCount: 3
```

根因：切分循环取「能覆盖请求的最小可容许割」，取不到时**保留最大可容许割**并落到 §4.4 真值表；真值表对 holdout 数量只检查硬下限 `MIN_HOLDOUT_TREES = 1`（ADR 的非空门槛），**从未对照 `requestedHoldoutCount` 检查**。于是显式配置 `holdoutTreeCount: 5` 的操作者在运行时拿到 40% 缩水的验证集，且 `hasSufficientEvidence: true` 会让 dreamer 把它当证据。这正是 config 层注释明令禁止的「undisclosed shrink」——config 的跨域规则（`holdoutTreeCount < maxTreePoolSize`）只能看见**配置上界**（默认 200），看不见**运行时实际池大小**（本例 4 树），所以该缺陷只能修在运行时。

## 2. 修复（src/dream-rsi/offline-dreamer.ts）

**2.1 请求地板（根因修复，`splitDreamerHoldout` §4.4 真值表，行 941）**

```diff
-if (holdoutTrees.length < MIN_HOLDOUT_TREES) {
+if (holdoutTrees.length < Math.max(MIN_HOLDOUT_TREES, requested)) {
```

holdout 数量现在有两个硬地板、取高者：ADR 的 `MIN_HOLDOUT_TREES >= 1`，加上调用方显式请求的 `requested`。不足即 `insufficient-holdout-trees`（复用既有状态字，`DreamerSplitStatus` 无需扩枚举）、`hasSufficientEvidence: false`、`holdoutTrees: []`。**超配仍 `ok`**：整组迁移，2 树的组合法满足 1 的请求，只有不足才拒。

**2.2 可审计诊断（`DreamerHoldoutSplit.diagnostics`）**

新增 `holdoutShortfall: max(0, requested - holdoutCount)`；`holdoutCount` 语义钉死为「观察到并拒绝的供给」。拒绝可从记录直接读出「请求 5、供给 3、缺口 2」，无需重跑切分。所有 fail-closed 出口的 `empty` 诊断同步携带 `holdoutShortfall`。

**2.3 纵深防御（`OfflineDreamerImpl.replay`，行 2196 / 2228）**

- `holdoutUsable = split.status === 'ok' && split.hasSufficientEvidence`：同时核对状态与布尔两个字段，未来任何状态位忘记翻转布尔也无法验证。
- 生成器池条件由 `holdoutTrees.length === 0` 改为 `this.holdoutTreeCount > 0`：fail-closed 时 `holdoutTrees` 已清空，旧条件会把被扣留的尾部树连同全池递给生成器——一个请求不足的切分将让最新的树参与生成。现在只要配置了 holdout，生成器只见选择集；未配置（0）时原样透传 `request`，pre-PR-4B 路径逐字段不变。

**未改动**：默认 `holdoutTreeCount = 0` 行为（`no-holdout-configured`、全池为选择集、G3 `holdout-missing` 拒绝）；`decideReplayPublication`（`validatedOnHoldout` 不设 true ⇒ `holdout-missing`，publish 恒 false——由修复后测试直接断言）；`src/config.ts` 无需改动（既有 `validateHoldoutTreeCount` 已是配置半边的正确实现，本缺陷在运行时半边）。

## 3. 判别力证明（新测试对旧实现必红）

临时还原地板检查为 `holdoutTrees.length < MIN_HOLDOUT_TREES` 后重跑专项：

```
Test Files  1 failed (1)      Tests  6 failed | 32 passed (38)
× refuses a 5-tree request when the newest group only offers 3
    AssertionError: expected 'ok' to be 'insufficient-holdout-trees'
× refuses a request larger than the pool can divide at all
× never reports ok with fewer holdout trees than requested (sweep)
× refuses publication when the pool cannot supply the requested holdout
× refuses an undersized holdout through the Jit-wired path
× fails closed through the production assembly when the pool cannot supply the configured count
```

6 条新测试在旧实现上失败且失败信息正是被修的缺陷（`ok` vs `insufficient-holdout-trees`），随后恢复修复、哈希核验一致（git blob `0e32ebda`），专项回到 38/38。其余 32 条含既有 27 条全部通过——**默认 0 路径与既有 ok 路径未被改变**。

## 4. 新增测试清单（tests/unit/dream-rsi/pr4b-holdout.test.ts，27 → 38 条）

`describe('PR-4B request floor: a short holdout fails closed instead of shrinking')`（行 423 起）：

| # | 用例 | 钉住的性质 |
| --- | --- | --- |
| 1 | `refuses a 5-tree request when the newest group only offers 3`（:431） | 审查原始场景：`insufficient-holdout-trees`、`hasSufficientEvidence=false`、`holdoutTrees=[]`、诊断 `requested=5 / holdoutCount=3 / shortfall=2`、选择集组隔离不因拒绝而破坏 |
| 2 | `accepts a request the pool can meet exactly`（:458） | 刚好够：`ok`、`holdoutCount=2`、`shortfall=0` |
| 3 | `treats the request as a floor: a bigger newest group is not a shrink`（:474） | 超配不是 shrink：整组迁移合法，`shortfall=0` |
| 4 | `refuses a request larger than the pool can divide at all`（:489） | 池整体不足：拒、`shortfall=2` |
| 5 | `never reports ok with fewer holdout trees than requested (sweep)`（:503） | 不变量扫描：`ok ⇔ holdoutTrees.length >= requested`，1..6 逐个请求核验 |
| 6 | `keeps the zero request exactly on the pre-PR-4B path`（:530） | **0/未配置**：`no-holdout-configured`、全池选择集、`shortfall=0`、不因修复变 fail-closed |
| 7 | `keeps the withheld tail out of the generator when the request cannot be met`（:547） | 请求不足时生成器只见选择集头（`['gen-a1','gen-a2']`），扣留尾部不泄漏 |
| 8 | `refuses publication when the pool cannot supply the requested holdout`（:578） | **G3 拒绝确认**：授权 + improved=true 下 publish=false、reason 含 `holdout-missing`、`holdoutHypervolume/baselineHypervolume` 双双 undefined、`applied=0` |
| 9 | `keeps an unconfigured dreamer on holdout-missing even when authorized`（:622） | 未配置 + 授权：仍 `no-holdout-configured` → `holdout-missing` 拒绝 |

另有 2 条门内补测：Jit-wired 路径同一缺陷（:742，`refuses an undersized holdout through the Jit-wired path`）；生产装配路径（:884，config `holdoutTreeCount:5` 通过校验而实际池 4 树 ⇒ 装配后仍 fail-closed）——证明缺陷是运行时性的、config 校验修不到它。

## 5. 验证记录

| 命令 | 结果 |
| --- | --- |
| `pnpm run typecheck`（`tsc --noEmit`） | **exit 0**，无错误 |
| `npx vitest run tests/unit/dream-rsi/pr4b-holdout.test.ts`（修复后） | **38/38 passed** |
| 同上（地板检查临时还原，判别力对照） | **6 failed**（恰为新测试），32 passed |
| `npx vitest run tests/unit/dream-rsi`（全量 dream-rsi 专项） | **8 files / 216 tests 全过** |
| `+ tests/unit/jitrl/runtime-control.test.ts + tests/unit/p62/release-contract.test.ts`（发布门相关面） | **10 files / 287 tests 全过** |
| `npx vitest run`（全仓 3 次） | `Test Files 3 failed / 93 passed`，失败集中在 `tests/unit/jitrl/dual-track-consumption.test.ts`、`tests/unit/verification/quality-provenance.test.ts`、`tests/unit/p62/evidence-gates.test.ts`（另 `tests/unit/ledger/audit-consistency.test.ts` 在运行中途出现又消失） |

**全仓失败的归因（与本修复无关的证据）**：三个失败文件无一 import `src/dream-rsi/**`；`src/ledger/wal.ts`（mtime 00:18:16）、`src/verification/quality-provenance.ts`（00:20:27）、`tests/unit/ledger/audit-consistency.test.ts`（00:19:59）的修改时间落在本次验证的两次全量运行**之间**，且三轮全量失败数互不相同（11 → 28 → 30）——并发在途改动导致的非确定性，属 PR-2 C2b / PR-1 / PR-3 的队友工作面，不在 t18 inScope。判别面证据：与 holdout/发布门相关的全部 287 例在本修复下全绿。

## 6. 修改清单（inScope）

| 文件 | 变更 |
| --- | --- |
| `src/dream-rsi/offline-dreamer.ts` | §2 全部四处（真值表请求地板、`holdoutShortfall` 诊断、`holdoutUsable` 双字段、生成器池条件）及相应契约注释 |
| `tests/unit/dream-rsi/pr4b-holdout.test.ts` | 新增 `describe('PR-4B request floor…')` 9 条 + Jit-wired 1 条 + 生产装配 1 条，27 → 38 条 |
| `src/config.ts` | **无改动**（既有 `validateHoldoutTreeCount` 已覆盖配置半边；本缺陷修在运行时半边） |
| `docs/reports/t9-pr4b-holdout-verification.md` | 本文件 |

blob 指纹（`git hash-object`，工作树原始字节）：`src/dream-rsi/offline-dreamer.ts` = `0e32ebda1daaedf9c6f83f03352600698dda3b95`；`tests/unit/dream-rsi/pr4b-holdout.test.ts` = `d80199346a01007f8a6892a9e0f50a498afcacf6`。

## 7. 边界与声明

- 未 commit / 未 push / 未发布 / 未启用任何真实付费调用。
- 本报告为执行者验证记录；按团队纪律，实现者的自测**不构成** review pass，独立评审另行进行。
- `holdoutShortfall` 是 `DreamerHoldoutSplit['diagnostics']` 的加法字段，随 `DreamerHoldoutSplitReport` 一起出现在 shadow 记录上；类型检查通过且无消费方破坏（全量 dream-rsi 216 例为证）。
