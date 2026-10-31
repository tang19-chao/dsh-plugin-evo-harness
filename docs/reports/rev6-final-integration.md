# rev6 最终集成报告

> **结论先行**：rev6 的六组交付均已实现、独立验证并 review pass；全量 Vitest **161 文件 / 2910 测试全绿**，干净副本（含 rev5 历史、不含 `work/`）复跑**同样全绿**；九项门禁全部 exit 0。
> **但这不是"收益已证明"**：真实收益评测 `not-run`、JitRL 门控 `not-evaluable`、可判别消融四臂**未跑**。工程全绿**不能**替代这三条。
> **未提交**：`HEAD` 仍为 `97e38db…`，未 commit / 未 push；真实记忆写入、guarded-active、publish 均未执行。

---

## 0. 一页速览

| 项 | 实测值 |
| --- | --- |
| HEAD（未提交） | `97e38db37305b24f695a5f989428b3611f84987c` |
| 工作树 status 条目 | 111 |
| stash | 0 |
| 交付面文件数（tracked+untracked，不含 `work/`、`node_modules/`） | **483** |
| 全量 Vitest | **161 files / 2910 tests / failed 0**，exit 0 |
| 干净副本全量 Vitest | **161 files / 2910 tests / failed 0**，exit 0 |
| 九项门禁 | 全部 exit 0（详见 §4） |
| 冻结件 rc1 | blob `932f80dae2995786534288827becb8dc2bbe6c3a`（未变） |
| 冻结件 rc2 | sha256 `d62bc9f5c9b0c8f68eca72bf72a5d7492ee11f8fe326bc1e7337813dcb3afa4c`（未变） |
| 漂移预算 | 73 − DR-1..DR-8 = **65** 条冻结，`freeze67.cjs` exit 0 |

---

## 1. 六组交付的验证与审核闭合

每一组都必须「实现 → 独立验证 → review pass」三段齐备。**审核退回过的组，必须 repair 后复审通过，不以 terminal 状态代替 pass。**

| 组 | 实现 | 独立验证 | 交叉审核 | 闭合 |
| --- | --- | --- | --- | --- |
| **R0 发布证明准备** | t8 | t14 | t20 `pass` | ✅ |
| **R1 JitRL 写回干预** | t9 | t15 | t21 `pass` → t28 `pass`（修 T21-F1 后复审）→ **t35 `pass`（当前字节重绑定）** | ✅ |
| **R1 可判别实验** | t10 | t16 | t22 `pass` | ✅ |
| **R2 真实宿主证据** | t11 | t17 `needs_revision` → t32 `pass` | t23 `pass` | ✅ |
| **R2 计量与召回** | t12 | t18 `pass` → t24 `pass` | t24 `pass` | ✅ |
| **R3 真实收益** | t13 | t19 | t25 `pass` | ✅ |
| **R2 rc2 守卫加固** | t33 | t34 `pass` | （由独立 integration review 覆盖） | ✅ |

### 1.1 审核退回的真实闭合链（不以 terminal 代替 pass）

**R2 真实宿主证据**走过两轮退回，全部修复后复审通过：

```text
t17 (verification) needs_revision
  → t29 (repair) 修 T17-F1/F2
  → t30 (verification) needs_revision（发现「无法观测」措辞过度纠正）
  → t31 (repair) 改为「有界观测」
  → t32 (verification) pass（绑定当前字节 in-host ef470b49 / run.mjs 9b887c93 / rc3 d3669fc6）
```

**R1 JitRL** 的 T21-F1（审计记录仍可进入 L2）修复后：

```text
t27 (repair) 修复 + 行为级回归
  → t28 (review) pass
  → t35 (review) pass（重绑定当前字节：src/orchestrator.ts 4c5cfb75 / writeback-intervention.test.ts 49bd3155 / rev6-jitrl-intervention-result.md be27bd35）
```

> **t35 的存在意义**：t15/t21/t28 判 pass 时看的字节，被后续 t27 修复改变。t35 是针对**当前**字节的独立重绑定，本报告引用的是 t35，不是旧 verdict。

---

## 2. rev6 集成修复（本次集成期间发现并修复）

### 2.1 缺陷

全量门禁首次跑出 **1 个真实失败**（此前各组只跑定向套件，无人跑全量）：

```text
× work-path scanner: this repository > has no UNPINNED repo-root work input
→ a new read of the gitignored work/ directory
tests/unit/eval/rev6-ablation-design.test.ts:74  existsSync  "work/t10/ablation.json"
```

