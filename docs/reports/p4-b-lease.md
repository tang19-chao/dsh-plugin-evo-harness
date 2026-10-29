# P4-B 交付报告：租约与 ScopeRegistry 完整性

| 项 | 值 |
| --- | --- |
| 任务 | t8 / P4-B（团队 `p2-p6-execution`，成员 p4-isolation） |
| 日期 | 2026-10-29 |
| 上游契约 | ADR 0006（`docs/adr/0006-host-identity-trust-and-mount-isolation.md`：sessionId 永不承担 branch identity、`authorizesBranch` 类型级 false、fail-closed 必须可计数） |
| 写入范围 | `src/jitrl/scope-registry.ts`、`tests/unit/jitrl/scope-registry-lease.test.ts`（新建 19 测试）、本报告；另按队长本轮明确要求补全 ADR 0006 §6.3 的"收紧后的预期行为"一行（纯文档，见 §7） |
| 结论 | **完成**：租约在兄弟探针、并发复用、重复注册、旧 handle 延迟 dispose、TTL 过期、adapter dispose 六类场景下不退化；负控制 3 条实测真红并按字节恢复 |

## 1. 对队长三条硬要求的正面回答

### 1.1 WeakMap 租约是真 WeakMap，不是 Map<id> 伪装

- 载体 → 租约的关联是 `const carrierLeases = new WeakMap<LeaseCarrier, string>()`（键是 agent 对象本身）。租约记录（`LeaseRecord`）与对外 handle **都不持有载体对象**：记录里只有一个 `WeakRef`（`record.carrierRef`），handle 完全没有载体字段。
- **"对象被 GC 后租约自动消失"的证明方式**（测试 `holds no strong reference to the carrier`）：
  1. **结构性证明（默认运行就断言）**：`Object.getOwnPropertyNames(lease)` 不含 `carrier`/`carrierRef`；handle 与 `leases()` 摘要的每个值都不是该对象（`every(v => v !== carrier)` / 无对象值）。因此注册表/handle 的可达路径上不存在对载体的强引用。
  2. **真 GC 证明（`NODE_OPTIONS=--expose-gc` 时进入同一用例的分支，非 skipped 测试）**：载体在独立 helper 作用域内创建（测试作用域不留强引用），随后 `await setTimeout(0) + gc()` 循环后断言 `new WeakRef(carrier).deref() === undefined` —— 对象被回收，即 WeakMap 关联自动消失；同一断言同时确认"租约记录仍然有效"（GC 清掉的是**关联**，不是有时限的租约本身，租约仍按 TTL/release 生命周期管理）。
  3. 实测：`$env:NODE_OPTIONS='--expose-gc'; pnpm exec vitest run tests/unit/jitrl/scope-registry-lease.test.ts -t 'holds no strong reference'` → **exit 0**（`1 passed`）；默认（无 `--expose-gc`）运行时该分支不进入，结构断言照常执行 —— **没有 skipped 测试**（check:docs 拒绝 pending，本任务不引入）。
- 为什么"不会漏"：载体被回收 ⇒ WeakMap 条目随之消失，注册表侧唯一残留是租约记录，而记录的寿命被 TTL 严格封顶（`sweepExpired` 清扫 + 读路径惰性终止 + 计数一次）。

### 1.2 invariant key 级不可变：按时间顺序写用例，不是孤立断言

| 时间顺序用例（`tests/unit/jitrl/scope-registry-lease.test.ts`） | 抓的 bug |
| --- | --- |
| `A(domain) → A2(invariant) → dispose(A) → 断言 A2 仍有效且 invariant`（`A2 stays valid and invariant`） | 旧 handle 延迟 dispose 删掉新登记（P4-B 修复前 `dispose` 无版本检查就会删） |
| `invariant → domain/advice 重复注册 → 断言仍是 invariant/guidance_free/allowAdvice=false + downgradePrevented≥1 → 旧 handle dispose 是 no-op → 现任者 dispose 才删键`（`refuses a downgrade sequence`） | 重复注册降级 + 旧 handle 误删 |
| `register → unregister → 旧 handle dispose → 断言不复活`（`cannot resurrect or fabricate a registration`） | 版本未随 removeInternal 递增导致的"幽灵复活" |
| `同键重复注册 → size===1 → 旧 handle dispose 不影响 → 现任 dispose 清空`（`re-registering the SAME key refreshes`） | 重复注册变成两条或互相删除 |
| adapter 场景：`mount A → mount A2 → dispose(A) → A2 仍在`（`disposing the adapter does not resurrect a replaced scope`） | 真实 hook adapter 的 mount handle 与注册表版本交互 |

