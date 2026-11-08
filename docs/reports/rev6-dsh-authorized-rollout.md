# rev6 DSH 授权落地交接（handover）

> **这份文件是什么**：把 rev6 审核结论落到 DeepSeek Harness（DSH）上的操作交接。它覆盖不需要授权的构建/自检、安装与 shadow 安全配置、A4-1 合入前后的差异、观测与回滚、rc4 smoke 必须回答的三个问题、真实收益 canary 的环境变量与成功语义、四臂消融的预注册与判定、以及 guarded-active 的前置条件。
>
> **这份文件不是什么**：**不是执行记录，也不是收益证据**。本工作流（编写本文件的会话）没有运行构建、测试、门禁、DSH 安装、`--check`、rc4 smoke、真实收益 canary、四臂消融或 guarded-active；没有真实模型调用、宿主写入、`HOSTSMOKE_AUTHORIZED=1`、`R3A_*` 实跑、commit/push/attest/PR。文中所有 `命令` 都是**待执行**的步骤，不是已通过的结果。
>
> **基线**：`fa1f2113861710f7fb2718fe91adc28b2354c770`（`git rev-parse HEAD`）。本报告以该基线的代码与文档为依据；施工工作流正在同一工作树并行修改 A1/A2 等文件，且**不 commit**。凡行号与符号冲突，以仓库真实代码为准。
>
> **证据口径**：代码引用 `path:line` 为编写时读取到的真实位置；报告/预注册引用文件与小节。凡是“本工作流未执行”的项，均在文中逐条标注，不写成 passed。

---

## 0. 一页速览

| 阶段 | 做什么 | 是否需要额外授权 | 本工作流状态 |
| :--- | :--- | :--- | :--- |
| P0 构建与自检 | `pnpm install/build/typecheck/test`、结构门、`host-smoke --check` | **否** | **未运行** |
| P1 安装 + shadow | `dsh plugin add`、`triggerMode=slash_command`、`mode=shadow`、`applyWinningPatch=false`、4 个首次运行面（`tool_guidance` 需 agent-loop） | **否**（但需要已安装 DSH） | **未运行** |
| P1-c rc4 宿主 smoke | 回答 A1/缓存/分支身份三问 | **是**：`HOSTSMOKE_AUTHORIZED=1` + 已安装 DSH | **未运行** |
| P2-a 真实收益 canary | 单任务、两臂、恰两次真实调用 | **是**：完整 `R3A_*` 绑定 + 硬预算 + 真实 host client | **未运行**；当前仓无绑定，历史结果为 `not-run` |
| P2-b 四臂消融 + 写回门对照 | 12 任务的可判别 2×2(+1) 设计；独立于 canary 预算 | **是**：独立预算、预注册与产物绑定 | **未运行**；设计脚本只算设计事实 |
| P3 guarded-active | `applyWinningPatch:true` 的受控灰度 | **是**：P2-b 正结果 + 宿主 branch/fork API + 显式批准 | **未运行** |
| 提交/证明 | commit/push/attest/远程 CI | **未授权**（本工作流明确不做） | **未运行** |

**发布口径**：链路接通、可诚实测量 ≠ 有收益。只有 P2-b 按预注册给出正结果，才可以说“有收益”；在此之前只能说“已具备测量机制”。

**评审状态**：用户提供的方案评审为 `approved:false`，其中与本手册直接相关的未闭合项至少包括（1）A4-1 的 `hasTrustedVerifier` 空 seam 表达式会导致默认路径崩溃（§4.4 已给出必须验收的安全写法），（2）A4-1 的“appended=0 / 物理 append=N”口径冲突（§4.5 用三计数拆开），（3）A4-3 与既有 M3 / credit-attribution reward 断言的冲突。**本报告不把 A4-3 写成已验收，也不替代最终门禁**；DSH 操作者应以工作流最终报告和门禁结果为准。

---

## 1. 前置条件与版本

| 项 | 要求 | 依据 |
| :--- | :--- | :--- |
| 代码 | 本仓库 checkout；基线 `fa1f211`。施工工作流的改动**未提交**，不要把它当作已发布版本 | `git rev-parse HEAD`；`git status` |
| Node | `>=20.19.0`（`package.json` `engines.node`）。DSH 0.2.1-rc.5 自带 Node 24.21.0；本仓 Node 24 只在 CI 的 `node24-compat` job 实测，本机基线是 Node 22 | `README.md:36-40`、`docs/reports/host-smoke-rc3.md` 头部 |
| pnpm | `11.7.0`（`packageManager`） | `package.json`；`README.md:37` |
| DSH | 目标 0.2.1-rc.5 / cordis 4.0.5；唯一宿主观测是 **rc3**（electron 44.7.0）。rc4/rc5 未测，不能外推 | `docs/reports/host-smoke-rc3.md` 头部；`docs/runbooks/rev7-safe-learning-operations.md:4` |
| 构建产物 | `lib/index.js` 是 loader 的 `main`，且 `lib/` 被 gitignore；安装前必须 `pnpm run build` | `README.md:84-85` |
| 运行注入 | 真实运行需要宿主提供模型 seam（`ctx.llm`）与 branch 执行器（`options.runBranch` / `options.agentLoop` / 插件解析的默认值）；缺任一都会确定性失败 | `README.md:40-46`、`src/index.ts:2420-2425` |

**当前工作树的事实**：`git status` 包含并行施工的 S1 文件（`src/dsh-bridge/branch.ts`、`agent-loop-executor.ts`、`patch-prompt.ts`、A2 fixtures 等）；`src/config.ts` **已包含** `jitrl.writebackGate`（`grep -n "writebackGate" src/config.ts` 在 284/287/474/616/1398-1399 有命中），所以下文第 4 节的 A4-1 契约与当前代码形状一致。本文件仍**不是执行记录**：其中的命令都是待执行步骤。

---

## 2. 不需要授权的构建与自检

### 2.1 最小构建链

```bash
corepack enable                      # 可选，激活 pnpm 11.7.0
pnpm install --frozen-lockfile
pnpm run build                       # 生成 lib/index.js + lib/build-stamp.json
pnpm run build:status                # 期望 stale:false；exit 0
pnpm run typecheck                   # tsc --noEmit
```

`pnpm install` **不会**自动触发根项目的 `prepare`/build；干净克隆必须显式 `pnpm run build`（`docs/runbooks/build-freshness-and-clean-tree.md` §1.5）。`lib/build-stamp.json` 绑定 `srcTreeSha256`、依赖摘要、产物 sha256 与 HEAD；改完 `src/**` 不重建，`build:status` 会以 `src-tree-mismatch`/`commit-mismatch` 判 stale。

### 2.2 测试与结构门

| 命令 | 作用 | 运行口径 |
| :--- | :--- | :--- |
| `pnpm run test` | 全量 Vitest | 本工作流**未运行**；最终由工作流统一跑一次 |
| `pnpm run test:unit` / `test:e2e` | 分层套件 | 迭代时可用；不要用它替代全量结论 |
| `pnpm run verify` | `typecheck` + `test` | 本工作流**未运行** |
| `pnpm run check:docs` | README 测试计数 + 配置参考叶子数 | 没有 `test-results.json` 时会**自己 spawn 一次全量 Vitest**；构造期只用 `node scripts/verify-readme-counts.mjs --docs-only` 查配置参考 |
| `pnpm run check:encoding` | **已提交 blob** 的 LF/例外检查 | 新建但未 commit 的文件不在判据内；不能拿本轮的绿当作新文件已编码的证据 |
| `pnpm run check:build-smoke` | 构建 + ESM 导入 + 导出面 | 本工作流**未运行** |
| `pnpm run check:negative-result` | 历史 −0.250 / A1–A6 不漂移 | 本工作流**未运行** |
| `pnpm run guarded-regression` | ADR 0002 gate #7：release-surface / isolation / trusted-source | 本工作流**未运行** |
| `pnpm run check:mutation` | pinned mutants 必须被指定测试名杀死 | A1/M5 落地后是 **five-mutant**；未落地前仍可能是 four-mutant，按实际 `MUTANTS` 读 |
| `pnpm run check:metering` | 生产 `.complete`/`.planNext` 必须经 MeteredModelAdapter | 本工作流**未运行**；它**不检查** ledger 是否真的传入 |
| `pnpm run check:orphans` | 每个 `src/**` 导出都要有 reader | 新 `patch-prompt.ts` / `surface-evaluability.ts` 必须被测试直接 import |
| `pnpm run check:import-coverage` | 每个 `src/**` 模块都要被测试直接/经 barrel import | 同上 |
| `pnpm run attest:verify` | 只验证**历史记录自己的提交** | 不覆盖当前 HEAD，也不覆盖新建文件；不得写成“HEAD 已证明” |

