# P0-6 / P1-4 文档漂移更正登记（rev5 · t9）

- **任务**：`t9`（P0 报告、证明、产物与文档门禁），attempt `7eefd151-604e-4f1a-b2f4-cae54840bc49`
- **作者**：p0-evidence
- **登记时刻**：2026-10-30T04:38–04:53（Asia/Shanghai）——窗口覆盖 §3 表格最早采样（E-5，04:38:34）到最晚采样（E-4，04:52:44），逐行时刻见 §3
- **证据基线**：`HEAD = 97e38db37305b24f695a5f989428b3611f84987c`，工作树**未提交**（rev5 全轮不 commit，G12）；本文件只登记事实与指针，不修改任何历史报告字节
- **裁决依据**：队长对 t7 §6 的裁定——C-1/C-2：pinned ADR 0007 **只读**，H-3 用新更正文件 + 指针登记；C-4：README 全量计数由 `t23` 收口；C-10：`readme-default-leaves` 的 5 个合成 fixture **只补字段、不改断言**
- **本文是什么**：一条可复核的**更正入口**。每条记录「原文位置 + 原断言 + 当前实测（命令/退出码/输出/时刻）+ 结论 + 指针」。
- **本文不是什么**：不是对历史报告的改写。`docs/reports/p3-*.md`、`p2-p6-final-verification.md`、`docs/adr/0002-*.md`、`src/runtime/execution-profile.ts` 均不在 `t9` 写范围，本文**只登记**，不落盘修改它们。

---

## 0. 双向指针图（先读这一节）

本轮的「更正」由三处入口构成。因为 ADR 0007 被 sha256 钉死（`tests/unit/jitrl/p6-pareto-budget.test.ts:866-880`，G8/C-1），**不能**在 ADR 0007 内新增指向本文件的边；因此下表把**每条可见边**与**唯一一条被冻结禁止的边**都写清楚，读者从任一端进入都能看到矛盾与更正。

| # | 边（From → To） | 位置（可核对） | 是否可写 | 证据 |
| --- | --- | --- | --- | --- |
| P-1 | 本登记 → ADR 0007 §4（H-3 的替换行登记） | 本文 §C-4；`docs/adr/0007-p6-pareto-budget-terminology-and-hooks.md:58-88` | 本文件可写；目标是 pinned 只读 | `Get-FileHash` = `47e67c7d…`（见 §3 E-1） |
| P-2 | ADR 0007 §4 → 漂移现场（出边，pinned 字节里已有） | `docs/adr/0002-p62-release-contract-and-default-safe-shape.md:51`、`src/runtime/execution-profile.ts:121` | 否（pinned） | ADR 0007 §4.1/§4.2 逐字给出两处替换整行；§3 E-1/E-2 实测两处仍含旧文案 |
| P-3 | 本登记 → `src/dsh-bridge/model-config.ts` 头注释（§C-5） | 本文 §C-5；`src/dsh-bridge/model-config.ts:22-69` | 两处都可写 | §3 E-3 实测 schemastery 可解析；头注释已加「DOC-DRIFT REGISTER」段 |
| P-4 | `src/dsh-bridge/model-config.ts` 头注释 → 本登记 §C-5（**反向边**） | `src/dsh-bridge/model-config.ts` 的 `forward:` / `reverse:` 两行 | 可写 | 指针测试 `tests/unit/p62/docs-correction-pointers.test.ts` 断言 |
| P-5 | 本登记 → H-3 三处原文（`p3-a-assembly` / `p3-b-adapter` / `p2-p6-final-verification`） | 本文 §C-1/§C-2/§C-3 | 原文只读（不在 t9 范围） | 原文行号 + §3 实测 |
| P-6 | ADR 0007 → 本登记（**不可表示的边**） | —— | **否**：ADR 0007 字节被 pin，改动即红 | `pnpm exec vitest run tests/unit/jitrl/p6-pareto-budget.test.ts -t "pinned sha256"`（§3 E-4） |

