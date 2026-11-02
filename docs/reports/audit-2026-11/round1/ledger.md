# Audit scope: ledger (two-phase settlement, WAL, metering, pricing)

## Verified facts summary
Audited src/ledger/* (assembly, ledger-event, limits, pricing, reconciliation, reservation-manager, two-phase, types, usage-report, wal, index) and src/dsh-bridge/metered-model-adapter.ts, cross-checked against tests/unit/ledger/* (p3c-cancellation-recovery, pr3b-limits-reconciliation, audit-consistency, metering-coverage) and docs/adr/0004 + docs/reports/t23. Seven findings were confirmed by executable reproduction (scratch vitest file, run then deleted); the rest are code-traced. The core reserve/settle/WAL machinery is solid (idempotent settle, sequence flooring, fail-closed WAL read, genuine conservation identity), but the two-phase call-index layer adds crash windows that permanently lock funds or double-charge, and two metering-coverage gaps let real provider spend bypass the ledger.

## Findings

### [LEDGER-1] `bookNewAttempt` has no redelivery idempotency — the same late usage is double-charged (P0)
- File: src/ledger/two-phase.ts:749
- Evidence:
  ```ts
  const origin = this.index.lookup(event.originCallId);
  const callId = event.originCallId + '#new-attempt-' + String(this.index.newAttempts().length + 1);
  ```
- Analysis: Each invocation derives a FRESH callId from `newAttempts().length + 1`, then `beginCall` + `settleCall` books the usage. There is no idempotency key (no dedupe on originCallId+reason+usage). Late-usage delivery is explicitly at-least-once in this design — `reconcileLateUsage` even names "a safe re-delivery" (`previouslyReconciled`, two-phase.ts:162) and is redelivery-safe — but the `bookNewAttempt` escape hatch handles the same redelivery-prone input class without any protection. A crash (or an I/O error) after `settleCall` booked the cost but before the result is returned makes the caller retry, and the retry books the same spend a second time under `origin#new-attempt-2`. **Verified by repro**: calling `bookNewAttempt` twice with the identical event produced two callIds and `settledMicros = 2 × 3,000µ`.
- Fix: Derive the attempt callId deterministically from the event (e.g. `originCallId + '#new-attempt-' + hash(originCallId|reason|receivedAt|providerCallId)`) and return the existing settlement if that callId is already tracked/settled; or refuse a second new-attempt for the same originCallId unless the reason differs.

### [LEDGER-2] Crash/I-O window between ledger settle and call-index record permanently locks funds and blocks late usage (P1)
- File: src/ledger/two-phase.ts:655-667
- Evidence:
  ```ts
  const result = this.manager.settle({ ...request, interim });
  if (!result.isIdempotentReplay) {
    if (interim) {
      this.index.recordInterim(request.callId, {...});
  ```
- Analysis: `manager.settle` fsyncs `EVENT_SETTLED` to the WAL; `index.recordInterim` fsyncs the call index in a *separate* file. A crash between the two writes (or any fs error in the index append) leaves the ledger settled but the index identity at `'reserved'`. After recovery, `recoverFromWal()` restores `settledCalls`, so a settle retry returns `isIdempotentReplay=true` — which SKIPS the index write again, so the index can never advance. `reconcileLateUsage` then refuses with `LATE_USAGE_BEFORE_TERMINATION` forever, and the reserved buffer stays held with no sanctioned way to book it (bridges cannot reach `manager.reconcileLateUsage` directly — structural debt B). **Verified by repro**: after simulating the window and recovery, `identityOf(callId).state === 'reserved'`, late usage throws `LATE_USAGE_BEFORE_TERMINATION`, and 10,000µ remain reserved. The same window exists in `beginCall` (manager.reserve + its WAL event fsynced, then index.recordReservation): a failure there orphans a live reservation whose callId is unknown to the index.
- Fix: In `settleCall`, on `isIdempotentReplay` with `identity.state === 'reserved'`, still call `recordInterim`/`recordFinal` to bring the index forward (the operations are idempotent appends). For `beginCall`, record the index mapping BEFORE `manager.reserve` (or add a recovery scan that back-fills index identities from `EVENT_RESERVED` payloads, which already carry callId/rateCard/reservedCostMicros).

### [LEDGER-3] `reconcileLateUsage` silently drops usage and books 0 when no rate card is available (P1)
- File: src/ledger/reservation-manager.ts:1137-1159
- Evidence:
  ```ts
  } else if (usage && effectiveRateCard) {
      costCalc = calculateUsageCost(usage, effectiveRateCard);
      newIncurredCost = costCalc.totalCostMicros;
  } else {
      newIncurredCost = previousIncurred;   // 0 for a crash-recovered reservation
  ```
- Analysis: If `usage` is provided but no rate card exists anywhere (recovered reservation without a frozen card, no request card, no manager default — exactly the shape of WAL events written before rate-card freezing, or managers built without a default card), the usage is silently DISCARDED and `previousIncurred` (0 for a `pending_reconciliation` reservation with no settled record) is booked. The reserved buffer is then released to the pool with zero cost booked. This contradicts (a) ADR-0003 §7.3.5 ("unknown must never silently book 0", enforced everywhere else), (b) `settle()`'s own sibling branches (usage + no card → reserved upper bound; no usage + card → conservative floor), and (c) the in-file comment at :1091-1093 which says `reconcile({actualCostMicros:0})` "cannot silently erase a real incurred cost" — the no-data branch erases exactly that. Note the audit-consistency F8 tests always pass an explicit card or `actualCostMicros`, so this branch is unpinned. **Verified by repro**: a crash-recovered 10,000µ reservation reconciled with measured usage worth 3,000µ and no card booked `incurredCostMicros = 0`, released the reservation, and reported `provenance: 'unknown'`.
- Fix: In the final `else` branch, when `usage` is present but no card is available, book the conservative fallback (rate-card floor or the hardcoded 10,000µ floor used by `settle()`, provenance 'unknown', conservative=true) instead of `previousIncurred`; never release a pending buffer against a zero booking when usage was supplied.

### [LEDGER-4] Usage accounting report double-counts every reconciled call (P2)
- File: src/ledger/usage-report.ts:80-88
- Evidence:
  ```ts
  export function summarizeUsageAccounting(events: readonly UsageLedgerEvent[]): UsageAccountingReport {
    const costs = events.map((event) => event.cost);
  ```
- Analysis: `ledgerEvents` holds one event per settle/reconcile, and a reconciliation event carries the FULL new total (replacement semantics). For an interim-settled call the interim event already carries the computed cost (e.g. the conservative floor), so summing events yields `interimCost + reconciledCost` while the pools only ever booked the reconciled figure. **Verified by repro**: one interim settle (floor 1,000µ) + one reconcile (3,000µ) → report `totalCostMicros = 4,000` vs pool `settledMicros = 3,000`, and `totalCalls = 2` for one call. The adapter knows about this hazard — metered-model-adapter.ts:386-389 keeps a `bookedByCall` map precisely because "summing the per-call records would double count" — but the manager-level report (exposed via `getMeteringStatus().totalCostMicros` and `getUsageAccounting()`, and consumed by real-benefit-controller.ts:1737 for canary metering evidence) still sums events. Host cost reports overstate spend and `measured/estimated/unknown` shares are computed per event, not per call.
- Fix: Aggregate by callId keeping only the latest event per call (mirror the adapter's `bookedByCall`), or have `summarizeUsageAccounting` accept the settledCalls map; rename `totalCalls`/bucket `calls` to "events" if event-level semantics are kept.

### [LEDGER-5] Transport exceptions are treated as remote-confirmed `failed` and booked as real settled spend (P2)
- File: src/dsh-bridge/metered-model-adapter.ts:341-344
- Evidence:
  ```ts
  function outcomeOfError(error: unknown): ExecutionOutcome {
    const name = error instanceof Error ? error.name.toLowerCase() : '';
    return name.includes('abort') || name.includes('cancel') ? 'cancelled' : 'failed';
  }
  ```
- Analysis: `REMOTE_TERMINATED_OUTCOMES` (reservation-manager.ts:86-91) treats `'failed'` as proof the provider stopped, so `settleCall` settles FINAL. But any thrown exception that is not abort/cancel — ECONNRESET, DNS failure, HTTP 429/500 raised as an error — is mapped to `'failed'` even though the request may have reached the provider and may still be generating (the exact concern ADR-0004 §5.1 encodes; `stream_interrupted` is deliberately excluded from the confirmed set for this reason). With no usage payload, final settlement books the conservative fallback floor as settled spend and releases the seat. **Verified by repro**: an inner adapter throwing `ECONNRESET` produced `settlement: 'final'`, `settledMicros = 1,000µ` (the floor) and `outcome: 'failed'`. Systematically overcharges the budget for zero-token calls and frees a concurrency slot the provider may still occupy. (For quality evidence it is safe — `failed` is audit-only.)
- Fix: Map non-abort exceptions to a non-remote-confirmed outcome (`'infrastructure_error'` / `'stream_interrupted'`) so they settle INTERIM and hold funds/seats pending late usage or an external bill; reserve `'failed'` for provider-responded terminal errors (e.g. `finishReason === 'error'`).

### [LEDGER-6] Settle failure on the model-success path is swallowed without the `settle_failed` marker (P2)
- File: src/dsh-bridge/metered-model-adapter.ts:610-613
- Evidence:
  ```ts
          } catch {
            provenance = 'unknown';
          }
        }
        record({ callId, ..., provenance });   // success path: no `error` field
  ```
- Analysis: The module header (metered-model-adapter.ts:46-47) contracts: "The failure of a settlement is recorded on the call record (`settle_failed`) instead of being swallowed." The model-error path honors it (`settleFailure = true` → `error: 'settle_failed'`, lines 560-563/578), but the success-path catch sets only `provenance = 'unknown'` and records NO error marker, so `stats().settleFailures` undercounts and a call whose money movement failed looks like a healthy unmetered-success. Worse, `manager.settle` can throw AFTER money moved (e.g. the WAL append at reservation-manager.ts:984 fails with ENOSPC after `settledCalls`/pool counters were already updated), in which case the ledger booked spend that this record and `stats().costMicros` never show. **Verified by repro** with a poisoned settlement whose `settleCall` throws: record has `error === undefined`, `provenance === 'unknown'`.
- Fix: Mirror the error path: set `settleFailure = true` in the success-path catch and record `error: 'settle_failed'` (plus `heldCostMicros`/diagnostics) so the count gate and stats reflect it.

### [LEDGER-7] `LedgerCallIndex.load()` silently drops corrupted lines anywhere in the file, contradicting its own fail-closed comment (P2)
- File: src/ledger/two-phase.ts:302-308
- Evidence:
  ```ts
      } catch {
        // A crash can truncate exactly the final line. Anything else is corruption
        // and must not be silently skipped (it would drop a real mapping).
        continue;
      }
  ```
- Analysis: The comment says non-tail corruption must not be silently skipped, but the code `continue`s on ANY parse failure at ANY position. A torn or corrupted line mid-file silently deletes a real, fsynced `callId -> reservationId` mapping; late usage for that call is then refused with `LATE_USAGE_UNKNOWN_CALL`, and `assertManagerAlignedWithIndex` may throw `CALL_STATE_UNAVAILABLE`. The sibling WAL reader does this correctly — wal.ts:184-194 throws on corruption unless it is exactly the last non-empty line. **Verified by repro**: truncating the FIRST of two index lines loses `k1`'s identity with no error while `k2` loads normally.
- Fix: Replicate the WAL's rule: tolerate a JSON parse failure only when it is the last non-empty line; throw `TwoPhaseLedgerError` (new code, e.g. `INDEX_CORRUPT`) otherwise.

### [LEDGER-8] Ledger mutates state and the idempotency cache BEFORE the WAL append — a failed append leaves unlogged money movement that retries treat as done (P2)
- File: src/ledger/reservation-manager.ts:982-996
- Evidence:
  ```ts
    // Store for idempotent replay
    this.settledCalls.set(callId, result);
    this.walWriter.append('EVENT_SETTLED', { ... });
  ```
- Analysis: `settle()` updates pool counters, deletes the reservation, and inserts into `settledCalls` before `walWriter.append`. If the append throws (ENOSPC/EIO), the caller gets an exception, but a retry finds the idempotency entry and returns `isIdempotentReplay=true` WITHOUT ever re-attempting the append — the settlement is permanently absent from the WAL and a restart reverts it (the settled spend reappears as a dangling reservation). The same ordering exists in `reconcileLateUsage` (`settledCalls.set` at :1250 before the append at :1252) and in `reserve()` (pools/`activeReservations` mutated at :577-620 before the append at :622 — a failed append there leaks a live reservation the caller was told did not happen). This inverts the write-ahead discipline the module otherwise documents (ADR-0004 §6.1: the log record must gate the state change). Minor related nit: `writeSnapshot`/append never fsync the parent directory after create/rename, so POSIX rename durability is not guaranteed.
- Fix: Attempt the WAL append before exposing the mutation (append-then-apply), or wrap so that an append failure rolls back the in-memory change (or at minimum marks the idempotency entry "unlogged" so the retry re-appends). Add a best-effort parent-dir fsync after snapshot rename.

### [LEDGER-9] jitrl stage wiring never passes metering — logit-probe and LLM-judge spend bypasses the ledger (P2)
- File: src/jitrl/index.ts:332-341
- Evidence:
  ```ts
      logitSource = createAutoLogitSource({
        logitSource: jitrl.logitSource,
        ...(options.model === undefined ? {} : { model: options.model }),
        capabilities
      });
  ...
  const stepEvaluator = createStepEvaluator({
    reward: jitrl.reward, privacy: jitrl.privacy, ...(model), ...(surrogate), clock, rng
  });
  ```
- Analysis: `createAutoLogitSource`'s options type (src/jitrl/logit-sources.ts:288-294) has no `metering` field, so `createTokenLogprobSource` always receives `metering: undefined` and its `createMeteredModelAdapter(model, 'logit_probe', undefined)` builds an UNMETERED adapter; `createStepEvaluator` (src/jitrl/index.ts:339, src/jitrl/step-evaluator.ts:981-983) is likewise constructed without `options.metering`. Both stages then make real provider calls (`PROBE_REQUEST`, the judge prompt) that land in the global `ModelCallRegistry` with `provenance: 'none'` but are never reserved or settled in any ledger — real token spend invisible to budgets, watermarks and the cost report. The static metering-coverage gate (scripts/eval/metering-coverage.mjs, pinned by tests/unit/ledger/metering-coverage.test.ts:59-78) passes because it only counts `.complete(` call sites and these stages do wrap with `createMeteredModelAdapter` — the gate verifies call-site plumbing, not that a ledger is attached. By contrast proposer/composer/reflector/dreamer accept `options.metering` (documented "absent records calls without cost"), so the gap is specific to the jitrl wiring, which cannot even express it.
- Fix: Thread `MeteredModelOptions` through `AutoLogitSourceOptions` and `createStepEvaluator` options and pass the host's settlement from src/jitrl/index.ts, so jitrl stages reserve/settle like the other five stages.

### [LEDGER-10] Unreported reasoning/cacheWrite metrics do not degrade provenance — separately-billed reasoning can be undercharged with no unknown marker (P3)
- File: src/ledger/pricing.ts:33-35
- Evidence:
  ```ts
  for (const m of metrics) {
    if (!m) continue;           // unreported metrics are skipped, not 'unknown'
  ```
- Analysis: `aggregatePrecision` ignores absent metrics, so a payload with measured input/output but no `reasoningTokens` gets overall provenance `'measured'`. When `reasoningSeparatelyBilled` is true with `outputIncludesReasoning` true and reasoning unreported, `netOutputTokens` keeps the full raw output and `reasoningCostMicros = 0` — the reasoning portion is priced at the (usually lower) output rate or not at all, with `conservative=false` so no floor applies. Only `cacheRead` gets a compensating flag (`cacheReadUnavailable`), and the usage report counts only that dimension (usage-report.ts:84-86), so `unknownCalls`/`cacheReadUnknownCalls` understate what the provider never reported. `dimensionProvenance` records the truth per dimension, but nothing validates or surfaces reasoning/cacheWrite gaps.
- Fix: When `reasoningSeparatelyBilled` (or cacheWrite) is enabled and the metric is absent, mark provenance 'unknown' (conservative floor) or at minimum extend the `cacheReadUnavailable`-style flag and report counters to reasoning/cacheWrite.

### [LEDGER-11] No cross-process budget enforcement — two managers sharing a storageDir can each grant the full budget (P3)
- File: src/ledger/reservation-manager.ts:126-176
- Evidence:
  ```ts
  export class LedgerReservationManager {
    private generalTotalMicros: number;
    private generalReservedMicros = 0;
  ```
- Analysis: All pool counters, `seatOwners` and `callToReservation` are per-instance memory, while the WAL and call index are shared append-only files in `storageDir`. two-phase.ts:26-27 explicitly anticipates "a restart (or a second process)" joining late usage against the same files, but nothing serializes writers: two processes each grant reservations against their own counters (combined spend up to 2× budget), both append `EVENT_RESERVED` lines (replay merges both into one pool), and concurrent `saveSnapshot()` calls clobber each other's `ledger.snapshot.json` (pid-suffixed temp, same final name). Intra-process this is safe (see positive verification PV2), but the multi-process story the docs imply is unenforced.
- Fix: Either document/lock single-writer (e.g. a lockfile in storageDir held by the assembled ledger) or move admission decisions behind a shared arbiter; at minimum detect a foreign pid/hostname in the WAL tail and refuse to double-open.

### [LEDGER-12] External-bill reconciliation can never match a bill keyed by `providerCallId` (P3)
- File: src/ledger/reconciliation.ts:119-121
- Evidence:
  ```ts
  function matchKey(line: { callId?: string; providerCallId?: string }): string | undefined {
    return line.callId ?? line.providerCallId;
  }
  ```
- Analysis: Internal lines are keyed only by `callId`; a bill line carrying only `providerCallId` is keyed by that provider id and can never equal an internal callId, so such a bill yields 100% `unresolved` + every line in `unknownToLedger` even when the mapping exists. The join data is thrown away upstream: `LateUsageEvent.providerCallId` is declared "audit metadata" (two-phase.ts:133-134) and is never persisted by `recordReconciliation`/`recordFinal`, so there is no table to join against. The module honestly reports the mismatch rather than false-passing (see PV6), but §8.3's goal — comparing against the provider's own bill — is unreachable for real provider exports that expose only provider-side ids.
- Fix: Persist `providerCallId` on the call-index identity when late usage arrives (it is already in `LateUsageEvent`), and match internal lines against both identifiers in `reconcileWithExternalBill`.

## Positive verifications

- **PV1 — Two-phase settle idempotency on the main path holds.** A duplicate `settle()` returns the cached `SettleResult` with `isIdempotentReplay=true` and books nothing (src/ledger/reservation-manager.ts:713-720); repeated `reconcileLateUsage` is accounting-idempotent (delta = new − previousIncurred = 0), pinned by tests/unit/ledger/audit-consistency.test.ts F9 (:926-1006, including no duplicate overdraft variance) and tests/unit/ledger/p3c-cancellation-recovery.test.ts:113-118.
- **PV2 — No intra-process reservation race.** `reserve()` performs the seat check, watermark cap, admission and budget check and the map insertions in one synchronous block with no await (src/ledger/reservation-manager.ts:430-654), so two concurrent reserves cannot interleave or exceed seat/budget limits within a process; seat ownership is a single `Set<callId>` with idempotent `delete` (releaseSeatOwnership, :413-423), and audit-consistency F1 (:215-310) proves a stale release can never free another live call's seat.
- **PV3 — WAL replay neither double-counts nor drops events.** Recovery replays only events with `sequenceNumber > snapshot.lastSequenceNumber` on top of snapshot totals that already include in-flight reservations' money (src/ledger/reservation-manager.ts:1401-1437, 1436-1437), floors the writer sequence to the high-water mark (`ensureSequenceAtLeast`, wal.ts:83-87; pinned by audit-consistency F6 :656-750), and `readAllEvents` fails closed on any non-tail corruption while tolerating exactly a truncated final line (wal.ts:175-195).
- **PV4 — The conservation check is a genuine identity, not a tautology.** `verifyConservationLaw` cross-checks the pool counters against the sum of live reservation records and seat ownership, throwing `LEDGER_BALANCE_MISMATCH` on disagreement (src/ledger/reservation-manager.ts:1294-1327); audit-consistency F7 (:756-816) proves it detects forged pool-only and record-only snapshots with a consistent control.
- **PV5 — Pricing units and anti-double-count are correct.** All rates are micros-per-million tokens and every multiplication divides by 1_000_000 (src/ledger/pricing.ts:97-99, 112, 125; src/ledger/limits.ts:238-240 uses `Math.ceil` for bounds vs `Math.round` for actuals — a deliberate, documented asymmetry, not a unit error); cacheRead/cacheWrite default to the input rate when absent (types.ts:109-112), input/cacheRead and output/reasoning dedup match ADR-0003 §7.3, and T23 §3.3's hand calculations (2,640,000µ / 2,300,000µ) reproduce exactly.
- **PV6 — External reconciliation genuinely detects mismatches.** `reconcileWithExternalBill` classifies exact / within-tolerance / disputed / unresolved, surfaces `unknownToLedger` and `duplicateBillKeys`, sums `netDifferenceMicros` over matched lines only, and never mutates the ledger figure (src/ledger/reconciliation.ts:130-256); pinned by tests/unit/ledger/pr3b-limits-reconciliation.test.ts:622-704. (Effectiveness caveat for provider-keyed bills: LEDGER-12.)
