# rev6 R1-3 / R1-4 结果：surrogate 去自指 shadow 对照 + 可判别消融设计（t10）

- **任务**：rev6 `t10`（R1-3 surrogate shadow）
- **形态**：**shadow only**。策略**未上线**，默认权重与 clamp 一个字节未动；四臂**未跑**（§7）。
- **预注册**：`docs/reports/rev6-ablation-preregistration.md`，sha256 `fc30f7d07450da80d614feba6441b630e934ec20acd9256cd27820686779b901`（§1.1 冻结本节判据）。
- **证据**：`tests/unit/dream-rsi/surrogate-evidence-policy.test.ts`（16 例全绿）+ 本文件引用的实测值。

---

## 0. 一句话结论

**自指缺陷被复现，并在 shadow 中被两种策略各自修正；默认路径未变。** 冲突反例上，去自指策略**不再**把可验证失败排在可验证通过之前；证据相等的对照**不翻转**。选定的 shadow 候选是 **策略 B（`verified-only-selection`）**，理由见 §3。

---

## 1. 缺陷复现（先证问题存在，再谈修正）

用 rev5 已交付的同一冲突夹具（`surrogate-self-reference.test.ts`，`3dd54b3c…` 逐字节未动）：

| 候选 | Composer 判定 | 实测 | 独立 verifier |
| --- | --- | --- | --- |
| `n-composer-pick` | **选中**（adoption 1.0） | 18 步、6 次工具调用、3 次错误 | 交付物内容 **FAIL** |
| `n-verified` | 未选中（adoption 0） | 5 步、6 次调用、0 错误 | 交付物内容 **PASS** |

| 打分口径 | pick | verified | 排序 |
| --- | --: | --: | --- |
| **冻结默认** `(0.4,0.3,0.2,0.1)` | **0.7658** | 0.2000 | ✗ pick 领先（自指） |
| 策略 B（权重 `(0,0,0.2,0.1)`，绝对权重不重分配） | **0.0658** | **0.2000** | ✓ verified 领先 |
| 策略 A（权重 `(0.1429,0.1071,0.5,0.25)`） | **0.4145** | **0.5000** | ✓ verified 领先 |

> 以上六个分数由代码实测（`scoreSurrogate` 与 `scoreWithEvidencePolicy` 直接调用），不是手算；复跑见 §6。差值方向一致：默认口径 pick 领先 `+0.5658`，两种策略下 verified 分别领先 `+0.1342`（B）与 `+0.0855`（A）。

`w1 + w2 = 0.7` 的尺度是 Composer 给自己打分——这就是自指，且它的方向与 verifier **相反**。

---

## 2. 两种策略与实测判别力

| 策略 | 机制 | 冲突夹具结果 | 备注 |
| --- | --- | --- | --- |
| **A** `verified-weight-floor` | 把**可验证侧**（efficiency/penalty）抬到 0.75 份额，Composer 侧压到 0.25；两组内部**保持冻结比例**（2:1 与 4:3） | ✓ 翻转（verified 领先） | 权重**由冻结默认推导**，不是新调参向量（套件逐项断言推导） |
| **B** `verified-only-selection` | 保留冻结权重，**仅当 verifier 判定为 `passed`** 时才计 Composer 两项 | ✓ 翻转（verified 领先） | 选为 shadow 候选 |

### 2.1 策略 B 的一个关键实现发现（本轮最重要的技术结论）

第一版策略 B 的规则是"**只要有 verdict 就准入 Composer 项**"。它在冲突夹具上**没有**修好缺陷：Composer 选中的那条带的是 `failed` verdict，按"有 verdict即准入"仍被计入 `0.7` 的 Composer 项，于是**仍然领先**。

**正确的规则**是"verdict 必须为 `passed`（即**佐证**而非仅仅是"存在"）才准入"。`failed` 是**反驳**，必须把 Composer 项**关掉**。这条不对称性是本策略的核心，已写成注释并有两处断言钉住（`admitSelection === false` 且 reason 含 `REFUTED`）。

### 2.2 第二个实现发现：归一化陷阱（否则修复会被静默抵消）

`normalizeSurrogateWeights` 会把任何**和不为 1** 的向量**重新归一化**。把两个 Composer 项置零后得到 `(0,0,0.2,0.1)`，和为 0.3 ⇒ 被重新归一化成 `(0,0,0.667,0.333)`——**可验证项被放大 3.3 倍**。若对被佐证的节点仍用冻结 `(0.4,0.3,0.2,0.1)`，两个候选就在**不同尺度**上比较，被反驳的节点凭 0.667 权重的 efficiency 仍可能赢。这个 bug 是被失败测试逮到的。

**修法**：策略 B 自己计算加权和，存活项**保持冻结绝对权重**（不重分配），因此两侧永远**同一尺度**。

---

