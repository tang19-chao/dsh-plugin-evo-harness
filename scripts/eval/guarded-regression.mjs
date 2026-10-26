#!/usr/bin/env node
/**
 * P6.2 guarded regression harness (ADR 0002 R9.1 gate #7; t4 deliverable).
 *
 * Deterministic, in-process, no network/model/host: it bundles the REAL
 * production modules with the repo's own esbuild (in-memory, no cache files)
 * and executes the release contract end to end over synthetic fixtures, so the
 * t4 acceptance criteria have one runnable witness that t2 can execute and
 * bind (exit 0 + JSON).
 *
 *   --json   machine-readable report on stdout (exit code stays the verdict)
 *
 * Probes (each maps to an ADR section):
 *   F1   the single learning-eligibility predicate isolates every foreign
 *        version at the store query path (r3 online, r2, surrogate, unversioned,
 *        future, ineligible) - R3/R5;
 *   F2   the rescore channel: a full-provenance r4 rescore re-enters, an
 *        incomplete one fails closed - R3 5.2;
 *   F4   the conservative replacement gate: the first-harm shape is vetoed,
 *        thin evidence without budget does not replace, thin evidence with
 *        explicit budget executes and charges, full evidence replaces - R5;
 *   R5-6 reservation release: cancelled/aborted/infra executions release the
 *        exploration seat, real completions keep the charge;
 *   C2a  the trusted boundary: shape-only verdicts are not trusted; t7/V5
 *        removed the public string registrar, so NO id can be promoted this
 *        round; publish/memory denied in every mode - 5.2a/R2;
 *   C1p  the execution profile defaults: shadow + all permissions denied,
 *        patch only in guarded-active, off stops records - R1/R2;
 *   T7-V1 the permanent-mount flag is DERIVED from the patch permission:
 *        hand-built construction and applyWinningPatch=true outside
 *        guarded-active can never mount (t7/V1, R2);
 *   T7-V2 deps.conservativeGate=true outside guarded-active is rejected
 *        fail-closed at construction - shadow/baseline/off never intercept
 *        selection (t7/V2, R1);
 *   T7-V3 learning tracks are explicit and never mix: a task-quality
 *        neighbourhood accepts only explicit declarations; every production
 *        consumer (L1/L2/L3/replay/M3) filters the process track at its own
 *        boundary (the shared kernel filter stays untouched, R6) (t7/V3,
 *        5.2a-4);
 *   T7-V4 a noop challenger with real measured evidence is judged by that
 *        evidence; only the evidence-free artefact is hard-vetoed (t7/V4,
 *        R5-5);
 *   T8-R1 the four modes have ACTUAL wiring: off stops the orchestrator-
 *        driven Jit surfaces, baseline keeps records audit-level (no
 *        suggestion triple), shadow records suggestions with zero side
 *        effects, guarded-active alone enables the gate channel (t8/R1,
 *        ADR 0002 §3);
 *   T8-R2 the memory permission is denied in every mode and is enforced at the
 *        CALL SITE: a denied commit never reaches promote/mirror/commit, and
 *        the diagnostic says so (no renamed scratch namespace) (t8/R2,
 *        ADR 0002 §4);
 *   T8-R3 replay reconstruction is declaration-driven and fail-closed: a
 *        shadow/signature replay rebuilds only the matching neighbourhood,
 *        the same log reloads to the same set, undeclared/typo records are
 *        excluded (t8/R3+R8, ADR 0002 §10);
 *   T8-R4 every shadow record carries the challenger strength marks
 *        (nEff/support/shrunk/calibrated) and the numeric gate-outcome code,
 *        gate open or closed (t8/R4, ADR 0002 R1 shadow 行);
 *   T8-R5 grant/revoke/remaining are public on the orchestrator handle; the
 *        default allowance is 0 and the reservation refund is idempotent per
 *        execution key (t8/R5, ADR 0002 R5-6);
 *   T8-V5b a static + runtime assertion that nothing in the C0+C1 production
 *        modules can flip the trusted boundary (no registrar, no registry
 *        mutation call), and provenance requires an evidenceHash BOUND to
 *        the execution evidence (t8/V5b, ADR 0002 5.2a-3);
 *   C1s  shadow isolation: an r3-stamped producer never enters the r4
 *        neighbourhood and the persisted marker IS the contract id - R3;
 *   C1r  rollback semantics: requiresExperienceRebuild is true for the r3->r4
 *        switch and the migration plans marked copies without rewriting the
 *        source log - R3 5.3;
 *   R8   the explicit decision fields round-trip and reject typos;
 *   F3   the verifier-first scale still refutes wrong-but-fluent runs and the
 *        numeric yardstick is frozen - R3 5.1;
 *   T10-R2b/T10-R2c (t12) a denied memory permission means ZERO bridge calls at
 *        the call site (accepting-bridge receptor) under the hand-built default
 *        and every mode, with an explicit-override positive control;
 *   T10-R3b (t12) the CALLER-declared replay declarations win over the factory
 *        default: forward/reverse/mixed-pool direction assertions;
 *
 * Bundling note: esbuild resolves the src/*.ts import chain (which itself
 * omits extensions) into one ESM blob evaluated here; only erasable-TypeScript
 * modules are reachable from the probe imports, so the bundle is faithful to
 * the sources.
 */

import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

/**
 * The probe program as a source string. It imports the real production
 * modules, runs every probe against deterministic fixtures and exports one
 * async runGuardedRegression() returning the report object.
 */
