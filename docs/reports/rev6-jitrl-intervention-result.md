# rev6 R1 结果：JitRL 写回证据门（t9）

- **任务**：rev6 `t9`（R1-1 预注册 + R1-2 证据写回门）
- **生成方式**：`node scripts/eval/rev6-jitrl-intervention.mjs --json > work/t9/intervention.json`。本文件引用的每个数字都来自该命令的一次真实执行（`exit 0`，2026-10-31T04:01+08:00），没有手写估值。
- **预注册**：`docs/reports/rev6-jitrl-intervention-preregistration.md`，sha256 `a9d97aa4631afcb3465642182e558810efc9f2fe7705456175c1e085606d948b`，mtime 2026-10-30T19:16:13Z。
- **首次采样**：2026-10-30T20:01:13Z；`preregisteredBeforeFirstSample === true`（mtime ≤ 首次采样）。

---

## 0. 一句话结论（先读这一节）

**门的机制已实现并通过判别力验证；但"门对 C3 的收益"在本轮池上 `not-evaluable`，不是正收益。**

原因是**在写任何实现之前就实测到的结构事实**（预注册 §9.1）：合成 fair-eval 池从不附 `metadata.verification`、从不传 `trustedProducers`，所以该池里每条轨迹的 verdict 只能是结构性 `unknown`，`trustedSource` 恒 `false`。G-A 要可信回执、G-B 的 `verified` 要可信 `passed` ⇒ **该池里两条准入路线都不可达**。180 条真实写回记录被判 **0 准入 / 180 仅审计**。

把"门拒绝了一切"读成"门有效并带来收益"正是预注册 §7 明令禁止的误读。本报告因此：

| 主张 | 状态 | 依据 |
| --- | --- | --- |
| 历史框架仍可精确复现（1.000 / 0.750 / −0.250 / CI [−0.417, −0.083] / 0-7-5） | **已实测** | §1 |
| 门对"无证据写回"的判决正确（180/180 拒绝、`gateFired=180`） | **已实测** | §2 |
| 门在"有可信回执"时能识别回执（不误判 untrusted） | **已实测** | §3 |
| 门的准入路线在受控输入下正确触发（G-A / G-B / 负控制） | **已实测** | §4（单元套件 26 例） |
| 门对 C3-online 的 verifiedRate 的影响 | **`not-evaluable`（不是收益，也不是负结果）** | §5 |
| 生产装配下门默认关闭、行为与历史字节等价 | **已实测** | §6 |

---

## 1. 冻结框架复现（不是新证据，是"我的驱动没跑偏"的证明）

| 臂 | verifiedRate | meanCoverage | 写入记录 |
| --- | --: | --: | --: |
| C3-frozen | 1.000 | 1.000 | 0 |
| C3-online | 0.750 | 0.9083 | 180 |

配对（独立分析单元 = **任务**，n=12；episodes/rounds 不是独立样本）：

| 统计量 | 值 |
| --- | --- |
| 均值差 | **−0.250** |
| 预注册区间（配对 t，95%，样本 SD=0.3089，t=2.201） | **[−0.4463, −0.0537]** |
| 冻结引擎口径区间（normal-approx 1.96，population SD=0.2958） | **[−0.4174, −0.0826]** |
| Bootstrap（10,000 次，seed 6221082）2.5/97.5 分位 | [−0.4000, −0.1000] |
| 胜/平/负 | **0 / 7 / 5** |
| 与历史报告逐项一致 | **true** |

> **两种区间必须并列，不能只报一种**：历史记录 `[−0.417, −0.083]` 是用 `fairCompare` 的正态近似（总体 SD）算出来的；预注册 §4 冻结的是配对 t（样本 SD，t=2.201）。两者点估计相同、下界相差 0.029。任一区间在本轮都**不满足** `−0.05` 容忍界（见 §5 的 `toleranceCheck`），所以谁也不比谁"更好"——只是口径不同，都如实列出。

---

## 2. 门在真实写回语料上的实测（`provenance: measured`）

语料来源：以 `runFairEngineWithLedger({ spec: fairArm('C3-online'), episodes:5, rounds:3, seed:6221082, protocol:'same-task' })` 实际跑一遍 C3-online，用 `collectRecords` 捕获它**真正写入**的记录（180 条），再用门的规则离线判决。历史与门判用的因果口径是"同任务中写在该记录之前的记录"（任何记录不能为自己背书）。

| 项 | 值 |
| --- | --: |
| 捕获记录 | 180 |
| 判定 | 180 |
| **准入 L2** | **0** |
| 仅审计 | 180 |
| **`gateFired`** | **180** |
| `writingBackRate` | 0 |
| 反例（verifier 失败却正目标） | 0 |

