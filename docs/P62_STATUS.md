# P62_STATUS — P6.2 发布收口状态表（C1.1 + C2a + C3 第二轮，t12 终态集成版；2026-10-28 rev.4 P0 修复批增补）

> 本表是 P6.2 第二轮（`p62-c11-c2a-closure`）的终态发布状态页，与 ADR 0002（`docs/adr/0002-p62-release-contract-and-default-safe-shape.md`，C0+C1 契约冻结）及 ADR 0003（`docs/adr/0003-publish-verification-and-cost-contract.md`，accepted，rev.3 冻结版）配套。
> 本版为 **t12 终态集成版**：整合已通过独立验证与评审的 C1.1、C2a、C3 契约成果，以及 t14（持久化反例）、t15/t16（appliedJit 虚假热替换修复）、t17/t19（C3 零成本与重复预留修复）、t18/t20（C2a 审计来源注册表加固）、t21（离线测试接入与 README 计数同步）全部闭环事实。
> 状态生命周期（严格按 ADR-0003 §8.1 六态逐级推进，不得跳读）：
> **implemented → wired → default_enabled → independently_verified → release_authorized → actually_applied**
> **released 恒为否**（ADR 0002 §11.3 / ADR 0003 §8.1 延续）；`release_authorized` 本轮恒 ✗，`actually_applied` 本轮恒 ✗。
> 本表只陈述**机制、契约与默认安全形态**，不宣称任何真实任务收益；历史负结果（research-v1 路径）原样保留。

---

## 0. 基线与环境

> **口径更新（rev.3 集成轮 t11，2026-10-27）**
> 本节的 `13c4c3cf…` 与 `846c85ee…` 是 **P6.2 第二轮当时的历史快照**，其**采集口径已被 PR-1 废止**：
> 那批摘要对**工作树字节**取哈希，而本仓 `core.autocrlf=true`（对象库 LF / 检出 CRLF），
> 因此同一提交在 Windows 与 Linux 检出上会得到**两个不同摘要**，在 CI 的 LF 环境下**无法复现**
> （事故记录见 ADR 0003 附录 14/15 个文件摘要与其 §5 F-1 发现）。
>
> **现行口径**：正式指纹一律取自 `git cat-file` 的**原始 blob 字节**或 blob id，
> 由 `scripts/eval/final-attestation.mjs` 产出 `{commitId, treeId, compositeSha256, bindingSha256}`，
> 可用 `--verify` 重算；现行值见 `docs/reports/final-attestation.json`。
>
> **本表下方保留旧值的唯一目的是历史可追溯**。它们**不**被重算覆盖（那会篡改历史证据），
> 也**不得**作为当前基线引用。

| 项 | 值 |
| --- | --- |
| **契约基线 HEAD** | `9ea9b7edacb199884df2020df879f4e59ed66d73`（`9ea9b7e feat(p6.2): close C0+C1 release contract and safe defaults`；**历史值**——rev.3 实施轮的实际基线为 `84a3d828ed2a27eef765c8b9c4950da4a9ee7287`，见 §0.1） |
| **契约文档** | ADR 0002（accepted，C0+C1 冻结）+ ADR 0003（accepted，rev.3 冻结版，sha256 `79ad12fe7ad9…`） |
| **验证环境** | win32/x64，Node `v22.23.1`，pnpm `11.7.0` |
| **代码面 diff 指纹 (tracked) — 历史快照，口径已废止** | SHA-1 blob: `846c85ee0c06471226cfc0150e7d84e912d9a323`；SHA-256: `bd6fad155a6418a38856cfdd5e96c41fce11969f1ea0bc335b0c4699251d34b5`（96,795 字节，11 files modified；**取自工作树二进制流，不可跨平台复现**；正文中「若经 PowerShell 行数组 LF 拼装则为 94,540 字节」那段正是该口径缺陷的自述） |
| **代码全库组合指纹 — 历史快照，口径已废止** | `13c4c3cff2c59183dc49416e242a0231bfbda1adb6ff7057a96b5e4b2ee693be`（当时 `src/`+`tests/`+`scripts/` 206 个代码文件，**工作树字节口径**；**不要用它复算当前代码**——文件数与字节口径均已变，见 §0.1） |
| **运行口径（Vitest 全量）— rev.4 集成实测（2026-10-28 P0 修复批）** | `pnpm test` = **97 文件 / 1979 测试**（unit 84/1820 + e2e 13/159，全绿通过）；历史：rev.3 集成实测 95/1878（unit 82/1719）、首轮 86/1666，均保留不回写 |
| **运行口径（Vitest 全量）— P1 批现行实测（截至 2026-10-29 t20 提交前复验时点）** | `pnpm test` = **103 文件 / 2094 测试**（unit 90/1935 + e2e 13/159，全绿 exit 0）；实测命令为 CI `verify` job 的同构串 `vitest run --reporter=default --reporter=json --outputFile=test-results.json`，随后 `check:docs` 消费**同一次**报告并 `SUCCESS`（README 计数由 t17 于 t16 时点同步为 2092/1933，t20 按当前字节复验后修订为 2094/1935）。上表 rev.4 的 97/1979 与 t16 时点的 2092/1933 自此仅作历史值 |
| **收口证据报告** | `docs/reports/p62-c11-c2a-closure.md`（历史收口报告，其指纹同为历史快照）+ `docs/reports/pr4a-five-arm-eval-report.md`（rev.3 实验报告） |
| **历史版本标记** | 本版正式取代上一版（首轮 t3 集成版）；历史状态与评审结论完整归档，零倒退、零回写 |

### 0.1 rev.3 轮（PR-1…PR-4B）的现行证据锚点

