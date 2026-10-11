/**
 * DEMO ÇAYKUR license register. ÇAYKUR's real ruhsat database is not available yet, so this
 * builds a deterministic, clearly fake register on top of real TKGM parcels and real satellite
 * detection. Scenarios are mixed in on purpose so every decision-matrix class — and the record
 * problems described in the project brief (old pafta numbers, deceased holders, 1 da minimum) —
 * shows up in the demo. Replace with the real register as soon as it is provided.
 */

export interface DemoLicense {
    licenseNo: string;
    walletNo: string;
    holderName: string;
    holderDeceased: boolean;
    licensedAreaM2: number;
    issuedYear: number;
    /** Parcel reference as written on the license; old ones use pafta/parsel without a block. */
    recordedParcelRef: string;
    /** TKGM parcel key this license resolves to, or null when the old reference cannot be matched. */
    parcelKey: string | null;
    scenario: DemoScenario;
}

export type DemoScenario = 'matching' | 'inflated' | 'ghost' | 'understated' | 'title_not_tea' | 'unmatched_old_ref';

export interface ParcelForLicensing {
    key: string;
    block: string;
    parcel: string;
    nature: string;
    geometryAreaM2: number;
    teaShare: number | null;
    teaAreaM2: number | null;
}

const FIRST_NAMES = ['Mehmet', 'Ahmet', 'Mustafa', 'Hasan', 'Hüseyin', 'İsmail', 'Osman', 'Fatma', 'Ayşe', 'Emine', 'Hatice', 'Zeynep', 'Recep', 'Kadir', 'Yusuf', 'Halil'];
const LAST_NAMES = ['Demir', 'Yılmaz', 'Kara', 'Çelik', 'Şahin', 'Aydın', 'Öztürk', 'Kalkan', 'Topal', 'Bayraktar', 'Karadeniz', 'Uzun', 'Koç', 'Ermiş', 'Haliloğlu', 'Saral'];

/** Small deterministic PRNG so every export produces the same demo register. */
function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * The 1 da minimum applies to a whole license, which in reality may span several small parcels;
 * the demo keeps one license per parcel, so only a floor against degenerate areas is applied.
 */
const MIN_LICENSE_M2 = 100;
const isTeaTitle = (nature: string) => /çay/i.test(nature);

export function buildDemoLicenses(parcels: ParcelForLicensing[], seed = 2028): DemoLicense[] {
    const random = mulberry32(seed);
    const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)] as T;
    const licenses: DemoLicense[] = [];
    let serial = 0;

    const add = (parcel: ParcelForLicensing | null, scenario: DemoScenario, licensedAreaM2: number) => {
        serial++;
        const issuedYear = scenario === 'unmatched_old_ref' ? 1965 + Math.floor(random() * 20) : 1975 + Math.floor(random() * 45);
        licenses.push({
            licenseNo: `DEMO-R-${String(serial).padStart(5, '0')}`,
            walletNo: `DEMO-C-${String(50_000 + serial)}`,
            holderName: `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
            holderDeceased: issuedYear < 1990 && random() < 0.35,
            licensedAreaM2: Math.max(MIN_LICENSE_M2, Math.round(licensedAreaM2 / 10) * 10),
            issuedYear,
            recordedParcelRef: parcel && scenario !== 'unmatched_old_ref'
                ? `Ada ${parcel.block} / Parsel ${parcel.parcel}`
                : `Pafta ${1 + Math.floor(random() * 12)} / Parsel ${10 + Math.floor(random() * 400)}`,
            parcelKey: scenario === 'unmatched_old_ref' ? null : (parcel?.key ?? null),
            scenario,
        });
    };

    for (const parcel of parcels) {
        const share = parcel.teaShare ?? 0;
        const detected = parcel.teaAreaM2 ?? 0;
        const deed = parcel.geometryAreaM2;
        const roll = random();

        if (isTeaTitle(parcel.nature) && share >= 0.3) {
            // Most tea-titled gardens hold a license; some are inflated or understated on paper.
            if (roll < 0.62) add(parcel, 'matching', detected * (0.9 + random() * 0.2));
            else if (roll < 0.74) add(parcel, 'inflated', detected * (1.6 + random() * 1.2));
            else if (roll < 0.84) add(parcel, 'understated', detected * (0.45 + random() * 0.2));
            // else: tea title and tea on the ground, but never licensed → unlicensed
        } else if (isTeaTitle(parcel.nature) && share < 0.1) {
            // Tea on the title but nothing growing: the classic idle wallet.
            if (roll < 0.8) add(parcel, 'ghost', deed * (0.6 + random() * 0.4));
        } else if (!isTeaTitle(parcel.nature) && share >= 0.3 && !/orman|mezarlık|cami|okul/i.test(parcel.nature)) {
            // Licensed tea on a parcel whose deed title says something else: title ≠ license.
            if (roll < 0.3) add(parcel, 'title_not_tea', detected * (0.9 + random() * 0.2));
        }
    }

    // Licenses issued with pre-renewal pafta numbers that no longer resolve to a TKGM parcel.
    const unmatched = Math.max(3, Math.round(licenses.length * 0.06));
    for (let i = 0; i < unmatched; i++) {
        add(null, 'unmatched_old_ref', 1000 + random() * 4000);
    }
    return licenses;
}
