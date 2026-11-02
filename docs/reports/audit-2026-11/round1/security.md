# Audit scope: security (injection, traversal, secrets, patching, supply chain, CI)

## Verified facts summary (2-5 lines: attack surface actually exposed)
The plugin is mounted into the DSH host via `cordis.patch.yml` and its externally influenced inputs are: (1) host-provided plugin config/settings, (2) payloads returned by mounted MCP memory backends (tools/list + tool results), (3) task/session text, and (4) developer-script argv/env. The MCP-backend payload path is the only place external data reaches file-oriented MCP tool calls: lesson ids parsed from backend documents flow unsanitized into `write_note`/`delete_file` path arguments (SEC-1), and raw task text is passed as a `url` argument (SEC-2). Monkey-patching is implemented through host capability calls with LIFO/idempotent disposal, not host-prototype mutation; command execution in scripts/ is array-argument (one shell-interpolated exception, SEC-3). No secrets, no eval, no network calls in src/, CI is hardened (pull_request, read-only, SHA-pinned).

## Findings

### [SEC-1] Lesson ids from MCP backend documents reach filesystem-tool paths without traversal sanitization (P2)
- File: src/memory-bridge/drivers/markdown-note.driver.ts:37-39 (see also :90, :130-131)
- Evidence:
  ```ts
  /** Note path for one lesson. */
  export function notePath(namespace: string, lessonId: string): string {
    return noteDirectory(namespace) + '/' + lessonId + '.md';
  }
  ```
  and in `prune()` (same file, :130-131):
  ```ts
  const path = notePath(input.namespace, id);
  const args: JsonObject = { path, [fields.ids]: [path] };
  ```
  The id originates from backend-controlled document trailers — src/memory-bridge/lesson-codec.ts:506:
  ```ts
  id: trailerFields.id ?? 'rendered-' + djb2Hex(title),
  ```
  and the governance gate only requires a non-empty string — src/memory-bridge/governance-polyfill.ts:96-98:
  ```ts
  if (typeof lesson.id !== 'string' || lesson.id.trim().length === 0) {
    push(violation('invalid_lesson', 'Lesson id must be a non-empty string.', 'block', 'id'));
  ```
  The recall→prune flow feeds these ids back into the driver — src/memory-bridge/bridge.ts:457,482,490:
  ```ts
  lessons = output.records.map((record) => record.lesson);
  ...
  const selected = candidates.slice(0, maxItems).map((lesson) => lesson.id);
  ...
  const output = await result.driver.prune(result.context, { namespace, ids: selected, now: at });
  ```
- Attack path: the driver binds `delete_note`/`delete_file` for filesystem-style memory MCP servers (basic-memory, obsidian-mcp, filesystem-mcp fingerprints). Any writer to the memory store (a compromised/hostile MCP backend, or another session on a shared memory server) plants a lesson document whose trailer id is e.g. `../../../victim`. When the plugin prunes (explicit `memory.prune`, or the promote cleanup at src/memory-bridge/bridge.ts:408 `ids: [lessonId]`), the plugin itself issues the MCP delete call with path `<prefix>/global/../../../victim.md`, escaping the derived namespace directory. The same unsanitized `lesson.id` is used for `write_note`/`write_file` paths in `commit()` (:90). Impact is constrained — the MCP server runs in the same trust domain and could act on its own — but this defeats the client-side namespace containment the architecture promises (the driver declares `namespaces: false` and containment is enforced solely by this path string). Note the contrast: embedded script paths in the same data flow ARE validated (src/memory-bridge/script-syntax.ts:42-54 `isValidScriptPath` rejects `..`, drive letters, leading slashes) — lesson ids get no equivalent gate.
- Fix: run lesson ids through a `sanitizeFileToken`-style gate (reuse `lesson-codec.ts:786-788` or `isValidScriptPath`) at `notePath()`/`noteDirectory()` in markdown-note.driver.ts, or add an id-pattern check (`^[A-Za-z0-9._-]+$`) to `validateLessonForWrite` so any traversal-bearing id is a blocking violation; reject (not silently rewrite) so mismatches surface.

### [SEC-2] Raw task text passed as the `url` argument of an MCP tool without validation or truncation (P2)
- File: src/memory-bridge/drivers/markdown-note.driver.ts:65-67
- Evidence:
  ```ts
  if (binding.recall === 'build_context') {
    args.url = input.fingerprint;
  }
  ```
  The fingerprint is raw user/task content — src/memory-bridge/governance-polyfill.ts:403-417:
  ```ts
  export function buildRecallFingerprint(query: MemoryRecallQuery): string {
    const parts: string[] = [];
    if (typeof query.text === 'string' && query.text.trim().length > 0) {
      parts.push(query.text.trim());
    }
  ```
