# t21 — 最终 P1 发布审核（round 1）

- **被审对象**：t20 收口后的**当前工作树最终字节**（t18/t19/t20 全部改动 + t16 集成文档 + 六份审核报告 + ADR 0005）；以 t20 为 reviewedTaskId
- **审核人**：architect-reviewer（只读审核；未改任何实现。仅：修正本人 t10 报告的 1 处行尾空白、向本人 t11/t14 报告追加实测附录）
- **结论**：**verdict = needs_revision**——**代码、ADR、测试与全部门禁均绿且无新缺陷**；但发布台账 `docs/P62_STATUS.md` / `DEVELOPMENT_LOG.md` 仍把已修复的两个 low 发现记为「未修」、并有 5 处 t18 之前的旧计数/失效交叉引用。**两项 finding 均为文档事实性修订，不否定任何已审核代码**（见 §6）。修好后可直接提交。
- **日期**：2026-10-29；基线 HEAD `722625c65ac2fbce6e8b6c91565e7fd2dcaddae7`（未提交）；Node `v22.23.1`

---

## 1. 审核方法

1. **当前字节复验（我本人跑，12 条 verify 全部 exit 0）**：`work/_t21_review/verify-all.mjs` 按 CI 同构顺序执行 typecheck → vitest（`--outputFile=test-results.json`）→ `check:docs`（消费同一报告）→ check:encoding → build-smoke → negative-result → guarded-regression → `check:mutation` → `node --test` → `check-attestation-target` → `attest:verify` → `verify-pr4a-artifacts`；另跑 fresh JSON 报告、t11 LF e2e harness、t12/t13 探针、t14 独立 harness。
2. **逐字节与卫生**：15 个未跟踪交付物 + 14 个已修改 tracked 文件的 sha256 清单（§3）；LF/BOM/NUL/行尾空白扫描（全部 0 问题）；无根 `test-results.json`、无 `work/docs-verify-*`、无 `mutation-gate-*` 残留；refs 9 / worktrees 1 / stash 0 / HEAD 未变。
3. **六项审核 + t18/t19/t20 收口的逐项处置核对**（§4），并核对 t11/t13/t14 的字节绑定（§5）。
4. **台账事实性审计**：P62_STATUS / DEVELOPMENT_LOG 的计数、f2 引用与「观察是否已修」的陈述对回当前字节。

---

## 2. 当前字节验证矩阵（全部 exit 0）

| # | 门禁 | 结果 |
| --- | --- | --- |
| 1 | `pnpm run typecheck` | exit 0 |
| 2 | `pnpm exec vitest run`（CI 同构：default+json → `test-results.json`） | **103 files / 2094 tests**，passed 2094、failed/pending/todo 0；unit 90/1935 + e2e 13/159 |
| 3 | `pnpm run check:docs`（消费 #2 的**同一份**报告） | SUCCESS；`103`/`2094`、unit `90`/`1935`、e2e `13`/`159` 机械匹配；78 rows vs 78 expected；根报告被消费后删除 |
| 4 | `pnpm run check:encoding` | SUCCESS（tracked blobs 全 LF 或显式 `-text`） |
| 5 | `pnpm run check:build-smoke` | SUCCESS（`lib/index.js` **1007959 bytes**、ESM import、**70** named exports） |
| 6 | `pnpm run check:negative-result` | A1..A6 PASS（历史负结果 −0.250 完整保留） |
| 7 | `pnpm run guarded-regression` | `{total:37, passed:37, failed:0}` |
| 8 | `pnpm run check:mutation`（完整跑，非 `--validate`） | **verdict PASS**：M1 4/4、M2 3/3、M3 2/2、M4 2/2 必红命中；基线 6/24/30/34 全绿；4/4 sha changed；worktree zero-residue；副本 removed |
| 9 | `node --test` 双套件 | **79 pass / 0 fail / 0 skipped / 0 todo** |
| 10 | `node scripts/eval/check-attestation-target.mjs --json` | exit 0，真实仓 **ordinary PASS**（记录 `56f846ae…` 为 `HEAD=722625c…` 祖先）；零写入 |
| 11 | `pnpm run attest:verify` | exit 0；记录 `675acf79…` **未重生成**；如实打印 branch-moved / HEAD-not-covered 两条 informational |
| 12 | `node scripts/eval/verify-pr4a-artifacts.mjs` | **691/691，failed=0**；`eolEquivalents=[]`、`warnings=[]`（生成检出 7/7 raw match） |

