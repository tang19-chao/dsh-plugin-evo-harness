# ADR 0007：Pareto 与预算钩子——"非劣/严格超越"术语、"holdout 防火墙"、预算档与只 ask 提醒

| 项 | 值 |
| --- | --- |
| 状态 | **accepted**（本 ADR 是 P6 轮"Pareto 与预算钩子"的术语与行为裁定，实现、测试、报告共同遵守） |
| 日期 | 2026-10-29 |
| 代码基线 | 工作树基线 `feb8465ded73ca48a770054c587990b93f54e21e` + P2–P6 各任务工作树改动（本轮不 commit、不 push） |
| 决策来源 | `docs/reports/p2-p6-remaining-work.md` §7（P6 清单）+ 队长 2026-10-29 裁定（t11 拆批；A 方案：不新增 config 叶；文案替换文本必须可直接粘贴；负控制必须真红；成本轴必须整轴 fail-closed） |
| 影响范围 | `src/jitrl/jit-active-policy.ts`（新增预算档/Pareto 轴/只 ask 提醒，默认关闭）、`tests/unit/jitrl/`（新增证据）、`docs/reports/p6-pareto-budget.md`（交付报告）；**不修改** `src/jitrl/decision-kernel.ts`、`src/jitrl/index.ts`、`src/runtime/execution-profile.ts`、`docs/adr/0002-*.md`（改写文案只登记、不落盘，见 §4） |
| 术语基线 | `docs/adr/0002` §R2（publish 权限）、`docs/adr/0004` §4（Dreamer holdout）、`docs/adr/0004-c3`（成本/计量）、`docs/reports/p2-preregistration-v3.md` F8（holdout 使用规则） |

## 1. 背景：同一个门，两套词

本仓当前存在一处**"文档比代码宽松"**的术语漂移，而这是最危险的一类偏差：读者会按文案去用 holdout，而实现本来不允许。

| # | 位置 | 现文案 | 实现实际判据 |
| --- | --- | --- | --- |
| D-1 | `docs/adr/0002-p62-release-contract-and-default-safe-shape.md` §R2 publish 行 | "**holdout 非劣证据** + 显式授权 + 匹配 artifact 三者齐备" | 严格超越：`decideReplayPublication` 先要求 `improved = hypervolume > baseline + ε`（`src/jitrl/decision-kernel.ts:1778`、`:1799`），再要求 `validatedOnHoldout === true`（`:1816`–`:1833`）；而 `validatedOnHoldout` 在 `src/dream-rsi/offline-dreamer.ts:2334` 由 `holdoutHypervolume > holdoutBaselineHypervolume + ε` 产生——**两个方向都是严格超越**，没有任何容差带 |
| D-2 | `src/runtime/execution-profile.ts:119`–`:122` publish 拒绝理由 | "holdout **non-inferiority** + explicit authorization + matching artifact are all required" | 同上：严格超越 + 授权 + artifact；`permissions.publish.allowed` 恒为 `false`（本轮任何路径都不解锁） |

两种读法的后果不同：
- 按原文案（非劣）读：读者会认为"holdout 上打平（落在 δ 容差内）即可发布"，从而把 holdout 当成一条**宽松的验收线**；
- 按实现（严格超越）读：holdout 上打平等于**未通过**，发布被拒。

**裁定**：以实现的严格超越为准；"非劣"不是本仓任何机器可判定的凭证。§2 给出术语定义，§3 给出作用位置，§4 给出可直接粘贴的替换整行。

## 2. 术语裁定（唯一定义）

四个词，各有唯一定义与唯一允许的使用面。**任何代码注释、报告、提交说明都不得混用。**

