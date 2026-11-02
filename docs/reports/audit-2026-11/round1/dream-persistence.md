# Audit scope: dream-rsi + persistence

## Verified facts summary (2-5 lines)

Audited all 7 files in `src/dream-rsi/` and 4 in `src/persistence/` against `tests/unit/dream-rsi/*`, `tests/unit/persistence/*`, ADR 0004 §4 and `docs/reports/t9-pr4b-holdout-verification.md`. The PR-4B holdout split and the replay core are genuinely leakage-safe and deterministic; the t9 report accurately describes the shipped code. Real defects found: a deterministic cross-restart data-loss path in the persisted tree pool (process-local ids + upsert-by-id), a Windows-specific silent-divergence hole in the atomic-write path, an unguarded parent-chain walk that hangs on cyclic snapshots, and a mid-run policy-version skew window between `planGrid` and `selectBatch`. Lower-severity items: efficiency-signal saturation, NaN tie-break poisoning, audit-timestamp mutation, over-broad temp-file sweep, and one documented ADR deviation.

## Findings

### [DREAM-1] Restarted host reuses process-local tree ids and destroys persisted discovery trees (P1)
- File: src/orchestrator.ts:976, src/orchestrator.ts:1029, src/orchestrator.ts:1314, src/orchestrator.ts:1941; src/index.ts:2028-2031; src/persistence/tree-pool.store.ts:474-493
- Evidence:
  ```ts
  // orchestrator.ts:976,1029
  private count = 0;
  this.newId = deps.newId ?? ((): string => 'run-' + String(this.count + 1));
  // orchestrator.ts:1314,1941
  id: 'tree-' + runId,
  ...
  this.treePool.add(tree.snapshot());
  // index.ts:2028-2031 (production newId)
  let sequence = 0;
  const newId = options.newId ?? ((): string => { sequence += 1; return 'evo-' + String(sequence); });
  // tree-pool.store.ts:476-484
  if (existing !== undefined && !sameTreeSnapshot(existing, tree)) {
    this.store.noteDiagnostic('persistence: tree id collision for ' + tree.id + '; ...');
  }
  this.base.add(tree);   // upsert: the new snapshot wins
  ```
- Analysis: The durable task counter (`taskCounter: persistence.policyStore`, wired at src/index.ts:2217) survives restarts, but it is used only for `shouldDream` (src/orchestrator.ts:3738-3747). Neither the orchestrator's `count` nor the plugin's `newId` sequence is seeded from it, so after every process restart ids restart at `evo-1`/`run-1` and tree ids restart at `tree-evo-1`. The first completed task on the restarted host calls `treePool.add()` on a `PersistentTreePool` whose persisted log still contains a different tree with that same id. `sameTreeSnapshot` is false (different task/session content), a diagnostic is noted, and the persisted tree is overwritten ("the new snapshot wins"). This is deterministic loss of the dreamer's replay corpus on every restart that completes at least as many tasks as the previous process; the store comment acknowledges the scenario ("A restarted host whose id factory restarts at 1 would otherwise silently destroy a persisted tree; report it instead of hiding the overwrite") but only reports, does not prevent.
- Fix: Seed the id sequence from durable state at startup (e.g. initialize `sequence`/`count` from `policyStore.counters.completedTasks`, or mix a per-boot random/session token into `newId`, or include `sessionId` in the tree id, e.g. `'tree-' + sessionId + '-' + runId`). Alternatively make `PersistentTreePool.add` refuse same-id-different-snapshot upserts unless the incoming snapshot's `createdAt` is newer.

### [DREAM-2] Atomic write has no Windows rename retry, and store write queues swallow the failure into a diagnostic — in-memory and disk state silently diverge (P2)
- File: src/persistence/data-dir.ts:152-178 (rename at :171); src/persistence/policy.store.ts:424-432; src/persistence/tree-pool.store.ts:373-379
- Evidence:
  ```ts
  // data-dir.ts
  await handle.sync(); ... await fs.rename(temp, filePath);   // no retry, no EPERM handling
  // policy.store.ts:424-429
  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task).catch((error) => {
      this.pushDiagnostic('persistence: policy store write failed: ' + ...);
    });
  ```
