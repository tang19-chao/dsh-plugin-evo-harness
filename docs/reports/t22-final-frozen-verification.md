# t22 终态冻结字节独立复验报告（七门禁 + 三组专项）

| 项 | 值 |
| --- | --- |
| 任务 | t22（verification）— 冻结终态字节独立复验七门禁 |
| 验证者 | gate-verifier（独立于全部实现者） |
| attempt | 1 / `2d9a43b5-9f35-459f-8400-1d92ee9520da` |
| 冻结条件 | t21 + t12 + t24 + **t25** 之后工作树不再改动 `src/**`、`tests/**`、`scripts/**` |
| 契约口径 | ADR-0003（accepted, rev.3）、ADR-0002 §11.1 七门禁 |
| 结论 | **PASS — 冻结字节自洽；验证前后代码组合指纹一致（无漂移）** |

> 本报告**关门** t7 / t8 / t9 / t13 / t19 / t20 等「verdict 覆盖修订已不存在」的历史缺口：它们绑定的旧字节已被后续修复取代，本报告在**当前冻结字节**上重新绑定。

---

## 1. 冻结字节绑定（本 verdict 覆盖的修订）

### 1.1 代码面组合指纹（可复现，构造式由脚本固化）

| 项 | 值 |
| --- | --- |
| 命令 | `node scripts/eval/final-attestation.mjs` |
| 机器可读清单 | `docs/reports/final-attestation.json`（schema 1.0.0） |
| 文件数 | **206**（`src/` + `tests/` + `scripts/`，扩展名 `.ts/.js/.mjs/.cjs/.json`） |
| **组合 SHA-256** | **`13c4c3cff2c59183dc49416e242a0231bfbda1adb6ff7057a96b5e4b2ee693be`** |
| 构造式 | POSIX 相对路径（无 `./`）· ordinal 排序 · 行 = `${path}:${fileSha256}` · LF 连接 · **无尾换行** · UTF-8 · `SHA256(lines.join('\n'))` |

**独立复算（关键：不复用 t25 脚本，按构造式自写实现）**——`work/_t22-recompute.ts`：

```
file count        = 206
composite (mine)  = 13c4c3cff2c59183dc49416e242a0231bfbda1adb6ff7057a96b5e4b2ee693be
composite (script)= 13c4c3cff2c59183dc49416e242a0231bfbda1adb6ff7057a96b5e4b2ee693be
composite match   = true
manifest entries  = 206
only in mine      = 0
only in manifest  = 0
hash mismatches   = 0
```

⇒ 组合指纹**独立可复现**，且 manifest **覆盖完整、无遗漏、无多余**。

### 1.2 代码面 tracked diff 指纹

| 项 | 值 |
| --- | --- |
| 命令 | `git diff -- . ':(exclude)docs/P62_STATUS.md' ':(exclude)docs/reports/**'` |
| SHA-1 blob | `846c85ee0c06471226cfc0150e7d84e912d9a323` |
| SHA-256 | `bd6fad155a6418a38856cfdd5e96c41fce11969f1ea0bc335b0c4699251d34b5` |
| 字节 | **96,795** |
| 文件数 | **11** |

**独立复核**：用 `Start-Process` 直接落盘 `git diff` 原始字节（**不经 PowerShell 文本管道**）复算，SHA-1 / SHA-256 / 字节 / 文件数**四项全部吻合**。

> **对既有争议的结论（已闭环）**：先前出现的「96,795 vs 94,540」差异，根因是 **PowerShell 以 LF 拼接文本时丢弃了 2,255 个 CR**，不是仓库内容问题。直接取原始字节即得 96,795。**t12 记录的字节数正确**。

### 1.3 HEAD 与关键文件哈希（sha256 前 16）

