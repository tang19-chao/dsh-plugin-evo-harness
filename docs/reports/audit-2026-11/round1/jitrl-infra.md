# Audit scope: jitrl-infra (stores, retrieval, redaction, scope registry)

## Verified facts summary
Audited the 10 in-scope `src/jitrl` files plus the four pinned test files and the two docs. The JSONL store's tolerant-reload design is real and well tested, but (1) the shared redaction matcher has an empirically confirmed credential bypass (`Authorization: Bearer <jwt>` leaks), (2) `ExperienceQuery.policyId/driftRho` are declared in the contract and forwarded by the retriever/host-advisor but are silently ignored by the only store query implementation, (3) `compact/purge/flush` can lose concurrently appended records (reachable in production via `/evo jit reset`), and (4) the scope registry has three identity/lease integrity gaps (host-scope stale dispose, lease scope staleness, branch-carrier id misread). ADR 0006's registry-level claims and p2-p6-host-wiring's W1/W2 status claims check out against code; the tests pin real behavior but miss every defect found below.

## Findings

### [JINFRA-1] Redaction bypass: `keyword_secret` consumes the Bearer anchor and leaves the credential in the clear (P0)
- File: src/jitrl/redaction.ts:53 (keyword_secret), 36-67 (combined matcher)
- Evidence:
  ```ts
  { name: 'keyword_secret', pattern: /(?:api[_-]?key|apikey|access[_-]?key|token|secret|password|passwd|pwd|authorization|credentials?|private[_-]?key)\s*(?:[=:]\s*(?:"[^"]*"|[^\s"';,]+)|...)/i },
  ```
  Verified empirically by replicating the pattern set 1:1 and running `redactSecrets`:
  ```
  'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6y'
    => '<secret> eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6y'   (JWT LEAKS)
  'authorization: Basic dXNlcjphYmNkZWZnaGlqaw=='
    => '<secret> dXNlcjphYmNkZWZnaGlqaw=='                                                 (Basic creds LEAK)
  'token = Bearer eyJ...' => '<secret> eyJ...'                                             (LEAKS)
  ```
- Analysis: the combined regex is a leftmost-match alternation. For `Authorization: Bearer <jwt>`, `keyword_secret` matches starting at `A` (value run `[^\s"';,]+` consumes exactly `Bearer`), so the match ends before the JWT. On the next scan the JWT body matches nothing: it is not `Bearer`-prefixed anymore, its dot-separated segments are each < 43 chars (base64_blob) and contain non-hex letters (hex_blob). The header-form of every real credential (`Authorization: Bearer/Basic ...`, `token = Bearer ...`) therefore ships the secret verbatim. This matters because `redactSecrets` is the only scrub applied to task prompts before tokenization (`state-abstraction.ts:473,515,537`), to tool names/error classes (`host-tool-experience.ts:171,183,535`), and to advisory fragments (`host-advisor.ts:161`) — a leaked JWT/Basic credential lands in the JSONL experience log and in the memory-bridge mirror with `redacted: true` stamped on the record. The test suite (`tests/unit/jitrl/redaction.test.ts`) only exercises bare `Bearer <jwt>` (no `keyword:` prefix), so the bypass is unpinned.
- Fix: in the `keyword_secret` value run, when the consumed value is case-insensitively `bearer`/`basic`/`digest`, extend the match to include the following token run (e.g. append `(?:\s+(?=[^\s"';,])(?:"[^"]*"|[^\s"';,]+))?` after the scheme word), or run `bearer_token` on the residual text after keyword replacement (re-scan pass with the bearer pattern independent of the anchor). Add the `Authorization: Bearer <jwt>` shape to redaction.test.ts.

