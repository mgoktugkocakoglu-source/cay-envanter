/**
 * Decision matrix: TKGM parcel × ÇAYKUR license × satellite tea detection → one inventory class.
 * Thresholds are deliberately generous because Sentinel-2 is 10 m: a parcel edge alone can move
 * the detected share by tens of percent on small parcels. The output is a *flag for an expert*,
 * never a legal verdict.
 */

export type InventoryClass =
    | 'compliant' // licensed, detected tea area matches the license
    | 'over_quota' // licensed area clearly larger than the tea on the ground (quota risk)
    | 'ghost_license' // licensed, but no tea on the ground (strongest quota-abuse signal)
    | 'expanded' // licensed, tea extends well beyond the licensed area
    | 'unlicensed' // tea on private land without any license
    | 'public_land' // tea on forest / treasury / pasture land
    | 'uncertain' // parcel too small or detection too weak to call at 10 m
    | 'no_tea'; // no license, no tea — out of scope

export interface DecisionInput {
    nature: string;
    geometryAreaM2: number;
    teaShare: number | null;
    teaAreaM2: number | null;
    licensedAreaM2: number | null;
}

/** Below this (3 Sentinel-2 pixels) the 10 m grid cannot resolve the parcel at all. */
export const MIN_RELIABLE_PARCEL_M2 = 300;
export const TEA_PRESENT_SHARE = 0.3;
/**
 * Tea also counts as present above this absolute area, whatever the share: a 1 da tea plot
 * inside a 250 ha forest parcel is a tiny share but exactly what public-land detection is for.
 */
export const TEA_PRESENT_MIN_M2 = 1000;
export const TEA_ABSENT_SHARE = 0.1;
/** Accepted relative gap between detected and licensed tea area. */
export const AREA_TOLERANCE = 0.25;

const PUBLIC_LAND_TITLE = /^(orman|hazine|mera|2b)/i;

export function classify(input: DecisionInput): InventoryClass {
    const share = input.teaShare ?? 0;
    const detected = input.teaAreaM2 ?? 0;
    const licensed = input.licensedAreaM2;
    const teaPresent = share >= TEA_PRESENT_SHARE || detected >= TEA_PRESENT_MIN_M2;
    const teaAbsent = share < TEA_ABSENT_SHARE && detected < TEA_PRESENT_MIN_M2;
    const small = input.geometryAreaM2 < MIN_RELIABLE_PARCEL_M2;

    if (licensed === null) {
        if (!teaPresent) {
            return 'no_tea';
        }
        if (PUBLIC_LAND_TITLE.test(input.nature.trim())) {
            return 'public_land';
        }
        return small ? 'uncertain' : 'unlicensed';
    }
    if (teaAbsent) {
        return small ? 'uncertain' : 'ghost_license';
    }
    const gap = (detected - licensed) / licensed;
    if (gap < -AREA_TOLERANCE) {
        return small ? 'uncertain' : 'over_quota';
    }
    if (gap > AREA_TOLERANCE) {
        return small ? 'uncertain' : 'expanded';
    }
    return 'compliant';
}
