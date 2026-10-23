# PR4 评审（第 2 轮）— 绑定稳定修订的复评与 PR4-L1 处置

| 项 | 值 |
| :-- | :-- |
| 被评任务 | t5「PR4 / R4：逐执行证据归因」 |
| 评审任务 | t23（attempt `66528362-c7df-48b8-9f1c-8287cf496740`） |
| 上轮评审 | t13（round 1, verdict=pass），被调度器判为"不绑定稳定修订" |
| 冻结修订（sha256 前 8 位） | `src/orchestrator.ts` **ff67ea0b**（mtime 22:32:44）、`src/types/contracts.ts` **8693026e**（22:32:44）、`src/jitrl/experience-store.ts` **7b04b023**（22:32:44）、`src/jitrl/backfill.ts` **c0c031d2**（22:32:44）、`src/jitrl/step-evaluator.ts` **ff0949ab**（22:32:44）、`tests/unit/orchestrator/credit-attribution.test.ts` **bf88a638**（22:11:05） |
| 环境 | `7307d7d` + 共享工作树；Node `v22.23.1` |
| 结论 | **pass** — 关键判别力证据在冻结字节上全部复现；PR4-L1 **接受为已知限制**（附审计影响与可选后续） |

## 0. 为什么有这一轮 / 观测窗口是否稳定

上一轮（t13）的 pass 被判定为"不绑定稳定修订"，原因是**评审期间另外两个文件在动**（`src/cordis-seams/dsh-hook-host-adapter.ts` 578a044f→d5ac1f2d、`src/jitrl/host-tool-experience.ts` 3325d89c→813928d8→32399b0d，属 PR3/t18 的返修）。captain 已确认 PR4 五文件当时是被其 `git stash push/pop` A/B 对照短暂移出又恢复。

本轮开工前与收工后的两次复核一致，且窗口内无写入：

| 文件 | 开工前 | 收工后 | 结论 |
| :-- | :-- | :-- | :-- |
| orchestrator.ts | ff67ea0b | ff67ea0b | 未变 |
| contracts.ts | 8693026e | 8693026e | 未变 |
| experience-store.ts | 7b04b023 | 7b04b023 | 未变 |
| backfill.ts | c0c031d2 | c0c031d2 | 未变 |
| step-evaluator.ts | ff0949ab | ff0949ab | 未变 |
| credit-attribution.test.ts | bf88a638 | bf88a638 | 未变 |

全部与 t13 绑定的哈希**逐位相同**；`git stash list` 为空；PR3 返修文件在 22:34:13 / 22:38:58 之后未再移动（本轮全部观测在 22:42 之后）。→ 本凭证绑定的是一个稳定修订。

## 1. 关键判别力证据（自写探针，生产入口 + 持久化 JSONL）

探针走 `createEvoHarnessPlugin` + `createPersistenceRuntime`，从 `jitrl-experience.jsonl` 读原始记录；13 项断言 **13 PASS / 0 FAIL**。原始记录（节选 round 1）：

```
{"id":"online-evo-e2e-17","level":"meta","round":1,"slot":0,"nodeId":"evo-e2e-4","trajectoryId":"traj-2-qxkue4q9",
 "decisionId":"jit-decision-evo-e2e-1-r1-s0","outcome":"succeeded","observedReturn":0.075,"baseline":-0.6,"target":0.675,
 "rewardSources":{"evaluated":0,"tool":0.5,"turn":1},"versions":["pi-0@v1","r2/verifiable-v1","p2/per-execution-v1",2]}
{"id":"online-evo-e2e-19","level":"meta","round":1,"slot":1,"nodeId":"evo-e2e-6","trajectoryId":"traj-3-ffn83pzl",
 "decisionId":"jit-decision-evo-e2e-1-r1-s1","outcome":"failed","observedReturn":-0.6,"baseline":-0.6,"target":0,
 "rewardSources":{"tool":-2,"steps":0.5,"turn":-2},"versions":["pi-0@v1","r2/verifiable-v1","p2/per-execution-v1",2]}
```

| 断言 | 结果 |
| :-- | :-- |
| A1 同 batch 判别力 | round 1 `records=4 distinctReturns=2 distinctTargets=2`，outcomes `["succeeded","succeeded","failed","failed"]`，targets `[0.675,0.675,0,0]` |
| A2 无共享 winner return | failed `observedReturn=[-0.6,-0.6]`、succeeded `[0.075,0.075]`，两组互不相同 |
| A3 目标恒等式 | 8/8 条满足 `learningTarget = clamp(observedReturn − baseline, ±3)` |
| A4 节点/轨迹一一对应 | **8/8** 条记录的 `nodeId+trajectoryId` 与 `treePool` 真实执行节点一致 |
| A5 L2 各自指向本槽 | 4 条 L2 记录各自与其同槽 meta 记录的 node/trajectory 相同（未被写成 winner） |
| A6 早轮保留 | round 1 与 round 2 各 4 条并存 |
| B1 无赢家 | `outcome=probed`、8 条全 `failed` |
| B2 无赢家不评估 | trace 中无 `evaluate_steps` |
| B3 可解释 | returns 全为 −0.6（负样本）、targets 全为 0、三字段均为 number |
| D1 未执行候选无伪造 | 3 候选 / 1 槽 → 仅 2 条记录、L2=1、probe 节点=1、全部映射到执行节点 |
| C1 版本隔离 | `partitionByVersion` learning=8/legacy=1；`mirrorVisibleRecords` legacyExcluded=1、`isolated=true`、`rewardVersion=r2/verifiable-v1` |
| C2 迁移只写 audit 副本 | 源数组与磁盘 sha16 均不变；dry-run `marked=1` 可回滚 |
| C3 活路径不改写 | 预置 legacy 行的数据目录上跑完整任务：该行**逐字节不变**，新增 8 条全部 `experienceSchemaVersion=2` |

