# Audit scope: jitrl-core (decision kernel, rewards, logits, writeback)

## Verified facts summary (2-5 lines)
Audited all 16 in-scope files under `src/jitrl/` plus the consuming seams they contract with
(`src/orchestrator.ts` gate/history/augment call sites, `src/dream-rsi/active-policy.ts` parity target,
`src/config.ts` defaults) and the unit suites `tests/unit/jitrl/*` (writeback-gate, decision-kernel-parity,
reward-version-isolation, logit-adjuster, value-estimator) plus `docs/reports/rev6-jitrl-intervention-{result,preregistration}.md`.
The logit math (closed form `center(z) + beta * A-tilde`), the reward-version isolation predicate, and the
preregistered G-B thresholds are implemented as documented. The real defects concentrate in the writeback
gate's G-A history semantics (deviates from its frozen preregistration), an inert exploration temperature in
the policy-prior logit, a reward-application helper that does not do what its contract says, and dead config
wiring (`jitrl.logitSource`) that silently cannot affect any decision.

## Findings

### [JITRL-1] G-A "prior failure" is satisfied by ANY non-verified history record, not only a prior `failed` verdict (P1)
- File: src/jitrl/writeback-gate.ts:273-275 (schema: src/jitrl/writeback-gate.ts:172-202; spec: docs/reports/rev6-jitrl-intervention-preregistration.md:72)
- Evidence:
```ts
const priorFailure = bucket.some(
  (entry) => entry.actionKey === signals.actionKey && !entry.verified && !entry.counterexample
);
```
  where `WritebackHistoryEntry` carries only `{ actionKey, verified, counterexample }` and
  `writebackHistoryEntryOf` computes `verified = trustedSource && verificationStatus === 'passed'`.
- Analysis: The frozen preregistration (§5, sha256-pinned) requires for G-A that "其同一 `actionKey` 的先前执行
  在快照中留有 `verification.status === 'failed'` 记录", and the module's own header repeats "a prior `failed`
  record for the SAME actionKey ... trusted-but-never-failed (nothing was repaired) ... explicitly refused".
  The implementation cannot express "failed": the history entry type has no verdict field, so a prior record
  with verdict `unknown` (no verdict at all), an untrusted `passed`, or `partial` all collapse to
  `verified === false` and count as a "prior failure". Consequence: in exactly the pool the rev6 result doc
  §2 measured (180/180 records with no verdict), the FIRST future execution of any of those actionKeys that
  carries a host-trusted `passed` receipt is admitted via `kept-fail-to-pass` even though nothing ever failed —
  the precise half-evidence case the header says must be refused. The unit test
  `tests/unit/jitrl/writeback-gate.test.ts:102-111` pins this diluted semantics (its "recorded failure" fixture
  is just two `verified: false` entries), so tests and code agree with each other but both deviate from the
  frozen spec.
- Fix: add the verdict to `WritebackHistoryEntry` (e.g. `status: 'passed' | 'failed' | 'unknown'` produced by
  `writebackHistoryEntryOf`) and define `priorFailure = bucket.some(e => e.status === 'failed' && !e.counterexample)`.
  Update the G-A fixtures to use explicit `failed` entries and add negative cases: prior `unknown` and prior
  untrusted-`passed` must NOT satisfy G-A.

### [JITRL-2] Exploration temperature in `policyPriorLogit` is a softmax no-op (P2)
- File: src/jitrl/logit-sources.ts:137-144
- Evidence:
```ts
const effective = modulated / temperature;
return effective > 0 ? Math.log(effective) : ZERO_SHARE_LOGIT;
```
- Analysis: `log(share / T) = log(share) - log(T)`. For every slot with a positive share (the normal case —
  `normalizeSlotWeights` falls back to an all-positive prior whenever the raw weights are all non-positive),
  dividing the share by T subtracts the SAME constant from every slot's logit. `softmax` (and the
  `centerLogits` pre-shift inside `adjustLogits`) is invariant to a constant shift, so T changes neither the
  prior probabilities, nor the argmax, nor `klToPrior`. The only residual effect is against the fixed
  `ZERO_SHARE_LOGIT = log(1e-9)` floor for zero-share slots. The header documents this as the plan §3.1
  "divided by the exploration temperature" prior — as an exploration temperature it should scale the logits
  (`log(share) / T`) or the exponent, not the pre-log share. Net effect: `policy.explorationTemperature`
  (wired from `jit-active-policy.candidates()` at src/jitrl/jit-active-policy.ts:1186-1191) is inert for L1
  decisions whenever all four slot weights are positive, i.e. essentially always.
