# ADR 0004：C2b 可信质量消费与 Dreamer 独立留出验证契约（含双轨分别检索、生产保守门复用与 Holdout 四维隔离）

| 项 | 值 |
| --- | --- |
| **状态** | **proposed / draft**（提议 / 草案；明确作为本轮及后续 PR-2 / PR-4B / PR-5 实现、独立验证与独立评审共同遵守的设计契约；**明确声明：本草案不代表已接受或已在线启用能力**） |
| **日期** | 2026-10-27 |
| **代码基线** | HEAD `84a3d828ed2a27eef765c8b9c4950da4a9ee7287`（`feat(p6.2): close C1.1 publish boundary and add C2a trusted local verification`） |
| **决策来源** | ①ADR 0001（权限分层与 shadow 口径）；②ADR 0002（C0+C1 冻结口径）；③ADR 0003（发布受体收口、C2a 宿主本地验证与回执绑定，§5.4 留出 C2b 边界）；④`work/t1-baseline-audit.md`（t1 基线审计与断言复验）；⑤Captain 2026-10-27 裁定（R1: ADR 0003 P 表为历史台账、§3/4/5/7 为 HEAD 规范；R2: 指纹仅 blob 原始字节；R3: PR-4B 移除 idle 回退；R4: 生产已有通用 nEff 保守门必须复用而非新建；R5: 放宽 t5 对 `experience-store.ts` 最小修改、t6 对 `model.ts` 修改；R6: 确立 index/orchestrator 并行合并纪律） |
| **决策起草** | quality-architect（C2b 与 Dreamer 契约架构） |
| **实施受体** | PR-2 (t5 可信质量消费工程)、PR-4B (t4 留出验证与发布受体彻底收口)、PR-5 (实验归因) |
| **影响范围** | `src/jitrl/decision-kernel.ts`（双轨检索、原子选轨、两轨 Q/V 估计）、`src/jitrl/index.ts`（L2/L3/replay/M3 消费端装配）、`src/jitrl/jit-active-policy.ts`（L1 消费端装配）、`src/jitrl/experience-store.ts`（放宽：支持双轨隔离检索与 track 查询辅助）、`src/dream-rsi/offline-dreamer.ts`（生成前切分、信息可见性、分组时序隔离、insufficient-evidence 判定）、`src/orchestrator.ts`（消费端接线与保守门复用）、`src/index.ts`（并行装配与配置开关） |

---

## 0. 核心术语与契约红线

### 0.1 术语约定
- **Process 轨（过程经验）**：执行层面的细粒度步骤与启发式反馈（composite heuristic / step rewards），覆盖高频但属于代理信号（proxy signals）。基线以 `PRODUCTION_LEARNING_TRACK = 'process'` 统一消费。
- **Task-Quality 轨（可信质量经验）**：经宿主自有 runner 在本轮运行内执行、并绑定不可伪造 artifact SHA-256 摘要与绑定六元组的可信回执结果（+1 成功或 ≤0 明确失败）。反映最终任务质量目标，样本稀疏但信任度极高。
- **统一学习资格（Unified Eligibility）**：由单一纯函数 `isLearningEligibleRecord` 判定的机器级布尔值，冻结两义性（outcome 否决 vs 审计编码）。
- **双轨分别检索（Dual-Track Separate Retrieval）**：在同一决策上下文状态下，对 Process 轨与 Task-Quality 轨分别执行独立的 Top-K 检索，严禁在底层单池中混合检索。
- **原子选轨（Atomic Track Selection）**：基于两轨各自独立的价值估计（Q/V）与有效样本量（$n_{eff}$），按不可分割的仲裁真值表判定最终动作。
- **Holdout 留出集**：在候选策略生成前从离线树池中剥离的评估集合，用于验证获胜候选策略的泛化性。
- **insufficient-evidence（证据不足）**：当样本容量、有效样本数或统计检验未能跨过最低可信置信度阈值时的 fail-closed 终态判决，明确拒绝发布或替换。

