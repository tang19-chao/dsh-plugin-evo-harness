# P62_STATUS — P6.2 发布收口状态表（C0+C1 首轮，t3 终态集成版）

> 本表是 P6.2 首轮（p62-safe-release-closure）的发布状态页，与 ADR 0002（`docs/adr/0002-p62-release-contract-and-default-safe-shape.md`，契约冻结，sha256 `95A7126B18499D20…`）配套。
> 本版为 **t3 终态集成版**：在 t12 限定修复与 t13 独立复核（verdict=pass）之后，按 ADR §11.3 五状态如实登记交付、接线、默认启用、独立验证与发布状态；released 本轮恒否。
> 状态生命周期（逐级推进，不得跳读）：**delivered → wired → default-enabled → independently-verified → released**（定义见 ADR 0002 §11.3）。
> 本表只陈述**机制与默认安全形态**，不宣称任何真实任务收益；历史负结果（research-v1 路径）原样保留。

## 0. 基线与环境

| 项 | 值 |
| --- | --- |
| 契约基线 HEAD | `d2f80254a51a9e927100d02b00703badcb963ffe`（`d2f8025`，docs(p6.2): PR-A and PR-B review reports；本轮全程工作树交付，**未 commit/push**） |
| 前序提交 | `a5bd889` feat(p6.2): unified learning eligibility, trusted verification, conservative selection（PR-A/PR-B，评审均 PASS） |
| 契约文档 | `docs/adr/0002-p62-release-contract-and-default-safe-shape.md`（accepted，2026-10-25，t6 修订版；sha256 `95A7126B18499D20…`，**t3 未改动**） |
| 验证环境 | win32/x64，Node `v22.23.1`，pnpm `11.7.0`（t2/t13/t3 实测一致） |
| 证据报告 | `docs/reports/p62-release-closure.md`（本版新增，t3 集成收口报告） |
| 上一版本表 | t1/t6 版 sha256 `4516125B3D60DCF6…`（已被本版取代；t13 复核时该版仍未变，属 t13 绑定范围内的预期状态） |

运行口径：`pnpm test` = 77 文件 / 1562 测试（unit 66/1411 + e2e 11/151）；六条主门禁 + guarded regression 见 §5。

## 1. 已交付的默认安全形态（对照契约口径，逐面陈述事实）

| 面 | 契约口径（ADR 0002，t6 修订 + t10/t12 裁定） | 本轮实际交付事实（代码/装配级） |
| --- | --- | --- |
| 执行模式 | 四模式 baseline / shadow / guarded-active / off；**声明默认 `execution.mode=shadow`**（= 宿主 baseline 执行 + 建议记录）；off 七面语义不变；显式区分**宿主 baseline**（宿主行为逐字节不变）与**基础 evo search**（隔离分支内可回滚探测） | `resolveExecutionProfile()` 默认 `shadow`；`shadowRecords=true`；off 停止七面（`off=true`）。**基础 evo search 面**：默认 shadow 下 L1 建议调整与 L2 K 候选选择**仍运行**（t10 裁定，t6 冻结行为）；只有显式 `baseline` 模式才完全不拦截（`interceptExecution` 读同一 effective profile）。宿主侧无外部副作用 |
| 永久 patch 应用 | **默认禁用**（含 winning patch 挂载）；仅 guarded-active + 证据规则/显式探索预算 | `applyWinningPatch = deps.applyWinningPatch === true && profile.permissions.patch.allowed`，默认均 false；挂载点二次校验 profile 并输出拒绝诊断。库直接构造（省略 deps）也默认 false（t7/V1 关闭） |
| guarded-active | 仅显式启用；缺省 fail-closed | 仅 `mode='guarded-active'` 打开保守门；显式 `conservativeGate=true` 在 shadow/baseline/off 下构造即抛错（t7/V2 关闭） |
| patch 权限 | 默认 deny | 默认 shadow/baseline/off 下 deny；guarded-active 下为「证据门控」而非白名单 |
| publish 权限 | 默认 deny；本轮任何路径不解锁 | `allowed=false` 恒成立；**代码内不存在 publish 调用点**，权限位仅作为报表/诊断常量输出（不得表述为「发布门已生效」） |
| memory 权限 | 本轮一律不真实写入（含验证与评审过程） | deny 为默认且任何 config 形状不可加宽；**t12：deny 时 orchestrator 在调用点之前直接返回，完全不调用 memory bridge**（无 `ephemeral`/改名作用域替换），诊断如实输出「N lesson(s) NOT committed … the memory bridge was not called」。显式 `ExecutionProfileInput.memoryRealWrites=true`（无 config 字段可产生、插件入口从不设置）仅用于确定性测试装配；mirror 在权限门后，默认零后端调用 |
| reward 契约 | r4/verifier-first-v1 一次性原子切换，数值标尺冻结 | `CURRENT_REWARD_VERSION='r4/verifier-first-v1'`、`PREVIOUS_REWARD_VERSION='r3/unified-signals-v1'`、schema=2、provenance=`p2/per-execution-v1`；旧 r3/r2/surrogate/future/missing 自动隔离；rescore 通道 `r4@rescore-v1` 需完整 provenance |
| 学习资格与可信边界 | C2 前仅 verification shape，不称来源可信 | shape-only passed/failed 不建立 task-quality 学习资格；`taskQualityEvidence`（FACT，仅可信 + verdict 派生为 true；unknown 恒 false）与消费门 `taskQualityLearningEligible` 分离，记录盖戳 `learningTrack`（unknown→`process`）；可靠失败学习 = C2 未完成项 |
| 显式字段 / replay | decisionMode + actionKeyVocabulary + rewardVersion 显式；replay 声明口径重建，缺省 fail-closed | 记录显式携带三字段；生产 dream replay 以 **effective profile** 派生声明（`recordModeOf(mode)/signature`），调用方显式声明优先于工厂默认（t12/R3b2）；未声明记录（L3 host_tool、cold-start backfill）**被排除且不被改写为当前模式**，排除数在 dream 诊断中可见 |

