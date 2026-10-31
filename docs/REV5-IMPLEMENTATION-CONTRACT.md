# rev5 实施契约（冻结版 · t7）

- 作者：spec-lead（任务 `t7`，attempt `0331d2ef-8a71-4d50-bec7-706ea654dca4`）
- 冻结时刻：2026-10-30T04:07–04:25（Asia/Shanghai）
- 冻结对象：`HEAD = 97e38db37305b24f695a5f989428b3611f84987c`，工作树干净（`git status --porcelain=v1` 0 行，04:07:37 取样）
- 用途：供 `t8`–`t23` 直接采用的**范围与验收口径**。实现仍由各任务负责人完成；本文件不含实现代码改动。
- 一句话：**本文件把队长任务书里的 rev5 条目变成「不重叠、可复现、默认安全」的契约；它同时记录我实测到的五处契约缺陷（见 §7 勘误表）与十处需要队长裁定的冲突（见 §6）。**
- 修订（2026-10-30T04:28）：§6 的 C-1…C-10 **已由队长全部裁定**（`scripts/host-smoke/**`、`src/index.ts` 归 t10；t9 获 readme fixture 只补字段权限；E-1/E-2 已改）。裁决见 **§11「裁定落地记录」**；§6 保留裁定前的证据与默认建议，冲突时**以 §11 为准**。

---

## 0. 本文件是什么 / 不是什么

**是**：范围边界、文件所有权、验收判据、可复现命令、负控制要求、默认安全与授权边界、依赖顺序、证据格式。

**不是**：

1. 不是进度报告。文中每个数字都来自我在本机 04:09–04:25 的实测（命令+退出码+时刻），不沿用任何旧报告数字。旧报告（`docs/reports/p2-p6-integration-round.md` 等）只作为**历史定位**引用，且必须带其原有时间语境。
2. 不是 rev5 原文。**rev5 的散文正文不在本仓库**：在 `HEAD=97e38db` 上 `grep -r "rev5"` 命中 0 个文件；本文件的条目编号与范围是从队长任务书 `t8`–`t23` 的 subject/objective/inScope/acceptance/verify 字段重建的（见 §4 映射表）。若队长手中的 rev5 原文与重建结果有出入，**以队长下发的差异为准**，并请广播一条勘误，不要各自解释。
3. 不是批准。`t7` 是 requirements 任务：它冻结口径，不代替 `t13`–`t22` 的验证/审核，也不代替 `t23` 的最终集成判定。

---

## 1. 冻结基线（本机实测，2026-10-30 04:09–04:25）

### 1.1 环境

| 项 | 值 |
| --- | --- |
| OS / shell | Windows（`win32/x64`），pwsh |
| Node | `v22.23.1` |
| pnpm | `11.7.0`（`packageManager: pnpm@11.7.0`） |
| 仓库根 | `C:\Users\Administrator\Documents\Codex\2026-10-19\https-github-com-google-research-harness2` |
| HEAD | `97e38db37305b24f695a5f989428b3611f84987c`（`docs(p2-p6): backfill J-1 gate gap disclosure`，普通提交，无 `Attestation-Target` trailer） |
| 工作树 | 干净（0 行） |
| `feb8465..HEAD` | 2 个提交 |

### 1.2 八门 + attestation（当前树，全部实测）

| 门 | 命令 | 退出码 | 关键输出（逐字） | 时刻 |
| --- | --- | --: | --- | --- |
| typecheck | `pnpm run typecheck` | 0 | 无输出 | 04:09:35 |
| 全量测试 | `pnpm exec vitest run` | 0 | `Test Files 130 passed (130)` / `Tests 2493 passed (2493)` | 04:10:55 |
| 文档门 | `pnpm run check:docs` | 0 | `Parsed == Actual == 130/2493`（Unit 116/2325、E2E 14/168）；`SUCCESS: documentation gate fully green.`；`78 vs 78` | 04:12:17 |
| 编码门 | `pnpm run check:encoding` | 0 | `SUCCESS: every tracked blob is LF text or an explicit -text exception` | 04:12:20 |
| 构建烟测 | `pnpm run check:build-smoke` | 0 | `export-surface: 72 named exports`；`artifact: lib/index.js (1185632 bytes)` | 04:12:23 |
| 负结果门 | `pnpm run check:negative-result` | 0 | `A1..A6 PASS - the historical negative result is intact` | 04:12:25 |
| 守护回归 | `pnpm run guarded-regression` | 0 | `"passed": 37`、`"failed": 0` | 04:12:27 |
| 变异门 | `pnpm run check:mutation` | 0 | `[M1] 4/4`、`[M2] 5/3`、`[M3] 3/2`、`[M4] 2/2`、`worktree zero-residue: OK`、`verdict: PASS` | 04:12:57 |
| 证明校验 | `pnpm run attest:verify` | 0 | 记录 `commit 1b7920e…` 与对象库一致；`informational: HEAD is 97e38db…`（**记录不覆盖当前 HEAD**） | 04:20 |
| 证明目标门 | `node scripts/eval/check-attestation-target.mjs --json` | 0 | 普通提交 → 记录为祖先（T0 PASS） | 04:20 |

> 这些是**带时点的断言**，不承诺此后恒绿；任何任务改动了 `src/`、`tests/`、`README.md`、`scripts/` 之后必须重跑自己相关的门并重新取样。

### 1.3 干净克隆基线（P0-1 的真实起点，非旧报告数字）

方法（可复跑；`work/` 被 gitignore，只作落地目录）：

```powershell
git clone --quiet --local --no-hardlinks . work/t7-clean
Push-Location work/t7-clean; pnpm install --frozen-lockfile --offline; Pop-Location
Push-Location work/t7-clean; pnpm exec vitest run --reporter=json --outputFile=clone-report.json; Pop-Location
```

实测（04:15–04:17）：

| 项 | 结果 |
| --- | --- |
| 安装 | `pnpm install --frozen-lockfile --offline` exit 0（1.6s；本地 store 可用） |
| 全量 | `Test Files 130`、`Tests 2493`、`failed=5`、`success=false` |
| 失败文件 | **仅 1 个**：`tests/unit/eval/pr4a-cost-provenance-gate.test.ts` |
| 失败原因 | 5 个用例全部 `ENOENT: copyfile …\work\pr4a-five-arm-eval.json`（该文件在 `work/` 下，被 `.gitignore` 忽略） |
| `work/`、`lib/` | 克隆中不存在（符合预期） |

**方法学警告（必须遵守）**：不要用“node_modules junction 回主仓”的方式模拟干净克隆。我实测该方式会额外制造 2 个假失败（`tests/unit/p62/evidence-gates.test.ts` 的 `pnpm run build` 被 pnpm 的 deps-status 检查挡住，报 `Command failed … pnpm install`），把真实失败集从 5 放大成 7。干净克隆必须 `pnpm install --frozen-lockfile`（可 `--offline`）。

### 1.4 J-1 门禁缺口：在当前 HEAD 复现（新证据）

方法：用当前全量 vitest JSON 报告为基底（计数 130/2493，与 README 精确一致），逐一注入后跑 `node scripts/verify-readme-counts.mjs --report <file>`。注入文件在 `work/t7-j1/`（gitignored），生成脚本 `work/t7-j1/mutate.cjs`。

| 注入 | 退出码 | 门禁输出 |
| --- | --: | --- |
| `success=false` + `unhandledErrors` 非空 | **0** | `SUCCESS: All README.md test counts match Vitest results exactly!` + `SUCCESS: documentation gate fully green.` |
| 仅 `unhandledErrors` 非空 | **0** | 同上（fully green） |
| 仅 `success=false` | **0** | 同上（fully green） |
| `numFailedTestSuites=1` | **0** | 同上（fully green） |
| `numTodoTests=1`（断言状态无 todo） | **0** | 同上（fully green） |
| `numTotalTests+1`（计数不匹配） | **1** | `Summary passing tests mismatch…` |
| `numFailedTests=1` | **1** | `FAIL: the consumed report carries 1 failed test(s)…` |

结论：`scripts/verify-readme-counts.mjs:404–430` 的 fail-closed 判据只覆盖 `numFailedTests` / `numPendingTests`（及断言级 status），**不看** `success` / `numFailedTestSuites` / `unhandledErrors` / `numTodoTests`。J-1 是真实的、当前可复现的门禁缺口；修复它属于 `t9`，本轮 `GO` 不得覆盖它。

### 1.5 宿主可用性与授权边界事实

