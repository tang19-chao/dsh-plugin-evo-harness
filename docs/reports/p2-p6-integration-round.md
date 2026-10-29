# P2–P6 集成轮报告（本轮唯一正式报告）

> 任务 `t5`（attempt `b924e10b-1533-479a-994f-60b66f31c3b2`）· 角色：文档收尾与报告
> 基线 `HEAD = feb8465ded73ca48a770054c587990b93f54e21e`（整轮不 commit，见 §2.3）
> 本报告的取样窗口：**2026-10-30T00:39–01:05（Asia/Shanghai）**；每条结论后都给出命令、退出码与取样时刻。
> 判据：**只有「可复跑命令 + 退出码 + 关键输出行」算证据**；只有自述而没有命令的，一律标【未知】。

## 1. 结论摘要

| 问题 | 结论 | 依据 |
| --- | --- | --- |
| t1 独立基线复核是否完成 | **完成**（8 节、45 行抽查、13 条 findings；标题写「34 条 / 五处」与表体不一致，见 §2.2 登记） | `docs/reports/p2-p6-integration-audit.md`（sha256 `3ce0d1945ce87d3838243b6dc300ea7b4cd3b0a73da8a65105399cb1a80e1b3f`，144 行） |
| t1 的 3 项 BLOCKER 是否处置 | **2 项已关闭（B-1 由 t4、B-2 由 t3），1 项未关闭（B-3，需授权跨写范围）** | §3 / §6 |
| 六处集成尾巴 | 尾巴 1（两阶段结算）**已接**；尾巴 4（预算提醒）**已接**；尾巴 2、3、5、6 **未接**（其中 3 是刻意不填数） | §3 逐行 |
| 门禁状态（当前树） | **8/8 绿**（我自己的连续跑，01:00:28–01:03:41） | §2.1 第 5 列 |
| 是否可推送 | **可进入 t6 复核 → t7 提交**，但有 3 条前置：①提交必须 `git add` 未跟踪文件（**64 项**：docs 23 / tests 29 / src 6 / scripts 6，即 `git status --porcelain=v1` 的 `??` 条目，2026-10-30 01:12 取样；§6 第 12 行）；②B-3 的两处过期表述要么授权更新、要么以本报告为指针；③t9 结构债与 t8 的 NC-A 残余是**下一轮**项 | §6 |

**一句话**：审计发现的三处阻断已处置两处；八门在 01:00–01:03 这棵树上全绿（**这是带时点的断言**——同一棵树在 23:17 是 7 绿 1 红）；本轮交付的是**库层机制 + 部分生产接线**，不是「全部集成尾都已接」。

## 2. 独立复核结果（引用 t1 实测数据）

### 2.1 八门退出码表（t1 三批 + 本轮复跑）

| 门 | t1 22:22–22:25 | t1 22:41–22:45 | t1 23:17–23:22（最新批） | **本轮复跑（t5）** | 本轮关键输出 |
| --- | --- | --- | --- | --- | --- |
| `pnpm run typecheck` | 0（11.8s） | 0（12.3s） | 0（10.2s） | **0**（10.5s，01:00:28） | 无输出 |
| `pnpm exec vitest run` | 0（127 files / 2429） | 0（129 / 2461） | 0（129 / 2461；23:31 复跑 130 / 2462） | **0**（74.4s，01:01:43） | `Test Files 130 passed (130)`、`Tests 2493 passed (2493)` |
| `pnpm run check:docs` | 0（127/2429 精确一致） | **1** | **1**（83.2s；23:31 复跑仍 1） | **0**（77.1s，01:03:00） | `SUCCESS: All README.md test counts match Vitest results exactly!`、`SUCCESS: documentation gate fully green.`、`Config reference coverage: 78 vs 78` |
| `pnpm run check:encoding` | 0 | 0 | 0（3.1s，333 blobs） | **0**（2.6s，01:03:03） | `SUCCESS: every tracked blob is LF text or an explicit -text exception` |
| `pnpm run check:build-smoke` | 0 | **1** | 0（3.4s） | **0**（3.2s，01:03:06） | `SUCCESS`；`artifact-is-esm ok`；`esm-import ok`；`export-surface: 72 named exports`；artifact 1185632 B |
| `pnpm run check:negative-result` | 0 | 0 | 0（2.4s） | **0**（2.3s，01:03:08） | `A1..A6 PASS - the historical negative result is intact` |
| `pnpm run guarded-regression` | 0 | 0 | 0（2.2s，37 probes） | **0**（2.2s，01:03:10） | `"passed": 37`、`"failed": 0` |
| `pnpm run check:mutation` | 0（46.4s） | 0（30.7s） | 0（31.7s） | **0**（30.4s，01:03:41） | `[M1] KILLED red=4/4`、`[M2] 5/3`、`[M3] 3/2`、`[M4] 2/2`、`worktree zero-residue: OK`、`verdict: PASS` |

**读法**：t1 的判读是「『八门全绿』是带时点的断言」——这一点被本轮证实：同一棵树的 `check:docs` 在 22:41 变红、在 t4 重铸 README 后 00:46 起恢复绿。**本轮 8/8 绿的时点 = 01:00:28–01:03:41**，不代表此后任何时刻都绿。

`check:build-smoke` 的 `export-surface` 从 70 → **72**：t3 新增了 `resolveBudgetHookConfig`、`assembleMeasuredCostObservations` 两个导出（`docs/reports/p2-p6-host-wiring.md` §7.3），我用产物 `import()` 独立复核：**72** 个导出，这两个都在面内（§3 尾巴 3/4 的证据）。

### 2.2 抽查结论（t1 §5）

t1 亲手重跑了 45 行抽查表（跨 23 份报告）：**精确一致 26 / 时点漂移 12 / 不可比 1 / 无支撑或报告自身错误 6**。

> **登记（标题与内容不一致，不改动历史文件）**：`docs/reports/p2-p6-integration-audit.md:61` 的标题写「**34 条**」，而其表体为 **45 行**、末行统计写「**45 项**」。两种读法都出现过（lead 的任务说明写 34，文件内容写 45）。本报告按**表体 45 条**引用，并把该不一致登记为遗留项（§6 第 11 行）。
>
> 同类登记：同文件 §4 标题写「五处集成尾巴核实」，表体为 **6 行**（#1–#6）。本报告按 **6 行**逐项处理（是 5 处的超集），不因此丢掉任何一条尾巴。

