#!/usr/bin/env node
/**
 * Targeted mutation gate (ADR 0005, decision D5 / P1 task t8).
 *
 * WHAT QUESTION THIS ANSWERS
 * --------------------------
 * Four discriminating test groups were written to pin four real defects. A
 * regression test whose verdict never changes when the defect is reintroduced
 * is decoration. This gate reintroduces each defect - ONCE, inside a throwaway
 * copy of the repository - and requires the defect's pinned tests to turn red:
 *
 *   M1  eight-surfaces provenance expansion deleted (R1-M1): removing the four
 *       `origin/guidance/role/allowAdvice` spreads from `mountSurface`'s mount
 *       base must turn e2e provenance-chain scenarios 1/2/5/6 red (scenarios
 *       3/4 are documented to stay green).
 *   M2  collector unknown-scope rejection deleted (R1-M2): removing the
 *       `if (!scopeInfo.isKnown)` fail-closed block in `observeToolCall` must
 *       turn e2e scenario 4 red plus the two D1 strict-default unit tests.
 *   M3  winner private yardstick restored (R3-M1): giving the composer winner
 *       its step-evaluator mean as the primary target again (non-winners keep
 *       `scoreUnderRewardContract`) must turn the two "P6.1-D 7.4" tests red.
 *   M4  readLearningTarget gain-first (R3-M2): preferring `learningTarget`
 *       over `observedReturn` must turn the two RewardContract target-field
 *       consumption tests red.
 *
 * JUDGEMENT (ADR 0005 §5.1, hard)
 * ------------
 *   - The criterion is `mustRed set ⊆ actual red set`, judged BY TEST NAME.
 *     The observed red COUNT is recorded as an observation (t16 documentation)
 *     and is deliberately NOT a failure condition: pinning a count would make
 *     the gate break whenever P1 legitimately grows the suites.
 *   - Before every mutant run, the SAME copy runs the target tests UNMUTATED
 *     and must be all green: a red under mutation only means something if the
 *     baseline is green (environment failures have no discriminating power).
 *   - The mutation must PROVE it landed: sha256 of the target file inside the
 *     copy is recorded before/after and must differ, otherwise the gate fails
 *     with `mutation-did-not-change-sha` (a "no-op mutation" is a lie).
 *   - ISOLATION: mutants are applied ONLY inside a temporary copy under
 *     `os.tmpdir()` (src/ tests/ scripts/ + tsconfig.json + vitest.config.ts +
 *     package.json, with `node_modules` linked back to the repository). The
 *     real worktree is NEVER mutated: src/, tests/ and scripts/ are exactly
 *     the attestation digest roots (ADR 0005 F-3), and an interrupted in-place
 *     mutation would silently poison `pnpm run attest:verify`.
 *   - ZERO RESIDUE: on every path (success, mutant red, crash) the temp copy is
 *     removed, and the gate re-hashes the four target files in the REPOSITORY
 *     and requires the digests to be identical to the ones taken at startup.
 *   - NO NEW DEPENDENCIES: the runner spawns the repository's own vitest
 *     binary with the same node running the gate. No Stryker, no child pnpm.
 *
 * EXIT CODES
 *   0  every selected mutant: baseline green, mutation landed, mustRed ⊆ red
 *   1  any named failure (see FAILURE CODES in the report) or an unmet mustRed
 *
 * USAGE
 *   node scripts/eval/mutation-gate.mjs --run [--json] [--only M1,M3]
 *        [--keep-tmp] [--out <file>]
 *   node scripts/eval/mutation-gate.mjs --validate [--json]   # anchors only,
 *                                                             # no vitest, no copy
 *   node scripts/eval/mutation-gate.mjs --list
 *
 * `tests/unit/eval/mutation-gate.test.ts` imports the PURE functions exported
 * below (spec parsing, anchor application, red-set judgement, path safety,
 * restore semantics) and never spawns a mutant run - running the four mutants
 * inside vitest would be a recursion hazard (ADR 0005 §5.1-6).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '../..');
export const GATE_ID = 'mutation-gate-v1';

/**
 * What the runner copies into the throwaway tree. `node_modules` is NOT
 * copied - it is linked back to the repository (junction on win32, dir symlink
 * elsewhere) so the copy resolves the exact same vitest/dependencies.
 */
export const COPY_ENTRIES = ['src', 'tests', 'scripts', 'tsconfig.json', 'vitest.config.ts', 'package.json'];

/** Only paths under these roots may ever be named by a mutant spec. */
export const GATE_MUTATION_ROOTS = ['src/', 'tests/', 'scripts/'];

/**
 * The four pinned mutants (ADR 0005 §5.1 table). Anchors are stable TEXT
 * blocks, never line numbers. Every `find` must occur exactly once in the
 * pristine source; the gate fails closed with a named code otherwise.
 */
