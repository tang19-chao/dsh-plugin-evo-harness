/**
 * SEC-4 regression (cross-audit §6): `diagnostics/` is the designated dumping
 * ground for audit evidence (host paths, session ids, GUI screenshots) and was
 * the only untracked entry in `git status`, yet `.gitignore` listed every other
 * scratch root except it — a routine `git add -A` would have staged it.
 *
 * The assertion is made through git itself rather than by reading the pattern
 * text, so a rule that silently stops applying (wrong anchoring, a later
 * negation, a moved file) fails here. The negative control keeps the positive
 * meaningful: a source file must remain unignored.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Run `git check-ignore --verbose` on one path; undefined when not ignored. */
function ignoredBy(relativePath: string): { readonly source: string; readonly pattern: string } | undefined {
  const result = spawnSync('git', ['check-ignore', '--verbose', '--', relativePath], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  expect(result.error).toBeUndefined();
  if (result.status !== 0) {
    return undefined;
  }
  // `<source>:<line>:<pattern>\t<path>` — the pattern may itself contain ':'.
  const meta = result.stdout.trim().split('\t')[0];
  expect(meta).toBeDefined();
  if (meta === undefined) {
    return undefined;
  }
  const source = meta.slice(0, meta.indexOf(':'));
  const rest = meta.slice(meta.indexOf(':') + 1);
  return { source, pattern: rest.slice(rest.indexOf(':') + 1) };
}

describe('SEC-4: audit evidence dumps stay out of the index', () => {
  it('ignores diagnostics/ and everything nested under it', () => {
    for (const candidate of [
      'diagnostics/probe.txt',
      'diagnostics/CROSS-AUDIT-REPORT.md',
      'diagnostics/audit-round1/security.md',
      'diagnostics/dsh-gui-20261031-2204/shot.png'
    ]) {
      const rule = ignoredBy(candidate);
      expect(rule, candidate + ' must be ignored').toBeDefined();
      expect(rule?.pattern).toBe('diagnostics/');
      // The rule must come from the repository's own .gitignore, not a global one.
      expect(rule?.source.endsWith('.gitignore')).toBe(true);
    }
  });

  it('leaves tracked source and test paths unignored (negative control)', () => {
    expect(ignoredBy('src/index.ts')).toBeUndefined();
    expect(ignoredBy('tests/unit/meta/docs-gate-no-shell-exec.test.ts')).toBeUndefined();
    expect(ignoredBy('README.md')).toBeUndefined();
  });
});
