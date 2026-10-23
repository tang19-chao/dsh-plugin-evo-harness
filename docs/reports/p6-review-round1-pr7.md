# PR7（5.3 治理包）独立评审 — Gate 1 第 1 轮

| 项 | 值 |
| :-- | :-- |
| 被评任务 | t4「PR7 / 5.3：tokenizer 预算、composer 输入剥离、mirror 诊断脱敏、advisor 措辞与统一收尾」 |
| 评审任务 | t12（attempt `59a1b010-6599-464d-9067-88fe7bba9e56`） |
| 冻结修订（sha256 前 8 位） | `src/jitrl/redaction.ts` **8cfaca9e**（23:01:22）、`src/harness2/shared.ts` **39e64d3e**、`src/harness2/composer.ts` **b3b9defc**（23:02:42）、`src/jitrl/stores/bridge.store.ts` **2f299ecb**（23:08:21）、`src/config.ts` **f0a17c54**（23:08:55）、`src/index.ts` **103bff0c**（23:09:36）、**`src/jitrl/host-advisor.ts` 8591b380（mtime 20:45:57，PR7 窗口之前）** |
| 结论 | **needs_revision**：composer 剥离、统一收尾、advisor 措辞、RuntimeControl 四项通过；**M2 token 预算没有接到真实消费方（新增 helper 是死代码，消费方仍可超自报预算约 2 倍）**；**mirror 诊断在后端回显原载荷时仍泄漏 serverId/namespace/载荷内容**（只做了限长，没做掩码）。 |

方法：只读代码 + 自写探针（esbuild 打包，直接调用四个模块的真实导出与生产插件入口）。除 `docs/reports/` 外未改仓库文件。

---

## 1. F1 / high：M2 token 预算未接线，真实消费方可超自报 ≤300 预算约 2 倍

**代码事实**
- 新增 `src/jitrl/redaction.ts:244-281` `checkTokenBudget()`（支持注入 `tokenizer`，fallback 走 `estimateConservativeTokens` + `400 chars / 1000 bytes` 上限，note 明确"does NOT claim equivalence to real model <= 300 tokens"）。
- 但全仓 grep：`checkTokenBudget|estimateConservativeTokens|countTokens(` 的调用点只有 `redaction.ts` 自身与 `tests/unit/jitrl/redaction.test.ts` —— **零生产消费方**。
- 真实的 300-token 消费方 `src/jitrl/host-advisor.ts` 完全没被 PR7 改动（mtime 20:45:57，早于 t4 窗口）：仍用自己的 `estimateTokens()`（`:117-129`，`ceil(ASCII/4) + 非ASCII 计数`）、仍是 `MAX_ADVISORY_TOKENS = 300`（`:448/:464`）**且没有任何 tokenizer 注入入口**；`:38-39/:108-115` 仍声称该估算"errs high rather than low"，`:678-682` 仍输出 `evidence trimmed to fit 300 tokens`。

**实测（同一文本分别喂三个估算器；bpeProxy = ASCII/2 + 非ASCII，作为高熵文本的 ~2 chars/token 参照）**

| 输入 | chars | `estimateTokens`（消费方） | 新 helper 保守值 | bpeProxy | 消费方是否接受 |
| :-- | --: | --: | --: | --: | :-- |
| hex 1200 | 1200 | **300** | 343 | **600** | **ACCEPTED** |
| hex 1180 | 1180 | **295** | 338 | **590** | **ACCEPTED** |
| base64url 1160 | 1160 | **290** | 363 | **580** | **ACCEPTED** |
| JSON 1001 | 1001 | **251** | 465 | **501** | **ACCEPTED** |
| CJK 360（300 汉字） | 360 | 360 | 540 | 360 | rejected（正常） |
| emoji 110（40 个含 ZWJ） | 110 | 60 | 165 | 60 | ACCEPTED（估算偏低） |

