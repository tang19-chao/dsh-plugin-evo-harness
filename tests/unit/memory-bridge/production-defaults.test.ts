/**
 * A-t11-7: production stays fail-closed.
 *
 * The memory write permission is denied by the default resolution, and no src
 * module constructs the explicit profile input that grants it (the grant is
 * profile DATA assembled only by test assemblies). The config leaves the write
 * paths consult — promoteOnComposeSuccess and the JitRL mirror — also stay off,
 * and this task's own module must not introduce the granting token into the
 * production tree.
 *
 * The scan strips comment lines before matching, because the type declaration
 * and the ADR explanation legitimately NAME the override; what must not exist is
 * a CONSTRUCTION of it.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveEvoHarnessConfig } from '../../../src/config';
import {
  EXECUTION_MODES,
  resolveExecutionProfile,
  type ExecutionMode
} from '../../../src/runtime/execution-profile';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function collectTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        files.push(full);
      }
    }
  };
  visit(directory);
  return files.sort();
}

/** Code lines only: full-line comments are dropped, trailing line comments stripped. */
function codeLinesOf(file: string): { line: number; code: string }[] {
  const out: { line: number; code: string }[] = [];
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? '').trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      continue;
    }
    out.push({ line: index + 1, code: trimmed.replace(/\/\/.*$/, '') });
  }
  return out;
}

describe('memory permission stays denied by default resolution', () => {
  it('denies real memory writes for every declared mode and for the bare default', () => {
    const bare = resolveExecutionProfile();
    expect(bare.mode).toBe('shadow');
    expect(bare.permissions.memory.allowed).toBe(false);
    expect(bare.permissions.publish.allowed).toBe(false);

    for (const mode of EXECUTION_MODES) {
      const profile = resolveExecutionProfile({ mode: mode as ExecutionMode });
      expect(profile.permissions.memory.allowed, 'memory denied in ' + mode).toBe(false);
      expect(profile.permissions.publish.allowed, 'publish denied in ' + mode).toBe(false);
    }
  });

  it('grants only through the explicit profile input that no config field produces', () => {
    const granted = resolveExecutionProfile({ memoryRealWrites: true });
    expect(granted.permissions.memory.allowed).toBe(true);
    expect(granted.permissions.memory.reason).toContain('memoryRealWrites');
    expect(verifiedConfigLeaves()).not.toContain('memoryRealWrites');
  });
});

describe('default config keeps the write requests off', () => {
  it('pins the default leaves this round depends on', () => {
    const config = resolveEvoHarnessConfig({});
    expect(config.memoryBridge.promoteOnComposeSuccess).toBe(false);
    expect(config.memoryBridge.enableNegativeFirewall).toBe(true);
    expect(config.memoryBridge.namespacePrefix).toBe('harness2');
    expect(config.jitrl.store.mirrorToMemoryBridge).toBe(false);
    expect(config.execution.mode).toBe('shadow');
    expect(config.execution.applyWinningPatch).toBe(false);
  });
});

describe('no production module constructs the memory-write grant', () => {
  it('scans every src/**/*.ts code line for the granting construction', () => {
    const files = collectTypeScriptFiles(join(REPO_ROOT, 'src'));
    expect(files.length).toBeGreaterThan(50);
    const offenders: string[] = [];
    for (const file of files) {
      for (const { line, code } of codeLinesOf(file)) {
        if (/memoryRealWrites\s*:\s*true/.test(code)) {
          offenders.push(relative(REPO_ROOT, file).replace(/\\/g, '/') + ':' + line);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the documented production modules free of the profile override entirely', () => {
    for (const relativePath of ['src/index.ts', 'src/config.ts', 'src/orchestrator.ts']) {
      const text = readFileSync(join(REPO_ROOT, relativePath), 'utf8');
      expect(text, relativePath).not.toMatch(/memoryRealWrites\s*:/);
    }
  });

  it('keeps this task module free of the granting token', () => {
    const source = readFileSync(join(REPO_ROOT, 'src/memory-bridge/status.ts'), 'utf8');
    expect(source).not.toMatch(/memoryRealWrites/);
  });
});

/** Placeholder resolver proving no config leaf can carry the override name. */
function verifiedConfigLeaves(): string {
  const config = resolveEvoHarnessConfig({
    memoryBridge: { promoteOnComposeSuccess: true }
  });
  return Object.keys(config.memoryBridge).join(',') + ',' + Object.keys(config.execution).join(',');
}