| 项 | 实测/读取 |
| --- | --- |
| 已安装宿主 | `C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe` 存在；`resources/app.asar` 182,434,783 B |
| 宿主 smoke 就绪 | `node scripts/host-smoke/run.mjs --check` → `[host-smoke] readiness ok=true`，exit 0（04:19） |
| 真实宿主 rc1 报告 | `docs/reports/p61-host-smoke-rc.md`，git blob `932f80dae2995786534288827becb8dc2bbe6c3a`（**本轮不得覆盖**） |
| 默认执行模式 | `execution.mode = 'shadow'`、`applyWinningPatch=false`（`src/config.ts:459-461`） |
| 记忆权限 | `resolveExecutionProfile`：`permissions.memory.allowed === false`，唯一放行是 **显式** `memoryRealWrites: true`（测试装配；任何 config 字段都产生不了），`publish.allowed === false` 恒真（`src/runtime/execution-profile.ts:96-128`） |
| 真实记忆写开关 | `memoryBridge.promoteOnComposeSuccess = false`（`src/config.ts:390-393`）；生产入口从不设置 `memoryRealWrites` |
| 宿主工具面 | 默认不下发：`src/index.ts` 不传 `toolFace` / `toolAllowlist`（`src/cordis-seams/tool-face.ts` 已存在，但仅测试装配接线） |
| `jitrl` | `enabled=true`（只读/影子语义）、`hostAdvisor.enabled=false`、`store.mirrorToMemoryBridge=false`、`surfaceActions=false` |

---

## 2. 全局不变量（G1–G12，所有实现/验证/审核任务都必须满足）

| # | 不变量 | 判据（可核查） |
| --- | --- | --- |
| G1 | **默认安全不被弱化** | `DEFAULT_EVO_HARNESS_CONFIG` 的 `execution.mode`、`applyWinningPatch`、`memoryBridge.promoteOnComposeSuccess`、`dreamRsi.holdoutTreeCount`、`jitrl.store.mirrorToMemoryBridge`、`jitrl.hostAdvisor.enabled` 保持现值；任何 `allowed===true` 的默认放行即为失败 |
| G2 | **授权边界** | 不执行付费模型、真实外部工具、真实记忆写入、真实网络；宿主 smoke 只允许 shadow/只读、且不触发模型调用；`9.4-2`/`9.4-3` 保持 `not-run`；`memoryRealWrites` 只能出现在 `tests/**` 的装配里，`src/**` 的生产路径不得设置它 |
| G3 | **证据纪律** | 任何被引用的数字必须附「命令 + 退出码 + 关键输出行 + 取样时刻」；旧报告数字只能以「历史（某时刻）」引用；`not-run`/`unknown`/`not-evaluable` 不得写成 pass |
| G4 | **负控制按 runbook** | 改门禁/守卫/变异的任务，必须按 `docs/NEGATIVE-CONTROL-RUNBOOK.md` 规则 2/3/3.5/4/4b 落盘：副本、`bak`/`red.log`/`anchor`/`snippet`、身份键（relpath+snippet hash）、先红后写日志、还原后同刻哈希 |
| G5 | **测试输入自包含** | `tests/**` 不得读取 gitignore 路径（尤其仓库根 `work/`）作为**输入**；缺输入必须显式失败，不得 `skip`/`todo`/`if (!exists) return`。允许在 `work/` 下**写**临时目录（如 `tests/unit/persistence/fixtures.ts`），但不得依赖预置内容 |
| G6 | **计数漂移由集成方收口** | 任何增删测试都会改变 README 计数；**实现任务不得手改 README 计数行**（并发会互相覆盖）；最终由 `t23` 用实测值一次性更新 |
| G7 | **冻结家族不改** | 本轮仍冻结 `docs/reports/pr4a-*.md`、`docs/reports/p61-*.md`、`docs/reports/p62-*.md`、`docs/reports/final-attestation.json`；`git diff --stat -- <这些路径>` 必须为空（除非队长单独授权） |
| G8 | **pinned 字节不改** | `docs/adr/0007-p6-pareto-budget-terminology-and-hooks.md`（sha256 `47e67c7dab9ddacaf1d505a7fea6fe9312ee9b38d52ea1097444e37ab089b289`）与 `src/jitrl/jit-active-policy.ts`（sha256 `c94431235a0a90bc256bbfdac043a6c675a85fe566d2e4d91c1047fa13ff4266`）被 `tests/unit/jitrl/p6-pareto-budget.test.ts:866-880` 钉死。**不要改这两个文件**；需要记录指针时写新文件 |
| G9 | **公开选项面 26 键不改** | `tests/unit/config/plugin-options-shape.test.ts:158-166` 钉死 26 个 `OPTION_KEYS`（ADR 0005 §3.1）。**本轮不新增插件 option key**；需要新能力时走现有 config 叶/`deps`/handle/status 的增量字段，或先请队长裁定 |
| G10 | **不伪造证明** | `final-attestation.json` 描述 `1b7920e…`；本轮工作树未提交，**不能被说成“当前 HEAD 已证明”**。不得为脏工作树生成/改写记录来“补一份证明” |
| G11 | **Windows/EOL** | 新文件必须 LF（`check:encoding` 只查 HEAD blob；提交前用编辑器保证 LF）；不要在源码里写 CRLF 字节 |
| G12 | **不 commit / 不 push** | 除非队长显式授权；本契约按“整轮不 commit”的既有纪律写 |

---

## 3. 文件所有权矩阵（防重叠；冲突一律以本表为准）

| 路径 | 唯一写者 | 只读/引用者 | 备注 |
| --- | --- | --- | --- |
| `tests/fixtures/pr4a/**`、`tests/unit/eval/pr4a-cost-provenance-gate.test.ts`、`tests/unit/**/*work*`（元测试） | **t8** | t13/t18 | t8 只许改 §5.1 列出的文件（实际路径见 §7 E-1；别按错误路径新建） |
| `tests/unit/p62/pr4a-artifact-verifier.test.ts`、`tests/unit/config/readme-default-leaves.test.ts` | **无人**（保持字节不变） | t8/t9/t12 | 它们已自包含；`t8` 的 inScope 里写成别的目录是笔误 |
| `scripts/verify-readme-counts.mjs`、`scripts/eval/final-attestation.mjs`、`scripts/eval/check-attestation-target.mjs`、`scripts/eval/smoke-build.mjs`、`scripts/build*`、`.github/workflows/**`、`package.json`、`src/dsh-bridge/model-config.ts` | **t9** | t14/t19/t23 | 门禁语义/CI/构建证据归 t9 |
| `scripts/eval/**` 其余文件（含 `mutation-gate.mjs`、`pr4a-*`、`negative-result-diag.mjs`、`jitrl-eval-lib.ts`） | **t12**（在 t9 交付后；不得改 t9 的四个门禁脚本） | t10 | t12 若需修 mutation 锚点，只能在 t10 完成后 |
| `src/dsh-bridge/**`、`src/jitrl/**`、`src/cordis-seams/dsh-hook-host-adapter.ts`、`src/cordis-seams/tool-face.ts`、`src/runtime/**`、`tests/unit/dsh-bridge/**`、`tests/unit/jitrl/**`、`docs/reports/host-smoke-rc2.md`、`docs/adr/0005-…` | **t10** | t15/t20 | `src/orchestrator.ts` 不在 t10 范围；`src/cordis-seams/eight-surfaces.ts` 也不在（M1 锚点安全） |
| `src/memory-bridge/**`、`tests/unit/memory-bridge/**`、`tests/e2e/**/*memory*` | **t11** | t16/t21 | t10 不得改 `*memory*` e2e 文件；t11 不得改 `tests/e2e/fixtures.ts`（共享，见下） |
| `src/dream-rsi/surrogate-scorer.ts`、`src/harness2/**`、`tests/unit/dream-rsi/**`、`tests/unit/eval/**`（除 t8 的三个文件）、`tests/e2e/**/*ablation*`、`docs/reports/p3-*`、`docs/reports/p7-*` | **t12** | t17/t22 | `scripts/eval/**` 归 t12（见上） |
| `tests/e2e/fixtures.ts`、`tests/e2e/lifecycle.test.ts`、`tests/e2e/fix-wave-composition.test.ts` | **共享（最后写者负责回归）** | t10/t11/t12 | 谁改谁必须在报告里列出并重跑全量 e2e；不得为过测而放宽断言 |
| `src/index.ts`（handle/status 的**增量**字段） | **t10**（P1-2 表面状态；见 C-7） | t11/t23 | 该文件当前不属于任何任务；见 C-7 的裁定项。禁止改既有字段语义/默认 |
| `src/index.ts` 的**记忆桥接状态**聚合 | **t23**（在 t11 交付模块函数后接线；见 C-7） | t11/t16 | t11 只交付 `src/memory-bridge/` 内的状态函数与测试 |
| `scripts/eval/check-clean-tree.mjs` + 其测试 + t9 新建的 J-1/stale 负控制测试 | **t9** | t12/t23 | t12 的 `scripts/eval/**` 所有权**不含** t9 新建的这些文件 |
| `tests/unit/p62/docs-gate-j1.test.ts`、`tests/unit/p62/clean-tree-gate.test.ts`、`tests/unit/p62/build-freshness.test.ts`（建议命名，均在 t9 的 `tests/unit/p62/**`、`*build*` 范围内） | **t9** | t14/t23 | 不要把 J-1 测试放进无人拥有的 `tests/unit/config/**` |
| `README.md` 的**计数行/摘要行**（4 行 + 1 行） | **t23 独占** | 全员只读 | 见 G6；实现任务不得改 |
| `README.md` 其它行（配置参考表） | **t9**（仅在其改动默认叶时） | t23 | 必须跑 `node scripts/verify-readme-counts.mjs --docs-only` |
| `docs/NEGATIVE-CONTROL-RUNBOOK.md` | **无人**（保持路径与字节） | 全员 | t9 可在 `docs/runbooks/**` 新增文件，但**不得移动/删除**本文件（旧报告引用它） |
| `docs/reports/final-attestation.json`、`pr4a-*`/`p61-*`/`p62-*` | **无人**（冻结） | t9/t23 | G7 |