- Analysis: The module comment claims MoveFileExW/MOVEFILE_REPLACE_EXISTING "also replaces an existing target". That is only true while no other handle holds the target without FILE_SHARE_DELETE. Measured on this host (win32): `fs.promises.rename(temp, target)` fails with `EPERM` while a plain read handle (`fs.promises.open(target, 'r')`) is open on the target — a window that antivirus/indexer scans and concurrent readers realistically hit. When that happens, `writeFileAtomic` cleans up the temp file and throws; the stores' `enqueue` catch converts the throw into a diagnostic string and a *resolved* promise, so `saveCurrent`, `recordCompletedTask`, `append`, and `PersistentActivePolicy.update` all report success without persisting. On restart the host silently resumes from the stale previous state (policy reverts, dream cadence counter rolls back). On POSIX the same sequence succeeds, so the defect is Windows-specific and invisible to the POSIX-run test suite.
- Fix: Add a bounded retry with backoff around `fs.rename` for `EPERM`/`EACCES` (transient sharing violations), and/or propagate write failures to the awaiting caller (or expose a `lastWriteFailed` flag) instead of only pushing a diagnostic, so the durability contract is observable.

### [DREAM-3] `ancestorsOf`/`causalPrefix` walk parent links with no cycle guard; snapshot rebuild accepts cyclic graphs and hangs the event loop (P2)
- File: src/dream-rsi/discovery-tree.ts:433-446 (loop at :436), src/dream-rsi/discovery-tree.ts:523-546; src/persistence/tree-pool.store.ts:132-162
- Evidence:
  ```ts
  // discovery-tree.ts:433-446
  ancestorsOf(nodeId: string): readonly DiscoveryNode[] {
    let current = this.requireNode(nodeId);
    const chain: DiscoveryNode[] = [];
    while (current.parentId !== null) {          // no visited-set, no depth cap
      const parent = this.nodes.get(current.parentId);
      if (parent === undefined) { break; }
      chain.push(toDiscoveryNode(parent));
      current = parent;
    }
  ```
- Analysis: `addNode` cannot create a cycle (the parent must exist before the child and cannot be the node itself), but `treeFromSnapshot` rebuilds from an arbitrary `DiscoveryTreeSnapshot` — the exact shape `tree-pool.jsonl` persists — and validates only that the root exists and each node is structurally valid (`isDiscoveryTreeSnapshot` checks fields per node; it never checks acyclicity or parent/childIds consistency). A snapshot with `a.parent = b`, `b.parent = a` passes validation, and any later `causalPrefix`/`ancestorsOf` call (including the `ReplayPrefixViewImpl` constructor at :592, which calls `tree.causalPrefix(anchorNodeId)`) spins forever, hanging the host. Currently latent — the offline dreamer replays via `childrenOfSnapshot` (children only) and no src caller invokes `treeFromSnapshot` on restored trees — but the API is exported as the documented replay entry and the pool store is its data source.
- Fix: Track a visited set (or a depth cap at `nodes.size`) in `ancestorsOf` and throw `UnknownDiscoveryNodeError`/a dedicated cycle error; additionally validate acyclicity (and `childIds`/`parentId` consistency) in `treeFromSnapshot` or in `isDiscoveryTreeSnapshot`.

### [DREAM-4] Policy-version skew window: `planGrid` runs on `request.policy`, `selectBatch` re-reads `this.current` after an await, with no consistency guard (P2)
- File: src/dream-rsi/active-policy.ts:419-424, :531-532; src/orchestrator.ts:1289, :1332, :1404; src/dream-rsi/offline-dreamer.ts:2353-2355
- Evidence:
  ```ts
  // active-policy.ts:419-420 (planGrid)
  planGrid(request: PlanGridRequest): SearchGridPlan {
    const policy = request.policy;
  // active-policy.ts:531-532 (selectBatch)
  selectBatch(request: SelectBatchRequest): BatchPlan {
    const policy = this.current;
  ```
