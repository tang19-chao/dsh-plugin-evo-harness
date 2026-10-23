# PR3 评审（第 3 轮）— t24 返修复评：行为已修好，但测试没覆盖 provenance 链路；F9 口径自相矛盾

| 项 | 值 |
| :-- | :-- |
| 被评任务 | t24「repair-round-3（修 t19 的 F3-RESIDUAL / F3-PLUMB）」 |
| 评审任务 | t25（attempt `35575993-91c2-4f1e-9177-ba29c3559f09`） |
| 冻结修订（sha256 前 8 位） | `scope-registry.ts` **5195b54f**、`eight-surfaces.ts` **423686fe**、`seam-manager.ts` **12799b41**、`dsh-hook-host-adapter.ts` **2111c03f**、`host-tool-experience.ts` **0ce5b189**、`dsh-hook-host-adapter.test.ts` **dda3de1b**、`host-tool-experience.test.ts` **c5783061** |
| 结论 | **needs_revision**：行为层面 t24 把链路真正接通了（我走**真实 mount 路径**复验全部通过，含同 branchId 反向对照），但 ①**没有任何测试覆盖 provenance 链路**——我把 eight-surfaces 的 provenance 全部抹掉后 43/43 测试仍绿；②**F9 口径自相矛盾**：代码注释声明 Option 2（匿名 host-local 允许），测试名与注释声明 Option 1（fail-closed），实测生产默认下匿名 `{name:'bash'}` 仍拿到 advice、匿名工具调用仍写 memory 记录。 |

方法：只读代码 + 自写探针（**全部经 `mountEightSurfaces` 真实挂载**，不手动向 adapter 传 guidance）+ 克隆变异。除 `docs/reports/` 外未改仓库文件。

---

## 1. 行为层复验：链路真的通了（我自己的证据）

探针构造：一个 `ScopeRegistry` 同时喂 adapter 与 collector；**每个分支都经 `mountEightSurfaces(adapter, patch, context)` 挂载**（provenance 只来自 patch/context，不手动传）；分支名用中性命名。

```
=== 真实挂载后的 registry 状态 ===
domain (origin=domain, guidance=memory)          -> {role:domain, allowAdvice:true,  guidance:memory}
invariant (origin=invariant, guidance=free)      -> {role:invariant, allowAdvice:false, guidance:guidance_free}
同一槽位但 domain provenance (sess-b2::…-s1)      -> {role:domain, allowAdvice:true,  guidance:memory}
域分支落在 -s2                                    -> {role:domain, allowAdvice:true}     ← 无假阳性
未登记分支                                        -> unknown

=== advice 投递（无 hostAdvisorScope）===
1 域分支（正向对照）            advisorCalls=1  additionalContexts=["ADVICE_MARKER"]
2 invariant + provenance        advisorCalls=0  additionalContexts=undefined
3 同槽位、无 provenance          advisorCalls=1  additionalContexts=["ADVICE_MARKER"]   ← 同 id 两种结果
4 域分支在 -s2                  advisorCalls=1
5 未登记分支                    advisorCalls=0
7 未登记 + payload 自称 free     advisorCalls=0                                        ← payload 不被采信

=== 宿主执行透传 ===
未登记/匿名 均 {"kind":"allow"}，deniedToolCalls=0

=== 采集端（同一 registry）===
records=1（只有域分支；invariant 分支与未登记分支均 0 条）

=== 附录 B（登记 A/B 分支）===
records=3，final = A / branch-A / tool:read_alpha，tokens 不含 write_beta
```

对照第 2 轮（t19）的失败态（invariant 槽被登记为 domain 且拿到 advice），**行为缺陷已修复**，而且是在**生产同构路径**上修复的（不是只在单测里传参）。指纹模式（`sess-inv`/`inv_probe`/`-s2`）已彻底删除：`isInvariantScopeName` 现在只剩 `inv-` 前缀 / `invariant` / `guidance_free` 三条保守护栏。

## 2. F3-TEST / medium：provenance 链路没有任何测试覆盖（判别力缺口）

**证据（克隆变异）**：在克隆（`eight-surfaces.ts` sha=423686fe，与仓库一致）里把 provenance 传递全部抹掉——`resolvedContext` 的 `origin/guidance` 置 `undefined`、`role` 强制 `'domain'`、`allowAdvice` 强制 `true`，并删除 mount base 里四个字段的展开（mutated sha `aaa38b31`），跑两个 PR3 测试文件：

```
 Test Files  2 passed (2)
      Tests  43 passed (43)        MUTATION_EXIT=0
```

**为什么仍绿**：新增的"provenance"用例（`dsh-hook-host-adapter.test.ts:754-773`、`:826-829`、`:851-854`）是把 `origin/guidance/role/allowAdvice` **直接塞进 adapter 的 mount spec**（`registerPromptSegment({...})`），只测了 **adapter+registry 这一层**；`eight-surfaces.test.ts` 虽然调用 `mountEightSurfaces`，但没有断言"patch/context 的 provenance 会进 registry"。也就是说：**t24 声称的"seam-manager → eight-surfaces → adapter 全链路"没有测试守护，删掉它 43 个用例全绿**——这正是 captain 预判的"若仍然只在测试里靠显式传参通过，就判 needs_revision"。

