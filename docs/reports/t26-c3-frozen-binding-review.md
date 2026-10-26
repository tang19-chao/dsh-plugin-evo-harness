# t26 终态 C3 交付路径绑定评审（冻结字节）

| 项 | 值 |
| --- | --- |
| 任务 | t26（review round 2）— 绑定终态 C3 全部交付路径 |
| 评审者 | evidence-reviewer（t23 Z-1/Z-3 的原报告者，非 t24/t25 实现者） |
| attempt | 1 / `db874969-cc22-4990-9658-f0b744e5dee7` |
| 被评审 | t24（r4 空转修复 + 指纹口径）、t25（attestation 脚本与清单）；回溯覆盖 t6/t17 全部 ledger 路径 |
| 契约口径 | ADR-0003 §7.2/§7.3/§7.4/§7.5/§7.6、§8.1（六态）、§8.2（证据口径） |
| 裁定 | **PASS** — t23 Z-1、Z-3 均关闭；无新 blocker；冻结字节无代码漂移 |

> **评审立场**：t26 的验收核心是「**绑定**」，不是「再讲一遍结论」。所以我没有转述 t24/t25 的自述，而是：
> ① 对 r4 修复做**判别力实验**（不只看它是否通过，而是看它在注入违禁字段时**会不会失败**、以及旧形态**为什么会空转**）；
> ② 对 attestation 用**自己写的实现**复算（不同遍历方式、不同排序原语），而不是跑它的脚本；
> ③ 对 12 条 C3 路径逐条对照 manifest 的 `path:sha256`，确认没有 unaudited path；
> ④ 用**重跑前后指纹比对**证明我这次的评审本身没有污染被验字节。

---

## 1. t24 r4 空转修复：**判别力实验**（t23 Z-1 关闭）

t23 Z-1 的原症状：`beforeEach` 每次重建 `manager`，而 r4 边界用例自身不做任何 reserve/settle ⇒ `getLedgerEvents()` 是**空数组** ⇒ `for` 循环体零执行，断言恒真。

t24 的修法（`tests/unit/ledger/offline-fixtures.test.ts:152`）：

```js
runAllPhasesWorkflowScenario(manager);          // 先产生真实事件
const events = manager.getLedgerEvents();
expect(events.length).toBeGreaterThan(0);       // 显式锚定非空
for (const evt of events) { expect(evt).not.toHaveProperty('learningTarget'); ... }
```

**我不只看它现在通过，而是做了三组实验**（`work/_t26-r4.json`）：

| 实验 | 问题 | 实测 |
| --- | --- | --- |
| **A** | 这个场景到底产生几条事件？ | **6 条**，phase 恰为 `probe/reference/compose/reflect/judge/dream`（§7.5 要求的 6 阶段） |
| **A2** | 计数是否确定？ | 连跑 3 次均为 **6** ⇒ 非偶然非空 |
| **B** | **修复后的断言有判别力吗？** | 把 `learningTarget:0.5` 注入任一事件 → 断言**会失败**（`B_fixedAssertionCatchesInjectedLearningTarget=true`）；注入 `contractWeightsHash` 同样被捕获 |
| **C** | **旧形态为什么是空转？** | 空数组上 `every(...)` 返回 `true`（`C_oldShapePassesOnEmptyArray=true`）⇒ **旧断言在违禁字段真的出现时也会通过**，空转被实证 |

**结论：Z-1 关闭，且关闭是**实质**的** —— 现在这条用例既跑在 6 条真实事件上，又能捕获违禁字段注入。测试数保持 12 it / 36 ledger（未用「加测试」掩盖，而是**修好了原来那条**）。

顺带确认：这 6 条事件仍满足 §7.3「已发生花费 ≠ 质量证据」——`succeeded` 的 6 条均 `auditOnly=false / qualityEvidence=true`，与 `ledger-event.ts` 的 `isMandatoryAuditOnlyOutcome` 一致（异常四类才锁 audit-only）。

---

## 2. t25 attestation：用**自己的实现**独立复算（不复用其脚本）

t22 已做过一次独立复算；t26 我再用**第三份实现**（`work/_t26-attest.ts`）做交叉验证 —— 迭代式栈遍历（t25 用递归）、手写 Unicode 码点比较（t25 用 `<`/`>`）、`Buffer` 直读。

