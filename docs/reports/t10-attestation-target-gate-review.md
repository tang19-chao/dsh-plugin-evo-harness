# t10 — attestation 目标门禁独立审核（round 1）

- **被审对象**：t2（attestation 证据提交目标门禁）最新实现 + t9 验证证据
- **审核人**：architect-reviewer（独立于实现者与验证者；本报告只新增 `docs/reports/t10-attestation-target-gate-review.md`，未改动任何实现/验证路径）
- **契约**：ADR 0005（`docs/adr/0005-p1-evidence-and-atomic-config-contract.md`）决定 D1
- **结论**：**verdict = PASS**（两项验收全部核实；5 条低/信息级观察如实记录，均不阻塞）
- **日期**：2026-10-29；基线 HEAD `722625c`（P1 改动在工作树未提交，审核期间未被本审核触碰）

---

## 1. 审核方法（独立重放，非采信自述）

1. **逐行读实现**：`scripts/eval/check-attestation-target.mjs`（640 行）对照 ADR §1.3 拓扑表与 §1.4 硬约束逐条核对。
2. **自建对抗夹具**（`work/_t10_review/check.mjs`，reviewer 所有、gitignored，**不复用作者测试**）：每个场景独立新建真实 git 仓库（真实提交 + 真实 `final-attestation.mjs` 生成记录），28 条期望全部验证（27/28 首跑，唯一 FAIL 是我自己的夹具断言错误——把"仓库子目录"误当"非 git 目录"；修正后用真非 git 目录验证为具名 `ref-not-a-commit`，见 §3 S11）。
3. **静态 CI 校验**（`work/_t10_review/ci-check.mjs` + grep）：job 名单唯一性、needs 拓扑、action pin、fetch-depth、persist-credentials、可执行行中无 `--strict`/`HEAD^`/管道/`|| true`/retry/continue-on-error。
4. **独立复跑**：`node --test` 双套件 47/47 + 32/32（= t9 的 79/79）；`pnpm run attest:verify`（旧记录）exit 0 且如实打印"HEAD 未被覆盖"；真实仓 `node scripts/eval/check-attestation-target.mjs` → ordinary PASS、exit 0、**零写入**（记录 sha256 前后均 `675ACF79F9FC75DB…`）。
5. **浅克隆负控制**（`work/_t10_review/shallow-check.mjs`）：full clone → 判定可达（exit 0）；depth-1 clone → **fail-closed**（exit 1、具名 code、无假绿）。
6. **残留检查**：全量套件运行后 refs 恒 9、worktrees 恒 1、stash 恒 0、`pr1-policy-commit-*` uuid refs 恒 0（`pr1-policy-commit` 无后缀分支是历史遗留分支，属 9 个 refs 之一，非泄漏）。

---

## 2. 验收逐项核实

### 2.1 "attestation 拓扑与目标绑定无 HEAD^ 绕过，合法/非法证据提交有实证" — **passed**

| 拓扑（ADR §1.3） | 我的独立实证（真实仓库 + 真实生成器） | 结果 |
| --- | --- | --- |
| T1 证据提交（marker + record-only + 非合并 + 未标记父 + 记录=HEAD^1） | S1：`mode=evidence`、`parentCommitId=C1`、`recordedCommitId=C1`、exit 0 | PASS ✓ |
| T2 记录命名非父提交（更老） | S2：`attestation-target-mismatch`，exit 1 | ✓ |
| T2b 记录命名"更新"的提交（说谎指向 E） | 作者测试同名用例（我复核其 fixture 构造真实）+ 实现按 expectCommit 精确比对 | ✓ |
| T3 证据提交夹带代码（record + src/extra.ts） | S3：`attestation-evidence-impure`，exit 1 | ✓ |
| T3b 触碰非规范记录名（final-attestation-old.json） | 作者测试 + 实现按 `CANONICAL_RECORD_PATH` 白名单过滤 | ✓ |
| T3c 空证据提交（`--allow-empty` + marker，changes=0） | 作者测试；实现 `changes.length === 0` → impure | ✓ |
| T4 合并提交带 marker | S4（2 parents）+ 作者测试：`attestation-evidence-merge`，exit 1 | ✓ |
| T5 证据叠证据（父带 marker） | S5 + 作者测试：`attestation-evidence-stacked`，exit 1 | ✓ |
| T6 记录缺失/坏 JSON/无 commitId（普通与证据两种模式） | S6 ×2 + 作者测试 ×3：`attestation-record-missing`，永不继续 | ✓ |
| T7 记录指向非祖先（外来/改写历史） | S7（无关分支提交）+ 作者测试（plumbing 造孤儿 root commit）：`attestation-record-not-ancestor`，exit 1 | ✓ |
| T8 重复 marker（两行 trailer） | S8a + 作者测试：`attestation-marker-duplicated`，exit 1 | ✓ |
| T8b marker 值非 `first-parent`（`HEAD^`） | S8b + 作者测试：`attestation-marker-unsupported`，exit 1 | ✓ |
| 正文引用 marker（非 trailer） | S8c + 作者测试：归入 **ordinary**（不冒充证据提交），PASS 且输出明示"HEAD is NOT covered" | ✓ |
| 小写键 `attestation-target:` | S8d：非声明 marker → ordinary（fail-safe 方向，不产生假证据声明） | ✓ |
| 记录指向 tree id | S10：具名失败（`ref-not-a-commit` 系），exit 1，绝不跳过 | ✓ |
| 目标正确但内容被篡改 | S9：`attestation-content-mismatch` 且**无** target-mismatch —— 证明 target 命中不豁免内容校验 | ✓ |
| **HEAD^ 绕过面**：无 marker 拿父绑定 | 不可能：无 marker → ordinary，门禁不发明父目标、不声称 HEAD 覆盖（S8c/S8d + 作者测试"invents NO parent target"） | ✓ |
| **自指绕过面**：记录声称覆盖包含它的提交 | 结构上不可能（记录字节进入提交 id 的哈希，不动点不存在）；门禁在 PASS 输出中断言 `recordedCommitId ≠ headCommitId`（作者测试显式钉住） | ✓ |

