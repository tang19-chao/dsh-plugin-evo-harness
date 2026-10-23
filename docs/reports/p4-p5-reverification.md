# P4 / P5 修复轮复验报告（T13，T9 评审 needs_revision 之后）

> 验证者：verifier（AgentTeams 成员 `verifier`，任务 `t13`，attempt `e977aad3-8935-4a65-8000-30e4a0682ae2`）
> 时间：2026-10-23 07:18–08:5x（UTC+08）
> 仓库：`<repo>`
> 代码版本：`84cbc1a` + 未提交工作树改动（`84cbc1a+dirty`）
> 上游：T9 评审判 `needs_revision`（2 high / 6 medium / 5 low）→ t10(H1) / t11(H2+F1) / t12(M1) 三条修复
> 证据：本报告每个数字都能在 `work/_t13-*.log` / `work/_t13-eval-json-postfix.json` 中回溯

---

## 1. 门禁终态（全部本轮实测）

| 门禁 | 命令 | 结果 | 证据 |
| :-- | :-- | :-- | :-- |
| 类型 | `pnpm run typecheck` | **exit 0** | `work/_t13-typecheck.log` |
| 全量测试 | `pnpm run test` | **63 files / 1129 tests passed** | `work/_t13-test-full.log` |
| 文档计数 | `node scripts/verify-readme-counts.mjs` | **连续两次 SUCCESS**（共四次全绿） | `_t13-docs-pass1.log`、`_t13-docs-pass2.log`、`_t13-docs-final1.log`、`_t13-docs-final2.log` |
| 评测脚本 | `node scripts/eval-jitrl.mjs` | **exit 0** | `work/_t13-eval.log` |
| 定向修复测试 | `vitest run <3 files>` | **59 例全绿** | `work/_t13-fix-tests.log` |
| 全量测试（收尾复跑） | `pnpm run test` | **63 files / 1129 tests passed** | `work/_t13-test-final.log` |

注：`pass1/pass2` 为刷新 README 后的连续两次；`final1/final2` 为删除探针、写完本报告后的再连续两次，均为 SUCCESS。

拆分明细（门禁内部 vitest JSON 逐文件聚合 + `tests/` 目录计数双证一致）：

| 范围 | 文件 | 用例 |
| :-- | --: | --: |
| `tests/unit` | 56 | 1051 |
| `tests/e2e` | 7 | 78 |
| **总计** | **63** | **1129** |

**未套用任何中间快照**：本轮以实测 63/1129 为准，未采用 61/1114、62/1120、62/1125 中的任何一个。

定向三文件明细：`tests/unit/jitrl/jit-active-policy.test.ts` **49**、`tests/unit/integration/p5-host-tool-wiring.test.ts` **6**、`tests/unit/orchestrator/invariant-guidance-hardening.test.ts` **4**。

### 1.1 README 计数 before / after

| 位置 | before | after（实测） |
| :-- | :-- | :-- |
| `README.md:73` 摘要 | `61` test files, `1114` passing tests | **`63` test files, `1129` passing tests** |
| `README.md:294` unit 行 | 54 files, 1036 tests | **56 files, 1051 tests** |
| `README.md:295` e2e 行 | 7 files, 78 tests | 7 files, 78 tests（**未变**） |
| `README.md:296` total 行 | 61 files, 1114 tests | **63 files, 1129 tests** |

刷新前门禁以 exit 1 逐条报出 **6 处**不匹配（summary 文件/用例、unit 文件/用例、total 文件/用例）；**e2e 行未报错**，与「e2e 未变」互相印证，可作为拆分正确性的旁证。

**增量归因**（+2 文件 / +15 用例，全部落在 unit）：

| 来源 | 文件 | 用例 |
| :-- | :-- | --: |
| t11 / H2 | 新增 `tests/unit/integration/p5-host-tool-wiring.test.ts` | +6 |
| t12 / M1 | 新增 `tests/unit/orchestrator/invariant-guidance-hardening.test.ts` | +4 |
| t10 / H1 | 既有 `tests/unit/jitrl/jit-active-policy.test.ts` 44 → 49 | +5 |

