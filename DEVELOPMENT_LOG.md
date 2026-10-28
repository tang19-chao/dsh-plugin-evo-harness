# 开发过程记录：JitRL Phase 4 / Phase 5 落地

> 仓库：`tang19-chao/dsh-plugin-evo-harness`
> 方案依据：`dsh-plugin-evo-harness-JitRL-开发方案.md`（§3.3 / §7.2 / §7.3 / §8 Phase 4–5 / §9）
> 实施方式：AgentTeams 多智能体协作（8 成员 / 14 任务）
> 最终状态：**P4 完整交付，P5-a/P5-b/P5-c 完整交付；两条 high 缺陷经独立评审发现并已修复；6 项 medium 与 5 项 low 如实保留为已知限制**

---

## 1. 交付摘要

| 指标 | 起点 | 终点 |
| :-- | --: | --: |
| 测试文件 | 54 | **63** |
| 测试用例 | 964 | **1129**（全绿） |
| `pnpm run typecheck` | clean | **clean** |
| `check:docs` | 通过 | **通过（连续四次 SUCCESS）** |
| `eval:jitrl` | 不存在 | **exit 0，数字可复现** |
| JitRL 源码模块 | 13 | **16**（+host-advisor / host-tool-experience / stores/bridge.store） |

净增 **+9 文件 / +165 用例**，既有 964 用例零失败。

### 新增能力

**Phase 4 — Dream-RSI × JitRL 双环**
- jit 超参（β/λ/α/k/gamma/similarityThreshold）纳入离线做梦的候选扰动网格，按 index **整组替换**而非逐元素混合
- `replayTree` 支持注入**同步纯函数** `JitReplayHook`，在每层前沿排序前修正 slotWeights
- **因果截断**：`causalExperienceSnapshot` 以 `record.createdAt <= tree.createdAt` 裁剪，钩子看不到未来样本
- 热替换仅当 `V(m*) > V(0)`，且 π 与 jit 超参**一起**切换
- **漂移降权**（ρ=0.7）：热替换后旧 policyId 经验降权，同 bucket 新经验达 k 条后停止

**Phase 5 — L3 宿主顾问 / 记忆镜像 / 评测**
- `host-advisor.ts`：advisory / gate 双模式，默认关闭，注入 ≤300 tokens，**gate 只能 ask，编译期+运行期双重封死 deny**
- `host-tool-experience.ts`：`tools/post-execute` 采集 isError/退出码 + `turn/end` reason.kind，按 §6.5 合成奖励，产出 `level='host_tool'` 经验 —— 补齐了 L3 顾问的**唯一真实证据来源**
- `stores/bridge.store.ts`：经验聚合统计镜像到 MCP，只写聚合值、命名空间隔离、开关关闭时**零客户端触达**
- `scripts/eval-jitrl.mjs` + `jitrl-eval-lib.ts`：L=5 协议、B0–B3 对照组、A2/A3 消融、健康度与安全指标
- `/evo jit off` 现在同时闸住 L1、L3、镜像、host-tool 采集四处（`runtimeGate`）

---

## 2. 时间线（14 个任务）

| # | 任务 | 负责 | 结果 |
| :-- | :-- | :-- | :-- |
| T1 | 合约 v2 增量 + 配置严格校验 | kernel-contracts | 55/996 绿 |
| T2 | P4 双环（超参扰动 + replay 钩子 + 因果截断） | dream-loop | 58/1092 绿 |
| T3 | P4 漂移降权（policyId 维度） | kernel-contracts | 57/1058 绿 |
| T4 | P5-a L3 宿主顾问 | host-advisor | 56/1024 绿 |
| T5 | P5-b 记忆桥聚合镜像 | bridge-mirror | 57/1058 绿 |
| T6 | P5-c 评测 harness + 首份报告 | eval-harness | 59/1104 绿 |
| T7 | 集成接线（barrel / 状态面 / hook / orchestrator） | integrator | 61/1114 绿 |
| T8 | 全量验证 + README 计数终刷 | verifier | 61/1114 绿，发现 F1 |
| **T9** | **独立评审** | reviewer | **needs_revision：2 high / 6 medium / 5 low** |
| T10 | 修复 H1（在线 β 构造期冻结） | kernel-contracts | 62/1125 绿 |
| T11 | 修复 H2 + F1（host_tool 生产者 + 一键关闭） | integrator | 62/1120 绿 |
| T12 | 修复 M1（invariant 的 L2 侧门） | kernel-contracts | 63/1129 绿 |
| T13 | 修复轮复验 + 计数刷新 | verifier | 63/1129 绿，eval 指标块逐字节相同 |
| T14 | 二次评审 | reviewer | **会话因服务端 500 失败，未完成** |

