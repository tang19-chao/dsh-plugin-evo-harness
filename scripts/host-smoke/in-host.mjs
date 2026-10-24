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

const require = createRequire(import.meta.url);

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

  const capturedAt = new Date().toISOString();
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

  const rowProblems = harness.validateRows(rows);
  if (gateFailure !== undefined) {
    rowProblems.push('gate-mode probe failed: ' + gateFailure);
  }

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
  appendix.push('## 附录：如何重跑与如何变成 Gate 4 可判定');
  appendix.push('');
  appendix.push('```text');
  appendix.push('# 1) 只做就绪自检（不执行真实宿主调用）');
  appendix.push('node scripts/host-smoke/run.mjs --check');
  appendix.push('# 2) 只跑、不覆盖报告（观察本轮失败/未跑项）');
  appendix.push('node scripts/host-smoke/run.mjs --no-write');
  appendix.push('# 3) 完整跑并落盘 docs/reports/p61-host-smoke-rc.md');
  appendix.push('node scripts/host-smoke/run.mjs');
  appendix.push('# 4) 真实模型调用 / 真实 memory 写入（需显式授权，且需绑定账号与预算）');
  appendix.push('HOSTSMOKE_AUTHORIZED=1 node scripts/host-smoke/run.mjs');
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

  const failedRows = rows.filter((row) => row.state === 'failed').length;
  const result = {
    ok:
      probeFailure === undefined &&
      degradationFailure === undefined &&
      mcpFailure === undefined &&
      gateFailure === undefined &&
      manifestProblems.length === 0 &&
      rowProblems.length === 0 &&
      failedRows === 0,
    durationMs: Date.now() - startedAt,
    manifest,
    manifestProblems,
    rowProblems,
    rows,
    probe: probeReport ?? null,
    probeFailure: probeFailure ?? null,
    gate: gateReport ?? null,
    gateFailure: gateFailure ?? null,
    degradation,
    degradationFailure: degradationFailure ?? null,
    mcp: mcpReport ?? null,
    mcpFailure: mcpFailure ?? null,
    reportMarkdown: reportMarkdown + appendix.join('\n'),
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
      String(rowProblems.length)
  );
  if (hostVersionFile.length > 0) {
    console.log('[host-smoke] host version file=' + hostVersionFile);
  }
}

await main();
