# Audit scope: verification + dsh-bridge

Files audited in full: `src/verification/{artifact-digest,attach,host-runner,index,quality-provenance,synthesized-tests,types}.ts`, `src/dsh-bridge/{agent-loop-executor,branch,cache-observation,clients,index,model-config,model,probe-safety,real-benefit-controller,real-benefit-host-client}.ts` (metered-model-adapter.ts excluded per scope). Cross-checked against `tests/unit/verification/*`, `tests/unit/dsh-bridge/*`, `tests/e2e/c2a-trusted-verification.test.ts`, `tests/e2e/c2b-quality-consumption.test.ts`, `docs/adr/0003-publish-verification-and-cost-contract.md`, and the production consumers in `src/orchestrator.ts` (`verifyTrajectory` :3574-3598, recorder two-gate block :2496-2519, C2b register-on-success :2764-2971) and `src/jitrl/{decision-kernel.ts:1493-1500, index.ts:644-690}`.

## Verified facts summary (2-5 lines)

The C2a trust chain is real and mostly sound: digests are host-recomputed (sha256 over an injective length-prefixed framing), attach enforces registry object-identity + full binding + digest equality before any attach, the receipt is stripped whenever authentication fails, empty-`checks`/implicit/foreign-binding rows are all rejected attach-side, and no config field can produce the verification seam. The C2b boundary is real: `synthesized-tests/v1` has zero production importers and its task-quality gate is type-level `allowed: false`; quality records register only under a complete `sha256:` host binding with register-on-success semantics and are consumed only through `isAuthenticatedQualityRecord` with a P0 fail-closed. The real defects found are one wrong-direction/numerically-invalid statistics gate (cache-observation), one authentication bypass in the stale-artifact audit row (attach), a cancellation/timeout mislabel in `branch.ts`, and several smaller robustness/honesty gaps. Note: `host-runner.ts` is an IN-PROCESS deterministic verifier — there is no subprocess, so injection/cwd/child-kill questions do not apply; the only timeout is the seam's `raceTimeout`.

## Findings

### [VERIF-1] Cache-optimization gate opens on wrong-direction or numerically-invalid sign tests (P1)
- File: src/dsh-bridge/cache-observation.ts:504-530 (gate), 433-446 (`exactSignTestP`)
- Evidence:
```ts
  // Rule 2: a real reduction must exist somewhere.
  if (reduced === 0) { return { status: 'measured-no-significant-reduction', ... }; }
  // Rule 3: significance over the discordant pairs.
  const p = exactSignTestP(reduced, increased);
  if (p > alpha) { return { status: 'measured-no-significant-reduction', ... }; }
  return { status: 'applicable', reason: 'measured cacheRead reduction is significant ...', ... };
```
- Analysis: two independent defects. (a) The two-sided sign test is direction-agnostic, but the gate never checks the direction of the significant result. With `reduced=1, increased=47` (48 discordant pairs), `exactSignTestP(1,47) = 2*(C(48,0)+C(48,1))/2^48 ≈ 3.5e-13 < 0.05`, so the gate returns `applicable` ("a same-task / same-budget / same-seed Tail Injection A/B is now justified") for a dataset where treatment is SIGNIFICANTLY WORSE — only `reduced >= 1` is required and `meanReduction` (strongly negative here) is reported but never gated. (b) `exactSignTestP` computes `2*tail / Math.pow(2, discordant)`; for `discordant > 1023` the denominator overflows to `Infinity` and the accumulated binomial coefficient overflows to `Infinity` around the middle of the range, so `p` becomes `Infinity/Infinity = NaN` (or an underflowed 0). `NaN > alpha` is false, so a near-balanced split over ~1500 pairs (true p ≈ 0.96) yields p=NaN and the gate returns `applicable`. The module's stated purpose is that `applicable` is the only output that justifies proposing the optimisation, so both paths produce a wrong decision output.
- Fix: (1) require the significant direction to be reduction — e.g. gate on `reduced > increased` (or `meanReduction > 0`) in addition to `p <= alpha`, or use a one-sided test in the reduction direction; (2) compute the binomial tail in log-space (or with exact BigInt / a normal approximation fallback) and treat any non-finite `p` as `not-computable` → `gated-not-applicable`, never as a pass.

