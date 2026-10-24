/**
 * Repair B2: shared secret redaction. Verifies every exported pattern
 * class (GitHub tokens, AWS keys, hyphenated/underscored sk- keys, Bearer
 * credentials, PEM blocks, keyword secrets with optional separators, long
 * hex/base64 blobs), the stable placeholder that keeps bucketing identical
 * when only the secret value changes, and idempotency.
 */
import { describe, expect, it } from 'vitest';
import {
  SECRET_PATTERNS,
  SECRET_PLACEHOLDER,
  redactAbsolutePaths,
  redactSecrets, checkTokenBudget, countTokens, estimateConservativeTokens, DEFAULT_ADVISORY_TOKEN_BUDGET, CONSERVATIVE_FALLBACK_CHAR_LIMIT, CONSERVATIVE_FALLBACK_BYTE_LIMIT
} from '../../../src/jitrl/redaction';
import {
  maskNamespace,
  maskServerId,
  sanitizeDiagnostic,
  MAX_DIAGNOSTIC_LENGTH
} from '../../../src/jitrl/stores/bridge.store';

describe('secret pattern set', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['github_token', 'ghp_0123456789abcdefghijklmnopqrstuv'],
    ['github_token', 'gho_0123456789abcdefghijklmnopqrstuv'],
    ['github_token', 'ghu_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'],
    ['github_token', 'ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'],
    ['github_token', 'ghr_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'],
    ['aws_access_key', 'AKIAIOSFODNN7EXAMPLE'],
    ['model_api_key', 'sk-proj-abc123XYZ_def-456'],
    ['model_api_key', 'sk-abc_123defgh'],
    ['model_api_key', 'sk-live-ABCDEF1234567890'],
    ['bearer_token', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6y'],
    ['keyword_secret', 'password hunter2'],
    ['keyword_secret', 'api_key = x'],
    ['keyword_secret', 'token: y'],
    ['keyword_secret', 'Password is y'],
    ['keyword_secret', 'password: "s3cret value"'],
    ['hex_blob', 'deadbeefdeadbeefdeadbeefdeadbeef'],
    ['base64_blob', 'Abcdefghijklmnopqrstuvwxyz0123456789+/ABCDEFGhijk']
  ];

  it.each(cases)('%s matches its specimen', (name, specimen) => {
    const entry = SECRET_PATTERNS.find((candidate) => candidate.name === name);
    expect(entry, name).toBeDefined();
    expect(entry?.pattern.test(specimen), name + ' vs ' + specimen).toBe(true);
  });

  it('matches a PEM private-key block including the body', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nlines\n-----END RSA PRIVATE KEY-----';
    const entry = SECRET_PATTERNS.find((candidate) => candidate.name === 'pem_private_key');
    expect(entry?.pattern.test(pem)).toBe(true);
  });

  it('does not match secret-free prose', () => {
    const prose = 'deploy the api service to production';
    for (const entry of SECRET_PATTERNS) {
      expect(entry.pattern.test(prose), entry.name).toBe(false);
    }
  });
});

describe('redactSecrets', () => {
  it('replaces a provider token with the stable placeholder', () => {
    expect(redactSecrets('use ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 now')).toBe('use <secret> now');
  });

  it('keeps functionally equivalent inputs identical when only the value changes', () => {
    const first = 'deploy with token ghp_AAAABBBBCCCCDDDDEEEEFFFF0000';
    const second = 'deploy with token ghp_ZZZZYYYYXXXXWWWWVVVVUUUU9999';
    expect(redactSecrets(first)).toBe(redactSecrets(second));
    // 'token <value>' is itself a keyword secret, so the whole phrase folds
    // into one stable placeholder.
    expect(redactSecrets(first)).toBe('deploy with <secret>');
  });

  it('is idempotent, including over pre-redacted text', () => {
    const adversarial = [
      'echo password hunter2',
      'sk-live-ABCDEF1234567890',
      'Bearer abc.def.ghi',
      'password <secret>',
      SECRET_PLACEHOLDER,
      'token is fine'
    ].join(' | ');
    const once = redactSecrets(adversarial);
    expect(once).not.toContain('password');
    expect(once).not.toContain('sk-live-');
    expect(redactSecrets(once)).toBe(once);
  });

  it('leaves secret-free text untouched', () => {
    const text = 'run the test suite and write a summary';
    expect(redactSecrets(text)).toBe(text);
  });

  it('honours a custom placeholder', () => {
    expect(redactSecrets('password hunter2', { placeholder: '<x>' })).toBe('<x>');
  });
});