export const MUTANTS = [
  {
    id: 'M1',
    title: 'eight-surfaces provenance expansion deleted (R1-M1)',
    targetDefect:
      'The mount base must forward host-side provenance (origin/guidance/role/allowAdvice) to every seam; dropping the expansion silently strips provenance from all eight surfaces.',
    file: 'src/cordis-seams/eight-surfaces.ts',
    anchor: 'mountSurface() `base` object: the four conditional provenance spreads',
    edits: [
      {
        label: 'delete the four provenance spreads from the mount base',
        find: [
          '  const base = {',
          '    surfaceId,',
          '    branchId: context.branchId,',
          '    sessionId: context.sessionId,',
          '    namespace: context.namespace,',
          '    ...(context.origin !== undefined ? { origin: context.origin } : {}),',
          '    ...(context.guidance !== undefined ? { guidance: context.guidance } : {}),',
          '    ...(context.role !== undefined ? { role: context.role } : {}),',
          '    ...(context.allowAdvice !== undefined ? { allowAdvice: context.allowAdvice } : {})',
          '  };'
        ].join('\n'),
        replace: [
          '  const base = {',
          '    surfaceId,',
          '    branchId: context.branchId,',
          '    sessionId: context.sessionId,',
          '    namespace: context.namespace',
          '  };',
          '  // MUTATION M1 (ADR 0005 D5, R1-M1; temp copy only): the four provenance',
          '  // spreads (origin/guidance/role/allowAdvice) are deleted, so the mount',
          '  // base silently loses host-side provenance.'
        ].join('\n')
      }
    ],
    testFiles: ['tests/e2e/provenance-chain.test.ts'],
    mustRed: [
      {
        file: 'tests/e2e/provenance-chain.test.ts',
        title:
          'scenario 1: neutral branch name + invariant provenance gets no advice and no memory sample, execution passes through'
      },
      {
        file: 'tests/e2e/provenance-chain.test.ts',
        title:
          'scenario 2: the same branchId flips with provenance - invariant phase gets nothing, domain phase gets advice and correctly-attributed experience, with full dispose between'
      },
      {
        file: 'tests/e2e/provenance-chain.test.ts',
        title:
          'scenario 5: multiple surfaces on one branch mount and release without cross-surface residue or scope bleed'
      },
      {
        file: 'tests/e2e/provenance-chain.test.ts',
        title:
          'scenario 6: a non-prompt surface (guardrails) carries provenance through the shared mount base into the registry and the advisor gate'
      }
    ]
  },
  {
    id: 'M2',
    title: 'collector unknown-scope rejection deleted (R1-M2)',
    targetDefect:
      'Unproven branches and identity-free observations must fail closed (never become a learnable bucket); deleting the rejection lets unknown scopes write experience records.',
    file: 'src/jitrl/host-tool-experience.ts',
    anchor: 'observeToolCall() `if (!scopeInfo.isKnown)` fail-closed rejection block',
    edits: [
      {
        label: 'delete the unknown-scope fail-closed block in observeToolCall',
        find: [
          '      if (!scopeInfo.isKnown) {',
          "        const rawBranch = typeof observation.branchId === 'string' ? observation.branchId.trim() : '';",
          '        if (rawBranch.length > 0) {',
          "          note('host-tool observation skipped: unproven branch scope is prohibited from collection');",
          '          return;',
          '        }',
          '        scopeUnknownSkipped += 1;',
          '        note(',
          "          'scope_unknown_skipped: ' +",
          '            String(scopeUnknownSkipped) +',
          "            ' (identity-free host-tool observation not collected; no payload stored)'",
          '        );',
          '        return;',
          '      }'
        ].join('\n'),
        replace: [
          '      // MUTATION M2 (ADR 0005 D5, R1-M2; temp copy only): the D1 fail-closed',
          '      // rejection of an unknown scope is removed, so unproven/identity-free',
          '      // observations fall through into a learnable bucket.'
        ].join('\n')
      }
    ],
    testFiles: ['tests/e2e/provenance-chain.test.ts', 'tests/unit/jitrl/host-tool-experience.test.ts'],
    mustRed: [
      {
        file: 'tests/e2e/provenance-chain.test.ts',
        title:
          'scenario 4: unregistered branch, anonymous {name:bash} and sessionId-only dispatches degrade per D1 while execution passes through'
      },
      {
        file: 'tests/unit/jitrl/host-tool-experience.test.ts',
        title: 'D1 strict default: unproven branches and identity-free observations stay out of every learnable track'
      },
      {
        file: 'tests/unit/jitrl/host-tool-experience.test.ts',
        title: 'D1: trusted registry registration is what re-enables learning for a scope'
      }
    ]
  },
  {
    id: 'M3',
    title: 'winner private yardstick restored (R3-M1)',
    targetDefect:
      'One RewardContract, one yardstick: the composer winner must NOT get its step-evaluator mean as the primary target; restoring that fork re-splits the scale.',
    file: 'src/orchestrator.ts',
    anchor: 'recordOnlineExperience() unified primary-target assignment inside the eligible branch',
    edits: [
      {
        label: 'restore the winner -> winnerRewards mean fork for reward/observedReturn',
        find: [
          '        reward = clamp(evaluation.reward, -3, 3);',
          '        observedReturn = clamp(evaluation.reward, -3, 3);'
        ].join('\n'),
        replace: [
          '        // MUTATION M3 (ADR 0005 D5, R3-M1; temp copy only): the pre-P6.1-D',
          '        // private yardstick is restored - the winner takes the step-evaluator',
          '        // mean while non-winners keep scoreUnderRewardContract.',
          '        const mutatedWinnerYardstick = winnerStepSummary(winnerRewards);',
          '        reward = clamp(isWinner ? mutatedWinnerYardstick : evaluation.reward, -3, 3);',
          '        observedReturn = clamp(isWinner ? mutatedWinnerYardstick : evaluation.reward, -3, 3);'
        ].join('\n')
      }
    ],
    testFiles: ['tests/unit/orchestrator/credit-attribution.test.ts'],
    mustRed: [
      {
        file: 'tests/unit/orchestrator/credit-attribution.test.ts',
        title:
          '① the same trajectory scores the same primary target whether or not it is the composer winner'
      },
      {
        file: 'tests/unit/orchestrator/credit-attribution.test.ts',
        title: '② a missing or failed judge leaves the rewardVersion semantics unchanged'
      }
    ]
  },
  {
    id: 'M4',
    title: 'readLearningTarget gain-first (R3-M2)',
    targetDefect:
      'The contract default consumption field is observedReturn (return only as the legacy fallback, never the gain field); preferring learningTarget is the ablation arm.',
    file: 'src/jitrl/reward-contract.ts',
    anchor: 'readLearningTarget(): observedReturn-first field selection',
    edits: [
      {
        label: 'make readLearningTarget prefer learningTarget over observedReturn',
        find: [
          'export function readLearningTarget(record: ExperienceRecord): number {',
          "  if (typeof record.observedReturn === 'number' && Number.isFinite(record.observedReturn)) {",
          '    return record.observedReturn;',
          '  }',
          '  return Number.isFinite(record.return) ? record.return : Number.NaN;',
          '}'
        ].join('\n'),
        replace: [
          'export function readLearningTarget(record: ExperienceRecord): number {',
          '  // MUTATION M4 (ADR 0005 D5, R3-M2; temp copy only): gain-first selection.',
          "  if (typeof record.learningTarget === 'number' && Number.isFinite(record.learningTarget)) {",
          '    return record.learningTarget;',
          '  }',
          "  if (typeof record.observedReturn === 'number' && Number.isFinite(record.observedReturn)) {",
          '    return record.observedReturn;',
          '  }',
          '  return Number.isFinite(record.return) ? record.return : Number.NaN;',
          '}'
        ].join('\n')
      }
    ],
    testFiles: ['tests/unit/jitrl/value-estimator.test.ts'],
    mustRed: [
      {
        file: 'tests/unit/jitrl/value-estimator.test.ts',
        title: 'reads observedReturn first, falls back to return only for legacy records'
      },
      {
        file: 'tests/unit/jitrl/value-estimator.test.ts',
        title: 'estimateStateValue averages the contract target, not the gain field'
      }
    ]
  }
];

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests; no I/O, no spawning).
// ---------------------------------------------------------------------------

