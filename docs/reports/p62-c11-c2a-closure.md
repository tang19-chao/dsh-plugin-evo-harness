# P6.2 第二轮收口报告（C1.1 发布边界补漏 + C2a 可信本地验证闭环 + C3 成本台账契约与离线 fixture）

> 角色：`ledger-engineer`（兼 t12 集成状态证明与七门禁复跑责任员）。
> 依据：ADR 0003（`docs/adr/0003-publish-verification-and-cost-contract.md`，accepted，rev.3 冻结版）与 `docs/P62_STATUS.md`（t12 终态版）。
> 性质：**终态集成收口报告**——汇总本轮团队 `p62-c11-c2a-closure` 全部 21 项任务交付、独立验证（t7/t8/t9）、独立评审（t10/t11）、限定修复与复审（t14/t15/t16/t17/t18/t19/t20/t21）的最终事实、工作树指纹与门禁见证。
> 约束：本报告只陈述机制、契约与默认安全形态，**绝不宣称任何真实任务收益**；历史负结果（research-v1 路径）原样保留；**released 恒为否**（无 commit/push、无真实部署、无付费模型调用、无真实 memory 写入）。

---

## 0. 结论摘要

| 项 | 结论事实 |
| --- | --- |
| **本轮目标** | 完成 ADR-0003、C1.1 默认发布边界补漏、C2a 可信本地验证最小闭环，并仅并行准备 C3 成本台账契约与离线 fixture；不做 C4、真实付费模型调用、真实 memory、部署或 commit/push |
| **六态判定** | 严格区分 `implemented → wired → default_enabled → independently_verified → release_authorized → actually_applied`（ADR-0003 §8.1）；`release_authorized` 恒 ✗、`actually_applied` 恒 ✗、`released` 恒为否 |
| **代码交付状态** | **已就绪**。代码/测试/脚本面工作树包含 11 modified + 13 untracked 产物（共 24 项产物，详见 §1）；未 commit/push |
| **七条主门禁 + 专项** | **全部 exit 0**（串行复跑实测一致，见 §5）：`typecheck` 0 error；`pnpm test` 86 文件 1666 测试全绿；`check:docs` SUCCESS；`pnpm run build` exit 0；`negative-result-diag` exit 0；`eval-jitrl` exit 0；`guarded-regression` 33/33 passed |
| **C1.1 发布边界** | **闭环完成**。publish 执行受体接入，四模式默认恒 deny；修复 deny 下 `appliedJit` 虚假热替换报告（t10 F-1 关闭，t16 复审 PASS）；t14 持久化反例在 8 种笛卡尔积组合下 revision 增量恒 0；idle 入口纳入审计；holdout-missing 严格 fail-closed |
| **C2a 可信验证** | **闭环完成**。宿主自有 runner 与 artifact 摘要强制绑定；双回执同卷（reference+candidate 均附回执）；伪造/错绑/旧 artifact/超时 12 类异常全拒并带明确原因码；WeakMap 宿主注册表加固来源认证（t11 F-3 关闭，t20 复审 PASS）；无 seam 时逐字节等价退化；**质量消费者保持未接线** |
| **C3 成本台账** | **契约与离线 fixture 闭环完成**。防重复计费、三态计量、保守非零地板（关闭 t11 F-1）、已结算调用重复预留拒绝（关闭 t11 F-2，t19 复审 PASS）；接入 11 个确定性离线场景函数（消除 t19 Y-1 死 fixture，t21 PASS），在 offline-fixtures.test.ts 中以 12 个 it() 充分覆盖；36 项 ledger 单测全绿；**零生产接线，零外部 import** |
| **未做范围** | **C2b**（质量消费者接线）、**C3 生产实施**（线上模型计费/动态路由/输出折叠）、**C4**（跨机协同/扩展）、**D**（自动发布/真实部署/真实付费调用/真实 memory 写入/commit/push）**全部未做** |

---

## 1. 最终绑定指纹与工作树构成

