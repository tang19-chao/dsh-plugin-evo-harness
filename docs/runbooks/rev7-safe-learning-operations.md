# rev7 安全学习运行手册（DSH 首次运行 / 观测 / 回滚）

- **适用构建**：`fa1f211` 之上含 rev6 A1–A6、B8、B9 落地的 rev7 工作树（本手册不绑定某个未提交的 sha）。
- **适用宿主**：DeepSeek Harness（DSH）0.2.1-rc.5 / cordis 4.0.5。rc4/rc5 的真实宿主结论必须重新测量，不能从 rc3 报告外推。
- **一句话**：先以 `slash_command + shadow + 4 个首次运行面 + writebackGate:auto` 运行，只审计、不学习；看到诊断再决定是否进入需要授权的真实宿主 / 真实收益阶段。第五个文本可评估面 `tool_guidance` 只在有 agent-loop 工具运行时时才加入（见 §4.1）。
- **不是收益声明**：本手册里的任何本地自检只证明链路可运行，不证明自进化有收益。收益只能在预注册的四臂消融（m=12，π*=0.8693）给出正结果后声张。

---

## 0. 范围与非目标

覆盖：

1. 前置条件与代码版本；
2. 构建、自检、安装；
3. 安全首次运行配置；
4. 运行中观测与停跑条件；
5. 回滚；
6. 分阶段授权运行（宿主 smoke、cacheRead、真实收益、消融、guarded-active）；
7. A3 / A4-5 / B8 / A5 的结构性限制。

**不覆盖**（本仓库没有、也不应在本轮伪造）：

- 真实模型调用、真实宿主写入（`HOSTSMOKE_AUTHORIZED=1`）；
- `R3A_*` 真实收益测量；
- 四臂消融与写回门 on/off 对照；
- guarded-active / `applyWinningPatch` 灰度；
- worktree / 只读工具 allowlist 验证 runner（仓库无实现，宿主无注入点；见 §7）。

---

## 1. 前置条件

| 项 | 要求 | 依据 |
| :--- | :--- | :--- |
| DSH | 0.2.1-rc.5（cordis 4.0.5，Electron 44.7）；rc3 smoke 在 win32 | rev6 审核基线 |
| Node.js | `>=20.19.0`（本仓库 `engines.node`）；审核机验证过 24.x | `package.json` |
| pnpm | `11.7.0`（`corepack enable`） | `packageManager` |
| 代码 | `fa1f211` + rev7 工作树；`lib/index.js` 必须由当前 `src/` 重新构建 | `scripts/build.mjs` / `build:status` |
| 模型 | 宿主提供 `ctx.llm.stream()` 或显式 `options.model`；插件不内置模型 | `src/dsh-bridge` |
| 探针执行器 | 宿主提供 `options.runBranch` / `options.agentLoop`，或由 `ctx` 解析同进程执行器 | `src/dsh-bridge/branch.ts` |
| 可信验证器 | **可选、只能由宿主注入 `deps.verification`**；没有它时按审计模式运行 | `src/verification/types.ts` |
| MCP 记忆 | 可选；无后端时 `Recall-Only`，不影响安全默认 | `src/memory-bridge` |

> `deps` 是公开的 26-key option 之一；**没有任何 config 字段能授予** trusted verifier、publish、memory 写入或永久 patch。

---

## 2. 构建与自检（不需要授权）

### 2.1 从源码构建

```bash
git clone <repository-url> dsh-plugin-evo-harness
cd dsh-plugin-evo-harness
corepack enable
pnpm install --frozen-lockfile
pnpm run build
pnpm run build:status          # stale 时 exit 1；只读 stamp，不跑真实调用
```

`pnpm install --frozen-lockfile` **不保证**触发根项目 `prepare`；必须显式 `pnpm run build`，否则 `lib/index.js` 可能缺失或过期（`artifact-missing` / `stamp-missing` / `src-tree-mismatch` / `dependency-mismatch`）。

### 2.2 本地自检

```bash
pnpm run typecheck
pnpm run test:unit            # 或按改动范围跑定向套件
pnpm run test:e2e             # 或按改动范围跑定向套件
pnpm run check:docs           # 需要完整 Vitest 报告；没有报告时会自跑全量
pnpm run check:encoding
pnpm run check:build-smoke
pnpm run check:negative-result
pnpm run guarded-regression
pnpm run check:metering
pnpm run check:orphans
pnpm run check:import-coverage
pnpm run check:mutation       # five-mutant（M1–M5）；M5 是 A1 回退
```