---

## 3. 评审发现的两条 high 缺陷（这是本轮最有价值的部分）

T9 独立评审没有停留在"测试全绿"，而是用**代码路径**判定，发现了测试覆盖结构性绕过的问题。

### H1 — 热替换的超参不被在线决策读取

**现象**：离线做梦把 β 热替换成 2，但在线 L1 决策仍用构造期冻结的初始 β。

**根因**：`jit-active-policy.ts:498` 的 `this.config = resolveConfig(...)` 只在构造期执行一次；`update()` 只做 `base.update + derivedCache.reset()`，不刷新 `this.config`；`:576` 的 `composeDecision` 用的是 `this.config.beta`。

**为什么没被测出**：`p4-wiring` 只断言**重放候选**的 β 网格，无一条断言**在线** `jit_meta_adjust` 用新 β。

**修复**（T10）：新增 `effectiveConfig(policy)`，每次决策现读 `base.policy.jit` 覆盖 beta/k/similarityThreshold/lambda/alpha。
关键设计取舍：**不引入第二份需同步的快照**——现读天然让 `update()` 立即生效。
`policy.jit` 缺失时直接返回原对象（零分配、逐字段等价）。

**验证**：β 反推法——用 β=0 运行的 `adjustedLogit` 当先验 z，`(z'(β)−z)/normalizedAdvantage` 反推生效 β，断言热替换后每条非零 Ã 反推为 **2**（9 位小数）。探针实测 `0.5 → 2（KL 0.0494→0.7122）→ 0.5 → 无 jit 回落 0.5`。

### H2 — L3 顾问在生产路径没有 host_tool 经验来源

**现象**：`kernel.createHostAdvisor()` 在真实插件里**永远 noop**。

**根因**：`orchestrator` 只写 `level: 'meta'` 与 `'proposal'`，**无任何 `'host_tool'` 生产者**；适配器的 `tools/post-execute` 只做 `counters.postExecute.applied += 1` 计数，不采集 isError、不落经验。而顾问只查 `level='host_tool'`，空邻域即 noop。

**为什么没被测出**：`p5-wiring` 的三条 P5-a 用例**全部注入了自带 retriever 的 advisor**，完整绕过了 `kernel.createHostAdvisor()` 默认分支。

**修复**（T11）：新增 `src/jitrl/host-tool-experience.ts`，按 §6.5 合成奖励（工具错误 −2 / 成功 +0.5 / 同错误重复 −3；turn completed +1 / error −2 / max_tokens −1 / aborted 0），生成 `level='host_tool'` 记录；适配器 `post-execute` 真转发，懒注册可选 `turn/end` 监听。

**验证的关键设计**：新测试**不注入 advisor/retriever**，并加了**反证步**——零证据时 gate 必须 `allow`（若有替身 retriever 回答，这一步就会直接 ask）。探针实测 `BEFORE: allow, hostToolExperiences=0` → `AFTER: ask, hostToolExperiences=5`。

### F1 — `/evo jit off` 不关闭 L3 与镜像（T8 发现，T9 复核成立）

**根因**：`setEnabled` 只写 `volatileJitEnabled` + L1 的 `runtimeEnabled`；L3 读构造期 `config.jitrl.hostAdvisor.enabled`、镜像读静态 `mirrorToMemoryBridge`，都不看 volatile。

