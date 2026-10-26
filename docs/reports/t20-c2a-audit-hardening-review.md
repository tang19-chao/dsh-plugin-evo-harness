# t20 独立复审报告：C2a 审计来源加固（t11 F-3 关闭确认）

| 项 | 值 |
| --- | --- |
| 任务 | t20（review round 1）— 复审 C2a 审计来源加固 |
| 复审者 | evidence-reviewer（t11 F-3 的原报告者，非 t18 实现者） |
| attempt | 1 / `33832550-d7fc-485c-b5f6-267f049be33a` |
| 被复审任务 | t18（attempt 2） |
| 原始缺陷 | t11 F-3（medium）：无 seam 时 `metadata.verificationAudit` 不被认证，分支可伪造其内容并影响持久化标记 |
| 契约口径 | ADR-0003 T1/T2（来源认证）、§4.2（可读字段集）、§4.3（真值表）、§4.5.1（默认退化逐字节等价）、§4.6a(3)（不能只看 `trustedSource`） |
| 复审裁定 | **PASS**（F-3 关闭），附 1 项 low（X1，非 t18 引入） |

> **复审立场**：t18 的测试与我的探针必须**独立收敛**才有意义。我按「攻击面枚举」而非「复述其用例」来设计：凡是一个只看字段名的读取器会漏掉的对象形态，我都构造一遍；凡是一个只看对象同一性的读取器可能误伤的合法形态，我也构造一遍。
>
> 三件事必须同时成立：① **数据级**伪造全部失效；② **合法**宿主审计仍准确可读且不被削弱；③ 修好之后**没有把门开在被修的那一侧**（即不能靠削弱读取器换来「伪造被拒」）。

---

## 1. 加固实现（读源码，不读自述）

`src/verification/attach.ts`：

```ts
const HOST_AUDIT_REGISTRY = new WeakMap<object, HostAuditRegistration>();

// 写入侧（:271-274）：先注册后发布
const mark = markOf(disposition);
HOST_AUDIT_REGISTRY.set(mark, { disposition, trajectoryId: trajectory.id });  // 同一性 + 轨迹绑定
metadata[VERIFICATION_AUDIT_KEY] = mark;
```

`readVerificationDisposition`（`:136-194`）四道门：

| # | 条件 | 挡住什么 |
| --- | --- | --- |
| 1 | `HOST_AUDIT_REGISTRY.get(candidate)` 命中，且 `registered.trajectoryId === trajectory.id` | 手写对象（未注册）、深拷贝（不同对象）、把真 mark 挪到别的轨迹 |
| 2 | `disposition` 三个布尔存在（按**注册的 disposition** 校验，非读 mark 字段） | — |
| 3 | `authenticated:true` 必须带 `verifierId` + `verificationId` + `artifactDigest` | 「只填三个布尔却声称已认证」 |
| 4 | `artifactDigest` 必须等于**宿主对当前 artifact 的重算摘要** | 事后替换 artifact |
| 5 | `attached` 时 `metadata.verification` 必须是合法回执，且 `verificationId/verifierId/binding.trajectoryId/binding.artifactDigest/evidenceHash` 与 mark 逐一相等 | 删除回执、换别人的回执、篡改 evidenceHash |

**关键设计点**：注册表存的是 **`disposition` 对象**而非 mark 本身。这意味着读取器返回的是**宿主当初的判定**，而不是**当前 mark 上的字段** —— 我据此单独验证了「篡改已发布 mark 的字段是否无效」（见 §2 P1）。

---

## 2. 独立复核（自建探针 `work/_t20-review.ts`、`_t20-followup{,2}.ts`）

### 2.1 攻击面 A：数据级伪造（全部被拒）

每条都附一句「若无加固会发生什么」。