## 3. 为什么 shadow 选策略 B

| 判据 | A | B |
| --- | --- | --- |
| 冲突夹具判别力 | ✓ | ✓ |
| 证据相等负控制不翻转 | ✓ | ✓ |
| 结论能否**从证据规则本身**推出 | 否（A 是标定选择） | **是**（"Composer 意见只在可被验证佐证时才可采信"） |
| 是否改变冻结权重数值 | 是（改了向量） | **否**（只做门控，向量保持不变项） |

B 的每条推理都能从"证据优先"直接推得，而 A 的 0.75 份额是一个**标定选择**（虽然由冻结比例推导，仍需人为决定"留多少给 Composer"）。因此 shadow 候选 = **B**；A 保留为对照。**两者都不上线。**

---

## 4. 负控制（全部实测）

| NC | 夹具 | 期望 | 实测 |
| --- | --- | --- | --- |
| NC-1 | Composer 选错 + verifier 相反 | 策略不把失败排在通过之前 | ✓ `[n-verified, n-composer-pick]`（A、B 均如此） |
| NC-2 | **证据相等**（同 steps/同 errors/同 verdict） | 不翻转 | ✓ 两候选分数相同、顺序保持输入序 |
| NC-2b | **完全对称**（无 composition，`selected` 由执行成功推导） | 分数恒等 | ✓ `policyScore` 与 `delta` 均逐位相等 |
| NC-3 | 无 verdict 的轨迹 | 不凭空给 `I(H*)` | ✓ `verdict='unknown'` ⇒ `admitSelection=false`，reason 含 "no verifiable verdict" |
| NC-3b | `failed` verdict | Composer 项被**反驳**清零 | ✓ `admitSelection=false`，reason 含 "REFUTED" |
| NC-4 | `DEFAULT_SURROGATE_WEIGHTS` / clamp | 逐字段不变 `(0.4,0.3,0.2,0.1)`、`[0,1]` | ✓ 且与 `DEFAULT_EVO_HARNESS_CONFIG` 逐字段相等 |
| NC-4b | 默认路径未被本模块改写 | 同函数、同数值 | ✓ `frozenScoreSurrogate === scoreSurrogate`，调用策略前后冻结向量不变 |

> **NC-2 的一个诚实说明**：最初我把"证据相等"写成了"同一对候选、一个被 Composer 选中"，并期望**完全并列**。那是错的——`adoption` 是真实信号，它的差异**不由证据反驳**，所以策略 B 保留它是对的。若强行让这一对并列，就等于用"证据相等"去否决一个未被反驳的信号。因此对照改为两层：①"证据相等但 Composer 意见不同"⇒ 顺序保持（不翻转）；②"完全对称"⇒ 分数恒等。两者都通过。

---

## 5. 边界（这份报告**不**声称的事）

1. **不是上线变更**：策略只存在于 `src/dream-rsi/surrogate-evidence-policy.ts`，默认 scorer 与装配路径未接。推广需队长裁定。
2. **不是收益证据**：这是 shadow 中的**机制判别**（冲突夹具 + 负控制），**不是**"surrogate 变好会提升任务通过率"的测量。
3. **合成环境**：夹具是确定性合成轨迹，无真实模型、无网络、无真实记忆写入。
4. **未跑臂**：本任务交付设计，不跑四臂；臂级 μ/π 区间在 `rev6-ablation-design` 报告中标 `not-evaluable`。
5. **`not-reject` ≠ 等价**：本报告不含任何"等价/无差异"表述（见预注册 §6.1）。

---

## 6. 复跑

```powershell
pnpm exec vitest run tests/unit/dream-rsi/surrogate-evidence-policy.test.ts   # 16 例
pnpm run typecheck
```


---

## 第二部分：R1-4 可判别 2×2(+1) 消融设计

> 生成命令：ode scripts/eval/rev6-ablation.mjs --json > work/t10/ablation.json（exit 0）；全部数字由冻结 V3 验证器计算，非手写估值。

### 1. 冻结框架

| 项 | 实测值 | 来源 |
| --- | --- | --- |
| 任务池 | **12 任务 × 3 轮** | `V3_TASKS.length` / `V3_ROUNDS` |
| 设计版本 | `v3/tasks-20261029` | `V3_DESIGN_VERSION` |
| 任务表摘要（实测绑定） | `sha256:585d030790072ba2fc096d00821e1a2a88bbb0866e91491962ae117fa15a2142` | `V3_FROZEN_TASK_TABLE_DIGEST` |
| 臂 | `Arm-0`（冻结参照）+ `Arm-1`…`Arm-4` = **5 个，无 Arm-5** | 预注册 §1.2 |
| 独立分析单元 | **任务**（episodes/rounds 不是独立样本） | N-7 |

