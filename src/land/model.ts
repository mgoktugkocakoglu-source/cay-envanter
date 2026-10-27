import type { ParcelClimate } from './climate.ts';
import type { ClassFractions, DwClass, SoilRaw, TerrainRaw } from './ee-layers.ts';
import { CROP_RULES, type CropRule, type FactorKey, type FactorRule } from './rules.ts';

/**
 * Land evaluation rules with their evidence (see sources.ts / rules.ts): slope classes and capability
 * proxy after the USDA/Turkish land-capability scheme, the 2026 regulation's land-class definitions,
 * a RUSLE index scaled like the Trabzon basin studies, and data-driven crop suitability.
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
    // R from annual rainfall as in the Trabzon RUSLE studies (R ≈ 38,5 + 0,35·P); short slope lengths for terraced hills.
    erosion: {
        rFormula: 'R = 38.5 + 0.35·P (Trabzon havza çalışmalarıyla uyumlu ölçek)',
        slopeLengthM: 20,
        classes: [2, 5, 10, 20],
        classLabels: ['Çok hafif', 'Hafif', 'Orta', 'Şiddetli', 'Çok şiddetli'],
        cover: { tea: 0.03, trees: 0.01, shrub: 0.05, pasture: 0.05, field: 0.3, bare: 0.8, built: 0.02, other: 0.15 },
        sources: ['renard-rusle-1997', 'cem-atlas-2018', 'ktu-catak-rusle', 'bartin-fol-rusle'],
    },
    floodProne: { maxHandM: 3, maxStreamDistM: 150 },
    built: { minFraction: 0.3 },
    tea: { minShare: 0.4 },
    capability: {
        sources: ['usda-akk', 'rg-2026-33214'],
        note: 'I–IV işlemeli tarıma uygun (mutlak tarım arazisi adayı), V ıslah gerektiren yüksek potansiyelli, VI–VII entansif ve korumalı tekniklerle özel ürüne uygun, VIII tarım dışı (RG 04.04.2026).',
    },
    data: { terrain: 'Copernicus DEM GLO-30 (TanDEM-X radar)', soil: 'OpenLandMap 250 m', landUse: 'Dynamic World 10 m (yıllık, May–Eyl mod), ESA WorldCover 2021, Landsat NDVI 1986→', water: 'MERIT Hydro, JRC Global Surface Water', climate: 'ERA5-Land + CHIRPS, MGM normallerine bağlı' },
} as const;

export type SlopeCode = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
export type AkkClass = 'I' | 'II' | 'III' | 'IV' | 'V' | 'VI' | 'VII' | 'VIII';
export type Law5403Class = 'MT' | 'OT' | 'DT' | 'TA' | 'TD';
export type DeclaredUse = 'tea' | 'hazelnut' | 'forest' | 'pasture' | 'field' | 'orchard' | 'built' | 'other';
export type ObservedUse = 'tea' | 'trees' | 'pasture' | 'field' | 'shrub' | 'built' | 'bare' | 'water' | 'wet' | 'unknown';
export type MismatchFlag = 'tea_title_no_tea' | 'abandoned_to_trees' | 'agri_to_built' | 'forest_cleared' | 'pasture_to_crops' | 'wet_or_water';
export type ErosionClass = 'very_low' | 'low' | 'moderate' | 'high' | 'very_high';
export type CropKey = 'tea' | 'hazelnut' | 'kiwi' | 'chestnut' | 'blueberry' | 'pasture' | 'vegetable' | 'forestry';

export const CROPS: Array<{ key: CropKey; label: string }> = CROP_RULES.map((c) => ({ key: c.key, label: c.label }));

export interface FactorResult {
    key: FactorKey;
    label: string;
    value: number | null;
    display: string;
    score: number;
    sources: string[];
    note: string;
}

export interface SuitabilityScore {
    crop: CropKey;
    score: number;
    limiting: string | null;
    factors: FactorResult[];
    legal: Array<{ label: string; sources: string[]; status: 'ok' | 'fail' | 'na' }>;
    /** Listed among the district's supported products (Tarım Havzaları). */
    supported: boolean;
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
        change: { from: DwClass; to: DwClass; fromYear: number; toYear: number } | null;
        /** Landsat summer NDVI by period since 1986 (vegetation density history). */
        ndviHistory: Array<{ period: string; ndvi: number | null; denseShare: number | null }>;
    };
    erosion: { index: number | null; class: ErosionClass | 'no_data'; factors: { R: number | null; K: number | null; LS: number | null; C: number | null }; sources: string[] };
    capability: { akk: AkkClass | null; limitations: string[]; law5403: Law5403Class | null; law5403Label: string; reasoning: string; sources: string[] };
    climate: ParcelClimate | null;
    suitability: SuitabilityScore[];
    recommendations: Array<{ text: string; sources: string[] }>;
}

