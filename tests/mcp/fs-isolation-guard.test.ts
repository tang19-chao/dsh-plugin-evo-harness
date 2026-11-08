/**
 * Self-test for the filesystem isolation guard (tests/mcp/fixtures/fs-isolation.ts).
 *
 * WHY THIS FILE EXISTS SEPARATELY
 *   `tests/mcp/evo-run-e2e.test.ts` asserts, at the end of EVERY test, that the
 *   guard recorded no creation outside the temp root and no access under a real
 *   DSH data root. That assertion is only meaningful if the guard genuinely
 *   classifies paths, so the guard needs its own proof — and the proof needs
 *   deliberately out-of-root calls, which must not run inside a file whose
 *   afterEach asserts "creation outside the root never happens".
 *
 * WHAT IT PINS, in both directions
 *   - a creation outside the allowed root, and under a forbidden root, IS
 *     reported (`createdOutsideAllowed`, `forbiddenAccesses`) and refused
 *     (`blockedCalls`, EACCES) — so a silent classifier fails here;
 *   - a creation inside the allowed root is NOT reported — so a classifier that
 *     flags everything fails here too;
 *   - the hook set is complete and the import-shape boundary is asserted
 *     EXPLICITLY: the live `fs.promises` object is watched, while a named import
 *     of `node:fs/promises` is a module-initialization snapshot and is not. The
 *     e2e file compensates for that second fact structurally (its baseline
 *     instance uses a temp dataDir, and it asserts the resolved dataDir), so
 *     the boundary is documented in a test instead of only in a comment.
 *
 * Nothing here touches real data: the "outside" directory is a fresh temp
 * directory that is deliberately NOT under TEST_TMP_ROOT, and it is removed
 * afterwards.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { mkdir as namedMkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createEvoMcpServer } from '../../src/mcp/server';
import type { IModelAdapter } from '../../src/types/contracts';
import { TEST_TMP_ROOT } from '../unit/persistence/fixtures';
import {
  fsPromisesLive,
  installFsIsolationGuard,
  isWithinPath,
  realDshRoots,
  samePath
} from './fixtures/fs-isolation';

/** A scripted model: the defect below never reaches a model call. */
function scriptedModel(): IModelAdapter {
  return {
    async complete() {
      return { text: 'scripted', finishReason: 'stop', model: 'scripted' };
    }
  };
}

const scratchDirs: string[] = [];

/**
 * A temp directory that is deliberately NOT under TEST_TMP_ROOT.
 *
 * The path is CONSTRUCTED rather than taken from `mkdir`'s return value: with
 * `{ recursive: true }` on Windows, Node returns a `\\?\`-prefixed long path
 * (measured in this session), which would make every later path comparison in
 * this file depend on that prefix instead of on the classifier.
 */
