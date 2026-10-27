import type { ParcelClimate } from './climate.ts';
import type { ClassFractions, DwClass, SoilRaw, TerrainRaw } from './ee-layers.ts';

/**
 * Land evaluation rules (Toprak Koruma ve Arazi Kullanımı Kanunu 5403 mantığı): slope classes, a
 * RUSLE-style erosion index, a land-capability class proxy (AKK I–VIII), the 5403 land class
 * suggestion and crop suitability with limiting factors. Every threshold is an approximation from
 * public literature for a desk-top pre-assessment; soil depth, stoniness and drainage need a field survey.
 */
export const LAND_RULES = {
    slopeClasses: [
        { code: 'A', max: 2, label: 'Düz' },
        { code: 'B', max: 6, label: 'Hafif eğimli' },
        { code: 'C', max: 12, label: 'Orta eğimli' },
        { code: 'D', max: 20, label: 'Dik' },
        { code: 'E', max: 30, label: 'Çok dik' },
        { code: 'F', max: 45, label: 'Sarp' },
        { code: 'G', max: Infinity, label: 'Çok sarp' },
    ],
    // Short slope lengths (field edges, terraces) and the dense perennial canopy of tea keep the RUSLE index honest.
    erosion: { slopeLengthM: 20, classes: [2, 5, 10, 20], cover: { tea: 0.01, trees: 0.01, shrub: 0.05, pasture: 0.05, field: 0.3, bare: 0.8, built: 0.02, other: 0.15 } },
    floodProne: { maxHandM: 3, maxStreamDistM: 150 },
    built: { minFraction: 0.3 },
    tea: { minShare: 0.4 },
    weights: { terrain: 'Copernicus DEM GLO-30 (TanDEM-X radar)', soil: 'SoilGrids 250 m, OpenLandMap', landUse: 'Dynamic World 10 m (yıllık, May–Eyl mod), ESA WorldCover 2021', water: 'MERIT Hydro, JRC Global Surface Water' },
} as const;

export type SlopeCode = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
export type AkkClass = 'I' | 'II' | 'III' | 'IV' | 'V' | 'VI' | 'VII' | 'VIII';
export type Law5403Class = 'MT' | 'OT' | 'DT' | 'TA' | 'TD';
export type DeclaredUse = 'tea' | 'hazelnut' | 'forest' | 'pasture' | 'field' | 'orchard' | 'built' | 'other';
export type ObservedUse = 'tea' | 'trees' | 'pasture' | 'field' | 'shrub' | 'built' | 'bare' | 'water' | 'wet' | 'unknown';
export type MismatchFlag = 'tea_title_no_tea' | 'abandoned_to_trees' | 'agri_to_built' | 'forest_cleared' | 'pasture_to_crops' | 'wet_or_water';
export type ErosionClass = 'very_low' | 'low' | 'moderate' | 'high' | 'very_high';
export type CropKey = 'tea' | 'hazelnut' | 'kiwi' | 'chestnut' | 'blueberry' | 'pasture' | 'vegetable' | 'forestry';

export const CROPS: Array<{ key: CropKey; label: string }> = [
    { key: 'tea', label: 'Çay' },
    { key: 'hazelnut', label: 'Fındık' },
    { key: 'kiwi', label: 'Kivi' },
    { key: 'chestnut', label: 'Kestane (bal / kereste)' },
    { key: 'blueberry', label: 'Yaban mersini' },
    { key: 'pasture', label: 'Mera / yem bitkisi' },
    { key: 'vegetable', label: 'Sebze / sera' },
    { key: 'forestry', label: 'Ağaçlandırma / koruma' },
];

export interface SuitabilityScore {
    crop: CropKey;
    score: number;
    /** Factor that set the score (lowest), with its value. */
    limiting: string | null;
}

