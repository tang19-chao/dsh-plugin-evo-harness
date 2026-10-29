# t2 复核报告：Dreamer 全部发布效果点覆盖矩阵

> 任务：t2 `[release-audit]` 复核 Dreamer 全部发布效果点（只读复核普通 / Jit-wired Dreamer、任务周期与 idle 的真实 apply/update 链与改进 fixture，产出覆盖矩阵）。
> 执行者：release-engineer（C1.1 Dreamer 发布边界工程师），attempt `4fa56c6c-05ad-429f-87c8-98947d03ed98`。
> 性质：**只读审计**。本任务对 `src/**`、`tests/**`、`scripts/**` **零改动**；唯一新增文件是本报告本身（`docs/reports/`）与 gitignored 的 `work/t2-dreamer-probe/` 探针目录。所有探针使用 `os.tmpdir()` 下的临时数据目录与内存 fixture，零网络、零真实模型、零真实 memory 写入。
> 定位：为 t1（ADR-0003 冻结）与 t4（C1.1 实现）提供**截至当前工作树**的效果事实与回归缺口清单；本报告不作实现，也不宣称任何收益。

---

## 0. captain 裁定（2026-10-26，本审计提交后下达；优先级高于本报告的建议）

> **本节是后加的裁定记录，不是审计结论。** 本报告 §1–§9 的事实陈述全部保持原样（它们仍是对 `9ea9b7e` 工作树的准确观测）；但 §6 与 §10-5 里属于**建议/待裁定**的部分，其口径以下表为准。裁定原文为 captain 消息，逐条转写如下并标注受影响的报告条目。

| # | 裁定 | 影响的本报告条目 |
| --- | --- | --- |
| R1 | **热替换和 revision 都归 publish，全 deny** | §6 的语义冲突已被裁定（按 ADR-0002 §3 的"零副作用"读法），不再需要"要么改 ADR、要么改测试"的二选一；`offline-dreamer.test.ts:515/539`、`jit-dream.test.ts:922`、`runtime-control.test.ts:319`、`dream-rsi-pipeline.test.ts:227` 的"improved 即热替换"期望**须按 ADR 修正** |
| R2 | **缺省 holdout 不可当发布证据** | 证实 F4；且把"`validatedOnHoldout===undefined` 仍然 `publish:true`"（`decision-kernel.ts:1198-1203`）定性为**必须收紧**，而非仅"生产未启用" |
| R3 | **idle deny 建议需可审计，至少不能消失或假 published** | 证实 F3；把"idle 发布不进 `dreamReports`"从可观测性缺陷升级为**本轮必须修**项 |
| R4 | **普通 Dreamer 忽略 `config.jitrl.dream` 不在本轮扩修，只登记** | **§6 表格第 5 行（`src/index.ts:1668` 传 `generatePolicies`）本轮不执行**；F5 保留为已登记限制，t4 不得顺手扩修 |
| R5 | **实现须同时做上层 shadow 派生与真实 apply 边界授权，不能只移除 callback** | §6 第 1 行的建议**被扩展而非取代**：仅靠 `shadowMode` 派生（上层）不足以满足裁定，还必须在**真实 apply 点**（`offline-dreamer.ts:1844-1846` 或其装配侧等价边界）加授权判定。§5 已证明"只移除 `applyPolicy`"会产出假 published，与本裁定方向一致 |
| R6 | **t7 验收以策略对象、revision/磁盘增量和报告事实为准** | 证实 §4 与 §10-3 的"不得以权限布尔值当证据"；t7 的最小证据集固定为：策略对象身份/版本、`policy.current.json`+`policy.history.jsonl` 增量、`publication.publish`/`shadow.published`/`improved`/`suggestedPolicyId` 四个字段 |

**裁定后的本轮范围（据此收窄 §6）**：修 R1+R2+R3+R5（上层派生 + 真实 apply 边界授权 + holdout 不作为证据 + idle 可审计）；**不修** R4；F6 的"在线配置被静默改写"链条在 R1 生效后**自然断开**（无 publish 即无 `applyPolicy`，故不会再写 `policy.jit`），保留为"若将来授权 publish 则重新暴露"的潜在风险登记，不在本轮单独修。

### 0.1 R2 的可行性预检（为 t4 省一轮返工；只读测量，未改 src）

captain R2 要求"缺省 holdout 不可当发布证据"，即收紧 `decision-kernel.ts:1198-1203` 的兜底分支。t4 需要先知道**这会波及哪些既有断言**。我用 `work/t2-dreamer-probe/r2feasibility.ts` 与 `breakage.ts` 复现了仓库现有每一处发布相关夹具，拿真实 `decideReplayPublication` 与"收紧规则"（`validatedOnHoldout !== true ⇒ 不发布`）对同一输入逐条比对：

**A. 内核直调用例（`decision-kernel-parity.test.ts:1245-1274`）——全部兼容，零改动**

| 用例 | 今日 `publish` | R2 后 | 是否翻转 |
| --- | --- | --- | --- |
| `shadowMode:true` | false | false | 否 |
| `validatedOnHoldout:false` | false | false | 否 |
| `validatedOnHoldout:true` | true | true | 否 |
| `improved:false` | false | false | 否 |
| **`improved:true`（无 holdout，生产形状）** | **true** | **false** | **是（唯一翻转点）** |

**B. Dreamer 夹具（现有热替换测试）——R2 会打破其中 4 处**

| 现有测试 | 夹具是否配 holdout | 今日是否 `applyPolicy` 被调 | R2 后 |
| --- | --- | --- | --- |
| `offline-dreamer.test.ts:515-537` hot-swaps | **否** | 是 | **破**（断言 `applied.length===1`） |
| `offline-dreamer.test.ts:539-558` injected activePolicy | **否** | 是 | **破** |
| `dream-rsi-pipeline.test.ts:250-277` activePolicy | **否** | 是 | **破** |
| `jit-dream.test.ts:922-975` 两轮 beta | **否** | 是 | **破** |
| `dream-rsi-pipeline.test.ts:227-278` | 否 | 否（该夹具 `improved=false`） | 通过（不涉及发布） |
| `offline-dreamer.test.ts:966-1013` `shadowMode:true` | — | 否 | 通过 |
| `offline-dreamer.test.ts:1015-1071`、`:1073-1117`（显式 `holdoutTreeCount:1`） | 是 | 视验证结果 | 通过（`validatedOnHoldout` 有定义） |

**结论（三条，直接给 t4）**：