### [VERIF-2] stale-artifact rejection marks the receipt `authenticated: true` without the registry identity check (P2)
- File: src/verification/attach.ts:432-441 (early return), 442-449 (the check it skips)
- Evidence:
```ts
  if (outcome.reasonCode === 'stale-artifact') {
    return reject(
      'stale-artifact',
      outcome.reason ?? 'the registered receipt was computed over an earlier artifact digest',
      verdictInfo(receipt),
      { receipt, authenticated: true }
    );
  }
  const registered = seam.runner.receiptFor(input.runId, trajectory.id, role);
  if (registered === undefined || registered !== receipt) {
    return reject('unregistered-receipt', ...);
  }
```
- Analysis: every other `authenticated: true` path (execution-not-completed, contradictory-verdict, falsified-success-claim, reference-receipt-missing, clean attach) runs AFTER the object-identity check `registered === receipt` against the runner's own registry. The stale-artifact row returns before that check, so any runner handed to the public `deps.verification` seam can return `{ receipt: <forged>, reasonCode: 'stale-artifact' }` and the disposition is written with `authenticated: true` plus the forged receipt's `verdict`/`verifierId`/`verifierVersion`/`verificationId`/`testSetId`/`envId`. The receipt itself is NOT attached (the scorer never sees it), but `verificationRewardMarks` (attach.ts:611-622) honors the host verdict when `authenticated === true`, so the persisted `rewardSources.verificationVerdict` becomes attacker-chosen — exactly the "forged audit injects verificationVerdict marks" class the t18/F-3 hardening (tests/unit/verification/audit-provenance.test.ts header) closed for forged trajectory metadata; a lying RUNNER reopens it on this one row. The repo's own e2e suite (tests/e2e/c2a-trusted-verification.test.ts:183-190) explicitly treats host-injected seams as the reachable forgery path.
- Fix: run the registry identity check BEFORE handling `outcome.reasonCode` (i.e. move the `registered !== receipt` rejection above the stale-artifact branch), or set `authenticated: false` on the stale-artifact rejection, or verify `seam.runner.receiptFor(...) === receipt` inside the stale branch before claiming authentication.

### [VERIF-3] branch.ts records cancellation as a `timeout` failure signal, contradicting the executor discipline and polluting the failure taxonomy (P2)
- File: src/dsh-bridge/branch.ts:257-261, 359-365, 402-407; contrast src/dsh-bridge/agent-loop-executor.ts:29-32
- Evidence:
```ts
    if (context.signal.aborted) {
      recorder.push('system', { text: 'probe cancelled before dispatch' });
      recorder.fail('timeout', 'the probe branch was aborted before dispatch', { repairable: true });
```
and, on cancellation mid-flight / in the catch: `recorder.fail('timeout', 'the probe branch was aborted while the model call was in flight', ...)`.
- Analysis: agent-loop-executor.ts documents the deliberate rule "cancellation settles status 'aborted' (and deliberately does NOT claim the 'timeout' signal kind), a real wall-clock overrun settles 'timeout'". branch.ts violates it: every cancellation path writes `kind: 'timeout'`. The signal has real consumers: `classifyTrajectoryOutcome` (src/jitrl/step-evaluator.ts:410-413) keys the `timeout` outcome off `failureSignals.kind === 'timeout' || 'budget_exhausted'` for failed-status trajectories, and `signalsFromTrajectory` (src/dream-rsi/failure-taxonomy.ts:135-154) feeds the signal verbatim into the failure taxonomy that drives repair guidance — a user cancellation is counted in the timeout failure family. Status is still 'aborted' so the C2a abnormal gate is unaffected, but the persisted signal is factually wrong and the two executors disagree on the same taxonomy.
- Fix: record cancellation with a non-timeout kind (e.g. `'unknown'` with the abort message, or a dedicated `'cancelled'` kind added to the frozen vocabulary) in all three branch.ts paths, matching the agent-loop-executor discipline.