- Fix: either compute `Math.log(modulated) / temperature` (a true logit temperature), or keep
  `log(modulated / T)` but document that T only moves the zero-share floor gap — and stop advertising it as
  an exploration knob. Add a counterexample test: two temperature values must produce different softmax
  priors (today they do not, for all-positive weights).

### [JITRL-3] `applyWritebackVerdict` does not zero `learningTarget` as its contract and the preregistration require, and production does not use it (P2)
- File: src/jitrl/writeback-gate.ts:352-368 (header claim: src/jitrl/writeback-gate.ts:41-44; preregistration §5)
- Evidence:
```ts
/**
 * CONTRACT: ... A refused record keeps its scored `reward` for audit, but is
 * forced to a zero learning target and explicit ineligibility ...
 */
export function applyWritebackVerdict<T extends Pick<ExperienceRecord, 'reward' | 'learningEligible'>>(
  record: T,
  verdict: WritebackGateVerdict
): T & Pick<ExperienceRecord, 'learningEligible'> {
  if (verdict.admitted) {
    return { ...record, learningEligible: record.learningEligible };
  }
  return { ...record, learningEligible: false };
}
```
- Analysis: The doc comment (and the module header, "it carries `learningEligible: false` and
  `learningTarget: 0`") promise the refused record is forced to `learningTarget: 0`; the code never touches
  `learningTarget`. The preregistration §5 freezes the refused-record encoding as
  "`learningEligible: false`，`learningTarget: 0`，保留 `reward`". The production orchestrator re-implements the
  application inline (src/orchestrator.ts:2666 `const learningTarget = eligible && !writebackAudited ? ... : 0`),
  so online behavior is compliant — but `applyWritebackVerdict` is the shared "same rule set" helper the module
  advertises ("the online path, the eval script and the unit tests all execute the SAME rule set rather than a
  test-local copy"), it is referenced by `tests/unit/jitrl/writeback-gate.test.ts:359-385` and the rev6 result
  doc §4, and any other consumer that trusts its contract writes refused records with a NON-ZERO
  `learningTarget`. Since the L2 value estimator reads `observedReturn` (not `learningTarget`), such a record is
  dropped by the eligibility filter today — but the moment an ablation consumer reads `learningTarget`
  (the documented ablation arm), a gate-refused record trained under `applyWritebackVerdict` keeps its full gain.
- Fix: make the function match its contract: on refusal return
  `{ ...record, learningEligible: false, learningTarget: 0 }` (type widened to include `learningTarget`), or fix
  the doc to say "the caller must zero learningTarget" and have the orchestrator call this function instead of
  its inline copy so there is exactly one application rule.

### [JITRL-4] `config.jitrl.logitSource` is dead wiring: no decision path consumes the resolved logit source (P2)
- File: src/jitrl/index.ts:328-341,371 (config: src/config.ts:421,1274; source: src/jitrl/logit-sources.ts:286-350)
- Evidence:
```ts
let logitSource: Promise<AutoLogitSource> | undefined;
const getLogitSource = (): Promise<AutoLogitSource> => { ... logitSource = createAutoLogitSource({...}); ... };
...
getLogitSource,   // exposed on the kernel API
```
  and the only consumers found: `grep -rn "getLogitSource|logitFor(" src/` outside logit-sources.ts returns nothing.
  L1 builds priors via `policyPriorLogit` directly (src/jitrl/jit-active-policy.ts:1186-1191, honestly noted in the
  index.ts header), and the L2 path builds priors via `verbalizedLogit(candidate.confidence)` directly
  (src/orchestrator.ts:3209).
- Analysis: `jitrl.logitSource` is a validated config enum (`'auto' | 'verbalized' | 'token'`, default `'auto'`)
  whose only effect is to lazily construct an `AutoLogitSource` nobody calls. Setting `logitSource: 'token'`
  performs the one-shot model probe (real metered model call through `createMeteredModelAdapter`) and then the
  verdict is used by nothing — decisions keep using `policyPriorLogit`/`verbalizedLogit`. The documented
  three-source selection ("Three producers feed prior logits z(s, a) into the JitRL adjustment core") therefore
  cannot steer any decision, and users pay a probe cost for a no-op. Secondary: `createAutoLogitSource`
  (logit-sources.ts:296-309) drops the `metering` option that `createTokenLogprobSource` supports, so even the
  dead probe is unmetered contrary to the P3-B comment.
- Fix: either wire the resolved source into the candidate construction (L2 `baseLogit` and the L1 prior), or
  remove `jitrl.logitSource` from the config surface (and `AutoLogitSource` from the kernel API) so the
  configuration cannot claim an effect it does not have. If kept, pass `metering` through.

### [JITRL-5] Test/comment claim G-A survives an unreadable store; the implementation refuses it (P2)
- File: tests/unit/jitrl/writeback-gate.test.ts:254-263 vs src/jitrl/writeback-gate.ts:290-299
- Evidence:
```ts
it('G-A still works on unusable history (G-B is the route that needs the denominator)', () => {
  // A fail->pass pair needs no history, so refusing it because the store could
  // not be enumerated would be over-strict rather than fail-closed.
  const verdict = judgeWriteback(
    view({ verificationStatus: 'passed', trustedSource: true }),
    indexWritebackHistory(history('action-a', 2, 0))   // <- a USABLE index with 2 entries
  );
```
- Analysis: With a genuinely unusable index (`indexWritebackHistory(undefined)`), `bucket` is `[]`, so
  `priorFailure` is `false` and a trusted `passed` is refused with `rejected-no-prior-failure` — G-A does NOT
  work on unreadable history. The test passes only because its fixture supplies a usable two-entry history,
  contradicting its own name and comment. This matters for safety documentation: an operator reading the suite
  concludes a trusted receipt alone is enough to train when the store is broken; the code (correctly, per the
  preregistration's "prior failed record in the snapshot") requires a readable snapshot. The module header
  ("an unreadable/malformed snapshot history ... refuses G-B") also implies G-A is unaffected, which is wrong
  in the `undefined`-history case.
- Fix: change the test to assert the actual behavior (`indexWritebackHistory(undefined)` + trusted passed ⇒
  `rejected-no-prior-failure`) or, if the intended design is "a trusted receipt needs no history", change
  `judgeWriteback` to skip the prior-failure requirement when `!history.usable` — but then the preregistration
  and header must be updated; today code, test name and spec tell three different stories.

### [JITRL-6] `WritebackGateTrajectoryView.verifierRewardMismatch`/`forceAuditOnly` are never read by the judge, and the orchestrator's mismatch computation is structurally always false (P3)
- File: src/jitrl/writeback-gate.ts:144-157,262-320 (producer: src/orchestrator.ts:2633)
- Evidence: `judgeWriteback` reads only `signals.recordLearningEligible`, `signals.verificationStatus`,
  `signals.trustedSource` and the history bucket; `signals.verifierRewardMismatch`/`signals.forceAuditOnly`
  appear nowhere in its body (they are consumed only by `writebackHistoryEntryOf` for HISTORY entries).
  The orchestrator passes
  `verifierRewardMismatch: evaluation.verification.status === 'failed' && reward > 0`
  but `scoreUnderRewardContract` (reward-contract.ts:193-200) already clamps reward to 0 whenever
  `verification.status === 'failed' && reward > 0`, and the audit branch sets `reward = 0` outright — so the
  condition is unsatisfiable by construction.
- Analysis: The current-execution "verifier and reward disagreed" channel is doubly dead: the judge ignores it,
  and the value fed in can never be true. `forceAuditOnly` still vetoes, but indirectly (it forces
  `recordLearningEligible: false` ⇒ `rejected-record-ineligible`). No wrong admission results; the defect is a
  misleading diagnostics surface and dead contract fields that suggest a veto path which does not exist.
- Fix: either consult `signals.verifierRewardMismatch || signals.forceAuditOnly` as a G-B counterexample for
  the current execution (matching the preregistration wording "任何 ... 的记录都算反例"), or delete both fields
  from the view and the orchestrator computation, documenting that current-run vetoes flow exclusively through
  `recordLearningEligible`.

### [JITRL-7] Neighbour eligibility gates on the legacy `record.return` field while the estimator consumes the contract target `observedReturn` (P3)
- File: src/jitrl/value-estimator.ts:160-162 vs 179-197 (contract: src/jitrl/reward-contract.ts:393-398)
- Evidence:
```ts
// selectNeighbors:
if (!Number.isFinite(neighbor.record.return)) { continue; }
...
// estimateStateValue:
const target = readLearningTarget(neighbor.record);   // observedReturn first, `return` fallback
```
- Analysis: The P6.1-D contract states learning consumes `observedReturn` first with `return` as a legacy
  fallback. But the neighbourhood admission check tests the LEGACY field: a record with a finite
  `observedReturn` and a non-finite `return` is excluded from the neighbourhood entirely, so its contract target
  never contributes — and conversely a record can pass the gate on `return` while contributing a different
  `observedReturn` value. No shipped producer currently diverges (orchestrator, backfill and rescore all stamp
  `return === observedReturn`), so this is latent, but it quietly contradicts the "observedReturn first" claim
  at exactly the gate where eligibility is decided, and `estimatorTargetLine`'s "consumed [...]" counts are
  taken over the `return`-gated survivor set.
- Fix: gate on `Number.isFinite(readLearningTarget(neighbor.record))` in `selectNeighbors` (or document that
  the eligibility gate intentionally keys on `return`).

### [JITRL-8] Session-scoped authorization grants authorize requests that never identify their session (P3, dormant)
- File: src/jitrl/runtime-control.ts:425-438
- Evidence:
```ts
if (grant.sessionId !== undefined && sessionId !== undefined && grant.sessionId !== sessionId) {
  continue;
}
```
- Analysis: A grant restricted to `sessionId: 's1'` matches a request that supplies only a `branchId` and NO
  `sessionId`, because the mismatch check is guarded on both sides being defined. The module's own fail-closed
  stance ("Missing identity is fail-closed", "A session identity NEVER substitutes for a branch identity",
  ADR 0006 D-P4-1) argues the request must prove it belongs to the grant's session. Branch scoping is handled
  strictly (a grant without `branchId` cannot authorize a branch request at all); session scoping is not.
  Impact is currently nil — no production call site is wired (the module documents "no call site is wired in
  P4-A") — but the first C2 consumer inherits a fail-open session restriction.
- Fix: `if (grant.sessionId !== undefined && grant.sessionId !== sessionId) { continue; }` (a session-scoped
  grant then requires the request to name the same session), plus a test for grant-session + request-without-session.

### [JITRL-9] Backfill `appended` reports "records the store accepted" but counts the raw batch, overcounting on the documented dedup path (P3)
- File: src/jitrl/backfill.ts:130-136,505-516
- Evidence:
```ts
/** Number of records the store accepted (0 when the append failed). */
readonly appended: number;
...
try {
  await options.store.append(records);
  appended = records.length;      // even though the store dedupes by id (header: "the store keeps a single copy")
```
- Analysis: The module header guarantees idempotency ("re-running over the same pool appends the same ids,
  which the store deduplicates"), so on a re-run every record is a duplicate, nothing new is stored, yet
  `appended === recordCount` and `index.ts` accumulates it into `backfilled` (`backfilled += result.appended`).
  The metric contradicts its own doc on exactly the path (re-backfill) the idempotency design invites.
  Diagnostics-only; no reward or eligibility effect.
- Fix: derive `appended` from the store's ack when available, or rename/re-document the field as
  "records submitted for append" and stop summing it as a store-acceptance counter.

### [JITRL-10] `/evo jit reset <bucket>` drops a whole bucket with no confirmation; the guard covers only the global reset (P3)
- File: src/jitrl/commands.ts:392-401
- Evidence:
```ts
if (parsed.bucket === undefined && !parsed.confirm) {
  return { ... 'refusing to clear all experience without an explicit --confirm flag; nothing was dropped' ... }
}
const outcome = await controller.reset(parsed.bucket);
```
- Analysis: `reset bucket-a` (no `--confirm`) immediately drops every record of that bucket. Given the store is
  the learning evidence pool the writeback gate and value estimator consume, an unconfirmable bucket-wide
  destructive command is dubious, and the usage line (`reset [bucket] [--confirm]`) does not mark when
  `--confirm` is required. Possibly intended (the refusal text scopes the guard to "all experience"), but the
  asymmetry is undocumented and surprising.
- Fix: either require `--confirm` for bucket resets too, or document the asymmetry in `JIT_COMMAND_USAGE` and
  the reset result text.

## Positive verifications

### [OK-1] Closed-form logit math is implemented and guarded as documented
`adjustLogits` (src/jitrl/logit-adjuster.ts:174-186) computes exactly `center(z) + beta * A-tilde` with
`normalizeAdvantages` applied once to the raw advantages (the reported `normalizedAdvantage` in
`composeDecision` is the same single application — no double normalization); `softmax` rejects non-finite
logits, uses max-shift stability, and validates the normalizer; `centerLogits` is softmax-invariant;
`klDivergence` is `KL(pi' || pi_prior)` and is exactly 0 when all advantages are 0 (cold start keeps the prior
argmax and `klToPrior = 0`), matching `tests/unit/jitrl/logit-adjuster.test.ts` (Figure-2 a2 choice at beta=1,
KL monotone in beta, tie-break by ascending actionKey, exploration draws consumed before the selection draw,
deterministic inverse-CDF sampling).

### [OK-2] Reward-version isolation holds end to end
`isLearningEligibleRecord` (src/jitrl/reward-contract.ts:499-515) enforces the three-way conjunction
(`learningEligible !== false`, schema ≥ 2 fail-closed on missing, EXACT contract id
`r4/verifier-first-v1` with only the certified `r4/verifier-first-v1@rescore-v1` companion — the r3 lineage
is empty both ways). The kernel re-exports it as the single predicate (`isLearningEligibleExperience`,
decision-kernel.ts:740-742), the store uses the same constant (`CURRENT_REWARD_VERSION ===
REWARD_CONTRACT_VERSION`, experience-store.ts:97), surrogate backfill records are stamped
`BACKFILL_REWARD_VERSION` + `learningEligible: false` (backfill.ts:467-498), rescored records require a
validated provenance chain bound to the current contract/weights hash (`isValidRescoreProvenance`), and the
migration produces marked copies without rewriting the source log (backfill.ts:694-782) — matching
`tests/unit/jitrl/reward-version-isolation.test.ts` and `eligibility-contract.test.ts`.

### [OK-3] The writeback gate's G-B mechanics and the rev6 result doc agree with the code
Thresholds are frozen exactly as preregistered (`minSupport: 3`, `minVerifiedRate: 0.8`,
`maxCounterexamples: 0`, writeback-gate.ts:93-100, pinned by writeback-gate.test.ts:74-80); a single
counterexample vetoes regardless of pass rate; an unreadable snapshot (`undefined`) is distinguished from a
genuinely empty store (`history-unusable` vs `rejected-insufficient-support`); judging happens once per
executed trajectory against a history that cannot vouch for itself (`before = createdAt`); and the rev6
result doc's headline numbers (0 admitted / 180 audited, `gateFired = 180`, all `rejected-no-verdict`, effect
on C3 reported as `not-evaluable` rather than a benefit) are consistent with the implementation's structural
facts — the doc does not overclaim.

### [OK-4] Online/replay parity is structural, not incidental
The replay hook (src/jitrl/index.ts:1007+, `createJitReplayHook`) is a shell over the same
`runDecisionKernel` the L1 decorator calls (src/jitrl/jit-active-policy.ts:1081-1112), with the slot-kind
neighbour projection shared via `projectNeighborsBySlotKind` and the slot-kind parser duplicated only behind a
test-pinned equality assertion (`slotKindOfMetaActionKey` vs `slotKindOfActionKey`); the seeded path is fully
deterministic (mulberry32 + FNV seed derivation) and the learning-facing survival abort
(`LearningFacingSurvivalError`) fires before the replay hook's degrade-to-prior catch, matching
`tests/unit/jitrl/decision-kernel-parity.test.ts`.
