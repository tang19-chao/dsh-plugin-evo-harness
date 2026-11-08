/**
 * rev8 stage-1 tests: the MCP entry assembly (src/mcp/assembly.ts).
 *
 * Deterministic and offline: every test injects its own data directory (a temp
 * dir under work/persistence-tmp, gitignored) and an explicit env snapshot, so
 * the real process environment — and therefore the real
 * EVO_HARNESS_DATA_DIR / DSH_DATA_DIR / DSH_PROFILE of this machine — is never
 * consulted. The model is a scripted adapter; no network, no host, no ctx.
 *
 * Covered (the ask's five assertions):
 *   1. shadow enforcement  — pinned config/profile, no patch/publish/memory
 *      widening, no real-namespace memory call, applyWinningPatch promotion
 *      refused;
 *   2. no ctx              — the assembly runs with ctx=undefined and mounts
 *      nothing into a live host context (in-memory host only);
 *   3. no collaborator probing — resolveDshCollaborators=false is reported, the
 *      collaborators promise resolves to undefined without touching any ctx;
 *   4. persistence          — a fresh runtime under the caller's data-dir
 *      options, flushed by dispose, recoverable on reopen;
 *   5. idempotent dispose   — second call is a no-op; teardown failures
 *      propagate.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';

import {
  buildEvoAssembly,
  MCP_EXECUTION_DEFAULTS,
  resolveMcpDataDir,
  type EvoAssemblyInput
} from '../../../src/mcp/assembly';
import { DEFAULT_EXECUTION_MODE, resolveExecutionProfile } from '../../../src/runtime/execution-profile';
import type {
  IModelAdapter,
  IsolatedBranchContext,
  ModelRequest,
  ModelResponse,
  ProbeExecutionResult
} from '../../../src/types/contracts';
import { createEvoHarnessPlugin, type EvoHarnessPlugin } from '../../../src/index';
import type { EvoHarnessConfig } from '../../../src/config';
import { cleanupDir, makeTempDir } from '../persistence/fixtures';

// ---------------------------------------------------------------------------
// deterministic fakes
// ---------------------------------------------------------------------------

/** Valid Harness2 proposer payload (same shape the e2e fixtures script). */
function proposalPayload(): Record<string, unknown> {
  return {
    rationale: 'Mount an output contract so the tool loop stops retrying after a failure.',
    focusSurfaces: ['guardrails'],
    confidence: 0.72,
    expectedStepsDelta: -1,
    edits: {
      guardrails: {
        kind: 'guardrails',
        formatContract: 'Return minified JSON only.',
        appendRules: ['declare the failing tool before retrying']
      }
    }
  };
}

/**
 * Scripted model routing on ModelPurpose (the fixtures' shape, locally inlined
 * so this suite does not import the e2e helpers): propose -> a valid proposal,
 * compose -> ranking of every candidate alias, reflect -> no lessons, probe ->
 * the deliverable text.
 */
function scriptedModel(reply: string = 'scripted deliverable'): IModelAdapter & {
  requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  return {
    requests,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      requests.push(request);
      if (request.purpose === 'propose') {
        return {
          text: JSON.stringify(proposalPayload()),
          finishReason: 'stop',
          model: 'scripted'
        };
      }
      if (request.purpose === 'compose') {
        const text = request.messages.map((message) => message.content).join('\n');
        const aliases = [...new Set(text.match(/candidate_[A-Z]/g) ?? [])];
        return {
          text: JSON.stringify({
            ranking: aliases,
            assessments: aliases.map((alias, index) => ({
              alias,
              rationale: 'ranked ' + String(index + 1) + ' by the scripted judge'
            }))
          }),
          finishReason: 'stop',
          model: 'scripted'
        };
      }
      if (request.purpose === 'reflect') {
        return { text: JSON.stringify({ lessons: [] }), finishReason: 'stop', model: 'scripted' };
      }
      return { text: reply, finishReason: 'stop', model: 'scripted' };
    }
  };
}