实现机制：每个 compound key 一个单调版本号（`registrationVersion`）；handle 只能释放**它自己创建的版本**（`dispose` 先校验版本与当前 scope 对象，不匹配 → `staleDisposeNoop += 1` 的 no-op）；`removeInternal`/`evictOldestIfNeeded` 都会递增版本，所以任何移除之后所有旧 handle 都变 stale。invariant 是"地板不是模式"：`isInvariant = requested || existing.isInvariant`，`guidance`/`allowAdvice` 取更严值，每次被阻止的降级计入 `downgradePrevented`（升级计入 `invariantUpgrades`，替换计入 `registrationsReplaced`，粘滞计入 `stickyInvariantKept`）。

### 1.3 sessionId 租约：**证明，不是假定**（正面回答清单原文"当前设计不能直接假定单占用"）

- **授予时证明**：`acquireSessionLease` 调 `proofOf(sessionId)`，从**实时状态**重算三个事实——恰好 1 个 live branch scope、恰好 1 个绑定该 branch 的 live branch lease、0 个其他 live session lease。任一不成立 → 结构化拒绝 `{ok:false, code:'single-occupancy-unproven', details:{liveScopes, liveBranchLeases, liveSessionLeases}}` 并计数。
- **持续证明（不是授予时一次性的）**：`validateSessionLeases(now())` 在**每次变更后**（register/acquire/release/unregister/prune/sweep）重算；proof 不再成立 ⇒ 旧 session lease 立即失效（`sessionInvalidated += 1`）。会话租约 handle 的 `isActive` getter 也重算（观察点惰性失效），因此**不可能读到"已失效但仍 active"的租约**。
- **违反时报错的断言**（测试钉死）：
  - 零占用 / 有 scope 无 lease → 拒绝（`refuses with zero occupants and with a scope but no lease`）；
  - **兄弟探针**：同 session 两个 branch 各持 lease → 拒绝且 `details` = `{liveScopes:2, liveBranchLeases:2, liveSessionLeases:0}`（`sibling probes in one session can never hold a session lease`）；
  - **并发复用**：先证明单占用授予，随后第二个 branch 出现 → 租约**立即** `isActive === false` + `sessionInvalidated === 1` + `sessionLeaseProof().proven === false`（`invalidates an existing session lease the moment a second occupant appears`）；
  - 占用者 lease 被 release → session lease 失效（`grants only for the proven single occupant`）；
  - 重复授予 → `session-lease-active` 拒绝；空 `sessionId` → `identity-required`；缺 `grantedBy`/`reason` → throw。
- `SessionLease.authorizesBranch` 与 host scope 一样是**类型级字面量 `false`**：session 租约证明的是"该会话此刻只有一个占用者"，永远推不出 branch 身份。

## 2. 六个验收场景 ↔ 测试映射

| 场景 | 测试（同一文件） | 关键断言 |
| --- | --- | --- |
| 兄弟探针 | `sibling probes in one session can never hold a session lease` + `keys a lease by the agent OBJECT` + `keeps two DIFFERENT agent objects independent` | 两个兄弟 lease 互不干扰（独立 leaseId、各自 release 只影响自己）；session 租约被拒且 details 精确 |
| 并发复用 session | `invalidates an existing session lease the moment a second occupant appears` | 第二占用者出现 ⇒ 旧 session lease 立即失效并计数 |
| 重复注册 | `refuses a downgrade sequence` / `re-registering the SAME key refreshes` / `A(domain)→A2(invariant)→dispose(A)` | size===1、粘滞 invariant、`downgradePrevented`/`stickyInvariantKept`/`registrationsReplaced` 计数 |
| 旧 handle 延迟 dispose | `A(domain)→A2(invariant)→dispose(A)` / `cannot resurrect or fabricate` / adapter 场景 | `staleDisposeNoop === 1`、A2 仍可 resolve、不复活 |
| TTL 过期 | `expires a branch lease on sweep` / `expires a session lease on sweep` / `invalidates a lease when its scope expires` | `sweepExpired` 计数一次、二次 sweep 为 0、`release()` 变 stale |
| adapter dispose | `releases the adapter-owned scopes and invalidates leases bound to them` / `disposing the adapter does not resurrect` | adapter dispose 后 `registry.size()===0`、host scopes 清空、绑定 lease `invalidated`、`staleDisposeNoop===0` |