### 0.2 契约红线（严禁突破）
1. **统一学习资格语义冻结**：严禁修改 `reward-contract.ts` 中的 `isLearningEligibleRecord` 逻辑；严禁修改 `step-evaluator.ts` 中的 `isLearningOutcome` 语义；`isLearningOutcome('timeout') === true` 已被既有测试固定，超时异常必须在 attach/recorder 侧以审计编码（`learningEligible: false`, audit-only）处理，不得冒充任务失败。
2. **严禁生产新建重复保守门**：H4 仅为离线评测脚本内的探针命名，生产环境已存在完备的通用动作级 $n_{eff}$ 保守门（`src/jitrl/value-estimator.ts:459-486` 之 `conservativeAdvantage`，`src/jitrl/replacement-policy.ts:117-210` 之 `decideReplacement`，及 `src/orchestrator.ts:2957-2981` 的接线）。C2b 必须**直接复用该生产门**，严禁在生产代码新建并行的门控函数。
3. **默认关闭与无损回退（Default-Off & Safe Fallback）**：C2b 质量消费在生产中必须由显式配置项控制，**默认保持关闭（`default_enabled: false`）**。在默认关闭或任何异常情形下，消费行为必须与 HEAD 基线逐字节等价，严格退化为纯 Process 消费。
4. **历史台账与 HEAD 规范严格区分**：ADR 0003 正文中的 P-1…P-10 表为基线 `9ea9b7e` 的历史缺陷台账，HEAD `84a3d82` 已将其修复。不得将 P 表误作为 HEAD 现状重新实施。
5. **草案定位**：本文档为实施设计草案（draft），在 PR-2 / PR-4B 落地并经独立验证（t7/t8）和独立评审（t10/t11）通过前，**全系统严禁宣称已具备在线可信质量消费能力**。

---

## 1. 背景与问题定义

### 1.1 为什么 ADR 0003 之后必须有独立的 C2b 与 Dreamer ADR
ADR 0003 成功收敛了 P6.2 阶段的发布受体（C1.1）与本地可信回执闭环（C2a）。然而，在基线审计（`work/t1-baseline-audit.md`）与代码复查中确认：
1. **C2a 交付物仅是“写得进、读不出”的记录闭环**：
   - 生产环境的 L1/L2/L3/replay/M3 消费端一律以硬编码 `PRODUCTION_LEARNING_TRACK = 'process'` 过滤（`jit-active-policy.ts:745-747`、`index.ts:507,609,884,976`）。
   - C2a 产出的 `task-quality` 记录在底层被完全隔离，当前从未参与在线价值估计或策略推荐。
2. **“双轨分别检索与原子选轨”在当前基线完全不存在**：
   - `decision-kernel.ts` 中 `learningTrack` 命中数为 0。
   - 基线仅在 `experience-store.ts:1173-1180` 具备底层的分区过滤能力，既无分别查询两次的逻辑，更无原子选轨的仲裁状态机。若直接将两者混在同一个 Top-K 池中，高频的过程记录必然淹没稀疏的质量记录，导致质量信号无法被学习。
3. **Dreamer 留出验证（Holdout）存在四大结构性漏洞**：
   - **生产零传值**：`src/**` 中仅 `offline-dreamer.ts` 自身有 `holdoutTreeCount` 字段，`src/index.ts` 装配时从不传值，导致生产运行中 `validatedOnHoldout` 恒为 `undefined`，G3 门恒因 `holdout-missing` 拒绝（但仅靠拒绝发布无法使离线学习具备泛化验证能力）。
   - **未做到生成前切分（Pre-generation Split）**：当前的候选网格在切分前生成，若未来候选生成消费了树池统计，将直接造成留出集先验泄漏。
   - **缺乏任务分组（Group）与时序（Temporal）隔离**：当前仅做简单的尾部截断（`trees.slice(trees.length - holdoutCount)`），如果同一任务的多个子树分布在前后两段，将发生严重的组间数据穿越。
   - **缺少 insufficient-evidence 判决**：当样本数不足或置信度不足时，缺少结构化的证据不足判决。
4. **共享修改面存在冲突风险**：
   - `src/index.ts` 与 `src/orchestrator.ts` 是质量消费（C2b）与计量计费（C3）的共同集成面，若无严格的并行修改纪律与分块界限，会导致代码合并混乱。

因此，必须由独立的 C2b ADR 建立完整的设计规范。

---

## 2. C2b：可信质量消费架构规范