---

## 4. rev5 条目 ↔ 任务 ↔ 依赖（重建映射）

> 编号来自队长任务书；`P1-4` 的任务书描述把它放在 `t9`（证据/构建/CI/文档），`P4-*` 指记忆桥接（与 ADR 的 `D-P4-*` 无关，勿混）。

| rev5 条目 | 任务 | 负责人 | 依赖 | 一句话范围 |
| --- | --- | --- | --- | --- |
| P0-1 P0-2 | t8 | p0-fixtures | t7 | PR-4A 夹具冻结 + `work/` 依赖消除 + 元测试 |
| P0-3 P0-4 P0-5 P0-6 J-1 P1-4 | t9 | p0-evidence | t7 | 报告负控制、证明目标/干净树、构建新鲜度、文档更正 |
| P1-1 P1-2 P1-3 P2-1 P2-2 P2-3 P2-4 | t10 | host-execution | t7,t8,t9 | 宿主八表面证据、状态可观测、JitRL 复诊、两档探针安全模型 |
| P4-1 P4-2 P4-3 | t11 | memory-bridge | t7,t8,t9 | writable 三态、正向召回、测试装配写入 e2e |
| P3-1 P3-2 P3-3 P3-4 | t12 | evaluation | t7,t8,t9,t10 | 2×2(+1) 判别力、surrogate 自指、缓存数据门控、结构债 |
| 验证 P0-1/2 | t13 | spec-lead | t8 | 干净克隆复跑夹具工作流 |
| 验证 P0-3..6 | t14 | spec-lead | t9 | 四组报告负控制 + 证明/构建/文档 |
| 验证 P1/P2 | t15 | spec-lead | t10 | 宿主/JitRL/探针 |
| 验证 P4 | t16 | spec-lead | t11 | 记忆桥接 |
| 验证 P3 | t17 | spec-lead | t12 | 评测/结构债 |
| 交叉审核 P0..P3 | t18–t22 | cross-reviewer | 对应验证 | 只审不改 |
| 集成/干净副本/交付 | t23 | integrator | t18–t22 | 全量门禁 + 未授权项 |

**依赖图的硬边**：`t8,t9` 可并行（都只依赖 t7）；`t10,t11` 在 `t8,t9` 之后（等待共享文件稳定，不等待内容完成）；`t12` 在 `t10` 之后（结构债要改 `src/dsh-bridge`、`src/jitrl` 的字节，且 mutation 锚点可能被 t10 移动）；验证/审核/集成按上表。

---

## 5. 分阶段契约

> 下列每个条目的“验收”（A-x）都是**可执行的**：命令、退出码或可观察输出。判定为 pass 时必须附证据；任何一条不满足即不得报 pass。

### 5.1 P0-1 / P0-2：测试夹具与 `work` 依赖（t8）

**Objective**：干净检出可复现；测试输入自包含、已跟踪、有 sha256；缺文件显式失败。

**In scope（修正后）**：
- `tests/fixtures/pr4a/**`（新建；含 `fixture-manifest.json` 与 6 个数据文件）
- `tests/unit/eval/pr4a-cost-provenance-gate.test.ts`（只改输入来源与缺失行为）
- `tests/unit/meta/no-work-dependency.test.ts`（新建；名称含 `work`，匹配 `tests/unit/**/*work*`，避开 `tests/unit/eval/**` 归属冲突）
- `tests/unit/persistence/fixtures.ts`（任务书已给范围：允许把临时目录从仓库 `work/` 迁到 `os.tmpdir()`；若迁移，必须重跑 `tests/unit/persistence/**` 并说明动机）
- 可在 `tests/fixtures/**` 下新增必要目录

**Out of scope**：`src/**`、`docs/reports/pr4a-*`（冻结）、`tests/unit/p62/**`、`tests/unit/config/**`、`scripts/**`、README。

**交付物**：
1. `tests/fixtures/pr4a/`：`pr4a-five-arm-eval.json`、`pr4a-ledger-Arm-0..4.jsonl`（5 个）、`fixture-manifest.json`（每文件：相对路径、bytes、sha256、来源=原 `work/` 同名文件、冻结时刻）。文本必须 LF；总量写入报告。
2. 测试改为从 `tests/fixtures/pr4a/` 读，按 manifest 逐文件校验 sha256；缺失/哈希不符时**抛错**（不是 skip）。
3. 元测试：扫描 `tests/**`（可扩展到 `scripts/**`，但必须分类），禁止把仓库根 `work/` 作为**输入**；允许 `work/` 作为**输出/临时**目录并给出理由清单；允许注释/字符串里出现 `work/`。

**验收**：
- A-t8-1 冻结夹具的完整性与来源：manifest 中每个 sha256 与原始 `work/` 文件一致（冻结时刻命令记录在报告）；数据文件均通过 `git check-attr`/LF 检查。
- A-t8-2 最小性（可判定的形式）：对夹具集逐个文件做删除实验。**删除后 5 个用例仍全绿的文件**，必须在 manifest 里标为 `optional` 并写出它服务的是 verifier 的哪条断言（即：不是这 5 个用例的输入）；否则从夹具集移除。**不得**用“多拷一份以防万一”代替最小性证明。
- A-t8-3 干净克隆转绿：`git clone --local` + `pnpm install --frozen-lockfile --offline` 后，`tests/unit/eval/pr4a-cost-provenance-gate.test.ts` 5/5 通过，且全量 vitest `failed=0`（允许总数变化，报告实测值）。
- A-t8-4 元测试有判别力：向临时副本的某个测试加入 `join(REPO_ROOT,'work',...)` 读取 → 元测试红（退出码 1、点名文件与行）；从副本还原 → 绿。
- A-t8-5 无静默跳过：用 grep 工具（`grep`/`rg`/`Select-String` 任一等价工具）扫 `it\.skip|describe\.skip|test\.skip|\.todo\(`，`tests/unit/eval/pr4a-cost-provenance-gate.test.ts` 0 命中；缺失夹具时退出码非 0。
- A-t8-6（仅当改了 `tests/unit/persistence/fixtures.ts`）临时目录不得再依赖“仓库根 work/ 预置内容”；`pnpm exec vitest run tests/unit/persistence` 全绿；干净克隆里运行后仅允许出现被 ignore 的临时目录，且测试不因目录缺失而失败。

**Verify（修正后的命令，逐字）**：

```powershell
pnpm exec vitest run tests/unit/eval/pr4a-cost-provenance-gate.test.ts tests/unit/p62/pr4a-artifact-verifier.test.ts tests/unit/config/readme-default-leaves.test.ts
pnpm exec vitest run tests/unit/meta/no-work-dependency.test.ts
pnpm run typecheck
# 干净克隆（见 §1.3 方法）
```

