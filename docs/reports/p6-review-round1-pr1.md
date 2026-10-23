# PR1 / R7 独立评审报告（Gate 0 · 第 1 轮）

| 项 | 值 |
| :-- | :-- |
| 被评任务 | t2「PR1 / R7：修复默认 eval CLI 可运行性，加子进程 smoke 与固定 SHA 基线报告」 |
| 评审任务 | t9（attempt `26e44506-dced-47b4-ad33-0d19fbcd9d43`） |
| 评审人 | gate-reviewer |
| 评审对象 commit | `7307d7dce40c7746a17a92e6a0262f272cca7f42` + 共享工作树未提交改动 |
| 评审机 Node | `v22.23.1`（`where node` → `C:\Users\Administrator\AppData\Local\hermes\node\node.exe`，本机仅此一份） |
| 评审时间 | 2026-10-23 21:18–21:22 (UTC+08) |
| 结论 | **pass**（无阻塞项；3 条 low 观察项，均不影响本次验收） |

评审方式：只读代码 + 由评审人本人重跑用户入口，未修改 `src/**`、`tests/**`、`scripts/**`。所有红/绿证据均由评审人自行产生，不引用被评者自述。

---

## 1. 用户入口真实性（Gate 0 第一条：默认 CLI 必须真跑）

**评审人本人执行的命令与真实退出码：**

```
$ node scripts/eval-jitrl.mjs --json
EXIT=0
ELAPSED_MS=5471
STDOUT_BYTES=312149
STDERR_BYTES=0
```

输出摘要（评审人从 312,149 字节 stdout 解析，未加任何 `--experimental-*` 参数）：

- `protocol.episodes=5`、`taskCount=12`、`deterministic=true`、`seed=0xfe348428`
- `metrics` 13 条：`B0,B1,B2,B3,A2-k4,A2-k8,A2-k10,A2-k14,A2-k20,A3-beta0.5,A3-beta1,A3-beta2,A3-beta4`
- `timing.totalMs=4788.19`
- 四类泄漏合计 `0`

| 组 | Avg | Final | Final−Avg | 解出率 | oracle 比 | probes/任务 | KL 均值 | KL p95 | 近邻命中率 |
| :-- | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| B0 | 0.569 | 0.569 | 0.000 | 0.250 | 0.569 | 0.00 | 0.000 | 0.000 | 0.000 |
| B1 | 0.889 | 0.889 | 0.000 | 0.667 | 0.889 | 7.00 | 0.000 | 0.000 | 0.000 |
| B2 | 0.889 | 0.889 | 0.000 | 0.667 | 0.889 | 7.00 | 0.025 | 0.231 | 0.975 |
| B3 | 0.956 | 0.972 | +0.017 | 0.867 | 0.956 | 7.00 | 0.031 | 0.239 | 0.975 |

修复体现在**用户入口本身**（`node scripts/eval-jitrl.mjs --json`），不是在测试里 import 库：命令退出 0、stdout 纯 JSON、stderr 为空。Gate 0 的“默认 CLI smoke 单独运行、不能以 import 库的测试替代”在形式上与实质上均成立。

### 1.1 旧路径确实不再是加载方式

- `git show HEAD:scripts/eval-jitrl.mjs`（修复前）含 `register('data:text/javascript,...extensionResolver...')` + `await import('./eval/jitrl-eval-lib.ts')`。
- 现版本 `scripts/eval-jitrl.mjs:44-45` 改为 `await import('./eval/build-eval.mjs')` → `loadEvalLib()`，文件内已无 `register`/扩展名解析钩子。
- `scripts/eval/build-eval.mjs:205-220` 用仓库自带 esbuild（devDependency）以 `bundle/format:esm/platform:node/target:node20` 预编译到 `node_modules/.cache/dsh-plugin-evo-harness/<name>.<digest20>.mjs`，`loadEvalLib` 只 import 该 `.mjs` 产物（`build-eval.mjs:258-261`）。Node 运行时不再接触任何 `.ts`。

### 1.2 冷构建（等价于 CI 全新 checkout）也通过

CI/新克隆的 `node_modules/.cache` 为空，所以冷构建必须能过。评审人用作者提供的缓存目录覆盖把产物强制落到仓库内空目录：

```
$ DSH_EVAL_CACHE_DIR=<repo>/node_modules/.cache/review-t9-cold node scripts/eval-jitrl.mjs --json
INREPO_COLD_EXIT=0  ELAPSED_MS=5397  STDOUT_BYTES=312150
新产物：jitrl-eval-lib.ff9bc5ba472131105f79.mjs  3,473,436 bytes（评审后已清理该临时缓存目录）
```

