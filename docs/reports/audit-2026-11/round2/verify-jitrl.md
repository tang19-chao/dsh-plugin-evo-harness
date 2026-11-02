# Round-2 verification: jitrl-core.md + jitrl-infra.md

Verifier: adversarial re-audit, round 2. Every finding was re-checked against the current tree by
personally reading the cited regions (plus ±30 lines) and, where the claim is behavioral, by
reproducing it against the real module. JINFRA-1, JINFRA-8 and JINFRA-7 were tested empirically by
bundling `src/jitrl/redaction.ts` with the repo's own esbuild (0.28.2) into a temp dir and importing
the actual `SECRET_PATTERNS` / `redactSecrets` / `redactAbsolutePaths`; all eight bundled pattern
sources were verified verbatim against `src/jitrl/redaction.ts:38-61` before running. Scratch files
were deleted after use.

## Summary table

| ID | Verdict | Final severity | One-line note |
|---|---|---|---|
| JINFRA-1 | CONFIRMED | P0 | Reproduced on the real module: `Authorization: Bearer <jwt>` leaves the JWT verbatim; `redactSecrets` is the only scrub on every persistence path. |
| JINFRA-2 | CONFIRMED | P1 | No mutex anywhere (store/facade/controller); purge/compact/flush snapshot-then-await-IO; `/evo jit reset` runs on the same loop as L3 appends. |
| JINFRA-3 | CONFIRMED | P1 | `executeExperienceQuery` never reads `policyId`/`driftRho`; retriever docstring false; advisor drifts post-truncation with no saturation stop; production wires the store seam. |
| JINFRA-4 | CONFIRMED | P2 | Host scopes re-register unconditionally, duplicate `hostScopeOrder.push`, dispose deletes the newer registration; branch path has the version check, host path does not. |
| JINFRA-5 | CONFIRMED | P2 | `lease.scope` is a frozen pre-upgrade object; re-registration replaces the map entry and never touches `leaseRecords`. |
| JINFRA-6 | CONFIRMED | P2 | `branch` object carriers get their `id` read into `sessionIds` (`CARRIER_KEYS` includes `'branch'` with `readId=true`). |
| JINFRA-7 | REFUTED | — | Empirically refuted: the hash input is the sanitized string, which preserves `|`/space, so round-1's example pairs produce DIFFERENT hashes and distinct note paths. |
| JINFRA-8 | CONFIRMED | P2 | Empirically: UNC, `~/`, `/srv`, `/data`, `/media`, `/workspace` all pass through `redactAbsolutePaths`. |
| JINFRA-9 | CONFIRMED | P2 | No production caller of `kernel.flush()` or store `compact()`; the only `.flush()` wired is `persistence.flush()` (a different store). |
| JINFRA-10 | CONFIRMED-DOWNGRADED | P3 | Missing dir-fsync is factual, but the quoted header claim ("never expose a half-written snapshot") is not actually falsified — a lost rename reverts to the old file, not a torn one. |
| JINFRA-11 | CONFIRMED | P3 | `lastLine.length` (UTF-16 units) reported as "byte(s)" at jsonl.store.ts:245. |
| JINFRA-12 | CONFIRMED | P3 | jsonl.store / host-advisor / host-tool diagnostics arrays unbounded; bridge store caps at 100 (bridge.store.ts:152,574-575). |
| JINFRA-13 | CONFIRMED | P3 | `[...versions].sort()` lexicographic max at experience-store.ts:1510; a numeric generation parser already exists unused (reward-contract.ts:201-210). |
| JINFRA-14 | CONFIRMED | P3 | `text: pick(...) ?? 'text'` (bridge.store.ts:547) forces an unknown property exactly contrary to the docstring at 528-531. |
| JINFRA-15 | CONFIRMED | P3 | TypeError → `transport` → `retryable: true` (bridge.store.ts:255-256,408); note undici `fetch failed` is a TypeError, so the mapping is partially defensible — severity stays P3. |
| JITRL-1 | CONFIRMED | P1 | Code cannot express `failed` (writeback-gate.ts:273-275); preregistration §5 (line 69) requires `verification.status === 'failed'`; nuance on the stated pool scenario below. |
| JITRL-2 | CONFIRMED | P2 | `log(share/T)` is a constant shift; `centerLogits` (logit-adjuster.ts:114-127) removes even the residual from reported z'; only the zero-share floor gap moves. |
| JITRL-3 | CONFIRMED | P2 | `applyWritebackVerdict` never touches `learningTarget`; orchestrator re-implements inline (orchestrator.ts:2678-2679, 2719); only tests call the helper. |
| JITRL-4 | CONFIRMED | P2 | Zero callers of `getLogitSource`/`logitFor` in src/ or scripts/ (tests only); metering option dropped at logit-sources.ts:296-309. |
| JITRL-5 | CONFIRMED | P2 | Test at writeback-gate.test.ts:254-263 passes a USABLE 2-entry index; genuinely-unusable history yields `rejected-no-prior-failure` (gate lines 296-298 fire before the `usable` check at 307). |
| JITRL-6 | CONFIRMED | P3 | Judge reads only 4 signals; `status==='failed' && reward>0` unsatisfiable (step-evaluator.ts:895,900-902 and reward-contract clamp). |
| JITRL-7 | CONFIRMED | P3 | Eligibility gate on legacy `return` (value-estimator.ts:160-162) vs contract target `observedReturn` (reward-contract.ts:393-398); latent, no diverging producer shipped. |
| JITRL-8 | CONFIRMED-DOWNGRADED | P3 | Gap is real ONLY for compound branchId+sessionId grants; round-1's session-only-grant example is refuted by the explicit `session-cannot-authorize-branch` denial (runtime-control.ts:430-434). |
| JITRL-9 | CONFIRMED | P3 | `appended = records.length` (backfill.ts:509) vs "records the store accepted" (backfill.ts:134); store keeps one copy per id (experience-store.ts:946). |
| JITRL-10 | CONFIRMED | P3 | `--confirm` required only when `bucket === undefined` (commands.ts:392); usage line does not mark it. |

