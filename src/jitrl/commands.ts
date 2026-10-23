/**
 * Pure /evo jit command layer (plan section 13.1, gap G2-2).
 *
 * Ownership: src/jitrl/commands.ts (P3-E).
 *
 * This module owns parsing, validation, rendering and JSON shaping only. It
 * performs no I/O and never touches the store directly: everything comes from
 * an injected JitCommandController, which src/index.ts implements from the live
 * kernel and the L1 decorator. Keeping the split here means the command layer
 * is deterministic and fully unit-testable with fakes.
 *
 * Privacy: all free text that reaches the rendered output is passed through the
 * shared redaction helpers (secrets and absolute paths), so status/explain can
 * never echo raw prompt text, credentials or instance paths.
 */

import type { JitLevel } from '../types/contracts';
import type { DerivedCacheStats } from './jit-active-policy';
import { redactAbsolutePaths, redactSecrets } from './redaction';

/** One (level, bucket) coverage row. */
export interface JitBucketCoverage {
  readonly level: JitLevel;
  readonly bucket: string;
  readonly count: number;
}

/** Source label of a candidate as rendered by explain. */
export type JitDecisionSource = 'llm' | 'policy_prior' | 'memory_augmented';

/** One explain-table row (plan section 13.1 columns). */
export interface JitDecisionRow {
  readonly candidate: string;
  readonly source: JitDecisionSource;
  /** Prior logit z(s, a), recovered as z' - beta * A-tilde. */
  readonly baseLogit: number;
  /** Q estimate; null when unsupported and not explored. */
  readonly q: number | null;
  readonly advantage: number;
  readonly normalizedAdvantage: number;
  /** Corrected logit z' = z + beta * A-tilde. */
  readonly adjustedLogit: number;
  readonly note: string;
}

/** One decision retained for status/explain. */
export interface JitRecentDecision {
  readonly decisionId: string;
  readonly level: JitLevel;
  readonly stateValue: number;
  readonly neighborCount: number;
  readonly klToPrior: number;
  readonly adjustments: readonly JitDecisionRow[];
  readonly rationale: string;
}

/** Result of a store reset request. */
export interface JitResetDrop {
  readonly dropped: number;
  /** False when the wired store driver exposes no reset operation. */
  readonly supported: boolean;
  readonly note?: string;
}

/**
 * Host-side capability surface. The plugin wires it to the live kernel and L1
 * decorator; tests inject deterministic fakes.
 */
export interface JitCommandController {
  isEnabled(): boolean;
  /** Set the volatile in-process switch; returns the new effective state. */
  setEnabled(enabled: boolean): boolean;
  levels(): readonly JitLevel[];
  storeSize(level: JitLevel): number;
  bucketCoverage(): readonly JitBucketCoverage[];
  cacheStats(): DerivedCacheStats | undefined;
  /** Most recent decisions, newest first, capped by the caller's limit. */
  recentDecisions(limit: number): readonly JitRecentDecision[];
  findDecision(runId: string): JitRecentDecision | undefined;
  reset(bucket?: string): Promise<JitResetDrop> | JitResetDrop;
}

/** Parsed command tokens (after the leading 'jit'). */
export interface ParsedJitCommand {
  readonly command: string;
  readonly runId?: string;
  readonly bucket?: string;
  readonly confirm: boolean;
}

/** Plain command result returned to the host. */
export interface JitCommandResult {
  readonly command: string;
  readonly ok: boolean;
  readonly text: string;
  readonly json: Readonly<Record<string, unknown>>;
  readonly usage?: string;
}

export const JIT_COMMAND_USAGE =
  'usage: /evo jit <status | explain <runId> | reset [bucket] [--confirm] | on | off>';

const EXPLAIN_COLUMNS = [
  'candidate',
  'source',
  'Base z',
  'Q̂',
  'Ã',
  "JitRL z'",
  'note'
] as const;

function scrub(text: string): string {
  // P3-FIX3: paths are turned into <path> BEFORE redactSecrets so the blob
  // patterns can never see (and destroy) a path like
  // C:/Users/.../jit-active-policy.ts.
  return redactSecrets(redactAbsolutePaths(text));
}

