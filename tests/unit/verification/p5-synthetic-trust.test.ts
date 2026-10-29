/**
 * P5: the offline synthetic-test trust layer `synthesized-tests/v1`.
 *
 * The layer exists to keep two questions apart, structurally:
 *
 *   EXECUTION TRUST  did the host runner execute the exact frozen test content?
 *   CONTENT TRUST    did the test content earn trust (frozen before candidates,
 *                    calibrated on labelled development cases, provenance clean,
 *                    generator/candidate isolated, holdout not leaked)?
 *
 * The legal state "execution verified, content uncalibrated" is a typed witness
 * (ExecutionTrustedContentUntrusted), and NO combination of the two trusts may
 * enter the task-quality track in v1.
 *
 * The historical anchor throughout is the first harmful deviation of the offline
 * negative result: (task ci-04, run 2, round 2), baseline chose `noop` with
 * support 0, coverage 1.000 -> 0.667. The case EXISTS and is referenced
 * (docs/reports/p61-eval-negative-result-explanation.md); this layer never claims
 * otherwise - it diagnoses a test frozen from that behaviour and keeps it out of
 * the trusted set.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LEARNING_TRACKS } from '../../../src/types/contracts';
import {
  SYNTHESIZED_TESTS_LAYER,
  SYNTHETIC_AUDIT_ONLY,
  SYNTHETIC_TASK_QUALITY_ELIGIBLE,
  SYNTHETIC_TEST_LABELS,
  SYNTHETIC_TEST_SOURCES,
  SYNTHETIC_TEST_REASON_CODES,
  DEFAULT_SYNTHETIC_CALIBRATION_THRESHOLDS,
  DEFAULT_SYNTHETIC_TEST_TRUST_POLICY,
  canonicalJson,
  syntheticDigest,
  isSyntheticDigest,
  computeSyntheticCaseDigest,
  computeSyntheticSuiteContentDigest,
  computeSyntheticTestSetDigest,
  computeSyntheticReceiptDigest,
  freezeSyntheticTestSuite,
  recomputeFrozenSuiteDigests,
  verifyFrozenSyntheticSuite,
  assertFrozenBeforeCandidateGeneration,
  checkGeneratorCandidateIsolation,
  checkSyntheticHoldoutFirewall,
  verifySyntheticTestReceipt,
  diagnoseBaselineFrozenCase,
  diagnoseBaselineFrozenCases,
  calibrateSyntheticTestSuite,
  assessSyntheticTestResult,
  isExecutionTrustedContentUntrusted,
  gateSyntheticResultForTaskQuality,
  createSyntheticTestTrustLayer,
  type FrozenSyntheticTestSuite,
  type SyntheticAssessmentInput,
  type SyntheticCalibrationReport,
  type SyntheticCandidateIdentity,
  type SyntheticCaseRunResult,
  type SyntheticTestCase,
  type SyntheticTestReceipt,
  type SyntheticTestSuiteDraft
} from '../../../src/verification/synthesized-tests';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const FIXTURE_DIR = path.join(repoRoot, 'tests/fixtures/p5-synth');

function readFixture<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8')) as T;
}

type SuiteFixture = SyntheticTestSuiteDraft & { readonly frozenAt: number };

function freezeFixture(): FrozenSyntheticTestSuite {
  const fixture = readFixture<SuiteFixture>('p5-synth-suite.json');
  return freezeSyntheticTestSuite(fixture, { now: fixture.frozenAt });
}

const SUITE = freezeFixture();
const DEV_CASES = SUITE.cases.filter((entry) => (SUITE.split?.development ?? []).includes(entry.id));

/** Development-only run results: the calibrated picture (1 miss, 0 false alarms). */
function developmentResults(): SyntheticCaseRunResult[] {
  return DEV_CASES.map((entry) => ({
    caseId: entry.id,
    outcome:
      entry.source === 'baseline-frozen'
        ? 'passed'
        : entry.label === 'bug-present' && entry.id !== 'p5-case-p6'
          ? 'failed'
          : 'passed'
  }));
}

/** Development results for a suite that does NOT calibrate (2 misses, 2 false alarms). */
function failingDevelopmentResults(): SyntheticCaseRunResult[] {
  return DEV_CASES.map((entry) => ({
    caseId: entry.id,
    outcome:
      entry.label === 'bug-present'
        ? entry.id === 'p5-case-p5' || entry.id === 'p5-case-p6'
          ? 'passed'
          : 'failed'
        : entry.id === 'p5-case-a3' || entry.id === 'p5-case-a4'
          ? 'failed'
          : 'passed'
  }));
}

