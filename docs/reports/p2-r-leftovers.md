# P2 批次 · 低风险遗留项 R-01…R-08 交付报告（leftovers / t1）

> 执行者：leftovers（低风险遗留修正工程师，R-01…R-08 单点修复）
> 基线：`feb8465ded73ca48a770054c587990b93f54e21e`（2026-10-29）
> Team：p2-p6-execution；任务 t1；attempt_id `5d940089-4a35-4477-80bd-422792a77fd5`
> 观测时点约定：本报告所有"实测"都带时点；共享工作树同窗口内 t2/t3/t4 也在写 `src/jitrl`、`src/ledger`、`src/dsh-bridge`、`tests/unit/eval/p2-*.test.ts`，凡涉及其文件的观察均单独标注、不计入本任务结论（详见 §9、§12）。
> 本报告不写"整体通过"：R-01…R-08 逐项给证据，`check:docs` 的临时红在 §9 单列披露。

## 0. 摘要

| ID | 项 | 结论 | 落地位置（本任务写范围内） |
| --- | --- | --- | --- |
| R-01 | `mapHostAdvisorStatus` 七键白名单 | **已落地**（源码 + 9 例契约测试） | `src/host-triggers.ts`；`tests/unit/contracts/host-advisor-status-mapping.test.ts`（新增） |
| R-02 | `skipped` 注释收敛 | **已落地**（仅注释，零行为改动） | `src/types/contracts.ts` |
| R-03 | `{config: null}` 语义裁定 | **已落地**（ADR §3.4.1：**继承宿主配置**；测试钉死；`src/index.ts` 零改动） | `docs/adr/0005-p1-evidence-and-atomic-config-contract.md`；`tests/unit/config/plugin-options-shape.test.ts` |
| R-04 | `check:docs` 三方闭合 + 测试根归属 | **已落地**（脚本 + 4 例测试） | `scripts/verify-readme-counts.mjs`；`tests/unit/config/readme-default-leaves.test.ts` |
| R-05 | effort 校验头注释修正 | **已落地**（仅文件头注释块） | `tests/unit/config/plugin-options-shape.test.ts` |
| R-06 | attestation-target 记录源绑定 + CI `pnpm install` 评估 | **脚本部分已落地**（evidence 模式 fail-closed 两个新码 + ordinary 模式仅 note）；**CI 改动未落地**（写范围外 → 评估结论 + 精确补丁交 lead） | `scripts/eval/check-attestation-target.mjs`；`tests/unit/eval/attestation-target-record-source.test.ts`（新增） |
| R-07 | M3 mutation 红数口径 | **已落地**（ADR §5.1 口径注 + 本报告 §8；判据零改动） | `docs/adr/0005-p1-evidence-and-atomic-config-contract.md`；本报告 |
| R-08 | `PARITY_PLATFORMS` 字段级 readonly | **已落地**（声明收紧 + 类型/运行时测试；运行时形状零改动） | `scripts/eval/compare-platform-digests.d.mts`；`tests/unit/eval/parity-platforms-readonly.test.ts`（新增） |

---

## 1. R-01 — `mapHostAdvisorStatus` 只转发七个公开计数字段

### 1.1 现状（改动前实测，2026-10-29 09:33）

注入 canary 字段的结构性适配器快照曾**原样进入**公开 counters（t13 O2 的复现）：

```text
命令：esbuild 打包 work/_r_probe.ts（import 真实 src）→ node 执行
R-01a mapHostAdvisorStatus counters with canary =
  {"advisory":1,"ask":2,"noop":3,"skipped":4,"scopeUnknownSkipped":5,
   "considered":6,"excludedByDeclaration":7,"toolName":"CANARY-ADAPTER-EXTRA"}
```

即 `{...stats}` 让 `toolName` 这类额外适配器字段到达公开 status；公开形状当时依赖"来源自觉"。

### 1.2 改动

- `src/host-triggers.ts:158` 新增 `HOST_ADVISOR_COUNTER_KEYS`（7 个公开计数，模块级单一事实源）；
  `src/host-triggers.ts:167-178` 三个编译期见证：`_COUNTER_KEYS_EXHAUSTIVE`（公开契约每个键都已登记）、
  `_COUNTER_KEYS_FOREIGN`（白名单没有契约外键）、`_COUNTER_KEYS_COUNT`（长度恰为 7）——新增/删改公开计数而不改白名单会让 `pnpm exec tsc --noEmit` 失败。
