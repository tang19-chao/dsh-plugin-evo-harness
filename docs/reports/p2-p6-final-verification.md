# P2–P6 最终独立验证报告（t12 / verifier）

> 任务：t12；attempt `53602424-b0ad-4061-999d-414f3663ec42`
> 角色：独立验证者（不接受任何成员自述结论，只用可复跑的命令与文件状态判断）
> 基线：`feb8465ded73ca48a770054c587990b93f54e21e`（2026-10-29）
> 判定时点：2026-10-29 17:30（Asia/Shanghai）
> 主机：Windows，24 逻辑处理器，node v22.23.1
> 写入范围：本文件（新建，唯一写入）

---

## 0. 判决摘要（先给结论，再给证据）

| 项 | 判决 | 依据 |
| --- | --- | --- |
| 8 条门禁 | **6 绿 / 2 红（vitest、check:docs）** | §2 命令矩阵；两条红**同源**，均为 §3 的 p62 flake |
| 全量 vitest 红是否为实现缺陷 | **不是** | §3：单文件隔离 5/5 绿；`--no-file-parallelism` 全绿；`--testTimeout=30000` 全绿 |
| check:docs 红是否只剩 flake | **是（已用可判定方式证明，非推断）** | §3.4：喂一份**通过**的同一棵树报告给 `check:docs --report` → **exit 0 全绿** |
| 授权边界是否被突破 | **未发现突破** | §4：0 commit / 0 push / CI 未改 / mutation 判据未改 / 冻结历史报告字节不变 / 0 个 skip |
| 各成员报告的"已通过"是否有支撑 | **抽查 28 项：23 项精确一致，3 项时点漂移，1 项命令不可比，0 项无支撑** | §5 |
| 写入范围是否越界 | **未发现代码/文档越界；但发现 3 处遗留需处置** | §6（T-1 / T-2 / T-3） |
| 是否可收尾 | **不建议直接收尾**：先修 T-1（flake 根因，一行改动），再重跑 8 门 | §7 |

**一句话**：实现质量本身通过独立复算（tsc 0、6 条脚本门全绿、全量 2431 用例在串行与放宽超时两种配置下均全绿）；**唯一的红是一个可精确定位、可用一行修好的预存在门禁不稳定缺陷**，而它同时污染 `vitest` 与 `check:docs` 两条门禁的绿/红结论。

---

## 1. 方法与判定纪律

1. **不采信自述**：每条结论都由我在本轮重新执行的命令产生；报告里的数字只有在我复算一致时才引用为"已复现"。
2. **红的二分法**（队长 2026-10-29 口径，本轮实测确认其必要性）：
   - **单文件跑绿 + 全量跑红** ⇒ 预存在 flake，**不写成"通过"，也不写成"失败"**，单列一节；
   - **单文件跑红** ⇒ 实现缺陷。
3. **"局部绿不得写成整体绿"**：§2 逐条记录真实退出码，红的两条如实标红。
4. **可判定优先**：能用"喂已知输入 → 看输出"决定的，不用推断。§3.4 即用此法把 `check:docs` 的失败原因**证成**只剩 flake。

---

## 2. 命令矩阵（8 条必跑，真实退出码）

在同一次串行会话中执行（避免并发互相干扰），完整日志落盘于 `%TEMP%\verifier-final-matrix.txt`。

| # | 命令 | 退出码 | 关键输出（原文摘录） | 判定 |
| --- | --- | --- | --- | --- |
| 1 | `pnpm exec tsc --noEmit` | **0** | 无输出（12.6s） | 绿 |
| 2 | `pnpm run check:encoding` | **0** | `tracked blobs inspected: 333`；`SUCCESS: every tracked blob is LF text or an explicit -text exception` | 绿 |
| 3 | `pnpm run check:build-smoke` | **0** | `export-surface: 70 named exports`；`SUCCESS: the bundle builds and imports as ESM` | 绿 |
| 4 | `pnpm run check:negative-result` | **0** | `A1..A6 PASS - the historical negative result is intact`（meanDelta=-0.25、0/7/5、first harmful deviation ci-04\|2\|2 全部原样） | 绿 |
| 5 | `pnpm run guarded-regression` | **0** | 37 个 probe 全部 `status: passed`；`boundaries: no real model call, no paid API, no publish, no real memory write` | 绿 |
| 6 | `pnpm run check:mutation` | **0** | `[M1] KILLED red=4/4`、`[M2] KILLED red=5/3`、`[M3] KILLED red=3/2`、`[M4] KILLED red=2/2`；`worktree zero-residue: OK`；`copy removed: true`；`verdict: PASS` | 绿 |
| 7 | `pnpm exec vitest run` | **1** | `Test Files 1 failed \| 129 passed (130)`；`Tests 1 failed \| 2430 passed (2431)`；唯一失败 `tests/unit/p62/evidence-gates.test.ts:371` `Test timed out in 5000ms` | **红（flake，见 §3）** |
| 8 | `pnpm run check:docs` | **1** | `[docs-verify] Unexpected error during verification: Error: Command failed: pnpm exec vitest run --reporter=json ...`（在**计数比较之前**中止） | **红（同一 flake 的下游，见 §3.4）** |

> **复跑次数披露**（队长要求）：
> - 第 7 条 **并行模式本轮共跑 4 次，4 次全红**（同一用例）；**串行/放宽超时 2 次全绿**。
> - 第 8 条 **本轮共跑 4 次，4 次全红**。
> 因此本轮的"红"不是偶发一次，而是在本机 24 核负载下的**稳定复现**——这比"偶发 flake"更值得记录。

---

## 3. 唯一失败项的精确复现与根因（本轮最重要的发现）

### 3.1 现象

```text
FAIL  tests/unit/p62/evidence-gates.test.ts > PR-1 encoding-policy gate
      > distinguishes the tracked state from the untracked state on IDENTICAL policy bytes
Error: Test timed out in 5000ms.
 ❯ tests/unit/p62/evidence-gates.test.ts:371:3
```

### 3.2 四个实验把"实现缺陷"排除

| 实验 | 命令 | 结果 | 说明 |
| --- | --- | --- | --- |
| E1 单文件隔离 | `pnpm exec vitest run tests/unit/p62/evidence-gates.test.ts` | **exit 0**，`43 passed (43)` | 本轮共跑 **5 次，5 次全绿** |
| E2 三个 p62 文件同跑 | `pnpm exec vitest run tests/unit/p62/{commit-attestation,evidence-gates,pr4a-artifact-verifier}.test.ts` | **exit 0**，`112 passed (112)` | 三个"重 git"文件同跑也不红 |
| E3 串行全量 | `pnpm exec vitest run --no-file-parallelism` | **exit 0**，`130 passed / 2431 passed`（295.3s） | 并发是被排除的唯一变量 |
| **E4 放宽超时（并发不变）** | `pnpm exec vitest run --testTimeout=30000` | **exit 0**，`130 passed / 2431 passed`（82.2s） | **决定性**：不改并发、只放大超时即全绿 ⇒ 根因是**超时预算**，不是 git 逻辑错误 |

### 3.3 根因（机理性，不是"资源竞争"这种笼统归因）

三层事实叠加：

1. **vitest 默认 per-test 超时是 5000ms**：`vitest.config.ts` 只配置了 `exclude`，**没有配置 `testTimeout`**（实测该文件内 `testTimeout|hookTimeout` 0 命中）。
2. **该用例在满载下远超 5000ms**：
   - 单独跑该用例：**3254ms / 3062ms**（verbose 实测，紧贴 5000ms，余量仅约 55–65%）；
   - 全量并行：该文件整体被推到 `collect 117.88s / tests 265.69s` 的量级，单用例必然越线。
