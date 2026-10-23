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

// ---------------------------------------------------------------------------
// Tokenizer Budget and Measurement (M2 governance repair)
// ---------------------------------------------------------------------------

/**
 * Injected model tokenizer function.
 * Given a text string, returns the exact token count according to the model's tokenizer.
 */
export type ModelTokenizer = (text: string) => number;

/** Default hard token budget for injected advisory text. */
export const DEFAULT_ADVISORY_TOKEN_BUDGET = 300;

/**
 * Conservative fallback limits when no injected model tokenizer is available.
 *
 * GOVERNANCE NOTE (M2):
 * A heuristic character or byte estimate CANNOT be claimed equivalent to real
 * model tokens (<= 300 tokens), because BPE vocabulary tokenization for
 * high-entropy identifiers, CJK, emoji, and JSON varies widely across models.
 * When a model tokenizer is not injected, the advisor relies on conservative
 * upper-bound character and byte limits to prevent prompt bloat without claiming
 * exact token equivalence.
 */
export const CONSERVATIVE_FALLBACK_CHAR_LIMIT = 400;
export const CONSERVATIVE_FALLBACK_BYTE_LIMIT = 1000;

export interface TokenBudgetOptions {
  /** Injected exact tokenizer for the target model. */
  readonly tokenizer?: ModelTokenizer;
  /**
   * Maximum allowed token count when a tokenizer is provided.
   * Default: DEFAULT_ADVISORY_TOKEN_BUDGET (300).
   */
  readonly maxTokens?: number;
  /**
   * Conservative character limit in fallback mode when no tokenizer is injected.
   * Default: CONSERVATIVE_FALLBACK_CHAR_LIMIT (400).
   */
  readonly maxChars?: number;
  /**
   * Conservative byte limit in fallback mode when no tokenizer is injected.
   * Default: CONSERVATIVE_FALLBACK_BYTE_LIMIT (1000).
   */
  readonly maxBytes?: number;
}

export interface TokenBudgetResult {
  /** Whether the text fits within the budget. */
  readonly fits: boolean;
  /**
   * Token count.
   * When an exact tokenizer is injected, this is the exact count.
   * When falling back, this is a conservative heuristic upper bound.
   */
  readonly tokenCount: number;
  /** Character length (UTF-16 code units). */
  readonly charLength: number;
  /** Byte length in UTF-8. */
  readonly byteLength: number;
  /** True if an exact injected model tokenizer was used. */
  readonly exact: boolean;
  /**
   * True if the text was truncated to fit the budget.
   * Under M2 policy, text is NEVER silently truncated; truncation is explicitly flagged.
   */
  readonly truncated: boolean;
  /** Explanatory note disclaiming equivalence when in fallback mode. */
  readonly note: string;
}

function utf8ByteLength(text: string): number {
  if (typeof Buffer !== 'undefined') {
    return Buffer.byteLength(text, 'utf-8');
  }
  return new TextEncoder().encode(text).length;
}

/**
 * Conservative upper-bound heuristic for estimating token count without a tokenizer.
 *
 * Uses UTF-8 byte weight and character categories to err high rather than low:
 * - High-entropy ASCII, hex/base64 strings, and JSON syntax symbols can take up
 *   to 1 token per 1.5 - 2 characters in BPE tokenizers.
 * - CJK ideographs typically take 1 - 2 tokens per character.
 * - Emojis (especially multi-codepoint sequences with ZWJ) take 2 - 4 tokens.
 * - Standard English prose averages ~3.5 - 4 characters per token.
 *
 * NOTE: This is an upper-bound estimate and is explicitly NOT claimed to equal
 * real tokenizer output.
 */
