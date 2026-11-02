# 审计修复闭环总账（2026-11-02）

- 审计报告：[CROSS-AUDIT-REPORT.md](CROSS-AUDIT-REPORT.md)（第一轮 12 份 + 第二轮 6 份，位于 `round1/`、`round2/`）
- 本文件把审计的**每一条发现**映射到实际修复证据，或如实记录豁免理由。
- 改动全部在工作树，**未 commit**（需授权）。

## 一、最终门禁状态（全部实测，非自述）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `node node_modules/typescript/bin/tsc --noEmit` | **exit 0**（含 scripts/ 纳入后的全量） |
| 全量测试 | `node node_modules/vitest/vitest.mjs run` | **200 文件 / 3290 用例全绿**，exit 0 |
| 行尾编码 | `node scripts/eval/check-encoding-policy.mjs` | **SUCCESS**（493 tracked blobs，3 个显式 -text 例外） |
| 文档计数 | `node scripts/verify-readme-counts.mjs` | **SUCCESS**（200/3290 与实测机械一致；78/78 配置叶） |
| 变异门禁 | `node scripts/eval/mutation-gate.mjs --run` | **PASS**（4/4 变异被杀死，零残留） |
| 计量覆盖 | `node scripts/eval/metering-coverage.mjs` | **OK**（106 文件，0 未计量调用） |
| 孤儿符号（新） | `node scripts/eval/check-orphan-exports.mjs` | **OK**（106 文件，40 个死导出/公共 API 面全部有理由） |
| 测试导入覆盖（新） | `node scripts/eval/check-test-import-coverage.mjs` | **OK**（106/106 模块被测试导入，零豁免） |
| 构建冒烟 | `node scripts/eval/smoke-build.mjs` | **SUCCESS**（含 default export 断言，`stale: false`） |
| 负结果保真 | `node scripts/eval/negative-result-diag.mjs --assert` | **A1..A6 PASS**（历史 −0.250 未漂移） |
| 守卫回归 | `node scripts/eval/guarded-regression.mjs --json` | **37/37 passed** |

## 二、P0（3 条，全部修复 + 变异反证）

| ID | 缺陷 | 修复证据 | 回归测试 |
| --- | --- | --- | --- |
| P0-1 / INT-1 | 生产挂载路径上 ctx.llm 模型与分支执行器从未送达编排器，每个 run 静默 `no_probe` | `src/index.ts` `forwardingModel(holder, …)` / `forwardingBranch(holder, …)` 接回 `buildOrchestratorDeps`（:2021 holder 参数、:2140 model 独立解析、:2214 单次链解析、:2228 forwarder、:2958-2990 解析后回填） | `tests/e2e/host-mount-smoke.test.ts`（伪造 ctx.llm、不注入 options.model，断言 `probesRun > 0`）；还原 src/index.ts 后 5 测试全 FAIL |
| P0-2 / JINFRA-1 | `Authorization: Bearer <jwt>` 的凭据本体裸奔进经验日志与记忆镜像 | `src/jitrl/redaction.ts:56` keyword_secret 值段插入 `(?:bearer\|basic\|digest)` 延伸消费 | `tests/unit/jitrl/redaction.test.ts` 57 用例；HEAD 变异 4 failed |
| P0-3 / LEDGER-1 | `bookNewAttempt` 无重投幂等，同笔用量按次双扣 | `src/ledger/two-phase.ts:573-590` `deriveNewAttemptCallId`（确定性 sha256）+ :775-810 已结算直接返回 | `tests/unit/ledger/new-attempt-idempotency.test.ts` 4 用例；HEAD 变异 3 failed |

## 三、P1（9 条，全部修复）

