# P6.2 PR-B 评审报告（round 1）

- 评审任务：t15「P6.2-PR-B 评审（round 1）」（kind: review，被评审任务 t11）
- 评审人：gate-reviewer-r2（接续原 gate-reviewer；应用重启后接手，评审从头独立执行，未采信前一评审人的任何中间记录）
- 实现者：verifier-steward（t11，attempt 1）
- 日期：2026-10-25（Asia/Shanghai）
- Verdict: **PASS**

## 0. 绑定（HEAD、diff 指纹、关键文件 sha256）

- 仓库 HEAD（基线，与 P6.2 任务声明一致）：`e0be51dbc06d86ccb8b681c0385129696e1e2803`（`e0be51d`）
- 工作树相对 `e0be51d` 的完整 diff 指纹：
  - `git diff e0be51d | git hash-object --stdin` = `b1358fbc79c5c6839e36a4df018855713daec374`
  - `git diff e0be51d` 全文 SHA-256 = `3994183881a7cbf071fbc2e6336450fea30e15f3123bdeccf955ab5e107e5174`
- diff 覆盖 22 文件（+2175/−139），其中 PR-B 核心 11 文件（见下表）+ PR-A（t10）13 文件 + t19 的 `tests/e2e/eval-cli.smoke.test.ts`（Windows 可移植性，PR-B 字节之外，全量测试含其 6 条全绿，不破坏）。
- 关键文件 SHA-256（评审时点）——与 t15 `verdictStartSnapshot`（t11 完成时刻由系统记录的指纹）**逐字节一致**，即本评审对象正是 t11 交付的 PR-B 字节：

| 文件 | SHA-256（前 16） | = snapshot |
|---|---|---|
| src/jitrl/reward-contract.ts | `845f40a693118d79` | ✅ |
| src/jitrl/step-evaluator.ts | `eeb20b1f6c123db2` | ✅ |
| src/jitrl/value-estimator.ts | `64667ccd1929d43f` | ✅ |
| src/orchestrator.ts | `81c7000afabbd1ad` | ✅ |
| src/jitrl/action-normalizer.ts | `443bc756fc51a2e7` | ✅ |
| tests/unit/orchestrator/prb-trusted-verification.test.ts | `ad4b405635eb1e3d` | ✅ |
| tests/unit/jitrl/step-evaluator.test.ts | `91e3a726c79abffe` | ✅ |
| tests/unit/jitrl/value-estimator.test.ts | `6803e53e8463e97f` | ✅ |
| tests/unit/jitrl/action-normalizer.test.ts | `2d0d7429c4420a7c` | ✅ |
| tests/unit/orchestrator/p3-proposal-select.test.ts | `a381dcdf1cc5dc93` | ✅ |
| tests/unit/orchestrator/credit-attribution.test.ts | `1b47072a0ceef509` | ✅ |

评审期间 PR-B 文件未被触碰（评审人复算哈希前后一致；并行的 PR-C 任务 scope 与上述文件不相交）。评审人自己的复放脚本放在 `work/p62-review-r2/`（vitest 排除区），评审完成后已删除，`git status` 无残留。

## 1. 首害反例 ci-04|2|2 独立复放（全链 orchestrator 路径）

评审人自建 harness（mock proposer/optimizer/seams + 真实 `createDiscoveryTreePool` + 注入 now/newId），把评审台账的 ci-04|2|2 决策形状（prior=guardrails append，support=2、负优势 −0.4——相对压制情形；challenger=noop，support=0、A=0 回退伪迹；optimizer 提议 noop，即修复前的缺陷行为）灌入 **`EvoHarnessOrchestratorImpl.run()` 全链**（非仅单元层 conservativeAdvantage），结果 **20/20 全绿**：

| 检查 | 结果 |
|---|---|
| gate ON：`jit_proposal_select` 决策发生 | PASS |
| gate ON：veto 诊断 `conservative gate fell back ... rejected: implicit-zero-advantage` | PASS |
| gate ON：**实际执行的探针是 prior patch**（guardrails 编辑，非 noop） | PASS（probes=[r2-prior]） |
| gate ON：L2 记录带 decisionPriorIndex=0 / decisionProposedIndex=1 / decisionExecutedIndex=0 | PASS（**attempted 与 executed 分列**） |
| gate ON：record_experience 台账 attemptedDeviations=1、actualDeviations=0 | PASS |
| gate ON：semanticKind=['constructive'] 随记录 | PASS |
| gate OFF（默认）：同一形状**不被拦截**（无 veto 诊断，noop 真的执行了，台账 attempted=1/actual=1 如实） | PASS |
| gate OFF：executed probe 就是 noop（空 edits） | PASS |
| 探索预算：默认 0（fail-closed）、grant(2)/revoke 显式、非正 grant 为 no-op、`EXPLORATION_BUDGET=0` 类常量 | PASS |
| 无支持非零 challenger（skills mount，A=+1.2）：预算 0 → gateReason='exploration-budget' 回退先验（无隐式探索路径）；授予预算 1 → 执行且 rewardSources.exploration=1、预算计费至 0 | PASS |

