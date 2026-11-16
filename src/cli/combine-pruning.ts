import { repeatedCellArea } from '../pruning/repeated-ground.ts';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { NeighborhoodStore } from '../library/store.ts';
import type { FusionSeasonFile } from './fuse-pruning.ts';
import { addDays, PixelTimeline, type RepeatCheck } from '../pruning/pixel-timeline.ts';

const USAGE = `
Kullanım:
  npm run combine-pruning -- --province Trabzon --district Of --neighborhood Çataldere --season 2025

Birleşik budama kararı (ayrı modül): çok-sensör kararı (fuse-pruning) ile piksel taramasını (scan-pixels) bahçe
başına tek karara indirir. İki modülün hiçbirini değiştirmez; yalnızca çıktılarını okur.
  uyumlu   : iki modül de aynı olayı gördü (değişim tarihleri ${45} gün içinde)
  muhtemel : yalnız biri gördü (çok-sensör budandı/olası ya da piksel taraması derin budama)
  hafif    : yalnız piksel taraması, hızlı toparlanan kesim (1/7 hesabına girmez)
  mevsimsel: “muhtemel” olacaktı ama aynı piksellerde aynı düşüş bir önceki sezonda, aynı dönemde de var (1/7 hesabına girmez)
Toparlanması henüz izlenemeyen (bekleyen) kesimler ve yalnız piksel taramasının gördüğü hafif kesimler hedef hesabına girmez.
Alan piksel taramasının çizdiği kümeden, o yoksa çok-sensörün alan çıktısından gelir. Radar/koherans yalnızca tanıktır.
Çıktı: pruning-combined/season-<yyyy-yy>.json
`;

export const COMBINED_RULES = {
    /** Two modules saw the same event when their change dates lie within this many days. */
    sameEventDays: 45,
    /**
     * Rule version. 4 = the promotion rule the validation measures: both modules positive on the same event is
     * "confirmed". Versions 2–3 also required pruned/deep_pruning + a deep pixel verdict + overlapping intervals + an
     * available repeat test; measured on the mirrored series that removed real agreement (2025-26: 10 → 2 gardens)
     * without removing a single false alarm (0 → 0; 2024-25: 6 → 1 against 1 → 1), so it was withdrawn.
     * A promotion rule is changed only together with scripts/combined-validate.mjs numbers before and after.
     */
    version: 4,
    /** Radar witness: the garden's coherence rise / VH drop beyond the 90 % bar of quiet tea (block-scale radar test). */
    witnessZ: 1.2816,
    cycleSeasons: 7, // Compare only the preceding rotation, never future observations.
    /**
     * Seasonal pattern: a "probable" detection whose step is also there a year earlier on the same pixels (at least this
     * share of the drop) is the garden's yearly pattern (shadow, aspect, early flush), not a pruning. Needs only the
     * previous season, so it is known at decision time. Confirmed detections are not touched: the test was measured on "probable" only.
     */
    seasonalRepeatShare: 0.6,
};

export type CombinedClass = 'confirmed' | 'probable' | 'light' | 'seasonal' | 'none' | 'no_data';
/** Previous-season repeat test of a detection: on the pixel cluster (against the rest of the garden) or the whole garden (against the neighbourhood). */
export type SeasonalOf = (gardenId: string, clusterCells: Array<[number, number]> | null, lastBefore: string, date: string) => RepeatCheck | null;
export type CombinedAgreement = 'both' | 'both_other_dates' | 'fusion_only' | 'pixel_only' | 'neither';

