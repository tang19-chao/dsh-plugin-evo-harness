/**
 * P3-4 structural-debt gate (rev5 t12).
 *
 * WHAT THIS REPLACES
 * ------------------
 * The P3-C register (`docs/reports/p3-c-structural-debt-register.md` §1 item 4)
 * records that the only thing stopping a production bridge from settling
 * directly was CODE SHAPE plus NC6's 7 runtime reds: mutate
 * `settleLedgerCall` to `ledgerManager!.settle({ ...request, interim: false })`
 * and the bridge suite went red. That is "tests instead of types". After:
 *
 *   A (type level): `TwoPhaseSettlement.settleCall` takes
 *     `Omit<SettleRequest,'interim'>`, so passing `interim` is `TS2353`;
 *   B (structural): `LedgerAssembly` returns a BUILT settlement and no manager;
 *     `TwoPhaseSettlement.manager` is private; the two bridges accept
 *     `ledgerSettlement`, never a manager.
 *
 * the NC6 mutation is not even expressible in the bridges. The protection that
 * takes over is this STATIC gate, which fails closed on the final bytes.
 *
 * WHY AN AST AND NOT A GREP
 * -------------------------
 * `branch.ts` legitimately calls `recorder.settle(...)` eleven times (its
 * trajectory recorder), and the bridges call the sanctioned
 * `settlement.settleCall(...)`. A substring scan can neither tell those apart
 * from `manager.settle(` nor avoid flagging its own test fixtures and doc
 * comments. This gate parses every TypeScript file under `src/dsh-bridge` and
 * judges the AST shape:
 *
 *   1. the identifier `LedgerReservationManager` may not appear at all;
 *   2. the identifier `twoPhaseSettlementFor` may not appear (the only way to
 *      turn a manager back into a settlement inside the bridge);
 *   3. no property access named `manager` (the "get it back through the
 *      assembly's return value" path);
 *   4. every `.settle(` / `.reserve(` call must have the trajectory recorder as
 *      its receiver — anything else is a ledger-manager-shaped bypass.
 *
 * NEGATIVE CONTROLS (run on TEMP COPIES, never on the repository)
 * --------------------------------------------------------------
 * A gate that has never caught anything is indistinguishable from a gate that
 * cannot catch. Each rule is therefore exercised against a planted violation,
 * and each rule is shown to be LOAD-BEARING: disabling that one rule in the
 * scanner makes the corresponding violation disappear. Deleting a rule from
 * this file therefore fails the suite (the NC assertions go red), which is what
 * "delete the protection -> red" means at the level of the gate itself.
 *
 * The A control typechecks a VIRTUAL probe file through the project's own
 * TypeScript (no file is written to the repository; the probe lives only in the
 * compiler host).
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const BRIDGE_DIR = path.join(repoRoot, 'src', 'dsh-bridge');

type FindingKind =
  | 'manager-type-identifier'
  | 'settlement-factory-identifier'
  | 'manager-property-access'
  | 'manager-settle-or-reserve-call'
  | 'non-sanctioned-settle-call';

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly kind: FindingKind;
  readonly detail: string;
}

/** Rules can be switched off ONLY by the negative controls below. */
interface ScanRules {
  readonly managerTypeIdentifier?: boolean;
  readonly settlementFactory?: boolean;
  readonly managerPropertyAccess?: boolean;
  readonly settleReserveCalls?: boolean;
}

const ALL_RULES: Required<ScanRules> = {
  managerTypeIdentifier: true,
  settlementFactory: true,
  managerPropertyAccess: true,
  settleReserveCalls: true
};

/** `recorder.settle(...)` is the trajectory recorder, not the ledger. */
function isRecorderReceiver(receiver: ts.Expression): boolean {
  if (ts.isIdentifier(receiver)) {
    return receiver.text === 'recorder';
  }
  if (ts.isPropertyAccessExpression(receiver)) {
    return receiver.name.text === 'recorder';
  }
  return false;
}

/** Identifiers/property names that denote the mutable ledger manager. */
function isManagerShaped(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) {
    return /manager/i.test(node.text);
  }
  if (ts.isPropertyAccessExpression(node)) {
    return /manager/i.test(node.name.text);
  }
  return false;
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out.sort();
}

