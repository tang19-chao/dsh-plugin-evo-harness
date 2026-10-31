# rev6 t15 — DSH 本机同步与安全重载方案研究

- 团队：rev6-hardening-and-dsh-live · 任务 t15（attempt 1, `cd698932-8b2c-4e20-94c0-df101a5ab1f9`）
- 日期：2026-10-31（+08:00）· 执行者：ci-host-operator
- 纪律：全程只读（app.asar 仅读头与指定条目字节；临时解包在 %TEMP% 且已清理）；未修改 `E:\DS\插件`、profile 配置、宿主进程；未启动替代 Web 服务；未 commit/publish。
- 基线：承接 t9 的 STALE 判定（安装加载 `E:\DS\插件\dsh-plugin-evo-harness\lib\index.js` sha256 `6e94acb0…`，工作树最新构建 `af7b1b73…`）。

---

## 1. 结论（供队长决定、t10 执行）

**同进程内不存在任何插件重载路径。GUI 禁用→启用、patch 热更新、任何 IPC 控制消息都不能让运行中的宿主重读插件字节。要让宿主装载新 lib，唯一途径是让宿主进程重新启动（Electron `app.relaunch()` 级别的整 app 重启）。**

因此 t10 的推荐序列是：**同步 5 文件 → 三段哈希验证 → 重启宿主（唯一重载动作）→ 重启后验证**。同步本身（复制文件到 `E:\`）不需要重启——符号链接是实时视图，重启发生在"装载"这一步。

## 2. 宿主进程与重载机制（实测证据）

### 2.1 进程结构（实测 2026-10-31 14:52–15:00）

```
DeepSeek Harness.exe  PID 19272（Electron 主进程，10-30 23:44:19 启动）
├─ PID 25200  --expose-internals
│    <install>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js
│    <install>\resources\app.asar\dsh          ← runtimeDir（宿主运行时根）
│    C:\Users\Administrator\.dsh\profiles\desktop   ← projectDir（profile）
│    <install>\resources\runtime\primary-runtime   ← primaryRuntime
│    ...\primary-runtime\dependencies\pnpm\bin\pnpm.mjs + ...\runtime\bin
├─ PID 20632  renderer；PID 27168 gpu；PID 25720/23504/22464 utility
└─ PID 6708  第二个 Electron 主进程（10-31 14:52:45 启动，较新——注意）
```

关键实测：**宿主（host）是 PID 25200，一个 Electron Node 模式子进程**，入口在 `app.asar` 内部的 `dsh-desktop-host/lib/index.js`（已从 asar 只读提取核对：`runProfile({profile:'desktop', patchFiles: [], ...})` → cordis loader 按 profile `package.json` 的 `dsh.profile.bundles` 逐层装载，插件经 `node_modules\dsh-plugin-evo-harness` 符号链接 → `E:\DS\插件\...\lib\index.js`）。

注意点：存在**第二个 Electron 主进程** PID 6708（14:52:45 启动）。命令行确认 PID 25200/22676 属于旧主进程 19272 的树（会话内的本次 GUI 会话）；6708 的归属需在 t10 前由任务管理器确认，避免"重启了另一个实例"。

### 2.2 为什么同进程重载不存在（源码级证据，全部来自只读解包）

| 途径 | 结论 | 证据 |
| :-- | :-- | :-- |
| GUI 内插件禁用/启用 | **不重读字节**。cordis loader 的 `Entry.update()` 只合并 options/rebuild fiber；模块导入走 `internal.import`（Node 内部 ESM loader 直通）或裸 `import()`，**均无缓存击穿**（无 `?t=`/query/snapshot 参数）。同 URL 的 ESM import 在同进程内永远命中模块缓存 | `cordis-plugin-loader/lib/index.js` :214-228（`import()` 无 cache-bust）；`Entry._init()` :453 同一 `tree.import`；main.js `Entry` 类 :3138 注释"HMR updates it after a successful reload"是残留文案，主进程无任何 HMR watcher（grep `watch(`/`FSWatcher`/`module.hot` 均无热重载实现） |
| IPC 控制消息 | **只有三种**：`shutdown`、`quit-inspection`、`update-tasks(inspect/lock/unlock)`。没有 reload/restart 消息类型 | `dsh-desktop-host/lib/index.js` :268-324（message handler 全量枚举）；main.js :3858-3876（control 调用点仅 updateTasks/inspectQuit） |
| 应用菜单 | **"Reload Page / Restart App and Host" 仅 development 构建**（`development = !app.isPackaged`，本机 app.isPackaged=true） | main.js :12767-12777（`...development ? [...]` 分支）、:11892 |
| 托盘菜单 | 仅 打开/退出，无重启项 | main.js :11692-11734 |
| 更新器 | `quitAndInstall` 走完整 `beforeRestart`（任务检查→admission lock→shutdown），仅用于 app 自身更新，与插件无关；本任务明确不触碰自动更新 | main.js :7780-7940 |
| patch（cordis.patch.yml）热重载 | 不存在：patch 在启动时读一次（`patchFiles: []` 传给 runProfile 表示桌面 profile 不用 profile patch 文件），无文件 watcher | host-index.js :233；main.js 全文无 patch watcher |

### 2.3 宿主重启的两条已证实路径

1. **正常退出 + 重新启动 app**（推荐）：
   - GUI：托盘/菜单 → 退出（会先弹 `quit-inspection` 检查活动任务与定时提醒——若有运行中任务会请求确认）→ 重新双击启动。这就是"卸载旧模块缓存 + 全新装载 profile bundles"。
   - 退出顺序由宿主自身完成（`shutdown` → `shutdown-complete` → disconnect），无需外部 kill。
2. **崩溃恢复对话框**（备用，非计划路径）：宿主 fatal 后的原生对话框第三项"禁用第三方插件、备份 profile patch 并重启"（`DesktopFatalRecovery` → `disableAllPlugins()` = 把 `cordis.patch.yml` 重命名为 `.bak-<ts>` + 把 bundles 重置为 web 模板）。**只应作为意外事故时的已知恢复面**，不是我们的方案（它会把我们的插件从 bundles 里去掉——恰好是反向操作）。

## 3. 同步方案确认（在 t9 §5 基础上的复核与细化）

### 3.1 需要同步的文件（宿主装载面，维持 t9 的 5 项清单）

| # | 文件 | 动作 | 来源 SHA-256（工作树，t9 记录） |
| :-- | :-- | :-- | :-- |
| 1 | `lib\index.js` | 覆盖 | `af7b1b732a544bc4f828f323e2becf66730868d77b81db53c30342ca1093e732` |
| 2 | `lib\index.js.map` | 覆盖 | `1c2f9a1aea80bdf3408bc5b1f825e1e8e8089d44ced9b65784c5647ed0ccb561` |
| 3 | `lib\build-stamp.json` | 新增 | `aa4112f54bf28397e712fe809e45dc5f3832c3ee3db8331dec9fe601c46e863f` |
| 4 | `cordis.patch.yml` | 覆盖 | `04170e8d006bd18959643d4104867e24a66545d09261a115e6171fb5dacb02f5`（仅 EOL 差异） |
| 5 | `package.json` | 覆盖（可选，建议同步） | `44db70bd7064d42ce35c64c6d3cf01de87d17ed6b3c9828a4d675ae917ad1941` |

补充确认（本次新增证据）：
- **宿主消费 `package.json` 的哪些字段**：cordis loader 经 `internal.import(name)`（Node ESM 解析）定位包 → 读 `package.json` 的 `exports`/`main`。工作树与安装的 `exports` 语义一致（t9 已核），覆盖安全。
- **`@deepseek-ai/schemastery` 打包进 lib**（t9 实测 26 处命中）→ `E:\…\node_modules` 是 dev-only，无需同步依赖。
- **profile 侧 `node_modules\dsh-plugin-evo-harness` 是符号链接**（LinkType=SymbolicLink，Target=`E:\DS\插件\dsh-plugin-evo-harness`，本次复测确认）→ 同步 `E:\` 内容后宿主**磁盘视图立即变化**；装载发生在下一次宿主启动。
- **src/ 无需同步**：宿主只装载 lib（`main: lib/index.js`）；src 仅门禁/类型检查消费。

### 3.2 备份与回退（维持 t9 §5.2，本轮补充操作细节）

1. 同步前在 `E:\DS\插件\dsh-plugin-evo-harness\` 下创建一次性备份目录（如 `_rev6-backup-<ts>\`），复制 4 个被覆盖文件的当前字节（哈希基线 t9 §5.2 已记录：`lib\index.js` `6e94acb0…`、`lib\index.js.map` `a70baaee…`、`cordis.patch.yml` `6e825fc2…`、`package.json` `d52f52c7…`）。
2. 回退 = 把备份字节写回原路径 + 删除新增的 `lib\build-stamp.json`（最小回退：4 恢复 + 1 删除），再重启宿主即回到 10-21 版本。
3. 备份目录放在 `E:\` 内部即可被 git 视为 untracked（`E:\` 是独立 clone，工作树干净）——t9 已声明同步后 `E:\` git 状态变脏是预期副作用；备份目录同理，操作记录中注明即可。

### 3.3 哈希验证方案（三段，维持 t9 §5.3 并落到可执行命令）

```powershell
# 段1（同步后、重启前）：逐一比对 5 文件 SHA-256 == 3.1 期望值；stamp 自洽：
#   (Get-Content E:\...\lib\build-stamp.json | ConvertFrom-Json).artifact.sha256 -eq (实测 lib\index.js sha)
# 段2（实时视图复证）：经符号链接读与直读 E:\ 逐位一致
#   C:\Users\Administrator\.dsh\profiles\desktop\node_modules\dsh-plugin-evo-harness\lib\index.js
# 段3（重启后）：宿主行为面 = rev6 面存在且 fail-closed（t10 执行）：
#   scripts/host-smoke/real-benefit.mjs --json（宿主环境无凭据 → verdict not-run、realCallsMade:0）
#   注意：E:\ 侧不能跑 check:build-smoke（其 git HEAD 是旧 clone）；验证以哈希+stamp+行为面为准
```

## 4. 风险与边界（供队长权衡）

1. **重启中断当前会话**：本会话（含 AgentTeams）跑在被重启的宿主里。`quit-inspection` 会报告活动任务；重启意味着本轮 t15 汇报必须先落盘、消息先送达，再执行重启——**重启动作建议由用户或队长在 t15/t10 汇报送达后触发**，而不是 t10 里进程自杀式重启。
2. **双 Electron 主进程**：PID 19272（宿主所在树）与 PID 6708（14:52 新起）。重启前应确认 6708 的角色（可能是第二个窗口/新会话实例），避免误判"重启完成"。
3. **`E:\` 是独立 git clone**：同步后其工作树变脏（4 修改 + 1 新增 + 备份目录）。这不是代码库损坏，回退基线可完整恢复；但**不要**在 `E:\` 里执行 `git checkout/restore` 来"清理"——那会把同步内容抹掉。
4. **禁用第三方插件的恢复路径是反冲**：若宿主意外 fatal 且操作者点了恢复对话框第三项，插件会被禁用（bundles 重置 + patch 备份）。恢复方法：把 `.bak-<ts>` 改回 `cordis.patch.yml` 并确认 profile `package.json` 的 `dsh.profile.bundles` 仍含 `dsh-plugin-evo-harness`（sanitize 只改 bundles 列表，不删 node_modules 符号链接），然后重启。
5. **绝不触碰的边界**：不修改 profile 配置（Option A 改 link 指向被排除）、不用 app 更新器、不 kill 宿主进程、不动 PID 树里的其他进程。

## 5. 有界结论

- "同进程无插件重载"为源码级+结构级双重证据的强结论（§2.2 表格 6 行全阴性）。
- t10 的执行序列（§1）与 t9 §5 完全兼容；本轮仅新增：宿主=PID 25200、IPC 控制面枚举、菜单/托盘/更新器三个入口的排除证据、恢复对话框的反冲警告、双主进程注意点。
- 全程零写入 `E:\`、零写入 profile、零进程操作；临时解包文件已清理。
