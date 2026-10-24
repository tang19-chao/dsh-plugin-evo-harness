# P6.1-R3：RewardContract 与负收益解释独立评审（round 1）

| 项 | 值 |
| :-- | :-- |
| 被评任务 | t6「P6.1-D：RewardContract 统一奖励标尺 + 判别测试」＋ t8「P6.1-E：负收益解释（决策级诊断台账+最小反例+假设判别）」 |
| 评审任务 | t12（attempt `2add3deb-ddf6-440c-9fd4-2394108c8d75`，gate-reviewer） |
| reviewed SHA（HEAD） | `7bce33ee9d102a6a05a35f080f606a8fd388e114`（`git log -1`；评审基于含未提交改动的**工作树**） |
| reviewed SHA（工作树 diff 指纹） | `git diff \| git hash-object --stdin` = `58d78843410caa7c9782adce80da118ba2477806`（评审全程未漂移） |
| 关键文件指纹（sha256 前 16） | `src/jitrl/reward-contract.ts` `69A7272305C330D3`；`src/orchestrator.ts` `84E0B163CB132977`；`src/jitrl/value-estimator.ts` `98F7A7F0C3A32C46`；`tests/unit/orchestrator/credit-attribution.test.ts` `2AAC8E0673E3A4C1`；`tests/unit/jitrl/value-estimator.test.ts` `782E18BA6CDFAC16`；`docs/reports/p61-eval-negative-result-explanation.md` `F053582AB7399FE4`；`scripts/eval/negative-result-diag.mjs` `10FBFC1D1D24D13E`；`scripts/eval/jitrl-eval-lib.ts` `74B36BD35B564693` |
| 结论 | **pass**（判别力、评分统一、默认口径、报告诚实性全部核实）。**1 条 medium 级 open finding（F1）**：RewardContract 的 upgradeRule 在生产学习路径**未接线**且持久化版本常量仍留在 r2 —— 按 ADR D4 属"阻塞扩大默认启用"，不阻塞本轮研究交付；另有 2 条 low 级报告数字精度问题（F2/F3）与 1 条集成面观察（O1）。 |

**方法**：只读代码 + 隔离副本独立变异重放（`%TEMP%\p61-r3-copy`，`node_modules` junction；变异前/后与仓库 `src`+`tests` 逐文件 sha256 **diff 0**，评审结束已删除）+ 独立重跑 t8 诊断脚本两次 + 自写探针全量扫描台账 180 条。未触碰仓库 `src/**`、`tests/**`、`scripts/**`。

---

## 1. t6 判别测试的判别力（我自己重放变异，不采信交付说明）

| 变异（隔离副本内） | 我实测结果 | 结论 |
| :-- | :-- | :-- |
| **M1**：在 `recordOnlineExperience` 恢复旧分叉——赢家走 `winnerRewards` 均值（私有标尺），非赢家走 `scoreUnderRewardContract` | `credit-attribution.test.ts -t "P6.1-D 7.4"` → **2 failed / 4 passed**：① 同轨迹同尺度、② judge 缺失不改语义 双双转红 | 六条判别测试确实钉住"赢家私有标尺"这一目标缺陷 |
| **M2**：把 `readLearningTarget()` 改成 **gain 优先**（`learningTarget` → `observedReturn` 回退） | `value-estimator.test.ts` → **2 failed / 26 passed**（"reads observedReturn first"、"estimateStateValue averages the contract target, not the gain field"） | "默认消费 observedReturn、gain 仅辅助"有真实判别力 |
| **M3**：删除 stage detail 里的 `estimatorTarget: estimatorTargetLine(...)` | `credit-attribution.test.ts -t "P6.1-D 7.4"` → **1 failed / 5 passed**：⑥ estimator 日志 转红 | "日志写明 target 字段与版本"不是空话 |

副本基线（未变异）：`6 passed | 24 skipped`，exit 0。三次变异后均按仓库原文件恢复并验证 sha256 一致。

---

## 2. 评分路径统一（t6 核心）