1. **R2 的收紧点唯一且安全**：只翻转"`improved=true` 且无 holdout"这一种输入，`shadowMode` / `validatedOnHoldout:false` / `validatedOnHoldout:true` / `improved:false` 四条既有断言**逐条不变**——所以 R2 不会与 `decision-kernel-parity.test.ts` 冲突，t4 可以放心改这一行。
2. **R2 独立于 R1 就会打破 4 处热替换测试**（它们都没配 holdout）。也就是说 R1 与 R2 的"需修测试集合"**完全重合**，t4 只需修一次这 4 处，不存在两套互相冲突的修正。
3. **R2 还顺带堵住了生产路径**：生产装配从不传 `holdoutTreeCount`（F4；全仓 `grep` 确认 `src/**` 对该字段**零引用**，只有 `offline-dreamer.test.ts:1020/1091` 手工传过），故 R2 一生效，生产 dream 的 `publish` 立即恒为 false。我用 `r2defence.ts` 走完整生产链实测 8 个用例（四模式 × Jit on/off）：**全部 `holdoutTreeIds=[]`、`validatedOnHoldout=undefined`，今日 `publish=true`，仅施加 R2 后 `publish=false`，无一例外**（`r2defence.json` → `r2AloneBlocksEveryProductionCase: true`）。因此 R2 是**独立于 R1/R5 的纵深防线**；但反过来不成立——R2 只堵生产路径，手建 dreamer（无 profile）与将来显式配 holdout 的路径仍需 R1+R5。这正是 captain 要求"不能只移除 callback"的另一层含义：三道闸（上层派生 / 真实边界授权 / holdout 证据）任一单独成立都不足以放行。

---


## 0. 绑定基线

| 项 | 值 |
| --- | --- |
| HEAD | `9ea9b7edacb199884df2020df879f4e59ed66d73`（`9ea9b7e` feat(p6.2): close C0+C1 release contract and safe defaults） |
| 工作树 diff 指纹（tracked） | `e69de29bb2d1d6434b8b29ae775ad8c2e48c5391`（`git diff \| git hash-object --stdin`；仅未跟踪文件，故为空树哈希） |
| 未跟踪文件（本报告写作前） | 1 项：`docs/reports/c2a-trusted-verification-wiring-audit.md`（t3 并行产出，非本任务改动） |
| 环境 | win32/x64，Node `v22.23.1`，pnpm `11.7.0`，vitest `3.2.7` |
| 全量测试（本任务实测） | `pnpm test` → **77 files / 1562 tests all passed**，exit 0 |
| typecheck | `pnpm run typecheck` → exit 0 |
| 门禁 7 | `node scripts/eval/guarded-regression.mjs --json` → exit 0，`{total:25, passed:25, failed:0}` |

关键文件 sha256（前 16 位，本次实测，用于 t4 变更前后对比）：

| 文件 | sha256 | 文件 | sha256 |
| --- | --- | --- | --- |
| `src/index.ts` | `f686a36f4002a964` | `src/dream-rsi/offline-dreamer.ts` | `42811c38795a91f5` |
| `src/orchestrator.ts` | `85268ed056cf29ff` | `src/jitrl/decision-kernel.ts` | `69647913db8c399e` |
| `src/runtime/execution-profile.ts` | `69e8a44145b69ade` | `src/jitrl/jit-active-policy.ts` | `f528cf00d93e43c3` |
| `src/persistence/policy.store.ts` | `c7dc99263ab6af52` | `src/host-triggers.ts` | `e34546ac0a28900c` |
| `src/config.ts` | `9e194dbccf16e651` | `tests/unit/p62/release-contract.test.ts` | `8876af317be20052` |
| `tests/unit/jitrl/runtime-control.test.ts` | `c6821ec3e9a38aaa` | `tests/unit/dream-rsi/offline-dreamer.test.ts` | `b1418bd9e95a0be0` |
| `tests/unit/dream-rsi/jit-dream.test.ts` | `65c3f653133513c3` | `tests/unit/dream-rsi/dream-rsi-pipeline.test.ts` | `438378f851e791f9` |
| `scripts/eval/guarded-regression.mjs` | `b0aa51220f63d70a` | `tests/e2e/fixtures.ts` | `4d1d786ccae00eea` |

---

## 1. 结论摘要（先行）

**核心结论（blocker 级，直接影响 t4 的验收口径）**：在当前工作树上，**默认装配（`execution.mode=shadow`，`publish` 权限恒 `false`）的 Dreamer 会真实热替换在线活动策略，并写入一条持久的策略 revision**。四种模式（baseline / shadow / guarded-active / off）以及 idle 入口**全部**如此，`/evo jit off` 也不阻断。原因是生产装配从未给 dreamer 传 `shadowMode`，而 `decideReplayPublication()` 在 `shadowMode !== true` 且 `improved` 时返回 `publish: true`，随后 `offline-dreamer.ts:1844-1846` 调用 `applyPolicy`。

| # | 事实 | 级 | 证据 |
| --- | --- | --- | --- |
| F1 | 默认 shadow 下，一次任务周期的 dream 把在线策略从 `pi-0@3` 换成 `pi-0::dream-2@4`，并新增 1 条持久 revision；四种模式 + 手建默认全部一致 | **blocker** | §3.1、§3.2；`work/t2-dreamer-probe/entries.json` |
| F2 | `publication.publish=true`、`shadow.published=true`、原因字符串为 "the candidate strictly improved the replayed hypervolume"——与 `publish` 层权限 deny 并行存在 | **blocker** | §3.1；`effect.json`、`cf.json` |
| F3 | idle 入口（`agent/status` → `idle`）同样热替换活动策略并写 revision，且**不产生任何 `dreamReports` 条目**，`recordDream` 也不调用 → 该发布路径对状态面不可见 | **high** | §3.3；`idle.json` |
| F4 | 生产装配从不传 `holdoutTreeCount`，门的"留出验证"半边在生产中**恒为惰性**：`publish` 完全由 `improved` 决定（captain R2 已裁定该兜底分支必须收紧） | **high** | §3.4、§0.1；`last.json`、`r2defence.json`、源码 `src/index.ts:1642-1668` |
| F5 | 普通（非 Jit-wired）Dreamer 用**冻结的默认扰动网格**生成候选，忽略 `config.jitrl.dream`（`hyperparamPerturbation=false` 与 `candidateJitBetas` 均不生效） | **high** | §3.5；`run-plaingrid`、`run-minfix` |
| F6 | 该被忽略的网格仍会把 `jit` 块写入活动策略并持久化；重启后 L1 装饰器 `effectiveConfig()` 以 `policy.jit` 覆盖构造期 `config.jitrl.{beta,k,similarityThreshold}` → 真实在线决策被改写 | **high** | §3.6；`restart.json`（持久化部分）+ 仓库自带决定性测试 `jit-active-policy.test.ts:1415`/`:1679`（合并规则部分） |
| F7 | 现有 1562 例测试与 25 条 guarded regression 探针**全部通过**，但**没有任何一条**覆盖 F1–F6 的真实效果点：`release-contract.test.ts` 对 Dreamer 只有 1 处（`t12/R1c` 断言 replay 声明字符串，且以 `trees: []` 调用，不会走到发布分支），`guarded-regression.mjs` 的 `dreamer` 一律是 `{}` 空对象 | **blocker(覆盖缺口)** | §4、§5 |