/** sha256 of a string (utf8) or Buffer, lowercase hex. */
export function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** 'lf' | 'crlf' | 'mixed' - which line-ending form a text uses. */
export function eolOf(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length;
  if (crlf === 0) return 'lf';
  if (crlf === lf) return 'crlf';
  return 'mixed';
}

/**
 * Candidate spellings of an authored (LF) anchor for a given file text: the
 * repository declares `text eol=lf`, but a Windows checkout can legitimately
 * hold CRLF worktree bytes (git normalises on compare), so an anchor must
 * match in the form the file actually uses. Anchors never contain lone CR.
 */
function anchorVariants(block) {
  const variants = [block];
  if (!block.includes('\r\n')) variants.push(block.replace(/\n/g, '\r\n'));
  const deduped = [];
  for (const variant of variants) {
    if (!deduped.includes(variant)) deduped.push(variant);
  }
  return deduped;
}

function toEolForm(block, useCrlf) {
  if (useCrlf) return block.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  return block.replace(/\r\n/g, '\n');
}

/**
 * Apply ONE edit to a text. The `find` block must occur EXACTLY once (in the
 * file's own EOL form); split/join is used instead of String#replace so `$`
 * sequences inside code are never interpreted as replacement patterns.
 *
 * @returns {{code: 'applied'|'anchor-not-found'|'anchor-ambiguous'|'mutation-inert',
 *            content: string, occurrences: number, eolForm: 'lf'|'crlf'}}
 */
export function applyEdit(text, edit) {
  if (edit.find === edit.replace) {
    return { code: 'mutation-inert', content: text, occurrences: 0, eolForm: 'lf' };
  }
  for (const candidate of anchorVariants(edit.find)) {
    const occurrences = candidate.length === 0 ? 0 : text.split(candidate).length - 1;
    if (occurrences === 1) {
      const useCrlf = candidate.includes('\r\n');
      const replacement = toEolForm(edit.replace, useCrlf);
      return {
        code: 'applied',
        content: text.split(candidate).join(replacement),
        occurrences: 1,
        eolForm: useCrlf ? 'crlf' : 'lf'
      };
    }
    if (occurrences > 1) {
      return { code: 'anchor-ambiguous', content: text, occurrences, eolForm: 'lf' };
    }
  }
  return { code: 'anchor-not-found', content: text, occurrences: 0, eolForm: 'lf' };
}

