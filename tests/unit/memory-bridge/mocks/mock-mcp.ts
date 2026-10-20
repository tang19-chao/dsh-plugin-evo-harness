/**
 * Deterministic in-memory MCP memory server fakes for the required mock
 * families (graph-entity, vector-fact, temporal, markdown-note, lingshu-mdcg,
 * custom-mapped). No network, no host, no LLM: every call is recorded so unit
 * tests can assert the exact mapping performed by each driver.
 */

import { isLessonDocument, parseLessonDocument, serializeLesson } from '../../../../src/memory-bridge/lesson-codec';
import type { CanonicalLesson } from '../../../../src/types/contracts';
import type { McpClient, McpToolCallResult, McpToolDescriptor } from '../../../../src/memory-bridge/spi';

export interface MockCall {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

export interface StoredRecord {
  readonly id: string;
  readonly namespace: string;
  readonly text: string;
  readonly createdAt: number;
  readonly polarity: string;
  readonly path?: string;
}

export interface MockServer {
  readonly client: McpClient;
  readonly calls: MockCall[];
  readonly store: StoredRecord[];
  listToolsCalls: number;
  callsTo(tool: string): MockCall[];
  lastCall(tool: string): MockCall | undefined;
  reset(): void;
}

export interface MockServerOptions {
  readonly serverId?: string;
  /** When false the server ignores namespace filters (legacy/blind backend). */
  readonly enforceNamespace?: boolean;
  /** When true writes answer with a backend rejection verdict. */
  readonly rejectWrites?: boolean;
  /** Tools that never resolve (proves the timeout/degradation path). */
  readonly hangTools?: readonly string[];
  /** Return tool results as text JSON instead of structuredContent. */
  readonly structured?: boolean;
  /** Pre-seeded records. */
  readonly seed?: readonly SeedRecord[];
}

export interface SeedRecord {
  readonly lesson: CanonicalLesson;
  readonly namespace: string;
  readonly text?: string;
  readonly path?: string;
}

export type MockHandler = (args: Record<string, unknown>, server: MockServer) => unknown;

const LESSON_MARKER = 'harness_lesson';

/** Build the shared mock plumbing plus per-family tool handlers. */
export function createMockServer(
  tools: readonly McpToolDescriptor[],
  handlers: Readonly<Record<string, MockHandler>>,
  options: MockServerOptions = {}
): MockServer {
  const calls: MockCall[] = [];
  const store: StoredRecord[] = [];
  for (const seed of options.seed ?? []) {
    store.push({
      id: seed.lesson.id,
      namespace: seed.namespace,
      text: seed.text ?? serializeLesson(seed.lesson, { namespace: seed.namespace }),
      createdAt: seed.lesson.createdAt ?? 0,
      polarity: seed.lesson.polarity,
      ...(seed.path === undefined
        ? {}
        : { path: seed.path })
    });
  }
  const server: MockServer = {
    calls,
    store,
    listToolsCalls: 0,
    callsTo(tool: string): MockCall[] {
      return calls.filter((call) => call.tool === tool);
    },
    lastCall(tool: string): MockCall | undefined {
      const matching = calls.filter((call) => call.tool === tool);
      return matching[matching.length - 1];
    },
    reset(): void {
      calls.length = 0;
      server.listToolsCalls = 0;
    },
    client: {
      serverId: options.serverId ?? 'mock-memory',
      async listTools(): Promise<readonly McpToolDescriptor[]> {
        server.listToolsCalls += 1;
        return tools;
      },
      async callTool(
        name: string,
        args: Record<string, unknown>,
        callOptions?: { readonly signal?: AbortSignal }
      ): Promise<McpToolCallResult> {
        calls.push({ tool: name, args });
        if (options.hangTools !== undefined && options.hangTools.includes(name)) {
          return await new Promise<McpToolCallResult>((_resolve, reject) => {
            const signal = callOptions?.signal;
            const fail = (): void => reject(new Error('mock tool aborted: ' + name));
            if (signal === undefined) {
              return;
            }
            if (signal.aborted) {
              fail();
            } else {
              signal.addEventListener('abort', fail, { once: true });
            }
          });
        }
        const handler = handlers[name];
        if (handler === undefined) {
          return { isError: true, content: [{ type: 'text', text: 'unknown tool ' + name }] };
        }
        return toResult(handler(args, server), options);
      }
    }
  };
  return server;
}

function toResult(value: unknown, options: MockServerOptions): McpToolCallResult {
  if (typeof value === 'string') {
    return { content: [{ type: 'text', text: value }] };
  }
  const text = JSON.stringify(value);
  if (options.structured === false) {
    return { content: [{ type: 'text', text }] };
  }
  return { content: [{ type: 'text', text }], structuredContent: value as never };
}

function props(shape: Readonly<Record<string, string>>): never {
  const properties: Record<string, { type: string }> = {};
  for (const [key, type] of Object.entries(shape)) {
    properties[key] = { type };
  }
  return { properties } as never;
}

// ---------------------------------------------------------------------------
// shared payload helpers
// ---------------------------------------------------------------------------

/** Extract the first serialized lesson + namespace from arbitrary tool args. */
export function extractLessonFromArgs(
  args: Record<string, unknown>
): { lesson: CanonicalLesson; namespace: string; text: string } | undefined {
  let found: { lesson: CanonicalLesson; namespace: string; text: string } | undefined;
  walk(args, undefined, 0);
  return found;

  function walk(node: unknown, inheritedNs: string | undefined, depth: number): void {
    if (found !== undefined || depth > 10 || node === null || node === undefined) {
      return;
    }
    if (typeof node === 'string') {
      if (!isLessonDocument(node)) {
        return;
      }
      const parsed = parseLessonDocument(node);
      if (parsed === undefined) {
        return;
      }
      found = { lesson: parsed.lesson, namespace: parsed.namespace || inheritedNs || '', text: node };
      return;
    }
    if (Array.isArray(node)) {
      for (const entry of node) {
        walk(entry, inheritedNs, depth + 1);
      }
      return;
    }
    if (typeof node !== 'object') {
      return;
    }
    const record = node as Record<string, unknown>;
    let namespace = inheritedNs;
    for (const key of ['namespace', 'group_id', 'user_id']) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) {
        namespace = value;
        break;
      }
    }
    for (const value of Object.values(record)) {
      walk(value, namespace, depth + 1);
    }
  }
}