- Attack path: when auto-discovery binds `build_context` (basic-memory fingerprint), the entire recall fingerprint — task prompt text, task signature, context tags concatenated — is passed as the tool's `url` parameter. A task/prompt containing `http://169.254.169.254/...` or `file:///...` makes the plugin hand an attacker-influenced URL to the backend. If that backend dereferences `url` (basic-memory's build_context semantics), this is SSRF via the MCP server and unbounded parameter length otherwise degrades recall. Exploitability depends on the bound backend, hence P2 not P1.
- Fix: when binding is `build_context`, pass a server-safe key (a namespace-scoped tag or the lesson tag) instead of the raw fingerprint, or validate/normalize the fingerprint as a URL/path fragment (scheme allowlist, length cap) before assignment.

### [SEC-3] Shell-interpolated `execSync` for the vitest report run (P3)
- File: scripts/verify-readme-counts.mjs:385
- Evidence:
  ```js
  execSync(`pnpm exec vitest run --reporter=json --outputFile="${normalizedTemp}"`, {
    cwd: rootDir,
    stdio: 'inherit'
  });
  ```
- Attack path: `normalizedTemp` is self-generated (`os.tmpdir() + 'dsh-evo-test-results-<pid>-<ts>.json'`, lines 69-72, 383), so there is no direct attacker input today. But the command string is executed via `cmd.exe /c` on Windows: a `TMP`/`TEMP` environment value containing `"` or `&`/`()` metacharacters becomes command injection in the developer's shell context, and paths with spaces/parentheses are fragile. This is the only shell-string execution in the repo (all other child_process calls use array arguments).
- Fix: replace with `execFileSync('pnpm', ['exec', 'vitest', 'run', '--reporter=json', `--outputFile=${tempReportFile}`], {...})` (matching the pattern already used in scripts/eval/smoke-build.mjs:94, with `shell:` only where the Windows pnpm shim requires it).

### [SEC-4] `diagnostics/` is untracked and not covered by .gitignore (P3)
- File: .gitignore:7-15
- Evidence: `.gitignore` lists `work/`, `outputs/`, `dsh-probe/`, `bridge-verify/`, `f1-repro/`, `asar-*.cjs` — but not `diagnostics/`. `git status --short` shows `?? diagnostics/` (the only untracked entry), containing audit artifacts and GUI screenshots (`diagnostics/dsh-gui-20261031-2204/*.png`, `round-0*.mjs`).
- Attack path: this directory is the designated dumping ground for audit/diagnostic evidence; a future artifact placed there (host paths, session ids, memory dumps) can be committed by a routine `git add -A` because there is no ignore rule. No sensitive content is currently present (verified by secret-pattern grep).
- Fix: add `diagnostics/` to .gitignore (or an explicit allowlist if audit evidence must be committed deliberately).

### [SEC-5] Experience-log path from plugin options is joined without containment (P3)
- File: src/index.ts:1986-2002
- Evidence:
  ```ts
  export function resolveExperienceFilePath(options: EvoHarnessPluginOptions): string | undefined {
    if (options.experienceFilePath !== undefined) {
      return options.experienceFilePath;
    }
    ...
  /** Minimal POSIX/Windows join that does not pull node:path into the entry module. */
  function joinPath(dir: string, file: string): string {
    const separator = dir.includes('\\') ? '\\' : '/';
  ```
- Attack path: `options.experienceFilePath` (host/integrator config) is used verbatim as the JSONL store target (src/jitrl/stores/jsonl.store.ts:83-91 appends with 0o600). A config value containing `..` writes the experience log outside the intended data dir. Input is integrator-controlled, not external, and the default path goes through the sanitized `resolveProfileDataDir` (src/persistence/data-dir.ts:97-129) — hardening gap only.
- Fix: resolve `experienceFilePath` against the profile data dir and reject (or log) a resolved path that is not inside it; prefer `node:path` join for Windows correctness.

### [SEC-6] Windows reserved device names survive profile/namespace sanitization (P3)
- File: src/persistence/data-dir.ts:97-110
- Evidence:
  ```ts
  export function sanitizeProfileName(profile: string | undefined): string {
    ...
    const replaced = profile.trim().replace(/[^A-Za-z0-9._-]+/g, '_');
  ```
- Attack path: the character allowlist keeps traversal out but permits Windows reserved device names (`CON`, `NUL`, `AUX`, `COM1`..). A `DSH_PROFILE=CON` environment or profile value yields `profiles/CON`, which mkdir/open resolves to the console device on Windows — persistence silently misbehaves or fails. No traversal or privilege impact; the traversal half of the same function is correct (dot-run collapsing + leading-dot stripping, verified).
- Fix: add a reserved-name denylist (case-insensitive, with extension forms like `CON.txt`) to `sanitizeProfileName` and to the script-path/token sanitizers.

