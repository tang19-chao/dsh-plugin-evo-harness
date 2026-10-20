/**
 * Dream-RSI failure taxonomy.
 *
 * Ownership: src/dream-rsi/** (Wave 1, Dream-RSI layer).
 *
 * Classifies a completed probe (trajectory plus tree history) into the
 * four-way Dream-RSI taxonomy plus 'none' (ARCHITECTURE.md 5.1, recovery slot):
 *
 * - hard_unrecoverable    : model refusal / exhausted budget / aborted run.
 *                           Nothing in this line can be repaired.
 * - repairable_implementation : syntax, import or interface bug in a freshly
 *                           written script/plugin. Repair the artifact and
 *                           re-probe instead of discarding the design.
 * - weak_underexplored    : too little evidence, no deliverable, timeout or a
 *                           conflicting memory premise. Search harder or move on.
 * - repeatedly_unpromising: the same lineage already failed the threshold number
 *                           of times. Abandon the direction.
 * - none                  : the probe succeeded.
 *
 * Precedence is fixed and evidence-driven so the same trajectory always yields
 * the same diagnosis: hard > repeated > repairable > weak.
 */

import type {
  DiscoveryNode,
  FailureCategory,
  FailureDiagnosis,
  FailureSignal,
  FailureSignalKind,
  ProbeTrajectory,
  ToolErrorRecord
} from '../types/contracts';

/** Signal kinds that make a run unrecoverable. */
export const HARD_FAILURE_SIGNALS: readonly FailureSignalKind[] = [
  'model_refusal',
  'budget_exhausted'
];

/** Signal kinds that indicate a repairable implementation defect. */
export const REPAIRABLE_FAILURE_SIGNALS: readonly FailureSignalKind[] = [
  'tool_error',
  'syntax_error',
  'import_error',
  'invalid_patch'
];

/** Signal kinds that indicate an under-explored direction. */
export const WEAK_FAILURE_SIGNALS: readonly FailureSignalKind[] = [
  'timeout',
  'no_deliverable',
  'memory_conflict',
  'unknown'
];

const SYNTAX_HINTS = [
  'syntax',
  'parse error',
  'parsing error',
  'unexpected token',
  'unexpected end',
  'unterminated',
  'cannot compile',
  'failed to compile',
  'typeerror'
];
const IMPORT_HINTS = [
  'cannot find module',
  'module not found',
  'failed to resolve',
  'importerror',
  'modulenotfounderror',
  'no such file or directory',
  'does not provide an export'
];
const TIMEOUT_HINTS = [
  'timeout',
  'timed out',
  'etimedout',
  'deadline exceeded',
  'aborted'
];
const INVALID_PATCH_HINTS = [
  'invalid patch',
  'schema validation',
  'malformed',
  'invalid json',
  'is not assignable'
];

function containsAny(haystack: string, needles: readonly string[]): boolean {
  const lower = haystack.toLowerCase();
  for (const needle of needles) {
    if (lower.includes(needle)) {
      return true;
    }
  }
  return false;
}

/** Map one tool error record onto the richer failure-signal model. */
export function signalFromToolError(error: ToolErrorRecord): FailureSignal {
  const text = (error.code ?? '') + ' ' + error.message;
  let kind: FailureSignalKind = 'tool_error';
  if (containsAny(text, SYNTAX_HINTS)) {
    kind = 'syntax_error';
  } else if (containsAny(text, IMPORT_HINTS)) {
    kind = 'import_error';
  } else if (containsAny(text, TIMEOUT_HINTS)) {
    kind = 'timeout';
  } else if (containsAny(text, INVALID_PATCH_HINTS)) {
    kind = 'invalid_patch';
  }
  const signal: FailureSignal = {
    kind,
    message: error.message,
    toolName: error.toolName
  };
  if (error.code !== undefined) {
    (signal as { code?: string }).code = error.code;
  }
  if (error.stepIndex !== undefined) {
    (signal as { stepIndex?: number }).stepIndex = error.stepIndex;
  }
  if (error.retryable !== undefined) {
    (signal as { retryable?: boolean }).retryable = error.retryable;
  }
  if (error.stack !== undefined) {
    (signal as { evidence?: string }).evidence = error.stack;
  }
  return signal;
}

/** Collect every failure signal attached to a trajectory. */
export function signalsFromTrajectory(
  trajectory: ProbeTrajectory
): readonly FailureSignal[] {
  const out: FailureSignal[] = [];
  const seen = new Set<string>();
  for (const signal of trajectory.failureSignals) {
    const key = signal.kind + '|' + signal.message;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(signal);
    }
  }
  for (const error of trajectory.toolErrors) {
    const signal = signalFromToolError(error);
    const key = signal.kind + '|' + signal.message;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(signal);
    }
  }
  if (trajectory.error !== undefined) {
    const signal: FailureSignal = {
      kind: 'unknown',
      message: trajectory.error.message
    };
    if (trajectory.error.code !== undefined) {
      (signal as { code?: string }).code = trajectory.error.code;
    }
    const key = signal.kind + '|' + signal.message;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(signal);
    }
  }
  if (trajectory.status === 'timeout') {
    const signal: FailureSignal = {
      kind: 'timeout',
      message: 'probe timed out after ' + String(trajectory.metrics.durationMs) + 'ms'
    };
    const key = signal.kind + '|' + signal.message;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(signal);
    }
  }
  return out;
}