- Analysis: In the orchestrator lifecycle, `planGrid` (orchestrator.ts:1289) is followed by an awaited reference probe (`runInIsolatedBranch`, :1332) and only then by the per-round `selectBatch` (:1404). A policy hot-swap that lands in that window — e.g. the idle dream trigger (`registerDshTriggers` dream path → `orchestrator.triggerDream` → `dreamer.replay` → `applyPolicy` → `activePolicy.update`, offline-dreamer.ts:2353-2355) firing while a run is in flight — makes every subsequent round of the in-flight run slot its batch with the *new* policy's `slotWeights` while the grid's width/depth/budget caps come from the *old* `runPolicy`. `selectBatch` records `policyId` from the grid but never checks `grid.policyId`/version against `this.current`, so the mixed state is untracked (and `PersistentActivePolicy.update` fires the persistence queue asynchronously, widening the window). Single-threaded JS prevents tearing within a synchronous section, but the await boundary is real and unpinned by any test.
- Fix: In `selectBatch`, either adopt `request.grid`'s policy wholesale when `grid.policyId` matches no current policy, or assert/stamp a diagnostic when `grid.policyId !== this.current.id@version`, so a mid-run swap is at least visible (or freeze the run's policy for the run's duration).

### [DREAM-5] Step-efficiency signal saturates at 1.0 for every run at or below the baseline, including zero-work trajectories (P3)
- File: src/dream-rsi/surrogate-scorer.ts:207-232 (formulas at :211 and :222)
- Evidence:
  ```ts
  stepEfficiency = clamp01(referenceSteps / Math.max(1, steps));        // :211
  ...
  stepEfficiency = clamp01((baselineSteps + 1) / (steps + 1));          // :222
  ```
- Analysis: With the default `baselineSteps = 10`, the no-reference branch yields `stepEfficiency = 1.0` for *any* `steps <= 10` — including `steps = 0` (a probe that never ran) and `steps = 10`. The reference branch behaves the same (`referenceSteps / max(1, steps)` clamps to 1 for `steps <= referenceSteps`). The `+1` smoothing intended to avoid division by zero turns the signal into a step function: it cannot distinguish "did nothing" from "did baseline work", and among failed/unselected nodes (where `selection`/`adoption` are 0 and efficiency is the dominant live term) more work strictly lowers the score. Tests pin the current numbers (surrogate-scorer.test.ts:205-218), so this is a designed wart, but it does distort the reward for the failure segment the taxonomy feeds on.
- Fix: Use a monotone non-saturating shape below the baseline, e.g. `steps / (baselineSteps + steps)` (0 at zero work, 0.5 at baseline) or clamp the efficiency credit to 0 for `steps === 0`.

### [DREAM-6] `bestNodeOf` is poisoned by a NaN score: the first NaN-scored node wins over every finite score (P3)
- File: src/dream-rsi/discovery-tree.ts:808-819 (comparison at :814)
- Evidence:
  ```ts
  if (node.score === undefined) { continue; }
  if (best === undefined || (best.score ?? 0) < node.score) { best = node; }
  ```
- Analysis: A node whose `score` is `NaN` passes the `!== undefined` guard and, when encountered first, becomes `best` unconditionally. Every later comparison `NaN < x` is false, so `best` never updates and the helper returns the NaN node even when finite-scored nodes exist. Reachable only via in-memory NaN injection (`updateNode`/`recordProbe` accept any number; JSON cannot carry NaN), hence P3, but the same pattern in `resolveBestNode` (active-policy.ts:767-777) is protected only by `?? 0` on *read*, not on entry. `replayNodeScore` (offline-dreamer.ts:387-395) does the correct `Number.isFinite` check — the helper lacks it.
- Fix: Mirror `replayNodeScore`: skip nodes whose score is not `Number.isFinite`, or sanitize at the `recordProbe`/`updateNode` boundary.

### [DREAM-7] History trim in `recordRevision` re-stamps retained audit records with the current time (P3)
- File: src/persistence/policy.store.ts:322-340 (re-stamp at :332)
- Evidence:
  ```ts
  await writeFileAtomic(this.historyPath, retained.map((entry) =>
    encodeJsonlRecord({ schemaVersion: PERSISTENCE_SCHEMA_VERSION, at: this.now(), policy: entry })
  ).join(''));
  ```
