# rev6 R1-3 / R1-4 预注册：surrogate 去自指策略 + 可判别 2×2(+1) 消融

- **任务**：rev6 `t10`（R1-3 surrogate shadow + R1-4 可判别实验）
- **本文件写于任何 rev6 采样之前**。冻结顺序的机器判据见 §9（脚本会回报本文件 sha256 与首次采样时刻）。
- **冻结的历史基线（只读，不可改）**：`docs/reports/p6-fair-eval.md` 的 `C3-online − C3-frozen` verifiedRate 均值差 **−0.250**；`docs/reports/pr4a-five-arm-experiment-preregistration.md`（V2，`3f2840ff…`）与 `tests/fixtures/pr4a/**`（manifest `48263082…`）**逐字节不动**（G7/G14/N-6）。
- **本文件只新增版本与数据**；不改写上述任一数字或产物。

---

## 0. 与 rev5 V2 的关系（先说清楚，避免误读为"重写预注册"）

V2 是**已封存**的五臂协议。本轮**不修订、不覆盖**它。本文件是一个**新的、独立的**预注册，只做两件事：

1. **R1-3**：给 surrogate 的自指缺陷一个**可判别的替代策略**，并在 **shadow** 中验证它；**默认权重与 clamp 一个字节都不动**。
2. **R1-4**：设计一个**新的**消融，使它**在设计上有机会**达到族大小 4 的 `m_disc ≥ 8`；沿用 V2 的**因子语义**（`track × gate`），**不新增 Arm-5**。

两者的产物都是新文件；V2 的五臂语义与臂号（`Arm-0`…`Arm-4`）**原样继承**。

---

## 1. 假设（先于采样写死）

### 1.1 R1-3（surrogate）

| # | 假设 | 判据（可执行） |
| --- | --- | --- |
| **S-H1** | 在"Composer 判错、verifier 相反"的冲突反例上，**去自指策略**不再把可验证通过排到可验证失败之后 | 冲突夹具下 `verified(fail)` 的 score **<** `verified(pass)` 的 score（严格），且排序与 verifier 一致 |
| **S-H0** | 该翻转可能只是"删了权重"的算术副作用，而非证据驱动 | **负控制**：两候选**证据相等**时策略**不翻转**（分数差 ≤ ε，排序保持输入序） |
| **S-H2** | 策略的收益只在**可验证信号存在时**才可计入 | 无 verifier 时策略退化回默认行为（`I(H*)` 不被伪造） |

**两种候选策略（按契约 §5.5 Do.1 的比较对象）**：

- **策略 A「可验证信号权重下限」**：给 `efficiency` / `toolErrorPenalty`（可验证侧）设权重下限，把 `selection`/`adoption`（Composer 侧）挤到剩余份额。
- **策略 B「仅在可验证时计 `I(H*)`」**：`I(H*)`（即 `selected`）**只在**该节点带有可验证 verdict 时计入；否则该 term 恒 0。

**选哪一个由 shadow 数据决定，不由实现偏好决定**：报告给出两者的冲突夹具判别力与负控制表现，并明确哪个被选为 shadow 候选、哪个被否决（§4）。

### 1.2 R1-4（消融）

沿用 V2 的 2×2 因子设计（`track ∈ {process, task-quality}` × `gate ∈ {off, nEff}`），`Arm-0` 为冻结参照（**不是因子格**，只锚定 `Arm-1 − Arm-0` 的写回效应）。

| # | 假设 | 判据 |
| --- | --- | --- |
| **A-H1** | `gate` 主效应在 `task-quality` 轨上可判别 | 配对差值的 95% 区间与 Holm 校正后的显著性 |
| **A-H2** | `track` 主效应可判别 | 同上 |
| **A-H3** | `track × gate` 交互**可识别**（不共线） | 设计矩阵秩 = 4/4（§5.3 实测） |

**零假设必须写出来**：主效应/交互均**可能不可判别**。设计只保证"有机会"，不保证"一定成立"。

---

## 2. 冻结的任务池与因子

| 项 | 冻结值 | 依据 |
| --- | --- | --- |
| 任务池 | **V3 设计池 12 任务**（`scripts/eval/pr4a-v3-design.mjs`，`V3_DESIGN_VERSION='v3/tasks-20261029'`） | 该池是**为可判别性设计的**：`requiredOutsideTop3Share=0.833`（10/12 任务的必需面落在 proposer 前 3 之外）、`priorMeanCoverage=0.569` vs `oracleMeanCoverage=0.806`（headroom 0.236） |
| rounds | 3 | `V3_ROUNDS` |
| 决策点 | 36（12 任务 × 3 轮） | `designSummary().supportMatrix.decisionPoints` |
| 每日决策候选数下限 | ≥3（实测 `minActionsPerDecisionPoint=3`） | 保证每格至少有一次真实选择 |
| 臂 | `Arm-0`…`Arm-4`，**共 5 个，无 Arm-5** | V2 §3.1 语义 |
| 因子 | `track`（process / task-quality）× `gate`（off / nEff） | V2 正交性：相邻格只差一个因子 |