- `src/host-triggers.ts:212` `mapHostAdvisorStatus` 不再 `{...stats}`，改为 `pickHostAdvisorCounters(stats)`（`:239`）：
  按 7 键逐键挑字段；**实测 `0` 逐字保留**（`0` 是有限数字，不会被 falsy 判断吞掉）；**未采集/非数值仍为省略**
  （present-but-non-numeric、NaN、±Infinity、undefined 一律不写键，绝不伪造 `0`，F-15）。
- ADR 0005 §3.7 追加"入口白名单"裁定行（`docs/adr/0005-p1-evidence-and-atomic-config-contract.md:310`）。

### 1.3 证据

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `pnpm exec tsc --noEmit` | 0（本任务文件完成时点 10:20） | 无输出（三个 witness 均通过） |
| `pnpm exec vitest run tests/unit/contracts/host-advisor-status-mapping.test.ts` | 0 | `Tests 9 passed (9)`；断言含：canary 注入后 `Object.keys(counters)` 恰为 7 公开键、序列化不含 CANARY、`hostAdvisorJitStatus` 入口面恰为 5 fixed + 7 counters、结构性适配器挂载后 `plugin.jitrl.hostAdvisor` 无 canary |
| `pnpm exec vitest run tests/unit/seams/status-observability.test.ts tests/unit/seams/status-observability-contract.test.ts`（既有，未改动） | 0 | 既有 collect-or-omit / 实测零 / 增量用例全绿（`{...stats}` → 白名单不改变七键转发的可见行为） |

**白名单两侧不变量（与 lead 要求一致）**：注入的额外字段不出现（whitelist），且七个公开计数字段实测为 0 的必须保留为 `0`（`zero preservation` 用例同时钉住 JSON 往返后仍为数字 `0`）。

### 1.4 未做项

- 无。注：`tests/unit/seams/status-observability*.test.ts` 是既有文件的更自然归宿，但不在本任务写范围；白名单契约测试按任务指定的 `tests/unit/contracts/` 落地，两者互不冲突。

---

## 2. R-02 — `skipped` 计数注释收敛

### 2.1 现状（实测计数边界，2026-10-29 09:33）

`src/cordis-seams/dsh-hook-host-adapter.ts` 中 `skipped` 的真实累加点（5 处，全部要求 `advisor !== undefined && !disposed`）：
`tools/pre-execute` 运行期门关闭（`:1096`）、out-of-scope（`:1099`）、无工具名（`:1120`）；`agent/pre-step` 运行期门关闭（`:1173`）、out-of-scope（`:1177`）。
**未挂载 advisor 时不产生任何事件**——探针实测：

```text
R-02a adapter WITHOUT advisor, after pre-execute+pre-step dispatches, hostAdvisorStats() =
  {"advisory":0,"ask":0,"noop":0,"skipped":0,"considered":0,
   "excludedByDeclaration":0,"scopeUnknownSkipped":0}
```

即"advisor off（未挂载）"**不是** `skipped` 的计数来源；此时 `skipped` 保持实测初值 0，含义是"未观察到 advice-channel 跳过事件"，**不是**"宿主派发都被跳过"。

### 2.2 改动

仅 `src/types/contracts.ts:1897-1927`（`HostAdvisorObservabilityCounters` 的 `skipped` 注释行）：

- 删除笼统的 "advisor off" 计数来源表述，改为按**真实事件点**描述（运行期门关闭；部分资格判定后的 out-of-scope / 无名派发，后者已计 `considered`）；
- 新增 **COUNTING BOUNDARY (R-02)** 段（`src/types/contracts.ts:1908`）：该计数是**适配器观测**、不是宿主派发量；未挂载 / 已 dispose 时累加点不触发，计数保持实测 0，禁止把 0 读成派发数；
- 保留并精确化 `skipped` 与 `advisory/ask/noop` 每事件互斥的表述（per booked event）。

### 2.3 证据

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `pnpm exec tsc --noEmit` | 0（10:20 时点） | 注释不影响类型 |
| `pnpm exec vitest run tests/unit/seams/status-observability-contract.test.ts tests/unit/seams/status-observability.test.ts` | 0 | 既有可观测性用例全绿（`skipped` 行为未变；测试文件中的口径引用与新注释一致） |
| `pnpm run check:encoding` | 0 | `SUCCESS: every tracked blob is LF text or an explicit -text exception`（contracts.ts 为 tracked 文件，编码受检） |

### 2.4 未做项

- `tests/unit/seams/status-observability.test.ts:192-198` 里引用旧注释措辞的内联说明属于他人文件（写范围外），未改；新注释已与该观测一致，不存在矛盾残留。

---

## 3. R-03 — `{config: null}` 语义裁定（ADR + 测试钉死）

### 3.1 决定前实测（兼容性影响先测量，2026-10-29 09:33）

