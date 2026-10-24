/**
 * Bundle entry for the real-host smoke harness (P6.1-F).
 *
 * Why this entry exists: the smoke must exercise the *shipped* plugin code
 * against the *installed* DSH host. `scripts/host-smoke/build-harness-entry.mjs`
 * bundles this file with esbuild into one CJS module; `scripts/host-smoke/in-host.mjs`
 * then loads that module inside the DSH runtime
 * (`ELECTRON_RUN_AS_NODE=1 <DSH executable> ...`), so the host's own
 * `@deepseek-ai/cordis` / `dsh-tools` packages are what the adapter attaches to.
 *
 * This file only re-exports. No logic lives here, so adding a harness module can
 * never change production behaviour by itself.
 */

// --- plugin sources under test ---------------------------------------------
export {
  createDshHookHostAdapter,
  detectDshHookHost,
  DSH_HOOK_EVENT_NAMES,
  hookScopeMatches,
  readHookScope
} from '../../../src/cordis-seams/dsh-hook-host-adapter';
export type {
  DshHookEventName,
  DshHookHostAdapter,
  DshHookHostAdapterOptions,
  HookScopeIdentity
} from '../../../src/cordis-seams/dsh-hook-host-adapter';
export { createScopeRegistry, formatScopeKey, isInvariantScopeName } from '../../../src/jitrl/scope-registry';
export type { RegisteredScope, ScopeRegistrationSpec, ScopeRegistry, ScopeRole } from '../../../src/jitrl/scope-registry';
export {
  createHostToolExperienceCollector,
  HOST_TOOL_REWARD_SIGNALS,
  HOST_TURN_KIND_OBSERVATIONS
} from '../../../src/jitrl/host-tool-experience';
export type {
  HostToolExperienceCollector,
  HostToolExperienceSink,
  HostToolObservation,
  HostTurnObservation
} from '../../../src/jitrl/host-tool-experience';
export {
  createJitBridgeMirrorStore,
  JITRL_STAT_TAG,
  maskNamespace,
  maskServerId,
  sanitizeDiagnostic
} from '../../../src/jitrl/stores/bridge.store';
export type { BridgeMirrorStore, JitMirrorMcpClient } from '../../../src/jitrl/stores/bridge.store';
export { createJitRuntimeControl, JIT_SURFACES } from '../../../src/jitrl/runtime-control';
export type { JitRuntimeControl, JitSurface } from '../../../src/jitrl/runtime-control';
export { parseEvoHarnessConfig } from '../../../src/config';
export type { EvoHarnessConfig } from '../../../src/config';
export type { ExperienceRecord, IExperienceStore, JitStatsAggregate } from '../../../src/types/contracts';

// --- harness modules (structural assertions, no production effect) --------
export { probeHost, probeGateMode, createAlwaysAdvisingAdvisor, createRecordingStore } from '../../../tests/e2e/host-smoke/probe';
export type { HostProbeReport, HostModules, PluginModules } from '../../../tests/e2e/host-smoke/probe';
export { probeMcpBackend, MIRROR_DIAG_PREFIX } from '../../../tests/e2e/host-smoke/mcp-smoke';
export type { McpSmokeReport, MirrorStoreLike } from '../../../tests/e2e/host-smoke/mcp-smoke';
export { createStdioMcpClient } from '../../../tests/e2e/host-smoke/mcp-client';
export type { StdioMcpClient, StdioMcpClientOptions } from '../../../tests/e2e/host-smoke/mcp-client';
export { runDegradationMatrix, createStructuralHost, degradationConfig } from '../../../tests/e2e/host-smoke/degradation';
export type { DegradationResult, DegradationModules } from '../../../tests/e2e/host-smoke/degradation';
export {
  MANIFEST_DURABLE_EVENTS,
  MANIFEST_HOOK_EVENTS,
  summarizeManifest,
  validateManifest
} from '../../../tests/e2e/host-smoke/manifest';
export type {
  DurableEventCapability,
  HookCapability,
  HookIdentityAvailability,
  HostCapabilityManifest,
  HostFacts,
  ManifestDurableEvent,
  ManifestHookEvent,
  PermissionPrecedence,
  PluginFacts
} from '../../../tests/e2e/host-smoke/manifest';
export {
  assembleAndValidate,
  buildManifest,
  carrierOnlyIdentityEvents,
  hasPlainSessionIdOnlyIdentity,
  hookCapabilityOf,
  identityAvailabilityOf,
  permissionPrecedence
} from '../../../tests/e2e/host-smoke/assemble';
export type { ManifestAssemblyInput } from '../../../tests/e2e/host-smoke/assemble';
export {
  FORBIDDEN_SAMPLE_KEYS,
  SMOKE_PREFIX,
  boundDetail,
  makeSample,
  normalizeTag,
  smokeNaming,
  validateNaming,
  validateSample
} from '../../../tests/e2e/host-smoke/samples';
export type { SmokeNaming, SanitizedEventSample } from '../../../tests/e2e/host-smoke/samples';
export {
  REPORT_LAYERS,
  layerTitle,
  renderReport,
  stateCell,
  summarizeLayer,
  validateRows
} from '../../../tests/e2e/host-smoke/report-template';
export type { ReportHeader, ReportLayer, ScenarioRow, ScenarioState } from '../../../tests/e2e/host-smoke/report-template';
