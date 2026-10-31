# ADR 0005 — P1 保留事项裁定：证据提交目标 attestation、PR-4A 换行可携性与 P1 原子配置契约

- **状态**：accepted（t1 契约裁定；t2–t8 按此实施，t10–t15 以此为准，t16 按 §7 集成）
- **日期**：2026-10-28
- **基线**：`722625c65ac2fbce6e8b6c91565e7fd2dcaddae7`（= `origin/main`，工作树干净；`git rev-list --left-right --count origin/main...HEAD` = `0 0`）
- **环境**：win32/x64，Node `v22.23.1`，pnpm `11.7.0`，git `2.55.0.windows.3`
- **上位契约**：ADR 0002（发布契约/门禁 #7）、ADR 0003（发布验证与成本）、ADR 0004（可信质量消费 / C3）；本 ADR 只新增 P1 轮规则，**不改写**上述 ADR 的任何历史条款
- **写者**：architect-reviewer（只做裁定与审查，不修改实现；本文件是本轮 t1 唯一新增的**受版本控制**路径——§8 的可复现原型脚本放在 `work/` 下，已被 `.gitignore` 忽略，不进入提交）

> **裁定目标**（对任务 t1 四条验收的可追溯映射见 §9）：
> 1. 为"证据提交（evidence commit）"给出**可执行**的目标 attestation 规则：明确提交拓扑、父提交/代码提交绑定、例外与 CI 失败语义；**不得**退化为恒红 HEAD 校验或宽松 `HEAD^` 猜测。
> 2. 为 PR-4A 换行可携性选定**一条**路径（重新生成 vs 版本化规范化摘要），生成侧与校验侧同口径，且**不改历史统计结论**。
> 3. 给出 P1 配置原子契约：`OPTION_KEYS` 穷举、`ROOT_KEYS ∪ {modelRoute}` 与选项键不相交、混合对象拒绝、`ctx.config` 保留，并逐条给出**实测反例**（不是设想）。
> 4. 给出各实施任务的排他写范围、`src/index.ts` 单写者顺序、README 全局计数集成点、本地/远端授权边界。

---

## 0. 事实基线（先测量，再裁定）

本节的每个数字都来自本轮实测（命令与输出见 §8）。裁定只建立在实测事实上；凡"未实测"，文中明确标注。

| # | 事实 | 实测值 |
| --- | --- | --- |
| F-1 | 当前 HEAD 与远端 | `722625c`；本地 = `origin/main`，ahead/behind 均为 0，`git status --porcelain` 为空 |
| F-2 | 已提交 attestation 记录 | `docs/reports/final-attestation.json`：`schemaVersion=2.1.0`、`commitId=56f846ae177b15d2b98b2fdeb8ba20bc7488f3cc`（= 当前 HEAD 的**第一父**）、`base=null`、`fileCount=249`、`roots=["src","tests","scripts"]`、`ref="HEAD"`、`refExplicit=true` |
| F-3 | 记录与 HEAD 的关系 | 记录**不含** `docs/**`（`ATTESTED_ROOTS = src,tests,scripts`），因此"记录描述父提交"与"记录住在子提交里"**不构成自指矛盾**：记录自身的字节不进入它自己的摘要 |
| F-4 | 现有目标能力 | `final-attestation.mjs` 已有 `--expect-commit <40hex>`（生成/校验两侧）与 `--strict`（校验侧，要求记录描述**检出 HEAD**） |
| F-5 | CI `verify` job 的现状 | `pnpm run attest:verify` **刻意无目标参数**（历史自洽语义）；`--strict` / `--expect-commit ${github.sha}` 在证据提交上**必然为红**（已由 t-1 原型实测，见 §8.2 第 9 行） |
| F-6 | 证据提交的形状 | `722625c` 只改 `docs/reports/final-attestation.json`（`git show --stat`：1 file changed）；提交消息正文**没有**机器可读标记（不是 trailer），因此按本 ADR 归入"普通提交" |
| F-7 | PR-4A 产物校验 | `node scripts/eval/verify-pr4a-artifacts.mjs` = **691/691，failed=0，exit 0，warnings=[]**（本轮实测） |
| F-8 | PR-4A `executedSources` 与磁盘 | 7 个被记录文件当前**逐字节等于**记录值（7/7 match）；其中包含 `scripts/eval/pr4a-five-arm-lib.ts` |
| F-9 | PR-4A 生成侧 | `fileSha256()` 对**工作树原始字节**取 sha256（`eval-pr4a-five-arm.mjs`），产物落 `work/`（`.gitignore` 忽略），已提交的只有 `docs/reports/pr4a-five-arm-eval-report.md` |
| F-10 | 配置入口 | `OPTION_KEYS` 只列 15 个键，而公开接口 `EvoHarnessPluginOptions` 声明 26 个键（含 `config`）；`looksLikeOptions` 只看这 15 个 |
| F-11 | 默认配置叶子数 | `DEFAULT_EVO_HARNESS_CONFIG` 共 **75** 个叶子（数组按 1 个叶子）——与 t6 任务描述一致，本轮独立复算确认 |
| F-12 | README 配置覆盖 | 精确路径行覆盖 **31** 个叶子；`dreamRsi.surrogateWeights` 单行合并覆盖 4 个 → 合计 35；**缺 40 个**（`jitrl.*` 37 + `execution.*` 2 + `dreamRsi.holdoutTreeCount` 1）。`modelRoute.{provider,model,reasoningEffort}` 3 行来自 `MODEL_ROUTE_DEFAULTS`（不属于 DEFAULT 叶子） |
| F-13 | README 默认值错误 | `memoryBridge.promoteOnComposeSuccess` 文档写 `true`，默认值实测为 **`false`** |
| F-14 | `check:docs` 失败语义 | `verify-readme-counts.mjs` 只比较计数，**不读** `numFailedTests`；CI 中 `verify` job 先写 `test-results.json`，`check:docs` 消费它 → 测试失败但计数一致时文档门禁**仍会 SUCCESS** |
| F-15 | 可观测性现状 | 插件 `jitrl.hostAdvisor` 状态在没有 `hostAdvisorStats` 的适配器上把 `advisory/ask/noop/skipped` 报成 `0`（"未采集"与"零发生"不可区分）；`scopeUnknownSkipped` **不在** `EvoHarnessHostAdvisorStatus` 类型里（P6.1 R1-O2 旧账） |
| F-16 | modelRoute effort 校验 | `createModelRouteSchema` 只用 `z.string()`；`reasoningEffort:'ultra'` **被接受**并原样进入 `plugin.modelRoute`（`MODEL_ROUTE_EFFORTS` 仅用于描述文本） |
| F-17 | 本机 Node | 只有 `v22.23.1`（`Get-Command node -All` 仅一个路径）；**本机没有 Node 24，P1 本轮不得宣称 Node24 本地实测** |
| F-18 | mutation 最小集（用户已登记） | `P6_STATUS.md` §5-5：①`eight-surfaces` provenance 展开（R1-M1，4/6 红）②collector 未知拒绝分支（R1-M2，scenario 4 红）③orchestrator 赢家标尺分叉（R3-M1，2 红）④`readLearningTarget` gain 回退（R3-M2，2 红）；四项均已在评审中人工重放，CI 化未做 |
| F-19 | CI 事实 | `guarded-regression` job 的 checkout **没有** `fetch-depth: 0`（浅克隆）；`verify` job 有 `fetch-depth: 0`；`verify-pr4a-artifacts.mjs` **不在** CI 中执行（只是文档化的本地门禁） |
| F-20 | 远端结果 | 本 ADR 不对 `722625c` 的 Actions 结果作任何断言；远端只由推送后的运行日志产生（授权边界见 §7.4） |

---

## 1. 决定 D1 — 证据提交的目标 attestation 规则

### 1.1 问题

记录只能描述"生成它的提交"。把记录提交进仓库后，**包含记录的那个提交不可能被记录覆盖**（记录若要覆盖它，摘要就得包含记录自身字节，而记录里又含有该摘要）。因此：

- 对**普通提交**跑 `--strict`（要求记录描述 HEAD）= 恒红 → 门禁永远失败，等于没有门禁。
- 对**所有提交**无条件跑 `--expect-commit HEAD^1` = 宽松猜测 → 普通提交（记录指向更早的祖先）恒红，且"attest 的是哪个提交"从未被声明过，靠猜。
- 只检查"仓库里有这个 JSON" = 今天的状态：**没有任何目标约束**，陈旧记录永远绿。

三种都不能用。需要的是：**让提交自己声明它是不是证据提交**，然后对两类提交分别施加**不同但都可判定**的规则。

### 1.2 名词与唯一规范路径

| 名词 | 定义 |
| --- | --- |
| **代码提交（code commit）** | 不含证据标记、承载代码/文档改动的普通提交 |
| **证据提交（evidence commit）** | 携带**唯一**机器标记 `Attestation-Target: first-parent`（git trailer）的提交；其唯一允许的改动是把规范记录更新为目标父提交的 attestation |
| **规范记录路径** | `docs/reports/final-attestation.json`（唯一被门禁约束的记录文件；其他名字的记录文件不受本门禁约束，也**不得**被当作本仓的 attestation） |
| **标记（marker）** | 提交消息最后一个段落里的一行 trailer，**逐字符**等于 `Attestation-Target: first-parent`（区分大小写、不含尾随空格；解析前把 `\r\n` 归一为 `\n`） |

