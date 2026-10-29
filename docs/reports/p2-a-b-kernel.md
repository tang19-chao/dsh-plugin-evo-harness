# P2-A + P2-B：V3 可判别任务设计与生产语义对齐重放

> 任务：t2（p2ab）/ attempt `5b0895a7-6feb-4f75-9683-e5f0568e6aa7`
> 角色：p2-kernel（P2 评测内核）
> 基线：`feb8465ded73ca48a770054c587990b93f54e21e`（2026-10-29）
> 日期：2026-10-29
> 写入范围：`src/jitrl/decision-kernel.ts`、`src/jitrl/index.ts`、`scripts/eval/pr4a-v3-design.mjs`（新建）、`scripts/eval/pr4a-v3-design.d.mts`（新建，新模块的配套声明）、`scripts/eval/pr4a-v3-replay.mjs`（新建）、`tests/unit/jitrl/*`（新增 2 个测试文件）。**未改** `scripts/eval/jitrl-eval-lib.ts` 与 `scripts/eval/pr4a-five-arm-lib.ts`（队长裁决：V2 引擎字节保持不变，见 §5/§7）。

---

## 0. 结论摘要（先给判断）

| 项 | 结论 | 关键证据 |
| --- | --- | --- |
| P2-A 可判别性 | **达成**：10/12 任务 `required ⊄ prefs[:3]`；oracle 由任务表穷举计算且不全为 1（6/12 任务 oracle < 1，0.50~0.67）；prior 均值 0.569 / oracle 均值 0.806 / 平均 headroom 0.236 | `node scripts/eval/pr4a-v3-design.mjs` exit 0（§4 E1） |
| P2-A 支持矩阵 | **达成**：36 决策点 × 14 action class，rank = 9；每关键决策点 distinct action = 3（min=3>1），L1 slot kind = 4>1；**rank-1 反例先行验证** | 同上 + `v3-task-discriminability.test.ts`（7 tests） |
| 基线设计目标带 | 0.569 ∈ [0.30, 0.70]，作为**设计目标**报告（非调参通行证，§2.4） | 同上 |
| P2-B 生产过滤存活数断言 | **达成**：内核新增 `experienceSurvival / learningFacingSurvival / assertLearningFacingSurvival / LearningFacingSurvivalError`；全过滤时抛错，错误信息含分母、主因、分项计数、可读样本、补救契约 | `production-replay-survival.test.ts`（9 tests，含 hook 抛错与默认不抛） |
| P2-B 对齐重放 | **达成**：V3 重放 9 项断言全部通过（生产过滤对象逐字段一致、存活分母、中止、rank>1、prior↔executed 非退化、分级验收、V2 缺口影子对照、零真实调用、digest） | `node scripts/eval/pr4a-v3-replay.mjs --fixture=r4-production` exit 0（§4 E2） |
| P2-B 全过滤显式失败 | **达成**：r2/verifiable-v1 全库负对照 → 36/36 决策中止，错误码 `learning_facing_survival_abort`，主因 `learning_ineligible` | `--fixture=r2-legacy` exit 0（含 "ABORTED (expected)"，§4 E3） |
| 既有五臂结果是否受影响 | **未受影响**（同一确定性夹具上规范化输出 SHA-256 完全相同；历史负结果 A1..A6 PASS；全 unit 2057 绿）——但**其结论不得读作生产策略效果**（影子对照：V2 调用形状 admitted 7992 条 vs 生产过滤 1998 条；执行覆盖 0.417 vs 0.722） | §5、§4 E4/E5 |
| 未执行（需授权） | 改 V2 引擎默认语义（会使历史 -0.250 帧与 e2e klMean 断言移动）、真实宿主 smoke、真实付费模型/五臂重跑、holdout 结论 | §7 |

一句话：**P2 从"不可判别"推进到"可判别"**——V3 表在结构上给学习留出了空间，重放路径与生产过滤/奖励标尺同源，且"没有可学证据"会显式中止而不是输出一个 prior 形状的"效果"。

---

## 1. 定位：V2 重放与生产语义的三处不一致（P2-B 的起点）

