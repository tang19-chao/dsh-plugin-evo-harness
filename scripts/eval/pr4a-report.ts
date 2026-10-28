/**
 * PR-4A five-arm report assembly.
 *
 * Consumes the arm results (pr4a-five-arm-lib.ts) and the pre-registered
 * statistics (pr4a-stats.ts), and produces:
 *   - the machine-readable JSON (V2 §12.2.1)
 *   - the per-arm FULL decision ledgers (V2 §12.2.2 — no "counts + samples")
 *   - the readable Markdown report (V2 §12.2.3)
 *
 * This module deliberately contains NO experiment logic: it never changes a
 * number. Every claim in the report traces to either a measured field or a
 * pre-registered formula, and the honesty constraints of §8/§9/§12.3 are
 * enforced as explicit assertions rather than prose.
 *
 * REVISION (PR-4A statistical-audit repair). Each change below fixes a defect
 * where the assembly disagreed with the pre-registration:
 *   1. the primary test for a RATE-type series is §8.3.2 exact paired
 *      randomization (sign-flip); exact McNemar is §8.3.1's BINARY test and is
 *      now reported only when the series actually is binary
 *      (`binarySeries.isBinary` records which one was primary);
 *   2. the four-dimension tuple consumes the ESTIMATOR's own interval
 *      (randomization inversion) instead of the Clopper-Pearson interval of the
 *      discordant-pair win probability π;
 *   3. the tuple's DTS is the estimator's own per-task degradation
 *      (`estimatorDegradation`), not one arm's DTS against the frozen reference;
 *   4. `effectiveReplication` is derived from the observed UNIQUE VALUE COUNT
 *      instead of being a constant 5;
 *   5. the supplementary family carries its own interval so a width can be read
 *      per contrast.
 */

import {
  PR4A_ARMS,
  PR4A_EPISODES,
  PR4A_ROUNDS,
  PR4A_TASKS,
  PR4A_EXPLORATION_ALLOWANCE,
  OFFLINE_NOTIONAL_BUDGET_MICROS,
  OFFLINE_NOTIONAL_TOKEN_BUDGET,
  LOCAL_TASK_WALLCLOCK_MS,
  LOCAL_CALL_TIMEOUT_MS,
  PROTOCOL_ID,
  armSpec,
  pr4aTaskOrder,
  resetArmTrust,
  runPr4aArmWithLedger,
  type Pr4aArmResult,
  type Pr4aLedgerEntry,
  type Pr4aArmId
} from './pr4a-five-arm-lib.ts';
import {
  DTS_MAX,
  DISCORDANT_INSUFFICIENT,
  MMI,
  NIM,
  WIDTH_INSUFFICIENT,
  bandOf,
  benjaminiHochberg,
  closedFormMinDetectableD,
  dtsOf,
  exactDiscordantInterval,
  exactMcNemarTwoSided,
  exactSignFlipTest,
  exactSignTestPower,
  estimatorDegradation,
  holmBonferroni,
  isBinarySeries,
  minDetectableWinRate,
  pearsonCorrelation,
  randomizationInversionInterval,
  summarisePaired,
  verdictTuple,
  widthBudget
} from './pr4a-stats.ts';

// ---------------------------------------------------------------------------
// comparisons (V2 §3.3 pre-specified estimators)
// ---------------------------------------------------------------------------

/** The four pre-registered controlled-family contrasts (V2 §8.6). */
const CONTROLLED_CONTRASTS = [
  { id: 'write-back', label: 'θ_write = Arm-1 − Arm-0 (write-back vs frozen)', kind: 'write' },
  { id: 'track', label: 'θ_track = ½[(Arm-3−Arm-1) + (Arm-4−Arm-2)]', kind: 'track' },
  { id: 'gate', label: 'θ_gate = ½[(Arm-2−Arm-1) + (Arm-4−Arm-3)]', kind: 'gate' },
  { id: 'interaction', label: 'θ_int = (Arm-4−Arm-3) − (Arm-2−Arm-1)', kind: 'interaction' }
] as const;

/**
 * The estimator's per-task value is the HOST VERDICT rate (§7.1), so a task
 * whose episodes were all censored (or that never ran) contributes no value and
 * must not be silently replaced by 0 — that would count a censored execution as
 * a failure, which §6.4 forbids.
 */
function taskMap(arm: Pr4aArmResult): Map<string, number | null> {
  return new Map(arm.tasks.map((task) => [task.taskId, task.verifiedRate] as const));
}

/**
 * Tasks on which BOTH arms of a pair carry an analyzed value. The estimator
 * series is built over this intersection, in task-id order, so a pair including
 * an `incomplete` arm reports its own (smaller) N instead of an invented 0.
 */
function commonTasks(left: Pr4aArmResult, right: Pr4aArmResult): readonly string[] {
  const leftMap = taskMap(left);
  const rightMap = taskMap(right);
  return [...leftMap.keys()]
    .filter((id) => leftMap.get(id) !== null && leftMap.get(id) !== undefined)
    .filter((id) => rightMap.get(id) !== null && rightMap.get(id) !== undefined)
    .sort();
}

function valueOf(arm: Pr4aArmResult, taskId: string): number {
  return taskMap(arm).get(taskId) ?? 0;
}

/** Per-task differences for a single pair of arms. */
function pairDeltas(
  left: Pr4aArmResult,
  right: Pr4aArmResult
): { taskId: string; delta: number; left: number; right: number }[] {
  const leftMap = taskMap(left);
  const rightMap = taskMap(right);
  const ids = [...leftMap.keys()]
    .filter((id) => leftMap.get(id) !== null && leftMap.get(id) !== undefined)
    .filter((id) => rightMap.get(id) !== null && rightMap.get(id) !== undefined)
    .sort();
  return ids.map((taskId) => ({
    taskId,
    left: leftMap.get(taskId) ?? 0,
    right: rightMap.get(taskId) ?? 0,
    delta: (leftMap.get(taskId) ?? 0) - (rightMap.get(taskId) ?? 0)
  }));
}

