# P3-A 交付报告：计量装配、导出与纯观测语义（t4，attempt 3）

- **状态**：完成（按队长 2026-10-29 拆分指令执行：本任务只做**装配与配置一致性**；observe 零副作用语义与硬限额显式 opt-in 移交 t13）
- **日期**：2026-10-29
- **写者**：p3-metering（P3 全阶段计量工程师）
- **基线**：工作树含并行队友的在制改动（见 §6）；本报告只覆盖本任务写入范围内的文件
- **上位契约**：ADR-0004 §9.2（EvoLedgerConfig / 配置兼容与退化保证）、ADR-0005 §3.1（OPTION_KEYS 26 键穷举、与 ROOT_KEYS ∪ {modelRoute} 不相交）、docs/reports/p2-p6-remaining-work.md §4 P3-A

---

## 1. 问题（改动前）

`LedgerReservationManager`（类定义 `src/ledger/reservation-manager.ts:112`）没有任何受支持的装配路径：

- 唯一消费者 `src/dsh-bridge/agent-loop-executor.ts:66` **deep import** 内部模块，`:278` 要求宿主自己 `new` 一个 manager 实例再注入；
- 预算参数（generalBudgetMicros / verificationReserveMicros / maxConcurrencySeats）是 manager 构造器的**必填项**，宿主必须知道内部约定才能装配；
- 没有统一的"不计量"退化语义：`ledgerManager` 缺省 = 无计量，但没有任何可观测信号，"无 ledger"与"已计量但没花钱"不可区分。

## 2. 实现

### 2.1 唯一装配工厂：`src/ledger/assembly.ts`（新增）

| 导出 | 作用 |
| --- | --- |
| `createLedgerReservationManager(config?)` | **唯一**受支持的构造点：先 `resolveLedgerAssemblyOptions` 校验，再构造 manager |
| `assembleAgentLoopLedger(config?)` | executor 装配入口：`config === undefined` 或 `enabled !== true` → 返回 `undefined`（完全不计量）；`enabled: true` → 校验并装配 |
| `resolveLedgerAssemblyOptions(config?)` | 应用 ADR-0004 §9.2 默认值并逐字段校验，非法即抛 `LedgerAssemblyError`（不钳制、不静默丢弃） |
| `describeLedgerAssembly(assembly)` | 一行可观测摘要（预算/席位/单次估算/phase），供 `describe()` 输出 |
| `LEDGER_ASSEMBLY_DEFAULTS` / `DEFAULT_LEDGER_PHASE` | 默认值单一来源：10,000,000u / 2,000,000u / 4 席 / 单次估算 10,000u / phase 'probe' |
| `LedgerAssemblyError`（code: `LEDGER_ASSEMBLY_INVALID` 或 `LEDGER_HARD_BOUNDS_NOT_WIRED`） | 具名失败码，断言不 grep 散文 |

校验规则（全部 fail-closed，抛错不钳制）：预算/席位/估算必须为非负整数；storageDir 非空字符串；rate card 字段级校验（conservativeFallbackCostMicros > 0）；watermarks 满足 warning ≤ critical；routeBound 必须带 routeId；allowUnboundedRiskOverride=true 必须携带正 stop-loss。

**硬限额在装配层显式 fail-closed**：enforceHardBounds: true 在本构建被**拒绝**（LEDGER_HARD_BOUNDS_NOT_WIRED），而不是被接受后静默当 observe——宿主请求硬限额却静默得到观测，等于以为自己受保护而实际没有。硬限额的真实接线属于 t13。装配层只做边界校验，**未触碰** src/ledger/limits.ts 的限额判定语义（t6 范围）。

### 2.2 executor 经统一入口装配：`src/dsh-bridge/agent-loop-executor.ts`