**修复方向的最小验证（已按 §0-R5 修正口径）**：在同一生产链上，仅把 `shadowMode: true` 注入 dreamer base 选项，即可让四模式 + 两入口的 `publish=false / policy 不变 / revision 增量 0`，同时 `improved=true` 与 `suggestedPolicyId` 仍成立（§5 反证实验）。但这**只是上层派生**；captain R5 明确要求**同时**在真实 apply 边界加授权判定（`offline-dreamer.ts:1844-1846` 或其等价侧），不能只依赖上层 `shadowMode` 或只移除 callback。另注意"仅移除 `applyPolicy`"会产出假 published（§5 末段），与本裁定方向相反。

---

## 2. 真实 apply/update 链（静态追踪，逐跳标注）

### 2.1 生产装配：谁把 `applyPolicy` 交出去

| 跳 | 位置 | 事实 |
| --- | --- | --- |
| ① | `src/index.ts:1642-1649`（`dreamBase`） | 只传 `now / treePool / activePolicy / policyCount / rhoPreferences / modelAdapter`。**没有** `shadowMode`，**没有** `holdoutTreeCount`，**没有** `applyPolicy` |
| ② | `src/index.ts:1650-1668` | 有 JitRL kernel 时用 `createJitWiredDreamer({ base: dreamBase, ... })`，否则 `createOfflineDreamer(dreamBase)`——**两条路径共用同一个不含 `shadowMode` 的 base** |
| ③ | `src/index.ts:1216-1250`（Jit-wired `replay()` 内） | `baseOptions = { ...input.base, generatePolicies, experiences }`；jit on 分支加 `jitHook`/`driftRho`；**jit off 分支显式覆写 `applyPolicy`**（只钉 `jit` 块），仍调用 `input.base.applyPolicy` 或 `holder.update(pinned)` |
| ④ | `src/dream-rsi/offline-dreamer.ts:1678-1684` | `this.applyPolicy = options.applyPolicy ?? (activePolicy === undefined ? undefined : (policy) => activePolicy.update(policy))`——**`activePolicy` 存在即自动获得 `applyPolicy`** |
| ⑤ | `src/dream-rsi/offline-dreamer.ts:1834-1846` | `publication = decideReplayPublication({ improved, shadowMode: this.shadowMode, validatedOnHoldout })`；**`if (publication.publish && bestCandidate && applyPolicy) await this.applyPolicy(...)`** |
| ⑥ | `src/jitrl/decision-kernel.ts:1162-1203` | `!improved → publish:false`；`shadowMode===true → publish:false`；`validatedOnHoldout===false → publish:false`；**其余 → `publish: true`**。`validatedOnHoldout` 只在 `holdoutTreeCount > 0` 时才被赋值 → 生产恒 `undefined` |
| ⑦ | `src/dream-rsi/offline-dreamer.ts:1850-1871` | `shadow.published = publication.publish`——所以 `shadow.published=true` 并非 shadow 语义，而是"真的发布了" |
| ⑧ | `src/persistence/policy.store.ts:493-498`（`PersistentActivePolicy.update`） | `base.update(policy)` + `store.savePolicy(policy)` → `saveCurrent` + `recordRevision` |
| ⑨ | `src/orchestrator.ts:3148-3186`（`runDream`）与 `:1789-1803`（`shouldDream` 触发） | 任务周期唯一 dream 入口；`runDream` 自身**不看 `executionProfile`**，与 `surfaceEnabled()` 完全无关 |
| ⑩ | `src/index.ts:2751-2763`（`dreamRun`）→ `src/host-triggers.ts:565-613`（`runIdleDream`） | idle 入口直接调 `deps.dreamer.replay({...})`，**也不看 `executionProfile`** |

**要点**：发布判定的唯一闸门是 `decideReplayPublication` 的 `shadowMode` 输入，而 `executionProfile.permissions.publish` 在整条链上**从未被读取**（`grep` 全仓：`permissions.publish` 只出现在 `src/index.ts:1761` 的诊断字符串与 `src/orchestrator.ts:2437` 的记录字段里）。

### 2.2 四种模式与两个入口的实际可见差异

| 模式 | `executionProfile` 对 dream 的影响 | 实际发布 |
| --- | --- | --- |
| baseline | 仅影响 L1 `interceptExecution` 与 replay 声明（`recordModeOf('baseline')='baseline'`）；**不影响 `runDream`** | **发布** |
| shadow（默认） | `shadowRecords=true` 只影响在线记录三元组，**不传给 dreamer** | **发布** |
| guarded-active | 同上；`permissions.patch.allowed=true` 只影响 `applyWinningPatch` 挂载点，**不影响 dream** | **发布** |
| off | `off=true` 使 `surfaceEnabled()` 对所有 Jit 面返回 false，且 `recordModeOf('off')='baseline'`；**`runDream` 不读 `surfaceEnabled`** | **发布** |

---

## 3. 实测证据（生产链路，非类单测）

所有探针通过真实工厂装配（`buildOrchestratorDeps` / `createEvoHarnessPlugin` / `createEvoHarnessOrchestrator` / `createPersistenceRuntime`），使用真实 `os.tmpdir()` 数据目录。运行命令与产物见 §8。

### 3.1 四种模式 × 任务周期（`plugin.run`，`offlineDreamTriggerEveryNTasks=1`）

夹具：1 棵深树（4 个浅层兄弟 0.10/0.30/0.20/0.15 + 3 层可下钻 0.35/0.40/0.55），`candidatePoliciesCount=3`，`maxWidth=4 / maxDepth=1`（宽浅基线）。

| 模式 | Jit kernel | `dreamTriggered` | `improved` | `publication.publish` | `shadow.published` | 策略变化（种子 `pi-0@3`） | revision 增量 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| shadow（默认） | 有 | true | true | **true** | **true** | `pi-0@3` → `pi-0::dream-2@4` | **+1** |
| shadow（默认） | 无（普通 Dreamer） | true | true | **true** | **true** | 同上 | **+1** |
| baseline | 有 | true | true | **true** | **true** | 同上 | **+1** |
| guarded-active | 有 | true | true | **true** | **true** | 同上 | **+1** |
| off | 有 | true | true | **true** | **true** | 同上 | **+1** |

