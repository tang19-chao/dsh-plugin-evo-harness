# C2a 可信验证生产接线审计与最小 host-owned runner 设计（t3）

> 只读审计 + 设计交付。**本文件不改动 `src/`、`tests/`、`scripts/`、ADR**；结论全部来自对 HEAD `9ea9b7e` 的源码追踪与可复现探针（见 §8）。
> t3 归属：`p62-c11-c2a-closure` / verification-engineer / attempt `93fd4337-c3ef-46e3-8d9b-175c1657d49f`。
> 对接：t5（C2a 实现，同一 owner）、t8（独立验证）、t1（ADR-0003）、t12（集成报告）。

## 0. 绑定与口径

| 项 | 值 |
| --- | --- |
| HEAD | `9ea9b7edacb199884df2020df879f4e59ed66d73`（工作树干净；`git diff \| git hash-object --stdin` = `e69de29bb2d1d6434b8b29ae775ad8c2e48c5391`，即空 diff） |
| 环境 | win32/x64，Node `v22.23.1`，pnpm `11.7.0`，vitest `3.2.7` |
| 基线门禁（本次实跑） | `pnpm run typecheck` exit 0；`node scripts/eval/guarded-regression.mjs --json` exit 0，`{total:25, passed:25, failed:0}`；`vitest run tests/unit/orchestrator/prb-trusted-verification.test.ts tests/unit/jitrl/eligibility-contract.test.ts` → 2 files / 41 tests passed |
| 关键文件 sha256（前 16） | `src/orchestrator.ts` `85268ED056CF29FF`、`src/jitrl/step-evaluator.ts` `50ACB8B6FE8D8794`、`src/jitrl/reward-contract.ts` `6C42F29E1C212E66`、`src/jitrl/experience-store.ts` `058582DA5F397454`、`src/cordis-seams/trajectory-collector.ts` `2935F349DD02D9F7`、`src/jitrl/index.ts` `3D1EE1F14DB54C09`、`src/dsh-bridge/agent-loop-executor.ts` `7DA8B4187B8E94AE`、`src/harness2/shared.ts` `7B960D2745AAF916`、`scripts/eval/guarded-regression.mjs` `B0AA51220F63D70A`、`src/runtime/execution-profile.ts` `69E8A44145B69ADE`、`src/types/contracts.ts` `E1BA3DA9683B2475` |
| 探针证据 | `work/_t3-c2a-probe.ts`（源码）、`work/_t3-c2a-probe.out.json`（输出）、`work/_t3-focused-vitest.log`、`work/_t3-typecheck.log`、`work/_t3-guarded-regression.json` |

## 1. 结论摘要

1. **生产路径目前完全没有 verdict 注入通道。** `TrajectoryCollector.finalize()` 只把 `diagnostics` 写进 `metadata`（`trajectory-collector.ts:334`），**丢弃** `ProbeExecutionResult.metadata`（`:288`、`:332`）；`metadata.verification` 的唯一读取点 `readTrustedVerification`（`step-evaluator.ts:626-632`）在生产链路里没有任何写入者（全 `src/` grep 确认）。因此今天所有"可信验证"行为都只在**手工构造 trajectory 的测试**里成立（`tests/unit/orchestrator/prb-trusted-verification.test.ts:58-68`）。
2. **hash 绑定在生产形态下不可达。** 生产 deliverable 由 `agent-loop-executor.ts:500` 产出，**不带 `contentHash`**；`expectedEvidenceHash = trajectory.deliverable.contentHash`（`step-evaluator.ts:909-912`）因此为 `undefined`，`hasTrustedVerificationProvenance` 的 hash 分支被**跳过**（`:540`）。探针 P2 证明：只要把一个自报 `verifierId` 放进调用方注入的 `Set`，一个"production shape"（无 contentHash）的伪造回执即可判为 trusted。
3. **资格冲突有 10 项**（§3），其中最紧的两项：
   - **C-3（high，需 ADR 裁定）**：`timeout` + trusted `failed` 当前会得到 `taskQualityEvidence === true`（探针 P3/P3b：recorder 会把它写成 `learningTrack='task-quality'`、reward `-0.6833`），与 t5 验收"超时/取消/infra error 保留原因且不冒充可靠任务失败"直接冲突。`verificationFromTrajectory` 只对 `passed` 做降级（`step-evaluator.ts:679-681`），对 `failed` 不做执行状态门。
   - **C-1（high）**：`ExperienceRecord.learningEligible` 被记录器写成**任务质量消费门**（`orchestrator.ts:2180`、`:2302`），而该字段的契约语义是"outcome 级否决（取消/infra）"（`contracts.ts:1442-1443`、`reward-contract.ts:503`）；于是"shape-only verdict"会把一条本可走 process 轨道的记录整体降为不可学（探针 P4：`processEligible=true` 但 `taskQualityLearningEligible=false` → 记录 `learningEligible:false`、reward 0）。
