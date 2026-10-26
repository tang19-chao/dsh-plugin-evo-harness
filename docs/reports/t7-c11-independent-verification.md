# t7 独立验证报告：C1.1 发布边界效果事实

| 项 | 值 |
| --- | --- |
| 任务 | t7（verification）— 独立验证 C1.1 效果事实 |
| 验证者 | gate-verifier（独立于 t4 实现者 release-engineer） |
| attempt | 1 / `815f393d-148f-4d9c-be90-a9f0eed042a7` |
| 契约口径 | ADR-0003 §3.2 deny 语义 / §3.3 三闸两层 / §3.6 冲突测试 / §8.2 证据口径 |
| 代码基线 | HEAD `9ea9b7e` + 工作树（t4/t5/t6 未提交改动） |
| 结论 | **PASS**（实现成立），附 **1 项 medium 证据强度缺陷**（不影响安全结论，但需 t12 知悉） |

> **本报告的立场**：不接受「`permissions.publish.allowed === false`」作为发布已阻止的证据（§8.2 / t2 §0 R6 明令禁止）。所有 deny 结论均以**实际调用计数 + 策略对象身份/版本 + 磁盘 revision 增量 + 报告字段**四项为准。

---

## 1. 门禁结果（全部独立复跑）

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `pnpm exec vitest run tests/unit/p62/release-contract.test.ts tests/unit/jitrl/runtime-control.test.ts tests/unit/dream-rsi` | **exit 0** — 9 files / **249 tests** passed |
| 2 | `node scripts/eval/guarded-regression.mjs --json` | **exit 0** — `{total:33, passed:33, failed:0}`（含新增 `C1.1-publish-receptor-boundary`；总数随 t5 并行增补而增长，我验证时先后观测到 26 → 33，两者均全绿） |
| 3 | `pnpm run typecheck` | **exit 0** — `tsc --noEmit`，0 error |
| 4 | `pnpm test` | **exit 0** — 85 files / **1647 tests** passed |
| 5 | `pnpm run check:docs` | **exit 0** — README 计数 `85 files / 1647 tests`，与实测一致（t1 阶段曾因新增测试未同步计数而失配，现已被修正并复核） |

---

## 2. 独立探针（不复用 t4 的测试逻辑）

自建探针 `work/_t7-verify-c11.ts` → `work/_t7-verify-c11.json`，用**真实改进深树**（4 浅层兄弟 + 3 层可下钻，t2 §3.1 形状）驱动，每个用例**先断言 `improved === true`** 作为非空洞前提，再断言 deny 性质。

| 用例 | 场景 | improved | publish | shadow.published | apply 次数 | reason |
| --- | --- | --- | --- | --- | --- | --- |
| **A** | 普通 dreamer，生产形态（无授权） | **true** | **false** | **false** | **0** | `holdout-missing` |
| **B** | 调用方强制 `shadowMode:false` + holdout | **true** | **false** | **false** | **0** | `publish-denied` |
| **C** | 授权正控（`publishAuthorized:true` + holdout 通过） | **true** | **true** | **true** | **1**（`pi-0::dream-2`） | — |
| **D** | 真实持久化（`PolicyStore` + `createPersistentActivePolicy`） | **true** | **false** | — | **0** | — |
| **E(jitOn=true)** | Jit-wired + profile deny | **true** | **false** | **false** | **0** | `shadow mode: …` |
| **E(jitOn=false)** | Jit-wired + profile deny（`/evo jit off` 分支） | **true** | **false** | **false** | **0** | `shadow mode: …` |

**D 用例的磁盘证据**（先播种一条真实 revision，使「不变」不是空断言）：

```
identitySame:        true   (pi-seed @ v2 前后一致)
jitSame:             true
appliedIdsSame:      true   (['pi-0@1','pi-seed@2'] 未增长)
currentFileHashSame: true   (policy.current.json 逐字节相同, c625a25de0ed888a)
beforeHistoryLines:  1  →  afterHistoryLines: 1   ⇒ historyLineDelta: 0
historyIds:          ['pi-seed']   （无 dream 写入）
```

**探针自检**：`failures: []`，`verdict: ALL_DENY_PROPERTIES_HOLD`。

---

## 3. 实现核对（读源码，不读自述）

| 契约 | 实现 | 判定 |
| --- | --- | --- |
| §3.3 A 层唯一收紧点 | `decision-kernel.ts:1198-1206` 新增 `validatedOnHoldout !== true ⇒ publish:false, reason:'holdout-missing'`，置于 `shadowMode`/`validatedOnHoldout===false` 分支之后 | ✅ 与 ADR 真值表逐行一致；既有 4 条内核断言不受影响 |
| §3.3 B 层合成 | `offline-dreamer.ts:1848-1868`：`canApply = verdict.publish && publishAuthorized && applyPolicy !== undefined && bestCandidate !== undefined`；`publication` 按 G1/G2 拒绝原因重建 | ✅ 拒绝原因可区分（`publish-denied` / `no-apply-target` / `no-candidate`） |
| §3.3 `reported === applied` | `:1898` `published: applied`、`:1905` `selected: applied && …` | ✅ 三字段同源，杜绝假 published |
| §3.5 idle 收敛到单一入口 | `orchestrator.ts:1029-1046` 新增 `triggerDream()`（记录 dreamReports + recordDream + 诊断）；`index.ts:2773-2779` idle 走 `orchestrator.triggerDream` | ✅ idle 不再绕过 orchestrator |
| §3.5 诊断含 publish/reason | `orchestrator.ts:3191-3200` 追加 `published=` + `reason=` | ✅ |
| §3.4 `off` 保留重放 | `off` 分支未加 dream 短路（按 captain C1.1-O1 裁定「不变」） | ✅ 符合裁定 |
| G1 授权来源 | `index.ts:1218-1221` 与 `:1662`：`executionProfile.permissions.publish.allowed === true && base.publishAuthorized === true` | ✅ 生产恒 `false`（见 §4） |

