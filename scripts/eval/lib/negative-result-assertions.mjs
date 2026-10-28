/**
 * PR-1: falsifiable assertions over the historical negative result.
 *
 * WHY THIS MODULE EXISTS (and why it is separate from the CLI)
 * ------------------------------------------------------------
 * `scripts/eval/negative-result-diag.mjs` used to only PRINT its findings and
 * always exit 0, so a regression that moved the reproduction away from the
 * historical -0.250 still reported "pass". A gate that cannot fail is not a
 * gate.
 *
 * The rules live here, as a pure function over an already-computed result, for
 * two reasons:
 *   1. they can be unit-tested against mutated copies of the real result, which
 *      is what proves each rule actually fires (a vacuous assertion is worse
 *      than no assertion, because it looks like coverage);
 *   2. the CLI stays a thin wiring layer - it computes the diagnostic, calls
 *      this function and maps `ok:false` to a non-zero exit code.
 *
 * This file deliberately has NO shebang, NO top-level await and NO side effects.
 * Vitest 3.2.7 does not strip a `#!` line when the file it transforms has CRLF
 * endings, so a shebang script with a CRLF worktree copy cannot be imported by
 * a test at all; the pure module is importable everywhere, and the CLI wiring is
 * asserted in a child process instead.
 *
 * OFFLINE: no network, no model call, no paid API.
 */

/**
 * JSON-only, locale-independent string comparison helper.
 *
 * @param {unknown} value
 * @returns {string}
 */