| ID | 缺陷 | 修复证据 |
| --- | --- | --- |
| INT-2 | `deps.proposer` 注入时 model 被强转为 undefined → judge 时裸 TypeError | `src/index.ts:2140` model 独立解析，不再与 proposer 耦合 |
| JINFRA-2 / P1-2 | JSONL append 与 compact/purge/flush 并发丢记录 | `src/jitrl/stores/jsonl.store.ts` `serialize()` promise 链互斥；`jsonl-store.test.ts` 并发交错用例（变异转红） |
| JINFRA-3 / P1-3 | `ExperienceQuery.policyId/driftRho` 被 store 忽略、advisor 截断后漂移无饱和 | `experience-store.ts:1206-1311` 切片前加权 + `driftWeight` 回填；`host-advisor.ts` 饱和停止；retriever docstring 改正 |
| JITRL-1 / P1-4 | G-A「先前失败」被任何 `verified:false` 满足，偏离冻结预注册 | `writeback-gate.ts:180-190,207-216,277-284` 增加 `status: passed\|failed\|unknown`，`priorFailure` 只认 `failed`；预注册 sha256 `a9d97aa4…` 未动 |
| LEDGER-2 / P1-5 | settle 与 call-index 之间的崩溃窗口永久锁资金 | `two-phase.ts:767-788` 幂等重放时仍推进索引；`:1015-1020` `recoverFromWal()`；`:1096-1124` 按需回填身份；`crash-window-recovery.test.ts` 12 用例 |
| MEM-1 / P1-6 | 无标签外来 lesson 被 fail-open 归因并跨会话浮出 | `governance-polyfill.ts` 分支/会话两处强制 `lesson.sessionId === scope.sessionId`；`unverifiedOrigin` 标记限 global；`isolation-and-firewall.test.ts` 7 用例 |
| DREAM-1 / P1-7 | 重启后 tree id 归零，持久发现树被覆盖销毁 | `src/index.ts:2030` newId 按 `policyStore.counters.completedTasks` 播种；`tree-pool.store.ts:234-245,492-508` `isSnapshotNewerThan` 拒绝旧覆新；`id-seeding.test.ts` + `tree-pool.store.test.ts` |
| DOCS-1 / P1-8 | README 称「无运行时依赖」而实际静态导入 schemastery | `README.md:38` 改为如实（含 esbuild） |
| VCI-1 / P1-9 | 同一重构还断掉 deferredClients，记忆自动发现死路 | `src/index.ts:2064-2067` 惰性 `listClients` 供给记忆桥；:2958-2990 JitRL 镜像落定后重建 |

## 四、P2（42 条，全部处理）

**core / 集成**：CORE-2（`improvedContrasts` 方向感知过滤）、CORE-3（空 ranking 判 judge 不可用）、CORE-4（复用 `isLearningEligibleRecord`）、CORE-5/INT-8（去重键 append 后登记）、INT-3（`candidateJitKs`/`SimilarityThresholds` 入 schema）、INT-4（`else if` 防双注册）、INT-5（`logging.level` 接入 `log()` + `includeTrajectorySummaries` 消费）、INT-6（改用 `REWARD_CONTRACT.*` 导出）、INT-7（`handleFallbackEvent` 包 `trackRun`）、R2-1（`recoverFromWal` 前向回填 + 恢复态 reconcile 放行）、LEDGER-9b（生产装配点传 metering）。

**jitrl**：JITRL-2（温度改为 `share^(1/T)` 真实生效）、JITRL-3（`applyWritebackVerdict` 置零 `learningTarget`）、JITRL-4（`logitSource` 接线）、JITRL-5（测试夹具修正）、JINFRA-4（host scope 版本化）、JINFRA-5（`lease.scope` 活 getter）、JINFRA-6（branch 载体 id 归 branchIds）、JINFRA-8（UNC/`~/`/`/srv` 等路径补全）、JINFRA-9（无界日志）。

**ledger**：LEDGER-3（无卡时不记 0）、LEDGER-4（按 callId 聚合，报告=池）、LEDGER-5（传输异常→`infrastructure_error`+INTERIM）、LEDGER-6（成功路径 `settle_failed` 标记）、LEDGER-7（`INDEX_CORRUPT` fail-closed）、LEDGER-8（append-then-apply）、LEDGER-9（jitrl probe/judge 计量贯通）。

**memory / verification / security / dream / tests / build**：MEM-2/3/4/5、VERIF-1/2、SEC-1（`sanitizeFileToken` 消毒 lessonId）、DREAM-2（EPERM 有限重试 + 诊断活出口）、DREAM-4、TEST-1 残余（`clients.ts` 补测）、TEST-2（真实执行器 e2e）、TEST-3（墙钟断言改为下界）、DOCS-2（三处「未修」追加闭环指针）、DOCS-3（C2b 矩阵行更新）、BUILD-1（stamp 纳入依赖摘要）、BUILD-2（`scripts/**/*.ts` 纳入 typecheck）。