export interface ParcelLandEvaluation {
    key: string;
    block: string;
    parcel: string;
    nature: string;
    areaM2: number;
    terrain: TerrainRaw & { slopeClass: SlopeCode; slopeLabel: string; aspectLabel: string | null };
    soil: SoilRaw & { textureLabel: string | null; phLabel: string | null };
    landUse: {
        declared: DeclaredUse;
        observed: ObservedUse;
        teaShare: number | null;
        latestYear: number | null;
        latest: ClassFractions;
        history: Array<{ year: number; dominant: DwClass | null; fractions: ClassFractions }>;
        worldcover: Record<string, number>;
        mismatches: MismatchFlag[];
        /** First → last dominant class when they differ. */
        change: { from: DwClass; to: DwClass; fromYear: number; toYear: number } | null;
    };
    erosion: { index: number | null; class: ErosionClass | 'no_data'; factors: { R: number | null; K: number | null; LS: number | null; C: number | null } };
    capability: { akk: AkkClass | null; limitations: string[]; law5403: Law5403Class | null; law5403Label: string };
    suitability: SuitabilityScore[];
    recommendations: string[];
}

export const LAW5403_LABEL: Record<Law5403Class, string> = {
    MT: 'Mutlak tarım arazisi',
    OT: 'Özel ürün arazisi',
    DT: 'Dikili tarım arazisi',
    TA: 'Marjinal tarım arazisi',
    TD: 'Tarım dışı (orman / mera / koruma)',
};

const TEXTURE_LABELS: Record<number, string> = { 1: 'Kil', 2: 'Siltli kil', 3: 'Kumlu kil', 4: 'Killi tın', 5: 'Siltli killi tın', 6: 'Kumlu killi tın', 7: 'Tın', 8: 'Siltli tın', 9: 'Kumlu tın', 10: 'Silt', 11: 'Tınlı kum', 12: 'Kum' };

export function slopeClassOf(pct: number | null): { code: SlopeCode; label: string } {
    if (pct === null) return { code: 'C', label: 'Bilinmiyor' };
    const c = LAND_RULES.slopeClasses.find((s) => pct < s.max) ?? LAND_RULES.slopeClasses.at(-1)!;
    return { code: c.code as SlopeCode, label: c.label };
}

export function aspectLabel(deg: number | null): string | null {
    if (deg === null) return null;
    const names = ['Kuzey', 'Kuzeydoğu', 'Doğu', 'Güneydoğu', 'Güney', 'Güneybatı', 'Batı', 'Kuzeybatı'];
    return names[Math.round(deg / 45) % 8]!;
}

export function declaredUseOf(nature: string): DeclaredUse {
    const t = nature.toLocaleLowerCase('tr');
    if (/çay/.test(t)) return 'tea';
    if (/fındık|findik/.test(t)) return 'hazelnut';
    if (/orman|koru|ağaçlık|agaclik|fundalık/.test(t)) return 'forest';
    if (/çayır|mera|otlak/.test(t)) return 'pasture';
    if (/bağ|meyve|kivi|kestane|zeytin|narenciye/.test(t)) return 'orchard';
    if (/tarla|bahçe|sebze/.test(t)) return 'field';
    if (/ev|bina|kargir|ahşap|arsa|dükkan|fabrika|depo|yol|mezar/.test(t)) return 'built';
    return 'other';
}

function dominant(f: ClassFractions): DwClass | null {
    let best: DwClass | null = null;
    let bestV = 0;
    for (const [k, v] of Object.entries(f) as Array<[DwClass, number]>) {
        if (v > bestV) {
            best = k;
            bestV = v;
        }
    }
    return best;
}

export function observedUseOf(latest: ClassFractions, teaShare: number | null): ObservedUse {
    if ((teaShare ?? 0) >= LAND_RULES.tea.minShare) return 'tea';
    if ((latest.built ?? 0) >= LAND_RULES.built.minFraction) return 'built';
    const d = dominant(latest);
    switch (d) {
        case 'trees': return 'trees';
        case 'grass': return 'pasture';
        case 'crops': return 'field';
        case 'shrub_and_scrub': return 'shrub';
        case 'built': return 'built';
        case 'bare': return 'bare';
        case 'water': return 'water';
        case 'flooded_vegetation': return 'wet';
        default: return 'unknown';
    }
}

