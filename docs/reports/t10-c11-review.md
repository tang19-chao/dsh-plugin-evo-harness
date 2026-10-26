# t10 独立评审报告：C1.1 发布安全（ADR-0003 §3）

| 项 | 值 |
| --- | --- |
| 任务 | t10（review round 1）— 独立评审 C1.1 发布安全 |
| 评审者 | evidence-reviewer（独立于 t4 实现者） |
| attempt | 1 / `0f06808f-64e3-4fb1-b382-cfbd4d85aff7` |
| 被评审任务 | t4（attempt 2，`469a2ca7-e1e6-451d-92b6-73b9a261e0b6`） |
| 契约口径 | ADR-0003 §3.1–§3.7（受体清单 / deny 语义 / 三闸两层 / 四模式 / 审计性 / 冲突测试 / 诚实边界）、§8.2 证据口径 |
| 评审裁定 | **PASS**（verdict=pass），附 **1 项 medium 缺陷 + 1 项 low 前向风险**，均不阻塞 C1.1 安全结论 |
| 前置条件 | t14 已落地（V-1 关闭）；本 verdict 绑定 **t14 之后**的最终字节，见 §6 |

> **评审立场**：不以 `permissions.publish.allowed` 当效果证据（ADR §8.2）。所有 deny 结论取自
> **实际调用计数 + 策略对象身份/版本 + 磁盘 revision 增量 + 报告四字段**。
>
> **与 t7 的差异（独立性的实际来源）**：t4 的回归与 t7 的探针主要在**手工构造的 dreamer**
> （`createOfflineDreamer` / `createJitWiredDreamer` 直接注入 `applyPolicy`）上判闸。ADR §3.1 冻结的
> publish 受体是 **PB-1…PB-6 六个**，其中 **PB-4「持久化 revision」的唯一生产触达路径**是
> `ActivePolicy.update` ← `persistence.wrapPolicy`。因此本评审**把整条生产装配链**作为被测对象：
>
> ```
> effectiveProfile → index.ts dreamBase → dreamer → orchestrator.runDream
>                  → idle 入口(agent/status) → PolicyStore(磁盘)
> ```
>
> 手工 dreamer 只能证明「闸在 dreamer 内成立」；只有走生产装配才能证明「PB-1…PB-4 在生产形态下为 0」。

---

## 1. 门禁结果（全部独立复跑，均 exit 0）

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `pnpm exec vitest run tests/unit/p62/release-contract.test.ts tests/unit/jitrl/runtime-control.test.ts tests/unit/dream-rsi` | **exit 0** — 9 files / **249 tests** passed |
| 2 | `node scripts/eval/guarded-regression.mjs --json` | **exit 0** — `summary={total:33, passed:33, failed:0}`；`C1.1-publish-receptor-boundary` status=passed，detail `{defaultDenyVerified:true, failClosedShadowOverride:true, authorizedPositiveControl:true, winnerPolicyId:'pi-reg-deep'}` |
| 3 | `pnpm run typecheck` | **exit 0** — `tsc --noEmit`，0 error |
| 4 | `pnpm test` | **exit 0** — **85 files / 1647 tests** passed |
| 5 | `pnpm run check:docs` | **exit 0** — `Unit 73/1493, E2E 12/154, Total 85/1647`，与 README 逐项一致 |

门禁 4 与 5 的计数相互印证（check:docs 内部重跑全量 vitest 并逐项比对 README），不是同一数字的自证。

---

## 2. 独立探针 A：生产装配 10 条 deny 路径 × 磁盘证据

自建 `work/_t10-verify-c11.ts` → `work/_t10-verify-c11.json`（**不重用 t4 测试、不重用 t7 探针**）。
每条用例都先预置**一条真实 revision 基线**（`pi-seed@4`，含 `jit` 块），使「不变」不是对空文件的断言。

| 维度 | 覆盖 |
| --- | --- |
| 入口 | 任务周期（`orchestrator.runDream`）、idle（**真实 `agent/status` 监听器**） |
| 形态 | 普通装配（无 kernel）、Jit-wired 装配（kernel on）、`/evo jit off` 运行时关 |
| 模式 | baseline / shadow / guarded-active / off |
| 追加 | 连续两次 dream（revision 叠加路径） |

**结果：10/10 任务周期用例 + 4/4 idle 用例全部满足 ADR §3.2 六项合取。**

| 用例 | improved | publish | shadow.published | comparisons.selected | history Δ | current hash | dreamReports |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 任务周期 × 4 模式 × jitKernel{on,off}（8 条） | **true** | **false** | **false** | 全 **false** | **0** | **不变** | 1 |
| `/evo jit off` 表面 | **true** | **false** | **false** | 全 **false** | **0** | **不变** | 1 |
| 连续两次 dream | **true** | **false** | **false** | 全 **false** | **0** | **不变** | 2 |
| idle × 4 模式 | **true** | **false** | **false** | — | **0** | **不变** | **1**（含 `recordDream` +1） |

