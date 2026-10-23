# PR3（R2+R3）独立评审报告 — Gate 1 第 1 轮

| 项 | 值 |
| :-- | :-- |
| 被评任务 | t3「PR3 / R2+R3：ScopeRegistry 作用域隔离与 advisor invariant fail-closed」 |
| 评审任务 | t11（attempt `5ce041a1-076a-42d2-a34d-034860d4e75d`） |
| 评审人 | gate-reviewer |
| 评审对象 | commit `7307d7d` + 共享工作树未提交改动；Node `v22.23.1` |
| 结论 | **needs_revision**（4 个 blocker/high：R3 在生产路径上仍 fail-open、invariant 探针经验被写成普通 memory、无 provenance 判定、ScopeRegistry 在生产代码里从未被构造） |

评审方式：只读代码 + 评审人自行运行。除 `docs/reports/` 外未修改任何仓库文件；探针脚本写在 `node_modules/.cache/review-t11/`（gitignored，评审后已删）。

---

## 1. 结论摘要（一句话）

**PR3 交付的隔离机制只有在测试显式注入 `ScopeRegistry` 时才生效；生产插件路径（`createEvoHarnessPlugin`）从不构造也不注入它，`hostAdvisorScope` 默认也为空，于是 `advisorInScope()` 落回“空 scope → 允许所有 dispatch”的旧分支，invariant 分支仍能收到 advice，且 invariant 探针的工具调用仍会以 `guidance: 'memory'` 写入经验库。** 这正是方案 §4 R3（P0）与 §11 Gate 1 禁止的“另一入口注入”。

关键静态证据（评审人自行 grep，全仓）：
- `createScopeRegistry` 的调用点只有测试：`tests/unit/cordis-seams/dsh-hook-host-adapter.test.ts:429,466,549,612,654`、`tests/unit/jitrl/host-tool-experience.test.ts:344,399`；**`src/**` 内 0 个调用点**。
- `setScopeRegistry`（`dsh-hook-host-adapter.ts:1303`）在 `src/**` 内 0 个调用点。
- `src/index.ts:813-820` 构造 hook adapter 时只传 `fallback`/`onDiagnostic`，**不传 `scopeRegistry`**；`src/index.ts:1180-1188` 构造 collector 时只传 `config/store/now/policyId/onDiagnostic`，**不传 `scopeRegistry`**。
- `src/index.ts:1694-1704` attach advisor 时只在 `options.hostAdvisorScope !== undefined` 时给 scope，否则日志写明 `host-local`；`src/index.ts:319-327` 该选项的文档即“Empty means the advisor is host-local (**every dispatch in this host**)”——即旧 M6 语义未改。
- 生产 branchId 形态都不匹配 `isInvariantScopeName()`（`src/jitrl/scope-registry.ts:153-156`，只认 `inv-` 前缀 / 含 `invariant` / 含 `guidance_free`）：`src/dream-rsi/active-policy.ts:693-703` → `<session>::<tree>::r<N>-s<M>`；`src/cordis-seams/seam-manager.ts:413` → `permanent-<patchId>`；`src/orchestrator.ts:917,1624` → `reference-<runId>`。

---

## 2. 评审人自跑：方案附录 B 最小序列（生产默认构造，无 ScopeRegistry）

用 esbuild 打包一个独立探针（`node_modules/.cache/review-t11/driver.ts`，`packages:'external'`），按 `src/index.ts` 的生产方式构造 collector（**不传 `scopeRegistry`**）：

```
[1] Appendix B (production default: NO ScopeRegistry) records=3
    {"sessionId":"A","branchId":"branch-A","actionKey":"tool:read_alpha","guidance":"memory","reward":0.25,...}
    {"sessionId":"B","branchId":"branch-B","actionKey":"tool:write_beta","guidance":"memory","reward":0.25,...}
    {"sessionId":"A","branchId":"branch-A","actionKey":"tool:read_alpha","guidance":"memory","reward":0.5,
     "tokens":["tool:read_alpha","err:none","turn:completed","wd:unknown"]}
    final: session=A branch=branch-A action=tool:read_alpha containsWriteBeta=false
```

**R2 的核心归因在无 registry 的生产默认下确实是正确的**：最终记录为 `A / branch-A / tool:read_alpha`，且 tokens 不含 `write_beta`（旧实现的 `A + write_beta` 串账已消除）。这条是本轮少见的干净通过项。

---

## 3. 阻塞证据一：invariant 分支在生产默认下仍会收到 advice（R3 未关闭）