function makeReceipt(suite: FrozenSyntheticTestSuite, allPassed: boolean): SyntheticTestReceipt {
  const caseIds = [...(suite.split?.development ?? suite.cases.map((entry) => entry.id))].sort();
  const results = caseIds.map((caseId) => ({
    caseId,
    status: allPassed ? ('passed' as const) : ('failed' as const),
    checks: [{ id: 'deterministic-check', passed: allPassed }]
  }));
  const status = results.some((entry) => entry.status === 'failed') ? 'failed' : 'passed';
  const base: Omit<SyntheticTestReceipt, 'receiptDigest'> = {
    layer: SYNTHESIZED_TESTS_LAYER,
    testSetDigest: suite.testSetDigest,
    scope: 'development',
    caseIds,
    runId: 'run-p5-contract',
    verifierId: 'host-runner-p5',
    verifierVersion: '1.0.0',
    executedAt: suite.frozenAt + 1000,
    status,
    results
  };
  return { ...base, receiptDigest: computeSyntheticReceiptDigest(base) };
}

const CLEAN_CANDIDATE: SyntheticCandidateIdentity = {
  id: 'candidate-p5-clean',
  generatorId: 'candidate-model-x',
  createdAt: 1730000001000
};

function calibratedReport(): SyntheticCalibrationReport {
  return calibrateSyntheticTestSuite({
    suite: SUITE,
    results: developmentResults(),
    now: SUITE.frozenAt
  });
}

describe('P5 trust layer: identity, independence, and the frozen online vocabulary', () => {
  it('does not extend LEARNING_TRACKS (the frozen online learning-track enum)', () => {
    expect([...LEARNING_TRACKS]).toEqual(['task-quality', 'process']);
    expect((LEARNING_TRACKS as readonly string[]).includes(SYNTHESIZED_TESTS_LAYER)).toBe(false);
  });

  it('is audit-only by construction and never task-quality eligible', () => {
    expect(SYNTHETIC_AUDIT_ONLY).toBe(true);
    expect(SYNTHETIC_TASK_QUALITY_ELIGIBLE).toBe(false);
  });

  it('exposes a bounded reason vocabulary with no success code', () => {
    expect(SYNTHETIC_TEST_REASON_CODES.length).toBeGreaterThan(10);
    expect((SYNTHETIC_TEST_REASON_CODES as readonly string[]).includes('attached')).toBe(false);
    expect(new Set(SYNTHETIC_TEST_REASON_CODES).size).toBe(SYNTHETIC_TEST_REASON_CODES.length);
  });

  it('declares both label and source vocabularies explicitly', () => {
    expect([...SYNTHETIC_TEST_LABELS]).toEqual(['bug-present', 'bug-absent']);
    expect([...SYNTHETIC_TEST_SOURCES]).toEqual(['spec-derived', 'mutation-derived', 'baseline-frozen']);
  });

  it('is not imported by ANY production source file (default behaviour is unchanged)', () => {
    const offences: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.ts')) {
          const content = fs.readFileSync(full, 'utf8');
          if (/from\s+['"][^'"]*synthesized-tests['"]/.test(content)) {
            offences.push(path.relative(repoRoot, full).replace(/\\/g, '/'));
          }
        }
      }
    };
    walk(path.join(repoRoot, 'src'));
    expect(offences).toEqual([]);
    const index = fs.readFileSync(path.join(repoRoot, 'src/index.ts'), 'utf8');
    expect(index.includes('createSyntheticTestTrustLayer')).toBe(false);
  });
});