### [VERIF-4] agent-loop-executor: pre-try code can reject `runBranch`, violating its own "never a rejection" contract (P3)
- File: src/dsh-bridge/agent-loop-executor.ts:549 (`extractToolGuidance`), 707-713 (`messages` IIFE), try starts at 782
- Evidence:
```ts
    const guidance = extractToolGuidance(context.patch);   // before try
    ...
    const messages: readonly ModelMessage[] = (() => {
      const built = (adapters.buildMessages ?? defaultAgentProbeMessages)(context);
      const systemPrompt = adapters.systemPrompt?.(context);
```
- Analysis: the file's catch block states "A planner or tool that threw outside its own catch block still yields a trajectory: the seam manager must never receive a rejection" (lines 1343-1345), but `extractToolGuidance` (which dereferences `patch.edits` unguarded), caller-supplied `buildMessages`, and `systemPrompt` all run OUTSIDE the try. A throwing builder rejects `runBranch`; the seam manager then degrades via its own catch (seam-manager.ts:324-326) to a collector-only `finalize` that carries no executor-recorded failure signal — the trajectory loses the structured failure diagnostics the in-try paths produce, and the executor's documented guarantee is broken.
- Fix: move `extractToolGuidance` and the message construction inside the try (after the pre-dispatch guards), or wrap them so a throw becomes `settle('failed', …)`.

### [VERIF-5] agent-loop-executor: a throwing `settleCall` abandons an active ledger reservation and erases its identity (P3)
- File: src/dsh-bridge/agent-loop-executor.ts:616-625
- Evidence:
```ts
    const settleLedgerCall = (request: SettleRequest): void => {
      if (settlement === undefined) { return; }
      try {
        ledgerCallRefs.push(settlement.settleCall(request).identity);
      } catch (error) {
        diagnostic('ledger settlement failed for call "' + request.callId + '": ' + errorMessageOf(error));
      }
    };
```
- Analysis: if `settleCall` throws mid-settlement, the reservation may remain open (money + seat held for the life of the process) and the `ledgerCallRefs.push` is skipped, so the callId→reservationId identity never reaches `callIdentities()` / `metadata.ledgerCalls`. The file itself calls this exact state "the exact leak the two-phase lifecycle must not create" (comment at lines 1058-1062 for the assertDecision path) — the leak it guards against everywhere else is reintroduced whenever the settlement call itself fails. Downstream late-usage reconciliation for that callId becomes impossible through the sanctioned surface.
- Fix: on settlement failure, still record the callId/reservationId (push a best-effort identity entry, or expose a `failedSettlements()` list) and surface the reservation as unsettled in diagnostics so a host can reconcile or release it.

### [VERIF-6] agent-loop-executor: non-integer per-probe metadata budgets silently disable the wall-clock timer (P3)
- File: src/dsh-bridge/agent-loop-executor.ts:422-425 (`readPositiveInteger`), 538-540 (`resolveBudget`), 500-504 (adapter-level validation)
- Evidence:
```ts
function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}
const resolveBudget = (context: IsolatedBranchContext): number =>
  readPositiveInteger(context.metadata?.probeTimeoutMs) ?? defaultBudget;
```
- Analysis: adapter-level `probeTimeoutMs` accepts any finite non-negative number (line 501), but the per-probe metadata override accepts only positive INTEGERS. A host that injects a context with `metadata.probeTimeoutMs = 2500.5` (or any fractional value) silently falls back to `defaultBudget` — which is `0` (timer disabled) unless the adapter configured one — so the probe runs with NO wall-clock budget instead of the requested one, with no diagnostic. Same for `metadata.maxStepsPerProbe`. The production seam manager currently passes no metadata, so impact is confined to hosts that build `IsolatedBranchContext` directly, but the failure mode is silent (a bounded run becomes unbounded).
- Fix: accept any finite positive number for metadata budgets (validate at the boundary with the same rule as the adapter config), or emit a diagnostic when a metadata override is present but rejected.