**为什么用 V3 池**：V2 池的每个任务必需面都是 `prefs[:3]` 子集、oracle 恒 1、prior 恒 1 ⇒ **先验与 oracle 无法分开**（`pr4a-v3-design.mjs:8-18` 自述）。V3 池是为可判别性设计的，选它是让"有机会判别"成为**设计属性**而非运气。

---

### 2. V3 任务表的可判别性（独立门实测）

由 `verifyV3TaskTableGate({V3_TASKS, V3_ROUNDS}, 冻结摘要)` 计算，`ok: true`，`findings: []`：

| 判据 | 实测 | 含义 |
| --- | --- | --- |
| `outsideTop3Share` | **0.833333**（10/12 任务） | 10 个任务的必需面落在 proposer 前 3 之外 ⇒ 先验**不**必然命中 |
| `oracleBelowOne` | **6** | 6 个任务的 oracle < 1（天花板**可测**，不是恒 1） |
| `headroomTasks` | **7** | 7 个任务存在 prior-vs-oracle 的**非退化**余量 |
| `minActionsPerDecisionPoint` | **3** | 每个决策点至少 3 个候选（不是伪选择） |
| 支撑矩阵秩 | **9 / 14 列**（36 行） | 动作类不共线；秩 > 1 是门的要求，实测远超 |

> 门能**失败**：它用**独立重算**的 oracle（从表的 decision points 重算，而非读声明值）与**秩重算**比对，且仓库另有 `rankOneFixture` 供秩计算的反向控制。§3 复用了同一个 `matrixRank`。

---

### 3. 交互可识别性（设计矩阵秩，实测）

| 格 | intercept | track | gate | track×gate |
| --- | --: | --: | --: | --: |
| Arm-1 (process, off) | 1 | 0 | 0 | 0 |
| Arm-2 (process, on) | 1 | 0 | 1 | 0 |
| Arm-3 (quality, off) | 1 | 1 | 0 | 0 |
| Arm-4 (quality, on) | 1 | 1 | 1 | 1 |

**秩 = 4 / 4（`fullRank: true`）** ⇒ 两个主效应与交互**各自可单独估计**，交互不会被"看起来合理"的解读替代。

**这个数字是可判别的，因为它能失败**（套件逐项断言）：
- `rankOneFixture(3)` ⇒ 秩 **1**（检测到）；
- 四行完全相同 ⇒ 秩 **1**；
- 交互列 = 主A+主B（共线）⇒ 秩 **3 / 4**（交互**不可识别**）。

若出现秩不足，预注册 §5.2 规定该效果必须标 **`undetermined`**。

---

### 4. 结构性可拒绝下限与功效（精确枚举）

### 4.1 下限（Holm 校正后必须达到的不一致对数）

| 族大小 | 最小 `m_disc` |
| --: | --: |
| 1 | 6 |
| 2 | 7 |
| **4** | **8** |

Holm 阈值阶梯（族大小 4）：`[0.0125, 0.016667, 0.025, 0.05]`（= 0.05/4、0.05/3、0.05/2、0.05/1）。

**m = 1..7 一律 `structurally-non-rejectable`**（`pMin = 2^(1-m) > 0.0125`，即**无论数据怎么落都不可能拒绝**）；**m ≥ 8 才 `rejectable`**。这是**设计属性**，不是数据结论——套件逐个断言 m=1..7 的标签。

### 4.2 可达性（A-R1-4-1 要求的算术）

`m_disc ≥ 8` 且池有 **12** 个任务 ⇒ **8 ≤ 12 成立**，下限**可达成**。

但**必须同时说明**（否则会被误读为"一定能拒绝"）：`m_disc` 是**不一致对的个数**，需要 8/12 个任务**真的分歧**；若多数任务打平，`m_disc` 就低，此时**结构上不可能拒绝**，只能报 `insufficient`。

### 4.3 功效（条件化于幅值集，非无条件功效分析）

达 80% 功效所需任务数（`minTasksForPower`，精确符号检验）：

| π | 所需任务数 |
| --: | --: |
| 0.70 | 49 |
| 0.75 | 30 |
| 0.80 | **20** |
| 0.85 | 15 |
| 0.90 | **12** |
| 0.95 | 9 |

`π*`（sign-flip，达 80% 功效的最小胜出率）随池大小的**实测**变化：

| m | π* |
| --: | --: |
| 8 | 0.9725 |
| 10 | 0.9167 |
| **12** | **0.8693** |
| 16 | 0.8529 |
| 20 | 0.7987 |

**判读边界（每个数字都要带着它报出）**：

1. 在 **N=12** 下，只有某臂在约 **87%** 的不一致对上占优才可能达常规功效——这是**极强效应**；
2. 12 任务给的是**机制可行性/决策级归因**证据，**不是**生产规模显著性；
3. **禁止**把 `m_disc ≥ 8` 的"结构性可拒绝"读成"已达到功效"；
4. **禁止**把 `not-reject` 读成"等价"（§6）。

