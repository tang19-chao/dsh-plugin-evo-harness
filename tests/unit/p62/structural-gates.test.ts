/**
 * rev6 cross-audit §9 batch-2: fail-closed tests for the two structural gates
 * `scripts/eval/check-orphan-exports.mjs` (exported-symbol orphan shape) and
 * `scripts/eval/check-test-import-coverage.mjs` (TEST-1 shape).
 *
 * WHY THESE CASES EXIST AT ALL
 * ---------------------------
 * A structural gate that always exits 0 is worse than no gate: it reports
 * "clean" on the exact tree it was built to reject. Both gates shipped with a
 * vacuity of that kind, and each case below is the one that would have caught
 * it.
 *
 *   1. ORPHAN, positive: a dead EXPORT is named with its file and kind.
 *   2. ORPHAN, negative: a clean tree reports nothing — so "flags everything"
 *      cannot pass as a gate.
 *   3. ORPHAN, scope: a module-private uncalled function is NOT reported (the
 *      header states this non-goal; the test pins the statement instead of
 *      letting it drift into an implied promise).
 *   4. ORPHAN, barrel口径: a named re-export (`export { x } from`, including the
 *      type-only form) counts as a reader; a star re-export (`export * from`)
 *      does NOT, because it publishes whatever happens to exist.
 *   5. ORPHAN, same-file: a call in the declaring file is a real reader, so an
 *      exported helper used only internally is not an orphan.
 *   6. ORPHAN, allowlist drift: a row that no longer matches an orphan fails
 *      (stale) and a row with a short reason fails.
 *   7. COVERAGE, positive: a module with no test importer fails.
 *   8. COVERAGE, the vacuity this file was written for: a module imported ONLY
 *      by `src/index.ts` (which the tests DO import) must STILL fail. The
 *      original implementation closed the graph over every relative import, so
 *      one test importing the entry marked the whole tree covered — the exact
 *      shape that hid `src/dsh-bridge/clients.ts` (audit TEST-1).
 *   9. COVERAGE, barrel: a barrel re-export DOES carry coverage, and a plain
 *      `src`→`src` import does NOT.
 *  10. COVERAGE, allowlist drift: stale and short-reason rows fail.
 *
 * Every case runs the gate as a CHILD PROCESS and asserts the EXIT CODE, so a
 * gate whose `main()` is unreachable, or one that throws mid-scan, cannot be
 * mistaken for a pass. Trees are built under the OS temp directory.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const ORPHAN_GATE = path.join(REPO_ROOT, 'scripts', 'eval', 'check-orphan-exports.mjs');
const COVERAGE_GATE = path.join(REPO_ROOT, 'scripts', 'eval', 'check-test-import-coverage.mjs');

/** A reason long enough to satisfy the gates' 120-character audit discipline. */
const REAL_REASON =
  'Synthetic fixture reason for the fail-closed suite: it is long enough to clear the audit threshold and ' +
  'states why the exemption exists rather than restating the row.';

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempTree(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'structural-gate-' + label + '-'));
  tempDirs.push(dir);
  return dir;
}

function writeFile(root: string, relativePath: string, content: string): void {
  const full = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

/**
 * Run a gate against a synthetic tree and return `{ status, output }`.
 *
 * The allowlist is ALWAYS passed explicitly: the gates default to the
 * repository's production table, which would make every row stale on a
 * throwaway tree and turn a "clean tree" case red for the wrong reason.
 */
function runGate(
  gate: string,
  root: string,
  allowlist: readonly unknown[] = []
): { status: number | null; output: string } {
  const file = path.join(root, 'allowlist.json');
  fs.writeFileSync(file, JSON.stringify(allowlist), 'utf8');
  const result = spawnSync(process.execPath, [gate, '--root', root, '--allowlist', file], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024
  });
  return { status: result.status, output: (result.stdout ?? '') + (result.stderr ?? '') };
}

