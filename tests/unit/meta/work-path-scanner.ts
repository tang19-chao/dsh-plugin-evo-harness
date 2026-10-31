/**
 * Scanner for repo-root `work/` path usage (rev5 P0-2, global invariant G5
 * "test inputs are self-contained").
 *
 * WHY AN AST SCANNER AND NOT A GREP
 * --------------------------------
 * `work/` is `.gitignore`d (`.gitignore:8`), so anything READ from
 * `<repo>/work/...` is absent in a clean checkout. The defect that motivated
 * this file is exactly one indirection deep: the path was BUILT in one statement
 * (`const ARTIFACT = join(REPO_ROOT, 'work', 'x.json')`) and READ in another
 * (`copyFileSync(ARTIFACT, …)`). A line-based grep sees those two lines only when
 * the author keeps the literal next to the read, and it cannot tell an INPUT read
 * from an OUTPUT write — so an allowlist built from raw grep hits degenerates
 * into "every line that mentions work is blessed", which is the silent hole this
 * exists to close. This scanner therefore tracks the PATH VALUE:
 *
 *   1. a `work/` string literal is lifted to the enclosing PATH EXPRESSION
 *      (`join(...)`/`resolve(...)`/concatenation/template) and classified by the
 *      filesystem API its value reaches AND which ARGUMENT SLOT it occupies.
 *      The slot matters: `writeFileSync(join(dir, '.gitignore'), 'work/\n')`
 *      passes `work/` as FILE CONTENT, which is not a path at all;
 *   2. a variable initialised from a work-path expression is TAINTED, so a later
 *      read/copy-source use is reported at the declaration line — the line an
 *      author has to change;
 *   3. the path's ROOT is resolved through the first argument of the enclosing
 *      `join`/`resolve`, following identifiers to the NEAREST ENCLOSING
 *      declaration (lexical scope, not a file-wide name match), then following
 *      function RETURN values and PARAMETERS to their call sites (bounded
 *      depth). `mkdtempSync(…)`/`os.tmpdir()` are `temp`;
 *      `REPO_ROOT`/`__dirname`/`import.meta.url`/`process.cwd()` are `repo`;
 *      anything else is `unresolved` and is a FINDING on purpose — fail-closed:
 *      "I could not prove this is a temp dir" is not a licence to read it.
 *
 * Only two kinds are findings: a repo-root read and an unresolved-root read.
 * Writes under the repo root are allowed by G5 (temporary output) but must be
 * justified per file; content strings (`work/` in markdown, `.gitignore` text,
 * task prompts such as `C:\work\a.ts`) are not paths and are never findings.
 *
 * DECLARED BOUNDARY: this is a static scan, not a dataflow analysis. A path
 * carried through an OBJECT PROPERTY and then read via a different binding
 * (e.g. `[…] = arms.map(a => ({ path: join(REPO_ROOT,'work',…) }))` followed by
 * `readFileSync(entry.path)`) is not followed. That gap is covered in the
 * meta-test by a second, structure-free guard: every statement that mentions a
 * repo-root anchor AND a `work/` literal must appear in the justification table,
 * whatever the dataflow says.
 *
 * The scanner is a PURE function of the tree it is pointed at: it never runs git,
 * never writes, and never consults repository state. The meta-test applies it to
 * synthetic temp trees (planted violations, a clean tree, temp-root usage) as
 * well as to this repository, so its discriminating power is asserted rather
 * than assumed.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

/** Where a `work/` path's root was traced to. */
export type RootKind =
  /** This repository: `REPO_ROOT`, `__dirname`, `import.meta.url`, `process.cwd()`. */
  | 'repo'
  /** A temp dir: `mkdtempSync(…)`, `os.tmpdir()`. */
  | 'temp'
  /** Could not be traced. Deliberately a finding (fail-closed). */
  | 'unresolved';

/** How a `work/` path reaches the filesystem. */
export type WorkUseKind =
  /** Read from a repo-root path: THE P0-2 defect (G5 violation). */
  | 'repo-root-input'
  /** Read from a path whose root could not be proven temporary: also a finding. */
  | 'unresolved-root-input'
  /** Written as scratch OUTPUT under the repo root: allowed by G5. */
  | 'repo-root-output'
  /** Read or written under a temp directory: allowed. */
  | 'temp-root'
  /** A work-path value that never reaches a filesystem API. */
  | 'path-value'
  /** Text that mentions `work/` but is content, not a path (markdown, prompts). */
  | 'content';