export const LAW5403_LABEL: Record<Law5403Class, string> = {
    MT: 'Mutlak tarım arazisi',
    OT: 'Özel ürün arazisi',
    DT: 'Dikili tarım arazisi',
    TA: 'Marjinal tarım arazisi',
    TD: 'Tarım dışı (orman / koruma / yapı)',
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
    if (agri.includes(declared) && !titleHasBuilding && (latest.built ?? 0) >= LAND_RULES.built.minFraction) out.push('agri_to_built');
    if (declared === 'forest' && (observed === 'tea' || observed === 'field')) out.push('forest_cleared');
    if (declared === 'pasture' && observed === 'field') out.push('pasture_to_crops');
    if (observed === 'water' || observed === 'wet') out.push('wet_or_water');
    return out;
}

/** RUSLE-style annual soil loss index (t/ha/yr). */
export function erosionOf(terrain: TerrainRaw, soil: SoilRaw, observed: ObservedUse, annualPrecipMm: number | null): ParcelLandEvaluation['erosion'] {
    const sources = [...LAND_RULES.erosion.sources];
    if (terrain.slopePct === null || annualPrecipMm === null) return { index: null, class: 'no_data', factors: { R: null, K: null, LS: null, C: null }, sources };
    const R = 38.5 + 0.35 * annualPrecipMm;
    const silt = soil.siltPct ?? 35;
    const clay = soil.clayPct ?? 25;
    const soc = soil.socPct ?? 2;
    // K rises with silt and falls with clay and organic carbon (Wischmeier nomograph tendency), bounded to field values.
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
    return { index: Math.round(A * 10) / 10, class: cls, factors: { R: Math.round(R), K: Math.round(K * 1000) / 1000, LS: Math.round(LS * 100) / 100, C }, sources };
}

const AKK_ORDER: AkkClass[] = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];

