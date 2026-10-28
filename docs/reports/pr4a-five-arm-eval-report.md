# PR-4A 五臂正交实验结果报告（离线）

> **本报告由 `scripts/eval/eval-pr4a-five-arm.mjs` 自动生成，不含手工编辑的数字。**
> 协议：`PR4A-EVAL-PREREG-20261027-V2`，代码基线（commit 对象）：`84a3d828ed2a27eef765c8b9c4950da4a9ee7287`。
> 零真实付费调用、零发布、零部署；全部数字来自离线合成夹具与宿主自有本地验收器。

| 项 | 值 |
| --- | --- |
| 生成时间 | `2026-10-27T18:12:14.801Z` |
| 协议 | `PR4A-EVAL-PREREG-20261027-V2` |
| 代码基线（commit 对象） | `84a3d828ed2a27eef765c8b9c4950da4a9ee7287` |
| 工作树是否脏 | **是（本 PR 未提交）** |
| `trackedWorkspaceDigest`（已跟踪脏文件摘要） | `3d412db6bee9784617808f03353de132c3587f3c30d8ea22d61b43761f01f63e` |
| `executedSourcesDigest`（实际执行代码摘要） | `5011b4691451f487306edcd9837be837bdcd2849d96fba930e1e2db830e39a7c` |
| 任务数 N（配对单位） | 12 |
| 每任务执行 L | 5 |
| 每执行深化轮 R | 3 |
| 有效重复 `effectiveReplication` | **1.3333**（按实测唯一值推导，不是常数 L） |
| 探索额度（五臂固定） | 0 |
| 主指标 | 宿主 runner 判定 `hostVerdict`（§6.1）——不是覆盖率自评 |
| 真实付费调用 `liveCalls` | **0** |
| 真实支出 `incurredRealUsd` | **0.00** |
| 分析单位 | task (N=12) |

### 0.1 代码可定位性（本报告由哪一份代码产生）

仅有 commit SHA **不足以**定位真实执行代码：本 PR 的全部改动仍在工作树中（未提交）。因此本节给出三重指纹。

- `git describe --always --dirty`：`84a3d82-dirty`
- 已跟踪且与 HEAD 不同的文件数：**30**
- 摘要算法：`sha256`（每次手工改动都会改变下列任一枚举值）
- 实际执行的编译产物指纹（内容寻址缓存键，覆盖全部可达 TS 源 + esbuild 版本 + target + 打包模式）：`9666b969fdeee82e316cd91ed3744b4a0a3638c7c14333b31534dcee21f29fcc`
  （入口 `scripts/eval/pr4a-report.ts`，模式 `external`，esbuild `0.28.2`，本次复用缓存）

| 实际执行模块（工作树字节） | SHA-256 |
| --- | --- |
| `scripts/eval/eval-pr4a-five-arm.mjs` | `ea889e14ecd0995a7180b731dc0c3d0b2208032eda3e8cdbb1a9159faafe2e05` |
| `scripts/eval/pr4a-build.mjs` | `69bd04382703419fcbc0ff3e598fe0937c1d72aabc7aa4db97f6a6a523f2f48a` |
| `scripts/eval/build-eval.mjs` | `fc20464563cd0ecce0b6c90f44c288badc253a1d83e81ab23c57697b39dd3200` |
| `scripts/eval/pr4a-five-arm-lib.ts` | `86813a289055406f54db969aff593c1bc22ffc3c8adc559acc3df686319782ac` |
| `scripts/eval/pr4a-report.ts` | `58f4ec4034fdbcb40cb6745d77db5bd7e46388b2a9ed84834a00430d9ace545f` |
| `scripts/eval/pr4a-stats.ts` | `d6841d75e008dbe64c795ca4500fdf5f381b83de148c64026b4ea2598aaea9f3` |
| `scripts/eval/jitrl-eval-lib.ts` | `7ad5ed6c5d2f97836de50542f3f88472dafe8c0d1d888a73763581121d51d878` |

| 已跟踪的脏文件 | SHA-256 |
| --- | --- |
| `.github/workflows/ci.yml` | `f11ff66d9e567508f39050ece04f4d29f08f2b0dff2d455dece4073269cd71aa` |
| `.gitignore` | `c10801cde42907247b41a63c2a3c60227113cd16017755f1ff048554a3646821` |
| `README.md` | `1d15f025c8318236b98fd5ce2dce73c672c329977cf5d1b9a0ebd92f096b3549` |
| `docs/P62_STATUS.md` | `977ab370b330c0cdce25bcbe5c7089f0e3efef03818cfbd487bb02c2684e2454` |
| `docs/reports/final-attestation.json` | `d706995e1eed228e700bc76eb519b7f5f721d50158364f4fd457ef891c56ba7b` |
| `docs/reports/p62-c11-c2a-closure.md` | `eea5d0d7e2c94a7269dd487795223efb295f231cf3eb86c9a6bb2f7ee0276305` |
| `package.json` | `5ce9ae8eadab64706ca9025cb327b9371c37ae17f67653ece481e6ba18b8c733` |
| `scripts/eval/final-attestation.mjs` | `639df2a72362ab135d2711480b04e796bc9e17bb115a65f5d8492f8d9a09b7af` |
| `scripts/eval/guarded-regression.mjs` | `5924c00f612cfd8a18846dd5a73a2791843deddfcff8ab17f3e05f9f527bd273` |
| `scripts/eval/negative-result-diag.mjs` | `3d13ab92f5836b4f197149bd510b9a5a38699bf6dd7d8fd54dd2dc72abeb6b5f` |
| `scripts/fixtures/ledger/scenarios.ts` | `e3c2c4d1ef3088c0c8ac0446c1fc45fc4ad6fcb01153fbb878e310028914bf34` |
| `src/config.ts` | `5a3a1d655fd5508cdf97ebb732d04ecf6eb9738fb8571dc5f00f0a8e95dad605` |
| `src/dream-rsi/offline-dreamer.ts` | `282bb23a565c7d2cdac5a32bcde4cbde185451c0dffa4a14a7ebce2febcce54e` |
| `src/dsh-bridge/agent-loop-executor.ts` | `0cdc55e112f3c6a7ba117e86b48089f2650312fbd47bb35dd0195013f76c1eca` |
| `src/dsh-bridge/model.ts` | `f74d906636ddae0996ecad27b83973477447e66f52f372b53b58abed8dee9801` |
| `src/index.ts` | `0328bb685f30ca62bd65e07c420e993b37f9f53b3cd749eea7e210f6783f5bbd` |
| `src/jitrl/decision-kernel.ts` | `e84b5c4534e59f06f0cd1b093f113f4b1935121b81f23148dcbd77ab35d96d63` |
| `src/jitrl/index.ts` | `d640932c228921416e311f3d939b3137f975cc2e1f785c0d48457e142b9ff1ec` |
| `src/jitrl/jit-active-policy.ts` | `b4061c26b2eca931afb7bf986ea1fa9c147237f20b597a04f1f796b6a76e51fc` |
| `src/ledger/index.ts` | `095fefd2e8c0a74eff25ca274ed91f61107282d64eee66ab2a0753ed99cc17be` |
| `src/ledger/ledger-event.ts` | `c6913059713f3a19fd3a52afd00116a30964ff733b45b57c0961ceb044a2a668` |
| `src/ledger/pricing.ts` | `13e85426e842a627c61013e21095135077a63ab70749552ead1c11daac009c68` |
| `src/ledger/reservation-manager.ts` | `ed55ef9d7a7354af8b229f6b6f0772ad68b9f0d2926a3d550036b1eef2b20cab` |
| `src/ledger/types.ts` | `a09811d93e6ed372e0f6ef8884d553ba3af957e7784cca0752b9c08eac44e9dd` |
| `src/orchestrator.ts` | `b4f6fb1bb14ef4c65f49465046ef1a03fa9f2d8ac27ba205f22ba1996384d9fb` |
| `src/verification/index.ts` | `2fb7cc608cbcbd78028ef35df60cf81fa06ded87996864c95f13e1516369b499` |
| `tests/unit/dream-rsi/dream-rsi-pipeline.test.ts` | `cc5437675c67ab57685ecdef12d6cc65b60866b61727fa958c8f13832bd074d4` |
| `tests/unit/dream-rsi/jit-dream.test.ts` | `64349d2334e8fafd93f14d422ba0f7791f02dd1403d91dcc9b078c311cac5df8` |
| `tests/unit/dream-rsi/offline-dreamer.test.ts` | `f870bf1a90f163830e28f102f8eb9bad8e248310aca223ccd09df76dad8b92f7` |
| `tests/unit/jitrl/runtime-control.test.ts` | `2d1ca3d1408a684390cce2760d48a1007c6b9ae2fc0b3c17512fdeb4f13aa838` |

