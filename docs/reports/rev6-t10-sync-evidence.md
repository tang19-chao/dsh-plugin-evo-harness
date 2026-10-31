# rev6 t10 — 本机同步执行证据（已同步，等待用户手动重启）

- 团队：rev6-hardening-and-dsh-live · 任务 t10（live-shadow, attempt `90f90187-0233-421a-9efb-ae6ccc17aedd`）
- 日期：2026-10-31 15:47–15:58（+08:00）· 执行者：ci-host-operator
- 授权：用户已在授权问题中选择"授权本机同步和必要重载"；队长指令按路径 A：先同步，不重启，完成后暂停等待用户手动重启。
- 纪律：只写了 `E:\DS\插件\dsh-plugin-evo-harness` 内的 5 个目标文件 + 1 个备份目录；未复制 node_modules；未改 profile；未 commit/publish；未启动替代服务；未真实记忆写入；未重启/kill 任何进程。

---

## 1. 执行摘要

| 步骤 | 结果 |
| :-- | :-- |
| 1. 4 个被覆盖文件基线核对 | 全部 MATCHES t9 baseline（`6e94acb0…` / `a70baaee…` / `6e825fc2…` / `d52f52c7…`） |
| 2. 带时间戳备份 | `E:\DS\插件\dsh-plugin-evo-harness\_rev6-backup-20261031-154816\`（4 文件复制后逐一哈希核对一致 + backup-manifest.json） |
| 3. 同步 5 文件（先确认解析后的绝对路径再写） | 全部写入并逐文件哈希核对 = t15 清单期望值 |
| 4. stamp 自洽 | `stamp.artifact.sha256 == lib\index.js 实测哈希 == af7b1b73…` ✅（srcTreeSha256 `50e792b1…`，106 src files） |
| 5. symlink 实时视图 | 经 profile 符号链接读取与 E:\ 直读**逐字节一致**（1,215,633B，双向哈希一致；build-stamp 同样一致） |
| 6. ESM 装载烟测 | 经 symlink 真实 `import()` 成功：73 named exports，PLUGIN_NAME 正确，apply/createEvoHarnessPlugin 均为 function，新面 `createAgentLoopExecutor` 已在导出面 |
| 7. E:\ git 状态 | `M cordis.patch.yml`、`M package.json`、`?? _rev6-backup-…`（lib/ 被 .gitignore:13 忽略——预期内、已声明的副作用） |

## 2. 关键澄清：real-benefit 面不在 lib 内是设计使然

同步后初步 grep 曾报 `CANARY_TOTAL_TOKEN_CEILING / absoluteTotalCapWouldExceed = 0` 命中，经追溯确认：

- `real-benefit-controller.ts` / `real-benefit-host-client.ts` 的唯一消费方是**操作者 runner 脚本**（`scripts/host-smoke/real-benefit.mjs` / `budget-binding.mjs`），它们在运行时用自己的 esbuild 打包（见 t7 审计的 `loadModules()` 内容寻址缓存）；
- 宿主插件入口 `src/index.ts` 不导出该模块 → esbuild 按入口图 tree-shake，real-benefit **本来就不进 lib/index.js**（旧安装 lib 同样 0 命中，行为一致）；
- 因此"rev6 面不在 lib 内"≠ 同步失败。宿主装载面的 rev6 变化以以下标记证明（OLD vs NEW lib）：`consumer:` 0→12（P3-4 settlement consumer 标签）、`createAgentLoopExecutor` 0→3、`probe-safety` 0→2、`agentLoop`/`agent_loop` 0→3、`ledgerSettlement` 0→6；体积 449,020 → 1,215,468 chars。
- t9 报告中"lib 内 grep CANARY_TOTAL_TOKEN_CEILING=0 ⇒ rev6 面缺失"的推断链需要修正：该标记只存在于 runner 打包面，不构成宿主装载面的判定依据。宿主面的正确判定是导出面+行为面（§3）。

## 3. "可重启"证据清单

1. 磁盘面：E:\ 5 文件 = 工作树字节（哈希逐一比对）；stamp 自洽。
2. 视图面：profile 符号链接实时视图与 E:\ 直读逐位一致——宿主进程下次打开模块文件时读到的就是新字节。
3. 完整性面：经 symlink 真实 ESM import 成功，公开面 73 exports 完整（含 rev5/rev6 的 createAgentLoopExecutor / validateEvoHarnessConfig），PLUGIN_NAME 正确——重启后装载不会因字节问题失败。
4. 回退面：备份目录含 4 个旧文件原字节（哈希核对）+ manifest；回退操作 = 复制回 4 文件 + 删除 `lib\build-stamp.json` + 重启。
5. 未加载声明：运行中的宿主（PID 25200，10-30 23:44 起）仍持有旧模块缓存；**在用户手动重启前，宿主加载的仍是 10-21 旧代码**。本任务在此暂停，不重启、不宣称已加载最新。

## 4. 重启后（t10 后半段）待办

用户手动重启 DSH 后，由队员在新会话中继续：
1. 新宿主进程确认（新 PID + 启动时间）；
2. 行为面 shadow-only 验证：插件装载诊断（triggerMode、execution profile mode、patch/publish/memory=denied、shadow records）、`/evo` 命令面存在、memory writable=false、无真实记忆写入证据；
3. runner 面 fail-closed 验证（real-benefit.mjs 无凭据 → not-run / realCallsMade:0）；
4. 宿主日志观察（无报错装载行）。

## 5. 回退说明（保留）

```text
回退 = 把 E:\DS\插件\dsh-plugin-evo-harness\_rev6-backup-20261031-154816\ 下
       lib\index.js、lib\index.js.map、cordis.patch.yml、package.json
       复制回各自原路径（覆盖），删除 lib\build-stamp.json，然后重启 DSH。
