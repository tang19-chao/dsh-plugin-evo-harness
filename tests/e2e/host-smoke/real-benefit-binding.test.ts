/**
 * rev6 t2: binding-strictness unification tests.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The binding credential script (`scripts/host-smoke/budget-binding.mjs`) and
 * the canary runner (`scripts/host-smoke/real-benefit.mjs`) used to keep
 * PRIVATE copies of (a) the required R3A_* key set and (b) the default token
 * ladder. They drifted: the credential script treated the four token-cap keys
 * as REQUIRED inputs, while the runner silently filled any missing cap from
 * its own hardcoded default ladder — the same environment produced
 * `runnable:false` in one script and a constructible (potentially runnable)
 * binding in the other. A missing cap cannot mean "unbounded": silently
 * defaulting it is a silent budget choice, which the contract forbids.
 *
 * The fix moves BOTH semantics into the PRODUCTION controller
 * (`real-benefit-controller.ts`) as shared functions, and both scripts now
 * consume them. These tests pin the unified behaviour from both directions:
 *
 *   1. Shared-function tests (in-process, pure): the default ladder shape,
 *      the required-key floor (exhaustive one-key-removal proof), and the
 *      `missing-required-key:*` rows.
 *   2. Direct-entry tests (spawn the scripts): the two entry points must
 *      agree on the SAME environment — identical missing lists, identical
 *      default-ladder report, and above all the runner must NEVER default a
 *      missing token cap (the regression that motivated this file). The
 *      complete-binding spawn proves the fail-closed `host-client-unbound`
 *      path makes zero real calls.
 *
 * No real model call, no network, no memory write: every spawn runs with a
 * scrubbed environment (no R3A_* or HOSTSMOKE keys) plus synthetic values, and
 * every terminal state is not-run/blocked — the legal fail-closed outcomes.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CANARY_TOTAL_TOKEN_CEILING,
  REAL_BENEFIT_ENV_KEYS,
  REAL_BENEFIT_REQUIRED_ENV_KEYS,
  canaryTokenCapDefaults,
  collectRealBenefitBindingFromEnv,
  missingRequiredBindingKeys,
  validateRealBenefitBinding,
  validateTokenBudget
} from '../../../src/dsh-bridge/real-benefit-controller';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const BUDGET_BINDING_SCRIPT = path.join(REPO_ROOT, 'scripts', 'host-smoke', 'budget-binding.mjs');
const REAL_BENEFIT_SCRIPT = path.join(REPO_ROOT, 'scripts', 'host-smoke', 'real-benefit.mjs');

/**
 * A controlled environment for the direct-entry spawns: the inherited process
 * environment minus every R3A_* / HOSTSMOKE key (so the operator's real
 * machine can never leak into the assertion), plus the synthetic overrides.
 */
function scrubbedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith('R3A_') || key === 'HOSTSMOKE_AUTHORIZED') continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

/** Run one host-smoke entry point in --json mode; throws on a non-zero exit. */
function runJson(script: string, extra: Record<string, string> = {}): Record<string, unknown> {
  const run = spawnSync(process.execPath, [script, '--json'], {
    env: scrubbedEnv(extra),
    encoding: 'utf8'
  });
  if (run.error !== undefined) throw run.error;
  if (run.status !== 0) {
    throw new Error(
      script + ' exited ' + String(run.status) + ' (expected 0)\nstdout: ' + String(run.stdout) + '\nstderr: ' + String(run.stderr)
    );
  }
  return JSON.parse(String(run.stdout)) as Record<string, unknown>;
}

/**
 * The exact satisfiable floor: an environment providing ONLY the keys in
 * REAL_BENEFIT_REQUIRED_ENV_KEYS (with valid values) must construct a binding
 * that validates satisfied — B-2 money/route/rate-card consistency uses the
 * same numbers as the controller suite (4000μ ceiling covers the 3000μ
 * fallback floor), and the token ladder is a valid strictly-smaller nesting.
 */
function floorEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const keys = REAL_BENEFIT_ENV_KEYS;
  return {
    [keys.provider]: 'test-provider',
    [keys.model]: 'test-model',
    [keys.accountId]: 'acct-0001',
    [keys.generalBudgetMicros]: '1000000',
    [keys.maxConcurrencySeats]: '1',
    [keys.rateModelId]: 'test-model',
    [keys.rateInput]: '1000000',
    [keys.rateOutput]: '2000000',
    [keys.rateFallback]: '3000',
    [keys.routeMaxInput]: '2000',
    [keys.routeMaxOutput]: '1000',
    [keys.routeMaxReasoning]: '0',
    [keys.routeMaxAttempts]: '1',
    [keys.routeTokenizerVerified]: '1',
    [keys.routeProviderEnforces]: '1',
    [keys.routeAllDimsPriced]: '1',
    [keys.readonlyTools]: '',
    [keys.tokenTotal]: '800000',
    [keys.tokenPerTask]: '500000',
    [keys.tokenPerArm]: '300000',
    [keys.tokenPerCall]: '200000',
    [keys.grantedBy]: 'test-operator',
    [keys.authorizationReason]: 't2 binding floor test',
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Shared production functions — the ONE copy of the semantics
// ---------------------------------------------------------------------------

describe('t2: shared production binding semantics', () => {
  it('canaryTokenCapDefaults derives the authorized ladder from the ceiling (report/provenance only)', () => {
    const defaults = canaryTokenCapDefaults();
    expect(defaults.totalTokens).toBe(CANARY_TOTAL_TOKEN_CEILING);
    expect(defaults.totalTokens).toBe(800_000_000);
    expect(defaults.perTaskTokens).toBe(CANARY_TOTAL_TOKEN_CEILING / 2);
    expect(defaults.perArmTokens).toBe(CANARY_TOTAL_TOKEN_CEILING / 4);
    expect(defaults.perCallTokens).toBe(CANARY_TOTAL_TOKEN_CEILING / 8);
    // The ladder itself must be a LEGAL nesting (strictly smaller per level,
    // inside the authorized ceiling) so reporting it can never suggest an
    // invalid budget.
    expect(validateTokenBudget(defaults)).toEqual([]);
    // An operator ceiling is honoured (the scripts pass the exported constant).
    const custom = canaryTokenCapDefaults(1_000_000);
    expect(custom).toEqual({ totalTokens: 1_000_000, perTaskTokens: 500_000, perArmTokens: 250_000, perCallTokens: 125_000 });
    expect(validateTokenBudget(custom)).toEqual([]);
  });

  it('REAL_BENEFIT_REQUIRED_ENV_KEYS is exactly the satisfiable floor', () => {
    // (a) The floor alone validates satisfied.
    const floor = collectRealBenefitBindingFromEnv(floorEnv());
    expect(floor.binding).toBeDefined();
    expect(validateRealBenefitBinding(floor.binding as Parameters<typeof validateRealBenefitBinding>[0]).satisfied).toBe(true);
    // (b) The floor is minimal: removing ANY ONE required key fails
    //     construction or validation. (Exhaustive over the published set.)
    for (const key of REAL_BENEFIT_REQUIRED_ENV_KEYS) {
      const env = { ...floorEnv() };
      delete env[key];
      const collected = collectRealBenefitBindingFromEnv(env);
      const failed =
        collected.binding === undefined || !validateRealBenefitBinding(collected.binding).satisfied;
      expect(failed, 'omitting ' + key + ' must leave the binding unsatisfiable').toBe(true);
    }
    // (c) The floor names exactly the env keys it needs (no phantom names).
    expect([...REAL_BENEFIT_REQUIRED_ENV_KEYS].sort()).toEqual([...Object.values(REAL_BENEFIT_ENV_KEYS)].filter((key) => REAL_BENEFIT_REQUIRED_ENV_KEYS.includes(key)).sort());
    expect(REAL_BENEFIT_REQUIRED_ENV_KEYS).toContain(REAL_BENEFIT_ENV_KEYS.tokenTotal);
    expect(REAL_BENEFIT_REQUIRED_ENV_KEYS).toContain(REAL_BENEFIT_ENV_KEYS.tokenPerTask);
    expect(REAL_BENEFIT_REQUIRED_ENV_KEYS).toContain(REAL_BENEFIT_ENV_KEYS.tokenPerArm);
    expect(REAL_BENEFIT_REQUIRED_ENV_KEYS).toContain(REAL_BENEFIT_ENV_KEYS.tokenPerCall);
  });

  it('missingRequiredBindingKeys names every absent required key and never defaults one', () => {
    // Empty environment: one row per required key, in contract order.
    const empty = missingRequiredBindingKeys(collectRealBenefitBindingFromEnv({}));
    expect(empty).toEqual(REAL_BENEFIT_REQUIRED_ENV_KEYS.map((key) => 'missing-required-key:' + key));
    // Complete floor: no rows.
    expect(missingRequiredBindingKeys(collectRealBenefitBindingFromEnv(floorEnv()))).toEqual([]);
    // Provided-but-unparseable is a construction problem, NOT a missing key:
    // the key was supplied, so the row must not accuse the operator of omitting it.
    const unparseable = collectRealBenefitBindingFromEnv(floorEnv({ [REAL_BENEFIT_ENV_KEYS.tokenTotal]: 'abc' }));
    expect(missingRequiredBindingKeys(unparseable)).toEqual([]);
    expect(unparseable.constructionProblems).toContain('non-integer-value:' + REAL_BENEFIT_ENV_KEYS.tokenTotal);
    // A constructed binding never produces rows.
    const constructed = collectRealBenefitBindingFromEnv(floorEnv());
    expect(constructed.binding).toBeDefined();
    expect(missingRequiredBindingKeys(constructed)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Direct entry: the two scripts agree, and the runner never silently widens
// ---------------------------------------------------------------------------

describe('t2: direct entry — budget-binding.mjs and real-benefit.mjs agree', () => {
  it('empty environment: identical missing lists, identical default ladder, zero calls', () => {
    const credential = runJson(BUDGET_BINDING_SCRIPT);
    const report = runJson(REAL_BENEFIT_SCRIPT);

    expect(credential['runnable']).toBe(false);
    expect(report['verdict']).toBe('not-run');
    expect(report['runnable']).toBe(false);
    expect(report['realCallsMade']).toBe(0);

    // THE unification: both entry points name the SAME missing rows for the
    // SAME environment (the runner used to emit a different, thinner list).
    expect(report['missingItems']).toEqual(credential['bindingStatus'] && (credential['bindingStatus'] as Record<string, unknown>)['missing']);
    expect(report['absentKeys']).toEqual(credential['absentKeys']);

    // The reported default ladder comes from the ONE production copy.
    const defaults = canaryTokenCapDefaults();
    const expectedLadder = {
      [REAL_BENEFIT_ENV_KEYS.tokenTotal]: String(defaults.totalTokens),
      [REAL_BENEFIT_ENV_KEYS.tokenPerTask]: String(defaults.perTaskTokens),
      [REAL_BENEFIT_ENV_KEYS.tokenPerArm]: String(defaults.perArmTokens),
      [REAL_BENEFIT_ENV_KEYS.tokenPerCall]: String(defaults.perCallTokens)
    };
    expect(credential['tokenBudgetDefaults']).toEqual(expectedLadder);
    expect(report['tokenBudgetDefaults']).toEqual(expectedLadder);

    // The four token-cap keys are among the named missing rows.
    const missing = report['missingItems'] as readonly string[];
    for (const key of [
      REAL_BENEFIT_ENV_KEYS.tokenTotal,
      REAL_BENEFIT_ENV_KEYS.tokenPerTask,
      REAL_BENEFIT_ENV_KEYS.tokenPerArm,
      REAL_BENEFIT_ENV_KEYS.tokenPerCall
    ]) {
      expect(missing).toContain('missing-required-key:' + key);
    }
  });

  it('REGRESSION: a binding missing only the token caps is refused by BOTH scripts — the runner never defaults the ladder', () => {
    // Before t2 the runner silently filled all four caps from its private
    // 800M ladder: the credential said runnable:false while the runner built
    // a runnable binding with a DEFAULTED hard budget (a silent widening —
    // with a real adapter this would have RUN on borrowed caps).
    const env = floorEnv();
    delete env[REAL_BENEFIT_ENV_KEYS.tokenTotal];
    delete env[REAL_BENEFIT_ENV_KEYS.tokenPerTask];
    delete env[REAL_BENEFIT_ENV_KEYS.tokenPerArm];
    delete env[REAL_BENEFIT_ENV_KEYS.tokenPerCall];

    const credential = runJson(BUDGET_BINDING_SCRIPT, env);
    const report = runJson(REAL_BENEFIT_SCRIPT, env);

    expect(credential['runnable']).toBe(false);
    expect(report['runnable']).toBe(false);
    expect(report['verdict']).toBe('not-run');
    expect(report['realCallsMade']).toBe(0);

    const missing = report['missingItems'] as readonly string[];
    for (const key of [
      REAL_BENEFIT_ENV_KEYS.tokenTotal,
      REAL_BENEFIT_ENV_KEYS.tokenPerTask,
      REAL_BENEFIT_ENV_KEYS.tokenPerArm,
      REAL_BENEFIT_ENV_KEYS.tokenPerCall
    ]) {
      expect(missing).toContain('missing-required-key:' + key);
    }
    // Same env → same rows, byte for byte.
    expect(missing).toEqual(
      (credential['bindingStatus'] as Record<string, unknown>)['missing'] as readonly string[]
    );
  });

  it('REGRESSION: a binding missing exactly ONE token cap is refused with the same named row by both scripts', () => {
    const env = { ...floorEnv() };
    delete env[REAL_BENEFIT_ENV_KEYS.tokenPerCall];

    const credential = runJson(BUDGET_BINDING_SCRIPT, env);
    const report = runJson(REAL_BENEFIT_SCRIPT, env);

    expect(credential['runnable']).toBe(false);
    expect(report['verdict']).toBe('not-run');
    expect(report['realCallsMade']).toBe(0);
    const row = 'missing-required-key:' + REAL_BENEFIT_ENV_KEYS.tokenPerCall;
    expect((report['missingItems'] as readonly string[])).toContain(row);
    expect((credential['bindingStatus'] as Record<string, unknown>)['missing']).toContain(row);
    // No invented cap mismatch noise: the true cause is the missing key.
    expect((report['missingItems'] as readonly string[]).join('|')).not.toContain('perCallTokens-not-below-perArm');
  });

  it('complete synthetic binding: credential runnable:true, runner fail-closed blocked with ZERO real calls, operator caps honoured verbatim', () => {
    const stdout = spawnSync(process.execPath, [BUDGET_BINDING_SCRIPT, '--json'], {
      env: scrubbedEnv(floorEnv()),
      encoding: 'utf8'
    });
    if (stdout.status !== 0) throw new Error('budget-binding exited ' + String(stdout.status));
    const credential = JSON.parse(String(stdout.stdout)) as Record<string, unknown>;

    // Operator-supplied non-default caps are carried verbatim (NOT widened to
    // the reported 800M default ladder).
    expect(credential['binding']).toBeDefined();
    expect((credential['binding'] as Record<string, unknown>)['tokenBudget']).toEqual({
      totalTokens: 800_000,
      perTaskTokens: 500_000,
      perArmTokens: 300_000,
      perCallTokens: 200_000
    });
    // ...while the REPORTED default ladder still shows the authorized ceiling.
    expect((credential['tokenBudgetDefaults'] as Record<string, string>)[REAL_BENEFIT_ENV_KEYS.tokenTotal]).toBe(
      String(CANARY_TOTAL_TOKEN_CEILING)
    );
    // Credential hygiene: the raw synthetic account id never enters the report.
    expect(String(stdout.stdout)).not.toContain('acct-0001');

    // The runner on the SAME environment: runnable, but no real client is
    // bound in this environment → fail-closed blocked, zero real calls.
    const report = runJson(REAL_BENEFIT_SCRIPT, floorEnv());
    expect(report['runnable']).toBe(true);
    expect(report['verdict']).toBe('blocked');
    expect(report['abortTrigger']).toBe('host-client-unbound');
    expect(report['realCallsMade']).toBe(0);
  });
});