/**
 * Apply every edit of a mutant. All edits must land; the first failure names
 * its edit label. Single-edit mutants only (each M1..M4 has exactly one), so
 * the reverse application (swap find/replace) restores the pristine bytes.
 *
 * @returns {{ok: boolean, code: 'ok'|string, content: string,
 *            failures: {label: string, code: string}[]}}
 */
export function applyMutation(text, mutant) {
  let content = text;
  const failures = [];
  for (const edit of mutant.edits) {
    const result = applyEdit(content, edit);
    if (result.code !== 'applied') {
      failures.push({ label: edit.label, code: result.code });
      return { ok: false, code: result.code, content, failures };
    }
    content = result.content;
  }
  return { ok: true, code: 'ok', content, failures };
}

/**
 * Path safety: a mutant may only name repo-relative POSIX paths under the
 * allowed roots. Rejects absolute paths, drive letters, `..` segments,
 * node_modules, empty strings and anything outside GATE_MUTATION_ROOTS.
 */
export function isSafeGatePath(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const posix = candidate.split('\\').join('/');
  if (posix.startsWith('/') || /^[A-Za-z]:/.test(posix)) return false;
  if (posix.startsWith('~')) return false;
  const segments = posix.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return false;
  if (segments.includes('node_modules')) return false;
  const withSlash = posix + '/';
  return GATE_MUTATION_ROOTS.some((root) => withSlash.startsWith(root));
}

/** Validate a whole mutant spec; returns named problems (empty when valid). */
export function validateMutantSpec(mutant) {
  const problems = [];
  if (!mutant || typeof mutant !== 'object') return ['mutant is not an object'];
  if (!/^(M[1-9][0-9]*)$/.test(mutant.id)) problems.push('id must look like M<number>: ' + String(mutant.id));
  if (typeof mutant.title !== 'string' || mutant.title.length === 0) problems.push(mutant.id + ': missing title');
  if (!isSafeGatePath(mutant.file)) problems.push(mutant.id + ': target file outside gate roots: ' + String(mutant.file));
  if (!Array.isArray(mutant.edits) || mutant.edits.length === 0) problems.push(mutant.id + ': no edits');
  for (const edit of (mutant.edits ?? [])) {
    if (typeof edit.find !== 'string' || edit.find.length === 0) problems.push(mutant.id + ': empty find block');
    if (typeof edit.replace !== 'string') problems.push(mutant.id + ': replace block is not a string');
    if (edit.find === edit.replace) problems.push(mutant.id + ': inert edit (find === replace)');
  }
  if (!Array.isArray(mutant.testFiles) || mutant.testFiles.length === 0) problems.push(mutant.id + ': no test files');
  for (const file of (mutant.testFiles ?? [])) {
    if (!isSafeGatePath(file)) problems.push(mutant.id + ': test file outside gate roots: ' + String(file));
  }
  if (!Array.isArray(mutant.mustRed) || mutant.mustRed.length === 0) problems.push(mutant.id + ': empty mustRed set');
  const seen = new Set();
  for (const entry of (mutant.mustRed ?? [])) {
    if (!isSafeGatePath(entry.file)) problems.push(mutant.id + ': mustRed file outside gate roots: ' + String(entry.file));
    if (typeof entry.title !== 'string' || entry.title.length === 0) problems.push(mutant.id + ': mustRed entry without title');
    const key = entry.file + ' :: ' + entry.title;
    if (seen.has(key)) problems.push(mutant.id + ': duplicate mustRed entry ' + key);
    seen.add(key);
    if (!(mutant.testFiles ?? []).includes(entry.file)) {
      problems.push(mutant.id + ': mustRed names a file the mutant never runs: ' + entry.file);
    }
  }
  return problems;
}

/** Identity of one red test, stable across the report. */
function redKey(file, title) {
  return file + ' :: ' + title;
}

function toPosix(p) {
  return p.split('\\').join('/');
}

/**
 * Extract the red (status !== 'passed') assertion results from a vitest JSON
 * report produced inside `copyDir`. The file identity is the repo-relative
 * POSIX path (the report names are absolute paths inside the copy).
 *
 * Only `failed` counts as red: skipped/pending/todo are observations, never
 * kills, so a mutant cannot be "proven dead" by a skipped test.
 *
 * @returns {{red: {file: string, title: string, ancestorTitles: string[], status: string}[],
 *            fileErrors: {file: string, message: string}[]}}
 */
export function collectRedTests(report, copyDir) {
  const red = [];
  const fileErrors = [];
  if (!report || typeof report !== 'object' || !Array.isArray(report.testResults)) {
    return { red, fileErrors };
  }
  const copyPosix = toPosix(copyDir);
  for (const suite of report.testResults) {
    const absolute = toPosix(String(suite.name ?? ''));
    let relative = absolute;
    if (copyPosix && absolute.startsWith(copyPosix + '/')) {
      relative = absolute.slice(copyPosix.length + 1);
    }
    const assertions = Array.isArray(suite.assertionResults) ? suite.assertionResults : [];
    let sawAssertion = false;
    for (const assertion of assertions) {
      sawAssertion = true;
      if (assertion.status === 'failed') {
        red.push({
          file: relative,
          title: String(assertion.title ?? ''),
          ancestorTitles: Array.isArray(assertion.ancestorTitles) ? assertion.ancestorTitles.map(String) : [],
          status: 'failed'
        });
      }
    }
    if (!sawAssertion && suite.status === 'failed') {
      fileErrors.push({ file: relative, message: String(suite.message ?? 'suite failed without assertion results') });
    }
  }
  return { red, fileErrors };
}

