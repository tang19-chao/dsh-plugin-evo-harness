#!/usr/bin/env node
/**
 * JitRL ablation/evaluation CLI (plan section 9, P5-c).
 *
 * Runs the protocol in scripts/eval/jitrl-eval-lib.ts and prints either the JSON
 * report or a human-readable summary; with --report it regenerates the committed
 * markdown report from the numbers it just measured.
 *
 * Dependency free: the lib is TypeScript and is imported directly (Node 22
 * strips the type annotations), which needs the one-line extension resolver
 * below because the sources use extensionless relative imports - the same
 * technique as scripts/bench-jitrl-query.mjs.
 *
 * Exit codes (a regression must be visible in CI):
 *   0  protocol completed and every gate passed
 *   1  a gate failed (leak, Avg below --min-avg, or Final < Avg when asked)
 *   2  the protocol itself threw
 *
 * Usage: node scripts/eval-jitrl.mjs [options]
 *   --json                     print the JSON report only
 *   --report <path>            write the markdown report to <path>
 *   --episodes <n>             episode length L (default 5)
 *   --conditions <ids>         comma-separated subset, e.g. B0,B1,B2,B3
 *   --tasks <ids>              comma-separated subset of task ids
 *   --min-avg <n>              fail when any condition's Avg is below n (default 0)
 *   --expect-final-improvement fail when a baseline's Final < Avg
 *   --quiet                    do not print the human-readable summary
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { register } from 'node:module';

/**
 * Extension resolvers, in the order Node must try them: the bare specifier,
 * then `.ts` (a module), then `/index.ts` (a directory barrel such as
 * `./cordis-seams`). All three appear in src/**; a single-level resolver is not
 * enough for the plugin entry module.
 */
const extensionResolver =
  "export async function resolve(specifier, context, nextResolve) {" +
  ' try { return await nextResolve(specifier, context); }' +
  ' catch (error) {' +
  "  if (!specifier.startsWith('.')) { throw error; }" +
  "  if (!specifier.endsWith('.ts')) {" +
  '   try { return await nextResolve(specifier + \'.ts\', context); } catch { /* fall through */ }' +
  '  }' +
  '  try { return await nextResolve(specifier + \'/index.ts\', context); } catch { /* fall through */ }' +
  '  throw error;' +
  ' }' +
  '}';
register('data:text/javascript,' + encodeURIComponent(extensionResolver), import.meta.url);

const { runEval, renderMarkdown, CONDITIONS, DEFAULT_CANARY, fixed } = await import(
  './eval/jitrl-eval-lib.ts'
);

// ---------------------------------------------------------------------------
// argument parsing
// ---------------------------------------------------------------------------

/**
 * Split a list argument. Commas are the documented separator, but `pnpm run
 * eval:jitrl -- --conditions B0,B3` reaches the script as "B0 B3" (pnpm
 * re-splits the passthrough), so whitespace is accepted as well.
 */
function splitList(value) {
  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function readArgs(argv) {
  const options = {
    json: false,
    quiet: false,
    episodes: 5,
    conditions: undefined,
    tasks: undefined,
    report: undefined,
    minAvg: 0,
    expectFinalImprovement: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('missing value for ' + String(arg));
      }
      index += 1;
      return value;
    };
    switch (arg) {
      case '--json':
        options.json = true;
        break;
      case '--quiet':
        options.quiet = true;
        break;
      case '--expect-final-improvement':
        options.expectFinalImprovement = true;
        break;
      case '--episodes':
        options.episodes = Number.parseInt(next(), 10);
        break;
      case '--conditions':
        options.conditions = splitList(next());
        break;
      case '--tasks':
        options.tasks = splitList(next());
        break;
      case '--min-avg':
        options.minAvg = Number.parseFloat(next());
        break;
      case '--report':
        options.report = next();
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error('unknown argument: ' + String(arg));
    }
  }
  if (!Number.isInteger(options.episodes) || options.episodes < 1) {
    throw new Error('--episodes must be a positive integer');
  }
  if (!Number.isFinite(options.minAvg)) {
    throw new Error('--min-avg must be a number');
  }
  return options;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function fail(message) {
  console.error('eval:jitrl FAILED: ' + message);
  process.exitCode = 1;
}

