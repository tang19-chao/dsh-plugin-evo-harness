/**
 * MCP server lifecycle: LAZY assembly startup, explicit warm-up, and teardown
 * of a build that is still in flight.
 *
 * THE DEFECT THIS FILE PINS
 *   `createEvoMcpServer` used to fire `void ready()` at construction
 *   (src/mcp/server.ts, the old line 570). `buildEvoAssembly` is not
 *   side-effect free: it resolves the profile directory, `mkdir`s it
 *   (src/persistence/index.ts:110), opens the tree-pool log and the policy
 *   store and runs the plugin's cold-start JitRL backfill. So merely
 *   CONSTRUCTING a server — or starting the stdio process and never calling a
 *   tool — created and wrote the persistence data directory, contradicting the
 *   `dryRun` contract the server itself advertises ("nothing was started and
 *   nothing was written (no data directory was created)") and README.md:264.
 *
 * WHAT IS ASSERTED (every point is a real filesystem observation)
 *   1. construction with zero tool calls creates NOTHING on disk;
 *   2. a dryRun preview creates nothing (and mints no job record);
 *   3. the same zero-side-effect guarantee holds for a NESTED, not-yet-existing
 *      directory chain, whether it is named explicitly or derived from the
 *      documented env root + `profiles/<name>` layout;
 *   4. the FIRST genuine tool call is what initializes the assembly (and its
 *      directory);
 *   5. an explicit `await instance.ready` warm-up plus `dispose()` tears the
 *      assembly down AND stops it writing: the on-disk listing is byte-stable
 *      across a settle window after dispose;
 *   6. `dispose()` called while the build is STILL UNRESOLVED awaits that build
 *      and disposes what it produced — the orchestrator of the captured handle
 *      reports `isDisposed()`, so no background persistence runtime outlives
 *      teardown;
 *   7. a FAILED build is reported by each tool through its own error result,
 *      and the rejected warm-up never becomes an unhandled rejection.
 *
 * OFFLINE: scripted model only (no network, no gateway, no key), an explicit
 * data directory under the shared temp root, and an injected env snapshot, so
 * the real process environment and the real `~/.dsh` tree are never consulted.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createEvoMcpServer, EVO_MCP_DISPOSED_MESSAGE, EVO_TOOL_NAMES } from '../../../src/mcp/server';
import type { IModelAdapter, ModelRequest, ModelResponse } from '../../../src/types/contracts';
import { cleanupDir, makeTempDir } from '../persistence/fixtures';

// ---------------------------------------------------------------------------
// deterministic scripted model (the same shape the other MCP unit suites use)
// ---------------------------------------------------------------------------

function scriptedModel(): IModelAdapter {
  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      if (request.purpose === 'propose') {
        return {
          text: JSON.stringify({
            rationale: 'Pin the deliverable format so scoring stops guessing.',
            focusSurfaces: ['guardrails'],
            confidence: 0.7,
            expectedStepsDelta: -1,
            edits: {
              guardrails: {
                kind: 'guardrails',
                formatContract: 'Return minified JSON only.',
                appendRules: ['declare the failing tool before retrying']
              }
            }
          }),
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
            assessments: aliases.map((alias, index) => ({ alias, rationale: 'judge ' + String(index) }))
          }),
          finishReason: 'stop',
          model: 'scripted'
        };
      }
      if (request.purpose === 'reflect') {
        return { text: JSON.stringify({ lessons: [] }), finishReason: 'stop', model: 'scripted' };
      }
      return { text: 'scripted deliverable', finishReason: 'stop', model: 'scripted' };
    }
  };
}

/** Raw config section shrunk for offline cost (defaults keep production semantics). */
function cheapConfig(): Record<string, unknown> {
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

/** The env snapshot every assembly receives: no inherited DSH/Evo data root. */
const ISOLATED_ENV = {
  EVO_HARNESS_DATA_DIR: undefined,
  DSH_DATA_DIR: undefined,
  DSH_PROFILE: undefined
} as const;

// ---------------------------------------------------------------------------
// scaffolding
// ---------------------------------------------------------------------------

interface DirectTool {
  readonly handler: (args: Record<string, unknown>, context: unknown) => Promise<any>;
}

interface ToolRegistry {
  readonly _registeredTools: Record<string, DirectTool>;
}

interface ToolReply {
  readonly isError?: boolean;
  readonly content: readonly { readonly type: string; readonly text: string }[];
  readonly structuredContent: Record<string, any>;
}

const tempDirs: string[] = [];
const instances: ReturnType<typeof createEvoMcpServer>[] = [];

afterEach(async () => {
  for (const instance of instances.splice(0, instances.length)) {
    await instance.dispose().catch(() => {});
  }
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await cleanupDir(dir).catch(() => {});
  }
});

