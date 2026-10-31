/**
 * Hand-written types for `check-clean-tree.mjs` (rev5 P0-4). See `git-objects.d.mts`.
 */

export interface CleanTreeFailure {
  code: string;
  detail: string;
}

export interface CleanTreeResult {
  ok: boolean;
  failures: CleanTreeFailure[];
  trackedChanges: { status: string; path: string }[];
  untracked: string[];
  allowed: string[];
  unexpected: string[];
  requiredInputs: { path: string; tracked: boolean }[];
  allow: string[];
}

export interface AllowanceRule {
  kind: 'exact' | 'directory' | 'glob';
  value: string;
}

export declare const DEFAULT_ALLOW: readonly string[];

export declare function isProtectedPath(entryPath: string): boolean;
export declare function validateAllowance(rule: string): AllowanceRule;
export declare function readStatusEntries(cwd: string): { status: string; path: string }[];
export declare function checkCleanTree(options?: {
  cwd?: string;
  allow?: readonly string[];
  requireTracked?: readonly string[];
}): CleanTreeResult;
