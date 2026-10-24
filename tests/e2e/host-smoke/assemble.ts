/**
 * Manifest assembly (P6.1-F).
 *
 * Why this is a separate, unit-tested function rather than logic inside the
 * runner: the honesty of the whole report depends on ONE rule — the manifest's
 * `hooks` and `identity` sections must be built from host-real dispatches only.
 * When that logic lived inline in the runner, an early version let a
 * contract-shaped dispatch (one the harness itself decorated with a branchId)
 * become the "representative" capture, which would have reported that the host
 * supplies a branchId that it does not. Extracting it here makes that rule
 * enforceable by a test instead of by review.
 *
 * Ownership: tests/e2e/host-smoke/**. Imported by scripts/host-smoke/in-host.mjs.
 */
import {
  MANIFEST_DURABLE_EVENTS,
  MANIFEST_HOOK_EVENTS,
  validateManifest
} from './manifest';
import type {
  DurableEventCapability,
  HookCapability,
  HookIdentityAvailability,
  HostCapabilityManifest,
  HostFacts,
  ManifestHookEvent,
  PermissionPrecedence,
  PluginFacts
} from './manifest';
import type { HookDispatchObservation, HostProbeReport } from './probe';

/** The host facts the runner observes for itself. */
export interface ManifestAssemblyInput {
  readonly capturedAt: string;
  readonly host: HostFacts;
  readonly plugin: PluginFacts;
  /** The in-host probe report (host-real captures + surfaces + durability). */
  readonly probe: HostProbeReport | null;
  /** Gate-mode probe totals, when it ran. */
  readonly gate: {
    readonly anonymousAskCount: number;
    readonly anonymousScopeUnknownSkipped: number;
    readonly anonymousToolExecuted: boolean;
  } | null;
  /** Gate 4 blockers the runner determined (never empty in this phase). */
  readonly gate4BlockedBy: readonly string[];
  /** Bounded, payload-free evidence lines for the permission section. */
  readonly permissionEvidence: readonly string[];
}

/** Map one host-real capture to identity availability (D1 §2.5 vocabulary). */
export function identityAvailabilityOf(observation: HookDispatchObservation): HookIdentityAvailability {
  const hasBranch = observation.branchIds > 0;
  const hasSession = observation.sessionIds > 0;
  const hasNamespace = observation.namespaces > 0;
  return {
    event: observation.event,
    branchId: hasBranch ? 'payload' : 'none',
    sessionId: hasSession ? 'payload' : observation.carrierIdPresent ? 'carrier-this' : 'none',
    namespace: hasNamespace ? 'payload' : 'none',
    fields: observation.identityFields,
    // D1 §2.5: a plain sessionId with no branch/namespace is exactly the case
    // that needs a trusted host-session registration to become learnable.
    plainSessionIdOnly: hasSession && !hasBranch && !hasNamespace
  };
}

/** Map one host-real capture to its hook capability record. */
export function hookCapabilityOf(
  observation: HookDispatchObservation,
  installedHookEvents: readonly string[],
  disposerKind: 'function' | 'dispose-object' | 'none'
): HookCapability {
  const installed = installedHookEvents.includes(observation.event);
  return {
    event: observation.event,
    support: installed ? 'installed' : 'rejected',
    disposer: installed ? disposerKind : 'none',
    dispatched: observation.dispatched,
    payloadFields: observation.payloadFields
  };
}

/** Structural fallback used when no probe ran at all (every field stays denied). */
function unprobedHooks(): readonly HookCapability[] {
  return MANIFEST_HOOK_EVENTS.map((event) => ({
    event,
    support: 'not-probed',
    disposer: 'none',
    dispatched: false,
    payloadFields: []
  }));
}

function unprobedIdentity(): readonly HookIdentityAvailability[] {
  return MANIFEST_HOOK_EVENTS.map((event) => ({
    event,
    branchId: 'none',
    sessionId: 'none',
    namespace: 'none',
    fields: [],
    plainSessionIdOnly: false
  }));
}