（`work/t2-dreamer-probe/entries.json` → `runs[]`，种子策略 `pi-0@3`；`effect.json` → `cuts[]` 是同一结论的独立复现，其种子为 `pi-0@1`，故显示 `pi-0@1 → pi-0::dream-2@2`——两个探针的 version 绝对值不同，语义一致。）

一条实际报告字段（`effect.json`，种子 `pi-0@1`）：

```
mode=shadow  publishPermission=false  patchPermission=false
publication: { publish: true,  reason: "the candidate strictly improved the replayed hypervolume" }
shadow:      { published: true, suggestedPolicyId: "pi-0::dream-2" }
live policy  before { id: "pi-0",          version: 1 }
after        { id: "pi-0::dream-2", version: 2 }   // version 同步 +1，id 与 version 双变
durable      policy.history.jsonl: 0 → 1 行；policy.current.json: "pi-0::dream-2"
```

**注意 `patchIds`**：`orchestrator.activePatchIds()` 在所有模式下均为空——永久 patch 挂载确实被 profile 挡住了。也就是说，**patch 层的 deny 是真实生效的，publish 层（Dreamer 热替换）没有**。这正是 C1.1 的漏点。

### 3.2 连续两次 dream 的叠加

```
dream#1: improved=true  pi-0 → pi-0::dream-2@2        history 0→1
dream#2: improved=true  pi-0::dream-2 → pi-0::dream-2::dream-2@3   history 1→2
dream#3: improved=false （不再变更）                    history 2→2
tree-pool log: 0 → 2 → 3 → 4（每次 dream 都把重放的树重新 add 回池；见 §9-4）
```

（`work/t2-dreamer-probe/seq.json`。）策略 id 逐轮层层嵌套（`pi-0::dream-2::dream-2`），version 单调递增——这是 `ActivePolicyImpl.update()` 的 `version` 不回退校验允许的，不是新缺陷，但说明**发布是持续累积的，不是一次性事件**。

### 3.3 idle 入口（`agent/status` → `idle`）

| 挂载方式 | mode | `publish.allowed` | 策略变化 | revision 增量 | `dreamReports` 增量 |
| --- | --- | --- | --- | --- | --- |
| 不注入 profile（config 默认 shadow） | shadow | false | `pi-0@3` → `pi-0::dream-2@4` | **+1** | **0** |
| 注入 off | off | false | 同上 | **+1** | **0** |
| 注入 baseline | baseline | false | 同上 | **+1** | **0** |
| 注入 guarded-active | guarded-active | false | 同上 | **+1** | **0** |
| shadow + `/evo jit off` | shadow | false | 同上 | **+1** | **0** |

（`work/t2-dreamer-probe/idle.json`。）两条独立事实：
1. idle 的发布**与任务周期一样真实**，且 `off` profile 完全不阻断；
2. idle 的发布**完全不进入 `orchestrator.dreamReports()`**（该数组只由 `runDream` 追加），也不调用 `taskCounter.recordDream` → 状态页、诊断与审计看不到这次发布。`plugin.diagnostics` 里只有 `execution profile: ...` 一行，没有任何 dream 相关记录。

### 3.4 holdout 半边在生产中惰性

| 装配 | `shadow.holdoutTreeIds` | `publication.publish` |
| --- | --- | --- |
| 生产装配（`buildOrchestratorDeps` → deps.dreamer） | `[]` | **true** |
| 手工 `createOfflineDreamer({})` + 1 棵树 | `[]` | true |
| 手工 + 2 棵树（仍未传 `holdoutTreeCount`） | `[]` | true |

（`work/t2-dreamer-probe/last.json`。）`src/index.ts:1642-1668` 的 `dreamBase` 不含 `holdoutTreeCount`，`createJitWiredDreamer` 也不补——因此 `offline-dreamer.ts:1765` 的 `holdoutCount = min(0, ...) = 0`，`validatedOnHoldout` 恒 `undefined`，`decideReplayPublication` 第 1189 行的 `validatedOnHoldout === false` 分支永不可达。单测 `offline-dreamer.test.ts:1015` 验证过"配置了 holdout 时会切分"，但**没有任何测试断言生产装配的默认值**。

### 3.5 普通 Dreamer 忽略 `config.jitrl.dream`

同一棵树、同一 `candidatePoliciesCount=3`，只改配置：

| 配置 | 期望 | 实际候选 `jit.beta` | 活动策略 `jit` |
| --- | --- | --- | --- |
| `jitrl.enabled=false`，`hyperparamPerturbation=false`，`candidateJitBetas=[7,8,9]` | 不扰动 | `[0.5, 1, 2]`（冻结默认网格） | **写入** `{beta:1, lambda:0.05, alpha:5, k:10, gamma:0.5, threshold:0.3}` |
| `jitrl.enabled=false`，`hyperparamPerturbation=true`，`candidateJitBetas=[7,8,9]` | 用 7/8/9 | `[0.5, 1, 2]` | **写入** 同一冻结默认块 |

（`work/t2-dreamer-probe/plaingrid.ts`、`minfix.json` → `gridDefect`。）对照：直接调用 `generateCandidatePolicies(base, 3, { jitGrid: config.jitrl.dream })` 会正确产出 `[7,8,9]`——说明缺陷**只在装配层**：`src/index.ts` 的普通 dreamer 分支（`:1668` `createOfflineDreamer(dreamBase)`）没有把 `generatePolicies`（含 grid）传进去，只有 Jit-wired 分支传了（`:1137-1149`）。

后果不是"jit 关闭时不扰动"这么温和：因为 `jitHyperparamsOf()`（`offline-dreamer.ts:377-382`）在 baseline 无 `jit` 块时返回 `defaultJitHyperparams()`，候选**总是**带 jit 块，一旦 improved 就把冻结默认值写进在线策略。

### 3.6 发布出去之后的在线影响（跨重启）

两代进程：

```
gen1: jitrl.enabled=false, hyperparamPerturbation=false, candidateJitBetas=[7,8,9]
      dream improved=true → policy.jit 被写入 {beta:1,k:10,threshold:0.3}
      policy.current.json 持久化 pi-0::dream-2（含该 jit 块）
gen2: jitrl.enabled=true, beta=0.5, k=4, similarityThreshold=0.9
      restore() → pi-0::dream-2，policy.jit = {beta:1,k:10,threshold:0.3}
      L1 装饰器决策：effectiveConfig() 以 policy.jit 覆盖构造配置
      → 实际生效 beta=1（配置 0.5）、k=10（配置 4）、threshold=0.3（配置 0.9）
```

