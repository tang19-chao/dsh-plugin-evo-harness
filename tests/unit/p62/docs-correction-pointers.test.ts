/**
 * rev5 P0-6 / P1-4: the doc-drift register's pointers are machine-checked.
 *
 * The captain's ruling (t7 C-1/C-2) is deliberately asymmetric: ADR 0007 is
 * sha256-pinned evidence and may NOT be edited to point back at the new
 * correction register, so the register documents each visible edge AND the one
 * edge that is mechanically forbidden. This test keeps that honesty from
 * decaying:
 *
 *   - the register names ADR 0007 §4, the model-config header, the two H-3
 *     drift sites and the three historical reports it corrects;
 *   - the model-config header names the register and §C-5 (the reverse edge);
 *   - ADR 0007's bytes are still EXACTLY the pinned digest, and its §4 still
 *     contains the outbound references to ADR 0002:51 / execution-profile.ts;
 *   - the pin test still pins the same digest (so a future "fix" cannot quietly
 *     delete the pin and then rewrite the ADR).
 */
import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const correctionPath = path.join(repoRoot, 'docs', 'reports', 'p0-evidence-correction.md');
const adrPath = path.join(repoRoot, 'docs', 'adr', '0007-p6-pareto-budget-terminology-and-hooks.md');
const modelConfigPath = path.join(repoRoot, 'src', 'dsh-bridge', 'model-config.ts');
const pinTestPath = path.join(repoRoot, 'tests', 'unit', 'jitrl', 'p6-pareto-budget.test.ts');

const PINNED_ADR_SHA256 = '47e67c7dab9ddacaf1d505a7fea6fe9312ee9b38d52ea1097444e37ab089b289';

const correction = fs.readFileSync(correctionPath, 'utf8');
const adr = fs.readFileSync(adrPath, 'utf8');
const modelConfig = fs.readFileSync(modelConfigPath, 'utf8');
const pinTest = fs.readFileSync(pinTestPath, 'utf8');

describe('doc-drift register: every correction entry and its source are named', () => {
  it('registers the H-3 entries and their original locations', () => {
    for (const section of ['## C-1', '## C-2', '## C-3', '## C-4', '## C-5']) {
      expect(correction, `missing ${section}`).toContain(section);
    }
    for (const original of [
      'docs/reports/p3-a-assembly.md',
      'docs/reports/p3-b-adapter.md',
      'docs/reports/p2-p6-final-verification.md',
      'docs/adr/0002-p62-release-contract-and-default-safe-shape.md',
      'src/runtime/execution-profile.ts'
    ]) {
      expect(correction, `original location not registered: ${original}`).toContain(original);
    }
    // The H-3 row numbers the register corrects must be present, not paraphrased
    // away: 19/17, 9+21+4=32, 2428/2429.
    expect(correction).toContain('19');
    expect(correction).toContain('17');
    expect(correction).toContain('9 + 21 + 4');
    expect(correction).toContain('34');
    expect(correction).toContain('2428');
    expect(correction).toContain('2429');
  });

  it('records measured evidence with commands and exit codes, not just claims', () => {
    // The register is useless if it says "measured" without naming the command.
    expect(correction).toContain('pnpm exec vitest run tests/unit/dsh-bridge/agent-loop-ledger-assembly.test.ts');
    expect(correction).toContain(
      'pnpm exec vitest run tests/unit/ledger/metering-coverage.test.ts tests/unit/ledger/metered-model-adapter.test.ts tests/unit/ledger/stage-purpose-labels.test.ts'
    );
    expect(correction).toContain('`Tests 20 passed (20)`');
    expect(correction).toContain('`Tests 34 passed (34)`');
    // not-run items must stay visible; C-4 itself is APPLIED as of rev6 R0-3
    // (captain D-1), so the guard is flipped to point the other way: it now
    // catches a register that claims the drift is still unfixed.
    expect(correction).toContain('已应用');
    expect(correction).toContain('not-run');
  });
});

describe('doc-drift register: the writable bidirectional edge (model-config ⇄ register)', () => {
  it('the model-config header names the register and §C-5', () => {
    expect(modelConfig).toContain('DOC-DRIFT REGISTER');
    expect(modelConfig).toContain('docs/reports/p0-evidence-correction.md');
    expect(modelConfig).toContain('§C-5');
    // The forward and reverse edges are spelled out, not implied.
    expect(modelConfig).toContain('forward:');
    expect(modelConfig).toContain('reverse:');
  });

  it('the register names the model-config header range (the reverse direction)', () => {
    expect(correction).toContain('src/dsh-bridge/model-config.ts');
    expect(correction).toContain('§C-5');
    expect(correction).toContain('DOC-DRIFT REGISTER');
    expect(correction).toContain('P-3');
    expect(correction).toContain('P-4');
  });
});

describe('doc-drift register: the pinned ADR edge is frozen, not fabricated', () => {
  it('ADR 0007 bytes are still exactly the pinned digest', () => {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(adrPath)).digest('hex');
    expect(actual).toBe(PINNED_ADR_SHA256);
  });

  it('the pin test still pins the same digest (the pin cannot be deleted to enable a rewrite)', () => {
    expect(pinTest).toContain(PINNED_ADR_SHA256);
    expect(pinTest).toContain("'docs/adr/0007-p6-pareto-budget-terminology-and-hooks.md'");
  });

  it('ADR 0007 §4 keeps its outbound references to both H-3 drift sites', () => {
    // §4 is the paste-ready replacement register; its outbound edges are the
    // evidence that P-1 -> P-2 is a real chain even though P-6 (back-edge from
    // the pinned file) is forbidden.
    expect(adr).toContain('## 4. 文案差异登记与可直接粘贴的替换整行');
    expect(adr).toContain('docs/adr/0002-p62-release-contract-and-default-safe-shape.md');
    expect(adr).toContain('src/runtime/execution-profile.ts');
    expect(adr).toContain('严格超越');
  });

  it('the register documents the forbidden reverse edge instead of pretending it exists', () => {
    expect(correction).toContain('P-6');
    expect(correction).toContain('不可表示的边');
    // And it must not claim the ADR was edited.
    expect(correction).toContain('ADR 0007 一个字节');
  });
});