**陷阱**：
- 原任务书 verify 里的 `tests/unit/eval/pr4a-artifact-verifier.test.ts` 与 `tests/unit/eval/readme-default-leaves.test.ts` **不存在**；实际路径是 `tests/unit/p62/pr4a-artifact-verifier.test.ts` 与 `tests/unit/config/readme-default-leaves.test.ts`。**不要按错误路径新建重复文件**（会破坏计数与归属）。
- `tests/unit/persistence/fixtures.ts` 会在仓库根创建 `work/persistence-tmp` 作临时目录；这是**写**不是读输入，允许保留；但元测试必须把它归入“写/临时”白名单并写理由。
- 不要改 `scripts/eval/verify-pr4a-artifacts.mjs`（它读 `work/pr4a-ledger-*` 是它自己的产物契约；其单测在临时 root 运行，不在此任务范围）。

### 5.2 P0-3/4/5/6 + J-1 + P1-4：证据、构建、CI、文档（t9）

**Objective**：报告门禁 fail-closed；证明目标/干净树可核查；构建新鲜度可判别；文档更正可追溯。

**In scope（按矩阵）**：`scripts/verify-readme-counts.mjs`、`scripts/eval/final-attestation.mjs`、`scripts/eval/check-attestation-target.mjs`、`scripts/eval/smoke-build.mjs`、`scripts/build*`（新建允许）、`.github/workflows/ci.yml`、`package.json`、`src/dsh-bridge/model-config.ts`、`docs/reports/*correction*`（新建）、`docs/runbooks/**`（新建）、`README.md` 的**配置参考表**（不改计数行；见 G6）。

**Out of scope**：`docs/adr/0007-…`（pinned，G8）、`pr4a-*`/`p61-*`/`p62-*`/`final-attestation.json`（冻结）、`src/**` 其它文件、`tests/fixtures/pr4a/**`。

**交付物与验收**：

**(a) J-1（P0-3）**
- A-t9-1 四个注入各自 exit 1：`success=false`（计数匹配）、`numFailedTestSuites>0`、`unhandledErrors` 非空、`numTodoTests>0`；每条都必须在 stderr/诊断里点名原因。
- A-t9-2 正常报告 exit 0，输出仍为 `documentation gate fully green.`。
- A-t9-3 计数不匹配仍 exit 1（回归）。
- A-t9-4 负控制自动化且**不腐化**：四组反例作为提交的测试（`node:test` 或 vitest）在临时目录生成报告；报告的计数必须以运行时的真实 vitest 报告/README 现值为准，不得硬编码 `130/2493`（后续任务会增删测试）。
- A-t9-5 现存 `tests/unit/config/readme-default-leaves.test.ts` 与 `tests/unit/p62/*` 全绿；不得通过放宽既有断言来通过。**兼容性冲突见 C-10**：该测试的 5 个合成报告 fixture 只有 `numTotalTests/numFailedTests/numPendingTests`，没有 `success`/`numFailedTestSuites`/`unhandledErrors`/`numTodoTests`。若 J-1 修复对“字段缺失”也 fail-closed，则必须给这些 fixture 补齐字段（只加字段，不改断言）——这需要 C-10 的授权；未获授权时，"字段缺失"只能记为诊断而不能作为 pass 依据。

**(b) P0-4 证明目标 + 干净树/测试输入**
- A-t9-6 CI 的 fingerprint 生成继续使用 `--expect-commit "${{ github.sha }}"`（现 `ci.yml:211`、`:289-304` 已具备），`attestation-target` job 继续跑 `check-attestation-target.mjs --json`。
- A-t9-7 新增“干净树/测试输入”检查（脚本名不限，建议 `scripts/eval/check-clean-tree.mjs`）：在 CI 的测试步骤**之前**执行；任何 modified/deleted tracked 文件或意外 untracked 文件 → exit 1；已知生成物（如 `test-results.json`、`lib/`、`attestation.json`）只能通过**显式 allow 列表**豁免，且豁免项不得覆盖 `src/`、`tests/`、`scripts/`、`package.json`。
- A-t9-8 该检查的负控制：临时 git 仓中改一个 tracked 文件 → 1；新增一个意外 untracked 文件 → 1；干净 → 0；允许项 → 0。
- A-t9-9 该检查**不加入** `pnpm run verify`（本轮工作树整轮未提交，加入会把本地验收变成恒红）；它只在 CI/显式命令中运行。报告里写明这条边界。
- A-t9-10 证明自指边界写清：记录仍描述 `1b7920e…`；本轮工作树未提交，因此**不得**声明“HEAD/本轮改动已被证明”。不重新生成 `final-attestation.json`。

**(c) P0-5 构建新鲜度**
- A-t9-11 `pnpm run build` 产出含 `srcTreeSha256` 与 `commit`（`HEAD`）的构建戳（文件名/嵌入位置不限，但必须可机读）。`srcTreeSha256` 的定义必须冻结并写进报告：`src/**/*.ts` 按 POSIX 路径序、对原始字节（LF）做 `sha256(path + "\0" + sha256(bytes) + "\n")` 的复合哈希；`commit` 取 `git rev-parse HEAD`。
- A-t9-12 `pnpm run check:build-smoke`（或新增 `status` 子命令）输出 `stale: true|false`：`src` 改动后未重建 → `true`；重建后 → `false`；`lib/index.js` 缺失 → `stale: true` + `artifact: absent`（不得当 0/未知混过去）。
- A-t9-13 负控制：在临时副本里改一个 `src` 文件 → stale true；重建 → false；**不得**通过修改时间戳（mtime）判定（内容摘要为准）。
- A-t9-14 `package.json` 增加 `prepare`（**建议** `"prepare": "pnpm run build"`）；判据：`pnpm run prepare` exit 0 且产出 `lib/index.js`；并在干净克隆中记录 `pnpm install --frozen-lockfile` 是否触发 prepare（**记录事实**；若 pnpm 不触发，就写“前提是显式 `pnpm run prepare`”，不得伪造触发）。
- A-t9-15 现有 72 个导出、`1,185,632 B` 基线与 `REQUIRED_EXPORTS` 断言不退化（除非任务自身新增导出，需在报告中逐条列出并说明来源）。

**(d) P0-6 / P1-4 文档更正**
- A-t9-16 在 `docs/reports/*correction*`（新文件）中逐条记录：原文位置（文件:行/章节）、原断言、当前实测（命令+退出码+时刻）、结论。至少覆盖：`p3-a-assembly` 19/17、`p3-b-adapter` 9+21+4=32、`p2-p6-final-verification` 2428/2429、H-3/ADR 0007 §4 登记的 non-inferiority 文案漂移。
- A-t9-17 不修改 pinned 的 ADR 0007（G8）；`tests/unit/jitrl/p6-pareto-budget.test.ts -t "pinned sha256"` 必须 PASS。
- A-t9-18 `node scripts/verify-readme-counts.mjs --docs-only` exit 0（配置参考 78 vs 78 或随任务变更后的真实值）；`pnpm run check:encoding` exit 0。
- A-t9-19 README 计数行的处理：**不改**（G6）；若文档门因计数漂移而红，只能在报告中登记“待 t23 收口”，不得改数字。

**Verify（逐字）**：

```powershell
pnpm run typecheck
node scripts/verify-readme-counts.mjs --docs-only
pnpm exec vitest run tests/unit/p62 tests/unit/config
node --test scripts/eval/final-attestation.node-test.mjs
pnpm run check:build-smoke
pnpm run check:encoding
node scripts/eval/check-attestation-target.mjs --json
# 新增负控制套件（J-1 四组、干净树四组、stale 两组）——由 t9 交付并纳入 CI/文档
```

> `pnpm run check:docs`（全量）在 t9 单独执行时可能因**并发任务新增测试**而红；这是 G6 的已知情形，不作为 t9 的失败判据。全量 `check:docs` 的关账点在 t23。

### 5.3 P1-1 / P1-2 / P1-3 + P2-1…P2-4：宿主与执行模型（t10）

**Objective**：真实宿主八表面证据；表面可观测；JitRL 负结果复诊；两档探针安全模型可判别。

**In scope**：`src/dsh-bridge/**`、`src/jitrl/**`、`src/cordis-seams/dsh-hook-host-adapter.ts`、`src/cordis-seams/tool-face.ts`、`src/runtime/**`、`src/index.ts`（**仅** handle/status 的增量字段，按 C-7 默认裁定）、`tests/unit/dsh-bridge/**`、`tests/unit/jitrl/**`、`tests/e2e/**`（不含 `*memory*`、`*ablation*`）、`docs/reports/host-smoke-rc2.md`（新建）、`docs/adr/0005-…`（公开键同步；若需编辑，只能改与 26 键一致的内容，并同步测试）。

