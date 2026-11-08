import { describe, expect, it } from 'vitest';
import {
  extractAllJsonValues,
  extractJsonValue,
  normalizePathForFingerprint,
  redactIdentifiers,
  stablePatchStringify,
  stableStringify,
  stripStructuredAdvice,
  surfaceEditSummary,
  truncate
} from '../../../src/harness2/shared';
import { redactSecrets } from '../../../src/jitrl/redaction';

describe('harness2 shared / extractAllJsonValues (#24 helper)', () => {
  it('collects every top-level parseable JSON object in order', () => {
    const values = extractAllJsonValues(
      'intro {"a":1} middle {"b":2} tail {"c":3}'
    );
    expect(values).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it('collects arrays and mixed shapes as well', () => {
    const values = extractAllJsonValues('{"ranking":["A"]} then [1,2] then {"x":"y"}');
    expect(values).toEqual([{ ranking: ['A'] }, [1, 2], { x: 'y' }]);
  });

  it('parses a raw JSON body and a fenced code block', () => {
    expect(extractAllJsonValues('{"a":1}')).toEqual([{ a: 1 }]);
    const fenced = '```json\n{"ranking": ["candidate_A"]}\n```';
    expect(extractAllJsonValues(fenced)).toEqual([{ ranking: ['candidate_A'] }]);
  });

  it('never extracts JSON nested inside a string value twice', () => {
    // The runtime text is {"note":"payload {\"leak\":true} inside"} — the
    // inner object lives INSIDE a JSON string value (escaped quotes), so the
    // balanced slice starting at the outer brace spans the whole value and
    // only the outer object is a top-level value.
    const values = extractAllJsonValues('{"note":"payload {\\"leak\\":true} inside"}');
    expect(values).toEqual([{ note: 'payload {"leak":true} inside' }]);
  });

  it('does not descend into an already-parsed outer object', () => {
    // The nested object belongs to the outer value; it is not returned again.
    const values = extractAllJsonValues('{"outer":{"inner":1}}');
    expect(values).toEqual([{ outer: { inner: 1 } }]);
  });

  it('keeps scanning past unbalanced or unparseable fragments', () => {
    const values = extractAllJsonValues('{"broken": [1, 2} {"good":true} {"alsoBad": }}');
    expect(values).toEqual([{ good: true }]);
  });

  it('returns an empty list for empty input and for prose without JSON', () => {
    expect(extractAllJsonValues('')).toEqual([]);
    expect(extractAllJsonValues('   ')).toEqual([]);
    expect(extractAllJsonValues('no json here at all')).toEqual([]);
  });

  it('preserves the first-object semantics of extractJsonValue (unchanged consumer contract)', () => {
    const text = '{"a":1} prose {"b":2}';
    expect(extractJsonValue(text)).toEqual({ a: 1 });
    // The new helper is a strict superset: its first element is the same value.
    expect(extractAllJsonValues(text)[0]).toEqual(extractJsonValue(text));
  });
});

describe('harness2 shared / upstream #163 path fingerprint posix normalization (win32 regression)', () => {
  it('makes windows and posix spellings of the same artifact identical', () => {
    expect(normalizePathForFingerprint('tools\\migrate.py')).toBe('tools/migrate.py');
    expect(normalizePathForFingerprint('tools/migrate.py')).toBe('tools/migrate.py');
    expect(normalizePathForFingerprint('tools\\\\migrate.py')).toBe('tools/migrate.py');
    expect(normalizePathForFingerprint('./tools/./migrate.py')).toBe('tools/migrate.py');
  });

  it('resolves dot segments without touching the filesystem, per path kind', () => {
    expect(normalizePathForFingerprint('C:\\work\\a\\b\\..\\c.py')).toBe('C:/work/a/c.py');
    expect(normalizePathForFingerprint('/var/log/./run.txt')).toBe('/var/log/run.txt');
    expect(normalizePathForFingerprint('/../run.txt')).toBe('/run.txt');
    expect(normalizePathForFingerprint('\\\\server\\share\\logs\\run.txt')).toBe('//server/share/logs/run.txt');
    // Relative paths keep an unresolvable leading .. (it is not resolvable
    // off-filesystem), while dot segments that resolve inside the base collapse.
    expect(normalizePathForFingerprint('../parent/keep.txt')).toBe('../parent/keep.txt');
    expect(normalizePathForFingerprint('a/b/../../c.txt')).toBe('c.txt');
    expect(normalizePathForFingerprint('a/../../c.txt')).toBe('../c.txt');
  });

  it('stablePatchStringify normalizes path fields but leaves code and prose byte-for-byte', () => {
    const windows = { kind: 'scripts', scripts: [{ path: 'tools\\migrate.py', code: 'print("a\\b")' }] };
    const posix = { kind: 'scripts', scripts: [{ path: 'tools/migrate.py', code: 'print("a\\b")' }] };
    expect(stablePatchStringify(windows)).toBe(stablePatchStringify(posix));
    expect(stablePatchStringify(windows)).toContain('"path":"tools/migrate.py"');
    expect(stablePatchStringify(windows)).toContain('print(\\"a\\\\b\\")');
    // The generic serializer keeps its pre-existing contract: no path awareness.
    expect(stableStringify(windows)).not.toBe(stableStringify(posix));
  });

  it('surfaceEditSummary yields identical lesson diffs across separators (the local fingerprint seam)', () => {
    const edit = (path: string) => ({
      kind: 'scripts',
      scripts: [{ path, language: 'python', code: 'print(1)' }]
    });
    const windows = surfaceEditSummary(edit('tools\\migrate.py'));
    const posix = surfaceEditSummary(edit('tools/migrate.py'));
    expect(windows).toBe(posix);
    expect(windows).toContain('tools/migrate.py');
    expect(windows).not.toContain('\\');
  });
});

describe('harness2 shared / redaction building blocks', () => {
  it('redactSecrets is idempotent and strips secret shapes', () => {
    const text = 'api_key=sk-abcdefghijklmnop12 and password hunter2x';
    const once = redactSecrets(text);
    expect(once).not.toContain('sk-abcdefghijklmnop12');
    expect(once).toContain('<secret>');
    expect(redactSecrets(once)).toBe(once);
  });

  it('composing redactSecrets before redactIdentifiers keeps both effects', () => {
    const text = 'branch_a uses token ghp_abcdefghijklmnopqrst';
    const composed = redactIdentifiers(redactSecrets(text), ['branch_a']);
    expect(composed).not.toContain('ghp_abcdefghijklmnopqrst');
    expect(composed).toContain('<secret>');
    expect(composed).toContain('[redacted]');
  });

  it('stripStructuredAdvice, truncate and redactIdentifiers keep their contracts', () => {
    expect(stripStructuredAdvice('x <jitrl_advice>a</jitrl_advice> y')).toBe('x  y');
    expect(truncate('abcdef', 4)).toBe('abc\u2026');
    expect(redactIdentifiers('node_a node_a', ['node_a'])).toBe('[redacted] [redacted]');
  });
});
