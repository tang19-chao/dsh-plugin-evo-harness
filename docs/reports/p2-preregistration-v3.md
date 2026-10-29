# P2-C 预注册 V3：可判别任务表、development/holdout 与统计功效

| 项 | 值 |
| --- | --- |
| **文档类型** | Pre-registered Evaluation Plan, V3（**并列新登记**，不取代 V2） |
| **协议编号** | `P2-V3-EVAL-PREREG-20261029-V3` |
| **状态** | **Sealed before V3 data**：任务表、划分、主要指标、排除规则、停止条件、Holm 族在**任何 V3 评测数字产生之前**冻结 |
| **代码基线** | HEAD `feb8465ded73ca48a770054c587990b93f54e21e`（2026-10-29） |
| **V3 任务表** | `scripts/eval/pr4a-v3-design.mjs`，版本 `v3/tasks-20261029`，digest `sha256:585d030790072ba2fc096d00821e1a2a88bbb0866e91491962ae117fa15a2142` |
| **复算脚本入口** | `node scripts/eval/pr4a-stats.verify.mjs`（全量自检）、`--split`（划分）、`--firewall`（holdout 防火墙）、`--v3-table`（任务表闸门）、`--check-doc`（本文档↔代码绑定） |
| **授权边界** | 零真实付费调用、零发布、零部署、零 commit。全部数字来自离线合成夹具与本地枚举 |

> **阅读顺序**：§0 说明本文件与 V2 的关系（V2 不动）；§1 是冻结清单；§2 是任务表的四道闸门与实测值；§3 是划分与 holdout 防火墙；§4 是"结构上不可拒绝"的可拒绝性下限；§5 是功效与区间覆盖；§6 是报告必填模板；§8 是复核命令与退出码。

---

## 0. 与 V2 的关系：并列新登记，历史帧不动

1. **V2 仍然有效且字节不变**。五臂正交实验的协议 `PR4A-EVAL-PREREG-20261027-V2`（`docs/reports/pr4a-five-arm-experiment-preregistration.md`，blob `47006d2b74a40966193951294b6c8244693f28c9`）继续是**五臂对照**的唯一协议；其引擎（`pr4a-stats.ts` blob `8e67e5d8b5f4be7714686408733cb374cbf29b50`、`pr4a-five-arm-lib.ts` blob `f1dc26dd677fb16958a5ce8fa3ea44620f778a9d`、`jitrl-eval-lib.ts` blob `e313e2eb36a99424fff1e36427c4a959226ac221`）**保持字节不变**，默认语义不改。
2. **V2 的门禁、阈值与标签一律不变**：MMI `+0.10`、NIM `-0.05`、DTS_max `0.25`、宽度门槛 `0.50`、不一致对下限 `8`、精确 McNemar / 符号翻转 / Holm m=4 全部原样；历史负结果（`Δ = -0.250`、胜/平/负 0/7/5、DTS 5/12 等）的数字、标签与解释边界**不改写**。
3. **V3 是新的判别性任务表 + 新的预注册**。V2 任务表的判别性缺陷（12/12 任务的 `required ⊆ prefs[:3]`、oracle 恒为 1）是**表结构**的问题；V3 用 `v3/tasks-20261029` 修复结构，并只在新表上登记新问题。
4. **禁止把 V2 的既有数字重新解释为 V3 的基线**。V2 的 `-0.250` 是 V2 任务表 + V2 协议下的历史观测；V3 的基线只能是 §1 冻结的 `priorCoverage`（由 V3 任务表计算）以及 V3 自己产生的数据。
5. **V3 数据产生之前的禁令**：在本文件登记任务表 digest（§2）之前，任何 `pr4a-v3-replay.mjs` 的运行只能标注为"设计期自检 / 契约验证"，**不得作为结果引用**。

---

## 1. 冻结清单（在任何 V3 数据产生之前）

