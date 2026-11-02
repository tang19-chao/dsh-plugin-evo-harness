# Audit scope: core (harness2, orchestrator, runtime, config, contracts)

## Verified facts summary (2-5 lines: what the module actually does)
The Harness² pipeline is real and mostly honors its stated contracts: the proposer strips external memory from guidance-free slots in code (not just in the prompt), the composer never selects a non-succeeded trajectory and clamps every ratio into [0,1], and the reflector emits complete six-element CanonicalLessons from deterministic evidence with model output restricted to header refinement. The orchestrator runs the documented 15-stage lifecycle with a bounded-concurrency probe wave, strict slotIndex-ordered tree commits, per-executed-probe credit attribution, and a fail-closed execution-profile permission stack (patch/publish/memory double gates). Defects found concentrate in the integrator layer (src/index.ts): the deferred-collaborator forwarding documented at lines 2334-2358 is dead code, so the ctx.llm model and same-process branch executor resolved asynchronously never reach the orchestrator. Secondary issues: an inverted sign in the composed rationale's "dimension wins" (which propagates into committed lesson summaries), a judge verdict with an empty ranking silently imposing a branch-order-correlated 15% blend, and a writeback-gate history filter that is weaker than the L2 learning-eligibility filter it claims to mirror.

## Findings

### [CORE-1] Deferred DSH collaborators are collected but never wired: async-resolved ctx.llm model and branch executor never reach the orchestrator (P1)
- File: src/index.ts:2350-2358 (dead functions), 2120-2135 and 2202 (static wiring), 2334-2344 (false comment), 2921-2925 (write-only holder)
- Evidence:
  ```ts
  function forwardingModel(holder: CollaboratorHolder, missing: () => IModelAdapter): IModelAdapter {
    return {
      complete: (request) => (holder.model ?? missing()).complete(request)
    };
  }
  ```
  The collaborator resolution writes results into `holder` only:
  ```ts
  if (holder.model === undefined && resolvedCollaborators.model !== undefined) {
    holder.model = resolvedCollaborators.model;
  }
  ```
  but the deps are built from static values:
  ```ts
  const model = options.deps?.proposer === undefined ? options.model ?? missingModelAdapter() : undefined;
  const proposer = options.deps?.proposer ?? createDualTrackProposer({ model: model as IModelAdapter, ... });
  ...
  runBranch: options.deps?.runBranch ?? options.runBranch ?? agentExecutor?.runBranch ?? unconfiguredBranchExecutor(now),
  ```
