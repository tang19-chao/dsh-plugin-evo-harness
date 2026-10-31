/**
 * rev6 R0-3 (captain ruling D-1): the C-4 terminology replacement, discriminated.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT A DUPLICATE
 * --------------------------------------------------
 * `docs-correction-pointers.test.ts` guards the *register* and the *pin*; it
 * deliberately does not read ADR 0002 / execution-profile.ts (rev5's C-4 was
 * registered-but-not-applied, and the register had to keep saying so). rev6 R0-3
 * applies the two replacement lines, so three new facts need a machine guard:
 *
 *   1. LIVE WIRING: ADR 0002:51 and `execution-profile.ts:121` carry the
 *      strict-improvement wording. Before R0-3 the operative phrase was
 *      `holdout 非劣证据` / `holdout non-inferiority +`; asserting those are ABSENT
 *      from the *criterion position* is the discrimination, not merely that the
 *      new words appear (a doc could contain both).
 *   2. VERBATIM PROVENANCE: the replacement text was not invented here. The two
 *      live lines must equal, byte for byte, the lines published in ADR 0007
 *      §4.1/§4.2 — the pinned register stays the single source of the wording.
 *   3. NON-WEAKENING (contract §11.1 item 3): applying (a) "the register is
 *      marked applied" must NOT be paid for by weakening (b) "ADR 0007 is still
 *      the original pin and §4 still carries the paste-ready replacement lines".
 *      Both are asserted in one file so a future edit cannot trade one for the
 *      other unnoticed.
 *
 * All three edits are one-line surgical changes: each live file must differ from
 * the FROZEN rev5 baseline on exactly one line (51 / 121) and on nothing else.
 * The baseline is the sha256 recorded in `work/t23/snapshot.csv` plus a
 * line-by-line comparison against the pristine `work/t23-clean/` copy, NOT
 * `git diff HEAD` - see `frozenBaselineSha` for why `HEAD` is the wrong axis here.
 *
 * Deliberately NOT asserted here: ADR 0007's own byte digest. That is the pin
 * (`docs-correction-pointers.test.ts:95-98`, `p6-pareto-budget.test.ts`), and a
 * second copy of the constant would be a second thing to keep in sync.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const ADR_0007_REL = 'docs/adr/0007-p6-pareto-budget-terminology-and-hooks.md';
const ADR_0002_REL = 'docs/adr/0002-p62-release-contract-and-default-safe-shape.md';
const PROFILE_REL = 'src/runtime/execution-profile.ts';
const REGISTER_REL = 'docs/reports/p0-evidence-correction.md';

const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const lines = (rel: string) => read(rel).split('\n');

/** The single body line of the fenced block that follows `marker`. */
function fencedBlockAfter(text: string, marker: string, lang: string): string {
  const rows = text.split('\n');
  const at = rows.findIndex((l) => l.trim() === marker);
  expect(at, `marker missing: ${marker}`).toBeGreaterThan(-1);
  // `noUncheckedIndexedAccess` is on: index reads are `string | undefined`, so the
  // walk narrows explicitly instead of asserting the compiler away.
  let i = at + 1;
  let opened = false;
  while (i < rows.length) {
    const row = rows[i];
    if (row === undefined) break;
    if (row.trim() !== '') { opened = row.trim() === '```' + lang; break; }
    i += 1;
  }
  expect(opened, `expected \`\`\`${lang} after ${marker}`).toBe(true);
  i += 1;
  const body: string[] = [];
  while (i < rows.length) {
    const row = rows[i];
    if (row === undefined || row.trim() === '```') break;
    body.push(row);
    i += 1;
  }
  expect(body.length, `${marker} must carry exactly one line`).toBe(1);
  const only = body[0];
  if (only === undefined) throw new Error(`${marker}: empty fenced block`);
  return only;
}

/**
 * The REV5 BASELINE BYTES of a tracked path, read from the object database.
 *
 * MUST NOT use `git diff HEAD` / `git diff --numstat HEAD`: before the rev6
 * commit exists those report worktree-vs-HEAD (`1/1`), and after the commit lands
 * they report `0/0` — a test written against `HEAD` would go permanently red the
 * moment it is committed, i.e. green in exactly the state it exists to police.
 *
 * Nor can `work/t23/snapshot.csv` be used: it records the 73 TESTED paths, and
 * ADR 0002 / execution-profile.ts are not among them (they are rev5 deliverables
 * but not part of that tested set). Reading them from it throws "not one of the
 * recorded rev5 paths".
 *
 * The stable, in-repo axis is the last commit of the rev5 delivery, `97e38db…`
 * (the contract's §1 frozen baseline `HEAD`). Its blobs ARE the bytes R0-3
 * replaced, and that commit does not move when rev6 commits later. `git cat-file`
 * reads the object database, so a checkout's line endings cannot change the
 * answer (the same reason `check:encoding` binds to commits).
 */
const REV5_BASELINE_COMMIT = '97e38db37305b24f695a5f989428b3611f84987c';

function rev5BaselineBytes(rel: string): Buffer {
  try {
    return Buffer.from(
      execFileSync('git', ['cat-file', 'blob', `${REV5_BASELINE_COMMIT}:${rel}`], {
        cwd: repoRoot,
        encoding: 'buffer'
      })
    );
  } catch (error) {
    throw new Error(
      `cannot read the rev5 baseline blob for ${rel} at ${REV5_BASELINE_COMMIT}: ${String(error)}`
    );
  }
}