| 术语 | 英文（代码内） | 定义（数学） | 本仓是否机器判定 | 允许出现的位置 | 禁止出现的位置 |
| --- | --- | --- | --- | --- | --- |
| **严格超越**（严格支配，strict dominance） | `strict-improvement` / `strictly better` | 在同一证据集上 `m(A) > m(B) + ε`（`ε > 0`，本仓默认 `hypervolumeEpsilon = 1e-9`，`src/dream-rsi/offline-dreamer.ts:2101`）；"支配"用于二维 Pareto 判定时：`q_A ≥ q_B` 且 `c_A ≤ c_B` 且至少一维严格 | **是**（唯一被实现的比较） | ①开发/选择集上的候选优胜（`isBetterEvaluation`，`offline-dreamer.ts:2043`–`:2059` 主轴；`improvedOnSelection` `:2294`–`:2296`）；②holdout 优胜者检验（`:2334`）；③publish 门（`decision-kernel.ts:1789`–`:1839`）；④P6 Pareto 轴（`jit-active-policy.ts` `dominates()`） | —— |
| **非劣**（non-inferiority） | `non-inferiority` | `m(A) ≥ m(B) − δ`，`δ` 必须是**预注册**的容差带与统计口径（区间、α、功效） | **否**（本仓没有任何非劣判定代码，也**不得**在 P6 轮新增） | 仅作为**实验报告语言**：描述"未观察到超出 δ 的退化"这一统计判读（P2-C 预注册的独立判读维度之一，见 `docs/reports/p2-preregistration-v3.md` §判定表） | 发布凭证、候选选择、Pareto 过滤、调参、早停、任何"打平即可"的自动化门 |
| **非回归承诺**（non-regression guarantee） | `monotone non-regression guarantee` | 对**未来**在线任务的单调不退化承诺 | **否** | 只能出现在**否定句**里：`REPLAY_GATE_BOUNDARY`（`decision-kernel.ts:1766`–`:1767`）明确声明"它不是未来在线任务的单调非回归保证" | 任何正向收益/上线承诺 |
| **预算档** | `budget tier` | 探针数上限，与货币无关（§6） | **是**（P6 新增，默认关闭） | `jit-active-policy.ts` `BUDGET_TIERS` / `BUDGET_TIER_PROBE_CEILINGS` | 货币成本、论文权重、"最优值"声明 |

使用规则（可执行判据）：

1. **只有严格超越能赢。** 任何"差一点也算过"的门都是非劣门，本仓没有；若要引入非劣门，必须新 ADR + 预注册 δ + 功效论证，且**不得**与 holdout 复用同一次评测。
2. **非劣不得作为凭证。** "非劣"在报告里只能描述统计判读，不能写成"因此可以发布/因此候选胜出"。
3. **严格超越蕴含非劣**（`m(A) > m(B) + ε` ⇒ `m(A) ≥ m(B) − δ`，任意 `δ ≥ −ε`），反之不成立。因此把"严格超越"写成"非劣"是**把门放松**，属于文案缺陷而非同义改写。
4. **平手不是胜利。** `isBetterEvaluation` 的次级键（`meanCost` 更小、`policyId` 字典序）只在两候选的 hypervolume 落在 ε 内时用于**在候选之间定序**（`offline-dreamer.ts:2051`–`:2057`），不改变"相对基线必须是严格超越"（`:2294`–`:2296`）。

## 3. 作用位置（一个位置只用一个词）

| 位置 | 代码锚点 | 判据 | 用的词 |
| --- | --- | --- | --- |
| 候选生成前的切分 | `offline-dreamer.ts:2183`–`:2201`（`splitDreamerHoldout`） | 先进先出按组切、时间隔离；失败即 `insufficient-*` fail-closed | —— （holdout 防火墙，§5） |
| 开发/选择集上的候选排序 | `offline-dreamer.ts:2043`–`:2059`、`:2279`–`:2292` | hypervolume 严格超越优先；ε 内用 `meanCost`、再 `policyId` 定序 | **严格超越**（主轴） |
| 相对基线的"是否有改进" | `offline-dreamer.ts:2294`–`:2296` | `best.hypervolume > baseline.hypervolume + ε` | **严格超越** |
| holdout 优胜者检验 | `offline-dreamer.ts:2305`–`:2335` | 只回放 winner 与 baseline，`holdout > baseline + ε` 才置 `validatedOnHoldout = true` | **严格超越** |
| publish 门 | `decision-kernel.ts:1789`–`:1839` | `improved === true` 且 `validatedOnHoldout === true` 且非 shadow | **严格超越 + holdout 验证**（不是非劣） |
| P6 Pareto 轴（新增） | `jit-active-policy.ts` `dominates()` | 二维严格支配（质量大、探针少，至少一维严格） | **严格超越**（支配） |
| P6 预算档（新增） | `jit-active-policy.ts` `resolveBudgetTier()` | 探针数上限；超档只报告/提醒 | **预算档**（探针数，非货币） |
| P6 提醒（新增） | `jit-active-policy.ts` `emitBudgetReminder()` | `probes > ceiling` 且提醒开关为 true | **只 ask**（不 deny） |

