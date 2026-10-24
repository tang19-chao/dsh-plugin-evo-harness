# P6.1-R1：F9/D1 严格默认 + 真实 provenance 链安全契约评审（round 1）

| 项 | 值 |
| :-- | :-- |
| 被评任务 | t2「P6.1-A1：F9 严格默认实现」＋ t3「P6.1-A2：真实 provenance 挂载链端到端测试 + 变异证据」（评审范围按 captain 指示含工作树全貌） |
| 评审任务 | t10（attempt `a63f0c95-071a-4a7e-a352-703497af8b46`，gate-reviewer） |
| reviewed SHA（HEAD） | `7bce33ee9d102a6a05a35f080f606a8fd388e114`（`git log -1`，基线 `7bce33e`；评审基于含未提交改动的**工作树**，非 HEAD 快照） |
| reviewed SHA（工作树 diff 指纹） | 报告落笔时 `git diff \| git hash-object --stdin` = `fd1b4d2fca01db08ce7a506ebe93f4958471c0fd`（评审期间在途任务 t6/t9/t15 仍在改动非 R1 面，见 §11 漂移声明） |
| R1 相关文件指纹（sha256 前 16） | `src/cordis-seams/dsh-hook-host-adapter.ts` `4C938EE057FE16E9`；`src/jitrl/host-tool-experience.ts` `D95372629F876A57`；`src/cordis-seams/eight-surfaces.ts` `423686FE4C38B4E6`；`tests/e2e/provenance-chain.test.ts` `A56BDD2AC376FB3C`；`tests/unit/cordis-seams/dsh-hook-host-adapter.test.ts` `E4DC72BFF50F2B07`；`README.md` `757D7D9DFA7071E4`（评审期间由 t2 快照被同步为落地计数，见 F1）；`src/index.ts` `D407AAD3EA05145A` |
| 结论 | **pass**（D1 行为、六面一致性、变异判别力、链路真实性全部成立；评审期间 F1/F2 两条中途发现均已在落地字节中关闭）。三道门禁在最终字节上全绿：`typecheck` exit 0、`pnpm test` 72 files / 1387 tests exit 0、`pnpm run check:docs` exit 0。 |

**方法**：只读代码 + 自建隔离副本独立重放变异。所有变异都在 `%TEMP%\p61-r1-copy`（`node_modules` 以 junction 指向仓库）内完成，**未触碰仓库 `src/**`、`tests/**`、`scripts/**`**。副本与仓库的 `src`+`tests` 全文件 sha256 对比在变异前/后均为 **diff 0**；变异恢复后副本全量 `72 files / 1387 tests` 全绿。

---

## 1. 独立变异重放（不信交付说明，我自己重做）

| 变异 | 我实际做的编辑（隔离副本） | 我实测的结果 | 与交付声明 |
| :-- | :-- | :-- | :-- |
| **M1** | 删除 `src/cordis-seams/eight-surfaces.ts::mountSurface` 中 `base` 对 `origin/guidance/role/allowAdvice` 的 4 行展开（370→366 行） | `tests/e2e/provenance-chain.test.ts`：**4 failed / 2 passed (6)**，红的正是 scenario **1、2、5、6**；scenario 3、4 保持绿 | 与声明**完全一致** |
| **M2** | 删除 `src/jitrl/host-tool-experience.ts::observeToolCall` 的 `if (!scopeInfo.isKnown) { … }` 拒绝块（1076 字符） | e2e：**1 failed / 5 passed**，红的正是 **scenario 4**；同变异下 `tests/unit/jitrl/host-tool-experience.test.ts`：**4 failed / 14 passed**（含「D1 strict default: unproven branches and identity-free observations stay out of every learnable track」与「D1: trusted registry registration is what re-enables learning for a scope」） | 与声明**完全一致**（声明只说 scenario 4 红；单元层另有 4 条同时红） |

**并复核了实现者披露的通用陷阱**（我按同一 M1 只跑 scenario 2 并抓断言）：

```
→ expected 'failed' to be 'succeeded' // Object.is equality
Expected: "succeeded"
385|       expect(phaseA.status).toBe('succeeded');
```