> **口径废止声明（rev.3 集成轮 t11，2026-10-27）**
> 本节的三个指纹（`846c85ee…`、`bd6fad15…`、`13c4c3cf…`）全部取自**工作树字节**。
> 该口径已被 PR-1 废止：本仓 `core.autocrlf=true`（对象库 LF / 检出 CRLF），
> 工作树摘要因此**依赖检出平台**，在 LF 环境下无法复现——本轮已在 ADR 0003 附录上实测到
> 14/15 个文件摘要不匹配（见 `work/t1-baseline-audit.md` §5 F-1）。
>
> **本节的数字作为该轮的历史证据原样保留，不重算、不覆盖**（重算等于篡改历史）。
> 需要复现历史时请用**同一口径**（工作树字节）在 `core.autocrlf=true` 的 Windows 检出上进行。
>
> **现行口径**为 `git cat-file` 原始 blob 字节 / blob id，产出
> `{commitId, treeId, compositeSha256, bindingSha256}`，可用 `--verify` 重算；
> 现行值见 `docs/reports/final-attestation.json` 与 `docs/P62_STATUS.md` §0.1。

### 1.1 Git 基线与 Diff 指纹（历史快照，工作树口径）

| 维度 | 指纹 / 散列值 | 说明 |
| --- | --- | --- |
| **基线 HEAD** | `9ea9b7edacb199884df2020df879f4e59ed66d73` | `9ea9b7e feat(p6.2): close C0+C1 release contract and safe defaults`（**历史基线**；rev.3 轮实际基线为 `84a3d82…`） |
| **代码面 Tracked Diff (SHA-1，排除自指终态文档与收口报告)** — 历史快照 | `846c85ee0c06471226cfc0150e7d84e912d9a323` | `git diff -- . ':(exclude)docs/P62_STATUS.md' ':(exclude)docs/reports/**' \| git hash-object --stdin`（工作树口径，跨平台不可复现） |
| **代码面 Tracked Diff SHA-256** — 历史快照 | `bd6fad155a6418a38856cfdd5e96c41fce11969f1ea0bc335b0c4699251d34b5` | 同上；「二进制流 96,795 / PowerShell LF 拼装 94,540」的差额正是该口径缺陷的自述 |
| **代码面 Tracked Diff 字节大小** — 历史快照 | `96,795 bytes` | 11 个已跟踪修改文件（+1660 / -75 lines），**工作树**字节数 |
| **全仓代码面组合指纹** — 历史快照 | `13c4c3cff2c59183dc49416e242a0231bfbda1adb6ff7057a96b5e4b2ee693be` | 当时 `src/`+`tests/`+`scripts/` 206 个文件，**工作树字节**口径；**请勿用它复算当前代码** |

### 1.2 工作树核心修改与新增产物明细（代码/测试/脚本面）

