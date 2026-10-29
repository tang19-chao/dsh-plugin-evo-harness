# P4-A 交付报告：宿主身份/信任 ADR 与紧急 mount 隔离

| 项 | 值 |
| --- | --- |
| 任务 | t7 / P4-A（团队 `p2-p6-execution`，成员 p4-isolation） |
| 日期 | 2026-10-29 |
| ADR | `docs/adr/0006-host-identity-trust-and-mount-isolation.md`（新建，accepted） |
| 写入范围 | 本报告 §3 列出的 12 个文件，全部在任务写入范围内 |
| 结论 | **完成**：身份/信任/授权模型先定后修；兄弟探针共享 session 时 mount 不进入宿主 assemble/pre-execute（测试钉死）；缺失身份 fail-closed 且有结构化计数；负控制 3 条实测真红 |

## 1. 目标与做法

任务目标：**先定身份与信任模型，再修隔离**；兄弟探针不得把 mount 泄漏进宿主 assemble/pre-execute。

事实依据（不是猜测，来自仓库自身的真机形状探针 `tests/e2e/host-smoke/probe.ts`）：

1. 真实宿主的 `agent/pre-step` 派发 payload **完全不带身份**（`{messages, turn, step, signal}`，身份在 `this` carrier 上）；
2. 真实宿主的 `tools/pre-execute` 带的是**宿主的 agent carrier**（`agent.id` = 宿主会话），无 `branchId` —— 探针、子探针、宿主工具调用**共享同一个 sessionId**；
3. 改动前的 `hookScopeMatches` 在"无身份"（`total === 0` → `return true`，模块头文档写明的 fail-open）与"只有 sessionId"（`sessionIds.has(mount.sessionId)`）两种情况下都会命中探针 mount → 兄弟探针的 prompt 段进入宿主 `system-prompt/assemble`、兄弟探针的 guardrails deny 作用到宿主 `tools/pre-execute`（**越权 deny**）。

因此本任务先写 ADR（identity / trust / authorization 三类概念分开 + sessionId 不得暗中承担 branch identity），再按 ADR 修代码。

## 2. 决策摘要（详见 ADR 0006 §2–§5）

| 决策 | 内容 |
| --- | --- |
| D-P4-1 身份分类 | host identity / branch identity / claim（自称）三类；**只有 branch identity 能授权 branch-scoped 行为**；`sessionId` 永不顶替 `branchId`：`ScopeRegistry.resolve` 对 session-only payload 一律 `'unknown'` 并计数；`RegisteredHostScope.authorizesBranch` 在类型上就是字面量 `false` |
| D-P4-2 身份词汇唯一化 | `classifyScopeIdentity` 返回五种互斥且穷尽的状态（`branch-and-session`/`branch-only`/`session-only`/`ambiguous`/`unattributed`），`hasBranchProof` 是 branch-class mount 的唯一准入条件 |
| D-P4-3 宿主显式登记 | `registerHostScope({sessionId, grantedBy})`：grant 必填、TTL、可 dispose、可计数；branch-attributed 派发**不算 host** |
| D-P4-4 mount scope class | `'branch' / 'host' / 'legacy-host-local'`；branch-class mount 只命中**证明了其 branchId** 的派发（session 不参与匹配）；host-class 只有永久 patch（必须带 `hostScopeGrant`）；生产路径全部显式声明 class |
| D-P4-5 显式授权 | `createProbeAuthorizationLedger`：五类动作（`external-tool-call`/`memory-write`/`multi-step-probe`/`real-host-smoke`/`paid-model-call`）默认拒绝；session-only grant 不能授权 branch 请求（`session-cannot-authorize-branch`）；`runtimeEnabled: true` 不授权任何东西（与 JIT 开关正交，ADR 0001 D4 权限分层） |
| 计数契约 | 三层结构化计数（`DshHookAdapterStats.scope` / `ScopeRegistryCounters` / `ProbeAuthorizationCounters`），缺身份 fail-closed 处全部有可读数字，且各有闭合不变式 |

## 3. 逐文件改动（全部在写入范围内）