备份目录内 backup-manifest.json 记录了新旧两侧全部 SHA-256。
```

---

## 6. Attempt 2 — 重启后实机验证（2026-10-31 15:56–16:05）

用户手动重启 DSH 并授权继续。本轮全部为只读观察 + 操作者 runner 探针；零 profile 写入、零进程操作、零真实记忆写入、零模型调用。

### 6.1 重启确认（进程实测）

| 项 | 旧（attempt 1） | 新（attempt 2） |
| :-- | :-- | :-- |
| Electron MAIN | PID 19272（10-30 23:44:19） | **PID 3304（10-31 15:55:19）** |
| HOST 子进程 | PID 25200（10-30 23:44:20） | **PID 18344（10-31 15:55:19，父=3304）** |
| 命令行 | 同一入口 | 同一入口：app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js + runtimeDir + C:\Users\Administrator\.dsh\profiles\desktop |
| 旧进程 | — | PID 19272/25200 均已退出（干净重启） |
| GUI | 127.0.0.1:53061（旧） | **127.0.0.1:62066**（本会话 DSH_WEB_URL） |

### 6.2 同步状态复查（重启后）

- 安装 lib sha256 `af7b1b73…`（1,215,633B）与 symlink 视图一致；stamp 自洽（`50e792b1…`，106 src files）；package `dsh-plugin-evo-harness@0.1.0 main=lib/index.js`。与 attempt-1 同步后状态逐位一致，重启未回滚任何文件。

### 6.3 宿主装载证据链（诚实分层）

1. **间接（强）**：宿主 15:55:19 启动并成功服务本会话；启动时按 profile bundles（第 10 项 `dsh-plugin-evo-harness`）经符号链接装载 `lib/index.js`——此时磁盘字节已是新 lib（6.2）。若装载失败，宿主 boot 会 fatal（DesktopFatalRecovery 路径），未发生。
2. **直接（受限）**：宿主进程内 ESM 模块缓存无法从外部内省；GUI/API 需认证（127.0.0.1:62066 无凭据 HTTP 401，body "dsh web authentication required; reopen the URL printed by dsh web."——token 只在桌面 renderer 内存中，CLI 侧不可达，诚实标注为 unverifiable）。
3. **装载面等价验证**：对同步后 lib 经 symlink 以包工厂 `createEvoHarnessPlugin({})` + 惰性上下文做了真实 ESM 装载（同一字节、同一入口）——**默认挂载诊断**完整输出：`execution profile: mode=shadow, patch=denied, publish=denied, memory=denied (shadow records on)`；`memory status writable=no, mode=recall-only`；`triggerMode=auto_fallback: subscribed to session/event, agent/error, agent/status`。该输出证明字节行为正确，但注明：这是包工厂在惰性上下文中的行为，不冒充宿主进程内调用。

### 6.4 shadow / applyWinningPatch=false / 权限拒绝（三层证据）

- **代码层**（t8 已审）：`applyWinningPatch: options.applyWinningPatch ?? config.execution.applyWinningPatch`，默认 false；仅 guarded-active 可解禁。
- **配置层**：profile `cordis.patch.yml` 与 `package.json` 中 grep 无任何 evo/applyWinningPatch/execution 段（本任务只读复核）→ 宿主以**纯默认**装载插件 → shadow + patch=false 生效。
- **行为层**（工厂诊断，见 6.3）：`mode=shadow, patch=denied, publish=denied, memory=denied`；`memory writable=no (recall-only)`；8 个 surfaces 全部 enabled+mountable。

### 6.5 无真实记忆写入（活体阴性对照）

- memory-hook 审计（活文件，重启后持续写入）：`written.assistant=0, written.tool=0`；
- 插件相关记忆目录（.dsh-memory data/run/sleep、gate-weights、engram-relay、graded-state）重启后 **0 文件写入**；
- `jitrl-experience.jsonl` 全 .dsh 树不存在 → 插件零 experience 落盘（与 shadow + 无 run 触发一致）。

### 6.6 runner fail-closed（操作者脚本证据，按队长许可执行，不冒充宿主调用）

无凭据环境直跑 `node scripts/host-smoke/real-benefit.mjs --json`（node 子进程，非宿主插件调用）：`verdict=not-run, runnable=false, realCallsMade=0, trigger=binding-incomplete(+24 个 missing-required-key 行)`——与 t5/t7 实测一致，fail-closed 保持。

### 6.7 边界与未决项

- GUI 内命令面板 `/evo` 可见性与宿主 loader "apply plugin" 日志行：**unverifiable（CLI 侧 401）**，需用户在 GUI 中查看（命令面板应有 "evo" 条目；设置页插件列表应显示 dsh-plugin-evo-harness）。
- 宿主进程内插件 handle（evoHarness service）状态：进程外不可内省，诚实标注。
- 未做任何 guarded-active / 发布 / 真实记忆写入 / 模型调用；未改 profile；未再次重启。
