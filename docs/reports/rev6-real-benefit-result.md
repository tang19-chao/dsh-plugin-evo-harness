# rev6 R3 真实收益评测结果：`not-run`（绑定不完整——合法终态）

**结论（一句话）**：本轮**未发生任何真实模型调用**。账号（B-1）与硬预算（B-2）在当前环境不可绑定，按契约 §5.8/§7 与 D-4 口径如实报 `not-run` 并列出缺失项；可复跑的绑定机制、预注册与负控制证据照常交付（A-R3-5）。

| 项 | 值 |
| :-- | :-- |
| 任务 | t13（benefit-engineer，attempt 1） |
| 结果日期 | 2026-10-31（+08:00） |
| 终态 | **`not-run`**（realCallsMade = 0） |
| 预注册 | `docs/reports/rev6-real-benefit-preregistration.md`，sha256 `17e102e1638114140606379a389c5135b0f873e5866a37cc4c9c9081f4d27d03`，mtime `2026-10-30T21:22:49.786Z`——先于本报告与全部采样动作；§8 采样登记为空（无真实调用） |
| HEAD | `97e38db…`（未 commit/push；本轮零提交） |

---

## 1. 四项绑定条件（§7 B-1..B-4）当前状态

机读凭据：`work/t13/binding-credential-current-env.json`（`runnable:false`）。

| # | 条件 | 状态 | 证据 |
| :-- | :-- | :-- | :-- |
| B-1 账号 | 缺失 | `blocked(account-unbound)` | `src/**` 无账号原语（契约实测 grep 0 命中）；本进程 env 无 `R3A_ACCOUNT_*`/任何 account/billing 命名变量；不伪造字段（D-4/N-10） |
| B-2 硬预算 | 缺失 | `blocked(budget-unbound)` | 无 `R3A_GENERAL_BUDGET_MICROS` 等预算输入；机制已就绪（`LedgerBudgetConfig`/`decideAdmission` 经 barrel 组装） |
| B-3 只读白名单 | 机制就绪，输入缺失 | 随 B-1/B-2 一并 blocked | `createToolFaceRegistry` per-branch fail-closed 已接线；`R3A_READONLY_TOOLS` 未提供 |
| B-4 中止开关 | 就绪（结构内置） | 满足（该项不可能为假） | 六个命名 trigger 全部实现并有负控制测试 |

信封声明：`HOSTSMOKE_AUTHORIZED` 未设置；**即使设置也仅是信封**，不构成绑定（凭据 JSON `envelope.countsAsBinding:false`；in-host 9.4-2 对此先例为 `failed` + "refusing to fabricate evidence"）。

## 2. 缺失项清单（机读）

`work/t13/canary-current-env.json`：`verdict:"not-run"`、`realCallsMade:0`、`abortTrigger:"binding-incomplete:…"`，缺失项（凭据侧 5 条，含命名 env 键）：

- `binding-unconstructable:required R3A_* inputs absent or unparseable`
- `missing-required-key:R3A_ACCOUNT_ID`
- `missing-required-key:R3A_GENERAL_BUDGET_MICROS`
- `missing-required-key:R3A_RATE_MODEL_ID`
- `missing-required-key:R3A_READONLY_TOOLS`

## 3. 已交付的可复跑机制（not-run ≠ 没有交付）

| 交付物 | 内容 |
| :-- | :-- |
| `src/dsh-bridge/real-benefit-controller.ts` | fail-closed canary 控制器：B-1..B-4 校验（`decideAdmission` hard 模式、`basis:'provable-hard-bound'` 才放行、conservative floor ≤ 路线上界）、授权台账（paid-model-call 显式 grant）、per-branch 只读 tool face、two-phase 结算（interim/final）、RewardContract 计分（r4/verifier-first-v1，trusted 门先行）。走 ledger barrel + `assembleAgentLoopLedger` 工厂，符合 rev5 冻结的 P3-A/P3-4 静态门（无直构、无深导入） |
| `scripts/host-smoke/budget-binding.mjs` | 绑定凭据脚本：`--json` 输出 `runnable` + 四行绑定状态 + 缺失项；空环境 exit 0（合法终态），`--require-runnable` exit 1（fail-closed） |
| `scripts/host-smoke/real-benefit.mjs` | canary 入口：绑定不完整 ⇒ `not-run` 机读报告；完整 ⇒ 恰好两次真实调用（baseline/treatment）+ 分层报告；`R3A_MODEL_SEAM` 缺失时拒绝伪造响应（诚实 `failed` + `insufficient`） |
| `tests/e2e/host-smoke/real-benefit-controller.test.ts` | **31 tests，全绿**：A-R3-1（缺账号/缺预算/不可证明路线/未定价费卡/floor 超上界/wildcard）、A-R3-2（字段完整/精度不升级/保守兜底）、A-R3-3（六 trigger 各一 + 恰两次调用断言）、A-R3-4（五态词汇表：untrusted⇒insufficient、passed 需双臂 trusted + delta>0、F3 词法界）、A-R3-6（无 memory-write/guarded-active/publish 代码路径、无 fs/network） |