**Out of scope**：`docs/reports/p61-host-smoke-rc.md`（冻结）、`src/orchestrator.ts`、`src/cordis-seams/eight-surfaces.ts`、`scripts/**`、`src/memory-bridge/**`、`src/dream-rsi/**`、README 计数行。

**交付物与验收**：

**(a) P1-1 宿主 smoke rc2**
- A-t10-1 `node scripts/host-smoke/run.mjs --check` 通过后，产出 `docs/reports/host-smoke-rc2.md`；**不得覆盖** `p61-host-smoke-rc.md`（报告里给出后者的 `git hash-object` 前后一致证据，当前 blob `932f80da…`）。
- A-t10-2 rc2 必须带：宿主版本/Electron/Node、commit、工作树状态、采集时刻、固定命令列、分层结论（passed/failed/not-run 计数）、HostCapabilityManifest 证据面。
- A-t10-3 **八表面逐面分类**：对 `HARNESS_COMPONENT_KEYS`（`system_prompt,guardrails,memory,tool_guidance,skills,scripts,subagents,plugins`）的每一面给出 `native` / `fallback` / `unavailable` 之一，并给出产生该判定的探针证据（manifest 字段或 seam 探针输出）。配置存在 ≠ mountable；未观测到 = `unavailable`/`not-run`，不得写成 native。
- A-t10-4 `9.4-2`（真实模型调用 + 真实记忆写）与 `9.4-3`（真实会话收益比较）保持 `not-run` 且带授权缺失理由；不得设置环境变量绕过。
- A-t10-5 运行器支持新报告路径（如 `--out`/env），且超时/卸载不变量检查仍执行（`退出码/超时/存活子进程/manifest 校验/报告行校验`）。**范围限制（C-9）**：若队长未把 `scripts/host-smoke/**` 授权给 t10，则改用 `--no-write` 捕获输出并落盘为 rc2，并在报告中写明“runner 仍无 `--out`，由 t23 收口”；不得为了 `--out` 擅自改 `scripts/`。

**(b) P1-2 表面可观测性**
- A-t10-6 插件 handle/status 增量字段（不新增 option key，G9；`src/index.ts` 的写权限见 C-7）对每面给出：`enabled`（config 是否包含该面）、`mountable`（宿主适配器是否暴露 seam）、`lastMountResult`（结构化 `{ok, code?}`，`code` 含 `seam_unavailable` 等）、以及 `seam_unavailable` 的**结构化计数**。
- A-t10-7 语义可判别：`enabled=true` 但 `mountable=false` → `lastMountResult.ok=false` 且计数 +1；禁用面不计入 unavailable；未测量字段用 `unknown`/缺省，不用 `0` 冒充实测（沿用 F-15 的 collect-or-omit 规则）。
- A-t10-8 `cacheRead` 无实测时必须是 `unknown`（沿用 `src/ledger/usage-report.ts` 的 `cacheReadUnknownCalls`/`dimensionProvenance.cacheRead='unknown'`），不得报表为 measured 0；`tests/unit/ledger/p3c-usage-report.test.ts` 保持绿。

**(c) P1-3 / P2-1 JitRL 负结果复诊**
- A-t10-9 `pnpm run check:negative-result` exit 0（`A1..A6 PASS`），历史 `-0.250` 帧不变；不得改 `docs/reports/p6-fair-eval.md`、`p2-p6-*` 等历史数字。
- A-t10-10 报告定位**首个**“偏离 prior 且变差”的决策与最小反例（任务/run/round 坐标 + 可重放锚点），与 `negative-result-diag.mjs` 的既有输出一致；不得只给均值差。
- A-t10-11 证据写回门控有 `online`/`frozen` 对照（两臂同坐标、同预算），并说明写入/不写入的判定；不得把门控写成“已启用默认写回”。

**(d) P2-2 文本探针**
- A-t10-12 `text-probe` 工具提案在无法判别时输出 `not-evaluable`（稳定字符串）与理由；不得抛异常代替，也不得静默 pass。

**(e) P2-3 / P2-4 tool-probe 两档安全模型**
- A-t10-13 只读 allowlist：`createToolFaceRegistry` 在生产入口可按分支装配（默认**不装配**，`src/index.ts` 默认不传）；拒绝 `"*"` 通配；`no-allowlisted` 计数与 deny 诊断可读。
- A-t10-14 授权账本：`createProbeAuthorizationLedger` 接到真实调用点（t10 的 inScope 覆盖 `src/dsh-bridge/**`）；`allowlisted` / `denied` / `no-policy` 三态计数；**分支内探针调用**的 `no-policy` 必须为 0（宿主级调用可以有 noPolicy，但必须与分支调用分开计数）。
- A-t10-15 “ADR 公开键同步”的可核查形式：`pnpm exec vitest run tests/unit/config/plugin-options-shape.test.ts` 必须绿（26 键不增不减，G9）；若确实新增了**诊断字段**（不是 option key），只需在 `docs/adr/0005-…` 增补一节并在测试中断言字段形状；**不得**为了让新字段进来而改 26 键清单或放宽该测试。
- A-t10-16 无真实工具调用：e2e 使用记录型 fake；`guarded-regression` 37/37 保持；不得开网/开子进程调外部工具。

**Verify（逐字）**：

```powershell
pnpm run typecheck
pnpm exec vitest run tests/unit/dsh-bridge tests/unit/jitrl
pnpm run test:e2e
pnpm run check:negative-result
pnpm run guarded-regression
pnpm run check:mutation          # 见陷阱：M2/M4 锚点
node scripts/host-smoke/run.mjs --check
# 就绪则：node scripts/host-smoke/run.mjs --out docs/reports/host-smoke-rc2.md（参数名以实现为准）
```

**陷阱**：
- `scripts/host-smoke/run.mjs` 当前把报告**硬编码**写到 `docs/reports/p61-host-smoke-rc.md`（`run.mjs:31` 的 `REPORT_PATH`）。直接跑全量会覆盖冻结的 rc1 → 必须加 `--out`/env 支持并用 `--no-write` 先观察。覆盖 rc1 = 失败。
- **`src/index.ts` 的写权限见 C-7**：默认只允许 t10 做增量状态字段；任何对既有字段/默认语义的改动都是失败。若队长未裁定而 t10 又需要改该文件，先发消息请裁定，不要先写后报。
- `check:mutation` 的 M2 目标 `src/jitrl/host-tool-experience.ts`、M4 目标 `src/jitrl/reward-contract.ts` 都在 t10 范围内；改这两处会移动锚点。硬约束：**不要改锚点文本块**；若必须改，先在报告中登记，由 t12 在依赖后修复 `scripts/eval/mutation-gate.mjs`（t10 不得改 scripts）。
- `src/orchestrator.ts`（M3 目标）不在 t10 范围；`src/cordis-seams/eight-surfaces.ts`（M1 目标）不在任何任务范围 → 两者锚点安全。

### 5.4 P4-1 / P4-2 / P4-3：记忆桥接（t11）

**Objective**：写能力三态握手无副作用；正向召回条件可观测；测试装配下的真实写入路径可验证；生产默认仍拒绝。

**In scope**：`src/memory-bridge/**`、`tests/unit/memory-bridge/**`、`tests/e2e/**/*memory*`（即 `tests/e2e/memory-backends.test.ts` 及新增 `*memory*` 文件）。

**Out of scope**：`src/index.ts`（入口状态？若必须加 handle 字段，请先报队长，因为入口是共享文件）、`src/runtime/**`、`src/jitrl/**`、`tests/e2e/fixtures.ts`（共享文件，改动需在报告中声明并重跑全量 e2e）。

