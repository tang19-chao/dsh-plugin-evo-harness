/**
 * Hand-written types for `smoke-build.mjs` (PR-1). See `git-objects.d.mts`.
 */

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
}

export declare const REQUIRED_EXPORTS: readonly string[];

export declare function smokeBuild(options?: { skipBuild?: boolean; cwd?: string }): Promise<SmokeBuildResult>;