| # | 冻结项 | 冻结值 | 复算入口 |
| --- | --- | --- | --- |
| F1 | **任务版本** | `v3/tasks-20261029`；digest `sha256:585d030790072ba2fc096d00821e1a2a88bbb0866e91491962ae117fa15a2142`；digestScope = `canonicalDesignBytes()` = `canonicalDesignJson()` + 单个 LF，共 47720 字节 | `node scripts/eval/pr4a-v3-design.mjs --canonical \| sha256sum`；或 `node scripts/eval/pr4a-stats.verify.mjs --v3-table` |
| F2 | **划分规则** | family 级切分；salt `P2-V3-SPLIT-SALT-V1`；hash = `sha256(canonicalJson([salt, family]))` 升序取 family 直到 25% 下限；holdout 份额 ∈ [25%, 50%]；不满足即 **fail-closed**（不静默缩小）。**随机种子：无（不适用）**——划分不含 PRNG，salt 是唯一且已冻结的"种子"；manifest 中不存在 seed 字段 | `node scripts/eval/pr4a-stats.verify.mjs --split` |
| F3 | **主要指标** | 任务级可信验证通过率 VR = (1/L)Σ verified；L=5，N=12；分析单位 = **任务**（轮次/R 不是样本）；主检验按系列型别：全二值 → 精确 McNemar；率型（0,0.2,…,1）→ 精确配对随机化（符号翻转） | `node scripts/eval/pr4a-stats.verify.mjs`（V2 §8.3 自检不变） |
| F4 | **排除规则** | 沿用 V2 §6.4/§8.1.4：`learningEligible=false`（超时/取消/基础设施）只进审计流、不计失败负样本；可用 episode < L 的任务进 `denominator-degraded` 清单；**排除判定只看执行级标志，绝不看结果**；排除谓词在划分之前固定 | 同上 |
| F5 | **停止条件** | 沿用 V2 §10 的执行控制优先级（安全门 → 名义护栏 → 危害停机 → 超时隔离）；V3 新增**预数据可拒绝性审计**（§4）：设计可拒绝性不足的对比在开跑前降级为 diagnostic-only | `node scripts/eval/pr4a-stats.verify.mjs`（floor 表自检） |
| F6 | **Holm 校正族** | 受控族 m=4：θ_write（Δ1-0）、θ_track、θ_gate、θ_int；Holm 步降阈值 α/4、α/3、α/2、α（α=0.05）；探索性族（次要指标、分层、决策点诊断）BH q≤0.10，**与受控族分表**；反例（advice / 单池混估 / random / L1+L2）不入族 | `node scripts/eval/pr4a-stats.verify.mjs`（holmThresholds 自检） |
| F7 | **报告必填结构** | `confidenceIntervals`、`coverage`、`policyChangeRate`、`winsTiesLosses`、`effectSizes`、`power`、`structuralRejectability`、`holdoutFirewall`（八节，缺一即报告不合规） | `checkReportCompleteness()`；见 §6 |
| F8 | **holdout 使用规则** | **单点、单向、不可逆**：holdout 只对开发侧产生的**最终优胜者**做一次检验；holdout **不得**参与调参、候选选择、Pareto 过滤或早停；holdout 结果不回流到任何搜索 | §3 防火墙 + `--firewall` |

> **签核顺序**：F1 的 digest 必须在任何 V3 数据之前写入本文件（本文件即登记）。若任务表在冻结后需要修改，必须 bump version + 新 digest，并**在跑任何数据之前**更新本文件与复算脚本中的常量；否则 `--v3-table` 直接失败。

---

## 2. 任务表冻结闸门（P2-A 判别性）与实测值

任务表由 `scripts/eval/pr4a-v3-design.mjs` 提供（`--json` 稳定键序，LF）。本预注册**不采信其摘要**，而是由 `pr4a-stats.verify.mjs` 独立重算四道闸门：

| 闸门 | 要求 | 独立重算结果 | 判定 |
| --- | --- | --- | --- |
| G1 判别性 | 至少部分任务 `required ⊄ prefs[:3]` | 10/12 任务；share = 0.833333；2 个对照任务为 `prior-saturates`（保留作"天花板可达"对照） | 通过 |
| G2 天花板可测 | oracle 由任务表计算、不全为 1；prior 与 oracle 有非退化差异 | oracle < 1 的任务 6/12（family-blind / mixed，0.50–0.67）；有 headroom 的任务 7/12；priorMean=0.569444、oracleMean=0.805556；oracle 重算与声明值逐个一致 | 通过 |
| G3 支持度 | 每个关键决策点动作数 >1；支持矩阵（决策点 × actionClass）秩 ≥ 2 | 36 决策点 × 14 actionClass；minActionsPerDecisionPoint = 3；**rank = 9**（独立高斯消元重算 = 9） | 通过 |
| G4 字节绑定 | 任务表 digest 可复算且与冻结常量一致 | `sha256:585d030790072ba2fc096d00821e1a2a88bbb0866e91491962ae117fa15a2142`（47720 字节 canonical bytes，含单个 LF） | 通过 |

