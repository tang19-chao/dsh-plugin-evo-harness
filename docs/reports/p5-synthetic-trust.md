# P5：离线合成测试信任层 `synthesized-tests/v1`（默认关闭，audit-only）

| 项 | 值 |
| --- | --- |
| 任务 | t10（attempt 2，改派自 p5-synth 的模型路由故障） |
| 信任层 | `synthesized-tests/v1`（独立层；**不扩展** `LEARNING_TRACKS`） |
| 默认状态 | **关闭**（`DEFAULT_SYNTHETIC_TEST_TRUST_POLICY = { enabled: false, mode: 'audit-only' }`） |
| 在线入口 | **无**：模块不被任何生产文件 import（§2.7 静态证明）；不进入 r4 主奖励或在线可信质量输入 |
| 交付文件 | `src/verification/synthesized-tests.ts`（57,582 B）、`tests/unit/verification/p5-synthetic-trust.test.ts`（49 用例）、`tests/fixtures/p5-synth/`（4 夹具）、本报告 |
| 授权边界 | 零真实付费调用、零真实宿主 smoke、零外部工具/记忆写入、零 commit/push |

---

## 1. 结论与边界（内容可信 ≠ 执行可信）

1. **两个信任是结构上分离的两个字段**，不是一个布尔：
   - `content.trust` ∈ `uncalibrated | calibrated | revoked` —— **测试内容**是否挣得信任（候选生成前冻结、在带标签的 development 案例上校准、来源不是基线固化、生成者/候选隔离、holdout 未泄漏）；
   - `execution.trust` ∈ `unverified | host-verified` —— **宿主 runner** 是否执行了**那份冻结内容**并给出回执（层 id + 重算的 test-set digest + scope 的完整案例集 + 回执 digest + verdict/check 一致）。
2. **"执行可信但内容不可信"是可表达的合法状态**，有类型见证：

   ```ts
   export type ExecutionTrustedContentUntrusted = SyntheticTestAssessment & {
     readonly content: SyntheticTestContentAssessment & { trust: 'uncalibrated' | 'revoked' };
     readonly execution: SyntheticTestExecutionAssessment & { trust: 'host-verified' };
   };
   ```

   实测（§5.2）：同一份 calibrated suite 去掉校准报告后，`execution.trust = 'host-verified'`、`content.trust = 'uncalibrated'`、`isExecutionTrustedContentUntrusted(assessment) === true`，而 task-quality 闸门给出的理由是 **`content-uncalibrated`**（不是 execution 问题）。这条用例就是"不得把离线测试可信执行误作测试内容可信"的可执行形式。
3. **v1 绝不进入 task-quality**：`gateSyntheticResultForTaskQuality()` 的返回类型是 `{ allowed: false }`——**没有 allow 分支**。理由按优先级：`content-revoked` > `content-uncalibrated` > `execution-unverified` > `audit-only-v1`（即使内容已校准、执行已验证，仍以 `audit-only-v1` 拒绝）。
4. **不是沙箱**：回执只把 verdict 绑定到冻结内容与宿主绑定，不提供执行环境隔离；同进程执行仍是同进程执行。
5. **本报告不声明**：不声明生产收益；不声明"校准通过 ⇒ 测试内容正确"（校准只测召回/误报这一组可观测性质）；不声明 ci-04|2|2 用例"不存在"——**它存在**，本层是给它加诊断而不是重新发现它（§3）。

---

## 2. 设计

### 2.1 独立性与冻结学习轨

- `SYNTHESIZED_TESTS_LAYER = 'synthesized-tests/v1'` 是**信任层 id**，不是学习轨。`LEARNING_TRACKS` 仍为 `['task-quality', 'process']`（测试断言）。
- **不扩展冻结枚举**：`src/types/contracts.ts` **零改动**（本任务仅获准"新增类型需先告知 lead"，实际未需要——所有类型都在 `src/verification/synthesized-tests.ts` 内，不进入公开契约面）。

### 2.2 摘要与冻结

| 概念 | 定义 | 复算 |
| --- | --- | --- |
| `canonicalJson` | 对象键排序、数组保序、undefined→null | 纯函数 |
| `contentDigest` | `sha256:<64hex>` over `dsh-p5-synthetic-tests-v1/content:<len>:<canonical content>`（**不含时间**） | `computeSyntheticSuiteContentDigest()` |
| `testSetDigest` | `sha256:<64hex>` over `.../seal` = `{layer, contentDigest, frozenAt}`（**含冻结时刻**，重打时间戳会破坏封印） | `computeSyntheticTestSetDigest()` |
| `caseDigests[id]` | 每个案例内容的独立摘要（篡改单例可定位） | `computeSyntheticCaseDigest()` |