### 2.3 宿主就绪检查（不启动真实调用）

```bash
node scripts/host-smoke/run.mjs --check
```

- 它检查 harness 必需文件是否存在、能否定位已安装的 DSH；输出 `readiness ok=true` 才算就绪（`scripts/host-smoke/run.mjs:336-390`）。
- 找不到宿主时设置 `HOSTSMOKE_DSH_HOME=<DSH 安装目录>`；Windows 默认候选是 `%LOCALAPPDATA%\Programs\DeepSeek Harness`（`scripts/host-smoke/run.mjs:81-125`）。
- **它不做真实模型调用，也不构成授权**。`--check` 绿只说明 harness 自己能启动，不说明 A1 生效、不说明缓存、不说明收益。

### 2.4 预期非绿 / 不要误读

| 门 | 预期 | 原因 |
| :--- | :--- | :--- |
| `check:clean-tree` | 未提交工作树 **exit 1** | 这是设计行为，不是失败；不要把它塞进 `pnpm run verify` |
| `check:docs`（全量） | 计数未收口时红 | 计数只能来自**唯一一次**最终 Vitest 报告；施工期用手改 README 会制造漂移 |
| `attest:verify` | 可能 exit 0 | 它验证的是记录自己的提交；**不是** HEAD 绑定（`docs/runbooks/rev6-release-attestation.md` §3/§4） |
| `check:encoding` | 可能 exit 0 | 只读 HEAD blob；未跟踪文件不在内 |

---

## 3. 安装到 DSH 与 shadow 安全配置

### 3.1 安装

先构建，再安装；`link:` 指向仓库绝对路径。安装后插件在**下次启动**生效。

```bash
pnpm run build
dsh plugin --profile desktop add "link:<absolute-path-to-this-repo>"
dsh --profile desktop --dump-config        # 确认出现 id: evo-harness
```

卸载：

```bash
dsh plugin --profile desktop remove dsh-plugin-evo-harness
```

依据：`README.md:49-70`。`desktop` profile 是 Electron 应用保留的 profile，但由它自己的 CLI 管理；不要假设 `dsh plugin add` 会替你构建 `lib/`。

### 3.2 推荐的 shadow 配置（适用于 A4-1 已合入的构建）

```yaml
plugins:
  dsh-plugin-evo-harness:
    schemaVersion: 1
    enabled: true
    triggerMode: slash_command          # 只响应 /evo，不订阅失败事件
    enabledSurfaces:                    # 只开文本可评估面
      - system_prompt
      - guardrails
      - memory
      - tool_guidance
      - skills
    execution:
      mode: shadow                      # 宿主 baseline + 建议记录，零宿主副作用
      applyWinningPatch: false          # 只有 guarded-active 才合法
    dreamRsi:
      maxOnlineRolloutBudget: 3         # 建议 2-4；控制每任务候选 rollout
    jitrl:
      enabled: true
      writebackGate: auto               # 仅 A4-1 之后的构建接受这个键
      store:
        mirrorToMemoryBridge: false     # 默认 false；不要镜像到真实 memory
    memoryBridge:
      promoteOnComposeSuccess: false    # 默认 false；promotion 会写真实 namespace
    modelRoute:
      provider: qodercn
      model: dfmodel
      reasoningEffort: max
```

**逐项理由**：

| 配置 | 为什么这样设 | 代码/文档依据 |
| :--- | :--- | :--- |
| `triggerMode: slash_command` | 不订阅 `auto_fallback`/`always`；避免无人值守时自动跑任务。`/evo` 是唯一入口 | `README.md:278`；`src/index.ts:3191-3192,3360-3361` |
| `enabledSurfaces` 只列 5 个 | `TEXT_PROBE_EVALUABLE = system_prompt, guardrails, memory, tool_guidance, skills`；`scripts/subagents/plugins` 在文本探针里不可评估，A3 还会限制 proposer 只见交集 | `src/dsh-bridge/patch-prompt.ts:62-79`；`src/runtime/surface-evaluability.ts`（S2 新增） |
| `execution.mode: shadow` | 默认安全形态：宿主 baseline 执行 + 建议记录；patch/publish/memory 全部 deny | `src/runtime/execution-profile.ts:105-160`；`docs/adr/0002` §3/§4 |
| `applyWinningPatch: false` | shadow 下永久挂载必须被拒绝；配置校验在 `applyWinningPatch=true && mode!=guarded-active` 时直接报 `invalid_value` | `src/config.ts:1236-1242` |
| `dreamRsi.maxOnlineRolloutBudget: 3` | 限制每个任务的候选 rollout；不是 token/费用上限，judge 调用仍可能按候选数放大 | `README.md:284`；`src/config.ts` |
| `jitrl.enabled: true` | A4-1 之后配合 `writebackGate:auto`，无 verifier 时只审计；A4-1 之前建议 `false`（见 §3.3） | `src/config.ts:436-438`；A4-1 契约 |
| `jitrl.writebackGate: auto` | 无 trusted verifier 时 gate on（只审计）；有 trusted verifier 时 gate off（历史路径） | 见 §4；注意这个方向是反直觉的 |
| `store.mirrorToMemoryBridge: false` | 不把经验镜像到宿主 memory；真实 memory 权限本身也 deny | `README.md:329`；`src/runtime/execution-profile.ts:137-146` |
| `memoryBridge.promoteOnComposeSuccess: false` | promotion 会写真实 global namespace；默认关闭 | `README.md:268`；`src/runtime/execution-profile.ts` |

### 3.3 A4-1 之前的构建：不要写 `writebackGate`

A4-1 之前，`jitrl.writebackGate` 不在 `JITRL_KEYS`（`src/config.ts:576-604`），配置校验是严格的 unknown-key fail-closed；写进去会让插件挂载失败，而不是被忽略。若构建没有这个键，想要“shadow 下不积累在线经验”，用：

```yaml
    jitrl:
      enabled: false
```

`jitrl.enabled:false` 停掉 JitRL 的七个 surface（`/evo jit off` 的同一控制面），Harness² 的 propose→probe→compose 仍可跑；代价是没有 L2/JitRL 观测。A4-1 之前若保持 `jitrl.enabled:true`，shadow **仍会在线追加经验记录**（B5；`src/orchestrator.ts:1065` 默认 `writebackGate=false`，`src/index.ts` 不传）。这正是 A4-1 要修的行为。

### 3.4 shadow 到底保证了什么

**保证（宿主侧）**：`execution.mode: shadow` 解析为 `patch=denied`、`publish=denied`、`memory=denied`、`shadowRecords=true`（`src/runtime/execution-profile.ts:105-160`）。`applyWinningPatch` 即使被误设为 true，配置校验也会拒绝；permanent mount 只在 guarded-active 才可能（`src/cordis-seams/seam-manager.ts:495-537`）。`memoryBridge.promoteOnComposeSuccess:false` 与 `mirrorToMemoryBridge:false` 阻断真实 memory 写入路径。

**不保证**：