- Analysis: The append-only audit log is described as an "append-only audit log of accepted policy revisions" with each record carrying `at`. When the log exceeds `maxHistory`, the compaction rewrites the retained window and assigns every surviving record a *new* `at: this.now()`, destroying the original acceptance timestamps. After a few trims the log's timeline is fiction. In-memory `historyValue` keeps the policies but also never carried the original `at` (it stores `MetaSearchPolicy[]`), so nothing downstream notices.
- Fix: Carry the original record through the trim (keep `PolicyRevisionRecord[]` in memory instead of bare policies, and rewrite those records verbatim).

### [DREAM-8] `sweepTempFiles` deletes any file whose name contains `.tmp-`, not only this module's temp files (P3)
- File: src/persistence/data-dir.ts:244-267 (match at :256); called from src/persistence/policy.store.ts:246 and src/persistence/tree-pool.store.ts:264
- Evidence:
  ```ts
  for (const entry of entries) {
    if (!entry.includes(TEMP_FILE_MARKER)) { continue; }   // '.tmp-'
    await fs.rm(path.join(dir, entry), { force: true });
  ```
- Analysis: The module's own temp names are `<target>.tmp-<pid>-<hex>`, but the sweep matches the substring anywhere in any name in the profile data directory. An operator- or host-placed file such as `notes.tmp-backup.json` or `report.tmp-final.json` in the data dir is permanently deleted at every store open. The marker is also not anchored to the end of a known target name.
- Fix: Anchor the match to the module's shape, e.g. require the marker to follow a `.` and be followed by `<pid>-<hex>` (`/\.tmp-\d+-[0-9a-f]{12}$/`), or track live temp names in a manifest.

### [DREAM-9] No cross-process discipline: counter updates are in-memory read-modify-write, and JSONL appends can interleave (P3)
- File: src/persistence/policy.store.ts:372-397; src/persistence/data-dir.ts:181-190
- Evidence:
  ```ts
  await this.enqueue(async () => {
    this.countersValue = { ...this.countersValue, completedTasks: this.countersValue.completedTasks + delta, ... };
    await writeFileAtomic(this.countersPath, JSON.stringify(this.countersValue));
  });
  ```
- Analysis: The queue serializes writers *within one process* only. Two hosts sharing a profile data dir each keep their own `countersValue` and atomically overwrite `counters.json` last-writer-wins, so completed-task counts are lost and the dream cadence misfires. Likewise `appendFileDurable` opens the JSONL with `'a'` and calls `handle.writeFile(contents)`, which Node may split into multiple `write()` syscalls for large records; a concurrent appender can interleave between those syscalls, producing torn records (the tolerant reader then drops everything after the tear). The single-host assumption is nowhere stated in the module headers.
- Fix: Document/enforce single-host-per-profile (e.g. a lockfile with pid), and/or route JSONL appends through one exclusive-owner writer; keep JSONL records under the OS pipe-atomicity threshold or write via a single `writev`.

### [DREAM-10] `writeFileAtomic` never fsyncs the parent directory after rename, weakening the stated crash-safety guarantee on POSIX (P3)
- File: src/persistence/data-dir.ts:146-178
- Evidence:
  ```ts
  if (options.fsync !== false) { await handle.sync(); }   // file only
  ...
  await fs.rename(temp, filePath);                        // no dir fsync
  ```
- Analysis: The module header states "every structured write goes to a sibling temp file, is fsynced, then renamed over its target, so a crash can never expose a half-written snapshot". Torn content is indeed impossible, but without `fsync` on the parent directory the rename itself is not durable on POSIX: after a power loss the target can revert to its previous content while the (renamed-away) temp is gone — the write vanishes entirely rather than appearing partially. On Windows, directory fsync is not available via Node, so the gap is POSIX-specific and unobservable in the (passing) test suite.
- Fix: After a successful rename, open the parent directory and `fsync` it (guarded by platform, skipped on Windows), or state the weaker guarantee explicitly in the header.

### [DREAM-11] Code deviates from ADR 0004 §4.4 row 1 as written: hard selection floor is 1, not the ADR's recommended 2 (P3)
- File: src/dream-rsi/offline-dreamer.ts:734-752, :961-969; docs/adr/0004-c2b-trusted-quality-consumption-and-dreamer-holdout.md §4.4 (row "选择集样本量"); tests/unit/dream-rsi/pr4b-holdout.test.ts:335-352
- Evidence:
  ```ts
  export const RECOMMENDED_MIN_SELECTION_TREES = 2;   // advisory only
  ...
  if (selectionTrees.length === 0) { return { status: 'insufficient-selection-trees', ... }; }
  ```