| 检查 | 证据 |
| :-- | :-- |
| 唯一标尺 | `scoreUnderRewardContract()`（`reward-contract.ts:150-169`）：`scoreTrajectorySignals` + 契约权重（completion .5 / turn .3 / steps .1 / tool .1）+ tool 正项二值化 + clip[-3,3] |
| 赢家不再有私有标尺 | 旧的 `else if (isWinner && winnerRewards !== undefined)` 分支（step 均值 + `discountedReturn`）已删除；现在**所有 eligible probe** 都走 `scoreUnderRewardContract(probe.trajectory)`（`orchestrator.ts:1900-1915`） |
| reference 同一标尺 | `const baseline = clamp(scoreUnderRewardContract(input.reference).reward, -3, 3)`（`:1876`）—— 与候选同一函数 |
| judge 仅辅助 | 赢家的 step 向量只作为 `rewardSources.stepJudge = winnerStepSummary(winnerRewards)`（`:1910-1915`，`:486-491` 均值 clip），judge 缺失/抛错时该字段缺失但主目标不变（测试②，M1 亦可反证） |
| 版本戳 | 新记录 `rewardVersion: REWARD_CONTRACT.version` = `r3/unified-signals-v1`（`:1936`）；`r2/verifiable-v1` 作为 `PREVIOUS_REWARD_CONTRACT_VERSION` 显式保留 |
| 六条测试逐条 | ①同轨迹同尺度=契约聚合值且 `stepJudge=3` 仅存在于赢家；②healthy/throws/empty 三态 reward/observedReturn/learningTarget/version 全等；③有交付物 vs 声称成功无交付物（`completion` = `COMPLETION_SIGNAL` vs `MISSING_DELIVERABLE_SIGNAL`，reward 更高）；④toolCalls 1/5/20/100 非单调、max ≤3；⑤cancel/infra → `learningEligible=false`、learningTarget 0、reward 0；⑥stage detail 含 `rewardVersion/rewardScale/rewardTargetField` + `estimatorTarget` 行 |

**M1 证明**：把分叉放回去，测试立即变红 —— 统一不是靠改测试名得到的。

---

## 3. 默认口径与消费关系

| 检查 | 证据 |
| :-- | :-- |
| 默认字段 | `REWARD_CONTRACT_LEARNING_TARGET_FIELD = 'observedReturn'`；`readLearningTarget()`（`:229-234`）observedReturn 优先、`return` 仅作 legacy 回退、**永不回退到 learningTarget** |
| 估算器实际消费 | `estimateStateValue()` 改用 `readLearningTarget(neighbor.record)`（`value-estimator.ts:176-186`）——以前直接读 `record.return` |
| 记录写入 | `observedReturn = clamp(signal.reward,-3,3)`，`return: observedReturn`（`orchestrator.ts:1909/1939/1954/1975`），`learningTarget = clamp(observedReturn - baseline)` **仅持久化** |
| gain 未被全量替换 | 全仓 grep：`learningTarget` 无任何**消费**点（只在 orchestrator 写入、experience-store 持久化/回读、backfill 迁移、reward-contract 定义与日志文案）；M2 证明一旦偷换会被测试抓住 |
| 日志可见 | `estimatorTargetLine()`（`:262-281`）输出 `target field observedReturn (contract default); consumed [observedReturn=N…]; rewardVersion=r3/unified-signals-v1`，并进入 `record_experience` stage detail（测试⑥ + M3 反证） |
| cancel/infra | `!eligible` → reward 0 / observedReturn 0 / learningTarget 0 / `learningEligible:false`（`:1893-1899`），与 PR5 的严格学习过滤一致 |

---

## 4. t8 负收益解释：独立重放与数字核对

**独立重跑** `node scripts/eval/negative-result-diag.mjs --json`（两次，注入到 `%TEMP%`）：

| 报告结论 | 我的独立复现 | 一致性 |
| :-- | :-- | :-- |
| 复现口径 episodes:5/rounds:3，均值差 −0.250，胜/平/负 0/7/5，`matchesHistorical` | meanDelta **-0.25**，wins/ties/losses **0/7/5**，`matchesHistorical: true` | ✓ |
| 退化任务 5/12（0.4167），退化任务均损 −0.600，改善任务 +0.000 | degradedTaskShare **0.4167**，tasks [ci-04,mig-01,mig-02,mig-04,test-03]，meanLoss **-0.6**，meanGain **0** | ✓ |
| 首害决策 `ci-04|2|2`：prior idx0 `guardrails:append(1)`，chosen `noop`，support 0，Q null，V 0.266687，A 0，z′ −0.10199，KL 0.122363，先验覆盖 1.000，实测覆盖 0.667，observedReturn +0.30，`verifierRewardMismatch: true` | 逐字段**完全一致**（`firstHarmfulDeviation`），另含 `neighborVersions:["r2/verifiable-v1"]`、`targetField:"observedReturn=8"` | ✓ |
| 36 次偏离、18 次有害、门槛触发 0 | total **36**、harmful **18**、gateFired **0** | ✓ |
| H1 Δ −0.1833（scale-sensitive）；H2 Δ −0.1833；H3 Δ 0；H4 Δ 0；H5 Δ −0.75；H6 not-run(behavioural) | 逐条一致（H1 verifiedRate 0.8167 / H2 0.8167/ H3 1 / H4 1 / H5 0.25） | ✓ |
| H3/H4 措辞为「假设，非已确认根因」 | artifact `verdict` 原文含"（假设，非已确认根因）"，报告 §5 开头明写"以下全部是假设判别，不是已确认根因" | ✓ |
| counterfactual 单独记账、不入公平臂 | `offlineCounterfactual.account = "offline-counterfactual (synthetic environment; NOT in the fair-arm budget; NOT a production observation)"`，锚点池 3 候选（含 idx2 `guardrails:append(1)#2` 满覆盖） | ✓ |
| H4 正式化双门槛：收益门槛未过、安全门槛过 | `benefitDelta 0 < +0.25` → `benefitGatePassed false`、`safetyGatePassed true` | ✓ |
| 默认路径未变（24/24 parity） | `pnpm exec vitest run tests/e2e/jitrl-ablation.test.ts` → **24 passed**, exit 0 | ✓ |
| `node scripts/eval-jitrl.mjs --json` exit 0 | **exit 0** | ✓ |
| 最小反例 5 条 | `minimalCounterexamples.length = 5` | ✓ |