> 复跑命令：`node scripts/eval/eval-pr4a-five-arm.mjs`（构建缓存内容寻址，见 `scripts/eval/build-eval.mjs`）。
> `git show 84a3d828ed2a27eef765c8b9c4950da4a9ee7287` reproduces the committed baseline; every deviation from it is enumerated above by path + SHA-256 (working tree, and this revision is uncommitted), together with the 7 executed modules. Re-verify any single file with: node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('<path>')).digest('hex'))"

## 1. 本臂读了哪一轨、门控开关状态

| 臂 | 轨道 | 写回 | 保守门 | 因子角色 | 终态快照 | 记录数 | 逐行轨道一致 | 审计流（未写回） |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `Arm-0` | `process` | 否 | 关 | reference | 冻结 | 0 | 0/0 ✅ | 0 |
| `Arm-1` | `process` | 是 | 关 | factorial | 演化 | 180 | 180/180 ✅ | 0 |
| `Arm-2` | `process` | 是 | 开 | factorial | 演化 | 180 | 180/180 ✅ | 0 |
| `Arm-3` | `task-quality` | 是 | 关 | factorial | 演化 | 115 | 115/115 ✅ | 65 |
| `Arm-4` | `task-quality` | 是 | 开 | factorial | 演化 | 115 | 115/115 ✅ | 65 |

> `Arm-0` 只参与 `θ_write = Arm-1 − Arm-0`；它**不进入**任何主效应/交互估计（V2 §3.3）。

**逐行写入轨不变量（取代「最后一次 `wroteTrack`」）**：上表「逐行轨道一致」列统计**每一条**真正写入的记录，
其轨道是否等于该臂声明的轨道。单一标量 `wroteTrack` 只反映**最后一次**写入——一条错轨记录 + 最后一次正确写入
会让标量断言通过，而库已经混轨。本报告因此按行统计，并把错轨行数直接列为失败条件。

**未认证执行 = 仅审计，绝不回落写 `process`（§6.3）**：对**质量臂**（`Arm-3`/`Arm-4`），任何未通过宿主认证的执行、
或结局非学习型的执行，都**不写入**经验库，只记入审计会计——绝不把它降级成 `process` 记录充数。
**过程臂**（`Arm-1`/`Arm-2`）写入的是**执行级过程观测**（生产默认 `trustedSource=false` 即为该路径），
这是「过程轨」的定义而不是降级；其无信任回执的行数单列披露，可与质量臂逐项对照。五臂写入会计：

| 臂 | 可写执行数 | 已写入 | 非学习结局（审计） | 未认证（审计，§6.3） | 无信任回执的过程观测（生产默认） | 质量标签落入过程臂 | 参照不写回 | 审计违规合计 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `Arm-0` | 0 | 0 | 0 | 0 | 0 | 0 | 180 | 0 |
| `Arm-1` | 180 | 180 | 0 | 0 | 48 | 0 | 0 | 0 |
| `Arm-2` | 180 | 180 | 0 | 0 | 77 | 0 | 0 | 0 |
| `Arm-3` | 180 | 115 | 0 | 65 | 0 | 0 | 0 | 0 |
| `Arm-4` | 180 | 115 | 0 | 65 | 0 | 0 | 0 | 0 |

> 断言 `auditOnlyAssertion = passed`：
> **质量臂**遇到未认证执行的唯一正确处理是「仅审计、不写库、不降级为过程记录」；
> **过程臂**写入的本来就是执行级过程观测（生产默认 `trustedSource=false`），其数目单列披露，不算违规。
> 「质量标签落入过程臂」必须恒为 0——否则意味着信任缝跨臂泄漏。

### 1.1 质量邻域断言（§6.3：未认证记录不得进入质量邻域）

