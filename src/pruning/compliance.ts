/**
 * 1/7 pruning rule per parcel and season (2022/5285 Cumhurbaşkanı Kararı, 2022/14 Tebliğ):
 * every year a seventh of the licensed tea garden is pruned below 20 cm.
 * The result is an inspection flag, never a verdict: the season window, partial observation
 * and 10 m pixels all leave room for error.
 */

export type PruningStatus =
    | 'pruned' // pruned area reaches the 1/7 target (with tolerance)
    | 'partial' // some pruning seen, clearly below 1/7
    | 'no_trace' // well observed, no pruning seen
    | 'insufficient_observation' // clouds / snow hid most of the tea in the compared windows
    | 'too_small'; // tea area too small for 10 m pixels to resolve a seventh of it

export const REQUIRED_FRACTION = 1 / 7;
/** Below this observed share of the tea area, absence of a drop says nothing. */
export const MIN_OBSERVED_SHARE = 0.5;
/** A seventh of this many m² is ~2 pixels — the smallest pruned area 10 m imagery can register. */
export const MIN_TEA_AREA_M2 = 1400;
/** Tea under one 10 m pixel is edge spill from a neighbouring garden, not a garden to judge. */
export const MIN_JUDGED_TEA_M2 = 100;
/** Pruned ≥ 70% of the target counts as meeting it (sub-pixel estimates are rough). */
export const MEETS_TARGET = 0.7;
/** Pruned ≥ 20% of the target is a partial trace; less is treated as noise. */
export const PARTIAL_TARGET = 0.2;

export interface PruningInput {
    teaAreaM2: number;
    observedTeaAreaM2: number;
    prunedM2: number;
}

export function requiredPrunedM2(teaAreaM2: number): number {
    return teaAreaM2 * REQUIRED_FRACTION;
}

export function pruningStatus({ teaAreaM2, observedTeaAreaM2, prunedM2 }: PruningInput): PruningStatus {
    const required = requiredPrunedM2(teaAreaM2);
    const ratio = required > 0 ? prunedM2 / required : 0;
    if (teaAreaM2 <= 0 || observedTeaAreaM2 / teaAreaM2 < MIN_OBSERVED_SHARE) {
        return 'insufficient_observation';
    }
    if (teaAreaM2 < MIN_JUDGED_TEA_M2) {
        return 'too_small';
    }
    if (ratio >= MEETS_TARGET) {
        return 'pruned';
    }
    if (teaAreaM2 < MIN_TEA_AREA_M2) {
        return 'too_small';
    }
    return ratio >= PARTIAL_TARGET ? 'partial' : 'no_trace';
}