| # | 位置 | 事实 | 后果 |
| --- | --- | --- | --- |
| I1 | `scripts/eval/jitrl-eval-lib.ts:2856`（fair L1）、`:2936`（fair L2）、`scripts/eval/pr4a-five-arm-lib.ts:1057`（PR-4A L2） | `runDecisionKernel(...)` **没有** spread `learningFacingFilterOptions()` | 重放邻居集包含 legacy / learning_ineligible 记录；生产两处（`src/jitrl/jit-active-policy.ts:740` 调用 + `:767` spread；`src/jitrl/index.ts:1072` 调用 + `:1104` spread）不包含。**离线重放了一个在线永远不会执行的政策** |
| I2 | `scripts/eval/jitrl-eval-lib.ts:2557` / `:2665`（`FAIR_R2_SCALE_VERSION`）、`scripts/eval/pr4a-five-arm-lib.ts:1329` | 写回记录 `rewardVersion: 'r2/verifiable-v1'` | 生产谓词 `isLearningEligibleRecord` 要求**精确等于** `CURRENT_REWARD_VERSION = 'r4/verifier-first-v1'`（或认证兼容 id），r2 一律 `learning_ineligible`。一旦在 V2 引擎上启用生产过滤，全部邻居被过滤、KL 恒 0 → 只能中止，不能输出效果 |
| I3 | `scripts/eval/pr4a-five-arm-lib.ts:1526`（`oracleCoverage: 1`）；`scripts/eval/jitrl-eval-lib.ts:321`（计算函数但恒为 1） | oracle 硬编码/等价硬编码 | V2 任务表 12/12 个任务 `required ⊆ prefs[:3]`，而 V2 只有 3 个可提议 surface，所以 `prefs[:3]` 就是全部词表 → 每个任务 oracle ≡ 1，prior 也会在 3 轮内达到 1。**"基线到达天花板"是表的结构性质，不是被测量的政策性质**，臂间差异无处出现 |

> 另有 `scripts/eval/guarded-regression.mjs:294` 的 r2 用例：属既有门禁数据，按队长裁决同样不改（不在本任务写入范围）。

**为什么不直接改 V2 引擎**：I2 的对齐会使历史公平臂帧移动，`node scripts/eval/negative-result-diag.mjs --assert` 的 A1（`|meanDelta + 0.250| < 0.05`）与 `tests/e2e/jitrl-ablation.test.ts` 的 klMean 断言会变红，等于改写历史负结果 —— 属清单"永久禁止"项。故对齐交付在新路径（V3），V2 引擎以"已知缺口棘轮测试"钉住（§3.6），解除条件写死。

---

## 2. P2-A：V3 任务与调度设计

### 2.1 任务表（12 任务 / 5 个真实 harness surface / 4 类）

surface 词表扩到 5 个**真实** `HARNESS_COMPONENT_KEYS`：`guardrails, tool_guidance, skills, memory, scripts`；另有 2 个真实但夹具家族不可编辑的 surface（`subagents, plugins`）作为"能力盲区"，只允许出现在 `required/blind`，不允许出现在 `prefs`。

| 任务 | 类别 | required | required ⊆ prefs[:3] | oracle | prior | headroom | 动作数/轮 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| v3-ci-01 | prior-saturates | guardrails+skills | true | 1.00 | 1.00 | 0.00 | 3/3/3 |
| v3-mig-01 | prior-saturates | tool_guidance | true | 1.00 | 1.00 | 0.00 | 3/3/3 |
| v3-ci-02 | preference-blind | guardrails+memory | **false** | 1.00 | 0.50 | 0.50 | 3/3/3 |
| v3-ci-03 | preference-blind | scripts+tool_guidance | **false** | 1.00 | 0.50 | 0.50 | 3/3/3 |
| v3-test-01 | preference-blind | memory+skills | **false** | 1.00 | 0.50 | 0.50 | 3/3/3 |
| v3-test-02 | preference-blind | guardrails+scripts+skills | **false** | 1.00 | 0.67 | 0.33 | 3/3/3 |
| v3-mig-02 | preference-blind | memory+scripts+tool_guidance | **false** | 0.67 | 0.33 | 0.33 | 3/3/3 |
| v3-rel-01 | family-blind | guardrails+subagents | **false** | 0.50 | 0.50 | 0.00 | 3/3/3 |
| v3-rel-02 | family-blind | plugins+skills | **false** | 0.50 | 0.50 | 0.00 | 3/3/3 |
| v3-mig-03 | family-blind | skills+subagents+tool_guidance | **false** | 0.67 | 0.67 | 0.00 | 3/3/3 |
| v3-rel-03 | mixed | guardrails+plugins+scripts | **false** | 0.67 | 0.33 | 0.33 | 3/3/3 |
| v3-test-03 | mixed | memory+skills+subagents | **false** | 0.67 | 0.33 | 0.33 | 3/3/3 |

设计意图（每类都必须在场）：
- **prior-saturates（2）**：天花板可达且 prior 已达标 —— 保留"指标能饱和"的对照，说明 V3 不是"把所有任务都做成不可解"。
- **preference-blind（5）**：required 含 proposer 排在第 4/5 位的 surface。prior 只沿自己的偏好加深，**结构上到不了**；只有"根据经验偏离先验"才能到达。
- **family-blind（3）**：required 含夹具家族永不编辑的真实 surface（`subagents/plugins`）→ oracle 被**测量为** < 1，天花板逐任务不同（"同时约束 baseline 与 oracle 的可判别空间"）。
- **mixed（2）**：两者叠加。