`loadPayload()` 读 `work/t10/ablation.json`，而 `work/` 被 `.gitignore` 排除。rev5 的 G5 门禁止仓库根输入依赖 gitignore 内容——**因为干净副本里它根本不存在**，测试会直接抛 `work/t10/ablation.json missing`。

### 2.2 修法（队长批准的方案 B）

把 payload 落成**受跟踪 fixture**，测试改读它；**不放宽 G5 守卫**。

| 项 | 值 |
| --- | --- |
| 新 fixture | `tests/fixtures/rev6/ablation-design.json` |
| 字节数 | 25,468 |
| sha256 | `50126340bff2ae2ee27ed5a34e1ba7e434060f1a1575ec9f4c0b294fffa33920` |
| 与原 `work/t10/ablation.json` | **逐字节相同**（同一 sha256） |
| 未被 `.gitignore` 排除 | `git check-ignore` 无输出 |
| 可入索引 | `git add -An` → `add 'tests/fixtures/rev6/ablation-design.json'` |

**G5 未被放宽的证据**：`ALLOWED_REPO_ROOT_READS` 的 pin 数**仍是 2**（两条均为 `scripts/eval/verify-pr4a-artifacts.mjs`），未新增条目。

**未触碰 t10 的预注册与统计结论**——只改测试输入来源，判据与断言逐条不变。

---

## 3. 干净副本复跑（关键证据）

### 3.1 副本构造的两次尝试（诚实登记）

| 尝试 | 构造 | 结果 | 原因 |
| --- | --- | --- | --- |
| 1 | 扁平复制工作树（无 `.git`） | **10 failed** | p62 的 attestation/evidence 套件需要 `git read-tree 97e38db…`/`84a3d828…`，扁平副本没有历史对象 |
| 2 | 复制 `.git` + 工作树，排除 `work/` 与 `node_modules/` | **全绿** | 保留 rev5 历史，`work/` 缺席 |

**这次失败本身是有价值的**：它证明干净副本必须携带 rev5 git 历史，否则 attestation 类门禁无法运行——这是副本语义要求，不是代码缺陷。

### 3.2 干净副本实测

```text
副本路径   = %TEMP%\t26-clean2-062755
rev5 97e38db 可达 = YES
work/ 存在 = NO（这正是检验点）
全量 test  = 161 files / 2910 tests / failed 0，exit 0
```

**自包含证明**：修好的 `rev6-ablation-design.test.ts` 在**无 `work/` 的副本**中通过——修复前它会直接抛缺文件。

---

## 4. 九项门禁（全部实测，全部 exit 0）

| 门禁 | 命令 | exit | 说明 |
| --- | --- | --- | --- |
| typecheck | `pnpm run typecheck` | **0** | `tsc --noEmit` 无输出 |
| 完整 Vitest | `pnpm run test` | **0** | 161 files / 2910 tests |
| docs | `pnpm run check:docs` | **0** | README 计数已收口（见 §5） |
| encoding | `pnpm run check:encoding` | **0** | 无 CRLF/BOM |
| build-smoke | `pnpm run check:build-smoke` | **0** | `stale:false`，73 exports |
| negative-result | `pnpm run check:negative-result` | **0** | `A1..A6 PASS`，−0.250 与 `{36,18,0}` 未动 |
| guarded-regression | `pnpm run guarded-regression` | **0** | `"passed": 37` |
| mutation | `pnpm run check:mutation` | **0** | M1–M4 全 KILLED，zero-residue OK |
| 冻结预算 | `node work/t7/freeze67.cjs` | **0** | 65/65 逐字节匹配快照 |

### 4.1 门禁补充证据（队长要求纳入）

**t33 守卫负控制**（不是引用，是直接跑守卫函数）：

```text
docs/reports/p61-host-smoke-rc.md   frozen=true   write=REFUSED(frozen-report-protected)   --force=ALLOWED
docs/reports/host-smoke-rc2.md      frozen=true   write=REFUSED(frozen-report-protected)   --force=ALLOWED
docs/reports/host-smoke-rc4.md      frozen=false  write=ALLOWED
```

**t35 当前字节复核索引**：见 §1.1 的三组哈希。

**attestation 状态（N-5 相关，必须原样报出）**：

```text
check-attestation-target: mode=ordinary, targetOk=true   （普通提交自洽，不构成 HEAD 证明）
attest:verify: informational: HEAD is 97e38db…, not the recorded 1b7920ee…
```