抽查里对下游最重要的三条：①第 10 行 `verify-pr4a-artifacts` 的 **176** 断言**不可比**（当前口径 `checked=691 passed=691 failed=0`，无法从当前树复算 176）；②第 22 行 `9 + 21 + 4 = 32` 既无支撑又是算术错误（实测 34）；③第 42 行 `p2-p6-final-verification` 同一报告内 `2428` 与 `2429` 冲突。**这三条都是报告层面的缺陷，不是代码缺陷。**

### 2.3 越界扫描（t1 §3 的 10 行 + 我的复跑）

| 项 | 命令 | t1 实测（00:04） | 本轮复跑（01:03） | 判定 |
| --- | --- | --- | --- | --- |
| 不得 commit | `git rev-list --count feb8465..HEAD` | 0 | **0** | ✅ |
| 不得 push | `git rev-list --left-right --count origin/main...HEAD` | 0 0 | **0 0** | ✅ |
| 不得改历史 | `git reflog -3` | 无 reset/rebase/amend | （未复跑；t1 证据保留） | ✅ |
| 冻结报告家族 | `git diff --stat -- docs/reports/pr4a-*.md docs/reports/p61-*.md docs/reports/p62-*.md docs/reports/final-attestation.json` | 空 | **空** | ✅ |
| CI 语义 | `git status --porcelain -- .github` | 空 | **空** | ✅ |
| 已跟踪报告整体 | `git status --porcelain --untracked-files=no -- docs/reports` | **空** | **1 行：` M docs/reports/t2-dreamer-release-effect-matrix.md`** | ⚠ 见下 |
| skip/only/todo 标记 | t1 自写脚本扫 129 个 `*.test.ts`、11 类标记 | 全部 0 命中 | （未复跑；t1 证据保留） | ✅ |
| 真实付费痕迹 | `grep API_KEY / apiKey / fetch( / https://api` 于 `src/**` | 各 0 命中 | （未复跑；t1 证据保留） | ✅ |
| 工作树规模 | `git status --porcelain` | 39 改 + 61 未跟踪 | **42 已跟踪状态行 + 64 未跟踪**（`??` 条目：docs 23 / tests 29 / src 6 / scripts 6；01:12:14 取样；本条初版误写「111」，更正见 §6 第 12 行） | 记录 |

**关于第 6 行的那 1 处改动（必须说明，不得掠过）**：`docs/reports/t2-dreamer-release-effect-matrix.md:250` 在 t4 被改了**一处路径引用**（`units/integration/p4-wiring.test.ts` → `tests/unit/integration/p4-wiring.test.ts`），因为前者解析不到而后者真实存在。该修改是 lead 在 t4 任务书「必做 3：文档一致性——发现即修，只改路径引用」中**授权的**；**未改任何数字、结论、阈值或标签**，且**冻结家族（pr4a-* / p61-* / p62-* / final-attestation.json）仍为零改动**（上表第 4 行实测为空）。
> 因此「t1 取样时已跟踪报告零改动」这一**不变量在本轮被一次授权修改打破**；本报告把它显式写出，而不是让读者从 `git status` 里自己发现。

## 3. 尾巴处理明细（逐项：改前状态 → 做了什么 → 证据 → 现在是否已接）

「改前状态」一列取自 `docs/reports/p2-p6-integration-audit.md` §4（t1 在 22:22–23:20 逐行读过并 grep 过）；「现在」一列是**我在 01:00–01:05 自己重测的**。

| # | 尾巴 | 改前（t1，22:22–23:20） | 做了什么 | 证据（命令 + 退出码 + 时刻） | 现在 |
| --- | --- | --- | --- | --- | --- |
| 1 | **两阶段结算** | **已接**（executor 6 处 settle 全经协调器；adapter `:487/:540/:589`） | t2：新建 `src/ledger/two-phase.ts`（`TwoPhaseSettlement` / `reconcileLateUsage` / `bookNewAttempt` / `LedgerCallIndex`），两个消费方改走协调器；新增 32 条确定性测试 | `pnpm exec vitest run tests/unit/ledger/p3c-two-phase-wiring.test.ts tests/unit/dsh-bridge/p3c-two-phase-bridge.test.ts` → **exit 0，2 files / 32 tests passed**（01:04:36）；`tests/unit/ledger tests/unit/dsh-bridge` → **exit 0，17 files / 279 tests**（01:04:31） | **已接**（与 t1 一致） |
| 2 | **迟到 usage 的真实来源（宿主事件入口）** | **未接** —— 入口存在但无生产调用方 | 未做（t2 只提供入口） | `Select-String -Path src/index.ts -Pattern reconcileLateUsage` → **0 命中**；`callIdentities` → **0 命中**（01:03:59） | **仍未接**（真实缺口，见 §6 第 2 行） |
| 3 | **P6 R7 `costObservations` 真实来源** | **未接**（全仓 0 个生产者） | t3：新增 `assembleMeasuredCostObservations`（全 measured 才返回数组，否则 `undefined`）+ 12 条负例；**构造点刻意不填数** | `pnpm exec vitest run tests/unit/jitrl/p6-host-wiring.test.ts` → **exit 0，32 passed**（01:04:18）；产物 `import()`：`assembleMeasuredCostObservations` **在公开面**；`src/index.ts:1537` 有透传分支，但唯一调用点 `:1724 resolveBudgetHookConfig(jitrl.budget)` **不传 costObservations** → 生产路径零取用 | **仍未接（t3 的正式判定是 `failed`，不是「部分完成」）** |
| 4 | **预算提醒开关** | **未接** —— `src/index.ts` 对 `budget` 0 命中 | t3：`src/config.ts` 新增可选叶 `JitRlConfig.budget?`（**无默认值**，避免改变默认行为）+ `export resolveBudgetHookConfig()` + 唯一生产构造点条件注入 | 同上测试（32 passed）；`src/index.ts:1724` 取值、`:1759` 注入 `...(budgetHook === undefined ? {} : { budget: budgetHook })`（01:03:59）；影子对照见 §4 | **已接（默认关闭，零行为变化）** |
| 5 | **授权账本 `createProbeAuthorizationLedger` 调用点** | **未接，且比报告更空**（连公开面都没有） | 未做（t3 判定超写范围，给最小补丁草案） | `Select-String src/index.ts -Pattern createProbeAuthorizationLedger` → **0 命中**；产物 `import()` → **not-in-surface**（01:03:59） | **仍未接** |
| 6 | **工具面 allowlist 生产开关** | **未接** | 未做（同上） | `Select-String src/index.ts -Pattern createToolFaceRegistry` → **0 命中**；产物 `import()` → **not-in-surface**（01:03:59） | **仍未接** |