**交付物与验收**：
- A-t11-1 `writable` 三态握手：`yes` / `no` / `unknown`；判定只读 tools/list 与 schema（不调用 commit/write，不写任何文件）；无法判定时 `unknown`，不得默认 `yes`。
- A-t11-2 握手无副作用：测试断言握手前后 backend 的调用序列不含写工具、`calls/writes/lastWritten` 不变、无临时文件。
- A-t11-3 状态显示 `Recall-Only`（当 `writable!==yes` 或权限拒绝时）；字段为增量、不新增 option key（G9）；`unknown` 与 `no` 可区分。**交付形态按 C-7 默认**：t11 提供 `src/memory-bridge/status.ts` 的纯函数（输入 descriptor/权限/profile，输出 `{ writable, mode: 'recall-only'|'read-write', diagnostics }`）+ 单测；handle 聚合由 t23 接线。若队长按 C-7 的备选裁定把 `src/index.ts` 给 t11，则 t11 可直接接线并在 t16 验收。
- A-t11-4 `whenToApply` 与 `whenNotToApply` 共用同一 CJK/latin 匹配规则；测试覆盖中文、英文、混合串；`whenNotToApply` 命中时否决（negative firewall）。
- A-t11-5 shadow 模式只记录、不过滤：命中率比较可观测（记录 recall 命中与 firewall 命中），默认行为不变（`enableNegativeFirewall=true` 的现有语义不被改写）。
- A-t11-6 仅测试装配 `memoryRealWrites: true` 的写入 e2e：治理（governance）拦截、命名空间隔离（`harness2` 前缀/自定义前缀）、失败回滚（backend 抛错后无半写）三件事均有断言。
- A-t11-7 生产默认仍关闭：`resolveExecutionProfile()`（无 override）`memory.allowed===false`（写成 t11 的正式测试）；`src/**` 不出现 `memoryRealWrites: true`（用等效 grep 工具 0 命中）；默认 config 的 `promoteOnComposeSuccess=false` 与 `mirrorToMemoryBridge=false` 不变。
- A-t11-8 无真实记忆写入：e2e 只连 in-memory mock；不得连接真实 MCP/本机记忆库；不得写用户目录。

**Verify（逐字）**：

```powershell
pnpm run typecheck
pnpm exec vitest run tests/unit/memory-bridge
pnpm run test:e2e
# 生产默认拒绝：由 t11 写成正式单测（resolveExecutionProfile().permissions.memory.allowed === false），
# 不要用一个只检查文件里出现某字符串的 node -e 冒充断言。
```

### 5.5 P3-1…P3-4：可判别评测与结构债（t12）

**Objective**：评测有判别力、统计解释不超证据、缓存优化数据门控、结构债用 AST 门禁收口。

**In scope**：`src/dream-rsi/surrogate-scorer.ts`、`src/harness2/**`、`scripts/eval/**`（t9 的四个门禁脚本除外）、`tests/unit/dream-rsi/**`、`tests/unit/eval/**`（t8 的三个文件除外）、`tests/e2e/**/*ablation*`、`docs/reports/p3-*`、`docs/reports/p7-*`、`docs/adr/*evaluation*`。

**Out of scope**：`pr4a-*`/`p61-*`/`p62-*`（冻结）、`src/dsh-bridge/**`、`src/jitrl/**`（除只读引用）、`src/memory-bridge/**`、README 计数行。

**交付物与验收**：

**(a) P3-1 2×2(+1) 判别力**
- A-t12-1 设计就是 PR-4A V2 的 **Arm-0…Arm-4**（2×2+1 参照）；**不得**引入 `Arm-5` 或“建议通道/单池混估”正式臂（V2 预注册明文禁止：`docs/reports/pr4a-five-arm-experiment-preregistration.md:775/:822`）。
- A-t12-2 同预算多采样对照：在**不改变 V2 冻结报告字节**（G7）的前提下，若新增重复采样，必须在开跑前写进新的预注册修订（指标、预算、seed、样本量/功效、α 与多重校正、胜/平/负定义），并把修订文件的哈希与时刻写进结果报告；未预注册的结果不得作为“判别力证据”。
- A-t12-3 结果报告必须给：每对比的差值、95% 区间（或预注册的区间口径）、胜/平/负、配对样本数；解释不得超出证据（不得把“未拒绝”写成“等效”）。
- A-t12-4 holdout 不参与选择：用现有防火墙命令验证：

```powershell
node scripts/eval/pr4a-stats.verify.mjs --firewall tests/fixtures/p2-l1/p2-v3-split-manifest.json --artifact tests/fixtures/p2-l1/p2-v3-selection-clean.json
# exit 0, ok:true
node scripts/eval/pr4a-stats.verify.mjs --firewall tests/fixtures/p2-l1/p2-v3-split-manifest.json --artifact tests/fixtures/p2-l1/p2-v3-selection-holdout-leak.json
# exit 1, ok:false（点名泄漏的 holdout task id）
```
  并把这两条作为提交测试/CI 步骤（若尚未接线）。**已实测（04:26）**：clean → exit 0 `ok:true`；leak → exit 1 `ok:false`，点名泄漏 task。
- A-t12-5 冻结家族零改动：`git diff --stat -- docs/reports/pr4a-*.md docs/reports/p61-*.md docs/reports/p62-*.md docs/reports/final-attestation.json` 为空。

**(b) P3-2 surrogate 自指检验**
- A-t12-6 构造反例：Composer（judge/选择器）判错，而可验证结果（receipt/verifier）给出相反结论；surrogate 若复制 Composer 的错误 → 自指成立（有测试断言分数排序错误）。
- A-t12-7 去 `w1`/`w2` 对照：同一批候选，分别用完整权重与去掉 `selection`/`adoption` 两维的排名；报告排序差异（必须给出具体节点与被翻转的位次）。
- A-t12-8 只基于证据调整：权重/规则调整必须指向可验证证据（receipt/verifier），并在报告中逐条列出“证据 → 调整”；不得以 Composer 自评为唯一依据。
- A-t12-9 `surrogate-scorer` 的默认权重与 clamp 语义不变（`DEFAULT_SURROGATE_WEIGHTS` 仍来自默认 config）；改动需有默认行为不变的对照测试。

**(c) P3-3 cacheRead 数据门控 A/B**
- A-t12-10 若没有 `cacheRead` 显著下降的 measured 数据：P3-3 明确 `gated` / `not-applicable`，**不得伪造 A/B**；报告必须写出“测不到”的原因与需要的授权/数据。
- A-t12-11 若存在 measured 数据：A/B 必须有同任务、同预算、同 seed 的对照，且 unknown 数据不得当 0 计入；统计口径（区间/胜平负）与 P3-1 一致。

**(d) P3-4 结构债 A+B（照 `docs/reports/p3-c-structural-debt-register.md` §3 执行）**
- A-t12-12 A（类型级）：`src/ledger/two-phase.ts` 的 `settleCall(request: SettleRequest)` 改为 `Omit<SettleRequest,'interim'>`；负控制：带 `interim` 的探针 `tsc` 报 `TS2353`（寄存器 §1 第 2b 行的方法）。
- A-t12-13 B（结构级）：两个桥文件不再持有 `LedgerReservationManager` 活引用（`src/dsh-bridge/agent-loop-executor.ts`、`src/dsh-bridge/metered-model-adapter.ts`）；装配点返回**已建好的** `TwoPhaseSettlement`；两者不得用 `any`/`as` 把 manager 拉回。
- A-t12-14 AST 静态门禁：扫 `src/dsh-bridge/**`，禁止对 manager 的 `.settle(` / `.reserve(`；必须是 AST 判断，不是字符串正则（`branch.ts` 的 `recorder.settle(` 会误伤）；负控制：向临时副本插入 `manager.settle({...})` → 门禁红并点名文件/行；删除保护 → 红。
- A-t12-15 NC6 迁移：既有运行时 7 红必须在 B 之后**换成静态门禁红**（“测试代替类型” → “门禁代替测试”），并给出最终字节上的负控制（不是中间态）。
- A-t12-16 强度自评分开写：类型面（A：类型级）与结构面（B：行为级结构性 + 静态门禁），不得合并成一句。
- A-t12-17 回归：`pnpm exec vitest run tests/unit/ledger tests/unit/dsh-bridge` 全绿（当前基线 17 files / 279 tests，**以实测值为准**，不钉死数字）；`pnpm run typecheck` 0。

**Verify（逐字）**：

```powershell
pnpm run typecheck
pnpm exec vitest run tests/unit/dream-rsi tests/unit/eval
pnpm run test:e2e
pnpm run check:negative-result
pnpm run check:mutation
pnpm exec vitest run tests/unit/ledger tests/unit/dsh-bridge
node scripts/eval/pr4a-stats.verify.mjs --firewall tests/fixtures/p2-l1/p2-v3-split-manifest.json --artifact tests/fixtures/p2-l1/p2-v3-selection-clean.json
```

**陷阱**：
- 改动 `scripts/eval/mutation-gate.mjs` 的锚点只能在 t10 完成之后（依赖边）；锚点必须仍“在 pristine 源码中恰好出现一次”，否则门禁按 `mutation-did-not-change-sha`/锚点缺失失败。
- `docs/reports/p7-*` 是新建目录前缀（当前不存在），不要与 `p6-*` 混淆。

### 5.6 验证 / 审核 / 集成（t13–t23）

