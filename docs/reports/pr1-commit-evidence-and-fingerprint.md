# PR-1 — 提交证据、跨平台指纹与 CI

| 项 | 值 |
| --- | --- |
| 任务 | t2 `[pr1]` 实施 PR-1 提交证据、跨平台指纹与 CI |
| 冻结基线 | `84a3d828ed2a27eef765c8b9c4950da4a9ee7287`（`9ea9b7e` 之子） |
| 复核基线提交 | `84a3d82` tree `bc25da6a5014223c4e50322c05a61e4e0295663c` |
| 性质 | 离线实施与验证。**未 commit / 未 push / 未发布 / 未部署 / 未发起真实或付费模型调用** |
| 证据口径 | 一律 `git cat-file` 原始 blob 字节或 blob id，**不使用工作树哈希** |
| 平台诚实性 | 本机为 win32/x64（Node v22.23.1、pnpm 11.7.0、git 2.55.0）。**未在本机运行 Linux/macOS**；跨平台等值由 CI 矩阵**测量**，本轮未声称已验证 |

---

## 1. 为什么必须有 PR-1

`work/t1-baseline-audit.md` §5 F-1 记录了一个真实事故：ADR 0003 附录 15 个文件摘要中
**14 个是 CRLF 工作树摘要**。本仓 `core.autocrlf=true`，对象库是 LF、检出是 CRLF，
所以同一提交在 Windows 与 Linux CI 上产出**两个不同的摘要**。ADR §13.2
「对附录 15 个文件重算 SHA-256 前 16 位…与附录逐项一致」因此在 LF 环境**全部不匹配**。

第二个事故是同一类缺陷的另一层：`scripts/eval/negative-result-diag.mjs` 只**打印**结论，
发生漂移仍 `exit 0`——一个永不失败的"门禁"只是显示品。

PR-1 修的就是这两件事：**证据必须来自提交对象**，**门禁必须真的会失败**。

---

## 2. 交付物

