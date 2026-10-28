/**
 * Hand-written types for `compare-platform-digests.mjs` (PR-1).
 * See `git-objects.d.mts` for why declarations are hand-written.
 */

export interface PlatformRow {
  platform: string;
  compositeSha256: string;
  bindingSha256: string;
  fileCount: number;
  commitId?: string;
}

export interface ParityResult {
  ok: boolean;
  reason?: string;
  rows: PlatformRow[];
  uniqueComposites: number;
  uniqueBindings: number;
}

/**
 * The cross-OS claim is a three-OS claim: the CLI passes minPlatforms 3 (t17),
 * and every record must be attributable (64-hex digests, 40-hex commit,
 * positive fileCount) before any comparison is meaningful.
 */
export declare function comparePlatformDigests(
  dir: string,
  options?: { minPlatforms?: number }
): ParityResult;