function asText(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * Split a verdict into clauses so a negation can be attached to the claim it
 * actually negates.
 *
 * The failure mode this avoids is the one that made the first two drafts of
 * this rule false-positive on the REAL report:
 *   - matching `/已确认根因/` fired on the legitimate disclaimer
 *     "（假设，非已确认根因）";
 *   - requiring an explicit disclaimer marker fired on honest abstentions such
 *     as "cannot-exclude" and "not-run (behavioural)" that make no causal claim
 *     at all.
 *
 * A clause-level check is the honest middle: a claim is only rejected when the
 * clause that states it carries no negation of its own.
 *
 * @param {string} text
 * @returns {string[]}
 */
function clauses(text) {
  return text
    .split(/[，。；、：:;,.!?！？()（）[\]【】]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Clause-level negation markers. */
const NEGATION = /[非不未无否]/;

/**
 * Does this verdict AFFIRM a confirmed root cause?
 *
 * Rejected shape: a clause containing 已确认根因 with no negation marker in that
 * clause and no negation in the clause immediately before it (Chinese prose
 * commonly negates across the comma: "不当作已确认根因").
 *
 * Known limit, stated rather than hidden: this is a text heuristic over free
 * prose, not a formal grammar. It can be fooled by a claim that negates
 * something else in the same clause. The structural companion assertion below
 * (`boundaries` must state that the probes are hypotheses) is what keeps the
 * heuristic from being the only line of defence.
 *
 * @param {string} verdict
 * @returns {boolean}
 */
export function affirmsConfirmedRootCause(verdict) {
  const parts = clauses(verdict);
  for (let index = 0; index < parts.length; index += 1) {
    if (!parts[index].includes('已确认根因')) {
      continue;
    }
    if (NEGATION.test(parts[index])) {
      continue;
    }
    const previous = index > 0 ? parts[index - 1] : '';
    if (previous.length > 0 && NEGATION.test(previous)) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Evaluate the PR-1 assertions A1..A6 against a computed diagnostic result.
 *
 * @param {any} data the object `negative-result-diag.mjs` assembles
 * @returns {{ok: boolean, failures: string[]}}
 */
export function evaluateAssertions(data) {
  /** @type {string[]} */
  const failures = [];

  // A1: the reproduction must still land in the historical frame. The script's
  // own `matchesHistorical` is |meanDelta - (-0.250)| < 0.05; asserting the flag
  // AND the number means a future edit to the tolerance cannot silently widen
  // the gate.
  if (data?.reproduction?.matchesHistorical !== true) {
    failures.push(
      'A1 historical-frame-drift: reproduction.meanDelta=' +
        String(data?.reproduction?.meanDelta) +
        ' is outside |delta - (-0.250)| < 0.05'
    );
  }
  if (data?.reproduction?.historical !== -0.25) {
    failures.push(
      'A1 historical-frame-drift: recorded historical anchor is ' +
        String(data?.reproduction?.historical) +
        ', expected -0.25'
    );
  }

  // A2: the negative result is task-specific; a flat mean shift would mean the
  // degraded-task evidence disappeared.
  const degraded = data?.reproduction?.degradation?.degradedTasks ?? [];
  if (degraded.length === 0) {
    failures.push('A2 no-degraded-tasks: the negative result lost its per-task evidence');
  }

  // A3: every counterexample must be replayable. The real shape is
  // { taskId, counterexample: { replay, observed } }, so assert the payload and
  // the coordinates that make a replay meaningful.
  for (const example of data?.minimalCounterexamples ?? []) {
    const taskId = example?.taskId;
    const replay = example?.counterexample;
    if (replay === undefined || replay === null || typeof replay !== 'object') {
      failures.push('A3 counterexample-not-replayable: ' + String(taskId ?? '<unknown>') + ' has no counterexample payload');
      continue;
    }
    if (typeof taskId !== 'string' || taskId.length === 0) {
      failures.push('A3 counterexample-not-replayable: a counterexample has no taskId');
    }
    const coordinates = replay.replay;
    if (coordinates === undefined || coordinates === null || typeof coordinates !== 'object') {
      failures.push('A3 counterexample-not-replayable: ' + String(taskId) + ' has no replay coordinates');
    } else {
      for (const field of ['protocol', 'seed', 'task', 'run', 'round', 'chosenChoice', 'priorChoice']) {
        if (coordinates[field] === undefined || coordinates[field] === null) {
          failures.push('A3 counterexample-not-replayable: ' + String(taskId) + ' is missing replay.' + field);
        }
      }
    }
  }

  // A4: the ledger must stay payload-free.
  const fields = data?.decisionLedger?.fields ?? [];
  for (const forbidden of ['prompt', 'patchBody', 'deliverableText', 'rawContent']) {
    if (fields.includes(forbidden)) {
      failures.push('A4 ledger-not-payload-free: field ' + forbidden + ' is present');
    }
  }

  // A5a: no hypothesis may ASSERT a confirmed root cause.
  for (const hypothesis of data?.hypotheses ?? []) {
    const verdict = asText(hypothesis?.verdict);
    if (affirmsConfirmedRootCause(verdict)) {
      failures.push('A5 hypothesis-claims-root-cause: ' + String(hypothesis?.id) + ' => ' + verdict);
    }
  }

  // A5b: the structural companion. The report must still SAY that its
  // discriminators are hypotheses, so the text rule above is never the only
  // thing standing between a hypothesis and a claim.
  const boundaries = Array.isArray(data?.boundaries) ? data.boundaries : [];
  const hasHypothesisBoundary = boundaries.some(
    (line) => asText(line).includes('假设') && asText(line).includes('已确认根因')
  );
  if (!hasHypothesisBoundary) {
    failures.push('A5 boundary-disclaimer-missing: no boundary states that the discriminators are hypotheses, not confirmed root causes');
  }

  // A6: the H4 benefit gate must NOT have silently passed. A probe that starts
  // passing its preregistered gate has been promoted to a default by accident.
  const gate = data?.improvementStrategyGates?.h4GateOnValidationSplit;
  if (gate !== undefined && gate !== null && gate.benefitGatePassed === true) {
    failures.push(
      'A6 strategy-gate-silently-passed: h4GateOnValidationSplit.benefitGatePassed became true ' +
        '(a probe must not be promoted to a default without an explicit decision)'
    );
  }

  return { ok: failures.length === 0, failures };
}

/**
 * The assertion catalogue, exposed so documentation and tests can cite ids
 * without re-implementing the rule.
 */
export const ASSERTION_IDS = Object.freeze({
  A1: 'historical-frame-drift',
  A2: 'no-degraded-tasks',
  A3: 'counterexample-not-replayable',
  A4: 'ledger-not-payload-free',
  A5: 'hypothesis-claims-root-cause / boundary-disclaimer-missing',
  A6: 'strategy-gate-silently-passed'
});
