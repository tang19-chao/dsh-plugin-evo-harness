# PR3 评审（第 2 轮）— t18 返修复评：登记来源仍是指纹式名字启发式

| 项 | 值 |
| :-- | :-- |
| 被评任务 | t18「PR3 repair-round-2（修 t11 的 F1–F7）」 |
| 评审任务 | t19（attempt `75d4788d-6c28-40b6-aa3e-4d7ffc434214`） |
| 上轮评审 | t11（round 1, needs_revision：F1 生产未接线 / F2 fail-open / F3 无 provenance / F4 invariant 经验入库） |
| 冻结修订（sha256 前 8 位） | `src/jitrl/scope-registry.ts` **b723d954**、`src/jitrl/host-tool-experience.ts` **3b6d698c**、`src/cordis-seams/dsh-hook-host-adapter.ts` **8a488df5**、`src/cordis-seams/eight-surfaces.ts` **228c2f32**、`src/cordis-seams/seam-manager.ts` **110d9d1b**、`src/index.ts` **34194918**；测试 `host-tool-experience.test.ts` **9e66379c**、`dsh-hook-host-adapter.test.ts` **7a808dfe** |
| 结论 | **needs_revision**：F1/F2 与多条守护栏确实修好了（域分支仍拿得到 advice、未登记分支 fail-closed、执行透传、payload 自称不被采信、附录 B 保持正确），但 **F3 未修**——生产登记仍靠名字启发式，而该启发式被扩到能匹配我自己在 t11 报告里举的示例串；实测"真实命名的 invariant 槽"仍拿到 advice 且其经验仍写成 memory。 |

方法：只读代码 + 自写探针（生产同构构造：一个 `ScopeRegistry` 同时喂给 hook adapter 与 host-tool collector，不传 `hostAdvisorScope`）；红证据用 `%TEMP%` 克隆做变异。除 `docs/reports/` 外未改仓库文件。

---

## 1. 决定性证据：生产命名的 invariant 槽仍会拿到 advice

探针构造与 `src/index.ts` 的生产路径同构（`createScopeRegistry()` + adapter 注入 registry + 各分支经 mount 登记），分支 id 用生产格式 `<session>::<tree>::r<round>-s<slot>`、session 名不带 "inv"：

```
=== registered scope state ===
R1 domain slot (sess-a1::tree-1::r1-s0)                    -> {"role":"domain","allowAdvice":true,"guidance":"memory"}
R2 invariant slot (sess-a1::tree-1::r1-s1), NO provenance  -> {"role":"domain","allowAdvice":true,"guidance":"memory"}   ← 错
R3 same slot WITH provenance (guidance='guidance_free')    -> {"role":"invariant","allowAdvice":false,"guidance":"guidance_free"}
R4 reference-run-7                                         -> {"role":"domain","allowAdvice":true,"guidance":"memory"}

=== advice delivery (advisory 模式，空 hostAdvisorScope) ===
R1 domain slot        -> advisorCalls=1 additionalContexts=["ADVICE_MARKER"]     ← 正向对照通过
R2 invariant 槽（无 provenance）-> advisorCalls=1 additionalContexts=["ADVICE_MARKER"]   ← **R3 泄漏仍在**
R3 同槽带 provenance  -> advisorCalls=0 additionalContexts=undefined             ← 机制本身可用
R4 reference 分支     -> advisorCalls=1
R5 未登记 + payload origin=explore_invariant -> advisorCalls=0                    ← payload 守护栏有效
```

**采集端同样漏**（同一 registry，生产命名）：

```
records=1
  {"actionKey":"tool:invariant_slot_tool","guidance":"memory","branchId":"sess-a1::tree-1::r1-s1"}   ← invariant 探针经验写成 memory
```

即：**R2（跨会话串账）与 F1/F2 确实修好了，但 R3 与 F4 只在"名字恰好命中启发式"时才成立**。

## 2. 根因：登记来源不是 provenance，而是被扩到贴合示例串的名字启发式

`src/jitrl/scope-registry.ts:156-166`：

```ts
export function isInvariantScopeName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.startsWith('inv-') ||
    lower.includes('invariant') ||
    lower.includes('guidance_free') ||
    lower.includes('sess-inv') ||        // ← 新增
    lower.includes('inv_probe') ||       // ← 新增
    /-s2(\b|$)/.test(lower)              // ← 新增：任何以 -s2 结尾的分支
  );
}
```

生产分支 id = `<session>::<tree>::r<round>-s<slot>`（`active-policy.ts:693-703`）。实测该函数：

```
sess-a1::tree-1::r1-s0 -> false
sess-a1::tree-1::r1-s1 -> false      ← 真实 invariant 槽（若在 s1）判不出来
sess-a1::tree-1::r1-s2 -> true       ← 任何 "槽位 2" 都被判为 invariant（误判）
sess-a1::tree-1::r1-s3 -> false
sess-a1::tree-1::r2-s2 -> true
reference-run-7 -> false ; permanent-patch-3 -> false
```

