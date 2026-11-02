# Round-2 verification: core.md + integration.md

Verifier: adversarial re-check, round 2. Every verdict below is based on code I read in this session (exact file:line given). Grep and git evidence was re-produced, not trusted from round 1. Line numbers refer to the working tree at HEAD 4b5b92c.

## Summary table

| ID | Verdict | Final severity | One-line note |
|----|---------|----------------|---------------|
| CORE-1 | CONFIRMED-UPGRADED | P0 | Dead forwarding confirmed by grep+git; the shipped production mount (cordis.patch.yml) is exactly the broken path, so this is headline-broken, not latent. |
| CORE-2 | CONFIRMED | P2 | Sign inversion verified against all six delta definitions; one evidence correction: `metadata.contrastDimensions` is unfiltered, only the rationale carries the inverted list. |
| CORE-3 | CONFIRMED | P2 | Empty `ranking` verified reachable and unguarded; correction: ranks follow lexicographic branchId/nodeId order, not "creation order". |
| CORE-4 | CONFIRMED | P2 | Gate filter verified to omit any rewardVersion check while the L2 path enforces `isRewardVersionExact`; `export()` is unfiltered, so no downstream guard saves it. |
| CORE-5 | CONFIRMED | P2 | Dedup keys added at 2801-2809, append catch 2963-2966 never releases them; register-on-success contrast is real. Same defect as INT-8. |
| CORE-6 | CONFIRMED | P3 | Comment sentence 1 contradicted by line 142 itself; mount-time reader at index.ts:1427 verified. One precision note on the scoping of sentence 2. |
| CORE-7 | CONFIRMED | P3 | Weights unvalidated; the contrast predicate exists (`normalizeSurrogateWeights`, surrogate-scorer.ts:76-106) — round 1 misnamed it `normalizeWeights`. |
| CORE-8 | CONFIRMED | P3 | All six `stop = true` sites are stopReason-preceded; the only `'not_started'` survivors are the two stop-free breaks. |
| CORE-9 | CONFIRMED | P3 | Diagnostic at reflector.ts:700 precedes the 701-703 wholesale replacement. |
| INT-1 | CONFIRMED | P0 | Same defect as CORE-1; integration report's P0 rating is the correct one. |
| INT-2 | CONFIRMED | P1 | Ternary at index.ts:2120 verified; metered adapter dereferences the undefined inner at metered-model-adapter.ts:531. |
| INT-3 | CONFIRMED | P2 | K/threshold axes unreachable from config (unknown_key rejection); lambda leaf dead vs README. Name correction: set is `JITRL_DREAM_KEYS`. |
| INT-4 | CONFIRMED | P2 | Fallback registration is an independent `if` (index.ts:3299), both blocks push the name (3288, 3308); "takes precedence" comment unimplemented. |
| INT-5 | CONFIRMED | P2 | Zero consumers for either leaf; log() hardcodes 'info'\|'warn'. Minor quote correction: README:113 says "every key is one the parser accepts". |
| INT-6 | CONFIRMED | P2 | Both literal copies verified; values currently match the contract, so it is drift risk, not an active fork. |
| INT-7 | CONFIRMED | P2 | `handleFallbackEvent` returns untracked at index.ts:3198; settle/dispose drain `triggeredRuns` only. |
| INT-8 | CONFIRMED | P3 | Identical to CORE-5; both ratings valid, P3 is the right call for a latent single-caller window. |
| INT-9 | CONFIRMED | P3 | Write-only confirmed (2 references); additionally the field's own doc comment (985-990) falsely claims it is consumed. |
| INT-10 | CONFIRMED | P3 | Inline chain at 2202 vs `forwardingBranch(holder, fallback)` signature; latent by construction (helper is dead). |

No finding was refuted. Two round-1 severity calls needed adjustment (CORE-1 up to P0); several evidence details corrected but none verdict-changing.

## Per-finding verification