export interface CombinedGarden {
    id: string;
    producerId: string;
    areaM2: number;
    licensedAreaM2: number | null;
    class: CombinedClass;
    kind: 'deep' | 'light' | null;
    agreement: CombinedAgreement;
    /** The observation interval the cut falls in (never a day): the overlap of the two modules' brackets when both saw it. */
    bracket: { from: string; to: string } | null;
    area: { m2: number; lowM2: number; highM2: number; source: 'pixel_scan' | 'change_patch' | 'ndvi_fraction' } | null;
    /** Square metres credited toward the 1/7 (confirmed and probable deep cuts, minus ground already credited in the cycle). */
    countedM2: number;
    repeatExclusion?: { excludedM2: number; checked: boolean; method: string };
    fusion: { class: string; kind: string | null; z: number | null; changeDate: string | null; lastBeforeAt: string | null; firstAfterAt: string | null; unit: string; unitAreaM2: number; reusedShare: number };
    pixel: { verdict: string; date: string | null; lastBefore: string | null; score: number | null; prunedM2: number; clusters: number; kind: string | null; confidence: string | null } | null;
    radar: { coherenceZ: number | null; vhZ: number | null; witness: boolean } | null;
    /** The previous-season repeat test, run on detections that would be "probable"; `repeat` true moved it to "seasonal". */
    seasonal: ({ unit: 'cluster' | 'garden' } & RepeatCheck) | null;
    reason: string;
}

export type CombinedProducerStatus = 'met' | 'met_with_probable' | 'partial' | 'light_only' | 'none' | 'no_license';
export interface CombinedProducer {
    id: string;
    licensedAreaM2: number;
    requiredM2: number;
    confirmedM2: number;
    probableM2: number;
    lightM2: number;
    countedM2: number;
    shortfallM2: number;
    gardens: number;
    confirmedGardens: string[];
    probableGardens: string[];
    lightGardens: string[];
    seasonalGardens: string[];
    status: CombinedProducerStatus;
    /** The fusion module's own purchase decision, for comparison (the combined module does not open purchases). */
    fusionDecision: string | null;
}

export interface CombinedRate { hit: number; n: number; rate: number | null }
/** Written by scripts/combined-validate.mjs: the combined classes on mirrored series and on the shared simulated cuts. */
export interface CombinedValidation {
    season: string;
    /** COMBINED_RULES.version the numbers were measured with; a file from other rules is not shown. */
    rulesVersion?: number;
    generatedAt: string;
    gardens: number;
    falseAlarms: { confirmed: number; probable: number; light: number; seasonal?: number; note: string };
    detection: { trials: number; note: string; rows: Array<{ key: string; overall: CombinedRate; deep: CombinedRate; light: CombinedRate; clear: CombinedRate }> };
}

export interface CombinedSeasonFile {
    season: string;
    /** The season is still running: only the pixel scan has spoken, the multi-sensor verdict joins after the season. */
    inProgress?: boolean;
    dataThrough?: string | null;
    /** Live season: detections of the pixel scan on the mirrored series so far (upper bound of the interim false alarms). */
    liveFalseAlarms?: number | null;
    generatedAt: string;
    method: string;
    rules: typeof COMBINED_RULES & { pruningRatio: number };
    sources: { fusion: boolean; pixel: boolean; radarCheck: boolean };
    summary: {
        gardens: number;
        byClass: Record<CombinedClass, number>;
        byAgreement: Record<CombinedAgreement, number>;
        areaM2: { confirmed: number; probable: number; light: number; seasonal: number; lowM2: number; highM2: number };
        radarWitness: { confirmed: number; probable: number; light: number };
        producers: Record<CombinedProducerStatus, number>;
        /** Producers whose combined status differs from the fusion purchase decision's direction. */
        producersChanged: number;
    };
    validation: CombinedValidation | null;
    gardens: CombinedGarden[];
    producers: CombinedProducer[];
}

interface PixelGardenLite {
    id: string;
    verdict: string;
    best: { date: string; lastBefore: string | null; score: number } | null;
    prunedM2: number;
    prunedLowM2: number;
    prunedUpperM2: number;
    mainCluster: number | null;
    clusters: Array<{ kind: string; confidence: string }>;
    px?: Array<[number, number, number, number | null, number | null, number, number, number]>;
}
interface RadarSingle { id: string; Koherans?: { z: number } | null; VH?: { z: number } | null }