| # | 伪造形态 | 读取器结果 | 若不加固 |
| --- | --- | --- | --- |
| **A1** | 三个布尔（t11 F-3 的原始 payload） | **rejected**，marks=`undefined` | 被接受 |
| **A1b** | 三布尔 + `verdict:'passed'` + 真 digest + 真 verifierId | **rejected**，marks=`undefined` | `verificationVerdict:1` 被注入 |
| **A2** | **字段完备**的手写 audit（verdict/digest/verifierId/verificationId/testSetId/envId 全齐）+ 结构合法回执 | **rejected** | 被接受（这正是「完备 ≠ 认证」） |
| **A3** | **真 mark 的浅拷贝**（同轨迹 + 真回执） | **rejected** | 被接受 |
| **A3b** | 真 mark 的 **JSON round-trip 深拷贝** | **rejected** | 被接受 |
| **A4** | 真 mark **搬到另一条轨迹** | **rejected** | 被接受 |
| **A5** | 真 mark + **换成另一个 verifier 的回执** | **rejected** | 被接受 |
| **A6** | 真 mark + 回执 `evidenceHash` **被篡改** | **rejected** | 被接受 |
| **A7** | 真 mark + 轨迹 **artifact 被替换**（摘要不符） | **rejected** | 被接受 |
| **A8** | 经 `applyVerificationDisposition` 写入的 `authenticated:true` 但**无身份三元组** | **rejected** | 被接受 |
| **P1** | **原地篡改已发布 mark 的字段**（verdict/auditOnly/authenticated/verifierId 全改） | **完全不生效**（读回仍是宿主原判定 `passed/false/host-verifier`） | 会被读到伪造值 |
| **P1b** | 把 mark 换成**同内容新对象** | **rejected** | — |

**P1 是最能说明设计正确性的一条**：读取器返回注册表中的 disposition，而非重新解析 mark；于是「篡改字段」这个最直观的伪造方式在结构上无效。

### 2.2 合法路径 B：不能靠削弱读取器来换「伪造被拒」

| 项 | 实测 |
| --- | --- |
| 真宿主 mark 可读 | **是** |
| `authenticated` | **true** |
| `verdict` | **passed** |
| marks | `verificationVerdict:1`（正确） |
| View 携带回执 | **是**，`verifierId='host-verifier'` |

即：加固没有变成「一律 undefined」。**非空洞前提成立。**

### 2.3 资格 C：伪造不能翻转 scorer / eligibility / track

| 场景 | trustedSource | taskQualityEvidence | verdict |
| --- | --- | --- | --- |
| 伪造回执 + 伪造 audit，**默认装配** | **false** | **false** | passed（但未采信） |
| 伪造回执 + 伪造 audit，**注入 producer 集**（最坏情形） | true | true | — |

`dispositionAccepted = false` ⇒ 伪造 audit 被拒，因此无法通过 `forcedAuditOnly` 反向操作资格；`consumptionEligible` 完全由 scorer 的 `taskQualityLearningEligible` 决定，**伪造无法凭空创造可学性**。

> 说明：注入 producer 集那一格 `trustedSource=true` 是**该测试用例自己**把真 verifierId 放进集合所致，属 ADR §4.1 明确保留的「第二必要条件」语义，不是伪造成功（此时回执是构造的、但 id 与 digest 都真；生产不注入集合）。

### 2.4 默认退化 D（ADR §4.5.1）

| 项 | 实测 |
| --- | --- |
| 无 seam 返回**同一对象** | **true** |
| 无 disposition | **true** |
| **不写 audit key** | **true** |
| View 为 undefined | **true** |

逐字节等价**未回退**。

### 2.5 ADR §4.3 真值表（加固后逐行复验）

| 行 | 执行态 | 回执 | reasonCode | auditOnly | forceAudit | taskQualityEvidence | consumptionEligible |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | succeeded | passed | — | **false** | false | **true** | **true** |
| 2 | succeeded | failed | **falsified-success-claim** | **true** | **true** | false | **false** |
| 3 | failed | failed | — | **false** | false | **true**（可靠失败正例保留） | **true** |
| 4 | failed | passed | **contradictory-verdict** | **true** | **true** | false | **false** |
| 5 | timeout | failed | **execution-not-completed** | **true** | **true** | false | **false** |

五行全部落在 ADR 要求的位置，且每行 `dispositionStillReadable=true` —— 加固没有把审计通道一起关掉。

---

## 3. 门禁（全部 exit 0）

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `pnpm exec vitest run tests/unit/verification tests/e2e/c2a-trusted-verification.test.ts tests/unit/cordis-seams/trajectory-collector-c2a.test.ts` | **exit 0** — 6 files / **64 tests** |
| 2 | `node scripts/eval/guarded-regression.mjs --json` | **exit 0** — `{total:33, passed:33, failed:0}` |
| 3 | `pnpm run typecheck` | **exit 0** — 0 error |
| 4 | `pnpm test` | **exit 0** — **86 files / 1663 tests** |
| 5 | `pnpm run check:docs` | **exit 0** — Unit 74/1506、E2E 12/157、Total **86/1663**，与 README 逐项一致 |

> 与 t16 时点不同：当时 `pnpm test` 有 2 条 ledger 失败、`check:docs` exit 1（t17 中间态）。**本轮两处均已消失**，ledger 修复已落地。