/** Namespace declared by explicit namespace-ish argument keys. */
export function namespaceFromArgs(args: Record<string, unknown>): string | undefined {
  for (const key of ['user_id', 'userId', 'namespace', 'group_id', 'groupId', 'container']) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  const groupIds = args.group_ids;
  if (Array.isArray(groupIds) && typeof groupIds[0] === 'string') {
    return groupIds[0];
  }
  const metadata = args.metadata;
  if (metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const nested = (metadata as Record<string, unknown>).namespace;
    if (typeof nested === 'string' && nested.length > 0) {
      return nested;
    }
  }
  return undefined;
}

/** Store the lesson carried by a write call. */
export function storeLesson(
  server: MockServer,
  args: Record<string, unknown>,
  namespace: string | undefined,
  path?: string
): StoredRecord | undefined {
  const found = extractLessonFromArgs(args);
  if (found === undefined) {
    return undefined;
  }
  const resolved = namespace ?? namespaceFromArgs(args) ?? found.namespace;
  const record: StoredRecord = {
    id: found.lesson.id,
    namespace: resolved,
    text: found.text,
    createdAt: found.lesson.createdAt ?? 0,
    polarity: found.lesson.polarity,
    ...(path === undefined ? {} : { path })
  };
  server.store.push(record);
  return record;
}