即：M1 下 executor 内的断言确实被 `runInIsolatedBranch` 的 branch error boundary 吞成 `trajectory.status='failed'`，**真正把红暴露出来的是显式的 `expect(phaseA.status)`**（scenario 1 有 `:318`，scenario 2 的 phase A/B 有 `:385`/`:432`）。因此这两条端到端测试具备判别力，不是"假绿"。

副本基线（未变异）：`6 passed (6)`；恢复后副本全量 `72 files / 1387 tests` 全绿、与仓库逐文件 sha256 diff 0。

---

## 2. D1 行为核实（三种未知身份 + 恢复路径）

代码事实：`advisorInScope()`（`dsh-hook-host-adapter.ts:869-920`）第 4 步改为 `scopeUnknownSkipped += 1; return false;`，删除了基线中"匿名带工具名即放行"与"有 sessionId 即放行"的分支；collector（`host-tool-experience.ts:475-488`）对 `!scopeInfo.isKnown` 直接 `return`（无注册表时缺 session 或缺 branch 同样走 468 行注释所说的严格默认），并删除"借用 `unknown` bucket"的旧路径。

| 身份形态 | 实测（真实链路，scenario 4；并经 M2 反证判别力） | 契约表（ADR §2.2） |
| :-- | :-- | :-- |
| 匿名 `{}` / `{name:'bash'}` | 不注入 advice（`additionalContexts` undefined）、`pre-execute` → `{kind:'allow'}`、`post-execute` 后 `records.length` 不变 | 第 4 行 ✓ |
| 仅 sessionId（`{sessionId:'sess-chain-4-only'}`） | 同上，且 `scopeUnknownSkipped` 由 2 增至 3 | 第 5 行 ✓ |
| 有 branchId 但未登记 | 同上，计数 +1 | 第 3 行 ✓ |
| rogue payload 自称 `role:'invariant'`/`allowAdvice:false`/`guidance:'memory'` | 自报字段不被提升为授权：不注入、不学习 | §2.3/§2.5 ✓ |
| 受信登记（`registry.register({sessionId,branchId,role:'domain',guidance:'memory',allowAdvice:true})`）后同一身份 | advice 回来（`['CHAIN_ADVICE_MARKER']`）、`evaluate` 调用 1 次、工具样本落地且 `sessionId/branchId/scopeKey` 精确归属（scenario 2 phase B；单测「trusted registry registration is what re-enables learning」） | 第 1 行 ✓ |
| 挂载 dispose 后同一身份 | advice 再次消失、无残留（scenario 2 尾段、scenario 5） | ✓ |

**执行透传**：`preExecute({name:'bash'})` 在三种未知身份下都返回 `{kind:'allow'}`，`stats().deniedToolCalls` 保持 0；adapter 单测另断言 gate 模式下匿名 dispatch **不触发额外 ask**（`gateEvaluate` 未被调用）。不存在 auto-deny/auto-ask ✓。

---

## 3. 六面一致性（按 ADR §2.6 清单逐面）

| 修改面 | 结果 | 证据 |
| :-- | :-- | :-- |
| 代码 | ✓ | 匿名放行分支已删除（§2 代码事实）；collector 不再写 `sessionId:'unknown'`/`branchId:'unknown'` 的可学习样本 |
| 注释 | ✓ | `grep 'Option 2' src/**/*.ts tests/**/*.ts` = **0 命中**（仅 ADR §2.4 保留"为什么不用 Option 2"的裁定记录，属应有内容）；adapter 注释明确"mount 匹配仍 host-local fail-open，但 advice/learning 走 D1 严格默认"（`:30`、`:266`、`:373`） |
| 测试名称与断言 | ✓ | 旧名「…(Option 2 / F9)」已删除并替换为「D1 strict default: …」（`host-tool-experience.test.ts`、`dsh-hook-host-adapter.test.ts`）；新增匿名/gate/仅 sessionId 三条断言（含 `scopeUnknownSkipped` 与 `deniedToolCalls` 计数） |
| README | ✓ | D1 段落明写"identity is proven, not assumed"、三种未证明身份零 advice/零学习、普通执行透传、只计数 `scope_unknown_skipped`（payload free）、**无 `allowAnonymous` 开关**；无"匿名可获得 advice"表述 |
| 状态诊断 | ✓ | `scope_unknown_skipped` 只写 `'scope_unknown_skipped: <n> (identity-free host-tool observation not collected; no payload stored)'`（`host-tool-experience.ts:481-486`）与 adapter `/` 计数器；诊断串不含工具参数或正文 |
| Gate 4 能力清单 | ✓（文档面，属 t9/t13） | 仓库 `src/**` 中不存在 `HostCapabilityManifest` 符号（grep 0 命中），故该行是 ADR §2.5/§2.6 的 Gate 4 **文档清单**项：host-session scope 登记作为显式兼容路径列入清单，由 P6.1-F/t13 在状态表中承接；本轮未新增默认开启开关 |

