# t15 — mutation gate 与 Node24 CI 独立审核（round 1）

- **被审对象**：t8（四项定向变异门禁 + Node24/CI 接线）+ t9 验证证据
- **审核人**：architect-reviewer（独立于实现者与验证者；本报告只新增 `docs/reports/t15-mutation-node24-review.md`，未改动任何实现路径）
- **契约**：ADR 0005 §5 / D5（mutation 最小集、必红测试名判据、副本隔离、Node24 实跑边界）
- **结论**：**verdict = PASS**（两项验收全部核实；7 条 info 观察，均不阻塞）
- **日期**：2026-10-29；基线 HEAD `722625c`（P1 改动在工作树未提交）

---

## 1. 审核方法（独立重放；未采信 t8/t9 自述）

1. **逐行读实现**：`scripts/eval/mutation-gate.mjs`（1003 行：变异规格、纯函数、副本/隔离、runner、判据、清理、CLI）、`tests/unit/eval/mutation-gate.test.ts`（517 行 / 31 用例）、`ci.yml` 的两个新 job、`package.json` diff。
2. **独立跑 anchor 校验**：`node scripts/eval/mutation-gate.mjs --validate --json` → `{ok:true, problems:[]}`（4 个 anchor 均恰好命中一次；二次应用得 `anchor-not-found`；反向应用逐字节还原 pristine）。
3. **独立跑完整门禁**（我本人执行，报告落 `work/_t15_review/gate-report.json`）：`node scripts/eval/mutation-gate.mjs --run --json --out …` → **exit 0，verdict PASS**；本机 Node `v22.23.1`。
4. **独立判别力复核（M3/M4，我自建）**：`work/_t15_review/indep-m3m4.mjs` —— 自己建临时副本、自己读规格、自己 `split/join` 应用变异、自己调 vitest、自己抽红集（不用 gate 的 runner/judge）：**10/10**。M3 基线 30 绿 → 变异后红 3（含 mustRed 2/2）→ 还原复绿；M4 基线 34 绿 → 红 2（mustRed 2/2）→ 还原复绿。
5. **零残留/零污染核对**：跑前跑后对我记录的 4 个目标文件做 sha256（与 gate 的 witness 一致，全部不变）；`refs 9→9`、`worktrees 1→1`、`stash 0`；`os.tmpdir()` 无 `mutation-gate-*` / `t15-indep-*` 残留；repo `git status` 与审核前一致。
6. **CI 静态分析**（自写脚本）：job 名单/needs 图、Node 版本、超时、`continue-on-error`/`|| true`/retry、uses pin、node24 step 顺序。
7. **专属套件**：`tests/unit/eval/mutation-gate.test.ts` **31/31** 我本人复跑。

---

## 2. 验收逐项核实

### 2.1 "4 个变异体均被目标测试杀死，预期红数准确且临时源码恢复" — **passed**

**我的完整运行结果**（`work/_t15_review/gate-report.json`；fatal=null、copy.removed=true、worktreeWitness.unchanged=true）：

| 变异体 | 目标缺陷（注册） | 基线（同副本、未变异） | sha 变化 | 必红集（按名字） | **观测红数** | 额外红（非致命） | 恢复 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **M1** | R1-M1 provenance 展开删除（`eight-surfaces.ts`） | 6 测试全绿 | ✓ | **4/4**（scenario 1/2/5/6） | **4**（= 注册的 4/6） | 0 | ✓ |
| **M2** | R1-M2 collector 未知身份拒绝块删除（`host-tool-experience.ts`） | 24 测试全绿 | ✓ | **3/3**（scenario 4 + 2 条 D1 单测） | **5**（= 注册的 scenario 4 + 4 条单测） | 2 条（另两条 D1 用例也红） | ✓ |
| **M3** | R3-M1 赢家私有标尺恢复（`orchestrator.ts`） | 30 测试全绿 | ✓ | **2/2**（"同轨迹同尺度"、"judge 缺失不改语义"） | **3** | 1 条（"scores a succeeded sibling from its own verifiable signals, not the winner vector"） | ✓ |
| **M4** | R3-M2 `readLearningTarget` gain 优先（`reward-contract.ts`） | 34 测试全绿 | ✓ | **2/2**（"reads observedReturn first…"、"estimateStateValue averages the contract target…"） | **2**（= 注册的 2 红） | 0 | ✓ |