6 + 4 + 5 = 15，与实测增量完全吻合。

---

## 2. 三条修复逐条复核（通过 / 失败 / 未实现 三分法）

复核方式：**先读产品源码确认修复真的在决策路径上，再用不读项目测试文件的独立探针复现**（探针自建输入、直接 import `src`；位于 `work/`，vitest 已 `exclude: ['work/**']`，不污染计数）。

### 2.1 H1 — 在线 L1 决策现读 `base.policy.jit` 的 β/k/λ/α：**通过**

| 项 | 结论 |
| :-- | :-- |
| 代码路径 | `src/jitrl/jit-active-policy.ts:556` `effectiveConfig(policy)` 从 `policy.jit` 覆盖 beta/k/similarityThreshold/lambda/alpha；`adjust()`（`:609`）每次决策调用它，并把它同时喂给 `composeDecision` 与 `retrieve`。`this.config` 全文仅剩构造期 `:498` 与 `effectiveConfig` 回落 `:559/:562-567` 两处用途，**无第二个读取构造期超参的旁路**。 |
| 验收措辞对齐 | `JIT_BATCH_METADATA_KEY = 'jit'`（`jit-active-policy.ts:73`），即验收所说「从 `metadata.jit` 可证」正是本探针所读的键。 |
| 独立探针 | `work/_t13-h1-probe.mjs` → **exit 0**（`_t13-h1-probe.log`） |

探针用可观测诊断**精确反推**生效 β：β=0 时 adjustedLogit 即先验，故 `β = (z'(β) − z'(0)) / normalizedAdvantage` 是恒等式。关键输出：

```
prior logits recovered for 4 action key(s)
before any swap (constructor beta): recovered beta = 0.5 across 3 candidate(s)
before swap KL = 0.04942515336603904
after update(policyWithJit(2)):      recovered beta = 2   across 3 candidate(s)
at beta=2 KL = 0.7121829372464911
after update(policyWithJit(0.5)):    recovered beta = 0.5 across 3 candidate(s)
after update(policy without jit):    recovered beta = 0.5 across 3 candidate(s)
neighborCount: k=1 -> 1, k=10 -> 6
```

「先断言中间态真的变了」在此体现为：**交换前先证 β=0.5**（构造值）并在交换后证 KL 由 0.049 升到 0.712；只跑 after 不足以证明是 `update()` 生效。k 也现读（k=1 → neighborCount 1；k=10 → 6），说明不只是 β 一个字段被接通。

**口径说明（不影响判定，但如实记录）**：T9 评审的 required fix 写的是「补在线 β 生效的 **e2e**」。实际新增的是 `tests/unit/jitrl/jit-active-policy.test.ts` 内的 5 例（真实 `createJitActivePolicy`，但非 `tests/e2e/` 目录）。功能覆盖成立且断言强度高（β 反推 + KL 单调 + 双向 update + 无 jit 回落），但**目录归属不是 e2e**；如需严格对齐措辞，可后续把该场景搬进 `tests/e2e/`。

### 2.2 H2 — 生产路径有 `host_tool` 经验生产者，默认 `kernel.createHostAdvisor()` 能产出非 noop：**通过**

这是 T9 评审点名的关键项：**旧 `p5-wiring` 因为注入了自带 retriever，完整绕过了缺口**。因此本轮复核的重点不是「测试是否绿」，而是「新测试是否真的走默认分支」。

| 项 | 结论 |
| :-- | :-- |
| 新测试是否注入 advisor/retriever | **没有**。`tests/unit/integration/p5-host-tool-wiring.test.ts:118-121` 只传 `config`，**没有 `extra.hostAdvisor`、没有 retriever**；文件头注释明确写出这一点。 |
| 生产接线 | `src/index.ts:1384-1397` 把 `tools/post-execute`（及可用时的 `turn/end`）转发给 host-tool producer；producer 为 `src/jitrl/host-tool-experience.ts` 的 `createHostToolExperienceCollector`。 |
| 独立探针 | `work/_t13-h2-probe.mjs` → **exit 0**（`_t13-h2-probe.log`），同样**不注入任何 advisor/retriever** |