/**
 * The gate judgement: mustRed set ⊆ actual red set (by test NAME). Extra reds
 * are recorded (and reported to t16 as the observed count) but never fail the
 * gate - that is the deliberate ADR 0005 §5.1-1 semantics.
 */
export function judgeMustRed(mutant, redTests) {
  const redKeys = new Set(redTests.map((entry) => redKey(entry.file, entry.title)));
  const hit = [];
  const missing = [];
  for (const entry of mutant.mustRed) {
    if (redKeys.has(redKey(entry.file, entry.title))) hit.push(entry);
    else missing.push(entry);
  }
  const hitKeys = new Set(hit.map((entry) => redKey(entry.file, entry.title)));
  const extraRed = redTests.filter((entry) => !hitKeys.has(redKey(entry.file, entry.title)));
  return {
    ok: missing.length === 0,
    missing,
    hit,
    extraRed,
    redCount: redTests.length,
    mustRedCount: mutant.mustRed.length,
    hitCount: hit.length
  };
}

/**
 * Baseline judgement for one target-test run on the UNMUTATED copy: every
 * collected test must pass. A skipped/pending test is reported as an
 * observation (it is not red), but zero collected tests is a failure - the
 * gate refuses to declare a mutant killed by tests that never ran.
 */
export function judgeBaselineReport(report) {
  if (!report || typeof report !== 'object') {
    return { ok: false, code: 'report-missing', numTotalTests: 0, numFailedTests: 0, numPendingTests: 0 };
  }
  const numTotalTests = Number(report.numTotalTests ?? 0);
  const numFailedTests = Number(report.numFailedTests ?? 0);
  const numPendingTests = Number(report.numPendingTests ?? 0);
  if (numFailedTests > 0) {
    return { ok: false, code: 'baseline-not-green', numTotalTests, numFailedTests, numPendingTests };
  }
  if (!(numTotalTests > 0)) {
    return { ok: false, code: 'baseline-no-tests-collected', numTotalTests, numFailedTests, numPendingTests };
  }
  return { ok: true, code: 'ok', numTotalTests, numFailedTests, numPendingTests };
}

// ---------------------------------------------------------------------------
// Runner (--run / --validate). Everything below does I/O or spawns.
// ---------------------------------------------------------------------------

function repoPath(...segments) {
  return path.join(REPO_ROOT, ...segments);
}

function readPristine(file) {
  return fs.readFileSync(repoPath(file));
}

function runVitestInCopy(copyDir, testFiles, reportPath, logPath) {
  const vitestCli = repoPath('node_modules', 'vitest', 'vitest.mjs');
  if (!fs.existsSync(vitestCli)) {
    return { status: -1, error: 'vitest-binary-missing', report: null };
  }
  const out = fs.openSync(logPath, 'w');
  try {
    const result = spawnSync(
      process.execPath,
      [
        vitestCli,
        'run',
        ...testFiles,
        '--reporter=default',
        '--reporter=json',
        '--outputFile=' + reportPath
      ],
      { cwd: copyDir, stdio: ['ignore', out, out], env: { ...process.env } }
    );
    return { status: result.status, error: result.error ? String(result.error) : null, report: null };
  } finally {
    fs.closeSync(out);
  }
}