拒绝原因分布（逐条）：`{ "rejected-no-verdict": 180 }` —— 全部因"没有 verdict"被拒，**与 §0 的结构事实完全一致**，无一条因"可信回执但缺先前失败"或"反例否决"被拒（这两类在本池不可达）。

> **对照历史缺陷**：`docs/reports/p6-fair-eval.md` 记录的 `deviationStats = { total: 36, harmful: 18, gateFired: 0 }`。`gateFired: 0` 说明历史 36 条偏离**没有一条**经过证据门。本实测在同一 C3-online 臂上得到 `gateFired = 180`（180 条写回全部被判），即"每条写回都过门"这一机制已经生效——但**这不等价于说历史有害偏离被拦下了**：那些记录在本池里连 verdict 都没有，门只能判"无证据"，不能判"这条偏离是有害的"。差别见 §5。

---

## 3. 可信路径确实接上了（不是"门把一切当无证据"）

单靠 §2，"门拒绝全部"也可能因为**可信性根本没接上**。所以另有实测（`tests/unit/jitrl/writeback-intervention.test.ts`，10 例全绿；本节引用的是其中 4 例接线判定，其余 6 例见 §6.1）：

| 观察 | 结论 |
| --- | --- |
| 用真实 `createHostOwnedVerificationRunner` 作 `deps.verification` 后，`trustedVerificationSource` 含 `host-runner` | C2a 可信 seam 在生产装配路径上生效 |
| 该装配下**没有**任何判决落在 `rejected-untrusted-receipt` 或 `rejected-no-verdict` | 门能看到并信任宿主回执；"无证据"不是因为看不懂 |
| 门先看 `recordLearningEligible`，只降不升 | 门不会复活评分器已拒绝的记录（§3 的判决落在 `rejected-record-ineligible`，是**正确**而非缺陷） |

因此 §2 的"180/180 无 verdict"是**池的事实**，不是门的盲点。

---

## 4. 准入路线与负控制（受控输入，`tests/unit/jitrl/writeback-gate.test.ts`，26 例全绿）

规则本身在构造输入上逐条钉死（这是"需要受控历史才能测的规则"该待的地方）：

| 路线 | 正例 | 半证据反例 |
| --- | --- | --- |
| **G-A 可验证 Fail→Pass** | 可信 `passed` + 同 actionKey 先前失败 ⇒ 准入 `kept-fail-to-pass` | ① `passed` 但回执不可信 ⇒ `rejected-untrusted-receipt`；② 可信 `passed` 但无先前失败 ⇒ `rejected-no-prior-failure`；③ 同 actionKey 才配对，别的 action 的失败不算证据 |
| **G-B 预注册收敛** | support=3/verifiedRate=1.0 恰好达阈；4/5=0.80 边界恰好达阈 | 3/4=0.75 ⇒ `rejected-low-verified-rate`；2/2 ⇒ `rejected-insufficient-support`；**10 条里 1 条反例（9 通过）仍 ⇒ `rejected-verifier-mismatch`**（反例不被多数淹没） |

`fail-closed` 边界（同样是实测断言）：不可读历史 ⇒ `history-unusable`（**不是**"空历史"）；真正空 store ⇒ `rejected-insufficient-support` 且 support=0；已 ineligible 的记录 ⇒ `rejected-record-ineligible`；无 verdict ⇒ `rejected-no-verdict`。

**"不能构造正奖励"的可执行断言**：`applyWritebackVerdict` 对已准入记录返回**原样**（门不是评分器）；对被拒记录保留 `reward` 供审计但强制 `learningEligible: false`；已 ineligible 的记录即使判决"可准入"也**不能**被抬升。⇒ 任何路径都不会凭空产生正目标。

---

## 5. H2（门对 C3 的影响）：`not-evaluable` —— 不是收益，也不是负结果

预注册 §4 的主终点是 `C3-online(off) − C3-online(on)` 的 CI95 下界 ≥ −0.05。**该量在本轮全程无法被测量**，原因链条完整且先于实现记录：

1. §9.1 的结构事实 ⇒ 该池无任何可信回执 ⇒ G-A/G-B 不可达；
2. ⇒ 门的 `writingBackRate = 0`（准入 0 / 判定 180）⇒ **门是恒等函数**（off 与 on 都写同样的东西，即都不写）；
3. ⇒ 两臂的 verifiedRate 必然相同 ⇒ 差值恒 0 ⇒ "达到容忍界"是**算术恒真**，不是证据。

所以本报告**不报**"门达到 −0.05"、**不报**"收益恢复"、**不报**"−0.250 已被修复"。`toleranceCheck` 在冻结框架（非门）上如实给出：

| 区间口径 | 下界 | ≥ −0.05？ |
| --- | --: | --- |
| 配对 t（预注册） | −0.4463 | **否** |
| 冻结引擎（历史口径） | −0.4174 | **否** |
| Bootstrap | −0.4000 | **否** |

