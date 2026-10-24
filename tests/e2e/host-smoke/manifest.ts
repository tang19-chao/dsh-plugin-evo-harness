/**
 * HostCapabilityManifest (P6.1-F, ADR 0001 D1 / Gate 4 evidence surface).
 *
 * Why this exists: ADR 0001 §2.6 lists the "Gate 4 capability list" as one of the
 * six surfaces that must move with the D1 strict default, and §2.5 makes a
 * trusted *host-session* scope registration the only compatibility path for a
 * dispatch that carries no `branchId`. Neither claim is checkable from a
 * fixture: both are claims about the installed host. This module defines the
 * manifest that records them as data, so a smoke can report "the host provides
 * X" instead of "the fixture pretends X".
 *
 * The manifest is deny-by-default: an unprobed field is `'not-probed'`/`'none'`,
 * never assumed true. `validateManifest()` rejects a manifest that omits any
 * required group or hook event, so a partial capability record can never be
 * mistaken for a Gate 4 pass.
 *
 * Two vocabularies are kept apart on purpose (they are different host
 * mechanisms, and conflating them is exactly how a "hook" claim becomes false):
 *
 *   - HOOK events: four waterfall hooks the adapter intercepts decisions on;
 *   - DURABLE events: `turn/end` is appended to the session log by the loop and
 *     reaches a listener as an observation, never as a decision waterfall.
 *
 * Ownership: tests/e2e/host-smoke/**. No production module imports this.
 */

/** The four waterfall hooks the adapter owns. */
export const MANIFEST_HOOK_EVENTS = [
  'system-prompt/assemble',
  'tools/pre-execute',
  'tools/post-execute',
  'agent/pre-step'
] as const;
export type ManifestHookEvent = (typeof MANIFEST_HOOK_EVENTS)[number];

/**
 * Durable session events the adapter may additionally observe. Not hooks: they
 * deliver no decision, so they can inform evidence but never gate execution.
 */
export const MANIFEST_DURABLE_EVENTS = ['turn/end'] as const;
export type ManifestDurableEvent = (typeof MANIFEST_DURABLE_EVENTS)[number];

/** What a hook event's listener registration actually did on this host. */
export type HookSupport = 'installed' | 'rejected' | 'not-probed';

/** How the host hands back the unregister capability. */
export type DisposerKind = 'function' | 'dispose-object' | 'off-fallback' | 'none';

/** Where the dispatch identity was found, if anywhere. */
export type IdentityCarrier = 'payload' | 'carrier-this' | 'none';

/** Which identity fields a hook dispatch actually carries. */
export interface HookIdentityAvailability {
  readonly event: ManifestHookEvent;
  readonly branchId: IdentityCarrier;
  readonly sessionId: IdentityCarrier;
  readonly namespace: IdentityCarrier;
  /** Payload/carrier field names the identity was read from. */
  readonly fields: readonly string[];
  /**
   * True when the only identity a dispatch carries is a plain session id. This
   * is the D1 §2.5 case: no advice and no learning until a trusted host-session
   * scope registration exists (the registration is NOT default-on).
   */
  readonly plainSessionIdOnly: boolean;
}

/** One hook event's observed support on the installed host. */
export interface HookCapability {
  readonly event: ManifestHookEvent;
  readonly support: HookSupport;
  readonly disposer: DisposerKind;
  /** True when a dispatch actually reached the listener during the probe. */
  readonly dispatched: boolean;
  /** Payload keys observed on a real dispatch, sorted (never values). */
  readonly payloadFields: readonly string[];
}

/** One durable event's observability (no decision semantics). */
export interface DurableEventCapability {
  readonly event: ManifestDurableEvent;
  /** True when `ctx.on(event, ...)` accepted a listener. */
  readonly listenerInstalled: boolean;
  /** The host's own dispatch mechanism for this event. */
  readonly dispatchKind: 'session-append';
  readonly terminatingDisposal: DisposerKind;
}

/**
 * Permission precedence the host actually enforces, highest first.
 *
 * This is the D1 "ordinary execution passes through" half of the contract: Jit
 * may ask, it may never deny, and any host deny/cancel decided further down the
 * chain wins over both.
 */
