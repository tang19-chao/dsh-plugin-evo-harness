# P6：Pareto 与预算钩子——交付报告（t11）

> 任务：`docs/reports/p2-p6-remaining-work.md` §7 P6 全部条目；队长 2026-10-29 裁定（t11 拆批、A 方案不新增 config 叶、文案替换整行不落地、负控制必须真红、成本轴整轴 fail-closed、还原证据要可复算）。
> 结论一句话：**机制就绪，默认全关（mechanism-ready, off by default），且生产宿主路径本轮完全不经过它。**

| 项 | 值 |
| --- | --- |
| 交付时点 | 2026-10-29 12:40（Asia/Shanghai） |
| 基线 | 工作树基线 `feb8465ded73ca48a770054c587990b93f54e21e` + P2–P6 各任务在制改动（共享工作树） |
| 本任务改动 | `src/jitrl/jit-active-policy.ts`（P6 段，+~330 行）、`tests/unit/jitrl/p6-pareto-budget.test.ts`（新建，33 用例）、`docs/adr/0007-p6-pareto-budget-terminology-and-hooks.md`（新建，本报告）、本文件 |
| 未改动（有意） | `src/config.ts`、`README.md`、`src/jitrl/index.ts`、`src/jitrl/decision-kernel.ts`、`src/runtime/execution-profile.ts`、`docs/adr/0002-*.md`、`scripts/**` |
| 文件指纹 | 装饰器 `c9443123…`、ADR 0007 `47e67c7d…`、本套件 `5349f4a2…`（36 099 B）——见 §3.3 一条命令复核 |

---

## 1. 状态判定（verifier 会问的那一句）

**P6 现在的状态是"机制就绪但默认全关"（mechanism-ready, not in force）。**

判断依据（三条，缺一不可）：

1. **默认值**：`BudgetHookConfig` 只在装饰器构造选项 `JitActivePolicyOptions.budget` 出现时存在；缺省 `undefined` → `budgetGate()` 立刻返回 `undefined`，**不创建任何 gate / reminder 对象**（不是"创建后被下游过滤"），`metadata.jit` 里没有 `budget` 键。
2. **生产路径不经过它**：全仓唯一生产构造点是 `src/index.ts:1575`（`kernel.createJitActivePolicy({...})`），**本轮不传 `budget`**。因此宿主行为与 P6 之前逐字节一致（§3 的 pinned digest 就是这条的机械证据）。
3. **提醒开关自身默认 false**：`budget.reminder.enabled` 缺省 false；即便某构造者传了 `budget`，只要不开这个开关，也不会产生、发送或记录任何提醒。

所以：**不是"已生效"**；P6 本轮交付的是"可注入、可回滚、默认零副作用"的机制 + 术语裁定 + 判别测试。

---

## 2. 术语裁定落地（ADR 0007）

ADR：`docs/adr/0007-p6-pareto-budget-terminology-and-hooks.md`（44 条表项，含两处**可直接粘贴的替换整行**）。

### 2.1 漂移的准确锚点（本轮只登记，不落盘）

| # | 位置 | 现文案 | 实现实际判据 |
| --- | --- | --- | --- |
| D-1 | `docs/adr/0002` §R2 publish 行（第 51 行） | "holdout **非劣证据** + 显式授权 + 匹配 artifact" | `decideReplayPublication` 先要求 `improved = hypervolume > baseline + ε`（`src/jitrl/decision-kernel.ts:1778/1799`），再要求 `validatedOnHoldout === true`（`:1816`–`:1833`）；后者由 `holdoutHypervolume > holdoutBaselineHypervolume + ε`（`src/dream-rsi/offline-dreamer.ts:2334`）产生 |
| D-2 | `src/runtime/execution-profile.ts:121` | "holdout **non-inferiority** + explicit authorization + matching artifact" | 同上；`permissions.publish.allowed` 恒 false |

裁定：**只有"严格超越"是凭证**；"非劣"不是本仓任何机器可判定的凭证，只允许作为报告中的统计判读语言；严格超越蕴含非劣，反之不成立 ⇒ 把严格超越写成非劣是**放松门**。

### 2.2 未落地项（明确登记）