export function capabilityOf(terrain: TerrainRaw, soil: SoilRaw, erosion: ErosionClass | 'no_data', observed: ObservedUse, declared: DeclaredUse, perennialSuitable: boolean): ParcelLandEvaluation['capability'] {
    const sources = [...LAND_RULES.capability.sources];
    if (terrain.slopePct === null) return { akk: null, limitations: ['Topografya verisi yok'], law5403: null, law5403Label: 'Değerlendirilemedi', reasoning: '', sources };
    const limitations: string[] = [];
    const s = terrain.slopePct;
    // Slope classes A–F of the Turkish standard drive the class; VIII beyond 60 % or under water.
    let idx = s < 2 ? 0 : s < 6 ? 1 : s < 12 ? 2 : s < 20 ? 3 : s < 30 ? 5 : s < 60 ? 6 : 7;
    if (s >= 12) limitations.push(`Eğim %${Math.round(s)} (${slopeClassOf(s).label})`);
    const floodProne = (terrain.handM ?? 99) <= LAND_RULES.floodProne.maxHandM && (terrain.streamDistM ?? 9999) <= LAND_RULES.floodProne.maxStreamDistM;
    if (floodProne && s < 6) {
        idx = Math.max(idx, 4);
        limitations.push('Taşkın / yüksek taban suyu riski (dere kenarı, düşük HAND) — w sınırlaması');
    } else if (floodProne) limitations.push('Dere kenarı, taşkın riski');
    if (erosion === 'high' || erosion === 'very_high') {
        if (idx < 6) idx += 1;
        limitations.push(`Erozyon riski ${erosion === 'very_high' ? 'çok şiddetli' : 'şiddetli'} — e sınırlaması`);
    }
    if ((soil.sandPct ?? 0) > 80 || (soil.clayPct ?? 0) > 60) {
        if (idx < 3) idx += 1;
        limitations.push((soil.sandPct ?? 0) > 80 ? 'Çok kumlu toprak (su tutmaz) — s sınırlaması' : 'Ağır killi toprak (drenaj) — s sınırlaması');
    }
    if ((soil.ph ?? 6) < 4.5) limitations.push('Çok asit toprak (pH < 4,5)');
    if (observed === 'water') idx = 7;
    if (observed === 'built') limitations.push('Yapılaşmış');
    const akk = AKK_ORDER[Math.min(7, idx)]!;
    const perennial = observed === 'tea' || declared === 'tea' || declared === 'hazelnut' || declared === 'orchard';
    let law: Law5403Class;
    let reasoning: string;
    if (akk === 'VIII' || observed === 'water') {
        law = 'TD';
        reasoning = 'VIII. sınıf / su altı: tarım arazisi tanımı dışında.';
    } else if (observed === 'built') {
        law = 'TD';
        reasoning = 'Yapılaşmış parsel: tarım dışı kullanım; tarım arazisi vasfı toprak etüdüyle belirlenir.';
    } else if (akk === 'I' || akk === 'II' || akk === 'III' || akk === 'IV') {
        law = 'MT';
        reasoning = `AKK ${akk}: topoğrafik sınırlaması yok/az, Ek-1’e göre I–IV. sınıf → mutlak tarım arazisi adayı${perennial ? ' (hâlihazır dikili ürün altında)' : ''}.`;
    } else if (akk === 'V') {
        law = 'MT';
        reasoning = 'AKK V: fiziksel/kimyasal ıslah gerektiren, tarımsal potansiyeli yüksek arazi (drenaj/taşkın önlemiyle mutlak tarım).';
    } else if (perennial || perennialSuitable) {
        law = 'OT';
        reasoning = `AKK ${akk}: toprak ve topoğrafik sınırlamalar nedeniyle her tür yetişmez; 2026 Yönetmeliği VI–VII. sınıfı entansif ve korumalı tekniklerle özel ürün üretimine uygun sayar → özel ürün arazisi (çay/fındık). Uygulamada çaylıklar dikili tarım arazisi olarak da vasıflandırılır; her iki sınıf da 5403 md. 13 ile tarım dışı kullanıma kapalıdır.`;
    } else if (observed === 'trees' || declared === 'forest') {
        law = 'TD';
        reasoning = `AKK ${akk} ve orman örtüsü: koruma / orman kullanımı.`;
    } else {
        law = 'TA';
        reasoning = `AKK ${akk}: yalnız geleneksel toprak işlemeli tarım; marjinal tarım arazisi.`;
    }
    return { akk, limitations, law5403: law, law5403Label: LAW5403_LABEL[law], reasoning, sources };
}

/** Piecewise score: 0 at/below lo0 or at/above hi0, 100 between lo1 and hi1, linear in between. */
function band(v: number | null, [lo0, lo1, hi1, hi0]: FactorRule['band']): number {
    if (v === null || Number.isNaN(v)) return 60;
    if (v <= lo0 || v >= hi0) return 0;
    if (v >= lo1 && v <= hi1) return 100;
    return v < lo1 ? Math.round(((v - lo0) / (lo1 - lo0)) * 100) : Math.round(((hi0 - v) / (hi0 - hi1)) * 100);
}

export interface SuitabilityInputs {
    terrain: TerrainRaw;
    soil: SoilRaw;
    climate: ParcelClimate | null;
    erosion: ErosionClass | 'no_data';
    floodProne: boolean;
    supportedCrops: Set<CropKey>;
}

