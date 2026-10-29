# P3-B 交付报告：统一 MeteredModelAdapter 与调用边界静态门（t5，attempt 1）

- **状态**：完成
- **日期**：2026-10-29
- **写者**：p3-metering（P3 全阶段计量工程师）
- **上位契约**：docs/reports/p2-p6-remaining-work.md §4 P3-B、ADR-0003 §7（三态计量）、ADR-0004（C3 计量契约）、t4 交付（src/ledger/assembly.ts 装配路径）

---

## 1. 问题（改动前）

生产侧 9 处 `.complete(` / 1 处 `.planNext(` 全部**直接调用**注入的 IModelAdapter，没有统一计量边界：

| 调用点 | purpose（改前） | 问题 |
| --- | --- | --- |
| src/dsh-bridge/branch.ts:324 | **'compose'** | **probe 被误标为 compose**——探针分支执行的是候选脚手架，路由/用量统计会把候选执行当评审判分 |
| src/harness2/proposer.ts:778/891 | 'propose' | 无计量、无调用记录 |
| src/harness2/composer.ts:623 | 'compose' | 同上 |
| src/harness2/reflector.ts:622 | 'reflect' | 同上 |
| src/dream-rsi/offline-dreamer.ts:1890 | 'dream_policy' | 同上 |
| src/jitrl/step-evaluator.ts:1000 | 'evaluate_steps' | 同上 |
| src/jitrl/logit-sources.ts:205 | 'probe' | 同上（capability probe） |
| src/dsh-bridge/agent-loop-executor.ts（bind 后调用） | 'probe' | 已由 t4 ledger 计量，但方法绑定逃逸了 .complete( / .planNext( 文本扫描 |
| src/index.ts:2051 | — | 惰性 holder 转发（非调用点） |

## 2. 实现

### 2.1 统一边界：`src/dsh-bridge/metered-model-adapter.ts`（新增）

| 导出 | 作用 |
| --- | --- |
| `createMeteredModelAdapter(model, stage, options?)` | **唯一**受支持的生产调用入口；stage 必填且决定期望 purpose |
| `STAGE_PURPOSE` / `STAGE_LEDGER_PHASE` | 阶段→真实 purpose / 台账 phase 的单一映射表（7 阶段） |
| `ModelCallRegistry` | 调用记录注册表（有界 ring 5000，丢弃可见）；**运行时计数门** |
| `globalModelCallRegistry()` | 进程级默认注册表：生产 stage 未注入 registry 时也必须可追溯 |
| `recordsForStage(registry, stage)` | 按阶段读取记录（status 面用） |
| `MeteredModelError` | 具名失败码：PURPOSE_MISMATCH / BUDGET_DENIED / AMBIGUOUS_LEDGER |

adapter 行为（每次 `call()`）：

1. **purpose 强制**：`request.purpose !== STAGE_PURPOSE[stage]` → 抛 METERED_MODEL_PURPOSE_MISMATCH 并记录 purpose_mismatch（这就是 probe-as-compose 的运行时防线；测试对 7 个 stage 逐个证明拒绝）。model 调用前即失败，provider 零调用。
2. **一次调用一条记录**：成功 / 模型失败 / 预算拒绝三条路径都恰好记录一条 ModelCallRecord（stage、purpose、ledgerPhase、outcome、durationMs、reserved/incurred、provenance、error），并同时进 stage 私有记录与注册表。
3. **可选 ledger 计量**（复用 t4 装配路径）：启用后 reserve→调用→settle；usage 取 response.metadata 的 rawUsage+countingSemantics，**语义缺省即剥离**（provenance 'unknown' + 保守地板），绝不冒充 measured；无 ledger 时 provenance 'none'、metering 'unmetered'，成本为 0 且不伪装。
4. **费率卡/参数从装配解析**：estimatedCostMicros（默认 10_000u）、routeId、rateCard；ledger 与 ledgerManager 同传构造期拒绝（与 t4 一致）。

### 2.2 阶段接线（全部经 `.call()`，生产侧不再出现 .complete()）

| 文件 | 改动 |
| --- | --- |
| src/dsh-bridge/branch.ts | **purpose 'compose'→'probe' 修复**；经 metered 边界；新增 metering?: 选项与 metering: 状态行 |
| src/harness2/proposer.ts | 2 处调用点经 .call()；新增 metering?: 选项 |
| src/harness2/composer.ts | 1 处；同上 |
| src/harness2/reflector.ts | 1 处；同上 |
| src/dream-rsi/offline-dreamer.ts | 1 处（createModelPolicyGenerator）；同上 |
| src/jitrl/step-evaluator.ts | 1 处（LLM judge）；同上 |
| src/jitrl/logit-sources.ts | 1 处（capability probe）；同上 |

## 3. 静态门：`scripts/eval/metering-coverage.mjs`（新增）

- **扫描模式**（TypeScript 编译器 API AST，注释/字符串不可能伪造命中）：.complete( 与 .planNext(，**外加** .complete.bind( / .planNext.bind(（绑定逃逸口，覆盖 agent-loop-executor 的 P3-A ledger 路径）。
- **允许列表**：DEFAULT_ALLOWLIST 常量，每项 { file, symbol, expectedCount, reason }，**双向严格**：未覆盖的命中 → FAIL（新未计量调用）；条目计数不匹配 → FAIL（陈旧条目，或第二个调用溜进已豁免文件）。`--allowlist <file>` 支持夹具测试。
- **退出码**：0 = covered，1 = violations，2 = usage/IO 错误；--json 输出稳定结构。
- **当前树实测**：93 files scanned，4 allow-listed calls（metered-model-adapter.ts|complete ×1、index.ts|complete ×1、agent-loop-executor.ts|complete.bind ×1、|planNext.bind ×1），0 unmetered。

### 3.1 允许列表（生产默认，逐条 reason）

| file | symbol | expectedCount | reason |
| --- | --- | --- | --- |
| src/dsh-bridge/metered-model-adapter.ts | complete | 1 | 唯一计量边界自身：所有生产调用经此汇聚并记录 stage/purpose/cost |
| src/index.ts | complete | 1 | 惰性 holder 转发：转发到已构造的 adapter，自身不新增调用 |
| src/dsh-bridge/agent-loop-executor.ts | complete.bind | 1 | P3-A ledger 路径：executor 绑定 complete() 并以 purpose 'probe' 自行 reserve/settle；统一到 MeteredModelAdapter 会双重计费 |
| src/dsh-bridge/agent-loop-executor.ts | planNext.bind | 1 | 同上，多步 planner 调用 |

### 3.2 负控制实测（fixture，仓库零写入）

| 控制 | 结果 |
| --- | --- | --- |
| 未列出的 .complete(（src/violating.ts:1） | **exit 1**，unmetered-call @ src/violating.ts:1 [complete] |
| 未列出的 .planNext( | **exit 1**，[planNext] |
| 未列出的 .complete.bind( | **exit 1**，[complete.bind] |
| 注释/字符串/对象字面量中的同形文本 | **exit 0**（0 unmetered call(s)）——AST 不匹配注释与字符串 |
| 允许列表计数不匹配（期望 2 实际 0） | **exit 1**，stale-allowlist-entry |
| 允许列表条目精确命中 | **exit 0** |

## 4. 可复算证据

| # | 命令 | 退出码 | 关键输出 |
| --- | --- | --- | --- |
| 1 | `pnpm exec tsc --noEmit` | **0** | （无错误）TSC_EXIT=0 |
| 2 | `node scripts/eval/metering-coverage.mjs` | **0** | OK: 93 file(s) scanned, 4 allow-listed model call(s), 0 unmetered call(s). |
| 3 | `node scripts/eval/metering-coverage.mjs --root <fixture> --allowlist <empty.json>` | **1** | unmetered-call @ src/violating.ts:1 [complete] |
| 4 | `pnpm exec vitest run tests/unit/ledger tests/unit/dsh-bridge tests/unit/harness2 tests/unit/dream-rsi tests/unit/jitrl --reporter=basic` | **0** | Test Files 48 passed (48) ／ Tests 1172 passed (1172) |
| 5 | `pnpm exec vitest run tests/unit/ledger/metering-coverage.test.ts tests/unit/ledger/metered-model-adapter.test.ts tests/unit/ledger/stage-purpose-labels.test.ts --reporter=basic` | **0** | 9 + 21 + 4 = 32 passed (32) |

## 5. 新增测试清单（32 条）

**tests/unit/ledger/metering-coverage.test.ts（9 条）**：真实树 exit 0 + 恰好 4 个允许组 / OK 行；负控制 7 条（.complete(、.planNext(、.complete.bind(、注释/字符串不匹配、计数不匹配、陈旧条目、精确命中）。

**tests/unit/ledger/metered-model-adapter.test.ts（21 条）**：阶段→purpose/phase 映射（7 阶段全表 + probe≠compose）；7 个 stage 逐个证明 purpose 拒绝（provider 零调用、purpose_mismatch 记录）；运行时计数门（每次底层调用一条记录、registry==inner 计数、complete() 同门）；无 ledger=unmetered/none/0 成本；measured 仅在 usage+语义齐备时；语义缺省=unknown 永不 measured；预算拒绝（模型零调用、denied 记录）；模型失败记录并重抛（settle 照记）；歧义 ledger 拒绝；全局默认注册表可追溯 + 有界 ring 丢弃可见。

**tests/unit/ledger/stage-purpose-labels.test.ts（4 条）**：真实 stage 工厂驱动——composer→'compose'（judge prompt 含 alias、registry 计数）、proposer→'propose'、reflector→'reflect'；共享 registry 分列 probe/compose 计数。

## 6. 改动文件清单（本任务写入范围内）

| 文件 | 变更 |
| --- | --- |
| src/dsh-bridge/metered-model-adapter.ts | 新增（统一边界 + 运行时计数门） |
| src/dsh-bridge/index.ts | 追加 metered 导出 |
| src/dsh-bridge/branch.ts | purpose 修复 + metered 接线 |
| src/harness2/proposer.ts / composer.ts / reflector.ts | 经 .call() + metering 选项 |
| src/dream-rsi/offline-dreamer.ts | 经 .call() + metering 选项 |
| src/jitrl/step-evaluator.ts / logit-sources.ts | 经 .call() + metering 选项 |
| scripts/eval/metering-coverage.mjs | 新增（静态门） |
| tests/unit/ledger/metering-coverage.test.ts / metered-model-adapter.test.ts / stage-purpose-labels.test.ts | 新增（32 条） |
| docs/reports/p3-b-adapter.md | 新增（本报告） |

未触碰：src/jitrl/decision-kernel.ts、src/jitrl/index.ts（p2-kernel 所有）、src/types/contracts.ts（严格冻结）、src/index.ts（holder 转发仅允许列表）、CI、package.json。

## 7. 授权边界与未执行项

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 真实付费模型调用 / 真实宿主 smoke | **未执行（需授权）** | 全部测试使用注入 scripted model / fake model，零网络零付费。授权申请文本："申请在目标宿主以 agentLoop.ledger.enabled=true（observe）跑一次真实探针 smoke，验证 MeteredModelAdapter 在真实 provider 流上记录 purpose 与成本。" |
| 生产侧全局 registry/ledger 接线（src/index.ts） | **未执行（需授权/超范围）** | src/index.ts 不在本任务写范围；已用进程级 globalModelCallRegistry() 兜底保证"收集即可追溯"，真正的共享预算接线属 P3-C/P3-D 集成任务。 |
| estimated 与 measured 分列的运行时报表 | 部分完成 | adapter.stats()/records() 已分列（measuredCalls/estimatedCalls/unknownCalls + costMicros）；跨阶段汇总报表属 P3-C。 |

## 8. 遗留风险

1. 静态门是**源级**检查：它证明 src/** 内没有未计量调用点，但运行时绕过（例如通过非 TS 动态代码）不由它回答；运行时计数门（registry 计数 == 底层调用计数）由测试与 records()/stats() API 承担。
2. agent-loop-executor 的 bind 路径被允许列表豁免（带 reason）：若未来把它统一到 MeteredModelAdapter，必须同步把条目删除，否则 stale-allowlist-entry 会红（双向严格已测）。
3. 语义缺省剥离是本适配器内的保守选择；"countingSemantics 只能来自 provider 元数据或明确 unknown"的完整规则属 P3-C（t6），本任务未改 dshUsageToProviderPayload 既有默认。
4. 全局默认注册表是有界 ring（5000，丢弃可见）：超长进程的完整审计仍需宿主注入自己的 registry 或接 WAL 持久化（P3-C）。
5. tsc 全仓绿依赖并行队友对 tests/unit/eval/p2-preregistration-v3.test.ts 的修复（本轮中途该文件曾有 2 个临时错误；本任务文件始终 0 错误）。

## 9. 结论

- 生产侧全部 7 个阶段 + probe 分支的模型调用统一经 MeteredModelAdapter：真实 purpose 强制（probe ≠ compose）、一次调用一条可追溯记录、可选 ledger 计量且诚实分列 provenance。
- 静态门（AST 扫 .complete( / .planNext( / .bind 逃逸口）+ 显式双向严格允许列表：未计量调用即失败（负控制实测 exit 1），当前树 exit 0。
- 运行时计数门：registry 计数与底层调用计数相等的断言 + 全局默认注册表 + 有界 ring。