**标记的提取方式**：`git log -1 --format=%B HEAD | git interpret-trailers --parse`（git ≥ 2.40；本机 2.55 实测可用）。**不接受**在正文里手写/引用同一行来"冒充"标记——trailer 解析只认末段 trailer 块，正文引用不改变分类。

**标记不携带 SHA**（裁定）：目标由 `HEAD^1` 机械导出，再与记录内的 `commit.commitId` 三方核对。把 SHA 写进提交消息会制造第二个可写事实源（reword/rebase 后漂移），不增加任何绑定强度。提交消息正文可以自由写"本条记录描述 56f846a…"之类的人类可读说明，但**门禁不解析正文**。

### 1.3 允许的提交拓扑（穷举）

| 拓扑 | 形状 | 门禁模式 | 结果 |
| --- | --- | --- | --- |
| **T0 普通提交** | 无标记；规范记录存在且描述某个提交 `A`，`A` 是 HEAD 的祖先 | ordinary | PASS（内容自洽 + 祖先约束；不声称 HEAD 已被记录覆盖） |
| **T1 证据提交（规范形状）** | 有标记；**非合并**（`parentCount == 1`）；**只改**规范记录路径；记录 `commitId == HEAD^1` | evidence | PASS（内容重算 + 目标命中） |
| **T2 证据提交但目标错** | 有标记；记录 `commitId != HEAD^1` | evidence | **FAIL** `attestation-target-mismatch` |
| **T3 证据提交但夹带代码** | 有标记；改动集 ≠ {规范记录路径} | evidence（先查纯度） | **FAIL** `attestation-evidence-impure` |
| **T4 证据提交但是合并提交** | 有标记；`parentCount > 1` | evidence | **FAIL** `attestation-evidence-merge` |
| **T5 证据提交叠证据提交** | 有标记；`HEAD^1` 自身也带标记 | evidence | **FAIL** `attestation-evidence-stacked`（"第一父代码提交"语义要求父提交是代码提交） |
| **T6 记录被删/读不到** | 规范记录在工作树缺失 | 任一 | **FAIL** `attestation-record-missing`（绝不静默跳过） |
| **T7 记录指向非祖先** | 记录 `commitId` 不是 HEAD 的祖先（历史被改写/外来记录） | ordinary | **FAIL** `attestation-record-not-ancestor` |
| **T8 标记畸形** | 标记行重复，或值不是 `first-parent`（如 `Attestation-Target: HEAD^`） | 任一 | **FAIL** `attestation-marker-duplicated` / `attestation-marker-unsupported` |

"普通提交必须绑定自身"的**可执行含义**（消除歧义）：普通提交**不做父提交绑定**——记录只与它自己命名的提交绑定（自洽校验），并且那个提交必须是 HEAD 的祖先。**不得**为普通提交推断目标：既不能要求它描述 HEAD（T-恒红），也不能要求它描述 `HEAD^1`（宽松猜测）。普通提交上"HEAD 是否被记录覆盖"这个问题**不由本门禁回答**；它由 `fingerprint` job 每次运行对 `github.sha` 现场重算并三平台比对来回答（分工见 §1.7）。

### 1.4 判定算法（t2 必须逐条实现）

```
classify(head):
  markerLines = parseTrailers(git log -1 --format=%B head) 过滤 key == 'Attestation-Target'
  if markerLines.length > 1                 -> FAIL marker-duplicated
  if markerLines.length == 1 && value != 'first-parent' -> FAIL marker-unsupported
  if record 不存在                            -> FAIL record-missing

  if markerLines.length == 0:                       # ordinary
     verify(record, noTarget) 要求 contentOk        # 复用现有 verifyAttestation
     若 content 不符 -> FAIL content-mismatch（打印前 N 条差异）
     assertAncestor(record.commit.commitId, head)   # git merge-base --is-ancestor
     否则 -> FAIL record-not-ancestor
     PASS；输出中必须写明 "ordinary: HEAD 未被本记录覆盖"

  else:                                             # evidence
     parents = git rev-list --parents -n 1 head
     if len(parents) != 2                -> FAIL evidence-merge
     parent = parents[1]
     if parent 也带 marker               -> FAIL evidence-stacked
     if changedPaths(head) != [规范记录路径] -> FAIL evidence-impure
     verify(record, expectCommit = parent) 要求 contentOk 且 target 命中
     否则 -> FAIL target-mismatch / content-mismatch
     PASS；输出中必须写明 "evidence: parent=<sha> 已被本记录覆盖"
```

实现约束（**硬性**）：

1. 新脚本 `scripts/eval/check-attestation-target.mjs`：`--json` 输出稳定 reason code 与 `mode`（`ordinary`/`evidence`）、`parent`、`recorded`；默认人类可读摘要。退出码 0/1 是唯一判据（CI 用它）。
2. **复用** `final-attestation.mjs` 已导出的 `generateAttestation/verifyAttestation`（import，不 shell out、不复制校验逻辑）；规范记录路径常量由 `final-attestation.mjs` 导出（单一事实源），checker 不另写一份。
3. **不改** `final-attestation.mjs` 的既有语义：`--verify` 无目标仍 = 历史自洽；`--strict` 仍是"记录须描述检出 HEAD"；**不新增**"默认跟随父提交"的隐式行为。
4. 任何 git 失败（HEAD 不可解析、父提交缺失、trailer 解析失败）都**失败**并带具名 code，不降级、不跳过。
5. `--cwd <dir>` 支持夹具仓（实测：脚本默认把证据根锚在**它自己所在仓库**，夹具必须显式传 `--cwd`，否则会在本仓上得出假结论——见 §8.2）。
6. checker 自身**不得**读对象库以外的仓库内容（记录文件本身除外），不得写任何文件（`--json` 只写 stdout；如需状态文件，写 `work/` 且不得成为判据）。

### 1.5 CI 接线（失败语义）

- **新增独立 job `attestation-target`**（`runs-on: ubuntu-latest`，`actions/checkout` 固定到现有 pin SHA 且 `fetch-depth: 0`、`persist-credentials: false`；Node 22 + pnpm 11.7.0，与 `verify` job 相同安装方式），步骤只有一条：
  `run: node scripts/eval/check-attestation-target.mjs --json`
- **不改** `verify` job 里的 `pnpm run attest:verify`（保持无目标历史语义）；**不**把新门禁塞进 `verify`：`fingerprint`/`fingerprint-parity` 是 `needs: verify` 的，若目标门禁在 `verify` 里失败会**skip** 掉本该产生证据的三平台 job。独立 job 的失败只让该 job 红，跨平台证据照常产出，故障定位更清楚（这与 `guarded-regression` 刻意不设 `needs` 的理由同源）。
- **不放进 `guarded-regression` job**：它当前 checkout 没有 `fetch-depth: 0`（F-19），`HEAD^1` 在浅克隆上缺失会把"缺历史"误报成"证据错"。
- 失败语义：脚本 exit 1 + 具名 reason code（§1.3 表）→ 该 job 红；其余 job 不受影响；**不重试、不 `|| true`、不把 `--json` 管道给 `tee` 之外的任何东西**（单命令步骤，本就没有 pipefail 陷阱）。
- **不新增任何 package script 也可**；若 t2 选择新增 `attest:target` script，只动 `package.json` 的 attestation 相关键（不得触碰 `guarded-regression` / `check:mutation`）。

### 1.6 例外与过渡（当前仓库怎么落地）

1. **当前 HEAD `722625c` 在规则下是"普通提交"**（无标记，F-6），记录描述其第一父 `56f846a`（祖先 ✓，内容自洽 ✓）→ **PASS**。因此接线后 CI 不会因历史状态恒红，**也不需要**给 722625c 补标记（禁止回写历史提交）。
2. **过渡期证据链**：本轮 P1 的代码提交 C 落地后，其记录仍指向旧目标（普通提交，PASS）。P1 的"目标绑定记录"随后以**单独的证据提交 E**（marker + record-only）落地，E 的父 = C。**E 与 C 必须分开**（T3 纯度规则）。E 的生成命令必须是干净树上：
   `pnpm run attest -- --expect-commit <C>`，提交消息末尾加 `Attestation-Target: first-parent`。
3. **压脚合并/PR 合并提交**：合并提交消息没有标记 → 归入普通提交；其父链里含记录命名的祖先 → PASS。若 PR 内是证据提交 E，E 本身在 push 到 main 后作为 tip 会被单独判定（push 事件 HEAD=E）。
   - **PR 事件的诚实边界**：`pull_request` 事件检出的 HEAD 是 GitHub 合成的 merge commit（无标记 → 普通模式），因此**证据提交的父绑定只在它落到 `main` 的 push 事件上被判定**。PR 阶段若想提前得到同样结论，只能对 PR tip 手动跑 `node scripts/eval/check-attestation-target.mjs --cwd <PR checkout>`（可选动作，不改变 CI 语义）。