| 臂 | 轨道 | 检查的决策点 | 存在可见质量记录的决策点 | 准入邻域的记录 | 因未认证被拒绝的记录 | 断言 |
| --- | --- | --- | --- | --- | --- | --- |
| `Arm-0` | `process` | 0 | 0 | 0 | 0 | passed |
| `Arm-1` | `process` | 0 | 0 | 0 | 0 | passed |
| `Arm-2` | `process` | 0 | 0 | 0 | 0 | passed |
| `Arm-3` | `task-quality` | 180 | 178 | 10585 | 0 | passed |
| `Arm-4` | `task-quality` | 180 | 178 | 10585 | 0 | passed |

> 质量臂在检索时先用生产谓词 `isAuthenticatedQualityRecord` 过滤：未被宿主认证的标签**永不进入**估计邻域，
> 因此「质量轨没有数据」与「质量轨被喂了未认证数据」两种情况可区分。过程臂不参与该检查（其邻域按定义不含质量记录）。

## 2. 主指标（按任务聚合，V2 §7.1）

| 臂 | verifiedRate（宿主判定） | meanCoverage | 改选率 | meanSupport | meanNEff（被执行） | meanNEff（挑战者，无条件测量） | 组内方差为 0 的任务 | 可用 episode |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `Arm-0` | 1.000 | 1.000 | 0.0000 | 0.00 | 0.00 | 0.00 | 12/12 | 60/60 |
| `Arm-1` | 0.833 | 0.944 | 0.3111 | 2.56 | 2.53 | 2.53 | 8/12 | 60/60 |
| `Arm-2` | 0.833 | 0.939 | 0.0556 | 3.10 | 3.07 | 2.49 | 8/12 | 60/60 |
| `Arm-3` | 1.000 | 1.000 | 0.0000 | 3.21 | 3.17 | 3.17 | 12/12 | 60/60 |
| `Arm-4` | 1.000 | 1.000 | 0.0000 | 3.21 | 3.17 | 3.17 | 12/12 | 60/60 |

> **主指标是宿主 runner 的判定**（§6.1），不是覆盖率自评。`coverage >= 1` 只是合成环境的**内部替代值**
> （附录 B 明确要求在有真实 runner 时替换掉）；本报告把它作为诊断保留，并逐条比对两者
> （见 §9 `hostVerdictAssertion`），任何分歧都会使运行断言失败。

**可用 episode 与审计流（§8.1.4/§6.4）**：被超时/中止/基础设施异常截断的执行**不计为失败**，
> 而是从该任务的分母中剔除，并把任务列入 `denominator-degraded` 清单。本轮实测：

- **没有任何任务出现分母退化**：全部 12 任务 × 5 执行均可用。

### 2.1 重复性检查（在看主结果前执行，V2 §8.1）

- 有效重复 `effectiveReplication = 1.3333`
- 推导方式：`max over LEARNING arms (writesBack=true) of mean(distinctRunValues per analysed task); set to exactly 1 when every analysed task is constant in every learning arm. allLearningArmsConstant=false, per-arm means=Arm-1:1.333333, Arm-2:1.333333, Arm-3:1, Arm-4:1`
- V2 §8.1: the L=5 episodes of one task may be identical under a deterministic runner. This is reported BEFORE the main results. `effectiveReplication` is the MEAN number of distinct within-task results actually resolved, taken over the LEARNING arms (Arm-0 is excluded because it never updates, so its constancy is definitional). It is NEVER `episodes`: the L episodes are not L independent observations. When every analysed task is constant in every learning arm the design is binary and `effectiveReplication` is exactly 1.

| 臂 | 写回 | 已分析任务 | 组内方差为 0 的任务数 | 每任务唯一值个数分布 | 唯一值众数 | 平均唯一值/任务 | 全部任务常数？ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `Arm-0` | 否 | 12/12 | 12/12 | {"1":12} | 1 | 1.000 | 是 |
| `Arm-1` | 是 | 12/12 | 8/12 | {"1":8,"2":4} | 1 | 1.333 | 否 |
| `Arm-2` | 是 | 12/12 | 8/12 | {"1":8,"2":4} | 1 | 1.333 | 否 |
| `Arm-3` | 是 | 12/12 | 12/12 | {"1":12} | 1 | 1.000 | 是 |
| `Arm-4` | 是 | 12/12 | 12/12 | {"1":12} | 1 | 1.000 | 是 |

> `Arm-0` **不参与** `effectiveReplication` 的计算：它从不更新，其常数性是**定义性质**而非重复性证据；
> 只有写回臂（`writesBack = true`）的组内唯一值个数说明本设计实际能分辨多少个不同结果。
> 并非全部任务常数 ⇒ 设计为**率型**，主检验按 §8.3.2 的精确配对随机化（符号翻转），
> `effectiveReplication = 1.3333` 由实测唯一值个数推导，
> **不是**常数 L=5：把 L 次执行当成 L 个独立观测，正是 §8.1 要防的虚增。

## 3. 受控族：四个前定估计量（Holm 校正，V2 §8.6）

| 估计量 | n | 均值差 | sd | 胜/平/负 | m_disc | 主检验 | 主检验 p | McNemar p | 符号翻转 p | Holm 调整 p | 显著 | 带宽 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| write-back | 12 | -0.167 | 0.267 | 0/8/4 | 4 | 符号翻转(§8.3.2) | 0.1250 | 0.1250 | 0.1250 | 0.3750 | 否 | below-NIM |
| track | 12 | 0.167 | 0.250 | 5/7/0 | 5 | 符号翻转(§8.3.2) | 0.0625 | 0.0625 | 0.0625 | 0.2500 | 否 | above-MMI |
| gate | 12 | 0.000 | 0.074 | 2/9/1 | 3 | 符号翻转(§8.3.2) | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 否 | within-band |
| interaction | 12 | 0.000 | 0.148 | 1/9/2 | 3 | 符号翻转(§8.3.2) | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 否 | within-band |

> **主检验与预注册一致（§8.3.1 vs §8.3.2）**：`主检验` 列逐行给出该估计量系列的**数据型别判定**。
> 率型系列（取值 {0, 0.2, …, 1}）的主检验是**精确配对随机化（符号翻转）**；**只有**当系列确实是二值时
> 才用精确 McNemar。两个 p 值始终并列打印，Holm 校正施加在**主检验 p** 上。
> 受控族**只有**这四行；补充族与反例均不在此族内，不得与上表合并宣称整体显著。

### 3.1 区间宽度与可复算性（§8.5 ④ / §8.3.3）