### 2.1 统一学习资格与两义性处理（继续冻结）
C2b 完整继承 ADR 0003 §5.1 的资格模型，保持单谓词权威：
```ts
// src/jitrl/reward-contract.ts
export function isLearningEligibleRecord(
  record: ExperienceRecord,
  expectedRewardVersion?: string
): boolean;
```
1. **单一消费谓词**：`decision-kernel.ts` 的 `isLearningEligibleExperience` 与 `experience-store.ts` 的查询过滤继续委托该函数，不增设第二谓词。
2. **两义性严格区分**：
   - **Outcome 否决**（`outcomeEligible === 0`）：用户主动取消（`cancelled`）、外部中断（`aborted`）或基础设施崩溃（`infrastructure_error`）。此类记录彻底不可学，reward 置 0，写入审计日志。
   - **审计编码**（`outcomeEligible === 1` 且 `learningEligible === false`）：包括未认证 verdict-derived completion、虚假成功声明、验证矛盾及某些异常执行带 verdict 的路径。**可信验证判定的 `failed + trusted failed` 是可靠失败，仍可学习，绝不能把“验证未通过”一概归为 audit-only**；超时是否可学仍按具体 attach/recorder 路径判断。审计记录保留有界原因码，供失败归因与离线诊断分析。
3. **超时门（Timeout Gate）实现位置**：
   - `isLearningOutcome('timeout') === true` 已被 `credit-attribution.test.ts:1253` 锁定，不得修改。
   - 超时记录的排除在 attach 侧或 recorder 侧以异常执行判定落地，标记 `learningEligible: false`，写入 `forceAuditOnly: true`。

### 2.2 宿主来源证据与六元组绑定
质量消费的前提是证据的绝对可信。依据 ADR 0003 §4：
1. **宿主自有 Runner 登记（T1–T2）**：回执必须由宿主 runner 在运行周期内按 `(runId, trajectoryId, role)` 登记；自报或未命中注册表的 payload 一律不可信（`unregistered-receipt`）。
2. **密码学摘要重算（T3）**：宿主使用 `node:crypto` 对交付物 artifact 字节计算 64 字符十六进制 SHA-256 摘要，覆盖写入 `deliverable.contentHash`。严禁依赖或比对 8 字符的 FNV-1a `hashString`（FNV 与 SHA-256 恒不相等）。
3. **六元组一致性绑定（T4）**：回执必须携带完整的绑定元组：
   $$\text{Binding} = \langle \text{taskId}, \text{testSetId}, \text{envId}, \text{runId}, \text{trajectoryId}, \text{role} \rangle$$
   任一字段缺失或与当前执行上下文不匹配，立即以 `binding-mismatch` 拒绝。
4. **Scorer / Attach 职责分界**：
   - `src/jitrl/step-evaluator.ts` 保持冻结，其 `TrustedVerification` 仅做结构检查且不识 `binding`。
   - 因此，**绑定校验（T4）、空 checks 校验（§4.6a(1)）、artifact 缺失校验（§4.6）全部由 attach 侧闭环完成**，以超集形式挂载于 `metadata.verification`。

### 2.3 进程重启与持久化派生策略（Restart & Persistence Derivation）
系统重启、崩溃恢复或冷启动时的经验处理规范：
1. **内存注册表生命周期隔离**：宿主 runner 的内存注册表是 per-run 且易失的，进程重启后自动清空。
2. **禁止追溯重标（No Retroactive Relabeling）**：
   - `learningTrack` 或普通 r4/rescore 文本标签本身不是宿主来源认证；重启后不得仅依据这些落库字段接纳质量记录。
   - 严禁通过文本解析 `verifierId` 或原地改写，将旧记录“晋级”为 `task-quality`。跨重启使用必须选择宿主管理且可验证完整性的证据存储，或重跑验证并生成新的、可追溯派生记录；`backfill.ts` 不得原地改写历史。
3. **统一来源认证与恢复拒绝**：质量记录须绑定经验内容摘要、轨迹/任务/作用域、交付物摘要、reward 契约、验证器及测试集/环境身份，以及适用的 reference 证据；仅 recordId、rewardVersion 或 checksum 均不充分。首期仅接纳当前受控运行中经认证且由 recorder 生成的质量记录；未认证恢复数据保留审计且不得进入质量邻域，也不得自动改标 process（其融合 reward 可能仍含未认证质量信号）。所有 query/snapshot/replay/M3 入口共享同一认证边界。

### 2.4 五大消费端统一消费边界
系统存在五个核心消费端，必须统一收敛到 C2b 门控之下：