**影响界定**：L3 **默认关闭**，需显式配置才启用 ⇒ 不是安全阻塞；但方案 §R8 明确写"可通过 `/evo jit off` 一键关闭"，属**契约未兑现**。

**修复**（T11）：引入单一 `runtimeGate`，同时闸住 L1 / L3（pre-step 不注入、pre-execute 不 ask）/ 镜像 / host-tool 采集四处。

### M1 — invariant 的 L2 过滤存在侧门（medium，一并修复）

**根因**：`orchestrator.ts:1936-1938` 的 L2 决策过滤读 `slot.guidance`（策略可标注），而专用守卫 `guidanceFilterForSlot` **生产路径零调用**。自定义策略把 invariant 标成 `guidance:'memory'` 即可让记忆经验进入 invariant 候选选择，绕过 §7.1。

**修复**（T12）：改为 `guidanceFilterForSlot(slot.slot) ?? slot.guidance`，invariant 按**槽位种类**硬钉 `guidance_free`，其余三种槽回落原值。

**验证**：对抗用例在修复前**实测为红**（`expected [ 'memory', 'guidance_free' ] to deeply equal [ 'guidance_free' ]`，2 failed / 2 passed），修复后 4/4 绿。非 invariant 两条用例在修复前就已绿 —— 证明用例定位精准。

---

## 4. 验证方法（本轮沉淀）

### 4.1 独立复核而非采信自述
每个任务交付后，Lead 都独立复跑 `typecheck` + 全量测试，并用 `grep` 核对声称的符号是否真在文件中。评审阶段进一步要求"读代码路径"而非"读测试名"。

### 4.2 变异自检（证明断言有判别力）
| 修复 | 变异方式 | 结果 |
| :-- | :-- | :-- |
| T3 漂移 | 降权覆盖时间衰减 | 恰好乘积断言失败（expected 0.7 ≈ 0.35） |
| T10 H1 | `const jit = undefined as ...` | 2 failed / 47 passed（typecheck 仍 0） |
| T11 H2 | 删 `observeToolCall` 转发 | 5 例红 |
| T11 F1 | 删 `runtimeGate.enabled` 同步 | 恰好 2 例红 |
| T12 M1 | 改回 `input.slot.guidance` | **2 failed / 2 passed**（Lead 亲自复现） |

### 4.3 两次"通过 tsc 但破坏运行时"的机械损坏
1. **换行被剥离**：`src/index.ts` 被写成 69140 字符 / 1 行 / LF=0，文件里唯一的 `//` 行注释吞掉了后 53325 字符（含 `export function apply`）。tsc 报 `expected '}'`。
   判定方法：数原始 `{`/`}` 是否配平（361/361 平衡）+ 关键声明锚点计数 + 文件尾是否闭合 —— 三者结合可区分"内容缺失"与"换行问题"。
2. **正则被空格拆散**：`/^decision-(\d+)$/` 写成 `/ ^ decision - (\ d +) $ /`。`} const` 恰好是合法语句序列，**tsc 完全不报错**，但 2 个既有用例红。
   教训：**typecheck 绿灯 ≠ 语义正确**；落盘后应定向扫描正则/转义/引号是否被空格拆散。

### 4.4 探针自纠
verifier 的 5 个探针前四次失败**全部是探针构造错误**而非产品缺陷（`ScoredExperience` 缺包装、`createDiscoveryTree` 需 `idFactory+rootPatchId`、`causalExperienceSnapshot` 第二参是 number、`MetaSearchPolicy` 漏 `maxWidth/maxDepth`、`runFromCommand` 文本在 `result.jitCommand.text`）。
最关键的纪律：**比较 before/after 前必须先断言中间态真的变了**，否则"命令没执行"会误报成"关不掉 L3"。

---

## 5. 评测结果（P5-c）

协议：§9.1 第 1 类**离线合成集**，每任务连续 L=5，12 个任务 / 3 个家族。