4. **reference / candidate 非同卷。** baseline 在 `orchestrator.ts:2128` 用 `scoreUnderRewardContract(input.reference)` **不传任何 trusted 集合**，每个 probe 在 `:2166` 同样不传；探针 P5 显示：只给 candidate 发可信回执会让 `learningTarget = 0.5`，而 reference 也经同一 runner 认证时 `learningTarget = 0.9167`——差异来自"验证覆盖不对称"，不是 patch 效果。
5. **task-quality 记录对生产消费者不可见是当前设计边界，不是 C2a 的缺陷。** 生产 L1/L2/L3/replay/M3 一律以 `PRODUCTION_LEARNING_TRACK='process'` 预过滤（`jit-active-policy.ts:745-747`、`jitrl/index.ts:500-509`、`:597-610`、`:884`、`:976`），探针 P6 证明 task-quality 记录过得了 `learningEligibleOnly` 却过不了 `learningTrack:'process'`。C2a 只能诚实交付"**可信记录闭环**"，并把"质量消费者尚未接线"作为未完成项登记（与 t12 验收措辞一致）；同时 fail-closed 不泄漏必须被新探针钉住。
6. **最小 host-owned runner 可在 t5 授权范围内落地**：新增 `src/verification/**`，在 `orchestrator.ts` 的 reference/candidate 两个出口各加一处同步 attach，`src/index.ts` 只做"宿主装配 + 默认不开启"。**不需要**改 `step-evaluator.ts` / `reward-contract.ts` / `types/contracts.ts`（§4.5 有范围说明与一处可选加宽请求）。

## 2. 现状追踪（read-only）

### 2.1 采集侧：collector 是唯一冻结 trajectory 的地方

```
orchestrator.probeCandidate -> deps.seams.runInIsolatedBranch -> seam-manager.runInIsolatedBranch
  -> new TrajectoryCollector({...})            seam-manager.ts:185-200
  -> this.execute(request, resources, context)
  -> collector.finalize({ status, result, error })   seam-manager.ts:304
```

- `finalize()` 的产物字段由 collector 自行拼装：`status`（`:281-282`）、`steps`（`:283`）、`toolErrors`（`:284-287`）、`failureSignals`（`:289-299`）、`metrics`（`:315-322`）、`deliverable`（`:288`→`:332`）、`metadata`（**只有 diagnostics**，`:334`）。
- `ProbeExecutionResult.metadata`（`contracts.ts:714`）**从不被读取**；`agent-loop-executor.toProbeExecutionResult`（`agent-loop-executor.ts:383-399`）把它塞进 `Result.metadata`，仍然在 `finalize` 处丢失。
- 参考分支同样走该 seam（`orchestrator.ts:1181-1200`），候选走 `probeCandidate`（`:2987-2999`）→ 两者是**同一个 choke point**，这对"reference/candidate 同卷同 provenance"是好消息。
- 生产 deliverable：`{ content, format:'markdown', producedFiles: [] }`（`agent-loop-executor.ts:498-500`），**无 `contentHash`**；`contentHash` 只由 `harness2/shared.ts:228-237 deliverableOf()` 派生，且只被 composer 的匿名化使用（`composer.ts:383-394`），**不回写 trajectory**。

**结论**：C2a 的 attach 必须在 collector 之外/之上显式做（collector 可选地提供 `finalize({verification})`），且绝不能顺手把 `result.metadata` 整体透传——那会把"分支可自报 verdict"从不可达变成可达（t5 明确禁止"分支 metadata 自行取得可信资格"）。

### 2.2 统一 evaluation：verdict 解析与信任判定

| 环节 | 位置 | 现行为 |
| --- | --- | --- |
| 形状校验 | `step-evaluator.ts:587-623` | status∈{passed,failed,unknown} + 非空 verifierId/verifierVersion/evidenceHash + checks[{id:string,passed:boolean}]；**`implicit` 不参与校验** |
| 读取 | `:626-632` | 仅 `trajectory.metadata['verification']` |
| 结构兜底 | `:645-664` | 只有"succeeded 且无 deliverable"→`failed`，其余→`unknown`，**永不 passed**；`evidenceHash = deliverable?.contentHash ?? ''`；`implicit:true` |
| 解析规则 | `:674-685` | 显式 payload 优先；显式 `passed` 且 `status!=='succeeded'` → 降级 `unknown`；**`failed` 不降级** |
| 信任判定 | `:526-544` | `implicit===true` → false；`verifierId ∉ injected Set` → false；evidenceHash 空 → false；**`expectedEvidenceHash!==undefined` 才做 hash 比对** |
| 信任集合 | `:495`、`:829` | 模块级**冻结空集**；`scoreTrajectorySignals`/`scoreUnderRewardContract` 的注入参数（`reward-contract.ts:179-184`）在生产调用点**从未传入** |
| 分数派生 | `:841-877`、`:891-898`、`:909-936` | `falsifiedSuccessClaim = failed && succeeded` → `eligible=false`；completion 由 verdict 决定（passed +1 / failed −1 / unknown 0）；failed 时 reward 钳到 ≤0；`trustedSource` 由 2.2 的判定产出；`taskQualityLearningEligible = eligible && (!verdictDerived || trustedSource)`；`taskQualityEvidence = eligible && verdictDerived && trustedSource` |