/** PURE scan of `rootDir`; never writes, never runs git. */
function scanStructuralDebt(rootDir: string, rules: ScanRules = {}): Finding[] {
  const effective = { ...ALL_RULES, ...rules };
  const findings: Finding[] = [];
  for (const full of listTsFiles(rootDir)) {
    const text = readFileSync(full, 'utf8');
    const source = ts.createSourceFile(full, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    const file = path.relative(rootDir, full).split(path.sep).join('/');
    const report = (node: ts.Node, kind: FindingKind, detail: string): void => {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      findings.push({ file, line: line + 1, kind, detail });
    };

    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        if (effective.managerTypeIdentifier && node.text === 'LedgerReservationManager') {
          report(node, 'manager-type-identifier', 'the bridges must never name the mutable manager type');
        }
        if (effective.settlementFactory && node.text === 'twoPhaseSettlementFor') {
          report(node, 'settlement-factory-identifier', 'a manager -> settlement factory is an assembly concern, not a bridge concern');
        }
      }
      if (effective.managerPropertyAccess && ts.isPropertyAccessExpression(node) && node.name.text === 'manager') {
        report(node, 'manager-property-access', 'no manager may be reached through a return value in the bridge');
      }
      if (effective.settleReserveCalls && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        if (method === 'settle' || method === 'reserve') {
          const receiver = node.expression.expression;
          if (!isRecorderReceiver(receiver)) {
            const kind: FindingKind = isManagerShaped(receiver)
              ? 'manager-settle-or-reserve-call'
              : 'non-sanctioned-settle-call';
            report(node.expression, kind, 'only the trajectory recorder may settle/reserve inside src/dsh-bridge');
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return findings;
}

// ---------------------------------------------------------------------------
// 0. the gate on the real tree (what must stay green)
// ---------------------------------------------------------------------------

describe('B: src/dsh-bridge holds no live ledger manager', () => {
  it('the real bridge tree has zero findings', () => {
    expect(scanStructuralDebt(BRIDGE_DIR)).toEqual([]);
  });

  it('the assembly returns a settlement and NEVER a manager', () => {
    const names = ledgerAssemblyPropertyNames(repoRoot);
    expect(names).toContain('settlement');
    expect(names).not.toContain('manager');
  });

  it('TwoPhaseSettlement.manager is private (the return-path exclusion is typed)', () => {
    expect(managerModifiers(repoRoot)).toContain('PrivateKeyword');
  });
});

// ---------------------------------------------------------------------------
// 1. negative controls: each rule catches a planted violation
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs.splice(0).reverse()) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** AST read of `LedgerAssembly`'s property names, rooted at `root`. */
function ledgerAssemblyPropertyNames(root: string): string[] {
  const file = path.join(root, 'src', 'ledger', 'assembly.ts');
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true);
  const names: string[] = [];
  source.forEachChild((node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'LedgerAssembly') {
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && member.name !== undefined) {
          names.push(member.name.getText(source));
        }
      }
    }
  });
  return names;
}

/** AST read of `TwoPhaseSettlement.manager`'s modifiers, rooted at `root`. */
function managerModifiers(root: string): string[] {
  const file = path.join(root, 'src', 'ledger', 'two-phase.ts');
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true);
  const modifiers: string[] = [];
  source.forEachChild((node) => {
    if (!ts.isClassDeclaration(node) || node.name?.text !== 'TwoPhaseSettlement') {
      return;
    }
    for (const member of node.members) {
      if (ts.isPropertyDeclaration(member) && member.name.getText(source) === 'manager') {
        for (const modifier of member.modifiers ?? []) {
          modifiers.push(ts.SyntaxKind[modifier.kind]);
        }
      }
    }
  });
  return modifiers;
}

function tempCopyOf(sourceRelative: string, extra: string): { dir: string; file: string; originalLineCount: number } {
  const dir = mkdtempSync(path.join(tmpdir(), 'p3-4-gate-'));
  tempDirs.push(dir);
  const original = readFileSync(path.join(repoRoot, sourceRelative), 'utf8');
  const target = path.join(dir, path.basename(sourceRelative));
  writeFileSync(target, original + '\n' + extra + '\n', 'utf8');
  return {
    dir,
    file: path.basename(sourceRelative),
    // Lines of the ORIGINAL file (it ends in LF, so the split has one extra "").
    originalLineCount: original.split('\n').length - 1
  };
}