**任务表版本哈希与冻结时间**：`v3/tasks-20261029` / `sha256:585d030790072ba2fc096d00821e1a2a88bbb0866e91491962ae117fa15a2142`，冻结时间 **2026-10-29（本文件写入时；早于任何 V3 评测数字）**。冻结时的实际文件指纹见 §8。

> **digest 的作用域（必须精确理解）**：digest 是对 **`canonicalDesignBytes()`（任务表内容）** 的 sha256，**不是对 `pr4a-v3-design.mjs` 文件字节**。文件里的注释/格式变化不会改变 digest（这是内容的稳定性）；而 **required / prefs / blind / rounds / 候选形状的任何改动都会改变 digest**（这是冻结的有效性）。因此复核方式是 `--canonical | sha256`（内容），不是对源文件做 `sha256sum`（字节）。
>
> **2026-10-29 复核记录**：`designDigest()`、`sha256(canonicalDesignBytes())`（47720 B）、`node scripts/eval/pr4a-v3-design.mjs --canonical | sha256` 三条独立路径给出**同一个** `sha256:585d030790072ba2fc096d00821e1a2a88bbb0866e91491962ae117fa15a2142`；`--v3-table` 的 `digest === frozenDigest` 且 `ok:true`。任务表文件字节在此后因注释调整发生变化（见 §8.1），但 canonical 内容未变，冻结不失效。

**闸门自身可失败**（否则不是闸门）：`--v3-table` 对"required 全在 prefs[:3]"、"oracle 恒为 1"、"oracle 与重算不一致"、"digest 不匹配"、"空表" 五种输入都会给出 finding；秩检查另有刻意 rank-1 夹具（`rankOneFixture()` → rank 1）。对应单元测试见 `tests/unit/eval/p2-preregistration-v3.test.ts`。

---

## 3. 划分与 holdout 防火墙

### 3.1 划分的冻结内容

| 项 | 值 |
| --- | --- |
| 划分单位 | **任务 family**（同一 family 的全部任务同侧，绝不跨侧） |
| 随机性 | 无。只有 `sha256(canonicalJson([salt, family]))` 的升序 |
| salt | `P2-V3-SPLIT-SALT-V1`（冻结；不复用、不改） |
| 份额边界 | holdout ≥ 25%、≤ 50% 任务数；不满足即 fail-closed |
| 实测划分 | holdout families: ci-fix（`v3-ci-01/02/03`，3/12 = 0.25）；development families: release-gating, schema-migration, test-authoring（9/12 = 0.75） |
| manifest digest | `71cf9b17e8f051a8b53bac8f5825b3fcb64bea961158dc1f5541cd8f8ab00b1d`（canonical JSON，排除 digest 字段本身） |
| 落盘夹具 | `tests/fixtures/p2-l1/p2-v3-split-manifest.json`（自身携带 task→family→side 映射，可自校验） |

划分 manifest 的复算：

```bash
node scripts/eval/pr4a-stats.verify.mjs --split
# -> {"protocolId":"P2-V3-EVAL-PREREG-20261029-V3","salt":"P2-V3-SPLIT-SALT-V1", ... "digest":"71cf9b17..."}
```

### 3.2 "holdout 未参与选择"的可核查证据

1. **构造性证据（metrics-blind）**：划分函数只读 `{id, family}`。单元测试注入 `verifiedRate / reward / policyChangeRate / holdoutPeek` 等诱饵字段后，划分 digest 与无诱饵时**完全相同**（`p2-preregistration-v3.test.ts` 的 "is metrics-blind" 用例）。函数签名层面不存在读指标的路径，因此"用 holdout 调参"在第一步就无法通过这个入口发生。
2. **防火墙命令**：对**喂给候选选择/调参的每一个产物**跑

   ```bash
   node scripts/eval/pr4a-stats.verify.mjs --firewall tests/fixtures/p2-l1/p2-v3-split-manifest.json \
     --artifact work/<selection>.json --artifact work/<tuning>.json
   ```

   任一产物文本中出现 holdout 任务 id ⇒ `ok:false`、退出码 1、violation `holdout-in-selection-artifact`；干净产物 ⇒ `ok:true`、退出码 0。实测：`tests/fixtures/p2-l1/p2-v3-selection-holdout-leak.json`（含 `v3-ci-01`）退出码 1；`tests/fixtures/p2-l1/p2-v3-selection-clean.json`（只含 development id）退出码 0。