export function estimateConservativeTokens(text: string): number {
  if (typeof text !== 'string' || text.length === 0) {
    return 0;
  }

  // Regex patterns for Unicode classification
  const emojiRegex = /\p{Extended_Pictographic}/u;
  const cjkRegex = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/u;

  let cjkCount = 0;
  let emojiCount = 0;
  let otherNonAscii = 0;
  let asciiSymbols = 0;
  const asciiAlnumRuns: string[] = [];

  const codePoints = Array.from(text);
  let currentAlnum = '';

  for (const char of codePoints) {
    if (emojiRegex.test(char)) {
      if (currentAlnum.length > 0) {
        asciiAlnumRuns.push(currentAlnum);
        currentAlnum = '';
      }
      emojiCount += 1;
    } else if (cjkRegex.test(char)) {
      if (currentAlnum.length > 0) {
        asciiAlnumRuns.push(currentAlnum);
        currentAlnum = '';
      }
      cjkCount += 1;
    } else {
      const code = char.codePointAt(0) ?? 0;
      if (code > 0x7f) {
        if (currentAlnum.length > 0) {
          asciiAlnumRuns.push(currentAlnum);
          currentAlnum = '';
        }
        otherNonAscii += 1;
      } else if (
        (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122)
      ) {
        currentAlnum += char;
      } else if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
        if (currentAlnum.length > 0) {
          asciiAlnumRuns.push(currentAlnum);
          currentAlnum = '';
        }
      } else {
        if (currentAlnum.length > 0) {
          asciiAlnumRuns.push(currentAlnum);
          currentAlnum = '';
        }
        asciiSymbols += 1;
      }
    }
  }
  if (currentAlnum.length > 0) {
    asciiAlnumRuns.push(currentAlnum);
  }

  // High-entropy identifiers, hex blobs, base64 strings, or long unbroken runs (>= 16 chars):
  // 1.5 - 2 chars/token (Math.ceil(run.length / 2))
  // Standard English words (< 16 chars without hex shape):
  // ~4 chars/token (Math.ceil(run.length / 4))
  let alnumTokens = 0;
  for (const run of asciiAlnumRuns) {
    const isHex = run.length >= 8 && /^[0-9a-fA-F]+$/.test(run);
    const isLongUnbroken = run.length >= 16;
    if (isHex || isLongUnbroken) {
      alnumTokens += Math.ceil(run.length / 2);
    } else {
      alnumTokens += Math.ceil(run.length / 4);
    }
  }

  const symbolTokens = Math.ceil(asciiSymbols / 1.5);
  const cjkTokens = cjkCount * 2;
  const emojiTokens = emojiCount * 3;
  const otherNonAsciiTokens = Math.ceil(otherNonAscii * 1.5);

  return Math.max(1, alnumTokens + symbolTokens + cjkTokens + emojiTokens + otherNonAsciiTokens);
}

/**
 * Count tokens using an injected model tokenizer if available,
 * or fall back to estimateConservativeTokens.
 */
export function countTokens(text: string, tokenizer?: ModelTokenizer): number {
  if (typeof tokenizer === 'function') {
    return tokenizer(text);
  }
  return estimateConservativeTokens(text);
}

/**
 * Check whether a text payload fits within the configured token and fallback limits.
 *
 * Under M2 governance, text is NEVER silently truncated: returns fits: boolean along with
 * diagnostic metadata and an explicit note disclaiming equivalence in fallback mode.
 */
export function checkTokenBudget(text: string, options?: TokenBudgetOptions): TokenBudgetResult {
  const maxTokens = options?.maxTokens ?? DEFAULT_ADVISORY_TOKEN_BUDGET;
  const maxChars = options?.maxChars ?? CONSERVATIVE_FALLBACK_CHAR_LIMIT;
  const maxBytes = options?.maxBytes ?? CONSERVATIVE_FALLBACK_BYTE_LIMIT;

  const charLength = text.length;
  const byteLength = utf8ByteLength(text);

  if (typeof options?.tokenizer === 'function') {
    const tokenCount = options.tokenizer(text);
    const fits = tokenCount <= maxTokens;
    return {
      fits,
      tokenCount,
      charLength,
      byteLength,
      exact: true,
      truncated: false,
      note: fits
        ? 'Fits within injected model tokenizer budget (' + tokenCount + '/' + maxTokens + ' tokens).'
        : 'Exceeds injected model tokenizer budget (' + tokenCount + '/' + maxTokens + ' tokens).'
    };
  }

  const tokenCount = estimateConservativeTokens(text);
  const fits = tokenCount <= maxTokens && charLength <= maxChars && byteLength <= maxBytes;
  return {
    fits,
    tokenCount,
    charLength,
    byteLength,
    exact: false,
    truncated: false,
    note: fits
      ? 'Fits within conservative heuristic budget (chars: ' + charLength + '/' + maxChars + ', bytes: ' + byteLength + '/' + maxBytes + ', estTokens: ' + tokenCount + '/' + maxTokens + '). Note: Heuristic estimation does NOT claim equivalence to real model <= 300 tokens.'
      : 'Exceeds conservative heuristic budget (chars: ' + charLength + '/' + maxChars + ', bytes: ' + byteLength + '/' + maxBytes + ', estTokens: ' + tokenCount + '/' + maxTokens + '). Heuristic estimation does NOT claim equivalence to real model <= 300 tokens.'
  };
}