（复放探针与交付测试字符串完全不同；探针脚本已删除，关键输出已摘录于本报告。）

## 2. 错误交付探针（新鲜 canary，非交付测试字符串）

canary 交付文本（评审人自造，含中文）：「评审金丝雀 r2：这份交付内容详尽、语气笃定，但完全未满足验收准则 canary-7f3a」，verifierId `r2-canary-judge`。经 `scoreUnderRewardContract`（在线记录同一标尺）：

- `sources.completion === -1`（VERIFICATION_FAILED_SIGNAL，非 +1）✅
- `reward === 0`（词典序钳：completion −0.5 + tool/steps 正项本可为正 → 钳 ≤0）✅
- `learningEligible === false`、`taskSuccess === false`、`executionSuccess === true`（分列正确）✅
- 无验证时同一非空交付 completion=0（过程观测，不加分）✅
- fail-closed 载荷校验：字符串/部分对象/bad checks/空 verifierId/未知 status/null 六种畸形形状全部拒绝；畸形显式载荷回退结构派生（永不 passed）✅

对照 P6.1 证据包源探针（reviewer.test.ts:919-923：非空错误交付 → completion=1、reward>0）：**缺陷行为已消除，方向反转正确**。

## 3. n_eff / shrinkage / 固定尺度校准（小支持差异用例）

- Kish n_eff：[1, 0.01×9] → **1.1870**（非 10；交付称 ≈1.19 属四舍五入，实测略低，判别结论不变）✅；均匀 [1,1,1,1] → 4 ✅；空/全零/负权 fail-closed（负权跳过，[-1,2]→1，非混入）✅
- 小支持噪声：A=0.06、n_eff=2 → shrunk=0.06·2/4=0.03、calibrated=0.03/3=**0.01**——比 max|A| 归一化（同样本池下 0.06/max|A|≈1.0 可放大 ~16 倍）低两个数量级，小样本噪声不再被放大成强改选 ✅
- 上界映射：raw ±3 → shrunk 1.5 → calibrated ±0.5（有界）✅
- 证据地板（minEffectiveSamples=2）：n_eff=1 的 thin-but-measured challenger shrunk=0、hasReplacementEvidence=false（建议与替换分离——只能打平不能赢）✅
- estimate.nEff 缺省回退 support ✅
- 冻结面核实：`normalizeAdvantages`（max|A|+ε）保留在 decision-kernel 冻结路径（论文复现/parity 测试钉住），conservative 层是**加性**的（value-estimator.ts:355-359 注释明确）——与交付声明一致 ✅

## 4. 八场景回归矩阵判别力抽查（评审人自有载荷）

伪造成功（succeeded+failed → ≤0 且 ineligible）、空交付（MISSING −1，且仍低于未验证非空交付 0.4167>0 的排序）、部分通过（checks 一真一假 → 整体 refuted ≤0）、真实通过（+1、reward>0、taskSuccess=true、eligible）、timeout（矛盾 passed 降级 unknown、无 completion、taskSuccess=false）、**infra error**（EvoHarnessSeamError 白名单名 → infrastructure_error、reward=0、ineligible；ECONNREFUSED 消息路径同样命中；**自造错误名+非传输消息不误标 infra**——保持可归因，窄白名单是设计使然且方向正确）、padding（31 次调用不高于 2 次）、词典序（efficientWrong 1 步 1 调用零错误仍 ≤0）。全过 ✅。

交付测试矩阵（prb-trusted-verification.test.ts 场景 1-8 + 词典序 + 分列 + fail-closed 3 条）代码走读与上述独立抽查语义一致。

## 5. 改选率诚实性与默认形态实际防线

