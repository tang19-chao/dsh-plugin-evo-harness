# PR5（R5）共同内核复评收口报告 — Gate 3 第 2 轮（P6.1 复评）

| 字段 | 详情 |
| :--- | :--- |
| **被评主题** | PR5 / R5：在线与 replay 共用纯决策内核、EffectivePolicyConfig 版本化与 M3 口径收口 |
| **评审任务** | t5（attempt `85179c04-a5bc-4bf5-bd2e-a06d6780809f`） |
| **评审人员** | kernel-auditor (engineer) |
| **Reviewed SHA** | `7bce33ee9d102a6a05a35f080f606a8fd388e114`（HEAD 基线 `7bce33e`） |
| **评审结论** | **PASS**（旧 PR5 第 1 轮 High 缺陷已闭环，9 项验收标准全部通过） |
| **前序报告** | `docs/reports/p6-review-round1-pr5.md`（结论为 needs_revision，提出 F1 High 缺陷） |

---

## 1. 复评背景与旧缺陷闭环核查（F1 High Formal Resolution）

### 1.1 旧 PR5 轮次第 1 轮发现回顾
在第 1 轮评审（`docs/reports/p6-review-round1-pr5.md`）中，评审人给出了 `needs_revision` 结论，核心阻塞项为：
> **F1 / high: legacy 与 learning-ineligible 过滤是 opt-in，生产没人 opt-in**。
> `excludeLegacy` 与 `learningEligibleOnly` 在共享过滤器 `decision-kernel.ts` 中存在，但在线 L1、replay 壳及 M3 fresh-policy count 均未传入该开关，导致历史遗留/误归因记录在实时决策中依然生效，M3 漂移口径被污染历史提前灌高饱和。

### 1.2 生产调用点返修核实
在当前提交字节（`7bce33ee9d102a6a05a35f080f606a8fd388e114`）上，对所有生产调用点进行了严格核验：

1. **在线 L1 决策调用点**（`src/jitrl/jit-active-policy.ts:686-702`）：
   ```ts
   const decision = runDecisionKernel({
     level: 'meta',
     state,
     candidates: selectBatchCandidates,
     records: experiences,
     config: policyConfig.level1,
     policyVersion,
     now: now(),
     rng,
     projectNeighbors: true,
     ...learningFacingFilterOptions() // 显式注入 excludeLegacy: true, learningEligibleOnly: true
   });
   ```
   **核实**：已显式 spread `learningFacingFilterOptions()`，诊断信息回显 `diagnostics.filter.excludeLegacy: true` 与 `diagnostics.filter.learningEligibleOnly: true`。

2. **Replay Hook 内核调用点**（`src/jitrl/index.ts:755-780`）：
   ```ts
   const decision = runDecisionKernel({
     level: 'meta',
     state,
     candidates: selectBatchCandidates,
     records: input.experiences,
     config: { beta: input.jit.beta, k: input.jit.k, similarityThreshold: input.jit.similarityThreshold },
     policyVersion: input.policyId,
     now: now(),
     rng: seedRng(options.seed),
     ...learningFacingFilterOptions() // 显式注入
   });
   ```
   **核实**：已显式展开 `learningFacingFilterOptions()`，在 replay 诊断中记录 `filtered N of M` 过滤详情。

3. **M3 Fresh Policy Support 计算点**（`src/jitrl/index.ts:835-850`）：
   ```ts
   const freshCount = freshPolicySupport(input.experiences, {
     level: 'meta',
     bucket: state.bucket,
     policyId: input.policyId,
     k: input.jit.k,
     guidance: input.frontier.guidance,
     ...learningFacingFilterOptions() // 显式注入
   });
   ```
   **核实**：计算 fresh/usable 时，遗留及不可学习样本在分母中被剔除，杜绝了提前饱和（`saturated = fresh >= k`）导致漂移惩罚过早关闭的问题。

4. **L2 Proposal Selector 调用点**（`src/jitrl/index.ts:795-815` / `createStoreOptimizer`）：
   ```ts
   const neighbors = await options.store.query({
     level,
     state,
     k: options.config.k,
     similarityThreshold: options.config.similarityThreshold,
     ...(decideOptions.guidanceFilter === undefined ? {} : { guidanceFilter: decideOptions.guidanceFilter }),
     ...learningFacingFilterOptions() // 显式注入到 store.query
   });
   ```
   **核实**：L2 提议优化器在向 store 查询近邻时，完整携带 `excludeLegacy: true` 与 `learningEligibleOnly: true`。