- **不是零成本**：shadow 仍会调用模型（propose/probe/compose/reflect），仍可能消耗真实 token；`triggerMode: slash_command` 只是把触发权交给你。
- **不是零执行**：探针在隔离 branch 内执行；host 需提供 `runBranch`/`agentLoop`/`ctx.llm`。shadow 的“零副作用”指宿主控制执行不被改写、探测后可回滚，不是“不跑”。
- **不是零本地学习**（A4-1 之前）：插件自己的 JSONL 经验池会追加。见 §3.3/§4。
- **不是 branch 级 hook 生效**：rc3 已观测宿主 dispatch 没有 branchId；shadow 下不要期待 hook 把补丁挂到 branch 上（见 §7 Q3）。

---

## 4. A4-1 合入前后的差异（`jitrl.writebackGate`）

**对操作者的净影响**：命令与 shadow 配置形状不变；配置多一个 `jitrl.writebackGate` 叶子（默认 `auto`）；默认 DSH（无 trusted verifier）从“在线学习”变成“在线审计”；有 trusted verifier 的默认仍走历史路径；公共 `EvoHarnessPluginOptions` 仍是 26 key，不新增 option。

### 4.1 先看版本门

在宿主侧读取**已解析**的插件配置（不是 YAML 原文）：

```text
plugin.config.jitrl.writebackGate
  → undefined  ：这是 A4-1 之前的构建；按 §4.2 的“前”列执行
  → 'auto'/'on'/'off' ：A4-1 之后的构建；按 §4.3 的“后”列执行
```

A4-1 之前把 `writebackGate` 写进 YAML 会被 `unknown_key` 拒绝；A4-1 之后 `validateEnum` 只接受 `auto|on|off`。不要用文档猜构建能力，读 resolved config 或诊断行。

### 4.2 前（基线 `fa1f211`）

| 项 | 行为 | 证据 |
| :--- | :--- | :--- |
| 配置 | 没有 `jitrl.writebackGate` 键 | `src/config.ts:576-604`（`JITRL_KEYS` 无此键） |
| 编排器默认 | `this.writebackGate = deps.writebackGate === true` → 手建默认 **false** | `src/orchestrator.ts:1017,1065` |
| 插件装配 | `src/index.ts` 的 deps 字面量**从不传** `writebackGate` | 全文件无 `writebackGate` 命中 |
| 在线写回 | 每条 executed probe 按 scorer 的 `learningEligible` 写入；无证据门 | `src/orchestrator.ts:2631-2681` |
| stage 记账 | `writebackGate: { enabled:false, judged:0, admittedToL2:0, auditedOnly:0, gateFired:0, ... }` | `src/orchestrator.ts:2426,2949-2960` |
| 日志 | `jitrl: appended N online experience record(s)`；N 是**物理 append**，不是 `executed` | `src/orchestrator.ts:1907` |
| L2 邻域 | `store.query` **不传** `learningEligibleOnly`；审计记录仍可能被检索 | `src/orchestrator.ts:3035-3064` |

**后果**：shadow 不是“零学习”。默认无 verifier 的轨迹多数是 `unknown` verdict，但 scorer 的 process 路径仍可 `learningEligible:true`；这些记录会参与 L2。历史报告已把这种形态描述为 C3-online 形态（`docs/reports/rev6-jitrl-intervention-result.md` §0/§6；B5）。

### 4.3 后（S2 步骤 2 目标契约）

| 项 | 目标行为 | 说明 |
| :--- | :--- | :--- |
| 配置 | 新增 `jitrl.writebackGate`，取值 `'auto' / 'on' / 'off'`，默认 `auto`；README 配置参考 75→76、78→79 | `README.md:239-246` 的叶子计数；A4-1 契约 |
| 解析 | `auto → enabled = !hasTrustedVerifier`；`on → true`；`off → false` | `src/runtime/writeback-policy.ts`（S2 新增） |
| 显式 seam | 宿主显式 `deps.writebackGate: true/false` 覆盖配置解析；装配时放在 `...options.deps` 之前，避免被展开覆盖 | S2 步骤 2；`src/index.ts:2349-2351` |
| 可信判定 | `hasTrustedVerifier` 只在**显式注入的 seam** 存在、`enabled !== false`、且 `runner.trustedProducers.size > 0` 时为 true | `src/orchestrator.ts:307`；`src/verification/types.ts:206-212` |
| 默认 DSH（无 seam） | `auto` → gate **on**：每条 executed probe 过 `judgeWriteback`；典型无 verdict → `rejected-no-verdict`，记录仅审计（具体拒绝码按 verdict/历史；G-A 需要当前 trusted 回执，G-B 需要历史里有可信记录；空/无可信历史时两条都不可达） | `src/jitrl/writeback-gate.ts:275-350` |
| 有 trusted verifier | `auto` → gate **off**：恢复历史路径 | 这是方案定义的极性，见 §4.4 |
| 审计编码 | 被拒记录仍持久化；`learningEligible:false`、`learningTarget:0`；`reward` 保留供审计 | `src/jitrl/writeback-gate.ts:392-400` |
| L2 过滤 | gate on 时 `store.query` 加 `learningEligibleOnly:true`，审计记录不参与邻居选择 | `src/orchestrator.ts:3058-3064` |
| stage 记账 | gate on 时 `writebackGate.enabled=true`、`judged=N`、`admittedToL2`、`auditedOnly`、`gateFired`、`refusalCounts`、`routeCounts`、`verdicts` | `src/orchestrator.ts:2949-2960` |
| 日志 | `jitrl: appended N ...` 仍是**物理 append** N；不要读成 admitted N | `src/orchestrator.ts:1907` |
| 契约不变 | `REWARD_CONTRACT_VERSION='r4/verifier-first-v1'`、权重 `{completion:0.5,steps:0.1,tool:0.1,turn:0.3}`、`scoreUnderRewardContract` 不变 | `src/jitrl/reward-contract.ts` |

**A4-1 只降低学习资格，从不授予学习**：门的第一条规则是 `!recordLearningEligible → rejected-record-ineligible`；它不会把一个被 scorer 拒绝的记录救活（`src/jitrl/writeback-gate.ts:275-310`）。

### 4.4 最容易被误读的极性：`auto` 不是“有 verifier 就开”

方案把 `auto` 定义为：

```text
auto: 无 trusted verifier → gate ON（只审计）
      有 trusted verifier → gate OFF（历史路径）
```

这与“有信任时更该设门”的直觉相反。**操作上必须读 resolved 值，而不是按字面猜**：

- 默认 DSH（无 host verifier、无可信历史）：`auto` = on；期望 `admittedToL2=0`、`auditedOnly=judged`、物理 append 不变。
- 有 trusted verifier：`auto` = off；如果你仍想让证据门来判断（而不是完全走历史路径），显式设 `writebackGate: on`；有 trusted 证据时 G-A/G-B 仍可能准入。
- 想完全恢复历史无门路径：`off`；只在明确接受“未验证信号可训练”时使用。

方案评审（P0）还指出一个实现级陷阱：`deps.verification` 是**可选**字段（`src/orchestrator.ts:307`），不能写成 `deps.verification?.enabled !== false && runner.trustedProducers.size > 0`——在无 seam 时前半句为 true，后半句会对 `undefined` 取 `.size` 并抛 `TypeError`。验收时必须看到显式的：

```ts
const seam = options.deps?.verification;
const hasTrustedVerifier =
  seam !== undefined && seam.enabled !== false && seam.runner.trustedProducers.size > 0;
```

这一段是**实现验收条件**，不是本报告已运行的代码。

### 4.5 计数口径：三个数不能混

