# ADR 0006：宿主身份、信任与 mount 隔离（P4-A）

| 项 | 值 |
| --- | --- |
| 状态 | **accepted**（P4-A 的设计依据；实现与本文一致，见 §7 一致性表） |
| 日期 | 2026-10-29 |
| 任务 | t7 / P4-A：身份/信任 ADR 与紧急 mount 隔离（团队 `p2-p6-execution`） |
| 上游契约 | ADR 0001 D1（身份不可证明 → 不注入、不学习、普通执行透传，§2.5 预定了"宿主显式登记 host-session scope"这条兼容路径）、ADR 0001 D4（权限分层，不得隐式跃迁）、ADR 0005 §3.7（可观测计数必须在真实事件点测量，缺采集 ≠ 零值） |
| 影响范围 | `src/jitrl/scope-registry.ts`、`src/jitrl/runtime-control.ts`、`src/cordis-seams/{host-adapter,eight-surfaces,seam-manager,dsh-hook-host-adapter,errors}.ts` |
| 兼容性 | **有**，全部登记在 §6；生产 mount 路径语义收紧，直接调用 adapter 的注册保持旧语义并计数 |

## 1. 背景与事实（不是猜测）

P4-A 要回答一个问题：**同进程里，兄弟探针的 mount 会不会作用到宿主？** 事实来自仓库自身的真机形状探针，不是假设：

1. 真实宿主的 `agent/pre-step` 派发**完全不带身份**：`tests/e2e/host-smoke/probe.ts` 的 host-real 形状是 `ctx.waterfall(carrier, 'agent/pre-step', { messages, turn, step, signal }, next)` —— 身份在 `this`（carrier）上，payload 里没有 `branchId`/`sessionId`/`agent`。
2. 真实宿主的 `tools/pre-execute` 派发带的是 **host 的 agent carrier**（`agent.id` = 宿主会话），没有 `branchId`：探针、子探针、宿主工具调用**共享同一个 sessionId**。
3. 改动前的 `hookScopeMatches`（`src/cordis-seams/dsh-hook-host-adapter.ts`）在两种情况下都会命中探针 mount：
   - 派发**无任何身份**（`total === 0`）→ `return true`（文档里写明的 fail-open）；
   - 派发**只有 sessionId**（无 branchId）→ `identity.sessionIds.has(mount.sessionId)` 命中 —— 而探针 mount 的 sessionId **就是宿主会话**。
   于是兄弟探针的 prompt 段会进入宿主的 `system-prompt/assemble`，兄弟探针的 guardrails deny 规则会作用到宿主的 `tools/pre-execute`（**越权 deny**），反之探针之间也可经共享 session 互相命中。
4. 同一份文档（模块头 + 单测 `treats an identity-free host-local assembly as in scope, documented fail-open`）把这条泄漏写成了"已文档化的例外"。P4-A 的任务就是把"例外"改成"契约"。

因此本 ADR 不是风格讨论：它先把身份/信任/授权三类概念分开定义，再据此收紧 mount 匹配。

## 2. 决策 D-P4-1：身份分类与"sessionId 不得暗中承担 branch identity"

身份分三类，**只有第 2 类能授权 branch-scoped 行为**：

| 类别 | 定义 | 由谁证明 | 能授权什么 |
| --- | --- | --- | --- |
| **host identity** | 宿主自己的会话/命名空间（真实对话、真实工具调用） | 宿主适配层**显式**登记（`ScopeRegistry.registerHostScope({sessionId, grantedBy})`），grant 必填 | 只授权 host-class mount（§5）与 host-scope 解析；**永不授权 branch** |
| **branch identity** | 一条探针分支（`branchId` + 所属 sessionId） | 由我们自己的 `createIsolatedBranch` / `createBranchIdFactory` 铸造，并以 compound key 登记进 trusted `ScopeRegistry` | 授权该 branch 的 mount、advice、学习记录 |
| **claim（自称）** | payload 里出现的 `branchId`/`sessionId`/`agent.id`/`namespace` 字符串 | **无人证明**：只能作为"匹配键"，不能作为"授权" | 仅能匹配已登记的同名 branchId；不能把 session 变成 branch |

硬性规则：

- **R1**：`sessionId` 永不顶替 `branchId`。`ScopeRegistry.resolve(...)` 对 session-only payload 一律返回 `'unknown'` 并计入 `resolves.sessionOnlyRejected`；即使该 session 已被 `registerHostScope` 登记为宿主，也**不会**解析出任何 branch。`RegisteredHostScope.authorizesBranch` 在**类型上**就是字面量 `false`，没有运行期分支能把它变成 true。
- **R2**：`resolve` 需要**已登记的 compound key**（sessionId::branchId）。同一 branchId 登记在多个 session 下时，branch-only payload 判 `ambiguous`（不是"任选一个"）。
- **R3**：授权账本（§4）里，session-only grant **不能**授权 branch-scoped 请求，返回结构化 `session-cannot-authorize-branch` 并计数。