## 4. 文案差异登记与可直接粘贴的替换整行

**本轮不改这两个文件**（`docs/adr/0002` 与 `src/runtime/execution-profile.ts` 均在本任务写范围外，且改动会牵动既有 ADR 链与 execution-profile 测试）。下面两行是**逐字符可直接粘贴**的替换整行；谁在范围内，谁按行替换，无需再解读。

### 4.1 `docs/adr/0002-p62-release-contract-and-default-safe-shape.md` 第 51 行（publish 行）

原文（整行）：

```markdown
| **publish** | 发布/热更新策略（publishPolicy 类动作） | **deny** | holdout 非劣证据 + 显式授权 + 匹配 artifact 三者齐备；任一缺失即拒绝。本轮**任何路径都不解锁** |
```

替换为（整行）：

```markdown
| **publish** | 发布/热更新策略（publishPolicy 类动作） | **deny** | holdout **严格超越**验证（优胜者在 holdout 上 hypervolume > baseline + ε；ADR 0002 原文"非劣"为文案漂移，实际实现与 ADR 0007 §2 均为严格超越，非劣不是本仓凭证）+ 显式授权 + 匹配 artifact 三者齐备；任一缺失即拒绝。本轮**任何路径都不解锁** |
```

### 4.2 `src/runtime/execution-profile.ts` 第 121 行（publish 拒绝理由）

原文（整行）：

```ts
        reason: 'publish is never granted in this round: holdout non-inferiority + explicit authorization + matching artifact are all required and none exists (ADR 0002 R2)'
```

替换为（整行）：

```ts
        reason: 'publish is never granted in this round: holdout STRICT-IMPROVEMENT validation (winner hypervolume > baseline + epsilon on the held-out trees, ADR 0007 §2 - the earlier "non-inferiority" wording was drift) + explicit authorization + matching artifact are all required and none exists (ADR 0002 R2)'
```

> 注：`tests/unit/dream-rsi/pr4b-holdout.test.ts` 与 `tests/unit/p62/*` 只在**行为**上钉住"发布被拒 + 理由含 held-out trees / holdout-missing"，不断言上述整行文本，因此替换不破坏既有测试（替换者仍应跑一次相关套件）。

## 5. holdout 防火墙：单点、单向、不可逆

holdout **只能按预注册用于最终优胜者的一次检验**。以下每一条都是硬约束，且已有代码锚点；本 ADR 只是把"实现已经在做的事"说死，不新增加载。