```text
命令：esbuild 打包 work/_r_probe.ts → node 执行（真实 normalizePluginOptions/apply）
R-03a normalizePluginOptions({config:null}, ctxConfig) = {"config":null}
R-03b apply(ctx-with-off-config, {config:null}).config.execution.mode = off | jitrl.enabled = false
R-03c apply({}, {config:null}) -> defaults? shadow true
R-03d normalizePluginOptions({config:undefined}, ctxConfig) = {}（JSON 视角；键存在、值为 undefined）
R-03e apply(ctx, {config:undefined}).config.execution.mode = off
```

### 3.2 裁定（ADR 0005 §3.4.1，`docs/adr/0005-p1-evidence-and-atomic-config-contract.md:263-303`）

**`{config: null}` 既不是拒绝、也不是显式清空，而是"未提供配置" → 继承 `ctx.config`**（上下文也没有配置时等价冻结默认）。三候选兼容性表（摘要，完整版在 ADR）：

| 候选 | 影响 | 裁定 |
| --- | --- | --- |
| (a) 拒绝 | YAML/JSON 空值 `config:` 会被解析成 `null`，合法写法变挂载期抛错；且与 C-12（**第二参**为 null 才拒绝）撞名 | 不采纳 |
| (b) 显式清空（等价 `{config:{}}`） | `null` 会用默认值覆盖宿主已声明的 `execution.mode:'off'`/`jitrl.enabled:false` → **静默放宽安全开关**（授权边界明令禁止） | 不采纳 |
| (c) 继承宿主配置 | 零行为改动，方向是保留宿主声明的安全开关 | **采纳** |

实现说明：本裁定**不需要改 `src/index.ts`**（`options.config ?? contextConfig(ctx)` 即该语义），因此未占用 t4/t7 的单写者窗口。

### 3.3 证据

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `pnpm exec vitest run tests/unit/config/plugin-options-shape.test.ts` | 0 | `Tests 28 passed (28)`，其中新增 `R-03 (ADR 0005 section 3.4.1)` 用例钉死：形态为 OPTIONS 形状且 `config` 键存在；`apply(ctx,{config:null})` 继承 `off/false`；`apply({},{config:null})` 等价冻结默认；与 `{config:{}}`（显式清空）、`{config:undefined}`（键缺席形状）三态可区分；混合形态仍抛 `plugin-options-mixed-shape` |
| `pnpm exec tsc --noEmit` | 0（10:20 时点） | — |

### 3.4 未做项

- 无（`src/index.ts` 按裁定无需改动；若未来要改成拒绝/清空，ADR §3.4.1 已写明必须先改 ADR + 补安全开关回归 + 记录破坏面）。

---

## 4. R-04 — `check:docs` 三方闭合与测试根归属

### 4.1 改动（`scripts/verify-readme-counts.mjs`）

- 头注释新增第 5 条拒绝条件（`:24-40`）。
- **测试根归属**（`:476-490`）：消费的每个 Vitest 测试文件必须落在 `/tests/unit/` 或 `/tests/e2e/`；否则逐个打印 `unattributed-root: <file>` 并置 exit 1 —— **第三类测试目录（如 `tests/integration/`）会明确失败并被点名**，而不是从所有计数里被静默丢弃。
- **三方闭合**（`:497-540`）：README 侧 `unit + e2e == total`（files 与 tests 两个维度）且摘要行 == 表 total 行；报告侧 `unit + e2e == total`。失败输出 `count-closure: …`；全部闭合时打印 `✓ Counts close: unit + e2e == total …`。
- 两个新断言**只做三方一致性、不依赖任何绝对值**（lead 裁定第 4 条）：绝对值漂移仍由原第 2 类检查报告，不会伪装成闭合失败。

### 4.2 证据

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `pnpm exec vitest run tests/unit/config/readme-default-leaves.test.ts` | 0 | `Tests 14 passed (14)`；新增 4 例：① 仓内 README 今日自闭合（90+13=103 files、1935+159=2094 tests、摘要==total）；② 第三测试根 → `unattributed-root: /virtual/tests/integration/b.test.ts` + `Vitest counts do not close`（README 数字与报告一致，证明只有新断言在红）；③ README 计数不闭合 → `README counts do not close (tests): unit (1) + e2e (0) != total (2)`；④ 闭合时打印 `Counts close: unit + e2e == total …` |
| `node scripts/verify-readme-counts.mjs --docs-only` | 0 | `78 documented row(s) vs 78 expected`；`SUCCESS: documentation gate fully green`（D4 叶子遍历行为不变） |

### 4.3 未做项

- README 的绝对计数行不在本任务写范围（见 §9 披露与 §10 清单）。

---