### [CORE-1] verdict: CONFIRMED-UPGRADED (P1 -> P0)
- Re-check evidence:
  - `grep -rn "forwardingModel\|forwardingBranch" src tests` returns exactly two definition sites (src/index.ts:2350, 2356) and zero call sites. `CollaboratorHolder` appears only at 2345 (interface), 2350/2356 (dead helpers), 2507 (creation).
  - `holder` lifecycle: created at src/index.ts:2507; written at 2509/2512 (from `options.model`/`options.runBranch`) and 2921-2926 (from `resolvedCollaborators`). The only reads of `holder.model`/`holder.runBranch` are inside the dead helpers (2352, 2357). The other `holder` identifiers in the file (770, 1559-1583) are unrelated locals in different scopes.
  - Deps are built from static values: src/index.ts:2120 `const model = options.deps?.proposer === undefined ? options.model ?? missingModelAdapter() : undefined;`; 2121-2135 build proposer/composer/reflector from `model as IModelAdapter`; 2202 `runBranch: options.deps?.runBranch ?? options.runBranch ?? agentExecutor?.runBranch ?? unconfiguredBranchExecutor(now)`; 2148 `modelAdapter: options.model` for the offline dreamer. `createEvoHarnessOrchestrator` is called exactly once (2523); nothing rebuilds the orchestrator or deps after collaborator resolution.
  - The comment at 2334-2344 still documents the forwarding design ("The orchestrator therefore receives stable FORWARDING collaborator objects..."), and the module header (src/index.ts:12) presents `ctx.llm / ctx.tools / ctx.agents -> src/dsh-bridge (resolveDshCollaborators)` as the host-facing resolution path.
  - `resolveDshCollaborators` really does build working collaborators: model adapter from `ctx.llm.stream` at src/dsh-bridge/index.ts:282-284, same-process branch executor at 320-327. Its no-llm diagnostic (277-280) says "Harness2 propose/compose/reflect and Dream-RSI policy generation will fail loudly **until then**" — implying mounting dsh-llm fixes it. It does not, because the resolution lands in the unread holder.
  - Failure shape: `missingModelAdapter()` throws (src/index.ts:1134-1140); the orchestrator catches the propose throw per slot and `continue`s (src/orchestrator.ts:1521-1526, diagnostic "proposal failed for slot ..."), so no candidates exist; the loop breaks at orchestrator.ts:1763-1766 and the run ends without probes. `unconfiguredBranchExecutor` (src/index.ts:2310-2331) returns the loud failed trajectory. Meanwhile the plugin reports "model route in effect: provider/model (effort ...)" unconditionally on successful resolution (src/index.ts:2927-2935).
  - Git: commit 7e73b3f wired the forwarders — `git show 7e73b3f:src/index.ts` lines 731-732 read `model: forwardingModel(holder, () => options.model ?? missingModelAdapter()),` and `runBranch: forwardingBranch(holder, unconfiguredBranchExecutor(() => Date.now())),` inside a `bridgeOptions` object passed to `buildOrchestratorDeps`. Commit 7307d7d (Oct 23, "feat(jitrl): land Phase 4 double-loop and Phase 5 L3/mirror/eval") deleted the whole `bridgeOptions` block (diff hunks `-    model: forwardingModel(holder, ...)` / `-    runBranch: forwardingBranch(holder, ...)`) and switched the call to `buildOrchestratorDeps(resolved, options, ctx, diagnostics)` — leaving helpers, holder and comment orphaned. The round-1 claim that the wiring existed at 7e73b3f is verified; the actual removal commit is 7307d7d.
- Disconfirming evidence considered:
  - Production delivery paths: (1) `options.model`/`options.runBranch` injection — works, but is the standalone/test path; (2) `options.deps` injection — full custom assembly, not a default; (3) `resolveDshCollaborators` — writes to `holder`, dead end. No fourth path exists.
  - External consumers: `grep -rn "\.collaborators" src tests scripts bridge-verify dsh-probe` finds nothing; `plugin.collaborators` (src/index.ts:3079) is exposure only.
  - Doc ambiguity: README:174-180 quick-start shows explicit `model`/`runBranch` injection, which would work. But the shipped DSH host-bundle patch — cordis.patch.yml, the artifact that actually mounts the plugin on DeepSeek Harness — supplies only a config section and its header states: "Every injection point (model adapter, MCP clients, runBranch) is resolved from the host at mount time through src/dsh-bridge; this layer only supplies the validated config section." That is precisely the broken path.
  - Option default: `resolveDshCollaborators` "Defaults to true; tests inject the three collaborators directly" (src/index.ts:341-345) — auto-resolution is the production default by the code's own doc.
  - Test coverage: all e2e mounts inject `model` + `runBranch` (tests/e2e/plugin-entry.test.ts:37+39, 98+100, 213+215); no test mounts with a fake `ctx.llm` and no `options.model` (searched tests/ for `llm:` mounts — the only hit, real-benefit-host-client.test.ts:186, tests `readZcodeHostClient` directly, not a plugin mount).
- Final severity rationale: P0. The documented production mount (cordis.patch.yml, auto-resolution default true) delivers a working model and branch executor into an object nobody reads; every `/evo` run on a real DSH host produces zero proposals, zero successful probes and no lessons, while the plugin simultaneously logs "model route in effect". This is the plugin's headline functionality broken in the default configuration, introduced by regression in 7307d7d, with the in-repo comment still asserting the opposite of the code. Round-1 core.md's P1 understated it; integration.md's P0 is correct. Round-1's citation "commit 7e73b3f, line 731-732" is accurate for where the wiring lived at that commit; the drop happened later in 7307d7d.

