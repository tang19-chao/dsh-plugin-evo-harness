# P6.1-R2：mirror / B2 无载荷诊断独立评审（round 1）

| 项 | 值 |
| :-- | :-- |
| 被评任务 | t4「P6.1-B1：mirror 无载荷结构化诊断（白名单，不加正则）」；captain 本轮追加 B2 出口范围 → t14「host-advisor describeError 无正文化」 |
| 评审任务 | t11（attempt `68fb98c4-e5d4-4ed8-b1d5-d098d02625d8`，gate-reviewer） |
| reviewed SHA（HEAD） | `7bce33ee9d102a6a05a35f080f606a8fd388e114`（基线 `7bce33e`，评审基于含未提交改动的工作树，非 HEAD 快照） |
| reviewed SHA（工作树 diff 指纹） | `git diff \| git hash-object --stdin` = `34ce3e7435d347970eedf60d2c22ad7d984212bb`（t14 落地后的最终字节） |
| 文件指纹（sha256 前 16） | `src/jitrl/stores/bridge.store.ts` `B228746E47FEF60D`；`src/jitrl/host-advisor.ts` `106D7685A8C48386`；`tests/unit/jitrl/bridge.store.test.ts` `83ACB7DEEE598A4D`；`tests/unit/jitrl/redaction.test.ts` `D3077B6BC51EBAD1`；`tests/unit/jitrl/host-advisor.test.ts` `B83F29CAA4CCBD16` |
| 结论 | **pass**（mirror 白名单，t4）＋ **pass**（advisor 出口，B2/t14 落地字节）；含 1 条 low 级、inScope 之外的残留观察（O1）与 2 条 info 观察，均不阻塞 |
| 绑定时间 | 2026-10-25（Asia/Shanghai），t14 落地后复跑验证命令的字节 |

**方法**：只读代码 + 自写探针。探针用 `esbuild` 打包成 CJS，直接调用仓库真实导出（`createJitBridgeMirrorStore()`、`createHostAdvisor()`、`sanitizeDiagnostic()`、`checkAdvisorBudget()`），不经过交付测试的任何 fixture。本轮所有 canary 均为评审人新造，**完全不复用**交付测试的固定串（`RAW_PAYLOAD…`、`CANARY_*_7341`、`mem0-prod-server-7f3a`、`tenant/secret-space`）；因此"正文不可见"不是靠匹配样例字符串、也不靠交付测试的断言。探针目录 `.p61-r2-probe/` 在交付前删除；仓库内未改 `src/**`、`tests/**`、`scripts/**`。

---

## 1. 结构化诊断白名单核实（代码事实）

| 断言 | 证据 |
| :-- | :-- |
| 唯一渲染器是固定字段集 | `whitelistFields()`（`bridge.store.ts:305-319`）按固定键序输出 `code phase operation retryable errorClass correlationId [serverRef] [namespaceRef]` |
| 字段是受控枚举/布尔/掩码引用 | `DIAG_PHASES`(`:187`)、`DIAG_OPERATIONS`(`:191`)、`DIAG_ERROR_CLASSES`(`:195-202`)、`DIAG_CODES`(`:206-213`)、`correlationId = mirror-<code>-<seq>`(`:358-364`)、`server:<8hex>`/`ns:<8hex>`(`:271-284`) |
| 正文在抛错边界丢弃 | `diagnosticFromError()`(`:386-408`) 只调 `classifyError()`；`classifyError()`(`:237-258`) 只读 `prototype`/`error.name`/类型标记，**从不读 `message`** |
| MCP `isError` 以类型承载、不带正文 | `BackendRejectionError`(`:498-503`) + `backendRejection()`(`:506-508`)；旧代码里的 `{isError, content:[{text}]}` 正文不再进入异常 |
| 旧自由文本回显函数已删除 | `grep errorMessage src/jitrl/stores/bridge.store.ts` 仅命中注释(`:383`)；`sanitizeDiagnostic` 保留为纵深防御 |
| 三条可见出口都被覆盖 | `result.diagnostics`、`store.diagnostics()`、`onDiagnostic` sink；`record()`(`:556-571`) 对每条线再 sanitize，且 sink 抛错被吞(`:562-566`) |
| 插件面只加前缀 | `src/index.ts:1970-1972` 仅 `diagnostics.push('jitrl mirror: ' + line)`，不引入新字段 |

---

## 2. 新鲜 canary 独立重放矩阵（真实 `mirror()` 路径，16 例）

