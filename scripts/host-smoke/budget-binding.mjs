#!/usr/bin/env node
/**
 * rev6 R3 / contract §7: assemble the account + hard-budget binding credential.
 *
 * WHAT THIS SCRIPT IS
 * -------------------
 * It reads the R3A_* environment keys (or a credential file), validates the
 * four binding conditions B-1..B-4 through the PRODUCTION module
 * `src/dsh-bridge/real-benefit-controller.ts`, and prints one machine-readable
 * credential. The credential is the ONLY thing a real canary run may start
 * from: `scripts/host-smoke/real-benefit.mjs` re-reads the same environment
 * and refuses to run unless this validation is satisfied.
 *
 * WHAT THIS SCRIPT IS NOT
 * -----------------------
 * It never calls a model, never touches the network, never writes memory, and
 * never fabricates a binding field. When the four conditions are not met (the
 * state of this repository today: no account primitive, no budget input), the
 * output says `runnable:false` with the EXACT missing items and exits 0 — a
 * blocked binding is a legal terminal state (contract A-R3-5), not a failure.
 * `--require-runnable` exists so CI can PROVE the runnable branch, and it
 * fails closed when the binding is incomplete.
 *
 * USAGE
 *   node scripts/host-smoke/budget-binding.mjs --json
 *   node scripts/host-smoke/budget-binding.mjs --json --env-file <path>
 *   node scripts/host-smoke/budget-binding.mjs --json --require-runnable
 *   node scripts/host-smoke/budget-binding.mjs --markdown
 *
 * EXIT CODES
 *   0  credential produced (with --require-runnable: AND the binding is complete)
 *   1  --require-runnable was passed but the binding is incomplete, the env
 *      file is unreadable, or a value is unparseable (fail closed)
 *   2  unknown argument
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(HERE, '..', '..');

/**
 * The TypeScript entry: ONLY the real production controller (plus the cache
 * observation rules it reports through). Compiled to a content-addressed
 * artifact under node_modules/.cache per the build-eval.mjs convention.
 */
const TS_ENTRY_CONTENTS = [
  "export * from './src/dsh-bridge/real-benefit-controller.ts';",
  "export * from './src/dsh-bridge/real-benefit-host-client.ts';"
].join('\n');

const CACHE_DIR = path.join(repoRoot, 'node_modules', '.cache', 'dsh-plugin-evo-harness');
const NODE_TARGET = 'node20';

async function loadModules() {
  const esbuildVersion = JSON.parse(
    readFileSync(path.join(repoRoot, 'node_modules', 'esbuild', 'package.json'), 'utf8')
  ).version;
  const key = (await import('node:crypto'))
    .createHash('sha256')
    .update(TS_ENTRY_CONTENTS)
    .update(readFileSync(path.join(repoRoot, 'src', 'dsh-bridge', 'real-benefit-controller.ts')))
    .update(readFileSync(path.join(repoRoot, 'src', 'dsh-bridge', 'real-benefit-host-client.ts')))
    .update(readFileSync(path.join(repoRoot, 'src', 'dsh-bridge', 'cache-observation.ts')))
    .update(readFileSync(path.join(repoRoot, 'src', 'dsh-bridge', 'model.ts')))
    .update(readFileSync(path.join(repoRoot, 'src', 'ledger', 'limits.ts')))
    .update(readFileSync(path.join(repoRoot, 'src', 'ledger', 'reservation-manager.ts')))
    .update(readFileSync(path.join(repoRoot, 'src', 'cordis-seams', 'tool-face.ts')))
    .update(readFileSync(path.join(repoRoot, 'src', 'jitrl', 'runtime-control.ts')))
    .update(readFileSync(path.join(repoRoot, 'src', 'jitrl', 'reward-contract.ts')))
    .update(readFileSync(path.join(repoRoot, 'src', 'jitrl', 'step-evaluator.ts')))
    .update('\n' + esbuildVersion + '\n' + NODE_TARGET + '\n')
    .digest('hex')
    .slice(0, 16);
  const artifact = path.join(CACHE_DIR, 'rev6-budget-binding-' + key + '.mjs');
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
      // npm dependencies stay external: the artifact lives inside
      // node_modules/.cache, so bare specifiers resolve from the repo root.
      packages: 'external',
      outfile: artifact,
      logLevel: 'warning'
    });
  }
  return import(pathToFileURL(artifact).href);
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
  console.error('[budget-binding] usage: node scripts/host-smoke/budget-binding.mjs --json [--env-file <path>] [--require-runnable]');
  process.exitCode = 2;
} else {
  run().catch((error) => {
    console.error('[budget-binding] unexpected failure: ' + String(error && error.stack ? error.stack : error));
    process.exitCode = 1;
  });
}

