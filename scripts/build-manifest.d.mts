/**
 * Hand-written types for `build-manifest.mjs` (rev5 P0-5). See `git-objects.d.mts`.
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
  artifact: BuildStampArtifact | null;
  commit: string | null;
  commitError: string | null;
  commitSource: string;
  algorithm: {
    fileSet: string;
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
  stampPath: string;
  stampPresent: boolean;
  srcTreeSha256: {
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

export declare function computeSrcTreeSha256(options?: { cwd?: string }): SrcTreeSummary;

export declare function buildStamp(options?: { cwd?: string; artifactPath?: string }): BuildStamp;

export declare function writeBuildStamp(options?: {
  cwd?: string;
  artifactPath?: string;
  stampPath?: string;
}): BuildStamp;

export declare function computeBuildStatus(options?: {
  cwd?: string;
  artifactPath?: string;
  stampPath?: string;
}): BuildStatus;

export declare function formatBuildStatus(status: BuildStatus): string[];