### 2.2 "CI 使用新规则且不存在恒红、恒绿或 pipefail 回退，历史记录未被伪造" — **passed**

静态与运行时证据（全部本轮实测）：

| 检查 | 结果 |
| --- | --- |
| job 名单（`jobs:` 下） | `verify, guarded-regression, fingerprint, fingerprint-parity, attestation-target, mutation-gate, node24-compat`，唯一、无重复、无 tab |
| `attestation-target` job 结构 | **无 `needs`**（红时不 skip 三平台 parity 证据）；`fetch-depth: 0`；`persist-credentials: false`；三个 `uses:` 全部 40-hex pin（与其他 job 同 SHA）；步骤仅 `pnpm install` + `node scripts/eval/check-attestation-target.mjs --json` |
| 可执行行中的 `--strict` / `HEAD^` | **0 处**（ci.yml 中 1 处 `--strict`、4 处 `HEAD^` 全部在注释里）；无 `|| true`（非注释 0 处）、无 retry、`continue-on-error` 0 处 |
| pipefail 回退 | 新 job 无任何管道（单命令步骤，不存在 `tee` 吞退出码问题）；既有 `fingerprint-parity` 的 `PIPESTATUS[0]` 修复未被触碰（diff 未涉及该 job 步骤体） |
| `verify` job 的 `attest:verify` | 未改（仍无目标参数 = 历史自洽语义；diff 从 :310 起纯追加，唯一 `-` 行是文件末尾缺换行的归一） |
| 不恒红 | 真实仓 HEAD `722625c`（无 marker，记录命名第一父 `56f846a`）→ **ordinary PASS exit 0**；P1 代码提交落地后记录仍命名祖先 → 仍 PASS（内容重算与 HEAD 无关，取自对象库） |
| 不恒绿 | 每次判定都跑内容重算 + 祖先/目标校验 + T6/T8 前置；无任何"无条件通过"输入面（S2/S3/S4/S5/S6/S7/S8/S9/S10/S11 全部具名红） |
| 历史记录未伪造 | `docs/reports/final-attestation.json` 不在 git 修改清单；sha256 审核前后均 `675ACF79F9FC75DBAD28810823A29ACB972687077798D7CF2250A2EF04AADCF5`（= t2 自报值）；`attest:verify` exit 0 且如实打印两条 informational（branch moved / HEAD not covered）；门禁运行零写入（S12：文件清单+mtime 前后逐项相同、`git status` 干净） |
| 既有语义未弱化 | `final-attestation.mjs` diff 仅 +文档 bullet、+`CANONICAL_RECORD_PATH`、+`ATTESTATION_TARGET_MARKER` 两个导出；旧 19 条 `it()` **逐字节保留**（旧文件自首个 `describe(` 起 13318 字节 verbatim 包含于新文件——t2 自报"13318 字节测试块逐字节保留"精确成立）；node:test 47/47、parity 32/32 |

---

## 3. 实现与 ADR §1.4 硬约束逐条对照