### [VERIF-7] verificationRewardMarks: a clean-attached receipt degraded by an empty trustedProducers set persists `verificationAuditOnly: 0` on an audit-only record (P3)
- File: src/verification/attach.ts:617-622
- Evidence:
```ts
  return {
    outcomeEligible: input.outcomeEligible ? 1 : 0,
    verificationVerdict: verdict === 'passed' ? 1 : verdict === 'failed' ? 2 : 0,
    verificationTrusted: input.trustedSource ? 1 : 0,
    verificationAuditOnly: !input.consumed && (verdictDerived || disposition.auditOnly) ? 1 : 0
  };
```
- Analysis: with a custom runner whose `trustedProducers` does not contain its `verifierId` (the production runner always includes it, but the seam shape allows any set), a receipt attaches cleanly (`disposition.auditOnly === false`, `authenticated === true`) while the scorer degrades the verdict to `unknown` (`verdictDerived === false`) and `consumed === false`. The record then takes the audit branch (`learningEligible: false`, reward 0) but is persisted with `verificationAuditOnly: 0` — the mark claims "not audit-only" for a record that is audit-only by the consumption gate. The ADR §5.1 discriminator (`outcomeEligible=1 && learningEligible=false ⇒ audit encoding`) still identifies it, so this is a reporting inconsistency, not a trust hole.
- Fix: derive the mark from the record's actual encoding, e.g. include `!input.trustedSource` (or pass the record's learningEligible) into the `verificationAuditOnly` condition.

### [VERIF-8] raceTimeout abandons the runner without cancelling it; a late runner still registers a receipt after a runner-timeout rejection (P3)
- File: src/verification/attach.ts:305-326; src/verification/host-runner.ts:190
- Evidence:
```ts
    return await Promise.race([
      promise,
      new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
```
```ts
    registry.set(key, { digest, receipt });   // runs whenever verify() eventually settles
```
- Analysis: the seam timeout resolves the race but the runner's in-flight `verify` keeps running; when it eventually settles it STILL writes its receipt into the registry (side effect after the rejection). A later re-verification of the same trajectory then returns `{ duplicate: true, receipt }` and attaches cleanly — so the "runner-timeout ⇒ no verdict this run" decision is silently reversible by a retry, and the abandoned promise (and, for a synchronous check that blocks the event loop, the whole process) is unbounded. Trust-wise the late receipt is genuine (host-computed), so this is a lifecycle/leak issue rather than an integrity one.
- Fix: document the semantics, and either gate `verify` re-entry after a timeout for the same key (refuse with `runner-timeout` until the in-flight work settles) or have the runner record timed-out keys and skip registration when the deadline already fired.

### [VERIF-9] real-benefit-controller settles a client-thrown stream — including an `aborted` finish — as FINAL 'failed' (P3)
- File: src/dsh-bridge/real-benefit-controller.ts:1345-1354
- Evidence:
```ts
      await hostClient
        .call({ prompt, perCallTokenCap: binding.tokenBudget.perCallTokens })
        .catch((error: unknown) => {
          // Transport failure with no usage: settle at the reserved ceiling
          // (conservative). A failed transport is a confirmed outcome (nothing
          // more will be generated for this callId), so the settlement is final.
          const settle = settlement.settleCall({ callId, reservationId: String(reserve.reservationId), outcome: 'failed' });
```
- Analysis: `createHostClientFromLlm` throws `DshModelStreamError(..., 'aborted')` when the stream settles with an `aborted` finish (real-benefit-host-client.ts:399-401) — i.e. the remote was cut mid-generation. The controller's catch cannot distinguish that from a pre-dial transport error and books the settlement FINAL at the reserved ceiling. The agent-loop-executor encodes the opposite (and per ADR-0004 §5.1 correct) rule for exactly this case: "a local cancel/timeout does NOT prove the remote stopped generating: the coordinator settles it INTERIM ... and the late usage merges into this SAME callId" (agent-loop-executor.ts:853-865). In the canary the only abort source is the caller's signal (not passed), so exposure is narrow, but a genuine mid-stream provider abort is booked as a confirmed ceiling spend instead of being held interim for late-usage reconciliation — the conservative direction for money, but it forfeits reconciliation and contradicts the plugin's own two-phase discipline.
- Fix: inspect `error instanceof DshModelStreamError && error.finishKind === 'aborted'` and settle `outcome: 'aborted_local'` (interim) for that case, reserving FINAL for pre-dial/confirmed-error throws.

