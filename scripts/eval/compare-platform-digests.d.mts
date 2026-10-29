/**
 * Hand-written types for `compare-platform-digests.mjs` (PR-1).
 * See `git-objects.d.mts` for why declarations are hand-written.
 */

export interface ParityPlatform {
  /** Canonical OS name used in the claim, e.g. `ubuntu-latest`. */
  readonly os: string;
  /** The artifact directory name CI produces, e.g. `attestation-ubuntu-latest`. */
  readonly artifactDirectory: string;
}

/**
 * The CLOSED three-OS set: exactly one record per entry and no other records.
 * Exported so callers name the same set the rule uses instead of re-typing it.
 *
 * R-08: the runtime freezes the array AND every element
 * (`Object.freeze([...])` with `Object.freeze` per entry), so the declared
 * type is field-level readonly — a caller cannot mutate a platform's `os` /
 * `artifactDirectory` (or push an entry) through this declaration any more
 * than it can at runtime. The runtime shape is unchanged; only the declaration
 * was looser than the object it describes.
 */
export declare const PARITY_PLATFORMS: readonly ParityPlatform[];

export interface PlatformRow {
  platform: string;
  /** Canonical OS resolved from the directory name. */
  os: string;
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
  /** Echo of `options.expectCommit`, when one was supplied. */
  expectedCommitId?: string;
  /** Canonical OS names present, ordinal-sorted. */
  platformSet: string[];
  missingPlatforms: string[];
  duplicatePlatforms: string[];
  unknownDirectories: string[];
}

/**
 * The cross-OS claim is a three-OS claim with a CLOSED directory set using ONE
 * naming convention (`attestation-<os>` or bare `<os>`, never a mixture), so
 * `minPlatforms` can only restate 3 - any other value is rejected rather than
 * accepting a smaller sample. `expectCommit` (a full 40-hex commit id) requires
 * every record to name that revision: agreement alone cannot rule out three
 * records that agree on the same WRONG commit.
 */
export declare function comparePlatformDigests(
  dir: string,
  options?: { minPlatforms?: number; expectCommit?: string }
): ParityResult;
