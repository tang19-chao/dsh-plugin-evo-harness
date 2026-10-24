# ADR 0001：P6.1 安全契约与边界裁定（D1–D4）

| 项 | 值 |
| --- | --- |
| 状态 | **accepted**（采纳，作为 P6.1 全部实现、测试与评审的设计依据） |
| 日期 | 2026-10-24 |
| 代码基线 | commit `7bce33e`（`7bce33ee9d102a6a05a35f080f606a8fd388e114`） |
| 决策来源 | 《dsh-plugin-evo-harness：P6.1 下一迭代方案与待决策裁定建议》第 3 节（D1–D4 裁定建议）与第 10–12 节（工作拆分、证据规范、明确不做） |
| 决策者 | P6.1 迭代团队（evo-p61-closeout；captain 批准执行） |
| 影响范围 | F9 安全契约默认值、invariant 隔离边界、审计归因 ID 语义、负收益下的发布边界 |

## 1. 背景与动机

P6.1 定位是**收口安全契约、解释学习负收益、完成真实宿主的受控验收**，不是重新打开 PR1–8 功能清单。基线 `7bce33e` 上，仓库外独立探针确认了三个待裁定事实：

1. **F9 匿名放行仍在**：`createDshHookHostAdapter()` 不提供 `hostAdvisorScope` 时，匿名 `{name:'bash'}` 落入放行分支可获得 advice 注入；collector 对无可证明 branch 的未知观察也写 `guidance:'memory'` 学习样本（基线时点：`src/cordis-seams/dsh-hook-host-adapter.ts` 约 :843–:907，`src/jitrl/host-tool-experience.ts` 约 :443–:503）。工具执行透传是其中**正确**的部分，不应修成 deny。
2. **PR4-L1 decisionId 语义**：meta／proposal 两类记录共用一次 L2 decisionId，第二轮评审已接受为非阻塞限制（`docs/reports/p6-review-round2-pr4.md` §3）。
3. **公平评测负收益**：同任务协议（episodes:5, rounds:3）中 online 相对 frozen 验证通过率差 −0.250，只限该合成实验；同时发现同轨迹存在两条评分路径（0.19 vs 0.20）。

本 ADR 将上述四项待决策事项（D1–D4）一次裁定清楚，使后续实现与评审不再各自演绎。

## 2. D1：F9 采用 Option 1——未知身份不学习、不注入，普通执行透传（采纳）

### 2.1 裁定

**采用严格默认（Option 1），不保留当前隐式 host-local 例外。**

- 未知身份的事件：**不注入 advice、不写学习样本**；
- 普通工具执行：**透传，不因 Jit 额外 deny、不额外 ask**（原宿主权限控制不变）；
- **不留**隐式 host-local 例外（基线中"匿名事件带工具名即放行 advice"的分支废除）；
- **不新增**默认开启的 `allowAnonymous=true` 之类开关。

理由：工具名只能说明调用了什么工具，不能证明该事件不属于 invariant 分支、另一个会话或另一个分支。身份不可证明时，记忆隔离必须先于功能可用性失效。

### 2.2 契约表（五行情事 × 三列裁定）

| 事件身份 | advice／gate 建议 | 可学习经验 | 普通工具执行 |
| --- | --- | --- | --- |
| 可信 registry 登记为 domain | 依配置允许 | 通过质量过滤后允许 | 仍受原宿主权限控制 |
| 可信 registry 登记为 invariant／reference 等无记忆轨道 | 禁止 | 不作为普通 memory 样本写入 | 保持原语义 |
| 有 branchId，但 registry 未登记 | 不注入 | 不写学习样本 | 透传，不额外 deny |
| 无任何身份，仅有工具名 | 不注入，不因 Jit 额外 ask | 不写学习样本 | 透传，不额外 deny |
| 只有 sessionId／namespace | 只有宿主能证明其覆盖范围并完成可信登记才允许 | 同左 | 透传，不因未知身份阻断 |

### 2.3 未知事件处理

未知事件可计数 `scope_unknown_skipped`，但**不保存工具参数／正文**，也**不**把它自动变成"可训练的 unknown bucket"（即不得将未知样本写入 `guidance:'memory'` 等任何可学习轨道）。计数只用于诊断与宿主契约校准。