## 2. 工作项五状态（t3 终态）

| 能力项 | delivered | wired | default-enabled | independently-verified | released | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| C0-1 nEff 全链贯通（orchestrator/L1/L2/replay） | ✓ | ✓ | ✓ | ✓ | ✗ | 替换判定只认 nEff，缺失 fail-closed（不得以 support 冒充）；记录共报 nEff/support。验证：t2 六例 F4 + t13 复跑 |
| C0-2 统一 evaluation 派生（reward/eligibility/taskSuccess/executionSuccess） | ✓ | ✓ | ✓ | ✓ | ✗ | recorder 单源消费同一 evaluation；C2 前 tightened 资格口径见 §1/§6 |
| C0-3 显式决策字段（decisionMode/actionKeyVocabulary/rewardVersion） | ✓ | ✓ | ✓ | ✓ | ✗ | replay/restart 按声明重建；**已知限制**：声明分区会排除未声明生产者的记录（§6-②） |
| C0-4 替换策略模块（replacement-policy） | ✓ | ✓ | **✗** | ✓ | ✗ | wired=生产路径经过 `if (conservativeGate)` 判定点；**default-enabled=否**——保守门仅 guarded-active 打开，默认 shadow 下 `decideReplacement` 不被调用（estimation 仍每决策测量并记录强度） |
| C1-1 r4 原子切换 | ✓ | ✓ | ✓ | ✓ | ✗ | 七处一次切换 + 双向空认证表；可信生产者缺席时定性为保守隔离，不代表 C2 已交付 |
| C1-2 默认安全形态 + 显式授权边界 | ✓ | ✓ | ✓ | ✓ | ✗ | 默认 shadow + patch/publish/memory 恒 deny；永久 patch 应用/自动发布/真实 memory 默认禁用 |
| C1-3 guarded regression 套件 | ✓ | — | — | ✓ | ✗ | `scripts/eval/guarded-regression.mjs --json`（门禁第 7 条）+ `tests/unit/p62/release-contract.test.ts`；当前 **25/25** |

说明：wired 指该能力已进入生产装配路径（非仅类/类型存在）；default-enabled 指默认形态下行为实际开启。上表 C0-4 的 wired/default-enabled 分歧即为该区分的实例。**released 本轮恒为 ✗**（无发布/部署，无 C2–C4）。

## 3. reviewed SHA 与证据绑定