/** The kinds that a justified allowlist must cover, in reporting order. */
export const FINDING_KINDS: readonly WorkUseKind[] = ['repo-root-input', 'unresolved-root-input'];

/** The kinds allowed without an identity-pinned entry, but justified per file. */
export const JUSTIFIED_KINDS: readonly WorkUseKind[] = ['repo-root-output', 'path-value'];

export interface WorkOccurrence {
  /** Repo-relative POSIX path of the source file. */
  readonly file: string;
  /** 1-based line of the statement that carries the finding. */
  readonly line: number;
  /** The `work/` segment literal that was classified. */
  readonly literal: string;
  /**
   * The whole path expression the literal belongs to, as source text
   * (`join(REPO_ROOT, 'work', 'x.json')`). This is what a reader needs to see
   * WHICH input is at fault, so diagnostics print it instead of `'work'`.
   */
  readonly pathExpression: string;
  readonly kind: WorkUseKind;
  readonly root: RootKind;
  /** The filesystem/path call the value flows into, '' when none was found. */
  readonly consumer: string;
  /** sha256 (first 16 hex) of the whitespace-normalised enclosing statement. */
  readonly snippetHash: string;
  /** Stable identity: `<file>#<snippetHash>` (relpath + snippet hash). */
  readonly identityKey: string;
}

/** A pinned occurrence the tree is allowed to contain, with its reason. */
export interface WorkAllowEntry {
  readonly identityKey: string;
  readonly kind: WorkUseKind;
  readonly reason: string;
}

export interface ScanOptions {
  /** Directories to scan, relative to `root`; defaults to tests/ and scripts/. */
  readonly roots?: readonly string[];
}

const DEFAULT_ROOTS = ['tests', 'scripts'] as const;
const SOURCE_FILE = /[.](ts|mts|cts|mjs|cjs)$/;
const SKIP_DIRS = new Set(['node_modules', 'work', 'lib', 'dist', 'outputs', 'coverage']);

/** Calls whose ARG 0 is a path to READ. */
const READ_PATH_CALLS = new Set([
  'readFileSync',
  'readFile',
  'readdirSync',
  'readdir',
  'readJsonSync',
  'readlinkSync',
  'existsSync',
  'statSync',
  'lstatSync',
  'createReadStream',
  'openSync',
  'realpathSync'
]);
/** Calls whose ARG 0 is a path to CREATE and whose ARG 1 is its CONTENT. */
const WRITE_PATH_CALLS = new Set([
  'writeFileSync',
  'writeFile',
  'appendFileSync',
  'appendFile',
  'createWriteStream',
  'mkdirSync',
  'mkdir',
  'mkdtempSync',
  'mkdtemp',
  'rmSync',
  'rm',
  'rmdirSync',
  'unlinkSync',
  'unlink'
]);
/** Calls whose ARG 0 is a read SOURCE and ARG 1 a write DESTINATION. */
const COPY_CALLS = new Set(['copyFileSync', 'copyFile', 'cpSync', 'renameSync', 'rename']);
/** Path constructors: their arguments are segments of ONE path value. */
const PATH_CALLS = new Set(['join', 'resolve', 'normalize', 'dirname', 'basename']);
/** Calls that PROVE a directory is temporary. */
const TEMP_CALLS = new Set(['mkdtempSync', 'mkdtemp', 'tmpdir']);

/**
 * Identifier names that are treated as "this repository" by CONVENTION.
 *
 * This is a name rule, not a proof, and it is deliberately ONE-DIRECTIONAL: it
 * can only turn a use into a repo-root finding (which then needs an explicit
 * allowlist entry with a reason), never bless one. `REPO_ROOT` imported from a
 * sibling module (`import { REPO_ROOT } from './pr4a-build.mjs'`) cannot be
 * resolved without a cross-file hop, and guessing "unresolved" there would let a
 * genuine repo-root read hide behind an import. So the conventional names are
 * pinned here and the cross-file value is irrelevant to the verdict.
 */
const REPO_ANCHOR_NAMES = new Set(['REPO_ROOT', 'repoRoot', 'REPO_DIR', 'repoDir', 'ROOT_DIR', 'PROJECT_ROOT']);