池规则（`v3/narrow+pair/fixed-lineage`）：在固定谱系 `prefs[:round]` 下，每个决策点提供 `[prefs[r]]`、`[prefs[r+1]]`、`[prefs[r],prefs[r+1]]` 三个候选（置信度 0.70/0.55/0.40，先验取 argmax 置信度）。与 V2 的 `fairFixedPoolParent` 同构：刺激只由 (task, round) 决定，与臂的选择无关。

### 2.2 oracle 必须由任务表计算（不是常量）

`oracleCoverage(task, rounds)` = 对 `rounds` 个决策点、每点 3 个候选的 `3^rounds = 27` 条 lineage 穷举，取 `coverageOf(required, union(choices))` 的最大值；先删除 `blind` surface（家族永不编辑，不能算作覆盖）。`priorCoverage` 同样是表函数：每点取 argmax 置信度候选的并集覆盖率。

验证 oracle **不是**常量、且**对表敏感**（测试里同时给出正反例）：
- 每个任务的 `oracleCoverage` 与测试内**独立重算**（只读 `taskDecisionPoints` 的 candidates）逐任务相等；
- `new Set(oracles).size > 1`，且 ≥2 个任务 oracle < 1；
- 变异：把某单 surface 任务的 required 标为 `blind` → oracle 从 >0 变 0；还原 → 恢复（表变了，天花板必须变）。

> 可复算入口（reviewer 直接跑）：`node scripts/eval/pr4a-v3-design.mjs --oracle-proof` 对每个任务枚举 3^3=27 条 lineage，打印最优选择序列 / 覆盖并集 / 覆盖率，并与发布值逐任务比对（全部 `agrees=true`，exit 0）；`--oracle-proof --json` 给机器可读行。
>
> V2 对照（测试中断言）：12/12 个 V2 任务的 `requiredWithinTop3Prefs === true` 且 `v2OracleCoverage === 1` —— 这正是 `oracleCoverage: 1` 可以硬编码而不被发现的根因。

### 2.3 每个关键决策点多动作 + 支持矩阵秩 > 1（先验证检查器）

- 每个决策点 `distinctActionCount = 3`（按 canonical surface-set 类别计；L1 另有 4 个 production slot kind，`l1SlotKinds.length = 4`）。
- 支持矩阵：行 = 决策点（task×round，36 行），列 = 全表出现过的 action class（14 列），单元格 = 该动作在该点是否可得。**rank = 9 > 1**。
- **反例先行**：`degenerateRankOneFixture()`（3 行同一向量）→ `rankOfMatrix` 返回 1、`isRankDeficient` 为 true；再用"所有池都只含单一动作"的退化任务表 → 矩阵 rank = 1 且 `designGateFindings` 报 `support matrix rank <= 1` 与 `a decision point offers <= 1 distinct action`。**检查器先被反例证明能失败，真实表 rank>1 的断言才有意义。**
- 同一 rank 实现（`rankOfMatrix`）也用于 kernel 支撑矩阵（§3.2）。

### 2.4 基线 30–70% 的口径（设计目标，不是调参通行证）

- prior 均值 **0.569** ∈ [0.30, 0.70]（`baselineBand.inBand = true`）。
- 该数字是**表的函数**：本模块不读任何测量结果、没有时钟/随机/环境输入；"落在带内"是**设计**结果（决定 required/prefs/盲区），不是对任何已测数据反复调参的结果。
- 若未来改表后落在带外，脚本会打印 `OUT OF BAND (design-target miss; requires a new pre-registration, NOT tuning)`，而不是自动调整参数凑带。

### 2.5 冻结信息（与 p2-prereg 的接口）

| 项 | 值 |
| --- | --- |
| version | `v3/tasks-20261029` |
| poolRule / schedule | `v3/narrow+pair/fixed-lineage` / `v3/schedule-20261029` |
| rounds | 3 |
| canonical digest | `sha256:585d030790072ba2fc096d00821e1a2a88bbb0866e91491962ae117fa15a2142` |
| digestScope | `canonicalDesignBytes()` = `canonicalDesignJson()` + 单个 LF，共 **47720 字节** |
| 复核 | `node scripts/eval/pr4a-v3-design.mjs --canonical \| sha256sum`（POSIX shell；**不要用 PowerShell 重定向**，会加 BOM/CRLF） |
| 登记状态 | 已由 p2-prereg 写入 `docs/reports/p2-preregistration-v3.md` §2/§5（F1/G4 = 同一 digest，47720 B） |

> 边界：本报告的 V3 数字一律是**设计期自检 / 契约验证**（`resultStatus: "design-time-self-check-not-a-result"`）。预注册已登记 digest，但 V3 **评测结论**（含 holdout、统计功效、Holm 族）属 P2-C/P2-D，本任务不产出、不引用。
> 注：`pr4a-v3-design.mjs` 在 p2-prereg 快照（36998 B / `ed216d4f…`）之后因 ¥2.2 的 blind 过滤修正与注释调整变为 **37038 B / `6711e8aa…`**；**canonical 内容未变**（digest 仍为 `585d0307…` / 47720 B），冻结不失效（该文件 §8.1 已预留此情形）。