3. **该文件有 16 个 `it()` 会 shell out 到 git 或建临时仓库，但都没有显式超时**；出事的第 371 行正是其中之一。同文件的同类用例要么带 `120_000`（如 :369、:406 附近），要么耗时 <2s，所以只有它稳定越线。

> **为什么恰好是它**：该用例在**一个 test body 内**做 **2 次 `makeRepo()`（各自 `git init` + `git add` + `git commit`）+ 2 次 `checkEncodingPolicy()`**，是本文件最重的单例。

**最小反例（两条命令）**：

```powershell
pnpm exec vitest run                        # 并行 + 默认 5s  -> Tests 1 failed | 2430 passed (2431)
pnpm exec vitest run --testTimeout=30000    # 并行 + 30s      -> Tests 2431 passed (2431)
```

唯一变量是超时预算，其余（并发度、文件集合、代码）完全相同。

**最小修法**（一行，不改任何判据）：

```diff
   it('distinguishes the tracked state from the untracked state on IDENTICAL policy bytes', () => {
     ...
-  });
+  }, 60_000);
```

> 同一文件另有 **15 个**同类"重 git 无超时"用例（实测耗时 1493–4465ms），建议一并加超时预算，否则下一个撞线的就是它们（尤其 4465ms 的 `reports attributes-missing on a commit that predates the policy`）。
>
> **边界**：该文件不在我的写入范围（本任务唯一写入文件是本报告），因此我**只给修法与复现，不落地修改**。

### 3.4 `check:docs` 的红**被证明**只剩 flake（不是推断）

`check:docs` 的设计是：先跑一次内层 `vitest --reporter=json`，**若报告含失败/pending 则拒绝比较计数**（ADR 0005 F-14）。因此 flake 会让门禁在计数比较**之前** abort，看起来像"文档门禁崩了"。

**决定性实验**：先产出一份**通过**的报告，再喂给同一个门禁的 `--report` 入口（绕过内层 vitest 的随机性）：

```powershell
pnpm exec vitest run --no-file-parallelism --reporter=json --outputFile=$env:TEMP\verifier-serial-report.json
# VITEST_EXIT=0

node scripts/verify-readme-counts.mjs --report $env:TEMP\verifier-serial-report.json
```

实测输出（exit **0**）：

```text
[docs-verify] ✓ Report carries zero failed and zero pending tests.
[docs-verify] Parsed README metrics:  Summary: 130 files, 2431 tests
                                  Unit: 116 files, 2263 tests | E2E: 14 files, 168 tests
[docs-verify] Actual Vitest run metrics:  Unit 116/2263, E2E 14/168, Total 130/2431
[docs-verify] ✓ Counts close: unit + e2e == total on the README side and the report side,
              and every test file is attributed to tests/unit or tests/e2e.
[docs-verify] SUCCESS: All README.md test counts match Vitest results exactly!
[docs-verify] Config reference coverage: 78 documented row(s) vs 78 expected default leaf path(s)
[docs-verify] SUCCESS: documentation gate fully green.
```

**结论**：README 计数（队长重铸的 130/2431、116/2263、14/168）与实测**逐项精确一致**；配置参考 78/78；三方闭合通过。**`check:docs` 的红 100% 由 flake 引起**——这以**证明**（而非声明）满足了队长"确认刷新后只剩 flake 一种原因"的要求。

失败路径也验证过：直接跑 `node scripts/verify-readme-counts.mjs --report <含 1 failed 的报告>` → **exit 1**，输出 `FAIL: the consumed report carries 1 failed test(s). Refusing to verify README counts against a failing run.`——F-14 的 fail-closed 行为正确。

### 3.5 关于"本轮提高了 flake 触发率"（两件事分开写）

- **事实**：本轮把套件从 103 文件 / 2094 用例扩到 **130 文件 / 2431 用例**（+27 文件 / +337 用例）。
- **机制**：vitest 默认按文件并行（本机 24 逻辑核）。并发度上升 ⇒ 每 worker 的 CPU 份额下降 ⇒ 本已贴近 5000ms 的用例越过阈值。E4（只放宽超时即全绿）+ E1（单文件全绿）共同支持这一机制。
- **归因措辞**：
  1. **本轮没有引入这个缺陷**——`tests/unit/p62/evidence-gates.test.ts` **未被修改**（不在 `git status` 的已跟踪改动列表内，`git diff` 对其为空）；
  2. **本轮的改动显著提高了它的触发率**——从"偶发"变成"本机 24 核下 4/4 稳定复现"。

### 3.6 与 p5 / 队长观测的关系（交叉核对结论）

- `p5-synthetic-trust.md` §8.1 把该 flake 归给"t12 集成轮作为门禁稳定性事项"，并给出"修法三步"。**复算结论**：
  - ✅ 归属正确（t12 处理，无当前属主）；✅ "在 README 计数重铸之前修"的时序正确；
  - ❌ **"嫌疑是并发负载下 repoRoot 的 .git 与临时仓库 git 进程竞争"不成立**：E2 证明三个重 git 文件同跑仍绿；失败形态是 **5000ms 超时**（确定性），不是 git 命令报错。
  - ❌ **修法第 1、2 步不是本缺陷的必要条件**：真正修复是**显式超时预算**（一行）；env 隔离与串行化只降低触发率、不解决根因，且串行化会把全量从 **85s** 拖到 **295s**。
- **形态差异如实登记**：队长报告过 **8 failed / `STACK_TRACE_ERROR`**（三个 p62 文件）；我本轮 **4 次并行全量从未复现** 8 条或 `STACK_TRACE_ERROR`，稳定是 **1 failed（超时）**。两者可能同源（更严苛的并发负载），也可能不同源；我按**我实测到的形态**判定，并明确标注存在差异。

---

## 4. 授权边界交叉核对（逐条，全部可复跑）

| 边界 | 检查命令 | 实测结果 | 判定 |
| --- | --- | --- | --- |
| 不得 commit | `git rev-list --count feb8465..HEAD` | `0` | ✅ |
| 不得 push | `git rev-list --left-right --count origin/main...HEAD` | `0  0` | ✅ |
| 不得改 git 历史 | `git reflog -5` | 最新仍是 `feb8465 commit: chore(evidence)…`，无 reset/rebase/amend | ✅ |
| 不得改 CI 门禁语义 | `git status --porcelain -- .github` | 空 | ✅ |
| 不得改变异判据 | `git status --porcelain -- scripts/eval/mutation-gate.mjs` | 空 | ✅ |
| 不得改写历史负结果 | `git status --porcelain --untracked-files=no -- docs/reports/` | **空** | ✅ |
| 定向核对冻结资产 | `git diff --stat -- docs/reports/pr4a-five-arm-eval-report.md docs/reports/pr4a-five-arm-experiment-preregistration.md 'docs/reports/p61-*' 'docs/reports/p62-*' P6_STATUS.md DEVELOPMENT_LOG.md docs/reports/final-attestation.json` | **空**（0 行输出） | ✅ |
| 冻结资产字节级 | `git rev-parse HEAD:<path>` vs 工作树 `Get-FileHash` | 11 个冻结资产全部 TRACKED，blob 与报告引用一致（pr4a 报告 `b6c47780…`、prereg `47006d2b…`、`final-attestation.json` `cf8fb513…`） | ✅ |
| 不得新增 skip | grep `it.skip/describe.skip/test.skip/xit/xdescribe/.todo(/.only(` 于 `tests/**` | **0 命中**（2 条原始命中是 `process.exit` 字符串，非 skip） | ✅ |
| 不得真实付费调用/宿主 smoke | `node scripts/eval/pr4a-v3-replay.mjs`；`node scripts/host-smoke/contract.mjs --json` | `liveCalls=0, incurredRealUsd=0`；real 五项 `status: not-run` | ✅ |
| 不得把 estimated 当 measured | `node scripts/eval/verify-pr4a-artifacts.mjs` | `checked=691 passed=691 failed=0`（PR-4A 成本门禁原样通过，未放宽） | ✅ |
| 不得用 holdout 做选择/过滤/调参 | `vitest run tests/unit/jitrl/p6-pareto-budget.test.ts`＋`tests/unit/dream-rsi/pr4b-holdout.test.ts` | 33/33、38/38 全绿（含 holdout-only 优胜者不被选中、生成器拿不到 holdout 引用） | ✅ |
| 不得把同进程执行称作沙箱 | 三处边界声明 | `p4-c-toolface.md` §1.2 / `tool-face.ts` 模块头 / contract-smoke 注释：同措辞"同进程协作式边界 / `ctx.fork` 不是 OS 边界 / 不是沙箱" | ✅ |

