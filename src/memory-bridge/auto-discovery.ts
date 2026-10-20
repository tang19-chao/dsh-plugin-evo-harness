/**
 * MCP memory backend auto-discovery (ARCHITECTURE.md 4.2).
 *
 * tools/list fingerprints are scored deterministically; the configured
 * driverHint or customMapping can force a specific family. Everything is pure
 * data + injected clients, so discovery is unit-testable without a backend.
 */

import type { MemoryBridgeConfig } from '../config';
import type {
  MemoryBackendCapabilities,
  MemoryBindingKind,
  MemoryBridgeDescriptor,
  MemoryDriverKind
} from '../types/contracts';
import { DRIVER_FINGERPRINTS, createDriverForKind, fingerprintFor, firstAvailable } from './drivers/index';
import type { IMemoryDriver, McpClient, McpToolDescriptor, MemoryDriverContext, MemoryDriverToolBinding } from './spi';
import { callToolWithTimeout, toolSchemaPropertyNames } from './spi';
import { safeStringify } from './spi';

/** One MCP server's advertised tool surface. */
export interface DiscoveryServer {
  readonly serverId: string;
  readonly tools: readonly McpToolDescriptor[];
}

/** One scored discovery candidate. */
export interface DiscoveryCandidate {
  readonly kind: MemoryDriverKind;
  readonly serverId: string;
  readonly score: number;
  readonly matchedTools: readonly string[];
  readonly strongTools: readonly string[];
  readonly binding: MemoryDriverToolBinding;
  readonly reason: string;
}

/** Result of the pure fingerprint selection step. */
export interface DriverSelection {
  readonly candidate: DiscoveryCandidate | null;
  readonly candidates: readonly DiscoveryCandidate[];
  readonly serverId: string | null;
  readonly diagnostics: readonly string[];
}

export interface SelectDriverInput {
  readonly config: MemoryBridgeConfig;
  readonly servers: readonly DiscoveryServer[];
}

const UNBOUND_CAPABILITIES: MemoryBackendCapabilities = {
  metadataFiltering: false,
  namespaces: false,
  negativePolarity: false,
  temporal: false,
  supportsPrune: false
};

/**
 * Score every fingerprint against every eligible server and return the winner.
 * Scoring: 2 points per matching candidate tool, 5 bonus points per strong
 * tool; ties break on fingerprint priority then kind then server id.
 */
