/**
 * Hand-written types for `smoke-build.mjs` (PR-1, freshness extended by rev5
 * P0-5). See `git-objects.d.mts`.
 */
import type { BuildStatus } from '../build-manifest.mjs';

export interface SmokeStep {
  step: string;
  ok: boolean;
  detail: string;
}

export interface SmokeBuildResult {
  ok: boolean;
  steps: SmokeStep[];
  exportCount: number;
  bytes: number;
  /** rev5 P0-5: true when the artifact is not provably built from the current src tree. */
  stale: boolean;
  /** Full freshness evidence (`null` when the build/artifact step failed first). */
  freshness: BuildStatus | null;
}

export declare const REQUIRED_EXPORTS: readonly string[];

export declare function smokeBuild(options?: { skipBuild?: boolean; cwd?: string }): Promise<SmokeBuildResult>;
