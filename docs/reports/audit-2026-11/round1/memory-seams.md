# Audit scope: memory-bridge + cordis-seams

## Verified facts summary (2-5 lines)
Audited all of `src/memory-bridge/` (incl. `drivers/`) and `src/cordis-seams/` against the repo's claims (client-side namespace isolation, governance gate, reversible eight-surface editing, LIFO disposal). The governance pre-write gate is a real single choke point (no bypass path found; `driver.commit` is only reachable through `bridge.commit`/`bridge.promote`, both gated), and the seam layer's mount/rollback machinery is correct in order and idempotence (verified by code trace + tests). Real defects found: a fail-open namespace-attribution hole that lets untagged foreign lesson documents surface across sessions/branches (verified end-to-end through the bridge), a schema-violating array namespace filter sent by four drivers, a namespace-less `stg` timeline fallback in the lingshu driver, rendered-form codec roundtrip corruption (the lingshu native path stores only the rendered form), a TOCTOU bypass of `maxConcurrentBranches`, duplicate-branchId namespace collisions, and a silent TTL lapse that re-opens the branch tool allowlist. Every finding below was verified by code trace; the runtime-behavior findings (MEM-1/4/5/6) were additionally reproduced with throwaway probes against the actual sources.

## Findings

### [MEM-1] Untagged foreign lesson documents are attributed to the requested namespace and surface across sessions/branches (P1)
- File: src/memory-bridge/lesson-codec.ts:674-679 (with src/memory-bridge/drivers/shared.ts:113-116 and src/memory-bridge/governance-polyfill.ts:346-351)
- Evidence:
  ```ts
  // lesson-codec.ts, collectLessonRecords.addFromText — hint/default both = the REQUESTED namespace
  const namespace =
    emptyToUndefined(parsed.namespace) ??
    emptyToUndefined(inheritedNamespace) ??
    emptyToUndefined(options.namespaceHint) ??
    emptyToUndefined(options.defaultNamespace) ?? '';
  ```
  ```ts
  // drivers/shared.ts, recordsFromPayload — every driver passes the requested namespace as hint AND default
  const records = collectLessonRecords(payload, {
    namespaceHint: input.namespace,
    defaultNamespace: input.namespace
  });
  ```
  ```ts
  // governance-polyfill.ts, isLessonVisibleInScope — a record whose namespace matches the branch scope
  // is visible WITHOUT consulting lesson.sessionId / branchId metadata (that check exists only in the
  // no-namespace fallback at :368-370)
  if (scope.kind === 'branch' && namespaceIsBranch(record, namespacePrefix, scope.sessionId, scope.branchId)) {
    return { visible: true, detail: 'branch-private record of this branch' };
  }
  ```