function factorValue(key: FactorKey, inp: SuitabilityInputs): number | null {
    const c = inp.climate;
    switch (key) {
        case 'elevation': return inp.terrain.elevationM;
        case 'slope': return inp.terrain.slopePct;
        case 'ph': return inp.soil.ph;
        case 'precip': return c?.precipMm ?? null;
        case 'tmean': return c?.tmean ?? null;
        case 'tminAbs': return c?.tminAbs ?? null;
        case 'tmaxAbs': return c?.tmaxAbs ?? null;
        case 'frostDays': return c?.frostDays ?? null;
        case 'hotDays': return c?.hotDays ?? null;
        case 'julyMean': return c && !Number.isNaN(c.julyMean) ? c.julyMean : null;
        case 'rhSummer': return c && !Number.isNaN(c.rhSummer) ? c.rhSummer : null;
        case 'chillHours': return c?.chillHours ?? null;
        case 'frostFreeDays': return c?.frostFreeDays ?? null;
        case 'springFrostDays': return c?.springFrostDays ?? null;
        case 'bloomRainDays': return c?.bloomRainDays ?? null;
        case 'drainage': return inp.floodProne ? 0 : 100;
        case 'erosion': return inp.erosion === 'no_data' ? null : inp.erosion === 'very_high' ? 30 : inp.erosion === 'high' ? 60 : inp.erosion === 'moderate' ? 85 : 100;
        case 'lime': return null;
    }
}

function legalStatus(rule: CropRule['legal'][number], inp: SuitabilityInputs): 'ok' | 'fail' | 'na' {
    if (rule.kind === 'hazelnut-planting-zone') {
        if (inp.terrain.elevationM === null || inp.terrain.slopePct === null) return 'na';
        return inp.terrain.elevationM <= 750 && inp.terrain.slopePct >= 12 ? 'ok' : 'fail';
    }
    return 'na';
}

export function suitabilityOf(inp: SuitabilityInputs): SuitabilityScore[] {
    return CROP_RULES.map((rule) => {
        const factors: FactorResult[] = rule.factors.map((f) => {
            const value = factorValue(f.key, inp);
            const score = band(value, f.band);
            const display = value === null ? 'veri yok' : f.key === 'drainage' ? (value === 0 ? 'taşkın riski' : 'uygun') : f.key === 'erosion' ? `${inp.erosion}` : `${value.toFixed(f.digits)}${f.unit}`;
            return { key: f.key, label: f.label, value: value === null ? null : Math.round(value * 100) / 100, display, score, sources: f.sources, note: f.note };
        });
        let min = 100;
        let limiting: string | null = null;
        for (const f of factors) {
            if (f.score < min) {
                min = f.score;
                limiting = `${f.label} ${f.display}`;
            }
        }
        return {
            crop: rule.key,
            score: Math.round(min),
            limiting: min >= 100 ? null : limiting,
            factors,
            legal: rule.legal.map((l) => ({ label: l.label, sources: l.sources, status: legalStatus(l, inp) })),
            supported: inp.supportedCrops.has(rule.key),
        };
    }).sort((a, b) => b.score - a.score);
}

