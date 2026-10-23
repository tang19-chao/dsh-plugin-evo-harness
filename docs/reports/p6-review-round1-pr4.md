# PR4（R4）独立评审报告 — Gate 2 第 1 轮

| 项 | 值 |
| :-- | :-- |
| 被评任务 | t5「PR4 / R4：逐执行证据归因，重写 recordOnlineExperience 关联模型与 legacy 迁移」 |
| 评审任务 | t13（attempt `9fb64774-6d0a-4697-bf93-9762ae9db397`） |
| 评审人 | gate-reviewer |
| 被评字节（评审基准） | `src/orchestrator.ts` **ff67ea0b**、`src/types/contracts.ts` **8693026e**、`src/jitrl/experience-store.ts` **7b04b023**、`src/jitrl/backfill.ts` **c0c031d2**、`src/jitrl/step-evaluator.ts` **ff0949ab**、`tests/unit/orchestrator/credit-attribution.test.ts` **bf88a638**（sha256 前 8 位，最后检查时间 22:35） |
| 环境 | `7307d7d` + 共享工作树；Node `v22.23.1` |
| 结论 | **pass**：九项验收全部由评审人自行取证通过；1 条 low 观察项（L1 记录复用 L2 decisionId）不阻塞 |

方法：只读代码 + 自写探针。**所有归因证据都来自生产插件入口（`createEvoHarnessPlugin` + 持久化 JSONL）**，不是跑作者的测试替身；唯一借用作者 harness 的地方是"变异红证据"（见 §5，仓库存放副本、隔离于 `%TEMP%`）。除 `docs/reports/` 外未改仓库文件。

> ⚠️ 过程记录：评审期间（22:32:20 / 22:32:44）五个 PR4 文件被**外部重写两次**（行数先 2479→2168→2479 等），随后稳定。上表哈希即本次结论绑定的字节；若之后再次变动，按流程应由下一轮复评绑定新字节。

---

## 1. 关联链与版本号（§6.1）

生产路径跑一次混合结果任务（`candidateCount=2`、`maxWidth=2`、`maxDepth=2`、持久化开启），从 `jitrl-experience.jsonl` 读回 8 条原始记录。每条都带完整关联链，示例（原文截取）：

```
{"id":"online-evo-e2e-17","level":"meta","round":1,"slot":0,"nodeId":"evo-e2e-4","parentNodeId":"evo-e2e-2",
 "trajectoryId":"traj-2-g6zq23vs","decisionId":"jit-decision-evo-e2e-1-r1-s0","actionKey":"slot:exploit/…",
 "outcome":"succeeded","observedReturn":0.075,"attributionBaseline":-0.6,"learningTarget":0.675,
 "versions":["pi-0@v1","r2/verifiable-v1","p2/per-execution-v1",2]}
```

覆盖核对：`decisionId`、`runId`、`round`、`slotIndex`、`scopeKey`、`treeId`、`nodeId`、`parentNodeId`、`trajectoryId`、`policyVersion`(`pi-0@v1`)、`rewardVersion`(`r2/verifiable-v1`)、`provenanceVersion`(`p2/per-execution-v1`)、`experienceSchemaVersion`(2) **全部落盘**；`learningEligible`/`outcome` 亦在。迁移策略可按 sink 回滚（§4）。

## 2. 同 batch 成功/失败目标值不同（§6.6-1，核心判别力）

同一 run、同一 batch 的两个槽位（slot 0 成功 / slot 1 失败），**我自跑的原始记录**：

| 记录 | level | round | slot | nodeId | trajectoryId | outcome | return | baseline | target |
| :-- | :-- | --: | --: | :-- | :-- | :-- | --: | --: | --: |
| online-evo-e2e-17 | meta | 1 | 0 | evo-e2e-4 | traj-2-g6zq23vs | succeeded | 0.075 | −0.6 | **0.675** |
| online-evo-e2e-19 | meta | 1 | 1 | evo-e2e-6 | traj-3-2rnlz90n | failed | −0.6 | −0.6 | **0** |
| online-evo-e2e-18 | proposal | 1 | 0 | evo-e2e-4 | traj-2-g6zq23vs | succeeded | 0.075 | −0.6 | 0.675 |
| online-evo-e2e-20 | proposal | 1 | 1 | evo-e2e-6 | traj-3-2rnlz90n | failed | −0.6 | −0.6 | 0 |

