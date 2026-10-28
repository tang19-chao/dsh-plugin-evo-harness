# t11 — PR-4A 换行可携性独立审核（round 1）

- **被审对象**：t3（PR-4A 换行可携性 / eol-equiv-v1）最新实现 + t9 验证证据
- **审核人**：architect-reviewer（独立于实现者与验证者；本报告只新增 `docs/reports/t11-pr4a-eol-portability-review.md`，未改动任何实现/产物）
- **契约**：ADR 0005 决定 D2（`docs/adr/0005-p1-evidence-and-atomic-config-contract.md` §2）
- **结论**：**verdict = PASS**（两项验收全部核实；5 条低/信息级观察如实记录，均不阻塞）
- **日期**：2026-10-29；基线 HEAD `722625c`，P1 改动在工作树未提交

---

## 1. 审核方法（独立重放；不采信作者测试自述）

1. **逐行读 diff**：`scripts/eval/verify-pr4a-artifacts.mjs`（+243/−77）与 `tests/unit/p62/pr4a-artifact-verifier.test.ts`（+254/−77）——确认改动只涉及 eol-equiv-v1 语义、旧 WARN 迁移、`--help`/文件头规约文本，以及一行 `digestOfFile` 注释。
2. **真实产物 × 真实 LF 检出（决定性端到端）**：把仓库克隆到临时目录（`core.autocrlf=false`、`core.eol=lf`、`checkout -f`），拷入**工作树的当前 verifier** + 真实 `work/pr4a-five-arm-eval.json` + 5 个 ledger + 报告 md，运行真实 verifier（`work/_t11_review/lf-e2e.mjs`，17/17 期望通过）。
3. **镜像方向**：在 LF 克隆里把 7 个执行源**全部转成 CRLF**（`work/_t11_review/mirror-e2e.mjs`）——验证另一方向。
4. **漂移/伪造系列**（同一 LF 克隆内，逐步变异并逐步恢复）：内容漂移、混合态 WARN、BOM、二进制 NUL、多余尾换行、伪造 digest（列表摘要不同步）、恢复后复绿、真实仓产物哈希前后不变。
5. **生成侧一致性证明**：用 `git cat-file blob HEAD:<path>` 取**已提交 blob**，逐条比对「记录的摘要 == LF 形式」还是「== CRLF 形式」，证明等价规则接受的是**同一条提交字节的另一种合法检出形式**，不是任意文本。
6. **旧反例清点**：用 `git show HEAD:<test>` 与新文件逐名比对（13 → 19），确认哪些旧用例被保留、改名或按 ADR 重写。
7. **产物完整性**：报告 md 的 `git status`（byte-identical）、`work/pr4a-five-arm-eval.json` sha256 与我审核前后一致、mtime、md 中 `executedSourcesDigest` 与 JSON 一致、当前工作树 verifier 691/691 与 `eolEquivalents: []`。

---

## 2. 验收逐项核实

### 2.1 "LF/CRLF 处理有生成与校验一致性证据，真实内容漂移仍失败" — **passed**

**生成侧与校验侧同口径的机械证明**（不是"看起来一致"）：

| 执行源 | 记录摘要 == 已提交 blob 的… | 含义 |
| --- | --- | --- |
| `scripts/eval/eval-pr4a-five-arm.mjs` | **LF 形式** | 生成时检出为 LF |
| `scripts/eval/pr4a-build.mjs` | **LF 形式** | 同上 |
| `scripts/eval/build-eval.mjs` | **CRLF 形式** | 生成时检出为 CRLF |
| `scripts/eval/pr4a-five-arm-lib.ts` | **LF 形式** | |
| `scripts/eval/pr4a-report.ts` | **LF 形式** | |
| `scripts/eval/pr4a-stats.ts` | **LF 形式** | |
| `scripts/eval/jitrl-eval-lib.ts` | **CRLF 形式** | 生成时检出为 CRLF |

即：**真实产物本身是混合换行记录（5 LF + 2 CRLF）**，等价规则对每条的接受集恰是"同一提交 blob 的 LF 或 CRLF 检出形式"——这正是"生成与校验一致"的可执行定义。

**真实产物在两种检出下的判定（我亲手跑，非作者测试）**：

| 场景 | 结果 |
| --- | --- |
| 真实仓库当前工作树（5 LF + 2 CRLF，7/7 raw） | **exit 0，checked=691，passed=691，failed=0，eolEquivalents=[]，warnings=[]**（与 t3 自报一致） |
| 真实产物 × 全新 **LF 检出** | **exit 0，checked=693，failed=0，eolEquivalents=2**（`build-eval.mjs`、`jitrl-eval-lib.ts`），无 WARN、无 provenance 失败；stdout 逐条打印 `EOL-EQUIVALENT (eol-equiv-v1)` |
| 真实产物 × 把 7 个源**全部转 CRLF**（镜像方向） | **exit 0，checked=693，failed=0，eolEquivalents=5**（其余 5 个 LF-era 条目），2 个 CRLF-era 条目转 raw；无 WARN |
| 混合换行（1 个源 CRLF + 其余 LF） | **exit 0**，该源变成 raw match（记录本来就是 CRLF），其余不变 |