同一驱动对 hook adapter 做在生产配置下可复现的 dispatch（`agent/pre-step` / `tools/pre-execute`），**不传 `scopeRegistry`、不传 `hostAdvisorScope`**（= 生产默认）：

```
[3a] advisory, production default, invariant-format branch -> advisor calls=1
     additionalContexts=["EXTERNAL_MEMORY_ADVICE_SHOULD_NOT_REACH_INVARIANT"]
[3b] advisory, payload self-declares guidance_free -> advisor calls=0 additionalContexts=undefined
[3c] advisory, registry injected + invariant registered -> advisor calls=0 additionalContexts=undefined
[3d] gate, production default, invariant-format branch -> advisor calls=1 result={"kind":"ask","reason":"confirm"}
     isInvariantPassedToAdvisor=false
[3e] gate, anonymous dispatch -> advisor calls=1 result={"kind":"ask","reason":"confirm"}
```

分支 id 用的是生产格式 `sess-inv::tree-1::r0-s2`（同 `active-policy.ts:693-703`）。读法：

- **[3a] 是 P0 泄漏**：invariant 分支经由 L3 advisory 面收到外部经验文本，落在 `additionalContexts` 上——正是方案 §4 R3 描述的“L2 已按 slot 硬过滤，L3 仍可能从另一入口注入”。
- **[3b] 说明现在唯一能封住这条通道的东西是 payload 自己声明 `guidance_free`**，即方案明令禁止的“靠 prompt 声明”。一旦宿主不声明（生产 payload 不带该字段），封锁失效。
- **[3c] 说明机制本身可用，但只有在测试注入 registry 时才可用**（与 §1 的静态证据一致）。
- **[3d]** 显示 gate 模式下 advisor 在 invariant dispatch 上仍被评估，且传给 advisor 的 `isInvariant=false`。
- **[3e]** 显示匿名 dispatch 在生产默认下也会调用 advisor（`advisorInScope` 在 `dsh-hook-host-adapter.ts:840-846` 对空 advisorScope 直接 `return true`）。

**边界与诚实说明**：`src/config.ts:356-358` 的默认是 `hostAdvisor.enabled=false, mode='advisory'`，所以**出厂默认下这条通道是关的**；但“用户/DSH 打开 L3 顾问”是受支持的配置，R3 正是针对该配置的 P0，Gate 1 要求此时 invariant 分支不获得 advice。因此这是“生产默认配置下仍然存在的缺陷”，不是“仅测试环境的问题”。

宿主执行侧未误伤（通过）：`[3d]/[3e]` 只返回宿主本身的 `allow`/顾问的 `ask`，没有任何自动 deny；`deniedToolCalls` 只在宿主 deny 规则命中时增长（作者新增的 `dsh-hook-host-adapter.test.ts:605-648` 覆盖 deny 优先级，评审人运行通过）。

---

## 4. 阻塞证据二：invariant 探针的工具调用被写成普通 memory 记录

```
[2a] production-format invariant branch, NO registry -> appended=1 guidance=["memory"] sessionId=["sess-inv"]
[2b] name-matching branch "inv-branch-1", NO registry -> appended=0   (只靠名字启发式)
[2c] same branch WITH registered invariant scope   -> appended=0
[4]  adapter->collector post-execute, production default -> records=1
     {"sessionId":"sess-inv","branchId":"sess-inv::tree-1::r0-s2","actionKey":"tool:invariant_probe_tool","guidance":"memory",...}
```

- `[4]` 走的是**真实生产链路**（`createDshHookHostAdapter({ hostToolExperience: collector })` → `tools/post-execute` → `sink.observeToolCall`，见 `dsh-hook-host-adapter.ts:1034-1059`），不是直接调 collector API。
- 结论：生产 branchId 不匹配名字启发式 ⇒ `resolveScope()` 回退分支（`host-tool-experience.ts:275-295`）给出 `isInvariant=false, guidance='memory'` ⇒ invariant 探针的经验以**普通 memory 来源**入库。这直接违反 Gate 1 / R3 验收的“采集端也不能把 invariant 探针记录伪装成普通 memory 来源”。
- 注意测试判别力缺口：`tests/unit/jitrl/host-tool-experience.test.ts:342-395` 用的 branchId 是 `br-invariant`，**它自己也包含 "invariant"**，所以即使 registry 被完全忽略（回退到名字启发式 `[2b]`），该测试依然绿。**没有任何测试使用生产格式的 branchId。**

---

## 5. 红证据（评审人自行回退验证）

`git clone --no-local --depth 1` → `CLONE_HEAD=7307d7d`（旧 collector / 旧 adapter），把两个新测试文件与新增的 `src/jitrl/scope-registry.ts`（新测试 import 的辅助模块）拷入克隆后运行：