补充事实（均为 ADR §3 要求的可审计性）：
- 每条用例 `publication.publish === shadow.published`（探针跨用例断言，0 违例）→ 无「假 published」。
- live policy `{id, version, jit, appliedPolicyIds}` JSON **逐字节前后相同**（含 `jit` 块）→ PB-4 的「内存被改写但无 revision」漏洞形态为 0。
- idle 从 `0 dreamReports`（t2 §F3 的原始缺陷）变为 **1 条**，且诊断行含 `published=` + `reason=`（ADR §3.5-1/2/3 全部满足）。
- `off` 模式 **未加 dream 短路**（`dreamTriggered` 仍发生、仍出报告），符合 captain C1.1-O1 裁定与 ADR §3.4。

---

## 3. 独立探针 B：非空洞性与正控（生产装配，不是手工 dreamer）

`work/_t10-diag-nonvacuity.ts` → `.json`。**同一** `buildOrchestratorDeps + createEvoHarnessOrchestrator + 真实 PolicyStore`，唯一变量是 profile。

| 用例 | publish.allowed | publish | history Δ | current hash | identity |
| --- | --- | --- | --- | --- | --- |
| deny（生产形态） | false | **false** | **0** | **不变** | 不变 |
| 授权 × mode=baseline | **true** | **false**（`holdout-missing`） | **0** | **不变** | 不变 |
| 授权 × mode=shadow | **true** | **false**（`shadow mode: …`） | **0** | **不变** | 不变 |

**结论**：deny 侧的「Δ=0」不是硬编码空转 —— 判据链**确实分叉**（G1 授权 true 时 A 层/`shadowMode` 各自接管拒绝，并给出**不同** reason）。三闸相互独立可测，符合 ADR §3.3「授权不是证据」。

**同时暴露一项 low 前向风险（L-1，非 C1.1 缺陷）**：`index.ts:1661` 把
`shadowMode = profile.shadowRecords || !publish.allowed` 派生出来，因此**将来 G1 授权后**，只要 profile 仍处于 `shadow`/`guarded-active`（`shadowRecords=true`），A 层会先命中 `shadow-mode` 分支，**holdout 门（G3）根本没被咨询**。今日无害（四模式一律 deny、且生产 `shadowRecords` 恒 true），但 G1 接线者若只打开 `publish.allowed` 而不同时处理 `shadowMode` 派生，会得到「报告说 shadow、实际是授权已通过」的误导性 reason —— 与 ADR §3.2-6「不得用 shadow mode 冒充授权拒绝」**方向相反**。见 §5 F-2。

---

## 4. 独立探针 C：V-1 关闭复核（t14）

t7 报的 V-1 是「Criterion 1 的 `policyStore.history.toHaveLength(0)` 空洞」。复核 t14 修复后的字节：

| 检查 | 证据 | 判定 |
| --- | --- | --- |
| activePolicy 是否真接线 | `release-contract.test.ts` 中 `persistence.wrapPolicy(baseActive, {recordRevision:true})` | ✅ |
| 基线是否非空 | 先 `active.update(pi-seed@2)` 并 `flush()`，再断言 `baselineHistoryCount === 1`、`existsSync(currentPath)` | ✅ |
| deny 侧是否相对基线 | `history.length - baselineHistoryCount === 0` + `policy.current.json` sha256 **不变** | ✅ |
| 正控是否真新增 revision | 授权 + holdout ⇒ `history.length - baseline === 1`、`history[baseline].id === 'pi-deep'`、current hash **改变** | ✅ |

**V-1 已关闭**，且正控证明该断言具备判别力（旧空洞形态在「apply 被误调用」时本会通过，现在会失败）。

---

## 5. 发现（findings）

### F-1（medium，不阻塞安全结论）状态面 `appliedJit` 在 deny 下谎报「发生过热替换」

**事实**（`work/_t10-diag-appliedJit.json`，生产装配，**双对照组**）：

| 组 | 生产 `update()` 调用数 | publish | live `jit` 前后 | `lastReplay.appliedJit` |
| --- | --- | --- | --- | --- |
| 预置 `jit` 的存量策略（真实恢复形态） | **0** | **false** | **逐字节相同** | **`{beta:1.25, lambda:0.04}`（存在）** |
| 无 `jit` 块的策略 | **0** | **false** | 相同 | `undefined` |

**根因**：`src/index.ts:1271`

```ts
const appliedJit = jitOn && report.improved ? holder?.policy?.jit : undefined;
```