### [VERIF-10] canary "measured" token totals are the double-counting gross sum, contradicting the module's own reporting claim (P3)
- File: src/dsh-bridge/real-benefit-host-client.ts:143-173, 180-196; consumed at src/dsh-bridge/real-benefit-controller.ts:1741-1763
- Evidence:
```ts
// real-benefit-host-client.ts header (lines 50-52):
//   ... Raw usage is recorded verbatim elsewhere; only the abort decision uses
//   the gross sum.
export function canaryUsageTokenCount(usage) { ... total += value; ... }  // sums ALL reported fields
```
- Analysis: `measuredTokens = canaryUsageTokenCount(usage)` sums input+output+cacheRead+cacheWrite+reasoning. With declared semantics `inputIncludesCacheRead: true` / `outputIncludesReasoning: true` (the DSH default, model.ts:56-60), that sum double-counts cacheRead and reasoning. The header states the gross sum is used "only [for] the abort decision" — but `measuredTokens` rides every `CanaryCallRecord` and `assembleResult` builds `measuredTotalTokens` / `measuredBaselineTokens` / `measuredTreatmentTokens` from it, presenting them as MEASURED gross in `tokenBudget` and gating the post-run caps on them. Over-counting is the safe direction for the caps, but the report overstates spend and the header's "reports keep the raw usage" claim is false for these fields.
- Fix: either rename/report these as `grossKillSwitchTokens` with the semantics caveat, or subtract declared-inclusion fields (cacheRead from input, reasoning from output) for the accounting/report path, keeping the raw `usageRaw` verbatim as it already is.

### [VERIF-11] synthesized-tests execution-trust receipts are self-sealed, not host-authenticated (P3, v2 forward-looking)
- File: src/verification/synthesized-tests.ts:636-640, 655-721
- Evidence:
```ts
export function computeSyntheticReceiptDigest(receipt: Omit<SyntheticTestReceipt, 'receiptDigest'>): string {
  return syntheticDigest(SYNTHETIC_RECEIPT_FRAMING_VERSION, receiptContentOf(receipt));
}
```
- Analysis: `verifySyntheticTestReceipt` accepts a receipt when `receipt.receiptDigest === computeSyntheticReceiptDigest(receipt)` — an unkeyed SHA-256 over the receipt's own content, computable by anyone. Unlike the C2a runner there is NO registry/object-identity or binding check, so any caller can mint a self-consistent receipt with `verifierId: 'anything'` and arbitrary results, and `assessSyntheticTestResult` will report `execution.trust: 'host-verified'`. In v1 this cannot reach task-quality (`gateSyntheticResultForTaskQuality` is type-level `allowed: false`, and calibration requires pre-registered thresholds on labelled cases), so it is confined to audit reports claiming "host-verified execution" for fabricated runs — but the "host-verified" label is forgeable by construction, which matters the moment a v2 gate ever consumes execution trust.
- Fix: have the receipt produced/registered by a host-owned runner instance (mirroring the C2a `(runId, trajectoryId, role)` registry + object-identity rule) or rename the trust state to something that does not assert host provenance (e.g. `self-consistent`).

### [VERIF-12] artifact-digest: duplicated `producedFiles` entries break the documented "one digest per file SET" property (P3)
- File: src/verification/artifact-digest.ts:29, 43-44
- Evidence:
```ts
  const producedFiles = [...(deliverable.producedFiles ?? [])].sort();
...
export function artifactBytes(artifact: HostArtifact): Buffer {
  const files = [...artifact.producedFiles].sort();
```
- Analysis: both sites sort but never deduplicate, so `producedFiles: ['a','a']` digests differently from `['a']` for the same logical file set, contradicting the doc comment "one digest per artifact, not one per ordering" (a set has no duplicates). Deterministic on both sides (host recomputes from the same trajectory), so there is no mismatch/forgery risk — only a claim/behaviour inconsistency that can produce confusingly different digests for logically identical artifacts when an upstream collector emits a duplicated listing.
- Fix: `Array.from(new Set(producedFiles)).sort()` in `artifactOf`/`artifactBytes`, or narrow the doc comment to "sorted multiset".