**结论**：F1 High 缺陷已在所有生产调用点完整接线并生效，状态正式标记为 **RESOLVED**。

---

## 2. 契约验收逐项核查（Acceptance Criteria Verification）

### 验收 1：复评绑定当前 SHA 与无预设立场
- **Reviewed SHA**：`7bce33ee9d102a6a05a35f080f606a8fd388e114`。
- **核查过程**：直接审查当前工作树与 git log，不照搬旧轮次报告。实测证明 `learningFacingFilterOptions()` 已成为全链学习消费者的统一基准，旧轮次中“生产未过滤”的问题已被真实修复代码替代。

### 验收 2：在线 L1、L2、replay、M3 fresh count 全链排除反证用例
反证用例全部落地于接线层与端到端真实入口（`tests/unit/jitrl/learning-filter-wiring.test.ts`），拒绝单纯的单元函数自测：
- **在线 L1**（`it('keeps only the clean records and reports the strict counts')` & `it('does not let a legacy or cancelled high-return record set Q')`）：
  - 构造 4 条样本（2 条 clean，1 条 legacy 无 schemaVersion 且 return=9，1 条 ineligible 且 return=9）。
  - 执行 `createJitActivePolicy().selectBatch()`。
  - 断言 `diagnostics.neighborCount === 2`（非 4），`diagnostics.stateValue < 1`（排除 return=9 污染），严格断言 `diagnostics.filter.kept === 2`。
- **在线 L2**（`it('actually excludes legacy and ineligible records from L2 decision when connected to a real memory store')`）：
  - 构造包含 `clean-good` (return=2), `clean-bad` (return=-5), `legacy-bad-inflator` (return=99), `ineligible-bad-inflator` (return=99) 的真实 `MemoryExperienceStore`。
  - 调用 `createStoreOptimizer().decide('proposal', state, candidates)`。
  - 断言 `decision.neighborCount === 2`（仅 2 条 clean 入选），`decision.stateValue === -1.5`，`patch:good` 的 Q=2，`patch:bad` 的 Q=-5，并未被 99 虚高膨胀，最终选择 `patch:good`。
- **Replay**（`it('reports the strict neighbour count on the mixed batch')`）：
  - 调用真实 `createJitReplayHook()` 处理混合 batch。
  - 断言 `replayed.diagnostics.neighborCount === 2`，诊断日志输出包含 `filtered 2 of 4`。
- **M3 fresh count**（`it('counts M3 usable/fresh against the strict denominator')` & `it('does not saturate M3 early because of polluted history')`）：
  - 样本含 1 条 clean fresh + 1 条 stale policy + 1 条 legacy fresh + 1 条 cancelled fresh。
  - 验证 `usable 2`（非 4），`fresh 1`（非 3），当设置 `k = 2` 时，`fresh = 1 < 2`，饱和不成立，`drift penalty inactive` 不出现，证明历史漂移降权惩罚持续生效。

### 验收 3：版本不兼容不混合估计
在 `tests/unit/jitrl/learning-filter-wiring.test.ts` 第 5 节新增针对版本隔离的端到端断言：
- **版本组合**：
  1. 当前合法版本（`experienceSchemaVersion: 2`, `rewardVersion: 'r2/verifiable-v1'`, `provenanceVersion: 'p2/per-execution-v1'`）；
  2. 遗留初始无版本记录（`experienceSchemaVersion: undefined`）；
  3. 过期 schema 版本（`experienceSchemaVersion: 1` < 2）；
  4. 回滚/标记副本遗留版本（`rewardVersion: 'legacy'`，`provenanceVersion: 'legacy'`，`learningEligible: false`）。
- **实测结果**：
  - 在线 L1 注入 5 条混合样本，入选估计近邻数为 1（`neighborCount === 1`），所有不兼容版本均被过滤。
  - Replay 注入 4 条混合样本，入选估计近邻数为 1，诊断记录 `filtered 3 of 4`，`usable 1`。
  - 配合 `mirrorVisibleRecords`（`tests/unit/jitrl/experience-store.test.ts`），当存在混合 reward 版本时，显式标记 `mixedRewardVersions: true` 并隔离。

### 验收 4：在线与 Replay 数值对齐与允许差异清单
通过 `tests/unit/jitrl/decision-kernel-parity.test.ts` 35 条平价测试，在线与 replay 在同一决策输入下实现了数值级完全对齐：
- `neighbors` 命中顺序与 ID 集合 100% 一致；
- `weights`（半衰期与相似度衰减权重）对齐精度达到 `1e-12`；
- `stateValue`（V 估计）对齐精度达到 `1e-12`；
- `Q`、`advantage`、`normalizedAdvantage` 在所有标准槽位（`exploit`, `explore_domain`, `explore_invariant`）完全对齐。