- 删除 `import { LedgerReservationManager } from '../ledger/reservation-manager.js'` 与 ../ledger/types.js / ../ledger/pricing.js 三个 deep import，改经 `../ledger/index.js`（模块入口）。
- `AgentLoopAdapters` 新增 `ledger?: LedgerAssemblyOptions`（配置驱动装配路径，嵌在既有 agentLoop 选项内）；**保留** ledgerManager? / ledgerPhase? / ledgerRateCard? 三个旧字段且仍可选（队长兼容指令：不传 ledger 的既有调用方行为不变）。
- 构造期一次性解析（显式优先级，无静默偏好）：
  - 两者都不传 → 不计量（undefined），与 P3-A 前完全一致；
  - 只传 ledger → 此刻装配，非法配置在构造期抛错（不会探针中途炸）；
  - 只传 ledgerManager → 旧注入路径原样使用；
  - 两者同传 → 构造期拒绝（歧义不容忍）。
- `describe()` 新增计量状态行，"关"必须自报家门：
  - 无 ledger：`ledger: OFF (unmetered; no cost is recorded or claimed)`
  - 旧注入：`ledger: pre-built manager injected (cost recording only; hard bounds not enforced in this build)`
  - 配置装配：`ledger assembly: budgets general=…u verification=…u seats=…, per-call estimate=…u, phase=…, hard bounds: not enforced in this build`

**行为不变性**：本任务 diff 只改装配接线；reserve 的参数值（estimate 10_000、requiresSeat true、pool general、phase 默认 probe）与拒绝→failed 的既有语义逐字保留（t13 才改 observe）。未启用 ledger 的全部既有调用方（含全部既有测试）零行为变化。

### 2.3 配置入口与 P1 26 键一致性（ADR 0005 §3.1）

- agentLoop 本就是 26 个公开选项之一；ledger 配置**嵌在 agentLoop.ledger 内**，不新增第 27 个选项键，也不新增 src/config.ts 根键。
- **为什么不在 src/config.ts 加键**（任务写范围允许"仅新增键，需先消息告知 lead"，本任务选择不加）：
  1. ADR 0005 §3.1 不变式 OPTION_KEYS ∩ (ROOT_KEYS ∪ {modelRoute}) = ∅——把 agentLoop 或 ledger 加进根键会直接击穿 P1 契约与既有测试 tests/unit/config/plugin-options-shape.test.ts（该文件当前由队友在制修改，不在本任务写范围）；
  2. config.ledger 节要真正生效必须改 src/index.ts 的装配（options.agentLoop 才会进 executor），src/index.ts 不在本任务写范围——加一个无接线的死配置节比不加更糟；
  3. ADR-0004 §9.2 的 ledger 配置节若要落地，应作为后续独立任务（改 src/config.ts + src/index.ts + README + ADR 0005 根键清单），本报告 §3 给出可直接抄的默认值表。
- **因此 check:docs 的 78 叶门禁不受影响**（实测 §4-E）。

### 2.4 "无 ledger 不得伪装成已计量"

三重保证（全部有测试）：
1. assembleAgentLoopLedger 对未启用返回 undefined，executor 走完全无计量路径；
2. describe() 对三种状态显式自报（§2.2），不存在"静默计量"；
3. 静态门禁证明 executor 不自建 manager（§4-C），所以"看起来配了 ledger"必然经由同一校验工厂。

## 3. 新增配置叶清单（供队长抄进 README）

**src/config.ts（EvoHarnessConfig 冻结 schema）：0 个新增叶。** check:docs 遍历的默认叶集合不变（实测 78/78，§4-E）。

以下是**选项级**配置（挂在公开选项 agentLoop 下，不是 cordis.yml 冻结 schema 的根键），如 README 增设 agentLoop 选项说明可照抄：