/** Input for one diagnosis. */
export interface FailureDiagnosisRequest {
  readonly trajectory?: ProbeTrajectory | null;
  /** Extra signals not carried by the trajectory. */
  readonly signals?: readonly FailureSignal[];
  readonly toolErrors?: readonly ToolErrorRecord[];
  readonly node?: DiscoveryNode | null;
  /** Prior diagnoses for the same lineage, oldest first. */
  readonly previousDiagnoses?: readonly FailureDiagnosis[];
  /** 1-based attempt counter for this lineage. */
  readonly attemptIndex?: number;
  /** Overrides the taxonomy default (3). */
  readonly repeatedFailureThreshold?: number;
  /** Caller knowledge that new directions remain unexplored. */
  readonly hasUnexploredDirections?: boolean;
  readonly maxDepthReached?: boolean;
}

/** Options for the taxonomy implementation. */
export interface FailureTaxonomyOptions {
  readonly repeatedFailureThreshold?: number;
  /** Deliverable size below which a success is treated as thin evidence. */
  readonly minDeliverableChars?: number;
}

/** Failure classifier. */
export interface IFailureTaxonomy {
  diagnose(request: FailureDiagnosisRequest): FailureDiagnosis;
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function collectSignals(request: FailureDiagnosisRequest): readonly FailureSignal[] {
  const out: FailureSignal[] = [];
  const seen = new Set<string>();
  const push = (signal: FailureSignal): void => {
    const key = signal.kind + '|' + signal.message;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(signal);
    }
  };
  if (request.trajectory !== undefined && request.trajectory !== null) {
    for (const signal of signalsFromTrajectory(request.trajectory)) {
      push(signal);
    }
  }
  for (const signal of request.signals ?? []) {
    push(signal);
  }
  for (const error of request.toolErrors ?? []) {
    push(signalFromToolError(error));
  }
  return out;
}

function buildRepairHint(signals: readonly FailureSignal[]): string {
  const targets: string[] = [];
  for (const signal of signals) {
    if (signal.toolName !== undefined && !targets.includes(signal.toolName)) {
      targets.push(signal.toolName);
    }
  }
  const first = signals[0];
  const target = targets.length > 0 ? targets.join(', ') : 'the failing artifact';
  const message = first === undefined ? 'unspecified implementation error' : first.message;
  return (
    'Repair ' +
    target +
    ' in a targeted rewrite (' +
    message +
    '), then re-probe the same design.'
  );
}

function actionForHardCategory(signals: readonly FailureSignal[]): 'stop' | 'discard' {
  if (signals.some((signal) => signal.kind === 'budget_exhausted')) {
    return 'stop';
  }
  return 'discard';
}