另有计数闭合不变式测试（`keeps lease accounting closed across a mixed sequence`）：`acquired === released + expired + superseded + invalidated + live.branchLeases`、`sessionGranted === sessionReleased + sessionExpired + sessionInvalidated + live.sessionLeases`，以及 `stats()` 深冻结。

## 3. 逐文件改动

| 文件 | 改动 |
| --- | --- |
| `src/jitrl/scope-registry.ts` | ①租约：`acquireLease`（carrier→WeakMap / 无载体→key，attach-or-register，supersede，TTL，`renew`/`release`/`isActive`）、`leases()`、`makeLeaseHandle`；②session 租约：`acquireSessionLease`/`activeSessionLeases`/`sessionLeaseProof`/`SingleOccupancyProof`；③注册版本化 + sticky invariant + `staleDisposeNoop`；④`sweepExpired`；⑤`removeInternal`/evict/clear/dispose 与租约、版本联动；⑥`stats()` 新增 `leases.*`/`live.*`/注册完整性计数（`registrationsReplaced`/`stickyInvariantKept`/`invariantUpgrades`/`downgradePrevented`/`staleDisposeNoop`）。既有 API/语义零破坏（t7 全部测试原样通过） |
| `tests/unit/jitrl/scope-registry-lease.test.ts` | **新建** 19 测试（§2 映射的全部场景 + 计数闭合 + 冻结快照 + GC 结构/真回收证明） |
| `docs/adr/0006-host-identity-trust-and-mount-isolation.md` §6.3 | 补一行"收紧后的预期行为"（队长本轮明确要求；纯文档，无代码/门禁语义变化） |
| `docs/reports/p4-b-lease.md` | 本报告 |

设计取舍（记录在代码注释中）：**租约 TTL 只约束租约，不改变 scope 自身寿命**（`acquireLease` 注册新 scope 时不透传 `ttlMs`）；**attach-or-register**：已存在 live scope 时租约附加到它而不是重新注册——重新注册会递增 key 版本，把宿主 adapter 自己的 mount handle 变成 stale no-op，adapter 将永远无法释放它（这正是"租约不得偷走 key 所有权"）。

## 4. 验证证据（可复算）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `pnpm exec tsc --noEmit` | 0 | 无输出 |
| `pnpm exec vitest run tests/unit/jitrl/scope-registry-lease.test.ts` | 0 | `Test Files 1 passed (1)`，`Tests 19 passed (19)` |
| `pnpm exec vitest run tests/unit/jitrl` | 0 | `Test Files 32 passed (32)`，`Tests 771 passed (771)` |
| `pnpm exec vitest run tests/unit/jitrl tests/unit/cordis-seams tests/unit/seams tests/e2e/provenance-chain.test.ts tests/e2e/host-smoke` | 0 | `Test Files 43 passed (43)`，`Tests 921 passed (921)` |
| `$env:NODE_OPTIONS='--expose-gc'; pnpm exec vitest run tests/unit/jitrl/scope-registry-lease.test.ts -t 'holds no strong reference'` | 0 | `Tests 1 passed`（真 GC 分支：`WeakRef.deref() === undefined`；默认运行不含 `--expose-gc` 时不进入该分支，无 skipped 测试） |
| 同上，写成单命令（PowerShell / POSIX 两种形式，verifier 可原样复跑） | 0 | PowerShell：`$env:NODE_OPTIONS='--expose-gc'; pnpm exec vitest run tests/unit/jitrl/scope-registry-lease.test.ts`（整文件跑，19 tests，含真 GC 分支）；POSIX：`NODE_OPTIONS=--expose-gc pnpm exec vitest run tests/unit/jitrl/scope-registry-lease.test.ts`。**预期输出特征**：`Tests 19 passed (19)`，且**没有** `skipped`；若把 `--expose-gc` 去掉，同一用例仍然通过但只执行结构断言分支（真回收分支不进入），**这正是必须带 flag 的理由**。 |
| `pnpm exec vitest run`（全量，收尾独立运行） | 0 | `Test Files 128 passed (128)`，`Tests 2373 passed (2373)` |
| `pnpm run check:docs` | **1（已知红，与本任务代码无关；队长已裁定收尾统一重铸）** | 仅 README 计数漂移：README `103 files/2094 tests` vs 实测 `128 files/2373 tests`（unit 115/2214、e2e 13/159）；`Config reference coverage: 78 documented row(s) vs 78 expected` ✓；`✓ Report carries zero failed and zero pending tests` ✓。该漂移在 P2/P3/P4 各批新增测试后累计存在（本任务前为 127/2354），README 不在本任务写入范围 |
| 负控制 NC1/NC2/NC3（临时补丁 → vitest → 按字节恢复 + sha256 复核） | 1（预期红） | NC1 去掉 dispose 版本检查 → **5 failed**（全部延迟 dispose/顺序用例）；NC2 去掉 sticky invariant → **1 failed**（降级用例）；NC3 去掉单占用证明 → **2 failed**（零占用/兄弟探针用例）；每次恢复后 `restored: IDENTICAL`，恢复后 `tests/unit/jitrl` 32 files/771 tests 绿、tsc 0 |