| 路径 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| agentLoop.ledger.enabled | boolean | false（缺省即完全不计量） | ADR-0004 §9.2 PR-3A 开关 |
| agentLoop.ledger.enforceHardBounds | boolean | false | PR-3B 开关；本构建 true 会被装配层拒绝（LEDGER_HARD_BOUNDS_NOT_WIRED），t13 接线 |
| agentLoop.ledger.generalBudgetMicros | number | 10000000 | 通用池总额（微美元，$10） |
| agentLoop.ledger.verificationReserveMicros | number | 2000000 | 验证池保留（$2） |
| agentLoop.ledger.maxConcurrencySeats | number | 4 | 最大并发探索席位 |
| agentLoop.ledger.estimatedCostMicros | number | 10000 | 单次调用预留估算 |
| agentLoop.ledger.phase | enum | probe | probe/reference/compose/reflect/judge/dream |
| agentLoop.ledger.routeId | string | 无（可省） | 传给 reserve 的路由标识（为 t13 准入预留） |
| agentLoop.ledger.routeBounds | RouteCostBound[] | 无（可省） | 预登记路由成本上界 |
| agentLoop.ledger.watermarks | {warningRatio,criticalRatio} | 无（ledger 层默认 0.8/0.95） | 水位阈值 |
| agentLoop.ledger.storageDir | string | 无（内存 WAL） | WAL 持久化目录 |
| agentLoop.ledger.defaultRateCard | ModelRateCard | 无（可省） | 默认费率卡（结算时 reserve 快照优先） |
| agentLoop.ledger.allowUnboundedRiskOverride | boolean | false | 无界路由风险豁免（必须配 stop-loss） |
| agentLoop.ledger.unboundedRiskStopLossMicros | number | 无（可省） | 每调用止损上限 |

## 4. 可复算证据

### 4-A 全量验收（任务验收判据）

| # | 命令 | 退出码 | 关键输出行 |
| --- | --- | --- | --- |
| 1 | `pnpm exec tsc --noEmit` | **0** | （无错误输出）TSC_EXIT=0 |
| 2 | `pnpm exec vitest run tests/unit/ledger tests/unit/dsh-bridge --reporter=basic` | **0** | Test Files  9 passed (9) ／ Tests  183 passed (183) |

### 4-B 新增套件单独输出（回应队长"不接受口头版"）

| 命令 | 退出码 | 末行输出 |
| --- | --- | --- |
| `pnpm exec vitest run tests/unit/ledger/assembly.test.ts` | 0 | Test Files  1 passed (1) ／ Tests  22 passed (22) |
| `pnpm exec vitest run tests/unit/dsh-bridge/agent-loop-ledger-assembly.test.ts` | 0 | Test Files  1 passed (1) ／ Tests  19 passed (19) |

### 4-C 静态门禁：不是观察，是断言 + 负控制实测（回应队长第 1 点）

**做法**：扫描器把禁止模式**由两段字面量拼接**（['new','LedgerReservationManager'].join('\\s+')、['from',"'../ledger/reservation-manager"].join('\\s+')），使门禁文件自身不含被禁短语、不会自匹配；对 src/dsh-bridge 全目录与 tests/unit/dsh-bridge 全目录断言零命中，另对 executor 源码单独断言"走 barrel + assembleAgentLoopLedger"。

**"将来真有人写了直接构造会不会红"——实测验证（非声称）**：

1. 临时写入 tests/unit/dsh-bridge/__negative_control__.test.ts（内容含直接构造）；
2. 复跑门禁 → **红**：AssertionError: expected [ '__negative_control__.test.ts' ] to deeply equal []，Tests  1 failed | 16 passed (17)，退出码 **1**；
3. 删除该文件（EXISTS_AFTER=False）；
4. 复跑门禁 → **绿**：Tests  17 passed (17)，退出码 **0**。

另有一个**常驻**负控制测试（NEGATIVE CONTROL: the scanner really reports a violating file）：在 OS 临时目录写违规文件、断言扫描器命中、清理——仓库本身永不被写。

**grep 证据**（Select-String，PowerShell 等价 grep）：

```
--- deep import of reservation-manager from dsh-bridge ---
（空：0 命中）
--- new LedgerReservationManager in src ---
src/ledger/assembly.ts:314:  return new LedgerReservationManager({      <- 唯一合法构造点（工厂内部）
src/ledger/assembly.ts:330:  * new LedgerReservationManager(...), ...    <- 文档注释，非代码
--- ledger barrel import in executor ---
79: } from '../ledger/index.js';
```