```
Tracked Modified (11 files):
  README.md                                       (a35a3750, 27463B) - 机械同步测试计数 (86 files / 1666 tests)
  scripts/eval/guarded-regression.mjs             (9c151d5c, 93934B) - 扩充 C1.1/C2a 专项探针至 33 条
  src/dream-rsi/offline-dreamer.ts                (d7b1346b, 70621B) - C1.1 发布受体受控接线与 holdout 校验
  src/index.ts                                    (d2693183, 123288B)- appliedJit 绑定真实 publication.publish
  src/jitrl/decision-kernel.ts                    (fdf68a44, 48145B) - holdout-missing fail-closed 语义
  src/orchestrator.ts                             (de6439b0, 148790B)- C2a 宿主 runner 接缝与双回执 attach
  tests/unit/dream-rsi/dream-rsi-pipeline.test.ts (ebcf50c8, 12423B) - C1.1 发布边界单测
  tests/unit/dream-rsi/jit-dream.test.ts          (88365150, 45457B) - Jit-wired 发布受体单测
  tests/unit/dream-rsi/offline-dreamer.test.ts    (aa2b5e71, 50320B) - holdout 校验与 idle 审计单测
  tests/unit/jitrl/runtime-control.test.ts        (475404a8, 33578B) - appliedJit 真实替换与反例覆盖
  tests/unit/p62/release-contract.test.ts         (7a66e6dd, 78617B) - 8 种笛卡尔积组合发布边界回归

Untracked Deliverables (24 files in src/tests/scripts, 含 attestation 脚本):
  scripts/eval/final-attestation.mjs              (001f4c94, 6343B)  - 终态可复现指纹清单与 attestation 生成脚本
  scripts/fixtures/ledger/index.ts                (b7dda524, 168B)   - C3 离线 fixture 导出入口
  scripts/fixtures/ledger/sample-rate-cards.ts    (f2f09b78, 2664B)  - 确定性费率表示例
  scripts/fixtures/ledger/scenarios.ts            (54a3110d, 17169B) - 11 个确定性离线台账场景函数
  scripts/fixtures/ledger/synthetic-payloads.ts   (9f5286ac, 3707B)  - 合成用量测试载荷
  src/ledger/index.ts                             (dbcf706f, 398B)   - C3 台账契约导出入口
  src/ledger/ledger-event.ts                      (333959a8, 2183B)  - UsageLedgerEvent 事实事件结构
  src/ledger/pricing.ts                           (4831a17d, 7231B)  - 计价契约、三态计量与重复扣减防护
  src/ledger/reservation-manager.ts               (18ca2b20, 17081B) - 预算预留管理、幂等结算与保守地板
  src/ledger/types.ts                             (1d6dad84, 9610B)  - 契约类型与拒绝枚举
  src/verification/artifact-digest.ts             (8bdfac77, 2741B)  - 宿主 artifact sha256 重算
  src/verification/attach.ts                      (a98d17a8, 25643B) - 宿主回执绑定、来源认证与 WeakMap 注册表
  src/verification/host-runner.ts                 (97ff4c19, 8076B)  - 宿主自有本地 runner 运行器
  src/verification/index.ts                       (a5361efc, 1618B)  - C2a 模块导出入口
  src/verification/types.ts                       (3a5efe99, 8301B)  - C2a 可信回执与 disposition 类型
  tests/e2e/c2a-trusted-verification.test.ts      (6b41e9d3, 22172B) - C2a 端到端可信证据流单测
  tests/unit/cordis-seams/trajectory-collector-c2a.test.ts (4970e13a, 3908B) - 轨迹采集器不透传元数据验证
  tests/unit/ledger/offline-fixtures.test.ts      (556acf3f, 6900B)  - 12 个 it() 离线台账确定性测试（覆盖 11 个场景函数与 r4 边界，断言事件非空）
  tests/unit/ledger/pricing.test.ts               (28f7d90b, 8430B)  - 计价契约与防重复扣费单测
  tests/unit/ledger/reservation-manager.test.ts   (08397500, 15133B) - 预算生命周期与 F-1/F-2 缺陷测试
  tests/unit/verification/attach.test.ts          (47c8dbcc, 29160B) - 回执绑定与原因码拒绝单测
  tests/unit/verification/audit-provenance.test.ts (406c1286, 13645B) - 审计来源不可伪造性测试
  tests/unit/verification/host-runner.test.ts     (4d13f616, 11986B) - 宿主 runner 执行与空 checks 拒绝单测
  tests/unit/verification/recorder-marks.test.ts  (1e475b17, 19504B) - 记录器标记与双回执同卷测试
```

---

## 2. C1.1 发布边界补漏成果整合

依据 ADR-0003 §3 与 t4/t7/t10/t14/t15/t16 的闭环交付：

1. **执行受体（Receptor）与默认恒 Deny**：
   - 彻底消除了 ADR-0002 遗留的「`permissions.publish` 无调用点」事实。在 `src/dream-rsi/offline-dreamer.ts` 中接入生产发布受体；
   - 在 baseline、shadow、guarded-active、off 四种模式下，默认 `executionProfile.permissions.publish.allowed === false`，任何在线热替换与持久 revision 写入均被拦截；
   - 探针与单测证明：四模式 × Jit on/off 全部 8 种组合下，`applyPolicy` 调用次数为 0、在线策略对象未改变、`policy.history.jsonl` 增量为 0。
