#!/usr/bin/env node
/**
 * P3-B: metering coverage gate.
 *
 * WHAT IT PROVES
 *   Every production model call in `src/**` must go through the unified
 *   MeteredModelAdapter (`src/dsh-bridge/metered-model-adapter.ts`) or be an
 *   explicitly allow-listed delegation. The gate parses TypeScript with the
 *   compiler API (comments/strings can never fake a hit) and fails when it
 *   finds an unlisted:
 *
 *     - `.complete(...)`        (IModelAdapter's only call surface)
 *     - `.planNext(...)`        (the agent-loop planner surface)
 *     - `.complete.bind(...)`   (binding the method escapes the two patterns)
 *     - `.planNext.bind(...)`
 *
 * ALLOWLIST (the only explicit exceptions, auditable in one place)
 *   Each entry is { file, symbol, expectedCount, reason }. The gate is strict in
 *   BOTH directions:
 *     - an occurrence not covered by an entry  -> FAIL (new unmetered call)
 *     - an entry whose count does not match    -> FAIL (stale allowlist, or a
 *       second call slipped into an allow-listed file)
 *   A JSON file can be supplied with `--allowlist <file>` for fixture tests; the
 *   default table below is the production allowlist.
 *
 * USAGE
 *   node scripts/eval/metering-coverage.mjs [--json] [--root <dir>] [--allowlist <file>]
 *   exit 0 = covered, exit 1 = violations, exit 2 = usage/IO error.
 *
 * WHY THIS FILE HOLDS THE TABLE INSTEAD OF SCATTERED EXEMPTIONS
 *   An exception is a security-relevant decision, so it belongs in the gate that
 *   enforces it — one diffable table, not comments in eight modules.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** Production allowlist. Every entry needs a reason; counts are exact. */
export const DEFAULT_ALLOWLIST = Object.freeze([
  {
    file: 'src/dsh-bridge/metered-model-adapter.ts',
    symbol: 'complete',
    expectedCount: 1,
    reason:
      'The single metered boundary itself. All production calls funnel through this adapter, which ' +
      'records stage/purpose/cost before and after the call.'
  },
  {
    file: 'src/index.ts',
    symbol: 'complete',
    expectedCount: 1,
    reason:
      'Lazy holder delegation: forwards to the already-constructed adapter and adds no call of its own ' +
      '(it is the one-line bridge for an adapter resolved after plugin start-up).'
  },
  {
    file: 'src/dsh-bridge/agent-loop-executor.ts',
    symbol: 'complete.bind',
    expectedCount: 1,
    reason:
      'P3-A ledger path: the agent-loop executor binds complete() and meters the call with its own ' +
      "reserve/settle under purpose 'probe'. Unifying it on MeteredModelAdapter would double-charge."
  },
  {
    file: 'src/dsh-bridge/agent-loop-executor.ts',
    symbol: 'planNext.bind',
    expectedCount: 1,
    reason:
      'Same P3-A ledger path for the multi-step planner call; bound once and metered per iteration.'
  }
]);

const SYMBOLS = new Set(['complete', 'planNext']);

function usage(message) {
  process.stderr.write('[metering-coverage] ' + message + '\n');
  process.exit(2);
}

function parseArgs(argv) {
  const args = { json: false, root: undefined, allowlist: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      args.json = true;
    } else if (arg === '--root') {
      args.root = argv[index + 1];
      index += 1;
    } else if (arg === '--allowlist') {
      args.allowlist = argv[index + 1];
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: node scripts/eval/metering-coverage.mjs [--json] [--root <dir>] [--allowlist <file>]\n'
      );
      process.exit(0);
    } else {
      usage('unknown argument: ' + arg);
    }
  }
  return args;
}

function walkTypeScriptFiles(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTypeScriptFiles(absolute, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(absolute);
    }
  }
}

/** True when the call's callee is `<something>.complete` / `.planNext`. */
function directCallSymbol(node) {
  if (!ts.isCallExpression(node)) {
    return undefined;
  }
  const callee = node.expression;
  if (ts.isPropertyAccessExpression(callee) && SYMBOLS.has(callee.name.text)) {
    return callee.name.text;
  }
  return undefined;
}

/** True when the call's callee is `<something>.complete.bind` / `.planNext.bind`. */
function boundCallSymbol(node) {
  if (!ts.isCallExpression(node)) {
    return undefined;
  }
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'bind') {
    return undefined;
  }
  const target = callee.expression;
  if (ts.isPropertyAccessExpression(target) && SYMBOLS.has(target.name.text)) {
    return target.name.text + '.bind';
  }
  return undefined;
}

function lineAndColumn(sourceFile, node) {
  const start = node.getStart(sourceFile);
  const position = sourceFile.getLineAndCharacterOfPosition(start);
  return { line: position.line + 1, column: position.character + 1 };
}

