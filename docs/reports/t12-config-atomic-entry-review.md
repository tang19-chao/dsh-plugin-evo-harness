# t12 — 配置原子入口修复独立审核（round 1）

- **被审对象**：t4（`src/index.ts` 配置入口原子修复）+ 其新增测试 + t9 验证证据
- **审核人**：architect-reviewer（独立于实现者与验证者；本报告只新增 `docs/reports/t12-config-atomic-entry-review.md`，未改动任何实现路径）
- **契约**：ADR 0005 决定 D3（§3.1–§3.7）
- **结论**：**verdict = PASS**（两项验收全部核实；3 条 info 观察，均不阻塞）
- **日期**：2026-10-29；基线 HEAD `722625c`（P1 改动在工作树未提交）

---

## 1. 审核方法（独立重放，非采信自述）

1. **逐行读 `src/index.ts` diff**：把 t4 的 hunk（`OPTION_KEYS` 26 键 + 三个编译期 witness + `normalizePluginOptions` 重写 + `route.reasoningEffort` 类型收紧）与 t7 的 hunk（状态/可观测性接线、route 运行期校验）区分开，确认 t4 的部分在 t7 之后**未被回退或弱化**。
2. **自建运行时探针**（`work/_t12_review/probe.mjs`，**47/47**）：用 esbuild 从**当前工作树**打包真实入口，独立于作者测试，覆盖 OPTION_KEYS 形状、C-0…C-12 反例、26 键逐个可达、裸 config / 裸 modelRoute 回归、apply() 的 ctx.config 行为、混合拒绝、非对象拒绝、运行期 effort 拒绝、`''`/`null` absent-like 归一。
3. **自建编译期探针**（`work/_t12_review/compile-check.mjs`，**9/9**）：把 `src/` **复制**到 work/ 下（真实树零改动），对副本做 5 个方向的变异并用项目同款 tsconfig 跑 tsc：删键 / 加外键 / 重复键 / 把 `reasoningEffort` 放宽回 `string` / 类型使用探针（`'ultra'`、`'MAX'` 必须报错）——验证 witness 与类型收紧**承重**。
4. **独立复跑**：真实树 `tsc --noEmit` exit 0；t4 专属套件 + `jitrl-config` + `plugin-entry` e2e = 3 文件 75 用例全绿；**全量 Vitest 103 文件 / 2092 用例全绿**（63s，我本人跑，不是引用 t7/t9）。
5. **下游可达性核对**：对 t4 修复的 10 个"旧白名单漏掉"的选项逐个 grep 其在入口中的实际消费点（不是只被 normalizer 接收）。
6. **实现细节核对**：`asRecord`（拒绝 null/数组/非对象）、`PluginOptionsShapeError`（code/offendingKeys/不回显值）、`assertModelRouteEffort`（`MODEL_ROUTE_EFFORTS` 单一来源，undefined/null/`''` 放行、枚举外抛错）、witness 的 `NeverBoth`/`IdenticalUnion` 逻辑。

---

## 2. 验收逐项核实

### 2.1 "类型穷举、不相交、混合拒绝和 ctx.config 保留原子成立，所有反例有测试" — **passed**

**类型穷举（编译期，变异实证）**——对 `src/` 副本逐条变异，tsc 全部按预期转红：

| 变异 | 结果 |
| --- | --- |
| 从 `OPTION_KEYS` 删除 `'scopeRegistry'` | **TS2322 `Type 'true' is not assignable to type 'never'`**（MissingOptionKey 非 never）且计数 witness 同时红 |
| 加入接口不存在的 `'notAnOption'` | **TS2322**（ForeignOptionKey 非 never）+ 计数红 |
| 重复 `'model'`（长度 27） | **TS2322**（26 键计数 witness 承重——这是穷举 witness 抓不到的唯一形态） |
| 把 `route.reasoningEffort` 放宽回 `string` | **TS2322**（`IdenticalUnion` 枚举一致性 witness） |
| 类型使用探针 `{ route: { reasoningEffort: 'ultra' } }` | **TS2322**（不在枚举内，编译期拒绝） |
| 类型使用探针 `{ reasoningEffort: 'MAX' }` | **TS2820**（大小写敏感，编译期拒绝） |
| 类型使用探针 `'max'` / 缺省 | 通过 |
| 副本恢复后 | 重新 exit 0；**真实 `src/index.ts` 全程未被触碰**（本审核只在副本上变异） |

