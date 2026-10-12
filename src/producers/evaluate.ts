import { evaluateScans, type ProducerStatus, type ScanInput } from './compliance.ts';

/** Per-garden scan series as the season file stores it (one entry per scan date). */
export interface GardenSeries {
    id: string;
    boundaryResolved: boolean;
    teaAreaM2: number;
    observedM2: number[];
    prunedM2: number[];
    reusedM2: number[];
}

export interface ProducerSeasonResult {
    licensedAreaM2: number;
    teaAreaM2: number;
    requiredM2: number;
    grossPrunedM2: number;
    reusedM2: number;
    newPrunedM2: number;
    unattributedM2: number;
    unobservedM2: number;
    remainingM2: number;
    unresolvedGardens: number;
    status: ProducerStatus;
    autoApprovedAt: string | null;
    scans: Array<{ date: string; grossPrunedM2: number; newPrunedM2: number; observedShare: number; ratio: number; status: ProducerStatus }>;
}

/**
 * Judges one producer's season from their gardens' scan series and the licensed area the
 * register allocates to them. Shared by the live scan and by offline re-evaluation (the licensed
 * area can change without touching the satellite: a licence is matched, corrected, transferred).
 */
export function evaluateProducerSeason(
    gardenIds: string[],
    gardensById: Map<string, GardenSeries>,
    dates: string[],
    newObservation: boolean[],
    licensedAreaM2: number,
): ProducerSeasonResult {
    const own = gardenIds.map((id) => gardensById.get(id)).filter((g): g is GardenSeries => !!g);
    const resolved = own.filter((g) => g.boundaryResolved);
    const unresolvedOwn = own.filter((g) => !g.boundaryResolved);
    const teaAreaM2 = own.reduce((s, g) => s + g.teaAreaM2, 0);
    const resolvedTeaM2 = resolved.reduce((s, g) => s + g.teaAreaM2, 0);
    const unresolvedTeaShare = teaAreaM2 > 0 ? unresolvedOwn.reduce((s, g) => s + g.teaAreaM2, 0) / teaAreaM2 : 0;
    const sum = (list: GardenSeries[], pick: (g: GardenSeries) => number) => list.reduce((s, g) => s + pick(g), 0);
    const inputs: ScanInput[] = dates.map((date, i) => ({
        date,
        newObservation: newObservation[i] as boolean,
        licensedAreaM2,
        teaAreaM2,
        grossPrunedM2: sum(resolved, (g) => g.prunedM2[i] ?? 0),
        reusedM2: sum(resolved, (g) => g.reusedM2[i] ?? 0),
        unattributedM2: sum(unresolvedOwn, (g) => g.prunedM2[i] ?? 0),
        observedShare: resolvedTeaM2 > 0 ? Math.min(1, sum(resolved, (g) => g.observedM2[i] ?? 0) / resolvedTeaM2) : 0,
        unresolvedTeaShare,
    }));
    const scans = evaluateScans(inputs);
    const last = scans.at(-1);
    const lastObserved = [...scans].reverse().find((s) => s.newObservation) ?? last;
    return {
        licensedAreaM2,
        teaAreaM2,
        requiredM2: last?.requiredM2 ?? 0,
        grossPrunedM2: last?.grossPrunedM2 ?? 0,
        reusedM2: last?.reusedM2 ?? 0,
        newPrunedM2: last?.newPrunedM2 ?? 0,
        unattributedM2: last?.unattributedM2 ?? 0,
        unobservedM2: Math.round(resolvedTeaM2 * (1 - (lastObserved?.observedShare ?? 0))),
        remainingM2: last?.remainingM2 ?? 0,
        unresolvedGardens: unresolvedOwn.length,
        status: last?.status ?? 'awaiting_observation',
        autoApprovedAt: scans.find((s) => s.status === 'auto_approved')?.date ?? null,
        scans: scans.map((s) => ({
            date: s.date,
            grossPrunedM2: Math.round(s.grossPrunedM2),
            newPrunedM2: s.newPrunedM2,
            observedShare: Math.round(s.observedShare * 1000) / 1000,
            ratio: s.ratio,
            status: s.status,
        })),
    };
}