**真实内容漂移仍然失败（逐项实测）**：

| 变异 | 结果 |
| --- | --- |
| 给一个 raw-match 源追加一行注释（真实内容漂移） | **exit 1**；`provenance-executed-sources-match-disk` FAIL 并具名该路径（`eolOnly:false`），`rule:eol-equiv-v1`；混合态触发保留的 `provenance-executed-sources-eol-divergent` WARN，并列出 2 个真正等价的内条目 |
| 给一个源加 UTF-8 BOM | **exit 1**（drift；等价规则不做 BOM 归一） |
| 给一个源追加 NUL/二进制 | **exit 1**（`bytes.includes(0)` 守卫，绝不"归一"成匹配） |
| 给一个源追加一个多余尾换行（内容，不是换行形式） | **exit 1**（drift） |
| 只改 `executedSources[].sha256` 为 LF 形式但**不同步** `executedSourcesDigest` | **exit 1**；`provenance-executed-digest-recomputed` FAIL（反合谋：列表摘要重算仍是 FAIL 条件） |
| 上述变异全部恢复 | **exit 0**（不可逆残留为零） |

**边界如实记录**：等价规则接受"同一文本的任意 CRLF/LF 组合"（含混合换行文件），因为变换只抹掉换行形式信息；它不接受任何其它字节差异（BOM/内容/二进制/非法 UTF-8 均 FAIL）。**未发现内容碰撞或"把不同内容判成相同"的路径**。

### 2.2 "旧13项反例和新增换行反例均通过，未修改历史统计或伪造产物" — **passed**

| 检查 | 结果 |
| --- | --- |
| 专属套件 | **19/19 通过**（我独立复跑） |
| 旧 13 项清点（逐名比对 HEAD 版本） | **11 项名字与断言原样保留**；`--help` 用例改名并按新规约更新期望串（同一场景、非削弱）；**唯一语义反转**是 EOL 反例——旧断言"仍须 match-disk FAIL"被 **ADR D2 明确否定**，改为"具名等价 PASS"，并新增 5 条覆盖（双向等价、混合态 WARN、BOM/内容/二进制、非法 UTF-8、反合谋）。**没有静默删除或弱化其它旧反例。** |
| 新增换行反例 | 双向等价（CRLF 记录/LF 磁盘、LF 记录/CRLF 磁盘）、具名分类含规则版本与 `kind`、混合态保留旧 WARN、非 EOL 字节差异仍 FAIL、非法 UTF-8 不进入等价、列表摘要反合谋——均实际执行并通过（我的独立夹具也覆盖了同样的正反例） |
| 历史产物 | `docs/reports/pr4a-five-arm-eval-report.md` **不在 git 修改清单**（byte-identical）；`work/pr4a-five-arm-eval.json` sha256 `F22BDB14…C55ACB` 审核前后一致；产物 mtime `2026/10/28 02:12:14`（P1 窗口在 10/29 凌晨，产物早于 P1 一整天）；JSON 的 `executedSourcesDigest=5011b469…` 与 md 表格一致；5 个 ledger mtime 同为 10/28 02:12 |
| 历史统计 | 当前工作树 verifier 仍 **691/691 exit 0**；五臂统计由 verifier 从 JSON+ledger 重算并通过（未改数字）；**691 作为历史计数保留**（新检出下为 693，见 O1） |
| 改动范围 | `git diff --name-only` 恰为 t3 申报的两个 in-scope 文件；未触碰 `EXECUTED_SOURCES` 的 7 个生成侧文件（否则历史记录会永久红——ADR §2.4 的红线） |

---

## 3. 实现审查（diff 逐点）