| ADR 约束 | 实现 | 核实 |
| --- | --- | --- |
| 1. 复用 `verifyAttestation`（import，不 shell out、不复制校验逻辑）；路径/标记常量单一事实源 | `import { CANONICAL_RECORD_PATH, verifyAttestation } from './final-attestation.mjs'`；marker 字面量本地定义 + 测试钉住与共享常量相等（见 O3） | ✓ |
| 2. 不改 `final-attestation.mjs` 既有语义 | diff 仅加导出；`--verify` 无目标仍历史自洽（实测 exit 0 + 两条 informational）；`--strict` 原语义（t1 原型仍 13/13） | ✓ |
| 3. 每个 git 失败具名、不降级 | `git()` 包装抛 `GitEvidenceError('git-command-failed')`；`resolveCommit`/`parentIds`/`assertAncestor` 失败全部具名传播；CLI catch → exit 1 + 稳定 JSON 形状（真非 git 目录实测 `ref-not-a-commit`；空仓库实测具名 fail） | ✓ |
| 4. 只读记录文件 + 对象库；零写入 | S12 实测：文件清单+mtime 前后相同、worktree 干净、真实仓记录哈希不变；实现无 `fs.writeFileSync` | ✓ |
| 5. `--cwd` 夹具支持（默认锚定脚本所在仓库） | 实现同 `final-attestation.mjs` 的 rootDir 默认；我的全部场景经 `--cwd` 驱动 | ✓ |
| 6. `git interpret-trailers --parse` 提取标记；正文引用不冒充 | S8c/S8d + 作者测试；CRLF 消息实测仍判 evidence（git 自身归一 \r\n，ADR §1.2 的 CRLF 要求行为成立） | ✓ |
| 判定顺序（T8 → T6 → ordinary/evidence[parents → T4 → T5 → T3 → T1/T2]） | 与 ADR §1.4 伪代码一致；T8 先于 T6（畸形 marker 即使记录缺失也先报） | ✓ |

---

## 4. 观察（低/信息级，不阻塞；建议 t16 收录，后续轮次可选）

- **O1（low）**：门禁经 `verifyAttestation` 从**工作树**读规范记录（而非 HEAD 的 blob）。CI 的 checkout 恒干净、且 checkout 与门禁之间没有任何写 tracked 文件的步骤，因此**无 CI 漏洞**；但本地脏工作树会改变判定（我实测：提交了一条被篡改记录的仓 → FAIL，改写工作树副本但不提交 → PASS）。这与 ADR §1.4"复用 verifyAttestation、记录文件除外"的授权一致，属设计注记。**建议**（后续轮次可选）：判定前断言工作树记录与 `git cat-file blob HEAD:<path>` 一致，或直接从对象库读。
- **O2（low）**：浅克隆上失败码为 `attestation-evidence-merge`（grafted 提交在 `rev-list --parents` 下无父）而非专门的 "shallow" code。**fail-closed 且 CI 用 fetch-depth: 0，不可在 CI 发生**；仅本地诊断精度问题。**建议**：用 `git rev-parse --is-shallow-repository` 先检并给具名 `shallow-clone` code。
- **O3（info）**：checker 本地重复定义 marker 字面量（`MARKER_EXACT_LINE`），未直接 import `ATTESTATION_TARGET_MARKER`；测试以真实提交钉住两者一致（drift 即红），行为正确。**建议**：后续直接 import 共享常量更贴合"单一事实源"。
- **O4（info）**：`attestation-target` job 的 `pnpm install` 对 checker（仅 node 内建 + 本地模块）非必需，每轮约多花数十秒 runner 时间；保留它对未来 import 有余地，非缺陷。
- **O5（info）**：`pull_request` 事件检出的 HEAD 是 GitHub 合成 merge commit（无 marker → ordinary），证据提交的父绑定只在它落到 `main` 的 push 事件上被判定——ADR §1.6.3 已声明，无动作。

---

## 5. 结论

t2 的实现与 ADR 0005 决定 D1 在拓扑穷举、父绑定、自指边界、fail-closed、零写入、CI 接线（独立 job、深历史、无管道、无恒红/恒绿）上**全部一致**；t9 对 t2 相关的验证证据（79/79、ordinary PASS 零写入、CI 静态校验、零残留）经我独立重放**全部复现**。两项验收 **passed**，历史记录未被伪造或重生成。**Verdict: PASS**，t2 评审通过。

### 复现方式

```bash
# 1) 门禁套件与 parity（79/79）
node --test scripts/eval/final-attestation.node-test.mjs scripts/eval/compare-platform-digests.node-test.mjs
# 2) 真实仓判定（ordinary PASS，零写入）
node scripts/eval/check-attestation-target.mjs            # exit 0
git status --porcelain docs/reports/final-attestation.json   # (empty)
# 3) 历史自洽语义未变
pnpm run attest:verify                                    # exit 0 + 两条 informational
# 4) 静态 CI 校验（reviewer 脚本在 work/，不入库）
node work/_t10_review/ci-check.mjs
# 5) 自建对抗夹具（28 期望）与浅克隆负控制
node work/_t10_review/check.mjs && node work/_t10_review/shallow-check.mjs
```
