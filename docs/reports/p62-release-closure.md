# P6.2 首轮收口报告（C0+C1：ADR / 契约修复 / 默认安全形态 / r4 原子切换）

> 角色：t3（release-integrator-ds，交付集成）。
> 依据：ADR 0002（`docs/adr/0002-p62-release-contract-and-default-safe-shape.md`，accepted，t6 修订版）与 `docs/P62_STATUS.md`（t3 终态版）。
> 性质：**集成收口报告**——汇总实现（t4）、独立验证（t2）、两轮独立评审（t5/t11 的 needs_revision 与 t7/t10/t12 的修复）、限定独立复核（t13，verdict=pass）的最终状态与证据；不是新的验证，也不替代任何人的结论。

## 0. 结论摘要

| 项 | 结论 |
| --- | --- |
| 本轮范围 | 仅 C0（契约/字段/资格修复）+ C1（默认安全形态 + r4 原子切换），见 ADR §2 |
| 代码交付 | **是**（工作树交付，代码/测试/脚本面 24 modified + 6 untracked；t3 另加 1 份未跟踪报告 → 终态 24 modified + 7 untracked；未 commit/push） |
| 七条门禁 | **全绿**（t13 独立复跑；t3 终态复核一致，见 §3） |
| 独立复核 | t13：**verdict=pass**（无阻塞），绑定 HEAD `d2f8025` + diff 指纹 `e1da67b4…`，四项断言独立复现 |
| 默认形态 | 声明默认 `execution.mode=shadow`（宿主 baseline 行为不变 + 建议记录）；patch/publish/memory 恒 deny；guarded-active 仅显式启用 |
| r4 原子切换 | **已交付**：`r4/verifier-first-v1` 七处一次切换，数值标尺冻结；可信生产者缺席 = 保守隔离（不代表 C2） |
| C2–C4 | **未执行**（不在本轮范围；入口与前置见 §6） |
| D（部署/真实试验） | **未执行**，需用户另行授权 |
| released | **恒为否**（未发布、未部署、未 commit/push） |
| 真实收益声明 | **无**。本报告只证明机制与默认安全形态，不宣称任务收益；research-v1 历史负结果原样保留 |

## 1. 绑定指纹（终态）

| 项 | 值 |
| --- | --- |
| HEAD | `d2f80254a51a9e927100d02b00703badcb963ffe`（`d2f8025`） |
| 工作树 diff 指纹（tracked） | `e1da67b4fa06d6ce885a848469652b79cb9fed7f`（`git diff \| git hash-object --stdin`；只覆盖 HEAD 已跟踪文件） |
| 代码面内容指纹（含未跟踪） | `c9faeeb43581a4aad515d4f7ae565f242236afc6805e021f07434b56215d604c`（`src/`+`tests/`+`scripts/` 共 182 文件，`路径:sha256` 排序后取 sha256） |
| 工作树构成 | 代码/测试/脚本面 24 modified + 6 untracked；t3 另加 `docs/reports/p62-release-closure.md`（未跟踪）→ 终态 24 modified + 7 untracked；`24 files changed, 1870 insertions(+), 252 deletions(-)`；无删除、无越界目录 |
| ADR 0002 | sha256 `95A7126B18499D20…`（t6 版；t3 未改动，与 t13 绑定值一致） |
| P62_STATUS | sha256 `50961A61A5672393`（t3 终态版；取代 t1/t6 版 `4516125B3D60DCF6…`） |
| 提交/发布状态 | **未 commit、未 push、未部署**（工作树交付） |

关键文件 sha256 与逐项状态见 `docs/P62_STATUS.md` §3/§2。

## 2. 交付内容（机制级事实）

1. **C0-1 nEff 全链**：orchestrator / L1 / L2 / replay 保留并共报 nEff；替换判定**只认 nEff**，缺失即 fail-closed（support 不得冒充）。
2. **C0-2 统一 evaluation**：recorder 单源消费同一 evaluation 派生的 reward/eligibility/taskSuccess/executionSuccess；C2 前 shape-only passed/failed 不建立 task-quality 学习资格。
3. **C0-3 显式字段**：每条记录显式携带 `decisionMode` / `actionKeyVocabulary` / `rewardVersion`；replay/restart 以声明口径重建，缺省 fail-closed。
4. **C0-4 替换策略**：`src/jitrl/replacement-policy.ts`（新）承载硬否决 / 薄证据不替换 / 显式探索预算 / nEff-only 判定；**默认 shadow 下保守门不调用**（仅 guarded-active 打开；estimation 仍每决策测量并记录强度）——故 default-enabled=✗。
5. **C1-1 r4 原子切换**：`CURRENT_REWARD_VERSION='r4/verifier-first-v1'`、`PREVIOUS_REWARD_VERSION='r3/unified-signals-v1'`、schema=2、provenance=`p2/per-execution-v1`；旧 r3/r2/surrogate/future/missing 自动隔离；rescore 通道 `r4@rescore-v1` 需完整 provenance；标尺冻结（权重/clip/minEff/k/scale 未变）。
6. **C1-2 默认安全形态**：默认 shadow；`applyWinningPatch` 双条件派生（请求 ∧ patch 权限，默认均 false）并在挂载点二次校验；guarded-active 仅显式；publish 恒 deny 且**代码内无调用点**；memory 恒 deny 且 **deny 时调用点直接不调用 memory bridge**（t12）。
7. **C1-3 门禁套件**：`scripts/eval/guarded-regression.mjs --json`（25 探针）+ `tests/unit/p62/release-contract.test.ts` 等回归。
8. **单一 effective profile（t12/R1c）**：`buildOrchestratorDeps` 先解析唯一 `effectiveProfile`，orchestrator、L1 `interceptExecution`、dream replay 声明与诊断**同源**；注入 profile 与 config 不再分裂。
9. **replay 声明（t10/R3b + t12/R3b2）**：工厂 `createReplayHook` 逐字段 `caller ?? 默认`（调用方优先）；生产 dream 以 effective profile 派生声明；未声明生产者记录 fail-closed 排除且不被改写，排除数进诊断。