该表达式只看 `improved` + **当前策略已有的** `jit` 块，与「是否真的 apply」无关。而字段契约
（`src/index.ts:381`）写的是「**jit of the hot-swapped policy, present only when a swap happened**」。
当在线策略在**本进程从未被热替换**、但**因持久化恢复而本就持有 `jit` 块**时（t2 §F6 已实证该链路），
该字段就报出一个与 incumbent **完全相同**、从未被 swap 的值。

**为什么这是 C1.1 范围内的同一类缺陷**：ADR §3.5-3 明令「不得假 published」，并禁止
「仅移除 applyPolicy 而不改报告值」的修法 —— 理由是那会产出「报告说发布了、实际没发」。
`appliedJit` 是 `publication.publish` / `shadow.published` 之外的**第三个状态字段**，此刻正在
deny 下声称「发生过一次 jit 热替换」，而对同一事实，`publication.publish` 说的是「没发生」。
即**同一份状态里有互相矛盾的两个陈述**，且撒谎的那个没有任何测试覆盖
（全仓 `tests/**` 对 `appliedJit` 仅 1 处断言，且是**负断言**：`runtime-control.test.ts:293` 断言
`/evo jit off` 下为 `undefined`——它恰好**不覆盖** jit-on + deny + 存量 jit 的组合）。

**为何定为 medium 而非 blocker**：
1. 四项安全效果（apply 次数、策略对象、磁盘 revision、`publication.publish`/`shadow.published`）
   **全部正确**，C1.1 的实际发布边界是干净的；
2. `appliedJit` 是**状态展示字段**，不参与任何门控决策（无代码读它做分支）；
3. 触发条件需要「策略已持有 `jit` 块」——今日生产可达（`config.ts:361` `jitrl.enabled` 默认 **true**，
   且 t2 §F6 已证 `policy.jit` 会被持久化并在重启后恢复），但前提是宿主此前跑过带 kernel 的 dream 或
   手工带入 jit 块。

**要求的修复**（低成本、C1.1 inScope 内）：`appliedJit` 必须与 `publication.publish` **同源**，
即只在**真实 apply 发生**（或至少 `report.publication.publish === true`）时才存在。等价写法：

```ts
const appliedJit = jitOn && report.publication?.publish === true ? holder?.policy?.jit : undefined;
```

并**补一条非空洞反例**：预置带 `jit` 块的存量策略 → deny 下 `appliedJit` 必须 `toBeUndefined()`
（该用例在旧实现上**失败**、修复后通过，符合 ADR §3.6-4「旧实现必失败」的同一纪律）。

### F-2（low，前向风险，非本轮缺陷）G1 授权后 `shadowMode` 派生会遮住 G3 的拒绝理由

见 §3 末。`index.ts:1661` 的 `shadowMode = shadowRecords || !publish.allowed` 在**本轮**是**正确的
fail-closed 派生**（它保证即使有人误传 profile 也 deny），但它是**压缩过的两个语义**：
「shadow 记录模式」与「未授权」。将来接线 G1 时若原样保留，授权的 profile 仍会报 `shadow mode`
作为拒绝理由，使「授权已通过、卡在 holdout」无法从 `reason` 读出。**建议登记到 ADR §3.8 或
G1 接线清单**，与 F-1 的修复一并处理（两者都是「状态字段必须等于事实」的同族问题）。

**不过遑论**：今日四条断言（`shadowMode` 派生值、`reason` 含 `shadow mode`）都是**既有冻结语义**
（ADR §3.3 A 层表 `true|true|任意 ⇒ shadow-mode`），t4 未越界改动，符合 §3.6-5「不需要改的」。

---

## 6. 字节绑定（本 verdict 的对象）

HEAD `9ea9b7e`；工作树未提交改动如下（sha256 全 64 hex，t14 之后）：

| 文件 | sha256 |
| --- | --- |
| `src/index.ts` | `afdfcafd710d2a29edbdcce9b0061512707509ad9505f2ee46bdd675a2f67b45` |
| `src/orchestrator.ts` | `de6439b083a42c8303012f9fc9a8434ef7ff74f1b7dd58877fb65785858d4e77` |
| `src/dream-rsi/offline-dreamer.ts` | `d7b1346be0c5a3b1929a3e5b397e40ef97a79d33534eea09c68719b8ca32cd07` |
| `src/jitrl/decision-kernel.ts` | `fdf68a441f15b4fe15efd96cf612621bd1dbec71a17f9e288751bc10b85d01c0` |
| `tests/unit/p62/release-contract.test.ts` | `6e5ab7e3181540e7e54cc7187596c4f983eea9aff84d8dddb43f51e3468e334f` |
| `scripts/eval/guarded-regression.mjs` | `9c151d5c7969e5421573ac801a1b900adf9730abf914eb6ef42603900bbe8259` |
| `tests/unit/jitrl/runtime-control.test.ts` | `e49dd50e7e54c5c28ea2a9b11fda09a5ce1676555b24d3b35423f57107de11ac` |
| `tests/unit/dream-rsi/offline-dreamer.test.ts` | `aa2b5e71162e79c411a76b47c059ce960a1d1840b40b82420e4de4d031163ee3` |
| `tests/unit/dream-rsi/jit-dream.test.ts` | `883651502508dd3e17b9e4eedebe66e4715c54f36d72ccbe33e4c7f454b4e1a2` |
| `tests/unit/dream-rsi/dream-rsi-pipeline.test.ts` | `ebcf50c872fb6e7e5f4bc6e3bbfe9f65f5c2e36f94d26f37c26015a08b85b872` |
| `README.md` | `df913ceda2c185eaf9fe43a97744e00f00504b20dbef3022dbb93f490421e00c` |