**结论**：可写的双向边是 **P-3 ⇄ P-4**（schemastery 注释与本登记互指），可复核的单向边是 **P-1 → P-2**（本登记指到 ADR 0007 §4，§4 自身指到两处漂移现场；ADR 0007 是冻结的登记簿，不是可写回执）。P-6 是 captain 裁定 C-1/C-2 明确接受的代价：**不为了加一条反向指针而破坏 pinned 凭证**。

> 机器可核：`tests/unit/p62/docs-correction-pointers.test.ts` 会读取本文件、`src/dsh-bridge/model-config.ts`、ADR 0007 与 pin 测试，逐条断言 P-1…P-5 的文本存在，并断言 ADR 0007 的 sha256 仍等于 `47e67c7dab9ddacaf1d505a7fea6fe9312ee9b38d52ea1097444e37ab089b289`（P-6 的边界）。

---

## C-1 H-3(a)：`p3-a-assembly` 的 19/17 与实测 20

| 项 | 内容 |
| --- | --- |
| 原文位置 | `docs/reports/p3-a-assembly.md:105`（§4-B 表：`Tests 19 passed (19)`）；`:148`/`:152`（§5 标题/正文：19 条）；`:162`（§6 表：**17 条**） |
| 原断言 | 同一测试文件 `tests/unit/dsh-bridge/agent-loop-ledger-assembly.test.ts` 在 §4-B/§5 记 19 条、在 §6 记 17 条 |
| 当前实测 | `pnpm exec vitest run tests/unit/dsh-bridge/agent-loop-ledger-assembly.test.ts --reporter=json --outputFile=work/t9-counts/agent-loop.json` → exit 0，`Tests 20 passed (20)`，JSON `numTotalTests=20`（2026-10-30T04:38:34+08:00） |
| 结论 | 原报告**同一文件内部自相矛盾**（19 vs 17）；t9 复跑当前树为 **20**（与 t1 审核的实测一致），因此 19 与 17 都不描述当前树。`p3-a-assembly.md` 不在 t9 写范围，**不修改历史报告**；本登记是唯一更正入口 |
| 指针 | 原文 §6 的 17 与 §5 的 19 都指向本节；t1 的原始发现见 `docs/reports/p2-p6-integration-audit.md:121`（H-3(a)）与 `docs/reports/p2-p6-integration-round.md:135`（第 4 行） |

## C-2 H-3(b)：`p3-b-adapter` 的 `9 + 21 + 4 = 32` 与实测 34

| 项 | 内容 |
| --- | --- |
| 原文位置 | `docs/reports/p3-b-adapter.md:93`（§4 第 5 行：`9 + 21 + 4 = 32 passed (32)`）；`:95`（§5 标题：32 条）；`:114`（§6 表：32 条）；分项 `:97`=9、`:99`=21、`:101`=4 |
| 原断言 | 三个测试文件合计 32 条，且逐项 9 + 21 + 4 |
| 当前实测 | `pnpm exec vitest run tests/unit/ledger/metering-coverage.test.ts tests/unit/ledger/metered-model-adapter.test.ts tests/unit/ledger/stage-purpose-labels.test.ts --reporter=json --outputFile=work/t9-counts/ledger-three.json` → exit 0，`Tests 34 passed (34)`；逐文件 JSON：9 / 21 / 4（2026-10-30T04:38:41+08:00） |
| 结论 | **分项正确、合计错**：9 + 21 + 4 = **34**，不是 32。这是算术错误，不是时点漂移（同一行内自相矛盾）。t9 不修改历史报告；本登记为更正入口 |
| 指针 | 原文 §4 第 5 行/§5/§6 指向本节；t1 原始发现 `p2-p6-integration-audit.md:121`（H-3(b)） |