- 逐轮统计：round 1 `distinctReturns=2 distinctTargets=2 distinctTrajectories=2`，`outcomes=["succeeded","succeeded","failed","failed"]` → **没有共享 winner return**。
- 全 8 条记录都满足 `learningTarget = clamp(observedReturn − attributionBaseline, ±3)`（自校验 `true`）。
- 失败槽位拿到自己的负 return（−0.6，rewardSources `{tool:-2,steps:0.5,turn:-2}`），不是 winner 的 +0.075。
- 轨迹/节点与树一一对应：**8/8 条记录**的 `nodeId + trajectoryId` 与 `treePool` 中真实执行节点的 `trajectoryId` 完全一致（§6.6-4）；L2 四条各自指向自己的 node/trajectory，未被写成 winner。
- 补偿性说明：round 2 两条目标值相同（都是 0.8），因为该夹具下两个槽位的可验证信号本身就相同——不是共享 winner 向量（该 run 只有一次 `evaluate_steps`，且只作用于 winner）。

## 3. 早轮记录、无赢家、未执行候选（§6.6-2/3、§6.2）

- **早轮仍有记录**：2 轮 run 的 JSONL 里 round 1 的 4 条记录完整存在（上表）；不再是只留最后一轮。
- **无赢家**：把全部候选设为失败（`candidateOutcomes` 6×fail）→ `outcome=probed`、8 条记录、`outcomes` 全为 `failed`、`eligible=8`、`traceHasEvaluate=false`（无赢家不调用模型评估）、`allExplainable=true`；returns 全为 −0.6（负样本保留），targets 全为 0（= 与 reference 基线同分，可解释）。
- **未执行候选无伪造**：`candidateCount=3` + `maxWidth=1` 场景 → 只产生 **2 条记录**（1 meta + 1 proposal），真实执行树节点只有 1 个 slot 节点，`every record maps to an executed node: true`，L2 计数 = 执行数（1）而不是候选数（3）。
- **先提交后落盘**：代码顺序 `tree.recordProbe(node.id, …)`（`orchestrator.ts:1313`）→ `executed.push({…})`（`:1329`），未执行候选根本不进归因集合；写经验只发生在 run 末 `record_experience`。

## 4. legacy 隔离、迁移回滚、mirror 旧聚合（§6.5）

| 检查 | 我自跑结果 |
| :-- | :-- |
| 无 schemaVersion 记录判为 legacy | `isLegacy(legacy)=true`、`isLegacy(current)=false`、`EXPERIENCE_SCHEMA_VERSION=2` |
| 版本分区 | `partitionByVersion: learning=8 legacy=1 ineligible=0` |
| mirror 旧聚合隔离 | `mirrorVisibleRecords: current=8 legacyExcluded=1 isolated=true mixedRewardVersions=false rewardVersion=r2/verifiable-v1` |
| 迁移产生标记副本 | `applied={"current":8,"legacy":1,"excludedFromLearning":1,...}`；audit 收到 1 条副本，`rewardVersion/provenanceVersion = "legacy"`（`LEGACY_VERSION_TAG`） |
| 回滚 | dry-run（`apply:false`）`marked=1` 但**零写入**；丢弃 audit sink 即回滚，源数组与源文件都不变 |
| 源日志不被原地改写 | ①迁移调用前后源数组 `unchanged=true`；②磁盘文件 sha16 不变（`9009f774594a7095 -> 9009f774594a7095`）；③**活路径**：在数据目录预置一条 legacy 行后启动新插件并完整跑一次任务 → 该行**逐字节不变**，新增 8 条记录全部 `experienceSchemaVersion=2` |

## 5. 变异红证据：回退成"统一复制赢家回报"（§6.6-6）

在 `%TEMP%\t13-revert`（HEAD 克隆 + 覆盖当前工作树 `src/tests/scripts`，克隆内 PR4 文件哈希与 §0 表一致 = **ff67ea0b/8693026e/7b04b023/c0c031d2/ff0949ab**）把非赢家分支改回"复制赢家 return 向量"（`sha 40aa6a9d`），跑作者的新测试：

```
 ❯ tests/unit/orchestrator/credit-attribution.test.ts (24 tests | 5 failed)
   × 6.6 (1) gives the failed slot its own negative target instead of the winner return
     → expected 4.5 to not be close to 4.5, received difference is 0
   × 6.6 (1) does not give two succeeded slots the same return when only one was evaluated
   × 6.6 (2) keeps round 1 records when the run reaches round 2
   × 6.6 (6) never lets two different executions share one return value
     → round 1 shares one return: expected 1 to be greater than 1
   × 6.6 (6) does not carry a winner return across rounds
     → expected 4.5 to be less than 0
 Test Files 1 failed (1)   Tests 5 failed | 19 passed (24)   MUTATION_SUITE_EXIT=1
```