**冻结校验（fail-closed，抛错而非静默）**：空 suite、重复 case id、未知 label/source、`sha256` 形状不符、`baseline-frozen` 缺 `baselineObservation`、非 `baseline-frozen` 却带 `baselineObservation`、split 未覆盖全部案例/两侧重叠/development 为空。

**候选生成前冻结**：`assertFrozenBeforeCandidateGeneration(suite, candidates)` 检查两条独立事实——①每个候选的 `createdAt >= frozenAt`（`createdAt` 非有限即 violation，无法与封印排序）；②没有任何案例声明 `generatedFromCandidateId`（候选自己写的测试不能判它自己，与时间无关）。

### 2.3 宿主执行回执（只承担执行证据）

`SyntheticTestReceipt` 绑定：`layer`、`testSetDigest`、`scope ∈ {development, holdout, full}`、`caseIds`（必须**精确等于**该 scope 的冻结案例集——不许挑案例、不许夹带 holdout）、`runId/verifierId/verifierVersion/executedAt`、逐案例 `status+checks`、`receiptDigest`。
校验失败码：`layer-mismatch` / `receipt-digest-mismatch` / `receipt-test-set-mismatch` / `receipt-case-set-mismatch` / `receipt-verdict-contradiction`（verdict=passed 但有失败 check，或反之）。

### 2.4 校准：混淆矩阵 + 本仓自定分母与标签

预注册阈值（层常量，不是每次运行的旋钮）：`minLabeledCases=8`、`minFailureRecall=0.8`、`maxFalsePositiveRate=0.1`、`maxMisjudgmentRate=0.2`。

分母定义（**本仓自定，无论文口径**）：

| 指标 id | 标签（label） | 公式 | 分母 | 分母单位 |
| --- | --- | --- | --- | --- |
| `failure-recall` | case-level-failure-recall (seeded-bug catch rate) | TP / (TP+FN) | 6 | labelled bug-present cases |
| `false-positive-rate` | case-level-false-positive-rate (false alarm rate on clean cases) | FP / (FP+TN) | 4 | labelled bug-absent cases |
| `misjudgment-rate` | case-level-misjudgment-rate (any wrong verdict, either direction) | (FP+FN) / (TP+FN+FP+TN) | 10 | all labelled cases in the calibration run |
| `failure-miss-rate` | case-level-failure-miss-rate (informational counterpart of recall) | FN / (TP+FN) | 6 | labelled bug-present cases |

**排除规则（计入 population、不进任何分母）**：`baseline-frozen` 案例（基线行为固化，天然通过基线）；**holdout 案例**（在 calibration 上使用 holdout 会把终检变成调参集——P2-C 规则在本层的同构应用）。混淆矩阵按 `label × host verdict` 计算：bug-present+failed=TP、bug-present+passed=FN、bug-absent+failed=FP、bug-absent+passed=TN。

### 2.5 生成者/候选隔离与来源

- `source ∈ {spec-derived, mutation-derived, baseline-frozen}`；`sourceDigest` 必须为 `sha256:<64hex>`（测试集来源可追溯）。
- `checkGeneratorCandidateIsolation`：suite.generator.id === candidate.generatorId ⇒ `same-generator`；候选自写案例 ⇒ `candidate-authored-case`。

### 2.6 holdout 防火墙（与 P2-C 同一纪律）

`checkSyntheticHoldoutFirewall(suite, generationArtifacts)` 对所有"喂给候选生成"的产物做文本扫描：任一 holdout 案例 id 出现 ⇒ `holdout-leak`。夹具**常驻仓库**并由永久用例断言：`p5-synth-selection-clean.json`（过）与 `p5-synth-holdout-leak.json`（抓）。

### 2.7 默认关闭、显式授权、可回滚、零生产接线

- `createSyntheticTestTrustLayer()` 默认 `enabled: false`；`assess()` 直接返回 `{status:'disabled', taskQualityEligible:false}`，**不读取输入**（用 Proxy 令任意属性访问抛错实测）。
- 开启：`enable(grant)` 要求 `{grantedBy, reason, mode:'audit-only', grantedAt}` 全部显式合法；`mode!=='audit-only'`（如 `enforce`）直接拒绝；重复 enable 拒绝。
- 回滚：`disable()` 把描述恢复为默认对象（`toEqual(DEFAULT)`），幂等。
- **零生产接线（静态证明）**：扫描 `src/**/*.ts` 中 `from '...synthesized-tests'` 的 import，结果为空；`src/index.ts` 不含 `createSyntheticTestTrustLayer`。因此"默认配置下行为与今日一致"是构造性的，不依赖运行时开关。