## C-3 H-3(c)：`p2-p6-final-verification` 的 2428/2429 是两个时点，不是同刻矛盾

| 项 | 内容 |
| --- | --- |
| 原文位置 | `docs/reports/p2-p6-final-verification.md:364`/`:365`/`:377`（§11.2，时点 2026-10-29 17:55）：`127 files / 2428 tests`；`:549`（§11.8.2）：`127 files / 2429 tests` |
| 原断言 | t1 审核把两处数字列为「同一文件内部自相矛盾」（`p2-p6-integration-audit.md:121` H-3(c)） |
| 当前实测 | ① 该报告 §11.8.1（`:525-527`）自述：t14 收尾后 lead **新增了一条 ratchet 测试**（`readme-default-leaves.test.ts` 的 `keeps the untestable no-report rethrow guard…`）② `pnpm exec vitest run tests/unit/config/readme-default-leaves.test.ts --reporter=json` → exit 0，当前 `Tests 15 passed (15)`，其中最后一条正是该 ratchet（2026-10-30T04:39:04+08:00）③ 2428 + 1 = 2429，与「先 §11.2、后 §11.8.2」的时间顺序一致 |
| 结论 | 2428 与 2429 是**不同时点的快照**：§11.2 在 ratchet 之前，§11.8.2 在 ratchet 之后，差 1 条测试可归因（不是同一棵树上的两个互斥值）。t1 的「自相矛盾」结论应限定为「未标注时点的**误读风险**」；原报告无需改数字，本登记补足时点归因 |
| 指针 | 原文 §11.2/§11.8.2 指向本节；t1 `p2-p6-integration-audit.md:121`（H-3(c)）与 §11.8.1 的 ratchet 自述 |

## C-4 H-3 术语漂移（ADR 0007 §4 登记）——**已应用**（rev6 R0-3，2026-10-31T02:06+08:00）

> **状态沿革（历史，2026-10-30T04:42）**：本行原记「未应用，仍待授权 owner 落盘」；rev5 写范围不含这两个文件（captain C-2 裁定），故当时**不修改、不伪造已修**。rev6 队长 D-1 批准后由 t8 的 R0-3 按 ADR 0007 §4.1/§4.2 **整行逐字**替换，本节据此改述为已应用。

| 项 | 内容 |
| --- | --- |
| 原文位置 | ① `docs/adr/0002-p62-release-contract-and-default-safe-shape.md:51`：「holdout **非劣证据** + 显式授权 + 匹配 artifact」② `src/runtime/execution-profile.ts:121`：`holdout non-inferiority + explicit authorization + matching artifact` ③ 替换整行已由 ADR 0007 §4.1/§4.2（`:62-88`）逐字给出 |
| 原断言 | 发布门的语义是「非劣即可」（ADR 0002）／「non-inferiority 是必需项」（execution-profile 拒绝理由） |
| 当前实测 | **两处均已由 ADR 0007 §4.1/§4.2 的替换整行逐字替换**（rev6 R0-3，2026-10-31T02:06+08:00，脚本 `node work/t8/apply-c4.cjs`，exit 0）：ADR 0002:51 现含「holdout **严格超越**验证」；`execution-profile.ts:121` 现含 `holdout STRICT-IMPROVEMENT validation`。判别脚本 `node work/t8/check-c4.cjs` exit 0：旧**操作性**判据（`holdout 非劣证据` / `holdout non-inferiority +`）命中 **0**，严格超越表述 **2/2**，ADR 0007 pin 仍 `47e67c7d…`。残余的两处 `非劣`/`non-inferiority` 是**替换整行自带的披露文字**（「ADR 0002 原文"非劣"为文案漂移」「the earlier "non-inferiority" wording was drift」），不是判据复述；删掉它们就必须手改 pinned 登记簿给出的整行 |
| 结论 | 文案漂移**已应用**（rev6 R0-3）。ADR 0007 **一个字节未改**（pin 仍 `47e67c7d…`，G8/C-1）；替换文本不是我抄写的，而是从 ADR 0007 §4.1/§4.2 的 fenced block **原样取出**并断言与文件当前行逐字节相等。本登记与 ADR 0007 §4 构成 P-1 → P-2 的可复核链，且两端现在指向**一致**的事实（不再是「登记了但未应用」） |
| 指针 | 本登记 §C-4 ⇄ ADR 0007 §4（`ADR:58-88`）；ADR 0007 §4 → 两处漂移现场（`:51` / `:121`）。反向边 P-6 见 §0 |
| 边界 | R0-3 **之前**不把「已登记替换行」写成「已应用」（当时确实未应用）；R0-3 **之后**也不得把漂移写回去——不得把「严格超越」写成「非劣」；不改任何历史负结果；不改 ADR 0007（pin） |