export function selectDriverFromServers(input: SelectDriverInput): DriverSelection {
  const { config, servers } = input;
  const diagnostics: string[] = [];
  const target = typeof config.mcpServerTarget === 'string' ? config.mcpServerTarget.trim() : 'auto';
  const eligible =
    target.length === 0 || target === 'auto' ? servers : servers.filter((server) => server.serverId === target);
  if (eligible.length === 0) {
    diagnostics.push(
      target === 'auto'
        ? 'no MCP client was provided to auto-discovery'
        : 'configured mcpServerTarget "' + target + '" is not among the mounted MCP servers'
    );
    return { candidate: null, candidates: [], serverId: null, diagnostics };
  }
  if (target !== 'auto') {
    diagnostics.push('mcpServerTarget="' + target + '" restricts discovery to that server');
  }

  const candidates: DiscoveryCandidate[] = [];
  for (const server of eligible) {
    const available = new Set(server.tools.map((tool) => tool.name));
    const custom = customMappingCandidate(config, server, available);
    if (custom !== null) {
      candidates.push(custom);
    }
    for (const fingerprint of DRIVER_FINGERPRINTS) {
      if (fingerprint.kind === 'custom_mapped') {
        continue;
      }
      const signature = [...fingerprint.recallCandidates, ...fingerprint.commitCandidates, ...fingerprint.pruneCandidates];
      const matched = signature.filter((name) => available.has(name));
      if (matched.length === 0) {
        continue;
      }
      const strong = fingerprint.strongTools.filter((name) => available.has(name));
      const recall = firstAvailable(available, fingerprint.recallCandidates);
      const commit = firstAvailable(available, fingerprint.commitCandidates);
      if (recall === undefined || commit === undefined) {
        diagnostics.push(
          'server "' +
            server.serverId +
            '" matched ' +
            fingerprint.kind +
            ' partially (' +
            matched.join(', ') +
            ') but lacks a usable recall/commit tool pair'
        );
        continue;
      }
      const prune = firstAvailable(available, fingerprint.pruneCandidates);
      const binding: MemoryDriverToolBinding = {
        recall,
        commit,
        ...(prune === undefined ? {} : { prune })
      };
      candidates.push({
        kind: fingerprint.kind,
        serverId: server.serverId,
        score: matched.length * 2 + strong.length * 5,
        matchedTools: matched,
        strongTools: strong,
        binding,
        reason:
          'fingerprint matched ' +
          matched.length +
          ' tool(s) incl. ' +
          strong.length +
          ' strong signal(s); recall=' +
          recall +
          ', commit=' +
          commit +
          (prune === undefined ? '' : ', prune=' + prune)
      });
    }
  }

  const hint = config.driverHint;
  const customHintIgnored =
    hint === 'custom_mapped' && config.customMapping?.enabled !== true;
  if (customHintIgnored) {
    diagnostics.push('driverHint "custom_mapped" ignored: memoryBridge.customMapping.enabled is false');
  }
  if (candidates.length === 0) {
    diagnostics.push('no MCP memory driver fingerprint matched the mounted servers');
    return { candidate: null, candidates, serverId: null, diagnostics };
  }

  let pool = candidates;
  if (hint !== undefined && hint !== 'auto') {
    const hinted = pool.filter((candidate) => candidate.kind === hint);
    if (hinted.length > 0) {
      pool = hinted;
      diagnostics.push('driverHint "' + hint + '" forced the driver family');
    } else {
      diagnostics.push('driverHint "' + hint + '" did not match any mounted MCP memory server');
    }
  }

  const sorted = [...pool].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    const leftPriority = fingerprintFor(left.kind)?.priority ?? 99;
    const rightPriority = fingerprintFor(right.kind)?.priority ?? 99;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    if (left.kind !== right.kind) {
      return left.kind < right.kind ? -1 : 1;
    }
    return left.serverId < right.serverId ? -1 : left.serverId > right.serverId ? 1 : 0;
  });
  const winner = sorted[0];
  if (winner === undefined) {
    diagnostics.push('no MCP memory driver fingerprint matched the mounted servers');
    return { candidate: null, candidates: sorted, serverId: null, diagnostics };
  }
  diagnostics.push(
    'selected ' + winner.kind + ' on server "' + winner.serverId + '" (score ' + winner.score + ')'
  );
  return { candidate: winner, candidates: sorted, serverId: winner.serverId, diagnostics };
}

function customMappingCandidate(
  config: MemoryBridgeConfig,
  server: DiscoveryServer,
  available: ReadonlySet<string>
): DiscoveryCandidate | null {
  const mapping = config.customMapping;
  if (mapping === undefined || mapping.enabled !== true) {
    return null;
  }
  const recall = mapping.recallToolName;
  const commit = mapping.commitToolName;
  if (typeof recall !== 'string' || typeof commit !== 'string') {
    return null;
  }
  if (!available.has(recall) || !available.has(commit)) {
    return null;
  }
  const prune = typeof mapping.pruneToolName === 'string' && available.has(mapping.pruneToolName) ? mapping.pruneToolName : undefined;
  return {
    kind: 'custom_mapped',
    serverId: server.serverId,
    score: 60 + (prune === undefined ? 0 : 4),
    matchedTools: prune === undefined ? [recall, commit] : [recall, commit, prune],
    strongTools: [recall, commit],
    binding: { recall, commit, ...(prune === undefined ? {} : { prune }) },
    reason:
      'customMapping enabled: recall=' + recall + ', commit=' + commit + (prune === undefined ? '' : ', prune=' + prune)
  };
}

/** Full auto-discovery result, including the bound driver and descriptor. */
export interface AutoDiscoveryResult {
  readonly driver: IMemoryDriver | null;
  readonly client: McpClient | null;
  readonly tools: readonly McpToolDescriptor[];
  readonly context: MemoryDriverContext | null;
  readonly selection: DriverSelection;
  readonly descriptor: MemoryBridgeDescriptor;
}