---

## 3. `ci-04|2|2` noop：新性质诊断

### 3.1 历史事实（该用例**存在**）

首害决策点：**task ci-04 / run 2 / round 2**，基线选择 `noop`（support 0，Q=null，V=0.266687，A=0，z'=-0.10199，KL=0.122363），覆盖率由先验 **1.000** 落到 **0.667**；池指纹链 `be05e090 → 73ba2b59 → 650d0bfa`。来源：`docs/reports/p61-eval-negative-result-explanation.md`（firstHarmfulDeviation / §2.2）、`docs/reports/p62-review-round1-pr-b.md` §1。**本报告不重复"该用例尚不存在"之类的说法；它存在，本层做的是给它加诊断。**

### 3.2 诊断定义与行为

`diagnoseBaselineFrozenCase(case)` 对 `source='baseline-frozen'` 的案例返回：

| 字段 | 值（ci-04 夹具） | 含义 |
| --- | --- | --- |
| `frozen` | `true` | 期望值抄自基线观测 |
| `frozenActionKey` | `'noop'` | 被固化的基线动作 |
| `wouldRejectDeviations` | `true` | 任何偏离 noop 的候选都会被这条"测试"判失败 |
| `discriminating` | `false` | 不能区分改进（橡皮图章） |
| `freezesHarmfulBaseline` | `true`（0.667 < 1.000） | 固化的是一次**有害**选择：修复基线的候选反而被判红 |
| `evidence` | `{taskId:'ci-04', run:2, round:2, actionKey:'noop', support:0, ...}` | 历史观测 |

行为：这类案例**被排除出校准分母**（population 单独计数，见 §4），因此它不能把"基线行为"洗成"测试通过"。

### 3.3 负控制：证明"没有错误固化"是可测的

把检测短路（`if (true) { // NC1 MUTATION: detection disabled`）后重跑：**5 条用例红**，其中直接命中的是：

- `diagnoses the frozen case as NON-discriminating and HARMFUL to freeze`；
- `excludes baseline-frozen cases from calibration denominators and counts them`；
- 连带 `computes the pinned confusion matrix...` / `publishes its own label...` / `fails calibration when recall/FP...`（分母被污染后 pinned 值不再成立）。

按字节还原后 sha256 与变异前**逐字节相同**，重跑 49/49 绿（§6 完整证据）。

---

## 4. 校准报告（实测）

### 4.1 校准通过（development 案例）

```
confusion: { tp: 5, fn: 1, fp: 0, tn: 4 }
population: { labeledCases: 10, bugPresentCases: 6, bugAbsentCases: 4,
              excludedBaselineFrozenCaseIds: ["ci-04-2-2-noop-baseline"],
              excludedHoldoutCaseIds: ["p5-holdout-a1", "p5-holdout-p1"] }
verdict: "calibrated"   reasons: []
reportDigest: sha256:201d6925718084d134669a13587791afa55323e500603390f485a28df2413817
testSetDigest: sha256:25dd1215f7d2bbf8572d930d96d57c55c939a89416235f1df1793020964136e6
```

| 指标 | 值 | 阈值 | 状态 |
| --- | --- | --- | --- |
| failure-recall（TP/6） | 0.833333 | ≥ 0.8 | pass |
| false-positive-rate（FP/4） | 0 | ≤ 0.1 | pass |
| misjudgment-rate（(FP+FN)/10） | 0.1 | ≤ 0.2 | pass |
| failure-miss-rate（FN/6，信息项） | 0.166667 | — | — |

### 4.2 校准失败与证据不足（两条必须能拒绝的路径）

| 输入 | verdict | 关键读数 |
| --- | --- | --- |
| 2 个漏报 + 2 个误报（`failingDevelopmentResults`） | `failed` | recall 0.666667（fail）、FPR 0.5（fail）、misjudgment 0.4（fail），reason `calibration-threshold-failed` |
| 只有 3 条结果 | `uncalibrated` | reasons `insufficient-labeled-cases` + `calibration-incomplete`；全部指标 `not-computable` |

---

## 5. 执行证据（命令 / 退出码 / 关键输出）