**t1 的另一条结构事实（我复核后仍然成立）**：产物 72 个导出里，`createProbeAuthorizationLedger`、`createToolFaceRegistry`、`TwoPhaseSettlement`、`twoPhaseSettlementFor`、`LedgerCallIndex`、`createLedgerReservationManager`、`assembleAgentLoopLedger`、`createMeteredModelAdapter`、`evaluateBudgetGate`、`resolveBudgetTier` **全部 not-in-surface** → 「机制就绪」严格说是**库层就绪**，宿主无法从公开入口取用。（本报告对这条做的是**复核**，不是**改变**。）

## 4. 默认行为不变的证据（影子对照）

**判据**：t3 的接线可能改变默认行为，唯一有力的证据是「接线后默认配置产出的字节 == 接线前的 pinned 字节」。

```text
命令: pnpm exec vitest run tests/unit/jitrl/p6-host-wiring.test.ts
退出码: 0，Tests 32 passed (32)        取样: 2026-10-30T01:04:18+08:00
HOST-WIRING SLOTS_DIGEST=a8c207ca083336b1a2828f88f428fa68a53a30ca37fad098157b3bcbdbbd16a1 PASS
HOST-WIRING DIAG_DIGEST=f2c0737a844a6a3d007de0c78092fafb1afe8a0825dad98eb91cc840c63b647a PASS
```

两个 pinned 值取自 `tests/unit/jitrl/p6-pareto-budget.test.ts:254/257`（**改动前**固化），与「接线前」逐字节相同 ⇒ 默认配置下 `BatchPlan` 与 `metadata.jit` 零变化。

**为什么这不是「自己给自己打分」**：影子对照写在**正式测试**的断言里（`describe('default configuration: the decorator is byte-identical to the pre-wiring build')`），不是 probe；该文件另钉住开关两态（下表取自 `docs/reports/p2-p6-host-wiring.md` §1.4；我这次复跑的是整文件，**逐条两态断言由它在 32 passed 中覆盖**）：

| 性质 | 断言形态（摘要） |
| --- | --- |
| 关则零对象 | `resolveBudgetHookConfig(undefined) === undefined`；`reminder.enabled` 缺省永不 `true`；`hasOwnProperty(budget,'reminder') === false` 且 `JSON.stringify(budget)` 不含 `reminder` |
| 默认配置零诊断键 | `hasOwnProperty(diagnostics,'budget') === false` 且 `JSON.stringify(diagnostics)` 不含 `budget` |
| 只 ask 不 deny | 开/关两态 `executionSurface(...)` **逐字节相同** |
| sink 抛错不失败决策 | `onReminder` 抛错 ⇒ 计划仍正常产出 |
| 独立性 | 四种 execution mode 下 `resolveBudgetHookConfig` 输出完全相同（结构上不可能读 mode） |

**未做的部分（不得读成已做）**：影子对照覆盖的是**装饰器决策摘要**（slots / metadata.jit）；它**不**覆盖真实宿主事件循环、真实 provider 时序、多进程并发写 `ledger.calls.jsonl`（§8）。t1 记录过的 `WIRE_RESULT_DIGEST=43248a70…`（上一轮的临时 probe，测整次 e2e run）**已随该 probe 文件删除而作废**，与这里的摘要不是同一夹具，不可互相替代。

## 5. 授权边界（未执行项 + 授权申请文本）

本轮**未执行**的项，逐条给出「为什么没做」与「需要什么」；**没有把未执行项写成已完成**。

| 项 | 状态 | 为什么没做 | 需要什么（授权 / 裁定） | 本轮替代验证 |
| --- | --- | --- | --- | --- |
| 真实付费模型调用 | **未执行（需授权）** | 本轮纪律明令禁止 | 显式授权 | 注入式 fake model（hanging / aborting / measured）+ 真实 WAL 临时目录 + 真实 factory；`tests/unit/ledger` + `tests/unit/dsh-bridge` 279 passed（01:04:31） |
| 真实宿主 smoke（Cordis 宿主挂载） | **未执行（需授权）** | 同上 | 显式授权 | `tests/e2e` 168 passed（含 `plugin-entry` / `persistence-restart`）；`tests/unit/jitrl/p6-host-wiring.test.ts` 32 passed（01:04:18） |
| 真实外部工具调用 / 记忆写入 | **未执行（需授权）** | 同上 | 显式授权 | 工具运行时为记录型 fake；`guarded-regression` 37/37（01:03:10） |
| 授权账本接真实调用点 | **未执行（需裁定）** | 真实调用点在 `dsh-bridge/**`，超 t3 写范围；只接一半会造成「部分路径受控、部分裸奔」的伪安全 | 扩展写范围到 `src/dsh-bridge/**`，或拆独立任务 | 机制有 12/12 测试（`probe-authorization.test.ts`），但**无生产调用点**（§3 尾巴 5） |
| 工具面 allowlist 生产开关 | **未执行（需裁定）** | 需改 `cordis-seams/**`；且「策略从哪来」本身需裁定；新增 option key 会破 26 键公开面 | ADR 0005 §3.1 同步 + 写范围扩展 | 现状已满足「默认不下发」（`src/index.ts:1766-1772` 不传 `toolFace` / `toolAllowlist`） |
| `costObservations` 活视图 | **未执行（需裁定）** | 需把 `BudgetHookConfig.costObservations` 改成 provider 函数，会破坏 `PINNED_DECORATOR_SHA256`（P6 交付物）；且账本只有 `qualityEvidence` 布尔、无质量数值 | 队长裁定是否允许动 P6 pinned 文件 | 组装规则 + 12 条负例（全部断言 `undefined`）；生产构造点**刻意不填数** |
| 两阶段协调器类型级 / 结构级加固 | **未执行（本轮裁定为下一轮）** | 会改动两个**已验收的桥文件**，而 t1 正在复核这两个文件的字节 | 下一轮执行（t9 已登记 A+B） | t9 登记件 + 运行时探针 P1/P2 证明「拦住绕过的是测试，不是类型」 |