2. **appliedJit 虚假热替换报告根治（t10 F-1 关闭）**：
   - `src/index.ts:1271` 由初版的 `jitOn && report.improved ? ...` 收敛为必须绑定真实发布事实：`jitOn && report.publication?.publish === true ? holder?.policy?.jit : undefined`；
   - 彻底切断了在 default deny 且存量策略包含 `jit` 块时状态面谎报发生热替换的缺口；
   - t16 独立复审以三重证明确认关闭（原始探针复核、四字段一致性、正控证明非硬编码 undefined）。
3. **持久化与状态一致性保障（t14 关闭）**：
   - 在 default deny 下，`publication.publish` 恒为 `false`，`shadow.published` 恒为 `false`，`status.appliedJit` 恒为 `undefined`，三字段自洽无矛盾；
   - 持久化历史 `policy.history.jsonl` 严格保持零写入；
   - idle 入口（`agent/status -> idle`）热替换被统一封堵，纳入审计日志。
4. **Holdout 严格 fail-closed 语义**：
   - `offline-dreamer.ts` 与 `decision-kernel.ts` 中明确：未提供 holdout 树或 holdout 验证不通过时，`decideReplayPublication` 判定为 `holdout-missing` 并拒绝发布。
5. **登记项说明（t10 F-2）**：
   - 评审发现 `resolveExecutionProfile()` 中的 `shadowMode` 派生自 `mode === 'shadow'`，若将来外部强行传入异构配置可能存在覆盖风险；
   - 依据 Captain 裁定，本轮不在代码中改变 `shadowMode` 现有逻辑，仅作为未来 G1 授权接线门禁的核验登记项。

---

## 3. C2a 可信本地验证闭环成果整合

依据 ADR-0003 §4、§5 与 t5/t8/t11/t18/t20 的闭环交付：

1. **宿主自有 runner 与 Artifact 摘要绑定**：
   - 实现 `src/verification/host-runner.ts` 与 `src/verification/artifact-digest.ts`，由宿主自有 runner 执行本地轻量检查，并强制计算 artifact 的 `sha256:64hex` 摘要；
   - `src/orchestrator.ts` 中的 `verifyAndAttach` 负责回执绑定，将宿主摘要回填至 `deliverable.contentHash`，使打分器原有的 `expectedEvidenceHash` 比对在生产形态真正生效（T3 落地）。
2. **双回执同卷（Symmetric Verification）**：
   - 彻底消除 baseline 与 candidate 之间的验证覆盖不对称。`orchestrator.ts` 在 reference 评估与 candidate 评估两侧均调用 `verifyAndAttach`，杜绝因单侧验证导致的虚拟 learningTarget 差异。
3. **真值表五行行为与 12 类异常全拒**：
   - 严格落实 ADR-0003 §4.3 真值表：
     * row 1: `succeeded + trusted passed` → `auditOnly=false`, `taskQualityEvidence=true`, `completion=1`；
     * row 2: `succeeded + trusted failed` → 拦截造假成功，强制 `auditOnly=true`, `reasonCode='falsified-success-claim'`, `reward=0`；
     * row 3: `failed + trusted failed` → **可靠失败学习正例**，`auditOnly=false`, `taskQualityEvidence=true`, `reward <= 0`；
     * row 4: `failed + trusted passed` → 矛盾判定拦截 (`contradictory-verdict`)；
     * row 5: `timeout + trusted failed` → 拦截将超时伪造成任务失败，`forceAuditOnly=true`, `reasonCode='execution-not-completed'`。
   - 12 类伪造、错绑、旧 artifact、异 test set、异 env、异 run、空 checks 均被明确原因码拒绝并剥离不可信元数据。
