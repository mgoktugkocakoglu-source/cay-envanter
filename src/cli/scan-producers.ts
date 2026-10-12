import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { initEarthEngine, evaluate } from '../ee/session.ts';
import { clearScenes, opticalComposite, pruningWindows, relativeDrop } from '../ee/pruning.ts';
import { NeighborhoodStore } from '../library/store.ts';
import { buildDemoProducers } from '../producers/demo-producers.ts';
import { evaluateScans, type ScanInput } from '../producers/compliance.ts';

/* `ee` objects are untyped (see src/types/earthengine.d.ts). */
type EE = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const USAGE = `
Kullanım:
  npm run scan-producers -- --province Trabzon --district Of --neighborhood Çataldere [--season 2025] [--every 5]

Sezon boyunca (15 Kasım – 15 Nisan) her N günde bir tarama: son 20 günün bulutsuz sahneleri
referansla (Eki–Kas) karşılaştırılır, her bahçenin budanan alanı güncellenir ve müstahsil
toplamı 1/7 kuralına göre değerlendirilir. Geçmiş bir sezonda çalıştırıldığında, o sezon
canlı izlenseydi her tarama gününde ne görüleceğini yeniden üretir.
`;

/** Each scan compares the newest observations: clear scenes of the last LOOKBACK_DAYS. */
const LOOKBACK_DAYS = 20;
const SCALE_M = 10;

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
    const parcels = read<FeatureCollection<Polygon | MultiPolygon, { key: string; block: string; parcel: string; teaAreaM2: number | null }>>('parcels-tea.geojson');
    const teaPatches = read<FeatureCollection<Polygon | MultiPolygon>>('tea-patches.geojson');
    if (!meta) throw new Error('meta.json yok; önce harvest çalıştırın.');

    const { producers, gardens } = buildDemoProducers(
        parcels.features.map((f) => ({ ...f.properties, geometry: f.geometry })),
    );
    console.log(`Demo kayıt: ${producers.length} müstahsil, ${gardens.length} bahçe`);

    const ee = await initEarthEngine();
    const region = ee.Geometry(meta.boundary);
    const teaMask = ee.Image(0).byte().paint(ee.FeatureCollection(teaPatches.features.map((f) => ee.Feature(ee.Geometry(f.geometry)))), 1).eq(1);
    const gardenCollection = ee.FeatureCollection(gardens.map((g) => ee.Feature(ee.Geometry(g.geometry), { id: g.id })));
    const windows = pruningWindows(year);
    const reference = opticalComposite(ee, region, teaMask, windows.reference);
    const area = ee.Image.pixelArea();

    const dates = scanDates(year, every);
    // gardenId → per scan [observed m², pruned m²]; tea m² once.
    const tea = new Map<string, number>();
    const perGarden = new Map<string, Array<{ observed: number; pruned: number }>>();
    const newObservation: boolean[] = [];
    const sceneDates: string[][] = [];
    for (const [i, date] of dates.entries()) {
        const window: [string, string] = [addDays(date, -LOOKBACK_DAYS) > windows.reference[1] ? addDays(date, -LOOKBACK_DAYS) : windows.reference[1], addDays(date, 1)];
        const scenes = clearScenes(ee, region, teaMask, window);
        const fresh = scenes.filterDate(addDays(date, -every + 1), addDays(date, 1));
        if ((await evaluate<number>(scenes.size())) === 0) {
            // Nothing clear in the whole look-back window: the scan runs, but sees nothing.
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
        newObservation.push(freshDates.length > 0);
        sceneDates.push([...new Set(freshDates)].sort());
        for (const { properties: r } of rows.features) {
            if (!tea.has(r.id)) tea.set(r.id, r.tea ?? 0);
            const list = perGarden.get(r.id) ?? [];
            list.push({ observed: r.observed ?? 0, pruned: r.pruned ?? 0 });
            perGarden.set(r.id, list);
        }
        console.log(`  ${date}: ${freshDates.length ? `yeni sahne ${[...new Set(freshDates)].join(', ')}` : 'yeni bulutsuz sahne yok'} (${i + 1}/${dates.length})`);
    }

    // Pruning stays visible until the first flush: a garden's pruned area is the running maximum.
    const gardenOut = gardens.map((g) => {
        const scans = perGarden.get(g.id) ?? [];
        let best = 0;
        const cumulative = scans.map((s, i) => {
            if (newObservation[i] || i === 0) best = Math.max(best, s.pruned);
            return Math.round(best);
        });
        return {
            ...g,
            teaAreaM2: Math.round(tea.get(g.id) ?? 0),
            observedM2: scans.map((s) => Math.round(s.observed)),
            prunedM2: cumulative,
        };
    });
    const byId = new Map(gardenOut.map((g) => [g.id, g]));

    let seed = 7;
    const jitter = () => {
        seed = (seed * 16807) % 2147483647;
        return 0.9 + ((seed % 1000) / 1000) * 0.2;
    };
    const producerOut = producers.map((p) => {
        const own = p.gardenIds.map((id) => byId.get(id)).filter((g): g is NonNullable<typeof g> => !!g);
        const teaAreaM2 = own.reduce((s, g) => s + g.teaAreaM2, 0);
        // DEMO license area: the producer's tea area ± 10 % (real values come from ÇAYKUR).
        const licensedAreaM2 = Math.round(Math.max(teaAreaM2, 100) * jitter());
        const inputs: ScanInput[] = dates.map((date, i) => ({
            date,
            newObservation: newObservation[i] as boolean,
            licensedAreaM2,
            teaAreaM2,
            prunedM2: own.reduce((s, g) => s + (g.prunedM2[i] ?? 0), 0),
            observedShare: teaAreaM2 > 0 ? Math.min(1, own.reduce((s, g) => s + (g.observedM2[i] ?? 0), 0) / teaAreaM2) : 0,
        }));
        const scans = evaluateScans(inputs);
        const last = scans.at(-1);
        return {
            ...p,
            licensedAreaM2,
            teaAreaM2,
            requiredM2: last?.requiredM2 ?? 0,
            prunedM2: last?.prunedM2 ?? 0,
            status: last?.status ?? 'awaiting_observation',
            autoApprovedAt: scans.find((s) => s.status === 'auto_approved')?.date ?? null,
            scans: scans.map((s) => ({ date: s.date, prunedM2: Math.round(s.prunedM2), observedShare: Math.round(s.observedShare * 1000) / 1000, ratio: s.ratio, status: s.status })),
        };
    });

    const counts = producerOut.reduce<Record<string, number>>((h, p) => ((h[p.status] = (h[p.status] ?? 0) + 1), h), {});
    const outDir = join(store.dir, 'producers');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `season-${windows.season}.json`), JSON.stringify({
        season: windows.season,
        every,
        lookbackDays: LOOKBACK_DAYS,
        reference: windows.reference,
        scanDates: dates,
        newObservation,
        sceneDates,
        producers: producerOut,
        gardens: gardenOut,
    }));
    console.log(`Sezon sonu durumlar: ${JSON.stringify(counts)}`);
    console.log(`Yeni gözlem gelen tarama: ${newObservation.filter(Boolean).length}/${dates.length}`);
    console.log(`Çıktı: ${outDir}`);
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