/** Every namespace a read call asked for (string or list valued fields). */
export function namespacesFromArgs(args: Record<string, unknown>): string[] | undefined {
  const list: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value.length > 0) {
      list.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string' && entry.length > 0) {
          list.push(entry);
        }
      }
    }
  };
  for (const key of ['user_id', 'userId', 'namespace', 'group_id', 'groupId', 'container', 'my_scope']) {
    push(args[key]);
  }
  push(args.group_ids);
  for (const key of ['metadata', 'meta', 'my_meta', 'filters', 'filter']) {
    const bag = args[key];
    if (bag !== null && typeof bag === 'object' && !Array.isArray(bag)) {
      const record = bag as Record<string, unknown>;
      push(record.namespace);
      push(record.namespaces);
    }
  }
  return list.length === 0 ? undefined : list;
}

function visibleFor(
  record: StoredRecord,
  namespaces: readonly string[] | undefined,
  options: MockServerOptions
): boolean {
  if (options.enforceNamespace === false || namespaces === undefined || namespaces.length === 0) {
    return true;
  }
  return namespaces.includes(record.namespace);
}

function rejectPayload(options: MockServerOptions): unknown {
  return { verdict: 'reject', reason: 'backend gate rejected the lesson' };
}

// ---------------------------------------------------------------------------
// Family 1: graph-entity (@modelcontextprotocol/server-memory style)
// ---------------------------------------------------------------------------

export function graphEntityServer(options: MockServerOptions = {}): MockServer {
  const tools: McpToolDescriptor[] = [
    { name: 'create_entities', description: 'create graph entities', inputSchema: props({ entities: 'array' }) },
    { name: 'create_relations', inputSchema: props({ relations: 'array' }) },
    { name: 'add_observations', inputSchema: props({ observations: 'array' }) },
    { name: 'search_nodes', inputSchema: props({ query: 'string' }) },
    { name: 'read_graph', inputSchema: props({}) },
    { name: 'delete_entities', inputSchema: props({ entityNames: 'array' }) }
  ];
  return createMockServer(
    tools,
    {
      create_entities: (args, server) => {
        if (options.rejectWrites === true) {
          return rejectPayload(options);
        }
        const entities = Array.isArray(args.entities) ? args.entities : [];
        let created = 0;
        for (const entity of entities) {
          if (entity === null || typeof entity !== 'object') {
            continue;
          }
          const record = entity as Record<string, unknown>;
          const name = typeof record.name === 'string' ? record.name : '';
          const namespace = name.startsWith('Lesson:') ? name.slice(0, name.lastIndexOf(':')).slice('Lesson:'.length) : '';
          const observations = Array.isArray(record.observations) ? record.observations : [];
          for (const observation of observations) {
            if (typeof observation !== 'string') {
              continue;
            }
            const parsed = parseLessonDocument(observation);
            if (parsed === undefined) {
              continue;
            }
            server.store.push({
              id: parsed.lesson.id,
              namespace: parsed.namespace.length > 0 ? parsed.namespace : namespace,
              text: observation,
              createdAt: parsed.lesson.createdAt ?? 0,
              polarity: parsed.lesson.polarity
            });
            created += 1;
          }
        }
        return { created };
      },
      search_nodes: (_args, server) => ({
        entities: server.store.map((record) => ({
          name: 'Lesson:' + record.namespace + ':' + record.id,
          entityType: 'Lesson',
          observations: [record.text]
        }))
      }),
      create_relations: (args) => ({ relations: Array.isArray(args.relations) ? args.relations.length : 0 }),
      delete_entities: (args, server) => {
        const names = Array.isArray(args.entityNames) ? args.entityNames : [];
        let removed = 0;
        for (const name of names) {
          if (typeof name !== 'string') {
            continue;
          }
          const id = name.slice(name.lastIndexOf(':') + 1);
          const index = server.store.findIndex((record) => record.id === id);
          if (index >= 0) {
            server.store.splice(index, 1);
            removed += 1;
          }
        }
        return { removed };
      }
    },
    options
  );
}

// ---------------------------------------------------------------------------
// Family 2: vector-fact (mem0 / supermemory / qdrant / chroma style)
// ---------------------------------------------------------------------------

