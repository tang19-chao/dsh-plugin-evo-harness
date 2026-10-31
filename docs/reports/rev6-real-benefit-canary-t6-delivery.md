# rev6 真实收益 canary — t6 最终交付报告（最终门禁与交付）

- 团队：rev6-real-benefit-canary · 任务 t6（integration, attempt 1, `fa838fdd-747c-4ba4-a896-bc7cdfa79a66`）
- 日期：2026-10-31 · 执行者：integrator
- 上游：t4（实现，binding-engineer）已通过；t5（独立审核，evidence-reviewer）verdict=pass（机制 4/4，53/53 独立复跑）

## 1. 最终结论

**真实收益 NOT-RUN（合法终态，A-R3-5）。本轮真实模型调用 = 0，真实 token 消耗 = 0。**

用户已授权 800,000,000 token 总硬上限；授权 ≠ 可用绑定。当前真实环境缺少可绑定的真实凭据与 adapter seam，按 N-10（不伪造数据）与 fail-closed 结构，canary 拒绝执行并输出诚实 not-run/blocked 报告。交付物为**已验证的绑定机制本身**，不是收益主张（engineering green ≠ benefit claim）。

## 2. 交付物（SHA256 快照，t6 门禁前后无漂移）

| 文件 | 作用 |
| :--- | :--- |
| `src/dsh-bridge/real-benefit-host-client.ts` | 真实宿主客户端绑定：`readZcodeHostClient` 经 guarded reader 解析 `ctx.llm`（唯一公开入口 `stream()`）；`R3A_ADAPTER_MJS` adapter invoke 绑定；脱敏身份（provider/model/routeId + maskAccountId，原始账号 id 永不进入 client）；流中 token kill switch |
| `src/dsh-bridge/real-benefit-controller.ts` | fail-closed 门（`host-client-unbound` / `host-client-identity-mismatch` 均在 ledger 组装前）+ 三层 token 硬预算（流中即停 + 事后兜底 + 臂间/总量门）；只计 MEASURED usage，未报字段永不错记为 0 |
| `tests/e2e/host-smoke/real-benefit-host-client.test.ts` | 21 项 H-1..H-6 机制控制（含负控制） |
| `tests/e2e/host-smoke/real-benefit-controller.test.ts` | 32 项控制器门禁测试 |
| `scripts/host-smoke/real-benefit.mjs` | 唯一执行入口：凭据缺失 → exit 0 + not-run 诚实报告；`--require-runnable` 用于真实门禁 |
| `scripts/host-smoke/budget-binding.mjs` | 机器可读绑定凭据（含 token 梯行） |
| `docs/reports/rev6-real-benefit-binding.md` | t4 实现报告（t5 已核与源码一致） |
| `docs/reports/rev6-real-benefit-canary-t6-delivery.md` | 本报告 |

## 3. 最终门禁矩阵（全部通过，exit 0）

| 门禁 | 结果 |
| :--- | :--- |
| `pnpm run typecheck` | exit 0 |
| 全量 `pnpm test`（Vitest） | **162 文件 / 2932 测试全部通过**（t4 前为 161/2910；+1 文件 +22 测试 = 新增 53 项 canary 测试中 21+32 两文件，e2e 计数 22/303） |
| `pnpm run check:docs` | exit 0（README 计数经实测 `vitest list` 同步为 162/2932；其余 MISMATCH 行为 attestation 篡改检测用例的预期负测试输出） |
| `pnpm run check:encoding` | exit 0（全部 tracked blob 为 LF 文本或显式例外） |
| `pnpm run check:build-smoke` | exit 0（ESM bundle 构建 + 导出面 73 项 + 插件名匹配，stale: false） |
| `pnpm run check:negative-result --assert` | exit 0（A1..A6 历史负结果完整） |
| `pnpm run guarded-regression --json` | exit 0（t7/V5：trusted-producer registrar 已移除，本轮无 id 可被提升） |
| `pnpm run check:mutation` | verdict PASS（4/4 pinned mutants KILLED；worktree zero-residue，副本已删） |
| 干净副本 `node scripts/host-smoke/real-benefit.mjs --json` | exit 0，`verdict=not-run`，`realCallsMade=0`，边界声明内嵌 |