const dayGap = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;

/** Same event: the pixel bracket (either end) touches the fusion change date within the tolerance. */
export function sameEvent(fusionDate: string | null, pixelDate: string, pixelLastBefore: string | null): boolean {
    return !!fusionDate && Math.min(dayGap(pixelDate, fusionDate), dayGap(pixelLastBefore ?? pixelDate, fusionDate)) <= COMBINED_RULES.sameEventDays;
}
/** The pixel scan counts as positive with a dated cut of any recovery kind. */
export const pixelPositive = (verdict: string, date: string | null): boolean => (verdict === 'deep' || verdict === 'light' || verdict === 'pending') && !!date;
/**
 * The promotion rule on the bare facts, before the seasonal-pattern test. combine() and scripts/combined-validate.mjs
 * both call it, so the measured rule and the applied rule cannot drift apart.
 */
export function promote(fusionPositive: boolean, fusionDate: string | null, pixelVerdict: string, pixelDate: string | null, pixelLastBefore: string | null): 'confirmed' | 'probable' | 'light' | 'none' {
    const pPos = pixelPositive(pixelVerdict, pixelDate);
    if (fusionPositive && pPos) return sameEvent(fusionDate, pixelDate as string, pixelLastBefore) ? 'confirmed' : 'probable';
    if (fusionPositive) return 'probable';
    if (pPos) return pixelVerdict === 'light' ? 'light' : 'probable';
    return 'none';
}
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function combine(fusion: FusionSeasonFile, pixelGardens: PixelGardenLite[] | null, radarSingles: RadarSingle[] | null, seasonalOf: SeasonalOf | null = null, live = false, previousCells: Map<string, Set<string>> = new Map()): { gardens: CombinedGarden[]; producers: CombinedProducer[] } {
    const pixelById = new Map((pixelGardens ?? []).map((g) => [g.id, g]));
    const radarById = new Map((radarSingles ?? []).map((r) => [r.id, r]));
    const gardens: CombinedGarden[] = fusion.gardens.map((g) => {
        const v = g.verdict;
        const px = pixelById.get(g.id) ?? null;
        const fPos = v.class === 'pruned' || v.class === 'likely';
        const pPos = !!px && pixelPositive(px.verdict, px.best?.date ?? null);
        const main = px && px.mainCluster !== null ? (px.clusters[px.mainCluster] ?? null) : null;
        // Same event: the pixel bracket touches the fusion change date within the tolerance.
        const same = fPos && pPos && sameEvent(v.changeDate, px!.best!.date, px!.best!.lastBefore);
        const agreement: CombinedAgreement = fPos && pPos ? (same ? 'both' : 'both_other_dates') : fPos ? 'fusion_only' : pPos ? 'pixel_only' : 'neither';
        let cls: CombinedClass;
        let kind: CombinedGarden['kind'] = null;
        let reason: string;
        if (agreement === 'both') {
            cls = 'confirmed';
            kind = 'deep';
            reason = `İki modül de aynı kesimi gördü: çok-sensör “${v.class === 'pruned' ? 'budandı' : 'olası'}” (değişim ${v.changeDate}), piksel taraması ${px!.best!.lastBefore ?? '—'} → ${px!.best!.date} arasında ${px!.prunedM2} m²`;
        } else if (agreement === 'both_other_dates') {
            cls = 'probable';
            kind = 'deep';
            reason = `İki modül de kesim gördü ama tarihleri ayrı (çok-sensör ${v.changeDate}, piksel taraması ${px!.best!.date}): aynı olay sayılmadı, eksper bakmalı`;
        } else if (agreement === 'fusion_only') {
            cls = 'probable';
            kind = 'deep';
            reason = `Yalnız çok-sensör karar gördü (“${v.class === 'pruned' ? 'budandı' : 'olası'}”, değişim ${v.changeDate}); piksel taraması aynı bahçede küme çizemedi`;
        } else if (agreement === 'pixel_only') {
            const light = px!.verdict === 'light';
            cls = light ? 'light' : 'probable';
            kind = light ? 'light' : 'deep';
            reason = light
                ? `Yalnız piksel taraması gördü ve kesim hızlı toparlandı (${px!.best!.lastBefore ?? '—'} → ${px!.best!.date}, ${px!.prunedM2} m²): hafif budama, 1/7 hesabına girmez`
                : `Yalnız piksel taraması gördü (${px!.best!.lastBefore ?? '—'} → ${px!.best!.date}, ${px!.prunedM2} m², ${px!.verdict === 'pending' ? 'toparlanma henüz izlenemedi' : 'yaz başında örtü hâlâ eksik'}); ${live ? 'sezon sürüyor, çok-sensör karar sezon sonunda eklenecek' : 'bahçe ortalaması çok-sensör eşiğinin altında kaldı'}`;
        } else if (v.class === 'no_data' && (!px || px.verdict === 'no_data')) {
            cls = 'no_data';
            reason = 'İki modülde de yeterli gözlem yok';
        } else {
            cls = 'none';
            reason = live ? 'Şimdiye kadar budama görülmedi (sezon sürüyor)' : 'İki modül de budama görmedi';
        }
        // A cut only the pixel scan saw and whose recovery cannot be watched yet (running season) is neither deep nor
        // light so far: it stays "probable" without square metres until summer tells which.
        if (agreement === 'pixel_only' && px!.verdict === 'pending') {
            kind = null;
            reason += ' · toparlanma bekleniyor; kesim türü ve hedef alanı henüz belirlenmedi';
        }
        // Seasonal pattern: a would-be "probable" whose step repeats a year earlier on the same pixels is not a pruning.
        let seasonal: CombinedGarden['seasonal'] = null;
        if (cls === 'probable' && seasonalOf) {
            const cells = agreement !== 'fusion_only' && px && px.mainCluster !== null ? (px.px ?? []).filter((x) => x[5] > 0 && x[6] === px.mainCluster).map((x) => [x[0], x[1]] as [number, number]) : [];
            const useCluster = cells.length > 0;
            const date = useCluster ? px!.best!.date : (v.firstAfterAt ?? v.changeDate);
            const before = useCluster ? (px!.best!.lastBefore ?? addDays(px!.best!.date, -15)) : (v.lastBeforeAt ?? (date ? addDays(date, -15) : null));
            const check = date && before ? seasonalOf(g.id, useCluster ? cells : null, before, date) : null;
            if (check) {
                seasonal = { unit: useCluster ? 'cluster' : 'garden', ...check };
                if (check.repeat) {
                    cls = 'seasonal';
                    kind = null;
                    reason += ` · aynı ${useCluster ? 'piksellerde' : 'bahçede'} bir önceki sezonun aynı döneminde de benzer düşüş var (bu sezon ${check.drop}, önceki sezon ${check.prevStep}): mevsimsel desen, 1/7 hesabına girmez`;
                }
            }
        }
        // Bracket: the overlap when both saw the same event, else the one that saw it.
        let bracket: CombinedGarden['bracket'] = null;
        const fB = fPos && v.lastBeforeAt && v.firstAfterAt ? { from: v.lastBeforeAt, to: v.firstAfterAt } : null;
        const pB = pPos ? { from: px!.best!.lastBefore ?? px!.best!.date, to: px!.best!.date } : null;
        if (agreement === 'both' && fB && pB) {
            const from = fB.from > pB.from ? fB.from : pB.from;
            const to = fB.to < pB.to ? fB.to : pB.to;
            // A degenerate overlap (the two brackets only touch) is no interval: the pixel bracket, the tighter of the two, stands.
            bracket = from < to ? { from, to } : pB;
        } else bracket = agreement === 'fusion_only' ? fB : (pB ?? fB);
        // Area: the lattice cluster where the pixel scan carries the verdict, else the fusion area output.
        let area: CombinedGarden['area'] = null;
        if (pPos && agreement !== 'both_other_dates' && px!.prunedM2 > 0) {
            const m2 = Math.min(px!.prunedM2, Math.round(g.areaM2));
            area = { m2, lowM2: Math.min(px!.prunedLowM2, m2), highM2: Math.max(m2, Math.min(px!.prunedUpperM2, Math.round(g.areaM2))), source: 'pixel_scan' };
        } else if (fPos && g.prunedArea) area = { m2: g.prunedArea.m2, lowM2: g.prunedArea.lowM2, highM2: g.prunedArea.highM2, source: g.prunedArea.method };
        else if (fPos) area = { m2: g.unitAreaM2, lowM2: 0, highM2: g.unitAreaM2, source: g.unit === 'patch' ? 'change_patch' : 'ndvi_fraction' };
        const reusedShare = fPos ? (g.repeat?.reusedShare ?? 0) : 0;
        const counts = (cls === 'confirmed' || cls === 'probable') && kind === 'deep';
        const rad = radarById.get(g.id);
        const coherenceZ = rad?.Koherans?.z ?? null;
        const vhZ = rad?.VH?.z ?? null;
        const radar = rad ? { coherenceZ: coherenceZ === null ? null : r3(coherenceZ), vhZ: vhZ === null ? null : r3(vhZ), witness: (coherenceZ !== null && coherenceZ >= COMBINED_RULES.witnessZ) || (vhZ !== null && vhZ <= -COMBINED_RULES.witnessZ) } : null;
        const gross = counts && area ? Math.round(area.m2 * (1 - reusedShare)) : 0;
        const cells = area?.source === 'pixel_scan' && px?.mainCluster != null
            ? (px.px ?? []).filter(x => x[5] > 0 && x[6] === px.mainCluster).map(x => [x[0], x[1], x[2]] as [number, number, number]) : [];
        const overlap = repeatedCellArea(cells, previousCells.get(g.id) ?? new Set());
        // Existing fusion reuse and pixel overlap must not be subtracted twice.
        const pixelNet = counts && area ? Math.max(0, area.m2 - overlap) : 0;
        const net = Math.min(gross, Math.round(pixelNet));
        return {
            id: g.id,
            producerId: g.producerId,
            areaM2: Math.round(g.areaM2),
            licensedAreaM2: g.licensedAreaM2,
            class: cls,
            kind,
            agreement,
            bracket,
            area,
            countedM2: net,
            repeatExclusion: { excludedM2: gross - net, checked: cells.length > 0, method: 'Same garden, prior credited pixel footprint; entire overlapping cells excluded conservatively. Missing seasons or changed garden IDs are not verified.' },
            fusion: { class: v.class, kind: v.kind ?? null, z: v.z, changeDate: v.changeDate, lastBeforeAt: v.lastBeforeAt, firstAfterAt: v.firstAfterAt, unit: g.unit, unitAreaM2: g.unitAreaM2, reusedShare },
            pixel: px ? { verdict: px.verdict, date: px.best?.date ?? null, lastBefore: px.best?.lastBefore ?? null, score: px.best?.score ?? null, prunedM2: px.prunedM2, clusters: px.clusters.length, kind: main?.kind ?? null, confidence: main?.confidence ?? null } : null,
            radar,
            seasonal,
            reason: reason + (radar?.witness ? ' · radar/koherans da aynı aralıkta değişim gösterdi' : ''),
        };
    });
    const byProducer = new Map<string, CombinedGarden[]>();
    for (const g of gardens) byProducer.set(g.producerId, [...(byProducer.get(g.producerId) ?? []), g]);
    const producers: CombinedProducer[] = fusion.producers.map((p) => {
        const own = byProducer.get(p.id) ?? [];
        const of = (c: CombinedClass) => own.filter((g) => g.class === c);
        const confirmed = of('confirmed');
        const probable = of('probable');
        const light = of('light');
        const seasonal = of('seasonal');
        const confirmedM2 = confirmed.reduce((s, g) => s + g.countedM2, 0);
        const probableM2 = probable.reduce((s, g) => s + g.countedM2, 0);
        const lightM2 = light.reduce((s, g) => s + (g.area?.m2 ?? 0), 0);
        const counted = confirmedM2 + probableM2;
        let status: CombinedProducerStatus;
        if (p.licensedAreaM2 <= 0) status = 'no_license';
        else if (confirmed.length && confirmedM2 >= p.requiredM2) status = 'met';
        else if ((confirmed.length || probable.length) && counted >= p.requiredM2) status = 'met_with_probable';
        else if (confirmed.length || probable.length) status = 'partial';
        else if (light.length) status = 'light_only';
        else status = 'none';
        return {
            id: p.id,
            licensedAreaM2: p.licensedAreaM2,
            requiredM2: p.requiredM2,
            confirmedM2,
            probableM2,
            lightM2,
            countedM2: counted,
            shortfallM2: Math.max(0, p.requiredM2 - counted),
            gardens: own.length,
            confirmedGardens: confirmed.map((g) => g.id),
            probableGardens: probable.map((g) => g.id),
            lightGardens: light.map((g) => g.id),
            seasonalGardens: seasonal.map((g) => g.id),
            status,
            fusionDecision: p.decision ?? null,
        };
    });
    return { gardens, producers };
}