## 3. 决策 D-P4-2：身份读取词汇唯一化（`classifyScopeIdentity`）

`classifyScopeIdentity(...payloads)` 返回五种**互斥且穷尽**的状态之一，所有消费者（mount 匹配、advisor 的 D1 判定、观测计数）共用同一份词汇：

| status | 含义 | hasBranchProof |
| --- | --- | --- |
| `branch-and-session` | 恰好一个 branchId + 一个 sessionId | true |
| `branch-only` | 恰好一个 branchId，无 sessionId | true |
| `session-only` | 只有 sessionId（**共享 session 泄漏的确切形状**） | false |
| `ambiguous` | 多个 branchId 或多个 sessionId（互相冲突） | false |
| `unattributed` | 什么都没带（真实 `agent/pre-step` 的形状） | false |

`hasBranchProof` 是 branch-class mount 的唯一准入条件。

## 4. 决策 D-P4-3 / D-P4-5：信任与授权（同进程不是沙箱）

1. **信任来源**：分支登记来自 `createIsolatedBranch`/`applyPermanentPatch` 这类可信内部路径；payload 自称一律不可信（ADR 0001 D1 的"claimed vs proven"直接复用）。
2. **宿主身份必须显式登记**：`registerHostScope` 必须带非空 `sessionId` 与非空 `grantedBy`，缺失即抛错并计入 `hostScopeRejections`；host scope 有 TTL、可 dispose，且不产生任何 branch 身份。
3. **同进程不是沙箱**：`src/jitrl/runtime-control.ts` 新增 `createProbeAuthorizationLedger`，覆盖五类**必须显式授权**的动作：
   `external-tool-call`、`memory-write`、`multi-step-probe`、`real-host-smoke`、`paid-model-call`。
   - 默认拒绝（零 grant → `no-grant`）；无身份 → `identity-required`；grant 缺 `grantedBy`/`reason` 直接抛错并计数；
   - branch-scoped 请求只能由 branch-scoped grant 授权；session-only grant 授权 branch 请求 → `session-cannot-authorize-branch`；
   - TTL 过期 → `grant-expired`（与"从未授权"区分），`singleUse` 首次放行即消耗，`revoke` 立即失效，dispose 后一律 `ledger-disposed`；
   - **`runtimeEnabled: true` 不授权任何东西**，JIT 开关与授权账本正交（ADR 0001 D4 权限分层）；
   - 计数闭合：`checks === allowed + denied`，`denied === Σ deniedByCode`；诊断串不携带 branch/session/授权人文本。
4. **P4-A 不执行真实动作**：账本只落地"代码 + 契约测试"，**没有**接到任何生产调用点（`src/index.ts`、`src/orchestrator.ts`、`src/dsh-bridge/**` 不在本任务写入范围）。真实外部调用、记忆写入、多步探针继续要求显式授权 —— 这条在 P4-C 接线前**没有行为变化**，只是从"口头规则"变成"可失败关闭的代码契约"。

## 5. 决策 D-P4-4：mount scope class 与 fail-closed 匹配

每个 mount 增加 `HostMountScopeClass = 'branch' | 'host' | 'legacy-host-local'`（`src/cordis-seams/host-adapter.ts` 的 `HostSurfaceSpecBase.mountScope`）。匹配规则（`hookScopeMatches`，全仓唯一判定点）：

| class | 命中条件 | 谁产生 | 缺身份时 |
| --- | --- | --- | --- |
| `branch` | 派发**证明**了该 mount 的 `branchId`（session 不参与匹配） | 所有探针 mount（`runInIsolatedBranch`） | **fail-closed**，计入 `anonymousSuppressed` / `sessionOnlySuppressed` |
| `host` | 无身份派发；或 session/namespace 被该 mount 覆盖（含 branch 派发时的环境基线） | 只有永久 patch（`applyPermanentPatch`），且**必须带非空 `hostScopeGrant`** | 命中（这就是"host-wide"的定义，且是显式授权） |
| `legacy-host-local` | 改动前的旧规则（无身份见所有 mount、session 命中） | **只有**直接调用 adapter 注册且未声明 class 的调用方；生产 mount 路径永不产生 | 命中并计数（兼容债，见 §6.3） |

要点：

