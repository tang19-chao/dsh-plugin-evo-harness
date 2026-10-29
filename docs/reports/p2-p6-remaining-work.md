# P2–P6 后续未执行任务清单

> 基线：`feb8465ded73ca48a770054c587990b93f54e21e`（2026-10-29）  
> 状态：P0、P1 及其远端 CI / Node 24 / mutation / attestation / 三平台 parity 已完成；**P2–P6 尚未开始**。  
> 本文只登记未执行工作，不重开已闭环的 P0/P1 审核项，也不把历史负结果改写成通过。

## 1. 总体执行顺序

```text
P0 已完成 → P1 已完成 →（P2 ∥ P3）→ P4 → P5 → P6
                    └──── 低风险遗留修正可与 P2/P3 并行，但不得写同一文件
```

| 里程碑 | 完成判据 | 当前状态 |
| --- | --- | --- |
| M2：效果可判别 | V3 有可辨别基线、生产一致过滤、预注册 holdout 与足够统计功效；L1 效应可解释 | 未开始 |
| M3：成本可计量 | 全阶段模型调用统一计量，默认观测不改变行为，estimated 与 measured 分列 | 未开始 |
| M4：宿主身份受控 | 身份/信任 ADR、mount 隔离、租约与工具面隔离通过；真实探针有明确授权 | 未开始 |
| M5：离线研究可控 | 合成测试独立信任层校准通过，仍不进入 r4 主奖励或在线可信质量轨 | 未开始 |
| M6：预算策略有证据 | 只用预注册 holdout 做最终检验，实测成本与 cache 口径充分，试验默认关闭可回滚 | 未开始 |

## 2. 可先行处理的低风险遗留项

这些项目不与 P2/P3 主任务耦合，可独立小批量执行；若涉及相同文件必须串行。

| ID | 任务 | 主要写入范围 | 验收与边界 |
| --- | --- | --- | --- |
| R-01 | `mapHostAdvisorStatus` 只转发七个公开计数字段，阻止额外适配器字段进入 status | `src/host-triggers.ts`、对应测试 | 注入额外 canary 字段不得泄漏；未采集仍省略字段，实测零值保留为 `0` |
| R-02 | 收敛 `skipped` 注释：明确未挂载 advisor 时的真实计数边界，不把“advisor off”笼统写成计数来源 | `src/types/contracts.ts` 注释 | 仅改注释，不改计数行为；可观测性测试保持通过 |
| R-03 | 在 ADR 中明确 `{config: null}` 是拒绝、显式清空还是继承宿主配置，并以测试固定选择 | ADR 0005、`src/index.ts` 及配置测试（若需要） | 不得静默改变安全开关语义；决定前先记录兼容性影响 |
| R-04 | `check:docs` 增加 `unit + e2e == total` 与测试根归属断言 | `scripts/verify-readme-counts.mjs`、对应测试 | 第三类测试目录或计数不闭合时明确失败；现有 Node 22 计数不变 |
| R-05 | 修正配置测试头注释中已由后续任务完成的 effort 校验描述 | `tests/unit/config/plugin-options-shape.test.ts` 注释 | 只改注释；effort 双路径校验行为不变 |
| R-06 | 评估 `attestation-target` 去除非必需 `pnpm install`，以及从工作树读记录时显式校验 HEAD blob 的一致性 | `.github/workflows/ci.yml`、`scripts/eval/check-attestation-target.mjs` 及测试 | 保持 fail-closed；浅克隆仍明确失败；不得放宽 ordinary/evidence 拓扑规则 |
| R-07 | 记录 M3 mutation 的准确口径：must-red 2/2、观测红 3，含 1 条额外判别用例 | 状态文档、报告 | 不把额外红写成注册的必红数，不修改变异判据 |
| R-08 | 收紧 `PARITY_PLATFORMS` 类型为字段级 readonly，与运行时逐元素冻结一致 | `scripts/eval/compare-platform-digests.d.mts` 及类型测试 | 类型检查与 parity 测试通过，不改变运行时形状 |

## 3. P2：可判别评测基座（与 P3 并行）

### P2-A：V3 任务与调度设计