## 3. 门禁结果（七条，真实退出码）

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `pnpm run typecheck` | exit 0（0 error） |
| 2 | `pnpm test` | exit 0；**77 files / 1562 tests** all passed（unit 66/1411 + e2e 11/151） |
| 3 | `pnpm run check:docs` | exit 0；README 77/1562 与真实 vitest 精确一致 |
| 4 | `pnpm run build` | exit 0（lib/index.js，gitignore 产物） |
| 5 | `node scripts/eval/negative-result-diag.mjs --json` | exit 0；`meanDelta=-0.25`、`matchesHistorical=true`、`degradedTaskShare=0.4167`、退化任务 `ci-04/mig-01/mig-02/mig-04/test-03` |
| 6 | `node scripts/eval-jitrl.mjs --json` | exit 0；`episodes=5`、`taskCount=12`、`deterministic=true`；未实现 ablation 如实列出 |
| 7 | `node scripts/eval/guarded-regression.mjs --json` | exit 0；`{total:25, passed:25, failed:0}` |

本报告的门禁结论来自：t13 的独立复跑（评审前后工作树逐字节一致）与 t3 终态复核（文档改动为 docs-only，不进入 `src/tests/scripts` 代码面指纹，故 `c9faeeb4…` 与 §1 所列代码文件哈希在 t3 前后不变）。

## 4. 轮次与 findings 处置

| 轮次 | 执行者 | 结论 | 处置 |
| --- | --- | --- | --- |
| t1 | release-architect | ADR 0002 + P62_STATUS 初版（requirements pass） | 契约冻结输入 |
| t6 | release-architect | ADR 修订（废除 `applyWinningPatch` 豁免、收紧 C2 前可信边界、门禁统一七条） | 契约口径以 t6 版为准 |
| t4 | core-implementer | C0+C1 实现完成 | 七处原子切换、默认 deny、replacement-policy、guard-regression 脚本 |
| t2 | gate-verifier-glm | 验证完成；七条门禁全绿，并如实登记五项边界探针 findings **V1–V5** | V1 patch 越权缺口、V2 shadow+conservativeGate、V3 unknown 消费侧、V4 noop 按类型、V5 公开字符串注册器 |
| t5 | independent-reviewer | **needs_revision**（12 findings，含 V1–V5） | 移交修复；V1–V5 由 t7 关闭并固化为生产回归（t11 复述「V1/V2/V4/V5 无回归」）；其余项以团队任务记录为准，本报告不逐条复述证据链外的条目 |
| t7 | gate-verifier-glm | 修复独立验证发现的五项发布边界问题（V1–V5），attempt 3 | V1 patch 双条件门 + 挂载点二次校验；V2 shadow/baseline/off + `conservativeGate` 构造即拒绝；V3 task-quality 轨道拆分；V4 noop 按证据；V5 移除公开字符串注册器——均固化为生产回归 |
| t8 | gate-verifier-glm | repair-round-2 完成（依赖 t7） | 关闭 t5 的其余 R1–R7（off/baseline/shadow 真接线、memory 权限、replay/restart 字段消费、shadow 记录强度、grant/revoke 公开接口与 reservation 幂等），复查 V1–V5 无回归；决定性探针固化入门禁 |
| t9 | independent-reviewer | **needs_revision**（8 findings，1 blocker） | `R2-memory-permission-not-enforced`、`R1b-baseline-still-intercepts`、`V3b-taskQualityField-vs-track`、`R3b-replay-declarations-capability-only`、`COV-self-referential-probes`、`CFG-deps-profile-override`、`DEAD-settle-reservation-nonidempotent`、`PUBLISH-no-enforcement-point` |
| t10 | core-implementer | repair-round-3 完成；8 项关闭，七门禁全绿（77/1556） | baseline 真接线、taskQualityEvidence 拆分、replay 声明接线、死方法删除、publish 诚实化 |
| t11 | independent-reviewer | **needs_revision**（5 findings，1 blocker + 1 high） | `R2-residual-memory-deny-not-at-call-site`(blocker)、`R3b2-replay-declaration-option-overridden`(high)、`COV-t10-probes-self-satisfying`(medium)、`R1c-mode-source-of-truth-split`(medium)、`NOTE-remaining-semantics-nits`(low) |
| t12 | release-integrator-ds | **收尾修复完成**；5 项全部落地，七门禁全绿（77/1562） | ①memory deny 调用点前阻断（零桥调用、删 ephemeral、修正诊断）；②工厂声明合并顺序 + 真实 dreamer 传递；③单一 effective profile；④恒真探针替换为方向断言；⑤未声明生产者不升级、publish 不称生效 |
| t13 | independent-reviewer | **verdict=pass**（限定复核，非新质量循环） | 四项断言独立复现；七门禁复跑全绿；绑定 HEAD+diff 指纹；残余非阻塞项移交 t3（本报告 §5/§6） |
| t3 | release-integrator-ds | **本报告**（集成收口） | 五状态如实登记；限制/计划项/授权边界登记；未改 ADR、未改 src/tests/scripts、未 commit/push |