function parseEnvFile(filePath) {
  const resolved = path.resolve(filePath);
  let contents;
  try {
    contents = readFileSync(resolved, 'utf8');
  } catch (error) {
    console.error('[budget-binding] cannot read env file ' + resolved + ': ' + String(error && error.message ? error.message : error));
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

function readAccountFromCredentialFile(env) {
  // A credential file may carry the account identity without exposing it in
  // the process environment: R3A_CREDENTIAL_FILE points at a KEY=VALUE file
  // whose keys use the same R3A_* names. The file forms the BASE and the
  // process environment OVERRIDES it on key collision ({ ...fileEnv, ...env }),
  // so either source works, and the file itself is never echoed.
  const credPath = env['R3A_CREDENTIAL_FILE'];
  if (credPath === undefined || credPath.trim().length === 0) return env;
  const fileEnv = parseEnvFile(credPath);
  if (fileEnv === null) return env;
  return { ...fileEnv, ...env };
}

async function run() {
  const modules = await loadModules();
  const {
    REAL_BENEFIT_ENV_KEYS,
    collectRealBenefitBindingFromEnv,
    validateRealBenefitBinding,
    validateRateCardForCanary,
    describeBindingItem,
    canaryTokenCapDefaults,
    missingRequiredBindingKeys
  } = modules;

  const merged = readAccountFromCredentialFile({ ...process.env });
  if (process.exitCode === 1) return; // env file failed closed

  const collected = collectRealBenefitBindingFromEnv(merged);
  const generatedAt = new Date().toISOString();
  const keys = REAL_BENEFIT_ENV_KEYS;

  // HostSMoke-style envelope: the flag alone is NOT a binding (in-host 9.4-2).
  const authorizedFlag = merged['HOSTSMOKE_AUTHORIZED'] === '1';

  // T4: the token hard budget is a binding row of its own. The user-authorized
  // total ceiling is 800,000,000 tokens; the nested caps must be strictly
  // smaller and are REQUIRED inputs (a missing cap cannot mean "unbounded").
  // The ladder below is the REPORTED default shape from the PRODUCTION
  // controller (`canaryTokenCapDefaults`, t2 unification) — provenance only;
  // the production controller re-validates whatever the operator supplies.
  const tokenCapDefaults = canaryTokenCapDefaults();
  const tokenCapDefaultReport = {
    [keys.tokenTotal]: String(tokenCapDefaults.totalTokens),
    [keys.tokenPerTask]: String(tokenCapDefaults.perTaskTokens),
    [keys.tokenPerArm]: String(tokenCapDefaults.perArmTokens),
    [keys.tokenPerCall]: String(tokenCapDefaults.perCallTokens)
  };

  let binding = collected.binding;
  let evaluation = null;
  if (binding !== undefined) {
    evaluation = validateRealBenefitBinding(binding);
    if (!evaluation.satisfied) {
      // Keep the object (the credential shows the per-item rows) but mark it
      // non-runnable; the canary runner performs the same validation itself.
    }
  }

  const runnable = evaluation !== null && evaluation.satisfied;
  const unconstructable = binding === undefined;
  const missingItems =
    evaluation === null
      ? unconstructable
        ? ['binding-unconstructable:required R3A_* inputs absent or unparseable']
        : []
      : [...evaluation.missing];
  if (collected.constructionProblems.length > 0) {
    missingItems.push(...collected.constructionProblems);
  }
  // Distinguish "a required input was never supplied" from "the supplied set
  // failed a §7 rule": each absent REQUIRED key gets its own named reason so
  // the report says exactly which env key to set. The required set and the
  // row format come from the PRODUCTION controller (`missingRequiredBindingKeys`,
  // t2 unification) so this credential and the canary runner name the same set.
  if (unconstructable) {
    missingItems.push(...missingRequiredBindingKeys(collected));
  }

  const credential = {
    generatedAt,
    script: 'scripts/host-smoke/budget-binding.mjs',
    routeId: 'r3a-single-canary',
    runnable,
    tokenBudgetDefaults: tokenCapDefaultReport,
    bindingStatus: {
      // The binding rows in contract order (B-1..B-4 + the t4 token row);
      // missing items name the exact defect. When a binding OBJECT exists the
      // rows come from the production validation (including the
      // wildcard/admission negative branches); only the unconstructable case
      // falls back to the generic rows.
      items:
        evaluation === null
          ? [
              { id: 'account', satisfied: false, reason: unconstructable ? 'binding-unconstructable' : 'binding-failed-validation' },
              { id: 'hard-budget', satisfied: false, reason: unconstructable ? 'binding-unconstructable' : 'binding-failed-validation' },
              { id: 'tool-allowlist', satisfied: false, reason: unconstructable ? 'binding-unconstructable' : 'binding-failed-validation' },
              { id: 'token-budget', satisfied: false, reason: unconstructable ? 'binding-unconstructable' : 'binding-failed-validation' },
              { id: 'controller-abort', satisfied: true, reason: '' }
            ]
          : evaluation.items,
      missing: missingItems
    },
    // The envelope is reported as an ENVELOPE: setting it does not satisfy any
    // of the four conditions (the trap the contract warns about).
    envelope: {
      hostsmokeAuthorized: authorizedFlag,
      countsAsBinding: false,
      note: 'HOSTSMOKE_AUTHORIZED=1 only signals declared authorization; it cannot bind an account or a budget (in-host.mjs 9.4-2 refuses to fabricate evidence).'
    },
    provided: [...collected.provided],
    absentKeys: Object.values(keys).filter((key) => !collected.provided.includes(key)),
    binding:
      binding === undefined
        ? null
        : {
            account: {
              provider: binding.account.provider,
              model: binding.account.model,
              // The account id is masked to its length class in the JSON so a
              // credential dump does not leak the identifier itself.
              accountIdMasked: binding.account.accountId.slice(0, 4) + '…(' + String(binding.account.accountId.length) + ' chars)',
              ...(binding.account.label !== undefined && binding.account.label !== '' ? { label: binding.account.label } : {})
            },
            authorization: { grantedBy: binding.authorization.grantedBy, reason: binding.authorization.reason },
            budget: {
              generalBudgetMicros: binding.generalBudgetMicros,
              verificationReserveMicros: binding.verificationReserveMicros,
              maxConcurrencySeats: binding.maxConcurrencySeats
            },
            rateCard: {
              modelId: binding.rateCard.modelId,
              inputRatePerMillion: binding.rateCard.inputRatePerMillion,
              cacheReadRatePerMillion: binding.rateCard.cacheReadRatePerMillion ?? null,
              cacheWriteRatePerMillion: binding.rateCard.cacheWriteRatePerMillion ?? null,
              outputRatePerMillion: binding.rateCard.outputRatePerMillion,
              reasoningRatePerMillion: binding.rateCard.reasoningRatePerMillion ?? null,
              reasoningSeparatelyBilled: binding.rateCard.reasoningSeparatelyBilled,
              conservativeFallbackCostMicros: binding.rateCard.conservativeFallbackCostMicros
            },
            route: { ...binding.route },
            readonlyTools: [...binding.readonlyTools],
            tokenBudget: { ...binding.tokenBudget },
            taskId: binding.taskId,
            recordedAdviceLength: binding.recordedAdvice.length
          },
    // The binding rows phrased for humans; keeps the credential self-describing.
    conditionPhrases: {
      account: describeBindingItem('account'),
      'hard-budget': describeBindingItem('hard-budget'),
      'tool-allowlist': describeBindingItem('tool-allowlist'),
      'token-budget': describeBindingItem('token-budget'),
      'controller-abort': describeBindingItem('controller-abort')
    },
    boundaries: [
      'this script performs no network call, no model call, no memory write',
      'a blocked binding is a legal terminal state (A-R3-5); no mock/estimated substitute is produced (N-10)',
      'the credential is derived from env/credential-file input only; no field is invented',
      'the canary runner re-validates the binding before any real call; this file alone authorizes nothing',
      'the account id is reported only in its masked form; the raw identifier never enters a report'
    ]
  };

  // Rate-card problems surface even when the binding failed to construct.
  if (binding === undefined && merged[keys.rateModelId] !== undefined) {
    credential.rateCardDiagnostics = 'rate card inputs were provided but incomplete/unparseable; see provided/absentKeys';
  }

  if (jsonMode) {
    console.log(JSON.stringify(credential, null, 2));
  } else {
    console.log(renderMarkdown(credential, validateRateCardForCanary));
  }

  if (requireRunnable && !runnable) {
    console.error(
      '[budget-binding] --require-runnable FAILED: the binding is not complete (' + credential.bindingStatus.missing.join(', ') + ')'
    );
    process.exitCode = 1;
    return;
  }
  console.error('[budget-binding] ' + (runnable ? 'binding complete; the canary runner may proceed' : 'binding incomplete → not-run/blocked is the legal terminal state'));
}

function renderMarkdown(credential) {
  const lines = [];
  lines.push('# R3 账号 + 硬预算绑定凭据（§7 B-1..B-4 + t4 token 预算）');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('| :-- | :-- |');
  lines.push('| 生成时刻 | ' + credential.generatedAt + ' |');
  lines.push('| 可实跑 | ' + String(credential.runnable) + ' |');
  lines.push('| 缺失项 | ' + (credential.bindingStatus.missing.length === 0 ? '（无）' : credential.bindingStatus.missing.join(', ')) + ' |');
  lines.push('| HOSTSMOKE_AUTHORIZED | ' + String(credential.envelope.hostsmokeAuthorized) + '（仅信封，不构成绑定） |');
  lines.push('');
  lines.push('## 绑定条件（B-1..B-4 + t4 token 硬预算）');
  lines.push('');
  lines.push('| # | 条件 | 满足 | 原因 |');
  lines.push('| :-- | :-- | :-- | :-- |');
  for (const item of credential.bindingStatus.items) {
    lines.push('| ' + item.id + ' | ' + credential.conditionPhrases[item.id].split(': ')[0] + ' | ' + String(item.satisfied) + ' | ' + (item.reason === '' ? '—' : item.reason) + ' |');
  }
  lines.push('');
  if (credential.binding !== null) {
    lines.push('## 绑定内容（脱敏）');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(credential.binding, null, 2));
    lines.push('```');
  } else {
    lines.push('## 绑定内容');
    lines.push('');
    lines.push('未构造成完整绑定（必填 R3A_* 输入缺失或不可解析）——这正是当前的合法终态。');
  }
  lines.push('');
  lines.push('## 边界');
  lines.push('');
  for (const boundary of credential.boundaries) {
    lines.push('- ' + boundary);
  }
  return lines.join('\n');
}
