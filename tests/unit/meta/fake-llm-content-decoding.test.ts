/**
 * Meta gate (rev6 A2): a tests/** fake that pretends to speak DSH but joins
 * `message.content` directly is lying about the host contract.
 *
 * The real adapter (`src/dsh-bridge/model.ts`, `toDshMessage`) turns every
 * message into `[{ type: 'text', text }]` BEFORE `ctx.llm.stream` is called.
 * A fake that does `options.messages.map((message) => message.content).join(...)`
 * therefore sees `[object Object]`, every prompt route misses, and the run can
 * look green while it never reached the pipeline under test (exactly how the
 * P0-1 permanent gate became a false green).
 *
 * DECISION RULE
 *   A file is a DSH stream fake when it contains a `stream:` / `stream(` /
 *   `.stream(` marker. Inside such a file, every `.messages` iteration
 *   (`map`, `for...of`, or destructured callback parameter) that accesses
 *   `content` without `decodeContent(...)` is a finding.
 *
 *   Host-neutral `ModelRequest` fakes (`complete(request: ModelRequest)` over a
 *   STRING `content`) are explicitly exempted BY SHAPE, not by directory or
 *   file allowlist: the enclosing function must be `complete` and its receiver
 *   must be declared `ModelRequest`. A stream fake that reuses the identifier
 *   `request` is therefore still flagged.
 *
 * The scan root is `tests/` (unit AND e2e); the meta test excludes itself.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeContent } from '../../e2e/fixtures';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TESTS_ROOT = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(TESTS_ROOT, '..');
const SELF = path.resolve(fileURLToPath(import.meta.url));

const STREAM_MARKER = /\bstream\s*[:(]|\.stream\s*\(/;
const MAP_CALLBACK =
  /([A-Za-z_$][\w$]*)\s*\.\s*messages\s*\.\s*map\s*\(\s*(?:\(\s*([A-Za-z_$][\w$]*)[^)]*\)|([A-Za-z_$][\w$]*))\s*=>/g;
const DESTRUCTURED_CALLBACK =
  /([A-Za-z_$][\w$]*)\s*\.\s*messages\s*\.\s*map\s*\(\s*\(\s*\{([^}]*)\}\s*(?::[^)]*)?\)\s*=>/g;
const FOR_OF_MESSAGES =
  /for\s*\(\s*const\s+([A-Za-z_$][\w$]*)\s+of\s+([A-Za-z_$][\w$]*)\s*\.\s*messages\s*\)/g;

interface RawContentFinding {
  /** 1-based line of the offending iteration. */
  readonly line: number;
  readonly snippet: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when this iteration belongs to a host-neutral `complete(request:
 * ModelRequest)` fake. Exemption is shape-based: the nearest enclosing function
 * declaration must be `complete`, and the receiver must carry the ModelRequest
 * type annotation. A stream fake is never exempt, even when it names its
 * parameter `request`.
 */
function isHostNeutralModelRequest(text: string, receiver: string, index: number): boolean {
  const before = text.slice(0, index);
  const complete = /\bcomplete\s*\(/g;
  const stream = /\bstream\s*[:(]/g;
  let lastComplete = -1;
  let lastStream = -1;
  let match: RegExpExecArray | null;
  while ((match = complete.exec(before)) !== null) {
    lastComplete = match.index;
  }
  while ((match = stream.exec(before)) !== null) {
    lastStream = match.index;
  }
  if (lastComplete < 0 || lastComplete < lastStream) {
    return false;
  }
  const declaration = before.slice(Math.max(0, lastComplete - 64));
  return new RegExp(
    '\\bcomplete\\s*\\(\\s*' + escapeRegExp(receiver) + '\\s*:\\s*ModelRequest\\b'
  ).test(declaration);
}

function findingAt(text: string, index: number, snippet: string): RawContentFinding {
  return { line: text.slice(0, index).split('\n').length, snippet: snippet.trim() };
}

/**
 * All raw `content` joins a DSH stream fake performs. `complete(...)` fakes are
 * exempt only when they are host-neutral by shape (see above).
 */
export function findRawDshContentJoins(text: string): RawContentFinding[] {
  if (!STREAM_MARKER.test(text)) {
    return [];
  }
  const findings: RawContentFinding[] = [];

  MAP_CALLBACK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MAP_CALLBACK.exec(text)) !== null) {
    const receiver = match[1];
    const parameter = match[2] ?? match[3];
    if (receiver === undefined || parameter === undefined) {
      continue;
    }
    if (isHostNeutralModelRequest(text, receiver, match.index)) {
      continue;
    }
    // Search the callback body (multiline included), not only the match line.
    const window = text.slice(match.index, match.index + 600);
    const access = new RegExp('\\b' + escapeRegExp(parameter) + '\\s*\\.\\s*content\\b');
    const accessMatch = access.exec(window);
    if (accessMatch === null) {
      continue;
    }
    // A decode in the same callback is the required safe form.
    if (/decodeContent\s*\(/.test(window.slice(0, accessMatch.index + accessMatch[0].length + 40))) {
      continue;
    }
    findings.push(findingAt(text, match.index, match[0]));
  }

  DESTRUCTURED_CALLBACK.lastIndex = 0;
  while ((match = DESTRUCTURED_CALLBACK.exec(text)) !== null) {
    const receiver = match[1];
    const destructured = match[2] ?? '';
    if (receiver === undefined || !/(^|,|\s)content(\s|,|$)/.test(destructured)) {
      continue;
    }
    if (isHostNeutralModelRequest(text, receiver, match.index)) {
      continue;
    }
    const window = text.slice(match.index, match.index + 600);
    if (/decodeContent\s*\(/.test(window)) {
      continue;
    }
    findings.push(findingAt(text, match.index, match[0]));
  }

  FOR_OF_MESSAGES.lastIndex = 0;
  while ((match = FOR_OF_MESSAGES.exec(text)) !== null) {
    const parameter = match[1];
    const receiver = match[2];
    if (parameter === undefined || receiver === undefined) {
      continue;
    }
    if (isHostNeutralModelRequest(text, receiver, match.index)) {
      continue;
    }
    const window = text.slice(match.index, match.index + 600);
    const access = new RegExp('\\b' + escapeRegExp(parameter) + '\\s*\\.\\s*content\\b');
    if (!access.test(window) || /decodeContent\s*\(/.test(window)) {
      continue;
    }
    findings.push(findingAt(text, match.index, match[0]));
  }

  return findings;
}

/** Every .ts file under tests/**, excluding this meta test. */
function listTestSources(): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') {
          continue;
        }
        walk(absolute);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        if (path.resolve(absolute) !== SELF) {
          files.push(absolute);
        }
      }
    }
  };
  walk(TESTS_ROOT);
  return files.sort();
}

