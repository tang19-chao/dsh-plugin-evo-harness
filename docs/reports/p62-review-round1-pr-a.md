# P6.2 PR-A 评审报告（round 1）

- 评审任务：t14「P6.2-PR-A 评审（round 1）」（kind: review，被评审任务 t10）
- 评审人：gate-reviewer（独立于实现者）
- 日期：2026-10-25（Asia/Shanghai）
- Verdict: **PASS**

## 0. 绑定（HEAD、diff 指纹、关键文件 sha256）

- 仓库 HEAD（基线，与 P6.2 任务声明一致）：`e0be51dbc06d86ccb8b681c0385129696e1e2803`（`e0be51d docs(p6.1): ADR 0001 rulings, review reports, P6_STATUS ledger`）
- 工作树相对 HEAD 的完整 diff 指纹：
  - `git diff | git hash-object --stdin` = `d3a6e46759759f7b7378ea042455236997777746d`
  - `git diff` 全文 SHA-256 = `afd84257e6a61bd35908c7eb2754ce7b32527ca2db30df66caa533786e07a45d`
- diff 覆盖 13 文件（+702/−96）：src 5 文件（backfill/decision-kernel/experience-store/index/reward-contract），tests 8 文件（新增 eligibility-contract.test.ts + 7 存量更新）。
- **绑定说明（按 captain 指示注明）**：`tests/e2e/eval-cli.smoke.test.ts` 的改动（+123）属 t19（Windows 预存在 e2e 失败清理，node 子进程化），在 PR-A 字节之外；本评审对其仅作「不破坏」验证（全量测试含该文件 6 条全绿），其内容不在 PR-A 评审范围内。
- 关键文件 SHA-256（评审时点）：

| 文件 | SHA-256 |
|---|---|
| src/jitrl/decision-kernel.ts | `69647913db8c399eb01e531902ad280835e8779fa33a43c81becc90fe5332dbf` |
| src/jitrl/experience-store.ts | `311501bb1b73fcc46792cd44ca016a1dc7e830bb8c145cf4e78d2ecbb0fe746b` |
| src/jitrl/backfill.ts | `14d9d5da4dc896ab7a27f4fe6812b565ec14c4df20fb0f8a2aa71778d05404b0` |
| src/jitrl/reward-contract.ts | `548effe36b405d521be98ff6e20f979d1a4f72703d2d198df32c04734ac2bcf4` |
| src/jitrl/index.ts | `5010ca6912d5ffc51a7f04fadcf753551e644ccb32465fada0381ac16d1d2297` |
| tests/unit/jitrl/eligibility-contract.test.ts | `0bd1a405baf10a4bc367df7f4b4b5ca17f9df17d6cc3092b189bc6f29b8be115` |
| work/p61-evidence/runs/probes/reviewer.test.ts（未改动，基线证据） | `dc7bb85aa84b42e88a554bd96d76f827109917c36b789c930f7cf7f523f7e342` |

工作树在整个评审期间未被实现者触碰（评审结束后 `git status` 与评审开始时逐文件一致；三处 mutation 均已恢复，恢复后哈希与上表一致）。

## 1. 证据包探针 → 正向回归（转换核实 + 独立重放）

**源探针**：`work/p61-evidence/runs/probes/reviewer.test.ts:893-923` 的三条独立复现探针（F1 r2/r3 混估、F2 surrogate backfill 被严格查询接受、F3 verifier 代理分数）。该证据包文件 import 的是另一台机器的绝对路径（`/data/repos/dsh-plugin-evo-harness/...`，本机 `Test-Path` 确认不存在），属 P6.1 一次性复现工件，不可也不应在本仓运行；转换载体是 PR-A 新增的正向回归文件 `tests/unit/jitrl/eligibility-contract.test.ts`（21 条）。

**逐条核实转换忠实性**：

1. F1 探针（reviewer.test.ts:896-908「r2 crossing online and replay while store excludes it」）→
   `eligibility-contract.test.ts` F1 describe（327-513）：同一对记录（old-r2 return +3 / new-r3 return −1，rewardVersion `r2/verifiable-v1` vs `CURRENT_REWARD_VERSION`），断言从「store 只留 1 但 L1/replay 见 2 邻居（缺陷）」反转为「四入口全部只留 new-r3 且 V=−1」：store.query（328）、L1 `createJitActivePolicy`（335）、replay `createJitReplayHook`（351）、M3 分母（359）、另加 L2 optimizer（387）与 L3 host advisor（411）——比原探针覆盖更全。修复前红（neighborCount=2、V=+1）、修复后绿，方向正确。
2. F2 探针（reviewer.test.ts:909-916「surrogate-only backfill accepted as r3」）→
   `eligibility-contract.test.ts` F2 describe（520-636）：同一 fixture（score 0.9 → observedReturn ≈ 2.4，断言 `toBeCloseTo(2.4, 6)` 与原探针数值一致），断言从 `queried.length > 0`（缺陷）反转为 `queried.length === 0`（544-555），并断言 `learningEligible === false`、`isSurrogatePriorRecord` 为真、`isRewardVersionCompatible(BACKFILL, CURRENT)` 为 false、认证表不含 backfill id。正路径（rescored 带六字段 provenance 被接受，558-601）与负路径（provenance 不完整/外来权重 fail-closed，603-635）都覆盖。
