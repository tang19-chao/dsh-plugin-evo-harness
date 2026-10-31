# rev6 t4 绑定报告：ZCode 宿主客户端接入 + token 硬预算

**任务**：t4（binding-engineer，attempt 1）
**日期**：2026-10-31（+08:00）
**范围声明**：本报告描述**绑定机制与验证证据**。本轮**零真实模型调用、零真实记忆写入、零 guarded-active、零 publish、零 commit/push**。真实 canary（baseline/treatment 各至多一次）仅在操作者提供真实 provider seam（`R3A_ADAPTER_MJS`）并显式授权后运行。

---

## 1. 交付物

| 文件 | 内容 |
| :-- | :-- |
| `src/dsh-bridge/real-benefit-host-client.ts`（新增） | 真实宿主客户端绑定：`readZcodeHostClient(ctx,…)` 经验证的 guarded reader 解析宿主 `ctx.llm`（唯一公开模型入口 `stream()`；`ctx.llm` 缺失/无 stream/Cordis 代理抛错 ⇒ 返回 `undefined`，调用方必须 fail-closed）；`createHostClientFromAdapter` 绑定操作者注入的 adapter invoke；脱敏身份（provider/model/routeId + `maskAccountId`，原始账号 id **永不**进入 client 对象）；**流式 token kill switch**：usage 块超 per-call 上限即刻 abort 自身 signal，宿主停止生成，usage 原样保留（`abortedByTokenCap:true`） |
| `src/dsh-bridge/real-benefit-controller.ts`（扩展） | ① `hostClient` 门：无 client ⇒ `blocked(host-client-unbound)`；client 身份与绑定账号/模型/路由不符 ⇒ `blocked(host-client-identity-mismatch:…)`——两者都在任何 ledger 组装**之前**拒绝，绝不模拟；② token 硬预算（见 §2）；③ 每条 call 记录新增 `measuredTokens`（仅计宿主实报字段的毛和）与 `abortedByTokenCap` |
| `scripts/host-smoke/budget-binding.mjs`（扩展） | 绑定凭据新增 token 预算行（`token-budget`）+ 默认梯（total=800M, task=400M, arm=200M, call=100M 仅作报告展示；操作者供给值优先，控制器重验整梯） |
| `scripts/host-smoke/real-benefit.mjs`（扩展） | 绑定完整 ⇒ 尝试绑定真实 client：`R3A_ADAPTER_MJS` 指向操作者模块（导出 `invoke(request)`）；无 seam ⇒ **exit 0 + `blocked(host-client-unbound)`** 诚实报告（绝不伪造响应）；报告新增 `tokenBudget` 块与每 call `measuredTokens` |
| `tests/e2e/host-smoke/real-benefit-host-client.test.ts`（新增，21 tests） | H-1 脱敏身份、H-2 ctx.llm fail-closed 解析、H-3 流式 kill switch、H-4 usage 逐字保真、H-5 adapter 路径 + 模块自身零 `complete()` 调用（metering gate 面不变）、H-6 控制器 fail-closed 接线（unbound/mismatch 零调用） |
| `tests/e2e/host-smoke/real-benefit-controller.test.ts`（更新，32 tests） | 既有 31 条负控制全部改为经真实 client 对象驱动；新增 token 预算行断言、`tokenBudget` 报告块断言、双臂恰好两次调用（经 client 计数） |

## 2. token 硬预算（验收行 2）

**上限阶梯**（全部为绑定必填，缺任一 ⇒ `blocked(token-caps-*)`）：

| 层级 | env 键 | 授权值 | 约束 |
| :-- | :-- | :-- | :-- |
| 总量 | `R3A_TOKEN_TOTAL_CAP` | **800,000,000**（用户授权上限） | ≤ `CANARY_TOTAL_TOKEN_CEILING` |
| 单任务 | `R3A_TOKEN_PER_TASK_CAP` | 400,000,000（默认梯） | **严格小于** total |
| 单臂 | `R3A_TOKEN_PER_ARM_CAP` | 200,000,000（默认梯） | **严格小于** per-task |
| 单调用 | `R3A_TOKEN_PER_CALL_CAP` | 100,000,000（默认梯） | **严格小于** per-arm |

**执行语义**（三层，全部只计 MEASURED usage）：

