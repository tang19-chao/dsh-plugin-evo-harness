/**
 * Unit tests for the targeted mutation gate (ADR 0005 D5 / P1 t8).
 *
 * HARD RULE (ADR 0005 §5.1-6): these tests exercise ONLY the gate's pure
 * functions - spec validation, text-anchored mutation application, restore
 * semantics, red-set subset judgement, baseline judgement, path safety - plus
 * static assertions that the CI/package wiring stays append-only. They never
 * spawn a vitest run and never apply a mutant to a real file: running the four
 * mutants inside vitest would be a recursion hazard, and mutating the worktree
 * would poison the attestation digest roots.
 *
 * The full gate (copy -> baseline -> mutate -> run -> judge -> restore ->
 * cleanup) is exercised by `node scripts/eval/mutation-gate.mjs --run`, which
 * is the CI `mutation-gate` job.
 *
 * HOW THE GATE MODULE IS LOADED: the gate is plain `.mjs` run directly by
 * node, and t8's write scope does not include a companion `.d.mts` declaration
 * file, so the module is imported with a runtime-computed specifier (typed
 * locally below) instead of a static import that would require one. The
 * runtime import happens exactly once, before any test runs, and importing
 * must stay side-effect free (the gate only runs under its own
 * `isDirectExecution` guard - these tests prove that by importing it).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

interface GateEdit {
  readonly label: string;
  readonly find: string;
  readonly replace: string;
}

interface GateMustRed {
  readonly file: string;
  readonly title: string;
}

interface GateMutant {
  readonly id: string;
  readonly title: string;
  readonly targetDefect: string;
  readonly file: string;
  readonly anchor: string;
  readonly edits: readonly GateEdit[];
  readonly testFiles: readonly string[];
  readonly mustRed: readonly GateMustRed[];
}

interface GateRedTest {
  readonly file: string;
  readonly title: string;
  readonly ancestorTitles: readonly string[];
  readonly status: string;
}

interface GateModule {
  readonly GATE_ID: string;
  readonly MUTANTS: readonly GateMutant[];
  readonly COPY_ENTRIES: readonly string[];
  readonly GATE_MUTATION_ROOTS: readonly string[];
  sha256Hex(input: string | Buffer): string;
  eolOf(text: string): 'lf' | 'crlf' | 'mixed';
  applyEdit(
    text: string,
    edit: GateEdit
  ): { code: string; content: string; occurrences: number; eolForm: string };
  applyMutation(
    text: string,
    mutant: GateMutant
  ): { ok: boolean; code: string; content: string; failures: { label: string; code: string }[] };
  isSafeGatePath(candidate: string): boolean;
  validateMutantSpec(mutant: GateMutant): string[];
  collectRedTests(report: unknown, copyDir: string): {
    red: GateRedTest[];
    fileErrors: { file: string; message: string }[];
  };
  judgeMustRed(
    mutant: GateMutant,
    redTests: readonly GateRedTest[]
  ): {
    ok: boolean;
    missing: GateMustRed[];
    hit: GateMustRed[];
    extraRed: GateRedTest[];
    redCount: number;
    mustRedCount: number;
    hitCount: number;
  };
  judgeBaselineReport(report: unknown): {
    ok: boolean;
    code: string;
    numTotalTests: number;
    numFailedTests: number;
    numPendingTests: number;
  };
  validateAnchors(): { ok: boolean; problems: string[] };
}

/** Import once; a non-literal specifier keeps tsc free of a companion d.mts. */
const gateModuleUrl = pathToFileURL(path.join(repoRoot, 'scripts', 'eval', 'mutation-gate.mjs')).href;
const gate = (await import(gateModuleUrl)) as GateModule;

function mutantById(id: string): GateMutant {
  const mutant = gate.MUTANTS.find((entry) => entry.id === id);
  if (mutant === undefined) throw new Error('mutant ' + id + ' missing from spec');
  return mutant;
}

function pristineText(mutant: { file: string }): string {
  return fs.readFileSync(path.join(repoRoot, ...mutant.file.split('/')), 'utf8');
}

function reverseMutant(mutant: GateMutant): GateMutant {
  return {
    ...mutant,
    edits: mutant.edits.map((edit) => ({
      label: edit.label + ' (reverse)',
      find: edit.replace,
      replace: edit.find
    }))
  };
}