同一文件在**当前字节**下：`24 passed`；连同 `experience-store.test.ts`(37) 与 `backfill.test.ts`(25) 共 **86 passed，退出码 0**。判别力成立，且失败点精确落在"共享 winner return"这一缺陷上。

## 6. 并行完成顺序与确定性（§6.6-5、§6.4）

- 用自写 runBranch 包装器：**先按调用序计算结果，再按槽位施加不同延迟**，从而只改变"完成顺序"、不改变场景语义。两次运行的可观测完成顺序确实不同（解析序 `[0,1,2,3,4]` vs `[0,2,1,3,4]`），而经验集合**完全相同**（投影逐行相等，含 nodeId/actionKey/outcome/observedReturn/learningTarget）。
- 同输入重跑两次 → 投影完全相同（确定性）。
- 代码保证：归因顺序显式排序 `(round, slotIndex, nodeId)`（`orchestrator.ts:1807-1815`），写入在 run 末一次提交（波次屏障），`experienceDedupKey` 去重（`:1975`），因此同轮 sibling 完成先后不影响经验集合与下一轮可见窗口。

## 7. 未回退 t1 的 runtime gate（§10 项）

当前字节仍保有原结构：`surfaceEnabled('onlineRecord')` 三处（`orchestrator.ts:1796` 打分前、`:1849` evaluate 后、`:1990` append 前）、`surfaceEnabled('proposal')` 两处（`:2116`、`:2156`）、generation 快照/重读（`:1828/1850`、`:2145/2156`）。未发现用 `kernel.config.enabled` 决定运行时开关的新路径。

---

## 8. 验收清单

| 验收项 | 结果 | 证据 |
| :-- | :-- | :-- |
| 关联字段覆盖 + 迁移可回滚 | **passed** | §1、§4 |
| 同 batch 成功/失败目标值不同（不共享 winner return） | **passed** | §2：0.675/−0.6/0 vs 0；逐轮 distinctTargets=2 |
| 最后一轮之前的好动作仍有记录 | **passed** | §3：2 轮 run 保留 round 1 的 4 条 |
| 无赢家时已执行失败动作有可解释记录 | **passed** | §3：8 条 failed、无 evaluate_steps、returns −0.6、targets 0 |
| 未执行候选无伪造 reward | **passed** | §3：3 候选 1 槽 → 2 条记录，全部映射到执行节点 |
| L2 的 actionKey/nodeId/trajectoryId 与真实执行一一匹配 | **passed** | §2：8/8 与树节点 id+trajectoryId 一致 |
| 并行完成顺序不改变经验集合/可见窗口 | **passed** | §6：完成序不同、集合相同；确定性排序 + 单次提交 |
| legacy 隔离 + mirror 旧聚合隔离 + 原始日志未原地改写 | **passed** | §4（含活路径逐字节比对） |
| 变异"统一复制赢家回报"使测试变红 | **passed** | §5：5 failed / 退出码 1 |
| 未回退 t1 runtime gate 结构 | **passed** | §7 |

## 9. 观察项（low，非阻塞）

**PR4-L1**：L1（`level:"meta"`）记录与同槽位 L2 记录**共用同一个 `decisionId`**（都是 L2 选择的 `jit-decision-<runId>-r<n>-s<m>`），因为 `orchestrator.ts:1906` 用 `probe.selection?.decisionId ?? 'jit-meta-decision-…'`，而有 selection 时永不走 fallback。追溯性未断（level/slot/round/nodeId/trajectoryId 都在，仍可定位），但"这一条 L1 记录由哪个 L1 决策产生"被 L2 决策 id 覆盖，审计上略含糊。建议：`level==='meta'` 时使用 L1 决策 id（或新增独立字段区分 selectionDecisionId 与 metaDecisionId），并补一条断言两条记录 decisionId 语义不同的测试。因不违反任何验收项，不影响本轮 verdict。

## 10. 边界声明

- 未跑全量 `pnpm test`/`typecheck`/`build`（共享工作树含其他 PR 在途改动，无法归因）；本次定向跑 PR4 三个测试文件共 86 用例 + 自写生产路径探针。
- 未接真实 DSH 宿主/真实模型：`stepEvaluator` 与轨迹均为脚本夹具（Gate 4 范围）。因此"没有 LLM judge、每 run 至多一次模型评估"只在夹具层面验证（trace 单次 `evaluate_steps` + 作者断言 evaluatorCalls=1）。
- 评审期间 PR4 字节被外部重写两次（见文首提示）；本结论绑定 §0 表中哈希。
- 未修改仓库 `src/**`、`tests/**`、`scripts/**`；克隆、临时探针与临时数据目录已清理。