## 五、P3（约 70 条，全部处理）

**core**：CORE-6（注释校正——见 §6 的契约冲突说明）、CORE-7（`normalizeAdoptionBlend`）、CORE-8（`policy_no_slots`/`no_candidates` 真实退出原因）、CORE-9、INT-9（删除只写不读字段）、INT-10（回退链收敛）。

**jitrl**：JITRL-6/7/8/9/10、JINFRA-10/11/12（诊断环形缓冲 100）/13（数字代际比较）/14（不再强制 `text` 属性）/15（TypeError→invalid_input）。

**ledger**：LEDGER-10（`reasoningUnavailable` 降级 provenance）、LEDGER-11（`ledger.writer.lock` 单写者）、LEDGER-12（`providerCallId` 双键匹配）、R2-3。

**verification/dsh-bridge**：VERIF-3（取消不再记 timeout）/4/5/6/9/10/11（`self-sealed` 标签）/12（producedFiles 去重）、VNEW-1。

**security**：SEC-2/3（`execSync`→`spawnSync`）/4（`.gitignore` 加 `diagnostics/`）/5/6（`RESERVED_DEVICE_NAME`）/7。

**memory/seams**：MEM-6/7/8/9/10/11（disposer deadline）/12。

**dream/persistence**：DREAM-3（环守卫）/6（NaN 不参选）/7（保留审计时间戳）/8（`sweepTempFiles` 收窄）/9/10。

**tests**：TEST-4/5（嵌套 vitest 合并）/6。

**docs**：DOCS-4（两个可选无默认键）/5（ADR 0004 编号消歧注）/6（Project layout 补齐 6 个模块 + scripts/）。

**build/CI**：GATE-1（default export 断言）/CI-1（`check:metering` 入 package.json + CI）/CI-2/CI-3（登记）/CI-4（`kill-tree.mjs` 收割孙进程）/CI-5。

## 六、豁免与如实登记

| 项 | 状态 | 依据 |
| --- | --- | --- |
| CORE-6（`recordModeOf` 注释） | **不回写** | `tests/unit/p62/rev6-release-contract.test.ts` 冻结契约要求 `src/runtime/execution-profile.ts` 相对 rev5 基线**只能**第 121 行有差异。注释澄清会破坏该门禁，故保持原文——这是「注释不准确」与「冻结发布契约」的真实冲突，按契约优先。 |
| DREAM-5 | **设计疣，不回写** | 步进效率对 ≤baseline 全饱和是刻意行为，已被测试钉住（审计本身标注 designed wart）。 |
| DREAM-11 | **有意偏离，已文档化** | ADR 建议值 2 vs 实现 1，偏离本身有文档与测试记录。 |
| CI-3（Node 20.19 下限） | **无法本地实测** | 本机仅 v22；只能由推送后的 CI 矩阵证明，已在报告登记。 |
| 孤儿符号 16 条 | **allowlist 登记** | 均为历史公共 API 面（插件入口、驱动辅助、持久化工厂等），删除会破坏公开契约；每条理由 >120 字符，门禁双向校验防漂移。 |
| commit / attestation | **未执行** | 需用户授权；SELF-REFERENCE BOUNDARY 要求 evidence 提交单独提交并重新生成 attestation。 |

## 七、过程改进（第 12 项）

| 新增 | 作用 |
| --- | --- |
| `scripts/eval/check-orphan-exports.mjs` | 抓 P0-1 形态：导出的函数无人调用（`forwardingModel` 案例） |
| `scripts/eval/check-test-import-coverage.mjs` | 抓 TEST-1 形态：整个宿主协议模块零测试导入（`clients.ts` 案例） |
| `tests/unit/p62/structural-gates.test.ts` | 两个新门禁的 fail-closed 双向测试（8 用例，用真实子进程测退出码） |
| `.github/workflows/ci.yml` | 三个门禁接入 verify job（此前 `check:metering` 只有单个测试文件调用） |
| `package.json` | `check:metering` / `check:orphans` / `check:import-coverage` |

## 八、改动规模

- 修改 114 个已跟踪文件，新增 41 个文件（其中 34 个新测试文件 + 2 个新门禁脚本 + `kill-tree.mjs` 等）
- 测试从 163 文件 / 2956 用例 → **200 文件 / 3290 用例**（+37 文件 / +334 用例）