这正是 A-R1-1-5 要求的"如实保留负/不可判别结论"。

### 5.1 为什么没有把门注入 fair 引擎去硬测（诚实登记）

注入需要改 `scripts/eval/jitrl-eval-lib.ts`（在 `runFairEngine` 的写回处加门）。该文件**不在 t9 inScope**（契约 §4.1 的 t9 行不含它），且 `tests/unit/jitrl/production-replay-survival.test.ts:569-597` 明确把该文件钉为"冻结 V2 帧：2 处未过滤内核调用 + r2 写回戳"，改动会触发该 ratchet（其注释要求"重跑实验 + 新预注册"或队长授权才可动）。因此我选择**不改冻结引擎**，并把"需要引擎改动才能测的量"标记为 `not-evaluable`，而不是用代理指标冒充主终点。

**这条限制对下游的直接影响**：t15（验证 R1）应把 H2 判为 `not-evaluable` 并**接受**，不得要求 t9 提供门对 C3 的收益数字；t16（可判别实验）与 t13（真实收益）才是测量收益的地方。

---

## 6. 默认安全与生产等价（A-R1-1-2 相关）

| 项 | 实测 |
| --- | --- |
| 门的默认值 | `deps.writebackGate` 缺省 ⇒ `false`（历史路径，字节等价） |
| 关闭时的 stage 记账 | `writebackGate: { enabled: false, judged: 0, gateFired: 0 }`（**显式测量**"历史路径跑了"，不是缺字段） |
| 关闭时的记录 | 每条 executed 写回照旧持久化、`learningEligible` 不被降级、无 `writebackRefusal` 标记 |
| `gateFired` 语义 | 计"被拒（仅审计）"条数；`judged === admittedToL2 + auditedOnly` 恒成立 |
| 历史负结果 | `check:negative-result` exit 0，`A1..A6 PASS`，5 个最小反例与 `−0.250`/`deviationStats{36,18,0}` **逐字未动** |
| M1–M4 变异锚点 | `check:mutation` exit 0，**M1–M4 全 KILLED**，`worktree zero-residue: OK`（M3 仍唯一解析） |

**门不接 `guarded-active`**：`conservativeGate` 与模式绑定，而本门只决定"哪些 executed 探针能训练 L2"，与是否挂载永久 patch 是两件事。这一点在 `src/orchestrator.ts` 的 `writebackGate` 字段注释里写明。

---

## 6.1 修订（t27，修复 t21 finding T21-F1）：审计记录此前仍可被 L2 选到

> 本节是**追加**记录，不改写上面的实测数字；H2 的 `not-evaluable` 结论与 `−0.250` 均不受影响。

### 缺陷（t21 提出，t27 复现并修复）

门的审计编码是「`learningTarget = 0` + `learningEligible = false`」。但消费侧读取的是 **`observedReturn`** 而不是 `learningTarget`——`readLearningTarget()`（`src/jitrl/reward-contract.ts`）在 `observedReturn` 为有限数时直接返回它。于是一条被门判为「仅审计」、却携带 `observedReturn: 0.9` 的记录，**仍然是 L2 邻居检索的可见候选**，可以用门刚刚拒绝的那个回报去影响选择。

**复现（真实 store，非谓词直调）**：

```text
store.append([audited(learningEligible:false, observedReturn:0.9), live(eligible, 0.1)])
store.query({ level:'proposal', state, k:10, similarityThreshold:0 })
  → ["audited-high","live-low"]        # 审计记录仍可见
store.query({ ...same, learningEligibleOnly:true })
  → ["live-low"]                       # 才被排除
```

**根因**：`augmentProposalCandidates()` 的 `store.query` 是生产唯一的 L2 邻域查询，它从未传 `learningEligibleOnly`。kernel 的 `LEARNING_CONSUMER_FILTER` 文档里明确写着「the store's `learningEligibleOnly` query」，但该调用点一直没有接线；而 kernel 侧默认只在 `isDualTrack` 为真时才置该标志，`isDualTrack` 又由 `enableQualityTrackConsumption` 控制且注释要求**生产默认 false**。两条路都不覆盖单轨生产路径。

**为什么此前没有测试发现**：历史 fixture 用 `candidateCount: 1` 且 `augmentFromMemory: false`——`selectProposal()` 在 `candidateCount <= 1` 时提前返回，那条 `store.query` 从未被执行。

### 修复（选定语义 + 落点）

**语义**：*启用门时，审计记录不得进入 L2 邻居选择；该保证不依赖 `task-quality`/dual-track 开关。默认 `writebackGate=false` 的查询形状逐字节不变。*