**补充实测（当前字节）**：
- **t11 LF e2e 复跑（17/17）**：真实产物 × 全新 LF 检出 → exit 0、**checked=692、passed=692、failed=0**（691 + 1 条等价分类；t18 的重复推入已删）；`eolEquivalents=2`；混合态 → exit 1，`failures` **仅** `provenance-executed-sources-match-disk`，等价 id 不再落入 failures；BOM/二进制/尾换行/伪造 digest 仍 FAIL；真实产物哈希不变（`f22bdb14…` / `acae3d33…`）。
- **t12 配置探针 47/47**、**t13 可观测性探针 34/34**（当前字节；t19 只改注释，行为未变）。
- **t14 文档 harness 复跑 32/32**（当前 README 2094/1935 vs 最新报告；叶子变异 6 向、报告变异 5 向、failed/pending/todo 拒绝均成立）。
- **目标化回归**（`tests/unit/{p62,config,seams,eval}`）：**12 files / 324 tests 全绿**（t18 +2）。

**残留检查**：根 `test-results.json` 不存在、`work/docs-verify-*` 0、`$TMP/mutation-gate-*` 0、refs 9 / worktrees 1 / stash 0、`git status` 与审核前一致。

---

## 3. 当前字节清单（提交前基线）

| 文件 | sha256（前 16） | 说明 |
| --- | --- | --- |
| `.github/workflows/ci.yml` | `0823109C02628211` | t2 attestation-target + t8 mutation/node24，append-only |
| `README.md` | `EBFF7D09C0ED8CD9` | 78 行配置参考 + 计数 103/2094、unit 90/1935 |
| `package.json` | `D5DA0A5243C465BE` | 仅 `check:mutation` |
| `scripts/eval/final-attestation.mjs` | `45CC3D07E971F5EA` | 仅 2 个导出 + 文档 bullet |
| `scripts/eval/final-attestation.node-test.mjs` | `257535D0232D0274` | 旧 13318B 块 verbatim + 门禁套件 |
| `scripts/eval/verify-pr4a-artifacts.mjs` | `7B4473959207B5D0` | eol-equiv-v1 + t18 计数收口 |
| `scripts/verify-readme-counts.mjs` | `7F51E9C275071283` | 78 叶 + failed/pending 拒绝 |
| `src/index.ts` | `FB4307D5BFBE9D6D` | t4+t7；配置/状态语义未回退 |
| `src/host-triggers.ts` | `7BD4177282C0D73B` | t5 映射 + effort 校验 |
| `src/types/contracts.ts` | `29A661AAEF27522D` | t5 契约 + t19 注释 |
| `src/cordis-seams/dsh-hook-host-adapter.ts` | `4D5CEE80063E63A4` | t5 计数事件点 |
| `tests/unit/p62/pr4a-artifact-verifier.test.ts` | `5BEE6D00B208B20E` | 21 用例（含 t18 两条计数回归） |
| `docs/adr/0005-…md`（新，15 个未跟踪之一） | 见文件 | 契约 D1–D6 |
| 六份审核报告（新） | — | t10–t15，全部 `check:encoding` 通过 |
| 新增实现/测试（新） | — | `check-attestation-target.mjs`、`mutation-gate.mjs`、6 个测试文件 |

未跟踪清单**恰为** 15 个预期交付物（ADR ×1、审核报告 ×6、脚本 ×2、测试 ×6），**无遗漏、无意外产物**；全部 LF、无 BOM/NUL、无行尾空白（我修正了本人 t10 报告的 1 处行尾空白）。

---

## 4. 六项审核 + t18/t19/t20 收口的逐项处置

