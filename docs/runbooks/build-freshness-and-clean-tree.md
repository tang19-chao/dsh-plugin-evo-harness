# Runbook：构建新鲜度、干净树与证明自指边界（rev5 P0-4/P0-5）

- **适用任务**：t9 / t14 / t19 / t23（以及任何改动 `src/**`、`tests/**`、`scripts/**`、`package.json` 的实现）
- **冻结基线**：`HEAD = 97e38db37305b24f695a5f989428b3611f84987c`（本轮不 commit，G12）
- **实测时刻**：2026-10-30T04:29–04:45（+08:00）
- **一句话**：`lib/index.js` 只有配上 `lib/build-stamp.json` 才能证明「它来自当前 `src/`」；CI 在测试前必须证明「工作树 = 提交字节」。两者都不在 `pnpm run verify` 里，理由见 §3。

---

## 1. 构建新鲜度（P0-5）

### 1.1 构建产物

`pnpm run build`（= `node scripts/build.mjs`）产生两件东西：

| 文件 | 内容 | 用途 |
| --- | --- | --- |
| `lib/index.js` | ESM bundle（esbuild 参数与旧 package.json 逐字一致：bundle / format=esm / node20 / sourcemap external / log-level warning） | `package.json` 的 `main`/`exports` |
| `lib/build-stamp.json` | `srcTreeSha256`、`srcFileCount`、逐文件 `{path,bytes,sha256}`、`artifact {path,bytes,sha256}`、`commit`（`git rev-parse HEAD`，不可得时为 `null` + `commitError`）、`builtAt`、node/platform/arch、冻结的算法说明 | 新鲜度证据（机读） |

### 1.2 冻结的 `srcTreeSha256` 定义（不要改）

```text
srcTreeSha256 = SHA256( concat over files of
                  "<posix-path>" + "\0" + SHA256(raw bytes) + "\n" )
```

- 文件集：`src/**/*.ts`（递归；不含 `.js`、不含 `node_modules`）；
- 路径：相对仓库根的 POSIX 路径（`src/a/b.ts`），按 **ordinal**（UTF-16 code unit）排序；
- 字节：读盘原始字节。仓库内容策略是 LF（`check:encoding` 对**提交的 blob** 强制），但 Windows 的 `core.autocrlf=true` 可能让工作树呈现 CRLF；此时摘要描述的是**这次构建实际消费的字节**，这是诚实的新鲜度问题，不是跨机产物指纹（跨机指纹由 attestation 对 **object database blob** 计算，见 §4）；
- `commit` 只是**来源**（provenance），不是判据：HEAD 前移但 `src` 未改 → `stale: false`，只报 `commit.matches: false`；
- 判据是**内容**，永远不是 mtime。

### 1.3 状态与 stale 原因（fail-closed）

```powershell
pnpm run build:status                # = node scripts/build-manifest.mjs --status
node scripts/eval/smoke-build.mjs --status
pnpm run check:build-smoke           # 构建 + ESM 冒烟 + 新鲜度
```

`--status` 只回答新鲜度（不构建、不 import）；**stale 时 exit 1**。`check:build-smoke` 的正常路径也会打印 `[build-smoke] stale: false`。

| 原因码 | 含义 | 处置 |
| --- | --- | --- |
| `artifact-missing` | `lib/index.js` 不存在 | `pnpm run build` |
| `stamp-missing` | `lib/build-stamp.json` 不存在 | `pnpm run build` |
| `stamp-invalid` | stamp 不是 JSON / 形状不对 | `pnpm run build` |
| `src-tree-mismatch` | 记录的 `srcTreeSha256` ≠ 当前值（改/增/删/改名） | `pnpm run build` |
| `artifact-mismatch` | 产物的 sha256/bytes 与 stamp 不一致 | 重新构建，**不要**手改 stamp |

`lib/index.js` 缺失时状态必须同时给出 `stale: true` 与 `artifact: absent`，不得当 0 或 unknown 混过去（由 `tests/unit/p62/build-freshness.test.ts` 钉住）。

### 1.4 负控制（可复跑，不写仓库）