function finite(value: number, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function formatNumber(value: number | null): string {
  if (value === null) {
    return 'n/a';
  }
  return finite(value).toFixed(3);
}

/** Split a raw command string into tokens; empty input yields []. */
export function splitJitArgs(args: string): readonly string[] {
  return args
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/** Parse tokens after 'jit'. Unknown commands stay verbatim for the usage error. */
export function parseJitArgs(tokens: readonly string[]): ParsedJitCommand {
  const command = (tokens[0] ?? '').toLowerCase();
  const rest = tokens.slice(1);
  const confirm = rest.includes('--confirm') || rest.includes('-y');
  const positionals = rest.filter((token) => !token.startsWith('-'));
  const positional = positionals[0];
  if (command === 'explain') {
    return {
      command,
      confirm,
      ...(positional === undefined ? {} : { runId: positional })
    };
  }
  if (command === 'reset') {
    return {
      command,
      confirm,
      ...(positional === undefined ? {} : { bucket: positional })
    };
  }
  return { command, confirm };
}

function usageResult(): JitCommandResult {
  return {
    command: 'usage',
    ok: false,
    text: JIT_COMMAND_USAGE,
    json: { usage: JIT_COMMAND_USAGE },
    usage: JIT_COMMAND_USAGE
  };
}

function statusResult(controller: JitCommandController): JitCommandResult {
  const enabled = controller.isEnabled();
  const levels = controller.levels();
  const byLevel = levels.map((level) => ({ level, count: controller.storeSize(level) }));
  const total = byLevel.reduce((sum, entry) => sum + entry.count, 0);
  const buckets = controller.bucketCoverage()
    .map((entry) => ({
      level: entry.level,
      bucket: scrub(entry.bucket),
      count: entry.count
    }))
    .sort((left, right) => {
      if (left.level !== right.level) {
        return left.level < right.level ? -1 : 1;
      }
      return left.bucket < right.bucket ? -1 : left.bucket > right.bucket ? 1 : 0;
    });

  if (!enabled) {
    const text = [
      'jit status',
      'enabled: false',
      'levels: ' + levels.join(','),
      'storeSize: ' + String(total),
      'note: JitRL is disabled; no expense records are retrieved or recorded'
    ].join('\n');
    return {
      command: 'status',
      ok: true,
      text,
      json: {
        enabled: false,
        levels,
        storeSize: total,
        byLevel,
        buckets: [],
        cacheStats: null,
        recentDecisions: []
      }
    };
  }

  const cache = controller.cacheStats();
  const recent = controller.recentDecisions(10);
  const lines = [
    'jit status',
    'enabled: true',
    'levels: ' + levels.join(','),
    'storeSize: ' + String(total)
  ];
  for (const entry of byLevel) {
    lines.push('  level ' + entry.level + ': ' + String(entry.count));
  }
  lines.push('buckets: ' + String(buckets.length));
  for (const bucket of buckets) {
    lines.push('  ' + bucket.level + '|' + bucket.bucket + ': ' + String(bucket.count));
  }
  lines.push(
    cache === undefined
      ? 'cache: n/a'
      : 'cache: size=' +
          String(cache.size) +
          ' maxEntries=' +
          String(cache.maxEntries) +
          ' hits=' +
          String(cache.hits) +
          ' misses=' +
          String(cache.misses) +
          ' evictions=' +
          String(cache.evictions)
  );
  lines.push('recentDecisions: ' + String(recent.length));
  for (const decision of recent) {
    const maxAdvantage = decision.adjustments.reduce(
      (max, adjustment) => Math.max(max, Math.abs(adjustment.normalizedAdvantage)),
      0
    );
    lines.push(
      '  ' +
        decision.decisionId +
        ': V=' +
        formatNumber(decision.stateValue) +
        ' neighbors=' +
        String(decision.neighborCount) +
        ' kl=' +
        formatNumber(decision.klToPrior) +
        ' candidates=' +
        String(decision.adjustments.length) +
        ' maxAtilde=' +
        formatNumber(maxAdvantage)
    );
  }

  return {
    command: 'status',
    ok: true,
    text: lines.join('\n'),
    json: {
      enabled: true,
      levels,
      storeSize: total,
      byLevel,
      buckets,
      cacheStats: cache ?? null,
      recentDecisions: recent.map((decision) => ({
        decisionId: decision.decisionId,
        level: decision.level,
        stateValue: decision.stateValue,
        neighborCount: decision.neighborCount,
        klToPrior: decision.klToPrior,
        adjustments: decision.adjustments.map((adjustment) => ({
          candidate: adjustment.candidate,
          normalizedAdvantage: adjustment.normalizedAdvantage
        })),
        rationale: scrub(decision.rationale)
      }))
    }
  };
}

function emptyExplain(controller: JitCommandController, note: string): JitCommandResult {
  return {
    command: 'explain',
    ok: true,
    text: ['jit explain', 'note: ' + note, renderExplainTable([])].join('\n'),
    json: { columns: EXPLAIN_COLUMNS, runId: null, rows: [], note }
  };
}

function renderExplainTable(rows: readonly JitDecisionRow[]): string {
  const header = '| ' + EXPLAIN_COLUMNS.join(' | ') + ' |';
  const separator = '| ' + EXPLAIN_COLUMNS.map(() => '---').join(' | ') + ' |';
  const body = rows.map(
    (row) =>
      '| ' +
      [
        scrub(row.candidate),
        row.source,
        formatNumber(row.baseLogit),
        formatNumber(row.q),
        formatNumber(row.normalizedAdvantage),
        formatNumber(row.adjustedLogit),
        scrub(row.note)
      ].join(' | ') +
      ' |'
  );
  return [header, separator, ...body].join('\n');
}

function explainResult(
  controller: JitCommandController,
  parsed: ParsedJitCommand
): JitCommandResult {
  if (parsed.runId === undefined) {
    return {
      command: 'explain',
      ok: false,
      text: 'explain requires a run id\n' + JIT_COMMAND_USAGE,
      json: { columns: EXPLAIN_COLUMNS, runId: null, rows: [], requiresRunId: true },
      usage: JIT_COMMAND_USAGE
    };
  }
  if (!controller.isEnabled()) {
    return emptyExplain(controller, 'JitRL is disabled; no decision table is available');
  }
  const decision = controller.findDecision(parsed.runId);
  if (decision === undefined) {
    return {
      command: 'explain',
      ok: false,
      text:
        'no decision recorded for run ' +
        scrub(parsed.runId) +
        '; nothing to explain\n' +
        renderExplainTable([]),
      json: { columns: EXPLAIN_COLUMNS, runId: scrub(parsed.runId), rows: [], note: 'unknown run id' }
    };
  }
  const rows = decision.adjustments.map((row) => ({ ...row }));
  const text = [
    'jit explain',
    'run: ' + scrub(decision.decisionId),
    'level: ' + decision.level,
    'V: ' + formatNumber(decision.stateValue),
    'neighbors: ' + String(decision.neighborCount),
    'kl: ' + formatNumber(decision.klToPrior),
    'rationale: ' + scrub(decision.rationale),
    renderExplainTable(rows)
  ].join('\n');
  return {
    command: 'explain',
    ok: true,
    text,
    json: {
      columns: EXPLAIN_COLUMNS,
      runId: scrub(decision.decisionId),
      level: decision.level,
      stateValue: decision.stateValue,
      neighborCount: decision.neighborCount,
      klToPrior: decision.klToPrior,
      rationale: scrub(decision.rationale),
      rows: rows.map((row) => ({
        candidate: scrub(row.candidate),
        source: row.source,
        baseLogit: row.baseLogit,
        q: row.q,
        advantage: row.advantage,
        normalizedAdvantage: row.normalizedAdvantage,
        adjustedLogit: row.adjustedLogit,
        note: scrub(row.note)
      }))
    }
  };
}

async function resetResult(
  controller: JitCommandController,
  parsed: ParsedJitCommand
): Promise<JitCommandResult> {
  if (parsed.bucket === undefined && !parsed.confirm) {
    return {
      command: 'reset',
      ok: false,
      text:
        'refusing to clear all experience without an explicit --confirm flag; nothing was dropped',
      json: { bucket: null, dropped: 0, supported: true, requiresConfirmation: true },
      usage: JIT_COMMAND_USAGE
    };
  }
  const outcome = await controller.reset(parsed.bucket);
  const scope = parsed.bucket === undefined ? 'all experience' : 'bucket ' + scrub(parsed.bucket);
  const text = outcome.supported
    ? 'reset ' + scope + ': dropped ' + String(outcome.dropped) + ' record(s)'
    : 'reset ' + scope + ' is unavailable: ' + scrub(outcome.note ?? 'store driver has no reset');
  return {
    command: 'reset',
    ok: outcome.supported,
    text,
    json: {
      bucket: parsed.bucket === undefined ? null : scrub(parsed.bucket),
      dropped: outcome.dropped,
      supported: outcome.supported,
      requiresConfirmation: false,
      ...(outcome.note === undefined ? {} : { note: scrub(outcome.note) })
    }
  };
}

function toggleResult(
  controller: JitCommandController,
  parsed: ParsedJitCommand
): JitCommandResult {
  const enabled = controller.setEnabled(parsed.command === 'on');
  return {
    command: parsed.command,
    ok: true,
    text:
      'jitrl: ' +
      (enabled ? 'on' : 'off') +
      ' (volatile in-process flag; the persisted configuration is unchanged)',
    json: { enabled, persisted: false }
  };
}

/**
 * Execute one parsed /evo jit invocation. Never throws for user input:
 * unknown commands and missing arguments return ok=false plus the usage line.
 */
export async function executeJitCommand(
  tokens: readonly string[],
  controller: JitCommandController
): Promise<JitCommandResult> {
  const parsed = parseJitArgs(tokens);
  switch (parsed.command) {
    case 'status':
      return statusResult(controller);
    case 'explain':
      return explainResult(controller, parsed);
    case 'reset':
      return resetResult(controller, parsed);
    case 'on':
    case 'off':
      return toggleResult(controller, parsed);
    default:
      return usageResult();
  }
}
