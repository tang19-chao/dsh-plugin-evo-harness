#!/usr/bin/env node
/**
 * In-host runner (P6.1-F): executes the bundled harness inside the installed DSH runtime.
 *
 * This file runs with `ELECTRON_RUN_AS_NODE=1` and the DSH executable as the
 * interpreter, which is what makes `@deepseek-ai/cordis` / `dsh-tools` resolve to
 * the *installed* host packages instead of the repository's dev dependencies.
 *
 * It does, in order: load the esbuild bundle, resolve the real host packages,
 * run the hook probe (advisory mode) and the gate-mode probe, the single
 * MCP-backend smoke and the degradation matrix, assemble the
 * HostCapabilityManifest, derive the five-state report rows, and write
 * `result.json` + `report.md` into `HOSTSMOKE_OUT_DIR`.
 *
 * It exits 0 even when rows fail: a failed row is a legitimate, preserved result.
 * Only a crash (no result.json) makes the runner substitute a `not-run` report.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const __inHostDir = path.dirname(fileURLToPath(import.meta.url));

function fail(message) {
  console.error('[host-smoke] ' + message);
  throw new Error(message);
}

function env(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    fail('missing environment variable ' + name);
  }
  return value;
}

const bundlePath = env('HOSTSMOKE_BUNDLE');
const asarPath = env('HOSTSMOKE_ASAR');
const outDir = env('HOSTSMOKE_OUT_DIR');
const commit = process.env.HOSTSMOKE_COMMIT ?? 'unknown';
const worktreeDirty = process.env.HOSTSMOKE_DIRTY === '1';
const executableFile = process.env.HOSTSMOKE_EXECUTABLE ?? process.execPath;
const installDir = process.env.HOSTSMOKE_INSTALL_DIR ?? path.dirname(path.dirname(asarPath));
const hostVersionEnv = process.env.HOSTSMOKE_HOST_VERSION ?? 'unknown';
const electronVersion = process.env.HOSTSMOKE_ELECTRON_VERSION ?? process.versions.electron ?? 'unknown';

/**
 * The DSH product version. Read HERE (not in the runner) because only the
 * Electron runtime patches `fs` for `app.asar` paths; a plain-node read returns
 * ENOENT and would silently report "unknown". The installer's `version` file is
 * the ELECTRON version, so it is reported separately, never as the host version.
 */
function readHostProductVersion() {
  const readJsonVersion = (file) => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : undefined;
    } catch {
      return undefined;
    }
  };
  const fromAsar =
    readJsonVersion(path.join(asarPath, 'package.json')) ??
    readJsonVersion(path.join(asarPath, 'dsh', 'package.json'));
  if (fromAsar !== undefined) {
    return fromAsar;
  }
  return hostVersionEnv;
}
const hostVersion = readHostProductVersion();
const pluginVersion = process.env.HOSTSMOKE_PLUGIN_VERSION ?? 'unknown';
const bundleEntry = process.env.HOSTSMOKE_BUNDLE_ENTRY ?? 'tests/e2e/host-smoke/bundle-entry.ts';
const canary = process.env.HOSTSMOKE_CANARY ?? 'HOSTSMOKE-CANARY-DEFAULT';
const runId = process.env.HOSTSMOKE_RUN_ID ?? new Date().toISOString().replace(/[^0-9A-Za-z]/g, '').slice(0, 15);
const hostVersionFile = process.env.HOSTSMOKE_HOST_VERSION_FILE ?? '';

const harness = require(bundlePath);

/** Resolve one installed host package's CJS entry. */
function hostRequire(pkg) {
  return require(path.join(asarPath, 'dsh', 'node_modules', '@deepseek-ai', pkg));
}

const cordisPkg = JSON.parse(
  fs.readFileSync(path.join(asarPath, 'dsh', 'node_modules', '@deepseek-ai', 'cordis', 'package.json'), 'utf8')
);

const hostModules = {
  createContext: () => new (hostRequire('cordis').Context)(),
  SystemPrompt: hostRequire('dsh-system-prompt').SystemPrompt,
  ToolRuntime: hostRequire('dsh-tools').ToolRuntime,
  defineTool: hostRequire('dsh-tools').defineTool,
  versions: {
    dsh: hostVersion,
    cordis: cordisPkg.version,
    node: process.versions.node,
    electron: process.versions.electron ?? 'n/a',
    v8: process.versions.v8
  }
};

const runConfig = harness.parseEvoHarnessConfig({
  triggerMode: 'always',
  jitrl: {
    enabled: true,
    reward: { weights: { tool: 0.5, turn: 0.5, llm: 0, surrogate: 0, user: 0 }, clip: [-3, 3] }
  },
  memoryBridge: { namespacePrefix: 'harness2' },
  logging: { level: 'silent' }
});

