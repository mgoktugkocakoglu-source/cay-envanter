import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { area, buffer } from '@turf/turf';
import type { MultiPolygon, Polygon } from 'geojson';
import { buildCoverFeatures, COVER_RULES } from '../cover/features.ts';
import { evaluate, initEarthEngine } from '../ee/session.ts';
import { LIBRARY_ROOT, NeighborhoodStore, slugify } from '../library/store.ts';
import type { Parcel } from '../tkgm/types.ts';

/* `ee` objects are untyped (see src/types/earthengine.d.ts). */
type EE = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Poly = Polygon | MultiPolygon;

const USAGE = `
Kullanım:
  npm run sample-cover -- --province Trabzon --district Of --neighborhood Çataldere [--only labels|pixels]

Arazi örtüsü modülünün Earth Engine adımı (ayrı modül; başka modülün çıktısına dokunmaz, TKGM'ye istek atmaz):
  labels : ilçe kütüphanesindeki etiketli pikseller → <mahalle>/land-cover/samples.csv
           çay / fındık / orman: tapu niteliği temiz parsellerin içi · çayır / ekili / yapı / diğer: ESA WorldCover
  pixels : hedef mahallenin bütün parsel pikselleri → <mahalle>/land-cover/pixels.csv
Sonra: .venv/Scripts/python.exe py/cover_experiments.py <mahalle klasörü>  ve  py/cover_classify.py <mahalle klasörü>
`;

/** Covers the deed title names without ambiguity; everything else in a title (çayır, tarla, mixed) is left out. */
const TITLE_CLASS: Array<[RegExp, string]> = [
    [/^çay bahçesi\.?$/, 'tea'],
    [/^(fındık bahçesi|fındıklık)\.?$/, 'hazelnut'],
    [/^orman\.?$/, 'forest'],
];
/** ESA WorldCover codes for the covers titles do not give. */
const MAP_CLASS: Array<[number, string]> = [[30, 'grass'], [40, 'crop'], [50, 'built'], [60, 'other'], [80, 'other']];

const titleClass = (nature: string): string | null => TITLE_CLASS.find(([re]) => re.test(nature.trim().toLocaleLowerCase('tr')))?.[1] ?? null;

/**
 * Rows of a sampled collection as plain numbers. The service account may not export tables, so the rows come back
 * through one reduction; every selected property must be numeric (text properties are sent as indexes).
 * Pixels with a missing band are left out by the reducer.
 */
async function rowsOf(fc: EE, selectors: string[]): Promise<number[][]> {
    const result = await evaluate<{ list: number[][] }>(fc.reduceColumns({ reducer: ee.Reducer.toList(selectors.length), selectors }));
    return result.list;
}
let ee: EE;