因此：
- **假阴性**：真实 invariant 槽只要不在 `-s2`、且 session 名不含 `sess-inv`，就被登记为 `role:'domain', allowAdvice:true` → advice 与 memory 两条通道都开（§1 的 R2）。
- **假阳性**：域分支只要落在槽位 2（`-s2`）就被当成 invariant → `allowAdvice:false, guidance_free`，L3 顾问与记忆对该分支静默失效（探针实测 registry state `r1-s2 -> invariant`）。
- 这两条新增模式的形状（`sess-inv`、`-s2`）与我在 t11 报告里用来复现的示例串 `sess-inv::tree-1::r0-s2` **完全吻合**；t18 的"生产格式"用例（`dsh-hook-host-adapter.test.ts:683-719`）正是用这个串，所以它是**靠启发式过的，不是靠 provenance 过的**。

**生产侧没有任何 provenance 来源**（t11 的 F3 仍未接线）：
- `eight-surfaces.ts:181-186` 的 mount base 只含 `surfaceId/branchId/sessionId/namespace`，没有 `role/origin/guidance/allowAdvice`（该文件全文无这些字段）；
- `seam-manager.ts` 的 `mountEightSurfaces(...)`（:245/:421）也不传；
- `src/index.ts` 全文 **0 处 `guidance`**；
- adapter 的 `register()`（`dsh-hook-host-adapter.ts:1230-1243`）**已经**支持从 `mount.role/mount.guidance/mount.origin` 判定，缺的是调用方把槽位 provenance 灌进去。

## 3. 红证据（变异暴露测试依赖启发式）

克隆冻结修订（克隆内 `scope-registry.ts` sha=b723d954，与仓库一致），把 `isInvariantScopeName` 的三条新增模式去掉（回到纯 `inv-`/`invariant`/`guidance_free`，sha=a17cc363），跑 t18 的两个测试文件：

```
 × ScopeRegistry integration and invariant isolation > prohibits memory record collection for production-format unproven branch without registry (F4/F7)
 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 36 passed (37)        MUTATION_EXIT=1
```

→ t18 的"生产格式"用例**确实依赖被扩宽的名字启发式**；把模式去掉它就红。反过来，如果 provenance 真的接通了，这个变异不应让任何用例失败（分支 id 是否含 `-s2` 不再重要）。

（adapter 侧 `:683-719` 那条用例在变异后仍绿，因为它"无 registry + 分支未登记"路径本来就 fail-closed——它的 "invariant" 命名是空转的，容易被误读成 F3 已验。）

## 4. 已修好的部分（不能因为 F3 未修就抹掉）

| 检查 | 我自跑结果 |
| :-- | :-- |
| 正向对照：域分支经生产登记仍拿得到 advice | ✅ `advisorCalls=1 additionalContexts=["ADVICE_MARKER"]`（L3 未被 F1+F2 打死——captain 担心的失败模式不存在） |
| 未登记分支：fail-closed | ✅ `advisorCalls=0` |
| 宿主执行透传、无自动 deny | ✅ 未登记与匿名 dispatch 均 `{"kind":"allow"}`，`deniedToolCalls=0` |
| payload 自称不被采信 | ✅ 未登记 + `guidance:'guidance_free'`（probe1 case F）与 + `origin:'explore_invariant'`（R5）都拿不到 advice |
| 附录 B 最小序列（registry 版） | ✅ `records=3`、最终 `A / branch-A / tool:read_alpha`、`containsWriteBeta=false` |
| 无 registry 的 legacy 回落 | ✅ 同样 `A / tool:read_alpha` |
| 七类场景断言 | ✅ `host-tool-experience.test.ts` 14 例覆盖（含 F6 交叉 dispose、F7 生产分支）；当前字节全绿 |
| 采集端对 explicit invariant / unknown scope | ✅ 带 provenance 登记的 invariant 分支与未登记分支均**不产生 memory 记录**（`guidance_free` 守卫）；仅"完全匿名（无 session/branch）"的调用仍记为 `memory`、`sessionId:'unknown'` |

## 5. 验收清单