---

## 4. 独立收敛性检查（证明 t18 的测试不是装饰）

我按**独立**思路枚举的攻击面，与 t18 的用例逐条对应：

| 我的攻击 | t18 对应用例 |
| --- | --- |
| A1 / A1b | `a three-boolean mark yields no disposition…` / `…carrying a forged verdict` |
| A2 | `a field-complete forgery is still rejected: completeness is not authentication` |
| A3 / A3b | 同上一例的 deep copy 段 |
| A4 | `a host mark cannot be moved onto another trajectory` |
| A5 / A6 / A7 | `an attached mark whose receipt was removed or swapped is unknown` / `a mark is unknown once the trajectory artifact no longer matches its digest` |
| B | `authentic host marks survive: …both keep their facts` |
| C | `a forged audit cannot flip trustedSource / taskQualityEvidence / eligibility` |
| D | `no mark at all stays unknown (default assembly and hand-built trajectories)` |

**双方独立设计却覆盖同一组形态**，且我的 **P1（原地篡改）** 是 t18 未显式覆盖的一条 —— 我实测其 `mutationInert=true`（结构上安全），故不构成缺口。

---

## 5. 发现

### X1（low，非 t18 引入，不阻塞）`applyVerificationDisposition` 在公开导出面上，进程内代码可铸造宿主 mark

**事实**（`work/_t20-review.json` → `X1_mint`、`_t20-followup.json` → `X1_over_falsified`）：

`applyVerificationDisposition` 是 `src/verification/index.ts:42` 的**公开导出**。任何**同进程代码**（而非数据）可调用它，把自己的 `VerificationDisposition` 注册进宿主 WeakMap，从而得到一个「被宿主认证」的 mark：

```
mintAccepted: true, mintedVerdict: 'passed', mintedVerifierId: 'attacker-verifier'
marks: { outcomeEligible: 1, verificationVerdict: 1, verificationTrusted: 0, verificationAuditOnly: 0 }
```

更进一步（`X1_over_falsified`）：在一个**宿主已判定 falsified-success-claim** 的真实轨迹上叠加铸造 mark，`consumptionEligible` 由 **false 被翻成 true**（`taskQualityLearningEligible` 由 false→true），即**救回了一条本应只作审计的记录**。

**为什么仍是 low，不判 needs_revision**：
1. **这不是 t18 引入的**：`src/verification/index.ts` 当前 hash 前 16 为 `A5361EFC7C8B3E9D`，与 **t11 记录的同一值**相同 ⇒ t18 未改动该导出面。它是 t5 起就有的公开面性质。
2. **它是代码级、不是数据级**：t11 F-3 的威胁模型是「**分支/执行器自报 payload**」——即不可信数据穿过 metadata。F-3 已彻底关闭（§2.1 全表）。同进程代码本来就有 `import` 任意模块的能力，能直接改 orchestrator、改 scorer 权重、或自己写 `policy.current.json`；把它视为「信任边界的伪造」会与其它同进程能力不匹配。
3. **生产路径无调用者**：`src/verification` 之外**零调用**（grep 空），`tests/**` 也**零直接 import**；即该导出当前是「为对称性而导出」，没有任何消费者需要它。
4. 但它是**唯一一条能让伪造审计真的改变资格**的路径 —— 这正是把审计通道做认证的意义所在，所以必须显式登记，不能让「F-3 已关闭」被读成「审计通道完全不可伪造」。

**建议（C2b 或下一次触碰该模块时，一行）**：把 `applyVerificationDisposition` 从 `src/verification/index.ts` 的公开导出去掉（改为 attach 内部函数），或改为不对外导出的 `applyInternal`；外部只用 `verifyAndAttach`（它已经做完全部认证）。若确有宿主需要自定义 disposition，应提供**只能由 runner 派生**的受限入口，而不是「任意 disposition 均可注册」。

### 已关闭项复核

**F-3 关闭**：数据级伪造 11 种形态全拒（§2.1），合法路径不受削（§2.2），资格/scorer 不可翻转（§2.3），默认退化逐字节等价（§2.4），§4.3 五行全部就位（§2.5）。

---

## 6. 字节绑定（本 verdict 的对象）

t18 报告的 8 项指纹我逐个重算，**全部吻合**：