| 消费端 | 基线状态（HEAD） | C2b 目标状态（默认关闭） | C2b 目标状态（显式开启） |
| --- | --- | --- | --- |
| **L1 Active Policy** (`jit-active-policy.ts:745`) | 硬编码 `filter(isOnLearningTrack(..., 'process'))` | 同基线（仅消费 process） | 双轨分别检索 + 原子选轨 |
| **L2 Proposal Policy** (`index.ts:609`) | 硬编码 `learningTrack: 'process'` | 同基线（仅消费 process） | 双轨分别检索 + 原子选轨 |
| **L3 Advisor** (`index.ts:507`) | 硬编码 `learningTrack: 'process'` | 同基线（仅消费 process） | 双轨分别检索 + 建议融合 |
| **Replay Kernel** (`index.ts:884`) | 硬编码 `replaySnapshot` 仅保留 process | 同基线（仅消费 process） | 支持按轨重放或双轨对齐重放 |
| **M3 Fresh Count** (`index.ts:976`) | 硬编码 process 分区刷新计数 | 同基线（仅统计 process） | 独立维护 process 与 quality 刷新计数 |

---

## 3. 双轨分别检索与原子选轨（Dual-Track & Atomic Selection）

### 3.1 为什么必须分别检索（Separate Retrieval）
1. **样本密度失衡（Density Skew）**：过程记录（密集单步）与质量记录（端到端可信产出）数量差距可达 10~100 倍。若单池混合 Top-K，Jaccard 相似度会把稀疏但关键的质量样本挤出窗口。
2. **信号异质性（Heterogeneous Variance）**：过程回报是探索性、启发式的连续值；质量回报是经真实评测断言的离散值（+1 / ≤0）。混合打分会导致 Kish 有效样本量 $n_{eff}$ 畸变。

### 3.2 双轨分别检索协议
在输入决策状态 $S$ 下：
1. **过程轨查询**：
   $$R_{proc} = \text{store.query}(S, \text{track}='process', k=k_{proc}, \text{learningEligibleOnly}=true)$$
2. **质量轨查询**：
   $$R_{qual} = \text{store.query}(S, \text{track}='task-quality', k=k_{qual}, \text{learningEligibleOnly}=true)$$
3. **同轨同目标估计（Intra-track Estimation）**：
   - 对每一个候选动作 $a \in \mathcal{A}$：
     - 在 $R_{proc}$ 上独立计算：支持数 $\text{supp}_{proc}(a)$、Kish 有效样本数 $n_{eff}^{proc}(a)$、优势值 $A_{proc}(a)$；
     - 在 $R_{qual}$ 上独立计算：支持数 $\text{supp}_{qual}(a)$、Kish 有效样本数 $n_{eff}^{qual}(a)$、优势值 $A_{qual}(a)$。
   - 两轨各自运行生产通用保守收缩（`conservativeAdvantage`），输出各自的收缩优势与替换有效性。

### 3.3 复用生产通用保守门（H4 的生产真实载体）
根据 Captain 裁定及代码实测，**生产环境已有动作级保守门**，C2b 必须直接复用：
- **估计收缩半边**：`src/jitrl/value-estimator.ts:459-486` 之 `conservativeAdvantage(estimate, options)`
  - 严格只认 $n_{eff}$，移除任何 `nEff ?? support` 回退；
  - 判定条件：`hasEvidence = Number.isFinite(nEff) && nEff >= minEff && support > 0`；
  - 优势收缩公式：$\text{shrunkAdvantage} = \frac{A \cdot n_{eff}}{n_{eff} + K}$（无证据时强制置 0）。
- **决策裁决半边**：`src/jitrl/replacement-policy.ts:117-210` 之 `decideReplacement(input)`
  - 仲裁硬规则：
    1. **隐式零伪证据硬否决（implicit-zero artefact veto）**：若候选动作依托回退或 noop 得到优势且无实测证据，而 Prior 具备证据或更高支持数，直接否决（`gateReason: 'implicit-zero-advantage'`）；
    2. **薄证据受限探索**：无证据候选（$n_{eff} < n_{min}$）仅在拥有显式探索预算（`explorationAllowance > 0`）时才允许以探索模式执行；
    3. **无预算拒绝**：薄证据且无探索预算，Prior 胜出，输出 `gateReason: 'min-support'` 或 `'exploration-budget'`；
    4. **充沛证据放行**：两全证据下方可基于收缩优势执行替换。
- **调度接线面**：`src/orchestrator.ts:2957-2981` 已完整调用上述双半边。C2b 严禁编写任何新的 `minSupportGate` 生产函数。

