# rev6 实施契约（冻结版 · t7）

- **任务**：`evo-harness-rev6` / `t7`（requirements：冻结 rev6 验收、授权边界与 rev5 交付基线）
- **attempt**：`52bf91f2-5f43-4da3-8280-4e2bde6f68b8`（第 3 次；前两次为上游 429 限流中断，非内容失败）
- **作者**：integrator
- **冻结时刻**：2026-10-31T00:56–01:35（Asia/Shanghai）
- **冻结对象**：`HEAD = 97e38db37305b24f695a5f989428b3611f84987c`，`main...origin/main` = 0/0，`git stash list` 空；冻结时（契约文件落盘前）工作树 `git status --porcelain=v1 -uall` = **74 行**（28 modified + 46 untracked，其中第 74 行为 rev5 最终报告）。**本文件是第 75 个路径（rev6 新建文档），落盘后 status = 75 行**；rev5 受测集仍恒为 73 + 报告 74，两者不可混淆
- **本文件是什么**：rev6 的**范围、验收、可复跑命令、授权边界与写入归属**的唯一冻结口径。实现由各任务负责人完成，本文件不含实现代码改动。
- **本文件不是什么**：不是进度报告；不是 rev5 原文（rev5 原文在 `C:\Users\Administrator\Downloads\dsh-plugin-evo-harness-交叉审核与下一步计划-rev6.md`，sha256 `4c4ded2ef758b28650b47ce545e33eabe3815d53ebbbe56a63f1e4c6b8d59436`，18,724 B）；不是批准（t14–t19 验证、t20–t25 审核、t26 集成各自独立判定）。

---

## 0. 一页结论（给后续 18 个任务直接照做）

1. **rev5 交付字节零漂移**。73 个受测路径与 `work/t23/snapshot.csv` 及 `docs/reports/rev5-final-integration.md` 附录 A 逐文件一致（合计 **2,481,944 B**），第 74 路径 `docs/reports/rev5-final-integration.md` 仍为 `3c785ee7…`/22,598 B。三源交叉核对 0 不一致、0 漂移（§1.2）。
2. **rev5 交付仍未提交**（G12 未解除）。`check:clean-tree` 因此**预期为红**（28 tracked change + 46 untracked，74 条 failure）；这不是缺陷，是「未提交」的真实状态。远程 CI、目标 attestation **都还没有**，谁写成绿即失败（§5.1）。
3. **现有 attestation 不覆盖 HEAD，且这是可执行证明**：`--expect-commit 97e38db…` 与 `--strict` 均 exit 1（`attestation-target-mismatch` / `attestation-head-mismatch`）。记录描述的是 `1b7920ee…`。R0 只做**准备**，不 commit/push（§5.2）。
4. **默认安全未弱化**：`execution.mode='shadow'`、`applyWinningPatch=false`、`permissions.memory.allowed=false`、`publish.allowed=false` 恒假、26 键公开面不变、`memoryRealWrites:true` 只存在于测试装配。rev6 不放松（G1/G2）。
5. **R3 已获授权，但受绑定前置条件约束**：真实收益评测是用户已授权范围，然而 `src/**` **没有任何账号标识原语**（grep `accountId|tenantId|orgId|billingAccount` 0 命中），且宿主信号 `HOSTSMOKE_AUTHORIZED=1` 只能表示「信封」，无法绑定账户/预算（`in-host.mjs` 自己对 9.4-2 也判 `failed` 并写明 "refusing to fabricate evidence"）。因此：**账号 + 硬预算可强制执行 → 才能实跑；否则 must be `not-run`/`blocked`，不得用 mock/estimated 冒充**（§7）。
6. **明确未授权**：commit/push、真实记忆写入、`guarded-active`、publish、真实远程 CI 声明、「以历史 −0.250 为代价换取新结论」的一切改写（§6）。
7. **写入归属有两个真实冲突点**，已在本文件冻结（§4.2/§4.3）：`t9` 的 inScope 含不存在的 `src/jitrl/orchestrator.ts`（真实文件是 `src/orchestrator.ts`，不在任何任务范围内）；`t11` 必须改 rev5 已交付的 `scripts/host-smoke/run.mjs`/`in-host.mjs`。另有 C-4 应用后的**联动改单**（登记文件 + 指针测试各一处），见 §5.3。

---

## 1. 冻结基线（本机实测，2026-10-31T00:56–01:28）

### 1.1 环境

| 项 | 值 |
| --- | --- |
| OS / shell | Windows（win32/x64），pwsh 7 |
| Node / pnpm | `v22.23.1` / `11.7.0`（`packageManager: pnpm@11.7.0`） |
| 仓库根 | `C:\Users\Administrator\Documents\Codex\2026-10-19\https-github-com-google-research-harness2` |
| HEAD | `97e38db37305b24f695a5f989428b3611f84987c`（`docs(p2-p6): backfill J-1 gate gap disclosure`，普通提交，无 `Attestation-Target` trailer） |
| 远端关系 | `git rev-list --left-right --count origin/main...HEAD` = `0	0` |
| 工作树 | 冻结时 74 行 = 28 `M` + 46 `??`（第 74 行为 rev5 最终报告）；本契约落盘后 75 行（+本文件） |
| 依赖安装 | `pnpm install --frozen-lockfile --offline` exit 0（`Already up to date`） |

### 1.2 rev5 交付基线（三源交叉核对，0 漂移）

| 源 | 内容 | 结果 |
| --- | --- | --- |
| `docs/reports/rev5-final-integration.md` 附录 A | 73 行（状态/路径/字节/行数/sha256） | 73 行、合计 **2,481,944 B** |
| `work/t23/snapshot.csv`（`28f65f6e…`，10,081 B） | 73 行同构快照 | 与附录 A **0 不一致**、0 行多余 |
| 当前工作树实际字节 | 逐文件 `readFileSync` + sha256 | 与 CSV **0 漂移**、0 缺失 |

- **第 74 路径**：`docs/reports/rev5-final-integration.md` = `3c785ee7cf9591bc2f881ef5c3f63ddd3d536976a69c7bacb1b4c1f4b0124ff6`，22,598 B，249 LF 行；与 `work/t23/report-identity.txt`（`30cd34ac…`）逐字段一致。它是纯文档，不参与代码字节断言。
- **rev5 需求锚点**：`docs/REV5-IMPLEMENTATION-CONTRACT.md` = `6d3fa74ac330b359f145b05dc644fc436b03e8792e028af8aa0eb743c7347958`，58,098 B。只绑定需求文档，不替代实现字节。
- **完整 73 路径清单**见附录 A（由 `work/t23/snapshot.csv` 直接生成，含 64 位 sha256，可逐行 `Get-FileHash` 复核）。
- **可复跑脚本**：`work/t7/verify-baseline.cjs`（三源核对）→ `work/t7/rev5-baseline-verification.json`；`work/t7/drift-check.cjs` → `work/t7/drift-report.json`。

#### 1.2.1 漂移预算（**队长已批准 D-1..D-4，本节为生效口径**）

上表的「0 漂移」是 **t7 冻结时刻**的实测事实，**不是** rev6 结束时的判据。队长于 2026-10-31T01:38 批准 D-1/D-3 后，rev6 **明确授权**以下 rev5 路径发生漂移；下游验证（t14–t19）、审核（t20–t25）与集成（t26）**必须按本表判定，不得把授权漂移报成 finding**：

| # | 任务 | 路径 | 附录 A 行 | 授权依据 | 冻结时 sha256 | 约束 |
| --: | --- | --- | --: | --- | --- | --- |
| DR-1 | t8 | `docs/reports/p0-evidence-correction.md` | 06 | **D-1**（C-4 联动改单 L-1） | `d84d4775692fbe0cacf1d23886454148f1466b8a650bf550132103104474283c` | 仅 §C-4 状态行、§2 第 2 条、§3「未执行/未授权」行；C-1/C-2/C-3/C-5 与全部数字不动 |
| DR-2 | t8 | `tests/unit/p62/docs-correction-pointers.test.ts` | 70 | **D-1**（C-4 联动改单 L-2） | `1491d476c4e2adbf6d153960219be8682ed6fdd9a0851671605c06bddf14a4bb` | 仅 `:70` 单条断言；ADR 0007 pin 三元组断言逐字节不动 |
| DR-3 | t9 | `src/jitrl/index.ts` | 29 | 契约 §4.1（唯一 R5 重叠） | `778b251aa41a693226a35aba738899896b9f2d9de3c22df9ee69f4d326ee8d26` | 只增写回门控接线；不改既有导出语义与默认值 |
| DR-4 | t11 | `scripts/host-smoke/run.mjs` | 20 | **D-3** | `de90864d9ad9cdfb8639b56279c2158d62e15eed8a93e4a139df5851b9ddc780` | 契约 §4.3 四条：只增量、`9.4-2/3` 只收紧、默认目标不改回 rc1、复跑 e2e |
| DR-5 | t11 | `scripts/host-smoke/in-host.mjs` | 18 | **D-3** | `95836578834aae6d602f5e6c79e69edec35d7ded64036b90382a8335a1f925a6` | 同上；保留 `refusing to fabricate evidence` 语义 |
| DR-6 | t26 | `README.md` | 02 | G6（计数一次收口） | `fc8987c0ee8b5181f0b90855144dea11c7707be601e41dad1acaeb26521f3241` | **仅**当测试文件/用例数变化时才改计数与摘要行 |

**判据（取代「全 73 条都不许变」）**：

1. **其余 67 条**（= 73 − DR-1..DR-6，**六条全部计入**）**必须逐字节保持**，一个字节都不能变。算术：73 − 6 = **67**。（此前本文写作「= 73 − DR-1..DR-5，不含 DR-6」，是**错算**为 68→67 的笔误；队长 2026-10-31T01:41 的「其他 67 路径保持冻结」为正确口径，本节按 67 修正。）
2. **DR-6 是条件性漂移**：若 rev6 未增删任何测试文件/用例，`README.md` 必须仍为 `fc8987c0…`；一旦增删，`README.md` 只能由 t26 按同一次绿色 JSON 重铸。
3. **受保护字节清单（§3）不因本节而放宽**——§3 的 pin 文件、冻结报告族、rc1/rc2、`final-attestation.json`、`NEGATIVE-CONTROL-RUNBOOK.md`、pr4a 预注册与夹具**一律不得漂移**，它们是 §3 而非本节管辖。
4. 复跑方式：`node work/t7/drift-check.cjs` 会打印当前漂移集；把其 `drift[].path` 与 **DR-1..DR-6**（六条全部，含 `README.md`）求差集，**差集必须为空**。该脚本的 `extra` 字段另计（rev6 新建文件不属于 rev5 73 路径，不算漂移）。

   **可执行的 67 条判据**（t26 与任何复核者可直接跑）：

   ```powershell
   # 输出 67 条「必须冻结」清单（73 − 6 条 DR），逐条比对 CSV 记录的 sha256
   node work/t7/freeze67.cjs
   #   exit 0 = 67 条全部与冻结时字节一致（合规）
   #   exit 1 = 有点名文件漂移（越权改写），脚本逐条打印 path / 期望 / 实际
   ```

   该脚本的 DR 白名单**硬编码为六条**并与本节表一致；若白名单与本表不符，以本表为准并修正脚本。

   **判别力（负控制已实测，2026-10-31T01:43）**：对 `scripts/eval/smoke-build.mjs`（附录 A #17，`121efb8b…`/11,359 B）追加一行注释 → 脚本 exit 1、点名 `FROZEN-PATH-DRIFTED: scripts/eval/smoke-build.mjs`、打印 expected `121efb8b…`(11,359 B) vs actual `2a41cf75…`(11,389 B)；还原后 exit 0 且哈希回到 `121efb8b…`。⇒ 该判据不是空话：**任一冻结路径被改一个字节即红**。