describe('B negative controls: the gate really reports violations (temp copies only)', () => {
  it('NC1: an inserted manager.settle() is reported with file and line', () => {
    const { dir, file, originalLineCount } = tempCopyOf(
      path.join('src', 'dsh-bridge', 'agent-loop-executor.ts'),
      [
        'export function __ncDirectSettle(manager: { settle: (request: unknown) => void }): void {',
        "  manager.settle({ callId: 'nc', reservationId: 'nc', outcome: 'succeeded', interim: false });",
        '}'
      ].join('\n')
    );
    const findings = scanStructuralDebt(dir);
    const hit = findings.find((finding) => finding.kind === 'manager-settle-or-reserve-call');
    expect(hit).toBeDefined();
    expect(hit?.file).toBe(file);
    // The reported line is the inserted CALL (blank separator + the 2nd line of
    // the extra block), not the start of the file.
    expect(hit?.line).toBe(originalLineCount + 3);
  });

  it('NC2: reintroducing the manager TYPE is reported', () => {
    const { dir } = tempCopyOf(
      path.join('src', 'dsh-bridge', 'metered-model-adapter.ts'),
      [
        "import type { LedgerReservationManager } from '../ledger/reservation-manager.js';",
        'export interface __NcOption { readonly ledgerManager?: LedgerReservationManager }'
      ].join('\n')
    );
    const kinds = scanStructuralDebt(dir).map((finding) => finding.kind);
    expect(kinds).toContain('manager-type-identifier');
  });

  it('NC3: reading the manager back through the assembly return value is reported', () => {
    const { dir } = tempCopyOf(
      path.join('src', 'dsh-bridge', 'agent-loop-executor.ts'),
      [
        'export function __ncAssemblyPath(): void {',
        "  const assembly = assembleAgentLoopLedger({ enabled: true });",
        "  assembly?.manager.settle({ callId: 'nc', reservationId: 'nc', outcome: 'succeeded' });",
        '}'
      ].join('\n')
    );
    const kinds = scanStructuralDebt(dir).map((finding) => finding.kind);
    expect(kinds).toContain('manager-property-access');
    expect(kinds).toContain('manager-settle-or-reserve-call');
  });

  it('NC4: each rule is LOAD-BEARING — disabling it makes its NC disappear', () => {
    // This is the "delete the protection -> red" property of the gate: if a
    // future edit deletes a rule, the matching assertion below fails.
    const { dir } = tempCopyOf(
      path.join('src', 'dsh-bridge', 'agent-loop-executor.ts'),
      [
        'export function __ncMixed(manager: { settle: (request: unknown) => void }): void {',
        "  manager.settle({ callId: 'nc', reservationId: 'nc', outcome: 'succeeded' });",
        '}'
      ].join('\n')
    );
    expect(scanStructuralDebt(dir, { settleReserveCalls: false })).toEqual([]);
    expect(scanStructuralDebt(dir, {}).length).toBeGreaterThan(0);
  });

  it('NC0: a clean copy of the real file stays clean (no false positives)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'p3-4-gate-clean-'));
    tempDirs.push(dir);
    const target = path.join(dir, 'agent-loop-executor.ts');
    writeFileSync(target, readFileSync(path.join(BRIDGE_DIR, 'agent-loop-executor.ts'), 'utf8'), 'utf8');
    expect(scanStructuralDebt(dir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 1b. FINAL-BYTES negative control: mutate -> red, restore -> byte-identical
// ---------------------------------------------------------------------------

function copyTsTree(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const from = path.join(sourceDir, entry.name);
    const to = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyTsTree(from, to);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      copyFileSync(from, to);
    }
  }
}

function sha256OfFile(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

describe('final bytes: the gate is red on a mutated copy and green after restore', () => {
  it('mutating the final bytes turns the gate red; restoring returns the identical hash', () => {
    const structural = [
      path.join('src', 'ledger', 'assembly.ts'),
      path.join('src', 'ledger', 'two-phase.ts'),
      path.join('src', 'dsh-bridge', 'agent-loop-executor.ts'),
      path.join('src', 'dsh-bridge', 'metered-model-adapter.ts'),
      path.join('src', 'dsh-bridge', 'branch.ts')
    ];
    // The bytes judged below ARE the final bytes: captured in memory first.
    const captured = new Map(structural.map((relative) => [relative, readFileSync(path.join(repoRoot, relative))]));
    const dir = mkdtempSync(path.join(tmpdir(), 'p3-4-final-'));
    tempDirs.push(dir);
    copyTsTree(path.join(repoRoot, 'src', 'dsh-bridge'), path.join(dir, 'src', 'dsh-bridge'));
    copyTsTree(path.join(repoRoot, 'src', 'ledger'), path.join(dir, 'src', 'ledger'));

    // green baseline on the copied final bytes
    expect(scanStructuralDebt(path.join(dir, 'src', 'dsh-bridge'))).toEqual([]);
    expect(managerModifiers(dir)).toContain('PrivateKeyword');
    expect(ledgerAssemblyPropertyNames(dir)).not.toContain('manager');

    // mutation 1: un-private the manager -> the typed exclusion goes red
    const twoPhasePath = path.join(dir, 'src', 'ledger', 'two-phase.ts');
    const twoPhaseBytes = readFileSync(twoPhasePath, 'utf8');
    expect(twoPhaseBytes).toContain('private readonly manager');
    writeFileSync(twoPhasePath, twoPhaseBytes.replace('private readonly manager', 'readonly manager'), 'utf8');
    expect(managerModifiers(dir)).not.toContain('PrivateKeyword');

    // mutation 2: reintroduce the assembly return path inside a bridge -> red
    const executorPath = path.join(dir, 'src', 'dsh-bridge', 'agent-loop-executor.ts');
    writeFileSync(
      executorPath,
      readFileSync(executorPath, 'utf8') + '\nexport const __ncFinal = assembleAgentLoopLedger({ enabled: true })!.manager;\n',
      'utf8'
    );
    const findings = scanStructuralDebt(path.join(dir, 'src', 'dsh-bridge'));
    expect(findings.some((finding) => finding.kind === 'manager-property-access')).toBe(true);

    // restore the captured final bytes -> green again, byte-identical
    for (const [relative, bytes] of captured) {
      writeFileSync(path.join(dir, relative), bytes);
    }
    expect(scanStructuralDebt(path.join(dir, 'src', 'dsh-bridge'))).toEqual([]);
    expect(managerModifiers(dir)).toContain('PrivateKeyword');
    expect(ledgerAssemblyPropertyNames(dir)).not.toContain('manager');

    // the repository was never mutated: every captured file still hashes the same
    for (const [relative, bytes] of captured) {
      expect(sha256OfFile(path.join(repoRoot, relative))).toBe(
        createHash('sha256').update(bytes).digest('hex')
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 2. A: the type-level control (virtual probe, project compiler, no disk write)
// ---------------------------------------------------------------------------

interface ProbeResult {
  readonly diagnostics: readonly ts.Diagnostic[];
  readonly virtualPath: string;
}

function typecheckProbe(probeBody: string): ProbeResult {
  const virtualPath = path.join(repoRoot, 'src', 'ledger', '__virtual-settle-signature-probe__.ts');
  // TypeScript normalizes file names to forward slashes internally, so match on
  // the (unique) base name instead of the platform-separator spelling.
  const isVirtual = (fileName: string): boolean =>
    path.basename(fileName) === '__virtual-settle-signature-probe__.ts';
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: []
  };
  const host = ts.createCompilerHost(options);
  const baseFileExists = host.fileExists.bind(host);
  const baseReadFile = host.readFile.bind(host);
  const baseGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (fileName) => isVirtual(fileName) || baseFileExists(fileName);
  host.readFile = (fileName) => (isVirtual(fileName) ? probeBody : baseReadFile(fileName));
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    isVirtual(fileName)
      ? ts.createSourceFile(fileName, probeBody, languageVersion, true)
      : baseGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([virtualPath], options, host);
  const source = program.getSourceFiles().find((candidate) => isVirtual(candidate.fileName));
  const diagnostics = source === undefined
    ? [...program.getSyntacticDiagnostics()]
    : [
        ...program.getSyntacticDiagnostics(source),
        ...program.getSemanticDiagnostics(source)
      ];
  return { diagnostics, virtualPath };
}

const PROBE_HEADER = [
  "import type { TwoPhaseSettlement } from './two-phase.js';",
  'declare const settlement: TwoPhaseSettlement;'
].join('\n');

describe('A: settleCall rejects the ignored `interim` knob at compile time', () => {
  it('passing interim:false is TS2353 (the register\'s reproduced defect)', () => {
    const { diagnostics } = typecheckProbe(
      PROBE_HEADER +
        "\nsettlement.settleCall({ callId: 'c', reservationId: 'r', outcome: 'succeeded', interim: false });\n"
    );
    const violation = diagnostics.find((diagnostic) => diagnostic.code === 2353);
    expect(violation).toBeDefined();
    const message = ts.flattenDiagnosticMessageText(violation?.messageText ?? '', '\n');
    expect(message).toContain("'interim'");
  });

  it('passing interim:true is TS2353 too (neither polarity is accepted)', () => {
    const { diagnostics } = typecheckProbe(
      PROBE_HEADER +
        "\nsettlement.settleCall({ callId: 'c', reservationId: 'r', outcome: 'cancelled', interim: true });\n"
    );
    expect(diagnostics.some((diagnostic) => diagnostic.code === 2353)).toBe(true);
  });

  it('the clean request compiles with zero diagnostics (the A change is not vacuous)', () => {
    const { diagnostics } = typecheckProbe(
      PROBE_HEADER + "\nsettlement.settleCall({ callId: 'c', reservationId: 'r', outcome: 'succeeded' });\n"
    );
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([]);
  });
});
