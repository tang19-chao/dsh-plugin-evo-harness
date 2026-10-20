/**
 * Deterministic, dependency-free syntax gate for lessons that embed generated
 * scripts or middleware (ARCHITECTURE.md 4.3 item 1: "先在本地做语法树（AST）
 * 解析验证，通过后才允许写入 MCP").
 *
 * A full parser would need a host toolchain; this module implements a
 * deterministic lexical/structural check that is strict enough to keep broken
 * generated code out of the memory backend (unbalanced brackets, unterminated
 * strings/comments, python block headers without a colon, mixed indentation,
 * unbalanced bash block keywords) while never depending on the host sandbox.
 * Results are stable for a given input, so governance is unit-testable.
 */

/** Embedded script languages supported by the gate. */
export const SCRIPT_LANGUAGES = ['python', 'bash', 'typescript', 'javascript'] as const;
export type ScriptLanguage = (typeof SCRIPT_LANGUAGES)[number];

/** One generated script/middleware artifact embedded in a lesson. */
export interface EmbeddedScriptSpec {
  readonly path: string;
  readonly language: string;
  readonly code: string;
}

/** Deterministic finding produced by the script gate. */
export interface ScriptSyntaxIssue {
  readonly code: 'script_syntax_invalid' | 'invalid_script_path';
  readonly path: string;
  readonly message: string;
}

interface ScanResult {
  readonly ok: boolean;
  readonly message?: string;
}

const OPENERS = '([{';
const CLOSERS = ')]}';
const PAIR: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };

/** Relative, traversal-free script path. */
export function isValidScriptPath(path: string): boolean {
  if (typeof path !== 'string' || path.trim().length === 0) {
    return false;
  }
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\')) {
    return false;
  }
  const segments = path.split(/[\\/]+/);
  if (segments.some((segment) => segment === '..')) {
    return false;
  }
  return /^[A-Za-z0-9._\-/\\]+$/.test(path);
}

export function isScriptLanguage(value: string): value is ScriptLanguage {
  return (SCRIPT_LANGUAGES as readonly string[]).includes(value);
}

/** Validate one embedded script; returns every issue found. */
export function checkScriptSyntax(spec: EmbeddedScriptSpec): ScriptSyntaxIssue[] {
  const issues: ScriptSyntaxIssue[] = [];
  const path = typeof spec.path === 'string' ? spec.path : '';
  if (!isValidScriptPath(path)) {
    issues.push({
      code: 'invalid_script_path',
      path,
      message: 'Embedded script path must be relative and traversal-free (received "' + path + '").'
    });
  }
  if (!isScriptLanguage(spec.language)) {
    issues.push({
      code: 'script_syntax_invalid',
      path,
      message: 'Unsupported embedded script language "' + spec.language + '".'
    });
    return issues;
  }
  const code = typeof spec.code === 'string' ? spec.code : '';
  if (code.trim().length === 0) {
    issues.push({ code: 'script_syntax_invalid', path, message: 'Embedded script body is empty.' });
    return issues;
  }
  const language = spec.language;
  const scan = scanBalanced(code, language);
  if (!scan.ok) {
    issues.push({ code: 'script_syntax_invalid', path, message: scan.message ?? 'Unbalanced script body.' });
    return issues;
  }
  if (language === 'python') {
    const pythonIssue = checkPythonBlocks(code);
    if (pythonIssue !== undefined) {
      issues.push({ code: 'script_syntax_invalid', path, message: pythonIssue });
    }
  } else if (language === 'bash') {
    const bashIssue = checkBashBlocks(code);
    if (bashIssue !== undefined) {
      issues.push({ code: 'script_syntax_invalid', path, message: bashIssue });
    }
  }
  return issues;
}

/** Validate many embedded scripts in declaration order. */
export function checkEmbeddedScripts(specs: readonly EmbeddedScriptSpec[]): ScriptSyntaxIssue[] {
  const issues: ScriptSyntaxIssue[] = [];
  for (const spec of specs) {
    issues.push(...checkScriptSyntax(spec));
  }
  return issues;
}