## C-5 schemastery 注释漂移（`src/dsh-bridge/model-config.ts`）——**已更正**

| 项 | 内容 |
| --- | --- |
| 原文位置 | `src/dsh-bridge/model-config.ts` 头注释（更正前 `:22-37`）：「`@deepseek-ai/schemastery` is NOT installed… The integrator … **installs** `@deepseek-ai/schemastery` as a dependency to make it resolvable」 |
| 原断言 | 本仓没有该依赖、需要集成方安装后才能解析；静态导入必然失败 |
| 当前实测 | ① `package.json:63` 声明 `"@deepseek-ai/schemastery": "3.18.4"`（`Select-String` 命中）② `node -e "import('@deepseek-ai/schemastery')…"` → exit 0，`default` 为 function（2026-10-30T04:39:40+08:00，见 §3 E-3）③ `Test-Path node_modules/@deepseek-ai/schemastery` = True |
| 结论 | 「需要安装」的措辞**已漂移**：本仓已声明依赖且在**本检出**可解析。仍然保留结构化注入 + 动态加载器，因为宿主可能把插件以 symlink 安装到没有自身 `node_modules` 的目录（该失败模式是头注释原本要防的）；本次更正**只改注释事实**，不改任何行为。构建产物字节未变（`lib/index.js` 1185632 B，与 t7 基线一致） |
| 已落盘 | `src/dsh-bridge/model-config.ts` 头注释新增「CURRENT FACTS」与「DOC-DRIFT REGISTER」两段；`forward:` 指向本文件 §C-5，`reverse:` 边由本文件 §C-5 指回该头注释（P-3 ⇄ P-4） |
| 反向指针 | 本登记 §C-5 → `src/dsh-bridge/model-config.ts` 头注释（`DOC-DRIFT REGISTER` 段）；头注释 → 本登记 §C-5 |
| 边界 | 不改 `MODEL_ROUTE_DEFAULTS` / 字段表 / 解析函数；不改 26 键公开面（G9）；不改 pin（G8） |

---

## 2. 本轮**没有**做的事（诚实登记）

1. **没有**修改 ADR 0007 一个字节（pinned；sha256 仍等于 `47e67c7d…`，§3 E-4）。
2. **没有**修改 `docs/adr/0002-*.md:51` 与 `src/runtime/execution-profile.ts:121`（不在 t9 写范围；C-4 只登记）。
   > **rev6 R0-3 补记（不改 rev5 事实）**：本行描述的是 **rev5 t9 的时点**。rev6 队长 D-1 批准后，这两行**已**由 t8 的 R0-3 按 ADR 0007 §4.1/§4.2 整行逐字替换（证据见 §C-4 与 §3 E-9…E-12）。第 1 条（ADR 0007 一个字节未改）在 rev6 仍成立，pin 仍 `47e67c7d…`。