---

## 3. P2-B：对齐重放与生产语义

### 3.1 生产内核新增：存活计数 + 显式中止

`src/jitrl/decision-kernel.ts`（新增导出，**行为纯增量**）：

| 导出 | 语义 |
| --- | --- |
| `ExperienceSurvival` | 一次过滤的完整账本：`records`（分母）、`survivors`、`excluded`、`byReason`（每个 `ExperienceFilterReason`，含 `kept`）、`mainExclusion`（最大排除原因）、`excludeLegacy/learningEligibleOnly`（实际生效的两面旗）、`sample`（最多 3 条 `id:reason` 可读样本） |
| `experienceSurvival(records, options)` | 原始过滤器计数（审计路径用；两旗由调用者给） |
| `learningFacingSurvival(records, scope)` | **生产学习过滤器**计数：内部 spread `learningFacingFilterOptions()`，因此"调用者是否真的 opt-in"可从存活记录本身回答 |
| `LEARNING_FACING_SURVIVAL_ABORT` | 稳定错误码 `learning_facing_survival_abort` |
| `LearningFacingSurvivalError` | 携带 `code/survival/context`；消息含分母、主因、全部分项、补救契约（`rewardVersion=r4/verifier-first-v1`、schema ≥ 2、`learningEligible !== false`）与样本 |
| `assertLearningFacingSurvival(survival, opts)` | 非空快照且存活 < 阈值 → 抛错；**空快照 = 冷启动，不抛**（阈值是存活计数，不是比例） |

`src/jitrl/index.ts`（`createJitReplayHook`）新增两个**默认关闭**的选项（不改变既有"never throws"契约）：

- `requireLearningFacingSurvival`：为 true 时先算生产存活，全过滤 → 抛 `LearningFacingSurvivalError`；该错误在 hook 的 degrade-to-prior catch 中**重新抛出**，不会被降级成 `degraded` 诊断。
- `onLearningSurvival`：每次调用回调存活账本（不抛的调用者也需要展示分母）。
- 门面 `JitRl.createReplayHook({ requireLearningFacingSurvival })` 已透传。

### 3.2 V3 对齐重放（`scripts/eval/pr4a-v3-replay.mjs`）

- **真 kernel、真常量**：经 `build-eval.mjs` 编译并加载 `src/jitrl/index.ts`（`runDecisionKernel / learningFacingFilterOptions / learningFacingSurvival / assertLearningFacingSurvival / CURRENT_REWARD_VERSION / EXPERIENCE_SCHEMA_VERSION` 等）、`src/jitrl/reward-contract.ts`（`scoreUnderRewardContract / REWARD_CONTRACT_WEIGHTS`）、`src/verification/index.ts`（宿主验收 runner + `verifyAndAttach`）。**脚本内不复制任何权重表**；weight 哈希由 `REWARD_CONTRACT_WEIGHTS` 计算并打印（`weightsHash`）。
- **生产过滤逐字段一致**：内核调用 spread `learningFacingFilterOptions()`，断言每个决策的 `filters.excludeLegacy / learningEligibleOnly` 与 `LEARNING_CONSUMER_FILTER` 完全相同（`production-filter-parity`）。
- **记录 = 生产可学习**：`rewardVersion = CURRENT_REWARD_VERSION`（r4/verifier-first-v1）、`experienceSchemaVersion = EXPERIENCE_SCHEMA_VERSION`、`provenanceVersion = CURRENT_PROVENANCE_VERSION`；奖励由 `scoreUnderRewardContract` 生产标尺给出。运行输出实测 `1998/1998` 记录存活（`learning_ineligible=0`）。
- **因果截断**：每个决策点的训练记录在决策**之前**写入、`createdAt < before`；决策后不写回，因此没有决策能读到自己的结果；retrieval 的 bucket 只由 signature/complexity/slot/guidance 决定（round 在 token 里），跨轮记录只有相似度足够才进入。
- **分级宿主验收（主指标）**：宿主 runner 按 **artifact 字节**判定 pass/fail（非空、覆盖全部 required surface 标记、无密钥），@ `verifyAndAttach` 认证后由 `scoreUnderRewardContract` 打分。**可信 pass/fail 是主指标**；部分覆盖率只进 `diagnostics.partialCoverage`，**不进奖励**（断言：同 verdict、不同 partial coverage 的两条轨迹奖励**相等**；pass 严格高于 fail：`partial=-1.0000, zero=-1.0000, full=0.9000`）。
- **支撑矩阵（kernel 实测支撑）**：行 = 36 决策点，列 = 14 action key，单元格 = kernel 的 `adjustments[].support`；`rank = 12 > 1`。

### 3.3 全过滤负对照（明确失败，不降级）