describe('mutation gate spec (ADR 0005 §5.1)', () => {
  it('pins exactly the four documented mutants in order', () => {
    expect(gate.MUTANTS.map((entry) => entry.id)).toEqual(['M1', 'M2', 'M3', 'M4']);
    expect(new Set(gate.MUTANTS.map((entry) => entry.title)).size).toBe(4);
    expect(gate.GATE_ID).toBe('mutation-gate-v1');
  });

  it('names only safe, existing repository paths and existing test files', () => {
    for (const mutant of gate.MUTANTS) {
      expect(gate.validateMutantSpec(mutant), mutant.id).toEqual([]);
      expect(mutant.file.startsWith('src/'), mutant.id).toBe(true);
      expect(fs.existsSync(path.join(repoRoot, ...mutant.file.split('/'))), mutant.file).toBe(true);
      for (const file of mutant.testFiles) {
        expect(fs.existsSync(path.join(repoRoot, ...file.split('/'))), file).toBe(true);
      }
    }
  });

  it('binds every must-red name to a test file the mutant actually runs', () => {
    for (const mutant of gate.MUTANTS) {
      for (const entry of mutant.mustRed) {
        expect(mutant.testFiles).toContain(entry.file);
        expect(entry.title.length).toBeGreaterThan(10);
      }
    }
    expect(mutantById('M1').mustRed).toHaveLength(4);
    expect(mutantById('M2').mustRed).toHaveLength(3);
    expect(mutantById('M3').mustRed).toHaveLength(2);
    expect(mutantById('M4').mustRed).toHaveLength(2);
  });

  it('keeps the copy list free of node_modules (it is linked, never copied)', () => {
    expect(gate.COPY_ENTRIES).toContain('src');
    expect(gate.COPY_ENTRIES).toContain('tests');
    expect(gate.COPY_ENTRIES).toContain('scripts');
    expect(gate.COPY_ENTRIES).not.toContain('node_modules');
    for (const root of gate.GATE_MUTATION_ROOTS) {
      expect(root.endsWith('/')).toBe(true);
    }
  });
});

