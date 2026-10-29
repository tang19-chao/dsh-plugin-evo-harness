# P3-C 结构债登记：两阶段结算的绕过面（下一轮执行）

- 登记人：release（本轮 t9；提交与推送责任人）
- 登记时刻：2026-10-29T23:05–23:08（Asia/Shanghai，各步采样时刻见 §6）
- 状态：**已登记，本轮不执行**（登记为结构债）
- 来源：integrator-dsh 在 t2 的自评 + lead 复核 + **本轮 release 独立只读复核（新增运行时探针，见 §2）**
- 不在本轮执行的唯一原因：t1（auditor）正在复核 `agent-loop-executor.ts` / `metered-model-adapter.ts` 的当前字节；本轮改这些字节会使其复核对象失效。本文件只登记，不改任何被复核字节。

---

## 0. 一句话

协调器（`TwoPhaseSettlement.settleCall`）对 interim/final 的判定是**行为级结构性**的（调用方传什么都覆盖不了），但**类型面仍然放行 `interim`**，且两个桥文件仍持有 `LedgerReservationManager` 活引用——任何后续编辑都可以直接 `manager.settle({...request, interim:false})` 并编译通过。今天拦住它的**只有代码形状 + NC6 的 7 条红**，没有静态门禁。修法 A（类型级一行）+ B（结构级 + AST 门禁）登记为下一轮执行。

---

## 1. 本轮独立复核（只读；四条现状逐条验证，不采信自述）

取样：2026-10-29T23:05–23:06。被复核字节的 sha256（与 t2 交付的最终哈希逐字一致，说明本轮没有移动被复核字节）：

| 文件 | sha256（本轮取样） |
| --- | --- |
| `src/ledger/two-phase.ts` | `5ec6b7cb77f164ca5efa257fc419d4a8ac8e5c69df27f292f2111ef5bd42ecda` |
| `src/dsh-bridge/agent-loop-executor.ts` | `2a978c4b981d6363afb9fe004747db096c70b0e7b39bdaf5638bc026f8d24269` |
| `src/dsh-bridge/metered-model-adapter.ts` | `68518d304e32ad96448e3f685fb205e523acf524649b14404185851da332622c` |
| `tests/unit/ledger/p3c-two-phase-wiring.test.ts` | `7081bad4c937775359f63d5271a3af2bd64f4fe736e79be972683635c607fba1` |
| `tests/unit/dsh-bridge/p3c-two-phase-bridge.test.ts` | `1ffc5fae6b68e6755c74eca561d9b5c2e201f08678889979647da9bace90ec76` |

| # | 现状（原登记） | 本轮复核方法与结果 | 判定 |
| --- | --- | --- | --- |
| 1 | `two-phase.ts:632-636`：`interim` 在 spread 之后写入，行为级不可覆盖 | 逐行读 `two-phase.ts:623-660`：`:623` 形参就是 `request: SettleRequest`；`:632` `const interim = !isRemoteTerminationConfirmed(request.outcome)`；`:633-636` `this.manager.settle({ ...request, interim })`——展开在前、`interim` 在后 | **成立** |
| 2 | `settleCall` 类型仍带可选 `interim`，传了能编译、被静默忽略 | `two-phase.ts:623` 形参 `SettleRequest`；`src/ledger/types.ts:394-423` 定义，`:422` `interim?: boolean`。**新增类型探针** `work/debt-t9/probe-current.ts`（`settlement.settleCall({..., outcome:'succeeded', interim:false})`）用项目自带编译器跑 `tsc -p work/debt-t9/tsconfig.json` → **exit 0**，即今天确实能编译 | **成立**（编译期证据，非推断） |
| 2b | 修法 A 是否能在类型面堵住 | 同一探针里加 A 面 `(r: Omit<SettleRequest,'interim'>) => void`：带 `@ts-expect-error` 的断言形态 exit 0；**负控制**（去掉该指令的副本）→ `TS2353: 'interim' does not exist in type 'Omit<SettleRequest, "interim">'`，exit 2 | **A 有效**（下一轮可直接采用） |
| 3 | 两个桥文件仍持有 manager 活引用，可 `.settle({..., interim:false})` 并编译通过 | `agent-loop-executor.ts`：`:81` type import、`:316` 选项字段、`:503` `const ledgerManager = adapters.ledgerManager ?? ledgerAssembly?.manager`、`:514/:516` 建协调器、`:1325` capabilities 里再读一次 → 引用活到函数末尾；`metered-model-adapter.ts`：`:69`、`:253`、`:359` `const manager = options.ledgerManager ?? assembly?.manager`、`:375-380` 建协调器。grep `src/dsh-bridge`：**当前没有**对 manager 的 `.settle(`/`.reserve(` 调用（`branch.ts` 的 `recorder.settle(...)` 是无关的 trajectory recorder）→ 风险是**能力存在**，不是**正在被用** | **成立（能力面）** |
| 4 | 拦住它的是代码形状 + NC6（改造后 7 条红） | t2 证据：`docs/reports/p3-c-two-phase-wiring.md:178`（NC6：`settleLedgerCall` 改为 `ledgerManager!.settle({ ...request, interim: false })` → bridge 套件 7 红，含 `expected 'reserved' to be 'interim_settled'`、`expected 500 to be +0`；变异 sha256 `532ffd93c62d58f80b82d2402593fc01ec785282d037efdae60d0cf9c38304f8`、`guard-removed: True`、`restore-identical: True`，@23:01:03）；本轮另加运行时探针（§2）独立复现同一形状 | **成立** |