describe('check-orphan-exports.mjs', () => {
  it('names a dead exported function and exits 1', () => {
    const root = tempTree('orphan-red');
    writeFile(root, 'src/used.ts', 'export function used(): number {\n  return 1;\n}\n');
    writeFile(root, 'src/dead.ts', 'export function deadSurface(): number {\n  return 2;\n}\n');
    writeFile(root, 'tests/used.test.ts', "import { used } from '../src/used';\nexport const value = used();\n");

    const { status, output } = runGate(ORPHAN_GATE, root);
    expect(status).toBe(1);
    // The report must NAME the symbol and file: a bare exit code would let a
    // reader guess which finding fired.
    expect(output).toContain('deadSurface');
    expect(output).toContain('src/dead.ts');
  });

  it('names a dead exported CONST and TYPE ALIAS, not only functions', () => {
    // The scan covers the whole export surface. If it silently narrowed back to
    // functions these two would disappear from the report.
    const root = tempTree('orphan-kinds');
    writeFile(
      root,
      'src/kinds.ts',
      [
        'export const UNREAD_TABLE = { a: 1 } as const;',
        'export type UnreadAlias = string;',
        'export function usedKind(): number {',
        '  return 1;',
        '}',
        ''
      ].join('\n')
    );
    writeFile(root, 'tests/used.test.ts', "import { usedKind } from '../src/kinds';\nexport const v = usedKind();\n");

    const { status, output } = runGate(ORPHAN_GATE, root);
    expect(status).toBe(1);
    expect(output).toContain('UNREAD_TABLE');
    expect(output).toContain('UnreadAlias');
    expect(output).toContain('exported const');
    expect(output).toContain('exported type alias');
    // Non-vacuity: the used function is NOT reported.
    expect(output).not.toContain('usedKind');
  });

  it('exits 0 on a tree where every export has a reader', () => {
    const root = tempTree('orphan-green');
    writeFile(root, 'src/used.ts', 'export function used(): number {\n  return 1;\n}\n');
    writeFile(root, 'tests/used.test.ts', "import { used } from '../src/used';\nexport const value = used();\n");

    const { status } = runGate(ORPHAN_GATE, root);
    expect(status).toBe(0);
  });

  it('does NOT report a module-private uncalled function (the stated non-goal)', () => {
    // P0-1 was exactly this shape: `function forwardingModel(...)` with no
    // caller and no `export`. An export scan cannot see it, and the gate's
    // header says so. Pinning the blindness makes the limitation a fact of the
    // suite rather than a claim in a comment.
    const root = tempTree('orphan-private');
    writeFile(root, 'src/used.ts', 'export function used(): number {\n  return 1;\n}\n');
    writeFile(root, 'src/private.ts', 'function neverCalled(): number {\n  return 2;\n}\n');
    writeFile(root, 'tests/used.test.ts', "import { used } from '../src/used';\nexport const value = used();\n");

    const { status, output } = runGate(ORPHAN_GATE, root);
    expect(status, output).toBe(0);
    expect(output).not.toContain('neverCalled');
  });

  it('counts a named and a type-only re-export as readers, but not a star re-export', () => {
    const root = tempTree('orphan-reexport');
    writeFile(
      root,
      'src/inner.ts',
      [
        'export function viaNamed(): number { return 1; }',
        'export type ViaTypeOnly = string;',
        'export function viaStar(): number { return 2; }',
        ''
      ].join('\n')
    );
    writeFile(
      root,
      'src/barrel.ts',
      [
        "export { viaNamed } from './inner';",
        "export type { ViaTypeOnly } from './inner';",
        "export * from './inner';",
        ''
      ].join('\n')
    );
    writeFile(root, 'tests/x.test.ts', 'export const nothing = 0;\n');

    const { status, output } = runGate(ORPHAN_GATE, root);
    expect(status).toBe(1);
    // Only the star-only symbol survives as an orphan.
    expect(output).toContain('viaStar');
    expect(output).not.toContain('viaNamed');
    expect(output).not.toContain('ViaTypeOnly');
  });

  it('counts a same-file call as a reader', () => {
    const root = tempTree('orphan-samfile');
    writeFile(
      root,
      'src/self.ts',
      [
        'export function usedInternally(): number { return 1; }',
        'function wrapper(): number {',
        '  return usedInternally();',
        '}',
        'export const consumer = wrapper();',
        ''
      ].join('\n')
    );
    writeFile(root, 'tests/x.test.ts', 'export const nothing = 0;\n');

    const { status, output } = runGate(ORPHAN_GATE, root);
    // `consumer` has no reader, so the tree is red — but the internally used
    // function must not be among the findings.
    expect(status).toBe(1);
    expect(output).not.toContain('usedInternally');
    expect(output).toContain('consumer');
  });

  it('accepts an allow-listed orphan with a real reason', () => {
    const root = tempTree('orphan-allowed');
    writeFile(root, 'src/api.ts', 'export function publicEntry(): number {\n  return 3;\n}\n');

    const { status } = runGate(ORPHAN_GATE, root, [
      { symbol: 'publicEntry', file: 'src/api.ts', reason: REAL_REASON }
    ]);
    expect(status).toBe(0);
  });

  it('exits 1 on a STALE allowlist row (the orphan was fixed)', () => {
    const root = tempTree('orphan-stale');
    writeFile(root, 'src/used.ts', 'export function used(): number {\n  return 1;\n}\n');
    writeFile(root, 'tests/used.test.ts', "import { used } from '../src/used';\nexport const value = used();\n");

    const { status, output } = runGate(ORPHAN_GATE, root, [
      { symbol: 'used', file: 'src/used.ts', reason: REAL_REASON }
    ]);
    expect(status).toBe(1);
    expect(output).toContain('allowlist-stale');
  });

  it('exits 1 when an allowlist reason is too short to be auditable', () => {
    const root = tempTree('orphan-short');
    writeFile(root, 'src/api.ts', 'export function publicEntry(): number {\n  return 3;\n}\n');

    const { status, output } = runGate(ORPHAN_GATE, root, [
      { symbol: 'publicEntry', file: 'src/api.ts', reason: 'because' }
    ]);
    expect(status).toBe(1);
    expect(output).toContain('allowlist-reason-too-short');
  });
});