**评审中途发现、已被 t15 修复的残留**：`src/index.ts:1845` 处 attach 诊断串原先仍输出 `', host-local'`（ADR §2.6「状态诊断」面）。我在评审中段抓到该残留并准备记为 finding；评审期间 t15（P6.1-A1b）落地，现在 `src/index.ts:1877` 已改为
`', registry-resolved scope (D1 strict default: unprovable identities get no advice or learning)'`，同时把 mirror 意外抛出路径的自由文本（`index.ts:1975` 旧写法）改为 `describeThrownClass(error)` 有界类。故 **当前字节不存在仍描述 Option 2 行为的残留**（F2 记录为 resolved）。

---

## 4. provenance 链真实性（没有绕过上游）

| 检查 | 结果 |
| :-- | :-- |
| 测试是否手工 `registry.register(...)` 替代链路 | **没有**。`tests/e2e/provenance-chain.test.ts` 全文件无 `register(` 调用；`role/allowAdvice/isInvariant/guidance` 只出现在 (a) patch 的 provenance 字段、(b) `scopeRegistry.get()` 的**断言**读取、(c) scenario 4 的 rogue payload（故意自称，用于验证被拒绝）。`role:'candidate'` 是 `runInIsolatedBranch` 的执行角色参数，不是注册。 |
| provenance 如何进入 registry | 真实链：`patch.origin/guidance` → `CordisSeamManager.runInIsolatedBranch`/`applyPermanentPatch` → `mountEightSurfaces` → `mountSurface` 的共享 `base`（`eight-surfaces.ts:191-200`，M1 即打这里）→ adapter mount spec → `ScopeRegistry`；非 hook 面（memory/skills）经同一 `base` 落到 fallback host，scenario 5 直接断言 `memorySpec.role/allowAdvice/origin/guidance`。 |
| 6 场景覆盖 | ✓ scenario 1 中性名 invariant 隔离；2 同 branchId provenance 翻转（含完整 dispose）；3 `-s2`/`-s1` 名字不误判；4 D1 三种未知身份 + rogue payload；5 多 surface 挂载/释放无残留、无跨 scope 泄漏；6 guardrails 非 prompt 面共享 base 传递 provenance + invariant 反相。 |
| 判别力 | ✓ 由 §1 的 M1 独立重放证明（删掉 `base` 展开后 4/6 红）。 |

---

## 5. 计数无载荷、unknown 不自动可训练

| 检查 | 结果 |
| :-- | :-- |
| `scope_unknown_skipped` 是否保存工具参数/正文 | **没有**。collector 诊断串只有计数与固定文案；adapter 侧只有 `let scopeUnknownSkipped = 0` 数值，`hostAdvisorStats()` 只回传数字。 |
| 是否把 unknown 自动变成可训练 bucket | **没有**。collector 对 `!scopeInfo.isKnown` 直接 return；旧的 `scopeBuckets.get('unknown')` 借用路径已删除（`host-tool-experience.ts:586` 注释记录该决定）。单测断言 `activeScopeKeys()` 不含 `'unknown'`、`records` 为空、`scopeUnknownSkipped` 递增（M2 下这些断言全部转红）。 |
| 计数口径差异（观察） | adapter 统计**所有**无法证明身份的 dispatch（含未登记 branch）；collector 只对"完全无身份"递增，未登记 branch 走另一条诊断（不递增）。ADR 只要求"可计数、无载荷"，两者均满足；差异属实现口径，已在报告记录，非缺陷。 |