3. **manifest 防篡改**：`verifySplitManifest` 对缺失 digest、digest 不匹配、两侧重叠、并集不完整、份额越界、family 被拆开逐一 fail-closed。实测：篡改 holdout 列表后 `digest-mismatch`；删掉 digest 字段后 `digest-missing`。
4. **单点单向**：报告必须记录 holdout 评测的**唯一一次**调用（时间、manifest digest、优胜者 id）与"之后未再读取 holdout"的声明；holdout 结果不得写回任何搜索产物（由 ② 的防火墙在收尾时复查）。

### 3.3 V3 数据来源边界

V3 评测只允许在**本文件登记的 digest** 对应的任务表上产生。若 `--v3-table` 报 `task-table-digest` finding，说明表在冻结后被改过：**停止一切 V3 数字引用**，按 §1 的签核顺序重新冻结（bump version + 新 digest + 更新本文件）。

---

## 4. 可拒绝性下限：何时必须写"结构上不可拒绝"

### 4.1 定义（可计算，不是修辞）

对某个对比，设不一致对数为 `m_disc`（= 胜 + 负）。精确双侧 McNemar（符号检验）在 `m_disc` 上**可能达到的最小 p 值**是所有不一致对同向时的

```text
pMin = 2 * 2^(-m_disc) = 2^(1-m_disc)
```

Holm 族大小 k 下，任何假设可能面对的最严阈值是 `alpha/k`（rank 1）。因此：

- 若 `pMin <= alpha/k`：设计上**有可能**拒绝（是否拒绝取决于数据）；
- 若 `pMin > alpha/k`：**无论数据怎么落，都不可能拒绝** ⇒ 该对比必须标注 **structurally-non-rejectable**（设计属性），**禁止**写成 `not-reject`（数据属性）。

### 4.2 冻结的 floor 表（α = 0.05，双侧）

| m_disc | pMin = 2^(1-m) | family=1（raw 0.05） | family=4（Holm 最严 0.0125） |
| --- | --- | --- | --- |
| 1 | 1 | 不可拒绝 | 不可拒绝 |
| 2 | 0.5 | 不可拒绝 | 不可拒绝 |
| 3 | 0.25 | 不可拒绝 | 不可拒绝 |
| 4 | 0.125 | 不可拒绝 | 不可拒绝 |
| 5 | 0.0625 | 不可拒绝 | 不可拒绝 |
| 6 | 0.03125 | **可拒绝** | 不可拒绝 |
| 7 | 0.015625 | 可拒绝 | 不可拒绝 |
| 8 | 0.0078125 | 可拒绝 | **可拒绝** |
| 9–12 | ≤ 0.00390625 | 可拒绝 | 可拒绝 |

**结论（V3 冻结口径）**：在 Holm 族 m=4 下，`m_disc <= 7` 的对比**结构上不可拒绝**；可拒绝性从 `m_disc = 8` 开始。原始 α=0.05（family=1）下从 `m_disc = 6` 开始。

### 4.3 预注册的措辞规则

| 情形 | 允许的报告写法 | 禁止的写法 |
| --- | --- | --- |
| `pMin > alpha_strictest` | `structurally-non-rejectable`（附 pMin 与 alpha_strictest） | `not-reject`、`无显著差异`、`无效应` |
| `pMin <= alpha_strictest` 且未拒绝 | `not-reject`（附 m_disc、p、区间、功效） | `无效应`、`非劣`、`无退化` |
| 拒绝 | `reject` + 方向 + 效应量 + 区间 | `效应很大`、`生产同样成立` |

