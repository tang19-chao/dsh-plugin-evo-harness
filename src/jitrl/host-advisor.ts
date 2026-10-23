/**
 * L3 host tool-call JitRL advisor (plan section 3.3; Phase 5, P5-a).
 *
 * Ownership: src/jitrl/** (Phase 5 kernel). Wiring into the host hooks stays in
 * the cordis seam (P5-b), so this module is a pure, injectable unit.
 *
 * The host LLM never exposes the logits of its tool choice, so L3 cannot apply
 * the closed-form logit correction of L1/L2. Plan section 3.3 keeps exactly two
 * degraded implementations, both default-off:
 *
 *   advisory (agent/pre-step): retrieve the host_tool neighbourhood of the
 *     current abstract state, estimate Q/V/A for every evidenced tool action,
 *     and when some action is clearly worse than the rest (normalized advantage
 *     A-tilde below `hostAdvisor.adviseThreshold`) render a short
 *     `<jitrl_advice>` block. Per the section 7.2 negative-evidence firewall,
 *     negative advantages may only appear inside `<anti_patterns_to_avoid>`;
 *     they are never phrased as a recommendation.
 *   gate (tools/pre-execute): when the action about to run has A-tilde below
 *     `hostAdvisor.gateThreshold` and at least `minSupport` neighbours, return
 *     { kind: 'ask', reason } so the harness asks the user. There is no 'deny'
 *     decision kind at all (contract HOST_ADVISOR_DECISION_KINDS and the
 *     compile-time NO_DENY guard below); the advisor can annotate or defer to
 *     the user, but it can never block a tool call on its own.
 *
 * Which action is judged:
 *   - gate mode judges the newest `recentTools` entry (the pending/branch-head
 *     call, since the host hook payload has no dedicated pending-action field);
 *   - advisory mode judges the worst evidenced action, because section 3.3
 *     item 1 is a generic "some tool action is bad in this state" annotation.
 *   Both fall back to the worst evidenced action when the focused key has no
 *   evidence, and both no-op when the neighbourhood is empty.
 *
 * Safety properties (all covered by tests):
 *   - `hostAdvisor.enabled: false` returns noop('host_advisor_disabled') for
 *     every request and performs zero retrieval.
 *   - an injected store/retriever that throws, or a malformed retrieval result,
 *     degrades to noop with a diagnostic and never propagates to the host turn.
 *   - the injected text is bounded by MAX_ADVISORY_TOKENS (300) using
 *     estimateTokens(), a deterministic, dependency-free estimator; when the
 *     evidence does not fit, lines are dropped (tag structure survives) and a
 *     `advisory_truncated` diagnostic is recorded.
 *   - only statistics leave this module: action keys, neighbour counts, mean
 *     returns and advantages. Raw ExperienceRecords are never rendered.
 *
 * Diagnostics contract: HostAdvisorDiagnostics.advantage carries A-tilde, the
 * exact quantity compared against `threshold`; the raw advantage is
 * recoverable as meanReturn - stateValue.
 */

import type { JitRlConfig } from '../config';
import {
  HOST_ADVISOR_DECISION_KINDS,
  type AbstractState,
  type ExperienceQuery,
  type HostAdvisorAdvisoryDecision,
  type HostAdvisorAskDecision,
  type HostAdvisorDecision,
  type HostAdvisorDecisionKind,
  type HostAdvisorDiagnostics,
  type HostAdvisorNoopDecision,
  type HostAdvisorRequest,
  type HostToolCallObservation,
  type JitCandidate,
  type ScoredExperience,
  type WorkingDirectorySummary
} from '../types/contracts';
import { redactSecrets } from './redaction';
import { abstractHostState } from './state-abstraction';
import { toExperienceQuery } from './retriever';
import {
  estimateActionValues,
  estimateStateValue,
  normalizeAdvantages,
  selectNeighbors,
  type ActionValueEstimate,
  type ValueEstimatorConfig
} from './value-estimator';

/** Hard budget for the injected advisory text, in estimated tokens. */
export const MAX_ADVISORY_TOKENS = 300;

/** Task-id prefix of every advisory block injected into the host turn. */
export const ADVISORY_TAG = 'jitrl_advice';

/** Slot that may carry negative evidence (plan section 7.2). */
export const ANTI_PATTERN_TAG = 'anti_patterns_to_avoid';