| # | 命令 | 退出码 | 关键输出 |
| --- | --- | --- | --- |
| E1 | `node node_modules/typescript/bin/tsc --noEmit` | 0 | 0 error |
| E2 | `pnpm exec vitest run tests/unit/verification`（等价的 node 直调亦已跑） | 0 | 6 files / **148 tests** 全过（其中 p5 套件 49） |
| E3 | `node node_modules/vitest/vitest.mjs run`（plain，多次） | 0 | **130 files / 2431 tests** 全过（plain 3/3 次；JSON reporter 2 次中 1 次命中 §8.1 的预存在 flake，复跑全绿） |
| E4 | `node scripts/eval/check-encoding-policy.mjs` | 0 | SUCCESS（LF/BOM 策略） |
| E5 | `node scripts/eval/smoke-build.mjs` | 0 | SUCCESS（bundle 构建 + ESM 导入；required exports 保留） |
| E6 | `node scripts/eval/negative-result-diag.mjs --assert` | 0 | A1..A6 PASS — 历史负结果原样保留 |
| E7 | `node scripts/eval/guarded-regression.mjs --json` | 0 | 受保护探针全过 |
| E8 | `pnpm run check:docs`（两次） | **1** | ①**计数红**（套件 0 failed/0 pending）：README 103 files/2094 vs 实际 **130 files/2431**（unit 116/2263、e2e 14/168）——README 由 lead 刷新，本任务未改；②**flake 红**：内层 `pnpm exec vitest run --reporter=json` 退出 1（1 failed / 2431，`tests/unit/p62/evidence-gates.test.ts:371`），gate 打印 `Unexpected error during verification`，在计数比较**之前** abort。两次都不是本任务改动造成，详见 §8.1 |

### 5.1 端到端评估实测（calibrated + 宿主回执）

```json
{ "layer": "synthesized-tests/v1", "auditOnly": true, "taskQualityEligible": false,
  "content":   { "trust": "calibrated", "testSetDigest": "sha256:25dd…", "calibrationReportDigest": "sha256:201d…", "reasons": [] },
  "execution": { "trust": "host-verified", "caseCount": 11, "receiptDigest": "sha256:ccb4…", "runId": "run-p5-final", "verifierId": "host-runner-p5", "verifierVersion": "1.0.0", "scope": "development", "reasons": [] },
  "provenance":{ "freezeOrderOk": true, "generatorIsolated": true, "holdoutFirewallOk": true, "baselineFrozenCaseIds": ["ci-04-2-2-noop-baseline"], "harmfulBaselineFrozenCount": 1, "reasons": [] } }
```

| 场景 | `content.trust` | `execution.trust` | task-quality 闸门 |
| --- | --- | --- | --- |
| calibrated + verified + clean provenance | calibrated | host-verified | `allowed:false` / `audit-only-v1` |
| verified 但无校准报告 | **uncalibrated** | **host-verified** | `allowed:false` / **`content-uncalibrated`** |
| 校准失败（阈值未过） | uncalibrated | host-verified | `content-uncalibrated` |
| 同生成者 / 候选早于冻结 / holdout 泄漏 | **revoked** | host-verified | `content-revoked` |
| calibrated 但无回执 | calibrated | unverified | `execution-unverified` |

### 5.2 文件指纹（工作树 sha256）

| 文件 | sha256 | 字节 |
| --- | --- | --- |
| `src/verification/synthesized-tests.ts` | `3ef949ec427e8b3e79a53b688e49a4b2c5b6b3728fedf3078ab1a967712f5e0a` | 57582 |
| `tests/unit/verification/p5-synthetic-trust.test.ts` | `bb8a94c8d7c2d49740d008619fe480c9f75ae60f7dd28ae4579a2d5d000b1341` | 35136 |
| `tests/fixtures/p5-synth/p5-synth-suite.json` | `e4ceb8933579bd98294af508816b003b58b2aefeebfe993bb015dedc68856521` | 5307 |
| `tests/fixtures/p5-synth/p5-synth-ci04-baseline-frozen.json` | `7317cc80bc52b51d75951bbf5a716257333a074d19612f4b38265f278cbd4474` | 978 |
| `tests/fixtures/p5-synth/p5-synth-selection-clean.json` | `0f9680f2c679cdb52773eae6cca0d706df169d03154853a6dccac6a9d93c2d5f` | 204 |
| `tests/fixtures/p5-synth/p5-synth-holdout-leak.json` | `fcc5f6efe0e44e9bf8b6195a79caaac9e041a8d2b318951dd73d7569006fbe36` | 215 |