---

## 6. t2 披露的 3 个 inScope 外测试文件：断言未放松

| 文件 | 变化 | 断言强度 |
| :-- | :-- | :-- |
| `tests/unit/jitrl/host-tool-experience.test.ts` | 删除 1 个旧 Option 2 用例，新增 2 个 D1 用例；`expect` 数 −0 / **+13** | 净增强（新增"零学习 + 计数 + 无 unknown bucket + 受信登记后恢复"） |
| `tests/unit/jitrl/runtime-control.test.ts` | `expect` 数 −0 / +0，仅把 dispatch 载荷改成"受信登记的 sessionId+branchId"，并在测试内显式 `registry.register(...domain…)` 走 ADR §2.5 兼容路径 | 断言（`skipped===0` / `>0` / `advisory` 不变）**逐条保留**；不注册就无法进入 `evaluate` 路径，故这是 D1 下的必要适配，不是放水 |
| `tests/unit/integration/p5-host-tool-wiring.test.ts` | 新增 `registerTrustedScope()` 辅助；3 处 `expect(` 被重排（本质同断言，增加了身份字段） | 语义不变：`hostToolExperiences >= 5`、`additionalContexts[0]` 含 `<jitrl_advice`、`jit befor out` 等原断言全在 |
| （另）`tests/unit/cordis-seams/dsh-hook-host-adapter.test.ts` | `expect` **+17**，新增 3 个用例 | 净增强 |

---

## 7. 验证命令（评审环境实跑，绑定当前字节）

| 命令 | 结果 |
| :-- | :-- |
| `pnpm run typecheck` | **exit 0** |
| `pnpm test` | **72 files / 1387 tests passed，exit 0** |
| `pnpm run check:docs` | **exit 0**（评审中段一次为 exit 1，见 F1；README 计数被在途任务同步为实际值后复跑通过） |
| 隔离副本：`vitest run tests/e2e/provenance-chain.test.ts`（基线 / M1 / M2 / 恢复后） | `6 passed` → `4 failed+2 passed` → `1 failed+5 passed` → `6 passed`；副本全量恢复后 `72 files / 1387 tests` 绿 |

---

## 8. 验收清单（逐条）

| 验收项 | 结果 | 证据 |
| :-- | :-- | :-- |
| 绑定当前提交 SHA 并写入报告 reviewed SHA 字段 | **passed** | 头部表：HEAD `7bce33ee…` + 工作树指纹 + 7 个文件 sha256 前 16 |
| 三种未知身份不注入 advice / 不写学习样本 / 执行透传不 deny | **passed** | §2（真实链路实测 + adapter 单测 gate 无额外 ask、`deniedToolCalls=0`） |
| 与 ADR/代码/注释/测试名/README 一致；无 Option 2 残留 | **passed** | §3（六面清单；`Option 2` 在 src/tests 中 0 命中；index.ts 残留由 t15 落地修复，见 F2） |
| t2/t3 反证测试确有判别力：评审人独立重放变异 | **passed** | §1（M1 4/6 红、M2 scenario 4 红 + 单元 4 条红；并复现"trajectory.status 陷阱"） |
| provenance 链未绕过上游；6 场景全覆盖 | **passed** | §4（全文件零 `register(`；6 场景逐条核对） |
| `scope_unknown_skipped` 不保存参数/正文；unknown 不自动可训练 | **passed** | §5（代码 + 单测 + M2 反证） |
| 评审报告落盘 `docs/reports/p61-review-round1-security.md`（含 verdict 与 findings） | **passed** | 本文件 |
| `pnpm run typecheck` / `pnpm test` 在评审环境通过 | **passed** | §7（exit 0 / 1387 passed） |

---

## 9. Findings