| 项 | 现行值（win32/x64，blob 字节口径） |
| --- | --- |
| 代码基线 commit | `84a3d828ed2a27eef765c8b9c4950da4a9ee7287`（未 commit/push，工作树交付） |
| 根树 tree id | `bc25da6a5014223c4e50322c05a61e4e0295663c` |
| 被摘要文件数 | 206（`src/` + `tests/` + `scripts/`，取自 `HEAD` 的**已提交**树） |
| `compositeSha256` | `4d90720eaedda8b48d43fe190bc0f67e6e562da2fc41994bf73a9025500fae3b` |
| `bindingSha256` | `f73714075a39cf83d88b6ce28edeac25b36c6bd8763cb759dba12bf01815ee51` |
| 复算 / 重验 | `node scripts/eval/final-attestation.mjs` / `--verify docs/reports/final-attestation.json` |

> 注：本轮把大量实现与测试写在**未跟踪**文件里，而指纹口径按设计只读**已提交树**，
> 故 `compositeSha256` 覆盖的仍是基线提交的 206 个文件，**不含**本轮新增文件。
> 这是口径的刻意选择（证据必须描述提交，不得依赖检出），不是遗漏；
> 提交后重跑 `pnpm run attest` 即会纳入。

---

## 1. 六态发布边界与能力矩阵（对照 ADR-0003 逐项陈述事实）

| 机制 / 能力项 | implemented | wired | default_enabled | independently_verified | release_authorized | actually_applied | 当前实际交付事实（代码与装配级） |
|---|:---:|:---:|:---:|:---:|:---:|:---:|---|
| **执行模式与基础 Evo 边界** | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | 默认 `execution.mode=shadow`（宿主 baseline 行为不变 + 建议记录）；off 模式停止七面；显式区分宿主 baseline 与基础 evo search。 |
| **永久 patch 应用** | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | 默认禁用；仅 `guarded-active` 且双重显式参数为 true 时方可开启，库构造缺省 fail-closed。 |
| **guarded-active 保守门** | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | 仅显式启用；在 shadow/baseline/off 下尝试配置即抛错拒绝。 |
| **C1.1 Dreamer 发布受体与默认 Deny** | ✓ | ✓ | ✓ (deny) | ✓ | ✗ | ✗ | 接入生产受体 `applyWinningPolicy`，四模式默认恒 deny；四模式 × Jit on/off 全部 8 种组合下 `applyPolicy` 调用次数为 0、`policy.history.jsonl` 增量为 0。 |
| **C1.1 appliedJit 真实发布事实绑定** | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | `index.ts:1271` 绑定真实 `publication.publish === true`；消除在 deny 且存量策略含 jit 时状态面虚假报告（t10 F-1 关闭，t16 PASS）。 |
| **C1.1 四字段一致性与 Idle 审计** | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | `publish`、`shadow.published`、`comparisons[].selected`、`appliedJit` 10/10 严格自洽；idle 入口热替换已统一封堵并记入审计。 |
| **C1.1 Holdout 严格验证** | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | 未传 holdout 树或 holdout 不通过时判定为 `holdout-missing`，fail-closed 拒绝发布。 |
| **Memory 权限隔离** | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | 默认 deny，orchestrator 在调用点之前直接返回，完全不调用 memory bridge（零桥调用）。 |
| **Reward 契约标尺** | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | `r4/verifier-first-v1` 一次性原子切换，数值标尺冻结，旧版本自动隔离。 |
| **C2a 宿主自有 Runner 与 Digest 绑定** | ✓ | ✓ | ✓ (退化) | ✓ | ✗ | ✗ | 宿主本地轻量 runner 执行检查，强制计算 artifact 的 `sha256:64hex` 摘要并回填 `deliverable.contentHash`（T3 落地）。无 seam 时逐字节等价纯净退化。 |
| **C2a 双回执同卷（Symmetric Verification）** | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | reference 与 candidate 两侧均执行 `verifyAndAttach`，消除单侧验证产生的虚假 learningTarget 差异。 |
| **C2a 真值表与 12 类伪造拒绝** | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | 严格落实 §4.3 真值表：succeeded+failed 截击伪造成功，failed+failed 保留可靠失败学习，timeout 拦截为 audit-only；12 类错绑/伪造回执全拒并带原因码。 |
| **C2a 审计来源注册表加固** | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | 引入 `HOST_AUDIT_REGISTRY` WeakMap 宿主注册表与五道认证门，杜绝三布尔或手动构造伪造审计 disposition（t11 F-3 关闭，t20 PASS）。 |
| **C2a 质量消费者接线** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **未接线**。真实任务质量证据暂不直接参与在线学习目标（learningTarget）加强，消费门与事实门严格隔离。 |
| **C3 成本台账数据契约** | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ | `src/ledger/**` 定义 UsageLedgerEvent、防重复计费、三态计量传播；**全仓零生产业务接线，零外部 import**。 |
| **C3 保守非零地板与生命周期** | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ | actualCost=0 强制 unknown provenance 与保守地板；已结算 callId 重复 reserve 明确拒绝（`call_already_settled`），总额度与席位零滞留（t11 F-1/F-2 关闭，t19 PASS）。 |
| **C3 确定性离线 Fixture 覆盖** | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ | 11 个离线场景函数（Scenario 1–8 与 9/10/11）由 `tests/unit/ledger/offline-fixtures.test.ts` 的 12 个 `it()` 测试 100% 实际调用（t19 Y-1 关闭，t21 PASS；含 11 场景测试 + 1 项 r4 边界测试）；全套件 36 项 ledger 单测全绿；零网络、零付费模型。 |
| **C2b / C3 生产实施 / C4 / D** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **全部未做**。无付费模型调用、无真实 memory 写入、无自动发布、无部署、无 commit/push。 |

---

## 2. 全量门禁结果（七门禁 + 专项）

下表为 **t12 终态集成轮（2026-10-27）** 的串行复跑记录（历史，保留不回写）；**rev.4（2026-10-28 P0 修复批）的现行实测见 §2.1**：