## 5. R-05 — 配置测试头注释中 effort 校验描述修正

### 5.1 改动

仅 `tests/unit/config/plugin-options-shape.test.ts:11-31` 的**文件头注释块**：

- 原 "MODEL_ROUTE_EFFORTS enum ENFORCEMENT is not this window…（由 state-wiring follow-up 承接）" 已过时；
  改为 "FIRST ONE IS CLOSED"：宿主 `modelRoute` 组在 `splitModelRoute`（src/host-triggers.ts:975）运行期拒绝、程序化 `route.reasoningEffort` 在 `assertModelRouteEffort`（src/index.ts:2192）拒绝，均具名 `model-route-effort-invalid`/`ModelRouteEffortError`；t4 的类型收窄（`_ROUTE_EFFORT_ENUM_EXACT`）已在位；运行期覆盖在 `tests/unit/seams/status-observability.test.ts`；
- 显式注明 C-11 内联句 "predates that landing and is superseded by this header"（遵守"只改头注释"的边界，内联句未动）。

### 5.2 证据

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `pnpm exec vitest run tests/unit/config/plugin-options-shape.test.ts` | 0 | 28/28（effort 双路径校验行为不变：C-11 的 `[...MODEL_ROUTE_EFFORTS] == ['high','max','low']` 等断言全绿） |
| `pnpm exec tsc --noEmit` | 0（10:20 时点） | — |

---

## 6. R-06 — attestation-target：记录源绑定（已落地）+ CI `pnpm install`（评估，未落地）

### 6.1 已落地：从工作树读记录时显式校验 HEAD blob 一致性

**问题**：`readCanonicalRecord`/`verifyAttestation` 用 `fs.readFileSync` 读**工作树**记录，而所有内容校验从**对象库**重算。CI 检出是干净的，两者一致；脏工作树下门禁可能在"未提交字节"上判绿——而 evidence 提交声明"本提交的唯一内容就是这份记录"。

**改动**（`scripts/eval/check-attestation-target.mjs`）：

- `compareRecordSource(commit, worktreeBytes, cwd)`（`:297`）：用 `git ls-tree`/`cat-file`（复用 `readCommitBlobAtPath`）取**被判定提交**的记录 blob，与工作树字节逐字节比较，产出 sha256 对；
- **evidence 模式 fail-closed**（`:451-457`）：HEAD 无该路径 blob → `attestation-record-not-committed`；字节不一致 → `attestation-record-worktree-drift`。两个新具名码进入头部分类表（`:46-48`）、设计规则 7（`:68-79`）与 USAGE_TEXT（`:669`）；detail 携带两侧 sha256/blobId；
- **ordinary 模式零判据变化**（`:413-419`）：保留 ADR §1.6.2"本地重生成、稍后提交"姿态，worktree/HEAD 对比只进 `notes`（`record source: …`），**绝不改 ok/failures**；
- evidence PASS 也携带绑定 note（`:404-409`），评审可直接看到"被判定字节 == 提交字节"。

**为什么这不算"触及门禁语义"**：T0–T8 拓扑规则与判据零改动；CI 干净检出下两种模式的判定结果与改动前一致（下面 79/79 node:test 与真实仓 exit 0 为证）；新失败只发生在"judged 字节不是提交字节"这一此前**未被检测**的输入上，方向是收紧（fail-closed），不是放宽。

### 6.2 证据

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `pnpm exec vitest run tests/unit/eval/attestation-target-record-source.test.ts` | 0 | 5/5：① evidence+干净 → PASS 且 note `worktree bytes == HEAD blob <blobId> (sha256 …)`；② evidence+脏 → `attestation-record-worktree-drift`，CLI **exit 1**（fail-closed 端到端），detail 含 `worktree sha256=` 与 `committed blob`；③ evidence 提交删除记录（worktree 恢复副本，T3 纯变更 = 该路径）→ `attestation-record-not-committed`，CLI exit 1；④ ordinary+未提交记录 → note `NOT committed at` 且 **ok 仍为 true**（判据不变）；⑤ ordinary+重排版记录 → note `worktree sha256=…` 且 ok 仍 true。每例 60s 预算（实测 3.5–4.8s；默认 5s 预算在全量并发下曾超时，已修复为显式 60s） |
| `node --test scripts/eval/compare-platform-digests.node-test.mjs scripts/eval/final-attestation.node-test.mjs` | 0 | `# tests 79 # pass 79 # fail 0`（CI 同款双套件；T0–T8 既有钉死行为全部保持） |
| `node scripts/eval/check-attestation-target.mjs --json`（真实仓） | 0 | `mode=evidence, ok=true`，note：`record source: worktree bytes == HEAD blob cf8fb513… (sha256 ad0dfb3b…)` |
| `pnpm run attest:verify` | 0 | 提交记录未被本任务改动（`git status docs/reports/final-attestation.json` 为空；stash 0） |

