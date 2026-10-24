/**
 * MCP stdio client for the smoke (P6.1-F, doc §9.3).
 *
 * A minimal, dependency-free MCP client over newline-delimited JSON-RPC. It is
 * deliberately NOT a wrapper around `@modelcontextprotocol/client`: the smoke
 * must prove the *plugin's* mirror behaves on a real transport, and a client we
 * control keeps the failure injection (deadline, restart, call counting) honest.
 * The client mirrors the two operations the mirror store consumes
 * (`tools/list` + `tools/call`) so it is a drop-in `JitMirrorMcpClient`.
 *
 * Every response is returned by reference to the JSON-RPC envelope only; no
 * `result.content[].text` of a failing call is ever surfaced, which is what
 * makes the "no canary in diagnostics" assertion meaningful.
 */

/** One tool descriptor as `tools/list` returns it. */
export interface McpToolDescriptorShape {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

/** Options for {@link createStdioMcpClient}. */
export interface StdioMcpClientOptions {
  readonly serverId: string;
  /** Executable to spawn (the DSH runtime node). */
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Per-request deadline. */
  readonly timeoutMs: number;
}

/** The client the mirror store consumes. */
export interface StdioMcpClient {
  readonly serverId: string;
  listTools(options?: { readonly timeoutMs?: number }): Promise<readonly McpToolDescriptorShape[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { readonly timeoutMs?: number }
  ): Promise<unknown>;
  /** Current backend process count (1 after construction, 2 after one restart). */
  readonly spawnCount: number;
  /** Stop the process and start a new one; rediscovery must be identical. */
  restart(): Promise<void>;
  close(): Promise<void>;
  /** Requests issued since construction (discovery + calls). */
  readonly requestCount: number;
  /** Backend stderr BYTES emitted so far (counted, never read as text). */
  readonly stderrBytes: number;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Create one stdio MCP client. Construction spawns the backend immediately and
 * performs the `initialize` handshake, so a client that resolves is a backend
 * that started.
 */
export async function createStdioMcpClient(
  options: StdioMcpClientOptions,
  spawnProcess: (command: string, args: readonly string[], options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
  }) => {
    readonly stdin: NodeJS.WritableStream;
    readonly stdout: NodeJS.ReadableStream;
    readonly stderr: NodeJS.ReadableStream;
    kill(): void;
    readonly pid?: number;
  }
): Promise<StdioMcpClient> {
  let child: ReturnType<typeof spawnProcess> | undefined;
  let spawnCount = 0;
  let requestCount = 0;
  let nextId = 1;
  let closed = false;
  let stderrBytes = 0;
  const pending = new Map<number, PendingRequest>();
  let buffer = '';

  const detach = (): void => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('mcp client closed'));
    }
    pending.clear();
  };

  const onData = (chunk: Buffer | string): void => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (line.length === 0) {
        continue;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = parsed['id'];
      if (typeof id !== 'number') {
        continue;
      }
      const entry = pending.get(id);
      if (entry === undefined) {
        continue;
      }
      pending.delete(id);
      clearTimeout(entry.timer);
      if (parsed['error'] !== undefined) {
        // Only the JSON-RPC error code is surfaced: never a message body.
        const code = (parsed['error'] as Record<string, unknown>)['code'];
        entry.reject(new Error('mcp rpc error code=' + String(code)));
      } else {
        entry.resolve(parsed['result']);
      }
    }
  };

  const request = (method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> => {
    if (child === undefined) {
      return Promise.reject(new Error('mcp backend is not running'));
    }
    const id = nextId;
    nextId += 1;
    requestCount += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('mcp request timed out after ' + String(timeoutMs) + 'ms'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child?.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };

  const start = async (): Promise<void> => {
    child = spawnProcess(options.command, options.args, { cwd: options.cwd, env: options.env });
    spawnCount += 1;
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk: Buffer | string) => {
      // Counted, never inspected: a backend's stderr is host text.
      stderrBytes += typeof chunk === 'string' ? chunk.length : chunk.length;
    });
    await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'hostsmoke-client', version: '1.0.0' }
    }, options.timeoutMs);
    if (child !== undefined) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    }
  };

  await start();

  const client: StdioMcpClient = {
    serverId: options.serverId,
    async listTools(callOptions?: { readonly timeoutMs?: number }): Promise<readonly McpToolDescriptorShape[]> {
      const result = await request('tools/list', {}, callOptions?.timeoutMs ?? options.timeoutMs);
      const record = result !== null && typeof result === 'object' ? (result as Record<string, unknown>) : {};
      const tools = Array.isArray(record['tools']) ? (record['tools'] as readonly unknown[]) : [];
      return tools
        .filter(
          (tool): tool is McpToolDescriptorShape =>
            tool !== null && typeof tool === 'object' && typeof (tool as Record<string, unknown>)['name'] === 'string'
        )
        .map((tool) => ({
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema })
        }));
    },
    async callTool(
      name: string,
      args: Record<string, unknown>,
      callOptions?: { readonly timeoutMs?: number }
    ): Promise<unknown> {
      return request('tools/call', { name, arguments: args }, callOptions?.timeoutMs ?? options.timeoutMs);
    },
    get spawnCount(): number {
      return spawnCount;
    },
    get requestCount(): number {
      return requestCount;
    },
    get stderrBytes(): number {
      return stderrBytes;
    },
    async restart(): Promise<void> {
      if (closed) {
        return;
      }
      detach();
      child?.kill();
      child = undefined;
      buffer = '';
      await start();
    },
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      detach();
      child?.kill();
      child = undefined;
    }
  };
  return client;
}
