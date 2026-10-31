# P7 / P3 评测复检报告（rev5 t12：P3-1 / P3-2 / P3-3）

- 任务：`evo-harness-rev5` / t12（P3 可判别评测工程师）
- 基线：`97e38db37305b24f695a5f989428b3611f84987c`（G12：未提交、未推送）
- 冻结输入：`tests/fixtures/pr4a/pr4a-five-arm-eval.json`（sha256 `f22bdb14…c55acb`，365 314 B）
- 判据来源：`docs/reports/p2-preregistration-v3.md`（F6 族划分）、`docs/reports/pr4a-five-arm-eval-report.md`（V2 冻结结果，G7）、`docs/NEGATIVE-CONTROL-RUNBOOK.md`
- 复跑命令：
  - `pnpm exec vitest run tests/unit/eval/pr4a-v2-discriminability-recheck.test.ts`
  - `pnpm exec vitest run tests/unit/dream-rsi/surrogate-self-reference.test.ts`
  - `pnpm exec vitest run tests/unit/eval/p3-cacheread-gating.test.ts`
  - `node scripts/eval/pr4a-stats.verify.mjs`

> **本轮不做新采样。** C-6 规定新增重复采样必须先修订预注册；t12 只复检**已冻结**的 V2 结果，不新增 Arm-5，不改判据，不改冻结字节。

---

## 1. P3-1：2×2(+1) 可判别性复检（同预算多采样、holdout 不入选择）

### 1.1 设计事实（从冻结产物独立读出）

| 项 | 冻结值 | 复检证据 |
| --- | --- | --- |
| 臂 | `Arm-0`…`Arm-4`（2×2 + 冻结参照），**无 Arm-5** | 测试断言 `design.arms` 恰为 5 个 id，且原始字节不含 `Arm-5` |
| 因子编码 | track ∈ {process, task-quality} × gate ∈ {off, on}；`Arm-0` 仅作参照，不进入主效应/交互估计 | `design.arms` 的 `role/track/conservativeGate/writesBack`；`Arm-0` 是唯一 `role=reference` 且 `writesBack=false` |
| 同预算 | 每臂共享**同一**设计：5 episodes × 3 rounds × 12 tasks = **180 行/臂** | `design.episodes=5, rounds=3, tasks=12`；5 个冻结 ledger 各 180 行 |
| 探索额度 | `explorationAllowance = 0`（分析期不允许按指标换任务） | `design.explorationAllowance` |
| 重复性口径 | `effectiveReplication = 1.3333 < episodes = 5`；`roundsAreNotSamples = true`；分析单元 = task（N=12） | `replication` / `declarations` |

**同预算多采样对照的含义**：12 个任务 × 每臂 5 episode × 3 round 的采样预算在五臂之间完全一致（180 行/臂），因此臂间差异不能归因于采样量不同；同时冻结声明明确 5 个 episode **不是** 5 个独立观测（`effectiveReplication=1.3333`），主检验按任务配对的精确随机化（符号翻转），不按 episode 膨胀样本量。

### 1.2 holdout 不参与选择

| 检查 | 结果 |
| --- | --- |
| V3 冻结划分（`computeV3Split`，committed task table） | holdout 家族 `ci-fix`，份额 **0.25**，development **0.75** |
| development ∩ holdout | **∅**（逐个 id 断言）；dev ∪ holdout = 全部任务 |
| 冻结划分摘要 `splitManifestDigest` | `71cf9b17e8f051a8…`（与 stats-verify 输出一致，可复算） |
| 冻结产物本身过 holdout 防火墙 | **clean**（`ok: true`，无 violation）——产物中不含任何 holdout id |
| 泄漏反例（把 holdout id 塞进选择集工件） | **被捕获**：`holdout-in-selection-artifact`，指名 `v3-ci-01` |

> 该检查是双向的：干净输入必须绿、植入泄漏必须红；只测一边等于没测（与 `docs/NEGATIVE-CONTROL-RUNBOOK.md` 的「同一门禁必须双向跑」一致）。

### 1.3 四个前定估计量：点估计、胜/平/负、p、CI（独立复算）

复检**不读** `comparisons.controlled` 的统计量，而是从 `pairwiseTable` 的逐任务两两 Δ 以 `Arm-0` 为参照还原五臂取值，再按冻结标签重算四个估计量：

