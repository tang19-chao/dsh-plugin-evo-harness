# rev6 R2-3 / R4：cacheRead 计量与召回 shadow 观测

- **任务**：`evo-harness-rev6` / `t12`（R2-3 cacheRead 计量 + R4 前置观测）
- **attempt**：`c2814801-b2d9-4a03-9a63-73af967ec292`
- **作者**：integrator
- **基线**：`HEAD = 97e38db37305b24f695a5f989428b3611f84987c`，工作树未提交（G12）
- **可复跑命令**：
  ```powershell
  node scripts/eval/rev6-cache-observation.mjs --json            # 机读报告
  node scripts/eval/rev6-cache-observation.mjs --markdown        # 本文第 1–4 节
  node scripts/eval/rev6-cache-observation.mjs --json --require-gated   # CI 反证：门必须保持关闭
  ```
- **一句话结论**：本仓**没有** measured cacheRead 数据（900 个样本全部 `estimated`，cacheRead tokens 恒 0，测量成本调用 0/180×5 臂），因此 Tail Injection 保持 **`gated-not-applicable`**；`whenToApply` 正滤在 shadow 下命中率 40.0%、误伤率 50.0%，**不启用**、不真实写入。

---

## 0. 本报告是什么 / 不是什么

**是**：一份可复跑的观测记录。每个数字都来自 `tests/fixtures/pr4a/pr4a-five-arm-eval.json`（rev5 冻结产物，`f22bdb14…`/365,314 B）与两个新模块的**实测输出**；命令、退出码与判定理由都写在下面。

**不是**：
1. **不是 A/B 结果**。本仓从未产生 measured cacheRead 流，所以没有可比较的两个臂。伪造一个 A/B 是本报告明确拒绝的行为。
2. **不是收益声明**。`gated-not-applicable` 的含义是「按现有数据无法判断」，不是「缓存无用」，也不是「缓存有效」。
3. **不是启用决定**。`whenToApply` 正滤保持默认关闭；本报告只度量，不激活（见 §4）。
4. **不是真实宿主/付费证据**。全程无网络、无模型调用、无付费 API、无记忆后端读写。

---

## 1. 为什么 `estimated` 不能算 `measured`

这是本任务的核心判据，也是 rev5 P3-C 已经立下的规则：**estimation 与 measurement 混成一个数字，就是一条虚假的财务声明**（`src/ledger/usage-report.ts` 的头注释）。

本仓的具体事实（逐项实测，见 §2）：

| 事实 | 值 | 含义 |
| --- | --- | --- |
| token 估算器 | `chars/4 over the exact rendered prompt text`，产物自述「every token count is ESTIMATED, never measured」 | 本仓**没有 tokenizer** |
| 每臂 `cacheReadTokens` | `{ tokens: 0, precision: "estimated" }` | 连 0 都是估算出来的 0 |
| 每臂 measured 成本调用 | `measured: { count: 0, share: 0 }`，`liveCalls: 0` | 从未发起过付费调用 |

因此：**没有任何一个 cacheRead 数字可以被称作 measured**。`cache-observation.ts` 把这条规则编码进类型与实现：

- `observeCacheUsage()` 只在**provider 显式声明了 counting semantics** 时才把某个维度标为 `measured`；有数字但无语义 ⇒ `unknown`（因为 `inputIncludesCacheRead` 决定它是否重复计数，语义未知的数字不可解释）；
- **字段缺失** ⇒ `cacheReadUnavailable: true` 且精度 `unknown`，**绝不当成 measured 的 0**；
- **上报的 0 + 已声明语义** ⇒ `measured` 的 0（provider 真的说 0）；
- `downgradeSample()` 只能向下：它用 `weakerPrecision` 取较弱者，所以 `downgradeSample(estimated, 'measured')` 是**空操作**。**升级在类型上不可表达**——没有 `upgradeSample`，也没有任何路径能把 `estimated`/`unknown` 变成 `measured`。

最后一点是刻意设计：如果只靠运行时检查，某个后续调用者可以用 `'measured'` 调一次「设定精度」函数就把估算洗成测量。现在这种调用存在，但**不改变任何东西**。

---

## 2. 实测：三态计量与配对样本

