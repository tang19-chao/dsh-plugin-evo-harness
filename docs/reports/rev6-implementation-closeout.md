# rev7 实现收口报告（A1–A6 / B8 / B9）

> **基线**：`main = fa1f211`（2026-11-02，attestation 提交，绑定 `9eac249`）。本报告描述的是该提交之上的**未提交** rev7 工作树。
> **方法**：逐跳读取真实代码 + 本地确定性单元 / e2e / 结构门禁；**没有真实模型调用、真实宿主写入、`HOSTSMOKE_AUTHORIZED=1`、`R3A_*` 真实收益测量、四臂消融或 guarded-active 运行**。
> **口径**：工程链路“已接通、可诚实测量”不等于“自进化有收益”。本报告不声称收益，也不声称真实宿主行为已被验证。

---

## 0. 结论速览

| 项 | 状态 | 本报告依据 |
| :--- | :--- | :--- |
| A1 补丁感知探针提示词 | 已实现 | `src/dsh-bridge/patch-prompt.ts:59`、`src/dsh-bridge/branch.ts:288` |
| A1-b agent-loop 同样渲染补丁 | 已实现 | `src/dsh-bridge/agent-loop-executor.ts:835` |
| A2 永久门假绿修复 | 已实现 | `tests/e2e/fixtures.ts:208`（`decodeContent`）、`host-mount-smoke` 断言 |
| A3 表面可评估矩阵 + proposer 限定 | 已实现 | `src/runtime/surface-evaluability.ts:104`、`src/orchestrator.ts:1332,1642,2240` |
| A4-1 `jitrl.writebackGate` 默认 auto | 已实现 | `src/runtime/writeback-policy.ts`、`src/index.ts` 解析与诊断 |
| A4-2 Dream verified-only-selection + 12 棵门 | 已实现 | `src/dream-rsi/surrogate-evidence-policy.ts:298`、`verified-tree-gate.ts:54` |
| A4-3 主链 not-evaluable | 已实现 | `src/jitrl/text-probe-evaluation.ts:222`、`src/orchestrator.ts` recorder |
| A4-4 对称步骤评审 | 已实现 | `src/jitrl/step-evaluator.ts:1034`、orchestrator 对 `ordered` 全量评审 |
| A4-5 生产验证 seam | **已实现“宿主 runner 接入 + 测试”**；**未实现 worktree runner** | `src/index.ts` 诊断、`tests/e2e/verification-seam-production.test.ts` |
| A5 branch-scoped hook 诊断 | 已实现 | `src/cordis-seams/host-mount-diagnostics.ts:35` |
| A6 跨模块契约测试 | 已实现 | `tests/e2e/signal-propagation.test.ts`（H3/H4/H6/H6'/H8/H9/H12） |
| B8 探针计量 | **已接线（ledger-only agentLoop 生产运行可证）**；无任何 settlement 的装配仍 unmetered（结构限制） | `src/index.ts` 三种执行器诊断、`tests/unit/integration/branch-metering.test.ts` production-run 用例 |
| rev6 独立审查修复波 | **22 项 verified 全部处理；1 项 unconfirmed（A4-3 L2 邻居）判定不可复现并记录理由** | 见 §9 |
| B9 不可评估面预算 | 已实现（A3） | 纯 `scripts/subagents/plugins` 补丁跳过并留诊断 |

---

## 1. 方法与本次实际执行的命令

### 1.1 读取

- 用户指定的审核与落地方案：`C:/Users/Administrator/Downloads/dsh-plugin-evo-harness-模块算法对接深度审核与DSH落地方案-rev6.md`（668 行，已完整读取）。
- 真实代码：`src/orchestrator.ts`、`src/index.ts`、`src/config.ts`、`src/dsh-bridge/*`、`src/runtime/*`、`src/jitrl/*`、`src/dream-rsi/*`、`src/cordis-seams/*`、`src/verification/*`、相关测试与 `README.md`。
- 审核文档中的行号和原型 diff 只作为线索；实现以工作树真实代码为准。

### 1.2 本次实际运行（全部 exit 0）

> 本节是前序施工会话的分组记录；其数字（329 / 49 / 176 / 344 / M5 baseline 8 等）不是当前工作树的最终总数。最终权威完整计数见 §10.3，审读修复轮的重跑证据见 §10.5。

| 命令 | 实际结果 |
| :--- | :--- |
| `npx --no-install tsc --noEmit` | exit 0，无输出 |
| `npx --no-install vitest run tests/unit/dsh-bridge/patch-prompt.test.ts … tests/unit/config/readme-default-leaves.test.ts`（19 个文件，A1–A6 回归） | **19 files / 329 tests passed** |
| `npx --no-install vitest run tests/unit/runtime/surface-evaluability.test.ts tests/unit/orchestrator/p3-proposal-select.test.ts tests/unit/integration/branch-metering.test.ts tests/e2e/verification-seam-production.test.ts tests/e2e/signal-propagation.test.ts` | **5 files / 49 tests passed** |
| `npx --no-install vitest run tests/unit/orchestrator tests/unit/integration` | **18 files / 176 tests passed** |
| `npx --no-install vitest run tests/e2e` | **29 files / 344 tests passed** |
| `npx --no-install vitest run tests/unit/meta/fake-llm-content-decoding.test.ts` | **1 file / 6 tests passed**（fake LLM 未解码块即失败的门） |
| `npx --no-install vitest run tests/unit/verification` | **7 files / 163 tests passed**（attach / host-runner / recorder-marks 的信任与 digest 回归） |
| `node scripts/eval/check-orphan-exports.mjs` | `OK: 111 source file(s), 40 orphan(s) all allow-listed (40).` |
| `node scripts/eval/check-test-import-coverage.mjs` | `OK: 111/111 src module(s) imported by a test (0 allow-listed).` |
| `node scripts/eval/metering-coverage.mjs` | `OK: 111 file(s) scanned, 4 allow-listed model call(s), 0 unmetered call(s).` |
| `node scripts/verify-readme-counts.mjs --docs-only` | `79 documented row(s) vs 79 expected default leaf path(s)`；SUCCESS |
| `node scripts/eval/smoke-build.mjs` | `SUCCESS`；`lib/index.js` 1,303,885 bytes；`stale: false`；74 named exports |
| `node scripts/eval/negative-result-diag.mjs --assert` | `A1..A6 PASS - the historical negative result is intact`；exit 0 |
| `node scripts/eval/guarded-regression.mjs --json` | exit 0（各守卫 status 见输出） |
| `node scripts/eval/mutation-gate.mjs --validate` | `anchors: all 5 mutants resolve against pristine sources`；exit 0 |
| `node scripts/eval/mutation-gate.mjs --run --only M5` | `[M5] KILLED baseline=ok(8 tests) sha changed red=2/2 must-red hit`；`worktree zero-residue: OK`；`verdict: PASS`；exit 0 |
| `git diff --check` | exit 0（仅有既有 CRLF 工作树告警，无空白错误） |
| 新文件字节检查（Python `read_bytes`） | 6 个新文件：CRLF=0、LF 计数正常、无 BOM（`src/runtime/surface-evaluability.ts`、3 个测试、runbook、本报告） |

### 1.3 没有运行

- 完整 `pnpm run test` / `pnpm run verify`：按要求不重复全量；由工作流的统一最终门禁执行。
- **README 的实际测试计数未在本轮更新**：`check:docs` 只接受完整 Vitest 报告（并拒绝 failed/pending/partial report），计划要求由最终文档步骤用唯一一次全量报告同步。本报告中的 `329` / `344` / `176` 是分组回归计数，**不得**填入 README 的 total/unit/e2e 行。
- 完整 `pnpm run check:docs`：根目录没有完整报告时它会主动启动全量 Vitest；本次只跑 `--docs-only`（79/79）。
- `pnpm run check:encoding`：它读取**已提交的 blob**，未提交的新文件不在其视野；本次对新文件做了字节级 LF/无 BOM 检查。
- `pnpm run attest:verify` / `check:clean-tree`：工作树是故意未提交的，二者不可在本地作为通过证据。
- **所有需要真实宿主/真实模型的阶段**（见 §5）。