5. 引用「73 路径零漂移」这句话的下游任务，**必须同时引用本节**，否则该引用无效。

### 1.3 本 attempt 的门禁实测（**一次连续扫描，23/23 与预期一致**）

> 逐条命令、退出码、起止时刻、日志路径见附录 B 与 `work/t7/rev6-gate-log.json`；单条日志在 `work/t7/logs/<gate>.log`。**这是本文件的证据基线，后续任务改动树后必须重跑自己相关的门并重新取样，不得引用本表当当前证据。**

权威测试报告：`work/t7/rev6-vitest-final.json`，sha256 `5e69c40f81d79f859e68cde5a312e636207a03d3d4dbdf52c9eeece171908953`，975,793 B。
**150 files / 784 suites / 2,727 tests / passed 2,727 / failed 0 / pending 0 / todo 0 / success=true**；unit 132 files/2,510 tests，e2e 18 files/217 tests；README 计数 150/2727 与之精确一致，配置参考 78 vs 78。

**两处「预期红」是判据的一部分，不是失败**：

| 门 | 实测 | 为什么这是正确的 |
| --- | --- | --- |
| `check:clean-tree` | **exit 1**，`trackedChanges=28`、`untracked=46`、`unexpected=46`、`failures=74` | rev5 交付未提交（G12）。禁改判据：提交落地后才允许转绿 |
| `attest --expect-commit <HEAD>` / `--verify --strict` | **exit 1**（`attestation-target-mismatch` / `attestation-head-mismatch`） | 记录 `1b7920ee…` 只描述它自己的提交；**HEAD 未被证明**。这两条红就是「不伪造证明」的机器证据 |

**一处「预期橙」**：`pr4a-stats.verify.mjs --firewall …-holdout-leak.json` = exit 1（点名泄漏 task），与 clean 夹具 exit 0 构成 holdout 防火墙的双向判别力。

### 1.4 负结果与 JitRL 现状（rev6 R1 的不可改基线）

| 项 | 实测值（`work/t7/neg-result.json`，`node scripts/eval/negative-result-diag.mjs --json` exit 0） |
| --- | --- |
| 历史对照 | `C3-online − C3-frozen` 均值差 **−0.250**（同任务、episodes=5、rounds=3、seed 6221082、k=10、12 任务） |
| 偏离统计 | `deviationStats = { total: 36, harmful: 18, gateFired: 0 }` |
| 首个有害偏离 | `ci-04|2|2`：prior `guardrails:append(1)` → 选 `noop`，`verifierRewardMismatch=true` |
| 最小反例 | 5 个 |
| 断言门 | `check:negative-result` exit 0，`A1..A6 PASS` |

**解释纪律**：`−0.250` 是 JitRL C3-online 与 C3-frozen 的历史对照，**不是** Dream-RSI 归因；`gateFired=0` 说明改善门从未触发。rev6 R1 只能**新增**实验版本与数据文件，不得改写上述任一数字（G7）。

### 1.5 宿主与授权事实（R2/R3 的起点）

| 项 | 实测/读取 |
| --- | --- |
| `docs/reports/host-smoke-rc2.md`（`d62bc9f5…`） | 八表面 `native=3 fallback=0 unavailable=0 not-run=5`；`enabled=8/8` 但 `mountable=3/8`；`9.4-2`/`9.4-3` = `not-run` |
| branch 身份 | 四个 hook 的 dispatch **`branchId=none`**（`branch=0 session=1`）；`agent/pre-step` 只有 carrier ⇒ Gate 4 **blocked**（不得用 contract-shaped 场景替代） |
| 冻结 rc1 | `docs/reports/p61-host-smoke-rc.md` blob `932f80dae2995786534288827becb8dc2bbe6c3a`（HEAD 与工作树一致） |
| 覆盖保护 | `scripts/host-smoke/report-path.mjs`：目标为 rc1 且已存在时**拒绝写入**，除非 `--force`；新报告必须走 `--out` |
| 授权信封 | `HOSTSMOKE_AUTHORIZED=1` 仅表示「已声明授权」；`in-host.mjs` 无账户/预算绑定时对 `9.4-2` 判 `failed` 并写明 `refusing to fabricate evidence` |
| 记忆/发布权限 | `resolveExecutionProfile`：`memory.allowed === false`（唯一放行是显式 `memoryRealWrites:true`，仅测试装配可达）；`publish.allowed === false` **恒真** |
| 默认装配 | `execution.mode='shadow'`、`applyWinningPatch=false`、`promoteOnComposeSuccess=false`、`store.mirrorToMemoryBridge=false`、`hostAdvisor.enabled=false`、`holdoutTreeCount=0` |

---

## 2. 全局不变量（G1–G14，所有任务必须满足）

| # | 不变量 | 可核查判据 |
| --- | --- | --- |
| G1 | **默认安全不弱化** | `DEFAULT_EVO_HARNESS_CONFIG` 的 `execution.mode`/`applyWinningPatch`/`memoryBridge.promoteOnComposeSuccess`/`dreamRsi.holdoutTreeCount`/`jitrl.store.mirrorToMemoryBridge`/`jitrl.hostAdvisor.enabled` 保持现值；任何默认 `allowed===true` 即失败 |
| G2 | **授权边界** | 不执行付费模型、真实外部工具、真实记忆写入；宿主 smoke 只允许 shadow/只读；`9.4-2`/`9.4-3` 保持 `not-run`；`memoryRealWrites` 只出现在 `tests/**` 装配里，`src/**` 生产路径不得设置它 |
| G3 | **证据纪律** | 每个被引用的数字附「命令 + 退出码 + 关键输出行 + 取样时刻」；旧数字只能以「历史（某时刻）」引用；`not-run`/`unknown`/`not-evaluable` 不得写成 pass |
| G4 | **负控制按 runbook** | 改门禁/守卫/变异的任务按 `docs/NEGATIVE-CONTROL-RUNBOOK.md` 规则 2/3/3.5/4/4b 落盘：副本、`keep-bak`/`red.log`/`anchor`、身份键（relpath + snippet hash）、先红后写、还原后同刻哈希 |
| G5 | **测试输入自包含** | `tests/**` 不得把仓库根 `work/`（gitignore）当**输入**；缺输入显式失败，不得 `skip`/`todo`/`if (!exists) return`。允许在 `work/` 下**写**临时目录 |
| G6 | **计数一次收口** | 实现任务不得手改 README 计数行；最终由 `t26` 用**一次绿色 JSON** 重铸 |
| G7 | **冻结家族不改** | `docs/reports/pr4a-*.md`、`p61-*.md`、`p62-*.md`、`final-attestation.json`、`host-smoke-rc2.md`、`p0-evidence-correction.md` 历史正文（除 §5.3 明确授权的一处）、`docs/reports/rev5-final-integration.md` 字节不变 |
| G8 | **pinned 字节不改** | `docs/adr/0007-…` = `47e67c7dab9ddacaf1d505a7fea6fe9312ee9b38d52ea1097444e37ab089b289`；`src/jitrl/jit-active-policy.ts` = `c94431235a0a90bc256bbfdac043a6c675a85fe566d2e4d91c1047fa13ff4266`（`tests/unit/jitrl/p6-pareto-budget.test.ts:865,867` 钉死）。需要指针时写新文件 |
| G9 | **公开选项面 26 键不变** | `plugin-options-shape.test.ts` 断言的 26 个 `OPTION_KEYS` 不增不减；新能力走 config 叶/`deps`/handle/status 增量字段 |
| G10 | **不伪造证明** | `final-attestation.json` 描述 `1b7920ee…`，**不覆盖 HEAD**；不为脏工作树生成/改写记录；不得声明「远程 CI 已绿」 |
| G11 | **字符编码** | 新文件必须 LF；`check:encoding` 只查 HEAD blob，提交前自行保证 |
| G12 | **不 commit / 不 push** | 除非用户显式授权；R0 只产出可执行提交计划与命令 |
| G13 | **host-smoke 报告不复用** | rc1（`p61-…`）与 rc2（`host-smoke-rc2.md`）字节不变；RC3 必须写新文件；覆盖 rc1/rc2 = 失败 |
| G14 | **`−0.250` 不可改** | 新实验必须新文件、新版本、新预注册；不得修改 `docs/reports/p6-fair-eval.md`、预注册 V2、pr4a fixture |

---

## 3. 受保护字节清单（改即失败；逐项给出当前实测哈希）

| 路径 | 当前 sha256 / 标识 | 钉住者 |
| --- | --- | --- |
| `docs/adr/0007-p6-pareto-budget-terminology-and-hooks.md` | `47e67c7dab9ddacaf1d505a7fea6fe9312ee9b38d52ea1097444e37ab089b289` | `p6-pareto-budget.test.ts:867`、`docs-correction-pointers.test.ts:30` |
| `src/jitrl/jit-active-policy.ts` | `c94431235a0a90bc256bbfdac043a6c675a85fe566d2e4d91c1047fa13ff4266` | `p6-pareto-budget.test.ts:865` |
| `docs/reports/p61-host-smoke-rc.md` | git blob `932f80dae2995786534288827becb8dc2bbe6c3a` | G13 / `report-path.mjs` |
| `docs/reports/host-smoke-rc2.md` | `d62bc9f5c9b0c8f68eca72bf72a5d7492ee11f8fe326bc1e7337813dcb3afa4c` | G13 |
| `docs/reports/final-attestation.json` | `ad0dfb3b7497ea00a2b56dbd4b037e87c5644341905c572028c3792d4a3db760` | G10 |
| `docs/NEGATIVE-CONTROL-RUNBOOK.md` | `85f12575d46434d056487dd428b004d54761fadd6af2f4108852e8fe8a58f23e` | G4 |
| `docs/reports/pr4a-five-arm-experiment-preregistration.md` | `3f2840ff7944630faf66f384e8af3f84fcbf4cc60ad78381a4885dc6e6ec8168` | G7/G14 |
| `tests/fixtures/pr4a/fixture-manifest.json` + 6 数据文件 | manifest `482630825665ede3830278085636d79b58d7d2b346da73c2da5f145b03295429`；6/6 哈希校验通过 | G5 |
| `docs/reports/rev5-final-integration.md` | `3c785ee7cf9591bc2f881ef5c3f63ddd3d536976a69c7bacb1b4c1f4b0124ff6` | 本契约 §1.2 |
| `src/jitrl/decision-kernel.ts` | `142cec1cc889964fc5905973a4be09dc1f4ea7d7763eec42ecf02e48d8ef1bc5` | ADR 0007 引用；R1 只读 |