**台账 payload-free（我自己全量扫描 180 条，不只看 sample）**：自写探针经 `loadEvalLib()` 重跑 `runFairEngineWithLedger({diagnostics:{ledger:true}})` 拿到全部 **180** 条，逐条扫描：

- 键集合（28 个）全部为结构化字段：坐标（taskGroup/task/run/round）、`stateBucket`/`stateFingerprint`、`candidatePoolDigest`/`candidateActionKeys`、选择（priorChoice/chosenChoice/deviated/minSupportGateFired）、近邻（neighborIds/neighborVersions/similarity/weight）、内核算术（support/q/v/advantage/adjustedLogit/kl）、`rewardModelVersion`/`targetField`、观测（observedOutcome/observedReturn/observedCoverage/observedVerified）。
- 最长字符串值 = `actionKey` **63 字符**；**0** 个字符串 >120 字符；**0** 条命中 raw-text 标记（prompt / deliverable / appendRules / rationale / markdown / content / Authorization 等）。
- ⇒ 无 prompt 正文、无 patch 正文、无交付物正文、不给未执行候选补 reward（counterfactual 全候选执行只出现在单独记账块）。

---

## 5. 验收清单（逐条）

| 验收项 | 结果 | 证据 |
| :-- | :-- | :-- |
| 评审绑定当前提交 SHA（写入 reviewed SHA 字段） | **passed** | 头部表（HEAD + diff 指纹 + 8 个文件 sha256） |
| 7.4 六条逐条有真实判别力（同轨迹同尺度/judge 缺失/交付物验证/无意义调用不无限加分/cancel-infra 不进学习/日志写明 target+版本） | **passed** | §2 六条逐条 + §1 的 M1/M3 变异反证 |
| 评分路径统一：同一 rewardVersion 下赢家/非赢家/reference 不再走不同聚合；orchestrator 分叉被统一 | **passed** | §2（代码事实 + M1 让 ①②转红） |
| 默认口径 verifier 优先 observedReturn，gain 仅辅助对照；未发生自动 return→gain 全量替换 | **passed** | §3（readLearningTarget + 全仓无 learningTarget 消费者 + M2 反证） |
| learningTarget 与 record.return 消费关系与契约一致；estimator 日志可见 | **passed** | §3（`return: observedReturn`；stage detail `estimatorTarget`；测试⑥/M3） |
| 负收益报告结论与数据一致、无包装收益措辞 | **passed（含 F2/F3 数字精度 finding）** | §4 逐项复现；报告开篇"先说负的"、§7 明确不归因模型能力/算法原理、§6 诚实结论"没有任何策略同时通过两道门槛" |
| 预注册假设一次只改一项 | **passed** | §4（H1 只换标尺、H2 只改状态 token、H3 只改 action key、H4 只加门槛、H5 只改池调度；H6 为结构性核对） |
| counterfactual 单独记账未混入公平臂 | **passed** | §4（account 字段 + 3 候选合成表；台账内 0 处未执行候选 reward） |
| 评审报告落盘 `docs/reports/p61-review-round1-reward-eval.md`（含 verdict 与 findings） | **passed** | 本文件 |
| `pnpm run typecheck` / `pnpm test` 在评审环境通过 | **passed** | typecheck exit 0；`pnpm test` **73 files / 1443 tests passed**, exit 0 |

---

## 6. Findings