export function recommendationsOf(e: Omit<ParcelLandEvaluation, 'recommendations'>): Array<{ text: string; sources: string[] }> {
    const r: Array<{ text: string; sources: string[] }> = [];
    const s = e.terrain.slopePct ?? 0;
    const obs = e.landUse.observed;
    const score = (c: CropKey) => e.suitability.find((x) => x.crop === c)?.score ?? 0;
    if ((e.erosion.class === 'high' || e.erosion.class === 'very_high') && (obs === 'field' || obs === 'bare')) r.push({ text: 'Erozyon riski şiddetli açık arazi: teraslama, örtü bitkisi ya da dikili ürüne (çay/fındık) geçiş; Su Erozyonu Atlası sınıfına göre koruma önceliği.', sources: ['cem-atlas-2018', 'omu-rize-erozyon'] });
    if (s >= 30 && (obs === 'field' || obs === 'pasture')) r.push({ text: '%30 üstü eğimde yıllık ürün/mera sürdürülebilir değil (AKK VI–VII): entansif ve korumalı tekniklerle özel ürün ya da ağaçlandırma.', sources: ['rg-2026-33214', 'usda-akk'] });
    if (e.capability.limitations.some((l) => l.startsWith('Taşkın'))) r.push({ text: 'Dere kenarı / taşkın riski: drenaj ve set olmadan sera ve yıllık ürün kurulmamalı; kivi için taban suyu yüksek toprak uygun değil.', sources: ['merit-hydro', 'tagem-kivi-2022'] });
    if (e.landUse.mismatches.includes('abandoned_to_trees')) r.push({ text: 'Tapuda tarla/çayır olan parsel ağaçlaşmış (terk edilmiş tarım arazisi): yeniden kazanım için mera ya da dikili ürün planlanabilir; 1986’dan bugüne NDVI tarihi değişimi gösterir.', sources: ['landsat', 'dynamic-world'] });
    if (e.landUse.mismatches.includes('agri_to_built')) r.push({ text: 'Tarım arazisinde yapılaşma görülüyor: 5403 sayılı Kanun ve 2026 Yönetmeliği kapsamında tarım dışı kullanım izni kontrol edilmeli.', sources: ['kanun-5403', 'rg-2026-33214'] });
    if (e.landUse.mismatches.includes('tea_title_no_tea')) r.push({ text: 'Tapuda çay bahçesi, uyduda çay örtüsü yok: ruhsat alanı ve kota kaydı sahada doğrulanmalı; ruhsatsız alanda destek ödenmez.', sources: ['karar-6243', 'tzob-cay'] });
    if (e.landUse.mismatches.includes('forest_cleared')) r.push({ text: 'Orman nitelikli parselde tarım örtüsü: orman kadastrosu / 2B durumu incelenmeli.', sources: ['kanun-5403'] });
    if (e.capability.law5403 === 'MT' && (obs === 'trees' || obs === 'shrub')) r.push({ text: 'Mutlak tarım arazisi niteliğinde (AKK I–IV) ama tarım dışı örtüde: tarımsal üretime kazandırılabilir.', sources: ['rg-2026-33214'] });
    const hz = e.suitability.find((x) => x.crop === 'hazelnut');
    if (hz && hz.score >= 70 && hz.legal[0]?.status === 'fail') r.push({ text: 'Fındık ekolojik olarak uygun ama 2844 sayılı Kanun dikim alanı ölçütü (≤750 m ve eğim ≥%12) sağlanmıyor; dikim izni alınamaz.', sources: ['kanun-2844'] });
    if (score('kiwi') >= 70 && obs !== 'built') r.push({ text: 'Kivi için taban arazi, donsuz dönem ve soğuklama uygun; telli terbiye ve rüzgâr koruması ile düşünülebilir (Doğu Karadeniz uygun bölge).', sources: ['tagem-kivi-2022', 'yalova-kivi'] });
    if (score('blueberry') >= 70 && obs !== 'tea' && obs !== 'built') r.push({ text: 'Asit toprak ve soğuklama yaban mersini (maviyemiş) için uygun; KTAE 1. iklim tipi şartları.', sources: ['ktae-maviyemis-2025'] });
    if (score('chestnut') >= 80 && obs === 'trees') r.push({ text: 'Kestane kuşağında orman örtüsü: kestane balı için çiçeklenme döneminde (1 Haz–15 Tem) yağışlı gün sayısı yıllık verimi belirler; iklim görünümünde izlenir.', sources: ['duzce-kestane-bali-ci', 'ayder-bali-ci'] });
    if ((e.soil.ph ?? 6) < 4.5 && obs !== 'tea') r.push({ text: 'Toprak çok asit: çay ve yaban mersini dışındaki ürünler için kireçleme gerekir.', sources: ['au-findik-ders', 'rize-ph-tez'] });
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