## 5. 验收对照

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| 六类场景各有测试 | **通过** | §2 映射表；`tests/unit/jitrl/scope-registry-lease.test.ts` 19/19 绿 |
| WeakMap 租约 + TTL/清理/过期计数完整 | **通过** | `carrierLeases` 是 `WeakMap`；记录/handle 无强引用（结构断言 + `--expose-gc` 实测回收）；`sweepExpired`/惰性终止计数恰好一次；闭合不变式测试钉死 |
| invariant key 级不可变、重复注册不降级、旧 handle dispose 不删新登记 | **通过** | 时间顺序用例 + `downgradePrevented`/`stickyInvariantKept`/`staleDisposeNoop` 计数；NC1/NC2 证明测试能抓对应回归 |
| 仅可证明单占用才允许 sessionId 租约 | **通过** | 授予时 + 每次变更后 + 观察点三重重算 proof；兄弟探针/并发复用/释放占用者三类违反路径各有断言；`authorizesBranch` 类型级 false |
| tsc 0、vitest 相关目录全绿 | **通过** | §4 命令表 |

## 6. 遗留风险

1. **GC 分支的引擎依赖**：`WeakRef` 回收断言依赖 V8 在 `gc()` 后真正回收（已用 12 次循环 + macrotask yield 稳定化，实测通过）；在未开 `--expose-gc` 的默认运行里该分支不执行，此时只依赖结构断言。若未来 runner 环境变化，最坏情形是"真 GC 证明退化为结构证明"，不会出现假绿（分支不进入即不断言）。
2. **租约与 scope 生命周期的边界**：租约 TTL 短于 scope TTL 时，scope 会比租约活得久（一个没有 live lease 的登记仍在 registry 里直到自身 TTL）——这是既有登记语义，不是泄漏（LRU 上限 `maxScopes` + `prune` 封顶）；若 P4-C 需要更紧的"无租约即回收"语义，需要一次显式裁定。
3. **session lease 的占用者由"恰好一个 branch lease"定义**：若未来出现"无 lease 但确实单占用"的合法场景（例如纯宿主侧登记），当前会拒绝而非放宽——这是 fail-closed 方向的偏差，安全但可能需要 P4-C 提供占用者 lease 的宿主接线。
4. **并发**：本模块为同步单线程语义（与仓库其余部分一致）；跨 worker 的共享注册表不在本轮范围。

## 7. 与队长要求的对应（含 ADR §6.3 确认）

- **ADR 0006 §6.3 四要素确认**：债的存在（legacy-host-local 匹配与改动前一致）✓；触发条件（直接调用 `adapter.registerPromptSegment/registerGuardrails/mountMiddleware` 且未声明 `mountScope`）✓；收紧时必改的 5 个用例名单（5 个测试名逐条列出）✓；**收紧后的预期行为**——原缺，本轮按队长要求补上一行（默认成为 `branch` class、`legacyHostLocalMounts` 恒 0、`sessionOnlySuppressed`/`anonymousSuppressed` 只增不减、legacy 退化为显式可选值）。该补全是纯文档编辑（ADR 0006 系 t7 产物），无任何代码/门禁语义变化，特此披露。
- **WeakMap**：见 §1.1（真 WeakMap + 结构断言 + `--expose-gc` 实测）。
- **时间顺序用例**：见 §1.2（5 条带时序的用例，负控制 NC1 证明它们抓得住回归）。
- **证明 vs 假定**：见 §1.3（证明，且三重重算 + 违反路径各有断言）。