1. **生产路径全部显式声明 class**：`mountEightSurfaces` 从 `SurfaceMountContext.mountScope` 透传；`runInIsolatedBranch` 传 `'branch'`，`applyPermanentPatch` 传 `'host' + hostScopeGrant: 'permanent-patch:<id>'`（该调用点已被执行档的 patch 权限把守，故 grant 是具名授权而非默认放行）。契约测试断言生产路径产出的 `activeMounts()` 只可能是 `branch`/`host`。
2. **guardrail 越权 deny 关闭**：`denyRulesFor` 只采纳派发已证明的 guardrails mount；宿主侧 `options.denyTools`（集成方策略）仍然全局生效。被抑制且本来会命中的规则计入 `stats().scope.deniedRulesSuppressed`。
3. **prompt 泄漏关闭**：`promptMountsFor` 同样只采纳已证明的 mount；`system-prompt/assemble` 的"assembly 没有 sections 数组"诊断与作用域无关（宿主契约观测），因此保留为一次性有界 note，但**不再**因此注入任何探针内容。
4. **结构化计数**（`stats().scope`，每个 hook 事件一份）：`applied`/`delegated`（按派发计），`branchProofApplied` / `sessionOnlySuppressed` / `anonymousSuppressed`（按 派发×mount 计），另有 `legacyHostLocalMounts`、`deniedRulesSuppressed`。缺身份不再是"静默放行"而是"可读数字"。

## 6. 兼容性影响（逐条登记）

### 6.1 行为收紧（生产路径）

| 变更 | 之前 | 之后 | 影响面 |
| --- | --- | --- | --- |
| 探针 prompt mount 对宿主 assemble | 命中（无身份 / 共享 session） | 不命中（fail-closed） | 宿主提示词不再被探针段污染；探针分支内的注入仍按 branchId 生效 |
| 探针 guardrails 对宿主工具调用 | 命中（可 deny） | 不命中（仅计数） | 宿主工具调用不再被探针越权拒绝；分支内规则不变 |
| policy `options.denyTools` | 全局生效 | 全局生效（不变） | 集成方安全策略语义不变 |
| 永久 patch mount | 与探针 mount 同等匹配 | host-class，必须带 grant，且记入 trust registry | 语义不变（它本来就该影响宿主），但现在是具名授权且可审计 |

### 6.2 不受影响

- advisor / 学习通道：仍按 ADR 0001 D1 严格默认（不可证明身份 → 无 advice、无 ask、无学习记录）；本 ADR **没有**放宽它。ADR 0001 §2.5 预定的"宿主显式登记 host-session scope 后可进入契约表第 1 行"这条路径，本 ADR 只落地了 registry 侧（`registerHostScope`/`resolveHostScope` + 计数器），**未**打开 session-only 派发的 advice 通道（留给 P4-C 配合工具面校准）。
- 逻辑观测计数 `stats().assemble/postExecute/preStep.applied|delegated` 的口径：仍按"是否有 mount 与该派发相关"计数（相关≠授权），E2E 与既有单测的数字不变。

### 6.3 兼容债（明确保留、明确计数）

直接调用 `adapter.registerPromptSegment/registerGuardrails/mountMiddleware` 且**未声明** `mountScope` 的调用方，得到 `legacy-host-local`：匹配规则与改动前完全一致（含"无身份可见所有 mount"）。这不是遗漏，是**登记的兼容面**：

- 每次注册：`stats().scope.legacyHostLocalMounts += 1` + 一条有界诊断；
- 生产代码不可达：仓库内没有任何生产调用点直接调用这三个方法（只有 `mountEightSurfaces`），契约测试断言生产路径产出 0 个 legacy mount；
- 去留：P4-C 在真实宿主 smoke 通过后把默认改成 `branch`（届时需同步更新 `tests/unit/cordis-seams/dsh-hook-host-adapter.test.ts` 中 5 个"无身份派发可见 mount"的用例：'makes a mounted segment visible'、'replaces an existing same-named section'、'never clobbers a foreign same-named section'、'delegates with next() and preserves every other contribution'、'treats an identity-free host-local assembly as in scope, documented fail-open'；其中第 3 个含两次派发，第 4 个还断言 `stats().assemble.applied === 1`）—— 本任务**不改**该文件（不在写入范围）。  
  **收紧后的预期行为**（P4-C 执行时的定义，避免"改成 branch"只是一句口号）：未声明 `mountScope` 的直接注册**默认成为 `branch` class** —— 即"有 branchId 就必须被派发证明；无身份派发与仅 sessionId 派发一律不作用"，不再走 legacy 匹配；届时 `stats().scope.legacyHostLocalMounts` 恒为 0，`sessionOnlySuppressed`/`anonymousSuppressed` 会开始覆盖此前被 legacy 放行的派发（计数**只增不减**，因为放行被改成了抑制），而 `legacy-host-local` 退化为**显式可选值**而非默认。

### 6.3.1 P4-C：默认已收紧（legacy 从默认降为显式 opt-in）

