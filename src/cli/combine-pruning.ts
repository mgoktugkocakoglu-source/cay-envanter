import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { NeighborhoodStore } from '../library/store.ts';
import type { FusionSeasonFile } from './fuse-pruning.ts';

const USAGE = `
Kullanım:
  npm run combine-pruning -- --province Trabzon --district Of --neighborhood Çataldere --season 2025

Birleşik budama kararı (ayrı modül): çok-sensör kararı (fuse-pruning) ile piksel taramasını (scan-pixels) bahçe
başına tek karara indirir. İki modülün hiçbirini değiştirmez; yalnızca çıktılarını okur.
  kesin    : iki modül de aynı olayı gördü (değişim tarihleri ${45} gün içinde)
  muhtemel : yalnız biri gördü (çok-sensör budandı/olası ya da piksel taraması derin budama)
  hafif    : yalnız piksel taraması, hızlı toparlanan kesim (1/7 hesabına girmez)
Alan piksel taramasının çizdiği kümeden, o yoksa çok-sensörün alan çıktısından gelir. Radar/koherans yalnızca tanıktır.
Çıktı: pruning-combined/season-<yyyy-yy>.json
`;

export const COMBINED_RULES = {
    /** Two modules saw the same event when their change dates lie within this many days. */
    sameEventDays: 45,
    /** Radar witness: the garden's coherence rise / VH drop beyond the 90 % bar of quiet tea (block-scale radar test). */
    witnessZ: 1.2816,
};

export type CombinedClass = 'confirmed' | 'probable' | 'light' | 'none' | 'no_data';
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
    fusion: { class: string; kind: string | null; z: number | null; changeDate: string | null; lastBeforeAt: string | null; firstAfterAt: string | null; unit: string; unitAreaM2: number; reusedShare: number };
    pixel: { verdict: string; date: string | null; lastBefore: string | null; score: number | null; prunedM2: number; clusters: number; kind: string | null; confidence: string | null } | null;
    radar: { coherenceZ: number | null; vhZ: number | null; witness: boolean } | null;
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
    status: CombinedProducerStatus;
    /** The fusion module's own purchase decision, for comparison (the combined module does not open purchases). */
    fusionDecision: string | null;
}

export interface CombinedRate { hit: number; n: number; rate: number | null }
/** Written by scripts/combined-validate.mjs: the combined classes on mirrored series and on the shared simulated cuts. */
export interface CombinedValidation {
    season: string;
    generatedAt: string;
    gardens: number;
    falseAlarms: { confirmed: number; probable: number; light: number; note: string };
    detection: { trials: number; note: string; rows: Array<{ key: string; overall: CombinedRate; deep: CombinedRate; light: CombinedRate; clear: CombinedRate }> };
}

