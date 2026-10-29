# P4-C 交付报告：工具面隔离与 fake-host 契约 smoke

| 项 | 值 |
| --- | --- |
| 任务 | t9 / P4-C（团队 `p2-p6-execution`，成员 p4-isolation） |
| 日期 | 2026-10-29 |
| 状态 | 代码 + fake-host 契约 smoke 完成；真实宿主 smoke **未执行（需授权）**（§5） |
| 上游契约 | ADR 0006（身份/信任/授权与 mount 隔离；D-P4-5 同进程不是沙箱） |
| 写入范围 | `src/cordis-seams/{tool-face.ts(新),dsh-hook-host-adapter.ts,host-adapter.ts,seam-manager.ts,index.ts}`、`scripts/host-smoke/contract.mjs(新)`、`tests/e2e/host-smoke/contract-smoke.test.ts(新)`、`tests/unit/cordis-seams/dsh-hook-host-adapter.test.ts`（队长移交的 5 个 legacy 用例）、`tests/unit/seams/mount-scope-isolation.test.ts`（t7 产物，随收紧同步）、本报告 |

## 1. 目标与边界

### 1.1 做了什么

1. **分支工具 allowlist**（`src/cordis-seams/tool-face.ts`）：每条探针分支一份显式 allowlist 策略；`tools/pre-execute` 对**证明了 branchId** 的调用执行策略，不在列表里的工具返回 `deny` 并写**结构化计数**；通配符 `*` 被显式拒绝（allowlist 不能退化成 deny-only）。
2. **隔离 branch context 的工具面生命周期**（`seam-manager.ts`）：`runInIsolatedBranch` 在挂载后为**该分支**安装策略（`label: 'probe:<branchId>'`），在 `finally` 中移除（成功/抛错/超时/abort 都清理）；兄弟分支各持一份，互不继承。
3. **默认收紧（legacy 二选一 → 选"收紧"）**：未声明 `mountScope` 的直接注册从 `legacy-host-local` 改为 **`branch` class（fail-closed）**；`legacy-host-local` 只保留为**显式可选值**（每次注册计数 + 有界诊断）。t7 留下的 5 个 legacy 用例已按新语义改写（§6）。
4. **fake-host 契约 smoke**（`tests/e2e/host-smoke/contract-smoke.test.ts`，可运行的仓库内测试）：逐字覆盖清单五项（sibling / 并发复用 / 过期租约 / 清理 / mount 不泄漏）+ allowlist 正负例；另有 `scripts/host-smoke/contract.mjs` 包装器（只运行该套件并打印机器可读摘要 + 真实 smoke not-run 清单，不含任何 smoke 逻辑）。

### 1.2 边界声明（不得把同进程执行描述成沙箱）

- 工具面与 `ctx.fork` 都是**同进程内的协作式边界**：同一进程、同一文件系统、同一网络与凭据。`ctx.fork` 给的是子 Cordis context（context 边界），**不是 OS 边界**。
- 绕过 `tools/pre-execute` 的代码、或无视决策的工具实现，**不会被本模块约束**；真正的隔离需要宿主权限层或进程外沙箱。
- 本报告、模块头注释与测试注释三处使用同一措辞；**没有任何一处把同进程执行称作沙箱**。

## 2. 实现清单