**不相交（OPTION_KEYS ∩ (ROOT_KEYS ∪ {modelRoute}) = ∅）**：我的探针实测 26 键与 `DEFAULT_EVO_HARNESS_CONFIG` 的 10 个根键交集为空、`modelRoute` 不在 OPTION_KEYS；作者测试另有**行为化**证明——把 26 个选项键逐个当配置 section 交给冻结校验器，全部得到 `unknown_key`（不是靠另一份手写清单自证）。✓

**混合拒绝（C-4…C-8 实测）**：

| 调用 | 结果 |
| --- | --- |
| `{config, enabled:false}` | `plugin-options-mixed-shape`，`offendingKeys=['enabled']`，**apply 抛错不挂载** |
| `{config, execution:{mode:'off'}}` | 同上（`execution`） |
| `{config, jitrl:{enabled:false}}` | 同上（`jitrl`） |
| `{model, triggerMode:'always'}` | 同上（`triggerMode`；修复前是**静默丢弃**） |
| `{deps:{}, enabled:false}` | 同上（`enabled`；修复前会**静默照常挂载**，安全开关被吞） |

**ctx.config 保留（原子）**：

| 场景 | 结果 |
| --- | --- |
| `apply(ctx,{})`（ctx: mode off / jitrl off） | **mode=off、jitrl=false**（修复前 shadow/true —— 空对象伪造 `{config:{}}` 吞掉 ctx.config） |
| `apply(ctx)` | off/false（回归保持） |
| `apply(ctx,{config:{}})` | shadow/true（**合法的显式清空**，与 C-1 可区分） |
| `apply(ctx,{config:X})` | X 生效（修复前单键 `{config}` 会被二次嵌套成 `{config:{config:X}}` 而抛错） |
| `apply(ctx,{config:X, model})` | 选项形态，X 生效（现有 e2e 形状保持） |
| `apply(ctx,{})` 时 ctx.config 为**非法**值 | 仍由冻结校验器响亮拒绝（无变化） |

**所有反例有测试**：`tests/unit/config/plugin-options-shape.test.ts` 27 用例覆盖 C-1…C-12（含 C-2/C-3b/C-8b/C-8c/C-9b 补充），我逐条阅读其断言（真实 `apply()`/`normalizePluginOptions`/`validateEvoHarnessConfig`，无 vacuous 断言）；套件 27/27、全量 2092/2092 全绿。

### 2.2 "公开入口可达且不改变裸 config 合法路径，无静默安全降级" — **passed**

| 检查 | 结果 |
| --- | --- |
| 26 键逐个经 normalizer | 全部保持选项形态、`config` 不出现（我的探针逐键验证；修复前 11 键被误判为 section） |
| 10 个"旧白名单漏掉"的键**真实可达**（不是只被接收） | `dualTrack` 2 处消费、`persistence` 5、`experienceFilePath` 2、`backfillFromTreePool` 1、`agentLoop` 1、`resolveDshCollaborators` 2、`enableIdleDream` 1、`dream` 2、`scopeRegistry` 4、`route` 5（`options.<key>` 引用数） |
| 裸 config section（`{schemaVersion, enabled, triggerMode, jitrl, execution}`） | 仍走配置形态并生效（探针 + C-8b + 回归用例） |
| 裸 `{modelRoute:{…}}` | 仍走配置形态；`max` 端到端到达 `plugin.modelRoute`；`ultra` 被 **`ModelRouteEffortError` 具名拒绝**（非静默回退） |
| 纯配置 + 无选项键 | 配置形态（回归用例） |
| e2e 文档形状 `{config, model, clients, runBranch, now, newId}` | 原样工作（回归用例 + `plugin-entry` e2e） |
| 非对象（null/string/number/array/function） | `plugin-options-invalid-shape`，不静默吞 ctx.config |
| 拼写错 `{presistence}` | 走配置形态 → 冻结校验器 `unknown_key 'presistence'` 响亮拒绝（C-10） |
| 静默安全降级面 | 混合形态一律抛错；`{deps,enabled:false}` 不再挂载；`{}` 不再清空 host 配置；`config` 键缺失时 host 配置保留 |
| 错误载荷 | `PluginOptionsShapeError` 只回显类型名/键名，**不回显值**（C-12 用例 + 我的探针 'secret-payload-text' 不入消息） |
| 回归 | 全量 Vitest **103/2092 全绿**；`tsc --noEmit` exit 0 |

