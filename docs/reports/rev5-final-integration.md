# rev5 最终集成与交付报告（t23）

- **任务**：`t23` 最终集成、干净克隆门禁与交付报告
- **attempt**：`a0ac46dd-2a00-4956-a3a6-26553ce730a0`
- **执行**：integrator，2026-10-30T07:37–08:0x（Asia/Shanghai）
- **基线**：`HEAD = 97e38db37305b24f695a5f989428b3611f84987c`；工作树**未提交**（G12：提交/推送需用户显式授权）
- **前置质量门**：t18/t19/t20/t21/t22 五个实现组的第一轮交叉审核**全部 verdict=pass**（t18 P0 夹具、t19 P0 证据/文档、t20 P1/P2、t21 P4、t22 P3）
- **本报告定位**：集成证据与未决授权项的**登记**，不是新的实现声明；所有数字均为本 attempt 实测（命令 + 退出码 + 关键输出 + 时刻），不沿用历史值

---

## 1. 交付面（73 个工作树路径 + 本报告）

`git status --porcelain -uall` = **73**（28 modified tracked + 45 untracked），逐文件 sha256/bytes/行数/时刻见附录 A；快照 CSV：`work/t23/snapshot.csv`。

| 组 | 交付内容 | 关键 sha256 |
| --- | --- | --- |
| P0 夹具（t8） | `tests/fixtures/pr4a/**` 8 文件（1,112,702 B 数据）+ 元测试 18 例 | eval json `f22bdb14…`（365,314 B） |
| P0 证据（t9） | `scripts/verify-readme-counts.mjs`（J-1 fail-closed）、`final-attestation` 目标门禁、clean-tree/build-manifest/build-smoke、`docs/reports/p0-evidence-correction.md` | 契约未动 |
| P1/P2（t10） | 宿主 smoke rc2、surface 状态、JitRL 复现、探针安全闸门、`src/index.ts` 增量字段 | `host-smoke-rc2.md` `d62bc9f5…` |
| P4（t11） | `src/memory-bridge/status.ts`（三态手写 + Recall-Only + shadow 观测）、barrel、matchLessonConditions、单测/e2e | status.ts `f6927c4f…` |
| P3（t12） | 五臂复检、surrogate 自指反例、cacheRead 三态门禁、结构债 AST 门禁、两份报告 | `structural-debt-gate.test.ts` `0e5b2367…` |
| 集成（t23） | C-7 handle 聚合 + 6 例集成测试；F1/F2/F-t20-1 收口；README 计数一次重铸 | `src/index.ts` `f8014de9…` |

**需求锚点（只读对照，不覆盖实现字节）**：`docs/REV5-IMPLEMENTATION-CONTRACT.md` = `6d3fa74a…`，58,098 B，554 逻辑行（553 LF、无尾换行），与 t7 登记一致；`work/t17/replica-nc` 的独立副本证明 ADR 0005 自 t20 审核以来除本报告 §3.3 的一行外无改动。

---

## 2. 工作树门禁（全部实测，HEAD 97e38db + 73 路径）

