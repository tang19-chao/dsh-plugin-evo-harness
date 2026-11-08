/**
 * rev8 plan §6.1 item 3 (P2): the live-cycle manifest - a port of upstream
 * dream-rsi `write_live_cycle_manifest` (`orchestrate.py:234-290`).
 *
 * WHAT THE UPSTREAM MODULE DOES
 * -----------------------------
 * After one completed live explore cycle, orchestrate.py writes a single
 * `live_cycle_manifest.json` into the cycle workspace recording the resolved
 * grid plan and the environment's REALIZED execution shape (probe budget,
 * decision rounds, effective sequential rounds, per-batch sizes). Later grid
 * planning reads the archived manifests back (`policy/grid_planning.py:166-186`,
 * `completed_history`) so the NEXT cycle's plan is grounded in what previous
 * rounds ACTUALLY ran, not in what they promised.
 *
 * WHAT THIS PORT IS (and is NOT)
 * ------------------------------
 * A standalone pure-data + atomic-write module. It owns no lifecycle state:
 * the caller supplies every recorded value, and any fact the caller cannot
 * supply is persisted as an explicit `null` ("recorded as unknown") - never a
 * plausible zero. Writes go to the ONE data directory the caller passes in
 * (the independent profile/dataDir seam); the module resolves nothing from
 * the environment and touches nothing outside that directory.
 *
 * WIRED AS OF THE rev8 LIVE-CYCLE TASK (was "not yet wired"; kept honest here):
 * the orchestrator (`src/orchestrator.ts`) consumes this module through the
 * `deps.liveCycleDataDir` seam (injected from `persistence.dataDir` by the
 * plugin entrypoint; an independent `EVO_HARNESS_DATA_DIR`-rooted directory
 * for the MCP assembly):
 *   1. BEFORE plan_grid the orchestrator reads the previous manifest via
 *      {@link readLiveCycleManifest} and hands the PREVIOUS cycle's realized
 *      `batchSizes`/`effectiveSequentialRounds` to the planner as
 *      `PlanGridRequest.previousLiveCycle` (contracts.ts; additive optional).
 *      Missing/damaged files degrade to diagnostics - never a run blocker.
 *      The previous PLANNED grid is never substituted for a realized one.
 *   2. Each round's realized candidate count is collected where the commit
 *      loop charges `candidateProbes`; the reference probe counts toward
 *      `probes` only (never a batch entry).
 *   3. `effectiveSequentialRounds` is derived with
 *      {@link effectiveSequentialRoundsOf} over the run's own clamped
 *      `config.probe.maxConcurrentProbes`.
 *   4. The completed AND the failed cycle each write their record (status
 *      'completed' / 'failed'); skip/dry-run cycles do not write, so the last
 *      REAL cycle's record is never clobbered by a no-op. Writes serialize
 *      per orchestrator instance and a cycle that completed strictly before
 *      the recorded one is refused. Write failures are diagnostics only.
 *   5. The online active policy consumes those realized values as UPPER bounds
 *      on width/depth/candidate budget. A previous planned `gridPlan` never
 *      participates; missing/damaged history leaves the original sizing alone.
 *      The additive request field still lets other policies ignore it.
 *
 * DELIBERATE DIVERGENCES FROM UPSTREAM (all documented, none silent):
 *   - timestamps are epoch milliseconds (the repo persistence convention -
 *     policy.store's `at`/`savedAt`), not upstream ISO-8601 strings;
 *   - one current file per data directory, named `live-cycle-manifest.json`
 *     (repo file-naming convention); upstream archives per cycle into
 *     `history/iterNNN/`, which no local archiver implements yet - a later
 *     archive step can move/copy this file additively;
 *   - no upstream `policy{name, source, sha256, beta_default, config}` block:
 *     the local policy is an in-memory object, not a source file; its
 *     identity rides on the recorded grid plan's `policyId`;
 *   - no upstream `direction_*` fields: there is no local directions
 *     counterpart;
 *   - no `cycle` index: the local lifecycle has no cycle counter; `runId`
 *     identifies the cycle and `startedAt` orders it.
 *
 * DURABILITY: the write goes through the persistence layer's
 * `writeFileAtomic` (sibling temp file, fsync, rename, Windows sharing-
 * violation retry) - never a bare overwrite, which a crash could tear. The
 * input is fully validated BEFORE any byte is written, so a caller bug cannot
 * clobber the previous cycle's manifest. Reads recover tolerantly through
 * `readJsonRecovering`: a damaged file is quarantined as '<name>.corrupt'
 * with a diagnostic instead of throwing.
 *
 * Ownership: src/dream-rsi/live-cycle-manifest.ts (rev8 live-cycle task).
 * Layering note: this file lives in the Dream-RSI layer by assignment and
 * touches the local data directory ONLY through src/persistence/data-dir
 * (no host, no network, no sandbox). It is exported from the dream-rsi barrel
 * now that the orchestrator wiring has landed; the module itself stays pure
 * data + on-demand fs, so the barrel's "no side effects" statement stays true
 * for everything it exports.
 */