describe('check-test-import-coverage.mjs', () => {
  it('exits 1 when a src module has no test importer', () => {
    const root = tempTree('coverage-red');
    writeFile(root, 'src/covered.ts', 'export const a = 1;\n');
    writeFile(root, 'src/host-protocol.ts', 'export const b = 2;\n');
    writeFile(root, 'tests/covered.test.ts', "import { a } from '../src/covered';\nexport const v = a;\n");

    const { status, output } = runGate(COVERAGE_GATE, root);
    expect(status).toBe(1);
    expect(output).toContain('src/host-protocol.ts');
  });

  it('STILL fails a module reachable only through src/index.ts (the TEST-1 vacuity)', () => {
    // THE case this file was written for. `src/index.ts` imports
    // `./host-protocol`; the test imports `../src/index`, so a closure over ALL
    // relative imports marks `host-protocol.ts` covered. It has no test of its
    // own, which is precisely the `clients.ts` blindness (audit TEST-1).
    const root = tempTree('coverage-entry-only');
    writeFile(root, 'src/host-protocol.ts', 'export function protocol(): number {\n  return 7;\n}\n');
    writeFile(
      root,
      'src/index.ts',
      "import { protocol } from './host-protocol';\nexport const entry = protocol();\n"
    );
    writeFile(root, 'tests/entry.test.ts', "import { entry } from '../src/index';\nexport const v = entry;\n");

    const { status, output } = runGate(COVERAGE_GATE, root);
    expect(status, 'a module covered only by an internal import is NOT covered by a test').toBe(1);
    expect(output).toContain('src/host-protocol.ts');
    // Non-vacuity in the other direction: the entry itself IS covered.
    expect(output).not.toContain('src/index.ts');
  });

  it('does not let a plain src-to-src import propagate coverage', () => {
    // Same rule stated without the entry file, so the failure cannot be
    // explained away as "src/index.ts is special". `covered.ts` has a DIRECT
    // test importer; `uncovered.ts` is reached only from `hub.ts` (an internal
    // import), so it stays red even though a test imports `hub.ts`.
    const root = tempTree('coverage-src-import');
    writeFile(root, 'src/covered.ts', 'export const a = 1;\n');
    writeFile(root, 'src/uncovered.ts', 'export const b = 2;\n');
    writeFile(root, 'src/hub.ts', "import { a } from './covered';\nimport { b } from './uncovered';\nexport const both = [a, b];\n");
    writeFile(
      root,
      'tests/hub.test.ts',
      "import { both } from '../src/hub';\nimport { a } from '../src/covered';\nexport const v = [both, a];\n"
    );

    const { status, output } = runGate(COVERAGE_GATE, root);
    expect(status).toBe(1);
    expect(output).toContain('src/uncovered.ts');
    expect(output).not.toContain('src/covered.ts');
  });

  it('exits 0 when every module is imported directly', () => {
    const root = tempTree('coverage-green');
    writeFile(root, 'src/one.ts', 'export const a = 1;\n');
    writeFile(root, 'src/two.ts', 'export const b = 2;\n');
    writeFile(
      root,
      'tests/both.test.ts',
      "import { a } from '../src/one';\nimport { b } from '../src/two';\nexport const v = a + b;\n"
    );

    const { status } = runGate(COVERAGE_GATE, root);
    expect(status).toBe(0);
  });

  it('counts a barrel re-export as coverage for what it publishes', () => {
    const root = tempTree('coverage-barrel');
    writeFile(root, 'src/inner.ts', 'export const a = 1;\n');
    writeFile(root, 'src/index.ts', "export * from './inner.js';\n");
    writeFile(root, 'tests/barrel.test.ts', "import { a } from '../src';\nexport const v = a;\n");

    const { status } = runGate(COVERAGE_GATE, root);
    expect(status).toBe(0);
  });

  it('accepts an allow-listed module and rejects a stale row', () => {
    const covered = tempTree('coverage-allow');
    writeFile(covered, 'src/lonely.ts', 'export type Contract = string;\n');

    const allowed = runGate(COVERAGE_GATE, covered, [
      { file: 'src/lonely.ts', reason: REAL_REASON }
    ]);
    expect(allowed.status, allowed.output).toBe(0);

    // The same row against a module that IS imported is stale.
    const stale = tempTree('coverage-allow-stale');
    writeFile(stale, 'src/used.ts', 'export const a = 1;\n');
    writeFile(stale, 'tests/used.test.ts', "import { a } from '../src/used';\nexport const v = a;\n");

    const rejected = runGate(COVERAGE_GATE, stale, [{ file: 'src/used.ts', reason: REAL_REASON }]);
    expect(rejected.status).toBe(1);
    expect(rejected.output).toContain('allowlist-stale');
  });
});