3. M3 分母净化（F1 的衍生缺陷，原 t28 探针文件 394-454 行变体）→ F1 第 4 条（359-385）：污染批 `usable 1 / =1/2` 且不出现 `drift penalty inactive`——精确对应评审包「4/3 vs 2/1」的口径修正。

**F3 探针**（reviewer.test.ts:919-923 verifier 代理）属 F3 缺陷（verifier-first 只查非空交付物），归 PR-B/C 范围，不在 PR-A 契约内；PR-A 契约（F1+F2）对应的转换全部到位。

**独立重放**：本评审人独立执行 `pnpm vitest run tests/unit/jitrl/eligibility-contract.test.ts` → 21/21 绿（修复态），并在三处 mutation 下观测必红（见 §3），即正向回归对缺陷真实敏感、对修复真实转绿。

## 2. 谓词唯一性（全仓一份实现）

全仓 grep 核实（`isLearningEligible|learningFacingFilterOptions|isRewardVersionExact|isRewardVersionCompatible`，src/ 下 38 处命中）：

- 实现（唯一）：`src/jitrl/reward-contract.ts:453` `isLearningEligibleRecord`（叶模块，三检查：learningEligible≠false ∧ schema≥`LEARNING_MIN_EXPERIENCE_SCHEMA_VERSION`(=2，缺省 fail-closed) ∧ `isRewardVersionExact`）。
- 转发（非副本）：`decision-kernel.ts:733` `isLearningEligibleExperience` = 一行委托；`experience-store.ts:228` `isLearningEligible` = 一行委托。两者没有任何独立的过滤逻辑（对照 PR-A 前 store 侧存在第二份严格副本——已消除）。
- 消费同一实现：store.query `learningEligibleOnly`（experience-store.ts:981 → 228）、L1（jit-active-policy.ts:707 spread `learningFacingFilterOptions()`，decision-kernel.ts:769 施加）、L2 optimizer（index.ts:555）、replay（index.ts:833）、M3 `freshPolicySupport`（index.ts:890）、L3 host advisor store seam（index.ts:458）。
- 辅助分类器（`partitionByVersion`/`classifyExperienceVersion`，experience-store.ts:1213/1246）直接调用 `isRewardVersionExact`（同一兼容规则），非独立重推导——mirror/迁移与查询路径不会分叉。
- 等价性有测试钉住：`eligibility-contract.test.ts:682-698`「store-side and kernel-side predicates are the same rule (no second strict copy)」对 7 种判别性输入逐一断言两侧 verdict 相等；`strictTargetContractIds()` 声明式导出接受集（700-704）。

**结论：全仓恰一份 eligibility 实现，无第二份严格过滤副本。成立。**

## 3. 独立 mutation 重放（评审人亲手执行，非采信实现者记录）

| 突变 | 位置/做法 | 结果 | 恢复 |
|---|---|---|---|
| M-a 删谓词版本检查 | reward-contract.ts `isLearningEligibleRecord` 末行改为恒真 | eligibility-contract.test.ts **14 failed**/21：F1 全部入口（store/L1/replay/M3/L2/L3）、演练矩阵、hydrate/restart 一致性全部转红（如 restart 出现 `['p-r2','p-r3']`） | SHA 恢复为 `548effe3…`，与基线一致 |
| M-b 删 surrogate 隔离 | backfill.ts `learningEligible: false` → `true` | F2 探针测试 **红**（`expected true to be false`，544 行 learningEligible 断言先于查询断言触发） | SHA 恢复为 `14d9d5da…`，与基线一致 |
| M-c 注释 L1 过滤 | jit-active-policy.ts:707 spread → 显式两个 false | eligibility + jit-active-policy + reward-version-isolation：**2 failed**（F1 L1、演练 L1）；learning-filter-wiring（t28 转正）：**4 failed** | 文件恢复，`git diff` 对该文件与 PR-A 状态零差异 |

说明：M-b 下仅 1 条红是**设计使然**——隔离是双层防御（`learningEligible:false` 标签 + 认证表不含 backfill id）：标签层被测出转红；若实现者只回滚标签而保留认证表排除，查询仍隔离（M-b' 场景由 F2 describe 第一条测试单独钉住认证表不含 backfill id，526-528 行）。判别力充分。

恢复后：`pnpm test` 全量 **75 文件 / 1471 测试全绿**；`pnpm run typecheck` exit 0。

## 4. 五输入 × 四入口升级演练矩阵（核实一致）

`eligibility-contract.test.ts:731-781`（F3 drill）：五输入 = r2-JSONL / r3-current / missing-version / future-r4 / surrogate-history（719-727，`d-*` id）；四入口断言：