## Per-finding verification

### [JINFRA-1] verdict: CONFIRMED (P0)
- Re-check evidence:
  - Pattern set verified: the esbuild bundle of the real `src/jitrl/redaction.ts` exports 8
    `SECRET_PATTERNS`; every `pattern.source` string was string-matched verbatim against the source
    file (redaction.ts:38-61), so the empirical run exercised the actual production matcher.
  - Empirical outputs from the real module (one run, fixed point):
    - `'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6y'`
      → `'<secret> eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6y'` — JWT LEAKS.
      Match regions: `[0..21)` = `"Authorization: Bearer"` — `keyword_secret` consumed the anchor and
      the value run stopped at `Bearer` exactly as round-1 derived.
    - `'authorization: Basic dXNlcjphYmNkZWZnaGlqaw=='` → `'<secret> dXNlcjphYmNkZWZnaGlqaw=='` — LEAKS.
    - `'token = Bearer <jwt>'` → `'<secret> <jwt>'` — LEAKS.
    - Control: bare `'Bearer <jwt>'` → `'<secret>'` (redacted) — confirming the tests' bare shape
      misses the header form.
    - Control: `'authorization: Bearer ghp_abc…'` → `'<secret> <secret>'` — gh-tokens survive header
      form only because `github_token` matches independently; JWT/Basic shapes have no independent
      pattern, which is why they leak.
    - Fixed-point property: a second `redactSecrets` pass on the leaking output returns it
      unchanged — the leak is stable, never self-heals.
  - No other redaction layer before persistence: `grep -rn "redactSecrets|redactAbsolutePaths" src/`
    shows every consumer routes through this one implementation —
    state-abstraction.ts:473,515,537 (`scrubInstanceDetails`, `sanitizeExplicitSignature`,
    `normalizeSignature`), host-tool-experience.ts:171,183,435,535 (`safeToolName`,
    `safeErrorClass`, `actionKey`), host-advisor.ts:161 (`safeFragment`),
    step-evaluator.ts:167-168, and bridge.store.ts:189 (`sanitizeText` = last scrub before the
    memory backend). jsonl.store.ts `append` (299-310) applies only
    `normalizeExperienceRecords` + `JSON.stringify` (encodeRecord, 180-182) — no scrub.
  - Persistence chain confirmed: host-tool-experience.ts:456/507/535 → `append({...})` →
    `options.store.append([record])` (line 430) with `redacted: true` stamped (line 427) — a JWT in a
    tool name or error class lands in the JSONL log and (via bridge.store sanitizeText, line 189)
    in the memory mirror with the false `redacted` attestation.
  - The post-redaction scrubbers in scrubInstanceDetails do not rescue the leak: line 490
    (`[^a-z0-9+#]+` → space) only splits the JWT at its dots, and line 488 (hex ≥7) does not match
    base64url segments, so JWT segment tokens survive into signature derivation.
- Disconfirming evidence considered:
  - `step-evaluator.ts:163-169` withholds raw text entirely when `storeRawText` is false (the
    default, config.ts:457) — but that only guards the judge-prompt rendering path, not the
    abstraction/tool/advisory/mirror paths above.
  - The `aws_access_key` header form (`x-api-key: AKIA…`) is actually consumed whole by
    `keyword_secret` (leftmost alternative wins) — no leak there; the leak is specific to
    credentials whose only patterns are anchor-shaped (JWT, Basic).
  - Searched for a second, independent scrub in jsonl.store/bridge.store — none exists; both call
    the same redaction module.