每例断言：`result.diagnostics` ∪ `store.diagnostics()` ∪ sink 三出口每条线满足「`mirror_diag ` 前缀 + 仅白名单键 + 键唯一 + 必含 code/phase/operation/retryable/errorClass/correlationId + 长度 ≤ 200」，且 canary 子串（含大小写不敏感）零出现。

| # | 案例（注入点） | 新鲜 canary 形态 | 白名单产物（实测） |
| --: | :-- | :-- | :-- |
| 1 | write 抛错回显正文 | 中文 `金丝雀正文「甲七幺五」` | `code=write_failed phase=write operation=statWrite retryable=false errorClass=unknown correlationId=mirror-write_failed-1 serverRef=server:22841adf namespaceRef=ns:1dfb1189` |
| 2 | write 抛错 | 英文短句 `the quick brown fox canary sentence` | 同上（正文零出现） |
| 3 | write 抛错 | JSON `{"canary":"P61R2JSON-c4e9","nested":{"inner":…}}` | 同上 |
| 4 | write 抛错 | nested cause（inner/outer 双 canary） | 同上 |
| 5 | write 抛错 | 异常长文本（5000+ 字符） | 同上，行长仍 ≤200 |
| 6 | 字符串 throw | `'plain string throw P61R2STR-6b52'` | 同上（`errorClass=unknown`） |
| 7 | write 抛错回显**工具 args**（含 note 正文、note path、完整 namespace、serverId） | `P61R2-bucket-7b3c`、`P61R2-action-9e21`、`p61r2-prefix-2a6b/jitrl/host_tool`、`#jitrl-stat` | 同上（`namespaceRef=ns:1dfb1189` 为掩码，原文零出现） |
| 8 | `callTool` 返回 `{isError:true, content:[{text: canary}]}` | `P61R2-ISERROR-content-91aa` | 同上，`errorClass=backend_rejection` |
| 9 | `listTools` 抛错（回显绝对路径、serverId） | `P61R2LISTTOOLS-77c1`、`C:\Users\canary-r2\secrets.txt`、serverId | `code=list_tools_failed phase=discovery operation=listTools retryable=false errorClass=unknown … serverRef=server:3b87a452` |
| 10 | 后端只暴露无写工具（工具名含 canary） | `search_notes_P61R2-0f19` | `code=no_write_tool … errorClass=backend_rejection serverRef=server:68512b18`（工具名零出现） |
| 11 | 非法聚合行（bucket 含 canary） | `P61R2BADROW-52de` | `code=invalid_row phase=write operation=aggregate …`（行内容零出现） |
| 12-15 | errorClass 映射 | TypeError / RangeError / name=TimeoutError / name=AbortError 各自正文 | `transport(retryable=true)` / `invalid_input(false)` / `timeout(true)` / `aborted(true)`，正文零出现 |
| 16 | 完整 `mirror()` 契约 | — | 16/16 例 `degraded=true`，全部白名单线；8 例 `write_failed` 的 `serverRef`/`namespaceRef` 与 `maskServerId()`/`maskNamespace()` 精确相等 |

探针总结行：`MIRROR PROBE: ALL CHECKS PASSED`。

---

## 3. 反事实：封堵来自"白名单 + 丢弃正文"，不是正则/固定字样

| 反事实实验 | 结果 |
| :-- | :-- |
| `sanitizeDiagnostic('echo PAYLOADQ_8842_INNER body tail')`（非 `RAW_PAYLOAD` 形状的载荷回显） | **原样保留** —— 通用脱敏器并不匹配任意载荷形状 |
| 把每例原始 `error.message` 单独交给 `sanitizeDiagnostic()`，再看 canary 是否可见 | **15 个子串仍然可见**（`quick brown fox`、`canary sentence`、`P61R2JSON-c4e9`、`“nested”`、`P61R2STR-6b52`、`P61R2-bucket-7b3c`、`P61R2-action-9e21`、`#jitrl-stat`、`P61R2LISTTOOLS-77c1`、serverId 原文、TypeError/RangeError/Timeout/Abort 正文…） |
| 同一批 canary 在真实 mirror 三出口上 | **零出现** |
| 保留的 `RAW_PAYLOAD` 形状规则 | `sanitizeDiagnostic('echo RAW_PAYLOAD_QR_8842 tail')` → `echo <payload> tail`（仍生效，但只是 sanitizer 自身的纵深防御，不是 mirror 出口的判据） |