1. **切分先于一切**（`offline-dreamer.ts:2183`–`:2189`）：`splitDreamerHoldout` 在生成器运行、任何 hypervolume 计算之前完成；`holdoutTreeCount === 0`（默认，`src/config.ts:378`）表示"没有 holdout"，`validatedOnHoldout` 保持 `undefined`，publish 继续以 `holdout-missing` 拒绝（`:1825`–`:1833`）。
2. **holdout 不外泄到生成/选择**：生成器拿到的是 `{ ...request, trees: selectionTrees }`（`:2230`–`:2234`）；选择集的 cost ceiling 只由选择侧回放构成（`:2261`–`:2273`）；holdout 侧有自己独立 ceiling（`:2314`–`:2328`）。
3. **只回放优胜者，不回放全部候选**（`:2302`–`:2304`、`:2308`–`:2335`）：对 holdout 回放所有候选再取最好，等于把 holdout 变成第二个选择集（多重比较过拟合）。
4. **失败即 fail-closed**：`insufficient-holdout-trees` / `insufficient-holdout-groups` / `no-holdout-configured` 时 `holdoutTrees` 为空、`validatedOnHoldout` 不置位、不缩小 holdout（`:780`–`:901`）。配置层交叉规则 `holdoutTreeCount < maxTreePoolSize`（`src/config.ts:1056`–`:1086`）。
5. **"看一眼"也违规**：把 holdout 的**任何统计量**（均值、排名、超过阈值的计数、甚至"哪个候选在 holdout 上看起来更好"这一判断）用于候选选择、Pareto 过滤、调参、早停，都违反本条——包括"只看不吃"的探索性分析。唯一的合法读取是 `replay` 内部对**已选定优胜者**的一次回放；结果不回流到任何搜索产物（P2-C F8 的防火墙约定）。
6. **P6 新增的预算/Pareto 层不得引入 holdout 输入**：`BudgetHookConfig` 只有 `tier` / `reminder` / `costObservations` 三个字段（`jit-active-policy.ts`），**没有** holdout、split、validation 字段；装饰器源码不含 `holdout` 标识符（由 `tests/unit/jitrl/p6-pareto-budget.test.ts` 的源码级负例钉住）。成本观测只能来自开发侧测量（P3 账本 measured 桶）。

## 6. 预算档（Lite / Medium / Heavy）与成本轴

### 6.1 预算档只是探针数预算

- 三档 = 三个**探针数上限**：`BUDGET_TIER_PROBE_CEILINGS = { lite: 2, medium: 4, heavy: 8 }`（`jit-active-policy.ts`），单位是"每轮允许的探针槽数（`BatchPlan.width`）"。
- **不照搬论文权重**：这些数字是本仓批宽的运行学默认值，不是任何论文的最优权重，也不声称最优；换档位不需要新 ADR，但**不得**把它写成"论文值"或"最优值"。
- **探针数成本不得表述为货币成本**：`BudgetReminder.unit` 固定为 `'probes'`；任何"探针数 × 单价"的换算、任何把探针数写进 `costMicros` 的字段都是违规。货币成本只能来自实测（§6.2）。
- 预算档**只报告、不拦截**：超档产生 `withinTier: false` 诊断（和开关打开时的 ask），计划本身逐字节不变（只 ask 不 deny）。

### 6.2 成本轴只吃 measured；estimated/unknown 使**整轴**不可用

- 轴上的每个观测 `CostObservation` 都带 `costProvenance: 'measured' | 'estimated' | 'unknown'`，映射自 P3 账本三桶（`src/ledger/usage-report.ts` 的 measured/estimated/unknown；`CostCalculation.dimensionProvenance` 五维全 measured 才算 measured）。
- **整轴 fail-closed，不是剔点**：只要出现**一个**非 measured 观测（或形状不可用），`paretoFront()` 返回 `usable: false`、`rejected > 0`、`nondominated = dominated = []`，`BudgetGateResult` 只报 `costAxisProvenance: 'unavailable'`，**不产生 `pareto` 字段**。
  理由（队长裁定，写入本 ADR 以免后人"优化"成剔点）：把 estimated 点剔掉会得到一条"看起来更优"的前沿——因为**保留与否恰好由被比较的成本维度决定**，这是静默的有利偏差。
- 零观测 = 轴不可用（空集不能做成本比较），同样不产生 `pareto` 字段。
- 支配定义：`q_A ≥ q_B` 且 `c_A ≤ c_B` 且至少一维严格（`dominates()`）；两轴相等**不**构成支配（两条相同观测都留在前沿）。输入顺序保留，输出确定性。

### 6.3 cacheRead 与 prefix cache

- `cacheRead` 不可得时保持 **unknown**（P3-C：`cacheReadUnavailable`、"unknown, not a measured zero"）。
- **只有实测 cacheRead 可用时才评估 prefix cache 影响**：本仓当前没有实测 cacheRead 流的证据，因此本 ADR 与 P6 实现**不评估、不声明**任何 prefix cache 收益；任何 prefix-cache 影响的结论都必须先有 `cacheRead` 的 measured 观测，否则按未执行处理（P3-C 的反向门禁继续有效）。