### [CORE-2] verdict: CONFIRMED (P2)
- Re-check evidence:
  - The filter is at src/harness2/composer.ts:820-824: `'; dimension wins: ' + selected.contrasts.filter((contrast) => (contrast.delta ?? 0) > 0).map((contrast) => contrast.dimension).join(', ')`.
  - Delta signs, read directly: `task_completion` delta = score difference, higher is better (composer.ts:139); `steps` delta = `candidateSteps - referenceSteps` (161), higher is worse; `tool_errors` delta = `candidateErrors - referenceErrors` (183), higher is worse; `deliverable_quality` delta = `chars - referenceChars` (208), higher is better; `cost` delta = `candidateTokens - referenceTokens` or `candidateMs - referenceMs` (231/245), higher is worse; `robustness` delta = `signals - referenceSignals` (279), higher is worse. Exactly 4 of 6 dimensions invert.
  - Propagation verified: reflector.ts:396-401 selects `composedPatch` for the winning trajectory; `executionSummary` (reflector.ts:303-311) returns `truncate(oneLine(patch.rationale), 300)` verbatim; it becomes `executionPatch.summary` in the committed lesson (reflector.ts:638-641).
  - Selection math unaffected: selection reads `evidenceScore`/`adoptionRatio` only (composer.ts:651-657).
- Disconfirming evidence considered:
  - I looked for a direction-aware helper applied elsewhere or a second filter that fixes the text before commit — none exists.
  - One inaccuracy in round-1's evidence: `composedPatch.metadata` is NOT affected. `contrastDimensions` at composer.ts:844 maps ALL contrasts (`selected.contrasts.map((contrast) => contrast.dimension)`), unfiltered by sign. Only the rationale string carries the inverted "wins" list. This does not weaken the finding (the committed lesson summary is the load-bearing claim) but the metadata claim should be dropped.
- Final severity rationale: P2 stands — committed-memory evidence text is systematically inverted for 4 of 6 dimensions, but selection/ratios are unaffected.

### [CORE-3] verdict: CONFIRMED (P2)
- Re-check evidence:
  - composer.ts:494 `const ranking = readStringList(parsed.ranking, 64) ?? [];` and readStringList (src/harness2/shared.ts:83-97) returns `undefined` for a missing field, a non-array, or a malformed entry — so `{"ranking": "A > B"}` and `{"assessments": [...]}` both yield `ranking === []`.
  - `readJudgeVerdict` (composer.ts:489-524) returns a verdict for ANY parseable JSON record; composer.ts:629-631 sets `judgeUnavailableReason` only when `verdict === undefined` (i.e., `extractJsonValue` failed or non-record). An empty ranking is never treated as unavailable.
  - composer.ts:633 `const ranked = [...verdict.ranking, ...aliases.filter(...)]` — with an empty ranking, `ranked` is `aliases` in evaluation order; `evaluations` is built from `ordered` sorted by `branchId + '\u0000' + nodeId` (591-595). `judgeRank = rank + 1` (636), `judgeScoreOf(1, n) = 1.0` (531-539), and the blend at 640-644 gives the first identity-ordered candidate `0.85*evidence + 0.15*1.0` (DEFAULT_ADOPTION_BLEND, composer.ts:78).
  - No test pins the empty-ranking behavior: tests/unit/harness2/composer.test.ts uses only non-empty rankings (lines 14, 196, 224).
- Disconfirming evidence considered:
  - Checked whether any earlier validation rejects a verdict without ranking — none; `readJsonRecord` only checks record-ness (526-529).
  - Precision correction to round-1: the bonus goes to the lexicographically-smallest `branchId\0nodeId`, not "the earliest-created branch". Branch ids are host/time-derived, so correlation with creation order is incidental; the substance (a judge score manufactured purely from identity order) is exact.
- Final severity rationale: P2 stands — a plausible judge response class silently converts identity order into a 15-point adoption bonus.

