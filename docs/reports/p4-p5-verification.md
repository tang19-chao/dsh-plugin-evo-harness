# P4 / P5 全量验证报告（T8 终验）

> 验证者：verifier（AgentTeams 成员 `verifier`，任务 `t8`，attempt `078e4359-f10d-4573-8973-c0787654897f`）
> 时间：2026-10-23 02:0x（UTC+08）
> 仓库：`<repo>`
> 代码版本：`84cbc1a` + 未提交工作树改动（`84cbc1a+dirty`）
> 本报告只陈述本轮实测；每个数字都可在 `work/_t8-*.log` / `work/_t8-eval-json-1.json` 中回溯。

---

## 1. 门禁终态（全部本轮实跑）

| 门禁 | 命令 | 结果 | 证据 |
| :-- | :-- | :-- | :-- |
| 类型 | `pnpm run typecheck` | **exit 0** | `work/_t8-typecheck.log`、`work/_t8-typecheck-final.log` |
| 全量测试 | `pnpm run test` | **61 files / 1114 tests passed** | `work/_t8-test-full.log`、`work/_t8-test-final.log` |
| 文档计数 | `node scripts/verify-readme-counts.mjs` | **连续两次 SUCCESS** | `_t8-docs-pass1.log`、`_t8-docs-pass2.log`、`_t8-docs-final1.log`、`_t8-docs-final2.log` |
| 评测脚本 | `node scripts/eval-jitrl.mjs` | **exit 0** | `work/_t8-eval.log` |

`check:docs` 刷新前后各跑过两轮，共四次全部记录在案；其中**刷新后的连续两次**（final1、final2）是本次验收要求的那两次。

### 1.1 README 计数 before / after

| 位置 | before | after（实测） |
| :-- | :-- | :-- |
| `README.md:73` 摘要 | `54` test files, `964` passing tests | **`61` test files, `1114` passing tests** |
| `README.md:294` unit 行 | 48 files, 898 tests | **54 files, 1036 tests** |
| `README.md:295` e2e 行 | 6 files, 66 tests | **7 files, 78 tests** |
| `README.md:296` total 行 | 54 files, 964 tests | **61 files, 1114 tests** |

净增 **+7 文件 / +150 用例**。刷新前 `check:docs` 以 exit 1 逐条报出 **8 处**不匹配（4 项 × 文件数/用例数），说明门禁对漂移确有判别力，不是空跑。

增量来源（逐任务核对）：T2 `tests/unit/dream-rsi/jit-dream.test.ts`（29）+ `offline-dreamer.test.ts`（+5）、T3 `retriever.test.ts`（+14）、T4 `host-advisor.test.ts`（28）、T5 `bridge.store.test.ts`（20）、T6 `tests/e2e/jitrl-ablation.test.ts`（12）、T7 `p4-wiring.test.ts`（3）+ `p5-wiring.test.ts`（7），其余为 P0–P3 期间已落地但 README 一直未跟进的目录。**这说明漂移是多轮累计，不是单次事故。**

---

## 2. 逐条验收结论（通过 / 失败 / 未实现 三分法）

### P4 Dream-RSI × JitRL 双环

| # | 验收项 | 结论 | 证据 |
| :-- | :-- | :-- | :-- |
| P4-1 | 合成树池真实最优 **β=2** | **通过** | `tests/unit/dream-rsi/jit-dream.test.ts:846`；独立探针 `work/_t8-p4-probe.mjs` exit 0 |
| P4-2 | ≥2 次做梦后热替换到 **β∈[1.5,2.5]** | **通过** | `jit-dream.test.ts:883`；探针两轮 `applied` 恰 1 次、终态 β=2 |
| P4-3 | 候选不更优时保持 **π⁰** | **通过** | `jit-dream.test.ts:938`（`applyPolicy` 未被调用）；探针追加严格更差候选后 `improved=false` |
| P4-4 | 因果截断生效 | **通过** | `jit-dream.test.ts:533-620`；探针：cutoff=900 只留 899/900，丢 901，调用方数组未被改，注入越界记录后重放结果不变 |
| P4-5 | 漂移降权 **ρ=0.7** 生效 | **通过** | `src/jitrl/retriever.ts:89` `driftFactorFor`；`retriever.test.ts:387-500`（含 0.5×0.7=0.35 乘积、达 k 后停止降权、不传 policyId 逐字段等同改动前） |

**P4-1/2 的独立复现细节**（`work/_t8-p4-probe.log`）：