### [JINFRA-2] Concurrent append during compact/purge/flush loses durably acknowledged records (P1)
- File: src/jitrl/stores/jsonl.store.ts:299-310 (append), 321-342 (compact), 344-373 (purge), 375-378 (flush)
- Evidence:
  ```ts
  async append(records) {
    ...
    await fileFs.appendDurable(filePath, normalized.map(encodeRecord).join(''));
    for (const record of normalized) { index.insert(record); }
  },
  async compact(options2) {
    const removed = planCompaction(index.snapshotDescending(), ...);
    const survivors = index.snapshotDescending().filter((record) => !removedIds.has(record.id));
    await fileFs.replaceAtomic(filePath, survivors.map(encodeRecord).join(''));  // rename overwrites
    for (const record of removed) { index.remove(record.id); }
  }
  ```
- Analysis: there is no mutex in the store or in the kernel facade (`src/jitrl/index.ts:261-317`). Interleaving: (a) append completes its `appendDurable` (bytes in the current file), (b) compact/purge/flush — which snapshotted the index BEFORE that append — resolves `replaceAtomic` and renames the temp file over the log, (c) append inserts into the index. Result: the record is live in memory but absent from the durable log; after restart it is gone even though `append()` resolved successfully (violating the "durable first" contract documented at lines 304-305). The rewrite paths snapshot the index and then `await` real async IO (mkdir/open/write/fsync/close/rename), so the window is several macrotasks wide and reachable with plain promise scheduling. Production-reachable: `/evo jit reset` calls `facade.purge(...)` (`src/index.ts:2810-2827`) while the L3 host-tool collector appends on the same loop. The tests cover parallel appends only (`jsonl-store.test.ts:243-254`), never append-vs-rewrite.
- Fix: serialize mutations with an internal promise chain (e.g. `this.queue = this.queue.then(op)` around append/compact/purge/flush/load), or have compact/purge/flush re-read+re-merge the file under the same chain. Minimum viable: a `mutationLock` promise in `createJsonlExperienceStore` that every mutating method awaits before snapshotting and releases after the rename.

### [JINFRA-3] Store query ignores the contract's `policyId`/`driftRho` drift inputs; host-advisor drifts post-truncation without the saturation stop (P1)
- File: src/jitrl/experience-store.ts:1206-1311 (executeExperienceQuery); src/types/contracts.ts:1493-1513; src/jitrl/retriever.ts:326-329; src/jitrl/host-advisor.ts:368-387
- Evidence:
  ```ts
  // contracts.ts, ExperienceQuery:
  //   "when it is present, records produced by a different policy are weighted
  //    by `driftRho` until the same bucket holds k records from the current policy."
  readonly policyId?: string;
  readonly driftRho?: number;
  ```
  `executeExperienceQuery` never reads `query.policyId` or `query.driftRho` (no occurrence in the function; grep confirms), and retriever.ts claims the opposite:
  ```ts
  // retriever.ts, toExperienceQuery():
  // "The drift inputs are forwarded, because the store applies the same
  //  section 7.3-4 factor itself."
  ```
- Analysis: three consequences, all verifiable. (1) Any caller that sends an `ExperienceQuery` with drift inputs to `IExperienceStore.query` gets un-drifted weights and `driftWeight === undefined` on every result, contradicting the `ScoredExperience.driftWeight` contract ("the drift factor actually applied to this neighbour"). (2) The retriever docstring is false. (3) host-advisor forwards `policyId`/`driftRho` into the store query (host-advisor.ts:557-572) where they are dropped, then re-applies drift via `applyDrift` AFTER the store already truncated to top-k and with no saturation check — `driftFactorFor` in retriever.ts:89-100 stops the penalty once `currentBucketCount >= k`, `applyDrift` never does. A stale-policy record with weight 0.80 therefore occupies a top-k slot over a current-policy record at 0.75 (drift applied before ranking would have flipped them), and the penalty keeps suppressing old-policy evidence even when the neighbourhood is already saturated with fresh records. The two section-7.3-4 implementations (retriever snapshot path vs advisor store path) silently disagree.
- Fix: either implement `policyId`/`driftRho` in `executeExperienceQuery` (compute the same-bucket current-policy count, apply `driftRho` to foreign-policy weights before the top-k slice, set `driftWeight`), or remove the fields from `ExperienceQuery`/`toExperienceQuery` and make host-advisor fetch a larger pre-k pool and re-rank after drifting. Update the retriever docstring to match whichever path is real.