export interface PermissionPrecedence {
  /** Ordered, highest priority first. */
  readonly order: readonly string[];
  /** The host decision handed to the adapter stays authoritative. */
  readonly hostDecisionAuthoritative: boolean;
  /** Jit may return `deny` on `tools/pre-execute`. Must be false. */
  readonly jitCanDeny: boolean;
  /** Jit may return `ask` on `tools/pre-execute` (gate mode). */
  readonly jitCanAsk: boolean;
  /** A mount's guardrails deny rule is applied only after the host decision. */
  readonly mountDenyAfterHost: boolean;
  /** Evidence lines for each precedence claim (bounded, payload free). */
  readonly evidence: readonly string[];
}

/** Structural host facts the manifest pins. */
export interface HostFacts {
  /** Product name as installed (e.g. `DeepSeek Harness`). */
  readonly product: string;
  /** Installed host version (from the installer's `version` file). */
  readonly version: string;
  /** Absolute install directory. */
  readonly installDir: string;
  /** Absolute path of the executable used to run the smoke. */
  readonly executable: string;
  /** Absolute path of the asar archive the host packages load from. */
  readonly asarPath: string;
  /** Cordis (meta-framework) version resolved from the installed host. */
  readonly cordisVersion: string;
  /** Runtime facts of the process that executed the smoke. */
  readonly runtime: {
    readonly node: string;
    readonly electron: string;
    readonly v8: string;
    readonly platform: string;
    readonly arch: string;
  };
}

/** Plugin revision the smoke pinned. */
export interface PluginFacts {
  readonly name: string;
  readonly version: string;
  /** Git commit the run is bound to. */
  readonly commit: string;
  /** True when the working tree had uncommitted changes at capture time. */
  readonly worktreeDirty: boolean;
  /** Bundle entry the harness loaded (workspace-relative POSIX path). */
  readonly bundleEntry: string;
}

/** What the host can do beyond the four hooks. */
export interface HostSurfaceFacts {
  /** `ctx.waterfall` exists (the hook dispatch primitive). */
  readonly waterfall: boolean;
  /** `ctx.off` exists (fallback unregister path). */
  readonly off: boolean;
  /** `ctx.fork` exists (branch-private child context). */
  readonly fork: boolean;
  /** Prompt assembly returns an object with a `sections` array. */
  readonly promptSections: boolean;
  /** Tool pipeline exposes a real pre/post decision pair. */
  readonly toolDecisionPipeline: boolean;
  /**
   * True when the host's tool dispatch carries the agent (and therefore a
   * discoverable session/branch identity) on `tools/*`. This is what makes the
   * sibling-probe check meaningful rather than vacuous.
   */
  readonly agentCarrierOnToolDispatch: boolean;
}

/**
 * The manifest. Every group is required; `validateManifest` fails a manifest
 * that leaves one out, so "not measured" can never read as "supported".
 */
export interface HostCapabilityManifest {
  readonly schemaVersion: 1;
  /** ISO-8601 capture timestamp. */
  readonly capturedAt: string;
  readonly host: HostFacts;
  readonly plugin: PluginFacts;
  readonly hooks: readonly HookCapability[];
  readonly durableEvents: readonly DurableEventCapability[];
  readonly identity: {
    readonly perHook: readonly HookIdentityAvailability[];
    /**
     * True when at least one hook dispatch proved only a plain session id. It
     * does not by itself prove the other hooks lack a branchId.
     */
    readonly anyPlainSessionIdOnly: boolean;
  };
  readonly permissions: PermissionPrecedence;
  readonly surfaces: HostSurfaceFacts;
  /** Gate 4 status: this phase prepares the harness; it never self-certifies. */
  readonly gate4: {
    readonly status: 'not-passed' | 'passed';
    readonly blockedBy: readonly string[];
  };
}