**工作示例（本文件冻结）**：12 任务、4 胜 2 负 6 平（m_disc = 6）→ pMin = `0.03125` > Holm 最严阈值 `0.0125` → 标签必须是 **structurally-non-rejectable**，不得写 not-reject。复算：`structuralRejectability(6, {familySize: 4})`。

### 4.4 达到可拒绝所需的最小样本量

**floor 侧**（与真实效应无关，只看设计）：Holm 族 m=4 需要 `m_disc >= 8`；若 `m_disc` 上限本来就是 12，则只有在 ≥8 个任务出现不一致时才有拒绝资格。

**功效侧**（真实胜出率 π，80% 检验力，精确符号检验）：

| π | 原始 α=0.05 需要的不一致对/任务数 | Holm 最严 α=0.0125 需要的不一致对/任务数 |
| --- | --- | --- |
| 0.70 | 49 | 70 |
| 0.75 | 30 | 44 |
| 0.80 | 20 | 31 |
| 0.85 | 15 | **20** |
| 0.90 | 12 | 15 |

即 `minTasks(pi=0.85, alpha=0.0125) = 20`。**因此：12 任务的 V3 套件只回答"机制是否可判别、方向如何"，不回答"生产规模显著"。** 任何"功效已达成"的表述都被禁止；若要做可拒绝的优胜者检验，需把配对任务扩到 ≥20（π≈0.85）或 ≥8 个不一致对（floor）。

---

## 5. 统计功效、区间覆盖与效应量

### 5.1 精确配对随机化（符号翻转）检验的功效

率型主指标用精确符号翻转检验（V2 §8.3.2）。其功效在"固定幅值 + Bernoulli(π) 符号"模型下可**精确枚举**（4096 个符号分配，确定性）：

| 真实单方向胜出概率 π | 精确功效（12 任务，幅值 [0.25,0.25,0.5,0.5,1,1,1,1,1.5,1.5,2,2]） |
| --- | --- |
| 0.70 | 0.2139 |
| 0.80 | 0.464145 |
| 0.90 | 0.796537 |

**pi* = 0.9011**（该幅值集合达到 80% 功效所需的最小胜出概率）。作为一致性自检：当所有幅值相等时，符号翻转检验退化为符号检验，其精确功效必须逐位等于 V2 §8.7 的 0.2530 / 0.5584 / 0.8891（自检通过）。

> **条件化声明（必须随数字一起引用）**：这是**条件功效**——以观测幅值集合为条件；不是无条件功效分析。

### 5.2 Clopper-Pearson 区间的精确覆盖率

"coverage"在 V3 报告里指**区间覆盖率**（与表面覆盖率 surfaceCoverage 同名不同义，报告必须分列）。按二项权重穷举全部可观测结果：

| m | π | 精确覆盖率 |
| --- | --- | --- |
| 12 | 0.5 | coverage(m=12, pi=0.5) = 0.961426 |
| 12 | 0.7 | 0.976669 |
| 12 | 0.9 | 0.995671 |
| 8 | 0.5 | 0.992188 |
| 6 | 0.5 | 0.96875 |

全部 ≥ 0.95（CP 区间保守，符合预期）。`m=12, π=0.5` 的未覆盖结果恰为极端的 `{0,1,2,10,11,12}`。

### 5.3 效应量（定义，不预设符号）

| 量 | 定义 | 备注 |
| --- | --- | --- |
| meanDelta | 任务级配对差均值 | 与 V2 §8.2 同 |
| sdDelta / d_z | sd；d_z = meanDelta / sdDelta | sd=0 时 d_z 记 `null`，不得写 0 |
| wins / ties / losses | 任务级胜平负 | 必须与 m_disc 并列 |
| piHat | wins / (wins+losses) | 附 CP 区间（描述量，**不**用于退化判读） |
| 改选率 | 实际选择 ≠ 先验最高置信动作的决策点比例 | 分母必须是**决策点**（不是任务）；必须写明分母 |

### 5.4 12 任务设计的诚实边界

- `d_min = 0.809`、`π* = 0.869`（二值）与 `π* = 0.9011`（率型幅值集合）都是**事先的可检测性上限**，不是"已达成功效"；
- 12 任务只提供**机制可行性与决策级归因**证据；
- 禁止把不显著读成"无效应"，禁止把显著读成"效应很大"，禁止外推到生产。

---