> 说明：以上文件在当前工作树为未跟踪文件（`git status` 的 `??`），故用工作树 SHA-256 固定；正式 blob 指纹须在提交后按 R2 规则取。

---

## 6. 负控制（实测红 → 字节还原 → 绿）

变异前模块 sha256 = `3ef949ec427e8b3e79a53b688e49a4b2c5b6b3728fedf3078ab1a967712f5e0a`；两次还原后均与变异前**逐字节相同**。

| # | 变异 | 实测结果 | 还原后 |
| --- | --- | --- | --- |
| NC1 | `diagnoseBaselineFrozenCase` 的检测短路为 `if (true)`（模拟"错误固化基线行为"） | **5 failed / 44 passed**：`diagnoses the frozen case as NON-discriminating and HARMFUL to freeze`、`excludes baseline-frozen cases from calibration denominators and counts them`、`computes the pinned confusion matrix…`、`publishes its own label…`、`fails calibration when recall/FP…` | sha256 IDENTICAL → **49/49 绿** |
| NC2 | `gateSyntheticResultForTaskQuality` 删除 content-trust 判定（让"执行可信"冒充"内容可信"） | **2 failed / 47 passed**：`EXECUTION VERIFIED + CONTENT UNCALIBRATED is a legal state, and the gate blames the CONTENT`、`a failed calibration is NOT content trust (and not execution blame)` | sha256 IDENTICAL → **49/49 绿** |

**结论**：两条验收判据（"未校准结果无法进入 task-quality"、"不把执行可信误作内容可信"）不是文档承诺，而是**删掉实现就红**的可判别用例。

---

## 7. 未执行项与授权

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 真实宿主 smoke / 真实 runner 回执 | **未执行（需授权）** | 本层只消费回执结构，不生产真实回执；回执由宿主 runner 侧（C2a）提供 |
| 真实付费模型调用 / 外部工具 / 记忆写入 | **未执行（需授权）** | 全部证据来自离线夹具与纯函数 |
| 把 enable 接线到生产（orchestrator / host trigger） | **未执行（按 v1 设计）** | v1 是 audit-only；接线需要新授权与新层版本（见下） |
| `pnpm run check:docs` | **repo 级红（非本任务缺陷）** | 两次实测（见 §5 E8）：①套件 0 failed/0 pending 时，失败**仅**因 README 计数漂移（103/2094 → 130/2431）；②另一次在计数比较**之前** abort（内层 `pnpm exec vitest run --reporter=json` 退出 1，命中的是 §8.1 的预存在 flake）。README 由 lead 统一刷新（本任务未改） |
| **提交后重录 blob 指纹** | **待办（提交后）** | 本报告 §5.2 的 SHA-256 是工作树字节（当前文件均未跟踪）。提交后必须按 R2 规则改为 `git rev-parse <rev>:<path>` / `git cat-file blob` 的 blob id，并复核 `pr4a` 式的 blob 指纹表；在那之前 §5.2 只能作为本地一致性核对，不能作为正式指纹证据 |
| `tests/unit/p62/evidence-gates.test.ts` 的偶发失败 | **预存在 flake（非本任务引入）** | 见 §8.1：同一提交下 5 次全量运行中 1 次该文件的临时 git 仓库用例抛出无消息错误；单文件隔离 43/43、plain 全量 2/2、JSON 复跑均绿。不归本任务，但 verifier 若遇 check:docs 在计数比较**之前**失败，应先看这条 |

**授权申请文本（真实回执/真实执行）**：

> 申请以真实宿主 runner 对 `synthesized-tests/v1` 的 development scope 执行一次离线合成测试（12 组件级案例，无真实模型调用、无外部工具、无记忆写入），产出真实回执并验证 §2.3 的六项绑定；执行前须确认：suite digest 已冻结、holdout 防火墙通过、本报告 §4 校准阈值未修改。若需要 `enforce`（把本层结果用于任何在线质量决策），必须另立新层版本并重新预注册；v1 不提供该能力。

---

## 8. 遗留风险与边界（如实登记）