`--fixture=r2-legacy`（整库 `r2/verifiable-v1`）：生产存活 **0/1998**，**36/36 决策中止**，例如：

```text
learning-facing survival abort (v3-aligned-replay): 0 of 3 records survive the production filter;
main exclusion reason: learning_ineligible
[level=0, bucket=0, guidance=0, time=0, timestamp=0, legacy=0, learning_ineligible=3]
- with no learnable evidence the run must abort instead of reporting a policy effect.
  Records must be stamped with the current reward contract (rewardVersion=r4/verifier-first-v1),
  experienceSchemaVersion >= 2 and learningEligible !== false.
  Excluded sample: v3-exp-…-c2-legacy:learning_ineligible, …
```

该模式下 `support-matrix` 与 `prior-vs-executed` 两项断言标注 "not applicable: aborted"（中止的运行不产生效果主张，强制其产出 rank>1 等于要求中止的实验给证据）；但**在 r4 模式下这两项是硬断言**，若意外中止则进程 exit 2。

### 3.4 V2 调用形状的影子对照（缺口量化）

同一 **mixed** 快照（r4 观测 + 3 倍 `r2` 陈旧副本，后者模拟已退役 r2 标尺的排序："有文本就算完成"，部分产物看起来比已验证通过更好）：

| 形状 | admitted 记录 | executed 覆盖 | 说明 |
| --- | --- | --- | --- |
| 生产过滤（对齐） | **1998** | **0.722** | 只用 r4 可学习证据 |
| V2 调用形状（无过滤） | **7992** | **0.417** | 陈旧记录把更好动作压低，选择被拖回/拖离证据 |

方向结论：**V2 调用形状下策略效果会被不可学习证据污染**（覆盖甚至低于 prior 0.569），因此历史五臂的"效果"不能读作生产策略效果；这不是重跑，而是在同一确定性夹具上的对照。

### 3.5 一个结构性发现（对 P2-D 有用）

在 r4 + C2-pre 语义下：一条 **"status=succeeded 但被可信验证判 failed"** 的轨迹是**被证伪的成功声明**，`learningEligible = false`（audit-only）。因此：
- 如果夹具把所有候选都写成 `succeeded`，则只有"通过"的动作产生可学习记录 → 邻居里只有一个动作有支撑 → `q ≡ V`、advantage 恒 0 → **策略在结构上无法学会偏离先验**（P2-D 的"单动作支持时 q≡V"正是此现象）。
- 诚实的失败语义是 `status=failed`（与 PR-4A 的 `buildTrajectory({verified})` 一致）：失败运行是可学习的负证据；被证伪的成功声明不是。V3 重放按此建模，才得到 prior 0.569 → executed 0.722 的非退化差异。
- 结论：**"失败不可学习"和"失败可学习"是两个不同信任问题**，不能在报告里混为一谈；trusted-failure 学习仍是 C2 未完成项（本报告不发明它）。

### 3.6 已知缺口棘轮（只读、结构快照）

`tests/unit/jitrl/production-replay-survival.test.ts` 末尾：
- **生产调用点门禁**：扫描 `src/**/*.ts` 的每个 `runDecisionKernel` **调用**（先剥离注释/字符串，避开 JSDoc 里的同名提及与函数定义），断言每个调用参数都含 `learningFacingFilterOptions`；当前检查 ≥2 个调用点、offenders = []。
- **V2 缺口钉住**：对 `scripts/eval/jitrl-eval-lib.ts`（2 个未过滤调用点 + `FAIR_R2_SCALE_VERSION = 'r2/verifiable-v1'`）与 `scripts/eval/pr4a-five-arm-lib.ts`（1 个未过滤调用点 + `rewardVersion: 'r2/verifiable-v1'` + `oracleCoverage: 1`）做结构断言。测试注释写明：这是**已知缺口**不是"已修复"；**解除条件** = (a) 在新预注册下重跑五臂（历史报告不改写），或 (b) 队长明确授权"历史帧可以移动"；解除时必须同一次改动更新该棘轮。缺口一旦被静默关闭，测试立刻变红，避免变成永久免责牌。

---

## 4. 验收证据（可复算）