### 3.4 原子选轨仲裁状态机（Atomic Track Selection State Machine）
在相同状态、scope、guidance、因果截止时间、schema/reward、mode 和词表规则下分别检索两轨。按**决策点原子选择一条轨**，再在该轨内用同一目标字段估计 V 与全部 Q，并复用现有保守替换门；不得比较两条轨的优势数值，也不得用一轨的 V 减另一轨的 Q。

| 规则优先级 | 场景条件 | 仲裁结论 | 选定轨 | gateReason / 审计标识 |
| --- | --- | --- | --- | --- |
| **P0: 认证或契约不满足** | 质量记录缺少来源证据、绑定不符、认证检查失败 | 质量轨不参与候选；保留审计，不自动改标 process | `process` 或 `none (prior)` | `quality-untrusted` |
| **P1: 质量证据满足候选门槛** | 质量轨的决策上下文与所需动作级 support/nEff 达到经实验预注册的候选门槛 | 整体选用质量轨，重新执行同轨 Q/V 和保守替换判定 | `task-quality` | `quality-selected` |
| **P2: 质量证据不足** | 状态总 nEff 达标不能替代 challenger/prior 的动作级证据 | 整个决策点回退过程轨；禁止质量轨否决/修剪过程轨动作 | `process` | `quality-insufficient-action-evidence` |
| **P3: 过程轨亦不足或查询失败** | 过程轨无可用证据或检索异常 | 冻结 Prior，不跨轨拼接 | `none (prior)` | `insufficient-evidence` / `retrieval-fallback` |

**原子性保证**：先选轨、后估值、再复用保守门。上述门槛（包括 `minQualitySupport` / `minQualityNEff`）均为待实验参数，不作为已验证默认值。审计记录包含 `preferredTrack`、`activeTrack`、`fallbackReason` 及所选轨的动作证据；默认关闭时只执行基线 process 路径。

---

## 4. Dreamer 独立留出验证（Holdout Contract）

### 4.1 生成前切分（Pre-generation Split）
1. **执行时机**：对输入树池 $\mathcal{T}$ 的切分必须发生在**任何候选策略生成、超参搜索或分布统计之前**。
2. **切分算子**：
   $$\text{Split}(\mathcal{T}, \text{options}) \to \langle \mathcal{T}_{sel}, \mathcal{T}_{hold} \rangle$$
   - 候选生成器 `generatePolicies` 仅能接收 $\mathcal{T}_{sel}$ 作为输入；
   - 严禁向候选生成器传递 $\mathcal{T}$ 或 $\mathcal{T}_{hold}$ 的任何引用或汇总统计。

### 4.2 信息可见性（Information Visibility）
1. **候选筛选期单向盲测**：
   - 所有候选策略 $C_1, \dots, C_m$ 与 Baseline 在 $\mathcal{T}_{sel}$ 上回放评估，计算选择集超体积 $HV_{sel}(C_i)$ 与 $HV_{sel}(Baseline)$；
   - 评选出选择集获胜候选 $C^* = \arg\max_{C_i} HV_{sel}(C_i)$。
2. **留出验证期单点触发**：
   - 当且仅当 $HV_{sel}(C^*) > HV_{sel}(Baseline) + \epsilon$ 时，方可触发留出验证；
   - 留出验证仅在 $\mathcal{T}_{hold}$ 上回放**获胜者 $C^*$ 与 Baseline** 两者（同探针成本上限 ceiling）；
   - 未在选择集获胜的其他候选，**严禁在留出集上回放**（防止多重假设检验导致的留出集过拟合）。
3. **数据流向单向性**：留出集的评估指标 $HV_{hold}(C^*)$ 仅输入到发布门判定中，**严禁反向反馈给生成网格或调整先验**。

### 4.3 分组与时序隔离（Group & Temporal Isolation）
现有的按索引截断（`trees.slice(...)`）极易造成数据污染。必须施加两级硬隔离：
1. **任务组隔离（Group Isolation）**：
   - 树对象按当前冻结契约提取分组键：`groupKey = tree.taskId ?? tree.sessionId ?? tree.id`。`DiscoveryTreeSnapshot` 没有 `testSetId`，不得穿透非契约 metadata 假装存在；验证回执中的 `testSetId` 与树分组是不同层次，映射关系须由宿主显式提供。
   - 同一 `groupKey` 下的所有树必须完整归属于 $\mathcal{T}_{sel}$ 或完整归属于 $\mathcal{T}_{hold}$，严禁同一任务的子树跨两集合分割。
