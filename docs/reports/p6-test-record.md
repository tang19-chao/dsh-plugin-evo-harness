# P6 迭代测试记录（最新）

> 生成时间：2026-10-24 07:29 (Asia/Shanghai)
> 基线 commit：`7307d7dce40c7746a17a92e6a0262f272cca7f42`（v0.1.0）
> 运行环境：Windows / Node `v22.23.1` / pnpm `11.7.0`
>
> **本文件只保留本迭代最新一次的完整验证结果。** 迭代过程中的数百份中间日志（逐 PR 的临时
> tsc / vitest / 探针输出）未纳入版本库；`work/` 目录已在 `.gitignore` 中排除。

## 1. 门禁汇总

| 门禁 | 命令 | 结果 |
| :--- | :--- | :--- |
| 类型检查 | `pnpm exec tsc --noEmit` | **PASS**（exit 0，0 诊断） |
| 打包构建 | `pnpm run build` | **PASS**（exit 0） |
| 全量测试 | `pnpm test` | **PASS**（71 文件 / 1344 用例） |
| 文档计数一致性 | `pnpm run check:docs` | **PASS**（README 与实测完全一致） |
| 默认评测 CLI | `node scripts/eval-jitrl.mjs --json` | **PASS**（exit 0，JSON 可解析，无需额外 flag） |

## 2. 全量测试

```text
Test Files  71 passed (71)
     Tests  1344 passed (1344)
  Duration  14.02s
```

拆分（由 `check:docs` 实测输出）：

| 套件 | 文件 | 用例 |
| :--- | ---: | ---: |
| `tests/unit` | 62 | 1243 |
| `tests/e2e` | 9 | 101 |
| 合计 | 71 | 1344 |

对比迭代起点（`7307d7d` 基线）：**64 文件 / 1154 用例 → 71 文件 / 1344 用例**，净增 7 个
测试文件、190 条用例。

## 3. 默认评测 CLI

```text
$ node scripts/eval-jitrl.mjs --json
EXIT=0
stdout ~302 KB 合法 JSON（protocol.episodes=5, taskCount=12, metrics=13 条）
```

该入口在本迭代前（`7307d7d`）**无法运行**：`node scripts/eval-jitrl.mjs --json` 报
`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`（`src/dsh-bridge/branch.ts` 的 TypeScript parameter
property 不被 Node strip-only 模式接受），退出码 1。现改为 esbuild 预编译 + 内容指纹缓存。

## 4. 本轮验证覆盖的缺陷修复

下列条目均有对应回归测试，且多数附有「回退修复后测试必红」的变异证据（记录在各 PR 评审报告中）。

| 方案条目 | 内容 | 状态 |
| :--- | :--- | :--- |
| PR1 / R7 | 默认评测 CLI 可运行性、子进程 smoke、CI 步骤 | 已闭环（评审 t20 pass） |
| PR2 / R1 | 单一 `JitRuntimeControl`，`jit off` 覆盖七面 | 已闭环（评审 t22 pass） |
| PR3 / R2+R3 | `ScopeRegistry` 归因隔离、invariant 分支 fail-closed | 行为已修好；两条 medium 未关闭（见 §6） |
| PR4 / R4 | 逐执行证据归因替代「复制赢家回报」 | 已闭环（评审 t13 + t23 pass） |
| PR5 / R5 | 在线/replay 共用决策内核、EffectivePolicyConfig、M3 口径 | 实现完成；评审 t14 后返修，待复评 |
| PR6 / R6 | 同 K 同候选池 C0–C4 公平对照、三协议分离 | 实现完成；待评审 |
| PR7 / 5.3 | tokenizer 预算、composer 剥离、mirror 脱敏、统一收尾 | 实现完成；评审 t12 后返修，待复评 |
| PR8 | 真实宿主 + 单 MCP 验收、rc1 文档 | **未开始** |

## 5. 关键指标的诚实边界

- **合成评测的数字不是生产效果承诺。** C0–C4 对照在同一合成任务集上测得，
  `C3-online − C3-frozen = −0.250`（区间 `[−0.417, −0.083]`）：该合成环境里偏离先验**有代价**，
  报告如实记录为「允许通过的零/负结果」，不作为学习收益证据。
- **KL 非零只证明分布变了**，不证明变好。
- **跨任务迁移**的 `Δ +0.200`（区间 `[−0.216, +0.616]`）样本量小，仅作可行性证据。
- **`p6-eval-baseline.md` 的指标绑定的是采集时的工作树字节**，不是 `7307d7d` 的已提交行为；
  该报告已显式声明这一点并给重跑时机。
- **真实 DSH 宿主 / 真实 MCP 后端联调未完成**（PR8 未开始），因此 **Gate 4 未通过**，
  不得宣称生产就绪。

## 6. 已知未关闭项（不得当作已通过）

1. **PR3 / PR3-TEST**：provenance 用例未走 `patch/context → eight-surfaces → adapter` 真实挂载
   链路；评审已在克隆中验证「抹掉 eight-surfaces 的 provenance 传递后测试仍全绿」，
   即链路被拆掉没有测试报警。
2. **PR3 / F9 口径**：生产默认下匿名 `{name:'bash'}` 仍可获得 advice，且采集端写入
   `guidance:'memory'`；代码注释（Option 2）与测试名（Option 1）自相矛盾，待拍板统一。
3. **PR5 / PR7**：两轮返修已完成接线与夹具修正，但**尚未取得绑定稳定字节的复评 pass**。
4. **PR8 / Gate 4**：未开始。
5. 各评审报告中标注为「已知限制」的项：PR4-L1（`decisionId` 非按层唯一）、
   PR1-L3（基线在脏树测得、Node 24 未复验）。

## 7. 复现方式

```bash
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm test
pnpm run check:docs
pnpm run build
node scripts/eval-jitrl.mjs --json
```

以上六条命令在本文生成时全部通过。