4. **旧记录不重生成**：本 ADR **不授权**在 t2 中重生成 `docs/reports/final-attestation.json`；重生成只发生在 §1.6.2 的授权动作里（干净树、`--expect-commit` 指向新代码提交、单独提交）。
5. **多记录文件**：如确需为旧版本保留 attestation，只能新增**不同文件名**的记录（如 `final-attestation-<shortsha>.json`），并在文档中说明其用途；**规范路径唯一**，其他文件不获得任何门禁含义。

### 1.7 门禁**不**声称什么（防过度解读）

- 普通提交 PASS **不**等于"HEAD 的代码已被记录 attest"。这类提交的代码证据来自 `fingerprint` job：每次运行对 `github.sha` 现场 `generateAttestation(--ref/--expect-commit)`，三平台（ubuntu/macos/windows）产出记录后由 `fingerprint-parity` 用 `--expect-commit ${github.sha}` 比对。两者互补：本门禁回答"记录的绑定是否成立"，fingerprint 回答"本次触发的 revision 的代码摘要在三平台是否一致"。
- 证据提交 PASS 只覆盖**第一父**（被测代码提交）；证据提交自身（记录文件）不属于被 attest 的代码面（`roots` 不含 `docs/`），这是**刻意的口径**（F-3），不是遗漏。
- 远端是否真的跑绿：只能由推送后的 Actions 日志证明；本地模拟（§8）不等于远端结果。

---

## 2. 决定 D2 — PR-4A 换行可携性：**版本化规范化摘要（eol-equiv-v1），不重新生成历史产物**

### 2.1 两条候选路径与裁定理由

| 候选 | 内容 | 裁定 |
| --- | --- | --- |
| **(a) 重新生成历史产物** | 在 LF 检出下重跑实验，把 CRLF 摘要换成 LF 摘要 | **否决** |
| **(b) 版本化规范化摘要（校验侧）** | 保留全部历史摘要字节；在校验侧引入版本化 **EOL 等价**规则 `eol-equiv-v1`，把"仅换行形式不同"从 FAIL 改为**具名 PASS 分类**，其余任何字节差异仍 FAIL | **采用** |

否决 (a) 的三条硬理由（均可复核）：

1. **结构上自毁**：`work/pr4a-five-arm-eval.json` 的 `executedSources` 覆盖 7 个脚本，其中包含 `scripts/eval/eval-pr4a-five-arm.mjs`、`pr4a-report.ts`、`pr4a-five-arm-lib.ts`（F-8 实测 7/7 逐字节匹配）。要"重新生成"，就必须先改生成侧脚本（加规范化）——一改，历史记录的 `executedSources` 立刻对不上磁盘，`provenance-executed-sources-match-disk` **永久红**。**用改代码的方式证明旧代码的记录，是自相矛盾。**
2. **不是同一次实验**：重跑发生在今天的工作树（含 P1 改动）上，provenance 会指向不同的代码状态与其脏文件集；把它写成"历史报告的证据"就是**改写历史**（团队红线）。
3. **成本与噪声**：重跑会产生新的 md 报告（新列/新 digest），而 §"不改历史统计结论"要求旧报告的每个数字原样保留；两份"同一实验"的报告会制造不可判定的双源。

采用 (b) 的语义：**记录仍然逐字节保存生成时的原始摘要**（历史事实不变）；校验器新增一条**版本化**的等价规则，使得同一份文本在另一种换行检出下可被判定为"内容等价（仅换行）"，并**显式标注**为等价而非字节相同。

### 2.2 `eol-equiv-v1` 精确定义（生成侧/校验侧同口径）

- **范围**：仅文本文件。变换仅一条：`CRLF → LF`（即 `\r\n` → `\n`；**不**处理孤立 `\r`、**不**去 BOM、**不**去尾随空白、**不**做 Unicode 归一化）。
- **等价判定**（对每条 `executedSources` 记录 `(path, recordedSha256)`）：
  - 若 `sha256(diskBytes) == recorded` → **raw match**（最强，保持不变）；
  - 否则若 `sha256(normalizeLF(diskBytes)) == recorded` **或** `sha256(toCRLF(diskBytes)) == recorded` → **eol-equivalent match**（新分类；`normalizeLF`/`toCRLF` 已在现实现 `isEolOnlyDivergence` 中，语义必须原样复用）；
  - 否则 → **drift** → FAIL（`provenance-executed-sources-match-disk` 保持失败语义）。
- **守卫（沿用且必须保留）**：磁盘字节含 NUL 或不是合法 UTF-8 → **不进入**等价判定（直接 drift），防止把二进制/损坏文件"归一"成等价。
- **反合谋守卫**：`provenance-executed-digest-recomputed`（对**记录内**条目列表重算 `executedSourcesDigest`）**保持不变并继续为 FAIL 条件**——等价规则不能靠替换条目来满足；替换任何一个 `sha256` 都会让列表摘要对不上。
- **输出可见性**：等价命中的条目必须出现在摘要与状态文件 `work/pr4a-verify-status.json` 的一个**具名分类**里（建议 `provenance-executed-sources-eol-equivalent`，`advisory: false, pass kind: 'eol-equivalent'`），**不得**与 raw match 混为一个计数。`--help`/文件头的 CHECKOUT BYTE SPEC 必须改写为描述 `eol-equiv-v1`（版本号必须出现在文本里，测试钉住 `--help` 含该串）。
- **历史记录兼容**：没有版本字段的历史记录（当前产物）走同一判定（因为规则只依赖记录里的 `(path, sha256)` 对），无需重生成；因此"CRLF 记录 / LF 磁盘"与"LF 记录 / CRLF 磁盘"两个方向都得到**明确、正确**的判定（实测见 §8.3）。
- **"生成侧不变"为什么仍然算同口径**：生成侧的声明始终是"这个摘要是**生成时检出字节**的 sha256"——这一点不因本裁定改变，也**不允许**改变。校验侧新增的等价规则不触碰记录内容，只把"同一文本在**另一种**换行检出下"的裁决从 FAIL 改为**具名等价**；两侧共享**同一个变换定义**（仅 `CRLF↔LF`，版本 `eol-equiv-v1`），不存在两套摘要口径，也不存在"把不同口径混作内容相同"（等价命中与字节命中在输出与状态文件里是两个分开的计数/分类）。

### 2.3 什么仍然算漂移（不得被等价规则吞掉）

| 变化 | 判定 |
| --- | --- |
| 仅 CRLF↔LF | **等价 PASS**（具名分类） |
| 内容字符变化 / 行增删 / 空白变化（非换行） | **FAIL**（drift，打印 firstDifferenceOffset 与两侧摘要） |
| BOM 增删 | **FAIL**（`eol-equiv-v1` 不做 BOM 归一） |
| 二进制（含 NUL）或非法 UTF-8 | **FAIL**（不进入等价） |
| `executedSources` 条目畸形（绝对路径/`..`/盘符/非 hex） | **FAIL**（既有 T7-F2 语义不变） |
| 条目 digest 被替换但列表 digest 未同步 | **FAIL**（列表摘要重算） |
| 文件不可读 | **FAIL**（既有语义不变） |

### 2.4 写范围修正（**重要**，t3 原 inScope 有一条会破坏历史证据）

- t3 原 inScope 含 `scripts/eval/pr4a-five-arm-lib.ts`。该文件**在** `EXECUTED_SOURCES` 里（F-8），**任何**修改都会让历史产物 691/691 变红（且 `eol-equiv-v1` 也救不了：内容变了，不是换行）。
  → **裁定：t3 不得修改 `scripts/eval/pr4a-five-arm-lib.ts`，应从 t3 写范围中删除。**
- t3 允许写：`scripts/eval/verify-pr4a-artifacts.mjs`、`tests/unit/p62/pr4a-artifact-verifier.test.ts`（+ 若需要，新增**不被** `EXECUTED_SOURCES` 引用的辅助文件也**不允许**——因为只有生成侧脚本才会 import 它，而生成侧脚本不能改；校验器内联实现即可）。
- **生成侧**本批**不改**（`eval-pr4a-five-arm.mjs` / `pr4a-report.ts` 都在 `EXECUTED_SOURCES` 中）。若未来希望新记录自带 `normalizedSha256` 字段，那属于**新一轮实验**（新产物、新报告、显式版本），必须单独立项授权；本批只做校验侧，保证旧产物可携。

### 2.5 必须保持的历史不变量

- `work/pr4a-five-arm-eval.json` 与 `docs/reports/pr4a-five-arm-eval-report.md` 的**任何字节/数字**都不因本批改动而变化；五臂统计、阈值、结论文本原样保留。
- 691 这个"当前有效计数"会因 t3 增加断言而变化（新增具名分类断言等）。**历史 691 必须作为历史保留**，t16 记录"新计数 = 实测值；691 为 P0 轮历史值"，不得回写成"一直如此"。
- `pr4a-verify-status.json` 的 warning 语义：`provenance-executed-sources-eol-divergent` 这个旧 WARN id 在**全部条目都命中等价**时不再出现（改为 pass 分类）；只有当"部分等价 + 部分其他"或需要诊断时保留。**不得**删掉该 id 而不留迁移说明（t11 会核对）。

---

## 3. 决定 D3 — P1 配置原子契约

