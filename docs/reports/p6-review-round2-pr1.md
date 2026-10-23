# PR1 评审（第 2 轮）— t17 修复后的当前字节复评

| 项 | 值 |
| :-- | :-- |
| 被评任务 | t17「PR1 收尾修复：eval 缓存目录可移植性（L1）与缓存裁剪顺序（L2）」 |
| 评审任务 | t20（attempt `4bd9a852-b2f7-4633-838d-cef409590e00`） |
| 评审人 | gate-reviewer |
| 被评字节 | `scripts/eval/build-eval.mjs` = **ddb64bdf**、`tests/e2e/eval-cli.smoke.test.ts` = **8875679f**（与轮次前提一致；上轮为 140e3fa9 / 5818bed8） |
| 环境 | `7307d7d` + 共享工作树；Node `v22.23.1` |
| 结论 | **pass** — PR1-L1 与 PR1-L2 在**当前字节**下均真实关闭，默认入口/CI/基线结论未回退；无阻塞项 |

评审方式：只读代码 + 评审人自行运行；除 `docs/reports/` 外未改仓库文件。探针与临时缓存写在 `%TEMP%`（评审后已清理）。

---

## 1. 默认入口（不得引用被评者自述）

```
$ node scripts/eval-jitrl.mjs --json
EXIT=0   ELAPSED_MS=5430   STDOUT_BYTES=312147   STDERR_BYTES=0
episodes=5 metrics=13 totalMs=5060.9
B0:0.569/0.569  B1:0.889/0.889  B2:0.889/0.889  B3:0.956/0.972
四类泄漏合计=0
```

默认缓存目录仍为 `node_modules/.cache/dsh-plugin-evo-harness/`，评审开始时的内容为 `jitrl-eval-lib.f3fb35115a6b6c4bd196.mjs`(3,473,436) + `last-build.json`（后者只在直接运行 `node scripts/eval/build-eval.mjs` 时由 `writeStamp()` 写入；§4 的冷缓存测试删除了整个目录、由 CLI 重建，故评审结束时只剩产物文件——属正常，`loadEvalLib()` 不写 stamp）。

`pnpm exec vitest run tests/e2e/eval-cli.smoke.test.ts` → **Test Files 1 passed；Tests 6 passed (6)**，退出码 0（9,927ms；其中 L1 子进程用例 4,383ms）。

---

## 2. PR1-L1：缓存目录可移植性（真实关闭）

**评审人冷构建取证**（空目录、仓库 `node_modules` 之外）：

```
$ DSH_EVAL_CACHE_DIR=%TEMP%\t20-l1 node scripts/eval-jitrl.mjs --json
L1_OUTSIDE_EXIT=0   ELAPSED_MS=4827   STDOUT_BYTES=312153   STDERR_BYTES=0
stderr 为空（无 ERR_MODULE_NOT_FOUND）；JSON 可解析：episodes=5 metrics=13 B0=0.569
产物：jitrl-eval-lib.43019e46640b998a2baa.mjs  3,611,216 bytes
```

**修法是「按缓存位置切换打包策略」，不是改文案**（代码 + 字节双重证据）：

- 代码：`build-eval.mjs:88-95` `isInsideRepositoryNodeModules()`（Windows 大小写不敏感、带尾分隔符前缀判定）；`:114-116` `bundlingMode()` → 树内 `'external'`／树外 `'self-contained'`；`:278` `packages: mode === 'external' ? 'external' : 'bundle'`；`:249-250` `mode` 参与 `fingerprint()`（`:149-166` 的 `hash.update('mode\0'…)`）。
- 字节：对两种产物做「是否存在活着的裸导入」检查（评审人脚本 `%TEMP%\t20-mode-check.mjs`）：

