import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { area, feature, featureCollection, intersect, union } from '@turf/turf';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { initEarthEngine, evaluate } from '../ee/session.ts';
import { clearScenes, opticalComposite, pruningWindows, relativeDrop } from '../ee/pruning.ts';
import { NeighborhoodStore } from '../library/store.ts';
import { buildDemoProducers, loadDemoLayout, type DemoGarden } from '../producers/demo-producers.ts';
import { CYCLE_SEASONS } from '../producers/compliance.ts';
import { evaluateProducerSeason, type GardenSeries } from '../producers/evaluate.ts';
import { producerLicensedAreaM2, type LicensingRegistry } from '../licensing/registry.ts';

/* `ee` objects are untyped (see src/types/earthengine.d.ts). */
type EE = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Poly = Polygon | MultiPolygon;

const USAGE = `
Kullanım:
  npm run scan-producers -- --province Trabzon --district Of --neighborhood Çataldere [--season 2025] [--every 5]

Sezon boyunca (15 Kasım – 15 Nisan) her N günde bir tarama: son 20 günün bulutsuz sahneleri
referansla (Eki–Kas) karşılaştırılır, her bahçenin budanan alanı güncellenir ve müstahsil
toplamı 1/7 kuralına göre değerlendirilir. Sezon sonunda budama olay poligonları çıkarılır ve
aynı döngüdeki önceki sezonların poligonlarıyla çakışma (tekrar budama) hesaplanır; bu yüzden
sezonlar sırayla (2023, 2024, 2025…) çalıştırılmalıdır. Geçmiş bir sezonda çalıştırıldığında,
o sezon canlı izlenseydi her tarama gününde ne görüleceğini yeniden üretir.
`;

/** Each scan compares the newest observations: clear scenes of the last LOOKBACK_DAYS. */
const LOOKBACK_DAYS = 20;
const SCALE_M = 10;
/** A pixel at least this pruned becomes part of an event polygon. */
const EVENT_SHARE = 0.5;
/** A garden's cumulative pruned area must rise by this much to date an event. */
const EVENT_MIN_RISE_M2 = 50;

const addDays = (iso: string, days: number) => new Date(Date.parse(iso) + days * 864e5).toISOString().slice(0, 10);

function scanDates(year: number, every: number): string[] {
    const out: string[] = [];
    // First scan once the reference window (5 Oct – 10 Nov) has closed.
    for (let d = `${year}-11-15`; d <= `${year + 1}-04-15`; d = addDays(d, every)) out.push(d);
    return out;
}

interface GardenScanRow {
    id: string;
    tea?: number;
    observed?: number;
    pruned?: number;
}

/** A pruning event: where (polygon inside one garden) and when (an observation interval, never a day). */
interface PruningEvent {
    gardenId: string;
    areaM2: number;
    /** Part of this polygon that overlaps ground credited in an earlier season of the cycle. */
    reusedM2: number;
    /** Last clear observation that showed no change, or null when pruning was already visible at the first scan. */
    lastNoChangeAt: string | null;
    /** First clear observation that showed the change. */
    firstChangeAt: string | null;
    /** Scan that produced the event. */
    detectedAt: string | null;
    geometry: Poly;
}

interface SeasonFile {
    season: string;
    gardens: Array<{ id: string; teaAreaM2: number }>;
    events: PruningEvent[];
}

const polyArea = (g: Poly) => area(feature(g));

function intersectArea(a: Poly, b: Poly): { geometry: Poly | null; areaM2: number } {
    const hit = intersect(featureCollection([feature(a), feature(b)]));
    return hit ? { geometry: hit.geometry as Poly, areaM2: area(hit) } : { geometry: null, areaM2: 0 };
}