| # | 门禁命令 | 通过标准 | 实测结果 | 关键见证输出 |
|---|---|---|---|---|
| **1** | `pnpm run typecheck` | exit 0 | **exit 0** | `tsc --noEmit`，0 error，零类型告警 |
| **2** | `pnpm test` | exit 0，全绿，README 计数完全同步 | **exit 0** | **Test Files: 86 passed (86), Tests: 1666 passed (1666)** |
| **3** | `pnpm run check:docs` | exit 0，文档与 Vitest 逐项精确匹配 | **exit 0** | `SUCCESS: All README.md test counts match Vitest results exactly!`（Unit 74/1509、E2E 12/157、Total 86/1666） |
| **4** | `pnpm run build` | exit 0，产出 `lib/index.js` | **exit 0** | esbuild 编译正常，零 warning / 零 error |
| **5** | `node scripts/eval/negative-result-diag.mjs --json` | exit 0，历史负结果不被抹去 | **exit 0** | `meanDelta: -0.25`, `matchesHistorical: true`, 5 退化任务保持原样 |
| **6** | `node scripts/eval-jitrl.mjs --json` | exit 0，确定性 Harness 正常 | **exit 0** | `seed: 0xfe348428`, `taskCount: 12`, 确定性指标块输出一致 |
| **7** | `node scripts/eval/guarded-regression.mjs --json` | exit 0，覆盖发布受体、隔离与可信来源 | **exit 0** | **`summary: { total: 33, passed: 33, failed: 0 }`**（含 C1.1 发布受体探针与 C2a 宿主回执/注册表全套探针） |

专项复测见证：
- Ledger 契约专项：`tests/unit/ledger` 3 文件 36 测试全绿（pricing 10、reservation-manager 14、offline-fixtures 12）；
- C2a 可信验证专项：`tests/unit/verification` + `tests/e2e/c2a-trusted-verification.test.ts` 5 文件 62 测试全绿；
- C1.1 发布边界专项：`tests/unit/jitrl/runtime-control.test.ts` + `tests/unit/p62/release-contract.test.ts` + `tests/unit/dream-rsi` 9 文件 249 测试全绿。

### 2.1 rev.4（2026-10-28 P0 修复批，win32/x64 实测，六门禁 + 专项全绿）

| 项 | 实测结果 |
| --- | --- |
| `pnpm run typecheck` | exit 0（`tsc --noEmit` 0 error） |
| `pnpm run check:encoding` | exit 0（314 tracked blobs 全 LF 或 3 个显式 `-text` 例外） |
| `pnpm test` / `pnpm run check:docs` | exit 0（**97 files / 1979 tests 全绿**，README 计数机械精确匹配 `SUCCESS`） |
| `pnpm run build` + `pnpm run check:build-smoke` | exit 0（`lib/index.js` 1003883B，ESM，68 named exports） |
| `pnpm run check:negative-result` | exit 0（A1..A6 PASS，历史负结果 −0.250 完整保留） |
| `node scripts/eval/guarded-regression.mjs --json` | exit 0，`{total:37, passed:37, failed:0}`（33→37：+4 由 PR-1 并行批追加；该门禁无 package script，按 ADR 0002 门禁 #7 规范命令直跑） |
| `tests/unit/p62` 专项 | 5 文件 / 176 测试全绿（evidence-gates 43 + commit-attestation 48 + pr4a-artifact-verifier 13 + 其余 2 套件合计 72） |
| `node --test` 双套件（parity / attestation） | 51/51 exit 0（parity 闭集与目标校验 31 项 + attestation 目标与自指边界 20 项） |
| **PR-4A 产物校验器（当前有效计数）** | **`node scripts/eval/verify-pr4a-artifacts.mjs` = 691/691，exit 0，warnings=[]**（683 为 t3 前基线、688 为 t3 轮中间值，**现行以 691 为准**） |
| 夹具泄漏边界（P0-A 修复实证） | 全量 Vitest（含 p62 夹具）多轮复跑后 refs 恒 9、worktrees 恒 1、`pr1-policy-commit-*` 恒 0——修复前每次运行净增 3 个永久 refs 的泄漏机制已消除 |

**F1 可携性边界（如实保留，不声称跨 LF 直接可携）**：PR-4A `executedSources` 为 raw-byte 硬校验（生成时工作树原始字节）。历史产物于 Windows/`core.autocrlf=true` 生成，在 LF 检出复验仍会 exit 1——但已具备具名诊断 `provenance-executed-sources-eol-divergent`（WARN + `eolOnly` 分类）与文件头 / `--help` 的 CHECKOUT BYTE SPEC（可携规约 `git -c core.autocrlf=false checkout -- .`，生成与校验同规约）。

### 2.2 rev.4 CI 接线与本地复验（2026-10-28，win32/x64，本批）

§2.1 是 P0 修复批的**本地验证**时点；本小节记录其后 CI/package 接线与在同一工作树上的复验（**远端结果不在本小节断言**，只由推送后的 Actions 运行产生）。