### [JINFRA-4] Host scopes: re-registration replaces unversioned, and a stale handle's dispose deletes the newer registration (P2)
- File: src/jitrl/scope-registry.ts:1381-1423 (registerHostScope), 619-630 (removeHostScopeInternal)
- Evidence:
  ```ts
  hostScopes.set(hostScopeKey, scope);           // unconditional replace, no version
  hostScopeOrder.push(hostScopeKey);             // duplicate push on re-registration
  ...
  dispose(): void {
    if (!handleDisposed && !disposed) {
      handleDisposed = true;
      removeHostScopeInternal(hostScopeKey);     // deletes whatever is registered NOW
    }
  }
  ```
- Analysis: P4-B added versioned registrations precisely so "a late dispose can never delete a newer registration" (module header, lines 41-45), and branch registrations get that via `registrationVersion` + the identity check at line 1091. Host scopes got none: two `registerHostScope` calls for the same `sessionId` (reachable — `dsh-hook-host-adapter.ts:1700-1706` registers one host scope per `mountScope: 'host'` mount, e.g. two permanent patches) leave handle #1 able to delete registration #2; the trust record for a live, explicitly granted host identity silently disappears and subsequent `resolveHostScope` calls fail closed (an availability/trust-accounting bug, counted nowhere — no `staleDisposeNoop` analog). Additionally `hostScopeOrder.push` runs on every re-registration without dedupe, so the order array accumulates ghost keys (it is write-only today, but it is the documented "registration order" surface).
- Fix: mirror the branch-registration scheme — `hostScopeVersion` map keyed by sessionId, each handle owns its version, dispose is a counted no-op when the version moved; push to `hostScopeOrder` only when the key was not already present. Pin with a test: register host scope A, re-register B, `A.dispose()` must keep B.

### [JINFRA-5] Leases keep a stale scope snapshot: an invariant upgrade after `acquireLease` leaves live leases reporting advice-permitting values (P2)
- File: src/jitrl/scope-registry.ts:975-1065 (registerScopeInternal), 1106-1167 (acquireLease), 896-934 (makeLeaseHandle)
- Evidence:
  ```ts
  const existingScope = scopesByCompound.get(compoundKey);
  const scope = existingScope ?? registerScopeInternal({ ...spec, ttlMs: undefined }).scope;
  ...
  return makeLeaseHandle(record, scope);   // frozen pre-upgrade object, never refreshed
  ```
  `registerScopeInternal` (the re-registration path used by `register()`) bumps `registrationVersion` but never touches `leaseRecords` — only `removeInternal`/eviction call `invalidateLeasesForScope`.
- Analysis: sequence: `acquireLease({sessionId, branchId})` attaches to a domain scope (`allowAdvice: true`); then `register({sessionId, branchId, role: 'invariant'})` replaces the scope with an invariant one (`allowAdvice: false`). The lease stays active (`isActive === true`) and `lease.scope` is still the old frozen domain object. The module's own contract ("Registrations are versioned per compound key ... Invariant provenance is sticky and key-level") is enforced for the registry map but not for the lease surface, so a lease consumer reading `lease.scope.allowAdvice`/`guidance` authorizes against pre-upgrade values — exactly the advice-channel sealing ADR 0006/P4-B is supposed to make airtight. The lease test suite never re-registers a key between acquire and read.
- Fix: on re-registration of a key, either refresh every live lease record for that key to the new scope object (`for (const l of leaseRecords.values()) if (l.scopeKey === key) handleScope = newScope`) or invalidate-then-reattach, and have `lease.scope` be a getter that re-reads `scopesByCompound.get(record.scopeKey)`. Pin with a test: acquire lease on domain key, re-register invariant, `lease.scope.allowAdvice === false` (or lease invalidated).