function printSummary(report) {
  const rows = report.metrics;
  const header = ['condition', 'levels', 'k', 'beta', 'Avg', 'Final', 'Final-Avg', 'solved', 'KL mean', 'KL p95'];
  console.log('protocol: L=' + String(report.protocol.episodes) + ', tasks=' + String(report.protocol.taskCount) + ', families=' + report.protocol.families.join(','));
  console.log('seed: ' + report.protocol.seed);
  console.log('');
  console.log(header.join(' | '));
  for (const row of rows) {
    console.log(
      [
        row.id,
        row.config.levels.join('+') || '-',
        String(row.config.k),
        String(row.config.beta),
        fixed(row.avg),
        fixed(row.final),
        (row.finalMinusAvg > 0 ? '+' : '') + fixed(row.finalMinusAvg),
        fixed(row.solvedRate),
        fixed(row.health.klMean),
        fixed(row.health.klP95)
      ].join(' | ')
    );
  }
  console.log('');
  const leaks = rows.reduce((total, row) => total + row.safety.invariantLeaks + row.safety.invariantMemoryLeaks + row.safety.canaryLeaks, 0);
  console.log('safety: invariant leaks=' + String(leaks) + ' (must be 0)');
  console.log('timing: total ' + String(report.timing.totalMs) + 'ms');
  for (const [id, ms] of Object.entries(report.timing.perConditionMs)) {
    console.log('  ' + id + ': ' + String(ms) + 'ms');
  }
  console.log('');
  console.log('unimplemented ablations: ' + report.unimplemented.map((entry) => entry.id).join(', '));
}

function currentCommit() {
  const cwd = process.cwd();
  try {
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' })
      .split('\n')
      .some((line) => line.trim().length > 0);
    return head + (dirty ? '+dirty' : '');
  } catch {
    return 'unknown';
  }
}

function localTimestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return (
    String(now.getFullYear()) +
    '-' + pad(now.getMonth() + 1) +
    '-' + pad(now.getDate()) +
    ' ' + pad(now.getHours()) +
    ':' + pad(now.getMinutes()) +
    ':' + pad(now.getSeconds()) +
    ' (UTC' + (now.getTimezoneOffset() <= 0 ? '+' : '-') + pad(Math.abs(now.getTimezoneOffset()) / 60) + ')'
  );
}

async function main() {
  const options = readArgs(process.argv.slice(2));
  if (options.help === true) {
    console.log('usage: node scripts/eval-jitrl.mjs [--json] [--report <path>] [--episodes <n>] [--conditions <ids>] [--tasks <ids>] [--min-avg <n>] [--expect-final-improvement] [--quiet]');
    console.log('conditions: ' + CONDITIONS.map((entry) => entry.id).join(', '));
    return;
  }
  const known = new Set(CONDITIONS.map((entry) => entry.id));
  if (options.conditions !== undefined) {
    const unknown = options.conditions.filter((entry) => !known.has(entry));
    if (unknown.length > 0) {
      throw new Error('unknown condition(s): ' + unknown.join(', ') + '; known: ' + [...known].join(', '));
    }
  }

  const report = await runEval({
    ...(options.episodes === 5 ? {} : { episodes: options.episodes }),
    ...(options.conditions === undefined ? {} : { conditions: options.conditions }),
    canary: DEFAULT_CANARY
  });

  if (options.json === true) {
    console.log(JSON.stringify(report, null, 2));
  } else if (options.quiet !== true) {
    printSummary(report);
  }

  if (options.report !== undefined) {
    const command = 'node scripts/eval-jitrl.mjs --report ' + options.report;
    const markdown = renderMarkdown(report, {
      commit: currentCommit(),
      generatedAt: localTimestamp(),
      command
    });
    const target = resolve(process.cwd(), options.report);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, markdown, 'utf8');
    if (options.quiet !== true) {
      console.log('');
      console.log('markdown report written to ' + target);
    }
  }

  // -------------------------------------------------------------------------
  // gates
  // -------------------------------------------------------------------------
  let failed = false;
  for (const row of report.metrics) {
    const leaks =
      row.safety.invariantLeaks +
      row.safety.invariantMemoryLeaks +
      row.safety.invariantGuidanceLeaks +
      row.safety.canaryLeaks;
    if (leaks > 0) {
      fail(
        'condition ' + row.id + ' reported ' + String(leaks) + ' safety leak(s): ' +
        JSON.stringify(row.safety)
      );
      failed = true;
    }
    if (row.avg < options.minAvg) {
      fail('condition ' + row.id + ' Avg ' + fixed(row.avg) + ' is below --min-avg ' + String(options.minAvg));
      failed = true;
    }
    if (options.expectFinalImprovement && row.group === 'baseline' && row.final < row.avg) {
      fail('condition ' + row.id + ' Final ' + fixed(row.final) + ' < Avg ' + fixed(row.avg));
      failed = true;
    }
  }
  // The very first sanity gate: the harness must actually measure something.
  const measured = report.metrics.filter((row) => row.group === 'baseline');
  if (measured.length === 0) {
    fail('no baseline condition ran; the report would be empty');
    failed = true;
  }
  // B0 must be a floor: a static agent with no harness cannot beat every arm.
  const b0 = report.metrics.find((row) => row.id === 'B0');
  if (b0 !== undefined) {
    for (const row of measured) {
      if (row.id !== 'B0' && row.avg < b0.avg - 1e-9) {
        fail('regression: ' + row.id + ' Avg ' + fixed(row.avg) + ' is below the static floor B0 ' + fixed(b0.avg));
        failed = true;
      }
    }
  }
  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('eval:jitrl ERROR: ' + (error instanceof Error ? error.stack ?? error.message : String(error)));
  process.exitCode = 2;
});