| 估计量 | 估计量区间（随机化反演） | 宽度 | 枚举空间 | 网格点 | 复跑命令 |
| --- | --- | --- | --- | --- | --- |
| write-back | [-0.350, 0.000] | 0.350 | 2^12 = 4096 | 321 | `node -e "import('./scripts/eval/pr4a-stats.ts').then(m=>console.log(m.randomizationInversionInterval([0,0,0,-0.6,0,-0.2,0,-0.6,0,0,-0.6,0],{alpha:0.05,step:0.005})))"` |
| track | [0.000, 0.325] | 0.325 | 2^12 = 4096 | 321 | `node -e "import('./scripts/eval/pr4a-stats.ts').then(m=>console.log(m.randomizationInversionInterval([0,0,0,0.6,0.2,0.1,0,0.6,0,0,0.5,0],{alpha:0.05,step:0.005})))"` |
| gate | [-0.050, 0.040] | 0.090 | 2^12 = 4096 | 201 | `node -e "import('./scripts/eval/pr4a-stats.ts').then(m=>console.log(m.randomizationInversionInterval([0,0,0,0,-0.2,0.1,0,0,0,0,0.1,0],{alpha:0.05,step:0.005})))"` |
| interaction | [-0.080, 0.100] | 0.180 | 2^12 = 4096 | 201 | `node -e "import('./scripts/eval/pr4a-stats.ts').then(m=>console.log(m.randomizationInversionInterval([0,0,0,0,0.4,-0.2,0,0,0,0,-0.2,0],{alpha:0.05,step:0.005})))"` |

> 区间用**估计量自身**的随机化反演（对均值差 μ 的网格反演），**不是** CP(π) 区间。
> `m_disc` 上的 Clopper–Pearson 区间是**另一个量**（不一致对胜出概率 π），本轮只作为 `exactInterval` 辅助保留，
> **不参与** §8.5 的 ③④ 判读。

> 复跑任一行：把该行的逐任务 Δ 数组（见 §5.3）传入 `randomizationInversionInterval(…,{alpha:0.05,step:0.005})` 即可，
> 枚举空间恒为 2^12 = 4096 个符号分配；本模块不含随机数，故无需种子。

### 3.2 四维判读元组（互不覆盖，V2 §8.5）

| 估计量 | significance | direction | degradationStatus | evidenceStatus | DTS（估计量自身） | 退化任务 | 区间下界 ≥ NIM？ | 区间上界 < NIM？ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| write-back | `not-reject` | `-` | `degraded` | `insufficient` | 0.3333 | ci-04, mig-02, mig-04, test-03 | **否** | 否 |
| track | `not-reject` | `+` | `not-degraded` | `insufficient` | 0.0000 | — | 是 | 否 |
| gate | `not-reject` | `0` | `not-degraded` | `insufficient` | 0.0833 | mig-01 | 是 | 否 |
| interaction | `not-reject` | `0` | `undetermined` | `insufficient` | 0.1667 | mig-02, test-03 | **否** | 否 |

> **判读规则**：四个维度相互独立。`degraded` 与 `insufficient` **可以同时成立**，
> 且 `not-reject` **绝不**等价于 `not-degraded`（V2 §8.5/§10.3）。本报告不把元组压成单一标签。

**③ `degradationStatus` 的 DTS 定义（本次修正）**：判读用的是**估计量自身**的逐任务 Δ：

> `DTS = #{i : estimator per-task value d_i < 0} / N (strictly below the null, mirroring the §7.2 strict comparison)`

| 估计量 | DTS（Δ<0，判读用） | DTS 敏感度（Δ ≤ NIM） | Δ ≤ NIM 的任务 | §7.2 臂级 DTS（仅描述，不进判读） |
| --- | --- | --- | --- | --- |
| write-back | 0.3333 | 0.3333 | ci-04, mig-02, mig-04, test-03 | 4/12（0.3333） |
| track | 0.0000 | 0.0000 | — | 0/12（0.0000） |
| gate | 0.0833 | 0.0833 | mig-01 | 4/12（0.3333） |
| interaction | 0.1667 | 0.1667 | mig-02, test-03 | 0/12（0.0000） |

> 第二列是**判读输入**；第三列是同一条数据的**敏感度**读数（结论不依赖阈值严格度）；
> 最后一列是 §7.2 的**臂级** DTS（某臂相对冻结参照输了几个任务），它是描述量，**不得**用作估计量的判读输入——
> 判读对象是估计量自身，不是某一臂。

### 3.3 交互优先可读性与共线披露（§8.4 判读顺序 / §3.4）

| 事实 | 实测值 |
| --- | --- |
| 质量臂在**每个**已分析任务上等同冻结参照（Arm-3 ≡ Arm-4 ≡ Arm-0） | **是** |
| 逐任务恒等式 `θ_track = −(θ_write + θ_gate)` 成立 | **是** |
| 该恒等式的最大残差 `max_i |θ_track_i + θ_write_i + θ_gate_i|` | `0` |
| `θ_track` 与 `θ_write` 两个**序列**数值相等 | **否**（相等不是本轮的退化形式） |
| `θ_track` 与 `θ_write` 的逐任务相关系数（仅描述） | -0.9615 |
| `θ_track` 相对轨道因子秩亏（不携带独立信息） | **是** |
| `Arm-3` ≡ `Arm-0` / `Arm-4` ≡ `Arm-0` / `Arm-3` ≡ `Arm-4` | 是 / 是 / 是 |
| 门控因子可识别的臂 | Arm-2 |
| 门控因子不可识别的臂 | Arm-4 |
| 轨道因子可识别 | **否** |
| 交互项可识别 | **否**（质量行两格完全相同） |

> **In this fixture the quality arms reproduce the FROZEN reference on every analysed task (Arm-3 ≡ Arm-4 ≡ Arm-0). Consequently θ_track is NOT an independent measurement of the track factor: it satisfies the exact identity `θ_track = −(θ_write + θ_gate)` (residual printed above), which contains no quality-row term at all. θ_track and θ_write are therefore rank-deficient with respect to the track factor, and θ_track’s `above-MMI` band is NOT positive track evidence. Only the process row of the gate factor is identifiable, and the interaction term is unidentifiable because the two quality cells are identical.**

**读法**：`θ_track` 落在 `above-MMI` 带**不得**被读作「轨道因子有正向效应」的轨道证据。
恒等式 `θ_track = −(θ_write + θ_gate)` 说明它完全由另外两个对比决定、不含任何质量行的项；
这正是「轨道因子在本夹具中不可识别」的**可执行证明**（残差为 0），而不是「轨道有效」的证据。
`θ_int` 在质量行不可识别时**只能**报 `undetermined`，不得解释为「无交互」。