export interface CombinedSeasonFile {
    season: string;
    generatedAt: string;
    method: string;
    rules: typeof COMBINED_RULES & { pruningRatio: number };
    sources: { fusion: boolean; pixel: boolean; radarCheck: boolean };
    summary: {
        gardens: number;
        byClass: Record<CombinedClass, number>;
        byAgreement: Record<CombinedAgreement, number>;
        areaM2: { confirmed: number; probable: number; light: number; lowM2: number; highM2: number };
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
}
interface RadarSingle { id: string; Koherans?: { z: number } | null; VH?: { z: number } | null }

const dayGap = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function combine(fusion: FusionSeasonFile, pixelGardens: PixelGardenLite[] | null, radarSingles: RadarSingle[] | null): { gardens: CombinedGarden[]; producers: CombinedProducer[] } {
    const pixelById = new Map((pixelGardens ?? []).map((g) => [g.id, g]));
    const radarById = new Map((radarSingles ?? []).map((r) => [r.id, r]));
    const gardens: CombinedGarden[] = fusion.gardens.map((g) => {
        const v = g.verdict;
        const px = pixelById.get(g.id) ?? null;
        const fPos = v.class === 'pruned' || v.class === 'likely';
        const pPos = !!px && (px.verdict === 'deep' || px.verdict === 'light' || px.verdict === 'pending') && px.best !== null;
        const main = px && px.mainCluster !== null ? (px.clusters[px.mainCluster] ?? null) : null;
        // Same event: the pixel bracket touches the fusion change date within the tolerance.
        const same = fPos && pPos && !!v.changeDate && Math.min(dayGap(px!.best!.date, v.changeDate), dayGap(px!.best!.lastBefore ?? px!.best!.date, v.changeDate)) <= COMBINED_RULES.sameEventDays;
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
                : `Yalnız piksel taraması gördü (${px!.best!.lastBefore ?? '—'} → ${px!.best!.date}, ${px!.prunedM2} m², ${px!.verdict === 'pending' ? 'toparlanma henüz izlenemedi' : 'yaz başında örtü hâlâ eksik'}); bahçe ortalaması çok-sensör eşiğinin altında kaldı`;
        } else if (v.class === 'no_data' && (!px || px.verdict === 'no_data')) {
            cls = 'no_data';
            reason = 'İki modülde de yeterli gözlem yok';
        } else {
            cls = 'none';
            reason = 'İki modül de budama görmedi';
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
            countedM2: counts && area ? Math.round(area.m2 * (1 - reusedShare)) : 0,
            fusion: { class: v.class, kind: v.kind ?? null, z: v.z, changeDate: v.changeDate, lastBeforeAt: v.lastBeforeAt, firstAfterAt: v.firstAfterAt, unit: g.unit, unitAreaM2: g.unitAreaM2, reusedShare },
            pixel: px ? { verdict: px.verdict, date: px.best?.date ?? null, lastBefore: px.best?.lastBefore ?? null, score: px.best?.score ?? null, prunedM2: px.prunedM2, clusters: px.clusters.length, kind: main?.kind ?? null, confidence: main?.confidence ?? null } : null,
            radar,
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
    if (!existsSync(fusionPath)) throw new Error(`Çok-sensör sezonu yok: ${fusionPath} (önce fuse-pruning)`);
    const fusion = JSON.parse(readFileSync(fusionPath, 'utf8')) as FusionSeasonFile;
    const pixelPath = join(store.dir, 'pruning-pixels', `season-${season}.json`);
    const pixel = existsSync(pixelPath) ? (JSON.parse(readFileSync(pixelPath, 'utf8')) as { gardens: PixelGardenLite[] }) : null;
    const radarPath = join(store.dir, 'pruning-radar', `block-check-${season}.json`);
    const radar = existsSync(radarPath) ? (JSON.parse(readFileSync(radarPath, 'utf8')) as { single: RadarSingle[] }) : null;
    if (!pixel) console.log('Piksel taraması bu sezon için yok: birleşik karar yalnız çok-sensör bulgularını “muhtemel” olarak taşır.');
    const { gardens, producers } = combine(fusion, pixel?.gardens ?? null, radar?.single ?? null);

    const count = <K extends string>(keys: readonly K[], of: (g: CombinedGarden) => K) => Object.fromEntries(keys.map((k) => [k, gardens.filter((g) => of(g) === k).length])) as Record<K, number>;
    const classes = ['confirmed', 'probable', 'light', 'none', 'no_data'] as const;
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
        generatedAt: new Date().toISOString(),
        method: 'combined-fusion-pixel',
        rules: { ...COMBINED_RULES, pruningRatio: fusion.rules.pruningRatio },
        sources: { fusion: true, pixel: !!pixel, radarCheck: !!radar },
        summary: {
            gardens: gardens.length,
            byClass: count(classes, (g) => g.class),
            byAgreement: count(agreements, (g) => g.agreement),
            areaM2: { confirmed: sumArea('confirmed'), probable: sumArea('probable'), light: sumArea('light'), lowM2: positive.reduce((s, g) => s + (g.area?.lowM2 ?? 0), 0), highM2: positive.reduce((s, g) => s + (g.area?.highM2 ?? 0), 0) },
            radarWitness: { confirmed: gardens.filter((g) => g.class === 'confirmed' && g.radar?.witness).length, probable: gardens.filter((g) => g.class === 'probable' && g.radar?.witness).length, light: gardens.filter((g) => g.class === 'light' && g.radar?.witness).length },
            producers: Object.fromEntries(statuses.map((s) => [s, producers.filter((p) => p.status === s).length])) as Record<CombinedProducerStatus, number>,
            producersChanged: producers.filter((p) => fusionOpen(p.fusionDecision) !== (p.status === 'met' || p.status === 'met_with_probable')).length,
        },
        validation: existsSync(validationPath) ? (JSON.parse(readFileSync(validationPath, 'utf8')) as CombinedValidation) : null,
        gardens,
        producers,
    };
    writeFileSync(join(outDir, `season-${season}.json`), JSON.stringify(out));
    console.log(`Sezon ${season}: ${JSON.stringify(out.summary.byClass)}`);
    console.log(`Uyum: ${JSON.stringify(out.summary.byAgreement)}`);
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