| # | 命令 | 退出码 | 关键输出 | 时刻 |
| --- | --- | --: | --- | --- |
| G1 | `pnpm install --frozen-lockfile` | 0 | `Already up to date` | 08:04:21 |
| G2 | `pnpm run typecheck` | 0 | `tsc --noEmit` 无输出 | 08:04:22–08:04:35 |
| G3 | `pnpm exec vitest run --reporter=json --outputFile work/t23/final-vitest.json` | 0 | 150 files / **2,727 tests**、passed 2727、failed 0、pending 0、todo 0、success=true；unit 132/2510、e2e 18/217；JSON `773fcf43…`（975,801 B） | 08:04:35–08:06:14 |
| G4 | `pnpm run check:docs`（**完整**，非 docs-only） | 0 | Parsed==Actual 150/2727；`Counts close`；`Config reference coverage: 78 vs 78`；`SUCCESS: documentation gate fully green` | 08:06:14–08:07:44 |
| G5 | `pnpm run check:encoding` | 0 | `every tracked blob is LF text or an explicit -text exception` | 08:07:44–08:07:47 |
| G6 | `pnpm run check:build-smoke` | 0 | artifact 1,200,700 B；`stale: false`；export-surface 73；`SUCCESS: the bundle builds and imports as ESM` | 08:07:47–08:07:51 |
| G7 | `pnpm run check:negative-result` | 0 | `A1..A6 PASS - the historical negative result is intact` | 08:07:51–08:07:53 |
| G8 | `pnpm run guarded-regression` | 0 | JSON 报告，boundaries 含「no real model call / no real memory write」 | 08:07:53–08:07:57 |
| G9 | `pnpm run check:mutation` | 0 | M1 4/4、M2 5/3、M3 3/2、M4 2/2 全 KILLED；`worktree zero-residue: OK`；`verdict: PASS` | 08:07:57–08:08:28 |
| G10 | `pnpm run attest:verify` | 0 | `commit 1b7920ee… matches the object database`；**informational：HEAD 97e38db 不被该记录覆盖** | 08:08:28–08:08:32 |
| G11 | `node scripts/eval/check-attestation-target.mjs --json` | 0 | `mode=ordinary`、`contentOk=true`、`targetOk=true`、`ok=true` | 08:08:32–08:08:34 |
| G12 | `node scripts/verify-readme-counts.mjs --report work/t23/final-vitest.json`（J-1 判据对**最终报告**本身） | 0 | 计数逐项一致；`SUCCESS: documentation gate fully green` | 08:10:22（elapsed 0.4s，直接取最终 JSON 判据） |
| G13 | `node scripts/eval/check-clean-tree.mjs --json` | **1**（预期） | `trackedChanges=28`、`untracked=45`、`unexpected=45`；见 §6 | 08:08:34 |

补充定向复跑（同一批字节）：

| 命令 | 退出码 | 输出 |
| --- | --: | --- |
| `vitest run tests/unit/p62/docs-correction-pointers.test.ts tests/unit/p62/docs-gate-j1.test.ts tests/unit/p62/clean-tree-gate.test.ts` | 0 | 3 files / 32 tests passed（F1/F2 改后指针图与 J-1 判据仍绿） |
| `vitest run tests/unit/memory-bridge tests/unit/config/plugin-options-shape.test.ts tests/unit/dsh-bridge/probe-safety.test.ts tests/unit/jitrl/text-probe-evaluation.test.ts tests/unit/meta/no-work-dependency.test.ts tests/e2e/memory-write-path.test.ts` | 0 | 14 files / 222 tests passed（含 26 键未变、探针闸门、无 work 依赖、写路径 e2e） |
| `node work/t23/beta-comment-proof.mjs` | 0 | 两文件各 1 行变更；AST（去注释）打印**逐字节相等** ⇒ 零代码变化（见 §3.3） |

---

## 3. 三个收口项（t19 F1/F2、t20 F-t20-1）

### 3.1 F1 — `docs/reports/p0-evidence-correction.md` §3 E-3 的键来源

- **原问题**：E-3 行用 `import('@deepseek-ai/schemastery')` 作命令，却引用 `default=function keys=ValidationError,extend,resolve,from,lazy`——键集实为**模块对象自身**属性（CJS `require()` 返回该对象；ESM `import()` 的 namespace 只有 `default`），命令与引文不一致。
- **修复**：E-3 命令改为一条可逐字复跑的两句式（`require()` 键集 + `import()` namespace 形状），输出逐字取自实跑；并在表后加「E-3 的『keys』来源」澄清段（26 键来自 require()/default 对象，不是 ESM namespace 的键集）。
- **复核**：2026-10-30T08:10:42 实跑（exit 0），两条输出与表格逐字一致（`require() keys=ValidationError,extend,resolve,from,lazy,… (26 total)`；`import() namespace keys=default; default=function`）；`docs-correction-pointers.test.ts` 8/8 绿。

### 3.2 F2 — 文件头登记窗口

- **修复**：`登记时刻` 由 `04:39–04:45` 改为 `04:38–04:53`，并注明窗口覆盖 §3 最早采样（E-5，04:38:34）到最晚采样（E-4，**04:52:44**）。
- **边界**：不重写任何历史报告正文；ADR 0007 仍为 pinned 只读（E-1 值 `47e67c7d…` 未变，由 `docs-correction-pointers.test.ts` 逐字节断言）。

