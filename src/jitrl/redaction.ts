/**
 * Shared JitRL secret redaction (repair B2).
 *
 * A single implementation is consumed by state abstraction (applied to the
 * task prompt BEFORE tokenization, and to every free-text string that
 * reaches a token or the summary) and by the step evaluator (judge prompt
 * rendering), so the two call sites cannot drift apart.
 *
 * Properties:
 * - Deterministic: pure string -> string, no randomness, no clock.
 * - Idempotent: applied repeatedly to a fixed point, so already-redacted
 *   text passes through unchanged.
 * - Bucket-stable: the replacement is one fixed placeholder that contains
 *   no trigger text, so two tasks differing only in the secret VALUE
 *   produce identical redacted text and therefore identical tokens,
 *   signatures, buckets and summaries.
 * - Fail closed: over-redaction (for example a keyword followed by an
 *   ordinary word) is accepted; under-redaction is not.
 */

/** Stable replacement used for every secret-shaped match. */
export const SECRET_PLACEHOLDER = '<secret>';

/** One named secret pattern; the combined matcher is built from this set. */
export interface SecretPattern {
  readonly name: string;
  readonly pattern: RegExp;
}

/**
 * Exported pattern set in priority order (the combined regex tries the
 * alternatives left to right, so shape-specific patterns run before the
 * generic high-entropy blob patterns). Patterns are regex literals so the
 * escaping lives in exactly one place.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  // Multiline PEM private-key blocks, body included.
  { name: 'pem_private_key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/i },
  // GitHub-style tokens (ghp_/gho_/ghu_/ghs_/ghr_ + long body).
  { name: 'github_token', pattern: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_-]{20,}/i },
  // AWS access key ids.
  { name: 'aws_access_key', pattern: /(?:AKIA|ASIA)[0-9A-Z]{16}/i },
  // Generic model-provider keys; the body may contain - and _ (sk-proj-..., sk-abc_123).
  { name: 'model_api_key', pattern: /sk-[A-Za-z0-9_-]{8,}/i },
  // Bearer credentials, including dotted JWT shapes.
  { name: 'bearer_token', pattern: /\bBearer\s+(?:"[^"]*"|(?=[^\s"';,]{12,}|[^\s"';,]*\d|[^\s"';,]*[^\s0-9A-Za-z"';,])[^\s"';,]+)/i },
  // Keyword secrets where the separator is "=", ":" or " is ": any value
  // run is accepted there (an explicit assignment is a deliberate
  // disclosure). For the bare-whitespace separator ("password hunter2") the
  // value must look value-shaped - quoted, at least 12 chars, or containing
  // a digit or symbol - so ordinary nouns ("token refresh bug") are no
  // longer swallowed. Quoted values are always consumed whole.
  { name: 'keyword_secret', pattern: /(?:api[_-]?key|apikey|access[_-]?key|token|secret|password|passwd|pwd|authorization|credentials?|private[_-]?key)\s*(?:[=:]\s*(?:"[^"]*"|[^\s"';,]+)|\bis\b\s+(?:"[^"]*"|[^\s"';,]+)|\s+(?:"[^"]*"|(?=[^\s"';,]{12,}|[^\s"';,]*\d|[^\s"';,]*[^\s0-9A-Za-z"';,])[^\s"';,]+))/i },
  // Long high-entropy blobs: hex digests and base64url-ish bodies. Two
  // anti-over-redaction guards (P3-FIX3/B3): a run that starts right after
  // a scheme/path/userinfo/hyphen separator (: / \ @ . -) is a structured
  // key or a path segment, not a secret, and base64 candidates must
  // additionally contain a digit (the eight-surface action-key runs are
  // letters-only). Real secrets are space/quote-preceded mixed values.
  { name: 'hex_blob', pattern: /\b(?<![-:/\\@.])[0-9a-f]{32,}\b/i },
  { name: 'base64_blob', pattern: /\b(?<![-:/\\@.])(?=[A-Za-z0-9+/_-]{43,})(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9][A-Za-z0-9+/_-]{42,}\b/i }
];

const COMBINED_PATTERN = new RegExp(
  SECRET_PATTERNS.map((pattern) => '(?:' + pattern.pattern.source + ')').join('|'),
  'gi'
);

/** Options for redactSecrets. */
export interface RedactSecretsOptions {
  /** Override the replacement placeholder; must itself be trigger-free. */
  readonly placeholder?: string;
}

const MAX_REDACTION_PASSES = 4;

/**
 * Replace every secret-shaped region of the text with a stable placeholder.
 * Runs to a fixed point (bounded passes) so the result is idempotent even
 * when the input already contains placeholder-like text.
 */
export function redactSecrets(text: string, options?: RedactSecretsOptions): string {
  if (typeof text !== 'string' || text.length === 0) {
    return text;
  }
  const placeholder = options?.placeholder ?? SECRET_PLACEHOLDER;
  let current = text;
  for (let pass = 0; pass < MAX_REDACTION_PASSES; pass += 1) {
    const next = current.replace(COMBINED_PATTERN, placeholder);
    if (next === current) {
      return next;
    }
    current = next;
  }
  return current;
}

const ABSOLUTE_PATH_PATTERN = /([A-Za-z]:[\\/][^\s"'`]+|\/(?:usr|home|Users|root|var|tmp|mnt|opt|etc)\/[^\s"'`]+)/g;

/**
 * Replace absolute Windows/POSIX paths with a neutral marker. Paths are
 * stripped unconditionally at both consumers (they are instance details,
 * not governed by privacy.redactSecrets).
 */
export function redactAbsolutePaths(text: string): string {
  return text.replace(ABSOLUTE_PATH_PATTERN, '<path>');
}