### 3.1 三个命名空间（唯一事实源）

| 命名空间 | 定义 | 现值 |
| --- | --- | --- |
| **OPTION_KEYS** | `EvoHarnessPluginOptions` 的**全部**键（26 个）：`dualTrack, config, model, host, clients, listClients, runBranch, deps, persistence, experienceFilePath, backfillFromTreePool, agentLoop, now, newId, commitScope, registerAutoFallback, autoFallbackEvents, applyWinningPatch, resolveDshCollaborators, route, enableIdleDream, dream, mirrorClient, hostAdvisor, scopeRegistry, hostAdvisorScope` | 当前只列 15 个（F-10） |
| **ROOT_KEYS** | `src/config.ts` 的冻结配置根键（10 个）：`schemaVersion, enabled, triggerMode, enabledSurfaces, probe, memoryBridge, dreamRsi, jitrl, execution, logging` | 已有，`config.ts:465` |
| **modelRoute** | 宿主专用组（`host-triggers.ts::splitModelRoute` 先从原始 section 摘出，再进冻结校验）；字段来自 `MODEL_ROUTE_FIELDS` | 已有 |

**不变式（必须机器校验）**：

- `OPTION_KEYS` **穷举** `keyof EvoHarnessPluginOptions`（编译期断言，见 §3.5）。
- `OPTION_KEYS ∩ (ROOT_KEYS ∪ {modelRoute}) = ∅`（运行期断言 + 测试）。注意 `model`（选项）与 `modelRoute`（宿主组）是两个不同键，不得混同；`route` 与 `modelRoute` 也是不同键。
- `config` ∈ `OPTION_KEYS`（它是"把配置挂在选项里"的显式键），但 `config` ∉ `ROOT_KEYS`（配置 section 里不允许出现 `config` 键——冻结校验会以 `unknown_key` 拒绝，这正是消除二义性的依据）。

### 3.2 形态判定（替换 `normalizePluginOptions` 的判定段）

```
normalize(second, ctxConfig):
  if second === undefined            -> { config: ctxConfig }  若 ctxConfig !== undefined；否则 {}
  if second 不是普通对象（null/字符串/数字/数组） -> THROW plugin-options-invalid-shape（不得静默忽略）
  keys = Object.keys(second)
  if keys.length === 0               -> {}        # 关键修复：空对象不再伪造 {config:{}} 吃掉 ctx.config
  if keys 里至少一个 ∈ OPTION_KEYS:
       if 存在 key ∉ OPTION_KEYS     -> THROW plugin-options-mixed-shape（列出冒犯键；提示 "配置放在 config 键下"）
       return second as EvoHarnessPluginOptions               # 选项形态（含 {config} / {model,config} / {dualTrack} …）
  else:
       return { config: second }      # 配置形态（含 {modelRoute:{…}}、完整 section）：交给冻结校验器产出 unknown_key 等
```

不变的行为（必须有回归测试）：`apply(ctx, {config:<section>, model, clients, runBranch, now, newId})`（现有 e2e 入口测试的形状）继续原样工作；`apply(ctx, {modelRoute:{…}})`（裸 section）继续工作；`apply(ctx, {schemaVersion:1, …})` 继续走配置形态。

### 3.3 反例（**逐条为实测**，不是设想；实测输出见 §8.4）

| # | 调用 | 当前实测行为（722625c） | 本 ADR 要求 |
| --- | --- | --- | --- |
| **C-1** | `apply(ctx, {})`，且 `ctx.config = {jitrl:{enabled:false}, execution:{mode:'off'}}` | 解析出 `mode='shadow'`、`jitrl.enabled=true` —— **ctx.config 被空对象吞掉** | 走 §3.2 → `{}` → 回落 `ctx.config`；解析出 `off` / `false` |
| **C-2** | `apply(ctx)`（无第二参） | `mode='off'`、`jitrl.enabled=false`（正确） | 保持（回归项，不得因 C-1 的修复退化） |
| **C-3** | `apply(ctx, {config:{}})` | **抛** `ConfigValidationError: unknown_key "config"`（因为被二次嵌套成 `{config:{config:{}}}`） | 选项形态：`config={}` → 显式覆盖为默认值（**合法**，与 C-1 区分） |
| **C-4** | `apply(ctx, {config:X, enabled:false})` | 抛 `unknown_key "config"`（错误信息指向 config，而不是说清"混合形态"） | `plugin-options-mixed-shape`，列出 `enabled` 冒犯键 |
| **C-5** | `apply(ctx, {config:X, execution:{mode:'off'}})` | 同上（抛 unknown_key "config"） | `plugin-options-mixed-shape`（列出 `execution`） |
| **C-6** | `apply(ctx, {config:X, jitrl:{enabled:false}})` | 同上（抛 unknown_key "config"） | `plugin-options-mixed-shape`（列出 `jitrl`） |
| **C-7** | `apply(ctx, {model, triggerMode:'always'})` | 返回选项形态，**`triggerMode` 被静默丢弃**（仍是默认 auto_fallback） | `plugin-options-mixed-shape`（列出 `triggerMode`） |
| **C-8** | `apply(ctx, {deps:{}, enabled:false})` | **插件照常挂载**，`config.enabled===true` —— 安全开关 `enabled:false` 被静默丢弃 | `plugin-options-mixed-shape`（列出 `enabled`）；绝不静默挂载 |
| **C-9** | `apply(ctx, {persistence:rt})` / `{dualTrack}` / `{scopeRegistry}` / `{route}` / `{agentLoop}` / `{dream}` / `{enableIdleDream}` / `{resolveDshCollaborators}` / `{backfillFromTreePool}` / `{experienceFilePath}` | 全部被误当成配置 section（`{config:{persistence:…}}`），随后 `unknown_key` | 全部识别为选项（`OPTION_KEYS` 穷举后自然成立），**不再误判** |
| **C-10** | `apply(ctx, {presistence:rt})`（拼写错） | 走配置形态 → `unknown_key "presistence"`（响亮但信息误导） | 同左（允许），措辞应提示"看起来像插件选项"；**不得**静默忽略 |
| **C-11** | `apply(ctx, {modelRoute:{provider:'p',model:'m',reasoningEffort:'ultra'}})` | 正常工作且 `plugin.modelRoute.reasoningEffort='ultra'` —— 枚举外值被接受 | 见 §3.6：由 `MODEL_ROUTE_EFFORTS` 单一来源校验，拒绝并具名（`model-route-effort-invalid`） |
| **C-12** | `apply(ctx, null)` | 返回 `{}`，**ctx.config 被丢弃** | `plugin-options-invalid-shape` |

### 3.4 `ctx.config` 保留规则（一句话）

`ctx.config` 只在两种情况下被替换：调用方**显式**给出选项形态且带 `config` 键（`{config: …}`，含 `{config:{}}` 显式清空）；或 `apply(ctx)` 的第二参为 `undefined`（此时 `{config: ctxConfig}`）。**其余任何情况都必须保留 `ctx.config`**；空对象不得伪造 `config` 键。

### 3.4.1 `{config: null}` 的裁定（R-03：先记录兼容性影响，再固定）

上游审核项 t12 O2 指出" `{config: null}` 语义未定义"。裁定前先按本 ADR 的规矩**测量现状并列出每条选择的兼容性影响**：

**现状实测**（可复算；命令与输出见 `docs/reports/p2-r-leftovers.md` R-03）：

- `normalizePluginOptions({config:null}, ctxConfig)` → `{config:null}`：`config` 是合法 OPTION key，因此走**选项形态**，`config` 键**存在**（不是 C-1 的空对象，也不是 C-12 的第二参为 `null`）。
- 入口 `readPluginSection` 用 `options.config ?? contextConfig(ctx)` 取值，`null` 与"未提供"同义 → **继承 `ctx.config`**。实测：`apply({config:{execution:{mode:'off'},jitrl:{enabled:false}}}, {config:null})` 解析出 `execution.mode='off'`、`jitrl.enabled=false`。
- 上下文没有 `ctx.config` 时（`apply({}, {config:null})`）回落到冻结默认（`mode='shadow'`、`jitrl.enabled=true`），与"省略 config 键"完全一致。

**三条候选与兼容性影响**：

| 候选 | 实测/推演影响 | 裁定 |
| --- | --- | --- |
| (a) **拒绝**（抛 `plugin-options-invalid-shape`） | 宿主用 YAML/JSON 写 `config:`（空值）时会被解析成 `null`；把"空值"升级为挂载期抛错，等于让一个**合法配置写法**变成不可用，且与 C-12（**第二参**为 `null` 才拒绝）在错误语义上撞名 | 不采纳 |
| (b) **显式清空**（等价 `{config:{}}`，用默认值覆盖宿主） | `config:null` 会用一个空 section 覆盖宿主已声明的 `execution.mode:'off'` / `jitrl.enabled:false`，即**静默放宽安全开关**——本 ADR 与全批授权边界都明令禁止 | 不采纳 |
| (c) **继承宿主配置**（等同"未提供 config 键"） | **零行为改动**：当前实现（`??`）已经如此，且方向是"保留宿主声明的安全开关"，不产生任何放宽 | **采纳** |