t11 的 blocker 关闭证据（t13 独立复现，非自述）：四模式 + 手建默认共 5 套装配、注入「接受任意作用域」的桥后 `bridgeCalls=[]`（零 commit/promote）；mirror 客户端 0 次 `listTools/callTool`；后端记录 0；诊断 `'N lesson(s) NOT committed … the bridge was not called'`；无 `ephemeral`；正控（显式 `memoryRealWrites`）走真实 governed 作用域 commit+promote。

## 5. 已知限制（不构成完成项）

1. **C2 前无可信验证来源**：只有 `TrustedVerification` shape + 结构/hash 校验；可靠失败学习未解禁（C2 未完成项）。
2. **R8 声明分区排除未声明生产者**：L3 host_tool 采集与 cold-start backfill 的存量记录无 `decisionMode/actionKeyVocabulary`，在声明式 replay 中被 fail-closed 排除（不改写为当前模式）；排除数已作为 dream 诊断输出。
3. **publish 无调用点**：权限位恒 false，仅报表/诊断常量——不得表述为「发布门已生效」。
4. **字段命名歧义**：`taskQualityLearningEligible` 对 unknown 为 true（消费门；FACT 是 `taskQualityEvidence=false`），重命名留 C2 前清理。
5. **C0-4 保守门默认不调用**：默认 shadow 下仅 estimation/记录生效。
6. **ADR 文本待裁定项**：ADR §13 第 2 条多一个「不」（自相矛盾）、§3 shadow 行需补 t10 裁定、§4 memory 行需补「调用点不调桥」、§5.2a/§6 unknown 字段实况、publish 无调用点——清单见 `docs/P62_STATUS.md` §7。**t3 未改 ADR**：`docs/adr/` 不在 t3 inScope（仅 `docs/P62_STATUS.md`、`docs/reports/`），且就地修改 accepted ADR 属契约变更、会改变 t13 绑定的 `95A7126B…` 指纹，需 captain 重新裁定后方可执行。
7. **研究路径**：research-v1 两臂版本戳冻结；历史负结果（meanDelta −0.25 等）原样保留，不淡化、不宣传收益。

## 6. 未授权与未执行事项

- **C2/C3/C4 未执行**。C2 的边界在 ADR §9 冻结（只补可信验证来源、不改 r4）；C3/C4 在仓库文档中没有冻结的验收口径与文件范围——**入口先决**是 captain/用户给出其口径（沿 ADR §11.2 的「越界须回 captain 重新裁定」机制），其后每阶段仍需独立验证 + 独立评审 + 七条门禁。具体前置条件与「可并行准备」清单见 `docs/P62_STATUS.md` §8。
- **D（部署/真实试验决定）需用户另行授权**；本轮未做。
- **未执行**：真实模型/付费调用、真实 memory 写入、发布/部署、`git commit`/`git push`。
- 验证与评审过程零网络、零付费、零真实 memory 写（探针全部使用 mock/fake 后端）。
- 工作树不含评审临时文件、真实凭据、memory 数据或无关 `outputs/` 改动（`outputs/`、`work/`、`.agent-teams/` 均在 .gitignore 内且本轮未改动）。

## 7. 附：证据复现指引

```bash
# 绑定与指纹
git rev-parse HEAD                                   # d2f80254a51a9e927100d02b00703badcb963ffe
git diff | git hash-object --stdin                   # e1da67b4fa06d6ce885a848469652b79cb9fed7f
git status --porcelain                               # 24 M + 7 ??（含本报告；代码/测试/脚本面为 24 M + 6 ??）

# 七条门禁（ADR §11.1）
pnpm run typecheck
pnpm test
pnpm run check:docs
pnpm run build
node scripts/eval/negative-result-diag.mjs --json
node scripts/eval-jitrl.mjs --json
node scripts/eval/guarded-regression.mjs --json
```

> 本报告不宣称任何真实任务收益；released 恒为否；C2–C4 与真实授权试验均未执行。所有结论以 ADR 0002 冻结口径与上述绑定指纹为准。