- `conservativeGate` 默认 off 属实：`EvoHarnessOrchestratorImpl` 构造 `deps.conservativeGate === true` 才开（orchestrator.ts:847）；src/index.ts 默认插件装配**无** conservativeGate 接线（grep 证实）；评审人全链复放 gate OFF 时同一首害形状**真的未被拦截**（§1 表第 7-8 行）——即「0% 改选」并未被美化成默认形态已拦截。
- 默认形态的实际防线是**奖励侧（verifier-first 计分）独立消除首害驱动**：ci-04|2|2 的环境形状（noop 选中 → 覆盖 2/3 → verifier FAILED + succeeded + 非空交付）在 r4 语义下 reward=0、learningEligible=false（§2/§6 复放证实）——强化 noop 的那条正回报记录不再存在。台账机制证明（veto 复放 + 奖励侧双通道）成立。
- 在线对照：评审人经 eval harness 独立复算 B1/B3（3 episodes，确定性合成 runner）：**B3 avg=0.963 ≥ B1 avg=0.8889**（solvedRate 0.8889 vs 0.6667）——与交付声明数字一致，在线臂无退化（t11 验收第十条的机制证明第二路径成立）。
- 防退化 ≠ 收益：diag 复跑（§7）显示 frozen 对照的历史负收益仍在（重放框架范围外），交付说明将其如实标注为「机制证明」而非「任务已不再退化」。诚实。

## 6. 实现核实（代码走读要点）

- **TrustedVerification**（step-evaluator.ts:466-607）：status/verifierId/verifierVersion/evidenceHash/checks/implicit 完整；`isTrustedVerification` 结构 fail-closed；`deriveStructuralVerification` 永不 passed（claimed-success-without-deliverable 才 failed）；`verificationFromTrajectory` 显式优先 + 矛盾（failed 执行上的 passed）降级 unknown。
- **completion 由判定决定**（:715-731）：passed→+1、failed→−1、unknown→0（succeeded 无交付仍保历史 MISSING −1）；failed 词典序钳 reward≤0（:751-753 与 scoreUnderRewardContract:170-171 双层）；taskSuccess/executionSuccess 分列（:768-769）。
- **conservativeAdvantage**（value-estimator.ts:368-471）：n_eff=(Σw)²/Σw²、shrinkage A·n_eff/(n_eff+k)（k=2）、ADVANTAGE_SCALE=3 固定尺度、implicitZeroAdvantage 标记、地板下 shrunk=0。
- **orchestrator 门**（:2533-2591）：双侧证据比较（challenger 与 prior 都过 conservativeAdvantage）；veto 硬分支（zero-advantage/noop 伪迹 + prior 有证据）→ gateReason='implicit-zero-advantage'；exploration 仅显式预算；thin-but-measured 执行并携带建议强度；三记录恒上报（:2654-2662，含无偏离情形）。
- **台账**（:2012-2021, :2152-2196）：rewardSources 携带 decisionPriorIndex/decisionProposedIndex/decisionExecutedIndex/exploration；record_experience detail 报 l2Decisions/attemptedDeviations/actualDeviations/explorationCharged/semanticKinds/verifierFirstRule。
- **语义键**（action-normalizer.ts:299-371）：semanticEditKindOf 按 payload 形状分 constructive/destructive/neutral（guardrails forbid→destructive、append/precondition→constructive；system_prompt replace→destructive）；normalizeSemanticActionKey = surface+kind+targets；append vs forbid 同 surface 不同键；actionKeyConflictRate 正反例碰撞率探针（测试断言 within>0、across=0）。**持久键未切**：orchestrator.ts:2378-2385 明确在线仍用 slot-shape 签名、语义键仅作台账标记（词表切换归发布 PR）。

## 7. 负收益诊断复跑与三条诚实边界的独立判断

`node scripts/eval/negative-result-diag.mjs --json` → **exit 0**，输出完整：

- 历史复现框架：meanDelta=**−0.25**（matchesHistorical=true），退化任务清单 **不变**（ci-04/mig-01/mig-02/mig-04/test-03，degradedTaskShare 0.4167）——交付如实声明该框架属 scripts/eval 范围外未改。
- firstHarmfulDeviation 仍为 **ci-04|2|2**（noop、support=0、v=0.266687、verifierRewardMismatch=true）；deviationStats：36 deviations、18 harmful、**gateFired=0**（默认 off 如实，未美化）。
- offlineCounterfactual 单独记账（合成表、不进公平臂预算、不给未执行候选补 LLM 猜测 reward）。

三条实现者诚实边界：