### [CORE-4] verdict: CONFIRMED (P2)
- Re-check evidence:
  - Gate filter, read at src/orchestrator.ts:2156 (`readWritebackHistory`) with the loop at ~2193-2232: skips records where `createdAt > before`, `record.learningEligible === false`, `experienceSchemaVersion` missing/`< EXPERIENCE_SCHEMA_VERSION`, or empty `actionKey`. There is NO `rewardVersion` check anywhere in the function (`grep -n "rewardVersion" src/orchestrator.ts` shows only the producer stamps at 2696 and 2883).
  - The comment immediately above (2181-2183) claims the gate applies "the same learning-eligibility filter the decision's own filter uses, so 'visible to L2' and 'counted by the gate' agree".
  - Decision side: orchestrator.ts:3026 passes `learningEligibleOnly: true`; the store applies it at src/jitrl/experience-store.ts:1165 (`if (learningEligibleOnly && !isLearningEligible(record))`); `isLearningEligible` (249-251) delegates to `isLearningEligibleRecord(record, CURRENT_REWARD_VERSION)` (src/jitrl/reward-contract.ts:499-515), which finally requires `isRewardVersionExact(record.rewardVersion, currentRewardVersion)` (line 514).
  - `isRewardVersionExact` (reward-contract.ts:285-299) accepts exact match or a certified compatibility pair — in every case strictly narrower than the gate's no-check-at-all.
- Disconfirming evidence considered:
  - Could `export()` pre-filter, making the gate's weak filter moot? No: the facade delegates (`src/jitrl/index.ts:306-308` → `drive.export()`), and both store implementations iterate the full snapshot unfiltered (src/jitrl/stores/jsonl.store.ts:380-390, src/jitrl/stores/memory.store.ts:147+).
  - Could stale-rewardVersion records not exist in practice? They are exactly the population the store's own comments describe (old contract generation `r3/unified-signals-v1` at reward-contract.ts:130, surrogate backfill, unversioned) — the store fails them closed for L2; the gate counts them.
- Final severity rationale: P2 stands — the gate can admit a writeback route on evidence the L2 decision can never see, contradicting the adjacent comment that claims the two filters agree.

### [CORE-5] verdict: CONFIRMED (P2)  (see also INT-8, same defect)
- Re-check evidence:
  - src/orchestrator.ts:2801-2809: the dedup loop does `this.appendedExperienceKeys.add(key)` before any append; the append happens later at 2962 (`await kernel.store.append(deduped)`), and the catch (2963-2966) pushes `'record_experience failed: ...'` and `return 0` without removing any key.
  - The register-on-success contrast is real and in the same function: pre-commit quality registrations are rolled back (2951-2958: push to `unregisteredQualityRecords` + `unregisterAuthenticatedQualityRecord`) and only re-registered after the append succeeds (2968-2973).
  - Latency confirmed: `recordOnlineExperience` is called once per run (orchestrator.ts:1884; comment 1881-1883 "it happens once, after reflect").
- Disconfirming evidence considered: looked for a key-release in a `finally`, a retry path, or a store-level dedup that would make the ledger irrelevant — none; the ledger is the only dedup, and it converts a failed append into a permanently suppressed retry for the orchestrator instance's lifetime.
- Final severity rationale: P2 is defensible and P3 is defensible (INT-8 rates the same code P3). I keep P2 for CORE-5/P3 for INT-8 as round-1 had them: the defect contradicts the file's own register-on-success discipline and the t8/R5 re-entry commentary treats recorder re-entry as live, but today there is exactly one call site per run.

### [CORE-6] verdict: CONFIRMED (P3)
- Re-check evidence:
  - src/runtime/execution-profile.ts:135-143: the comment says "'off' runs still record NOTHING ..., so the profile never maps 'off' onto a record mode", while line 142 is `return mode === 'off' ? 'baseline' : mode;` — the function is literally the mapping the comment denies.
  - Second caller verified exactly: src/index.ts:1425-1429 — `createJitWiredDreamer` computes `declaredProfile` and `replayDeclarations = { decisionMode: recordModeOf(declaredProfile.mode), ... }` unconditionally at construction (module scope of the factory, executed at mount), so an 'off' profile declares replay partitions as 'baseline'.
- Disconfirming evidence considered:
  - Sentence 2 of the comment ("The orchestrator reads this only when it is actually producing records") is, read literally, TRUE for the orchestrator's own call site: orchestrator.ts:2411 sits inside the record-production function (`const records: ExperienceRecord[] = []` at 2405). What is false is the first sentence (contradicted by line 142 itself) and the implied exclusivity — the mount-time reader at index.ts:1427 is not the orchestrator. Round-1's framing ("the claim ... is false") is right in spirit; the precise defect is sentence 1 plus the mount-time caller.
  - Checked whether the runtime control actually stops all surfaces under 'off' (which would make the baseline mapping harmless): irrelevant to the verdict — the comment asserts the mapping never happens, and it happens at line 142 by definition.
- Final severity rationale: P3 stands (comment/doc defect; behavior itself is defensible, as round-1 said).

