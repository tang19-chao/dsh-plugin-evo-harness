/**
 * In-host single-MCP-backend smoke (P6.1-F, doc §9.3).
 *
 * Runs inside the installed DSH runtime (same launch as `probe.ts`). It drives
 * the plugin's real `createJitBridgeMirrorStore()` against ONE real stdio MCP
 * backend (`mcp-backend-server.mjs`) and records the five §9.3 obligations:
 *
 *   1. discovery  — the backend's tools/list is what the mirror sees;
 *   2. aggregate mirror — only aggregate statistics are written, once per row;
 *   3. no body echo — a canary-bearing backend rejection never reaches a
 *      diagnostic (the P6.1-B1 whitelist holds on a real transport too);
 *   4. off means off — a disabled mirror makes zero further backend calls;
 *   5. timeout / restart — a wedged call degrades, and a restart rediscovers
 *      the same tools with no duplicate write.
 *
 * Everything returned is structural: counts, names, booleans and bounded
 * diagnostic lines produced by the plugin itself (never backend text).
 */
import { createStdioMcpClient } from './mcp-client';
import type { StdioMcpClient } from './mcp-client';

/** Structural shape of the plugin's mirror store (see bundle-entry.ts). */
export interface MirrorStoreLike {
  mirror(rows: readonly unknown[]): Promise<{
    readonly written: number;
    readonly skipped: number;
    readonly namespaces: readonly string[];
    readonly degraded: boolean;
    readonly diagnostics: readonly string[];
  }>;
  namespaceFor(level: string): string;
  diagnostics(): readonly string[];
}

/** Factory the bundle exposes. */
export interface MirrorFactory {
  (options: Record<string, unknown>): MirrorStoreLike;
}

/** Result of the single-backend MCP smoke. */
export interface McpSmokeReport {
  readonly discovered: readonly string[];
  readonly writeNamespace: string;
  readonly aggregate: {
    readonly written: number;
    readonly skipped: number;
    readonly degraded: boolean;
    readonly namespaces: readonly string[];
  };
  readonly canary: {
    /** True when the mirror degraded on the canary-bearing row. */
    readonly degraded: boolean;
    /** True when the canary text appeared in ANY diagnostic line. */
    readonly leaked: boolean;
    /** True when any diagnostic line carries a non-whitelisted free-text shape. */
    readonly freeTextLine: boolean;
    readonly diagnostics: readonly string[];
  };
  readonly off: {
    /** Backend calls attributable to a disabled mirror (must be 0). */
    readonly backendCalls: number;
  };
  readonly timeout: {
    /** True when the wedged call settled instead of hanging the smoke. */
    readonly settled: boolean;
    readonly elapsedMs: number;
  };
  readonly restart: {
    readonly spawns: number;
    /** Tools rediscovered after restart are identical to the first discovery. */
    readonly sameTools: boolean;
    /** A repeated aggregate write after restart must not double-write. */
    readonly repeatWrite: number;
  };
  readonly notes: readonly string[];
}

/** Diagnostic lines the P6.1-B1 whitelist renders, as a prefix check. */
export const MIRROR_DIAG_PREFIX = 'mirror_diag ';

/**
 * Run the single-backend MCP smoke.
 *
 * Call order matters: discovery, then a real aggregate write, then the canary
 * rejection, then the disabled-mirror call count, then timeout, then restart.
 * Each step's counter is read from the backend itself (`hostsmoke_call_count`),
 * so "zero further calls" is measured at the backend, not in the client.
 */
