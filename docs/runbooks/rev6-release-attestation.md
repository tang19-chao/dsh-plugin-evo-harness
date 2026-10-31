# Runbook：rev6 R0 提交、证明与远程 CI（**只准备，不执行**）

- **适用任务**：t8（R0-1 / R0-2 / R0-3），以及任何需要把本地全绿变成「可复核的提交证据」的人（t14 验证、t26 集成都引用本文件）
- **冻结基线**：`HEAD = 97e38db37305b24f695a5f989428b3611f84987c`（rev5 交付未提交，G12）
- **本文件的一个句子**：`commit` / `push` **本轮未授权**（契约 §6.2 N-1）。本文件只给**可执行计划 + 判据 + 反例**，让人在被授权后照做，或证明「为什么现在还不能说已提交/已被证明」。
- **实测时刻**：2026-10-31T02:04–02:20（+08:00）

---

## 1. 为什么需要这份 runbook（三个已发生的真实故障）

| # | 故障 | 机器证据 | 本文件如何防 |
| --- | --- | --- | --- |
| F-1 | 「本地全绿」被当成「远程 CI 绿」 | 本轮**没有任何**远程 job 记录；`work/t7/rev6-gate-log.json` 全是本机命令 | §4 判据 A 明确写「远程未核实」，出现「远程 CI 绿」表述即失败 |
| F-2 | 旧 attestation 被当成「HEAD 已被证明」 | `final-attestation.json` 描述 `1b7920ee…`；`--expect-commit 97e38db` → exit 1 `attestation-target-mismatch`；`--strict` → exit 1 `attestation-head-mismatch` | §3 的两阶段 C1→C2，且把两条 exit 1 写成**正当的**准备态证据 |
| F-3 | 代码与证明混在一个提交 | `check-attestation-target.mjs` 的 T3 判据 `attestation-evidence-impure`（record-only 才对） | §3 的纯度硬约束 + `Attestation-Target: first-parent` trailer |

---

## 2. R0-1：提交已审核交付（计划，不执行）

### 2.1 提交路径集 = rev5 的 74 路径（可执行分类）

```powershell
node work/t8/r0-plan.cjs            # exit 0 = 每个 status 行都归类了；写 work/t8/r0-plan.json
git status --porcelain=v1 -uall     # 人工复核
```

本轮实测（2026-10-31T02:11+08:00）：

| 桶 | 数量 | 含义 |
| --- | --: | --- |
| rev5 交付路径（73 受测 + `rev5-final-integration.md`） | **74** | 都在 status 里出现，全部有内容改动或未跟踪 |
| 其中出现在当前 `git status` 的 | 74 | **0 遗漏、0 缺失**（`holes=0`） |
| rev5 74 中已在 HEAD 中且无改动 | 0 | 说明 74 条都要进提交 |
| **rev6 新增/改动（不属于这 74 条）** | 8 | 见 §2.2，**单独一提交**，不计入 74 |

> `r0-plan.cjs` 故意**不**决定提交什么；它只把「74 条 vs rev6 新增」分开，防止把新工作折进已审字节里。

### 2.2 rev6 新增必须单独成提交

`work/t8/r0-plan.json` 的 `rev6Additions`（本轮实测 8 条，会随后续任务增长）例如：

- `docs/adr/0002-…md`、`src/runtime/execution-profile.ts`（R0-3 的一行替换）
- `docs/reports/REV6-IMPLEMENTATION-CONTRACT.md`、`docs/reports/host-smoke-rc3.md`
- `scripts/host-smoke/apply-context.mjs`(+`.d.mts`)、`tests/e2e/host-smoke/{apply-context,branch-identity}.test.ts`

理由：rev5 的 74 条是**已审字节**，其中的每一条都要能对得上 `work/t23/snapshot.csv` 的 sha256；rev6 改动是**新的主张**，单独提交才能在出问题时按提交回退，而不是把「哪几个字节是谁改的」混在一次提交里。

