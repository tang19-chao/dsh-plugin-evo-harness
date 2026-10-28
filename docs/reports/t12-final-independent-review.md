# T12 独立对抗性复核报告：安全、归因、测试与交付证据

- **任务编号**: `t12`
- **复核人身份**: `cost-architect` (C3 计量取消恢复契约架构, DeepSeek Harness AgentTeams)
- **复核性质**: 独立对抗性复核（覆盖 PR-1, PR-2, PR-3A, PR-3B, PR-4A, PR-4B 及补丁任务 t13/t14）
- **基线版本**: commit [`84a3d828ed2a27eef765c8b9c4950da4a9ee7287`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/docs/P62_STATUS.md)
- **复核时间**: 2026-10-27
- **运行环境**: Windows pwsh, Node.js v20+, pnpm v11.7.0, 纯离线环境（`liveCalls: 0`, `incurredRealUsd: 0.00`）
- **复核结论**: **PASS (通过)**

---

## 1. 独立对抗性审查 11 大核心维度评估

### 1.1 资格语义回退（`learningEligible` / `outcomeEligible` / `consumptionEligible`）
- **实现定位**: [`src/verification/quality-provenance.ts:115-123`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/src/verification/quality-provenance.ts#L115-L123), [`src/jitrl/decision-kernel.ts:1108-1148`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/src/jitrl/decision-kernel.ts#L1108-L1148)
- **机制与断言**:
  - `isAuthenticatedQualityRecord` 执行严密三重判定：必须显式声明 `rewardSources.verificationTrusted === 1`、`rewardSources.outcomeEligible === 1`，且 `learningEligible !== false`。
  - 任何标记为 `learningEligible: false` 的经验在质量鉴权层直接判定为非可信（`isAuthenticated` 返回 `false`）。
  - 在决策核 `selectTrackAtomically` 中，当 `qualityUntrusted === true` 时，质量轨被整体从候选池剥离（P0 阶段），状态机无条件回退至过程轨（`process`）或先验（`prior-default`）。
- **可观测测试证据**:
  - [`tests/unit/verification/quality-provenance.test.ts`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/tests/unit/verification/quality-provenance.test.ts) (14 tests passed)
  - [`tests/unit/jitrl/eligibility-contract.test.ts`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/tests/unit/jitrl/eligibility-contract.test.ts) (21 tests passed)
- **判定**: **PASS**。无语义倒灌与静默越权。

### 1.2 认证绕过 / recordId 冒充（C2b 内容摘要 vs recordId 标签，未认证数据仅审计）
- **实现定位**: [`src/verification/quality-provenance.ts:71-146`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/src/verification/quality-provenance.ts#L71-L146), [`src/verification/quality-provenance.ts:151-234`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/src/verification/quality-provenance.ts#L151-L234)
- **机制与断言**:
  - 注册表生命周期隔离：`QualityProvenanceRegistryImpl` 为内存挥发型单例，进程重启或显式调用 `clear()` 即重置，杜绝跨会话残留。
  - 摘要绑定覆盖范围（C2b 完整协议帧 `dsh-c2b-quality-record-v2`）：覆盖 `id`, `level`, `track`, `actionKey`, `reward` (固定6位小数), `return` (固定6位小数), `state_bucket`, `state_tokens` (排序后拼接), `schemaVersion`, `rewardVersion`, `provenanceVersion`, `sessionId`, `treeId`, `scope`, `taskId`, `trajectoryId`, `runId`, `policyId`, `decisionMode`, `vocabulary`, `rewardSources` (键按字典序排序序列化), 以及宿主回执上下文（`artifactDigest`, `verifierId`, `verifierVersion`, `verificationId`, `testSetId`, `envId`, `role`）。
  - 保持隐私性：不包含原始状态文本或摘要文本。
  - 任何改动 actionKey、reward、上下文参数，或仅提供文本 `recordId` 标签而无内存注册表凭据的数据，在鉴权时 `isAuthenticated` 均返回 `false`。
  - 未认证的持久化恢复记录仅用于审计，严禁静默降级为过程经验。
- **可观测测试证据**:
  - [`tests/unit/verification/quality-provenance.test.ts`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/tests/unit/verification/quality-provenance.test.ts)（篡改任意字段即失效，未注册 ID 鉴权恒为 false）
  - [`tests/e2e/c2b-quality-consumption.test.ts`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/tests/e2e/c2b-quality-consumption.test.ts) (2 tests passed)
- **判定**: **PASS**。无 recordId 仿冒通道。

### 1.3 跨轨 Q/V 混淆（先分别检索两轨后原子选轨，同轨同目标估计 Q/V）
- **实现定位**: [`src/jitrl/decision-kernel.ts:1078-1230`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/src/jitrl/decision-kernel.ts#L1078-L1230)
- **机制与断言**:
  - 先分别检索：过程轨与质量轨各自根据独立存储与目标分别检索并生成 `processDecision` 与 `qualityDecision`。
  - 原子选轨：`selectTrackAtomically` 在顶层执行轨间仲裁，决不在底层将质量轨的 Q 与过程轨的 Q 直接加权或混合比较。
  - 同轨同目标估计：两轨候选均通过 `evaluateTrackReplacement` 进行轨内评估（各自比较 challengerEstimate 与 priorEstimate）。
  - 优先序遵循契约：P0（未认证/缺省）-> P1（质量轨具备充分置换证据时胜出）-> P2（质量轨证据不足时整点回退过程轨评估结果）。质量轨无权修剪或否决过程轨既有动作。
- **可观测测试证据**:
  - [`tests/unit/jitrl/dual-track-consumption.test.ts`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/tests/unit/jitrl/dual-track-consumption.test.ts) (18 tests passed)
- **判定**: **PASS**。无跨轨 Q/V 交叉污染。

### 1.4 动作薄证据（`support` / `nEff` 审核，生产通用 nEff 保守门复用）
- **实现定位**: [`src/jitrl/decision-kernel.ts:1018-1076`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/src/jitrl/decision-kernel.ts#L1018-L1076), [`src/orchestrator.ts:2956-2981`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/src/orchestrator.ts#L2956-L2981), [`src/jitrl/replacement-policy.ts:170-220`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/src/jitrl/replacement-policy.ts#L170-L220)
- **机制与断言**:
  - `support` 绝对不冒充 `nEff`：`conservativeAdvantage` 仅在 `nEff` 达到门槛时提供非零校准优势；无 `nEff` 或 `nEff === undefined` 时直接归入 `implicitZeroAdvantage`。
  - 复用生产通用保守替换门：`evaluateTrackReplacement` 显式调用生产函数 `decideReplacement`，两轨统一执行 `challengerIsNoop` 否决、`implicit-zero` 拦截、`min-support` 约束以及探索预算检查。
  - 质量轨不仅通过 `decideReplacement` 校验，还受 `meetsMinQualityEff`（要求 `challengerNEff >= minEff && challenger.hasReplacementEvidence === true`）双重约束。
- **可观测测试证据**:
  - [`tests/unit/jitrl/value-estimator.test.ts`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/tests/unit/jitrl/value-estimator.test.ts) (34 tests passed)
  - [`tests/unit/jitrl/dual-track-consumption.test.ts`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/tests/unit/jitrl/dual-track-consumption.test.ts)
- **判定**: **PASS**。两轨严密复用同一生产门控。

### 1.5 未知计费（三态精度，未知非零保守地板）
- **实现定位**: [`src/ledger/pricing.ts:40-120`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/src/ledger/pricing.ts#L40-L120), [`src/ledger/limits.ts:140-185`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/src/ledger/limits.ts#L140-L185)
- **机制与断言**:
  - 显式声明三态精度：`measured`（精确度量）、`estimated`（分词/字符估算）、`unknown`（未知/不透明）。
  - 未知成本保守地板：根据 ADR-0004 §4.2，未知成本路由绝不记 0，强制收取 `conservativeFallbackCostMicros` 保守地板附加费，并作为独立项目单列，禁止伪装成真实计费。
  - 已知零成本（如精确度量的免费/离线桩）在精度为 `measured` 时保持真实 0，不被错误加收保底费。
- **可观测测试证据**:
  - [`tests/unit/ledger/pricing.test.ts`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/tests/unit/ledger/pricing.test.ts) (10 tests passed)
  - [`tests/unit/ledger/pr3a-metering-recovery.test.ts`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/tests/unit/ledger/pr3a-metering-recovery.test.ts) (20 tests passed)
- **判定**: **PASS**。无成本失真与偷漏记账。

### 1.6 取消与崩溃（本地停止等待 vs 远端终止确认两阶段模型，席位保留，迟到 usage 调和，WAL 仅追加持久化与崩溃恢复保持 `pending_reconciliation`）
- **实现定位**: [`src/ledger/reservation-manager.ts:280-450`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/src/ledger/reservation-manager.ts#L280-L450), [`src/ledger/wal.ts:60-140`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/src/ledger/wal.ts#L60-L140), [`src/ledger/reconciliation.ts:80-160`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/src/ledger/reconciliation.ts#L80-L160)
- **机制与断言**:
  - 本地停止等待 vs 远端确认：调用取消时，客户端本地断开并不代表远端停止计费。经理通过 `seatsRetainedPendingRemote` 保持席位与预留挂起，严禁在未收到远端确认前释放并发席位。
  - 迟到 usage 调和：`reconcileLateUsage` 派生超额方差（`derivedGeneralOverdraftMicros = max(0, -rawRemaining)`），既维持总账守恒方程 `verifyConservationLaw` 恒成立，又对审计发出超额方差警报。
  - WAL 仅追加且安全：WAL 写入严格禁止写向团队协作目录（`.agent-teams/`）。
  - 崩溃恢复：`recoverFromWal` 将所有中断未决预留重放为 `pending_reconciliation`，不假定费用为 0、不退款、不擅自释放潜在风险席位，总账平衡保持守恒。
- **可观测测试证据**:
  - [`tests/unit/ledger/pr3a-metering-recovery.test.ts`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/tests/unit/ledger/pr3a-metering-recovery.test.ts) (涵盖崩溃恢复幂等性、超额方差自愈、重复恢复零席位泄漏)
  - [`tests/unit/ledger/pr3b-limits-reconciliation.test.ts`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/tests/unit/ledger/pr3b-limits-reconciliation.test.ts) (41 tests passed)
- **判定**: **PASS**。生命周期与崩溃恢复状态机完全闭环。

### 1.7 硬上界夸大（经验证分词器、强制 `max_tokens` 参数、全计费项覆盖、网络重试封顶，无硬上界路由在硬模式下 `fail-closed` 拒止）
- **实现定位**: [`src/ledger/limits.ts:180-280`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/src/ledger/limits.ts#L180-L280), [`src/ledger/reservation-manager.ts:190-240`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/src/ledger/reservation-manager.ts#L190-L240)
- **机制与断言**:
  - 可证明物理硬上界必要条件：①分词器已经经验证（`tokenizerVerified === true`）；②生成参数强制包含 `max_tokens`（`maxOutputTokens > 0`）；③全计费项覆盖（输入、输出、请求底噪、缓存输入均参与计算）；④网络重试次数物理封顶（`maxRetries` 显式受限）。
  - Fail-closed 准入拒止：若以上任一条件不满足，该路由被判为 `isBounded === false`；在硬限额模式下（`hardBudgetStrict === true`），经理直接抛出 `UNBOUNDED_ROUTE_REJECTED` 拒绝准入。
  - 量纲安全屏障：通过 TypeScript 独特名义类型（branded types）`ExplorationSeatUnits` 与 `CurrencyMicros`，在编译期与运行时（`DimensionMismatchError`）彻底隔离席位数与货币数值，杜绝荒谬相加。
- **可观测测试证据**:
  - [`tests/unit/ledger/pr3b-limits-reconciliation.test.ts`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/tests/unit/ledger/pr3b-limits-reconciliation.test.ts)（测试用例 3B-L1 ~ 3B-L5 完备覆盖无界路由拒止、物理硬上界计算与量纲隔离）
- **判定**: **PASS**。硬限额边界真实可证。

### 1.8 五臂正交性（Arm-0 参照 + 2×2 因子格，消除 Arm-5，禁止编号定义臂，探索配额钉 0）
- **实现定位**: [`docs/reports/pr4a-five-arm-experiment-preregistration.md`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/docs/reports/pr4a-five-arm-experiment-preregistration.md) (V2), [`scripts/eval/eval-pr4a-five-arm.mjs`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/scripts/eval/eval-pr4a-five-arm.mjs)
- **机制与断言**:
  - 结构设计：
    * **Arm-0**: 冻结先验参照（process / updates=false / 门关），不参与 2×2 主效应分解。
    * **2×2 正交因子格**:
      - 因子 A（学习轨道）：过程轨（process） vs 可信质量轨（task-quality）；
      - 因子 B（保守门控）：门关（gate=closed） vs 生产 nEff 门开（gate=open）。
      - Arm-1: process + 门关；
      - Arm-2: process + 生产 nEff 门开；
      - Arm-3: task-quality + 门关；
      - Arm-4: task-quality + 同一生产 nEff 门开。
  - 彻底剔除伪正交的 Arm-5。
  - 移除硬编码编号判读 `enforceQualityTagBoundary(armId)`，以生产语义谓词 `isOnLearningTrack` 定义学习范围。
  - 探索预算硬控制：五臂中 `explorationAllowance` 全部钉死为 0，防止预算探索行为混杂进门控效应。
- **可观测测试与验证证据**:
  - `node scripts/eval/pr4a-stats.verify.mjs` (exit 0)
  - `node scripts/eval/verify-pr4a-artifacts.mjs` (176/176 机器断言通过, exit 0)
- **判定**: **PASS**。因子格严格正交可归因。

### 1.9 实验泄漏与错误统计（配对任务聚合，不把轮次当独立样本，精确 McNemar，禁止 Wilcoxon 套二值，检验力不虚报，合成数据不谎称真实法币）
- **实现定位**: [`scripts/eval/pr4a-stats.ts:120-260`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/scripts/eval/pr4a-stats.ts#L120-L260), [`scripts/eval/pr4a-report.ts`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/scripts/eval/pr4a-report.ts)
- **机制与断言**:
  - 独立单元边界：主假设以配对任务（n=12 paired tasks）为聚合分析单位，禁止将任务内的多轮多次交互（L=5）作为独立统计样本（避免伪重复 inflating sample size）。
  - 统计检验方法：对于二值成功率指标，严格采用**精确 McNemar 检验**（双侧单样本二项式翻转检验，查阅预注册临界值表），明令禁止使用 Wilcoxon 秩和检验拟合二值数据。
  - 功效客观诚实：明确注明 n=12 条件下最小可测效应量为 $d_{\min} = 0.809$（$\pi^* \approx 0.869$），且如实标为闭式理论近似，严禁虚报事后高功效。
  - 离线成本口径：测试使用合成桩（fake），台账明确声明 `liveCalls: 0`, `incurredRealUsd: 0.00`，micros 为记账无量纲单位，禁止谎称产生真实法币支出。
- **可观测验证证据**:
  - `node scripts/eval/pr4a-stats.verify.mjs` (McNemar 7/7 边界行全吻合，5/5 功效曲线吻合)
- **判定**: **PASS**。统计与口径高度审慎严谨。

### 1.10 Dreamer holdout 污染（生成前切分，分组与时序隔离，排除候选策略信息泄漏，删除 idle 回退）
- **实现定位**: [`src/dream-rsi/offline-dreamer.ts:88-160`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/src/dream-rsi/offline-dreamer.ts#L88-L160), [`src/index.ts:320-350`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/src/index.ts#L320-L350)
- **机制与断言**:
  - 先切分后生成：在策略生成器被调用前，已通过 `splitDreamerHoldout` 将发现树分割为选择集（selection）与留出集（holdout）。
  - 分组键与时序隔离：分组键按 `taskId` -> `sessionId` -> `id` 聚合；时序隔离要求可容许切满足 $\max(\text{selection}) \le \min(\text{holdout})$。若存在交叉时序反转，判为 `insufficient-temporal-isolation`，拒绝发布（`hasSufficientEvidence=false`）。
  - 排除候选排序信息泄漏：候选评估上限（`selectionCeiling`）严格仅依据选择集生成，留出集评估上限（`holdoutCeiling`）独立计算，留出集指标绝不参与选择阶段排序。
  - 彻底删除 idle 回退：`src/index.ts` 中 `dreamRun` 彻底移除了原先隐式调用 `deps.dreamer.replay` 的回退旁路；当 `triggerDream` 不可用时，直接安全中止，防止绕过发布闸链。
- **可观测测试证据**:
  - [`tests/unit/dream-rsi/pr4b-holdout.test.ts`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/tests/unit/dream-rsi/pr4b-holdout.test.ts) (27 tests passed)
  - [`tests/e2e/offline-dream.test.ts`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/tests/e2e/offline-dream.test.ts) (4 tests passed)
- **判定**: **PASS**。留出集完全独立，无未来信息渗透。

### 1.11 默认权限变化（`publish`、`patch`、`memory` 默认 `fail-closed`，baseline/shadow 零副作用不变）
- **实现定位**: [`src/config.ts`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/src/config.ts), [`src/orchestrator.ts`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/src/orchestrator.ts), [`src/dream-rsi/offline-dreamer.ts`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/src/dream-rsi/offline-dreamer.ts)
- **机制与断言**:
  - 发布控制闸门 G1/G2/G3：`publishAuthorized` 在所有默认装配及四种运行模式（`baseline`, `shadow`, `guarded-active`, `off`）下恒为 `false`。
  - `patch` 与 `memory` 权限默认处于 `fail-closed` 状态；`baseline` 与 `shadow` 运行模式下系统写副作用为 0。
- **可观测测试证据**:
  - [`tests/unit/p62/release-contract.test.ts`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/tests/unit/p62/release-contract.test.ts) (51 tests passed)
  - `node scripts/eval/guarded-regression.mjs` (37/37 probes passed)
- **判定**: **PASS**。安全边界零漂移。

---

## 2. 队长指令关键机制边界核实与说明

依据 Captain 针对 `t12` 复核的指导备忘，独立复核人对本次实验与代码实现中的机制边界进行了逐项核实与确认：

1. **Arm-4 `applied=0` 的物理真实含义**:
   - Arm-4 中改选被应用次数为 0，**绝不等于门控逻辑未接线或失灵**。
   - 证明：生产函数 [`decideReplacement`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/src/jitrl/replacement-policy.ts#L170-L220) 已由独立探针及 Arm-2 充分验证。在 Arm-2（过程轨开门）中，门控被有效触发 45 次（其中 35 次决定维持先验 `kept-prior`，具体包含 33 次 `implicit-zero` 拦截与 2 次 `min-support` 拦截）。
   - Arm-4 的接线通过 [`selectTrackAtomically`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/src/jitrl/decision-kernel.ts#L1082-L1230) 与 Arm-2 共用完全一致的执行代码与常数，其 `applied=0` 属于输入数据分布导致的自然前置现象。

2. **质量轨改选为零的根本机理（饱和效应与不可识别性）**:
   - 根本原因在于离线任务集中，可信质量轨执行成功的样本所获得的奖励高度饱和统一（通过执行的 reward/observedReturn 完全相同）。
   - 这导致估计出的 $Q$ 值几乎无差，优势值 $A = Q - V \approx 0$。在 $\text{argmax}$ 决策机制下，算法天然退回基准先验（prior）。
   - 各臂改选率对比：Arm-1 改选率为 `0.3111` (56/180)，Arm-2 降为 `0.0556` (10/180)，而 Arm-3 与 Arm-4 均为 `0.0000` (0/180)。
   - 因此，门控主效应 $\theta_{\text{gate}}$ 的全部信息量几乎完全由过程轨提供，交互效应 $\theta_{\text{int}}$ 在本轮样本中在经验上不可识别。**严禁在任何报告中表述为“门控在质量轨无效”或声称存在“轨道与门控的交互作用”**。

3. **统计结论与退化状态**:
   - 轨道主效应：$\theta_{\text{track}} = +0.167$（胜/平/负为 5/7/0），单侧 $p = 0.0625$，经 Holm 纠正后 $p = 0.250$，**在统计上不具备显著性**。
   - 全部四个估计量的证据状态（`evidenceStatus`）均为 `insufficient`（证据不足）。
   - 次要写入指标：$\theta_{\text{write}} = -0.167$，处于退化状态（`degraded`），退化任务比率 $\text{DTS} = 4/12 = 0.333$。
   - **本复核确认：退化与证据不足可以且确实并存**。

4. **报告权利声明与非主张约束**:
   - 复核确认 [`docs/reports/pr4a-five-arm-eval-report.md`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/docs/reports/pr4a-five-arm-eval-report.md) §11 及全文**未声明任何生产收益、未声明功效达成、未声明质量轨更优、亦未声称门控在两轨均经过了行为检验**。
   - 符合科学诚实性与预注册协议约束。

5. **ADR-0004-C3 下游任务引用确认**:
   - 经核验，[`docs/adr/0004-c3-metering-cancellation-recovery-and-limits-contract.md:11`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/docs/adr/0004-c3-metering-cancellation-recovery-and-limits-contract.md#L11) 已完整登记为 `t13 [preregistration-revision] 五臂正交实验预注册 V2`，引用完全准确闭环。

---

## 3. 全量离线门禁实测结果与可复跑性

在当前代码树状态下，独立复核人逐一实际执行了所有离线校验与测试门禁，全量通过：

| 门禁指令 | 执行耗时 | 输出断言 / 测试规模 | 退出码 | 状态 |
| :--- | :--- | :--- | :---: | :---: |
| `pnpm run typecheck` | ~1.5s | `tsc --noEmit`，仓内 0 error | `0` | **PASS** |
| `pnpm test` | ~32.2s | **95 个测试文件，1875 个测试全部通过，0 失败** | `0` | **PASS** |
| `pnpm run check:docs` | ~4.2s | README 统计（95 files / 1875 tests）逐字精确匹配 | `0` | **PASS** |
| `node scripts/eval/check-encoding-policy.mjs` | ~1.2s | 266 个跟踪 blob 检验，0 个未声明非 LF/BOM | `0` | **PASS** |
| `node scripts/eval/negative-result-diag.mjs --assert` | ~1.8s | 历史负结果断言 A1..A6 全 PASS，`--json` 形状无篡改 | `0` | **PASS** |
| `node scripts/eval/smoke-build.mjs` | ~3.8s | 独立编译 993,828 字节纯 ESM bundle，导出 68 项全部合法 | `0` | **PASS** |
| `node scripts/eval/pr4a-stats.verify.mjs` | ~1.5s | McNemar 边界、功效曲线、宽度预算、区间全吻合 | `0` | **PASS** |
| `node scripts/eval/verify-pr4a-artifacts.mjs` | ~1.2s | **176/176 机器一致性断言全部 PASS** | `0` | **PASS** |
| `node scripts/eval/guarded-regression.mjs` | ~1.2s | **37/37 关键保护探针全部 PASS** | `0` | **PASS** |
| `pnpm run build` | ~2.5s | esbuild 构建成功，产出 `lib/index.js` | `0` | **PASS** |

---

## 4. 交付文件规范 Git Blob 原始字节摘要索引

依据复核规范，所有正式交付物采用 `git hash-object` 原始字节 SHA-1 进行指纹固化：

| 文件路径 | Git Blob SHA-1 | 契约性质与审查焦点 |
| :--- | :--- | :--- |
| [`docs/adr/0004-c3-metering-cancellation-recovery-and-limits-contract.md`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/docs/adr/0004-c3-metering-cancellation-recovery-and-limits-contract.md) | `eb0f15099c6e523eb01f79c7798853e93c6649a2` | C3 计量/取消/恢复/限额 ADR 终稿（已引 t13 V2） |
| [`docs/adr/0004-c2b-trusted-quality-consumption-and-dreamer-holdout.md`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/docs/adr/0004-c2b-trusted-quality-consumption-and-dreamer-holdout.md) | `4708c8d04d98fda7f3eca307502e25b0710f96fc` | C2b 质量消费与 Dreamer 留出集 ADR 终稿 |
| [`docs/reports/pr1-commit-evidence-and-fingerprint.md`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/docs/reports/pr1-commit-evidence-and-fingerprint.md) | `516ce80eb94eaa9b820c2e187cb9e7873d25e121` | PR-1 提交对象权威与跨平台指纹报告 |
| [`docs/reports/pr4a-five-arm-experiment-preregistration.md`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/docs/reports/pr4a-five-arm-experiment-preregistration.md) | `af7ab9628512065f10374f357cbc2ed23620221f` | PR-4A 五臂正交实验预注册 V2 契约 |
| [`docs/reports/pr4a-five-arm-eval-report.md`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/docs/reports/pr4a-five-arm-eval-report.md) | `4a5779a46a5ccdadcaa5059d60b29dd5d557b34a` | PR-4A 五臂离线评测实验报告 |
| [`src/verification/quality-provenance.ts`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/src/verification/quality-provenance.ts) | `fc30616848460c9ffdf6da1b93fb79595d4c7e93` | C2b 宿主认证与内容摘要绑定模块 |
| [`src/jitrl/decision-kernel.ts`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/src/jitrl/decision-kernel.ts) | `970fd2cd241db9ac5b2f433291451ce72c6055c2` | 双轨原子选轨与两轨通用门控复用内核 |
| [`src/ledger/wal.ts`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/src/ledger/wal.ts) | `110a8716671b67b0264b2297bb2d75fd65f3570a` | C3 WAL 仅追加持久化引擎 |
| [`src/ledger/limits.ts`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/src/ledger/limits.ts) | `b9b83364452cc0d98881fc94703da2e50530344e` | C3 物理硬上界计算、量纲屏障与准入判定 |
| [`src/ledger/reconciliation.ts`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/src/ledger/reconciliation.ts) | `5b4b05744d0acf8fe405befc56e4e557c01cdbc8` | C3 账单外部调和状态机 |
| [`src/dream-rsi/offline-dreamer.ts`](file:///C:/Users/Administrator/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/src/dream-rsi/offline-dreamer.ts) | `c4e96aee5996d5867f9975e4145936c4ef357a19` | PR-4B 先切分后生成与时序隔离 Dreamer 引擎 |

---

## 5. 最终复核意见与裁决

本复核确认：
1. 涉及安全、归因、计量、回放、隔离、正交实验与统计检验的全部 11 项技术要求，均具备充分的代码级实现与可实测的判别力测试覆盖，无假通过、无绕过通道；
2. 队长指出的机理边界（Arm-4 applied=0 根因、饱和效应、统计不显著、退化与证据不足并存、§11 非主张声明、ADR 下游引用）已全部在实现与报告中得到核实与澄清；
3. 本次代码修改严格保持零真实 API/模型付费调用（`liveCalls: 0`, `incurredRealUsd: 0.00`），未做任何 `git commit`/`push` 操作，未发布、未部署；
4. 全量离线门禁（TypeCheck 0 error, Vitest 95 files / 1875 tests 100% 通过, Docs 计数精确匹配, 37/37 guarded probes 通过, 176/176 机器断言通过）均以物理 exit 0 确证。

**最终独立复核结论**: **PASS**。