### [JINFRA-6] Identity extractor reads a `branch` carrier object's `id` into `sessionIds` (P2)
- File: src/jitrl/scope-registry.ts:501-506
- Evidence:
  ```ts
  for (const key of CARRIER_KEYS) {   // ['agent','session','scope','context','parent','branch']
    const child = record[key];
    if (child !== undefined) {
      visit(child, depth + 1, key === 'agent' || key === 'session' || key === 'branch');
    }
  }
  // visit(): if (readId) { const id = record['id']; ... sessionIds.add(id.trim()); }
  ```
- Analysis: a string under `branch` is (correctly) a branchId (line 497: `addStr(branchIds, record['branch'])`), but an object under `branch` gets its `id` counted as a SESSION id. A dispatch shaped `{ branch: { id: 'br-1' } }` — the natural shape of a branch carrier — reads as `session-only` with `sessionId === 'br-1'`; `{ branch: { id: 'br-1' }, branchId: 'br-1' }` reads as `branch-and-session` with `sessionId === branchId`, producing compound key `br-1::br-1` which is never registered, so a resolution that the branch-only path would have proven is instead rejected. In `resolve()` the error direction is fail-closed (safe), but `classifyScopeIdentity` is the documented ADR 0006 D-P4-2 vocabulary ("the vocabulary for deciding whether a payload proves a branch, names a session only, ...") and it now reports a branch id as a session id; `resolveHostScope` also consults the same extractor, so `{ branch: { id: 'sess-host' } }` resolves as the host session. No test pins a `branch`-object carrier (`scope-registry-identity.test.ts:72-76` covers only `agent.id`).
- Fix: treat `branch` like a branch carrier — read its `id` into `branchIds` (or drop `branch` from the readId list entirely, keeping only explicit `sessionId`/`session` fields). Add the `{ branch: { id } }` shape to the identity tests.

### [JINFRA-7] Mirror note-path disambiguation hash is computed over the sanitized slug, so it cannot disambiguate sanitization-created collisions (P2)
- File: src/jitrl/stores/bridge.store.ts:436-456 (slugSegment/stableHash/statPath), 763-771 (writeRow)
- Evidence:
  ```ts
  /** Deterministic djb2 hash, base36 - disambiguates slug collisions only. */
  function stableHash(text: string): string { ... }
  function statPath(namespace, level, bucket, actionKey) {
    const bucketSlug = slugSegment(bucket);
    const actionSlug = slugSegment(actionKey);
    const hash = stableHash(level + '\u0000' + bucket + '\u0000' + actionKey);  // bucket is ALREADY sanitized
  ...
  const bucket = sanitizeText(aggregate.bucket);
  const actionKey = sanitizeText(aggregate.actionKey);
  ...
  args[fields.path] = statPath(namespace, aggregate.level, bucket, actionKey);
  ```
- Analysis: `writeRow` sanitizes `bucket`/`actionKey` before calling `statPath`, so `stableHash` hashes the post-sanitization string. Two distinct aggregates whose keys differ only in characters `slugSegment` collapses (`'task|simple'` vs `'task-simple'`, `'a b'` vs `'a-b'` — both map to slug `task-simple`/`a-b` with equal hashes) produce the identical note path and silently overwrite each other's statistics at the backend, last write wins. This directly defeats the stated purpose of the hash ("disambiguates slug collisions") and the mirror's identity contract of one row per `(level, bucket, actionKey)` (plan section 7.2). Buckets contain free-text-derived task signatures (`meta|<signature>|<complexity>` per state-abstraction.ts:22), so punctuation-collapsed pairs are plausible. No bridge test pins collision behavior.
- Fix: hash the RAW values: pass `aggregate.bucket`/`aggregate.actionKey` (pre-sanitization) into `statPath` for `stableHash` (keep slugging the sanitized values for the human-readable segment). Add a collision test with `'task|simple'` vs `'task-simple'`.