### 2.3 提交前门禁清单（逐条 exit code，缺一不可）

```powershell
pnpm run typecheck                       # 期望 0
pnpm exec vitest run --reporter=json --outputFile work/t8/final-vitest.json   # 期望 0，success=true
pnpm run check:docs                      # 期望 0（计数与配置参考）
pnpm run check:encoding                  # 期望 0（只查 HEAD blob，见 §5）
pnpm run check:build-smoke               # 期望 0（构建 + ESM 冒烟 + 新鲜度）
pnpm run check:negative-result           # 期望 0（A1..A6）
pnpm run guarded-regression              # 期望 0
pnpm run check:mutation                  # 期望 0
pnpm run attest:verify                   # 期望 0（历史自洽，**不是** HEAD 绑定）
node scripts/eval/check-attestation-target.mjs --json   # 期望 targetOk/ verdict 见 §3
node scripts/eval/check-clean-tree.mjs --json           # 提交前 **期望 exit 1**（见 §5）
node work/t7/freeze67.cjs                # 期望 0：67 条冻结路径零漂移
node work/t8/check-c4.cjs                # 期望 0：C-4 已应用且 pin 未动
```

### 2.4 提交分组与顺序（建议）

| 顺序 | 提交内容 | 消息草案 | 为什么不合并 |
| --: | --- | --- | --- |
| 1 | rev5 的 **74 路径**（`git add` 逐条，或按 `work/t23/snapshot.csv` 的 73 + 报告） | `feat(p2-p6): integrate rev5 verified delivery (74 paths)` | 这是已审交付；单独落定后 `check:clean-tree` 才可能转绿，且 C1 必须是一个**普通**代码提交 |
| 2 | rev6 新增（§2.2 集合，随任务增长） | `feat(rev6): <topic>`（一个主题一个提交） | 新主张不被折进已审字节 |
| 3 | 证明记录（**仅** `docs/reports/final-attestation.json`） | 见 §3.3，末段 trailer 逐字符 `Attestation-Target: first-parent` | T3 纯度：混入代码即 `attestation-evidence-impure` |

**授权点**：以上 3 条都要**用户显式授权**才可执行（N-1）。本 attempt 一条都没执行。

### 2.5 本轮实测的门禁扫描（17 条，一次连续执行）

完整记录：`work/t8/gate-sweep.json`（命令、真实退出码、起止时刻、耗时、首末行、关键判定行）。**`mismatches = 0 / 17`**（每条的实测退出码都等于它自己的判据期望）。

| 门 | 命令 | 实测退出码 | 期望 | 判读 |
| --- | --- | --: | --- | --- |
| typecheck | `pnpm run typecheck` | 0 | 0 | PASS（10.1s） |
| docs-only | `node scripts/verify-readme-counts.mjs --docs-only` | 0 | 0 | 配置参考 78/78 绿 |
| encoding | `pnpm run check:encoding` | 0 | 0 | 403 tracked blobs 全 LF 或显式例外 |
| build-smoke | `pnpm run check:build-smoke` | 0 | 0 | 构建 + ESM 导入 + `stale:false` |
| negative-result | `pnpm run check:negative-result` | 0 | 0 | A1..A6 PASS，5 个最小反例仍在 |
| guarded-regression | `pnpm run guarded-regression` | 0 | 0 | publish/memory 全 mode 仍 deny |
| mutation | `pnpm run check:mutation` | 0 | 0 | M1–M4 全 KILLED，`worktree zero-residue: OK` |
| attest-verify | `... final-attestation.mjs --verify <record>` | 0 | 0 | 历史自洽（**不是** HEAD 绑定） |
| attestation-target | `node scripts/eval/check-attestation-target.mjs --json` | 0 | 0 | `mode=ordinary`，`targetOk=true`；见 §3.5 |
| clean-tree | `pnpm run check:clean-tree` | **1** | **1** | 预期红：74 路径未提交 |
| attest-expect-commit-HEAD | `... --verify <record> --expect-commit 97e38db…` | **1** | **1** | `attestation-target-mismatch` |
| attest-strict | `... --verify <record> --strict` | **1** | **1** | `attestation-head-mismatch` |
| docs-full | `pnpm run check:docs` | **1** | **1** | 计数比对红（G6 归 t26），见 §5 |
| freeze67 | `node work/t7/freeze67.cjs` | 0 | 0 | 67 条冻结路径零漂移 |
| check-c4 | `node work/t8/check-c4.cjs` | 0 | 0 | 操作性判据 0 命中、严格超越 2/2、pin 完整 |
| dr-hash-check | `node work/t20/dr-hash-check.cjs` | 0 | 0 | 6 个 DR 指纹与 CSV 逐字符一致 |
| r0-plan | `node work/t8/r0-plan.cjs` | 0 | 0 | 74 路径全在 status 中、`holes=0` |