export function mismatchesOf(declared: DeclaredUse, observed: ObservedUse, latest: ClassFractions, teaShare: number | null, nature = ''): MismatchFlag[] {
    const out: MismatchFlag[] = [];
    const titleHasBuilding = /ev|bina|kargir|ahşap|okul|cami|dükkan|fabrika|depo/.test(nature.toLocaleLowerCase('tr'));
    const agri: DeclaredUse[] = ['tea', 'hazelnut', 'field', 'orchard', 'pasture'];
    if (declared === 'tea' && (teaShare ?? 0) < 0.1 && observed !== 'unknown') out.push('tea_title_no_tea');
    if ((declared === 'field' || declared === 'pasture') && observed === 'trees') out.push('abandoned_to_trees');
    // A deed title that already names a building ("Ev ve Çay Bahçesi") is not farmland turned built.
    if (agri.includes(declared) && !titleHasBuilding && (latest.built ?? 0) >= LAND_RULES.built.minFraction) out.push('agri_to_built');
    if (declared === 'forest' && (observed === 'tea' || observed === 'field')) out.push('forest_cleared');
    if (declared === 'pasture' && observed === 'field') out.push('pasture_to_crops');
    if (observed === 'water' || observed === 'wet') out.push('wet_or_water');
    return out;
}

/** RUSLE-style annual soil loss index (t/ha/yr): R from annual rainfall, K from texture, LS from slope, C from cover. */
export function erosionOf(terrain: TerrainRaw, soil: SoilRaw, observed: ObservedUse, annualPrecipMm: number | null) {
    if (terrain.slopePct === null || annualPrecipMm === null) return { index: null, class: 'no_data' as const, factors: { R: null, K: null, LS: null, C: null } };
    const P = annualPrecipMm;
    const R = P < 850 ? 0.0483 * P ** 1.61 : 587.8 - 1.219 * P + 0.004105 * P ** 2;
    // K by topsoil texture: silt-rich soils erode easily, clay and sand resist.
    const silt = soil.siltPct ?? 35;
    const clay = soil.clayPct ?? 25;
    const soc = soil.socPct ?? 2;
    const K = Math.max(0.01, Math.min(0.06, 0.02 + 0.0006 * silt - 0.0002 * clay - 0.002 * Math.min(soc, 4)));
    const theta = Math.atan(terrain.slopePct / 100);
    const sin = Math.sin(theta);
    const m = terrain.slopePct < 1 ? 0.2 : terrain.slopePct < 3 ? 0.3 : terrain.slopePct < 5 ? 0.4 : 0.5;
    const LS = (LAND_RULES.erosion.slopeLengthM / 22.13) ** m * (65.41 * sin * sin + 4.56 * sin + 0.065);
    const cover = LAND_RULES.erosion.cover as Record<string, number>;
    const C = cover[observed] ?? cover.other!;
    const A = R * K * LS * C;
    const [c1, c2, c3, c4] = LAND_RULES.erosion.classes;
    const cls: ErosionClass = A < c1 ? 'very_low' : A < c2 ? 'low' : A < c3 ? 'moderate' : A < c4 ? 'high' : 'very_high';
    return { index: Math.round(A * 10) / 10, class: cls, factors: { R: Math.round(R), K: Math.round(K * 1000) / 1000, LS: Math.round(LS * 100) / 100, C } };
}

const AKK_ORDER: AkkClass[] = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];

