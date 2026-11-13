/**
 * DEMO licence register for the licence audit, used until ÇAYKUR's real list (caykur-licences.csv) arrives.
 *
 * It keeps the licences of the demo producer register (licensing/registry.json) and extends it to the parcels that
 * register does not reach, so that the picture is the one expected in the field: nearly all tea is licensed, and
 * unlicensed tea, licences without tea and licences on land that was never tea are exceptions.
 *
 * "Tea on the ground" here means, in this order: a field note or expert confirmation, else the satellite reading,
 * else the deed title. The register is therefore built from the same detection the audit later compares it with:
 * the result shows that the decision mechanism works, it says nothing about how many such parcels really exist.
 * Choices are a fixed hash of the parcel key, so adding parcels never reshuffles the others.
 */
export const DEMO_LICENCE_RULES = {
    /** Share of parcels with tea on the ground left without a licence (unlicensed tea). */
    unlicensedShare: 0.06,
    /** Share of parcels titled tea, without tea on the ground, that still hold a licence (licence without tea). */
    licensedNoTeaShare: 0.5,
    /** Share of parcels with neither a tea title nor tea on the ground that hold a licence (licensing error). */
    errorShare: 0.03,
    /** Licensed area as a share of the tea area (or of the parcel when no tea is measured). */
    areaFactor: [0.9, 1.1] as [number, number],
    noTeaParcelShare: 0.6,
};

export type DemoLicenceOrigin = 'registry' | 'extension' | 'field_note' | 'pinned';
export type DemoLicenceScenario = 'licensed_tea' | 'unlicensed_tea' | 'licence_no_tea' | 'licensing_error' | 'no_licence';

export interface DemoLicenceInput {
    key: string;
    block: string;
    parcel: string;
    parcelAreaM2: number;
    titleTea: boolean;
    /** Tea on the ground as far as known (note / confirmation, else satellite, else title). */
    groundTea: boolean;
    teaAreaM2: number | null;
    /** Licence already held in the demo producer register. */
    registry: { areaM2: number; codes: string[] } | null;
    /** A field note calls the tea on this parcel unlicensed. */
    notedUnlicensed: boolean;
    /** Fixed by hand (demo-pins.json): true = licensed, false = not licensed. */
    pinned: boolean | null;
}
export interface DemoLicence {
    key: string;
    block: string;
    parcel: string;
    licensed: boolean;
    areaM2: number | null;
    codes: string[];
    origin: DemoLicenceOrigin;
    scenario: DemoLicenceScenario;
}

/** FNV-1a → [0, 1): a stable draw per parcel and purpose. */
export function stableDraw(key: string, salt: string): number {
    let h = 0x811c9dc5;
    for (const ch of `${salt}:${key}`) {
        h ^= ch.codePointAt(0) as number;
        h = Math.imul(h, 0x01000193);
    }
    // Final mix (murmur3): without it keys that differ in the last digit land next to each other.
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 0x1_0000_0000;
}

export function buildDemoLicences(inputs: DemoLicenceInput[]): DemoLicence[] {
    const R = DEMO_LICENCE_RULES;
    return inputs.map((p) => {
        const scenarioOf = (licensed: boolean): DemoLicenceScenario => (licensed ? (p.groundTea ? 'licensed_tea' : p.titleTea ? 'licence_no_tea' : 'licensing_error') : p.groundTea ? 'unlicensed_tea' : 'no_licence');
        // A field note or a pin stands above the producer register.
        if (p.registry && p.pinned === null && !p.notedUnlicensed) return { key: p.key, block: p.block, parcel: p.parcel, licensed: true, areaM2: Math.round(p.registry.areaM2), codes: p.registry.codes, origin: 'registry', scenario: scenarioOf(true) };
        let licensed: boolean;
        let origin: DemoLicenceOrigin = 'extension';
        if (p.pinned !== null) {
            licensed = p.pinned;
            origin = 'pinned';
        } else if (p.notedUnlicensed) {
            licensed = false;
            origin = 'field_note';
        } else if (p.groundTea) licensed = stableDraw(p.key, 'unlicensed') >= R.unlicensedShare;
        else if (p.titleTea) licensed = stableDraw(p.key, 'no-tea') < R.licensedNoTeaShare;
        else licensed = stableDraw(p.key, 'error') < R.errorShare;
        if (!licensed) return { key: p.key, block: p.block, parcel: p.parcel, licensed: false, areaM2: null, codes: [], origin, scenario: scenarioOf(false) };
        const factor = R.areaFactor[0] + stableDraw(p.key, 'area') * (R.areaFactor[1] - R.areaFactor[0]);
        const base = p.groundTea && (p.teaAreaM2 ?? 0) >= 100 ? (p.teaAreaM2 as number) : p.parcelAreaM2 * R.noTeaParcelShare;
        return {
            key: p.key,
            block: p.block,
            parcel: p.parcel,
            licensed: true,
            areaM2: Math.round(Math.min(base * factor, p.parcelAreaM2)),
            // DEMO-RX: extension of the demo register (DEMO-R codes belong to the producer register).
            codes: [`DEMO-RX-${p.block}-${p.parcel}`],
            origin,
            scenario: scenarioOf(true),
        };
    });
}