### 2.3 recorder：记录字段如何从 evaluation 派生

`orchestrator.recordOnlineExperience`（`:2031-2456`）：

- baseline：`clamp(scoreUnderRewardContract(input.reference).reward,-3,3)`（`:2128`），**无 trusted 集合**。
- 每条 probe：`const evaluation = scoreUnderRewardContract(probe.trajectory)`（`:2166`），**无 trusted 集合**。
- `eligible = evaluation.taskQualityLearningEligible`（`:2180`）；`!eligible` 分支：`reward=0, observedReturn=0, rewardSources={outcome:1,...}`（`:2245-2255`）；`eligible` 分支：`reward=observedReturn=evaluation.reward`（`:2263-2264`）。
- `learningTrack = evaluation.taskQualityEvidence ? 'task-quality' : 'process'`（`:2193-2195`）。
- 记录字段：`learningEligible: eligible`（`:2302`）、`rewardVersion: REWARD_CONTRACT.version`（`:2287`）、`experienceSchemaVersion`（`:2289`）、`learningTrack`（`:2297`）、`observedReturn/attributionBaseline/learningTarget/outcome`（`:2298-2301`）。
- 去重键 `(level, actionKey, treeId, nodeId, trajectoryId, round)`（`:612-621`），在 append 前过滤（`:2351-2359`）→ 同一 trajectory 的第二次 verdict **不可能**写第二条记录。
- stage detail：`trustedVerificationSource: 'shape-only (C2-pre: no trusted producer registered)'`（`:2425`）是**常量字符串**，不反映当次 verdict 的真实来源；`notTaskQualityEligible`（`:2410`）只给计数。
- 记录里**不持久化 verdict 身份/原因**：`rewardSources` 是唯一的开放数值口袋，目前只有 `{tool,steps,turn,completion,stepJudge,...decisionMarks}`。

### 2.4 消费侧（决定了"闭环到哪一步"）

| 消费者 | 位置 | track 过滤 |
| --- | --- | --- |
| L1 | `jit-active-policy.ts:745-747` | `isOnLearningTrack(entry, PRODUCTION_LEARNING_TRACK)` |
| L2 | `jitrl/index.ts:597-610` | store.query + `learningTrack:'process'` |
| L3 advisor | `jitrl/index.ts:500-509` | 同上 |
| replay / M3 | `jitrl/index.ts:880-895`、`:971-979` | 先 `isOnLearningTrack` 预过滤，再 `freshPolicySupport` |
| store.query | `experience-store.ts:1165-1180` | `learningEligibleOnly`（谓词）+ `learningTrack` |
| 单点资格谓词 | `reward-contract.ts:499-515` ← `decision-kernel.ts:733-735` | `learningEligible!==false` ∧ schema≥2 ∧ rewardVersion 精确匹配 |
| 版本分区/镜像 | `experience-store.ts:1415-1443`、`:1454-1469` | `learningEligible===false` 或版本不兼容 → `ineligible` |

即：**"可信 task-quality 记录"今天是"写进去也读不出来"**（探针 P6）。这是 C2a 之后必须如实登记的边界（C2b 未接线），不是 C2a 需要偷偷打开的开关。

### 2.5 verdict × 执行状态真值表（当前代码）

| 执行状态 | verdict=passed | verdict=failed | verdict=unknown | 无 payload（结构兜底） |
| --- | --- | --- | --- | --- |
| succeeded + deliverable | trusted? → task-quality；否则 audit-only | falsified → `learningEligible=false`（audit-only） | process 轨道，completion=0 | unknown → process；无 deliverable 时 structural `failed` |
| succeeded + 无 deliverable | 同上（但 contentHash 为空，hash 绑定不可达） | 同上 | structural `failed` → falsified → ineligible | structural `failed` |
| **timeout** | 降级 `unknown` → process | **⚠ taskQualityEvidence=true（trusted 时）** | process | process |
| aborted / cancelled / infra | `eligible=false`（outcome 否决） | 同左（outcome 否决先生效） | 同左 | 同左 |

（`timeout` 行即 C-3；`aborted/cancelled` 因 `isLearningOutcome` 先行否决，所以只有 timeout 这一格漏。）

### 2.6 "凭证"侧的第二个字符串信任通道（不在 t5 范围，必须登记）