### [CORE-7] verdict: CONFIRMED (P3)
- Re-check evidence:
  - Header guarantee 2 at src/harness2/composer.ts:13-14 ("The judge's ranking can only blend a bounded share (default 15%)"); weights read at 568-569 as `options.evidenceWeight ?? DEFAULT_ADOPTION_BLEND.evidence` / `options.judgeWeight ?? DEFAULT_ADOPTION_BLEND.judge`; both are public option fields (composer.ts:92-97). `grep -rn "evidenceWeight\|judgeWeight" src` outside composer.ts returns nothing — no normalization, no validation anywhere; `clamp01` (640-644) bounds the per-candidate ratio but `0.9/0.9` pre-clamps to 1.8 with the judge term dominating.
  - The round-1 contrast is real, with a name fix: the sibling scorer's function is `normalizeSurrogateWeights` (src/dream-rsi/surrogate-scorer.ts:76-106), not `normalizeWeights`; it detects non-unit sums and renormalizes with a diagnostic (line 105: "surrogate weights did not sum to 1; normalized by ...").
  - Production safety verified: the only plugin-level construction passes no weights (src/index.ts:2126-2130), so defaults 0.85/0.15 apply in every assembled-by-plugin composer.
- Disconfirming evidence considered: looked for a config path that could set the weights (none — they are not in `EvoHarnessConfig`), and for test assemblies that would already exercise the guarantee (none pin normalization).
- Final severity rationale: P3 stands — documented-invariant-vs-implementation gap reachable only by hand-built assemblies.

### [CORE-8] verdict: CONFIRMED (P3)
- Re-check evidence:
  - src/orchestrator.ts:1854-1856 `if (stopReason === 'not_started') { stopReason = stop ? 'stopped' : 'rounds_completed'; }`.
  - Every `stop = true` site (grep: 1449, 1827, 1832, 1840, 1845, 1850) is immediately preceded by a specific stopReason assignment (1448 `budget_exhausted`, 1826 `first_success`, 1831 `budget_exhausted`, 1839 `failure_taxonomy:*`, 1844 `diminishing_returns`, 1849 `max_depth`).
  - The while condition is `!stop && rounds < maxRounds` (1387) and the loop-body trailing check sets `stop` when `rounds >= maxRounds` (1848-1851), so the loop can never exit with `stop === true && stopReason === 'not_started'` — `'stopped'` is dead (grep `'stopped'` in src: only line 1855).
  - The two break-without-stop exits are 1430-1433 (policy selected zero slots) and 1763-1766 (no candidate probe completed); both land on `'rounds_completed'`, which misnames them.
- Disconfirming evidence considered: searched for any other `stop` assignment or a `stopReason = 'stopped'` producer — none exists.
- Final severity rationale: P3 stands (telemetry mislabel only; no consumer keys on `'stopped'` today).

### [CORE-9] verdict: CONFIRMED (P3)
- Re-check evidence: src/harness2/reflector.ts:699-703 — the diagnostic `'duplicate lesson key ... merged into ' + String(existing?.id)` is pushed at line 700, BEFORE the confidence comparison at 701; when the incoming lesson wins, line 702 `deduped[existingIndex] = lesson` replaces the entry wholesale (incoming lessons carry fresh `newId('lesson')` ids), so the diagnostic names an id that is no longer in the result. No field merging occurs anywhere in the block.
- Disconfirming evidence considered: checked whether `lesson.id` could equal `existing.id` (no — ids are freshly minted per lesson) and whether the diagnostic is regenerated after replacement (no).
- Final severity rationale: P3 stands (audit-trail accuracy only).

### [INT-1] verdict: CONFIRMED (P0)
- Re-check evidence: same defect as CORE-1, independently re-verified. All cited lines check out: src/index.ts:2350-2358 (helpers), 2120 (ternary), 2126-2135 (composer/reflector construction), 2202 (runBranch chain), 2921-2926 (holder filled); src/dsh-bridge/index.ts:282-284 (real model), 313-331 (same-process executor); zero call sites for the helpers; nothing reads `holder`; e2e coverage gap at tests/e2e/plugin-entry.test.ts:37,98,213 confirmed.
- Disconfirming evidence considered: see CORE-1 — no production delivery path exists; the only working paths are the explicit-injection seams the DSH host bundle does not use.
- Final severity rationale: P0, as round-1 integration.md rated it; consistent with the CORE-1 upgrade.