### 6.3 未落地（范围外）：去除 attestation-target job 的非必需 `pnpm install`

**评估结论：可以移除，门禁判定不变**；但 `.github/workflows/ci.yml` 不在本任务写范围（且 ADR 0005 §6.3 规定 ci.yml 单写者串行），故**只出评估结论 + 精确补丁，不落地**：

1. **静态证据**：`check-attestation-target.mjs` 的模块闭包恰为 3 个本地文件（`check-attestation-target.mjs → final-attestation.mjs → lib/git-objects.mjs`），全部 import 均为 `node:` 内建（path/url/child_process/fs/crypto）+ 相对路径；**零 bare specifier**（扫描结果见 §6.4）。
2. **运行时证据**：把 `scripts/eval` 拷贝到无 node_modules 上下文执行 `node …/check-attestation-target.mjs --cwd <fixture> --json` → 模块图加载成功并输出结构化 JSON、exit 1（fixture 无记录 → `attestation-record-missing`，fail-closed 不受影响）——证明该 job 不需要安装依赖即可运行门禁本体。
3. **补丁**（供 lead 采纳）：

```diff
       - name: Set up Node.js 22 with pnpm cache
         uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
         with:
           node-version: '22'
           cache: pnpm
-
-      - name: Install dependencies
-        run: pnpm install --frozen-lockfile
-
       # The gate itself decides ordinary vs evidence from the commit; its exit
       # code is the only verdict. …
       - name: Judge the attestation target binding of this revision
         run: node scripts/eval/check-attestation-target.mjs --json
```

4. **残余注意**：`pnpm install --frozen-lockfile` 在该 job 里附带的锁文件完整性信号会随步骤一起消失（若认为该信号有价值，可保留或单列 lightweight job——超出本任务，由 lead 裁定）。
5. **浅克隆仍明确失败**：本次改动不触碰 ancestry/`rev-list` 路径；shallow 下 ordinary（T7 祖先判定）与 evidence（`HEAD^1` 解析）依旧具名失败，CI job 的 `fetch-depth: 0` 注释理由保持有效。

### 6.4 依赖闭包扫描（复算证据）

```text
扫描方式：对 check-attestation-target.mjs 的 import 闭包逐个文件收集 from/import specifier，
非 '.' 开头且非 'node:' 开头者记为 bare。
closure files: 3
  - scripts/eval/check-attestation-target.mjs
  - scripts/eval/final-attestation.mjs
  - scripts/eval/lib/git-objects.mjs
bare non-node: specifiers: []   （唯一命中为注释散文的误匹配，非 import）
```
---

## 7. R-08 — `PARITY_PLATFORMS` 收紧为字段级 readonly

### 7.1 改动

`scripts/eval/compare-platform-digests.d.mts:6-11`：`ParityPlatform` 的 `os` / `artifactDirectory` 加 `readonly`；`PARITY_PLATFORMS: readonly ParityPlatform[]` 的语义由"只读数组、元素字段可变"变为"字段级只读"，与运行时 `Object.freeze([...])` + 逐元素 `Object.freeze`（`scripts/eval/compare-platform-digests.mjs:91-95`）一致。**运行时形状零改动**（.mjs 未动）。

### 7.2 证据

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `pnpm exec tsc --noEmit` | 0（10:20 时点） | 五个 `ts-expect-error` 负见证全部成立：`first.os = …`、`first.artifactDirectory = …`、`PARITY_PLATFORMS.push(…)`、`PARITY_PLATFORMS[0] = …`、`platform.os = …`；正向读路径类型正常 |
| `pnpm exec vitest run tests/unit/eval/parity-platforms-readonly.test.ts` | 0 | 2/2：三 OS 顺序与 artifactDirectory 名不变、`Object.keys` 恰为 `['artifactDirectory','os']`；数组与每个元素 `Object.isFrozen` 均真；strict 模式运行时改写抛 `TypeError` 且值未变 |
| `node --test scripts/eval/compare-platform-digests.node-test.mjs` | 0 | 既有 parity node:test 全绿（闭集/冻结断言不变） |

### 7.3 未做项

- 无。运行时（`.mjs`）逐元素冻结本就存在，本项只把声明补齐到位。

---

## 8. R-07 — M3 mutation 红数口径（记录，不改判据）

**准确口径**（已写入 ADR 0005 §5.1：M3 行 `docs/adr/0005-p1-evidence-and-atomic-config-contract.md:336` + 口径注 `:349-350`）：