**授权申请文本（原样引用，供 lead 直接使用）**：

- 真实付费调用 / 真实宿主 smoke（来自 `docs/reports/p3-c-usage.md:97`）：
  > 「申请以 `agentLoop.ledger.enabled=true` 跑一次真实探针 smoke 验证两阶段结算与迟到对账在真实 provider 流上的行为。」
- cancel→interim→迟到 usage→reconcile 的真实链路（来自 `docs/reports/p3-c-two-phase-wiring.md:312`）：
  > 「申请以 `agentLoop.ledger.enabled=true` 对一次真实 provider 调用执行 cancel→interim→迟到 usage→reconcile 的 smoke，以核对真实流上的 usage 时序与 `ledger.calls.jsonl` 的落盘时序。」
- 授权账本 / 工具面（来自 `docs/reports/p2-p6-host-wiring.md` §8）：扩展写范围到 `src/dsh-bridge/**` 与 `cordis-seams/**`，或拆成独立任务；工具面另需 ADR 0005 §3.1 同步。

## 6. 已知遗留（谁知道 · 什么时候修 · 修法）

| # | 遗留项 | 谁知道 | 什么时候修 | 修法 | 当前状态证据 |
| --- | --- | --- | --- | --- | --- |
| 1 | **B-3 两处过期表述**：`p3-c-usage.md` §7.1 与 `p4-c-toolface.md` §7.1 仍写两阶段「未接」，而代码已接 | t1、t2、lead | **已裁定：不改那两份旧报告，以本报告为指针** | `p3-c-usage.md` §7.1 与 `p4-c-toolface.md` §7.1 写于 2026-10-29，记录的是**当时**的接线状态（未接）；**截至 2026-10-30 已由 t2 接通**，见本报告 §3 尾巴 1。**两份文档保留其时间语境，不作为当前状态依据。**——注意这不是「旧报告错了」，而是「旧报告记录了一个真实事实，而那个事实已过期」；前者会让人怀疑旧报告的整体可靠性，后者只提醒读者注意时点 | t1 §6-B-3；本报告 §3 尾巴 1 |
| 2 | **H-1 迟到 usage 无生产调用方** | t1、t2 | **下一轮**（需要宿主事件入口的适配器） | 在 `src/index.ts` 把宿主 provider 回调接到 `agentExecutor.reconcileLateUsage` | `src/index.ts` 对 `reconcileLateUsage` / `callIdentities` **0 命中**（01:03:59） |
| 3 | **H-2 五个机制不在公开导出面** | t1 | **下一轮**（与尾巴 5/6 一起） | 在 `src/index.ts` 显式 re-export（或提供宿主装配入口） | 72 导出里逐个 `not-in-surface`（01:03:59） |
| 4 | **H-3 三处报告内部数字矛盾**（`p3-a-assembly` 19/17 vs 实测 20；`p3-b-adapter` 9+21+4=32 vs 实测 34；`p2-p6-final-verification` 2428 vs 2429） | t1 | 下一轮（**改历史报告需授权**） | 逐处加「更正（原错误同址 + 双向指针）」，不改数字本身的历史性 | t1 §5 第 20/22/42 行 |
| 5 | **M-1 `smoke-build.mjs` 的 require 正则仍是脆弱判据** | t1（M-1）、t2、t8 | 下一轮（**改门禁语义需授权**） | 加正向判据或 AST 判定；**不要**为了通过而放宽正则 | t8 的 NC-B 复现了它（附录 A） |
| 6 | **M-2 取证路径失效** | t1 | **本轮已修**（t4） | 指向常驻夹具 `tests/fixtures/p2-l1/p2-v3-selection-{clean,holdout-leak}.json` | 我复跑：clean exit 0 `ok:true` / leak exit 1 `ok:false`（附录 B） |
| 7 | **M-3 工作树 EOL 不受门禁覆盖**（18 个已跟踪文件工作树为 CRLF） | t1 | 下一轮（**改门禁范围需授权**） | 决定是否把工作树 EOL 纳入门禁；当前 `check:encoding` 只看 HEAD blob | t1 §6-M-3 |
| 8 | **M-4 `p3-c-two-phase-wiring.md` §5 有一处行号偏移**（`agent-loop-executor.ts:957` 应为 `:958`） | t1 | 下一轮（改已交付报告需授权） | 单行更正 | t1 §6-M-4 |
| 9 | **L-1 新测试目录需确认前缀归属**；**L-2 5 个文件缺末尾换行** | t1 | 下一轮 | 目录前缀确认；补末尾换行 | t1 §6-L-1 / L-2 |
| 10 | **t9 结构债 A+B**（`settleCall` 类型收紧 + 桥文件不再持有 manager + AST 门禁） | t9、t2、lead | **下一轮第一件事**（登记件可直接照做） | 见 `p3-c-structural-debt-register.md` §3；**A、B 一起做**，且必须对最终字节重做负控制 | 登记件 §1 四条现状逐条复核成立；我复跑 `src/dsh-bridge` 的 manager settle / reserve 调用 → 10 命中**全是** `branch.ts` 的 `recorder.settle(` ⇒ 字符串正则门禁会误伤，**必须 AST** |
| 11 | **t1 报告的标题 / 行数不一致**（§4「五处」vs 6 行；§5「34 条」vs 45 行） | t1、本报告 | 下一轮（或 t1 自行在同址更正） | 改标题或补一行说明，**不要静默** | `p2-p6-integration-audit.md:49 / :61 / :110` |
| 12 | **提交前置：64 项未跟踪文件**（`??` 条目：docs 23 / tests 29 / src 6 / scripts 6；含本轮 4 份被 t4 改过的文档、本报告、t1 / t3 / t9 报告） | release、lead | **提交时必须** | `git add` 全部本轮产物后再跑门禁；否则 CI 会在**提交后的树**上红 | **更正记录（2026-10-30T01:12:14 取样）**：本条初版写「111 项」，来源是我用 `Where-Object { $_ -like '??*' }` 过滤 `git status` —— `?` 在 PowerShell 的 `-like` 里是**单字符通配符**，该过滤器匹配了**全部**状态行（106 行），不是未跟踪数。正确口径：`git status --porcelain=v1` 中 `StartsWith('??')` 的条目 **64**（docs 23 / tests 29 / src 6 / scripts 6；若用 `--untracked-files=all` 则为 70，因为新目录内的文件被逐个列出）。README 与各报告均按**工作树**取数 |
| 13 | **t8 的 NC-A 残余**：套件内 `esm-import` 与 plain node 导入**不等价**（vitest 提供了 `require`），裸 `require(...)` 语句在套件内存活 | t8、t5 | 下一轮（lead 已批准方向） | 在同一 describe 加一条 plain-node 子进程断言（复用 beforeAll 产物，不改 `smoke-build.mjs` 默认语义） | 附录 A（t8.4） |
| 14 | **ADR 0007 §4 登记的文案漂移未应用**（`src/runtime/execution-profile.ts:121` 与 ADR 0002:51 仍写 non-inferiority / 非劣） | t5（t4 登记） | 下一轮（需动 `src/**` 与 ADR 0002，均不在 t4 / t5 写范围） | 按 ADR 0007 §4 的可粘贴替换行执行 | t4 §4（我逐行核过：两处位置**引用有效**，漂移在**内容**不在**指针**） |
| 15 | **J-1（门禁缺口，未修）**：`check:docs` 的 fail-closed 判据**只判** `numFailedTests` / `numPendingTests`，**不看** `success` / `numFailedTestSuites` / `unhandledErrors`。构造『计数完全正确（130 files / 2493 tests、unit 116/2325、e2e 14/168 逐项匹配）但 `success=false` 或 `unhandledErrors` 非空』的 vitest 报告，可获 **exit 0 / fully green**。**复现前提是计数必须正确**——用计数不匹配的假报告会先被计数检查挡住（exit 1），于是看起来门禁是好的。影响：CI 若发生 worker 崩溃 / OOM / 未捕获 promise rejection 而断言数未变（已跑完的仍是 passed），门禁仍绿，**推送会被误读成「全绿交付」**。**本轮 GO 不覆盖该缺口。** | t6（提出）、auditor（四组注入复现）、lead（复核） | **下一轮**（需授权改门禁语义） | 判据加 `success === false` 或 `unhandledErrors.length > 0` 任一成立 ⇒ FAIL（**改门禁语义需授权**） | 判据范围由我在 2026-10-30T01:40 直接读 `scripts/verify-readme-counts.mjs:404-430` 核对（该区间只读 `numFailedTests` / `numPendingTests` 与逐条断言的 status；`success` / `numFailedTestSuites` / `unhandledErrors` 在该脚本里 0 命中）；注入对照：v1（`success=false` + `unhandledErrors` 非空） / v2（`numFailedTestSuites=1`） / v3（`numTodoTests=1`）均 **exit 0 + fully green**，计数不匹配的对照 **exit 1**。**本条为补记**：本报告第一版（t5，2026-10-30T01:13:09 定版）与**已推送的 commit** `a50bd3f8ebefe3749abae45fb5b2bd48e9cf6727`（commit-date 2026-10-30T01:36:53、推送 2026-10-30T01:38:53）**均不含本条**；发现遗漏后按『更正必须与原错误同址』记在**原处、不另开文件**，并显式标注为**事后补记**——不把补正伪装成当时就写过。 |