const ALLOWED_HOOK_SUPPORT: readonly HookSupport[] = ['installed', 'rejected', 'not-probed'];
const ALLOWED_DISPOSERS: readonly DisposerKind[] = ['function', 'dispose-object', 'off-fallback', 'none'];
const ALLOWED_CARRIERS: readonly IdentityCarrier[] = ['payload', 'carrier-this', 'none'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate a manifest against the acceptance contract.
 *
 * Returns one message per missing/incoherent field; an empty array means the
 * manifest is structurally complete. Deliberately checks *presence and
 * coherence*, not "everything is supported": a `rejected` hook is a valid,
 * reportable fact, while an absent hook entry is not.
 */
export function validateManifest(value: unknown): readonly string[] {
  const problems: string[] = [];
  if (!isRecord(value)) {
    return ['manifest is not an object'];
  }
  const manifest = value as unknown as HostCapabilityManifest;
  if (manifest.schemaVersion !== 1) {
    problems.push('schemaVersion must be 1');
  }
  if (!nonEmptyString(manifest.capturedAt) || !Number.isFinite(Date.parse(manifest.capturedAt))) {
    problems.push('capturedAt must be an ISO-8601 timestamp');
  }

  const host = manifest.host;
  if (!isRecord(host)) {
    problems.push('host group is missing');
  } else {
    for (const field of ['product', 'version', 'installDir', 'executable', 'asarPath', 'cordisVersion'] as const) {
      if (!nonEmptyString(host[field])) {
        problems.push('host.' + field + ' is missing (DSH/host version facts are required)');
      }
    }
    const runtime = host.runtime;
    if (!isRecord(runtime)) {
      problems.push('host.runtime is missing');
    } else {
      for (const field of ['node', 'electron', 'v8', 'platform', 'arch'] as const) {
        if (!nonEmptyString(runtime[field])) {
          problems.push('host.runtime.' + field + ' is missing (Node/runtime version facts are required)');
        }
      }
    }
  }

  const plugin = manifest.plugin;
  if (!isRecord(plugin)) {
    problems.push('plugin group is missing');
  } else {
    for (const field of ['name', 'version', 'commit', 'bundleEntry'] as const) {
      if (!nonEmptyString(plugin[field])) {
        problems.push('plugin.' + field + ' is missing (plugin version/commit facts are required)');
      }
    }
    if (typeof plugin.worktreeDirty !== 'boolean') {
      problems.push('plugin.worktreeDirty must be a boolean');
    }
  }

  const hooks = manifest.hooks;
  const hookEvents = new Set<string>();
  if (!Array.isArray(hooks) || hooks.length === 0) {
    problems.push('hooks must list every probed hook event');
  } else {
    for (const entry of hooks) {
      if (!isRecord(entry)) {
        problems.push('hooks entry is not an object');
        continue;
      }
      const event = entry['event'];
      if (typeof event !== 'string' || !(MANIFEST_HOOK_EVENTS as readonly string[]).includes(event)) {
        problems.push('hooks entry has an unknown event: ' + String(event));
      } else if (hookEvents.has(event)) {
        problems.push('hooks entry duplicates event ' + event);
      } else {
        hookEvents.add(event);
      }
      if (!(ALLOWED_HOOK_SUPPORT as readonly unknown[]).includes(entry['support'])) {
        problems.push('hooks[' + String(event) + '].support must be one of ' + ALLOWED_HOOK_SUPPORT.join('/'));
      }
      if (!(ALLOWED_DISPOSERS as readonly unknown[]).includes(entry['disposer'])) {
        problems.push('hooks[' + String(event) + '].disposer must be one of ' + ALLOWED_DISPOSERS.join('/'));
      }
      if (typeof entry['dispatched'] !== 'boolean') {
        problems.push('hooks[' + String(event) + '].dispatched must be a boolean');
      }
      if (!Array.isArray(entry['payloadFields'])) {
        problems.push('hooks[' + String(event) + '].payloadFields must be an array (payload keys only)');
      }
    }
    for (const event of MANIFEST_HOOK_EVENTS) {
      if (!hookEvents.has(event)) {
        problems.push('hooks is missing event ' + event + ' (hook support must be defined for every event)');
      }
    }
  }

  const durable = manifest.durableEvents;
  if (!Array.isArray(durable) || durable.length === 0) {
    problems.push('durableEvents must record the session-level events the adapter observes (e.g. turn/end)');
  } else {
    for (const entry of durable) {
      if (!isRecord(entry)) {
        problems.push('durableEvents entry is not an object');
        continue;
      }
      const event = entry['event'];
      if (typeof event !== 'string' || !(MANIFEST_DURABLE_EVENTS as readonly string[]).includes(event)) {
        problems.push('durableEvents has an unknown event: ' + String(event));
      }
      if (typeof entry['listenerInstalled'] !== 'boolean') {
        problems.push('durableEvents[' + String(event) + '].listenerInstalled must be a boolean');
      }
      if (entry['dispatchKind'] !== 'session-append') {
        problems.push('durableEvents[' + String(event) + '].dispatchKind must be session-append');
      }
      if (!(ALLOWED_DISPOSERS as readonly unknown[]).includes(entry['terminatingDisposal'])) {
        problems.push(
          'durableEvents[' + String(event) + '].terminatingDisposal must be one of ' + ALLOWED_DISPOSERS.join('/')
        );
      }
    }
    for (const event of MANIFEST_DURABLE_EVENTS) {
      if (!durable.some((entry) => isRecord(entry) && entry['event'] === event)) {
        problems.push('durableEvents is missing ' + event);
      }
    }
  }

  const identity = manifest.identity;
  if (!isRecord(identity)) {
    problems.push('identity group is missing');
  } else {
    const perHook = identity.perHook;
    const seen = new Set<string>();
    if (!Array.isArray(perHook) || perHook.length === 0) {
      problems.push('identity.perHook must define identity availability for every hook event');
    } else {
      for (const entry of perHook) {
        if (!isRecord(entry)) {
          problems.push('identity.perHook entry is not an object');
          continue;
        }
        const event = entry['event'];
        if (typeof event !== 'string' || !(MANIFEST_HOOK_EVENTS as readonly string[]).includes(event)) {
          problems.push('identity.perHook entry has an unknown event: ' + String(event));
          continue;
        }
        seen.add(event);
        for (const field of ['branchId', 'sessionId', 'namespace'] as const) {
          if (!(ALLOWED_CARRIERS as readonly unknown[]).includes(entry[field])) {
            problems.push(
              'identity.perHook[' + event + '].' + field + ' must be one of ' + ALLOWED_CARRIERS.join('/')
            );
          }
        }
        if (!Array.isArray(entry['fields'])) {
          problems.push('identity.perHook[' + event + '].fields must be an array');
        }
        if (typeof entry['plainSessionIdOnly'] !== 'boolean') {
          problems.push('identity.perHook[' + event + '].plainSessionIdOnly must be a boolean');
        }
      }
      for (const event of MANIFEST_HOOK_EVENTS) {
        if (!seen.has(event)) {
          problems.push('identity.perHook is missing event ' + event + ' (identity field availability must be defined)');
        }
      }
    }
    if (typeof identity.anyPlainSessionIdOnly !== 'boolean') {
      problems.push('identity.anyPlainSessionIdOnly must be a boolean');
    }
  }

  const permissions = manifest.permissions;
  if (!isRecord(permissions)) {
    problems.push('permissions group is missing');
  } else {
    if (!Array.isArray(permissions.order) || permissions.order.length < 4) {
      problems.push('permissions.order must list the full precedence chain (host deny/cancel before any Jit decision)');
    } else {
      // `order` is highest priority first, so every host decision must precede
      // every Jit decision: a Jit ask can never outrank a host deny/cancel, and
      // Jit deny is not a real permission at all (it must never be returned).
      const order = permissions.order as readonly string[];
      for (const required of ['host-deny', 'host-cancel', 'jit-ask', 'jit-deny']) {
        if (!order.includes(required)) {
          problems.push('permissions.order is missing ' + required);
        }
      }
      const rank = (name: string): number => order.indexOf(name);
      const hostRank = Math.max(rank('host-deny'), rank('host-cancel'));
      const jitAskRank = rank('jit-ask');
      const jitDenyRank = rank('jit-deny');
      if (hostRank >= 0 && jitAskRank >= 0 && jitAskRank < hostRank) {
        problems.push('permissions.order puts jit-ask above a host deny/cancel');
      }
      if (hostRank >= 0 && jitDenyRank >= 0 && jitDenyRank < hostRank) {
        problems.push('permissions.order puts jit-deny above a host deny/cancel');
      }
    }
    if (permissions.hostDecisionAuthoritative !== true) {
      problems.push('permissions.hostDecisionAuthoritative must be true');
    }
    if (permissions.jitCanDeny !== false) {
      problems.push('permissions.jitCanDeny must be false (Jit may ask, never deny)');
    }
    if (permissions.jitCanAsk !== true) {
      problems.push('permissions.jitCanAsk must be true (gate mode is an ask)');
    }
    if (permissions.mountDenyAfterHost !== true) {
      problems.push('permissions.mountDenyAfterHost must be true (mount rules never override the host)');
    }
    if (!Array.isArray(permissions.evidence)) {
      problems.push('permissions.evidence must be an array (bounded, payload free)');
    }
  }

  const surfaces = manifest.surfaces;
  if (!isRecord(surfaces)) {
    problems.push('surfaces group is missing');
  } else {
    for (const field of [
      'waterfall',
      'off',
      'fork',
      'promptSections',
      'toolDecisionPipeline',
      'agentCarrierOnToolDispatch'
    ] as const) {
      if (typeof surfaces[field] !== 'boolean') {
        problems.push('surfaces.' + field + ' must be a boolean');
      }
    }
  }

  const gate4 = manifest.gate4;
  if (!isRecord(gate4)) {
    problems.push('gate4 group is missing');
  } else {
    if (gate4.status !== 'not-passed' && gate4.status !== 'passed') {
      problems.push('gate4.status must be not-passed or passed');
    }
    if (!Array.isArray(gate4.blockedBy)) {
      problems.push('gate4.blockedBy must be an array');
    }
    if (gate4.status === 'passed' && (gate4.blockedBy as readonly unknown[]).length > 0) {
      problems.push('gate4.status=passed contradicts a non-empty blockedBy');
    }
  }
  return problems;
}

/** Render one bounded, payload-free summary line per manifest group. */
export function summarizeManifest(manifest: HostCapabilityManifest): readonly string[] {
  const lines: string[] = [];
  lines.push(
    'host ' +
      manifest.host.product +
      ' ' +
      manifest.host.version +
      ' (cordis ' +
      manifest.host.cordisVersion +
      ', node ' +
      manifest.host.runtime.node +
      ', electron ' +
      manifest.host.runtime.electron +
      ')'
  );
  lines.push(
    'plugin ' +
      manifest.plugin.name +
      '@' +
      manifest.plugin.version +
      ' commit ' +
      manifest.plugin.commit.slice(0, 12) +
      (manifest.plugin.worktreeDirty ? ' (dirty worktree)' : ' (clean worktree)')
  );
  for (const hook of manifest.hooks) {
    lines.push(
      'hook ' +
        hook.event +
        ': support=' +
        hook.support +
        ' disposer=' +
        hook.disposer +
        ' dispatched=' +
        String(hook.dispatched) +
        ' payloadFields=' +
        String(hook.payloadFields.length)
    );
  }
  for (const durable of manifest.durableEvents) {
    lines.push(
      'durable ' +
        durable.event +
        ': listenerInstalled=' +
        String(durable.listenerInstalled) +
        ' dispatch=' +
        durable.dispatchKind
    );
  }
  for (const identity of manifest.identity.perHook) {
    lines.push(
      'identity ' +
        identity.event +
        ': branchId=' +
        identity.branchId +
        ' sessionId=' +
        identity.sessionId +
        ' namespace=' +
        identity.namespace +
        ' plainSessionIdOnly=' +
        String(identity.plainSessionIdOnly) +
        ' fields=' +
        identity.fields.join(',')
    );
  }
  lines.push('permission precedence: ' + manifest.permissions.order.join(' > '));
  lines.push('gate4: ' + manifest.gate4.status + ' (' + manifest.gate4.blockedBy.join('; ') + ')');
  return lines;
}
