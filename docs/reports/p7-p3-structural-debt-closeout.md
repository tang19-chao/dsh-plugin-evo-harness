# P7 / P3 结构债收口报告（rev5 t12：P3-4 A + B + AST 门禁）

- 任务：`evo-harness-rev5` / t12（P3 可判别评测工程师）
- 基线：`97e38db37305b24f695a5f989428b3611f84987c`（G12：未提交、未推送）
- 判据来源：`docs/reports/p3-c-structural-debt-register.md` §3（A = 类型层 `Omit<SettleRequest,'interim'>`；B = 桥不再持有 live `LedgerReservationManager`；assembly 返回**已构建**的 `TwoPhaseSettlement`）
- 门禁与复跑：
  - `pnpm exec vitest run tests/unit/eval/structural-debt-gate.test.ts`（独立可跑，12 例）
  - `pnpm run typecheck`
  - `pnpm exec vitest run tests/unit/ledger tests/unit/dsh-bridge`
  - `pnpm exec vitest run tests/unit/dream-rsi tests/unit/eval`

> 队长裁定（§11）：AST 结构债门禁落在 `tests/unit/eval/structural-debt-gate.test.ts`、**不**新建 `scripts/eval/check-structural-debt.mjs`、不改 t9 建立的 gate 脚本；NC 在**临时副本**上跑（hit → 红 → 删除保护 → 红 → 恢复字节一致）。

---

## 1. P3-4 A：`settleCall` 拒绝被忽略的 `interim`（类型层）

`src/ledger/two-phase.ts`：

- `TwoPhaseSettlement.manager` → `private readonly manager`（591 行；原来 public，是 P3-C 登记的缺陷来源）。
- `settleCall(request: SettleRequest)` → `settleCall(request: Omit<SettleRequest, 'interim'>)`（641 行；633–640 行文档写明理由：interim/final 由结果派生，调用方不能声明）。

类型探针（虚拟 probe 文件，进程内 `ts.createProgram`，**不落盘**、tsconfig 包含 `tests/**` 所以失败 probe 不允许提交）：

| probe | 期望 | 实测 |
| --- | --- | --- |
| `settleCall({…, interim: false})` | TS2353（对象字面量出现未知属性 `'interim'`） | TS2353 ✓ |
| `settleCall({…, interim: true})` | TS2353（两个极性都不可表达） | TS2353 ✓ |
| `settleCall({…})`（干净） | 0 诊断（改动非空洞） | 0 ✓ |

即登记的缺陷（把 `settleLedgerCall` 改成 `ledgerManager!.settle({…request, interim:false})`）在桥里**不再可表达**。

## 2. P3-4 B：桥不再持有 live manager；assembly 交出已构建 settlement

- `src/ledger/assembly.ts`：`LedgerAssembly = { settlement: TwoPhaseSettlement; options; meteringStatus(): LedgerMeteringStatus }`（122–127 行）。`assembleAgentLoopLedger` 在装配点构建 settlement（consumer `ledger-assembly`），不再返回 `manager`；`meteringStatus()` 是保留下来的唯一 live 读数（P3-A2 观测性测试改用它）。
- `src/dsh-bridge/agent-loop-executor.ts`：注入点改名 `ledgerSettlement?: TwoPhaseSettlement`（333 行），**删除** `LedgerReservationManager`/`twoPhaseSettlementFor` 依赖；`settlement = adapters.ledgerSettlement ?? ledgerAssembly?.settlement`；两个 `beginCall` 站点显式传 `consumer: 'agent-loop-executor'`；capability 文案 → `pre-built settlement injected`。
- `src/dsh-bridge/metered-model-adapter.ts`：同样改名（258 行）、删除 manager 依赖；`beginCall` 显式传 `consumer: 'metered-model-adapter:<stage>'`；歧义拒绝文案 → `pre-built settlement, not both`。
- 迁移的测试（机械改名，语义不变）：`tests/unit/dsh-bridge/agent-loop-ledger-assembly.test.ts`、`tests/unit/dsh-bridge/p3c-two-phase-bridge.test.ts`、`tests/unit/ledger/metered-model-adapter.test.ts`、`tests/unit/ledger/p3a2-observe.test.ts`（`assembly?.manager.getMeteringStatus()` → `assembly?.meteringStatus()`）。

> 测试仍可合法地 `createLedgerReservationManager` 并用 `twoPhaseSettlementFor` **在装配点**构建 settlement——门禁扫描的是 `src/dsh-bridge/**`（桥层），不是测试。

## 3. AST 结构债门禁（`tests/unit/eval/structural-debt-gate.test.ts`，12 例）