describe('redactAbsolutePaths', () => {
  it('strips absolute windows and posix paths', () => {
    expect(redactAbsolutePaths('see /usr/local/bin/x and C:\\Temp\\a')).toBe('see <path> and <path>');
    expect(redactAbsolutePaths('plain relative/path.txt')).toBe('plain relative/path.txt');
  });
});

describe('P6.1-B1 mirror diagnostic sanitizer contract', () => {
  it('masks RAW_PAYLOAD-shaped echo tokens generically and never keeps the original', () => {
    // One arbitrary shape instance; there is no per-example branch behind it.
    expect(sanitizeDiagnostic('echo RAW_PAYLOAD_AB_CD_7341')).toBe('echo <payload>');
    expect(sanitizeDiagnostic('echo raw_payload_lower_7341 tail')).toContain('<payload>');
  });

  it('redacts secret-shaped and path-shaped text without any example-specific rule', () => {
    const diag = sanitizeDiagnostic('secret=ghp_0123456789abcdefghijklmnopqrstuv path=/etc/vault/k.pem');
    expect(diag).toContain('<secret>');
    expect(diag).toContain('<path>');
    expect(diag).not.toContain('ghp_0123456789');
  });

  it('masks explicit serverId/namespace context with short hashes; no example-string branches', () => {
    const serverId = 'my-arbitrary-server-1';
    const namespace = 'my/arbitrary-ns-1';
    const diag = sanitizeDiagnostic(`server=${serverId} namespace=${namespace}`, { serverId, namespace });
    expect(diag).not.toContain(serverId);
    expect(diag).not.toContain(namespace);
    expect(diag).toContain('server=' + maskServerId(serverId));
    expect(diag).toContain('namespace=' + maskNamespace(namespace));
    // The former review example strings get no dedicated branch anymore:
    // they are handled by the same generic context masking.
    expect(sanitizeDiagnostic('tenant/secret-space', { namespace: 'tenant/secret-space' })).toContain(
      maskNamespace('tenant/secret-space')
    );
  });

  it('bounds diagnostics to MAX_DIAGNOSTIC_LENGTH with an ellipsis', () => {
    const long = 'x'.repeat(1000);
    const diag = sanitizeDiagnostic(long);
    expect(diag.length).toBeLessThanOrEqual(200);
    expect(diag.endsWith('\u2026')).toBe(true);
  });

  it('is idempotent: already-sanitized diagnostics pass through unchanged', () => {
    const once = sanitizeDiagnostic('secret=ghp_0123456789abcdefghijklmnopqrstuv RAW_PAYLOAD_XY_1');
    expect(sanitizeDiagnostic(once)).toBe(once);
  });
});