/**
 * True when the string literal names a RELATIVE `work/` path segment.
 *
 * Excluded on purpose: absolute paths (`/tmp/work`) and drive-letter paths
 * (`C:\work\a.ts`) are somebody else's filesystem, and prose such as "already
 * has active work" is not a path at all.
 */
export function isWorkPathLiteral(text: string): boolean {
  if (text === 'work' || text === './work') return true;
  if (/^[.]?[/\\]?work[/\\]/.test(text)) return true;
  // a relative sub-path such as `evidence/work/x.json`
  if (/[^/\\:][/\\]work([/\\]|$)/.test(text) && !/^[A-Za-z]:/.test(text) && !text.startsWith('/') && !text.startsWith('\\')) {
    return true;
  }
  return false;
}

/** Walk the source files under `root/{roots}` in a stable order. */
export function collectSourceFiles(root: string, options: ScanOptions = {}): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(join(dir, entry.name));
      } else if (SOURCE_FILE.test(entry.name)) {
        found.push(join(dir, entry.name));
      }
    }
  };
  for (const rootName of options.roots ?? DEFAULT_ROOTS) {
    walk(join(root, rootName));
  }
  return found;
}

/** A stable, whitespace-insensitive digest of a statement's normalised text. */
function snippetHashOf(statementText: string): string {
  return createHash('sha256').update(statementText.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
}

/** The innermost statement containing `node`. */
function statementOf(node: ts.Node): ts.Node {
  let current: ts.Node = node;
  while (current.parent !== undefined && !ts.isStatement(current)) current = current.parent;
  return current;
}

function statementTextOf(node: ts.Node, sf: ts.SourceFile): string {
  return statementOf(node).getText(sf);
}

function lineOf(node: ts.Node, sf: ts.SourceFile): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** The bare callee name (`fs.readFileSync` → `readFileSync`). */
function bareCallee(call: ts.CallExpression, sf: ts.SourceFile): string {
  const text = call.expression.getText(sf);
  const parts = text.split('.');
  return parts[parts.length - 1] ?? text;
}

/** Strip parentheses, `as`/`satisfies` casts and non-null assertions. */
function unwrap(node: ts.Node): ts.Node {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * A function-like node WITH a body. `SignatureDeclaration` also covers overloads
 * and declare-only signatures, so the body-bearing subset is named explicitly
 * rather than poked at with optional chaining.
 */
type BodyBearer = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

function isFunctionLike(node: ts.Node | undefined): node is BodyBearer {
  return (
    node !== undefined &&
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node))
  );
}

/** Variable declarations named `name` among a statement list's DIRECT children. */
function declarationsIn(statements: readonly ts.Statement[], name: string): ts.VariableDeclaration[] {
  const found: ts.VariableDeclaration[] = [];
  for (const statement of statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) found.push(declaration);
    }
  }
  return found;
}

/**
 * Resolve `name` at `at` to its NEAREST enclosing declaration (lexical scope).
 *
 * A file-wide name match is wrong here: `for (const root of tempRoots)` in
 * `afterAll` and `const root = mkdtempSync(…)` in a helper are different roots,
 * and mixing them turns a provable temp dir into "unresolved" noise.
 */
function lookupBinding(at: ts.Node, name: string): ts.VariableDeclaration | ts.ParameterDeclaration | undefined {
  let child: ts.Node = at;
  let scope: ts.Node | undefined = at.parent;
  while (scope !== undefined) {
    if (isFunctionLike(scope)) {
      for (const parameter of scope.parameters) {
        if (ts.isIdentifier(parameter.name) && parameter.name.text === name) return parameter;
      }
      // An arrow's concise body (`() => x`) declares nothing, so only a block
      // body can hold a shadowing declaration.
      if (scope.body !== undefined && ts.isBlock(scope.body)) {
        const found = declarationsIn(scope.body.statements, name);
        if (found.length === 1) return found[0];
        if (found.length > 1) return undefined; // shadowed in one scope: ambiguous
      }
    } else if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope)) {
      const statements: readonly ts.Statement[] = ts.isSourceFile(scope) ? scope.statements : scope.statements;
      const found = declarationsIn(statements, name);
      if (found.length === 1) return found[0];
      if (found.length > 1) return undefined;
    }
    child = scope;
    scope = scope.parent;
  }
  return undefined;
}