**红数准确性判读**：
- M1 **精确 4**（注册 R1-M1 = 4/6 红；scenario 3/4 保持绿由原始评审记录，门禁不要求，见 O3）。
- M2 **精确 5**（注册：scenario 4 红 + 单元 4 条红；门禁把 scenario 4 与其中 2 条钉进 mustRed，其余 2 条作为 extraRed 记录）。
- M3 注册的 2 红按**过滤重放**（`-t "P6.1-D 7.4"`）计；门禁跑**整文件**，多出的第 3 条 sibling 用例同样检测"赢家私有标尺"回归——属**更强的额外判别力**，mustRed 2/2 满足，extraRed 如实记录（供 t16 记录；**不得**把它写成"注册 2 红"）。
- M4 **精确 2**。

**判别力真实性**：
- 判据是 `mustRed ⊆ 实际红集`（按 **file :: title**），跳过/挂起**不算红**（`collectRedTests` 只收 `failed`）——不可能用 skipped 冒充击杀；
- 基线必须先在**同一副本**全绿且 `numTotalTests > 0`（`baseline-not-green` / `baseline-no-tests-collected` 具名拒绝），环境失败无判别力；
- 变异必须证明落地：副本内目标文件 sha256 前后必须不同（`mutation-did-not-change-sha`）；
- anchor 唯一性（`anchor-ambiguous` / `anchor-not-found`）、`find===replace`（`mutation-inert`）、路径白名单（仅 `src/`/`tests/`/`scripts/`，拒绝绝对路径/盘符/`..`/node_modules）；
- 我的 M3/M4 独立副本复现了同样的红集与基线绿 → 判据不是作者测试自证。

**临时源码/工作树恢复**：
- 变异**只**发生在 `os.tmpdir()` 的 `mutation-gate-*` 副本（`mkdtemp` + 复制 src/tests/scripts/3 配置 + node_modules junction）；真实工作树从未被写（代码审阅 + `worktree-mutated` witness）。
- 每个变异体：3a 用 pristine 字节重置副本 → 3f 恢复并逐字节核对（`restore-mismatch`）；结束后删除副本（`copy-cleanup-failed` 兜底）。
- 我自己的前后哈希：4 个目标文件全部不变；refs/worktrees/stash 不变；`os.tmpdir()` 与 work/ 无残留。
- `--validate` 还证明：反向应用（swap find/replace）能逐字节还原 pristine、且变异后 anchor 不再存在（不可二次应用）。

### 2.2 "CI 实际包含 Node22/Node24 与 mutation，未误读 runner Node 或回退既有证据门禁" — **passed**

**我的静态分析**（自写脚本逐 job 解析 `ci.yml`）：

| job | needs | node | timeout | 关键步骤 |
| --- | --- | --- | --- | --- |
| verify | — | 22 | 30 | 既有（含 `attest:verify`，未改） |
| guarded-regression | — | 22 | 20 | 既有（未改） |
| fingerprint | verify | 22 | 30 | 既有（未改） |
| fingerprint-parity | fingerprint | 22 | 10 | 既有（未改） |
| attestation-target | — | 22 | 10 | t2 的 job（t8 未改） |
| **mutation-gate** | — | **22** | **30** | `pnpm run check:mutation`（= `mutation-gate.mjs --run`） |
| **node24-compat** | — | **24** | **30** | setup-node `'24'` → **`node -v`** → `pnpm install --frozen-lockfile` → `pnpm exec vitest run tests/unit` → `node scripts/eval-jitrl.mjs --json` → `node scripts/eval/negative-result-diag.mjs --assert` |

- **Node24 真实性**：显式 `actions/setup-node` `node-version: '24'`（不是 runner 自带），并在 install/测试**之前**打印 `node -v`（step 顺序已核对：node -v → install → unit → eval → negative）；job 名含 "Node 24"；`24` 只出现在该 job；Node22 的 `verify` job 仍是官方计数来源（README 由 t17 同步，Node24 job 不触碰计数）。
- **不误读 runner Node**：无任何 `${{ env.node }}`/runner 默认版本推断；Node24 只能来自 setup-node 的显式安装；本地未安装 Node24（仅 `v22.23.1`），因此 **Node24 结论只能来自授权推送后的 Actions 日志**——本审核不作远端断言（诚实边界）。
- **不回退既有证据门禁**：diff 仅**追加**两个 job；`verify`（含 attest:verify）、`guarded-regression`、`fingerprint`/`fingerprint-parity`、`attestation-target` 的步骤体零改写（t8 的单测也钉住 t2 块与 verify 块）；新 job 均**无 `needs`**（mutation 红不会 skip 跨平台证据；node24 红不阻塞任何 job）。
- **无假绿通道**：`continue-on-error` 0 处、`|| true` 0 处、`retry` 0 处；22 个 `uses:` 全部 40-hex 固定；两个新 job 的 checkout 均 `persist-credentials: false`。
- **package.json**：仅新增 `"check:mutation": "node scripts/eval/mutation-gate.mjs --run"`；attestation/guarded-regression 等既有脚本值逐字节不变；devDependencies/dependencies 未变（diff + t8 单测的深相等断言双证）。
- **运行时长**：本机完整 `--run` 约 2–3 分钟（报告时间戳 2026-10-29 04:16:39 +08:00），远低于 CI 的 30 分钟超时；CI 端 e2e 目标套件在 ubuntu 上的实际时长属远端实测（未推送前不宣称）。