| 项 | 状态 | 原因 |
| --- | --- | --- |
| `docs/adr/0002` §R2 第 51 行替换 | **未落地（已裁定）** | 该文件在任何人写范围之外；改文案会使既有 ADR 链引用失效。替换整行见 ADR 0007 §4.1 |
| `src/runtime/execution-profile.ts:121` 替换 | **未落地（已裁定）** | 同上；替换整行见 ADR 0007 §4.2 |
| `src/index.ts:1575` 宿主可达接线 | **未落地（handoff）** | `src/index.ts` 属 p2-kernel 范围（已 idle）；且需配套配置叶（本轮裁定 A 不加）。整行补丁见 ADR 0007 §7.4 |

---

## 3. 默认配置下宿主行为不变（影子对照）

### 3.1 方法（先固化、再改动）

改动**之前**用同一夹具、同一注入时钟（`now: () => T0`）导出两份规范 JSON 摘要；改动**之后**重算并比对。夹具与判据都在测试里可复算（`tests/unit/jitrl/p6-pareto-budget.test.ts` → `ADR 0007 §8`）。

| 摘要 | 口径 | 改动前（HEAD 源） | 改动后（P6 源） | 判定 |
| --- | --- | --- | --- | --- |
| `SLOTS_DIGEST` | `sha256(JSON({width, policyId, round, slots}))`——宿主真正执行的面 | `a8c207ca083336b1a2828f88f428fa68a53a30ca37fad098157b3bcbdbbd16a1` | 同左 | **相等** |
| `DIAG_DIGEST` | `sha256(JSON(metadata.jit))`——观测面 | `f2c0737a844a6a3d007de0c78092fafb1afe8a0825dad98eb91cc840c63b647a` | 同左 | **相等** |
| `klToPrior` | 诊断标量 | `0.20179472901254605` | 同左 | **相等** |
| 槽位 | `slots` 的 kind 序列 | `["exploit","explore_domain","explore_invariant","explore_invariant"]` | 同左 | **相等** |

> 口径说明（避免误读）：不注入时钟时 `DIAG_DIGEST` 每次运行都会变（`now` 影响半衰期权重 → q 的末位浮点）。这是**夹具**的性质，不是实现不确定性；测试用注入时钟把它钉死。实测：同一进程连跑三次不注入时钟 → `SLOTS_DIGEST` 稳定、`DIAG_DIGEST` 三次不同（`b9e18979…`/`2b2f76e2…`/`03d7dc14…`），注入时钟后两次运行完全相同。

### 3.2 一条命令复算（不需要读本报告的叙述）

```bash
pnpm exec vitest run tests/unit/jitrl/p6-pareto-budget.test.ts -t "pinned default digest"
```

实测输出（exit 0）：

```text
P6 SLOTS_DIGEST=a8c207ca083336b1a2828f88f428fa68a53a30ca37fad098157b3bcbdbbd16a1
P6 DIAG_DIGEST=f2c0737a844a6a3d007de0c78092fafb1afe8a0825dad98eb91cc840c63b647a
Tests  1 passed
```

### 3.3 还原证据的第三方复核（pinned sha256）

两次"真红负控制"各做过一次临时文件变异并还原。为让 verifier **不依赖任何自述**，测试里有一条 pinned sha256 见证（与 p2-kernel 的 `pr4a-smoke-invariant.mjs` 同构：打印当前值 + pinned 值 + PASS/FAIL）：

```bash
pnpm exec vitest run tests/unit/jitrl/p6-pareto-budget.test.ts -t "pinned sha256"
```

实测输出（exit 0）：

```text
P6 SHA256 src/jitrl/jit-active-policy.ts=c94431235a0a90bc256bbfdac043a6c675a85fe566d2e4d91c1047fa13ff4266 PASS
P6 SHA256 docs/adr/0007-p6-pareto-budget-terminology-and-hooks.md=47e67c7dab9ddacaf1d505a7fea6fe9312ee9b38d52ea1097444e37ab089b289 PASS
```

| 文件 | sha256 | 说明 |
| --- | --- | --- |
| `src/jitrl/jit-active-policy.ts` | `c9443123…` | 变异前备份的哈希；两次变异均以此为还原源，实测`Get-FileHash` 与 pinned 相等 |
| `docs/adr/0007-*.md` | `47e67c7d…` | ADR 终稿 |
| `tests/unit/jitrl/p6-pareto-budget.test.ts` | `5349f4a2…`（36 099 B） | 本套件自身（不自我 pin，避免自指） |