| 文件 | 改动 |
| --- | --- |
| `src/cordis-seams/tool-face.ts`（新） | `createToolFaceRegistry`：`install`（显式 allowlist、`denyTools`、TTL、LRU 上限、替换计数）、`remove`、`policyFor`（读路径惰性过期）、`policies`、`decide`（`allowlisted` / `not-allowlisted` / `explicitly-denied` / `no-policy` / `out-of-scope` / `registry-disposed`）、`sweepExpired`、`stats`（计数闭合）。模块头写明 "NOT a sandbox"。 |
| `src/cordis-seams/dsh-hook-host-adapter.ts` | 选项 `toolFace` + `attachToolFace()` + `get toolFace`；`tools/pre-execute` 在 mount deny 之后、advisor gate 之前执行 allowlist 决策：`deny` → `{kind:'deny', reason}` 并计 `stats().toolFace.{decisions,denials}`；host 派发（无 branchId）永不因探针策略被拒；`resolveMountScope` 默认改 `branch`；`hookScopeMatches` 未声明 class 视为 `branch`；模块头新增 tool-face 边界段。 |
| `src/cordis-seams/host-adapter.ts` | `HostMountScopeClass` 文档更新：`legacy-host-local` 降级为**显式 opt-in**，未声明 = `branch`。 |
| `src/cordis-seams/seam-manager.ts` | 选项 `toolFace` + `toolAllowlist`（非数组构造期拒绝）、per-branch 安装/清理、清理失败诊断。 |
| `src/cordis-seams/index.ts` | barrel 导出 `tool-face`。 |
| `scripts/host-smoke/contract.mjs`（新） | fake-path 包装器：运行 `tests/e2e/host-smoke/contract-smoke.test.ts`（`--reporter=json`），打印 `files/tests/passed/failed` 与真实 smoke not-run 五场景；exit 0/1。 |
| `tests/e2e/host-smoke/contract-smoke.test.ts`（新） | 9 测试：五项场景 + allowlist 正负例/通配符拒绝/no-policy 可见/策略移除后重检。 |
| `tests/unit/cordis-seams/dsh-hook-host-adapter.test.ts` | 队长移交的 5 个"无身份派发可见 mount"用例改为**显式 host scope + grant**；"documented fail-open" 用例改写为"未声明 = branch class（fail-closed）"并断言显式 legacy opt-in 的计数与诊断；session-only 观测计数改为 fail-closed 口径。 |
| `tests/unit/seams/mount-scope-isolation.test.ts` | 同步收紧后的默认：未声明 = branch（fail-closed）+ 显式 legacy opt-in 计数。 |

## 3. 四条硬要求逐条对照（要求 → 做了什么 → 证据）

### 3.1 要求 1：allowlist 必须证明"不在列表里的工具真的调不到"（负例 + 结构化计数）

| 要求 | 做了什么 | 证据（测试名 / 命令 / 字段） |
| --- | --- | --- |
| 列表外工具必须被拒（负例） | `decide()` 在策略存在且工具不在 `allowTools` 时返回 `{allowed:false, code:'not-allowlisted', branchId, policyId, reason}`；adapter 在 `tools/pre-execute` 把它转成 `{kind:'deny', reason}`，被拒调用不会到达执行体 | `contract-smoke.test.ts`：`denies an unlisted tool with a structured decision and counter`；场景 1 断言 `ownUnlisted` / `siblingUnlisted` 均为 `{kind:'deny'}` 且 reason 含工具名 |
| 拒绝必须可计数（不能静默） | 两级计数：分支级 `toolFace.stats()` 与适配器级 `adapter.stats().toolFace` | `toolFace.stats().deniedNotAllowlisted === 2`、`allowed === 1`（场景 1）；`adapter.stats().toolFace.denials === 2`（场景 1）；负例单测 `deniedNotAllowlisted === 1` |
| 显式 deny 优先于 allowlist | `denyTools` 命中 → `code:'explicitly-denied'` + 自带 reason | `deniedExplicit === 1` + reason 逐字断言 |
| "没有策略"不能被读成"校验通过" | 分支无策略 → `{allowed:true, code:'no-policy'}` + `noPolicy` 计数；策略移除后立刻按 no-policy 重新判定（无缓存） | `a branch without a policy is reported as noPolicy`；`the adapter re-checks the allowlist on every call after a policy is removed`（移除前 deny / 移除后 allow，`noPolicy === 1`） |
| allowlist 不得退化为黑名单 | `allowTools:['*']`、空 branchId、空白工具名在 `install` 期抛错，`policies()` 仍为空 | `refuses a wildcard allowlist and an empty branch id` |
| 计数闭合 | `checks === allowed + deniedNotAllowlisted + deniedExplicit + outOfScope + noPolicy + registryDisposed` | 负例测试内逐项求和断言 |

