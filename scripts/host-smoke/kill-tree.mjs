/**
 * Process-tree reaping for the host-smoke runner (rev6 cross-audit CI-4).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * On the run deadline the runner used to call `child.kill()` only, which
 * signals (or TerminateProcess-es) the single in-host pid. The in-host smoke
 * spawns the MCP backend as its own child, so a timeout landing inside the
 * backend's work window orphaned the grandchild: on Windows TerminateProcess
 * never touches children, and on POSIX only the direct child was signalled.
 * The runner's surviving-pid boundary check watches pids after the fact, but
 * an orphan created BY the kill itself is invisible to it. The kill must
 * therefore cover the whole tree.
 *
 * Platform rules:
 *   - win32: `taskkill /T /F /PID <pid>` - /T walks the OS parent-child tree,
 *     /F forces (TerminateProcess), matching what `child.kill()` did to the
 *     direct child;
 *   - POSIX: the in-host child is spawned `detached`, i.e. as a process-group
 *     leader, so `process.kill(-pid, signal)` reaches every group member,
 *     including the MCP backend grandchild. If the group is already gone
 *     (ESRCH) the direct pid is signalled as a fallback.
 *
 * Failures are swallowed on purpose: a reaper racing an exiting process loses
 * to ESRCH routinely, and a kill failure must not mask the deadline outcome
 * the caller is about to report (the caller still follows up with
 * `child.kill()` on the direct pid).
 */
import { execFileSync } from 'node:child_process';

/**
 * Kill the process tree rooted at `pid`.
 *
 * @param {number | undefined} pid
 * @param {{signal?: 'SIGTERM' | 'SIGKILL'}} [options]
 * @returns {void}
 */
export function killProcessTree(pid, options = {}) {
  if (typeof pid !== 'number' || pid <= 0) {
    return;
  }
  const signal = options.signal ?? 'SIGTERM';
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
    } catch {
      // The tree is already gone (or taskkill refused a dead pid): nothing to reap.
    }
    return;
  }
  try {
    // Negative pid targets the process GROUP the detached child leads.
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}