- `θ_write = Arm-1 − Arm-0`
- `θ_track = ½[(Arm-3−Arm-1) + (Arm-4−Arm-2)]`
- `θ_gate = ½[(Arm-2−Arm-1) + (Arm-4−Arm-3)]`
- `θ_int = (Arm-4−Arm-3) − (Arm-2−Arm-1)`

重算序列与 `controlledSeries.rowss` 逐格一致（最大残差 ≤ 1e-12）。

| 估计量 | n | 均值差 | sd | 胜/平/负 | m_disc | 精确符号翻转 p | Holm 调整 p | CP 95% 区间（不一致对胜率 π） | 随机化反演区间（μ 的 0.005 网格） | 带宽 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| write-back | 12 | −0.1667 | 0.267423 | 0/8/4 | 4 | 0.1250 | 0.3750 | [0, 0.602365] | [−0.350, 0.000]（321 点） | below-NIM |
| track | 12 | 0.1667 | 0.249848 | 5/7/0 | 5 | 0.0625 | 0.2500 | [0.478176, 1] | [0.000, 0.325]（321 点） | above-MMI |
| gate | 12 | ≈0（−4.6e−18） | 0.073855 | 2/9/1 | 3 | 1.0000 | 1.0000 | [0.094299, 0.991596] | [−0.050, 0.040]（201 点） | within-band |
| interaction | 12 | ≈0（9.3e−18） | 0.147710 | 1/9/2 | 3 | 1.0000 | 1.0000 | [0.008404, 0.905701] | [−0.080, 0.100]（201 点） | within-band |

独立复算实现：

- **p**：只对不一致对（`|d|>1e-9`）枚举 2^m 个符号分配，取 `|Σ| ≥ |Σ_obs|` 的比例；与冻结 `signFlipPatterns=2^12`（平局对称折叠，p 等价）和 `pPrimary/pRaw/pSignFlip` 全部一致。
- **CP 区间**：对不一致对胜率做 Clopper–Pearson 反演（`lower` 解 `P(X≥w)=0.025`，`upper` 解 `P(X≤w)=0.025`），与冻结 `exactInterval` 6 位一致。**注意**：CP 区间是 π（胜率）的区间，**不是**均值差 μ 的区间；μ 的区间只能读 `randomizationInterval`（已按冻结复跑命令用 `scripts/eval/pr4a-stats.ts` 重跑，逐点一致）。
- **Holm**：对 4 个主检验 p 做步降 + 单调化：`0.0625→0.25`、`0.125→0.375`、其余 `1`；**四行全部不显著**（`significantAfterCorrection=false`）。

### 1.4 共线披露（复检必须同口径读出）

| 事实 | 复检值 |
| --- | --- |
| 质量臂在**每个**任务上等同冻结参照（Arm-3 ≡ Arm-4 ≡ Arm-0） | 是（逐任务两两 Δ 均为 0） |
| `θ_track` 与 `θ_write` 的序列相等 | 否（不是本轮退化形式） |
| 恒等式 `θ_track = −(θ_write + θ_gate)` | 成立，最大残差 **0** |
| `θ_int` 可识别性 | **不可识别**（质量行两格相同）→ 只能报 `undetermined` |

> 因此 `θ_track` 的 `above-MMI` 带**不得**读作「轨道因子正向效应」；它完全由另外两个对比决定（秩亏）。`not-reject` 也**绝不**等于「无效应」：write-back 一行同时是 `degraded` 与 `insufficient`，四维元组原样保留。

### 1.5 预注册指标与功效（唯一可引用的功效来源）

`declarations`（冻结产物）钉住：`minDetectableD = 0.8087`、`minDetectableWinRate = 0.8693`，并声明 `powerIsClosedFormApproximation` = 「闭式正态近似，**不是**已执行的功效分析」。`node scripts/eval/pr4a-stats.verify.mjs` 复跑输出（exit 0）：

```
[pr4a-stats] SUCCESS: every pre-registered table and invariant reproduces
  §8.7   power curve       : 5/5 rows, pi*=0.869, d_min=0.809
  V3 rejectability floor   : family=4 rejects only from m_disc>=8 (pMin = 2^(1-m))
  V3 exact sign-flip power : pi*=0.9011 (12 tasks, heterogeneous magnitudes)
  V3 exact CP coverage     : >= 0.95 at every pinned point (12/0.5 -> 0.961426)
  V3 frozen split          : holdout=ci-fix share=0.25 digest=71cf9b17e8f051a8...
```

