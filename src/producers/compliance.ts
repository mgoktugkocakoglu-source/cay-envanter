/**
 * Producer-level 1/7 pruning compliance, re-evaluated at every scan (≤ 5 days apart).
 *
 * The rule (2022/5285, 2022/14 Tebliğ): each season a seventh of the producer's licensed tea is
 * pruned, anywhere across their gardens. A producer whose pruning is confirmed may sell green
 * leaf to ÇAYKUR that season; one who did not prune may not.
 *
 * Satellite evidence may OPEN purchase on its own only at very high confidence (auto_approved).
 * It never closes purchase on its own: every other outcome goes to an expert or waits for
 * observation. Thresholds are pre-calibration and must be re-set from field-labelled seasons.
 */

export type ProducerStatus =
    | 'auto_approved' // very high confidence: purchase opens without an expert
    | 'expert_review' // pruning near or above the target, confidence not high enough
    | 'partial' // some pruning seen, clearly below 1/7
    | 'no_trace' // well observed, no pruning seen (yet)
    | 'awaiting_observation'; // clouds / snow: not enough of the producer's tea observed

export const REQUIRED_FRACTION = 1 / 7;

/** Auto-approval demands all of these at once. */
export const AUTO_APPROVAL = {
    /** Pruned ≥ 120 % of the 1/7 target — a margin for 10 m sub-pixel error. */
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

export interface ScanInput {
    date: string;
    /** A clear scene arrived since the previous scan. */
    newObservation: boolean;
    licensedAreaM2: number;
    teaAreaM2: number;
    /** Cumulative pruned area across the producer's gardens since the reference window. */
    prunedM2: number;
    observedShare: number;
}

export interface ScanResult extends ScanInput {
    requiredM2: number;
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
        const ratio = requiredM2 > 0 ? scan.prunedM2 / requiredM2 : 0;
        const strong = ratio >= AUTO_APPROVAL.minRatio && scan.observedShare >= AUTO_APPROVAL.minObservedShare;
        if (scan.newObservation) confirmations = strong ? confirmations + 1 : 0;
        if (strong && confirmations >= AUTO_APPROVAL.consecutiveScans && scan.teaAreaM2 >= AUTO_APPROVAL.minTeaAreaM2) {
            approved = true;
        }
        let status: ProducerStatus;
        if (approved) status = 'auto_approved';
        else if (ratio >= EXPERT_REVIEW_RATIO) status = 'expert_review';
        else if (scan.observedShare < MIN_OBSERVED_SHARE) status = 'awaiting_observation';
        else if (ratio >= PARTIAL_RATIO) status = 'partial';
        else status = 'no_trace';
        out.push({ ...scan, requiredM2: Math.round(requiredM2), ratio: Math.round(ratio * 1000) / 1000, confirmations, status });
    }
    return out;
}