| 任务 | 必须实测 | 关键判据 |
| --- | --- | --- |
| t13（P0-1/2 验证） | 干净克隆（§1.3 方法，禁用 junction）+ 目标测试 + typecheck + 全量 | 0 failed；5 个原失败用例逐个有名字与结果；未改生产代码掩盖夹具问题；报告实测文件/用例数 |
| t14（P0-3..6 验证） | J-1 四反例 + 正常 + 计数不匹配；干净树四反例；stale 两组；attest 目标/干净树/文档 | 退出码逐个记录；无伪造 HEAD 证明；`pnpm run typecheck`、`--docs-only`、`check:build-smoke`、`node --test …`、`tests/unit/p62` 全实测 |
| t15（P1/P2 验证） | rc2 逐面分类、状态字段、cacheRead unknown、A1..A6、两档探针、allowlist/账本/denied、noPolicy 分支计数 | 未执行项如实披露；无真实工具/模型/记忆；`check:mutation` 锚点未被 t10 破坏（或已由 t12 修复） |
| t16（P4 验证） | 三态握手无写调用、Recall-Only、CJK/latin、shadow 记录、测试装配写入 e2e 的治理/命名空间/回滚 | 生产写入仍关闭；用 grep 工具扫 `src/**` 的 `memoryRealWrites: true` 为 0 命中 |
| t17（P3 验证） | 预注册修订、CI/胜平负、holdout 防火墙两向、surrogate 反例、去 w1/w2 排名、cacheRead gated、结构债 NC | 未测项不得冒称完成；`check:mutation` 与 ledger/dsh-bridge 套件实测 |
| t18–t22（审核） | 只审不改；对照本契约逐条 | 有问题必须 `findings` + `requiredFix`；只有全满足才 `pass`；不得把“验证通过”当“审核通过” |
| t23（集成） | 见下 | 见下 |

**t23 的干净副本方法（冻结；本仓库本轮不 commit）**：

```powershell
# 1) 用脚本（node）读取 git 的 NUL 分隔清单并复制，得到“提交后的树”的等价副本：
#    git ls-files -z --cached --others --exclude-standard
#    （不要在 PowerShell 里直接对 NUL 分隔输出做 split：先把原始字节读入，再按 NUL 切分）
# 2) 临时目录内 pnpm install --frozen-lockfile（可 --offline）
# 3) 依次跑：typecheck / vitest / check:docs / check:encoding / build-smoke / negative-result / guarded-regression / mutation / attest:verify / check-attestation-target
# 4) 记录工作树状态：git status --porcelain=v1（含未跟踪计数），并声明“未提交，故未生成 HEAD 证明”
```

t23 验收（在任务书基础上补齐可核查点）：

- A-t23-1 五个实现组 + 五组验证 + 首轮交叉审核全部通过；需要 repair 的 finding 已关闭（引用 finding id 与复跑命令）。
- A-t23-2 干净副本中：`pnpm install --frozen-lockfile`、typecheck、全量 vitest、`check:docs`（**此时**用实测计数更新 README，一次写完）、`check:encoding`、`check:build-smoke`、`check:negative-result`、`guarded-regression`、`check:mutation`、`attest:verify`、`check-attestation-target` 全部实际执行并记录（命令/退出码/输出/时刻）。
- A-t23-3 README 计数一次收口：`node scripts/verify-readme-counts.mjs` 或 `pnpm run check:docs` 的 `Parsed == Actual` 与实测一致；此后任何测试增删都必须重跑并更新。
- A-t23-4 默认安全与授权边界：shadow 默认、memory 写入关闭、toolface 默认不下发、`9.4-2/9.4-3` not-run、publish 恒拒；逐条给出检查命令。
- A-t23-5 最终输出：变更清单（`git status --porcelain=v1` 的逐项分类）、证据索引（命令 → 日志位置/输出行）、剩余风险、需要用户另行授权的事项（真实付费模型、真实 memory 写、推送/提交、真实宿主收益评估）。

---

## 6. 需要队长裁定的冲突（C-1…C-10）

| # | 冲突 | 现状证据 | 我建议的默认处理（未裁定前按此执行） |
| --- | --- | --- | --- |
| C-1 | `t9` inScope 指向 `docs/adr/0007-…`，但该文件被 sha256 钉死 | `p6-pareto-budget.test.ts:866-880`，sha256 `47e67c7d…` | **不改 0007**；更正写入 `docs/reports/*correction*` 并指向 0007 §4。若队长要求改 0007，必须同时裁定更新 pin（会削弱冻结凭证） |
| C-2 | H-3 的另一处目标是 `ADR 0002:51` 与 `src/runtime/execution-profile.ts:121`，两者都不在 `t9` inScope | 轮次报告 #14；`t9` inScope 只有 `docs/adr/0007`、`src/dsh-bridge/model-config.ts` | 默认只登记不改（“文档漂移”以新更正文件 + 指针记录）。若要修文案，需给 t9 扩范围（ADR 0002 未被 pin，`execution-profile.ts` 未被 pin，技术上可行） |
| C-3 | `t10` 要写 `docs/reports/host-smoke-rc2.md`，但现有 runner 硬编码覆盖 rc1 | `scripts/host-smoke/run.mjs:31` `REPORT_PATH=docs/reports/p61-host-smoke-rc.md` | 默认：给 runner 加 `--out`/env，rc2 写新文件，rc1 字节不变；覆盖 rc1 视为失败 |
| C-4 | `t9` 全量 `check:docs` 与并发任务新增测试互相冲突（计数必须精确匹配） | README 当前 130/2493；G6 | 默认：t9 用 `--docs-only` + 负控制套件；全量计数由 t23 一次收口；t9 不得改计数行 |
| C-5 | rev5 原文不在仓库，本契约是重建 | `grep -r rev5` 0 命中 | 默认：以本文件 + 队长任务书为准；队长若持有原文，请广播与本文的差异（尤其 P1-4/P2/P3 的编号含义） |
| C-6 | t12 的“2×2(+1) 同预算多采样”可能与 V2 预注册冲突 | V2 禁止 Arm-5（`:775/:822`）；V2 报告冻结 | 默认：不新增正式臂；重复采样必须在开跑前写修订预注册；否则 P3-1 只能做“已有 V2 结果的判别力复核”，不得冒称新实验 |
| C-7 | **`src/index.ts` 不在任何任务的 inScope**，但 P1-2（表面状态）与 P4-1（Recall-Only 状态）都要求 handle/status 输出 | 任务书 t10/t11 的 inScope 均无 `src/index.ts`；`EvoHarnessPlugin`/`EvoHarnessJitRlStatus` 定义在 `src/index.ts:586` 起 | 默认：**`src/index.ts` 的增量状态字段由 t10 独占**（P1-2；只加字段/只读聚合，不改既有字段语义）；**t11 只交付 `src/memory-bridge/status.ts` 的模块函数 + 测试**，其 handle 聚合由 **t23 集成时一次接线**并由 t23 复验。若队长希望 P4-1 在 t16 就能从 handle 读到 Recall-Only，则请把 t11 依赖改为 `t10` 并把 `src/index.ts` 授权给 t11（串行写，避免冲突） |
| C-8 | t9 的新建门禁脚本（如 `scripts/eval/check-clean-tree.mjs`）与 t12 的 `scripts/eval/**` 所有权重叠 | 见 §3 矩阵 | 默认：t9 新建的门禁脚本与测试归 t9，t12 不得改；t12 只改既有评测脚本与 `mutation-gate.mjs` |
| C-9 | P1-1 要“支持新报告路径”，但 `scripts/host-smoke/**` 不在 t10 的 inScope（也不在 t12 的 `scripts/eval/**` 里） | `run.mjs:31` `REPORT_PATH` 硬编码 | 默认：不授权时 t10 用 `--no-write` 捕获 + 落盘 rc2，并在报告写明限制；`--out` 由 t23 集成时加（或队长现在就把 `scripts/host-smoke/**` 给 t10） |
| C-10 | J-1 修复要求“字段缺失也 fail-closed”，但会打破 `tests/unit/config/readme-default-leaves.test.ts` 的 5 个合成报告 fixture（缺 `success`/`numFailedTestSuites`/`unhandledErrors`/`numTodoTests`），而该文件不在 t9 inScope | 该文件 `:277-281` 等 5 处 fixture；`tests/unit/config/**` 无人拥有 | **建议**：授权 t9 对该文件做**只加字段**的 fixture 维护（`success: true`、`numFailedTestSuites: 0`、`unhandledErrors: []`、`numTodoTests: 0`），不得改任何断言；若队长不同意，则 t9 必须把“字段缺失”仅在**自生成报告**（root/temp）路径 fail-closed，对显式 `--report` 记录 `partial-report` 诊断，并写清该模式不进 CI |