describe('P5 trust layer: canonical digests and content freezing', () => {
  it('canonical JSON is key-order independent but array-order preserving', () => {
    expect(canonicalJson({ b: 1, a: [1, 2] })).toBe(canonicalJson({ a: [1, 2], b: 1 }));
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }));
    expect(canonicalJson({ b: undefined, a: null })).toBe('{"a":null,"b":null}');
  });

  it('digests are sha256:<64 hex> and deterministic', () => {
    const digest = syntheticDigest('framing', { a: 1 });
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(isSyntheticDigest(digest)).toBe(true);
    expect(isSyntheticDigest('sha256:abc')).toBe(false);
    expect(syntheticDigest('framing', { a: 1 })).toBe(digest);
    expect(syntheticDigest('other-framing', { a: 1 })).not.toBe(digest);
  });

  it('freezes deterministically and pins the fixture digest', () => {
    expect(SUITE.testSetDigest).toBe(
      'sha256:25dd1215f7d2bbf8572d930d96d57c55c939a89416235f1df1793020964136e6'
    );
    expect(SUITE.contentDigest).toBe(
      'sha256:6d2c623a9ad7154e258fe5c15c0dd620c3a69f1eb95a1bbdbe571b1d55e32ed1'
    );
    const again = freezeFixture();
    expect(again.testSetDigest).toBe(SUITE.testSetDigest);
    expect(again.contentDigest).toBe(SUITE.contentDigest);
    expect(recomputeFrozenSuiteDigests(SUITE)).toEqual({
      contentDigest: SUITE.contentDigest,
      testSetDigest: SUITE.testSetDigest
    });
    expect(Object.keys(SUITE.caseDigests).sort()).toEqual(SUITE.cases.map((entry) => entry.id).sort());
  });

  it('re-freezing the SAME content at a different instant changes the seal but not the content digest', () => {
    const fixture = readFixture<SuiteFixture>('p5-synth-suite.json');
    const later = freezeSyntheticTestSuite(fixture, { now: fixture.frozenAt + 1 });
    expect(later.contentDigest).toBe(SUITE.contentDigest);
    expect(later.testSetDigest).not.toBe(SUITE.testSetDigest);
  });

  it('a changed expectation changes both digests (the seal is content-sensitive)', () => {
    const fixture = readFixture<SuiteFixture>('p5-synth-suite.json');
    const mutated: SuiteFixture = {
      ...fixture,
      cases: fixture.cases.map((entry) =>
        entry.id === 'p5-case-p1'
          ? { ...entry, expectation: { kind: 'passes', detail: 'tampered expectation' } }
          : entry
      )
    };
    const frozen = freezeSyntheticTestSuite(mutated, { now: fixture.frozenAt });
    expect(frozen.contentDigest).not.toBe(SUITE.contentDigest);
    expect(frozen.testSetDigest).not.toBe(SUITE.testSetDigest);
  });

  it('fails closed on malformed suites', () => {
    const fixture = readFixture<SuiteFixture>('p5-synth-suite.json');
    const duplicate = { ...fixture, cases: [...fixture.cases, fixture.cases[0]!] };
    expect(() => freezeSyntheticTestSuite(duplicate, { now: fixture.frozenAt })).toThrow(/duplicate case id/);

    const unknownLabel = { ...fixture, cases: [{ ...fixture.cases[0]!, label: 'bug-maybe' }] } as unknown as SuiteFixture;
    expect(() => freezeSyntheticTestSuite(unknownLabel, { now: fixture.frozenAt })).toThrow(/unknown label/);

    const baselineWithoutEvidence = {
      ...fixture,
      cases: [{ ...fixture.cases[0]!, source: 'baseline-frozen' }]
    } as unknown as SuiteFixture;
    expect(() => freezeSyntheticTestSuite(baselineWithoutEvidence, { now: fixture.frozenAt })).toThrow(
      /needs a baselineObservation/
    );

    const specWithEvidence = {
      ...fixture,
      cases: [
        {
          ...fixture.cases[0]!,
          source: 'spec-derived',
          baselineObservation: {
            taskId: 'ci-04',
            run: 2,
            round: 2,
            actionKey: 'noop',
            support: 0,
            advantage: 0,
            observedCoverage: 0.5,
            priorCoverage: 1
          }
        }
      ]
    } as unknown as SuiteFixture;
    expect(() => freezeSyntheticTestSuite(specWithEvidence, { now: fixture.frozenAt })).toThrow(
      /carries a baselineObservation/
    );

    const overlappingSplit = {
      ...fixture,
      split: { development: ['p5-case-p1'], holdout: ['p5-case-p1'] }
    };
    expect(() => freezeSyntheticTestSuite(overlappingSplit, { now: fixture.frozenAt })).toThrow(
      /both sides of the split/
    );

    const incompleteSplit = { ...fixture, split: { development: ['p5-case-p1'], holdout: [] } };
    expect(() => freezeSyntheticTestSuite(incompleteSplit, { now: fixture.frozenAt })).toThrow(
      /cover every case exactly once/
    );
  });

  it('detects tampering with a frozen case or the declared seal', () => {
    expect(verifyFrozenSyntheticSuite(SUITE).ok).toBe(true);

    const tamperedCase: FrozenSyntheticTestSuite = {
      ...SUITE,
      cases: SUITE.cases.map((entry) =>
        entry.id === 'p5-case-a1'
          ? { ...entry, expectation: { kind: 'fails', detail: 'tampered after freeze' } }
          : entry
      )
    };
    const caseCheck = verifyFrozenSyntheticSuite(tamperedCase);
    expect(caseCheck.ok).toBe(false);
    expect(caseCheck.violations.some((violation) => violation.kind === 'digest-mismatch')).toBe(true);

    const tamperedSeal: FrozenSyntheticTestSuite = { ...SUITE, testSetDigest: 'sha256:' + '0'.repeat(64) };
    expect(verifyFrozenSyntheticSuite(tamperedSeal).ok).toBe(false);

    const wrongLayer = { ...SUITE, layer: 'synthesized-tests/v0' } as unknown as FrozenSyntheticTestSuite;
    expect(verifyFrozenSyntheticSuite(wrongLayer).violations[0]?.kind).toBe('layer-mismatch');
  });

  it('rejects a malformed content digest at seal time', () => {
    expect(() => computeSyntheticTestSetDigest('not-a-digest', 1)).toThrow(/contentDigest must be sha256/);
    expect(() => computeSyntheticTestSetDigest(SUITE.contentDigest, Number.NaN)).toThrow(/frozenAt must be finite/);
  });
});