---

## 2. 逐项实现

### A1 / A1-b：补丁正文进入探针

**实现**

- 新增 `src/dsh-bridge/patch-prompt.ts`：
  - `TEXT_PROBE_EVALUABLE`（`:59`）= `system_prompt, guardrails, memory, tool_guidance, skills`；
  - `renderPatchSections` 按 A1 表渲染 append/replace、guardrails（formatContract/appendRules/forbiddenActions/toolPreconditions）、memory（workingNotes/recallTags）、tool_guidance（descriptions/priority/examples）、skills（每 skill 一段）；
  - `scripts / subagents / plugins` **只追加一行** `not evaluable in a text probe: ...`，**绝不渲染正文**；
  - `appendPatchSections` 把补丁段插在 `header(system)` 之后、task(user) 之前；空补丁返回原数组引用。
- 生产装配：
  - `src/dsh-bridge/branch.ts:288`：无宿主 `buildMessages` 时使用 `patchAwareBranchMessages(context)`；宿主显式 builder **完全优先**，不会被二次追加；
  - `src/dsh-bridge/agent-loop-executor.ts:835`：无宿主 builder 时使用 `appendPatchSections(defaultAgentProbeMessages(context), context)`；`defaultAgentProbeMessages` 本身未改。
- 刻意**没有**在 `src/index.ts` 再传 `branch.buildMessages`：那会双重渲染并把 M5 变绿变成风险；生产 resolver 使用 branch 默认 builder 是单一接线点。

**测试**

- `tests/unit/dsh-bridge/patch-prompt.test.ts`：17 tests（常量、逐面渲染、不可评估面正文缺席、空补丁与 `defaultBranchMessages` 相等、前缀稳定、replace、候选含 marker/reference 不含）。
- `tests/unit/dsh-bridge/agent-loop-patch-prompt.test.ts`：6 tests（planner / single_call 两模式均含 `system_prompt` / `guardrails` marker；显式 builder/systemPrompt 优先）。
- 本会话回归：上述两文件均通过（17 + 6）。

### A2：永久门从 `no_probe` 假绿修复

**实现**

- `tests/e2e/fixtures.ts:208` 新增 `decodeContent`：字符串原样；块数组按 `.text` 拼接；null/undefined → `''`。
- `tests/e2e/fixtures.ts:262` 新增可复用 `createPatchAwareHostLlm`。
- `tests/e2e/host-mount-smoke.test.ts`：改为解码块并断言 `outcome !== 'no_probe'`、`probesRun > 1`、候选探针含补丁 marker、reference 不含。
- `tests/unit/meta/fake-llm-content-decoding.test.ts`：扫描 `tests/**` 同时含 `stream:` 与 `messages.map(message.content)` 的 fake，未包 `decodeContent` 即失败（host-neutral ModelRequest fake 在 allowlist）。

**测试**

- `host-mount-smoke` 1 test；本会话通过。
- 本会话运行：`tests/unit/meta/fake-llm-content-decoding.test.ts` 6 tests 通过（正/负控制 + host-neutral ModelRequest allowlist）。

### A3 / B9：表面可评估矩阵 + 限定 proposer + 纯不可评估补丁跳过

**实现**

- 新增 `src/runtime/surface-evaluability.ts`：
  - `SURFACE_EVALUABILITY`（`:104`）8 行，顺序等于 `HARNESS_COMPONENT_KEYS`；文本列**复用** `TEXT_PROBE_EVALUABLE`（`:53` re-export），不声明第二份；
  - `evaluableSurfaceKeys(mode)`（`:215`）、`effectiveProbeSurfaces(enabled, mode)`（`:232`）、`assessPatchEvaluability` / `isPatchEvaluable`（`:297`）；
  - 空 patch、未知 key、disabled 的可评估面、纯不可评估面全部 fail-closed 为不可评估。
- `src/orchestrator.ts`：
  - `probeSurfaces()`（`:2240`）= `config.enabledSurfaces ∩ TEXT_PROBE_EVALUABLE`；
  - run 开始若交集为空：诊断 `probe surfaces: enabledSurfaces=[...] contains no text-probe evaluable surface (...); the run was skipped...`（`:1332`），`stopReason=no_evaluable_surfaces`，**不消耗 reference 探针**；
  - 单候选 proposer 与 K 候选 `selectProposal` 都只传该交集（`:1610` / `selectProposal`）；
  - 在 `proposed` 生成后、`tree.addNode` 前调用 `assessPatchEvaluability`（`:1642`）；不可评估则推 `proposal-not-evaluable:`（`:1648`）并 `continue`：**不建节点、不跑候选、不写回、保留 reference**；
  - 全部跳过且无候选时 `stopReason=proposals_not_evaluable`（`:1905`），而不是笼统的 `no_candidates`。
- 语义边界：`enabledSurfaces` 仍是 seam manager 的完整挂载列表；A3 只限制 **proposer 可提案的探针面**，不阻止既有已保存补丁在其他路径的挂载。

**测试**

- `tests/unit/runtime/surface-evaluability.test.ts`：14 tests（8 面矩阵、5 面交集、纯 scripts/subagents/plugins 为空、空 patch/未知 key/disabled 面、混合 patch、顺序、blindspot）。
- `tests/unit/orchestrator/p3-proposal-select.test.ts` 新增 4 tests：
  - `passes enabledSurfaces ∩ TEXT_PROBE_EVALUABLE to the single proposer`；
  - `passes the same intersection to the K-candidate proposer`；
  - `skips the whole run when enabledSurfaces has no text-probe evaluable surface`（`outcome=skipped`、`probesRun=0`、`stopReason=no_evaluable_surfaces`、无 proposer 调用、store 为空）；
  - `skips a scripts-only proposal before node creation, probing or write-back`（断言 `probesRun=1`、零候选、tree 只有 reference root、store 为空、`stopReason=proposals_not_evaluable`、诊断前缀）。
- 本会话：surface 14 + p3 新增 4 均通过；p3 全文件 23 tests 通过。

### A4-1：`jitrl.writebackGate` 默认 auto（只审计、不学习）

**实现**

- `src/config.ts`：`jitrl.writebackGate: 'auto' | 'on' | 'off'`，默认 `auto`；`JITRL_KEYS` / `validateJitRlGroup` 纳入校验（严格 enum）。
- 新增 `src/runtime/writeback-policy.ts`：`hasTrustedVerifierSeam`（enabled + runner.trustedProducers 非空）、`resolveWritebackGate`：
  - `auto`：无 trusted verifier → on；有 → off；
  - `on` / `off`：显式，独立于 verifier 存在。
- `src/index.ts`：只用**有效** `deps.verification` 计算 `hasTrustedVerifier`；把解析结果写在 `...options.deps` **之前**，显式 `deps.writebackGate` 仍覆盖；推送 `jitrl write-back gate:` 诊断（区分 auto 与显式 seam）。
- README Configuration reference 已含 `jitrl.writebackGate` 行（本会话 `--docs-only` 79/79 通过）。

**测试**

- `tests/unit/runtime/writeback-policy.test.ts`：6 tests（auto×verifier 矩阵、空 producer = conservative-degraded、显式 on/off 独立性）。
- `tests/e2e/signal-propagation.test.ts` H9：无 verifier 默认 `admittedToL2=0`、`auditedOnly=judged`、物理审计记录 N 条仍持久化（不是 `appended 0`）、`auto -> on` 诊断；显式 `on` 在 trusted verifier 下仍 on。
- 本会话两者通过。

### A4-2：Dream 的 verified-only-selection + 最小 12 棵 verified trees

**实现**