### 4.1 一处需披露的已跟踪改动（非越界）

`docs/adr/0005-p1-evidence-and-atomic-config-contract.md` 被修改（+26 / −1）。逐行核对：

- 删除的 1 行是 **M3 行的旧文本**，被替换为**同一判据的精确化版本**（补 `tests/unit/orchestrator/` 路径前缀 + "注册必红 2 / 观测红 3"口径）；
- 新增为 §3.4.1（`{config:null}` 裁定）、§3.7 入口白名单行、§5.1 M3 口径注；
- **判据零改动**：`check:mutation` 实测 `M3 KILLED red=3/2`，与 ADR 记载的"must-red 2/2、观测红 3"完全吻合。

结论：属 R-03 / R-01 / R-07 的授权写入（`p2-r-leftovers.md` §10 已声明），**不是历史数字改写**。

---

## 5. 交叉核对：13 份报告 × "已通过" 抽样复算

原则：**报告里每个"已通过"我都要能自己跑出同样的行**。下表只列我实际重跑过的项。

| # | 报告 | 声明 | 我的复算命令 | 实测 | 一致？ |
| --- | --- | --- | --- | --- | --- |
| 1 | p2-a-b-kernel | prior .569 / oracle .806 / headroom .236；rank=9；10/12；IN BAND | `node scripts/eval/pr4a-v3-design.mjs` | exit 0；四组数字逐项相同；`rank-1 negative control: rank=1` | ✅ |
| 2 | p2-a-b-kernel | r4 重放 9 断言全过、1998/1998、0.569→0.722、rank 12 | `pr4a-v3-replay.mjs --fixture=r4-production` | exit 0；9 项 PASS 逐条命中；`7992 vs 1998 / 0.417 vs 0.722` | ✅ |
| 3 | p2-a-b-kernel | r2 负对照必须 ABORTED | `--fixture=r2-legacy` | exit 0 且打印 `ABORTED (expected for the r2-legacy control)`，码 `learning_facing_survival_abort` | ✅ |
| 4 | p2-a-b-kernel | 五臂帧未移动（pinned digest） | `node scripts/eval/pr4a-smoke-invariant.mjs` | `current == pinned == sha256:0654a6cb…d423`；PASS | ✅ |
| 5 | p2-preregistration-v3 | V2+V3 全部表自检 | `node scripts/eval/pr4a-stats.verify.mjs` | exit 0；split `71cf9b17…`、table `585d0307…`、`pi*=0.9011` | ✅ |
| 6 | p2-l1-mechanism | 12 条机制夹具 | `vitest run tests/unit/eval/p2-l1-mechanism.test.ts` | `12 passed` | ✅ |
| 7 | p2-r-leftovers | docs-only 78/78 | 见 §3.4 同程输出 | `78 documented row(s) vs 78 expected` | ✅ |
| 8 | p2-r-leftovers / p3-c | 冻结产物门禁 691/691 | `node scripts/eval/verify-pr4a-artifacts.mjs` | `checked=691 passed=691 failed=0`；PASS | ✅ |
| 9 | p3-a-assembly | ledger+dsh-bridge 全绿 | `vitest run tests/unit/ledger` | `13 files / 206 tests`（报告写 9/183） | ⚠️ 时点漂移 |
| 10 | p3-a-assembly | 静态门 + 常驻负控制 | `vitest run tests/unit/dsh-bridge/agent-loop-ledger-assembly.test.ts` | `20 passed`（含 NEGATIVE CONTROL 与 5 条静态门） | ✅ |
| 11 | p3-a2-observe | observe 12 条保证 | `vitest run tests/unit/ledger/p3a2-observe.test.ts` | `12 passed` | ✅ |
| 12 | p3-b-adapter | 静态门 93 files / 4 allow-listed / 0 unmetered | `node scripts/eval/metering-coverage.mjs` | exit 0；**96 file(s)** / 4 / 0 | ⚠️ 文件数 93→96，语义不变 |
| 13 | p3-b-adapter | 32 条新增 | 三个套件同跑 | 9 + 21 + 4 = `32 passed` | ✅ |
| 14 | p3-c-usage | ledger 193 条 | 同 #9 | 206 条 | ⚠️ 时点漂移 |
| 15 | p4-a-adr-mount | 兄弟探针隔离 5 条 | `vitest run tests/unit/seams/mount-scope-isolation.test.ts` | `5 passed` | ✅ |
| 16 | p4-a-adr-mount | 身份/授权 12+12 | `vitest run tests/unit/jitrl/{scope-registry-identity,probe-authorization}.test.ts` | 12 + 12 = `24 passed` | ✅ |
| 17 | p4-b-lease | 租约 19 条 | `vitest run tests/unit/jitrl/scope-registry-lease.test.ts` | `19 passed` | ✅ |
| 18 | p4-b-lease | jitrl 32 files / 771 tests | `vitest run tests/unit/jitrl` | `32 passed / 771 passed` | ✅ 精确一致 |
| 19 | p4-c-toolface | contract-smoke 9 条 | `vitest run tests/e2e/host-smoke/contract-smoke.test.ts` | `9 passed` | ✅ |
| 20 | p4-c-toolface | cordis-seams+host-smoke 8 files/124 | `vitest run tests/e2e/host-smoke` | `2 files / 49 tests`（我跑的是子集） | ➖ 不可比 |
| 21 | p4-c-toolface | contract.mjs real 五项 not-run | `node scripts/host-smoke/contract.mjs --json` | exit 0；`"passed": true`；real 五项 `not-run` | ✅ |
| 22 | p5-synthetic-trust | verification 6 files / 148 tests | `vitest run tests/unit/verification` | `6 passed / 148 passed` | ✅ 精确一致 |
| 23 | p5-synthetic-trust | p5 套件 49 条 | `vitest run tests/unit/verification/p5-synthetic-trust.test.ts` | `49 passed` | ✅ |
| 24 | p5-synthetic-trust | 指纹 `3ef949ec…` / 57582 B | `Get-FileHash` | `3ef949ec427e…5e0a` / 57582 | ✅ 精确一致 |
| 25 | p6-pareto-budget | pinned `c9443123…` / `47e67c7d…` | `Get-FileHash` | `c94431235a0a…4266` / `47e67c7dab9d…b289` | ✅ 精确一致 |
| 26 | p6-pareto-budget | 33 条 | `vitest run tests/unit/jitrl/p6-pareto-budget.test.ts` | `33 passed` | ✅ |
| 27 | p6-pareto-budget | p6 套件自身指纹 `5349f4a2…` / 36099 B | `Get-FileHash` | `5349f4a2ba5d…4ad0` / 36099 | ✅ 精确一致 |
| 28 | 全体 | e2e host-smoke 总览 | §2 全量运行 | 全量 2431 用例串行/放宽超时双配置全绿 | ✅ |

**统计**：28 项 → **23 项精确一致**、**3 项时点漂移**、**1 项命令不可比**、**0 项无支撑**。

