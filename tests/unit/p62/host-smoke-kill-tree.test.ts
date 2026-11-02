/**
 * rev6 cross-audit CI-4 + CI-5: the host-smoke runner's process boundary.
 *
 * CI-4 (tree reaping): on the run deadline the runner used to `child.kill()`
 * the single in-host pid. The in-host smoke spawns the MCP backend as its own
 * child, so a timeout inside the backend's work window orphaned the
 * grandchild - on Windows TerminateProcess never touches children, and on
 * POSIX only the direct child was signalled. The reaper must cover the whole
 * tree: win32 via `taskkill /T /F`, POSIX via a process-group signal (the
 * in-host child is spawned `detached` for exactly this purpose). The test
 * below builds a real child->grandchild tree and asserts BOTH die.
 *
 * CI-5 (doc drift): the runner header used to claim the frozen-report guard
 * protects rc1 only - the t33 `FROZEN_REPORT_RELATIVES` list has protected
 * both rc1 and rc2 for a long time (behaviour pinned in
 * tests/e2e/host-smoke/report-path.test.ts). The header must point at the
 * guard instead of understating it.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killProcessTree } from '../../../scripts/host-smoke/kill-tree.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const runScript = path.join(repoRoot, 'scripts', 'host-smoke', 'run.mjs');

const spawnedPids: number[] = [];
const tempFiles: string[] = [];

function pidAlive(pid: number | undefined): boolean {
  if (typeof pid !== 'number' || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll a predicate with a deadline; resolves to its final value. */
async function until(predicate: () => boolean, timeoutMs: number, stepMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return predicate();
}

afterAll(() => {
  // Defensive cleanup: a failed assertion must not leak processes.
  for (const pid of spawnedPids) {
    if (pidAlive(pid)) {
      killProcessTree(pid, { signal: 'SIGKILL' });
    }
  }
  for (const file of tempFiles) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // A leftover temp file must not turn a green suite red.
    }
  }
});

describe('killProcessTree (rev6 CI-4): a timed-out run must not orphan grandchildren', () => {
  it('ignores pid values that cannot name a process', () => {
    expect(() => killProcessTree(undefined)).not.toThrow();
    expect(() => killProcessTree(0)).not.toThrow();
    expect(() => killProcessTree(-1)).not.toThrow();
  });

  it('kills the whole child -> grandchild tree, not just the direct child', async () => {
    // The in-host smoke shape, shrunk to its process skeleton: a child that
    // spawns a long-lived grandchild (the MCP backend stand-in) and stays
    // alive itself. Both pids are recorded in a file - stdout would race.
    const infoFile = path.join(os.tmpdir(), `kill-tree-info-${process.pid}-${Date.now()}.json`);
    const childScript = path.join(os.tmpdir(), `kill-tree-child-${process.pid}-${Date.now()}.cjs`);
    tempFiles.push(infoFile, childScript);
    fs.writeFileSync(
      childScript,
      [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        'fs.writeFileSync(process.argv[2], JSON.stringify({ childPid: process.pid, grandchildPid: grandchild.pid }), "utf8");',
        'setInterval(() => {}, 1000);',
        ''
      ].join('\n'),
      'utf8'
    );
    const child = spawn(process.execPath, [childScript, infoFile], {
      stdio: 'ignore',
      // Same detachment rule as run.mjs: on POSIX the child must lead a
      // process group so the group signal can reach the grandchild.
      detached: process.platform !== 'win32',
      windowsHide: true
    });
    spawnedPids.push(child.pid!);

    const infoAppeared = await until(() => fs.existsSync(infoFile), 10_000);
    expect(infoAppeared, 'the child fixture never recorded its pids').toBe(true);
    const info = JSON.parse(fs.readFileSync(infoFile, 'utf8')) as { childPid: number; grandchildPid: number };
    expect(info.childPid).toBe(child.pid);
    spawnedPids.push(info.grandchildPid);
    expect(pidAlive(info.childPid), 'fixture child not alive before the kill').toBe(true);
    expect(pidAlive(info.grandchildPid), 'fixture grandchild not alive before the kill').toBe(true);

    killProcessTree(child.pid);

    const childDead = await until(() => !pidAlive(info.childPid), 10_000);
    const grandchildDead = await until(() => !pidAlive(info.grandchildPid), 10_000);
    // The grandchild is the whole point: a single-pid kill leaves it running.
    expect(grandchildDead, 'the grandchild (MCP backend stand-in) survived the tree kill').toBe(true);
    expect(childDead, 'the direct child survived the tree kill').toBe(true);
  }, 30_000);
});

describe('run.mjs header vs the frozen-report guard (rev6 CI-5)', () => {
  it('no longer claims rc1-only protection and points at FROZEN_REPORT_RELATIVES', () => {
    const source = fs.readFileSync(runScript, 'utf8');
    // The stale t31 sentence asserted the guard "currently protects rc1 only".
    expect(source).not.toContain('protects rc1 only');
    expect(source).toContain('FROZEN_REPORT_RELATIVES');
  });
});