async function makeScratchDir(label: string): Promise<string> {
  const dir = path.join(os.tmpdir(), 'evo-fs-guard-' + label + '-' + String(process.pid));
  await mkdir(dir, { recursive: true });
  scratchDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of scratchDirs.splice(0, scratchDirs.length)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe('path predicates', () => {
  it('isWithinPath is a segment-wise check, not a string prefix', () => {
    expect(isWithinPath(TEST_TMP_ROOT, path.join(TEST_TMP_ROOT, 'child'))).toBe(true);
    expect(isWithinPath(TEST_TMP_ROOT, TEST_TMP_ROOT)).toBe(true);
    // A sibling whose name merely starts with the root's must not pass.
    expect(isWithinPath(path.join(TEST_TMP_ROOT, 'x'), path.join(TEST_TMP_ROOT, 'xy', 'child'))).toBe(
      false
    );
    expect(isWithinPath(path.join(TEST_TMP_ROOT, 'child'), TEST_TMP_ROOT)).toBe(false);
  });

  it('samePath compares resolved absolute paths', () => {
    expect(samePath(TEST_TMP_ROOT, TEST_TMP_ROOT)).toBe(true);
    expect(samePath(TEST_TMP_ROOT, path.join(TEST_TMP_ROOT, '.'))).toBe(true);
    expect(samePath(TEST_TMP_ROOT, path.join(TEST_TMP_ROOT, '..'))).toBe(false);
  });

  it('realDshRoots names ~/.dsh without touching the filesystem', () => {
    const roots = realDshRoots({});
    expect(roots).toEqual([path.join(os.homedir(), '.dsh')]);
    const withEnv = realDshRoots({ DSH_DATA_DIR: 'C:/tmp/dsh-root', EVO_HARNESS_DATA_DIR: 'C:/tmp/evo-root' });
    expect(withEnv).toContain(path.resolve('C:/tmp/dsh-root'));
    expect(withEnv).toContain(path.resolve('C:/tmp/evo-root'));
    expect(withEnv).toContain(path.join(os.homedir(), '.dsh'));
    // An empty variable means "unset", matching the resolver's own rule
    // (src/persistence/data-dir.ts:93-99 readEnv).
    expect(realDshRoots({ DSH_DATA_DIR: '   ' }).length).toBe(1);
  });
});

describe('classifier and enforcement', () => {
  it('reports out-of-root creations, refuses writes under a forbidden root, and stays quiet inside the root', async () => {
    const outside = await makeScratchDir('outside');
    const guard = installFsIsolationGuard({
      allowedRoots: [TEST_TMP_ROOT],
      forbiddenRoots: [outside]
    });
    try {
      // 1. A creation under a FORBIDDEN root is refused before it lands, with
      //    an EACCES-shaped error so the caller's own error path still runs.
      //    The call goes through the LIVE `fs.promises` object — the surface
      //    the guard wraps and the one src/persistence uses (data-dir.ts:30);
      //    a named import is a module-init snapshot and is proven below to
      //    bypass the guard, which is why it cannot be used to assert refusal.
      const refused = path.join(outside, 'refused');
      await expect(fsPromisesLive()['mkdir']!(refused, { recursive: true })).rejects.toMatchObject({
        code: 'EACCES'
      });
      expect(guard.blockedCalls).toEqual([expect.stringMatching(/^mkdir /u)]);
      expect(guard.forbiddenAccesses.length).toBeGreaterThan(0);
      expect(guard.createdOutsideAllowed.length).toBe(1);
      expect(guard.createdOutsideAllowed[0]).toContain('refused');
      // The refusal is real: nothing was created there.
      await expect(rm(refused, { recursive: true })).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      guard.restore();
    }

    // 2. A creation inside the allowed root is NOT a violation.
    const quiet = installFsIsolationGuard({ allowedRoots: [TEST_TMP_ROOT], forbiddenRoots: [] });
    try {
      await fsPromisesLive()['mkdir']!(path.join(TEST_TMP_ROOT, 'guard-inside-probe'), { recursive: true });
      expect(quiet.createdDirs.some((entry) => entry.includes('guard-inside-probe'))).toBe(true);
      expect(quiet.createdOutsideAllowed).toEqual([]);
      expect(quiet.forbiddenAccesses).toEqual([]);
      expect(quiet.blockedCalls).toEqual([]);
    } finally {
      quiet.restore();
      await rm(path.join(TEST_TMP_ROOT, 'guard-inside-probe'), { recursive: true, force: true });
    }

    // 3. An out-of-root creation is reported even when the root is not
    //    forbidden — the predicate the e2e file's afterEach relies on.
    const classified = installFsIsolationGuard({
      allowedRoots: [TEST_TMP_ROOT],
      forbiddenRoots: [],
      blockForbidden: false
    });
    try {
      await fsPromisesLive()['mkdir']!(path.join(outside, 'classified'), { recursive: true });
      expect(classified.createdOutsideAllowed.length).toBe(1);
      expect(classified.createdOutsideAllowed[0]).toContain('classified');
      expect(classified.forbiddenAccesses).toEqual([]);
      expect(classified.blockedCalls).toEqual([]);
    } finally {
      classified.restore();
    }

    // 4. READS under a forbidden root are recorded but NOT refused: the
    //    assertion is what fails, and the caller's own error handling stays
    //    intact (a read of a missing file must still surface ENOENT, not the
    //    guard's EACCES).
    const reader = installFsIsolationGuard({ allowedRoots: [TEST_TMP_ROOT], forbiddenRoots: [outside] });
    try {
      await expect(fsPromisesLive()['readFile']!(path.join(outside, 'never-existed'))).rejects.toMatchObject({
        code: 'ENOENT'
      });
      expect(reader.forbiddenAccesses.length).toBeGreaterThan(0);
      expect(reader.forbiddenAccesses[0]).toContain('never-existed');
      expect(reader.blockedCalls).toEqual([]);
    } finally {
      reader.restore();
    }
  });

  it('reports every hook it installs, and the import-shape boundary is explicit', async () => {
    const guard = installFsIsolationGuard({ allowedRoots: [TEST_TMP_ROOT], forbiddenRoots: [] });
    try {
      expect(guard.hooksComplete()).toBe(true);
      expect(guard.hookFailures).toEqual([]);
      expect(guard.hooked).toContain('promises.mkdir');
      expect(guard.hooked).toContain('promises.open');
      expect(guard.hooked).toContain('promises.readFile');
      expect(guard.hooked).toContain('fs.mkdirSync');
      expect(guard.hooked.length).toBeGreaterThanOrEqual(39);

      // The LIVE object is watched...
      const live = fsPromisesLive();
      expect(typeof live['mkdir']).toBe('function');
      await live['mkdir']!(path.join(TEST_TMP_ROOT, 'guard-live-probe'), { recursive: true });
      expect(guard.createdDirs.some((entry) => entry.includes('guard-live-probe'))).toBe(true);

      // ...while a NAMED import of 'node:fs/promises' is a snapshot taken at
      // module initialization: its calls bypass the guard. This is asserted
      // rather than assumed, so if a future Node build changes the shape the
      // test tells us the guard's coverage changed too.
      await namedMkdir(path.join(TEST_TMP_ROOT, 'guard-snapshot-probe'), { recursive: true });
      expect(guard.createdDirs.some((entry) => entry.includes('guard-snapshot-probe'))).toBe(false);
    } finally {
      guard.restore();
      await rm(path.join(TEST_TMP_ROOT, 'guard-live-probe'), { recursive: true, force: true });
      await rm(path.join(TEST_TMP_ROOT, 'guard-snapshot-probe'), { recursive: true, force: true });
    }
  });

  it('wraps and restores idempotently', async () => {
    const before = fsPromisesLive()['mkdir'];
    const first = installFsIsolationGuard({ allowedRoots: [TEST_TMP_ROOT], forbiddenRoots: [] });
    const wrapped = fsPromisesLive()['mkdir'];
    expect(wrapped).not.toBe(before);
    first.restore();
    first.restore();
    expect(fsPromisesLive()['mkdir']).toBe(before);

    // A second guard wraps again from the restored state (no double-wrap left
    // behind by the first).
    const second = installFsIsolationGuard({ allowedRoots: [TEST_TMP_ROOT], forbiddenRoots: [] });
    try {
      expect(second.hooksComplete()).toBe(true);
      await fsPromisesLive()['mkdir']!(path.join(TEST_TMP_ROOT, 'guard-restore-probe'), { recursive: true });
      expect(second.createdDirs.filter((entry) => entry.includes('guard-restore-probe')).length).toBe(1);
    } finally {
      second.restore();
      await rm(path.join(TEST_TMP_ROOT, 'guard-restore-probe'), { recursive: true, force: true });
    }
    expect(fsPromisesLive()['mkdir']).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// negative control: the guard actually catches the defect it was written for
// ---------------------------------------------------------------------------

describe('negative control (the rev8 slow-runner defect shape)', () => {
  it('building a server WITHOUT assembly.dataDir is recorded as a violation against a real DSH root', async () => {
    // This is the exact shape the slow-runner case had before the fix:
    //   createEvoMcpServer({ model, assembly: { options: { runBranch } } })
    // with no dataDir — so ready() resolves the module default root, which is
    // <home>/.dsh/evo-harness/profiles/<profile> (src/persistence/data-dir.ts:142-152).
    //
    // Kept as a NEGATIVE CONTROL so the isolation assertions in
    // tests/mcp/evo-run-e2e.test.ts cannot pass vacuously: this proves the guard
    // reports the defect if such an instance ever returns to the suite. The
    // guard refuses the mkdir under the forbidden root BEFORE it lands, so no
    // real directory is created; what the server reports is the refusal.
    //
    // The forbidden root is derived from a REDIRECTED data root rather than the
    // real ~/.dsh: the server only has to aim at an out-of-temp-root directory;
    // aiming at a scratch one proves the classifier (and that the write is
    // refused) without putting real state in reach. It must live OUTSIDE
    // TEST_TMP_ROOT, or "outside the allowed root" would be false by
    // construction and the control would prove nothing.
    const fakeDshRoot = await makeScratchDir('dsh-root');
    expect(isWithinPath(TEST_TMP_ROOT, fakeDshRoot)).toBe(false);
    const originalHome = process.env['HOME'];
    const originalUserProfile = process.env['USERPROFILE'];
    const originalDshDataDir = process.env['DSH_DATA_DIR'];
    process.env['HOME'] = fakeDshRoot;
    process.env['USERPROFILE'] = fakeDshRoot;
    process.env['DSH_DATA_DIR'] = fakeDshRoot;

    const guard = installFsIsolationGuard({
      allowedRoots: [TEST_TMP_ROOT],
      forbiddenRoots: [fakeDshRoot]
    });
    let instance: ReturnType<typeof createEvoMcpServer> | undefined;
    try {
      instance = createEvoMcpServer({
        model: scriptedModel(),
        // Swallow the assembly's "DSH_DATA_DIR is set" warning: this control is
        // deliberately in that configuration and must not spam stderr.
        log: () => {},
        now: (() => {
          let tick = 1_700_000_000_000;
          return () => (tick += 1);
        })(),
        assembly: { options: { runBranch: (async () => ({ status: 'succeeded' })) as never } }
      });
      // ready() rejects: the guard refused the forbidden mkdir.
      await expect(instance.ready).rejects.toMatchObject({ code: 'EACCES' });

      // The violation list is what the e2e file asserts is empty, and here it
      // is non-empty for exactly the defect shape.
      expect(guard.createdOutsideAllowed.length).toBeGreaterThan(0);
      expect(guard.blockedCalls.length).toBeGreaterThan(0);
      const targetedARealRoot = guard.createdOutsideAllowed.some((entry) =>
        isWithinPath(fakeDshRoot, entry.replace(/^mkdir /u, ''))
      );
      expect(targetedARealRoot).toBe(true);
      // Every blocked call is a REFUSAL of a creation, never a completed write.
      for (const blocked of guard.blockedCalls) {
        expect(blocked).toMatch(/^mkdir /u);
      }
    } finally {
      await instance?.dispose().catch(() => {});
      guard.restore();
      process.env['HOME'] = originalHome;
      process.env['USERPROFILE'] = originalUserProfile;
      if (originalDshDataDir === undefined) {
        delete process.env['DSH_DATA_DIR'];
      } else {
        process.env['DSH_DATA_DIR'] = originalDshDataDir;
      }
    }
  }, 30_000);
});