- Analysis: For namespace-blind backends (graph_entity searches the whole store; mocks show `search_nodes` returning every entity regardless of query), isolation relies on the inline `[SCOPE:...]` tag / frontmatter namespace written by this bridge. When the backend returns lesson-shaped text that carries NO tag and NO enclosing namespace metadata (a lesson written by another deployment, an older untagged version, or a hand-written note that parses as a lesson), `collectLessonRecords` attributes it to the *requested* namespace via `namespaceHint`/`defaultNamespace`. `isLessonVisibleInScope` then sees a record whose namespace equals the scope's branch namespace and returns `visible: true`, ignoring the lesson's own `sessionId` metadata, which the firewall only checks in the no-namespace fallback branch. Reproduced end-to-end with a probe: a rendered lesson with `sessionId: 's-1'` seeded in the mock under `harness2:branch:s-OTHER:b-OTHER` but returned as untagged text was surfaced by `bridge.recall({ scope: {kind:'branch', sessionId:'s-2', branchId:'b-9'} })` with zero suppressions. The mirror case has the same shape: when `record.namespace` is present, lesson-level scope metadata is never cross-checked (e.g. a `branch_private`-visibility lesson misfiled under a `global` namespace is visible everywhere via the `tier === 'global'` short-circuit at :337-341). Rated P1, not P0: the bridge's own writes are always tagged, so the leak requires foreign/untagged lesson-shaped content from the backend — but that is exactly the content the client-side firewall exists to police.
- Fix: In `applyPostRecallFirewall`/`isLessonVisibleInScope`, enforce the lesson-level scope metadata even when the record namespace matches the scope (a lesson legitimately written into a branch namespace always carries that scope's `sessionId`, so requiring `lesson.sessionId === scope.sessionId` for session/branch tiers breaks nothing). Optionally, mark records attributed via `namespaceHint`/`defaultNamespace` (no tag, no inherited namespace) as unverified-origin and restrict them to `global`-visibility lessons only.

### [MEM-2] Lingshu `stg` timeline fallback recalls with no namespace argument, pulling cross-namespace records into the recall set (P2)
- File: src/memory-bridge/drivers/lingshu-mdcg.driver.ts:84
- Evidence:
  ```ts
  if (context.hasTool('stg') && binding.recall !== 'stg') {
    try {
      const timeline = await context.call('stg', { op: 'timeline', limit: input.limit });
  ```
- Analysis: The primary recall call is namespace-scoped (`args[fields.namespace] = scopeArg` at :60-75, for `cg` op=route, `stg` op=timeline, and `mdcg_recall` alike). The supplemental `stg op=timeline` fallback sends only `{ op, limit }` — no namespace, no group filter — so it queries the timeline across all sessions. Records are then attributed by `recordsFromPayload(..., { namespace: input.namespace })` (shared.ts), i.e. the same fail-open attribution as MEM-1. Tagged lessons are filtered client-side, but any untagged lesson-shaped timeline content from another session is attributed to the current branch namespace and can pass the firewall. The unit mock (`tests/unit/memory-bridge/mocks/mock-mcp.ts:545`) models `stg` as returning the whole store with no namespace field, which silently endorses this unscoped query.
- Fix: Pass the namespace scope to the fallback call (`{ op: 'timeline', limit, namespace: scopeArg }`, plus `group_ids` when declared, matching the temporal driver), and drop records the backend returns outside `input.namespaces`.

### [MEM-3] Drivers send the namespace filter as an array for branch/session scopes, violating the declared scalar schema (P2)
- File: src/memory-bridge/drivers/vector-fact.driver.ts:78 (also temporal.driver.ts:54, custom-mapped.driver.ts:62, lingshu-mdcg.driver.ts:60)
- Evidence:
  ```ts
  // vector-fact.driver.ts recall
  args[fields.namespace] = input.namespaces.length > 1 ? [...input.namespaces] : primary;
  // the mocked mem0-style server itself declares user_id as a scalar:
  // { name: 'search_memory', inputSchema: props({ query: 'string', user_id: 'string', ... }) }  (mock-mcp.ts:381)
  ```
- Analysis: For a branch scope `visibleNamespaces()` returns three namespaces, so every recall/commit filter field resolved as `user_id`/`group_id`/`namespace` receives a JSON array. `resolveFields` matches property *names* only, never the declared type, so a tool that declares `user_id: string` (the common mem0/supermemory shape, including the repo's own mock schema) is handed an array. A strict backend rejects the call → every probe recall degrades to empty memory; a lenient backend ignores the malformed filter and returns everything, which combined with MEM-1 turns into a leak. The unit mocks are array-tolerant in `namespacesFromArgs` (mock-mcp.ts:250-278), so the suite cannot catch this. This affects the most common probe case (branch scope), not an edge case.
- Fix: Inspect the declared property type in `resolveFields` (the schema is already available in `context.schemaProperties`); send a scalar (e.g. the primary namespace) when the property is `string`-typed, and use the array only when the tool declares an array-typed field (as the temporal driver already does separately for `group_ids` at temporal.driver.ts:55-57).

### [MEM-4] Rendered-form codec roundtrip corrupts lessons on the lingshu native path, including a phantom `whenNotToApply` clause injected from `executionPatch.summary` (P2)
- File: src/memory-bridge/lesson-codec.ts:498-554 (parseRenderedLesson; render side at :116-151)
- Evidence:
  ```ts
  // parseRenderedLesson — fractional metricsDelta truncates, evidence captures one line only
  const stepsDiff = Number.parseInt(/stepsDiff=(-?\d+)/.exec(deltaLine)?.[1] ?? '0', 10);
  const referenceFailure = firstMatch(verificationLines, /参考分支失败[:：]\s*(.*)$/);
  ```
  Reproduced with a probe against the real sources (write `renderLessonMarkdown` -> read `parseRenderedLesson`, the exact pair `renderLingshuWriteText`/recall uses):
  - `metricsDelta {stepsDiff: 1.5, toolErrorsDiff: -2.5}` -> recalled as `{stepsDiff: 1, toolErrorsDiff: -2}`;
  - `referenceFailure: 'line one\nline two'` -> recalled as `'line one'` (candidateSuccess likewise);
  - `whenToApply: ['cue line1\ncue line2']` -> recalled as two clauses `['cue line1','cue line2']`;
  - a summary containing a heading (`'do it\n## 不适用条件 / whenNotToApply\ninjected'`) -> summary truncated to `'do it'` and `whenNotToApply` recalled as `['injected','restraint']`.
- Analysis: `lingshu-mdcg.driver.ts:36-38/106` stores ONLY the rendered Markdown (no frontmatter) via `renderLingshuWriteText`, so for driver 5 the rendered roundtrip is the storage format, not a best-effort view — every asymmetry above is real data corruption on write->recall. The heading case is worst: recall reconstructs a lesson with an extra restraint clause that the pre-write gate never validated, so the negative firewall can veto the lesson on recall based on clause text that exists only as a serialization artifact of `executionPatch.summary`. The frontmatter envelope path is genuinely lossless (verified: fractional deltas survive), so the module header's "round-trips are lossless" claim holds only there.
- Fix: In `renderLessonMarkdown`, escape/sanitize multi-line values (indent continuation lines so they cannot look like headings/bullets) and serialize `metricsDelta` with a lossy-proof format (e.g. `JSON.stringify` inside the trailer or the frontmatter block also for the rendered form); in `parseRenderedLesson`, stop treating `## `-prefixed lines inside the executionPatch section as section switches once a diffKey/summary accumulation started, or reject lessons whose summary renders to a different parse than the original.

### [MEM-5] `maxConcurrentBranches` is bypassed by simultaneous calls (check-then-await TOCTOU) (P2)
- File: src/cordis-seams/seam-manager.ts:234-239, 248, 261
- Evidence:
  ```ts
  if (this.activeBranches.size >= this.maxConcurrentBranches) {   // checked BEFORE any await
    throw new CordisSeamError('Concurrent probe branch limit ...', ...);
  }
  ...
  resources = await createIsolatedBranch({ ... });                 // suspends here
  ...
  this.activeBranches.set(branchId, { ... });                      // slot claimed only AFTER the await
  ```
- Analysis: Between the size check and the `activeBranches.set` there is an `await`, so N simultaneous `runInIsolatedBranch` calls all observe the pre-await size and all proceed. Reproduced with a probe: with `maxConcurrentBranches: 1`, two calls fired in the same tick both executed their executors (`entered executors: 2`). The existing test (`seam-manager.test.ts:191-221`) only passes because it awaits the first executor's `started` signal — i.e. after the first branch has already registered — before firing the second call. Over-commit breaks the documented concurrency cap and, with MEM-6, multiplies shared-namespace exposure.
- Fix: Reserve the slot synchronously before the first await (e.g. insert a placeholder record or increment a counter immediately after the limit check, rolling it back in the catch/finally if `createIsolatedBranch` or mounting fails).

### [MEM-6] A caller-supplied duplicate `branchId` gives two concurrent probes the same namespace and one activeBranches slot (P2)
- File: src/cordis-seams/seam-manager.ts:207-211, 261
- Evidence:
  ```ts
  const branchId =
    request.branchId !== undefined && request.branchId.length > 0
      ? request.branchId
      : this.createBranchId();
  const namespace = buildBranchNamespace(this.namespacePrefix, branchId);
  ...
  this.activeBranches.set(branchId, { ... });   // same key overwrites the first branch's record
  ```
- Analysis: Unlike the minted ids (`createBranchIdFactory` is monotonic + random), a caller-provided `branchId` is accepted with no uniqueness check against `activeBranches`. Reproduced with a probe: two concurrent `runInIsolatedBranch` calls with `branchId: 'dup-branch'` both reported `namespace: 'harness2:probe_dup-branch'` and the same `branchId` in their `IsolatedBranchContext`. Consequences: (a) memory written under the branch namespace is shared by both probes — the branch isolation that `deriveNamespace`/`buildBranchNamespace` exist to guarantee collapses; (b) the second `activeBranches.set` overwrites the first record, so `listActiveBranches()` under-reports and `dispose()`/cleanup of one branch tears down shared bookkeeping for both; (c) the host `forkBranch`/`acquireSandbox` receive the same `branchId`/`namespace`, so any host-side per-branch state collides too. This is the concrete "state bleeding between forks" vector in context-forker/seam-manager; no other bleed path was found (patches are per-branch deep-cloned+frozen, abort controllers and registries are per-branch — pinned by seam-manager.test.ts:260-284).
- Fix: In `runInIsolatedBranch`, reject (or mint a fresh id for) a `request.branchId` that is already present in `activeBranches`; the namespace is a pure function of branchId, so uniqueness of the id is the only thing to enforce.

### [MEM-7] Tool-face allowlist silently lapses after its TTL, re-opening the branch (fail-open `no-policy`) (P2)
- File: src/cordis-seams/tool-face.ts:335-339 (with :152, :181-192, :270)
- Evidence:
  ```ts
  const policy = policyForInternal(branchId);
  if (policy === undefined) {
    counters.noPolicy += 1;
    return { allowed: true, code: 'no-policy', toolName, branchId };   // allowed=true
  }
  ...
  const ttl = typeof spec.ttlMs === 'number' && spec.ttlMs > 0 ? spec.ttlMs : defaultTtlMs;  // 30 min default
  ```
- Analysis: `policyForInternal` lazily deletes an expired policy; the next `decide()` then falls into the `no-policy` branch, which returns `allowed: true`. The seam manager installs the policy once per probe (`seam-manager.ts:315-318`) with the default 30-minute TTL and never renews it; a probe without an explicit timeout (`defaultTimeoutMs`/`request.timeoutMs` are optional) that runs past 30 minutes loses its allowlist mid-run with no diagnostic on the run path (only an aggregate `expiredPolicies` counter). The `no-policy => allow` default is documented for branches that never had a policy, but here it converts a *configured* allowlist into an open one for the remainder of the branch. The module's own header claims the fence is fail-closed inside a branch; the TTL lapse is a fail-open exception to that claim. (Same `allowed: true` also applies between `createIsolatedBranch` and `toolFace.install`, but that window is synchronous.)
- Fix: Have the branch own the policy lifetime — pass `ttlMs` derived from the probe timeout (plus margin), or remove expiry for probe-installed policies and rely on the guaranteed `finally` removal at seam-manager.ts:328-337; alternatively return `allowed: false` for an expired-policy branch id that the manager still lists as active.

### [MEM-8] `bridge.isolate()` handle accounting breaks when the same scope is isolated twice (P3)
- File: src/memory-bridge/bridge.ts:305-324
- Evidence:
  ```ts
  handles.set(namespace, handle);            // keyed by namespace: a second isolate() overwrites the first
  ...
  async release(): Promise<void> {
    if (!state.active) { return; }
    state.active = false;
    handles.delete(namespace);               // removes the OTHER (still-active) handle's entry
  }
  ```
- Analysis: Two `isolate()` calls for the same scope produce two handles mapped to one key. Releasing only the first handle deletes the shared map entry while the second handle still reports `active === true`, so `activeNamespaces()` claims the namespace is released while a live handle believes otherwise. No memory data is affected (the namespace itself is unaffected), but the diagnostic accessor lies and the second handle's later release is a no-op delete.
- Fix: Store a refcount or a set of handles per namespace and only delete the entry when the last handle releases (or refuse/isolate-idempotently-return the existing handle for a duplicate namespace).

### [MEM-9] `promote()` skips the source-copy prune whenever `capabilities.namespaces` is false, even for drivers that can prune by namespace-derived path (P3)
- File: src/memory-bridge/bridge.ts:406 (with src/memory-bridge/drivers/markdown-note.driver.ts:47-53, :119-140)
- Evidence:
  ```ts
  // Remove the branch/session copy so the winning lesson exists only globally.
  if (from.kind !== 'global' && result.driver.capabilities.namespaces) {
  ```
- Analysis: `markdown_note` declares `namespaces: false` but its `prune` deletes by `notePath(namespace, id)` — it can remove exactly the source copy. After a promote on a markdown-note backend, the lesson therefore exists in both the branch namespace and the global namespace; on the next branch recall both copies parse and the firewall's `seen` id-dedupe (governance-polyfill.ts:627-630) keeps whichever the driver returned first, silently discarding the other (including its possibly different `promotedFrom` metadata). For graph_entity (no delete-by-id without the entity name it can reconstruct) the gate is reasonable; for markdown_note it is not. The header comment "the branch copy is pruned when supported" is contradicted for this driver.
- Fix: Gate the prune on actual capability (`binding.prune !== undefined` plus a per-driver "can prune by namespace" signal), or let each driver decide and return `removedIds` — the markdown-note driver can already compute `notePath(fromNamespace, lessonId)`.

### [MEM-10] `MemoryCommitOptions.enforceGovernance` is declared and passed but never read — the contract option is dead (P3)
- File: src/types/contracts.ts:599, src/memory-bridge/bridge.ts:205-303 (commit reads only `options.dryRun`), src/orchestrator.ts:3664
- Evidence:
  ```ts
  export interface MemoryCommitOptions {
    readonly scope: MemoryScope;
    readonly enforceGovernance?: boolean;   // never referenced by any implementation
  ```
- Analysis: The bridge's commit always runs `validateLessonForWrite` and never consults `enforceGovernance`. This is fail-closed (a caller passing `false` cannot bypass the gate — good), but the option is a misleading contract surface: the orchestrator passes `enforceGovernance: true` as if it were meaningful, and a future reader could reasonably assume `false` is honored. Grep confirms no implementation or test asserts its effect.
- Fix: Either delete the field from `MemoryCommitOptions` (and the orchestrator call site), or implement it explicitly as "may only downgrade the completeness severities in the same way `enableGovernancePolyfill: false` does, never the block-class scope/script rules" with a test.

### [MEM-11] DisposableRegistry has no deadline: one hung disposer stalls the single LIFO unwind that everything depends on (P3)
- File: src/cordis-seams/disposable-registry.ts:36-53, 111-130 (consumer: src/cordis-seams/seam-manager.ts:338-352)
- Evidence:
  ```ts
  try {
    if (typeof target === 'function') { await target(); } else { await target.dispose(); }
    return null;
  } catch (error) { return { label, error }; }   // catches throw, never timeout
  ```
- Analysis: The registry's stated purpose is that "success, failure, timeout and abort all unwind through one code path", and `runInIsolatedBranch`'s `finally` awaits `resources.dispose()` before the trajectory can finalize. A disposer that never settles (e.g. a host seam disposal awaiting a wedged child context — the same failure mode `callToolWithTimeout` exists for on the memory side) blocks the whole unwind forever: the branch's resources after the hung one are never disposed, `activeBranches` never shrinks, and the probe promise never resolves. Failure *counting* is robust; time is unbounded.
- Fix: Race each `disposeEntry` with a (configurable, default generous) deadline that converts a hang into a `DisposalFailure` and continues the LIFO pass, mirroring `callToolWithTimeout` in src/memory-bridge/spi.ts:235-307.

### [MEM-12] TrajectoryCollector `finalize` merges executor data inconsistently: steps are replaced, tool errors/signals are concatenated (P3)
- File: src/cordis-seams/trajectory-collector.ts:283-292
- Evidence:
  ```ts
  const steps = result !== undefined && result.steps !== undefined ? reindexSteps(result.steps) : reindexSteps(this.steps);
  const toolErrors =
    result !== undefined && result.toolErrors !== undefined
      ? [...this.toolErrors, ...result.toolErrors]      // concatenated
      : [...this.toolErrors];
  ```
- Analysis: When both sources carry data, collector-recorded steps are silently dropped while collector-recorded toolErrors/failureSignals survive — `metrics.steps` and `metrics.toolErrors` then describe different event sets (and can even double-count a tool error that the executor's steps also contain). Today this is latent: the only production step producer (`src/dsh-bridge/agent-loop-executor.ts:680-763`) builds its result from its own collector's finalized trajectory, and the seam-manager's collector records no steps, so the two sources never diverge. Rated P3 because the merge policy is provably asymmetric in code and any future executor that both appends steps to the passed-in collector and returns steps will lose events without an error.
- Fix: Merge steps deterministically too (concatenate then `reindexSteps`, or assert `this.steps.length === 0` when `result.steps` is present) so metrics always cover the union of observed events.

## Positive verifications

### [OK-1] Eight-surface mounting and rollback are correct in order, reverse order, and idempotence — the "reversible" headline holds in this layer
Verified by trace and by tests. `mountEightSurfaces` mounts strictly in `HARNESS_COMPONENT_KEYS` order, registers each handle into the caller's registry, and on a mid-way failure calls `rollbackMounts(handles)` which disposes in reverse index order and reports (never swallows) failures before rethrowing the original error (src/cordis-seams/eight-surfaces.ts:411-438, 360-376). `DisposableRegistry.disposeAll()` disposes a reverse snapshot LIFO, is idempotent via the `released` order-set, continues past individual failures, and makes post-disposal registration throw instead of leak (src/cordis-seams/disposable-registry.ts:111-158; tests/unit/cordis-seams/disposable-registry.test.ts:9-95). `applyPermanentPatch` deletes its record and rolls back the whole registry on partial mount failure, and its disposer is idempotent (src/cordis-seams/seam-manager.ts:504-543; tests/unit/cordis-seams/seam-manager.test.ts:343-358). The hook-adapter mount surface is trivially reversible (mounts live in an adapter-local array; dispose splices exactly one mount and unregisters scope entries, src/cordis-seams/dsh-hook-host-adapter.ts:1661-1729), and patch data is deep-cloned + deep-frozen per branch so concurrent branches cannot alias edits (src/cordis-seams/patch-utils.ts:39-64; pinned by seam-manager.test.ts:260-288).

### [OK-2] The governance pre-write gate is a genuine single choke point; no bypass path exists
`driver.commit` is reachable only from `bridge.commit` and `bridge.promote` (grep over src/), and both run `validateLessonForWrite` before any backend call, before `initialize()`, and before `dryRun` short-circuiting (src/memory-bridge/bridge.ts:220-249, 344-362). The gate rejects non-object payloads, empty CCG elements, unknown harness surfaces, embedded-script syntax/path violations, scope/namespace contradictions and negative-polarity recommendation leaks with `severity: 'block'`, and `governance-gate.test.ts:66-74` asserts `server.calls` and even `listToolsCalls` remain 0 for every rejection — i.e. "no network call before the gate" is enforced, not just claimed. Config downgrades (`enableGovernancePolyfill: false`, `requireEvidence: false`) only ever downgrade the designated completeness/evidence severities to warnings; scope, script-syntax and polarity rules stay blocking in all configurations (src/memory-bridge/governance-polyfill.ts:83-227).

### [OK-3] ADR 0006 fail-closed mount-scope authority is implemented as documented, and the production path cannot produce the legacy class
`hookScopeMatches` defaults an unclassified mount to `'branch'` (fail-closed; a dispatch with no proven branchId never matches a probe mount, and sessionId never substitutes for branch identity), `'host'` requires a non-empty `hostScopeGrant` and is the only identity-free channel, and `'legacy-host-local'` exists only as an explicit, counted opt-in (src/cordis-seams/dsh-hook-host-adapter.ts:316-352, 1253-1305). `mountEightSurfaces` callers always declare the class — probes pass `mountScope: 'branch'` and the permanent-patch path passes `mountScope: 'host'` with a grant (src/cordis-seams/seam-manager.ts:292, 499-501) — and the suppressions are counted per dispatch x mount (`sessionOnlySuppressed`/`anonymousSuppressed`/`deniedRulesSuppressed`), asserted in tests/unit/seams/mount-scope-isolation.test.ts:97-236 including the shared-session sibling case.

### [OK-4] ADR 0007's claims about the hook adapter channels match the code (line anchors drifted, substance intact)
The ADR states post-execute is observation-only, pre-step advisory only appends to `additionalContexts`, and gate mode can only forward `{ kind: 'ask' }`, never deny. The current code confirms each: the post-execute listener returns the host decision untouched and only forwards a structured observation to the sink (src/cordis-seams/dsh-hook-host-adapter.ts:1529-1560); the pre-step advisory path appends `verdict.text` to `additionalContexts` without rewriting messages or the step decision (:1561-1605); the gate path returns `{ kind: 'ask', ... }` and every other outcome falls through to the host decision, with deny/cancel from below never overridden (:1450-1527, `isBlockingDecision` at :1187-1193). The ADR's cited line ranges (:1139-1196, :425-428) no longer align with the current file — a documentation-drift nit, not a behavioral defect.