## 6. 报告必填模板（八节，缺一即不合规）

任何 V3 结果报告必须包含下列结构；`checkReportCompleteness()` 逐字段检查，CLI 可直接调用：

| 节 | 必填字段 | 说明 |
| --- | --- | --- |
| `confidenceIntervals` | meanDelta, lower, upper, method, reproducibleCommand | 精确/随机化反演区间；必须给复算命令 |
| `coverage` | intervalCoverage, surfaceCoverage | 两者分列，禁止混用同名 |
| `policyChangeRate` | value, denominator | 分母 = 决策点 |
| `winsTiesLosses` | wins, ties, losses, discordantPairs | 平/负必须与 m_disc 同表 |
| `effectSizes` | meanDelta, sdDelta, dz | sd=0 时 dz=null |
| `power` | signTestPower, signFlipPower, rejectabilityFloor | 三个数都要，且标注条件化 |
| `structuralRejectability` | label, pMin, alphaStrictest | label ∈ {rejectable, structurally-non-rejectable} |
| `holdoutFirewall` | manifestDigest, checkedArtifacts, violations | 防火墙命令输出 |

报告还必须包含：**"本报告不声明什么"** 小节（外推禁令、功效上限、名义金额）、**holdout 单次调用记录**、以及**任务表 digest**。

---

## 7. 与五臂重跑口径的关系

- **V3 不是五臂的重跑**。五臂对照（Arm-0…Arm-4）仍按 V2 协议与 V2 引擎执行；其可复现运行口径与 L1 机制诊断见 `docs/reports/p2-l1-mechanism.md`。
- **P2-D 机制结论（同一生产内核的对比，夹具侧已复现）**：单动作支持时 **q ≡ V（位级相等）、advantage 恒为 0、KL = 0**；多动作支持且收益有差异时 **KL > 0 可恢复**（beta=0 时为 0，随 beta 严格递增）。两种 KL=0 的成因（支持坍缩 vs 奖励饱和）用 `(supportRank, betweenGroupReturnVariance)` 分离；生产根因仍未测量。详见 `docs/reports/p2-l1-mechanism.md` §2–§3。
- **真实付费模型调用 / 真实宿主 smoke 一律未执行（需授权）**。若未来授权，必须先满足：V3 任务表 digest 已登记（本文件）、holdout 防火墙通过、统计计划未被修改。
- 既有五臂离线对照的复跑口径（离线、零付费）在 `p2-l1-mechanism.md` §5 给出。

---

## 8. 复核命令与实测输出（可复算）

| # | 命令 | 退出码 | 关键输出行 |
| --- | --- | --- | --- |
| C1 | `node scripts/eval/pr4a-stats.verify.mjs` | 0 | `SUCCESS: every pre-registered table and invariant reproduces`；5 行 V2 + 5 行 V3 汇总 |
| C2 | `node scripts/eval/pr4a-stats.verify.mjs --v3-table` | 0 | `"ok": true`，`outsideTop3Tasks: 10`，`supportMatrixRank: 9`，digest = 冻结值 |
| C3 | `node scripts/eval/pr4a-stats.verify.mjs --split` | 0 | `"salt": "P2-V3-SPLIT-SALT-V1"`，`"digest": "71cf9b17..."`，holdout families `["ci-fix"]` |
| C4 | `node scripts/eval/pr4a-stats.verify.mjs --firewall tests/fixtures/p2-l1/p2-v3-split-manifest.json --artifact <clean>` | 0 | `"ok": true` |
| C5 | 同上，`--artifact` 换成含 holdout id 的产物 | 1 | `"kind": "holdout-in-selection-artifact"` |
| C5a | `node scripts/eval/pr4a-stats.verify.mjs --firewall tests/fixtures/p2-l1/p2-v3-split-manifest.json --artifact tests/fixtures/p2-l1/p2-v3-selection-clean.json` | 0 | `"ok": true`（干净的 development-only 产物） |
| C5b | `node scripts/eval/pr4a-stats.verify.mjs --firewall tests/fixtures/p2-l1/p2-v3-split-manifest.json --artifact tests/fixtures/p2-l1/p2-v3-selection-holdout-leak.json` | 1 | `tests/.../p2-v3-selection-holdout-leak.json:v3-ci-01`（实测退出码 1） |
| C6 | `node scripts/eval/pr4a-stats.verify.mjs --check-doc docs/reports/p2-preregistration-v3.md` | 0 | `doc check OK: 12 markers bound to ...` |
| C7 | `node scripts/eval/pr4a-v3-design.mjs --canonical \| sha256sum` | 0 | `585d030790072ba2fc096d00821e1a2a88bbb0866e91491962ae117fa15a2142` |
| C8 | `node node_modules/vitest/vitest.mjs run tests/unit/eval/p2-preregistration-v3.test.ts tests/unit/eval/p2-l1-mechanism.test.ts` | 0 | 全部用例通过（见任务报告） |