**两个计数的关系（不是同一数据的两层视图，是两个不同层次）**：

- `toolFace.stats().deniedNotAllowlisted` 是**分支级**计数：`ToolFaceRegistry` 内部 `decide()` 的决策结果，区分 `deniedNotAllowlisted` / `deniedExplicit` / `noPolicy` / `outOfScope`。
- `adapter.stats().toolFace.denials` 是**适配器级聚合**：hook adapter 把 `decide()` 的拒绝落到 `tools/pre-execute` 并返回 `deny` 的次数；`decisions` 统计所有进入决策的调用（含放行）。
- 关系：正常路径下 `adapter.toolFace.denials === toolFace.deniedNotAllowlisted + toolFace.deniedExplicit + toolFace.registryDisposed`（`outOfScope`/`noPolicy` 是放行，不进 `denials`）。本 smoke 的两个数字（2 与 2）正是这条等式的一个实例；分开写是为了让"拒绝来自 allowlist 还是来自授权账本/挂载守卫"可见。

### 3.2 要求 2：fake-host smoke 五项逐字对应（sibling / 并发复用 / 过期租约 / 清理 / mount 不泄漏）

| 清单原文 | 做了什么 | 证据（测试名 / 字段） |
| --- | --- | --- |
| sibling（兄弟探针） | 两个兄弟分支共享同一 session 并发存活；各自 mount prompt + 各自策略；在 B 的执行体内对双方派发 | `1. sibling probes: separate tool faces and mounts, host untouched`：宿主 assemble 为空、各自 branchId 只见自己的 prompt、`policyIdsDiffer === true`、`liveScopes === 2`、`livePolicies === 2` |
| 并发/复用 | 同 session 并发两分支；结束后用同一 branchId 复用；活体内 refine 策略 | `2. concurrent/reused session: per-branch policies, replacement counted, no residue`：policyId 集合大小 2、复用得到全新策略、`replacements === 1`、结束后 `policies()===[]` 且 `registry.size()===0` |
| 过期租约 | 分支 lease `ttlMs:30` + 策略 `ttlMs:20`，越过 TTL 后观察 | `3. expired leases: ...`：`isActive===false`、`policyFor===undefined`、`expiredPolicies===1`、`leases.expired===1`；scope 保留自身寿命（租约 TTL 只约束租约），越过 scope TTL 后 prune 归零 |
| 清理 | 成功 / 抛错 / 超时 三条结束路径 | `4. cleanup: success, throw and timeout all leave nothing behind`：三路径后 `listActiveBranches()===[]`、`activeMounts()===[]`、`policies()===[]`、`registry.size()===0`、`activeHostScopes()===[]`、`leases()===[]` |
| mount 不泄漏 | 探针挂载期间，宿主 assemble 与工具调用（无身份 / 仅 session） | `5. mount non-leakage: ...`：宿主 assemble 为空、宿主工具调用均 `allow`、探针 `forbidden action: tool:shell` 不拒绝宿主（`deniedToolCalls===0`）、`deniedRulesSuppressed===1`（被抑制的计数）、`toolFace.outOfScope===2` |

运行方式（两种，均不启动真实宿主）：`pnpm exec vitest run tests/e2e/host-smoke/contract-smoke.test.ts`；`node scripts/host-smoke/contract.mjs [--json]`。

### 3.3 要求 3：真实 smoke 写成可批准形态 —— 见 §5（逐场景授权申请文本 + fake-host 替代验证结论）

### 3.4 要求 4：legacy 默认二选一 —— **选"收紧"**，细节见 §6