| 项 | 实测结果 |
| --- | --- |
| `.github/workflows/ci.yml` `fingerprint-parity` | 比较调用新增 `--expect-commit "${{ github.sha }}"`：三平台记录不再只能互相印证 |
| 同上步骤的失败语义（承重修复） | 旧体 `node … \| tee parity.json` 在默认 shell（`bash -e`，无 `pipefail`）下返回 `tee` 的退出码，规则失败被记为绿灯；现为 `shell: bash` + `${PIPESTATUS[0]}` 显式回传，`tee` 与失败时仍写 job summary 均保留。本地合成产物实测：目标匹配 → 0，目标不匹配 → 1，三平台 composite 不一致 → 1；同一失败用例在旧体下 → 0 |
| `fingerprint`（三平台生成侧） | `final-attestation.mjs --ref "${{ github.sha }}" --expect-commit "${{ github.sha }}" …`：每个平台先自证记录即本次 revision |
| 新 job `guarded-regression` | `pnpm run guarded-regression` + `node --test` parity/attestation 双套件；独立 job（非 `verify` 的 `needs`），探针红即该 job 失败，不让 parity 证据被 skip |
| `package.json` | 新增 `"guarded-regression": "node scripts/eval/guarded-regression.mjs --json"`；README 命令表与 Packaging status 同步 |
| `pnpm run typecheck` / `check:encoding` / `check:docs` | 全部 exit 0（check:docs：README 97/1979、84/1820、13/159 机械匹配 `SUCCESS`） |
| `pnpm test`（全量 Vitest，本批复跑） | **97 文件 / 1979 测试全绿**，exit 0 |
| `pnpm run build` + `check:build-smoke` | exit 0（`lib/index.js` 1003883B、ESM、68 named exports） |
| `pnpm run check:negative-result` | exit 0（A1..A6 PASS） |
| `pnpm run guarded-regression`（新 script 直跑） | exit 0，`{total:37, passed:37, failed:0}` |
| `node --test` 双套件 | **51 pass / 0 fail / 0 skipped**，exit 0 |
| `node scripts/eval/verify-pr4a-artifacts.mjs` | **691/691，failed=0**，exit 0 |
| 夹具/临时对象边界 | worktrees 恒 1、`pr1-policy-commit-*` 恒 0、分支数不增长 |
| `attest:verify` 目标门禁 | **本条已被 2026-10-29 P1 批取代（现行结论见 §5.4）**：当时的判断本身没错——记录覆盖不了包含它自己的提交，`--strict` / `--expect-commit github.sha` 在证据提交上必然为红（SELF-REFERENCE BOUNDARY）；但「需 ADR 后再落地」这一挂起状态已结束：ADR 0005 D1 裁定**不给 `attest:verify` 加目标参数**，而是新增独立 `attestation-target` job，按提交类型（ordinary / evidence 提交）机械判定覆盖目标。历史陈述保留，不再作为现行状态引用 |

---

## 3. 登记项与限制清单（不影响本轮安全收口）

1. **登记项 t10 F-2（G1 授权接线门禁前置）**：
   `executionProfile.shadowMode` 派生自 `mode === 'shadow'`，若将来外部强行传入异构配置可能存在覆盖风险。本轮不改代码，仅作为未来 G1 授权接线时的核验登记项。
2. **登记项 t20 X1（C2b 模块私有化前置）**：
   `applyVerificationDisposition` 仍在公开导出面（`src/verification/index.ts:42`），同进程代码理论上可调用注册。本轮无生产接线且为本地轻量形态，留待 C2b 阶段在模块边界内部私有化。
3. **C2a 质量消费者未接线**：
   可信本地验证已实现本地 runner 运行与真伪认证，但其结果不直接送入在线学习目标（learningTarget），在线强化消费门依然保持保守。
4. **C3 仅为契约与离线 Fixture 准备**：
   `src/ledger/**` 为纯数据契约与离线确定性模拟，全仓无任何外部 import，不接线上选择、不改模型路由、不产生真实费用。
5. **严禁已部署与正收益宣称**：
   本轮交付仅证明机制与安全默认形态，不宣称任何线上任务收益；历史负结果（research-v1）原样保留。

---

## 4. 历史版本与更新纪律记录