（`work/t2-dreamer-probe/restart.ts` → `restart.json`。这条证据**只证明"`jit` 块被持久化并在重启后被 restore 出来"**；"该块会覆盖构造期 beta/k/threshold"由仓库自带的两条决定性测试独立钉住：`jit-active-policy.test.ts:1415`（构造 beta 0.5 + 策略 jit beta 2 → 恢复出的温度恰为 2）与 `:1679`（无 provider 时回落到 live policy 块，`klToPrior` 严格增大）；两者均 `1 passed` 实跑确认。合并点源码：`src/jitrl/jit-active-policy.ts:625-658`。）

> **本条证据的诚实边界**：本报告自写的 `merge2.ts` 探针在空经验库下 `normalizedAdvantage` 恒为 0、`adjustedLogit` 与 beta 无关，因此它**无法**给出"beta 变了"的判别性结论（其输出 `policyJitChangesDecisionSurface=false` 是空转，不是反证）。结论改由上述仓库测试承担；`merge2` 仅作为"同一输入下决策面不变"的旁证记录在 `merge2.json`，不引用为 F6 的证据。

注意 gen2 的 `publish.allowed` 仍为 false、mode 仍为 shadow——**这是纯粹的"配置被静默改写"，不经过任何发布门**。

### 3.7 无持久化装配同样被改写（排除"只是持久化噪声"）

`buildOrchestratorDeps` 完全不带 `options.persistence` 时：活动策略仍从 `pi-0@3` 变为 `pi-0::dream-2@4`（`last.json` → `memoryOnlyAssembly.mutatedWithoutPersistence=true`）。所以 F1 是**内存语义**缺陷，持久化 revision 只是它的可见副作用。

---

## 4. 现有测试对效果点的覆盖矩阵（逐条判定）

图例：**✓效果** = 断言了真实 apply/update 或真实策略对象变化；**○旁证** = 只断言 `publish` 布尔/权限值/接口存在；**✗** = 完全未覆盖。

| 效果点 | 现有断言 | 判定 | 位置 |
| --- | --- | --- | --- |
| 普通 dreamer 在 improved 时调用 `applyPolicy` | `applied` 数组长度 1、policy id | **✓效果**（但**未传 `shadowMode`**，即把"会发布"当成期望行为固化） | `offline-dreamer.test.ts:515-537` |
| 普通 dreamer 通过 `activePolicy` 自动接线 | `updates` 数组 | **✓效果**（同上） | `offline-dreamer.test.ts:539-558` |
| Jit-wired dreamer 热替换携带 jit 块 | `applied[0].jit.beta===2` | **✓效果** | `jit-dream.test.ts:922-975` |
| jit off 时钉回 incumbent jit 块 | `swapped.jit.beta===1` | **✓效果** | `runtime-control.test.ts:319-421` |
| 生产插件任务周期会 dream | `dreamTriggered`、`dreamReports().length` | **○旁证**（不断言策略是否被改写） | `offline-dream.test.ts:16-59`、`runtime-control.test.ts:259-315`、`tests/unit/integration/p4-wiring.test.ts` 全篇 |
| 生产插件 dream 的**发布**后果 | — | **✗** | 无任何测试读取 `dreamReports()[i].publication.publish` 或对比 dream 前后策略 |
| idle 入口会触发 dream | `dream.run` 被调用（vi.fn） | **○旁证** | `dsh-triggers.test.ts:249-286` |
| idle 入口的**发布**后果 | — | **✗** | 无（本报告 §3.3 是首个证据） |
| `shadowMode` 语义 | `published=false`、`applied.length===0` | **✓效果**，但只在**手工构造** `createOfflineDreamer({shadowMode:true})` 时 | `offline-dreamer.test.ts:966-1013` |
| 生产装配是否传 `shadowMode` | — | **✗** | 无（本报告 §2.1 是首个证据） |
| holdout 切分 | 手工传 `holdoutTreeCount:1` 时验证选择/验证集不重叠 | **✓效果**（手工） | `offline-dreamer.test.ts:1015-1071` |
| 生产装配的 `holdoutTreeCount` 默认值 | — | **✗** | 无 |
| 发布门与 `permissions.publish` 的绑定 | `guarded-regression.mjs` 只断言 `profile.permissions.publish.allowed===false` 四模式恒真 | **○旁证**（权限值，不是效果） | `guarded-regression.mjs:470,486-487`；`release-contract.test.ts:402-433` |
| guard 下真实零副作用（dream 口径） | `T8-R1` 探测 `surfaceEnabled('onlineRecord'|'proposal')` | **○旁证**（只覆盖 orchestrator 的两面，不含 dream） | `guarded-regression.mjs:714-772` |
| 普通 Dreamer 是否消费 `config.jitrl.dream` | — | **✗** | 无（`jit-dream.test.ts:1023` 只测 `generateCandidatePolicies` 直接调用 + 手工 dreamer） |
| 跨重启后 `policy.jit` 对在线 beta 的影响 | `jit-active-policy.test.ts:1415` 测了"`update(policyWithJit)` 后 beta 变化"（装饰器层）；`:1679` 测了无 provider 时回落到 live policy 块 | **✓效果**（机制级，判别性已验证），但**未与 dream/persistence 串起来**（本报告 §3.6 补上了持久化这半条链，在线这半条仍靠上述单测） | `jit-active-policy.test.ts:1353-1450`、`:1679-1703` |

**关键读数**：`release-contract.test.ts`（1447 行，标注为"C0+C1 release-contract regression"）里与 Dreamer 相关的**只有 1 处**——`t12/R1c` 的 `:1423-1444`，它用 `createJitWiredDreamer` 但传 `trees: []`，并在断言 replay 声明字符串后就结束，**永远不会走到 `offline-dreamer.ts:1834-1846` 的发布分支**。被它当作"默认装配"验证的 `dreamer` 桩在 `:526/:581/:890` 一律是 `{}`。`guarded-regression.mjs`（1799 行、25 探针）的 `dreamer` 同样一律是 `{}` 空对象（`:517,595,730,943,1071,1374,1509`）。**C1.1 的"Dreamer 发布边界"在两道门禁里都是空白格。**

---

## 5. 反例有效性（"旧实现失败、修复后通过"的可构造性）

要让 t4 的新增反例满足"旧实现失败、修复后通过"，必须能用**同一份测试**在修复前后得到相反结论。本报告用 `work/t2-dreamer-probe/counterfactual.ts` 在**不改 src** 的前提下，经由官方 `deps.dreamer` 注入缝把 `shadowMode:true`（或"不接 applyPolicy"）装进生产链，测得：