4. **审计来源认证与宿主注册表加固（t11 F-3 关闭）**：
   - 依据 t11 评审发现（无 seam 时仅凭三布尔可伪造 `metadata.verificationAudit`），在 `src/verification/attach.ts` 中引入 `HOST_AUDIT_REGISTRY = new WeakMap<object, HostAuditRegistration>()`；
   - 读取侧实施五道认证防护：①对象同一性与本轨迹绑定；②按注册事实校验；③必带 verifierId/verificationId/artifactDigest；④artifactDigest 必与当前 artifact 重算一致；⑤attached 标记必与原回执一致；
   - t20 独立复审以 12 种攻击面测试确认：纯三布尔、手动补齐字段、深浅拷贝、跨轨迹迁移、原地篡改等伪造 payload 全被安全拒绝；
   - 默认无 runner 时保持逐字节等价，不写 audit 键，保持纯净退化。
5. **登记项说明（t20 X1）**：
   - `applyVerificationDisposition` 仍在公开导出面（`src/verification/index.ts:42`），在同进程内恶意代码理论上可调用注册接口；
   - 依据 t20 裁定，因本轮无多租户隔离风险且默认无生产接线，该项作为 low 登记项留待 C2b 阶段进行模块内部私有化收敛。
6. **质量消费者边界明确**：
   - **C2a 质量消费者保持未接线**。生成的真实任务质量回执不直接开放给在线 JIT 学习策略强化；消费门与记录门保持隔离。

---

## 4. C3 成本台账契约与离线 Fixture 成果整合

依据 ADR-0003 §7 与 t6/t9/t11/t17/t19/t21 的闭环交付：

1. **计价契约与防重复计费（`src/ledger/pricing.ts`）**：
   - 显式要求声明 `countingSemantics`（至少 `inputIncludesCacheRead` 与 `outputIncludesReasoning`），未声明自动降级为 `provenance: 'unknown'` 并进入保守非零地板；
   - 防重复计费：`inputIncludesCacheRead` 为 true 时从输入中精确扣除 cacheRead（`netInput = input - cacheRead`）；`outputIncludesReasoning` 为 true 且非单独计价时不重复加算 reasoning；
   - 三态计量传播：`measured` / `estimated` / `unknown` 精确聚合。
2. **保守非零地板与自相矛盾根治（t11 F-1 关闭）**：
   - 在 `src/ledger/reservation-manager.ts` 中，对 `actualCostMicros` 分支彻底修复：
     * 无 usage 载荷时，强制置 `provenance = 'unknown'`（绝不伪称 `estimated`），置 `conservative = true`，并施加 `Math.max(rawMicros, fallbackFloor)`；
     * usage 精度为 unknown 时，同样严格施加 `conservative = true` 与 `fallbackFloor` 兜底，并记录 `conservativeSurchargeMicros`，消除了「金额为 0 却标 conservative=true」的逻辑矛盾；
     * 保持反向对照：对真实 measured 的 0 成本保持为 0，精准限制在 unknown 范畴。
3. **已结算调用防重复预留（t11 F-2 关闭）**：
   - 在 `reservation-manager.ts` 的 `reserve()` 入口新增 `this.settledCalls.has(callId)` 校验，返回公开枚举 `'call_already_settled'`；
   - 彻底关闭了已结算 callId 再次 reserve 导致额度与席位永久滞留的会计漏洞，保证总额度、预留额度与席位零泄漏。
4. **消除死 Fixture 并接入全部场景离线测试（t19 Y-1 关闭，t21 完成）**：
   - 在 `tests/unit/ledger/offline-fixtures.test.ts` 中新增 3 项测试，实际接入 Scenario 9（0 成本无 usage）、Scenario 10（0 成本 unknown usage）、Scenario 11（二次预留拒绝）；
   - 配合已有的 Scenario 1–8（重复计费、二次扣减、未知成本、取消结算、6 阶段全流程调度、预算耗尽 fail-closed、验证池独立隔离、席位释放 ≠ 金额退款），实现全部 11 个确定性离线场景函数由 offline-fixtures.test.ts 的 12 个 it()（含 r4 边界）100% 测试执行覆盖；
   - `tests/unit/ledger` 专项测试达到 36 项全绿。