| id | 等级 | 状态 | 内容 / required fix |
| :-- | :-- | :-- | :-- |
| **F1** | medium | **open（阻塞"扩大默认启用"，不阻塞本轮研究交付 —— ADR D4）** | RewardContract 的 `upgradeRule`（"bump rewardVersion; rebuild incompatible experience"）在生产学习路径**未接线**：`requiresExperienceRebuild()` / `isRewardVersionBump()`（`reward-contract.ts:178-221`）全仓**零生产调用点**；持久化版本常量 `CURRENT_REWARD_VERSION`（`experience-store.ts:73`）**仍是 `r2/verifiable-v1`**，而 orchestrator 已写 `r3/unified-signals-v1`（`reward-contract.ts:38-40` 自己声明"两者 must never drift apart"）；学习资格判定 `isLearningEligible()` 只看 `experienceSchemaVersion`/`learningEligible`，**不看 rewardVersion**，且 `backfill.migrateExperienceRecords()` 的隔离条件同样不含版本。⇒ 真实升级场景下，升级前写入的 r2 记录（schema 已达标、未打 legacy 标签）仍会被 `readLearningTarget` 与新生 r3 记录**混在同一邻域求均值**，正是 P6.1-D 要消除的"不同标尺混估"类别（本轮合成评测用 per-task 冷启动库，不触发该路径，故不影响 §4 的结论）。**required fix（默认启用前必须完成）**：把 `CURRENT_REWARD_VERSION` 指向 `REWARD_CONTRACT.version`（或删除该常量统一到契约模块），在经验加载/升级路径对 `record.rewardVersion` 与当前契约版本做兼容判定（不兼容 → 按既有 marked-copy 机制隔离为 legacy/审计），并补一条判别测试（r2 记录不得进入 r3 估计）。建议在 t13/P6_STATUS 登记为 Gate-4 前的阻塞项。 |
| **F2** | low | **open（报告数字精度）** | t8 报告 §1 的池指纹 witness"`be05e090 → 73ba2b59 → 650d0bfa`，与公平评测报告同池"**无法用交付脚本复现**：`node scripts/eval/negative-result-diag.mjs --json` 两次运行均确定性输出 `75d57bdc → b73b0a8b → bd56d73e`（`frame.poolDigests`，witness=ci-01 三轮）；且所引值在 `docs/reports/p6-fair-eval.md` 中**检索不到**。**required fix**：用当前引擎重跑并把实际池指纹写回 §1（或删除该 witness），避免与"每个数字都来自一次真实执行"的声明冲突。 |
| **F3** | low | **open（报告数字精度）** | 两处不可核验/表述不准：① §5 H1 的"`ci-04\|2\|2` 的 noop 回报从 +0.30 变为 **+0.88**"——`+0.88` 在脚本、库与 `--json` artifact 中**均不存在**（`0.88` 零命中），无来源；② §9 称 `work/p61-e-diag.json`"含 180 条台账"，实际只存 `entries: 180`（计数）+ **4 条 sample**（`decisionLedger.sample = online.decisionLedger.slice(0,4)`，脚本 `:612`），且 §9 复现 −0.250 的一行命令是**无效 stub**（`const f=(l,rr,m)=>r;` 求值后丢弃）。**required fix**：补上 +0.88 的推导来源或删除该数字；把 §9 描述改为"计数 + 样例"并给出可运行的复现命令（直接用 diag 脚本即可，`matchesHistorical:true`）。 |
| **O1** | info | 观察（集成面，属 t13） | 当前 tree 的 `pnpm run check:docs` **红**：README `72 files / 1387 tests`（unit 62/1280、e2e 10/107）vs 实测 `73 files / 1443 tests`（unit 62/1296、e2e 11/147）——新增 `tests/e2e/host-smoke/*`（+40）与 t6 单测（+16）后 README 计数过期。t10 评审时同类问题出现过并被同步；建议 t13 在冻结树上统一同步 README 计数。**非本轮验收项**（本轮 verify 命令 typecheck / pnpm test 均 exit 0）。 |
| **O2** | info | 观察（正向证据） | 六条 7.4 测试 + value-estimator 契约测试具备真实判别力（§1 三次独立变异重放），且 t8 的 additivity 声明由 `jitrl-ablation` 24/24 parity 与 `eval-jitrl --json` exit 0 支撑。 |

---

## 7. 边界与漂移声明

- 评审期间 R3 相关字节**未漂移**：HEAD 与工作树 diff 指纹全程为 `7bce33ee…` / `58d78843…`，8 个关键文件 sha256 前后一致。
- 变异重放全部在 `%TEMP%\p61-r3-copy` 完成；副本与仓库 `src`+`tests` 逐文件 sha256 **diff 0**、副本基线/恢复后测试均绿，评审结束副本与 `%TEMP%` 探针脚本已删除。
- 未接真实宿主：t8 的 H6 已如实标注"重放差值不外推为生产结论、真实宿主行为差异归 Gate 4"，本轮不越界补结论。
- 合成集局限：报告 §6/§7 已声明"不重放训练集调参最优点当独立验证、小合成集不承诺统计显著性"，我未追加任何统计显著性主张。
- 未修改仓库 `src/**`、`tests/**`、`scripts/**`；本报告仅新增 `docs/reports/p61-review-round1-reward-eval.md`。