数值与 t13 完全一致（0.675 / 0 / 0.8；8/8 匹配）。

## 2. 其他复核项

- **PR4 三个测试文件**：`credit-attribution`(24) + `experience-store`(37) + `backfill`(25) = **86 passed，退出码 0**（冻结字节）。
- **runtime gate 未被回退**：`surfaceEnabled('onlineRecord')` 三处（`orchestrator.ts:1796/1849/1990`）、`surfaceEnabled('proposal')` 两处（`:2116/:2156`）、`runtimeGeneration()` 快照与重读（`:1828/:1850/:2145/:2156`）均在。
- **变异红证据（本轮重做，绑定冻结字节）**：克隆 `7307d7d` + 覆盖当前工作树 `src/tests/scripts`，克隆内 `orchestrator.ts` sha=ff67ea0b（与仓库一致）；把非赢家分支改回"复制 winner return 向量"（mutated sha `3b4b184d`）→ `credit-attribution.test.ts` **5 failed | 19 passed (24)**，退出码 1。判别力在冻结字节上成立（与 t13 同一结果）。

## 3. PR4-L1 处置结论：**接受为已知限制**（不要求修复）

**事实**（`orchestrator.ts:1906`）：
```ts
const decisionId = probe.selection?.decisionId ?? 'jit-meta-decision-' + input.runId + '-r' + String(probe.round);
```
`probe.selection.decisionId` 是 L2 选择决策（`:1202` `jit-decision-<runId>-r<round>-s<slot>`）。同一次执行会落两条记录（`level:'meta'` 与 `level:'proposal'`），**两条共用该 L2 decisionId**；`jit-meta-decision-…` 兜底只在没有 selection 时使用。

**审计影响（明确写出，供 Gate 2 引用时不要越读）**：
- 记录仍然**唯一可追溯**：`level + runId + round + slotIndex + nodeId + parentNodeId + trajectoryId` 足以定位到具体执行；`observedReturn/baseline/target` 逐条正确。
- 不能从 `decisionId` 判断"该 L1 记录由哪个**meta**决策产生"：它指向的是授权该次执行的 L2 选择决策。契约注释（`contracts.ts:1325` "which decision produced the action"）在该口径下**不算错**（执行是被 L2 选择授权的），但**不是按层区分的 id**。
- **无功能影响**：全仓 `decisionId` 的消费点（`experience-store.ts` 的持久化/读回、`commands.ts` 的 *decision* 对象）都不按它分组或 join；去重键 `experienceDedupKey` 也不含 `decisionId`。因此学习、检索、镜像与去重均不受影响。
- **不影响 Gate 2 任何验收项**（traceability/失败样本/未执行候选/legacy 隔离）。

**可选后续（非阻塞，若 Gate 汇总或未来消费者需要按层归因再做）**：`level==='meta'` 时改用独立的 meta 决策 id（或拆出 `metaDecisionId` 字段），并补一条断言两类记录的 decisionId 语义不同的测试。若将来出现"按 decisionId 聚合经验"的消费者，本限制需重新评估。

## 4. 边界与方法论

- 本轮**未重做 t13 的全部九项验收**（按 captain 的范围收缩）：t13 的完整证据在字节层面依然成立（六文件哈希逐位相同），本轮只重跑关键判别力证据 + 绑定稳定修订 + 处置 PR4-L1。
- 未跑全量 `pnpm test`/`typecheck`/`build`（共享工作树含其他 PR 在途改动，无法归因）；本轮定向 86 用例 + 自写探针 13 项。
- 未接真实 DSH 宿主/真实模型（脚本夹具，Gate 4 范围）。
- 采纳其他成员的避坑情报并已应用：①判 `jit` 相关断言前先确认对象不是 `undefined`（`createDefaultPolicy` 不携带 `jit`，`makePolicy({...,jit})` 会静默丢弃——我上轮已注意到并如实写出"incumbent 无 jit 块"的边界）；②沙箱/克隆必须与主工作树同一份 `src/tests`（本轮克隆以 `Copy-Item src/tests/scripts` 覆盖，并以克隆内 `orchestrator.ts` sha=ff67ea0b 自证一致）。
- 未修改仓库 `src/**`、`tests/**`、`scripts/**`；探针、克隆与临时 junction 已清理（仓库 `node_modules` 完整性已复核）。