| 审核 | 结论 | 审核后是否被新字节影响 | 处置 |
| --- | --- | --- | --- |
| t10（attestation 门禁，t2） | PASS | 互不相关（t18 未碰 t2 文件；ci.yml 未再改） | 结论有效；5 条 info 观察仍登记 |
| t11（PR-4A 可携性，t3） | PASS | t18 改了 verifier + 测试（§6 由 t20 追加） | **O1 已闭环**：重复推入删除、条件解耦；我新增 **§7 真实 LF 实测**（checked=692、混合态仅 match-disk） |
| t12（配置原子，t4） | PASS | 无关（`src/index.ts` 字节未变：`FB4307D5…`；t19 只改 contracts 注释） | 结论有效；O1（测试注释时效）/O2（`{config:null}`）仍为非阻塞残留 |
| t13（可观测性，t5/t7） | PASS | t19 改了 contracts.ts 注释（§6 由 t20 追加） | **O1 已闭环**（新措辞与计数点一致；我探针 34/34 复跑）；残余「advisor off」措辞、O2 `{...stats}` 仍开放 |
| t14（文档门禁，t6） | PASS | t20/t16 改了 README 计数 | 结论有效；我在**当前字节**复跑 harness 32/32 并追加 §6（103/2094、90/1935；78 行不变；绑定刷新为 `EBFF7D09…`） |
| t15（mutation/Node24，t8） | PASS | 无关（mutation-gate/ci/package 未再改；目标文件哈希与 t15 记录一致） | 结论有效；O1 红数口径已由台账 §5.2/§5.6 记录 |
| t18（PR-4A 计数收口） | 集成复核：修复真实 | 我的 §7 实测确认 checked=692 与混合态排他 | 闭环 |
| t19（skipped 注释收口） | 集成复核：注释与代码一致 | 我逐点核对 5 个累加点（1096/1099/1120/1173/1177） | 闭环（残余「advisor off」措辞一处） |
| t20（提交前复验） | 其 12 条 verify 与我本次 12 条一致 | 当前字节与 t20 时点相同（除本审核的 3 处文档追加/空白修复） | 采纳 |

---

## 5. 字节绑定与「README 字节绑定过期」提示的解决

- **t11**：t20 已追加 §6（改动说明 + 14/14 夹具 + O1 闭环）；我追加 **§7** 用**真实 LF 检出实测**（而非算术预期）确认 `checked=692`、混合态仅 match-disk、信任规则不回退。→ **绑定已刷新**。
- **t13**：t20 已追加 §6（t19 改动反推 + 5 个累加点核对 + 残余登记）；我在当前字节复跑探针 34/34，行为未变。→ **绑定已刷新**。
- **t14**：t20 未追加（其改动只涉及 README 计数）；**我追加 §6**：当前字节 103/2094（unit 90/1935、e2e 13/159）、`check:docs` 双模式绿、78/78 叶、harness 32/32、README 绑定刷新为 `EBFF7D09…`。→ **绑定已刷新**。
- **t10/t12/t15**：其被审文件当前 sha256 与审核时点一致（§3 清单；t15 的四个 mutation 目标文件哈希与 t15 记录相同），无需追加。
- 结论：**质量门禁关于「README 字节绑定过期」的提示已解决**——不是靠改写旧结论，而是靠「当前字节重取样 + 只追加附录 + 明确标注旧样本」。

---

## 6. Findings（必须修订；均为文档事实性，**不否定已审核代码**）

### F1（medium，台账把已修复的发现记为未修）

- **文件/位置**：`docs/P62_STATUS.md` §5.6（L256 标题、**L260** t13 O1 行、**L263** t11 O1 行）；`DEVELOPMENT_LOG.md` §12.6（**L359–361** 句子）。
- **问题**：当前字节已由 t18 删除 `provenance-executed-sources-eol-equivalent` 的重复推入并把断言条件解耦（我实测 LF 检出 `checked=692`、混合态等价 id 不再落入 failures），由 t19 重写 `skipped` 注释（我逐点核对 5 个累加点成立）。但台账仍写「建议…修复 / 未在本批修复 / 未修」，且 `DEVELOPMENT_LOG` §12.6 仍把这两项列为 open。**以状态页为准的读者会误以为两个 low 发现仍未修**。
- **requiredFix**：以**只追加**方式新增「P1 批后续收口」小节（如 P62 §5.7、DEV §12.7），写明：t11 O1 已由 t18 修复（重复推入删除、条件解耦；t20 §6.2 + t21 §7 实测）；t13 O1 已由 t19 修复（新措辞与 5 个累加点一致；t20 §6.2/§6.3 + t21 探针 34/34）；并把 §5.6/§12.6 中的这两行状态改为「已闭环（见 §5.7/§12.7）」而**保留原观察文字**。**同时登记当前仍开放的残余**：t13 O2（`{...stats}` 白名单）、t20-registered 的「advisor off」措辞（`contracts.ts` 一行）、t12 O2（`{config:null}`）、t14 O2（`unit+e2e==total` 断言）。

