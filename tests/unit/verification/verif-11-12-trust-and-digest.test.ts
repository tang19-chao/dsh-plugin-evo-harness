/**
 * VERIF-11 / VERIF-12 regression: two verification-layer honesty/identity gaps.
 *
 * VERIF-11 — `verifySyntheticTestReceipt` accepts a receipt when its digest
 * equals an UNKEYED SHA-256 over the receipt's own content: no host registry, no
 * object identity, no runner binding (unlike the C2a runner, attach.ts
 * `registered === receipt`). `assessSyntheticTestResult` then labelled that state
 * `'host-verified'`, asserting host provenance the check cannot back. The fix
 * renames the state to `'self-sealed'` (self-consistency), keeping the v1
 * containment literal `SYNTHETIC_TASK_QUALITY_ELIGIBLE = false` untouched.
 *
 * VERIF-12 — `artifactOf`/`artifactBytes` sorted `producedFiles` but never
 * deduplicated, so `['a','a']` digested differently from `['a']` for the same
 * logical file SET, contradicting the module's own "one digest per file SET" doc.
 *
 * MUST BE RED before the fixes: a minted receipt reads `'host-verified'`, and a
 * duplicated file list yields a different digest.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  artifactBytes,
  artifactDigestOf,
  artifactOf
} from '../../../src/verification/artifact-digest';
import {
  SYNTHETIC_EXECUTION_TRUST_STATES,
  SYNTHETIC_TASK_QUALITY_ELIGIBLE,
  assessSyntheticTestResult,
  computeSyntheticReceiptDigest,
  freezeSyntheticTestSuite,
  gateSyntheticResultForTaskQuality,
  verifySyntheticTestReceipt,
  type FrozenSyntheticTestSuite,
  type SyntheticTestReceipt,
  type SyntheticTestSuiteDraft
} from '../../../src/verification/synthesized-tests';
import type { ProbeTrajectory } from '../../../src/types/contracts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(here, '../../fixtures/p5-synth');

function freezeFixture(): FrozenSyntheticTestSuite {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(fixtureDir, 'p5-synth-suite.json'), 'utf8')
  ) as SyntheticTestSuiteDraft & { readonly frozenAt: number };
  return freezeSyntheticTestSuite(fixture, { now: fixture.frozenAt });
}

const SUITE = freezeFixture();

/** The receipt ANY caller holding the suite data can mint (the VERIF-11 shape). */
function mintedReceipt(suite: FrozenSyntheticTestSuite, verifierId = 'not-a-host'): SyntheticTestReceipt {
  const caseIds = [...(suite.split?.development ?? suite.cases.map((entry) => entry.id))].sort();
  const results = caseIds.map((caseId) => ({
    caseId,
    status: 'passed' as const,
    checks: [{ id: 'minted-check', passed: true }]
  }));
  const base: Omit<SyntheticTestReceipt, 'receiptDigest'> = {
    layer: suite.layer,
    testSetDigest: suite.testSetDigest,
    scope: 'development',
    caseIds,
    runId: 'run-minted',
    verifierId,
    verifierVersion: '0.0.0-minted',
    executedAt: suite.frozenAt + 1,
    status: 'passed',
    results
  };
  return { ...base, receiptDigest: computeSyntheticReceiptDigest(base) };
}