- `src/dream-rsi/surrogate-evidence-policy.ts`：`verificationFromTrajectory` + `hasTrustedVerificationProvenance` + deliverable contentHash 绑定；`scoreWithEvidencePolicy` 增加可选 `trustedProducers`；生产始终用 trusted 读取器（空集显式传入）；冻结绝对权重、零重分配。
- `src/orchestrator.ts`：两个 scorer 位置计算 `dreamEvidence {verdict,trusted,dreamScore,strategy,verifierId?,evidenceHash?}` 写入 node.metadata（final update 合并 metadata）；`verifierId`/`evidenceHash` 只在 trusted verification 存在时写入，`node.score` 保持冻结的在线 surrogate。
- 新增 `src/dream-rsi/verified-tree-gate.ts`：`MIN_VERIFIED_TREES_FOR_DREAM=12`（`:54`）、`isVerifiedTree`（所有**已评分**节点必须 trusted + passed/failed + 非空 producer id/evidence hash）、`countVerifiedTrees`、`assessDreamReadiness`（`:151`）。
- `src/orchestrator.ts` `runDream`：低于 12 时推 `offline dream skipped: ...` 并 return null；达到时只把 verified trees 交给 dreamer。生产 index 传 12；手建 deps 默认 0（仅测试/机制保留）。
- `src/dream-rsi/offline-dreamer.ts` `replayNodeScore` 优先 `dreamScore`。

**测试**

- `tests/unit/dream-rsi/surrogate-evidence-policy.test.ts`：22 tests（冲突夹具 PASS>FAIL、NC-2、无 verifier skip、self-declared 无效）。
- `tests/unit/dream-rsi/verified-tree-gate.test.ts`：10 tests（12 门槛、混合树排除、0 = 历史机制）。
- `tests/unit/dream-rsi/offline-dreamer.test.ts`：45 tests（replay 优先 dreamScore 等）。
- `tests/e2e/offline-dream.test.ts`：6 tests（含默认 12 门槛负测）。
- 本会话全部通过；无 verifier 时 Dream 不运行，这是正确行为，不是失败。

### A4-3：主链 not-evaluable（0 + 标记、不是失败）

**实现**

- `src/jitrl/text-probe-evaluation.ts:222` `classifyProbeEvaluability`：
  - trusted passed/failed 或 structural implicit failed → `evaluated`；
  - `producedFiles > 0` 且无 trusted → `not-evaluable / no-trusted-verifier`；
  - 纯文本无 trusted → `text-only-deliverables` / `no-executable-deliverable`。
- `src/orchestrator.ts` `recordOnlineExperience`：not-evaluable 时 `reward/observedReturn/learningTarget=0`、`learningEligible=false`、`rewardSources.notEvaluable=1` + 数值原因码；`outcome` **不改成 failed**；`notEvaluable` 独立计数；`notTaskQuality` 只计 C2-pre。
- 既有 `evaluateTextProbe` handle 语义保持不变（纯文本恒 not-evaluable、reward 字面量 0）。

**测试**

- `tests/unit/jitrl/text-probe-evaluation.test.ts`：13 tests（reason codes append-only、main-chain 分类矩阵）。
- `tests/unit/orchestrator/credit-attribution.test.ts`：30 tests（无 verifier 的 `learningEligible=false` 审计语义 + trusted 对照；notEvaluable 不混入失败/0 分平均）。
- `tests/e2e/signal-propagation.test.ts` H6：trusted PASS/FAIL reward 不同；无 verifier 时 `notEvaluable=1` 且不学习。
- 本会话全部通过。

### A4-4：对称的 LLM 步骤评审

**实现**

- `src/jitrl/step-evaluator.ts:1034`：`judgePolicy` 新增 `'cost-gated' | 'all'`（默认 `cost-gated` 保兼容）；`all` 模式只看 `reward.llmEvaluator` + model，不再看 `selected/composed/steps≥3/Δsurrogate`。
- `src/jitrl/index.ts` 透传；`src/index.ts` 生产 kernel 传 `all`。
- `src/orchestrator.ts` `recordOnlineExperience`：对 `ordered` 中**每个已执行探针**调用 `evaluator.evaluate`，各自 judge 均值写入该条 `rewardSources.stepJudge`；winner/非 winner/审计记录都带自己的；主 reward 仍 `scoreUnderRewardContract`；运行中 `/evo jit off` 仍丢弃整批。
- 缺失/失败/空 judge 只降级该探针，不删除样本、不改 `rewardVersion` 语义。

**测试**

- `tests/unit/jitrl/step-evaluator.test.ts`：38 tests（含 judge policy 门）。
- `tests/e2e/judge-symmetry.test.ts`：3 tests（生产装配下未选中一步探针也被评审；orchestrator 调用数 = 已执行探针数；per-probe stepJudge 不同；`llmEvaluator=false` 时 0 调用；ctx.llm-only 装配的 judge 使用该 model）。
- `tests/unit/orchestrator/p3-proposal-select.test.ts` / `credit-attribution.test.ts` 的对称断言通过。
- 本会话全部通过。

### A4-5：生产验证 seam（不是 worktree runner）

**实现**

- 生产入口只认宿主注入的 `deps.verification`；`src/index.ts` 诊断：
  - 无 seam → `c2a verification: no host runner injected; verdicts stay structural/shape-only (C2-pre conservative default)`；
  - 有 seam 且 `trustedProducers` 非空 → `host-owned runner ... active ...; verdicts are registry-authenticated, not shape-only`；
  - 有 seam 但 producer 集为空 → `active but conservative-degraded: trustedProducers is EMPTY ...`（`src/index.ts:2429`）。
- 现有 `verifyAndAttach` 保证：registry 身份 + binding + 宿主重算 digest；自声明 payload 在有 seam 时被替换/剥离。`host-runner` 自己构造非空 `trustedProducers`（`{verifierId}`，`src/verification/host-runner.ts:119`），但 `HostVerificationRunner` 接口允许宿主传入空集（`src/verification/types.ts:179-188`）；producer 集的 consumer-trust 判定发生在 `accumulateVerificationSummary`（`src/verification/attach.ts:688-702`）——attached 且 non-audit-only 的 verifierId 命中集合才算 trusted，否则 audit-only；生产总是传入集合（即使为空）；对应 e2e 在 `tests/e2e/verification-seam-production.test.ts:268-287,331-347`。**没有 seam 时**轨迹原样返回，公开 `verification.status` 仍可能是 `passed`（那是 payload 的声明），但 `trustedSource=false`、不是 task-quality evidence、A4-3 判 not-evaluable；不能写成“永不提升为 passed”，正确的口径是“永不 consumer-trusted / 永不 task-quality”。本次**没有**新增 worktree/只读工具 allowlist runner——仓库无实现、宿主无注入点（见 §6）。agent-loop 的只读 allowlist 仍由既有的 `src/dsh-bridge/probe-safety.ts` / `AgentLoopAdapters.safety` gate 承担，本轮未改写；不存在“临时 worktree”实现。
- README / runbook 写明 runner 由宿主提供。

**测试**

- 新增 `tests/e2e/verification-seam-production.test.ts`：5 tests：
  1. PASS/FAIL 工件 → `lastVerificationViews()` 的 `status ∈ {passed, failed}`、`attached/authenticated=true`、digest 为 `sha256:<64 hex>`；online 记录 `verificationTrusted=1` 且 PASS reward > FAIL reward；
  2. 空 producer runner → `conservative-degraded` 诊断，且不出现“registry-authenticated”；
  3. 空 producer runner → run summary `trusted=0` / audit-only，持久化 marks 也不是 trusted；
  4. 自声明 passed + 宿主 check 失败的工件 → 宿主 receipt 为 **failed**，`metadata.verification` 被替换，score 为 trusted failed，falsified-success 不被消费；
  5. 无 seam 的自声明 passed → `trustedSource=false`、`taskQualityEvidence=false`、not-evaluable（text-only），形状声明不构成信任。
- 本会话 5 tests 通过。

### A5：branch-scoped hook mount 诊断

**证据边界**

- 唯一宿主观测是 `docs/reports/host-smoke-rc3.md`（全部 host hook dispatch 的 `branchId=0`）；rc4/rc5 的真实宿主行为**未测量**，不能把 rc3 的结论写成 rc.5 的既成事实。诊断只在实际观测到 `dsh-hooks` dispatch 时产生，不是版本常量。