```
 Test Files  2 failed (2)
      Tests  13 failed | 21 passed (34)
REVERT_VITEST_EXIT=1
```

失败集中在 R2/R3 相关席：`fails closed on advice injection when advisor has no scope...`、`explicitly forbids advice for invariant branches...`、`delivers advice and gate ask to authorized domain branches`、`rejects untrusted payload self-proclaiming domain role...`（adapter 侧 6 项新测试中 4 项红）以及 collector 侧 9 项。**该项验收通过**：测试在旧实现上确实必红。

当前树为绿（评审人自跑）：

```
 ✓ tests/unit/jitrl/host-tool-experience.test.ts (12 tests) 22ms
 ✓ tests/unit/cordis-seams/dsh-hook-host-adapter.test.ts (22 tests) 51ms
 Test Files 2 passed (2)   Tests 34 passed (34)   VITEST_EXIT=0
```

**但“绿”不等于“生产生效”**：上文 §1/§3/§4 表明这些测试全部在注入 registry 的条件下运行，覆盖不到生产默认构造。

---

## 6. 验收清单逐项

| 验收项 | 结果 | 证据 |
| :-- | :-- | :-- |
| 独立复核 ScopeRegistry 登记来源；payload 自称 invariant/domain 不被采信 | **passed（机制层面）** | `scope-registry.ts:224-295` 只接受内部 register 的 role/guidance/allowAdvice；`resolve()` 只按 id 匹配已登记 scope，从不读 payload 的 `role/isInvariant/guidance`；`[3c]`/`dsh-hook-host-adapter.test.ts:650-682` 证明未登记 payload 不获 advice。**但生产无人构造 registry（§1）** |
| 自跑附录 B：最终为 A+read_alpha、不含 B 工具上下文 | **passed** | `[1]`：final `session=A branch=branch-A action=tool:read_alpha`，`containsWriteBeta=false` |
| 七类场景（A/B 交错、同 session 不同 branch、乱序、重复 turn/end、无工具先收 turn/end、abort、关闭后重开）均有断言且语义正确 | **passed** | `host-tool-experience.test.ts:57/117/168/197/231/248/284` 七项齐备，34 用例全绿；`[1]` 独立复现第 1 类 |
| advisor 无 scope 时经验注入 fail-closed、宿主执行透传、缺 scope 不构成自动 deny | **failed** | `[3a]/[3e]`：生产默认下 advisor 被调用且 advice 注入（fail-**open**）；透传/不 deny 部分通过（结果只有 allow/ask） |
| invariant 分支无 advice 注入面（含 canary 覆盖 prompt/轨迹/诊断/落盘/镜像） | **failed** | `[3a]` advice 进入 invariant 分支的 `additionalContexts`；评审未发现针对“invariant 分支 advice 通道”的 canary 断言 |
| 采集端无法把 invariant 探针记录伪装成普通 memory 来源 | **failed** | `[2a]/[4]`：生产格式 invariant 分支被写入 `guidance:'memory'` 记录 |
| 回归测试在旧实现上必红 | **passed** | 克隆 `7307d7d`：`Tests 13 failed \| 21 passed (34)`，exit 1 |

---

## 7. 可执行修复项（按优先级）

**F1 / blocker — 让 ScopeRegistry 在生产路径上真正存在（当前是死代码）**
`src/index.ts` 构造 adapter/collector 时从不传 `scopeRegistry`（`:813-820`、`:1180-1188`），全仓也没有任何 `createScopeRegistry()` 调用。修法（二选一，建议同时做）：
1. 在 `createEvoHarnessPlugin` 内 `const scopeRegistry = createScopeRegistry()`，注入 `createDshHookHostAdapter` 与 `createHostToolExperienceCollector`，并在 mount/attach 处调用 `setScopeRegistry`；**注意 `src/index.ts` 属 t1 写作用域，需要 captain 协调或在两个工厂内部默认自建 registry（不改 index.ts 即可生效）**。
2. 两个工厂在 `options.scopeRegistry === undefined` 时**默认自建**一个 registry（并提供显式关闭开关），否则“fail-closed 只有测试能看到”会再次发生。
验收要求：新增一条**不注入 registry** 的测试（用 hook fixture 走 `agent/pre-step` + `tools/pre-execute`，branchId 用生产格式 `<session>::<tree>::r0-s2`）断言 advisor 不被调用、invariant 分支无 `additionalContexts`、且该分支的工具调用不产生 `guidance:'memory'` 记录。