/** A fresh temp dir; `child` names a path under it that must NOT exist yet. */
async function makeParent(label: string): Promise<string> {
  const parent = await makeTempDir(label);
  tempDirs.push(parent);
  return parent;
}

function build(
  dataDirOptions: Record<string, unknown>,
  extra: { readonly log?: (line: string) => void } = {}
): ReturnType<typeof createEvoMcpServer> {
  const instance = createEvoMcpServer({
    model: scriptedModel(),
    now: (() => {
      let tick = 1_700_000_000_000;
      return () => (tick += 1);
    })(),
    ...(extra.log === undefined ? {} : { log: extra.log }),
    assembly: { config: cheapConfig(), dataDir: dataDirOptions }
  });
  instances.push(instance);
  return instance;
}

/** Call one registered tool handler directly (no transport, no reimplementation). */
function call(instance: ReturnType<typeof createEvoMcpServer>, name: string, args: Record<string, unknown>): Promise<ToolReply> {
  const registry = instance.server as unknown as ToolRegistry;
  const tool = registry._registeredTools[name];
  expect(tool, 'tool ' + name + ' is registered').toBeDefined();
  return tool!.handler(args, {});
}

/**
 * Every path under `root` with its size and mtime, sorted — a listing that
 * changes if ANY byte is written. Used to prove a disposed assembly stopped
 * writing (a leak would show up as a new file or a moved mtime).
 */
function diskState(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push('dir  ' + full);
        walk(full);
      } else {
        const info = statSync(full);
        out.push('file ' + full + ' size=' + String(info.size) + ' mtime=' + String(info.mtimeMs));
      }
    }
  };
  walk(root);
  return out.sort();
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 1-3. construction and preview are side-effect free
// ---------------------------------------------------------------------------