---

## 3. R0-2：两阶段 attestation（C1 → C2，**只准备**）

### 3.1 为什么必须两阶段

记录描述的是**产生它的那个提交**。若把记录和代码放进同一提交，记录描述的提交就含记录本身 → 自指，无法证明任何东西。所以：

- `C1` = 代码提交（普通提交，不含 `final-attestation.json` 的改动）；
- `C2` = **只**提交证明记录（`record-only`），其父 `C2^1` 必须 `== C1`。

### 3.2 执行序列（被授权后照做）

```powershell
# 阶段 1：在 C1 上生成绑定 C1 的 canonical record
$C1 = git rev-parse HEAD                       # 必须是第 1 组提交落定后的 HEAD
pnpm run attest -- --expect-commit $C1         # 写 docs/reports/final-attestation.json

# 阶段 2：只提交这条记录 → C2，消息末段 trailer 逐字符：
#   Attestation-Target: first-parent
git add docs/reports/final-attestation.json
git commit -F <msgfile>                        # 消息以空行 + 该 trailer 结尾
$C2 = git rev-parse HEAD

# 阶段 3：三处交叉验证
node scripts/eval/final-attestation.mjs --verify docs/reports/final-attestation.json --expect-commit $C1
node scripts/eval/check-attestation-target.mjs --json
git rev-parse "$C2^1"                          # 必须 == $C1
```

### 3.3 判据（逐条可执行）

| # | 判据 | 期望 | 失败原因码 |
| --- | --- | --- | --- |
| A-R0-2-1 | `final-attestation.mjs --verify <record> --expect-commit $C1` | exit 0 | `attestation-target-mismatch` |
| A-R0-2-2 | `check-attestation-target.mjs --json` | exit 0 + `mode=evidence` + `targetOk=true` + `record.commitId == C2^1` | `attestation-evidence-impure` / `-merge` / `-stacked` / `-record-missing` |
| A-R0-2-3 | 报告同时写明 `C1`、`C2` 与自指边界 | 文本齐备 | 出现「旧记录 verify 0 ⇒ HEAD 已证明」即失败 |
| A-R0-2-4 | **本 attempt 的准备态证据** | 见 §3.4 | —— |

### 3.4 本 attempt 的准备态证据（已实测，正当的红）

| # | 命令 | 退出码 | 关键输出 | 时刻 |
| --- | --- | --: | --- | --- |
| P-1 | `node scripts/eval/final-attestation.mjs --verify docs/reports/final-attestation.json --expect-commit 97e38db37305b24f695a5f989428b3611f84987c` | 1 | `attestation-target-mismatch`：记录描述 `1b7920ee…`，不是 HEAD | 02:20 |
| P-2 | `node scripts/eval/final-attestation.mjs --verify docs/reports/final-attestation.json --strict` | 1 | `attestation-head-mismatch`：HEAD `97e38db…` 未被该记录描述 | 02:20 |
| P-3 | `pnpm run attest:verify` | 0 | 历史自洽通过 + informational 明写「不覆盖检出修订」 | 02:20 |
| P-4 | `node scripts/eval/check-attestation-target.mjs --json` | **0** | `mode="ordinary"`, `targetOk=true`, `ok=true`；`notes[0]` 逐字：`ordinary: HEAD 97e38db… is NOT covered by this record; the record binds its own commit 1b7920ee… only`；`record source: worktree bytes == HEAD blob cf8fb513… (sha256 ad0dfb3b…)` | 02:21 |