- Analysis: The ADR truth table lists `|T_sel| >= N_sel_min` (建议值 2) with verdict `insufficient-selection-trees`. The code fails closed only at 0 and reports the 2-tree recommendation via `diagnostics.selectionMeetsRecommendedMinimum` (comment at :738-752 explains the authorized positive control — 1 selection + 1 holdout — would be unprovable otherwise). The deviation is deliberate and documented, and `pr4b-holdout.test.ts:335-352` depends on it (2-tree pool → 1-tree selection → `publish: true`), but an auditor reconciling ADR to code should see it recorded: under a strict reading of the truth table, that passing test is a violation.
- Fix: Either amend ADR 0004 §4.4 to state that N_sel_min is 1 hard + 2 recommended (with the positive-control rationale), or enforce the 2-tree floor and rework the positive-control fixture to a 3-tree pool.

## Positive verifications

- **PR-4B holdout leakage prevention is real.** `splitDreamerHoldout` (src/dream-rsi/offline-dreamer.ts:778-977) groups whole tasks (`holdoutGroupKey` = taskId → sessionId → tree id, matching ADR 0004 §4.3-1), sorts groups by a deterministic total order (newest/oldest/key, :612-620), and admits a cut only when `max(selection.createdAt) <= min(holdout.createdAt)` (:867), failing closed as `insufficient-temporal-isolation` otherwise. In `replay()` the split runs before generation (:2187), the generator receives `{ ...request, trees: selectionTrees }` whenever a holdout was requested (:2230-2234), only the winner is replayed on the holdout (:2318-2334, no multiple-comparison overfit), and the PR-4B information-visibility fix is present: the selection cost ceiling is computed from selection runs only (:2268-2273) while the holdout pass computes its own ceiling (:2325-2328), so no holdout-derived statistic enters selection ranking. The t9 report's four claimed repairs (request floor `Math.max(MIN_HOLDOUT_TREES, requested)` at :943, `holdoutShortfall` diagnostics, `holdoutUsable` double-field check at :2201, generator-pool condition `this.holdoutTreeCount > 0`) are all in the shipped code, and the 38-case suite pins them.
- **Replay determinism holds.** No `Date.now()`/`Math.random()` appears anywhere in the scoring/ordering path: `replayTree`, `orderFrontier` (:542-556), `compareFrontierScore` (:1155-1164), `frontierPriority`, `apportionSearchSlots`, and `splitDreamerHoldout` are pure functions of their inputs with total orders (priority desc → createdAt asc → id asc for frontiers; hypervolume/cost/policyId for candidate selection in `isBetterEvaluation`, :2043-2060). Wall-clock enters only as metadata (`ranAt`, candidate `createdAt`, `computedAt`), never as a ranking input, and `scoreSurrogate`/`createSurrogateScorer` accept an injectable `now` that the production assembly supplies (src/index.ts:2136-2139). The determinism test (offline-dreamer.test.ts:400-408) pins visited ids, probes, quality and evidence for identical inputs.
- **Atomic-write and tolerant-recovery discipline matches its documented contract.** `writeFileAtomic` writes an exclusive (`wx`) sibling temp, fsyncs, renames, and removes the temp on any failure (data-dir.ts:152-178); `readJsonlRecovering` distinguishes a torn unterminated tail (dropped) from interior/schema corruption (quarantined), always quarantining the original bytes as `<name>.corrupt` before atomically rewriting the healthy prefix (:382-487), and every behavior is covered by data-dir.test.ts:180-289 plus store-level tests (policy.store.test.ts:152-208, tree-pool.store.test.ts:122-174). Windows profile-name sanitization blocks traversal (`sanitizeProfileName` collapses dot runs and strips separators; data-dir.test.ts:84-95), `path.resolve`/`path.join` are used consistently (no string concatenation), and reserved device names were empirically verified non-blocking on this Windows host (`mkdir 'profiles/con'` succeeds), so the path-handling core is sound.