| 文件 | 改动 |
| --- | --- |
| `docs/adr/0006-host-identity-trust-and-mount-isolation.md` | **新建**：身份/信任/授权模型、mount class 规则表、兼容性影响、明确不做、术语表 |
| `src/jitrl/scope-registry.ts` | 新增 `classifyScopeIdentity`（五状态词汇）、`registerHostScope`/`resolveHostScope`/`activeHostScopes`、`ScopeRegistryCounters`（`stats()`，深冻结快照）；`resolve` 全分支计数（`sessionOnlyRejected`/`ambiguousRejected`/`unattributedRejected`/`unregisteredRejected`/`expiredRejected`，闭合 `total === proven + unknown`）；branch-only 多 compound 判 ambiguous；既有 API/语义零变更（纯增量） |
| `src/jitrl/runtime-control.ts` | 新增 `createProbeAuthorizationLedger`（grant/revoke/authorize/stats/dispose，结构化 `deniedByCode`，闭合 `checks === allowed + denied`，TTL/`grant-expired` 与 `no-grant` 分开、singleUse、诊断串无身份/授权人文本）；既有 `createJitRuntimeControl` 零变更 |
| `src/cordis-seams/host-adapter.ts` | `HostSurfaceSpecBase` 增加可选 `mountScope`/`hostScopeGrant`（纯增量，缺省 = legacy） |
| `src/cordis-seams/eight-surfaces.ts` | `SurfaceMountContext` 增加 `mountScope`/`hostScopeGrant` 并经 `mountScopeFields(context)` 透传到全部 8 个 spec；**刻意不放进共享 `base` 对象**（ADR 0005 D5 变异体 M1 锚定 `base` 精确文本，门禁必须继续解析该锚点） |
| `src/cordis-seams/seam-manager.ts` | `runInIsolatedBranch` 传 `mountScope: 'branch'`；`applyPermanentPatch` 传 `mountScope: 'host', hostScopeGrant: 'permanent-patch:<id>'`（该调用点已被执行档 patch 权限把守，grant 是具名授权） |
| `src/cordis-seams/dsh-hook-host-adapter.ts` | **核心修复**：`hookScopeMatches` 按 class 三分支（branch=只认 branchId 证明 / host=显式授权的 host-wide / legacy=旧规则）；`evaluateMountAuthority` 成为**唯一**判定点并写全部计数（`branchProofApplied`/`sessionOnlySuppressed`/`anonymousSuppressed`/`deniedRulesSuppressed`）；`resolveMountScope` 校验（host 无 grant → `mount_scope_not_authorized`，branch 无 branchId → 同码）；guardrail deny 只采纳已证明 mount；`system-prompt/assemble` 的"无 sections"诊断与作用域无关（一次性有界 note，不因此注入）；host-class mount 注册时把 grant 记入 trust registry；`stats()` 增加 `scope` 节；模块头注释改写（fail-open 段删除） |
| `src/cordis-seams/errors.ts` | `CORDIS_SEAM_ERROR_CODES` 增加 `mount_scope_not_authorized`（1 行） |
| `tests/unit/seams/mount-scope-isolation.test.ts` | **新建** 5 测试：兄弟探针共享 session 的宿主派发隔离（含计数断言与"诊断不携带身份"断言）、guardrail 越权 deny 抑制、host-class grant 校验、生产路径 0 legacy、legacy 兼容面计数 |
| `tests/unit/jitrl/scope-registry-identity.test.ts` | **新建** 12 测试：五状态词汇、session-only 拒绝（即使 host scope 已登记）、compound 权威、计数闭合、host scope grant/TTL/dispose/冻结 |
| `tests/unit/jitrl/probe-authorization.test.ts` | **新建** 12 测试：五类动作默认拒绝、缺身份 fail-closed、runtimeEnabled≠授权、grant 校验、session-only grant 不能授权 branch、`grant-expired`≠`no-grant`、singleUse/revoke/dispose、诊断无载荷、计数闭合 |

## 4. 验收映射（任务验收 3 条）

| 验收 | 状态 | 证据 |
| --- | --- | --- |
| 兄弟探针共享 session 时 mount 不进入宿主 assemble/pre-execute | **通过** | `tests/unit/seams/mount-scope-isolation.test.ts`：两个兄弟探针（`br-sibling-a`/`br-sibling-b`，同一 `sess-shared-p4a`）经**生产路径**（`runInIsolatedBranch`）挂载后，宿主派发 `{agent:{id: SHARED_SESSION}}` 与 `{}`（真实 `agent/pre-step` 形状）的 assemble sections 均为 `[]`；各自 branchId 派发只见自己的 mount；`stats().scope.assemble.sessionOnlySuppressed === 2`、`anonymousSuppressed === 2`、`branchProofApplied === 2`、`assemble.applied === 2`/`delegated === 2`。pre-execute 侧：探针 guardrails 对宿主 `shell` 调用（session-only 与无身份）均 `allow`，`deniedToolCalls === 1`（仅分支内），`deniedRulesSuppressed === 2` |
| 缺失身份时 fail-closed 且有结构化计数 | **通过** | registry：`resolve({sessionId})` → `'unknown'` + `resolves.sessionOnlyRejected`（即使 `registerHostScope` 已登记该 session）；`resolve({})` → `unattributedRejected`；闭合 `total === proven + unknown`。ledger：`authorize` 无身份 → `identity-required`，无 grant → `no-grant`，闭合 `checks === allowed + denied`。hook adapter：`stats().scope.{sessionOnlySuppressed, anonymousSuppressed, deniedRulesSuppressed, legacyHostLocalMounts}` 全部为真实事件点计数 |
| ADR 与实现一致，兼容性影响记录在案 | **通过** | ADR §7 逐决策→实现位置→钉死测试的一致性表；§6 兼容性影响三段（行为收紧/不受影响/兼容债）；§6.3 登记了 `legacy-host-local` 兼容面（每次注册计数 + 诊断、生产不可达、P4-C 去留），§8 登记未执行项 |