## 4. 补充族：五臂两两对照（BH FDR，V2 §8.6）

| 对比 | n | 均值差 | 胜/平/负 | m_disc | 主检验 | 主检验 p | BH q | 区间 | 宽度 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `Arm-0` − `Arm-1` | 12 | 0.167 | 4/8/0 | 4 | 符号翻转 | 0.1250 | 0.2083 | [0.000, 0.350] | 0.350 |
| `Arm-0` − `Arm-2` | 12 | 0.167 | 4/8/0 | 4 | 符号翻转 | 0.1250 | 0.2083 | [0.000, 0.330] | 0.330 |
| `Arm-0` − `Arm-3` | 12 | 0.000 | 0/12/0 | 0 | McNemar | 1.0000 | 1.0000 | [0.000, 0.000] | 0.000 |
| `Arm-0` − `Arm-4` | 12 | 0.000 | 0/12/0 | 0 | McNemar | 1.0000 | 1.0000 | [0.000, 0.000] | 0.000 |
| `Arm-1` − `Arm-2` | 12 | 0.000 | 1/9/2 | 3 | 符号翻转 | 1.0000 | 1.0000 | [-0.080, 0.100] | 0.180 |
| `Arm-1` − `Arm-3` | 12 | -0.167 | 0/8/4 | 4 | 符号翻转 | 0.1250 | 0.2083 | [-0.350, 0.000] | 0.350 |
| `Arm-1` − `Arm-4` | 12 | -0.167 | 0/8/4 | 4 | 符号翻转 | 0.1250 | 0.2083 | [-0.350, 0.000] | 0.350 |
| `Arm-2` − `Arm-3` | 12 | -0.167 | 0/8/4 | 4 | 符号翻转 | 0.1250 | 0.2083 | [-0.330, 0.000] | 0.330 |
| `Arm-2` − `Arm-4` | 12 | -0.167 | 0/8/4 | 4 | 符号翻转 | 0.1250 | 0.2083 | [-0.330, 0.000] | 0.330 |
| `Arm-3` − `Arm-4` | 12 | 0.000 | 0/12/0 | 0 | McNemar | 1.0000 | 1.0000 | [0.000, 0.000] | 0.000 |

> 本表为**探索性/补充性**，与 §3 的受控族分开成表；其 q 值不得用来支撑五臂结论（V2 §8.6）。

> ⚠️ **退化区间（必须如实读出）**：`Arm-0 − Arm-3`、`Arm-0 − Arm-4`、`Arm-3 − Arm-4` 的逐任务 Δ 恒为 0（`m_disc = 0`），符号翻转检验没有任何不一致质量，
> 反演因此不拒绝任何 μ，`randomizationInversionInterval` 返回的 `[0.000, 0.000]` 是**退化输出**，
> **不是**「区间极窄、两组精确相同」。这类行的宽度**不构成**精度证据；`m_disc = 0` 本身即信息量为零。

## 5. 逐任务表（12 × 10 两两 Δ + 四个受控估计量）

### 5.1 各臂逐任务 verifiedRate（宿主判定；`—` = 未分析）

| 任务 | `Arm-0` | `Arm-1` | `Arm-2` | `Arm-3` | `Arm-4` | 各臂可用 episode |
| --- | --- | --- | --- | --- | --- | --- |
| test-02 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 5/5/5/5/5 |
| mig-01 | 1.000 | 1.000 | 0.600 | 1.000 | 1.000 | 5/5/5/5/5 |
| ci-02 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 5/5/5/5/5 |
| test-04 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 5/5/5/5/5 |
| ci-01 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 5/5/5/5/5 |
| ci-04 | 1.000 | 0.400 | 0.400 | 1.000 | 1.000 | 5/5/5/5/5 |
| mig-04 | 1.000 | 0.400 | 0.400 | 1.000 | 1.000 | 5/5/5/5/5 |
| test-01 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 5/5/5/5/5 |
| mig-02 | 1.000 | 0.800 | 1.000 | 1.000 | 1.000 | 5/5/5/5/5 |
| mig-03 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 5/5/5/5/5 |
| ci-03 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 5/5/5/5/5 |
| test-03 | 1.000 | 0.400 | 0.600 | 1.000 | 1.000 | 5/5/5/5/5 |

### 5.2 12 × 10 两两逐任务 Δ（left − right，探索性）

| 任务 | `Arm-0−Arm-1` | `Arm-0−Arm-2` | `Arm-0−Arm-3` | `Arm-0−Arm-4` | `Arm-1−Arm-2` | `Arm-1−Arm-3` | `Arm-1−Arm-4` | `Arm-2−Arm-3` | `Arm-2−Arm-4` | `Arm-3−Arm-4` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ci-01 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| ci-02 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| ci-03 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| ci-04 | 0.600 | 0.600 | 0.000 | 0.000 | 0.000 | -0.600 | -0.600 | -0.600 | -0.600 | 0.000 |
| mig-01 | 0.000 | 0.400 | 0.000 | 0.000 | 0.400 | 0.000 | 0.000 | -0.400 | -0.400 | 0.000 |
| mig-02 | 0.200 | 0.000 | 0.000 | 0.000 | -0.200 | -0.200 | -0.200 | 0.000 | 0.000 | 0.000 |
| mig-03 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| mig-04 | 0.600 | 0.600 | 0.000 | 0.000 | 0.000 | -0.600 | -0.600 | -0.600 | -0.600 | 0.000 |
| test-01 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| test-02 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| test-03 | 0.600 | 0.400 | 0.000 | 0.000 | -0.200 | -0.600 | -0.600 | -0.400 | -0.400 | 0.000 |
| test-04 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |

> V2 §12.2 item 3: 12 tasks × 10 pairwise deltas (left − right), all supplementary/exploratory. The four §8.6 controlled estimators are NOT columns here; see comparisons.controlledSeries.
> 行数实测 12 × 列数 10。

### 5.3 四个受控估计量的逐任务 Δ（判读输入）