| 状态 | calls | cacheRead tokens |
| :-- | --: | --: |
| measured | **0** | 0 |
| estimated | **900** | 0 |
| unknown | 0 | 0 |

- 总样本 **900**（5 臂 × 180 次调用）。
- paired 样本 **12**，其中完整 **12**（按 `taskId` 配对；配对精度取两臂中**较弱**者，因此混精度配对会退化为 `estimated`，不能开闸）。
- 每臂标签与精度：`Arm-0/2/4 = baseline`、`Arm-1/3 = treatment`，五臂全部 `estimated`。

> **配对方法与局限**：本仓没有天然的 cache-on/cache-off 任务对，报告按「臂索引奇偶 + 轮转 taskId」构造配对。这**足以**驱动门的判定逻辑（这是本任务要验的东西），但**不足以**支撑任何缓存效应的结论——理由很简单：输入数据本身全是估算。任何把 §2 的 12 个配对读成「12 个任务上缓存减少了 X」的解读都是错的。

---

## 3. 优化门：为什么保持 `gated-not-applicable`

门的实现是 `cacheOptimizationGate()`，三条判据**必须同时**成立才开：

1. 配对精度必须是 `measured`；
2. 至少一个完整配对显示**真实下降**（不是打平）；
3. 对不一致对的精确双侧符号检验在 α = 0.05 下显著。

实测输出：

```
status = gated-not-applicable
reason = cacheRead tokens are estimated (not measured) in 12 of 12 complete pairs,
         so no reduction can be claimed;
         estimated and unknown data are never relabelled as measured
```

**第 1 条在算术之前就把门关上了**，这是刻意的顺序：先判精度，再算数。否则一个 12/12 全降的估算数据集会算出「p 显著」，然后被读成效应。

### 3.1 What-if 分支（**非证据**）

为了证明门**确实能开**（而不只是永远返回同一个字符串），报告附了一个 what-if：把同一批冻结数字**故意**标成 measured，只看门怎么说。

```
what-if status = measured-no-significant-reduction
what-if reason = measured, but not one task shows a cacheRead reduction
```

含义有两点，都必须同时成立才诚实：

- 门的分支是**可达的**：精度满足后它会继续走到第 2 条判据，而不是一律拒绝；
- 即便精度满足，**这批数据也不显示任何下降**——因为 `cacheReadTokens` 恒为 0，两臂相等。所以「缓存有效」在这批数据上连 what-if 都得不到支持。

what-if 的样本**不进入** §2 的计量，也不进入任何结论；它的唯一作用是证明门有判别力。

---

## 4. `whenToApply` shadow（R4 前置）：命中与误伤

判据要求「报告命中率和误伤，不真实写入、不默认启用过滤」。实测：

| 项 | 值 |
| :-- | :-- |
| lessons | 2 |
| queries | 5 |
| 命中率（cue / 全部 lesson×query） | **40.0%** |
| 误伤率（friendly-fire / cue） | **50.0%** |
| 有任一 cue 的 query | 4 / 5 |

| lesson | source | cue 命中 | veto 命中 | 误伤 | 可用 | 命中率 | 误伤率 |
| :-- | :-- | --: | --: | --: | --: | --: | --: |
| `rev6-shadow-cjk` | rev6 synthetic probe (cjk cue) | 2 | 1 | 1 | 1 | 40.0% | 50.0% |
| `rev6-shadow-latin` | rev6 synthetic probe (latin cue) | 2 | 1 | 1 | 1 | 40.0% | 50.0% |

**关键实现约束（不是文档承诺，是代码事实）**：

1. **复用生产匹配器**。分析器直接调用 `matchLessonConditions`（recall 路径用的同一个函数），不重新实现规则。否则报告描述的会是一个没人运行的过滤器。测试用 CJK / latin / 混合串三种线索断言分析器与 `matchLessonConditions` 的判定一致。
2. **误伤是真算出来的**。`cue 命中 ∧ veto 命中` ⇒ `friendly-fire`，并计入 `friendlyFireRate`。上面 50% 的误伤率意味着：若开启正滤，一半的正向命中会被负防火墙立刻撤销——纯成本、无收益。这正是 R4 决定「不默认开启」的证据基础。
3. **没有 `enabled`/`recommended` 字段**。报告的 TypeScript 接口里根本不存在这类字段，测试断言序列化结果不含 `"enabled"`/`"recommended"`。所以「分析结论」无法被误读成「激活决定」。
4. **零 I/O**。模块不 import `node:fs`，测试静态扫描源码禁止 `writeFileSync|appendFileSync|mkdirSync|rmSync`，并断言传入的 lesson/query 对象未被修改。