describe('P5 trust layer: frozen BEFORE candidates, generator/candidate isolation', () => {
  it('accepts candidates created after the freeze seal', () => {
    const result = assertFrozenBeforeCandidateGeneration(SUITE, [CLEAN_CANDIDATE]);
    expect(result.ok).toBe(true);
  });

  it('rejects a candidate that predates the freeze seal (the suite may be fitted to it)', () => {
    const early: SyntheticCandidateIdentity = { ...CLEAN_CANDIDATE, createdAt: SUITE.frozenAt - 1 };
    const result = assertFrozenBeforeCandidateGeneration(SUITE, [early]);
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.kind).toBe('not-frozen-before-candidates');
  });

  it('rejects a non-finite candidate timestamp (cannot be ordered against the seal)', () => {
    const malformed: SyntheticCandidateIdentity = { ...CLEAN_CANDIDATE, createdAt: Number.NaN };
    const result = assertFrozenBeforeCandidateGeneration(SUITE, [malformed]);
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.kind).toBe('not-frozen-before-candidates');
    expect(result.violations[0]?.detail).toContain('not finite');
  });

  it('rejects a case authored by the candidate under evaluation', () => {
    const fixture = readFixture<SuiteFixture>('p5-synth-suite.json');
    const authored: SuiteFixture = {
      ...fixture,
      cases: fixture.cases.map((entry) =>
        entry.id === 'p5-case-a1' ? { ...entry, generatedFromCandidateId: CLEAN_CANDIDATE.id } : entry
      )
    };
    const frozen = freezeSyntheticTestSuite(authored, { now: fixture.frozenAt });
    const order = assertFrozenBeforeCandidateGeneration(frozen, [CLEAN_CANDIDATE]);
    expect(order.ok).toBe(false);
    expect(order.violations.some((violation) => violation.kind === 'candidate-authored-case')).toBe(true);
    const isolation = checkGeneratorCandidateIsolation(frozen, CLEAN_CANDIDATE);
    expect(isolation.isolated).toBe(false);
    expect(isolation.reason).toBe('candidate-authored-case');
  });

  it('rejects the same generator for tests and candidate', () => {
    const sameGenerator: SyntheticCandidateIdentity = { ...CLEAN_CANDIDATE, generatorId: SUITE.generator.id };
    const isolation = checkGeneratorCandidateIsolation(SUITE, sameGenerator);
    expect(isolation.isolated).toBe(false);
    expect(isolation.reason).toBe('same-generator');
  });

  it('isolates a different generator with no authored cases', () => {
    expect(checkGeneratorCandidateIsolation(SUITE, CLEAN_CANDIDATE)).toEqual({ isolated: true });
  });
});

describe('P5 trust layer: the holdout firewall (permanent fixtures)', () => {
  it('passes on a development-only generation artifact', () => {
    const clean = readFixture<{ cases: string[] }>('p5-synth-selection-clean.json');
    const result = checkSyntheticHoldoutFirewall(SUITE, [
      { path: 'tests/fixtures/p5-synth/p5-synth-selection-clean.json', content: JSON.stringify(clean) }
    ]);
    expect(result.ok).toBe(true);
    expect(result.checkedArtifacts).toHaveLength(1);
  });

  it('catches a holdout case id in a generation artifact (and names it)', () => {
    const leak = readFixture<{ cases: string[] }>('p5-synth-holdout-leak.json');
    const result = checkSyntheticHoldoutFirewall(SUITE, [
      { path: 'tests/fixtures/p5-synth/p5-synth-holdout-leak.json', content: JSON.stringify(leak) }
    ]);
    expect(result.ok).toBe(false);
    expect(result.violations.some((violation) => violation.kind === 'holdout-leak')).toBe(true);
    expect(result.violations[0]?.detail).toContain('p5-holdout-p1');
  });
});