`src/index.ts` 与 `src/orchestrator.ts` 的哈希与 t7 报告记录的（`afdfcafd` / `de6439b0`）**一致**
⇒ t14 只改了测试文件，生产实现未在 t7 之后漂移；`release-contract.test.ts` 由 `f114a461` 变为
`6e5ab7e3` 正是 t14 的修复，与本 verdict 一致。

---

## 7. 越界审计（ADR §3.8 / t4 inScope）

| 检查 | 结果 |
| --- | --- |
| t4 inScope 外是否被改 | ✅ 未触碰 `src/jitrl/reward-contract.ts`、`src/jitrl/step-evaluator.ts`、`src/verification/**`、`src/evaluation/**`、`src/dsh-bridge/model.ts`、`docs/adr/0003-*.md` |
| `decision-kernel.ts` 改动是否最小 | ✅ 仅 +9 行（一个 `validatedOnHoldout !== true` 分支），四个既有分支逐字未动 |
| `offline-dreamer.ts` 改动是否最小 | ✅ 仅 apply 点 + shadow 记录派生（`published`/`selected` 均改指 `applied`），replay 语义未动 |
| `src/index.ts` 改动是否限 C1.1 | ✅ C1.1 相关为 `publishAuthorized` 派生、`shadowMode` 派生、idle 收敛到 `triggerDream`、`off` 分支的同源授权判定 |
| `orchestrator.ts` 共享文件是否只做最小局部改动 | ✅ `triggerDream()` 新增 + `runDream` 返回类型拓宽 + 诊断行追加；无格式化/重构噪声 |
| 是否开放 memory / 永久 patch / 发布 | ✅ `resolveExecutionProfile` 的 `publish.allowed` 仍为**字面量 false**；`ExecutionProfileInput` 无 publish 开关；`src/config.ts` 无 publish 配置项；生产 `dreamBase` 派生恒 false |
| 是否 commit/push | ✅ 无 |
| 是否弱化既有安全断言 | ✅ 5 处冲突测试均按 §3.6 改为 deny，并以授权正控**保留**判别力：`runtime-control.test.ts:319-421` 的「Jit 扰动不得泄漏」仍断言 `swapped.jit.beta===1 / lambda===0.05`（形态 (i)）；其余 4 处保留 `improved`/`suggestedPolicyId` 非空洞前提 |

---

## 8. 结论

| 验收项 | 判定 | 依据 |
| --- | --- | --- |
| 所有内建 Dreamer 与入口 deny 下均无 apply/update/revision 副作用 | **PASS** | §2：10 条生产任务周期 + 4 条真实 `agent/status` idle，`update()` 调用 **0**、`history` Δ **0**、`current.json` 哈希不变、策略对象（含 jit 块）逐字节不变 |
| 报告和改进/建议/应用状态语义一致且正控有效 | **PASS**（附 F-1） | `publication.publish === shadow.published === comparisons[].selected === false` 而 `improved/suggestedPolicyId` 成立；三闸独立可测（§3）。F-1 是**第三个**状态字段 `appliedJit` 的同类不一致，不影响上面四字段 |
| 实现严格限 C1.1 范围且验证证据可信 | **PASS** | §6 字节绑定（t14 之后、与 t7 记录的 src 哈希一致）+ §7 零越界 + §1 五门禁全绿 + §4 V-1 已关闭 |

**verdict = pass**。C1.1 的发布边界（PB-1…PB-6）在默认装配下**真实成立且非空洞**，`release_authorized`/`actually_applied` 仍恒 ✗，本轮未开放任何权限。F-1（medium）建议交 t12 前的修复轮（或登记为新工作项）：改动一行 + 一条非空洞反例，属 C1.1 inScope。

**本轮未做**：真实模型/付费调用、真实 memory、部署、commit/push、多进程并发 dream（ADR §3.7 已登记为未覆盖）；未评 C2a（t8/t11）与 C3（t9/t11）。
