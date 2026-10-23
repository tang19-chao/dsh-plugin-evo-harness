/**
 * P2 L1 JitRL wiring (plan sections 4.3 and 8 Phase 2).
 *
 * Mandatory acceptance:
 *   (f) config disabled => the active policy is NOT wrapped and no
 *       'jit_meta_adjust' stage is emitted; enabled => plugin.jitrl diagnostics
 *       are present, the orchestrator emits 'jit_meta_adjust' after
 *       'select_batch', and the stage list carries it;
 *   (g) a failing experience store (unwritable log) and a malformed persisted
 *       tree degrade into diagnostics without throwing.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildOrchestratorDeps,
  createEvoHarnessPlugin,
  createPersistenceRuntime,
  resolveExperienceFilePath
} from '../../../src/index';
import type { EvoHarnessPlugin } from '../../../src/index';
import type { JitRl } from '../../../src/jitrl';
import { EVO_HARNESS_STAGES } from '../../../src/orchestrator';
import { createJitRl, isJitActivePolicy, jitMetaEnabled } from '../../../src/jitrl';
import { createDefaultConfig, parseEvoHarnessConfig } from '../../../src/config';
import { cleanupDir, makeTempDir, sampleTree } from '../persistence/fixtures';
import { buildE2E, createScriptedModel, e2eConfig, makeClock } from '../../e2e/fixtures';

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

/** Build a plugin with JitRL forced on/off through the plugin config section. */
function buildPlugin(jitrl: Record<string, unknown>): {
  readonly plugin: EvoHarnessPlugin;
  readonly harness: ReturnType<typeof buildE2E>;
} {
  // e2eConfig deep-merges groups under `config`; jitrl takes the same path so a
  // partial override cannot drop the frozen defaults of the other sections.
  const harness = buildE2E({ config: { jitrl } });
  return { plugin: harness.plugin, harness };
}

describe('stage list', () => {
  it('documents jit_meta_adjust immediately after select_batch', () => {
    const at = EVO_HARNESS_STAGES.indexOf('jit_meta_adjust');
    expect(at).toBeGreaterThan(0);
    expect(EVO_HARNESS_STAGES[at - 1]).toBe('select_batch');
  });
});

describe('jitMetaEnabled', () => {
  it('requires both the switch and the meta level', () => {
    const config = createDefaultConfig();
    expect(jitMetaEnabled(config.jitrl)).toBe(true);
    expect(jitMetaEnabled({ ...config.jitrl, enabled: false })).toBe(false);
    expect(jitMetaEnabled({ ...config.jitrl, levels: ['proposal'] })).toBe(false);
    expect(jitMetaEnabled({ ...config.jitrl, levels: ['meta', 'proposal'] })).toBe(true);
  });
});

describe('acceptance (f): disabled configuration is byte-identical', () => {
  it('does not wrap the policy and emits no jit stage', async () => {
    const { plugin } = buildPlugin({ enabled: false });
    expect(plugin.jitrl.enabled).toBe(false);
    expect(plugin.jitrl.storeSize).toBe(0);
    expect(plugin.jitrl.backfilled).toBe(0);
    expect(plugin.jitrl.degraded).toBe(false);

    const task = plugin.makeTask({
      id: 'task-off',
      prompt: 'Fix the failing build without breaking the release train.',
      taskSignature: 'build-failure',
      contextTags: ['ci']
    });
    const result = await plugin.run({ sessionId: 'sess-off', task, trigger: 'always' });
    expect(result.outcome).toBe('composed');

    const trace = plugin.orchestrator.lastTrace();
    expect(trace).toContain('select_batch');
    expect(trace).not.toContain('jit_meta_adjust');
    expect(EVO_HARNESS_STAGES).toContain('jit_meta_adjust');
  });

  it('does not wrap the policy when levels omit meta', async () => {
    const { plugin } = buildPlugin({ enabled: true, levels: ['proposal'] });
    expect(plugin.jitrl.enabled).toBe(false);
    const task = plugin.makeTask({ id: 'task-nometa', prompt: 'Repair the broken pipeline.' });
    await plugin.run({ sessionId: 'sess-nometa', task, trigger: 'always' });
    expect(plugin.orchestrator.lastTrace()).not.toContain('jit_meta_adjust');
  });
});

