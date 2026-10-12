/**
 * Producer-level 1/7 pruning compliance, re-evaluated at every scan (≤ 5 days apart).
 *
 * The rule (2022/5285, 2022/14 Tebliğ): each season a seventh of the producer's licensed tea is
 * pruned, anywhere across their gardens. A producer whose pruning is confirmed may sell green
 * leaf to ÇAYKUR that season; one who did not prune may not.
 *
 * Only NEW area counts: pruning seen where the same ground was already credited in an earlier
 * season of the 7-year cycle is "reused" and goes to review instead of the target. Pruning in
 * a garden whose boundary inside a shared parcel is not resolved cannot be attributed to the
 * producer at all ("unattributed").
 *
 * Satellite evidence may OPEN purchase on its own only at very high confidence (auto_approved).
 * It never closes purchase on its own: every other outcome goes to an expert or waits for
 * observation. Thresholds are pre-calibration and must be re-set from field-labelled seasons.
 */

export type ProducerStatus =
    | 'auto_approved' // very high confidence: purchase opens without an expert
    | 'expert_review' // pruning near or above the target, confidence not high enough
    | 'repeat_pruning_review' // much of the pruning overlaps ground credited in an earlier season
    | 'boundary_unresolved' // a material share of the producer's tea has no resolved garden boundary
    | 'partial' // some pruning seen, clearly below 1/7
    | 'no_trace' // well observed, no pruning seen (yet)
    | 'awaiting_observation' // clouds / snow: not enough of the producer's tea observed
    | 'no_license'; // no licensed area is allocated to the producer: nothing to judge, no purchase

export const REQUIRED_FRACTION = 1 / 7;
/** Seasons in the pruning rotation: ground credited within this many past seasons counts as reused. */
export const CYCLE_SEASONS = 7;

/** Auto-approval demands all of these at once. */
export const AUTO_APPROVAL = {
    /** New pruned area ≥ 120 % of the 1/7 target — a margin for 10 m sub-pixel error. */
    minRatio: 1.2,
    /** ≥ 90 % of the producer's tea clearly observed in the scan window. */
    minObservedShare: 0.9,
    /** Two consecutive scans with new observations agree. */
    consecutiveScans: 2,
    /** ≥ 1,400 m² tea: a seventh is ≥ 2 Sentinel-2 pixels. */
    minTeaAreaM2: 1400,
} as const;

export const EXPERT_REVIEW_RATIO = 0.7;
export const PARTIAL_RATIO = 0.2;
export const MIN_OBSERVED_SHARE = 0.5;
/** Reused area above both of these sends the producer to repeat-pruning review. */
export const REPEAT_REVIEW = { minShareOfGross: 0.25, minM2: 100 } as const;
/** Unresolved-boundary gardens holding at least this share of the producer's tea block a verdict. */
export const BOUNDARY_MATERIAL_SHARE = 0.2;

export interface ScanInput {
    date: string;
    /** A clear scene arrived since the previous scan. */
    newObservation: boolean;
    licensedAreaM2: number;
    teaAreaM2: number;
    /** Cumulative pruned area in resolved gardens since the reference window (gross). */
    grossPrunedM2: number;
    /** Part of the gross that overlaps ground credited in an earlier season of the cycle. */
    reusedM2: number;
    /** Pruned area seen in gardens whose boundary is unresolved (cannot be attributed). */
    unattributedM2: number;
    /** Share of the producer's tea (resolved gardens) clearly observed at this scan. */
    observedShare: number;
    /** Share of the producer's tea lying in unresolved-boundary gardens. */
    unresolvedTeaShare: number;
}

export interface ScanResult extends ScanInput {
    requiredM2: number;
    newPrunedM2: number;
    remainingM2: number;
    ratio: number;
    confirmations: number;
    status: ProducerStatus;
}

/** Walks a producer's scans in date order; auto-approval is sticky once reached. */
export function evaluateScans(scans: ScanInput[]): ScanResult[] {
    const out: ScanResult[] = [];
    let confirmations = 0;
    let approved = false;
    for (const scan of scans) {
        const requiredM2 = scan.licensedAreaM2 * REQUIRED_FRACTION;
        const newPrunedM2 = Math.max(0, scan.grossPrunedM2 - scan.reusedM2);
        const ratio = requiredM2 > 0 ? newPrunedM2 / requiredM2 : 0;
        const repeat = scan.reusedM2 >= REPEAT_REVIEW.minM2 && scan.grossPrunedM2 > 0 && scan.reusedM2 / scan.grossPrunedM2 >= REPEAT_REVIEW.minShareOfGross;
        const strong = ratio >= AUTO_APPROVAL.minRatio && scan.observedShare >= AUTO_APPROVAL.minObservedShare && !repeat;
        if (scan.newObservation) confirmations = strong ? confirmations + 1 : 0;
        if (strong && scan.licensedAreaM2 > 0 && confirmations >= AUTO_APPROVAL.consecutiveScans && scan.teaAreaM2 >= AUTO_APPROVAL.minTeaAreaM2) {
            approved = true;
        }
        let status: ProducerStatus;
        if (scan.licensedAreaM2 <= 0) status = 'no_license';
        else if (approved) status = 'auto_approved';
        else if (repeat) status = 'repeat_pruning_review';
        else if (ratio >= EXPERT_REVIEW_RATIO) status = 'expert_review';
        else if (scan.unresolvedTeaShare >= BOUNDARY_MATERIAL_SHARE) status = 'boundary_unresolved';
        else if (scan.observedShare < MIN_OBSERVED_SHARE) status = 'awaiting_observation';
        else if (ratio >= PARTIAL_RATIO) status = 'partial';
        else status = 'no_trace';
        out.push({
            ...scan,
            requiredM2: Math.round(requiredM2),
            newPrunedM2: Math.round(newPrunedM2),
            remainingM2: Math.round(Math.max(0, requiredM2 - newPrunedM2)),
            ratio: Math.round(ratio * 1000) / 1000,
            confirmations,
            status,
        });
    }
    return out;
}