说明：

- `check:docs` 在根目录没有 `test-results.json` 时会**启动一次完整 Vitest**；发布门禁应由唯一一次完整报告驱动，不要在开发循环里反复触发。
- `check:encoding` 读取 **已提交的 blob**；未跟踪的新文件不会出现在它的检查里，提交前仍需确认新文件是 LF、无 BOM。
- `check:mutation` 在当前工作树上会创建临时副本；它不执行真实模型 / 宿主调用。
- 以上命令都**不是**真实宿主证据；它们只证明本地确定性链路和静态门禁。

### 2.3 宿主就绪检查（不是真实调用）

```bash
node scripts/host-smoke/run.mjs --check
# 找不到宿主时：
HOSTSMOKE_DSH_HOME=<DSH 安装目录> node scripts/host-smoke/run.mjs --check
```

Windows 默认安装目录通常是 `%LOCALAPPDATA%\Programs\DeepSeek Harness`。

`--check` 只回答“宿主是否就绪”，**不会**启动模型、apply 补丁或写入宿主。不要把 exit 0 当作“已在真实宿主上验证”。

---

## 3. 安装到 DSH

```bash
# 从本仓库 checkout 执行；链接安装需要绝对路径
dsh plugin --profile desktop add "link:<本仓库的绝对路径>"
dsh --profile desktop --dump-config     # 应出现 id: evo-harness
```

- `dsh plugin` 会在 profile 内执行 pnpm，并把声明了 `dsh.bundle` 的依赖合并进 `dsh.profile.bundles`。
- 安装/更新后需要**重启 DSH** 才会加载新 bundle。
- 卸载：`dsh plugin --profile desktop remove dsh-plugin-evo-harness`。

---

## 4. 安全首次运行配置

覆盖 `cordis.patch.yml` 的插件 section。以下每个键都是 `src/config.ts` 接受的（严格校验；未知键会拒绝挂载）：

```yaml
- id: evo-harness
  config:
    schemaVersion: 1
    enabled: true
    # 只响应 /evo，不订阅失败事件；首次运行最可控
    triggerMode: slash_command
    # A3：首次只开文本探针真正能评估的 4 个面（与方案 §5.4 对齐）。
    # scripts / subagents / plugins 不在列表里；纯这三面的补丁会被跳过。
    # tool_guidance 故意不开：文本探针只能看到说明（partial），
    # 只有存在 agent-loop 只读工具运行时时才值得开；见 §4.1。
    enabledSurfaces:
      - system_prompt
      - guardrails
      - skills
      - memory
    execution:
      mode: shadow                 # 对宿主零副作用：不永久挂载、不 publish、不写 memory
      applyWinningPatch: false     # 只有 guarded-active 才合法
    jitrl:
      enabled: true
      # A4-1：没有宿主 trusted verifier 时门为 on（只审计、不学习）；
      # 有 trusted verifier 时 auto 解析为 off（走历史路径）。
      # 不要把它当成“打开学习”的开关；显式 on/off 只用于已授权的对照实验。
      writebackGate: auto
    dreamRsi:
      maxOnlineRolloutBudget: 3    # 建议 2–4；每个任务最多 3 个候选 rollout
      offlineDreamTriggerEveryNTasks: 10
    memoryBridge:
      promoteOnComposeSuccess: false
    modelRoute:
      provider: qodercn
      model: dfmodel
      reasoningEffort: max
```

### 4.1 为什么首次只开这四个面（第五个是 tool_guidance）

代码的文本可评估面上限是 5 个（`TEXT_PROBE_EVALUABLE`：system_prompt / guardrails / memory / tool_guidance / skills）。§4 的首次运行配置只开其中 4 个：`tool_guidance` 的文本列是 **partial**（`SURFACE_EVALUABILITY`：`textProbe:'partial'`、`dshRecommendation:'on-with-agent-loop'`；方案 A3 也写“有 agentLoop 时开”），没有工具运行时它只贡献说明文本、不产生可区分的行为，所以首次运行省掉这部分预算。有只读工具运行时（`options.agentLoop`）后再加入。

