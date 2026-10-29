/**
 * R-08 type test — `PARITY_PLATFORMS` must be field-level readonly.
 *
 * The runtime freezes the array AND every element
 * (`scripts/eval/compare-platform-digests.mjs:91-95`), but the hand-written
 * declaration used to say `readonly ParityPlatform[]` with MUTABLE fields: the
 * type promised less than the runtime enforced, so a TypeScript caller could
 * write `PARITY_PLATFORMS[0].os = ...` and find out only at run time (or never,
 * in a code path that never executes). The declaration now marks both fields
 * `readonly`; this file is the gate.
 *
 * What is pinned:
 *  - compile time (`pnpm exec tsc --noEmit`): `@ts-expect-error` witnesses fail
 *    the build when the fields stop being readonly, and a positive assignment
 *    proves the negative witnesses are not vacuous;
 *  - run time: the shape is UNCHANGED — the same three OS entries in the same
 *    order, each frozen, with the CI artifact directory names.
 *
 * No network, no CI, no file mutation.
 */
import { describe, expect, it } from 'vitest';
import { PARITY_PLATFORMS } from '../../../scripts/eval/compare-platform-digests.mjs';
import type { ParityPlatform } from '../../../scripts/eval/compare-platform-digests.mjs';

/**
 * Compile-time witnesses; deliberately never executed at run time beyond the
 * `void` reference. Each `@ts-expect-error` is a tsc gate: if a field became
 * mutable again, tsc would report the now-unused directive.
 */
function readonlyWitnesses(): void {
  // `noUncheckedIndexedAccess` is on: the entry exists (runtime-frozen three-OS set).
  const first = PARITY_PLATFORMS[0]!;
  // Reading is fine and keeps the positive path type-checked.
  const os: string = first.os;
  const directory: string = first.artifactDirectory;
  expect(typeof os).toBe('string');
  expect(typeof directory).toBe('string');

  // @ts-expect-error `os` is readonly in the declared contract
  first.os = 'freebsd-latest';
  // @ts-expect-error `artifactDirectory` is readonly in the declared contract
  first.artifactDirectory = 'attestation-freebsd-latest';
  // @ts-expect-error the array is readonly: no entry may be appended
  PARITY_PLATFORMS.push({ os: 'freebsd-latest', artifactDirectory: 'attestation-freebsd-latest' });
  // @ts-expect-error the array is readonly: no entry may be replaced
  PARITY_PLATFORMS[0] = { os: 'freebsd-latest', artifactDirectory: 'attestation-freebsd-latest' };

  // A value typed as the public interface is readonly too (the fields, not just
  // the array element access).
  const platform: ParityPlatform = first;
  // @ts-expect-error a ParityPlatform value cannot be mutated field-by-field
  platform.os = 'freebsd-latest';
}
void readonlyWitnesses;

describe('PARITY_PLATFORMS: declaration and runtime agree (R-08)', () => {
  it('declares the three-OS set with field-level readonly members', () => {
    // The compile-time proof is the `@ts-expect-error` block above; this run-time
    // pass pins the SHAPE the declaration describes.
    expect(PARITY_PLATFORMS.map((platform) => platform.os)).toEqual([
      'ubuntu-latest',
      'macos-latest',
      'windows-latest'
    ]);
    expect(PARITY_PLATFORMS.map((platform) => platform.artifactDirectory)).toEqual([
      'attestation-ubuntu-latest',
      'attestation-macos-latest',
      'attestation-windows-latest'
    ]);
    expect(Object.keys(PARITY_PLATFORMS[0]!).sort()).toEqual(['artifactDirectory', 'os']);
  });

  it('keeps the runtime freeze the declaration now matches (array AND every element)', () => {
    expect(Object.isFrozen(PARITY_PLATFORMS)).toBe(true);
    for (const platform of PARITY_PLATFORMS) {
      expect(Object.isFrozen(platform)).toBe(true);
    }
    // A runtime mutation is refused exactly like the type-level one.
    expect(() => {
      'use strict';
      (PARITY_PLATFORMS[0]! as { os: string }).os = 'freebsd-latest';
    }).toThrow(TypeError);
    expect(PARITY_PLATFORMS[0]!.os).toBe('ubuntu-latest');
  });
});