/**
 * Bound on the root-tracing hops. Six hops is not enough for the real chains
 * (`join(param)` → call-site variable → helper-call → its `return` → its local →
 * `mkdtempSync`), so the budget is stated generously and still finite: a value
 * that cannot be resolved within it becomes `unresolved`, i.e. a FINDING.
 */
const MAX_TRACE_DEPTH = 20;

/**
 * Classify the ROOT of a path expression as repo / temp / unresolved.
 *
 * `seen` carries the nodes already visited so a recursive helper cannot loop;
 * `depth` bounds the hop count so a long chain degrades to `unresolved` (a
 * finding) rather than hanging.
 */
export function classifyRoot(
  expression: ts.Node,
  sf: ts.SourceFile,
  depth = 0,
  seen: ReadonlySet<ts.Node> = new Set<ts.Node>()
): RootKind {
  const node = unwrap(expression);
  if (depth > MAX_TRACE_DEPTH) return 'unresolved';
  if (seen.has(node)) return 'unresolved';
  // A NEW set per branch: sibling branches (several call sites of one helper)
  // must not poison each other, or the second site reads as a cycle.
  const visited = new Set(seen);
  visited.add(node);

  // A literal root: only meaningful when it is an absolute or relative path to
  // THIS repo. 'work' by itself proves nothing about where it sits.
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return /^([/\\]|[A-Za-z]:)/.test(node.text) || node.text === '.' || node.text === '..' ? 'unresolved' : 'unresolved';
  }

  if (ts.isIdentifier(node)) {
    // Node's module-scoped path helpers ARE this repository: a script's
    // `__dirname` is `<repo>/scripts/...`, and `path.resolve(__dirname,'..')` is
    // the repo root.
    if (node.text === '__dirname' || node.text === '__filename') return 'repo';
    if (REPO_ANCHOR_NAMES.has(node.text)) return 'repo';
    const binding = lookupBinding(node, node.text);
    if (binding === undefined) return 'unresolved';
    if (ts.isVariableDeclaration(binding)) {
      if (binding.initializer === undefined) return 'unresolved';
      return classifyRoot(binding.initializer, sf, depth + 1, visited);
    }
    // a parameter: follow it to the call sites of its own function
    return classifyParameter(binding, sf, depth + 1, visited);
  }

  if (ts.isPropertyAccessExpression(node)) {
    const text = node.getText(sf);
    if (/^import[.]meta[.](url|dirname|filename)$/.test(text)) return 'repo';
    if (/^process[.]env[.]/.test(text)) return 'unresolved'; // caller-supplied override
    return 'unresolved';
  }

  if (ts.isBinaryExpression(node)) {
    // `a ?? b`: the left option may be an external override, so the root is only
    // as strong as the right-hand fallback.
    if (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      return classifyRoot(node.right, sf, depth + 1, visited);
    }
    if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = classifyRoot(node.left, sf, depth + 1, visited);
      return left === 'unresolved' ? classifyRoot(node.right, sf, depth + 1, visited) : left;
    }
    return 'unresolved';
  }

  if (ts.isTemplateExpression(node)) {
    const head = classifyRoot(node.head, sf, depth + 1, visited);
    return head === 'unresolved' && node.templateSpans[0] !== undefined
      ? classifyRoot(node.templateSpans[0].expression, sf, depth + 1, visited)
      : head;
  }

  if (ts.isCallExpression(node)) {
    const callee = bareCallee(node, sf);
    if (TEMP_CALLS.has(callee)) return 'temp';
    if (/^cwd$/.test(callee) && /process/.test(node.expression.getText(sf))) return 'repo';
    if (PATH_CALLS.has(callee)) {
      const first = node.arguments[0];
      return first === undefined ? 'unresolved' : classifyRoot(first, sf, depth + 1, visited);
    }
    // A call to a locally declared function: trace its return values.
    if (ts.isIdentifier(node.expression)) {
      const fn = lookupFunction(node, node.expression.text);
      if (fn !== undefined) return classifyFunctionReturn(fn, sf, depth + 1, visited);
      // An arrow assigned to a const has no declaration-level name of its own.
      const arrow = lookupArrowBinding(node, node.expression.text);
      if (arrow !== undefined) return classifyFunctionReturn(arrow, sf, depth + 1, visited);
    }
    return 'unresolved';
  }

  return 'unresolved';
}