describe('P5 trust layer: host execution receipts (execution evidence only)', () => {
  it('accepts a receipt that covers exactly the frozen development scope', () => {
    const receipt = makeReceipt(SUITE, true);
    const check = verifySyntheticTestReceipt(receipt, SUITE);
    expect(check.ok).toBe(true);
    expect(receipt.caseIds.length).toBe(SUITE.split?.development.length);
  });

  it('rejects a receipt whose seal was tampered with', () => {
    const receipt = makeReceipt(SUITE, true);
    const tampered = { ...receipt, receiptDigest: 'sha256:' + '1'.repeat(64) };
    const check = verifySyntheticTestReceipt(tampered, SUITE);
    expect(check.ok).toBe(false);
    expect(check.violations.some((violation) => violation.kind === 'receipt-digest-mismatch')).toBe(true);
  });

  it('rejects a receipt for another test-set digest', () => {
    const receipt = makeReceipt(SUITE, true);
    const otherSet = { ...receipt, testSetDigest: 'sha256:' + '2'.repeat(64) };
    const check = verifySyntheticTestReceipt(otherSet, SUITE);
    expect(check.ok).toBe(false);
    expect(check.violations.some((violation) => violation.kind === 'receipt-test-set-mismatch')).toBe(true);
  });

  it('rejects cherry-picking (a missing case) and swapped scopes', () => {
    const receipt = makeReceipt(SUITE, true);
    const cherryPicked = { ...receipt, caseIds: receipt.caseIds.slice(1) };
    const missing = verifySyntheticTestReceipt(
      { ...cherryPicked, receiptDigest: computeSyntheticReceiptDigest(cherryPicked as SyntheticTestReceipt) },
      SUITE
    );
    expect(missing.ok).toBe(false);
    expect(missing.violations.some((violation) => violation.kind === 'receipt-case-set-mismatch')).toBe(true);

    const holdoutInDev = {
      ...receipt,
      caseIds: [...(SUITE.split?.holdout ?? [])].sort()
    };
    const swapped = verifySyntheticTestReceipt(
      { ...holdoutInDev, receiptDigest: computeSyntheticReceiptDigest(holdoutInDev as SyntheticTestReceipt) },
      SUITE
    );
    expect(swapped.ok).toBe(false);
  });

  it('rejects a verdict that contradicts its own checks', () => {
    const receipt = makeReceipt(SUITE, true);
    const contradicted = {
      ...receipt,
      results: receipt.results.map((entry, index) =>
        index === 0 ? { ...entry, status: 'passed' as const, checks: [{ id: 'x', passed: false }] } : entry
      )
    };
    const check = verifySyntheticTestReceipt(
      { ...contradicted, receiptDigest: computeSyntheticReceiptDigest(contradicted as SyntheticTestReceipt) },
      SUITE
    );
    expect(check.ok).toBe(false);
    expect(check.violations.some((violation) => violation.kind === 'receipt-verdict-contradiction')).toBe(true);
  });

  it('rejects a receipt from another layer', () => {
    const receipt = makeReceipt(SUITE, true);
    const wrongLayer = { ...receipt, layer: 'synthesized-tests/v0' } as unknown as SyntheticTestReceipt;
    const check = verifySyntheticTestReceipt(wrongLayer, SUITE);
    expect(check.ok).toBe(false);
    expect(check.violations[0]?.kind).toBe('layer-mismatch');
  });
});

