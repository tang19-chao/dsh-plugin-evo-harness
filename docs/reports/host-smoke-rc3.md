
> **rev6 / rc3 方法差异（必须与 rc2 区分）**
> 
> rc2 的八表面分类来自 smoke **自建**的适配器 + 一个**裸** Cordis Context；该上下文不含 `ctx.systemPrompt`/`ctx.tools`，
> 因此生产 `resolveHostAdapter` 会落到 in-memory 参考实现，与分类所用适配器**不一致**，rc2 只能用 `resolveNote` 散文免责。
> 
> rc3 在真正挂载了宿主服务的上下文上调用插件**自己的 `apply()`**，并断言「生产解析 == 分类所用适配器」（见附录 A.4）。
> 这是**事实**而非免责声明；也是本报告唯一有权声称「证据来自真实 apply 上下文」的理由。
> 
> 分支身份：附录 A.5 的 dispatch 是**探针自建**的 identity-free payload，只能证明读取器 fail-closed，**不能**证明宿主提供什么身份；宿主实际提供什么见 `identity evidence:` 段的 `host-real` 条目——本轮 4 个场景实测 **branchId=0、身份仅限 session**，属**有界观测**，不构成「宿主永不提供 branchId」的普遍断言。故 R2-2 记为 **blocked**（附录 A.5），Gate 4 不予主张。
# P6.1-F 真实宿主受控 smoke 与 shadow RC 报告

| 项 | 值 |
| :-- | :-- |
| 报告 schema | `1` |
| 固定 commit | `97e38db37305b24f695a5f989428b3611f84987c`（工作树有未提交改动，结论仅对这些字节成立） |
| 插件版本 | `0.1.0` |
| 采集时间 | 2026-10-30T21:09:18.945Z |
| 宿主 | DeepSeek Harness 0.2.1-rc.5 (product version from the asar package.json) |
| 宿主 | cordis 4.0.5 |
| 宿主 | node 24.21.0 |
| 宿主 | electron 44.7.0 |
| 宿主 | runtime win32/x64 |

## 固定命令列

```text
$ node scripts/host-smoke/run.mjs --out docs/reports/host-smoke-rc3.md   # cwd=C:\Users\Administrator\Documents\Codex\2026-10-19\https-github-com-google-research-harness2
$ pnpm run typecheck    # cwd=C:\Users\Administrator\Documents\Codex\2026-10-19\https-github-com-google-research-harness2
$ git rev-parse HEAD    # cwd=C:\Users\Administrator\Documents\Codex\2026-10-19\https-github-com-google-research-harness2
```

## 分层结论（先看这里，不看单行全绿）

| 层 | passed | failed | not-run | 该层是否完整 |
| :-- | --: | --: | --: | :-- |
| 工程可运行 (`engineering-runnable`) | 2 | 0 | 0 | 完整 |
| 安全契约 (`security-contract`) | 12 | 0 | 1 | **不完整** |
| 学习语义 (`learning-semantics`) | 1 | 0 | 0 | 完整 |
| 真实宿主兼容 (`real-host-compatibility`) | 6 | 0 | 0 | 完整 |
| 任务收益 (`task-benefit`) | 0 | 0 | 2 | **不完整** |

### 工程可运行 (`engineering-runnable`)

| id | expected | observed | passed | failed | not-run | 授权 | 证据 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| `9.2-3` | off stops advice and collection, on restores advice, an in-flight call is aborted, the slow tool settles, and dispose leaves zero listeners/mounts/further observations. | offStopsAdvice=true offStopsCollection=true onRestoresAdvice=true abortSettled=true(116ms) listenersAfterDispose=0 mountsAfterDispose=0 postDisposeObservations=0 | **passed** | — | — | not-required | `in-host runtime control + dispose counters` |
| `9.0-1` | The smoke harness loads inside the installed host, the adapter attaches to the real event bus, the manifest validates, and the run finishes inside the deadline. | detected=true; installedHooks=4; detectedEvents=4; manifestProblems=0 | **passed** | — | — | not-required | `HostCapabilityManifest validateManifest` |