### 3.3 F-t20-1 — `TextProbeEvaluation` 含字面量 `reward: 0` 的措辞统一（β）

三处一次改齐，**只改注释/ADR 文字**：

| 文件 | 变更 | 证据 |
| --- | --- | --- |
| `docs/adr/0005-…md:554` | 改为「**只**携带 `reward: 0`（字面量 0，永不为正）与 `evaluable: false`，**没有** score/passed 字段」 | 与 t20 审核时副本（`work/t17/replica-nc`，`8409230d…`/65,220 B）逐行 diff：**仅第 554 行变化**；现 `6176f4cc…`/65,322 B |
| `src/jitrl/text-probe-evaluation.ts:48` | `There is no score or pass flag, and reward is the literal 0 (never positive) by design.` | 逐行 diff 仅第 48 行；AST 去注释打印相等 |
| `tests/unit/jitrl/text-probe-evaluation.test.ts:7` | `…no input yields a score or pass flag, and reward stays the literal 0 (never positive);` | 逐行 diff 仅第 7 行；AST 去注释打印相等 |

**零代码变化证明**（`work/t23/beta-comment-proof.mjs`）：对两文件用「改后文本 − 已知旧注释行」重建改前字节，逐字符 diff 恰好 1 行；再用 TypeScript `createSourceFile` + `createPrinter({removeComments:true})` 打印两版，**输出逐字节相等**（任何 token/标识符/字面量变化都会破坏相等）。行为断言未动：`expect(verdict.reward).toBe(0)` 与 "never reports a positive reward…" 仍绿（7/7）。

---

## 4. C-7：Recall-Only 聚合到 handle（t23 独占接线）

**接线前基线（必须等于 t20 审核字节）**：`src/index.ts` = `7e71cedc…`，146,288 B，mtime 06:18:02；t20 attempt `ff9406b2-dc6c-46cd-90df-85fa99674807` 于 06:44:17 pass。`work/t17/replica-nc/src/index.ts`（06:18:02 的独立副本）逐字节等于该基线，证明 t23 动手前无人再写过该文件。

**变更**：`src/index.ts` 新增 38 行、删除 0 行（唯一「删除」是 import 行重排：`type McpClient` → `type McpClient,`），现 `f8014de9…`，147,958 B。

1. `EvoHarnessPlugin` 增量成员 `readonly memory: MemoryBridgeStatus`（**不是** option key，26 键公开面不变）；
2. getter：`resolveMemoryWritableStatus({ discovery: memoryDiscoveryOf(deps.memory), profile: deps.executionProfile })`——profile 与 orchestrator 强制的是**同一个** `effectiveProfile`；
3. `memoryDiscoveryOf(bridge)`：结构化读取 `discoveryResult()`；注入的 `IMemoryBridge` 没有该访问器时返回 `null`（fail-closed 为 unknown，不猜 yes）。

**集成测试**：`tests/unit/memory-bridge/handle-memory-status.test.ts`（6 例，`b8470e1e…`）

| 场景 | 断言 |
| --- | --- |
| 默认装配（真实 bridge，无 clients） | `writable='no'`、`mode='recall-only'`、`label='Recall-Only'`、reason 含 denied；diagnostics 含 `execution mode: shadow` |
| 仅授予 permission（测试装配），无 discovery | `writable='unknown'`、仍 Recall-Only（**授权 ≠ Read-Write**） |
| stub discovery 有可写 commit 工具 + 授予 profile | `writable='yes'`、`mode='read-write'`；calls 全 0（未触 listTools/initialize/commit） |
| 同一可写后端 + 默认 profile | `writable='no'`（permission 压过后端能力） |
| 注入 bridge 缺 `discoveryResult` 访问器 | `unknown` + Recall-Only |
| 重复读取 | 两次 JSON 相等，无副作用 |

**Recall-Only 复验**：上述默认路径 + `tests/e2e/memory-write-path.test.ts` 9/9（治理拦截、命名空间隔离、回滚、默认装配 `lessonsCommitted=0`）；`src/**` 中 `memoryRealWrites\s*:\s*true` 的**构造**计数 = 0（代码行扫描，注释除外）。