- `classifyExecutedSource(bytes, recorded)` 四分类 `raw | eol-equivalent | drift | unreadable`：先 raw，再 `isEolOnlyDivergence`（**原样复用**既有 CRLF↔LF 变换 + 二进制/非法 UTF-8 守卫），否则 drift；unreadable 单独失败。**没有新增归一种类**（无 BOM/空白/Unicode 归一）。
- `provenance-executed-sources-match-disk` 的通过条件 = 无 drift、无 malformed、无 unreadable（raw 或等价都算）；detail 里带 `rule`、`mismatches`（drift 列表）与 `eolEquivalent`（等价路径）。**raw 与等价在计数与输出上分开**。
- 旧 WARN `provenance-executed-sources-eol-divergent` 保留，触发条件收窄为"**有 drift 且有等价**"的混合态；全等价态不再出 WARN（改为 PASS 分类）——与 ADR §2.5 的迁移要求一致。
- `provenance-self-hash-matches-working-tree` 同样按 raw|eol-equivalent 通过、drift 失败（镜像方向实测触发等价分支并通过）；守卫未弱化。
- `--help`/文件头规约文本已改写为 eol-equiv-v1（含版本串、三分类、迁移说明、反合谋）；`--help` 实测输出含 `eol-equiv-v1` 与两个 check id。
- 生成侧零改动（`EXECUTED_SOURCES` 的 7 个文件 diff 为空）；verifier 仍只依赖 node 内建模块。

---

## 4. 观察（低/信息级，不阻塞；建议 t16 收录，后续轮次可选修）

- **O1（low，诊断/计数）**：摘要段有一处**重复推入断言**（`results.push({id:'provenance-executed-sources-eol-equivalent', ok:true, …})`，把一个已存在的 id 再压一份）。后果：只要出现等价命中，`status.checked/passed` 就 **+1 虚增**（真实仓 691 → LF 检出 693），且混合态下同一 id 会**既出现在 `failures` 里、又作为"通过"计入 `passed`**。退出码不受影响（`failed` 在推入前已计算，所有实测失败仍 exit 1，**无假绿**）。建议：删除该重复推入；把等价分类改成独立的 `classifications` 数组（或把该断言的 ok 条件与"其它条目是否 drift"解耦——它现在只因**别的**条目漂移而失败，语义与"本条目等价"无关）。
- **O2（info，死代码）**：`digestOfFile()` 已无调用点（仅定义），可后续清理。
- **O3（info，表述精度）**：t3 自报"旧 13 项反例全部保留（实测零丢失）"不够精确——实际是 11 项原样、1 项改名（`--help` 更新期望串）、1 项（EOL 反例）**按 ADR D2 有意反转**。反转本身正确，但 t16 记录时应写明"ADR 决定的唯一语义反转"，避免读者以为 13 项断言一字未动。
- **O4（info，规则边界）**：等价规则接受"同一文本的任意 CRLF/LF 组合"（含逐行混合），因为变换只抹换行形式；建议在文档中明说"eol-equiv-v1 按设计抹掉换行形式这一维度，除此之外不抹任何信息"。
- **O5（info）**：真实产物的 7 个执行源在当前工作树是 5 LF + 2 CRLF（`.gitattributes` 把 `*.ts/*.mjs` 等钉为 `eol=lf`，而 2 个文件仍带着生成时写入工作树的 CRLF 字节）；因此**全新 git 检出只会走 LF 方向**，CRLF 方向需要显式构造（我的镜像夹具即如此）——这解释了为什么作者/验证方在"当前检出 7/7 raw"下看不到等价命中。

**无 blocker / 无 high / 无 medium findings；验收两条均满足。**

---

## 5. 复现方式

```bash
# 1) 专属套件（19/19）
pnpm exec vitest run tests/unit/p62/pr4a-artifact-verifier.test.ts
# 2) 当前工作树（CRLF-era 混合检出）：691/691，eolEquivalents=[]，warnings=[]
node scripts/eval/verify-pr4a-artifacts.mjs
# 3) 真实产物 × 真实 LF 检出（17/17 期望；含漂移/BOM/二进制/反合谋/恢复）
node work/_t11_review/lf-e2e.mjs
# 4) 镜像方向：真实产物把 7 个源全转 CRLF -> exit 0，5 等价 + 2 raw
node work/_t11_review/mirror-e2e.mjs
# 5) 产物完整性
git status --porcelain docs/reports/pr4a-five-arm-eval-report.md   # (empty)
node -e "const p=require('./work/pr4a-five-arm-eval.json').codeProvenance;console.log(p.executedSourcesDigest)"
```

---

## 6. 附录（t20 提交前复验，2026-10-29）：t18 收口后的字节变化与本审核结论的关系

> 本节由集成复验任务 t20 追加（仅追加，不回写 §1–§5）。t11 的正式 round-1 裁定仍以 §2/§4 为准；是否需要 reviewer 重出裁定由 captain 决定。本节只陈述「审核之后哪些字节变了、我在新字节上重跑了什么、结论是否受影响」。

### 6.1 审核后发生的字节变化（t18）