| id | 等级 | 状态 | 内容 / required fix |
| :-- | :-- | :-- | :-- |
| **F1** | medium | **resolved（评审期间由在途任务同步掉落）** | 评审中段 `pnpm run check:docs` 红：README 计数与实测不符（摘要/总计 `71 files / 1370 tests` vs 实际 `72 / 1387`；unit `1269` vs `1280`；e2e `9 files / 101` vs `10 / 107`），根因是 t2 更新 README 时 t3 的 e2e 文件与 t15 用例尚未落地。**核实结果**：评审收尾时 README 已被同步为 `72 files / 1387 tests`（unit 62/1280、e2e 10/107），`pnpm run check:docs` 复跑 **exit 0**。无需后续动作（t13 收口时按新 SHA 重新绑定即可）。 |
| **F2** | low | **resolved（t15 已修）** | 评审中段 `src/index.ts:1845` 仍输出 `', host-local'`（ADR §2.6「状态诊断」面残留）。t15 落地后已改为 `', registry-resolved scope (D1 strict default: …)'`；同时 `index.ts:1975` 的 mirror 自由文本回显改为 `describeThrownClass(error)` 有界类。无需后续动作（除 t13 重新绑定字节）。 |
| **O1** | low | 观察（非阻塞） | 独立使用 `createHostToolExperienceCollector`（**不注入** ScopeRegistry）时，`resolveScope()` 对"sessionId+branchId"仍判 `isKnown: true` 并可学习（`host-tool-experience.ts:331-341`）。插件生产路径**总是**注入注册表（`src/index.ts:1400-1405` 的 `options.scopeRegistry ?? createScopeRegistry(...)`，并在 `:1299-1306` 传给 collector），故 D1 在生产默认路径成立；建议在 ADR/README 或代码注释中显式声明"无注册表的独立用法不在 D1 契约保护范围内"，或要求显式 opt-in。 |
| **O2** | info | 观察 | adapter 侧 `scopeUnknownSkipped` 只经 `hostAdvisorStats()`/attach 诊断暴露，未进入插件 `status` 快照（collector 的 `scope_unknown_skipped` 诊断线会经 `index.ts` 的 `jitrl host-tool:` 前缀进入插件 diagnostics）。ADR 未要求进状态表，仅作提示。 |
| **O3** | info | 观察 | t15 的 index.ts 编辑引入一处格式瑕疵：`const syncJitMirror = async (): Promise<void> => {    const mirror = jitWiring.mirror;`（函数体首行并入箭头行）。语义与 typecheck/test 均正常，建议 t13 顺手格式化。 |

---

## 10. 边界与漂移声明

- **R1 相关字节在评审期间未漂移**：adapter / host-tool-experience / eight-surfaces / e2e / adapter 单测的 sha256 与我在隔离副本中重放变异时完全一致（逐文件对比 `match=True`）。
- **非 R1 面在评审期间漂移**（在途任务 t6/t9/t15/t13 所致）：`src/index.ts`（t15 已修 F2/O3）、`README.md`（F1 计数，评审收尾已被同步为 72/1387）、`src/jitrl/stores/bridge.store.ts`（t11/R2 面的后续改动，已由 delivery gate 标记需重绑）。因此报告同时给出**文件级 sha256** 与当时的工作树 diff 指纹（最终 `fd1b4d2fca01db08ce7a506ebe93f4958471c0fd`）；若这些面再变，只有 F1/O3 与 R2 重绑受影响的结论需要新 SHA 复核，§1–§5 的 D1 结论按上述 R1 文件指纹保持有效。
- 未接真实 DSH 宿主/Cordis 运行时：provenance 链与 D1 行为由仓库自身的生产接线（`createCordisSeamManager` + `createDshHookHostAdapter` + 真实 collector）在进程内重放，符合本轮"受控重放"口径；真实宿主 smoke 属 t9（P6.1-F）。
- 未跑 `pnpm run test:e2e` 之外的全量门禁以外的额外检查；`check:docs` 已如实执行并记录（F1）。
- 未修改仓库 `src/**`、`tests/**`、`scripts/**`；隔离副本位于 `%TEMP%\p61-r1-copy`，评审结束后删除。