> 维护约定：任何人**故意**修改这两个文件后，必须同步更新测试里的 pinned 常量；否则该用例会红——这正是"改动必须被看见"的机制。

---

## 4. holdout 不参与选择与过滤（含真红负例）

### 4.1 行为证据（4 条，全部在本套件 `ADR 0007 §5`）

| 用例 | 钉住的事实 | 关键断言 |
| --- | --- | --- |
| A. `a holdout-only winner is NOT selected (guarded), and IS selected by the removed guard` | 只在 holdout 上占优的候选**不被选中** | guarded：`improved=false`、`selectedPolicyId='pi-deep'`（基线）、`publication.publish=false`、`holdoutHypervolume === undefined`、`selectionTreeIds=['sel-1','sel-2']`、`holdoutTreeIds=['held-1','held-2']`；变异（`holdoutTreeCount=0`，即删掉防火墙）：`improved=true`、`selectedPolicyId='pi-wide'` ⇒ 候选的"胜利"只在消费 holdout 时存在 |
| B. `the generator must not even RECEIVE a holdout tree reference (fail-fast detector)` | 生成器**拿到引用**就失败（不是"读了不许用"） | 正常路径：生成器收到的池 `=['g-sel-1','g-sel-2']`、不含 `g-held-*`；变异路径（未过滤请求）：`Error: holdout leak: generator received g-held-1,g-held-2` |
| C. `when a winner exists, the holdout is replayed only for it and a holdout loss withholds publication` | holdout 只对**最终优胜者**回放一次；holdout 上未严格超越即拒绝发布 | `improved=true`、`selectedPolicyId='pi-deep'`、`holdoutHypervolume` 有值、`publication.publish=false` 且 reason 含 `held-out trees` |
| D. `the L1 decorator never consumes a holdout reference (canary getter is never read)` | L1 装饰器连"读一眼"都不允许 | 用 `get holdoutTrees() { throw }` 的 canary 选项构造装饰器：不抛错，且 `executionSurface` 与默认构造逐字节相同 |
| E. `the decorator source contains no holdout identifier at all (structural tripwire)` | 结构负例：装饰器**代码**（剥注释后）不含 `holdout` 标识符 | 源码扫描 0 命中 |

### 4.2 真红负控制实测（不是结构声明）

**负控制①（成本轴）**：把 `paretoFront()` 临时改成"剔掉不合格点再在子集上算前沿"：

```text
FAIL  ... > ONE estimated observation makes the WHOLE axis unavailable - never a filtered subset
AssertionError: expected true to be false
 ❯ tests/unit/jitrl/p6-pareto-budget.test.ts:344  expect(front.usable).toBe(false);
Test Files  1 failed (1) | Tests  1 failed | 31 skipped
[exit 1]
```

还原：`Copy-Item work/p6-src-backup.ts src/jitrl/jit-active-policy.ts` → `Get-FileHash` = `C9443123…`（与变异前一致，见 §3.3 pinned 复核）→ 套件回绿。

**负控制②（holdout 防火墙）**：把两处 `holdoutTreeCount: 2` 临时改成 `0`（即 pre-PR-4B 调用形状，"删掉防火墙"）：

```text
FAIL  ... > a holdout-only winner is NOT selected ...
AssertionError: expected true to be false   ❯ :702  expect(guarded.improved).toBe(false);
FAIL  ... > the generator must not even RECEIVE a holdout tree reference ...
Error: holdout leak: generator received g-held-1,g-held-2   ❯ :746
Test Files  1 failed (1) | Tests  2 failed | 30 skipped
[exit 1]
```

还原后：`Tests  33 passed (33)`（`pnpm exec vitest run tests/unit/jitrl/p6-pareto-budget.test.ts`，exit 0）。

**这两条负控制的判别力**：负控制①证明"整轴 fail-closed"不是同义反复（剔点实现会给出 `usable=true`）；负控制②证明防火墙断言不是空转（删掉 guard 后同一断言立刻红，且红的原因精确到"生成器收到了 holdout 引用"）。

---

## 5. 成本轴只用 measured（estimated 不得进入）