- **2026-10-25 t1–t13 / t3（第一轮：p62-safe-release-closure）**：完成 C0+C1 契约冻结（ADR-0002）、默认安全形态、r4 原子切换、内存权限调用点前拦截、七门禁全绿（77 文件 / 1562 测试）。生成首轮终态报告 `docs/reports/p62-release-closure.md`。
- **2026-10-26 t1（contract-architect）**：冻结 ADR-0003，确定 C1.1 发布受体 deny、C2a 可信本地验证闭环、C3 台账契约与离线 fixture 三项核心范围。
- **2026-10-26 t4/t7/t10（C1.1 发布受体）**：实现发布受体接线，独立验证通过，独立评审识别 t10 F-1（appliedJit 谎报）与 t10 F-2。
- **2026-10-26 t5/t8/t11（C2a 可信验证）**：实现宿主本地 runner 与 digest 绑定，独立验证通过，独立评审识别 t11 F-3（三布尔伪造审计）。
- **2026-10-26 t6/t9/t11（C3 台账契约）**：实现计价契约与预留管理，独立验证通过，独立评审识别 t11 F-1（0 成本绕过）与 t11 F-2（已结算重复预留滞留）。
- **2026-10-26 t14/t15/t16（C1.1 修复与复审）**：收敛 `appliedJit` 条件绑定真实发布事实，补充 8 笛卡尔积持久化反例，t16 独立复审 **verdict=pass**，t10 F-1 关闭。
- **2026-10-26 t17/t19（C3 修复与复审）**：强制 0 成本 unknown provenance 与保守地板，入口补查已结算调用防重复预留，t19 独立复审 **verdict=pass**，t11 F-1/F-2 关闭，识别 Y-1（死 fixture）。
- **2026-10-26 t18/t20（C2a 修复与复审）**：引入 WeakMap 宿主注册表与五道认证门，t20 独立复审 **verdict=pass**，12 类攻击面全拒，t11 F-3 关闭，登记 X1（low）。
- **2026-10-27 t21（C3 新场景接入）**：在 `offline-fixtures.test.ts` 中接入 Scenario 9/10/11 测试，消除 Y-1 死 fixture；ledger 增至 36 测试，全量机械同步至 86 文件 / 1666 测试，四门禁全绿。
- **2026-10-27 t12（终态集成）**：整合全量成果，生成 `docs/reports/p62-c11-c2a-closure.md`，更新本状态表，复跑七门禁全部 exit 0，绑定当前 HEAD `9ea9b7e` 与 diff 指纹 `846c85ee…`。
- **2026-10-27 t24（指纹口径与 r4 消除空转）**：消除 `offline-fixtures.test.ts` r4 边界测试空转；明确代码面 diff 指纹排除 `P62_STATUS.md` 自指终态文档口径；统一表述为 11 个场景函数与 12 个 offline-fixtures it。
- **2026-10-27 t25（可复现指纹清单与 attestation 重写）**：落地 `scripts/eval/final-attestation.mjs`，消除不可复现旧组合指纹 `c631c281…`，新生成 206 文件确定性组合指纹 `13c4c3cf…`；固化代码面 tracked diff 排除 `P62_STATUS.md` 与 `docs/reports/**` 规约（SHA-1 `846c85ee…` / 96,795B / 11 files）；产出机器可读清单 `docs/reports/final-attestation.json`。
- **2026-10-28 rev.4（P0 修复批：t2/t3/t4/t10/t14 实现 + t5/t13 验证 + t7/t8/t11/t15 独立审核）**：
  - **P0-A 临时仓库夹具**：删除「`worktree add --detach HEAD` + `checkout -b <uuid>` + `commit --allow-empty`」的假绿泄漏机制（空提交 tree==HEAD tree，且每次运行净增 3 个 `pr1-policy-commit-*` 永久 refs），改为 frozen 基线 `84a3d828…` 上私有 clone（`--shared --no-checkout`、私有 index、只读 `GIT_ALTERNATE_OBJECT_DIRECTORIES`）合成的真实提交夹具；清理语义升级为可断言（refs/worktree 计数 before==after）。
  - **P0-B PR-4A 证据可携性**：MISSING/CLEAN/DIRTY 三态确定语义；t7 三项 findings（伪造 executedSources 绕过、dirty 未绑 codeBaseline、可携性回退无诊断）经 t14 修复、t15 独立复审 **verdict=pass**（变异测试证明新断言承重）。当前有效计数 **691/691 exit 0**（见 §2.1）；F1 为 (b) 语义，LF 检出边界如实保留。
  - **P0-C parity/attestation 目标校验**：三平台闭集、`--expect-commit` / `--strict` / `verify-ref-conflict`、SELF-REFERENCE BOUNDARY（记录不覆盖包含自身的提交；`--verify` 通过 ≠ HEAD 已 attested；目标 SHA 永不伪造/回填）；`compare-platform-digests.d.mts` 公开声明同步（t10/t11 pass）。新增 `node:test` 双套件 51 项。
  - **README 计数统一同步（本任务 t9）**：97 files / **1979** tests（unit 84/**1820**、e2e 13/159），由 `check:docs` 机械匹配验证。
  - **边界**：本轮全部为本地验证修改；未生成 attestation、未 commit、未 push；`release_authorized` / `actually_applied` 恒 ✗ 不变。
- **2026-10-28 rev.4 剩余授权事项（未授权前不得自行执行）**：
  1. **CI / package script 变更授权**：`.github/workflows/ci.yml` 的 fingerprint-parity job（:236 附近）尚未传 `--expect-commit "${{ github.sha }}"`——远端门禁目前仍不能排除「三平台一致指向错误 commit」（t4 验收条款 4 留作集成授权；t8 复核同结论）；guarded-regression 如需纳入 pnpm 门禁链，需授权新增 package script。
  2. **目标提交生成 attestation**：现行 `docs/reports/final-attestation.json` 描述基线提交 `84a3d828…`；含该记录自身的提交按 SELF-REFERENCE BOUNDARY 永不可自证——需在修复批提交落定后的目标提交上重跑 `pnpm run attest` 重生成（本轮未生成、未伪造）。
  3. **推送后三平台 parity 实测**：三 OS 断言需在 GitHub Actions ubuntu/macos/windows 实际产出三份记录并 `--expect-commit <推送 SHA>` 比对（本地无法替代；HEAD `0410d78` 远端 CI=failure、fingerprint/parity=skipped 的历史事实未变，不因本地绿而改写）。
  4. **后续批次**：修订方案 P1–P6——**P1（证据提交目标门禁 + 配置原子入口 + 可观测性 + 配置文档 + mutation/Node24 门禁 + PR-4A 换行可携性）已于 2026-10-29 在本地完成并通过逐项独立审核（见 §5）；P2–P6 仍未开始**。
- **2026-10-28 rev.4 CI 接线轮（本批；用户明确授权后执行）**：
  - **CI / package 接线（随本提交落地）**：`fingerprint-parity` 接 `--expect-commit "${{ github.sha }}"` 并修复同一 pipe 的失败语义（旧体返回 `tee` 退出码 = 假绿）；`fingerprint` 生成侧同接 `--expect-commit`；新增独立 `guarded-regression` job（`pnpm run guarded-regression` + `node --test` 双套件）；`package.json` 新增 `guarded-regression` script 并同步 README。详见 §2.2。
  - **目标提交 attestation**：`docs/reports/final-attestation.json` 在本批代码提交上以 `--expect-commit <代码提交 SHA>` 重新生成、`--verify --expect-commit <同一 SHA>` 复验后**单独提交**；记录不覆盖包含自身的提交（证据提交不被其自身 attestation 覆盖）。
  - **推送与远端实测**：两个提交推送至 `origin/main`（**不 force、不改写历史**）；三平台（ubuntu/macos/windows）parity 的远端结果以该次 GitHub Actions 运行日志为准——**本表不预先断言远端结果**。
  - **未闭环（需 ADR，未擅自改变契约）→ 已由 ADR 0005 D1 闭环（2026-10-29 P1 批，见 §5.4）**：`verify` job 的目标门禁（要求记录描述证据提交的父提交/目标 revision）。当时的自指边界分析仍成立，故 `attest:verify` 至今仍**不带**目标参数；ADR 0005 D1 把该需求改判为独立的 `attestation-target` job（ordinary / evidence 提交分类 + `Attestation-Target: first-parent` trailer 三方绑定），本轮只落地该 job，未改 `verify` 与 `attest:verify` 的既有语义。

---

## 5. P1 批（证据与配置原子批）本地集成交付（2026-10-29，win32/x64；未 commit / 未 push）

> 本节只追加，不回写 §0–§4。契约依据：`docs/adr/0005-p1-evidence-and-atomic-config-contract.md`（本轮唯一新增 ADR，accepted）。
> 链路：t1 契约裁定 → t2/t3/t4/t5+t7/t6/t8 六类实现 → t17 计数同步 → t9 独立全量验证 → t10–t15 逐项独立审核（**全部 verdict=pass**）→ t16 本条集成收口。
> 与 rev.4 的差别：本轮**首次**落地 attestation 目标门禁、PR-4A 换行可携口径、配置入口原子修复、结构化可观测性、mutation gate 与 Node24 CI 覆盖。
> **`release_authorized` / `actually_applied` 仍恒 ✗**；历史负结果、既有指纹与历史计数一律不回写。

### 5.1 交付清单（契约 + 六类实现 + 文档）

| 类别 | 任务 | 交付路径（本轮新增 / 修改） | 专属门禁 / 测试 |
| --- | --- | --- | --- |
| 契约 | t1 | **新增** `docs/adr/0005-p1-evidence-and-atomic-config-contract.md`（D1 目标门禁、D2 eol-equiv-v1、D3 配置原子契约、D4 文档 75+3 叶与失败/跳过拒绝、D5 四变异体 + Node24 边界、D6 排他写范围） | tsc 正反例、T0–T8 原型穷举 |
| 证据目标门禁 | t2 | **新增** `scripts/eval/check-attestation-target.mjs`；改 `scripts/eval/final-attestation.mjs`（仅新增 2 个导出，语义零改）、`final-attestation.node-test.mjs`（旧 13318B 块逐字节保留）、`.github/workflows/ci.yml`（新 job） | `node --test` 套件 + `attestation-target` job |
| PR-4A 换行可携 | t3（t18 收口计数） | 改 `scripts/eval/verify-pr4a-artifacts.mjs`（`EOL_EQUIV_VERSION` + 四分类）、`tests/unit/p62/pr4a-artifact-verifier.test.ts` | **21 用例**（双向等价 / 混合态 / BOM·二进制·非法 UTF-8 反例 + t18 计数与混合态回归 2 条；t18 前为 19 用例）+ 真实产物 691/691 |
| 配置原子入口 | t4 | 改 `src/index.ts`（`OPTION_KEYS` 15→26 + 编译期 witness、混合形态具名拒绝、`{}` 不再伪造 `{config:{}}`、effort 类型收紧）；**新增** `tests/unit/config/plugin-options-shape.test.ts` | 27 用例（C-1…C-12 真实 `apply()`） |
| 可观测性 | t5 / t7 | 改 `src/host-triggers.ts`（`mapHostAdvisorStatus` / `assertModelRouteEffort`）、`src/types/contracts.ts`、`src/cordis-seams/dsh-hook-host-adapter.ts`、`src/index.ts`（hostAdvisor 扁平状态 + route effort 运行期校验）；**新增** `tests/unit/config/model-route-effort.test.ts`、`tests/unit/seams/status-observability.test.ts` | 15 + 12 用例（未采集 ≠ 0 的 collect-or-omit） |
| 配置文档与文档门禁 | t6 / t17 | 改 `scripts/verify-readme-counts.mjs`（78 叶逐行校验 + `numFailedTests`/`numPendingTests` 拒绝）、`README.md`（78 行配置参考；全局计数三行）；**新增** `tests/unit/config/readme-default-leaves.test.ts` | 10 用例 + `check:docs` |
| mutation / Node24 门禁 | t8 | **新增** `scripts/eval/mutation-gate.mjs`、`tests/unit/eval/mutation-gate.test.ts`；改 `ci.yml`（`mutation-gate` + `node24-compat` 两个 job）、`package.json`（仅加 `check:mutation`） | 31 用例 + 四变异体实跑 |
| 集成收口 | t16 | 本条 + README 命令表 / Evidence 段，`docs/P62_STATUS.md`、`DEVELOPMENT_LOG.md` | 见 §5.2 四门禁 |

### 5.2 本地实测（t9 独立验证 + t17 计数同步；全部 exit 0）

| 项 | 实测结果 |
| --- | --- |
| `pnpm run typecheck` | exit 0 |
| `pnpm test`（CI 同构串，含 `--outputFile=test-results.json`） | **103 files / 2094 tests 全绿**（unit 90/1935 + e2e 13/159；failed/pending/todo 全 0；口径时点同 §0 的 2026-10-29 t20 复验） |
| `pnpm run check:docs` | exit 0，两种模式均绿：消费**同一次**报告（`SUCCESS: All README.md test counts match Vitest results exactly!`）与无根报告的自跑模式；78 documented rows vs 78 expected |
| `pnpm run check:encoding` | exit 0（317 tracked blobs / 3 个显式 `-text` 例外） |
| `pnpm run check:build-smoke` | exit 0（`lib/index.js` 1007959B、ESM import、70 named exports） |
| `pnpm run check:negative-result` | exit 0（A1..A6 PASS，历史 −0.250 完整保留） |
| `pnpm run guarded-regression` | exit 0，`{total:37, passed:37, failed:0}` |
| `pnpm run check:mutation`（新） | exit 0，**M1/M2/M3/M4 全部 KILLED**（必红测试名集合 4/4、3/3、2/2、2/2 命中，**观测红数 M1 4 / M2 5 / M3 3 / M4 2**，其中 M2 的 2 条与 M3 的 1 条为 extra red 观察、不参与判据；基线先全绿、副本目标文件 sha 必变、worktree zero-residue；`--validate` 4 anchors resolve） |
| `node --test` 双套件 | **79 pass / 0 fail**（较 rev.4 的 51 增 28，来自 t2 追加套件） |
| `node scripts/eval/check-attestation-target.mjs --json` | exit 0，真实仓 `mode=ordinary`（记录绑定 `56f846ae…`，为 `HEAD=722625c6…` 的祖先）；**零文件写入**（运行前后记录 sha256 `675acf79…`、mtime、`git status` 全不变） |
| `pnpm run attest:verify` | exit 0（`OK … matches the object database`；**记录未重生成、未伪造**） |
| `node scripts/eval/verify-pr4a-artifacts.mjs` | **691/691，failed=0**，exit 0（历史产物 7/7 raw match，无等价命中） |
| 目标化回归（p62/config/seams/eval） | **12 files / 324 tests 全绿**（含 27/10/15/12/12/**21**/31 与 p62 48/43/21/51；t18 前为 322 tests / pr4a 19 用例，+2 条计数回归后为 324 / 21） |
| 非空转独立反证（t9 自建，非复跑作者自测） | 配置探针 **16/16**（mixed→`plugin-options-mixed-shape`+offendingKeys；`{}`→`{}`；非对象→invalid-shape；26 键唯一）；未采集计数四键在对象与 JSON 中**缺席**、实测零值**存在为 0**；四个自改 README 副本分别触发 `missing-leaf`/`stale-leaf`/`default-mismatch`；自建临时 git 仓 **9 场景**复现 T1 PASS 与 T2/T3/T4/T5/T6/T7/T8 全部具名红；PR-4A A/B 双跑**双向等价**判 `eol-equivalent` 而真实漂移具名 FAIL + 混合态 WARN |
| 夹具 / 引用边界 | refs 恒 9、worktrees 恒 1、stash 恒 0；验证前后 8 个关键文件 sha256 逐一致、`git status` 清单相同 |