**判据**：`git status --porcelain=v1 -uall -- <上述路径>` 为空，且 sha256 与上表一致。已实测当前全部匹配。

---

## 4. 写入归属矩阵（防重叠；冲突一律以本表为准）

### 4.1 rev6 计划路径 vs rev5 已交付字节（**唯一权威对照**）

`R5` = 该路径已存在于 rev5 交付清单（73/74）中，rev6 改动将改写**已审字节**；`HEAD` = 当前与 HEAD 逐字节相同（改动即新增差异）；`new` = 新建。

| 任务 | 路径 | 归属 | 现状 |
| --- | --- | --- | --- |
| **t8** | `docs/adr/0002-p62-release-contract-and-default-safe-shape.md` | t8（R0-3 整行替换） | 存在，HEAD 同字节 `95a7126b…` |
| **t8** | `src/runtime/execution-profile.ts` | t8（R0-3 整行替换，仅 `:121`） | 存在，HEAD 同字节 `69e8a441…` |
| **t8** | `docs/reports/p0-evidence-correction.md` | **t8（新增：§5.3 联动改单）** | **R5**（rev5 交付，15,272 B / `d84d4775…`） |
| **t8** | `tests/unit/p62/docs-correction-pointers.test.ts` | **t8（新增：§5.3 联动改单，仅:70 一处断言）** | **R5**（6,022 B / `1491d476…`） |
| **t8** | `docs/runbooks/rev6-release-attestation.md` | t8 | new |
| **t8** | `tests/unit/runtime/execution-profile.test.ts` | t8 | new |
| **t8** | `tests/unit/p62/rev6-release-contract.test.ts` | t8 | new |
| **t9** | `src/jitrl/index.ts` | **t9（唯一 R5 重叠点）** | **R5**，现 `M`，`778b251a…`/55,427 B |
| **t9** | `src/orchestrator.ts` | **t9（路径勘误，见 §4.2）** | 存在，HEAD 同字节 `b4f6fb1b…`/150,248 B |
| **t9** | `src/jitrl/writeback-gate.ts`、`tests/unit/jitrl/writeback-gate.test.ts`、`tests/unit/jitrl/writeback-intervention.test.ts`、`scripts/eval/rev6-jitrl-intervention.mjs`、两份 `rev6-jitrl-*` 报告 | t9 | new |
| **t9** | `src/jitrl/orchestrator.ts` | **不存在（勘误：删除该 inScope 项）** | — |
| **t10** | `src/dream-rsi/surrogate-scorer.ts` | t10 | 存在，HEAD 同字节 `b3bdb635…` |
| **t10** | `src/dream-rsi/surrogate-evidence-policy.ts`、其单测、`tests/unit/eval/rev6-ablation-design.test.ts`、`scripts/eval/rev6-ablation.mjs`、两份 `rev6-*` 报告 | t10 | new |
| **t11** | `scripts/host-smoke/run.mjs` | **t11（R5 重叠点 1）** | **R5**，现 `M`，`de90864d…`/22,221 B |
| **t11** | `scripts/host-smoke/in-host.mjs` | **t11（R5 重叠点 2）** | **R5**，现 `M`，`95836578…`/46,553 B |
| **t11** | `scripts/host-smoke/apply-context.mjs`、`tests/e2e/host-smoke/apply-context.test.ts`、`tests/e2e/host-smoke/branch-identity.test.ts`、`docs/reports/host-smoke-rc3.md` | t11 | new |
| **t12** | `src/dsh-bridge/cache-observation.ts`、`src/memory-bridge/recall-shadow-analysis.ts` + 两单测 + `scripts/eval/rev6-cache-observation.mjs` + 报告 | t12 | 全部 new（`cache-observation.ts` 不存在） |
| **t13** | `scripts/host-smoke/real-benefit.mjs`、`scripts/host-smoke/budget-binding.mjs`、`src/dsh-bridge/real-benefit-controller.ts`、其 e2e、两份 `rev6-real-benefit-*` 报告 | t13 | 全部 new |
| **t26** | `README.md` 计数行（4+1 行）、`docs/reports/rev6-final-integration.md` | t26 独占 | `README.md` 为 **R5**（`M`），只允许改计数/摘要行 |

### 4.2 t9 的精确归属（含路径勘误）

- **可写**：`src/jitrl/index.ts`（R5 重叠）、新建的 `src/jitrl/writeback-gate.ts` 与全部 t9 新文件、`src/orchestrator.ts`（见下）。
- **路径勘误 E-6**：t9 inScope 写的是 `src/jitrl/orchestrator.ts`，该文件**不存在**；真实文件是 `src/orchestrator.ts`（150,248 B，`b4f6fb1b…`）。若 t9 需要改 `recordOnlineExperience`（写回门控的唯一落点），**必须把 `src/orchestrator.ts` 显式登记为 t9 写入范围**。在队长确认前，t9 只读该文件；不得以「inScope 有 orchestrator」为由改 `src/jitrl/` 下不存在的路径。
- **硬约束**：`src/orchestrator.ts` 是 M3 变异锚点（`scripts/eval/mutation-gate.mjs`）所在文件。t9 若改动它，**不得移动/重写 M3 锚点文本块**；若必须改，先登记，由 t12 在依赖后修锚点（t9 不改 `scripts/eval/**`）。当前 `mutation-gate --validate` ok=true（4/4 锚点唯一解析）。
- **只读**：`src/jitrl/decision-kernel.ts`、`src/jitrl/jit-active-policy.ts`（pinned）、`docs/reports/p6-fair-eval.md`、`docs/reports/pr4a-*`、`tests/fixtures/pr4a/**`。

### 4.3 t11 的精确归属（R5 重叠点）

- **可写**：`scripts/host-smoke/run.mjs`、`scripts/host-smoke/in-host.mjs`（两者都是 rev5 已交付字节，rev6 继续由 t11 拥有）、新建 `apply-context.mjs`/两个 e2e/`host-smoke-rc3.md`。
- **写规则（防止覆盖已审证据）**：
  1. 只允许**增量**：新增 apply 上下文采集、branch 身份采集、RC3 报告路径支持；不得改变既有 rc1/rc2 的判定语义与五态计数口径。
  2. 若改 `in-host.mjs` 的 `9.4-2`/`9.4-3` 分支，**只能收紧**（缺账号/预算绑定仍必须 `not-run`/`failed` 并保留 `refusing to fabricate evidence` 语义），不得把 `not-run` 升级为 `passed`。
  3. **禁止**把默认报告目标改回 rc1；`report-path.mjs` 的冻结保护不得删除或放宽；RC3 走 `--out`。
  4. 改动后必须复跑 `tests/e2e/host-smoke`、`pnpm run test:e2e`、`pnpm run guarded-regression`，并在报告中给出 rc1/rc2 前后 `git hash-object` 一致证据。
- **只读**：`docs/reports/p61-host-smoke-rc.md`、`docs/reports/host-smoke-rc2.md`、`scripts/host-smoke/report-path.mjs`（不得删保护）、`src/cordis-seams/dsh-hook-host-adapter.ts`（t11 不拥有；它在 rev5 是 t10 交付，现 `M` `ec933936…`）。

### 4.4 无人拥有 / 保持字节不变的 rev5 文件

| 路径 | 规则 |
| --- | --- |
| `docs/REV5-IMPLEMENTATION-CONTRACT.md`（`6d3fa74a…`） | 只读历史需求锚点；rev6 写**新**文件（本文件） |
| `docs/reports/rev5-final-integration.md`（`3c785ee7…`） | 只读；不得改写其中数字 |
| `docs/reports/host-smoke-rc2.md`、`p7-p3-*`、`p0-evidence-correction.md`（除 §5.3 那一处） | 只读 |
| `tests/unit/config/readme-default-leaves.test.ts`、`tests/unit/p62/pr4a-artifact-verifier.test.ts` | 只读（rev5 已自包含） |
| `docs/NEGATIVE-CONTROL-RUNBOOK.md`、`docs/reports/final-attestation.json`、`docs/reports/pr4a-*`、`p61-*`、`p62-*` | 冻结（G4/G7/G10） |

---

## 5. 分阶段契约（R0–R4；每条验收都是可执行判据）

> 「验收」= 命令 + 退出码/可观察输出。判定 pass 必须附证据；任一条不满足即不得报 pass。**未执行项必须写 `not-run`/`blocked`/`unknown` + 原因**。

### 5.1 R0-1：提交已审核交付并验证远程 CI（**只准备，不执行**）

**Objective**：把 74 路径变成「提交后的可复核证据」，但 commit/push 需用户单独授权。

**In scope（准备物）**：提交计划（路径分组、提交消息草案、顺序）、提交前门禁清单、远程 CI 关注点清单。**不是**执行 commit。

**Do**：
1. 以附录 A + `work/t23/snapshot.csv` 核对 74 路径，排除 `work/`、临时副本、日志、本地工具产物。
2. 提交前重跑全量门禁；任何测试增删都从**同一次绿色 JSON** 重铸 README 计数。
3. `commit`/`push` **必须由用户显式授权**；不得用「本地全绿」替代远程结果。

**验收**：
- A-R0-1-1 提交路径集 == 74（`git status --porcelain=v1 -uall` 逐项归类，0 遗漏、0 多余）。
- A-R0-1-2 提交前的本地门禁记录完整（typecheck / vitest / docs / encoding / build-smoke / negative-result / guarded-regression / mutation / attest 校验），逐条 exit code。
- A-R0-1-3 明确写出「未 commit、未 push；远程 CI 未核实」。出现「远程 CI 绿」表述即失败。
- A-R0-1-4（**提交后**才可判）`node scripts/eval/check-clean-tree.mjs --json` = 0 且 `git status --porcelain` 为空；新提交的 `Typecheck and test` 与 `Node 24 compatibility` job 通过；远程测试数与提交前绿色 JSON 一致。

**Verify**：
```powershell
git status --porcelain=v1 -uall            # 期望提交前 74 行
node scripts/eval/check-clean-tree.mjs --json   # 提交前 exit 1（预期）；提交后 exit 0
pnpm run typecheck
pnpm exec vitest run --reporter=json --outputFile work/<task>/final-vitest.json
pnpm run check:docs
pnpm run check:encoding
pnpm run check:build-smoke
pnpm run check:negative-result
pnpm run guarded-regression
pnpm run check:mutation
pnpm run attest:verify
node scripts/eval/check-attestation-target.mjs --json
```