5. **严格零生产接线约束**：
   - `src/ledger/**` 仅被自身内部与 `tests/unit/ledger/**` 引用，全仓其他业务模块零 import；
   - 零网络调用、零付费模型、零动态路由、零输出折叠；`r4` learningTarget 与权重散列全零改动未触碰。

---

## 5. 全量门禁与专项探针复跑全量记录（七门禁 + 专项）

本轮收口在当前最终字节上串行复跑全部门禁命令，所有命令均以 **exit code 0** 通过：

| # | 门禁命令 | 验证口径与标准 | 实测结果 | 关键见证输出 |
|---|---|---|---|---|
| **1** | `pnpm run typecheck` | `tsc --noEmit` 0 error | **passed (exit 0)** | 编译无任何类型报错，代码与契约类型 100% 对齐 |
| **2** | `pnpm test` | 全量 Vitest 测试全绿 | **passed (exit 0)** | **Test Files: 86 passed (86), Tests: 1666 passed (1666)**，耗时 17.24s |
| **3** | `pnpm run check:docs` | 文档与测试计数机械比对 | **passed (exit 0)** | Unit 74/1509, E2E 12/157, Total 86/1666 逐项精确匹配 |
| **4** | `pnpm run build` | esbuild 产出 `lib/index.js` | **passed (exit 0)** | 成功打包 ESM 运行时 bundle，零 warning / 零 error |
| **5** | `node scripts/eval/negative-result-diag.mjs --json` | 历史负结果不被抹去 | **passed (exit 0)** | `meanDelta: -0.25`, `matchesHistorical: true`, 5 退化任务保持原样 |
| **6** | `node scripts/eval-jitrl.mjs --json` | 确定性评测 Harness 正常 | **passed (exit 0)** | `seed: 0xfe348428`, `taskCount: 12`, 确定性指标块输出一致 |
| **7** | `node scripts/eval/guarded-regression.mjs --json` | 33 项安全与边界探针 | **passed (exit 0)** | **summary: { total: 33, passed: 33, failed: 0 }** |

### 5.1 专项探针执行记录

- **Ledger 契约专项** (`pnpm exec vitest run tests/unit/ledger`):
  3 files / 36 tests passed (pricing 10, reservation-manager 14, offline-fixtures 12)，exit 0。
- **C2a 可信验证专项** (`pnpm exec vitest run tests/unit/verification tests/e2e/c2a-trusted-verification.test.ts`):
  5 files / 62 tests passed (host-runner 14, audit-provenance 9, attach 24, recorder-marks 9, e2e/c2a 6)，exit 0。
- **C1.1 发布受体专项** (`pnpm exec vitest run tests/unit/jitrl/runtime-control.test.ts tests/unit/p62/release-contract.test.ts tests/unit/dream-rsi`):
  9 files / 249 tests passed，exit 0。

---

## 6. 缺陷与发现关闭跟踪表（Finding Tracker）