describe('VERIF-11: the execution-trust state says self-sealed, not host-verified', () => {
  it('the frozen vocabulary carries self-sealed and no longer claims host-verified', () => {
    expect([...SYNTHETIC_EXECUTION_TRUST_STATES]).toEqual(['unverified', 'self-sealed']);
    expect(SYNTHETIC_EXECUTION_TRUST_STATES).not.toContain('host-verified');
  });

  it('a caller-minted, self-consistent receipt is accepted as self-sealed (not host provenance)', () => {
    const receipt = mintedReceipt(SUITE, 'not-a-host');
    // The check really is self-consistency only: the seal recomputes.
    expect(verifySyntheticTestReceipt(receipt, SUITE).ok).toBe(true);

    const assessment = assessSyntheticTestResult({ suite: SUITE, receipt });
    // RED before the fix: 'host-verified'.
    expect(assessment.execution.trust).toBe('self-sealed');
    expect(assessment.execution.verifierId).toBe('not-a-host');
  });

  it('v1 containment is UNCHANGED: task-quality stays type-level false even when calibrated + self-sealed', () => {
    const assessment = assessSyntheticTestResult({ suite: SUITE, receipt: mintedReceipt(SUITE) });
    expect(assessment.taskQualityEligible).toBe(false);
    expect(assessment.auditOnly).toBe(true);
    expect(SYNTHETIC_TASK_QUALITY_ELIGIBLE).toBe(false);
    const gate = gateSyntheticResultForTaskQuality(assessment);
    expect(gate.allowed).toBe(false);
    // An uncalibrated content axis still wins the reasoning order.
    expect(gate.reason).toBe('content-uncalibrated');
  });

  it('a receipt with no receipt at all is still unverified (the vocabulary did not collapse)', () => {
    const assessment = assessSyntheticTestResult({ suite: SUITE });
    expect(assessment.execution.trust).toBe('unverified');
    expect(assessment.execution.reasons).toContain('execution-unverified');
  });
});

describe('VERIF-12: producedFiles is a SET — duplicates cannot change the digest', () => {
  /** A minimal finalized trajectory carrying only what the digest reads. */
  function trajectoryWith(producedFiles: readonly string[]): ProbeTrajectory {
    return {
      id: 'traj-artifact',
      sessionId: 'sess-artifact',
      branchId: 'br-artifact',
      branchNamespace: 'ns-artifact',
      role: 'candidate',
      status: 'succeeded',
      patchId: 'patch-artifact',
      patchOrigin: 'reference',
      surfaceKeys: [],
      startedAt: 0,
      endedAt: 1,
      metrics: { steps: 0, toolCalls: 0, toolErrors: 0, durationMs: 1 },
      steps: [],
      toolErrors: [],
      deliverable: { content: 'body', format: 'markdown', producedFiles },
      failureSignals: [],
      memoryRecallIds: []
    };
  }

  it('artifactOf collapses duplicate listings to the same SET', () => {
    expect(artifactOf(trajectoryWith(['a', 'a']))?.producedFiles).toEqual(['a']);
    expect(artifactOf(trajectoryWith(['b', 'a', 'a', 'b']))?.producedFiles).toEqual(['a', 'b']);
  });

  it('artifactBytes/artifactDigestOf give ONE digest per file SET, not per duplicate entry', () => {
    const once = { content: 'body', producedFiles: ['a', 'b'] };
    const twice = { content: 'body', producedFiles: ['b', 'a', 'a', 'b'] };

    // RED before the fix: the multiset framing counted 'a' and 'b' twice.
    expect(artifactBytes(once)).toEqual(artifactBytes(twice));
    expect(artifactDigestOf(once)).toBe(artifactDigestOf(twice));
  });

  it('still distinguishes genuinely different file sets and different content', () => {
    const base = { content: 'body', producedFiles: ['a'] };
    expect(artifactDigestOf(base)).not.toBe(artifactDigestOf({ content: 'body', producedFiles: ['b'] }));
    expect(artifactDigestOf(base)).not.toBe(
      artifactDigestOf({ content: 'body', producedFiles: ['a', 'b'] })
    );
    expect(artifactDigestOf(base)).not.toBe(artifactDigestOf({ content: 'other', producedFiles: ['a'] }));
  });

  it('keeps an empty content + no files as "nothing to verify"', () => {
    const emptyDelivery: ProbeTrajectory = {
      ...trajectoryWith([]),
      deliverable: { content: '', format: 'markdown', producedFiles: [] }
    };
    expect(artifactOf(emptyDelivery)).toBeUndefined();
    // Content alone (no files) IS an artifact; so are files alone.
    expect(artifactOf(trajectoryWith([]))?.content).toBe('body');
  });
});
