#!/usr/bin/env node
/**
 * Test-import coverage gate (audit round 2, §9 batch-2 process improvement).
 *
 * WHAT IT PROVES
 *   Every module under `src/**` is imported by at least one file under
 *   `tests/**` — directly, or through a BARREL re-export (`src/ledger/index.ts`
 *   does `export * from './two-phase.js'`, so a test importing `src/ledger`
 *   covers `two-phase.ts`). The audit found `src/dsh-bridge/clients.ts` (376
 *   lines of real host protocol) with zero test references while the whole
 *   suite stayed green (TEST-1); this gate makes that shape fail instead of
 *   hiding.
 *
 * WHY THE CLOSURE FOLLOWS RE-EXPORTS ONLY (what separates this from a rubber
 * stamp)
 *   Following every relative `import` would make the gate vacuous. `src/index.ts`
 *   imports nearly the whole tree, so ONE test importing the package entry
 *   would mark every module "covered" — including a module nothing tests.
 *   The closure therefore expands over `export ... from` edges ONLY: a barrel
 *   is a declared public surface, an internal `import` is not a test. The
 *   discriminating case — a module reachable only through `src/index.ts` — is
 *   pinned by `tests/unit/p62/test-import-coverage-gate.test.ts`.
 *
 * DECISION RULE (stated so the gate cannot be read as more than it is)
 *   - `import` / `import type` / dynamic `import()` in a TEST file
 *       -> the resolved target is covered
 *   - `export ... from` in a COVERED `src` file
 *       -> the resolved target is covered (barrel transparency)
 *   - `import` between two `src` modules
 *       -> covers NOTHING (see the paragraph above)
 *   TYPE-ONLY edges COUNT in both positions: `import type` and
 *   `export type { X } from './x'` still pull the module into the compile graph,
 *   and a type-only contract with no test is the same blind spot.
 *
 * SCOPE LIMIT (stated so nobody reads the gate as more than it is)
 *   This is an IMPORT gate, not an assertion gate: it proves a test file pulls
 *   the module in, not that the test asserts anything about it. Pair it with the
 *   per-module review discipline rather than treating green as "tested".
 *
 * ALLOWLIST
 *   Modules that legitimately have no test importer (a type-only contract, a
 *   barrel that only exists for package exports). Each entry is
 *   { file, reason } with a reason of at least 120 characters; the gate is
 *   strict in both directions (an unlisted uncovered module fails, and an entry
 *   whose module is now covered also fails as stale).
 *
 * USAGE
 *   node scripts/eval/check-test-import-coverage.mjs [--json] [--root <dir>] [--allowlist <file>]
 *   exit 0 = covered, exit 1 = violations, exit 2 = usage/IO error.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const MIN_REASON_LENGTH = 120;

/**
 * Production allowlist. Every entry needs a reason; the gate rejects stale rows.
 *
 * EMPTY ON PURPOSE. The current tree has 0 uncovered modules, so every row
 * here would be a stale exemption. Add a row only together with the module it
 * excuses, and write down why that module cannot or must not be imported by a
 * test — never "the gate is failing".
 */
const DEFAULT_ALLOWLIST = Object.freeze([]);

const EXIT_OK = 0;
const EXIT_VIOLATION = 1;
const EXIT_USAGE = 2;

function parseArgs(argv) {
  const out = { json: false, root: undefined, allowlist: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      out.json = true;
    } else if (arg === '--root') {
      out.root = argv[i + 1];
      i += 1;
    } else if (arg === '--allowlist') {
      out.allowlist = argv[i + 1];
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'usage: node scripts/eval/check-test-import-coverage.mjs [--json] [--root <dir>] [--allowlist <file>]\n'
      );
      process.exit(EXIT_OK);
    } else {
      process.stderr.write('[test-import-coverage] unknown argument: ' + arg + '\n');
      process.exit(EXIT_USAGE);
    }
  }
  return out;
}

function loadAllowlist(args) {
  if (args.allowlist === undefined) {
    return DEFAULT_ALLOWLIST;
  }
  const raw = fs.readFileSync(args.allowlist, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('allowlist file must contain a JSON array');
  }
  return parsed;
}

function listTsFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) {
    return out;
  }
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out.sort();
}