**实现**

- 新增 `src/cordis-seams/host-mount-diagnostics.ts`：精确文本 `branch-scoped hook mount: unavailable (host dispatch carries no branchId)`（`:35`），仅当 `hostAdapterSource='dsh-hooks'`、观测到 `applied+delegated>0`、且 `branchProofApplied=0`；返回计数 + summary。
- `src/index.ts` 在 run 后只报告一次；不改探针路径、不改挂载决策。

**测试**

- `tests/unit/cordis-seams/branch-mount-diagnostics.test.ts`：5 tests（helper 矩阵、非 dsh-hooks、无 dispatch、branch proof 存在）。
- `tests/e2e/hook-branch-identity-diagnostic.test.ts`：2 tests（shadow 下 `activePatchIds()` 为空 + 精确文本；guarded-active permanent mount 仍 host-class + grant）。
- 本会话通过。

### A6：跨模块契约测试

**实现/测试**

- `tests/e2e/signal-propagation.test.ts` 现为 9 tests（7 个 H 跳 + 2 个 A3 用例）：
  - A3 真实 proposer 的 scripts-only 响应 → `stopReason=proposals_not_evaluable`、`probesRun=1`；空 guardrails/memory payload 在候选探针前被拒、reference 保留；
  - H3 候选探针含 `PATCH_PROMPT_PREFIX` + marker；reference 不含；header→patch→task 顺序；
  - H4 marker 驱动 fake 使候选交付物 ≠ reference；
  - H6 trusted PASS/FAIL reward 不同；无 verifier 则 not-evaluable 且不学习；
  - H6' judge 对称（生产装配）；
  - H8 冲突夹具：Composer 选中的 FAIL 在 `node.score` 更高，但 trusted PASS 的 `dreamScore` 更高（冻结在线分数不动）；
  - H9 默认 auto 无 verifier：`admittedToL2=0`、`auditedOnly=N`、物理审计记录 N；
  - H12 传入 ledger 时，探针调用产生 reserve/settle，且计数 = `probesRun`。本用例通过 `resolveDshCollaborators(..., { branch: { metering } })` 构造带计量的同进程 executor，再以 `deps.runBranch` 注入完整 plugin run；它证明的是 resolver seam + 探针计量一致性，不是 `src/index.ts` 内部的 `branch.metering` 自动传递（后者由 `branch-metering` 单测第 3 条与代码读取确认）。
- 所有 fake 使用 `decodeContent` 或 host-neutral ModelRequest 适配器；meta 解码门仍为零违规。
- 本会话 9 tests 通过。

### B8 / H12：探针计量

**实现**

- `src/index.ts` 从宿主已有的 `options.agentLoop.ledgerSettlement` 构造 `hostProbeMetering`，并通过 `resolveDshCollaborators(..., { branch: { metering: hostProbeMetering } })` 传给同进程执行器；**不新建第二个 manager**。
- 三种可达形态与诊断（本轮修复了此前“互斥条件导致接线不可达 + 诊断误导”的缺陷）：
  1. `agentLoop.model` 存在 → agent-loop executor 跑探针并用同一 settlement；诊断 `agent-loop probe executor uses ...`；
  2. 只有 `agentLoop.ledgerSettlement`（无 model）→ 不再构造无 model 的 agent executor；DSH-resolved 同进程执行器接管并通过 `branch.metering` 使用 settlement；诊断 `DSH-resolved same-process probe executor shares ...`；
  3. 显式 `runBranch` / `deps.runBranch` → settlement 只到 JitRL stages，诊断明确说 caller-supplied executor is authoritative。
- 剩余结构性限制：公开 26-key options 仍无独立 settlement seam；完全没有 `agentLoop` 的装配里同进程探针保持 unmetered。

**测试**

- `tests/unit/integration/branch-metering.test.ts`：4 tests，含 production-run 用例：ledger-only agentLoop + 真实 plugin.run，`reserveAttempts = settleCount = probesRun`，identity 全 settled；
- `tests/e2e/signal-propagation.test.ts` H12：完整 plugin run 的 resolver seam 计量一致性；
- `tests/unit/ledger/metered-model-adapter.test.ts`：unmetered `reservedMicros=0`、observe 模式 `reservedMicros=0`（不再把 10_000 估算写成已预留）。
- 本会话全部通过。

### B9：不可评估面的预算与信任边界

- A3 矩阵明确 `scripts/subagents/plugins` 在任何探针模式都不可评估、DSH 推荐 `off`；proposer 不再看到它们；纯这类补丁不跑候选、不写回。
- A4-5 保证 `scripts` 生成的代码**不执行**、自声明验证不提升；宿主 hook 的守护栏执行范围仍是显式 deny 子集（README Limitations 已记录）。
- 本会话通过矩阵/跳过测试；没有把“不执行生成代码”伪装成“已验证”。

---

## 3. 验证记录（按命令）

### 3.1 类型与测试

> 以下是前序施工会话的分组运行记录；分组文件清单未保存，除 e2e 行外本轮未重跑。最终权威完整计数见 §10.3。

```text
npx --no-install tsc --noEmit
→ exit 0（无输出）

npx --no-install vitest run <A1–A6 19 files>
→ Test Files 19 passed (19); Tests 329 passed (329)

npx --no-install vitest run <A3/A4-5/B8/H12 5 files>
→ Test Files 5 passed (5); Tests 49 passed (49)

npx --no-install vitest run tests/unit/orchestrator tests/unit/integration
→ Test Files 18 passed (18); Tests 176 passed (176)

npx --no-install vitest run tests/e2e
→ Test Files 29 passed (29); Tests 348 passed (348)
```

### 3.2 结构门禁

```text
node scripts/eval/check-orphan-exports.mjs
→ OK: 111 source file(s), 40 orphan(s) all allow-listed (40).

node scripts/eval/check-test-import-coverage.mjs
→ OK: 111/111 src module(s) imported by a test (0 allow-listed).

node scripts/eval/metering-coverage.mjs
→ OK: 111 file(s) scanned, 4 allow-listed model call(s), 0 unmetered call(s).

node scripts/verify-readme-counts.mjs --docs-only
→ 79 documented row(s) vs 79 expected default leaf path(s); SUCCESS.

node scripts/eval/smoke-build.mjs
→ SUCCESS; lib/index.js 1,303,885 bytes; stale: false; 74 named exports.

node scripts/eval/negative-result-diag.mjs --assert
→ A1..A6 PASS - the historical negative result is intact; exit 0.

node scripts/eval/guarded-regression.mjs --json
→ exit 0.

node scripts/eval/mutation-gate.mjs --validate
→ anchors: all 5 mutants resolve against pristine sources.

node scripts/eval/mutation-gate.mjs --run --only M5
→ [M5] KILLED baseline=ok(10 tests) sha changed red=2/2 must-red hit;
  worktree zero-residue: OK; copy removed: true; verdict: PASS.
```

### 3.3 编码/空白

- `git diff --check` exit 0；只有既有 tracked 文件的 CRLF→LF 提示。
- 新文件字节检查：`src/runtime/surface-evaluability.ts`、`tests/unit/runtime/surface-evaluability.test.ts`、`tests/unit/integration/branch-metering.test.ts`、`tests/e2e/verification-seam-production.test.ts`、`docs/runbooks/rev7-safe-learning-operations.md` 均为 LF、无 BOM。

---

## 4. 接口与兼容性