**边界声明（R1 O1 补记，P6.1-A1c）**：`createHostToolExperienceCollector` **独立使用**（调用方未注入 `scopeRegistry`）时，collector 内部自建空 registry，带 `sessionId+branchId` 但未登记的事件仍判 `isKnown` 可学习（`resolveScope` 无 registry 走 `sessionId+branchId` 直读分支）——这是该模块独立测试口径的既有行为，**不属于** D1 违规：D1 严格默认在生产默认路径成立，因为生产路径**总是注入 registry**——`createEvoHarnessPlugin` 先创建 singleton `createScopeRegistry()` 并写入 `effectiveOptions`（`src/index.ts` `createEvoHarnessPlugin` 内，基线锚点 :1428–:1437；P6.1-A1c 格式修正后约 :1452–:1461），再经 `buildJitRlWiring` 的 `effectiveScopeRegistry` 传入 `createHostToolExperienceCollector`（基线锚点 :1327–:1336；格式修正后约 :1349–:1358）。R1 报告中 ":1400–:1405" 系锚点笔误（该处实为 `resolveExperienceFilePath`），本条以基线 :1428–:1437 / :1327–:1336 为准。

### 2.4 为什么不采用当前 Option 2

Option 2 把"真实宿主保证探针事件都带 branchId"当作先决条件，而 Gate 4 尚未验证该条件。功能缺省失效比记忆隔离缺省失效更容易控制：即使宿主暂时不提供身份，任务仍应能运行——只是该事件不参与 Jit（不注入、不学习），而不是获得隐式 advice 通道或隐式学习通道。

### 2.5 未来兼容路径

若普通宿主工具事件确实只有 sessionId（无 branchId），由**宿主适配层显式建立可信 host-session scope**（宿主证明其覆盖范围并完成可信登记，registry 按正常登记解析），使其进入契约表第 1 行语义。**不要**为此新增默认开启的 `allowAnonymous=true` 开关——这样既支持真实宿主，又不把任意 payload 自称当授权。该路径属于 Gate 4 能力清单项（宿主身份字段可用性、权限优先级），不是 P6.1 的默认行为。

### 2.6 必须同步修改面（D1 落地的一致性清单）

D1 不是只改一处分支，以下面必须**统一改为同一份裁定口径**，不允许只改测试名让 needs_revision 消失：

| 修改面 | 基线时点锚点 / 要求 |
| --- | --- |
| 代码 | `src/cordis-seams/dsh-hook-host-adapter.ts` 匿名放行分支（约 :882–:903：`total === 0` 带工具名返回 true、尾行"有 sessionId 即放行"）；`src/jitrl/host-tool-experience.ts` 未知观察写 `guidance:'memory'` 分支（约 :451–:499，含 `sessionId:'unknown'` / `branchId:'unknown'` 样本） |
| 注释 | 移除仍描述 Option 2 的注释：`dsh-hook-host-adapter.ts` :882、:889 一带的 "(PR3 / F9 Option 2)"、"Anonymous dispatch … (Option 2)"；`host-tool-experience.ts` :452 一带的 "Option 2 (F9)" 表述 |
| 测试名称与断言 | 匿名 `{name:'bash'}` 默认 dispatch：无 advice（`additionalContexts` 不含 advisor marker）但执行结果仍 allow；仅 sessionId 降级透传；测试名不得残留 Option 2 语义 |
| README | 相关段落与 D1 口径一致，不描述"匿名可获得 advice" |
| 状态诊断 | `scope_unknown_skipped` 计数不保存工具参数／正文；诊断口径与契约表一致 |
| Gate 4 能力清单 | HostCapabilityManifest 记录宿主可提供的身份字段（branchId/sessionId/namespace）可用性与权限优先级；host-session scope 登记作为显式兼容路径列入清单 |

## 3. D2：invariant 内容隔离与元调度学习分开定义（确认）

维持如下边界，两件事分开定义、不得混为一谈：

- **元调度（meta-scheduling）**：可以利用**合规经验**决定分配多少 invariant 槽位（预算决策）。
- **invariant 分支内容**：其 prompt、候选增广、工具 advice 与采集来源**不得跨入外部记忆内容**（内容隔离）。

研究对照的要求：若研究实验需要一条完全不受记忆影响的独立对照，应**固定该对照的调度预算**，而不是偷偷把生产 invariant 定义扩大为"所有元决策都不可使用经验"。

边界声明：本条是设计裁定，**不是**对当前所有间接信息通道已穷尽排查的声明。

## 4. D3：PR4-L1 decisionId 记录为已接受限制（确认）