**功效读法（诚实口径）**：本轮观测到的最大不一致对数为 `m_disc=5`，而族大小 4 的可拒性下界是 `m_disc ≥ 8`（`pMin = 2^(1-m)`），所以四行在结构上**本轮不可拒**——这不是「效应为零」，而是「样本量不足以判别」。复检不把 `p=1` 读成等价性，也不把 `above-MMI` 读成正向证据。

### 1.6 补充族（BH FDR，m=10）

10 个两两 Δ 的 n/均值/胜平负/m_disc/p 从各自 `perTask` 独立重算一致；BH q 重算一致（`0.2083/0.2083/1/1/1/0.2083/0.2083/0.2083/0.2083/1`）。两族**分表、永不合并**：受控族 Holm（m=4）只用于四个前定估计量，补充族 q 值**不得**支撑任何五臂结论（`familySeparation.rule` 原文：`never merged`）。三条退化行（`Arm-0−Arm-3`、`Arm-0−Arm-4`、`Arm-3−Arm-4`，`m_disc=0`）的 `[0,0]` 区间是退化输出，不是精度证据。

### 1.7 P3-1 结论

1. **可判别性未建立**：四个前定估计量在 Holm 后全部 `not-reject`，且 `m_disc ≤ 5 < 8` 结构性不可拒；write-back 方向为负但不足以判退化，track 的 `above-MMI` 因秩亏不可读作正向证据，interaction 不可识别。
2. **同预算成立**：180 行/臂，`explorationAllowance=0`，`effectiveReplication=1.3333` 明确「重复不是样本」。
3. **holdout 未参与选择**：防火墙对冻结产物 clean、对植入泄漏 red。
4. **差值 CI 已给**：CP（π）+ 随机化反演（μ）两套区间分列，且明确各自语义；胜/平/负逐行给。
5. **预注册指标/功效已复跑**：`pi*=0.869`、`d_min=0.809`、`m_disc≥8`、`π*=0.9011`；本轮结论受「N=12 判据」约束，不越权宣称。

---

## 2. P3-2：surrogate 自指检验（Composer 判错但可验证结果相反）

### 2.1 反例构造（测试可复跑）

| 节点 | Composer 判定 | 可验证结果（独立检查） | steps | toolErrors/toolCalls | 归一信号 |
| --- | --- | --- | --- | --- | --- |
| `n-composer-pick` | **选中**（selected=1，adoption=1.0） | deliverable 含 `FAIL` → **不通过** | 18 | 3/6 | selected=1, adoption=1, eff=11/19≈0.5789, err=0.5 |
| `n-verified` | 未选中（selected=0，adoption=0） | deliverable 含 `PASS` → **通过** | 5 | 0/6 | selected=0, adoption=0, eff=1.0, err=0 |

「可验证结果」是测试内一个**只读 deliverable 内容**的谓词（不读 Composer、不读 surrogate 信号），所以它是证据而不是另一种意见。

### 2.2 两种权重下的排名

| 权重 | `n-composer-pick` | `n-verified` | 排名 |
| --- | --- | --- | --- |
| 冻结默认 `(0.4, 0.3, 0.2, 0.1)` | **0.7658** | 0.2000 | **Composer 错选在前**（自指） |
| 去 w1/w2（`(0, 0, 0.2, 0.1)` 归一化为 `(0, 0, 2/3, 1/3)`） | 0.2193 | **0.6667** | **证据正确的节点在前**（翻转） |

**载荷性反例（负控制）**：当两个候选在证据上相同（同 steps、同 toolErrors、同 deliverable 通过），仅 Composer 选中不同时，去 w1/w2 后两分数精确相等（差 0），排名**不翻转**。这证明 2.2 的翻转来自「可验证差异」（效率/工具错误），而不是「删权重就会换名次」的算术——即该审计手段是**证据门控**的。

### 2.3 证据 → 调整（只基于证据调整）