### 5.1 整轴不可用（不是剔点）

`paretoFront(observations)` 的实现（`src/jitrl/jit-active-policy.ts`，P6 段）：

```ts
if (rejected > 0) {
  return { usable: false, rejected, nondominated: [], dominated: [] };
}
```

- 只要 **1 条** 观测的 `costProvenance !== 'measured'`（或形状不可用：`probes` 非有限/负、`quality` 越界），整轴 `usable=false`、`rejected>0`、**两个数组都为空**，`BudgetGateResult` 不带 `pareto` 字段。
- 零观测同样 `usable=false`（空集不能做成本比较）。

### 5.2 判别用例（`ADR 0007 §6.2`，8 条）

| 用例 | 断言 |
| --- | --- |
| 全 measured 的三点集 | front=`['d']`、dominated=`['a','b','c']`（`d` 严格支配其余） |
| 1 条 estimated | `usable=false`、`rejected=1`、`nondominated=[]`；**并显式算出"剔点实现"会给出的答案** `['measured-1']`，断言两者不同（证明判别力，不是同义反复） |
| 1 条 unknown | 同 estimated |
| 零观测 | `usable=false`、`rejected=0`、两数组空 |
| 两轴相等 | 不构成支配（两条都留） |
| 一轴更好一轴更差 | 不构成支配（两条都留） |
| NaN probes / quality=1.5 | `rejected=2`（不合格形状不是"零成本探针"） |
| gate 字段白名单 | 只有 `tier/probeCeiling/observedProbes/withinTier/costAxisProvenance/costAxisRejected/pareto/reminder`；序列化后不含 `costMicros|usd|$|currency|price` |

### 5.3 cacheRead / prefix cache

无实测 `cacheRead` 观测 ⇒ **本轮不评估、不声明任何 prefix cache 影响**（ADR 0007 §6.3）。P3-C 的 `cacheReadUnavailable`、"unknown, not a measured zero" 语义不变；本任务未触碰计量层。

---

## 6. 预算档与只 ask 提醒

### 6.1 预算档（Lite/Medium/Heavy = 探针数预算，不是论文权重、不是货币）

```ts
export const BUDGET_TIERS = ['lite', 'medium', 'heavy'] as const;
export const BUDGET_TIER_PROBE_CEILINGS = Object.freeze({ lite: 2, medium: 4, heavy: 8 });
```

- 单位是`BatchPlan.width`（每轮探针槽数）；`BudgetReminder.unit` 固定 `'probes'`。
- 超档**只报告**：`withinTier=false` + （开关打开时）一条 ask；**不删槽、不缩宽、不拒绝**（用例：`over-tier is REPORTED, never denied: the plan width is untouched`；gate 序列化不含 `deny|denied|block`）。
- 未认档位在**构造期**抛 `TypeError`（fail-closed，不允许静默退化为"无预算"）。

### 6.2 提醒：独立开关、默认 false、只 ask

| 事实 | 证据 |
| --- | --- |
| 独立开关（不复用 guarded-active / patch / execution mode） | `BudgetHookConfig.reminder.enabled` 默认 false；用例 `the reminder switch is independent of the execution-mode switch`：interceptor on + reminder off ⇒ 无提醒；interceptor off + reminder on ⇒ 仍无提醒（gate 乘同一条拦截门） |
| 默认关闭 = **零对象** | `without a budget block there is no gate, no reminder object and no diagnostics key` 断言 `'budget' in diagnostics === false`；`switch off (default)` 断言 `'reminder' in gate === false`（不是 `{enabled:false}`） |
| 只 ask、不改计划 | `switch on + over tier`：提醒 1 条 `{kind:'budget-tier-exceeded', observedProbes:4, probeCeiling:2, tier:'lite', unit:'probes'}`，`executionSurface` 与默认构造逐字节相同、`plan.slots.length===4` |
| 回调抛错不能失败决策 | `a throwing sink cannot fail the decision`：计划照常返回、诊断保留提醒、`diagnostics()` 多一条 `budget_reminder …` |
| 回滚开关 | 删 `budget` 块（构造级）/ `reminder.enabled=false`（提醒级）；`runtime-off` 与 `interceptExecution=false` 两条路径实测：无 `metadata.jit`、无 gate、无回调 |