| 组 | Avg | Final | Final−Avg | 解出率 |
| :-- | --: | --: | --: | --: |
| B0 Static | 0.569 | 0.569 | 0.000 | 0.250 |
| B1 Harness²+Dream-RSI | 0.889 | 0.889 | 0.000 | 0.667 |
| B2 +L1 | **0.889** | 0.889 | 0.000 | 0.667 |
| B3 +L1+L2 | 0.956 | 0.972 | +0.017 | 0.867 |

- A2（k 消融）：k=4 → 0.889；k=14 / k=20 → 0.969
- A3（β 消融）：KL 0.009 → 0.102 **单调升**（符合 §6.4），而 Avg 恒 0.956
- 安全：13 条件 / 3840 次 invariant 提案 / **泄漏合计 0**
- 可复现：指标块 137874 字符，两次运行逐字节相同（剥离计时列）

### 「L1 零效应」——本轮最有价值的负面结果

**B1 = B2 = 0.889，L1 元调度在这套任务集上零效应。**

根因可查：orchestrator 每轮只对**获胜候选**计分一次 → 4 个槽位动作拿到**同一个回报** → Ã 归一化后全为 0 → KL 仅 0.025。

这是本轮暴露的**真实设计缺口**：**槽位级信用分配需要按槽位分别计分**，而当前实现只做候选级计分。不是度量误差，也没有被粉饰。

---

## 6. 已知限制（本轮未修，如实保留）

### 6.1 medium（未修）

| 编号 | 问题 | 影响 |
| :-- | :-- | :-- |
| M2 | 「≤300 tokens」用的是自带 `estimateTokens`（ASCII 每 4 字符计 1），高熵标识符可低估 3–4 倍；单测用 `estimateTokens` 断言 `estimateTokens≤300`，属**自证** | **下调**「≤300 tokens 在真实 tokenizer 下成立」的结论强度 |
| M3 | replay 漂移按**整层**计数，非 §7.3-4「同 `(level,bucket)` 达 k 条」 | 会**提前停止**降权 |
| M4 | §9.1「跨任务泛化只用不相交任务经验」未实现：12 任务共享同一经验库 | **不能**用本轮数字论证跨任务泛化 |
| M6 | `advisorScope` 默认空 = host-local，advice 会注入**所有** dispatch，含 invariant 探针 fork 的 `agent/pre-step` | §7.1 侧门（顾问面） |

### 6.2 low（L1–L5，未修）
其中 L5：`config.ts:132,136` 的注释与 §3.3「永不 deny」相反，**易误导集成方**。

### 6.3 观察 O1（明确不判缺陷）
L1 元层装饰器的检索**没有 guidance 过滤** ⇒ invariant **槽位分配**会参考记忆经验。
判断：§7.1 约束的是 invariant **分支内容**（已由四处守卫钉死：增广 / proposer / 记录来源 / L2 过滤器），槽位分配属元决策。若认为 §7.1 也应覆盖"分配"层面，这是一条廉价加固项。

### 6.4 未实现（T6 报告范围）
- A1 / A4 / A5 / A6 消融组
- **L3 无收益数字**（缺对照数据）
- §9.1 第 2/3 类真实基准任务集（Harness² 公开基准子集、30 个 DSH 真实任务集）
- 真实 DSH 宿主 / MCP 联调

### 6.5 口径说明
T9 评审的 required fix 原文写「补在线 β 生效的 **e2e**」「补真实链路 **e2e**」，实际新增覆盖落在 `tests/unit/integration/`（真实插件入口 + 真实 hook 派发，但**非** `tests/e2e/` 目录）。功能覆盖与断言强度成立，目录归属如实标注。

---

## 7. 未完成事项

**T14 二次独立评审因服务端 500 错误（`d1api.xin` EOF）中途失败，未产出裁定。**

因此当前状态是：**三条修复（H1/H2/M1）已由 verifier 独立复验通过，但尚未经 reviewer 二次评审背书。**
若需闭环，应重跑 T14，重点裁定：
1. H1/H2/M1/F1 是否真闭合（不接受自述）
2. O1 属设计意图还是 §7.1 侧门
3. `tests/unit/integration/` 与评审要求的「e2e」口径差异是否构成验收不达标