/** Previous seasons' event polygons inside the cycle, merged into one shape per garden-independent ground record. */
function loadPreviousEvents(dir: string, season: string): { seasons: string[]; ground: Poly | null } {
    if (!existsSync(dir)) return { seasons: [], ground: null };
    const startYear = Number(season.slice(0, 4));
    const files = readdirSync(dir)
        .filter((n) => /^season-\d{4}-\d{2}\.json$/.test(n))
        .map((n) => ({ n, year: Number(n.slice(7, 11)) }))
        .filter((f) => f.year < startYear && f.year > startYear - CYCLE_SEASONS)
        .sort((a, b) => a.year - b.year);
    const polys: Feature<Poly>[] = [];
    for (const f of files) {
        const data = JSON.parse(readFileSync(join(dir, f.n), 'utf8')) as SeasonFile;
        for (const e of data.events ?? []) polys.push(feature(e.geometry));
    }
    if (polys.length === 0) return { seasons: files.map((f) => f.n.slice(7, 14)), ground: null };
    const merged = polys.length === 1 ? polys[0] : union(featureCollection(polys));
    return { seasons: files.map((f) => f.n.slice(7, 14)), ground: (merged?.geometry as Poly) ?? null };
}

/** The observation interval in which a garden's cumulative pruned area first rose. */
function eventWindow(cumulative: number[], newObservation: boolean[], sceneDates: string[][], scanDates: string[]) {
    let lastClear: string | null = null;
    let previous = 0;
    for (let i = 0; i < cumulative.length; i++) {
        const fresh = newObservation[i] ?? false;
        const scenes = sceneDates[i] ?? [];
        const latestScene = scenes.at(-1) ?? null;
        if ((cumulative[i] ?? 0) - previous >= EVENT_MIN_RISE_M2 && fresh) {
            return { lastNoChangeAt: lastClear, firstChangeAt: latestScene, detectedAt: scanDates[i] ?? null };
        }
        if (fresh) {
            lastClear = latestScene;
            previous = cumulative[i] ?? previous;
        }
    }
    return { lastNoChangeAt: lastClear, firstChangeAt: null, detectedAt: null };
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            province: { type: 'string' },
            district: { type: 'string' },
            neighborhood: { type: 'string' },
            season: { type: 'string', default: '2025' },
            every: { type: 'string', default: '5' },
        },
    });
    if (!values.province || !values.district || !values.neighborhood) {
        console.log(USAGE);
        process.exit(1);
    }
    const year = Number(values.season);
    const every = Math.min(Math.max(Number(values.every), 1), 5);
    const store = new NeighborhoodStore(values.province, values.district, values.neighborhood);
    const meta = store.readMeta();
    const read = <T>(name: string): T => JSON.parse(readFileSync(join(store.dir, name), 'utf8')) as T;
    const parcels = read<FeatureCollection<Poly, { key: string; block: string; parcel: string; teaAreaM2: number | null }>>('parcels-tea.geojson');
    const teaPatches = read<FeatureCollection<Poly>>('tea-patches.geojson');
    if (!meta) throw new Error('meta.json yok; önce harvest çalıştırın.');

    const { producers, gardens } = buildDemoProducers(parcels.features.map((f) => ({ ...f.properties, geometry: f.geometry })), 2026, loadDemoLayout(store.dir));
    const unresolved = gardens.filter((g) => !g.boundaryResolved).length;
    console.log(`Demo kayıt: ${producers.length} müstahsil, ${gardens.length} bahçe (${unresolved} bahçenin hisse sınırı belirsiz)`);

    const outDir = join(store.dir, 'producers');
    const windows = pruningWindows(year);
    const previous = loadPreviousEvents(outDir, windows.season);
    console.log(previous.seasons.length ? `Döngüdeki önceki sezonlar: ${previous.seasons.join(', ')}` : 'Döngüde önceki sezon kaydı yok');

    const ee = await initEarthEngine();
    const region = ee.Geometry(meta.boundary);
    const teaMask = ee.Image(0).byte().paint(ee.FeatureCollection(teaPatches.features.map((f) => ee.Feature(ee.Geometry(f.geometry)))), 1).eq(1);
    const gardenCollection = ee.FeatureCollection(gardens.map((g) => ee.Feature(ee.Geometry(g.geometry), { id: g.id })));
    const reference = opticalComposite(ee, region, teaMask, windows.reference);
    const area = ee.Image.pixelArea();

    const dates = scanDates(year, every);
    const tea = new Map<string, number>();
    const perGarden = new Map<string, Array<{ observed: number; pruned: number }>>();
    const newObservation: boolean[] = [];
    const sceneDates: string[][] = [];
    // Pruned-share images of scans that saw something; their pixel-wise maximum is the season's pruned map.
    const shareImages: EE[] = [];
    for (const [i, date] of dates.entries()) {
        const window: [string, string] = [addDays(date, -LOOKBACK_DAYS) > windows.reference[1] ? addDays(date, -LOOKBACK_DAYS) : windows.reference[1], addDays(date, 1)];
        const scenes = clearScenes(ee, region, teaMask, window);
        const fresh = scenes.filterDate(addDays(date, -every + 1), addDays(date, 1));
        if ((await evaluate<number>(scenes.size())) === 0) {
            newObservation.push(false);
            sceneDates.push([]);
            for (const g of gardens) {
                const list = perGarden.get(g.id) ?? [];
                list.push({ observed: 0, pruned: 0 });
                perGarden.set(g.id, list);
            }
            console.log(`  ${date}: son ${LOOKBACK_DAYS} günde bulutsuz sahne yok (${i + 1}/${dates.length})`);
            continue;
        }
        const after = opticalComposite(ee, region, teaMask, window);
        const step = relativeDrop(ee, reference, after, teaMask, region);
        const sums = area.multiply(teaMask).rename('tea')
            .addBands(area.multiply(step.valid.unmask(0)).updateMask(teaMask).rename('observed'))
            .addBands(area.multiply(step.share.unmask(0)).updateMask(teaMask).rename('pruned'))
            .reduceRegions({ collection: gardenCollection, reducer: ee.Reducer.sum(), scale: SCALE_M, tileScale: 4 });
        const [rows, freshDates] = await Promise.all([
            evaluate<{ features: Array<{ properties: GardenScanRow }> }>(sums),
            evaluate<string[]>(fresh.aggregate_array('system:time_start').map((t: EE) => ee.Date(t).format('YYYY-MM-dd'))),
        ]);
        const hasFresh = freshDates.length > 0;
        newObservation.push(hasFresh);
        sceneDates.push([...new Set(freshDates)].sort());
        if (hasFresh || i === 0) shareImages.push(step.share.unmask(0).updateMask(teaMask));
        for (const { properties: r } of rows.features) {
            if (!tea.has(r.id)) tea.set(r.id, r.tea ?? 0);
            const list = perGarden.get(r.id) ?? [];
            list.push({ observed: r.observed ?? 0, pruned: r.pruned ?? 0 });
            perGarden.set(r.id, list);
        }
        console.log(`  ${date}: ${hasFresh ? `yeni sahne ${[...new Set(freshDates)].join(', ')}` : 'yeni bulutsuz sahne yok'} (${i + 1}/${dates.length})`);
    }

    // ── Season pruned map → event polygons per garden ──
    console.log('Olay poligonları çıkarılıyor…');
    const seasonMap = shareImages.length > 0 ? ee.ImageCollection(shareImages).max() : ee.Image(0).updateMask(teaMask);
    const patches = await evaluate<FeatureCollection<Poly>>(
        seasonMap.gte(EVENT_SHARE).selfMask().reduceToVectors({ geometry: region, scale: SCALE_M, geometryType: 'polygon', eightConnected: true, maxPixels: 1e8, tileScale: 8 }),
    );
    const patchFeatures = patches.features.map((f) => feature(f.geometry as Poly));
    const seasonPruned = patchFeatures.length === 0 ? null : patchFeatures.length === 1 ? patchFeatures[0] : union(featureCollection(patchFeatures));

    const events: PruningEvent[] = [];
    const gardenOut = gardens.map((g: DemoGarden) => {
        const scans = perGarden.get(g.id) ?? [];
        let best = 0;
        const cumulative = scans.map((s, i) => {
            if (newObservation[i] || i === 0) best = Math.max(best, s.pruned);
            return Math.round(best);
        });
        const window = eventWindow(cumulative, newObservation, sceneDates, dates);
        let eventAreaM2 = 0;
        let reusedM2 = 0;
        if (seasonPruned) {
            const hit = intersectArea(g.geometry, seasonPruned.geometry as Poly);
            if (hit.geometry && hit.areaM2 >= EVENT_MIN_RISE_M2) {
                const reused = previous.ground ? intersectArea(hit.geometry, previous.ground).areaM2 : 0;
                eventAreaM2 = Math.round(hit.areaM2);
                reusedM2 = Math.round(reused);
                events.push({ gardenId: g.id, areaM2: eventAreaM2, reusedM2, ...window, geometry: hit.geometry });
            }
        }
        // Reuse is measured on the event polygon; applied pro rata to the sub-pixel cumulative estimate.
        const reuseRatio = eventAreaM2 > 0 ? Math.min(1, reusedM2 / eventAreaM2) : 0;
        return {
            ...g,
            teaAreaM2: Math.round(tea.get(g.id) ?? 0),
            observedM2: scans.map((s) => Math.round(s.observed)),
            prunedM2: cumulative,
            reusedM2: cumulative.map((v) => Math.round(v * reuseRatio)),
            eventAreaM2,
            eventReusedM2: reusedM2,
            ...window,
        };
    });
    const byId = new Map(gardenOut.map((g) => [g.id, g]));

    // Licensed area per producer: the digital licence register when it exists, else a DEMO
    // placeholder of the producer's tea area ± 10 % (real values come from ÇAYKUR).
    const registryPath = join(store.dir, 'licensing', 'registry.json');
    const registry = existsSync(registryPath) ? (JSON.parse(readFileSync(registryPath, 'utf8')) as LicensingRegistry) : null;
    if (registry) console.log('Ruhsat alanları: licensing/registry.json');
    let seed = 7;
    const jitter = () => {
        seed = (seed * 16807) % 2147483647;
        return 0.9 + ((seed % 1000) / 1000) * 0.2;
    };
    const seriesById = new Map<string, GardenSeries>(gardenOut.map((g) => [g.id, g]));
    const producerOut = producers.map((p) => {
        const teaAreaM2 = p.gardenIds.reduce((s, id) => s + (byId.get(id)?.teaAreaM2 ?? 0), 0);
        const licensedAreaM2 = registry ? producerLicensedAreaM2(registry, p.id) : Math.round(Math.max(teaAreaM2, 100) * jitter());
        return { ...p, ...evaluateProducerSeason(p.gardenIds, seriesById, dates, newObservation, licensedAreaM2) };
    });

    const counts = producerOut.reduce<Record<string, number>>((h, p) => ((h[p.status] = (h[p.status] ?? 0) + 1), h), {});
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `season-${windows.season}.json`), JSON.stringify({
        season: windows.season,
        every,
        lookbackDays: LOOKBACK_DAYS,
        reference: windows.reference,
        previousSeasons: previous.seasons,
        scanDates: dates,
        newObservation,
        sceneDates,
        producers: producerOut,
        gardens: gardenOut.map(({ geometry: _g, ...g }) => g),
        events,
    }));
    const totalReused = events.reduce((s, e) => s + e.reusedM2, 0);
    console.log(`Olaylar: ${events.length} poligon, ${Math.round(events.reduce((s, e) => s + e.areaM2, 0) / 1000)} da; önceki sezonlarla çakışan ${Math.round(totalReused / 1000)} da`);
    console.log(`Sezon sonu durumlar: ${JSON.stringify(counts)}`);
    console.log(`Yeni gözlem gelen tarama: ${newObservation.filter(Boolean).length}/${dates.length}`);
    console.log(`Çıktı: ${outDir}`);
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