### 6.3 注入路径（A 方案）与最后一跳

- **唯一注入路径 = 装饰器构造者**：`JitRl.createJitActivePolicy(options)`（`src/jitrl/index.ts:441`–`:466`）用 `...policyOptions` 原样转发，因此 `options.budget` **不需要改 `src/jitrl/index.ts`** 就能到达装饰器——这不是"死开关"。
- **宿主可达的最后一跳**在 `src/index.ts:1575`（全仓唯一生产构造点）。**本轮不应用**，补丁（整行）：
  ```ts
  // src/index.ts:1575 起，wrapped 的构造对象里新增一行
  budget: config.jitrl.budget === undefined ? undefined : { ...config.jitrl.budget },
  ```
  配套配置叶（同样不应用；需与 README 行 + readme-default-leaves 计数 78→79/75→76 同一变更集）：
  ```ts
  // src/config.ts JitRlConfig 内新增（默认关闭）
  budget: { tier: 'medium', reminder: { enabled: false } },
  ```
- **接线后开关才对宿主可用**——本轮**没有**接线，因此没有任何宿主行为变化；不要把它读成"已对宿主开放"。

---

## 7. 门禁证据（命令 / 退出码 / 关键输出行）

| # | 命令 | 退出码 | 关键输出 | 归属 |
| --- | --- | --- | --- | --- |
| 1 | `pnpm run typecheck` | **0** | `$ tsc --noEmit` 无错误 | 本任务 |
| 2 | `pnpm exec vitest run tests/unit/jitrl/p6-pareto-budget.test.ts` | **0** | `Tests  33 passed (33)`；打印 `P6 SLOTS_DIGEST/DIAG_DIGEST/SHA256 … PASS` | 本任务 |
| 3 | `pnpm exec vitest run tests/unit/jitrl tests/unit/dream-rsi tests/unit/config` | **0** | `Test Files 43 passed (43)` / `Tests 1058 passed (1058)` | 本任务相关面 |
| 4 | `pnpm exec vitest run`（全量） | **1**（12:52 快照） | 带时间戳的三次观测：**12:28** `Test Files 1 failed, 126 passed (127)` / `Tests 4 failed, 2349 passed (2353)`——4 条全在 `tests/unit/eval/mutation-gate.test.ts`（M1 `anchor-not-found`）；**12:52** `Test Files 2 failed, 125 passed (127)` / `Tests 2 failed, 2352 passed (2354)`——2 条在 `tests/unit/jitrl/scope-registry-identity.test.ts` 与 `tests/unit/seams/mount-scope-isolation.test.ts`；**12:49:43 定点评测**（只跑这三个文件）`Test Files 3 passed (3)` / `Tests 48 passed (48)`，exit 0——即 12:28 与 12:52 的红在 p4 的在制改动落定后**全部回绿**。全程 6 条红均在 p4 的在制面上，本任务错误数 0 | **非本任务（时序快照，已回绿）** |
| 5 | `pnpm run check:encoding` | **0** | `[encoding-policy] SUCCESS: every tracked blob is LF text or an explicit -text exception`（333 blobs / 29 rules / 3 exceptions） | 本任务（新文件 LF，BOM 无） |
| 6 | `node scripts/verify-readme-counts.mjs --docs-only` | **0** | `Config reference coverage: 78 documented row(s) vs 78 expected`；`SUCCESS: documentation gate fully green` | 本任务（未加配置叶 ⇒ 78/78 不变） |
| 7 | `pnpm run check:docs`（全量） | **1** | 见 §7.2：gate 先拒绝"有失败测试的报告"，再叠加 README 计数漂移 | **非本任务**（详见 §7.2） |

### 7.1 全量套件红条目的五段式标注（12:28 首测 4 条；12:52 复测 2 条，均为 p4 在制面）

| 文件 | 行 | 错误码/错误 | 属主 | 本任务错误数 |
| --- | --- | --- | --- | --- |
| `tests/unit/eval/mutation-gate.test.ts` | 176 | `anchor-not-found`（M1：`delete the four provenance spreads from the mount base`） | **p4-isolation**（在制改 `src/cordis-seams/eight-surfaces.ts`，ADR 0006 D-P4-4） | **0** |
| `tests/unit/eval/mutation-gate.test.ts` | 211 | 同根因（`restore semantics`） | 同上 | **0** |
| `tests/unit/eval/mutation-gate.test.ts` | — | 同根因（`applies each mutant`） | 同上 | **0** |
| `tests/unit/eval/mutation-gate.test.ts` | — | 同根因（`is EOL-adaptive`） | 同上 | **0** |