2. **时序隔离（Temporal Ordering）**：
   - 切分必须严格基于时间戳：$\max_{t \in \mathcal{T}_{sel}} t.createdAt \le \min_{t \in \mathcal{T}_{hold}} t.createdAt$；
   - 严禁将未来的轨迹放入选择集去拟合过去，严禁随机无序 shuffle 打乱时序。长任务组的时间窗可能重叠，不能假定“取最新 N 组”自然满足该式；须搜索满足整组隔离与时序可容许性的切分，找不到则 fail-closed。

### 4.4 样本不足（insufficient-evidence）判定真值表
针对样本容量过小导致的虚假泛化，建立 fail-closed 的判定规范：

| 校验项 | 最低阈值要求 | 未达标判定结果 | 行为及发布影响 |
| --- | --- | --- | --- |
| **选择集样本量** | $|\mathcal{T}_{sel}| \ge N_{sel}^{min}$（建议值 2） | `insufficient-selection-trees` | 终止 Dream，不产生有效候选，禁止发布 |
| **留出集样本量** | $|\mathcal{T}_{hold}| \ge N_{hold}^{min}$（建议值 1） | `insufficient-holdout-trees` | 降级为 `validatedOnHoldout: undefined`，触发 G3 `holdout-missing` 拒绝 |
| **留出集分组数** | 留出集独立 `groupKey` 数 $\ge G_{hold}^{min}$（建议值 1） | `insufficient-holdout-groups` | 判定为证据不足，禁止发布 |
| **分组时序可容许性** | 存在整组切分且 $\max(\mathcal{T}_{sel}) \le \min(\mathcal{T}_{hold})$ | `insufficient-temporal-isolation` | 无可行切分则不生成/不发布，不得改用尾部近似切分 |
| **泛化超体积增量** | $HV_{hold}(C^*) > HV_{hold}(Baseline) + \epsilon_{hold}$ | 未显著跑赢 Baseline | `validatedOnHoldout: false`，G3 判定为 `held-out-underperformed` 拒绝 |

### 4.5 Dreamer 发布门与 idle 回退彻底收口
1. **三道闸全闭（G1/G2/G3）**：
   - G1 授权：`publishAuthorized === true`（生产 profile 恒 deny，恒 false）；
   - G2 真实边界：`applyPolicy !== undefined` 且 `publishAuthorized` 校验通过；
   - G3 留出验证：必须显式 `validatedOnHoldout === true`。
2. **彻底移除 idle 回退（PR-4B 承诺）**：
   - 确认 captain 裁定：`src/index.ts:2805` 保留的 `deps.dreamer.replay` 回退分支将在 PR-4B 中彻底删除，杜绝绕过 orchestrator 触发未审计重放的隐患。

---

## 5. 版本兼容性、数据迁移与失败模式分析

### 5.1 数据模型与 Schema 兼容
1. **经验存储契约**：
   - `EXPERIENCE_SCHEMA_VERSION` 保持向前兼容；
   - 持久化记录扩展字段遵循 ADR 0003 §4.2：通过 `rewardSources` 数值化标记（`verificationVerdict`, `verificationTrusted`, `verificationAuditOnly`, `outcomeEligible`）持久化，不破坏已有 JSONL 读取解析。
2. **双轨检索向下兼容**：
   - 查询接口：`experience-store.ts` 之 `ExperienceQuery` 字段 `learningTrack?: LearningTrack` 保持可选；
   - 未声明轨的旧记录：在 `learningTrack === 'process'` 查询时视为命中（兼容旧历史），但在 `learningTrack === 'task-quality'` 查询时一律排除（严格 fail-closed，不凭空提升）。

### 5.2 失败模式与防御策略矩阵（Failure Matrix）