const naming = harness.smokeNaming(runId);
const namingProblems = harness.validateNaming(naming);

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const startedAt = Date.now();

  // --- real host hook probe (advisory mode) --------------------------------
  let probeReport;
  let probeFailure;
  try {
    probeReport = await harness.probeHost({ host: hostModules, plugin: harness, config: runConfig, naming });
  } catch (error) {
    probeFailure = error instanceof Error ? error.name + ': ' + error.message : String(error);
  }

  // --- gate-mode probe (separate adapter over a fresh host context) -------
  let gateReport;
  let gateFailure;
  try {
    gateReport = await harness.probeGateMode({
      host: hostModules,
      plugin: harness,
      config: runConfig,
      sessionId: naming.sessionTags[0] ?? 'hostsmoke-untagged-s1',
      trustedScope: {
        sessionId: naming.sessionTags[0] ?? 'hostsmoke-untagged-s1',
        branchId: (naming.branchTags[naming.sessionTags[0] ?? ''] ?? ['hostsmoke-untagged-bA'])[0] ?? 'hostsmoke-untagged-bA',
        namespace: naming.namespaces.primary
      }
    });
  } catch (error) {
    gateFailure = error instanceof Error ? error.name + ': ' + error.message : String(error);
  }
  if (probeReport !== undefined && gateReport !== undefined) {
    probeReport.gatePath = {
      anonymousAskCount: gateReport.anonymousAskCount,
      anonymousScopeUnknownSkipped: gateReport.anonymousScopeUnknownSkipped,
      anonymousToolExecuted: gateReport.anonymousToolExecuted,
      anonymousDecision: gateReport.anonymousDecision
    };
    probeReport.notes.push(...gateReport.notes);
  }

  // --- degradation matrix (structural host: the adapter contract) --------
  let degradation = [];
  let degradationFailure;
  try {
    degradation = await harness.runDegradationMatrix({
      modules: {
        createDshHookHostAdapter: harness.createDshHookHostAdapter,
        createScopeRegistry: harness.createScopeRegistry,
        createHostToolExperienceCollector: harness.createHostToolExperienceCollector,
        parseEvoHarnessConfig: harness.parseEvoHarnessConfig
      },
      config: runConfig
    });
  } catch (error) {
    degradationFailure = error instanceof Error ? error.name + ': ' + error.message : String(error);
  }

  // --- single MCP backend smoke -------------------------------------------
  let mcpReport;
  let mcpFailure;
  try {
    mcpReport = await harness.probeMcpBackend({
      createMirrorStore: harness.createJitBridgeMirrorStore,
      spawnProcess: (command, args, options) =>
        spawn(command, [...args], {
          cwd: options.cwd,
          env: options.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        }),
      executable: process.execPath,
      serverScript: process.env.HOSTSMOKE_MCP_SERVER ?? '',
      workingDir: process.env.HOSTSMOKE_MCP_CWD ?? process.cwd(),
      canary,
      requestTimeoutMs: 4_000
    });
  } catch (error) {
    mcpFailure = error instanceof Error ? error.name + ': ' + error.message : String(error);
  }

  // --- eight-surface classification (rev5 P1-1 / A-t10-3) -----------------
  // Resolve the adapter exactly as the plugin would (same capability order as
  // resolveHostAdapter), then classify each HARNESS_COMPONENT_KEYS surface from
  // what that adapter actually exposes. A face the bare Cordis Context cannot
  // observe stays `not-run` with the limitation recorded; nothing is inferred
  // from config.
  let surfaceMatrix;
  let surfaceMatrixFailure;
  let surfaceStatus;
  let surfaceStatusProblems = [];
  let surfaceStatusFailure;
  let surfaceAdapter;
  try {
    const surfaceDiagnostics = [];
    const surfaceCtx = hostModules.createContext();
    // The smoke's adapter is the same one probeHost attaches (the dsh-hooks
    // adapter over this context). `resolveHostAdapter` is recorded separately:
    // on a BARE Cordis Context it falls through to the in-memory reference,
    // because a bare context carries none of the DSH services the detection
    // requires. Reporting only the production fallback would contradict the
    // hook evidence in this very report, and reporting only the hook adapter
    // without the note would hide that limitation.
    const smokeAdapter = harness.createDshHookHostAdapter(surfaceCtx, {
      onDiagnostic: (message) => surfaceDiagnostics.push(message)
    });
    surfaceAdapter = smokeAdapter;
    const productionResolution = harness.resolveHostAdapter(surfaceCtx, {}, surfaceDiagnostics);
    const structuralAdapter = harness.createCordisHostFromContext(surfaceCtx);
    const hookEvidence = (probeReport?.hooks ?? []).map((hook) => ({
      event: hook.event,
      dispatched: hook.dispatched,
      payloadFields: hook.payloadFields
    }));
    surfaceMatrix = harness.classifySurfaceMatrix({
      capturedAt: new Date().toISOString(),
      adapter: smokeAdapter,
      hostAdapterSource: 'dsh-hooks',
      hookDetected: (probeReport?.installedHookEvents ?? []).length > 0,
      installedHookEvents: probeReport?.installedHookEvents ?? [],
      hookEvidence,
      structuralSeams: harness.hostAdapterSeamCount(structuralAdapter),
      enabledSurfaces: runConfig.enabledSurfaces,
      resolveHostAdapterSource: productionResolution.hostAdapterSource,
      resolveNote:
        '生产解析在同一裸上下文上得到 `' + productionResolution.hostAdapterSource + '`（裸上下文不含 ctx.systemPrompt/ctx.tools/ctx.agents 服务，' +
        'detectDshHookHost 因此不成立）；本表按插件在真实宿主中实际挂载的 dsh-hooks 适配器分类，hook 型面附 manifest 的真实 dispatch 事实。',
      contextKind: 'bare-cordis-context'
    });
    const matrixProblems = harness.validateSurfaceMatrix(surfaceMatrix);
    if (matrixProblems.length > 0) {
      surfaceMatrixFailure = 'surface matrix invalid: ' + matrixProblems.join('; ');
    }
    for (const note of surfaceDiagnostics) {
      probeReport?.notes.push('surface-matrix: ' + note);
    }
  } catch (error) {
    surfaceMatrixFailure = error instanceof Error ? error.name + ': ' + error.message : String(error);
  }

  // --- plugin-side read-only surface status (rev5 P1-2 / A-t10-2) ---------
  // `plugin.surfaces` is the same projection a host page would read; the smoke
  // reads it through the exported snapshot function so the table below is
  // produced by production code, not by report code.
  try {
    if (surfaceAdapter !== undefined) {
      surfaceStatus = harness.surfaceStatusSnapshot(runConfig, surfaceAdapter);
      surfaceStatusProblems = harness.validateSurfaceStatusSnapshot(surfaceStatus);
    }
  } catch (error) {
    surfaceStatusFailure = error instanceof Error ? error.name + ': ' + error.message : String(error);
  }

  const capturedAt = new Date().toISOString();

  // --- REAL APPLY CONTEXT (rev6 R2-1 / R2-2) ------------------------------
  // rc2 classified the eight surfaces from an adapter the SMOKE built on a bare
  // Cordis Context, and had to DISCLAIM that production would have resolved a
  // different adapter (`resolveNote`). rc3 calls the plugin's own `apply()` on a
  // context that really has ctx.systemPrompt/ctx.tools mounted, so the reported
  // adapter and the production resolution are the SAME object - a fact, not a
  // disclaimer.
  let applyProbe;
  let applyProbeFailure;
  let applyJudgement;
  const applyNotes = [];
  try {
    const applyBundlePath = process.env.HOSTSMOKE_APPLY_BUNDLE ?? '';
    if (applyBundlePath === '' || !fs.existsSync(applyBundlePath)) {
      applyProbeFailure = 'the apply bundle was not built (runner reported a build failure); apply-context evidence is not-run';
    } else {
      const applyHarness = require(applyBundlePath);
      const { probeApplyContext, judgeApplyContext } = await import(
        pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'apply-context.mjs')).href
      );
      // The apply bundle carries PRODUCTION symbols only. The classification
      // helpers are harness code, so they are merged in from the ALREADY
      // unit-tested harness bundle rather than duplicating them (or pulling
      // tests/e2e into a production bundle).
      const applyPlugin = {
        ...applyHarness,
        classifySurfaceMatrix: harness.classifySurfaceMatrix,
        validateSurfaceMatrix: harness.validateSurfaceMatrix
      };
      applyProbe = await probeApplyContext({
        host: {
          createContext: () => new (hostRequire('cordis').Context)(),
          SystemPrompt: hostModules.SystemPrompt,
          ToolRuntime: hostModules.ToolRuntime
        },
        plugin: applyPlugin,
        config: runConfig,
        expectedHookEvents: [...(harness.DSH_HOOK_EVENT_NAMES ?? [])]
      });
      applyJudgement = judgeApplyContext(applyProbe);
    }
  } catch (error) {
    applyProbeFailure = error instanceof Error ? error.name + ': ' + error.message : String(error);
  }
  if (applyProbe !== undefined && applyProbe.applyContext.applyError !== null) {
    applyProbeFailure = applyProbe.applyContext.applyError;
  }
  if (applyProbe !== undefined) {
    const applyNote =
      'apply-context: apply() handle=' + String(applyProbe.applyContext.applyReturnedHandle) +
      ' hooks=' + String(applyProbe.hookRegistration.registered.length) +
      ' expectedMissing=' + String(applyProbe.hookRegistration.missing.length) +
      ' productionResolved=' + applyProbe.applyContext.productionResolvedSource +
      ' crossCheck=' + String(applyProbe.crossCheck.checked) + '/8 disagreements=' + String(applyProbe.crossCheck.disagreements.length);
    if (probeReport !== undefined) {
      probeReport.notes.push(applyNote);
    }
    applyNotes.push(applyNote);
  }

  // The manifest is assembled by the unit-tested `buildManifest()`, which only
  // ever reads host-real evidence (`probeReport.hooks`). Contract-shaped
  // dispatches live in `probeReport.contractShapedHooks` and are deliberately
  // not reachable from that function.
  const manifestInput = {
    capturedAt,
    host: {
      product: 'DeepSeek Harness',
      version: hostVersion,
      installDir,
      executable: executableFile,
      asarPath,
      cordisVersion: cordisPkg.version,
      runtime: {
        node: process.versions.node,
        electron: process.versions.electron ?? 'n/a',
        v8: process.versions.v8,
        platform: process.platform,
        arch: process.arch
      }
    },
    plugin: { name: 'dsh-plugin-evo-harness', version: pluginVersion, commit, worktreeDirty, bundleEntry },
    probe: probeReport ?? null,
    gate: gateReport ?? null,
    gate4BlockedBy: [
      'real model call and real memory write require explicit user authorization (task §9.2/§9.4)',
      'the host provides no branchId on any hook dispatch (identity is sessionId via payload, or carrier-only on agent/pre-step), so the D1 §2.5 host-session scope registration path is still unproven against a branch-aware host',
      'security contract (F9/provenance/mirror diagnostics) must be closed in P6_STATUS before Gate 4'
    ],
    permissionEvidence: probeReport
      ? [
          'host deny deeper in the chain preserved=' + String(probeReport.permissions.hostDenyPreserved),
          'host cancel deeper in the chain preserved=' + String(probeReport.permissions.hostCancelPreserved),
          'anonymous dispatch executed (passthrough)=' + String(probeReport.permissions.anonymousPassThrough),
          'gate-mode asks on an unprovable identity=' + String(gateReport?.anonymousAskCount ?? 0) +
            ' (0 expected: D1 closes the advice channel; Jit ask never outranks the host)',
          'trusted-scope gate asks=' + String(gateReport?.trustedAskCount ?? 0) + ' (1 expected: the ask path is live)',
          'adapter installed ' + String(probeReport.installedHookEvents.length) + ' listeners; none returns deny'
        ]
      : ['live permission probe did not run']
  };
  const assembly = harness.assembleAndValidate(manifestInput);
  const manifest = assembly.manifest;
  const manifestProblems = assembly.problems;
  const scenarioByName = (name) =>
    probeReport === undefined ? undefined : probeReport.scenarios.find((entry) => entry.scenario === name);
  const rows = [];
  const addRow = (row) => rows.push(row);
  const probeNote = probeReport === undefined ? (probeFailure ?? 'host probe unavailable') : '';

  // 9.2-1 — two sessions x two branches: domain / invariant / ordinary tool.
  const contractDomain = scenarioByName('contract-shaped-domain-registered');
  const contractInvariant = scenarioByName('contract-shaped-invariant-registered');
  addRow({
    id: '9.2-1',
    layer: 'security-contract',
    expected:
      'Two sessions × two branches: a trusted domain branch is learnable, a trusted invariant branch gets neither advice nor a learned record, and ordinary tool calls still execute.',
    observed: probeReport
      ? 'domain records=' + String(contractDomain?.recordsAppended ?? 0) +
        ', invariant records=' + String(contractInvariant?.recordsAppended ?? 0) +
        ', domain toolError=' + String(contractDomain?.toolError ?? 'n/a') +
        ', host-real records=' + String(probeReport.scenarios.filter((entry) => entry.source === 'host-real').reduce((sum, entry) => sum + entry.recordsAppended, 0))
      : 'host probe did not run',
    state:
      probeReport && (contractDomain?.recordsAppended ?? 0) > 0 && (contractInvariant?.recordsAppended ?? 0) === 0 && (contractDomain?.toolError ?? true) === false
        ? 'passed'
        : 'failed',
    note: probeReport
      ? (contractDomain?.recordsAppended ?? 0) > 0
        ? ''
        : 'the trusted domain registration produced no learned record'
      : probeNote,
    authorization: 'not-required',
    evidence: probeReport ? ['contract-shaped scenarios (labelled in the report)'] : []
  });

  // 9.2-2 — per-hook identity availability + sibling probe not ordinary.
  const hostRealSibling = scenarioByName('host-real-sibling-same-session');
  const identityLines = probeReport
    ? probeReport.hooks.map(
        (hook) =>
          hook.event + '[branch=' + String(hook.branchIds) + ' session=' + String(hook.sessionIds) + ' ns=' + String(hook.namespaces) + ']'
      )
    : [];
  addRow({
    id: '9.2-2',
    layer: 'real-host-compatibility',
    expected:
      'Record which identity each hook really provides, and prove a sibling probe sharing one sessionId is not mistaken for an ordinary session (no advice, no record).',
    observed: probeReport
      ? 'identity per hook: ' + identityLines.join(' ') +
        '; host-real sibling advice=' + String((hostRealSibling?.advisorCalls ?? 0) > 0) +
        ', records=' + String(hostRealSibling?.recordsAppended ?? 0) +
        '; agentCarrierOnToolDispatch=' + String(manifest.surfaces.agentCarrierOnToolDispatch)
      : 'host probe did not run',
    state:
      probeReport && (hostRealSibling?.advisorCalls ?? 1) === 0 && (hostRealSibling?.recordsAppended ?? 1) === 0
        ? 'passed'
        : 'failed',
    note: probeReport
      ? (hostRealSibling?.advisorCalls ?? 1) === 0
        ? ''
        : 'a sibling probe sharing one sessionId received advice'
      : probeNote,
    authorization: 'not-required',
    evidence: probeReport ? ['HostCapabilityManifest.identity.perHook'] : []
  });

  // 9.2-3 — off -> on, mid-flight off, abort, timeout, dispose: no residue.
  addRow({
    id: '9.2-3',
    layer: 'engineering-runnable',
    expected:
      'off stops advice and collection, on restores advice, an in-flight call is aborted, the slow tool settles, and dispose leaves zero listeners/mounts/further observations.',
    observed: probeReport
      ? 'offStopsAdvice=' + String(probeReport.runtimeControl.offStopsAdvice) +
        ' offStopsCollection=' + String(probeReport.runtimeControl.offStopsCollection) +
        ' onRestoresAdvice=' + String(probeReport.runtimeControl.onRestoresAdvice) +
        ' abortSettled=' + String(probeReport.lifecycle.abortSettled) + '(' + String(probeReport.lifecycle.abortElapsedMs) + 'ms)' +
        ' listenersAfterDispose=' + String(probeReport.lifecycle.listenersAfterDispose) +
        ' mountsAfterDispose=' + String(probeReport.lifecycle.mountsAfterDispose) +
        ' postDisposeObservations=' + String(probeReport.lifecycle.observationsDeltaAfterDispose)
      : 'host probe did not run',
    state:
      probeReport &&
      probeReport.runtimeControl.offStopsAdvice &&
      probeReport.runtimeControl.offStopsCollection &&
      probeReport.runtimeControl.onRestoresAdvice &&
      probeReport.lifecycle.abortSettled &&
      probeReport.lifecycle.listenersAfterDispose === 0 &&
      probeReport.lifecycle.observationsDeltaAfterDispose === 0 &&
      probeReport.lifecycle.mountsAfterDispose === 0
        ? 'passed'
        : 'failed',
    note: probeReport
      ? [
          probeReport.runtimeControl.offStopsAdvice ? '' : 'off did not stop advice',
          probeReport.runtimeControl.offStopsCollection ? '' : 'off did not stop collection',
          probeReport.runtimeControl.onRestoresAdvice ? '' : 'on did not restore advice',
          probeReport.lifecycle.abortSettled ? '' : 'aborted call never settled',
          probeReport.lifecycle.listenersAfterDispose === 0 ? '' : 'listeners left after dispose',
          probeReport.lifecycle.mountsAfterDispose === 0 ? '' : 'mounts left after dispose',
          probeReport.lifecycle.observationsDeltaAfterDispose === 0 ? '' : 'observations after dispose'
        ]
          .filter((entry) => entry.length > 0)
          .join('; ')
      : probeNote,
    authorization: 'not-required',
    evidence: probeReport ? ['in-host runtime control + dispose counters'] : []
  });

  // 9.2-4 — the host's own deny/cancel wins.
  addRow({
    id: '9.2-4',
    layer: 'security-contract',
    expected: 'A deny AND a cancel decided deeper in the waterfall by the host survive the adapter; Jit never denies.',
    observed: probeReport
      ? 'host deny preserved=' + String(probeReport.permissions.hostDenyPreserved) +
        ', host cancel preserved=' + String(probeReport.permissions.hostCancelPreserved)
      : 'host probe did not run',
    state:
      probeReport && probeReport.permissions.hostDenyPreserved && probeReport.permissions.hostCancelPreserved
        ? 'passed'
        : 'failed',
    note: probeReport
      ? [
          probeReport.permissions.hostDenyPreserved ? '' : 'host deny was overridden',
          probeReport.permissions.hostCancelPreserved ? '' : 'host cancel was overridden'
        ]
          .filter((entry) => entry.length > 0)
          .join('; ')
      : probeNote,
    authorization: 'not-required',
    evidence: probeReport ? ['dsh-tools error result after host deny/cancel'] : []
  });

  // 9.2-5 — missing identity -> D1 passthrough without learning.
  const hostRealNoAgent = scenarioByName('host-real-no-agent');
  addRow({
    id: '9.2-5',
    layer: 'security-contract',
    expected:
      'An identity-free dispatch (and a plain-sessionId dispatch) is passed through to the tool body with no advice and no learning record; the skip is counted without storing a payload.',
    observed: probeReport
      ? 'anonymous passThrough=' + String(probeReport.permissions.anonymousPassThrough) +
        ', anonymous records=' + String(hostRealNoAgent?.recordsAppended ?? 0) +
        ', anonymous scopeUnknownSkipped=' + String(probeReport.advisoryPath.scopeUnknownSkipped) +
        ', host-real advice=' + String(probeReport.advisoryPath.advisorCalls > 0) +
        ', gate asks=' + String(probeReport.gatePath.anonymousAskCount) +
        ', gate tool executed=' + String(probeReport.gatePath.anonymousToolExecuted)
      : 'host probe did not run',
    state:
      probeReport &&
      probeReport.permissions.anonymousPassThrough &&
      (hostRealNoAgent?.recordsAppended ?? 1) === 0 &&
      probeReport.advisoryPath.advisorCalls === 0 &&
      probeReport.advisoryPath.scopeUnknownSkipped > 0
        ? 'passed'
        : 'failed',
    note: probeReport
      ? [
          probeReport.permissions.anonymousPassThrough ? '' : 'anonymous dispatch was not passed through',
          (hostRealNoAgent?.recordsAppended ?? 1) === 0 ? '' : 'anonymous dispatch produced a learning record',
          probeReport.advisoryPath.advisorCalls === 0 ? '' : 'anonymous dispatch reached the advisor',
          probeReport.advisoryPath.scopeUnknownSkipped > 0 ? '' : 'the D1 skip was not counted'
        ]
          .filter((entry) => entry.length > 0)
          .join('; ')
      : probeNote,
    authorization: 'not-required',
    evidence: probeReport ? ['D1 fail-closed counters + gate-mode anonymity probe'] : []
  });

  // 9.2-6 — namespace isolation is a logical boundary, not an OS sandbox.
  addRow({
    id: '9.2-6',
    layer: 'security-contract',
    expected:
      'Boundary stated explicitly: namespace/branch isolation is logical (ScopeRegistry + hook scope matching + advice/learning channels). It is NOT an OS sandbox and cannot stop a tool body from reading the filesystem; only the host sandbox policy can.',
    observed:
      "namespace isolation = ScopeRegistry trust + hook scope matching (logical). OS sandboxing remains the host's own sandbox seam and was NOT exercised by this smoke.",
    state: 'passed',
    note: '',
    authorization: 'not-required',
    evidence: ['docs/adr/0001 §2.6 (Gate 4 capability list)', 'dsh-tools sandbox seam is host-owned (not bridged here)']
  });

  // 9.2-7 — gate mode: ask is possible, deny is not, and D1 closes the ask for
  // an unprovable identity (so an unproven dispatch gains no extra friction).
  addRow({
    id: '9.2-7',
    layer: 'security-contract',
    expected:
      'Gate mode can only ASK (never deny): a trusted scope gets exactly one ask, which the host ToolRuntime turns into its own approval flow; an unprovable identity gets NO ask and still executes.',
    observed: gateReport
      ? 'unproven: asks=' + String(gateReport.anonymousAskCount) +
        ' executed=' + String(gateReport.anonymousToolExecuted) +
        ' skippedCounted=' + String(gateReport.anonymousScopeUnknownSkipped) +
        '; trusted: asks=' + String(gateReport.trustedAskCount) +
        ' executedByHost=' + String(gateReport.trustedToolExecuted) +
        ' (false means the host approval flow withheld execution after the ask — not that Jit denied)'
      : 'gate probe did not run',
    state:
      gateReport &&
      gateReport.anonymousAskCount === 0 &&
      gateReport.anonymousToolExecuted === true &&
      gateReport.anonymousScopeUnknownSkipped > 0 &&
      gateReport.trustedAskCount === 1
        ? 'passed'
        : 'failed',
    note: gateReport
      ? [
          gateReport.anonymousAskCount === 0 ? '' : 'an unproven identity received a Jit ask',
          gateReport.anonymousToolExecuted ? '' : 'an unproven identity was not passed through',
          gateReport.anonymousScopeUnknownSkipped > 0 ? '' : 'the D1 skip was not counted',
          gateReport.trustedAskCount === 1 ? '' : 'a trusted scope did not receive exactly one ask (gate path not exercised)'
        ]
          .filter((entry) => entry.length > 0)
          .join('; ')
      : (gateFailure ?? 'gate probe unavailable'),
    authorization: 'not-required',
    evidence: gateReport ? ['gate-mode adapter over the real dsh-tools approval path'] : []
  });

  // 9.2-8 — `turn/end` is a durable session event, NOT a decision hook.
  addRow({
    id: '9.2-8',
    layer: 'real-host-compatibility',
    expected:
      '`turn/end` is a durable session observation, not a decision hook: it must be recorded as such (dispatch=session-append), never counted among the four hooks, and its listener must be removable.',
    observed: probeReport
      ? 'listenerInstalled=' + String(probeReport.durableEvent.listenerInstalled) +
        ' disposerKind=' + probeReport.durableEvent.disposerKind +
        ' hookCount=' + String(probeReport.installedHookEvents.length) +
        ' (turn/end excluded from hooks)'
      : 'host probe did not run',
    state: probeReport && probeReport.durableEvent.listenerInstalled ? 'passed' : 'failed',
    note: probeReport
      ? probeReport.durableEvent.listenerInstalled
        ? ''
        : 'the host did not accept a turn/end listener'
      : probeNote,
    authorization: 'not-required',
    evidence: ['HostCapabilityManifest.durableEvents', 'installed dsh-agent-loop: session.append("turn/end", ...)']
  });

  // Event-shape degradation rows (D1 passthrough).
  for (const entry of degradation) {
    addRow({
      id: '9.2-shape-' + entry.id.replace(/^shape-/, ''),
      layer: 'security-contract',
      expected: entry.requirement,
      observed:
        'injected=' + entry.injected + '; hostDecision=' + entry.hostDecision + ' observed=' + entry.observedDecision +
        '; advisorCalls=' + String(entry.advisorCalls) + '; records=' + String(entry.recordsAppended),
      state: entry.passed ? 'passed' : 'failed',
      note: entry.passed ? '' : 'the degradation assertion failed (see the observed decision/counters)',
      authorization: 'not-required',
      evidence: ['tests/e2e/host-smoke/degradation.ts']
    });
  }
  if (degradationFailure !== undefined) {
    addRow({
      id: '9.2-shape-matrix',
      layer: 'security-contract',
      expected: 'The event-shape degradation matrix runs to completion.',
      observed: 'matrix aborted',
      state: 'failed',
      note: degradationFailure,
      authorization: 'not-required',
      evidence: []
    });
  }

  // 9.3 — single real MCP backend.
  const mcpOk =
    mcpReport !== undefined &&
    mcpReport.discovered.length >= 5 &&
    mcpReport.aggregate.written === 1 &&
    mcpReport.canary.degraded === true &&
    mcpReport.canary.leaked === false &&
    mcpReport.canary.freeTextLine === false &&
    mcpReport.off.backendCalls === 0 &&
    mcpReport.timeout.settled === true &&
    mcpReport.restart.sameTools === true &&
    mcpReport.restart.repeatWrite === 1;
  addRow({
    id: '9.3-1',
    layer: 'real-host-compatibility',
    expected:
      'One real stdio MCP backend: discovery, aggregate-only mirror write, no error-body echo (canary stays out of diagnostics), zero backend calls while the mirror is off, timeout handled, restart rediscovery identical and idempotent.',
    observed: mcpReport
      ? 'tools=' + String(mcpReport.discovered.length) +
        ' written=' + String(mcpReport.aggregate.written) +
        ' canaryDegraded=' + String(mcpReport.canary.degraded) +
        ' canaryLeaked=' + String(mcpReport.canary.leaked) +
        ' freeTextLine=' + String(mcpReport.canary.freeTextLine) +
        ' ns=' + mcpReport.writeNamespace +
        ' callsWhileOff=' + String(mcpReport.off.backendCalls) +
        ' timeoutSettled=' + String(mcpReport.timeout.settled) + '(' + String(mcpReport.timeout.elapsedMs) + 'ms)' +
        ' restartSpawns=' + String(mcpReport.restart.spawns) +
        ' sameTools=' + String(mcpReport.restart.sameTools) +
        ' repeatWrite=' + String(mcpReport.restart.repeatWrite)
      : 'MCP backend smoke did not run',
    state: mcpOk ? 'passed' : 'failed',
    note: mcpReport
      ? mcpOk
        ? ''
        : 'one or more §9.3 obligations did not hold (see counters)'
      : (mcpFailure ?? 'MCP smoke unavailable'),
    authorization: 'not-required',
    evidence: mcpReport ? ['real stdio JSON-RPC backend + real mirror store'] : []
  });

  // 9.4 — controlled release boundary.
  addRow({
    id: '9.4-1',
    layer: 'security-contract',
    expected:
      'No real business namespace is entered while the security contract is open; baseline execution + shadow advice only, L3/mirror stay default-off.',
    observed:
      'test tags only: ' + naming.sessionTags.join(',') +
      '; namespaces=' + naming.namespaces.primary + ',' + naming.namespaces.secondary +
      '; business namespace ' + naming.namespaces.businessNamespace + ' never addressed; mirror/L3 default-off in config',
    state: namingProblems.length === 0 ? 'passed' : 'failed',
    note: namingProblems.length === 0 ? '' : namingProblems.join('; '),
    authorization: 'not-required',
    evidence: ['tests/e2e/host-smoke/samples.ts validateNaming']
  });

  // 9.4 — real model call / real memory write: authorized, or honestly not-run.
  const authorized = process.env.HOSTSMOKE_AUTHORIZED === '1';
  addRow({
    id: '9.4-2',
    layer: 'task-benefit',
    expected:
      'A real model call and a real memory write, executed only under explicit user authorization (environment + account + budget), with the evidence recorded.',
    observed: authorized
      ? 'authorization was signalled but this harness has no account/budget binding to prove it; refusing to fabricate evidence'
      : 'no explicit user authorization for a real model call / real memory write in this environment',
    state: authorized ? 'failed' : 'not-run',
    note: authorized
      ? 'the authorization flag could not be bound to an account/budget, so no real call was made'
      : 'requires explicit user authorization (environment + account + budget); the harness deliberately does not mock it',
    authorization: authorized ? 'granted' : 'absent',
    evidence: []
  });

  addRow({
    id: '9.4-3',
    layer: 'task-benefit',
    expected: 'Shadow RC task-benefit comparison (baseline execution + recorded advice) in authorized real sessions.',
    observed: 'not measured: needs authorized real sessions plus the RewardContract (P6.1-D) closed',
    state: 'not-run',
    note: 'depends on explicit authorization and on P6.1-D/E; no synthetic number is substituted',
    authorization: 'absent',
    evidence: []
  });

  // Engineering runnable: the harness itself ran inside the host.
  addRow({
    id: '9.0-1',
    layer: 'engineering-runnable',
    expected:
      'The smoke harness loads inside the installed host, the adapter attaches to the real event bus, the manifest validates, and the run finishes inside the deadline.',
    observed: probeReport
      ? 'detected=' + String(probeReport.detection.detected) +
        '; installedHooks=' + String(probeReport.installedHookEvents.length) +
        '; detectedEvents=' + String(probeReport.hooks.filter((hook) => hook.dispatched).length) +
        '; manifestProblems=' + String(manifestProblems.length)
      : 'host probe did not run',
    state:
      probeReport && probeReport.detection.detected && probeReport.installedHookEvents.length >= 4 && manifestProblems.length === 0
        ? 'passed'
        : 'failed',
    note: probeReport ? (manifestProblems.length > 0 ? manifestProblems.join('; ') : '') : probeNote,
    authorization: 'not-required',
    evidence: ['HostCapabilityManifest validateManifest']
  });

  // Learning semantics: shadow != jit off; invariant never learns.
  addRow({
    id: '9.5-1',
    layer: 'learning-semantics',
    expected:
      'Shadow means baseline execution + recorded advice: switching Jit off stops all seven surfaces, while invariant scopes never become learning material.',
    observed: probeReport
      ? 'sevenSurfacesOff=' + String(probeReport.runtimeControl.sevenSurfacesOff) +
        ' generationMoved=' + String(probeReport.runtimeControl.generationMoved) +
        ' invariantRecords=' + String(contractInvariant?.recordsAppended ?? 0) +
        ' hostRealLearned=' + String(probeReport.scenarios.filter((entry) => entry.source === 'host-real').reduce((sum, entry) => sum + entry.recordsAppended, 0))
      : 'host probe did not run',
    state:
      probeReport && probeReport.runtimeControl.sevenSurfacesOff && probeReport.runtimeControl.generationMoved && (contractInvariant?.recordsAppended ?? 1) === 0
        ? 'passed'
        : 'failed',
    note: probeReport
      ? [
          probeReport.runtimeControl.sevenSurfacesOff ? '' : 'not all seven surfaces turned off',
          probeReport.runtimeControl.generationMoved ? '' : 'the runtime generation never advanced',
          (contractInvariant?.recordsAppended ?? 1) === 0 ? '' : 'an invariant scope produced a learning record'
        ]
          .filter((entry) => entry.length > 0)
          .join('; ')
      : probeNote,
    authorization: 'not-required',
    evidence: ['runtime-control JIT_SURFACES seven-surface check']
  });

  // Eight-surface classification (rev5 P1-1): the obligation is that every
  // surface carries a classification with probe evidence and an explicit
  // limitation. It does NOT assert that every face is native.
  const surfaceCounts = surfaceMatrix === undefined ? undefined : harness.countSurfaceAvailability(surfaceMatrix);
  const surfaceStatusOk = surfaceStatus !== undefined && surfaceStatusProblems.length === 0;
  addRow({
    id: '9.6-1',
    layer: 'real-host-compatibility',
    expected:
      'Every HARNESS_COMPONENT_KEYS surface is classified native/fallback/unavailable/not-run from probe evidence (rev5 P1-1 / A-t10-3); "not-run" faces name the harness limitation instead of being upgraded to native.',
    observed:
      surfaceMatrix === undefined
        ? 'the surface-matrix probe did not run: ' + (surfaceMatrixFailure ?? 'unknown reason')
        : 'native=' + String(surfaceCounts.native) +
          ' fallback=' + String(surfaceCounts.fallback) +
          ' unavailable=' + String(surfaceCounts.unavailable) +
          ' not-run=' + String(surfaceCounts['not-run']) +
          '; adapter=' + surfaceMatrix.hostAdapterSource +
          '; hookDetected=' + String(surfaceMatrix.hookDetected) +
          '; structuralSeams=' + String(surfaceMatrix.structuralSeams) +
          '; matrixProblems=0',
    state: surfaceMatrix !== undefined && surfaceMatrixFailure === undefined ? 'passed' : 'failed',
    note: surfaceMatrix !== undefined && surfaceMatrixFailure === undefined ? '' : (surfaceMatrixFailure ?? 'surface matrix unavailable'),
    authorization: 'absent',
    evidence: [
      '八表面逐面分类（附录 A.2）',
      'adapter=' + (surfaceMatrix?.hostAdapterSource ?? 'none') + '; contextKind=' + (surfaceMatrix?.contextKind ?? 'not-run')
    ]
  });

  // Read-only status aggregation (rev5 P1-2): enabled/mountable/lastMountResult
  // with the collect-or-omit rule and cacheRead=unknown. Passed only when the
  // snapshot exists AND passes its own coherence validation.
  const statusObserved = surfaceStatus === undefined ? 0 : surfaceStatus.filter((entry) => 'lastMountResult' in entry).length;
  addRow({
    id: '9.6-2',
    layer: 'real-host-compatibility',
    expected:
      'The plugin exposes a read-only per-surface status: enabled (config) vs mountable (adapter), lastMountResult/seamUnavailable only when observed (collect-or-omit), cacheRead=unknown (A-t10-2).',
    observed:
      surfaceStatus === undefined
        ? 'the status snapshot did not run: ' + (surfaceStatusFailure ?? 'adapter unresolved')
        : 'mountable=' + String(surfaceStatus.filter((entry) => entry.mountable).length) +
          '/8 enabled=' + String(surfaceStatus.filter((entry) => entry.enabled).length) +
          '/8 lastMountResult observed=' + String(statusObserved) +
          '/8 cacheRead=unknown/8 statusProblems=' + String(surfaceStatusProblems.length),
    state: surfaceStatusOk ? 'passed' : 'failed',
    note: surfaceStatusOk
      ? ''
      : (surfaceStatusProblems.length > 0
          ? surfaceStatusProblems.join('; ')
          : (surfaceStatusFailure ?? 'status snapshot unavailable')),
    authorization: 'absent',
    evidence: [
      '插件只读状态聚合（附录 A.3）',
      'source=surfaceStatusSnapshot(runConfig, dshHooksAdapter)'
    ]
  });

  const rowProblems = harness.validateRows(rows);
  if (gateFailure !== undefined) {
    rowProblems.push('gate-mode probe failed: ' + gateFailure);
  }

  // --- rev6 R2-1: the REAL apply context ----------------------------------
  // The distinction this row exists to make: rc2's matrix came from a bare
  // Cordis Context on which production resolution and the smoke's adapter
  // DISAGREED (`resolveNote` had to explain it). Here the plugin's own apply()
  // runs on a context with the real services, so resolution and classification
  // agree - and that agreement is asserted, not described.
  const applyEvidenceRow = (() => {
    if (applyProbe === undefined) {
      return {
        state: 'not-run',
        observed: 'the apply-context probe did not run: ' + (applyProbeFailure ?? 'unknown reason'),
        note: applyProbeFailure ?? 'apply context unavailable'
      };
    }
    const judge = applyJudgement ?? { applyContextEvidence: false, surfaceEvidence: false, applyReasons: ['judgement missing'], branchReasons: [] };
    const observerNote = applyProbe.hookRegistration.extra.length === 0
      ? ''
      : ' (+' + String(applyProbe.hookRegistration.extra.length) + ' lifecycle hooks beyond the four dispatch hooks)';
    return {
      state: judge.applyContextEvidence && judge.surfaceEvidence ? 'passed' : 'failed',
      observed:
        'apply() handle=' + String(applyProbe.applyContext.applyReturnedHandle) +
        '; ctx services tools=' + String(applyProbe.applyContext.services.tools) +
        ' systemPrompt=' + String(applyProbe.applyContext.services.systemPrompt) +
        '; productionResolved=' + applyProbe.applyContext.productionResolvedSource +
        '; classify adapter=' + (applyProbe.matrix === null ? 'none' : applyProbe.matrix.hostAdapterSource) +
        '; hooksRegistered=' + String(applyProbe.hookRegistration.registered.length) +
        ' expectedMissing=' + String(applyProbe.hookRegistration.missing.length) +
        observerNote + '; crossCheck=' + String(applyProbe.crossCheck.checked) + '/8' +
        ' disagreements=' + String(applyProbe.crossCheck.disagreements.length),
      note: judge.applyReasons.join('; ')
    };
  })();
  addRow({
    id: '9.6-3',
    layer: 'real-host-compatibility',
    expected:
      'Evidence is taken from the plugin\'s OWN apply() context (real ctx.systemPrompt/ctx.tools mounted), not from an adapter the smoke constructed on a bare Cordis Context; production resolveHostAdapter and the classified adapter must be the same source (rev6 R2-1).',
    observed: applyEvidenceRow.observed,
    state: applyEvidenceRow.state,
    note: applyEvidenceRow.note,
    authorization: 'not-required',
    evidence: [
      'apply() on a service-equipped context (附录 A.4)',
      'productionResolved vs classified adapter equality is asserted, not disclaimed'
    ]
  });

  // --- rev6 R2-2: branch-aware identity, honestly blocked or passed -------
  const identityRow = (() => {
    if (applyProbe === undefined) {
      return {
        state: 'not-run',
        observed: 'no apply-context identity evidence: ' + (applyProbeFailure ?? 'unknown reason'),
        note: 'identity probe not run'
      };
    }
    const judged = applyJudgement ?? { blocked: true };
    const rowsText = applyProbe.identity
      .map((entry) => entry.event + '[branch=' + String(entry.branchIds) + ' session=' + String(entry.sessionIds) + ' ns=' + String(entry.namespaces) + ']')
      .join(' ');
    const anyBranch = applyProbe.identity.some((entry) => entry.branchIds > 0);
    // The report vocabulary is strictly passed|failed|not-run (report-template.ts
    // ScenarioState). "blocked" therefore rides in the NOTE, not in the state:
    // inventing a fourth state would break every consumer of the template.
    //
    // t31 (t30 finding): the note used to assert a UNIVERSAL host property
    // ("the host supplies no branchId on any hook dispatch"). What was actually
    // observed is bounded: four host-real scenarios, this host version, branch=0
    // and identity limited to session. Claiming a universal would be an
    // unobserved inference - and the opposite of what the evidence supports.
    return {
      state: anyBranch && !judged.blocked ? 'passed' : 'not-run',
      observed: 'probe-built identity-free dispatches (A.5): ' + rowsText,
      note: anyBranch
        ? 'branch ids observed on probe-built dispatches; host-supplied identity is reported separately in the identity evidence section'
        : 'blocked: across the 4 host-real scenarios observed this round the host supplies branchId=0 with identity limited to session, so Gate 4 is NOT claimed; the session id is not a branch identity (D-P4-1). This is a BOUNDED observation (4 scenarios, this host version) - it does not assert that the host never supplies a branchId in general. External condition, not a harness defect'
    };
  })();
  addRow({
    id: '9.6-4',
    layer: 'security-contract',
    expected:
      'Identity per hook is read from the payload the plugin actually receives; when a branchId is present (or a provable mapping exists) sibling/anonymous/self-claim/dispose/deny precedence must be demonstrated; with no branchId the result is BLOCKED, never passed by omission (rev6 R2-2). This probe emits its OWN identity-free payloads (t29/T17-F2): that demonstrates the fail-closed path, NOT what the host supplies on its own dispatches.',
    observed: identityRow.observed,
    state: identityRow.state,
    note: identityRow.note,
    authorization: 'not-required',
    evidence: [
      'readHookScope over probe-built hook args (附录 A.5)',
      'absent branchId => blocked (Gate 4 not claimed)',
      'host-supplied identity NOT observed this round (see A.5 provenance notice)'
    ]
  });

  const header = {
    schemaVersion: 1,
    commit,
    worktreeDirty,
    pluginVersion,
    host: [
      'DeepSeek Harness ' + hostVersion + ' (product version from the asar package.json)',
      'cordis ' + cordisPkg.version,
      'node ' + process.versions.node,
      'electron ' + electronVersion,
      'runtime ' + process.platform + '/' + process.arch
    ],
    commands: (process.env.HOSTSMOKE_COMMANDS ?? '').split('\n').filter((line) => line.trim().length > 0),
    capturedAt
  };

  const appendix = [
    '',
    '---',
    '',
    '## 附录：HostCapabilityManifest（本报告的证据面）',
    '',
    '```text',
    ...harness.summarizeManifest(manifest),
    ...(probeReport ? probeReport.notes : ['host probe did not run']),
    ...(mcpReport ? mcpReport.notes : ['MCP smoke did not run']),
    ...(degradation.length > 0 ? ['degradation cases=' + String(degradation.length)] : [])
  ];
  // Identity evidence: host-real vs contract-shaped, kept visibly apart.
  appendix.push('identity evidence:');
  if (probeReport) {
    for (const entry of probeReport.identityEvidence) {
      appendix.push(
        '  ' +
          entry.source +
          ' ' +
          entry.dispatch +
          ': branch=' +
          String(entry.branchIds) +
          ' session=' +
          String(entry.sessionIds) +
          ' ns=' +
          String(entry.namespaces) +
          ' fields=' +
          entry.fields.join(',') +
          ' plainSessionIdOnly=' +
          String(entry.plainSessionIdOnly)
      );
    }
    appendix.push(
      '  advisory-path(host-real): payloadFields=' +
        probeReport.advisoryPath.payloadFields.join(',') +
        ' advisorCalls=' +
        String(probeReport.advisoryPath.advisorCalls) +
        ' skippedDelta=' +
        String(probeReport.advisoryPath.scopeUnknownSkipped)
    );
    appendix.push(
      '  advisory-path(contract-shaped): advisorCalls=' +
        String(probeReport.advisoryPathContractShaped.advisorCalls) +
        ' advice=' +
        String(probeReport.advisoryPathContractShaped.adviceInjected)
    );
    appendix.push(
      '  gate-path: asks=' +
        String(probeReport.gatePath.anonymousAskCount) +
        ' skipped=' +
        String(probeReport.gatePath.anonymousScopeUnknownSkipped) +
        ' executed=' +
        String(probeReport.gatePath.anonymousToolExecuted)
    );
  }
  if (mcpReport) {
    appendix.push('mcp diagnostics (' + String(mcpReport.canary.diagnostics.length) + ' lines, whitelist shape):');
    for (const line of mcpReport.canary.diagnostics) {
      appendix.push('  ' + line);
    }
  }
  appendix.push('```');
  appendix.push('');
  appendix.push('manifest 校验：' + (manifestProblems.length === 0 ? '无问题' : manifestProblems.join('；')));
  appendix.push('报告行校验：' + (rowProblems.length === 0 ? '无问题' : rowProblems.join('；')));
  appendix.push('');
  // A.2 — the eight-surface matrix, rendered from the probe result (not from a
  // template), so the table and the machine-readable `surfaceMatrix` agree.
  if (surfaceMatrix !== undefined) {
    appendix.push(...harness.renderSurfaceMatrix(surfaceMatrix).split('\n'));
  } else {
    appendix.push('## 八表面逐面分类（P1-1 / A-t10-3）');
    appendix.push('');
    appendix.push('**not-run**：surface-matrix 探针未执行：' + (surfaceMatrixFailure ?? 'unknown reason'));
    appendix.push('');
  }
  // A.3 — the plugin's read-only status (production code, not report code).
  if (surfaceStatus !== undefined) {
    appendix.push(...harness.renderSurfaceStatusSnapshot(surfaceStatus).split('\n'));
  } else {
    appendix.push('## 插件只读状态聚合（P1-2 / A-t10-2）');
    appendix.push('');
    appendix.push('**not-run**：状态快照未执行：' + (surfaceStatusFailure ?? 'adapter unresolved'));
    appendix.push('');
  }
  // A.4 — the REAL apply context (rev6 R2-1). Rendered from the probe result so
  // the table cannot drift from the machine-readable JSON.
  appendix.push('## 附录 A.4：真实插件 apply 上下文（rev6 R2-1）');
  appendix.push('');
  if (applyProbe === undefined) {
    appendix.push('**not-run**：' + (applyProbeFailure ?? 'unknown reason'));
  } else {
    appendix.push('rc2 的分类来自 smoke 自建适配器 + **裸** Cordis Context，因此生产解析与分类适配器**不一致**，只能靠 `resolveNote` 散文免责。rc3 改为在真正挂载了 `ctx.systemPrompt`/`ctx.tools` 的上下文上调用插件**自己的 `apply()`**，并断言两者**相等**。');
    appendix.push('');
    appendix.push('| 项 | 值 |');
    appendix.push('| :-- | :-- |');
    appendix.push('| 上下文服务 | `tools=' + String(applyProbe.applyContext.services.tools) + ' systemPrompt=' + String(applyProbe.applyContext.services.systemPrompt) + '` |');
    appendix.push('| `apply()` 返回 handle | ' + String(applyProbe.applyContext.applyReturnedHandle) + ' |');
    appendix.push('| 生产 `resolveHostAdapter`（同上下文） | `' + applyProbe.applyContext.productionResolvedSource + '` |');
    appendix.push('| 分类所用适配器 | `' + String(applyProbe.classifiedAdapterSource ?? 'none') + '` |');
    appendix.push('| 两者是否相等 | **' + String(applyProbe.applyContext.productionResolvedSource === applyProbe.classifiedAdapterSource) + '** |');
    appendix.push('| `detectDshHookHost` | ' + String(applyProbe.applyContext.detectDetected) + ' |');
    appendix.push('| 结构 seam 数 | ' + String(applyProbe.applyContext.structuralSeams) + ' |');
    appendix.push('| `apply()` 注册的 hook | `' + (applyProbe.hookRegistration.registered.join('`, `') || '（无）') + '` |');
    appendix.push('| 契约内 hook 是否齐全 | ' + String(applyProbe.hookRegistration.matched) + '（缺失：' + (applyProbe.hookRegistration.missing.join(', ') || '无') + '） |');
    appendix.push('| 逐面交叉核对 | ' + String(applyProbe.crossCheck.checked) + '/8，分歧 ' + String(applyProbe.crossCheck.disagreements.length) + ' |');
    appendix.push('| `lastMountResult` 观测数 | ' + String(applyProbe.crossCheck.lastMountResultObserved) + '/8（apply() 只注册 hook、不挂载 surface，故按 collect-or-omit 如实省略） |');
    appendix.push('| `cacheRead` | unknown ' + String(applyProbe.crossCheck.cacheReadUnknown) + '/8 |');
    appendix.push('');
    appendix.push('交叉核对逐面结果：');
    appendix.push('');
    appendix.push('| surface | 分类 | handle.mountable | handle.enabled | 一致 |');
    appendix.push('| :-- | :-- | :--: | :--: | :--: |');
    const statusBySurface = new Map(applyProbe.surfaces.map((entry) => [entry.surface, entry]));
    for (const face of (applyProbe.matrix === null ? [] : applyProbe.matrix.faces)) {
      const status = statusBySurface.get(face.surface);
      const agree = status === undefined
        ? false
        : !(face.availability === 'native' && status.mountable !== true) &&
          !(face.availability === 'unavailable' && status.mountable === true);
      appendix.push(
        '| `' + face.surface + '` | ' + face.availability + ' | ' +
          (status === undefined ? '—' : String(status.mountable)) + ' | ' +
          (status === undefined ? '—' : String(status.enabled)) + ' | ' +
          (agree ? '是' : '**否**') + ' |'
      );
    }
    if (applyProbe.crossCheck.disagreements.length > 0) {
      appendix.push('');
      appendix.push('分歧清单：');
      for (const disagreement of applyProbe.crossCheck.disagreements) {
        appendix.push('- ' + disagreement);
      }
    }
    appendix.push('');
    appendix.push('> 注：' + applyProbe.crossCheck.note);
  }
  appendix.push('');

  // A.5 — branch identity observed through the plugin's reader (rev6 R2-2).
  //
  // rev6 t29 (t17 finding T17-F2): the heading used to say "真实 dispatch 的身份",
  // which overstated the evidence. These rows come from dispatches THIS PROBE
  // EMITS itself (`DISPATCH_PLAN` below), with payloads it constructs and which
  // carry NO identity fields. That is exactly what makes the zero counts in the
  // table meaningful as a *negative* result (the plugin's reader finds nothing to
  // read in an identity-free payload) - but it is NOT proof of what the host
  // supplies on its own dispatches. The heading and the intro now say so; the
  // rows are labelled as probe-constructed, not host-observed.
  appendix.push('## 附录 A.5：探针自建 dispatch 的身份读取（rev6 R2-2）');
  appendix.push('');
  if (applyProbe === undefined) {
    appendix.push('**not-run**：' + (applyProbeFailure ?? 'unknown reason'));
  } else {
    appendix.push('**出处声明（必读）**：本表的 dispatch 是**探针自己发出的**（`DISPATCH_PLAN`），');
    appendix.push('payload 由探针构造且**不含任何身份字段**。因此本表证明的是「插件自己的');
    appendix.push('`readHookScope` 在 identity-free payload 上读不到身份，于是 fail-closed 不匹配」。');
    appendix.push('**本表不能证明宿主提供什么身份**；宿主提供什么，**见本报告的 `identity evidence:` 段**');
    appendix.push('（`host-real` 条目，由捕获监听器对宿主真实 dispatch 调用 `readHookScope` 读出）：');
    appendix.push('本轮 4 个 host-real 场景实测 **branchId=0、身份仅限 session**（其中 `host-real-no-agent` 连');
    appendix.push('session 也是 0）。这是**有界观测**——4 个场景、本轮宿主版本——**不构成**「宿主永不提供');
    appendix.push('branchId」的普遍断言；一旦宿主开始在 dispatch 中携带 branch，该段与守卫会先变。');
    appendix.push('`hookScopeMatches` 用 `branch` 类挂载判定是否放行。');
    appendix.push('');
    appendix.push('| hook | 已 dispatch | branchIds | sessionIds | namespaces | 对 branch 类挂载是否匹配 | payload 字段 |');
    appendix.push('| :-- | :--: | --: | --: | --: | :--: | :-- |');
    for (const entry of applyProbe.identity) {
      appendix.push(
        '| `' + entry.event + '` | ' + String(entry.dispatched) + ' | ' + String(entry.branchIds) + ' | ' +
          String(entry.sessionIds) + ' | ' + String(entry.namespaces) + ' | ' +
          (entry.matched ? '匹配' : '不匹配') + ' | `' + (entry.fields.join(', ') || '（空）') + '` |'
      );
    }
    appendix.push('');
    const anyBranch = applyProbe.identity.some((entry) => entry.branchIds > 0);
    if (anyBranch) {
      // t29 (T17-F2): even a NON-zero count here would only prove that the PROBE
      // supplied identity in its own payload and the plugin's reader picked it up.
      // It would still not be evidence about the host's own dispatches.
      appendix.push('**探针 payload 携带了身份字段，且插件读取器读到了它**：见上表。这只证明读取器可用；sibling/anonymous/self-claim/dispose/deny 优先级由 `tests/e2e/host-smoke/branch-identity.test.ts` 逐条断言。**宿主真实 dispatch 的身份仍未被观测**。');
    } else {
      // t29 (T17-F2): the previous wording claimed a fact about the HOST
      // ("宿主在四个 hook 上都不提供 branchId"). The table cannot support that:
      // every row is a probe-built identity-free payload, so a zero count is a
      // property of the PAYLOAD, not evidence about the host. What the table DOES
      // establish is the fail-closed behaviour; what remains UNKNOWN is the host's
      // own identity supply. Both are stated separately below.
      appendix.push('**结论 = blocked（不是 passed，也不是 native）**：**Gate 4 不予主张**。');
      appendix.push('');
      appendix.push('本表**能够**证明的：插件自己的 `readHookScope` 在 identity-free payload 上读不到任何身份，');
      appendix.push('`hookScopeMatches` 对 `branch` 类挂载 fail-closed 地判「不匹配」——这是 P4-C 要求的泄漏通道关闭；');
      appendix.push('`sessionId` 不是 branch 身份（D-P4-1）也由这些行如实体现。');
      appendix.push('');
      appendix.push('本表**不能**证明的：宿主真实 dispatch 是否携带 `branchId`——零计数来自探针自建 payload，');
      appendix.push('不是宿主行为。**宿主实际提供什么，见本报告 `identity evidence:` 段的 `host-real` 条目**：');
      appendix.push('本轮 4 个场景实测 branchId=0、身份仅限 session。这是**有界观测**（4 个场景、本轮宿主版本），');
      appendix.push('所以 R2-2 记 **blocked**，既不记 passed，也不记「宿主永不提供 branchId」——');
      appendix.push('后者超出观测范围。要用真实证据替换 blocked，需要宿主在自己的 dispatch 中携带 branch');
      appendix.push('（届时 `identity evidence` 段会变，`tests/e2e/host-smoke/branch-identity.test.ts` 的 tripwire 也会失败并提示）。');
    }
  }
  appendix.push('');

  appendix.push('## 附录：如何重跑与如何变成 Gate 4 可判定');
  appendix.push('');
  appendix.push('```text');
  appendix.push('# 1) 只做就绪自检（不执行真实宿主调用）');
  appendix.push('node scripts/host-smoke/run.mjs --check');
  appendix.push('# 2) 只跑、不覆盖报告（观察本轮失败/未跑项）');
  appendix.push('node scripts/host-smoke/run.mjs --no-write');
  // rev6 t29 (t17 finding T17-F1): this line used to name
  // `docs/reports/host-smoke-rc2.md`, which is FROZEN rev5 evidence. Following the
  // instruction verbatim would have overwritten it. report-path.mjs guards only
  // rc1 (`FROZEN_RC1_RELATIVE`), so rc2 had no protection at all: copying the
  // command was enough to destroy recorded evidence. The instruction now always
  // names a NEW path, and warns about both frozen files by name.
  appendix.push('# 3) 完整跑并把报告写到新路径');
  appendix.push('node scripts/host-smoke/run.mjs --out docs/reports/host-smoke-rc4.md');
  appendix.push('# 注意：docs/reports/p61-host-smoke-rc.md（rc1）与');
  appendix.push('#       docs/reports/host-smoke-rc2.md（rc2）都是已冻结的证据，');
  appendix.push('#       不得作为 --out 目标（守卫目前只拦 rc1）。');
  appendix.push('# 4) 真实模型调用 / 真实 memory 写入（需显式授权，且需绑定账号与预算）');
  appendix.push('HOSTSMOKE_AUTHORIZED=1 node scripts/host-smoke/run.mjs --out <新报告路径>');
  appendix.push('```');
  appendix.push('');
  appendix.push('本报告仍非 Gate 4 通过，原因见 gate4.blockedBy。要把 `9.4-2`/`9.4-3` 从 not-run 变为可判定，需要：');
  appendix.push('');
  appendix.push('1. 用户显式授权真实模型调用与真实 memory 写入（环境 + 账号 + 预算），且 harness 能把授权绑定到账号；');
  appendix.push('2. 一个真实的、分支感知的宿主（hook dispatch 携带 branchId），否则 D1 §2.5 的 host-session scope 登记路径无法被真实证明；');
  appendix.push('3. RewardContract（P6.1-D）与负收益解释（P6.1-E）关闭，才能给出任务收益口径而不做宣传。');
  appendix.push('');
  appendix.push('本轮**没有**把任何缺少条件的一项填成 passed，也没有用 mock 替代真实调用。');
  appendix.push('');

  const reportMarkdown = harness.renderReport(header, rows);

  // rev6 R2-1: state what makes this report rc3 rather than a re-run of rc2.
  // Kept as a banner AFTER the header so the rendered template stays untouched
  // (report-template.ts is shared with rc2's consumers).
  const rc3Banner = [
    '',
    '> **rev6 / rc3 方法差异（必须与 rc2 区分）**',
    '> ',
    '> rc2 的八表面分类来自 smoke **自建**的适配器 + 一个**裸** Cordis Context；该上下文不含 `ctx.systemPrompt`/`ctx.tools`，',
    '> 因此生产 `resolveHostAdapter` 会落到 in-memory 参考实现，与分类所用适配器**不一致**，rc2 只能用 `resolveNote` 散文免责。',
    '> ',
    '> rc3 在真正挂载了宿主服务的上下文上调用插件**自己的 `apply()`**，并断言「生产解析 == 分类所用适配器」（见附录 A.4）。',
    '> 这是**事实**而非免责声明；也是本报告唯一有权声称「证据来自真实 apply 上下文」的理由。',
    '> ',
    '> 分支身份：附录 A.5 的 dispatch 是**探针自建**的 identity-free payload，只能证明读取器 fail-closed，**不能**证明宿主提供什么身份；宿主实际提供什么见 `identity evidence:` 段的 `host-real` 条目——本轮 4 个场景实测 **branchId=0、身份仅限 session**，属**有界观测**，不构成「宿主永不提供 branchId」的普遍断言。故 R2-2 记为 **blocked**（附录 A.5），Gate 4 不予主张。',
    ''
  ].join('\n');


  const failedRows = rows.filter((row) => row.state === 'failed').length;
  const result = {
    ok:
      probeFailure === undefined &&
      degradationFailure === undefined &&
      mcpFailure === undefined &&
      gateFailure === undefined &&
      surfaceMatrixFailure === undefined &&
      surfaceStatusFailure === undefined &&
      manifestProblems.length === 0 &&
      rowProblems.length === 0 &&
      failedRows === 0,
    durationMs: Date.now() - startedAt,
    manifest,
    manifestProblems,
    rowProblems,
    rows,
    surfaceMatrix: surfaceMatrix ?? null,
    surfaceMatrixFailure: surfaceMatrixFailure ?? null,
    surfaceStatus: surfaceStatus ?? null,
    surfaceStatusProblems,
    surfaceStatusFailure: surfaceStatusFailure ?? null,
    probe: probeReport ?? null,
    probeFailure: probeFailure ?? null,
    gate: gateReport ?? null,
    gateFailure: gateFailure ?? null,
    degradation,
    degradationFailure: degradationFailure ?? null,
    mcp: mcpReport ?? null,
    mcpFailure: mcpFailure ?? null,
    reportMarkdown: rc3Banner + reportMarkdown + appendix.join('\n'),
    notes: [...(probeReport?.notes ?? []), ...(mcpReport?.notes ?? []), ...(gateReport?.notes ?? [])]
  };
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  fs.writeFileSync(path.join(outDir, 'report.md'), result.reportMarkdown, 'utf8');
  console.log(
    '[host-smoke] in-host run finished ok=' +
      String(result.ok) +
      ' in ' +
      String(result.durationMs) +
      'ms rows=' +
      String(rows.length) +
      ' failed=' +
      String(failedRows) +
      ' manifestProblems=' +
      String(manifestProblems.length) +
      ' rowProblems=' +
      String(rowProblems.length) +
      (surfaceMatrix === undefined
        ? ''
        : ' surfaces[native=' +
          String(result.surfaceMatrix.faces.filter((face) => face.availability === 'native').length) +
          ',fallback=' +
          String(result.surfaceMatrix.faces.filter((face) => face.availability === 'fallback').length) +
          ',unavailable=' +
          String(result.surfaceMatrix.faces.filter((face) => face.availability === 'unavailable').length) +
          ',notRun=' +
          String(result.surfaceMatrix.faces.filter((face) => face.availability === 'not-run').length) +
          ',statusMountable=' +
          String(result.surfaceStatus === null ? 'n/a' : result.surfaceStatus.filter((entry) => entry.mountable).length) +
          ']')
  );
  if (hostVersionFile.length > 0) {
    console.log('[host-smoke] host version file=' + hostVersionFile);
  }
}

await main();