> **时间戳与回绿确认（本条更正了本报告初稿的一处归因错误，见下方 §7.1 归因更正）**：12:52 复测时 mutation-gate 4 条已回绿（`tests/unit/eval/mutation-gate.test.ts` → `Tests 31 passed`）；**12:49:43–12:49:48** 我把三个文件一起跑：`tests/unit/jitrl/scope-registry-identity.test.ts` + `tests/unit/seams/mount-scope-isolation.test.ts` + `tests/unit/eval/mutation-gate.test.ts` → `Test Files 3 passed (3)` / `Tests 48 passed (48)`，exit 0。因此下表 6 条红全部是 **p4-isolation 编辑窗口内的时序快照**，现在已回绿；本任务错误数 0。

| 文件 | 行 | 错误码/错误 | 属主 | 本任务错误数 |
| --- | --- | --- | --- | --- |
| `tests/unit/jitrl/scope-registry-identity.test.ts` | 157 起 | `resolves a host dispatch to the recorded scope and never to a branch`（ADR 0006 D-P4-3） | p4-isolation（t7 在制） | **0** |
| `tests/unit/seams/mount-scope-isolation.test.ts` | 291 | `declares a class on every mount the production path creates (never legacy)`（ADR 0006） | p4-isolation（t7 在制） | **0** |

> **§7.1 归因更正（自我更正，必须留在报告里）**：本报告初稿把 12:28 的 `anchor-not-found` 归因为“`eight-surfaces.ts` 工作树是 CRLF”。**这个归因不成立，已撤回。** 复核证据：
>
> 1. `scripts/eval/mutation-gate.mjs:304`–`:318` 的 `anchorVariants()` **本来就是 EOL 自适应的**：它同时尝试 LF 与 CRLF 两种拼写（注释写明“a Windows checkout can legitimately hold CRLF worktree bytes”），`applyEdit()` 在文件自身 EOL 形态上匹配；
> 2. **12:50:13 实测**：`eight-surfaces.ts` 仍是 CRLF（`crlf true`，15 470 B），而 `node scripts/eval/mutation-gate.mjs --validate --json` 返回 `{"mode":"validate","ok":true,"problems":[]}`、exit 0 —— CRLF 本身**不会**造成锚点失配；
> 3. 我当初那条“LF 锚点出现 0 次”的检查用的是**手工拼接的 LF 字符串**，它当然匹配不上 CRLF 文本——那是检查方法无效，不是门禁行为。因此 12:28 的红只能归为**文件在 p4 编辑窗口内的半写入状态**（该文件当时正在被写，读到的是不一致内容），12:49 定点评测全绿与此一致。
>
> **经验（写给后来者）**：判断“锚点找不到”这一类红，不要用自己拼的 `indexOf` 去猜，直接跑门禁自带的只读校验器。

### 7.1.1 `check:mutation` 红的两种含义与自查命令（队长要求的可复现诊断）

`check:mutation` 的红有**两种语义完全相反**的来源，而它们都表现为“某个用例红了”。误读的方向是致命的：把“没跑成”读成“变异存活”会掩盖真缺陷，把“变异存活”读成“没跑成”会放过真缺陷。

| 红的样子 | 含义 | 处置 |
| --- | --- | --- |
| 校验阶段：`validateAnchors()` 报 `M1: <edit label> -> anchor-not-found` / `anchor-ambiguous` / `anchor-inert` | **源文件变了，变异根本没被应用**；本次运行的 `mustRed` 结果**没有任何意义**（不是“变异存活”） | 视为**无效运行**；先修锚点或确认改动是有意的（改锚点=改门禁语义，需授权） |
| 运行阶段：变异已 `applied`，但 `mustRed` 里某个用例没红（`killed:false` / “missing must-red …”） | **变异被应用了而测试没抓到**——这是真正的判别力缺口（gate 要防的东西） | 视为**真缺陷**，补测试或补锚点 |