**F2 / blocker — 无法证明 scope 时对 advice fail-closed**
`dsh-hook-host-adapter.ts:836-852` 的 fallback 在 `advisorScope` 全空时 `return true`（host-local = 所有 dispatch），这是 M6 的原始语义。应按方案 §4 R3/§5.2 改为：**无 registry 或 resolve 为 `unknown` 且无法由 provenance 证明授权时，经验注入一律 `false`**；`tools/pre-execute` 仍返回宿主决策（透传、绝不自动 deny，保持 `[3d]/[3e]` 已验证的 deny 优先级与 ask-only 语义）。
配套：`index.ts:319-327` 的 `hostAdvisorScope` 文档需同步改为“空 = 无授权 scope（不注入）”，或让 harness2 在 mount 时提供真实 scope。

**F3 / blocker — invariant 判定必须来自 provenance，而不是名字/自称**
生产 branchId（`active-policy.ts:693-703`、`seam-manager.ts:413`、`orchestrator.ts:917,1624`）永不匹配 `isInvariantScopeName()`，而 `[3b]` 显示剩下唯一生效的是 payload 自称 `guidance_free`——方案明令“invariant 分支显式禁止，不能靠 prompt 声明”。必须在内部 branch 创建/挂载时按 slot 的 `origin/guidance`（如 `explore_invariant` / `guidance_free`）登记 scope，注册时写死 `role:'invariant'`、`allowAdvice:false`；名字启发式只能作为额外保守护栏，不能作为唯一依赖。`scope-registry.ts:238-246` 的强制逻辑已具备，缺的是“谁登记”。

**F4 / high — 采集端不得为不可证明的 scope 写 memory 记录**
`host-tool-experience.ts:427-471`（unknown 分支）与 `:275-295` 会让未登记/无法证明的 scope 以 `guidance:'memory'` 入库（`[2a]/[4]`）。要求：scope 无法证明时**不写 memory 记录**（或写 `guidance:'guidance_free'` 并确保不被 memory 召回），并把该行为写进测试（含生产格式 branchId 与 registry 已存在但未登记两种情形）。`tests/unit/jitrl/host-tool-experience.test.ts:397-433` 目前把“未登记 payload 仍产生一条 memory 记录”当作期望，需一并修正。

**F5 / medium — 不要为缺少 branchId 的事件编造 `main` 分支**
`host-tool-experience.ts:297-306` 对“只有 sessionId”的事件伪造 `branchId:'main'`，同一 session 的两个兄弟分支会落进同一个桶，R2 的跨分支串账在该形态下仍会复现。方案 §5.2 要求“作用域未知时不猜测”；应改为 unknown 桶（配合 F4 不写 memory 记录）。

**F6 / medium — registry 匹配不应做跨 session 叉积、branch-only 回退不可靠**
`scope-registry.ts:310-338` 先对 `sessionIds × branchIds` 叉积匹配，再退回“branchId 唯一”匹配；`branchToCompound`（`:277`）以 branchId 为键，两个 session 注册同名 branchId 时后写覆盖先写，且 `removeInternal`（`:186`）会无条件删掉该 branchId 的映射（先注册者 dispose 后，后注册者的 branch-only 查找也一起失效）。应只按 `(sessionId, branchId)` 复合键匹配，session 与 branch 互相矛盾时返回 `unknown`；branch-only 查找仅在唯一且无歧义时使用。

**F7 / medium — 补生产默认形态的判别力测试**
现有 6 项 adapter 测试全部注入 registry，且 invariant 用例使用含 `invariant` 的 branchId，因此**在“registry 被完全忽略”的变异下仍会绿**（评审已用 `[2b]` 证实名字启发式即可让 `br-invariant` 用例通过）。需要至少一条“无 registry + 生产格式 branchId”的用例；这条同时是 F1/F2/F4 的验收测试。

---

## 8. 边界声明

- 未运行全量 `pnpm test`/`typecheck`/`build`（工作树同时承载其他 PR 未提交改动，单点全量无法归因）；本次只对 PR3 声称的行为做定向验证：`tests/unit/jitrl/host-tool-experience.test.ts` + `tests/unit/cordis-seams/dsh-hook-host-adapter.test.ts` 共 34 用例。
- 探针使用仓库测试夹具同形的 hook fixture（`on/off + systemPrompt`）与 `process.execPath` 之外的 esbuild 打包，未接入真实 DSH 宿主；结论不涉及真实宿主/MCP（那属 Gate 4）。
- 未修改 `src/**`、`tests/**`、`scripts/**`；探针与克隆已清理（仓库 `node_modules` 完整性已复核）。