function scanBalanced(code: string, language: string): ScanResult {
  const stack: string[] = [];
  const hashComments = language === 'python' || language === 'bash';
  const slashComments = language === 'javascript' || language === 'typescript';
  let index = 0;
  while (index < code.length) {
    const char = code[index];
    if (char === undefined) {
      break;
    }
    const next = code[index + 1];
    if (char === '\n') {
      index += 1;
      continue;
    }
    if (hashComments && char === '#') {
      while (index < code.length && code[index] !== '\n') {
        index += 1;
      }
      continue;
    }
    if (slashComments && char === '/' && next === '/') {
      while (index < code.length && code[index] !== '\n') {
        index += 1;
      }
      continue;
    }
    if (slashComments && char === '/' && next === '*') {
      const end = code.indexOf('*/', index + 2);
      if (end < 0) {
        return { ok: false, message: 'Unterminated block comment.' };
      }
      index = end + 2;
      continue;
    }
    if (char === '"' || char === "'" || (char === '\x60' && language !== 'python')) {
      const quote = char;
      let cursor = index + 1;
      let closed = false;
      while (cursor < code.length) {
        const inner = code[cursor];
        if (inner === '\\') {
          cursor += 2;
          continue;
        }
        if (inner === quote) {
          closed = true;
          break;
        }
        if ((inner === '\n' || inner === '\r') && quote !== '\x60') {
          break;
        }
        cursor += 1;
      }
      if (!closed) {
        return { ok: false, message: 'Unterminated string literal starting at offset ' + index + '.' };
      }
      index = cursor + 1;
      continue;
    }
    if (OPENERS.includes(char)) {
      stack.push(char);
      index += 1;
      continue;
    }
    if (CLOSERS.includes(char)) {
      const expected = PAIR[char];
      const actual = stack.pop();
      if (actual !== expected) {
        return {
          ok: false,
          message: 'Unbalanced bracket "' + char + '" at offset ' + index + (actual === undefined ? ' with no opener.' : ' closing "' + actual + '".')
        };
      }
      index += 1;
      continue;
    }
    index += 1;
  }
  if (stack.length > 0) {
    return { ok: false, message: 'Unclosed bracket "' + stack[stack.length - 1] + '".' };
  }
  return { ok: true };
}

const PYTHON_HEADER = /^(?:def|class|if|elif|else|for|while|try|except|finally|with|match|case|lambda|async)\b/;

function checkPythonBlocks(code: string): string | undefined {
  const lines = code.split(/\r?\n/);
  let sawTabIndent = false;
  let sawSpaceIndent = false;
  for (const line of lines) {
    const indentMatch = /^([ \t]+)/.exec(line);
    if (indentMatch !== null && indentMatch[1] !== undefined && line.trim().length > 0) {
      if (indentMatch[1].includes('\t')) {
        sawTabIndent = true;
      }
      if (/^ +$/.test(indentMatch[1].replace(/\t/g, ''))) {
        sawSpaceIndent = true;
      }
    }
    const stripped = line.replace(/#.*$/, '').trimEnd();
    if (stripped.length === 0) {
      continue;
    }
    if (!PYTHON_HEADER.test(stripped.trimStart())) {
      continue;
    }
    if (!bracketsBalancedInLine(stripped)) {
      continue;
    }
    if (stripped.endsWith('\\')) {
      continue;
    }
    if (!stripped.includes(':')) {
      return 'Python block header is missing a trailing colon: "' + stripped.trim() + '".';
    }
  }
  if (sawTabIndent && sawSpaceIndent) {
    return 'Python indentation mixes tabs and spaces.';
  }
  return undefined;
}

function bracketsBalancedInLine(line: string): boolean {
  const stack: string[] = [];
  for (const char of line) {
    if (OPENERS.includes(char)) {
      stack.push(char);
    } else if (CLOSERS.includes(char)) {
      if (stack.pop() !== PAIR[char]) {
        return false;
      }
    }
  }
  return stack.length === 0;
}

const BASH_BLOCKS: readonly (readonly [RegExp, RegExp, string])[] = [
  [/^\s*if\b/, /^\s*fi\b/, 'if/fi'],
  [/^\s*(?:for|while|until|select)\b/, /^\s*done\b/, 'loop/done'],
  [/^\s*case\b/, /^\s*esac\b/, 'case/esac']
];

function checkBashBlocks(code: string): string | undefined {
  const lines = code.split(/\r?\n/);
  for (const [opener, closer, label] of BASH_BLOCKS) {
    let open = 0;
    let close = 0;
    for (const line of lines) {
      if (opener.test(line)) {
        open += 1;
      }
      if (closer.test(line)) {
        close += 1;
      }
    }
    if (open !== close) {
      return 'Bash ' + label + ' blocks are unbalanced (' + open + ' open, ' + close + ' closed).';
    }
  }
  return undefined;
}