function readReport(reportPath) {
  if (!fs.existsSync(reportPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch {
    return null;
  }
}

function linkNodeModules(copyDir) {
  const target = repoPath('node_modules');
  const link = path.join(copyDir, 'node_modules');
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    fs.symlinkSync(target, link, type);
    return { ok: true, mode: type };
  } catch (error) {
    // Windows without privilege for junction is effectively unheard of, but a
    // Linux runner may forbid symlinks in tmp: fall back to linking each
    // top-level entry individually (pnpm keeps that list small).
    try {
      fs.mkdirSync(link, { recursive: true });
      for (const entry of fs.readdirSync(target)) {
        fs.symlinkSync(path.join(target, entry), path.join(link, entry), type);
      }
      return { ok: true, mode: type + '-per-entry' };
    } catch (fallbackError) {
      return { ok: false, error: String(fallbackError?.message ?? fallbackError), first: String(error?.message ?? error) };
    }
  }
}

function copyTree(source, destination) {
  fs.cpSync(source, destination, { recursive: true, verbatimSymlinks: false });
}

function removeCopy(copyDir) {
  try {
    fs.rmSync(copyDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    /* reported by the caller via existsSync */
  }
  return !fs.existsSync(copyDir);
}

/**
 * Anchor-only validation: every mutant's find block must match its pristine
 * repository source exactly once. Reads files only; never mutates anything.
 */
export function validateAnchors() {
  const problems = [];
  for (const mutant of MUTANTS) {
    problems.push(...validateMutantSpec(mutant).map((problem) => mutant.id + ': ' + problem));
    if (!isSafeGatePath(mutant.file)) continue;
    if (!fs.existsSync(repoPath(mutant.file))) {
      problems.push(mutant.id + ': source file missing: ' + mutant.file);
      continue;
    }
    const pristine = readPristine(mutant.file).toString('utf8');
    for (const edit of mutant.edits) {
      const result = applyEdit(pristine, edit);
      if (result.code !== 'applied') {
        problems.push(mutant.id + ': ' + edit.label + ' -> ' + result.code);
        continue;
      }
      // The mutated text must no longer contain the anchor (the mutation is
      // not a no-op that could be applied twice), and reversing it restores
      // the pristine bytes byte-for-byte.
      const second = applyEdit(result.content, edit);
      if (second.code !== 'anchor-not-found') {
        problems.push(mutant.id + ': anchor still present after mutation (' + second.code + ')');
      }
      const reverse = applyMutation(result.content, {
        ...mutant,
        edits: mutant.edits.map((entry) => ({ label: entry.label + ' (reverse)', find: entry.replace, replace: entry.find }))
      });
      if (!reverse.ok || reverse.content !== pristine) {
        problems.push(mutant.id + ': reverse mutation does not restore pristine bytes');
      }
    }
    for (const file of mutant.testFiles) {
      if (!fs.existsSync(repoPath(file))) problems.push(mutant.id + ': test file missing: ' + file);
    }
    for (const entry of mutant.mustRed) {
      if (!fs.existsSync(repoPath(entry.file))) problems.push(mutant.id + ': mustRed test file missing: ' + entry.file);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Full gate run. Options: only (mutant ids), keepTmp (debug), out (write the
 * JSON report to a file; the exit code stays the verdict).
 */
export async function runMutationGate(options = {}) {
  const only = options.only ?? null;
  const keepTmp = options.keepTmp === true;
  const outPath = typeof options.out === 'string' && options.out.length > 0 ? options.out : null;

  const selected = only ? MUTANTS.filter((mutant) => only.includes(mutant.id)) : [...MUTANTS];
  const unknown = only ? only.filter((id) => !MUTANTS.some((mutant) => mutant.id === id)) : [];
  const report = {
    gate: GATE_ID,
    at: new Date().toISOString(),
    node: process.version,
    platform: process.platform + '/' + process.arch,
    repoRoot: REPO_ROOT,
    worktreeWitness: null,
    copy: null,
    mutants: [],
    fatal: null,
    ok: false
  };

  if (unknown.length > 0) {
    report.fatal = { code: 'unknown-mutant', detail: unknown.join(', ') };
    finish(report, outPath);
    return report;
  }

  // ---- 1. snapshot the repository's target files (the zero-residue witness)
  const pristineFiles = new Map();
  const worktreeBefore = new Map();
  try {
    for (const mutant of selected) {
      if (!isSafeGatePath(mutant.file)) {
        report.fatal = { code: 'unsafe-mutant-path', detail: mutant.file };
        break;
      }
      if (!fs.existsSync(repoPath(mutant.file))) {
        report.fatal = { code: 'source-file-missing', detail: mutant.file };
        break;
      }
      if (!pristineFiles.has(mutant.file)) {
        const bytes = readPristine(mutant.file);
        pristineFiles.set(mutant.file, bytes);
        worktreeBefore.set(mutant.file, sha256Hex(bytes));
      }
      for (const file of mutant.testFiles) {
        if (!fs.existsSync(repoPath(file))) {
          report.fatal = { code: 'test-file-missing', detail: file };
          break;
        }
      }
      if (report.fatal) break;
    }
  } catch (error) {
    report.fatal = { code: 'snapshot-failed', detail: String(error?.message ?? error) };
  }

  let copyDir = null;
  if (!report.fatal) {
    // ---- 2. build the throwaway copy
    copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-gate-'));
    try {
      for (const entry of COPY_ENTRIES) {
        const source = repoPath(entry);
        if (!fs.existsSync(source)) {
          report.fatal = { code: 'copy-entry-missing', detail: entry };
          break;
        }
        const destination = path.join(copyDir, entry);
        if (fs.statSync(source).isDirectory()) copyTree(source, destination);
        else fs.copyFileSync(source, destination);
      }
      if (!report.fatal) {
        const link = linkNodeModules(copyDir);
        if (!link.ok) {
          report.fatal = { code: 'node-modules-link-failed', detail: link.first + ' / ' + link.error };
        } else {
          report.copy = { mode: link.mode, entries: [...COPY_ENTRIES] };
        }
      }
    } catch (error) {
      report.fatal = { code: 'copy-failed', detail: String(error?.message ?? error) };
    }
  }

  // ---- 3. per mutant: baseline -> mutate -> run -> judge -> restore
  if (!report.fatal) {
    for (const mutant of selected) {
      const record = {
        id: mutant.id,
        title: mutant.title,
        file: mutant.file,
        anchor: mutant.anchor,
        sha256: { pristine: worktreeBefore.get(mutant.file), mutatedCopy: null, changed: false },
        baseline: null,
        mutantRun: null,
        judgement: null,
        ok: false,
        failure: null
      };
      report.mutants.push(record);
      const copyTarget = path.join(copyDir, ...mutant.file.split('/'));
      try {
        // 3a. fresh pristine bytes in the copy (no cross-mutant residue)
        fs.writeFileSync(copyTarget, pristineFiles.get(mutant.file));

        // 3b. baseline on the SAME copy must be green
        const baselineResult = runMutantPhase(copyDir, mutant, 'baseline');
        record.baseline = baselineResult.summary;
        if (!baselineResult.summary.ok) {
          record.failure = { code: baselineResult.summary.code, detail: 'baseline on the unmutated copy is not green' };
          continue;
        }

        // 3c. apply the mutation INSIDE THE COPY and prove it landed
        const beforeText = fs.readFileSync(copyTarget, 'utf8');
        const mutated = applyMutation(beforeText, mutant);
        if (!mutated.ok) {
          record.failure = { code: mutated.code, detail: mutated.failures.map((f) => f.label + ' -> ' + f.code).join('; ') };
          continue;
        }
        fs.writeFileSync(copyTarget, mutated.content);
        const mutatedSha = sha256Hex(fs.readFileSync(copyTarget));
        record.sha256.mutatedCopy = mutatedSha;
        record.sha256.changed = mutatedSha !== record.sha256.pristine;
        if (!record.sha256.changed) {
          record.failure = { code: 'mutation-did-not-change-sha', detail: 'target file sha256 unchanged after mutation' };
          continue;
        }

        // 3d. run the target tests against the mutant
        const mutantResult = runMutantPhase(copyDir, mutant, 'mutant');
        record.mutantRun = mutantResult.summary;
        if (mutantResult.summary.code === 'vitest-report-missing' || mutantResult.summary.code === 'vitest-binary-missing') {
          record.failure = { code: mutantResult.summary.code, detail: 'vitest did not produce a usable report' };
          continue;
        }

        // 3e. judge: mustRed (by name) ⊆ actual red set
        const judgement = judgeMustRed(mutant, mutantResult.red);
        record.judgement = {
          ok: judgement.ok,
          mustRedCount: judgement.mustRedCount,
          hitCount: judgement.hitCount,
          redCount: judgement.redCount,
          observedRedCount: judgement.redCount,
          missing: judgement.missing.map((entry) => entry.file + ' :: ' + entry.title),
          extraRed: judgement.extraRed.map((entry) => entry.file + ' :: ' + entry.title),
          redTests: mutantResult.red.map((entry) => entry.file + ' :: ' + entry.title)
        };
        if (!judgement.ok) {
          record.failure = { code: 'must-red-not-satisfied', detail: 'missing: ' + record.judgement.missing.join(' | ') };
          continue;
        }

        // 3f. restore the pristine bytes in the copy (restore semantics witness)
        fs.writeFileSync(copyTarget, pristineFiles.get(mutant.file));
        const restoredSha = sha256Hex(fs.readFileSync(copyTarget));
        if (restoredSha !== record.sha256.pristine) {
          record.failure = { code: 'restore-mismatch', detail: 'copy not restored to pristine bytes' };
          continue;
        }
        record.ok = true;
      } catch (error) {
        record.failure = { code: 'mutant-run-crashed', detail: String(error?.stack ?? error) };
      }
    }
  }

  // ---- 4. cleanup + zero-residue assertion (always runs)
  if (copyDir !== null) {
    if (keepTmp) {
      report.copy = { ...(report.copy ?? {}), kept: true, path: copyDir };
    } else {
      const removed = removeCopy(copyDir);
      report.copy = { ...(report.copy ?? {}), removed, path: null };
      if (!removed) report.fatal = { code: 'copy-cleanup-failed', detail: copyDir };
    }
  }
  const worktreeAfter = new Map();
  for (const [file] of worktreeBefore) {
    try {
      worktreeAfter.set(file, sha256Hex(readPristine(file)));
    } catch (error) {
      worktreeAfter.set(file, 'unreadable: ' + String(error?.message ?? error));
    }
  }
  const unchanged = [...worktreeBefore.entries()].every(
    ([file, sha]) => worktreeAfter.get(file) === sha
  );
  report.worktreeWitness = {
    unchanged,
    files: [...worktreeBefore.entries()].map(([file, before]) => ({
      file,
      sha256Before: before,
      sha256After: worktreeAfter.get(file)
    }))
  };
  if (!unchanged && report.fatal === null) {
    report.fatal = { code: 'worktree-mutated', detail: 'repository target files changed during the gate run' };
  }

  report.ok = report.fatal === null && report.mutants.length > 0 && report.mutants.every((record) => record.ok);
  finish(report, outPath);
  return report;
}

/** One vitest phase (baseline or mutant) for one mutant's target tests. */
function runMutantPhase(copyDir, mutant, phase) {
  const reportPath = path.join(copyDir, 'gate-' + mutant.id + '-' + phase + '.json');
  const logPath = path.join(copyDir, 'gate-' + mutant.id + '-' + phase + '.log');
  const result = runVitestInCopy(copyDir, mutant.testFiles, reportPath, logPath);
  if (result.error === 'vitest-binary-missing') {
    return { red: [], fileErrors: [], summary: { ok: false, code: 'vitest-binary-missing', numTotalTests: 0, numFailedTests: 0, numPendingTests: 0, exitCode: -1 } };
  }
  const parsed = readReport(reportPath);
  if (parsed === null) {
    return { red: [], fileErrors: [], summary: { ok: false, code: 'vitest-report-missing', numTotalTests: 0, numFailedTests: 0, numPendingTests: 0, exitCode: result.status } };
  }
  const { red, fileErrors } = collectRedTests(parsed, copyDir);
  const baseline = judgeBaselineReport(parsed);
  return {
    red,
    fileErrors,
    summary: {
      ok: baseline.ok,
      code: baseline.code,
      numTotalTests: baseline.numTotalTests,
      numFailedTests: baseline.numFailedTests,
      numPendingTests: baseline.numPendingTests,
      exitCode: result.status
    }
  };
}

function finish(report, outPath) {
  if (outPath) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    } catch (error) {
      report.fatal = report.fatal ?? { code: 'report-write-failed', detail: String(error?.message ?? error) };
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printHuman(report) {
  const lines = [];
  lines.push('mutation gate ' + GATE_ID + '  node=' + report.node + '  platform=' + report.platform);
  if (report.fatal) {
    lines.push('FATAL ' + report.fatal.code + ': ' + (report.fatal.detail ?? ''));
  }
  for (const record of report.mutants) {
    const verdict = record.ok ? 'KILLED' : 'NOT KILLED';
    const baseline = record.baseline ? 'baseline=' + record.baseline.code + '(' + record.baseline.numTotalTests + ' tests)' : 'baseline=n/a';
    const sha = record.sha256 && record.sha256.changed ? 'sha changed' : 'sha unchanged';
    const reds = record.judgement ? 'red=' + record.judgement.redCount + '/' + record.judgement.mustRedCount + ' must-red hit' : '';
    lines.push('  [' + record.id + '] ' + verdict + '  ' + baseline + '  ' + sha + (reds ? '  ' + reds : ''));
    if (record.failure) lines.push('        failure: ' + record.failure.code + ' — ' + (record.failure.detail ?? ''));
    if (record.judgement) {
      for (const missing of record.judgement.missing) lines.push('        missing red: ' + missing);
      for (const extra of record.judgement.extraRed) lines.push('        extra red (observed, non-fatal): ' + extra);
    }
  }
  const witness = report.worktreeWitness;
  if (witness) {
    lines.push(
      'worktree zero-residue: ' + (witness.unchanged ? 'OK (target files unchanged)' : 'VIOLATED') +
        '  copy removed: ' + String(report.copy?.removed ?? (report.copy?.kept === true ? 'kept(--keep-tmp)' : 'n/a'))
    );
  }
  lines.push('verdict: ' + (report.ok ? 'PASS' : 'FAIL'));
  return lines.join('\n');
}

const isDirectExecution = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectExecution) {
  const args = process.argv.slice(2);
  const flags = { json: false, run: false, validate: false, list: false, keepTmp: false, help: false, only: null, out: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') flags.json = true;
    else if (arg === '--run') flags.run = true;
    else if (arg === '--validate') flags.validate = true;
    else if (arg === '--list') flags.list = true;
    else if (arg === '--keep-tmp') flags.keepTmp = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--only') {
      index += 1;
      flags.only = (args[index] ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    } else if (arg === '--out') {
      index += 1;
      flags.out = args[index] ?? null;
    } else {
      console.error('unknown argument: ' + arg);
      flags.help = true;
      process.exitCode = 1;
    }
  }

  if (flags.help) {
    console.log(
      [
        'Usage:',
        '  node scripts/eval/mutation-gate.mjs --run [--json] [--only M1,M2] [--keep-tmp] [--out <file>]',
        '  node scripts/eval/mutation-gate.mjs --validate [--json]',
        '  node scripts/eval/mutation-gate.mjs --list',
        '',
        'Mutants: ' + MUTANTS.map((mutant) => mutant.id).join(', ')
      ].join('\n')
    );
  } else if (flags.list) {
    for (const mutant of MUTANTS) {
      console.log(mutant.id + '  ' + mutant.title);
      console.log('    file: ' + mutant.file);
      console.log('    anchor: ' + mutant.anchor);
      console.log('    tests: ' + mutant.testFiles.join(', '));
      console.log('    must-red (' + mutant.mustRed.length + '):');
      for (const entry of mutant.mustRed) console.log('      - ' + entry.file + ' :: ' + entry.title);
    }
  } else if (flags.validate) {
    const validation = validateAnchors();
    if (flags.json) {
      console.log(JSON.stringify({ gate: GATE_ID, mode: 'validate', ...validation }, null, 2));
    } else {
      for (const problem of validation.problems) console.log('PROBLEM: ' + problem);
      console.log('anchors: ' + (validation.ok ? 'all 4 mutants resolve against pristine sources' : 'INVALID'));
    }
    process.exitCode = validation.ok ? 0 : 1;
  } else if (flags.run) {
    runMutationGate({ only: flags.only, keepTmp: flags.keepTmp, out: flags.out }).then((report) => {
      if (flags.json) console.log(JSON.stringify(report, null, 2));
      else console.log(printHuman(report));
      process.exitCode = report.ok ? 0 : 1;
    });
  } else {
    console.error('nothing to do: pass --run (full gate), --validate (anchors only) or --list');
    process.exitCode = 1;
  }
}