describe('over-redaction narrowing (P3-F/G2-4)', () => {
  const collisions: readonly (readonly [string, string])[] = [
    ['token refresh bug', 'token expiry bug'],
    ['secret manager config', 'secret rotation policy'],
    ['bearer auth layer', 'bearer caching note']
  ];

  it('no longer redacts ordinary noun runs after a bare-whitespace keyword', () => {
    for (const [first, second] of collisions) {
      expect(redactSecrets(first), first).toBe(first);
      expect(redactSecrets(second), second).toBe(second);
    }
  });

  it('keeps the collision pairs distinguishable (no bucket folding)', () => {
    for (const [first, second] of collisions) {
      expect(redactSecrets(first)).not.toBe(redactSecrets(second));
    }
  });

  it('still redacts every genuine credential shape', () => {
    const genuine: readonly string[] = [
      'password hunter2',
      'api_key = x',
      'token: y',
      'Password is y',
      'password: "s3cret value"',
      'access_key=Abc123!@',
      'token 0123456789abcdef0123456789abcdef',
      'deploy with token ghp_AAAABBBBCCCCDDDDEEEEFFFF0000',
      'AKIAIOSFODNN7EXAMPLE',
      'sk-live-ABCDEF1234567890',
      'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6y',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEpA\n-----END RSA PRIVATE KEY-----'
    ];
    for (const text of genuine) {
      expect(redactSecrets(text), text).not.toBe(text);
      expect(redactSecrets(text), text).toContain('<secret>');
    }
  });

  it('still redacts a quoted short value after a bare-whitespace keyword', () => {
    expect(redactSecrets('password "x"')).toBe('<secret>');
  });

  it('keeps idempotency and bucket stability after the narrowing', () => {
    const adversarial = ['echo password hunter2', 'password <secret>', SECRET_PLACEHOLDER, 'token is fine'].join(' | ');
    const once = redactSecrets(adversarial);
    expect(redactSecrets(once)).toBe(once);
    expect(redactSecrets('deploy with token ghp_AAAABBBBCCCCDDDDEEEEFFFF0000')).toBe(
      redactSecrets('deploy with token ghp_ZZZZYYYYXXXXWWWWVVVVUUUU9999')
    );
  });
});