### [INT-2] verdict: CONFIRMED (P1)
- Re-check evidence:
  - src/index.ts:2120: `const model = options.deps?.proposer === undefined ? options.model ?? missingModelAdapter() : undefined;` — when `deps.proposer` is injected, `model` is forced to `undefined` even if `options.model` was supplied.
  - src/index.ts:2126-2135: `createAnonymousComposer({ model: model as IModelAdapter, ... })` and `createEvidenceReflector({ model: model as IModelAdapter, ... })` — the cast silences tsc.
  - Downstream dereference verified: composer.ts:571 / reflector.ts:572 wrap the value with `createMeteredModelAdapter(options.model, '<stage>', ...)`; the metered call path executes `response = await inner.complete(request);` at src/dsh-bridge/metered-model-adapter.ts:531 → with `inner === undefined` this is `TypeError: Cannot read properties of undefined (reading 'complete')`, not the loud `missingModelAdapter()` message.
- Disconfirming evidence considered:
  - Could a host that injects `deps.proposer` be expected to inject composer/reflector too, making the combination unreachable? Nothing enforces it; `deps.composer`/`deps.reflector` are independent optionals and the orchestrator calls `this.deps.composer.compose(...)` unconditionally when candidates exist (orchestrator.ts:1769).
  - Is the thrown TypeError at least caught somewhere benign? It propagates out of `compose()` inside the run; the run fails noisily with an opaque error and the explicitly injected `options.model` is silently discarded — the two harms round-1 named.
- Final severity rationale: P1 stands — a documented override combination (custom proposer + default composer/reflector) fails with a raw TypeError and silently drops a supplied option. Not P0 because it requires the partial-deps-injection scenario, not the default mount.

### [INT-3] verdict: CONFIRMED (P2)
- Re-check evidence:
  - Consumer reads: src/dream-rsi/offline-dreamer.ts:352-353 (`const ks = finiteIntegerGrid(config.candidateJitKs); const thresholds = finiteUnitGrid(config.candidateJitSimilarityThresholds);`); the consumer-facing type `JitPerturbationConfig` declares both (offline-dreamer.ts:243-250); the resolved grid feeds live sweeps (`k: grid.ks[index % grid.ks.length] ?? baseJit.k`, offline-dreamer.ts:1699).
  - Config side: `JitRlDreamConfig` (src/config.ts:198-207) has only driftRho/hyperparamPerturbation/candidateJitBetas/candidateJitLambdas; `JITRL_DREAM_KEYS` (src/config.ts:597-602) matches exactly; `collectUnknownKeys(raw.jitrl.dream, JITRL_DREAM_KEYS, 'jitrl.dream', issues)` (config.ts:1418) rejects anything else. So `candidateJitKs`/`candidateJitSimilarityThresholds` can never come from config — pinned to `DEFAULT_JIT_KS`/`DEFAULT_JIT_SIMILARITY_THRESHOLDS` via the 369-372 fallbacks.
  - Lambda leaf: read at 356 but only "reported verbatim" (comment 354-355); `JitPerturbationGrid.lambdas` documented "not consumed by generateCandidatePolicies since P6 PR5" (offline-dreamer.ts:258-261); `JIT_IGNORED_DIMENSIONS` lambda reason (289-294). Yet the README row documents `jitrl.dream.candidateJitLambdas[]` as "Candidate lambda grid **drawn from when generating policies**" (README table row shown in the config reference).
- Disconfirming evidence considered: checked whether some second config path (options override, env) can populate ks/thresholds — the dreamer receives `input.config.jitrl.dream` only (src/index.ts:1449), which is post-validation and therefore cannot carry the keys.
- Final severity rationale: P2 stands. Name correction to round-1: the set is `JITRL_DREAM_KEYS`, not `JIT_DREAM_KEYS`. Substantively identical.

### [INT-4] verdict: CONFIRMED (P2)
- Re-check evidence:
  - First block: src/index.ts:3273-3293 — comment "DSH's own command service takes precedence", then `if (dshRegister !== undefined) { ... registeredCommands.push(EVO_COMMAND_NAME); ... }` (push at 3288).
  - Second block: 3295-3318 — `const registerCommand = pickFunction(asRecord(ctx), ['registerCommand','command','addCommand']); if (registerCommand !== undefined) { ... registeredCommands.push(EVO_COMMAND_NAME); ... }` (push at 3308). It is an independent `if`, not `else if`; the `else if (registeredCommands.length === 0)` clause only emits a diagnostics message. On a ctx exposing both shapes, /evo is registered twice with two different handlers (`handleDshCommand(plugin, invocation)` vs `plugin.runFromCommand(args, context)`).
- Disconfirming evidence considered:
  - Host-plausibility: all test fixtures provide one shape only (tests/e2e/fixtures.ts:660 provides `registerCommand`; plugin-entry tests provide `ctx.commands`), so the collision is untested — as round-1 said. Nothing in the code prevents a host from exposing both (Cordis contexts grow such conveniences), and the "takes precedence" comment plus the fallback-diagnostics guard show the author intended exclusivity.
  - Harm check: worst case is host-dependent (duplicate invocation, overwrite, or a registration error) — a real integration hazard, not a theoretical style issue.