```powershell
# 1) stale: src 改动后不重建
Add-Content src/dsh-bridge/model-config.ts '// probe'
node scripts/eval/smoke-build.mjs --status    # exit 1, stale: true [src-tree-mismatch]
# 2) 重建后消失
pnpm run build
node scripts/eval/smoke-build.mjs --status    # exit 0, stale: false
# 3) mtime 不参与判据（内容不变 → 仍 fresh）
(Get-Item src/config.ts).LastWriteTime = Get-Date
pnpm run build:status                          # exit 0
```

### 1.5 `prepare` 的事实（实测，不伪造）

- `package.json` 有 `"prepare": "pnpm run build"`；`pnpm run prepare` → **exit 0**，产出 `lib/index.js`（1185632 B）与 `lib/build-stamp.json`（2026-10-30T04:41:57+08:00）。
- **实测事实**：`pnpm install --frozen-lockfile --offline`（pnpm 11.7.0）**不会**触发根项目的 `prepare`；最小探针 `work/t9-prepare-min` 同样没有生成 `prepare-ran.txt`（2026-10-30T04:42:15+08:00）。因此：**不要**假设 install 会构建；CI/干净克隆必须显式 `pnpm run build`（`check:build-smoke` 默认就会构建，或 `pnpm run prepare`）。
- 本机 `pnpm run prepare` 与 `pnpm run build` 的产物字节一致（`lib/index.js` 1185632 B）。

---

## 2. 干净树 / 测试输入（P0-4）

### 2.1 命令

```powershell
node scripts/eval/check-clean-tree.mjs `
  --require-tracked package.json --require-tracked src `
  --require-tracked tests --require-tracked scripts
# 或显式：pnpm run check:clean-tree
```

判定（全部 fail-closed）：

| 情形 | 结果 |
| --- | --- |
| 任意 tracked 文件 modified/deleted/renamed | exit 1 `tracked-change`（没有「预期修改」这种豁免） |
| 未跟踪且不在允许表 | exit 1 `untracked-unexpected` |
| 未跟踪但在允许表 | exit 0（如 `test-results.json`、`lib/`、`attestation.json`、`coverage/`） |
| 允许表命中 `src/`、`tests/`、`scripts/`、`package.json` 等受保护内容 | **在读 status 之前** exit 1 `allow-rule-covers-protected-path` |
| `--require-tracked` 的路径在 index 里 0 条 | exit 1 `required-input-not-tracked` |
| 忽略目录（如 `work/`）里的文件 | 不参与（`git status` 不列 ignored） |

允许表本身是安全边界：`--allow tests/`、`--allow src/**`、`--allow package.json`、`--allow '*'`、`--allow '*.json'` 都会被拒（通配符会与 `package.json`/源码代表路径比对）。

### 2.2 CI 位置（不要挪到 install 之后）

`.github/workflows/ci.yml` 的 `verify` job 在 **setup-node 之后、`pnpm install` 之前** 执行该门，然后才是 install → 编码 → typecheck → 测试 → `check:docs`。理由：

1. install/测试产生的 `test-results.json`、`lib/` 等不能在检查时already 存在，否则「测试前就有一份旧报告」会被 `check:docs` 当成本次运行；
2. git 状态必须在任何构建步骤之前取样，否则生成物会污染判据；
3. `--require-tracked tests/scripts/src/package.json` 保证干净克隆能复现测试输入。

### 2.3 为什么**不**放进 `pnpm run verify`

rev5 全轮工作树**故意未提交**（G12，多人并发、由 t23 统一收口）。把干净树门放进 `verify` 会让本地每次验收恒红，从而训练人们忽略它。它只在 CI（未提交 → 提交前的等价副本由 t23 另测）或显式命令中运行。这条边界由 `tests/unit/p62/ci-evidence-wiring.test.ts` 与 `tests/unit/p62/clean-tree-gate.test.ts` 钉住。

### 2.4 负控制（可复跑）

```powershell
# 临时仓：clean → 0；改 tracked → 1；加意外 untracked → 1；加 lib/ → 0
node -e "..."   # 见 tests/unit/p62/clean-tree-gate.test.ts 的 makeRepo()
node scripts/eval/check-clean-tree.mjs --cwd <tmp>
```