t9（P4-C）执行了 §6.3 的"去留"分支并选择**收紧**：

- 未声明 `mountScope` 的直接注册从 `legacy-host-local` 改为 **`branch` class（fail-closed）**：只有证明了该 branchId 的派发才可见；无身份/仅 session 派发一律不作用；未声明且无 branchId 的 mount 直接 `mount_scope_not_authorized` 拒绝。
- `legacy-host-local` 仅保留为**显式可选值**：每次注册计入 `stats().scope.legacyHostLocalMounts` 并输出一条有界诊断；不再是任何路径的默认。
- §6.3 的四要素仍然有效（存在/触发条件/5 个用例名单/预期行为），其中"预期行为"自 t9 起为**已实现状态**：5 个受影响用例改为显式 host scope + grant（意图不变），1 个 session-only 观测计数用例改为 fail-closed 口径（`preStep.applied 1→0`、`delegated 1→2`）。
- 生产 mount 路径（`mountEightSurfaces`）零变化：始终显式声明 `branch`/`host`。
- 计数方向：`legacyHostLocalMounts` 只在显式 opt-in 时增长；此前被 legacy 放行的派发改由 `sessionOnlySuppressed`/`anonymousSuppressed` 计数（**只增不减**）。

## 7. 与实现的逐项一致性（可复核）

| 决策 | 实现位置 | 钉死它的测试 |
| --- | --- | --- |
| D-P4-1 sessionId 不承担 branch | `scope-registry.ts: resolve / classifyScopeIdentity / RegisteredHostScope.authorizesBranch: false`；`runtime-control.ts: session-cannot-authorize-branch` | `tests/unit/jitrl/scope-registry-identity.test.ts`、`tests/unit/jitrl/probe-authorization.test.ts` |
| D-P4-2 身份词汇唯一 | `scope-registry.ts: classifyScopeIdentity` | 同上（五状态 + 嵌套 agent carrier） |
| D-P4-3 宿主显式登记 | `scope-registry.ts: registerHostScope / resolveHostScope / stats().hostScopeResolves` | 同上（grant 必填、TTL、dispose、branch 派发不算 host） |
| D-P4-4 mount 隔离 | `dsh-hook-host-adapter.ts: hookScopeMatches / evaluateMountAuthority / resolveMountScope`；`eight-surfaces.ts`、`seam-manager.ts` 传 class | `tests/unit/seams/mount-scope-isolation.test.ts`（兄弟探针共享 session、越权 deny、grant 校验、生产路径无 legacy） |
| D-P4-5 显式授权 | `runtime-control.ts: createProbeAuthorizationLedger` | `tests/unit/jitrl/probe-authorization.test.ts` |
| 结构化计数 | `DshHookAdapterStats.scope`、`ScopeRegistryCounters`、`ProbeAuthorizationCounters` | 三个测试文件均断言闭合与具体数字 |

## 8. 明确不做（需授权或属后续任务）

| 项 | 状态 | 理由 |
| --- | --- | --- |
| 真实宿主 smoke / 真实外部工具 / 记忆写入 / 多步探针 | **未执行（需授权）** | 授权边界（团队准则 3）；本任务只落地账本与 fake-host 契约测试 |
| 付费模型调用 | **未执行（需授权）** | 同上 |
| 把授权账本接到 `src/index.ts`/`src/orchestrator.ts`/`src/dsh-bridge/**` | **未执行（写入范围外）** | 属 P4-C 工具面隔离；本 ADR 给出契约，接线时必须逐个调用点显式 `authorize()` |
| 打开 session-only 派发的 advice 通道 | **未执行** | ADR 0001 §2.5 的兼容路径需要 P4-C 的工具面/真实宿主校准，先保持 D1 严格默认 |
| 移除 legacy-host-local 兼容面 | **未执行（写入范围外）** | 需改 `tests/unit/cordis-seams/dsh-hook-host-adapter.test.ts`，见 §6.3 |
| 租约（WeakMap/TTL/重复注册不降级）与工具 allowlist | **未执行** | 属 P4-B / P4-C |

## 9. 术语表

- **mount**：一次可回滚的八面挂载（prompt 段 / guardrails / middleware 等），由 `mountSurface` 注册、`disposer` 回收。
- **fail-closed**：身份不可证明时**不作用**（而不是"作用于所有"），并且**一定计数**。
- **host-class mount**：唯一允许作用于宿主派发的 mount，必须有具名 grant（`hostScopeGrant`）。
- **host scope**：宿主身份的可信登记记录；只描述 session/namespace，类型上不携带 branch。
- **同进程不是沙箱**：探针与宿主共享内存/网络/工具面；凡越出测量世界的动作都要显式授权。