- **公共 options 仍是 26 个 key**；本报告没有新增公共 option。A3/A4-1/A4-5 都没有 config 字段授予 publish/memory/patch/trusted verifier。
- `defaultBranchMessages` / `defaultAgentProbeMessages` 保留；空补丁时输出逐字节相等；宿主显式 `buildMessages` / `systemPrompt` 仍优先。
- `REWARD_CONTRACT_VERSION='r4/verifier-first-v1'`、权重 `{completion:0.5,steps:0.1,tool:0.1,turn:0.3}`、聚合与 `scoreUnderRewardContract` 语义未改。
- A4-2 不改 `node.score` 或在线 active-policy 选择；只改 Dream 的输入与 replay 分数来源。
- A4-4 只增加对称辅助 judge；主 reward 仍由 `scoreUnderRewardContract` 决定；M3（primary-target 相等）必须变红——审读修复轮已用 `node scripts/eval/mutation-gate.mjs --run` 验证为 KILLED（baseline=ok(30 tests)、red=2/2，见 §10.5）。
- not-evaluable 的持久化形状：`rewardSources.notEvaluable=1` + 数值原因码；`ExperienceRecord.reward` 仍为有限数（0）；`learningEligible=false`、`learningTarget=0`。
- B8 只共享宿主已有 settlement；不创建第二个 manager。

---

## 5. 未执行的外部阶段（不计入通过）

| 阶段 | 需要的授权/条件 | 状态 |
| :--- | :--- | :--- |
| rc4 真实宿主 smoke | `HOSTSMOKE_AUTHORIZED=1` + 已安装 DSH 的真实 apply 上下文 | **not-run** |
| 真实 cacheRead 测量 | 宿主/真实模型；现有 rev6 观察全为估算且 cacheRead=0 | **not-run** |
| R3A 真实收益 canary | `R3A_ADAPTER_MJS` / `R3A_CREDENTIAL_FILE` / `R3A_MODEL_SEAM` / `R3A_AUTHORIZED_BY` / 预算 / 只读工具 | **not-run** |
| 四臂消融 + 写回门 on/off | 预注册 m=12，π*=0.8693 | **not-run** |
| guarded-active + `applyWinningPatch` 灰度 | P2-b 正结果 + 宿主 branch/fork API | **not-run** |
| worktree / 只读工具 allowlist 验证 runner | 仓库无实现、宿主无注入点 | **未实现；A4-5 只验证既有 `deps.verification` seam** |
| 完整 `pnpm run test` / 完整 `check:docs` / `attest:verify` | 工作流统一最终门禁 | **not-run（本报告不猜计数）** |

---

## 6. 非声称

- 不声称“自进化有收益”；不声称 −0.250 已被修复或确认。
- 不声称真实 DSH 上候选探针一定带补丁段（A1 的本地 e2e 只证明生产 resolver 路径；真实宿主需 rc4）。
- 不声称 branch-scoped hook mount 可用；唯一宿主观测是 rc3 的 `branchId=0`，rc4/rc5 未测量。
- 不声称所有真实宿主探针都已被预算约束：ledger-only agentLoop 已由 production-run 用例证明，但完全没有 `agentLoop` 的装配仍是 unmetered（B8 的剩余结构限制）。
- 不声称 cacheRead 非零或 Tail Injection 可启用。
- 不声称 A4-5 有 worktree runner；它只有宿主 runner seam。
- 不声称 12 棵 verified trees 的门槛在真实运行中会被满足；首次运行通常是 `offline dream skipped`。
- 不把 `outcome=no_probe` 当成功；A3 的 `proposals_not_evaluable` 有独立诊断解释。

---

## 7. 残余风险

1. **在线 active-policy 仍使用冻结的 surrogate 分数**（自指项仍在）；A4-2 只把 Dream replay 换成 `dreamScore`，不改变在线选择。这是本轮明确保留的残余风险，需由 P2-b 消融判别。
2. **B8 剩余结构限制**：公开 26-key options 没有独立 settlement seam；只有 `agentLoop.ledgerSettlement` 可作为 settlement 来源。ledger-only agentLoop 已走 resolved 同进程 executor 并计量；完全没有 `agentLoop` 的装配里探针仍 unmetered。
3. **A5 宿主约束**：rc3 观测到 host hook dispatch 无 `branchId`；rc4/rc5 未测量，不能外推。在宿主提供 branch/fork API 前，branch-scoped hook mount 仅在 rc3 上被观测为不可用。
4. **A4-5 无 worktree runner**：可信 verdict 只能在宿主自己注入 `deps.verification.runner` 时产生；本地没有真实 runner 可测“可执行交付物”的比例。
5. **真实宿主/收益证据缺失**：rc4 smoke、cacheRead、R3A、消融、guarded-active 全部 not-run；任何真实收益结论必须等这些阶段。
6. **未提交工作树**：`attest:verify` / `check:clean-tree` 不可作为通过证据；本报告绑定的是 `fa1f211` 基线之上的未提交内容。

---

## 8. 本次涉及的文件

新增：

- `src/runtime/surface-evaluability.ts`
- `tests/unit/runtime/surface-evaluability.test.ts`
- `tests/unit/integration/branch-metering.test.ts`
- `tests/e2e/verification-seam-production.test.ts`
- `docs/runbooks/rev7-safe-learning-operations.md`
- `docs/reports/rev6-implementation-closeout.md`（本文件）

修改（本轮）：

- `src/orchestrator.ts`（A3：probeSurfaces / 空交集跳过 / 不可评估提案跳过 / stopReason；既有 A4 逻辑未改语义）
- `src/index.ts`（B8 branch metering 装配 + 诊断；A4-5 conservative-degraded 诊断）
- `tests/unit/orchestrator/p3-proposal-select.test.ts`（A3 proposer 5 面 + scripts-only 跳过）
- `tests/e2e/signal-propagation.test.ts`（H12 ledger 计量）

前序施工者已在同一工作树实现（本报告读取/回归确认，未重复改动）：

- A1/A1-b：`src/dsh-bridge/patch-prompt.ts`、`branch.ts`、`agent-loop-executor.ts` 及对应单测；
- A2：`tests/e2e/fixtures.ts`、`host-mount-smoke`、meta 解码门；
- A4-1/2/3/4、A5：`src/config.ts`、`src/runtime/writeback-policy.ts`、`src/jitrl/text-probe-evaluation.ts`、`src/jitrl/step-evaluator.ts`、`src/dream-rsi/surrogate-evidence-policy.ts`、`src/dream-rsi/verified-tree-gate.ts`、`src/dream-rsi/offline-dreamer.ts`、`src/cordis-seams/host-mount-diagnostics.ts` 及对应测试。
---

## 9. rev6 独立审查修复波（2026-11-05）

本轮以三份独立审查（探针链路 / 学习安全 / 计量与交付）的 23 项发现为输入：22 项 `verified` 全部处理，1 项 `unconfirmed` 亲自复核后判定不可复现并记录理由。没有删除、跳过或放宽既有测试来换取绿色；所有行为变化都伴随新的正向/负向断言。

### 9.1 探针链路