| 项 | 值 |
| --- | --- |
| 终态 HEAD | `d2f80254a51a9e927100d02b00703badcb963ffe`（`d2f8025`） |
| 工作树 diff 指纹（tracked） | `e1da67b4fa06d6ce885a848469652b79cb9fed7f`（口径 `git diff \| git hash-object --stdin`；**只覆盖 HEAD 已跟踪文件**，与 t13 评审绑定值逐字节一致） |
| 代码面内容指纹（含未跟踪新文件） | `c9faeeb43581a4aad515d4f7ae565f242236afc6805e021f07434b56215d604c`（口径：`src/`、`tests/`、`scripts/` 下全部 182 文件按 `路径:sha256` 排序后取 sha256；补充 diff 指纹的未跟踪盲区） |
| 工作树构成 | 24 modified + 6 untracked（代码/测试/脚本交付面，t4–t12）；t3 另新增 1 份未跟踪文档（`docs/reports/p62-release-closure.md`）→ 终态 24 modified + 7 untracked。`24 files changed, 1870 insertions(+), 252 deletions(-)`；无删除、无越界目录 |
| 契约文档指纹 | ADR 0002 sha256 `95A7126B18499D20…`（t6 版，t3 未改动；t1 版 `E88FB9C9D9E7E02D…` 已被取代） |
| 独立复核 | t13（independent-reviewer）：**verdict=pass**，绑定 HEAD+diff 指纹与本表所列关键文件 sha256，四项待验断言独立复现，七条门禁复跑全绿 |

关键文件 sha256（按 ADR §11.2 范围，终态）：

| 文件 | sha256（前 16） | 文件 | sha256（前 16） |
| --- | --- | --- | --- |
| `src/types/contracts.ts` | `E1BA3DA9683B2475` | `src/orchestrator.ts` | `85268ED056CF29FF` |
| `src/jitrl/logit-adjuster.ts` | `AD536D2E545CA4AE` | `src/config.ts` | `9E194DBCCF16E651` |
| `src/jitrl/value-estimator.ts` | `60A9F3D7F464059E` | `src/index.ts` | `F686A36F4002A964` |
| `src/jitrl/replacement-policy.ts`（新） | `1EE5CE7233E68D08` | `src/dream-rsi/offline-dreamer.ts`（未改） | `42811C38795A91F5` |
| `src/jitrl/reward-contract.ts` | `6C42F29E1C212E66` | `src/runtime/execution-profile.ts`（新） | `69E8A44145B69ADE` |
| `src/jitrl/experience-store.ts` | `058582DA5F397454` | `scripts/eval/guarded-regression.mjs`（新） | `B0AA51220F63D70A` |
| `src/jitrl/index.ts` | `3D1EE1F14DB54C09` | `tests/unit/p62/release-contract.test.ts`（新） | `8876AF317BE20052` |
| `src/jitrl/step-evaluator.ts` | `50ACB8B6FE8D8794` | `tests/e2e/memory-backends.test.ts` | `77821CC442131DCF` |
| `src/jitrl/decision-kernel.ts`（未改） | `69647913DB8C399E` | `tests/e2e/lifecycle.test.ts` | `57A3301531659274` |
| `src/jitrl/jit-active-policy.ts` | `F528CF00D93E43C3` | `README.md`（仅计数同步） | `BAAA3ACE97E52726` |

未改动的冻结面（HEAD 原样）：`src/jitrl/decision-kernel.ts`、`src/dream-rsi/offline-dreamer.ts`、`src/jitrl/action-normalizer.ts`、`src/cordis-seams/**`、研究评测引擎版本臂常量。

## 4. 实现文件范围与实际改动

ADR §11.2 冻结清单（实现范围）：`src/types/contracts.ts`、`src/jitrl/{logit-adjuster,value-estimator,replacement-policy(新),reward-contract,experience-store,index,step-evaluator,decision-kernel}.ts`、`src/orchestrator.ts`、`src/config.ts`、`src/index.ts`、`src/dream-rsi/offline-dreamer.ts`、`src/runtime/execution-profile.ts`（新）、`tests/`、`scripts/eval/guarded-regression.mjs`（新）、`docs/adr/0002-*.md`、`docs/P62_STATUS.md`。

本轮实际改动（`git status`，代码/测试/脚本面 24 modified + 6 untracked；t3 文档面另加 1 份报告）：