关键输出（含**反证步**）：

```
hostAdapterSource = dsh-hooks
advisor attached=true enabled=true mode=gate
BEFORE evidence: gate kind=allow, hostToolExperiences=0
AFTER  evidence: hostToolExperiences=5
AFTER  evidence: gate kind=ask, reason=host tool action "tool:bash" has tilde=-0.889 (meanReturn=-0.800, n=3) below gateThreshold
```

**为什么 BEFORE 那一步是决定性的**：如果默认分支背后仍有自带 retriever 在替它回答，零证据时就会直接 `ask`。它返回 `allow`，排除了「用注入替身自证」这一失败模式；随后喂入真实 post-execute 流量（3 次失败 bash + 2 次成功 edit）后，**同一个**默认 gate 才转为 `ask`，证明证据确实经 kernel store 到达 `createHostAdvisor()` 的默认查询路径。

同样的口径说明：新增覆盖在 `tests/unit/integration/`（真实 hook 派发 + 真实插件入口），**不在 `tests/e2e/` 目录**。

### 2.3 M1 — invariant 的 L2 检索过滤按 slot 种类钉死：**通过**

| 项 | 结论 |
| :-- | :-- |
| 代码路径 | `src/orchestrator.ts:1944` `const pinnedGuidance = guidanceFilterForSlot(input.slot.slot);` → `:1946` `guidanceFilter: pinnedGuidance ?? input.slot.guidance`。 |
| 钉死函数 | `src/jitrl/candidate-augmenter.ts:370` `guidanceFilterForSlot`：`explore_invariant → 'guidance_free'`，其余返回 `undefined`。 |
| 独立探针 | `work/_t13-m1-probe.mjs` → **exit 0**（`_t13-m1-probe.log`） |
| 对抗用例 | 新增 `tests/unit/orchestrator/invariant-guidance-hardening.test.ts` 4 例，**驱动真实 orchestrator** 并注入一个「把 invariant 槽标成 `guidance:'memory'`」的自定义策略，断言交给 L2 optimizer 的 `guidanceFilter` 恒为 `guidance_free`。 |

探针输出：

```
explore_invariant claimed=memory        -> pinned=guidance_free, effective filter=guidance_free
explore_invariant claimed=guidance_free -> pinned=guidance_free, effective filter=guidance_free
exploit        -> pinned=undefined (undefined means the slot guidance is used)
explore_domain -> pinned=undefined
recover        -> pinned=undefined
explore_domain claimed=guidance_free -> effective filter=guidance_free
```

即：两种拼写都塌缩到同一硬值；非 invariant 种类**未被扩大化**（仍读自身 guidance）；`guidance_free` 的 domain 槽也保持 `guidance_free`（无「放宽」方向的漂移）。

### 2.4 三条修复之外，另复核了四处同类守卫

T9 评审指出 §7.1 的隔离「四个守卫」中此前只有三个按 kind 钉死。除 L2 过滤器（M1）外，我读码确认其余三处也都按 kind 优先，未被自定义策略误标绕过：

| 位置 | 行为 |
| :-- | :-- |
| `src/orchestrator.ts:437-443` `slotProvenance` | `slot.slot === 'explore_invariant'` → `'guidance_free'`（kind 优先） |
| `src/orchestrator.ts:1586` proposer guidance mode | `slot.slot === 'explore_invariant' \|\| slot.guidance === 'guidance_free'` → invariant 模式（kind 优先，故误标 `memory` 仍进 invariant 模式） |
| `src/jitrl/candidate-augmenter.ts` 增广守卫 | 由 `guidanceFilterForSlot` 提供同一钉死语义 |

---