### 3.1 规则（解析 `src/dsh-bridge/**/*.ts` 的 AST，不用子串扫描）

| 规则 | 检测 |
| --- | --- |
| `manager-type-identifier` | 标识符 `LedgerReservationManager` 不得出现（含 type-only import） |
| `settlement-factory-identifier` | 标识符 `twoPhaseSettlementFor` 不得出现（manager→settlement 工厂是装配层关注点） |
| `manager-property-access` | 不得出现名为 `manager` 的属性访问（「从 assembly 返回值拿回去」路径） |
| `settleReserveCalls` | 每个 `.settle(`/`.reserve(` 调用的 receiver 必须是 trajectory `recorder`（branch.ts 的 11 处合法调用放行）；其余一律违规（`manager-settle-or-reserve-call` / `non-sanctioned-settle-call`） |

用 AST 而非 grep 的原因：`recorder.settle(...)` 与被禁止的 `manager.settle(` 形状相近，且文档注释里合法地提到这些名字——AST 解析天然忽略注释与字符串。

### 3.2 非空洞性（NC 矩阵，全部在临时副本上跑）

| NC | 植入 | 期望 | 实测 |
| --- | --- | --- | --- |
| NC0 | 真实文件的干净副本 | 0 findings（无误报） | ✓ |
| NC1 | 追加 `manager.settle({...})` | `manager-settle-or-reserve-call`，带 file+line（报告的是插入行） | ✓ |
| NC2 | 追加 `import type { LedgerReservationManager }` + 用它声明字段 | `manager-type-identifier` | ✓ |
| NC3 | 追加 `assembleAgentLoopLedger({enabled:true})!.manager.settle(...)` | `manager-property-access` + `manager-settle-or-reserve-call` | ✓ |
| NC4 | **关闭单条规则**再扫 NC 植入 | 该规则的 findings 消失（规则是 load-bearing：删除本文件中任一规则，对应断言变红） | ✓ |
| 最终字节 | 临时树 = 最终字节副本 → 基线绿 → 去掉 `private`（红）→ 桥里重引入 `.manager` 返回路径（红）→ 恢复字节（绿，逐文件 sha256 与仓库一致，仓库零污染） | mutation → red，restore → byte-identical | ✓ |

类型层 NC：A 探针的三向（`interim:false` 红 / `interim:true` 红 / 干净绿）见 §1。

### 3.3 类型级断言（同样进全量 Vitest）

- `LedgerAssembly` 接口属性名（AST 逐成员读取）**包含 `settlement`、不含 `manager`**。
- `TwoPhaseSettlement` 类的 `manager` 属性修饰符**含 `PrivateKeyword`**（把 `private` 摘掉该断言变红）。

## 4. 验证结果（本任务实测）

| 命令 | 结果 |
| --- | --- |
| `pnpm run typecheck` | exit 0 |
| `pnpm exec vitest run tests/unit/ledger tests/unit/dsh-bridge` | 18 files / 294 tests 全绿 |
| `pnpm exec vitest run tests/unit/dream-rsi tests/unit/eval` | 19 files / 352 tests 全绿（含新门禁 12 例、P3-1 18 例、P3-2 8 例、P3-3 8 例） |
| `node scripts/eval/pr4a-stats.verify.mjs` | SUCCESS（P3-1 复检引用，见 `p7-p3-evaluation-recheck.md` §1.5） |
| 结构债文件 sha256（改后） | `two-phase.ts 5445a51ae5b3…`、`assembly.ts 71df4ded8bd2…`、`agent-loop-executor.ts b9e5629677bb…`、`metered-model-adapter.ts 99b4f4c3ba11…`、`structural-debt-gate.test.ts 0e5b23674913…` |

## 5. 边界与未做

1. **未改** t9 建立的 gate 脚本（`check-clean-tree.*`、J-1/stale 测试）与记忆桥负责范围；未动 P0 与宿主/JitRL。
2. `createLedgerReservationManager` 与 `twoPhaseSettlementFor` 仍从 `src/ledger` 模块导出——它们是装配层/测试的合法原语；门禁只封**桥层**的持有与调用（inScope 内的最小修复）。
3. assembly 内部仍构建 manager（必然：settlement 需要它），但它不再跨过 `LedgerAssembly` 的返回类型暴露。
4. `ledgerManager` 注入点是**有意的不兼容改名**（`ledgerSettlement`）：登记簿 §3 的 B 项要求桥不持有 manager；旧调用方按文档注释迁移（`twoPhaseSettlementFor(manager, { consumer })`）。测试中 4 个文件已完成迁移。
5. 运行时 NC6 的 7 条红仍保留（t9 的门禁脚本未被触碰）；本门禁是**叠加**的静态层，不是替代。