| 证据（可验证、与 Composer 无关） | 观测 | 允许的调整 | 不允许的调整 |
| --- | --- | --- | --- |
| Composer 选集与 deliverable 校验冲突 | 选中节点 FAIL、未选节点 PASS | 记录「self-reference 冲突」，在复盘中以证据排序为准 | 直接改 Composer 输出、改默认权重去「修」排名 |
| 去 w1/w2 排名与证据一致 | 翻转 | 把「去 w1/w2 排名」当作审计信号，与证据交叉验证后采纳 | 把去 w1/w2 的排名本身当证据（无证据时会平票，不翻转） |
| 冻结默认权重 | `(0.4, 0.3, 0.2, 0.1)`，`DEFAULT_SURROGATE_WEIGHTS` 与 `config.ts` 默认一致 | 保持默认不变；诊断只在报告层 | 静默改默认权重、改 `normalizeSurrogateWeights` 的兜底 |
| 分数夹紧 | 对抗权重 `(5,5,0,0)` 归一化后分数仍 ∈ [0,1] | 保持 clamp 契约 | 用未夹紧分数做比较 |

**结论**：全权重 surrogate **会复现** Composer 的错选（自指）；`w1/w2` 正是自指通道（占分 0.7）；去掉它们后的排名与可验证证据一致，且在没有证据差异时不会翻转——因此「去 w1/w2 排名 + 证据校验」是可复跑的判别手段，而不是新的拍脑袋规则。默认权重与 clamp 契约未被改动。

---

## 3. P3-3：cacheRead 消融 —— **gated / not-applicable**（不伪造 A/B）

### 3.1 前提事实（冻结产物）

| 检查 | 结果 |
| --- | --- |
| 五臂 `cacheReadTokens` | 全部 `{tokens: 0, precision: "estimated"}` |
| 五臂 `cacheWriteTokens` / `totalTokens` | 全部 `estimated`；`estimator` 明确「ESTIMATED, never measured」 |
| 计量能力（cost） | 每臂 `measured.count = 0`、`measured.share = 0`；`estimated = 180/180`；`liveCalls = 0`；`incurredRealUsd = 0` |
| 冻结产物是否含 cacheRead 对照 | 否（`comparisons` 序列化后不含 `cacheRead`） |
| 文档口径 | 报告 §9.3：`cacheReadTokens` = `estimated`，「never measured」；`docs/reports/p6-pareto-budget.md:180`：无实测 `cacheRead` ⇒ **本轮不评估、不声明任何 prefix cache 影响**；`:327` R5 = **未评估（无实测流）** |

### 3.2 门禁（三向可判别，测试 `tests/unit/eval/p3-cacheread-gating.test.ts`）

`cacheReadAblationGate` 只在同时满足 ①`precision="measured"` ②存在配对观测且至少一个任务实测下降 ③不一致对精确符号检验 `p ≤ 0.05` 时返回 `applicable`；否则返回

- `gated-not-applicable`（无观测 / 估计值 / 无配对）；
- `measured-no-significant-reduction`（实测但未显著）。

| 输入 | 输出 | 语义 |
| --- | --- | --- |
| 冻结产物（无实测流） | `gated-not-applicable` | 本轮不评估 |
| 合成「实测 + 显著下降」 | `applicable` | 门禁**能开**（未来有实测流即可评估） |
| 合成「实测 + 不显著」 | `measured-no-significant-reduction` | 实测也不得宣称下降 |
| 合成「估计值 + 看似大幅下降」 | `gated-not-applicable` | 估计值不能开门 |

### 3.3 结论

**P3-3 = gated / not-applicable。** 没有实测 cacheRead 流，本轮**不产生**任何 cacheRead A/B、差值或「缓存收益」声明；门禁是双向/三向可判别的（能开、能拒、能区分「实测但不显著」），不是把「没做」写成「无效应」。未来若出现实测流，只需把带 `precision:"measured"` 的配对观测喂给同一函数即可开门，无需改报告口径。

---

## 4. 交付物与复跑

| 交付 | 路径 |
| --- | --- |
| P3-1 独立复检（18 例） | `tests/unit/eval/pr4a-v2-discriminability-recheck.test.ts` |
| P3-2 自指反例（8 例） | `tests/unit/dream-rsi/surrogate-self-reference.test.ts` |
| P3-3 cacheRead 门禁（8 例） | `tests/unit/eval/p3-cacheread-gating.test.ts` |
| P3-4 结构债门禁 | `tests/unit/eval/structural-debt-gate.test.ts`（见 `p7-p3-structural-debt-closeout.md`） |

```
pnpm exec vitest run tests/unit/dream-rsi tests/unit/eval
node scripts/eval/pr4a-stats.verify.mjs
```

**未做（明确边界）**：未新增采样（C-6）、未新增 Arm-5、未改预注册阈值/权重默认值、未改冻结 fixture 字节、未声称任何等价性或 cacheRead 收益。
