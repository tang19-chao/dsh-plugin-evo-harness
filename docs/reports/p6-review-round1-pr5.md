# PR5（R5）独立评审 — Gate 3 第 1 轮

| 项 | 值 |
| :-- | :-- |
| 被评任务 | t6「PR5 / R5：在线与 replay 共用纯决策内核、EffectivePolicyConfig 版本化与 M3 口径修复」 |
| 评审任务 | t14（attempt `ce4604e5-142d-40bd-b0e5-b609c241c84e`） |
| 冻结修订（sha256 前 8 位） | `src/jitrl/decision-kernel.ts` **1fc28070**、`src/jitrl/jit-active-policy.ts` **caae67aa**、`src/jitrl/index.ts` **8fb6619c**、`src/dream-rsi/offline-dreamer.ts` **42811c38**、`tests/unit/jitrl/decision-kernel-parity.test.ts` **ddbdf297** |
| 结论 | **needs_revision**：单一内核、维度范围、版本化配置、replay 发布门槛、M3 的"按 (level,bucket)"全部通过；但 **legacy／learning-ineligible 过滤是 opt-in 而两个生产调用点都没 opt-in** → 旧（误归因）记录仍进入新决策邻域，且 M3 的 `usable/fresh/saturated` 被 legacy/不可学样本灌高。 |

方法：只读代码 + 自写 3 个探针（esbuild 打包，直接调用模块真实导出）+ 评审人亲自跑平价测试。除 `docs/reports/` 外未改仓库文件。

---

## 1. 通过项（均为我自跑）

**1.1 在线与 replay 确实是同一个内核**
全仓 `runDecisionKernel` 只有两个生产调用点：`jit-active-policy.ts:686`（在线 L1 `adjust()`）与 `index.ts:755`（`createJitReplayHook`，纯壳）。replay 的注释（`index.ts:712-729`）明确它只做两件事：喂因果截断快照、把内核结果投影回 hook 形状。我亲自跑平价测试：

```
 ✓ tests/unit/jitrl/decision-kernel-parity.test.ts (35 tests) 47ms
 Test Files  1 passed (1)   Tests  35 passed (35)   PARITY_EXIT=0
```

**1.2 维度范围**：`POLICY_SEARCH_DIMENSIONS=["beta","k","similarityThreshold"]`；`POLICY_IGNORED_DIMENSIONS` 三条各有实质原因（lambda/alpha 在 L1+L2：抽取是逐动作 Bernoulli，扫它会让候选排名跟着 seed 走；gamma 在 L2：持久化 return 已按旧 gamma 折现，改 gamma 无法重算）。层归属明确：level3 不拥有其中任何维度。

**1.3 被忽略维度确实"被显式标记而非静默 applied"**（我自跑 replay hook，逐项改 jit 字段）：

```
base          weights{exploit:0.4637, domain:0.0895, invariant:0.3468, recover:0.1} neighbors=3
beta=6        weights{exploit:0.7658, domain:0.00004, invariant:0.1342, recover:0.1} → changed=true
k=1           weights{0.3,0.3,0.3,0.1} neighbors=1                                   → changed=true
lambda=0.9    weights 与 base 完全相同 → changed=false   ← 被忽略而非静默应用
alpha=0.9     weights 与 base 完全相同 → changed=false
```
（我这份夹具里 threshold=0.99 没改变结果，因为三条记录与 state 的 Jaccard 都是 1.0；这是**夹具限制**，不是反例缺失——作者在 `parity.test.ts:705` 用差异化相似度覆盖了该维度。我不据此下结论。）

**1.4 EffectivePolicyConfig 版本化（我自跑 provider）**：

```
v1 read by level1      : version=0 tag=config@v0 beta=1   k=10
publish({level1:{beta:2.5,k:9}}) → version=1 tag=config@v1 beta=2.5 k=9
next decision (level2) : version=1 tag=config@v1 beta=2.5 k=9   ← 下一次决策即读到新版本
gamma fixed=0.5，归属 level2
history=config@v0,config@v1   consumption=[level1@config@v0, level2@config@v1]
```
`current()` 每次调用都记 consumer+version（`decision-kernel.ts:514-526`），`publish()` 先构造完整 `merged` 再整体替换（`:536-559`），因此读者不可能看到"新版本+旧数值"。在线侧 `adjust()` 每次决策都 `effectiveConfig(policy)`（`jit-active-policy.ts:674-677`）并把 `policyVersion` 传进内核与诊断。

**1.5 M3 的 (level,bucket) 隔离**：5 条 fresh 丢在 `bucket-A`，`bucket-B` 只有 1 条 fresh → `bucket-B: usable=…/fresh=1`、`bucket-A: fresh=5 saturated=true`；把记录整体改成 `level:'proposal'` 后对 `level:'meta'` 的支持数为 **0** ⇒ 其他 bucket／其他 level 不冒充当前 bucket 支持。

**1.6 replay 发布门槛**：

```
improved                → publish=true
not improved            → publish=false
shadow mode             → publish=false（suggestion recorded but not published）
holdout lost            → publish=false（won on selection trees but not on held-out）
improved + holdout won  → publish=true
boundary: "…it holds only on the fixed historical replay set, and it is not a monotone
           non-regression guarantee for future live tasks"
```
`REPLAY_GATE_BOUNDARY` 明确声明只适用于固定历史 replay 集合、不是未来不退化保证；shadow 不发布 ✓。