`buildRescoredBackfillRecord`（`backfill.ts:602-643`）在 provenance 校验通过后**无条件**写 `learningEligible: true`（`:641`），而 provenance 里的 `verifierId` 只是 `provenanceVersion` 文本里解析出来的字符串（`:598`、`:630`），**不与任何 host 注册表/回执绑定**；产物 rewardVersion=`r4/verifier-first-v1@rescore-v1` 在认证表内（`reward-contract.ts:248-252`）→ 会被单点谓词判为 current。该函数在 `src/` 内**无生产调用者**（仅测试与宿主可调用 seam），属"可被宿主/后续阶段用来绕过 C2a 注册表的通道"，须由 ADR-0003 明确归属（C2b 收口或本轮声明为可接受 seam）。

## 3. 资格冲突清单

| id | 严重度 | 冲突 | 证据（位置 / 探针） | 建议处置 | 归属 |
| --- | --- | --- | --- | --- | --- |
| C-1 | high | `learningEligible` 字段一名两义：契约是 outcome 否决，记录器写的是 task-quality 消费门；shape-only verdict 使本可 process 学习的记录整体不可学 | `orchestrator.ts:2180,2302` vs `contracts.ts:1442-1443`、`reward-contract.ts:503`；探针 P4 | 记录器改为 `learningEligible: evaluation.learningEligible`（outcome 否决），把消费门留在 `learningTrack`/`taskQualityEvidence` 语义里；或 ADR 明确接受该重载并加回归钉住。**注意**：改 `learningEligible` 会改变 process 集合，需 ADR 裁定后再动 | t5 实施（orchestrator 在范围内）+ t1 裁定 |
| C-2 | info（边界） | 生产消费者全部锁 `process`，task-quality 记录"写进去读不出" | `jit-active-policy.ts:745`、`jitrl/index.ts:507,609,884,976`；探针 P6 | C2a 只交付"可信记录闭环"；把"质量消费者尚未接线"写入状态表/报告，并加探针钉住"不泄漏进 process"（已有 T7-V3，需补真实回执版本） | t12 报告 + t5 探针 |
| C-3 | high | `timeout` + trusted `failed` → `taskQualityEvidence=true`，会被盖成可靠任务失败 | `step-evaluator.ts:679-681`（只降级 passed）、`:841-843`（只对 succeeded 判伪）、`:936`；探针 P3/P3b | 按 t5 验收采用"保守 A"：**只有 `trajectory.status==='succeeded'` 的 trusted 回执可作 task-quality 证据**；非 succeeded 时回执只作审计（`metadata.verificationAudit`）并保留原因。可用 attach 侧实现，无需改 `step-evaluator.ts` | t1 裁定 + t5 实施 |
| C-4 | high | reference 与 candidate 非同卷：baseline 与 probe 都无 trusted 集合；即便传入集合，未认证的 reference 也拿不到 completion | `orchestrator.ts:2128,2166`；探针 P5 | host runner 必须对 reference 与 candidate **同规则各出一份回执**，同一 `testSetId/envId/runId` 绑定，同一 `trustedProducers` 集合参与打分 | t5 实施 + t8 验收 |
| C-5 | high | 生产链路无 verdict 注入通道（collector 丢弃 result.metadata；无写入者） | `trajectory-collector.ts:288,332,334`；`readTrustedVerification` 全仓唯一读取点；探针 P1 | 新增显式 attach（orchestrator 两处出口 / collector 可选 `finalize({verification})`）；**不得**透传 `result.metadata` | t5 实施 |
| C-6 | high | hash 绑定在生产形态不可达（无 `contentHash`） | `agent-loop-executor.ts:500`、`step-evaluator.ts:909-912,540`；探针 P2 | host 侧重算 artifact digest 写入 attach 后的 `deliverable.contentHash`，使既有比对分支真正生效；**不改**"evidenceHash 绑定执行证据"的语义 | t5 实施 |
| C-7 | high | 信任门当且仅当"id ∈ 注入集合 + 自报 hash 非空"时成立；未提交路径下"分支自报"即可冒充，id 集合本身不是来源认证 | `step-evaluator.ts:526-544`；探针 P2（production shape trusted=false→true 只差注入集合） | 信任绑定到 **host 注册表身份**（runner 实例返回的回执对象，按 `trajectoryId/runId + artifactDigest` 登记），而不是 id 字符串；attach 只接受注册表命中对象 | t5 实施 + t11 评审 |
| C-8 | medium | 记录不持久化 verdict 身份/原因（只有 `rewardSources` 数值口袋），t5 验收"保留 verdict/原因"在当前文件范围内只能部分满足 | `orchestrator.ts:2245-2255,2265-2268,2302`；`contracts.ts:1398-1472`（无 verification 字段） | 最小方案：`rewardSources` 加数值标记（verdictCode/trustedSource/verifierVersionCode）+ stage detail 原因串 + 审计副本；若要求可读 `verificationId` 落库，需 captain 加宽 t5（`src/types/contracts.ts` 不在 t5 SCOPE） | t1 裁定 + t5 |
| C-9 | medium | backfill rescore 通道可凭 provenance 文本里的 `verifierId` 字符串取得 `learningEligible:true` + r4 兼容版本 | `backfill.ts:598,630,641`；`reward-contract.ts:248-252`；`tests/unit/jitrl/eligibility-contract.test.ts:558` | ADR-0003 明确：该通道要么归入 C2b 收口（provenance.verifierId 需与宿主回执绑定），要么本轮声明为可接受 seam 并冻结（不改行为） | t1 裁定（out of t5 scope：`src/jitrl/backfill.ts` 未列出） |
| C-10 | low | 显式 `implicit:true` payload 过 `isTrustedVerification`（`:587-623` 不校验 implicit）并覆盖结构兜底，把 process-eligible 记录整体推成 audit-only；当前不可达（无写入者） | `step-evaluator.ts:587-623,626-632,674-685` | attach 侧只写非 implicit 回执；若 ADR 想收口，需 `verificationFromTrajectory` 忽略显式 implicit（`step-evaluator.ts` 不在 t5 SCOPE → 登记为 C2b 清理项） | t1 登记 / C2b |

