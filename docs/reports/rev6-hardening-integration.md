# rev6 硬化收尾 — t8 全量集成与交付门禁报告

- 团队：rev6-hardening-and-dsh-live · 任务 t8（integrate, attempt 1, `add828c5-14df-45c8-9cb5-1fa68545c5d8`）
- 日期：2026-10-31（+08:00）· 执行者：token-runtime
- 对象：最终完整工作树（含 t1/t2/t3/t12/t13/t14 交付与 t4/t5/t6/t7 独立验证与交叉审核结论）
- 纪律：零 commit / 零 push / 零真实模型调用 / 零记忆写入 / 零 guarded-active / 零 publish；未使用 node_modules junction；未宣称远端 CI、HEAD attestation、收益或宿主已加载。

---

## 1. 一句话结论

**八项交付门禁在本机最终完整工作树上全部 exit 0；README 计数经实测 vitest run 同步为 163 文件 / 2956 测试。** 交付物为硬化修复 + 验证/审核链闭合本身，不是收益主张（engineering green ≠ benefit claim）。

## 2. 门禁矩阵（本 attempt 实测，全部 exit 0）

| # | 门禁 | 结果 |
| :-- | :--- | :--- |
| 1 | `pnpm run typecheck` | exit 0（tsc --noEmit 零错误） |
| 2 | `pnpm run test`（全量 Vitest） | **163 文件 / 2956 测试全部通过**（75.1s；unit 140/2632 + e2e 23/324，两侧闭合与总运行逐位一致） |
| 3 | `pnpm run check:docs` | exit 0：zero failed/pending、J-1 完整成功报告（success=true、0 failed suites、0 unhandled errors、0 todo）、三方闭合通过、Config reference 78/78 leaves |
| 4 | `pnpm run check:encoding` | exit 0：全部 tracked blob 为 LF 文本或显式例外（binary.bin / crlf.txt / utf8-bom.txt） |
| 5 | `pnpm run check:build-smoke` | exit 0：真实 `pnpm run build` 子进程构建 + ESM import + 导出面 + `apply`/`createEvoHarnessPlugin` 可调用 + PLUGIN_NAME 匹配，`stale: false` |
| 6 | `pnpm run check:negative-result --assert` | exit 0：A1..A6 历史负结果完整（−0.250 不漂移；strategy gates 保持 probe-not-default） |
| 7 | `pnpm run check:mutation` | verdict **PASS**：4/4 pinned mutants 全部 KILLED（M1 red=4/4、M2 red=5/3、M3 red=3/2、M4 red=2/2，extra red 均为观察性非致命），worktree zero-residue、副本已删 |
| 8 | `pnpm run guarded-regression --json` | exit 0：release-surface/isolation/trusted-source 探针通过；边界声明内嵌（无真实调用、无付费 API、无 publish、无真实记忆写入；trusted-producer registrar 已移除） |

## 3. README 计数重铸（机械同步，非手改数字）

计数漂移由并行批新增测试累计造成（基线 162/2932 → 实测 163/2956）。按团队既定惯例（"由集成任务从一次绿色 run 重铸"）执行：

- **实测来源**：`pnpm run test` 全量 163/2956；分根 `tests/unit` 140/2632、`tests/e2e` 23/324（各自 `--reporter=json` 实测，闭合校验 140+23=163、2632+324=2956 与全量逐位一致）。
- **同步的 4 处**：README 汇总行（`162`→`163`、`2932`→`2956`）与 Testing 表三行（unit 140/2632、e2e 23/324、total 163/2956）。
- **验证**：`check:docs` 以该次运行的合并 JSON 报告（`--report`）复核，全部计数逐一匹配、闭合并 Config reference 全绿。

## 4. 本轮硬化交付一览（含独立验证与交叉审核状态）

| 任务 | 交付 | 独立验证 / 交叉审核 |
| :--- | :--- | :--- |
| t1 fix-token | 执行级 token 硬预算：per-call cap 随每次 client 调用下发（与构建 option 取更严者）；`absoluteTotalCapWouldExceed` 在 treatment 预留前拒绝越授权 800M 的累计；结算后毛值复判；报告新增 `postHocPerCallChecks`/`absoluteTotalPrechecks` | t4 独立验证通过（4 攻击面）+ t6 交叉审核建议通过（3 low 报告面 findings） |
| t2 fix-binding | 绑定/运行器严格性统一：runner 永不静默默认 token cap；必需键行与默认梯消费生产共享导出 | t5 独立验证通过 + t7 交叉审核 pass（2 low findings） |
| t3 fix-ci | smoke-build 生产构建子进程钉定 `CI='true'`（整体继承环境，仅覆写 CI） | t5 复跑（含 CI=false 调用方漂移证明）+ t7 代码级比对 |
| t12 | evidence-gates 严格空值 4×TS2532 最小修正（`buildStep` 窄化） | t5 复跑全仓 typecheck exit 0 |
| t13 | t7 两处 low 报告瑕疵清理（budget-binding 注释方向、runner 死兜底删除） | t13 自证 7/7 + typecheck exit 0 |
| t14 | t6 三项 low 报告面 findings：abortedByTokenCap 双强制点注释 + `tokenCapAbortOrigin`/`capIgnoredByClient` 透传 + runner 计数器透传 | 自证 + 全量门禁（本报告） |

## 5. 本任务（t8）唯一改动

- `README.md`（测试计数 4 处实测同步：162/2932 → 163/2956，分根 140/2632、23/324）
- `docs/reports/rev6-hardening-integration.md`（本报告，新增）

除上述两个文件外零改动；未触碰冻结历史报告、`src/**`、`scripts/**` 或 CI 文件。

## 6. 诚实边界（本报告不声明什么）

- **零真实模型调用、零真实 token 消耗、零预算消耗**：全部合成 fixture。
- **不宣称远端 CI**：所有门禁均为本机（win32/x64, node v22.23.1, pnpm 11.7.0）实测；`.github/workflows/ci.yml` 的远端执行状态不在本轮证据内。
- **不宣称 HEAD attestation**：本轮零 commit/push（团队纪律），attestation 绑定的 commit 指纹不存在，脏树状态按既有惯例以显式记录处理，不伪造干净树。
- **不宣称收益**：八门绿是工程事实；t1–t14 的交付是防护机制与验证/审核链，不是任何任务收益或策略收益的主张。
- **不宣称宿主已加载**：本轮未执行任何 DSH 插件安装/更新/重启/宿主内 smoke；"实际安装插件是否为最新代码"的核对与 shadow-only 实机验证属后续任务，本报告不预支其结论。
- **计数快照性**：163/2956 是本 attempt 时点的实测快照；后续任何测试增删都会使 README 计数再次漂移，须由下一次绿色 run 重铸。