3. **没有**修改 `p3-a-assembly` / `p3-b-adapter` / `p2-p6-final-verification` 的任何历史数字（只登记 + 指针）。
4. **没有**修改 README 计数行（G6；全量 `check:docs` 的计数由 t23 一次收口；t9 用 `--docs-only` + 负控制验证配置参考）。
5. **没有**伪造「当前 HEAD 已被证明」：`docs/reports/final-attestation.json` 仍描述 `1b7920e…`；本轮工作树未提交，`attest:verify` 的 informational 行明确「HEAD is 97e38db…, not the recorded …」。自指边界见 `scripts/eval/final-attestation.mjs` 头注释与 `tests/unit/p62/*attestation*`。
6. **没有**执行付费模型、真实工具、真实宿主收益评估或真实记忆写入。

---

## 3. 可复跑证据（逐字命令 + 退出码 + 关键输出 + 时刻）

| # | 命令（逐字） | 退出码 | 关键输出（≤3 行） | 时刻（+08:00） |
| --- | --- | --: | --- | --- |
| E-1 | `Get-FileHash docs/adr/0007-p6-pareto-budget-terminology-and-hooks.md -Algorithm SHA256` | 0 | `47E67C7DAB9DDACAF1D505A7FEA6FE9312EE9B38D52EA1097444E37AB089B289`（= pin） | 04:42 |
| E-1b | `Select-String -Path docs/adr/0002-p62-release-contract-and-default-safe-shape.md -Pattern 'holdout 非劣证据'` | 0 | `51: … holdout 非劣证据 + 显式授权 + 匹配 artifact …` | 04:42 |
| E-2 | `Select-String -Path src/runtime/execution-profile.ts -Pattern 'non-inferiority'` | 0 | `121: reason: 'publish is never granted in this round: holdout non-inferiority + …'` | 04:42 |
| E-3 | `node -e "const c=require('@deepseek-ai/schemastery'); console.log('require() keys=' + Object.keys(c).slice(0,5).join(',') + ',… (' + Object.keys(c).length + ' total)'); import('@deepseek-ai/schemastery').then((m)=>console.log('import() namespace keys=' + Object.keys(m).join(',') + '; default=' + typeof m.default))"` | 0 | `require() keys=ValidationError,extend,resolve,from,lazy,… (26 total)`；`import() namespace keys=default; default=function` | 04:39:40 |
| E-3b | `Select-String -Path package.json -Pattern 'schemastery'` | 0 | `63: "@deepseek-ai/schemastery": "3.18.4"` | 04:39:40 |
| E-4 | `pnpm exec vitest run tests/unit/jitrl/p6-pareto-budget.test.ts -t "pinned sha256"` | 0 | `P6 SHA256 docs/adr/0007-…=47e67c7d… PASS`；`src/jitrl/jit-active-policy.ts=c9443123… PASS` | 04:52:44 |
| E-5 | `pnpm exec vitest run tests/unit/dsh-bridge/agent-loop-ledger-assembly.test.ts --reporter=json --outputFile=work/t9-counts/agent-loop.json` | 0 | `Tests 20 passed (20)`；JSON `numTotalTests=20` | 04:38:34 |
| E-6 | `pnpm exec vitest run tests/unit/ledger/metering-coverage.test.ts tests/unit/ledger/metered-model-adapter.test.ts tests/unit/ledger/stage-purpose-labels.test.ts --reporter=json --outputFile=work/t9-counts/ledger-three.json` | 0 | `Tests 34 passed (34)`；逐文件 9/21/4 | 04:38:41 |
| E-7 | `pnpm exec vitest run tests/unit/config/readme-default-leaves.test.ts --reporter=json` | 0 | `Tests 15 passed (15)`；含 ratchet `keeps the untestable no-report rethrow guard…` | 04:39:04 |
| E-8 | `node scripts/verify-readme-counts.mjs --docs-only` | 0 | `Config reference coverage: 78 documented row(s) vs 78 expected`；`SUCCESS: documentation gate fully green.` | 04:39:47 |
| E-9 | `node work/t8/apply-c4.cjs` | 0 | `ADR 0002 after : 0e7106e73788bc3251f4f128e1c40748fb8287562def50147576908173007671`；`profile after : cf9fe73dee3eb5c4289e50b94b16f6ca174dac9df790315b80efac13b758b348`；`ADR 0007 after : 47e67c7d… (== pin, untouched)` | 2026-10-31T02:06 |
| E-10 | `node work/t8/check-c4.cjs` | 0 | `operative old-criterion hits : 0`；`strict-improvement wording : 2/2`；`ADR 0007 pin : 47e67c7d… (== pin)` | 2026-10-31T02:13 |
| E-11 | `node work/t8/nc-check-c4.cjs`（脚本级）/ `node work/t8/nc-test-c4.cjs`（测试级） | 0 / 0 | 脚本级 4/4 全 PASS（`baseline-green-copy=true mutation-red=true (exit 1) restore-identical=true restore-green=true`，`treeUntouched=true`）；测试级 5/5 全 PASS，含 **NC-5 第二处越权编辑**（改 ADR 0002 第 52 行 memory 行，C-4:51 不动）→ 手术性断言必红 | 2026-10-31T02:40 |
| E-12 | `git diff --unified=1 -- docs/adr/0002-…md src/runtime/execution-profile.ts` | 0 | `2 files changed, 2 insertions(+), 2 deletions(-)`：仅 `:51` 与 `:121` 两行；`index bd8992d..69ea30c` / `b04da77..a388036` | 2026-10-31T02:08 |
| E-13 | `node work/t8/gate-sweep.cjs`（17 门一次连续扫描） | 0 | `mismatches = 0 / 17`；13 条 PASS + 4 条 `RED-AS-EXPECTED`（`clean-tree` / `attest-expect-commit-HEAD` / `attest-strict` / `docs-full`）；全文 `work/t8/gate-sweep.json` | 2026-10-31T02:46 |
| E-14 | `pnpm exec vitest run --reporter=json --outputFile work/t8/final-vitest.json` | 0 | `810 suites / 2803 tests / passed 2803 / failed 0 / pending 0 / todo 0 / success=true`（unit 136 files/2561、e2e 20 files/242）；JSON sha256 `a4924640…`，1,006,613 B | 2026-10-31T02:47 |