1. **预存在的 flake（不是本任务引入）——已给出归属与处置路径**：`tests/unit/p62/evidence-gates.test.ts` 的临时 git 仓库用例在 5 次全量运行中出现 **2 次**无消息异常（`Error: STACK_TRACE_ERROR`，发生在该 test body 内，:371 `PR-1 encoding-policy gate distinguishes the tracked state from the untracked state on IDENTICAL policy bytes`）。同一代码下：
   - 单文件隔离：**43/43 通过**（66.4s）；
   - plain 全量：**2/2 次 130 files/2431 全绿**；
   - JSON reporter 全量：首次 1 failed，复跑 **130 files/2431 全绿**。
   **归属**：`tests/unit/p62/evidence-gates.test.ts` 是 P6.2/PR-1 的既有资产，当前 roster 没有它的属主；本任务只读。该 flake 应归 **t12 集成/收尾轮（verifier）作为"门禁稳定性"事项**，并在需要改代码时由 t12 申请授权（文件不在本任务写入范围）。
   **何时修**：**在 lead 刷新 README 计数之前**。否则 `check:docs` 的重铸结果不可信——你无法区分"计数漂移红"与"flake 红"（本报告已两次遇到后者）。
   **修法（按优先级，均为该文件内的小改动）**：
   1. **先让失败可诊断**：把 test body 内的 `execFileSync('git', ...)` / `checkEncodingPolicy(...)` 包一层 try/catch，捕获后 `throw new Error(cmd + ' failed: ' + stderr)`；当前无消息异常被 reporter 序列化成 `STACK_TRACE_ERROR`，等于把根因吞掉——没有这一步，后续修复只能靠猜；
   2. **彻底隔离临时仓库**：`makeRepo` 已用 `mkdtempSync`（路径唯一），但 env 只删了 `GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/GIT_ALTERNATE_OBJECT_DIRECTORIES`；应再设 `GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=<空文件>`、删 `GIT_CONFIG_PARAMETERS`、`GIT_TERMINAL_PROMPT=0`，并把 `git clone repoRoot` 的用例与其它临时仓库用例合并到 `describe.sequential`（或该文件单独 `--no-file-parallelism`）——嫌疑是并发负载下 repoRoot 的 `.git` 与临时仓库的 git 进程竞争；
   3. **不要用静默重试掩盖**：若临时加 `retry: 1`，必须在报告里单列 `retried` 计数；重试只降低阻塞，不消除根因。
   **复现判据（供 verifier）**：plain 全量 3/3 绿；JSON reporter/check:docs 内层 2 次命中同一用例；单文件隔离 43/43 绿。若 `pnpm run check:docs` 输出 `Unexpected error during verification ... vitest run --reporter=json`，先看本条，不要先怀疑 README。
2. **真实执行证据缺口**：本层消费回执**结构**，不生产真实回执。真实宿主 runner 对合成测试的执行 = **未执行（需授权）**（§7 申请文本）。因此"执行可信"在真实环境中的端到端证明留待授权轮。
3. **校准不具备统计功效声明**：10 个 labeled development 案例、6 个 bug-present，只能支撑"该合成集上的召回/误报点估计"，不能外推为"测试生成器普遍可靠"。报告按 P2-C 的纪律不给区间/功效声明（校准是层准入条件，不是统计结论）。
4. **holdout 的实际终检**：v1 只提供 holdout 防火墙与"holdout 不进校准分母"的结构约束；真正的 holdout 终检（对最终候选单次执行）不在本任务范围（audit-only）。

## 9. 签核清单

- [x] 独立信任层 `synthesized-tests/v1`，audit-only；不扩展 `LEARNING_TRACKS`（测试断言）；
- [x] 测试内容在候选生成前冻结：`frozenAt` 进入封印、候选 `createdAt` 严格校验、候选自写案例可检测；
- [x] 宿主可重算的 `sha256:<64hex>` 摘要（content/testSet/case/receipt/report 五种）与回执绑定（layer/digest/scope/caseIds/verdict）；
- [x] 校准四项齐备：失败召回、误判率、生成者/候选隔离、测试集来源；误判率有本仓自定分母与标签（§2.4）；
- [x] 混淆矩阵给出（§4.1），分母单位写明；
- [x] `ci-04|2|2` noop 诊断：引用其历史存在性、识别"固化有害基线"、排除出校准分母；NC1 实测红（§3.3/§6）；
- [x] 未校准结果无法进入 task-quality：`gate` 无 allow 分支 + NC2 实测红；
- [x] 执行可信 ≠ 内容可信：类型见证 + 实测合法状态 + 闸门归因 `content-uncalibrated`；
- [x] 默认关闭、显式授权、可回滚；零生产 import（静态证明）；
- [x] tsc 0；verification 6 files/148、全量 130 files/2431 全绿；encoding/build-smoke/negative-result/guarded-regression 全 0。