export function vectorFactServer(options: MockServerOptions = {}): MockServer {
  const tools: McpToolDescriptor[] = [
    { name: 'add_memory', description: 'store a memory', inputSchema: props({ text: 'string', user_id: 'string', metadata: 'object' }) },
    { name: 'search_memory', inputSchema: props({ query: 'string', user_id: 'string', limit: 'number', filters: 'object' }) },
    { name: 'delete_memory', inputSchema: props({ ids: 'array', user_id: 'string' }) }
  ];
  return createMockServer(
    tools,
    {
      add_memory: (args, server) => {
        if (options.rejectWrites === true) {
          return rejectPayload(options);
        }
        const record = storeLesson(server, args, namespaceFromArgs(args));
        return { id: record?.id ?? 'unknown', stored: record !== undefined };
      },
      search_memory: (args, server) => {
        const namespaces = namespacesFromArgs(args);
        return {
          results: server.store
            .filter((record) => visibleFor(record, namespaces, options))
            .map((record) => ({ id: record.id, memory: record.text, metadata: { namespace: record.namespace } }))
        };
      },
      delete_memory: (args, server) => {
        const ids = Array.isArray(args.ids) ? args.ids : [];
        const namespaces = namespacesFromArgs(args);
        let removed = 0;
        for (const id of ids) {
          const index = server.store.findIndex(
            (record) => record.id === id && visibleFor(record, namespaces, options)
          );
          if (index >= 0) {
            server.store.splice(index, 1);
            removed += 1;
          }
        }
        return { removed };
      }
    },
    options
  );
}

// ---------------------------------------------------------------------------
// Family 3: temporal (graphiti/zep, letta style)
// ---------------------------------------------------------------------------

export function temporalServer(options: MockServerOptions = {}): MockServer {
  const tools: McpToolDescriptor[] = [
    { name: 'add_episode', description: 'add an episode', inputSchema: props({ name: 'string', episode_body: 'string', group_id: 'string' }) },
    { name: 'search_facts', inputSchema: props({ query: 'string', group_ids: 'array', limit: 'number' }) },
    { name: 'delete_episode', inputSchema: props({ ids: 'array', group_id: 'string' }) }
  ];
  return createMockServer(
    tools,
    {
      add_episode: (args, server) => {
        if (options.rejectWrites === true) {
          return rejectPayload(options);
        }
        const record = storeLesson(server, args, namespaceFromArgs(args));
        return { episode_id: 'ep-' + (record?.id ?? 'unknown') };
      },
      search_facts: (args, server) => {
        const namespaces = namespacesFromArgs(args);
        return {
          facts: server.store
            .filter((record) => visibleFor(record, namespaces, options))
            .map((record) => ({ fact: record.text, metadata: { namespace: record.namespace } }))
        };
      },
      delete_episode: (args, server) => {
        const ids = Array.isArray(args.ids) ? args.ids : [];
        let removed = 0;
        for (const id of ids) {
          const index = server.store.findIndex((record) => record.id === id);
          if (index >= 0) {
            server.store.splice(index, 1);
            removed += 1;
          }
        }
        return { removed };
      }
    },
    options
  );
}

// ---------------------------------------------------------------------------
// Family 4: markdown-note (basic-memory / obsidian style)
// ---------------------------------------------------------------------------