**允许差异清单（逐一核查与合理性确认）**：
| 差异维度 | 在线 (Live L1/L2) | 回放 (Replay Hook) | 允许存在的正当理由 |
| :--- | :--- | :--- | :--- |
| **参考时钟 (`clock`)** | 实时调用时的墙上时钟 `now()` | 回放输入传入的因果截断时刻 `now()` 或冻结时间戳 | 回放需确保时间因果一致性，不能受回放执行当下的实时时钟影响。 |
| **半衰期衰减计算** | 基于记录入库时刻与实时时钟的绝对差 | 基于记录入库时刻与回放模拟时钟的差 | 算法公式 $e^{-\frac{\Delta t \ln 2}{T_{1/2}}}$ 完全一致，输入时间基准差异属因果回放必要设计。 |
| **指导模式 (`guidance`)** | 可继承外层上下文的 `guidanceFilter` | 前端状态传入指定 `guidance`；不变性槽位均强制 `guidance_free` | 隔离逻辑一致，输入源头依调用链路形态不同。 |
| **恢复槽位权重 (`recover`)** | 结构化硬上限拦截（`maxRecoverySlots: 1`，L1 离散截断） | 保持连续先验分布份额（`slotWeights.recover`） | 恢复动作属于安全结构垫，L1 必须保证离散执行安全，回放保留先验供整体对齐评估。 |
| **动作空间输出形式** | 离散整数槽位分配（按概率采样离散动作批次） | 连续归一化权重向量（Softmax/Logits 投影连续概率） | 在线需调度具体的并发探针树执行，回放评估策略分布的期望偏置。 |

### 验收 5：Dream 搜索维度边界与状态面显式标记
- **生效维度**：`POLICY_SEARCH_DIMENSIONS = ['beta', 'k', 'similarityThreshold']`。
- **忽略维度**：`POLICY_IGNORED_DIMENSIONS` 明确记录：
  - `lambda`：逐动作 Bernoulli 探索抽取，扰动将使候选排名完全受随机数种子主导，当前未实施跨种子均值化前禁止扰动；
  - `alpha`：提议选择器中的贪婪探索抽取，同受随机数种子支配；
  - `gamma`：历史经验的持久化回报 $G_t$ 已按固化 $\gamma$ 折现计算，在无需完整轨迹重算前提下无法动态重折现。
- **状态面**：`src/dream-rsi/offline-dreamer.ts` 的 `JitPerturbationGrid` 与 `EffectivePolicyConfig` 诊断对象将上述三个维度显式暴露为 `ignoredDimensions`，配置传入 `candidateJitLambdas` 时虽做向后兼容解析，但绝不驱动候选生成，状态面不会显示为“已生效”。

### 验收 6：L3 Host-Tool 生产者与过滤契约核查（遵循 ADR 0001 D1 严格默认）
- **L3 生产者**（`src/jitrl/host-tool-experience.ts`）：
  - 遵循 ADR 0001（D1 严格默认）：匿名或不可证明的宿主调用不再向可学习桶写入 `unknown` 会话样本，而是记录无载荷计数器 `scope_unknown_skipped`；只有经受信注册表可信登记的会话/分支才生产经验记录。
  - 受信产出记录具有明确级别标记 `level: 'host_tool'`。
  - 采用无折扣单步回报标尺 $G_t = r_t$（$\gamma^0$），归因于受信 `sessionId`/`branchId`/`actionKey`。
  - 生产时未携带 `experienceSchemaVersion` 字段。
- **L3 消费者**（`src/jitrl/host-advisor.ts`）：
  - 查询 store 时限定 `level: 'host_tool'`。
  - 显式**不传递** `excludeLegacy: true`，因此不会因缺少 `experienceSchemaVersion` 导致检索为空或永久 noop。
  - 同时，由于底层存储索引按照 `(level, bucket)` 严格隔离，缺少版本字段的 L3 记录不会泄漏进入 L1/L2 学习邻域（L1/L2 强制要求 `level: 'meta'` 或 `'proposal'` 且 `excludeLegacy: true`）。
- **核查结论**：契约定义清晰，L3 既不发生永久 noop，也绝不破坏 L1/L2 历史记录的严格版本隔离。符合 ADR 0001 规范。