| 文件 | sha256 前 16 |
| --- | --- |
| `src/verification/attach.ts` | `A98D17A8640B0BEF` ✅ |
| `src/verification/host-runner.ts` | `97FF4C19A421EE34` ✅ |
| `src/verification/artifact-digest.ts` | `8BDFAC7768ABBBCF` ✅ |
| `src/verification/types.ts` | `3A5EFE99BA2BB30A` ✅ |
| `src/verification/index.ts` | `A5361EFC7C8B3E9D` ✅ |
| `tests/unit/verification/audit-provenance.test.ts` | `406C1286910E0389` ✅ |
| `tests/unit/verification/recorder-marks.test.ts` | `1E475B178B9E3F62` ✅ |
| `tests/e2e/c2a-trusted-verification.test.ts` | `6B41E9D3B7157D96` ✅ |
| `README.md`（t18 额外授权的计数同步） | `BF5E465AEEF61F39` ✅ |

**README 授权的合规性**：t18 在其 changedPaths 中未列 `README.md`（结构化校验器按原 outOfScope 拒绝），但在 output 中以文字如实登记了 captain 的授权同步。我核对：README 只改了三行计数（Summary 85/1647→86/1663；Unit 73/1493→74/1506；E2E 12/154→12/157；Total→86/1663），且 `check:docs` 实测逐项一致。**属授权范围内的机械同步，不构成越界**；但建议 captain 在后续把该路径显式加入 inScope，避免每次靠文字登记绕过结构化校验。

---

## 7. 范围审计

| 检查 | 结果 |
| --- | --- |
| 是否只改 `src/verification/**` + 对应测试 + README 计数 | ✅ 是 |
| 是否改 `src/orchestrator.ts` / `src/index.ts` / collector | ✅ 未改（t16 记录：orchestrator `de6439b0`；本轮 grep 确认 collector 仍自建 metadata） |
| 是否改 r4（`REWARD_CONTRACT`/`learningTarget`/`contractWeightsHash`） | ✅ 未改 |
| 是否改 `src/types/contracts.ts` / `step-evaluator.ts` / `reward-contract.ts` | ✅ 未改（C2a-O1 遵守，仍走开放 metadata） |
| 是否新增 config 开关可开启 runner | ✅ 无（§4.5.2 遵守） |
| 是否 commit/push | ✅ 无 |

---

## 8. 结论

| 验收项 | 判定 | 依据 |
| --- | --- | --- |
| 三布尔与完整未注册 audit 均不能伪造 verdict/audit 标记 | **PASS** | §2.1：A1/A1b/A2 全部 rejected、marks=`undefined`；A3/A3b/A4/A5/A6/A7/A8 与 P1/P1b 同样被拒，其中 P1（原地篡改已发布 mark）在结构上无效（读取器返回注册的 disposition） |
| 认证基于宿主所有权与绑定而非字段名，合法审计保持可读 | **PASS** | §2.2：真 mark 可读、`authenticated=true`、`verdict='passed'`、View 带回执。§2.5：五行 `dispositionStillReadable=true`。A2 证明「字段完备 ≠ 认证」，A4/A5/A7 证明绑定（轨迹/回执/artifact）三向生效 |
| trustedSource/eligibility/track/scorer verdict 不被伪造翻转 | **PASS** | §2.3：伪造 audit 被拒 ⇒ `dispositionAccepted=false`，无法经 `forcedAuditOnly` 反操作；默认装配 `trustedSource=false`、`taskQualityEvidence=false`；`consumptionEligible` 只由 scorer 决定。附 X1（low）：代码级铸造可翻转，但非 t18 引入、生产零调用者 |
| 默认退化、真实 e2e 与相关门禁通过 | **PASS** | §2.4：无 seam 返回同一对象、无 mark、View undefined。§3：64 tests / guarded 33/33 / typecheck 0 / 全量 86 files 1663 tests / check:docs exit 0 —— **t16 时点的 2 条 ledger 失败与 check:docs exit 1 已随 t17 落地而消失** |

**verdict = pass**。t11 F-3 **关闭**：数据级伪造被结构性拒绝（不是靠削读取器），合法审计完整保留，资格与可信来源均无可翻转路径。C2a 的「可信来源」与「审计来源」两条通道现在都是**对象同一性**认证，而非字段名认证。

**唯一登记项 X1（low，非 t18 引入）**：`applyVerificationDisposition` 仍在公开导出面上，进程内代码可铸造宿主 mark（可翻转 `consumptionEligible`）。建议 C2b 或下次触碰该模块时收为内部函数 —— 当前生产与测试均零直接调用者，改动成本一行。

**未做**：真实付费调用、真实 memory、部署、commit/push；未评 C3（t19 对象）、未评 C1.1（t10/t16 已结）。