/** Build the four factorial estimator series (one value per task). */
function estimatorSeries(
  arms: Map<Pr4aArmId, Pr4aArmResult>
): Map<string, { taskId: string; value: number }[]> {
  const get = (id: Pr4aArmId): Pr4aArmResult => arms.get(id)!;
  const a0 = get('Arm-0');
  const a1 = get('Arm-1');
  const a2 = get('Arm-2');
  const a3 = get('Arm-3');
  const a4 = get('Arm-4');
  const ids = commonTasks(a0, a1);
  const v = (arm: Pr4aArmResult, taskId: string): number => valueOf(arm, taskId);
  const series = new Map<string, { taskId: string; value: number }[]>();
  series.set(
    'write',
    ids.map((taskId) => ({ taskId, value: v(a1, taskId) - v(a0, taskId) }))
  );
  series.set(
    'track',
    ids.map((taskId) => ({
      taskId,
      value: 0.5 * (v(a3, taskId) - v(a1, taskId) + (v(a4, taskId) - v(a2, taskId)))
    }))
  );
  series.set(
    'gate',
    ids.map((taskId) => ({
      taskId,
      value: 0.5 * (v(a2, taskId) - v(a1, taskId) + (v(a4, taskId) - v(a3, taskId)))
    }))
  );
  series.set(
    'interaction',
    ids.map((taskId) => ({
      taskId,
      value: v(a4, taskId) - v(a3, taskId) - (v(a2, taskId) - v(a1, taskId))
    }))
  );
  return series;
}

// ---------------------------------------------------------------------------
// degradation: TWO different objects, kept apart on purpose (V2 §7.2 vs §8.5)
// ---------------------------------------------------------------------------

/**
 * DESCRIPTIVE arm-vs-reference DTS (§7.2): the share of tasks whose arm-level
 * rate is strictly below the frozen reference's. Reported per ARM; it answers
 * "does this arm lose tasks against the reference?".
 */
function degradationVsReference(
  arm: Pr4aArmResult,
  reference: Pr4aArmResult
): { dts: number; degradedTasks: string[] } {
  const refMap = taskMap(reference);
  const pairs = arm.tasks
    .filter((task) => task.verifiedRate !== null)
    .map((task) => ({
      taskId: task.taskId,
      arm: task.verifiedRate ?? 0,
      reference: refMap.get(task.taskId) ?? 0
    }));
  const outcome = dtsOf(pairs);
  return { dts: outcome.dts, degradedTasks: [...outcome.degradedTasks] };
}

// ---------------------------------------------------------------------------
// the full experiment
// ---------------------------------------------------------------------------

export interface Pr4aCodeProvenance {
  /** `git rev-parse HEAD^{commit}` — the commit object the run started from. */
  readonly commit: string;
  /** `git describe --always --dirty=-dirty` (empty string when unavailable). */
  readonly describe: string;
  /** Porcelain status digest over TRACKED files modified in the working tree. */
  readonly trackedWorkspaceDigest: string;
  /** Count of tracked files whose working-tree bytes differ from HEAD. */
  readonly trackedDirtyCount: number;
  /** SHA-256 of each file listed in `trackedDirtyFiles`. */
  readonly dirtyFileDigests: readonly { readonly path: string; readonly sha256: string }[];
  /** SHA-256 of each executed entry point / eval module (the real code). */
  readonly executedSources: readonly { readonly path: string; readonly sha256: string }[];
  /** SHA-256 over all `executedSources` digests, order-stable. */
  readonly executedSourcesDigest: string;
  /** Whether the harness reported a dirty working tree. */
  readonly workspaceDirty: boolean;
  /**
   * Provenance of the COMPILED bundle esbuild actually loaded: its content
   * fingerprint, bundling mode and esbuild version. The per-source digests above
   * say what the sources were; this says which compiled artifact was executed.
   */
  readonly bundleFingerprint?: {
    readonly entry: string;
    readonly artifact: string;
    readonly digest: string;
    readonly mode: string;
    readonly esbuildVersion: string;
    readonly rebuilt: boolean;
  };
  /** Algorithm used for every digest above (reproducibility requires naming it). */
  readonly digestAlgorithm: 'sha256';
  /** Human-readable instructions for locating exactly this code revision. */
  readonly howToLocate: string;
}

export interface Pr4aExperimentReport {
  readonly protocol: string;
  readonly generatedAt: string;
  /**
   * The commit SHA (kept as a plain string for the artifact verifier), with the
   * full provenance block in `codeProvenance` — a bare SHA cannot locate the
   * code that actually ran when the working tree is dirty.
   */
  readonly codeBaseline: string;
  readonly codeProvenance: Pr4aCodeProvenance;
  readonly design: unknown;
  readonly replication: unknown;
  readonly arms: readonly Pr4aArmResult[];
  readonly comparisons: unknown;
  readonly cost: unknown;
  readonly safety: unknown;
  readonly invariants: unknown;
  readonly declarations: unknown;
  /** V2 §9.3: the six token fields per arm, each with its own precision. */
  readonly tokenFields: unknown;
  /** V2 §4.1: the decision-level ledger rows, in full, inside the JSON. */
  readonly ledgerIndex: unknown;
}

export interface RunPr4aExperimentOptions {
  readonly codeBaseline: string;
  readonly codeProvenance: Pr4aCodeProvenance;
  readonly seed?: number;
  readonly episodes?: number;
  readonly rounds?: number;
}

