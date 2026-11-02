/**
 * Hand-written types for `kill-tree.mjs` (rev6 cross-audit CI-4).
 *
 * The module is plain ESM because `run.mjs` and the in-host runtime are plain
 * ESM, so the p62 tests need this declaration file to typecheck. Same
 * convention as `apply-context.d.mts` / `check-clean-tree.d.mts`.
 */

/**
 * Kill the process tree rooted at `pid`.
 *
 * win32: `taskkill /T /F /PID <pid>` (walks the OS parent-child tree);
 * POSIX: the negative pid signals the process GROUP the detached child leads,
 * with a direct-pid fallback when the group is already gone.
 *
 * A pid that cannot name a process, and any kill failure, is a no-op.
 */
export function killProcessTree(pid: number | undefined, options?: { signal?: 'SIGTERM' | 'SIGKILL' }): void;
