# t8 独立验证报告：C2a 可信证据闭环

| 项 | 值 |
| --- | --- |
| 任务 | t8（verification）— 独立验证 C2a 可信证据闭环 |
| 验证者 | gate-verifier（独立于 t5 实现者 verification-engineer） |
| attempt | 1 / `6b7e3a3d-d456-480a-9f36-be4be1f7a262` |
| 契约口径 | ADR-0003 §4（T1–T6、保守 A 真值表、双回执、原因码）、§4.6a 三条精度、§5（两门/审计编码）、§13.4 三项裁定 |
| 代码基线 | HEAD `9ea9b7e` + 工作树；**字节绑定见 §1** |
| 结论 | **PASS** |

> **立场**：不接受「`trustedSource === false`」作为拒绝证据（§4.6a(3)：它是**多因一果**终态），也不接受「shape 合法即可信」。所有结论以**宿主 runner 注册表身份 + 宿主重算 digest + attach 侧具体 reasonCode + 记录 track/eligibility/reward 列**为准。

---

## 1. 字节绑定（本 verdict 覆盖的修订）

| 文件 | sha256（前 16） | 备注 |
| --- | --- | --- |
| `src/verification/index.ts` | `a5361efc7c8b3e9d` | 新增模块 |
| `src/verification/types.ts` | `3a5efe99ba2bb30a` | 回执/绑定/原因码契约 |
| `src/verification/artifact-digest.ts` | `8bdfac7768abbbcf` | 宿主 sha256 |
| `src/verification/host-runner.ts` | `97ff4c19a421ee34` | 注册表 + 确定性检查 |
| `src/verification/attach.ts` | `f9ac270361f6b0d4` | 认证 / 审计编码 |
| `src/orchestrator.ts` | `de6439b083a42c83` | deps.verification 缝 + 两处 attach + 两门 + 标记 |
| `src/index.ts` | `afdfcafd710d2a29` | 仅事实诊断，无 config 开启面 |
| `src/cordis-seams/trajectory-collector.ts` | `2935f349dd02d9f7` | **有意零改动**（不透传 result.metadata） |
| `src/jitrl/step-evaluator.ts` | `50acb8b6fe8d8794` | 未改动（不在任何 inScope） |
| `src/jitrl/reward-contract.ts` | `6c42f29e1c212e66` | 未改动（r4 标尺不变） |
| `src/types/contracts.ts` | `e1ba3da9683b2475` | 未改动（未加宽，遵循 C2a-O1） |
| `scripts/eval/guarded-regression.mjs` | `9c151d5c7969e542` | +7 条 C2a 探针 |

> 说明：t7 的 C1.1 verdict 覆盖的是 `src/index.ts 6a3a5f37` / `src/orchestrator.ts 9a7a4f35` 的旧修订，**本报告绑定当前字节**（captain 明确要求）。

---

## 2. 门禁结果（全部独立复跑）

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `pnpm exec vitest run tests/unit/verification tests/unit/cordis-seams tests/unit/p62 tests/e2e` | **exit 0** — 22 files / **326 tests** |
| 2 | `node scripts/eval/guarded-regression.mjs --json` | **exit 0** — `{total:33, passed:33, failed:0}` |
| 3 | `pnpm run typecheck` | **exit 0** — 0 error |
| 4 | `pnpm test` | **exit 0** — 85 files / **1647 tests** |
| 5 | `pnpm run check:docs` | **exit 0** — README 计数 85/1647 与实测一致 |

C2a 专项探针（8 条）全部 `passed`：`C2a-trusted-boundary`、`C2a-host-runner-verdicts`、`C2a-forgery-and-misbinding-rejected`、`C2a-timeout-not-task-quality`、`C2a-audit-records-out-of-learning`、`C2a-task-quality-not-leaked-into-process`、`C2a-no-config-grant-and-offline-runner`、`C2a-scale-unchanged-by-trust`。

---

## 3. 独立探针：ADR §4.3 真值表逐行（自建，不复用 t5 夹具）

探针 `work/_t8-verify-c2a.ts` → `work/_t8-verify-c2a.json`；宿主 runner 用**真实检查函数**（`artifact.content === EXPECTED`），不用 mock 打分器。

| ADR 行 | 场景 | auditOnly | forceAuditOnly | verdict | reasonCode | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `succeeded` + trusted `passed` | **false** | — | passed | （无，正常附加） | ✅ 正向附加 |
| 2 | `succeeded` + trusted `failed` | **true** | **true** | failed | `falsified-success-claim` | ✅ 审计编码 |
| 3 | **`failed` + trusted `failed`** | **false** | false | failed | — | ✅ **可靠失败学习正例未被误扫** |
| 4 | `failed` + trusted `passed` | **true** | **true** | passed | `contradictory-verdict` | ✅ attach 侧拦截（scorer 不可达） |
| 5 | **`timeout` + trusted `failed`** | **true** | **true** | failed | `execution-not-completed` | ✅ 关闭 C-3/P-3 漏格 |

**行 5 的关键证据**：`scorerLearningEligible: true` 而 `taskQualityEvidence: false` —— 精确证明「`isLearningOutcome('timeout')` 仍为 `true`（冻结、未改），是 **attach 侧的 `forceAuditOnly`** 关掉了这格」。这正是 ADR §4.3 约束 1 要求的分工。