| # | 命令 | 退出码 | 关键输出 |
| --- | --- | --- | --- |
| E1 | `node scripts/eval/pr4a-v3-design.mjs` | **0** | `digest: sha256:585d0307…`；`prior mean 0.569 / oracle mean 0.806 / mean headroom 0.236`；`baseline band [0.30,0.70]: IN BAND`；`required outside prefs[:3]: 10/12 (share 0.83)`；`min actions per decision point: 3`；`support matrix: 36 × 14, rank=9`；`rank-1 negative control: rank=1`；`design gate: PASS` |
| E2 | `node scripts/eval/pr4a-v3-replay.mjs --fixture=r4-production` | **0** | `survival 1998 of 1998`；`coverage prior 0.569 -> executed 0.722 (deviations 10/36)`；`primary pass=10 fail=26 refused=0`；`support matrix rank: 12`；9/9 `PASS` |
| E3 | `node scripts/eval/pr4a-v3-replay.mjs --fixture=r2-legacy` | **0**（负对照按预期中止） | `survival 0 of 1998; byReason {learning_ineligible:1998}`；`36 abort(s)`；`ABORTED (expected for the r2-legacy control)`；错误码 `learning_facing_survival_abort` |
| E4 | `pnpm exec tsc --noEmit` | **0** | 无输出（`TSC=0`） |
| E5 | `pnpm exec vitest run tests/unit/jitrl` | **0** | `Test Files 25 passed (25) / Tests 692 passed (692)`（基线 23/676；新增 2 文件 16 测试） |
| E6 | `pnpm exec vitest run tests/unit` | **0** | `Test Files 99 passed (99) / Tests 2057 passed (2057)`（快照时刻 10:36；随后其他并行任务继续新增测试，docs 门运行时为 102 files / 2093 tests——数字随并行任务落地而漂移） |
| E7 | `node scripts/eval/negative-result-diag.mjs --assert` | **0** | `A1..A6 PASS - the historical negative result is intact` |
| E8 | `node scripts/eval/pr4a-smoke.mjs`（改动前后各一次，去掉每行尾部 `\d+ms`） | **0** | `NON_TIMING_DIFF_LINES=0`；规范化 SHA-256 前后同为 `0654A6CB…D423`（VR/cov/rec/track/gate/kept/trusted/rcpt/frozen/ledger/notional 全一致，仅耗时不同） |
| E9 | `node scripts/eval/pr4a-v3-design.mjs --json` 两次 | **0** | `DESIGN_JSON_DETERMINISTIC=True`（稳定键序、LF） |
| E10 | `pnpm run check:encoding` | **0** | `SUCCESS: every tracked blob is LF text or an explicit -text exception`（commit feb8465 的 .gitattributes，333 个 blob） |
| E11 | `pnpm run check:docs` | **1** | 见 §7 计数行条目：R-04 的闭合断言与配置参考 78/78 均通过；只有 README 计数行落后于并行任务的测试新增（团队性遗留，非本任务引入） |
| E12 | `node scripts/eval/pr4a-smoke-invariant.mjs --baseline=work/p2-kernel-smoke-before.txt` | **0** | `current digest = baseline digest = sha256:0654a6cb…d423`；`line differences: 0 (timing removed)`；`PASS: the frozen five-arm frame is unchanged (timing excluded)`。入口 `scripts/eval/pr4a-smoke-invariant.mjs`：子进程跑 `pr4a-smoke.mjs` → 去掉每行尾部 `<n>ms` → 归一化文本 SHA-256；无 `--baseline` 时与脚本内 **pinned digest**（同一 `0654a6cb…`）比对 —— 任何人一条命令即可复核『P2-B 没有移动五臂数字』 |
| E13 | `node scripts/eval/pr4a-v3-design.mjs --oracle-proof` | **0** | 每任务 `lineages=27`，打印 bestChoices / bestSurfaces / coverage，且发布的 `oracleCoverage` 与穷举最大值 **12/12 agrees=true**（含 oracle<1 的任务）→ 证明 oracle 由表穷举得出，不是常量 |
| E14 | `pnpm exec vitest run tests/unit/eval/p2-v3-replay-cli.test.ts` | **0** | `Test Files 1 passed / Tests 2 passed`：①`--out=<tmp>/nested/dir/replay.json` → exit 0、文件为该路径下的合法 JSON，且临时目录树中**没有任何以 `--out=` 开头的文件/目录**；②`--out=`（空值）→ 非零退出、stderr 含 `invalid --out=`、不写任何文件（fail-closed 早于重放工作）。`pr4a-v3-replay.mjs` 相应改为剥离前缀 + 空值报错 + `resolve()` 后写入 |

新增确定性测试的两个文件：
- `tests/unit/jitrl/v3-task-discriminability.test.ts`（7 tests）：词表真实性、required ⊄ prefs[:3] 份额 + V2 恒 1 对照、oracle 独立重算/变异常量/≤1、prior↔oracle 非退化 + 设计带、每决策点多动作（含反例）、支持矩阵 rank>1（含 rank-1 反例）、digest 可复算且随表变化。
- `tests/unit/jitrl/production-replay-survival.test.ts`（9 tests）：存活计数（分母/分项/主因/样本/词表完整性）、其他过滤阶段（level/guidance/time）、生产过滤对象一致、全过滤抛错 vs 冷启动不抛、hook 抛错不被降级、默认契约保留、存活回调、生产调用点门禁、V2 缺口棘轮。

---

## 5. 对既有五臂结果是否受影响的判断（不重跑付费模型）

**判断：数值未受影响；解释力受影响。**