即：**advisor 会接受一个真实 tokenizer 需要 ≈600 tokens 的块，并对外声称它 fit 300 tokens**。这正是方案 §5.3 要求消除的说法（"不继续声称近似估算等于真实 ≤300 tokens"）——新的免责声明写在一个没人调用的模块里，消费方口径未变。
补充：新 helper 自己的文档（`:190-198`）声称 hex/base64 是"1 token per 1.5–2 characters"，但代码只有 `alnum/3.5`（无 hex/base64 分支），文档与实现不一致；其 fallback 之所以还算安全，靠的是 400 chars / 1000 bytes 上限，而不是 token 估算本身。

**要求修复**：把预算真正接到消费方（二选一或同时）：
1. `host-advisor` 增加 `tokenizer?: ModelTokenizer` 注入并改用 `checkTokenBudget()`，无注入时同时受 `400 chars / 1000 bytes` 与保守 token 界约束；
2. 或至少把 `estimateTokens` 改为高熵感知的保守界（hex/base64/无空格长串按 ≤2 chars/token，CJK 2/char，emoji ≥3/char），并让 `:678-682` 的诊断与 `:38-39/:113-115` 的措辞降级为"估算、非真实 token 数"。
   验收测试：用 1200-hex / 1160-base64url / 1001-JSON / 300-CJK / emoji 五类输入断言**消费方**会拒绝或降级（不能只看 helper）。

## 2. F2 / medium-high：mirror 诊断"后端回显原载荷"仍泄漏

我构造的真实失败面（后端错误里回显 serverId、namespace、长载荷、密钥与绝对路径）：

```
raw length=657 → sanitizeDiagnostic 输出长度=200（≤200 ✓）
sanitized=listTools failed on mem0-prod-server-7f3a in namespace tenant/secret-space with payload
          RAW_PAYLOAD_RAW_PAYLOAD_...RAW_PAYLOAD_RAW_…
leaks: longPayload=true   githubToken=false   absPath=false
       serverId echoed=true   namespace echoed=true
```

- ✅ 做到：密钥（`ghp_…`）与绝对路径被 `redactSecrets/redactAbsolutePaths` 抹掉；长度限到 `MAX_DIAGNOSTIC_LENGTH=200`（`bridge.store.ts:154-173`）。
- ❌ 未做到：**serverId 与 namespace 原样输出**（`bridge.store.ts:401` 插值 `namespace`、`:426/:437` 插值 `client.serverId`），**回显的载荷内容也原样保留**（只被截到 200 字符）。
- 方案 §5.3 要求"mirror 的 serverId、后端异常、namespace 相关诊断**统一脱敏**并限长"；当前只有"限长 + 通用密钥/路径脱敏"，没有对 serverId/namespace 做掩码，也没有把"后端回显体"替换成有界、无载荷的摘要。

**要求修复**：serverId/namespace 改为掩码或短哈希（如 `server:<hash8>`、`ns:<hash8>`）；后端异常只保留类别/短摘要（例如错误名 + 前 40 字符的已脱敏摘要或哈希），不要 `slice(0,200)` 直接把载荷原文留下；把"后端回显原载荷 + serverId + namespace + 密钥"这一条加入测试（我上面的构造即可复用）。

## 3. 通过项（同样以我自跑为准）