---

## 5. 默认安全边界未被弱化

| 不变量 | 证据 |
| --- | --- |
| 默认 `execution.mode='shadow'`、`applyWinningPatch=false`、publish 恒拒 | `production-defaults.test.ts` 绿；`plugin.config.execution.mode==='shadow'` 在 C-7 测试中断言 |
| memory 真实写入关闭（默认 `permissions.memory.allowed=false`） | 同上 + C-7 默认断言 `writable='no'`；`src/**` 无 `memoryRealWrites: true` 构造 |
| 工具面/授权账本默认不下发；分支探针 fail-closed（`branchNoPolicy===0`） | `probe-safety.test.ts`（12/12）+ `probe-safety` 集成用例在 222 例定向跑中绿 |
| 26 键公开选项面不变 | `plugin-options-shape.test.ts` 28/28；build-smoke export-surface 73（t10 的 `surfaceStatusSnapshot` 为 handle 成员，不是 option key） |
| 不伪造真实宿主/CI/缓存/记忆证据 | host-smoke 9.4-2/9.4-3 仍 `not-run`（需显式授权）；`cacheRead` 恒 `'unknown'`；本轮无付费模型、无真实工具、无真实记忆写入 |

---

## 6. 干净克隆验收（不含本地忽略 `work/`）

- 方法：`git clone --local --no-hardlinks . work/t23-clean` → 纯 `HEAD 97e38db`；`work/`=False、`node_modules/`=False、`tests/fixtures/pr4a/`=False；再按 73 路径清单 overlay（`tests/fixtures/pr4a/**` 由未跟踪→克隆内存在）。
- `pnpm install --frozen-lockfile --offline` → **0**（未用 junction）。

| 门禁 | 克隆内退出码 | 关键输出 |
| --- | --: | --- |
| `typecheck` | 0 | 无输出 |
| `vitest run --reporter=json` | 0 | **150 files / 2,727 tests**、failed 0、success=true（与工作树逐项一致） |
| `check:docs` | 0 | 150/2727 + 78 vs 78 + `fully green` |
| `check:encoding` | 0 | SUCCESS |
| `check:build-smoke` | 0 | 73 exports、`stale: false` |
| `check:negative-result` | 0 | A1..A6 PASS |
| `guarded-regression` | 0 | JSON 报告 |
| `check:mutation` | 0 | M1–M4 KILLED、zero-residue、PASS |
| `attest:verify` | 0 | 记录 1b7920ee 自洽（informational：不覆盖 HEAD） |
| `check-attestation-target --json` | 0 | `ok=true`（ordinary） |
| `check:clean-tree --json` | 1（预期） | `trackedChanges=28`、`untracked=45`；原因见下 |

**为什么 `check:clean-tree` 是红的**：G12 规定本轮**不提交**，28 个修改 + 45 个新增交付尚未进入索引；该门禁的判据是「检出必须干净」，因此在**交付未提交的真实状态**下必然红。它的**判别力**已在 t14 的独立副本矩阵与 `clean-tree-gate.test.ts`（15 例：clean 绿；modified/deleted/unexpected-untracked/allowance 越界/requiredInput 缺失 逐向红）中验证。提交后该项应变绿，届时需重跑（见 §7）。

---

## 7. 未决授权项 / 剩余风险（需用户或队长明确授权）