tests/ 下 48 处直接构造全部位于既有 tests/unit/ledger/*.ts 白盒单测（装配前基线，按队长指示保留）。**新规则已写成常驻断言**：新增测试一律经工厂，违者门禁红（负控制已证明会红）。

### 4-D 26 键一致性测试的真实性（回应队长第 3 点）

tests/unit/dsh-bridge/agent-loop-ledger-assembly.test.ts §3（5 条测试）：

- **选项键集是 IMPORT 的**：`import { OPTION_KEYS } from '../../../src/index'`——P1 的权威清单（其在 src/index.ts 内有编译期穷举 witness _OPTION_KEYS_EXHAUSTIVE 与 26 计数 witness _OPTION_KEYS_COUNT）。测试**没有**抄一份 26 键数组，断言的是 length===26、Set size===26、含 agentLoop、不含 ledger/ledgerManager（无第 27 键）。
- **根键集是派生的**：`Object.keys(DEFAULT_EVO_HARNESS_CONFIG)`（权威冻结 schema），断言与 ADR 0005 §3.1 记载的 10 键字面量相等、不含 ledger/agentLoop、与 OPTION_KEYS 交集为空。**该 10 键字面量是显式标注的手工同步 PIN**（测试内注释写明权威来源是 DEFAULT_EVO_HARNESS_CONFIG，变更须同步 ADR 与此字面量；其失败即 check:docs 叶面变化的信号）——这是维护负担，不是自动保证，已在测试头注释声明。
- 行为证据：`validateEvoHarnessConfig({ agentLoop: {…} })` 必须以 unknown_key 拒绝 agentLoop（选项键≠配置根键）。

### 4-E docs 门禁不受影响

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| node scripts/verify-readme-counts.mjs --docs-only | 0 | Config reference coverage: 78 documented row(s) vs 78 expected default leaf path(s) ／ SUCCESS: documentation gate fully green. |

## 5. 新增测试清单（41 条）

**tests/unit/ledger/assembly.test.ts（22 条）**：默认值解析／显式值保留／7 类非法输入拒绝（含字符串预算的 JS 旁路，as unknown as 仅用于构造非法输入并有注释）／畸形 rate card／watermark 交叉校验／routeBound 校验／无止损豁免拒绝／enforceHardBounds fail-closed 拒绝／工厂创建+结算（默认上界、rate card 实测 2000u、**无语义声明→provenance 'unknown'**）／storageDir WAL／装配退化（undefined、enabled:false、enabled:true 描述行、非法配置构造期抛错）。

**tests/unit/dsh-bridge/agent-loop-ledger-assembly.test.ts（19 条）**：真实装配路径创建并观测（describe() 含预算行+hard bounds 行；正常预算全探针成功）／**装配真实生效**（generalBudgetMicros=0 → EvoHarnessLedgerError + budget_exhausted，模型与工具零调用——这是 P3-A2 前的 fail-closed 现状，t13 将收窄）／非法配置构造期抛错／双路径同传拒绝／**插件入口级**（apply({}, {agentLoop.ledger…})：非法配置挂载期抛错；合法配置可挂载并暴露插件面）／无 ledger 自报 OFF 且照常工作／enabled:false 照常工作／旧 ledgerManager 注入兼容／26 键一致性 5 条／静态门禁 5 条（含常驻负控制）。

## 6. 改动文件清单（本任务写入范围内）

| 文件 | 变更 |
| --- | --- |
| src/ledger/assembly.ts | 新增（唯一装配工厂 + 校验 + fail-closed） |
| src/ledger/index.ts | 追加 export * from './assembly.js'（统一导出入口） |
| src/dsh-bridge/agent-loop-executor.ts | 装配接线（去 deep import；新增 ledger 配置路径；保留旧可选字段；构造期歧义拒绝；describe() 计量状态行） |
| tests/unit/ledger/assembly.test.ts | 新增（22 条） |
| tests/unit/dsh-bridge/agent-loop-ledger-assembly.test.ts | 新增（17 条，含 26 键一致性与静态门禁） |
| docs/reports/p3-a-assembly.md | 新增（本报告） |

未触碰：src/config.ts（0 新增键，理由 §2.3）、src/ledger/limits.ts、src/index.ts、README、CI、package.json。工作树中 src/host-triggers.ts、src/types/contracts.ts、scripts/verify-readme-counts.mjs、docs/adr/0005-*.md、tests/unit/config/plugin-options-shape.test.ts、tests/unit/eval/p2-l1-mechanism.test.ts 等改动属于并行队友，与本任务无关。

## 7. 授权边界与未执行项

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 真实宿主 smoke / 真实多步探针 | **未执行（需授权）** | 授权申请文本："申请在目标宿主以只读探针配置（agentLoop.ledger.enabled=true，observe）跑一次真实宿主 smoke，验证装配路径在真实 DSH 上下文可创建且不改宿主行为。" 替代验证（已完成）：结构化 fakes 全链路 + 契约/静态门禁测试（§4-C/§5），describe() 可观测性测试。 |
| 真实付费模型调用 | **未执行（需授权）** | 本任务全部测试使用注入的 scripted planner / recording tools，零网络、零付费。 |
| observe 零副作用语义（不拒绝/不截断/不改写/不改结局） | **移交 t13（队长拆分指令）** | 本任务未触碰任何探针行为语义；装配后的 reserve 拒绝路径保持原 fail-closed 并由测试固定，t13 将改为 observe 继续并不改变结局。 |
| 硬限额独立显式 opt-in 接线 | **移交 t13** | 本任务对 enforceHardBounds=true fail-closed 拒绝（绝不静默当 observe）；未改 src/ledger/limits.ts 限额语义（t6 范围）。 |
| config.ledger 配置节（ADR-0004 §9.2 原文形态） | **未执行，建议后续任务** | 需 src/config.ts 新增根键 + src/index.ts 接线 + ADR 0005 根键清单更新 + README；与本任务"26 键不动"的验收直接冲突，且 src/index.ts 不在写范围。默认值表见 §3 可直接复用。 |

## 8. 遗留风险

1. agentLoop.ledger.* 是选项级配置，不经 cordis.yml 冻结校验器：拼写错误只有 TypeScript 类型层拦截（测试内 @ts-expect-error 负 witness），纯 JS 宿主的未知键由装配层抛 LEDGER_ASSEMBLY_INVALID 兜底（已测），但没有 unknown-key 白名单校验。
2. 既有 tests/unit/ledger/*.ts 的 48 处直接构造是白盒基线，保留；若未来要"全绿经工厂"，需要一轮专门迁移（涉及 walWriter 注入等工厂暂不支持的内部分离点，不宜在本任务顺手做）。
3. dshUsageToProviderPayload(rawUsage, countingSemantics) 在 metadata 缺省时回落 DEFAULT_DSH_COUNTING_SEMANTICS——"语义只能来自 provider 元数据或明确 unknown"属 P3-C（t6）范围，本任务未改。
4. 全仓 tsc 绿依赖并行队友对 tests/unit/eval/p2-l1-mechanism.test.ts 的修复（本轮中途曾出现 2 个该文件错误，队长确认后由 p2-prereg 修复；本任务文件始终 0 错误）。
5. 真实宿主装配验证仍是 fake-host 级别；在获授权 smoke 之前，"真实宿主入口可装配"的证据强度是结构等价而非运行实测。

## 9. 结论

- 统一入口装配/导出路径已落地并成为唯一合法构造点；executor 与测试的 deep import / 直接构造绕过已被**断言 + 实测负控制**的门禁封死。
- 配置入口收敛在既有 agentLoop 选项内，26 键公开面与 src/config.ts 冻结 schema 均未扩大，且一致性测试直接 import 权威来源。
- 验收命令全部退出码 0（§4-A/4-B）；无授权动作一律未执行并给出申请文本与替代验证。