/** Classify pure evidence (no taxonomy instance) for reuse by callers. */
export function classifyFailure(
  request: FailureDiagnosisRequest,
  options: FailureTaxonomyOptions = {}
): FailureDiagnosis {
  const threshold =
    request.repeatedFailureThreshold ?? options.repeatedFailureThreshold ?? 3;
  const signals = collectSignals(request);
  const history = request.previousDiagnoses ?? [];
  const priorFailures = history.filter((diagnosis) => diagnosis.category !== 'none');
  const attempts = request.attemptIndex ?? 1;
  const priorFailureCount = Math.max(priorFailures.length, Math.max(0, attempts - 1));
  const status = request.trajectory?.status;
  const nodeStatus = request.node?.status;
  const evidence: string[] = [];
  const minChars = options.minDeliverableChars ?? 1;
  const deliverableChars = request.trajectory?.deliverable?.content.length ?? 0;

  const hardSignals = signals.filter((signal) => HARD_FAILURE_SIGNALS.includes(signal.kind));
  const repairableSignals = signals.filter((signal) =>
    REPAIRABLE_FAILURE_SIGNALS.includes(signal.kind)
  );
  const repeatedExplicit = signals.some((signal) => signal.kind === 'repeated_failure');
  const memoryConflict = signals.some((signal) => signal.kind === 'memory_conflict');

  for (const signal of signals) {
    evidence.push(
      signal.kind +
        (signal.toolName === undefined ? '' : '[' + signal.toolName + ']') +
        ': ' +
        signal.message
    );
  }

  // 1. Success: no terminal failure to diagnose.
  if (status === 'succeeded' && hardSignals.length === 0 && !repeatedExplicit) {
    evidence.push('trajectory status succeeded');
    if (deliverableChars >= minChars) {
      evidence.push('deliverable produced (' + String(deliverableChars) + ' chars)');
    }
    return {
      category: 'none',
      confidence: 0.9,
      repairable: false,
      recommendedAction: 'stop',
      evidence,
      signals
    };
  }
  if (
    status === undefined &&
    signals.length === 0 &&
    (nodeStatus === 'succeeded' || nodeStatus === 'probing' || nodeStatus === 'scheduled')
  ) {
    evidence.push('node status ' + String(nodeStatus) + ' with no failure evidence');
    return {
      category: 'none',
      confidence: 0.6,
      repairable: false,
      recommendedAction: 'stop',
      evidence,
      signals
    };
  }

  // 2. Hard unrecoverable evidence in this run.
  if (hardSignals.length > 0 || status === 'aborted') {
    if (status === 'aborted') {
      evidence.push('trajectory status aborted');
    }
    const hasCode = hardSignals.some((signal) => signal.code !== undefined);
    return {
      category: 'hard_unrecoverable',
      confidence: hasCode ? 0.85 : 0.75,
      repairable: false,
      recommendedAction: actionForHardCategory(hardSignals),
      evidence,
      signals
    };
  }

  // 3. The same lineage keeps failing: abandon the direction.
  if (repeatedExplicit || priorFailureCount >= threshold) {
    if (priorFailureCount > 0) {
      evidence.push(
        'prior failures in lineage: ' +
          String(priorFailureCount) +
          ' (threshold ' +
          String(threshold) +
          ')'
      );
    }
    if (repeatedExplicit) {
      evidence.push('explicit repeated_failure signal');
    }
    return {
      category: 'repeatedly_unpromising',
      confidence: clamp01(0.55 + 0.1 * Math.min(priorFailureCount, 4)),
      repairable: false,
      recommendedAction: 'explore_elsewhere',
      evidence,
      signals
    };
  }

  // 4. Repairable implementation defect: targeted repair, keep the design.
  if (repairableSignals.length > 0) {
    const explicitlyRepairable = repairableSignals.some(
      (signal) => signal.repairable === true
    );
    const retryable = repairableSignals.some((signal) => signal.retryable === true);
    evidence.push(
      'repairable signals: ' +
        String(repairableSignals.length) +
        ' (' +
        repairableSignals.map((signal) => signal.kind).join(', ') +
        ')'
    );
    return {
      category: 'repairable_implementation',
      confidence: clamp01(
        0.6 + 0.1 * repairableSignals.length + (explicitlyRepairable || retryable ? 0.1 : 0)
      ),
      repairable: true,
      recommendedAction: 'repair',
      evidence,
      signals,
      repairHint: buildRepairHint(repairableSignals)
    };
  }

  // 5. Weak evidence: search harder or move to a different direction.
  const weakEvidence =
    signals.length > 0 ||
    status === 'failed' ||
    status === 'timeout' ||
    nodeStatus === 'failed' ||
    (request.trajectory !== undefined &&
      request.trajectory !== null &&
      status !== 'succeeded' &&
      deliverableChars < minChars);
  if (weakEvidence) {
    let action: FailureDiagnosis['recommendedAction'] = 'deepen';
    if (memoryConflict) {
      action = 'explore_elsewhere';
      evidence.push('recalled memory conflicted with observed behavior');
    }
    if (request.hasUnexploredDirections === false) {
      if (request.maxDepthReached === true) {
        action = 'explore_elsewhere';
        evidence.push('max depth reached with no unexplored directions');
      }
    } else if (request.hasUnexploredDirections === true) {
      action = 'deepen';
      evidence.push('unexplored directions remain, deepen the search');
    }
    if (signals.length === 0) {
      evidence.push('no explicit failure signal; treating as under-explored');
    }
    return {
      category: 'weak_underexplored',
      confidence: clamp01(0.45 + 0.05 * signals.length),
      repairable: false,
      recommendedAction: action,
      evidence,
      signals
    };
  }

  // 6. Nothing to diagnose.
  evidence.push('no trajectory, signals or node state supplied');
  return {
    category: 'none',
    confidence: 0.2,
    repairable: false,
    recommendedAction: 'stop',
    evidence,
    signals
  };
}

/** Whether a category should be retried with a targeted repair. */
export function isRepairableCategory(category: FailureCategory): boolean {
  return category === 'repairable_implementation';
}

class FailureTaxonomyImpl implements IFailureTaxonomy {
  private readonly options: FailureTaxonomyOptions;

  constructor(options: FailureTaxonomyOptions) {
    this.options = options;
  }

  diagnose(request: FailureDiagnosisRequest): FailureDiagnosis {
    return classifyFailure(request, this.options);
  }
}

/** Create a failure taxonomy (evidence-driven, no host dependencies). */
export function createFailureTaxonomy(
  options: FailureTaxonomyOptions = {}
): IFailureTaxonomy {
  return new FailureTaxonomyImpl(options);
}

/** Convenience wrapper around the default taxonomy. */
export function diagnoseFailure(
  request: FailureDiagnosisRequest,
  options: FailureTaxonomyOptions = {}
): FailureDiagnosis {
  return classifyFailure(request, options);
}

/** True when a diagnosis blocks any further probing of the lineage. */
export function isTerminalFailure(diagnosis: FailureDiagnosis): boolean {
  return (
    diagnosis.category === 'hard_unrecoverable' ||
    diagnosis.category === 'repeatedly_unpromising'
  );
}