## 4. 验证证据（命令 / 退出码 / 关键输出）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `pnpm exec tsc --noEmit` | 0 | 无输出（全仓干净） |
| `pnpm exec vitest run tests/e2e/host-smoke/contract-smoke.test.ts` | 0 | `Test Files 1 passed (1)`，`Tests 9 passed (9)` |
| `pnpm exec vitest run tests/unit/cordis-seams tests/e2e/host-smoke` | 0 | `Test Files 8 passed (8)`，`Tests 124 passed (124)` |
| `node scripts/host-smoke/contract.mjs` | 0 | `files=3 tests=9 passed=9 failed=0`；`real-host smoke: not-run (requires authorization) - 5 scenarios`；`PASS (fake path only)` |
| `node scripts/host-smoke/contract.mjs --json` | 0 | `{"gate":"p4c-contract-smoke-v1", "fake":{tests:9,passed:9,failed:0}, "real":[{"status":"not-run", ...5 scenarios}], "passed":true}` |
| `pnpm exec vitest run`（全量） | 0 | `Test Files 129 passed (129)`，`Tests 2382 passed (2382)` |
| `pnpm run check:encoding` | 0 | `SUCCESS: every tracked blob is LF text or an explicit -text exception` |
| `pnpm run check:build-smoke` | 0 | `SUCCESS: the bundle builds and imports as ESM` |
| `pnpm run check:negative-result` | 0 | `A1..A6 PASS - the historical negative result is intact` |
| `pnpm run guarded-regression` | 0 | boundaries 三条（no real model call, no paid API, no memory write） |
| `pnpm run check:mutation` | 0 | `[M1] KILLED red=4/4`、M2 5/3、M3 3/2、M4 2/2、`worktree zero-residue: OK`、`verdict: PASS` |
| `pnpm run check:docs` | 1（已知红，与代码无关；队长收尾重铸） | 仅 README 计数漂移：README `103 files/2094 tests` vs 实测 `129/2382`；`Config reference 78/78` ✓、`zero failed/pending` ✓ |


## 5. 真实宿主 smoke：**未执行（需授权）**，五场景 + 授权申请文本 + fake-host 替代验证

**当前状态**：真实宿主 smoke **未执行**。`scripts/host-smoke/run.mjs`（P6.1-F 真实宿主 runner）与 `in-host.mjs` 本轮**未运行**；所有结论均来自 fake-host 契约路径（§3.2）。未获得授权前不会运行真实宿主、真实外部工具或记忆写入。

### 5.1 五场景清单（逐场景授权申请文本 + fake-host 替代验证结论）

| # | 场景 | 授权申请文本（逐场景） | fake-host 下的替代验证结论 |
| --- | --- | --- | --- |
| 1 | **sibling**：真实安装宿主上两个共享同一 session 的兄弟探针 | "申请在受控测试会话（仅测试 namespace/测试会话）启动两个真实 DSH 探针分支，各自 mount 一个 prompt 段与一份工具 allowlist，采集宿主的 `system-prompt/assemble` 与 `tools/pre-execute` 快照，验证任一方都不影响宿主与兄弟分支。不触碰业务数据，不产生付费调用。" | **通过**：场景 1 证明宿主 assemble 为空、兄弟互不可见、两策略 id 不同、`liveScopes/livePolicies=2`。**真实宿主下的 host-real 派发形状未覆盖**（见 5.3）。 |
| 2 | **并发/复用**：真实宿主上并发两分支 + 结束后复用同一 branchId | "申请在同一受控测试会话内并发运行两个真实探针分支，结束后以同一 branchId 复用一次，采集策略替换计数、策略/挂载残留与宿主行为快照。" | **通过**：场景 2 证明并发策略隔离、复用得新策略、`replacements===1`、结束后零残留。**真实宿主的事件循环竞态（并发清理时机）未覆盖**。 |
| 3 | **过期租约**：真实宿主上短 TTL 分支租约/策略过期 | "申请在受控测试会话内以缩短 TTL（<60s）运行真实探针分支，等待租约与工具面策略过期后采集过期计数、策略查询结果与宿主是否仍受影响。" | **通过**：场景 3 证明观察点惰性过期、`expiredPolicies===1`、`leases.expired===1`、过期后不可复活。**真实宿主时钟/GC 时序差异未覆盖**。 |
| 4 | **清理**：真实宿主上成功/抛错/超时三种结束 | "申请在受控测试会话内分别以成功、执行体抛错、超时三种方式结束真实探针，采集 mount/策略/scope/监听器残留与进程存活情况。" | **通过**：场景 4 三路径均零残留（`listActiveBranches`、`activeMounts`、`policies`、`registry.size`、`activeHostScopes`、`leases`）。**真实宿主进程/监听器残留未覆盖**（需要宿主级观测）。 |
| 5 | **mount 不泄漏**：真实宿主的无身份/仅 sessionId 派发 | "申请在真实探针挂载期间向宿主派发无身份与仅 sessionId 的工具调用与 pre-step（即真实 `agent/pre-step` 形状），采集宿主 assemble 与工具决策，验证探针内容与探针 deny 均不进入宿主。" | **通过**：场景 5 证明宿主 assemble 为空、宿主工具调用均 allow、探针 guardrails 不越权 deny。**真实宿主 host-real 身份字段未采集**（依赖 P6.1-F 的 identity capture 路径，本轮未运行）。 |