/**
 * The permission chain. `order` is highest priority first; `jit-deny` is last
 * because it is a documented NON-capability (the adapter must never return deny).
 */
export function permissionPrecedence(evidence: readonly string[]): PermissionPrecedence {
  return {
    order: ['host-deny', 'host-cancel', 'jit-ask', 'jit-deny'],
    hostDecisionAuthoritative: true,
    jitCanDeny: false,
    jitCanAsk: true,
    mountDenyAfterHost: true,
    evidence: [...evidence]
  };
}

/**
 * Build the manifest from host-real evidence only.
 *
 * `contractShapedHooks` is intentionally NEVER read here. A caller cannot opt
 * into it: the parameter does not exist, so "use the contract-shaped capture"
 * is a compile error rather than a silent regression.
 */
export function buildManifest(input: ManifestAssemblyInput): HostCapabilityManifest {
  const probe = input.probe;
  const disposerKind: 'function' | 'dispose-object' | 'none' =
    probe?.disposer.kind === 'function'
      ? 'function'
      : probe?.disposer.kind === 'dispose-object'
        ? 'dispose-object'
        : 'none';

  // Host-real captures only: `probe.hooks` is documented as the host-real set.
  const hostHooks = probe?.hooks ?? [];
  const hooks = probe === null ? unprobedHooks() : hostHooks.map((entry) => hookCapabilityOf(entry, probe.installedHookEvents, disposerKind));

  const durableEvents: readonly DurableEventCapability[] = MANIFEST_DURABLE_EVENTS.map((event) => ({
    event,
    listenerInstalled: probe?.durableEvent.listenerInstalled === true,
    dispatchKind: 'session-append',
    terminatingDisposal:
      probe?.durableEvent.disposerKind === 'function'
        ? 'function'
        : probe?.durableEvent.disposerKind === 'dispose-object'
          ? 'dispose-object'
          : 'none'
  }));

  const perHook = probe === null ? unprobedIdentity() : hostHooks.map(identityAvailabilityOf);

  const agentCarrierOnToolDispatch = hostHooks.some(
    (entry) => entry.event.startsWith('tools/') && entry.identityFields.includes('agent')
  );

  return {
    schemaVersion: 1,
    capturedAt: input.capturedAt,
    host: input.host,
    plugin: input.plugin,
    hooks,
    durableEvents,
    identity: {
      perHook,
      anyPlainSessionIdOnly: perHook.some((entry) => entry.plainSessionIdOnly)
    },
    permissions: permissionPrecedence(input.permissionEvidence),
    surfaces: {
      waterfall: probe?.surfaces.waterfall === true,
      off: probe?.surfaces.off === true,
      fork: probe?.surfaces.fork === true,
      promptSections: probe?.surfaces.promptSections === true,
      toolDecisionPipeline: probe?.surfaces.toolDecisionPipeline === true,
      agentCarrierOnToolDispatch
    },
    gate4: {
      // This phase prepares the harness; it never self-certifies Gate 4.
      status: 'not-passed',
      blockedBy: input.gate4BlockedBy.length > 0 ? [...input.gate4BlockedBy] : ['no blocker recorded (invalid: this phase cannot pass Gate 4)']
    }
  };
}

/** Validate-and-summarize helper so the runner has one call for both. */
export function assembleAndValidate(input: ManifestAssemblyInput): {
  readonly manifest: HostCapabilityManifest;
  readonly problems: readonly string[];
} {
  const manifest = buildManifest(input);
  return { manifest, problems: validateManifest(manifest) };
}

/** True when a manifest reports host-real identity that is session-only. */
export function hasPlainSessionIdOnlyIdentity(manifest: HostCapabilityManifest): boolean {
  return manifest.identity.perHook.some((entry) => entry.plainSessionIdOnly);
}

/** Hook events whose identity availability depends on the carrier `this`. */
export function carrierOnlyIdentityEvents(manifest: HostCapabilityManifest): readonly ManifestHookEvent[] {
  return manifest.identity.perHook
    .filter((entry) => entry.sessionId === 'carrier-this')
    .map((entry) => entry.event);
}