## 5. 验证证据（可复算）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `pnpm exec tsc --noEmit` | 0 | 无输出（全仓干净；含队友并行新增文件） |
| `pnpm exec vitest run`（全量，独立运行） | 0 | `Test Files 127 passed (127)`，`Tests 2354 passed (2354)` |
| `pnpm exec vitest run tests/unit/jitrl tests/unit/cordis-seams tests/unit/seams tests/e2e/provenance-chain.test.ts tests/e2e/host-smoke tests/e2e/jit-control.test.ts tests/e2e/lifecycle.test.ts tests/e2e/plugin-entry.test.ts` | 0 | `Test Files 45 passed (45)`，`Tests 944 passed (944)` |
| `pnpm exec vitest run tests/unit/eval/mutation-gate.test.ts tests/unit/p62/evidence-gates.test.ts` | 0 | `Test Files 2 passed (2)`，`Tests 74 passed (74)`（变异门锚点在 eight-surfaces 改动后仍唯一解析） |
| `pnpm run check:encoding` | 0 | `tracked blobs inspected: 333`，`SUCCESS: every tracked blob is LF text or an explicit -text exception` |
| `pnpm run check:build-smoke` | 0 | `export-surface: 70 named exports`，`SUCCESS: the bundle builds and imports as ESM` |
| `pnpm run check:negative-result` | 0 | `A1..A6 PASS - the historical negative result is intact` |
| `pnpm run guarded-regression` | 0 | JSON `boundaries: no real model call, no paid API, no publish, no real memory write` |
| `pnpm run check:mutation` | 0 | `[M1] KILLED ... red=4/4 must-red hit`（M2 5/3、M3 3/2、M4 2/2）；`worktree zero-residue: OK`；`verdict: PASS` |
| `pnpm run check:docs` | **1（已知红，与本任务代码无关）** | 仅 README 计数漂移：README `103 files/2094 tests` vs 实测 `127 files/2354 tests`（unit 114/2195、e2e 13/159）；`Config reference coverage: 78 documented row(s) vs 78 expected` ✓；`✓ Counts close` ✓；`✓ Report carries zero failed and zero pending tests` ✓。**该漂移在本任务改动前已存在**（基线实测：README 103/2094 vs 118/2273），由 P2/P3/P6 并行批新增测试累计造成；README 不在本任务写入范围（ADR 0005 §6.3 规定 docs 单写者串行），需由集成任务从一次绿色 run 重铸计数 |

## 6. 负控制（变异式验证：修复回退必须红）

三条负控制均"临时打补丁 → 跑测试 → 立即按字节恢复"（恢复后 sha256 复核 + 全量受影响套件重跑绿）：

| 负控制 | 注入的回退 | 结果（预期红） | 恢复验证 |
| --- | --- | --- | --- |
| NC1 | `hookScopeMatches` branch 分支退回旧 fail-open（无身份/共享 session 命中） | `tests/unit/seams/mount-scope-isolation.test.ts`：`3 failed / 2 passed (5)`，exit 1（两个验收测试 + grant 校验测试红） | 恢复后 sha256 与改动版一致；42 files/902 tests 绿 |
| NC2 | 授权账本删除 `session-cannot-authorize-branch` 守卫 | `tests/unit/jitrl/probe-authorization.test.ts`：`refuses to let a session-only grant authorize a branch action` 红，exit 1 | 恢复后 sha256 一致；套件绿 |
| NC3 | `ScopeRegistry.resolveHostScope` 允许 host scope 覆盖 branch-attributed 派发 | `tests/unit/jitrl/scope-registry-identity.test.ts`：`resolves a host dispatch to the recorded scope and never to a branch` 红，exit 1 | 逐字回退后 tsc 0 + 套件绿 |