即首次运行会真的构建（~5.4 s 含协议），不是“碰巧命中作者预置产物”。

---

## 2. 回归判别力（必须“旧实现必红”，不接受只看现在绿）

**评审人自行做了回退验证（不是引用被评者自述）：**

1. 先证明旧加载机制在本机 Node 上必失败（把修复前的 resolver 钩子原样复制到 `%TEMP%` 执行，仓库文件未改动）：

```
OLD_MECHANISM_IMPORT_FAILED code=ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX
TypeScript parameter property is not supported in strip-only mode
```

2. 再在 `%TEMP%\t9-oldcli\` 以 git 历史版本跑**真正的旧 CLI**（`scripts-old/` + junction 到仓库 `scripts/eval`），stdout/stderr 落盘：

```
OLD_CLI_EXIT=1
OLD_STDOUT_BYTES=0
stderr: ... file:///.../src/dsh-bridge/branch.ts:140  constructor(private readonly now: () => number, ...
       SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not supported in strip-only mode
```

3. 决定性证据：把**新** smoke 测试注入到干净克隆的 `7307d7d`（`git clone --no-local --depth 1`，`CLONE_HEAD=7307d7d`，旧 CLI 仍在用 `register` + 直接 import `.ts`），跑该测试：

```
$ node <repo>/node_modules/vitest/vitest.mjs run tests/e2e/eval-cli.smoke.test.ts   (cwd = 克隆)
 Test Files  1 failed (1)
      Tests  2 failed | 1 passed (3)
REVERT_VITEST_EXIT=1
```

失败点正是判别力所在：`expect(result.status).toBe(0)` 拿到 1、stdout 为空；未知参数用例也因 CLI 在 arg 解析前就崩而拿不到 `/unknown argument/i`。**新测试在旧实现上必红，已实证。**

同一测试在当前工作树为绿：

```
$ node <repo>/node_modules/vitest/vitest.mjs run tests/e2e/eval-cli.smoke.test.ts   (cwd = 仓库)
 ✓ tests/e2e/eval-cli.smoke.test.ts (3 tests) 5683ms
 Test Files  1 passed (1)   Tests  3 passed (3)   VITEST_EXIT=0