**为什么用 V3 池而不是 V2 的 12 任务池**：V2 池"每个任务的必需面都是 `prefs[:3]` 子集、table oracle 恒 1、prior 恒 1"，因此**先验与 oracle 无法分开**——这正是 V2 池不可判别的原因（`pr4a-v3-design.mjs:8-18` 的自述）。选 V3 是为了让"有机会判别"成为**设计属性**，不是运气。

---

## 3. 独立分析单元与样本量（这是本轮最容易出错的地方）

| 项 | 冻结口径 |
| --- | --- |
| **独立分析单元** | **任务**（12 个）。**`episodes` 与 `rounds` 不是独立样本**（N-7 明令禁止） |
| 配对单位 | 同一任务、同一协议下的**臂间配对差** |
| 可用最大 `m_disc` | **≤ 12**（不一致对数不可能超过任务数） |
| 族大小 | **4**（两个主效应 + 交互 + 一条写回对比之外的受控对比；Holm 阈值 `[0.0125, 0.016667, 0.025, 0.05]`） |
| 结构性下限 | **`m_disc ≥ 8`** 才可能被 Holm 校正后拒绝（`2^(1-m) ≤ 0.05/4`；实测 `minDiscordantForRejectability({familySize:4}) = 8`） |

### 3.1 功效（诚实声明：**闭式/精确枚举，不是已执行的功效分析**）

用冻结验证器 `scripts/eval/pr4a-stats.verify.mjs` 的导出函数实测（`work/t10/probe-design.cjs`）：

| 真实单方向胜出概率 π | 达 80% 功效所需任务数（`minTasksForPower`） |
| --: | --: |
| 0.70 | 49 |
| 0.75 | 30 |
| 0.80 | **20** |
| 0.85 | 15 |
| 0.90 | **12** |
| 0.95 | 9 |

在**本池 N=12** 下，sign-flip 检验的 `π*`（达 80% 功效的最小胜出率）：

| m（全部不一致） | π* |
| --: | --: |
| 8 | 0.9725 |
| 10 | 0.9167 |
| **12** | **0.8693** |
| 16 | 0.8529 |
| 20 | 0.7987 |

**结论边界（必须随每个数字一起报出）**：

1. N=12 时**只有**某臂在约 **87%** 的不一致对上占优才可能达到常规功效——这是**极强效应**；
2. 12 任务提供的是**机制可行性与决策级归因**证据，**不是**生产规模显著性；
3. **禁止**把 `m_disc≥8` 的"结构性可拒绝"读成"已达到功效"；
4. **禁止**把 `not-reject` 读成"等价"（见 §6）。

**因此本设计的"足以争取 m_disc≥8"是如下可复核的算术事实**：族大小 4 的下限是 8，而池有 12 个任务，故 **8 ≤ 12 成立**（`floorReachableAtN12 = true`）；但**能否真的拿到 8 个不一致对，取决于两臂是否真有分歧**——若多数任务打平，`m_disc` 就低，此时必须报 `insufficient`，**不得**报等价（§6）。

---

## 4. holdout 防火墙（选择阶段完全不可读）

| 项 | 冻结口径 |
| --- | --- |
| holdout 用途 | **只用于最终评估**；选择/调参/早停**一律不得读取** |
| 选择输入 | 仅 train 分区 |
| 双向判别力判据 | clean 夹具 exit **0** / leak 夹具 exit **1**（`pr4a-stats.verify.mjs --firewall …`） |
| 违反即失败 | 任何在 selection 阶段读取 holdout 的实现，结果作废 |

---

## 5. 可识别性与共线（先算，不事后解释）

### 5.1 设计矩阵（4 列，4 格）

| 格 | intercept | main:track | main:gate | interaction |
| --- | --: | --: | --: | --: |
| Arm-1 (process, off) | 1 | 0 | 0 | 0 |
| Arm-2 (process, on) | 1 | 0 | 1 | 0 |
| Arm-3 (quality, off) | 1 | 1 | 0 | 0 |
| Arm-4 (quality, on) | 1 | 1 | 1 | 1 |

**秩 = 4 / 4**（`matrixRank` 实测，见 §9 脚本输出）。⇒ 两个主效应与交互**各自可单独估计**，不存在共线。

### 5.2 若秩 < 4 怎么办（预先写死的处置）

若将来任务丢失或格缺失导致秩不足，**该效果必须标 `undetermined`**，不得用"看起来合理"的解读替代。`undetermined` 不是失败，是**设计事实**。

### 5.3 支撑矩阵