## 7. 可复算证据（命令 + 退出码 + 取样时刻）

| # | 命令 | 退出码 | 关键输出 | 取样时刻（+08:00） |
| --- | --- | --- | --- | --- |
| 1 | `pnpm run typecheck` | 0 | （无输出） | 01:00:28 |
| 2 | `pnpm exec vitest run` | 0 | `Test Files 130 passed (130)` / `Tests 2493 passed (2493)` | 01:01:43 |
| 3 | `pnpm run check:docs` | 0 | `Parsed == Actual == 130/2493`（Unit 116/2325、E2E 14/168）；`SUCCESS: documentation gate fully green.`；`78 vs 78` | 01:03:00 |
| 4 | `pnpm run check:encoding` | 0 | `SUCCESS: every tracked blob is LF text or an explicit -text exception` | 01:03:03 |
| 5 | `pnpm run check:build-smoke` | 0 | `artifact-is-esm ok`、`esm-import ok`、`export-surface: 72 named exports`、1185632 B | 01:03:06 |
| 6 | `pnpm run check:negative-result` | 0 | `A1..A6 PASS - the historical negative result is intact` | 01:03:08 |
| 7 | `pnpm run guarded-regression` | 0 | `"passed": 37`、`"failed": 0` | 01:03:10 |
| 8 | `pnpm run check:mutation` | 0 | `[M1] 4/4`、`[M2] 5/3`、`[M3] 3/2`、`[M4] 2/2`、`worktree zero-residue: OK`、`verdict: PASS` | 01:03:41 |
| 9 | `pnpm exec vitest run tests/unit/jitrl/p6-host-wiring.test.ts` | 0 | 影子对照两条 `PASS` + `Tests 32 passed (32)` | 01:04:18 |
| 10 | `pnpm exec vitest run tests/unit/ledger tests/unit/dsh-bridge` | 0 | `Test Files 17 passed (17)` / `Tests 279 passed (279)` | 01:04:31 |
| 11 | `pnpm exec vitest run tests/unit/ledger/p3c-two-phase-wiring.test.ts tests/unit/dsh-bridge/p3c-two-phase-bridge.test.ts` | 0 | `2 files / 32 tests passed` | 01:04:36 |
| 12 | 产物 `import()` 探针（`file:///…/lib/index.js`） | 0 | `artifact-export-count: 72`；10 个符号 not-in-surface；`resolveBudgetHookConfig` / `assembleMeasuredCostObservations` 在面内 | 01:03:59 |
| 13 | `git rev-list --count feb8465..HEAD` | 0 | `0` | 01:03:59 |
| 14 | `git rev-list --left-right --count origin/main...HEAD` | 0 | `0 0` | 01:03:59 |
| 15 | `git status --porcelain -- .github` | 0 | 空 | 01:03:59 |
| 16 | `git diff --stat -- <冻结家族>` | 0 | 空 | 01:03:59 |
| 17 | `git status --porcelain --untracked-files=no -- docs/reports` | 0 | ` M docs/reports/t2-dreamer-release-effect-matrix.md`（t4 授权路径修正） | 01:03:59 |
| 18 | `node scripts/eval/pr4a-stats.verify.mjs --firewall … --artifact tests/fixtures/p2-l1/p2-v3-selection-clean.json` | 0 | `ok: true`、`violations: []` | 00:47（t4） |
| 19 | `node scripts/eval/pr4a-stats.verify.mjs --firewall … --artifact tests/fixtures/p2-l1/p2-v3-selection-holdout-leak.json` | 1 | `ok: false`（点名 `v3-ci-01`） | 00:47（t4） |
| 20 | `pnpm exec vitest run tests/unit/p62/evidence-gates.test.ts` | 0 | `43 passed (43)` | 23:09（t8） |
| 21 | `node scripts/eval/smoke-build.mjs --json`（NC-A 变异 + 强制真构建） | 1 | `esm-import FAIL: Dynamic require of "node:fs" is not supported` | 23:04（t8） |
| 22 | `node work/t8-nc/plain-import.mjs`（同一产物字节） | 1 | 同上（plain node） | 23:06（t8） |

