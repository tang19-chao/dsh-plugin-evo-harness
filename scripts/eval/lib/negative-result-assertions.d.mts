/**
 * Hand-written types for `negative-result-assertions.mjs` (PR-1).
 *
 * The rules are plain `.mjs` so the diagnostic CLI can run through `node` with
 * no build step, and so the module can be imported by tests without the shebang
 * problem the CLI itself has on a CRLF checkout. See `git-objects.d.mts`.
 */

export interface AssertionOutcome {
  ok: boolean;
  failures: string[];
}

export declare function affirmsConfirmedRootCause(verdict: string): boolean;

export declare function evaluateAssertions(data: unknown): AssertionOutcome;

export declare const ASSERTION_IDS: Readonly<Record<'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'A6', string>>;
