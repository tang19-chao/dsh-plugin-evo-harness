/**
 * SEC-5 regression (cross-audit §6): `options.experienceFilePath` used to be
 * returned verbatim and appended to with mode 0o600, so an integrator-supplied
 * path containing `..` aimed the durable JitRL log outside the profile data
 * directory. The option is now resolved against `persistence.dataDir` and
 * containment-checked; a path resolving outside it raises a named error that
 * `hydrateJitRl` reports as a cold-start diagnostic.
 *
 * The default path (no override) still goes through the sanitized
 * `resolveProfileDataDir`, and without a persistence runtime the option passes
 * through unchanged (there is no container to escape and hydrateJitRl never
 * consumes the value).
 */

import { describe, expect, it } from 'vitest';

import { createDefaultConfig } from '../../../src/config';
import { createJitRl } from '../../../src/jitrl';
import {
  hydrateJitRl,
  resolveExperienceFilePath,
  type EvoHarnessPluginOptions
} from '../../../src/index';
import type { PersistenceRuntime } from '../../../src/persistence';

/** The data directory a container check compares against. */
const DATA_DIR = 'C:/data/evo/profile';

describe('SEC-5: experience log path containment', () => {
  it('passes the override through when no persistence data dir exists', () => {
    expect(resolveExperienceFilePath({ experienceFilePath: 'C:/tmp/x.jsonl' })).toBe('C:/tmp/x.jsonl');
    expect(resolveExperienceFilePath({})).toBeUndefined();
  });

  it('accepts a relative file name and an absolute path inside the data dir', () => {
    expect(resolveExperienceFilePath({ experienceFilePath: 'jitrl-other.jsonl', persistence: { dataDir: DATA_DIR } as unknown as PersistenceRuntime })).toBe(
      DATA_DIR + '/jitrl-other.jsonl'
    );
    expect(resolveExperienceFilePath({ experienceFilePath: DATA_DIR + '/nested/log.jsonl', persistence: { dataDir: DATA_DIR } as unknown as PersistenceRuntime })).toBe(
      DATA_DIR + '/nested/log.jsonl'
    );
  });

  it('refuses a traversal segment and an absolute path outside the data dir', () => {
    const persistence = { dataDir: DATA_DIR } as unknown as PersistenceRuntime;
    expect(() => resolveExperienceFilePath({ experienceFilePath: '../escape.jsonl', persistence })).toThrow(
      /resolves outside the persistence data directory/
    );
    expect(() => resolveExperienceFilePath({ experienceFilePath: 'C:/data/evo/other/log.jsonl', persistence })).toThrow(
      /resolves outside the persistence data directory/
    );
    // A sibling whose prefix merely matches the data dir is NOT inside it.
    expect(() => resolveExperienceFilePath({ experienceFilePath: DATA_DIR + '-sibling/log.jsonl', persistence })).toThrow(
      /resolves outside the persistence data directory/
    );
  });

  it('reports the refusal as a cold-start diagnostic instead of rejecting', async () => {
    const kernel = createJitRl({ config: createDefaultConfig(), now: () => 1_700_000_000_000 });
    const diagnostics: string[] = [];
    const options = {
      experienceFilePath: '../escape.jsonl',
      persistence: { dataDir: DATA_DIR } as unknown as PersistenceRuntime,
      backfillFromTreePool: false
    } satisfies EvoHarnessPluginOptions;
    await hydrateJitRl({
      kernel,
      options,
      persistence: options.persistence,
      diagnostics
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain('cold start failed');
    expect(diagnostics[0]).toContain('resolves outside the persistence data directory');
    await kernel.flush();
  });
});