1. **提交与推送**：本报告的全部字节仍在工作树（G12）。`git commit` / `git push` 需用户显式授权；`check:clean-tree` 转绿、以及任何「HEAD 已被证明」的表述，都以该授权为前提。
2. **目标 attestation**：现有记录 `1b7920e` 只绑定它自己的提交，**不覆盖 HEAD 97e38db**（attest:verify 的两条 informational 已如实打印）。提交落定后需按 ADR 0005 D1 重跑 `pnpm run attest`，并以 evidence 提交（`Attestation-Target: first-parent` + record-only + 记录 == `HEAD^1`）单独提交；本轮**未生成、未伪造**。
3. **真实宿主/付费模型/真实记忆写入**：host-smoke 9.4-2（真实工具调用）与 9.4-3（真实记忆写）保持 `not-run`，需 `HOSTSMOKE_AUTHORIZED` 与真实后端；rc2 只记录已发生的 DSH 0.2.1-rc.3 dispatch 事实，不对外推收益。
4. **C-4 替换行**（ADR 0002:51 / `src/runtime/execution-profile.ts:121` 的「非劣」→「严格超越」）：仍**未应用**（写范围外，需 owner 授权），登记在 `p0-evidence-correction.md` §C-4 与 pinned ADR 0007 §4。
5. **t7 契约（需求文档）字节绑定**：`6d3fa74a…`/58,098 B 只绑定需求文档；实现字节以本报告附录 A 的 73 文件快照为准，两者不可互相替代。
6. **AgentTeams 本地 `**` 通配门禁缺陷**（p0-fixtures 报告）：定性为**本地任务元数据工具**，非仓库 CI，本轮不修；本报告以完整交付清单 + 字节快照交叉核对，不依赖被截断的 changedPaths。
7. **README 计数的时效性**：150/2727 是**本 attempt 最终 JSON**（`b88c3152…`）的时点值；未来任何增删测试都必须重跑 `pnpm run check:docs` 并从一次绿色 JSON 重铸，不能沿用本报告数字。

---

## 附录 A：最终交付字节快照（73 路径；本报告自身另计）

生成方式：`git status --porcelain=v1 -uall` 逐路径 `Get-FileHash -Algorithm SHA256` + 字节 + 行数；CSV：`work/t23/snapshot.csv`。状态列：`M`=已跟踪文件修改，`??`=新增未跟踪。

