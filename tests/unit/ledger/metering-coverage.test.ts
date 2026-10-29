/**
 * P3-B: the metering coverage gate must FAIL on an unmetered model call.
 *
 * The gate is driven as a child process exactly as CI would run it. Fixtures are
 * built under the OS temp dir, so the real repository is only READ: no test can
 * turn green by mutating the tree it is auditing.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const gateScript = path.join(repoRoot, 'scripts', 'eval', 'metering-coverage.mjs');
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs.splice(0).reverse()) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface GateResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runGate(args: readonly string[]): GateResult {
  const result = spawnSync(process.execPath, [gateScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

interface Fixture {
  readonly root: string;
  readonly allowlist: string;
}

function makeFixture(files: Readonly<Record<string, string>>, allowlist: unknown): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p3b-gate-fixture-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, 'src', name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  const allowlistPath = path.join(root, 'allowlist.json');
  fs.writeFileSync(allowlistPath, JSON.stringify(allowlist), 'utf8');
  return { root, allowlist: allowlistPath };
}

describe('metering coverage gate: the real tree', () => {
  it('passes on the current tree with exactly the audited allow-list', () => {
    const result = runGate(['--json']);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      scannedFiles: number;
      occurrences: number;
      groups: { key: string; count: number }[];
      violations: unknown[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.scannedFiles).toBeGreaterThan(50);
    expect(parsed.violations).toEqual([]);
    expect(parsed.groups.map((group) => group.key).sort()).toEqual([
      'src/dsh-bridge/agent-loop-executor.ts|complete.bind',
      'src/dsh-bridge/agent-loop-executor.ts|planNext.bind',
      'src/dsh-bridge/metered-model-adapter.ts|complete',
      'src/index.ts|complete'
    ]);
  });

  it('prints a human-readable OK line without --json', () => {
    const result = runGate([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[metering-coverage] OK');
    expect(result.stdout).toContain('0 unmetered call(s)');
  });
});

describe('metering coverage gate: negative controls (fixtures only)', () => {
  it('FAILS on an unlisted .complete() call', () => {
    const fixture = makeFixture(
      { 'violating.ts': 'const answer = model.complete({ purpose: "compose" });\n' },
      []
    );
    const result = runGate(['--root', fixture.root, '--allowlist', fixture.allowlist]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unmetered-call');
    expect(result.stderr).toContain('src/violating.ts:1');
    expect(result.stderr).toContain('[complete]');
  });

  it('FAILS on an unlisted .planNext() call', () => {
    const fixture = makeFixture(
      { 'violating.ts': 'const decision = planner.planNext({ iteration: 0 });\n' },
      []
    );
    const result = runGate(['--root', fixture.root, '--allowlist', fixture.allowlist]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[planNext]');
  });

  it('FAILS on an unlisted .complete.bind() escape hatch', () => {
    const fixture = makeFixture(
      { 'violating.ts': 'const bound = model.complete.bind(model);\n' },
      []
    );
    const result = runGate(['--root', fixture.root, '--allowlist', fixture.allowlist]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[complete.bind]');
  });

  it('does NOT match comments or string literals', () => {
    const fixture = makeFixture(
      {
        'clean.ts': [
          '// model.complete({ purpose: "compose" }) in a comment',
          "const text = 'model.complete(';",
          'const template = `model.planNext(`;',
          'const object = { complete: 1 };',
          ''
        ].join('\n')
      },
      []
    );
    const result = runGate(['--root', fixture.root, '--allowlist', fixture.allowlist]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('0 unmetered call(s)');
  });

  it('FAILS when an allow-list entry is stale (count mismatch)', () => {
    const fixture = makeFixture(
      { 'allowed.ts': 'model.complete({ purpose: "probe" });\n' },
      [
        {
          file: 'src/allowed.ts',
          symbol: 'complete',
          expectedCount: 2,
          reason: 'fixture expects two calls'
        }
      ]
    );
    const result = runGate(['--root', fixture.root, '--allowlist', fixture.allowlist]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('allowlist-count-mismatch');
  });

  it('FAILS on a stale entry whose file no longer calls the model', () => {
    const fixture = makeFixture(
      { 'clean.ts': 'const nothing = 1;\n' },
      [
        {
          file: 'src/clean.ts',
          symbol: 'complete',
          expectedCount: 1,
          reason: 'stale fixture entry'
        }
      ]
    );
    const result = runGate(['--root', fixture.root, '--allowlist', fixture.allowlist]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('stale-allowlist-entry');
  });

  it('PASSES when the exact call is explicitly allow-listed', () => {
    const fixture = makeFixture(
      { 'allowed.ts': 'model.complete({ purpose: "probe" });\n' },
      [
        {
          file: 'src/allowed.ts',
          symbol: 'complete',
          expectedCount: 1,
          reason: 'fixture allow-list entry'
        }
      ]
    );
    const result = runGate(['--root', fixture.root, '--allowlist', fixture.allowlist]);
    expect(result.status).toBe(0);
  });
});
