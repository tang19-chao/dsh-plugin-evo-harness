import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';

import {
  COUNTERS_FILE,
  POLICY_CURRENT_FILE,
  POLICY_HISTORY_FILE,
  PersistentActivePolicy,
  PolicyStore
} from '../../../src/persistence/policy.store';
import {
  encodeJsonlRecord,
  readTextIfExists,
  writeFileAtomic
} from '../../../src/persistence/data-dir';
import {
  PolicyValidationError,
  createActivePolicy
} from '../../../src/dream-rsi/active-policy';
import type { MetaSearchPolicy } from '../../../src/types/contracts';
import { cleanupDir, makeTempDir, samplePolicy } from './fixtures';

const tempDirs: string[] = [];

async function tempDir(label: string): Promise<string> {
  const dir = await makeTempDir(label);
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await cleanupDir(dir);
  }
});

function historyLine(policy: MetaSearchPolicy, at = 1): string {
  return encodeJsonlRecord({ schemaVersion: 1, at, policy });
}

describe('PolicyStore', () => {
  it('starts empty and reports no dream for a zero everyNTasks', async () => {
    const store = await PolicyStore.open({ dataDir: await tempDir('policy-empty') });
    expect(store.current).toBeUndefined();
    expect(store.history).toEqual([]);
    expect(store.counters.completedTasks).toBe(0);
    expect(store.counters.dreams).toBe(0);
    expect(store.shouldDream(3)).toBe(false);
    expect(store.shouldDream(0)).toBe(false);
    expect(store.shouldDream(Number.NaN)).toBe(false);
    expect(store.diagnostics).toEqual([]);
  });

  it('persists the current policy and history across a restart', async () => {
    const dir = await tempDir('policy-restart');
    const first = samplePolicy('pi-1', 1);
    const second = samplePolicy('pi-2', 2);
    const store = await PolicyStore.open({ dataDir: dir });
    await store.savePolicy(first);
    await store.savePolicy(second);
    await store.flush();
    expect(store.current).toEqual(second);
    expect(store.history.map((policy) => policy.id)).toEqual(['pi-1', 'pi-2']);

    const restarted = await PolicyStore.open({ dataDir: dir });
    expect(restarted.current).toEqual(second);
    expect(restarted.history.map((policy) => policy.id)).toEqual(['pi-1', 'pi-2']);
    expect(await restarted.restore()).toEqual(second);
    expect(restarted.quarantinedPaths).toEqual([]);
  });

  it('rejects an invalid policy before writing anything', async () => {
    const dir = await tempDir('policy-invalid');
    const valid = samplePolicy('pi-1', 1);
    const store = await PolicyStore.open({ dataDir: dir });
    await store.savePolicy(valid);
    await store.flush();

    const invalid: MetaSearchPolicy = { ...valid, version: 0 };
    await expect(store.saveCurrent(invalid)).rejects.toBeInstanceOf(PolicyValidationError);
    await store.flush();

    const restarted = await PolicyStore.open({ dataDir: dir });
    expect(restarted.current).toEqual(valid);
    expect(restarted.history).toHaveLength(1);
  });

  it('resumes the newest persisted revision when the current snapshot is missing', async () => {
    const dir = await tempDir('policy-history-only');
    const store = await PolicyStore.open({ dataDir: dir });
    await store.recordRevision(samplePolicy('pi-1', 1));
    await store.flush();

    const restarted = await PolicyStore.open({ dataDir: dir });
    expect(restarted.current).toBeUndefined();
    const restored = await restarted.restore();
    expect(restored.id).toBe('pi-1');
    expect(restarted.diagnostics.some((line) => line.includes('newest persisted revision'))).toBe(true);
  });

  it('falls back to the caller policy and then to a fresh pi-0', async () => {
    const store = await PolicyStore.open({ dataDir: await tempDir('policy-fallback') });
    const fallback = samplePolicy('pi-fallback', 1);
    expect(await store.restore(fallback)).toEqual(fallback);
    expect((await store.restore()).id).toBe('pi-0');
  });

  it('continues the completed-task counter and the shouldDream cadence across a restart', async () => {
    const dir = await tempDir('policy-counter');
    const store = await PolicyStore.open({ dataDir: dir });
    await store.recordCompletedTask();
    await store.recordCompletedTask();
    expect(await store.recordCompletedTask()).toBe(3);
    expect(store.shouldDream(3)).toBe(true);
    await store.flush();

    const restarted = await PolicyStore.open({ dataDir: dir });
    expect(restarted.counters.completedTasks).toBe(3);
    expect(restarted.shouldDream(3)).toBe(true);

    await restarted.recordCompletedTask();
    expect(restarted.counters.completedTasks).toBe(4);
    expect(restarted.shouldDream(3)).toBe(false);
    await restarted.recordCompletedTask();
    await restarted.recordCompletedTask();
    expect(restarted.counters.completedTasks).toBe(6);
    expect(restarted.shouldDream(3)).toBe(true);
    await restarted.flush();

    const third = await PolicyStore.open({ dataDir: dir });
    expect(third.counters.completedTasks).toBe(6);
  });

  it('records offline dreams and persists them', async () => {
    const dir = await tempDir('policy-dreams');
    const store = await PolicyStore.open({ dataDir: dir });
    await store.recordDream();
    expect(await store.recordDream(2)).toBe(3);
    await store.flush();

    const restarted = await PolicyStore.open({ dataDir: dir });
    expect(restarted.counters.dreams).toBe(3);
    await restarted.resetCounters();
    expect(restarted.counters.completedTasks).toBe(0);
    expect(restarted.counters.dreams).toBe(0);
    await restarted.flush();
    const third = await PolicyStore.open({ dataDir: dir });
    expect(third.counters.completedTasks).toBe(0);
    expect(third.counters.dreams).toBe(0);
  });

  it('quarantines a corrupt counters snapshot and resumes at zero', async () => {
    const dir = await tempDir('policy-counter-corrupt');
    await writeFileAtomic(path.join(dir, COUNTERS_FILE), '{"schemaVersion":1,"completedTasks":');
    const store = await PolicyStore.open({ dataDir: dir });
    expect(store.counters.completedTasks).toBe(0);
    expect(store.counters.dreams).toBe(0);
    expect(store.quarantinedPaths).toEqual([path.join(dir, COUNTERS_FILE) + '.corrupt']);
    expect(store.diagnostics.length).toBeGreaterThan(0);
  });

  it('quarantines a schema-invalid counters snapshot', async () => {
    const dir = await tempDir('policy-counter-shape');
    await writeFileAtomic(
      path.join(dir, COUNTERS_FILE),
      JSON.stringify({ schemaVersion: 1, completedTasks: -1, dreams: 0, updatedAt: 1 })
    );
    const store = await PolicyStore.open({ dataDir: dir });
    expect(store.counters.completedTasks).toBe(0);
    expect(store.quarantinedPaths).toHaveLength(1);
  });

  it('quarantines a corrupt current snapshot and falls back', async () => {
    const dir = await tempDir('policy-current-corrupt');
    await writeFileAtomic(path.join(dir, POLICY_CURRENT_FILE), '{"schemaVersion":1,"savedAt":');
    const store = await PolicyStore.open({ dataDir: dir });
    expect(store.current).toBeUndefined();
    const fallback = samplePolicy('pi-fallback', 1);
    expect(await store.restore(fallback)).toEqual(fallback);
    expect(store.quarantinedPaths).toEqual([path.join(dir, POLICY_CURRENT_FILE) + '.corrupt']);
  });

  it('keeps the healthy history prefix and quarantines a corrupt revision line', async () => {
    const dir = await tempDir('policy-history-corrupt');
    const good = samplePolicy('pi-1', 1);
    await writeFileAtomic(
      path.join(dir, POLICY_HISTORY_FILE),
      historyLine(good) + 'garbage-line\n' + historyLine(samplePolicy('pi-2', 2), 2)
    );
    const store = await PolicyStore.open({ dataDir: dir });
    expect(store.history.map((policy) => policy.id)).toEqual(['pi-1']);
    expect(store.quarantinedPaths).toEqual([path.join(dir, POLICY_HISTORY_FILE) + '.corrupt']);
    expect(await readTextIfExists(path.join(dir, POLICY_HISTORY_FILE))).toBe(historyLine(good));
  });

  it('trims the retained history window', async () => {
    const dir = await tempDir('policy-max-history');
    const store = await PolicyStore.open({ dataDir: dir, maxHistory: 2 });
    await store.savePolicy(samplePolicy('pi-1', 1));
    await store.savePolicy(samplePolicy('pi-2', 2));
    await store.savePolicy(samplePolicy('pi-3', 3));
    await store.flush();
    expect(store.history.map((policy) => policy.id)).toEqual(['pi-2', 'pi-3']);

    const restarted = await PolicyStore.open({ dataDir: dir, maxHistory: 2 });
    expect(restarted.history.map((policy) => policy.id)).toEqual(['pi-2', 'pi-3']);
  });
});