> **对"时点漂移"的判定**：报告数字在**其写作时刻**为真，漂移方向与后续任务的新增量一致；不算"复述错误"。但仍登记，因为**下游引用必须带时点**，否则会误判。

---

## 6. 写入范围与越界扫描（`git status` 全量）

### 6.1 变更规模

| 类 | 数量 | 说明 |
| --- | --- | --- |
| 已跟踪修改 | **37** 文件（+4880 / −250 行，含队长对 README 的 +4/−4） | 全部落在各任务声明的写入范围内（§6.2）；我本人未改任何已跟踪文件 |
| 未跟踪新增 | 约 **60** 项 | 新模块 / 脚本 / 测试 / 报告 / ADR / 夹具 |
| 未跟踪垃圾 | **2 项**（§6.3 T-1/T-2） | 需清理，非功能缺陷 |
| 越界的代码/文档改动 | **0** | 定向核对见 §4、§6.2 |

### 6.2 逐文件归属（37 个已跟踪修改，无孤儿）

- **P2 组（9）**：`src/jitrl/{decision-kernel,index,jit-active-policy}.ts`、`scripts/eval/{pr4a-stats.verify,verify-pr4a-artifacts}.mjs`、`scripts/verify-readme-counts.mjs`、`tests/unit/config/{plugin-options-shape,readme-default-leaves}.test.ts`、`docs/adr/0005-*.md`
- **P3 组（14）**：`src/ledger/{index,limits,pricing,reservation-manager,types}.ts`、`src/dsh-bridge/{agent-loop-executor,branch,index}.ts`、`src/harness2/{proposer,composer,reflector}.ts`、`src/dream-rsi/offline-dreamer.ts`、`src/jitrl/{step-evaluator,logit-sources}.ts`
- **P4 组（9）**：`src/cordis-seams/{dsh-hook-host-adapter,eight-surfaces,errors,host-adapter,index,seam-manager}.ts`、`src/jitrl/{scope-registry,runtime-control}.ts`、`tests/unit/cordis-seams/dsh-hook-host-adapter.test.ts`
- **R 组（4）**：`src/host-triggers.ts`、`src/types/contracts.ts`、`scripts/eval/{check-attestation-target.mjs,compare-platform-digests.d.mts}`
- **队长（1）**：`README.md`（计数重铸，+4/−4；不在我的写入范围，我未触碰）

### 6.3 三处需处置的遗留（**非越界，但必须登记**）

| ID | 项 | 事实 | 影响 | 建议 |
| --- | --- | --- | --- | --- |
| **T-1** | `tests/unit/jitrl/__p6-probe.tmp.test.ts`、`__p6-probe2.tmp.test.ts`、`__p6-probe3.tmp.test.ts` | t11 的临时校准探针，文件头自称 *"TEMPORARY probe … Deleted after use"*，但**仍在工作树且被 vitest 收集** | **已计入正式计数**：`vitest` 报 130 files / 2431 tests，其中 **3 files / 3 tests 是这些遗留探针**。README 已按 130/2431 重铸，直接删除会**再次**让 `check:docs` 红（需同步重铸为 127/2428、unit 113/2260） | 二选一：**删除 + 同步重铸 README**（推荐；其校准结果已固化进 `p6-pareto-budget.test.ts` 的 pinned digest）或**明确声明为正式测试**。当前两者皆非，属**未声明状态** |
| **T-2** | `undefined/temp/p5-docs-repro{,2,3}.json`（约 2.6MB，未跟踪） | `undefined/` 目录由某次脚本把 `undefined` 当路径段拼接产生（时间戳 2026-10-29 16:02–16:13，P5 收尾窗口） | 不被 vitest 收集、不在 git 跟踪内，但污染 `git status`，且说明**某次运行把参数当成了路径**（与 p2-kernel 报告 §7 已修的 `--out=` 缺陷同类） | 删除该目录；复核产生它的那次命令（P5 报告 E8 的复现命令很可能是源头） |
| **T-3** | `tests/unit/jitrl/mount-scope-isolation.test.ts` **不存在** | `p4-a-adr-mount.md` §3 的逐文件表写的这个路径；实际在 `tests/unit/seams/mount-scope-isolation.test.ts`（**p4-c** 报告写对了） | **文档路径错误**（非功能缺陷）：按 p4-a 报告复算的人会找不到文件 | 修正 p4-a 报告一行。不属我的写入范围，只登记。**（该条已更正，见 §11.6：这是我的误读，文件本身正确）** |

> **T-1 的额外证据**：这 3 个探针在本轮 **4 次并行全量中全部被收集并通过**，并 `console.log` 大量 `RUN={…}` 校准数据（CI 日志噪声）。`p6-pareto-budget.md` 与 `p2-r-leftovers.md` **都没有提到它们**（grep 0 命中），即**未被任何报告声明**。

---

## 7. 残余风险

| # | 风险 | 严重度 | 证据/复现 | 处置建议 |
| --- | --- | --- | --- | --- |
| R1 | **门禁绿/红取决于并发负载**（队长已确认为跨任务系统性遗留） | **高** | §3.2：同树 isolated 绿 / 并行红 / 串行绿 / 放宽超时绿 | 修 R2 类超时预算；报告"全量绿"必须附**复跑次数与运行配置**（p2-prereg 的"plain 3/3"是正确做法，但**未注明并发配置**，应补充） |
| R2 | 15 个同类"重 git 无超时"用例仍在 5000ms 默认预算下 | 中 | §3.3：实测 1493–4465ms，余量仅 10–70% | 与 R1 同批加超时（`}, 60_000)`） |
| R3 | 3 个遗留探针被计入正式计数 | 中 | §6.3 T-1 | 删除 + 重铸 README，或声明为正式测试 |
| R4 | `undefined/` 垃圾目录（2.6MB） | 低 | §6.3 T-2 | 删除；复核产生源 |
| R5 | p4-a 报告测试路径写错 | 低 | §6.3 T-3 | 一行文档修正 |
| R5-撤销 | **（该条已撤销，见 §11.6：这是我的误读，`p4-a-adr-mount.md` 的路径从一开始就是正确的，无需修正）** | — | §11.6 | 无 |
| R6 | p5 报告对 flake 的根因归因（git 竞争）与实测不符 | 低 | §3.6 | 以 §3.3 的超时归因取代；"三步修法"可保留为防御性加固，但不是本缺陷的修复 |
| R7 | 真实宿主 smoke / 真实付费调用 / 真实外部工具 / 记忆写入 **全部未执行** | 中（设计如此） | §4；`contract.mjs` real 五项 not-run | 见 §8 |
| R8 | `estimated` vs `measured` 分列只在**报告层与类型层**验证；生产消费方仍是一步式结算（t6 §7.1 自述缺口） | 中 | t6 报告 §7.1 | 集成轮事项，已登记 |
| R9 | P6 预算钩子**未接生产**（`src/index.ts:1575` 不传 `budget`） | 低（默认全关，设计如此） | p6 报告 §1；`pr4a-smoke-invariant` 帧未动 | 保持 |

---

## 8. "需授权未执行"清单（不留无声缺口）