---

## 4. 「未开放任何默认权限」的独立证明

| 检查 | 结果 |
| --- | --- |
| `execution-profile.ts:119-122` | `publish.allowed` **字面量 `false`**，四模式共享同一分支 |
| `ExecutionProfileInput` 字段集 | 只有 `mode` / `memoryRealWrites` —— **没有**任何 publish 开关 |
| `src/config.ts` | 无 publish 配置项（仅注释提及） |
| 生产 `dreamBase`（`index.ts:1661-1662`） | `shadowMode = shadowRecords \|\| !publish.allowed`；`publishAuthorized = permissions.publish.allowed === true` ⇒ 生产恒 `false` |
| 探针 A/E | 无授权时 apply 次数 **0** |

即使调用方显式传 `base.shadowMode = false`（用例 B），仍得到 `publish-denied` —— **fail-closed 成立**。

---

## 5. 发现的缺陷（medium，不阻塞安全结论）

### V-1：Criterion 1 的持久化 revision 断言是**空洞**的

`tests/unit/p62/release-contract.test.ts:1567`

```ts
expect(persistence.policyStore.history).toHaveLength(0);
```

**问题**：该用例的 `activePolicy`（`:1505-1512`）是**裸 `createActivePolicy`**，**从未**被 `persistence.wrapPolicy(...)` 包装；而 `persistence`（`:1500`）只被创建用来读 `.history`。二者**没有任何连接**。因此 dream 侧无论写什么，都到不了 `policyStore`，断言恒为 0。

**实证**（`work/_t7-diag-crit1.ts`）：向该 persistence 预置一条真实 revision 后再跑同一构造，`historyAfterSeed = 1`、`historyAfterDream = 1` —— 说明该断言**看不到** dream 写入。若把 apply 闸门改坏，用例 1 **仍然通过**。

**对照实证**（`work/_t7-diag-crit1b.ts`，生产形态 `persistence.wrapPolicy`）：

| 场景 | publish | history 行数 | 策略版本 |
| --- | --- | --- | --- |
| deny | false | **0** | 1 |
| 授权正控 | true | **1** | 2 |

⇒ **实现是对的，只是 Criterion 1 的这条断言缺了接线**。同文件的 **Criterion 2c**（`:1647-1652` 经 `createEvoHarnessPlugin({ persistence })`）接线正确，断言有效。

**影响**：安全结论不变（A/B/D/E 用例与我自建探针均独立证明零副作用）；但作为**回归护栏**，Criterion 1 在该点上失去判别力。

**建议修法**（不属我的 inScope，交 t4/t12）：把 Criterion 1 的 `activePolicy` 改为 `persistence.wrapPolicy(createActivePolicy({...}))`，断言 `history` 长度**相对基线不增**、`policy.current.json` 哈希不变。修好后 Criterion 1 才真正覆盖「持久化 revision 不变」。

---

## 6. 边界与未做

- 未跑真实模型、未付费调用、未写真实 memory、未部署、未 commit/push。
- 未改 `src/**`、`tests/**`、`scripts/**`；仅新增本报告与 `work/` 下（gitignored）探针。
- 未验证多进程/并发 dream 的 revision 竞争（ADR-0003 §3.7 已登记为未覆盖项）。
- 未复查 C2a（属 t8）与 C3（属 t9）。
- **能力状态**：C1.1 = `implemented` + `wired` + `default_enabled` + `independently_verified`（本报告）；**`release_authorized = ✗`**、**`actually_applied = ✗`**（G1/G2/G3 本轮恒拒）。

---

## 7. 复现

```bash
# 门禁
pnpm exec vitest run tests/unit/p62/release-contract.test.ts tests/unit/jitrl/runtime-control.test.ts tests/unit/dream-rsi
node scripts/eval/guarded-regression.mjs --json
pnpm run typecheck
pnpm test
pnpm run check:docs

# 自建独立探针
pnpm exec esbuild work/_t7-verify-c11.ts --bundle --format=esm --platform=node --target=node20 --outfile=work/_t7-verify-c11.mjs
node work/_t7-verify-c11.mjs          # → work/_t7-verify-c11.json, verdict=ALL_DENY_PROPERTIES_HOLD

# V-1 缺陷实证
pnpm exec esbuild work/_t7-diag-crit1.ts  --bundle --format=esm --platform=node --target=node20 --outfile=work/_t7-diag-crit1.mjs  && node work/_t7-diag-crit1.mjs
pnpm exec esbuild work/_t7-diag-crit1b.ts --bundle --format=esm --platform=node --target=node20 --outfile=work/_t7-diag-crit1b.mjs && node work/_t7-diag-crit1b.mjs
```