- 改动路径：`scripts/eval/verify-pr4a-artifacts.mjs`、`tests/unit/p62/pr4a-artifact-verifier.test.ts`（与 t18 自报的 in-scope 两条一致）。
- 改动内容（独立核对）：① 删除报告段对 `provenance-executed-sources-eol-equivalent` 的**第二次** `results.push` —— 现全文仅剩 1 处该 id 的 `assert`（第 602 行），`results.find` / `eolEquivalentCheck` 残留为 0；② 判定段该断言只推入一次，且 ok 条件收窄为 `executedEolEquivalent.length > 0`，不再因**别的**条目真实 drift 而置败（真实 drift 仍由 `provenance-executed-sources-match-disk` 独立失败并驱动 exit 1）。
- 这正对应 §4 的 **O1**：属对 O1 的最小修复，未触碰 eol-equiv-v1 信任规则，也未触碰历史产物。

### 6.2 在新字节上的独立复验（t20 自建夹具，非复跑作者测试）

在系统临时目录内以真实产物记录 + 单提交真仓夹具驱动**真实 verifier**（`cwd`=夹具，零仓库写入），14/14 期望全部成立：

| 场景 | 结果 |
| --- | --- |
| A：1 条等价命中（记录 CRLF / 磁盘 LF） | checked=643、passed=627、failed=16（16 条为夹具缺 arms/ledger 等无关断言）、checked=passed+failed、等价分类 1 条、stdout `EOL-EQUIVALENT` 恰 1 行 |
| C：同夹具但记录为 raw（无等价命中）对照组 | checked=642、passed=626、failed=16 |
| **A−C 差值** | **checked +1、passed +1、failed 不变** → 每条等价命中只被计一次，**不存在 O1 描述的 +2 虚增** |
| M：1 条等价 + 1 条真实内容漂移（混合态） | exit 1；`provenance-executed-sources-match-disk` 失败且仅具名漂移路径（`eolOnly:false`）；**等价 id 不在 failures**（不再同时计入 passed）；保留的 `eol-divergent` WARN 触发且仅为 advisory；checked=passed+failed |

- 专属套件当前 **21/21**（19 旧 + t18 的 2 个计数/混合态回归）。
- 真实工作树 `node scripts/eval/verify-pr4a-artifacts.mjs` = **691/691 exit 0**、`eolEquivalents=[]`、`warnings=[]`，与 §2.1 第一行一致。

### 6.3 对 §2/§4 结论的影响

- §2.1「LF/CRLF 处理有生成与校验一致性证据，真实内容漂移仍失败」**不回退，且被加强**：混合态下等价仍是具名 PASS、真实漂移仍 FAIL、保留的 WARN 仍存在。
- §2.2「旧反例保留、历史统计未改」**不回退**：历史算术 691/691 不变，七个执行源与历史产物零改动。
- §4 **O1（low）判定为已闭环**：重复推入已删除、计数自洽（checked=passed+failed）、同一 id 不再落入两侧。
- 受影响的只是**含等价命中的计数预期**：§2.1 表中 LF 检出 `checked=693`（即 O1 所述虚增）在修复后应为 `checked=692`（691 + 1 条分类）。该 692 是依据本节实测的 **+1 差值**推出的算术预期（t20 未再跑真实 LF 检出），**不是**新的 LF 检出实测值——如实标注，避免与实测混淆。

---

## 7. 附录（t21 最终发布审核，2026-10-29）：t18 收口后的**真实 LF 检出实测**

> §6.3 把 LF 检出的 692 标注为「算术预期、非实测」；本节由 t21 在同一最终字节上复跑 t11 的 LF e2e harness（17/17），给出实际测量。

- 真实产物 × **全新 LF 检出**（`core.autocrlf=false`、`core.eol=lf`、`checkout -f`，克隆内跑**当前** verifier）：exit 0，**checked=692、passed=692、failed=0**（= 691 + 1 条等价分类断言；重复推入已删除 → t20 的算术预期被实测确认）。`eolEquivalents=2`（`build-eval.mjs`、`jitrl-eval-lib.ts`），`warnings=[]`，无 provenance 失败。
- 混合态（2 条等价 + 1 条真实内容漂移）：exit 1，`failures` **只有** `provenance-executed-sources-match-disk`（等价 id 不再落入 failures，t18 的第二处修复被实测确认）；保留的 `eol-divergent` WARN 仍触发且仅为 advisory；`eolEquivalent` 列出 2 条真实等价。
- 信任规则不回退：内容漂移 / BOM / 二进制 NUL / 多余尾换行仍 FAIL；伪造 digest + 未同步列表摘要仍被 `provenance-executed-digest-recomputed` 拒绝；变异恢复后复绿，真实仓产物哈希（`f22bdb14…` / `acae3d33…`）不变。
- 结论：§2/§4 不回退；§6 的 O1 闭环由**实测**（而非仅算术）确认；`checked=passed+failed` 在 LF 与生成检出下均自洽。