```

补充：`vitest.config.ts` 只继承 vitest 默认 include 并排除 `work/**`，因此 `tests/e2e/eval-cli.smoke.test.ts` 会被 `pnpm test`（`"test": "vitest run"`）与 CI 的 `pnpm exec vitest run` 正常收集——判别力不会只在手工单跑时存在。

---

## 3. 基线报告真实性（数字必须来自默认命令）

**机制核对（先读码再重跑）：** `scripts/eval-jitrl.mjs:217-233` 的 `runDocumentedCommand()` 以 `execFile(process.execPath, [SELF_PATH, '--json'])` 重新跑 `node scripts/eval-jitrl.mjs --json`（无附加 flag），`--baseline` 分支在参数解析后早退（`:518-521`），不在本进程重复跑协议；G0.1–G0.6 全部由该子进程的 stdout/退出码计算（`:267-330`），不手写。

**评审人重跑生成器（写到 `%TEMP%`，未覆盖仓库内报告）：**

```
$ node scripts/eval-jitrl.mjs --baseline %TEMP%\t9-baseline-regen.md
baseline written ... ; command: node scripts/eval-jitrl.mjs --json (exit 0)
gates: G0.1=PASS G0.2=PASS G0.3=PASS G0.4=PASS G0.5=PASS G0.6=PASS
BASELINE_GEN_EXIT=0
```

把重跑产物的 `G0.*`/`B0–B3`/安全行与提交的 `docs/reports/p6-eval-baseline.md` 逐行对比：**逐字节相同**（含 `metrics=13 条`、`合计 0 次泄漏`、seed 串、B3 `0.956/0.972/+0.017`）。

**独立交叉核对：** §1 中评审人自己那次 `--json` 的原始 JSON 与报告 §3 表格在 3 位小数上全部一致（B0 `0.5694`→0.569、B3 `0.9556/0.9722`→0.956/0.972、B2 KL `0.0251/0.2305`→0.025/0.231、B3 KL `0.0314/0.2395`→0.031/0.239）；`totalMs` 不同（5177.99 vs 4788.19）属正常运行间波动，报告已把 timing 排除在确定性块之外。

**报告身份可信：** `docs/reports/p6-eval-baseline.md:22-42` 的“工作树改动清单”与评审时 `git status --porcelain` 的 19 条**完全一致**，说明报告确实由同一棵工作树生成，不是从别处抄的数字。

**不得是 `--experimental-transform-types` 的结果：** 仓库内该 flag 只出现在 `tests/unit/memory-bridge/spi-and-bridge.test.ts:451-454`（与 PR1 无关的既有探针），修复后的入口、`build-eval.mjs`、CI 中均无任何 `--experimental-*`；且 `--baseline` 的子进程命令是可读可复现的固定字符串，无隐藏参数。数字来自默认命令运行——成立。

---

## 4. CI 门禁

`.github/workflows/ci.yml` 共 55 行、8 个 step；在 `Typecheck`（L40-41）之后新增：

```
L48: - name: Run default eval CLI
L49:   run: node scripts/eval-jitrl.mjs --json
```

无 pnpm wrapper、无隐藏 flag，原有 7 步（checkout / pnpm / Node 22 / install --frozen-lockfile / typecheck / tests / check:docs）全部保留。`package.json` 仅新增 `eval:build`、`eval:jitrl:baseline`，既有 `eval:jitrl` 等条目未变。

---

## 5. 诚实分层、禁止项、数据正确性

- **诚实分层（§12）**：报告 §1 明示“12 个离线合成任务”，§6 明确“不能证明真实模型、真实 DSH 宿主或真实 MCP 后端上的效果；合成任务集的收益不能外推为生产收益”，并把 `tests/e2e/jitrl-ablation.test.ts` 与 Gate 1–4 列为不可替代项。全程无“真实宿主/MCP 通过”的措辞。
- **脏树披露**：报告 §1/§1.1 主动标注工作树 dirty、`src/**` 含其他并行 PR 的未提交改动，并说明指标块描述的是**工作树中的插件**而非 `7307d7d` 的已提交行为；`baselineGates`/`renderBaseline` 是实测后渲染（`gitIdentity()` 实时读 git），不是“凭信仰”写死 `src/** unchanged`。这属于加分项：把测量边界写在报告里，而非隐去。
- **禁止项（§12）**：本 PR 未新增用户可关的 invariant 隔离生产开关、未触碰 advisor 的 deny 行为、未新增 L4 算法层或记忆后端、未把合成数字写成生产效果承诺。`git diff --stat` 显示 PR1 自身只改 `.github/workflows/ci.yml`、`package.json`、`scripts/eval-jitrl.mjs` 并新增 `scripts/eval/build-eval.mjs`、`tests/e2e/eval-cli.smoke.test.ts`、`docs/reports/p6-eval-baseline.md`；`git diff -- src` 中不含 `eval-jitrl|build-eval|eval:build` 任何引用，与“本 PR1 未修改 `src/**`”的声明一致。
- **门槛可机判**：G0.1–G0.6 全部是退出码/结构/计数的可机判断言；泄漏门槛把 `invariantLeaks + invariantMemoryLeaks + invariantGuidanceLeaks + canaryLeaks` 四类一起求和（`:274-282`），与报告 §4 的四列表格对得上。
- **失败路径**：`--baseline` 对子进程 stdout 非 JSON 的情形给出 exit 2 并打印子进程退出码与 stderr 前 4000 字符（`:473-483`）；esbuild 失败时重排 `error.errors` 为“文件:行: 文本”（`build-eval.mjs:221-239`）；缓存写入用 `<pid>.tmp` + rename 抗并发（`:199-251`）。这些路径为代码复核，未逐一注入故障验证。

---

## 6. 观察项（low，非阻塞；不改变本轮 verdict）

| id | 严重度 | 问题 | 位置 | 建议修复 |
| :-- | :-- | :-- | :-- | :-- |
| PR1-L1 | low | 调试用环境变量 `DSH_EVAL_CACHE_DIR` 若指向仓库 `node_modules` 之外，产物失去 bare import 解析根，CLI 直接 `ERR_MODULE_NOT_FOUND`。评审实测：`DSH_EVAL_CACHE_DIR=%TEMP%\t9-cold-cache2 node scripts/eval-jitrl.mjs --json` → `exit 1 / Cannot find package '@deepseek-ai/schemastery' imported from ...\Temp\t9-cold-cache2\jitrl-eval-lib.<digest>.mjs`（stdout 0 字节）。默认路径（仓库内 `node_modules/.cache`）与 CI 均不受影响，报告与文档也从未宣传该覆盖变量，故不阻塞。 | `scripts/eval/build-eval.mjs:60-65` | 覆盖目录不在 `node_modules` 祖先链上时，要么把产物落到 `resolve(override)/../node_modules/...` 语义的解析根内，要么改用 `packages: 'bundle'`（或对该覆盖值直接报错退出并说明原因），且把该限制写进 `defaultCacheDir()` 注释。 |
| PR1-L2 | low | 缓存裁剪的“超量”分支方向反了：`candidates` 按 `ageMs` 降序（index 0 最旧），而 `overCap = index >= MAX_ARTIFACTS - 1 && ...` 使超量时被删的是**最新**的旧产物（index 11）而非最旧的。仅影响缓存占用，不影响评测结果；`>24h` 与 `>5min` 两道年龄护栏仍避免删到并发进程正在 import 的文件。 | `scripts/eval/build-eval.mjs:152-158` | 改为按 `ageMs` 降序保留前 `MAX_ARTIFACTS-1` 个、对 `index >= MAX_ARTIFACTS-1 && ageMs > QUIET_AGE_MS` 之外的**索引更大者**（即更年轻者）跳过，或等价地 `if (index < MAX_ARTIFACTS - 1) continue;` 之外再加年龄判断；并用一个“造 13 个 mtime 递增产物”的单测锁住“先删最旧”。 |
| PR1-L3 | low | 基线是在 dirty 工作树上测的（作者已如实披露），因此当前报告不能标为 `7307d7d` 的固定 SHA 行为；且原始缺陷是在 Node `v24.14.1` 复现的，本机只有 `v22.23.1`，Node 24 上的修复未被复验（属证据覆盖缺口，非虚假声明：报告只声明 v22.23.1）。 | `docs/reports/p6-eval-baseline.md:10,12,110` | 兄弟 PR 的 `src/**` 改动提交、工作树只剩 PR1 改动后重跑 `pnpm run eval:jitrl:baseline`；若 CI/本机可获得 Node 24，追加一次 `node scripts/eval-jitrl.mjs --json` 的版本矩阵记录（报告已自带重跑时机说明）。 |

---

## 7. 验收结论（对照评审契约）

| 验收项 | 结果 | 证据 |
| :-- | :-- | :-- |
| 评审人本人执行 `node scripts/eval-jitrl.mjs --json` 并贴真实退出码与输出摘要 | **passed** | `EXIT=0`，312,149 字节 JSON，13 条件，`totalMs=4788.19`，§1 给出四类泄漏=0 |
| 加载已改为预编译/构建产物，旧 strip 路径不再是唯一方式 | **passed** | `eval-jitrl.mjs:44-45` + `build-eval.mjs:205-261`；旧 `register`+`.ts` 直接 import 已删；冷构建（空缓存）同样 exit 0 |
| smoke 测试以子进程执行用户文档原命令，且在旧实现上失败 | **passed** | `tests/e2e/eval-cli.smoke.test.ts:52-76` 用 `execFile(process.execPath,[CLI,'--json'])`；当前树 3 passed；干净克隆 `7307d7d` + 新测试 = **2 failed \| 1 passed**，退出码 1 |
| 基线数字来自默认命令运行，不得是 `--experimental-transform-types` 结果 | **passed** | `--baseline` 重跑生成的行与提交报告逐字节相同；与自己那次 `--json` 原始 JSON 在 3 位小数上一致；§1.1 改动清单与实时 `git status` 完全一致；仓库无任何 `--experimental-*` 用于该入口 |
| CI 新增步骤存在且命令为 `node scripts/eval-jitrl.mjs --json` | **passed** | `.github/workflows/ci.yml:48-49`，位于 Typecheck 之后，原 7 步保留 |

**verdict = pass**（Gate 0 中属于 PR1 的部分：默认 CLI 可运行、入口级 smoke 有判别力、基线可复现且诚实分层）。PR1-L1/L2/L3 为 low 观察项，不构成“证据不足仍强称收益”，故不触发 needs_revision。

**本轮未做的事（边界声明）：** 未运行完整 `pnpm test`/`pnpm run typecheck`/`pnpm run check:docs`/`pnpm run build`（Gate 0 的整体回归由其他任务/后续轮次覆盖；且本工作树同时承载其他并行 PR 的未提交 `src/**`、`tests/**` 改动，单点全量跑无法归因）。本次结论只针对 PR1 的用户入口、回归判别力、基线真实性与 CI 门禁。