describe('both gates against THIS repository', () => {
  it('reports a clean tree for the orphan gate (the production allowlist is current)', () => {
    // The production table is used deliberately here: an entry that names a
    // fixed symbol fails the run, so this pins "the allowlist is NOT stale".
    const result = spawnSync(process.execPath, [ORPHAN_GATE], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024
    });
    expect(result.status, (result.stdout ?? '') + (result.stderr ?? '')).toBe(0);
  });

  it('reports a clean tree for the import-coverage gate', () => {
    const result = spawnSync(process.execPath, [COVERAGE_GATE], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024
    });
    expect(result.status, (result.stdout ?? '') + (result.stderr ?? '')).toBe(0);
  });

  it('keeps src/dsh-bridge/clients.ts covered by a DIRECT test import', () => {
    // TEST-1's concrete subject. The gate must not be satisfied by the module
    // being reachable from `src/dsh-bridge/index.ts`; the direct importer is
    // what makes the coverage real.
    const testSource = fs.readFileSync(
      path.join(REPO_ROOT, 'tests', 'unit', 'dsh-bridge', 'clients.test.ts'),
      'utf8'
    );
    expect(testSource).toMatch(/from '\.\.\/\.\.\/\.\.\/src\/dsh-bridge\/clients'/);
  });
});