结论：不可见性来自 `diagnosticFromError()` 在抛错边界**丢弃**正文并按白名单渲染，符合"不加逐例正则"的修复要求；评测不依赖 `RAW_PAYLOAD` 字样。

---

## 4. 已有效脱敏 / 掩码未回退

| 项 | 实测 |
| :-- | :-- |
| 密钥 | `ghp_QR8842…` → `<secret>`；交付案例中的 `ghp_…` 同样不出现 |
| 绝对路径 | `/usr/local/secret/keys.pem`、`C:\Users\canary-r2\secrets.txt` → `<path>`（后者的 listTools 案例中路径零出现） |
| serverId / namespace | 显式上下文掩码生效：`server=<serverId> namespace=<ns>` → `server=server:b6b98f91 namespace=ns:924d4fa3`；格式断言 `/^server:[0-9a-f]{8}$/`、`/^ns:[0-9a-f]{8}$/` 通过 |
| 限长 / 幂等 | 1000 字符 → ≤200 且以 `…` 结尾；`sanitizeDiagnostic(sanitizeDiagnostic(x)) === sanitizeDiagnostic(x)` |

---

## 5. 原评审示例名特殊分支已移除（行为证据）

| 证据 | 结果 |
| :-- | :-- |
| `grep 'tenant/secret-space\|mem0-prod-server' src/**/*.ts` | **0 命中** |
| 代码 diff | 删除了旧版 `namespace=` 通用正则、`\btenant/secret-space\b` 与 `\bmem0-prod-server-[0-9a-zA-Z_-]+\b` 三个专用 `replace`（`bridge.store.ts` diff `@@ -213,25 +340,71 @@`） |
| 行为反证 | `sanitizeDiagnostic('mem0-prod-server-7f3a tenant/secret-space')`（不给上下文）→ **原样返回**，证明不存在针对原评审示例名的隐藏分支 |
| 不产生回归的原因 | 生产路径不再把 serverId/namespace 原文交给 sanitizer：白名单只输出 `server:<8hex>`/`ns:<8hex>`（§2 案例 7/9/10 已验证原文零出现）；通用掩码只在 caller 显式传 `serverId`/`namespace` 上下文时替换 |

---

## 6. tokenizer 消费端复评（上一轮 F1，未回退）

接线：`checkAdvisorBudget()`（`host-advisor.ts:132-140`）→ `checkTokenBudget()`（`redaction.ts:303-339`）；`renderAdvice()`（`:463-485`）逐行收敛，并用 `minimalAdvice()` 兜底；`HostAdvisorOptions.tokenizer`（`:209-210`）为注入入口；`evaluate()` 在 advisory 分支传 `options.tokenizer`（`:700`）。

| 输入（评审人探针） | chars | bytes | estTokens | fits | exact |
| :-- | --: | --: | --: | :-- | :-- |
| hex 1200（上一轮 F1 的用例） | 1200 | 1200 | 600 | **false** | false |
| base64url 1073 | 1073 | 1073 | 542 | **false** | false |
| JSON 1172 | 1172 | 1172 | 515 | **false** | false |
| CJK 300 字 | 300 | 900 | 600 | **false** | false |
| emoji 40 个 ZWJ 序列 | 320 | 720 | 480 | **false** | false |
| ASCII 300 | 300 | 300 | 150 | true | false |
| ASCII 400 | 400 | 400 | 200 | true | false |
| ASCII 500 | 500 | 500 | 250 | **false** | false |

- 未注入 tokenizer 时 `exact=false`，note 明写 `Heuristic estimation does NOT claim equivalence to real model <= 300 tokens`；`truncated` 始终为 false（无静默截断）。
- 端到端降级文案（长证据触发截断，实测）：无 tokenizer → `advisory_truncated: evidence trimmed to fit estimated budget (heuristic/not real tokens)`；注入 tokenizer → `advisory_truncated: evidence trimmed to fit tokenizer budget (300 tokens)`。
- 注入 tokenizer 返回 301/250 → `fits=false (exact=true)` / `fits=true (exact=true)`，note 为 `Exceeds injected model tokenizer budget (301/300 tokens).`
- 渲染产物自身在保守预算内：实测截断后 `chars=371, fits=true`；注入 tokenizer 时文本长度 ≤300。
- **真实模型 tokenizer 端到端一致性（真实 BPE 计数）仍属 Gate 4 范畴，本轮不验证**，上述数字全部是"注入替身 + 保守启发式"口径。

---

## 7. host-advisor 出口复评（B2 / t14，绑定落地字节）