export function capabilityOf(terrain: TerrainRaw, soil: SoilRaw, erosion: ErosionClass | 'no_data', observed: ObservedUse, declared: DeclaredUse): ParcelLandEvaluation['capability'] {
    if (terrain.slopePct === null) return { akk: null, limitations: ['Topografya verisi yok'], law5403: null, law5403Label: 'Değerlendirilemedi' };
    const limitations: string[] = [];
    const s = terrain.slopePct;
    // I–IV arable by slope; VI/VII perennial or grazing land; VIII only beyond 60 % or under water.
    let idx = s < 2 ? 0 : s < 6 ? 1 : s < 12 ? 2 : s < 20 ? 3 : s < 30 ? 5 : s < 60 ? 6 : 7;
    if (s >= 12) limitations.push(`Eğim %${Math.round(s)}`);
    const floodProne = (terrain.handM ?? 99) <= LAND_RULES.floodProne.maxHandM && (terrain.streamDistM ?? 9999) <= LAND_RULES.floodProne.maxStreamDistM;
    if (floodProne && s < 6) {
        idx = Math.max(idx, 4);
        limitations.push('Taşkın / yüksek taban suyu riski (dere kenarı, düşük HAND)');
    } else if (floodProne) limitations.push('Dere kenarı, taşkın riski');
    if (erosion === 'high' || erosion === 'very_high') {
        if (idx < 6) idx += 1;
        limitations.push(`Erozyon riski ${erosion === 'very_high' ? 'çok yüksek' : 'yüksek'}`);
    }
    if ((soil.sandPct ?? 0) > 80 || (soil.clayPct ?? 0) > 60) {
        if (idx < 3) idx += 1;
        limitations.push((soil.sandPct ?? 0) > 80 ? 'Çok kumlu toprak (su tutmaz)' : 'Ağır killi toprak (drenaj)');
    }
    if ((soil.ph ?? 6) < 4.5) limitations.push('Çok asit toprak (pH < 4,5)');
    if (observed === 'water') idx = 7;
    if (observed === 'built') limitations.push('Yapılaşmış');
    const akk = AKK_ORDER[Math.min(7, idx)]!;
    let law: Law5403Class;
    const perennial = observed === 'tea' || declared === 'tea' || declared === 'hazelnut' || declared === 'orchard';
    // 5403: land under perennial crops is dikili tarım whatever its slope class; VIII and forest stay outside agriculture.
    if (akk === 'VIII') law = 'TD';
    else if (perennial && observed !== 'trees' && s <= 60) law = 'DT';
    else if (akk === 'VII') law = 'TD';
    else if (akk === 'V') law = 'OT';
    else if (akk === 'I' || akk === 'II' || akk === 'III' || akk === 'IV') law = 'MT';
    else law = 'TA';
    if (observed === 'trees' && declared === 'forest') law = 'TD';
    return { akk, limitations, law5403: law, law5403Label: LAW5403_LABEL[law] };
}

/** Factor label with its value, or a "veri yok" note when the layer had no value. */
function fl(name: string, v: number | null | undefined, unit = '', digits = 0): string {
    return v === null || v === undefined || Number.isNaN(v) ? `${name} (veri yok)` : `${name} ${v.toFixed(digits)}${unit}`;
}

/** Piecewise score: 0 below `lo0`/above `hi0`, 100 between `lo1` and `hi1`, linear in between. */
function band(v: number | null, lo0: number, lo1: number, hi1: number, hi0: number): number {
    if (v === null || Number.isNaN(v)) return 60;
    if (v <= lo0 || v >= hi0) return 0;
    if (v >= lo1 && v <= hi1) return 100;
    return v < lo1 ? Math.round(((v - lo0) / (lo1 - lo0)) * 100) : Math.round(((hi0 - v) / (hi0 - hi1)) * 100);
}

