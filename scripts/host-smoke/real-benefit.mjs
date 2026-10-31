#!/usr/bin/env node
/**
 * rev6 R3: run the single-task minimal real-benefit canary — or refuse.
 *
 * WHAT THIS SCRIPT DOES
 * ---------------------
 * It is the ONLY entry point that can turn the binding credential into a real
 * model call, and it is deliberately narrow:
 *
 *   1. It re-collects the binding from the same R3A_* environment (or
 *      credential file) the credential script read, and re-validates the four
 *      §7 conditions through the production controller. An incomplete binding
 *      is reported as `not-run` with the missing items and exits 0 — the legal
 *      terminal state (A-R3-5). `--require-runnable` fails closed instead.
 *   2. A complete binding runs exactly TWO real calls (baseline + recorded
 *      advice) on the ONE task through `evaluateRealBenefitCanary`: hard-budget
 *      admission, per-branch read-only tool face, authorization ledger, abort
 *      on identity-missing / noPolicy / unauthorized-tool / budget-exhausted.
 *   3. It prints the honest layered report: `passed` / `failed` /
 *      `insufficient` / `not-run` / `blocked` plus the raw usage, cost and
 *      cacheRead provenance per arm. Engineering green (this script exiting 0)
 *      is NOT a benefit claim.
 *
 * WHAT THIS SCRIPT NEVER DOES
 * ---------------------------
 *   - No memory write of any kind (the controller has no such path; this
 *     script opens none).
 *   - No guarded-active, no publish, no patch mounting.
 *   - No retry, no budget growth, no second task: two calls is the whole run.
 *   - No mock/estimated substitution: without a binding there is no number.
 *
 * USAGE
 *   node scripts/host-smoke/real-benefit.mjs --json
 *   node scripts/host-smoke/real-benefit.mjs --json --env-file <path>
 *   node scripts/host-smoke/real-benefit.mjs --json --require-runnable
 *   node scripts/host-smoke/real-benefit.mjs --markdown
 *
 * EXIT CODES
 *   0  the run completed and produced an honest report (ANY verdict, including
 *      not-run/blocked/insufficient/failed — a failed BENEFIT is still a
 *      successful MEASUREMENT)
 *   1  --require-runnable with an incomplete binding, or an internal error
 *   2  unknown argument
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(HERE, '..', '..');

/**
 * The TypeScript entry: the real production controller. The compiled artifact
 * convention follows build-eval.mjs / rev6-cache-observation.mjs.
 */
const TS_ENTRY_CONTENTS = [
  "export * from './src/dsh-bridge/real-benefit-controller.ts';",
  "export * from './src/dsh-bridge/real-benefit-host-client.ts';",
  "export { DEFAULT_DSH_COUNTING_SEMANTICS } from './src/ledger/pricing.ts';"
].join('\n');

const CACHE_DIR = path.join(repoRoot, 'node_modules', '.cache', 'dsh-plugin-evo-harness');
const NODE_TARGET = 'node20';

const BUNDLE_SOURCES = [
  'src/dsh-bridge/real-benefit-controller.ts',
  'src/dsh-bridge/real-benefit-host-client.ts',
  'src/dsh-bridge/model.ts',
  'src/dsh-bridge/cache-observation.ts',
  'src/ledger/limits.ts',
  'src/ledger/reservation-manager.ts',
  'src/ledger/pricing.ts',
  'src/cordis-seams/tool-face.ts',
  'src/jitrl/runtime-control.ts',
  'src/jitrl/reward-contract.ts',
  'src/jitrl/step-evaluator.ts'
];