1. **r4 未 bump（PR-C 必办，非 blocker）**：`CURRENT_REWARD_VERSION` 仍 `r3/unified-signals-v1`（experience-store.ts:82）。语义一致性核实：在线记录的数值由 `scoreUnderRewardContract`（verifier-first 语义）产生（orchestrator.ts:2036-2038），r3-stamp 下的含义已由 reward-contract.ts:36-97 的契约文档更新（completion 语义改为 verdict 决定，REWARD_CONTRACT_VERIFIER_FIRST='verifier-first-completion-v1' 标记随记录/台账携带）；数值域（权重、clip ±3）未变，learningTarget 仍同尺对比（baseline 与候选同一聚合）。版本号切换会造成 r3 历史记录与 r4 新记录语义断代——预注册 r4/verifier-first-v1 + **双向空认证表**（reward-contract.ts:570-583）已把该断代钉死（r3↔r4 除 r4 自算的 rescore 副本外互不兼容），PR-C 采纳时旧 r3 邻域自动被 PR-A 谓词排除。**遗留风险**：在 PR-C bump 之前写入的 r3-stamp 记录混合了两种 completion 语义（旧记录奖励文本存在、新记录奖励 verdict）——过渡窗口内 r3 邻域存在语义异质，属已知且已声明，收窄窗口是 PR-C 的责任。判定：如交付所述为 PR-C 必办项，非本 PR blocker。
2. **diag 退化任务历史复现仍在**：如上，−0.25 与五个退化任务如实复现；防退化按验收第二路径（机制可证明生效）交付：评审人独立复放 veto 台账（§1）+ 奖励侧独立拦截（§2/§5）+ B3≥B1 在线对照（§5）——三证齐备。判定：成立。
3. **持久 action-key 词表切换归 PR-C**：orchestrator.ts:2378-2385 注释+代码核实（在线键仍是 normalizePatchSignature；semanticKind 作为 decision mark 落 rewardSources/台账）。冲突率测试钉住语义键判别力。判定：边界划分清晰，成立。

## 8. 门禁复跑（评审环境）

| 命令 | 结果 |
|---|---|
| `pnpm run typecheck` | exit 0，tsc --noEmit 零错误 |
| `pnpm test` | exit 0，**76 文件 / 1509 测试全绿**（PR-A 基线 1471 + PR-B 新增 38） |
| `node scripts/eval/negative-result-diag.mjs --json` | exit 0（详见 §7） |

## 9. Findings

无 blocker，无 needs_revision。

- **F-B1（informational，PR-C 提示）**：conservativeGate 默认 off 期间，首害形状的拦截依赖奖励侧（verifier-first 计分）单通道在线生效；veto 通道（gate）默认不可达。这是交付明确声明的过渡形态，但 PR-C 若不启用 gate 也不 bump r4，双通道防线只剩单通道常驻——建议 PR-C 评审（t16）显式核对发布形态下哪几道防线实际在位。
- **F-B2（informational，PR-C 必办确认）**：r3-stamp 过渡窗口的语义异质（同版本号下 completion 两种含义）随每次在线写入累积；PR-C bump r4 时应同时评估存量过渡期 r3 记录是否需要隔离或 rescore（预注册的 r4@rescore-v1 通道已备好）。
- **F-B3（informational，数值口径）**：交付说明「10 条权重集中 n_eff≈1.19」实测 1.1870（四舍五入差异，不影响判别）；「B3 0.963≥B1 0.8889」评审人独立复算一致。
- **F-B4（informational）**：infra 白名单窄（两个错误名 + 传输 errno 正则）：自造错误名不会误标 infra、保持负样本可归因——这是正确方向的设计选择，此处仅记录其判别边界（调用方需用白名单名或 errno 消息才能触发 audit-only 路径）。

## 10. 结论

PR-B（t11，F3 可信验收 + F4 保守改选）的九条验收契约在独立复放下全部成立：verifier-first 语义与 fail-closed 载荷校验实现正确；首害反例 ci-04|2|2 在 gate 开启时被 veto 且台账 attempted/executed 分列、gate 默认 off 如实未拦截、奖励侧独立消除其正回报驱动（B3≥B1 在线复算确认）；n_eff/shrinkage/固定尺度消除小噪声放大；八场景矩阵判别力抽查全过；三条诚实边界划分清楚且 r4 预注册已把版本断代钉死；三门禁全绿。**Verdict: PASS**——t11 通过，t12（PR-C）可继续（其已在进行中），t16（PR-C 评审）解锁条件不受本报告影响。