| 面 | 文本探针 | 说明 |
| :--- | :--- | :--- |
| `system_prompt` | 可评估 | A1 把 append/replace 正文渲染进候选探针 |
| `guardrails` | 部分可评估 | 输出契约 / 追加规则 / forbidden / precondition 可见；只有显式 `tool:` / `deny:` 由宿主强制，自然语言规则只是 advisory |
| `memory` | 部分可评估 | 只看 branch-scoped working notes / recall tags；探针内不做真实召回或写入（“只用 working notes”即指此） |
| `tool_guidance` | 部分可评估（文本）/ 完整（agent loop） | 文本探针只读描述；只有带工具运行时的 agent-loop 探针才会实际调用 |
| `skills` | 可评估 | 每个 skill markdown 渲染成独立段落，不需要执行 |
| `scripts` / `subagents` / `plugins` | **不可评估** | 不执行生成代码、不注册子 agent、不挂 branch 级 middleware；见 §6 |

### 4.2 没有可信验证器时的预期

- `jitrl.writebackGate: auto` → 解析为 **on**：
  - `record_experience.detail.writebackGate.enabled === true`
  - `admittedToL2 === 0`
  - `auditedOnly === judged`
  - 审计记录**仍物理 append**（`jitrl: appended N`，不是 `appended 0`），但 `learningEligible: false`、`learningTarget: 0`；
- A4-3：纯文本 / 无可信 verdict 的探针还会带 `rewardSources.notEvaluable: 1` 和原因码；
- A4-2：Dream 只在 ≥12 棵 verified trees 时运行；首次运行通常看到 `offline dream skipped: ...`，这是**未 dream**，不是 dream 失败；
- A5：只有真实 `dsh-hooks` 适配器且观测到 dispatch 时，才出现 `branch-scoped hook mount: unavailable (host dispatch carries no branchId)`。

### 4.3 注入 trusted verifier（可选、宿主责任）

```ts
// 宿主代码，不是 cordis.yml 字段
createEvoHarnessPlugin({
  deps: {
    verification: {
      runner: createHostOwnedVerificationRunner({ ... })
    }
  }
});
```

- 这是唯一产生 trusted verdict 的路径；**没有 config 字段**能伪造。
- runner 的 `trustedProducers` 必须非空；为空时诊断会写 `conservative-degraded: trustedProducers is EMPTY`，记录保持 audit-only。
- shape-only / 自声明的 `metadata.verification` 永远不会成为 **consumer-trusted**，也不会成为 task-quality evidence；它的公开 `verification.status` 仍可能读到 `passed`，因为那只是 payload 的**声明**。trusted 需要 registry 身份 + binding + 宿主重算的 artifact digest + `trustedProducers`。
- 本仓库**不包含** worktree / 只读工具 allowlist 验证 runner；不要用一个自称 runner 的假实现来“打开学习”。

### 4.4 L3 host-tool 轨道（显式 opt-in，不受 writebackGate 否决）

- `jitrl.hostAdvisor.enabled: true` 会挂载 host-tool experience collector；这些记录来自宿主 hook 的 **process** 观测，不是 probe outcome；
- `jitrl.writebackGate` 只裁决 executed probe 的在线写回，不否决这条独立 process 轨道；没有 trusted verifier 时 host-tool 记录仍是 learning-eligible；
- 默认 `hostAdvisor.enabled: false`，所以“无 verifier 只审计、不学习”的默认结论成立；开启 L3 的宿主必须显式接受这一边界，并在 README 的 hostAdvisor 说明中记录；
- 集成测试 `tests/unit/integration/p5-host-tool-wiring.test.ts` 覆盖默认 advisor 路径；`tests/unit/jitrl/eligibility-contract.test.ts` 钉住 L3 的 strict filter 与 facade stamping。

---

## 5. 运行与观测

### 5.1 最小操作

| 步骤 | 命令/位置 | 期望 |
| :--- | :--- | :--- |
| 1 | `/evo jit status` | 显示 JitRL 开关、经验池计数、runtime 状态 |
| 2 | `/evo <一个可复现的小任务>` | `outcome` 为 `composed` / `probed`；`probesRun = 1 + 候选数` |
| 3 | 读 `EvoHarnessRunResult.diagnostics` | 逐条读，不要只看 summary；关键前缀见 §5.2 |
| 4 | 读 `options.deps.onStage` 的 `record_experience.detail.writebackGate` | `enabled / judged / admittedToL2 / auditedOnly / gateFired` |
| 5 | `plugin.orchestrator.lastVerificationViews()` | 无 runner 时为空；有 runner 时是宿主认证视图 |
| 6 | `plugin.orchestrator.activePatchIds()` | shadow 下必须是 `[]` |
| 7 | `plugin.orchestrator.lastTrace()` | 阶段序列；细节用 `onStage` |
| 8 | `plugin.hostAdapterSource` / `plugin.surfaces` | `enabled` 是配置事实，`mountable` 是适配器事实；两者不同是真实状态 |

