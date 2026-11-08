/**
 * Filesystem isolation guard for the MCP suites (rev8 leftover fix).
 *
 * WHY IT EXISTS
 *   Building a server with no `assembly.dataDir` makes it resolve, on first
 *   use, `<home>/.dsh/evo-harness/profiles/<profile>` (src/persistence/data-dir.ts:142-152)
 *   — the REAL plugin data directory — and then create it, open the tree-pool
 *   log there and append to the JitRL experience log. A test that builds a
 *   second, un-injected server therefore touches real plugin state behind the
 *   test's back, which is exactly the defect this guard pins.
 *
 *   The build is LAZY in the current server: `buildEvoAssembly` starts on the
 *   first use, not in the constructor (src/mcp/server.ts:520-580,1268), so mere
 *   construction is harmless, while any path that reads `instance.ready` or
 *   calls a tool is not. Measured in this session against the current file:
 *   construction alone records no mkdir, while `instance.ready` on a
 *   dataDir-less instance records
 *   `mkdir <home>/.dsh/evo-harness/profiles/default`.
 *
 * WHAT THE GUARD PROVES (two independent negative facts)
 *   1. CREATED DIRECTORIES: every `mkdir`/`mkdtemp` target recorded while the
 *      guard is active must live under an allowed root (the suite's temp root
 *      under `work/persistence-tmp`). `createdOutsideAllowed` is otherwise
 *      non-empty, which means something in the served code created a
 *      directory outside the test's temporary tree.
 *   2. NO REAL STATE IS TOUCHED: every operation recorded on a path under a
 *      forbidden root (`~/.dsh`, plus DSH_DATA_DIR / EVO_HARNESS_DATA_DIR when
 *      they are set in this process) is a violation — whether it was a read
 *      (`readFile`, `readdir`, `stat`, `access`, read-mode `open`, …) or a
 *      write. The guard never touches those paths itself: it only inspects the
 *      path strings the served code hands to fs, so the assertion is made
 *      without reading real plugin state.
 *
 * HOW IT HOOKS (measured in this session, per import shape)
 *   The `node:fs` module object's `promises` property IS the object that
 *   `import { promises as fs } from 'node:fs'` (used by
 *   src/persistence/data-dir.ts:30 and therefore by every store write path) and
 *   the DEFAULT import of `'node:fs/promises'` (src/persistence/tree-pool.store.ts:29)
 *   both resolve to. A probe over four shapes measured this exactly:
 *   `fs.promises.mkdir` and the default import of `'node:fs/promises'` route
 *   through a wrapped live object; a NAMESPACE import (`import * as fsp`) and a
 *   NAMED import (`import { mkdir }`) of `'node:fs/promises'` are snapshots
 *   taken at module initialization and do NOT. The sync variants on the module
 *   object are wrapped too (src/ledger/* uses them; nothing in the MCP path
 *   does today, but a future one must not slip past).
 *
 * HONEST BOUNDARY (stated so the guard is not read as more than it is)
 *   Consumers reached only through a snapshot import are not recorded: today
 *   that is `src/jitrl/stores/jsonl.store.ts:97`, which does
 *   `await import('node:fs/promises')` for the durable JitRL experience log.
 *   Those paths are still covered STRUCTURALLY: the log path is derived from
 *   `persistence.dataDir` (src/index.ts:2071-2076), and the isolation test
 *   asserts the assembly's resolved `dataDir` IS the temp directory. The guard
 *   is a path-recording proof over the live module-object surface, not a
 *   sandbox, and the tests do not claim otherwise.
 *
 * NON-VACUITY
 *   `hooked` lists what was actually wrapped and `hookFailures` what could not
 *   be; the tests assert `hooksComplete()` so a Node upgrade that makes a
 *   function non-writable turns the isolation test red instead of silently
 *   recording nothing. The guard's own classifier, its refusal semantics and
 *   its ability to catch the defect above (a dataDir-less instance aiming at an
 *   out-of-root profile directory) are self-tested in
 *   tests/mcp/fs-isolation-guard.test.ts, so "zero violations" cannot mean "the
 *   classifier never fires".
 *
 * ENFORCEMENT (why a regression cannot land in the real directory)
 *   A DETECTOR only proves a regression after it already wrote. A write-side
 *   hook that would create a directory — or write — under a forbidden root is
 *   therefore REFUSED with an EACCES-shaped error before the original function
 *   runs (the call is still recorded). Reads of a forbidden root are recorded
 *   but allowed through: the assertion is what fails, and observation is more
 *   useful than masking the caller's error handling. `blockForbidden` turns
 *   this off for a scenario that must observe the raw calls.
 */