| # | 项 | 状态 | 授权申请文本 |
| --- | --- | --- | --- |
| A1 | 真实宿主 smoke（sibling / 并发复用 / 过期租约 / 清理 / mount 不泄漏） | **未执行（需授权）** | "申请在受控测试会话（仅测试 namespace）启动真实 DSH 探针分支，采集 `system-prompt/assemble` 与 `tools/pre-execute` 快照，验证五类场景；不触碰业务数据，不产生付费调用。" 替代验证（已完成）：`contract-smoke` 9/9 + `contract.mjs --json` real 五项 not-run |
| A2 | 真实付费模型调用 / 五臂或 V3 重跑 | **未执行（需授权）** | "申请对 V3 任务表 `v3/tasks-20261029`（digest `585d0307…`）执行真实付费评测（12 任务 × L=5 × R=3），执行前复核 holdout 防火墙与统计计划未修改，执行后只新增 V3 报告。" |
| A3 | 真实外部工具 / 记忆写入 / 多步探针 | **未执行（需授权）** | "申请在测试 namespace 内执行一次真实多步探针与外部工具调用，验证授权账本五类动作的默认拒绝在生产路径生效。" |
| A4 | 修改 `tests/unit/p62/evidence-gates.test.ts`（T-1 修复） | **未执行（写入范围外）** | 修法与 diff 见 §3.3。建议授权后一行修复 + 复核 15 个同类用例 |
| A5 | 删除 3 个遗留探针并重铸 README（T-1/T-2） | **未执行（写入范围外 + README 属队长）** | 需与 README 重铸同一变更集，否则 `check:docs` 会因计数不匹配转红 |
| A6 | 真实 attestation（目标提交生成 + 单独证据提交） | **未执行（需授权）** | 需在目标代码提交上 `pnpm run attest` 并以 `Attestation-Target: first-parent` 单独提交 |

---

## 9. 复算命令清单（reviewer 最小集）

```bash
# 0) 八条门禁（逐条，记录退出码）
pnpm exec tsc --noEmit                          # 0
pnpm run check:encoding                         # 0
pnpm run check:build-smoke                      # 0
pnpm run check:negative-result                  # 0
pnpm run guarded-regression                     # 0
pnpm run check:mutation                         # 0
pnpm exec vitest run                            # 1（p62 evidence-gates:371 超时）
pnpm run check:docs                             # 1（同一 flake 的下游）

# 1) 证明 flake 不是实现缺陷（三条互证）
pnpm exec vitest run tests/unit/p62/evidence-gates.test.ts   # 0（43 passed）
pnpm exec vitest run --no-file-parallelism                   # 0（130 files / 2431 tests）
pnpm exec vitest run --testTimeout=30000                     # 0（130 files / 2431 tests）★决定性

# 2) 证明 check:docs 的红只剩 flake
pnpm exec vitest run --no-file-parallelism --reporter=json --outputFile=$TEMP/vr.json
node scripts/verify-readme-counts.mjs --report $TEMP/vr.json # 0（fully green）

# 3) 授权边界
git rev-list --count feb8465ded73ca48a770054c587990b93f54e21e..HEAD   # 0
git rev-list --left-right --count origin/main...HEAD                  # 0  0
git status --porcelain --untracked-files=no -- docs/reports/          # 空
git diff --stat -- docs/reports/pr4a-five-arm-eval-report.md 'docs/reports/p61-*' 'docs/reports/p62-*'  # 空

# 4) 报告数字复算（抽样）
node scripts/eval/pr4a-v3-design.mjs                          # prior .569 / oracle .806 / rank 9
node scripts/eval/pr4a-v3-replay.mjs --fixture=r4-production  # 9 PASS / 1998 survivors
node scripts/eval/pr4a-smoke-invariant.mjs                    # pinned 0654a6cb… 一致
node scripts/eval/verify-pr4a-artifacts.mjs                   # checked=691 passed=691
node scripts/eval/metering-coverage.mjs                       # 96 files / 4 allow-listed / 0 unmetered
node scripts/host-smoke/contract.mjs --json                   # fake 9/9；real 五项 not-run
```

---

## 10. 本报告不声明什么

1. **不声明整体通过**：8 条门禁中 **2 条为红**，已如实标红并给出根因、最小反例与一行修法。
2. **不声明"flake 可以忽略"**：它使 `vitest` 与 `check:docs` 两条门禁的结论不可靠，属**必须修的门禁稳定性缺陷**。
3. **不声明我复现了队长的 8 failed / `STACK_TRACE_ERROR`**：本轮 4 次并行全量稳定为 **1 failed（超时）**，形态不同，已如实登记（§3.6）。
4. **不声明 P2–P6 的功能验收已通过**：我只验证了"报告声明的命令能否复现"（§5 抽样 28 项）与"门禁是否绿"（§2）。**功能正确性、真实宿主行为、真实成本口径**不在本轮可判定范围（§8）。
5. **不声明 estimated 是 measured**，**不声明同进程执行是沙箱**，**不声明 holdout 参与了任何选择**。
6. **未修改任何他人文件**：本任务唯一写入是本报告。
---

## 11. 收尾复核（修复后）

> **编号说明**：lead 要求的标题是"§9 收尾复核（修复后）"。本报告 §9（复算命令清单）与 §10（本报告不声明什么）在 t12 时已存在，直接插入会破坏既有编号与交叉引用，故本节**顺延为 §11**，标题文字保留 lead 的原措辞。§1–§10 一字未改。
> 复核时点：2026-10-29 17:55（Asia/Shanghai）。任务：t14（承接 t12）。

### 11.1 原 2 条红的处置链

| 原红 | t12 的诊断 | lead 的处置 | 复测 |
| --- | --- | --- | --- |
| `vitest=1`（`tests/unit/p62/evidence-gates.test.ts:371` "Test timed out in 5000ms"） | 根因是**全局 `testTimeout` 默认 5000ms 不足**，非实现缺陷；决定性实验 `--testTimeout=30000` 已验证（§3.2 E4 / §3.3） | 改 `vitest.config.ts` 增加 `testTimeout: 30_000`（附 12 行理由注释），**不改任何测试文件** | **exit 0**，`127 files / 2428 tests` |
| `check:docs=1`（`Unexpected error during verification`，在计数比较前 abort） | 同一 flake 的**下游**；门禁先跑内层 vitest，报告含失败即拒绝比较计数（ADR 0005 F-14） | 随上一条转绿；README 重铸为 127/2428（unit 113/2260、e2e 14/168） | **exit 0**，逐项一致 + 78/78 |

**两条红是同一根因的两种表现**，修一处即同时消失——这一点在修复后得到证实（不存在"修了 A 而 B 仍红"的情况）。

### 11.2 修复后 8 门真实退出码（我在同一次串行会话中复跑，日志 `%TEMP%\verifier-closeout-matrix.txt`）

| # | 命令 | 退出码 | 耗时 | 关键输出 | 判定 |
| --- | --- | --- | --- | --- | --- |
| 1 | `pnpm exec tsc --noEmit` | **0** | 12.3s | 无输出 | 绿 |
| 2 | `pnpm exec vitest run` | **0** | 76.8s | `Test Files 127 passed (127)`；`Tests 2428 passed (2428)` | **绿（原红）** |
| 3 | `pnpm run check:docs` | **0** | 76.9s | `Summary 127/2428`、`Unit 113/2260`、`E2E 14/168` 与实测逐项一致；`✓ Counts close`；`✓ Configuration reference 78/78`；`SUCCESS: documentation gate fully green` | **绿（原红）** |
| 4 | `pnpm run check:encoding` | **0** | 2.9s | `SUCCESS: every tracked blob is LF text or an explicit -text exception` | 绿 |
| 5 | `pnpm run check:build-smoke` | **0** | 3.4s | `SUCCESS: the bundle builds and imports as ESM` | 绿 |
| 6 | `pnpm run check:negative-result` | **0** | 2.6s | `A1..A6 PASS - the historical negative result is intact` | 绿 |
| 7 | `pnpm run guarded-regression` | **0** | 2.4s | 全部 probe `passed` | 绿 |
| 8 | `pnpm run check:mutation` | **0** | 30.1s | `M1 4/4`、`M2 5/3`、`M3 3/2`、`M4 2/2`；`worktree zero-residue: OK`；`verdict: PASS` | 绿 |

**结果：8/8 全绿。**