**陷阱**：`check:clean-tree` 不加入 `pnpm run verify`（否则未提交期本地验收恒红）；它只在 CI/显式命令中跑。

### 5.2 R0-2：目标 attestation 与 evidence 提交（**只准备**）

**Objective**：提交落定后，两阶段生成「绑定代码提交」的证明，且不产生自指误读。

**Do（授权后执行）**：
1. 设代码提交为 `C1`；在 `C1` 上 `pnpm run attest -- --expect-commit <C1>`，生成绑定 `C1` 的 canonical record。
2. 只提交证明记录形成 `C2`，提交消息末段 trailer **逐字符** `Attestation-Target: first-parent`（record-only，纯度为唯一改动 `docs/reports/final-attestation.json`）。
3. 在 `C2` 上验证 `record.commitId == C2^1`。

**验收**：
- A-R0-2-1 `node scripts/eval/final-attestation.mjs --verify docs/reports/final-attestation.json --expect-commit <C1-full-sha>` = 0。
- A-R0-2-2 `node scripts/eval/check-attestation-target.mjs --json` = 0，且输出 `mode=evidence`、`targetOk=true`；`record.commitId == git rev-parse C2^1`。
- A-R0-2-3 报告同时写明 `C1`、`C2` 与自指边界；**不得**出现「旧记录 verify 0 所以 HEAD 已证明」。
- A-R0-2-4 本 attempt 的**准备态**证据（已完成）：`--expect-commit 97e38db…` = exit 1 `attestation-target-mismatch`；`--strict` = exit 1 `attestation-head-mismatch`；`attest:verify` = exit 0 但两条 informational 明写「不覆盖检出修订」。

**陷阱**：不得为脏工作树生成记录；不得把记录与代码混在同一提交（T3 纯度规则会判 `attestation-evidence-impure`）；`--verify` 无目标 = 历史自洽，**不是**目标绑定。

### 5.3 R0-3：C-4 术语替换行（t8）

**Objective**：把 ADR 0002:51 与 `execution-profile.ts:121` 的「非劣 / non-inferiority」改为「严格超越 / strict improvement」，不改 pinned ADR、不改历史数字。

**In scope**：`docs/adr/0002-…`（仅第 51 行）、`src/runtime/execution-profile.ts`（仅 `:121` 的 reason 字面量），以及 §4.1 表中新增的两处**联动改单**。

**Do**：按 ADR 0007 §4.1/§4.2 给出的**整行**逐字符替换。ADR 0007 一个字节都不改。

**联动改单（关键，必须一次做齐，否则测试必红）**：

| # | 文件 | 允许改动 | 理由 |
| --- | --- | --- | --- |
| L-1 | `docs/reports/p0-evidence-correction.md` | 仅 §C-4 的「未应用」状态行 + §2 第 2 条 + §3「未执行/未授权」行改述为「已应用（rev6 R0-3，含命令/时刻）」；历史 C-1/C-2/C-3/C-5 与所有数字不动 | 否则登记文件对当前树撒谎 |
| L-2 | `tests/unit/p62/docs-correction-pointers.test.ts` | **仅** `:70` 的 `expect(correction).toContain('未应用')` 改为断言新的「已应用」标记；ADR 0007 pin 三元组（`47e67c7d…`、路径、`严格超越`）断言**逐字节不变** | 该断言原本防「谎称已修」；应用后必须防「谎称未修」 |

**验收**：
- A-R0-3-1 `Select-String` 在 ADR 0002:51 与 `execution-profile.ts:121` **0 命中** `非劣`/`non-inferiority`；两处均含「严格超越」/`STRICT-IMPROVEMENT`。
- A-R0-3-2 `pnpm exec vitest run tests/unit/p62/docs-correction-pointers.test.ts tests/unit/p62/release-contract.test.ts tests/unit/dream-rsi/pr4b-holdout.test.ts` 全绿。
- A-R0-3-3 `pnpm exec vitest run tests/unit/jitrl/p6-pareto-budget.test.ts -t "pinned sha256"` PASS；ADR 0007 sha256 仍 `47e67c7d…`。
- A-R0-3-4 `pnpm run guarded-regression` exit 0（`publish denied in every mode` 仍成立）。
- A-R0-3-5 `pnpm run check:docs` exit 0（不新增 option key，78/78 不变）。
- A-R0-3-6 历史负结果与冻结报告 `git status -- docs/reports/pr4a-* docs/reports/p61-* docs/reports/p62-* docs/reports/final-attestation.json` 为空。

**陷阱**：不得为「文案一致」改 `decision-kernel.ts` 的 `REPLAY_GATE_BOUNDARY`（`p6-pareto-budget.test.ts:309` 断言它**不含** `non-inferior`）；不得改 ADR 0007 加反向指针（G8）。

### 5.4 R1-1 / R1-2：预注册写回干预 + 证据写回门控（t9）

**Objective**：以预注册证据门控干预 JitRL 写回退化，判定是否达到容忍下界；不改历史负结果。

**In scope**：§4.1 的 t9 行。**Out of scope**：`−0.250`、`p6-fair-eval.md`、pr4a 预注册/fixture、`decision-kernel.ts`、`jit-active-policy.ts`。

**Do**：
1. **先**写 `docs/reports/rev6-jitrl-intervention-preregistration.md`（在任何新采样之前）：冻结假设、任务集、候选池 K、seed、样本量/功效、独立分析单元、主要终点、区间方法、α、多重校正、停止规则。预注册文件的 sha256 与时刻写入结果报告。
2. 主要终点沿用：`C3-online − C3-frozen` 的 **CI 下界 ≥ −0.05**。
3. 证据门：只有**可验证 Fail→Pass** 或预注册收敛条件成立时，经验才进入 L2 选择；否则只写审计，不参与排序。**无证据不得构造正奖励**（不得用 Composer 自评替代 verifier）。
4. 每次只改一个变量；记录 `gateFired`、拒绝原因、coverage、候选排序、verifiedRate。

**验收**：
- A-R1-1-1 预注册先于采样（文件 mtime/sha256 与首次采样时刻可证）。
- A-R1-1-2 `check:negative-result` exit 0（A1..A6），`−0.250`、`deviationStats{36,18,0}`、5 个最小反例不变。
- A-R1-1-3 「无证据写回进入 L2 的数量 = 0」有可执行断言（负控制：注入无证据写回 → 门禁红）。
- A-R1-1-4 结果报告给出：主终点差值、预注册区间、胜/平/负、配对样本数、`gateFired`、coverage、反例坐标（任务/run/round）。
- A-R1-1-5 达到 `CI 下界 ≥ −0.05` 才可称「未再出现超过容忍界的退化」；否则如实保留负结果/不可判别，**不自动等同正向收益**。

**Verify**：
```powershell
pnpm run typecheck
pnpm exec vitest run tests/unit/jitrl tests/unit/orchestrator
pnpm run check:negative-result
pnpm run check:mutation
node scripts/eval/rev6-jitrl-intervention.mjs --json
node scripts/eval/mutation-gate.mjs --validate --json   # 确认 M1-M4 锚点未被移动
```

**陷阱**：`recordOnlineExperience` 在 `src/orchestrator.ts`（§4.2 勘误）；改它会影响 M3 锚点，改前先 `--validate`，改后必须仍 ok=true。

### 5.5 R1-3 / R1-4：surrogate 去自指 shadow + 可判别 2×2(+1)（t10）

**Objective**：在 shadow 中验证 surrogate 去自指策略；重新设计可判别实验（不改冻结 V2）。

**In scope**：§4.1 的 t10 行。**Out of scope**：默认权重 `(0.4,0.3,0.2,0.1)`、clamp、`pr4a-*` 冻结产物、Arm-5。

**Do**：
1. surrogate：以 rev5 已交付的「Composer 判错、verifier 相反」反例为回归门；比较两种策略（可验证信号权重下限 / 仅在可验证时计 `I(H*)`），先 shadow，不改默认。
2. 新消融：**先**写预注册修订（`rev6-ablation-preregistration.md`），再采样；沿用 Arm-0…Arm-4 因子语义，**不新增 Arm-5**；增加**独立任务**（不得把 episodes/rounds 当独立样本）；设计上必须有机会达到族大小 4 的 `m_disc ≥ 8`；holdout 只用于最终评估（选择/调参/早停不得读取）。
3. 报告分别给 μ 区间与 π 区间、胜/平/负、多重校正；共线/不可识别项明确标 `undetermined`。

**验收**：
- A-R1-3-1 冲突夹具中策略**不再**把可验证失败排到可验证通过之前；证据相等负控制**不翻转**。
- A-R1-3-2 `DEFAULT_SURROGATE_WEIGHTS` 与 clamp 未变（有默认行为不变的对照测试）。
- A-R1-4-1 预注册先于采样；无 Arm-5；独立任务数与功效计算可复核，目标 `m_disc ≥ 8`。
- A-R1-4-2 holdout 防火墙双向：clean exit 0 / leak exit 1（本 attempt 已实测：`pr4a-firewall-clean` exit 0、`pr4a-firewall-leak` exit 1）。
- A-R1-4-3 `not-reject` 不写成等价；功效不足写成 `insufficient`；interaction 不可识别时标 `undetermined`。

**Verify**：
```powershell
pnpm run typecheck
pnpm exec vitest run tests/unit/dream-rsi tests/unit/eval
node scripts/eval/pr4a-stats.verify.mjs --firewall tests/fixtures/p2-l1/p2-v3-split-manifest.json --artifact tests/fixtures/p2-l1/p2-v3-selection-clean.json   # 0
node scripts/eval/pr4a-stats.verify.mjs --firewall tests/fixtures/p2-l1/p2-v3-split-manifest.json --artifact tests/fixtures/p2-l1/p2-v3-selection-holdout-leak.json   # 1
pnpm run check:negative-result
```

### 5.6 R2-1 / R2-2：真实 apply 上下文与 branch 身份（t11）

**Objective**：从宿主**真实 apply 上下文**采集八表面证据（RC3），并证明 branch-aware 身份/隔离链；无 branchId 则明确 blocked。

**In scope**：§4.1 的 t11 行（含两处 R5 重叠，按 §4.3 规则写）。

**Do**：
1. RC3 写 `docs/reports/host-smoke-rc3.md`（新文件）；rc1/rc2 字节不变。
2. 八表面逐项 `native`/`fallback`/`unavailable`/`not-run`，每项附实际服务/dispatch/mount 证据；`enabled` ≠ `mountable`；未观测不到 `native`。
3. branch 身份：在真实 hook dispatch 携带 `branchId` 或可证明映射下重跑 sibling / anonymous / self-claim / dispose / deny 优先级。