/** Scan one file and append occurrences: { file, symbol, line, column, snippet }. */
function scanFile(absolute, root, occurrences) {
  const text = fs.readFileSync(absolute, 'utf8');
  const sourceFile = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  const visit = (node) => {
    const symbol = directCallSymbol(node) ?? boundCallSymbol(node);
    if (symbol !== undefined) {
      const { line, column } = lineAndColumn(sourceFile, node);
      occurrences.push({
        file: relative,
        symbol,
        line,
        column,
        snippet: text.split(/\r?\n/)[line - 1]?.trim() ?? ''
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function loadAllowlist(args) {
  if (args.allowlist === undefined) {
    return DEFAULT_ALLOWLIST.map((entry) => ({ ...entry }));
  }
  const raw = fs.readFileSync(args.allowlist, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    usage('allowlist must be a JSON array');
  }
  return parsed;
}

function groupKey(file, symbol) {
  return file + '|' + symbol;
}

function evaluate(root, allowlist) {
  const violations = [];
  const srcDir = path.join(root, 'src');
  if (!fs.existsSync(srcDir)) {
    usage('no src/ directory under root: ' + root);
  }
  const files = [];
  walkTypeScriptFiles(srcDir, files);
  const occurrences = [];
  for (const file of files) {
    scanFile(file, root, occurrences);
  }

  const groups = new Map();
  for (const occurrence of occurrences) {
    const key = groupKey(occurrence.file, occurrence.symbol);
    const list = groups.get(key) ?? [];
    list.push(occurrence);
    groups.set(key, list);
  }

  const allowByKey = new Map();
  for (const entry of allowlist) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof entry.file !== 'string' ||
      typeof entry.symbol !== 'string' ||
      !Number.isInteger(entry.expectedCount) ||
      typeof entry.reason !== 'string' ||
      entry.reason.trim().length === 0
    ) {
      usage('allowlist entry must be { file, symbol, expectedCount, reason }: ' + JSON.stringify(entry));
    }
    if (allowByKey.has(groupKey(entry.file, entry.symbol))) {
      usage('duplicate allowlist entry for ' + entry.file + ' ' + entry.symbol);
    }
    allowByKey.set(groupKey(entry.file, entry.symbol), entry);
  }

  // 1. Every occurrence must be covered by an allowlist entry.
  for (const [key, list] of groups) {
    const entry = allowByKey.get(key);
    if (entry === undefined) {
      for (const occurrence of list) {
        violations.push({
          code: 'unmetered-call',
          file: occurrence.file,
          symbol: occurrence.symbol,
          line: occurrence.line,
          column: occurrence.column,
          snippet: occurrence.snippet,
          detail:
            'direct ' + occurrence.symbol + '() outside the MeteredModelAdapter; route it through ' +
            "createMeteredModelAdapter(model, '<stage>').call(request)"
        });
      }
    }
  }

  // 2. Every allowlist entry must match its exact observed count (stale/extra detection).
  for (const [key, entry] of allowByKey) {
    const list = groups.get(key) ?? [];
    if (list.length !== entry.expectedCount) {
      violations.push({
        code: list.length === 0 ? 'stale-allowlist-entry' : 'allowlist-count-mismatch',
        file: entry.file,
        symbol: entry.symbol,
        expectedCount: entry.expectedCount,
        actualCount: list.length,
        reason: entry.reason,
        detail:
          "allowlist expects " + entry.expectedCount + ' ' + entry.symbol +
          ' call(s) in ' + entry.file + ' but found ' + list.length +
          (list.length === 0
            ? '; remove the stale entry'
            : '; an extra call slipped into an allow-listed file')
      });
    }
  }

  return {
    ok: violations.length === 0,
    scannedFiles: files.length,
    occurrences: occurrences.length,
    groups: [...groups.entries()]
      .map(([key, list]) => ({ key, count: list.length }))
      .sort((left, right) => left.key.localeCompare(right.key)),
    violations
  };
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(args.root ?? path.join(here, '..', '..'));
  const allowlist = loadAllowlist(args);
  const result = evaluate(root, allowlist);
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else if (result.ok) {
    process.stdout.write(
      '[metering-coverage] OK: ' + result.scannedFiles + ' file(s) scanned, ' +
      result.occurrences + ' allow-listed model call(s), 0 unmetered call(s).\n'
    );
  } else {
    process.stderr.write('[metering-coverage] FAIL: ' + result.violations.length + ' violation(s)\n');
    for (const violation of result.violations) {
      process.stderr.write(
        '  ' + violation.code + ' @ ' + violation.file +
        (violation.line === undefined ? '' : ':' + violation.line) +
        (violation.symbol === undefined ? '' : ' [' + violation.symbol + ']') +
        ' — ' + violation.detail + '\n'
      );
    }
  }
  process.exit(result.ok ? 0 : 1);
}