**独立二次复跑**（fresh 进程，不与上表同一次会话）——因为 lead 只要求这两条，且它们正是原红：

```text
pnpm exec vitest run   -> VITEST_EXIT=0   elapsed=75.2s   Test Files 127 passed (127) | Tests 2428 passed (2428)
pnpm run check:docs    -> DOCS_EXIT=0     elapsed=78.5s   SUCCESS: documentation gate fully green
```

两次复跑与 lead 自报的"127/2428、74.7s；check:docs exit 0"一致。**lead 的修法成立。**

### 11.3 T-1 / T-2 / T-3 最终状态（逐条独立核实）

| ID | 最终状态 | 我的独立核实 | 备注 |
| --- | --- | --- | --- |
| **T-1** | 三个 `__p6-probe*.tmp.test.ts` **已删除** | `Get-ChildItem tests/unit/jitrl/__p6-probe*` → **0 命中**；测试文件总数由 130 降到 **127**（unit 116→113），与删 3 个文件精确吻合 | 见下方"理由评估" |
| **T-2** | `undefined/` 目录**已删除** | `Test-Path undefined` → `False` | 生产者仍未定位，lead 已登记为系统性遗留 |
| **T-3** | **我错了，lead 的"已过期"不成立——正确的说法是"我的观测有误"** | `p4-a-adr-mount.md` 的 `LastWriteTime = 2026/10/29 12:45:16`，**早于我本轮开工（16:40）**；文件长度 16061 B 与我读取时相同；第 46/54/79 行全部写的是 `tests/unit/seams/mount-scope-isolation.test.ts`；该路径文件存在，`tests/unit/jitrl/mount-scope-isolation.test.ts` 不存在 | **这是我的误读，必须由我更正**，见 §11.6 |

**对 T-1 删除理由的评估**：lead 的理由比我的更严格，且更正确。我在 §6.3 给的是"删除 **或** 声明为正式测试"的二选一，隐含承认它们可以是测试；lead 指出它们**没有任何 `expect()`**（是打印脚本，不是测试），因此"计入 2428 passing"等于**用永远通过的用例稀释分母**——这与本仓"不许 skip、不许无断言的绿"是同一条底线。**我接受这个更强的判断。**

> **诚实边界**：三个文件被删且原本未跟踪，**我现在无法再独立复核"0 个 `expect()`"这一具体断言**（无 git 对象、无副本）。我 t12 期间读过 `__p6-probe.tmp.test.ts` 的前 60 行（内容是 `console.log('SLOTS_DIGEST=' + …)` 一类打印），与该断言**方向一致**，但那是部分读取、非全文件计数。
> **可以核实的是"证据未丢失"**：其 pinned 值确已在 `tests/unit/jitrl/p6-pareto-budget.test.ts:254-257` 固化，并在 **:485-486** 以真实断言 `expect(slotsDigest).toBe(PINNED_SLOTS_DIGEST)` / `expect(diagnosticsDigest).toBe(PINNED_DIAGNOSTICS_DIGEST)` 使用——我已读该处代码确认。**所以删除不构成证据损失。**

### 11.4 我对 `testTimeout: 30_000` 的独立评价

**结论：我同意这个修法，并且认为它优于我在 §3.3 给出的逐条加超时。但要附两条必须修/必须知道的保留意见。**

#### 同意的理由（不是附和）

1. **它就是我自己实验里的那一条**。lead 采纳的不是我的"建议"，而是我用来做判定的**决定性实验本身**（§3.2 E4：`--testTimeout=30000` → 130/2431 全绿）。修法与被验证的变量完全一致，因此可预期地成立——修复后复测也确实是 8/8。
2. **一处改动 vs 16 处魔法数字**。逐条加超时会在 130 个文件里散落 16 个 `60_000`，且**下一个重 git 用例仍然会撞线**（我已指出同文件另有 15 个同类用例，但我无法保证全仓只有这 16 个）。全局预算覆盖现状与未来。
3. **不碰测试文件**，因此不会改变任何测试的语义——这一点比我原来的建议风险更低。

> **主动更正我的立场**：我在 §3.3 推荐逐条加超时，**部分原因是我当时判断 `vitest.config.ts` 不在我的写入范围**（本任务唯一写入是本报告）。那是一个**受约束的次优建议**，不是我认为的最优解。在可以改 config 的前提下，全局预算才是正解。

#### 保留意见 1（事实性错误，建议修）：注释里"10-minute job timeout"与 CI 实际不符

`vitest.config.ts:31` 写的是：

```text
// code. Raised to 30 s: still an order of magnitude below the 10-minute job
// timeout, so a genuine hang is still caught, but ordinary contention cannot
```

而我核对 `.github/workflows/ci.yml`：主 job `verify`（"Typecheck and test"）是 **`timeout-minutes: 30`**（30 分钟），不是 10 分钟（10 分钟的是 parity 与 attestation-target 两个小 job）。

- **结论方向不变且更强**：30s 相对 30min 是 **60 倍**余量，不是"一个数量级"而是接近两个数量级，"真挂起仍会被抓住"反而更成立；
- **但注释里的数字是错的**。这是一条**durable comment**，下一个人会据此推断 CI 预算。建议改为 `still ~60x below this job's 30-minute timeout` 或直接写 `far below the job timeout`。

#### 保留意见 2（真实残余暴露面，建议登记）：`hookTimeout` 仍是默认 10s

`testTimeout` 只管 **test body**，**不管 `beforeAll`/`afterAll`** —— 后者的预算是独立的 `hookTimeout`，**默认 10000ms**，而配置里**没有设置它**（`vitest.config.ts` 中 `hookTimeout` 0 命中，已实测确认）。

这不是理论风险，涉及的文件确实有重 hook：

| 文件 | hook | 内容 |
| --- | --- | --- |
| `tests/unit/p62/evidence-gates.test.ts:147` | `beforeAll` | `measureRepoState()`：两次 `execFileSync('git', …)` |
| `tests/unit/p62/evidence-gates.test.ts:151` | `afterAll` | `git worktree list` **+ 逐个 `rmSync` 全部临时目录**（本套件创建的目录多达 24 处） |
| `tests/unit/p62/commit-attestation.test.ts:53` | `afterAll` | 清理临时仓库 |
| `tests/unit/p62/pr4a-artifact-verifier.test.ts:145` | `afterAll` | 清理 |
| `tests/unit/eval/attestation-target-record-source.test.ts:51` | `afterAll` | 清理 |

**已从 vitest 源码确认这两个默认值**（`node_modules/vitest/dist/chunks/coverage.DfSpMS-b.js:3921-3922`）：

```js
resolved.testTimeout ??= resolved.browser.enabled ? 15e3 : 5e3;   // 5000ms
resolved.hookTimeout ??= resolved.browser.enabled ? 3e4 : 1e4;    // 10000ms
```
即 `testTimeout` 已被提到 30s，而 `hookTimeout` **仍是默认 10s**——两条预算现在不同步。

**本轮未观测到 hook 超时**（8 门全绿、两次独立复跑全绿），所以这是**风险而非缺陷**。但 `evidence-gates` 的 `afterAll` 要串行 `rmSync` 24 个含 `.git` 的临时目录，正是最容易在满载下越过 10s 的那一类。**建议**：与 `testTimeout` 同批显式声明 `hookTimeout`（例如 `30_000`），把这条暴露面也关掉；或至少在配置注释里说明"hook 仍走 10s 默认"。

#### 不构成反对的一点说明

30s 相对 5s 是 6 倍放宽，会不会掩盖真正的慢测试？我的实测给出上界：修复后最慢的单条用例是 **5821ms**（`attestation-target-record-source` 的 R-06 用例，在 p62+该文件的小规模并行下），30s 对它有约 5 倍余量。同时 `check:docs` 与主 CI job 的 30 分钟上限仍在兜底。**因此 30s 是可辩护的**；但我建议**这个数字应当由"实测最慢值 × 安全系数"推出并写进注释**，而不是仅声明"足够"——目前注释没给实测依据。