| 任务 | write-back | track | gate | interaction |
| --- | --- | --- | --- | --- |
| ci-01 | 0.000 | 0.000 | 0.000 | 0.000 |
| ci-02 | 0.000 | 0.000 | 0.000 | 0.000 |
| ci-03 | 0.000 | 0.000 | 0.000 | 0.000 |
| ci-04 | -0.600 | 0.600 | 0.000 | 0.000 |
| mig-01 | 0.000 | 0.200 | -0.200 | 0.400 |
| mig-02 | -0.200 | 0.100 | 0.100 | -0.200 |
| mig-03 | 0.000 | 0.000 | 0.000 | 0.000 |
| mig-04 | -0.600 | 0.600 | 0.000 | 0.000 |
| test-01 | 0.000 | 0.000 | 0.000 | 0.000 |
| test-02 | 0.000 | 0.000 | 0.000 | 0.000 |
| test-03 | -0.600 | 0.500 | 0.100 | -0.200 |
| test-04 | 0.000 | 0.000 | 0.000 | 0.000 |

> V2 §3.3/§8.4: the four pre-registered estimator series, one value per task.

## 6. 门控介入分布（证明门控确实接线的必要证据，V2 §7.2）

| 臂 | 门控 | 提议偏离数 | 门控评估数（applied） | kept-prior | executed-proposed | executed-exploration | 原因分布 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `Arm-0` | 关 | 0 | 0 | 0 | 0 | 0 | — |
| `Arm-1` | 关 | 56 | 0 | 0 | 0 | 0 | — |
| `Arm-2` | 开 | 45 | 45 | 35 | 10 | 0 | {"implicit-zero-advantage":33,"min-support":2} |
| `Arm-3` | 关 | 0 | 0 | 0 | 0 | 0 | — |
| `Arm-4` | 开 | 0 | 0 | 0 | 0 | 0 | — |

> `applied` 只计**真正评估过门控**的决策点（门控开 **且** 提议偏离先验）。未偏离先验的行由内核直接落回先验，
> 门控根本没有拦截机会；把它们计成 `applied` 会虚增门控的判别力。

### 6.1 无条件落盘的挑战者测量（§3.4：门关臂**仍测量**强度）

| 臂 | 门控 | 决策行数 | 含挑战者测量的行数 | meanNEff（挑战者） |
| --- | --- | --- | --- | --- |
| `Arm-1` | 关 | 180 | 180 | 2.53 |
| `Arm-3` | 关 | 180 | 180 | 3.17 |

> 断言 `challengerFieldsUnconditional = passed`：检查 900 行，缺失挑战者字段的行数 = 0。
> **修正说明**：原实现只在 `conservativeGate === true` 时调用 `decideReplacement`，于是两条门关臂的
> `nEff/support/shrunk/calibrated` 全部为 `null`——恰恰抹掉了门控因子必须对比的那一维。现在五臂**无条件**调用
> 生产函数并落盘四个字段，门控开关只决定 `verdict` 能否改写被执行动作。

> 门控在共享路径上**双向可达**：另有独立探针以同一生产函数验证「证据不足⇒否决」与
> 「证据充分⇒执行」两侧均成立（`scripts/eval/pr4a-gate-wiring.mjs`，exit 0）。

### 6.2 空门控分布的成因（**可识别性限制，必须如实读出**）

下列带门控的臂**从未偏离先验**（`policyChangeRate = 0`），因此门控**没有任何可拦截的机会**：

| 臂 | 改选率 | 门控评估数 | 该格的可解释性 |
| --- | --- | --- | --- |
| `Arm-4` | 0.0000 | 0 | 门控因子在该格**不可识别**（无偏离可判） |

**为什么没有偏离（实测机制）**：可信质量轨的奖励在该合成夹具中趋于饱和——凡被判通过的执行
都取得同一奖励值，于是各候选的 `Q` 几乎相等、优势 A ≈ 0，argmax 每次落回先验。
这是**夹具性质**，不是「门控未接线」的证据（接线由独立可达性探针证明）。

**对结论的影响（必须同时读出）**：

1. `θ_gate` 的实际信息**全部来自 `Arm-1` vs `Arm-2`**（过程行）；质量行的门控贡献为 0。
2. `θ_int` 因此**不可识别**：当 `Arm-3 ≡ Arm-4` 时，交互项退化为「过程行的门控效应」，
   不得解释为「轨道与门控的交互」。
3. 本轮**不能**回答「质量轨 + 保守门优于质量轨」——该对比的两格观测值相同。
   这是**可识别性边界**，不是「门控在质量轨无效」的证据。

有偏离、因而具备门控判别力的臂：`Arm-1`（0.3111）、`Arm-2`（0.0556）

## 7. 成本口径（真实 / 估计 / 未知，V2 §9）

| 臂 | 分母 | 决策点 | 模型调用 | measured | estimated | unknown | 名义微美元 | 地板附加费 | 本地墙钟 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `Arm-0` | decision-points | 180 | 180 | 0 / 0.0% | 180 / 100.0% | 0 / 0.0% | 24667 | 0 | 48ms |
| `Arm-1` | decision-points | 180 | 180 | 0 / 0.0% | 180 / 100.0% | 0 / 0.0% | 24667 | 0 | 92ms |
| `Arm-2` | decision-points | 180 | 180 | 0 / 0.0% | 180 / 100.0% | 0 / 0.0% | 24667 | 0 | 86ms |
| `Arm-3` | decision-points | 180 | 180 | 0 / 0.0% | 180 / 100.0% | 0 / 0.0% | 24667 | 0 | 375ms |
| `Arm-4` | decision-points | 180 | 180 | 0 / 0.0% | 180 / 100.0% | 0 / 0.0% | 24667 | 0 | 341ms |

### 7.1 Token 六字段分列（V2 §9.3，每项自带精度状态）

| 臂 | inputTokens | outputTokens | reasoningTokens | cacheReadTokens | cacheWriteTokens | totalTokens | 分母 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `Arm-0` | 10445 (`estimated`) | 8640 (`estimated`) | 0 (`estimated`) | 0 (`estimated`) | 0 (`estimated`) | 19085 (`estimated`) | decision-points（180 决策点 / 180 调用） |
| `Arm-1` | 10445 (`estimated`) | 8640 (`estimated`) | 0 (`estimated`) | 0 (`estimated`) | 0 (`estimated`) | 19085 (`estimated`) | decision-points（180 决策点 / 180 调用） |
| `Arm-2` | 10445 (`estimated`) | 8640 (`estimated`) | 0 (`estimated`) | 0 (`estimated`) | 0 (`estimated`) | 19085 (`estimated`) | decision-points（180 决策点 / 180 调用） |
| `Arm-3` | 10445 (`estimated`) | 8640 (`estimated`) | 0 (`estimated`) | 0 (`estimated`) | 0 (`estimated`) | 19085 (`estimated`) | decision-points（180 决策点 / 180 调用） |
| `Arm-4` | 10445 (`estimated`) | 8640 (`estimated`) | 0 (`estimated`) | 0 (`estimated`) | 0 (`estimated`) | 19085 (`estimated`) | decision-points（180 决策点 / 180 调用） |