## 8. 本报告不声明什么

1. **不声明「报告数字都可信」——本条置于首位，因为它已经有具体实例**：**本报告的第一版就有一个数字是错的**——§1 与 §6 曾把未跟踪文件数写成「111 项」，实测是 **64**（`git status --porcelain=v1` 的 `??` 条目：docs 23 / tests 29 / src 6 / scripts 6，2026-10-30T01:12:14 取样）。错因是过滤条件 `-like` 把 `?` 当成**单字符通配符**，于是匹配了全部 106 行状态行——正是 runbook §0 说的「证据的形式（一个数）比它的范围权威」。数字已更正（§2.3 / §6 第 12 行），更正记录保留在 §6 第 12 行。叠加 t1 抽查自己指出的 **6 条无支撑 / 报告自身错误**（§2.2）：**本报告的数字要按命令复核，不能因为写在报告里就采信。**
2. **不声明「八门长期全绿」**：8/8 是 **01:00:28–01:03:41 这一个窗口**的实测；同一棵树在 23:17 是 7 绿 1 红（`check:docs`）。
3. **不声明「集成尾全部已接」**：六行里只有尾巴 1（两阶段结算）与尾巴 4（预算提醒）已接；尾巴 2 / 3 / 5 / 6 未接，其中 3 是**刻意不填数**（宁可 `undefined` 也不填假数据）。
4. **不声明「功能正确性」**：本轮证据只覆盖库层行为、契约测试、门禁脚本、产物形状与字节哈希。
5. **不声明「真实宿主 / 真实 provider / 真实成本口径」**：三者都需授权，本轮**未执行**（§5）。
6. **不声明「没有更多问题」**：抽查 45 行、越界 10 项、尾巴 6 行、门禁 8 门——**这个覆盖面不等于穷举**。未覆盖：真实 provider 迟到 usage 的到达顺序、多进程并发写 `ledger.calls.jsonl`、真实宿主事件循环、`--format=cjs` 产物形状。这些标【未知】。

**t1 §8 第 6 条原样引用**（lead 指定必须原样引用）：

> 6. **不声明『找不到更多问题』= 通过**：我的变异空间只覆盖（i）门禁脚本的实际执行、（ii）源码结构 grep、（iii）产物导入、（iv）字节哈希、（v）工作树 EOL；**未覆盖**真实 provider 时序、多进程并发写 `ledger.calls.jsonl`、真实宿主事件循环。这些标【未知】。

远端的提交与推送**不属于本报告的执行范围**（t1 §3 实测 `origin/main...HEAD = 0 0`，本轮无 push）；执行者是 release（t7），前置门禁是 t6 的 go / no-go。
---

## 附录 A：t8 片段（按 `fe49734e…` 原样转写）

> 本附录是 `work/t8-nc/t8-report-fragment.md` 的**原样转写**（`work/` 被 gitignore，不入库；这是 lead 指定的 t5 硬约束）。
> 身份键：sha256 `fe49734e70f1983a3cb9d2b2598e3f69096ddf044a1991710f1318cb5377c44c`、9080 B（t5 转写前已复核，与 lead 指定值一致）。

## t8. evidence-gates 的 `skipBuild` 绕过（t2 遗留待办，已修复）

> 供 t5 汇总进 `docs/reports/p2-p6-integration-round.md`（本文件是 t8 的原始记录，`work/` 不入库）。
> 基线 HEAD `feb8465`，工作树 dirty（本轮整轮不 commit）。

### t8.1 缺陷（改前实测：测试说绿、门禁说红）

`tests/unit/p62/evidence-gates.test.ts` 的 build/ESM 冒烟用例传的是
`smokeBuild({ skipBuild: fs.existsSync(artifact) })`：`lib/index.js` 一旦存在就**复用旧产物**，
被测字节不再是当前源码构建出来的。门禁脚本 `scripts/eval/smoke-build.mjs` 本身正确
（默认必构建，`skipBuild` 只由 `--skip-build` 触发），**绕过发生在测试自己这一侧**。

改前实测（在 `src/index.ts` 追加一条真实 CommonJS `require('node:fs')`，**不重建**）：

| 路径 | 命令 | 结果 |
| --- | --- | --- |
| 旧用例（`fs.existsSync` 为真 ⇒ skipBuild） | `pnpm exec vitest run tests/unit/p62/evidence-gates.test.ts -t "PR-1 build/ESM smoke gate"` | **exit 0，3 passed**（旧产物 sha256 `a6c2a284…`，绕过成立） |
| 门禁脚本（强制真构建） | `node scripts/eval/smoke-build.mjs --json` | **exit 1**，`esm-import` FAIL：`Dynamic require of "node:fs" is not supported` |

这正是 t2 §6.2 描述的失效形状：**用过期证据判通过**。

### t8.2 修法：选 A（强制真构建），不选 B

1. **A 让「产物由当前源码构建」成为唯一状态**，而 B 会保留一条「复用旧产物」的合法路径——
   这条路径正是本次缺陷的载体。**B 并非没有价值**：把「正在复用旧产物」显式化、可失败化，
   在有意保留 `skipBuild` 为常态的项目里是有意义的；只是在这里，这条用例的全部价值就是断言
   产物由**当前**源码构建，跳过构建等于取消它的意义。