---

## 2. F1 / high：legacy 与 learning-ineligible 过滤是 opt-in，生产没人 opt-in

**代码事实**：共享过滤器的两个排除项都是**显式开关**（`decision-kernel.ts:680-691`）：
```ts
if (options.excludeLegacy === true && isLegacyExperienceRecord(...)) return 'legacy';
if (options.learningEligibleOnly === true && !isLearningEligibleExperience(record)) return 'learning_ineligible';
```
而生产调用点**从不传这两个开关**：
- 在线：`jit-active-policy.ts:686-699`（只有 level/state/candidates/records/config/policyVersion/now/rng/projectNeighbors）；取快照的 `resolveSnapshot`（`:284-301`）也不做任何版本过滤。
- replay：`index.ts:755-786` 同样没有。
- M3 支持数：`index.ts:825-836` 只传 `{level,bucket,policyId,k,guidance?}`。

**实测（同一批记录，按生产选项 vs 严格选项）**：

| 记录 | 性质 | 生产选项 reason | 严格选项 reason |
| :-- | :-- | :-- | :-- |
| b1 | fresh(policyId=pi-1) | kept | kept |
| b2 | stale(pi-0) | kept | kept |
| b3 | **legacy**（无 schemaVersion） | **kept** | legacy |
| b4 | **learningEligible:false** | **kept** | learning_ineligible |

```
邻域大小：production kept=4 | strict kept=2
M3 (meta,bucket-B)：production usable=4 fresh=3 stale=1
                     strict     usable=2 fresh=1 stale=1
```

**影响**：
1. §6.5 的"旧（误归因）记录不进入新版学习邻域"在**实时路径**上没有被执行——legacy 记录仍可成为在线决策的近邻并参与 Q/V 与 logit 修正。
2. M3 漂移口径被灌高：`fresh` 把 legacy 与 `learningEligible:false` 记录都算作"当前策略的新鲜可用样本"，于是 `saturated = fresh >= k` 会**提前成立**，把漂移惩罚（`driftRho` 降权）关掉——恰好是在那些存放了被污染历史的 bucket 上。
3. 作者的测试标题写的是 "…**when asked**"（`parity.test.ts:892/993`），即测试验证的是"机制可用"，而生产从未 ask——这正是本轮重复出现的"机制存在但未接线"模式。

**要求修复**（二选一，推荐前者）：
1. 在两个内核调用点与 M3 调用点显式传 `excludeLegacy: true, learningEligibleOnly: true`（或把这两个开关并入一个"学习面向消费者默认开启"的选项），并把该策略写进注释与状态诊断；
2. 或明确论证并记录"决策邻域允许 legacy、只有 M3 需要严格过滤"的口径——但那样必须至少给 M3 调用点补上 `learningEligibleOnly: true`，并在文档里说明与 §6.5 的差异。
   验收测试（必须走**生产调用点**，不能再只测函数）：在线跑一次决策时邻域不包含 legacy/ineligible 记录；replay+M3 的 `usable/fresh` 与严格口径一致；并断言"删掉这两个开关后测试必红"。

---

## 3. 验收清单

| 验收项 | 结果 | 证据 |
| :-- | :-- | :-- |
| 独立验证在线/replay 在同一输入下 neighbors/weights/Q/V/logits 一致 | **passed** | §1.1：两个调用点 + 我亲跑平价测试 35/35；作者测试逐项断言 neighbors(ids/weights/similarity)、stateValue、neighborCount、四槽 support/Q/advantage/normalizedAdvantage |
| 只对齐 beta/k/similarityThreshold；lambda/alpha 显式 ignored；gamma 固定且有说明 | **passed** | §1.2/§1.3：表 + 我自跑"改 lambda/alpha 结果不变"、"改 beta/k 结果变" |
| 每个进入搜索的维度有反例证明其影响 | **passed**（threshold 由作者测试覆盖） | §1.3：beta/k 我自证；threshold 的差异化相似度反例在 `parity.test.ts:705`（我的夹具 Jaccard 全 1，未复现该维度） |
| EffectivePolicyConfig 逐决策读当前版本；版本与配置原子切换；热替换后缓存按版本失效；L1/L2/L3 归属明确 | **passed** | §1.4（我自跑 provider）+ `parity.test.ts:852` "invalidates a version-keyed consumer cache on a hot swap" |
| M3 按 (level,bucket) 计数且只统计**过滤后可用**样本；其他 bucket 不冒充 | **failed（后半句）** | 按 (level,bucket) 与跨 level 隔离 ✓（§1.5）；"只统计过滤后可用样本" ✗（§2：生产未 opt-in legacy/ineligible） |
| hypervolume 门槛声明只适用固定历史 replay；shadow 不自动发布 | **passed** | §1.6 |

## 4. 边界声明

- 未跑全量 `pnpm test`/`typecheck`/`build`（共享工作树含其他 PR 在途改动）；本轮跑平价测试（35）+ 自写探针 3 个。
- 未接真实模型/真实宿主：全部为纯函数与 hook 级验证（Gate 3 范围）。
- 我的 threshold 反例夹具失效（Jaccard 全 1），已在 §1.3 明确标注，未把它当作反例缺失的证据。
- 未修改仓库 `src/**`、`tests/**`、`scripts/**`；探针目录已清理。