`describeError()`（`host-advisor.ts:236-265`）改为只输出 `class=<bounded>`：`aborted` / `timeout` / `type_error` / `range_error` / `error` / `unknown`；任何恶意 `Error.name` 折叠为 `error`，字符串/对象 throw 折叠为 `unknown`。

| 注入（全部为评审人新造 canary） | 决策 | 可见出口实测 | canary 出现 |
| :-- | :-- | :-- | :-- |
| store.query 抛 `Error('store offline: 金丝雀顾问正文「丙八六二」')` | `noop/retrieval_failed` | `retrieval_failed: class=error` | 0 |
| 英文短句正文 | `noop/retrieval_failed` | 同上 | 0 |
| 字符串 throw | `noop/retrieval_failed` | `retrieval_failed: class=unknown` | 0 |
| `TypeError('… P61R2ADVTYPE-3c62')` | `noop/retrieval_failed` | `retrieval_failed: class=type_error`（连 `TypeError` 字样也不出现） | 0 |
| 恶意 `error.name='P61R2HOSTILENAME-44aa'` | `noop/retrieval_failed` | `retrieval_failed: class=error` | 0 |
| `name='AbortError'` + 正文 | `noop/retrieval_failed` | `retrieval_failed: class=aborted` | 0 |
| nested cause（outer/inner 双 canary） | `noop/retrieval_failed` | `retrieval_failed: class=error` | 0 |
| `now()` 注入抛错（evaluate 外抛路径） | `noop/advisor_failed` | `advisor_failed: class=error` | 0 |

其它出口：noop 决策不带 `text`/`additionalContexts`；advisory 文本仅由统计量构成（实测 `<jitrl_advice mode="advisory" …>recommend read (meanReturn=3.000, n=2, tilde=1.000)…`）；`additionalContexts`（`dsh-hook-host-adapter.ts:1162-1166`）只追加 `verdict.text`，错误正文无任何进入路径；advisor 诊断面经 `src/index.ts:955`（status）与 adapter `advisories()`/`details.advisories` 暴露的仅为上述 bounded 行。

---

## 8. 交付测试与验证命令（评审环境实跑）

| 命令 | 结果 |
| :-- | :-- |
| `pnpm run typecheck` | **exit 0**（无输出错误） |
| `pnpm exec vitest run tests/unit/jitrl` | **20 文件 / 601 测试全部通过，exit 0** |
| （定点复核 t4 归属文件）`pnpm exec vitest run tests/unit/jitrl/bridge.store.test.ts tests/unit/jitrl/redaction.test.ts` | **87 passed**（36 + 51），exit 0 |
| （评审人探针）mirror / advisor 两个打包探针 | `MIRROR PROBE: ALL CHECKS PASSED`；`ADVISOR PROBE ALL CHECKS PASSED`（绑定上述文件指纹重跑） |

交付测试的 canary 是固定串（`CANARY_*_7341` 等）；本轮结论不以它们为判据（见 §2/§3 的独立 canary 与反事实）。评审中途曾观察到 1 条失败位于 `tests/unit/jitrl/learning-filter-wiring.test.ts`（t3 在途文件，非 t4/t14 字节）；其稳定后最终复跑为 601/601 全绿。

---

## 9. 验收清单（逐条）