- store.query：仅 `d-r3`（732-737）
- L1：neighborCount 1、records 5、kept 1、V=−1（739-752）
- replay：neighborCount 1、V=−1、note `filtered 4 of 5`（754-760）
- M3：`usable 1`、`=1/10`（762-767）
- 谓词显式分类表：`[r2✗, r3✓, bare✗, r4✗, surr✗]`（769-780）

五个形状 × 全部入口行为一致（只留 r3-current）。矩阵真实覆盖五输入：`missing-version` 通过省略 rewardVersion 构造（213-216 有条件展开），`future-r4` 用 `r4/x`，`surrogate-history` 用 `BACKFILL_REWARD_VERSION` 且带 `learningEligible:true`（模拟历史未隔离行——即使标签为真也必须被认证表排除，这是最强的形状）。**一致，成立。**

## 5. 持久化重启邻居一致（有测试证明）

`eligibility-contract.test.ts:787-889` 两条，通过 `createJitRl().hydrate()` 真实 JSONL 路径（fakeFs 模拟 durable drive）：

1. 「old unmigrated lines are not silently mixed in after the drive swap」（814-861）：旧日志 2×r2 + 1 unversioned + 1 r3 → hydrate（drive 换成 JSONL + surrogate backfill）→ 严格查询仅 `old-r3`；durable 日志仍含全部历史行 + backfill 行（`BACKFILL_RECORD_PREFIX` 在场，证明是过滤而非删除/原地改写）；日志中每条 surrogate 行过单谓词均 false。
2. 「restart: reloading the same log reproduces the same neighbour set」（863-888）：两个 kernel 实例先后 hydrate 同一日志 → 邻居集合相等且恰为 `['p-r3']`，日志行数只增（追加式，不改写）。

独立佐证（评审人代码走读）：hydrate 经 `durable.load()` 直接载入（index.ts:380），不经过带 auto-stamp 的 facade append——历史无版本行不会被错误盖 current 章（否则 restart 一致性会假绿）；facade append 的 auto-stamp（index.ts:241-262）仅对「三个版本字段全缺」的新记录生效，已声明任何版本的记录原样透传，不relabel历史。读写对偶成立。**成立。**

## 6. 精确契约兼容（F2 语义核实）

- `REWARD_CONTRACT_COMPATIBLE_IDS`（reward-contract.ts:210-222）：`r3/unified-signals-v1` 认证集恰为 `[rescore id]`；`r3/backfill-tree-v1` 显式空表（注释说明 absent 的原因）；`isRewardVersionExact` 双向查表（对称）。
- `isRewardVersionCompatible` 改为纯转发 `isRewardVersionExact`（309-313），旧的 generation 前缀相等逻辑删除——F2 根因（前缀互信）已消除。
- rescore 通道：`isValidRescoreProvenance` 要求六字段全非空且 targetContractId=当前契约、aggregation=契约聚合、weightsHash=当前权重哈希（fail-closed）；`buildRescoredBackfillRecord` 不过则返回 undefined，provenanceVersion 六字段可解回（`parseRescoreProvenanceVersion`，测试 581-587 逐字段断言）。
- 负路径测试：缺 verifierId / 外来 aggregation / 外来 weightsHash / undefined 全部 fail-closed（603-635）。

## 7. 验证命令（评审环境）

| 命令 | 结果 |
|---|---|
| `pnpm run typecheck` | exit 0（0 错误） |
| `pnpm test` | exit 0：75 文件 / 1471 测试全绿 |
| `pnpm vitest run tests/unit/jitrl/eligibility-contract.test.ts` | 21/21 绿（独立重放） |
| M-a / M-b / M-c 三处 mutation | 各自必红（14 / 1+认证表钉住 / 2+4），恢复后全绿且文件哈希与基线一致 |

## 8. Findings

- **F-1（informational）**：M-b（仅回滚 `learningEligible` 标签）只有 1 条断言转红，是因为隔离为双层防御（标签 + 认证表排除）。判别力由 F2 describe 第一条（认证表不含 backfill id）与 M-a（谓词层）补全，整体充分。无需修改。
- **F-2（informational）**：`work/p61-evidence/runs/probes/reviewer.test.ts` 底部三条探针使用原机器绝对路径 import（`/data/repos/...`），在当前环境不可执行；正向回归的转换忠实性已通过逐行对照（§1）与独立重放核实。该文件属 P6.1 证据包（应保持原样），无需修改。
- **F-3（note，超出本 PR 范围）**：F3 缺陷（verifier 代理：非空错误交付物拿 completion=+1）的探针在证据包 919-923 行，属 PR-B/C 范围；PR-A 契约只绑 F1+F2。提醒后续 PR 评审时对照。

无 blocker / needs_revision 级发现。

## 9. 结论

PR-A 的六项验收全部核实：绑定完整（HEAD + diff 指纹 + 关键文件 sha256，含 t19 字节外注记）、探针转换忠实且全绿（评审人独立重放）、三处独立 mutation 必红且恢复后全绿、五输入×四入口矩阵一致、谓词全仓唯一、持久化重启邻居一致有测试证明。**Verdict: PASS**，t10（PR-A）评审通过，PR-B 可解锁。
