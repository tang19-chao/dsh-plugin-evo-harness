# rev6 t9 — DSH 实际安装插件审计与同步方案

- 团队：rev6-hardening-and-dsh-live · 任务 t9（audit-install, attempt 1, `14a232b6-78af-4035-a9ed-b605f721846c`）
- 日期：2026-10-31（+08:00）· 执行者：token-runtime
- 纪律：全程只读；未安装/更新/重装/重启宿主、未写 `E:\DS\插件` 与任何宿主配置、未 commit/push。

---

## 1. 判定：STALE（安装 ≠ 最新；源码最新、构建最新、已加载非最新）

三个层面分别判定：

| 层面 | 判定 | 依据 |
| :-- | :-- | :-- |
| 源码最新（工作树） | ✅ 是 | HEAD `97e38db` + t1/t2/t3/t12/t13/t14 交付，八门禁全绿（t8） |
| 构建最新（lib 与 src 一致） | ✅ 是 | `lib/build-stamp.json`：srcTreeSha256 `50e792b1…`、106 src files、`check:build-smoke` stale:false |
| 已加载最新（宿主实际加载） | ❌ 否 | 加载入口 SHA-256 ≠ 最新构建 SHA-256；rev6 文件面在安装中完全缺失（§3） |

## 2. 运行时加载链（实测确认，非推测）

```
C:\Users\Administrator\.dsh\profiles\desktop\package.json        ← profile 清单
  "dsh-plugin-evo-harness": "link:E:/DS/插件/dsh-plugin-evo-harness"
  dsh.profile.bundles[9] = "dsh-plugin-evo-harness"
C:\Users\Administrator\.dsh\profiles\desktop\node_modules\dsh-plugin-evo-harness
  = SymbolicLink → E:\DS\插件\dsh-plugin-evo-harness            （真实目录，非 junction）
E:\DS\插件\dsh-plugin-evo-harness\lib\index.js                   ← 加载入口（package.json main）
```