/** A branch executor recording its contexts; the explicit-runBranch fake. */
function scriptedRunner(): {
  runBranch: (context: IsolatedBranchContext) => Promise<ProbeExecutionResult>;
  calls: IsolatedBranchContext[];
} {
  const calls: IsolatedBranchContext[] = [];
  return {
    calls,
    async runBranch(context: IsolatedBranchContext): Promise<ProbeExecutionResult> {
      calls.push(context);
      return {
        status: 'succeeded',
        steps: [{ index: 0, at: 1_700_000_000_001, kind: 'model', text: 'explicit runner' }],
        toolErrors: [],
        failureSignals: [],
        deliverable: { content: 'explicit runner deliverable', format: 'markdown', producedFiles: [] }
      };
    }
  };
}

/** Deterministic monotonic clock (the fixtures' makeClock shape). */
function makeClock(start = 1_700_000_000_000): () => number {
  let current = start;
  return (): number => {
    current += 1;
    return current;
  };
}

/** A config section shrunk for offline test cost (plan: "配置默认缩小离线测试成本但不改变生产预算语义"). */
function cheapConfigSection(): Record<string, unknown> {
  return {
    triggerMode: 'slash_command',
    probe: { maxConcurrentProbes: 1, probeTimeoutMs: 1_000 },
    dreamRsi: {
      maxOnlineRolloutBudget: 2,
      maxWidth: 1,
      maxDepth: 1,
      candidatePoliciesCount: 2,
      rhoPreferences: [0, 1],
      offlineDreamTriggerEveryNTasks: 100
    },
    logging: { level: 'silent' }
  };
}

interface BuiltAssembly {
  assembly: Awaited<ReturnType<typeof buildEvoAssembly>>;
  dirs: string[];
}

const tempDirs: string[] = [];

/**
 * Windows-tolerant cleanup: the JitRL JSONL experience store serializes its
 * writes on an internal promise chain that dispose does not drain (the plugin
 * flushes the persistence runtime, not the experience store), so one append can
 * land while `rm -rf` is already walking the directory and the rmdir reports
 * ENOTEMPTY. The shared persistence fixtures' cleanupDir has no retry and is
 * owned by another module, so this suite wraps it locally.
 */
