/**
 * Purchase-decision policy of the fusion module (shared by the fusion CLI and the demo layout tool).
 * Kept outside the CLI so tools can import it without running the CLI.
 */
export const DECISION_POLICY = {
    /** "Likely" units count toward the 1/7 like confirmed ones (they keep their own label on screen). */
    likelyCounts: true,
    /** Pruned area above this multiple of the 1/7 target is suspicious (clearing, not pruning). */
    overPrunedRatio: 3.0,
    /** Seasons in the pruning rotation: ground pruned within this many earlier seasons does not count again (set from --ratio). */
    cycleSeasons: 7,
    /** Reused share of a unit that is flagged as repeat pruning (always subtracted, flagged above this). */
    repeatShare: 0.2,
    /**
     * Anomalies that send the file to an expert; the others (repeat pruning, licence-area mismatch,
     * unresolved share boundary) are notes: repeat pruning is subtracted automatically and the
     * shortfall is written, no expert needed.
     */
    blocking: ['sensors_contradict', 'boundary_conflict', 'unlicensed_pruning', 'over_pruned'] as string[],
    /** Smallest free tea patch judged on its own (m²). */
    minUnassignedM2: 300,
};