### 5.2 与现有 P6.1-F 真实 harness 的关系（获批后如何执行）

- 现有 `scripts/host-smoke/run.mjs` 已具备：安装宿主定位、硬 deadline、hang 检查、host-real 身份采集（`probe.ts` 的 `identityCarrier` 路径）、sibling 命名（两 session × 两 sibling）、mount 生命周期与 degradation 矩阵。获批后**复用它**，不新写 runner。
- P4-C 真机增量（尚未进入任何真机路径，故列为**未覆盖**）：①兄弟分支共享 session 时的 assemble 快照；②工具面策略在真实执行期的 allow/deny 回执；③<60s TTL 的受控过期窗口。这三处需要先扩展 `tests/e2e/host-smoke/probe.ts`（真机探针），属于获批后的实施项，不在本轮。
- 获批后的执行命令（原样保留，不伪造结果）：`node scripts/host-smoke/run.mjs --check`（只做 harness 就绪检查），通过后再 `node scripts/host-smoke/run.mjs`；结果写入 `docs/reports/p61-host-smoke-rc.md`（现有契约），并在本报告追加"获批后实测"一节。

### 5.3 未覆盖项汇总（显式登记，不留空）

| 项 | 状态 |
| --- | --- |
| 真实宿主 sibling / 并发复用 / 过期租约 / 清理 / mount 不泄漏五场景 | **未执行（需授权）** |
| host-real 身份字段采集与真实 `agent/pre-step` 派发形状 | **未覆盖**（依赖 5.2 的 harness 运行） |
| 真实宿主下的并发清理竞态与进程/监听器残留 | **未覆盖** |
| 工具面策略在真实执行期的 allow/deny 回执 | **未覆盖**（fake-host 已覆盖） |
| 真实付费模型调用 | **未执行（需授权）**，本任务零调用 |

## 6. 兼容性：legacy 默认收紧（改前 → 改后 → 受影响）

### 6.1 决定：**收紧**（二选一中的前者）

| 维度 | 改前（t7 契约） | 改后（P4-C） |
| --- | --- | --- |
| 直接调用 `adapter.registerPromptSegment/registerGuardrails/mountMiddleware` 且未声明 `mountScope` | `legacy-host-local`：无身份派发可见、仅 sessionId 派发按 session 命中 | **`branch` class（fail-closed）**：只有证明了该 branchId 的派发才可见；无身份/仅 session 一律不作用 |
| `legacy-host-local` 可达性 | 默认路径 | **仅显式 opt-in**：`mountScope: 'legacy-host-local'`，每次注册 `stats().scope.legacyHostLocalMounts += 1` + 一条有界诊断 |
| `hookScopeMatches` 对未声明 class 的对象 | legacy 规则 | `branch` 规则（默认收紧，导出函数同步） |
| 未声明 class 且无 branchId | 允许（legacy 可命中） | `CordisSeamError('mount_scope_not_authorized')`：不可归属的 mount 直接拒绝 |
| 生产 mount 路径（`mountEightSurfaces`） | 始终显式声明 branch/host | **不变**（始终显式声明） |

