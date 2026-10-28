# t14 — 配置文档与 `check:docs` 门禁独立审核（round 1）

- **被审对象**：t6（README 配置参考 + `scripts/verify-readme-counts.mjs` + 专属测试）+ t9 验证证据
- **审核人**：architect-reviewer（独立于实现者与验证者；本报告只新增 `docs/reports/t14-config-docs-gate-review.md`，未改动任何实现/文档路径）
- **契约**：ADR 0005 §4 / D4（75 + 3 叶子覆盖、失败/挂起拒绝、计数不伪造）
- **结论**：**verdict = PASS**（两项验收全部核实；5 条 info 观察，均不阻塞）
- **日期**：2026-10-29；基线 HEAD `722625c`（P1 改动在工作树未提交）

---

## 1. 审核方法（独立重放；不采信自述）

1. **逐行读实现**：`scripts/verify-readme-counts.mjs`（+559/−153：叶子遍历、README 行解析、真默认值 esbuild 装载、失败/挂起拒绝、CLI、清理）与 `README.md`（+140：78 行配置表、modelRoute 适用说明、计数与 Testing 段）与新增 `tests/unit/config/readme-default-leaves.test.ts`（406 行）。
2. **自建独立 harness**（`work/_t14_review/check.mjs`，**32/32**）：
   - 生成**一份真实** Vitest JSON 报告（103 files / 2092 tests），用**我自己的解析器**（不复用脚本的 parser）核对 README 四组计数（summary/unit/e2e/total）与真实报告；
   - 用**我自己的 esbuild bundle + 自己的叶子遍历 + 自己的表格解析**独立比对 78 行与真默认值（含 `promoteOnComposeSuccess`、3 个 modelRoute 默认值）；
   - 真实 `--report` / `--docs-only` / `--dump-leaves` / 根报告（CI 模式）/ 无报告自跑（fresh 模式）全路径；
   - **叶子变异**（用 `--readme` 副本，真实 README 零改动）：删行 → missing-leaf；改值 10→11 → default-mismatch；加假行 → stale-leaf；`promoteOnComposeSuccess` false→true → default-mismatch；`modelRoute.model` 改错 → default-mismatch；删章节标题 → 全 78 missing；
   - **报告变异**：同计数下 1 failed → 拒绝且具名；1 pending → 拒绝；`todo`（numPendingTests=0）→ 仍拒绝；计数不符 → 具名 mismatch；**字段缺失回退**（删 `numFailedTests` 但 assertion 为 failed）→ 仍拒绝；
   - 清理不变量：`--report` 文件不被删除、根 `test-results.json` 被消费后删除、`work/docs-verify-*` 零残留；
   - CI 接线：`verify` job 中 vitest 写 `test-results.json` 在 `check:docs` 之前（同一份运行）。
3. **独立复跑**：t6 专属套件 **10/10**；`pnpm run check:docs` 三种模式（fresh 自跑 63.3s、根报告消费 0.3s、`--report`）全 exit 0；`git status` 基线无变化（无根 test-results.json、无 work 残留）。

---

## 2. 验收逐项核实

### 2.1 "75 叶子覆盖检查真实遍历 DEFAULT，缺失或错误默认值会失败" — **passed**

| 检查 | 实证 |
| --- | --- |
| **真实遍历，不硬编码** | 脚本用 `createRequire` 载入 esbuild，把**真实的** `src/config.ts`（`DEFAULT_EVO_HARNESS_CONFIG`）与 `src/dsh-bridge/model-config.ts`（`MODEL_ROUTE_DEFAULTS`）打成临时 ESM bundle 后 import，再递归遍历；`--dump-leaves` 实测 **75 DEFAULT + 3 modelRoute**；我用自己的 bundle 独立遍历同样是 75，且 78 条路径集合一致 |
| 数组 = 一个叶子，带 `[]` | `enabledSurfaces[]`、`rhoPreferences[]`、`levels[]`、`candidateJitBetas[]`、`candidateJitLambdas[]`、`reward.clip[]` 均按 `[]` 后缀匹配（我的独立比对亦按此规则，零差异） |
| 缺失 → 失败 | 删 `jitrl.k` 行 → exit 1，`missing-leaf: jitrl.k is a default leaf but has no reference row`；删章节标题 → 78 条 missing 全部列出 |
| 错误默认值 → 失败 | `jitrl.k` 10→11 → exit 1，`default-mismatch: jitrl.k documents \`11\` but the real default is \`10\``；`promoteOnComposeSuccess` false→true → default-mismatch（**F-13 历史缺陷的回归被门禁钉住**）；`modelRoute.model` 改错 → default-mismatch |
| 陈旧行 → 失败 | 追加 `jitrl.notARealKey` 行 → exit 1，stale-leaf 具名 |
| 真实 README | 零 missing / 零 stale / 零 drift（我的独立解析器与脚本结论一致）；`promoteOnComposeSuccess=false`、modelRoute 默认 qodercn/dfmodel/max 全部正确 |
| 78 行 vs 82 预期？ | 脚本期望集 = 75 + 3 = 78；README 恰 78 行；`rowCount/expectedCount` 只作观测打印，判据是集合差集，**没有硬编码 75/78**（测试里的 78 仅是 observation pin） |

