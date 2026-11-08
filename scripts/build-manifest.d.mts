/**
 * Hand-written types for `build-manifest.mjs` (rev5 P0-5; dependency digest
 * added by schema 1.1.0, rev6 cross-audit BUILD-1). See `git-objects.d.mts`.
 */

export interface SrcFileDigest {
  path: string;
  bytes: number;
  sha256: string;
}

export interface SrcTreeSummary {
  srcTreeSha256: string;
  fileCount: number;
  files: SrcFileDigest[];
}

/** Schema 1.1.0: `package.json` + `pnpm-lock.yaml`, the bytes the bundle inlines. */
export interface DependencySummary {
  dependencySha256: string;
  fileCount: number;
  files: SrcFileDigest[];
}

export interface BuildStampArtifact {
  path: string;
  bytes: number;
  sha256: string;
}

export interface BuildStamp {
  schemaVersion: string;
  kind: 'build-stamp';
  srcTreeSha256: string;
  srcFileCount: number;
  srcFiles: SrcFileDigest[];
  /** Schema 1.1.0: a dependency bump without a rebuild must not look fresh. */
  dependencySha256: string;
  dependencyFileCount: number;
  dependencyFiles: SrcFileDigest[];
  artifact: BuildStampArtifact | null;
  /** rev8 dual-artifact: the MCP stdio entry (absent when not built). */
  artifactMcp: BuildStampArtifact | null;
  commit: string | null;
  commitError: string | null;
  commitSource: string;
  algorithm: {
    fileSet: string;
    dependencyFileSet: string;
    pathFormat: string;
    sorting: string;
    lineFormat: string;
    compositeHash: string;
    normalization: string;
  };
  builtAt: string;
  node: string;
  platform: string;
  arch: string;
}

export interface BuildStatus {
  ok: boolean;
  stale: boolean;
  reasons: string[];
  artifact: 'present' | 'absent';
  artifactPath: string;
  artifactBytes: number | null;
  artifactSha256: string | null;
  /** rev8 dual-artifact: the MCP entry's presence (descriptive, never gating by itself). */
  artifactMcp: 'present' | 'absent';
  artifactMcpPath: string;
  artifactMcpBytes: number | null;
  artifactMcpSha256: string | null;
  stampPath: string;
  stampPresent: boolean;
  srcTreeSha256: {
    current: string;
    recorded: string | null;
    currentFileCount: number;
  };
  dependencySha256: {
    current: string;
    recorded: string | null;
    currentFileCount: number;
  };
  commit: {
    recorded: string | null;
    head: string | null;
    matches: boolean | null;
  };
  detail: string;
}

export declare const BUILD_STAMP_SCHEMA_VERSION: string;
export declare const BUILD_STAMP_PATH: string;
export declare const BUILD_ARTIFACT_PATH: string;
/** rev8 dual-artifact: the MCP stdio entry artifact path. */
export declare const BUILD_MCP_ARTIFACT_PATH: string;

export declare function computeSrcTreeSha256(options?: { cwd?: string }): SrcTreeSummary;

export declare function computeDependencySha256(options?: { cwd?: string }): DependencySummary;

export declare function buildStamp(options?: {
  cwd?: string;
  artifactPath?: string;
  mcpArtifactPath?: string;
}): BuildStamp;

export declare function writeBuildStamp(options?: {
  cwd?: string;
  artifactPath?: string;
  mcpArtifactPath?: string;
  stampPath?: string;
}): BuildStamp;

export declare function computeBuildStatus(options?: {
  cwd?: string;
  artifactPath?: string;
  mcpArtifactPath?: string;
  stampPath?: string;
  /**
   * rev8: add the named mcp-artifact-* staleness reasons (default false).
   * `smokeBuild` passes `requireMcpArtifact: existsSync(mcpArtifact)` so the
   * second artifact is stamp-verified whenever it exists on disk.
   */
  requireMcpArtifact?: boolean;
}): BuildStatus;

export declare function formatBuildStatus(status: BuildStatus): string[];