## 4. runnable 分支已验证（合成 fixture，非真实调用）

`work/t13/binding-credential-runnable-fixture.json`（`runnable:true`）与 `work/t13/canary-runnable-fixture.json` 证明：绑定齐备时控制器真实走通——

- 两臂 `admitted:true, admissionBasis:"provable-hard-bound"`，预留 = 路线可证明上界（4000μ）；
- ledger metering `mode:"enforce"`，reserveGranted=2、settleCount=2；
- 无真实客户端（fixture 未注入 provider seam）⇒ 两臂诚实 `failed`、按预留上界保守结算（各 3000μ，conservative floor，未被改标 measured）、终态 **`insufficient`**（不是收益，也不是崩溃）；
- 预算守恒：remaining 99 994 000μ + settled 6 000μ = 100 000 000μ 绑定总额。

**该 fixture 不冒充真实收益**：账号/授权标注 `synthetic-fixture`，报告自身携带「no real client bound; transport refuses; no real call」边界。

## 5. 门禁（本 attempt 实测）

| 命令 | 结果 |
| :-- | :-- |
| `pnpm run typecheck` | exit 0 |
| `pnpm exec vitest run tests/e2e/host-smoke/real-benefit-controller.test.ts` | 31 passed，exit 0 |
| `pnpm exec vitest run tests/unit/dsh-bridge/agent-loop-ledger-assembly.test.ts`（rev5 冻结静态门） | 20 passed，exit 0（初版控制器曾两条违禁命中，已改走 barrel+assembly 工厂消红，见 §6） |
| `pnpm run guarded-regression` | 见 §7 命令记录（exit 0） |
| `node scripts/host-smoke/budget-binding.mjs --json` | exit 0，`runnable:false` + 缺失项（当前环境） |

## 6. 诚实登记：过程中发现并修复的三个真实问题

1. **rev5 冻结静态门命中（release-spec 在 t24 交叉审核中发现并即时通报）**：初版控制器直接 `new LedgerReservationManager` 且深导入 `../ledger/reservation-manager`，命中冻结测试 `tests/unit/dsh-bridge/agent-loop-ledger-assembly.test.ts` 的两条违禁模式（该测试在 67 条冻结路径内，不得改）。修复：改走 `../ledger/index.js` barrel + `assembleAgentLoopLedger` 工厂 + `TwoPhaseSettlement` 生命周期（`beginCall`/`settleCall`），与其它生产 bridge 同规。修复后该门 20/20 复绿。
2. **B-2 完整性缺口（自查发现）**：conservative fallback floor（未知用量时的结算下界）可能超过路线可证明上界，使「预算耗尽即拒」形同虚设（预留 2μ 却结算 10 000μ）。修复：绑定校验新增 `rateCard.conservativeFallbackCostMicros-exceeds-route-bound` 负控制；测试夹具同步改用自洽量纲。
3. **trust 语义建模修正（自查发现）**：结构回退保证两臂评分后必带 verdict（`absent` 只在未评分时出现）；trust 是「谁签署 + 证据绑定」的来源属性，与 verdict 方向（passed/failed）正交。测试断言已按此修正，避免未来读者把 `failed` 臂误读为 untrusted。

## 7. 复跑命令（t19 验证可直接执行）

```powershell
pnpm run typecheck
pnpm exec vitest run tests/e2e/host-smoke/real-benefit-controller.test.ts
pnpm exec vitest run tests/unit/dsh-bridge/agent-loop-ledger-assembly.test.ts
pnpm run guarded-regression
node scripts/host-smoke/budget-binding.mjs --json          # 期望 runnable:false + 缺失项
node scripts/host-smoke/real-benefit.mjs --json             # 期望 verdict:not-run
```

## 8. 边界与未决授权

- 本轮零真实调用、零真实记忆写入、零 guarded-active、零 publish、零 commit/push（HEAD 未变）。
- 实跑前置（缺一即继续 not-run）：操作者提供 `R3A_CREDENTIAL_FILE`（账号 + 预算 + 费卡 + 路线 + 白名单 + 授权来源）与已注入的真实 provider seam（`R3A_MODEL_SEAM`）；绑定齐备后凭据脚本给 `runnable:true`，canary 才允许恰两次调用。
- 单任务 canary 的 `passed` 只表示「该任务上治疗臂可验证更高分」，不外推为策略收益（预注册 §3.2）。