### 5.2 关键诊断（按实际代码的精确文本/前缀）

| 诊断（前缀/精确文本） | 出现条件 | 读法 |
| :--- | :--- | :--- |
| `c2a verification: no host runner injected; verdicts stay structural/shape-only (C2-pre conservative default)` | 无 `deps.verification` | 这是诚实默认；没有任务质量学习 |
| `c2a verification: host-owned runner ... active (...); verdicts are registry-authenticated, not shape-only` | 有 seam 且 `trustedProducers` 非空 | 宿主认证视图可用 |
| `c2a verification: host-owned runner ... active but conservative-degraded: trustedProducers is EMPTY ...` | 有 seam 但 producer 集为空 | 所有记录 audit-only；不是正常可学习状态 |
| `jitrl write-back gate: jitrl.writebackGate=auto -> on (...) `（或 `off` / 显式值） | 有 JitRL kernel | 报告**实际生效**的布尔值与原因；`auto` 不是“永远 on” |
| `proposal-not-evaluable: slot ... dropped known surface(s) ...; ... no node was added ...` | A3 跳过不可评估补丁（含真实 proposer 先拒绝的 paths） | 省预算、保留 reference、不写回；不是失败 |
| `probe surfaces: enabledSurfaces=[...] contains no text-probe evaluable surface (...); the run was skipped...` | 空交集 | 整个 run 跳过；检查 `enabledSurfaces` |
| `offline dream skipped: N verified tree(s) < minimum 12 ...` | A4-2 门槛不足 | **未 dream**，不是 dream 失败 |
| `offline dream: replayed ...` | 已运行 dream | 只表示重放完成，不表示收益 |
| `branch-scoped hook mount: unavailable (host dispatch carries no branchId)` | A5，仅真实 hook 适配器观测到 dispatch 且 branchProofApplied=0 | 不要以为补丁已在宿主 branch 生效 |
| `multi-step agent probe executor is active: ...` | `options.agentLoop` 存在且无显式 `runBranch` | 探针走 agent loop；其 `ledgerSettlement` 也用于计量 |
| `branch metering: the agent-loop probe executor uses agentLoop.ledgerSettlement ...` | `agentLoop.model` + `ledgerSettlement` | agent-loop 探针自己计量 |
| `branch metering: the DSH-resolved same-process probe executor shares agentLoop.ledgerSettlement ...` | 只有 `ledgerSettlement`（无 model）且无显式 runBranch | 同进程探针通过该 settlement 计量；见 §7.3 |
| `branch metering: the caller-supplied probe executor is authoritative; ...` | 显式 runBranch + `ledgerSettlement` | settlement 只到 JitRL stage，不覆盖宿主执行器 |
| `permanently mounted scaffold ... (guarded-active explicit opt-in ... NO host-trusted verdict gate is applied)` | guarded-active + `applyWinningPatch:true` | 显式挂载；没有 verdict 证据门，必须按已授权灰度对待 |

### 5.3 停跑条件（看到就停）

- 有效 proposer 补丁下出现 `outcome=no_probe`，且没有 `proposal-not-evaluable:` 解释；
- 候选探针 prompt 不含 `# Active harness patch for this branch`（A1 未生效，或宿主自建 builder 接管）；
- shadow 下 `activePatchIds()` 非空、出现永久 mount 诊断、或 memory/publish 权限不是 denied；
- `writebackGate.admittedToL2 > 0` 而环境**没有** trusted verifier；
- 任何真实 memory 写入、publish、guarded-active 未授权行为；
- 预算/成本异常（canary 外）：先 `/evo jit off`，再考虑 `execution.mode: off`。

---

## 6. 回滚