---

## 7. 对队长任务书的勘误表（E-1…E-5，必须采用）

| # | 任务书原文 | 事实 | 修正 |
| --- | --- | --- | --- |
| E-1 | `t8` verify 里 `tests/unit/eval/pr4a-artifact-verifier.test.ts` | 文件不存在；实际是 `tests/unit/p62/pr4a-artifact-verifier.test.ts` | 用实际路径；不要新建重复文件 |
| E-2 | `t8` inScope/verify 里 `tests/unit/eval/readme-default-leaves.test.ts` | 文件不存在；实际是 `tests/unit/config/readme-default-leaves.test.ts`（自包含，无需改） | 从 t8 范围移除；回归时只跑不写 |
| E-3 | `t9` inScope `scripts/build*`、`docs/runbooks/**` | 两者当前都不存在（允许新建）；构建目前是 `package.json` 内联 esbuild；`prepare` 不存在 | 可新建；`prepare` 由 t9 加；`docs/runbooks/**` 只新增，不移动既有 runbook |
| E-4 | `t9` inScope `docs/adr/0007` | 被测试钉死（G8） | 改为只读；见 C-1 |
| E-5 | 干净克隆失败数“5 个 PR-4A 失败” | 实测正确（5 个，全部在 1 个文件）；但“junction 模拟”会多出 2 个假失败 | 干净克隆必须 `pnpm install --frozen-lockfile`；报告要写清方法 |

---

## 8. 验收证据格式（所有任务统一）

每个任务在完成时提交一张表（可放任务 output 或 `docs/reports/` 下的新报告）：

```text
| # | 命令（逐字） | 退出码 | 关键输出（逐字，≤3 行） | 取样时刻(+08:00) |
```

负控制另起一张表：

```text
| NC | 目标文件 | 变异（snippet 哈希） | 先证变异生效（目标串消失） | 红证据（red.log 路径/首行身份键） | 还原后哈希 == 原哈希 | 身份键完整 |
```

硬性要求：

1. 退出码必须来自实际执行；不得用“应当为 0”。
2. 引用他人/历史数字必须带其时间语境，且不得当作当前证据。
3. 任何“未执行/未授权/无法判定”必须显式写 `not-run` / `blocked` / `unknown` + 原因。
4. 通过 `agent_teams_update_task` 提交时，`acceptanceResults` 逐条对应本文件的 A-x；`commandsRun` 逐条对应 Verify 命令；不得只写“全部通过”。
5. 审核任务（t18–t22）只能基于被审任务**提交时**的证据与当前树复跑；不得替被审方补跑后宣称通过。

---

## 9. 本契约的失效条件

出现下列任一情形，本契约需由队长重新冻结（并广播）：

1. rev5 原文与本文件在条目范围/编号上有实质差异；
2. 队长批准新增插件 option key（G9 变化）或修改 pinned 文件（G8 变化）；
3. 队长批准 commit/push（G12 变化），从而使证明目标口径改变；
4. 任何任务发现本文件 §1 的基线数字在**未改动的树**上不能复现（说明环境已变）。

---

## 10. 附：本契约引用的关键源码/文件位置（供实现者直达）

| 主题 | 位置 |
| --- | --- |
| 默认配置 | `src/config.ts:367-466` |
| 执行档/权限（memory/publish/patch） | `src/runtime/execution-profile.ts:96-133` |
| 八表面键 | `src/types/contracts.ts:71-80` |
| 八表面挂载/`seam_unavailable` | `src/cordis-seams/eight-surfaces.ts:1-40`、`src/cordis-seams/errors.ts:15` |
| 工具面 allowlist/noPolicy | `src/cordis-seams/tool-face.ts:27-29,66-101,229-231,331-365` |
| 报告门禁（J-1 缺口） | `scripts/verify-readme-counts.mjs:404-430` |
| 证明目标门 T0–T8 | `scripts/eval/check-attestation-target.mjs:1-70` |
| 证明摘要根 | `scripts/eval/final-attestation.mjs:110-135`（`ATTESTED_ROOTS=['src','tests','scripts']`，记录路径 `docs/reports/final-attestation.json`） |
| 构建烟测 | `scripts/eval/smoke-build.mjs`（当前**无**新鲜度判据） |
| 宿主 smoke 运行器 | `scripts/host-smoke/run.mjs`（`run.mjs:31` 的 `REPORT_PATH` 硬编码）、`scripts/host-smoke/in-host.mjs` |
| 插件 handle / status 接口 | `src/index.ts:586` 起（`EvoHarnessPlugin`、`EvoHarnessJitRlStatus`；文件 3433 行，C-7 的裁定对象） |
| 宿主 smoke 五态/清单 | `tests/e2e/host-smoke/report-template.ts`、`tests/e2e/host-smoke/manifest.ts` |
| JitRL 负结果断言 A1–A6 | `scripts/eval/negative-result-diag.mjs:27-53`、`scripts/eval/lib/negative-result-assertions.mjs` |
| 结构债 A+B | `docs/reports/p3-c-structural-debt-register.md:58-78` |
| 预注册禁止 Arm-5 | `docs/reports/pr4a-five-arm-experiment-preregistration.md:775,822` |
| 变异门 M1–M4 与锚点规则 | `scripts/eval/mutation-gate.mjs:88-110,154-245` |
| 26 键公开面 | `tests/unit/config/plugin-options-shape.test.ts:45-180` |
| pinned ADR/装饰器 | `tests/unit/jitrl/p6-pareto-budget.test.ts:866-880` |
| 负控制规程 | `docs/NEGATIVE-CONTROL-RUNBOOK.md`（规则 2/3/3.5/4/4b/5.5） |

---

## 11. 裁定落地记录（2026-10-30T04:28，队长广播）

> 本节是**追加**记录：§6 的 C-1…C-10 已全部裁定，按队长的广播落地；上文条文的默认建议自此升级为**生效口径**。`t13`–`t17` 的验证一律按本节（而非 §6 的“待裁定”表述）执行。

| 冲突 | 裁定 | 生效口径 |
| --- | --- | --- |
| C-1 / C-2 | 按默认 | `docs/adr/0007-…` 保持只读（G8）；H-3 的 ADR 0002 / `src/runtime/execution-profile.ts` 文案漂移**只登记不改**，记录在新 `docs/reports/*correction*` 并附指针；不给 t9 扩范围 |
| C-3 / C-9 | 按默认 + 扩范围 | **t10 获得 `scripts/host-smoke/**` 与 `src/index.ts`**；runner 加 `--out`，rc2 写 `docs/reports/host-smoke-rc2.md`，`p61-host-smoke-rc.md` 字节不变（覆盖即失败） |
| C-4 | 按默认 | t9 用 `node scripts/verify-readme-counts.mjs --docs-only` + 负控制套件；README 计数由 `t23` 一次收口 |
| C-5 | 按默认 | rev5 原文与契约范围**无实质差异** → 本文件即权威版本（`t7` 冻结口径有效） |
| C-6 | 按默认 | 2×2(+1) 即 V2 的 `Arm-0…Arm-4`；禁 `Arm-5`；新增重复采样必须先写预注册修订 |
| C-7 | 按默认 + 授权 | `src/index.ts` 归 **t10**（仅 P1-2 增量状态字段，不改既有语义）；t11 交付 `src/memory-bridge/status.ts` 模块函数 + 单测；handle 聚合由 `t23` 接线（若 t11 依赖已改到 t10，则按队长广播允许 t11 直接接线） |
| C-8 | 按默认 | t9 新建的门禁脚本与测试归 t9；t12 不得改 |
| C-10 | 授权 | t9 获得 `tests/unit/config/readme-default-leaves.test.ts` 的 **fixture 只补字段**权限（补 `success` / `numFailedTestSuites` / `unhandledErrors` / `numTodoTests`），**不得改任何断言** |
| E-1 / E-2 | 已修正 | 队长任务书已改：`tests/unit/p62/pr4a-artifact-verifier.test.ts`、`tests/unit/config/readme-default-leaves.test.ts` |

**对后续验证任务的约束**：`t13`–`t17` 的 acceptance 以上文 A-x 为准，并按上表更新越界判定（t9 的 fixture 字段追加、t10 的 `scripts/host-smoke/**`、`src/index.ts` 属**合法**改动，不再是越界 finding；t11 直接接线的合法性取决于队长广播的依赖调整）。

---

**（完）** 本文件由 `t7` 产出；不修改任何生产代码、不执行付费模型/真实工具/真实记忆写入。