**裁定（固定为契约）**：`{config: null}` **既不是拒绝、也不是显式清空，而是"未提供配置" → 继承 `ctx.config`**（上下文也没有配置时等价于冻结默认）。它与 `{config:{}}`（唯一显式清空）和 `{config:<section>}`（显式覆盖）三态并列，语义由 `tests/unit/config/plugin-options-shape.test.ts` 的 `R-03` 用例固定。

**实现说明**：本裁定**不需要改 `src/index.ts`**（`options.config ?? contextConfig(ctx)` 就是该语义）；若未来要改成拒绝或清空，必须先改本节、补安全开关回归用例，并在报告里记录兼容性破坏面 —— 不允许静默变更。

### 3.5 穷举的机械化（编译期，双保险）

在 `src/index.ts` 内（不必新增公开导出）加类型级断言：

```ts
export const OPTION_KEYS = [ /* 26 个键，按字母序 */ ] as const;
type MissingOptionKey = Exclude<keyof EvoHarnessPluginOptions, (typeof OPTION_KEYS)[number]>;
/** 该行无法通过 tsc：新增公开选项却忘了登记时，MissingOptionKey 不为 never。 */
const _OPTION_KEYS_EXHAUSTIVE: [MissingOptionKey] extends [never] ? true : never = true;
```

（`EvoHarnessPluginOptions` 没有索引签名，`keyof` 是精确的；`[T] extends [never]` 避免裸 never 的分发陷阱。）`pnpm exec tsc --noEmit` 就是门禁；测试侧再补一条运行期断言 `OPTION_KEYS` 无重复、含 `config`，且与 `ROOT_KEYS ∪ {'modelRoute'}` 交集为空（测试可 import `normalizePluginOptions` 与 `validateEvoHarnessConfig` 的公开面，不要求新增导出）。

### 3.6 `modelRoute.reasoningEffort` 校验（t5 提供、t7 接线）

- **单一来源**：`MODEL_ROUTE_EFFORTS = ['high','max','low']`（既有）。禁止在别处再写一份枚举。
- **宿主配置路径**（`splitModelRoute`，`src/host-triggers.ts`）：遇到 `modelRoute.reasoningEffort` 存在但不在枚举内 → **抛具名错误**（`model-route-effort-invalid`，`ModelRouteEffortError`），**不得**静默回退默认值（静默回退就是"静默丢弃配置"）。这条不需要改 `src/index.ts`（入口已经调用 `splitModelRoute`）。
- **程序化注入路径**（`options.route.reasoningEffort`，`src/index.ts` 第二写者 t7）：同一校验函数，同样拒绝；类型上 `route.reasoningEffort` 若仍声明为 `string`，属公开类型过宽，由 t4 在**其第一顺位**窗口内一并收紧为 `(typeof MODEL_ROUTE_EFFORTS)[number]`（若 t4 判定会破坏现有测试，则只报告、由 t7 以运行期校验兜底，并在交付说明记录）。
- `provider` / `model` 保持既有语义（空值回退默认；不是本批范围）。

### 3.7 可观测性契约（t5 提供来源、t7 暴露到 status）

- `DshHostAdvisorStats` 增加**可选** `scopeUnknownSkipped?: number` 与结构化来源字段（`considered`/`excludedByDeclaration` 计数必须来自适配器/收集器的真实事件点，不得从别处推算）。
- **"未采集" ≠ "零发生"**：适配器不提供 `hostAdvisorStats` 时，入口**不得**把 `advisory/ask/noop/skipped` 报成 `0`（当前实测 F-15）；这些字段在 status 中应为 `undefined`（省略），只有适配器真的提供了统计时才是数字（可以是 0）。`EvoHarnessHostAdvisorStatus` 对应字段标 `?`。
- 零值、增量、序列化（JSON 往返）与"未运行"四种形态必须有入口级测试；**不得**携带工具参数/正文（ADR 0001 §2.3 延续）。
- **入口白名单（R-01 / t13 O2，已落地）**：`mapHostAdvisorStatus` 不再 `{...stats}` 原样转发，而是按 `HOST_ADVISOR_COUNTER_KEYS`（7 个公开计数，src/host-triggers.ts 单点定义，编译期双向穷举 + 计数见证）**逐键挑字段**。理由：公开 status 的**形状由入口负责**，不能依赖"来源自觉"——结构性适配器可能带回 `toolName` / 正文回显 / 私有计数，注入 canary 实测曾进入公开 status（t13 §O2）。白名单同时必须保留两侧不变量：实测 `0` 逐字保留（不得被 falsy 判断吞掉）、未采集/非数值仍为**省略**（不得伪造 `0`，F-15）。测试：`tests/unit/contracts/host-advisor-status-mapping.test.ts`。
- 风险预检：改动后若既有测试（如 `tests/unit/integration/p5-*.test.ts`）对"无 stats 适配器"断言了 `0`，**不得**为了变绿而弱化语义——应报告测试路径，由队长扩展该测试的写范围。当前实测：`p5-host-tool-wiring.test.ts:398-401` 用的是**真实 hook 适配器**（有 stats），因此不在风险面内。

---

## 4. 决定 D4 — 配置文档与 `check:docs` 强校验（t6）

1. **DEFAULT 叶子 75 个**（F-11 复算确认；数组按 1 个叶子）+ `modelRoute` 3 个字段（来自 `MODEL_ROUTE_DEFAULTS`）= **78 个必须有文档行**。README 当前精确覆盖 31 个 DEFAULT 叶子（另 4 个被 `dreamRsi.surrogateWeights` 合并行覆盖），**缺 40 个**（F-12）。
   - 要求：配置参考表**一行一个叶子路径**（`dreamRsi.surrogateWeights` 拆成 4 行；数组叶子用 `[]` 后缀，与实现路径一致）；新增 `jitrl.*` 37 行、`execution.*` 2 行、`dreamRsi.holdoutTreeCount` 1 行。
   - 校验器必须**从 `DEFAULT_EVO_HARNESS_CONFIG` 实际遍历**（不得硬编码 75 这个数字；数字只作为测试的 explain 文本），缺失叶子即失败并打印缺失路径。
2. **默认值一致性**：每个叶子行的 Default 列必须与实测默认值一致（布尔/数字按 `String(v)`，数组/对象按去空白的 JSON 字面量比较）。`memoryBridge.promoteOnComposeSuccess` 必须改为 **`false`**（F-13）。
3. **`modelRoute` 适用入口说明**：必须写清 `provider/model/reasoningEffort` 属于**二级设置页/`cordis.patch.yml` 的 modelRoute 组**（宿主专用），不是 `EvoHarnessConfig` 的根键——避免读者把它写成 section 根键（F-16 的接受面）。
4. **`check:docs` 失败语义**：读取的 Vitest JSON 必须断言 `numFailedTests === 0` **且** `numPendingTests === 0`（README 的措辞是 "passing tests"）；任一不满足 → exit 1 并打印失败/跳过测试名。**禁止**用"失败测试的报告"凑出计数绿灯（F-14）。
5. `test-results.json` 的临时/消费语义保持（消费后清理；不得把残留文件留进仓库根）。仓库根出现的 `test-results.json` 不得被提交（`.gitignore` 需要时由 t16 处理，t6 只在脚本内清理）。
6. **本任务不改全局测试计数**（新增测试的计数由 t16 统一同步）；t6 只改 README 的**配置参考**章节与文档校验脚本/测试。

---

## 5. 决定 D5 — Mutation 门禁与 Node24 CI（t8）

### 5.1 四个变异体（目标缺陷、变异、期望红集）

| # | 目标缺陷（用户登记） | 变异位置（稳定锚点，不用行号） | 必红测试（**按测试名钉死**，红数作为观察值） |
| --- | --- | --- | --- |
| M1 | provenance 展开丢失（R1-M1） | `src/cordis-seams/eight-surfaces.ts::mountSurface` 中 `base` 对 `origin/guidance/role/allowAdvice` 的 4 行展开 → 删除 | `tests/e2e/provenance-chain.test.ts` 中 scenario 1/2/5/6 的用例名（应 4 红；scenario 3/4 保持绿） |
| M2 | collector 未知身份拒绝分支（R1-M2） | `src/jitrl/host-tool-experience.ts::observeToolCall` 的 `if (!scopeInfo.isKnown) { … }` 拒绝块 → 删除 | e2e `provenance-chain.test.ts` scenario 4；unit `tests/unit/jitrl/host-tool-experience.test.ts` 的 D1 strict default 两条（应 1 红 + 4 红） |
| M3 | 赢家私有标尺分叉（R3-M1） | `recordOnlineExperience` 中赢家 → `winnerRewards` 均值的分叉恢复（非赢家仍走 `scoreUnderRewardContract`） | `tests/unit/orchestrator/credit-attribution.test.ts -t "P6.1-D 7.4"` 的"同轨迹同尺度"与"judge 缺失不改语义"（**注册必红 2**；**观测红 3**，含 1 条额外判别用例 — 见下方口径注） |
| M4 | `readLearningTarget` gain 优先（R3-M2） | 改成 `learningTarget` 优先、`observedReturn` 回退 | `tests/unit/jitrl/value-estimator.test.ts` 的 "reads observedReturn first" 与 "estimateStateValue averages the contract target, not the gain field"（应 2 红） |