- **modified**：`README.md`（仅 R9.1 要求的测试计数同步 77/1562）、`src/config.ts`、`src/index.ts`、`src/jitrl/{experience-store,index,jit-active-policy,logit-adjuster,reward-contract,step-evaluator,value-estimator}.ts`、`src/orchestrator.ts`、`src/types/contracts.ts`、`tests/`（e2e 5 + unit 7 文件）。
- **untracked（新增）**：`docs/P62_STATUS.md`、`docs/adr/0002-p62-release-contract-and-default-safe-shape.md`、`scripts/eval/guarded-regression.mjs`、`src/jitrl/replacement-policy.ts`、`src/runtime/execution-profile.ts`、`tests/unit/p62/release-contract.test.ts`；t3 追加 `docs/reports/p62-release-closure.md`。

范围外说明（如实登记，非隐瞒扩张）：`src/jitrl/jit-active-policy.ts` 承担 R1b 的 baseline/off 不拦截开关（t7–t10 修复所需），属 ADR §11.2 冻结清单内的接线面；`src/config.ts` 的 `execution` 组校验为 R1/R2 的前置。未触碰 `src/jitrl/action-normalizer.ts`、`src/cordis-seams/**`、研究臂常量与 `docs/reports/` 既有报告。

## 5. 全量门禁结果（七条）

| # | 命令 | 通过标准 | 结果（t13 独立复跑 + t3 终态复核一致） |
| --- | --- | --- | --- |
| 1 | `pnpm run typecheck` | exit 0 | **exit 0**（tsc --noEmit，0 error） |
| 2 | `pnpm test` | exit 0，全绿，README 计数同步 | **exit 0**；Test Files **77 passed (77)**，Tests **1562 passed (1562)** |
| 3 | `pnpm run check:docs` | exit 0，不与另一全量 vitest 并发 | **exit 0**；README 77/1562 == 真实 vitest（unit 66/1411 + e2e 11/151） |
| 4 | `pnpm run build` | exit 0，产出 lib/index.js | **exit 0**（lib/ 为 .gitignore 产物） |
| 5 | `node scripts/eval/negative-result-diag.mjs --json` | exit 0，历史负结果未抹去 | **exit 0**；`meanDelta=-0.25`、`matchesHistorical=true`、`degradedTaskShare=0.4167`、退化任务 `ci-04/mig-01/mig-02/mig-04/test-03` 原样 |
| 6 | `node scripts/eval-jitrl.mjs --json` | exit 0，默认 CLI 正常 | **exit 0**；`episodes=5`、`taskCount=12`、`deterministic=true`；未实现 ablation（A1/A4/A5 等）如实列出 |
| 7 | `node scripts/eval/guarded-regression.mjs --json` | exit 0，支持 --json，覆盖 F1/F2/F4、隔离、shadow 无副作用、holdout/授权/回滚、reservation | **exit 0**；`{total:25, passed:25, failed:0}`（含 F1 隔离、F2 rescore 通道、F4 六例、R5-6 释放、C2a 全模式 deny、C1p/C1s/C1r、R8、F3 冻结标尺、T10-R2b/R2c/R3b、T8-V5b 静态扫描） |

补充证据（本轮新增，均在门禁 7 / 门禁 2 内）：`t12/R2-residual`（默认 + 四模式共 5 套装配，接受任意作用域的注入桥零调用；正控显式授权正常写入）、`t12/R3b2`（同池两种声明 stateValue +5 / −5）、`t12/R1c`（config=shadow 注入 baseline→L1 不拦截、注入 guarded-active→拦截；dream 声明随 effective profile 切换）、`tests/e2e/memory-backends.test.ts` 三后端默认装配零后端写入。

## 6. 已知限制与诚实边界（不构成完成项）

1. **C2 前无可信验证来源**：仅交付 `TrustedVerification` 的 shape 与结构/hash 校验；shape-only passed/failed 不建立 task-quality 学习资格，**可靠失败学习未解禁**（C2 未完成项）。
2. **R8 声明分区会排除未声明生产者的记录**：L3 host-tool 采集与 cold-start backfill 的存量记录不携带 `decisionMode/actionKeyVocabulary`，在声明式 replay 中被 fail-closed 排除（**不**改写为当前模式）；排除数已作为 dream 诊断输出，便于状态观测。
3. **publish 无调用点**：权限位恒 false，仅为报表常量；本轮不存在可变发布对象，故不得表述为「发布门已生效」。
4. **字段命名歧义**：`taskQualityLearningEligible` 对 unknown 记录为 true（它是消费门，`taskQualityEvidence=false` 才是 FACT 标志）；重命名/收敛列入 C2 前置或下一轮清理项。
5. **C0-4 保守门非默认开启**：默认 shadow 下替换判定不被调用（仅 estimation/记录生效），这是设计选择而非缺陷。
6. **研究路径冻结**：research-v1 两臂版本戳不变，`tests/e2e/jitrl-ablation.test.ts` 与 negative-result-diag 历史负结果原样保留；本轮改动对研究复现路径是加性的。
7. **无真实收益声明**：本表仅证明默认安全形态与机制接线，不宣称任务收益；历史负结果不改写、不淡化。
8. **ADR 文本待裁定项**：见 §7——ADR 不在 t3 的 inScope（`docs/P62_STATUS.md`、`docs/reports/`），且 t13 的 pass 绑定 ADR 指纹 `95A7126B…` 未变；就地修改 accepted ADR 属契约变更，需 captain 重新裁定后方可执行。

