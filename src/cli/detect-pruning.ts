import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { initEarthEngine, evaluate } from '../ee/session.ts';
import { buildPruningImages, pruningWindows } from '../ee/pruning.ts';
import { NeighborhoodStore } from '../library/store.ts';
import { pruningStatus, requiredPrunedM2, type PruningStatus } from '../pruning/compliance.ts';

/* `ee` objects are untyped (see src/types/earthengine.d.ts). */
type EE = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const SCALE_M = 10;
/** Pixels at least this pruned are drawn as pruned patches on the map. */
const PATCH_SHARE = 0.5;

const USAGE = `
Kullanım:
  npm run detect-pruning -- --province Trabzon --district Of --neighborhood Çataldere [--seasons 2023,2024,2025]

Sezon Y = Y Kasım'ında başlayan budama: referans 5 Eki–10 Kas, kış 10 Ara–1 Şub, bahar 25 Mar–26 Nis.
`;

interface ParcelSums {
    key: string;
    tea?: number;
    obs_season?: number;
    winter?: number;
    spring?: number;
    season?: number;
    vh_change_db?: number;
}

const round = (value: number | undefined) => Math.round(value ?? 0);

async function analyseSeason(ee: EE, region: EE, teaMask: EE, parcels: EE, year: number, fixedThreshold?: number) {
    const windows = pruningWindows(year);
    const { pruned, observed, stats } = buildPruningImages(ee, region, teaMask, windows, fixedThreshold);
    const area = ee.Image.pixelArea();
    const areas = area.multiply(teaMask).rename('tea')
        .addBands(area.multiply(observed.select('obs_season')).updateMask(teaMask).rename('obs_season'))
        .addBands(area.multiply(pruned.select(['winter', 'spring', 'season']).unmask(0)).updateMask(teaMask));
    const sums = areas.reduceRegions({ collection: parcels, reducer: ee.Reducer.sum(), scale: SCALE_M, tileScale: 4 });
    const withRadar = pruned.select('vh_change_db').reduceRegions({ collection: sums, reducer: ee.Reducer.mean().setOutputs(['vh_change_db']), scale: SCALE_M, tileScale: 4 });
    const patches = pruned.select('season').gte(PATCH_SHARE).selfMask()
        .reduceToVectors({ geometry: region, scale: SCALE_M, geometryType: 'polygon', eightConnected: true, maxPixels: 1e8 })
        .map((f: EE) => f.set('areaM2', f.geometry().area(1)));

    const [parcelRows, seasonStats, patchCollection] = await Promise.all([
        evaluate<{ features: Array<{ properties: ParcelSums }> }>(withRadar),
        evaluate<Record<string, number | null>>(stats),
        evaluate<FeatureCollection>(patches),
    ]);
    return { windows, parcelRows: parcelRows.features.map((f) => f.properties), seasonStats, patchCollection };
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            province: { type: 'string' },
            district: { type: 'string' },
            neighborhood: { type: 'string' },
            seasons: { type: 'string', default: '2023,2024,2025' },
            threshold: { type: 'string' },
            out: { type: 'string', default: 'pruning' },
        },
    });
    if (!values.province || !values.district || !values.neighborhood) {
        console.log(USAGE);
        process.exit(1);
    }
    const store = new NeighborhoodStore(values.province, values.district, values.neighborhood);
    const meta = store.readMeta();
    const parcels = store.loadParcels().filter((p) => p.properties.inTargetNeighborhood);
    const read = <T>(name: string): T => JSON.parse(readFileSync(join(store.dir, name), 'utf8')) as T;
    const teaPatches = read<FeatureCollection<Polygon | MultiPolygon>>('tea-patches.geojson');
    if (!meta || parcels.length === 0) {
        throw new Error('Mahalle kütüphanesi veya çay haritası yok; önce harvest ve detect-tea çalıştırın.');
    }

    const ee = await initEarthEngine();
    const region = ee.Geometry(meta.boundary);
    // Tea pixels only (from detect-tea): forest and hazelnut never enter the comparison.
    const teaMask = ee.Image(0).byte().paint(ee.FeatureCollection(teaPatches.features.map((f) => ee.Feature(ee.Geometry(f.geometry)))), 1).eq(1);
    const parcelCollection = ee.FeatureCollection(parcels.map((p) => ee.Feature(ee.Geometry(p.geometry), { key: p.properties.key })));

    const fixedThreshold = values.threshold ? Number(values.threshold) : undefined;
    const outDir = join(store.dir, values.out);
    mkdirSync(outDir, { recursive: true });
    const summary: object[] = [];
    for (const year of values.seasons.split(',').map(Number)) {
        console.log(`Sezon ${year}-${year + 1} işleniyor…`);
        const { windows, parcelRows, seasonStats, patchCollection } = await analyseSeason(ee, region, teaMask, parcelCollection, year, fixedThreshold);
        const rows = parcelRows
            .filter((r) => (r.tea ?? 0) > 0)
            .map((r) => {
                const teaAreaM2 = round(r.tea);
                const observedTeaAreaM2 = round(r.obs_season);
                const prunedM2 = round(r.season);
                const status: PruningStatus = pruningStatus({ teaAreaM2, observedTeaAreaM2, prunedM2 });
                return {
                    key: r.key,
                    teaAreaM2,
                    observedTeaAreaM2,
                    requiredM2: round(requiredPrunedM2(teaAreaM2)),
                    winterPrunedM2: round(r.winter),
                    springPrunedM2: round(r.spring),
                    prunedM2,
                    vhChangeDb: r.vh_change_db === undefined ? null : Math.round(r.vh_change_db * 100) / 100,
                    status,
                };
            });
        const sum = (pick: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + pick(r), 0);
        const counts = Object.fromEntries(
            (['pruned', 'partial', 'no_trace', 'insufficient_observation', 'too_small'] as PruningStatus[]).map((s) => [s, rows.filter((r) => r.status === s).length]),
        );
        const teaTotal = sum((r) => r.teaAreaM2);
        const seasonSummary = {
            season: windows.season,
            windows,
            stats: seasonStats,
            parcelsWithTea: rows.length,
            teaAreaM2: teaTotal,
            observedShare: Math.round((sum((r) => r.observedTeaAreaM2) / teaTotal) * 1000) / 1000,
            winterPrunedM2: sum((r) => r.winterPrunedM2),
            springPrunedM2: sum((r) => r.springPrunedM2),
            prunedM2: sum((r) => r.prunedM2),
            prunedShareOfTea: Math.round((sum((r) => r.prunedM2) / teaTotal) * 1000) / 1000,
            expectedShare: Math.round((1 / 7) * 1000) / 1000,
            statusCounts: counts,
        };
        writeFileSync(join(outDir, `season-${windows.season}.json`), JSON.stringify({ ...seasonSummary, parcels: rows }, null, 2));
        writeFileSync(join(outDir, `pruned-patches-${windows.season}.geojson`), JSON.stringify(patchCollection));
        summary.push(seasonSummary);
        console.log(
            `  gözlenen çay %${Math.round(seasonSummary.observedShare * 100)} | budanan ${Math.round(seasonSummary.prunedM2 / 1000)} da ` +
                `(çayın %${(seasonSummary.prunedShareOfTea * 100).toFixed(1)}; beklenen ~%14,3) | kış ${Math.round(seasonSummary.winterPrunedM2 / 1000)} da, ` +
                `mart ${Math.round(seasonSummary.springPrunedM2 / 1000)} da | ${JSON.stringify(counts)}`,
        );
    }
    writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(`Çıktılar: ${outDir}`);
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