| # | 状态 | 路径 | 字节 | 行 | sha256 |
| --: | --- | --- | --: | --: | --- |
| 01 | M | `.github/workflows/ci.yml` | 26,432 | 544 | `a6abe4bb…` |
| 02 | M | `README.md` | 40,538 | 581 | `fc8987c0…` |
| 03 | M | `docs/adr/0005-p1-evidence-and-atomic-config-contract.md` | 65,322 | 580 | `6176f4cc…` |
| 04 | ?? | `docs/REV5-IMPLEMENTATION-CONTRACT.md` | 58,098 | 553 | `6d3fa74a…` |
| 05 | ?? | `docs/reports/host-smoke-rc2.md` | 22,907 | 223 | `d62bc9f5…` |
| 06 | ?? | `docs/reports/p0-evidence-correction.md` | 15,272 | 117 | `d84d4775…` |
| 07 | ?? | `docs/reports/p7-p3-evaluation-recheck.md` | 14,587 | 186 | `ee6dcc2f…` |
| 08 | ?? | `docs/reports/p7-p3-structural-debt-closeout.md` | 7,769 | 89 | `7bc3773b…` |
| 09 | ?? | `docs/runbooks/build-freshness-and-clean-tree.md` | 10,589 | 166 | `b826c9bf…` |
| 10 | M | `package.json` | 2,276 | 65 | `44db70bd…` |
| 11 | ?? | `scripts/build-manifest.d.mts` | 2,061 | 90 | `69061628…` |
| 12 | ?? | `scripts/build-manifest.mjs` | 18,713 | 497 | `41090aea…` |
| 13 | ?? | `scripts/build.mjs` | 2,696 | 61 | `7f2d7d14…` |
| 14 | ?? | `scripts/eval/check-clean-tree.d.mts` | 988 | 35 | `5cd802bd…` |
| 15 | ?? | `scripts/eval/check-clean-tree.mjs` | 16,280 | 430 | `3db3e0d7…` |
| 16 | M | `scripts/eval/smoke-build.d.mts` | 776 | 26 | `f534af98…` |
| 17 | M | `scripts/eval/smoke-build.mjs` | 11,359 | 256 | `121efb8b…` |
| 18 | M | `scripts/host-smoke/in-host.mjs` | 46,553 | 977 | `95836578…` |
| 19 | ?? | `scripts/host-smoke/report-path.mjs` | 5,881 | 151 | `fe292962…` |
| 20 | M | `scripts/host-smoke/run.mjs` | 22,221 | 552 | `de90864d…` |
| 21 | M | `scripts/verify-readme-counts.mjs` | 32,800 | 753 | `55c37c2c…` |
| 22 | M | `src/cordis-seams/dsh-hook-host-adapter.ts` | 84,601 | 2,054 | `ec933936…` |
| 23 | M | `src/dsh-bridge/agent-loop-executor.ts` | 59,967 | 1,439 | `b9e56296…` |
| 24 | M | `src/dsh-bridge/index.ts` | 15,437 | 388 | `3b75c68a…` |
| 25 | M | `src/dsh-bridge/metered-model-adapter.ts` | 26,000 | 678 | `99b4f4c3…` |
| 26 | M | `src/dsh-bridge/model-config.ts` | 12,021 | 291 | `95fa97bf…` |
| 27 | ?? | `src/dsh-bridge/probe-safety.ts` | 11,980 | 291 | `5defc7e8…` |
| 28 | M | `src/index.ts` | 147,958 | 3,640 | `f8014de9…` |
| 29 | M | `src/jitrl/index.ts` | 55,427 | 1,380 | `778b251a…` |
| 30 | ?? | `src/jitrl/text-probe-evaluation.ts` | 5,538 | 128 | `ee287c0a…` |
| 31 | M | `src/ledger/assembly.ts` | 17,620 | 406 | `71df4ded…` |
| 32 | M | `src/ledger/two-phase.ts` | 35,629 | 883 | `5445a51a…` |
| 33 | M | `src/memory-bridge/governance-polyfill.ts` | 23,133 | 675 | `b07f2f97…` |
| 34 | M | `src/memory-bridge/index.ts` | 867 | 25 | `4a342ec9…` |
| 35 | ?? | `src/memory-bridge/status.ts` | 17,998 | 459 | `f6927c4f…` |
| 36 | ?? | `tests/e2e/host-smoke/report-path.test.ts` | 8,128 | 189 | `c83052d5…` |
| 37 | ?? | `tests/e2e/host-smoke/surface-matrix.test.ts` | 9,738 | 220 | `8c94af63…` |
| 38 | ?? | `tests/e2e/host-smoke/surface-matrix.ts` | 20,014 | 448 | `dbfd3356…` |
| 39 | ?? | `tests/e2e/host-smoke/surface-status.test.ts` | 11,527 | 242 | `e3d64e8d…` |
| 40 | ?? | `tests/e2e/memory-write-path.test.ts` | 19,932 | 470 | `b8803cc4…` |
| 41 | ?? | `tests/fixtures/pr4a/.gitattributes` | 1,534 | 28 | `c47a8623…` |
| 42 | ?? | `tests/fixtures/pr4a/fixture-manifest.json` | 10,290 | 204 | `48263082…` |
| 43 | ?? | `tests/fixtures/pr4a/pr4a-five-arm-eval.json` | 365,314 | 13,381 | `f22bdb14…` |
| 44 | ?? | `tests/fixtures/pr4a/pr4a-ledger-Arm-0.jsonl` | 137,930 | 180 | `9c182a32…` |
| 45 | ?? | `tests/fixtures/pr4a/pr4a-ledger-Arm-1.jsonl` | 151,523 | 180 | `cb006610…` |
| 46 | ?? | `tests/fixtures/pr4a/pr4a-ledger-Arm-2.jsonl` | 152,493 | 180 | `12335caa…` |
| 47 | ?? | `tests/fixtures/pr4a/pr4a-ledger-Arm-3.jsonl` | 152,721 | 180 | `3e025775…` |
| 48 | ?? | `tests/fixtures/pr4a/pr4a-ledger-Arm-4.jsonl` | 152,721 | 180 | `301b7976…` |
| 49 | M | `tests/unit/config/readme-default-leaves.test.ts` | 27,118 | 628 | `fd688c88…` |
| 50 | ?? | `tests/unit/dream-rsi/surrogate-self-reference.test.ts` | 12,224 | 285 | `3dd54b3c…` |
| 51 | ?? | `tests/unit/dsh-bridge/probe-safety.test.ts` | 12,134 | 304 | `8288d832…` |
| 52 | M | `tests/unit/dsh-bridge/agent-loop-ledger-assembly.test.ts` | 19,250 | 454 | `06b50306…` |
| 53 | M | `tests/unit/dsh-bridge/p3c-two-phase-bridge.test.ts` | 26,577 | 628 | `4832e4b8…` |
| 54 | M | `tests/unit/eval/pr4a-cost-provenance-gate.test.ts` | 12,663 | 298 | `fdc41a35…` |
| 55 | ?? | `tests/unit/eval/p3-cacheread-gating.test.ts` | 10,564 | 262 | `714efae3…` |
| 56 | ?? | `tests/unit/eval/pr4a-v2-discriminability-recheck.test.ts` | 29,389 | 680 | `22f3f6e9…` |
| 57 | ?? | `tests/unit/eval/structural-debt-gate.test.ts` | 20,878 | 474 | `0e5b2367…` |
| 58 | ?? | `tests/unit/jitrl/text-probe-evaluation.test.ts` | 3,781 | 86 | `a9947fa8…` |
| 59 | M | `tests/unit/ledger/metered-model-adapter.test.ts` | 10,909 | 267 | `fbeff6a7…` |
| 60 | M | `tests/unit/ledger/p3a2-observe.test.ts` | 11,864 | 311 | `0a251bee…` |
| 61 | ?? | `tests/unit/memory-bridge/handle-memory-status.test.ts` | 7,805 | 185 | `b8470e1e…` |
| 62 | ?? | `tests/unit/memory-bridge/production-defaults.test.ts` | 5,253 | 127 | `592e23d8…` |
| 63 | ?? | `tests/unit/memory-bridge/recall-matching.test.ts` | 10,133 | 241 | `3b1983c5…` |
| 64 | ?? | `tests/unit/memory-bridge/status.test.ts` | 10,118 | 256 | `325fcdac…` |
| 65 | ?? | `tests/unit/meta/no-work-dependency.test.ts` | 25,014 | 519 | `097c0ef9…` |
| 66 | ?? | `tests/unit/meta/work-path-scanner.ts` | 32,376 | 792 | `6b77c2f5…` |
| 67 | ?? | `tests/unit/p62/build-freshness.test.ts` | 13,135 | 309 | `5c1f1de1…` |
| 68 | ?? | `tests/unit/p62/ci-evidence-wiring.test.ts` | 4,811 | 91 | `8464972f…` |
| 69 | ?? | `tests/unit/p62/clean-tree-gate.test.ts` | 10,616 | 244 | `f8f7760c…` |
| 70 | ?? | `tests/unit/p62/docs-correction-pointers.test.ts` | 6,022 | 121 | `1491d476…` |
| 71 | ?? | `tests/unit/p62/docs-gate-j1.test.ts` | 11,559 | 276 | `bb60034e…` |
| 72 | M | `tests/e2e/host-smoke/bundle-entry.ts` | 5,639 | 139 | `84ee2720…` |
| 73 | M | `tests/e2e/host-smoke/report-template.ts` | 9,953 | 260 | `a62bad89…` |