- 新增任务，使至少部分任务满足 `required ⊄ prefs[:3]`，不能只通过减少轮数压低 prior。
- oracle 必须由任务表计算，不能硬编码 `oracleCoverage: 1`。
- 同时约束 baseline 与 oracle 的可判别空间；基线目标约 30–70% 是设计目标而非调参通行证。
- 每轮决策点需有多个 slot kind/候选动作支持，避免支持矩阵秩 1。

**验收**：固定池下 prior 与 oracle 均有非退化差异；每个关键决策点动作数 >1，并输出支持矩阵与秩断言。

### P2-B：对齐重放与生产语义

- fair/PR-4A 的 `runDecisionKernel` 使用与生产一致的 `learningFacingFilterOptions()`。
- 新记录使用 `r4/verifier-first-v1` 与正确权重，不得继续以 `r2/verifiable-v1` 充当生产可学习记录。
- 增加生产过滤后的存活数断言，禁止“全部 learning_ineligible”仍输出策略效果结论。
- 分级宿主验收器：可信 pass/fail 为主指标，部分得分只作独立诊断，不混入主奖励。

**验收**：重放记录在生产过滤下有可解释存活；基线/候选使用同一奖励标尺；任何全过滤失败明确中止实验。

### P2-C：预注册、development/holdout 与统计功效

- 在数据生成前冻结任务版本、划分规则、主要指标、排除规则、停止条件与 Holm 校正族。
- 预注册可拒绝性下限：当前小样本判别对不能拒绝时，必须写“结构上不可拒绝”而非简单 not-reject。
- 报告置信区间、coverage、改选率、平/负、效应量与统计功效。
- 保持历史负结果门禁、阈值与标签不变；V3 只能新预注册并列。

**验收**：holdout 未参与调参或候选选择；功效足以回答预定问题；全部估计量可复算。

### P2-D：L1 机制诊断与五臂重跑

- 用可辨别合成夹具验证：单动作支持时 `q ≡ V`、advantage 为零；多动作支持后 KL 可恢复。
- 区分“夹具侧已复现机制”与“生产根因尚未测量”，不得继续笼统归因为奖励饱和。
- 先在干净、固定 revision 上跑合成测试，再运行既有五臂对照；真实付费模型调用需单独授权。

**验收**：动作支持与效应可解释；生产重放契约一致；负结果可复现且历史报告不改写。

## 4. P3：C3 全阶段计量（与 P2 并行）

### P3-A：装配、导出与纯观测语义

- 在统一入口提供合法 `LedgerReservationManager` 装配/导出路径，避免 deep import 和直接构造测试绕过宿主入口。
- `agentLoop` 配置入口必须与 P1 的 26 键公开选项保持一致。
- 默认 observe 不得因预算拒绝、截断、改写工具结果或把探针结局改为 failed。
- 硬限额必须独立显式 opt-in，不复用其他权限开关。

**验收**：真实宿主装配路径可创建并观测；无 ledger 或未知语义不伪装成已计量；observe 下行为与无计量一致。

### P3-B：统一 `MeteredModelAdapter` 与调用边界

- 覆盖 proposer、composer、reflector、step-evaluator、offline-dreamer、logit-sources、agent-loop 与相关 bridge 路径。
- 按真实 `purpose` 标注阶段，纠正 probe 被误标为 compose 的问题。
- 静态覆盖检查同时扫描 `.complete(` 和 `planNext(`，直接未计量调用即失败；允许列表必须显式、可审计。

**验收**：所有生产模型调用可追溯到阶段与调用记录；静态扫描和运行时计数门均通过。

### P3-C：usage、语义来源与恢复

- `countingSemantics` 只能来自 provider/宿主元数据或明确 unknown，不能按字段名或模型名猜测。
- 取消/超时的两阶段结算、迟到 usage 对账和 WAL 恢复必须接入生产路径。
- `cacheRead` 不可得时保持 unknown，不用保守地板冒充实测。
- estimated 与 measured 成本分列；修正旧 PR-4A 强制 `measuredCount=0` 的反向门禁。

**验收**：真实/模拟 provider 元数据均可追溯；取消恢复不重复结算；只有实测值可进入成本 Pareto 轴。

## 5. P4：宿主身份租约与 mount/工具面隔离（等待 P2、P3 基座）

### P4-A：ADR 与紧急 mount 隔离

