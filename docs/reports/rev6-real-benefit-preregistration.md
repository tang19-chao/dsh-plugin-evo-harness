# rev6 R3 预注册：最小预算真实收益评测（baseline vs recorded advice）

**状态**：`preregistered — 未采样`
**写定时刻**：2026-10-31T05:3x+08:00（先于任何真实调用采样；本仓库当前无任何真实调用，见 §8）
**任务**：t13（rev6 §5.8 / §7，D-4 口径）
**授权**：真实收益评测属用户已授权范围（Z-4）；但「已授权 ≠ 可实跑」——实跑必须同时满足 §7 的 B-1..B-4 四项绑定，缺任一项即 `not-run`/`blocked`（合法终态），不得以 mock/estimated 冒充（N-10）。

---

## 1. 研究问题（一句话）

在同一单任务 canary 上，**recorded advice（治疗臂）是否比无 advice 的 baseline（对照臂）在冻结 RewardContract 量尺上取得可验证的更高回报**，且全程在可强制执行的硬预算内。

## 2. 冻结的实验设计（采样前不可更改）

| 项 | 冻结值 |
| :-- | :-- |
| 设计 | 配对两臂（2×1 内嵌于单任务）：baseline（无 advice）/ treatment（同 prompt + recorded advice） |
| 独立单元 | **canary 任务 = 1 个**（`taskId` 来自绑定凭据）。两臂是同任务的两个条件，不是两个独立样本；episodes/轮次概念不适用（每臂恰 1 次真实调用） |
| 任务集规模 | **恰好 1**。不自动扩大（B-4）；扩大任务集是新的预注册 + 新的授权 |
| 治疗条件 | 治疗臂 prompt 附加操作者提供的 `recordedAdvice` 原文；对照臂无此节 |
| 主结局 | 两臂 `scoreUnderRewardContract`（`r4/verifier-first-v1`，`trajectory-signals-v1`，权重 `{completion:0.5, steps:0.1, tool:0.1, turn:0.3}`，clip [-3,3]，F3 词法界）的 `reward` 差：`delta = reward_treatment − reward_baseline` |
| 判定规则（only-if） | **仅当两臂 verification 均为 trusted provenance**（注册 producer + 绑定 evidenceHash）才可判 `passed`（delta>0）/`failed`（delta≤0）；否则一律 `insufficient`——工程绿/可运行性不得替代任务收益（A-R3-4） |
| 次结局（观察性，不判定收益） | 每臂：provider 原始 usage 字段、cost（micros，provenance 三态）、cacheRead（t12 三态精度规则）、工具计数（requested/allowed/denied/executed）、settlement phase（final/interim） |
| 预算上限 | 绑定凭据 `generalBudgetMicros`（硬上限，可执行）；每臂调用前 `decideAdmission` 必须 `admitted:true, basis:'provable-hard-bound'`；预留额 = 路线可证明上界（非估计值）；conservative floor 必须 ≤ 上界（B-2 完整性约束，未知用量结算不得击穿预留） |
| 工具面 | 只读白名单 `readonlyTools`（可为空表；`"*"` 禁止）；per-branch tool face fail-closed |
| 中止条件（任一即停，不重试、不扩） | `identity-missing` / `noPolicy` / `unauthorized-tool` / `budget-exhausted` / `authorization-denied` / `tool-executor-unavailable` |
| 中止后的报告口径 | 中止是**控制事实**不是测量：整个 run 判 `blocked` + 命名的 trigger；中止臂的数据不得参与任何收益表述 |

## 3. 分析计划（先于数据）

1. **可信门先行**：读每臂 `verificationTrusted`。任一臂 untrusted/absent ⇒ 终态 `insufficient`，不再往下算（防「用不可信 verdict 拼收益」）。
2. **收益判定（only-if 通过后）**：`delta = treatment − baseline`；`delta > 0 ⇒ passed`，`delta ≤ 0 ⇒ failed`。单任务 canary **不做**统计显著性检验（n=1 配对无检验力），`passed` 的含义严格限定为「该单任务上治疗臂可验证得分更高」，**不得**外推为策略收益；多任务统计版是新的预注册。
3. **分层报告**：engineering-runnable（脚本退出码/typecheck/测试）≠ task-benefit（§2 主结局）≠ learning-semantics（本轮不写回任何经验）。三层各报各的。
4. **精度纪律**：cacheRead/cost 只报 provider 实报字段 + 声明的 counting semantics；未报字段=unreported（不是 0），无 semantics=unknown。`estimated`/`unknown` 永不改标 `measured`。