| 字段 | 含义 | 典型关系 |
| :--- | :--- | :--- |
| `record_experience.detail.executed` | 实际执行过的候选探针数（reference 不计） | 判分/门判的 probe 基数 |
| `writebackGate.judged` | 过门的 executed probe 数（gate on 时） | `admittedToL2 + auditedOnly === judged` |
| `writebackGate.admittedToL2` | 被准入 L2 的 probe 数 | 无 verifier 时通常 0 |
| `writebackGate.auditedOnly` | 被拒、仅审计的 probe 数 | gate on 时通常等于 `judged` |
| `record_experience.detail.records` | 实际持久化的 ExperienceRecord 数（dedup 后） | 可能 > `executed`（每 probe 最多 L1+L2） |
| `jitrl: appended N` / `plugin.jitrl.storeSize` | 物理持久化计数 | **不是** `admittedToL2` |

**结论**：A4-1 后，“无 verifier”应表述为 **`admittedToL2=0`、`auditedOnly=N`、物理 append 仍为原来的 `records` 数**；不要写 `appended=0`。`appended` 是物理写入，gate 不删除审计记录（`src/jitrl/writeback-gate.ts:358-400`；`src/orchestrator.ts:1907`）。

### 4.6 A4-1 之前的安全替代

| 目标 | 做法 |
| :--- | :--- |
| shadow 完全不积累在线经验 | `jitrl.enabled: false`（停七个 surface；Harness² 仍跑） |
| 接受经验但先观察 | 保持 `jitrl.enabled:true`，记录 `storeSize`/`records`，运行后用 `/evo jit reset --confirm` 清理（**破坏性**，先备份 JSONL） |
| 只跑单任务最小观察 | `triggerMode: slash_command` + 小 `maxOnlineRolloutBudget` + 只开 5 面 |

不要为了“先试试 writebackGate”而在 A4-1 之前的构建里写这个键：strict config 会拒绝挂载。

---

## 5. 观测清单与预期诊断

### 5.1 每次运行必读

| 观测 | 位置 | 读法 |
| :--- | :--- | :--- |
| `outcome` | `EvoHarnessRunResult.outcome`（`src/types/contracts.ts:2025`） | `composed`/`probed` 才算有候选链路；`no_probe` 不是成功；`failed` 看 `failure` |
| `probesRun` | 同上 | 期望 `1 + 候选数`；`no_probe` 时通常只有 reference（1） |
| `selectedNodeId` / `composedPatchId` | 同上 | 是否真的选/组了补丁 |
| `diagnostics` | `EvoHarnessRunResult.diagnostics` | 每条 run 的事实日志；不要只看 summary |
| `plugin.settle()` | handle API（`src/index.ts:700-714`） | 事件触发的 run 的确定性 join 点；`/evo` 直接返回结果 |
| `plugin.executionProfileSnapshot()` | orchestrator（`src/orchestrator.ts:1070`） | 实际 mode 与 patch/publish/memory 权限 |
| `plugin.hostAdapterSource` | handle | `'dsh-hooks'`/`'context'`/`'injected'`/`'in-memory'`；不要用 rc3 的结论替代本机事实 |
| `plugin.surfaces` | handle（`src/index.ts`） | `enabled` 是配置事实，`mountable` 是适配器事实；`enabled && !mountable` 是真实状态，不是错误 |
| `plugin.jitrl.storeSize` / `runtime` | handle | 物理记录数 / `/evo jit off` 的 volatile 状态 |
| `plugin.orchestrator.activePatchIds()` | orchestrator（`src/orchestrator.ts:1167`） | shadow 下应为 `[]`；guarded-active 下才是永久挂载 |
| `plugin.orchestrator.lastVerificationViews()` | orchestrator（`src/orchestrator.ts:1094`） | 无 seam 时为空；有 seam 时是宿主认证视图 |
| `plugin.orchestrator.lastTrace()` | orchestrator | 阶段序列；细节用 `options.deps.onStage` |

**stage 细节**：`EvoHarnessStageEvent` 是 `{stage, runId, detail?}`（`src/orchestrator.ts:202-208`）。要拿 `record_experience.detail.writebackGate`，在 `options.deps` 里注入 `onStage`（`deps` 是公开 26-key option 之一，不新增公共 option）。不要从 `lastTrace()` 猜计数。

### 5.2 预期诊断（按构建能力读）

| 诊断（前缀/精确文本） | 出现条件 | 说明 |
| :--- | :--- | :--- |
| `execution profile: mode=shadow, patch=denied, publish=denied, memory=denied (ADR 0002 R2; shadow records on)` | 有 JitRL kernel 时 | 解析后的权限；`patch=explicit-opt-in-no-verdict-gate` 只在 guarded-active 且 `applyWinningPatch:true`，代码不检查 verdict |
| `c2a verification: no host runner injected; verdicts stay structural/shape-only (C2-pre conservative default)` | 无 `deps.verification` | 精确文本来自 `src/index.ts:2391-2392` |
| `c2a verification: host-owned runner ...; verdicts are registry-authenticated, not shape-only` | 有 seam 且 enabled | `src/index.ts:2378-2390` |
| `jitrl: appended N online experience record(s)` | 有物理 append | N 是物理记录数；不是 admitted |
| `writeback gate: ...` | A4-1 实现 | 稳定前缀；**具体措辞以实现为准**，不要复制猜测的字符串。方案示例是 `writeback gate: auto -> on (...)` |
| `proposal-not-evaluable: ...` | A3 跳过不可评估补丁 | 前缀；不建节点、不跑候选、不写回 |
| `offline dream skipped: ...` | A4-2 门槛不足 | 前缀；表示未 dream，不是 dream 失败 |
| `branch-scoped hook mount: unavailable (host dispatch carries no branchId)` | A5 诊断 | 精确文本是 A5 目标；仅当 `hostAdapterSource='dsh-hooks'` 且观测到 dispatch 但无 branchProof 时 |
| `c2a verification: ... conservative-degraded ...` | A4-5 目标 | `trustedProducers` 为空的防御分支；不要把它当作正常可学习状态 |
| `multi-step agent probe executor is active: ...` | `options.agentLoop` 存在且无显式 runBranch | 说明 agent-loop 执行器优先 |

**A4-3 注意**：若同一构建包含 A4-3，`record_experience` 可能另有 `notEvaluable`/原因码；`ExperienceRecord.reward` 仍是有限数值（可能为 0）。不要把 `reward=0` 当成“0 分参与平均”；读 `learningEligible`、`notEvaluable`、`writebackGate` 三个字段，不要相加。

### 5.3 停跑条件（看到就停）

- 有效 proposer 补丁下出现 `outcome=no_probe`。
- 候选探针 prompt 不含 `# Active harness patch for this branch`（A1 未生效或宿主自建 builder 接管）。
- shadow 下 `activePatchIds()` 非空、出现 permanent mount 诊断、或 `memory`/`publish` 权限不是 denied。
- `record_experience.detail.writebackGate.admittedToL2 > 0` 而运行环境**没有** trusted verifier。
- `jitrl: appended N` 与预期记录量差异巨大，或 `storeSize` 异常增长。
- 任何真实 memory 写入、publish、或 guarded-active 未授权行为。
- 预算/成本异常（canary 外）：先停 `/evo jit off` 或 `execution.mode: off`。

---

## 6. 回滚

| 级别 | 操作 | 作用 | 注意 |
| :--- | :--- | :--- | :--- |
| 1 关学习 | `/evo jit off` | 停 JitRL 七个 surface（决策、收集、镜像、dreamJit 等）；立即生效、进程内 volatile | 不是持久配置；重启后按 `jitrl.enabled` |
| 2 持久关 JitRL | `jitrl.enabled: false` + 重启 | 持久停学习/记录 | Harness² 仍可跑 |
| 3 停插件行为 | `execution.mode: off` + 重启 | 七面活动停止、无记录 | 也可 `enabled: false` |
| 4 卸载 | `dsh plugin --profile desktop remove dsh-plugin-evo-harness` + 重启 | 移除挂载 | 不影响其他 profile |
| 5 清理经验 | `/evo jit reset [bucket] --confirm` | `purge()` 删除经验记录 | **破坏性**；先备份 `jitrl-experience.jsonl`（若 `persistence.dataDir` 已接线） |
| 6 永久 patch | 回到 `shadow`/`off` 或重启/dispose | 释放 guarded-active 的 host-class mount | `applyPermanentPatch` 是 host-class + `permanent-patch:<id>` grant；下一次 run 会先 `disposeMountedPatches` |