### 2.2 "numFailedTests>0 被拒绝，README 默认值和 modelRoute 说明正确，测试计数未伪造" — **passed**

| 检查 | 实证 |
| --- | --- |
| 失败报告拒绝（**核心 F-14 洞**） | 构造"计数完全匹配但含 1 个 failed"的报告 → exit 1，`carries 1 failed test(s). Refusing to verify README counts against a failing run`，并打印失败用例全名；**拒绝发生在计数比较之前**，输出中无 `match Vitest results exactly` / `SUCCESS` |
| 字段缺失回退 | 删掉 `numFailedTests` 但 assertion 状态为 failed → 仍拒绝（status 扫描兜底） |
| 挂起拒绝 | `numPendingTests=1` → 拒绝并具名；`status:'todo'` 且 `numPendingTests=0` → 仍拒绝（status 扫描） |
| 全绿 + 计数匹配 | exit 0，打印 `zero failed and zero pending` + 计数 SUCCESS；`--report` 文件不被删除 |
| 全绿 + 计数不符 | exit 1，具名 `Summary passing tests mismatch: README has 2092, Vitest has 2093` 等（并继续跑配置检查，一次报全） |
| 计数未伪造 | 我生成的真实报告：**103 files / 2092 tests**，unit **90/1933**、e2e **13/159**，unit+e2e 分区等于总数；README 四组声明逐项相等（我的独立解析 + 脚本双证） |
| README 默认值正确 | 独立比对 78 行零差异；`execution.*`、`dreamRsi.holdoutTreeCount`、37 个 `jitrl.*` 均已补全；`surrogateWeights` 由单行拆成 4 行（数组/对象口径一致） |
| modelRoute 说明正确 | 表格 3 行默认值正确且标注 host-only；正文明确"**not** a root key"、`splitModelRoute` 在冻结校验前摘出、直接写入 programmatic config 会 `unknown_key`、字段 volatile——与 `src/host-triggers.ts` / `model-config.ts` 实际行为一致（t13 已独立复核该行为） |
| CI 同一次运行 | `verify` job：vitest `--outputFile=test-results.json` 在 `pnpm run check:docs` 之前；根报告被消费后删除；fresh 模式（无根报告）自跑 63.3s 亦 exit 0 |
| 清理 | 三种模式后 `work/docs-verify-*` 恒 0、根 `test-results.json` 不残留；`git status` 与审核前一致 |

---

## 3. 实现审查要点

- **单一事实源**：叶子集来自真实源码 bundle（不是脚本里的复制表），这是"文档不能悄悄腐烂"的关键；`--dump-leaves` 把遍历结果暴露为机器可读，便于排查。
- **判据是集合差集**（missing/stale/drift），不是数字；任何一项非空即 exit 1。
- **拒绝顺序**：先 failed/pending（含 status 扫描兜底），再计数；计数不符不提前 return（配置检查同跑），最终 exitCode 合并——一次调用报全部缺陷类。
- **CLI 严格**：未知 flag 直接抛错；值逐个消费（`--readme --docs-only` 的字面值用例证明不会把值当 flag）。
- **清理**：临时报告/临时 bundle/根报告在 exit 与信号路径清理；外部 `--report` 永不删除。
- **t6 测试质量**：10 个用例全部以子进程方式驱动真实脚本、用真实 DEFAULT 生成先验一致的 fixture、逐条断言具名诊断与残留；负例是真实增量（不是 vacuous）。

---

## 4. 观察（info 级，不阻塞）