import fsDefault from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TEST_TMP_ROOT } from '../../unit/persistence/fixtures';

/** The live `fs.promises` object — the one `import { promises } from 'node:fs'` and the default import of `node:fs/promises` both resolve to. */
export function fsPromisesLive(): Record<string, any> {
  return (fsDefault as unknown as { promises: Record<string, any> }).promises;
}

/**
 * Create a temp directory under the suite's audited temp root, THROUGH the
 * shared `fs.promises` object so the isolation guard records the call.
 *
 * `tests/unit/persistence/fixtures.ts` does `import { mkdir, mkdtemp } from
 * 'node:fs/promises'`, and a NAMED import is a SNAPSHOT of the functions taken
 * at module initialization (measured in this session: a named import and a
 * namespace import of 'node:fs/promises' do NOT route through the live object;
 * only `fs.promises.*` and the default import of 'node:fs/promises' do), so its
 * creations are invisible to a guard that wraps the live object. Verified:
 * under an active guard `makeTempDir` records nothing while this helper records
 * its mkdir/mkdtemp. Using this helper for the instances under audit keeps the
 * negative proof ("every created directory lives in the temp root") complete
 * instead of merely true-by-omission. The root is the same one `makeTempDir`
 * uses, so cleanup and disk placement are unchanged.
 */
export async function makeTrackedTempDir(label: string): Promise<string> {
  const promises = fsPromisesLive();
  await promises['mkdir']!(TEST_TMP_ROOT, { recursive: true });
  return (await promises['mkdtemp']!(path.join(TEST_TMP_ROOT, label + '-'))) as string;
}

/** Async fs operations the guard wraps on the shared `fs.promises` object. */
const ASYNC_OPERATIONS = [
  'mkdir',
  'mkdtemp',
  'open',
  'writeFile',
  'appendFile',
  'rename',
  'rm',
  'rmdir',
  'unlink',
  'copyFile',
  'cp',
  'truncate',
  'chmod',
  'readFile',
  'readdir',
  'stat',
  'lstat',
  'access',
  'opendir',
  'realpath',
  'readlink'
] as const;

/** Sync fs operations the guard wraps on the `node:fs` module object. */
const SYNC_OPERATIONS = [
  'mkdirSync',
  'mkdtempSync',
  'openSync',
  'writeFileSync',
  'appendFileSync',
  'renameSync',
  'rmSync',
  'rmdirSync',
  'unlinkSync',
  'copyFileSync',
  'truncateSync',
  'chmodSync',
  'readFileSync',
  'readdirSync',
  'statSync',
  'lstatSync',
  'accessSync',
  'realpathSync'
] as const;

/** Operations that create a directory (the "created directories" assertion). */
const DIRECTORY_CREATORS = new Set(['mkdir', 'mkdtemp', 'mkdirSync', 'mkdtempSync']);

/** Operations that touch two paths (source read, destination written). */
const TWO_PATH_OPERATIONS = new Set(['rename', 'renameSync', 'copyFile', 'copyFileSync', 'cp']);

/** `open` flags that make the call a writer rather than a reader. */
const WRITE_FLAG = /[wax+]/;

/** Everything the guard recorded while active. */
export interface FsIsolationReport {
  /** Every directory-creating call's target, in call order. */
  readonly createdDirs: readonly string[];
  /** Created-directory targets that are NOT under an allowed root. */
  readonly createdOutsideAllowed: readonly string[];
  /** Every operation whose path is under a forbidden root. */
  readonly forbiddenAccesses: readonly string[];
  /** Forbidden writes/creations refused before they reached the filesystem. */
  readonly blockedCalls: readonly string[];
  /** Every written/created path (diagnostics only). */
  readonly writtenPaths: readonly string[];
  /** Every read path (diagnostics only). */
  readonly readPaths: readonly string[];
  /** Both violation lists concatenated: `expect(violations).toEqual([])`. */
  readonly violations: readonly string[];
  /** Functions actually wrapped ('promises.mkdir', 'fs.mkdirSync', …). */
  readonly hooked: readonly string[];
  /** Operations that could NOT be wrapped: a hook gap, never silent. */
  readonly hookFailures: readonly string[];
}

/** The installed guard: the live report plus restoration. */
export interface FsIsolationGuard extends FsIsolationReport {
  /** Remove every wrapper (idempotent). */
  restore(): void;
  /** True when every requested operation was actually wrapped. */
  hooksComplete(): boolean;
}