### 5.3 独立审核（t10–t15，逐项 verdict=pass）

| 审核 | 报告 | 结论要点 |
| --- | --- | --- |
| t10 | `docs/reports/t10-attestation-target-gate-review.md` | 自建 28 期望对抗 harness（真实仓库 + 真实生成器）全过；浅克隆 fail-closed；旧测试块 13318B verbatim；真实仓零写入 |
| t11 | `docs/reports/t11-pr4a-eol-portability-review.md` | 真实产物 LF 检出与镜像 CRLF 检出均 exit 0，等价/原样分开计数；漂移 / BOM / 二进制 / 伪造 digest 全 FAIL；历史产物未动 |
| t12 | `docs/reports/t12-config-atomic-entry-review.md` | 编译期 witness 5 向变异全部触发预期 tsc 报错；运行时探针 47/47；10 个旧白名单漏键有真实消费点 |
| t13 | `docs/reports/t13-observability-and-route-review.md` | 探针 34/34（未采集三档 / 三种 dispatch 计数 / canary 不泄漏 / effort 矩阵）；t5 语义从工作树核验（t5 无 output 记录） |
| t14 | `docs/reports/t14-config-docs-gate-review.md` | 独立 harness 32/32；叶子变异 6 向、报告变异 5 向全具名红（含「计数匹配但 1 failed → 拒绝先于计数」）；t6 套件 10/10 |
| t15 | `docs/reports/t15-mutation-node24-review.md` | 本人跑完整门禁 exit 0；`--validate` anchor 唯一 + 反向逐字节还原；独立 M3/M4 判别力复核 10/10；CI 静态全过 |