## 4. 最小 host-owned runner 设计

### 4.1 目标与不动项

**目标**：让"宿主自己跑的确定性本地 verifier"成为唯一可信来源，产出绑定 `artifact digest + test set + env + run` 的回执，经统一 evaluation 进入 recorder，使 reference/candidate 同卷同 provenance；未配置 runner 时与今天**逐字节等价**（保守退化）。

**不动**（红线）：r4 数值标尺（`REWARD_CONTRACT_WEIGHTS`/clip/版本 id）、`evidenceHash` 旧语义、`trustedProducers` 注入接缝形状、task-quality/process 隔离、patch/publish/memory 权限、r3 隔离与认证表、任何网络/付费模型调用。

### 4.2 模块与类型（`src/verification/`，新目录）

```
src/verification/index.ts          对外出口
src/verification/types.ts          HostVerificationRequest/Receipt/Binding/Runner/Registry
src/verification/artifact-digest.ts  artifactDigestOf(...) —— 宿主重算，node:crypto sha256
src/verification/host-runner.ts      createHostOwnedVerificationRunner(...) —— 注册表 + 确定性检查
src/verification/attach.ts           attachHostVerification(...) / verificationAuditMark(...)
```

```ts
// types.ts（要点）
export interface VerificationBinding {
  readonly runId: string; readonly sessionId: string; readonly trajectoryId: string;
  readonly taskId: string; readonly testSetId: string; readonly envId: string;
  readonly artifactDigest: string;          // host 重算，非调用方自报
}
export interface VerificationReceipt {
  readonly status: 'passed' | 'failed';
  readonly verifierId: string; readonly verifierVersion: string;
  readonly evidenceHash: string;            // === artifactDigest（旧语义不变）
  readonly checks: readonly { readonly id: string; readonly passed: boolean }[];
  readonly binding: VerificationBinding;    // 认证对象的一部分
  readonly kind: 'host-runner';             // 只有 runner 会生成
}
export interface HostVerificationRunner {
  verify(req: HostVerificationRequest): Promise<VerificationReceipt>;   // 只返回注册成功的回执
  readonly trustedProducers: ReadonlySet<string>;   // 生产集合由 runner 工厂持有
}
export interface HostVerificationSeam {
  readonly runner: HostVerificationRunner;
  enabled?: boolean;                         // 缺省 false（deny-by-default）
}
```

**认证机制（最小、无密钥）**：runner 内部持有 `Map<trajectoryId, {digest, receipt}>`（`WeakSet<object>` 亦可）。`attach` 只接受"由本 runner 实例在本次运行登记过的回执对象"，并以登记时宿主计算的 digest 作为 `deliverable.contentHash`。因此：
- 分支/执行器自报的 payload **永远进不了 attach**（collector 也不透传 `result.metadata`）：C-5/C-7 同时关闭；
- 旧 replay 回执（异 `trajectoryId`/`runId`）命中失败：t5 验收"重复回执/幂等"可测；
- `trustedProducers` 只作为 scorer 的第二个必要条件（保留既有接缝形状），不再承担来源认证。

### 4.3 调用点（逐文件最小 diff，均在 t5 SCOPE 内）

1. **`src/orchestrator.ts`**
   - `deps` 新增可选 `verification?: HostVerificationSeam`（默认 undefined）。
   - reference 出口（`1181-1200` 之后）：`const reference = await this.attachVerification(await ...runInIsolatedBranch(...), {task, role:'reference', runId})`。
   - candidate 出口（`probeCandidate`，`2987-2999` return 处）：同规则 attach 后返回。
   - `recordOnlineExperience`：把 `this.verificationTrustedProducers()`（空集或缺省）传给 **`:2128` 与 `:2166` 两处** `scoreUnderRewardContract`（C-4）；stage detail 的 `trustedVerificationSource` 改为**事实串**（如 `host-runner:<verifierId>@<version>` / `no-host-runner` / `audit-only(<reason>)`）。
   - `!eligible` 分支与 `eligible` 分支的 `rewardSources` 追加数值标记：`verificationVerdict`（0/1/2）、`verificationTrusted`（0/1）、`verificationAuditOnly`（0/1）→ C-8 的最小可审计形态；**不改任何现有键的语义**。