| 文件 | sha256[:16] |
| --- | --- |
| **HEAD** | `9ea9b7edacb199884df2020df879f4e59ed66d73` |
| `scripts/eval/final-attestation.mjs` | `001f4c94d0e03311` |
| `docs/reports/final-attestation.json` | `b7210330b14d085b` |
| `src/verification/attach.ts` | `a98d17a8640b0bef` |
| `src/verification/host-runner.ts` | `97ff4c19a421ee34` |
| `src/verification/artifact-digest.ts` | `8bdfac7768abbbcf` |
| `src/verification/types.ts` | `3a5efe99ba2bb30a` |
| `src/verification/index.ts` | `a5361efc7c8b3e9d` |
| `src/ledger/types.ts` | `1d6dad849522ed34` |
| `src/ledger/reservation-manager.ts` | `18ca2b20a2bfe288` |
| `src/ledger/pricing.ts` | `4831a17d7a520eeb` |
| `src/ledger/ledger-event.ts` | `333959a84e60fde0` |
| `src/ledger/index.ts` | `dbcf706f4f4959e7` |
| `src/orchestrator.ts` | `de6439b083a42c83` |
| `src/index.ts` | `d2693183c90b7a2a` |
| `src/dream-rsi/offline-dreamer.ts` | `d7b1346be0c5a3b1` |
| `src/jitrl/decision-kernel.ts` | `fdf68a441f15b4fe` |
| `src/jitrl/step-evaluator.ts` | `50acb8b6fe8d8794`（未改动） |
| `src/jitrl/reward-contract.ts` | `6c42f29e1c212e66`（未改动，r4 标尺不变） |
| `src/types/contracts.ts` | `e1ba3da9683b2475`（未加宽） |
| `src/cordis-seams/trajectory-collector.ts` | `2935f349dd02d9f7`（有意零改动） |
| `scripts/eval/guarded-regression.mjs` | `9c151d5c7969e542` |
| `scripts/fixtures/ledger/scenarios.ts` | `54a3110d02493875` |
| `README.md` | `a35a3750a3ee2e15` |
| `docs/P62_STATUS.md` | `5ed8315d28f97a08` |
| `tests/unit/ledger/offline-fixtures.test.ts` | `556acf3fbb193aa2` |
| `tests/unit/p62/release-contract.test.ts` | `7a66e6ddd2213f78` |
| `tests/unit/verification/audit-provenance.test.ts` | `406c1286910e0389` |
| `tests/e2e/c2a-trusted-verification.test.ts` | `6b41e9d3b7157d96` |

### 1.4 无漂移证明

验证**前**记录组合指纹 → 串行跑完七门禁 + 三组专项 + 自建探针 → 验证**后**重算：

| 时点 | 组合 SHA-256 |
| --- | --- |
| 验证前 | `13c4c3cf…693be` |
| 验证后（重跑 attestation）| `13c4c3cf…693be` |
| 验证后（我自己的实现重算）| `13c4c3cf…693be`，mismatches = 0 |

⇒ **全部门禁与探针均为只读**，未污染被验字节。

---

## 2. 七门禁（串行执行，全部 exit 0）

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `pnpm run typecheck` | **exit 0** — `tsc --noEmit`，0 error |
| 2 | `pnpm test` | **exit 0** — **86 files / 1666 tests** passed |
| 3 | `pnpm run check:docs` | **exit 0** — SUCCESS；Unit 74/1509、E2E 12/157、Total 86/1666，与 README **逐项一致** |
| 4 | `pnpm run build` | **exit 0** — 产出 `lib/index.js`（955,842 B） |
| 5 | `node scripts/eval/negative-result-diag.mjs --json` | **exit 0** — `meanDelta = -0.25`、`historical = -0.25`、**`matchesHistorical = true`**、退化任务 `ci-04 / mig-01 / mig-02 / mig-04 / test-03` **原样保留** |
| 6 | `node scripts/eval-jitrl.mjs --json` | **exit 0** — JSON 可解析，seed **`0xfe348428`**（suite fingerprint，metric block 确定性） |
| 7 | `node scripts/eval/guarded-regression.mjs --json` | **exit 0** — summary **`{total:33, passed:33, failed:0}`** |