## 3. F1 结论（T8 遗留缺口已闭合）：**通过**

T8 轮我报告的中危缺陷 F1 是「`/evo jit off` 只关 L1，不关 L3 顾问与记忆镜像」。本轮用两个独立探针复核，**该缺口已闭合**：

| 被覆盖的面 | 证据（探针输出） |
| :-- | :-- |
| gate 询问 | on → `ask`；off（`json.enabled=false` 已验证）→ `allow`；on → 恢复 `ask`（`_t13-h2-probe.log`） |
| host_tool 采集 | off 后再喂 5 条工具事件，`hostToolExperiences` **冻结在 5**；on 后继续增长 |
| advisory 注入 | on → `additionalContexts=1`（含 `<jitrl_advice`）；off → `additionalContexts=0`；on → 恢复（`_t13-f1-probe.log`） |
| 记忆镜像 | on 后 `mirror.calls=1`、`listTools=1`、`callTool=2`；off 后再跑一个 run，三个计数**全部不变**；on 后 `mirror.calls` 1→2 |
| 运行时状态面 | off 后 `plugin.jitrl.hostAdvisor.runtimeEnabled=false`；on 后 `=true` |

实现依据：`src/index.ts:1373-1375` 新增单一 `runtimeGate`，L3 顾问 attach 时传入 `isRuntimeEnabled: () => runtimeGate.enabled`（`:1405`），host-tool 采集与镜像同步各自读取同一 `runtimeGate`（`:1392/:1394`、`:1514`），命令面 `setEnabled` 同时翻 `runtimeGate`（`:1600`）。

这与 T8 轮**同样输入下的旧行为**构成前后对照：T8 时 off 后仍注入 advice、gate 仍 `ask`；本轮 off 后 `allow` 且注入为空。

---

## 4. eval 复跑结论：**exit 0，且修复后指标块与修复前逐字节相同**

- `node scripts/eval-jitrl.mjs` → **exit 0**（`work/_t13-eval.log`）。
- 本轮 post-fix JSON：`work/_t13-eval-json-postfix.json`。
- **修复前**基准：上一轮（T8，即 t10/t11/t12 落地**之前**）生成的 `work/_t8-eval-json-1.json`。
- 用 `work/_t8-determinism.mjs` 剥离计时字段后逐字节比对：

```
metric block A length: 137874
metric block B length: 137874
metric blocks identical: true
total safety leaks across all conditions: 0
conditions: B0, B1, B2, B3, A2-k4, A2-k8, A2-k10, A2-k14, A2-k20, A3-beta0.5, A3-beta1, A3-beta2, A3-beta4
protocol deterministic flag: true
RESULT: OK
```

**结论：三条修复没有改变评测路径的可观测量，`work/p5-eval-report.md` 的数字仍然有效，因此本轮没有重生成、也没有覆盖该报告。**

为什么「数字不变」是合理而非可疑：三条修复分别作用于 (a) 在线 L1 的热替换超参读取、(b) 宿主 `post-execute`→`host_tool` 证据生产与运行时开关、(c) L2 过滤器在**策略误标**时的钉死。评测协议不使用热替换、L3 默认关闭（不进 12 个离线任务）、且其默认策略本就把 invariant 槽标成 `guidance_free`（故 M1 的钉死对默认路径是**行为等价的加固**，只在误标策略上改变行为）。三者都不在评测的取值路径上，与实测全等一致。

附带复核（本轮实测）：13 个条件安全计数器全 0、且 `invariantProbes` 非 0（避免空断言）；B0 0.569 / B1 0.889 / B2 0.889 / B3 0.956（Final 0.972，Final−Avg +0.017）与提交报告逐项一致。

---

## 5. 未修项诚实清单（强制，**不得读作已解决**）

### 5.1 T9 评审的中危项（本轮**未修**）