---

## 2. 本轮新增的独立运行时证据（只读；未改任何被跟踪字节）

探针位置（`work/` 已被 `.gitignore` 忽略，不会进入交付树）：`work/debt-t9/runtime.probe.test.ts` + `work/debt-t9/vitest.probe.config.ts`。
之所以用临时 vitest 配置而不是往 `tests/` 里加文件：`lib/index.js` 不导出 ledger 模块，无法直接 `import` 驱动；加文件又会移动 t1 正在取样的树。

| 探针 | 输入 | 实测输出 | 说明 |
| --- | --- | --- | --- |
| P1（协调器路径） | `settleCall({ callId:'probe-ignored-interim', outcome:'cancelled', interim:false })` | `settlement=interim`、`result.state=interim_settled`、`index.state=interim_settled` | **`interim:false` 被静默忽略**（现状 1+2 的运行时直证） |
| P2（绕过面） | 直呼 `manager.settle({ callId:'probe-direct-manager', outcome:'cancelled', interim:false })` | `state=settled`、`incurredCostMicros=500`、`amountRefundedMicros=9500`，而协调器索引 `index.state=reserved` | 未确认的远端终态被记成 **final**，且**协调器索引与账本发散**；这正是 NC6 所堵的形状，**未改一行 src 即可复现**——证明"拦住它的是测试，不是类型" |

**P1/P2 探针自身的负控制**（runbook 规则 2/3/3.5）：把探针复制成副本并把 P1 期望从 `'interim'` 翻成 `'final'`（`work/debt-t9/runtime.probe.nc.test.ts`，变异前先核目标串存在、变异后核目标串消失）→ `Test Files 1 failed`、`Tests 1 failed | 1 passed`、`expected 'interim' to be 'final'`、`nc-probe-exit=1`，红日志落盘 `work/debt-t9/probe-nc.red.log`；真探针未被动过（sha256 `8c3d97faaab2e722d72ad9be1df0870a2c333236e90ab6f1ebab264818d3f16b`，仍含 `toBe('interim')`、不含 `toBe('final')`）。
探针身份哈希：`probe-current.ts` `8994e81a22cbfedacc18f64816f9c3ab56f230f716ff5d9f6f3acfb350205624`、`probe-fixA.ts` `d1e09763ffdd6800c719ef2f34e9b76ccd6979bbff2cbac3768a57b641e3d933`、`probe-fixA.nc.ts` `7aacbbe765338029d9666a81829d9292586797bc46ec7c1b5501c238f2a95e33`、`runtime.probe.nc.test.ts` `fc8ab908f003b1107d406fc4f9f7a2e56e3d5632f3828fb5fe9875d66a41f717`。

**当前字节绿色基线**（本轮取样，作为"下一轮改完后必须仍然绿、且删掉保护必须红"的对照）：`tests/unit/ledger` + `tests/unit/dsh-bridge` → **17 files / 279 tests passed，exit 0**（23:07:38.930 起，23:07:51.355 止）。

**本轮明确未做**（不得被读成已做）：没有改 `src/**`、`tests/**`、`README.md` 或任何被跟踪字节；**没有**在最终字节上重跑 NC6（那是下一轮的要求）；没有真实付费模型调用、真实宿主 smoke、外部工具/记忆写入。

---

## 3. 修法（下一轮做，A+B 一起；按成本从小到大）

**A（类型级一行，只堵"传错"）**
`src/ledger/two-phase.ts:623`：`settleCall(request: SettleRequest)` → `settleCall(request: Omit<SettleRequest, 'interim'>)`。
本轮已用探针证明它**真的会报错**（TS2353，见 §1 第 2b 行），不是"看上去更严"。
注意：A 只是类型级，**不改运行时**，调用方若用 `as`/`any`/`...spread 变量` 仍可绕；不要把它写进强度自评的"结构性"一栏。

