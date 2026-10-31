/**
 * rev6 R0-3 (captain ruling D-1): the publish DENIAL REASON is a *runtime* fact.
 *
 * WHY THIS IS A SEPARATE SUITE FROM tests/unit/p62/rev6-release-contract.test.ts
 * ------------------------------------------------------------------------------
 * The p62 suite reads the two FILES and proves the replacement was applied
 * verbatim and surgically. That is a documentation claim. This suite proves the
 * claim reaches the RESOLVED PROFILE that callers and diagnostics actually see:
 * `resolveExecutionProfile().permissions.publish.reason` must state the
 * strict-improvement criterion and must not use non-inferiority AS the criterion.
 *
 * The distinction matters because the apt regression here is not "someone edited
 * the ADR" - it is "someone edited the ADR and forgot the code, so the register
 * says applied while the running denial reason still promises a looser gate".
 * A file-level assertion cannot see that; this one can.
 *
 * The `allowed: false` half is unchanged by R0-3 and is re-asserted here so a
 * future "terminology cleanup" cannot quietly start granting publish: the wording
 * changed, the verdict did not.
 */
import { describe, expect, it } from 'vitest';
import { EXECUTION_MODES, resolveExecutionProfile } from '../../../src/runtime/execution-profile';

const PUBLISH_DENIAL = resolveExecutionProfile().permissions.publish.reason;

describe('rev6 R0-3: publish denial reason states strict improvement, not non-inferiority', () => {
  it('names the strict-improvement criterion', () => {
    expect(PUBLISH_DENIAL).toContain('STRICT-IMPROVEMENT');
    // The identifier a reviewer greps for should be the operative one, not a
    // paraphrase ("strictly better", "strict dominance") that no other file uses.
    expect(PUBLISH_DENIAL).not.toContain('strictly better');
  });

  it('does not use non-inferiority as the operative criterion', () => {
    // The literal token survives exactly once, inside the disclosure clause
    // ("the earlier "non-inferiority" wording was drift"). What must be absent is
    // the phrase that USED it as the requirement.
    expect(PUBLISH_DENIAL).not.toContain('holdout non-inferiority +');
    // And the disclosure must be present, not silently dropped: deleting it is
    // the only way to make the token disappear, and it would hide the drift.
    expect(PUBLISH_DENIAL).toContain('wording was drift');
  });

  it('still requires the same three things it always required', () => {
    // R0-3 is a wording change. If a future edit "simplifies" the reason by
    // dropping one of the three conditions, the denial would describe a weaker
    // gate than the code enforces.
    expect(PUBLISH_DENIAL).toContain('explicit authorization');
    expect(PUBLISH_DENIAL).toContain('matching artifact');
    expect(PUBLISH_DENIAL).toContain('ADR 0002 R2');
  });

  it('names the epsilon form of the criterion, not a tolerance band', () => {
    // Strict improvement = "winner > baseline + epsilon on the held-out trees".
    // A non-inferiority reading would be ">= baseline - delta"; the reason must
    // not be readable either way.
    expect(PUBLISH_DENIAL).toContain('hypervolume > baseline + epsilon');
    expect(PUBLISH_DENIAL).not.toContain('delta');
  });

  it('publish stays denied in EVERY declared mode (the wording change grants nothing)', () => {
    for (const mode of EXECUTION_MODES) {
      const profile = resolveExecutionProfile({ mode });
      expect(profile.permissions.publish.allowed, `publish must stay denied in ${mode}`).toBe(false);
      expect(profile.permissions.publish.reason, `reason must not weaken in ${mode}`).toBe(PUBLISH_DENIAL);
    }
    // Including the "unknown mode" fallback: fail-closed means the reason is the
    // same string, not a weaker default.
    const unknown = resolveExecutionProfile({ mode: 'spectacular' as never });
    expect(unknown.permissions.publish.allowed).toBe(false);
    expect(unknown.permissions.publish.reason).toBe(PUBLISH_DENIAL);
  });

  it('the strict-improvement wording is the SAME string the ADR publishes (no drift between docs and code)', () => {
    // Cheap cross-check with the documentation suite: both must quote the same
    // identifying phrase, so a rename in either place fails somewhere.
    expect(PUBLISH_DENIAL).toMatch(/holdout STRICT-IMPROVEMENT validation/);
  });
});
