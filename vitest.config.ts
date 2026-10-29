/**
 * Vitest configuration (DSH plugin).
 *
 * Why this file exists: without a config, `vitest run` uses its default include
 * glob (a test/spec wildcard over the whole repository) with only vitest's own
 * default excludes: node_modules, dist, cypress, dot-directories and tooling
 * configs. Neither .gitignore nor tsconfig.json restricts that glob, so any
 * scratch file dropped under `work/` - the team's scratch/report directory -
 * was collected as a test and could turn a healthy tree red. Observed: a failing
 * probe under work/ reported 55 files / 965 tests instead of the real
 * 54 files / 964 tests.
 *
 * `work/**` is therefore excluded. Everything else is left exactly as vitest
 * ships it; in particular this config deliberately sets NO environment, globals
 * or coverage thresholds, so the existing suites run under identical options.
 */
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Spread the real shipped defaults rather than hand-copying them, so a
    // future vitest upgrade cannot silently introduce an unexcluded path.
    exclude: [...configDefaults.exclude, 'work/**'],

    // A per-TEST budget, not a per-file one. The shipped 5 000 ms default is a
    // budget for a fast assertion, but several evidence tests here shell out to
    // real `git` (init/add/commit/clone, plus a full attestation pass) and
    // legitimately need 3.2-5.8 s EACH. Measured after this change: the slowest
    // single test is 5 821 ms (attestation-target R-06), so 30 s is ~5x headroom
    // over the observed worst case. Load is the variable, not the test: that same
    // 5 821 ms test PASSES in isolation under `--testTimeout=5000` and only
    // crosses the line when the other p62 files run beside it, so no static
    // per-test "it takes X seconds, therefore it is safe" judgement holds.
    //
    // Why one global budget instead of per-test annotations: the CI `verify` job
    // allows `timeout-minutes: 30` (ci.yml:27), i.e. 30 s sits ~60x below the job
    // budget, so a genuine hang is still caught — but ordinary contention on a
    // shared runner can no longer turn a green tree red. Annotating the 16
    // git-heavy tests one by one would leave the next such test unprotected and
    // scatter magic numbers across the suite.
    testTimeout: 30_000,

    // Hooks are governed by a SEPARATE budget (vitest resolves testTimeout and
    // hookTimeout independently), and leaving it at the 10 s default would put
    // them out of sync with the reason above. The exposure is real:
    // tests/unit/p62/evidence-gates.test.ts:151 runs `git worktree list` and then
    // removes 24 temporary repositories serially in `afterAll`. No hook timeout
    // has been observed yet, so this is prophylaxis, not a fix — declared here so
    // "the test budget was raised but the hook budget was not" cannot become the
    // next silent gap.
    hookTimeout: 30_000
  }
});