1. **数值**：本任务对 `src/jitrl/decision-kernel.ts` / `src/jitrl/index.ts` 的改动是**纯增量**（新导出 + 默认关闭的选项；钩子在选项关闭时的执行路径不变）。证据 E8/E12：同一确定性夹具的 PR-4A smoke 在改动前后，去掉墙钟耗时后**逐行相同、规范化 SHA-256 相同**（`node scripts/eval/pr4a-smoke-invariant.mjs` 可重算，pinned digest `0654a6cb…`）。E7：历史负结果 A1..A6 仍 PASS。E6：全 unit 2057 绿。
2. **解释力**：V2 的五个臂都在"无生产过滤 + r2 标尺"下运行（I1/I2）。§3.4 的影子对照表明：同一快照上 V2 调用形状 admitted 7992 条、执行覆盖 0.417，而生产过滤 admitted 1998 条、覆盖 0.722。因此历史五臂的"在线 vs 冻结臂差异"**不是生产策略效果的度量**：它测量的是一个生产不会执行的证据集合上的选择。这不改写历史报告中的任何数字/标签/阈值（永久禁令），而是明确其**外推边界**。
3. **重跑需求**：要得到生产语义下的五臂结论，必须在 **P2-C 新预注册**下、以 V3 任务表 + r4 记录 + 生产过滤重跑（真实付费模型调用需单独授权，本任务未执行）；历史帧保持原样并列。

---

## 6. 改动文件清单（仅本任务范围）

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `src/jitrl/decision-kernel.ts` | 修改（纯增量） | +`ExperienceSurvival` / `experienceSurvival` / `learningFacingSurvival` / `LEARNING_FACING_SURVIVAL_ABORT` / `LearningFacingSurvivalError` / `assertLearningFacingSurvival`（约 796–1000 行区段） |
| `src/jitrl/index.ts` | 修改（默认关闭） | 引入存活助手与错误类；`JitReplayHookFactoryOptions.requireLearningFacingSurvival / onLearningSurvival`；hook 内先算存活 → 回调 → 断言；catch 重抛存活错误；门面 `createReplayHook` 透传 |
| `scripts/eval/pr4a-v3-design.mjs` | **新建** | V3 任务表 + oracle/prior 计算 + 支持矩阵 + rank + 秩反例 + 设计门 + canonical bytes/digest + CLI（`--json/--canonical`） |
| `scripts/eval/pr4a-v3-design.d.mts` | **新建** | 新模块的 TS 声明（沿用 `check-encoding-policy.d.mts` 的既有做法，使 strict 测试可导入） |
| `scripts/eval/pr4a-v3-replay.mjs` | **新建** | 生产对齐重放（真 kernel/真权重/真宿主验收 runner）+ 存活断言 + 分级验收 + 影子对照 + 断言 CLI（`--fixture/--json/--out`）；`--out=` 前缀剥离 + 空值 fail-closed（修复曾把 flag 本身当路径、生成字面 `--out=work/` 目录的缺陷，见 §7） |
| `scripts/eval/pr4a-smoke-invariant.mjs` | **新建** | 五臂 smoke 的**可复算不变量**入口（子进程跑既有 smoke → 去耗时 → 归一化 SHA-256 → 与 pinned digest / 捕获基线比对）；只读既有门禁，不改门禁语义 |
| `tests/unit/jitrl/v3-task-discriminability.test.ts` | **新建** | P2-A 7 项确定性断言 |
| `tests/unit/jitrl/production-replay-survival.test.ts` | **新建** | P2-B 9 项确定性断言 + 调用点门禁 + 缺口棘轮 |
| `tests/unit/eval/p2-v3-replay-cli.test.ts` | **新建** | 2 项 CLI 参数→路径边界回归（见 E14） |
| `docs/reports/p2-a-b-kernel.md` | **新建** | 本报告 |

**未改**（按队长裁决与写入边界）：`scripts/eval/jitrl-eval-lib.ts`、`scripts/eval/pr4a-five-arm-lib.ts`、`docs/reports/p2-preregistration*.md`、`scripts/eval/pr4a-stats.verify.mjs`、`src/ledger/**`、`scripts/eval/guarded-regression.mjs`、CI 门禁语义。
（工作树中 `src/harness2`、`src/dsh-bridge`、`src/ledger` 等其他改动属其他成员，与本任务无关。）

---

## 7. 遗留风险与未执行项