2. 附带理由（不是主要理由）：B 需新增一条真构建用例，会改动测试条数（牵动 README 计数）；
   A 保持 43 条不变。
3. 实现把真构建放进 describe 级 `beforeAll`（`smokeBuild()` 无参 = 必构建）：一次构建被下面两条用例共享，
   `-t` 过滤运行时也会先构建，因此不存在「哪条用例拿到旧产物」的缝隙；用例 1 额外断言首步就是
   `pnpm run build`（而不是 `skipped (--skip-build)`），把「这次真的构建了吗」变成可失败的断言。

```diff
-import { smokeBuild } from '../../../scripts/eval/smoke-build.mjs';
+import { smokeBuild, type SmokeBuildResult } from '../../../scripts/eval/smoke-build.mjs';
@@ describe('PR-1 build/ESM smoke gate')
-  it('builds and imports the bundle as ESM', async () => {
-    const artifact = path.join(repoRoot, 'lib', 'index.js');
-    const result = await smokeBuild({ skipBuild: fs.existsSync(artifact) });
-    expect(result.ok, JSON.stringify(result.steps, null, 2)).toBe(true);
+  let built: SmokeBuildResult;
+  beforeAll(async () => { built = await smokeBuild(); }, 300_000);
+
+  it('builds and imports the bundle as ESM', () => {
+    // Prove the build actually ran: a skipped build is the bypass itself.
+    expect(built.steps[0]).toEqual({ step: 'build', ok: true, detail: 'pnpm run build exited 0' });
+    expect(built.ok, JSON.stringify(built.steps, null, 2)).toBe(true);
```

`scripts/eval/smoke-build.mjs` **未改动**（`git status --porcelain -- scripts/eval/smoke-build.mjs` 为空），
其默认语义（不传 `--skip-build` 必构建）原样保留。

文件身份（小写 sha256；`git hash-object` 同口径）：

| 文件 | 改前 | 改后 |
| --- | --- | --- |
| `tests/unit/p62/evidence-gates.test.ts` | `8a2826a4b10e33c31e5e55eed2c15f8284aef35b1e9f52c456679957304bf3a7`（git blob `ab779f4`） | `7aea34b6cb4b0d20ab35d62f890c82e5d9089e34ee0f4a49240632f78dd0d7ba`（git blob `24fd79a`） |
| `src/index.ts`（变异目标） | `fb4307d5bfbe9d6d0228a21a456e10310dcbb9c00062ca07c7727fe5b0e85342` | **同值**（`git status` 对该文件为空） |

### t8.3 负控制（runbook 规则 2/3/3.5/4/5.5）

变异目标一律 `src/index.ts`；按规则 2 用**副本**保底（`work/neg-control.6e16ae5d5b24.keep-bak`），
整轮**未使用** `git checkout/restore/stash`。每个变异都先过规则 3 的两次检查（`guard-inserted: True`：
注入片段在变异后存在、在备份中不存在），再跑用例；4b 在**另一次进程**里从磁盘读锚点复核。

| 变异 | 形状 | 修改后用例 | 关键输出 |
| --- | --- | --- | --- |
| NC-B | 新增**名为 `require` 的类成员**（t2 的真实实例，esbuild 保留成员名） | **红 exit 1** | `artifact-is-esm` FAIL：`lib/index.js contains CommonJS syntax (module.exports / require) despite --format=esm`；第二条用例 `exportCount`=0 连带红 |
| NC-C | 一条**字面 CommonJS require 调用** `globalThis.require('node:fs')` | **红 exit 1** | 同上（产物文本含 `.require(`） |
| NC-A | 一条**裸 CommonJS `require('node:fs')` 语句** | **存活 exit 0** → 见 t8.4 | esbuild 改写为 `__require(`，文本判据不命中 |

NC-B 的「同一变异 × 同一份旧产物」对照（证明改前确实被绕过）：

| 路径 | 命令 | 结果 |
| --- | --- | --- |
| 改前等价物（旧用例当时就是 `skipBuild:true`） | `node scripts/eval/smoke-build.mjs --skip-build --json` | **exit 0，ok:true，70 exports**（旧产物，绿） |
| 改后用例 | `pnpm exec vitest run … -t "PR-1 build/ESM smoke gate"` | **exit 1，2 failed**（真构建后 `artifact-is-esm` FAIL） |

规则 4/3.5 结果：NC-B、NC-C 各 `restore-identical: True`；新进程 4b 输出
`hash-unchanged-since-restore/red-was-recorded/red-target-matches/red-snippet-matches = True`、
`evidence-valid: True`。红日志只在**真红**分支写（NC-A 存活 ⇒ 没有为它写红日志），
`work/neg-control.6e16ae5d5b24.red.log` 首行为本次变异的身份键（`target=src/index.ts;snippet-sha256=…;case=…;test-sha256=7aea34b6…`）。

规则 5.5 汇总行（报告只引用这一行）：

```
NEGATIVE-CONTROL-COMPLETE: True  (case=NC-C; anchor h1=fb4307d5bfbe9d6d0228a21a456e10310dcbb9c00062ca07c7727fe5b0e85342; 2026-10-29T23:11:24+08:00)
```

落盘痕迹（`work/` 已 gitignore，仅本地可查）：`work/t8-nc/01…11-*`、`work/neg-control.6e16ae5d5b24.{keep-bak,red.log,h1}`。

### t8.4 存活变异与残余缺口（必须知道，已登记不实施）

NC-A（裸 `require('node:fs')` 语句）**在修好的用例里仍然绿**，原因已定位并有双向证据：

- 产物确实被真构建（sha256 `6b54d1c3af69228dee40f66e801368587603f0114b5eacb5017e52e3a6bf551a`，含 `__t8CjsRequireProbe` 与 esbuild 的 `__require` shim）；
- **vitest 内** import 这份产物**不抛错**（用例 exit 0）；**同一份字节 plain node** 导入**抛错**：
  `node work/t8-nc/plain-import.mjs` → exit 1，`Dynamic require of "node:fs" is not supported`。

即：`await import(artifact)` 在 vitest 执行环境里模块作用域**有 `require`**，esbuild 的 `__require` 因而解析成功；
**套件内的 `esm-import` 断言不等价于「plain node 能导入」**。CI 门禁 `pnpm run check:build-smoke`（plain node）能抓住它，
套件内抓不住。该缺口在改动前就存在（改动前它被另一件事掩盖：产物过期），A 不引入它、也不能单独消除它。

