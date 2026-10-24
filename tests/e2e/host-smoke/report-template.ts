/**
 * Smoke report template (P6.1-F).
 *
 * The report is a *table of five states*, not a prose summary: every scenario
 * carries `expected`, `observed`, `passed`, `failed` and `not-run`, and the
 * commit + command line are pinned at the top. That shape exists because the
 * failure mode this phase must avoid is exactly the one a one-line green
 * summary enables: claiming Gate 4 from a harness that never ran against the
 * host. A scenario that did not run must be visible as `not-run` with a reason,
 * and a scenario that failed must keep its failure.
 *
 * Ownership: tests/e2e/host-smoke/**. Consumed by scripts/host-smoke/report.mjs.
 */

/** The five per-scenario states. Exactly one of passed/failed/not-run is set. */
export type ScenarioState = 'passed' | 'failed' | 'not-run';

/** Layers the RC report must keep separate (task §9.4 / D4). */
export const REPORT_LAYERS = [
  'engineering-runnable',
  'security-contract',
  'learning-semantics',
  'real-host-compatibility',
  'task-benefit'
] as const;
export type ReportLayer = (typeof REPORT_LAYERS)[number];

/** One scenario row of the report table. */
export interface ScenarioRow {
  /** Stable id: doc section + item, e.g. `9.2-1`. */
  readonly id: string;
  /** Which layer this scenario evidences. */
  readonly layer: ReportLayer;
  /** What the harness expected, stated before running. */
  readonly expected: string;
  /** What was actually observed (bounded, payload free). */
  readonly observed: string;
  readonly state: ScenarioState;
  /** Reason a `failed`/`not-run` row is not green. Empty for `passed`. */
  readonly note: string;
  /** Authorized? Only an explicitly authorized row may be `passed` with real calls. */
  readonly authorization: 'not-required' | 'granted' | 'absent';
  /** Commands/evidence backing the row, as recorded by the runner. */
  readonly evidence: readonly string[];
}

/** The fixed header values a report binds to. */
export interface ReportHeader {
  /** Git commit the run is bound to (full sha). */
  readonly commit: string;
  /** True when the working tree had uncommitted changes. */
  readonly worktreeDirty: boolean;
  /** Plugin version. */
  readonly pluginVersion: string;
  /** Installed host facts, one bounded line each. */
  readonly host: readonly string[];
  /** Every command executed for this report, in order. */
  readonly commands: readonly string[];
  /** ISO-8601 capture timestamp. */
  readonly capturedAt: string;
  /** Harness schema version (bumped when the row shape changes). */
  readonly schemaVersion: 1;
}

/** Layer-level rollup, computed from rows so it cannot drift from them. */
export interface LayerSummary {
  readonly layer: ReportLayer;
  readonly passed: number;
  readonly failed: number;
  readonly notRun: number;
  /** True only when at least one row exists and none failed or was skipped. */
  readonly complete: boolean;
}

const LAYER_TITLES: Readonly<Record<ReportLayer, string>> = {
  'engineering-runnable': '工程可运行',
  'security-contract': '安全契约',
  'learning-semantics': '学习语义',
  'real-host-compatibility': '真实宿主兼容',
  'task-benefit': '任务收益'
};

/** Human-facing layer title (zh, matching the team's report language). */
export function layerTitle(layer: ReportLayer): string {
  return LAYER_TITLES[layer];
}

/** Human-facing five-state cell, e.g. `**failed**：<reason>`. */
export function stateCell(row: ScenarioRow): string {
  if (row.state === 'passed') {
    return '**passed**';
  }
  return '**' + row.state + '**' + (row.note.length > 0 ? '：' + row.note : '');
}

/** Roll one layer up from its rows. */
export function summarizeLayer(layer: ReportLayer, rows: readonly ScenarioRow[]): LayerSummary {
  const scoped = rows.filter((row) => row.layer === layer);
  const passed = scoped.filter((row) => row.state === 'passed').length;
  const failed = scoped.filter((row) => row.state === 'failed').length;
  const notRun = scoped.filter((row) => row.state === 'not-run').length;
  return {
    layer,
    passed,
    failed,
    notRun,
    complete: scoped.length > 0 && failed === 0 && notRun === 0
  };
}

/** A `|`-safe cell: newlines collapse, pipes escape. */
function cell(value: string): string {
  return value.replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim();
}

/**
 * Render the markdown report.
 *
 * Ordering guarantees the reader sees, in this order: the pinned commit and
 * commands, the layer rollup (so a green layer next to a red one is visible),
 * and only then the row tables. `not-run` rows are never dropped.
 */
