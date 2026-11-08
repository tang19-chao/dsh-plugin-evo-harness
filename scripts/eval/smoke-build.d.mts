/**
 * Hand-written types for `smoke-build.mjs` (PR-1, freshness extended by rev5
 * P0-5; rev8 dual-artifact MCP steps). See `git-objects.d.mts`.
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
  /** rev8 dual-artifact: byte size of lib/mcp/server.js (0 when absent). */
  mcpBytes: number;
  /** rev5 P0-5: true when the artifact is not provably built from the current src tree. */
  stale: boolean;
  /** Full freshness evidence (`null` when the build/artifact step failed first). */
  freshness: BuildStatus | null;
}

export declare const REQUIRED_EXPORTS: readonly string[];

/** rev8: the named MCP-entry export surface the additive steps assert. */
export declare const REQUIRED_MCP_EXPORTS: readonly string[];

export interface McpImportProbeResult {
  ok: boolean;
  detail: string;
  /** The probe's parsed JSON report (null when stdout was not one JSON object). */
  parsed: {
    ok: boolean;
    exportNames: string[];
    stdinHasDataListeners: boolean;
    stdinFlowingChanged: boolean;
    filesCreated: string[];
    error?: string;
  } | null;
  stdout: string;
  stderr: string;
  status: number | null;
}

/**
 * rev8: run the child-process import-purity probe against an MCP artifact.
 */
export declare function probeMcpImport(artifactPath: string): McpImportProbeResult;

/**
 * rev8: the additive MCP-entry smoke steps. `paths.artifactPath` overrides
 * the artifact under test (tests point it at fixture bundles; production uses
 * the repo's lib/mcp/server.js).
 */
export declare function runMcpSmokeSteps(
  accumulator: { steps: SmokeStep[] },
  paths?: { artifactPath?: string }
): { steps: SmokeStep[]; ok: boolean };

export declare function smokeBuild(options?: { skipBuild?: boolean; cwd?: string }): Promise<SmokeBuildResult>;