⇒ **本轮不主张「HEAD 已被证明」。** 记录所描述的是 `1b7920ee…`，与当前 HEAD 不同。

---

## 5. README 计数一次收口（来自绿色 JSON）

| 项 | 旧值 | 新值 | 来源 |
| --- | --- | --- | --- |
| 全量 | 150 files, 2727 tests | **161 files, 2910 tests** | `pnpm run test` 绿色产物 |
| unit | 132 files, 2510 tests | **140 files, 2629 tests** | `pnpm exec vitest run tests/unit` |
| e2e | 18 files, 217 tests | **21 files, 281 tests** | `pnpm exec vitest run tests/e2e` |

**闭合校验**：`140 + 21 = 161` ✓，`2629 + 281 = 2910` ✓。`check:docs` 收口后 exit 0。

---

## 6. 漂移预算与 DR 授权（rev6 集成裁定，非修改 rev5 契约）

### 6.1 本轮判据

```text
73（rev5 受测路径）− 8（DR-1..DR-8）= 65 条必须逐字节保持
```

`work/t7/freeze67.cjs` 已同步为 8 条白名单，实测 `recorded=73 dr=8 frozen=65`、`SUCCESS: all 65 frozen paths match`。

### 6.2 DR-7 / DR-8 授权记录

| 项 | 路径 | rev5 快照 | 集成前 | 集成后 |
| --- | --- | --- | --- | --- |
| **DR-7** | `scripts/host-smoke/report-path.mjs` | `fe292962…` / 5,881 B | `4e555ea5…` / 7,894 B | 同左 |
| **DR-8** | `tests/e2e/host-smoke/report-path.test.ts` | `c83052d5…` / 8,128 B | `a0aad915…` / 14,361 B | 同左 |

> **性质声明**：DR-7/DR-8 是 **rev6 集成裁定**，用于记录 **t33 的 rc2 防覆盖安全加固**所必需的两处改动。它们**不构成对 rev5 历史契约的修改**——§1.2.1 的原文语义未被改写，此处只是登记「这两条被授权漂移及其理由」。
>
> t33 修复的缺陷：`report-path.mjs` 的守卫只比较 `FROZEN_RC1_RELATIVE`，而 `RC2_RELATIVE` 虽已导出**从未被守卫查询**，导致 rc2 零保护——照着旧附录命令复制粘贴即可覆盖冻结证据。

### 6.3 快照口径提醒

DR-1、DR-2、DR-7、DR-8 这四条在 rev5 快照中的 git 状态是 `??`（从未被跟踪），另四条（DR-3/4/5/6）是 `M`。**因此漂移判定必须用快照哈希比对，不能用 `git status`**——用 git 口径会看不见那四条。

---

## 7. 明确不宣称的三件事（工程全绿不可替代）

### 7.1 真实收益评测 = `not-run`

R3 的账号与硬预算**未绑定**（环境无任何 `R3A_*` / `HOSTSMOKE_AUTHORIZED` 输入；binding 脚本 `runnable:false`，27 个必需键全缺）。`canary` 报 `not-run`、`realCallsMade: 0`。

⇒ **本轮零真实模型调用、零真实付费。** 任何「收益提升/成本下降」的说法在本轮都无数据支撑。合法终态是 `not-run`，不得用 mock 或 estimated 冒充。

### 7.2 JitRL 门控对 C3 的收益 = `not-evaluable`

门的机制已实现并通过判别力验证（反例不被多数淹没、fail-closed、只降不升）。但合成 fair-eval 池**从不附 `metadata.verification`、从不传 `trustedProducers`**，故每条轨迹 verdict 只能 `unknown`、`trustedSource` 恒 false ⇒ G-A/G-B 两条准入路线在该池**结构上不可达**。

180 条写回 ⇒ **0 准入 / 180 仅审计 / `gateFired=180`**。

⇒ 把"门拒绝一切"读成"门有效且带来收益"是预注册 §7 明禁的误读。**这是 `not-evaluable`，不是正收益，也不是负结果。**

### 7.3 可判别消融四臂 = 未跑

设计本身可判别：交互秩 **4/4**、`m_disc ≥ 8` 在 12 任务池可达（Holm 阈 0.05/4=0.0125；2^(1-m) 在 m=7 不可拒、m=8 可拒）、holdout 双向（clean exit 0 / leak exit 1）、**无 Arm-5**。

功效 π*@m=12 = **0.8693**（8⇒0.9725、20⇒0.7987）——这要求约 **87%** 的不一致对同向胜出，属**极强效应**。