变异空间清单（runbook §7，≥2 项 + 实测痕迹）：

| 空间 | 试法 | 结果 | 痕迹 |
| --- | --- | --- | --- |
| 产物文本（成员名） | NC-B：类成员名 `require` | 红 | `work/t8-nc/08-rule4b-NC-B.txt`（红日志随后被同一 target 的 NC-C 覆盖；身份键含 snippet，故不误认） |
| 产物文本（属性调用） | NC-C：`globalThis.require(...)` | 红 | `work/t8-nc/09-ncC-red.log` |
| 运行时求值（eager require） | NC-A：裸 `require(...)` 语句 | **存活**（vitest 侧）/ plain node 红 | `work/t8-nc/03-*.log`、`work/t8-nc/plain-import.mjs` |
| 真 CJS emit（`--format=cjs`） | **未试**【未知】 | — | esbuild 配置固定 ESM，不在本任务授权范围 |

**后续建议（留给 captain/lead 决定，本次未改）**：若要求套件内也能抓住 NC-A 形状，可在同一 describe 内补一条
plain-node 子进程断言（例如 `execFileSync(process.execPath, [SMOKE_CLI, '--skip-build', '--json'])`，复用 `beforeAll`
刚构建的产物），断言 exit 0；不改变 `smoke-build.mjs` 的默认语义。这超出「二选一」的授权范围，故只登记不实施。

### t8.5 验收命令（第三方可复跑，cwd = 仓库根）

```
pnpm exec vitest run tests/unit/p62/evidence-gates.test.ts   # exit 0，43 passed (43)，约 62s（含 beforeAll 真构建）
pnpm run typecheck                                            # exit 0
pnpm run check:build-smoke                                    # exit 0，70 named exports
git status --porcelain -- tests/unit/p62/evidence-gates.test.ts src/index.ts scripts/eval/smoke-build.mjs
#   -> 只有 tests/unit/p62/evidence-gates.test.ts 为 M
```

---

## 附录 B：t4 文档收尾明细（本轮文档层修复）

| # | 修复 | 改前（证据） | 改后（证据） | 文件身份 |
| --- | --- | --- | --- | --- |
| B-1 | runbook L487 的 `powershell` fence 引用未定义变量（默认模式**纯静默**） | 逐字运行：输出长度 0、退出码 0、`$Error.Count`=0；仅严格模式下报「无法检索变量 `$matches`」 | fence 改 `text` + 首行「示意，不可直接执行」+ 文件内一行「已修说明（t4，2026-10-30）」；另核全文 8 个 `powershell` fence，其余 7 个**响亮失败**（实测 ParserError exit 1 或自带上下文注释） | sha256 `9e3edb78…` → `85f12575d46434d056487dd428b004d54761fadd6af2f4108852e8fe8a58f23e` |
| B-2 | README 计数重铸 | 我自己的 `check:docs`：exit 1，6 条计数 mismatch（README 127/2429 vs Actual 130/2493） | 取数用我自己的 `vitest --reporter=json`（01:43:31 前后，exit 0，2493 passed / 0 failed / 0 pending）→ `README.md:105` 130/2493、`:429` 116/2325、`:431` 130/2493（`:430` e2e 行本已正确）；改后 `check:docs` **三次连续 exit 0** | sha256 `dfff7e04…` → `e03a8945dd580151a7162f7e1e6dad2f6654c14faa5bf6ade4453cc4492a1a2d` |
| B-3 | 报告路径引用（全量扫描，非抽样） | docs 下 83 个 `.md` + README + ARCHITECTURE，归一化 `:line` 后缀后 **355 个路径 token、336 个存在** | 修 5 处：M-2 的 2 个失效路径 → 常驻夹具；3 个 `...md` 占位符 → 完整文件名；1 个错前缀 `units/integration/…` → `tests/unit/integration/p4-wiring.test.ts`。剩余 19 个按 7 类登记（简写 4 / scratch 7 / 缺陷与更正记录 4 / 已删除记录 1 / 假设文件 1 / 非根相对 1 / 扩展名清单 1） | 6 个文件均实测 CRLF=0、BOM=False |

**计数漂移归因（不猜）**：unit 2323 → 2325 的 +2 全部来自 `tests/unit/jitrl/p6-host-wiring.test.ts` 在 00:34:40 的一次编辑（现 32 条 `it(`）；00:20 之后无其它测试文件被改动。

## 附录 C：已裁定记录（写给下一个收尾的人）

| # | 问题 | 裁定 | 理由（裁定者原话摘要） |
| --- | --- | --- | --- |
| C-1 | 同表简写（`types/contracts.ts`、`harness2/shared.ts`、`jitrl/index.ts`、`dsh-bridge/model.ts`）是否统一补 `src/` 前缀？ | **不改** | ①它们是全仓惯例（同表邻居用裸 basename），统一补会让这一处与邻居不一致；②批量改已验收报告会产生新 diff 噪声，与「不改数字 / 结论 / 阈值」的边界摩擦；③**真正的失效是「指向不存在的文件」，不是「路径不完整」**——裸 basename 在报告语境里可解析 |
| C-2 | `work/` 到底能不能碰？ | **禁令的本意是「不要把正式产物写进 work/」**，`work/` 是 gitignored 的一次性取证目录 | t4 曾出现两条规则冲突（任务书写「禁止碰 work/」，lead 让取数写 `work/t4-counts.json`）；**t4 选择了更严的一条（写 `%TEMP%`）并显式登记冲突**，被 lead 判为正确做法 |
| C-3 | t8 的加固（plain-node 子进程断言）要不要本轮做？ | **批准方向、本轮不做** | 会新增测试条数 → 牵动 README 计数（而 t3 还在动计数）；且 t1 正在复核当前字节，改 `evidence-gates.test.ts` 会让复核对象部分失效。登记为下一轮待办 |
| C-4 | t8 片段用哪一版？ | **以 `fe49734e…` 为准**（附录 A 即该版本） | 旧版含「把选项 B 说弱」的表述，已被 lead 挑过；若片段哈希不符必须停下来问 lead，**不得用旧版** |