const ADVICE_OPEN = '<' + ADVISORY_TAG;
const ANTI_OPEN = '<' + ANTI_PATTERN_TAG + '>';
const ANTI_CLOSE = '</' + ANTI_PATTERN_TAG + '>';
const ADVICE_CLOSE = '</' + ADVISORY_TAG + '>';

/** Longest action key / bucket fragment emitted into the injected text. */
const RENDER_LIMIT = 64;

/**
 * Compile-time proof that the advisor can never deny a tool call: were 'deny'
 * ever added to HostAdvisorDecisionKind, Extract<...> would yield 'deny', this
 * type would collapse to `never` and this assignment would stop compiling.
 */
type NoDenyDecisionKind = Extract<HostAdvisorDecisionKind, 'deny'> extends never
  ? true
  : never;

/** Runtime witness of the compile-time no-deny guard; always true. */
export const HOST_ADVISOR_NEVER_DENIES: NoDenyDecisionKind = true;

/**
 * Deterministic, dependency-free token estimate.
 *
 * ASCII characters count 4 per token (the usual English average; conservative
 * for code and identifiers) and every non-ASCII code point counts as one token
 * (CJK is >= 1 token per character). The estimator never needs a tokenizer, so
 * the 300-token budget is reproducible across machines and test runs, and it
 * errs high rather than low for the mixed-language advice this module emits.
 */
export function estimateTokens(text: string): number {
  let narrow = 0;
  let wide = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint > 0x7f) {
      wide += 1;
    } else {
      narrow += 1;
    }
  }
  return Math.ceil(narrow / 4) + wide;
}

/** Minimal, always-budget-safe advisory block used as the truncation floor. */
function minimalAdvice(neighborCount: number): string {
  return [
    ADVICE_OPEN +
      ' mode="advisory" level="host_tool" neighbors="' +
      String(neighborCount) +
      '" truncated="true">',
    'recommend none (evidence truncated to fit the token budget)',
    ANTI_OPEN,
    ANTI_CLOSE,
    ADVICE_CLOSE
  ].join('\n');
}