async function main(): Promise<void> {
    const { values } = parseArgs({ options: { province: { type: 'string' }, district: { type: 'string' }, neighborhood: { type: 'string' }, season: { type: 'string', default: '2025' } } });
    if (!values.province || !values.district || !values.neighborhood) {
        console.log(USAGE);
        process.exit(1);
    }
    const store = new NeighborhoodStore(values.province, values.district, values.neighborhood);
    const year = Number(values.season);
    const season = `${year}-${String(year + 1).slice(2)}`;
    const fusionPath = join(store.dir, 'pruning-fusion', `season-${season}.json`);
    const pixelPath = join(store.dir, 'pruning-pixels', `season-${season}.json`);
    const pixel = existsSync(pixelPath) ? (JSON.parse(readFileSync(pixelPath, 'utf8')) as { gardens: PixelGardenLite[]; inProgress?: boolean; dataThrough?: string | null }) : null;
    // Live season: the multi-sensor module has not run yet (it judges a finished season). The gardens and producers
    // come from the latest fusion season with every verdict blanked, so only the pixel scan speaks.
    const live = !existsSync(fusionPath);
    let fusion: FusionSeasonFile;
    if (!live) fusion = JSON.parse(readFileSync(fusionPath, 'utf8')) as FusionSeasonFile;
    else {
        if (!pixel) throw new Error(`Ne çok-sensör ne piksel taraması var: ${season} (önce scan-pixels ya da fuse-pruning)`);
        const fusionDir = join(store.dir, 'pruning-fusion');
        const latest = (existsSync(fusionDir) ? readdirSync(fusionDir) : []).filter((n) => /^season-\d{4}-\d{2}\.json$/.test(n) && n < `season-${season}.json`).sort().at(-1);
        if (!latest) throw new Error('Bahçe ve müstahsil listesi için en az bir çok-sensör sezonu gerekli.');
        const base = JSON.parse(readFileSync(join(fusionDir, latest), 'utf8')) as FusionSeasonFile;
        fusion = {
            ...base,
            season,
            gardens: base.gardens.map((g) => ({ ...g, unit: 'garden', unitAreaM2: Math.round(g.areaM2), prunedArea: null, repeat: null, verdict: { ...g.verdict, class: 'no_data', kind: null, z: null, changeDate: null, lastBeforeAt: null, firstAfterAt: null } })),
            producers: base.producers.map((p) => ({ ...p, decision: null })),
        } as unknown as FusionSeasonFile;
        console.log(`Canlı sezon ${season}: çok-sensör henüz yok, bahçe listesi ${latest} dosyasından; yalnız piksel taraması konuşuyor.`);
    }
    const radarPath = join(store.dir, 'pruning-radar', `block-check-${season}.json`);
    const radar = existsSync(radarPath) ? (JSON.parse(readFileSync(radarPath, 'utf8')) as { single: RadarSingle[] }) : null;
    if (!pixel) console.log('Piksel taraması bu sezon için yok: birleşik karar yalnız çok-sensör bulgularını “muhtemel” olarak taşır.');
    // The repeat test reads the pixel caches; without them (no pixel scan in this neighbourhood) nothing is moved to "seasonal".
    const pixDir = join(store.dir, 'pruning-pixels');
    const timeline = existsSync(join(pixDir, 'lattice.json')) ? new PixelTimeline(pixDir, { repeatShare: COMBINED_RULES.seasonalRepeatShare }) : null;
    const seasonalOf: SeasonalOf | null = timeline
        ? (id, cells, before, date) => {
            const pix = cells ? timeline.indexes(cells) : timeline.gardenPix(id);
            return pix.length ? timeline.repeatsPrev(pix, cells ? timeline.refFor(id, pix) : null, before, date) : null;
        }
        : null;
    const previousCells = new Map<string, Set<string>>();
    const combDir = join(store.dir, 'pruning-combined');
    for (let prior = year - COMBINED_RULES.cycleSeasons; prior < year; prior++) {
        const suffix = `${prior}-${String(prior + 1).slice(2)}`;
        const combinedPath = join(combDir, `season-${suffix}.json`);
        const scanPath = join(pixDir, `season-${suffix}.json`);
        if (!existsSync(combinedPath) || !existsSync(scanPath)) continue;
        const old = JSON.parse(readFileSync(combinedPath, 'utf8')) as CombinedSeasonFile;
        const credited = new Set(old.gardens.filter(g => g.countedM2 > 0 && g.kind === 'deep').map(g => g.id));
        const scan = JSON.parse(readFileSync(scanPath, 'utf8')) as { gardens: PixelGardenLite[] };
        for (const g of scan.gardens) {
            if (!credited.has(g.id) || g.mainCluster === null) continue;
            const cells = previousCells.get(g.id) ?? new Set<string>();
            for (const x of g.px ?? []) if (x[5] > 0 && x[6] === g.mainCluster) cells.add(`${x[0]}_${x[1]}`);
            previousCells.set(g.id, cells);
        }
    }
    const { gardens, producers } = combine(fusion, pixel?.gardens ?? null, radar?.single ?? null, seasonalOf, live, previousCells);

    const count = <K extends string>(keys: readonly K[], of: (g: CombinedGarden) => K) => Object.fromEntries(keys.map((k) => [k, gardens.filter((g) => of(g) === k).length])) as Record<K, number>;
    const classes = ['confirmed', 'probable', 'light', 'seasonal', 'none', 'no_data'] as const;
    const agreements = ['both', 'both_other_dates', 'fusion_only', 'pixel_only', 'neither'] as const;
    const statuses = ['met', 'met_with_probable', 'partial', 'light_only', 'none', 'no_license'] as const;
    const sumArea = (c: CombinedClass, key: 'm2' | 'lowM2' | 'highM2' = 'm2') => gardens.filter((g) => g.class === c).reduce((s, g) => s + (g.area?.[key] ?? 0), 0);
    const positive = gardens.filter((g) => g.class === 'confirmed' || g.class === 'probable' || g.class === 'light');
    const fusionOpen = (d: string | null) => d === 'auto_open';
    const outDir = join(store.dir, 'pruning-combined');
    mkdirSync(outDir, { recursive: true });
    const validationPath = join(outDir, `validation-${season}.json`);
    const out: CombinedSeasonFile = {
        season,
        inProgress: live || !!pixel?.inProgress,
        dataThrough: pixel?.dataThrough ?? null,
        liveFalseAlarms: live && existsSync(join(pixDir, `validation-${season}-cv-mirror.json`)) ? (JSON.parse(readFileSync(join(pixDir, `validation-${season}-cv-mirror.json`), 'utf8')) as { positives: unknown[] }).positives.length : null,
        generatedAt: new Date().toISOString(),
        method: 'combined-fusion-pixel-v4',
        rules: { ...COMBINED_RULES, pruningRatio: fusion.rules.pruningRatio },
        sources: { fusion: !live, pixel: !!pixel, radarCheck: !!radar },
        summary: {
            gardens: gardens.length,
            byClass: count(classes, (g) => g.class),
            byAgreement: count(agreements, (g) => g.agreement),
            areaM2: { confirmed: sumArea('confirmed'), probable: sumArea('probable'), light: sumArea('light'), seasonal: sumArea('seasonal'), lowM2: positive.reduce((s, g) => s + (g.area?.lowM2 ?? 0), 0), highM2: positive.reduce((s, g) => s + (g.area?.highM2 ?? 0), 0) },
            radarWitness: { confirmed: gardens.filter((g) => g.class === 'confirmed' && g.radar?.witness).length, probable: gardens.filter((g) => g.class === 'probable' && g.radar?.witness).length, light: gardens.filter((g) => g.class === 'light' && g.radar?.witness).length },
            producers: Object.fromEntries(statuses.map((s) => [s, producers.filter((p) => p.status === s).length])) as Record<CombinedProducerStatus, number>,
            producersChanged: live ? 0 : producers.filter((p) => fusionOpen(p.fusionDecision) !== (p.status === 'met' || p.status === 'met_with_probable')).length,
        },
        // Shown only when it was measured with these rules (scripts/combined-validate.mjs stamps the rule version).
        validation: (() => {
            const v = existsSync(validationPath) ? (JSON.parse(readFileSync(validationPath, 'utf8')) as CombinedValidation) : null;
            return v && v.rulesVersion === COMBINED_RULES.version ? v : null;
        })(),
        gardens,
        producers,
    };
    writeFileSync(join(outDir, `season-${season}.json`), JSON.stringify(out));
    console.log(`Sezon ${season}: ${JSON.stringify(out.summary.byClass)}`);
    console.log(`Uyum: ${JSON.stringify(out.summary.byAgreement)}`);
    console.log(`Mevsimsel desen: ${out.summary.byClass.seasonal} bahçe “muhtemel”den ayrıldı (${out.summary.areaM2.seasonal} m²; sınanan ${gardens.filter((g) => g.seasonal).length}, sınanamayan ${gardens.filter((g) => g.class === 'probable' && (!g.seasonal || g.seasonal.repeat === null)).length})`);
    console.log(`Alan: kesin ${out.summary.areaM2.confirmed} m² · muhtemel ${out.summary.areaM2.probable} m² · hafif ${out.summary.areaM2.light} m² (toplam aralık ${out.summary.areaM2.lowM2}–${out.summary.areaM2.highM2})`);
    console.log(`Radar tanığı: ${JSON.stringify(out.summary.radarWitness)}`);
    console.log(`Müstahsil: ${JSON.stringify(out.summary.producers)} · çok-sensör alım kararından farklı ${out.summary.producersChanged}`);
    console.log(`Çıktı: ${join(outDir, `season-${season}.json`)}`);
}

// Run only as a CLI (the validation script imports combine()).
if (process.argv[1]?.replaceAll('\\', '/').endsWith('src/cli/combine-pruning.ts')) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