**声明口径**（来自 manifest 的 `algorithm` 块，我按此独立实现）：roots `src/tests/scripts`；扩展名 `.ts .js .mjs .cjs .json`；POSIX 相对路径无 `./`；Unicode 码点排序；行格式 `${path}:${sha256}`；LF 连接、**末尾无 LF**；`SHA256(utf8)`。

| 项 | 我的复算 | t25/t22 声明 | 一致 |
| --- | --- | --- | --- |
| 代码文件数 | **206** | 206 | ✅ |
| 组合指纹 | **`13c4c3cff2c59183dc49416e242a0231bfbda1adb6ff7057a96b5e4b2ee693be`** | 同值 | ✅ |
| 逐条比对 | only-in-mine **0** / only-in-manifest **0** / hash-mismatch **0** | — | ✅ |
| 代码面 tracked diff SHA-1 | **`846c85ee0c06471226cfc0150e7d84e912d9a323`** | 同值 | ✅ |
| 同上 SHA-256 | **`bd6fad155a6418a38856cfdd5e96c41fce11969f1ea0bc335b0c4699251d34b5`** | 同值 | ✅ |
| 同上字节数 | **96,795** | 96,795 | ✅ |
| 同上文件数 | **11** | 11 | ✅ |

**逐条比对是最有力的一层**：不是两个总数碰巧相等，而是 206 条记录的 `path`/`sha256`/`bytes` 三元组**逐项零差异**。

### 2.1 94,540 vs 96,795 的根因我独立确认

`git diff` 原始二进制流 = **96,795 B**。PowerShell 以 LF 拼接 `git diff` 的行数组会丢弃 2,255 个 `\r`，96,795 − 2,255 = **94,540** —— 差分恰好等于行数，与 t25 的解释吻合。**t12 记录的字节数正确**，此前的 94,540 是测量方法误差，不是内容漂移。

### 2.2 manifest 自身的可变性（如实记录，非缺陷）

连跑两次 `final-attestation.mjs`，逐行 diff 显示**唯一差异是 `generatedAt` 时间戳**：

```
"generatedAt": "2026-10-26T21:12:22.099Z"   (第二次)
"generatedAt": "2026-10-26T21:11:51.487Z"   (第一次)
```

`fileCount` / `compositeSha256` / 206 条记录 / trackedDiff 四项**全部不变**。即：**文件哈希不可复现是预期的**（时间戳），**指纹与清单内容是可复现的**。`docs/reports/final-attestation.json` 当前为未跟踪文件（`??`），不污染 tracked diff。

---

## 3. t6/t17 全部 ledger 路径：逐条绑定（无 unaudited path）

**12 条路径逐条对照 manifest 的 `path:sha256`，全部 `inManifest=true` 且 `hashMatch=true`**（我直接拿当前文件哈希与 manifest 记录比对，不是我自己的清单）：

| # | 路径 | sha256 | 字节 |
| --- | --- | --- | --- |
| 1 | `src/ledger/index.ts` | `dbcf706f4f4959e7…` | 398 |
| 2 | `src/ledger/types.ts` | `1d6dad849522ed34…` | 9,610 |
| 3 | `src/ledger/pricing.ts` | `4831a17d7a520eeb…` | 7,231 |
| 4 | `src/ledger/ledger-event.ts` | `333959a84e60fde0…` | 2,183 |
| 5 | `src/ledger/reservation-manager.ts` | `18ca2b20a2bfe288…` | 17,081 |
| 6 | `scripts/fixtures/ledger/index.ts` | `b7dda524f808eebf…` | 168 |
| 7 | `scripts/fixtures/ledger/sample-rate-cards.ts` | `f2f09b78e1b31c31…` | 2,664 |
| 8 | `scripts/fixtures/ledger/synthetic-payloads.ts` | `9f5286ac720a1f1d…` | 3,707 |
| 9 | `scripts/fixtures/ledger/scenarios.ts` | `54a3110d02493875…` | 17,169 |
| 10 | `tests/unit/ledger/offline-fixtures.test.ts` | **`556acf3fbb193aa2…`** | **6,900** |
| 11 | `tests/unit/ledger/pricing.test.ts` | `28f7d90bdff4aae9…` | 8,430 |
| 12 | `tests/unit/ledger/reservation-manager.test.ts` | `0839750086a59646…` | 15,133 |