**这两条 exit 1 是「不伪造证明」的机器证据**，不是本任务的失败：记录只描述它自己的提交，而 rev5 的 74 路径从未提交。任何把 P-1/P-2 写成 pass 的报告都是造假。

### 3.5 关于 `check-attestation-target` 的当前读数

实测（2026-10-31T02:21+08:00，`node scripts/eval/check-attestation-target.mjs --json`，exit 0）：

| 字段 | 值 | 读法 |
| --- | --- | --- |
| `mode` | `"ordinary"` | HEAD 是普通提交（无 `Attestation-Target` trailer） |
| `targetOk` / `ok` | `true` / `true` | 这是**普通提交**路径的自洽判定，**不是**「HEAD 已被证明」 |
| `recordedCommitId` | `1b7920ee…` | 记录绑定它自己的提交 |
| `parentCommitId` | `null` | 普通提交路径不派生父提交 |
| `notes[0]` | `ordinary: HEAD 97e38db… is NOT covered by this record; the record binds its own commit 1b7920ee… only (self-consistency + ancestry, ADR 0005 §1.3 T0)` | **逐字否证**「HEAD 已被证明」 |

关键区分：`ok=true` 在这里的含义是「记录**关于它自己的提交**是自洽的」，而 `--expect-commit` / `--strict` 才是「记录是否关于**指定目标**」的轴（本轮两者都 exit 1，见 P-1/P-2）。把 `ok=true` 读成「HEAD 已被证明」正是 N-5 禁止的表述。只有 C2 阶段（`mode=evidence` + `targetOk=true` + `record.commitId == C2^1`）才构成目标绑定。

---

## 4. 远程 CI（**未核实**，不得声称绿）

| 项 | 本轮状态 |
| --- | --- |
| 远程 job 记录 | **none**（未 push，故不存在） |
| 「Typecheck and test」job | `not-run` |
| 「Node 24 compatibility」job | `not-run` |
| 可否声明「远程 CI 绿」 | **否**（N-5）。任何此类表述即失败 |

被授权 push 后，远程判据是：两个 job 通过 **且** 远程测试数与本次提交前绿色 JSON 一致。**本地绿不能替代远程绿**。

本轮实测的提交前绿色 JSON（rev6 新增测试已计入，2026-10-31T02:33+08:00）：

| 项 | 值 |
| --- | --- |
| 文件 | `work/t8/final-vitest.json`（1,006,613 B，sha256 `a49246406b6acfbd836f21b6a7dc4bd3e49d89dda6af98cb71cee0ec54f07cb2`） |
| suites / tests | **810 / 2803**，`passed=2803`，`failed=0`，`failedSuites=0`，`pending=0`，`todo=0`，`success=true` |
| 逐文件口径 | unit **136 files / 2561 tests**；e2e **20 files / 242 tests**；合计 **156 files / 2803 tests**（从 JSON 的 `testResults` 逐文件归属算出，与 `check:docs` 的归属规则一致） |
| README 当前声明 | **150 files / 2727 tests**（rev5 值）⇒ `check:docs` 计数比对**红**（见 §5），这是 G6 规定的「由 t26 用同一次绿色 JSON 一次收口」，**不是** t8 的失败，也不授权 t8 改 README |
| 配置参考 | 78 documented vs 78 expected（`--docs-only` exit 0） |

---

## 5. 「预期非绿」，别修