| 缺陷 ID | 严重度 | 发现来源 | 缺陷简述 | 修复/加固动作 | 验证与复审证据 | 最终状态 |
|---|---|---|---|---|---|---|
| **t10-F-1** | medium | t10 评审 | deny 下 `appliedJit` 谎报发生热替换 | `index.ts:1271` 收敛为必须绑定真实 `publication.publish === true` | t15 单元测试 + t16 三重独立证明 (verdict=pass) | **已关闭** |
| **t10-F-2** | low | t10 评审 | `shadowMode` 派生自 `mode === 'shadow'` 的覆盖风险 | 登记为未来 G1 授权接线门禁核验项，本轮代码不作改动 | t10/t16 确认保留登记项，不阻断本轮发布 | **已登记 (G1 前置)** |
| **t11-F-1** | medium | t11 评审 | `actualCostMicros: 0` 绕过 unknown 保守下限且标记矛盾 | `reservation-manager.ts` 强制 unknown provenance 与保守地板 | t17 单元测试 + t19 十字用例逐笔重算 (verdict=pass) | **已关闭** |
| **t11-F-2** | medium | t11 评审 | 已结算 `callId` 可再次 reserve 导致额度席位永久滞留 | `reservation-manager.ts` 入口补查 `settledCalls`，返回 `call_already_settled` | t17 单元测试 + t19 六子用例验证零滞留 (verdict=pass) | **已关闭** |
| **t11-F-3** | medium | t11 评审 | 无 seam 时三布尔可伪造宿主审计标记 | `attach.ts` 引入 `HOST_AUDIT_REGISTRY` WeakMap 宿主注册表与五道门 | t18 单元测试 + t20 12 种攻击面复查 (verdict=pass) | **已关闭** |
| **t19-Y-1** | low | t19 复审 | Scenario 9/10/11 为未实际执行的死 fixture | `offline-fixtures.test.ts` 接入 3 项独立 it 测试，README 同步 +3 | t21 独立任务完成，全量 1666 测试通过 | **已关闭** |
| **t20-X-1** | low | t20 复审 | `applyVerificationDisposition` 仍在公开导出面 | 登记为 C2b 前置项，留待后续阶段在模块边界内部私有化 | t20 裁定非阻塞，登记入状态表与收口报告 | **已登记 (C2b 前置)** |
| **t23-Z-1** | low | t23 评审 | `offline-fixtures.test.ts` 的 r4 边界测试在 `eventCount=0` 下空转 | 边界测试先调用 6 阶段确定性场景生成事件并断言 `events.length > 0` | t24 单元测试更新，断言非空洞 | **已关闭** |
| **t23-Z-2** | low | t23 评审 | fixture 场景使用 `Date.now()` 生成 callId，字节级不可复现 | 确认金额数值投影 100% 确定可复现，无时间敏感断言，登记为确定性事实 | t23 独立探针双跑全过，本轮无需改代码 | **已登记 (数值确定)** |
| **t23-Z-3** | low | t23 评审 | tracked diff 指纹包含自指文档导致回填时序悖论与旧组合指纹不确定 | 明确 tracked diff 排除 `P62_STATUS.md` 与 `docs/reports/**` (`846c85ee…`/96,795B)；新增 `scripts/eval/final-attestation.mjs` 重新计算并固化 206 文件组合指纹 (`13c4c3cf…`)，输出机器可读清单 `docs/reports/final-attestation.json` | t25 独立重写并生成 attestation 清单，提供精确独立复现命令 | **已关闭** |

---

## 7. 边界、限制与未做范围说明

为确保工程与学术诚信，严格遵守 ADR-0003 §2 硬边界声明：

1. **六态生命周期终态**：
   - C1.1 发布受体：`independently_verified: ✓`, `release_authorized: ✗`, `actually_applied: ✗`；
   - C2a 可信本地验证：`independently_verified: ✓`, `release_authorized: ✗`, `actually_applied: ✗`；
   - C3 成本台账：`independently_verified: ✓`, `wired: ✗`（纯数据契约与离线 fixture，无生产接线）；
   - 全仓发布状态：**released 恒为否**。
2. **严禁越界的未做范围（Out-of-Scope）**：
   - **C2b 质量消费者接线**：未建立真实可信来源打分对 JIT 在线学习目标（learningTarget）的正向强化消费接线；
   - **C3 生产计费与动态路由**：未接入真实模型 API 计费监控，未实现基于 token 的动态路由或输出折叠；
   - **C4 跨进程/分布式协同**：未执行跨机或生产级集群协同调度实施；
   - **D 真实环境部署与付费调用**：零真实付费模型 API 调用、零真实持久化 Memory 写入、零线上自动发布、零容器/生产部署、零 Git Commit/Push。
3. **负结果与收益诚实性**：
   - 本报告及全套门禁仅证明**机制正确性、契约完整性与默认安全边界**；
   - 绝不宣称任何线上性能提升、任务成功率提升或 Token 成本节约；
   - 研究路径上的历史负结果（`meanDelta = -0.25`）原样保留并作为门禁探针持续监督。