**验收**：
- A-R2-1-1 RC3 明确记录采集自真实 apply 上下文（含宿主版本/Electron/Node、commit、工作树状态、采集时刻、固定命令列）。
- A-R2-1-2 八表面分类逐项有证据字段；rc2 的 5 个 `not-run` 每项要么获得新证据、要么写明具体缺失条件（禁止无证据升级）。
- A-R2-1-3 `git hash-object docs/reports/p61-host-smoke-rc.md` 与 `host-smoke-rc2.md` 前后一致（rc1 = `932f80da…`，rc2 = `d62bc9f5…`）。
- A-R2-2-1 同 session 兄弟 branch 不共享建议/学习记录；anonymous 与 self-claim 仍 fail-closed。
- A-R2-2-2 若宿主仍无 `branchId`（当前实测 `branch=0`），**Gate 4 保持 blocked** 并写明外部条件；不得用 contract-shaped 场景替代。

**Verify**：
```powershell
pnpm run typecheck
pnpm exec vitest run tests/e2e/host-smoke
pnpm run test:e2e
pnpm run guarded-regression
node scripts/host-smoke/run.mjs --check
# 就绪后：node scripts/host-smoke/run.mjs --out docs/reports/host-smoke-rc3.md
```

### 5.7 R2-3：measured cacheRead 样本（t12）

**Objective**：建立可复核的 measured cacheRead 证据；无实测则保持 `gated/not-applicable`。

**Do**：记录 `ctx.llm.stream` 的 usage 原始字段、precision、任务/seed/模型与预算；缺字段即 `unknown`；`estimated` 不得改标 `measured`；paired 样本才可评估。

**验收**：
- A-R2-3-1 三态（measured/estimated/unknown）分离，原始字段与 paired 样本可复核；`cacheReadUnknownCalls` 与 `dimensionProvenance.cacheRead='unknown'` 语义不被改写。
- A-R2-3-2 只有 measured 显著下降才建议 Tail Injection；否则 `gated/not-applicable`，**不实施优化、不伪造 A/B**。
- A-R2-3-3 `src/ledger/usage-report.ts` 语义未变（`tests/unit/ledger` 相关套件绿）。

**Verify**：
```powershell
pnpm run typecheck
pnpm exec vitest run tests/unit/dsh-bridge tests/unit/memory-bridge tests/unit/ledger
pnpm run check:build-smoke
```

### 5.8 R3：真实收益评测（t13）——**已授权，但受账号 + 硬预算绑定前置条件约束**

**Objective**：在账号与**可强制执行的硬预算**可绑定时，测量真实任务收益；不能绑定则 `not-run`/`blocked`。

**授权状态（重要）**：真实收益评测属于用户已授权范围；**但**「已授权」不等于「可实跑」。实跑必须同时满足 §7 的四项绑定条件。**缺任一项即 `not-run`/`blocked`，不得用 mock/estimated 冒充，不得把工程绿写成任务收益。**

**In scope**：§4.1 的 t13 行（全部新建）。**Out of scope**：真实记忆写入、`guarded-active`、publish、真实外部工具（除只读白名单）。

**Do（机制先行）**：
1. `scripts/host-smoke/budget-binding.mjs`：把（a）账号标识、（b）硬预算上限 micros、（c）只读工具白名单、（d）中止开关，组装成 `LedgerBudgetConfig` + `AdmissionPolicy{mode:'hard'}` + `RouteCostBound`/`ModelRateCard` + `createProbeAuthorizationLedger()`，并输出可机读绑定凭据（含 rateCard digest）。
2. `src/dsh-bridge/real-benefit-controller.ts`：单任务最小 canary 控制流；记录模型/宿主/usage/cost/cacheRead/工具计数；`noPolicy`、身份不明、越权工具**任一即中止**。
3. `docs/reports/rev6-real-benefit-preregistration.md`：baseline + recorded advice 的任务、指标、预算、统计口径（**先于采样**）。
4. 结果写 `docs/reports/rev6-real-benefit-result.md`，分层：`passed` / `failed` / `insufficient` / `not-run`。

**验收**：
- A-R3-1 绑定机制可执行：缺账号 → 控制器返回 `blocked(account-unbound)`；缺硬上限 → `blocked(budget-unbound)`；`AdmissionPolicy.mode='hard'` 且 stop-loss 正数；预算耗尽即拒绝下一调用（有断言）。
- A-R3-2 canary 记录字段完整（模型/宿主/usage/cost/cacheRead/工具计数/denied/allowlisted），并保留原始 usage。
- A-R3-3 中止路径有负控制：`noPolicy=1` / 身份缺失 / 越权工具 → 立即中止且不重试放大。
- A-R3-4 收益结论只写 `passed`/`failed`/`insufficient`/`not-run`；功效不足不得写「有收益」；工程可运行/安全契约/学习语义/真实兼容/任务收益**分层报告**。
- A-R3-5 **不可绑定时的合法终态**：`not-run`/`blocked` + 明确缺失项（账号、硬预算、白名单、中止开关中的哪几项），**且**已交付可复跑的绑定机制与预注册。
- A-R3-6 无真实记忆写入、无 `guarded-active`、无 publish（`git grep` 级证明 + 默认值未变）。

**Verify**：
```powershell
pnpm run typecheck
pnpm exec vitest run tests/e2e/host-smoke/real-benefit-controller.test.ts
pnpm run guarded-regression
node scripts/host-smoke/budget-binding.mjs --json      # 期望 not-run/blocked + 缺失项，除非绑定齐备
```

**陷阱**：`src/**` 目前**没有** accountId/tenantId/billing 原语（已实测 grep 0 命中）；不得「造一个假账号字段」充当绑定，应把它作为 R3 的外部输入（env/凭据文件），并在控制器里 fail-closed。`HOSTSMOKE_AUTHORIZED=1` 单独**不构成**绑定（`in-host.mjs` 已如此判定）。

### 5.9 R4：进入 active 的前置条件（t26 判定，不预设开启）

| 项 | 开启前提 | 退出条件 |
| --- | --- | --- |
| 正向 `whenToApply` 过滤 | shadow 命中率与误过滤分析完成 | 误伤超预注册阈值 → 退回只记录 |
| 真实 Read-Write 状态 | §5.8 通过且后端稳定报告能力 | 任一证据缺失 → `unknown`/Recall-Only |
| Tail Injection | measured cacheRead 显著下降 | 同任务/预算/seed A/B 证明收益，否则不合并 |
| `guarded-active` | R0 证据闭环 + R1 写回退化受控 + R2 身份链闭合 + R3 安全与收益口径明确 | 小范围灰度；默认 shadow、publish denied 不变 |

**验收**：A-R4-1 上述四项逐条给出「满足/不满足 + 证据指针」；A-R4-2 任一项不满足时**不得**进入 active，且默认安全值未变。

---

## 6. 授权边界（本轮**已授权 / 未授权**清单）

### 6.1 已授权

| # | 项 | 边界 |
| --- | --- | --- |
| Z-1 | 代码/测试/文档的**本地**实现与验证 | 不 commit/push |
| Z-2 | 聚合层：typecheck、vitest、docs、encoding、build-smoke、negative-result、guarded-regression、mutation、attest 校验 | 只读 + 重建 gitignore 的 `/lib/` |
| Z-3 | 真实宿主 smoke 的**只读/非付费**采集（`--check`、apply 上下文、branch 身份） | 不得触发真实模型调用/真实记忆写入 |
| Z-4 | **真实收益评测**（R3） | **仅当** §7 四项绑定条件全部满足；否则 `not-run`/`blocked` |
| Z-5 | 新建 rev6 文档/预注册/报告 | 新文件；不改冻结历史 |

### 6.2 明确未授权（做即失败）

| # | 项 | 依据 |
| --- | --- | --- |
| N-1 | `git commit` / `git push` / 打 tag / 改远端 | G12；需用户单独明确授权 |
| N-2 | 真实记忆写入（任何后端、任何命名空间） | G2；`memoryRealWrites:true` 仅测试装配 |
| N-3 | `execution.mode='guarded-active'` / `applyWinningPatch=true` | G1/G2 |
| N-4 | publish / 发布热更新 | `publish.allowed` 恒假 |
| N-5 | 声明远程 CI 绿、声明 HEAD 已被证明 | G10（已实测两条 exit 1 证明） |
| N-6 | 改写 `−0.250`、`deviationStats`、A1–A6、pr4a 预注册/fixture、冻结报告 | G7/G14 |
| N-7 | 新增 Arm-5、把 episodes/rounds 当独立样本、把 `not-reject` 当等价 | rev6 §7 |
| N-8 | 没有 measured cacheRead 就实施/宣称 Tail Injection 收益 | rev6 §7 |
| N-9 | 在 `src/**` 引入 `memoryRealWrites: true` 或默认放开工具面/真实工具 | G2 |
| N-10 | 以 mock / estimated / synthetic 结果冒充真实收益或真实宿主证据 | rev6 §7 |

---

## 7. R3 的账号 + 硬预算绑定要求（可执行判据）

真实调用前**必须**同时具备以下四项，并写入机读绑定凭据（`budget-binding.mjs --json` 输出，含 `rateCardDigest`）：

| # | 条件 | 可核查形式 |
| --- | --- | --- |
| B-1 | **账号** | 至少一个真实账号标识（provider + model + 账号/组织/计费标识）；来自 env/凭据文件，**不得**伪造字段。缺失 → `blocked(account-unbound)` |
| B-2 | **硬预算** | `LedgerBudgetConfig.generalBudgetMicros > 0`（与 `verificationReserveMicros` 分离）+ `AdmissionPolicy{mode:'hard', allowUnboundedRiskOverride:false}`；每次调用前 `decideAdmission` 必须给 `admitted:true, basis:'provable-hard-bound'`（不可证明上界则拒绝）。若必须用风险覆盖，则 `unboundedRiskStopLossMicros` 必须为正整数。缺失 → `blocked(budget-unbound)` |
| B-3 | **只读工具白名单** | `createToolFaceRegistry({allowTools:[...]})`（拒绝 `"*"`）+ `createProbeAuthorizationLedger()` 的 grant/deny 计数；分支内探针 `branchNoPolicy === 0` |
| B-4 | **中止开关** | 控制器级中止：预算耗尽 / `noPolicy` / 身份缺失 / 越权工具 → 立即停止；不自动扩大预算或任务集 |

**判据**：四项齐备 → 允许单任务最小 canary（仍不得写入真实记忆）；任一项缺失 → 结果必须是 `not-run`/`blocked` + 缺失项清单，**这是合法终态**，不是失败。

---

## 8. 证据格式与提交流程（所有任务统一）

**证据表**（放任务 output 或 `docs/reports/rev6-*.md`）：

```text
| # | 命令（逐字） | 退出码 | 关键输出（逐字，≤3 行） | 取样时刻(+08:00) |
```

**负控制另起一表**：

```text
| NC | 目标文件 | 变异（snippet 哈希） | 先证变异生效 | 红证据（red.log 路径/首行身份键） | 还原后哈希 == 原哈希 | 身份键完整 |
```

