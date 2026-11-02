/**
 * rev6 cross-audit CI-2: the docs gate deletes ONLY the reports it produced
 * or consumed.
 *
 * THE DEFECT THIS PINS (measured on the pre-fix cleanup)
 * ------------------------------------------------------
 * `cleanup()` in scripts/verify-readme-counts.mjs deleted the root
 * `test-results.json` whenever it existed, even when this run consumed an
 * explicit `--report <path>` or ran `--docs-only` and therefore never touched
 * the root file. That destroyed an unconsumed - possibly freshly produced,
 * wanted - report, contradicting the header's own cleanup invariant ("A root
 * `test-results.json` that was consumed is deleted as before. External
 * `--report` files are never deleted.").
 *
 * The behavioural pin: with a sentinel root report in place and `--docs-only`
 * (the mode that skips the report branch entirely, so `rootReportConsumed`
 * stays false), the sentinel must still be there byte-for-byte after the gate
 * exits. The gate's own docs verdict is NOT asserted here on purpose: a red
 * docs verdict (e.g. mid-edit README from a parallel task) must not change
 * the cleanup behaviour, and the J-1 suite (docs-gate-j1.test.ts) already
 * covers the verdict logic.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const gateScript = path.join(repoRoot, 'scripts', 'verify-readme-counts.mjs');
const rootReportPath = path.join(repoRoot, 'test-results.json');
const SENTINEL = JSON.stringify({ sentinel: 'docs-gate-cleanup rev6 CI-2' }, null, 2) + '\n';

describe('docs gate cleanup: unconsumed root reports are not ours to delete (rev6 CI-2)', () => {
  it('leaves a root test-results.json in place when the run consumed nothing (--docs-only)', () => {
    // Snapshot/restore: a real root report (e.g. a CI leftover) must survive
    // this test byte-for-byte, and an absent one must be absent again.
    const preExisting = fs.existsSync(rootReportPath) ? fs.readFileSync(rootReportPath, 'utf8') : null;
    try {
      fs.writeFileSync(rootReportPath, SENTINEL, 'utf8');
      const result = spawnSync(process.execPath, [gateScript, '--docs-only'], {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
      });
      // The defect: the old unconditional "safety check" deleted the sentinel
      // even though this run consumed no report at all.
      expect(fs.existsSync(rootReportPath), `root report was deleted; gate stderr: ${result.stderr}`).toBe(true);
      expect(fs.readFileSync(rootReportPath, 'utf8')).toBe(SENTINEL);
    } finally {
      if (preExisting === null) {
        fs.rmSync(rootReportPath, { force: true });
      } else {
        fs.writeFileSync(rootReportPath, preExisting, 'utf8');
      }
    }
  }, 60_000);
});
