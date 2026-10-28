/**
 * Hand-written types for `check-encoding-policy.mjs` (PR-1).
 *
 * The gate is plain `.mjs` so `node` can run it with no build step; these
 * declarations let the TS test suite import it under `strict` without enabling
 * `allowJs` for the whole repository (see `git-objects.d.mts` for the same
 * reasoning).
 */

export type EncodingViolationKind =
  | 'attributes-missing'
  | 'attributes-empty'
  | 'blanket-renormalise'
  | 'undeclared-non-lf-blob';

export interface EncodingViolation {
  kind: EncodingViolationKind;
  detail: string;
}

export interface EncodingPolicyResult {
  violations: EncodingViolation[];
  checked: number;
  exceptions: string[];
  attributesPresent: boolean;
  declaredRules: string[];
  /** The attested commit id (40-hex) the policy was read from. */
  commitId: string;
}

/**
 * The policy is read from the COMMIT named by `ref` (`git check-attr
 * --source=<commit>` or the commit tree on git < 2.40), never from the
 * working tree: an untracked or modified `.gitattributes` cannot change the
 * verdict, and a bare clone re-checks identically.
 */
export declare function checkEncodingPolicy(options?: { ref?: string; cwd?: string }): EncodingPolicyResult;