**shadow 的宿主回滚**：shadow 没有永久 patch、没有 publish、没有真实 memory；卸载/切 `off` 后宿主行为应回到 baseline。**但**插件自己的 JSONL 经验不会被卸载自动删除；按级别 5 处理并保留审计备份。

**不要**用 `check:clean-tree` 判断回滚成功：它只看 git 状态，与宿主行为无关。

---

## 7. rc4 真实宿主 smoke：必须回答的三个问题（需要授权）

### 7.1 前置与命令

```bash
node scripts/host-smoke/run.mjs --check         # 先就绪；不启动真实调用
HOSTSMOKE_AUTHORIZED=1 node scripts/host-smoke/run.mjs --out docs/reports/host-smoke-rc4.md
```

- 需要：已安装 DSH（真实 apply 上下文）、`HOSTSMOKE_AUTHORIZED=1`（信封）、以及本次运行的真实模型/宿主授权。**`HOSTSMOKE_AUTHORIZED=1` 本身不是账号/预算绑定**；rc3 的 9.4-2 与 `docs/reports/rev6-real-benefit-preregistration.md` §5 都明确这一点。
- `docs/reports/host-smoke-rc4.md` 是新的 `--out` 目标；rc1/rc2 是冻结证据，不要覆盖；rc3 是上一份 rev6 证据，也不要覆盖。
- 本工作流**未运行**上述任何命令。

### 7.2 三个问题与判据

| # | 问题 | 需要的证据 | 通过/不通过的读法 | 不得声称 |
| :--- | :--- | :--- | :--- | :--- |
| Q1 | **A1 合入后，真实宿主上的候选探针是否带补丁段？** | 在插件挂载前包一层 `ctx.llm.stream`（或在 rc4 harness 里注入 recording executor），按块解码 `message.content`（DSH 传的是 `[{type:'text',text}]`，不是字符串；`src/dsh-bridge/model.ts:191-194`），记录每次 probe 的完整 messages。断言：候选 prompt 含 `# Active harness patch for this branch` 与补丁 marker；reference 不含 | 若候选 100% 含、reference 0% 含 → A1 在该宿主路径生效。若宿主显式提供 `runBranch`/`buildMessages`，插件的默认 builder 不参与；答案应是 **host-owned，未评估**，不是“A1 失败”。若候选不含且宿主没有自建 builder → A1 未生效，停 | 不得用“probesRun>0”代替；不得把 rationale 命中当成补丁正文命中；不得把测试 fake 的结果写成真实宿主结果 |
| Q2 | **真实 `cacheRead` 是否非零？** | provider 原始 usage + 声明的 counting semantics；`observeCacheUsage` 的 `precision` 必须是 `measured`，字段缺失是 `unknown`，不是 0（`src/dsh-bridge/cache-observation.ts`） | 若 measured 且非零 → Tail Injection 可以进入“可考虑 A/B”的状态；**仍不能**直接启用。若非零但 precision 是 estimated/unknown → 答案仍是 **unknown**。若 measured 且为 0 → 真实为 0 | 不得把估算值/缺失字段写成 measured 0；不得用单个非零样本声称缓存收益；Tail Injection 仍需配对、显著、预注册 |
| Q3 | **hook dispatch 是否仍然 branchId=0？** | `HostCapabilityManifest.identity.perHook` + host-real dispatch 的 `branchIds/sessionIds/namespaces` 计数；四个 hook 事件逐一记录 | 若全部 branchId=0、身份仅 session → 维持 rc3 的有界观测：branch-scoped hook mount 不可用；只能 host-class permanent mount，R2-2/Gate 4 不主张。若出现 branchId → 记录场景与字段，仍不推广到所有事件 | 不得把“4 场景 branchId=0”写成“宿主永不提供 branchId”；不得把 contract-shaped dispatch 当成 host-real |

**rc3 的事实基线**：4 个 host-real 场景实测 branchId=0、身份仅 session、`fork=false`；因此 R2-2 记 `blocked`、Gate 4 未通过（`docs/reports/host-smoke-rc3.md` 顶部方法差异与 `9.6-4` 行）。rc4 只能更新这个**有界观测**，不能把它升级成普遍断言。

**Q1 的现实提醒**：rc3 的 host smoke 主要跑 hook/adapter 探针，**没有跑 propose→probe 的完整 run**；要回答 Q1，rc4 必须增加一个会真正跑 propose→probe 的记录路径（或使用带 recording 的 `runBranch`/`ctx.llm`）。不要拿 rc3 的 `probesRun` 类字段替代。

---

## 8. 真实收益 canary：环境变量与成功语义（需要授权 + 预算）

### 8.1 前置与命令

```bash
# 1) 绑定凭据：先证明 runnable，不调用模型
node scripts/host-smoke/budget-binding.mjs --json

# 2) 只有 runnable:true 才允许 canary；--require-runnable 在不可运行时 fail-closed
node scripts/host-smoke/real-benefit.mjs --json --require-runnable

# 也可从凭据文件读取（进程 env 覆盖文件值）
node scripts/host-smoke/real-benefit.mjs --json --env-file <path>
```

`R3A_CREDENTIAL_FILE` 可指向 env 风格文件；脚本先读文件，再用 `process.env` 覆盖（`scripts/host-smoke/real-benefit.mjs:138-150`）。`HOSTSMOKE_AUTHORIZED=1` 只是信封，**不是** B-1..B-4 绑定。

### 8.2 绑定键（以 `REAL_BENEFIT_ENV_KEYS` 为准）

**B-1 账号 + 授权来源（必填）**

| 键 | 含义 |
| :--- | :--- |
| `R3A_ACCOUNT_PROVIDER` | provider（如宿主路由的 provider） |
| `R3A_ACCOUNT_MODEL` | model id |
| `R3A_ACCOUNT_ID` | 账号 id（脱敏后才进入报告） |
| `R3A_AUTHORIZED_BY` | 授权人/来源 |
| `R3A_AUTHORIZATION_REASON` | 授权理由/范围 |

**B-2 硬预算 + 费卡 + 路线（大部分必填）**

| 键 | 必填 | 含义 |
| :--- | :---: | :--- |
| `R3A_GENERAL_BUDGET_MICROS` | 是 | 总硬预算（micros，>0） |
| `R3A_MAX_CONCURRENCY_SEATS` | 是 | 并发座位（>0） |
| `R3A_RATE_MODEL_ID` | 是 | 费卡模型 id |
| `R3A_RATE_INPUT_PER_MILLION` | 是 | 输入费率 |
| `R3A_RATE_OUTPUT_PER_MILLION` | 是 | 输出费率 |
| `R3A_RATE_FALLBACK_MICROS` | 是 | 未知用量保守兜底（>0） |
| `R3A_VERIFICATION_RESERVE_MICROS` | 否（默认 0） | 验证预留 |
| `R3A_RATE_CACHE_READ_PER_MILLION` | 否 | cacheRead 费率；缺失时保守兜底 |
| `R3A_RATE_CACHE_WRITE_PER_MILLION` | 否 | cacheWrite 费率 |
| `R3A_RATE_REASONING_PER_MILLION` | 否 | reasoning 费率；若单独计费则必须定价 |
| `R3A_RATE_REASONING_SEPARATELY_BILLED` | 否（默认 false） | reasoning 是否单独计费 |
| `R3A_ROUTE_MAX_INPUT_TOKENS` | 是 | 路线输入上界（>0） |
| `R3A_ROUTE_MAX_OUTPUT_TOKENS` | 是 | 路线输出上界（>0） |
| `R3A_ROUTE_MAX_REASONING_TOKENS` | 是 | 路线 reasoning 上界（>=0） |
| `R3A_ROUTE_MAX_ATTEMPTS` | 是 | 网络尝试上界（>0） |
| `routeTokenizerVerified` 键 | 是 | tokenizer 已验证标志；**其字面 env 名在本 checkout 被 secret 扫描器遮蔽，读 `REAL_BENEFIT_ENV_KEYS.routeTokenizerVerified` 或 `budget-binding.mjs --json` 的缺失项获取真实名字** |
| `R3A_ROUTE_PROVIDER_ENFORCES_MAX_TOKENS` | 是 | provider 是否强制 max tokens |
| `R3A_ROUTE_ALL_BILLABLE_DIMENSIONS_PRICED` | 是 | 所有计费维度是否已定价 |

