import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { initEarthEngine } from '../ee/session.ts';
import { NeighborhoodStore } from '../library/store.ts';
import { buildDemoProducers } from '../producers/demo-producers.ts';
import { currentGeometry, type LicensingRegistry } from '../licensing/registry.ts';
import { backscatterSeries, type OrbitPass } from '../radar/series.ts';
import { growingSeries, type GrowingSeries } from '../health/optical.ts';
import { HEALTH_RULES, detectAnomaly, medianSeries, relative, vigourAndYield, type AnomalyClass, type GardenHealth } from '../health/model.ts';
import type { FusionSeasonFile } from './fuse-pruning.ts';

type Poly = Polygon | MultiPolygon;

const USAGE = `Bahçe sağlığı ve verim taraması (budama modülünden ayrı): büyüme sezonu (Nis–Eki) NDVI/NDRE/NBR + S1 VH.

  npm run scan-health -- --province Trabzon --district Of --neighborhood Çataldere --year 2026 [--refetch]

Her bahçe için: komşuluğa göre canlılık (Haz–Eyl), ani kayıp anomalisi (herbisit/kimyasal şüphesi = optik düşer,
radar yapısal değişim görmez; yaprak kaybı = ikisi birlikte; stres = hafif), rekolte tahmini ve kota oranı.
Çıktı: health/season-<yyyy>.json (seriler önbellekte health/series-<yyyy>.json)
`;

export type YieldFlag = 'ok' | 'low' | 'high' | 'no_license' | 'no_data';

export interface HealthProducer {
    id: string;
    gardens: number;
    teaAreaM2: number;
    licensedAreaM2: number;
    yieldKg: number;
    quotaKg: number;
    ratio: number | null;
    flag: YieldFlag;
    anomalies: Record<AnomalyClass, number>;
    meanVigour: number | null;
    reason: string;
}