六份审核报告均为本轮**新增且未跟踪**的产物，全部 `check:encoding` exit 0。除这六份报告之外，本轮**另新增 ADR ×1（ADR 0005）、脚本 ×2（`check-attestation-target.mjs`、`mutation-gate.mjs`）、测试 ×6**（`plugin-options-shape`、`model-route-effort`、`readme-default-leaves`、`status-observability-contract`、`status-observability`、`mutation-gate`），未跟踪交付物合计 15 项——完整清单与职责见 §5.1。

### 5.4 §2.2「刻意不接」与 §4「未闭环」的现行结论（取代声明）

1. **attestation 目标门禁（ADR 0005 D1）——已落地，不再是挂起项。** `verify` job 与 `attest:verify` 保持原语义（自洽校验、不带目标参数）；目标判定改为独立 `attestation-target` job：**ordinary 提交**要求记录与所记提交自洽**且**该提交是 `HEAD` 祖先（不声称 `HEAD` 已 attested、不为 ordinary 发明父绑定）；**evidence 提交**（`Attestation-Target: first-parent` trailer）要求记录-纯净、非合并、不叠加，且记录 `commit.commitId == HEAD^1`。恒红 `--strict` 与宽松 `HEAD^1` 两方案均已被 ADR 0005 §1.1/§8.2 的原型实测否决。
2. **PR-4A 换行可携口径（ADR 0005 D2）——F1 的「不声称跨 LF 直接可携」升级为版本化规则。** 记录侧仍是 raw worktree 字节且**永久不回写**；校验侧新增 `eol-equiv-v1`：同一文本仅在 CRLF↔LF 一种换算下匹配的条目判为具名 `eol-equivalent` **PASS**（携带规则版本、与 raw match 分开计数）；内容 / BOM / 二进制 / 非法 UTF-8 差异仍为 FAIL；旧 `provenance-executed-sources-eol-divergent` WARN 保留，且只在**混合态**触发。生成侧与历史产物零改动（本批 7/7 raw match）。

### 5.5 本轮未执行（未授权前不得自行执行）

1. **commit / push**：本轮全部为本地工作树交付，**未 commit、未 push、未建分支、未动远端**。
2. **目标提交 attestation 生成**：`docs/reports/final-attestation.json`（现行 `675acf79…`，描述 `56f846ae…`）**未重生成**；P1 提交落定后需在该提交上重跑 `pnpm run attest`，并按 ADR 0005 D1 以 evidence 提交（trailer + record-only）单独提交。
3. **Node24 实测**：本机只有 `v22.23.1`，且未安装任何 Node24 / 版本管理器——**Node24 未实测**；`node24-compat` job 的结论只能来自授权推送后的运行日志。本表**所有**计数均为 Node 22 实测。
4. **mutation gate 远端运行**：本地 `check:mutation` 已实测 4/4 KILLED，但 `mutation-gate` job 的远端结果同样只能由推送后的 Actions 产生。
5. **远端 CI / 三平台 parity 实测**：`attestation-target`、`mutation-gate`、`node24-compat` 三个新 job 与既有 fingerprint parity 的远端结果一并以推送后日志为准；**本地绿 ≠ 远端绿**。
6. **P2–P6 后续批次**：未开始。

### 5.6 已登记的非阻塞观察（如实保留，未在本批修复，未静默丢弃）