### 安全契约 (`security-contract`)

| id | expected | observed | passed | failed | not-run | 授权 | 证据 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| `9.2-1` | Two sessions × two branches: a trusted domain branch is learnable, a trusted invariant branch gets neither advice nor a learned record, and ordinary tool calls still execute. | domain records=1, invariant records=0, domain toolError=false, host-real records=0 | **passed** | — | — | not-required | `contract-shaped scenarios (labelled in the report)` |
| `9.2-4` | A deny AND a cancel decided deeper in the waterfall by the host survive the adapter; Jit never denies. | host deny preserved=true, host cancel preserved=true | **passed** | — | — | not-required | `dsh-tools error result after host deny/cancel` |
| `9.2-5` | An identity-free dispatch (and a plain-sessionId dispatch) is passed through to the tool body with no advice and no learning record; the skip is counted without storing a payload. | anonymous passThrough=true, anonymous records=0, anonymous scopeUnknownSkipped=1, host-real advice=false, gate asks=0, gate tool executed=true | **passed** | — | — | not-required | `D1 fail-closed counters + gate-mode anonymity probe` |
| `9.2-6` | Boundary stated explicitly: namespace/branch isolation is logical (ScopeRegistry + hook scope matching + advice/learning channels). It is NOT an OS sandbox and cannot stop a tool body from reading the filesystem; only the host sandbox policy can. | namespace isolation = ScopeRegistry trust + hook scope matching (logical). OS sandboxing remains the host's own sandbox seam and was NOT exercised by this smoke. | **passed** | — | — | not-required | `docs/adr/0001 §2.6 (Gate 4 capability list)` `dsh-tools sandbox seam is host-owned (not bridged here)` |
| `9.2-7` | Gate mode can only ASK (never deny): a trusted scope gets exactly one ask, which the host ToolRuntime turns into its own approval flow; an unprovable identity gets NO ask and still executes. | unproven: asks=0 executed=true skippedCounted=1; trusted: asks=1 executedByHost=false (false means the host approval flow withheld execution after the ask — not that Jit denied) | **passed** | — | — | not-required | `gate-mode adapter over the real dsh-tools approval path` |
| `9.2-shape-1-pre-execute-without-tool-name` | D1: pass the host decision through, no advice, no record | injected=tools/pre-execute payload with `arguments` but no `name`; hostDecision=allow observed=allow; advisorCalls=0; records=0 | **passed** | — | — | not-required | `tests/e2e/host-smoke/degradation.ts` |
| `9.2-shape-2-pre-step-decision-without-additional-contexts` | D1: no advice appended; the enter decision is returned unchanged | injected=agent/pre-step payload with no identity and a decision lacking additionalContexts; hostDecision=enter observed=enter; advisorCalls=0; records=0 | **passed** | — | — | not-required | `tests/e2e/host-smoke/degradation.ts` |
| `9.2-shape-3-post-execute-unknown-error-shape` | D1: no learning sample from an unprovable/unknown shape; host decision unchanged | injected=tools/post-execute result with an undocumented error flag and no identity; hostDecision=accept observed=accept; advisorCalls=0; records=0 | **passed** | — | — | not-required | `tests/e2e/host-smoke/degradation.ts` |
| `9.2-shape-4-assembly-without-sections` | the mount is skipped with a bounded note; the host assembly is returned unchanged | injected=system-prompt/assemble assembly object without a sections array; hostDecision=object-without-sections observed=object-without-sections; advisorCalls=0; records=0 | **passed** | — | — | not-required | `tests/e2e/host-smoke/degradation.ts` |
| `9.2-shape-5-self-claimed-identity` | D1: a payload self-claim is not authorization; no advice, no record | injected=tools/post-execute payload self-declaring branchId/sessionId/role/allowAdvice; hostDecision=accept observed=accept; advisorCalls=0; records=0 | **passed** | — | — | not-required | `tests/e2e/host-smoke/degradation.ts` |
| `9.2-shape-6-undispatched-hook` | install is idempotent and dispose removes every listener (no residue) | injected=system-prompt/assemble listener installed but never dispatched; hostDecision=listener-installed observed=listener-removed; advisorCalls=0; records=0 | **passed** | — | — | not-required | `tests/e2e/host-smoke/degradation.ts` |
| `9.4-1` | No real business namespace is entered while the security contract is open; baseline execution + shadow advice only, L3/mirror stay default-off. | test tags only: hostsmoke-20261030210917-s1,hostsmoke-20261030210917-s2; namespaces=hostsmoke/20261030210917/test-domain,hostsmoke/20261030210917/test-invariant; business namespace harness2/jitrl never addressed; mirror/L3 default-off in config | **passed** | — | — | not-required | `tests/e2e/host-smoke/samples.ts validateNaming` |
| `9.6-4` | Identity per hook is read from the payload the plugin actually receives; when a branchId is present (or a provable mapping exists) sibling/anonymous/self-claim/dispose/deny precedence must be demonstrated; with no branchId the result is BLOCKED, never passed by omission (rev6 R2-2). This probe emits its OWN identity-free payloads (t29/T17-F2): that demonstrates the fail-closed path, NOT what the host supplies on its own dispatches. | probe-built identity-free dispatches (A.5): agent/pre-step[branch=0 session=0 ns=0] system-prompt/assemble[branch=0 session=0 ns=0] tools/post-execute[branch=0 session=0 ns=0] tools/pre-execute[branch=0 session=0 ns=0] | — | — | **not-run**：blocked: across the 4 host-real scenarios observed this round the host supplies branchId=0 with identity limited to session, so Gate 4 is NOT claimed; the session id is not a branch identity (D-P4-1). This is a BOUNDED observation (4 scenarios, this host version) - it does not assert that the host never supplies a branchId in general. External condition, not a harness defect | not-required | `readHookScope over probe-built hook args (附录 A.5)` `absent branchId => blocked (Gate 4 not claimed)` `host-supplied identity NOT observed this round (see A.5 provenance notice)` |