```
beta=0.5 hooked -> root>X>X1 quality=0.4 probes=2 early=false
beta=1   hooked -> root>X>X1 quality=0.4 probes=2 early=false
beta=2   hooked -> root>Y    quality=1   probes=1 early=true
beta=4   hooked -> root>Y    quality=1   probes=1 early=true      # 未超越 β=2
beta=0.5/1/2/4 no-hook -> root>X>X1 quality=0.4                  # β 完全失效
round1 improved=true  selected=pi-0::dream-3 applied=1           # applied[0].jit.beta=2
round2 improved=false selected=pi-0::dream-3 applied=1           # 无 churn
final beta = 2 within [1.5, 2.5]: true
```

「无钩子时 β 完全失效」这一条是关键：它把 β 效应归因到 replay hook，而不是别的路径。

### P5-a L3 宿主顾问

| # | 验收项 | 结论 | 证据 |
| :-- | :-- | :-- | :-- |
| P5a-1 | gate **永不 deny** | **通过** | 编译期 `NoDenyDecisionKind` 见证（`host-advisor.ts:97-106`）+ 480 次扫描无 deny 形态（探针）+ `host-advisor.test.ts:383/:444` + `p5-wiring.test.ts:114/:162` |
| P5a-2 | advisory **≤300 tokens** | **通过** | `MAX_ADVISORY_TOKENS=300`（`:80`）；180 条证据渲染实测 **293 tokens**，截断后两个结构标签均保留（探针）；`host-advisor.test.ts:245` |
| P5a-3 | 默认关闭 | **通过** | `config.ts:357` `enabled: false`；探针：`noop` 且 store/retriever **零触达**；`p5-wiring.test.ts:182` |
| P5a-4 | `/evo jit off` 可关闭 | **部分通过（见 §3 缺陷 F1）** | L1 装饰器确被关闭（`jit-active-policy.ts:537-553`）；**L3 顾问不受该开关约束** |

### P5-b 记忆桥聚合镜像

| # | 验收项 | 结论 | 证据 |
| :-- | :-- | :-- | :-- |
| P5b-1 | 只写聚合值 | **通过** | 探针：3 次写共 27 个键全在白名单内，序列化后不含 `sessionId`/`rewardSources`/原始 summary/`surrogate`；`bridge.store.test.ts:169` |
| P5b-2 | namespace 隔离 | **通过** | 探针：`probe/jitrl/{meta,proposal,host_tool}` 三者互异且都含 `jitrl` 段与前缀；`bridge.store.test.ts:235/:272` |
| P5b-3 | 开关关闭时**零写入** | **通过** | 探针：`written=0` 且 `listTools=0`/`callTool=0`（连发现都不做）；`bridge.store.test.ts:110` + `p5-wiring.test.ts:282` |

### P5-c 评测 harness

| # | 验收项 | 结论 | 证据 |
| :-- | :-- | :-- | :-- |
| P5c-1 | 报告数字可由脚本复现 | **通过（指标块）** | 两次 `--json` 剥离计时后 **137874 字符全等**；13 条件数字与 `work/p5-eval-report.md` 逐项一致 |
| P5c-2 | invariant 泄漏计数为 0 | **通过** | 13 条件全部 `invariantLeaks/invariantMemoryLeaks/invariantGuidanceLeaks/canaryLeaks = 0`；且 `invariantProbes` 非 0（避免空断言） |
| P5c-3 | 负路径会以非 0 退出 | **通过** | `--min-avg 0.99` → exit 1，打印 `condition B0 Avg 0.569 is below --min-avg 0.99` |

### 生产可达性（从真实入口）

| # | 验收项 | 结论 | 证据 |
| :-- | :-- | :-- | :-- |
| R-1 | dream hook 从 `createEvoHarnessPlugin` 可达 | **通过** | `p4-wiring.test.ts:32`（`hookAttached=true`、`hookCalls>0`、候选含 `pi-0::dream-*`、β 取自配置网格） |
| R-2 | advisor 从真实入口可达且只 ask | **通过** | `p5-wiring.test.ts:114/:195` |
| R-3 | mirror 从真实入口可达且关闸零触达 | **通过** | `p5-wiring.test.ts:260/:282/:297` |

### P5-c 实测数字（L=5，12 任务，本轮实跑）

| 组 | Avg | Final | Final−Avg | 解出率 | KL 均值 | KL p95 |
| :-- | --: | --: | --: | --: | --: | --: |
| B0 Static | 0.569 | 0.569 | 0.000 | 0.250 | 0.000 | 0.000 |
| B1 Harness²+Dream-RSI | 0.889 | 0.889 | 0.000 | 0.667 | 0.000 | 0.000 |
| B2 + L1 | 0.889 | 0.889 | 0.000 | 0.667 | 0.025 | 0.231 |
| B3 + L1 + L2 | 0.956 | 0.972 | +0.017 | 0.867 | 0.031 | 0.239 |