---

### 5. holdout 防火墙（双向实测）

| 夹具 | ok | 违规 |
| --- | --- | --- |
| clean（`p2-v3-selection-clean.json`） | **true** | 0 |
| leak（`p2-v3-selection-holdout-leak.json`） | **false** | 1：`holdout-in-selection-artifact` @ `v3-ci-01` |

**双向 = 判别力**：clean 过 **且** leak 必红。只过不红的防火墙等于没装。holdout **只用于最终评估**；选择/调参/早停一律不读（预注册 §4）。

---

### 6. 判读规则（防"把 not-reject 写成等价"）

预注册 §6.1 冻结了判读矩阵，本报告与下游一律按它：

| 观测 | 允许 | **禁止** |
| --- | --- | --- |
| Holm 校正后 p < 0.05 且方向一致 | "在该任务池上观测到可判别的主效应/交互" | "生产规模显著"/"效应很大" |
| p ≥ 0.05 且 `m_disc ≥ 8` | "**未拒绝**零假设" | "**等价**"/"无差异"/"两臂相同" |
| `m_disc < 8` | "**`insufficient`**（结构上不可能拒绝）" | 任何"无差异"表述 |
| 交互秩不足 | "**`undetermined`**" | 猜测方向 |
| 少数任务变差 | "`degraded`"，可与 `insufficient` **并存** | 用总体均值掩盖 |

`pr4a-five-arm-experiment-preregistration.md:597` 也明令禁止把 `d_min=0.809` / `π*=0.869` 说成"已计算并达到功效"——它们是**事先的可检测性上限**。

---

### 7. 为什么四臂没有跑（诚实登记 + 对下游的影响）

| 原因 | 说明 |
| --- | --- |
| 预算/归属 | 跑四臂是**一次五臂实验**，有各自的预算与 V2/V3 产物绑定；本任务的交付物是**设计** |
| 不得造数 | 若在此脚本里"顺带跑一遍"，其输出会被报告当作**实测**引用——那正是 N-10 禁止的"以合成/估算冒充测量" |
| 因此 | 臂级 μ/π 区间、胜/平/负、校正后显著性一律 `not-evaluable`，并**不得**由设计算术（下限、功效、秩）反推 |

**对下游的影响**：t16（验证 R1）与 t13（真实收益）才是跑臂/测收益的地方。t16 应接受"设计可判别 + 臂未跑"，**不得**要求 t10 交出臂级区间；若要求，那属于**扩大 t10 inScope**（需队长裁定）。

---

### 8. 证据索引与复跑

| 文件 | 内容 |
| --- | --- |
| `work/t10/ablation.json` | 本报告全部数字的机读来源（秩、下限、功效、pi*、防火墙、任务表门、臂状态） |
| `scripts/eval/rev6-ablation.mjs` | 复现全部设计事实；`--json` / `--markdown` |
| `docs/reports/rev6-ablation-preregistration.md`（`fc30f7d0…`） | 预注册（先于采样） |
| `tests/unit/eval/rev6-ablation-design.test.ts` | 16 例：排序、无 Arm-5、独立单元、下限与可达性、秩（含三种失败夹具）、功效单调、防火墙、判读词禁、臂未跑 |

```powershell
node scripts/eval/rev6-ablation.mjs --json > work/t10/ablation.json
node scripts/eval/rev6-ablation.mjs                    # 人读摘要，exit 0
node scripts/eval/pr4a-stats.verify.mjs                                            # 0
node scripts/eval/pr4a-stats.verify.mjs --firewall tests/fixtures/p2-l1/p2-v3-split-manifest.json --artifact tests/fixtures/p2-l1/p2-v3-selection-clean.json   # 0
node scripts/eval/pr4a-stats.verify.mjs --firewall tests/fixtures/p2-l1/p2-v3-split-manifest.json --artifact tests/fixtures/p2-l1/p2-v3-selection-holdout-leak.json   # 1
```

---

### 9. 明确没做的事

- 未跑四臂（§7）。
- 未新增 Arm-5、未把 episodes/rounds 当独立样本（N-7）。
- 未改 V2 预注册（`3f2840ff…` 逐字节未动）、`tests/fixtures/pr4a/**`（`48263082…` 未动）、`−0.250` / `deviationStats{36,18,0}` / A1–A6（`check:negative-result` exit 0）。
- 未改 `src/dream-rsi/surrogate-scorer.ts`（`b3bdb635…` 逐字节未动）、未改 rev5 自指夹具（`3dd54b3c…` 未动）。
- 未 commit/push/tag；未写真实记忆；未开 `guarded-active`；未 publish。
- 未把 surrogate 策略上线（shadow only，见 `rev6-surrogate-shadow.md`）。