---

## 3. 三组专项（全部 exit 0）

| 组 | 命令 | 结果 |
| --- | --- | --- |
| **C1.1** 发布受体 | `vitest run tests/unit/p62/release-contract.test.ts tests/unit/jitrl/runtime-control.test.ts tests/unit/dream-rsi` | **9 files / 249 tests** passed |
| **C2a** 可信证据 | `vitest run tests/unit/verification tests/e2e/c2a-trusted-verification.test.ts` | **5 files / 62 tests** passed |
| **C3** 成本台账 | `vitest run tests/unit/ledger` | **3 files / 36 tests** passed |

> 计数口径说明：C2a 的 62 = `unit/verification` 56（attach 24 + host-runner 14 + audit-provenance 9 + recorder-marks 9）+ `e2e/c2a` 6，与 t12 §L180 记录逐项吻合。**我曾误用 `cordis-seams` 替代 `e2e/c2a` 得到 58 并据此怀疑 t12，此处更正：t12 该数字正确。**

---

## 4. 自建独立探针（不复用实现者测试逻辑）

### 4.1 C1.1：deny 下真实零副作用

`work/_t7-verify-c11.ts`（在冻结字节上复跑）：**`verdict = ALL_DENY_PROPERTIES_HOLD`，`failures = []`**

| 用例 | 关键观测 |
| --- | --- |
| A 生产形态 | `publish=false` / `shadowPublished=false` / **applyCalls=0** |
| B 调用方强制 `shadowMode=false` | 仍 `publish=false` / **applyCalls=0** / reason=`publish-denied` |
| C 授权正控 | `publish=true` / **applyCalls=1**（证明非硬编码永久 deny） |
| D 真实持久化（先播种 revision） | **`historyLineDelta=0`**、策略 id/version 不变 |
| E Jit-wired × on/off | 均 `publish=false` / `applyCalls=0` |

### 4.2 C2a：认证与审计

`work/_t8-verify-c2a.ts`（复跑）：**`verdict = ALL_C2A_PROPERTIES_HOLD`，`failures = []`**

- 真值表：`succeeded+passed`→auditOnly=false；**`succeeded+failed`→`falsified-success-claim`（未被遗漏）**；`failed+failed`→auditOnly=false（可靠失败正例未被误扫）；`failed+passed`→`contradictory-verdict`；**`timeout+failed`→`execution-not-completed`**
- 伪造/越权：未注册回执→`unregistered-receipt`（attached=false，auditOnly=true）
- 审计隔离：审计记录无过滤查询**可见 1 条**（非空洞前提）、`learningEligibleOnly` **0 条**

### 4.3 C3：零成本地板与重复预留

`work/_t22-c3.ts`（本次新建，在冻结字节上运行）：**`verdict = ALL_C3_PROPERTIES_HOLD`，`failures = []`**

| 用例 | 观测 | 判定 |
| --- | --- | --- |
| F-1 无 usage、cost=0 | incurred=**10,000**、provenance=`unknown`、conservative=true、surcharge=**10,000** | ✅ 保守非零地板 |
| **F-1c 反向对照：measured 且 cost=0** | incurred=**0**、provenance=`measured`、conservative=**false** | ✅ **关键：地板只作用于 unknown，未用 overcharge 换 silent-zero** |
| F-1b 有 usage 但精度 unknown | incurred=**10,000**、provenance=`unknown` | ✅ |
| F-1d 高于地板（20,000） | incurred=**20,000**（不向下夹、无虚假附加费） | ✅ |
| **F-2 已结算后再次 reserve** | `granted=false`、reason=**`call_already_settled`**、`reservationId=null`；预算 `100,000→90,000` 在拒绝前后**不变**、席位恒 4、事件数恒 1 | ✅ **零泄漏** |
| F-2 其他 callId | `granted=true`（不受影响） | ✅ |
| F-2b 活跃重复 reserve | 仍报 `duplicate_active_call`（新检查未遮蔽既有码） | ✅ |

