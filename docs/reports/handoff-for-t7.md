# T4 / T5 / T3 → T7 交接：集成接线地图

来源：t4（P5-a）、t5（P5-b）、t3（P4 漂移）均已完成。captain 已逐个独立复核。
当前门禁基线：`pnpm run typecheck` exit 0；`pnpm run test` = 57 文件 / 1058 用例全绿（起点为 54/964）。

本文件只记录**接线所需**的接口事实。实现细节以源码为准。

---

## 1. T4 — L3 宿主顾问（`src/jitrl/host-advisor.ts`）

```ts
createHostAdvisor({ config, store?, retriever?, estimator?, now?, rng? })
  → { evaluate(request): Promise<HostAdvisorDecision>, diagnostics(): readonly string[] }
```

- `store` 只需 `{ query(q: ExperienceQuery): Promise<readonly ScoredExperience[]> }`，可直接传经验 store。
- `retriever` 为 `(state, query) => neighbors | Promise<neighbors>`；**存在时优先于 store**。
- `config` 传 `JitRlConfig`（读取 `hostAdvisor.*`、`k`、`similarityThreshold`、`exploration`、`unseenFallback`）。

### 默认关闭
`config.jitrl.hostAdvisor.enabled === false` → 任何请求返回 `noop('host_advisor_disabled')`，零检索零估计。
**适配器侧不需要再写开关判断**，可安全常驻挂载。

### advisory（接 `agent/pre-step`）
- `request.mode = 'advisory'` → `{ kind: 'advisory', text, antiPatterns, diagnostics }`
- `text` 是 `<jitrl_advice>` 块，≤300 token（`estimateTokens` 确定性估算）
- 负优势只出现在 `<anti_patterns_to_avoid>`
- **适配器职责**：把 `text` 放进 `additionalContexts`；绝不改写为工具选择，绝不据此改动 messages

### gate（接 `tools/pre-execute`）
- `request.mode = 'gate'`
- 判定对象：`recentTools` 最新一条的 `actionKey ?? toolName`；该 key 无证据则回退最差动作
- `Ã < gateThreshold` 且 `|N(s,a)| ≥ minSupport` → `{ kind: 'ask', suggestedActionKey, reason }`；否则 `noop`
- **union 只有 `advisory | ask | noop`，没有 `deny`**。适配器必须原样转发 `ask`，不得升级为 deny

### 请求状态
- `request.state` 应为 `level === 'host_tool'` 的 `AbstractState`；不传则由 `recentTools + errors + workingDirectory.path` 自行派生
- `request.policyId` / `request.driftRho` 透传进 `ExperienceQuery` 并做漂移降权
- `request.now` 或注入的 `now()` 存在时用作 `before` 因果截断

### 失败安全
永不抛：store/retriever 抛错、返回非数组、estimator 抛错、请求不可用 → `noop` + diagnostics。

---

## 2. T5 — 记忆桥镜像（`src/jitrl/stores/bridge.store.ts`）

```ts
createJitBridgeMirrorStore({
  mirrorToMemoryBridge: config.jitrl.store.mirrorToMemoryBridge,
  namespacePrefix: config.memoryBridge.namespacePrefix,
  client: /* JitMirrorMcpClient */
})
```

导出：`createJitBridgeMirrorStore`、`JITRL_STAT_TAG = 'jitrl-stat'`、`JITRL_STAT_KIND = 'jitrl-stat'`、`BridgeMirrorStore`（含 `.diagnostics()`）。

- `mirrorToMemoryBridge === false` → **严格空操作，零客户端触达**（连 `listTools` 都不调）
- 空聚合 → 零调用早返回
- 每次调用恰 1 次 `listTools` 发现写工具（`write_note → … → write`，大小写不敏感），并从 `inputSchema.properties` 解析字段名
- 载荷只有聚合六字段（`n`/`meanReturn`/`variance`/`bucket`/`actionKey`/`level`）+ 结构字段（`kind`/`namespace`/`updatedAt`）
- 所有自由文本（含笔记路径 slug 与 hash 输入）先 `redactSecrets` 再 `redactAbsolutePaths`
- 失败隔离：单条失败只记 payload-free 诊断并继续；`listTools` 失败/无写工具/未注入客户端 → degraded 零写入
- 与本地 ExperienceStore 解耦（只消费聚合行，不读 JSONL）

**注意**：灵枢 `stg` 时间线映射属 driver 层，**本轮未实现**，报告中须标注。

---

## 3. T3 — 漂移降权（`src/jitrl/retriever.ts`）

已导出的纯函数，集成侧可直接用：

```ts
RetrieveOptions += { policyId?: string; driftRho?: number }
export interface DriftContext { policyId: string; driftRho: number; currentBucketCount: number; k: number }
export function driftFactorFor(recordPolicyId: string, context: DriftContext): number
export function resolveDriftContext(bucketRecords: readonly ExperienceRecord[], options: RetrieveOptions): DriftContext | null
```

语义（§7.3-4）：当前 policy 记录 → 1；同 `(level, bucket)` 下当前 policy 记录数 ≥ k → 1；否则 `driftRho`（默认 0.7）。
`retrievalWeight` 以 `base * driftFactor` **相乘**，与半衰期叠加不覆盖。`factor === 1` 时不写 `driftWeight`，保证向后兼容。

### 关键：不要做成双重降权
漂移**只由检索快照端应用**。`experience-store.ts` 查询仍返回原始权重，由调用方（`host-advisor.applyDrift`）在客户端按需降权。
T3 成员曾把漂移也落到 `experience-store.ts`，随后因会导致 `host-advisor` 再次降权（其 `:339` 以 `driftWeight` 存在为跳过条件）而**全部回退**。
**若 T7 认为 store 侧也需要应用漂移，必须先报 captain 取得明确写域授权，且必须同时改两个 stores 的 `toScored` 转发，否则就是双重降权。**

---

## 4. T7 必须证明的四件事

1. **生产可达**：从 `createEvoHarnessPlugin` 真实入口能拿到顾问与镜像存储；`enabled=true` 时 gate 真的会返回 `ask`。
2. **默认静默**：`hostAdvisor.enabled=false`、`mirrorToMemoryBridge=false` 时行为与改动前逐字段一致（既有 1058 用例不受影响）。
3. **作用域正确**：`branchId`/`sessionId` 过滤生效；`dispose()` 之后顾问不再注入任何文本或 ask，镜像不再写入。
4. **变异自检**：至少对一个关键接线点做「删掉该行转发 → 测试必须变红」实验，并写明是哪两个用例变红。