export async function probeMcpBackend(input: {
  readonly createMirrorStore: MirrorFactory;
  readonly spawnProcess: (
    command: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> }
  ) => {
    readonly stdin: NodeJS.WritableStream;
    readonly stdout: NodeJS.ReadableStream;
    readonly stderr: NodeJS.ReadableStream;
    kill(): void;
    readonly pid?: number;
  };
  readonly executable: string;
  readonly serverScript: string;
  readonly workingDir: string;
  readonly canary: string;
  readonly requestTimeoutMs: number;
}): Promise<McpSmokeReport> {
  const notes: string[] = [];
  const client: StdioMcpClient = await createStdioMcpClient(
    {
      serverId: 'hostsmoke-mcp',
      command: input.executable,
      args: [input.serverScript],
      cwd: input.workingDir,
      env: { ...process.env as Record<string, string>, HOSTSMOKE_CANARY: input.canary },
      timeoutMs: input.requestTimeoutMs
    },
    input.spawnProcess
  );

  try {
    // --- 1. discovery -------------------------------------------------------
    const discovered = (await client.listTools()).map((tool) => tool.name).sort();
    notes.push('discovered=' + discovered.join(','));

    const mirror = input.createMirrorStore({
      mirrorToMemoryBridge: true,
      namespacePrefix: 'hostsmoke',
      client,
      onDiagnostic: () => undefined
    });
    const writeNamespace = mirror.namespaceFor('host_tool');

    // --- 2. aggregate mirror ------------------------------------------------
    const aggregateRow = {
      bucket: 'hostsmoke-bucket',
      actionKey: 'tool:hostsmoke_echo',
      level: 'host_tool',
      n: 3,
      meanReturn: 0.5,
      variance: 0.25,
      updatedAt: 1_700_000_000_000
    };
    const first = await mirror.mirror([aggregateRow]);
    notes.push('aggregate written=' + String(first.written) + ' degraded=' + String(first.degraded));

    // --- 3. canary rejection: degrade, never echo ---------------------------
    const canaryRow = {
      bucket: input.canary,
      actionKey: 'tool:hostsmoke_canary',
      level: 'host_tool',
      n: 1,
      meanReturn: 0,
      variance: 0,
      updatedAt: 1_700_000_000_001
    };
    const canaryMirror = await mirror.mirror([canaryRow]);
    const storeDiagnostics = [...mirror.diagnostics()];
    const canaryLeaked = storeDiagnostics.some((line) => line.toLowerCase().includes(input.canary.toLowerCase()));
    // Any line that is not the whitelisted renderer shape would be a new echo
    // channel; the check is a shape assertion, not a substring guess.
    const freeTextLine = storeDiagnostics.some(
      (line) =>
        !line.startsWith(MIRROR_DIAG_PREFIX) ||
        !/code=[a-z_]+ phase=[a-z_]+ operation=[A-Za-z]+ retryable=(true|false) errorClass=[a-z_]+/.test(line)
    );
    notes.push(
      'canary degraded=' + String(canaryMirror.degraded) + ' leaked=' + String(canaryLeaked) + ' freeText=' + String(freeTextLine)
    );

    // --- 4. a DISABLED mirror must not touch the backend --------------------
    // The backend's counter tool does not count itself, so the delta between
    // two reads is exactly the calls the disabled mirror made.
    const beforeOff = await readCallCount(client);
    const offMirror = input.createMirrorStore({
      mirrorToMemoryBridge: false,
      namespacePrefix: 'hostsmoke',
      client
    });
    await offMirror.mirror([aggregateRow, aggregateRow]);
    const afterOff = await readCallCount(client);
    const backendCallsWhileOff = afterOff - beforeOff;
    notes.push('disabled mirror backend calls=' + String(backendCallsWhileOff));

    // --- 5. timeout: a wedged call settles, it does not hang the smoke ------
    // The whole smoke runs on ONE backend; a real deadline is exercised here on
    // the backend's slow tool with a deliberately short client timeout.
    const timeoutStart = Date.now();
    let timeoutSettled = false;
    try {
      await client.callTool('hostsmoke_slow', { ms: 2_000 }, { timeoutMs: 250 });
    } catch {
      timeoutSettled = true;
    }
    const timeoutElapsedMs = Date.now() - timeoutStart;
    notes.push('timeout settled=' + String(timeoutSettled) + ' elapsed=' + String(timeoutElapsedMs));

    // --- 6. restart: identical discovery, no duplicate write ---------------
    await client.restart();
    const rediscovered = (await client.listTools()).map((tool) => tool.name).sort();
    // The backend's in-memory duplicate guard is fresh after a restart, so an
    // idempotence check has to be about the MIRROR: the same aggregate must
    // produce exactly one write per mirror() call, never a fan-out.
    const repeatMirror = input.createMirrorStore({
      mirrorToMemoryBridge: true,
      namespacePrefix: 'hostsmoke',
      client
    });
    const repeat = await repeatMirror.mirror([aggregateRow]);
    notes.push('restart spawns=' + String(client.spawnCount) + ' repeatWrite=' + String(repeat.written));

    return {
      discovered,
      writeNamespace,
      aggregate: {
        written: first.written,
        skipped: first.skipped,
        degraded: first.degraded,
        namespaces: first.namespaces
      },
      canary: {
        degraded: canaryMirror.degraded,
        leaked: canaryLeaked,
        freeTextLine,
        diagnostics: storeDiagnostics
      },
      off: { backendCalls: backendCallsWhileOff },
      timeout: { settled: timeoutSettled, elapsedMs: timeoutElapsedMs },
      restart: {
        spawns: client.spawnCount,
        sameTools: rediscovered.join(',') === discovered.join(','),
        repeatWrite: repeat.written
      },
      notes
    };
  } finally {
    await client.close();
  }
}

/** Read the backend-side call counter (a count, never a payload). */
async function readCallCount(client: StdioMcpClient): Promise<number> {
  const result = await client.callTool('hostsmoke_call_count', {});
  const record = result !== null && typeof result === 'object' ? (result as Record<string, unknown>) : {};
  const structured = record['structuredContent'];
  if (structured !== null && typeof structured === 'object') {
    const calls = (structured as Record<string, unknown>)['calls'];
    if (typeof calls === 'number' && Number.isFinite(calls)) {
      return calls;
    }
  }
  return Number.NaN;
}