---

## 8. 复现方式

```bash
pnpm install
pnpm run typecheck                 # 必须 exit 0
pnpm run test                      # 63 files / 1129 tests
pnpm run check:docs                # README 计数校验
node scripts/eval-jitrl.mjs        # 评测（exit 0）
pnpm run bench:jitrl               # 检索性能（p95 < 5ms）
```

> 注意：任何增删测试都会使 README 计数失效，必须**单独**重跑 `check:docs`（不要与 vitest 并行，会有 resource 争用假红）。

---

## 9. 附录：新增文件清单

```
src/jitrl/
├── host-advisor.ts            # L3 顾问（advisory/gate，永不 deny）
├── host-tool-experience.ts    # host_tool 经验生产者（§6.5 奖励合成）
├── stores/bridge.store.ts     # 聚合统计镜像（只写聚合值）
├── jit-active-policy.ts       # L1 装饰器（effectiveConfig 现读 jit）※改
└── index.ts                   # 工厂 + barrel ※改

src/dream-rsi/offline-dreamer.ts   # 超参扰动 + replay 钩子 + 因果截断 ※改
src/orchestrator.ts                # M1：按槽位种类硬钉 guidance ※改
src/index.ts                       # 状态面 + runtimeGate ※改
src/cordis-seams/dsh-hook-host-adapter.ts  # advisor 挂载 + post-execute 转发 ※改

scripts/eval/jitrl-eval-lib.ts     # 评测协议核心
scripts/eval-jitrl.mjs             # 评测 CLI

tests/unit/jitrl/host-advisor.test.ts
tests/unit/jitrl/bridge.store.test.ts
tests/unit/jitrl/jit-active-policy.test.ts        # +5 例（H1）
tests/unit/dream-rsi/jit-dream.test.ts
tests/unit/orchestrator/invariant-guidance-hardening.test.ts  # M1
tests/unit/integration/p4-wiring.test.ts
tests/unit/integration/p5-wiring.test.ts
tests/unit/integration/p5-host-tool-wiring.test.ts # H2/F1
tests/e2e/jitrl-ablation.test.ts
```

---

## 10. 附：2026-10-28 P0 修复批（rev.4）回链

> 本节为 P0 修复批（AgentTeams `rev4-p0-remediation`）的集成回链；§1–§9 记录的 JitRL P4/P5 轮内容保持历史原样，不回写。

### 三项 P0 修复（全部本地验证、独立审核 pass；未 commit / 未 push）

- **P0-A p62 临时仓库夹具**（`tests/unit/p62/evidence-gates.test.ts`、`commit-attestation.test.ts`）：删除「`worktree add --detach HEAD` + `checkout -b <uuid>` + `commit --allow-empty`」的假绿泄漏机制——空提交 tree==HEAD tree（被问的提交根本不含策略），且每次运行净增 3 个 `pr1-policy-commit-*` 永久 refs；改为 frozen 基线 `84a3d828…` 上私有 clone（`--shared --no-checkout` + 私有 index + 只读 `GIT_ALTERNATE_OBJECT_DIRECTORIES`）合成的真实提交夹具，清理语义升级为可断言（refs / worktree 计数 before==after）。修复后全量 Vitest 多轮复跑 refs 恒 9、worktrees 恒 1、`pr1-policy-commit-*` 恒 0。
- **P0-B PR-4A 证据可携性**（`scripts/eval/verify-pr4a-artifacts.mjs`，专属测试 8→13）：MISSING / CLEAN / DIRTY 三态确定且可诊断；t7 三项 findings（伪造 executedSources 可绕过、dirty 未绑 codeBaseline、可携性回退无诊断）经 t14 修复、t15 独立复审 **verdict=pass**（变异测试证明新增断言承重，非陪跑）。**当前有效计数 691/691 exit 0（warnings=[]）**——683 为 t3 前基线、688 为 t3 轮中间值，均非现行。F1 边界如实保留：raw-byte 历史产物在 LF 检出复验仍会失败，但已具备具名 `provenance-executed-sources-eol-divergent` WARN（含 `eolOnly` 分类）与文件头 / `--help` 的 CHECKOUT BYTE SPEC，**不声称跨 LF 直接可携**。
- **P0-C parity / attestation 目标校验**（`scripts/eval/compare-platform-digests.mjs`、`final-attestation.mjs`、新增 `node:test` 双套件 51 项、`compare-platform-digests.d.mts` 声明同步）：三平台闭集（恰 ubuntu/macos/windows 各一，命名约定不得混用）、`--expect-commit` / `--strict` / `verify-ref-conflict`、SELF-REFERENCE BOUNDARY（记录不覆盖包含自身的提交；`--verify` 通过 ≠ HEAD 已 attested；目标 SHA 永不伪造/回填）。t8 / t11 独立审核 pass。