---

## 3. 实现审查要点

- **规格可校验**：`validateMutantSpec` 检查 id 形状、文件/测试文件/mustRed 文件路径白名单、edit 非空且非 inert、mustRed 非空且必须属于该变异体实际运行的文件、无重复项。
- **anchor 稳定**：文本块锚点（非行号）、EOL 自适应（LF/CRLF 两种拼写，仓库 `text eol=lf` 与 Windows CRLF 检出均可命中）、`split/join` 而非 `String#replace`（代码里的 `$` 序列不被解释为替换模式）。
- **判据与记录分离**：mustRed 按名字子集；`observedRedCount`/`extraRed`/`redTests` 全量写入报告，供 t16 记录；退出码只由 `ok` 决定。
- **隔离与清理**：副本 + junction（win）/dir symlink（linux），失败回退 per-entry symlink；成功/失败/异常统一清理；真实工作树 sha256 witness；`copy-cleanup-failed`/`worktree-mutated` 具名致命错误。
- **测试只测纯函数 + CI 静态契约**：31 用例（规格、anchor/恢复、EOL、red 判据、baseline、路径安全、sha/EOL、CI/package 接线），**绝不在 vitest 内跑变异**（避免递归），符合 ADR §5.1-6。
- **无新依赖**：spawn 仓库自带 `node_modules/vitest/vitest.mjs` + `process.execPath`，不嵌套 pnpm。

---

## 4. 观察（info 级，不阻塞）

- **O1（info，红数口径）**：M3 观测红数 3 与注册的"R3-M1：2 红"不同——注册值是**过滤重放**（`-t "P6.1-D 7.4"`）的口径，门禁跑整文件后第 3 条 sibling 用例也红（额外判别力）。t16 记录时必须写"mustRed 2/2、观测红 3（含 1 条额外）"，**不得**简写为"注册 2 红"或反过来把 3 当成注册值。
- **O2（info，CI 证据形态）**：CI 的 `pnpm run check:mutation` 未带 `--out`，机器可读报告（`observedRedCount`/`extraRed`/`redTests`）不会作为 artifact/job summary 持久化；人类可读输出包含 `red=X/Y must-red hit`，t16 可引用日志。若希望远端可复核结构化证据，可后续在 job 里加 `--json --out`（属可选加固，不改判据）。
- **O3（info，M1 保持绿的场景不校验）**：门禁只要求 mustRed 4 条红，不校验 scenario 3/4 保持绿（ADR D5 的"必红子集"判据刻意如此；额外红被容忍）。当前观测恰好 4 红，与注册"4/6"一致。
- **O4（info，Node24 版本打印位置）**：`node -v` 在 install/测试之前打印（证明 setup-node 生效）；若再在 vitest 步骤前打印一次，可把"测试实际使用的版本"也钉进日志（防御性加固，非缺陷）。
- **O5（info，副本内容来源）**：副本复制的是**当前工作树**（含未提交 P1 改动）——本地运行语义正确；CI 上工作树即提交树，因此 CI 的变异针对提交源码（构造上一致）。
- **O6（info，fileErrors 未进报告）**：`collectRedTests` 会收集"无 assertion 的 suite 级失败"（fileErrors），但 runner 未把它写入报告/判据；由于 mustRed 按名字硬性要求具体用例失败，文件级错误会以 `must-red-not-satisfied` 失败（不会假绿），只是诊断里看不到原始错误信息（可选改进）。
- **O7（info，文档）**：README 命令表尚未列出 `pnpm run check:mutation`（t17 已标给 t16）；不属于 t8 验收。

**无 blocker / 无 high / 无 medium findings；验收两条均满足。**

---

## 5. 复现方式

```bash
# 1) anchor 校验与清单
node scripts/eval/mutation-gate.mjs --validate --json
node scripts/eval/mutation-gate.mjs --list
# 2) 完整门禁（我本人跑过：exit 0，报告落盘）
node scripts/eval/mutation-gate.mjs --run --json --out work/_t15_review/gate-report.json
# 3) 独立 M3/M4 判别力（自建副本/自建变异/自建抽红）
node work/_t15_review/indep-m3m4.mjs
# 4) 门禁单测
pnpm exec vitest run tests/unit/eval/mutation-gate.test.ts
# 5) CI 静态
node -e "…（见报告 §2.2 的 job/needs/node/timeout 解析）"
```