`tests/unit/p62/clean-tree-gate.test.ts` 覆盖全部四组 + 允许表保护 + `--require-tracked` + `--json` + `--help`。

---

## 3. 报告门禁（J-1，P0-3）

`pnpm run check:docs` 除了计数对比，还要求被消费的报告本身是**完整、成功**的运行：

- `success === false` → exit 1（worker 崩溃/未捕获 rejection，计数可能完全没变）；
- `numFailedTestSuites > 0` → exit 1（collection 失败不产生 failed assertion）；
- `unhandledErrors` 非空 → exit 1（**仅在报告携带该键时**；Vitest 3.2.7 的 JSON reporter 在无错误时**不输出**该键——实测键表里没有它。因此缺键 ≠ 缺证据；`success=false` 是这一类的兜底判据，非空数组/非数组都会失败）；
- `numTodoTests > 0` → exit 1（没跑过的用例）；
- `success` / `numFailedTestSuites` / `numTodoTests` 任一缺失 → exit 1 `partial-report`（缺失的证据不算证据）；
- 计数不匹配 → exit 1（既有回归）；
- 正常报告 → exit 0，仍打印 `documentation gate fully green.`。

负控制全部是**提交的测试**（`tests/unit/p62/docs-gate-j1.test.ts`），报告的计数在运行时从 README 现值推导，不硬编码 `130/2493`；后续任务增删测试不会让负控制腐化。

**与 README 计数的关系（G6/C-4）**：任何增删测试都会让 README 的计数行漂移。实现任务不得手改计数（并发会互相覆盖）；`t9` 用 `node scripts/verify-readme-counts.mjs --docs-only` + 上述负控制验收配置参考，**全量计数由 t23 一次收口**。

---

## 4. 证明的自指边界（P0-4，必须照抄进任何报告）

`docs/reports/final-attestation.json` 描述的是它**被生成时**的提交（当前记录：`1b7920e…`）。一个记录永远不能覆盖「包含它自己的提交」：那需要摘要包含记录自身字节，而记录里又有摘要。

因此：

1. **不得**声明「当前 HEAD / 本轮改动已被证明」；本轮工作树未提交，`attest:verify` 只重算记录自己的提交，并明确打印 `informational: HEAD is …`。
2. **不得**为了「补一份证明」而重新生成或改写 `docs/reports/final-attestation.json`（G7/G10）。
3. CI 用 `${{ github.sha }}` 做**目标校验**（`--expect-commit`），并有一个显式步骤断言 canonical record **不等于** `github.sha`（记录不覆盖包含它的提交），以及 `--help` 仍包含 `SELF-REFERENCE BOUNDARY`。
4. 需要「记录说的是哪个 revision」时：`--verify <file> --expect-commit <40-hex>`；需要「HEAD 是否被证明」时：`--verify <file> --strict`（当前树应为 **exit 1**，这是正确行为，不是缺陷）。

---

## 5. 相关文件

| 主题 | 位置 |
| --- | --- |
| 构建入口 | `scripts/build.mjs`（`pnpm run build` / `prepare`） |
| 新鲜度模块 + 冻结配方 | `scripts/build-manifest.mjs`（`--status`，exit 1 = stale） |
| 构建烟测 | `scripts/eval/smoke-build.mjs`（`--status` 只查新鲜度） |
| 干净树门 | `scripts/eval/check-clean-tree.mjs` |
| J-1 报告门 | `scripts/verify-readme-counts.mjs`（§报告完整性） |
| 文档漂移更正 | `docs/reports/p0-evidence-correction.md`（§0 指针图、§C-1…§C-5） |
| 自指边界（实现） | `scripts/eval/final-attestation.mjs` 头注释 `SELF-REFERENCE BOUNDARY`、`--help` |
| 负控制测试 | `tests/unit/p62/{docs-gate-j1,clean-tree-gate,build-freshness,docs-correction-pointers,ci-evidence-wiring}.test.ts` |