### 本地门禁终态（2026-10-28，win32/x64）

typecheck / check:encoding / **check:docs（README 97 files / 1979 tests 机械匹配 SUCCESS）** / build + build-smoke / negative-result（A1..A6 PASS）/ guarded-regression **37/37**（无 package script，按 ADR 0002 门禁 #7 规范命令直跑）全 exit 0；`tests/unit/p62` 5 文件 176 测试全绿；README 计数由本批 integration（t9）统一同步（此前 t12 同步至 97/1974 后 t14 又 +5 测试，最终按 t15 复审实测 97/1979、unit 84/1820 落定）。

### 剩余授权事项（本轮未执行，未授权前不得自行执行）

1. **CI / package script 变更授权**：`.github/workflows/ci.yml` 的 fingerprint-parity job 尚未传 `--expect-commit "${{ github.sha }}"`——远端门禁目前仍不能排除「三平台一致指向错误 commit」；guarded-regression 如需纳入 pnpm 门禁链需新增 package script。
2. **目标提交生成 attestation**：现行 `docs/reports/final-attestation.json` 描述基线 `84a3d828…`；含记录自身的提交按 SELF-REFERENCE BOUNDARY 永不可自证——需在修复批提交落定后的目标提交上重跑 `pnpm run attest` 重生成。
3. **推送后三平台 parity 实测**：需 GitHub Actions ubuntu/macos/windows 实际产出三份记录并 `--expect-commit <推送 SHA>` 比对（本地无法替代；HEAD `0410d78` 远端 CI=failure、fingerprint/parity=skipped 的历史事实未变）。
4. **后续批次**：修订方案 P1–P6 未开始。

**边界声明**：本轮全部为本地验证修改；**本地绿 ≠ 远端绿**；未生成/伪造任何 attestation 或远端 CI 结果；未 commit、未 push。

---

## 11. 附：P0 CI 接线、目标提交 attestation 与推送（2026-10-28，rev.4 集成第二段）

> 本节仅追加，不回写 §1–§10。§10「剩余授权事项」1–3 在本段获得用户明确授权后执行；**远端结果只能由推送后的 GitHub Actions 运行产生**，本节不预先断言。

### 11.1 CI / package 接线（`.github/workflows/ci.yml`、`package.json`）