### 学习语义 (`learning-semantics`)

| id | expected | observed | passed | failed | not-run | 授权 | 证据 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| `9.5-1` | Shadow means baseline execution + recorded advice: switching Jit off stops all seven surfaces, while invariant scopes never become learning material. | sevenSurfacesOff=true generationMoved=true invariantRecords=0 hostRealLearned=0 | **passed** | — | — | not-required | `runtime-control JIT_SURFACES seven-surface check` |

### 真实宿主兼容 (`real-host-compatibility`)

| id | expected | observed | passed | failed | not-run | 授权 | 证据 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| `9.2-2` | Record which identity each hook really provides, and prove a sibling probe sharing one sessionId is not mistaken for an ordinary session (no advice, no record). | identity per hook: system-prompt/assemble[branch=0 session=1 ns=0] tools/pre-execute[branch=0 session=1 ns=0] tools/post-execute[branch=0 session=1 ns=0] agent/pre-step[branch=0 session=0 ns=0]; host-real sibling advice=false, records=0; agentCarrierOnToolDispatch=true | **passed** | — | — | not-required | `HostCapabilityManifest.identity.perHook` |
| `9.2-8` | `turn/end` is a durable session observation, not a decision hook: it must be recorded as such (dispatch=session-append), never counted among the four hooks, and its listener must be removable. | listenerInstalled=true disposerKind=function hookCount=4 (turn/end excluded from hooks) | **passed** | — | — | not-required | `HostCapabilityManifest.durableEvents` `installed dsh-agent-loop: session.append("turn/end", ...)` |
| `9.3-1` | One real stdio MCP backend: discovery, aggregate-only mirror write, no error-body echo (canary stays out of diagnostics), zero backend calls while the mirror is off, timeout handled, restart rediscovery identical and idempotent. | tools=5 written=1 canaryDegraded=true canaryLeaked=false freeTextLine=false ns=hostsmoke/jitrl/host_tool callsWhileOff=0 timeoutSettled=true(263ms) restartSpawns=2 sameTools=true repeatWrite=1 | **passed** | — | — | not-required | `real stdio JSON-RPC backend + real mirror store` |
| `9.6-1` | Every HARNESS_COMPONENT_KEYS surface is classified native/fallback/unavailable/not-run from probe evidence (rev5 P1-1 / A-t10-3); "not-run" faces name the harness limitation instead of being upgraded to native. | native=3 fallback=0 unavailable=0 not-run=5; adapter=dsh-hooks; hookDetected=true; structuralSeams=0; matrixProblems=0 | **passed** | — | — | absent | `八表面逐面分类（附录 A.2）` `adapter=dsh-hooks; contextKind=bare-cordis-context` |
| `9.6-2` | The plugin exposes a read-only per-surface status: enabled (config) vs mountable (adapter), lastMountResult/seamUnavailable only when observed (collect-or-omit), cacheRead=unknown (A-t10-2). | mountable=3/8 enabled=8/8 lastMountResult observed=0/8 cacheRead=unknown/8 statusProblems=0 | **passed** | — | — | absent | `插件只读状态聚合（附录 A.3）` `source=surfaceStatusSnapshot(runConfig, dshHooksAdapter)` |
| `9.6-3` | Evidence is taken from the plugin's OWN apply() context (real ctx.systemPrompt/ctx.tools mounted), not from an adapter the smoke constructed on a bare Cordis Context; production resolveHostAdapter and the classified adapter must be the same source (rev6 R2-1). | apply() handle=true; ctx services tools=true systemPrompt=true; productionResolved=dsh-hooks; classify adapter=dsh-hooks; hooksRegistered=7 expectedMissing=0 (+3 lifecycle hooks beyond the four dispatch hooks); crossCheck=8/8 disagreements=0 | **passed** | — | — | not-required | `apply() on a service-equipped context (附录 A.4)` `productionResolved vs classified adapter equality is asserted, not disclaimed` |