## Positive verifications

1. **The C2a digest/attach chain resists forging as claimed (ADR 0003 T1-T5 verified in code).** The digest is always recomputed by the host from artifact bytes over an injective, versioned, length-prefixed framing (`artifactBytes` prefixes both content and each file name with their UTF-8 byte length, so no framing ambiguity/collision-by-concatenation is possible); `verifyAndAttach` requires object identity with the runner's registry entry (`registered !== receipt` → `unregistered-receipt`), the full four-part binding + trajectory/session/role equality, `binding.artifactDigest === digest && receipt.evidenceHash === digest`, rejects empty `checks` attach-side exactly as ADR §4.6a(1) requires, rejects `implicit` payloads, strips any inherited `metadata.verification` on every non-attach path (T2), and overwrites `deliverable.contentHash` with the host digest so the scorer's `expectedEvidenceHash` branch genuinely runs (T3 / §4.6a(2)). The audit-mark channel is object-identity-keyed (WeakMap) and pinned to the trajectory id, and the e2e forged-seam tests (tests/e2e/c2a-trusted-verification.test.ts:311-413) demonstrate the forged receipt/audit marks are inert. `grep verification src/config.ts` = 0 hits, confirming §4.5.2 ("no config field produces this seam"). The stale-artifact row's `authenticated: true` gap (VERIF-2) is the one exception found.

2. **The C2a/C2b trust boundary between self-generated tests and trusted verification is real in code.** `synthesized-tests/v1` has zero production importers (`grep` over `src/` finds only the module and its test), its default policy is `enabled: false`, and `gateSyntheticResultForTaskQuality` returns `allowed: false` in every branch (type-level `readonly allowed: false`), so synthesized tests can never feed task-quality in v1 regardless of calibration or execution trust; content trust additionally requires freeze-before-candidates ordering, generator/candidate isolation, a textual holdout firewall, and pre-registered thresholds with explicit denominators. On the consumption side, `registerAuthenticatedQualityRecord` throws on any incomplete binding (all 11 fields + strict `sha256:[0-9a-f]{64}` digest shape), the orchestrator registers only task-quality records whose context is host-disposition-derived and rolls back pre-commit registrations around the store append (register-on-success, orchestrator.ts:2938-2971), and both consumers (`decision-kernel.ts:1499`, `jitrl/index.ts:676`) admit only `isAuthenticatedQualityRecord(...)` records with a P0 fail-closed when none authenticate — restored/stale records without a live registration are structurally untrusted.

3. **Agent-loop termination and cancellation hygiene hold up.** The loop is a bounded `for` over a strictly positive-integer `maxSteps` (non-integer/zero/NaN overrides fall back to the default and cannot loop forever); every await is raced against a `deadlinePromise` whose losing branch is explicitly marked handled (`call.catch(() => undefined)` + `deadlinePromise.catch(...)`), timeout and caller-abort are distinguished (`timedOut` vs `cancelled` with the timeout checked first), the deadline is unref'd/cleared and the abort listener removed in a `finally`, and every exit path funnels into `settle(...)` returning a finalized trajectory — the executor never rejects on planner/tool/decision errors, and a malformed planner decision still closes its ledger call before propagating (the P3-C leak fix at lines 1063-1077).

4. **probe-safety fails closed in every degenerate case, with self-validating counters.** An empty/whitespace tool name is denied (`invalid-request`), a disposed allowlist registry or ledger denies (`registry-disposed` / `ledger-disposed`), a BRANCH-scoped call hitting a `no-policy` registry answer is denied instead of inheriting the host-level transparency (`branchNoPolicy` counter + `validateProbeSafetyCounters` failing a snapshot where a policy was installed but any branch call fell through), tier 2 is consulted only after tier 1 allows, and the executor turns every refusal into a structured tool error without ever calling the tool runtime (tests/unit/dsh-bridge/probe-safety.test.ts:263-297 pins the "never calls the tool runtime when the gate refuses" property). The gate is inert (and says so via `checks: 0`) when no fence is configured, so unconfigured hosts keep byte-identical behaviour.
