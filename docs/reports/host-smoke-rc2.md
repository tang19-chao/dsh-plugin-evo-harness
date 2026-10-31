# P6.1-F 真实宿主受控 smoke 与 shadow RC 报告

| 项 | 值 |
| :-- | :-- |
| 报告 schema | `1` |
| 固定 commit | `97e38db37305b24f695a5f989428b3611f84987c`（工作树有未提交改动，结论仅对这些字节成立） |
| 插件版本 | `0.1.0` |
| 采集时间 | 2026-10-29T22:09:48.944Z |
| 宿主 | DeepSeek Harness 0.2.1-rc.3 (product version from the asar package.json) |
| 宿主 | cordis 4.0.5 |
| 宿主 | node 24.21.0 |
| 宿主 | electron 44.7.0 |
| 宿主 | runtime win32/x64 |

## 固定命令列

```text
$ node scripts/host-smoke/run.mjs --out docs/reports/host-smoke-rc2.md   # cwd=C:\Users\Administrator\Documents\Codex\2026-10-19\https-github-com-google-research-harness2
$ pnpm run typecheck    # cwd=C:\Users\Administrator\Documents\Codex\2026-10-19\https-github-com-google-research-harness2
$ git rev-parse HEAD    # cwd=C:\Users\Administrator\Documents\Codex\2026-10-19\https-github-com-google-research-harness2
```

## 分层结论（先看这里，不看单行全绿）

| 层 | passed | failed | not-run | 该层是否完整 |
| :-- | --: | --: | --: | :-- |
| 工程可运行 (`engineering-runnable`) | 2 | 0 | 0 | 完整 |
| 安全契约 (`security-contract`) | 12 | 0 | 0 | 完整 |
| 学习语义 (`learning-semantics`) | 1 | 0 | 0 | 完整 |
| 真实宿主兼容 (`real-host-compatibility`) | 5 | 0 | 0 | 完整 |
| 任务收益 (`task-benefit`) | 0 | 0 | 2 | **不完整** |

### 工程可运行 (`engineering-runnable`)

| id | expected | observed | passed | failed | not-run | 授权 | 证据 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| `9.2-3` | off stops advice and collection, on restores advice, an in-flight call is aborted, the slow tool settles, and dispose leaves zero listeners/mounts/further observations. | offStopsAdvice=true offStopsCollection=true onRestoresAdvice=true abortSettled=true(105ms) listenersAfterDispose=0 mountsAfterDispose=0 postDisposeObservations=0 | **passed** | — | — | not-required | `in-host runtime control + dispose counters` |
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
| `9.4-1` | No real business namespace is entered while the security contract is open; baseline execution + shadow advice only, L3/mirror stay default-off. | test tags only: hostsmoke-20261029220947-s1,hostsmoke-20261029220947-s2; namespaces=hostsmoke/20261029220947/test-domain,hostsmoke/20261029220947/test-invariant; business namespace harness2/jitrl never addressed; mirror/L3 default-off in config | **passed** | — | — | not-required | `tests/e2e/host-smoke/samples.ts validateNaming` |

### 学习语义 (`learning-semantics`)

| id | expected | observed | passed | failed | not-run | 授权 | 证据 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| `9.5-1` | Shadow means baseline execution + recorded advice: switching Jit off stops all seven surfaces, while invariant scopes never become learning material. | sevenSurfacesOff=true generationMoved=true invariantRecords=0 hostRealLearned=0 | **passed** | — | — | not-required | `runtime-control JIT_SURFACES seven-surface check` |

### 真实宿主兼容 (`real-host-compatibility`)