**要求修复**：新增一条**走真实挂载链**的测试（用 `mountEightSurfaces` 或 seam-manager，provenance 只放 patch/context），断言 registry 的 `role/allowAdvice` 与 advice 结果；并保留反向对照（同一 branchId，带/不带 provenance 结果不同）与 `-s2` 域分支防假阳性；附"抹掉 provenance 传递后该测试必红"的变异证据。

## 3. F9 / medium：口径自相矛盾，匿名 dispatch 仍拿到 advice 与 memory

**实测（生产默认：无 hostAdvisorScope）**：

```
[F9 advisory] 匿名 {name:bash} -> advisorCalls=1  additionalContexts=["ANON_ADVICE"]  execResult={"kind":"allow"} denied=0
[F9 gate]     匿名 {name:bash} -> advisorCalls=1  execResult={"kind":"ask","reason":"confirm"}  denied=0
[F9 collector] 匿名 observeToolCall -> records=1  {actionKey:"tool:anonymous_tool", guidance:"memory", sessionId:"unknown"}
```

**矛盾之处**：
- 代码注释：`dsh-hook-host-adapter.ts:882-890` 写的是「Unscoped advisor / host-local execution (**PR3 / F9 Option 2**)…ordinary host-local tool executions (e.g. bash) are permitted」——即 Option 2（允许）。
- 测试名与注释：`dsh-hook-host-adapter.test.ts:521` "fails closed on advice for anonymous dispatches…"、`:725` "Anonymous dispatch: fail-closed (**Option 1 / F9**)"——即声明 Option 1（禁止）。
- 但这两条用例都没打到生产默认路径：`:521` 那条给了 `hostAdvisorScope:{branchId:'domain-br'}`（走"显式 scope 不匹配"分支），`:725` 那条传的是**空 payload `{}`**（无 `name`，落到"无身份且无工具名"分支）。真正生产默认 + 有工具名的路径**没有断言**，所以绿。

**与方案的关系**：§4 R3 的修复方向是"默认无法证明 scope 时，对**经验注入** fail-closed；对普通宿主执行保持透传，不能把缺少 scope 变成自动 deny"。匿名 dispatch 恰恰是"无法证明 scope"，而当前实现给它注入了 advice（advisory 注入文本、gate 返回 ask），采集端还把它记成 `guidance:'memory'` 的 memory 记录。

**要求处置（二选一并同步代码/注释/测试）**：
1. **Option 1（推荐，贴方案原文）**：无身份 dispatch 一律不注入 advice（保留执行透传与"绝不自动 deny"），删除 `:889-902` 的匿名放行分支；采集端对零身份观察也不写 memory 记录；补一条"生产默认 + `{name:'bash'}`"的用例。
2. **Option 2（保留现状）**：把代码注释与两条测试名改成 Option 2，明确写出前提（宿主 payload 必带 branchId/sessionId）并把该前提列进 Gate 4 宿主能力清单；同时补上"生产默认 + 有工具名"的用例，避免用无效场景宣称 fail-closed。

## 4. 其余验收项（我自跑，全部通过）

| 项 | 结果 | 证据 |
| :-- | :-- | :-- |
| 登记来源可信、payload 自称不被采信 | **passed** | 真实挂载后 domain/invariant 角色由 provenance 决定；未登记 + payload 自称 `guidance_free` → 无 advice |
| 附录 B 最小序列 | **passed** | §1：A + read_alpha，tokens 不含 write_beta |
| 七类场景断言且语义正确 | **passed** | `host-tool-experience.test.ts` 17 例含 A/B 交错、同 session 多 branch、乱序、重复 turn/end、无工具先收、abort、toggle+dispose；当前字节两文件 **43 passed**（adapter 26 / host-tool 17） |
| 无 scope fail-closed + 透传 + 不自动 deny | **partial** | 未登记分支 fail-closed ✓、透传/denied=0 ✓；**匿名路径仍 fail-open**（§3） |
| invariant 分支无注入面 | **passed**（我走真实挂载） | §1 case 2/3/4 + 采集端 0 记录 |
| 采集端不能把 invariant 伪装成 memory | **passed** | §1：invariant 分支与未登记分支均 0 记录；只有域分支产生 `guidance:'memory'` |
| 回归测试在旧实现上必红 | **partial** | 指纹已删且无残留依赖（变异保留全绿）；但**链路本身无守护**（§2 变异仍全绿），故"必红"只对 adapter 层成立 |
| （captain 追加）F9 一并验收 | **failed** | §3 |

## 5. 边界声明

- 未跑全量 `pnpm test`/`typecheck`/`build`（共享工作树含其他 PR 在途改动）；本轮定向两文件 43 用例 + 自写探针（真实挂载路径）+ 克隆变异。
- 未接真实 DSH 宿主：探针用仓库 hook fixture 的 ctx 形状与 `mountEightSurfaces` 真实挂载链；分支与 provenance 按 `seam-manager.ts:246-259/:429-442` 的生产取值构造（Gate 4）。
- 未修改仓库 `src/**`、`tests/**`、`scripts/**`；探针目录与克隆已清理。