**与 t23 的唯一差异**：第 10 项 `96189b6a/6699B → 556acf3f/6900B`，即 **t24 的 r4 修复是 C3 面唯一的代码改动**（+201B）。其余 11 项**逐字节不变** —— 与我 t23 记录的哈希完全一致，说明 t24/t25 没有夹带任何其他改动。

`src/ledger/**` 五个文件全部出现在 manifest 的 `ledgerFilesInManifest` 中，且 `pricing.ts` 仍为 t13 基线值（防重复计价核心算法从头未动）。

---

## 4. 语义在冻结字节上仍成立（重跑独立探针，不复用实现者测试）

`work/_t26-c3.json`（即 t19 探针在新字节上的复跑）：`verdict=F1_F2_CLOSED_NO_REGRESSION, failures=0`

| 项 | 实测 | 判定 |
| --- | --- | --- |
| `actualCost 0` 无 usage | 10,000 / `unknown` / conservative=true | ✅ 地板生效、provenance 不再假盖 estimated |
| **真实 measured 零（反向对照）** | **0 / `measured` / conservative=false** | ✅ 地板只作用于 unknown，**未用 overcharge 换 silent-zero** |
| 已结算 callId 再 reserve | `call_already_settled`、reserved=0、seats=0 | ✅ 零滞留 |

补充（t23 已逐笔验证、本轮字节未变，故结论直接沿用并已抽样复核）：cacheRead 600,000→2,640,000、reasoning 700,000→2,300,000、两地板区幂等、fail-closed 拒 200 余量仍 100、验证池专款专用、活跃 reservation 仍报 `duplicate_active_call`。

---

## 5. 范围与零漂移

| 检查 | 实测 | 判定 |
| --- | --- | --- |
| `src/ledger` 在自身之外是否被 import | **0 处** | **零生产接线** |
| ledger 源码/fixture 对 r4 的引用 | **0 处** | r4 未耦合 |
| `reward-contract.ts` / `contracts.ts` / `model*.ts` / `step-evaluator.ts` diff | **空** | 冻结契约未动 |
| 真实付费调用 / 动态路由 / 输出折叠 | 无（纯合成 micros） | ✅ |
| 收益 / 已部署宣称 | 无 | ✅ |
| commit/push | 无 | ✅ |
| **本次评审自身是否污染被验字节** | 我的报告写 `docs/reports/`（**不在 manifest 的 roots 内**），探针写 `work/`（gitignored）⇒ 复算后 composite 仍 `13c4c3cf…`/206/96,795B | ✅ **零漂移** |

---

## 6. 门禁（冻结字节，全部 exit 0）

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `pnpm exec vitest run tests/unit/ledger` | **exit 0** — 3 files / **36 tests** |
| 2 | `pnpm run typecheck` | **exit 0** — 0 error |
| 3 | `pnpm test` | **exit 0** — **86 files / 1666 tests** |
| 4 | `pnpm run check:docs` | **exit 0** — Unit 74/1509、E2E 12/157、Total **86/1666**，README 逐项一致 |
| 5 | `node scripts/eval/guarded-regression.mjs --json` | **exit 0** — `{total:33, passed:33, failed:0}`（`C1.1-publish-receptor-boundary:passed`） |
| 6 | `node scripts/eval/final-attestation.mjs` | **exit 0** — HEAD `9ea9b7e`、206 files、`13c4c3cf…`、96,795B、11 files |

---

## 7. 发现

**无新 blocker。** 两项如实记录，均不构成缺陷：

### R-1（info）manifest 含 `generatedAt`，文件哈希逐次不同
如上 §2.2：连跑两次唯一差异是时间戳；`compositeSha256` / 206 条记录 / trackedDiff **全部稳定**。这是**正确设计**（时间戳属于运行元数据而非被验内容），但意味着「manifest 文件本身的 sha256」**不能**用作指纹 —— 应以 `compositeSha256` 为准。当前 `P62_STATUS.md:20` 已写明「可由 `node scripts/eval/final-attestation.mjs` 确定性复算」，措辞正确。