2. **`src/cordis-seams/trajectory-collector.ts`**（可选，二者选一，推荐 a）
   - a) 不新增字段；attach 在 orchestrator 侧用不可变 spread 生成新 trajectory（`{...trajectory, deliverable:{...,contentHash:digest}, metadata:{...,verification:receipt}}`）。collector 零改动。
   - b) 新增 `finalize({ verification })` 与 `metadata` 合并（保留 diagnostics 键，禁止覆盖）。仅在需要 seam 层 attach 时采用；**不得**改为透传 `result.metadata`。
3. **`src/index.ts`**：宿主装配只做"若调用方显式提供 runner 则注入 `deps.verification`"，**无 config 字段可开启**（对齐 `memoryRealWrites` 的"配置形状不可加宽"纪律；`src/config.ts` 不在 t5 SCOPE，正好保持不动）。
4. **`scripts/eval/guarded-regression.mjs`**：新增 C2a 探针（§5 的 A/B/C/D/E/F/G 组至少各一条），并保留现有 `C2a-trusted-boundary`、`T8-V5b`、`T7-V3` 全部断言不变。
5. **测试**：`tests/unit/verification/*`（新）、`tests/unit/cordis-seams/*`（attach/不透传）、`tests/unit/p62/release-contract.test.ts`（记录形态）、`tests/e2e/*`（真装配下 reference+candidate 双回执）。

### 4.4 不变式（实现与验收共同引用）

- **I1 deny-by-default**：无 runner ⇒ 无 attach ⇒ 记录与今天完全一致（比 "byte-identical" 用既有 25 探针 + 新探针共同保证）。
- **I2 来源不可自报**：attach 只接受宿主注册表对象；分支 metadata 永不授予信任。
- **I3 digest 宿主重算**：`artifactDigest` 从 artifact 字节重算，回执 `evidenceHash` 必须等于它，且写入 trajectory 的 `contentHash`；scorer 的比对分支由此真正生效。
- **I4 verdict×status 门（保守 A）**：仅 `status==='succeeded'` 的 trusted 回执可作 task-quality 证据；timeout/aborted/cancelled/infra 一律 audit-only，原因保留（`metadata.verificationAudit` + 诊断 + `rewardSources` 标记）。
- **I5 同卷**：同一 runner/集合/testSet/env 施加于 reference 与 candidate；`learningTarget` 只反映 patch 效果。
- **I6 数值不动**：`contractWeightsHash()` 前后一致；`REWARD_CONTRACT.version/aggregation/weights/clip` 不变；trust 只影响 eligibility/track。
- **I7 不泄漏**：task-quality 记录不进任何 process 邻域（真实回执版本复跑 T7-V3）。
- **I8 无副作用**：runner 零网络、零模型、零 memory/patch/publish；权限布尔值一律不变。

### 4.5 范围说明（需要 captain/ADR 知晓）

- `src/types/contracts.ts`、`src/jitrl/step-evaluator.ts`、`src/jitrl/reward-contract.ts`、`src/dsh-bridge/model.ts`、`src/ledger`、`docs/adr/0003-*.md` 均**不在 t5 SCOPE**。因此 C-3 的保守 A 只能落在 attach 侧（把非 succeeded 的回执转入审计通道），C-1 若要求改 `learningEligible` 语义也只需改 orchestrator 一行（在范围内），但**语义变更本身须 ADR 先裁定**。
- 若 ADR-0003 要求"记录里落可读 `verificationId`/`reason`"，t5 需加宽到 `src/types/contracts.ts`（新增可选字段，schema 版本不动），否则退化为 §4.3.4 的数值标记 + stage 诊断。
- C-9 的 rescore 通道（`src/jitrl/backfill.ts`）不在任何人的本轮 SCOPE，须由 ADR-0003 定性。

## 5. 端到端验收矩阵（t8 可独立复跑）

> 约定：`V()` = 待新增的 verification 单测文件（`tests/unit/verification/*.test.ts`）；`E2E` = `tests/e2e/*`；`GR#` = `scripts/eval/guarded-regression.mjs` 新探针 id。所有命令都在仓库根执行。