## 7. 预算提醒：独立开关、只 ask、只走观察通道

1. **独立、默认 false 的权限开关**：`BudgetHookConfig.reminder.enabled`（默认 `false`），**不复用** `guarded-active` / `execution.applyWinningPatch` / `interceptExecution` / 任何 patch 权限（清单明确禁止复用授予 patch 权限的开关）。开关为 false 时不产生、不发送、不记录任何提醒。
2. **只 ask、不 deny**：提醒只能做两件事——写进 `metadata.jit.budget.reminder` 诊断、调用可选的 `onReminder` 回调。它**不能**删槽、改序、缩宽、拒绝决策、改写工具结果；`withinTier: false` 时计划与 `withinTier: true` 时逐字节一致（测试钉住）。
3. **通道**：`post-execute` 只有观察通道（`src/cordis-seams/dsh-hook-host-adapter.ts:1139`–`:1154` 只做 `observeToolCall` 记录），**不得假设可改写工具结果**。提醒的宿主侧落点是既有 pre-step `additionalContexts` 追加路径（`dsh-hook-host-adapter.ts:1155`–`:1196`，advisory 模式把文本追加到 `additionalContexts`；gate 模式转发 `{ kind: 'ask' }`，`:425`–`:428`）。P6 只生产 ask 载荷（`BudgetReminder`），**本轮不接宿主侧**（写范围外）。
4. **注入路径（A 方案，队长裁定 2026-10-29）**：
   - **唯一注入路径 = 装饰器构造者**：任何调用 `JitRl.createJitActivePolicy(options)` / `createJitActivePolicy(options)` 的代码，在 `options.budget` 上传入 `{ tier, reminder: { enabled: true, onReminder }, costObservations }` 即生效。`src/jitrl/index.ts:441`–`:466` 的工厂用 `...policyOptions` 原样转发，**不需要改一行 `src/jitrl/index.ts`**（这是本轮不接线也不影响可注入性的原因）。
   - **宿主可达的最后一跳在 `src/index.ts:1575`**（`kernel.createJitActivePolicy({...})`，全仓唯一生产构造点）。让它可由宿主配置驱动的精确补丁（本轮**不应用**，写范围外）：
     ```ts
     // src/index.ts:1575 起，wrapped 的构造对象里新增一行（配置叶见下一行）
     budget: config.jitrl.budget === undefined ? undefined : { ...config.jitrl.budget },
     ```
     以及对应配置叶（同样本轮**不新增**，队长裁定 A；`src/config.ts` + `README` 参考行 + `tests/unit/config/readme-default-leaves.test.ts` 计数 78→79/75→76 必须同一变更集）：
     ```ts
     // src/config.ts JitRlConfig 内新增（默认关闭）
     budget: { tier: 'medium', reminder: { enabled: false } },
     ```
   - **为什么本轮不接**：`src/index.ts` 与 `src/config.ts` 的连带改动（README 行、readme-default-leaves 计数、契约测试）不在本任务写范围，且 t13（P3-A2 硬限额开关）同期在改配置装配层，串行风险大于收益；语义上开关已满足"独立、默认 false 的权限开关"。
   - **谁在什么时点补**：由队长在 t13 落地后统一接线（配置叶 + `src/index.ts:1575` 一行 + README/计数），或在新任务中授权给 P6 owner；本 ADR §8 的交付表把该项标为 `wired=false (handoff)`。
5. **回滚开关**：删除 `budget` 块（构造级）或 `reminder.enabled=false`（提醒级）即回滚；两者都不触碰计划与既有诊断键。

## 8. 本仓实现清单（默认关闭、可回滚）