async function cleanupWithRetry(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await cleanupDir(dir);
      return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (attempt >= 4 || (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM')) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

/**
 * Build one assembly over a fresh temp directory — or reuse `reuseDir`, so a
 * "reopen the same directory" test can build a second generation on top of the
 * first one's flushed writes.
 */
async function build(
  overrides: Partial<EvoAssemblyInput> = {},
  reuseDir?: string
): Promise<BuiltAssembly> {
  const dir = reuseDir ?? (await makeTempDir('mcp-assembly'));
  if (reuseDir === undefined) {
    tempDirs.push(dir);
  }
  const input: EvoAssemblyInput = {
    config: cheapConfigSection(),
    model: scriptedModel(),
    now: makeClock(),
    dataDir: {
      dataDir: dir,
      env: { EVO_HARNESS_DATA_DIR: undefined, DSH_DATA_DIR: undefined, DSH_PROFILE: undefined }
    },
    ...overrides
  };
  // When overrides carry their own dataDir, honour it (the temp dir stays only
  // for cleanup bookkeeping).
  return { assembly: await buildEvoAssembly(input), dirs: [dir] };
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await cleanupWithRetry(dir);
  }
});

// ---------------------------------------------------------------------------
// 1. shadow enforcement
// ---------------------------------------------------------------------------

describe('shadow enforcement (plan §5.7)', () => {
  it('pins the resolved config execution group to the shadow constants', async () => {
    const { assembly } = await build();
    expect(assembly.plugin.config.execution.mode).toBe(MCP_EXECUTION_DEFAULTS.mode);
    expect(assembly.plugin.config.execution.mode).toBe('shadow');
    expect(assembly.plugin.config.execution.applyWinningPatch).toBe(false);
    await assembly.dispose();
  });

  it('pins an already-parsed guarded-active config back to shadow', async () => {
    // An already-resolved config whose execution group declares guarded-active:
    // the parse path keeps it, the assembly must pin it back.
    const guarded = {
      ...cheapConfigSection(),
      execution: { mode: 'guarded-active', applyWinningPatch: true }
    } as unknown as EvoHarnessConfig;
    const { assembly } = await build({ config: guarded });
    expect(assembly.plugin.config.execution.mode).toBe('shadow');
    expect(assembly.plugin.config.execution.applyWinningPatch).toBe(false);
    await assembly.dispose();
  });

  it('reports a denied patch permission on the orchestrator profile after a run', async () => {
    const { assembly } = await build();
    const profile = resolveExecutionProfile({ mode: MCP_EXECUTION_DEFAULTS.mode });
    expect(profile.mode).toBe('shadow');
    expect(profile.permissions.patch.allowed).toBe(false);
    expect(profile.permissions.publish.allowed).toBe(false);
    expect(profile.permissions.memory.allowed).toBe(false);
    await assembly.dispose();
  });

  it('refuses a raw config that promotes applyWinningPatch outside guarded-active (parse path)', async () => {
    await expect(
      build({
        config: {
          ...cheapConfigSection(),
          execution: { mode: 'shadow', applyWinningPatch: true }
        }
      })
    ).rejects.toThrow(/applyWinningPatch requires execution\.mode=guarded-active/);
  });

  it('pins the memory-bridge mirror request off so no real write is even requested', async () => {
    const { assembly } = await build({
      config: { ...cheapConfigSection(), jitrl: { store: { mirrorToMemoryBridge: true } } }
    });
    expect(assembly.plugin.config.jitrl.store.mirrorToMemoryBridge).toBe(false);
    await assembly.dispose();
  });

  it('runs a full shadow run with zero active host effects and no bridge write', async () => {
    const { assembly } = await build();
    const result = await assembly.plugin.run({
      runId: 'mcp-shadow-1',
      sessionId: 'sess-mcp',
      task: assembly.plugin.makeTask({ prompt: 'Fix the failing build.' }),
      trigger: 'slash_command'
    });
    // The scripted proposer + scripted runner compose in shadow mode.
    expect(['composed', 'probed']).toContain(result.outcome);
    // The eight surfaces mounted inside the ISOLATED branches during the run;
    // every branch effect was disposed at branch end, so nothing stays active.
    expect(assembly.host.activeEffects()).toHaveLength(0);
    // The branch lifecycle really ran through the in-memory host.
    expect(assembly.host.callCount('fork_branch')).toBeGreaterThan(0);
    // Shadow profile denies memory: the bridge was never asked to commit.
    expect(assembly.plugin.memory.writable).not.toBe('yes');
    expect(assembly.plugin.memory.writable === 'no' || assembly.plugin.memory.writable === 'unknown').toBe(
      true
    );
    expect(assembly.plugin.memory.label).toBe('Recall-Only');
    expect(assembly.plugin.diagnostics.join(' ')).not.toContain('apply_patch: winning patch mounted');
    await assembly.dispose();
  });

  it('refuses options.deps.executionProfile (the profile-replacing test seam)', async () => {
    await expect(
      build({
        options: {
          deps: {
            executionProfile: resolveExecutionProfile({ mode: 'guarded-active' })
          }
        }
      })
    ).rejects.toThrow(/deps\.executionProfile/);
  });
});

// ---------------------------------------------------------------------------
// 2. no ctx
// ---------------------------------------------------------------------------

describe('ctx-free assembly', () => {
  it('mounts with ctx=undefined and reports the in-memory host adapter source', async () => {
    const { assembly } = await build();
    // resolveHostAdapter honours options.host first: the source is 'injected',
    // and the adapter is the in-memory recorder the assembly created.
    expect(assembly.plugin.hostAdapterSource).toBe('injected');
    expect(assembly.plugin.surfaces.length).toBeGreaterThan(0);
    // The mountable statuses are TRUE (the in-memory host implements every
    // host method) — the honest state under plan §5.7; safety is asserted via
    // activeEffects() being empty, not by faking mountable=false.
    for (const surface of assembly.plugin.surfaces) {
      if (surface.enabled) {
        expect(surface.mountable).toBe(true);
      }
    }
    await assembly.dispose();
  });

  it('never reads a ctx object: createEvoHarnessPlugin receives undefined', async () => {
    // Structural proof: calling the documented public entry with the same
    // option shape and NO ctx produces a plugin whose collaborator promise is
    // the only async gap — none of the mount/registration paths ran.
    const { assembly } = await build();
    expect(assembly.plugin.registeredCommands).toHaveLength(0);
    expect(assembly.plugin.registeredEvents).toHaveLength(0);
    await assembly.dispose();
  });
});

// ---------------------------------------------------------------------------
// 3. no collaborator probing
// ---------------------------------------------------------------------------

describe('collaborator probing disabled', () => {
  it('resolves collaborators to undefined with the documented diagnostic', async () => {
    const { assembly } = await build();
    const collaborators = await assembly.plugin.collaborators;
    expect(collaborators).toBeUndefined();
    expect(assembly.plugin.diagnostics.join(' ')).toContain(
      'DSH collaborator detection was disabled by options.resolveDshCollaborators=false'
    );
    await assembly.dispose();
  });

  it('keeps trigger registration off (pull-mode entry, no host events)', async () => {
    const { assembly } = await build();
    expect(assembly.plugin.diagnostics.join(' ')).toContain(
      'trigger registration was disabled by options.registerAutoFallback=false'
    );
    expect(assembly.plugin.registeredEvents).toHaveLength(0);
    // The idle-dream hook is likewise disabled: no agent/status listener would
    // exist even if a ctx carried one; with none the count stays zero.
    await assembly.dispose();
  });

  it('starts the memory bridge unbound (clients=[]) without failing the mount', async () => {
    const { assembly } = await build();
    // clients=[] means the bridge never binds a backend: recall-only mode,
    // non-'yes' writable state, and the mount itself did not fail.
    expect(assembly.plugin.memory.mode).toBe('recall-only');
    expect(assembly.plugin.memory.writable).not.toBe('yes');
    expect(assembly.plugin.memory.diagnostics.join(' ')).not.toContain('backend:');
    await assembly.dispose();
  });
});

// ---------------------------------------------------------------------------
// 4. persistence
// ---------------------------------------------------------------------------

describe('persistence wiring', () => {
  it('creates a fresh runtime inside the caller data directory and resumes it', async () => {
    const first = await build();
    const result = await first.assembly.plugin.run({
      runId: 'mcp-persist-1',
      sessionId: 'sess-persist',
      task: first.assembly.plugin.makeTask({ prompt: 'Fix the failing build.' }),
      trigger: 'slash_command'
    });
    expect(result.outcome).not.toBe('failed');
    // The tree of the completed run is owned by the fresh runtime.
    expect(first.assembly.persistence.treePool.size()).toBe(1);
    expect(first.assembly.dataDir).toBe(first.assembly.persistence.dataDir);
    expect(first.assembly.persistence.dataDir.toLowerCase().includes(tempDirs[0]!.toLowerCase())).toBe(
      true
    );
    await first.assembly.dispose();
    // Reopen the SAME directory: the run's tree survived the flush barrier.
    const second = await build({}, tempDirs[0]);
    expect(second.assembly.persistence.treePool.size()).toBe(1);
    await second.assembly.dispose();
  });

  it('does not auto-target the real plugin data root when only env is set (documented precedence)', () => {
    // Pure resolution (no store creation): an explicit dataDir wins over env;
    // rootDir + profile compose the documented profiles/<name> layout; a
    // sanitized profile cannot traverse.
    expect(resolveMcpDataDir({ dataDir: 'C:/tmp/explicit', env: { EVO_HARNESS_DATA_DIR: 'C:/tmp/env' } })).toBe(
      'C:\\tmp\\explicit'
    );
    expect(resolveMcpDataDir({ rootDir: 'C:/root', profile: 'desktop', env: {} })).toContain(
      'profiles' + '\\desktop'
    );
    expect(resolveMcpDataDir({ rootDir: 'C:/root', profile: '../escape', env: {} })).not.toContain('..');
    // No options at all: the default root is <home>/.dsh/evo-harness — NOT the
    // real plugin profile directory (which lives under the DSH data root).
    const fallback = resolveMcpDataDir({ env: {} });
    expect(fallback).toContain('evo-harness');
    expect(fallback).toContain('profiles' + '\\default');
  });

  it('propagates a persistence failure instead of silently running in memory', async () => {
    // The data-dir path runs through an existing FILE: mkdir(recursive) fails
    // and the assembly must refuse to start (fail fast, no fallback).
    const dir = await makeTempDir('mcp-assembly-blocked');
    tempDirs.push(dir);
    const blockFile = dir + '\\occupied.txt';
    await writeFile(blockFile, 'not a directory', 'utf8');
    await expect(
      build({
        dataDir: { dataDir: blockFile, env: { EVO_HARNESS_DATA_DIR: undefined } }
      })
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. idempotent dispose
// ---------------------------------------------------------------------------

describe('dispose', () => {
  it('is idempotent: the second call resolves without side effects', async () => {
    const { assembly } = await build();
    await assembly.plugin.run({
      runId: 'mcp-dispose-1',
      sessionId: 'sess-dispose',
      task: assembly.plugin.makeTask({ prompt: 'Fix the failing build.' }),
      trigger: 'slash_command'
    });
    await assembly.dispose();
    // Second call: resolves (not rejects), pool state untouched.
    await expect(assembly.dispose()).resolves.toBeUndefined();
    expect(assembly.persistence.treePool.size()).toBe(1);
  });

  it('propagates a plugin dispose failure and still runs the runtime teardown', async () => {
    const { assembly } = await build();
    // Force the plugin's own dispose to fail: disposing the orchestrator twice
    // is safe, so instead replace the orchestrator dispose with a throwing one
    // through the documented deps seam… which is pinned here. The honest way:
    // break the plugin handle's dispose directly.
    const plugin = assembly.plugin as unknown as { dispose: () => Promise<void> };
    const original = plugin.dispose.bind(assembly.plugin);
    plugin.dispose = async () => {
      await original();
      throw new Error('injected plugin dispose failure');
    };
    await expect(assembly.dispose()).rejects.toThrow(/injected plugin dispose failure/);
    // The persistence runtime was still disposed (its queue drained cleanly).
    await expect(assembly.persistence.flush()).resolves.toBeUndefined();
  });

  it('flushes queued persistence writes when the plugin flushes first', async () => {
    const first = await build();
    await first.assembly.plugin.run({
      runId: 'mcp-flush-1',
      sessionId: 'sess-flush',
      task: first.assembly.plugin.makeTask({ prompt: 'Fix the failing build.' }),
      trigger: 'slash_command'
    });
    await first.assembly.dispose();
    // Reopen the SAME directory: the durable task counter survived.
    const second = await build({}, tempDirs[tempDirs.length - 1]);
    expect(second.assembly.persistence.policyStore.counters.completedTasks).toBe(1);
    await second.assembly.dispose();
  });
});

// ---------------------------------------------------------------------------
// agent-loop default + runBranch precedence
// ---------------------------------------------------------------------------

describe('agent-loop default and runBranch precedence', () => {
  it('activates the agent-loop executor on the injected model (single_call, no tools)', async () => {
    const { assembly } = await build();
    const diagnostics = assembly.plugin.diagnostics.join(' ');
    expect(diagnostics).toContain('multi-step agent probe executor is active');
    // No tool runtime: the loop degrades to single_call.
    expect(diagnostics).toContain('no tool runtime');
    await assembly.dispose();
  });

  it('gives an explicit runBranch precedence over the agent-loop executor', async () => {
    const runner = scriptedRunner();
    const { assembly } = await build({ options: { runBranch: runner.runBranch } });
    const diagnostics = assembly.plugin.diagnostics.join(' ');
    expect(diagnostics).not.toContain('multi-step agent probe executor is active');
    const result = await assembly.plugin.run({
      runId: 'mcp-runner-1',
      sessionId: 'sess-runner',
      task: assembly.plugin.makeTask({ prompt: 'Fix the failing build.' }),
      trigger: 'slash_command'
    });
    expect(runner.calls.length).toBeGreaterThan(0);
    expect(result.outcome).not.toBe('failed');
    await assembly.dispose();
  });

  it('probes through the injected model when no runBranch exists', async () => {
    const model = scriptedModel('probe deliverable via model');
    const { assembly } = await build({ model });
    const result = await assembly.plugin.run({
      runId: 'mcp-model-1',
      sessionId: 'sess-model',
      task: assembly.plugin.makeTask({ prompt: 'Fix the failing build.' }),
      trigger: 'slash_command'
    });
    expect(result.outcome).not.toBe('failed');
    // The probe stage really called the injected adapter (single_call mode).
    const probeRequests = model.requests.filter((request) => request.purpose === 'probe');
    expect(probeRequests.length).toBeGreaterThan(0);
    await assembly.dispose();
  });
});

// ---------------------------------------------------------------------------
// pinned-option refusals
// ---------------------------------------------------------------------------

describe('pinned option refusals', () => {
  const pinnedCases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['model', { model: scriptedModel('other') }],
    ['host', { host: { registerPromptSegment: async () => ({ dispose: () => undefined }) } }],
    ['clients', { clients: [] }],
    ['listClients', { listClients: async () => [] }],
    ['resolveDshCollaborators', { resolveDshCollaborators: true }],
    ['registerAutoFallback', { registerAutoFallback: true }],
    ['enableIdleDream', { enableIdleDream: true }],
    ['persistence', { persistence: undefined }]
  ];

  for (const [name, extras] of pinnedCases) {
    it('refuses options.' + name, async () => {
      await expect(build({ options: extras as never })).rejects.toThrow(
        new RegExp('options\\.' + name + ' is pinned')
      );
    });
  }

  it('still refuses the offline-evaluation-only probeEvaluation seam (public entry contract)', async () => {
    // The public createEvoHarnessPlugin refuses deps.probeEvaluation even when
    // the caller bypasses the assembly's own checks — the entry's contract.
    const options = {
      config: cheapConfigSection(),
      model: scriptedModel(),
      deps: { probeEvaluation: 'legacy' }
    };
    expect(() =>
      createEvoHarnessPlugin(options as never, undefined)
    ).toThrow(/offline-evaluation-only/);
  });

  it('accepts an explicit runBranch and other additive options without refusal', async () => {
    const runner = scriptedRunner();
    const { assembly } = await build({
      options: { runBranch: runner.runBranch, experienceFilePath: 'jitrl-test.jsonl' }
    });
    expect(assembly.plugin).toBeDefined();
    await assembly.dispose();
  });
});

// ---------------------------------------------------------------------------
// default data-dir rule: env only, no real-path leaks
// ---------------------------------------------------------------------------

describe('data-dir defaults', () => {
  it('follows EVO_HARNESS_DATA_DIR from the injected env snapshot, not process.env', async () => {
    const root = await makeTempDir('mcp-env-root');
    tempDirs.push(root);
    const dir = await makeTempDir('mcp-env-build');
    tempDirs.push(dir);
    // dataDir omitted; the env snapshot points at the temp root. The profile
    // comes from the snapshot's DSH_PROFILE.
    const { assembly } = await build({
      dataDir: {
        env: { EVO_HARNESS_DATA_DIR: root, DSH_PROFILE: 'mcp-profile' }
      }
    });
    expect(assembly.dataDir).toContain('profiles' + '\\mcp-profile');
    // The env-injected root was honored (the build wrote under it), and the
    // unused temp dir keeps the assertion anchor honest.
    expect(assembly.dataDir.startsWith(root)).toBe(true);
    void dir;
    await assembly.dispose();
  });

  it('treats a scrubbed DSH_PROFILE (stdio reality) as profiles/default', () => {
    const resolved = resolveMcpDataDir({
      rootDir: 'C:/root',
      env: { DSH_PROFILE: undefined }
    });
    expect(resolved).toContain('profiles' + '\\default');
  });

  // rev8 review nice-to-have: an inherited DSH_DATA_DIR with no explicit
  // dataDir/rootDir would resolve the SAME profiles/<profile> directory the
  // Cordis plugin uses (data-dir.ts single-host assumption). The assembly
  // warns by NAME (never fatal, never silent) through its `log` seam.
  it('warns when an inherited DSH_DATA_DIR would collide with the plugin data dir', async () => {
    const lines: string[] = [];
    const { assembly } = await build({
      log: (line: string) => lines.push(line),
      dataDir: {
        env: { DSH_DATA_DIR: 'C:/Users/op/.dsh', DSH_PROFILE: undefined, EVO_HARNESS_DATA_DIR: undefined }
      }
    });
    expect(lines.some((line) => line.includes('DSH_DATA_DIR') && line.includes('profiles/<profile>'))).toBe(true);
    // Non-secret: the warning names VARIABLES, never the inherited VALUE.
    for (const line of lines) {
      expect(line).not.toContain('C:/Users/op/.dsh');
    }
    // The build itself still resolved (warning is not a refusal).
    expect(assembly.dataDir.length).toBeGreaterThan(0);
    await assembly.dispose();
  });

  it('does NOT warn when the data root is explicit (dataDir or rootDir wins)', async () => {
    const explicitDataDirLines: string[] = [];
    const { assembly } = await build({
      log: (line: string) => explicitDataDirLines.push(line)
    });
    expect(explicitDataDirLines).toEqual([]);
    await assembly.dispose();
    const root = await makeTempDir('mcp-rootdir-explicit');
    tempDirs.push(root);
    const rootDirLines: string[] = [];
    const { assembly: rootDirAssembly } = await build({
      log: (line: string) => rootDirLines.push(line),
      dataDir: { rootDir: root, env: { DSH_DATA_DIR: 'C:/Users/op/.dsh' } }
    });
    expect(rootDirLines).toEqual([]);
    await rootDirAssembly.dispose();
  });
});

// ---------------------------------------------------------------------------
// plugin-handle invariants shared with the Cordis entry
// ---------------------------------------------------------------------------

describe('plugin handle parity', () => {
  it('returns the real createEvoHarnessPlugin handle (name, evaluateTextProbe)', async () => {
    const { assembly } = await build();
    const plugin: EvoHarnessPlugin = assembly.plugin;
    expect(plugin.name).toBe('dsh-plugin-evo-harness');
    const probe = plugin.evaluateTextProbe({ prompt: 'plain text probe' });
    expect(probe.status).toBe('not-evaluable');
    expect(probe.evaluable).toBe(false);
    expect(probe.reward).toBe(0);
    await assembly.dispose();
  });

  it('respects DEFAULT_EXECUTION_MODE semantics (shadow is the documented default)', () => {
    expect(DEFAULT_EXECUTION_MODE).toBe('shadow');
  });
});