describe('P5 trust layer: calibration (confusion matrix, own denominators, own labels)', () => {
  it('computes the pinned confusion matrix on the development cases', () => {
    const report = calibratedReport();
    expect(report.confusion).toEqual({ tp: 5, fn: 1, fp: 0, tn: 4 });
    expect(report.population.labeledCases).toBe(10);
    expect(report.population.bugPresentCases).toBe(6);
    expect(report.population.bugAbsentCases).toBe(4);
    expect(report.population.excludedBaselineFrozenCaseIds).toEqual(['ci-04-2-2-noop-baseline']);
    expect(report.population.excludedHoldoutCaseIds).toEqual(['p5-holdout-a1', 'p5-holdout-p1']);
    expect(report.verdict).toBe('calibrated');
    expect(report.reasons).toEqual([]);
    expect(report.reportDigest).toBe(
      'sha256:201d6925718084d134669a13587791afa55323e500603390f485a28df2413817'
    );
  });

  it('publishes its own label, formula, denominator and denominator unit for every metric', () => {
    const report = calibratedReport();
    const byId = new Map(report.metrics.map((metric) => [metric.id, metric]));
    expect(byId.get('failure-recall')).toMatchObject({
      label: 'case-level-failure-recall (seeded-bug catch rate)',
      denominator: 6,
      denominatorUnit: 'labelled bug-present cases',
      value: 0.833333,
      threshold: DEFAULT_SYNTHETIC_CALIBRATION_THRESHOLDS.minFailureRecall,
      comparison: 'min',
      status: 'pass'
    });
    expect(byId.get('false-positive-rate')).toMatchObject({
      denominator: 4,
      denominatorUnit: 'labelled bug-absent cases',
      value: 0,
      threshold: DEFAULT_SYNTHETIC_CALIBRATION_THRESHOLDS.maxFalsePositiveRate,
      comparison: 'max',
      status: 'pass'
    });
    expect(byId.get('misjudgment-rate')).toMatchObject({
      denominator: 10,
      denominatorUnit: 'all labelled cases in the calibration run',
      value: 0.1,
      threshold: DEFAULT_SYNTHETIC_CALIBRATION_THRESHOLDS.maxMisjudgmentRate,
      comparison: 'max',
      status: 'pass'
    });
    for (const metric of report.metrics) {
      expect(metric.label.length).toBeGreaterThan(0);
      expect(metric.formula.length).toBeGreaterThan(0);
      expect(metric.denominatorUnit.length).toBeGreaterThan(0);
    }
  });

  it('fails calibration when recall/FP/misjudgment miss their pre-set thresholds', () => {
    const report = calibrateSyntheticTestSuite({
      suite: SUITE,
      results: failingDevelopmentResults(),
      now: SUITE.frozenAt
    });
    const byId = new Map(report.metrics.map((metric) => [metric.id, metric]));
    expect(byId.get('failure-recall')?.value).toBe(0.666667);
    expect(byId.get('failure-recall')?.status).toBe('fail');
    expect(byId.get('false-positive-rate')?.value).toBe(0.5);
    expect(byId.get('false-positive-rate')?.status).toBe('fail');
    expect(byId.get('misjudgment-rate')?.value).toBe(0.4);
    expect(byId.get('misjudgment-rate')?.status).toBe('fail');
    expect(report.verdict).toBe('failed');
    expect(report.reasons).toContain('calibration-threshold-failed');
  });

  it('is UNCALIBRATED when there are too few labelled cases or missing results', () => {
    const tooFew = calibrateSyntheticTestSuite({
      suite: SUITE,
      results: developmentResults().slice(0, 3),
      now: SUITE.frozenAt
    });
    expect(tooFew.verdict).toBe('uncalibrated');
    expect(tooFew.reasons).toContain('insufficient-labeled-cases');
    expect(tooFew.reasons).toContain('calibration-incomplete');
    expect(tooFew.metrics.every((metric) => metric.status === 'not-computable')).toBe(true);
  });

  it('is deterministic (same inputs => same report digest)', () => {
    expect(calibratedReport().reportDigest).toBe(calibratedReport().reportDigest);
  });

  it('rejects duplicate or unknown case results', () => {
    const duplicate = [...developmentResults(), developmentResults()[0]!];
    expect(() => calibrateSyntheticTestSuite({ suite: SUITE, results: duplicate, now: SUITE.frozenAt })).toThrow(
      /duplicate run result/
    );
    const unknown = [...developmentResults(), { caseId: 'p5-case-ghost', outcome: 'passed' as const }];
    expect(() => calibrateSyntheticTestSuite({ suite: SUITE, results: unknown, now: SUITE.frozenAt })).toThrow(
      /unknown cases/
    );
  });
});

describe('P5 trust layer: the ci-04|2|2 noop baseline-frozen diagnostic', () => {
  it('diagnoses the frozen case as NON-discriminating and HARMFUL to freeze', () => {
    const caseEntry = SUITE.cases.find((entry) => entry.id === 'ci-04-2-2-noop-baseline')!;
    const diagnosis = diagnoseBaselineFrozenCase(caseEntry);
    expect(diagnosis.frozen).toBe(true);
    expect(diagnosis.reason).toBe('baseline-frozen-test');
    expect(diagnosis.frozenActionKey).toBe('noop');
    expect(diagnosis.wouldRejectDeviations).toBe(true);
    expect(diagnosis.discriminating).toBe(false);
    expect(diagnosis.freezesHarmfulBaseline).toBe(true);
    expect(diagnosis.evidence).toMatchObject({ taskId: 'ci-04', run: 2, round: 2, support: 0 });
  });

  it('the historical evidence fixture agrees with the frozen case (the case EXISTS)', () => {
    const evidence = readFixture<{
      observation: {
        taskId: string;
        run: number;
        round: number;
        actionKey: string;
        support: number;
        advantage: number;
        observedCoverage: number;
        priorCoverage: number;
      };
      derivedCaseId: string;
    }>('p5-synth-ci04-baseline-frozen.json');
    const caseEntry = SUITE.cases.find((entry) => entry.id === evidence.derivedCaseId)!;
    expect(caseEntry.source).toBe('baseline-frozen');
    expect(caseEntry.baselineObservation).toEqual(evidence.observation);
    expect(evidence.observation.observedCoverage).toBeLessThan(evidence.observation.priorCoverage);
  });

  it('excludes baseline-frozen cases from calibration denominators and counts them', () => {
    const report = calibratedReport();
    expect(report.population.excludedBaselineFrozenCaseIds).toEqual(['ci-04-2-2-noop-baseline']);
    expect(report.population.labeledCases).toBe(10);
    const diagnoses = diagnoseBaselineFrozenCases(SUITE);
    expect(diagnoses.frozen).toHaveLength(1);
    expect(diagnoses.harmfulCount).toBe(1);
  });

  it('does not flag specification-derived cases', () => {
    const diagnosis = diagnoseBaselineFrozenCase(SUITE.cases.find((entry) => entry.id === 'p5-case-a1')!);
    expect(diagnosis.frozen).toBe(false);
    expect(diagnosis.reason).toBe('not-baseline-frozen');
    expect(diagnosis.discriminating).toBeNull();
  });
});