**B（结构级，彻底）**
1. 两个桥文件**不再持有 manager 活引用**：从 `agent-loop-executor.ts`（`:81/:316/:503/:514/:516/:1325`）与 `metered-model-adapter.ts`（`:69/:253/:359/:375-380`）拿掉 `LedgerReservationManager`，只保留/接收 `TwoPhaseSettlement`（或装配层返回的 settlement）。
2. **新增静态门禁**：扫 `src/dsh-bridge/**`，禁止对 manager 出现 `.settle(` / `.reserve(`（与既有 metering-coverage 门禁同构的 AST 门禁，而不是字符串正则——`branch.ts` 的 `recorder.settle(` 说明正则容易误伤）。
3. **必须先决定的接缝归属（否则 B 是假的）**：`twoPhaseSettlementFor(manager, ...)` 需要 manager 才能建协调器。如果桥文件不持有 manager，装配点（`assembleAgentLoopLedger` 一类）必须返回**已建好的 settlement**，并且桥文件不得再用 `any`/`as` 把 manager 拉回来。下一轮开工前先把这件事写成一句话的接口决定，再动手。

---

## 4. 下一轮执行要求（照抄任务，并补齐本轮新增的判据）

1. A+B 一起做。
2. **负控制**：删掉/弱化结构保护后必须有测试变红，按 `docs/NEGATIVE-CONTROL-RUNBOOK.md` 规则 2（副本 + 按目标隔离的 `bak`/`red.log`/`anchor`/`snippet` 身份键）、规则 3（先证明变异生效：目标串真的消失）、规则 3.5（先判红后写日志，红日志写全身份键）、规则 4/4b（四处同刻取样 + 跨进程复核）落盘证据。
3. A/B 落地后重跑 `tests/unit/ledger` + `tests/unit/dsh-bridge`（对照基线：17 files / 279 tests，本节 §2），并**对最终字节重做负控制**（对最终字节，不是对中间态）。
4. 报告里更新强度自评：**分别**写类型面（A：类型级）与结构面（B：行为级结构性 + 静态门禁），不能合并成一句"类型级"或一句"结构性"。
5. 建议保留的回归锚点：现有 `tests/unit/dsh-bridge/p3c-two-phase-bridge.test.ts` 的 7 条红（NC6 形状）必须在 B 之后**换成静态门禁红**，否则 B 只是把运行时风险挪走而没有新拦截点。

---

## 5. 边界与未知

- **本文件的性质**：登记件，不是实现报告；本轮它的存在本身就是交付物（下一轮可直接照做）。
- **未验证（想验证也做不了）**：真实宿主 wiring 下有人写出绕过的场景（无授权、且本轮禁止改字节）；静态门禁的 AST 实现细节。
- **[未知] 装配点归属的最终形态**（§3 B-3）：`assembleAgentLoopLedger` 目前返回 `{ manager, options }`；如果 B 只删 import 不改返回类型，manager 会从装配层的返回值再次进入两个桥文件——门禁必须同时覆盖"经返回值拿到 manager 再 settle"这条路径，用类型签名而不是 grep 排除。

---

## 6. 本轮采样时刻表（可复现）

| 步骤 | 命令/对象 | 结果 | 时刻 |
| --- | --- | --- | --- |
| 字节快照 | `Get-FileHash`（§1 五文件） | 与 t2 交付哈希逐字一致 | 23:05:5x |
| 类型探针（正） | `tsc -p work/debt-t9/tsconfig.json` | exit 0（今天可编译 `interim:false`；A 面断言成立） | 23:06:07.851 |
| 类型探针（负） | `tsc -p work/debt-t9/tsconfig.nc.json` | exit 2，`TS2353 @ probe-fixA.nc.ts:6:73` | 23:06:09.486 |
| 运行时探针 | `vitest run --config work/debt-t9/vitest.probe.config.ts` | 2 passed，exit 0（P1/P2 输出见 §2） | 23:07:09 |
| 探针负控制 | `vitest run --config work/debt-t9/vitest.probe-nc.config.ts` | 1 failed，exit 1，红日志 `probe-nc.red.log` | 23:07:27.451 |
| 绿色基线 | `vitest run tests/unit/ledger tests/unit/dsh-bridge` | 17 files / 279 tests passed，exit 0 | 23:07:38.930–23:07:51.355 |

产物落盘（`work/`，已被 `.gitignore` 忽略）：`work/debt-t9/{tsconfig.json,tsconfig.nc.json,probe-current.ts,probe-fixA.ts,probe-fixA.nc.ts,probe-main.out.txt,probe-fixA.nc.out.txt,vitest.probe.config.ts,runtime.probe.test.ts,vitest.probe-nc.config.ts,runtime.probe.nc.test.ts,probe-runtime.out.txt,probe-nc.red.log,suites-green.out.txt}`。