| 项 | 状态 | 说明 / 授权申请文本 |
| --- | --- | --- |
| V2 引擎默认语义对齐 | **未执行（需授权）** | 申请文本："授权在**新预注册**下把 fair/PR-4A 的 `runDecisionKernel` 调用对齐到 `learningFacingFilterOptions()`、写回改为 r4/verifier-first-v1，并接受历史 -0.250 帧与 e2e klMean 断言随之移动（历史报告不改写、并列新结果）。" 替代验证：本任务的影子对照（§3.4）+ 缺口棘轮（§3.6） |
| 真实宿主 smoke / 真实外部调用 | **未执行（需授权）** | 本任务全部为确定性离线夹具；宿主验收 runner 是 `src/verification` 的真实实现，但运行在同一进程（**不是沙箱**） |
| 真实付费模型 / 五臂重跑 | **未执行（需授权）** | 本任务 `liveCalls=0 / incurredRealUsd=0`，无任何模型适配器构造 |
| holdout 结论 | **未执行（不在本任务）** | holdout 只允许按 P2-C 预注册做最终检验；本任务未读取、未使用 |
| V3 评测结论 | **不产出** | 本报告数字是设计期自检/契约验证；评测结论属 P2-C/P2-D |
| 缺口棘轮的维护 | 风险已标注 | 若有人在新预注册前对齐 V2 引擎，棘轮会红；解除条件写在测试注释里 |
| 影子对照的 stale 语料是**建模假设** | 已声明 | 3× 副本与 r2 排序（有文本 > 已验证）是建模选择，不是测量；它只回答"admitted 与否是否改变选择"这一结构问题 |
| 失败可学习性 | 结构性限制 | §3.5：被证伪的成功声明 audit-only；trusted-failure 学习是 C2 未完成项，本任务不伪造 provenance |
| `--out=` 参数被直接当作路径（已修） | **已修 + 回归测试 + 清理** | 缺陷：`outArg` 保留 `--out=` 前缀就传给 `mkdirSync/writeFileSync`，`--out=work/x.json` 会创建字面目录 `--out=work/`（flag 本身成为首个路径段）；已产生的 `--out=work/p2-v3-replay-r4.json`（1 个文件）经确认后删除，`STRAY_ENTRIES=0`。修法：剥离前缀、空值 `--out=` 在重放前 fail-closed 退出、`resolve()` 后创建<b>该文件自己的</b>父目录。回归：E14。性质说明：这是『参数直接当路径用』没被任何检查覆盖的缺陷类，与本报告其它入口（`--baseline`/`--capture`/`--fixture` 均已剥离前缀）无关 |
| PR-4A smoke 前后对照的可复算性 | 已补齐（review 要求） | 历史两份输出在 `work/`（未跟踪）；**durable 不变量**是脚本内 pinned 归一化 digest `0654a6cb…d423`：任何人任何时刻 `node scripts/eval/pr4a-smoke-invariant.mjs` 都能复核，`--baseline=<文件>` 可对任意捕获文件做行级差分 |
| `pr4a-v3-design.mjs` 字节漂移 | 已对齐 | 37038 B / `6711e8aa…`；canonical digest 不变（47720 B / `585d0307…`），已告知 p2-prereg 按其 §8.1 规则处理 |
| `pnpm run check:docs` 计数行 | **红（团队性，非本任务引入）** | README 计数行（Summary 103/2094、Unit 90/1935）落后于工作树实际（Total 115/2252、Unit 102/2093、E2E 13/159）：本任务新增 **2 文件/16 测试**，其余为并行任务新增（约 +10 文件/+142 tests）。R-04 的 `unit + e2e == total` 与测试根归属断言**通过**；配置参考覆盖 78/78 通过；`check:encoding` 通过（E10）。README.md 不在本任务写入范围，计数行归 docs 门责任者更新：Summary 115/2252、Unit 102/2093、E2E 13/159、Total 115/2252 |

---

## 8. 复算命令清单（reviewer 最小集）

```bash
# 0) 任务表冻结值（内容，不是源文件字节）
node scripts/eval/pr4a-v3-design.mjs --canonical | sha256sum
# -> 585d030790072ba2fc096d00821e1a2a88bbb0866e91491962ae117fa15a2142

# 1) P2-A 设计门（oracle/prior/带宽/秩/反例）
node scripts/eval/pr4a-v3-design.mjs

# 2) P2-B 对齐重放（r4：全断言通过）
node scripts/eval/pr4a-v3-replay.mjs --fixture=r4-production --json --out=work/p2-v3-replay-r4.json

# 3) P2-B 全过滤负对照（必须 ABORTED，不是 warning）
node scripts/eval/pr4a-v3-replay.mjs --fixture=r2-legacy

# 4) 必跑门禁
pnpm exec tsc --noEmit
pnpm exec vitest run tests/unit/jitrl
node scripts/eval/negative-result-diag.mjs --assert
```

---

## 9. 本报告不声明什么

- 不声明 V3 有任何**评测结论**（效应量、显著性、holdout、优胜者）；这些属 P2-C/P2-D。
- 不声明历史五臂的负结果被修复或改写；只声明其**生产语义外推边界**。
- 不声明离线宿主验收 runner 等于沙箱或真实宿主 smoke；同进程执行不是沙箱。
- 不声明 estimated 成本为 measured 成本；本任务不涉及成本轴。
- 不声明"部分得分"进入主奖励；分级验收的等式断言证明其被排除。