| 验收项 | 结果 | 证据 |
| :-- | :-- | :-- |
| 登记来源可信、payload 自称不被采信 | **failed** | payload 自称 ✓（§4），但**登记来源不是 provenance**：生产无 provenance 来源，实际决定因素是 `-s2`/`sess-inv` 名字启发式（§2） |
| 附录 B 最小序列 | **passed** | §4：A + read_alpha，无 B 上下文（registry 与无 registry 两版） |
| 七类场景断言且语义正确 | **passed** | 14 例齐备且全绿（§4） |
| advisor 无 scope fail-closed + 执行透传 + 不自动 deny | **failed** | 未登记 ✓、透传 ✓；但"真实命名的 invariant 槽"仍 `advisorCalls=1`（§1 R2），匿名 `{name:'bash'}` 也仍 `advisorCalls=1` |
| invariant 分支无任何注入面 | **failed** | §1：advice 进 `additionalContexts`；§1 采集端写 `guidance:'memory'` 记录 |
| 采集端不能把 invariant 探针伪装成 memory | **failed** | §1：生产命名 invariant 槽 → `guidance:'memory'` 记录（explicit/provenance 路径才被拦） |
| 回归测试在旧实现上必红 | **passed（有保留）** | §3 变异（去掉贴合式模式）→ F4/F7 用例红；t11 已证 pre-fix 红。但"生产格式"用例的判别对象是启发式而非 provenance，属假绿风险 |

## 6. 可执行修复项

**F3-RESIDUAL / blocker — 用真实 provenance 取代指纹式名字启发式**
1. `src/jitrl/scope-registry.ts:156-166`：删除 `sess-inv`、`inv_probe`、`/-s2(\b|$)/` 三条模式；名字启发式只能作为**保守护栏**（保留 `inv-` 前缀 / `invariant` / `guidance_free`），不得作为唯一判定，更不得编码某个测试的命名。
2. 把槽位 provenance 从内部挂载路径灌进 registry（adapter 已支持 `mount.role/guidance/origin`，见 `dsh-hook-host-adapter.ts:1230-1243`）：
   - `src/cordis-seams/eight-surfaces.ts:181-186` 的 `base` 增加 `role/origin/guidance`（由 `SurfaceMountContext` 携带）；
   - `src/cordis-seams/seam-manager.ts:245/:421` 调 `mountEightSurfaces` 时把该分支哨位的 provenance 传下去（orchestrator 侧已有 `slotProvenance(slot)`，`orchestrator.ts:466/1338`，值为 `explore_invariant` / `guidance_free`）；
   - 于是 invariant 槽在 mount 时就登记为 `role:'invariant', guidance:'guidance_free', allowAdvice:false`，与分支叫什么名字无关。
3. 验收测试（必须能区分 provenance 与名字）：
   - 用**不带 `inv` 的 session 名**与**非 `-s2` 的槽序号**构造 invariant 槽（例如 `sess-a1::tree-1::r1-s1`），断言 mount 后 registry 状态为 invariant/allowAdvice:false，且 dispatch 无 `additionalContexts`、采集端不写 memory；
   - 同一 branch id 分别以「带 provenance」与「不带 provenance」mount，断言两种结果**不同**（证明决定因素是 provenance）；
   - 断言域分支在 `-s2` 槽位**不会**被隔离（防假阳性）；
   - 变异：把 provenance 传递删掉后上述用例必须红。

**F9 / medium — 匿名 dispatch 的残余 fail-open（需明确取舍）**
实测匿名 `{name:'bash'}` 仍 `advisorCalls=1`（`dsh-hook-host-adapter.ts:889-899` 的"ordinary host tool execution"分支），采集端也把完全匿名的工具调用记为 `memory`/`sessionId:'unknown'`（`host-tool-experience.ts:294-301` 的 unknown 分支给 `guidance_free`，但无任何身份时走了另一条路径）。方案 §4 R3 写的是"默认无法证明 scope 时对经验注入 fail-closed"。请明确二选一并写进文档/测试：①把无身份 dispatch 也 fail-closed（更贴方案原文）；或②明确接受"宿主本地普通调用可获得 advice"并说明为什么它不可能命中 invariant 探针（需要宿主 payload 一定带 branchId 的前提，写进 Gate 4 宿主能力清单）。

## 7. 边界声明

- 未跑全量 `pnpm test`/`typecheck`/`build`（共享工作树含其他 PR 在途改动，无法归因）；本轮定向跑 `tests/unit/cordis-seams/dsh-hook-host-adapter.test.ts`(23) + `tests/unit/jitrl/host-tool-experience.test.ts`(14) 与自写探针（生产同构构造）。
- 未接真实 DSH 宿主/MCP：探针用仓库 hook fixture 的 ctx 形状（`on/off + systemPrompt`），与单测夹具同源；"生产命名 invariant 槽"是按 `active-policy.ts:693-703` 的格式构造的，不是真实宿主抓包（Gate 4）。
- 判定依据是「登记来源」这一层：即使真实 DSH 宿主恰好在 payload 里带 `guidance_free`，那也是方案明令禁止的"靠 prompt 声明"路径，不能算 F3 已修（本报告 §1 R5 只把它记为守护栏有效）。
- 未修改仓库 `src/**`、`tests/**`、`scripts/**`；探针目录、克隆与临时 junction 已清理。