### [JINFRA-2] verdict: CONFIRMED (P1)
- Re-check evidence:
  - jsonl.store.ts read in full: `append` (299-310) writes bytes via `appendDurable` then inserts
    into the index; `compact` (321-342), `purge` (344-373) and `flush` (375-378) snapshot
    `index.snapshotDescending()` BEFORE awaiting `fileFs.replaceAtomic` (mkdir → open 'wx' →
    writeFile → sync → close → rename, lines 102-121 — six real async hops). No mutex, promise
    chain or mutation queue exists anywhere in the file (verified by full read).
  - Kernel facade (jitrl/index.ts:261-317) is a plain pass-through — `append` → `drive.append`,
    `purge` → `drive.purge` (302-305); no serialization. The command controller and dispatch path
    (src/index.ts:2830+, 3107-3133 `runFromCommand` → `executeJitCommand` → `resetResult` →
    `controller.reset` → `facade.purge`, src/index.ts:2799-2829) add no lock either.
  - Concurrency is real: `/evo jit reset` is dispatched from the plugin's async `runFromCommand`,
    while L3 appends arrive from the independent `'tools/post-execute'` hook
    (dsh-hook-host-adapter.ts:1529-1559 → `sink.observeToolCall`, line 1549) wired to the SAME
    `kernel.store` (src/index.ts:1917-1926, line 1920 `store: kernel.store`). Two independent async
    entry points, one event loop; the purge's snapshot-then-rename window is several macrotasks
    wide, so an append landing inside it is clobbered by the rename while `append()` has already
    resolved (violating the "durable first" comment at jsonl.store.ts:304-305).
  - Test coverage claim verified: tests/unit/jitrl/jsonl-store.test.ts:243-254 covers concurrent
    appends only; the compact/purge/flush tests (203-241, 313+) are sequential — no
    append-vs-rewrite interleaving test exists.
- Disconfirming evidence considered:
  - Searched for serialization in the host adapter, command controller and facade — none.
  - A purge with `bucket` matching nothing is a no-op (jsonl.store.ts:351-353), and `flush` only
    fires from tests — but `purge` with a real bucket (or global reset) is the documented
    `/evo jit reset` behavior (jsonl.store.ts:158-163), reachable mid-run.