| 级别 | 操作 | 作用 | 注意 |
| :--- | :--- | :--- | :--- |
| 1 关学习 | `/evo jit off` | 停 JitRL 七个 surface（决策、收集、镜像、dreamJit 等） | 进程内 volatile；重启后按 `jitrl.enabled` |
| 2 持久关 JitRL | `jitrl.enabled: false` + 重启 | 持久停学习/记录 | Harness² 仍可跑 |
| 3 停插件行为 | `execution.mode: off` 或 `enabled: false` + 重启 | 七面活动停止、无记录 | 不删除已有经验/审计 |
| 4 卸载 | `dsh plugin --profile desktop remove dsh-plugin-evo-harness` + 重启 | 移除挂载 | 不影响其他 profile |
| 5 清理经验 | `/evo jit reset [bucket] --confirm` | `purge()` 删除经验记录 | **破坏性**；先备份 `jitrl-experience.jsonl` |
| 6 永久 patch | 回到 `shadow` / `off`，或重启/dispose | 释放 guarded-active 的 host-class mount | 下一次 run 会先 `disposeMountedPatches` |

**shadow 的宿主回滚**：shadow 没有永久 patch、没有 publish、没有真实 memory；卸载或切 `off` 后宿主行为应回到 baseline。**但**插件自己的 JSONL 经验不会因卸载自动删除；按级别 5 处理并保留审计备份。

**不要**用 `check:clean-tree` 判断回滚成功：它只看 git 状态，与宿主行为无关。

---

## 7. 结构性限制（必须和运行一起读）

### 7.1 A3：proposer 最多看到 5 个可评估面（首次配置开 4 个）

- `enabledSurfaces ∩ {system_prompt, guardrails, memory, tool_guidance, skills}` 同时是 proposer 的 `allowedSurfaces` 和**渲染提示词只列出的面集合**；scripts/subagents/plugins 的 payload 契约不会再出现在提示词里；
- 键存在但正文为空（`guardrails: {appendRules: []}`、只有 `scopedViewId` 的 memory）不算可评估：不会建节点、不会跑候选；
- 纯 `scripts` / `subagents` / `plugins` 补丁在 `tree.addNode` **之前**被跳过：不建节点、不跑候选、不写回，reference 保留；
- 真实 Harness² proposer 的解析器会先拒绝这种响应，orchestrator 把它映射为同一 A3 跳过，`stopReason` 会是 `proposals_not_evaluable`；`outcome` 可能仍是 `no_probe`，这不是“P0-1 假绿”的 `no_probe`，diagnostics 有明确前缀；
- 交集为空时整个 run 记为 `skipped` + `stopReason=no_evaluable_surfaces`，不消耗 reference 探针。
- 首次运行按方案 §5.4 只开 system_prompt / guardrails / skills / memory；`tool_guidance` 要等有 agent-loop 只读工具运行时时再加入（见 §4.1）。proposer 的 allowed 集合是 `enabledSurfaces ∩ 5 个可评估面`，所以配置里开 4 个时 proposer 只会看到 4 个。

### 7.2 A4-5：验证 runner 由宿主提供；本仓库没有 worktree runner

- 生产只认 `deps.verification.runner`；没有它时 verdict 是 structural/shape-only；
- shape-only / 自声明 payload 不会被 consumer 信任，也不会成为 task-quality evidence；公开 `status` 可以仍是 `passed`（那是声明，不是可信结论）。trusted 需要 registry 身份 + binding + 宿主重算的 artifact digest + `trustedProducers`；
- 本仓库**不实现** worktree / 只读工具 allowlist 的验证 runner，宿主也没有注入点；本轮的 A4-5 交付是“验证已有 seam 的生产接入”，不是新 runner；
- agent-loop 的只读工具 allowlist 仍由既有的 `probe-safety` / `AgentLoopAdapters.safety` gate 承担；它只在调用前裁决，不提供隔离文件系统或临时 worktree；
- 因此 `verification.status ∈ {passed, failed}` 的比例 > 0 只能在宿主注入 runner 的真实运行里测量。

### 7.3 B8：探针计量通过 `agentLoop.ledgerSettlement`

- `src/index.ts` 把宿主已有的 `agentLoop.ledgerSettlement` 通过 `resolveDshCollaborators(..., { branch: { metering } })` 传给**同进程**执行器；没有第二个 ledger manager；
- 三种可达形态：
  1. `agentLoop.model` 存在 → agent-loop executor 跑探针，并使用同一个 settlement（诊断说 `agent-loop probe executor uses ...`）；
  2. 只有 `agentLoop.ledgerSettlement`（没有 model）→ 不创建 agent executor，DSH-resolved 同进程执行器接管，并通过 `branch.metering` 使用该 settlement（诊断说 `DSH-resolved same-process probe executor shares ...`）；
  3. 显式 `runBranch` / `deps.runBranch` 优先 → settlement 只到 JitRL 模型 stage，不到该宿主执行器（诊断明确说 caller-supplied executor is authoritative）。