### 任务收益 (`task-benefit`)

| id | expected | observed | passed | failed | not-run | 授权 | 证据 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| `9.4-2` | A real model call and a real memory write, executed only under explicit user authorization (environment + account + budget), with the evidence recorded. | no explicit user authorization for a real model call / real memory write in this environment | — | — | **not-run**：requires explicit user authorization (environment + account + budget); the harness deliberately does not mock it | absent | — |
| `9.4-3` | Shadow RC task-benefit comparison (baseline execution + recorded advice) in authorized real sessions. | not measured: needs authorized real sessions plus the RewardContract (P6.1-D) closed | — | — | **not-run**：depends on explicit authorization and on P6.1-D/E; no synthetic number is substituted | absent | — |

---

## 附录：HostCapabilityManifest（本报告的证据面）

```text
host DeepSeek Harness 0.2.1-rc.5 (cordis 4.0.5, node 24.21.0, electron 44.7.0)
plugin dsh-plugin-evo-harness@0.1.0 commit 97e38db37305 (dirty worktree)
hook system-prompt/assemble: support=installed disposer=function dispatched=true payloadFields=3
hook tools/pre-execute: support=installed disposer=function dispatched=true payloadFields=8
hook tools/post-execute: support=installed disposer=function dispatched=true payloadFields=8
hook agent/pre-step: support=installed disposer=function dispatched=true payloadFields=4
durable turn/end: listenerInstalled=true dispatch=session-append
identity system-prompt/assemble: branchId=none sessionId=payload namespace=none plainSessionIdOnly=true fields=id,session
identity tools/pre-execute: branchId=none sessionId=payload namespace=none plainSessionIdOnly=true fields=agent,id,session
identity tools/post-execute: branchId=none sessionId=payload namespace=none plainSessionIdOnly=true fields=agent,id,session
identity agent/pre-step: branchId=none sessionId=carrier-this namespace=none plainSessionIdOnly=false fields=
permission precedence: host-deny > host-cancel > jit-ask > jit-deny
gate4: not-passed (real model call and real memory write require explicit user authorization (task §9.2/§9.4); the host provides no branchId on any hook dispatch (identity is sessionId via payload, or carrier-only on agent/pre-step), so the D1 §2.5 host-session scope registration path is still unproven against a branch-aware host; security contract (F9/provenance/mirror diagnostics) must be closed in P6_STATUS before Gate 4)
host surface: waterfall=true off=false fork=false
prompt assembly sections=true
ctx.on disposer kind=function unregisters=true
turn/end listener installed=true kind=function
identity probe (host-real): system-prompt/assemble[branch=0 session=1 ns=0 carrierId=false] tools/pre-execute[branch=0 session=1 ns=0 carrierId=false] tools/post-execute[branch=0 session=1 ns=0 carrierId=false] agent/pre-step[branch=0 session=0 ns=0 carrierId=true]
adapter installed hooks=system-prompt/assemble,tools/pre-execute,tools/post-execute,agent/pre-step
registered 2 test tools through the real dsh-tools registry
host-real sibling: advice=false records=0
contract-shaped domain: records=1
contract-shaped invariant: records=0
contract-shaped unregistered sibling: records=0
advisory path (host-real): dispatched=true advisorCalls=0 advice=false skippedDelta=1
advisory path (contract-shaped): advisorCalls=1 advice=true
host deny preserved=true cancel preserved=true
abort settled=true in 116ms
runtime control: collectOff=true collectOn=true advisorCallsWhileOff=0 sevenSurfacesOff=true generation=3
dispose: listeners=0 mounts=0 postDisposeObservations=0
learning: domainRecords=1 invariantRecords=0 unregisteredSiblingRecords=0 hostRealRecords=0
gate mode: anonymousAsked=0 anonymousSkipped=1 anonymousExecuted=true trustedAsked=1 trustedExecuted=false
apply-context: apply() handle=true hooks=7 expectedMissing=0 productionResolved=dsh-hooks crossCheck=8/8 disagreements=0
discovered=hostsmoke_call_count,hostsmoke_fail_with_canary,hostsmoke_slow,search_memory,write_note
aggregate written=1 degraded=false
canary degraded=true leaked=false freeText=false
disabled mirror backend calls=0
timeout settled=true elapsed=263
restart spawns=2 repeatWrite=1
degradation cases=6
identity evidence:
  host-real host-real-session-agent: branch=0 session=1 ns=0 fields=agent,id plainSessionIdOnly=true
  host-real host-real-sibling-same-session: branch=0 session=1 ns=0 fields=agent,id plainSessionIdOnly=true
  host-real host-real-second-session: branch=0 session=1 ns=0 fields=agent,id plainSessionIdOnly=true
  host-real host-real-no-agent: branch=0 session=0 ns=0 fields= plainSessionIdOnly=false
  contract-shaped contract-shaped-domain-registered: branch=1 session=1 ns=0 fields=agent,branchId,id plainSessionIdOnly=false
  contract-shaped contract-shaped-invariant-registered: branch=1 session=1 ns=0 fields=agent,branchId,id plainSessionIdOnly=false
  contract-shaped contract-shaped-unregistered-sibling: branch=1 session=1 ns=0 fields=agent,branchId,id plainSessionIdOnly=false
  advisory-path(host-real): payloadFields=messages,signal,step,turn advisorCalls=0 skippedDelta=1
  advisory-path(contract-shaped): advisorCalls=1 advice=true
  gate-path: asks=0 skipped=1 executed=true
mcp diagnostics (1 lines, whitelist shape):
  mirror_diag code=write_failed phase=write operation=statWrite retryable=false errorClass=backend_rejection correlationId=mirror-write_failed-1 serverRef=server:426c1935 namespaceRef=ns:2ac60c40
```

