/**
 * Hand-written types for pr4a-v3-design.mjs (P2-A, p2-a-b-kernel).
 *
 * The design module is plain .mjs so the pre-registration gate and the replay
 * probe can run it with no build step; these declarations let the TS unit suite
 * import it under strict without enabling allowJs for the whole repository (the
 * same reasoning as check-encoding-policy.d.mts).
 */

export type V3Surface = string;

export interface V3Task {
  readonly id: string;
  readonly family: string;
  readonly prompt: string;
  readonly signature: string;
  readonly contextTags: readonly string[];
  readonly complexity: 'moderate' | 'complex';
  readonly required: readonly V3Surface[];
  readonly prefs: readonly V3Surface[];
  readonly blind: readonly V3Surface[];
  readonly taskClass: 'prior-saturates' | 'preference-blind' | 'family-blind' | 'mixed';
}

export interface V3PoolCandidate {
  readonly index: number;
  readonly surfaces: readonly V3Surface[];
  readonly confidence: number;
  readonly className: string;
  readonly actionKey: string;
}

export interface V3DecisionPoint {
  readonly id: string;
  readonly task: string;
  readonly round: number;
  readonly slotKind: 'proposal';
  readonly l1SlotKinds: readonly string[];
  readonly candidates: readonly {
    readonly actionKey: string;
    readonly surfaces: readonly V3Surface[];
    readonly confidence: number;
    readonly className: string;
  }[];
  readonly distinctActionCount: number;
}

export interface V3DecisionActionCount {
  readonly round: number;
  readonly actions: number;
  readonly classes: readonly string[];
}

export interface V3DesignRow {
  readonly id: string;
  readonly family: string;
  readonly required: readonly V3Surface[];
  readonly prefs: readonly V3Surface[];
  readonly blind: readonly V3Surface[];
  readonly taskClass: V3Task['taskClass'];
  readonly requiredWithinTop3Prefs: boolean;
  readonly reachable: readonly V3Surface[];
  readonly actionsPerDecisionPoint: readonly V3DecisionActionCount[];
  readonly oracle: number;
  readonly prior: number;
  readonly headroom: number;
  readonly ceilingIsOne: boolean;
}

export interface V3SupportMatrix {
  readonly decisionPoints: readonly string[];
  readonly actionClasses: readonly string[];
  readonly cells: readonly (readonly number[])[];
  readonly rank: number;
  readonly minActionsPerDecisionPoint: number;
}

export interface V3DesignSummary {
  readonly version: string;
  readonly poolRuleVersion: string;
  readonly scheduleVersion: string;
  readonly rounds: number;
  readonly taskCount: number;
  readonly surfaces: readonly V3Surface[];
  readonly unproposableSurfaces: readonly V3Surface[];
  readonly slotKinds: readonly string[];
  readonly baselineBand: { readonly low: number; readonly high: number; readonly inBand: boolean };
  readonly priorMeanCoverage: number;
  readonly oracleMeanCoverage: number;
  readonly meanHeadroom: number;
  readonly requiredOutsideTop3Share: number;
  readonly tasksWithRequiredOutsideTop3: number;
  readonly tasksWithConstrainedCeiling: number;
  readonly tasksWithHeadroom: number;
  readonly minActionsPerDecisionPoint: number;
  readonly supportMatrix: {
    readonly decisionPoints: number;
    readonly actionClasses: readonly string[];
    readonly rank: number;
    readonly minActionsPerDecisionPoint: number;
  };
  readonly rows: readonly V3DesignRow[];
  readonly findings: readonly string[];
}

export declare const V3_SURFACES: readonly V3Surface[];
export declare const V3_UNPROPOSABLE_SURFACES: readonly V3Surface[];
export declare const V3_ROUNDS: number;
export declare const V3_SLOT_KINDS: readonly string[];
export declare const V3_POOL_RULE_VERSION: string;
export declare const V3_SCHEDULE_VERSION: string;
export declare const V3_DESIGN_VERSION: string;
export declare const V3_TASKS: readonly V3Task[];
export declare const ORACLE_DERIVATION: string;
export declare const PRIOR_DERIVATION: string;

export declare function v3PoolForDecision(task: V3Task, round: number): readonly V3PoolCandidate[];
export declare function surfaceClassName(surfaces: readonly V3Surface[]): string;
export declare function coverageOf(task: Pick<V3Task, 'required'>, surfaces: readonly V3Surface[]): number;
export declare function requiredWithinTop3Prefs(task: Pick<V3Task, 'required' | 'prefs'>): boolean;
export declare function reachableSurfaces(task: V3Task): readonly V3Surface[];
export declare function oracleCoverage(task: V3Task, rounds?: number): number;
export declare function priorCoverage(task: V3Task, rounds?: number): number;
export declare function enumerateLineages(
  task: V3Task,
  rounds?: number
): readonly { readonly choices: readonly number[]; readonly surfaces: readonly V3Surface[] }[];
export declare function taskDesignRow(task: V3Task, rounds?: number): V3DesignRow;
export declare function decisionPointActionCounts(task: V3Task, rounds?: number): readonly V3DecisionActionCount[];
export declare function buildSupportMatrix(tasks?: readonly V3Task[], rounds?: number): V3SupportMatrix;
export declare function rankOfMatrix(cells: readonly (readonly number[])[], tolerance?: number): number;
export declare function degenerateRankOneFixture(): V3SupportMatrix;
export declare function isRankDeficient(matrix: { readonly rank: number }): boolean;
export declare function designGateFindings(tasks?: readonly V3Task[], rounds?: number): readonly string[];
export declare function designSummary(tasks?: readonly V3Task[], rounds?: number): V3DesignSummary;
export declare function taskDecisionPoints(task: V3Task, rounds?: number): readonly V3DecisionPoint[];
export declare function canonicalDesignTasksJson(tasks?: readonly V3Task[], rounds?: number): readonly unknown[];
export declare function canonicalDesignJson(tasks?: readonly V3Task[], rounds?: number): string;
export declare function canonicalDesignBytes(tasks?: readonly V3Task[], rounds?: number): string;
export declare function designDigest(tasks?: readonly V3Task[], rounds?: number): Promise<string>;