- pnpm `link:` 语义 + `pnpm-lock.yaml` 只钉 **link 本身**（`version: link:E:/DS/插件/…`），不钉字节。
- 符号链接是**实时视图**（经 symlink 读取与直读 `E:\` 的 lib 字节逐位一致，已实测）。
- 无影子副本：app.asar 的 dsh checkout 无 node_modules；`.plugin-manager\logs` 全空（无安装操作记录可引用）。
- 宿主进程 2026-10-30 23:44 启动（早于 10-31 14:33 的最新 lib 构建）；Node ESM require 在装载时缓存字节 → **运行中的宿主不可能看到 10-31 构建的 lib，必须有重载或重启动作**。

## 3. 关键哈希与版本证据（实测 2026-10-31 14:35–14:50）

| 项 | 安装（实际加载） | 工作树（最新代码） |
| :-- | :-- | :-- |
| 绝对路径 | `E:\DS\插件\dsh-plugin-evo-harness` | `C:\Users\Administrator\Documents\Codex\2026-10-19\https-github-com-google-research-harness2` |
| package 版本 | 0.1.0 | 0.1.0（相同） |
| git HEAD | `7e73b3f8b9913f03d4ab99f2146c6219fc822ea9`（2026-10-21 21:13） | `97e38db37305b24f695a5f989428b3611f84987c`（2026-10-30 01:45） |
| `lib\index.js` SHA-256 | `6e94acb0cb54727a34d6cdb565aa2026ff1e30f6831ee11da0a553e189f3e43b`（449,048 B，mtime 2026-10-21 21:11:38） | `af7b1b732a544bc4f828f323e2becf66730868d77b81db53c30342ca1093e732`（1,215,633 B，mtime 2026-10-31 14:33:14，stamp 自洽） |
| `lib\index.js.map` SHA-256 | `a70baaee0dad866abe8f656ae2aaf6669c5318f377c0b2b37d1b30e6f1399423` | `1c2f9a1aea80bdf3408bc5b1f825e1e8e8089d44ced9b65784c5647ed0ccb561` |
| `lib\build-stamp.json` | **不存在** | `aa4112f54bf28397e712fe809e45dc5f3832c3ee3db8331dec9fe601c46e863f` |
| `cordis.patch.yml` SHA-256 | `6e825fc2991f4ef51cacf60e8959814a8a0078525f419ccfcaabc0f60fea97aa` | `04170e8d006bd18959643d4104867e24a66545d09261a115e6171fb5dacb02f5`（仅 EOL 差异：0 vs 65 个 CRLF 对；行内容 diff = 0） |
| tracked src | 46 文件（对自身 HEAD 干净） | 97 文件 |
| rev6 面 | **完全没有**：`real-benefit-controller/host-client/cache-observation/probe-safety`、`agent-loop-executor`、`metered-model-adapter`、`jitrl/writeback-gate`、`text-probe-evaluation` 等缺失；lib 内 grep `CANARY_TOTAL_TOKEN_CEILING` / `absoluteTotalCapWouldExceed` 均 0 命中 | 全部在树内且已验证 |

差距量化：`7e73b3f..97e38db` = **17 commits / 349 files / +156,425 行**。

## 4. 插件重载机制审计（只读；GUI 侧留待 ci-host-operator）

| 问题 | 结论 | 证据 |
| :-- | :-- | :-- |
| 宿主是按安装时快照还是加载时实时读 lib？ | **加载时实时读**（符号链接实时视图；lockfile 钉 link 不钉字节） | symlink 双向哈希一致（实测）；lockfile `version: link:E:/…` |
| 文件同步后是否必须重启宿主？ | **是（对已运行的宿主进程）**：Node ESM require 装载时缓存；宿主进程 2026-10-30 23:44 启动，早于最新 lib | 进程 StartTime 实测 |
| GUI 是否有禁用/启用/reload 入口？ | **unverifiable（本轮）**：GUI `http://127.0.0.1:53061` 未授权访问（HTTP 401），CLI 侧无法内省插件管理 UI | Invoke-WebRequest 实测 401 |
| 是否存在字节快照/安装缓存机制？ | 未发现：`.plugin-manager\logs` 全空、profile 内无 lib 副本 | 目录扫描实测 |
| 重装（dsh plugin add link:…）是否必需？ | 无证据表明必需（lockfile 已指向 E:\ 且符号链接实时）；但**同步后宿主需要某种重载**（GUI reload 若存在则可免重启；若不存在则需重启） | 综上 A–D |