### F2（low，台账含 t18 之前的旧计数与失效交叉引用）

- **文件/位置与更正**：
  1. `docs/P62_STATUS.md` **L202**：「19 用例」→ **21**（t18 新增 2 条计数/混合态回归；我实测该套件 21/21）。
  2. `docs/P62_STATUS.md` **L225**：「12 files / **322 tests**（含 27/10/15/12/12/**19**/31 …）」→ **12 files / 324 tests**（我当前字节实测：`tests/unit/{p62,config,seams,eval}` = 12/324），括号内 19→**21**。
  3. `docs/P62_STATUS.md` **L220**（§5.2 mutation 行）只写必红集合「4/4、3/3、2/2、2/2」；**L266** 却声称 §5.2「已注明『2/2 命中 + 红 3 含 extra 1』」——该文字不在 §5.2。**二选一修正**：在 §5.2 补上 t15 O1 要求的观测红数（M1 4 / M2 5 / M3 3 / M4 2，mustRed 4/3/2/2；M2/M3 的 extra 分别 2/1），或改写 L266 的交叉引用。
  4. `docs/P62_STATUS.md` **L240**：「六份审核报告均为本轮新增且未跟踪的产物（README/P62_STATUS/DEVELOPMENT_LOG 之外**唯一**新增路径）」——与事实不符：ADR 0005、`check-attestation-target.mjs`、`mutation-gate.mjs`、6 个测试文件同样是新增路径。改为「六份审核报告之外，本轮另新增 ADR ×1、脚本 ×2、测试 ×6（见 §5.1）」。
  5. `DEVELOPMENT_LOG.md` **L329**：「19 用例」→ **21**；**L338**：「目标化回归 12 files/**322** tests」→ **324**。
- **requiredFix**：按上述逐条更正（数字取自当前字节实测，见 §2）；**不要**把旧数字删成「历史值」以外的改写——可在括号注明「t18 前为 322/19，t18 +2 后为 324/21」以保留历史。

---

## 7. 仍开放的非阻塞残余（如实保留，不阻塞本次修订）

- t13 O2：`mapHostAdvisorStatus` 的 `{...stats}` 原样转发（建议 7 键白名单）。
- t20 新登记：`contracts.ts` 新 `skipped` 注释里的「advisor off」并非本适配器的 skipped 来源（unmounted advisor 不计数；属一行措辞，t5 文件）。
- t12 O1：`plugin-options-shape.test.ts` C-11 头注释仍称运行期 effort 校验为 follow-up（t7 已接上）。
- t12 O2：`{config: null}` 语义未在 ADR 定义（回落宿主配置，无安全降级）。
- t14 O1/O2：README 散文「75+3=78」不入门禁；`check:docs` 未断言 `unit + e2e == total`。
- t10 O1–O5：工作树记录读取、浅克隆失败码、marker 字面量、attestation-target job 的 install、PR 事件边界（均 info）。
- t15 O2–O7：CI 无 `--out` 结构化 artifact、M1 scenario 3/4 不校验、node -v 只打印一次、副本来源、fileErrors 未进报告、README 命令表已由 t16 补齐。

---

## 8. 提交前结论

- **代码/ADR/测试/门禁**：当前字节全绿、六项审核结论不回退、t18/t19/t20 收口经我独立复测确认；**可以提交**（提交与推送仍需用户明示授权；目标 attestation 需在代码提交落定后按 ADR 0005 D1 以 evidence 提交单独生成）。
- **文档**：修好 **F1 + F2** 后即可提交；两项均为台账事实性修订，不涉及代码。
- 本轮未 commit / 未 push / 未动远端 / 未实测 Node24；本地绿 ≠ 远端绿。

### 复现方式

```bash
node work/_t21_review/verify-all.mjs          # 12 条 verify（CI 同构顺序）+ 残留检查
node work/_t11_review/lf-e2e.mjs              # 真实产物 × LF 检出（17/17）
node work/_t12_review/probe.mjs               # 配置探针（47/47）
node work/_t13_review/probe.mjs               # 可观测性探针（34/34）
node work/_t14_review/check.mjs --regenerate  # 文档 harness（32/32）
```