manifest 校验：无问题
报告行校验：无问题


## 八表面逐面分类（P1-1 / A-t10-3）

每一面只按探针观测到的证据分类：`native` = 宿主自身机制（hook 监听或 Cordis ctx 服务 seam）；`fallback` = 插件进程内参考实现；`unavailable` = 适配器确定没有该 seam；`not-run` = 本次观测不到（限制条件写在 limitation 列，不得读成 native）。

| 项 | 值 |
| :-- | :-- |
| 采集时间 | 2026-10-30T21:09:18.945Z |
| 解析出的适配器 | `dsh-hooks` |
| 生产解析 `resolveHostAdapter`（同上下文） | `in-memory` |
| 检测到 DSH hook 宿主 | true |
| 已安装 hook 事件 | `system-prompt/assemble`, `tools/pre-execute`, `tools/post-execute`, `agent/pre-step` |
| 发现的 Cordis 结构 seam 数 | 0 |
| 探针所用上下文 | `bare-cordis-context` |
| 合计 | native=3 fallback=0 unavailable=0 not-run=5 |

| surface | configured | availability | 机制 | 宿主方法 | 证据 | limitation |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| `system_prompt` | true | **native** | `dsh-hook` | `registerPromptSegment` | `adapter=dsh-hooks method=registerPromptSegment present=true structuralSeams=0 ctx=bare-cordis-context dispatch[system-prompt/assemble]=true payloadFields=3 hookEvents=4` | — |
| `guardrails` | true | **native** | `dsh-hook` | `registerGuardrails` | `adapter=dsh-hooks method=registerGuardrails present=true structuralSeams=0 ctx=bare-cordis-context dispatch[tools/pre-execute]=true payloadFields=8 hookEvents=4` | — |
| `memory` | true | **not-run** | `not-observed` | `registerMemoryScope` | `adapter=dsh-hooks method=registerMemoryScope present=false structuralSeams=0 ctx=bare-cordis-context` | the dsh-hooks adapter forwards this seam only when the context exposes it; the bare Cordis Context used by this runner did not, so mountability was NOT observed (harness limitation, not proof that the host lacks it) |
| `tool_guidance` | true | **not-run** | `not-observed` | `patchToolGuidance` | `adapter=dsh-hooks method=patchToolGuidance present=false structuralSeams=0 ctx=bare-cordis-context` | the dsh-hooks adapter forwards this seam only when the context exposes it; the bare Cordis Context used by this runner did not, so mountability was NOT observed (harness limitation, not proof that the host lacks it) |
| `skills` | true | **not-run** | `not-observed` | `mountSkills` | `adapter=dsh-hooks method=mountSkills present=false structuralSeams=0 ctx=bare-cordis-context` | the dsh-hooks adapter forwards this seam only when the context exposes it; the bare Cordis Context used by this runner did not, so mountability was NOT observed (harness limitation, not proof that the host lacks it) |
| `scripts` | true | **not-run** | `not-observed` | `mountScripts` | `adapter=dsh-hooks method=mountScripts present=false structuralSeams=0 ctx=bare-cordis-context` | the dsh-hooks adapter forwards this seam only when the context exposes it; the bare Cordis Context used by this runner did not, so mountability was NOT observed (harness limitation, not proof that the host lacks it) |
| `subagents` | true | **not-run** | `not-observed` | `registerSubagents` | `adapter=dsh-hooks method=registerSubagents present=false structuralSeams=0 ctx=bare-cordis-context` | the dsh-hooks adapter forwards this seam only when the context exposes it; the bare Cordis Context used by this runner did not, so mountability was NOT observed (harness limitation, not proof that the host lacks it) |
| `plugins` | true | **native** | `dsh-hook` | `mountMiddleware` | `adapter=dsh-hooks method=mountMiddleware present=true structuralSeams=0 ctx=bare-cordis-context dispatch[agent/pre-step]=true payloadFields=4 hookEvents=4` | — |