- 公开 26-key options 仍**没有独立的 settlement seam**：完全没有 `agentLoop` 的装配里，同进程探针保持 unmetered。这是剩余的结构限制，不是可通过配置打开的开关。
- `tests/unit/integration/branch-metering.test.ts` 的 production-run 用例证明：ledger-only agentLoop 下真实探针的 reserve/settle 数等于 `probesRun`。

### 7.4 A5：rc3 观测没有 branch 身份；rc4/rc5 未测

- **rc3 观测**：真实 hook dispatch 的 `branchId=0`，身份只有 session；任何依赖 hook 的 branch 级补丁施加都 fail-closed。rc4/rc5 未测量，不能把 rc3 的结论外推；`--check` 只证明 readiness、不产生 dispatch，不能替代真实 smoke；
- 探针差异只能来自 A1（提示词）和 A1-b（工具执行器）；hook 只用于 guarded-active + `applyWinningPatch:true` 的 host-class 永久挂载；
- **永久挂载没有 verdict 证据门**：代码只检查 mode、显式 `applyWinningPatch` 和 patch 权限；mount 诊断会写 `NO host-trusted verdict gate is applied`。因此不能把 guarded-active 描述成 evidence-gated；真实灰度仍需要 §8 的授权和人工证据审查；
- 看到 `branch-scoped hook mount: unavailable ...` 是**正确**的诊断，不是需要修的 bug。

---

## 8. 分阶段授权

| 阶段 | 内容 | 需要授权 | 退出条件 |
| :--- | :--- | :--- | :--- |
| P0/P1 本地 | A1–A6、B8、B9 的单元/e2e/门禁 | 否 | 定向套件 + 结构门通过；完成本手册 §2 自检 |
| P1-c rc4 宿主 smoke | `HOSTSMOKE_AUTHORIZED=1 node scripts/host-smoke/run.mjs --out docs/reports/host-smoke-rc4.md` | **是** | 报告回答：候选探针是否带补丁段、cacheRead 是否非零、dispatch 是否仍 branchId=0 |
| P2-a 真实收益 canary | `node scripts/host-smoke/real-benefit.mjs --json --require-runnable` | **是**（`R3A_ADAPTER_MJS` / `R3A_CREDENTIAL_FILE` / `R3A_MODEL_SEAM` / `R3A_AUTHORIZED_BY` / 预算 / token caps / rate / 只读工具） | exit 0 只证明测量成功，不证明收益 |
| P2-b 四臂消融 + 写回门 on/off | 预注册 m=12，π*=0.8693 | **是** | 按预注册判定；这是唯一能推翻/确认 −0.250 的证据 |
| P3 guarded-active + applyWinningPatch | 灰度 | **是**，且需要 P2-b 正结果、宿主 branch/fork API | Gate 4；R2-2 仍受宿主 branch API 限制 |

### 授权边界

- 不设 `HOSTSMOKE_AUTHORIZED=1` 就不要运行真实宿主 smoke；
- 不绑定 `R3A_*` 就不要运行真实收益脚本；
- 不在未授权环境把 `execution.mode` 切到 `guarded-active`，也不要把 `applyWinningPatch` 设为 true；
- `exit 0` 的测量脚本只表示“测量成功”，不表示“收益为正”；
- 所有真实宿主/收益结论必须绑定报告路径、命令、退出码和采样时刻；`not-run` / `not-evaluable` 不得写成 pass。

---

## 9. 相关证据

- rev7 实现收口：`docs/reports/rev6-implementation-closeout.md`
- rev6 审核：`C:/Users/Administrator/Downloads/dsh-plugin-evo-harness-模块算法对接深度审核与DSH落地方案-rev6.md`（外部输入，不随仓库分发）
- 历史宿主 smoke：`docs/reports/host-smoke-rc3.md`
- 写回门 / surrogate 报告：`docs/reports/rev6-jitrl-intervention-result.md`、`docs/reports/rev6-surrogate-shadow.md`
- 消融预注册：`docs/reports/rev6-ablation-preregistration.md`