| 来源 | 观察 | 影响 / 建议 |
| --- | --- | --- |
| t13 O1（low） | `src/types/contracts.ts` 的 `skipped` 注释写「never reached the eligibility decision」，实测 4 个累加点中有 2 个位于资格判定之后（匿名 gate `considered=1 / skipped=1` 可复现）；计数本身真实且彼此独立、未从别处推算 | **已闭环（见 §5.7，t19 修复）**——原建议文字保留：属措辞精度问题；建议由 t5 文件做一行注释修复，**不在本批 integration 写范围**（inScope 不含 `src/`） |
| t13 O2（low） | `mapHostAdvisorStatus` 以 `{...stats}` 原样转发，额外适配器字段可进入公开 status（注入 `toolName` 可实证）；真实 hook 适配器只返回 7 个计数，现状无泄漏 | 建议按键白名单加固，留待后续批次 |
| t14 O2（info） | `check:docs` 未断言 `unit + e2e == total`，未来出现第三类测试目录时不会报红 | 登记项，建议随下一轮文档门禁加固 |
| t11 O1（low） | 等价命中时摘要段重复推入断言使 `checked/passed` +1，混合态下同一 id 可同时出现在 `failures` 与 passed 计数中；**退出码不受影响，无假绿** | **已闭环（见 §5.7，t18 修复）**——原建议文字保留：建议删除重复推入 / 解耦分类条件 |
| t10 O2/O4（info） | 浅克隆失败码精度；`attestation-target` job 中 `pnpm install`（门禁不依赖依赖树）非必需 | 登记项 |
| t12 O2（info） | `{config: null}` 语义未在 ADR 0005 定义（回落宿主配置，无安全降级） | 登记项 |
| t15 O1（info） | M3 实测红数 3 而注册 must-red 2（第 3 条为 extraRed 观察，不参与判据） | 已在本表 §5.2 口径注明：必红 **2/2** 命中 + **观测红数 3**（含 1 条 extra red 观察，不参与判据）；同理 M1 观测 4、M2 观测 5、M4 观测 2 |
| t17/t16（已闭环） | README 命令表原先未列 `check:mutation` | 本条已由 t16 在 README 命令表补齐（§5.1） |

### 5.7 P1 批后续收口（t18/t19 闭环）与仍开放残余（2026-10-29，t24 追加）

> 本节只追加，不回写 §5.1–§5.6。t21 最终发布审核的 F1 要求在此登记：§5.6 中两个记为未修的 low 观察已在 t18/t19 收口，其原观察文字保留在 §5.6（该处状态列已改为「已闭环」并回指本节）。

**已闭环**

| 观察 | 收口任务 | 证据 |
| --- | --- | --- |
| t11 O1（low）：等价命中时摘要段重复推入断言使 `checked/passed` 虚增 1，混合态下同一 id 同时进入 `failures` 与 passed 计数 | **t18** | 删除报告段对 `provenance-executed-sources-eol-equivalent` 的第二次 `results.push`（全文仅剩 1 处 assert），断言语义收窄为「仅描述等价命中本身」，真实 drift 仍由 `provenance-executed-sources-match-disk` 独立失败并驱动 exit 1。证据：t20 §6.2 自建夹具 A/C 对照（checked 643 vs 642、passed 627 vs 626、failed 不变）、混合态 exit 1 且等价 id 不入 failures、checked=passed+failed（14/14）；**t21 §7 真实 LF 检出实测 checked=692 / passed=692 / failed=0**、`eolEquivalents=2`、混合态仅 match-disk；专属套件 21/21；真实工作树 691/691（`eolEquivalents=[]`） |
| t13 O1（low）：`src/types/contracts.ts` 的 `skipped` 注释称跳过「never reached the eligibility decision」，与实测累加点相反 | **t19** | `src/types/contracts.ts` 注释重写为「判定之前的跳过 + 部分资格判定之后的 out-of-scope / 无名工具路径（已计入 `considered`）」，并声明与 outcome 计数每 dispatch 互斥。证据：t20 §6.2/§6.3 逐点核对 5 个累加点（`dsh-hook-host-adapter.ts` 1096/1099/1120/1173/1177，其中 1099/1120/1177 在 `considered += 1`（880 行）之后）；t21 探针 34/34 复跑；类型面零改动、tsc exit 0 |

**仍开放（如实登记，未修，不误称已修）**

| 残余 | 归属 | 现状 |
| --- | --- | --- |
| t13 O2（low）：`mapHostAdvisorStatus` 以 `{...stats}` 原样转发，额外适配器字段可进入公开 status（注入 `toolName` 可实证） | t5 文件（`src/host-triggers.ts`） | **未修**；真实 hook 适配器只返回 7 个计数，现状无泄漏；建议按键白名单加固（留待后续批次） |
| t20 新登记（low/info）：t19 新注释把判定前跳过写成「advisor off or the runtime gate closed」，但 advisor 未挂载（`advisor === undefined`）时本适配器根本不计数 | t5 文件（`src/types/contracts.ts` 注释） | **未修**；可观测到的判定前跳过只有运行时闸门（`/evo jit off`）一种；建议一行措辞收敛。附注：t19 未在台账留下 output 记录，本条结论来自 t20/t21 对工作树与代码的独立核对 |
| t12 O2（info）：`{config: null}` 语义未在 ADR 0005 定义（回落宿主配置，无安全降级） | ADR 0005 / t4 入口 | **未修**；登记项 |
| t14 O2（info）：`check:docs` 未断言 `unit + e2e == total`，未来出现第三类测试目录时不会报红 | `scripts/verify-readme-counts.mjs` | **未修**；登记项 |

其余 info 级残余（t10 O1–O5、t12 O1、t14 O1、t15 O2–O7）与 t11/t13/t14 的完整观察列表分别保留在 `docs/reports/t10…t15` 六份审核报告与 `docs/reports/t21-final-p1-release-review.md` §7，本表不重复展开、也不声称已修。