describe('P5 trust layer: content trust vs execution trust (never collapsed)', () => {
  it('calibrated content + verified execution still cannot enter task-quality (audit-only v1)', () => {
    const assessment = assessSyntheticTestResult({
      suite: SUITE,
      receipt: makeReceipt(SUITE, true),
      calibration: calibratedReport(),
      candidate: CLEAN_CANDIDATE
    });
    expect(assessment.content.trust).toBe('calibrated');
    expect(assessment.execution.trust).toBe('host-verified');
    expect(assessment.auditOnly).toBe(true);
    expect(assessment.taskQualityEligible).toBe(false);
    expect(assessment.provenance.freezeOrderOk).toBe(true);
    expect(assessment.provenance.generatorIsolated).toBe(true);
    const gate = gateSyntheticResultForTaskQuality(assessment);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe('audit-only-v1');
  });

  it('EXECUTION VERIFIED + CONTENT UNCALIBRATED is a legal state, and the gate blames the CONTENT', () => {
    const assessment = assessSyntheticTestResult({
      suite: SUITE,
      receipt: makeReceipt(SUITE, true),
      candidate: CLEAN_CANDIDATE
    });
    expect(assessment.execution.trust).toBe('host-verified');
    expect(assessment.content.trust).toBe('uncalibrated');
    expect(assessment.content.reasons).toContain('calibration-missing');
    expect(isExecutionTrustedContentUntrusted(assessment)).toBe(true);
    const gate = gateSyntheticResultForTaskQuality(assessment);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe('content-uncalibrated');
  });

  it('a failed calibration is NOT content trust (and not execution blame)', () => {
    const failed = calibrateSyntheticTestSuite({
      suite: SUITE,
      results: failingDevelopmentResults(),
      now: SUITE.frozenAt
    });
    const assessment = assessSyntheticTestResult({
      suite: SUITE,
      receipt: makeReceipt(SUITE, true),
      calibration: failed,
      candidate: CLEAN_CANDIDATE
    });
    expect(assessment.content.trust).toBe('uncalibrated');
    expect(assessment.content.reasons).toContain('calibration-threshold-failed');
    expect(gateSyntheticResultForTaskQuality(assessment).reason).toBe('content-uncalibrated');
  });

  it('calibration for a DIFFERENT suite cannot be replayed (set mismatch)', () => {
    const otherSuite = freezeSyntheticTestSuite(
      { ...readFixture<SuiteFixture>('p5-synth-suite.json'), version: 'v1-other' },
      { now: SUITE.frozenAt }
    );
    const foreign = calibrateSyntheticTestSuite({
      suite: otherSuite,
      results: otherSuite.cases
        .filter((entry) => otherSuite.split?.development.includes(entry.id))
        .map((entry) => ({ caseId: entry.id, outcome: entry.label === 'bug-present' ? 'failed' as const : 'passed' as const })),
      now: SUITE.frozenAt
    });
    const assessment = assessSyntheticTestResult({
      suite: SUITE,
      receipt: makeReceipt(SUITE, true),
      calibration: foreign
    });
    expect(assessment.content.trust).toBe('uncalibrated');
    expect(assessment.content.reasons).toContain('calibration-set-mismatch');
  });

  it('same-generator suites revoke content trust even when calibrated', () => {
    const assessment = assessSyntheticTestResult({
      suite: SUITE,
      receipt: makeReceipt(SUITE, true),
      calibration: calibratedReport(),
      candidate: { ...CLEAN_CANDIDATE, generatorId: SUITE.generator.id }
    });
    expect(assessment.content.trust).toBe('revoked');
    expect(assessment.provenance.generatorIsolated).toBe(false);
    expect(assessment.provenance.reasons).toContain('same-generator');
    expect(gateSyntheticResultForTaskQuality(assessment).reason).toBe('content-revoked');
  });

  it('a candidate that predates the freeze revokes content trust', () => {
    const assessment = assessSyntheticTestResult({
      suite: SUITE,
      receipt: makeReceipt(SUITE, true),
      calibration: calibratedReport(),
      candidate: { ...CLEAN_CANDIDATE, createdAt: SUITE.frozenAt - 5 }
    });
    expect(assessment.content.trust).toBe('revoked');
    expect(assessment.provenance.freezeOrderOk).toBe(false);
    expect(assessment.provenance.reasons).toContain('not-frozen-before-candidates');
  });

  it('a holdout leak in a generation artifact revokes content trust', () => {
    const leak = readFixture<{ cases: string[] }>('p5-synth-holdout-leak.json');
    const assessment = assessSyntheticTestResult({
      suite: SUITE,
      receipt: makeReceipt(SUITE, true),
      calibration: calibratedReport(),
      candidate: CLEAN_CANDIDATE,
      generationArtifacts: [
        { path: 'tests/fixtures/p5-synth/p5-synth-holdout-leak.json', content: JSON.stringify(leak) }
      ]
    });
    expect(assessment.content.trust).toBe('revoked');
    expect(assessment.provenance.holdoutFirewallOk).toBe(false);
    expect(assessment.provenance.reasons).toContain('holdout-leak');
  });

  it('unverified execution is blamed only when the content is otherwise trusted', () => {
    const assessment = assessSyntheticTestResult({
      suite: SUITE,
      calibration: calibratedReport(),
      candidate: CLEAN_CANDIDATE
    });
    expect(assessment.content.trust).toBe('calibrated');
    expect(assessment.execution.trust).toBe('unverified');
    expect(gateSyntheticResultForTaskQuality(assessment).reason).toBe('execution-unverified');
  });
});