- 先确定身份、信任与授权模型，再实现；不得让 `sessionId` 暗中承担 branch identity。
- 无 `branchId` 时不得按共享 session 匹配探针 mount；优先修复 prompt mount 泄漏与 guardrail 越权 deny。
- 同进程不是沙箱；真实外部调用、记忆写入和多步探针继续要求显式授权。

**验收**：兄弟探针共享 session 时 mount 不进入宿主 assemble/pre-execute；缺失身份 fail-closed 并有结构化计数。

### P4-B：租约与 ScopeRegistry 完整性

- 有 agent 对象载体时使用 WeakMap 租约，TTL、清理与过期计数完整。
- invariant 在 key 级不可变；重复注册不能降级，旧 handle dispose 不得删除新登记。
- 只有可证明单占用时才允许 sessionId 租约；当前设计不能直接假定单占用。

**验收**：兄弟探针、并发复用 session、重复注册、旧 handle 延迟 dispose、TTL 过期与 adapter dispose 均有测试。

### P4-C：工具面与真实宿主 smoke

- 实施工具 allowlist 和隔离的 branch context；不得把 `ctx.fork` 或同进程执行描述成物理沙箱。
- 先通过契约/fake-host smoke，再申请真实宿主授权。
- 真实 smoke 覆盖 sibling、并发/复用、过期租约、清理和 mount 不泄漏。

**验收**：未授权真实探针保持 not-run；获批后 smoke 结果与授权边界、计数和回滚证据完整。

## 6. P5：HarnessPro 式离线合成测试（等待 P4，默认关闭）

- 仅用于离线 benchmark、development/holdout 和 Dreamer 候选评估；不得进入 r4 主奖励或在线可信质量输入。
- 建立独立 `synthesized-tests/v1` 信任层，初期 audit-only，不扩展冻结的在线学习轨枚举。
- 测试内容在候选生成前冻结；使用宿主可重算的 `sha256:<64hex>` 摘要与宿主 runner 回执。
- 校准失败召回、误判率、生成者/候选隔离和测试集来源；误判率指标需本仓自定分母与标签。
- 将 `ci-04|2|2 noop` 作为新性质诊断，验证不会错误固化基线行为，不重复宣称该用例尚不存在。

**验收**：独立信任层与校准报告完整；未校准结果不得进入 `task-quality`；不得把离线测试可信执行误作测试内容可信。

## 7. P6：Pareto 与预算钩子（等待 P2 + P3 实测数据）

- 先在 ADR 中统一“非劣”与“严格超越”的术语及作用位置；当前实现与文案存在差异。
- **holdout 只能按预注册用于最终优胜者检验，不得用于候选选择、Pareto 过滤或调参。**
- Lite/Medium/Heavy 只作预算档，不照搬论文权重为本仓最优值；探针数成本不得表述为货币成本。
- 预算提醒使用独立、默认 false 的权限开关，不复用授予 patch 权限的 `guarded-active`。
- post-execute 当前只有观察通道；如需提醒，优先研究 pre-step `additionalContexts`，不得假设可改写工具结果。
- 只 ask、不 deny；保留 shadow 对照和回滚开关，实测 cacheRead 可用时才评估 prefix cache 影响。

**验收**：holdout 未参与选择；成本真实可测；默认宿主行为不变；没有真实计量与隔离证据时不启用试验。

## 8. 每批共同验收与授权边界

### 本地必跑（按涉及范围增减）

```bash
pnpm exec tsc --noEmit
pnpm exec vitest run
pnpm run check:docs
pnpm run check:encoding
pnpm run check:build-smoke
pnpm run check:negative-result
pnpm run guarded-regression
pnpm run check:mutation
```

### 仍需明确授权的动作

- 修改 CI 门禁语义、提交和推送；
- 在目标代码提交生成 attestation，并以 `Attestation-Target: first-parent` 单独证据提交；
- 真实宿主 smoke、真实多步探针、真实外部工具或记忆写入；
- 真实付费模型调用或重跑五臂在线实验；
- 启用 guarded-active、预算提醒或任何会改变宿主默认行为的试验。

### 永久禁止

- 改写历史负结果、统计数字、阈值或标签以消除红灯；
- 把 CI skipped 当通过，把局部绿当整体绿；
- 把同进程执行称作沙箱，把 estimated 成本当 measured 成本；
- 用 holdout 做候选选择或调参；
- 把离线合成测试直接提升为在线可信 verifier 或主奖励。