| 能力 | 符号（`src/jitrl/jit-active-policy.ts`） | 默认 | 是否改变计划 | 证据 |
| --- | --- | --- | --- | --- |
| 预算档 | `BUDGET_TIERS`、`BUDGET_TIER_PROBE_CEILINGS`、`resolveBudgetTier()` | 冻结常量；仅在传入 `budget` 时使用 | 否 | 单测：档位/上限/未知档构造期抛错 |
| 门限诊断 | `evaluateBudgetGate()`、`JitBatchDiagnostics.budget` | `budget` 缺省即不出现该键 | 否 | 单测：默认构造无 `budget` 键；before/after 摘要相同 |
| 只 ask 提醒 | `BudgetReminder`、`emitBudgetReminder()` | `reminder.enabled` 缺省 = false | 否（超档也不动计划） | 单测：开关 false 不产生；true 产生 1 条且槽位不变 |
| 只吃 measured 的 Pareto 轴 | `CostObservation`、`paretoFront()` | 无观测/非 measured → 轴不可用 | 否（诊断） | 单测：整轴 fallback + 负例（一条 estimated 使前沿为空） |
| holdout 防火墙（结构） | 无 holdout 输入字段；源码无 holdout 标识符 | —— | 否 | 单测：源码级负例 + 行为级负例（§9） |
| 接线（宿主可达） | `src/index.ts:1575` + 配置叶 | **未接线（handoff）** | —— | 本 ADR §7.4 给出整行补丁 |

**兼容性**：默认（不传 `budget`）下装饰器的 `BatchPlan` 与 `metadata.jit` 逐字节不变——由"改动前/改动后同一夹具同一注入时钟"的规范 JSON 摘要相等证明（`SLOTS_DIGEST`、`DIAG_DIGEST` 双摘要，见 `docs/reports/p6-pareto-budget.md` §3 与单测钉住值）。

## 9. 验收证据（详见 `docs/reports/p6-pareto-budget.md`）

| 验收项 | 判据 | 证据位置 |
| --- | --- | --- |
| 术语 ADR 与代码/文案一致 | 本 ADR §2/§3 的表；代码内 `strict` 措辞与 §4 替换整行 | §2、§3、§4；`dominates()` 注释 |
| holdout 不参与选择与过滤（含负例） | 行为负例：只在 holdout 上占优的候选不被选中；生成器拿不到 holdout；删除防火墙的变异夹具必须红 | §5、报告 §4 |
| 默认配置下宿主行为不变 | 改动前后同夹具摘要相等 + 默认构造无新增诊断键 | §8、报告 §3 |
| 成本只用 measured | 一条 estimated/unknown → 整轴不可用且无 `pareto` 字段 | §6.2、报告 §5 |

## 10. 不做 / 未执行（明确登记）

- **不修改** `src/jitrl/decision-kernel.ts`、`src/jitrl/index.ts`（p2-kernel 所有）；**不修改** `src/runtime/execution-profile.ts`、`docs/adr/0002-*.md`（§4 只给替换整行，落盘留给范围内 owner）。
- **不新增** `src/config.ts` 配置叶（队长裁定 A）；宿主可达接线（§7.4）**未执行（需授权/需串行）**。
- **不接**宿主侧 pre-step `additionalContexts` 通道（`dsh-hook-host-adapter.ts` 写范围外）；P6 只生产 ask 载荷。
- **不评估 prefix cache 影响**（无实测 cacheRead；§6.3）。
- **不跑**真实宿主 smoke、真实付费模型调用、真实记忆写入（授权边界）。
- **不改写**任何历史负结果、统计数字、阈值或标签；**不把** estimated 当 measured；**不把**同进程执行称作沙箱。

## 11. 参考

- `docs/reports/p2-p6-remaining-work.md` §7（P6 清单）与 §8（授权边界）。
- `docs/adr/0002` §R1/§R2/§R6（执行模式、权限分层、研究路径冻结）。
- `docs/adr/0004` §4（Dreamer holdout 切分、信息可见性、fail-closed）。
- `docs/adr/0004-c3`（计量三态、cacheRead、measured/estimated/unknown）。
- `docs/reports/p2-preregistration-v3.md` F8（holdout 单点单向规则）。
- 代码锚点：`src/dream-rsi/offline-dreamer.ts:2043`–`:2059`/`:2183`–`:2335`、`src/jitrl/decision-kernel.ts:1766`–`:1839`、`src/runtime/execution-profile.ts:119`–`:122`、`src/cordis-seams/dsh-hook-host-adapter.ts:1139`–`:1196`、`src/jitrl/jit-active-policy.ts`（P6 段）。