**限制条件（必须随本表一起引用）**：本 runner 在安装宿主内构造的是裸 Cordis Context；宿主把 tools/skills/subagents 等服务注入的是插件被 apply 时的上下文。因此 `not-run` 表示“本次 harness 观测不到该面”，不是“宿主没有该面”；把它写成 `native` 或 `unavailable` 都是超出证据。逐面 evidence 列给出产生判定的具体字段（adapter/method/present/structuralSeams/ctx），hook 型面另附 manifest 的真实 dispatch 事实。 生产解析在同一裸上下文上得到 `in-memory`（裸上下文不含 ctx.systemPrompt/ctx.tools/ctx.agents 服务，detectDshHookHost 因此不成立）；本表按插件在真实宿主中实际挂载的 dsh-hooks 适配器分类，hook 型面附 manifest 的真实 dispatch 事实。


## 插件只读状态聚合（P1-2 / A-t10-2）

`enabled` = 配置事实；`mountable` = 适配器事实；`lastMountResult`/`seamUnavailable` 只在有挂载记录时出现（无记录 = 未观测，不是 0）；`cacheRead` 本进程无测量点，恒为 `unknown`。

| surface | enabled | mountable | lastMountResult | seamUnavailable | cacheRead |
| :-- | :-- | :-- | :-- | :-- | :-- |
| `system_prompt` | true | true | 未观测 | 未观测 | `unknown` |
| `guardrails` | true | true | 未观测 | 未观测 | `unknown` |
| `memory` | true | false | 未观测 | 未观测 | `unknown` |
| `tool_guidance` | true | false | 未观测 | 未观测 | `unknown` |
| `skills` | true | false | 未观测 | 未观测 | `unknown` |
| `scripts` | true | false | 未观测 | 未观测 | `unknown` |
| `subagents` | true | false | 未观测 | 未观测 | `unknown` |
| `plugins` | true | true | 未观测 | 未观测 | `unknown` |