export interface AutoDiscoveryInput {
  readonly config: MemoryBridgeConfig;
  readonly clients: readonly McpClient[];
  readonly now?: () => number;
}

/** Introspect every mounted MCP client and bind the best matching driver. */
export async function autoDiscoverMemoryDriver(input: AutoDiscoveryInput): Promise<AutoDiscoveryResult> {
  const now = input.now ?? (() => Date.now());
  const diagnostics: string[] = [];
  const servers: DiscoveryServer[] = [];
  const clients = new Map<string, McpClient>();
  for (const client of input.clients) {
    clients.set(client.serverId, client);
    try {
      const tools = await client.listTools({ timeoutMs: input.config.requestTimeoutMs });
      servers.push({ serverId: client.serverId, tools });
      diagnostics.push('server "' + client.serverId + '" advertises ' + tools.length + ' tool(s)');
    } catch (error) {
      diagnostics.push('tools/list failed for server "' + client.serverId + '": ' + describeError(error));
    }
  }

  const selection = selectDriverFromServers({ config: input.config, servers });
  const selectionDiagnostics = [...diagnostics, ...selection.diagnostics];
  if (selection.candidate === null || selection.serverId === null) {
    return {
      driver: null,
      client: null,
      tools: [],
      context: null,
      selection,
      descriptor: unboundDescriptor(input.config, selectionDiagnostics, now)
    };
  }
  const client = clients.get(selection.serverId) ?? null;
  const server = servers.find((entry) => entry.serverId === selection.serverId);
  const tools = server?.tools ?? [];
  const driver = createDriverForKind(selection.candidate.kind, selection.candidate.binding);
  if (client === null || driver === undefined) {
    selectionDiagnostics.push('discovery selected ' + selection.candidate.kind + ' but the driver could not be constructed');
    return {
      driver: null,
      client,
      tools,
      context: null,
      selection,
      descriptor: unboundDescriptor(input.config, selectionDiagnostics, now)
    };
  }
  const context = createDriverContext(client, tools, input.config, selection.candidate.binding, now);
  return {
    driver,
    client,
    tools,
    context,
    selection,
    descriptor: {
      driverKind: driver.kind,
      serverId: client.serverId,
      backendLabel: driver.label,
      capabilities: driver.capabilities,
      boundAt: now(),
      diagnostics: selectionDiagnostics
    }
  };
}

/** Build the driver context (tool lookup + timeout-guarded call helper). */
export function createDriverContext(
  client: McpClient,
  tools: readonly McpToolDescriptor[],
  config: MemoryBridgeConfig,
  binding: MemoryDriverToolBinding,
  now: () => number
): MemoryDriverContext {
  const toolNames = new Set(tools.map((tool) => tool.name));
  const schemaProperties = new Map<string, ReadonlySet<string>>();
  for (const tool of tools) {
    schemaProperties.set(tool.name, toolSchemaPropertyNames(tool));
  }
  return {
    client,
    tools,
    toolNames,
    schemaProperties,
    config,
    binding,
    now,
    hasTool: (toolName: string | undefined): boolean =>
      toolName !== undefined && toolNames.has(toolName),
    call: (toolName: string, args) =>
      callToolWithTimeout(client, toolName, args, { timeoutMs: config.requestTimeoutMs })
  };
}

function unboundDescriptor(
  config: MemoryBridgeConfig,
  diagnostics: readonly string[],
  now: () => number
): MemoryBridgeDescriptor {
  const driverKind: MemoryBindingKind = 'unbound';
  return {
    driverKind,
    serverId: null,
    backendLabel: 'unbound (no MCP memory backend selected)',
    capabilities: UNBOUND_CAPABILITIES,
    boundAt: now(),
    diagnostics: [...diagnostics, 'configured driverHint=' + String(config.driverHint)]
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.name + ': ' + error.message : safeStringify(error);
}

/** Driver kind reported by a descriptor, with a safe fallback. */
export function boundDriverKind(descriptor: MemoryBridgeDescriptor): MemoryBindingKind {
  return descriptor.driverKind;
}

/** Type guard for a bound driver kind. */
export function isDriverKind(value: MemoryBindingKind): value is MemoryDriverKind {
  return value !== 'unbound';
}