**落点**：`src/orchestrator.ts` 的 `augmentProposalCandidates()`——在同一个 `store.query` 上：

```ts
...(this.writebackGate ? { learningEligibleOnly: true } : {})
```

- **门开** ⇒ L2 邻域是学习消费者，过滤掉被判「仅审计」的记录；
- **门关** ⇒ 该选项**完全缺席**，查询与历史形状一致（这是任务要求的「历史路径不变」，且用测试方向 B 钉住）；
- **不接 dual-track**：T21-F1 的缺陷正是这种依赖。门决定"被拒的证据能否训练"，与"是否消费质量轨"无关。

**未采用「只改注释」的路线**：任务明确要求「不只改注释」，且改注释不会让审计记录变得不可见。也**未**把 store 的默认改为过滤——`memory.store.ts`/`experience-store.ts` 不在本任务范围，且冻结研究路径依赖当前宽松默认。

### 行为级回归（4 个方向，全部走生产路径）

| 方向 | 断言 | 结果 |
| --- | --- | --- |
| A 门开 | 预置审计记录**不出现**在 L2 查询结果 | 通过 |
| B 门关 | **同一记录仍出现**（证明过滤是门带来的，不是 store 原有行为） | 通过 |
| C 字段 | `readLearningTarget(audited)` 返回 `observedReturn`（0.9）而非被置零的 `learningTarget`（0）——解释为何置零 target 无用 | 通过 |
| D 接线 | 用 spy 观察**真实 orchestrator 发出**的 `store.query`：门开时每条 proposal 查询都带 `learningEligibleOnly:true`；门关时**一条都不带** | 通过 |

方向 D 是真正钉住调用点的断言：直接复现谓词（方向 A/B）在调用点被拆掉时仍会通过，而这正是 T21-F1 的缺陷类别。

### 判别力（变异实测）

把 `...(this.writebackGate ? { learningEligibleOnly: true } : {})` 从 `src/orchestrator.ts` 删除后重跑：
**`writeback-intervention.test.ts` 10 tests → 1 failed**，红在方向 D（`gate ON issues at least one proposal query with learningEligibleOnly:true`）。还原后文件 sha256 逐字节相同。→ 回归不是空转。

### 不受影响的部分

`−0.250`、`deviationStats{36,18,0}`、5 个最小反例、`check:negative-result` exit 0；M1–M4 全 KILLED（**M3 锚点在改过的 `orchestrator.ts` 上仍唯一解析**，`worktree zero-residue: OK`）；`jit-active-policy.ts` `c9443123…`、ADR 0007 `47e67c7d…`、pr4a fixture `f22bdb14…`、预注册 `a9d97aa4…` 全部未变。门的默认值仍是 `false`——**本次没有借修复之机开启生产门**。

---

## 7. 证据索引

| 文件 | 内容 |
| --- | --- |
| `work/t9/intervention.json` | 本报告全部数字的机读来源（含 prereg sha/mtime、首次采样时刻、两套区间、bootstrap、逐条判决样本） |
| `docs/reports/rev6-jitrl-intervention-preregistration.md`（`a9d97aa4…`） | 预注册（先于采样） |
| `src/jitrl/writeback-gate.ts` | 门（纯函数 + 预注册阈值常量 + 拒绝/准入原因码） |
| `tests/unit/jitrl/writeback-gate.test.ts` | 26 例：阈值冻结、G-A/G-B 正例与半证据反例、fail-closed、负控制、汇总、不构造正奖励 |
| `tests/unit/jitrl/writeback-intervention.test.ts` | 10 例：4 例接线（off 等价 / on 全审计 / 可信路径识别 / 不抬升资格）+ §6.1 的 6 例行为级回归（A–D 方向 + 判别力对照） |
| `scripts/eval/rev6-jitrl-intervention.mjs` | 复现 + 语料测量 + H2 判定，`--json` / `--markdown` |

**复跑**：`node scripts/eval/rev6-jitrl-intervention.mjs --json`（exit 0；若预注册 mtime 晚于首次采样则 exit 1 并拒绝出报告）。

---

## 8. 明确没做的事

- 未 commit / 未 push / 未打 tag（N-1）。
- 未写真实记忆（N-2）；未开 `guarded-active`（N-3）；未 publish（N-4）。
- 未改 `docs/reports/p6-fair-eval.md`、`pr4a-*` 预注册与 fixture、`−0.250`、`deviationStats{36,18,0}`（G7/G14/N-6）。
- 未新增 Arm-5、未把 episodes/rounds 当独立样本（N-7）。
- 未改 `scripts/eval/jitrl-eval-lib.ts`（不在 t9 inScope，且被 ratchet 钉住）——因此 H2 为 `not-evaluable` 而非"测了不理想"。
- 未声称"−0.250 已修复"或"收益已恢复"。
