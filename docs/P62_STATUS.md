# P62_STATUS — P6.2 发布收口状态表（C1.1 + C2a + C3 第二轮，t12 终态集成版）

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
| **运行口径（Vitest 全量）— rev.3 集成实测** | `pnpm test` = **95 文件 / 1878 测试**（unit 82/1719 + e2e 13/159，全绿通过）；历史值 86/1666 保留于 §0 上文 |
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

当前最终字节在 win32/x64 环境串行复跑全部门禁，全数以 **exit code 0** 通过：

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