function offendersIn(files: readonly string[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    const findings = findRawDshContentJoins(fs.readFileSync(file, 'utf8'));
    for (const finding of findings) {
      offenders.push(relative + ':' + String(finding.line) + ' :: ' + finding.snippet);
    }
  }
  return offenders;
}

describe('DSH content-block decoding in test fakes', () => {
  it('decodeContent follows the real block-array contract', () => {
    expect(decodeContent('plain')).toBe('plain');
    expect(
      decodeContent([
        { type: 'text', text: 'alpha' },
        { type: 'text', text: 'beta' }
      ])
    ).toBe('alphabeta');
    expect(decodeContent([{ type: 'image' }, null, { text: 'tail' }])).toBe('tail');
    expect(decodeContent(null)).toBe('');
    expect(decodeContent(undefined)).toBe('');
    expect(decodeContent({ text: 'not an array' })).toBe('');
  });

  it('flags a synthetic raw-content stream fake (positive control)', () => {
    const positive = [
      'const host = {',
      '  stream: async function* (options) {',
      "    const joined = options.messages.map((message) => message.content).join('\\n');",
      '    return joined;',
      '  }',
      '};'
    ].join('\n');
    const findings = findRawDshContentJoins(positive);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(3);
  });

  it('accepts the same fake once it decodes blocks (negative control)', () => {
    const negative = [
      'const host = {',
      '  stream: async function* (options) {',
      "    const joined = options.messages.map((message) => decodeContent(message.content)).join('\\n');",
      '    return joined;',
      '  }',
      '};'
    ].join('\n');
    expect(findRawDshContentJoins(negative)).toEqual([]);
  });

  it('accepts a host-neutral ModelRequest fake with string content (shape allowlist)', () => {
    const modelRequest = [
      'const model = {',
      '  async complete(request: ModelRequest) {',
      "    const text = request.messages.map((message) => message.content).join('\\n');",
      '    return text;',
      '  }',
      '};'
    ].join('\n');
    expect(findRawDshContentJoins(modelRequest)).toEqual([]);
  });

  it('still flags a stream fake that names its parameter request (allowlist is not a name)', () => {
    const deceptive = [
      'const host = {',
      '  stream: async function* (request) {',
      "    const joined = request.messages.map((message) => message.content).join('\\n');",
      '    return joined;',
      '  }',
      '};'
    ].join('\n');
    expect(findRawDshContentJoins(deceptive)).toHaveLength(1);
  });

  it('flags the one-line uppercase stream fake spelling too', () => {
    const oneLine = 'const host = { stream(options) { return options.messages.map((m) => m.content).join(""); } };';
    expect(findRawDshContentJoins(oneLine)).toHaveLength(1);
  });

  it('flags a multiline callback and a for...of raw-content read', () => {
    const multiline = [
      'const host = {',
      '  stream: async function* (options) {',
      '    const joined = options.messages.map((message) => {',
      '      return message.content;',
      '    }).join("\\n");',
      '    return joined;',
      '  }',
      '};'
    ].join('\n');
    expect(findRawDshContentJoins(multiline)).toHaveLength(1);

    const forOf = [
      'const host = {',
      '  stream: async function* (options) {',
      '    let joined = "";',
      '    for (const message of options.messages) {',
      '      joined += message.content;',
      '    }',
      '    return joined;',
      '  }',
      '};'
    ].join('\n');
    expect(findRawDshContentJoins(forOf)).toHaveLength(1);

    const destructured = [
      'const host = {',
      '  stream: async function* (options) {',
      '    return options.messages.map(({ content }) => content).join("\\n");',
      '  }',
      '};'
    ].join('\n');
    expect(findRawDshContentJoins(destructured)).toHaveLength(1);
  });

  it('finds zero raw-content stream fakes under tests/ (unit AND e2e)', () => {
    expect(offendersIn(listTestSources())).toEqual([]);
  });

  it('actually scans tests/e2e (the original P0-1 file lived there)', () => {
    const e2eFiles = listTestSources().filter((file) =>
      path.relative(TESTS_ROOT, file).split(path.sep).join('/').startsWith('e2e/')
    );
    expect(e2eFiles.length).toBeGreaterThan(0);
    expect(e2eFiles.some((file) => file.endsWith('host-mount-smoke.test.ts'))).toBe(true);
  });
});