A2（k）：k=4 → 0.889、k=8/10 → 0.956、k=14/20 → 0.969。A3（β）：KL 0.0095 → 0.0314 → 0.0727 → 0.1017 单调升，Avg 恒 0.956。

---

## 3. 缺陷 / 降级项（诚实清单）

### F1【中危·影响范围已界定】`/evo jit off` 不关闭 L3 宿主顾问

- **复现**（本轮实测，`work/_t8-jit-off-probe.log`）：
  1. 构造 `jitrl.hostAdvisor.enabled=true` 的插件（advisory 或 gate 模式），挂到真实 DSH hook 上下文；
  2. `plugin.runFromCommand('jit off')` → 返回 `ok=true`、`json={"enabled":false,"persisted":false}`（**证明开关真的翻了**）；
  3. 再派发 `agent/pre-step` → `additionalContexts` 仍含 `<jitrl_advice …>`；再派发 `tools/pre-execute` → 仍返回 `kind: 'ask'`。
- **期望**：方案 §R8 写「可通过 `/evo jit off` 一键关闭」。
- **实际**：仅 L1 装饰器被关闭。
- **根因**：`setEnabled` 只写 `volatileJitEnabled` 与 `runtimeEnabled.enabled`（`src/index.ts:1529-1537`）；`runtimeEnabled` 唯一消费者是 L1 装饰器（`src/jitrl/jit-active-policy.ts:537-553`）。L3 顾问读的是 `config.jitrl.hostAdvisor.enabled`（`host-advisor.ts:703`），P5-b 镜像读的是 `config.jitrl.store.mirrorToMemoryBridge`（`index.ts:1453`），二者都不读 volatile 开关。
- **影响界定**：L3 **默认关闭**（`config.ts:357`），必须显式配置才启用，所以**不是安全阻塞**；但方案 §R8 的「一键关闭」对 L3 未兑现。
- **未覆盖的处置**：verifier 不改产品代码。建议 owner（integrator / T7 写域）在 `setEnabled` 里追加 `jitWiring.advisor` 与镜像的运行时闸门，或明确在 README/方案里把 §R8 改为「关闭 L1/L2；L3 需重启或改配置」。**本轮未修复，故 P5a-4 判「部分通过」而非「通过」。**

### F2【低危·如实披露】评测报告的检索延迟列不可复现

重新生成 `work/p5-eval-report.md` 后有 **12 行**（检索 p50/p95）与提交版不同，其余 **139/151 行逐字相同**；差异只有延迟数字、生成时间与输出路径。报告 `:84` 与 `:30` 已声明延迟是微基准、不参与确定性断言，**属预期行为**，但读者不应把延迟列当稳定基线。

### F3【信息】`--expect-final-improvement` 在 Final==Avg 时**不**报错

`--expect-final-improvement --conditions B1` → exit 0。脚本 docstring 写的是「Final < Avg 时失败」，等值不失败，**行为与文档一致**，此处仅记录语义，避免误读为「该开关保证有提升」。

### 未实现项（沿用 T6 的显式清单，本轮复核其仍成立）

| 项 | 状态 | 说明 |
| :-- | :-- | :-- |
| A1 Prompt-update 消融 | **未实现** | 需独立 prompt 注入路径 |
| A4 不使用 invariant 隔离 | **未实现** | 当前隔离是编译期硬约束，无可关闭开关 |
| A5 只用 LLM 奖励 | **未实现** | 需真实 LLM judge |
| A6 Embedding 检索 | **未实现** | 会引入模型/网络依赖，与「零新增依赖、离线确定」冲突 |
| L3 顾问的**收益数字** | **未实现（无数字）** | L3 默认关闭，不参与 12 个离线任务；行为由 unit/e2e 覆盖，**没有收益对照数据** |
| §9.1 第 2/3 类任务集（真实仓库基准、30 个 DSH 任务） | **未实现** | 需适配层与真机执行；本轮只有 12 个离线合成任务 |
| 真实 DSH 宿主 / 真实 MCP 后端联调 | **未验证** | 全部测试使用结构替身；仓库承诺不宣称真机验证 |

**因此不得从本报告推出**：真实仓库收益、跨任务泛化强度、真实 LLM judge 的影响、embedding 检索是否更好、L3 的实际收益。

### 方法学澄清（应 captain 要求记录，避免后续评审误判）

- eval-harness **未修改任何既有测试期望**。全部既有套件（P0–P3 的 1104 例基线）断言逐字未变；`offline-dreamer.test.ts` 与 `proposer.test.ts` 的 diff 均为**纯追加**。
- 唯一一次断言调整在它**自己新建**的 `tests/e2e/jitrl-ablation.test.ts` 内：`toBeCloseTo(mean, 6)` → `toBeCloseTo(round(mean), 6)`。原因是报告按设计把发布值四舍五入到 4 位（如 0.6667），这是让新断言匹配被测系统的既定输出契约，**不是放宽门禁**。本轮复核确认：`round()` 由 `work/p5-eval-report.md` 的出版契约定义，且该断言仍以 6 位精度比对。
- 本轮 T8 未修改任何测试文件、未删减任何用例；唯一改动的生产/文档文件是 `README.md`（四处计数）。