| 字段 | 本轮精度 | 说明 |
| --- | --- | --- |
| `inputTokens` | `estimated` | chars/4 over the exact rendered prompt text (no tokenizer in this harness) — every token count is ESTIMATED, never measured |
| `outputTokens` | `estimated` | chars/4 over the exact rendered prompt text (no tokenizer in this harness) — every token count is ESTIMATED, never measured |
| `reasoningTokens` | `estimated` | chars/4 over the exact rendered prompt text (no tokenizer in this harness) — every token count is ESTIMATED, never measured |
| `cacheReadTokens` | `estimated` | chars/4 over the exact rendered prompt text (no tokenizer in this harness) — every token count is ESTIMATED, never measured |
| `cacheWriteTokens` | `estimated` | chars/4 over the exact rendered prompt text (no tokenizer in this harness) — every token count is ESTIMATED, never measured |
| `totalTokens` | `estimated` | chars/4 over the exact rendered prompt text (no tokenizer in this harness) — every token count is ESTIMATED, never measured |

> **没有任何一项是 `measured`**：本 harness 无 tokenizer，故六字段全部为 `estimated`。
> 口径说明：`V2 §9.3: input / output / reasoning / cache-read / cache-write / total, each carrying its own precision label. No total may be read as "measured".`

**口径声明（逐条，均可核对）**：

1. **`liveCalls = 0`、`incurredRealUsd = 0.00`**：本轮全部为离线合成夹具，未发起任何真实付费调用。
2. **`micros` 不是美元**：它是记账单位约定（1 USD = 1,000,000 micros）。上表金额由**离线夹具费率卡**
   `pr4a-offline-fixture-model`（`pr4a-fixture-rc-20261027-v1`）计算，属**名义值（notional）**，
   不是支出、不是报价、也不构成任何财务授权。
3. **`100000` 微美元 / `500000` token 不是财务上限**：它们是离线名义台账的
   **护栏阈值**（`offlineNotionalBudgetMicros` / `offlineNotionalTokenBudget`），仅用于在夹具跑飞时于**决策边界**快速中止。
4. **本地墙钟不是远端费用上限**：`60000ms`（单次调用 `10000ms`）是超时隔离判据，
   与远端计费无函数关系；「60 秒内 ⇒ 不超预算」是无效推理。
5. **全部 token 数均为 `estimated`**：见上表，`measured` 计数恒为 0——这是事实，不是缺陷。
6. **地板附加费单列**：若 `unknown` 触发保守地板，其差额计入「地板附加费」列，**不并入**名义金额。

## 8. 安全事件与执行控制（V2 §10）

| §10.2 路径 | 本轮是否触发 | 说明 |
| --- | --- | --- |
| `security-gate`（STOP-ALL (publishAuthorized leak / unauthorized write / unredacted payload)） | 未触发 | defensive assertion: permissions.publish.allowed is false in all four execution modes, so this path has no executable trigger in this round (V2 §10.2 item 1) |
| `offline-notional-guardrail`（STOP-ARM (offline notional micros / token guardrail)） | 未触发 | runaway-fixture stopper; NOT a financial cap and NOT a budget authorisation (V2 §9.4) |
| `early-stopped-for-harm`（STOP-ARM (futility stop)） | 未触发 | fires at 3 consecutive tasks with observed verifiedRate = 0; the V2 §10.2 item 3 wording also requires destructive errors, which this fixture cannot produce — the wording difference is disclosed rather than silently applied |
| `timeout-isolation`（TIMEOUT-ISOLATION (per-execution local wall-clock)） | 未触发 | a censored execution is audit-only and is never counted as a task failure (V2 §6.4) |

**本轮未触发任何执行控制事件**：五臂均在 12 任务 × 5 执行 × 3 轮内正常完成，
没有 `guardrail-stop`、没有 `futility-stop`、没有 `runner-timeout`、没有 `safety-violation`。

> 「未触发」是**实测事实**，不是遗漏：上表逐条列出四条路径、其触发条件与不可触发性原因。

> 执行控制与结果判定**互不改写**（V2 §10.1）：中止不会被记成「退化」，退化也不会触发中止。
> 超时/中止的执行按 §6.4 标 `learningEligible=false`、`forceAuditOnly=true`，**不计为任务失败**，
> 而是从该任务分母中剔除并列入 `denominator-degraded` 清单（见 §2）。

### 8.1 数据完整性（§10.4：不得静默丢任务）

| 臂 | 状态 | 计划任务 | 已分析任务 | not-run | denominator-degraded | 被截断执行 | 决策点（实记/计划） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `Arm-0` | complete | 12 | 12 | — | — | 0 | 180/180 |
| `Arm-1` | complete | 12 | 12 | — | — | 0 | 180/180 |
| `Arm-2` | complete | 12 | 12 | — | — | 0 | 180/180 |
| `Arm-3` | complete | 12 | 12 | — | — | 0 | 180/180 |
| `Arm-4` | complete | 12 | 12 | — | — | 0 | 180/180 |

> 任何被执行控制截断的臂/任务都保留其**原始计数**与原因，分母里不做静默剔除（V2 §10.4）。

## 9. 不变量断言

| 断言 | 结果 |
| --- | --- |
| 跨臂候选池指纹一致 | passed（失配 0） |
| 跨臂记录 id 两两不交 | passed（重叠 0） |
| `Arm-0` 快照冻结（终态 = 初始） | passed |
| 探索额度钉为 0 | passed（0） |
| **逐行写入轨符合设计**（不是最后一次写入） | passed |
| **未认证执行仅审计**（质量标签落入过程臂 = 0） | passed |
| **挑战者四字段无条件落盘** | passed（缺失 0 / 900 行） |
| **主指标 = 宿主判定**（与覆盖率替代值零分歧） | passed（分歧 0） |
| `Arm-0` 轨道符合设计（process） | passed（写入 0 行，错轨 0，末次写入 null） |
| `Arm-1` 轨道符合设计（process） | passed（写入 180 行，错轨 0，末次写入 process） |
| `Arm-2` 轨道符合设计（process） | passed（写入 180 行，错轨 0，末次写入 process） |
| `Arm-3` 轨道符合设计（task-quality） | passed（写入 115 行，错轨 0，末次写入 task-quality） |
| `Arm-4` 轨道符合设计（task-quality） | passed（写入 115 行，错轨 0，末次写入 task-quality） |

