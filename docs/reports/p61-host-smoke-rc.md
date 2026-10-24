# P6.1-F 真实宿主受控 smoke 与 shadow RC 报告

| 项 | 值 |
| :-- | :-- |
| 报告 schema | `1` |
| 固定 commit | `7bce33ee9d102a6a05a35f080f606a8fd388e114`（工作树有未提交改动，结论仅对这些字节成立） |
| 插件版本 | `0.1.0` |
| 采集时间 | 2026-10-24T18:39:40.352Z |
| 宿主 | DeepSeek Harness 0.2.1-rc.2 (product version from the asar package.json) |
| 宿主 | cordis 4.0.5 |
| 宿主 | node 24.21.0 |
| 宿主 | electron 44.7.0 |
| 宿主 | runtime win32/x64 |

## 固定命令列

```text
$ node scripts/host-smoke/run.mjs    # cwd=C:\Users\Administrator\Documents\Codex\2026-10-19\https-github-com-google-research-harness2
$ pnpm run typecheck    # cwd=C:\Users\Administrator\Documents\Codex\2026-10-19\https-github-com-google-research-harness2
$ git rev-parse HEAD    # cwd=C:\Users\Administrator\Documents\Codex\2026-10-19\https-github-com-google-research-harness2
```

## 分层结论（先看这里，不看单行全绿）

| 层 | passed | failed | not-run | 该层是否完整 |
| :-- | --: | --: | --: | :-- |
| 工程可运行 (`engineering-runnable`) | 2 | 0 | 0 | 完整 |
| 安全契约 (`security-contract`) | 12 | 0 | 0 | 完整 |
| 学习语义 (`learning-semantics`) | 1 | 0 | 0 | 完整 |
| 真实宿主兼容 (`real-host-compatibility`) | 3 | 0 | 0 | 完整 |
| 任务收益 (`task-benefit`) | 0 | 0 | 2 | **不完整** |

### 工程可运行 (`engineering-runnable`)

| id | expected | observed | passed | failed | not-run | 授权 | 证据 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| `9.2-3` | off stops advice and collection, on restores advice, an in-flight call is aborted, the slow tool settles, and dispose leaves zero listeners/mounts/further observations. | offStopsAdvice=true offStopsCollection=true onRestoresAdvice=true abortSettled=true(110ms) listenersAfterDispose=0 mountsAfterDispose=0 postDisposeObservations=0 | **passed** | — | — | not-required | `in-host runtime control + dispose counters` |
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
| `9.4-1` | No real business namespace is entered while the security contract is open; baseline execution + shadow advice only, L3/mirror stay default-off. | test tags only: hostsmoke-20261024183939-s1,hostsmoke-20261024183939-s2; namespaces=hostsmoke/20261024183939/test-domain,hostsmoke/20261024183939/test-invariant; business namespace harness2/jitrl never addressed; mirror/L3 default-off in config | **passed** | — | — | not-required | `tests/e2e/host-smoke/samples.ts validateNaming` |

### 学习语义 (`learning-semantics`)

| id | expected | observed | passed | failed | not-run | 授权 | 证据 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| `9.5-1` | Shadow means baseline execution + recorded advice: switching Jit off stops all seven surfaces, while invariant scopes never become learning material. | sevenSurfacesOff=true generationMoved=true invariantRecords=0 hostRealLearned=0 | **passed** | — | — | not-required | `runtime-control JIT_SURFACES seven-surface check` |

### 真实宿主兼容 (`real-host-compatibility`)

| id | expected | observed | passed | failed | not-run | 授权 | 证据 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| `9.2-2` | Record which identity each hook really provides, and prove a sibling probe sharing one sessionId is not mistaken for an ordinary session (no advice, no record). | identity per hook: system-prompt/assemble[branch=0 session=1 ns=0] tools/pre-execute[branch=0 session=1 ns=0] tools/post-execute[branch=0 session=1 ns=0] agent/pre-step[branch=0 session=0 ns=0]; host-real sibling advice=false, records=0; agentCarrierOnToolDispatch=true | **passed** | — | — | not-required | `HostCapabilityManifest.identity.perHook` |
| `9.2-8` | `turn/end` is a durable session observation, not a decision hook: it must be recorded as such (dispatch=session-append), never counted among the four hooks, and its listener must be removable. | listenerInstalled=true disposerKind=function hookCount=4 (turn/end excluded from hooks) | **passed** | — | — | not-required | `HostCapabilityManifest.durableEvents` `installed dsh-agent-loop: session.append("turn/end", ...)` |
| `9.3-1` | One real stdio MCP backend: discovery, aggregate-only mirror write, no error-body echo (canary stays out of diagnostics), zero backend calls while the mirror is off, timeout handled, restart rediscovery identical and idempotent. | tools=5 written=1 canaryDegraded=true canaryLeaked=false freeTextLine=false ns=hostsmoke/jitrl/host_tool callsWhileOff=0 timeoutSettled=true(264ms) restartSpawns=2 sameTools=true repeatWrite=1 | **passed** | — | — | not-required | `real stdio JSON-RPC backend + real mirror store` |

### 任务收益 (`task-benefit`)

| id | expected | observed | passed | failed | not-run | 授权 | 证据 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| `9.4-2` | A real model call and a real memory write, executed only under explicit user authorization (environment + account + budget), with the evidence recorded. | no explicit user authorization for a real model call / real memory write in this environment | — | — | **not-run**：requires explicit user authorization (environment + account + budget); the harness deliberately does not mock it | absent | — |
| `9.4-3` | Shadow RC task-benefit comparison (baseline execution + recorded advice) in authorized real sessions. | not measured: needs authorized real sessions plus the RewardContract (P6.1-D) closed | — | — | **not-run**：depends on explicit authorization and on P6.1-D/E; no synthetic number is substituted | absent | — |

---

## 附录：HostCapabilityManifest（本报告的证据面）

```text
host DeepSeek Harness 0.2.1-rc.2 (cordis 4.0.5, node 24.21.0, electron 44.7.0)
plugin dsh-plugin-evo-harness@0.1.0 commit 7bce33ee9d10 (dirty worktree)
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
abort settled=true in 110ms
runtime control: collectOff=true collectOn=true advisorCallsWhileOff=0 sevenSurfacesOff=true generation=3
dispose: listeners=0 mounts=0 postDisposeObservations=0
learning: domainRecords=1 invariantRecords=0 unregisteredSiblingRecords=0 hostRealRecords=0
gate mode: anonymousAsked=0 anonymousSkipped=1 anonymousExecuted=true trustedAsked=1 trustedExecuted=false
discovered=hostsmoke_call_count,hostsmoke_fail_with_canary,hostsmoke_slow,search_memory,write_note
aggregate written=1 degraded=false
canary degraded=true leaked=false freeText=false
disabled mirror backend calls=0
timeout settled=true elapsed=264
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

## 附录：如何重跑与如何变成 Gate 4 可判定

```text
# 1) 只做就绪自检（不执行真实宿主调用）
node scripts/host-smoke/run.mjs --check
# 2) 只跑、不覆盖报告（观察本轮失败/未跑项）
node scripts/host-smoke/run.mjs --no-write
# 3) 完整跑并落盘 docs/reports/p61-host-smoke-rc.md
node scripts/host-smoke/run.mjs
# 4) 真实模型调用 / 真实 memory 写入（需显式授权，且需绑定账号与预算）
HOSTSMOKE_AUTHORIZED=1 node scripts/host-smoke/run.mjs
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