**门禁语义（硬性）**：

1. **判据是"必红集合 ⊆ 实际红集合"**，不是红数相等：测试数量会随 P1 增长，钉死红数会让门禁因"新增测试"而假红。观察到的红数写进输出与文档（供 t16 记录），但不作为失败条件。
2. **隔离执行**：变异体只在临时副本里应用（例如 `os.tmpdir()` 下拷贝 `src/ tests/ scripts/ tsconfig.json vitest.config.ts package.json`，并用 `pnpm exec vitest run --root <tmp>` / 仓库内的 vitest 二进制），**绝不在**仓库工作树里就地变异。理由：(a) `src/`、`tests/`、`scripts/` 正是 attestation 的摘要根，就地变异一旦中断会污染 `pnpm run attest:verify`；(b) 副本法天然满足"失败路径恢复字节并清理临时状态"（真实工作树从未被写）。
3. **基线控制**：每个变异体运行前，先在**同一个副本**上跑一次目标测试，要求全绿；否则该变异体的"红"无判别力（防止把环境失败当成击杀）。
4. **自证变异真的落地**：记录"变异前/后目标文件 sha256"并在输出中断言两者不同；若变异没落地 → FAIL（防"空转变异"）。
5. **源码零残留**：结束时断言仓库工作树的 4 个目标文件 sha256 与开始时一致（本仓工作树从不被写），并清理临时目录。
6. `--run` 是全量执行入口；`tests/unit/eval/mutation-gate.test.ts` 只测**纯函数**（解析变异规格、红集判定、路径安全、恢复语义），**不得**在 Vitest 里真的跑 4 个变异（会有递归/超时风险）。
7. 不引入 Stryker 等新依赖；不写任何被测源码的"永久补丁"。

**M3 红数口径（R-07 记录；t15 O1 / t21 复核）**：M3 的**注册必红集合是 2 条**（`tests/unit/orchestrator/credit-attribution.test.ts` 的"同轨迹同尺度"与"judge 缺失不改语义"，即 `scripts/eval/mutation-gate.mjs` M3 `mustRed` 注册值），**实测观测红 3 条**——多出的第 3 条是 `"scores a succeeded sibling from its own verifiable signals, not the winner vector"`（门禁按**整文件**跑，而注册值按 `-t "P6.1-D 7.4"` 过滤重放计），它同样检测"赢家私有标尺"回归，属**更强的额外判别力**。判据是"必红集合 ⊆ 实际红集合（按名字）"，额外红只进 `extraRed` 观察、**不参与判据也不改判据**；记录时必须写"**must-red 2/2、观测红 3（含 1 条额外判别用例）**"，**不得**把 3 写成注册必红数，也不得反向简写。证据：`docs/reports/t15-mutation-node24-review.md` §表格/O1、`docs/P62_STATUS.md` §5.2 行、`docs/reports/p2-r-leftovers.md` R-07。

### 5.2 CI 接线（mutation + Node24）

- `package.json` 新增 `"check:mutation": "node scripts/eval/mutation-gate.mjs --run"`（t8 只加这一个键，不碰 t2 的 attestation 键）。
- `ci.yml` **追加**（不改既有 job）：
  - `mutation-gate` job（ubuntu，Node 22，`timeout-minutes` ≥ 30，checkout `persist-credentials: false`，安装同现有方式）：步骤 `pnpm run check:mutation`。
  - `node24-compat` job（ubuntu，`actions/setup-node` **显式** `node-version: '24'`，pnpm 11.7.0）：`pnpm install --frozen-lockfile` → `pnpm exec vitest run tests/unit` → `node scripts/eval-jitrl.mjs --json` → `node scripts/eval/negative-result-diag.mjs --assert`；job 名必须含 "Node 24"，**不得**复用 runner 预装的 node 冒充（必须 setup-node 显式安装，输出里打印 `node -v`）。
- **两种失败语义**：Node24 红 = 兼容性问题，**不**改写 Node22 的官方计数与结论（README 计数仍来自 Node22 `verify`）；mutation 红 = 判别力丢失。
- 远端实测：`722625c` 的 Actions 结果未验证；Node24 的 CI 结论只能在推送后的运行日志里首次成立。本机只有 v22.23.1（F-17），t9 **不得**写"Node24 已本地实测"。

---

## 6. 决定 D6 — 排他写范围与单写者顺序

### 6.1 写范围（按任务；同一路径同一时间只有一个写者）

| 任务 | 排他写范围 | 明确禁止 |
| --- | --- | --- |
| **t2** attestation 门禁（evidence-engineer） | `scripts/eval/final-attestation.mjs`（只加导出/常量，不改既有语义）、`scripts/eval/final-attestation.node-test.mjs`、**新增** `scripts/eval/check-attestation-target.mjs`、`scripts/eval/check-attestation-target.node-test.mjs`（若拆分）、`.github/workflows/ci.yml`（**只追加** `attestation-target` job）、`package.json`（**只** attestation 键，可选） | `src/**`、`tests/**`、`README.md`、`docs/reports/final-attestation.json`（不得重生成）、`scripts/eval/verify-pr4a-artifacts.mjs` |
| **t3** PR-4A 可携性（evidence-engineer，**在 t2 之后**串行） | `scripts/eval/verify-pr4a-artifacts.mjs`、`tests/unit/p62/pr4a-artifact-verifier.test.ts` | **`scripts/eval/pr4a-five-arm-lib.ts`（删除，见 §2.4）**、`EXECUTED_SOURCES` 的 7 个文件、`work/pr4a-five-arm-eval.json`、`docs/reports/pr4a-five-arm-eval-report.md`、`src/**`、README |
| **t4** 配置原子入口（entrypoint-engineer，**src/index.ts 第一写者**） | `src/index.ts`、`tests/unit/config/plugin-options-shape.test.ts`（新增） | `src/config.ts`、`src/host-triggers.ts`、README、CI、package.json |
| **t5** 可观测性来源 + effort 校验（observability-engineer，与 t4 **并行**但**不写 index.ts**） | `src/cordis-seams/dsh-hook-host-adapter.ts`、`src/types/contracts.ts`、`src/host-triggers.ts`、`tests/unit/seams/status-observability-contract.test.ts`（新增）、`tests/unit/config/model-route-effort.test.ts`（新增） | **`src/index.ts`**、`src/dsh-bridge/model-config.ts`（如需见 §3.6 的报告路径）、README、CI |
| **t6** 配置文档 + docs 门禁（docs-engineer，**与实现并行**） | `README.md`（**只**配置参考/命令表相关章节）、`scripts/verify-readme-counts.mjs`、`tests/unit/config/readme-default-leaves.test.ts`（新增） | **全局测试计数**（t16 统一）、`src/**`、`.github/workflows/ci.yml`、`package.json` |
| **t7** 状态/可观测性接线（entrypoint-engineer，**src/index.ts 第二写者**，依赖 t4+t5） | `src/index.ts`（在 t4 最新文件上增量；不回退 OPTION_KEYS/混合拒绝）、`tests/unit/seams/status-observability.test.ts`（新增） | `src/config.ts`、`src/host-triggers.ts`（如需改接口，先由 t5 落地）、README、CI |
| **t8** mutation + Node24（gates-engineer，**在 t2 之后**串行；CI/package 第二位写者） | `scripts/eval/mutation-gate.mjs`（新增）、`tests/unit/eval/mutation-gate.test.ts`（新增）、`.github/workflows/ci.yml`（**只追加** `mutation-gate`/`node24-compat` job）、`package.json`（**只** `check:mutation`） | `verify`/`guarded-regression` 既有步骤、t2 的 `attestation-target` job、`src/**` 的永久改动（变异只在副本） |
| **t9** 独立验证（integration-engineer） | 只读 + `work/` 下的验证输出；**不写**任何实现文件 | 全部实现路径 |
| **t10–t15** 独立审核（architect-reviewer） | 只写 `docs/reports/t*-*.md` 审核报告 | 全部实现路径 |
| **t16** 集成文档（integration-engineer） | `README.md`（**全局计数** + Packaging status）、`docs/P62_STATUS.md`、`DEVELOPMENT_LOG.md` | `src/**`、scripts、CI、package.json（如需改代码 → 退回对应修复流程） |

### 6.2 `src/index.ts` 单写者顺序（硬顺序）

```
t4（配置原子：OPTION_KEYS 穷举 / 混合拒绝 / ctx.config）
  └─► t7（状态与可观测性接线：scopeUnknownSkipped / considered / excludedByDeclaration；route effort 运行期校验）
```

- t4 完成并由 t9 记录后，t7 才读**最新**文件；t7 的验收包含"重跑 t4 的 plugin-options-shape 测试全绿、不回退"。
- **没有第三个 writer**：t5 只提供来源与类型；t2/t3/t6/t8 一律不写 `src/index.ts`。任何后续修复如果必须再动 `src/index.ts`，由队长按同一"单写者顺序"追加（先读最新文件、再增量、再让 t9 复验），不得并发。

### 6.3 `.github/workflows/ci.yml` / `package.json` 双写者顺序

```
t2（attestation job；package.json 可选 attest 键）
  └─► t8（mutation/node24 job；package.json check:mutation 键）
```