| 装配 | mode | `improved` | `publication.publish` | `shadow.published` | 策略变化 | revision 增量 |
| --- | --- | --- | --- | --- | --- | --- |
| 现状（无 shadowMode） | shadow | true | **true** | **true** | **变** | **+1** |
| 修复形态（`shadowMode:true`） | shadow | **true** | **false** | false | 不变 | **0** |
| 现状 | baseline | true | true | true | 变 | +1 |
| 修复形态 | baseline | true | false | false | 不变 | 0 |
| 现状 | guarded-active | true | true | true | 变 | +1 |
| 修复形态 | guarded-active | true | false | false | 不变 | 0 |
| 现状 | off | true | true | true | 变 | +1 |
| 修复形态 | off | true | false | false | 不变 | 0 |

（`work/t2-dreamer-probe/cf.json`。）四条判据同时成立：`improved=true`（建议仍成立）、`suggestedPolicyId=pi-0::dream-2`（建议可读）、`publish=false`、`policy 未变 & revision 0`。**这正好构成验收所需的"deny 时实际 update/apply 为零且 improved/suggested 仍可成立、published=false"**。

另一条修复形态（完全不注入 `applyPolicy`）也能达到"实际不写"的效果，但**不改变 `publication.publish` 的返回值**（仍为 `true`，`shadow.published` 仍为 `true`）——即"报告说发布了、实际没发"。这正是 p62 已裁定过的"假 published"类型（见 `docs/P62_STATUS.md` §6-③ 与 `docs/reports/p62-release-closure.md` §5-③ 的诚实化要求：publish 无调用点、权限位不得表述为"发布门已生效"）。**因此推荐修复形态是 `shadowMode` 绑定 profile，而不是静默移除 `applyPolicy`**；否则报告字段会与事实相反。若采用"移除 applyPolicy"，必须同时把 `publication.publish` 改为 false（即在装配层传 `shadowMode:true`，两者等价），不能只删接线。

---

## 6. 修复最小面与范围提示（给 t4，非实现）

按 ADR-0002 §11.2 冻结清单，本缺陷的所有权面在 `src/index.ts`（装配）+ 可选 `src/dream-rsi/offline-dreamer.ts`（把 `shadowMode` 的默认值改为 fail-closed）。**不需要**改 `decision-kernel.ts`（`decideReplayPublication` 语义正确）、**不需要**改 `jit-active-policy.ts`。

> **本节已于 2026-10-26 被 captain 裁定收窄，见 §0。** 下表保留为审计提交时的原始建议（供追溯），但**执行范围以 §0 的 R1–R6 为准**：第 5 行（普通 Dreamer 网格）**本轮不做**（R4）；第 1 行须**同时**加上真实 apply 边界授权（R5），不能只做 shadow 派生；决策内核须收紧"缺省 holdout 仍 publish"的分支（R2），因此 §6 首段"不需要改 `decision-kernel.ts`"的初判**已被 R2 推翻**。

| 改动点 | 内容 | 风险 | 裁定状态 |
| --- | --- | --- | --- |
| `src/index.ts:1642-1668` | 由 effective profile 派生 `shadowMode: !effectiveProfile.permissions.publish.allowed`（或更保守：`effectiveProfile.mode !== 'guarded-active'`），同时补 `applyPolicy` 的显式传递语义 | 低；`dreamBase` 是新建对象 | **执行**（R1+R5，须配合真实边界授权） |
| `src/dream-rsi/offline-dreamer.ts:1844-1846`（真实 apply 点） | 发布前增加**授权条件**（profile 派生的 publish 许可），使"上层 shadow 派生"与"真实 apply 边界"双重成立；两者任一缺失都不得写入活动策略 | 中；`offline-dreamer.ts` 在 ADR §11.2 冻结清单内 | **执行**（R5） |
| `src/jitrl/decision-kernel.ts:1189-1203` | 缺省 `validatedOnHoldout`（undefined）**不得**返回 `publish:true`；只有显式验证通过才可发布 | 中；须保证既有 `validatedOnHoldout:true` 用例不变 | **执行**（R2） |
| `src/index.ts:1216-1250`（jit off 分支） | 现有 `applyPolicy` 覆写**绕过了 base 的 `applyPolicy`**；需同源授权判定 | 中 | **执行**（R1：热替换归 publish，故 jit off 也不得热替换） |
| `src/orchestrator.ts:3148-3186`（`runDream`） | 可选：进入 `runDream` 前按 `executionProfile.off` 短路 | 低 | 可选（R3 的可审计要求可用此实现） |
| `src/host-triggers.ts:565-613` / `src/index.ts:2751-2763` | idle 入口需同样受 profile 约束；并把 idle dream 写入 `dreamReports`/诊断，避免不可见发布 | 中 | **执行**（R3：不得消失或假 published） |
| `src/index.ts:1668`（普通 dreamer） | 传 `generatePolicies: deterministic`（含 `config.jitrl.dream` 网格） | 低 | **本轮不做**（R4：只登记） |

**语义冲突已被裁定（原为"待裁定"，现将 §0-R1 的结论落到此处）**：ADR-0002 §3 写"shadow = baseline 执行 + 建议记录，零副作用（不 applyPatch、不 publishPolicy、不 writeMemory）"，而现有单测 `offline-dreamer.test.ts:515/539`、`jit-dream.test.ts:922`、`runtime-control.test.ts:319`、`dream-rsi-pipeline.test.ts:227` 都把"improved 时 `applyPolicy` 被调用"当作**期望行为**。**captain 裁定 R1**：热替换与 revision 同属 publish 层，四模式全 deny —— 因此上述 4 处测试的期望**须按 ADR 修正**；修正时**不得弱化** `runtime-control.test.ts:319` 的"jit 扰动不得泄漏"断言（那是另一条独立安全性质，仍需保留）。

---

## 7. 覆盖矩阵（交付主表）

> `入口` × `Dreamer 形态` × `模式` 三维。每格给：**当前实际效果** / **现有测试证据** / **缺口**。

### 7.1 任务周期入口（`shouldDream` → `runDream`）

| Dreamer 形态 | 模式 | 实际效果 | 现有证据 | 缺口 |
| --- | --- | --- | --- | --- |
| 普通（无 kernel） | shadow（默认） | **热替换 + revision +1** | ○ `offline-dream.test.ts`（只数报告） | 发布效果无断言 |
| 普通 | baseline | **热替换 + revision +1** | ✗ | 全缺 |
| 普通 | guarded-active | **热替换 + revision +1** | ✗ | 全缺 |
| 普通 | off | **热替换 + revision +1** | ✗ | 全缺 |
| Jit-wired | shadow（默认） | **热替换（含 jit 块）+ revision +1** | ✓ `runtime-control.test.ts:259`（hook/jit 面，不判发布） | 发布效果无断言 |
| Jit-wired | baseline | **热替换 + revision +1** | ✗ | 全缺 |
| Jit-wired | guarded-active | **热替换 + revision +1** | ✗ | 全缺 |
| Jit-wired | off | **热替换 + revision +1** | ✗ | 全缺 |
| Jit-wired | shadow + `/evo jit off` | **热替换（不含 jit 块）+ revision +1** | ✓ `runtime-control.test.ts:319`（钉 jit 面） | 发布效果无断言 |