### [SEC-7] Root asar helper scripts hardcode a machine-specific absolute path (P3)
- File: asar-bulk.cjs:4, asar-index.cjs:3
- Evidence:
  ```js
  const asarPath = 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar';
  ```
- Attack path: none direct — the files are untracked (`asar-*.cjs` in .gitignore:16), operator-invoked, argv-driven, and contain no credentials. The hardcoded path leaks the dev username if the ignore rule is ever dropped, and `asar-list.cjs:26` builds a `RegExp` from `process.argv[3]` (self-inflicted ReDoS at worst). Recorded for hygiene only.
- Fix: read the asar path from an env var or `asar-extract.cjs`'s argv pattern; delete the helpers before any wider distribution.

## Attack surface NOT present (verified)
- No `eval`, `new Function`, or dynamic `import()` with a dynamic specifier in src/, scripts/, or asar-*.cjs. The single runtime dynamic import uses a constant (`SCHEMASTERY_PACKAGE = '@deepseek-ai/schemastery'`, src/dsh-bridge/model-config.ts:152,174-176).
- No network calls in src/ at all (no `fetch`, `http.request`, `net.connect`) — the plugin has no direct SSRF surface; all backend I/O goes through injected `McpClient` instances.
- CI (.github/workflows/ci.yml): uses `pull_request`, NOT `pull_request_target`; `permissions: contents: read` (line 11-12); `persist-credentials: false` on every checkout; all five actions pinned to full commit SHAs; zero `secrets.*` references; no `actions/cache` with attacker-influenceable keys (only setup-node's pnpm cache keyed on the committed lockfile); no untrusted PR input interpolated into `run:` blocks (`github.sha` only, quoted).
- No hardcoded secrets: repo-wide grep for `sk-`, `api_key`, `secret`, `Bearer`, `password`, AWS/GitHub token shapes over tracked files returned only false positives; no `.env*` files exist; README/ARCHITECTURE reference `MEM0_API_KEY` only as `"${MEM0_API_KEY}"` env expansion (README.md:127). No credentials files tracked (`git ls-files` clean of key/token/pem patterns); `data/` is empty and untracked; `work/`, `outputs/`, `%SystemDrive%/` are ignored.
- No host-prototype mutation: the plugin never assigns into host objects (grep for `root.X =`, `host.X =`, `.prototype.X =` returns nothing); "patching" is done by calling host-provided capabilities, and the only method replacement wraps the plugin's OWN adapter object (src/cordis-seams/dsh-hook-host-adapter.ts:2042-2052, delegating via `original.apply(adapter, args)`). Originals are restored correctly: disposers are the host's own objects, disposal is LIFO/idempotent/failure-tolerant (src/cordis-seams/disposable-registry.ts:111-130), branch mounts are fail-closed branch-scoped (src/cordis-seams/host-adapter.ts:61,69-72), and patches are validated, `structuredClone`d and deep-frozen before mounting (src/cordis-seams/patch-utils.ts:56-64).
- No prototype pollution in config handling: `deepMerge` filters `__proto__`/`prototype`/`constructor` at every recursion level (src/config.ts:613, 953-970), config validation is allowlist-based, and namespace segments are regex-sanitized with hash disambiguation (src/memory-bridge/namespace.ts:17-30).
- Command injection: all other `execFileSync`/`spawnSync`/`spawn`/`execFile` calls (scripts/build-manifest.mjs:145, scripts/eval/*.mjs, scripts/host-smoke/run.mjs:66,208, scripts/eval-jitrl.mjs:220) pass fixed argv arrays without `shell:`; the one `shell: win32` case (scripts/eval/smoke-build.mjs:94) uses constant arguments.
- Supply chain: all dependencies pinned to exact versions with no ranges (`@deepseek-ai/schemastery 3.18.4`, `esbuild 0.28.2`, `typescript 5.9.3`, `vitest 3.2.7`); `scripts/build.mjs` performs no network fetch (esbuild local bundle only, verified lines 42-51); no postinstall scripts beyond the local `prepare` build.
- Path traversal containment that works: profile names (src/persistence/data-dir.ts:97-110), embedded script paths (src/memory-bridge/script-syntax.ts:42-54 rejects drive letters, leading slashes, `..`), and host-smoke report targets (scripts/host-smoke/report-path.mjs:62-70 compares resolved absolute paths against frozen evidence).