**B-3 只读工具白名单（必填）**

| 键 | 含义 |
| :--- | :--- |
| `R3A_READONLY_TOOLS` | 逗号分隔；可为空数组；`*` 被拒绝；per-branch tool face fail-closed |

**token 硬预算（必填，严格嵌套）**

| 键 | 含义 |
| :--- | :--- |
| `R3A_TOKEN_TOTAL_CAP` | 总量；必须 `<= 800,000,000`（`CANARY_TOTAL_TOKEN_CEILING`） |
| `R3A_TOKEN_PER_TASK_CAP` | 必须 `< total` |
| `R3A_TOKEN_PER_ARM_CAP` | 必须 `< per-task` |
| `R3A_TOKEN_PER_CALL_CAP` | 必须 `< per-arm` |

**任务与治疗（收集但当前不在 required 列表）**

| 键 | 含义 | 注意 |
| :--- | :--- | :--- |
| `R3A_TASK_ID` | 唯一 canary 任务 id | `REAL_BENEFIT_REQUIRED_ENV_KEYS` 不强制；缺失会得到空 `taskId`。要让 canary 有意义，必须提供 |
| `R3A_RECORDED_ADVICE` | 治疗臂附加的 recorded advice 原文 | 同样不被 required 强制；缺失时治疗臂没有实质 advice，**不是**收益对比 |

**运行器专用（不是 binding 字段）**

| 键 | 含义 |
| :--- | :--- |
| `R3A_CREDENTIAL_FILE` | env 文件路径；进程 env 覆盖文件 |
| `R3A_ADAPTER_MJS` | 导出 `invoke(request)` 的真实 adapter 模块；runner 用它构造 host client |
| `R3A_MODEL_SEAM=dsh-llm` | 表示外部已绑定 DSH `ctx.llm`；runner **不会**自己构造 client，单独设置它仍会 `blocked(host-client-unbound)` |
| `HOSTSMOKE_AUTHORIZED=1` | 信封，不是账号/预算绑定 |

### 8.3 成功语义（五态）

| 终态 | 条件 | 调用数 | exit | 能否说“有收益” |
| :--- | :--- | :---: | :---: | :--- |
| `not-run` | B-1..B-4/token 绑定不完整；0 次调用 | 0 | 0（`--require-runnable` 时 1） | 否 |
| `blocked` | 运行期中止：identity/noPolicy/unauthorized-tool/budget/token-cap/authorization/executor/host-client-unbound/identity-mismatch | 0 或部分 | 0 | 否 |
| `insufficient` | 两臂实跑，但 `verificationBasis` 不是 trusted（或 reward 缺失） | 2 | 0 | 否 |
| `passed` | 两臂 trusted，且 `reward_treatment > reward_baseline` | 2 | 0 | **只在该单任务上**；不外推 |
| `failed` | 两臂 trusted，且 `reward_treatment <= reward_baseline` | 2 | 0 | 否（但仍是成功的测量） |

关键规则（`src/dsh-bridge/real-benefit-controller.ts:2153-2169`）：

- `verificationBasis` 只有两臂都 trusted 才是 `'trusted'`；否则 `'untrusted'`/`'absent'` → `insufficient`。
- `passed`/`failed` 是**受益结论**；`insufficient`/`blocked`/`not-run` 不是。
- `exit 0` 只代表“报告已诚实产出”，不代表任何收益；`--require-runnable` 的 exit 1 是 fail-closed，不是测量失败。
- 只有恰两次调用（baseline + treatment）、同任务、只读工具、无 memory/publish/guarded-active；不重试、不扩任务（`scripts/host-smoke/real-benefit.mjs:1-40`）。

### 8.4 当前入口的一个硬限制（必须写进任何使用说明）

当前 `scripts/host-smoke/real-benefit.mjs` 调用 controller 时只传 `{ binding, identity, hostClient }`（`scripts/host-smoke/real-benefit.mjs:325-329`）。而 `runArm` 只在**legacy `callModel`** 分支接收 `verification` 回执；host-client 分支明确不携带 verification（`src/dsh-bridge/real-benefit-controller.ts:1391-1454`）。controller 也不会自己编造 receipt。

因此：

- **用当前入口跑通的 canary，预期终态是 `insufficient`，不是 `passed`/`failed`**，因为 `verificationBasis` 不可能成为 trusted。
- 要得到 `passed`/`failed`，必须由调用方在 controller 层提供 `trustedProducers` + `OperatorVerificationReceipt`（或扩展 runner 暴露该 seam）。这是**新的集成/预注册动作**，不是某个环境变量能打开。
- 这不否定 canary 机制的价值：它证明绑定、硬预算、只读工具面、两阶段结算、abort 触发器；它**不**证明收益。

### 8.5 读数清单

保存并检查 JSON 的：

- `verdict`、`runnable`、`missingItems`、`abortTrigger`、`realCallsMade`（runnable 时必须 2）。
- `binding.items[]`（B-1..B-4 + token budget）。
- `calls[].arm`、`outcome`、`admitted`、`admissionBasis`、`settlementPhase`、`usageRaw`、`measuredTokens`、`cacheReadSample.precision`、`reward`、`verificationStatus`、`verificationTrusted`、`tools`。
- `reward.baseline` / `treatment` / `delta` / `verificationBasis`。
- `boundaries`（必须包含“engineering green is not a benefit claim”一类声明）。

**不得**把 `estimated`/`unknown` 的 usage 改标成 `measured`；不得用单任务 `passed` 外推策略收益。

---

## 9. 四臂消融：预注册与判定（独立授权）

### 9.1 先分清两件事

1. **rev6 R1-4 的四臂消融**：`docs/reports/rev6-ablation-preregistration.md` 定义的 **2×2 因子设计 + Arm-0 冻结参照**。所谓“四臂”是 4 个因子格（`track ∈ {process, task-quality}` × `gate ∈ {off, nEff}`），不是总共 4 次运行；加上 Arm-0 是 5 个臂，**没有 Arm-5**。
2. **写回门 on/off 对照**：`docs/reports/rev6-jitrl-intervention-preregistration.md` 的 H2，是另一个预注册，不是四臂设计的一部分。两者都不等于旧的 `scripts/eval/eval-pr4a-five-arm.mjs`（V2 离线合成五臂协议）。不要混用数字。

### 9.2 冻结设计（从预注册读取）

| 项 | 冻结值 |
| :--- | :--- |
| 任务池 | V3 设计池 **12 任务**（`V3_DESIGN_VERSION='v3/tasks-20261029'`） |
| 轮次 | 3；决策点 36（12×3） |
| 独立分析单元 | **任务（12）**；episodes/rounds 不是独立样本 |
| 臂 | `Arm-0` 冻结参照 + `Arm-1..Arm-4` 四个因子格；无 Arm-5 |
| 因子 | `track`（process / task-quality）× `gate`（off / nEff） |
| 设计矩阵秩 | 4/4；交互可识别 |
| 主要终点 | 任务级 `verifiedRate`（二值） |
| 副终点 | `meanCoverage` |
| 族大小 | 4（两主效应 + 交互 + 受控对比） |
| Holm 阈值 | `[0.0125, 0.016667, 0.025, 0.05]` |
| 结构性下限 | `m_disc >= 8` 才可能被 Holm 校正后拒绝 |
| N=12 的 π* | **0.8693**（80% 功效所需的最小胜出率） |
| 功效示例 | π=0.80 需 20 任务；π=0.90 需 12 任务；N=12 只对极强效应有常规功效 |