| id | 断言（可判定） | 夹具 | 命令 | 期望 |
| --- | --- | --- | --- | --- |
| A1 | **真实正确 artifact** 经生产链路（orchestrator.run + 注入 runner）产生 trusted `passed` 记录：`learningTrack='task-quality'`、`learningEligible=true`、`observedReturn>0`、`rewardSources.completion=1` | 宿主测试用例 `case-correct`（fixture 内置期望输出） | `pnpm exec vitest run tests/unit/verification tests/e2e` | 断言全过；记录字段如左 |
| A2 | **真实错误 artifact** 经同一链路产生 trusted `failed`（执行 succeeded）：verdict=failed、`reward≤0`、audit-only（`learningEligible=false`、track=`process`）、原因可查 | `case-wrong` | 同上 | 无正分记录；审计标记与诊断存在 |
| B1 | 分支/执行器自报 payload（含注册表内的 verifierId + 正确 hash）**不得**取得信任；`trajectory.metadata.verification` 不由 `result.metadata` 透传 | 假 executor 返回伪造。metadata | `pnpm exec vitest run tests/unit/cordis-seams` | attach 前 `verificationFromTrajectory` 为 structural/unknown；无 task-quality 记录 |
| B2 | 旧 artifact 回执（digest 不匹配）拒绝 | 同一 trajectory，`evidenceHash` 指向上一版 artifact | `V()` | `trustedSource=false`；无 task-quality |
| B3 | 异 task / 旧 test set 回执拒绝 | 同 artifact，`testSetId`/`taskId` 不匹配 | `V()` | 同上 |
| B4 | 缺 digest / 空 checks / 形状不全拒绝 | 3 个畸形 payload | `V()`、GR 复用 `C2a-trusted-boundary` | 全部 `isTrustedVerification=false` 或 trusted=false |
| B5 | 回执跨 run 重放拒绝（`runId/trajectoryId` 绑定） | 上一轮回执对象喂给新 run | `V()` | 拒绝且诊断留痕 |
| C1 | runner 超时/抛错：probe 状态与失败原因**不变**、无 verdict、无 task-quality 记录、诊断含原因 | 注入会抛/延迟的 runner | `V()` + `E2E` | `status==='timeout'/'failed'` 原样；`verificationAudit` 存在 |
| C2 | 取消/中止（`CancelledError`/`UserCancelledError`/signal）不产生 task-quality 证据 | 取消夹具 | `V()` | `learningEligible=false`（outcome 否决）且原因保留 |
| C3 | infra error 不冒充可靠任务失败 | `EvoHarnessPluginError` | `V()` | outcome=`infrastructure_error`、无 task-quality |
| C4 | **timeout + trusted failed 不得成为 task-quality 证据**（本地径要求的 C-3 裁定） | timeout trajectory + trusted failed 回执 | `GR#C2a-timeout-not-task-quality` + `V()` | `taskQualityEvidence=false`，审计标记=1 |
| D1 | 同一回执重复投递 ⇒ 仅一条记录（dedup 键）；重入 recorder 不重复 append | 同 trajectory 两次 attach | `E2E` + `V()` | store 记录数不变；无重复 id |
| D2 | runner 确定性：同输入两次运行 digest/verdict 完全相同 | 同一 artifact | `V()` | 回执深度相等 |
| D3 | 反转后的第二次 verdict 不回写、不新增（首写为准） | 先 passed 后 failed | `V()` | store 保留第一条；诊断说明 |
| E1 | reference 与 candidate 都有回执，`testSetId/envId/runId` 绑定一致；缺一即不对称（探针给出数值差） | 真装配双分支 | `E2E` | `baseline`/`candidate` 都经 `scoreUnderRewardContract(..., {trustedProducers})` |
| E2 | `learningTarget = candidate.observedReturn − reference.observedReturn`，两侧同集合同规则 | 同上 | `E2E` | 等式成立；只反映 patch 差异 |
| F1 | **未配置 runner** ⇒ 与 HEAD 行为一致：无 attach、无 task-quality、既有 25 探针 + 全量测试全绿 | 默认装配 | `node scripts/eval/guarded-regression.mjs --json`、`pnpm test` | `{total:25,passed:25,failed:0}` → 追加新探针后 `failed:0` |
| F2 | 有 runner 但无 trusted 集合 ⇒ 回执 shape-only，无 task-quality 记录（保守退化） | runner 不给集合 | `V()` | 记录 `learningEligible=false`（audit-only），诊断明确 |
| F3 | 无 config 形状可开启 runner（静态扫描 + 运行时探针） | `src/config.ts` 文本 + 默认装配对象 | `GR#C2a-no-config-grant` | 不存在把 runner 打开的配置路径 |
| G1 | r4 数值标尺不动：weights hash、版本 id、aggregation、clip 不变 | — | `GR#C2a-scale-frozen` | `contractWeightsHash()` 前后相等（记录值与 HEAD 值对照） |
| G2 | task-quality 记录不进任何 process 邻域（store + L1/L2/L3/replay/M3 快照预过滤） | 真回执记录 + 一条 process 记录 | `GR#C2a-track-isolation-with-receipt` + `V()` | process 查询/快照都拿不到 task-quality 记录 |
| G3 | patch/publish/memory 权限与零桥调用不变 | 现有 T10-R2b/R2c 复用 | `node scripts/eval/guarded-regression.mjs --json` | 既有探针全绿 |
| H1 | runner 零网络/零模型：静态扫描（无 `fetch`/`http`/`IModelAdapter`）+ 运行时模型适配器 spy 零调用 | `src/verification/**` | `GR#C2a-runner-offline` | 两项均为 0 |
| H2 | 回执/记录不含绝对路径与秘密（复用 redaction 口径） | 含 `C:\...`、token 形状的 artifact | `V()` | 输出无绝对路径/秘密 |
| H3 | digest 由宿主重算：篡改 `deliverable.contentHash`（shake）不影响判定 | 手工抖动 contentHash | `V()` | 以重算值为准，抖动被忽略 |