- Final severity rationale: P2 stands.

### [INT-5] verdict: CONFIRMED (P2)
- Re-check evidence:
  - Declared/defaulted/validated: `LoggingConfig` (src/config.ts:101-105), defaults (462-465), `LOGGING_KEYS` (552), `validateLoggingGroup` (1138-1149).
  - Consumers: `grep -rn "includeTrajectorySummaries" src` → config.ts only; `grep -rn "\.logging" src` outside config.ts → only the doc comment at src/index.ts:244. The plugin's `log` (src/index.ts:2552-2561) hardcodes `'info' | 'warn'` and never reads `config.logging.level`.
  - README rows exist for both leaves (README.md:255-256).
- Disconfirming evidence considered: none found — the group is dead surface. One quote correction: README:113 actually reads "every value shown is the built-in default, and every key is one the **parser accepts**" (round-1 quoted "every key is one the plugin reads"). The parser-acceptance claim is literally true, so the contradiction round-1 alleged against README:113 is weaker than stated; the dead-config substance (validated no-op keys, README rows promising behavior) is unaffected.
- Final severity rationale: P2 stands.

### [INT-6] verdict: CONFIRMED (P2)
- Re-check evidence:
  - src/dsh-bridge/real-benefit-controller.ts:1772-1773 hardcodes `contractVersion: 'r4/verifier-first-v1', aggregation: 'trajectory-signals-v1'`; line 122 already imports `scoreUnderRewardContract` from `'../jitrl/reward-contract'`; the single source values are `REWARD_CONTRACT_VERSION = 'r4/verifier-first-v1'` (reward-contract.ts:56) and `REWARD_CONTRACT_AGGREGATION = 'trajectory-signals-v1'` (reward-contract.ts:65) — currently identical, so this is drift risk, not an active fork.
  - src/orchestrator.ts:2885 hardcodes `verifierFirstRule: 'verifier-first-completion-v1'`; `REWARD_CONTRACT_VERIFIER_FIRST` is exported at reward-contract.ts:591 with zero importers (`grep -rn REWARD_CONTRACT_VERIFIER_FIRST src` → definition only).
  - src/orchestrator.ts:647-651: `readJitBatchDiagnostics` reads `metadata['jit']` as a local literal; `JIT_BATCH_METADATA_KEY = 'jit'` at src/jitrl/jit-active-policy.ts:82; the orchestrator comment at 443-447 documents the duplication as deliberate ("Kept as a local structural read instead of an import so the orchestrator stays independent of src/jitrl/**").
- Disconfirming evidence considered: checked whether a compile-time witness test pins any of the three strings — none found (`grep -rn "verifier-first-completion-v1\|trajectory-signals-v1" tests` finds behavioral tests but no cross-module identity assertion tying the copies to the constants).
- Final severity rationale: P2 stands (hand-copied identity literals at two seams; one has zero-importer single-source available, one is documented-but-unwitnessed duplication).

### [INT-7] verdict: CONFIRMED (P2)
- Re-check evidence:
  - src/index.ts:3165-3198: `handleFallbackEvent` ends with `return runFallback({...})` — no `trackRun`.
  - src/index.ts:3200-3201: `handleTriggerFailure: (failure) => trackRun(runFallback(failure)), handleTurnCompleted: (turn) => trackRun(runCompletedTurn(turn)),`.
  - `settle()` (3202-3216) drains `triggeredRuns` only; `dispose()` (3226-3240) awaits `triggeredRuns` ("Let in-flight trigger runs finish before tearing the orchestrator down, so a run started by the last event is not aborted mid-flight") before disposing the runtime control and the orchestrator.
  - README.md:195-196 documents `plugin.handleFallbackEvent(payload)` as a supported fallback entrypoint.
- Disconfirming evidence considered: a host that awaits its own `handleFallbackEvent` call before dispose is safe; but the untracked run is invisible to BOTH join points, and the asymmetry with the other two entries (which are tracked even though their callers also receive promises) shows the intended invariant. A fire-and-forget fallback caller — the exact scenario `settle()` exists for — leaks a mid-flight run into teardown.
- Final severity rationale: P2 stands.