**对 ci-host-operator 的含义**：同步 `E:\` 内容后，可用两条路径让宿主加载新代码——(a) 若 GUI 有插件 reload/禁用-启用开关（待 GUI 内确认），走 GUI；(b) 否则需要重启宿主（需用户/队长批准，本轮纪律禁止我方执行）。无论哪条，先完成 §5 的哈希验证再观察加载结果。

## 5. 最小可回退的文件同步清单（Option B：E:\ 原位内容同步；未执行）

**不**重定向符号链接（Option A 改 profile 配置 = 写宿主配置，被排除）。同步 = 把工作树的运行时面复制进 `E:\`（宿主经实时符号链接立即看到新字节；重载/重启后才真正装载）。

### 5.1 必须同步（宿主装载面，5 项）

| # | 文件 | 动作 | 来源（工作树）SHA-256 |
| :-- | :-- | :-- | :-- |
| 1 | `lib\index.js` | 覆盖 | `af7b1b732a544bc4f828f323e2becf66730868d77b81db53c30342ca1093e732` |
| 2 | `lib\index.js.map` | 覆盖 | `1c2f9a1aea80bdf3408bc5b1f825e1e8e8089d44ced9b65784c5647ed0ccb561` |
| 3 | `lib\build-stamp.json` | 新增 | `aa4112f54bf28397e712fe809e45dc5f3832c3ee3db8331dec9fe601c46e863f` |
| 4 | `cordis.patch.yml` | 覆盖 | `04170e8d006bd18959643d4104867e24a66545d09261a115e6171fb5dacb02f5` |
| 5 | `package.json` | 覆盖（可选但建议：保持与源一致；宿主消费字段 name/version/main/exports/dsh 实测语义相同） | `44db70bd7064d42ce35c64c6d3cf01de87d17ed6b3c9828a4d675ae917ad1941` |

依赖面无需同步：`@deepseek-ai/schemastery` 已**打包进 lib**（installed lib 内 26 处命中）；`E:\…\node_modules` 是 dev-only（vitest/esbuild/typescript）。

### 5.2 回退基线（同步前先快照这 4 个当前值）

| 文件 | 当前（安装）SHA-256 |
| :-- | :-- |
| `lib\index.js` | `6e94acb0cb54727a34d6cdb565aa2026ff1e30f6831ee11da0a553e189f3e43b` |
| `lib\index.js.map` | `a70baaee0dad866abe8f656ae2aaf6669c5318f377c0b2b37d1b30e6f1399423` |
| `cordis.patch.yml` | `6e825fc2991f4ef51cacf60e8959814a8a0078525f419ccfcaabc0f60fea97aa` |
| `package.json` | `d52f52c7c67494b991e8d7c1eefcbe4c44b1a4c5bfd8223ae41aff7041ef6506` |

回退 = 把快照字节写回原路径（+删除新增的 `lib\build-stamp.json`）。最小可回退：仅 4 覆盖 + 1 删除。

### 5.3 哈希验证方案（同步后、重载前后各跑一次）

1. **同步后立即**（重载前）：对 5 个目标文件重算 SHA-256，必须逐一等于 §5.1 的期望值；`lib\build-stamp.json` 内 `artifact.sha256` 必须等于 `lib\index.js` 实测哈希（stamp 自洽）；经 **symlink 路径**读取（`C:\Users\Administrator\.dsh\profiles\desktop\node_modules\dsh-plugin-evo-harness\lib\index.js`）与直读 `E:\` 必须逐位一致（实时视图复证）。
2. **重载/重启后**：宿主装载的模块字节 = 新 lib —— 可观察证据：宿主日志中插件加载行；若 GUI 有插件详情页，版本/入口信息应显示新值。
3. **行为面验证（shadow-only，t10）**：rev6 面存在性——宿主中该插件的 real-benefit 工具/命令面应从"不存在"变为"存在但 fail-closed"（`node scripts/host-smoke/real-benefit.mjs --json` 在宿主环境无凭据时输出 `not-run`、`realCallsMade:0`）。
4. **不可行项**：`check:build-smoke` 在 `E:\` 不能直接跑（其 git HEAD 是旧 clone）——验证以哈希 + stamp 自洽 + 宿主行为面为准，不在 E:\ 重跑门禁。

### 5.4 风险与边界

- 同步会改变 `E:\` 目录内容（该目录同时是一个独立 git clone，HEAD `7e73b3f`、工作树干净）——同步后其工作树将显示为脏（约 4 处修改 + 1 新增）。回退基线可完整恢复；但 `E:\` 的 git 状态变化是**预期副作用**，须在操作记录中声明。
- `package.json` 的 scripts 段在两树间差异较大（新命令），但宿主消费字段语义相同；若操作者希望最小化 E:\ 变化，可跳过第 5 项（package.json），不影响装载，代价是 stamp/门禁工具链在 E:\ 不完整。
- 本轮未写任何文件到 `E:\` 与宿主配置；执行权在 ci-host-operator（等待队长指挥）。

## 6. 有界结论

- 安装路径、加载入口、版本、哈希均已实测并给出（§2–§3）。
- 判定 **STALE** 的证据充分：加载入口哈希 ≠ 最新构建哈希 + rev6 面零命中 + 宿主进程早于最新构建。
- "源码最新/构建最新/已加载最新"三层分别判定（§1），无 unverifiable 项；GUI reload 入口存在性单独标注 unverifiable（401），交由 ci-host-operator 在 GUI 内确认。
- 同步方案与哈希验证方案已就绪（§5），未执行；等待队长指挥 ci-host-operator。