- **事实**：meta／proposal 两类记录可能共用一次 L2 decisionId（基线 `src/orchestrator.ts` 约 :1906）；追溯仍可由 `level + runId + round + slotIndex + nodeId + parentNodeId + trajectoryId` 完成，现有消费者（experience-store 持久化／读回、commands 的 decision 对象）不按 decisionId 分组或 join。
- **裁定**：记录为**已接受限制（accepted limitation）**，不要求修复。仅当**新增按 decisionId 聚合／归因的消费者**时，才引入 `metaDecisionId`、`selectionDecisionId` 等显式语义。
- **不做**：不为改 ID 重开归因重构；不能用一个大范围 ID 迁移挤掉 F9 与 mirror 回显防护的优先级。
- 依据：`docs/reports/p6-review-round2-pr4.md` §3（第二轮评审已接受为非阻塞限制）。

## 5. D4：负收益不阻塞研究交付，但阻塞扩大默认启用（确认）

区分"研究可复现"与"默认启用"两个层面：

- **不阻塞评测工具／研究结果交付**：负结果是有效结果（本轮口径：同任务协议 online vs frozen −0.250，episodes:5, rounds:3，仅限该合成实验）。不得把 CI 改成必须跑出正收益，也不把负结果归因为模型能力不足或算法原理失败的证明。
- **阻塞扩大自动在线修正和自动热替换的默认启用**：本轮尚无真实收益证据，先保持 **baseline 控制执行 + shadow 记录建议**。
- **权限分层**：收集可信经验、记录反事实建议、实际改变执行、发布新策略是**不同权限**，不得隐式跃迁。
- **shadow ≠ jit off**：shadow 是 baseline 执行 + 建议记录；`off` 仍必须停止原契约约定的**七面活动**（PR2 RuntimeControl 七面），不得把 shadow 实现成变相 off。
- **默认关闭项**：真实试运行中 L3（host advisor gate）继续默认关闭，mirror 继续默认关闭；开启仅限测试 namespace／测试会话。
- **禁止**：用合成集调参最优点直接改生产默认值。
- 与第 11.3 节发布口径一致：安全契约（F9、provenance 链、诊断回显、PR5 复评、宿主身份契约）阻塞**扩大启用**；reward 标尺与负收益解释阻塞**学习收益宣传**；负结果本身属"非阻塞且需记录"。

## 6. 与 P6.1 工作项的对应关系

| 工作项 | 与本 ADR 的关系 |
| --- | --- |
| P6.1-A0（本 ADR） | D1–D4 的设计裁定输入，非代码变更 |
| P6.1-A1（F9 严格默认实现） | 落地 D1 第 2.1–2.3、2.6 节 |
| P6.1-A2（provenance 链端到端测试） | 守护 D1 契约表与可信登记链路（场景 ④ 即 D1 降级行） |
| P6.1-B1（mirror 无载荷诊断） | 与 D1 同属安全契约收口；其完成前不在真实业务 memory namespace 开启 mirror（对齐 D4） |
| P6.1-C（PR5 复评收口） | 绑定 SHA 复评；与 D3"不重开重构"同口径 |
| P6.1-D（RewardContract） | 解释负收益的前置；与 D4"负结果有效但阻塞默认启用"衔接 |
| P6.1-E（负收益解释） | 落实 D4 第 1 条：负结果可复现、可解释，不包装收益 |
| P6.1-F（真实宿主 smoke + RC 报告） | 落实 D1 未来兼容路径的证据面（HostCapabilityManifest）与 D4 受控发布边界（shadow RC 分层报告） |
| P6.1-R1/R2/R3（评审） | 以本 ADR 为设计依据核对实现／注释／测试名／README 一致性 |
| P6.1-G（P6_STATUS 状态表） | 已接受限制（如 D3）按 accepted limitation 列示 |

## 7. 本 ADR 明确不做

- 不为通过评审继续添加示例串专用脱敏正则（对齐源文档第 12 节）。
- 不通过降低测试强度／修改报告措辞隐藏 F9 行为。
- 不因先验在当前合成集满分就声称学习无用，也不靠人为调弱先验制造宣传收益。
- 不默认开启 L3 gate／mirror／自动 Jit 热替换。
- 不为 D3 改 ID 而重开归因重构。

## 8. 参考

- 源文档：《dsh-plugin-evo-harness：P6.1 下一迭代方案与待决策裁定建议》（第 3 节 D1–D4、第 10–12 节）。
- 基线代码：commit `7bce33e`；`src/cordis-seams/dsh-hook-host-adapter.ts`、`src/jitrl/host-tool-experience.ts`、`src/jitrl/scope-registry.ts`、`src/orchestrator.ts`。
- 历史评审：`docs/reports/p6-review-round2-pr4.md`（D3 依据）、`docs/reports/p6-review-round3-pr3.md`（F3-TEST／F9 缺口）、`docs/reports/p6-fair-eval.md`（负收益口径）。