| 项 | 证据 |
| :-- | :-- |
| **composer 输入剥离** | `stripStructuredAdvice` 删除 `<jitrl_advice>…</jitrl_advice>` 块（canary `CANARY_P7_LEAK_9f13` 随之消失）与自闭合标签；自由文本复述**不会被** XML 剥离消除（实测 canary 仍在），但 `ADVICE_LEAKAGE_RISK_RECORD`（`composer.ts:901-904`）显式记录 `residualRisk: free_text_restatement_cannot_be_eliminated_by_xml_stripping_alone` + `recommendation: audit_judge_inputs_and_apply_whitelist_filtering`，并有 `redactIdentifiers`（`:240-246`）在 composer 的 deliverable/step 文本上兜底 ⇒ **没有宣称已消除**，与方案要求一致 |
| **统一收尾 / 镜像不在无条件 finally** | 代码：`index.ts:2156 executeRun`，成功路径 `:2174 await syncJitMirror()`，`finally :2176` 只清 inFlight guard；注释 `:2150-2154` 明写"MUST NOT be placed in an unconditional finally"。行为：mirror ON → 后端 `callTool=4`、`mirror.calls=1`；`jit off` → `dMirrorCallTool=0`（`runtimeEnabled=false`）；`auto_fallback` 触发但 run 被跳过 → 后端调用 0 |
| **advisor 措辞** | `config.ts:132/136` 已改为"请求用户确认，永不自动 deny (请求用户确认，永不自动 deny)"；advisor 侧仍有编译期 no-deny 守卫 `HOST_ADVISOR_NEVER_DENIES`（`host-advisor.ts:100-106`），行为上只 ask/advisory（历轮已验） |
| **未回退 RuntimeControl** | `index.ts` 仍是单一控制器：`isRuntimeOn('hostRecord')`(:1826/1828)、`('advisor')`(:1839)、`('mirror')`(:1956/1961)、`('dreamJit')`(:1280/:1519)、状态面 `snapshot()`(:1260/1884/1907/1918)、命令控制器(:2025) 均在 |
| **t4 测试文件** | `redaction.test.ts` + `composer.test.ts` + `bridge.store.test.ts` → **85 passed**，退出码 0（绿色只说明它们没覆盖上面两条） |

## 4. 验收清单

| 验收项 | 结果 | 证据 |
| :-- | :-- | :-- |
| 5.3 四项与行为一致 | **failed** | token 预算（§1）与 mirror 脱敏（§2）与其宣称/方案不符；composer 剥离与 advisor 措辞一致 |
| token 上限在高熵/CJK/emoji/JSON 下成立、未静默截断 | **failed** | §1：消费方对 hex1200/base64url1160/JSON1001 **接受**（自报 300），真实需 ≈600；新 helper 无消费方。截断本身是显式的（`truncated` 标记与 minimalAdvice 分支），不是静默——但预算本身不成立 |
| 不再声称近似估算等于真实 ≤300 tokens | **failed** | §1：免责声明在被孤立的 helper 内；消费方 `host-advisor.ts:38-39/:108-115` 仍称"errs high rather than low"，`:678-682` 仍说"trimmed to fit 300 tokens" |
| composer 剥离有 canary/对抗测试、残留风险显式记录 | **passed** | §3（含 `ADVICE_LEAKAGE_RISK_RECORD`） |
| mirror 诊断在后端回显原载荷场景下不泄漏 | **failed** | §2：serverId/namespace/载荷内容原样保留（仅限长 200） |
| 镜像收尾不在无条件 finally、off/失败可阻止镜像 | **passed** | §3（代码 + ON/OFF/auto_fallback 行为） |
| 未回退 t1 的 RuntimeControl 结构 | **passed** | §3 |

## 5. 边界声明

- 未跑全量 `pnpm test`/`typecheck`/`build`（共享工作树含其他 PR 在途改动，无法归因）；本轮定向跑 t4 三个测试文件（85 passed）+ 自写探针。
- 未接真实模型 tokenizer：`bpeProxy` 是"高熵 ASCII ≈2 chars/token"的估算参照，报告已标注；F1 的结论不依赖它的绝对值——**消费方根本没使用任何真实 tokenizer，且对 1200 字符无空格长串给出 300 tokens（=4 chars/token）**，与它自己文档承认的 hex/base64 事实（1.5–2 chars/token）矛盾，这已足够说明其"保守上界"不成立。
- 未接真实 MCP 后端：mirror 回显场景是构造的客户端错误（方案 §5.3 要求测试的正是这个失败面）。
- 未修改仓库 `src/**`、`tests/**`、`scripts/**`；探针目录已清理。