async function main(): Promise<void> {
    const { values } = parseArgs({ options: { province: { type: 'string' }, district: { type: 'string' }, neighborhood: { type: 'string' }, only: { type: 'string' } } });
    if (!values.province || !values.district || !values.neighborhood) {
        console.log(USAGE);
        process.exit(1);
    }
    const R = COVER_RULES;
    const store = new NeighborhoodStore(values.province, values.district, values.neighborhood);
    const outDir = join(store.dir, 'land-cover');
    mkdirSync(outDir, { recursive: true });
    const districtDir = join(LIBRARY_ROOT, slugify(values.province), slugify(values.district));
    const pool = readdirSync(districtDir)
        .filter((n) => existsSync(join(districtDir, n, 'parcels.ndjson')))
        .flatMap((n) => new NeighborhoodStore(values.province as string, values.district as string, n).loadParcels().map((p) => ({ p, neighborhood: n })));
    const targets = store.loadParcels();
    ee = await initEarthEngine();
    const inner = (p: Parcel) => (buffer(p, -R.innerBufferM, { units: 'meters' })?.geometry ?? null) as Poly | null;
    const labelled = pool.map(({ p, neighborhood }) => ({ p, neighborhood, cls: titleClass(p.properties.nature), geometry: inner(p) })).filter((x): x is { p: Parcel; neighborhood: string; cls: string; geometry: Poly } => x.cls !== null && x.geometry !== null);
    const region = ee.FeatureCollection([...labelled.map((t) => ee.Feature(ee.Geometry(t.geometry))), ...targets.map((t) => ee.Feature(ee.Geometry(t.geometry)))]).geometry(1).bounds(1);
    const { features, extras } = buildCoverFeatures(ee, region);
    const bands: string[] = await evaluate(features.bandNames());
    const stack = features.addBands(extras.select(['elevation', 'lon', 'lat']));
    writeFileSync(join(outDir, 'bands.json'), JSON.stringify({ generatedAt: new Date().toISOString(), rules: R, bands }));
    console.log(`Öznitelik: ${bands.length} bant · etiketli parsel ${labelled.length} · hedef parsel ${targets.length}`);

    if (values.only !== 'pixels') {
        const byClass = (c: string) => labelled.filter((t) => t.cls === c);
        const lines: string[] = [['cls', 'grp', 'nbh', 'elevation', 'lon', 'lat', ...bands].join(',')];
        for (const [, cls] of TITLE_CLASS) {
            const own = byClass(cls);
            const cap = cls === 'tea' ? R.maxPixelsPerClass * 2 : R.maxPixelsPerClass;
            const sampled = stack
                .sampleRegions({ collection: ee.FeatureCollection(own.map((t) => ee.Feature(ee.Geometry(t.geometry), { gid: labelled.indexOf(t) }))), properties: ['gid'], scale: R.scaleM, tileScale: 8 })
                .randomColumn('rnd', 42)
                .limit(cap, 'rnd');
            const got = await rowsOf(sampled, ['gid', 'elevation', 'lon', 'lat', ...bands]);
            for (const [gid, ...rest] of got) {
                const t = labelled[gid as number] as (typeof labelled)[number];
                lines.push([cls, t.p.properties.key, t.neighborhood, ...rest].join(','));
            }
            console.log(`  ${cls}: ${own.length} parsel → ${got.length} piksel (üst sınır ${cap})`);
        }
        // Covers the titles do not give, from the global map; pixels inside tea-titled parcels are never taken as "not tea".
        const worldCover = ee.ImageCollection('ESA/WorldCover/v200').first().select('Map');
        const teaMask = ee.Image(0).byte().paint(ee.FeatureCollection(byClass('tea').map((t) => ee.Feature(ee.Geometry(t.p.geometry)))), 1);
        const codes = [...new Set(MAP_CLASS.map(([code]) => code))];
        const mapped = stack
            .addBands(worldCover.rename('wc'))
            .updateMask(teaMask.not())
            .stratifiedSample({ numPoints: R.mapPixelsPerClass, classBand: 'wc', classValues: codes, classPoints: codes.map(() => R.mapPixelsPerClass), region, scale: R.scaleM, seed: 42, tileScale: 8, dropNulls: true });
        for (const [wc, ...rest] of await rowsOf(mapped, ['wc', 'elevation', 'lon', 'lat', ...bands])) {
            const cls = MAP_CLASS.find(([code]) => code === wc)?.[1];
            if (cls) lines.push([cls, 'map', 'map', ...rest].join(','));
        }
        writeFileSync(join(outDir, 'samples.csv'), lines.join('\n') + '\n');
        const counts = lines.slice(1).reduce<Record<string, number>>((acc, l) => ((acc[l.slice(0, l.indexOf(','))] = (acc[l.slice(0, l.indexOf(','))] ?? 0) + 1), acc), {});
        console.log(`Etiketli piksel: ${lines.length - 1} satır ${JSON.stringify(counts)} → ${join(outDir, 'samples.csv')}`);
    }

    if (values.only !== 'labels') {
        // Every pixel of every target parcel, in chunks an export request can carry.
        const chunks: Parcel[][] = [];
        let current: Parcel[] = [];
        let budget = 0;
        for (const p of targets) {
            const px = area(p.geometry as Poly) / 100;
            if (current.length && budget + px > 4000) {
                chunks.push(current);
                current = [];
                budget = 0;
            }
            current.push(p);
            budget += px;
        }
        if (current.length) chunks.push(current);
        const out: string[] = [['key', 'elevation', 'lon', 'lat', ...bands].join(',')];
        for (const [i, chunk] of chunks.entries()) {
            const fc = stack.sampleRegions({ collection: ee.FeatureCollection(chunk.map((p, n) => ee.Feature(ee.Geometry(p.geometry), { pid: n }))), properties: ['pid'], scale: R.scaleM, tileScale: 8 });
            const got = await rowsOf(fc, ['pid', 'elevation', 'lon', 'lat', ...bands]);
            for (const [pid, ...rest] of got) out.push([(chunk[pid as number] as Parcel).properties.key, ...rest].join(','));
            console.log(`  hedef pikseller ${i + 1}/${chunks.length}: ${got.length} satır`);
        }
        writeFileSync(join(outDir, 'pixels.csv'), out.join('\n') + '\n');
        console.log(`Hedef piksel: ${out.length - 1} satır → ${join(outDir, 'pixels.csv')}`);
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