/** The nearest enclosing function declaration named `name`, searched outward. */
function lookupFunction(at: ts.Node, name: string): BodyBearer | undefined {
  let scope: ts.Node | undefined = at;
  while (scope !== undefined) {
    const statements = ts.isSourceFile(scope)
      ? scope.statements
      : ts.isBlock(scope) || ts.isModuleBlock(scope)
        ? scope.statements
        : undefined;
    if (statements !== undefined) {
      for (const statement of statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name !== undefined && statement.name.text === name) {
          return statement;
        }
      }
    }
    scope = scope.parent;
  }
  return undefined;
}

/** Resolve `const name = (...) => …` / `const name = function …` to its function. */
function lookupArrowBinding(at: ts.Node, name: string): BodyBearer | undefined {
  let scope: ts.Node | undefined = at;
  while (scope !== undefined) {
    const statements: readonly ts.Statement[] | undefined = ts.isSourceFile(scope)
      ? scope.statements
      : ts.isBlock(scope) || ts.isModuleBlock(scope)
        ? scope.statements
        : undefined;
    if (statements !== undefined) {
      for (const statement of statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === name &&
            declaration.initializer !== undefined &&
            (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
          ) {
            return declaration.initializer;
          }
        }
      }
    }
    scope = scope.parent;
  }
  return undefined;
}

/** A function's return values, folded: all-repo → repo, all-temp → temp, else unresolved. */
function classifyFunctionReturn(
  fn: BodyBearer,
  sf: ts.SourceFile,
  depth: number,
  seen: ReadonlySet<ts.Node>
): RootKind {
  if (fn.body === undefined) return 'unresolved';
  const results: RootKind[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== fn && isFunctionLike(node)) return; // do not descend into nested functions
    if (ts.isReturnStatement(node)) {
      results.push(node.expression === undefined ? 'unresolved' : classifyRoot(node.expression, sf, depth + 1, seen));
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  if (results.length === 0) return 'unresolved';
  const unique = [...new Set(results)];
  return unique.length === 1 ? (unique[0] ?? 'unresolved') : 'unresolved';
}

/** Follow a parameter to its function's call sites (all same root wins). */
function classifyParameter(
  parameter: ts.ParameterDeclaration,
  sf: ts.SourceFile,
  depth: number,
  seen: ReadonlySet<ts.Node>
): RootKind {
  const fn = parameter.parent;
  if (!isFunctionLike(fn)) return 'unresolved';
  // An arrow assigned to a variable has no name of its own.
  const name =
    fn.name !== undefined && ts.isIdentifier(fn.name)
      ? fn.name.text
      : fn.parent !== undefined && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)
        ? fn.parent.name.text
        : undefined;
  if (name === undefined) return 'unresolved';
  const index = fn.parameters.indexOf(parameter);
  if (index < 0) return 'unresolved';
  const results: RootKind[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name &&
      // do not treat the helper's own recursion as a call site
      node.parent !== undefined
    ) {
      const argument = node.arguments[index];
      results.push(argument === undefined ? 'unresolved' : classifyRoot(argument, sf, depth + 1, seen));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (results.length === 0) return 'unresolved';
  const unique = [...new Set(results)];
  return unique.length === 1 ? (unique[0] ?? 'unresolved') : 'unresolved';
}

/** The path expression a literal belongs to, lifted through concatenation/ctors. */
function pathExpressionOf(node: ts.Node): ts.Node {
  let current: ts.Node = node;
  for (;;) {
    const parent = current.parent;
    if (parent === undefined) return current;
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      current = parent;
      continue;
    }
    if (ts.isTemplateSpan(parent) || ts.isTemplateExpression(parent)) {
      current = parent;
      continue;
    }
    if (ts.isCallExpression(parent) && parent.arguments.some((argument) => argument === current)) {
      const name = parent.expression.getText().split('.').pop() ?? '';
      if (PATH_CALLS.has(name)) {
        current = parent;
        continue;
      }
    }
    return current;
  }
}