```
=== self-contained (outside node_modules) ===
bytes=3611188
live bare import of @deepseek-ai/schemastery = false
  occurrence #1: … // node_modules/.pnpm/@deepseek-ai+schemastery@3.18.4/…/lib/index.mjs   ← 内联后的路径注释
  occurrence #2: … var SCHEMASTERY_PACKAGE = "@deepseek-ai/schemastery"                    ← 无关字符串常量
=== external (default node_modules cache) ===
bytes=3473408
live bare import of @deepseek-ai/schemastery = true
  occurrence #1: … import z from "@deepseek-ai/schemastery";                               ← 依赖保持外部
```

即：树外产物**确实把 npm 依赖内联**（`packages:'bundle'`），因此不再依赖解析根；默认路径仍是 external、大小与 t9 记录的 3,473,436 bytes 一致。两种模式的 digest 不同（`43019e46…` vs `f3fb3511…`），不会互相命中。

---

## 3. PR1-L2：裁剪顺序（真实关闭，删除的是最旧）

评审人自写探针（`%TEMP%\t20-l2-probe.mjs`）：新建空缓存目录 → 造 13 个不同指纹产物 `prime.00…prime.12`，mtime 严格递增（`now-100min` 起、每分钟一个；均 > `QUIET_AGE_MS`(5min) 且 < `PRUNE_AGE_MS`(24h)）→ 调真实 `buildEvalLib({name:'prime', cacheDir})` 触发 prune：

```
BEFORE (oldest first): prime.00.mjs@100min prime.01.mjs@99min prime.02.mjs@98min … prime.12.mjs@88min
keep=prime.43019e46640b998a2baa.mjs built=true mode=self-contained
AFTER  (oldest first): prime.02.mjs@98min prime.03.mjs@97min … prime.11.mjs@89min prime.12.mjs@88min keep@0min
DELETED: prime.00.mjs@100min prime.01.mjs@99min
SURVIVING_SPARES=11
```

**被删的是最旧的两个（prime.00/prime.01），最新者 prime.12 存活**，与代码一致：`build-eval.mjs:211` 按 `ageMs` 降序（index 0 = 最旧），`:217` `overCap = candidates.length > MAX_ARTIFACTS - 1 && index < candidates.length - (MAX_ARTIFACTS - 1)`，13 个候选时只命中 index 0/1，即从数组**前端**删除；年龄护栏（`:214,:218`）保留。上轮"删最年轻"的方向已被纠正。

---

## 4. 默认路径与 CI 未变

- CI：`.github/workflows/ci.yml` 步骤与第 1 轮逐字相同 —— `- name: Run default eval CLI` / `run: node scripts/eval-jitrl.mjs --json`（无 pnpm wrapper、无隐藏 flag）。
- 冷缓存（删掉整个 `node_modules/.cache/dsh-plugin-evo-harness/` 后首次运行）：

```
before: jitrl-eval-lib.f3fb35115a6b6c4bd196.mjs(3473436)
COLD_DEFAULT_EXIT=0  STDOUT_BYTES=312153  STDERR_BYTES=0
after:  jitrl-eval-lib.f3fb35115a6b6c4bd196.mjs(3473436)   ← 默认路径重新构建为 external，大小不变
```

---

## 5. t9 的基线真实性结论在当前字节下仍成立

```
$ node scripts/eval-jitrl.mjs --baseline %TEMP%\t20-baseline.md
command: node scripts/eval-jitrl.mjs --json (exit 0)
gates: G0.1=PASS G0.2=PASS G0.3=PASS G0.4=PASS G0.5=PASS G0.6=PASS   BASELINE_EXIT=0
```

- 14 行（G0.1–G0.6 + B0–B3 指标行 + 4 行安全表）与提交的 `docs/reports/p6-eval-baseline.md` 用 `Compare-Object` 比对 → **ROWS_IDENTICAL**（B0 0.569/0.569、B1 0.889/0.889、B2 0.889/0.889、B3 0.956/0.972）。
- 报告 §1.1 的改动清单与实时 `git status --porcelain` 归一化后 **21 条完全一致**。
- 评测数字本身也与我本轮独立跑的默认命令一致（§1：B0–B3 四位小数落点相同）。