describe('anchor application and restore semantics', () => {
  it('resolves every anchor exactly once against the pristine sources', () => {
    const validation = gate.validateAnchors();
    expect(validation.problems).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  it('applies each mutant, changes the bytes, and cannot be applied twice', () => {
    for (const mutant of gate.MUTANTS) {
      const pristine = pristineText(mutant);
      const applied = gate.applyMutation(pristine, mutant);
      expect(applied.ok, mutant.id + ' must apply cleanly').toBe(true);
      expect(applied.content).not.toBe(pristine);
      expect(gate.sha256Hex(applied.content)).not.toBe(gate.sha256Hex(pristine));
      const second = gate.applyMutation(applied.content, mutant);
      expect(second.ok, mutant.id + ' must not apply a second time').toBe(false);
      expect(second.code).toBe('anchor-not-found');
    }
  });

  it('is EOL-adaptive: the same anchors land on a CRLF checkout', () => {
    for (const mutant of gate.MUTANTS) {
      const pristine = pristineText(mutant).replace(/\r\n/g, '\n');
      const crlfText = pristine.replace(/\n/g, '\r\n');
      const applied = gate.applyMutation(crlfText, mutant);
      expect(applied.ok, mutant.id + ' must apply on CRLF bytes').toBe(true);
      expect(applied.content).not.toBe(crlfText);
      expect(applied.content).toContain('\r\n');
      const reverse = gate.applyMutation(applied.content, reverseMutant(mutant));
      expect(reverse.ok, mutant.id + ' must reverse cleanly on CRLF bytes').toBe(true);
      expect(reverse.content).toBe(crlfText);
    }
  });

  it('restores pristine bytes byte-for-byte on an LF checkout (restore semantics)', () => {
    for (const mutant of gate.MUTANTS) {
      const pristine = pristineText(mutant).replace(/\r\n/g, '\n');
      const applied = gate.applyMutation(pristine, mutant);
      expect(applied.ok).toBe(true);
      const reverse = gate.applyMutation(applied.content, reverseMutant(mutant));
      expect(reverse.ok).toBe(true);
      expect(reverse.content).toBe(pristine);
    }
  });

  it('refuses ambiguous, missing and inert anchors with named codes', () => {
    const text = 'alpha\nbeta\ngamma\n';
    expect(gate.applyEdit(text, { label: 'missing', find: 'delta', replace: 'x' }).code).toBe('anchor-not-found');
    expect(gate.applyEdit(text, { label: 'ambiguous', find: 'a', replace: 'z' }).code).toBe('anchor-ambiguous');
    expect(gate.applyEdit(text, { label: 'inert', find: 'beta', replace: 'beta' }).code).toBe('mutation-inert');
    const once = gate.applyEdit(text, { label: 'once', find: 'beta', replace: 'BETA' });
    expect(once.code).toBe('applied');
    expect(once.occurrences).toBe(1);
    expect(once.content).toBe('alpha\nBETA\ngamma\n');
  });

  it('keeps `$` sequences in code inert by using split/join semantics', () => {
    const text = 'const a = value;\n';
    const result = gate.applyEdit(text, { label: 'dollar', find: 'value', replace: "$&'$`" });
    expect(result.code).toBe('applied');
    expect(result.content).toBe("const a = $&'$`;\n");
  });
});

describe('red-set judgement is subset-based by test name', () => {
  const m4 = mutantById('M4');
  const red = (file: string, title: string): GateRedTest => ({
    file,
    title,
    ancestorTitles: ['suite'],
    status: 'failed'
  });
  const mustRedRed = m4.mustRed.map((entry) => red(entry.file, entry.title));
  const firstTestFile = m4.testFiles[0] ?? '';
  const firstMustRedTitle = m4.mustRed[0]?.title ?? '';

  it('passes when the must-red set is fully red and tolerates extra reds (count is observation only)', () => {
    const judgement = gate.judgeMustRed(m4, [...mustRedRed, red(firstTestFile, 'a brand new unrelated red')]);
    expect(judgement.ok).toBe(true);
    expect(judgement.redCount).toBe(3);
    expect(judgement.hitCount).toBe(2);
    expect(judgement.missing).toEqual([]);
    expect(judgement.extraRed).toHaveLength(1);
    expect(judgement.extraRed[0]?.title).toBe('a brand new unrelated red');
  });

  it('fails with the exact missing name when one pinned test stays green', () => {
    const judgement = gate.judgeMustRed(m4, mustRedRed.slice(1));
    expect(judgement.ok).toBe(false);
    expect(judgement.missing).toHaveLength(1);
    expect(judgement.missing[0]?.title).toBe(firstMustRedTitle);
    expect(judgement.hitCount).toBe(1);
  });

  it('does not credit a red title from the wrong file', () => {
    const wrongFile = mustRedRed.map((entry) => ({ ...entry, file: 'tests/unit/other.test.ts' }));
    const judgement = gate.judgeMustRed(m4, wrongFile);
    expect(judgement.ok).toBe(false);
    expect(judgement.missing).toHaveLength(m4.mustRed.length);
  });

  it('treats only failed assertions as red (skipped/pending are not kills)', () => {
    const report = {
      numTotalTests: 4,
      numFailedTests: 1,
      numPassedTests: 2,
      numPendingTests: 1,
      testResults: [
        {
          name: 'C:/tmp/copy/tests/unit/jitrl/value-estimator.test.ts',
          status: 'failed',
          assertionResults: [
            { title: 'skipped one', status: 'skipped', ancestorTitles: ['s'] },
            { title: 'pending one', status: 'pending', ancestorTitles: ['s'] },
            { title: firstMustRedTitle, status: 'failed', ancestorTitles: ['s'] },
            { title: 'green one', status: 'passed', ancestorTitles: ['s'] }
          ]
        }
      ]
    };
    const collected = gate.collectRedTests(report, 'C:/tmp/copy');
    expect(collected.red).toHaveLength(1);
    expect(collected.red[0]?.file).toBe('tests/unit/jitrl/value-estimator.test.ts');
    expect(collected.red[0]?.title).toBe(firstMustRedTitle);
    expect(collected.fileErrors).toEqual([]);
  });

  it('derives repo-relative POSIX file identities from absolute report names', () => {
    const report = {
      testResults: [
        {
          name: 'C:\\tmp\\copy\\tests\\unit\\jitrl\\value-estimator.test.ts',
          status: 'failed',
          assertionResults: [{ title: 'x', status: 'failed', ancestorTitles: [] }]
        }
      ]
    };
    const collected = gate.collectRedTests(report, 'C:/tmp/copy');
    expect(collected.red[0]?.file).toBe('tests/unit/jitrl/value-estimator.test.ts');
  });

  it('surfaces a file-level collection failure instead of inventing reds', () => {
    const report = {
      testResults: [
        {
          name: 'C:/tmp/copy/tests/unit/broken.test.ts',
          status: 'failed',
          message: 'SyntaxError: unexpected token',
          assertionResults: []
        }
      ]
    };
    const collected = gate.collectRedTests(report, 'C:/tmp/copy');
    expect(collected.red).toEqual([]);
    expect(collected.fileErrors).toHaveLength(1);
    expect(collected.fileErrors[0]?.file).toBe('tests/unit/broken.test.ts');
  });

  it('reads reports from a real temp directory layout, not just synthetic paths', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-gate-test-'));
    try {
      const testFileRel = 'tests/unit/fake.test.ts';
      const absolute = path.join(dir, ...testFileRel.split('/'));
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, 'export const fake = true;\n', 'utf8');
      const report = {
        numTotalTests: 2,
        numFailedTests: 1,
        numPassedTests: 1,
        numPendingTests: 0,
        testResults: [
          {
            name: absolute,
            status: 'failed',
            assertionResults: [
              { title: 'green', status: 'passed', ancestorTitles: ['s'] },
              { title: 'red one', status: 'failed', ancestorTitles: ['s'] }
            ]
          }
        ]
      };
      const collected = gate.collectRedTests(report, dir);
      expect(collected.red.map((entry) => entry.file + ' :: ' + entry.title)).toEqual([
        testFileRel + ' :: red one'
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('baseline judgement', () => {
  it('accepts a fully green report', () => {
    const judgement = gate.judgeBaselineReport({ numTotalTests: 34, numFailedTests: 0, numPendingTests: 0 });
    expect(judgement.ok).toBe(true);
    expect(judgement.code).toBe('ok');
    expect(judgement.numTotalTests).toBe(34);
  });

  it('rejects any failed test with baseline-not-green', () => {
    const judgement = gate.judgeBaselineReport({ numTotalTests: 34, numFailedTests: 2, numPendingTests: 0 });
    expect(judgement.ok).toBe(false);
    expect(judgement.code).toBe('baseline-not-green');
    expect(judgement.numFailedTests).toBe(2);
  });

  it('refuses to judge an empty run (tests that never ran cannot kill a mutant)', () => {
    expect(gate.judgeBaselineReport({ numTotalTests: 0, numFailedTests: 0 }).code).toBe('baseline-no-tests-collected');
    expect(gate.judgeBaselineReport(null).code).toBe('report-missing');
    expect(gate.judgeBaselineReport(undefined).ok).toBe(false);
  });
});

describe('path safety', () => {
  it('accepts repo-relative POSIX paths under the gate roots', () => {
    expect(gate.isSafeGatePath('src/jitrl/reward-contract.ts')).toBe(true);
    expect(gate.isSafeGatePath('tests/e2e/provenance-chain.test.ts')).toBe(true);
    expect(gate.isSafeGatePath('scripts/eval/mutation-gate.mjs')).toBe(true);
  });

  it('rejects absolute paths, traversal, drive letters and out-of-root targets', () => {
    expect(gate.isSafeGatePath('')).toBe(false);
    expect(gate.isSafeGatePath('/etc/passwd')).toBe(false);
    expect(gate.isSafeGatePath('C:/Windows/system32/config')).toBe(false);
    expect(gate.isSafeGatePath('C:\\Users\\x')).toBe(false);
    expect(gate.isSafeGatePath('../outside.ts')).toBe(false);
    expect(gate.isSafeGatePath('src/../..//etc/passwd')).toBe(false);
    expect(gate.isSafeGatePath('src/a/../../b.ts')).toBe(false);
    expect(gate.isSafeGatePath('docs/reports/final-attestation.json')).toBe(false);
    expect(gate.isSafeGatePath('README.md')).toBe(false);
    expect(gate.isSafeGatePath('node_modules/vitest/vitest.mjs')).toBe(false);
    expect(gate.isSafeGatePath('src//double//slash.ts')).toBe(false);
  });

  it('rejects specs that name files the gate may never touch', () => {
    const broken: GateMutant = { ...mutantById('M4'), id: 'M5', file: 'docs/reports/final-attestation.json' };
    const problems = gate.validateMutantSpec(broken);
    expect(problems.some((problem) => problem.includes('outside gate roots'))).toBe(true);
    const orphanMustRed: GateMutant = {
      ...mutantById('M4'),
      mustRed: [{ file: 'tests/unit/never-run.test.ts', title: 'not part of this mutant' }]
    };
    expect(gate.validateMutantSpec(orphanMustRed).some((problem) => problem.includes('never runs'))).toBe(true);
  });
});

describe('hashing and EOL detection', () => {
  it('computes sha256 in lowercase hex', () => {
    expect(gate.sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(gate.sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(gate.sha256Hex('abc')).toBe(gate.sha256Hex('abc'));
  });

  it('classifies line-ending forms', () => {
    expect(gate.eolOf('a\nb\n')).toBe('lf');
    expect(gate.eolOf('a\r\nb\r\n')).toBe('crlf');
    expect(gate.eolOf('a\r\nb\n')).toBe('mixed');
  });
});

describe('CI and package wiring stays append-only (t2 → t8 order, ADR 0005 §6.3)', () => {
  const ci = fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');

  function jobBlock(job: string): string {
    const start = ci.indexOf('  ' + job + ':');
    expect(start, 'job ' + job + ' present').toBeGreaterThan(-1);
    const rest = ci.slice(start + 1);
    const next = rest.search(/\n  [a-zA-Z0-9_-]+:\s*(#.*)?\n/);
    return next === -1 ? rest : rest.slice(0, next + 1);
  }

  it('keeps every existing job and appends mutation-gate and node24-compat', () => {
    const jobKeys = [...ci.matchAll(/^  ([a-zA-Z0-9_-]+):\s*(#.*)?$/gm)].map((match) => match[1] ?? '');
    for (const required of [
      'verify',
      'guarded-regression',
      'fingerprint',
      'fingerprint-parity',
      'attestation-target',
      'mutation-gate',
      'node24-compat'
    ]) {
      expect(jobKeys, 'job ' + required).toContain(required);
    }
  });

  it('pins every action to a full 40-hex commit SHA', () => {
    const uses = [...ci.matchAll(/uses:\s*(\S+)/g)].map((match) => match[1] ?? '');
    expect(uses.length).toBeGreaterThan(5);
    for (const action of uses) {
      expect(action, action).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it('appends the mutation-gate job on Node 22 via the package script', () => {
    const block = jobBlock('mutation-gate');
    expect(block).toContain("node-version: '22'");
    expect(block).toContain('pnpm run check:mutation');
    expect(block).toContain('persist-credentials: false');
    expect(block).toContain('timeout-minutes: 30');
  });

  it('appends an explicit Node 24 job that never fakes the version', () => {
    const block = jobBlock('node24-compat');
    expect(block).toContain('Node 24');
    expect(block).toContain("node-version: '24'");
    expect(block).toContain('node -v');
    expect(block).toContain('pnpm exec vitest run tests/unit');
    expect(block).toContain('node scripts/eval-jitrl.mjs --json');
    expect(block).toContain('node scripts/eval/negative-result-diag.mjs --assert');
    expect(block).toContain('persist-credentials: false');
    // The PR-1 evidence suites in `tests/unit` resolve `HEAD~1` and the frozen
    // pre-policy baseline, so this job needs real history; without it a
    // checkout defect is misreported as a Node 24 incompatibility.
    expect(block).toContain('fetch-depth: 0');
  });

  it('does not rewrite the t2 attestation job or the Node 22 verify job', () => {
    const attestation = jobBlock('attestation-target');
    expect(attestation).toContain('node scripts/eval/check-attestation-target.mjs --json');
    expect(attestation).toContain('fetch-depth: 0');
    const verify = jobBlock('verify');
    expect(verify).toContain('pnpm run attest:verify');
    expect(verify).toContain("node-version: '22'");
  });

  it('adds exactly check:mutation to package.json without touching attestation keys or deps', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
      dependencies: Record<string, string>;
    };
    expect(pkg.scripts['check:mutation']).toBe('node scripts/eval/mutation-gate.mjs --run');
    expect(pkg.scripts['attest']).toBe(
      'node scripts/eval/final-attestation.mjs --ref HEAD --out docs/reports/final-attestation.json'
    );
    expect(pkg.scripts['attest:verify']).toBe(
      'node scripts/eval/final-attestation.mjs --verify docs/reports/final-attestation.json'
    );
    expect(pkg.scripts['guarded-regression']).toBe('node scripts/eval/guarded-regression.mjs --json');
    expect(pkg.devDependencies).toEqual({
      '@types/node': '22.20.5',
      esbuild: '0.28.2',
      typescript: '5.9.3',
      vitest: '3.2.7'
    });
    expect(pkg.dependencies).toEqual({ '@deepseek-ai/schemastery': '3.18.4' });
  });
});