- Analysis: `forwardingModel`/`forwardingBranch` have zero call sites in src/ and tests/ (verified by grep). `holder` is written at index.ts:2509-2512 and 2921-2925 but read only inside the two dead functions. The comment block at 2334-2344 claims "The orchestrator therefore receives stable FORWARDING collaborator objects whose target is replaced once detection settles: an early `ctx.llm` call still fails loudly with the documented message instead of silently succeeding, and a later call uses the real adapter" — none of that happens. Git history (commit 7e73b3f, line 731-732) shows the forwarding adapters WERE wired into deps (`model: forwardingModel(holder, ...)`, `runBranch: forwardingBranch(holder, ...)`); the refactor into `buildOrchestratorDeps` dropped the wiring and left the helpers and comment orphaned. Consequence: on a DSH mount that relies on the documented ctx.llm auto-resolution (resolveDshCollaborators's own diagnostic says "Mount @deepseek-ai/dsh-llm ... Harness2 propose/compose/reflect and Dream-RSI policy generation will fail loudly until then", implying "until ctx.llm exists"), the orchestrator permanently keeps `missingModelAdapter()` and `unconfiguredBranchExecutor()`: every propose throws, every probe returns a failed trajectory, and the run always ends `no_probe` — while a later diagnostic ("model route in effect: provider/model") falsely suggests the model is wired. `dreamBase.modelAdapter` (index.ts:2148) is equally static, so offline policy generation never sees ctx.llm either. `plugin.collaborators` exposes the resolved objects, but no consumer in the repo reads them.
- Fix: wire the forwarding adapters back into `buildOrchestratorDeps` (pass the holder in, use `forwardingModel(holder, () => options.model ?? missingModelAdapter())` for proposer/composer/reflector and `forwardingBranch(holder, ...)` for `deps.runBranch`, with the agentExecutor as the inner fallback), or delete `CollaboratorHolder`/`forwardingModel`/`forwardingBranch` and correct the three doc claims (module header line 12, the CollaboratorHolder comment, and the resolveDshCollaborators diagnostic) to say an explicit `options.model`/`options.runBranch`/`options.agentLoop` injection is mandatory.

### [CORE-2] Composer "dimension wins" sign is inverted for 4 of 6 dimensions; the wrong text propagates into committed lesson summaries (P2)
- File: src/harness2/composer.ts:820-824 (filter), 161, 183, 231/245, 279 (delta signs)
- Evidence:
  ```ts
  '; dimension wins: ' +
  selected.contrasts
    .filter((contrast) => (contrast.delta ?? 0) > 0)
    .map((contrast) => contrast.dimension)
    .join(', ');
  ```
  while the deltas are defined as `delta: candidateSteps - referenceSteps` (line 161), `delta: candidateErrors - referenceErrors` (line 183), `delta = candidateTokens - referenceTokens` (line 231) and `delta: signals - referenceSignals` (line 279).
- Analysis: for `steps`, `tool_errors`, `cost` and `robustness`, a positive delta means the candidate did WORSE (more steps, more errors, more tokens, more failure signals); only `task_completion` and `deliverable_quality` treat delta > 0 as an improvement. The filter therefore lists exactly the dimensions on which the winner regressed against the reference as its "wins" in `composedPatch.rationale` and `composedPatch.metadata`. This is not cosmetic: the reflector's `executionSummary` (reflector.ts:309-311) uses the winning patch's rationale verbatim as the lesson's `executionPatch.summary` (CCG element 4), so the inverted evidence sentence is committed into memory with the lesson. Selection math is unaffected (this is rationale text only).
- Fix: make the filter direction-aware, e.g. `const improving = (c) => c.dimension === 'task_completion' || c.dimension === 'deliverable_quality' ? (c.delta ?? 0) > 0 : (c.delta ?? 0) < 0;` and filter with it.

### [CORE-3] A judge response without a usable `ranking` is treated as a valid verdict and blends a branch-order-correlated score instead of falling back to evidence-only (P2)
- File: src/harness2/composer.ts:494, 633-645
- Evidence:
  ```ts
  const ranking = readStringList(parsed.ranking, 64) ?? [];
  ...
  const ranked = [...verdict.ranking, ...aliases.filter((alias) => !verdict.ranking.includes(alias))];
  for (const evaluation of evaluations) {
    const rank = ranked.indexOf(evaluation.alias);
    evaluation.judgeRank = rank >= 0 ? rank + 1 : undefined;
    ...
    const judgeScore = judgeScoreOf(evaluation.judgeRank, evaluations.length);
    evaluation.adoptionRatio = clamp01(
      judgeScore === undefined ? evaluation.evidenceScore
        : evidenceWeight * evaluation.evidenceScore + judgeWeight * judgeScore);
  ```
- Analysis: `readJudgeVerdict` returns a verdict whenever the response is any JSON object; a response like `{"assessments": [...]}` with no `ranking` field yields `verdict.ranking === []`, which is not distinguished from an unparseable verdict (the `judgeUnavailableReason` path at 630-631 is only taken when `extractJsonValue` fails). The completion at line 633 then assigns judge ranks 1..n in evaluation order — and `evaluations` is sorted by `branchId + '\u0000' + nodeId` (lines 591-595), i.e. by branch/node identity. `judgeScoreOf` awards 1.0 down to 0.0 in that order, so the earliest-created branch receives the full judge bonus and the adoption ratio blends 0.15 * 1.0 of a signal derived purely from identity order — the exact "judge reward" the anonymity design says must reflect judged behavior, here silently manufactured from creation order. A model that returns malformed-but-parseable JSON (e.g. `{"ranking": "A > B"}`, which `readStringList` rejects to `[]`) gets the same arbitrary ranking.
- Fix: treat an empty filtered `verdict.ranking` as unavailable (`judgeUnavailableReason = 'judge returned no usable ranking'`), or restrict the judge blend to aliases the judge actually ranked and leave unranked candidates at their evidence-only ratio.

### [CORE-4] Writeback-gate history filter is weaker than the L2 learning-eligibility filter it claims to mirror (stale-rewardVersion records counted) (P2)
- File: src/orchestrator.ts:2177-2233 (esp. the filter at 2193-2210); src/jitrl/experience-store.ts:249-251, 1436
- Evidence (orchestrator, `readWritebackHistory`):
  ```ts
  // `export()` yields every persisted record; the gate then applies the
  // causal cutoff and the same learning-eligibility filter the decision's
  // own filter uses, so "visible to L2" and "counted by the gate" agree.
  ...
  if (record.learningEligible === false) { continue; }
  const schemaVersion = record.experienceSchemaVersion;
  if (typeof schemaVersion !== 'number' || ... || schemaVersion < EXPERIENCE_SCHEMA_VERSION) { continue; }
  ```
- Analysis: the decision-side neighbourhood is read with `learningEligibleOnly: true` (orchestrator.ts:3026), whose store implementation is `isLearningEligible` = `isLearningEligibleRecord(record, CURRENT_REWARD_VERSION)` — which, per reward-contract, also requires an EXACT current `rewardVersion` (store comment: "its rewardVersion is not the exact current contract id ... does not train either"). The gate's history read checks `learningEligible === false` and the schema version, but never checks `record.rewardVersion`. Any record with `learningEligible: true` and an old/foreign `rewardVersion` (previous reward-contract generation, surrogate rebuild) is therefore counted in G-B's support/verifiedRate/counterexamples while being permanently invisible to the L2 decision it gates. This directly contradicts the comment's "same learning-eligibility filter ... 'visible to L2' and 'counted by the gate' agree" claim, and can admit a writeback route on the strength of evidence the store would never return.
- Fix: in `readWritebackHistory`, also skip records where `record.rewardVersion !== REWARD_CONTRACT.version` (the module already imports `REWARD_CONTRACT`), or reuse the store's exported `isLearningEligibleExperience` predicate so both sides share one rule.

### [CORE-5] Experience dedup ledger marks records as appended before the store append succeeds (P2)
- File: src/orchestrator.ts:2800-2808 (keys added) vs 2960-2965 (append catch)
- Evidence:
  ```ts
  for (const record of records) {
    const key = experienceDedupKey(record);
    if (this.appendedExperienceKeys.has(key)) { continue; }
    this.appendedExperienceKeys.add(key);
    deduped.push(record);
  }
  ...
  try {
    await kernel.store.append(deduped);
  } catch (error) {
    input.diagnostics.push('record_experience failed: ' + errorMessage(error));
    return 0;
  }
  ```
- Analysis: on an append failure the records were never persisted, but their dedup keys stay in `this.appendedExperienceKeys` for the orchestrator instance's lifetime, so any re-entry of the recorder would silently drop them as "already appended". This inverts the register-on-success discipline the very same function enforces two paragraphs later for quality-provenance registrations (C2b F4, lines 2934-2971: pre-commit registrations are rolled back and only re-registered after the append succeeds) and contradicts the class-level claim that the ledger exists to prevent duplicate appends of executions (it instead prevents RETRIES of failed appends). Today `recordOnlineExperience` is called once per run so the window is latent, but the file's own t8/R5 commentary treats recorder re-entry ("dedup path, off mid-flight") as a live path and guards the reservation refund against it with `releasedReservationKeys`.
- Fix: add the keys only after `await kernel.store.append(deduped)` resolves (or delete them in the catch), matching the quality-record register-on-success pattern.

### [CORE-6] `recordModeOf` doc comment contradicts the implementation and its real second caller (P3)
- File: src/runtime/execution-profile.ts:135-143
- Evidence:
  ```ts
  /**
   * Effective DecisionMode a record should carry for one run: 'off' runs still
   * record NOTHING (the runtime control stops the surfaces), so the profile
   * never maps 'off' onto a record mode. The orchestrator reads this only when
   * it is actually producing records.
   */
  export function recordModeOf(mode: ExecutionMode): 'baseline' | 'shadow' | 'guarded-active' {
    return mode === 'off' ? 'baseline' : mode;
  }
  ```
- Analysis: the function is literally a mapping of 'off' onto the record mode 'baseline'. And the claim that "the orchestrator reads this only when it is actually producing records" is false: `createJitWiredDreamer` (src/index.ts:1425-1429) calls `recordModeOf(declaredProfile.mode)` unconditionally at mount time to build `replayDeclarations`, so an 'off' profile replays the persisted log under a declared 'baseline' partition (excluding shadow-mode records) even though no 'off' run ever produces records. The behavior is defensible (a declared partition must be one of the three record modes), but the comment asserts the opposite of what the code does.
- Fix: rewrite the comment to state the actual contract ('off' falls back to the 'baseline' record mode; the orchestrator never stamps records under 'off' because the runtime surfaces are stopped, but the replay-declaration builder maps 'off' to 'baseline').

### [CORE-7] Composer adoption weights are unvalidated, so the documented "bounded 15%" judge share is only a default, not an invariant (P3)
- File: src/harness2/composer.ts:13-14 (guarantee), 568-569
- Evidence:
  ```ts
  const evidenceWeight = options.evidenceWeight ?? DEFAULT_ADOPTION_BLEND.evidence;
  const judgeWeight = options.judgeWeight ?? DEFAULT_ADOPTION_BLEND.judge;
  ```
  with the header claiming "The judge's ranking can only blend a bounded share (default 15%) into the adoption ratio".
- Analysis: nothing normalizes the pair or verifies `evidenceWeight + judgeWeight <= 1`; `createAnonymousComposer({ judgeWeight: 0.9, evidenceWeight: 0.9 })` yields ratios up to 1.8 pre-clamp (judge effectively dominating after clamping) with no diagnostic. Contrast with the sibling scorer, which detects non-normalized weights and renormalizes with a diagnostic (surrogate-scorer.ts `normalizeWeights`). The plugin entry never passes these options, so production is safe; the risk is hand-built assemblies and tests that treat the header guarantee as enforced.
- Fix: normalize the two weights to sum to 1 (recording a diagnostic when they did not), mirroring the surrogate scorer's approach.

### [CORE-8] Unreachable `'stopped'` stopReason arm; `rounds_completed` misnames the two actual exits (P3)
- File: src/orchestrator.ts:1854-1856
- Evidence:
  ```ts
  if (stopReason === 'not_started') {
    stopReason = stop ? 'stopped' : 'rounds_completed';
  }
  ```
- Analysis: every `stop = true` path in the round loop sets a specific stopReason first (`budget_exhausted` twice, `first_success`, `failure_taxonomy:*`, `diminishing_returns`, `max_depth`), and the while-condition cannot exit with `stop === false` because the loop body's trailing check sets `stop` when `rounds >= maxRounds`. So `stop === true` with `stopReason === 'not_started'` is unreachable and `'stopped'` is never emitted. The surviving `'rounds_completed'` label actually covers the two break-without-stop exits: the policy returned zero slots, or no candidate probe completed — neither of which is "rounds completed". Misleading telemetry for anyone keying on stopReason.
- Fix: drop the dead arm (`stopReason = 'rounds_completed'` with a comment naming the two real exits), or emit distinct reasons (`policy_no_slots`, `no_candidates`).

### [CORE-9] Reflector dedup diagnostic names the id of a lesson it may have just replaced (P3)
- File: src/harness2/reflector.ts:698-703
- Evidence:
  ```ts
  const existing = deduped[existingIndex];
  diagnostics.push('duplicate lesson key ' + key + ' merged into ' + String(existing?.id));
  if (existing !== undefined && (lesson.confidence ?? 0) > (existing.confidence ?? 0)) {
    deduped[existingIndex] = lesson;
  }
  ```
- Analysis: the diagnostic is emitted before the confidence comparison and says "merged into <existing.id>", but when the incoming lesson has higher confidence the existing lesson is REPLACED wholesale (new id from `newId('lesson')`), so the surviving lesson carries a different id than the one the diagnostic names. Diagnostics are the module's audit trail (returned in `ReflectionResult.diagnostics`), so the record points auditors at a lesson id that no longer exists in the result. Also "merged" is inaccurate — no fields are merged; the survivor is one or the other whole lesson.
- Fix: move the diagnostic after the confidence comparison and report the actual outcome, e.g. `replaced <existing.id> with <lesson.id>` / `kept <existing.id>`.

## Positive verifications (what looks solid and why)

1. **Composer guarantees 1, 3 and 4 are enforced in code, not just in prose, and pinned by substantive tests.** `eligible = evaluations.filter((e) => e.candidate.trajectory.status === 'succeeded')` (composer.ts:651) makes guarantee 3 structural; every ratio passes through `clamp01` (guarantee 4); the judge dossier is built only from alias/redacted content (`identifiersOf` + `redactIdentifiers` over deliverable, steps summary and producedFiles, guarantee 1). tests/unit/harness2/composer.test.ts pins all three with real assertions — it greps the judge prompt for leaked branch/node/patch ids (must be absent), asserts a judge ranking a failed candidate first still selects the successful one, checks the exact nine-key adoptionRatios map, and covers lineage merge, cyclic-parent termination and reference fallback with concrete edit expectations. These are not `toBeDefined` trivialities.

2. **Probe-wave concurrency discipline is correct and regression-tested.** `settleWithConcurrency` (orchestrator.ts:855-888) starts tasks in slotIndex order, caps in-flight at `config.probe.maxConcurrentProbes`, and on a rejection lets every already-started peer settle before the run fails — so isolated-branch cleanup is never abandoned. The commit phase (1666-1760) walks `prepared` in slotIndex order, and the L1 state is captured per-round (`l1StateByRound`) rather than "last state wins". tests/unit/orchestrator/concurrency.test.ts pins parallel execution with ordered tree commits/trace, the concurrency cap, the settle-then-fail budget rollback, and the launch budget ceiling.

3. **The permission/exploration stack is genuinely fail-closed and consistent between doc and code.** A permanent mount requires BOTH `deps.applyWinningPatch === true` AND `profile.permissions.patch.allowed` (constructor at orchestrator.ts:1045-1046 re-checked at the single mount call site 1913-1917); `conservativeGate=true` with a non-guarded-active profile throws in the constructor (1053-1060); `publish` is hard-denied in `resolveExecutionProfile`; `memory` is denied unless the explicit `memoryRealWrites` profile override that no config field can produce is present; the exploration allowance defaults to 0, is granted/revoked only through the public methods, and refunds are idempotent per trajectory id (`releasedReservationKeys`). tests/unit/orchestrator/prb-trusted-verification.test.ts pins the zero default, grant/revoke semantics, and the gate-order totality.

4. **Config validation is unusually thorough and internally consistent with the runtime clamps.** Every config group rejects unknown keys (fail-fast typos), surrogate and reward weights must sum to 1, rho preferences must be strictly ascending, and the cross-field guards match the runtime: `applyWinningPatch=true` requires `execution.mode=guarded-active` (config.ts:1162-1170), `holdoutTreeCount < maxTreePoolSize` (1110-1136), and `probe.maxConcurrentProbes` is validated 1..16 exactly matching `resolveProbeConcurrency`'s clamp. `deepMerge` skips `__proto__`/`prototype`/`constructor` keys (FORBIDDEN_KEYS), so the override path cannot pollute prototypes.

## Test-suite cross-check note
tests/unit/harness2/ and tests/unit/orchestrator/ are high quality: assertions are concrete (exact ids, exact merged edits, exact rewardSource marks, order-sensitive tree checks) rather than presence checks; the scattered `toBeDefined()` calls are guards ahead of deeper assertions. Gaps observed: no test pins the empty-`ranking` judge-verdict behavior (CORE-3) — the closest test only exercises a non-empty ranking over all-failed candidates; nothing covers the deferred-collaborator path (it is dead code, CORE-1); and no test exercises `stopReason` values for the zero-slot / zero-candidate exits (CORE-8).