| 合计 | enabled=8 mountable=3 有挂载记录=0 / 8 |  |  |  |  |

## 附录 A.4：真实插件 apply 上下文（rev6 R2-1）

rc2 的分类来自 smoke 自建适配器 + **裸** Cordis Context，因此生产解析与分类适配器**不一致**，只能靠 `resolveNote` 散文免责。rc3 改为在真正挂载了 `ctx.systemPrompt`/`ctx.tools` 的上下文上调用插件**自己的 `apply()`**，并断言两者**相等**。

| 项 | 值 |
| :-- | :-- |
| 上下文服务 | `tools=true systemPrompt=true` |
| `apply()` 返回 handle | true |
| 生产 `resolveHostAdapter`（同上下文） | `dsh-hooks` |
| 分类所用适配器 | `dsh-hooks` |
| 两者是否相等 | **true** |
| `detectDshHookHost` | true |
| 结构 seam 数 | 0 |
| `apply()` 注册的 hook | `agent/error`, `agent/pre-step`, `agent/status`, `session/event`, `system-prompt/assemble`, `tools/post-execute`, `tools/pre-execute` |
| 契约内 hook 是否齐全 | true（缺失：无） |
| 逐面交叉核对 | 8/8，分歧 0 |
| `lastMountResult` 观测数 | 0/8（apply() 只注册 hook、不挂载 surface，故按 collect-or-omit 如实省略） |
| `cacheRead` | unknown 8/8 |

交叉核对逐面结果：

| surface | 分类 | handle.mountable | handle.enabled | 一致 |
| :-- | :-- | :--: | :--: | :--: |
| `system_prompt` | native | true | true | 是 |
| `guardrails` | native | true | true | 是 |
| `memory` | not-run | false | true | 是 |
| `tool_guidance` | not-run | false | true | 是 |
| `skills` | not-run | false | true | 是 |
| `scripts` | not-run | false | true | 是 |
| `subagents` | not-run | false | true | 是 |
| `plugins` | native | true | true | 是 |

> 注：apply() registers hooks but mounts no surface, so lastMountResult is legitimately absent: the adapter only records a mount when a surface method is called (probe/patch paths), and no surface was mounted here. observed=0/8

## 附录 A.5：探针自建 dispatch 的身份读取（rev6 R2-2）

**出处声明（必读）**：本表的 dispatch 是**探针自己发出的**（`DISPATCH_PLAN`），
payload 由探针构造且**不含任何身份字段**。因此本表证明的是「插件自己的
`readHookScope` 在 identity-free payload 上读不到身份，于是 fail-closed 不匹配」。
**本表不能证明宿主提供什么身份**；宿主提供什么，**见本报告的 `identity evidence:` 段**
（`host-real` 条目，由捕获监听器对宿主真实 dispatch 调用 `readHookScope` 读出）：
本轮 4 个 host-real 场景实测 **branchId=0、身份仅限 session**（其中 `host-real-no-agent` 连
session 也是 0）。这是**有界观测**——4 个场景、本轮宿主版本——**不构成**「宿主永不提供
branchId」的普遍断言；一旦宿主开始在 dispatch 中携带 branch，该段与守卫会先变。
`hookScopeMatches` 用 `branch` 类挂载判定是否放行。