| 验收项 | 结果 | 证据 |
| :-- | :-- | :-- |
| 评审绑定当前提交 SHA 并写入报告 reviewed SHA 字段 | **passed** | 头部表：HEAD `7bce33e…` + 工作树 diff 指纹 `34ce3e74…` + 5 个文件 sha256 前 16 |
| 结构化诊断白名单核实（production 仅 code/phase/operation/retryable/correlationId/errorClass/serverRef/namespaceRef） | **passed** | §1（代码）+ §2（16/16 例实测线形状） |
| 后端 `error.message`、content、工具 args、note body 不出现在任何可见出口 | **passed** | §2 案例 1-9（三出口并集零出现）+ §3 反事实 |
| 评审人独立构造新鲜 canary（中文/英文/JSON/nested cause/超长/字符串 throw）重放真实 mirror 路径 | **passed** | §2（16 例，全部新造，含 `mirror()` 真实路径） |
| 不以固定 `RAW_PAYLOAD` 字样作为唯一判据 | **passed** | §3（非 `RAW_PAYLOAD` 形状载荷 + 15 条"仅 sanitizer 会泄漏"的反事实） |
| 已有效的密钥脱敏/serverId/namespace 掩码未回退 | **passed** | §4（`<secret>`/`<path>`/`server:<8hex>`/`ns:<8hex>`/限长/幂等） |
| tokenizer 消费端复评：接线 + 未注入保守预算 + 降级文案 | **passed** | §6（hex1200/base64url/JSON/CJK/emoji 全拒绝；两套降级文案实测） |
| 真实模型 tokenizer 端到端一致性标注为 Gate 4 范畴 | **passed** | §6 末行（本轮不验证，已标注） |
| 移除了针对原评审示例名的特殊匹配分支 | **passed** | §5（grep 0 命中 + 行为反证 + diff 删除三个专用 replace） |
| 评审报告落盘 `docs/reports/p61-review-round1-mirror.md`（含 verdict 与 findings） | **passed** | 本文件（§9/§10） |
| `pnpm run typecheck` / `pnpm exec vitest run tests/unit/jitrl` 在评审环境通过 | **passed** | §8（typecheck exit 0；20 files / 601 tests passed，exit 0） |
| captain 追加：host-advisor 出口（建议文案/诊断/additionalContexts）正文回显为零，t4 保留项未回退 | **passed** | §7（8 例 canary × 双路由 + noop 无正文载荷）+ §6（预算项未回退） |

---

## 10. Findings

| id | 等级 | 状态 | 内容 |
| :-- | :-- | :-- | :-- |
| **F1** | high（上一轮） | **resolved** | 上一轮 F2：mirror 诊断在后端回显原载荷时泄漏 serverId/namespace/正文（仅限长 200）。本轮改为白名单渲染 + 抛错边界丢弃正文；§2/§3/§4 证明封堵且不依赖正则。 |
| **F2** | high（上一轮） | **resolved** | 上一轮 F1：token 预算未接到消费方（新 helper 是死代码）。本轮 `checkAdvisorBudget()` 已由 `renderAdvice()`/`evaluate()` 消费，hex1200 等高熵输入被拒绝，降级文案已如实声明"非真实 token"（§6）。 |
| **O1** | low | 观察（**inScope 之外**，不阻塞） | `src/index.ts:1975` 在 `mirror.mirror()` 意外抛出（非后端错误路径）时仍 `error.message` 拼入插件 diagnostics。当前 `mirror()` 对全部后端失败都在内部收敛为白名单诊断（§1），因此不是活跃的后端回显通道；但它是 mirror 相邻面唯一残留的自由文本出口，建议按 F9/B 线口径改为 bounded class（属 t15/index.ts 范围，本评审不改代码）。 |
| **O2** | info | 观察 | `BridgeMirrorStore.diagnostics()` 的注释（`bridge.store.ts:115`）仍写 "counts and tool names only, no payloads"，与现在的结构化白名单线不符（既无计数也无工具名）。仅为注释陈旧。 |
| **O3** | info | 已接受限制 | `serverRef`/`ns:<8hex>` 是 FNV-1a 短哈希，可枚举反推——代码注释已明确其不是匿名化，只作跨行关联；上一轮评审正是这样要求的。 |

---

## 11. 边界与声明

- **共享工作树**：本报告绑定头部表的 HEAD + 工作树 diff 指纹 + 文件 sha256。t3/t5/t10/t15 在途；若之后 `src/jitrl/**` 字节变化，本结论只对上述指纹成立，需要按新 SHA 复评增量 diff。host-advisor 部分是在 t14（P6.1-B2）标记 completed 之后、以其稳定文件指纹（`106D7685…`）复跑探针与验证命令的；`bridge.store.ts` 指纹自 t4 交付后未再变化。
- **中途观察**：评审过程中 `tests/unit/jitrl/learning-filter-wiring.test.ts`（t3 在途，本评审范围外）曾单条失败，`tests/e2e/provenance-chain.test.ts`（t3 新增）当时也在写入中；最终复跑时 `tests/unit/jitrl` 为 601/601 全绿，故按最终字节判定通过。
- 未跑全量 `pnpm test`/`pnpm run test:e2e`（其他工作项在途，失败无法归因）；本轮只跑验收要求的 `typecheck` 与 `tests/unit/jitrl`。
- 未接真实 MCP 后端、未接真实模型 tokenizer；mirror 的"后端回显"失败面与 advisor 的"store/estimator 抛错"失败面均为受控构造（验收要求覆盖的正是这些面）。
- 未修改仓库 `src/**`、`tests/**`、`scripts/**`；探针目录 `.p61-r2-probe/` 已删除。