## 7. 兼容性影响（详见 ADR §6）

1. **生产路径收紧**：探针 prompt mount 不再进入宿主 assemble；探针 guardrails 不再 deny 宿主工具调用；探针分支内的注入/拒绝仍按 branchId 生效；`options.denyTools`（集成方策略）语义不变；永久 patch 语义不变（本就该影响宿主），但现在是**具名授权**（`hostScopeGrant`）且记入 trust registry。
2. **不受影响**：advisor/学习通道仍按 ADR 0001 D1 严格默认（本 ADR 未放宽）；观测计数 `applied|delegated` 口径不变（相关≠授权），既有 E2E/单测数字全部不变（45 files/944 tests 实测）。
3. **兼容债（登记保留）**：直接调用 adapter 注册且未声明 `mountScope` 的调用方得到 `legacy-host-local`（与改动前匹配完全一致），每次注册计数 + 有界诊断；生产代码不可达（仓库内仅 `mountEightSurfaces` 调用这三个 seam，契约测试断言 0 legacy）；P4-C 在真实宿主 smoke 通过后把默认改 `branch`，届时需同步更新 `tests/unit/cordis-seams/dsh-hook-host-adapter.test.ts` 中 5 个"无身份派发可见 mount"用例（ADR §6.3 已列出名单）——该文件不在本任务写入范围，**未改**。

## 8. 未执行（需授权或写入范围外）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 真实宿主 smoke / 真实外部工具调用 / 记忆写入 / 多步探针 | **未执行（需授权）** | 授权申请文本："申请在获批准后于受控环境执行 P4-C 真实宿主 smoke：覆盖 sibling、并发/复用 session、过期租约、清理与 mount 不泄漏五类场景；仅测试 namespace/测试会话，不触碰业务数据，结果与授权边界、计数、回滚证据一并交付。" 替代验证（本任务已完成）：fake-host 契约测试（`tests/unit/seams/mount-scope-isolation.test.ts` 走生产 mount 路径 + 宿主 waterfall 形状）+ `tests/e2e/host-smoke` 契约矩阵全绿 |
| 付费模型调用 | **未执行（需授权）** | 本任务零模型调用 |
| 授权账本接入生产调用点（`src/index.ts`/`src/orchestrator.ts`/`src/dsh-bridge/**`） | **未执行（写入范围外）** | 属 P4-C；ADR §4.4/§8 给出契约，接线时每个调用点必须显式 `authorize()`，不得复用 `runtimeEnabled`/`guarded-active` |
| session-only 派发的 advice 通道（ADR 0001 §2.5 兼容路径） | **未执行** | registry 侧已落地（`registerHostScope`/`resolveHostScope` + 计数）；打开 advice 需 P4-C 工具面/真实宿主校准，先保持 D1 严格默认 |
| 租约（WeakMap/TTL/重复注册不降级）与工具面 allowlist | **未执行** | 属 P4-B / P4-C |
| README 计数重铸 | **未执行（写入范围外）** | 见 §5 `check:docs` 行；需集成任务单写者处理 |

## 9. 遗留风险

1. **legacy-host-local 兼容面**：在 P4-C 收紧默认之前，直接调用 adapter 注册的 mount 仍保留旧匹配（已计数、已诊断、生产不可达）；风险是外部集成方误用 —— 已在 ADR §6.3 与模块注释中声明弃用方向。
2. **宿主真实身份字段尚未校准**：真机上宿主是否会在 `tools/pre-execute` 携带 branchId、以及 `agent/pre-step` 是否永远无身份，目前只有 contract-shaped 探针结论；P4-C 的真实 smoke 必须复核（本 ADR 的规则对两种结论都 fail-closed，不依赖该假设）。
3. **并行共享工作树**：本轮全量 vitest 曾出现 1 例队友 P6 任务的 pinned-SHA 测试瞬时红（`tests/unit/jitrl/p6-pareto-budget.test.ts` 钉的是 ADR 0007 与 `src/jitrl/jit-active-policy.ts`，非本任务文件；其文件落定后全量重跑绿）；`tests/unit/p62/evidence-gates.test.ts` 在多进程并行重载下曾因 5s vitest 超时瞬时红，单独重跑绿（74/74）。两者均与本任务改动无关，复算时建议单独跑这两类 spawn 子进程的套件。
4. **`check:docs` 已知红**：README 计数漂移（P2/P3/P6 并行批累计），须在集成任务中从一次绿色 run 重铸；在重铸前该门禁会持续红，且按其自身设计"带失败/pending 的 run 不能铸绿计数"，不能用手改数字消除。