import path from 'node:path';

import { TASK_COMPLEXITIES, type SearchGridPlan, type StopCondition } from '../types/contracts';
import {
  PersistenceError,
  readJsonRecovering,
  writeFileAtomic,
  type JsonRecovery
} from '../persistence/data-dir';

/** Completion status of the recorded cycle; `unknown` when the caller cannot say. */
export type LiveCycleStatus = 'completed' | 'failed' | 'unknown';

export const LIVE_CYCLE_STATUSES: readonly LiveCycleStatus[] = [
  'completed',
  'failed',
  'unknown'
];

/** Schema version of the on-disk manifest document. */
export const LIVE_CYCLE_MANIFEST_SCHEMA_VERSION = 1 as const;

/** File name inside the (independent) data directory. */
export const LIVE_CYCLE_MANIFEST_FILE = 'live-cycle-manifest.json';

/** The `stopCondition` values the frozen SearchGridPlan contract defines. */
const STOP_CONDITIONS: readonly StopCondition[] = [
  'first_success',
  'budget_exhausted',
  'diminishing_returns',
  'max_depth'
];

/**
 * The manifest exactly as persisted. Core fields are ALWAYS present so a
 * reader can tell "schema field, recorded as unknown" (null) apart from "not
 * in this schema version" (absent); `taskId`/`sessionId` are the only
 * optional keys (identity enrichment, absent until a caller supplies them).
 */
export interface LiveCycleManifest {
  readonly schemaVersion: typeof LIVE_CYCLE_MANIFEST_SCHEMA_VERSION;
  /** Identity of the lifecycle run this manifest records. */
  readonly runId: string;
  readonly status: LiveCycleStatus;
  /** Epoch-ms write time (upstream `recorded_at` is an ISO-8601 string). */
  readonly recordedAt: number;
  /** Epoch-ms lifecycle boundaries, when the caller has them. */
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  /** The lifecycle's own stop reason (e.g. `first_success`), when known. */
  readonly stopReason: string | null;
  /** The lifecycle's outcome label (the EvoHarnessRunOutcome), when known. */
  readonly outcome: string | null;
  readonly taskId?: string;
  readonly sessionId?: string;
  /** The plan_grid decision this cycle ran under; null when unknown. */
  readonly gridPlan: SearchGridPlan | null;
  /** Total probes executed (reference probe included); null when unknown. */
  readonly probes: number | null;
  /** Selection rounds executed; null when unknown. */
  readonly rounds: number | null;
  /**
   * Candidate probes executed per round (index = round - 1). Deliberately NOT
   * cross-checked against `probes`: the reference probe is counted in
   * `probes` but belongs to no batch. `[]` is a KNOWN-EMPTY sequence (e.g. a
   * skipProbing cycle); `null` is unknown.
   */
  readonly batchSizes: readonly number[] | null;
  /**
   * Sequential-round cost of the recorded batches (upstream
   * `effective_sequential_rounds`); null when unknown. Derivable from
   * `batchSizes` + worker count via {@link effectiveSequentialRoundsOf} once
   * the orchestrator tracks per-round batch sizes.
   */
  readonly effectiveSequentialRounds: number | null;
}

/** Writer input. Omitted (or null) optional facts are persisted as null. */
export interface LiveCycleManifestInput {
  readonly runId: string;
  readonly status: LiveCycleStatus;
  /** Epoch-ms write time; defaults to Date.now() at write time. */
  readonly recordedAt?: number;
  readonly startedAt?: number | null;
  readonly endedAt?: number | null;
  readonly stopReason?: string | null;
  readonly outcome?: string | null;
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly gridPlan?: SearchGridPlan | null;
  readonly probes?: number | null;
  readonly rounds?: number | null;
  readonly batchSizes?: readonly number[] | null;
  readonly effectiveSequentialRounds?: number | null;
}