## 7. ADR 一致性待裁定清单（t3 只登记，不改 ADR）

| 编号 | 位置 | 问题 | 建议措辞（供 captain 裁定） |
| --- | --- | --- | --- |
| A1 | ADR §13 第 2 条 | 首句「默认装配**不**禁用任何永久 patch 应用、自动发布或真实 memory（t6 修订后口径）：」与后半句及 §3/§4 自相矛盾（多一个「不」） | 删除首句的「不」：「默认装配禁用任何永久 patch 应用、自动发布或真实 memory」 |
| A2 | ADR §3 shadow 行与「约束」 | 现文「执行=baseline 执行逐字节不变」「不改先验执行」易被读成 shadow 完全不拦截；实际默认 `shadow` 下**基础 evo search** 面的 L1 建议调整与 L2 K 候选选择仍运行（t6 冻结、t10 裁定） | 保留「宿主 baseline 行为逐字节不变 + 零外部副作用（不 applyPatch/publishPolicy/writeMemory）」；补一句「基础 evo search 面在 shadow 下仍经 L1/L2 建议调整；只有显式 `baseline` 模式完全不拦截」 |
| A3 | ADR §4 memory 行 | 「本轮一律不真实写入」未写执行点，易被理解为「写了但被后端拒绝」 | 补「deny 时 orchestrator 在调用点直接不调用 memory bridge（无 ephemeral/改名作用域替换），桥调用次数为 0」（t12 事实） |
| A4 | ADR §5.2a / §6 unknown 行 | 未反映字段实况：`taskQualityEvidence=false`（FACT）而 `taskQualityLearningEligible=true`（消费门），记录盖戳 `learningTrack='process'` | 补上述字段实况，并注明字段名歧义（§6-④）留待 C2 前清理 |
| A5 | ADR §3/§4 publish 行 | 未写明「本轮无 publish 调用点，权限位是报表常量」 | 补一句与 §6-③ 一致的事实描述 |
| A6 | 本表旧 §1（t6 版） | 「作用域内 governed commit carve-out 落 ephemeral 命名空间」与 t12 事实相反 | **已在本版删除并更正**（§1 memory 行）；ADR 侧无对应旧措辞需处理 |

## 8. C2/C3/C4/D：入口、可并行前置与授权边界（计划项，均未完成）

### C2（可信验证来源；ADR §9 边界已冻结）
- **已具备的 shape 前置**（本轮交付，均为 delivered/wired/verified——**不代表 C2 已交付**）：`TrustedVerification` 字段契约（status/verifierId/verifierVersion/evidenceHash/checks/implicit）；`hasTrustedVerificationProvenance` 结构校验；**hash 绑定**执行证据（不匹配拒绝、匹配通过）；`trustedProducers` 调用方自有 Set 注入接缝（生产不传 = 冻结空表，非全局注册器）；生产路径 `isRegisteredTrustedVerifier` 恒 false 回归。
- **尚缺（C2 本体）**：真实可信 verifier 服务/receipt 生产者（本轮零调用、零真实来源）、由其派生的 passed/failed 可信 verdict（可靠失败学习解禁的前提）、以及真实模型/付费与真实 memory 的**用户显式授权**。
- **可并行准备（不改变本轮发布边界）**：生产者接入文档与验收口径冻结（由 captain/用户）；沿用同一 evaluation 派生，不得绕过 R4 直接改 reward；不得改 r4 数值标尺/资格语义/词典序钳制/版本认证表。