docs 门禁中两条**非致命**结构性观察（如实记录，未修复亦未掩盖）：
- commit `84a3d82`（历史提交）树内无 `.gitattributes`；磁盘上 `.gitattributes` 存在且独立 encoding 门禁通过。修复需改写历史或新 commit，与"零 commit"纪律冲突，留给有 commit 权的轮次。
- attestation 要求干净 worktree；本轮按纪律不做 commit/push，脏树 attestation 以 `--allow-dirty` 显式记录缺陷或留待归档轮处理。

## 4. 契约要求的交付明细

### 4.1 脱敏绑定状态（§7 B-1..B-4 + token 预算）

| 绑定项 | 状态 | 缺项 |
| :--- | :--- | :--- |
| B-1 账户 | ❌ 未满足 | `R3A_ACCOUNT_PROVIDER` / `R3A_ACCOUNT_MODEL` / `R3A_ACCOUNT_ID` 全部缺失 |
| B-2 硬预算（micros） | ❌ 未满足 | `R3A_GENERAL_BUDGET_MICROS` 等 + rate card + route 全部缺失 |
| B-3 只读工具白名单 | ❌ 未满足 | `R3A_READONLY_TOOLS` 缺失（显式必填，`*` 在校验层被拒） |
| token 硬预算 | ⚠️ 仅默认梯 | runner 将 800M 授权上限展开为默认梯（total=800M, task=400M, arm=200M, call=100M）仅作显式 fallback，受同一生产验证器约束；操作者提供的 cap 优先 |
| B-4 中止开关 | ✅ 结构保证 | controller 自身 fail-closed 结构（9 个具名触发器），不可为 false |

### 4.2 token 预算与实际消耗

- **授权上限**：800,000,000 token（`CANARY_TOTAL_TOKEN_CEILING`，用户授权，写死于 `real-benefit-controller.ts:152`）。
- **实际消耗**：**0 真实 token**。`realCallsMade=0`；未产生任何真实模型调用，故无 usage 记录（not-run 报告中的默认梯数字是 fallback 配置，不是消耗）。
- 中止机制已验证：流中 kill switch（H-3 实证中止到达宿主 signal）+ 事后兜底 + 臂间/总量门，53/53 测试覆盖。

### 4.3 真实调用次数

**0**（干净副本实测 + t5 独立复核 + t4 实测三处一致）。

### 4.4 工具白名单

显式必填（缺失即 binding-unconstructable；空数组合法；`"*"` 校验层拒绝）。本环境未提供，故无白名单被安装，无工具执行发生（toolFace counters 全 0）。

### 4.5 收益 / 未执行原因

- **收益：未测量（NOT-RUN）**。不存在任何可引用的收益数字。
- **未执行原因**：本环境无 `R3A_CREDENTIAL_FILE`（26 个 `R3A_*` 键全部缺失）、无 `R3A_ADAPTER_MJS`（无导出 `invoke(request)` 的真实 adapter）、无可绑定的 ZCode GLM-5.3-Flash `ctx.llm` 客户端。`HOSTSMOKE_AUTHORIZED` 未设。授权信封不能替代账户绑定（D-4）。

### 4.6 未决授权（激活路径）

待操作者提供：① 含 26 个 `R3A_*` 键的凭据文件；② 导出 `invoke(request)` 的真实 adapter 模块（`R3A_ADAPTER_MJS`）。随后执行
`node scripts/host-smoke/real-benefit.mjs --json --require-runnable`
即可在既有门禁（hard admission + 三层 token 预算 + 只读白名单 + 9 类中止触发器）下做最小真实 canary。在此之前任何一轮都不应尝试真实调用。

## 5. 纪律与边界

- 零 commit / 零 push（工作树变更仅 README 计数同步与本报告；t4/t5 交付物字节未动，快照比对一致）。
- 零真实记忆写入、零 guarded-active、零 publish。
- 零真实模型调用、零预算消耗。
- t5 两条非阻塞观察（总量 cap 执行级测试建议；budget-binding/real-benefit 默认梯严格度对齐建议）已记录，留给下轮，本轮不扩范围。

## 6. t6 唯一变更文件

- `README.md`（3 行测试计数 161/2910 → 162/2932，实测同步，消除 docs 门禁唯一致命缺项）
- `docs/reports/rev6-real-benefit-canary-t6-delivery.md`（本报告，新增）