describe('acceptance (f): enabled configuration', () => {
  it('exposes plugin.jitrl diagnostics and emits jit_meta_adjust', async () => {
    const { plugin } = buildPlugin({ enabled: true, levels: ['meta'] });
    expect(plugin.jitrl.enabled).toBe(true);
    expect(plugin.jitrl.levels).toEqual(['meta']);
    expect(plugin.jitrl.storeSize).toBe(0);
    expect(plugin.jitrl.diagnostics.length).toBeGreaterThan(0);

    const task = plugin.makeTask({
      id: 'task-on',
      prompt: 'Fix the failing build without breaking the release train.',
      taskSignature: 'build-failure',
      contextTags: ['ci']
    });
    const result = await plugin.run({ sessionId: 'sess-on', task, trigger: 'always' });
    expect(result.outcome).toBe('composed');

    const trace = plugin.orchestrator.lastTrace();
    expect(trace).toContain('jit_meta_adjust');
    const at = trace.indexOf('jit_meta_adjust');
    expect(at).toBeGreaterThan(trace.indexOf('select_batch'));
    expect(at).toBeLessThan(trace.indexOf('propose'));
    // The stage list and the run metadata agree.
    expect(result.metadata?.lifecycle).toEqual([...trace]);
  });

  it('reports a stable, JSON-safe status object', () => {
    const { plugin } = buildPlugin({ enabled: true, levels: ['meta'] });
    expect(() => JSON.stringify(plugin.jitrl)).not.toThrow();
    const status = plugin.jitrl;
    expect(typeof status.enabled).toBe('boolean');
    expect(typeof status.storeSize).toBe('number');
    expect(typeof status.backfilled).toBe('number');
    expect(Array.isArray(status.levels)).toBe(true);
    expect(Array.isArray(status.diagnostics)).toBe(true);
  });

  it('wraps deps.policy in the decorator and keeps the base policy identity', () => {
    const diagnostics: string[] = [];
    const enabled = buildOrchestratorDeps(
      parseEvoHarnessConfig(e2eConfig({ config: { jitrl: { enabled: true, levels: ['meta'] } } })),
      { model: createScriptedModel(), now: makeClock() },
      {},
      diagnostics
    );
    expect(isJitActivePolicy(enabled.deps.policy)).toBe(true);
    // The decorator never renames the base policy: tree lineage and the offline
    // dreamer key on MetaSearchPolicy.id.
    expect(enabled.deps.policy.policy.id).toBe('pi-0');
    expect(enabled.jitrl.status.enabled).toBe(true);

    const disabled = buildOrchestratorDeps(
      parseEvoHarnessConfig(e2eConfig({ config: { jitrl: { enabled: false } } })),
      { model: createScriptedModel(), now: makeClock() },
      {},
      []
    );
    expect(isJitActivePolicy(disabled.deps.policy)).toBe(false);
    expect(disabled.jitrl.kernel).toBeUndefined();
    expect(disabled.jitrl.status.enabled).toBe(false);
  });
});