> **一个副产品发现**：生产匹配器的阈值是「clause 中 ≥50% 的显著 token 出现即命中」。因此 `alpha cue` 会在 `beta cue and beta restraint` 中命中（共享 `cue`，1/2 = 0.5）。这不是缺陷，是已文档化的规则；但它意味着**短 clause 容易误命中**，而 `whenNotToApply` 用的是同一规则——也就是误伤率会偏高。本报告的 50% 误伤率需要在这个背景下读：其中一部分来自 fixture 的构造，不全是 lesson 质量问题。这条已写进测试（`documents the >=50% token threshold that makes shared words match`），阈值一旦改动会立刻红。

---

## 5. 边界与未执行项（诚实登记）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| measured cacheRead 样本 | **not-run（不可能在当前仓产生）** | 无 tokenizer、无付费调用；需要 R3 的账号 + 硬预算绑定后才能产生真实 usage |
| 真实模型计量 | **not-run** | 未授权本次执行；若需付费，必须复用 R3 的账号/硬预算绑定，不得绕开 |
| Tail Injection 实施 | **未实施** | 门保持关闭；即使 status 变为 `applicable`，模块也只「建议做 A/B」，实现是另一个授权动作 |
| `whenToApply` 正滤启用 | **未启用** | 默认仍是关闭；report 无 enable 字段 |
| 真实记忆写入 | **未执行** | 无后端连接、无写入调用 |
| cacheRead 的因果效应 | **不可判定** | 现有数据全是 estimated 且恒 0 |

---

## 6. 交付物与验证

| 类型 | 路径 | 说明 |
| --- | --- | --- |
| 模块 | `src/dsh-bridge/cache-observation.ts` | 精度保持的三态计量 + 配对 + 三向优化门 |
| 模块 | `src/memory-bridge/recall-shadow-analysis.ts` | `whenToApply` shadow 分析（复用生产匹配器、零 I/O） |
| 测试 | `tests/unit/dsh-bridge/cache-observation.test.ts` | 23 例（含 estimated/unknown 双负控制、升级不可表达、冻结产物负控制） |
| 测试 | `tests/unit/memory-bridge/recall-shadow-analysis.test.ts` | 14 例（含 CJK/latin 一致性、误伤计数、无 enable 字段、阈值非空论证） |
| 脚本 | `scripts/eval/rev6-cache-observation.mjs` | 可复跑报告 + `--require-gated` 反证 |
| 报告 | `docs/reports/rev6-cache-recall-observation.md` | 本文件 |

**验证命令与结果**（详见任务 `commandsRun`）：

```powershell
pnpm run typecheck                                              # 0
pnpm exec vitest run tests/unit/dsh-bridge tests/unit/memory-bridge   # 全绿
pnpm run check:build-smoke                                      # 0（stale: false）
node scripts/eval/rev6-cache-observation.mjs --json --require-gated    # 0（门保持关闭）
node scripts/eval/rev6-cache-observation.mjs --json --bogus     # 1（未知参数拒绝）
# 缺失冻结产物时：exit 1 并点名 ENOENT（不把「读不到」当成「没问题」）
```

---

## 7. 相关但不在本任务范围

- **R3 真实收益**：只有账号 + 硬预算可绑定时才能产生真实 usage；届时 §2 的 `estimated: 900` 才可能变成 `measured: N`，本门的第 1 条判据才可能满足。本任务不实施该绑定。
- **R4 active 决定**：需要 shadow 命中/误伤数据（本报告提供）**加上** R1 写回受控、R2 身份链闭合、R3 安全收益口径——四项齐备前 `guarded-active` 不开启。

---

**（完）** 本文件由 `t12` 产出；不执行付费模型/真实工具/真实记忆写入、不启用正滤、不实施 Tail Injection、不 commit/push。