export interface HealthSeasonFile {
    season: string;
    window: [string, string];
    rules: typeof HEALTH_RULES;
    sensors: { optical: { dates: string[] }; backscatter: Array<{ pass: OrbitPass; relativeOrbit: number; dates: string[] }> };
    neighbourhood: { dates: string[]; ndviMedian: Array<number | null>; ndreMedian: Array<number | null> };
    gardens: GardenHealth[];
    producers: HealthProducer[];
    /** Per garden: absolute NDVI/NDRE and relative VH series (dates in `sensors`). */
    series: Record<string, { ndvi: Array<number | null>; ndre: Array<number | null>; nbr: Array<number | null>; vhAsc: Array<number | null> | null; vhDesc: Array<number | null> | null }>;
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            province: { type: 'string' },
            district: { type: 'string' },
            neighborhood: { type: 'string' },
            year: { type: 'string', default: String(new Date().getFullYear()) },
            refetch: { type: 'boolean', default: false },
        },
    });
    if (!values.province || !values.district || !values.neighborhood) {
        console.log(USAGE);
        process.exit(1);
    }
    const store = new NeighborhoodStore(values.province, values.district, values.neighborhood);
    const meta = store.readMeta();
    if (!meta) throw new Error('meta.json yok; önce harvest çalıştırın.');
    const year = Number(values.year);
    const today = new Date().toISOString().slice(0, 10);
    const end = `${year}-10-31` < today ? `${year}-10-31` : today;
    const window: [string, string] = [`${year}-04-15`, end];
    const read = <T>(name: string): T => JSON.parse(readFileSync(join(store.dir, name), 'utf8')) as T;
    const parcels = read<FeatureCollection<Poly, { key: string; block: string; parcel: string; teaAreaM2: number | null }>>('parcels-tea.geojson');
    const teaPatches = read<FeatureCollection<Poly>>('tea-patches.geojson');
    const registryPath = join(store.dir, 'licensing', 'registry.json');
    const registry = existsSync(registryPath) ? (JSON.parse(readFileSync(registryPath, 'utf8')) as LicensingRegistry) : null;
    const { producers, gardens: slices } = buildDemoProducers(parcels.features.map((f) => ({ ...f.properties, geometry: f.geometry })));
    const byCode = new Map(registry?.gardens.map((g) => [g.code, g]) ?? []);
    const gardens = slices.map((g) => {
        const reg = byCode.get(g.id);
        return { id: g.id, producerId: g.producerId, geometry: (reg ? currentGeometry(reg) : g.geometry) as Poly, teaAreaM2: reg?.measuredTeaAreaM2 ?? g.geometryAreaM2, licensedAreaM2: reg?.licensedAreaM2 ?? null };
    });
    console.log(`Sezon ${year}: ${gardens.length} bahçe, ${producers.length} müstahsil, pencere ${window[0]} → ${window[1]}`);

    const outDir = join(store.dir, 'health');
    mkdirSync(outDir, { recursive: true });
    interface RawSeries {
        optical: GrowingSeries;
        backscatter: Array<{ pass: OrbitPass; relativeOrbit: number; dates: string[]; vh: Record<string, Array<number | null>> }>;
    }
    const cachePath = join(outDir, `series-${year}.json`);
    let raw: RawSeries;
    if (existsSync(cachePath) && !values.refetch) {
        raw = JSON.parse(readFileSync(cachePath, 'utf8')) as RawSeries;
        console.log(`Sensör serileri önbellekten: ${cachePath}`);
    } else {
        const ee = await initEarthEngine();
        const region = ee.Geometry(meta.boundary);
        const teaMask = ee.Image(0).byte().paint(ee.FeatureCollection(teaPatches.features.map((f) => ee.Feature(ee.Geometry(f.geometry)))), 1).eq(1);
        console.log('Sentinel-2 NDVI/NDRE/NBR serileri…');
        const optical = await growingSeries(ee, region, teaMask, gardens, window);
        console.log(`  ${optical.dates.length} tarih (${optical.dates[0]} → ${optical.dates.at(-1)})`);
        const backscatter: RawSeries['backscatter'] = [];
        for (const pass of ['ASCENDING', 'DESCENDING'] as OrbitPass[]) {
            console.log(`Sentinel-1 ${pass}…`);
            const s = await backscatterSeries(ee, region, gardens, window, pass);
            if (!s) continue;
            backscatter.push({ pass, relativeOrbit: s.relativeOrbit, dates: s.dates, vh: Object.fromEntries(Object.entries(s.gardens).map(([id, g]) => [id, g.vh])) });
            console.log(`  yörünge ${s.relativeOrbit}: ${s.dates.length} tarih`);
        }
        raw = { optical, backscatter };
        writeFileSync(cachePath, JSON.stringify(raw));
    }
    const { optical, backscatter } = raw;

    // Previous winter's pruning (fusion verdicts) feeds the yield estimate.
    const fusionPath = join(store.dir, 'pruning-fusion', `season-${year - 1}-${String(year).slice(2)}.json`);
    const prunedShare = new Map<string, number>();
    if (existsSync(fusionPath)) {
        const fusion = JSON.parse(readFileSync(fusionPath, 'utf8')) as FusionSeasonFile;
        for (const g of fusion.gardens) {
            if (g.verdict.class === 'pruned' || g.verdict.class === 'likely') prunedShare.set(g.id, Math.max(0, Math.min(1, g.unitAreaM2 / Math.max(1, g.areaM2))));
        }
        console.log(`Önceki kış budama kararları: ${prunedShare.size} bahçede budama payı`);
    }

    // Neighbourhood medians and relative series.
    const n = optical.dates.length;
    const ndviMedian = medianSeries(Object.fromEntries(Object.entries(optical.gardens).map(([id, g]) => [id, g.ndvi])), n);
    const ndreMedian = medianSeries(Object.fromEntries(Object.entries(optical.gardens).map(([id, g]) => [id, g.ndre])), n);
    const vhRel = backscatter.map((b) => ({ ...b, rel: Object.fromEntries(Object.entries(b.vh).map(([id, v]) => [id, relative(v, medianSeries(b.vh, b.dates.length))])) }));

    const outGardens: GardenHealth[] = [];
    const series: HealthSeasonFile['series'] = {};
    for (const g of gardens) {
        const o = optical.gardens[g.id];
        if (!o) continue;
        const ndviRel = { dates: optical.dates, values: relative(o.ndvi, ndviMedian) };
        const ndreRel = { dates: optical.dates, values: relative(o.ndre, ndreMedian) };
        const radar = vhRel.map((b) => ({ dates: b.dates, values: b.rel[g.id] ?? [] }));
        const anomaly = detectAnomaly(year, ndviRel, ndreRel, radar);
        const share = prunedShare.get(g.id) ?? 0;
        const vy = vigourAndYield(year, { dates: optical.dates, values: o.ndvi }, { dates: optical.dates, values: o.ndre }, { dates: optical.dates, values: ndviMedian }, g.teaAreaM2, share, anomaly.class);
        outGardens.push({ id: g.id, producerId: g.producerId, teaAreaM2: Math.round(g.teaAreaM2), licensedAreaM2: g.licensedAreaM2, prunedShare: Math.round(share * 1000) / 1000, anomaly, ...vy });
        series[g.id] = {
            ndvi: o.ndvi, ndre: o.ndre, nbr: o.nbr,
            vhAsc: vhRel.find((b) => b.pass === 'ASCENDING')?.rel[g.id] ?? null,
            vhDesc: vhRel.find((b) => b.pass === 'DESCENDING')?.rel[g.id] ?? null,
        };
    }

    const outProducers: HealthProducer[] = producers.map((p) => {
        const own = outGardens.filter((g) => g.producerId === p.id);
        const licensed = own.reduce((t, g) => t + (g.licensedAreaM2 ?? 0), 0);
        const yieldKg = own.reduce((t, g) => t + g.yieldKg, 0);
        const quotaKg = Math.round((licensed / 1000) * HEALTH_RULES.quotaKgPerDa);
        const anomalies = { chemical_suspect: 0, defoliation: 0, stress: 0, none: 0, no_data: 0 } as Record<AnomalyClass, number>;
        for (const g of own) anomalies[g.anomaly.class]++;
        const vig = own.map((g) => g.vigour).filter((v): v is number => v != null);
        const meanVigour = vig.length ? Math.round((vig.reduce((a, b) => a + b, 0) / vig.length) * 1000) / 1000 : null;
        const observed = own.filter((g) => g.anomaly.class !== 'no_data').length;
        let flag: YieldFlag = 'ok';
        let reason = `${own.length} bahçe · tahmin ${yieldKg} kg, kota ${quotaKg} kg`;
        if (own.length === 0 || observed === 0) { flag = 'no_data'; reason = 'Büyüme sezonunda gözlem yok'; }
        else if (quotaKg === 0) { flag = 'no_license'; reason = `Ruhsat alanı yok; tahmini ${yieldKg} kg yaprak ruhsatsız`; }
        else if (yieldKg / quotaKg < HEALTH_RULES.lowRatio) { flag = 'low'; reason = `Tahmin kotanın %${Math.round((yieldKg / quotaKg) * 100)}'i: bahçeler zayıf ya da yeni budanmış; teslimat kotaya yaklaşırsa dışarıdan yaprak şüphesi`; }
        else if (yieldKg / quotaKg > HEALTH_RULES.highRatio) { flag = 'high'; reason = `Tahmin kotanın %${Math.round((yieldKg / quotaKg) * 100)}'i: çay alanı ruhsat alanından büyük görünüyor (taşan çaylık?)`; }
        return { id: p.id, gardens: own.length, teaAreaM2: Math.round(own.reduce((t, g) => t + g.teaAreaM2, 0)), licensedAreaM2: Math.round(licensed), yieldKg, quotaKg, ratio: quotaKg ? Math.round((yieldKg / quotaKg) * 1000) / 1000 : null, flag, anomalies, meanVigour, reason };
    });

    const counts = outGardens.reduce<Record<string, number>>((h, g) => ((h[g.anomaly.class] = (h[g.anomaly.class] ?? 0) + 1), h), {});
    const flags = outProducers.reduce<Record<string, number>>((h, p) => ((h[p.flag] = (h[p.flag] ?? 0) + 1), h), {});
    console.log(`Bahçe anomalileri: ${JSON.stringify(counts)}`);
    console.log(`Müstahsil verim bayrakları: ${JSON.stringify(flags)} · toplam tahmin ${Math.round(outProducers.reduce((t, p) => t + p.yieldKg, 0) / 1000)} t`);
    const out: HealthSeasonFile = {
        season: String(year),
        window,
        rules: HEALTH_RULES,
        sensors: { optical: { dates: optical.dates }, backscatter: backscatter.map((b) => ({ pass: b.pass, relativeOrbit: b.relativeOrbit, dates: b.dates })) },
        neighbourhood: { dates: optical.dates, ndviMedian, ndreMedian },
        gardens: outGardens,
        producers: outProducers,
        series,
    };
    const outPath = join(outDir, `season-${year}.json`);
    writeFileSync(outPath, JSON.stringify(out));
    console.log(`Çıktı: ${outPath}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