硬性要求：
1. 退出码必须来自实际执行；不得写「应当为 0」。
2. 引用历史数字必须带时间语境，不得当当前证据。
3. 未执行/未授权/无法判定必须显式 `not-run`/`blocked`/`unknown` + 原因。
4. `acceptanceResults` 逐条对应本文件的 A-x；`commandsRun` 逐条对应 Verify；不得只写「全部通过」。
5. 验证任务（t14–t19）只能基于被审任务**提交时**的证据与当前树复跑，不得替被审方补跑后宣称通过。
6. 审核任务（t20–t25）必须给 `findings + requiredFix`；只有全满足才 `pass`；不得把「验证通过」当「审核通过」。

---

## 9. 本契约的失效条件（出现任一，需队长重新冻结并广播）

1. rev6 原文（`dsh-plugin-evo-harness-交叉审核与下一步计划-rev6.md`，`4c4ded2e…`）与本文在条目范围/编号上有实质差异；
2. 队长批准新增插件 option key（G9 变化）、修改 pinned 文件（G8 变化）或修改冻结家族（G7 变化）；
3. 队长批准 commit/push（G12 变化），从而使证明目标口径改变；
4. 用户提供账号 + 硬预算（R3 从 `not-run` 转为可执行，§7 生效）；
5. 任何任务发现 §1 的基线数字在**未改动的树**上不能复现（说明环境已变）。

---

## 10. 证据索引（本 attempt 实际产物，全部在 gitignore 的 `work/t7/`）

| 产物 | 路径 | 说明 |
| --- | --- | --- |
| 契约证据指纹 | 见附录 C | 生成时刻计算，含大小与 sha256 |
| 门禁扫描（23 条） | `work/t7/rev6-gate-log.json` + `work/t7/logs/*.log` | 命令/退出码/起止时刻/关键输出 |
| 权威 Vitest JSON | `work/t7/rev6-vitest-final.json` | 150 files / 2,727 tests / success=true；sha256 `5e69c40f81d79f859e68cde5a312e636207a03d3d4dbdf52c9eeece171908953` |
| rev5 三源核对 | `work/t7/rev5-baseline-verification.json`（脚本 `verify-baseline.cjs`） | 附录 A ↔ CSV ↔ 实际字节，0 不一致/0 漂移 |
| 73 路径漂移 | `work/t7/drift-report.json`（脚本 `drift-check.cjs`） | 73 记录路径，0 漂移 |
| 74 路径状态 | `work/t7/rev6-status.txt`、`work/t7/rev6-snapshot.json` | `git status --porcelain=v1 -uall` |
| clean-tree | `work/t7/clean-tree.json` | 预期红：28 + 46 |
| 负结果 | `work/t7/neg-result.json` | `−0.250`、36/18/0、5 反例 |
| 归属重叠分析 | `work/t7/overlap.cjs` 输出（见 §4.1） | 3 处 R5 重叠 + 1 处路径勘误 |

---

## 11. 需队长确认的登记项（默认口径已生效，可否决）

| # | 事项 | 本契约默认口径 |
| --- | --- | --- |
| D-1 | C-4 应用后的联动改单（§5.3 L-1/L-2） | **授权 t8** 改 `p0-evidence-correction.md` §C-4 状态行与 `docs-correction-pointers.test.ts:70` 单条断言；ADR 0007 pin 断言不动。若否决，则 C-4 保持「未应用」，R0-3 记 `not-run` |
| D-2 | t9 inScope 的 `src/jitrl/orchestrator.ts` 不存在 | 勘误为 `src/orchestrator.ts` 并**登记为 t9 写入范围**（否则 R1-2 无落点）；M3 锚点不得移动 |
| D-3 | t11 拥有两处 R5 文件 | 按 §4.3 增量规则写；rc1/rc2 字节不变 |
| D-4 | R3 的账号/硬预算 | `src/**` 无账号原语 ⇒ 作为**外部输入**；未提供则 `not-run`/`blocked` 为合法终态 |

### 11.1 裁定记录（2026-10-31T01:38，队长广播：D-1..D-4 **全部按默认批准**）

> 本节为**追加**记录，不改写 §11 上表的「待确认」表述；冲突时**以本节为准**。t8–t26 一律按本节执行。

| # | 裁定 | 生效口径 |
| --- | --- | --- |
| D-1 | **批准** | t8 在 C-4 应用中**同步**改 `docs/reports/p0-evidence-correction.md` §C-4 状态（L-1）与 `tests/unit/p62/docs-correction-pointers.test.ts:70` 单条断言（L-2）；ADR 0007 pin 断言（`:95-113` 的 `47e67c7d…`、路径、`严格超越`、`P-6`/`不可表示的边`/`ADR 0007 一个字节`）**逐字节不动**。⇒ R0-3 不得再记 `not-run` |
| D-2 | **批准** | t9 使用真实 `src/orchestrator.ts`（150,248 B，`b4f6fb1b…`）作为 `recordOnlineExperience` 的写回落点；inScope 中不存在的 `src/jitrl/orchestrator.ts` 作废。M3 变异锚点不得移动：改前/改后都必须 `node scripts/eval/mutation-gate.mjs --validate --json` = `ok:true` |
| D-3 | **批准** | t11 增量修改 `scripts/host-smoke/run.mjs`（DR-4）与 `in-host.mjs`（DR-5），按 §4.3 四条写规则；**rc1（`932f80da…`）与 rc2（`d62bc9f5…`）字节必须不变** |
| D-4 | **批准** | R3 的账号 + 硬预算作为外部输入；**未齐备则 `not-run`/`blocked` 为合法终态**，不得用 mock/estimated 冒充（§7 B-1..B-4 生效） |

**裁定对下游判据的三点直接影响（务必按此判定，避免误报 finding）**：

1. **漂移预算生效**：§1.2.1 的 DR-1..DR-6 是**授权漂移集**。t14–t19/t20–t25/t26 判「rev5 字节是否被越权改写」时，判据是「漂移集 ⊆ DR 集」，**不是**「73 条全不变」。把 DR-1..DR-5 报成越权 finding = 误报。
2. **§3 受保护清单不因 D-1 而放宽**：`docs/adr/0007-…`、`src/jitrl/jit-active-policy.ts`、rc1/rc2、`final-attestation.json`、`NEGATIVE-CONTROL-RUNBOOK.md`、pr4a 预注册与夹具、`rev5-final-integration.md` 仍然逐字节冻结。D-1 只放开了 DR-1/DR-2 两个**非 pin** 文件。
3. **C-4 的可判别性要求**：t8 应用后，`docs-correction-pointers.test.ts` 必须**同时**证明两件事——(a) 登记文件已标记「已应用」；(b) ADR 0007 仍是原 pin 且其 §4 仍含替换行指针。只改 (a) 而弱化 (b) 视为削弱证据，t14 应判 `needs_revision`。t7 已实测：当前 `:70` 是 `expect(correction).toContain('未应用')`，`:95-113` 是 pin 三元组断言，两者互不耦合。

**t7 在本裁定上未做的事**：未执行 C-4 的任何替换（那是 t8 的 R0-3）；未改动 `p0-evidence-correction.md` 或 `docs-correction-pointers.test.ts` 一个字节（二者当前仍为 `d84d4775…` / `1491d476…`，与附录 A #06/#70 一致）。本文件只登记口径。

---

## 附录 B：门禁扫描表（23 条，2026-10-31T01:22–01:28，逐条实测）

> 生成自 `work/t7/rev6-gate-log.json`；`asExpected` 列表示实测退出码是否等于判据期望。两处「预期红」（`clean-tree`、`attest-*`）与一处「预期橙」（`pr4a-firewall-leak`）是判据的一部分。

采集窗口：2026-10-31T01:28:23.873+08:00；HEAD = `97e38db37305b24f695a5f989428b3611f84987c`；工作树状态行 before=74 after=74；**mismatches = 0 / 23**。

| 门 | 命令（逐字） | 退出码 | 期望 | 一致 | 耗时 | 起始时刻 | 日志 |
| --- | --- | --: | --: | :--: | --: | --- | --- |
| install-frozen-offline | `pnpm install --frozen-lockfile --offline` | 0 | 0 | ok | 0.8s | 2026-10-31T01:22:58.623+08:00 | `work/t7/logs/install-frozen-offline.log` |
| typecheck | `pnpm run typecheck` | 0 | 0 | ok | 10.1s | 2026-10-31T01:22:59.502+08:00 | `work/t7/logs/typecheck.log` |
| vitest-full-json | `pnpm exec vitest run --reporter=json --outputFile work/t7/rev6-vitest-final.json` | 0 | 0 | ok | 71.7s | 2026-10-31T01:23:09.573+08:00 | `work/t7/logs/vitest-full-json.log` |
| check-docs | `pnpm run check:docs` | 0 | 0 | ok | 72.7s | 2026-10-31T01:24:21.257+08:00 | `work/t7/logs/check-docs.log` |
| check-encoding | `pnpm run check:encoding` | 0 | 0 | ok | 2.7s | 2026-10-31T01:25:33.929+08:00 | `work/t7/logs/check-encoding.log` |
| check-build-smoke | `pnpm run check:build-smoke` | 0 | 0 | ok | 3.2s | 2026-10-31T01:25:36.600+08:00 | `work/t7/logs/check-build-smoke.log` |
| check-negative-result | `pnpm run check:negative-result` | 0 | 0 | ok | 2.3s | 2026-10-31T01:25:39.810+08:00 | `work/t7/logs/check-negative-result.log` |
| guarded-regression | `pnpm run guarded-regression` | 0 | 0 | ok | 2.1s | 2026-10-31T01:25:42.072+08:00 | `work/t7/logs/guarded-regression.log` |
| check-mutation | `pnpm run check:mutation` | 0 | 0 | ok | 24s | 2026-10-31T01:25:44.147+08:00 | `work/t7/logs/check-mutation.log` |
| attest-verify | `pnpm run attest:verify` | 0 | 0 | ok | 3s | 2026-10-31T01:26:08.192+08:00 | `work/t7/logs/attest-verify.log` |
| attestation-target | `node scripts/eval/check-attestation-target.mjs --json` | 0 | 0 | ok | 1.8s | 2026-10-31T01:26:11.196+08:00 | `work/t7/logs/attestation-target.log` |
| attest-expect-head | `node scripts/eval/final-attestation.mjs --verify docs/reports/final-attestation.json --expect-commit 97e38db37305b24f695a5f989428b3611f84987c` | 1 | 1（判据） | ok | 1.3s | 2026-10-31T01:26:12.971+08:00 | `work/t7/logs/attest-expect-head.log` |
| attest-strict | `node scripts/eval/final-attestation.mjs --verify docs/reports/final-attestation.json --strict` | 1 | 1（判据） | ok | 1.3s | 2026-10-31T01:26:14.261+08:00 | `work/t7/logs/attest-strict.log` |
| attest-node-test | `node --test scripts/eval/final-attestation.node-test.mjs` | 0 | 0 | ok | 104.1s | 2026-10-31T01:26:15.541+08:00 | `work/t7/logs/attest-node-test.log` |
| readme-report | `node scripts/verify-readme-counts.mjs --report work/t7/rev6-vitest-final.json` | 0 | 0 | ok | 0.3s | 2026-10-31T01:27:59.618+08:00 | `work/t7/logs/readme-report.log` |
| clean-tree | `node scripts/eval/check-clean-tree.mjs --json` | 1 | 1（判据） | ok | 0.3s | 2026-10-31T01:27:59.949+08:00 | `work/t7/logs/clean-tree.log` |
| eval-jitrl-json | `node scripts/eval-jitrl.mjs --json` | 0 | 0 | ok | 4.6s | 2026-10-31T01:28:00.242+08:00 | `work/t7/logs/eval-jitrl-json.log` |
| negative-result-diag-json | `node scripts/eval/negative-result-diag.mjs --json` | 0 | 0 | ok | 0.6s | 2026-10-31T01:28:04.966+08:00 | `work/t7/logs/negative-result-diag-json.log` |
| mutation-validate | `node scripts/eval/mutation-gate.mjs --validate --json` | 0 | 0 | ok | 0.2s | 2026-10-31T01:28:05.530+08:00 | `work/t7/logs/mutation-validate.log` |
| pr4a-firewall-clean | `node scripts/eval/pr4a-stats.verify.mjs --firewall tests/fixtures/p2-l1/p2-v3-split-manifest.json --artifact tests/fixtures/p2-l1/p2-v3-selection-clean.json` | 0 | 0 | ok | 0.2s | 2026-10-31T01:28:05.711+08:00 | `work/t7/logs/pr4a-firewall-clean.log` |
| pr4a-firewall-leak | `node scripts/eval/pr4a-stats.verify.mjs --firewall tests/fixtures/p2-l1/p2-v3-split-manifest.json --artifact tests/fixtures/p2-l1/p2-v3-selection-holdout-leak.json` | 1 | 1（判据） | ok | 0.2s | 2026-10-31T01:28:05.935+08:00 | `work/t7/logs/pr4a-firewall-leak.log` |
| vitest-j1-negative-controls | `pnpm exec vitest run tests/unit/p62/docs-gate-j1.test.ts tests/unit/p62/clean-tree-gate.test.ts` | 0 | 0 | ok | 12.9s | 2026-10-31T01:28:06.165+08:00 | `work/t7/logs/vitest-j1-negative-controls.log` |
| vitest-pinned | `pnpm exec vitest run tests/unit/jitrl/p6-pareto-budget.test.ts -t "pinned sha256"` | 0 | 0 | ok | 4.7s | 2026-10-31T01:28:19.070+08:00 | `work/t7/logs/vitest-pinned.log` |

