/**
 * SEC-3 regression (cross-audit §6): the documentation gate was the one place
 * in the repo that ran a child process from a shell STRING
 * (`execSync(`pnpm exec vitest … --outputFile="${temp}"`)`). On Windows
 * execSync goes through cmd.exe, so a TMP/TEMP environment value carrying `"`
 * or `&`/`()` metacharacters was command injection in the developer's shell
 * context. The first repair moved to an argv array but still passed
 * `shell: true` (the pnpm `.cmd` shim) — measured: a `c&d` argument still split
 * at the `&`. The gate now spawns the resolved Vitest entry with the node
 * binary, so no argument is ever quoted or split; this pin keeps both the
 * shell-free form and the repo-wide "no execSync" property from regressing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('SEC-3: the docs gate spawns vitest via a shell-free argv array', () => {
  const gateSource = readFileSync(path.join(repoRoot, 'scripts', 'verify-readme-counts.mjs'), 'utf8');

  it('never uses execSync (shell-string execution)', () => {
    expect(gateSource).not.toContain('execSync');
  });

  it('never asks for a shell, so no argument is re-quoted or split', () => {
    expect(gateSource).not.toContain('shell:');
    expect(gateSource).not.toContain('shell: true');
    expect(gateSource).not.toContain('shell: process.platform');
  });

  it('passes the vitest invocation as a fixed argument array with the output path uninterpolated', () => {
    expect(gateSource).toContain('execFileSync(process.execPath, [vitestEntry()');
    expect(gateSource).toContain("'--reporter=json'");
    // The report path must ride as its own argument, never quoted into a shell string.
    expect(gateSource).toContain("'--outputFile=' + tempReportFile");
    expect(gateSource).not.toContain('--outputFile="');
  });
});