- **注册必红集合 = 2 条**（`scripts/eval/mutation-gate.mjs:228-238` M3 `mustRed`）：
  `tests/unit/orchestrator/credit-attribution.test.ts` 的"① the same trajectory scores the same primary target whether or not it is the composer winner"与"② a missing or failed judge leaves the rewardVersion semantics unchanged"；
- **观测红 = 3 条**：门禁按**整文件**跑，而注册值按 `-t "P6.1-D 7.4"` 过滤重放计；第 3 条为额外判别用例
  "scores a succeeded sibling from its own verifiable signals, not the winner vector"，同样检测"赢家私有标尺"回归，属**更强的额外判别力**；
- 判据是 **must-red 集合 ⊆ 实际红集合（按名字）**（`scripts/eval/mutation-gate.mjs:481-501`），额外红只进 `extraRed` 观察、不参与判据；退出码只由 `ok` 决定；
- 记录格式钉死为"**must-red 2/2、观测红 3（含 1 条额外判别用例）**"，不得把 3 写成注册必红数，也不得反向简写；
- 证据链：`docs/reports/t15-mutation-node24-review.md`（§表格 L29-33、O1 L91：独立 M3/M4 判别力复核 10/10，M3 基线 30 绿 → 变异红 3（mustRed 2/2）→ 还原复绿）、`docs/P62_STATUS.md:220`（§5.2 已按此口径记录）、本报告。

**未做项与理由**：未重跑 `pnpm run check:mutation`（约 30 分钟、8 次 vitest 副本执行）。R-07 是**记录口径**而非重验判据：四个变异目标文件（`src/orchestrator.ts`、`src/cordis-seams/eight-surfaces.ts`、`src/jitrl/host-tool-experience.ts`、`src/jitrl/reward-contract.ts`）本任务零触碰，`mutation-gate.mjs` 判据零触碰，重跑结果不可能因本批改动而变化；且共享工作树同时有他人 in-flight 改动，此时重跑会把他人状态混进记录。verifier 轮如需可按 §11 复算。

---

## 9. check:docs 已知临时红（lead 裁定 B 的披露，非"整体通过"）

**结论：红的只有 README 三行（四行数字、共 6 条比对）绝对值；本任务新增的闭合/归属断言输出"闭合通过"，其余断言（LICENSE/CHANGELOG/叶子遍历/失败与 pending 检查）全绿。**

**时点说明（避免时序误判）**：2026-10-29 10:26 我首轮 `check:docs` 时内层 vitest 尚有 3 条红（全部来自 t3 in-flight 的 `tests/unit/eval/p2-preregistration-v3.test.ts`，属**观测时点**差异；lead 10:31 复测已全绿），fail-closed 因此拒绝消费失败报告。t3 修复后我做了一次**全绿全量跑**（10:40，exit 0）并用同一份报告做了计数分解（10:49 又做了一次刷新，见下）；两次全量均全绿、均满足三方闭合，README 计数行持续漂移：

| 检查 | 命令 | 退出码 | 关键输出（10:40 实测） |
| --- | --- | --- | --- |
| 全量 vitest（计数采集） | `pnpm exec vitest run --reporter=json --outputFile=work/leftovers-counts.json` | **0** | `failed 0 / pending 0 / pass 2216`（unit 99 files / 2057 tests，e2e 13 / 159，total 112 / 2216） |
| 全量 vitest（10:49 刷新） | 同上（重新采集） | **0** | `failed 0 / pending 0 / pass 2250`（unit 102 files / 2091 tests，e2e 13 / 159，total 115 / 2250；闭合 2091 + 159 = 2250 ✓，102 + 13 = 115 ✓） |
| 配置参考（不含计数） | `node scripts/verify-readme-counts.mjs --docs-only` | **0** | `✓ Configuration reference documents every default leaf with the correct default value.`（78/78）；`SUCCESS: documentation gate fully green.` |
| 计数行漂移分解 | `node scripts/verify-readme-counts.mjs --report work/leftovers-counts.json` | **1** | `✓ Report carries zero failed and zero pending tests.` → `✓ Counts close: unit + e2e == total on the README side and the report side, and every test file is attributed to tests/unit or tests/e2e.`（R-04 新断言通过）→ `✓ Configuration reference documents every default leaf …`（78/78）→ **仅** 6 条计数不匹配（下方原文） |
| 编码 | `pnpm run check:encoding` | **0** | `SUCCESS: every tracked blob is LF text or an explicit -text exception`（317 blobs / 3 显式例外；新增文件 untracked，提交后随 attest 受检） |

计数分解的原文（10:40 那次采集；只列计数缺点，别处没有红）：

