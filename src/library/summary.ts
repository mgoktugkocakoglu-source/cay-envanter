import type { Parcel } from '../tkgm/types.ts';
import type { HarvestResult } from '../harvest/harvest-neighborhood.ts';
import type { NeighborhoodMeta } from './store.ts';

const TEA_NATURE = /çay/i;
/** Deed vs. polygon area mismatch worth flagging (the deed area is the legal one). */
const AREA_MISMATCH_RATIO = 0.1;

const round = (value: number) => Math.round(value * 100) / 100;

export function buildSummary(meta: NeighborhoodMeta, result: HarvestResult, boundaryAreaM2: number) {
    const target = result.parcels.filter((p) => p.properties.inTargetNeighborhood);
    const byNature = new Map<string, { count: number; deedAreaM2: number }>();
    for (const { properties } of target) {
        const entry = byNature.get(properties.nature) ?? { count: 0, deedAreaM2: 0 };
        entry.count++;
        entry.deedAreaM2 += properties.deedAreaM2 ?? 0;
        byNature.set(properties.nature, entry);
    }
    const sumDeed = (parcels: Parcel[]) => round(parcels.reduce((sum, p) => sum + (p.properties.deedAreaM2 ?? 0), 0));
    const teaTitled = target.filter((p) => TEA_NATURE.test(p.properties.nature));
    const areaMismatches = target.filter(({ properties }) => {
        const deed = properties.deedAreaM2;
        return deed !== null && deed > 0 && Math.abs(properties.geometryAreaM2 - deed) / deed > AREA_MISMATCH_RATIO;
    });

    return {
        province: meta.province,
        district: meta.district,
        neighborhood: meta.neighborhood,
        harvestedAt: new Date().toISOString(),
        outcome: result.outcome,
        boundaryAreaM2: round(boundaryAreaM2),
        neighborhoodId: result.neighborhoodId,
        coveredRatio: Math.round(result.coveredRatio * 10_000) / 10_000,
        droppedSliverM2: round(result.droppedSliverM2),
        queries: result.queries,
        misses: result.misses,
        parcels: {
            total: result.parcels.length,
            inNeighborhood: target.length,
            fromNeighbors: result.parcels.length - target.length,
            deedAreaM2: sumDeed(target),
            withSuccessors: target.filter((p) => p.properties.successorParcels !== '').length,
            areaMismatchOver10Pct: areaMismatches.length,
        },
        teaTitled: { count: teaTitled.length, deedAreaM2: sumDeed(teaTitled) },
        byNature: [...byNature.entries()]
            .map(([nature, entry]) => ({ nature: nature || '(boş)', count: entry.count, deedAreaM2: round(entry.deedAreaM2) }))
            .sort((a, b) => b.deedAreaM2 - a.deedAreaM2),
    };
}