### [JINFRA-3] verdict: CONFIRMED (P1)
- Re-check evidence:
  - `executeExperienceQuery` (experience-store.ts:1206-1311) read in full: it reads `level`,
    `guidanceFilter`, `before`, `excludeLegacy`, `minimumExperienceSchemaVersion`,
    `learningEligibleOnly`, `learningTrack`, replay declaration fields, `state.tokens/bucket`, `k`,
    `similarityThreshold`. `query.policyId` and `query.driftRho` appear nowhere in the function;
    grep over experience-store.ts finds `policyId` only as a RECORD field (189, 401-403, 474, 655)
    and `driftRho`/`driftWeight` not at all. The top-k slice at 1306 is drift-free.
  - Contract: src/types/contracts.ts:1500-1513 declares both fields with the section-7.3-4 wording;
    contracts.ts:1550-1556 documents `ScoredExperience.driftWeight` as "the drift factor actually
    applied to this neighbour" — never set by the store query.
  - Retriever docstring false: retriever.ts:324-329 ("The drift inputs are forwarded, because the
    store applies the same section 7.3-4 factor itself") vs the code above.
  - Divergence confirmed: the retriever's snapshot path applies drift BEFORE ranking with the
    saturation stop (`driftFactorFor` retriever.ts:89-100, applied at 291-292, slice at 306), while
    the advisor path forwards the inputs into the store query (host-advisor.ts:552-573), gets the
    un-drifted top-k (line 615), then `applyDrift` (628) multiplies post-truncation with NO
    saturation check (host-advisor.ts:368-387 — no `currentBucketCount >= k` anywhere).
  - Production reachability: the kernel hands the advisor the STORE seam directly
    (jitrl/index.ts:531-554, lines 542-554), so the store path (not a retriever) is the live one.
- Disconfirming evidence considered:
  - Checked whether any other store implementation honors the fields — memory.store's query also
    funnels through `executeExperienceQuery` (jsonl.store.ts:313); no honoring implementation exists.
  - If `request.policyId` is never set by callers the behavioral delta shrinks, but the contract
    violation and the false docstring stand independently.

### [JINFRA-4] verdict: CONFIRMED (P2)
- Re-check evidence: scope-registry.ts:1410-1411 `hostScopes.set(hostScopeKey, scope)` +
  `hostScopeOrder.push(hostScopeKey)` unconditional on every registration; handle.dispose
  (1416-1421) calls `removeHostScopeInternal(hostScopeKey)` (619-630) which deletes whatever is
  currently registered with no version check — in contrast the branch path returns a version
  (1064) and its dispose checks `registrationVersion.get(compoundKey) !== version ||
  scopesByCompound.get(compoundKey) !== scope` (1091-1095, counted `staleDisposeNoop`).
  Reachability: dsh-hook-host-adapter.ts:1700-1706 registers one host scope per
  `mount.scopeClass === 'host'` mount keyed by `mount.sessionId` — two host mounts on one session
  make handle #1 able to delete registration #2. `hostScopeOrder` also accumulates duplicate keys
  on re-registration (1411 vs the single-index splice at 625-628).
- Disconfirming evidence considered: module header (lines 41-45 per round-1) promises late-dispose
  safety "via version check" — that mechanism demonstrably exists only for branch scopes; looked
  for a host-scope version map — none exists.

### [JINFRA-5] verdict: CONFIRMED (P2)
- Re-check evidence: `makeLeaseHandle` (896-934) stores `scope` as a plain frozen object property
  (899); `isActive` reads only `record.active` (904-914). `acquireLease` attaches to
  `scopesByCompound.get(compoundKey)` or registers (1129-1132) and returns
  `makeLeaseHandle(record, scope)` (1167). `registerScopeInternal` (975-1065) replaces the map
  entry with a NEW frozen scope (1044-1059) and never touches `leaseRecords`;
  `invalidateLeasesForScope` is called only from removeInternal (699) and eviction (712) — not from
  re-registration. So domain-lease + invariant re-registration leaves a live lease reporting the
  pre-upgrade `allowAdvice: true` scope object.
- Disconfirming evidence considered: checked for any lease-refresh on re-registration or a
  `scope` getter — none; the supersede path (1135-1142) only fires when a NEW lease is acquired.

### [JINFRA-6] verdict: CONFIRMED (P2)
- Re-check evidence: CARRIER_KEYS = `['agent','session','scope','context','parent','branch']`
  (scope-registry.ts:468); the loop at 500-506 passes `readId = key === 'agent' || key ===
  'session' || key === 'branch'`; `visit` (484-494) adds `record['id']` to `sessionIds` when
  `readId`. So `{branch: {id: 'br-1'}}` classifies as session-only with sessionId 'br-1', while a
  string `branch` is correctly a branchId (497 `addStr(branchIds, record['branch'])`).
- Disconfirming evidence considered: resolution failure direction is fail-closed (round-1 already
  noted); the defect is the misreported identity vocabulary feeding `classifyScopeIdentity` and
  `resolveHostScope` (1425-1434 uses the same extractor).

### [JINFRA-7] verdict: REFUTED
- Re-check evidence (empirical): `writeRow` sanitizes first (bridge.store.ts:763-764) then calls
  `statPath` (770), and `statPath` hashes `level + '\u0000' + bucket + '\u0000' + actionKey`
  (451-456). The mechanism claim (hash over sanitized values) is TRUE — but the consequence does
  not follow, because `sanitizeText` = `redactAbsolutePaths(redactSecrets(raw))` (bridge.store.ts:188-190)
  PRESERVES punctuation like `|` and space. I replicated slugSegment/stableHash/statPath exactly
  (bridge.store.ts:436-456, ILLEGAL_SEGMENT_CHARS at 148) plus the real bundled redaction pipeline:
  - `'task|simple'` vs `'task-simple'` → slugs both `task-simple`, but hashes `1rpn599` vs
    `1gpzy32` → DISTINCT paths.
  - `'a b'` vs `'a-b'` → hashes `icx9hj` vs `qrtras` → DISTINCT paths.
  - The only collisions are strings that sanitize to identical output (`token: <secret-a>` vs
    `token: <secret-b>`, or two different absolute paths) — which is the documented, intentional
    bucket-stability property of the redaction pipeline (redaction.ts:13-16), and such inputs are
    already merged upstream before an aggregate can be built (state-abstraction redacts before
    signature/bucket derivation, state-abstraction.ts:473,537).
- Disconfirming evidence considered: round-1's premise "slugSegment collapses `|` so both map to
  slug `task-simple` with equal hashes" conflates slugification (which collapses) with
  sanitization (which does not); the hash exists precisely to disambiguate the slug collapse and
  still receives the distinguishing characters. No test pins this, but the behavior is correct as
  implemented.

### [JINFRA-8] verdict: CONFIRMED (P2)
- Re-check evidence (empirical, real bundled `redactAbsolutePaths`, pattern at redaction.ts:98):
  `\\server\share\secret.txt`, `~/secret.txt`, `/srv/data/file.txt`, `/data/file.txt`,
  `/media/usb/file.txt`, `/workspace/build/out.txt` all pass through UNCHANGED;
  `/private/tmp/x` is partially caught (`/private<path>`) via the `/tmp/` alternative;
  controls `/var/log/app.log` and `C:\Users\admin\file.txt` fully redacted.
- Disconfirming evidence considered: none — the pattern is a fixed allowlist (`usr|home|Users|root|
  var|tmp|mnt|opt|etc`) and the docstring's "stripped unconditionally" (redaction.ts:100-104) is
  over-broad exactly as claimed.

### [JINFRA-9] verdict: CONFIRMED (P2)
- Re-check evidence: kernel `flush()` defined at jitrl/index.ts:570-575; grep across src/ shows the
  only `.flush()` call is `persistence.flush()` (src/index.ts:2627) — the persistence runtime's
  policy store, a different store (round-1's exact claim). Store `compact()` has no caller outside
  the facade pass-through (jitrl/index.ts:296-301) and tests. Bucket-cap eviction is index-only
  (ExperienceIndex.insert → `this.evictOverCap(record)` at experience-store.ts:975; cap default 200
  at line 115); appends write every record's line unconditionally (jsonl.store.ts:299-310), so
  evicted records persist as dead lines that `load()` re-parses and re-evicts on every restart.
  The only wired rewrite is `/evo jit reset` → `facade.purge` (src/index.ts:2820).
- Disconfirming evidence considered: searched for hydrate-time compaction and dispose-time flush of
  the kernel — neither exists (dispose flushes only persistence, src/index.ts:2624-2627).

### [JINFRA-10] verdict: CONFIRMED-DOWNGRADED (P3)
- Re-check evidence: `appendDurable` (jsonl.store.ts:81-90) opens with 'a' — no parent-dir fsync on
  first creation; `replaceAtomic` (102-121) fsyncs the temp file then renames (116) — no dir fsync.
  All factual.
- Downgrade rationale: the quoted header claim (lines 11-12) is narrow — "a crash can never expose a
  half-written snapshot". A lost rename after power loss reverts the directory entry to the previous
  file (a complete, older log), and a lost creation leaves no file — in neither case is a torn
  snapshot exposed. The gap is real durability-loss (the fresh append log can vanish despite the
  file fsync), so the finding stands as a claim-accuracy/durability nuance, not as refutation of the
  quoted sentence. Round-1 itself scoped it "claim-accuracy rather than active corruption".

### [JINFRA-11] verdict: CONFIRMED (P3)
- Re-check evidence: jsonl.store.ts:240-246 — `lastLine = text.slice(...)`; `text` comes from
  `readText` which reads `'utf8'` into a JS string (91-99); the message concatenates
  `lastLine.length` (UTF-16 code units) labeled "byte(s)".

### [JINFRA-12] verdict: CONFIRMED (P3)
- Re-check evidence: jsonl.store.ts:268-271 `diagnostics.push` with no cap (parseLog emits per
  malformed line, 215/236/241); host-tool-experience.ts:242/259 unbounded `note()`; host-advisor.ts:549
  `diagnostics: string[]` with 8 unbounded push sites (579, 620, 624, 634...). Contrast
  bridge.store.ts:152 `MAX_STORE_DIAGNOSTICS = 100` enforced at 574-575.

### [JINFRA-13] verdict: CONFIRMED (P3)
- Re-check evidence: experience-store.ts:1510 `[...versions].sort()[versions.size - 1]` — default
  lexicographic; `'r10/x' < 'r2/x'` so a two-digit generation regresses the reported "newest reward
  version" (docstring 1500-1501). A numeric generation parser already exists in the codebase
  (`rewardVersionGeneration`, reward-contract.ts:201-215, "r3/x -> 3") and is unused here.

### [JINFRA-14] verdict: CONFIRMED (P3)
- Re-check evidence: bridge.store.ts:528-531 docstring ("a schema that shows none of the optional
  candidates the argument is omitted entirely so a strict backend is never handed unknown
  properties") vs line 547 `text: pick(TEXT_FIELD_CANDIDATES, 'text') ?? 'text'` and writeRow line
  768 `args[fields.text] = document` — a schema-having backend naming none of TEXT_FIELD_CANDIDATES
  still receives a `text` property; `backendRejection` → `BackendRejectionError` (789-792) makes
  every row fail.

### [JINFRA-15] verdict: CONFIRMED (P3)
- Re-check evidence: bridge.store.ts:255-256 `TypeError → 'transport'`, `RangeError →
  'invalid_input'`; line 408 `retryable: errorClass === 'transport' || errorClass === 'timeout' ||
  errorClass === 'aborted'` — TypeError is retryable.
- Interpretation caveat: in Node/undici, network failures from `fetch` surface as `TypeError: fetch
  failed`, so for an HTTP-based MCP client the mapping catches real transport errors too; the
  comment at 254 shows this is deliberate. The cost (programming bugs classified retryable) keeps
  it a P3, matching round-1.

### [JITRL-1] verdict: CONFIRMED (P1)
- Re-check evidence:
  - Code: writeback-gate.ts:273-275 `priorFailure = bucket.some((entry) => entry.actionKey ===
    signals.actionKey && !entry.verified && !entry.counterexample)`; the history entry type
    (172-177) carries only `{actionKey, verified, counterexample}` — no verdict field;
    `writebackHistoryEntryOf` (192-202) computes `verified = trustedSource && verificationStatus ===
    'passed'`, so prior `unknown`, `partial`, `failed`, and untrusted-`passed` all collapse to
    `verified: false` and satisfy G-A. The header's own wording (28-32) demands "a prior `failed`
    record for the SAME actionKey" and refuses "trusted-but-never-failed".
  - Doc: preregistration §5 (docs/reports/rev6-jitrl-intervention-preregistration.md:69, section at
    68-76) freezes G-A as requiring the same-actionKey prior execution to have left a record with
    `verification.status === 'failed'`, explicitly disqualifying half-evidence. The file's sha256
    (`a9d97aa4631a…d948b`) matches the digest pinned in the module header (writeback-gate.ts:23), so
    the deviation is against the frozen text.
  - Tests pin the diluted semantics: the "recorded failure" fixture at
    tests/unit/jitrl/writeback-gate.test.ts:102-111 is `history('action-a', 2, 0)` = two
    `verified: false` entries (helper at 60-71) — indistinguishable from unknown verdicts.
  - Reachability (corrected): unknown-verdict records are trainable through the process path
    (step-evaluator.ts:930-936: `taskQualityLearningEligible = eligible &&
    (!verdictDerivedCompletion || trustedSource)`; unknown → `verdictDerivedCompletion === false` →
    trainable), and with the gate OFF (default — orchestrator.ts:1067 `deps.writebackGate === true`)
    they persist with `learningEligible: true` and no `verificationVerdict` mark (verdictCode 0 at
    orchestrator.ts:2217-2222), later feeding `priorFailure` for their actionKey. The offline eval
    script reproduces the exact dilution: scripts/eval/rev6-jitrl-intervention.mjs:275-282 pushes
    EVERY prior record into the history via `writebackHistoryEntryOf` with the same
    verdictCode-0 mapping.
- Disconfirming evidence considered (and where round-1 overstates):
  - The production history reader EXCLUDES gate-refused records: orchestrator.ts:2196-2198 skips
    `record.learningEligible === false`, so the 180 audited records of the rev6 pool can only serve
    as phantom prior failures if they were persisted with `learningEligible !== false` — true for a
    gate-off capture run (the rev6 corpus was captured from the un-gated C3-online writer and judged
    offline, result doc line 53), but NOT for records refused by a live gate. Round-1's sentence
    "the FIRST future execution of any of those actionKeys … is admitted" holds for the offline/capture
    semantics and gate-off-produced history, and needs that qualifier.
  - Host-tool records additionally pass the history filters (the facade stamps
    `experienceSchemaVersion: 2` on unstamped records, jitrl/index.ts:276-287; `learningEligible`
    undefined passes the 2196 filter), carrying no verdict marks — a second, structural source of
    verdict-less history entries (bounded by actionKey overlap, which is usually disjoint from
    meta-level keys).
  - A trusted `failed` prior with `learningTarget > 0` is correctly classified a counterexample
    (orchestrator.ts:2227-2228), so the dilution is one-directional — it cannot fabricate failures
    from mismatches.

### [JITRL-2] verdict: CONFIRMED (P2)
- Re-check evidence: logit-sources.ts:137-144 — `const effective = modulated / temperature; return
  effective > 0 ? Math.log(effective) : ZERO_SHARE_LOGIT;` exactly as quoted. `log(share/T) =
  log(share) - log(T)` shifts every positive-share slot by the same constant. Consumed at
  jit-active-policy.ts:1186-1191 with `policy.explorationTemperature`. The no-op is even stronger
  than round-1 states: `composeDecision` centers the base logits (`centerLogits`,
  logit-adjuster.ts:114-127, applied at 183 and 294-296) which subtracts the per-decision mean — a
  uniform `-log(T)` cancels identically, so reported z', prior probabilities, argmax and `klToPrior`
  are all bit-for-bit invariant whenever every candidate's share is positive. Residual effect:
  zero-share slots are pinned at `ZERO_SHARE_LOGIT` (144), so T moves only their gap
  (normalizeSlotWeights falls back to the all-positive DEFAULT_SLOT_PRIOR at 99-103 when all raw
  weights are non-positive).

### [JITRL-3] verdict: CONFIRMED (P2)
- Re-check evidence: writeback-gate.ts:354-359 doc comment promises "forced to a zero learning
  target and explicit ineligibility"; the body (360-368) sets only `learningEligible: false` and
  never mentions `learningTarget`. Preregistration §5 (line 74) freezes the refused encoding as
  "`learningEligible: false`，`learningTarget: 0`，保留 `reward`". Production is compliant via the
  inline copy (orchestrator.ts:2678-2679 `learningTarget = eligible && !writebackAudited ? clamp(...)
  : 0`; eligibility at 2719), and `applyWritebackVerdict` has no production callers — only
  tests/unit/jitrl/writeback-gate.test.ts:359-385 and the rev6 result doc's citation.

### [JITRL-4] verdict: CONFIRMED (P2)
- Re-check evidence: jitrl/index.ts:328-339 lazily builds `AutoLogitSource` from
  `jitrl.logitSource`; exposed on the kernel API at 371 (interface at 169). `grep -rn
  "getLogitSource|logitFor" src/ scripts/` finds no caller outside the definition file and the
  kernel object itself; tests exercise `logitFor` only on directly-constructed sources
  (tests/unit/jitrl/logit-sources.test.ts). Config surface is real (config.ts:421 default 'auto';
  validated at 1274). Secondary claim verified: `createAutoLogitSource` (logit-sources.ts:296-309)
  constructs `createTokenLogprobSource({ model, capabilities })` without the `metering` option that
  `createTokenLogprobSource` accepts (204-206) — even the dead probe is unmetered. The header
  (index.ts:17-19) honestly notes L1 uses `policyPriorLogit()` directly but the source remains
  purchasable-and-unused.

### [JITRL-5] verdict: CONFIRMED (P2)
- Re-check evidence: tests/unit/jitrl/writeback-gate.test.ts:254-263 is named "G-A still works on
  unusable history" but passes `indexWritebackHistory(history('action-a', 2, 0))` — a usable index
  with two entries. With genuinely unusable history (`indexWritebackHistory(undefined)`), `bucket`
  is `[]` (gate line 267), `priorFailure` is false, and a trusted `passed` is refused with
  `rejected-no-prior-failure` at lines 296-298 — the G-A branch runs BEFORE the `history.usable`
  check (307), so `history-unusable` is unreachable for a passed verdict. Code, test name and
  comment tell three stories exactly as round-1 concluded.

### [JITRL-6] verdict: CONFIRMED (P3)
- Re-check evidence: `judgeWriteback` (writeback-gate.ts:262-320) reads only `signals.actionKey`,
  `signals.trustedSource`, `signals.verificationStatus`, `signals.recordLearningEligible` plus the
  history bucket; `verifierRewardMismatch`/`forceAuditOnly` appear only in the view type (152-154)
  and in `writebackHistoryEntryOf` (194, 200). Producer: orchestrator.ts:2633
  `verifierRewardMismatch: evaluation.verification.status === 'failed' && reward > 0`. That
  condition is unsatisfiable: the step evaluator zeroes reward on every failed path
  (step-evaluator.ts:895 `reward = eligible ? fuse(...) : 0`; 900-902 `if (verification.status ===
  'failed' && eligible && reward > 0) reward = 0`), and the orchestrator's audit branch sets
  `reward = 0` outright (2590) — so `reward > 0` implies `status !== 'failed'`. `forceAuditOnly`
  vetoes only indirectly: `forcedAuditOnly` (orchestrator.ts:2521-2523) → `consumptionEligible`
  (2502) → `recordLearningEligible: eligible && outcomeEligible` (2635) →
  `rejected-record-ineligible`. No wrong admission; dead diagnostics surface confirmed.

### [JITRL-7] verdict: CONFIRMED (P3)
- Re-check evidence: value-estimator.ts:160-162 `if (!Number.isFinite(neighbor.record.return))
  { continue; }` gates neighbourhood admission on the legacy field, while `estimateStateValue`
  (179-197) consumes `readLearningTarget(neighbor.record)` = observedReturn first, `return`
  fallback (reward-contract.ts:393-398). Latent: every shipped producer stamps `return ===
  observedReturn` (orchestrator.ts:2600-2601, 2754) or only `return` (host-tool-experience.ts:419,
  where the fallback is what makes it work) — no divergence today, exactly the "latent" framing.

### [JITRL-8] verdict: CONFIRMED-DOWNGRADED (P3)
- Re-check evidence:
  - The quoted condition is real: runtime-control.ts:436-438 `if (grant.sessionId !== undefined &&
    sessionId !== undefined && grant.sessionId !== sessionId) { continue; }`.
  - BUT round-1's example is refuted by code round-1 did not cite: for a session-ONLY grant
    (`grant.branchId === undefined`) and a request carrying a branchId, lines 430-434 return
    `denied('session-cannot-authorize-branch')` — a strict, counted denial
    (`counters.sessionCannotAuthorizeBranch`, 320-322). A request with neither branchId nor
    sessionId is denied at 407-411. Therefore the only reachable fail-open shape is a COMPOUND
    grant (`grant()` accepts both, 356-379): grant `{branchId: 'b1', sessionId: 's1'}` +
    request `{branchId: 'b1'}` (no sessionId) skips the session check at 436 and is ALLOWED.
  - No shipped caller creates sessionId-bearing grants: the only production `authorize()` call site
    is real-benefit-controller.ts:1271-1277, which grants `branchId` only. (Round-1's "no call site
    is wired" is now slightly stale — the r3a controller does call it — but with branch-only grants
    the session gap is unreachable there.) Dormant P3 stands with the corrected trigger condition.

### [JITRL-9] verdict: CONFIRMED (P3)
- Re-check evidence: backfill.ts:134 docstring "Number of records the store accepted (0 when the
  append failed)" vs 505-516 `await options.store.append(records); appended = records.length;`;
  module header line 22 "second backfill produces the same ids and the store keeps a single copy";
  `ExperienceIndex.insert` is insert-or-replace by id (experience-store.ts:946). Accumulated into
  `backfilled` at jitrl/index.ts:359. On a re-run every id dedupes yet `appended === recordCount`.

### [JITRL-10] verdict: CONFIRMED (P3)
- Re-check evidence: commands.ts:392-401 — the guard fires only when `parsed.bucket === undefined &&
  !parsed.confirm`; `reset bucket-a` without `--confirm` proceeds to `controller.reset(parsed.bucket)`
  (402). Usage (commands.ts:101) `reset [bucket] [--confirm]` does not mark when `--confirm` is
  required. Design-judgment finding; all factual claims check out.

## New findings spotted during verification

1. **Offline gate judgment and the production gate read different histories for the same pool**
   (observation supporting JITRL-1's corrected reachability). The rev6 eval script pushes every
   prior record into the G-A/G-B history regardless of eligibility
   (scripts/eval/rev6-jitrl-intervention.mjs:275-282), while the production reader filters out
   `learningEligible === false` records first (src/orchestrator.ts:2196-2198). Numbers produced by
   the script's semantics (e.g. a future-pool fail→pass admission) can therefore overstate what a
   live gate would do over the same records; conversely, the result doc's 0/180 current-run numbers
   are unaffected (those hinge on the current run's own missing verdict). Any future result doc that
   quotes the script's admission counts over an audited pool should state which history filter was
   in force.

2. **Facade version-stamping quietly qualifies host-tool records into the writeback history**
   (observation). The kernel facade stamps `experienceSchemaVersion: 2` (+ current reward/provenance
   versions) onto unstamped records at append time (src/jitrl/index.ts:276-287), which means
   host-tool L3 records — which never set `learningEligible` and carry no `verificationVerdict`
   mark — pass all three filters in `readWritebackHistory` (orchestrator.ts:2193-2206) and become
   verdict-less history entries (`verified: false, counterexample: false`) for their actionKeys.
   Impact is bounded by actionKey-space overlap with judged meta/proposal keys (usually disjoint:
   `meta:*` vs tool-name keys), but the gate's `support`/`verifiedRate` denominators for a shared
   actionKey would silently include tool observations.

3. **`x-api-key: AKIA…` header form is fully consumed (no leak) but only by accident** (minor,
   related to JINFRA-1). In `x-api-key: AKIAIOSFODNN7EXAMPLE` the leftmost match wins: `keyword_secret`
   starts at `api-key` (index 2) before `aws_access_key` can start at `AKIA`, so the whole value is
   consumed. Fine here — but it shows the combined matcher's leftmost-alternative semantics are
   load-bearing for correctness of shapes that round-1's fix suggestion ("re-scan pass with the
   bearer pattern") must preserve.