describe('structured keys and paths survive blobs (P3-FIX3)', () => {
  const EIGHT_SURFACE_KEY =
    'slot:exploit/surf:guardrails+memory+plugins+scripts+skills+subagents+system_prompt+tool_guidance';
  const candidateKeys = [
    EIGHT_SURFACE_KEY,
    'slot:explore_domain/surf:guardrails+memory+plugins+scripts+skills+subagents+system_prompt+tool_guidance',
    'slot:explore_invariant/surf:guardrails+memory+plugins+scripts+skills+subagents+system_prompt+tool_guidance',
    'slot:recover/surf:guardrails+memory+plugins+scripts+skills+subagents+system_prompt+tool_guidance'
  ];

  it('round-trips the full eight-surface action key unchanged', () => {
    expect(redactSecrets(EIGHT_SURFACE_KEY)).toBe(EIGHT_SURFACE_KEY);
  });

  it('keeps all four explain candidate keys intact and distinct', () => {
    const scrubbed = candidateKeys.map((key) => redactSecrets(key));
    expect(scrubbed).toEqual(candidateKeys);
    expect(new Set(scrubbed).size).toBe(4);
  });

  it('keeps absolute paths intact under redactSecrets; the scrub layer turns them into <path>', () => {
    const path = 'C:/Users/Admin/Documents/Codex/2026-10-19/https-github-com-google-research-harness2/jit-active-policy.ts';
    expect(redactSecrets(path)).toBe(path);
    expect(redactAbsolutePaths(path)).toBe('<path>');
    expect(redactAbsolutePaths('C:\\Users\\Admin\\Documents\\jit-active-policy.ts')).toBe('<path>');
    expect(
      redactSecrets('see /usr/local/lib/node_modules/very-long-package-name-here/file.js')
    ).toBe('see /usr/local/lib/node_modules/very-long-package-name-here/file.js');
  });

  it('keeps path-embedded and key-prefixed hex intact while folding bare hex', () => {
    expect(redactSecrets('C:/Users/x/2026-10-19/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(
      'C:/Users/x/2026-10-19/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    );
    expect(redactSecrets('node:deadbeefdeadbeefdeadbeefdeadbeef')).toBe('node:deadbeefdeadbeefdeadbeefdeadbeef');
    expect(redactSecrets('deadbeefdeadbeefdeadbeefdeadbeef')).toBe('<secret>');
  });

  it('still folds realistic high-entropy blobs', () => {
    expect(redactSecrets('Abcdefghijklmnopqrstuvwxyz0123456789AbCdEfGh')).toBe('<secret>');
    expect(redactSecrets('Abcdefghijklmnopqrstuvwxyz0123456789+/AbCdEfGhIjKlMnOp')).toBe('<secret>');
  });
});

describe('M2 tokenizer budget and measurement governance', () => {
  it('supports injecting a custom model tokenizer and reports exact: true', () => {
    const mockTokenizer = (text: string): number => text.split(/\s+/).filter(Boolean).length;
    const input = 'hello world from custom tokenizer';
    const result = checkTokenBudget(input, { tokenizer: mockTokenizer, maxTokens: 10 });

    expect(result.exact).toBe(true);
    expect(result.tokenCount).toBe(5);
    expect(result.fits).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.note).toContain('injected model tokenizer');
  });

  it('rejects over-budget text under injected tokenizer without silent truncation', () => {
    const mockTokenizer = (text: string): number => text.length;
    const input = 'abcdefghijklm';
    const result = checkTokenBudget(input, { tokenizer: mockTokenizer, maxTokens: 5 });

    expect(result.exact).toBe(true);
    expect(result.tokenCount).toBe(13);
    expect(result.fits).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.note).toContain('Exceeds injected model tokenizer budget');
  });

  it('falls back to conservative char/byte limits and explicitly disclaims <= 300 tokens equivalence', () => {
    const input = 'standard advice prose';
    const result = checkTokenBudget(input);

    expect(result.exact).toBe(false);
    expect(result.fits).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.note).toContain('does NOT claim equivalence to real model <= 300 tokens');
    expect(result.charLength).toBe(input.length);
    expect(result.byteLength).toBeGreaterThan(0);
  });

  describe('four input categories: high-entropy, CJK, emoji, JSON', () => {
    const categories = [
      {
        name: 'high-entropy identifiers',
        fitting: 'node:deadbeef0123456789abcdef0123456789+ghp_validTokenString12345',
        overBudget: 'x'.repeat(450) + '_deadbeef_' + 'y'.repeat(100)
      },
      {
        name: 'CJK text',
        fitting: '深度学习模型自适应优化与强化学习状态经验回放系统测试',
        overBudget: '这是一段非常长的中文测试内容用于验证超出保守上限的场景。'.repeat(20)
      },
      {
        name: 'emoji sequences',
        fitting: '🚀 🤖 💡 🎉 👨‍👩‍👧‍👦 ✨ 🔍',
        overBudget: '🚀 🤖 💡 🎉 👨‍👩‍👧‍👦 ✨ 🔍'.repeat(50)
      },
      {
        name: 'JSON payloads',
        fitting: JSON.stringify({ action: 'tool_call', target: 'bash', params: { cmd: 'ls -la' }, safe: true }),
        overBudget: JSON.stringify({ array: Array.from({ length: 60 }, (_, i) => ({ id: i, label: 'item_' + i, hash: 'h_' + i })) })
      }
    ];

    for (const cat of categories) {
      it('evaluates ' + cat.name + ' within budget: fits=true and no silent truncation', () => {
        const result = checkTokenBudget(cat.fitting);
        expect(result.fits).toBe(true);
        expect(result.truncated).toBe(false);
        expect(result.tokenCount).toBeGreaterThan(0);
        expect(result.charLength).toBe(cat.fitting.length);
      });

      it('evaluates ' + cat.name + ' over budget: fits=false without silent truncation', () => {
        const result = checkTokenBudget(cat.overBudget);
        expect(result.fits).toBe(false);
        expect(result.truncated).toBe(false);
        expect(result.note).toContain('Exceeds conservative heuristic budget');
      });
    }
  });
});