describe('rev6 R0-3: the C-4 replacement is applied, verbatim and surgically', () => {
  const adr7 = read(ADR_0007_REL);
  const adr2Lines = lines(ADR_0002_REL);
  const profileLines = lines(PROFILE_REL);

  it('ADR 0007 §4 still publishes the paste-ready replacement lines (the source of truth)', () => {
    expect(adr7).toContain('## 4. 文案差异登记与可直接粘贴的替换整行');
    // §4 deliberately names the two drift sites it fixes; a "cleanup" that
    // dropped these outbound pointers would break P-1 -> P-2.
    expect(adr7).toContain('docs/adr/0002-p62-release-contract-and-default-safe-shape.md');
    expect(adr7).toContain('src/runtime/execution-profile.ts');
    expect(adr7).toContain('严格超越');
  });

  it('ADR 0002:51 is byte-identical to the §4.1 replacement line', () => {
    const replacement = fencedBlockAfter(adr7, '替换为（整行）：', 'markdown');
    expect(adr2Lines[50]).toBe(replacement);
  });

  it('execution-profile.ts:121 is byte-identical to the §4.2 replacement line', () => {
    // §4.2 is the SECOND `替换为（整行）：` occurrence in the ADR.
    const rows = adr7.split('\n');
    const firstOriginal = rows.findIndex((l) => l.trim() === '原文（整行）：');
    const secondOriginal = rows.findIndex((l, i) => i > firstOriginal && l.trim() === '原文（整行）：');
    expect(firstOriginal, '§4.1 original block').toBeGreaterThan(-1);
    expect(secondOriginal, '§4.2 original block').toBeGreaterThan(firstOriginal);
    const replacement = fencedBlockAfter(rows.slice(secondOriginal).join('\n'), '替换为（整行）：', 'ts');
    expect(profileLines[120]).toBe(replacement);
  });

  it('the OPERATIVE non-inferiority criterion is gone from both live lines', () => {
    // Not "the words 非劣 / non-inferiority never appear": the replacement lines
    // themselves DISCLOSE the old wording ("原文"非劣"为文案漂移",
    // "the earlier "non-inferiority" wording was drift"). What must be gone is the
    // phrase that USED the old wording as the criterion.
    expect(adr2Lines[50]).not.toContain('holdout 非劣证据');
    expect(profileLines[120]).not.toContain('holdout non-inferiority +');
  });

  it('both live lines state the strict-improvement criterion instead', () => {
    expect(adr2Lines[50]).toContain('holdout **严格超越**');
    expect(profileLines[120]).toContain('holdout STRICT-IMPROVEMENT');
  });

  it('the replacement is surgical: each file differs from the rev5 baseline on one line only', () => {
    // The baseline is the rev5 delivery commit's blob, so this answers the same
    // question before and after rev6 is committed (see rev5BaselineBytes).
    for (const [rel, lineNo] of [
      [ADR_0002_REL, 51],
      [PROFILE_REL, 121]
    ] as const) {
      const baselineLines = rev5BaselineBytes(rel).toString('utf8').split('\n');
      const currentLines = lines(rel);

      // A REPLACED line keeps the line count identical: that is what separates
      // "surgical" from "rewrite". A rewrite (or a wrapping change) moves this.
      expect(currentLines.length, `${rel} line count must be unchanged by a one-line replacement`).toBe(
        baselineLines.length
      );

      // Exactly one line differs, and it is the registered coordinate.
      const differing = currentLines
        .map((line, i) => (line === baselineLines[i] ? null : i + 1))
        .filter((n): n is number => n !== null);
      expect(differing, `${rel} may differ from the rev5 baseline on line ${lineNo} only`).toEqual([lineNo]);

      // And the change is a WIDENING of the criterion, not a deletion: the line
      // got longer (the strict-improvement sentence was substituted in place).
      const before = baselineLines[lineNo - 1] ?? '';
      const after = currentLines[lineNo - 1] ?? '';
      expect(after.length, `${rel}:${lineNo} must be longer (strict-improvement text substituted in)`).toBeGreaterThan(
        before.length
      );
    }
  });

  it('the register no longer claims the drift is unapplied (and keeps its history)', () => {
    const register = read(REGISTER_REL);
    // The live status line.
    expect(register).toMatch(/## C-4[^\n]*已应用/);
    // The old status survives as dated history rather than being deleted, so the
    // register stays an append-only correction log rather than a rewrite.
    expect(register).toContain('状态沿革');
    expect(register).toContain('rev6 R0-3');
  });

  it('the C-4 judgement did not weaken the pin trio it sits next to (non-weakening)', () => {
    // Contract §11.1 item 3: applying (a) must not be paid for by weakening (b).
    // (a) is above. (b): the pin assertions in the pointer suite are still there,
    // unchanged, and still name the pinned digest + the ADR path.
    const pointerSuite = read('tests/unit/p62/docs-correction-pointers.test.ts');
    expect(pointerSuite).toContain('47e67c7dab9ddacaf1d505a7fea6fe9312ee9b38d52ea1097444e37ab089b289');
    expect(pointerSuite).toContain('expect(actual).toBe(PINNED_ADR_SHA256)');
    expect(pointerSuite).toContain('expect(pinTest).toContain(PINNED_ADR_SHA256)');
    // The ADR path is pinned by the pointer suite as a double-quoted literal.
    expect(pointerSuite).toContain(`"\'docs/adr/0007-p6-pareto-budget-terminology-and-hooks.md\'"`);
    // And the pinned file itself still carries the §4 heading the assertion reads.
    expect(adr7).toContain('## 4. 文案差异登记与可直接粘贴的替换整行');
  });
});