| 失败模式 | 诱发场景 | 行为与防御策略 | 结构化输出/原因码 |
| --- | --- | --- | --- |
| **FM-1: 质量轨完全无数据** | 冷启动、无宿主 runner 或所有任务均未通过验证 | 纯净降级：双轨检索中质量轨返回空数组，原子选轨自动退化为纯过程轨消费，逻辑等价于基线 | `trackSelected: 'process'` / `gateReason: 'quality-empty'` |
| **FM-2: 质量轨薄证据冲击** | 质量轨仅有 1 条可信样本，但置信度低于门限（$n_{eff}^{qual} < n_{min}$） | 生产通用保守门生效：`conservativeAdvantage` 将优势收缩为 0，拒绝替换 Prior | `gateReason: 'min-support'` |
| **FM-3: 回执与交付物指纹错位** | 工作区文件被篡改或并发写入导致 SHA-256 不匹配 | Attach 侧立即拦截，拒绝生成 `task-quality` 记录，转入审计分叉 | `reasonCode: 'digest-mismatch'` |
| **FM-4: 跨任务上下文错绑** | 宿主混淆了不同任务或环境的评测回执 | 六元组比对拦截，禁止进入质量轨 | `reasonCode: 'binding-mismatch'` |
| **FM-5: 留出集过小或单一样本** | 任务总树数 < 2 或未配置 `holdoutTreeCount` | Dreamer 判定为留出缺失，Fail-closed 拒绝发布 | `publication.reason: 'holdout-missing'` |
| **FM-6: 进程崩溃重启恢复** | 包含未完成事务或易失性回执的节点重启 | 内存注册表清空，历史记录按结构化持久态安全加载，不发生重标升轨 | `audit-only` 加载 |

---

## 6. 并行实施与合并纪律（Integration Discipline）

为保证 t4/t6 (C3) 与 t5 (C2b) 在并行开发中互不踩踏，制定以下合并与文件所有权纪律：

```
                    ┌─────────────────────────┐
                    │  冻结基线 (84a3d82)      │
                    └────────────┬────────────┘
                                 │
                 ┌───────────────┴───────────────┐
                 ▼                               ▼
       【t5 / PR-2: 质量消费】         【t6 / PR-3A: 成本计量】
       - decision-kernel.ts            - src/ledger/**
       - jitrl/index.ts                - src/dsh-bridge/model.ts
       - jit-active-policy.ts          - (shared) src/index.ts [Seam B]
       - offline-dreamer.ts            - (shared) orchestrator.ts [Seam B]
       - (放宽) experience-store.ts     
       - (shared) src/index.ts [Seam A]
       - (shared) orchestrator.ts [Seam A]
                 │                               │
                 └───────────────┬───────────────┘
                                 ▼
                    ┌─────────────────────────┐
                    │ 串行 Rebase 验证集成     │
                    │ (七门禁 exit 0 保证)    │
                    └─────────────────────────┘
```

### 6.1 范围与权限放宽边界
1. **t5 权限放宽**：根据 Captain 裁定，放宽 t5 对 `src/jitrl/experience-store.ts` 的修改权限，但仅限于支持双轨检索与 track 分区辅助查询的**最小必要修改**，严禁改动存储层的其它已有逻辑。
2. **t6 权限放宽**：放宽 t6 对 `src/dsh-bridge/model.ts` 的修改权限，用于用量旁路与真实取消映射。
3. **严格禁止触碰的冻结面**：
   - `src/types/contracts.ts`（无加宽，继续冻结）
   - `src/jitrl/step-evaluator.ts`（继续冻结）
   - `src/jitrl/reward-contract.ts`（继续冻结）
   - `src/jitrl/backfill.ts`（继续冻结）
   - ADR 0001 / ADR 0002 / ADR 0003 正文（继续冻结，指纹仅认原始 blob 字节）

### 6.2 共享文件切分与合并接缝（Seams）
对两个共享集成文件划分物理隔离区块：
- **`src/index.ts`**：
  - **Seam A (t5 独占)**：`createJitActivePolicy`、`createOfflineDreamer`、`createJitDecisionKernel` 的装配参数。
  - **Seam B (t6 独占)**：`LedgerReservationManager` 实例化、`modelBridge` 计费适配器注入。
  - 严禁 t5 修改 Seam B，严禁 t6 修改 Seam A。
- **`src/orchestrator.ts`**：
  - **Seam A (t5 独占)**：`executeStep` 中的双轨记录分叉与通用保守门复用调用点（`:2950-2985`）。
  - **Seam B (t6 独占)**：预算预留（`reserve`）、结算（`settle`）与上下文透传。
- **合并纪律**：PR-2 与 PR-3A 提交时必须保持干净的单功能提交；若发生合并冲突，后完成者必须基于先完成者的提交进行 rebase，并重新全量运行七条门禁，确保 100% 通过。

---

## 7. 验收标准与验证矩阵（Verification Matrix）

后续 PR 实施完成后，必须满足以下硬性验收条件：