| ID | 内容 | 本轮状态 | 我的复核意见 |
| :-- | :-- | :-- | :-- |
| **M2** | ≤300 token 是**估算器口径**且由单测自证（`host-advisor.ts:80,117-129,447-467`）；高熵 ASCII 可低估 3–4×，实际可能远超 300 | **未修** | 我独立探针实测 180 条证据渲染出 293 tokens（`_t8-p5a-probe.log`），但**同样用的是产品自带 `estimateTokens`**，因此我的证据与单测同源、**不能**反驳 M2。无真实 tokenizer（如 tiktoken）交叉校验。 |
| **M3** | replay 漂移按**整层**计数，非 §7.3-4 的「同 `(level,bucket)` 达 k 条」（对照 `jitrl/index.ts:695-703` vs `retriever.ts:107-122`） | **未修** | 检索端（`retriever.ts`）的漂移语义按 bucket 正确；不一致在 replay 端按层计数，会使降权**提前停止**。本轮未新增跨 bucket 用例。 |
| **M4** | §9.1「跨任务泛化只用不相交任务经验」未实现，12 个任务共享一个经验库；且报告未标注该协议偏离 | **未修** | 这直接限制 P5-c 结论的适用范围：当前数字**不能**用于论证跨任务泛化。报告（`p5-eval-report.md`）未声明此偏离——我把它记在此处，作为对 P5-c 结论强度的下调依据。 |
| **M6** | `advisorScope` 默认空 = host-local（`index.ts:1354-1357` → `dsh-hook-host-adapter.ts:540-557` 空 scope 时 `return true`），advice 会注入**所有** dispatch，包括 invariant 探针 fork 的 `agent/pre-step`（§7.1 侧门） | **未修** | 与 §7.1「invariant 轨道不得读外部记忆」相冲突的**顾问面**通道。我的 F1/H2 探针使用 host-local 正是复现该路径；本轮未改默认绑定策略。 |

### 5.2 T9 评审的 5 条 low（本轮**全部未修**）

| ID | 内容 | 状态 |
| :-- | :-- | :-- |
| **L1** | gate 的 ask reason 把负统计量写给用户（`host-advisor.ts:642-658`）；评审判定不违规（非模型面） | 未修 |
| **L2** | 若模型在 step 文本里复述 advice，统计量可经 `summarizeTrajectorySteps`（`harness2/shared.ts`，经 `composer.ts:393-395` 入 prompt）间接进入判官 | 未修 |
| **L3** | 镜像诊断含未脱敏 `serverId` 与后端 error message（`stores/bridge.store.ts:384,408`） | 未修 |
| **L4** | `auto_fallback` 路径不同步镜像（`index.ts:1664-1703`） | 未修 |
| **L5** | `config.ts:132,136` 注释写 `gate may block host tool calls` / "blocks the call"，与 §3.3「任何情况下都不自动 deny」相反，易误导集成方 | 未修 |

### 5.3 沿用 T6 报告的未实现项（本轮复核**仍成立**）

| 项 | 状态 | 说明 |
| :-- | :-- | :-- |
| A1 Prompt-update 消融 | **未实现** | 需独立 prompt 注入路径 |
| A4 不使用 invariant 隔离 | **未实现** | 当前隔离是编译期硬约束，无可关闭开关 |
| A5 只用 LLM 奖励 vs 多信号融合 | **未实现** | 需真实 LLM judge |
| A6 Embedding 检索 vs Jaccard | **未实现** | 会引入模型/网络依赖，与「零新增依赖、离线确定」冲突 |
| L3 顾问的**收益数字** | **未实现（无数字）** | L3 默认关闭、不参与 12 个离线任务；行为由 unit/integration 覆盖，**没有收益对照数据** |
| §9.1 第 2/3 类任务集（真实仓库基准、30 个 DSH 任务） | **未实现** | 只有 12 个离线合成任务 |
| 真实 DSH 宿主 / 真实 MCP 后端联调 | **未验证** | 全部测试用结构替身；仓库不宣称真机验证 |