export function markdownNoteServer(options: MockServerOptions = {}): MockServer {
  const tools: McpToolDescriptor[] = [
    { name: 'write_note', description: 'write a markdown note', inputSchema: props({ path: 'string', content: 'string', tags: 'array' }) },
    { name: 'search_notes', inputSchema: props({ query: 'string', limit: 'number' }) },
    { name: 'delete_note', inputSchema: props({ path: 'string' }) }
  ];
  return createMockServer(
    tools,
    {
      write_note: (args, server) => {
        if (options.rejectWrites === true) {
          return rejectPayload(options);
        }
        const path = typeof args.path === 'string' ? args.path : undefined;
        const denormalized = path === undefined ? undefined : path.replace(/\//g, ':').replace(/:[^:]*$/, '');
        const record = storeLesson(server, args, denormalized, path);
        return { path: record?.path ?? path ?? 'unknown' };
      },
      search_notes: (_args, server) => ({
        notes: server.store.map((record) => ({ path: record.path ?? record.namespace, content: record.text }))
      }),
      delete_note: (args, server) => {
        const path = typeof args.path === 'string' ? args.path : '';
        const index = server.store.findIndex((record) => record.path === path);
        if (index >= 0) {
          server.store.splice(index, 1);
          return { deleted: true };
        }
        return { deleted: false };
      }
    },
    options
  );
}

// ---------------------------------------------------------------------------
// Family 5: lingshu-mdcg (dsh-memory white-box native style)
// ---------------------------------------------------------------------------

export function lingshuServer(options: MockServerOptions = {}): MockServer {
  const tools: McpToolDescriptor[] = [
    { name: 'cg', description: '灵枢 cognitive graph', inputSchema: props({ op: 'string', query: 'string', content: 'string', limit: 'number', ids: 'array', namespace: 'string' }) },
    { name: 'stg', inputSchema: props({ op: 'string', limit: 'number' }) },
    { name: 'mdcg_remember', inputSchema: props({ content: 'string', namespace: 'string' }) },
    { name: 'mdcg_recall', inputSchema: props({ query: 'string', limit: 'number', namespace: 'string' }) }
  ];
  return createMockServer(
    tools,
    {
      cg: (args, server) => {
        const op = args.op;
        if (op === 'write') {
          if (options.rejectWrites === true) {
            return rejectPayload(options);
          }
          const record = storeLesson(server, args, namespaceFromArgs(args));
          return { verdict: 'accept', id: record?.id ?? 'unknown', gates: 3 };
        }
        if (op === 'forget') {
          const ids = Array.isArray(args.ids) ? args.ids : [];
          let removed = 0;
          for (const id of ids) {
            const index = server.store.findIndex((record) => record.id === id);
            if (index >= 0) {
              server.store.splice(index, 1);
              removed += 1;
            }
          }
          return { removed };
        }
        return {
          results: server.store.map((record) => ({ content: record.text, namespace: record.namespace }))
        };
      },
      stg: (_args, server) => ({ episodes: server.store.map((record) => ({ content: record.text })) }),
      mdcg_remember: (args, server) => {
        const record = storeLesson(server, args, namespaceFromArgs(args));
        return { ok: true, id: record?.id };
      },
      mdcg_recall: (_args, server) => ({
        lessons: server.store.map((record) => ({ content: record.text, namespace: record.namespace }))
      })
    },
    options
  );
}

// ---------------------------------------------------------------------------
// Family 6: custom-mapped (schema-declared non-canonical field names)
// ---------------------------------------------------------------------------

export function customMappedServer(options: MockServerOptions = {}): MockServer {
  const tools: McpToolDescriptor[] = [
    {
      name: 'my_custom_search',
      description: 'custom recall',
      inputSchema: props({ my_query: 'string', my_top_k: 'number', my_scope: 'string', my_meta: 'object' })
    },
    {
      name: 'my_custom_upsert',
      description: 'custom commit',
      inputSchema: props({ my_text: 'string', my_scope: 'string', my_meta: 'object' })
    },
    { name: 'my_custom_purge', inputSchema: props({ my_ids: 'array', my_scope: 'string' }) }
  ];
  return createMockServer(
    tools,
    {
      my_custom_upsert: (args, server) => {
        if (options.rejectWrites === true) {
          return rejectPayload(options);
        }
        const record = storeLesson(server, args, namespaceFromArgs(args));
        return { ok: true, id: record?.id ?? 'unknown' };
      },
      my_custom_search: (args, server) => {
        const namespaces = namespacesFromArgs(args);
        return {
          items: server.store
            .filter((record) => visibleFor(record, namespaces, options))
            .map((record) => ({ content: record.text, scope: record.namespace }))
        };
      },
      my_custom_purge: (args, server) => {
        const ids = Array.isArray(args.my_ids) ? args.my_ids : [];
        let removed = 0;
        for (const id of ids) {
          const index = server.store.findIndex((record) => record.id === id);
          if (index >= 0) {
            server.store.splice(index, 1);
            removed += 1;
          }
        }
        return { removed };
      }
    },
    options
  );
}