describe('PersistentActivePolicy', () => {
  it('persists every accepted update through the store', async () => {
    const dir = await tempDir('policy-wrapper');
    const store = await PolicyStore.open({ dataDir: dir });
    const initial = samplePolicy('pi-1', 1);
    const evolved = samplePolicy('pi-2', 2, { parentPolicyId: 'pi-1' });
    // The caller snapshots the baseline it resumed from before evolving it.
    await store.savePolicy(initial);
    const base = createActivePolicy({ policy: initial, now: (): number => 1_700_000_000_000 });
    const wrapper = new PersistentActivePolicy(store, base);
    expect(wrapper.policy).toEqual(initial);

    wrapper.update(evolved);
    expect(wrapper.policy).toEqual(evolved);
    expect(wrapper.appliedPolicyIds).toEqual(['pi-1@1', 'pi-2@2']);
    await wrapper.flush();

    const restarted = await PolicyStore.open({ dataDir: dir });
    expect(restarted.current).toEqual(evolved);
    expect(restarted.history.map((policy) => policy.id)).toEqual(['pi-1', 'pi-2']);
    expect(await restarted.restore()).toEqual(evolved);
  });

  it('can skip the revision log while still snapshotting the policy', async () => {
    const dir = await tempDir('policy-wrapper-norev');
    const store = await PolicyStore.open({ dataDir: dir });
    const base = createActivePolicy({
      policy: samplePolicy('pi-1', 1),
      now: (): number => 1_700_000_000_000
    });
    const wrapper = new PersistentActivePolicy(store, base, { recordRevision: false });
    wrapper.update(samplePolicy('pi-2', 2));
    await wrapper.flush();

    const restarted = await PolicyStore.open({ dataDir: dir });
    expect(restarted.current?.id).toBe('pi-2');
    expect(restarted.history).toEqual([]);
  });
});