### 6.2 谁受影响

- **受影响**：任何**直接**调用 adapter 三个注册方法且未声明 `mountScope` 的集成方 —— 行为变严：不再对无身份/仅 session 派发生效；需要宿主可见性时必须显式 `mountScope:'host' + hostScopeGrant`（具名授权），需要旧行为时显式 `legacy-host-local`（计数）。
- **不受影响**：探针（`runInIsolatedBranch` 传 `branch`）与永久 patch（`applyPermanentPatch` 传 `host` + grant）——生产路径本轮零变化。
- **测试面**：`tests/unit/cordis-seams/dsh-hook-host-adapter.test.ts` 的 5 个"无身份派发可见 mount"用例改为显式 host scope + grant（意图不变：验证 prompt 合并/替换/幂等）；原 "documented fail-open" 用例改写为 "未声明 = branch（fail-closed）+ 显式 legacy opt-in 计数"；1 个 session-only 观测计数用例改为 fail-closed 口径（`preStep.applied` 1→0、`delegated` 1→2）。`tests/unit/seams/mount-scope-isolation.test.ts` 同步（t7 产物）。
- **ADR**：ADR 0006 §6.3.1 追加 "P4-C 收紧" 记录（债由"默认放行"降为"显式 opt-in"；四要素保留：存在/触发/5 个用例名单/预期行为），纯文档。

## 7. 遗留风险与集成轮事项

### 7.1 集成轮事项（与 t6 两阶段接线、P6 R7 并列；机制就绪、生产路径未接）

| # | 事项 | 机制状态 | 未接的生产路径 |
| --- | --- | --- | --- |
| 1 | t6 两阶段结算 / 迟到 usage / WAL 恢复 | 已就绪 + 确定性测试 | executor 生产调用点（`src/dsh-bridge/agent-loop-executor.ts` 及装配） |
| 2 | P6 R7（预算/提醒钩子） | 已就绪 + 契约测试 | `src/index.ts` / 预算提醒开关接线 |
| 3 | P4-B 遗留：无 live lease 但**确实单占用**的合法场景 | 当前 **fail-closed 拒绝**（`proofOf` 要求恰 1 live scope + 1 live branch lease） | 宿主侧"占用者 lease"接线（否则该场景会被拒；安全但可能过严） |
| 4 | P4-A 授权账本 `createProbeAuthorizationLedger` | 已就绪 + 契约测试 | `src/index.ts`/`src/orchestrator.ts`/`src/dsh-bridge/**` 的逐调用点 `authorize()` |
| 5 | 本任务工具面 allowlist | 已就绪 + fake-host 契约 smoke | 生产开关/配置接线（哪个任务给哪个分支下发 allowlist） |

### 7.2 风险

1. **执行路径依赖**：allowlist 只在 `tools/pre-execute` 生效；不经该 hook 的工具调用不在约束内（同进程协作式边界的固有边界，已写进模块头）。
2. **`no-policy` 是放行**：未安装策略的分支不拦截（按设计），但计数可见；若要求"无策略即拒绝"，需要一次显式裁定（会改变现有探针默认行为）。
3. **真实宿主未验证**：§5.3 的未覆盖项在获批真机 smoke 前不能声称"真实宿主上不泄漏"。
4. **策略生命周期**：策略由 seam manager 在分支结束时移除；若未来出现"分支结束后仍需策略"的场景（如复用 branchId 的后台任务），需要显式续期。