## 4. 判为各终态的条件

| 终态 | 条件 |
| :-- | :-- |
| `passed` / `failed` | B-1..B-4 齐 + 两臂实跑 + 两臂 trusted verdict + delta 可比 |
| `insufficient` | 两臂实跑（含 transport failure 的 failed 臂）但 verdict 不可信或任一 reward 缺失 |
| `blocked` | 运行期中止（identity/noPolicy/unauthorized/budget/authorization/executor 任一） |
| `not-run` | 绑定不完整（B-1..B-4 任一缺失）——**合法终态**，附缺失项清单 |

## 5. 本轮执行的实际口径（如实声明）

本仓库现状（预注册写定时刻实测）：

- `src/**` 无账号原语（grep `accountId|tenantId|orgId|billingAccount` = 0 命中）；
- 进程 env 无任何 R3A_* / 账号 / 预算变量（`work/t13/binding-credential-current-env.json`：`runnable:false`，5 项缺失）；
- `HOSTSMOKE_AUTHORIZED` 未设置，且单独设置也不构成绑定（in-host 9.4-2 已如此判定）；
- 无已绑定的真实 provider client（`R3A_MODEL_SEAM` 仅接受外部注入的 host 客户端；runner 拒绝伪造响应）。

因此**本轮真实调用保持 `not-run`**，交付物为：可复跑的绑定机制（controller + 两个脚本 + 31 条负控制测试）+ 本预注册 + `not-run` 结果报告（§7 的 A-R3-5 合法终态）。绑定齐备时的实跑路径已由 runnable-fixture 证据验证（`work/t13/canary-runnable-fixture.json`：两臂 admitted、硬上限预留、interim/final 结算、无真实客户端时诚实 `failed` + `insufficient`）。

## 6. 交付物与机读证据

| 文件 | 作用 |
| :-- | :-- |
| `src/dsh-bridge/real-benefit-controller.ts` | fail-closed 控制器：B-1..B-4 校验、`decideAdmission` 硬准入、two-phase 结算、tool face、授权台账、RewardContract 计分 |
| `scripts/host-smoke/budget-binding.mjs` | 绑定凭据（机读 JSON）：`runnable` + 四行 B-1..B-4 + 缺失项 + 信封声明（HOSTSMOKE_AUTHORIZED 不算绑定） |
| `scripts/host-smoke/real-benefit.mjs` | canary 入口：绑定不完整 ⇒ `not-run` 报告；完整 ⇒ 恰两次真实调用 + 分层报告 |
| `tests/e2e/host-smoke/real-benefit-controller.test.ts` | 31 条负控制/正控制（A-R3-1..A-R3-6 全覆盖） |
| `work/t13/binding-credential-current-env.json` | 当前环境凭据（`runnable:false` + 命名缺失项） |
| `work/t13/binding-credential-runnable-fixture.json` | runnable 分支凭据（合成 fixture，标注无真实调用） |
| `work/t13/canary-current-env.json` / `work/t13/canary-runnable-fixture.json` | 对应 canary 报告（`not-run` / `insufficient`） |

## 7. 与 rev6 契约的对应

- A-R3-1 绑定机制可执行 → 缺账号 `blocked(account-*)`、缺硬上限 `admission-not-provable-hard-bound`、hard 模式 + 无 override 输入、预算耗尽即拒（测试钉住）。
- A-R3-2 canary 字段完整 → 模型/宿主/usage 原始字段/cost/cacheRead/工具计数/settlement phase 全在 `CanaryCallRecord`。
- A-R3-3 中止负控制 → 六个命名 trigger 各有测试；不重试不放大（恰好两次调用断言）。
- A-R3-4 结论词汇表 → 只出五态；`insufficient` 结构性不可跳过（C2-pre 无注册 producer）。
- A-R3-5 不可绑定合法终态 → `not-run` + 缺失项清单 + 机制/预注册照常交付。
- A-R3-6 无真实记忆写入 / 无 guarded-active / 无 publish → 控制器无该代码路径（结构性扫描测试）。

## 8. 采样登记（预留）

首次真实调用发生时在此追加：时刻、绑定凭据 sha256、两臂 callId、usage 原文、settlement 结果。**当前为空——本轮未发生任何真实调用。**

| 字段 | 值 |
| :-- | :-- |
| firstRealCallAt | （空：not-run） |
| bindingCredentialSha256 | （空：not-run） |
| baselineCallId / treatmentCallId | （空：not-run） |