### [JINFRA-8] `redactAbsolutePaths` misses UNC paths, `~` homes, and several common POSIX roots (P2)
- File: src/jitrl/redaction.ts:98-107
- Evidence:
  ```ts
  const ABSOLUTE_PATH_PATTERN = /([A-Za-z]:[\\/][^\s"'`]+|\/(?:usr|home|Users|root|var|tmp|mnt|opt|etc)\/[^\s"'`]+)/g;
  ```
  Verified empirically: `\\server\share\secret.txt`, `~/secret.txt`, `/srv/data/file.txt`, `/data/file.txt` all pass through unredacted (`/private/tmp/x` is caught only via its `/tmp/` segment).
- Analysis: the mirror's `sanitizeText` (bridge.store.ts:189) is the last scrub before bytes leave the process for the memory backend; it relies on this single pattern. UNC network shares (the canonical Windows machine-identifier form), `~`-expanded homes, and roots like `/srv`, `/data`, `/media`, `/workspace` (common container checkout roots) are instance-identifying paths that survive into the mirrored document/metadata. The docstring claims "Paths are stripped unconditionally" — over-broad claim vs the actual fixed allowlist.
- Fix: add `\\\\[^\\s"'`]+` (UNC), `~(?:/|\\)[^\s"'`]+`, and at least `srv|data|media|workspace|private|boot` to the alternation; keep the existing structured-key exemptions by reusing the same lookbehind guard as the blob patterns. Pin each new shape in redaction.test.ts.

### [JINFRA-9] The JSONL log grows unboundedly: bucket-cap evictions are index-only and neither `compact()` nor `flush()` is wired into any production path (P2)
- File: src/jitrl/stores/jsonl.store.ts:299-310 (append-only writes), src/jitrl/index.ts:2375-2440 (hydrate), 2625-2628 (dispose), src/index.ts:2810-2827 (only wired rewrite: /evo jit reset)
- Evidence: every `append` appends lines forever; the in-memory cap is enforced only in `ExperienceIndex.insert` (`evictOverCap`), so evicted records remain as dead lines in the file. Grep across `src/` (non-test) finds no caller of experience-store `.compact()` and no caller of the kernel's `flush()`; plugin dispose flushes only the persistence runtime (`src/index.ts:2627` — `persistence.flush()`, a different store).
- Analysis: on every restart `load()` re-reads all dead lines, re-inserts them, and re-evicts them one by one (each eviction also fires `onEvict`/diagnostics), so startup cost and the file grow without bound for the life of the deployment; the only wired rewrite is a manual `/evo jit reset`. The module header's retention story ("compaction rewrites the log", bucket cap "defaults to 200") holds for the index but not for the durable projection, contradicting the "durable projection of the index" framing at lines 14-15 — the file is a strict superset that only shrinks by user command.
- Fix: either call `kernel.flush()` (index-rewrite, drops evicted lines) on plugin dispose after `jitReady` settles, or run `compact({ maxPerBucket })` on hydrate; alternatively append-side dedupe/skip when `index.has(record.id)` and a size-based auto-compaction threshold. At minimum document the unbounded-log property where the log path is configured.

### [JINFRA-10] Crash-safety claim overstates durability: no directory fsync after create/rename (P3)
- File: src/jitrl/stores/jsonl.store.ts:81-122, 1-17 (header claim)
- Evidence:
  ```ts
  const handle = await fs.open(temp, 'wx', 0o600);
  await handle.writeFile(contents); await syncBestEffort(handle);
  await fs.rename(temp, filePath);        // no parent-dir fsync, ever
  ```
- Analysis: the temp file is fsynced but the parent directory entry is not (neither on first `open(filePath, 'a')` creation nor after `rename`). On POSIX journaling filesystems a power loss can drop the rename/creation, reverting to the previous log (compaction) or losing a freshly created log entirely. Failure direction is stale-but-mostly-safe, and the deployment target here is win32 where semantics differ, so this is a claim-accuracy issue rather than an active corruption bug — but the header asserts "a crash can never expose a half-written snapshot" without this caveat.
- Fix: after `rename`/first create, open the parent directory and fsync it (POSIX), or soften the header to "best-effort durable rename".

### [JINFRA-11] Torn-tail diagnostic reports UTF-16 code units as "byte(s)" (P3)
- File: src/jitrl/stores/jsonl.store.ts:240-247
- Evidence:
  ```ts
  const lastLine = text.slice(text.lastIndexOf('\n') + 1);
  emit({ ..., message: 'ignored a torn trailing line of ' + String(lastLine.length) + ' byte(s) without a terminating newline' });
  ```
- Analysis: `lastLine.length` is UTF-16 code units (read via `readFile(..., 'utf8')`), not bytes; for CJK-bearing lines the reported size is ~1/3 of the real byte count. The log itself is UTF-8 on disk, so the diagnostic misleads forensics about how much of a torn write was discarded.
- Fix: measure `Buffer.byteLength(lastLine, 'utf8')` (the injected `ExperienceStoreFs` would need a byteLength surface, or encode-count in `parseLog`) or relabel the message as "character(s)".

### [JINFRA-12] Diagnostics arrays are unbounded in the JSONL store, host advisor and host-tool collector (P3)
- File: src/jitrl/stores/jsonl.store.ts:268-271 (per-malformed-line emit), src/jitrl/host-advisor.ts:549/579-773 (per-evaluate push), src/jitrl/host-tool-experience.ts:258-261 (per-note push); contrast bridge.store.ts:152/562-577 (capped at 100)
- Evidence: `parseLog` emits one diagnostic per corrupt line and `diagnostics.push` retains all of them for the store's lifetime; a multi-megabyte corrupted log yields millions of retained objects and the same volume re-emitted to `onDiagnostic` on every `load()`. The advisor pushes one-plus lines per decision point (`no_neighbors`, `advise_threshold`, ...) with no cap.
- Analysis: unbounded memory growth proportional to damage/traffic in long-lived processes; inconsistent with the sibling bridge store which deliberately caps (`MAX_STORE_DIAGNOSTICS = 100`).
- Fix: apply a bounded ring buffer (the bridge store's pattern) to all three surfaces.

### [JINFRA-13] `mirrorVisibleRecords` picks "the newest reward version" by lexicographic sort (P3)
- File: src/jitrl/experience-store.ts:1504-1510
- Evidence:
  ```ts
  const rewardVersion = versions.size > 0 ? [...versions].sort()[versions.size - 1] : undefined;
  ```
- Analysis: lexicographic max of version ids; with the repo's own naming scheme, `'r10/...'` sorts before `'r2/...'` (`'1' < '2'`), so once the reward contract reaches a two-digit revision the reported "newest reward version" on the mirror snapshot regresses. Harmless today (r3/r4) but the docstring promise ("The newest reward version among the visible records") is already version-fragile.
- Fix: compare by the leading numeric generation (`/^r(\d+)\//`) with lexicographic tiebreak, or store an explicit ordering key alongside the contract id.

### [JINFRA-14] `resolveWriteFields` docstring contradicts behavior for the text field on schema-having backends (P3)
- File: src/jitrl/stores/bridge.store.ts:527-552
- Evidence:
  ```ts
  /**
   * ... with a schema that shows none of the optional candidates the argument
   * is omitted entirely so a strict backend is never handed unknown properties.
   */
  return {
    text: pick(TEXT_FIELD_CANDIDATES, 'text') ?? 'text',   // null coalesced -> ALWAYS sent
  ```
- Analysis: for path/tags/metadata a schema miss yields `null` and the argument is omitted (writeRow:769-787), but for text a miss forces the literal `text` property into the args even though the backend's schema does not declare it — precisely the "unknown property" the comment promises never to send. A strict backend rejects the write (`isError` → `BackendRejectionError`), turning a schema-mismatch into a per-row write failure for every aggregate.
- Fix: honor the documented contract — when the schema names none of `TEXT_FIELD_CANDIDATES`, skip the write (or the row) with a `no_write_tool`/`invalid_row` diagnostic instead of guessing `text`.

### [JINFRA-15] Mirror error classifier labels `TypeError` as retryable `transport` (P3)
- File: src/jitrl/stores/bridge.store.ts:243-264 (classifyError), 392-414 (retryable derivation)
- Evidence:
  ```ts
  if (error.name === 'TypeError' || error.name === 'RangeError') {
    return error.name === 'TypeError' ? 'transport' : 'invalid_input';
  }
  ...
  retryable: errorClass === 'transport' || errorClass === 'timeout' || errorClass === 'aborted',
  ```
- Analysis: a `TypeError` from the injected client is overwhelmingly a programming/contract bug (null deref, wrong argument shape), not a network transport condition; labeling it `transport` and `retryable: true` invites callers to retry a write that will fail identically forever, and skews the retryable share of the payload-free diagnostics. Payload safety is unaffected (classification only).
- Fix: map `TypeError` to `invalid_input` (non-retryable) and reserve `transport` for explicit connection/abort-shaped signals (e.g. `fetch failed`, `ECONN*` codes surfaced as typed names by the integrator).

## Positive verifications

1. **JSONL tolerant reload is real, safe, and pinned.** `parseLog` (jsonl.store.ts:189-249) keeps the healthy prefix on a torn tail, isolates per-line corruption, implements last-writer-wins for duplicate ids, and never lets SyntaxError text (which quotes input) reach diagnostics — all pinned by `tests/unit/jitrl/jsonl-store.test.ts:145-201` including the payload-free assertion with a planted secret, and the real-filesystem tests (`:390-454`) prove the temp-file + rename path leaves no debris.

2. **Durable-before-index append ordering is correctly implemented.** `append` writes bytes before mutating the index (jsonl.store.ts:299-310) and the failure test (`jsonl-store.test.ts:127-135`) proves a failed append leaves the index empty, so a rejected append can never diverge from the log.

3. **Scope-registry fail-closed identity rule matches ADR 0006 and is genuinely pinned.** `resolve` refuses session-only payloads even when a trusted host scope exists, requires the registered compound key, treats multi-compound branch-only payloads as ambiguous, and every outcome increments a bucket whose closure (`total === proven + unknown`, 5 rejection buckets) is asserted (`scope-registry.ts:1294-1379`; `scope-registry-identity.test.ts:79-155`). `RegisteredHostScope.authorizesBranch` is the literal `false` at the type level (scope-registry.ts:193-202, 1407) with no runtime path that mutates it, and `registerHostScope` counts rejections before throwing (`:1387-1393`), exactly as the ADR's §7 consistency table claims.

4. **Invariant stickiness and lease supersede semantics behave as documented.** Re-registration can upgrade to invariant but never downgrade (role/guidance/allowAdvice keep the stricter value, counted as `downgradePrevented`/`invariantUpgrades`/`stickyInvariantKept`, scope-registry.ts:994-1028), late dispose of a replaced branch registration is a counted no-op via the version check (`:1091-1095`), carrier leases live behind a WeakMap/WeakRef with the superseded handle unable to release the new lease, and lease accounting closes (`acquired === released + expired + superseded + invalidated + live`) — pinned by `scope-registry-lease.test.ts:51-134, 136-218, 383-428`.

5. **p2-p6-host-wiring.md's W1/W2 claims check out against code.** `resolveBudgetHookConfig` exists (`src/index.ts:1640`) and is actually consumed at the decorator construction point (`:1848`, spread only when defined), `assembleMeasuredCostObservations` is exported (`:1693`) with explicit comments that `costObservations` is deliberately never produced in the default assembly (`:1634`, `:1690`) — matching the report's "landed" vs "failed (unwired)" verdicts, and the bridge mirror's disabled state is a strict zero-contact no-op pinned by test (`bridge.store.test.ts:179-181`).