export function suitabilityOf(terrain: TerrainRaw, soil: SoilRaw, climate: ParcelClimate | null, erosion: ErosionClass | 'no_data', floodProne: boolean): SuitabilityScore[] {
    const slope = terrain.slopePct;
    const elev = terrain.elevationM;
    const ph = soil.ph;
    const precip = climate?.precipMm ?? null;
    const frost = climate?.frostDays ?? null;
    const hot = climate?.hotDays ?? null;
    const tminAbs = climate?.tminAbs ?? null;
    const tmean = climate?.tmean ?? null;
    const july = climate && !Number.isNaN(climate.julyMean) ? climate.julyMean : null;
    const flood = floodProne ? 0 : 100;
    const erosionPenalty = erosion === 'very_high' ? 40 : erosion === 'high' ? 70 : 100;
    const factors = (list: Array<[string, number]>): SuitabilityScore => {
        let min = 100;
        let limiting: string | null = null;
        for (const [name, s] of list) {
            if (s < min) {
                min = s;
                limiting = name;
            }
        }
        return { crop: 'tea', score: Math.round(min), limiting: min >= 100 ? null : limiting };
    };
    const rows: SuitabilityScore[] = [
        { ...factors([[fl('yükselti', elev, ' m'), band(elev, -1, 0, 700, 1100)], [fl('eğim %', slope), band(slope, -1, 0, 35, 60)], [fl('pH', ph, '', 1), band(ph, 3.8, 4.5, 6.0, 7.0)], [fl('yıllık yağış', precip, ' mm'), band(precip, 800, 1200, 4000, 5000)], [fl('don günü/yıl', frost), band(frost, -1, 0, 60, 130)], [fl('en düşük sıcaklık', tminAbs, ' °C', 1), band(tminAbs, -18, -10, 50, 60)], [fl('yıllık ort. sıcaklık', tmean, ' °C', 1), band(tmean, 7, 11, 22, 28)], ['erozyon', erosionPenalty], ['taşkın', flood]]), crop: 'tea' },
        { ...factors([[fl('yükselti', elev, ' m'), band(elev, -1, 0, 600, 900)], [fl('eğim %', slope), band(slope, -1, 0, 30, 50)], [fl('pH', ph, '', 1), band(ph, 4.5, 5.5, 7.0, 8.0)], [fl('yıllık yağış', precip, ' mm'), band(precip, 500, 750, 3000, 5000)], [fl('don günü/yıl', frost), band(frost, -1, 0, 70, 140)], [fl('en düşük sıcaklık', tminAbs, ' °C', 1), band(tminAbs, -22, -14, 50, 60)], ['erozyon', erosionPenalty]]), crop: 'hazelnut' },
        { ...factors([[fl('yükselti', elev, ' m'), band(elev, -1, 0, 350, 600)], [fl('eğim %', slope), band(slope, -1, 0, 8, 15)], [fl('pH', ph, '', 1), band(ph, 4.8, 5.5, 7.0, 7.8)], [fl('don günü/yıl', frost), band(frost, -1, 0, 25, 60)], [fl('en düşük sıcaklık', tminAbs, ' °C', 1), band(tminAbs, -14, -8, 50, 60)], [fl('30 °C üstü gün/yıl', hot), band(hot, -1, 0, 20, 45)], ['taşkın / drenaj', flood], ['erozyon', erosionPenalty]]), crop: 'kiwi' },
        { ...factors([[fl('yükselti', elev, ' m'), band(elev, 50, 300, 1100, 1400)], [fl('eğim %', slope), band(slope, -1, 0, 45, 70)], [fl('pH', ph, '', 1), band(ph, 3.8, 4.5, 6.5, 7.5)], [fl('yıllık yağış', precip, ' mm'), band(precip, 600, 900, 3000, 5000)], ['taşkın / drenaj', flood]]), crop: 'chestnut' },
        { ...factors([[fl('pH', ph, '', 1), band(ph, 3.5, 4.0, 5.5, 6.3)], [fl('eğim %', slope), band(slope, -1, 0, 15, 30)], [fl('yükselti', elev, ' m'), band(elev, -1, 0, 1000, 1400)], ['taşkın / drenaj', flood], [fl('don günü/yıl', frost), band(frost, -1, 0, 80, 150)]]), crop: 'blueberry' },
        { ...factors([[fl('eğim %', slope), band(slope, -1, 0, 30, 60)], [fl('yıllık yağış', precip, ' mm'), band(precip, 300, 500, 4000, 6000)], ['erozyon', Math.max(erosionPenalty, 60)]]), crop: 'pasture' },
        { ...factors([[fl('eğim %', slope), band(slope, -1, 0, 5, 12)], [fl('yükselti', elev, ' m'), band(elev, -1, 0, 700, 1200)], [fl('pH', ph, '', 1), band(ph, 4.8, 6.0, 7.2, 8.0)], ['taşkın / drenaj', flood], [fl('temmuz ort.', july, ' °C'), band(july, 10, 16, 26, 32)]]), crop: 'vegetable' },
        { ...factors([[fl('eğim %', slope), slope === null ? 60 : slope >= 30 ? 100 : Math.round((slope / 30) * 100)], ['erozyon', erosion === 'very_high' || erosion === 'high' ? 100 : erosion === 'moderate' ? 70 : 40]]), crop: 'forestry' },
    ];
    return rows.sort((a, b) => b.score - a.score);
}