1. **单调用·流中即停**：`createHostClientFromLlm` 的 kill switch 在每个 usage 块上检查毛计数值（`canaryUsageTokenCount`：五个实报字段求和；未报字段不计、不发明 0）。超限即刻 `abort.abort()` ——宿主停止生成——流照常结算，`abortedByTokenCap:true`。声明包含语义（cacheRead ⊆ input 等）导致的重复计数对 kill switch 是**安全方向**（提前中止）；账目与报告始终用原始 usage。
2. **单调用·事后兜底**：adapter 路径无流中钩子，控制器在结算后对 `measuredTokens > perCallTokens` 判 `blocked(token-cap-exceeded)`（interim 结算，treatment 臂不再运行）。
3. **臂间/总量门**：baseline 结算后其毛计数即对照 per-arm/per-task/total 上限，超限则 treatment 臂的预留**永不发生**；双臂完成后累计毛计数再对照 task/total。`abortedByTokenCap` 的流中中止同样归为 `token-cap-exceeded`。

**不错记规则**：usage 未上报的字段 = unreported（不是 0）；宿主完全未报 usage 的调用 `measuredTokens=undefined`，run 级 `allUsageMeasured:false`——上限"通过"绝不在未计量花销上主张。

## 3. 脱敏验证（验收行 1）

- client 身份仅含 `provider/model/routeId/accountIdMasked`；`maskAccountId` 输出形如 `acct…(32 chars)`。
- `verifyHostClientIdentity` 在任何调用前把 client 身份与绑定对账，**raw 账号 id 冒充 mask 是显式失败**（`host-client-account-not-masked`）。
- `readZcodeHostClient` 经 `readDshLlm` guarded reader 读取宿主——Cordis 未声明服务抛错也归一为 `undefined`。
- 本轮实测：本环境无 `R3A_ADAPTER_MJS`，runner 输出 `verdict:"blocked", abortTrigger:"host-client-unbound", realCallsMade:0`，exit 0——**无 client 时 fail-closed 已被真实执行路径证明**（非仅测试断言）。

## 4. 保留的安全契约（验收行 3）

美元硬预算（`decideAdmission` hard 模式、`basis:'provable-hard-bound'`、conservative floor ≤ 路线上界）、只读工具白名单（`"*"` 禁止、per-branch fail-closed）、授权台账（`paid-model-call` 显式 grant）、默认无工具——**全部原样保留**。控制器依旧没有真实记忆写入、guarded-active、publish 的代码路径（结构性扫描测试继续钉住）；宿主客户端模块同样无 fs/network/fetch、无 adapter `complete()` 调用（metering-coverage gate 实测 106 文件 4 处 allow-listed 命中不变）。

## 5. baseline/treatment 各至多一次（验收行 4）

绑定校验（现含 token 行）+ 负控制全部通过后才允许真实 canary；控制器结构保证恰两次调用（baseline→treatment，无重试无扩集），且 `host-client-unbound` / `host-client-identity-mismatch` / `token-cap-exceeded` 任一即中止整 run——不自动扩大任务、不重试、不买更多 token。

## 6. 门禁记录（本 attempt 实测）

| 命令 | 结果 |
| :-- | :-- |
| `pnpm run typecheck` | exit 0 |
| `pnpm exec vitest run tests/e2e/host-smoke/real-benefit-controller.test.ts tests/e2e/host-smoke/real-benefit-host-client.test.ts` | **53 passed**（32 + 21），exit 0 |
| `pnpm run guarded-regression` | exit 0 |
| `node scripts/eval/metering-coverage.mjs` | OK：106 文件、4 处 allow-listed、0 unmetered |
| `node scripts/host-smoke/budget-binding.mjs --json` | exit 0，`runnable:false` + 缺失项含四个 token cap 键（当前环境） |
| `node scripts/host-smoke/real-benefit.mjs --json` | exit 0，`verdict:"not-run"`（无凭据）／`verdict:"blocked", abortTrigger:"host-client-unbound"`（合成凭据齐备、无真实 seam） |
| `pnpm exec vitest run tests/unit/dsh-bridge` | 93 passed，exit 0（rev5 冻结静态门含内） |

## 7. 实跑前置（缺一即保持 not-run/blocked）

1. 操作者提供含真实账号/预算/费卡/路线/白名单/token 梯的 `R3A_CREDENTIAL_FILE`（或等价 env）；
2. 操作者注入真实 provider seam：`R3A_ADAPTER_MJS` 指向导出 `invoke(request)` 的模块（宿主 adapter 绑定），client 身份自动脱敏对账；
3. 两者齐备后 `budget-binding.mjs --json` 给 `runnable:true`，`real-benefit.mjs` 才允许**恰好两次**真实调用（baseline/treatment 各一次），全程受 §2 的三层 token 上限与美元硬预算约束，禁止真实记忆写入。

## 8. 诚实边界

- 本轮零真实调用；合成 fixture 仅用于证明 runnable 分支机制（binding `runnable:true` 经由本机临时凭据实测后已删除，不留账号痕迹）。
- `passed`（若未来达成）严格限定为「该单任务上治疗臂可验证更高分」，不外推为策略收益（预注册 §3）。
- 工程绿（本报告全部命令 exit 0）**不是**任务收益主张。