interface Consumption {
  readonly callee: string;
  /** Index of the argument slot the value occupies, -1 when none. */
  readonly argumentIndex: number;
  /** The variable declaration that stores the value, when only stored. */
  readonly declaration?: ts.VariableDeclaration;
}

/** Where a path expression's value goes: a call argument or a storage slot. */
function consumptionOf(expression: ts.Node, sf: ts.SourceFile): Consumption {
  let current = expression;
  for (;;) {
    const parent = current.parent;
    if (parent === undefined) return { callee: '', argumentIndex: -1 };
    if (ts.isCallExpression(parent)) {
      const index = parent.arguments.findIndex((argument) => argument === current);
      if (index >= 0) return { callee: bareCallee(parent, sf), argumentIndex: index };
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === current) {
      return { callee: '', argumentIndex: -1, declaration: parent };
    }
    if (ts.isStatement(parent) || ts.isVariableDeclarationList(parent)) {
      return { callee: '', argumentIndex: -1 };
    }
    current = parent;
  }
}

/** read/write/content, from the call a path value reaches and its argument slot. */
function directionOf(callee: string, argumentIndex: number): 'read' | 'write' | 'content' | undefined {
  if (COPY_CALLS.has(callee)) return argumentIndex === 0 ? 'read' : argumentIndex === 1 ? 'write' : 'content';
  if (READ_PATH_CALLS.has(callee)) return argumentIndex === 0 ? 'read' : 'content';
  if (WRITE_PATH_CALLS.has(callee)) return argumentIndex === 0 ? 'write' : 'content';
  return undefined;
}

function kindFor(direction: 'read' | 'write', root: RootKind): WorkUseKind {
  if (direction === 'write') return root === 'temp' ? 'temp-root' : 'repo-root-output';
  if (root === 'temp') return 'temp-root';
  return root === 'repo' ? 'repo-root-input' : 'unresolved-root-input';
}

/** The root-bearing node of a path expression (the part that decides WHERE it points). */
function rootOfPathExpression(expression: ts.Node): ts.Node {
  let current = unwrap(expression);
  for (;;) {
    if (ts.isBinaryExpression(current)) {
      // `a + b` and `a ?? b` take their root from the left, except that a
      // caller-supplied override on the left means the fallback decides.
      if (current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        current = unwrap(current.left);
        continue;
      }
      if (current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
        current = unwrap(current.right);
        continue;
      }
      return current;
    }
    if (ts.isTemplateExpression(current)) {
      current = unwrap(current.head);
      continue;
    }
    if (ts.isCallExpression(current)) {
      const name = current.expression.getText().split('.').pop() ?? '';
      if (PATH_CALLS.has(name) && current.arguments[0] !== undefined) {
        current = unwrap(current.arguments[0]);
        continue;
      }
    }
    return current;
  }
}

interface FileScan {
  readonly occurrences: readonly WorkOccurrence[];
}

/**
 * Scan one source file's text.
 *
 * Taint rule: a variable initialised from a work-path expression carries the
 * taint, so a later READ/copy-source use is reported at the DECLARATION line
 * (the line that introduced the input) even when the literal lives elsewhere.
 */