### 7.2 idle 入口（`agent/status` → `idle`）

| Dreamer 形态 | 模式 | 实际效果 | 现有证据 | 缺口 |
| --- | --- | --- | --- | --- |
| 普通 | 任意（含 off） | **热替换 + revision +1；`dreamReports` 不记录** | ○ `dsh-triggers.test.ts:249`（只验 `run` 被调） | 发布效果、可观测性全缺 |
| Jit-wired | 任意（含 off、`/evo jit off`） | **热替换 + revision +1；`dreamReports` 不记录** | ✗ | 全缺 |

### 7.3 其它发布相关效果点

| 效果点 | 当前实际 | 现有证据 | 缺口 |
| --- | --- | --- | --- |
| `publication.publish` 与 `permissions.publish` 一致性 | **从不一致**（前者 true、后者 false） | ✗ | 需新增不变量断言 |
| `shadow.published` 的语义 | 等于 `publication.publish`，在默认装配下为 **true** | ○ 只在手工 `shadowMode:true` 时断言 false | 需断言"默认模式下 `shadow.published===false`" |
| holdout 验证在生产是否启用 | **未启用**（`holdoutTreeIds=[]`） | ○ 只在手工传参时验证 | 需断言装配默认值 |
| 普通 Dreamer 是否消费 `config.jitrl.dream` | **否**（用冻结默认网格） | ✗ | 需新增 |
| 发布是否写持久 revision | **是**（`policy.history.jsonl` + `policy.current.json`） | ○ `policy.store.test.ts:210-247`（封装层） | 需在 dream 口径断言 |
| 发布是否刷新在线 L1 beta/k/threshold | **是**（经 `policy.jit` 合并） | ✓ `jit-active-policy.test.ts:1415`（机制级） | 需跨 dream/重启串联 |
| 永久 patch 挂载是否被挡 | **是**（`activePatchIds()=[]` 四模式） | ✓ `release-contract.test.ts:515-568`、`guarded-regression.mjs:500-578` | 已覆盖（对照项） |
| memory 写入是否被挡 | **是**（调用点前返回） | ✓ `release-contract.test.ts:920-1092`、`guarded-regression.mjs` T10-R2b/R2c | 已覆盖（对照项） |

---

## 8. 复现指引

探针全部在 gitignored 的 `work/t2-dreamer-probe/`，**不进入** `src/tests/scripts` 指纹。每条命令都用仓库自带 esbuild 把真实 `src/**` 打成 ESM 后执行，`packages: 'external'` 保持 `@deepseek-ai/schemastery` 真实解析。

```powershell
# 全量基线（本报告 §0）
pnpm test                                  # 77 files / 1562 tests, exit 0
pnpm run typecheck                         # exit 0
node scripts/eval/guarded-regression.mjs --json   # {total:25,passed:25,failed:0}

# Dreamer 效果探针（只读；每个都创建 os.tmpdir() 下的临时数据目录）
node work/t2-dreamer-probe/run-entries.mjs       # §3.1 四模式 × 任务周期（durable deltas）
node work/t2-dreamer-probe/run-effect.mjs        # §3.1 独立复现（策略/日志/报告全字段）
node work/t2-dreamer-probe/run-seq.mjs           # §3.2 连续三次 dream 的叠加
node work/t2-dreamer-probe/run-idle.mjs          # §3.3 idle 入口 × 五套装配
node work/t2-dreamer-probe/run-last.mjs          # §3.4 holdout 惰性、§3.7 无持久化装配
node work/t2-dreamer-probe/run-plaingrid.mjs     # §3.5 普通 Dreamer 忽略 config grid
node work/t2-dreamer-probe/run-restart.mjs       # §3.6 跨重启 jit 块被持久化
node work/t2-dreamer-probe/run-merge2.mjs        # §3.6 空经验库下决策面不变（旁证，非判别性）
node work/t2-dreamer-probe/run-cf.mjs            # §5 反证：shadowMode 修复形态
node work/t2-dreamer-probe/run-minfix.mjs        # §5 T0/F1/F2 三形态对照 + grid 缺陷
node work/t2-dreamer-probe/run-treelog.mjs       # §9-4 tree-pool 日志净增（0→2→3→4）

# §0.1 裁定可行性预检（R2 的波及面；只读）
node work/t2-dreamer-probe/run-r2.mjs            # 内核直调用例 + dreamer 夹具逐条比对今日/R2 后
node work/t2-dreamer-probe/run-breakage.mjs      # 谁会被 R2 打破（4 处热替换测试）
node work/t2-dreamer-probe/run-r2defence.mjs     # 四模式×Jit on/off 下 R2 单独即可阻断生产路径
```

逐条事实 → 命令 → 产物映射：

| 事实 | 命令 | 产物 |
| --- | --- | --- |
| F1/F2 | `run-entries.mjs`、`run-effect.mjs` | `entries.json`、`effect.json` |
| F3 | `run-idle.mjs` | `idle.json` |
| F4 | `run-last.mjs` | 控制台 JSON |
| F5 | `run-plaingrid.mjs`、`run-minfix.mjs` | 控制台 JSON、`minfix` |
| F6 | `run-restart.mjs`（持久化半条链） | `restart.json`；在线合并半条链见 `jit-active-policy.test.ts:1415/:1679` |
| 反证 | `run-cf.mjs` | `cf.json` |
| 基线 | `pnpm test` / `typecheck` / `guarded-regression` | 见 §0 |

---

## 9. 边界与未做事项