**因此仍不得从本报告推出**：真实仓库收益、跨任务泛化强度、真实 LLM judge 的影响、embedding 检索是否更优、L3 的实际收益、以及「≤300 tokens 在真实 tokenizer 下成立」。

### 5.4 本轮新增的一条观察（不判为缺陷，交给评审裁决）

**O1（观察，low 候选）**：L1 元层装饰器的检索（`jit-active-policy.ts` 的 `retrieve`）**没有 guidance 过滤**，即 invariant **槽位的分配**会参考记忆经验。我的判断是这**不属于** M1 描述的侧门：§7.1 约束的是 invariant **分支内容**不得读外部记忆，而该分支内容由四处守卫（增广 / proposer / 记录来源 / L2 过滤器）钉死；槽位分配本身是元决策，使用全部经验是设计意图。若评审认为 §7.1 也应覆盖「分配」层面，则这是一条廉价可跟进的加固项。**本轮未修，也未判为缺陷。**

---

## 6. 写域核对与清理

| 文件 | 本轮改动 | 说明 |
| :-- | :-- | :-- |
| `README.md` | **是** | 仅 4 处计数（`:73`、`:294`、`:295`、`:296`；其中 `:295` 值未变） |
| `work/p4-p5-reverification.md` | **是**（新建） | 本报告 |
| `work/_t13-*.log` / `_t13-eval-json-postfix.json` | 是（新建） | 验证物证，保留 |
| `work/_t13-*.mjs`（4 个探针源码） | 曾新建 | **按 captain 指示已删除**（保留 `.log` 作证据）。副作用如实说明：第三方若要**重跑**本轮独立复现，需按日志重建探针源码；日志本身已包含判定所需的全部关键输出行 |
| `src/**`、`tests/**`、`scripts/**`、`package.json` | **否** | 未触碰；`git status` 中这些路径的改动全部来自 t1–t12 |

**本轮未修改任何测试期望、未删除任何用例、未修改任何产品代码。**

### 6.1 探针自身错误留证（避免被误读为产品缺陷）

本轮 H1 探针首版**运行失败**，归因于探针构造而非产品：我猜了 `plan.stages` 里找 `jit_meta_adjust`，而产品把诊断发布在 `plan.metadata['jit']`（`JIT_BATCH_METADATA_KEY='jit'`），并通过 `readJitDiagnostics(plan)` 导出。改用产品导出的 reader 后 exit 0。教训与本轮纪律一致：**探针失败先怀疑自身构造；比较 before/after 前先断言中间态真的变了**。

---

## 7. 结论

- **三条修复全部真闭合**：H1（在线决策现读热替换 β/k，β 由诊断精确反推为 2，KL 0.049→0.712）、H2（不注入 advisor/retriever 时默认 `createHostAdvisor()` 分支能在真实证据后产出 `ask`；并以「零证据必须 `allow`」作反证排除替身自证）、M1（误标 `memory` 的 invariant 槽仍被钉到 `guidance_free`，其余种类未被扩大化）。每条都有**独立探针**（不读项目测试文件）+ 产品源码路径双证。
- **F1 已闭合**：`/evo jit off` 现同时关闭 gate 询问、advisory 注入、记忆镜像与 host_tool 采集，`jit on` 全部恢复；与 T8 轮同输入的旧行为构成前后对照。
- **eval 行为未变**：修复前/后指标块逐字节相同（137874 字符），`work/p5-eval-report.md` **无需重生成且未被覆盖**。
- **门禁终态**：typecheck 0、63 文件/1129 用例全绿、`check:docs` 连续两次 SUCCESS、eval exit 0。
- **诚实边界**：M2/M3/M4/M6、L1–L5、以及 T6 报告的全部未实现项**均未修/未验证**，其中 M2 与 M4 直接下调「≤300 tokens 在真实 tokenizer 下成立」与「跨任务泛化」这两条结论的强度。
- **计数终态 63/1129**：任何后续增删或改名测试都会使其失效，发布前必须**单独**重跑 `pnpm run check:docs`（不得与 `pnpm run test` 并行）。