> 附带一个反直觉的实测（值得记录）：同一个 5821ms 用例，**在单文件隔离下用 `--testTimeout=5000` 跑是 PASS 的**（`5 passed`）。也就是说 5s 下它单独跑不红、只有叠加 p62 其余文件的负载才越线。这再次说明**负载是变量、用例本身不是**，也说明任何"这条用例耗时 X 秒所以安全/不安全"的静态判断都不可靠。

### 11.5 `check:docs` 的失败信息不足（门禁设计正确，报错需改进）

**这是本轮最值得下一个人知道的一条**，按 lead 要求正式登记。

**现象**：`pnpm run check:docs` 在命中 flake 时输出的**最终错误行**是：

```text
[docs-verify] Unexpected error during verification: Error: Command failed: pnpm exec vitest run --reporter=json --outputFile="…/dsh-evo-test-results-*.json"
    at execSync (node:child_process:988:15)
    at main (…/scripts/verify-readme-counts.mjs:386:7)
```

它说的是"验证过程中出现**意外错误**"，**读起来像文档门禁自身崩溃**；真实原因却是**内层 vitest 有 1 条测试超时**。这两个原因的处置方向完全相反（一个要查门禁脚本，一个要查测试稳定性），因此这条错误信息**有误导性**。

**门禁设计本身是正确的**：`scripts/verify-readme-counts.mjs:371-392` 的语义是"内层跑一次 vitest → 报告含 failed/pending 就**拒绝**用这份报告比较计数"（ADR 0005 F-14）。在 flake 情况下拒绝比较是**正确的 fail-closed**——它避免了"用一份失败的运行去铸绿计数"。**问题只在错误信息，不在判据。**

**根因（代码级）**：第 386 行的 `execSync(...)` 未捕获非零退出；vitest 在有失败用例时退出码为 1，`execSync` 直接抛 `Error: Command failed`，被外层 `main()` 的通用 catch 捕获并原样打印，**于是"测试失败"被降级成了"意外错误"**。

**修法（廉价，且能复用已有的正确诊断）**：vitest 在**有失败用例时仍然会把报告文件写出来**——这一点我实测确认过：t12 期间 `%TEMP%\dsh-evo-test-results-*.json` 里 `numFailedTests: 1` 是可以正常解析的。所以只需：

```ts
// scripts/verify-readme-counts.mjs:386 附近
try {
  execSync(`pnpm exec vitest run --reporter=json --outputFile="${normalizedTemp}"`, { cwd: rootDir, stdio: 'inherit' });
} catch {
  // 非零退出不是"意外"：报告文件通常已经写出，交给下面的
  // numFailedTests > 0 分支给出具名诊断（"Refusing to verify … against a failing run"）。
  if (!fs.existsSync(tempReportFile)) throw new Error('inner vitest run failed and wrote no report');
}
```

这样 flake 会走到**已经实现好的**第 394-400 行正常路径，输出：

```text
[docs-verify] FAIL: the consumed report carries 1 failed test(s). Refusing to verify README counts against a failing run.
  - failed: PR-1 encoding-policy gate distinguishes the tracked state from the untracked state on IDENTICAL policy bytes
```

—— **直接点名失败的用例**，读的人立刻知道该查测试稳定性而不是文档门禁。我已验证这段输出确实由 `--report` 路径产生（t12 §3.4 反向实验）。

**给下一个人的一句话**：若看到 `check:docs` 输出 `Unexpected error during verification`，**先看内层 vitest 有没有红**（`stdio: 'inherit'` 会把内层输出打在上面），不要先怀疑 README 或计数逻辑。

### 11.6 我在 t12 报告中的一处错误（自我更正）

> **反向指针（与 §6.3 / §7 双向）**：本条更正对应 **§6.3 的 T-3 行**与 **§7 残余风险表的 R5 行**；那两处已各加一句同址指针指回本节。
> 只有单向链（错误 → 更正）时，从本节读起的读者会误以为原处已干净——**双向指针才能让任何入口的读者都看到矛盾存在**。

t12 报告 §6.3 的 **T-3** 声称"`p4-a-adr-mount.md` §3 写的 `tests/unit/jitrl/mount-scope-isolation.test.ts` 不存在，实际在 `seams/`"——**这条是错的**。

证据：该文件 `LastWriteTime = 2026/10/29 12:45:16`，**早于我本轮开工时间（16:40）**；文件大小 16061 B 与我读取时一致；第 46、54、79 行从一开始写的就都是 `tests/unit/seams/mount-scope-isolation.test.ts`。

因此正确结论是：**我在 t12 期间误读了那一行**（该表相邻两行分别指向 `seams/mount-scope-isolation.test.ts` 与 `jitrl/scope-registry-identity.test.ts`，我混淆了行归属），而不是"报告有错"或"快照过期"。lead 说"已过期"是把我的错误往时间上解释，我不接受这个归因——**这是我的读取错误，应由我更正，不应记在文件头上**。

**这件事的教训（也是给我的）**：我这一轮反复用"时点漂移/时序快照"解释观测差异，而这一次的真正原因是**我自己的读取错误**。"快照"是一个容易被滥用的解释——它能让任何矛盾都显得无害。判定"别人写错了"之前，应当先核对**文件 mtime 是否晚于我的读取时刻**，这一步我这次没做。

### 11.7 收尾判定

| 项 | t12 | 收尾复核后 |
| --- | --- | --- |
| 8 条门禁 | 6 绿 / 2 红 | **8/8 全绿**（两次独立复跑一致） |
| 原 2 条红 | 同一根因（全局 testTimeout 5s 不足 + F-14 下游） | **均已消失**；根因修复方式与我的决定性实验一致 |
| T-1 / T-2 / T-3 | 登记为待处置 | **T-1 删除（理由更强）、T-2 删除、T-3 更正为我的误读** |
| 新增待办 | — | ①`vitest.config.ts` 注释"10-minute"应为 30-minute；②`hookTimeout` 仍默认 10s（残余暴露面）；③`check:docs` 错误信息应具名化（§11.5） |
| "需授权未执行" | A1–A6 | **不变**（见 §8）；本收尾全程仍零真实付费调用、零真实宿主 smoke、零 commit |

**结论**：t12 的两条红已如实消除，且不是靠放宽判据、不是靠 skip、不是靠调数字——是修了真正的根因（全局超时预算），并同时删除了两个会稀释分母/污染工作树的遗留项。**8 门可以按绿收尾**；§11.4 的两条保留意见与 §11.5 的报错改进建议应在下一次触碰相关文件时一并处理。
### 11.8 增补：一次"证据范围被放大"的事故（R-04 数据损失与无效哈希）

> 本节由 lead 明确要求写入，并指定包含其自述段落。它是本轮**最值得留给下一轮**的材料，因为它记录的不是一个 bug，而是一种**验证方法的失效**——而且发生在写"证据纪律"的过程之中。
> 本节只做追加，不改变 §11.7 的收尾判定（8 门仍为绿）。

#### 11.8.1 事件

lead 在 t14 验收后，为了给我提出的"rethrow 分支无测试覆盖"这一**低风险缺口**加一条棘轮测试，需要做负控制。他使用的还原命令是：

```bash
git checkout -- scripts/verify-readme-counts.mjs
```

本轮**全程零 commit**，因此这条命令回滚的是**整个文件的全部未提交改动**——包括 leftovers 交付的 R-04 实现（`Counts close` 三方闭合 + `unattributed-root` 测试根归属，见 §6.2 与 `p2-r-leftovers.md` §4）。那段代码从未被提交，所以在 git 眼里它就是"垃圾"。

