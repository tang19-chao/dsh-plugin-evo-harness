/**
 * Hand-written types for `git-objects.mjs` (PR-1).
 *
 * WHY A DECLARATION FILE AND NOT `allowJs`
 * ---------------------------------------
 * The evidence core is plain `.mjs` on purpose: it must be runnable by `node`
 * directly (CI, a reviewer's shell) with no build step, because the whole point
 * of PR-1 is that evidence can be recomputed by anyone with git installed.
 *
 * But `tests/unit/p62/commit-attestation.test.ts` imports it, and the project
 * typechecks with `strict` + `noImplicitAny`, so an untyped `.mjs` import is an
 * error (TS7016). The alternative, `allowJs: true`, would make tsc infer types
 * from the whole of any imported JS (including its dynamic shapes) and change
 * how every existing script is checked - a much wider blast radius for a PR
 * about evidence.
 *
 * So the contract is declared here, by hand, and `pnpm run typecheck` proves the
 * TESTS match it. The declaration is deliberately the narrow public surface.
 */

/** A resolved commit object. Constructed only through `resolveCommit`. */
export declare class ResolvedCommit {
  readonly ref: string;
  readonly commitId: string;
  readonly treeId: string;
  constructor(ref: string, commitId: string, treeId: string);
  static _create(ref: string, commitId: string, treeId: string): ResolvedCommit;
}

/** Thrown when the object database cannot supply authoritative evidence. */
export declare class GitEvidenceError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  blobId: string;
}

export type EncodingKind = 'text-lf' | 'text-crlf' | 'text-bom' | 'binary';

export interface ByteClassification {
  bom: string | null;
  crlf: number;
  loneCr: number;
  nul: number;
  kind: EncodingKind;
}

export interface BlobRecord {
  path: string;
  mode: string;
  blobId: string;
  sha256: string;
  bytes: number;
  encoding: EncodingKind;
  encodingException: boolean;
  declaredTextUnset: boolean;
  declaredEol: string;
}

export interface CanonicalManifest {
  commitId: string;
  treeId: string;
  roots: string[];
  fileCount: number;
  files: BlobRecord[];
  compositeSha256: string;
  bindingSha256: string;
  algorithm: Record<string, string>;
  encoding: {
    policy: string;
    exceptions: { path: string; encoding: EncodingKind; bytes: number }[];
    exceptionCount: number;
  };
}

export interface ManifestComparison {
  ok: boolean;
  differences: string[];
}

export declare function commitTreeId(commitId: string, cwd: string): string;
export declare function resolveCommit(ref: string, cwd: string): ResolvedCommit;
export declare function assertAncestor(base: ResolvedCommit, target: ResolvedCommit, cwd: string): void;
export declare function listTreeBlobs(commit: ResolvedCommit, cwd: string, roots?: readonly string[]): TreeEntry[];
export declare function readBlobBytes(blobId: string, cwd: string): Buffer;
export declare function readBlobsBatch(blobIds: readonly string[], cwd: string): Map<string, Buffer>;
export declare function readCommitBlobAtPath(
  commit: { commitId: string },
  filePath: string,
  cwd: string
): { blobId: string; bytes: Buffer } | null;
/**
 * Attribute answers are COMMIT-BOUND: `source` must be the resolved 40-hex
 * commit id (or a ResolvedCommit). Answers come from
 * `git check-attr --source=<commit>` or, on git < 2.40, from parsing the
 * commit tree's `.gitattributes` — never from the working tree.
 */
export declare function readAttributes(
  paths: readonly string[],
  cwd: string,
  source: string | { commitId: string },
  options?: { forceTreeFallback?: boolean }
): Map<string, { text: string; eol: string }>;
export declare function classifyBytes(bytes: Buffer): ByteClassification;
export declare function sha256Bytes(bytes: Buffer): string;
export declare function buildCanonicalManifest(
  commit: ResolvedCommit,
  cwd: string,
  roots?: readonly string[],
  options?: { allowUndeclaredEncoding?: boolean }
): CanonicalManifest;
export declare function compareManifests(
  recorded: unknown,
  current: CanonicalManifest | Record<string, unknown>,
  options?: { compareAttributeLabels?: boolean }
): ManifestComparison;
export declare function trackedWorktreeChanges(cwd: string): string[];
export declare function untrackedPaths(cwd: string): string[];
export declare function gitVersion(cwd: string): string;