| id | expected | observed | passed | failed | not-run | 授权 | 证据 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| `9.2-2` | Record which identity each hook really provides, and prove a sibling probe sharing one sessionId is not mistaken for an ordinary session (no advice, no record). | identity per hook: system-prompt/assemble[branch=0 session=1 ns=0] tools/pre-execute[branch=0 session=1 ns=0] tools/post-execute[branch=0 session=1 ns=0] agent/pre-step[branch=0 session=0 ns=0]; host-real sibling advice=false, records=0; agentCarrierOnToolDispatch=true | **passed** | — | — | not-required | `HostCapabilityManifest.identity.perHook` |
| `9.2-8` | `turn/end` is a durable session observation, not a decision hook: it must be recorded as such (dispatch=session-append), never counted among the four hooks, and its listener must be removable. | listenerInstalled=true disposerKind=function hookCount=4 (turn/end excluded from hooks) | **passed** | — | — | not-required | `HostCapabilityManifest.durableEvents` `installed dsh-agent-loop: session.append("turn/end", ...)` |
| `9.3-1` | One real stdio MCP backend: discovery, aggregate-only mirror write, no error-body echo (canary stays out of diagnostics), zero backend calls while the mirror is off, timeout handled, restart rediscovery identical and idempotent. | tools=5 written=1 canaryDegraded=true canaryLeaked=false freeTextLine=false ns=hostsmoke/jitrl/host_tool callsWhileOff=0 timeoutSettled=true(256ms) restartSpawns=2 sameTools=true repeatWrite=1 | **passed** | — | — | not-required | `real stdio JSON-RPC backend + real mirror store` |
| `9.6-1` | Every HARNESS_COMPONENT_KEYS surface is classified native/fallback/unavailable/not-run from probe evidence (rev5 P1-1 / A-t10-3); "not-run" faces name the harness limitation instead of being upgraded to native. | native=3 fallback=0 unavailable=0 not-run=5; adapter=dsh-hooks; hookDetected=true; structuralSeams=0; matrixProblems=0 | **passed** | — | — | absent | `八表面逐面分类（附录 A.2）` `adapter=dsh-hooks; contextKind=bare-cordis-context` |
| `9.6-2` | The plugin exposes a read-only per-surface status: enabled (config) vs mountable (adapter), lastMountResult/seamUnavailable only when observed (collect-or-omit), cacheRead=unknown (A-t10-2). | mountable=3/8 enabled=8/8 lastMountResult observed=0/8 cacheRead=unknown/8 statusProblems=0 | **passed** | — | — | absent | `插件只读状态聚合（附录 A.3）` `source=surfaceStatusSnapshot(runConfig, dshHooksAdapter)` |

### 任务收益 (`task-benefit`)

| id | expected | observed | passed | failed | not-run | 授权 | 证据 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| `9.4-2` | A real model call and a real memory write, executed only under explicit user authorization (environment + account + budget), with the evidence recorded. | no explicit user authorization for a real model call / real memory write in this environment | — | — | **not-run**：requires explicit user authorization (environment + account + budget); the harness deliberately does not mock it | absent | — |
| `9.4-3` | Shadow RC task-benefit comparison (baseline execution + recorded advice) in authorized real sessions. | not measured: needs authorized real sessions plus the RewardContract (P6.1-D) closed | — | — | **not-run**：depends on explicit authorization and on P6.1-D/E; no synthetic number is substituted | absent | — |

---

## 附录：HostCapabilityManifest（本报告的证据面）

```text
host DeepSeek Harness 0.2.1-rc.3 (cordis 4.0.5, node 24.21.0, electron 44.7.0)
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
abort settled=true in 105ms
runtime control: collectOff=true collectOn=true advisorCallsWhileOff=0 sevenSurfacesOff=true generation=3
dispose: listeners=0 mounts=0 postDisposeObservations=0
learning: domainRecords=1 invariantRecords=0 unregisteredSiblingRecords=0 hostRealRecords=0
gate mode: anonymousAsked=0 anonymousSkipped=1 anonymousExecuted=true trustedAsked=1 trustedExecuted=false
discovered=hostsmoke_call_count,hostsmoke_fail_with_canary,hostsmoke_slow,search_memory,write_note
aggregate written=1 degraded=false
canary degraded=true leaked=false freeText=false
disabled mirror backend calls=0
timeout settled=true elapsed=256
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
| 采集时间 | 2026-10-29T22:09:48.943Z |
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

## 附录：如何重跑与如何变成 Gate 4 可判定

```text
# 1) 只做就绪自检（不执行真实宿主调用）
node scripts/host-smoke/run.mjs --check
# 2) 只跑、不覆盖报告（观察本轮失败/未跑项）
node scripts/host-smoke/run.mjs --no-write
# 3) 完整跑并把报告写到新路径（rc1 是冻结证据，默认目标未加 --force 时拒绝覆盖）
node scripts/host-smoke/run.mjs --out docs/reports/host-smoke-rc2.md
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