自查命令（只读、不写仓库；实测输出附后）：

```bash
# 1) 只校验锚点：ok:false 就是“源动了”，此时不要解读任何 must-red 结论
node scripts/eval/mutation-gate.mjs --validate --json

# 2) 只跑一个变异：JSON 里看 applied + killed + 未红的用例名（真缺陷才在这里出现）
node scripts/eval/mutation-gate.mjs --run --only M1 --json

# 3) 换行符自查（工作树 EOL；check:encoding 只看 HEAD blob，看不见工作树 CRLF）
node -e "const fs=require('fs');const f='src/cordis-seams/eight-surfaces.ts';const t=fs.readFileSync(f,'utf8');console.log(f, t.includes('\r\n')?'CRLF':'LF')"

# 4) 空白错误自查（trailing whitespace / mixed EOL 的粗筛）
git diff --check
```

实测（12:50:13，`eight-surfaces.ts` 仍 CRLF）：

```text
crlf true lf-only false bytes 15470
{ "gate": "mutation-gate-v1", "mode": "validate", "ok": true, "problems": [] }
VALIDATE_EXIT=0
```

结论与建议：
- **CRLF 本身不是本仓的随机红来源**（门禁对锚点做了 EOL 自适应；`git diff --check` 与 `--validate` 现在都干净）。本轮 12:28 的红是编辑窗口内的半写入快照，不是环境风险；本报告不把“CRLF 会让 `check:mutation` 随机红”当成既有事实——**没有证据支持它，就不写它**。
- 真正需要防的是上表第二行（变异存活但没人红）。日常自查的最小纪律：**红先跑 `--validate --json`**；`ok:true` 才说明“这次运行算数”，再看 `--run` 的 `killed`。
- 若将来某个门禁改成按**原始工作树字节**比较（而不是 EOL 自适应），那才会引入 CRLF 风险；届时应把该门禁的输入固定为 LF（`.gitattributes` 已声明 `text eol=lf`，仓库侧无需新增文件）。

### 7.2 `check:docs` 红的两个原因

1. **前置拒绝**：gate 会先跑一次全量 vitest；12:28/12:52 的快照里存在 §7.1 的时序红，gate 按 ADR 0005 F-14 拒绝从"有失败测试的报告"生成计数（`numFailedTests > 0` ⇒ 直接 exit 1，且不打印 SUCCESS）。这不是计数问题，是**正确的 fail-closed**；那些红在 12:49 已回绿（§7.1），因此“全量跑绿之后 check:docs 是否只剩计数漂移”需在 p4 落定后复测一次才能定论。
2. **README 计数漂移**：README 当前声称 `103 files / 2094 tests`（unit 90/1935、e2e 13/159），实测全量为 `127 files / 2353 tests`。P2–P6 各任务的在制测试都还没汇总进 README——按团队约定由 **lead 收尾复测同步**（`docs/reports/p2-r-leftovers.md` 与 t1 输出同口径）。本任务新增 1 文件 / 33 用例，是这 24 文件 / 259 用例差额的一部分。

**本任务对 check:docs 的净贡献**：配置参考叶 0 增（`--docs-only` 78/78 绿）；测试计数 +1 文件/+33 用例（需 lead 同步 README 后转绿）。

---

## 8. 关于"在制测试文件让全仓 tsc 红"的机制建议（队长提问的 (a)/(b)/(c)）

**我的判断：取 (a)+(c)，并明确否决 (b)。**

- **(a) 先写 tsc 通过的最小骨架，再逐步填内容**：采纳。可执行到"每个 describe 块落地前先跑一次 `pnpm run typecheck`"，成本一次 `tsc`（本机 ~10s）。
- **(b) `*.wip.test.ts` 后缀 + verifier 排除**：**否决**。理由是它不隔离任何东西，只隔离了"看见"：vitest 的 include 是 `**/*.test.ts`（`vitest.config.ts` 只额外排除 `work/**`），`foo.wip.test.ts` **仍会被收集**、仍参与 `numTotalTests`/`numFailedTests` 计数、仍在 `check:docs` 的 `testResults` 里。所谓"verifier 排除"只能是在脚本里**主动跳过**这些文件——那等于把"没跑"写成"通过"，与清单"不把 CI skipped 当通过"是同一类错误，只是换了个更隐蔽的形式（一个后缀约定如果只改命名而不改收集规则，它唯一的作用就是给 verifier 一个跳过理由）。
- **(c) 统一五段式汇报**：采纳，并建议固定为 `文件 | 行 | 错误码 | 属主 | 本任务错误数`（本报告 §7.1 即按此格式）。它是唯一**不改变门禁语义**、又能让 lead 秒级判断"该找谁"的办法。