合计 **2,481,944 B**（73 文件）。本报告 `docs/reports/rev5-final-integration.md` 为第 74 个交付路径，是纯文档，不参与代码字节断言；本报告不含自指哈希：自身 sha256 落盘于 `work/t23/report-identity.txt` 并抄录进 t23 evidence_note（终稿后计算）。

---

## 附录 B：证据文件与可复跑入口

| 产物 | 位置 | 说明 |
| --- | --- | --- |
| 最终 Vitest JSON | `work/t23/final-vitest.json` | 2,727 tests；sha256 `773fcf43…`（975,801 B） |
| 逐文件快照 | `work/t23/snapshot.csv` | 73 行，含状态/字节/行数/sha256/mtime |
| 门禁流水 | `work/t23/gate-log.csv` | 13 条 gate 的命令/退出码/起止时刻（本 attempt 08:04–08:10 实测） |
| β 零代码变化证明 | `work/t23/beta-comment-proof.mjs` | AST 去注释打印相等 + 单行 diff |
| 干净克隆 | `work/t23-clean/` | HEAD 97e38db + 73 路径 overlay + `--frozen-lockfile --offline` |
| 克隆内 Vitest JSON（最终 74 路径集） | `work/t23-clean/work/t23/vitest-final.json` | 150 files / 2,727 tests / success=true；sha256 `7c5fa8a0…` |