### C3/C4（源方案后续阶段）
- ADR 0002 只定义了 C0/C1/C2 的边界，**仓库文档未冻结 C3/C4 的内容、验收口径与文件范围**，故本轮不实施、不预判、不标记任何完成项。
- **入口条件（先决）**：① captain/用户给出 C3/C4 的验收口径与文件范围（沿 ADR §11.2「越界须回 captain 重新裁定」机制）；② 每阶段独立验证 + 独立评审 + 七条门禁；③ 通用前置同上（shape 边界、单独评审、released 解禁）。
- 未冻结口径前不得以「计划项」冒充交付；本表不为其预留任何 ✓。

### D（部署/真实试验决定）
- **需用户另行授权**；本轮不做。一切真实模型/付费调用、真实 memory 写入、发布/部署（含 git commit/push）均在本轮授权边界之外。

## 9. 范围外事项与授权边界（本轮恒不做）

- **不实施 C2–C4**（§8）；**不调用真实模型/付费接口、不写真实 memory、不发布/部署、不 commit/push**（除非用户另行明确要求）。
- 默认装配禁用永久 patch 应用（含 winning patch 挂载）、自动发布与真实 memory；宿主 baseline 与基础 evo search 显式区分，off 语义不变。
- 验证与评审过程同样零网络、零付费、零真实 memory 写（探针均用 mock/fake 后端）。
- 研究路径冻结不变（§6-⑥）。

## 10. 更新纪律

- **2026-10-25 t1（release-architect）**：初版，随 ADR 0002 冻结契约；七项能力五状态全部如实 ✗。
- **2026-10-25 t6（release-architect）**：按 captain 修正令修订 ADR 与本表——废除 `applyWinningPatch` 默认 true 豁免；收紧 C2 前可信边界（shape≠来源、failed 需可信 provenance、unknown 不入 task-quality 学习）；r4 定性为保守隔离；门禁统一七条。
- **2026-10-25 t4（core-implementer）**：C0+C1 实现落地（nEff 全链、统一 evaluation、显式字段、replacement-policy、r4 七处原子切换、默认 shadow + 三层 deny、guard-regression 脚本）。
- **2026-10-25 t2（gate-verifier-glm，attempt 2）**：独立验证；七条门禁真跑全绿，五项边界探针 V1–V5 如实登记为 findings。
- **2026-10-25 t5（independent-reviewer）**：verdict=needs_revision（12 findings，含 V1–V5）。
- **2026-10-25 t7（gate-verifier-glm）**：修复独立验证发现的 V1–V5（patch 双条件门 + 挂载点二次校验；shadow/baseline/off + `conservativeGate` 构造即拒绝；task-quality 轨道拆分；noop 按证据；移除公开字符串注册器）并固化为生产回归。
- **2026-10-25 t8（gate-verifier-glm）**：repair-round-2——关闭 t5 的其余 R1–R7（off/baseline/shadow 真接线、memory 权限、replay/restart 字段消费、shadow 强度记录、grant/revoke 公开接口与 reservation 幂等），复查 V1–V5 无回归。
- **2026-10-25 t9（independent-reviewer）**：verdict=needs_revision（8 findings，含 1 blocker：memory 权限未在调用点执行）。
- **2026-10-26 t10（core-implementer）**：repair-round-3，8 项关闭，七门禁全绿。
- **2026-10-26 t11（independent-reviewer）**：verdict=needs_revision（5 findings，含 1 blocker R2-residual 与 high R3b2）。
- **2026-10-26 t12（release-integrator-ds）**：限定收尾修复——memory deny 调用点前阻断（零桥调用）、replay 声明合并顺序、单一 effective profile（orchestrator/L1/replay）、恒真探针替换、未声明记录不升级；七门禁全绿（77/1562）。
- **2026-10-26 t13（independent-reviewer）**：限定独立复核 **verdict=pass**，四项断言独立复现，七门禁复跑全绿，绑定 HEAD `d2f8025` + diff 指纹 `e1da67b4…`。
- **2026-10-26 t3（release-integrator-ds）**：终态集成——本表按五状态如实更新，新增 `docs/reports/p62-release-closure.md`，登记 §6/§7/§8 限制与计划项；**未改 ADR、未改 src/tests/scripts、未 commit/push**。
- 历史结论不回写；needs_revision 不改写为完成；状态只在工作项实际达到时推进（wired 必须指生产装配路径实际经过该代码，default-enabled 必须默认形态下实际开启）。