### [INT-8] verdict: CONFIRMED (P3)
- Re-check evidence: identical code to CORE-5 (marking at src/orchestrator.ts:2801-2809; append catch 2963-2966 returns 0 without releasing keys). Round-1's line citations (2800-2812 / 2960-2965) match within a line.
- Disconfirming evidence considered: none beyond CORE-5's; the quality-record rollback (2951-2973) is correctly symmetric, isolating the defect to the ledger.
- Final severity rationale: P3 stands (latent single-caller window; CORE-5's fuller write-up carries the analysis).

### [INT-9] verdict: CONFIRMED (P3)
- Re-check evidence: `grep -rn "unregisteredQualityRecords" src tests` → exactly two references: declaration src/orchestrator.ts:992 and the sole write at 2957. Nothing reads, bounds or clears it. Every rolled-back record (full `ExperienceRecord`) is retained for the process lifetime.
- Disconfirming evidence considered: the field's own doc comment (orchestrator.ts:985-990) claims "the rollback list is consumed by the recorder's commit step (register-on-success)" — that is false; the commit step re-registers from `pendingQualityRegistrations` (2968-2973), not from this array. So the field is not merely write-only, its comment misdescribes the mechanism — this strengthens round-1's "misleading name" point.
- Final severity rationale: P3 stands (unbounded dead store + false doc).

### [INT-10] verdict: CONFIRMED (P3)
- Re-check evidence: src/index.ts:2202 inlines the four-level chain `options.deps?.runBranch ?? options.runBranch ?? agentExecutor?.runBranch ?? unconfiguredBranchExecutor(now)` while `forwardingBranch(holder, fallback)` (2356-2358) takes the fallback as a parameter and is currently dead. Any INT-1 fix that wires `forwardingBranch` must restate the chain by hand or the two default resolutions diverge (the `agentExecutor?.runBranch` tier is the easy one to forget).
- Disconfirming evidence considered: none — this is a corollary finding, true by construction of the two sites.
- Final severity rationale: P3 stands (latent, conditional on fixing INT-1 the naive way).

## New findings spotted during verification

### [VCI-1] The same 7307d7d refactor also dropped the deferred tools-client forwarding, so the memory bridge and the JitRL mirror never receive DSH clients on the production mount (P1)
- File: src/index.ts:2055-2066 (memory bridge built from `options.clients`/`options.listClients` only), src/index.ts:1907 (`pickMirrorClient(input.options.mirrorClient ?? pickMirrorClient(input.options.clients))` — reads options only), src/memory-bridge/bridge.ts:131 (`const clients = deps.clients ?? (deps.listClients === undefined ? [] : await deps.listClients());` — read at initialize from construction deps only); counterpart src/dsh-bridge/index.ts:288-289 (tools-backed MCP client built by `resolveDshCollaborators`).
- Evidence:
  - Commit 7307d7d removed, together with the `bridgeOptions` forwarding (INT-1), the `deferredClients` provider: the deleted diff hunk contains
    ```ts
    const deferredClients = async (): Promise<readonly McpClient[]> => {
      const detected = await collaborators;
      if (detected === undefined) { return options.clients ?? []; }
      return detected.clients;
    };
    ```
    which used to be injected as `listClients` when the host supplied neither `clients` nor `listClients`. No replacement exists: `grep -n "listClients" src/index.ts` shows only the option type (299), the option-key list (426) and the memory-bridge construction spread (2061-2063).
  - `resolveDshCollaborators` builds the tools-backed client and reports "memory bridge receives N MCP clients: ..." (dsh-bridge/index.ts:288-311), but the result is consumed only by the dead `holder` path and the exposed `collaborators` promise (index.ts:3079) — the memory bridge is constructed earlier and never re-wired.
- Disconfirming evidence considered: the bridge has no late-attach API (`grep setClient|addClient|attach` in src/memory-bridge → none; clients are read once at initialize, bridge.ts:131); no other module forwards resolved collaborators into `deps.memory`; test fixtures inject `options.clients` directly so e2e never sees the gap.
- Final severity rationale: P1 rather than P0 only because on the production DSH mount it is masked by INT-1 (the mount is already non-functional for probes); it independently kills memory auto-discovery (`mcpServerTarget: auto` in cordis.patch.yml finds zero clients → backend unbound) and the JitRL mirror client on the same documented default path. Fix together with INT-1 (reintroduce a deferred `listClients` into `buildOrchestratorDeps`'s memory construction or rebuild the bridge after resolution).

### Verification notes on round-1 accuracy
- Round-1 core.md's git claim ("commit 7e73b3f, line 731-732 shows the wiring") is accurate for that commit's file; the wiring was removed later by 7307d7d — worth recording because a fix must not re-land on top of the wrong blame.
- Minor citation corrections that do not change verdicts: `JIT_DREAM_KEYS` → `JITRL_DREAM_KEYS` (INT-3); `normalizeWeights` → `normalizeSurrogateWeights` (CORE-7); CORE-2's metadata claim and CORE-3's "earliest-created branch" phrasing (see per-finding sections); INT-5's README:113 quote.