/** Absolute path of the manifest file inside the given data directory. */
export function liveCycleManifestPath(dataDir: string): string {
  return path.join(dataDir, LIVE_CYCLE_MANIFEST_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Structural validation of a persisted SearchGridPlan. Known fields are
 * checked field by field; the object itself is returned VERBATIM (not
 * rebuilt), so additive contract fields survive a write/read round trip
 * instead of being silently dropped by an older reader.
 */
function validateGridPlan(value: unknown): SearchGridPlan | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (!isNonNegativeInteger(value['maxWidth']) || !isNonNegativeInteger(value['maxDepth']) || !isNonNegativeInteger(value['budget'])) {
    return undefined;
  }
  if (typeof value['skipProbing'] !== 'boolean') {
    return undefined;
  }
  if (!STOP_CONDITIONS.includes(value['stopCondition'] as StopCondition)) {
    return undefined;
  }
  if (!TASK_COMPLEXITIES.includes(value['complexity'] as (typeof TASK_COMPLEXITIES)[number])) {
    return undefined;
  }
  if (typeof value['rationale'] !== 'string' || !isNonEmptyString(value['policyId'])) {
    return undefined;
  }
  return value as unknown as SearchGridPlan;
}

/**
 * Structural + semantic validation of a manifest document (the schema checker
 * shared by the writer and the tolerant reader). Returns a canonical manifest
 * (core fields explicit, `taskId`/`sessionId` only when present) or undefined.
 */
export function parseLiveCycleManifest(value: unknown): LiveCycleManifest | undefined {
  if (!isRecord(value) || value['schemaVersion'] !== LIVE_CYCLE_MANIFEST_SCHEMA_VERSION) {
    return undefined;
  }
  if (!isNonEmptyString(value['runId'])) {
    return undefined;
  }
  const status = value['status'];
  if (typeof status !== 'string' || !LIVE_CYCLE_STATUSES.includes(status as LiveCycleStatus)) {
    return undefined;
  }
  if (!isFiniteNumber(value['recordedAt'])) {
    return undefined;
  }
  for (const field of ['startedAt', 'endedAt'] as const) {
    const entry = value[field];
    if (entry !== null && !isFiniteNumber(entry)) {
      return undefined;
    }
  }
  for (const field of ['stopReason', 'outcome'] as const) {
    const entry = value[field];
    if (entry !== null && typeof entry !== 'string') {
      return undefined;
    }
  }
  for (const field of ['taskId', 'sessionId'] as const) {
    const entry = value[field];
    if (entry !== undefined && !isNonEmptyString(entry)) {
      return undefined;
    }
  }
  const gridPlan =
    value['gridPlan'] === null ? null : validateGridPlan(value['gridPlan']);
  if (gridPlan === undefined) {
    return undefined;
  }
  for (const field of ['probes', 'rounds', 'effectiveSequentialRounds'] as const) {
    const entry = value[field];
    if (entry !== null && !isNonNegativeInteger(entry)) {
      return undefined;
    }
  }
  const batchSizes = value['batchSizes'];
  if (batchSizes !== null) {
    if (!Array.isArray(batchSizes) || !batchSizes.every((entry) => isNonNegativeInteger(entry))) {
      return undefined;
    }
  }
  const manifest: LiveCycleManifest = {
    schemaVersion: LIVE_CYCLE_MANIFEST_SCHEMA_VERSION,
    runId: value['runId'],
    status: status as LiveCycleStatus,
    recordedAt: value['recordedAt'],
    startedAt: (value['startedAt'] ?? null) as number | null,
    endedAt: (value['endedAt'] ?? null) as number | null,
    stopReason: (value['stopReason'] ?? null) as string | null,
    outcome: (value['outcome'] ?? null) as string | null,
    ...(value['taskId'] === undefined ? {} : { taskId: value['taskId'] as string }),
    ...(value['sessionId'] === undefined ? {} : { sessionId: value['sessionId'] as string }),
    gridPlan,
    probes: (value['probes'] ?? null) as number | null,
    rounds: (value['rounds'] ?? null) as number | null,
    batchSizes: batchSizes === null ? null : [...(batchSizes as readonly number[])],
    effectiveSequentialRounds: (value['effectiveSequentialRounds'] ?? null) as number | null
  };
  return manifest;
}

/**
 * Atomically write the manifest for one completed lifecycle into the GIVEN
 * data directory (creating it if needed) and return the written path plus the
 * canonicalized record. The input is validated BEFORE any byte is written: an
 * invalid input throws `PersistenceError('invalid_manifest', …)` and leaves
 * the previous cycle's manifest untouched.
 */
export async function writeLiveCycleManifest(
  dataDir: string,
  input: LiveCycleManifestInput
): Promise<{ readonly path: string; readonly manifest: LiveCycleManifest }> {
  const issues: string[] = [];
  const recordedAt = input.recordedAt ?? Date.now();
  if (!isNonEmptyString(input.runId)) {
    issues.push('runId must be a non-empty string');
  }
  if (!LIVE_CYCLE_STATUSES.includes(input.status)) {
    issues.push('status must be one of ' + LIVE_CYCLE_STATUSES.join('|'));
  }
  if (!isFiniteNumber(recordedAt)) {
    issues.push('recordedAt must be a finite number');
  }
  for (const field of ['startedAt', 'endedAt'] as const) {
    const entry = input[field];
    if (entry !== undefined && entry !== null && !isFiniteNumber(entry)) {
      issues.push(field + ' must be a finite number or null');
    }
  }
  for (const field of ['stopReason', 'outcome'] as const) {
    const entry = input[field];
    if (entry !== undefined && entry !== null && typeof entry !== 'string') {
      issues.push(field + ' must be a string or null');
    }
  }
  for (const field of ['taskId', 'sessionId'] as const) {
    const entry = input[field];
    if (entry !== undefined && !isNonEmptyString(entry)) {
      issues.push(field + ' must be a non-empty string when provided');
    }
  }
  const gridPlan = input.gridPlan ?? null;
  if (gridPlan !== null && validateGridPlan(gridPlan) === undefined) {
    issues.push('gridPlan failed structural validation');
  }
  for (const field of ['probes', 'rounds', 'effectiveSequentialRounds'] as const) {
    const entry = input[field];
    if (entry !== undefined && entry !== null && !isNonNegativeInteger(entry)) {
      issues.push(field + ' must be a non-negative integer or null');
    }
  }
  const batchSizes = input.batchSizes ?? null;
  if (batchSizes !== null && (!Array.isArray(batchSizes) || !batchSizes.every((entry) => isNonNegativeInteger(entry)))) {
    issues.push('batchSizes must be an array of non-negative integers or null');
  }
  if (issues.length > 0) {
    throw new PersistenceError('invalid_manifest', 'live-cycle manifest input rejected: ' + issues.join('; '));
  }

  const manifest: LiveCycleManifest = {
    schemaVersion: LIVE_CYCLE_MANIFEST_SCHEMA_VERSION,
    runId: input.runId,
    status: input.status,
    recordedAt,
    startedAt: input.startedAt ?? null,
    endedAt: input.endedAt ?? null,
    stopReason: input.stopReason ?? null,
    outcome: input.outcome ?? null,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    gridPlan,
    probes: input.probes ?? null,
    rounds: input.rounds ?? null,
    batchSizes: batchSizes === null ? null : [...batchSizes],
    effectiveSequentialRounds: input.effectiveSequentialRounds ?? null
  };
  const filePath = liveCycleManifestPath(dataDir);
  // Pretty-printed on purpose: the manifest is an operator-auditable record
  // (upstream writes it with indent=2 too), and writeFileAtomic guarantees the
  // write itself is atomic either way.
  await writeFileAtomic(filePath, JSON.stringify(manifest, null, 2) + '\n');
  return { path: filePath, manifest };
}

/**
 * Tolerant read seam for the NEXT cycle's planner (grid-planning port, plan
 * item #1). Never throws because of a damaged file: the file is quarantined
 * as '<name>.corrupt' and reported in diagnostics; a missing file is
 * `{ existed: false }`, not an error.
 */
export function readLiveCycleManifest(dataDir: string): Promise<JsonRecovery<LiveCycleManifest>> {
  return readJsonRecovering(liveCycleManifestPath(dataDir), parseLiveCycleManifest);
}

/**
 * Upstream `effective_sequential_rounds` semantics (`env/trace_env.py:259-269`):
 * a probe batch of `size` probes executed with `workers` workers costs
 * ceil(size / workers) sequential rounds; zero (or invalid) batch sizes are
 * skipped exactly like upstream's `size <= 0` early return; the worker count
 * floors at 1. Pure arithmetic - the caller decides what is unknown.
 */
export function effectiveSequentialRoundsOf(
  batchSizes: readonly number[],
  workers: number
): number {
  const effectiveWorkers = Number.isFinite(workers) ? Math.max(1, Math.floor(workers)) : 1;
  let total = 0;
  for (const size of batchSizes) {
    const normalized = Number.isFinite(size) ? Math.floor(size) : 0;
    if (normalized <= 0) {
      continue;
    }
    total += Math.ceil(normalized / effectiveWorkers);
  }
  return total;
}