| # | 严重度 | 发现 | 本轮处理 | 证据 |
| :--- | :--- | :--- | :--- | :--- |
| P-1 | high | A3 只看 edit key，A1 按内容渲染；`guardrails:{appendRules:[]}`、`memory:{scopedViewId}` 被计为 evaluable 但渲染 0 段 | `assessPatchEvaluability` 复用 `renderPatchEdits` 的 `renderedSurfaces`（content-level）；新增 reason code `notRenderable=3`；proposer 的 `validateGuardrails` / `validateMemorySurface` 拒绝无正文 payload；`stripExternalMemoryChannels` 不再把只有 scopedViewId 的 memory 当作保留内容 | `src/dsh-bridge/patch-prompt.ts`、`src/runtime/surface-evaluability.ts`、`src/harness2/proposer.ts`；`tests/unit/dsh-bridge/patch-prompt.test.ts`（17）、`tests/unit/runtime/surface-evaluability.test.ts`（14）、`tests/unit/harness2/proposer.test.ts`（20） |
| P-2 | medium | proposer 提示词无条件列出 8 面与三面 payload 契约 | `renderProposalPrompts` 以 `allowedSurfacesFor(request)` 过滤 legend 和 payload contract；测试断言 scripts/subagents/plugins 的契约行不存在 | `src/harness2/proposer.ts`；`tests/unit/harness2/proposer.test.ts` `filters the surface legend AND payload contracts` |
| P-3 | medium | 真实 proposer 对 scripts-only 抛 `proposal_no_valid_edits`，orchestrator 记 `no_candidates` 而不是 A3 skip | `Harness2ProposalError` 新增 `notEvaluable` / `droppedSurfaces`（仅在“全部是已知但被禁用面且无其他坏 edit”时为真）；orchestrator catch 映射为 `proposal-not-evaluable:` 并计入 `proposals_not_evaluable` | `src/harness2/proposer.ts`、`src/orchestrator.ts`；`tests/e2e/signal-propagation.test.ts` 真实 proposer e2e（`stopReason=proposals_not_evaluable`，`probesRun=1`） |
| P-4 | medium | meta 解码门扫描根是 `tests/unit`，从未扫 `tests/e2e`；且多行/for...of/解构漏报 | `TESTS_ROOT = tests/`、`REPO_ROOT` 固定；按“enclosing complete + receiver: ModelRequest”形状豁免 host-neutral fake；新增多行、`for...of`、解构正控与 `tests/e2e` 实际扫描断言 | `tests/unit/meta/fake-llm-content-decoding.test.ts`（9 tests） |
| P-5 | medium | `probePrompts: string[]` 无 branch 身份，内容二分可被“部分候选丢补丁”假绿 | `PatchAwareHostLlm` 新增 `probeDispatches`（prompt + `branch:`）；host-mount、signal-propagation、patch-prompt e2e 改为断言恰好 1 条 `reference-`、候选全带补丁、reference 全不带 | `tests/e2e/fixtures.ts`、`tests/e2e/host-mount-smoke.test.ts`、`tests/e2e/signal-propagation.test.ts`、`tests/unit/dsh-bridge/patch-prompt.test.ts` |
| P-6 | low | “prefix-stable”只是同一 context 内稳定，header 跨分支不同 | 源注释改为“同一 context 内 byte-identical；header 每请求不同，不声称跨请求缓存收益”；测试改名并新增两 context 断言 | `src/dsh-bridge/patch-prompt.ts`、`tests/unit/dsh-bridge/patch-prompt.test.ts` |

### 9.2 学习安全

| # | 严重度 | 发现 | 本轮处理 | 证据 |
| :--- | :--- | :--- | :--- | :--- |
| L-1 | high | guarded-active 永久挂载没有可信 verdict 门，文档却称 evidence-gated | 采用审查允许的“诚实标注”分支：`execution-profile` 注释/权限 reason、profile 诊断、mount 诊断都改为 **explicit opt-in / NO host-trusted verdict gate is applied**；runbook、README、rollout 同步（rollout §10.4 明确 L2 replacement gate 只是选择阶段门，不是永久挂载的 verdict 门）；e2e 在无 verification 的 guarded-active 下钉住这一行为 | `src/runtime/execution-profile.ts`、`src/index.ts`、`src/orchestrator.ts`、`tests/e2e/hook-branch-identity-diagnostic.test.ts` |
| L-2 | medium | ctx.llm-only 装配下 step judge model 为 undefined，judge 永不调用 | 在 `buildJitRlWiring` 之前构造 `forwardingModel(holder, ...)` 并作为 `model` 传入 kernel；新增 ctx.llm-only e2e 断言 judge 调用数 = executed candidate probes | `src/index.ts`、`tests/e2e/judge-symmetry.test.ts`（3 tests） |
| L-3 | medium | A4-1 验收写 appended=0，实现物理 append 审计记录 | README/runbook 统一为 `admittedToL2=0` / `auditedOnly=N` / physical append=N；H9 继续断言物理记录存在且不是 appended 0；closeout 同步 | `README.md`、`docs/runbooks/rev7-safe-learning-operations.md`、本报告 |
| L-4 | medium | `writebackGate:off` 被写成 historical ungated path，但 A4-3 veto 仍生效 | `src/runtime/writeback-policy.ts` 注释、`off` reason、README 配置行改为“只关 G-A/G-B；A4-3 仍生效；完整历史路径需 offline eval 的 legacy seam” | `src/runtime/writeback-policy.ts`、`README.md`、`tests/unit/runtime/writeback-policy.test.ts` |
| L-5 | medium | verified-tree 只看 `trusted:true`，无 verifierId/evidenceHash，strategy 未 pin，JSONL 可伪造 | `DreamEvidence` 新增**可选** `verifierId`/`evidenceHash`（无 trusted verification 的节点省略这两个字段）；`dreamEvidenceOf` pin `DREAM_EVIDENCE_STRATEGY` 并拒绝“存在但为空”的 identity/hash；真正的门槛在 `nodeIsVerified`（`isVerifiedTree` 的判定）：trusted + concrete verdict + 非空 identity/hash + producer 集命中；`isVerifiedTree`/`assessDreamReadiness` 接受 producer 集并在生产 runDream 传入；模块注释明确“tree pool 是 local-trusted、无签名”，删除“signed/bound”强措辞；单元测试加伪造拒绝 | `src/dream-rsi/verified-tree-gate.ts`、`src/orchestrator.ts`、`tests/unit/dream-rsi/verified-tree-gate.test.ts`（10）、`tests/e2e/offline-dream.test.ts` |
| L-6 | low | “not-evaluable 不是 0 分”与持久化 reward=0 自相矛盾 | 文案统一为“0 + `rewardSources.notEvaluable=1` + `learningEligible=false`”；不改变记录契约（reward/return 仍是有限数） | 本报告、README/runbook |
| L-7 | low | strategy B 用 `DEFAULT_SURROGATE_WEIGHTS`，host 自定义 `dreamRsi.surrogateWeights` 被静默忽略 | strategy B 的 base 改为 `normalizeSurrogateWeights(request.weights, options.defaultWeights ?? DEFAULT)`；新增自定义权重测试（PASS delta=0、unknown 只保留证据项） | `src/dream-rsi/surrogate-evidence-policy.ts`、`tests/unit/dream-rsi/surrogate-evidence-policy.test.ts`（22） |
| L-8 | low | hostAdvisor 开启时 host-tool 记录绕过 writebackGate，无 learningEligible=false | 采用审查允许的“显式豁免 + 文档”分支：collector 注释、README、runbook 明确 L3 是 host process 轨道、`writebackGate` 只裁决 probe 记录、默认 `hostAdvisor.enabled=false`；未改 L3 既有契约测试 | `src/jitrl/host-tool-experience.ts`、`README.md`、`docs/runbooks/rev7-safe-learning-operations.md` |
| L-9 | low | `dreamMinVerifiedTrees:0` 不恢复历史 node.score 评分 | 代码/报告措辞改为“只恢复 full-pool 选择；replay 仍优先 dreamScore”；未改变 `replayNodeScore`（否则会撤销 A4-2） | `src/orchestrator.ts`、`src/dream-rsi/verified-tree-gate.ts` |
| L-10 | low | `assessDreamReadiness` 把 12.5/Infinity/NaN 归一化为 0（fail-open） | 新增 `normalizeVerifiedTreeMinimum`：只有显式 0 禁用；正有限值 `max(1, floor)`；负数/NaN/Infinity 抛 `RangeError`；orchestrator 构造器复用；测试覆盖 12.5/0.5/-3/NaN/Infinity | `src/dream-rsi/verified-tree-gate.ts`、`src/orchestrator.ts`、`tests/unit/dream-rsi/verified-tree-gate.test.ts` |

### 9.3 计量与交付