1. **`fingerprint-parity` 目标校验**：比较调用改为 `node scripts/eval/compare-platform-digests.mjs artifacts --json --expect-commit "${{ github.sha }}"`。此前三平台记录只能互相印证——三份一致但同指向错误 commit 的陈旧 artifact 目录会被判绿。
2. **同一步的失败语义修复（承重，非装饰）**：原步骤体 `node … | tee parity.json` 走默认 shell（`bash -e`，**不含 `pipefail`**；GitHub 文档明载 `-o pipefail` 仅在显式 `shell: bash` 时附加），管道退出码取 `tee`，所以规则失败会被记为绿灯。现为 `shell: bash` + `set +e` + `status=${PIPESTATUS[0]}` + `exit "$status"`：`tee`（日志输出、失败时仍写 job summary）全部保留，退出码改由规则本身决定。本地以合成三平台产物实测同一命令：目标匹配 → 0；目标不匹配 → 1；三平台 composite 不一致 → 1；旧步骤体在同一失败用例下 → 0。
3. **`fingerprint` 生成侧显式目标**：`final-attestation.mjs --ref "${{ github.sha }}" --expect-commit "${{ github.sha }}" --out attestation.json --json`——每个平台先自我保证「将要发布的记录就是本次 revision」。
4. **新增 `guarded-regression` job**（独立 job，刻意不作为 `verify` 的 `needs`）：`pnpm run guarded-regression`（ADR 0002 门禁 #7）与 `node --test scripts/eval/compare-platform-digests.node-test.mjs scripts/eval/final-attestation.node-test.mjs`。不设 `needs` 的目的：探针红必须表现为该 job 失败，而不是让三平台 parity 证据被 skip。
5. **`package.json` 新增 `guarded-regression` script**：`node scripts/eval/guarded-regression.mjs --json`；README 命令表与「Packaging status」同步（文档命令与门禁命令为同一字符串）。

### 11.2 attestation 严格门禁与 SELF-REFERENCE BOUNDARY（未擅自改变契约）

`verify` job 的 `pnpm run attest:verify` 保持**无目标参数**的自洽校验。记录只能描述生成它的提交，而证据提交自身包含该记录，因此 `--strict`（要求记录描述 HEAD）或 `--expect-commit github.sha` 在证据提交上**必然为红**（自指边界）；在代码提交上同样为红（记录仍指向旧基线）。故本轮**不**给 `verify` job 接目标门禁；「记录须描述证据提交的父提交」这类规则是新契约，需 ADR 后另行落地（见 §11.4）。

### 11.3 本地复验（2026-10-28，win32/x64，本批工作树）

| 门禁 | 实测 |
| --- | --- |
| `pnpm run typecheck` | exit 0 |
| `pnpm run check:encoding` | exit 0（314 tracked blobs；3 个显式 `-text` 例外） |
| `pnpm test`（全量 Vitest） | **97 files / 1979 tests 全绿**（unit 84/1820 + e2e 13/159），exit 0 |
| `pnpm run check:docs` | SUCCESS（README 97/1979、84/1820、13/159 机械匹配） |
| `pnpm run build` + `pnpm run check:build-smoke` | exit 0（`lib/index.js` 1003883B、ESM、68 named exports） |
| `pnpm run check:negative-result` | exit 0（A1..A6 PASS，历史 −0.250 保留） |
| `pnpm run guarded-regression`（新 script） | exit 0，`{total:37, passed:37, failed:0}` |
| `node --test` parity/attestation 双套件 | **51 pass / 0 fail / 0 skipped**，exit 0 |
| `node scripts/eval/verify-pr4a-artifacts.mjs` | **691/691，failed=0**，exit 0（F1 可携性边界不变） |
| 夹具泄漏边界 | worktrees 恒 1、`pr1-policy-commit-*` 恒 0、分支数不增长 |
| `pnpm run attest:verify`（旧记录） | exit 0，并**如实打印**「HEAD 不是记录提交」（自洽 ≠ 目标已 attested） |

### 11.4 边界与未闭环项

- **未被本轮覆盖**：`verify` job 的目标门禁（需 ADR，见 §11.2）；PR-4A 产物校验器在 LF 检出的可携性（F1，仍不声称跨 LF 直接可携）。
- **本节不作断言**：三平台 parity 是否在远端通过，只能以推送后的 Actions 运行日志为准（run URL、各 job 状态与目标 SHA 见推送轮报告）；**本地绿 ≠ 远端绿**。
- **提交与 attestation**：本段全部修改进入一个非 merge 提交；`docs/reports/final-attestation.json` 在该提交上以 `--expect-commit <该提交 SHA>` 重新生成并**单独提交**（记录不覆盖包含自身的提交，证据提交不被自己的 attestation 覆盖）。