---

## 6. 越界自查（t17 是否只动了两文件）

- `scripts/eval/jitrl-eval-lib.ts`：`git diff --stat` 空、mtime `10:41:35`（远早于 t17 窗口）——未改动。
- `scripts/eval-jitrl.mjs`：mtime `21:01:38`、diff stat 371 行（与第 1 轮所见一致）；`ci.yml` 20:38:47、`package.json` 21:00:31。
- 其余 git 报为 modified 的 `src/**`、`tests/unit/**` 文件 mtime 全部 **≤ 21:18:10**，而 t17 的两个文件为 **21:28:14 / 21:30:27** → 时间线上 t17 窗口内只写了这两个文件（`git status` 也确认它们是本迭代新增的未跟踪文件）。
- 两文件 sha256 前缀 `ddb64bdf` / `8875679f` 与调度器给出的轮次前提一致。

---

## 7. 验收清单

| 验收项 | 结果 | 证据 |
| :-- | :-- | :-- |
| 本人执行默认命令并贴真实退出码，确认未被 L1/L2 破坏 | **passed** | §1：EXIT=0、312,147B JSON、stderr 0、13 条件 |
| L1：树外目录清空后冷构建 + 默认命令 exit 0 且产物可加载（不再 ERR_MODULE_NOT_FOUND） | **passed** | §2：EXIT=0、4,827ms、stderr 空、JSON 可解析、产物 3,611,216B |
| L1：修法确为「按缓存位置切换打包策略」而非改文案 | **passed** | §2：代码 mode 判定 + `packages` 切换 + mode 入指纹；树外产物无活裸导入、默认产物有 |
| L2：超过 MAX_ARTIFACTS=12 时删最旧而非最年轻，贴删除顺序证据 | **passed** | §3：DELETED = prime.00/prime.01（最旧两个），prime.12（最新）存活，存活 11 |
| 默认路径行为与 CI 步骤未变，冷缓存首次运行仍 exit 0 | **passed** | §4：CI 步骤逐字相同；删缓存后 EXIT=0 且产物重建为 external 3,473,436B |
| 重跑 `--baseline` 与提交报告的 G0.*/B0–B3/安全行比对 | **passed** | §5：六门禁全 PASS、14 行 ROWS_IDENTICAL、改动清单一致 |
| t17 未越界改 `src/**` 或 `scripts/eval/jitrl-eval-lib.ts`；smoke 套件全绿 | **passed** | §6：lib 未改、mtime 时间线只覆盖两文件；§1：6/6 通过 |

---

## 8. 非阻塞观察（无需返工）

- 因为 `mode` 进入指纹，默认路径产物的 digest 由第 1 轮的 `ff9bc5ba…` 变为 `f3fb3511…`（同源同配置、字节数相同）。第 1 轮遗留的旧文件只能靠 `PRUNE_AGE_MS`(>24h) 清掉——一次性、无害。
- L1 子进程用例断言 exit 0 + 无 `ERR_MODULE_NOT_FOUND`，本身是「模式无关」的；真正区分 external 的是第三条用例（默认目录 `result.mode === 'external'`）。两条合起来足以锁定开关行为，故不构成 finding。
- 树外自包含产物约 3.61MB（比 external 大 ~0.14MB），仅非默认路径付出，注释已写明取舍。

## 9. 边界声明

- 未跑全量 `pnpm test`/`typecheck`/`build`（共享工作树含其他 PR 未提交改动，无法归因）；本轮定向跑 smoke 套件 6 用例。
- 未接真实 DSH 宿主/MCP；结论限于评测 CLI、缓存与基线报告面。
- 未修改 `src/**`、`scripts/**`、`tests/**`；临时探针与临时缓存目录已清理。