| # | 严重度 | 发现 | 本轮处理 | 证据 |
| :--- | :--- | :--- | :--- | :--- |
| M-1 | medium | B8 resolver metering 与 agentLoop executor 条件互斥，生产接线不可达；诊断误导 | ledger-only agentLoop 不再构造无 model 的 agent executor；resolved 同进程 executor 接管并收到 settlement；诊断按三种可达形态分别说明；新增 production-run 计量测试（`reserveAttempts=settleCount=probesRun`） | `src/index.ts`、`tests/unit/integration/branch-metering.test.ts`（4）、`tests/e2e/signal-propagation.test.ts` H12 |
| M-2 | medium | 无 ledger 时 `reservedMicros` 仍写 10_000；observe 模式也写估算而非真实预留 | 记录 `decision.reservedCostMicros`（无 reservation 时为 0）；unmetered 与 observe 测试断言 0；enforce 测试保留 >0 的真实预留 | `src/dsh-bridge/metered-model-adapter.ts`、`tests/unit/ledger/metered-model-adapter.test.ts`、`tests/unit/integration/branch-metering.test.ts` |
| M-3 | medium | A4-3 的 `probeEvaluation:'legacy'` 可经公开 `deps` 关闭 | `EvoHarnessPluginOptions.deps` Omit `probeEvaluation`；公共 `createEvoHarnessPlugin` 运行时拒绝；新增显式 `createEvoHarnessPluginForOfflineEvaluation` 供 eval harness；eval lib 迁移；负向测试 | `src/index.ts`、`scripts/eval/jitrl-eval-lib.ts`、`tests/unit/integration/p0-wiring.test.ts` |
| M-4 | medium | 空 producer runner 的 receipt 在 run summary 里被计为 trusted | `accumulateVerificationSummary` 接受 producer 集：生产传入 seam 的集合（可空）；只有 verifierId 在集合内才计 trusted，否则计 auditOnly；新增 production run e2e 断言 `trusted=0` / `audit-only=N` / `verificationTrusted=0` | `src/verification/attach.ts`、`src/orchestrator.ts`、`tests/e2e/verification-seam-production.test.ts`（5） |
| M-5 | medium | “shape-only / self-declared 永不提升为 passed”与无 seam 时 status 仍为 passed 矛盾 | 文档/诊断口径改为“永不 consumer-trusted / 永不 task-quality；公开 status 可仍是声明 passed”；既有 no-seam e2e 继续钉住 `status='passed' + trustedSource=false + not-evaluable` | README、runbook、本报告、`tests/e2e/verification-seam-production.test.ts` |
| M-6 | medium（unconfirmed） | 声称 A4-3 not-evaluable 记录在 gate off 时进入 L2 邻居并影响支持度 | **未复现**：not-evaluable 记录 return=0，`augmentCandidates` 在分组前丢弃 `return<=0`；L2 决策 optimizer 始终应用 `learningFacingFilterOptions`。原始 query 确实会返回该记录（仅诊断计数），但不影响学习。尝试在 trusted 模式恒加 `learningEligibleOnly` 会破坏已 pin 的 gate-off 历史 query 形状，已回退；保留为诊断级残余并记录于此 | `src/jitrl/candidate-augmenter.ts:280`、`src/jitrl/index.ts:767`、`tests/unit/jitrl/writeback-intervention.test.ts` |
| M-7 | low | README 测试计数过期 | 完整 `vitest run` 一次：212 files / 3409 tests（unit 183/3061，e2e 29/348）；README 已同步，`verify-readme-counts` 全绿 | §10.3 |

### 9.4 本轮修复涉及的文件

源码：

- `src/dsh-bridge/patch-prompt.ts`（`renderPatchEdits` / `renderedSurfaces`、prefix 注释）
- `src/runtime/surface-evaluability.ts`（content-level evaluability、`notRenderable=3`）
- `src/harness2/proposer.ts`（空 payload 校验、prompt 过滤、结构化 notEvaluable error）
- `src/orchestrator.ts`（真实 proposer A3 映射、verified-tree producer re-check、mount 诊断、min 归一化）
- `src/index.ts`（A4-4 forwarding model、B8 三形态接线/诊断、offline eval entry、ledger-only 校验）
- `src/dsh-bridge/metered-model-adapter.ts`（`decision.reservedCostMicros`）
- `src/verification/attach.ts`（consumer-trust summary）
- `src/dream-rsi/verified-tree-gate.ts`（provenance/strategy/min 归一化/trust boundary）
- `src/dream-rsi/surrogate-evidence-policy.ts`（effective weights）
- `src/jitrl/host-tool-experience.ts`（L3 process-track 边界注释）
- `src/runtime/writeback-policy.ts`（off 口径）
- `src/runtime/execution-profile.ts`（guarded-active 不再声称 evidence-gated）
- `src/config.ts`（execution 注释同一口径）

测试：

- `tests/unit/dsh-bridge/patch-prompt.test.ts`、`tests/unit/runtime/surface-evaluability.test.ts`、`tests/unit/harness2/proposer.test.ts`
- `tests/unit/meta/fake-llm-content-decoding.test.ts`（扫描根/allowlist/多行/for...of/e2e 控制）
- `tests/e2e/fixtures.ts`、`tests/e2e/host-mount-smoke.test.ts`、`tests/e2e/signal-propagation.test.ts`
- `tests/e2e/judge-symmetry.test.ts`、`tests/e2e/verification-seam-production.test.ts`、`tests/e2e/hook-branch-identity-diagnostic.test.ts`
- `tests/unit/dream-rsi/verified-tree-gate.test.ts`、`tests/unit/dream-rsi/surrogate-evidence-policy.test.ts`、`tests/unit/dream-rsi/offline-dreamer.test.ts`、`tests/unit/dream-rsi/pr4b-holdout.test.ts`、`tests/e2e/offline-dream.test.ts`
- `tests/unit/integration/branch-metering.test.ts`、`tests/unit/integration/p0-wiring.test.ts`
- `tests/unit/ledger/metered-model-adapter.test.ts`、`tests/unit/ledger/jitrl-metering-wiring.test.ts`
- `tests/unit/p62/rev6-release-contract.test.ts`（登记安全更正行，仍拒绝未登记漂移）

脚本 / 文档 / CI：

- `scripts/eval/jitrl-eval-lib.ts`（offline evaluation entry）
- `README.md`、`docs/runbooks/rev7-safe-learning-operations.md`、本报告
- `docs/reports/rev6-dsh-authorized-rollout.md`（两处 guarded-active 前置条件/诊断口径）
- `.github/workflows/ci.yml`（four-mutant → five-mutant 注释）

### 9.5 施工者 remaining 中本轮本地补齐的事项

- README / `.github/workflows/ci.yml` 的 “four-mutant” 改为 five-mutant（mutation gate 现为 5 anchors）。
- 预存在的失败测试 `tests/unit/dream-rsi/pr4b-holdout.test.ts`：该用例测 holdout，不是 verified-tree 门；显式注入 `deps.dreamMinVerifiedTrees:0` 使其只测 holdout 机制（不是放宽断言）。
- `execution-profile.ts` 的 C-4 手术线 pin：保留 144 行与 line 121 的 strict-improvement 文本；release-contract 测试登记了本轮安全更正的额外行（91-94、116），仍拒绝任何未登记漂移。

---

## 10. 本轮实际运行 / 未运行与交接

### 10.1 已运行（本会话）

> 本节是前序施工会话的记录；审读修复轮**没有**重跑下列完整套件，只在 §10.5 重跑了 mutation 门、e2e 套件、点名的 7 个文件与 README 计数校验。

- `npx --no-install tsc --noEmit` → exit 0。
- 定向套件（patch-prompt / surface-evaluability / proposer / meta decoding / host-mount / signal-propagation / judge-symmetry / verification-seam / hook-diagnostic / verified-tree / surrogate / branch-metering / metered-adapter / p0-wiring / pr4b）→ 修复后复跑相关文件全部通过（见 §9 各表）。
- `npx --no-install vitest run tests/unit` → 183 files / 3061 tests；首轮 4 个失败（jitrl-metering observe 预留、release-contract 行 pin），修复后完整套件复跑通过（见 §10.3）。
- `node scripts/eval/check-orphan-exports.mjs` → `OK: 111 source file(s), 40 orphan(s) all allow-listed (40).`
- `node scripts/eval/check-test-import-coverage.mjs` → `OK: 111/111 src module(s) imported by a test (0 allow-listed).`
- `node scripts/eval/metering-coverage.mjs` → `OK: 111 file(s) scanned, 4 allow-listed model call(s), 0 unmetered call(s).`
- `node scripts/verify-readme-counts.mjs --docs-only` → `SUCCESS: documentation gate fully green`（79/79 documented rows）。
- `node scripts/eval/negative-result-diag.mjs --assert` → `A1..A6 PASS - the historical negative result is intact`；exit 0。
- `node scripts/eval/guarded-regression.mjs --json` → exit 0（全部 guard 见输出）。
- `node scripts/eval/mutation-gate.mjs --validate` → `anchors: all 5 mutants resolve against pristine sources`；exit 0。
- `node scripts/eval/mutation-gate.mjs --run --only M5` → `[M5] KILLED baseline=ok(10 tests) sha changed red=2/2 must-red hit`、worktree zero-residue、copy removed、verdict PASS；exit 0。
- `node scripts/eval/smoke-build.mjs` → `SUCCESS`；`pnpm run build` exit 0；artifact 1,303,885 bytes、`stale:false`、74 named exports。
- `node scripts/eval/check-encoding-policy.mjs` → HEAD `fa1f211` 的 554 个 tracked blobs 全部 LF/显式 -text；exit 0。新/未跟踪文件另做字节级检查：全部 no BOM、LF（见 §9.4 列表）。
- `git diff --check` → exit 0（仅 CRLF 工作树告警）。