### 9.3 判定规则（预注册 §6）

| 观测 | 允许措辞 | 禁止措辞 |
| :--- | :--- | :--- |
| Holm 校正后 p<0.05 且方向与预注册一致 | 在该任务池上观测到可判别的主效应/交互 | 生产规模显著、效应很大 |
| p>=0.05 且 `m_disc>=8` | **未拒绝**零假设（数据不支持差异） | **等价**、无差异、两臂相同 |
| `m_disc<8` | **insufficient**：结构上不可能拒绝 | 任何“无差异”表述 |
| 交互秩不足 | **undetermined** | 猜测方向 |
| 少数任务变差 | **degraded**（可与 insufficient 并存） | 用总体均值掩盖 |
| 无中途查看/序贯停止/补采样 | 单次运行 | “再看一批” |

**区间**：μ 用配对 t 双侧 95%（样本 SD）+ bootstrap 10,000（seed 固定）的 2.5/97.5 分位；π 用精确 Clopper–Pearson；胜/平/负按 `|Δ|<=1e-9` 记平；α=0.05 双侧；Holm 族大小 4。**`not-reject` ≠ 等价**；设计只保证“有机会判别”，不保证“有差异”。

### 9.4 当前状态与可执行入口

```bash
# 只算设计事实（floor / power / rank / task-table discriminability / holdout firewall）
# 明确不跑四臂；arms.status 是 not-run
node scripts/eval/rev6-ablation.mjs --json
```

该脚本自己的注释写明：`It does NOT run the four arms`（`scripts/eval/rev6-ablation.mjs:23-29`），`arms.status='not-run'`（`:155-163`）。**不要**把它的 `piStarAtPool`、`rank` 当成实验结果；它们是设计算术。

四臂的真实运行需要：

- 独立的预注册产物绑定（任务池/版本/摘要）+ 代码 provenance；
- 独立的预算与授权（不是 `HOSTSMOKE_AUTHORIZED`，不是 canary 的 `R3A_*`）；
- 冻结的 V3 任务表与统计验证器；
- 样本量按预注册；不扩大、不中途看。

**本工作流未运行四臂，也未运行写回门 on/off 对照。** 现有 `rev6-jitrl-intervention-result.md` 的结论是：写回门机制正确、180/180 仅审计、对 C3 的收益 `not-evaluable`；它**不是**“门的收益”证据。

### 9.5 写回门 on/off 对照（独立预注册）

- 主终点：`Δ = C3-online(off) - C3-online(on)` 的 verifiedRate 均值差；CI95 下界必须 `>= -0.05` 才算“未出现超过容忍界的退化”。
- 覆盖率否决：`C3-online(on)` 的 `meanCoverage` 相对 off 下降不得超过 0.10。
- 配对单位：同一任务的 `(C3-frozen, C3-online, gate)` 三元组；n=12。
- 门关必须与历史路径字节级等价（`admittedToL2 === 全部 executed`、`gateFired === 0`）。
- 当前：**未运行**；历史 fair 池无 trusted receipt，门退化为恒等，所以该池上不可判别。不要把“恒等”读成“门有效”。

---

## 10. guarded-active 的前置条件与灰度

### 10.1 它是什么

`guarded-active` 是四种执行模式之一；它只解锁 **patch 层** 的永久挂载（`execution.mode: guarded-active` + 显式 `applyWinningPatch: true` + patch 权限），**不解锁** publish 或 memory（`docs/adr/0002` §3/§4；`src/runtime/execution-profile.ts:105-160`）。代码在 mount 前**不检查 host-trusted verdict**，所以它不是“证据门”；mount 诊断会写 `NO host-trusted verdict gate is applied`。`applyWinningPatch:true` 必须在 `mode=guarded-active` 下才合法；否则配置校验直接报错（`src/config.ts:1236-1242`）。`conservativeGate=true` 也只能在 guarded-active 下构造，否则 orchestrator 构造期抛错（`src/orchestrator.ts:1044-1065`）。

### 10.2 前置条件（缺一不可）

| # | 条件 | 证据/检查 | 当前状态 |
| :---: | :--- | :--- | :--- |
| 1 | **P2-b 正结果**：四臂消融 + 写回门对照按预注册给出支持性结论 | 预注册判定；不是“门恒等”或“设计算术” | **未运行** |
| 2 | **可信验证（人工审查前置，非代码门）**：`deps.verification` seam 已注入、`enabled !== false`、`trustedProducers` 非空 | `src/verification/types.ts:206-212`；`src/runtime/execution-profile.ts` | 默认 **无**；代码**不**在 mount 前检查 verdict，mount 诊断会写 `NO host-trusted verdict gate is applied`。操作者必须在授权前人工审查证据 |
| 3 | **宿主 branch/fork 身份**：branch-scoped hook mount 或等价 fork API 可用 | rc3: 4 个 host-real 场景 branchId=0、身份仅 session、`fork=false`；R2-2 blocked、Gate 4 未通过 | **blocked**（有界观测） |
| 4 | **显式配置 + 显式授权**：`execution.mode: guarded-active`，`applyWinningPatch: true`，操作者书面批准 | 配置严格校验；不是默认 | **未授权** |
| 5 | **L2 replacement gate（选择阶段，不是永久挂载的 verdict 门）**：nEff/支持度/无反例；每次偏离仍过 replacement gate；exploration 预算可撤销 | `docs/adr/0002` §7；`guarded-regression` | 机制在，**未实测** |
| 6 | **可回滚**：permanent mount 是 host-class + `permanent-patch:<id>` grant；有 disposer | `src/cordis-seams/seam-manager.ts:495-537` | 机制在，**未实测** |
| 7 | **权限边界**：publish/memory 仍 deny；不因 guarded-active 自动获得 | `src/runtime/execution-profile.ts:137-146` | 结构保证 |

### 10.3 灰度顺序（建议）

1. **shadow 单任务**：`/evo` 跑一个可复现小任务；确认 `outcome`、`probesRun`、候选 prompt marker、`activePatchIds()=[]`、无 memory/publish。
2. **rc4**：回答 §7 三问；确认宿主身份与 A1 的真实行为。
3. **canary**：先 `budget-binding`，再 `real-benefit`；接受 `insufficient` 是合法终态；不把工程绿当收益。
4. **P2-b**：按预注册跑四臂/写回门对照；只有正结果才进入下一步。
5. **guarded-active 单任务**：显式 `mode: guarded-active` + `applyWinningPatch:true` + `writebackGate: on`（建议显式，不依赖 `auto` 极性）+ 最小预算；观察 `apply_patch`、`activePatchIds()`、permanent mount 诊断、宿主行为。
6. **扩大**：只有在单任务可回滚、无 memory/publish、L2 replacement gate 与人工证据审查稳定后才扩大；publish/memory 仍不开放。

### 10.4 它不授予什么

- 不是“永久 patch 的空白许可证”：L2 选择阶段仍要过 replacement gate（nEff、支持度、无反例）；但这只是**选择**门，不是最终永久挂载的 verdict 证据门——挂载只检查 mode、显式 `applyWinningPatch` 和 patch 权限。
- 不是 publish：publish 永远 deny（holdout 严格超越 + 显式授权 + artifact 三者缺一不可）。
- 不是 memory：真实 memory 写入在四种模式都 deny（除非测试专用 `memoryRealWrites` profile override；生产入口不产生）。
- 不是收益证明：guarded-active 只是“允许在显式授权下把选中的补丁永久挂载到宿主”；代码不检查 verdict，收益仍需 P2-b。