- t8 必须先读 t2 提交后的最新文件；**只追加**，不改 t2 的 job/步骤；`package.json` 的 JSON 必须保持合法（tests 会解析）。
- 全部 action 继续固定到完整 commit SHA；每个 checkout 保留 `persist-credentials: false`（现有不变量）。新增 job 的 checkout 需要历史时显式 `fetch-depth: 0`。
- t9 的 CI 静态校验：解析 `ci.yml`（至少断言 job 名单 = {verify, guarded-regression, fingerprint, fingerprint-parity, attestation-target, mutation-gate, node24-compat}，且每个 `uses:` 都是 40-hex pin）。

### 6.4 README 全局计数集成点（唯一写者 t16）

- 唯一允许改全局计数的时点是 **t16 集成**（且必须在 t9 全量实测之后）；实现任务最多新增测试文件，**不得**改 README 里的计数。
- 必须保持 `verify-readme-counts.mjs` 的三组正则与表格行格式可匹配（`reports \`N\` test files and \`M\` passing tests for \`pnpm run test\``、`| \`pnpm run test:unit\` | \`tests/unit\` | N files, M tests |`、e2e 行、total 行）。
- 计数必须来自**同一次** Node22 全量 Vitest 运行（97/1979 是 rev.4 历史值，P1 会变）；`check:docs` 的 SUCCESS 输出要贴到 t16 交付里。
- 历史数字（86/1666、95/1878、97/1979 等）一律保留在历史章节，不回写。

### 6.5 本地 / 远端授权边界

| 动作 | 本轮（t1–t16） | 授权要求 |
| --- | --- | --- |
| 修改工作树、跑本地门禁 | 允许 | 无需额外授权 |
| `git commit` | **禁止**（实现任务不提交；t9/t16 也不提交） | 需用户明确授权（rev.4 先例：授权后才提交） |
| `git push` / force-push | **禁止** | 需用户明确授权；**永不 force、不改写历史** |
| 重生成 `docs/reports/final-attestation.json` | **禁止** | 需用户授权；且必须在干净树、`--expect-commit <已存在的代码提交>`、单独证据提交（§1.6） |
| 读取/引用远端 Actions 结果 | 只引用**真实运行日志**（run URL + job 状态） | 不得预写、不得伪造；本地绿 ≠ 远端绿 |
| 调用真实付费模型 / 重新跑 PR-4A 实验 | **禁止** | 需单独授权（本批 PR-4A 只做校验侧，不重跑） |
| 修改历史统计/负结果/历史报告 | **禁止** | 无授权通道（红线） |

**提交拓扑（授权后执行时的顺序）**：代码提交（可多个）→ 推送 → 在**已存在的**代码提交上生成记录 → 证据提交（marker + record-only）→ 推送。**不得**把记录与代码混在同一提交（T3 纯度规则会把这种提交判红）。

---

## 7. 交叉一致性检查（本 ADR 不自相矛盾的自检）

| 检查 | 结论 |
| --- | --- |
| D1 的"普通提交 PASS"是否会与 D4/D5 的"门禁必须严格"冲突？ | 不冲突：D1 回答"记录绑定是否成立"，`fingerprint` 回答"本次 revision 的代码是否被现场测量"；两问分离且都在 CI 有执行者 |
| D1 要求"证据提交记录 = HEAD^1"，与"记录不能覆盖自身提交"是否冲突？ | 不冲突：记录覆盖的是**父**提交；`docs/` 不在摘要根内（F-3），不存在自指不动点 |
| D2 的等价规则会不会让"M1/M2 变异未被杀死"更隐蔽？ | 不相关：变异门禁跑的是**测试**，不是 PR-4A 摘要；等价规则只作用于 `executedSources` 的字节比较 |
| D2 改校验器会不会让历史 691 计数"变好看"？ | 不会：691 是断言计数，t3 会新增断言（计数上升），历史 691 作为历史保留；统计数字零改动 |
| D3 的"混合拒绝"会不会破坏现有 host 调用？ | 不会：唯一现存 options+config 调用（`tests/e2e/plugin-entry.test.ts:96`）是纯选项形态（`config` 是选项键），§3.2 保持；裸 section（含 `modelRoute`）继续走配置形态 |
| D5 在副本里变异，会不会绕开"真实工作树"的证明力？ | 不会：副本是同一 git 工作树的完整拷贝，测试与源码同一份内容；且副本法额外证明"变异确实改变目标文件字节"（§5.1-4） |
| D5 的"红集 ⊆ 实际红集"是否弱于用户要求的"预期红数准确"？ | 不弱：必红集合按**测试名**钉死（比计数更精确）；红数作为观察值记录，避免测试增长造成的假红 |

---

## 8. 证据附录（本轮实测；可复现）

### 8.1 环境与基线

```bash
git rev-parse HEAD origin/main            # 722625c…, 722625c…
git rev-list --left-right --count origin/main...HEAD   # 0	0
git status --porcelain                    # (empty)
node -v && pnpm -v && git --version       # v22.23.1 / 11.7.0 / 2.55.0.windows.3
node -e "const r=require('./docs/reports/final-attestation.json');console.log(r.schemaVersion,r.commit.commitId,r.commit.base,r.fileCount,r.roots)"
# 2.1.0 56f846ae… null 249 [ 'src', 'tests', 'scripts' ]
```

### 8.2 可行性原型（证据提交规则；脚本在 `work/`，不进仓库）

`node work/_t1_proto_evidence_commit.mjs work/_t1_proto_repo` 在一个临时仓库里构造真实提交并逐条重放规则，13/13 PASS：

| 验证点 | 结果 |
| --- | --- |
| 代码提交 C 上生成记录（干净树 + `--expect-commit C`） | PASS（exit 0） |
| 记录 `roots` 不含 `docs/`（自指不倒） | PASS（`["src","tests","scripts"]`，`fileCount=3`） |
| `git interpret-trailers --parse` 提取 `Attestation-Target: first-parent` | PASS |
| 证据提交只改规范记录（record-only） | PASS（`["docs/reports/final-attestation.json"]`） |
| 证据提交非合并、第一父 = C | PASS |
| `--verify --expect-commit C` 在证据提交工作树 exit 0 | PASS |
| `--strict` 在证据提交上 **exit 1 `attestation-head-mismatch`**（证明为什么不能用 `--strict`） | PASS（红） |
| 无条件 `--expect-commit HEAD^1` 在**普通提交**上 exit 1 `attestation-target-mismatch`（证明宽松 HEAD^ 猜测不可用） | PASS（红） |
| 普通提交保持自洽语义（无目标）exit 0 | PASS |
| 带标记但记录指向更早提交 → 绑定失败 | PASS（红） |
| 手改 `commitId` 后连自洽校验也失败 | PASS（红） |

> 实施提示（原型踩到的真问题）：`final-attestation.mjs` 的 `--cwd` 默认是**脚本自身所在仓库**，夹具仓必须显式传 `--cwd <abs>`；否则会在本仓上取数并给出看似合理的错误结论。

### 8.3 PR-4A 现状（本轮实测）

```bash
node scripts/eval/verify-pr4a-artifacts.mjs     # checked=691 passed=691 failed=0, exit 0
# 7 个 executedSources 与磁盘逐字节一致（recorded == disk，7/7 match）
```

- 生成侧 `fileSha256` 读工作树原始字节；校验侧 `isEolOnlyDivergence` 已能把"仅 CRLF/LF"与"内容漂移"区分开（现有实现），本裁定只是把前者的**裁决**从 FAIL 升级为具名 PASS 分类。
- 当前 WARN `provenance-executed-sources-eol-divergent` 只在 eol-only 时出现，且整轮 FAIL；这正是"F1 可携性边界"的可观测形态。

### 8.4 配置反例实测（`work/_t1_config_probe.mjs`，跑的是真实 `apply()`）

| 探针 | 实测输出（节选） |
| --- | --- |
| `normalize({config:{enabled:false}})` | `{config:{config:{enabled:false}}}`（二次嵌套） |
| `normalize({})` + ctx.config | `{config:{}}`（伪造空配置，会吞掉 ctx.config） |
| `normalize({persistence:{}})` | `{config:{persistence:{}}}`（选项被当成配置） |
| `normalize({dualTrack:{}})` / `({scopeRegistry})` / `({route})` | 同上（均被当成配置） |
| `normalize({model, triggerMode})` | 原样返回选项（`triggerMode` 静默丢失） |
| `apply(ctx,{})`（ctx 配置 off/false） | `mode='shadow'`, `jitrl.enabled=true` |
| `apply(ctx)` | `mode='off'`, `jitrl.enabled=false` |
| `apply(ctx,{config:{}})` | 抛 `unknown_key "config"` |
| `apply(ctx,{deps:{},enabled:false})` | `mounted=true`, `config.enabled=true`（安全开关被吞） |
| `apply({},{modelRoute:{…,'ultra'}})` | `route.reasoningEffort='ultra'`（枚举外值被接受） |
| `createEvoHarnessPlugin({}).jitrl.hostAdvisor` | `advisory:0, ask:0, noop:0, skipped:0`（无 stats 也报 0；无 `scopeUnknownSkipped` 字段） |