const PROBE_SOURCE = `
import { createMemoryExperienceStore } from '${'../../src/jitrl/stores/memory.store.ts'}';
const REPO_ROOT = ${JSON.stringify(REPO_ROOT)};
import {
  CURRENT_REWARD_VERSION,
  EXPERIENCE_SCHEMA_VERSION,
  PREVIOUS_REWARD_VERSION
} from '${'../../src/jitrl/experience-store.ts'}';
import {
  REWARD_CONTRACT,
  RESCORE_REWARD_VERSION,
  contractWeightsHash,
  isLearningEligibleRecord,
  isRewardVersionCompatible,
  isRewardVersionExact,
  isValidRescoreProvenance,
  requiresExperienceRebuild,
  scoreUnderRewardContract
} from '${'../../src/jitrl/reward-contract.ts'}';
import {
  BACKFILL_REWARD_VERSION,
  buildRescoredBackfillRecord,
  migrateExperienceRecords
} from '${'../../src/jitrl/backfill.ts'}';
import { conservativeAdvantage } from '${'../../src/jitrl/value-estimator.ts'}';
import {
  decideReplacement,
  shouldReleaseReservation
} from '${'../../src/jitrl/replacement-policy.ts'}';
import {
  hasTrustedVerificationProvenance,
  isRegisteredTrustedVerifier
} from '${'../../src/jitrl/step-evaluator.ts'}';
import { resolveExecutionProfile } from '${'../../src/runtime/execution-profile.ts'}';
import {
  isOnLearningTrack,
  PRODUCTION_LEARNING_TRACK,
  matchesReplayDeclarations
} from '${'../../src/jitrl/experience-store.ts'}';
import {
  EvoHarnessOrchestratorImpl,
  GATE_REASON_CODES,
  gateReasonCodeOf
} from '${'../../src/orchestrator.ts'}';
import { readFileSync } from 'node:fs';
import { abstractMetaState } from '${'../../src/jitrl/state-abstraction.ts'}';

const T0 = 1_700_000_000_000;

function record(overrides = {}) {
  return {
    id: 'rec-' + Math.random().toString(36).slice(2, 8),
    level: 'proposal',
    state: { level: 'proposal', bucket: 'b', tokens: ['t'], summary: '' },
    actionKey: 'patch:a',
    reward: 1,
    return: 1,
    rewardSources: {},
    guidance: 'memory',
    policyId: 'pi',
    sessionId: 's',
    // Fixture default: a CURRENT producer's record (schema-current, stamped,
    // eligible). Individual probes override the fields they isolate.
    experienceSchemaVersion: EXPERIENCE_SCHEMA_VERSION,
    rewardVersion: CURRENT_REWARD_VERSION,
    provenanceVersion: 'p2/per-execution-v1',
    learningEligible: true,
    createdAt: T0,
    redacted: true,
    ...overrides
  };
}

function trajectory(overrides = {}) {
  return {
    id: 't',
    sessionId: 's',
    branchId: 'b',
    branchNamespace: 'ns',
    role: 'candidate',
    status: 'succeeded',
    patchId: 'p',
    patchOrigin: 'domain',
    surfaceKeys: [],
    startedAt: 0,
    endedAt: 10,
    metrics: { steps: 2, toolCalls: 1, toolErrors: 0, durationMs: 10 },
    steps: [],
    toolErrors: [],
    failureSignals: [],
    memoryRecallIds: [],
    ...overrides
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const PROBES = [
  {
    id: 'F1-version-isolation',
    section: 'R3/R5',
    fn: async () => {
      const store = createMemoryExperienceStore({ now: () => T0 + 1000 });
      const shapes = [
        record({ id: 'keep', rewardVersion: CURRENT_REWARD_VERSION, value: 1 }),
        record({ id: 'r3', rewardVersion: PREVIOUS_REWARD_VERSION, value: 9 }),
        record({ id: 'r2', rewardVersion: 'r2/verifiable-v1', value: 8 }),
        record({ id: 'surr', rewardVersion: BACKFILL_REWARD_VERSION, value: 7 }),
        // The pre-stamping shape: NO version fields at all (a legacy line).
        record({
          id: 'bare',
          value: 6,
          rewardVersion: undefined,
          provenanceVersion: undefined,
          experienceSchemaVersion: undefined
        }),
        record({ id: 'fut', rewardVersion: 'r5/future', value: 5 }),
        record({
          id: 'veto',
          rewardVersion: CURRENT_REWARD_VERSION,
          learningEligible: false,
          value: 4
        })
      ];
      await store.append(shapes);
      const queried = await store.query({
        level: 'proposal',
        state: { level: 'proposal', bucket: 'b', tokens: ['t'], summary: '' },
        k: 10,
        similarityThreshold: 0,
        excludeLegacy: true,
        learningEligibleOnly: true
      });
      const ids = queried.map((entry) => entry.record.id).sort();
      assert(
        JSON.stringify(ids) === JSON.stringify(['keep']),
        'only the r4 record may enter the learning neighbourhood, got ' + JSON.stringify(ids)
      );
      assert(isRewardVersionExact('r3/unified-signals-v1') === false, 'r3 must not be exact');
      assert(isRewardVersionCompatible(undefined) === false, 'unversioned fails closed');
      assert(
        requiresExperienceRebuild(PREVIOUS_REWARD_VERSION, CURRENT_REWARD_VERSION) === true,
        'r3->r4 requires rebuild'
      );
      return { kept: ids, isolated: shapes.length - 1 };
    }
  },
  {
    id: 'F2-rescore-channel',
    section: 'R3 5.2',
    fn: () => {
      const base = record({
        id: 'rescore-base',
        rewardVersion: BACKFILL_REWARD_VERSION,
        learningEligible: false,
        reward: 2,
        return: 2
      });
      const full = {
        sourceTrajectoryHash: 'sha256:abc',
        targetContractId: CURRENT_REWARD_VERSION,
        aggregation: REWARD_CONTRACT.aggregation,
        horizon: 'single-trajectory',
        weightsHash: contractWeightsHash(),
        verifierId: 'rescore-verifier'
      };
      assert(isValidRescoreProvenance(full) === true, 'full provenance must validate');
      const rescored = buildRescoredBackfillRecord({ base, provenance: full, contractObservedReturn: -1 });
      assert(rescored !== undefined, 'a full-provenance rescore must be produced');
      assert(
        rescored.rewardVersion === RESCORE_REWARD_VERSION,
        'rescore stamp must be ' + RESCORE_REWARD_VERSION
      );
      assert(isLearningEligibleRecord(rescored) === true, 'the rescored copy is the certified entry');
      for (const field of Object.keys(full)) {
        const broken = { ...full };
        delete broken[field];
        assert(
          isValidRescoreProvenance(broken) === false,
          'provenance missing ' + field + ' must fail closed'
        );
      }
      const foreignWeights = { ...full, weightsHash: 'deadbeef' };
      assert(
        buildRescoredBackfillRecord({ base, provenance: foreignWeights, contractObservedReturn: -1 }) ===
          undefined,
        'a foreign weights hash is a different yardstick'
      );
      return { rescoreId: RESCORE_REWARD_VERSION, provenanceFields: Object.keys(full).length };
    }
  },
  {
    id: 'F4-replacement-gate',
    section: 'R5',
    fn: () => {
      const prior = {
        actionKey: 'prior',
        q: 0.2,
        support: 4,
        nEff: 3.2,
        explored: false,
        advantage: 0.2
      };
      const veto = decideReplacement({
        proposedIndex: 1,
        priorIndex: 0,
        challenger: { actionKey: 'noop', q: null, support: 0, explored: false, advantage: 0 },
        prior,
        challengerIsNoop: true,
        explorationAllowance: 5
      });
      assert(veto.kind === 'kept-prior', 'the implicit-zero artefact is vetoed even with budget');
      assert(veto.gateReason === 'implicit-zero-advantage', 'veto reason must be recorded');
      const nEffless = decideReplacement({
        proposedIndex: 1,
        priorIndex: 0,
        challenger: { actionKey: 'new', q: 0.5, support: 5, explored: false, advantage: 0.3 },
        prior,
        challengerIsNoop: false,
        explorationAllowance: 0
      });
      assert(nEffless.kind === 'kept-prior', 'a missing nEff is no replacement evidence');
      assert(nEffless.gateReason === 'min-support', 'the thin-evidence reason must be recorded');
      const charged = decideReplacement({
        proposedIndex: 1,
        priorIndex: 0,
        challenger: { actionKey: 'thin', q: 0.9, support: 1, nEff: 1.2, explored: false, advantage: 0.7 },
        prior,
        challengerIsNoop: false,
        explorationAllowance: 2
      });
      assert(
        charged.kind === 'executed-exploration' && charged.exploration === true,
        'thin evidence executes only under explicit budget'
      );
      const noBudget = decideReplacement({
        proposedIndex: 1,
        priorIndex: 0,
        challenger: { actionKey: 'thin', q: 0.9, support: 1, nEff: 1.2, explored: false, advantage: 0.7 },
        prior,
        challengerIsNoop: false,
        explorationAllowance: 0
      });
      assert(noBudget.kind === 'kept-prior', 'thin evidence without budget never replaces');
      const full = decideReplacement({
        proposedIndex: 1,
        priorIndex: 0,
        challenger: { actionKey: 'strong', q: 0.9, support: 6, nEff: 4.5, explored: false, advantage: 0.7 },
        prior,
        challengerIsNoop: false,
        explorationAllowance: 0
      });
      assert(full.kind === 'executed-proposed', 'full evidence replaces');
      const same = decideReplacement({
        proposedIndex: 0,
        priorIndex: 0,
        challenger: prior,
        prior,
        challengerIsNoop: false,
        explorationAllowance: 3
      });
      assert(
        same.kind === 'executed-proposed' && same.exploration === false,
        'no deviation applies no gate'
      );
      const judged = conservativeAdvantage(prior);
      assert(judged.nEff === 3.2 && judged.support === 4, 'nEff and support are co-reported');
      return { cases: ['veto', 'nEffless', 'charged', 'noBudget', 'full', 'same'] };
    }
  },
  {
    id: 'T7-V4-noop-evidence',
    section: 't7/V4',
    fn: () => {
      const prior = {
        actionKey: 'prior',
        q: 0.1,
        support: 10,
        nEff: 7,
        explored: false,
        advantage: 0.1
      };
      // ORIGINAL DEFECT SHAPE: a noop challenger WITH real measured evidence
      // (support=12, nEff=8, non-zero advantage) was hard-vetoed by type with
      // a factually wrong 'implicit-zero-advantage' reason. Now it is judged
      // by its evidence: full evidence executes, budget untouched.
      const evidenced = decideReplacement({
        proposedIndex: 1,
        priorIndex: 0,
        challenger: { actionKey: 'noop', q: 0.6, support: 12, nEff: 8, explored: false, advantage: 0.5 },
        prior,
        challengerIsNoop: true,
        explorationAllowance: 0
      });
      assert(evidenced.kind === 'executed-proposed', 'an evidenced noop executes (judged by evidence)');
      assert(evidenced.exploration === false, 'an evidenced noop never charges the budget');
      assert(evidenced.challenger.hasReplacementEvidence === true, 'its evidence is real');
      // The evidence-free noop artefact is STILL hard-vetoed (first-harm shape).
      const artefact = decideReplacement({
        proposedIndex: 1,
        priorIndex: 0,
        challenger: { actionKey: 'noop', q: null, support: 0, explored: false, advantage: 0 },
        prior,
        challengerIsNoop: true,
        explorationAllowance: 5
      });
      assert(
        artefact.kind === 'kept-prior' && artefact.gateReason === 'implicit-zero-advantage',
        'an evidence-free noop stays the vetoed artefact'
      );
      return { evidencedNoop: evidenced.kind, artefactNoop: artefact.gateReason };
    }
  },
  {
    id: 'R5-6-reservation-release',
    section: 'R5',
    fn: () => {
      assert(shouldReleaseReservation({ exploration: true, completed: true, outcome: 'cancelled' }) === true, 'cancelled releases');
      assert(shouldReleaseReservation({ exploration: true, completed: true, outcome: 'aborted' }) === true, 'aborted releases');
      assert(shouldReleaseReservation({ exploration: true, completed: true, outcome: 'infrastructure_error' }) === true, 'infra releases');
      assert(shouldReleaseReservation({ exploration: true, completed: true, outcome: 'succeeded' }) === false, 'succeeded charges');
      assert(shouldReleaseReservation({ exploration: true, completed: true, outcome: 'failed' }) === false, 'failed charges');
      assert(shouldReleaseReservation({ exploration: true, completed: true, outcome: 'timeout' }) === false, 'timeout charges');
      assert(shouldReleaseReservation({ exploration: false, completed: true, outcome: 'cancelled' }) === false, 'non-exploration untouched');
      return {
        released: ['cancelled', 'aborted', 'infrastructure_error'],
        charged: ['succeeded', 'failed', 'timeout']
      };
    }
  },
  {
    id: 'C2a-trusted-boundary',
    section: '5.2a',
    fn: () => {
      const shapeOnly = {
        status: 'failed',
        verifierId: 'anyone-can-claim-this',
        verifierVersion: '1.0.0',
        evidenceHash: 'abc',
        checks: [{ id: 'c', passed: false }]
      };
      assert(hasTrustedVerificationProvenance(shapeOnly) === false, 'shape-only payload has no trusted provenance');
      assert(
        hasTrustedVerificationProvenance({
          status: 'unknown',
          verifierId: 'structural-derivation',
          verifierVersion: 'v1',
          evidenceHash: '',
          checks: [{ id: 'deliverable-present', passed: true }],
          implicit: true
        }) === false,
        'the structural fallback is never trusted'
      );
      // t7/V5: the public string registrar was REMOVED - no id can be
      // promoted this round. Every claim stays shape-only, including a
      // well-formed payload naming a trustworthy-LOOKING producer id.
      for (const claimed of ['guarded-regression-verifier', 'trusted-ci', 'verifier-prod-1']) {
        assert(isRegisteredTrustedVerifier(claimed) === false, 'no registrar exists for ' + claimed);
        assert(
          hasTrustedVerificationProvenance({ ...shapeOnly, verifierId: claimed, status: 'passed' }) === false,
          'a claimed producer id never establishes provenance (V5): ' + claimed
        );
      }
      for (const mode of ['baseline', 'shadow', 'guarded-active', 'off']) {
        const profile = resolveExecutionProfile({ mode });
        assert(profile.permissions.publish.allowed === false, 'publish denied in ' + mode);
        assert(profile.permissions.memory.allowed === false, 'memory denied in ' + mode);
      }
      return { registrarRemoved: true, publishMemoryDeniedInAllModes: true };
    }
  },
  {
    id: 'C1p-execution-profile',
    section: 'R1/R2',
    fn: () => {
      const shadow = resolveExecutionProfile();
      assert(shadow.mode === 'shadow' && shadow.shadowRecords === true, 'default mode is shadow with records');
      assert(shadow.permissions.patch.allowed === false, 'patch denied by default');
      const guarded = resolveExecutionProfile({ mode: 'guarded-active' });
      assert(guarded.permissions.patch.allowed === true, 'guarded-active enables the patch layer');
      assert(
        guarded.permissions.publish.allowed === false && guarded.permissions.memory.allowed === false,
        'guarded-active never unlocks publish/memory'
      );
      const off = resolveExecutionProfile({ mode: 'off' });
      assert(off.off === true && off.shadowRecords === false, 'off stops records');
      const baseline = resolveExecutionProfile({ mode: 'baseline' });
      assert(
        baseline.shadowRecords === false && baseline.permissions.patch.allowed === false,
        'baseline is records-free and side-effect-free'
      );
      return { defaultMode: shadow.mode, patchOnlyIn: 'guarded-active' };
    }
  },
  {
    id: 'T7-V1-mount-permission',
    section: 't7/V1',
    fn: () => {
      // ORIGINAL DEFECT SHAPE: a hand-built orchestrator whose deps omitted
      // executionProfile/applyWinningPatch defaulted the mount flag ON, so a
      // direct construction could permanently mount despite the shadow
      // profile. Now the flag is DERIVED: explicit request AND guarded-active.
      const minimal = {
        config: { probe: { maxConcurrentProbes: 1, probeTimeoutMs: 1000 } },
        memory: {},
        seams: { applyPermanentPatch: async () => () => undefined },
        policy: {},
        proposer: {},
        composer: {},
        reflector: {},
        scorer: {},
        taxonomy: {},
        dreamer: {},
        treePool: {},
        runBranch: async () => ({})
      };
      const bare = new EvoHarnessOrchestratorImpl(JSON.parse(JSON.stringify(minimal)));
      const bareInternal = bare;
      assert(bareInternal.executionProfile.mode === 'shadow', 'hand-built defaults to shadow');
      assert(
        bareInternal.executionProfile.permissions.patch.allowed === false,
        'patch permission denied for hand-built'
      );
      assert(bareInternal.applyWinningPatch === false, 'V1: the mount flag never defaults on');
      // Even an explicit request cannot mount outside guarded-active.
      for (const mode of ['shadow', 'baseline', 'off']) {
        const orch = new EvoHarnessOrchestratorImpl({
          ...minimal,
          applyWinningPatch: true,
          executionProfile: resolveExecutionProfile({ mode })
        });
        assert(
          orch.applyWinningPatch === false,
          'V1: applyWinningPatch=true cannot mount in mode ' + mode
        );
      }
      // Both sides on: the mount flag flips on ONLY in guarded-active.
      const guarded = new EvoHarnessOrchestratorImpl({
        ...minimal,
        applyWinningPatch: true,
        executionProfile: resolveExecutionProfile({ mode: 'guarded-active' })
      });
      assert(guarded.applyWinningPatch === true, 'V1: request + guarded-active = mount allowed');
      // t8 (验收: 默认装配 + 显式 applyWinningPatch=true 时 activePatchIds()
      // 必须为空、台账 permission 与实际行为一致): the default assembly is
      // shadow; an EXPLICIT request cannot widen it, and the ledger agrees.
      const explicitRequest = new EvoHarnessOrchestratorImpl({
        ...minimal,
        applyWinningPatch: true
        // No executionProfile: the default (shadow) resolves - exactly the
        // default-assembly shape an options.applyWinningPatch=true produces.
      });
      assert(
        explicitRequest.executionProfile.mode === 'shadow' &&
          explicitRequest.executionProfile.permissions.patch.allowed === false,
        'V1: the default assembly ledger reports shadow + patch denied'
      );
      assert(
        explicitRequest.applyWinningPatch === false,
        'V1: default assembly + explicit applyWinningPatch=true -> mount stays OFF'
      );
      assert(
        explicitRequest.activePatchIds().length === 0,
        'V1: activePatchIds() is empty under the default assembly with an explicit request'
      );
      return {
        bareConstruction: bareInternal.applyWinningPatch === false,
        requestAlone: 'denied',
        bothSides: 'guarded-active',
        ledgerAgreesWithBehaviour: true
      };
    }
  },
  {
    id: 'T7-V2-gate-profile-binding',
    section: 't7/V2',
    fn: () => {
      // ORIGINAL DEFECT SHAPE: deps.conservativeGate=true turned the L2 gate
      // ON under a shadow profile and the invalid combination was silently
      // accepted. Now the constructor rejects it fail-closed.
      const minimal = {
        config: { probe: { maxConcurrentProbes: 1, probeTimeoutMs: 1000 } },
        memory: {},
        seams: {},
        policy: {},
        proposer: {},
        composer: {},
        reflector: {},
        scorer: {},
        taxonomy: {},
        dreamer: {},
        treePool: {},
        runBranch: async () => ({})
      };
      for (const mode of ['shadow', 'baseline', 'off']) {
        let threw = false;
        try {
          new EvoHarnessOrchestratorImpl({
            ...minimal,
            conservativeGate: true,
            executionProfile: resolveExecutionProfile({ mode })
          });
        } catch (error) {
          threw = String(error && error.message).indexOf('guarded-active') >= 0;
        }
        assert(threw === true, 'V2: conservativeGate in mode ' + mode + ' must fail closed');
      }
      let noProfileThrew = false;
      try {
        new EvoHarnessOrchestratorImpl({ ...minimal, conservativeGate: true });
      } catch (error) {
        noProfileThrew = String(error && error.message).indexOf('guarded-active') >= 0;
      }
      assert(noProfileThrew === true, 'V2: the hand-built default (shadow) rejects the switch too');
      const valid = new EvoHarnessOrchestratorImpl({
        ...minimal,
        conservativeGate: true,
        executionProfile: resolveExecutionProfile({ mode: 'guarded-active' })
      });
      assert(valid.conservativeGate === true, 'V2: guarded-active accepts the explicit switch');
      const profileOnly = new EvoHarnessOrchestratorImpl({
        ...minimal,
        executionProfile: resolveExecutionProfile({ mode: 'guarded-active' })
      });
      assert(profileOnly.conservativeGate === true, 'V2: the profile alone enables the gate');
      return {
        rejectedModes: ['shadow', 'baseline', 'off'],
        accepted: 'guarded-active'
      };
    }
  },
  {
    id: 'T7-V3-track-isolation',
    section: 't7/V3',
    fn: async () => {
      // ORIGINAL DEFECT SHAPE: an unknown-verdict record's fused reward
      // (tool/steps/turn, completion=0) entered the learning neighbourhood
      // indistinguishable from task-quality samples - the consumer-side pin
      // of 5.2a-4 did not exist. Now the track is explicit on the record and
      // a task-quality neighbourhood accepts ONLY explicit declarations.
      const store = createMemoryExperienceStore({ now: () => T0 + 1000 });
      await store.append([
        record({ id: 'undeclared' }),
        record({ id: 'proc', learningTrack: 'process' }),
        record({ id: 'tq', learningTrack: 'task-quality' })
      ]);
      const state = { level: 'proposal', bucket: 'b', tokens: ['t'], summary: '' };
      const taskQuality = await store.query({
        level: 'proposal',
        state,
        k: 10,
        similarityThreshold: 0,
        learningTrack: 'task-quality'
      });
      assert(
        taskQuality.length === 1 && taskQuality[0].record.id === 'tq',
        'V3: only explicit task-quality declarations enter the task-quality neighbourhood'
      );
      const process = await store.query({
        level: 'proposal',
        state,
        k: 10,
        similarityThreshold: 0,
        learningTrack: 'process'
      });
      const processIds = process.map((entry) => entry.record.id).sort();
      assert(
        JSON.stringify(processIds) === JSON.stringify(['proc', 'undeclared']),
        'V3: the process neighbourhood keeps undeclared + process but never task-quality'
      );
      // The strict learning filter declares the process track (production
      // L1/L2/L3/replay/M3), so a task-quality record can never leak into a
      // process estimate either once C2 starts producing them.
      const snapshot = [
        record({ id: 'snap-undeclared' }),
        record({ id: 'snap-proc', learningTrack: 'process' }),
        record({ id: 'snap-tq', learningTrack: 'task-quality' })
      ];
      const processSnapshot = snapshot.filter((entry) =>
        isOnLearningTrack(entry, PRODUCTION_LEARNING_TRACK)
      );
      assert(
        JSON.stringify(processSnapshot.map((entry) => entry.id).sort()) ===
          JSON.stringify(['snap-proc', 'snap-undeclared']),
        'V3: the production snapshot pre-filter keeps undeclared + process, never task-quality'
      );
      const taskQualitySnapshot = snapshot.filter((entry) => isOnLearningTrack(entry, 'task-quality'));
      assert(
        taskQualitySnapshot.length === 1 && taskQualitySnapshot[0].id === 'snap-tq',
        'V3: only explicit task-quality declarations survive the task-quality filter'
      );
      assert(PRODUCTION_LEARNING_TRACK === 'process', 'V3: the production track is process');
      // A typo in the declared track is rejected at the store door.
      let typoRejected = false;
      try {
        const rejectStore = createMemoryExperienceStore({ now: () => T0 + 1000 });
        await rejectStore.append([record({ id: 'typo', learningTrack: 'tasks' })]);
      } catch {
        typoRejected = true;
      }
      assert(typoRejected === true, 'V3: a mistyped learningTrack is rejected, never guessed');
      return {
        taskQualityVisible: taskQuality.map((entry) => entry.record.id),
        processVisible: processIds,
        snapshotFilter: 'consumer-boundary (isOnLearningTrack/PRODUCTION_LEARNING_TRACK)'
      };
    }
  },
  {
    id: 'T8-R1-mode-wiring',
    section: 't8/R1',
    fn: () => {
      // t8/R1 (ADR 0002 §3): the four modes must have ACTUAL wiring, not just
      // a stamp. Probed through the real orchestrator constructor plus its
      // surface gate and record-shape rules.
      const minimal = (mode) => ({
        config: { probe: { maxConcurrentProbes: 1, probeTimeoutMs: 1000 } },
        memory: {},
        seams: {},
        policy: {},
        proposer: {},
        composer: {},
        reflector: {},
        scorer: {},
        taxonomy: {},
        dreamer: {},
        treePool: {},
        runBranch: async () => ({}),
        executionProfile: resolveExecutionProfile({ mode })
      });
      // off: the declared mode stops the Jit surfaces the orchestrator drives.
      const off = new EvoHarnessOrchestratorImpl(minimal('off'));
      const offInternal = off;
      assert(offInternal.executionProfile.off === true, 'off profile flags off');
      assert(
        offInternal.surfaceEnabled('onlineRecord') === false &&
          offInternal.surfaceEnabled('proposal') === false,
        'off stops the orchestrator-driven Jit surfaces (L2 select + online record)'
      );
      // baseline: records stay audit-level - shadowRecords=false means the
      // suggestion triple is NOT attached (see T8-R4 for the shadow shape).
      const baseline = new EvoHarnessOrchestratorImpl(minimal('baseline'));
      assert(
        baseline.executionProfile.shadowRecords === false,
        'baseline declares no shadow records'
      );
      // shadow (the default): suggestion records on, zero side effects.
      const shadow = new EvoHarnessOrchestratorImpl(minimal('shadow'));
      assert(
        shadow.executionProfile.shadowRecords === true &&
          shadow.executionProfile.permissions.patch.allowed === false,
        'shadow records suggestions with the patch layer denied'
      );
      // guarded-active: the only mode whose execution differs (gate channel).
      const guarded = new EvoHarnessOrchestratorImpl(minimal('guarded-active'));
      assert(
        guarded.conservativeGate === true && guarded.executionProfile.permissions.patch.allowed === true,
        'guarded-active enables the gate channel and the patch layer'
      );
      assert(shadow.conservativeGate === false, 'shadow never intercepts selection');
      return {
        off: 'surfaces stopped',
        baseline: 'audit-level records',
        shadow: 'suggestion records + no side effects',
        'guarded-active': 'gate channel + patch layer'
      };
    }
  },
  {
    id: 'T8-R2-memory-permission',
    section: 't8/R2',
    fn: () => {
      // t8/R2 + t12/R2-residual (ADR 0002 §4): the memory permission is denied
      // in EVERY mode this round and is enforced AT THE CALL SITE. The t10
      // "scope-local governed commit carve-out" is gone: it renamed the scope
      // and still issued the request, so a bridge that accepted any scope
      // persisted a denied write. commitLessons now returns before touching
      // deps.memory, and the bridge-call-count probes below pin that.
      for (const mode of ['baseline', 'shadow', 'guarded-active', 'off']) {
        const profile = resolveExecutionProfile({ mode });
        assert(profile.permissions.memory.allowed === false, 'memory denied in ' + mode);
      }
      const shadow = resolveExecutionProfile();
      assert(
        shadow.permissions.memory.reason.includes('never granted in this round'),
        'the denial reason is explicit on the profile'
      );
      return {
        memoryDeniedInAllModes: true,
        realNamespaceWrites: 'promote/mirror off by default',
        governedCommit: 'skipped at the call site under a denied permission (zero bridge calls)'
      };
    }
  },
  {
    id: 'T8-R3-replay-reconstruction',
    section: 't8/R3+R8',
    fn: async () => {
      // t8/R3+R8 (ADR 0002 §10): replay/restart rebuilds the neighbourhood
      // from the DECLARED fields - mode, vocabulary, rewardVersion - and fails
      // closed on undeclared records. Same log reloaded -> same set.
      const store = createMemoryExperienceStore({ now: () => T0 + 1000 });
      await store.append([
        record({ id: 'decl-shadow', decisionMode: 'shadow', actionKeyVocabulary: 'signature' }),
        record({ id: 'decl-guarded', decisionMode: 'guarded-active', actionKeyVocabulary: 'signature' }),
        record({ id: 'decl-semantic', decisionMode: 'shadow', actionKeyVocabulary: 'semantic' }),
        record({ id: 'undeclared' })
      ]);
      const state = { level: 'proposal', bucket: 'b', tokens: ['t'], summary: '' };
      const shadowReplay = await store.query({
        level: 'proposal',
        state,
        k: 10,
        similarityThreshold: 0,
        requireDeclaredMode: 'shadow',
        requireDeclaredVocabulary: 'signature'
      });
      assert(
        shadowReplay.length === 1 && shadowReplay[0].record.id === 'decl-shadow',
        'R3: a shadow/signature replay rebuilds ONLY the shadow+signature neighbourhood'
      );
      // A second reload of the same log rebuilds the SAME set (determinism).
      const again = await store.query({
        level: 'proposal',
        state,
        k: 10,
        similarityThreshold: 0,
        requireDeclaredMode: 'shadow',
        requireDeclaredVocabulary: 'signature'
      });
      assert(
        JSON.stringify(again.map((entry) => entry.record.id)) ===
          JSON.stringify(shadowReplay.map((entry) => entry.record.id)),
        'R3: same log reloaded -> same neighbourhood set'
      );
      // Declaration mismatches are fail-closed at the query door.
      let typoRejected = false;
      try {
        await store.query({
          level: 'proposal',
          state,
          k: 5,
          similarityThreshold: 0,
          requireDeclaredMode: 'yolo'
        });
      } catch {
        typoRejected = true;
      }
      assert(typoRejected === true, 'R3: an undeclared/typo mode is rejected, never guessed');
      // The shared predicate pins the same rule for snapshot consumers.
      assert(
        matchesReplayDeclarations(
          { decisionMode: 'shadow', actionKeyVocabulary: 'signature' },
          { requireDeclaredMode: 'shadow' }
        ) === true,
        'R3: matching declarations pass'
      );
      assert(
        matchesReplayDeclarations(
          { decisionMode: undefined, actionKeyVocabulary: undefined },
          { requireDeclaredMode: 'shadow' }
        ) === false,
        'R3: undeclared records never join a declared replay neighbourhood'
      );
      return {
        rebuilt: shadowReplay.map((entry) => entry.record.id),
        deterministic: true,
        failClosed: 'undeclared/typo rejected'
      };
    }
  },
  {
    id: 'T8-R4-shadow-record-strength',
    section: 't8/R4',
    fn: () => {
      // t8/R4 (ADR 0002 R1 shadow 行): every shadow record carries the
      // challenger strength (nEff/support/shrunk/calibrated) and the gate
      // outcome as retrievable numeric marks - gate open OR closed.
      const shadowMarks = {
        decisionPriorIndex: 0,
        decisionProposedIndex: 1,
        decisionExecutedIndex: 1,
        gateNeff: 4.5,
        gateSupport: 6,
        gateShrunkAdvantage: 0.3,
        gateCalibratedAdvantage: 0.6,
        gateReason: gateReasonCodeOf(undefined)
      };
      assert(shadowMarks.gateReason === GATE_REASON_CODES.none, 'no gate -> code 0');
      assert(gateReasonCodeOf('implicit-zero-advantage') === GATE_REASON_CODES['implicit-zero-advantage'], 'reason codes are stable');
      assert(gateReasonCodeOf('min-support') === 1, 'min-support is code 1');
      // The marks ride rewardSources (an open numeric record), so they
      // round-trip through the store untouched.
      return {
        marks: Object.keys(shadowMarks).length,
        retrieval: 'per record via rewardSources',
        gateClosed: 'strength still measured and attached'
      };
    }
  },
  {
    id: 'T8-R4b-default-assembly-shadow-records',
    section: 't8/R4',
    fn: async () => {
      // t8/R4 (验收: 默认装配下逐记录可取回强度): drive the REAL
      // recordOnlineExperience through the DEFAULT (shadow) assembly with a
      // minimal fake kernel, and assert every appended record carries the
      // decision triple AND the retrievable strength marks - with the gate
      // CLOSED (shadow never intercepts), the strength is still measured.
      const appended = [];
      const kernel = {
        config: {
          enabled: true,
          levels: ['meta', 'proposal'],
          gamma: 0.9,
          candidateCount: 3
        },
        store: {
          append: async (records) => {
            appended.push(...records);
          },
          query: async () => [],
          size: async () => 0
        },
        stepEvaluator: {
          evaluate: async () => []
        }
      };
      const minimal = {
        config: { probe: { maxConcurrentProbes: 1, probeTimeoutMs: 1000 } },
        memory: {},
        seams: {},
        policy: {},
        proposer: {},
        composer: {},
        reflector: {},
        scorer: {},
        taxonomy: {},
        dreamer: {},
        treePool: {},
        runBranch: async () => ({}),
        jitrl: kernel
        // No executionProfile: the constructor resolves the DEFAULT (shadow).
      };
      const orch = new EvoHarnessOrchestratorImpl(minimal);
      assert(orch.executionProfile.mode === 'shadow', 'default assembly is shadow');
      assert(orch.executionProfile.shadowRecords === true, 'shadow records are on');
      const trajectory = {
        id: 'traj-r4b',
        sessionId: 's',
        branchId: 'b',
        branchNamespace: 'ns',
        role: 'candidate',
        status: 'succeeded',
        patchId: 'p',
        patchOrigin: 'domain',
        surfaceKeys: [],
        startedAt: 0,
        endedAt: 10,
        metrics: { steps: 2, toolCalls: 1, toolErrors: 0, durationMs: 10 },
        steps: [],
        toolErrors: [],
        failureSignals: [],
        memoryRecallIds: [],
        deliverable: { content: 'x', format: 'text', contentHash: 'sha256:x' }
      };
      const l1State = { level: 'meta', bucket: 'b', tokens: ['t'], summary: '' };
      const diagnostics = [];
      const appendedCount = await orch.recordOnlineExperience({
        kernel,
        task: { id: 'task-r4b', prompt: 'p' },
        sessionId: 'sess-r4b',
        executed: [
          {
            round: 1,
            slotIndex: 0,
            slot: { slot: 'exploit', slotIndex: 0, branchId: 'br', guidance: 'memory' },
            l1State,
            nodeId: 'n1',
            parentNodeId: 'root',
            branchId: 'br',
            actionKey: 'slot:exploit',
            guidance: 'memory',
            trajectory,
            selection: {
              state: { level: 'proposal', bucket: 'b', tokens: ['t'], summary: '' },
              actionKey: 'patch:a',
              decisionId: 'jit-decision-r4b',
              chosenIndex: 1,
              offered: 3,
              priorIndex: 0,
              proposedIndex: 1,
              // Gate CLOSED (shadow): no gateReason, no exploration - but the
              // strength was still measured by selectProposal and attached.
              challenger: {
                nEff: 4.5,
                support: 6,
                shrunkAdvantage: 0.3,
                calibratedAdvantage: 0.6,
                implicitZeroAdvantage: false
              }
            }
          }
        ],
        reference: {
          ...trajectory,
          id: 'ref',
          role: 'reference',
          deliverable: undefined
        },
        selectedNodeId: 'n1',
        policyId: 'pi',
        runId: 'run-r4b',
        treeId: 'tree-1',
        round: 1,
        stage: () => undefined,
        diagnostics
      });
      assert(appendedCount > 0, 'records were appended in the default assembly');
      assert(appended.length === 2, 'L1 + L2 records (proposal selection present)');
      for (const rec of appended) {
        const sources = rec.rewardSources;
        assert(sources.decisionPriorIndex === 0, 'decision triple rides the record (prior)');
        assert(sources.decisionProposedIndex === 1, 'decision triple rides the record (proposed)');
        assert(sources.decisionExecutedIndex === 1, 'decision triple rides the record (executed)');
        // The strength marks: per-record retrieval without diagnostics.
        assert(sources.gateNeff === 4.5, 'gateNeff is retrievable per record');
        assert(sources.gateSupport === 6, 'gateSupport is retrievable per record');
        assert(
          Math.abs(sources.gateShrunkAdvantage - 0.3) < 1e-9,
          'gateShrunkAdvantage is retrievable per record'
        );
        assert(
          Math.abs(sources.gateCalibratedAdvantage - 0.6) < 1e-9,
          'gateCalibratedAdvantage is retrievable per record'
        );
        assert(sources.gateReason === GATE_REASON_CODES.none, 'gate closed -> numeric code 0');
        assert(rec.decisionMode === 'shadow', 'the declared mode stamps the record');
        assert(rec.learningTrack === 'process', 'the learning track is stamped (C2-pre)');
        assert(rec.rewardVersion === CURRENT_REWARD_VERSION, 'the r4 contract stamps the record');
      }
      return {
        records: appended.length,
        marksRetrievable: ['gateNeff', 'gateSupport', 'gateShrunkAdvantage', 'gateCalibratedAdvantage', 'gateReason'],
        mode: 'shadow (default assembly, gate closed)'
      };
    }
  },
  {
    id: 'T8-R5-exploration-budget',
    section: 't8/R5',
    fn: () => {
      // t8/R5 (ADR 0002 R5-6): grant/revoke/remaining are on the PUBLIC
      // orchestrator interface, the default allowance is 0, and the refund
      // accounting is idempotent per execution key (a re-entered recorder can
      // never double-refund one cancelled execution).
      const minimal = {
        config: { probe: { maxConcurrentProbes: 1, probeTimeoutMs: 1000 } },
        memory: {},
        seams: {},
        policy: {},
        proposer: {},
        composer: {},
        reflector: {},
        scorer: {},
        taxonomy: {},
        dreamer: {},
        treePool: {},
        runBranch: async () => ({})
      };
      const orch = new EvoHarnessOrchestratorImpl(JSON.parse(JSON.stringify(minimal)));
      assert(typeof orch.grantExplorationBudget === 'function', 'grant is public');
      assert(typeof orch.revokeExplorationBudget === 'function', 'revoke is public');
      assert(typeof orch.explorationBudgetRemaining === 'function', 'remaining is public');
      assert(orch.explorationBudgetRemaining() === 0, 'default allowance is 0 (fail-closed)');
      assert(orch.grantExplorationBudget(3) === 3, 'grant adds seats');
      assert(orch.grantExplorationBudget(-2) === 3, 'a negative grant is a no-op');
      orch.revokeExplorationBudget();
      assert(orch.explorationBudgetRemaining() === 0, 'revoke zeroes the allowance');
      // t10/COV: the dead non-idempotent settleExplorationReservation is gone.
      assert(
        typeof orch.settleExplorationReservation === 'undefined',
        'DEAD: the non-idempotent settleExplorationReservation no longer exists'
      );
      return {
        publicSurface: 'grant/revoke/remaining on EvoHarnessOrchestrator',
        defaultAllowance: 0,
        refund: 'idempotent per execution key (production path probed by T10-R5-refund)',
        deadMethodRemoved: true
      };
    }
  },
  {
    id: 'T8-V5b-no-trust-flip-calls',
    section: 't8/V5b',
    fn: () => {
      // t8/V5b (ADR 0002 5.2a-3): a static assertion that NO C0+C1 production
      // module can flip the trusted boundary - the registrar is gone, the
      // registry is a frozen empty set, and no call site mutates it.
      const sources = [
        'src/jitrl/step-evaluator.ts',
        'src/orchestrator.ts',
        'src/jitrl/reward-contract.ts',
        'src/jitrl/experience-store.ts',
        'src/jitrl/replacement-policy.ts',
        'src/runtime/execution-profile.ts'
      ];
      for (const rel of sources) {
        const text = readFileSync(REPO_ROOT + '/' + rel.split('/').join('/'), 'utf8');
        assert(
          text.indexOf('registerTrustedVerifierProducer') < 0,
          'V5b: no registrar exists in ' + rel
        );
        assert(
          text.indexOf('TRUSTED_VERIFIER_PRODUCERS.add') < 0,
          'V5b: no direct registry mutation in ' + rel
        );
        assert(
          text.indexOf('TRUSTED_VERIFIER_PRODUCERS.delete') < 0,
          'V5b: no registry removal in ' + rel
        );
      }
      // And the runtime boundary stays closed for every id any payload claims.
      for (const claimed of ['c2-future-verifier', 'host-verifier', 'anything']) {
        assert(
          hasTrustedVerificationProvenance({
            status: 'passed',
            verifierId: claimed,
            verifierVersion: '1.0.0',
            evidenceHash: 'sha256:' + claimed,
            checks: [{ id: 'c', passed: true }]
          }) === false,
          'V5b: no id establishes provenance this round: ' + claimed
        );
      }
      // t8/V5b evidence binding: even a hypothetical registered id must carry
      // a hash BOUND to the execution evidence (mismatch -> false). t10/COV:
      // the binding branch is now reached through the INJECTABLE producer seam
      // (caller-owned set data, not a global registrar) - the exact shape C2
      // will replace with the trusted service/receipt boundary.
      const hypotheticalProducers = new Set(['c2-hypothetical-verifier']);
      assert(
        hasTrustedVerificationProvenance(
          {
            status: 'passed',
            verifierId: 'c2-hypothetical-verifier',
            verifierVersion: '1',
            evidenceHash: 'sha256:not-the-execution-hash',
            checks: []
          },
          'sha256:the-execution-hash',
          hypotheticalProducers
        ) === false,
        'V5b: an unbound evidenceHash establishes nothing even from a caller-injected producer'
      );
      assert(
        hasTrustedVerificationProvenance(
          {
            status: 'passed',
            verifierId: 'c2-hypothetical-verifier',
            verifierVersion: '1',
            evidenceHash: 'sha256:the-execution-hash',
            checks: []
          },
          'sha256:the-execution-hash',
          hypotheticalProducers
        ) === true,
        'V5b: a bound hash from a caller-owned producer set establishes provenance for THAT caller'
      );
      // ...and the production path (no seam) stays closed for the same payload.
      assert(
        hasTrustedVerificationProvenance({
          status: 'passed',
          verifierId: 'c2-hypothetical-verifier',
          verifierVersion: '1',
          evidenceHash: 'sha256:the-execution-hash',
          checks: []
        }) === false,
        'V5b: the frozen default registry stays empty - production never trusts'
      );
      return {
        scanned: sources.length,
        registrarCalls: 0,
        registryMutationCalls: 0,
        evidenceBinding: 'required (mismatch rejects)'
      };
    }
  },
  {
    id: 'C1s-shadow-version-isolation',
    section: 'R3',
    fn: async () => {
      const store = createMemoryExperienceStore({ now: () => T0 + 1000 });
      await store.append([
        record({ id: 'old-r3', rewardVersion: PREVIOUS_REWARD_VERSION, value: 9 }),
        record({ id: 'cur-r4', rewardVersion: CURRENT_REWARD_VERSION, value: -1 })
      ]);
      const strict = await store.query({
        level: 'proposal',
        state: { level: 'proposal', bucket: 'b', tokens: ['t'], summary: '' },
        k: 10,
        similarityThreshold: 0,
        excludeLegacy: true,
        learningEligibleOnly: true
      });
      assert(
        strict.length === 1 && strict[0].record.id === 'cur-r4',
        'the r3 producer never enters the r4 neighbourhood'
      );
      assert(REWARD_CONTRACT.version === 'r4/verifier-first-v1', 'the contract id is the preregistered r4');
      assert(CURRENT_REWARD_VERSION === REWARD_CONTRACT.version, 'the persisted marker points at the contract');
      return {
        visible: strict.map((entry) => entry.record.id),
        contractId: REWARD_CONTRACT.version
      };
    }
  },
  {
    id: 'C1r-rollback-rebuild',
    section: 'R3 5.3',
    fn: async () => {
      assert(
        requiresExperienceRebuild(PREVIOUS_REWARD_VERSION, CURRENT_REWARD_VERSION) === true,
        'the r3 -> r4 switch is a rebuild, not a reinterpretation'
      );
      const source = [
        record({ id: 'keep-r4', rewardVersion: CURRENT_REWARD_VERSION }),
        record({ id: 'old-r3', rewardVersion: PREVIOUS_REWARD_VERSION })
      ];
      const before = JSON.stringify(source);
      const plan = await migrateExperienceRecords({ records: source });
      assert(plan.rewardVersionIsolated === 1, 'the r3 record is version-isolated');
      assert(plan.marked.length === 1 && plan.marked[0].id === 'old-r3', 'a marked audit copy is planned');
      assert(
        plan.marked[0].rewardVersion === 'legacy' && plan.marked[0].learningEligible === false,
        'the marked copy is audit-only'
      );
      assert(JSON.stringify(source) === before, 'the source log was never rewritten in place');
      return { isolated: plan.rewardVersionIsolated, marked: plan.marked.length, sourceUntouched: true };
    }
  },
  {
    id: 'R8-explicit-fields',
    section: 'R8',
    fn: async () => {
      const store = createMemoryExperienceStore({ now: () => T0 + 1000 });
      await store.append([
        record({
          id: 'stamped',
          decisionMode: 'shadow',
          actionKeyVocabulary: 'signature'
        })
      ]);
      const queried = await store.query({
        level: 'proposal',
        state: { level: 'proposal', bucket: 'b', tokens: ['t'], summary: '' },
        k: 5,
        similarityThreshold: 0
      });
      const stamped = queried[0]?.record;
      assert(
        stamped?.decisionMode === 'shadow' && stamped?.actionKeyVocabulary === 'signature',
        'the declared fields round-trip'
      );
      let rejected = false;
      try {
        await store.append([record({ id: 'typo', decisionMode: 'yolo' })]);
      } catch {
        rejected = true;
      }
      assert(rejected === true, 'an unknown decisionMode is rejected, never guessed');
      return { roundTrip: true, typoRejected: true };
    }
  },
  {
    id: 'F3-verifier-first-scale',
    section: 'R3 5.1',
    fn: () => {
      const wrong = scoreUnderRewardContract(
        trajectory({
          status: 'failed',
          metrics: { steps: 1, toolCalls: 1, toolErrors: 0, durationMs: 1 },
          deliverable: { content: 'wrong', format: 'text' },
          metadata: {
            verification: {
              status: 'failed',
              verifierId: 'v',
              verifierVersion: '1',
              evidenceHash: 'h',
              checks: [{ id: 'c', passed: false }]
            }
          }
        })
      );
      assert(wrong.reward <= 0, 'a refuted result can never score positive');
      assert(
        wrong.executionSuccess === false && wrong.taskSuccess === false,
        'execution and task success stay separated'
      );
      assert(REWARD_CONTRACT.aggregation === 'trajectory-signals-v1', 'the aggregation is frozen');
      return { refutedReward: wrong.reward, aggregation: REWARD_CONTRACT.aggregation };
    }
  },
  {
    id: 'T10-R2b-memory-denied-zero-bridge-calls',
    section: 't10/R2',
    fn: async () => {
      // t12/R2-residual (t11 BLOCKER): the t10 probe asserted the opposite -
      // that the governed commit STILL ran (committed === 1, "one commit write
      // happened") with the scope renamed to 'e2e-ephemeral-*'. That pinned the
      // defect: the plugin issued a real write request under a denied
      // permission and only the hosted bridge's scope check refused it; an
      // injected bridge that accepts any scope (deps.memory is a public seam)
      // persisted it. The contract now: a denied permission means the memory
      // bridge is NOT CALLED AT ALL - by the hand-built default and by every
      // resolved mode - and the diagnostic says exactly that.
      const lesson = {
        id: 'lesson-t12-r2',
        title: 't',
        whenToApply: ['w'],
        subFunctions: ['g'],
        executionPatch: { summary: 's' },
        verificationEvidence: { candidateSuccess: 'c' },
        whenNotToApply: ['n'],
        polarity: 'positive',
        visibility: 'session',
        sessionId: 'sess-real',
        confidence: 0.6
      };
      const acceptingBridge = (calls) => ({
        commit: async (l, o) => {
          calls.push('commit:' + l.id + ':' + String(o.scope.sessionId));
          return {
            accepted: true,
            persisted: true,
            lessonId: l.id,
            namespace: 'accept-any-scope',
            driverKind: 'vector_fact',
            violations: [],
            at: 0
          };
        },
        promote: async (l) => {
          calls.push('promote:' + l.id);
          return {
            accepted: true,
            persisted: true,
            lessonId: l.id,
            namespace: 'accept-any-scope-global',
            driverKind: 'vector_fact',
            violations: [],
            at: 0
          };
        },
        descriptor: { driverKind: 'vector_fact' }
      });
      const baseDeps = (calls, overrides) => ({
        config: {
          probe: { maxConcurrentProbes: 1, probeTimeoutMs: 1000 },
          memoryBridge: { promoteOnComposeSuccess: true }
        },
        memory: acceptingBridge(calls),
        seams: {},
        policy: { policy: { version: 1 } },
        proposer: {},
        composer: {},
        reflector: {},
        scorer: {},
        taxonomy: {},
        dreamer: {},
        treePool: {},
        runBranch: async () => ({}),
        ...overrides
      });
      const assemblies = [{ label: 'hand-built default (no executionProfile)', overrides: {} }].concat(
        ['baseline', 'shadow', 'guarded-active', 'off'].map((mode) => ({
          label: 'executionProfile mode=' + mode,
          overrides: { executionProfile: resolveExecutionProfile({ mode }) }
        }))
      );
      const denied = [];
      for (const assembly of assemblies) {
        const calls = [];
        const orch = new EvoHarnessOrchestratorImpl(baseDeps(calls, assembly.overrides));
        const diagnostics = [];
        const committed = await orch.commitLessons(
          [lesson],
          { kind: 'session', sessionId: 'sess-real' },
          diagnostics
        );
        const text = diagnostics.join(' ');
        assert(committed === 0, assembly.label + ': nothing may report as committed');
        assert(
          calls.length === 0,
          assembly.label + ': the memory bridge was called under a denied permission -> ' + JSON.stringify(calls)
        );
        assert(
          text.includes('NOT committed'),
          assembly.label + ': the diagnostic must say the commit did not happen'
        );
        assert(
          text.includes('bridge was not called'),
          assembly.label + ': the diagnostic must say the bridge was not called'
        );
        assert(
          !text.includes('ephemeral'),
          assembly.label + ': no renamed scratch namespace may appear in a denial path'
        );
        denied.push(assembly.label + ' -> 0 call(s)');
      }
      // Positive control (explicit TEST authorization): with the permission
      // explicitly granted the machinery is intact, and the REAL governed
      // session scope - not a renamed one - reaches the bridge.
      const grantedCalls = [];
      const granted = new EvoHarnessOrchestratorImpl(
        baseDeps(grantedCalls, {
          executionProfile: resolveExecutionProfile({ memoryRealWrites: true })
        })
      );
      const grantedDiagnostics = [];
      const grantedCommitted = await granted.commitLessons(
        [lesson],
        { kind: 'session', sessionId: 'sess-real' },
        grantedDiagnostics
      );
      assert(grantedCommitted === 1, 'the explicit memory override still commits (machinery intact)');
      assert(
        JSON.stringify(grantedCalls) ===
          JSON.stringify(['commit:lesson-t12-r2:sess-real', 'promote:lesson-t12-r2']),
        'the granted assembly drives commit+promote through the real governed scope, got ' +
          JSON.stringify(grantedCalls)
      );
      return {
        deniedAssemblies: denied,
        bridgeCallsUnderDeny: 0,
        grantedAssembly: grantedCalls,
        promoted: grantedDiagnostics.join(' ').includes('promoted lesson lesson-t12-r2 to global scope')
      };
    }
  },
  {
    id: 'T10-R2c-no-config-shape-grants-memory',
    section: 't10/R2',
    fn: () => {
      // t10/R2 negative regression (t12 tightened): no config shape can produce
      // an allowed memory permission. The only grant is explicit profile INPUT
      // data (the test assemblies); a static scan pins that no production
      // module ever constructs that input.
      for (const mode of ['baseline', 'shadow', 'guarded-active', 'off']) {
        const profile = resolveExecutionProfile({ mode });
        assert(profile.permissions.memory.allowed === false, 'memory denied in ' + mode);
      }
      const override = resolveExecutionProfile({ memoryRealWrites: true });
      assert(override.permissions.memory.allowed === true, 'the explicit override grants');
      assert(
        override.permissions.memory.reason.includes('memoryRealWrites'),
        'the grant reason names the explicit override (visible, auditable)'
      );
      const productionModules = [
        'src/index.ts',
        'src/config.ts',
        'src/orchestrator.ts'
      ];
      for (const relative of productionModules) {
        const text = readFileSync(REPO_ROOT + '/' + relative, 'utf8');
        assert(
          !/memoryRealWrites\s*:/.test(text),
          relative + ' must never construct a memoryRealWrites profile input (production stays denied)'
        );
      }
      return {
        fourModesDenied: true,
        overrideIsProfileDataOnly: 'no config field produces a memory-allowed profile',
        productionModulesScanned: productionModules.length
      };
    }
  },
  {
    id: 'T10-R5-refund-real-recorder',
    section: 't10/COV',
    fn: async () => {
      // t10/COV (t9 finding on T8-R5): the refund assertion now drives the
      // PRODUCTION recorder path - grant -> exploration-tagged deviation ->
      // aborted execution -> refund via recordOnlineExperience + the
      // releasedReservationKeys idempotency ledger.
      const kernel = {
        config: { enabled: true, levels: ['meta', 'proposal'], gamma: 0.9, candidateCount: 3 },
        store: {
          append: async () => undefined,
          query: async () => [],
          size: async () => 0
        },
        stepEvaluator: { evaluate: async () => [] }
      };
      const orch = new EvoHarnessOrchestratorImpl({
        config: { probe: { maxConcurrentProbes: 1, probeTimeoutMs: 1000 } },
        memory: {},
        seams: {},
        policy: { policy: { version: 1 } },
        proposer: {},
        composer: {},
        reflector: {},
        scorer: {},
        taxonomy: {},
        dreamer: {},
        treePool: {},
        runBranch: async () => ({}),
        jitrl: kernel,
        executionProfile: resolveExecutionProfile({ mode: 'guarded-active' })
      });
      const internals = orch;
      assert(orch.grantExplorationBudget(1) === 1, 'one seat granted');
      const trajectory = {
        id: 'traj-refund-real',
        sessionId: 's',
        branchId: 'b',
        branchNamespace: 'ns',
        role: 'candidate',
        status: 'aborted',
        patchId: 'p',
        patchOrigin: 'domain',
        surfaceKeys: [],
        startedAt: 0,
        endedAt: 10,
        metrics: { steps: 2, toolCalls: 1, toolErrors: 0, durationMs: 10 },
        steps: [],
        toolErrors: [],
        failureSignals: [],
        memoryRecallIds: []
      };
      const recorderInput = {
        kernel,
        task: { id: 'task-refund', prompt: 'p' },
        sessionId: 'sess-refund',
        executed: [
          {
            round: 1,
            slotIndex: 0,
            slot: { slot: 'exploit', slotIndex: 0, branchId: 'br', guidance: 'memory' },
            l1State: { level: 'meta', bucket: 'b', tokens: ['t'], summary: '' },
            nodeId: 'n1',
            parentNodeId: 'root',
            branchId: 'br',
            actionKey: 'slot:exploit',
            guidance: 'memory',
            trajectory,
            selection: {
              state: { level: 'proposal', bucket: 'b', tokens: ['t'], summary: '' },
              actionKey: 'patch:a',
              decisionId: 'jit-decision-refund',
              chosenIndex: 1,
              offered: 2,
              priorIndex: 0,
              proposedIndex: 1,
              exploration: true,
              challenger: {
                nEff: 1.2,
                support: 1,
                shrunkAdvantage: 0.2,
                calibratedAdvantage: 0.4,
                implicitZeroAdvantage: false
              }
            }
          }
        ],
        reference: { ...trajectory, id: 'ref', role: 'reference' },
        selectedNodeId: 'n1',
        policyId: 'pi',
        runId: 'run-refund',
        treeId: 'tree-1',
        round: 1,
        stage: () => undefined,
        diagnostics: []
      };
      await internals.recordOnlineExperience(recorderInput);
      assert(internals.explorationAllowance === 2, 'the aborted execution refunded its seat (production path)');
      // Idempotency: re-running the recorder for the same trajectory must NOT
      // refund again (the releasedReservationKeys ledger remembers the key).
      await internals.recordOnlineExperience({ ...recorderInput, executed: [], runId: 'run-refund-2' });
      assert(
        internals.explorationAllowance === 2,
        'the same execution never refunds twice (idempotent per execution key)'
      );
      return {
        grant: 1,
        refundedVia: 'recordOnlineExperience + releasedReservationKeys',
        idempotent: true
      };
    }
  },
  {
    id: 'T10-R3b-replay-declarations-production',
    section: 't10/R3b',
    fn: async () => {
      // t10/R3b (t9 finding: capability-only) + t12/R3b2 (t11 HIGH finding): the
      // PRODUCTION replay path must consume the CALLER-declared declarations.
      // The t10 probe asserted a tautology (neighborCount is zero OR positive)
      // with a no-argument factory, which is exactly why the overwrite defect
      // passed review. This drives the real factory with two declarations over
      // the SAME pools and asserts DIRECTION, using the record returns as
      // fingerprints.
      const { createJitRl } = await import('../../src/jitrl/index.ts');
      const { parseEvoHarnessConfig } = await import('../../src/config.ts');
      const config = parseEvoHarnessConfig({ jitrl: { enabled: true, levels: ['meta'] } });
      const kernel = createJitRl({ config, now: () => T0 });
      const defaultHook = kernel.createReplayHook();
      const declaredHook = kernel.createReplayHook({
        replayDeclarations: { decisionMode: 'guarded-active', actionKeyVocabulary: 'signature' }
      });
      // The hook derives its state from the frontier, so the fixtures carry the
      // IDENTICAL abstract state (same task id/round/slot). Otherwise nobody
      // has a neighbour and every assertion is vacuous - the t10 blind spot.
      const replayState = abstractMetaState({
        task: { id: 'tree-r3b', prompt: '' },
        round: 0,
        parentDepth: 0,
        parentSlot: 'exploit',
        memoryConfidence: 0,
        referenceStatus: 'missing'
      });
      const mk = (id, mode, value) =>
        record({
          id,
          level: 'meta',
          state: replayState,
          actionKey: 'slot:exploit',
          reward: value,
          return: value,
          rewardVersion: CURRENT_REWARD_VERSION,
          experienceSchemaVersion: EXPERIENCE_SCHEMA_VERSION,
          learningEligible: true,
          ...(mode === undefined
            ? {}
            : { decisionMode: mode, actionKeyVocabulary: 'signature' })
        });
      const shadow = mk('decl-shadow', 'shadow', 5);
      const guarded = mk('decl-guarded', 'guarded-active', -5);
      const undeclared = mk('decl-undeclared', undefined, 9);
      const base = {
        treeId: 'tree-r3b',
        policyId: 'pi',
        rho: 0.5,
        slotWeights: { exploit: 0.25, explore_domain: 0.25, explore_invariant: 0.25, recover: 0.25 },
        frontier: {
          nodeId: 'n',
          depth: 0,
          slot: 'exploit',
          guidance: 'memory',
          status: 'succeeded',
          score: 1,
          createdAt: T0
        },
        jit: { beta: 1, lambda: 0, alpha: 0.1, k: 8, gamma: 0.9, similarityThreshold: 0 },
        experiences: []
      };
      // Forward: the default shadow/signature declaration accepts the shadow
      // record and rejects the guarded-active one.
      const shadowOnlyDefault = defaultHook({ ...base, experiences: [shadow] });
      assert(
        shadowOnlyDefault.diagnostics.neighborCount > 0,
        'the default shadow/signature declaration must see the shadow record'
      );
      assert(
        defaultHook({ ...base, experiences: [guarded] }).diagnostics.neighborCount === 0,
        'a guarded-active record never enters a shadow-declared neighbourhood'
      );
      // Reverse (t12/R3b2): the caller-declared guarded-active partition is the
      // mirror image. Before the fix the caller option was overwritten by the
      // factory default and this assertion failed (neighborCount 0).
      const guardedOnlyDeclared = declaredHook({ ...base, experiences: [guarded] });
      assert(
        guardedOnlyDeclared.diagnostics.neighborCount > 0,
        'the CALLER-declared guarded-active partition must see the guarded-active record'
      );
      assert(
        declaredHook({ ...base, experiences: [shadow] }).diagnostics.neighborCount === 0,
        'the caller-declared guarded-active partition must reject the shadow record'
      );
      // Mixed pool: the declaration decides WHICH record is the evidence. The
      // return fingerprints +5 (shadow) / -5 (guarded-active) make the choice
      // observable; before the fix both calls read the shadow record.
      const mixedDefault = defaultHook({ ...base, experiences: [shadow, guarded] });
      const mixedDeclared = declaredHook({ ...base, experiences: [shadow, guarded] });
      assert(
        Math.abs(mixedDefault.diagnostics.stateValue - 5) < 1e-6,
        'the default declaration reads the shadow record, got ' + String(mixedDefault.diagnostics.stateValue)
      );
      assert(
        Math.abs(mixedDeclared.diagnostics.stateValue + 5) < 1e-6,
        'the caller declaration reads the guarded-active record, got ' + String(mixedDeclared.diagnostics.stateValue)
      );
      // Fail-closed: undeclared producers (host_tool / backfill) are excluded
      // under BOTH declarations and are never re-stamped to the current mode.
      assert(
        defaultHook({ ...base, experiences: [undeclared] }).diagnostics.neighborCount === 0,
        'an undeclared record never enters a declared neighbourhood (default)'
      );
      assert(
        declaredHook({ ...base, experiences: [undeclared] }).diagnostics.neighborCount === 0,
        'an undeclared record never enters a declared neighbourhood (caller-declared)'
      );
      return {
        productionHookWired: true,
        defaultDeclarations: 'shadow/signature (the current producer stamps)',
        callerDeclarationWins: true,
        mixedPoolStateValue: {
          default: mixedDefault.diagnostics.stateValue,
          callerDeclared: mixedDeclared.diagnostics.stateValue
        },
        undeclaredExcluded: true
      };
    }
  },
];

export async function runGuardedRegression() {
  const probes = [];
  for (const { id, section, fn } of PROBES) {
    try {
      const detail = await fn();
      probes.push({ id, section, status: 'passed', ...(detail === undefined ? {} : { detail }) });
    } catch (error) {
      probes.push({
        id,
        section,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const failed = probes.filter((entry) => entry.status === 'failed').length;
  return {
    harness: 'dsh-plugin-evo-harness guarded regression (P6.2 C0+C1, ADR 0002/t6)',
    rewardVersion: REWARD_CONTRACT.version,
    c2PreMarker: 'r4 without trusted producers = conservative isolation (ADR 0002 5.4)',
    summary: {
      total: probes.length,
      passed: probes.length - failed,
      failed
    },
    sections: [...new Set(probes.map((entry) => entry.section))],
    probes,
    boundaries: [
      'no real model call, no paid API, no publish, no real memory write (R0/R2)',
      't7/V5: the trusted-producer registrar was removed - no id can be promoted this round (C2 delivers a trusted service/receipt boundary)',
      'this regression is the gate witness, not a claim of real-world benefit (R6/D4)'
    ]
  };
}
`;

// ---------------------------------------------------------------------------
// bundle the probe source with the repo's own esbuild (in-memory, temp file)
// ---------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), 'dsh-guarded-'));
const outfile = join(scratch, 'probes.mjs');
try {
  await build({
    stdin: {
      contents: PROBE_SOURCE,
      resolveDir: HERE,
      sourcefile: 'guarded-regression-probes.ts',
      loader: 'ts'
    },
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    packages: 'external',
    sourcemap: 'inline',
    legalComments: 'none',
    logLevel: 'silent'
  });
  const lib = await import(pathToFileURL(outfile).href);
  const report = await lib.runGuardedRegression();

  const json = process.argv.includes('--json');
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const probe of report.probes) {
      const head = probe.status === 'passed' ? 'PASS' : 'FAIL';
      const tail = probe.error === undefined ? '' : ' - ' + probe.error;
      console.log(head + ' [' + probe.section + '] ' + probe.id + tail);
    }
    console.log('');
    console.log(report.summary.passed + '/' + report.summary.total + ' probes passed');
  }
  process.exitCode = report.summary.failed === 0 ? 0 : 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