- **只读**：本任务对 `src/**`、`tests/**`、`scripts/**` 零改动；仓库内唯一新增文件是本报告 `docs/reports/t2-dreamer-release-effect-matrix.md`，外加 gitignored 的 `work/t2-dreamer-probe/`。`git status --porcelain` 在写作前只有 t3 并行产出的 `docs/reports/c2a-trusted-verification-wiring-audit.md`。
- **未做**：不实现 C1.1 修复（属 t4）、不改 ADR（属 t1）、不做 C2a/C3/C4、不跑真实模型、不写真实 memory、不 commit/push、不部署。
- **未覆盖的发布效果点（如实登记）**：
  1. **多进程/多实例并发 dream** 的 revision 竞争未探测（单进程串行已验证）；
  2. **真实 DSH 宿主 `runMaintenance`** 路径未跑（`host-triggers.ts:601-612` 的 `maintenance.call(agent, job)` 分支只在 mock 层被覆盖；本报告 idle 探测走的是 `maintenance === undefined` 的 fallback 分支 `:601-604`，两条分支提交的 `job()` 完全相同，故发布语义应一致，但未实测）；
  3. **model-backed generator**（`createModelPolicyGenerator`）在默认装配下会走真实 `IModelAdapter.complete`——本轮零真实模型，夹具里 `options.model` 未提供，故该分支未在端到端探针中激活（单测 `offline-dreamer.test.ts:442-491` 已覆盖解析/回落）；
  4. **`tree-pool` 日志增长**：实测每次 dream 让 `tree-pool.jsonl` 净增 1 条 `kind:'tree'` 记录（池恒 1 棵树，日志 0 → 2 → 3 → 4；首个 dream 一次写 2 条，含种子树与重放树）：`offline-dreamer.ts:1737-1741` 把重放的树 `add` 回注入的 `treePool`，`PersistentTreePool.add` 因快照内容不同判定为"同 id 不同快照"并 append（`tree-pool.store.ts:474-489`）。日志随 dream 次数线性增长而与池大小脱钩，属**审计日志膨胀**，但**不**改变重放语义，故本报告只登记事实、不定性为本轮缺陷（是否纳入 C1.1 由 t1/t4 裁定）；
  5. **`recordDream` 计数器**：任务周期路径在 `runDream` 返回非 null 时调用，idle 路径不调用；本报告只登记差异，未判定是否应为缺陷；
  6. **`online.ts` 探针未给出判别性结论**：它的在线决策对比在空经验库下 `adjustedLogit` 与 `nAdvantage` 均退化，只能证明"决策 metadata 变了"，不足以证明"beta 变了"；后者由 `merge2.ts` 用真实 `ActivePolicy` 内层单独验证（结论见 §3.6）。

---

## 10. 对 t4 / t7（独立验证）/ t10（安全评审）的直接输入

> 本节已按 §0 的 captain 裁定更新；第 5 条的"待冻结三条口径"已被裁定关闭，保留为追溯记录。

1. **t4 必须做到**：在 `publish.allowed=false` 的同一 effective profile 下，普通与 Jit-wired 两种 dreamer、任务周期与 idle 两个入口、四模式（含 `off`）以及 `/evo jit off`，`applyPolicy`/`activePolicy.update` **实际调用次数为 0**，`policy.current.json`/`policy.history.jsonl` **增量 0**，`publication.publish===false`、`shadow.published===false`，且 `improved===true`、`suggestedPolicyId` 仍指向候选（建议能力不得被一起关掉）。
2. **t4 的冲突测试修正**：§6 末尾列出的 4 处既有测试把"improved 时热替换"当期望（`offline-dreamer.test.ts:515/539`、`jit-dream.test.ts:922`、`runtime-control.test.ts:319`、`dream-rsi-pipeline.test.ts:227`）。**captain R1 已裁定**热替换与 revision 同属 publish 层、四模式全 deny，故这 4 处须按 ADR 修正；修正时**不得弱化** `runtime-control.test.ts:319` 的"jit 扰动不得泄漏"断言。
3. **t7 的独立验证必须用真实效果证据**（captain R6 已固化为验收口径）：不能只读 `permissions.publish.allowed`（`guarded-regression.mjs:470` 已证明那条恒真、无判别力）；最小证据集 = 策略对象身份/版本 + `policy.current.json`/`policy.history.jsonl` 磁盘增量 + `publication.publish`/`shadow.published`/`improved`/`suggestedPolicyId` 四个报告字段。
4. **t10 安全评审的现成攻击面**：idle 入口的发布**不在 `dreamReports` 里**（§3.3）；captain R3 要求 idle deny 建议**可审计**，"至少不能消失或假 published"，故本轮该缺口是**必修项**而非仅登记项。评审时仍建议以磁盘 `policy.history.jsonl` 为唯一可信账本。
5. **ADR-0003（t1）的三条口径 —— 已由 captain 裁定关闭，记录如下**：①"基础 Dream-RSI 在线热替换"是否属于 publish 层 → **属于，全 deny**（R1）；②holdout 是否为本轮发布的必要条件 → **缺省 holdout 不可当发布证据**（R2，需收紧 `decision-kernel.ts:1189-1203` 的 undefined 分支）；③普通 Dreamer 是否必须消费 `config.jitrl.dream` → **不在本轮扩修，只登记**（R4）。另加一条实现约束：**上层 shadow 派生与真实 apply 边界授权须同时做**，不能只移除 callback（R5）。

---

### 附：本报告使用的探针文件清单（全部 gitignored）

```
work/t2-dreamer-probe/probe.ts         # 早期四模式 + idle 概览
work/t2-dreamer-probe/effect.ts        # 策略/日志/计数器全字段快照
work/t2-dreamer-probe/cycle.ts         # plugin.run 真链 + 普通 dreamer 网格
work/t2-dreamer-probe/drift.ts         # planGrid 前后对比（结论：grid 参数不足，已由 griddebug 修正）
work/t2-dreamer-probe/griddebug.ts     # planGrid 前后对比（含真实 policy 对象）
work/t2-dreamer-probe/plaingrid.ts     # 普通 Dreamer 忽略 config grid
work/t2-dreamer-probe/entries.ts       # 任务周期 + idle 的 durable deltas（主证据）
work/t2-dreamer-probe/online.ts        # 在线决策 metadata 前后对比
work/t2-dreamer-probe/minfix.ts        # T0/F1/F2 三形态对照
work/t2-dreamer-probe/idle.ts          # idle × 五套装配
work/t2-dreamer-probe/seq.ts           # 连续三次 dream 叠加
work/t2-dreamer-probe/counterfactual.ts# 反证：shadowMode 修复形态
work/t2-dreamer-probe/restart.ts       # 跨重启 jit 污染
work/t2-dreamer-probe/merge.ts         # L1 合并规则首版探针（结论：空经验库下无判别力，已弃用）
work/t2-dreamer-probe/merge2.ts        # 同上，真实 ActivePolicy 内层；仅作"决策面不变"旁证
work/t2-dreamer-probe/last.ts          # 无持久化装配 + holdout 惰性
work/t2-dreamer-probe/treelog.ts       # tree-pool 日志净增测量
work/t2-dreamer-probe/run-*.mjs        # 各探针的 esbuild 打包运行器
```