| hook | 已 dispatch | branchIds | sessionIds | namespaces | 对 branch 类挂载是否匹配 | payload 字段 |
| :-- | :--: | --: | --: | --: | :--: | :-- |
| `agent/pre-step` | true | 0 | 0 | 0 | 不匹配 | `（空）` |
| `system-prompt/assemble` | false | 0 | 0 | 0 | 不匹配 | `（空）` |
| `tools/post-execute` | false | 0 | 0 | 0 | 不匹配 | `（空）` |
| `tools/pre-execute` | true | 0 | 0 | 0 | 不匹配 | `name, arguments` |

**结论 = blocked（不是 passed，也不是 native）**：**Gate 4 不予主张**。

本表**能够**证明的：插件自己的 `readHookScope` 在 identity-free payload 上读不到任何身份，
`hookScopeMatches` 对 `branch` 类挂载 fail-closed 地判「不匹配」——这是 P4-C 要求的泄漏通道关闭；
`sessionId` 不是 branch 身份（D-P4-1）也由这些行如实体现。

本表**不能**证明的：宿主真实 dispatch 是否携带 `branchId`——零计数来自探针自建 payload，
不是宿主行为。**宿主实际提供什么，见本报告 `identity evidence:` 段的 `host-real` 条目**：
本轮 4 个场景实测 branchId=0、身份仅限 session。这是**有界观测**（4 个场景、本轮宿主版本），
所以 R2-2 记 **blocked**，既不记 passed，也不记「宿主永不提供 branchId」——
后者超出观测范围。要用真实证据替换 blocked，需要宿主在自己的 dispatch 中携带 branch
（届时 `identity evidence` 段会变，`tests/e2e/host-smoke/branch-identity.test.ts` 的 tripwire 也会失败并提示）。

## 附录：如何重跑与如何变成 Gate 4 可判定

```text
# 1) 只做就绪自检（不执行真实宿主调用）
node scripts/host-smoke/run.mjs --check
# 2) 只跑、不覆盖报告（观察本轮失败/未跑项）
node scripts/host-smoke/run.mjs --no-write
# 3) 完整跑并把报告写到新路径
node scripts/host-smoke/run.mjs --out docs/reports/host-smoke-rc4.md
# 注意：docs/reports/p61-host-smoke-rc.md（rc1）与
#       docs/reports/host-smoke-rc2.md（rc2）都是已冻结的证据，
#       不得作为 --out 目标（守卫目前只拦 rc1）。
# 4) 真实模型调用 / 真实 memory 写入（需显式授权，且需绑定账号与预算）
HOSTSMOKE_AUTHORIZED=1 node scripts/host-smoke/run.mjs --out <新报告路径>
```

本报告仍非 Gate 4 通过，原因见 gate4.blockedBy。要把 `9.4-2`/`9.4-3` 从 not-run 变为可判定，需要：

1. 用户显式授权真实模型调用与真实 memory 写入（环境 + 账号 + 预算），且 harness 能把授权绑定到账号；
2. 一个真实的、分支感知的宿主（hook dispatch 携带 branchId），否则 D1 §2.5 的 host-session scope 登记路径无法被真实证明；
3. RewardContract（P6.1-D）与负收益解释（P6.1-E）关闭，才能给出任务收益口径而不做宣传。

本轮**没有**把任何缺少条件的一项填成 passed，也没有用 mock 替代真实调用。

---

## 附录：运行边界检查（runner 侧）

| 检查 | 结果 |
| :-- | :-- |
| 子进程退出码 | 0 |
| 是否超时（120000ms） | 否 |
| 卸载后是否有存活子进程 | 无 |
| manifest 校验问题 | 无 |
| 报告行校验问题 | 无 |

边界问题清单：
（无）