describe('lazy assembly startup', () => {
  it('constructing a server with ZERO tool calls creates no data directory', async () => {
    const parent = await makeParent('mcp-lazy-construct');
    const dataDir = path.join(parent, 'data');
    expect(existsSync(dataDir)).toBe(false);

    const instance = build({ dataDir, env: ISOLATED_ENV });

    // Give any eager (buggy) build a full macrotask turn to run its mkdir: the
    // old `void ready()` resolved within a handful of microtasks plus one
    // fs.mkdir, so a 150 ms window is far more than the defect needed.
    await settle(150);
    expect(existsSync(dataDir)).toBe(false);
    // The parent's listing is unchanged too: nothing was created beside it.
    expect(readdirSync(parent)).toEqual([]);
    // The book is live but empty — construction itself starts no work.
    expect(instance.jobCounts()).toEqual({ running: 0, retained: 0 });
    expect(Object.keys((instance.server as unknown as ToolRegistry)._registeredTools).sort()).toEqual(
      [...EVO_TOOL_NAMES].sort()
    );

    // Disposing a never-used server is a clean no-op that still creates nothing.
    await instance.dispose();
    expect(existsSync(dataDir)).toBe(false);
  });

  it('a dryRun preview returns its reply and creates no data directory', async () => {
    const parent = await makeParent('mcp-lazy-dryrun');
    const dataDir = path.join(parent, 'data');
    const instance = build({ dataDir, env: ISOLATED_ENV });

    const reply = await call(instance, 'evo_run_submit', { prompt: 'preview only', dryRun: true });
    expect(reply.isError).toBeFalsy();
    expect(reply.structuredContent.payload.dryRun).toBe(true);
    expect(String(reply.structuredContent.payload.note)).toContain('no data directory was created');
    // The claim in the note is TRUE: nothing was created, and no job was minted.
    expect(existsSync(dataDir)).toBe(false);
    expect(readdirSync(parent)).toEqual([]);
    expect(instance.jobCounts()).toEqual({ running: 0, retained: 0 });

    await instance.dispose();
    expect(existsSync(dataDir)).toBe(false);
  });

  it('a dryRun preview of a real prompt never resolves the assembly either (failed build is invisible to it)', async () => {
    // The data directory path runs through an existing FILE, so a build would
    // fail. A successful dryRun therefore proves operationally that the
    // preview reaches no assembly at all.
    const parent = await makeParent('mcp-lazy-dryrun-blocked');
    const blocker = path.join(parent, 'occupied.txt');
    await writeFile(blocker, 'not a directory', 'utf8');
    const instance = build({ dataDir: blocker, env: ISOLATED_ENV });

    const reply = await call(instance, 'evo_run_submit', {
      prompt: 'preview against an impossible data dir',
      dryRun: true,
      sessionId: 'sess-preview',
      runId: 'preview-run-1',
      cwd: 'C:/tmp/preview-workspace'
    });
    expect(reply.isError).toBeFalsy();
    const preview = reply.structuredContent.payload;
    expect(preview.request).toMatchObject({
      sessionId: 'sess-preview',
      runId: 'preview-run-1',
      cwd: 'C:/tmp/preview-workspace',
      trigger: 'slash_command'
    });
    await instance.dispose();
  });

  it('keeps the zero-side-effect guarantee for a NESTED explicit directory chain', async () => {
    const parent = await makeParent('mcp-lazy-nested');
    // None of these segments exists yet: only a real mkdir could create them.
    const dataDir = path.join(parent, 'a', 'b', 'c', 'data');
    const instance = build({ dataDir, env: ISOLATED_ENV });

    await settle(150);
    expect(existsSync(path.join(parent, 'a'))).toBe(false);
    expect(existsSync(dataDir)).toBe(false);

    await instance.dispose();
    expect(existsSync(path.join(parent, 'a'))).toBe(false);
  });

  it('creates nothing for the env-root + profiles/<name> layout either', async () => {
    // No explicit dataDir/rootDir: the documented resolution produces
    // <EVO_HARNESS_DATA_DIR>/profiles/<profile>. The injected env keeps the
    // real ~/.dsh tree out of the test entirely.
    const root = await makeParent('mcp-lazy-env-root');
    const instance = build({ env: { ...ISOLATED_ENV, EVO_HARNESS_DATA_DIR: root } });

    await settle(150);
    // The root itself is the test's own temp dir (it exists by construction);
    // nothing the server resolves may appear under it.
    expect(readdirSync(root)).toEqual([]);
    expect(existsSync(path.join(root, 'profiles'))).toBe(false);

    await instance.dispose();
    expect(readdirSync(root)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. the first real tool call is what initializes
// ---------------------------------------------------------------------------

describe('first real use initializes', () => {
  it('only a genuine tool call materializes the assembly and its directory', async () => {
    const parent = await makeParent('mcp-first-use');
    const dataDir = path.join(parent, 'data');
    const logs: string[] = [];
    const instance = build({ dataDir, env: ISOLATED_ENV }, { log: (line) => logs.push(line) });

    await settle(100);
    expect(existsSync(dataDir)).toBe(false);

    // evo_lessons never awaits the assembly (an honest empty page), so it is
    // NOT an initializing call — asserted so the split stays explicit.
    const lessons = await call(instance, 'evo_lessons', { limit: 1 });
    expect(lessons.isError).toBeFalsy();
    expect(lessons.structuredContent.payload.counts.returned).toBe(0);
    expect(existsSync(dataDir)).toBe(false);

    // evo_status IS an initializing call: this is the first real use.
    const status = await call(instance, 'evo_status', {});
    expect(status.isError).toBeFalsy();
    expect(existsSync(dataDir)).toBe(true);
    // The status reports the directory it really resolved.
    expect(String(status.structuredContent.payload.dataDir).toLowerCase()).toBe(dataDir.toLowerCase());

    await instance.dispose();
    // A created-and-used directory is released, not deleted (documented).
    expect(existsSync(dataDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5-6. teardown, including disposal during startup
// ---------------------------------------------------------------------------

describe('teardown', () => {
  it('an explicit ready warm-up + dispose flushes the assembly and stops all writing', async () => {
    const parent = await makeParent('mcp-warmup-dispose');
    const dataDir = path.join(parent, 'data');
    const instance = build({ dataDir, env: ISOLATED_ENV });

    // The explicit warm-up: reading the handle's `ready` starts the build.
    const assembly = await instance.ready;
    expect(assembly.dataDir.toLowerCase()).toBe(dataDir.toLowerCase());
    expect(existsSync(dataDir)).toBe(true);
    expect(assembly.plugin.orchestrator.isDisposed()).toBe(false);

    // Generate queued persistence work before teardown: one full scripted run.
    const submitted = await call(instance, 'evo_run_submit', {
      prompt: 'Fix the failing build.',
      sessionId: 'sess-lifecycle'
    });
    expect(submitted.isError).toBeFalsy();
    const runId: string = submitted.structuredContent.payload.runId;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (instance.pollJob(runId).status !== 'running') {
        break;
      }
      await settle(25);
    }
    expect(['complete', 'failed']).toContain(instance.pollJob(runId).status);

    await instance.dispose();
    expect(assembly.plugin.orchestrator.isDisposed()).toBe(true);

    // THE LEAK CHECK: nothing writes after dispose. A post-flush append (a
    // late queue item, a stray timer) would add a file or move an mtime.
    const afterDispose = diskState(dataDir);
    expect(afterDispose.length).toBeGreaterThan(0);
    await settle(200);
    expect(diskState(dataDir)).toEqual(afterDispose);

    // Teardown is idempotent.
    await expect(instance.dispose()).resolves.toBeUndefined();
    expect(diskState(dataDir)).toEqual(afterDispose);
  });

  it('dispose DURING startup awaits the in-flight build and disposes what it produced', async () => {
    const parent = await makeParent('mcp-dispose-instartup');
    const dataDir = path.join(parent, 'data');

    // Build a server whose construction is side-effect free, then start the
    // warm-up and dispose in the SAME tick: at that instant the assembly
    // promise exists but is unresolved (the build has real fs awaits ahead).
    const instance = createEvoMcpServer({
      model: scriptedModel(),
      assembly: { config: cheapConfig(), dataDir: { dataDir, env: ISOLATED_ENV } }
    });
    instances.push(instance);

    let buildResolved = false;
    const warmUp = instance.ready;
    void warmUp.then(() => {
      buildResolved = true;
    });
    // Nothing has resolved yet, so the assertions below really are about a
    // build in flight rather than a completed one.
    expect(buildResolved).toBe(false);

    const disposePromise = instance.dispose();
    expect(buildResolved).toBe(false);

    // The started warm-up still yields the handle it produced...
    const assembly = await warmUp;
    await disposePromise;

    // ...and that handle was torn down: no background persistence runtime
    // outlives the dispose that raced its own startup.
    expect(assembly.plugin.orchestrator.isDisposed()).toBe(true);
    expect(existsSync(dataDir)).toBe(true);
    const state = diskState(dataDir);
    await settle(200);
    expect(diskState(dataDir)).toEqual(state);

    // After the latch, no tool may resurrect an assembly (which would create
    // or reopen the directory behind a closed server).
    const status = await call(instance, 'evo_status', {});
    expect(status.isError).toBe(true);
    expect(status.structuredContent.ok).toBe(false);
    expect(status.structuredContent.code).toBe('evo_status_failed');
    // The refusal is the named, stable one — not just any error.
    expect(String(status.structuredContent.message)).toContain(EVO_MCP_DISPOSED_MESSAGE);
    expect(String(status.content[0]?.text)).toContain(EVO_MCP_DISPOSED_MESSAGE);
    expect(diskState(dataDir)).toEqual(state);
  });
});

// ---------------------------------------------------------------------------
// 7. a failed build is reported by the tools, never an unhandled rejection
// ---------------------------------------------------------------------------

describe('failed assembly build', () => {
  it('is reported through each tool\'s own error result and produces no unhandled rejection', async () => {
    const parent = await makeParent('mcp-build-failure');
    // A path through an existing FILE: mkdir(recursive) fails, so the build
    // rejects exactly as a misconfigured deployment would.
    const blocker = path.join(parent, 'occupied.txt');
    await writeFile(blocker, 'not a directory', 'utf8');

    const instance = build({ dataDir: blocker, env: ISOLATED_ENV });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      // Reading `ready` starts the build and this reference is DROPPED with no
      // catch at all — the harshest shape. The constructor's own `.then(...,
      // () => undefined)` observer marks the rejection handled, so the failure
      // stays a value the tools report instead of crashing the process.
      void instance.ready;

      const status = await call(instance, 'evo_status', {});
      expect(status.isError).toBe(true);
      expect(status.structuredContent.ok).toBe(false);
      expect(status.structuredContent.code).toBe('evo_status_failed');
      expect(status.structuredContent.message.length).toBeGreaterThan(0);

      // The other assembly-touching tools report the same failure under their
      // OWN stable codes rather than escaping to the SDK.
      const submit = await call(instance, 'evo_run_submit', { prompt: 'real run against a broken data dir' });
      expect(submit.isError).toBe(true);
      expect(submit.structuredContent.code).toBe('submit_failed');

      const probe = await call(instance, 'evo_text_probe', { prompt: 'probe' });
      expect(probe.isError).toBe(true);
      expect(probe.structuredContent.code).toBe('evo_text_probe_failed');

      const dream = await call(instance, 'evo_dream', {});
      expect(dream.isError).toBe(true);
      expect(dream.structuredContent.code).toBe('evo_dream_failed');

      // evo_lessons needs no assembly: an honest empty page, never an error.
      const lessons = await call(instance, 'evo_lessons', { limit: 3 });
      expect(lessons.isError).toBeFalsy();
      expect(lessons.structuredContent.payload).toMatchObject({
        lessons: [],
        dreamReports: [],
        counts: { lessons: 0, dreamReports: 0, returned: 0 }
      });

      // The rejected warm-up is a real rejection the caller can observe...
      await expect(instance.ready).rejects.toThrow();
      // ...and a settle window passes with nothing escaping unhandled.
      await settle(150);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    // dispose() observes the failure instead of hiding it (the caller learns
    // teardown was not clean); the blocked path is still just the file.
    await expect(instance.dispose()).rejects.toThrow();
    expect(existsSync(blocker)).toBe(true);
  });
});