| 门 | 提交前期望 | 为什么这是正确的 |
| --- | --- | --- |
| `check:clean-tree` | **exit 1**（`trackedChanges>0`, `unexpected>0`） | 74 路径未提交。它只在 CI/显式命令里跑，**不在** `pnpm run verify`；提交落地后才允许转绿 |
| `check:docs`（全量，计数比对） | **exit 1**（`Summary test files mismatch: README has 150, Vitest has 155` 及 7 条同类） | G6：实现任务**不得**手改 README 计数行；必须由 t26 用**一次绿色 JSON**一次收口。t8 新增了 2 个测试文件（`tests/unit/p62/rev6-release-contract.test.ts` 8 例、`tests/unit/runtime/execution-profile.test.ts` 6 例），计数必然暂时不一致；`--docs-only`（配置参考）**exit 0** 证明叶子集没坏。注：该数字（155/2797）来自一次**含并发任务在途**的采样；权威口径以 `work/t8/final-vitest.json` 的 156 files / 2803 tests 为准 |
| `check:encoding` | exit 0，但**只看 HEAD blob** | 未提交的新文件不在判据内（G11）。提交前需自行保证 LF（本文件与 rev6 新文件均已 LF、无 BOM） |

`check:clean-tree` 的 allow list 只允许生成物（`test-results.json`、`lib/`、`attestation.json`、`coverage/`），任何能覆盖 `src/`、`tests/`、`scripts/`、`package.json` 的规则都会被**先**拒绝。

---

## 6. 授权边界（照抄契约 §6，避免误读）

**已授权**：本地实现/验证；聚合门；只读宿主采集；新建 rev6 文档。
**未授权（做即失败）**：`commit`/`push`/tag（N-1）；真实记忆写入（N-2）；`guarded-active`（N-3）；publish（N-4）；声明远程 CI 绿或「HEAD 已被证明」（N-5）；改写历史负结果（N-6）；Arm-5/伪独立样本（N-7）；无 measured cacheRead 就宣称 Tail Injection 收益（N-8）；`src/**` 引入 `memoryRealWrites:true`（N-9）；mock/estimated 冒充真实收益（N-10）。

---

## 7. 本 attempt 的实际动作（诚实边界）

- **未** `git add` / `commit` / `push` / tag；`HEAD` 仍 `97e38db…`。
- **未**为脏工作树生成或改写 `final-attestation.json`（`ad0dfb3b…` 未变）。
- **未**声明远程 CI 或「HEAD 已被证明」。
- 已落盘的写入只有：`docs/adr/0002-…:51`、`src/runtime/execution-profile.ts:121`（R0-3 两行，各 1 行替换）、`docs/reports/p0-evidence-correction.md`（C-4 状态改述 + E-9…E-12 证据行）、`tests/unit/p62/docs-correction-pointers.test.ts:70`（断言翻转）、本文件、`tests/unit/p62/rev6-release-contract.test.ts`（新，8 例）、`tests/unit/runtime/execution-profile.test.ts`（新，6 例）与 `work/t8/**` 证据。
- **未**触碰任何 §3 受保护字节：ADR 0007 = `47e67c7d…`、`final-attestation.json` = `ad0dfb3b…`、rc1 blob `932f80da…`、rc2 `d62bc9f5…`、`jit-active-policy.ts` = `c9443123…`、`rev5-final-integration.md` = `3c785ee7…` 全部未变；`README.md` 仍 `fc8987c0…`（DR-6 只属 t26）。
- 漂移集实测 ⊆ DR-1..DR-6：`docs/reports/p0-evidence-correction.md`、`tests/unit/p62/docs-correction-pointers.test.ts` 为本任务（DR-1/DR-2）；`scripts/host-smoke/{run,in-host}.mjs` 为 t11（DR-4/DR-5）。其余 67 条由 `node work/t7/freeze67.cjs` exit 0 覆盖。