---

## 4. 本轮未能独立复现的项（如实标注）

| 项 | 状态 | 替代证据 |
| :-- | :-- | :-- |
| P4-5 漂移 ρ=0.7 的**独立探针** | **未独立复现** | 未另写探针；证据取自 `retriever.ts:89` 源码 + `retriever.test.ts:387-500` 的 37 例断言（t3 另做过两次变异自检证明断言有判别力）。这是**证据强度较弱**的一档，故单列而非混入"全部独立复现"。 |

其余 P4-1/2/3/4、P5a-1/2/3、P5b-1/2/3、P5c-1/2 均有本轮独立探针或全量绿支撑。

---

## 5. 探针自身的三次错误（留证，避免被误读为产品缺陷）

本轮写了 5 个独立探针（`work/_t8-p4-probe.mjs`、`_t8-p5a-probe.mjs`、`_t8-p5b-probe.mjs`、`_t8-jit-off-probe.mjs`、`_t8-determinism.mjs`），前三次运行失败**全部归因于探针构造**，逐条记录：

1. **P5-a 探针**：retriever 返回裸 `ExperienceRecord` 而非 `ScoredExperience`（缺 `{record, similarity:1, weight:1}`），被相似度门控过滤 → 证据归一化后全 0 → 恒 `noop`。修后 advisory 正确产生 **293 tokens**。
2. **P4 探针 v1**：`createDiscoveryTree` 的 root 不由 `options.root` 传入（需 `idFactory: () => 'root'` + `rootPatchId`）；`causalExperienceSnapshot` 第二参是 `number` 而非 snapshot 对象（传对象导致 `createdAt > 对象` 恒 false → 全部保留）。
3. **P4 探针 v2**：`policyWith` 漏了 `maxWidth:1`/`maxDepth:2`/`earlyStopThreshold`，用了默认 4/3 → 前沿可同时探多节点，任何 β 都直接吃到高分叶，β 曲线被抹平；且未用 `TRADE_OFF_WEIGHTS`（0.2/0.1/0.7/0.1）而是自编 0.5/0.3/0.2 → 钩子无需克服 invariant 先验。
4. **jit-off 探针**：`runFromCommand` 的文本在 `result.jitCommand.text` 而非 `result.text`；且 `import tests/e2e/fixtures.ts` 在纯 Node 下抛 "Vitest failed to access its internal state"（该夹具 import 了 `vi`）→ 改为探针内自建 Cordis stand-in。

方法论收获：**探针在比较 before/after 之前，必须先断言中间态真的变了**。jit-off 探针现在会校验 `command.jitCommand.json.enabled === false`，只有确认开关翻转、且 after 仍注入/仍 ask，才算 finding——否则"命令没执行"会被误报成"关不掉 L3"。

---

## 6. 写域核对

| 文件 | 是否本轮改动 | 说明 |
| :-- | :-- | :-- |
| `README.md` | **是**（唯一） | 仅 4 处计数（`:73`、`:294`、`:295`、`:296`） |
| `work/p4-p5-verification.md` | **是**（新建） | 本报告 |
| `work/_t8-*.log` / `*.mjs` / `*.json` | 是（新建） | 验证过程物证；`vitest.config.ts` 已 `exclude: ['work/**']`，不污染计数 |
| `src/**`、`tests/**`、`scripts/**`、`package.json` | **否** | 未触碰；`git status` 中这些路径的改动全部来自 T1–T7 |

---

## 7. 结论

- **可交付**：typecheck 0、全量 61 文件/1114 用例全绿、`check:docs` 连续两次 SUCCESS、eval 脚本 exit 0、四条核心验收路径（P4 双环、P5-a 顾问、P5-b 镜像、P5-c 评测）均有**本轮独立证据**。
- **一条中危缺陷待处置**：F1 `/evo jit off` 不覆盖 L3 顾问与记忆镜像。默认关闭使其不构成安全阻塞，但方案 §R8「一键关闭」对 L3 未兑现；**P5a-4 判「部分通过」**。
- **诚实边界**：本报告的收益数字只适用于 12 个离线合成任务；真实仓库基准、真实 LLM judge、embedding 检索、L3 收益均**未实现/未验证**。
- **计数终态 61/1114**：任何后续增删或改名测试都会使其失效，发布前必须重跑 `pnpm run check:docs`（且必须单独运行，不与 `pnpm run test` 并行）。