```text
[docs-verify] ✓ Report carries zero failed and zero pending tests.
[docs-verify] Actual Vitest run metrics:
  - Unit:    99 files, 2057 tests
  - E2E:     13 files, 159 tests
  - Total:   112 files, 2216 tests
[docs-verify] ✓ Counts close: unit + e2e == total on the README side and the report side,
              and every test file is attributed to tests/unit or tests/e2e.
[docs-verify] FAIL: Found discrepancies between README.md and test results:
  - Summary test files mismatch: README has 103, Vitest has 112
  - Summary passing tests mismatch: README has 2094, Vitest has 2216
  - Table unit test files mismatch: README has 90, Vitest has 99
  - Table unit tests mismatch: README has 1935, Vitest has 2057
  - Table total test files mismatch: README has 103, Vitest has 112
  - Table total tests mismatch: README has 2094, Vitest has 2216
[docs-verify] ✓ Configuration reference documents every default leaf with the correct default value.
[docs-verify] FAIL: see the discrepancy report above (counts and/or configuration reference).
```

**精确计数（供 lead 收尾同步 README；采集命令 `pnpm exec vitest run --reporter=json --outputFile=work/leftovers-counts.json`，共享树逐时点）**：

```text
# 10:25 观测（lead 已采信为收尾基准之一）
unit:  98 files / 2048 tests
e2e:   13 files / 159 tests
total: 111 files / 2207 tests

# 10:40 观测（比 10:25 多了 1 个文件 / 9 例，来自其他成员）
unit:  99 files / 2057 tests
e2e:   13 files / 159 tests
total: 112 files / 2216 tests
failed/pending/todo: 0 / 0 / 0
闭合：2057 + 159 = 2216 ✓（files：99 + 13 = 112 ✓）；第三类测试根（unattributed）: 无

# 10:49 观测（本报告写作时点的最新值；工作树仍在增长，最终以 lead 收尾复测为准）
unit:  102 files / 2091 tests
e2e:   13 files / 159 tests
total: 115 files / 2250 tests
failed/pending/todo: 0 / 0 / 0
闭合：2091 + 159 = 2250 ✓（files：102 + 13 = 115 ✓）；第三类测试根（unattributed）: 无
```

因为共享树仍在增长，**最终数字以 lead 收尾统一复测为准**；三行采样都满足 R-04 的三方闭合，README 只需按最终一次实测整体替换。

其中**本任务新增的测试文件与用例数**（其余计数增量来自 t2/t3/t4 in-flight 文件）：

- `tests/unit/contracts/host-advisor-status-mapping.test.ts`（新增文件，9 例）
- `tests/unit/eval/attestation-target-record-source.test.ts`（新增文件，5 例）
- `tests/unit/eval/parity-platforms-readonly.test.ts`（新增文件，2 例）
- `tests/unit/config/plugin-options-shape.test.ts`（+1 例 R-03；R-05 仅注释）
- `tests/unit/config/readme-default-leaves.test.ts`（+4 例 R-04）

即本任务净增 **3 个文件 / 21 例**。

## 10. 改动文件清单（全部在 t1 写范围内）

**修改（8）**

1. `src/host-triggers.ts` — R-01 白名单 + 编译期见证（`:126-156` 文档、`:158-178` 常量与见证、`:212-256` 映射）
2. `src/types/contracts.ts` — R-02 `skipped` 注释（`:1897-1927`，仅注释）
3. `docs/adr/0005-p1-evidence-and-atomic-config-contract.md` — R-03 §3.4.1（`:263-303`）、R-01 §3.7 白名单行（`:310`）、R-07 §5.1（`:336` M3 行、`:349-350` 口径注）
4. `scripts/verify-readme-counts.mjs` — R-04（`:24-40` 头注释、`:476-540` 归属 + 闭合）
5. `scripts/eval/check-attestation-target.mjs` — R-06（imports、`:44-48` 分类表、`:68-79` 设计规则 7、`:253-326` record-source 绑定、`:383`、`:404-409` evidence note、`:413-419` ordinary note、`:451-457` evidence fail-closed、`:665-674` USAGE）
6. `scripts/eval/compare-platform-digests.d.mts` — R-08（字段级 readonly）
7. `tests/unit/config/plugin-options-shape.test.ts` — R-05 头注释 + R-03 用例
8. `tests/unit/config/readme-default-leaves.test.ts` — R-04 四例 + 新 describe

**新增（4）**

9. `tests/unit/contracts/host-advisor-status-mapping.test.ts` — R-01（9 例）
10. `tests/unit/eval/attestation-target-record-source.test.ts` — R-06（4 例，CLI 级真实 git 夹具）
11. `tests/unit/eval/parity-platforms-readonly.test.ts` — R-08（2 例，类型 + 运行时）
12. `docs/reports/p2-r-leftovers.md` — 本报告