---

## 5. 文档口径与「未做事项」核对

| 检查 | 结果 |
| --- | --- |
| README 计数与实测一致 | ✅ 86 files / 1666 tests（check:docs 机械校验通过） |
| guarded 33/33 | ✅ |
| 历史 `meanDelta = -0.25` 保持 | ✅ `matchesHistorical=true`，退化清单原样 |
| 旧不可复现组合指纹 `c631c281…` 是否已退役 | ✅ 文档仅剩 t25 变更记录中**显式声明退役**的一处引用，无任何地方再把它当作当前指纹 |
| 自指陈旧数字（Z-3） | ✅ `P62_STATUS.md` 改为**排除口径**（排除 `P62_STATUS.md` 与 `docs/reports/**`），diff 指纹 `846c85ee…` / 96,795B / 11 files 可复算 |
| Z-1 r4 边界用例空转 | ✅ 已修：先 `runAllPhasesWorkflowScenario(manager)` 并 `expect(events.length).toBeGreaterThan(0)` 建立非空洞前提，再遍历断言无 `learningTarget` / `contractWeightsHash` |
| 11 场景 / 12 it 表述 | ✅ `offline-fixtures.test.ts` 12 个 `it()` = 11 个场景函数（全部被引用）+ 1 条 r4 边界；`scenarios.ts` 导出恰好 11 个 `run*Scenario`，**零死 fixture** |

### 5.1 边界与诚信声明（严格对齐 ADR-0003 §8.1 六态）

- **C2b 质量消费者接线：未做**。`task-quality` 记录仍被 `PRODUCTION_LEARNING_TRACK='process'` 全量生产消费者预过滤 ⇒ **本轮不宣称「可信验证已生效于学习」**。
- **C3 生产接线：未做**。`src/ledger` 之外零 import，交付的是**可测试数据基础**，不是可用成本门禁；**不宣称任何节省或收益**。
- **C4 / D：未做**。无部署、无真实付费模型调用、无真实 memory 写入。
- **全仓 `released` 恒为否**；`release_authorized = ✗`、`actually_applied = ✗`。
- 未执行 `git commit` / `git push`。
- 本报告**只新增自身**，未修改任何被验字节（已由 §1.4 前后指纹一致证明）。

---

## 6. 复现

```bash
# 组合指纹 + tracked diff（唯一权威来源）
node scripts/eval/final-attestation.mjs
# → 206 files / 13c4c3cf…693be / diff 846c85ee… / 96,795B / 11 files

# 七门禁
pnpm run typecheck
pnpm test
pnpm run check:docs
pnpm run build
node scripts/eval/negative-result-diag.mjs --json
node scripts/eval-jitrl.mjs --json
node scripts/eval/guarded-regression.mjs --json

# 三组专项
pnpm exec vitest run tests/unit/p62/release-contract.test.ts tests/unit/jitrl/runtime-control.test.ts tests/unit/dream-rsi
pnpm exec vitest run tests/unit/verification tests/e2e/c2a-trusted-verification.test.ts
pnpm exec vitest run tests/unit/ledger

# 自建独立探针（抗「脚本自证」）
pnpm exec esbuild work/_t22-recompute.ts --bundle --format=esm --platform=node --target=node20 --outfile=work/_t22-recompute.mjs && node work/_t22-recompute.mjs
pnpm exec esbuild work/_t7-verify-c11.ts  --bundle --format=esm --platform=node --target=node20 --outfile=work/_t7-verify-c11.mjs  && node work/_t7-verify-c11.mjs
pnpm exec esbuild work/_t8-verify-c2a.ts  --bundle --format=esm --platform=node --target=node20 --outfile=work/_t8-verify-c2a.mjs  && node work/_t8-verify-c2a.mjs
pnpm exec esbuild work/_t22-c3.ts         --bundle --format=esm --platform=node --target=node20 --outfile=work/_t22-c3.mjs         && node work/_t22-c3.mjs
```