### 10.2 未运行 / 需要授权

- **完整** `pnpm run test`：本轮已用 `npx --no-install vitest run --reporter=json` 跑过一次完整套件（§10.3）；不再重复。
- `pnpm run check:docs` 的“自动生成报告”分支未再跑第二次：已用 §10.3 的完整报告执行等价命令 `node scripts/verify-readme-counts.mjs --report <temp>`，exit 0。
- `attest:verify` / `check:clean-tree`：工作树故意未提交，不能作为通过证据。
- **完整** `check:mutation`（5 个 mutant 全跑）：审读修复轮已执行 `node scripts/eval/mutation-gate.mjs --run`（node v22.23.1）→ 5/5 KILLED，`verdict: PASS`（见 §10.5）；构造会话本身只跑了 `--validate` 与 M5。
- **所有需要真实宿主/真实模型的阶段**：rc4 host smoke、HOSTSMOKE_AUTHORIZED=1、cacheRead 实测、R3A_* 真实收益 canary、四臂消融、guarded-active 灰度，全部 not-run。没有真实模型调用、真实宿主写入、收益或宿主证据被声称。
- A4-5 的 worktree / 只读工具 allowlist runner 仍未实现：仓库没有 runner，宿主没有注入点；只验证了既有 `deps.verification` seam 的生产接入。

### 10.3 完整测试计数与 README 同步（已执行）

- 命令（前序施工会话，只运行一次）：`npx --no-install vitest run --reporter=json --outputFile=C:/Users/Administrator/AppData/Local/Temp/evo-full-vitest-report-final.json`
- 报告：`success=true`，`numTotalTests=3409`，`numPassedTests=3409`，`numFailedTests=0`，`numPendingTests=0`，`numTodoTests=0`；按路径归因 unit 183 files / 3061 tests，e2e 29 files / 348 tests，total 212 files / 3409 tests。
- README 已更新：summary `212 / 3409`；unit `183 / 3061`；e2e `29 / 348`；total `212 / 3409`。
- 审读修复轮**没有重新运行完整 Vitest**；它读取上面的外部报告并执行 `node scripts/verify-readme-counts.mjs --report C:/Users/Administrator/AppData/Local/Temp/evo-full-vitest-report-final.json` → `SUCCESS: All README.md test counts match Vitest results exactly!` 且 config-reference `79/79`；exit 0（见 §10.5）。
- 该报告是一次真实完整套件运行，不是分组计数或猜测。临时报告在系统临时目录，不写入仓库。

### 10.4 授权交接

- **rc4 宿主 smoke**：需 `HOSTSMOKE_AUTHORIZED=1 node scripts/host-smoke/run.mjs --out docs/reports/host-smoke-rc4.md`；必须回答：候选探针是否含补丁段、`measured cacheRead` 是否非零、hook dispatch 是否仍 `branchId=0`。`--check` 只检查宿主就绪。
- **cacheRead**：只能认宿主/供应商返回的 measured 值；估算值不得写成实测。
- **真实收益 canary**：需 `R3A_ADAPTER_MJS` / `R3A_CREDENTIAL_FILE` / `R3A_MODEL_SEAM` / `R3A_AUTHORIZED_BY` / 预算 / token caps / rate / 只读工具；exit 0 只代表测量成功，`insufficient`/`not-run` 不得写成 passed。
- **四臂消融**：预注册 m=12、Holm 族 4、π*=0.8693；`not-reject` 不等于等价；写回门 on/off 对照只有在 offline eval 的 `probeEvaluation:'legacy'` seam 下才等于完整历史路径。
- **guarded-active**：需要 P2-b 正结果、显式 `execution.mode:guarded-active` + `applyWinningPatch:true`、人工证据审查（代码不检查 verdict）、宿主 branch/fork 能力；runbook §8 的授权门全部满足前不得开启。

### 10.5 审读修复轮的门禁证据更正

审读指出：交付门禁表里“完整 vitest”与“README 计数”两行的 detail 是同一段无关日志（`pr1-attest` 负测试的 MISMATCH 行、encoding policy 行、attest ref 错误），无法归到各自命令。下面按行给出正确证据；**没有把外部报告冒充成本轮运行**。

| 门 | 本轮动作 | 实际输出 | 结论 |
| :--- | :--- | :--- | :--- |
| 完整 Vitest（212 files / 3409 tests） | **未重跑**；只读取前序会话的完整报告 `C:/Users/Administrator/AppData/Local/Temp/evo-full-vitest-report-final.json` | `success=true`、`numTotalTests=3409`、`numPassedTests=3409`、`numFailedTests=0`、`numPendingTests=0`、`numTodoTests=0` | 外部报告；不是本轮运行；最终套件由工作流重跑 |
| README 计数 | `node scripts/verify-readme-counts.mjs --report C:/Users/Administrator/AppData/Local/Temp/evo-full-vitest-report-final.json` | exit 0；`SUCCESS: All README.md test counts match Vitest results exactly!`；212/3409、183/3061、29/348、config 79/79 | **PASS（本轮实跑）** |
| mutation 固定缺陷集（5 mutant） | `node scripts/eval/mutation-gate.mjs --run` | M1 baseline=6 red=4/4；M2 25 red=6/3；M3 30 red=2/2；M4 35 red=2/2；M5 10 red=2/2；worktree zero-residue OK；copy removed true；verdict PASS | **PASS（本轮实跑）** |
| e2e 套件 | `node node_modules/vitest/vitest.mjs run tests/e2e` | 29 files / 348 tests passed | **PASS（本轮实跑）** |
| 审读点名的 7 个文件 | `node node_modules/vitest/vitest.mjs run tests/unit/dsh-bridge/patch-prompt.test.ts tests/unit/runtime/surface-evaluability.test.ts tests/unit/dream-rsi/surrogate-evidence-policy.test.ts tests/unit/dream-rsi/verified-tree-gate.test.ts tests/e2e/judge-symmetry.test.ts tests/e2e/verification-seam-production.test.ts tests/e2e/signal-propagation.test.ts` | 7 files / 80 tests passed；per-file 17 / 14 / 22 / 10 / 3 / 5 / 9 | **PASS（本轮实跑）** |

另抽验 §2 其余每文件计数（`agent-loop-patch-prompt` 6、`step-evaluator` 38、`p3-proposal-select` 23、`branch-mount-diagnostics` 5、`hook-branch-identity-diagnostic` 2、`branch-metering` 4、`offline-dream` 6）均与当前运行一致（7 files / 84 tests passed）。

**没有运行**：完整 `vitest run`（工作流最终门禁负责）；`attest:verify` / `check:clean-tree`（工作树故意未提交）；任何真实宿主/真实模型阶段。`node scripts/host-smoke/run.mjs --check` 只证明 readiness，不产生 dispatch，不能作为 rc4/rc5 的宿主结论。

工作流最终门禁表若仍显示旧的 `detail`，应以本表重新采集；本文件不是工作流输出，也不替代工作流的重跑。