/** Normalize a path for comparison (Windows is case-insensitive). */
function normalizePath(target: string): string {
  const resolved = path.resolve(target).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** True when `candidate` is `root` itself or lives under it (lexically). */
export function isWithinPath(root: string, candidate: string): boolean {
  const base = normalizePath(root);
  const target = normalizePath(candidate);
  if (target === base) {
    return true;
  }
  return target.startsWith(base + path.sep) || target.startsWith(base + '/');
}

/** True when both paths normalize to the same absolute path. */
export function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

/**
 * The real plugin/DSH data roots this process would resolve when nothing
 * redirects it. PURE path arithmetic: `os.homedir()` and the environment are
 * read, no filesystem call is made, so asking the question never touches the
 * real directory.
 *
 * `~/.dsh` is the whole DSH tree (the Cordis plugin's `profiles/<name>` lives
 * there — src/persistence/data-dir.ts:149). The two documented env roots are
 * added only when this process actually exports them.
 */
export function realDshRoots(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const roots = new Set<string>([path.join(os.homedir(), '.dsh')]);
  for (const name of ['DSH_DATA_DIR', 'EVO_HARNESS_DATA_DIR'] as const) {
    const value = env[name];
    if (typeof value === 'string' && value.trim().length > 0) {
      roots.add(path.resolve(value));
    }
  }
  return [...roots];
}

/** One path argument of a hooked call, as text (undefined when not a path). */
function pathArgument(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.length === 0 ? undefined : value;
  }
  if (value instanceof URL) {
    return value.protocol === 'file:' ? fileURLToPath(value) : undefined;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }
  // A numeric first argument is a file descriptor, not a path.
  return undefined;
}