function readParsed(fileName) {
  const text = fs.readFileSync(fileName, 'utf8');
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

/**
 * Module specifiers one file references, split by how they are referenced.
 *
 * Parsed with the compiler API rather than a regex: the previous regex
 * (`(?:^|[\s;{(])(?:import|export)[\s\S]*?from`) happily spanned several
 * statements, so an `import` in one line could inherit the specifier of a later
 * `export * from` — a spurious edge of the wrong KIND, which would both widen
 * the closure and mislabel it. Comments and string literals are likewise never
 * declarations, so prose cannot create an edge.
 */
function referenceEdges(fileName) {
  const source = readParsed(fileName);
  const out = [];
  const push = (kind, specifier) => {
    if (typeof specifier === 'string' && specifier.startsWith('.')) {
      out.push({ kind, specifier });
    }
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier !== undefined && ts.isStringLiteral(specifier)) {
        push('import', specifier.text);
      }
    } else if (ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier !== undefined && ts.isStringLiteral(specifier)) {
        push('export', specifier.text);
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      push('import', node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** Normalize `x` / `x.ts` / `x/index.ts` to one canonical key. */
function canonical(absPath) {
  // ESM-style specifiers name the emitted `.js`; the source beside it is `.ts`.
  const base = absPath.endsWith('.js') ? absPath.slice(0, -3) : absPath;
  const candidates = [base + '.ts', path.join(base, 'index.ts'), base];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return path.normalize(candidate);
    }
  }
  return path.normalize(base);
}

function evaluate(root, allowlist) {
  const srcDir = path.join(root, 'src');
  if (!fs.existsSync(srcDir)) {
    throw new Error('no src/ directory under root: ' + root);
  }
  const srcFiles = listTsFiles(srcDir);
  const testFiles = listTsFiles(path.join(root, 'tests'));
  const srcPrefix = path.join(root, 'src');

  // 1. Directly imported by a test file (`import`, `import type`, `import()`).
  const covered = new Set();
  const pending = [];
  for (const file of testFiles) {
    for (const edge of referenceEdges(file)) {
      const key = canonical(path.resolve(path.dirname(file), edge.specifier));
      if (fs.existsSync(key) && !covered.has(key)) {
        covered.add(key);
        pending.push(key);
      }
    }
  }

  // 2. Close over BARREL RE-EXPORTS only. An `import` between src modules is not
  //    a test and must never propagate coverage.
  const expanded = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (expanded.has(current)) {
      continue;
    }
    expanded.add(current);
    if (!current.startsWith(srcPrefix)) {
      continue;
    }
    for (const edge of referenceEdges(current)) {
      if (edge.kind !== 'export') {
        continue;
      }
      const key = canonical(path.resolve(path.dirname(current), edge.specifier));
      if (fs.existsSync(key) && !covered.has(key)) {
        covered.add(key);
        pending.push(key);
      }
    }
  }

  const uncovered = [];
  for (const file of srcFiles) {
    if (!covered.has(path.normalize(file))) {
      uncovered.push(path.relative(root, file).split(path.sep).join('/'));
    }
  }

  const violations = [];
  const matched = new Set();
  for (const file of uncovered) {
    const allowed = allowlist.find((entry) => entry.file === file);
    if (allowed === undefined) {
      violations.push({
        code: 'uncovered-module',
        file,
        detail: 'no test file imports this module (directly or through a barrel)'
      });
    } else {
      matched.add(allowed);
    }
  }
  for (const entry of allowlist) {
    if (typeof entry.reason !== 'string' || entry.reason.length < MIN_REASON_LENGTH) {
      violations.push({
        code: 'allowlist-reason-too-short',
        file: entry.file,
        detail: 'reason must be at least ' + String(MIN_REASON_LENGTH) + ' characters'
      });
    }
    if (!matched.has(entry)) {
      violations.push({
        code: 'allowlist-stale',
        file: entry.file,
        detail: 'allowlisted module is now covered; drop the entry'
      });
    }
  }

  return {
    ok: violations.length === 0,
    srcFiles: srcFiles.length,
    testFiles: testFiles.length,
    covered: srcFiles.length - uncovered.length,
    uncovered: uncovered.length,
    allowlisted: matched.size,
    violations
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(args.root ?? path.join(here, '..', '..'));
  let allowlist;
  try {
    allowlist = loadAllowlist(args);
  } catch (error) {
    process.stderr.write('[test-import-coverage] cannot read allowlist: ' + String(error) + '\n');
    process.exit(EXIT_USAGE);
  }
  let result;
  try {
    result = evaluate(root, allowlist);
  } catch (error) {
    process.stderr.write('[test-import-coverage] ' + String(error) + '\n');
    process.exit(EXIT_USAGE);
  }
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else if (result.ok) {
    process.stdout.write(
      '[test-import-coverage] OK: ' +
        String(result.covered) +
        '/' +
        String(result.srcFiles) +
        ' src module(s) imported by a test (' +
        String(result.allowlisted) +
        ' allow-listed).\n'
    );
  } else {
    process.stderr.write(
      '[test-import-coverage] FAIL: ' + String(result.violations.length) + ' violation(s)\n'
    );
    for (const violation of result.violations) {
      process.stderr.write('  ' + violation.code + ' @ ' + violation.file + ' — ' + violation.detail + '\n');
    }
  }
  process.exit(result.ok ? EXIT_OK : EXIT_VIOLATION);
}

main();