function scanSourceText(relativePath: string, text: string, scriptKind: ts.ScriptKind): FileScan {
  const sf = ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true, scriptKind);
  const occurrences: WorkOccurrence[] = [];

  interface Tainted {
    readonly literal: string;
    readonly pathExpression: string;
    readonly declaration: ts.VariableDeclaration;
    readonly root: RootKind;
  }
  const tainted = new Map<string, Tainted>();

  const push = (
    literal: string,
    pathExpression: string,
    kind: WorkUseKind,
    root: RootKind,
    consumer: string,
    anchor: ts.Node
  ): void => {
    const snippetHash = snippetHashOf(statementTextOf(anchor, sf));
    const identityKey = relativePath + '#' + snippetHash;
    if (occurrences.some((entry) => entry.identityKey === identityKey && entry.kind === kind)) return;
    occurrences.push({
      file: relativePath,
      line: lineOf(anchor, sf),
      literal,
      pathExpression: pathExpression.replace(/\s+/g, ' ').trim(),
      kind,
      root,
      consumer,
      snippetHash,
      identityKey
    });
  };

  // --- pass 1: literals, their path expression, consumption and root ---------
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const literal = node.text;
      if (isWorkPathLiteral(literal)) {
        const expression = pathExpressionOf(node);
        const consumption = consumptionOf(expression, sf);
        // A bare relative segment (`'work'`, `'work/x'`) inherits its root from
        // the enclosing join()/template/concat; a path with no such context is
        // NOT provably temporary, so it must not default to 'temp'.
        const root = classifyRoot(rootOfPathExpression(expression), sf);
        const direction =
          consumption.callee === '' ? undefined : directionOf(consumption.callee, consumption.argumentIndex);

        if (direction !== undefined) {
          if (direction === 'content') {
            push(literal, expression.getText(sf), 'content', root, consumption.callee, node);
          } else {
            push(literal, expression.getText(sf), kindFor(direction, root), root, consumption.callee, expression);
          }
          return;
        }
        if (consumption.declaration !== undefined && ts.isIdentifier(consumption.declaration.name)) {
          tainted.set(consumption.declaration.name.text, {
            literal,
            pathExpression: expression.getText(sf),
            declaration: consumption.declaration,
            root
          });
          return;
        }
        // Reaching a non-filesystem call (console.log, expect().toContain, it())
        // or a non-path slot is CONTENT, not a path read.
        push(literal, expression.getText(sf), 'content', root, consumption.callee, node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // --- pass 2: uses of tainted variables -------------------------------------
  if (tainted.size > 0) {
    const checkUse = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const origin = tainted.get(node.text);
        const parent = node.parent;
        const isDeclarationName = parent !== undefined && ts.isVariableDeclaration(parent) && parent.name === node;
        if (origin !== undefined && !isDeclarationName) {
          const expression = pathExpressionOf(node);
          const consumption = consumptionOf(expression, sf);
          const direction =
            consumption.callee === '' ? undefined : directionOf(consumption.callee, consumption.argumentIndex);
          if (direction !== undefined && direction !== 'content') {
            // The use-site root wins when the enclosing expression proves more
            // than the declaration did: `writeFileSync(join(REPO_ROOT, file))`
            // settles it even though `file` itself is a bare relative segment.
            const root = classifyRoot(rootOfPathExpression(expression), sf);
            push(origin.literal, origin.pathExpression, kindFor(direction, root), root, consumption.callee, origin.declaration);
          }
        }
      }
      ts.forEachChild(node, checkUse);
    };
    checkUse(sf);
  }

  return { occurrences };
}

/** Scan a tree and return every classified `work/` occurrence, sorted. */
export function scanWorkPathUses(root: string, options: ScanOptions = {}): WorkOccurrence[] {
  const all: WorkOccurrence[] = [];
  for (const file of collectSourceFiles(root, options)) {
    const relativePath = relative(root, file).split(sep).join('/');
    const text = readFileSync(file, 'utf8');
    const scriptKind = /[.](ts|mts|cts)$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    all.push(...scanSourceText(relativePath, text, scriptKind).occurrences);
  }
  return all.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

/** Reads of `work/` that are not proven temporary: the G5 violations. */
export function inputFindings(occurrences: readonly WorkOccurrence[]): WorkOccurrence[] {
  return occurrences.filter((occurrence) => FINDING_KINDS.includes(occurrence.kind));
}

/** Allowed-but-suspicious uses that need a per-file justification. */
export function justifiedUses(occurrences: readonly WorkOccurrence[]): WorkOccurrence[] {
  return occurrences.filter((occurrence) => JUSTIFIED_KINDS.includes(occurrence.kind));
}

/**
 * The two sides of the allowlist contract, as plain data so a test can assert
 * both directions:
 *   - `unlisted` findings are new reads nobody justified;
 *   - `stale` entries pin something the tree no longer contains, which means the
 *     allowlist has rotted and must be re-derived rather than trusted.
 */
export function compareAllowlist(
  occurrences: readonly WorkOccurrence[],
  allowlist: readonly WorkAllowEntry[]
): { unlisted: WorkOccurrence[]; stale: WorkAllowEntry[] } {
  const findings = inputFindings(occurrences);
  const allowed = new Set(allowlist.map((entry) => entry.identityKey));
  const present = new Set(findings.map((finding) => finding.identityKey));
  return {
    unlisted: findings.filter((finding) => !allowed.has(finding.identityKey)),
    stale: allowlist.filter((entry) => !present.has(entry.identityKey))
  };
}