### 验收 7：重启后 JSONL / Backfill / 镜像聚合兼容口径一致性
- **JSONL 存储启动**（`src/jitrl/stores/jsonl.store.ts`）：
  - 重启时重新加载磁盘记录（`load()`），逐行解析后由 `normalizeExperienceRecords` 载入内存索引。
  - 磁盘上的遗留数据被原样保留，并不在读取时物理改写或破坏。
- **回放回填 (`backfill.ts`)**：
  - `migrateExperienceRecords` 在迁移时生成带有 `rewardVersion: 'legacy'` 与 `learningEligible: false` 的审计副本写入 audit sink，源数据不被破坏性覆写。
- **镜像聚合 (`mirrorVisibleRecords`)**：
  - 统一调用 `partitionByVersion()`，输出 `learning`、`legacy`、`ineligible` 三分离结果。
  - 严格不把“运行时查询已加过滤”等同于“磁盘全部历史数据已被迁移”，保证了冷启动、回填与实时镜像视图口径完全一致。

### 验收 8：评审结论与落盘
- 本复评报告独立落盘于 `docs/reports/p61-review-round2-pr5.md`，完整保留旧报告 `docs/reports/p6-review-round1-pr5.md`，形成完整的质量闭环轨迹。
- 综合结论判定：**PASS**。

### 验收 9：类型检查与自动化测试全绿
- **类型检查**：执行 `pnpm run typecheck`，结果为 exit code 0，零类型错误。
- **单元测试验证**：`tests/unit/jitrl/` 包含 20 个测试套件，共计 601 条用例（含新增的端到端接线反证用例与版本非混合测试），全部通过。
- **平价与接线重点测试**：
  - `tests/unit/jitrl/learning-filter-wiring.test.ts`：14 条用例全过；
  - `tests/unit/jitrl/decision-kernel-parity.test.ts`：35 条用例全过。

---

## 3. 验收结果矩阵（Acceptance Summary Table）

| 验收条款 | 判定 | 关键证明材料 |
| :--- | :---: | :--- |
| **1. 绑定实际提交 SHA 进行复评** | **PASS** | 锁定 SHA `7bce33ee9d102a6a05a35f080f606a8fd388e114`，核实全部 4 个生产调用点代码。 |
| **2. 在线 L1/L2/replay/M3 均排除 legacy/ineligible 反证用例** | **PASS** | `learning-filter-wiring.test.ts` 构造 4 类混合样本，走真实 `selectBatch`、`optimizer.decide`、`createJitReplayHook` 与 `freshPolicySupport`，断言被排除。 |
| **3. 初始经验版本/rewardVersion/provenanceVersion 不兼容时不混合估计** | **PASS** | `learning-filter-wiring.test.ts` 第 5 节用例证明 schemaVersion < 2、legacy 标记样本绝不参与 Q/V 均值估计。 |
| **4. 相同可比输入下 neighbors/weights/Q/V/logits 对齐与差异列明** | **PASS** | `decision-kernel-parity.test.ts` 35 项测试全过（精度 `1e-12`），列明时钟、半衰期、离散采样等 5 大正当差异。 |
| **5. 仅实际支持维度参与 Dream 搜索，忽略维度状态面显式标明** | **PASS** | `POLICY_SEARCH_DIMENSIONS` 限定 3 维度，`POLICY_IGNORED_DIMENSIONS` 标明 lambda/alpha/gamma，状态诊断显式回显。 |
| **6. L3 过滤契约与独立奖励模型核查** | **PASS** | L3 独立使用 `level: 'host_tool'`，不传 `excludeLegacy` 避免 noop，同时不与 L1/L2 跨层混合；单步即时回报模型。 |
| **7. 重启后 JSONL/backfill/镜像聚合同一口径** | **PASS** | 重启加载保真原盘数据，backfill 与 mirror 统一使用 `partitionByVersion`，不混淆运行时过滤与磁盘迁移。 |
| **8. 评审结论落盘与报告规范** | **PASS** | 形成 `docs/reports/p61-review-round2-pr5.md`，verdict 明确为 PASS，旧 High 标记 resolved。 |
| **9. pnpm run typecheck 与测试套件运行** | **PASS** | `pnpm run typecheck` exit 0；`tests/unit/jitrl/` 20 文件 601 测试全部绿灯。 |

---

## 4. 复评签收结论

PR5 共同决策内核（R5）的设计目标已在基线代码和当前接线中彻底达成。在线决策和离线回放基于同一纯数学内核执行，学习面向消费者的安全过滤策略（`learningFacingFilterOptions`）在生产全路径上生效闭环，版本隔离与平价性具备完整且健壮的回归反证测试保护。

**最终评审判定：PASS**