describe('acceptance (g): degraded paths never throw', () => {
  it('degrades to the memory store when the experience log cannot be opened', async () => {
    const config = createDefaultConfig();
    const kernel: JitRl = createJitRl({
      config,
      now: () => 1_700_000_000_000,
      onDiagnostic: () => undefined
    });
    // A directory that does not exist and cannot be created by the fake fs.
    const failingFs = {
      async appendDurable(): Promise<void> {
        throw new Error('EACCES: read-only filesystem');
      },
      async readText(): Promise<string | undefined> {
        throw new Error('EACCES: read-only filesystem');
      },
      async replaceAtomic(): Promise<void> {
        throw new Error('EACCES: read-only filesystem');
      }
    };
    // An unreadable log is tolerated by the driver itself: load() reports it and
    // the healthy (empty) index becomes the durable drive. Nothing throws.
    const tolerant = await kernel.hydrate({
      filePath: 'Z:/definitely/not/writable/experience.jsonl',
      fs: failingFs
    });
    expect(tolerant).toBeUndefined();
    expect(await kernel.size('meta')).toBe(0);

    // A hard store construction failure (blank path) is the degraded path: the
    // kernel keeps the in-memory drive and records jitrl_store_degraded.
    const hardFail = createJitRl({ config, now: () => 1_700_000_000_000 });
    await hardFail.hydrate({ filePath: '   ', fs: failingFs });
    expect(hardFail.degraded).toBe(true);
    expect(hardFail.diagnostics().map((entry) => entry.code)).toContain('jitrl_store_degraded');
    expect(await hardFail.size('meta')).toBe(0);
  });

  it('backfills a malformed persisted tree without throwing', async () => {
    const config = createDefaultConfig();
    const kernel = createJitRl({ config, now: () => 1_700_000_000_000 });
    const malformed = {
      id: 'tree-broken',
      sessionId: 'session-x',
      taskId: 'task-x',
      rootId: 'missing-root',
      nodes: {},
      stats: { nodeCount: 0, maxDepth: 0, maxWidth: 0, scoredNodes: 0, completedNodes: 0 },
      completed: false,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000
    } as never;
    const result = await kernel.backfill({ pool: [malformed] });
    expect(result.recordCount).toBe(0);
    expect(result.diagnostics.join(' ')).toContain('no resolvable root node');
    expect(kernel.diagnostics().map((entry) => entry.code)).toContain('jitrl_backfill');
  });

  it('survives an unavailable tree pool at hydrate time', async () => {
    const config = createDefaultConfig();
    const kernel = createJitRl({ config, now: () => 1_700_000_000_000 });
    const result = await kernel.hydrate({});
    expect(result).toBeUndefined();
    expect(kernel.degraded).toBe(false);
  });

  it('runs a real cold start from a persisted tree pool', async () => {
    const dir = await tempDir('jitrl-p2');
    const config = createDefaultConfig();
    const persistence = await createPersistenceRuntime({ dataDir: dir });
    persistence.treePool.add(sampleTree({ id: 'tree-cold', childCount: 2 }));
    await persistence.flush();

    const kernel = createJitRl({ config, now: () => 1_700_000_000_000 });
    const experienceFile = resolveExperienceFilePathFor(dir);
    const result = await kernel.hydrate({
      filePath: experienceFile,
      pool: persistence.treePool
    });
    expect(result).toBeDefined();
    expect(result?.recordCount).toBeGreaterThan(0);
    expect(result?.treeCount).toBe(1);
    expect(kernel.backfilled).toBe(result?.recordCount);
    expect(kernel.count('meta')).toBeGreaterThan(0);
    expect(kernel.degraded).toBe(false);

    // A second hydrate is a documented no-op (one-shot cold start).
    expect(await kernel.hydrate({ pool: persistence.treePool })).toBeUndefined();
    await persistence.dispose();
  });
});

describe('resolveExperienceFilePath', () => {
  it('prefers the explicit option over the persistence data directory', () => {
    const explicit = resolveExperienceFilePath({ experienceFilePath: 'C:/tmp/x.jsonl' });
    expect(explicit).toBe('C:/tmp/x.jsonl');
    expect(resolveExperienceFilePath({})).toBeUndefined();
  });

  it('derives the log path from an injected persistence runtime', async () => {
    const dir = await tempDir('jitrl-path');
    const persistence = await createPersistenceRuntime({ dataDir: dir });
    const resolved = resolveExperienceFilePath({ persistence });
    expect(resolved).toBeDefined();
    expect(resolved?.endsWith('jitrl-experience.jsonl')).toBe(true);
    await persistence.dispose();
  });
});

/** Join the persistence directory with the documented log file name. */
function resolveExperienceFilePathFor(dir: string): string {
  const separator = dir.includes('\\') ? '\\' : '/';
  return dir.endsWith(separator) ? dir + 'jitrl-experience.jsonl' : dir + separator + 'jitrl-experience.jsonl';
}

describe('config surface', () => {
  it('keeps the e2e config JitRL section optional', () => {
    // e2eConfig without a jitrl override keeps the frozen defaults, which have
    // JitRL enabled at the meta level: the L1 decorator must therefore appear.
    const { plugin } = buildE2E();
    expect(plugin.config.jitrl.enabled).toBe(true);
    expect(plugin.jitrl.enabled).toBe(true);
    expect(e2eConfig().jitrl).toBeUndefined();
  });
});