`buildSupportMatrix(V3_TASKS, 3)` 的秩与覆盖由设计脚本输出；任一决策点候选数 < 3 即视为该格不可判别。

---

## 6. 终点、区间、校正与判读规则

| 项 | 冻结口径 |
| --- | --- |
| 主要终点 | 任务级 `verifiedRate`（二值：该任务是否 verified 通过） |
| 副终点 | `meanCoverage` |
| **μ 区间** | 配对 t，双侧 95%，样本 SD；同时报 bootstrap(10,000, seed 固定) 的 2.5/97.5 分位 |
| **π 区间** | 不一致对的胜出比例的**精确** Clopper–Pearson 区间（`exactIntervalCoverage`），**不与 μ 区间混用** |
| 胜/平/负 | 逐对统计，`|Δ| ≤ 1e-9` 记平 |
| 多重校正 | **Holm–Bonferroni**，族大小 4，阈值 `[0.0125, 0.016667, 0.025, 0.05]` |
| α | 0.05 双侧 |
| 停止规则 | 单次运行；**无**中途查看、**无**序贯停止、**无**补采样凑结果 |

### 6.1 判读矩阵（防"把 not-reject 写成等价"）

| 观测 | 允许措辞 | **禁止**措辞 |
| --- | --- | --- |
| Holm 校正后 p < 0.05 且方向与预注册一致 | "在该任务池上观测到可判别的主效应/交互" | "生产规模显著"、"效应很大" |
| p ≥ 0.05 且 `m_disc ≥ 8` | "**未拒绝**零假设（数据不支持差异）" | "**等价**"、"无差异"、"两臂相同" |
| `m_disc < 8` | "**`insufficient`**：结构上不可能拒绝" | 任何"无差异"表述 |
| 交互秩不足 | "**`undetermined`**" | 猜测方向 |
| 少数任务变差 | "`degraded`"，可与 `insufficient` **并存** | 用总体均值掩盖 |

**`not-reject` ≠ 等价**：前者是"没有足够证据说不同"，后者是"证明了相同"。本预注册只允许前者。

---

## 7. 负控制（必须出现在报告中）

| NC | 变异 | 期望 |
| --- | --- | --- |
| NC-1 | 冲突夹具：Composer 选错、verifier 相反 | 去自指策略**不再**让可验证失败领先（严格） |
| NC-2 | **证据相等**夹具（同 steps/同 toolErrors/同 verdict） | 策略**不翻转**（分数差 ≤ ε，顺序不变） |
| NC-3 | 无 verifier 的轨迹 | `I(H*)` 不被计入（策略 B）或退化回默认（策略 A），**不得**凭空给分 |
| NC-4 | `DEFAULT_SURROGATE_WEIGHTS` 与 clamp | **逐字段等于** `(0.4, 0.3, 0.2, 0.1)` 与 `[0,1]`，默认路径行为不变 |
| NC-5 | holdout leak 夹具 | 防火墙 exit 1 |

---

## 8. 明确不做（授权边界）

- 不改 `DEFAULT_SURROGATE_WEIGHTS`、不改 clamp、不改 `scoreSurrogate` 的默认路径（A-R1-3-2）。
- 不新增 Arm-5、不把 `episodes`/`rounds` 当独立样本（N-7）。
- 不改 V2 预注册、`pr4a-*` 报告与 `tests/fixtures/pr4a/**`（G7/G14/N-6）。
- 不改 `−0.250` / `deviationStats{36,18,0}` / A1–A6。
- 不 commit / push / tag（N-1）；不写真实记忆（N-2）；不开 `guarded-active`（N-3）；不 publish（N-4）。
- 不把 surrogate 策略**上线**（ships OFF / shadow only）；推广是队长的裁定。

---

## 9. 冻结顺序的可证判据

`node scripts/eval/rev6-ablation.mjs --json` 必含：

```
preregistration: { path, sha256, mtimeMs }
firstSampleAtMs
preregisteredBeforeFirstSample   // === mtimeMs <= firstSampleAtMs
design: { rank, fullRank, familySize, floor, piStarAtPool, tasksForPower }
```

判据：`preregisteredBeforeFirstSample === true`，且本文件 sha256 在结果报告中逐字符出现。为 false 则整个 R1-4 作废。

**本文件 sha256：落盘后由脚本计算并写入报告，不在本文件内自指。**

---

## 10. 失效条件

出现任一条即失效，需新版本 + 新 sha256（旧版保留）：

1. 任务池增删或 `V3_DESIGN_VERSION` 变化；
2. 因子语义、臂号或 Arm-0 的参照角色变化；
3. 主要终点、区间方法、α、Holm 族大小、`m_disc` 下限任一变化；
4. 策略 A/B 的判据或 NC 集合变化；
5. 采样开始后修改本文件。