> **E-3 的「keys」来源（t19 F1 澄清）**：`ValidationError,extend,resolve,from,lazy,…` 是**模块对象自身**的可枚举属性——CJS `require()` 直接返回该对象；ESM `import()` 的 **namespace 只暴露 `default`**，同一组属性挂在 `import().default` 上。因此「26 个键」不是 ESM namespace 的键集，命令与引文以 E-3 的两条输出为准（t23 于 2026-10-30T08:10:42 复跑，exit 0，输出与本行逐字一致）。

> **时点声明**：以上是本轮 t9 在 `HEAD=97e38db` + 未提交工作树上的一次采样。后续任务改动树后必须重跑；历史报告与 ADR 的数字不因本节而改写。
>
> **未执行/未授权（rev5 t9 时点，历史）**：ADR 0002 / execution-profile 的替换行应用（C-4）= `not-run`（写范围外，需 owner 授权）；全量 `check:docs` 的 README 计数收口 = `t23`；真实宿主/付费模型/真实记忆写 = `not-run`。
>
> **rev6 R0-3 的状态更新（当前事实）**：上一条的 C-4 = `not-run` **已不再成立**——rev6 队长 D-1 批准后由 t8 的 R0-3 落盘，证据 E-9…E-12，现态为 `applied`（ADR 0002:51 与 `execution-profile.ts:121` 两行按 ADR 0007 §4.1/§4.2 逐字替换，ADR 0007 一个字节未改）。**仍未执行**：README 全量计数重铸（t26/G6）、真实宿主/付费模型/真实记忆写、commit/push（N-1）。