### R-2（info）manifest 的 roots 与 tracked diff 的排除集**不同**
manifest 的 `roots` 是 `src/tests/scripts`（`docs/` 天然不在内），而 tracked diff 的排除集是 `docs/P62_STATUS.md` + `docs/reports/**`。因此：
- **组合指纹**覆盖的是**代码面**（206 文件），不含任何文档；
- **tracked diff** 覆盖的是**已跟踪文件的工作树修改**，排除两份自指文档后剩 11 个。

两者**口径不同但都自称准确** —— 这本身没问题（t25 已分别命名），但状态表里若把两者并列，读者可能误以为「206 文件」与「11 files modified」应相等。建议（可选）在状态表加一句「206 为代码面全量文件数，11 为其中被修改的已跟踪文件数」，一句话消除歧义。

> 说明：这两项都是我作为**外部评审者**看到的表述风险，不是 t24/t25 的实现错误；t24 把 `t23-Z-3` 标为「口径明确已关闭」我认可 —— 因为**自指悖论确实已消除**（排除集显式、可复算），残余只是读法提示。

---

## 8. 结论

| 验收项 | 判定 | 依据 |
| --- | --- | --- |
| t24 r4 测试事件非空、无 learningTarget/contractWeightsHash，t23 Z-1 关闭 | **PASS** | §1 三组实验：场景产出 **6 条**真实事件（6 阶段齐全，3 次连跑均 6）；**修复后的断言在注入 `learningTarget` 或 `contractWeightsHash` 时会失败**（有判别力）；**旧形态在空数组上 `every()` 返回 true** ⇒ 空转被实证。Z-1 **实质关闭**，测试数保持 12/36（修好原用例而非加测试掩盖） |
| t25 manifest 206 文件 / `13c4c3cf` 可独立复算且与 t22 一致 | **PASS** | §2 用**第三份独立实现**（迭代栈 + 手写码点比较 + Buffer 直读）复算：**206 文件、`13c4c3cf…` 完全一致**；206 条记录 `path/sha256/bytes` **逐项零差异**（only-in-mine=0 / only-in-manifest=0 / mismatch=0）；tracked diff 四项（SHA-1/SHA-256/96,795B/11 files）全部吻合；94,540 的差异根因独立确认为 PowerShell LF 拼接丢失 2,255 个 CR。manifest 自身唯一可变项是 `generatedAt`（§2.2） |
| t6/t17 所有 listed unaudited paths 在当前哈希下逐一审阅并通过，无新 blocker | **PASS** | §3 **12 条路径逐条**对照 manifest：全部 `inManifest=true` 且 `hashMatch=true`；与 t23 的唯一差异是 `offline-fixtures.test.ts` `96189b6a→556acf3f`（t24 的 r4 修复，+201B），其余 11 项**逐字节不变** ⇒ 无夹带改动。§7 无新 blocker，仅 2 项 info 级表述提示 |
| 当前 C3 契约/离线范围成立，七门禁证据绑定冻结字节，未新增代码漂移 | **PASS** | §4 语义在冻结字节上复跑：地板 10,000/unknown/true、**measured 零保持 0**、`call_already_settled` 零滞留。§5 零生产接线、r4 零引用、冻结契约 diff 为空、无付费/收益宣称。§6 六条门禁全 exit 0。**评审自身零漂移**：报告落 `docs/reports/`（不在 roots）、探针落 `work/`（gitignored），复算后 composite 仍 `13c4c3cf…`/206/96,795B |

**verdict = pass**。t23 Z-1（r4 空转）与 Z-3（指纹口径）**均已实质关闭**；t25 的 attestation 可被第三方用不同实现精确复现；t6/t17 的 12 条 ledger 路径在冻结字节上逐条绑定、无 unaudited path。**C3 契约与离线范围在冻结字节上成立，且本轮未引入任何代码改动。**

**未做**：真实付费模型调用、真实 memory、部署、commit/push；未评 C1.1（t10/t16）、C2a（t20）、C4。