/** Redact and bound one free-text fragment before it reaches the host prompt. */
function safeFragment(value: string): string {
  const singleLine = value.replace(/[\r\n\t]+/g, ' ');
  const redacted = redactSecrets(singleLine).replace(/["<>]/g, "'");
  const trimmed = redacted.trim();
  return trimmed.length <= RENDER_LIMIT ? trimmed : trimmed.slice(0, RENDER_LIMIT) + '…';
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : String(value);
}

/** One evidenced tool action, as consumed by the decision rules and renderer. */
interface ActionEvidence {
  readonly actionKey: string;
  /** Weighted mean neighbour return for this action (Q estimate). */
  readonly meanReturn: number;
  /** Neighbour support |N(s, a)|. */
  readonly support: number;
  /** Raw advantage A = Q - V. */
  readonly advantage: number;
  /** Normalized advantage A-tilde in (-1, 1); the compared quantity. */
  readonly normalizedAdvantage: number;
}

/** Store seam: anything with IExperienceStore.query's shape. */
export interface HostAdvisorStore {
  query(query: ExperienceQuery): Promise<readonly ScoredExperience[]>;
}

/**
 * Retriever seam. Receives the abstract state and the query it was built from,
 * so a snapshot retriever can reuse retriever.ts (retrieveNeighbors) and a
 * store-backed retriever can be either sync or async.
 */
export type HostAdvisorRetriever = (
  state: AbstractState,
  query: ExperienceQuery
) => readonly ScoredExperience[] | Promise<readonly ScoredExperience[]>;

/** Estimator seam; defaults to value-estimator.ts estimateActionValues. */
export type HostAdvisorEstimator = typeof estimateActionValues;

/** Factory options. `enabled` comes from config.jitrl.hostAdvisor.enabled. */
export interface HostAdvisorOptions {
  /** Frozen plugin config; supplies thresholds, k, similarity and exploration. */
  readonly config: JitRlConfig;
  /** Experience store seam (queried when no retriever is injected). */
  readonly store?: HostAdvisorStore;
  /** In-memory/custom retriever seam; takes precedence over `store`. */
  readonly retriever?: HostAdvisorRetriever;
  /** Value estimator seam; defaults to estimateActionValues. */
  readonly estimator?: HostAdvisorEstimator;
  /** Injected clock; when present it also causally truncates retrieval at now. */
  readonly now?: () => number;
  /** Injected randomness forwarded to the estimator. */
  readonly rng?: () => number;
}

/** The constructed L3 advisor. */
export interface HostAdvisor {
  /** Evaluate one host decision point. Never throws; degrades to noop. */
  evaluate(request: HostAdvisorRequest): Promise<HostAdvisorDecision>;
  /** Append-only diagnostic lines (failures, truncation, disabled skips). */
  diagnostics(): readonly string[];
}

function noopDecision(
  reason: string,
  diagnostics?: HostAdvisorDiagnostics
): HostAdvisorNoopDecision {
  return {
    kind: 'noop',
    reason,
    ...(diagnostics === undefined ? {} : { diagnostics })
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name + ': ' + redactSecrets(error.message);
  }
  if (typeof error === 'string') {
    return redactSecrets(error);
  }
  return 'unknown';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function finiteOr(value: unknown, fallback: number): number {
  return isFiniteNumber(value) ? value : fallback;
}

/** A usable L3 abstract state: right level, token set present, keys stringy. */
function isHostToolState(value: unknown): value is AbstractState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const state = value as Partial<AbstractState>;
  return (
    state.level === 'host_tool' &&
    typeof state.bucket === 'string' &&
    Array.isArray(state.tokens) &&
    typeof state.summary === 'string'
  );
}

function isRequestLike(value: unknown): value is HostAdvisorRequest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<HostAdvisorRequest>;
  return isHostToolState(candidate.state) || Array.isArray(candidate.recentTools);
}

function recentToolList(request: HostAdvisorRequest): readonly HostToolCallObservation[] {
  return Array.isArray(request.recentTools) ? request.recentTools : [];
}

/** Coarse working-directory category; the raw path never becomes a token. */
function workingDirCategory(summary: WorkingDirectorySummary | undefined): string {
  if (summary === undefined || typeof summary.path !== 'string') {
    return 'unknown';
  }
  const normalized = summary.path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (normalized.length === 0) {
    return 'unknown';
  }
  if (/(^|\/)(tmp|temp|tempdir)(\/|$)/.test(normalized)) {
    return 'tmp';
  }
  if (/(^|\/)(users|home)\/[^/]+$/.test(normalized)) {
    return 'home';
  }
  return 'repo';
}

/**
 * Resolve the abstract state of this decision point. A valid pre-computed
 * host_tool state is trusted as-is; otherwise it is derived from the observed
 * recent tools, errors and working-directory digest (the plan section 3.3
 * input shape), so the advisor is usable stand-alone.
 */
function resolveState(request: HostAdvisorRequest): AbstractState {
  if (isHostToolState(request.state)) {
    return request.state;
  }
  const tools = recentToolList(request);
  const last = tools[tools.length - 1];
  const errors = Array.isArray(request.errors) ? request.errors : [];
  const hasError =
    errors.length > 0 || (last !== undefined && last !== null && last.isError === true);
  return abstractHostState({
    recentToolNames: tools.map((tool) => String(tool?.toolName ?? '')),
    lastErrorClass: hasError ? 'tool_error' : 'none',
    workingDirCategory: workingDirCategory(request.workingDirectory)
  });
}

/** Newest observed call's action key: explicit actionKey, else the tool name. */
function focusActionKeys(request: HostAdvisorRequest): readonly string[] {
  const tools = recentToolList(request);
  const last = tools[tools.length - 1];
  if (last === undefined || last === null || typeof last !== 'object') {
    return [];
  }
  const keys: string[] = [];
  if (typeof last.actionKey === 'string' && last.actionKey.length > 0) {
    keys.push(last.actionKey);
  }
  if (typeof last.toolName === 'string' && last.toolName.length > 0) {
    keys.push(last.toolName);
  }
  return keys;
}

/**
 * Apply the section 7.3 drift factor to neighbours whose record was written by
 * a superseded policy. A store that already reported driftWeight wins: the
 * factor is never applied twice.
 */
function applyDrift(
  neighbors: readonly ScoredExperience[],
  policyId: string | undefined,
  driftRho: number | undefined
): readonly ScoredExperience[] {
  if (policyId === undefined || driftRho === undefined || driftRho >= 1) {
    return neighbors;
  }
  const rho = driftRho < 0 ? 0 : driftRho;
  return neighbors.map((neighbor) => {
    if (neighbor.driftWeight !== undefined || neighbor.record.policyId === policyId) {
      return neighbor;
    }
    const base = neighbor.weight ?? neighbor.similarity;
    if (!isFiniteNumber(base) || base <= 0) {
      return neighbor;
    }
    return { ...neighbor, weight: base * rho, driftWeight: rho };
  });
}

/**
 * Keep only genuine neighbours. The store query already carries
 * `similarityThreshold`, but an injected retriever is a foreign seam: mirroring
 * retriever.ts (similarity strictly positive, at or above the threshold) keeps
 * the "no evidence -> do nothing" rule independent of the source's diligence.
 */
function filterBySimilarity(
  neighbors: readonly ScoredExperience[],
  similarityThreshold: number
): readonly ScoredExperience[] {
  return neighbors.filter(
    (neighbor) =>
      isFiniteNumber(neighbor.similarity) &&
      neighbor.similarity > 0 &&
      neighbor.similarity >= similarityThreshold
  );
}

/** Deterministic worst-first ordering: A-tilde asc, mean return asc, key asc. */
function compareWorstFirst(left: ActionEvidence, right: ActionEvidence): number {
  if (left.normalizedAdvantage !== right.normalizedAdvantage) {
    return left.normalizedAdvantage - right.normalizedAdvantage;
  }
  if (left.meanReturn !== right.meanReturn) {
    return left.meanReturn - right.meanReturn;
  }
  return left.actionKey < right.actionKey ? -1 : left.actionKey > right.actionKey ? 1 : 0;
}

function evidenceLine(prefix: string, evidence: ActionEvidence): string {
  return (
    prefix +
    ' ' +
    safeFragment(evidence.actionKey) +
    ' (meanReturn=' +
    formatNumber(evidence.meanReturn) +
    ', n=' +
    String(evidence.support) +
    ', tilde=' +
    formatNumber(evidence.normalizedAdvantage) +
    ')'
  );
}

interface RenderedAdvice {
  readonly text: string;
  readonly antiPatterns: readonly string[];
  readonly truncated: boolean;
}

/**
 * Render the advisory block under the hard token budget.
 *
 * Recommendations (A-tilde > 0) come first, best first; anti-patterns
 * (A-tilde < 0) live inside <anti_patterns_to_avoid>, most negative first.
 * When the assembly exceeds MAX_ADVISORY_TOKENS the least informative lines
 * are dropped (the tags and therefore the block structure always survive) and,
 * if even the tags cannot fit, a fixed minimal block is emitted. Every drop is
 * recorded as a diagnostic; the returned text is always within budget.
 */
function renderAdvice(entries: readonly ActionEvidence[]): RenderedAdvice {
  const sorted = [...entries].sort(compareWorstFirst);
  const recommendable = sorted
    .filter((entry) => entry.normalizedAdvantage > 0)
    .sort((left, right) => compareWorstFirst(right, left));
  const avoidable = sorted.filter((entry) => entry.normalizedAdvantage < 0);

  const header = (neighborCount: number, truncated: boolean): string =>
    ADVICE_OPEN +
    ' mode="advisory" level="host_tool" neighbors="' +
    String(neighborCount) +
    '"' +
    (truncated ? ' truncated="true"' : '') +
    '>';

  const assemble = (
    recommendLines: readonly string[],
    avoidLines: readonly string[]
  ): string => {
    const lines: string[] = [];
    if (recommendLines.length === 0) {
      lines.push('recommend none (no positive-advantage action observed)');
    } else {
      lines.push(...recommendLines);
    }
    lines.push(ANTI_OPEN);
    lines.push(...avoidLines);
    lines.push(ANTI_CLOSE);
    lines.push(ADVICE_CLOSE);
    return lines.join('\n');
  };

  let recommendLines = recommendable.map((entry) => evidenceLine('recommend', entry));
  let avoidLines = avoidable.map((entry) => evidenceLine('avoid', entry));
  const neighborCount = entries.reduce((total, entry) => total + entry.support, 0);
  let truncated = false;

  const fits = (recommend: readonly string[], avoid: readonly string[]): boolean =>
    estimateTokens(header(neighborCount, truncated) + '\n' + assemble(recommend, avoid)) <=
    MAX_ADVISORY_TOKENS;

  while (!fits(recommendLines, avoidLines)) {
    if (avoidLines.length >= recommendLines.length && avoidLines.length > 0) {
      avoidLines = avoidLines.slice(0, -1);
    } else if (recommendLines.length > 0) {
      recommendLines = recommendLines.slice(0, -1);
    } else {
      break;
    }
    truncated = true;
  }

  let text =
    header(neighborCount, truncated) + '\n' + assemble(recommendLines, avoidLines);
  if (estimateTokens(text) > MAX_ADVISORY_TOKENS) {
    text = minimalAdvice(neighborCount);
    truncated = true;
  }

  return { text, antiPatterns: avoidLines, truncated };
}

function toDiagnostics(
  mode: 'advisory' | 'gate',
  evidence: ActionEvidence,
  stateValue: number,
  threshold: number
): HostAdvisorDiagnostics {
  return {
    actionKey: evidence.actionKey,
    meanReturn: evidence.meanReturn,
    support: evidence.support,
    stateValue,
    advantage: evidence.normalizedAdvantage,
    threshold,
    mode
  };
}

/**
 * Create the L3 host advisor. With `config.hostAdvisor.enabled === false` every
 * request returns noop without touching the store, retriever or estimator.
 */
export function createHostAdvisor(options: HostAdvisorOptions): HostAdvisor {
  const config = options.config;
  const hostAdvisor = config.hostAdvisor;
  const estimator: HostAdvisorEstimator = options.estimator ?? estimateActionValues;
  const rng = options.rng ?? Math.random;
  const injectedNow = options.now;
  const diagnostics: string[] = [];

  /** Build the store query; `toExperienceQuery` owns the numeric validation. */
  const buildQuery = (
    state: AbstractState,
    before: number | undefined,
    request: HostAdvisorRequest
  ): ExperienceQuery => {
    const base = toExperienceQuery(state, {
      k: config.k,
      similarityThreshold: config.similarityThreshold,
      level: 'host_tool'
    });
    const policyId =
      typeof request.policyId === 'string' && request.policyId.length > 0
        ? request.policyId
        : undefined;
    const driftRho = isFiniteNumber(request.driftRho) ? request.driftRho : undefined;
    return {
      ...base,
      ...(before === undefined ? {} : { before }),
      ...(policyId === undefined ? {} : { policyId }),
      ...(driftRho === undefined ? {} : { driftRho })
    };
  };

  const evaluateEnabled = async (
    request: HostAdvisorRequest
  ): Promise<HostAdvisorDecision> => {
    if (!isRequestLike(request)) {
      diagnostics.push('invalid_request: no abstract state and no recentTools');
      return noopDecision('invalid_request');
    }
    if (options.retriever === undefined && options.store === undefined) {
      diagnostics.push('no_experience_source: neither store nor retriever injected');
      return noopDecision('no_experience_source');
    }

    const mode: 'advisory' | 'gate' =
      request.mode === 'gate' ? 'gate' : request.mode === 'advisory' ? 'advisory' : hostAdvisor.mode;
    const adviseThreshold = finiteOr(request.adviseThreshold, hostAdvisor.adviseThreshold);
    const gateThreshold = finiteOr(request.gateThreshold, hostAdvisor.gateThreshold);
    const minSupport = Math.max(
      0,
      Math.trunc(finiteOr(request.minSupport, hostAdvisor.minSupport))
    );
    const threshold = mode === 'gate' ? gateThreshold : adviseThreshold;

    const state = resolveState(request);
    const clock = isFiniteNumber(request.now)
      ? request.now
      : injectedNow === undefined
        ? undefined
        : injectedNow();
    const query = buildQuery(
      state,
      isFiniteNumber(clock) ? clock : undefined,
      request
    );

    let fetched: readonly ScoredExperience[];
    try {
      const source = options.retriever;
      fetched =
        source !== undefined
          ? await source(state, query)
          : await (options.store as HostAdvisorStore).query(query);
    } catch (error) {
      diagnostics.push('retrieval_failed: ' + describeError(error));
      return noopDecision('retrieval_failed');
    }
    if (!Array.isArray(fetched)) {
      diagnostics.push('retrieval_failed: source returned a non-array');
      return noopDecision('retrieval_failed');
    }

    const drifted = applyDrift(fetched, query.policyId, query.driftRho);
    const selected = selectNeighbors(
      state,
      filterBySimilarity(drifted, config.similarityThreshold)
    );
    if (selected.length === 0) {
      diagnostics.push('no_neighbors: no host_tool experience within similarityThreshold');
      return noopDecision('no_neighbors');
    }

    const actionKeys = [...new Set(selected.map((neighbor) => neighbor.record.actionKey))].sort();
    const candidates: JitCandidate<undefined>[] = actionKeys.map((actionKey) => ({
      actionKey,
      baseLogit: 0,
      source: 'policy_prior',
      payload: undefined
    }));
    const estimatorConfig: ValueEstimatorConfig = {
      lambda: config.exploration.lambda,
      alpha: config.exploration.alpha,
      unseenFallback: config.unseenFallback
    };
    const estimates: readonly ActionValueEstimate[] = estimator(
      state,
      selected,
      candidates,
      estimatorConfig,
      rng
    );
    const stateValue = estimateStateValue(selected);
    const normalized = normalizeAdvantages(estimates.map((estimate) => estimate.advantage));

    const evidence: ActionEvidence[] = [];
    for (let index = 0; index < estimates.length; index += 1) {
      const estimate = estimates[index] as ActionValueEstimate;
      const meanReturn = estimate.q;
      if (meanReturn === null || !Number.isFinite(meanReturn)) {
        continue;
      }
      const normalizedAdvantage = normalized[index];
      evidence.push({
        actionKey: estimate.actionKey,
        meanReturn,
        support: estimate.support,
        advantage: estimate.advantage,
        normalizedAdvantage: isFiniteNumber(normalizedAdvantage) ? normalizedAdvantage : 0
      });
    }
    if (evidence.length === 0) {
      diagnostics.push('no_supported_action: no evidenced tool action to judge');
      return noopDecision('no_supported_action');
    }

    const worst = [...evidence].sort(compareWorstFirst)[0] as ActionEvidence;
    let target = worst;
    if (mode === 'gate') {
      for (const key of focusActionKeys(request)) {
        const focused = evidence.find((entry) => entry.actionKey === key);
        if (focused !== undefined) {
          target = focused;
          break;
        }
      }
    }

    if (mode === 'gate') {
      if (target.normalizedAdvantage < gateThreshold && target.support >= minSupport) {
        const ask: HostAdvisorAskDecision = {
          kind: 'ask',
          reason:
            'host tool action "' +
            safeFragment(target.actionKey) +
            '" has tilde=' +
            formatNumber(target.normalizedAdvantage) +
            ' (meanReturn=' +
            formatNumber(target.meanReturn) +
            ', n=' +
            String(target.support) +
            ') below gateThreshold=' +
            formatNumber(gateThreshold) +
            '; asking the user before executing. The advisor never denies a tool call.',
          suggestedActionKey: target.actionKey,
          diagnostics: toDiagnostics(mode, target, stateValue, threshold)
        };
        return ask;
      }
      return noopDecision(
        target.support < minSupport
          ? 'gate_min_support: n=' +
              String(target.support) +
              ' < minSupport=' +
              String(minSupport)
          : 'gate_threshold: tilde=' +
              formatNumber(target.normalizedAdvantage) +
              ' >= gateThreshold=' +
              formatNumber(gateThreshold),
        toDiagnostics(mode, target, stateValue, threshold)
      );
    }

    if (target.normalizedAdvantage < adviseThreshold) {
      const rendered = renderAdvice(evidence);
      if (rendered.truncated) {
        diagnostics.push(
          'advisory_truncated: evidence trimmed to fit ' +
            String(MAX_ADVISORY_TOKENS) +
            ' tokens'
        );
      }
      const advisory: HostAdvisorAdvisoryDecision = {
        kind: 'advisory',
        text: rendered.text,
        antiPatterns: rendered.antiPatterns,
        diagnostics: toDiagnostics(mode, target, stateValue, threshold)
      };
      return advisory;
    }
    return noopDecision(
      'advise_threshold: tilde=' +
        formatNumber(target.normalizedAdvantage) +
        ' >= adviseThreshold=' +
        formatNumber(adviseThreshold),
      toDiagnostics(mode, target, stateValue, threshold)
    );
  };

  return {
    async evaluate(request: HostAdvisorRequest): Promise<HostAdvisorDecision> {
      if (!hostAdvisor.enabled) {
        // Default-off must cost nothing: no store, retriever or estimator call.
        return noopDecision('host_advisor_disabled');
      }
      try {
        return await evaluateEnabled(request);
      } catch (error) {
        // Failure safety: a broken seam degrades to "do nothing", never a throw
        // into the host turn and never a blocked tool call.
        diagnostics.push('advisor_failed: ' + describeError(error));
        return noopDecision('advisor_failed');
      }
    },
    diagnostics: () => [...diagnostics]
  };
}

/** Decision kinds the advisor may emit; re-exported for host-side assertions. */
export const HOST_ADVISOR_EMITTABLE_KINDS: readonly HostAdvisorDecisionKind[] =
  HOST_ADVISOR_DECISION_KINDS;