> 说明：`check:clean-tree` 与 `attest-expect-head`/`attest-strict` 的期望值为 1（预期红，见 §1.3）；`pr4a-firewall-leak` 的期望值为 1（holdout 防火墙的判别力）。其余期望 0。

## 附录 C：证据文件指纹（生成本文件时计算）

| 产物 | 字节 | sha256 |
| --- | --: | --- |
| docs/reports/REV6-IMPLEMENTATION-CONTRACT.md（本文件自身的指纹不在此表，见任务 evidence_note） | — | — |
| `work/t7/rev6-gate-log.json` | 14,794 | `a59d433251a235dee85168011d11ed55b0b79aeec6ca8d8bc63c84d743049cdc` |
| `work/t7/rev6-vitest-final.json` | 975,793 | `5e69c40f81d79f859e68cde5a312e636207a03d3d4dbdf52c9eeece171908953` |
| `work/t7/rev5-baseline-verification.json` | 506 | `647753e0fc809daa775c9c8ac3cf51dd130acc965a784298d384c70cf6fef014` |
| `work/t7/drift-report.json` | 18,742 | `c08e3be684d4559250861ec47dd0261c6fc44f26b93f15698d63cb3b2c980782` |
| `work/t7/rev6-status.txt` | 3,113 | `32e578ea350497b3c3114a086bc004add62d25d83cf79eb53b31a8e0692e8ec2` |
| `work/t7/rev6-snapshot.json` | 15,980 | `1537285f0943ae7bbd40a673e21f5695948f4c542e71b0a19f08a3a7e3cba4e4` |
| `work/t7/clean-tree.json` | 23,422 | `327395c48634254f358ed2d9a23fe49ded936d58b7c34f8610d57efad1646700` |
| `work/t7/neg-result.json` | 29,965 | `093f85317ba1bc29f100987ae94d4e44a2636368f5fbaf372600bd22982e0536` |
| `work/t23/snapshot.csv` | 10,081 | `28f65f6ea85a7dee4cdc35d48388725cf92ae3d0543770f6f3e792b5882c6493` |
| `work/t23/final-vitest.json` | 975,801 | `773fcf431fd33139157457db4e59a5eff58afbdeded8e92daa33024eead00e60` |
| `work/t23/report-identity.txt` | 277 | `30cd34ac126181ff14c0c646812dfa993fcdf0f505c305e69258b89474d5e7aa` |

## 附录 A：rev5 交付 73 路径字节快照（受测集；行序与 rev5 报告附录 A 一致）

> 生成自 `work/t23/snapshot.csv`（与 rev5 报告附录 A 同序、同字节、同前 8 位 sha256）；本表给出完整 64 位哈希。状态列：`M` = 已跟踪文件修改，`??` = 新增未跟踪。第 74 路径 `docs/reports/rev5-final-integration.md`（`3c785ee7…`，22,598 B）是纯文档，单列于 §1.2。**§1.2.1 的漂移预算以本表行号为引用坐标。**