export function renderReport(header: ReportHeader, rows: readonly ScenarioRow[]): string {
  const lines: string[] = [];
  lines.push('# P6.1-F 真实宿主受控 smoke 与 shadow RC 报告');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('| :-- | :-- |');
  lines.push('| 报告 schema | `' + String(header.schemaVersion) + '` |');
  lines.push(
    '| 固定 commit | `' +
      header.commit +
      '`' +
      (header.worktreeDirty ? '（工作树有未提交改动，结论仅对这些字节成立）' : '（工作树 clean）') +
      ' |'
  );
  lines.push('| 插件版本 | `' + header.pluginVersion + '` |');
  lines.push('| 采集时间 | ' + header.capturedAt + ' |');
  for (const hostLine of header.host) {
    lines.push('| 宿主 | ' + cell(hostLine) + ' |');
  }
  lines.push('');
  lines.push('## 固定命令列');
  lines.push('');
  lines.push('```text');
  for (const command of header.commands) {
    lines.push(command);
  }
  lines.push('```');
  lines.push('');
  lines.push('## 分层结论（先看这里，不看单行全绿）');
  lines.push('');
  lines.push('| 层 | passed | failed | not-run | 该层是否完整 |');
  lines.push('| :-- | --: | --: | --: | :-- |');
  for (const layer of REPORT_LAYERS) {
    const summary = summarizeLayer(layer, rows);
    lines.push(
      '| ' +
        layerTitle(layer) +
        ' (`' +
        layer +
        '`) | ' +
        String(summary.passed) +
        ' | ' +
        String(summary.failed) +
        ' | ' +
        String(summary.notRun) +
        ' | ' +
        (summary.complete ? '完整' : summary.passed + summary.failed + summary.notRun === 0 ? '无条目' : '**不完整**') +
        ' |'
    );
  }
  lines.push('');
  for (const layer of REPORT_LAYERS) {
    const scoped = rows.filter((row) => row.layer === layer);
    if (scoped.length === 0) {
      lines.push('### ' + layerTitle(layer) + ' (`' + layer + '`)');
      lines.push('');
      lines.push('本层没有条目：这是缺口，不是通过。');
      lines.push('');
      continue;
    }
    lines.push('### ' + layerTitle(layer) + ' (`' + layer + '`)');
    lines.push('');
    lines.push('| id | expected | observed | passed | failed | not-run | 授权 | 证据 |');
    lines.push('| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |');
    for (const row of scoped) {
      // The reason travels WITH the state cell, not in the observed column: a
      // reader scanning the failed/not-run columns must see why without
      // cross-referencing another cell.
      const failedCell = row.state === 'failed' ? '**failed**：' + cell(row.note) : '—';
      const notRunCell = row.state === 'not-run' ? '**not-run**：' + cell(row.note) : '—';
      const passedCell = row.state === 'passed' ? '**passed**' : '—';
      lines.push(
        '| `' +
          row.id +
          '` | ' +
          cell(row.expected) +
          ' | ' +
          cell(row.observed) +
          ' | ' +
          passedCell +
          ' | ' +
          failedCell +
          ' | ' +
          notRunCell +
          ' | ' +
          row.authorization +
          ' | ' +
          (row.evidence.length === 0 ? '—' : row.evidence.map((entry) => '`' + cell(entry) + '`').join(' ')) +
          ' |'
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Validate a row set before rendering (guards the report's own honesty). */
export function validateRows(rows: readonly ScenarioRow[]): readonly string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  if (rows.length === 0) {
    problems.push('report has no scenario rows');
  }
  for (const row of rows) {
    if (row.id.trim().length === 0) {
      problems.push('row without id');
      continue;
    }
    if (seen.has(row.id)) {
      problems.push('duplicate row id ' + row.id);
    }
    seen.add(row.id);
    if (!(REPORT_LAYERS as readonly string[]).includes(row.layer)) {
      problems.push('row ' + row.id + ' has an unknown layer ' + String(row.layer));
    }
    if (row.state !== 'passed' && row.state !== 'failed' && row.state !== 'not-run') {
      problems.push('row ' + row.id + ' has an unknown state');
    }
    if ((row.state === 'failed' || row.state === 'not-run') && row.note.trim().length === 0) {
      problems.push('row ' + row.id + ' is ' + row.state + ' but carries no reason');
    }
    if (row.state === 'passed' && row.evidence.length === 0) {
      problems.push('row ' + row.id + ' claims passed with no evidence');
    }
    if (row.state === 'passed' && row.authorization === 'absent' && row.layer === 'task-benefit') {
      problems.push('row ' + row.id + ' claims a real task-benefit pass without authorization');
    }
    if (row.expected.trim().length === 0) {
      problems.push('row ' + row.id + ' has no expected statement');
    }
    if (row.observed.trim().length === 0) {
      problems.push('row ' + row.id + ' has no observed statement');
    }
  }
  return problems;
}