async function loadModules() {
  const { createHash } = await import('node:crypto');
  const esbuildVersion = JSON.parse(
    readFileSync(path.join(repoRoot, 'node_modules', 'esbuild', 'package.json'), 'utf8')
  ).version;
  const hash = createHash('sha256').update(TS_ENTRY_CONTENTS);
  for (const source of BUNDLE_SOURCES) {
    hash.update(readFileSync(path.join(repoRoot, source)));
  }
  hash.update('\n' + esbuildVersion + '\n' + NODE_TARGET + '\n');
  const key = hash.digest('hex').slice(0, 16);
  const artifact = path.join(CACHE_DIR, 'rev6-real-benefit-' + key + '.mjs');
  let exists = true;
  try {
    readFileSync(artifact);
  } catch {
    exists = false;
  }
  if (!exists) {
    await build({
      stdin: { contents: TS_ENTRY_CONTENTS, resolveDir: repoRoot, loader: 'ts' },
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: NODE_TARGET,
      packages: 'external',
      outfile: artifact,
      logLevel: 'warning'
    });
  }
  return import(pathToFileURL(artifact).href);
}

function parseEnvFile(filePath) {
  const resolved = path.resolve(filePath);
  let contents;
  try {
    contents = readFileSync(resolved, 'utf8');
  } catch (error) {
    console.error('[real-benefit] cannot read env file ' + resolved + ': ' + String(error && error.message ? error.message : error));
    process.exitCode = 1;
    return null;
  }
  const env = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function mergedEnvironment() {
  const credPath = process.env['R3A_CREDENTIAL_FILE'];
  if (credPath === undefined || credPath.trim().length === 0) return { ...process.env };
  const fileEnv = parseEnvFile(credPath);
  if (fileEnv === null) return null;
  return { ...fileEnv, ...process.env };
}

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const markdownMode = args.includes('--markdown');
const requireRunnable = args.includes('--require-runnable');
const envFileIndex = args.indexOf('--env-file');
const unknownFlags = args.filter(
  (arg, index) =>
    !['--json', '--markdown', '--require-runnable'].includes(arg) && arg !== '--env-file' && index !== envFileIndex + 1
);
if (unknownFlags.length > 0 || (envFileIndex !== -1 && (envFileIndex + 1 >= args.length || args[envFileIndex + 1].startsWith('--')))) {
  console.error('[real-benefit] usage: node scripts/host-smoke/real-benefit.mjs --json [--env-file <path>] [--require-runnable]');
  process.exitCode = 2;
} else {
  run().catch((error) => {
    console.error('[real-benefit] unexpected failure: ' + String(error && error.stack ? error.stack : error));
    process.exitCode = 1;
  });
}

async function run() {
  const modules = await loadModules();
  const {
    REAL_BENEFIT_ENV_KEYS,
    REAL_BENEFIT_ROUTE_ID,
    collectRealBenefitBindingFromEnv,
    validateRealBenefitBinding,
    evaluateRealBenefitCanary,
    createHostClientFromLlm,
    createHostClientFromAdapter,
    maskAccountId,
    canaryTokenCapDefaults,
    missingRequiredBindingKeys
  } = modules;

  const env = mergedEnvironment();
  if (env === null) return; // credential file failed closed
  const generatedAt = new Date().toISOString();

  // T4: the token caps are REQUIRED binding inputs — a missing cap cannot
  // mean "unbounded" and is never silently filled from a default (the
  // credential script reports the same `missing-required-key:*` rows through
  // the shared production helper). The default ladder
  // (`canaryTokenCapDefaults`, total = ceiling, task = total/2, arm = total/4,
  // call = total/8) is REPORTED for provenance only; the production
  // controller re-validates whatever the operator supplies.
  const keys = REAL_BENEFIT_ENV_KEYS;
  const tokenCapDefaultReport = canaryTokenCapDefaults();
  const tokenBudgetDefaults = {
    [keys.tokenTotal]: String(tokenCapDefaultReport.totalTokens),
    [keys.tokenPerTask]: String(tokenCapDefaultReport.perTaskTokens),
    [keys.tokenPerArm]: String(tokenCapDefaultReport.perArmTokens),
    [keys.tokenPerCall]: String(tokenCapDefaultReport.perCallTokens)
  };

  const collected = collectRealBenefitBindingFromEnv(env);
  const binding = collected.binding;
  const evaluation = binding === undefined ? null : validateRealBenefitBinding(binding);
  const runnable = evaluation !== null && evaluation.satisfied;

  if (!runnable) {
    // ---- the honest not-run report --------------------------------------
    // The absent REQUIRED keys are named exactly as the credential script
    // names them (shared production helper, t2 unification): the runner never
    // defaults a required key into the environment.
    const missingRequired = missingRequiredBindingKeys(collected);
    const missing =
      collected.constructionProblems.length > 0 || missingRequired.length > 0 || collected.provided.length === 0
        ? [
            'binding-unconstructable:required R3A_* inputs absent or unparseable',
            ...collected.constructionProblems,
            ...missingRequired
          ]
        : evaluation === null
          ? []
          : [...evaluation.missing];
    const report = {
      generatedAt,
      script: 'scripts/host-smoke/real-benefit.mjs',
      verdict: 'not-run',
      runnable: false,
      missingItems: missing,
      abortTrigger: 'binding-incomplete:' + missing.join(','),
      realCallsMade: 0,
      tokenBudgetDefaults,
      envelope: {
        hostsmokeAuthorized: env['HOSTSMOKE_AUTHORIZED'] === '1',
        countsAsBinding: false
      },
      provided: [...collected.provided],
      absentKeys: Object.values(REAL_BENEFIT_ENV_KEYS).filter((key) => !collected.provided.includes(key)),
      boundaries: [
        'no real model call was made: the four §7 binding conditions are not met',
        'no mock/estimated/synthetic number is substituted (N-10)',
        'not-run/blocked is the legal terminal state (A-R3-5); deliverables are the binding mechanism + preregistration',
        'engineering green (exit 0) is not a benefit claim'
      ]
    };
    emit(report);
    if (requireRunnable) {
      console.error('[real-benefit] --require-runnable FAILED: binding incomplete (' + missing.join(', ') + ')');
      process.exitCode = 1;
    }
    return;
  }

  // ---- runnable: run the canary through the production controller ---------
  const branchId = 'r3a-canary-branch-' + String(Date.now());
  const sessionId = 'r3a-canary-session-' + String(Date.now());
  const host = {
    provider: binding.account.provider,
    model: binding.account.model,
    accountIdMasked: maskAccountId ? maskAccountId(binding.account.accountId) : binding.account.accountId.slice(0, 4) + '…',
    routeId: REAL_BENEFIT_ROUTE_ID
  };

  // ---- T4: bind the REAL host client (fail-closed; no fabrication) --------
  // The client resolves ONLY from (a) a real adapter the operator's process
  // supplies via R3A_ADAPTER_MJS (a module exporting `invoke(request)` — the
  // host-injected seam reserved for the operator), or (b) nothing. This
  // runner never constructs a model client of its own: without a real seam
  // the controller refuses with `host-client-unbound`, which is the honest
  // fail-closed outcome (not-run/blocked is a legal terminal state).
  let hostClient;
  const adapterSpec = env['R3A_ADAPTER_MJS'];
  if (adapterSpec !== undefined && adapterSpec.trim().length > 0) {
    const { pathToFileURL } = await import('node:url');
    const loaded = await import(pathToFileURL(path.resolve(adapterSpec.trim())).href);
    const invoke = loaded.invoke ?? loaded.default?.invoke;
    if (typeof invoke !== 'function') {
      console.error('[real-benefit] R3A_ADAPTER_MJS must export invoke(request); refusing to guess');
      process.exitCode = 1;
      return;
    }
    hostClient = createHostClientFromAdapter(invoke, {
      provider: binding.account.provider,
      model: binding.account.model,
      routeId: REAL_BENEFIT_ROUTE_ID,
      accountIdMasked: maskAccountId(binding.account.accountId)
    });
  } else if (env['R3A_MODEL_SEAM'] === 'dsh-llm') {
    // The operator has bound a real DSH llm service externally. This runner
    // does not construct one itself: fabricating a client here would be the
    // mock the contract forbids — the controller will refuse (fail-closed).
    hostClient = undefined;
  }

  if (hostClient === undefined) {
    // Fail-closed report: the binding is complete but no real client is
    // bound, so the run is refused (never simulated).
    const report = {
      generatedAt,
      script: 'scripts/host-smoke/real-benefit.mjs',
      host,
      branchId,
      verdict: 'blocked',
      runnable: true,
      binding: evaluation,
      missingItems: [],
      abortTrigger: 'host-client-unbound',
      realCallsMade: 0,
      envelope: {
        hostsmokeAuthorized: env['HOSTSMOKE_AUTHORIZED'] === '1',
        countsAsBinding: false
      },
      boundaries: [
        'no real model call was made: no real host client is bound in this environment (R3A_ADAPTER_MJS unset)',
        'the controller refuses to fabricate a response (N-10); not-run/blocked is the legal terminal state (A-R3-5)',
        'engineering green (exit 0) is not a benefit claim'
      ]
    };
    emit(report);
    if (requireRunnable) {
      console.error('[real-benefit] --require-runnable FAILED: no real host client is bound');
      process.exitCode = 1;
    }
    return;
  }

  const result = await evaluateRealBenefitCanary({
    binding,
    identity: { branchId, sessionId },
    hostClient
  });

  const report = {
    generatedAt,
    script: 'scripts/host-smoke/real-benefit.mjs',
    host,
    branchId,
    verdict: result.verdict,
    runnable: true,
    binding: result.binding,
    missingItems: result.missingItems,
    abortTrigger: result.abortTrigger ?? null,
    realCallsMade: result.calls.filter((call) => call.outcome !== 'not-called').length,
    calls: result.calls.map((call) => ({
      arm: call.arm,
      callId: call.callId,
      admitted: call.admitted,
      admissionBasis: call.admissionBasis ?? null,
      reserveMicros: call.reserveMicros,
      rejectedBecause: call.rejectedBecause ?? null,
      outcome: call.outcome,
      settlementPhase: call.settlementPhase,
      usageRaw: call.usageRaw,
      measuredTokens: call.measuredTokens ?? null,
      abortedByTokenCap: call.abortedByTokenCap,
      // t14: WHERE the per-call cap was enforced for THIS call (the client's
      // mid-stream kill switch vs the controller's post-hoc guard) and whether
      // the client reported it could not enforce mid-stream at all. The pair
      // is observability only: capIgnored=true says the ADAPTER surface could
      // not act mid-stream — it never implies the client enforced anything.
      tokenCapAbortOrigin: call.tokenCapAbortOrigin ?? null,
      capIgnoredByClient: call.capIgnoredByClient,
      cacheRead: {
        precision: call.cacheReadSample.cacheReadPrecision,
        unavailable: call.cacheReadSample.cacheReadUnavailable,
        tokens: call.cacheReadSample.cacheReadTokens
      },
      incurredCostMicros: call.incurredCostMicros ?? null,
      amountRefundedMicros: call.amountRefundedMicros ?? null,
      reward: call.reward ?? null,
      verificationStatus: call.verificationStatus,
      verificationTrusted: call.verificationTrusted,
      tools: call.tools
    })),
    reward: result.reward,
    budget: {
      generalRemainingMicros: result.budget.generalRemainingMicros ?? null,
      settledMicros: result.budget.settledMicros ?? null,
      heldMicros: result.budget.heldMicros ?? null,
      rateCardDigest: result.budget.rateCardDigest
    },
    tokenBudget: {
      caps: result.tokenBudget.caps,
      measuredTotalTokens: result.tokenBudget.measuredTotalTokens,
      measuredBaselineTokens: result.tokenBudget.measuredBaselineTokens,
      measuredTreatmentTokens: result.tokenBudget.measuredTreatmentTokens,
      allUsageMeasured: result.tokenBudget.allUsageMeasured,
      perCallCapEnforcedByClient: result.tokenBudget.perCallCapEnforcedByClient,
      // t14: the controller-side enforcement counters, verbatim —
      // postHocPerCallChecks: settled calls the controller re-judged against
      // the per-call cap; absoluteTotalPrechecks: absolute-ceiling pre-checks
      // that ran before arm reservations.
      postHocPerCallChecks: result.tokenBudget.postHocPerCallChecks,
      absoluteTotalPrechecks: result.tokenBudget.absoluteTotalPrechecks
    },
    metering: result.metering ?? null,
    toolFace: result.toolFace,
    authorization: result.authorization ?? null,
    boundaries: result.boundaries
  };
  emit(report);
  if (requireRunnable && (report.verdict === 'not-run' || report.verdict === 'blocked')) {
    console.error('[real-benefit] --require-runnable FAILED: the canary did not run (' + String(report.abortTrigger ?? report.verdict) + ')');
    process.exitCode = 1;
  }
}

function emit(report) {
  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderMarkdown(report));
  }
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# R3 最小预算真实收益 canary 结果');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('| :-- | :-- |');
  lines.push('| 生成时刻 | ' + report.generatedAt + ' |');
  lines.push('| 结论 | **' + report.verdict + '** |');
  lines.push('| 实跑调用数 | ' + String(report.realCallsMade) + ' |');
  if (report.abortTrigger !== undefined && report.abortTrigger !== null) {
    lines.push('| 中止/未跑原因 | ' + String(report.abortTrigger).replace(/\|/g, '\\|') + ' |');
  }
  lines.push('');
  if (report.runnable) {
    lines.push('## 各臂记录');
    lines.push('');
    lines.push('| arm | callId | outcome | usage(in/out/cacheRead) | incurred μ$ | reward | verification | tools(req/allowed/denied/exec) |');
    lines.push('| :-- | :-- | :-- | :-- | --: | --: | :-- | :-- |');
    for (const call of report.calls) {
      const usage =
        '(' +
        String(call.usageRaw.inputTokens ?? '—') +
        '/' +
        String(call.usageRaw.outputTokens ?? '—') +
        '/' +
        String(call.usageRaw.cacheReadTokens ?? '—') +
        ')';
      lines.push(
        '| ' + call.arm + ' | ' + call.callId + ' | ' + call.outcome + ' | ' + usage + ' | ' +
          String(call.incurredCostMicros ?? '—') + ' | ' + String(call.reward ?? '—') + ' | ' +
          call.verificationStatus + (call.verificationTrusted ? ' (trusted)' : '') + ' | ' +
          String(call.tools.requested.length) + '/' + String(call.tools.allowed.length) + '/' +
          String(call.tools.denied.length) + '/' + String(call.tools.executed.length) + ' |'
      );
    }
    lines.push('');
    lines.push('- RewardContract：' + report.reward.contractVersion + '（' + report.reward.aggregation + '），verificationBasis=' + report.reward.verificationBasis);
    lines.push('- 预算：generalRemaining=' + String(report.budget.generalRemainingMicros) + 'μ$，settled=' + String(report.budget.settledMicros) + 'μ$，rateCardDigest=' + report.budget.rateCardDigest);
  }
  if (Array.isArray(report.missingItems) && report.missingItems.length > 0) {
    lines.push('## 缺失项');
    lines.push('');
    for (const missing of report.missingItems) {
      lines.push('- ' + String(missing).replace(/\|/g, '\\|'));
    }
    lines.push('');
  }
  lines.push('## 边界');
  lines.push('');
  for (const boundary of report.boundaries) {
    lines.push('- ' + boundary);
  }
  return lines.join('\n');
}