### 8.1 冻结时的文件指纹（working tree SHA-256）

| 文件 | sha256 |
| --- | --- |
| `scripts/eval/pr4a-stats.verify.mjs` | `f4b8377701c7636dd30f43249e7d83fc4c10f8b67d6c0c550d3a56218f376bcb` |
| `scripts/eval/pr4a-v3-design.mjs`（2026-10-29 复核时字节） | `ed216d4fae6dcb0a841be04d8428fd4783bccd7655806bb5f14173008ba68e8f`（36998 B；canonical 内容 digest 仍为 `585d0307…`，见 §2 的作用域说明） |
| `tests/fixtures/p2-l1/p2-l1-mechanism-cells.json` | `1750efe0892c76696c78c98c9afcaac6a6b9ad473b3ca3ff990a27b40584a387` |
| `tests/fixtures/p2-l1/p2-v3-split-manifest.json` | `6511b4b986751c2953603f69cc9cad5ddeb069d1a24a955aa5033096b4fea880` |
| HEAD commit | `feb8465ded73ca48a770054c587990b93f54e21e` |
| V2 引擎（git blob） | `pr4a-stats.ts` = 8e67e5d8b5f4be7714686408733cb374cbf29b50；`pr4a-five-arm-lib.ts` = f1dc26dd677fb16958a5ce8fa3ea44620f778a9d；`jitrl-eval-lib.ts` = e313e2eb36a99424fff1e36427c4a959226ac221 |

> 说明：`pr4a-v3-design.mjs` 与夹具在当前工作树中为未跟踪文件（`git status` 的 `??`），因此这里用工作树 SHA-256 固定；正式 blob 指纹须在提交后按 R2 规则用 `git rev-parse <rev>:<path>` 重取。

---

## 9. 签核清单

- [x] F1 任务表版本 + digest + digestScope 已登记（`v3/tasks-20261029` / `sha256:585d0307…`）；
- [x] F2 划分规则（family 级、salt、份额边界、fail-closed）已冻结，manifest digest 已登记；
- [x] F3 主要指标与分析单位（任务轴）已冻结；主检验按系列型别选择；
- [x] F4 排除规则沿用 V2 且先于划分；
- [x] F5 停止条件沿用 V2 执行控制 + V3 预数据可拒绝性审计；
- [x] F6 Holm 族 m=4 与 BH 探索族分表；反例不入族；
- [x] F7 报告八节必填结构已冻结，`checkReportCompleteness()` 可实现检查；
- [x] F8 holdout 单点单向；防火墙命令与豆腐模型（诱饵字段不可影响划分）已实测；
- [x] 可拒绝性下限：`pMin = 2^(1-m)`；family=4 时 `m_disc <= 7` 一律 `structurally-non-rejectable`；
- [x] 功效/覆盖/最小样本量全部给出可复算命令与实测输出；
- [x] V2 门禁、阈值、标签不变；V2 数字不被重新解释为 V3 基线。

---

## 10. 授权申请（未执行项）

以下动作**未执行（需授权）**，本文件只登记申请文本：

> 申请对 V3 任务表 `v3/tasks-20261029`（digest `sha256:585d0307…`）执行**真实付费模型**的五臂/单臂评测：范围 = 12 任务 × L=5 × R=3，单次预算上限与 provider/费率卡另行确认；执行前复核 holdout 防火墙（C4/C5）与统计计划未修改；执行后只产生 V3 报告，不回写 V2 历史数字。

未获授权前，V3 的一切数字只能来自离线合成夹具与本地枚举，且报告必须标注 `not-run (requires live API grant)`。