describe('P5 trust layer: default OFF, explicit grant, rollback', () => {
  it('defaults to OFF and returns a disabled marker without touching its input', () => {
    const layer = createSyntheticTestTrustLayer();
    const description = layer.describe();
    expect(description.enabled).toBe(false);
    expect(description.mode).toBe('audit-only');
    expect(description.taskQualityEligible).toBe(false);
    expect(description.grant).toBeUndefined();
    expect(DEFAULT_SYNTHETIC_TEST_TRUST_POLICY).toEqual({ enabled: false, mode: 'audit-only' });

    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('a disabled layer must not read its input');
        }
      }
    );
    const result = layer.assess(hostile as unknown as SyntheticAssessmentInput);
    if (result.status !== 'disabled') {
      throw new Error('the default layer must return the disabled marker');
    }
    expect(result.taskQualityEligible).toBe(false);
  });

  it('enable() requires an explicit, well-formed audit-only grant', () => {
    const layer = createSyntheticTestTrustLayer();
    expect(() => layer.enable({ grantedBy: '', reason: 'x', mode: 'audit-only', grantedAt: 1 })).toThrow(
      /grantedBy/
    );
    expect(() => layer.enable({ grantedBy: 'lead', reason: '', mode: 'audit-only', grantedAt: 1 })).toThrow(
      /reason/
    );
    expect(() =>
      layer.enable({ grantedBy: 'lead', reason: 'x', mode: 'enforce' as unknown as 'audit-only', grantedAt: 1 })
    ).toThrow(/audit-only only/);
    expect(() =>
      layer.enable({ grantedBy: 'lead', reason: 'x', mode: 'audit-only', grantedAt: Number.NaN })
    ).toThrow(/grantedAt/);

    const enabled = layer.enable({ grantedBy: 'lead', reason: 'offline calibration review', mode: 'audit-only', grantedAt: 7 });
    expect(enabled.enabled).toBe(true);
    expect(enabled.grant).toMatchObject({ grantedBy: 'lead', reason: 'offline calibration review' });
    expect(() => layer.enable({ grantedBy: 'lead', reason: 'again', mode: 'audit-only', grantedAt: 8 })).toThrow(
      /already enabled/
    );
  });

  it('rolls back to the default policy exactly', () => {
    const layer = createSyntheticTestTrustLayer();
    const defaultDescription = layer.describe();
    layer.enable({ grantedBy: 'lead', reason: 'x', mode: 'audit-only', grantedAt: 7 });
    const disabled = layer.disable();
    expect(disabled).toEqual(defaultDescription);
    expect(layer.disable()).toEqual(defaultDescription);
    expect(layer.assess({ suite: SUITE }).status).toBe('disabled');
  });

  it('when enabled, audits end-to-end and still denies task-quality', () => {
    const layer = createSyntheticTestTrustLayer();
    layer.enable({ grantedBy: 'lead', reason: 'audit', mode: 'audit-only', grantedAt: 9 });
    const result = layer.assess({
      suite: SUITE,
      receipt: makeReceipt(SUITE, true),
      calibration: calibratedReport(),
      candidate: CLEAN_CANDIDATE
    });
    expect(result.status).toBe('audited');
    if (result.status !== 'audited') {
      throw new Error('unreachable');
    }
    expect(result.assessment.content.trust).toBe('calibrated');
    expect(result.assessment.execution.trust).toBe('host-verified');
    expect(result.taskQualityGate.allowed).toBe(false);
    expect(result.taskQualityGate.reason).toBe('audit-only-v1');
  });
});