- **O1（info，散文计数不入门禁）**：README 正文写着"75 … + 3 … = 78"，门禁只校验表格行集合，不校验这句散文。若未来 `src/config.ts` 增删叶子，表格会红，但散文里的 75/78 不会被检查（改表不改散文即可绿）。**建议**：让门禁同时断言/打印该散文，或把散文改为不写死数字。
- **O2（info，分区不加总校验）**：门禁分别核对 summary/unit/e2e/total 四组数字，但没有断言 `unit + e2e == total`。当前对象库只有 `tests/unit` 与 `tests/e2e`（我实测 90+13=103、1933+159=2092），若未来出现 `tests/integration` 等第三类目录，README 表格三行会"加不起来"而门禁不报。**建议**加一条廉价断言（分区加总 = total）。
- **O3（info，表序不校验）**：配置表按"根键组 + 子组"排列，非严格字典序；门禁不要求顺序（我按路径比对），可读性取舍，非缺陷。
- **O4（info，运行依赖）**：门禁现在依赖 devDependency `esbuild` 与可写的 `work/` 临时目录；CI/本地开发均满足（私有包、不发布），清理已验证。若将来有"无 devDeps 的只读环境"跑 `check:docs` 会失败——属预期。
- **O5（info，命令表缺项）**：README 命令表尚未列出 t8 新增的 `pnpm run check:mutation`（t17 已把该缺口标给 t16 收口）；不在 t6 验收范围内。

**无 blocker / 无 high / 无 medium findings；验收两条均满足。**

---

## 5. 复现方式

```bash
# 1) t6 专属套件（10）
pnpm exec vitest run tests/unit/config/readme-default-leaves.test.ts
# 2) 三种真实模式
node scripts/verify-readme-counts.mjs            # fresh 自跑（约 63s）
cp work/_t14_review/report.json test-results.json && node scripts/verify-readme-counts.mjs   # CI 消费模式
node scripts/verify-readme-counts.mjs --docs-only                                # 仅配置参考（78 vs 78）
node scripts/verify-readme-counts.mjs --dump-leaves                              # 75 + 3
# 3) 独立 harness（生成真实报告 + 变异矩阵 32 期望）
node work/_t14_review/check.mjs --regenerate
```

---

## 6. 附录（t21 最终发布审核，2026-10-29）：当前字节上的计数重取样与本审核结论的关系

> 本节由 t21 追加（仅追加，不回写 §1–§5）。§1–§5 的计数样本（`103 files / 2092 tests`、unit `90/1933`）是 **t14 审核时点**（t18 新增 2 个 PR-4A 用例之前）的取样；t18/t19 之后 t20 已把 README 同步为当前字节。本节记录 t21 在**当前最终字节**上的重取样，结论不回退、数字刷新。

### 6.1 当前字节的实测（t21 独立 harness 复跑 32/32 + 12 门禁批全部 exit 0）

- 全量 Vitest（真实 JSON 报告）：**103 files / 2094 tests**，unit **90/1935**、e2e **13/159**，unit + e2e = total，failed/pending 全 0 —— README 的四组计数声明逐项相等（我的独立解析器与门禁双证）。
- `pnpm run check:docs`：CI 同构串（vitest `--outputFile=test-results.json` → `check:docs` 消费**同一次**报告）与 fresh 自跑两种模式均 SUCCESS；配置参考 **78 documented rows vs 78 expected**，零 missing/stale/drift。
- 本报告的独立 harness（叶子变异 6 向、报告变异 5 向、失败/挂起/`todo` 拒绝、`--` 字面值处理）在当前字节复跑 **32/32** —— 其判据全部是结构性的（不依赖具体计数样本），结论不因 2092→2094 而变化。
- 字节绑定刷新：本报告对 README 的 sha256 绑定更新为 `EBFF7D09C0ED8CD96139E38684162D93E194225958B5B5A57023D291A4663914`（2026-10-29 t21 实测样本）。

### 6.2 对 §1–§5 的影响

- §2 两项验收的**判据全部是结构性的**（真实遍历 DEFAULT、拒绝先于计数、集合差集），t18/t19/t20 未触碰 `scripts/verify-readme-counts.mjs` 与 `tests/unit/config/readme-default-leaves.test.ts`，结论不回退。
- §4 的 5 条 info 观察维持原判；其中 **O5「README 命令表未列 `check:mutation`」已由 t16 闭环**（README L102 现有该行）。
- 本报告 §2.2 中「README 计数 103/2092 / 90/1933」属审核时点样本，阅读时以本节为准。