**行 1 的 T3 证据**：`deliverable.contentHash` 等于 `disposition.artifactDigest`，且形如 `sha256:<64 hex>` —— 宿主重算确实写回了轨迹，使 scorer 既有的 `expectedEvidenceHash` 比对分支在生产形态**真正生效**。

---

## 4. §4.6a 三条精度（ADR 明确要求 t8 验证）

### (1) 空 `checks` 在 attach 侧被拒 ✅
`isHostVerificationReceipt({... checks: [] ...}) === false`（探针 `precision1_emptyChecks.hostShapeRejectsEmpty = true`）。宿主 runner 构造期也拒绝空 check 列表（`host-runner.ts` 抛 `TypeError`）。**双层拒绝**，不依赖 `step-evaluator.ts`。

### (2) 未断言 FNV ≡ sha256 ✅
`hashString(EXPECTED) = dbef028f`（8 hex，FNV-1a）vs 宿主 `sha256:7eb89…`（71 字符）。探针断言二者**不相等**且宿主摘要恰为 `sha256:` + 64 hex。未出现任何跨轨迹哈希相等断言。

### (3) 旧 artifact / 错绑断言 **attach 侧原因码** ✅
| 攻击 | 观测 reasonCode | 判定 |
| --- | --- | --- |
| 同一轨迹换 artifact（旧回执） | **`stale-artifact`** | ✅ 非 `trustedSource=false` 式空洞 |
| runner 返回**未注册**回执 | **`unregistered-receipt`**，`attached=false` | ✅ registry 身份守卫生效 |
| 分支自报 `metadata.verification`（伪造 passed，artifact 实际错误） | 伪造的 `checks:['forged']` **被替换**为宿主 `['matches-expected-output']`；`verdict` 由 `passed` **翻转为 `failed`**；`evidenceHash` = 宿主 digest | ✅ 自报 payload 无法授予信任 |

> **实证说明**：我曾尝试构造「异 runner 回执 → `test-set-mismatch`」用例，实测得到 `unregistered-receipt`。查明原因是 attach **先**校验 registry 对象身份（`attach.ts:361`）**再**比较 `testSetId`（`:399`），而 `verifyAndAttach` 只调用**当前** runner 的 `verify()` —— 外来回执根本走不到 testSet 比对。这是**正确的 fail-closed 顺序**，不是缺陷；`test-set-mismatch` 需同实例回执被篡改才可达（由 t5 单测覆盖）。我把探针改为断言真实可达的 `unregistered-receipt`，而非硬凑一个不成立的预期。

---

## 5. 默认退化与「非 mock 伪闭环」

| 检查 | 观测 |
| --- | --- |
| 无 seam | 返回**同一对象**、**逐字节相同**、**无 disposition**（ADR §4.5.1） |
| 生产 e2e（`tests/e2e/c2a-trusted-verification.test.ts:179`） | 真实 `buildE2E` 插件 + 真实 `createHostOwnedVerificationRunner` + 真实 artifact：正确 artifact → trusted `passed`（auditOnly=false）；错误 artifact → trusted `failed`（`falsified-success-claim`，auditOnly=true）；reference 亦有回执；`artifactDigest` 匹配 `/^sha256:[0-9a-f]{64}$/` |
| 无 runner 时 e2e（`:236`） | 不附加、保持 C2-pre |
| 配置不可开启（`:255`） | 插件**从不**由 config 启用 runner |

---

## 6. 审计记录不进入学习邻域（§5.3）

| 观测 | 值 |
| --- | --- |
| 审计记录在无过滤查询中可见 | **1**（非空洞前提成立） |
| 在 `learningEligibleOnly` 查询中 | **0** |
| 该记录 reward | **0** |

⇒ 审计编码（`learningEligible:false` + reward 0）**结构性**排除在支持集/nEff 之外，不是靠新增过滤器。

---

## 7. 边界与未做

- 未跑真实模型、未付费调用、未写真实 memory、未部署、未 commit/push。
- 未改 `src/**`、`tests/**`、`scripts/**`；仅新增本报告与 `work/` 下（gitignored）探针。
- **C2a 只交付「可信记录闭环」**：`task-quality` 记录仍被全部生产消费者（`PRODUCTION_LEARNING_TRACK='process'`）预过滤，**C2b 质量消费者未接线**（ADR §5.4）。状态页不得声称「可信验证已生效于学习」。
- 未验证：真实多进程并发、真实 `runMaintenance` 分支、rescore/backfill seam（ADR §6 已冻结并登记 C2b）。
- **能力状态**：C2a = `implemented` + `wired` + `default_enabled` + `independently_verified`（本报告）；`release_authorized = ✗`。

---

## 8. 复现

```bash
pnpm exec vitest run tests/unit/verification tests/unit/cordis-seams tests/unit/p62 tests/e2e
node scripts/eval/guarded-regression.mjs --json
pnpm run typecheck
pnpm test
pnpm run check:docs

pnpm exec esbuild work/_t8-verify-c2a.ts --bundle --format=esm --platform=node --target=node20 --outfile=work/_t8-verify-c2a.mjs
node work/_t8-verify-c2a.mjs   # → work/_t8-verify-c2a.json, verdict=ALL_C2A_PROPERTIES_HOLD
```