## 10. 决策台账（全量落盘，V2 §4.1/§12.2）

| 臂 | 决策点 | 文件 | 完整 SHA-256（64 位十六进制） |
| --- | --- | --- | --- |
| `Arm-0` | 180 | `work/pr4a-ledger-Arm-0.jsonl` | `9c182a32b880039f55dee5a67a93cd65f32cddda5b92867312ffb1e25ce303ee` |
| `Arm-1` | 180 | `work/pr4a-ledger-Arm-1.jsonl` | `cb0066107443534ea17a138e8da55c689dd410a782c0bbf0d7a30c29b7f49911` |
| `Arm-2` | 180 | `work/pr4a-ledger-Arm-2.jsonl` | `12335caabdadf08ffb0d06d480f341e59f88746586e8cb98f5dcd0944266262f` |
| `Arm-3` | 180 | `work/pr4a-ledger-Arm-3.jsonl` | `3e0257753aec88cd413e99786c78b35c275e29bd713bc1f29ff459f053888b1c` |
| `Arm-4` | 180 | `work/pr4a-ledger-Arm-4.jsonl` | `301b7976366e5ad41ad8d964b232056050aa47bbd5923978eb9f5f5bfbf527a4` |

> 台账为**全量数组**（每臂 12 任务 × 5 run × 3 round = 180 行），不是计数 + 样例；
> 上表给出**完整 64 位十六进制** SHA-256（不是前缀省略），可直接与文件对账：

```powershell
(Get-FileHash work/pr4a-ledger-Arm-0.jsonl -Algorithm SHA256).Hash  # expect 9C182A32B880039F55DEE5A67A93CD65F32CDDDA5B92867312FFB1E25CE303EE
(Get-FileHash work/pr4a-ledger-Arm-1.jsonl -Algorithm SHA256).Hash  # expect CB0066107443534EA17A138E8DA55C689DD410A782C0BBF0D7A30C29B7F49911
(Get-FileHash work/pr4a-ledger-Arm-2.jsonl -Algorithm SHA256).Hash  # expect 12335CAABDADF08FFB0D06D480F341E59F88746586E8CB98F5DCD0944266262F
(Get-FileHash work/pr4a-ledger-Arm-3.jsonl -Algorithm SHA256).Hash  # expect 3E0257753AEC88CD413E99786C78B35C275E29BD713BC1F29FF459F053888B1C
(Get-FileHash work/pr4a-ledger-Arm-4.jsonl -Algorithm SHA256).Hash  # expect 301B7976366E5AD41AD8D964B232056050AA47BBD5923978EB9F5F5BFBF527A4
```

> 台账不含任何原始文本、代码补丁或 Prompt（payload-free）。

台账列（payload-free，逐行可复算 §4.1）：

```
armId
track
taskId
run
round
stateBucket
stateFingerprint
poolDigest
priorChoice
chosenChoice
executedIndex
deviated
proposedDeviation
gateEvaluated
gateReason
gateVerdict
support
nEff
q
v
advantage
challengerIndex
challengerSupport
challengerNEff
challengerAdvantage
challengerShrunkAdvantage
challengerCalibratedAdvantage
challengerHasReplacementEvidence
priorSupport
priorNEff
writeDisposition
learningTrackWritten
hostVerdict
observedVerified
observedCoverage
```

> 其中 `challengerSupport` / `challengerNEff` / `challengerShrunkAdvantage` / `challengerCalibratedAdvantage`
> 为**无条件**落盘的挑战者测量（§3.4）；`writeDisposition` 记录该行是 `written` 还是 `audit-only-*`（§6.3）；
> `hostVerdict` 是宿主判定（§6.1），`observedCoverage` 只是合成替代值。

## 11. 本报告**不**声明什么

- **不声明任何「真实费用」**：`liveCalls=0`、`incurredRealUsd=0.00`，全部金额为名义值（§7）。
- **不声明生产结论**：12 个合成任务提供的只是机制可行性与决策级归因证据；
  不得外推为生产显著性结论（V2 §8.7）。
- **不声明统计功效已达成**：`d_min = 0.809` 是**闭式近似**
  （closed-form normal approximation ((z_1-a/2 + z_1-b) / sqrt(N)), NOT an executed power analysis; the N=10 value is 0.8859 (the superseded V1 figure 0.886)）；
  精确枚举得到的最小可检测胜率为 π* = 0.869。
- **不声明 Wilcoxon 用于二值数据**：`wilcoxonUsedOnBinary = false`。
- **不把「不显著」读成「无退化」**：见 §3.2 的四维元组。
- **不把门控因子说成在两个轨道上都被检验过**：质量行的门控**不可识别**（该行从未偏离先验）；
  因此 `θ_gate` 全部来自过程行，`θ_int` 在本轮**不可识别**。
- **不把 `above-MMI` 当作正向轨道证据**：本夹具中质量臂在每个已分析任务上等同冻结参照，
  因此 `θ_track` 满足恒等式 `θ_track = −(θ_write + θ_gate)`（残差 = 0），对轨道因子**秩亏**、不携带独立信息；
  且 Holm 校正后不显著、证据状态为 `insufficient`。这是「未定论」，不是「已证明更优」，也不是「轨道有效」。
- **不声明门关臂「未测量门控」**：门关臂同样无条件落盘 `nEff/support/shrunk/calibrated`（§6.1）。
- **不把超时/中止计成任务失败**：截断执行按 §6.4 只进审计流并从分母剔除，且列入 `denominator-degraded`。
- **不声称工作树干净**：本报告绑定执行代码摘要 `5011b4691451f487…` 与 commit `84a3d828ed2a…`，见 §0.1。
- **不预填正向结果**：本轮结果无论正、零或负，均如实记录；没有任何数值目标被当作完成条件。

---

*本文件由脚本生成；任何手工改动都会与 JSON 报告不一致，并会被 `scripts/eval/verify-pr4a-artifacts.mjs` 判失败。*
