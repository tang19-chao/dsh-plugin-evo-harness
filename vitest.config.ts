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
    exclude: [...configDefaults.exclude, 'work/**']
  }
});