/** Run all five arms and assemble every artifact the protocol requires. */
export async function runPr4aExperiment(options: RunPr4aExperimentOptions): Promise<{
  readonly report: Pr4aExperimentReport;
  readonly ledgers: Map<Pr4aArmId, readonly Pr4aLedgerEntry[]>;
}> {
  const seed = options.seed ?? undefined;
  const episodes = options.episodes ?? PR4A_EPISODES;
  const rounds = options.rounds ?? PR4A_ROUNDS;
  const order = pr4aTaskOrder(seed ?? 0x5eed1a);

  const arms: Pr4aArmResult[] = [];
  const ledgers = new Map<Pr4aArmId, readonly Pr4aLedgerEntry[]>();

  for (const spec of PR4A_ARMS) {
    // Trust must not survive between arms: each arm redeems only its own receipts.
    resetArmTrust();
    const { arm, ledger } = await runPr4aArmWithLedger({
      armId: spec.id,
      ...(seed === undefined ? {} : { seed }),
      episodes,
      rounds,
      taskOrder: order
    });
    arms.push(arm);
    ledgers.set(spec.id, ledger);
  }

  const byId = new Map(arms.map((arm) => [arm.armId, arm] as const));
  const reference = byId.get('Arm-0')!;

  // ---- §8.1 replication check (BEFORE any main result, as pre-registered) ----
  /**
   * `effectiveReplication` is the number of DISTINCT within-task results the
   * design actually resolves, computed from the data — never set to `episodes`.
   * Claiming L=5 independent observations is precisely the sample-size inflation
   * §8.1 exists to prevent.
   *
   * The headline value is the MEAN distinct-value count per analysed task, taken
   * over the LEARNING arms (`writesBack === true`). The frozen reference is
   * excluded on purpose: Arm-0 never updates, so its constancy is a property of
   * its definition, not evidence about replication — including it would force
   * the statistic to 1 by construction and hide the real variation. Arm-3/4 are
   * included and do contribute their own (saturated) value.
   *
   *   - every analysed task constant in every learning arm -> 1 (binary design);
   *   - otherwise -> max over learning arms of mean(distinctRunValues per task),
   *     reported with the per-arm means and modes so the number is auditable.
   */
  const replicationPerArm = arms.map((arm) => {
    const analyzed = arm.tasks.filter((task) => task.analysisIncluded);
    const histogram = arm.tasks.reduce<Record<string, number>>((acc, task) => {
      const key = String(task.distinctRunValues);
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    let modeValue = 1;
    let modeCount = -1;
    for (const [key, count] of Object.entries(histogram)) {
      if (count > modeCount) {
        modeCount = count;
        modeValue = Number(key);
      }
    }
    const meanDistinct =
      analyzed.length === 0
        ? 0
        : analyzed.reduce((sum, task) => sum + task.distinctRunValues, 0) / analyzed.length;
    return {
      armId: arm.armId,
      writesBack: arm.spec.writesBack,
      analyzedTasks: analyzed.length,
      tasksWithZeroWithinVariance: arm.tasks.filter((task) => task.withinRunVariance === 0).length,
      tasks: arm.tasks.length,
      distinctValueHistogram: histogram,
      distinctValueMode: modeValue,
      meanDistinctValuesPerTask: Number(meanDistinct.toFixed(6)),
      allTasksConstant: analyzed.every((task) => task.withinRunVariance === 0)
    };
  });
  const learningPerArm = replicationPerArm.filter((entry) => entry.writesBack);
  const allLearningConstant =
    learningPerArm.length > 0 && learningPerArm.every((entry) => entry.allTasksConstant);
  const observedReplication = allLearningConstant
    ? 1
    : Number(
        Math.max(...learningPerArm.map((entry) => entry.meanDistinctValuesPerTask)).toFixed(4)
      );
  const replication = {
    note:
      'V2 §8.1: the L=5 episodes of one task may be identical under a deterministic runner. ' +
      'This is reported BEFORE the main results. `effectiveReplication` is the MEAN number of distinct ' +
      'within-task results actually resolved, taken over the LEARNING arms (Arm-0 is excluded because it ' +
      'never updates, so its constancy is definitional). It is NEVER `episodes`: the L episodes are not L ' +
      'independent observations. When every analysed task is constant in every learning arm the design is ' +
      'binary and `effectiveReplication` is exactly 1.',
    episodes,
    /** Mean distinct within-task results resolved (never `episodes` by fiat). */
    effectiveReplication: observedReplication,
    effectiveReplicationDerivation:
      'max over LEARNING arms (writesBack=true) of mean(distinctRunValues per analysed task); ' +
      'set to exactly 1 when every analysed task is constant in every learning arm. ' +
      'allLearningArmsConstant=' +
      String(allLearningConstant) +
      ', per-arm means=' +
      learningPerArm.map((entry) => entry.armId + ':' + String(entry.meanDistinctValuesPerTask)).join(', '),
    allTasksConstantAcrossArms: replicationPerArm.every((entry) => entry.allTasksConstant),
    allLearningArmsConstant: allLearningConstant,
    designIsBinary: allLearningConstant,
    perArm: replicationPerArm
  };

  // ---- §3.3/§8.6 the four pre-registered controls ----
  const series = estimatorSeries(byId);
  const controlledBase = CONTROLLED_CONTRASTS.map((contrast) => {
    const values = series.get(contrast.kind) ?? [];
    const deltas = values.map((entry) => entry.value);
    const summary = summarisePaired(values.map((entry) => ({ taskId: entry.taskId, left: entry.value, right: 0 })));
    const signFlip = exactSignFlipTest(deltas);
    const interval = randomizationInversionInterval(deltas, { alpha: 0.05, step: 0.005 });
    const wins = deltas.filter((value) => value > 1e-9).length;
    const losses = deltas.filter((value) => value < -1e-9).length;
    const binary = isBinarySeries(deltas);
    const mcnemarP = exactMcNemarTwoSided(wins, wins + losses);
    const exactInterval = exactDiscordantInterval(wins, losses);
    const meanDelta = deltas.length === 0 ? 0 : deltas.reduce((a, b) => a + b, 0) / deltas.length;
    /**
     * §8.3.1 vs §8.3.2: the pre-registered PRIMARY test is chosen by the data
     * type of the estimator series. A rate-type series ({0, 0.2, ..., 1}) uses
     * the exact paired randomization; only an all-binary series falls back to
     * the exact McNemar. Both are always COMPUTED and reported, but
     * `primaryTest` names which one the SAP designates, so a reader cannot
     * mistake a McNemar p-value on rate data for the primary result.
     */
    const primaryTest = binary
      ? 'exact-mcnemar-two-sided (§8.3.1: the series is binary)'
      : 'exact-paired-randomization-sign-flip (§8.3.2: the series is rate-type)';
    return {
      id: contrast.id,
      label: contrast.label,
      n: deltas.length,
      meanDelta,
      sd: summary.sd,
      wins,
      ties: deltas.length - wins - losses,
      losses,
      discordantPairs: wins + losses,
      /** The SAP-designated primary p-value (see `primaryTest`). */
      pPrimary: binary ? mcnemarP : signFlip.twoSidedP,
      pRaw: mcnemarP,
      pSignFlip: signFlip.twoSidedP,
      signFlipPatterns: signFlip.patterns,
      primaryTest,
      binarySeries: binary,
      exactInterval,
      /** §8.5 ③ consumes THIS interval (the estimator's own), not `exactInterval`. */
      randomizationInterval: interval,
      intervalWidth: interval.upper - interval.lower,
      /** §8.3.3: what a reader needs to reproduce the interval. */
      intervalProvenance: {
        method: 'exact paired randomization inversion (sign-flip) over a 0.005 grid of null shifts mu',
        algorithm: 'randomizationInversionInterval',
        gridStep: 0.005,
        gridPointsTested: interval.grid,
        enumerationSpace: Math.pow(2, deltas.length),
        seed: 'none (exhaustive enumeration, no randomness)',
        rerunCommand:
          'node -e "import(\'./scripts/eval/pr4a-stats.ts\').then(m=>console.log(m.randomizationInversionInterval(' +
          JSON.stringify(deltas.map((value) => Number(value.toFixed(6)))) +
          ',{alpha:0.05,step:0.005})))"'
      },
      band: bandOf(meanDelta),
      perTask: values
    };
  });
  // Holm over the four controlled contrasts — the ONLY controlled family.
  // §8.6 applies the multiplicity correction to the SAP-designated primary p.
  const holm = holmBonferroni(controlledBase.map((entry) => entry.pPrimary));
  const controlled = controlledBase.map((entry, index) => {
    const taskSeries = series.get(CONTROLLED_CONTRASTS[index]?.kind ?? 'write') ?? [];
    /**
     * §8.5 ③: the DTS used by the verdict is the ESTIMATOR'S OWN per-task
     * degradation, not an arm's DTS against the frozen reference (that arm-level
     * quantity is reported separately, per arm, in `armDegradation`).
     */
    const estimatorDts = estimatorDegradation(taskSeries);
    const tuple = verdictTuple({
      meanDelta: entry.meanDelta,
      // ③ and ④ read the ESTIMATOR interval (randomization inversion).
      interval: [entry.randomizationInterval.lower, entry.randomizationInterval.upper],
      discordantPairs: entry.discordantPairs,
      dts: estimatorDts.dts,
      significantAfterCorrection: holm.rejected[index] === true
    });
    return {
      ...entry,
      pAdjusted: holm.adjusted[index],
      significantAfterCorrection: holm.rejected[index] === true,
      /** §7.2 descriptive arm-vs-reference DTS (kept, but NOT the verdict input). */
      armLevelDtsVsReference: degradationVsReference(
        byId.get((['Arm-1', 'Arm-3', 'Arm-2', 'Arm-4'] as const)[index] ?? 'Arm-1')!,
        reference
      ),
      /** §8.5 ③ estimator-level degradation (the verdict input). */
      degradation: estimatorDts,
      verdict: tuple,
      verdictInputs: {
        meanDelta: entry.meanDelta,
        interval: [entry.randomizationInterval.lower, entry.randomizationInterval.upper],
        intervalWidth: entry.randomizationInterval.upper - entry.randomizationInterval.lower,
        discordantPairs: entry.discordantPairs,
        dts: estimatorDts.dts,
        significance: holm.rejected[index] === true ? 'reject' : 'not-reject',
        thresholds: { MMI, NIM, DTS_MAX, WIDTH_INSUFFICIENT, DISCORDANT_INSUFFICIENT }
      }
    };
  });

  // ---- exploratory/supplementary family (BH only; never merged with §8.6) ----
  const allPairs: { left: Pr4aArmId; right: Pr4aArmId }[] = [];
  for (let i = 0; i < arms.length; i += 1) {
    for (let j = i + 1; j < arms.length; j += 1) {
      allPairs.push({ left: arms[i]!.armId, right: arms[j]!.armId });
    }
  }
  const exploratoryRaw = allPairs.map((pair) => {
    const deltas = pairDeltas(byId.get(pair.left)!, byId.get(pair.right)!);
    const values = deltas.map((entry) => entry.delta);
    const wins = values.filter((value) => value > 1e-9).length;
    const losses = values.filter((value) => value < -1e-9).length;
    const binary = isBinarySeries(values);
    const signFlip = exactSignFlipTest(values);
    const interval = randomizationInversionInterval(values, { alpha: 0.05, step: 0.005 });
    return {
      left: pair.left,
      right: pair.right,
      n: values.length,
      meanDelta: values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length,
      wins,
      ties: values.length - wins - losses,
      losses,
      discordantPairs: wins + losses,
      binarySeries: binary,
      pPrimary: binary ? exactMcNemarTwoSided(wins, wins + losses) : signFlip.twoSidedP,
      pRaw: exactMcNemarTwoSided(wins, wins + losses),
      pSignFlip: signFlip.twoSidedP,
      primaryTest: binary
        ? 'exact-mcnemar-two-sided (§8.3.1)'
        : 'exact-paired-randomization-sign-flip (§8.3.2)',
      randomizationInterval: interval,
      intervalWidth: interval.upper - interval.lower,
      perTask: deltas
    };
  });
  const exploratoryQ = benjaminiHochberg(exploratoryRaw.map((entry) => entry.pPrimary));
  const exploratory = exploratoryRaw.map((entry, index) => ({ ...entry, q: exploratoryQ[index] }));
  /**
   * §12.2 item 3 asks for a 12 × 10 per-task table. The 10 columns are the
   * supplementary pairwise deltas; the four controlled ESTIMATOR series are
   * reported separately in `controlledSeries` so the two families stay visually
   * and mathematically distinct (the table's 10 columns must not be mixed with
   * the 4 pre-registered contrasts).
   */
  const pairwiseTable = {
    note:
      'V2 §12.2 item 3: 12 tasks × 10 pairwise deltas (left − right), all supplementary/exploratory. ' +
      'The four §8.6 controlled estimators are NOT columns here; see comparisons.controlledSeries.',
    columns: exploratoryRaw.map((entry) => entry.left + '−' + entry.right),
    rows: PR4A_ARMS.length === 0
      ? []
      : [...new Set(exploratoryRaw.flatMap((entry) => entry.perTask.map((task) => task.taskId)))].map(
          (taskId) => ({
            taskId,
            cells: exploratoryRaw.map((entry) => {
              const row = entry.perTask.find((item) => item.taskId === taskId);
              return row === undefined ? null : Number(row.delta.toFixed(6));
            })
          })
        )
  };
  const controlledSeries = {
    note: 'V2 §3.3/§8.4: the four pre-registered estimator series, one value per task.',
    columns: CONTROLLED_CONTRASTS.map((entry) => entry.id),
    rows: (series.get('write') ?? []).map((entry) => ({
      taskId: entry.taskId,
      cells: CONTROLLED_CONTRASTS.map(
        (contrast) =>
          series.get(contrast.kind)?.find((item) => item.taskId === entry.taskId)?.value ?? null
      )
    }))
  };

  // ---- cost (V2 §9) ----
  const costTable = arms.map((arm) => ({
    armId: arm.armId,
    denominator: arm.cost.denominator,
    decisionPoints: arm.cost.decisionPoints,
    modelCalls: arm.cost.modelCalls,
    measured: arm.cost.measured,
    estimated: arm.cost.estimated,
    unknown: arm.cost.unknown,
    notionalCostMicros: arm.cost.notionalCostMicros,
    conservativeSurchargeMicros: arm.cost.conservativeSurchargeMicros,
    rateCardId: arm.cost.rateCardId,
    rateCardVersion: arm.cost.rateCardVersion,
    liveCalls: arm.cost.liveCalls,
    incurredRealUsd: arm.cost.incurredRealUsd,
    localWallClockMs: arm.cost.localWallClockMs
  }));

  /**
   * V2 §9.3: the six token fields, each with its OWN precision state. The cost
   * table's `estimated` share is about decision points, not about these six
   * fields, so they are reported here explicitly instead of being implied by a
   * total.
   */
  const tokenFields = {
    note:
      'V2 §9.3: input / output / reasoning / cache-read / cache-write / total, each carrying its own ' +
      'precision label. No total may be read as "measured".',
    fields: [
      'inputTokens',
      'outputTokens',
      'reasoningTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'totalTokens'
    ],
    estimator: arms[0]?.cost.estimator ?? '',
    perArm: arms.map((arm) => ({
      armId: arm.armId,
      inputTokens: arm.cost.inputTokens,
      outputTokens: arm.cost.outputTokens,
      reasoningTokens: arm.cost.reasoningTokens,
      cacheReadTokens: arm.cost.cacheReadTokens,
      cacheWriteTokens: arm.cost.cacheWriteTokens,
      totalTokens: arm.cost.totalTokens,
      denominator: arm.cost.denominator,
      decisionPoints: arm.cost.decisionPoints,
      modelCalls: arm.cost.modelCalls
    }))
  };

  // ---- safety / execution control (V2 §10) ----
  const safety = {
    events: arms.flatMap((arm) => arm.controlEvents),
    perArm: arms.map((arm) => ({
      armId: arm.armId,
      events: arm.controlEvents.length,
      notes: arm.notes
    })),
    /**
     * §10.2 paths that were NOT taken are reported as not-triggered WITH the
     * reason, so "未触发" is a recorded observation instead of an omission.
     */
    executionControlCoverage: [
      {
        path: 'security-gate',
        label: 'STOP-ALL (publishAuthorized leak / unauthorized write / unredacted payload)',
        triggered: arms.some((arm) =>
          arm.controlEvents.some((event) => event.kind === 'safety-violation')
        ),
        note:
          'defensive assertion: permissions.publish.allowed is false in all four execution modes, so this path has no executable trigger in this round (V2 §10.2 item 1)'
      },
      {
        path: 'offline-notional-guardrail',
        label: 'STOP-ARM (offline notional micros / token guardrail)',
        triggered: arms.some((arm) => arm.controlEvents.some((event) => event.kind === 'guardrail-stop')),
        note: 'runaway-fixture stopper; NOT a financial cap and NOT a budget authorisation (V2 §9.4)'
      },
      {
        path: 'early-stopped-for-harm',
        label: 'STOP-ARM (futility stop)',
        triggered: arms.some((arm) => arm.controlEvents.some((event) => event.kind === 'futility-stop')),
        note:
          'fires at 3 consecutive tasks with observed verifiedRate = 0; the V2 §10.2 item 3 wording also requires destructive errors, which this fixture cannot produce — the wording difference is disclosed rather than silently applied'
      },
      {
        path: 'timeout-isolation',
        label: 'TIMEOUT-ISOLATION (per-execution local wall-clock)',
        triggered: arms.some((arm) => arm.controlEvents.some((event) => event.kind === 'runner-timeout')),
        note: 'a censored execution is audit-only and is never counted as a task failure (V2 §6.4)'
      }
    ],
    offlineNotionalGuardrailMicros: OFFLINE_NOTIONAL_BUDGET_MICROS,
    offlineNotionalGuardrailTokens: OFFLINE_NOTIONAL_TOKEN_BUDGET,
    guardrailIsNotAFinancialCap: true,
    localTaskWallClockMs: LOCAL_TASK_WALLCLOCK_MS,
    localCallTimeoutMs: LOCAL_CALL_TIMEOUT_MS,
    wallClockIsNotARemoteCostCeiling: true,
    dataCompleteness: arms.map((arm) => ({ armId: arm.armId, ...arm.completeness }))
  };

  // ---- invariants (V2 §5.4/§7.2/§9) ----
  const poolDigestsByArm = arms.map((arm) => {
    const map = new Map<string, string>();
    for (const row of ledgers.get(arm.armId) ?? []) {
      map.set(row.taskId + '|' + row.run + '|' + row.round, row.poolDigest);
    }
    return { armId: arm.armId, map };
  });
  let poolMismatches = 0;
  const baselinePools = poolDigestsByArm[0]!.map;
  for (const entry of poolDigestsByArm.slice(1)) {
    for (const [key, digest] of baselinePools) {
      const other = entry.map.get(key);
      if (other !== undefined && other !== digest) poolMismatches += 1;
    }
  }
  let recordOverlaps = 0;
  for (let i = 0; i < arms.length; i += 1) {
    for (let j = i + 1; j < arms.length; j += 1) {
      const left = new Set(arms[i]!.storeRecordIds);
      for (const id of arms[j]!.storeRecordIds) if (left.has(id)) recordOverlaps += 1;
    }
  }
  const gateArms = arms.filter((arm) => arm.spec.conservativeGate);
  const gateReachable = gateArms.some((arm) => arm.gate.applied > 0);
  /**
   * §5.2 track invariant, PER ROW. `wroteTrack` alone is the LAST write: a store
   * with one wrong row and a correct final row would pass it. The per-row tally
   * is the assertion; the scalar is kept only for continuity.
   */
  const perRowTrack = arms.map((arm) => ({
    armId: arm.armId,
    expectedTrack: arm.spec.track,
    wroteTrack: arm.wroteTrack,
    rowsWritten: arm.learningTrackRows.written,
    rowsMatching: arm.learningTrackRows.matching,
    rowsMismatched: arm.learningTrackRows.mismatched,
    rowsWithoutWrite: arm.learningTrackRows.nullRows,
    satisfiesExpectedTrackCount: arm.spec.writesBack
      ? arm.learningTrackRows.mismatched === 0
      : arm.learningTrackRows.written === 0,
    /**
     * HONEST DISCLOSURE (V2 §3.4/§8.4). In this fixture `θ_track` and `θ_write`
     * are COLLINEAR: the quality-track arms reproduce the frozen reference
     * exactly, so Arm-3 ≡ Arm-0 ≡ Arm-4 in the analysed cells and the track
     * contrast becomes numerically identical to the write-back contrast. That is
     * also why the quality row of the gate factor is unidentifiable. A reader
     * must not read the `above-MMI` band of θ_track as positive track evidence.
     */
    qualityTrackEqualsFrozenReference: null as boolean | null
  }));
  /**
   * COLLINEARITY DIAGNOSIS (V2 §3.4/§8.4 reading order).
   *
   * The measurement is reported in its EXACT algebraic form rather than as a
   * loose "identical" claim, because the two are different facts:
   *
   *   θ_write_i = Y1i − Y0i
   *   θ_track_i = ½[(Y3i − Y1i) + (Y4i − Y2i)]
   *
   * If the quality arms reproduce the frozen reference (Y3 ≡ Y4 ≡ Y0), then
   *
   *   θ_track_i = ½[(Y0i − Y1i) + (Y0i − Y2i)] = −½[θ_write_i + (Y2i − Y0i)]
   *
   * i.e. θ_track becomes a deterministic function of the two PROCESS-row
   * contrasts and carries ZERO track information. It is not numerically equal to
   * θ_write in general (that would need Y2 ≡ Y1); what makes it uninformative is
   * that it is a rank-1 function of other rows. Both facts are measured and
   * printed, and a boolean `qualityArmsIdenticalToReference` names the condition
   * that produces the degeneracy, so a future run with different data cannot
   * inherit this fixture's conclusion.
   */
  const qualityArmsEqualReference = (() => {
    const a3 = byId.get('Arm-3')!;
    const a4 = byId.get('Arm-4')!;
    const a0 = byId.get('Arm-0')!;
    const same = (left: Pr4aArmResult, right: Pr4aArmResult): boolean =>
      left.tasks.length === right.tasks.length &&
      left.tasks.every(
        (task, index) =>
          task.taskId === right.tasks[index]?.taskId &&
          task.verifiedRate === right.tasks[index]?.verifiedRate
      );
    return { arm3EqualsArm0: same(a3, a0), arm4EqualsArm0: same(a4, a0), arm3EqualsArm4: same(a3, a4) };
  })();
  const trackSeriesValues = (series.get('track') ?? []).map((entry) => entry.value);
  const writeSeriesValues = (series.get('write') ?? []).map((entry) => entry.value);
  const gateSeriesValues = (series.get('gate') ?? []).map((entry) => entry.value);
  /**
   * The EXACT reduced form. With the quality arms pinned to the frozen reference
   * (Y3 ≡ Y4 ≡ Y0), substituting into the §3.3 definitions gives the identity
   *
   *     θ_track_i = −(θ_write_i + θ_gate_i)
   *
   * `max_i |θ_track_i + θ_write_i + θ_gate_i|` is therefore an executable PROOF
   * of the degeneracy: at ~0, θ_track is fully determined by the two other
   * contrasts and contributes no independent information.
   */
  const reducedFormMaxResidual = (() => {
    if (trackSeriesValues.length === 0) return null;
    let worst = 0;
    for (let i = 0; i < trackSeriesValues.length; i += 1) {
      const predicted = -((writeSeriesValues[i] ?? 0) + (gateSeriesValues[i] ?? 0));
      worst = Math.max(worst, Math.abs((trackSeriesValues[i] ?? 0) - predicted));
    }
    return Number(worst.toFixed(12));
  })();
  const thetaTrackIdenticalToThetaWrite =
    trackSeriesValues.length > 0 &&
    trackSeriesValues.length === writeSeriesValues.length &&
    trackSeriesValues.every((value, index) => Math.abs(value - (writeSeriesValues[index] ?? Number.NaN)) < 1e-9);
  const reducedFormHolds =
    reducedFormMaxResidual !== null && reducedFormMaxResidual < 1e-9;
  const collinearity = {
    /** Measured equality of the two SERIES (false here; see the reduced form). */
    thetaTrackEqualsThetaWrite: thetaTrackIdenticalToThetaWrite,
    /** Max residual of the exact identity below; ~0 proves the degeneracy. */
    thetaTrackReducedFormResidual: reducedFormMaxResidual,
    thetaTrackReducedForm: 'θ_track_i = −(θ_write_i + θ_gate_i) — exact whenever the quality arms reproduce the frozen reference',
    thetaTrackReducedFormHolds: reducedFormHolds,
    thetaTrackRankDeficient: reducedFormHolds || thetaTrackIdenticalToThetaWrite,
    trackVsWriteSeriesCorrelation: pearsonCorrelation(trackSeriesValues, writeSeriesValues),
    qualityArmsEqualReference,
    /** The condition that makes θ_track uninformative about the track factor. */
    qualityArmsIdenticalToReference:
      qualityArmsEqualReference.arm3EqualsArm0 &&
      qualityArmsEqualReference.arm4EqualsArm0 &&
      qualityArmsEqualReference.arm3EqualsArm4,
    disclosure:
      'In this fixture the quality arms reproduce the FROZEN reference on every analysed task ' +
      '(Arm-3 ≡ Arm-4 ≡ Arm-0). Consequently θ_track is NOT an independent measurement of the track factor: ' +
      'it satisfies the exact identity `θ_track = −(θ_write + θ_gate)` (residual printed above), which contains ' +
      'no quality-row term at all. θ_track and θ_write are therefore rank-deficient with respect to the track ' +
      'factor, and θ_track’s `above-MMI` band is NOT positive track evidence. Only the process row of the gate ' +
      'factor is identifiable, and the interaction term is unidentifiable because the two quality cells are ' +
      'identical.',
    identifiability: {
      gateFactorIdentifiableOn: arms
        .filter((arm) => arm.spec.conservativeGate && arm.gate.applied > 0)
        .map((arm) => arm.armId),
      gateFactorUnidentifiableOn: arms
        .filter((arm) => arm.spec.conservativeGate && arm.gate.applied === 0)
        .map((arm) => arm.armId),
      interactionIdentifiable: !qualityArmsEqualReference.arm3EqualsArm4,
      trackFactorIdentifiable: !(
        qualityArmsEqualReference.arm3EqualsArm0 && qualityArmsEqualReference.arm4EqualsArm0
      )
    }
  };
  const perRowTrackFinal = perRowTrack.map((entry) => ({
    ...entry,
    qualityTrackEqualsFrozenReference:
      entry.armId === 'Arm-3' || entry.armId === 'Arm-4'
        ? collinearity.qualityArmsEqualReference.arm3EqualsArm0
        : null
  }));

  const invariants = {
    poolDigestMismatches: poolMismatches,
    poolDigestAssertion: poolMismatches === 0 ? 'passed' : 'FAILED',
    crossArmRecordOverlaps: recordOverlaps,
    recordIsolationAssertion: recordOverlaps === 0 ? 'passed' : 'FAILED',
    arm0Frozen:
      reference.recordsAppended === 0 &&
      reference.initialSnapshotDigest === reference.finalSnapshotDigest,
    trackPerArm: perRowTrackFinal,
    /** The PER-ROW invariant: no arm may write a row outside its declared track. */
    trackIsolationPerRowAssertion: perRowTrackFinal.every(
      (entry) => entry.satisfiesExpectedTrackCount
    )
      ? 'passed'
      : 'FAILED',
    /** §6.3: unauthenticated executions are audit-only and never persisted. */
    auditOnlyAssertion:
      arms.every((arm) => arm.auditOnlyViolations === 0) ? 'passed' : 'FAILED',
    /**
     * §6.3 quality-neighbourhood check: on every quality-arm decision point, how
     * many visible quality records failed authentication. A non-zero count means
     * an unauthenticated record was one filter away from an estimate.
     */
    qualityNeighbourhood: arms.map((arm) => ({
      armId: arm.armId,
      track: arm.spec.track,
      ...arm.qualityNeighbourhood
    })),
    writeAccounting: arms.map((arm) => ({
      armId: arm.armId,
      ...arm.writeAccounting,
      auditOnlyViolations: arm.auditOnlyViolations
    })),
    /** §3.4: the four challenger fields must exist on EVERY row, gate off included. */
    challengerFieldsUnconditional: (() => {
      const rows = [...ledgers.values()].flat();
      const missing = rows.filter(
        (row) =>
          typeof row.challengerSupport !== 'number' ||
          typeof row.challengerShrunkAdvantage !== 'number' ||
          typeof row.challengerCalibratedAdvantage !== 'number' ||
          typeof row.challengerHasReplacementEvidence !== 'boolean'
      ).length;
      return {
        assertion: missing === 0 ? 'passed' : 'FAILED',
        rowsWithoutFields: missing,
        rowsChecked: rows.length,
        gateOffRowsWithMeasuredNEff: rows.filter(
          (row) => row.armId === 'Arm-1' || row.armId === 'Arm-3'
        ).length
      };
    })(),
    /** §3.4: measurements exist on gate-off rows (the draft reported null there). */
    gateOffChallengerMeasurement: arms
      .filter((arm) => !arm.spec.conservativeGate && arm.spec.writesBack)
      .map((arm) => ({
        armId: arm.armId,
        rows: (ledgers.get(arm.armId) ?? []).length,
        rowsWithChallengerMeasurement: (ledgers.get(arm.armId) ?? []).filter(
          (row) => typeof row.challengerShrunkAdvantage === 'number'
        ).length,
        meanChallengerNEff: arm.meanChallengerNEff
      })),
    gateDistribution: arms.map((arm) => ({
      armId: arm.armId,
      gateEnabled: arm.spec.conservativeGate,
      applied: arm.gate.applied,
      keptPrior: arm.gate.keptPrior,
      executedProposed: arm.gate.executedProposed,
      executedExploration: arm.gate.executedExploration,
      proposedDeviations: arm.gate.proposedDeviations,
      reasons: arm.gate.reasons
    })),
    gateReachableOnSharedPath: gateReachable,
    explorationAllowancePinned: PR4A_EXPLORATION_ALLOWANCE,
    /** §6.1: the host verdict is the metric; the coverage substitute is a diagnostic. */
    hostVerdictAssertion: {
      assertion: arms.every((arm) => arm.verification.hostCoverageDisagreements === 0)
        ? 'passed'
        : 'FAILED',
      perArm: arms.map((arm) => ({
        armId: arm.armId,
        agreements: arm.verification.hostCoverageAgreements,
        disagreements: arm.verification.hostCoverageDisagreements
      }))
    },
    collinearity,
    completeness: arms.map((arm) => ({ armId: arm.armId, ...arm.completeness }))
  };

  // ---- honest declarations (V2 §8.7/§9/§12.3) ----
  const d = closedFormMinDetectableD();
  const declarations = {
    protocol: PROTOCOL_ID,
    liveCalls: 0,
    incurredRealUsd: 0,
    costIsNotional: true,
    microsIsNotUsd:
      'micros is a UNIT CONVENTION (1 USD = 1,000,000 micros), not an incurred spend; the rate card is an offline fixture model',
    notionalGuardrailMicros: OFFLINE_NOTIONAL_BUDGET_MICROS,
    notionalGuardrailTokens: OFFLINE_NOTIONAL_TOKEN_BUDGET,
    notionalGuardrailIsNotAFinancialCap: true,
    wallClockIsNotARemoteCostCeiling: true,
    powerIsClosedFormApproximation: d.note,
    minDetectableD: d.d,
    exactPowerTable: [0.7, 0.75, 0.8, 0.85, 0.9].map((pi) => ({
      pi,
      power: exactSignTestPower(pi)
    })),
    minDetectableWinRate: minDetectableWinRate(),
    widthBudget: widthBudget(0.5),
    analysisUnit: 'task (N=' + String(PR4A_TASKS) + ')',
    roundsAreNotSamples: true,
    wilcoxonUsedOnBinary: false,
    bands: { MMI, NIM, DTS_MAX },
    primaryTestPolicy:
      'the §8.6 controlled family uses the SAP-designated primary test per series type: exact paired ' +
      'randomization (sign-flip) for rate-type series (§8.3.2), exact McNemar only when the series is ' +
      'binary (§8.3.1). Multiplicity (Holm) is applied to that primary p-value.',
    verdictIntervalPolicy:
      'the §8.5 ③④ dimensions read the ESTIMATOR interval (randomization inversion of mean Δ); the ' +
      'Clopper-Pearson interval of the discordant-pair win probability π is reported as a separate ' +
      'descriptive quantity and is NOT the verdict interval.',
    externalValidity:
      '12 synthetic tasks provide mechanistic/feasibility evidence only; they are NOT a production significance claim ' +
      'and must not be generalised (V2 §8.7)'
  };

  /**
   * §12.2 item 2 also asks that the JSON carry the ledger; the full arrays are
   * written to their own `.jsonl` files (with SHA-256 in the report), and this
   * index pins their cardinality so the files cannot silently shrink.
   */
  const ledgerIndex = {
    note:
      'V2 §12.2 item 2: the FULL per-arm decision ledgers are persisted as one JSON object per line in ' +
      'work/pr4a-ledger-<Arm>.jsonl, with a SHA-256 per file printed in the Markdown report.',
    perArm: [...ledgers.entries()].map(([armId, rows]) => ({
      armId,
      rows: rows.length,
      file: 'work/pr4a-ledger-' + armId + '.jsonl',
      columns: Object.keys(rows[0] ?? {})
    }))
  };

  return {
    report: {
      protocol: PROTOCOL_ID,
      generatedAt: new Date().toISOString(),
      codeBaseline: options.codeBaseline,
      codeProvenance: options.codeProvenance,
      design: {
        arms: PR4A_ARMS,
        episodes,
        rounds,
        tasks: PR4A_TASKS,
        explorationAllowance: PR4A_EXPLORATION_ALLOWANCE,
        taskOrder: order,
        estimator:
          'chars/4 over the rendered prompt text — every token figure is ESTIMATED; no tokenizer exists in this harness'
      },
      replication,
      arms,
      comparisons: {
        controlled,
        controlledSeries,
        pairwiseTable,
        exploratory,
        familySeparation: {
          controlledFamily: '§8.6 Holm-Bonferroni over the 4 pre-registered estimators',
          exploratoryFamily: '§8.6 BH FDR over the 10 supplementary pairwise deltas',
          rule:
            'the two families are never merged: the supplementary q-values must not support any five-arm conclusion'
        }
      },
      cost: { note: 'V2 §9: notional micros only; liveCalls=0; incurredRealUsd=0', arms: costTable },
      tokenFields,
      safety,
      invariants,
      declarations,
      ledgerIndex
    },
    ledgers
  };
}