### 8.5 默认叶子与 README 覆盖（本轮复算）

- `DEFAULT_EVO_HARNESS_CONFIG` 叶子 **75**（分组：root 4 / probe 2 / memoryBridge 12 / dreamRsi 16 / jitrl 37 / execution 2 / logging 2）。
- README 精确路径行覆盖 **31**，`dreamRsi.surrogateWeights` 合并行再覆盖 4 → 35；**缺 40**（清单见 F-12）。
- `memoryBridge.promoteOnComposeSuccess`：默认 `false`，README 写 `true`（F-13）。

### 8.6 编译期穷举机制实测（§3.5 的可行性证明）

用真实 `EvoHarnessPluginOptions` 跑两次 `tsc`：

- 26 键全集 → **0 error**（能通过）；
- 只列 `['config','model','host']` → **`error TS2322: Type 'true' is not assignable to type 'never'`**（恰好落在"缺键"那行）。

即：新增公开选项却忘记登记时，`pnpm exec tsc --noEmit`（门禁 #1）会红——该断言不是装饰。

```bash
# 正例：0 error
.\\node_modules\\.bin\\tsc.cmd --noEmit --strict --skipLibCheck --module esnext \\
  --moduleResolution bundler --target es2022 --allowImportingTsExtensions work/_t1_coverage_check.ts
# 反例：Type 'true' is not assignable to type 'never'（缺 23 键）
.\\node_modules\\.bin\\tsc.cmd --noEmit --strict --skipLibCheck --module esnext \\
  --moduleResolution bundler --target es2022 --allowImportingTsExtensions work/_t1_coverage_negative.ts
```


---

## 9. 任务验收追溯矩阵

| t1 验收条款 | 本 ADR 章节 | 可执行判据 |
| --- | --- | --- |
| ① 证据提交目标规则：拓扑、父/代码提交绑定、例外、CI 失败语义；不得恒红 HEAD 或宽松 HEAD^ | §1.2–§1.7（拓扑表 §1.3、判定算法 §1.4、CI §1.5、过渡 §1.6、否决方案 §1.1） | 原型 13/13（§8.2）+ t2 的 node-test 覆盖 T0–T8 + CI 独立 job |
| ② PR-4A：明确重生成 vs 版本化规范化摘要；生成/校验同口径；不改历史统计结论 | §2.1–§2.5 | t3 的 `eol-equiv-v1` 具名分类 + 双向换行用例 + 691 历史保留 + `EXECUTED_SOURCES` 零改动 |
| ③ 配置契约：OPTION_KEYS 穷举、ROOT_KEYS∪modelRoute 不相交、混合拒绝、ctx.config 原子落地、反例 | §3.1–§3.7（反例 C-1…C-12 全部实测于 §8.4） | t4 的编译期断言 + t4/t7 测试逐条对应 C-1…C-12 |
| ④ 排他写范围、index.ts 单写者顺序、README 计数集成点、本地/远端授权边界 | §6.1–§6.5 | t9 核对写者顺序与工作树证据；t16 唯一计数同步；§6.5 授权表逐条落地 |

---

## 10. 对既有任务的修正（需要在派发实现前生效）

1. **t3 写范围**：删除 `scripts/eval/pr4a-five-arm-lib.ts`（在 `EXECUTED_SOURCES` 中，改它即毁历史证据，§2.4）；t3 只写 `verify-pr4a-artifacts.mjs` 与其专属测试。
2. **t3 验收措辞**：把"生成侧 fileSha256 与校验侧 executedSources 摘要口径一致"落为"**原始摘要保持为字节事实 + 校验侧版本化等价规则**"；不要求在生成侧新增字段（生成侧改动被 §2.4 禁止）。
3. **t2 新增文件**：`scripts/eval/check-attestation-target.mjs` 已在 t2 inScope；补一条"CI 独立 `attestation-target` job（`fetch-depth: 0`）"。
4. **t5/t7 接口**：`DshHostAdvisorStats.scopeUnknownSkipped?` 与"未采集 ≠ 零"的语义由 t5 定类型、t7 落地到 status（§3.7）；`src/index.ts` 只允许 t4→t7 顺序写。
5. **t8 判据**：mutation 以**必红测试名集合**为判据（红数只作观察值，§5.1）；Node24 以 CI 实跑为准，本地不得宣称（F-17）。
6. **t16 集成点**：全局计数只在 t16 同步；691（PR-4A）与 97/1979（Vitest）作为历史值保留，新增实测值并列记录；`P62_STATUS`/`DEVELOPMENT_LOG` 的 F1 表述更新为"eol-equiv-v1 后 LF 检出可复验；历史 691 仍为当时计数"，**不删历史**。

---

## 11. rev5 诊断面与公开键同步（t10，A-t10-15）

本节记录 rev5 P1/P2 新增的**只读诊断面**与它们对公开契约的影响。原则不变（§3.1）：公开选项键只有 `OPTION_KEYS` 那 26 个，**新增任何顶层键都要先改本节并让 `plugin-options-shape` 测试同步**；本节的所有新增都**不是**选项键。

### 11.1 新增的只读状态（`src/index.ts`，增量、无宿主副作用）

| 公开键 | 形态 | 语义边界 |
| --- | --- | --- |
| `plugin.surfaces: EvoHarnessSurfaceStatus[]` | 8 项，恒有 | `enabled` = `config.enabledSurfaces` 事实；`mountable` = 解析出的适配器是否暴露该 seam 方法；`lastMountResult`/`seamUnavailable` 只在适配器留下挂载记录时出现（**未采集 ≠ 0**，F-15）；`cacheRead` 恒为 `'unknown'`（本进程无读缓存测量点，不得猜命中率） |
| `plugin.evaluateTextProbe(input?)` | 纯函数投影 | 文本探针恒返回 `not-evaluable`（含稳定 reason code）；`TextProbeEvaluation` **只**携带 `reward: 0`（字面量 0，永不为正）与 `evaluable: false`，**没有** score/passed 字段，因此"正奖励"或"文本探针通过"在类型层不可构造 |
| `agentLoop.safety`（**嵌套**在既有 `agentLoop` 键内） | `ProbeSafetyGate` | 缺省即惰性（`checks: 0`，行为与本轮前完全一致）；存在即 fail-closed：只读 allowlist → 授权账本，两级都要过；拒绝返回结构化错误，永不回落到执行 |

`plugin.surfaces` 与 `plugin.evaluateTextProbe` 都是 `EvoHarnessPlugin` 句柄上的增量成员，不进入 `OPTION_KEYS` / `ROOT_KEYS`，因此 §3.2 的形态判定与 `plugin-options-shape` 的 26 键断言不变（本轮 `pnpm run typecheck` + `tests/unit/meta` 全绿即为同步证据）。

### 11.2 新增的结构化计数（诊断可判定，不是宣传口径）

| 位置 | 计数 | 恒等式 / 不变量 |
| --- | --- | --- |
| `dshHookAdapter.stats().surfaceMounts[]` | `attempts / ok / failed / seamUnavailable / lastResult` | 每个 surface 一条；`failed` 只由真实抛出的错误累加，`seamUnavailable` 只由 `code === 'seam_unavailable'` 累加 |
| `ProbeSafetyGate.stats()` | `checks / allowed / denied / byCode / allowlistTier / authorizationTier / branchChecks / hostChecks / branchNoPolicy` | `checks === allowed + denied`；`branchChecks + hostChecks === checks`；`ΣbyCode === checks`；**装了分支策略时 `branchNoPolicy === 0`**（`validateProbeSafetyCounters` 对它 fail-closed） |

`branchNoPolicy` 是这一轮新增的唯一硬不变量：`ToolFaceRegistry.decide` 对"分支无策略"按设计透明放行（宿主级调用需要这种透明），但一条**分支**探针调用落在透明分支上就等于无围栏执行 JitRL 建议的工具，因此闸门把它判为 `no-policy` 拒绝并计数。`branchNoPolicy === 0` 才说明装配路径正确。

### 11.3 与 §3.7（可观测性契约）的关系

§3.7 规定"未采集的字段缺席，而不是补 0"。本节的三处新增都遵守同一条：

- `surfaceMounts` 在适配器从未挂载任何面时仍列出 8 条记录（`attempts: 0`），这是**真实测量到的零**；而 `plugin.surfaces` 在没有任何挂载记录时**省略** `lastMountResult`/`seamUnavailable` 两键；
- `ProbeSafetyGate` 未配置时 `checks: 0` 且 `allowlistTier.checks === 0`：它报告"没有测量"，不报告"全部放行"；
- 文本探针不产出任何分数，也不产出 0 分——0 分会把"不可评估"污染成"评估为零收益"。

### 11.4 不声称什么

- 本节不声称八表面在真实宿主上全部 `native`：rc2 的逐面表是 `native=3 / not-run=5`，`not-run` 的原因（裸 Cordis Context 不注入服务 seam）写在表里；
- 不声称 `cacheRead` 有任何测量；
- 不声称两级闸门已在真实宿主默认启用：`agentLoop.safety` 需要宿主显式注入，缺省惰性。P1/P2 的证据是单元测试与 rc2 的行，不是 Gate 4 通过。