补充一条成本更低的工程手段（不改门禁）：把"在制文件"放在 `tests/**/*.test.ts` **之外**（如 `work/`，vitest 已排除），跑通后再 `git mv`/`Move-Item` 进 `tests/`——`work/**` 的排除是**收集规则本身**，不是 verifier 的跳过理由，因此不触碰"skipped 不算通过"的底线。若 lead 认可，可作为 (a) 的补充惯例。

---

## 9. 遗留风险与未执行（需授权）

| # | 项 | 状态 | 说明/授权申请文本 |
| --- | --- | --- | --- |
| R1 | ADR 0002 §R2 与 execution-profile.ts:121 的文案替换 | **未落地（已裁定）** | 替换整行见 ADR 0007 §4.1/§4.2；落盘需授权修改这两个文件（本轮不在任何人写范围） |
| R2 | `src/index.ts:1575` 宿主可达接线 + `src/config.ts` 预算叶 | **未执行（需授权/需串行）** | 补丁见 ADR 0007 §7.4；须与 README 行、`readme-default-leaves` 计数（78→79/75→76）同一变更集，避免与 t13 撞车。授权申请：请允许在 t13 落地后由单一 owner 提交"config 叶 + index.ts 一行 + README/计数"三件套 |
| R3 | 宿主侧 pre-step `additionalContexts` 通道接线 | **未执行（写范围外）** | 通道已由 `src/cordis-seams/dsh-hook-host-adapter.ts:1155`–`:1196` 提供（advisory 追加 / gate `{kind:'ask'}`）；P6 只生产 ask 载荷。需在 host adapter 侧加一次"消费 `BudgetReminder`"的接线，属 P4/宿主适配范围 |
| R4 | 真实宿主 smoke / 真实付费模型调用 / 真实记忆写入 | **未执行（需授权）** | 授权边界；本轮全部离线（无网络、无模型、无盘写；测试仅读自身源码做结构负例） |
| R5 | `cacheRead` / prefix cache 评估 | **未评估（无实测流）** | 只有实测 cacheRead 可用时才可评估（ADR 0007 §6.3） |
| R6 | 全量 `check:docs` 与全量套件的时序红 | **非本任务** | §7.1 的 6 条红已于 12:49 定点评测回绿（`3 files / 48 tests passed`）；**不需要** CRLF 修复（§7.1 更正：门禁 EOL 自适应，`--validate` 在 CRLF 工作树上仍 `ok:true`）。剩余：p4 落定后重跑一次全量确认，README 计数由 lead 收尾同步 |
| R7 | 成本观测的真实来源 | **未接线** | `costObservations` 需由调用方从 P3 账本 measured 桶组装；本轮只做"轴侧"的整轴 fail-closed，不伪造数据 |

---

## 10. 改动文件清单（本任务）

| 文件 | 类型 | 行数/大小 | sha256（前缀） |
| --- | --- | --- | --- |
| `src/jitrl/jit-active-policy.ts` | 修改（P6 段：预算档/成本轴/只 ask 提醒 + 诊断键 + 构造期校验） | +~330 行 | `c9443123` |
| `tests/unit/jitrl/p6-pareto-budget.test.ts` | 新建（33 用例） | 36 099 B | `5349f4a2` |
| `docs/adr/0007-p6-pareto-budget-terminology-and-hooks.md` | 新建（ADR 终稿） | — | `47e67c7d` |
| `docs/reports/p6-pareto-budget.md` | 新建（本报告） | — | — |

未改动（确认）：`src/config.ts`、`README.md`、`src/jitrl/index.ts`、`src/jitrl/decision-kernel.ts`、`src/runtime/execution-profile.ts`、`docs/adr/0002-*.md`、`scripts/**`、`src/dream-rsi/**`、`src/ledger/**`。