---

## 11. 明确未执行与不得声称

**本工作流未执行**：

- `pnpm install` / `pnpm run build` / `build:status` / `typecheck` / `test` / `verify`。
- `check:docs`（全量或 `--docs-only`）/ `check:encoding` / `check:build-smoke` / `check:negative-result` / `guarded-regression` / `check:mutation` / `check:metering` / `check:orphans` / `check:import-coverage` / `attest:verify`。
- `node scripts/host-smoke/run.mjs --check`；DSH 安装/卸载；真实 `/evo` 运行。
- rc4 smoke；真实模型调用；真实宿主写入；真实 memory 写入；publish。
- 真实收益 canary；`R3A_*` 实跑；四臂消融；写回门 on/off 对照；guarded-active。
- commit / push / attest / 改远端 / PR；README 修改。

**不得声称**：

- “候选探针在真实宿主上一定带补丁段”——需要 rc4 Q1。
- “cacheRead 已测量/缓存有收益”——现有仓 900 样本全 estimated、cacheRead=0；Tail Injection 仍 `gated-not-applicable`（`docs/reports/rev6-cache-recall-observation.md`）。
- “branch-scoped hook mount 可用”——rc3 是有界观测 branchId=0；Gate 4 未通过。
- “自进化有收益”或“−0.250 已修复”——没有 P2-b 结果；写回门对 C3 是 `not-evaluable`。
- “A4-1 已让 shadow 零学习”——只有构建包含 A4-1 且 resolved `writebackGate` 生效时才成立；A4-1 之前 shadow 仍在线写回。
- “canary `passed` 已得到”——当前入口缺 trusted receipt seam，预期 `insufficient`；`passed` 只可能是 controller 层集成后的单任务结论。
- “HEAD 已被 attestation 证明”或“远程 CI 绿”——本工作流不 commit/push；`attest:verify` 只验证历史记录自己的提交。
- “A4-5 的 worktree/只读工具 allowlist runner 已实现”——仓库没有该 runner；只有 `deps.verification` seam 和工具面/安全闸。

**已知残余限制**：

- **B8（同进程探针计量）**：公开 26-key options 没有独立 `ledgerSettlement` seam；`branch.metering` 只能在直接调用 `resolveDshCollaborators` 的 seam 中证明。`options.agentLoop` 存在时 agent-loop executor 优先，生产默认预算约束对同进程探针不可证。不要声称“探针已计量”。
- **A4-5**：`src/dsh-bridge/branch.ts` 与 `agent-loop-executor.ts` 的 `producedFiles` 恒为 `[]`；没有 worktree/只读工具 runner。`verification.status ∈ {passed,failed}` 只能来自宿主注入的 verifier 对内容/工件的检查，不是“可执行任务证据”。
- **A1 的“所有探针”**：只对两个内置执行器（同进程 `branch.ts`、agent-loop）的**默认 builder** 成立；宿主显式 `options.runBranch`/`deps.runBranch`/`buildMessages` 时，prompt 由宿主负责，插件不追加补丁。
- **B4/B5 在线自指**：A4-1 只决定“是否学习”，不改变 surrogate 的冻结分数；A4-2 才把 Dream 输入改成 `dreamEvidence`/`dreamScore`，在线 active-policy 仍是冻结 surrogate。不要在证据报告里把 A4-1 写成“已修自指”。

---

## 12. 证据索引

### 12.1 代码

| 主题 | 位置 |
| :--- | :--- |
| 默认 branch prompt / 补丁注入 | `src/dsh-bridge/branch.ts:121-146`、`:282-289`；`src/dsh-bridge/patch-prompt.ts:79,279-305` |
| agent-loop 默认 prompt | `src/dsh-bridge/agent-loop-executor.ts:369-383`、`:826-840` |
| DSH content block 契约 | `src/dsh-bridge/model.ts:191-194`、`:207-222` |
| 执行模式与权限 | `src/runtime/execution-profile.ts:105-160` |
| 写回门规则 | `src/jitrl/writeback-gate.ts:275-350`、`:392-400` |
| 编排器写回/计数 | `src/orchestrator.ts:1017,1065,1907,2426,2631,2896-2960,3035-3064` |
| 26-key options witness | `src/index.ts:415-460` |
| c2a 诊断 / 装配 | `src/index.ts:2180-2400`、`:3048-3066` |
| 配置严格校验 | `src/config.ts:576-604`、`:1236-1242` |
| permanent mount grant | `src/cordis-seams/seam-manager.ts:495-537` |
| canary 绑定/判定 | `src/dsh-bridge/real-benefit-controller.ts:424-455,710-741,936-993,1391-1454,2153-2169` |
| 五态终态 | `src/dsh-bridge/real-benefit-controller.ts:767` |

### 12.2 文档

| 主题 | 位置 |
| :--- | :--- |
| rev6 审核与落地方案 | 用户提供的 `dsh-plugin-evo-harness-模块算法对接深度审核与DSH落地方案-rev6.md`（本次运行指定依据；非仓库文件） |
| 安装/配置参考 | `README.md:49-110,239-330` |
| 默认安全形态 | `docs/adr/0002-p62-release-contract-and-default-safe-shape.md` §3/§4 |
| rc3 宿主事实 | `docs/reports/host-smoke-rc3.md`（顶部方法差异、`9.6-4`、identity evidence） |
| 写回门结果 | `docs/reports/rev6-jitrl-intervention-result.md` |
| 写回门预注册 | `docs/reports/rev6-jitrl-intervention-preregistration.md` |
| 四臂预注册 | `docs/reports/rev6-ablation-preregistration.md` |
| canary 预注册/结果 | `docs/reports/rev6-real-benefit-preregistration.md`、`docs/reports/rev6-real-benefit-result.md` |
| 缓存观测 | `docs/reports/rev6-cache-recall-observation.md` |
| surrogate shadow | `docs/reports/rev6-surrogate-shadow.md` |
| 构建新鲜度/attestation 边界 | `docs/runbooks/build-freshness-and-clean-tree.md`、`docs/runbooks/rev6-release-attestation.md` |

### 12.3 复跑命令（按需要授权，不是本报告已运行）

```bash
# 构建/自检
pnpm install --frozen-lockfile
pnpm run build && pnpm run build:status
pnpm run typecheck
pnpm run test
node scripts/verify-readme-counts.mjs --docs-only

# 宿主就绪（不启动真实调用）
node scripts/host-smoke/run.mjs --check

# rc4（需要 HOSTSMOKE_AUTHORIZED + 已安装 DSH）
HOSTSMOKE_AUTHORIZED=1 node scripts/host-smoke/run.mjs --out docs/reports/host-smoke-rc4.md

# canary（需要完整 R3A + 真实 host client）
node scripts/host-smoke/budget-binding.mjs --json
node scripts/host-smoke/real-benefit.mjs --json --require-runnable

# 消融设计事实（不跑四臂）
node scripts/eval/rev6-ablation.mjs --json
```

---

## 13. 交接结论

- **可以立刻做（不需要额外授权）**：构建、typecheck、离线测试/结构门、`host-smoke --check`、按 §3 的 shadow 配置做一次小任务观察（前提是宿主已安装且你接受模型调用）。
- **必须在授权后做**：rc4 smoke（§7）、真实收益 canary（§8）、四臂/写回门对照（§9）、guarded-active（§10）。
- **在 rc4 回答三问之前**：不要声称 A1 在真实宿主生效、不要声称缓存可优化、不要声称 branch-scoped mount 可用。
- **在 P2-b 正结果之前**：不要声称收益；`−0.250` 既未被推翻也未被确认。
- **在任何情况下**：shadow 不是零成本；A4-1 之前 shadow 不是零学习；canary 的 `insufficient` 是合法终态；`attest:verify` 不是 HEAD 证明；本报告不是执行证据。