**后果**：`check:docs` 的 R-04 断言静默消失，`readme-default-leaves.test.ts` 中 3 条测试转红。若没有跑测试就宣布收尾，**团队会交付一个丢失 R-04 的仓库，而报告里仍写着"R-04 已落地"**。

lead 随后按 `p2-r-leftovers.md` §4.1 的**描述**逐条重写恢复了 R-04（不是凭记忆，但也不是原始字节）。

#### 11.8.2 我对恢复结果做的独立验证（不采信"已恢复"自述）

因为恢复是**按描述重写**而非字节还原，我做了功能验证而非文本对照：

| 验证项 | 输入 | 实测 | 判定 |
| --- | --- | --- | --- |
| 第三方测试根必须失败并点名 | 含 `C:/x/tests/integration/b.test.ts` 的报告 | exit 1；`FAIL: 1 test file(s) live outside the documented test roots (/tests/unit/ | /tests/e2e/)` + `- unattributed-root: …` | ✅ |
| 干净报告必须打印闭合行 | 仅 unit + e2e 的报告 | `✓ Counts close: unit + e2e == total on the README side and the report side…` | ✅ |
| 闭合断言条数 | 源码 | `closureErrors` 六处 push（:529/:534/:539/:544/:549/:554）+ `FAIL: count closure:` | ✅ 与 leftovers 描述 6 条吻合 |
| **额外对抗（我自加）** | `C:/x/tests/unit-evil/a.test.ts` | 被正确拒绝并点名 | ✅ 非天真子串放行 |
| rethrow 守卫结构 | 源码索引 | catchIndex=14008 < guardIndex=14412 < throwIndex=15258 < readIndex=15436 | ✅ 守卫严格在 catch 内且在 `readFileSync` 之前 |

**8 门在当前树全部 exit 0**：tsc=0 | vitest=0（127 files / **2429 tests**）| check:docs=0（fully green）| encoding=0 | build-smoke=0 | negative-result=0（A1..A6 PASS）| guarded-regression=0 | mutation=0（verdict: PASS）。

> **结论**：**R-04 在功能上确实恢复了**。数据损失没有传导到交付面。

#### 11.8.3 那条哈希：一次"证据范围被放大"

lead 向团队披露事故时，附了这样一条证据：

```text
sha-before: 527866D943F90260E0FD1F3F500DD79079DF5B1D9F9272E7FA61D497774EAE22
sha-after:  527866D943F90260E0FD1F3F500DD79079DF5B1D9F9272E7FA61D497774EAE22
BYTE-IDENTICAL: True
```

语境是"**证明我没有损坏文件**"。我复现不出来。当前文件实测：

```text
file:   scripts/verify-readme-counts.mjs
bytes:  27256
sha256: 4ca0bd1dc619d382e86dbba247c23a3d85a70caee5b6c7aeddfe8a51404ef362
cr-count: 0  (LF-only, no CRLF confusion)
```

我用三种独立实现交叉确认（PowerShell `Get-FileHash` / node `crypto` / 字节长度与 CR 计数），三者一致。并排除了编码形态的干扰：CRLF 变体 = `4EFFB212…`（27906 B）、BOM 变体 = `1F50F94D…`（27259 B）、当前 LF = `4CA0BD1D…`（27256 B）——**没有一种是 `527866D9…`**。另扫描 `work/` 与 `%TEMP%` 下全部 20–40 KB 文件，无一命中。

**lead 的归因（已确认）**：`527866D9…` 是"**try/catch 已加、R-04 尚未恢复**"那一版字节的哈希。它**不是最终交付物的哈希**。

因此那条证据实际证明的是：**"我备份的那份 == 我还原回的那份"**——这对它**自身的用途**（证明变异被撤销）是**有效的**；但它**不覆盖最终交付物**，而它被写进披露时的语境是"证明我没有损坏文件"。

> **这就是问题的全部**：一条只覆盖"某中间态自洽"的哈希，被赋予了一个它不拥有的范围。**而这件事发生在团队正在讨论"证据必须覆盖它声称覆盖的东西"的同一轮里，且是在最核心的那条证据上。**

#### 11.8.4 正确的证据形式

负控制若要留下可复算证据，必须**在同一时刻、同一条命令下**取得三者并显式声明其相等：

```bash
# 1) 变异前：备份并记录
cp  <target> <backup>
sha256sum <backup>                      # sha-before

# 2) 变异 → 跑测试（确认红，且确认变异真的生效）

# 3) 从备份按字节还原，再记录
cp  <backup> <target>
sha256sum <target>                      # sha-after（应从备份还原，不是"看起来一样"）

# 4) 同一时刻再取一次最终交付物
sha256sum <target>                      # sha-final —— 必须与 sha-before 相同
```

**判据：一条哈希证据只有在"变异前副本 / 还原后文件 / 最终交付物"三者在同一时刻取到且相等时，才配称为"没有损坏文件"的证明。** 若三者不在同一时刻取，它至多证明"某一中间态自洽"。

#### 11.8.5 影响与不影响的边界

| 项 | 状态 |
| --- | --- |
| 负控制本身的结论（变异已被撤销） | **不变**——否则测试不会在还原后立刻转绿 |
| 该负控制的**证据形式** | **作废**（覆盖范围与声称范围不符） |
| R-04 是否恢复 | **已恢复**，经 §11.8.2 功能验证成立 |
| 8 门是否绿 | **是**，全部 exit 0 |
| 交付物是否受损 | **未受损**（但这一点现在由"功能验证 + 8 门"支撑，**不由那条哈希支撑**） |

#### 11.8.6 一条可复用的判据（本节的主要产出）

> **任何哈希证据必须附「命令 + 取样时刻」，并且能被第三方在最终树上用同一条命令复现。达不到这三条中任意一条的哈希，只能作为过程记录，不能作为交付证明。**

附带的团队规则（lead 已采纳并把它排为规则 1，原三条顺延）：

1. **前置检查**：负控制前先 `git status -- <file>`。**破坏性的范围不由"你正在编辑什么"决定，而由"文件里还藏着什么"决定。** 本轮零 commit 意味着每一次 `git checkout --` 都是一次不可恢复的删除。
2. 负控制只允许"副本 + 按字节还原"；禁止对未提交文件使用 `git checkout --` / `git restore` / `git stash`。
3. 变异必须先验证"变异真的生效了"（目标字符串在新内容中不存在），而不是只看测试有没有红——**"测试没红"可能是变异没生效，也可能是守卫没被覆盖，两者含义相反**。
4. 改门禁/脚本后，先跑它自己的测试套件，再做别的。

#### 11.8.7 关于"要不要把小缺口都补上"

lead 最初的结论是"把小缺口都补上本身也可能是错误判断"。我不同意这个表述，并提出了更精确的版本，lead 已采纳：

> **缺口从来不是问题，工具选择才是。** 我提出的"rethrow 分支无测试覆盖"本就是**低风险、明确标注不阻塞收尾**的缺口，它本来就允许"记下来、不现在补"。若用"副本 + 按字节还原"，这个缺口能以**零数据损失**的代价补上。把结论说成"不该补小缺口"会让下一轮对**任何**小缺口都倾向于不记录——那是另一种损失。

#### 11.8.8 本节的一句话

lead 要求把他这段话带上，我原样引用：

> 『一条自述证据被第三方复现不出来』的价值不在于抓到队长犯错，而在于它示范了**证据的有效范围必须由取证者自己声明，并接受第三方用同一命令复现**。

我补一句作为验证者的对称义务：**我也必须接受同样的检验。** 本节 §11.6 记录的正是我自己的一次同类错误（把相邻两行的归属搞混，却用"时点漂移"去解释它）。**验证者不因为站在验证的位置就免于被验证。**
