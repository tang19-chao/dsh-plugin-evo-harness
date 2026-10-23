# P6 固定基线报告（R7 / PR1）

> 本文件由 `node scripts/eval-jitrl.mjs --baseline docs/reports/p6-eval-baseline.md` 生成。数字来自 `node scripts/eval-jitrl.mjs --json` 的一次真实子进程执行，**没有**使用 `--experimental-transform-types` 等诊断参数，也不是手写估值。

## 1. 基本身份

| 项 | 值 |
| :-- | :-- |
| 代码版本 | `7307d7dce40c7746a17a92e6a0262f272cca7f42`（short `7307d7d`） |
| 工作树状态 | **dirty**：基线是在未提交的工作树上测得的，改动清单见 §1.1；其中包含 `src/**` 的未提交改动，此时基线描述的是**工作树中的插件**，不是 `7307d7d` 的已提交行为 |
| 生成时间（本地） | 2026-10-23 21:18:02 (UTC+08) |
| Node | `v22.23.1` |
| 命令 | `node scripts/eval-jitrl.mjs --json` |
| 退出码 | `0` |
| 协议 | 每任务连续 L=5 次；报告 Avg（L 次均值）、Final（第 L 次）、Final−Avg |
| 任务集 | 12 个离线合成任务；家族：ci-fix, schema-migration, test-authoring |
| 随机性 | 0xfe348428 (suite fingerprint; the metric block is deterministic) |
| 总耗时（协议） | 5177.99 ms |

### 1.1 工作树改动清单（基线对应的未提交改动）

```text
M .github/workflows/ci.yml
M package.json
M scripts/eval-jitrl.mjs
M src/cordis-seams/dsh-hook-host-adapter.ts
M src/index.ts
M src/jitrl/host-advisor.ts
M src/jitrl/host-tool-experience.ts
M src/orchestrator.ts
M src/types/contracts.ts
M tests/unit/cordis-seams/dsh-hook-host-adapter.test.ts
?? docs/reports/p6-eval-baseline.md
?? findings/
?? scripts/eval/build-eval.mjs
?? src/jitrl/runtime-control.ts
?? src/jitrl/scope-registry.ts
?? tests/e2e/eval-cli.smoke.test.ts
?? tests/e2e/jit-control.test.ts
?? tests/unit/jitrl/host-tool-experience.test.ts
?? tests/unit/jitrl/runtime-control.test.ts
```

**注意**：清单中包含 `src/**` 的未提交改动（本 PR1 未修改 `src/**`；这些是同一共享工作树上其他并行 PR 的改动）。因此本报告证明的是「默认评测命令在当前工作树上可直接运行并退出 0」，其指标块描述的是**当前工作树中的插件**，不能直接标注为 `7307d7d` 的已提交行为。

## 2. 门禁结果

| 门禁 | 检查项 | 结果 | 证据 |
| :-- | :-- | :-- | :-- |
| G0.1 | 默认命令退出码为 0 | PASS | `node scripts/eval-jitrl.mjs --json` 以退出码 0 结束 |
| G0.2 | 输出为可解析 JSON 且含 protocol/metrics | PASS | protocol.episodes=5；metrics=13 条 |
| G0.3 | B0–B3 四组基线齐全 | PASS | B0–B3 全部出现 |
| G0.4 | 三类 invariant 泄漏与 canary 泄漏合计为 0 | PASS | 合计 0 次泄漏（13 个条件） |
| G0.5 | B0 是静态下界（其余基线 Avg 不低于 B0） | PASS | B1/B2/B3 均不低于 B0 |
| G0.6 | 协议声明确定性 | PASS | true；seed 0xfe348428 (suite fingerprint; the metric block is deterministic) |

全部门禁通过。

## 3. 基线指标 B0–B3

| 组 | 配置 | Avg | Final | Final−Avg | 解出率 | oracle 比 | probes/任务 | KL 均值 | KL p95 | 近邻命中率 |
| :-- | :-- | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| B0 | - | 0.569 | 0.569 | 0.000 | 0.250 | 0.569 | 0.00 | 0.000 | 0.000 | 0.000 |
| B1 | - | 0.889 | 0.889 | 0.000 | 0.667 | 0.889 | 7.00 | 0.000 | 0.000 | 0.000 |
| B2 | meta | 0.889 | 0.889 | 0.000 | 0.667 | 0.889 | 7.00 | 0.025 | 0.231 | 0.975 |
| B3 | meta+proposal | 0.956 | 0.972 | +0.017 | 0.867 | 0.956 | 7.00 | 0.031 | 0.239 | 0.975 |

`Avg`/`Final` 是覆盖率（命中的必需表面 / 必需表面总数）在 12 个任务上的均值；`解出率` 是完全解出的 run 占比；`oracle 比` 是实测覆盖率与该任务表内最优覆盖率之比。

## 4. 安全指标

| 组 | invariant 泄漏 | invariant 记忆泄漏 | invariant guidance 违约 | canary 泄漏 | invariant 提案数 |
| :-- | --: | --: | --: | --: | --: |
| B0 | 0 | 0 | 0 | 0 | 0 |
| B1 | 0 | 0 | 0 | 0 | 120 |
| B2 | 0 | 0 | 0 | 0 | 120 |
| B3 | 0 | 0 | 0 | 0 | 360 |
| A2-k4 | 0 | 0 | 0 | 0 | 360 |
| A2-k8 | 0 | 0 | 0 | 0 | 360 |
| A2-k10 | 0 | 0 | 0 | 0 | 360 |
| A2-k14 | 0 | 0 | 0 | 0 | 360 |
| A2-k20 | 0 | 0 | 0 | 0 | 360 |
| A3-beta0.5 | 0 | 0 | 0 | 0 | 360 |
| A3-beta1 | 0 | 0 | 0 | 0 | 360 |
| A3-beta2 | 0 | 0 | 0 | 0 | 360 |
| A3-beta4 | 0 | 0 | 0 | 0 | 360 |

三类 invariant 泄漏与 canary 泄漏合计 **0**（必须为 0）。

## 5. 如何复核本基线

```bash
# 1) 用户文档中的原命令（不得附加任何 --experimental-* 参数）
node scripts/eval-jitrl.mjs --json

# 2) 通过 pnpm 脚本执行同一入口
pnpm run eval:jitrl -- --json

# 3) 重新生成本报告（会重新执行上面的命令）
pnpm run eval:jitrl:baseline

# 4) 子进程 smoke（CI 门禁）
pnpm exec vitest run tests/e2e/eval-cli.smoke.test.ts
```

CLI 通过 esbuild 预编译评测库到 `node_modules/.cache/dsh-plugin-evo-harness/` 后导入产物，因此不再依赖 Node 原生 TS strip 对 parameter property 的支持，也不需要隐藏 flag。

## 6. 这份基线能证明什么、不能证明什么

- **能证明**：`node scripts/eval-jitrl.mjs --json` 在 Node `v22.23.1` 上可直接运行并退出 0，输出可机读；B0–B3 与安全门禁位于上述数值。代码版本为 `7307d7d` 加上 §1.1 中的工作树改动，因此上述指标描述的是**该工作树中的插件**。
- **不能证明**：真实模型、真实 DSH 宿主或真实 MCP 后端上的效果；合成任务集的收益不能外推为生产收益。
- **不能替代**：`tests/e2e/jitrl-ablation.test.ts`（协议不变量）与后续 Gate 1–4 的验收证据。
- **重跑时机**：当 §1.1 中的 `src/**` 改动全部提交、工作树只剩本 PR1 的评测入口改动时，重跑即可把基线对齐到一个确定的 commit。