---

## 3. 实现审查要点（与 ADR §3 对照）

- **形态判定**（`normalizePluginOptions`）：`undefined`→ctx.config；非普通对象→`plugin-options-invalid-shape`；`{}`→`{}`；含 ≥1 选项键→选项形态（出现非选项键即 mixed 抛错）；否则→`{config: second}`。与 ADR §3.2 四条逐字一致。**判据是"键存在"而非"值 !== undefined"**，因此 `false`/`0`/`undefined` 值不会改变形态（比旧启发式更稳）。
- **witness 设计**：`NeverBoth`（双向穷举）、26 键计数（抓重复键）、`IdenticalUnion`（route effort 枚举精确一致）三者互补——我的变异矩阵证明三者各自承重。
- **错误类型**：`PluginOptionsShapeError{code,offendingKeys}`，`code` 是稳定字面量联合，便于宿主/测试分支；消息含冒犯键名与修复建议（"put the configuration section under the `config` key"）。
- **route effort**：类型侧 `EvoHarnessModelRouteEffort`（复用 `MODEL_ROUTE_EFFORTS` 单一来源）；运行期由 t5 的 `assertModelRouteEffort` 在宿主组与程序化 `options.route` 两条路径上拒绝枚举外值（t7 接线），`undefined/null/''` 视为 absent-like 回落默认——**没有静默改成默认值的分支**（enum 外值抛错）。
- **范围**：`src/index.ts` diff 中的状态/可观测性 hunk 属 t7 交付（与本审核的 t4 验收无关，但确认 t4 的键表/判定/witness 未被 t7 改动）；t4 未触碰 `src/config.ts`、`src/host-triggers.ts`、README、CI、package.json。
- **公共面**：新增导出 `OPTION_KEYS`、`PluginOptionsShapeError`、`PluginOptionsShapeErrorCode`、`EvoHarnessModelRouteEffort`——smoke-build 只做 required-exports 包含检查，不 pin 数量（t9 报 70 exports），无破坏。

---

## 4. 观察（info 级，不阻塞）

- **O1（info，注释时效）**：`tests/unit/config/plugin-options-shape.test.ts` 的 C-11 头注释仍写"运行期 effort 拒绝属于宿主组校验与状态接线 follow-up"。t7 已经接上：我实测 `apply({}, {modelRoute:{…,'ultra'}})` 与 `apply({}, {route:{reasoningEffort:'ultra'}})` 都抛 `ModelRouteEffortError`。行为正确，仅注释过时；建议 t16 顺手更新或在 t13 记录。
- **O2（info，边界未定义）**：`apply(ctx, {config: null})` 因 `options.config ?? contextConfig(ctx)` 把 `null` 当 absent，回落到 ctx.config。ADR 未规定 null 的语义（既非"显式清空"也非"非法"）；不构成安全降级（回落的是宿主配置），但建议后续在 ADR/文档中把 `{config:null}` 明确为 invalid-shape 或显式清空之一。
- **O3（info，维护性）**：`_OPTION_KEYS_COUNT` 的 `26` 是硬编码契约常量。这是 ADR 的刻意 pin（新增选项必须同步改常量并触发 tsc 失败），不是缺陷；仅提示后续 ADR 变更时要同时改断言与测试字面量。

**无 blocker / 无 high / 无 medium findings；验收两条均满足。**

---

## 5. 复现方式

```bash
# 1) 真实树类型与全量测试
.\node_modules\.bin\tsc.cmd --noEmit
pnpm exec vitest run            # 103 files / 2092 tests
# 2) t4 专属 + 相关入口套件
pnpm exec vitest run tests/unit/config/plugin-options-shape.test.ts tests/unit/config/jitrl-config.test.ts tests/e2e/plugin-entry.test.ts
# 3) 独立运行时探针（47 期望；esbuild 从工作树打包真实入口）
pnpm exec esbuild src/index.ts --bundle --format=esm --platform=node --outfile=work/_t12_idx.mjs
pnpm exec esbuild src/config.ts --bundle --format=esm --platform=node --outfile=work/_t12_cfg.mjs
node work/_t12_review/probe.mjs
# 4) 独立编译期 witness 变异（对 src 的副本，真实树零改动）
node work/_t12_review/compile-check.mjs
```