**明确未触碰（供 verifier 越界扫描）**：`README.md`（lead 单写者）、`.github/workflows/ci.yml`（R-06 仅评估 + 补丁文本，见 §6.3）、历史负结果报告（`docs/P62_STATUS.md`、`DEVELOPMENT_LOG.md`、`docs/reports/t13/t15/t21-*.md` 等，仅引用未改写）、`src/index.ts`（R-03 裁定无需改动）、`src/jitrl/**`、`src/ledger/**`、`src/dsh-bridge/**`（其他成员所有）、CI 门禁语义与 ordinary/evidence 拓扑规则（未改判据、未放宽规则）、`scripts/eval/mutation-gate.mjs`（判据未动）。

---

## 11. 可复算命令汇总

```bash
pnpm exec tsc --noEmit                                                    # 0（共享树时点见 §12 风险 1）
pnpm exec vitest run tests/unit/contracts/host-advisor-status-mapping.test.ts   # 9 passed
pnpm exec vitest run tests/unit/config/plugin-options-shape.test.ts       # 28 passed
pnpm exec vitest run tests/unit/config/readme-default-leaves.test.ts      # 14 passed
pnpm exec vitest run tests/unit/eval/attestation-target-record-source.test.ts   # 4 passed
pnpm exec vitest run tests/unit/eval/parity-platforms-readonly.test.ts    # 2 passed
pnpm exec vitest run tests/unit/seams/status-observability.test.ts tests/unit/seams/status-observability-contract.test.ts  # 既有全绿
node --test scripts/eval/compare-platform-digests.node-test.mjs scripts/eval/final-attestation.node-test.mjs   # 79 pass / 0 fail
node scripts/eval/check-attestation-target.mjs --json                     # exit 0（真实仓 evidence + record-source note）
pnpm run check:encoding                                                   # 0
pnpm run check:build-smoke                                                # 0
pnpm run check:negative-result                                            # 0
pnpm run attest:verify                                                    # 0
node scripts/verify-readme-counts.mjs --docs-only                         # 0
pnpm exec vitest run --reporter=json --outputFile=work/leftovers-counts.json    # 计数采集命令（§9）
node scripts/verify-readme-counts.mjs --report work/leftovers-counts.json # 计数行漂移分解取证（§9，exit 1 仅计数行）
pnpm run check:docs                                                       # 当前树 = 1（仅 README 计数行；§9）
# verifier 如需重验 M3 口径（约 30 分钟）：
pnpm run check:mutation
```

---

## 12. 遗留风险与授权边界声明

1. **共享树并发**：t2/t3/t4 在同窗口写 `src/jitrl`、`src/ledger`、`src/dsh-bridge` 与 `tests/unit/eval/p2-*.test.ts`。本任务文件在独立运行时 tsc/vitest 全绿；最终判定以 verifier 轮在收敛后的树上复跑为准。教训（lead 已提示）：报告他人状态必须带观测时点，本报告所有观测均已带时点。
2. **check:docs 临时红**（§9）：仅 README 四行绝对值漂移，由 lead 收尾统一同步；未为了让它变绿去动 README。
3. **R-06 CI 部分**（§6.3）：`pnpm install` 移除已评估可行（零 bare specifier 闭包 + 无依赖运行证据），但 ci.yml 写入留给 lead；采纳补丁后建议核对远端 attestation-target job 首跑时长（应显著缩短）。
4. **新文件编码受检时点**：`check:encoding` 只扫 tracked blob；4 个新增文件（3 测试 + 本报告）在提交后才进入该门禁，本批已保证 LF/UTF-8。
5. **R-06 测试时序**：新测试最初用 vitest 默认 5s 预算，在全量并发下曾超时（10:09、10:14 两次观测）；已改为显式 60s 预算并复验（10:20、10:33 均 4/4 绿）。属测试自身预算问题，非门禁行为变化。
6. **授权边界声明（本任务全程遵守）**：未 commit、未 push、未改 git 历史；未发起真实付费模型调用、未跑真实宿主 smoke、未做真实外部工具调用或记忆写入；未修改 CI 门禁语义、未放宽 ordinary/evidence 拓扑规则、未把 CI skipped 当通过（R-06 新码只在"judged 字节非提交字节"输入上收紧）；未使用 holdout 做候选选择、Pareto 过滤或调参；未改写历史负结果、统计数字、阈值或标签（R-07 为口径记录，判据零改动）；未把 estimated 成本当 measured 成本；未把同进程执行称作沙箱。