## 6. t5 实施顺序（建议）

1. `src/verification/**`（types → digest → runner → attach），先写 A1/A2/B1-B5/D2/H2/H3 的 `V()` 单测（红）。
2. collector：保持零改动或加 `finalize({verification})`；**加一条"result.metadata 不透传"的回归**。
3. orchestrator：deps seam + reference/candidate 两处 attach + 两处 scorer 传集合 + `rewardSources` 数值标记 + stage detail 事实串。
4. `src/index.ts`：显式注入只有调用方给 runner 时发生；无 config 路径。
5. `scripts/eval/guarded-regression.mjs`：新增 C2a 组探针（C4/F3/G1/G2/H1），保持既有 25 条不变。
6. 全量：`pnpm exec vitest run tests/unit/verification tests/unit/cordis-seams tests/unit/p62 tests/e2e` → `pnpm run typecheck` → `pnpm test`。
7. 交付说明必须区分：**可信记录闭环已交付** / **质量消费者（C2b）未接线** / timeout 等异常只审计。

风险提示：`src/orchestrator.ts` 与 `src/index.ts` 同時是 t4（C1.1）的共享面；按 t4 任务书写"只做局部最小改动、避免格式化无关区域"，t5 必须**等 t4 落地后**再改这两文件（任务依赖已声明 t5 ← t4）。

## 7. 待 ADR-0003 / captain 裁定

| # | 裁定项 | 现状事实 | t3 建议 |
| --- | --- | --- | --- |
| R1 | `timeout/aborted/cancelled/infra` + trusted verdict 的资格语义（C-3） | timeout+trusted failed → taskQualityEvidence=true | 采用保守 A：仅 succeeded 的执行可承载 task-quality 证据；其余 audit-only 且保留原因 |
| R2 | `learningEligible` 字段是否维持"消费门"重载（C-1） | 记录器写入 task-quality 门，契约文档写 outcome 否决 | 回归到 outcome 否决；消费门由 track/evidence 承载；若要保留重载需在 ADR 明示并由回归钉住 |
| R3 | 持久化 verdict 身份的字段范围（C-8） | 当前只有 `rewardSources` 数值口袋 | 先做数值标记 + stage 诊断；若要求可读 id，加宽 t5 到 `src/types/contracts.ts`（可选字段） |
| R4 | rescore 通道 `verifierId` 认证（C-9） | 字符串 provenance 即可获得 `learningEligible:true` + r4 兼容 | 归入 C2b 收口，或本轮声明为冻结 seam 并写进状态表 |
| R5 | 显式 `implicit:true` payload（C-10） | 能覆盖结构兜底，当前不可达 | 列为 C2b 清理项，或允许 t5 在 attach 侧保证不产生（默认已满足） |
| R6 | reference 回执是否强制（C-4） | baseline 无回执时 learningTarget 偏置（探针 P5） | 强制"双回执同卷"；缺 reference 回执时把 candidate 回执降级为审计（fail-closed） |

## 8. 复现命令

```powershell
# 0) 基线（本次实测结果见 §0）
pnpm run typecheck
pnpm exec vitest run tests/unit/orchestrator/prb-trusted-verification.test.ts tests/unit/jitrl/eligibility-contract.test.ts
node scripts/eval/guarded-regression.mjs --json

# 1) t3 探针（P1..P6 + P3b）
pnpm exec esbuild work/_t3-c2a-probe.ts --bundle --format=esm --platform=node --target=node20 --outfile=work/_t3-c2a-probe.mjs
node work/_t3-c2a-probe.mjs

# 2) 关键判定摘录
#   P1 trajectoryMetadata=null, readBackVerdict=unknown(implicit)   -> 无注入通道
#   P2 productionShapeTrusted=true, hashedShapeTrustedAgainstWrongDigest=false -> 生产形态 hash 绑定不可达
#   P3/P3b timeout+trusted failed -> taskQualityEvidence=true, wouldLearningTrack=task-quality
#   P4 shape-only: taskQualityLearningEligible=false / trusted: true
#   P5 learningTarget 0.5（只认证 candidate） vs 0.9167（双认证）
#   P6 anyTrack=[rec-tq] / processTrack=[] / taskQualityTrack=[rec-tq]
```

t3 未改动任何 `src/`、`tests/`、`scripts/`、ADR 文件；仅新增 `work/_t3-c2a-probe.ts` 与其输出、以及本报告。