| 路径 | 作用 |
| --- | --- |
| `scripts/eval/lib/git-objects.mjs` | 证据核心：提交/树解析、祖先校验、原始 blob 批量读取、编码分类、规范化清单、清单重比 |
| `scripts/eval/lib/git-objects.d.mts` | 手写类型契约（不用全库 `allowJs`，见 §4.3） |
| `scripts/eval/lib/negative-result-assertions.mjs` | A1–A6 纯函数断言（无 shebang、无 TLA、无副作用） |
| `scripts/eval/lib/negative-result-assertions.d.mts` | 同上类型契约 |
| `scripts/eval/final-attestation.mjs` | CLI 重写：`--ref/--base/--out/--allow-dirty/--json` + **`--verify`** |
| `scripts/eval/check-encoding-policy.mjs` | 编码/换行策略门禁（t17：提交绑定——属性与策略文件从被证 commit 读，`--ref` 可选；拒绝未声明 CRLF/BOM/二进制，拒绝全库 renormalize） |
| `scripts/eval/smoke-build.mjs` | 构建 + **真实 ESM import** 冒烟，断言公开面 |
| `scripts/eval/compare-platform-digests.mjs` | 跨 OS 指纹等值规则（t17：≥3 平台、64hex/40hex 形状、fileCount>0 且一致；ship 成模块，故可被测试双向钉死） |
| `scripts/eval/check-encoding-policy.d.mts`, `smoke-build.d.mts`, `compare-platform-digests.d.mts` | 同上类型契约 |
| `.gitattributes` | 声明式内容策略（窄口径，非 `* text=auto`） |
| `.github/workflows/ci.yml` | 三条新门禁 + `attest:verify` + 三 OS 指纹矩阵 + 跨 OS 等值判定作业（t17：SHA 钉、fetch-depth:0、persist-credentials:false、timeout、Windows 腿 smoke/测试） |
| `tests/unit/p62/commit-attestation.test.ts` | 47 测试（t17 +8）：提交权威/原始字节/祖先/无回退/核心-环境分离/编码策略/**§8 策略提交绑定（未跟踪豁免不假通过、bare clone 复验、fallback 等值）** |
| `tests/unit/p62/negative-result-assertions.test.ts` | 21 测试：A1–A6 **每条都有失败用例** + CLI 接线 |
| `tests/unit/p62/evidence-gates.test.ts` | 41 测试（t17 +14）：四个门禁**都双向测**（通过 + 失败），含 10 条跨 OS 等值规则与 verify 全字段篡改判别 |
| `tests/fixtures/encoding/{crlf,utf8-bom,binary,lf-control}` | 显式 `-text` 例外夹具（CRLF/BOM/二进制各一） |
| `README.md` | 计数 86/1666 → 91/1777；新增证据与证明章节、新脚本表 |
| `docs/reports/final-attestation.json` | 按 blob 字节重新生成（schema 1.0.0 → 2.1.0） |

---

## 3. 六条 PR-1 规则与落点

| # | 规则 | 实现 | 测试 |
| --- | --- | --- | --- |
| 1 | **提交对象权威** | `resolveCommit` 用 `<ref>^{commit}`，`commitTreeId` 用 `<commit>^{tree}`；树形/sha 片段 ref 被拒 | §1（7 例） |
| 2 | **原始 blob 字节** | `readBlobsBatch` 走 `git cat-file --batch`；核心模块**不 import `node:fs`** | §2（6 例）+ §7 源码断言 |
| 3 | **显式 ref/base + 祖先校验** | `--ref` 记录 `refExplicit`；`--base` 走 `git merge-base --is-ancestor`，退出码 1 = 非祖先，其他 = 硬错 | §3（4 例，含无关分支） |
| 4 | **禁止静默工作区回退** | 脏 tracked 树默认 `dirty-worktree` 硬失败；`--allow-dirty` 只**记录**缺陷，不进摘要 | §4（4 例，含 `GIT_DIR` 污染） |
| 5 | **核心/环境分离** | `compositeSha256` 只覆盖 `path:blobSha256`；`bindingSha256` 覆盖 `commit+tree+composite`；`environment`（node/platform/arch/时间/worktree）**不参与任何摘要** | §5（9 例，含同内容不同提交的分裂验证） |
| 6 | **编码策略显式** | `classifyBytes` + `git check-attr`；未声明非 LF blob ⇒ `encoding-policy-violation` | §6（6 例，正反双向） |

### 3.1 两个摘要，不是一个

- `compositeSha256` = 内容身份：同一内容不同提交 → **相同**。
- `bindingSha256` = 提交身份 + 内容：同一内容不同提交 → **不同**。

`tests/unit/p62/commit-attestation.test.ts` §5「separates content identity from commit identity」
用真实临时仓证明这一点。若只保留一个摘要，`composite` 就退化成"带内容哈希名字的提交元数据哈希"。

### 3.2 为什么权威树是必需的

只记 `commitId` 的清单，验的人无法脱离本仓代码判断"这个 commit 到底含哪些字节"。
记 `treeId` 后，第三方可自行 `git rev-parse <commit>^{tree}` 并重算，`bindingSha256` 把
"提交 → 树 → 内容"三者在密码学上绑死。`final-attestation.mjs --verify` 正是这条路径的实现。

---

## 4. 实际修掉的三个半成品缺陷

接手时工作区已有 PR-1 半成品（`git status` 显示 2 改 5 新）。逐项复核后发现并修复：

### 4.1 【blocker，已修】证据核心被 `.gitignore` 静默排除

`.gitignore` 的 `lib/` 是**无锚点**模式，匹配任意深度的 `lib` 目录，因此把
`scripts/eval/lib/git-objects.mjs`（PR-1 的核心证据模块）一并忽略了：

```
$ git check-ignore -v scripts/eval/lib/git-objects.mjs
.gitignore:19:lib/    scripts/eval/lib/git-objects.mjs
```

后果：整个 PR-1 的证据核心**根本提交不进去**，而 `final-attestation.mjs` 一 import 就
MODULE_NOT_FOUND。修复为锚定 `/lib/`、`/dist/`、`/coverage/`（构建产物在根，嵌套 lib 是源码），
并在 `.gitignore` 写明理由。修复后 `git status` 正确显示 `?? scripts/eval/lib/`。

### 4.2 【high，已修】`--assert` 对真实报告**误报**（exit 1）

半成品的 A5 规则是 `/(?<![非不未无])已确认根因/`，对真实 H1 verdict
`"…（记录为再校准证据，不当作已确认根因）"` **误判为"宣称已确认根因"**，
实测 `node scripts/eval/negative-result-diag.mjs --assert` → **exit 1**。
即：新门禁在健康的树上就是红的——这会让维护者直接关掉它。

修复为**分句否定**判定（`affirmsConfirmedRootCause`）：只在"含 `已确认根因` 且本句与前一句
均无否定词"时判失败，并补一条**结构性**伴随断言 A5b（`boundaries` 必须仍写明"假设、非已确认根因"），
使文本启发式不是唯一防线。修复后 `--assert` → exit 0，且 A5 的 5 个正反用例全绿。

### 4.3 【high，已修】`typecheck` 红（TS7016 × 2）

半成品测试 import 无类型的 `.mjs`，`strict` 下报 TS7016。两条路：
- `allowJs: true`：实测能消 TS7016，但会把全库 JS 纳入 tsc 推断，**改变所有既有脚本的检查面**
  ——对"证据"主题的 PR 来说爆炸半径过大（已实测后**回退**，`tsconfig.json` 未改动）。
- 手写 `.d.mts`：只声明窄公开面，`tsc` 反过来校验**测试**是否与契约一致。**采用此路**。

### 4.4 【medium，已修】`smoke-build.mjs` 在 Windows 上假失败

`execFileSync('pnpm.cmd', …, { shell: false })` 在 Windows 报 `EINVAL`（batch shim 需要 shell），
于是门禁在"构建其实成功"的机器上判失败。已改为 `shell: process.platform === 'win32'` 并写明理由。

### 4.5 【medium，已修】`--verify` 把"分支已前进"当成失败

初版把记录的 `commit.ref` 重解析后与 `commitId` 比较，分支前移即 MISMATCH。
这是错的：**旧记录必须永远可验**。改为按**记录的 commit id** 重算，ref 前移只写一条
`informational:` 备注，不进 `differences`。同时补了篡改/增行两个失败用例。

### 4.6 【low，已修】`--assert` 的 A3 是空断言

半成品只检查 `counterexample` 是对象，`taskId` 缺失时用 `'<unknown>'` 兜底再判——
永远为假分支。改为检查 `counterexample.replay` 存在且含
`protocol/seed/task/run/round/chosenChoice/priorChoice` 七个可重放坐标。

---

## 5. 门禁（实测，本机，PR-1 交付时点）

> **t17 口径注记**：下表为 PR-1 交付时点的实测快照。其中 `check:encoding` 一行是
> **工作树口径**（`git check-attr` 读磁盘）下的结果；t17 修复后门禁改为提交绑定，
> 冻结基线 `84a3d82` 上如实 exit 1（`attributes-missing`，见 §11.1）。
> 当前实测以 §11.5 为准。

| 命令 | 结果 |
| --- | --- |
| `pnpm run check:encoding`（交付时口径） | **exit 0** — 266 tracked blob 检查，0 未声明非 LF，0 例外 |
| `pnpm run check:negative-result` / `--assert` | **exit 0** — `A1..A6 PASS`；`--json` 模式与 PR-1 前**逐字节一致**（29,047B，SHA-256 相同） |
| `node scripts/eval/final-attestation.mjs --ref 84a3d82… --out …` | **exit 0** — 206 文件、tree `bc25da6a…`、composite `4d90720e…`、binding `f7371407…` |
| `pnpm run attest:verify` | **exit 0** — 重算与记录逐项一致 |
| `node scripts/eval/smoke-build.mjs` | **exit 0** — 968KB 级产物、62 exports、`apply`/`createEvoHarnessPlugin` 可调用、PLUGIN_NAME 匹配 |
| `node scripts/eval/compare-platform-digests.mjs work/_parity` | **exit 0**（三平台一致）/ **exit 1**（单平台摘要被改）—— 规则双向实测 |
| `node scripts/eval-jitrl.mjs --json` | **exit 0** |
| `node scripts/eval/guarded-regression.mjs --json` | **exit 0** — **37/37**（基线 33/33，+4 由并行 PR 追加） |
| `pnpm run test`（全量） | **exit 0** — **92 files / 1810 tests / 0 failed** |
| `pnpm run check:docs` | **exit 0** — README `92 / 1810` 机器校验通过 |
| `pnpm exec vitest run tests/unit/p62/{commit-attestation,negative-result-assertions,evidence-gates}` | **87/87 pass**（39 + 21 + 27），连续 3 次复跑稳定 |
| `tsc --noEmit`（PR-1 范围） | **0 error** — 见 §7，唯一剩余错误属 PR-2 |

### 5.0 测试计数：PR-1 的**可归因增量**

> **计数口径（t17 澄清）**：下表是 PR-1 交付时点（工作树含并行在途 PR）的历史快照；
> 「92 / 1810」混合了队友的并发新增。**PR-1 自身可归因增量固定为 +3 文件 / +87 测试**
> （39 + 21 + 27）。t17 修复轮后三个 PR-1 测试文件的当前实测为 **109**（47 + 41 + 21，
> 见 §11.5），全仓计数以集成轮（t11）最终 pin 为准——本表数字**不**应当作当前值复述，
> 避免与 §11.5 形成内部矛盾。

| 项 | 基线（`84a3d82`） | 交付时实测 | PR-1 增量 |
| --- | --- | --- | --- |
| 文件 | 86 | 92 | **+3**（`commit-attestation` / `negative-result-assertions` / `evidence-gates`） |
| 测试 | 1666 | 1810 | **+87**（39 + 21 + 27） |
| unit | 74 / 1509 | 80 / 1653 | +3 文件 / +87 测试（PR-1） |
| e2e | 12 / 157 | 12 / 157 | 0 |

README 的 `92 / 1810` 是**交付时工作树**的合并态（含并行 PR 的在途测试），
`check:docs` 当时机器校验通过。该数字随队友继续加测试而漂移，
**t11 集成轮必须在全部 PR 落定后重新 pin 一次**。

### 5.0b 一个被我修掉的**间歇性**假失败

`commit-attestation.test.ts` §5「separates content identity from commit identity」初版用
「写 extra.txt → commit → rm → commit」造第二个提交，在并行 worker 下**偶发失败**
（首轮 39/39 通过，第二次 1 失败，单跑又通过）。**flaky 的证据测试比没有测试更糟**——
它会训练人"重跑一下就好"。改为 `git commit-tree <同一 tree> -p <parent>`：
不碰工作树、构造上确定。修后连续 3 次 39/39。

### 5.1 跨平台等值：本机**未**验证，CI 才测量

本机只有 win32/x64。**我没有**也**不会**声称"Linux/macOS 已验证"。可本地复现的**等价性**证据是
`commit-attestation.test.ts` §2「produces the SAME manifest digest from two independent temp checkouts」：
在同一台机器上克隆两份、分别设 `core.autocrlf=true` / `false`、强制重新检出，
断言**工作树字节确实不同**（`crlfWorktree.length !== lfWorktree.length`）而
**composite/binding 摘要相同**。这排除了"摘要依赖检出"这一 F-1 根因，但不等于跨 OS 实测。

CI 的 `fingerprint` 作业在 `ubuntu-latest` / `macos-latest` / `windows-latest` 三个 runner 上
对**同一个 `github.sha`** 重算并把摘要写进 job summary；`fingerprint-parity` 作业下载三份记录，
**摘要不一致即 exit 1**。这才是跨平台的**测量**。t17 收紧了 parity 判定（3 平台缺一不可、
64hex/40hex 形状校验、fileCount>0 且跨平台一致），并在 CI 的 `verify` 作业加入
`attest:verify`——两者的分工见 §9.1 / §11.3。

---

## 6. 编码例外政策（明确边界）

`.gitattributes` **刻意窄**：29 条规则，逐组带注释。明确**不做**全库 `* text=auto`：
那会重写每一个历史 blob、作废所有已记录摘要，并产出无人可审的巨型 diff。
`check-encoding-policy.mjs` 主动**拒绝** `* text=auto` / `* text` / `* -text` 三种全库规则。

例外清单与理由：

| 规则 | 理由 |
| --- | --- |
| `*.ts *.mts *.cts *.mjs *.cjs *.js *.json *.md *.yml *.yaml` → `eol=lf` | 进入 PR-1 摘要的路径；pin 到 LF 才让 `path:sha256` 跨平台一致 |
| `*.sh *.bash` → `eol=lf` | shell 解析器对 CRLF 不容忍 |
| `*.bat *.cmd *.ps1` → `eol=crlf` | Windows 脚本的正确工作树形态 |
| `*.png … *.xlsx` → `binary` | 二进制等价物，永不转换（git 的 `binary` 宏即 `-text -diff`） |
| `tests/fixtures/encoding/**` → `-text` | **显式 BOM/CRLF/二进制夹具**：字节必须逐位保留 |

`tests/fixtures/encoding/` 现新增 4 个夹具（`crlf.txt` 28B、`utf8-bom.txt` 19B、
`binary.bin` 8B 含 NUL、`lf-control.txt` 24B）。前三个由 `-text` 声明确保字节不变，
第四个是对照：即便落在该目录下，LF 文件也无需例外。

> **当前计数为何是 0（不是缺陷，是口径）**：门禁与 attestation 都检视 `HEAD` 的**已提交**树。
> 本轮基线冻结在 `84a3d82`，4 个夹具与全部 PR-1 新文件仍是 `??` 未跟踪状态，
> 因此交付时点 `check:encoding` 报 `266 tracked blobs / 0 exceptions`（工作树口径），
> `docs/reports/final-attestation.json` 的 `tests/fixtures` 条目为 0。
> 提交后它们会各出现一次，且以 `encodingException=true` 形式出现。
> 该行为已被 `evidence-gates.test.ts`「PASSES a declared -text exception and reports it」
> 用真实临时仓证明（1 例外、0 违规）。
>
> **t17 口径升级**：修复后 `.gitattributes` 的存在性与属性答案**都从被证 commit 读**。
> 基线 commit 树里没有该文件，所以现在的 `check:encoding` @ `84a3d82` 如实报
> `attributes-missing` 并 exit 1——磁盘上那份未跟踪副本**不能**再替 commit 背书
> （那是假通过通道，已由双向判别测试钉死）。策略文件随 PR 一起提交后，门禁才会转绿。
>
> **已知边界（如实登记）**：门禁只看已提交树，不看工作树。这意味着**未暂存**的
> 未声明非 LF 文件在本机能过、提交后 CI 才拦。这是刻意的——证据必须描述提交；
> 若让门禁看工作树，它就重新引入了"证据依赖检出"这一 F-1 根因。

---

## 7. 与其他并行 PR 的边界（**重要，供 t11/t12 归因**）

本工作区是**共享工作树**，并行成员同时在改 `src/**`。本轮实测到的失败**均不在 PR-1 范围**，
我**没有**改动队友文件，也**没有**用我的改动覆盖它们：

| 失败 | 所有者 | 依据 |
| --- | --- | --- |
| `tsc`: `tests/unit/verification/quality-provenance.test.ts:17` TS2322（`guidance` 可选性） | **PR-2** | 该文件 `??` 未跟踪，属 quality-engineer；`src/types/contracts.ts` 冻结、我未改 |
| `tsc`: `tests/unit/ledger/pr3a-metering-recovery.test.ts:148,185` 缺 `purpose` | **PR-3A** | 该文件 `??`，属 cost-engineer；`contracts.ts:789 purpose` 冻结、我未改 |
| `tsc`: `tests/unit/dream-rsi/pr4b-holdout.test.ts` TS2305/TS2353/TS7006 | **PR-4B** | 该文件 `??`，属 dreamer-engineer（`createJitWiredDreamer` 未从 `src/dream-rsi` 导出、`NodeSpec` 无 `createdAt`） |
| vitest 8 例：`dream-rsi/{offline-dreamer,jit-dream,dream-rsi-pipeline}`、`jitrl/runtime-control`、`p62/release-contract` | **PR-4B** | `src/dream-rsi/offline-dreamer.ts` 正被 dreamer-engineer 修改（`git diff` 含 `PR-4B (ADR 0004 §4)` 的 holdout 分块），失败断言全部与 holdout/publish 相关；此后 `tests/unit/dream-rsi/*` 亦进入 `M` 状态 |
| `guarded-regression` 第一次 `exit 1`（`MIN_SELECTION_TREES is not defined`），**重跑 exit 0 / 33-33** | **PR-4B** | 首次运行正好撞上队友保存 `offline-dreamer.ts` 的中间态（mtime 12:47:18）；稳定后恢复 33/33 |

**逐步复核记录（避免误判为"PR-1 引起"）**：

1. 12:40 首次 `tsc` → 仅有 ledger/quality 两处，均在新测试文件；
2. 12:47 `guarded-regression` 首次失败 → 12:48 重跑 33/33，说明是保存中间态；
3. 12:56 再 `tsc` → 新增 `pr4b-holdout.test.ts` 三处错误，**同时** `src/dream-rsi/offline-dreamer.ts` mtime 更新；
4. 全程 `git status --porcelain -- scripts/eval/lib scripts/eval/*.mjs tests/unit/p62/commit-attestation.test.ts tests/unit/p62/negative-result-assertions.test.ts tests/unit/p62/evidence-gates.test.ts` 只出现**我的**改动，`src/**` 我一个字节都没改。

**结论**：PR-1 自身三条新门禁 + 81 个新测试 + attest/verify 全部绿；全库门禁的红来自并行 PR 的在途状态，
且随队友提交而移动。**t11 集成轮必须在此全部落定后再跑七门禁**，否则会把并行在途态误记为 PR-1 失败。

---

## 8. 证据指纹（本机，win32-x64）

```
commit   84a3d828ed2a27eef765c8b9c4950da4a9ee7287
tree     bc25da6a5014223c4e50322c05a61e4e0295663c
files    206   (src + tests + scripts)
composite 4d90720eaedda8b48d43fe190bc0f67e6e562da2fc41994bf73a9025500fae3b
binding   f73714075a39cf83d88b6ce28edeac25b36c6bd8763cb759dba12bf01815ee51
```

> **口径变更，必须同步**：`docs/reports/final-attestation.json` 已从 schema 1.0.0
> （`gitHead 9ea9b7e`、206 文件、composite `13c4c3cf…`、工作树哈希）重写为 schema 2.1.0
> （blob 字节、含 treeId 与 bindingSha256）。因此 `docs/P62_STATUS.md:20` 与
> `docs/reports/p62-c11-c2a-closure.md:35` 引用的 `13c4c3cf…` **已作废**。
> 这两个文件按 t1 §7.1 归 **t11/t12** 所有，**我未改动**，请由集成轮更新。
> 历史报告中的旧摘要应标注为"历史快照（工作树口径）"，**不得**重算覆盖——
> 那会篡改历史证据。

---

## 9. 复跑命令（与 CI 实际执行的命令一致）

```bash
# PR-1 三条新门禁（CI verify 作业同款命令）
pnpm run check:encoding          # 提交绑定版：默认 --ref HEAD；冻结基线 84a3d82 上会 exit 1
                                 # （attributes-missing，诚实结论），策略入树后 exit 0
pnpm run check:negative-result   # 即 negative-result-diag.mjs --assert
pnpm run check:build-smoke

# 证据与重验（CI verify 作业新增 attest:verify 步）
pnpm run attest:verify
node scripts/eval/final-attestation.mjs --ref HEAD --out <path> --allow-dirty --json
# 生成正式清单用 pnpm run attest（等价于 --ref HEAD --out docs/reports/final-attestation.json，
# 不带 --allow-dirty：脏树默认硬失败，这是设计而非疏漏）

# PR-1 测试（CI Windows 腿也会跑前两个）
pnpm exec vitest run tests/unit/p62/commit-attestation.test.ts
pnpm exec vitest run tests/unit/p62/evidence-gates.test.ts
pnpm exec vitest run tests/unit/p62/negative-result-assertions.test.ts

# 两次同提交必须给出同一摘要（排除时间戳进摘要）——由
# tests/unit/p62/evidence-gates.test.ts §CLI「recomputes the same digests twice」钉死
```

### 9.1 CI 与本报告的命令对应表

| CI 步骤（.github/workflows/ci.yml） | 命令 | 说明 |
| --- | --- | --- |
| `Check encoding and line-ending policy` | `node scripts/eval/check-encoding-policy.mjs` | 提交绑定（`check-attr --source=<commit>`）；HEAD 含 `.gitattributes` 后为 exit 0 |
| `Verify the recorded commit attestation` | `pnpm run attest:verify` | 与 parity 互补：verify 管「记录是否仍匹配其提交」（单机），parity 管「同一提交跨 OS 重算是否一致」（3 平台矩阵）。verify 通过 ≠ 跨 OS 已测；parity 通过 ≠ 记录未过期 |
| `Build and ESM-import smoke test` | `node scripts/eval/smoke-build.mjs` | ubuntu 腿 |
| `Windows - build and ESM-import smoke test` | 同上 | windows 腿（Windows 曾是 smoke 假失败的故乡） |
| `Windows - PR-1 evidence gates and attestation tests` | `pnpm exec vitest run tests/unit/p62/{commit-attestation,evidence-gates}.test.ts` | windows 腿跑证据测试 |
| `Compute commit attestation` | `node scripts/eval/final-attestation.mjs --ref "${{ github.sha }}" --out attestation.json --json` | 显式 `--ref`（钉到被测 SHA）；不再重定向到第二个文件 |
| `Compare digests across operating systems` | `node scripts/eval/compare-platform-digests.mjs artifacts --json` | minPlatforms=3、fileCount>0、64hex/40hex 形状校验 |

CI 全部 action 以 **40 位 commit SHA** 钉死（checkout/setup-node/pnpm-action-setup/upload-artifact/download-artifact），
checkout 一律 `fetch-depth: 0` + `persist-credentials: false`，各作业有 `timeout-minutes`，
upload-artifact 用 `if-no-files-found: error`——缺一条平台记录在产出侧就报错，而不是等到比较作业报「平台不足」。

---

## 10. 边界声明

- 未 `git commit`、未 `push`、未发布、未部署；未启动真实模型或付费 API 调用。
- 未改动任何历史 ADR（`docs/adr/0003-*.md` 保持原样，其 CRLF 附录作为**历史证据**保留）。
- 未改动 `src/**` 任何文件；`tsconfig.json` 经实验后**已回退**至原状（`git status` 无该文件）。
- 未改动队友文件（`src/ledger/**`、`src/verification/**`、`src/dsh-bridge/**`、
  `src/dream-rsi/offline-dreamer.ts`、`src/config.ts`、各并行测试文件）。
- 未声称除 win32/x64 外的任何 OS 已验证。

---

## 11. 修复轮（t17）追记：提交绑定、verify 全覆盖与 parity 收紧

本轮（t17，attempt 847b43d5）修复独立审查的 Medium 缺陷，改动仍限于 PR-1 范围
（`scripts/eval/lib/git-objects.mjs`、`final-attestation.mjs`、`check-encoding-policy.mjs`、
`compare-platform-digests.mjs`、`.github/workflows/ci.yml`、两个 p62 测试文件、本报告；*.d.mts
类型契约随签名同步）。零 `src/**` 改动。

### 11.1 【medium，已修】编码策略绑定到被证 commit

缺陷：属性答案来自 `git check-attr --stdin`（工作树语义）。被证 commit 的 `.gitattributes`
尚不在树里时（未跟踪），一个只存在于磁盘的「宽松策略」可以把 commit 里的未声明 CRLF/BOM
夹具豁免掉——**假通过**。bare clone（无工作树）则完全无法作答。

修复：
- `readAttributes(paths, cwd, source)` 增加**必填** `source`（40-hex commit id）。
  主路径 `git check-attr --source=<commit>`（git ≥ 2.40；本仓 2.55 实测可用）；旧 git 走
  **commit 树解析回退**（从对象库读各层 `.gitattributes`，实现 gitattributes 模式语义：
  basename/相对路径匹配、深目录覆盖浅目录、文件内最后规则胜出、`binary` 宏 = `-text`），
  并有 `forceTreeFallback` 测试接缝证明两条路径同答案。
- 两个形态失败都保留硬错：`check-attr` 因**版本不支持** `--source` 才允许回退
  （按 stderr 特征判定）；缺 commit/坏仓等其他失败继续抛 `git-command-failed`。
- `check-encoding-policy.mjs` 改为：`.gitattributes` 的存在性与规则内容都**从 commit 读**
  （`readCommitBlobAtPath`）；commit 没有策略文件 ⇒ `attributes-missing` 违规（磁盘上的
  未跟踪副本**不计入**）；CLI 增加 `--ref`（供 CI 钉住被测提交）；结果携带 `commitId`。
- 判别测试（临时仓，双向）：未跟踪 `.gitattributes` 豁免 → 仍 `encoding-policy-violation`
  （不假通过）；已提交策略 + 磁盘副本被削弱 → 仍豁免并记录例外（不假失败）；删掉磁盘
  `.gitattributes` → commit 内策略继续生效；`HEAD~1`（无策略提交）抛错而 HEAD 通过；
  **bare clone 与源仓对同一 commit 产出相同 composite/binding 且例外计数一致**；
  fallback 解析器与 `check-attr --source` 逐路径等值。
- **口径诚实**：冻结基线 `84a3d82` 的树里没有 `.gitattributes`（该文件至今未跟踪），
  因此 `check:encoding` 在 HEAD 上现在**如实 exit 1**（`attributes-missing`）。
  用临时 worktree 把策略提交进去后同一命令对 267 blob exit 0。这不是门禁变脆，
  而是旧的「看磁盘」版本在基线上给出的 exit 0 本来就是假通过。

### 11.2 【medium，已修】`--verify` 比较全部非环境元数据

缺陷：`compareManifests` 只比较 commitId/treeId/fileCount/两摘要/每文件 sha256，
其余元数据（algorithm 配方、encoding 块、blobId/mode/bytes/编码标签、base）被静默忽略。

修复：`compareManifests(recorded, current, {compareAttributeLabels})` 现在比较：
`schemaVersion`/`kind`、`commit.commitId`/`treeId`、`commit.base`（commitId/treeId/
ancestryVerified/method，逐字段）、`roots`（键序无关结构比较）、`fileCount`、两摘要、
`algorithm`（配方本身是指纹语义的一部分）、`encoding`（政策+例外表+计数）、每文件的
`sha256/blobId/mode/bytes/encoding/encodingException`。`declaredEol`/`declaredTextUnset`
是属性标签：仅当被证 commit 树里有 `.gitattributes` 时才比较；否则写一条
`informational:` 备注（基线 commit 无策略文件，标签是生成期注解，无可重算的权威答案）。
`verifyAttestation` 同时**重算记录的 base**（重新解析、重新跑 merge-base --is-ancestor），
使「base 是祖先」从声明变成可复验证据。environment 块仍然有意不比较。
判别测试：篡改 algorithm/encoding/mode/blobId/bytes/encoding/roots/base（含假
ancestryVerified、幽灵 base commit id）各自 `--verify` exit 1 并输出对应字段名。

### 11.3 【medium，已修】CI：attest:verify、verify/parity 关系、Windows 腿、parity 收紧、加固

- `verify` 作业新增 **`Verify the recorded commit attestation`**（`pnpm run attest:verify`），
  步骤注释写明与 parity 的分工：verify 回答「记录的清单是否仍匹配其 commit」（单机，
  内容权威/祖先/配方/逐文件元数据），parity 回答「同一 commit 跨 OS 重算是否一致」
  （3 平台矩阵）。两者互补不可互替：摘要若以同样错误的方式在各平台错开，verify 仍绿、
  parity 抓；记录过期则 parity 仍绿、verify 抓。
- checkout `fetch-depth: 0`（verify 重解析记录的旧 commit/base，浅克隆会让合法记录不可验；
  Windows 腿的 `--base HEAD~1` 测试同样需要）+ `persist-credentials: false`；全部 5 个
  action 钉到 40 位 SHA（v4.4.0/v4.4.0/v4.4.0/v4.6.2/v4.3.0，SHA 来自 `git ls-remote` 实测）；
  三个作业均有 `timeout-minutes`。
- Windows 腿新增两步：`smoke-build`（Windows 曾是 spawn EINVAL 假失败的发生地）+
  `pnpm exec vitest run tests/unit/p62/{commit-attestation,evidence-gates}.test.ts`。
- `fingerprint` 不再把 `--json` 输出重定向到第二个文件（Windows PowerShell 重定向编码
  是隐患；stdout 已在 job log，artifact 是 `--out` 写的文件）；upload-artifact 加
  `if-no-files-found: error`；download-artifact 落到独立 `artifacts/` 目录再交给比较器。
- `compare-platform-digests.mjs`：minPlatforms 2 → **3**（「Windows/Linux/macOS 一致」
  是三 OS 声明，缺一条腿就是失败）；新增**形状校验**——composite/binding 必须 64 位小写
  hex、commit 必须 40 位 hex、fileCount 必须正整数；并比较 fileCount 跨平台一致
  （旧代码把 `''` 当值比较）。判别测试：两平台即失败、畸形摘要即失败、fileCount=0/
  缺失/不一致即失败。

### 11.4 【文档，已修】§9 命令与 CI 一致、内部计数矛盾澄清

- §9 重写：标注每条命令与 CI 步骤的对应（§9.1 对应表）；`pnpm run attest`（无
  `--allow-dirty`、硬性要求干净树）与「生成到 /tmp」示例（`--allow-dirty`）不再混写。
- 原 §5 表中「`check:encoding` exit 0 — 266 blob」是**工作树口径**下的历史结果；按提交
  绑定口径，基线 commit 上该命令如实 exit 1（见 §11.1 口径诚实段）。原 §5 其余行中的
  计数（92 files/1810 tests、87/87）属于当时的工作树状态；本轮后 PR-1 三个测试文件的
  当前实测计数见 §11.5。历史段落按其记录时点保留，不作改写。

### 11.5 修复轮门禁实测（本机 win32/x64，Node v22.23.1，git 2.55.0）

| 命令 | 结果 |
| --- | --- |
| `pnpm run typecheck` | **exit 0** |
| `pnpm exec vitest run tests/unit/p62/{commit-attestation,evidence-gates,negative-result-assertions}.test.ts` | **109/109 pass**（47 + 41 + 21；PR-1 范围 +22 判别测试） |
| `pnpm run attest:verify` | **exit 0** — 记录仍逐项匹配其 commit（附 informational 备注：基线无已提交 `.gitattributes`，属性标签不比较） |
| `node scripts/eval/smoke-build.mjs` | **exit 0** — 68 exports，构建 + 真实 ESM import |
| `node scripts/eval/negative-result-diag.mjs --assert` | **exit 0** — A1..A6 PASS |
| `check:encoding` @ 基线 `84a3d82` | **exit 1（诚实）**：`attributes-missing`（该 commit 树里没有策略文件；磁盘未跟踪副本不豁免） |
| `check:encoding --ref <策略已提交的临时 commit>` | **exit 0**：267 blob、0 未声明 |
| 临时仓判别探针（API 直调） | 未跟踪豁免→THROW `encoding-policy-violation`；bare clone 与源仓同答（同 THROW / 同 exceptions=1 / 同 composite+binding） |
| `.github/workflows/ci.yml` YAML 解析 | python yaml.safe_load 通过；5 个 action SHA 钉、fetch-depth:0、persist-credentials:false、timeout-minutes、if-no-files-found:error 全部确认 |

### 11.6 修复轮边界

- 禁改面（`src/ledger`、`src/jitrl`、PR4A 脚本）零改动；`git status` 中这些文件的
  M/?? 状态全部来自并行队友的在途工作。
- 未 commit/push；CI 变更只落在工作树的 `ci.yml`，由集成轮审阅。
- 跨 OS 等值仍未在本机「验证」——它是 CI 三平台矩阵的**测量**对象；本轮把该测量
  的判定规则本身收紧并补齐了单侧测试。