⇒ 但**四臂没有跑**，臂级 μ/π 一律 `not-evaluable`，**不得由设计算术反推**。

---

## 8. 未决授权（未执行，不得冒称完成）

| 编号 | 项 | 状态 |
| --- | --- | --- |
| **N-1** | commit / push | **未执行**（HEAD 仍 `97e38db…`，`main...origin/main` = 0/0，stash 空） |
| **N-2** | 真实记忆写入 | **未执行**（`mirror calls=0`，canary `leaked=false`） |
| **N-3** | guarded-active | **未执行** |
| **N-4** | publish | **未执行** |
| **N-5** | 远程 CI 绿 / 「HEAD 已被证明」 | **不主张**（见 §4.1：记录 `1b7920ee…` ≠ HEAD） |
| **N-6** | 改写历史负结果 | **未执行**（−0.250、`deviationStats{36,18,0}`、A1–A6、pr4a 预注册与夹具逐字未动） |
| **R3 绑定** | 账号 + 硬预算 | **缺口**，故真实收益 `not-run` |

---

## 9. 默认安全形状未弱化

| 项 | 实测 |
| --- | --- |
| 执行档位默认 | `shadow` |
| `publish.allowed` | `false` |
| 记忆写入 / 永久 patch | `false` / `false` |
| `publishMemoryDeniedInAllModes` | `true`（guarded-regression 实测） |
| 写回门默认 | `deps.writebackGate` 缺省 ⇒ `false`（历史等价） |
| `whenToApply` 正滤 | 保持默认 **OFF**（shadow 观测 40.0% 命中 / 50.0% 误伤，未启用） |
| Tail Injection | `gated-not-applicable`（无 measured cacheRead） |

---

## 10. 逐项登记的下游 low 项（不阻塞交付）

- **T25-F1**：canary 信任链 `evidenceHash` 绑定当前空转——`buildTrajectory` 未设 `deliverable.contentHash`，故 step-evaluator 的 `expectedEvidenceHash` 检查恒跳过。**未来真实 passed 之前必须硬化**（contentHash = sha256(text) + 负控制）。
- **T25-F2**：控制器注释 "no clock of its own" 与 `runArm` 两处 `Date.now()`（仅用于 metrics）措辞漂移。
- **T25-F3**：`noPolicy` 触发器无可执行负控制（结构性不可达，测试已诚实披露）。
- **T25-F4**：预注册 mtime 与已存证证据相差 **38s**。**两个时刻原样保留、不合并**；在先证据全为非采样（`not-run`/`insufficient`，零真实调用），故「预注册先于真实调用采样」成立。**不升格为违规。**
- **T28-L1**：JitRL 报告计数已由独立补充修正为 10 例。
- **T18-L1 / L2**：按队长指示在本报告登记，不要求新开修复。
- **T21-F1**：审计记录资格过滤缺口，已由 t27 修复、t28/t35 复审通过。
- **T23 / T34**：审核附带的 low 级硬化项，不阻塞。

---

## 11. 证据文件索引

| 文件 | 内容 |
| --- | --- |
| `work/t26/snapshot-final.csv` | 483 个交付面文件的路径 + 字节 + sha256 |
| `work/t26/final-meta.json` | HEAD / status 条目 / stash / 文件数 / 采集时刻 |
| `work/t26/gate-results.json` | 八项门禁退出码 |
| `work/t26/full-vitest.log` | 全量 Vitest 完整输出（161/2910） |
| `work/t26/unit-vitest.log` / `e2e-vitest.log` | 分项计数来源 |
| `work/t26/cleancopy2-path.txt` | 干净副本路径 |
| `work/t7/freeze67.cjs` | 65 条冻结的可执行判据 |
| `work/t23/snapshot.csv` | rev5 基线快照（漂移判定基准） |

---

## 12. 本轮的诚实边界

1. **未 commit / 未 push**，HEAD 未变。本报告描述的是**工作树字节**，不是某个提交。
2. **未执行任何真实付费调用**，R3 结果为空。
3. **未做真实记忆写入 / guarded-active / publish**。
4. **干净副本必须携带 rev5 git 历史**——扁平复制会因 attestation 套件缺历史对象而红。这是副本语义，已如实登记（§3.1）。
5. **本集成期间修改了 3 个文件**（见交付清单）：新增 fixture、改其测试输入来源、README 计数收口。改动范围严格限于修复 G5 违规与计数收口，**未触动任何 rev5 冻结报告或历史契约**。