/** Install the guard: returns the live report plus `restore()`. */
export function installFsIsolationGuard(options: {
  /** Roots where creation is legitimate (the suite's temp root). */
  readonly allowedRoots: readonly string[];
  /** Roots that must never be touched (the real DSH/plugin data). */
  readonly forbiddenRoots: readonly string[];
  /** Refuse writes/creations under a forbidden root (default true). */
  readonly blockForbidden?: boolean;
}): FsIsolationGuard {
  const createdDirs: string[] = [];
  const createdOutsideAllowed: string[] = [];
  const forbiddenAccesses: string[] = [];
  const blockedCalls: string[] = [];
  const writtenPaths: string[] = [];
  const readPaths: string[] = [];
  const hooked: string[] = [];
  const hookFailures: string[] = [];
  const restores: (() => void)[] = [];

  const allowed = [...options.allowedRoots];
  const forbidden = [...options.forbiddenRoots];
  const blockForbidden = options.blockForbidden !== false;

  /**
   * Record one path argument. Returns the forbidden root it fell under (or
   * undefined), so the caller can refuse the operation.
   */
  const record = (
    operation: string,
    argument: string | undefined,
    mutable: boolean
  ): string | undefined => {
    if (argument === undefined) {
      return undefined;
    }
    // A relative path is resolved against the process cwd — the same way the
    // served code's own path resolution would treat it.
    const absolute = path.resolve(argument);
    if (mutable) {
      writtenPaths.push(absolute);
    } else {
      readPaths.push(absolute);
    }
    if (DIRECTORY_CREATORS.has(operation)) {
      createdDirs.push(absolute);
      if (!allowed.some((root) => isWithinPath(root, absolute))) {
        createdOutsideAllowed.push(operation + ' ' + absolute);
      }
    }
    const hit = forbidden.find((root) => isWithinPath(root, absolute));
    if (hit !== undefined) {
      forbiddenAccesses.push(
        operation + ' ' + absolute + ' (under forbidden root ' + hit + ')'
      );
    }
    return hit;
  };

  /** An EACCES-shaped refusal error: the served code's own error path still runs. */
  const refusal = (operation: string, target: string): NodeJS.ErrnoException => {
    blockedCalls.push(operation + ' ' + target);
    const error = new Error(
      operation + ": EACCES: test isolation guard refused the real data root '" + target + "'"
    ) as NodeJS.ErrnoException;
    error.code = 'EACCES';
    error.errno = -13;
    error.syscall = operation;
    error.path = target;
    return error;
  };

  /**
   * Classify one call, record its path arguments, and return the refusal error
   * when a forbidden write must be stopped. The CALLER decides how to surface
   * it: an async fs wrapper returns a rejected promise (a synchronous throw
   * would escape `await expect(...).rejects`, since the throw happens while the
   * argument expression is evaluated, not inside the promise chain), a sync
   * wrapper throws.
   */
  const observe = (
    operation: string,
    args: readonly unknown[]
  ): NodeJS.ErrnoException | undefined => {
    const first = pathArgument(args[0]);
    if (TWO_PATH_OPERATIONS.has(operation)) {
      // Source is read, destination is written/created.
      record(operation, first, false);
      const hit = record(operation, pathArgument(args[1]), true);
      if (blockForbidden && hit !== undefined) {
        return refusal(operation, path.resolve(pathArgument(args[1]) ?? ''));
      }
      return undefined;
    }
    if (operation === 'open' || operation === 'openSync') {
      // Read vs write is decided by the flags, never by the call site.
      const flags = typeof args[1] === 'string' ? args[1] : 'r';
      const mutable = WRITE_FLAG.test(flags);
      const hit = record(operation, first, mutable);
      if (blockForbidden && mutable && hit !== undefined) {
        return refusal(operation, path.resolve(first ?? ''));
      }
      return undefined;
    }
    const mutable =
      operation.startsWith('mkdir') ||
      operation.startsWith('mkdtemp') ||
      [
        'writeFile',
        'appendFile',
        'rm',
        'rmdir',
        'unlink',
        'truncate',
        'chmod',
        'cp',
        'writeFileSync',
        'appendFileSync',
        'rmSync',
        'rmdirSync',
        'unlinkSync',
        'truncateSync',
        'chmodSync'
      ].includes(operation);
    const hit = record(operation, first, mutable);
    if (blockForbidden && mutable && hit !== undefined) {
      return refusal(operation, path.resolve(first ?? ''));
    }
    return undefined;
  };

  /**
   * Wrap one function property, recording any failure instead of swallowing.
   * `async: true` makes the refusal a REJECTED PROMISE (the fs promises API
   * contract); `async: false` (the sync module surface) throws.
   */
  const wrap = <T extends object>(target: T, key: string, label: string, isAsync: boolean): void => {
    const holder = target as Record<string, unknown>;
    const original = holder[key];
    if (typeof original !== 'function') {
      hookFailures.push(label + ' (not a function)');
      return;
    }
    const bound = original as (...args: unknown[]) => unknown;
    try {
      if (isAsync) {
        holder[key] = function wrappedAsync(this: unknown, ...args: unknown[]): unknown {
          const blocked = observe(key, args);
          if (blocked !== undefined) {
            // No timer/flag dependence: the returned promise settles as a
            // rejection on the microtask queue, exactly like a real EACCES.
            return Promise.reject(blocked);
          }
          return bound.apply(this, args);
        };
      } else {
        holder[key] = function wrappedSync(this: unknown, ...args: unknown[]): unknown {
          const blocked = observe(key, args);
          if (blocked !== undefined) {
            throw blocked;
          }
          return bound.apply(this, args);
        };
      }
    } catch (error) {
      hookFailures.push(label + ' (' + (error instanceof Error ? error.message : String(error)) + ')');
      return;
    }
    if (holder[key] === original) {
      hookFailures.push(label + ' (assignment did not take effect)');
      return;
    }
    hooked.push(label);
    restores.push(() => {
      holder[key] = original;
    });
  };

  // The shared promises object: `import { promises } from 'node:fs'` and the
  // default import of 'node:fs/promises' both resolve to THIS object.
  const promises = (fsDefault as unknown as { promises: Record<string, unknown> }).promises;
  for (const operation of ASYNC_OPERATIONS) {
    wrap(promises, operation, 'promises.' + operation, true);
  }
  for (const operation of SYNC_OPERATIONS) {
    wrap(fsDefault as unknown as Record<string, unknown>, operation, 'fs.' + operation, false);
  }

  let restored = false;
  return {
    get createdDirs() {
      return [...createdDirs];
    },
    get createdOutsideAllowed() {
      return [...createdOutsideAllowed];
    },
    get forbiddenAccesses() {
      return [...forbiddenAccesses];
    },
    get blockedCalls() {
      return [...blockedCalls];
    },
    get writtenPaths() {
      return [...writtenPaths];
    },
    get readPaths() {
      return [...readPaths];
    },
    get violations() {
      return [...createdOutsideAllowed, ...forbiddenAccesses];
    },
    get hooked() {
      return [...hooked];
    },
    get hookFailures() {
      return [...hookFailures];
    },
    hooksComplete() {
      return hookFailures.length === 0 && hooked.length === ASYNC_OPERATIONS.length + SYNC_OPERATIONS.length;
    },
    restore() {
      if (restored) {
        return;
      }
      restored = true;
      for (const undo of restores.splice(0, restores.length)) {
        undo();
      }
    }
  };
}