export function recommendationsOf(e: Omit<ParcelLandEvaluation, 'recommendations'>): string[] {
    const r: string[] = [];
    const s = e.terrain.slopePct ?? 0;
    const obs = e.landUse.observed;
    if ((e.erosion.class === 'high' || e.erosion.class === 'very_high') && (obs === 'field' || obs === 'bare')) r.push('Erozyon riski yüksek açık arazi: teraslama, örtü bitkisi ya da dikili ürüne geçiş (çay/fındık) önerilir.');
    if (s >= 30 && (obs === 'field' || obs === 'pasture')) r.push('%30 üzeri eğimde yıllık ürün/mera sürdürülebilir değil; dikili tarım ya da ağaçlandırma ile koruma altına alınmalı.');
    if (e.capability.limitations.some((l) => l.startsWith('Taşkın'))) r.push('Dere kenarı / taşkın riski: drenaj ve set olmadan sera ve yıllık ürün kurulmamalı; suya dayanıklı dikili ürün ya da ıslak çayır uygun.');
    if (e.landUse.mismatches.includes('abandoned_to_trees')) r.push('Tapuda tarla/çayır olan parsel ağaçlaşmış (terk edilmiş tarım arazisi): yeniden kazanım için mera ya da dikili ürün planlanabilir.');
    if (e.landUse.mismatches.includes('agri_to_built')) r.push('Tarım arazisinde yapılaşma görülüyor: 5403 sayılı Kanun kapsamında tarım dışı kullanım izni kontrol edilmeli.');
    if (e.landUse.mismatches.includes('tea_title_no_tea')) r.push('Tapuda çay bahçesi, uyduda çay örtüsü yok: ruhsat alanı ve kota kaydı sahada doğrulanmalı.');
    if (e.landUse.mismatches.includes('forest_cleared')) r.push('Orman nitelikli parselde tarım örtüsü: orman kadastrosu / 2B durumu incelenmeli.');
    if (e.capability.law5403 === 'MT' && (obs === 'trees' || obs === 'shrub')) r.push('Mutlak tarım arazisi niteliğinde ama tarım dışı örtüde: tarımsal üretime kazandırılabilir.');
    const best = e.suitability[0];
    if (best && best.score >= 70 && best.crop !== 'forestry' && best.crop !== 'pasture') {
        const label = CROPS.find((c) => c.key === best.crop)?.label ?? best.crop;
        if (!(best.crop === 'tea' && obs === 'tea')) r.push(`Uygunluk puanı en yüksek ürün: ${label} (${best.score}/100).`);
    }
    if ((e.soil.ph ?? 6) < 4.5 && obs !== 'tea') r.push('Toprak çok asit: çay ve yaban mersini dışındaki ürünler için kireçleme gerekir.');
    return r;
}

export function textureLabel(code: number | null): string | null {
    return code === null ? null : (TEXTURE_LABELS[code] ?? null);
}

export function phLabel(ph: number | null): string | null {
    if (ph === null) return null;
    return ph < 4.5 ? 'Çok asit' : ph < 5.5 ? 'Asit' : ph < 6.5 ? 'Hafif asit' : ph < 7.5 ? 'Nötr' : 'Alkali';
}

export { dominant as dominantClass };