| # | 状态 | 路径 | 字节 | 行 | sha256 |
| --: | --- | --- | --: | --: | --- |
| 01 | M | `.github/workflows/ci.yml` | 26,432 | 544 | `a6abe4bbb36ab4a0c1dc7ba23b35d616a77618ff4fbade8123eb73432a10e82a` |
| 02 | M | `README.md` | 40,538 | 581 | `fc8987c0ee8b5181f0b90855144dea11c7707be601e41dad1acaeb26521f3241` |
| 03 | M | `docs/adr/0005-p1-evidence-and-atomic-config-contract.md` | 65,322 | 580 | `6176f4cc62d550cb619014ff98d3c6128eab08c848e6a68c64d5dd0e5b0cab19` |
| 04 | ?? | `docs/REV5-IMPLEMENTATION-CONTRACT.md` | 58,098 | 553 | `6d3fa74ac330b359f145b05dc644fc436b03e8792e028af8aa0eb743c7347958` |
| 05 | ?? | `docs/reports/host-smoke-rc2.md` | 22,907 | 223 | `d62bc9f5c9b0c8f68eca72bf72a5d7492ee11f8fe326bc1e7337813dcb3afa4c` |
| 06 | ?? | `docs/reports/p0-evidence-correction.md` | 15,272 | 117 | `d84d4775692fbe0cacf1d23886454148f1466b8a650bf550132103104474283c` |
| 07 | ?? | `docs/reports/p7-p3-evaluation-recheck.md` | 14,587 | 186 | `ee6dcc2ff70d124672ef2e76ec5ab8d8425166c705dc42f61d255ce65b3799af` |
| 08 | ?? | `docs/reports/p7-p3-structural-debt-closeout.md` | 7,769 | 89 | `7bc3773b014cc08c357b933f7bc114c603d00ca116817482ad1e0d18ff24d049` |
| 09 | ?? | `docs/runbooks/build-freshness-and-clean-tree.md` | 10,589 | 166 | `b826c9bfce0d987d739cd44195357c84eea8d519a39ae14c49cf9b7725d3dd45` |
| 10 | M | `package.json` | 2,276 | 65 | `44db70bd7064d42ce35c64c6d3cf01de87d17ed6b3c9828a4d675ae917ad1941` |
| 11 | ?? | `scripts/build-manifest.d.mts` | 2,061 | 90 | `69061628bb40daeee879dc0ee26d9a2a6d327c6f6187ccd689c101dec5f809b7` |
| 12 | ?? | `scripts/build-manifest.mjs` | 18,713 | 497 | `41090aea5144f29feb4bf006b41aae34b771bb1f1a96315df6d4c98dc019f191` |
| 13 | ?? | `scripts/build.mjs` | 2,696 | 61 | `7f2d7d1419b28d92f57ca61a4a367e2ab2fca5b3ced86c7e99c500106b279413` |
| 14 | ?? | `scripts/eval/check-clean-tree.d.mts` | 988 | 35 | `5cd802bda6cc10e25350547d6c607656fb63e776faec61b9705b30c0ec70471d` |
| 15 | ?? | `scripts/eval/check-clean-tree.mjs` | 16,280 | 430 | `3db3e0d777480e234d7650faad87e3be1755aa350d7ebb33d2b2db97b6d1e35e` |
| 16 | M | `scripts/eval/smoke-build.d.mts` | 776 | 26 | `f534af98b5815f74be3bc7cf34271d1ea206d0f7feb32c2c9c3837a6e8f4504d` |
| 17 | M | `scripts/eval/smoke-build.mjs` | 11,359 | 256 | `121efb8b5f2ddbddbb9a3b54ab98e78ffce0d5adb739fd8382a498cc6b5f0e1a` |
| 18 | M | `scripts/host-smoke/in-host.mjs` | 46,553 | 977 | `95836578834aae6d602f5e6c79e69edec35d7ded64036b90382a8335a1f925a6` |
| 19 | ?? | `scripts/host-smoke/report-path.mjs` | 5,881 | 151 | `fe292962ac2f2aa8080e67abc22779819adbeb308ed984ba9e47d6fa49c28001` |
| 20 | M | `scripts/host-smoke/run.mjs` | 22,221 | 552 | `de90864d9ad9cdfb8639b56279c2158d62e15eed8a93e4a139df5851b9ddc780` |
| 21 | M | `scripts/verify-readme-counts.mjs` | 32,800 | 753 | `55c37c2c203624f138b7f4bc00d6b144e77371e4dd00b12d4102dd2749b99313` |
| 22 | M | `src/cordis-seams/dsh-hook-host-adapter.ts` | 84,601 | 2054 | `ec93393644ee4ec2c0197f3489d60b1fdcc0de951fc7bc7db42dd2a1c7c623eb` |
| 23 | M | `src/dsh-bridge/agent-loop-executor.ts` | 59,967 | 1439 | `b9e5629677bbfcd94a1710ef35fadf9f4df21bd0d53e21bb45a923b418788770` |
| 24 | M | `src/dsh-bridge/index.ts` | 15,437 | 388 | `3b75c68afc9528a8587ee51095a1ea6d5b15e3ae1e9924197899edf2b5b5648c` |
| 25 | M | `src/dsh-bridge/metered-model-adapter.ts` | 26,000 | 678 | `99b4f4c3ba11558df3b31f47c2856a52fc74e18bab7c076a97c48fee519af554` |
| 26 | M | `src/dsh-bridge/model-config.ts` | 12,021 | 291 | `95fa97bf35b660f238e8ffd42e62b27c4fc5d813d712b773bada3879bb4d1f15` |
| 27 | ?? | `src/dsh-bridge/probe-safety.ts` | 11,980 | 291 | `5defc7e866204c2248deb0f90e11cf1d7f651a669e27319595babac7135a5d97` |
| 28 | M | `src/index.ts` | 147,958 | 3640 | `f8014de932a9d94b02fbffbf47b2742436a589eee13f9caa18f302a4df0e2863` |
| 29 | M | `src/jitrl/index.ts` | 55,427 | 1380 | `778b251aa41a693226a35aba738899896b9f2d9de3c22df9ee69f4d326ee8d26` |
| 30 | ?? | `src/jitrl/text-probe-evaluation.ts` | 5,538 | 128 | `ee287c0aa44dc62d7405fa6666cc12547fc0c5ab7e1840657851593c2201d2f0` |
| 31 | M | `src/ledger/assembly.ts` | 17,620 | 406 | `71df4ded8bd212a5d105688733b3499d371095c52d648a58f301bd1a9088ef4d` |
| 32 | M | `src/ledger/two-phase.ts` | 35,629 | 883 | `5445a51ae5b3ef3d2b192e531ad76d494d22aa2df9969787c5659b493bcab128` |
| 33 | M | `src/memory-bridge/governance-polyfill.ts` | 23,133 | 675 | `b07f2f97579ab13c5a89830631d2e0e45bef0706074236356d4e063d1eac2e61` |
| 34 | M | `src/memory-bridge/index.ts` | 867 | 25 | `4a342ec9800181e4cad9a85a4f7b07a7f5e18045be00b38a765ca1bfee1d1861` |
| 35 | ?? | `src/memory-bridge/status.ts` | 17,998 | 459 | `f6927c4f4fdab9740ceac1c5d568159ec4fd10c0cba761b50863b0c338ca9802` |
| 36 | ?? | `tests/e2e/host-smoke/report-path.test.ts` | 8,128 | 189 | `c83052d5a75b740d02cfb5780f0ac66c9f30921e80d493b997c3867d3234130d` |
| 37 | ?? | `tests/e2e/host-smoke/surface-matrix.test.ts` | 9,738 | 220 | `8c94af63cc4b4d0b4a0de8db4461d3f6cf43242f395ad0ddffee98c84b98b606` |
| 38 | ?? | `tests/e2e/host-smoke/surface-matrix.ts` | 20,014 | 448 | `dbfd3356439969ed7610bae73745e6c7a5305ab77a9af675145b457370f4218f` |
| 39 | ?? | `tests/e2e/host-smoke/surface-status.test.ts` | 11,527 | 242 | `e3d64e8dd468098f46f0bedd41679977de8a14953e89d03a85269729c0430d5b` |
| 40 | ?? | `tests/e2e/memory-write-path.test.ts` | 19,932 | 470 | `b8803cc4d7c3dd868983f77456a39dcb7a024a32055f70674601b58f85079d72` |
| 41 | ?? | `tests/fixtures/pr4a/.gitattributes` | 1,534 | 28 | `c47a86237cb58b553a9df9d03d162ffb29e12c756245bf3d40a8c739117e319a` |
| 42 | ?? | `tests/fixtures/pr4a/fixture-manifest.json` | 10,290 | 204 | `482630825665ede3830278085636d79b58d7d2b346da73c2da5f145b03295429` |
| 43 | ?? | `tests/fixtures/pr4a/pr4a-five-arm-eval.json` | 365,314 | 13381 | `f22bdb14a637c08f24576e6325a0cf3ff03e19551bd72eca10e9512dd1c55acb` |
| 44 | ?? | `tests/fixtures/pr4a/pr4a-ledger-Arm-0.jsonl` | 137,930 | 180 | `9c182a32b880039f55dee5a67a93cd65f32cddda5b92867312ffb1e25ce303ee` |
| 45 | ?? | `tests/fixtures/pr4a/pr4a-ledger-Arm-1.jsonl` | 151,523 | 180 | `cb0066107443534ea17a138e8da55c689dd410a782c0bbf0d7a30c29b7f49911` |
| 46 | ?? | `tests/fixtures/pr4a/pr4a-ledger-Arm-2.jsonl` | 152,493 | 180 | `12335caabdadf08ffb0d06d480f341e59f88746586e8cb98f5dcd0944266262f` |
| 47 | ?? | `tests/fixtures/pr4a/pr4a-ledger-Arm-3.jsonl` | 152,721 | 180 | `3e0257753aec88cd413e99786c78b35c275e29bd713bc1f29ff459f053888b1c` |
| 48 | ?? | `tests/fixtures/pr4a/pr4a-ledger-Arm-4.jsonl` | 152,721 | 180 | `301b7976366e5ad41ad8d964b232056050aa47bbd5923978eb9f5f5bfbf527a4` |
| 49 | M | `tests/unit/config/readme-default-leaves.test.ts` | 27,118 | 628 | `fd688c884559061cd8c428a8bc0bb8e05b9594ee8016cf59cc66fdf970500c15` |
| 50 | ?? | `tests/unit/dream-rsi/surrogate-self-reference.test.ts` | 12,224 | 285 | `3dd54b3c5223a8914db69c0c7a192ffa0857ba348dbd85e9afdadb2bce94911b` |
| 51 | ?? | `tests/unit/dsh-bridge/probe-safety.test.ts` | 12,134 | 304 | `8288d83268fc15c92db34f231959b675cad2bff1bb0da07eeadffcbdaed8dd90` |
| 52 | M | `tests/unit/dsh-bridge/agent-loop-ledger-assembly.test.ts` | 19,250 | 454 | `06b50306a16eee219f18000043ea04cd4aa99a7544f4d438c50eaf0f46a1e72c` |
| 53 | M | `tests/unit/dsh-bridge/p3c-two-phase-bridge.test.ts` | 26,577 | 628 | `4832e4b8002fd8e48e44f63fdb6aa412d57b2351018bd184d95b1a2e68d63dcd` |
| 54 | M | `tests/unit/eval/pr4a-cost-provenance-gate.test.ts` | 12,663 | 298 | `fdc41a35d5297c324ed3d103b05b84854821e7836d0830dbb42d9b9b0a625d85` |
| 55 | ?? | `tests/unit/eval/p3-cacheread-gating.test.ts` | 10,564 | 262 | `714efae356d9ec76da5040abbb60e0b8d621a3143941dba0a51079b33c852fbc` |
| 56 | ?? | `tests/unit/eval/pr4a-v2-discriminability-recheck.test.ts` | 29,389 | 680 | `22f3f6e951aa0f26d946123bcc9b4d075506c734e98401f49716d3735eeb8496` |
| 57 | ?? | `tests/unit/eval/structural-debt-gate.test.ts` | 20,878 | 474 | `0e5b23674913a644ebb52186c27474c7d45f435d309a9bf3f6f8357b7a6eb3f2` |
| 58 | ?? | `tests/unit/jitrl/text-probe-evaluation.test.ts` | 3,781 | 86 | `a9947fa8425f4462879630f00c45f88b7c3626eae2864d081b6b7f1d6ad3ce91` |
| 59 | M | `tests/unit/ledger/metered-model-adapter.test.ts` | 10,909 | 267 | `fbeff6a76b6ce93816b11360e70f33a1b0c0b6c28aef63c94f7bc2285ba8e2c5` |
| 60 | M | `tests/unit/ledger/p3a2-observe.test.ts` | 11,864 | 311 | `0a251bee543a180167672b3dd67fb9a0dde9120f8f61063a6cc09de8dca50888` |
| 61 | ?? | `tests/unit/memory-bridge/handle-memory-status.test.ts` | 7,805 | 185 | `b8470e1e4e1fe4adb4c5dc0e4888d48f920d579203fe845d24af0929d11c30e1` |
| 62 | ?? | `tests/unit/memory-bridge/production-defaults.test.ts` | 5,253 | 127 | `592e23d89261fe4f0c8e0e876ae15ef8a159816912206b5b4557e57148e32884` |
| 63 | ?? | `tests/unit/memory-bridge/recall-matching.test.ts` | 10,133 | 241 | `3b1983c588383bc2da7efacdd01f2aa51ecb033a0c186631d6de2d997d6c081d` |
| 64 | ?? | `tests/unit/memory-bridge/status.test.ts` | 10,118 | 256 | `325fcdacaba6820c6c15ebe240eda82acf905ba4fcf2506e533a4c6935c9495e` |
| 65 | ?? | `tests/unit/meta/no-work-dependency.test.ts` | 25,014 | 519 | `097c0ef92a7f2cda9c3473f11c2e4f0bbe5ad2f555cb3e2f6d3b03c215b4448e` |
| 66 | ?? | `tests/unit/meta/work-path-scanner.ts` | 32,376 | 792 | `6b77c2f5ba57c0dc4a73ead7dc813e2f1490d4ed4cae3af9db148c1f78d7563c` |
| 67 | ?? | `tests/unit/p62/build-freshness.test.ts` | 13,135 | 309 | `5c1f1de1b1382ca3dc80cd894d0fc22d10dc2dd2cb11ee5ccbe3adfd9f98250f` |
| 68 | ?? | `tests/unit/p62/ci-evidence-wiring.test.ts` | 4,811 | 91 | `8464972f0e1787107f0272cdc37de9523182307442d587372338c85652fb8c4c` |
| 69 | ?? | `tests/unit/p62/clean-tree-gate.test.ts` | 10,616 | 244 | `f8f7760c706cd13e02cb8cb59aa991ccdefa830e69f88f8cbb764070b90321f8` |
| 70 | ?? | `tests/unit/p62/docs-correction-pointers.test.ts` | 6,022 | 121 | `1491d476c4e2adbf6d153960219be8682ed6fdd9a0851671605c06bddf14a4bb` |
| 71 | ?? | `tests/unit/p62/docs-gate-j1.test.ts` | 11,559 | 276 | `bb60034eb6c9e3f31af7a4e26e1f2868d9dfc57ee1f300500776331be93bab1f` |
| 72 | M | `tests/e2e/host-smoke/bundle-entry.ts` | 5,639 | 139 | `84ee2720c16a6fb99e1d04393377995d46d481e8aa3cebc5062dcaae971677bc` |
| 73 | M | `tests/e2e/host-smoke/report-template.ts` | 9,953 | 260 | `a62bad89d5457749682681ea169c01d87fddfffe06a3efec99515f980d68e67c` |

**合计 2,481,944 B（73 文件）**。行序与 `docs/reports/rev5-final-integration.md` 附录 A **逐行同序**（该顺序不是 path 的 ASCII 排序，也不是大小写不敏感排序；t7 已实测三种排序均无法复现，故此处直接沿用 rev5 报告顺序），每行 sha256 为完整 64 位（rev5 报告只印前 8 位）。

---

**（完）** 本文件由 `t7` 产出；不修改任何生产代码、不执行付费模型/真实工具/真实记忆写入、不 commit/push。