| 序号 | 验证维度 | 验证方法与探针设计 | 预期通过结论 |
| --- | --- | --- | --- |
| **V1** | **默认关闭等价性** | 在 `enableQualityTrackConsumption: false` 默认配置下，运行七门禁全量用例 | 测试 86 files / 1666 tests 全绿，行为与基线逐字节一致 |
| **V2** | **双轨独立检索** | 构造包含 10 条 process 记录与 1 条 task-quality 记录的状态池，分别发起两轨查询 | Process 查询准确返回 10 条过程记录；Quality 查询准确返回 1 条质量记录；无混合串扰 |
| **V3** | **通用保守门复用** | 构造 $n_{eff}^{qual} < n_{min}$ 的质量候选，断言其进入 `conservativeAdvantage` 与 `decideReplacement` | 优势被收缩为 0，拒绝替换 Prior，输出 `gateReason: 'min-support'`，未调用任何新建门 |
| **V4** | **质量正向替换** | 显式开启质量消费，注入 $A_{qual} > 0$ 且 $n_{eff}^{qual} \ge n_{min}$ 的可信记录 | 成功采纳质量轨推荐，完成原子选轨 |
| **V5** | **禁止跨轨否决与安全回退** | 质量轨动作级证据不足，但过程轨推荐候选 $a_1$ 具备充分过程证据 | 决策点整体选用过程轨，禁止质量轨跨轨修剪/否决过程动作；输出 `quality-insufficient-action-evidence` 并执行过程替换 |
| **V6** | **Dreamer 生成前切分** | 校验 `replay()` 内部执行序列，断言候选生成函数在切分之后被调用，且仅接收到 $\mathcal{T}_{sel}$ | 留出集 $\mathcal{T}_{hold}$ 在生成期完全不可见 |
| **V7** | **Holdout 组时序隔离** | 输入同一 `taskId` 的多个子树，验证切分结果 | 相同 `taskId` 的子树完全分布在同一集合内，且 $\mathcal{T}_{sel}$ 时间戳严格早于 $\mathcal{T}_{hold}$ |
| **V8** | **薄证据拒绝发布** | 构造样本量不足的留出集进行 Dream 回放 | 输出 `holdout-missing` 或 `insufficient-evidence`，发布受体调用次数恒为 0 |
| **V9** | **idle 回退消除** | 检查 `src/index.ts` 中的 `agent/status -> idle` 逻辑 | 确认 `deps.dreamer.replay` 直连分支已被彻底移除，无任何绕过 orchestrator 路径 |

---

## 8. 附录：核心接口与类型契约草案（TypeScript 签名）

```ts
/**
 * 双轨检索与选轨配置选项
 */
export interface DualTrackConsumptionOptions {
  /** 是否开启可信质量轨消费，生产环境必须默认 false */
  readonly enableQualityTrackConsumption?: boolean;
  /** 质量轨最小有效样本量门槛，默认复用生产保守门 DEFAULT_MIN_EFFECTIVE_SAMPLES */
  readonly minQualityEffectiveSamples?: number;
  /** 质量轨检索数量，默认 8 */
  readonly qualityK?: number;
  /** 过程轨检索数量，默认 16 */
  readonly processK?: number;
}

/**
 * 原子选轨裁决结果
 */
export interface AtomicTrackSelectionVerdict<TAction> {
  /** 最终选定的动作 */
  readonly selectedAction: TAction;
  /** 获胜的轨道来源 */
  readonly winningTrack: 'task-quality' | 'process' | 'prior-default';
  /** 裁决判定原因码 */
  readonly selectionReason:
    | 'quality-selected'
    | 'quality-insufficient-action-evidence'
    | 'quality-untrusted'
    | 'process-evidenced-replacement'
    | 'executed-exploration'
    | 'min-support'
    | 'fallback-default';
  /** 过程轨估计快照（供审计） */
  readonly processReport?: unknown;
  /** 质量轨估计快照（供审计） */
  readonly qualityReport?: unknown;
}

/**
 * Dreamer 生成前切分输入与输出
 */
export interface DreamerHoldoutSplit<TTree> {
  /** 供候选策略生成与初选的树集合 */
  readonly selectionTrees: readonly TTree[];
  /** 供最终泛化验证的留出树集合 */
  readonly holdoutTrees: readonly TTree[];
  /** 切分是否满足最低统计容量 */
  readonly hasSufficientEvidence: boolean;
  /** 样本容量诊断详情 */
  readonly splitDiagnostics: {
    readonly totalTrees: number;
    readonly selectionCount: number;
    readonly holdoutCount: number;
    readonly groupCount: number;
  };
}
```
