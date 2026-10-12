import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { initEarthEngine, evaluate } from '../ee/session.ts';
import { NeighborhoodStore } from '../library/store.ts';
import { buildDemoProducers } from '../producers/demo-producers.ts';
import { buildLicensingRegistry } from '../licensing/registry.ts';

const USAGE = `
Kullanım:
  npm run build-licensing -- --province Trabzon --district Of --neighborhood Çataldere

Demo dijital ruhsat kaydını üretir: müstahsil → ruhsat → çaylık alt-poligonu → parsel; eşleştirme
düzeyi (kesin / tarihsel / olası / eşleşmeyen), üç alan ölçüsü (ruhsat / izdüşüm / DEM ile eğimli
yüzey), sınır önerileri ve çakışmalar, geometri sürümleri, başvuru dosyaları.
Eğim Copernicus DEM'den (30 m) okunur: eğimli yüzey alanı teknik bir tahmindir, hukuki alan değildir.
`;

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: { province: { type: 'string' }, district: { type: 'string' }, neighborhood: { type: 'string' } },
    });
    if (!values.province || !values.district || !values.neighborhood) {
        console.log(USAGE);
        process.exit(1);
    }
    const store = new NeighborhoodStore(values.province, values.district, values.neighborhood);
    const meta = store.readMeta();
    const read = <T>(name: string): T => JSON.parse(readFileSync(join(store.dir, name), 'utf8')) as T;
    const parcels = read<FeatureCollection<Polygon | MultiPolygon, { key: string; block: string; parcel: string; locality: string; teaAreaM2: number | null }>>('parcels-tea.geojson');
    const teaPatches = read<FeatureCollection<Polygon | MultiPolygon>>('tea-patches.geojson');
    if (!meta) throw new Error('meta.json yok; önce harvest çalıştırın.');

    const { producers, gardens } = buildDemoProducers(parcels.features.map((f) => ({ ...f.properties, geometry: f.geometry })));

    // Measured tea per garden from the latest producer scan (already computed on the tea mask).
    const teaAreaByGarden = new Map<string, number>();
    const producersDir = join(store.dir, 'producers');
    if (existsSync(producersDir)) {
        const latest = readdirSync(producersDir).filter((n) => /^season-\d{4}-\d{2}\.json$/.test(n)).sort().at(-1);
        if (latest) {
            const file = JSON.parse(readFileSync(join(producersDir, latest), 'utf8')) as { gardens: Array<{ id: string; teaAreaM2: number }> };
            for (const g of file.gardens) teaAreaByGarden.set(g.id, g.teaAreaM2);
            console.log(`Bahçe çay alanları: ${latest}`);
        }
    }

    // Slope per garden from the DEM: mean of 1/cos(slope) turns a planimetric area into a surface area.
    console.log('Eğim (Copernicus DEM 30 m) okunuyor…');
    const ee = await initEarthEngine();
    const dem = ee.ImageCollection('COPERNICUS/DEM/GLO30').filterBounds(ee.Geometry(meta.boundary)).select('DEM').mosaic().setDefaultProjection('EPSG:4326', null, 30);
    const slope = ee.Terrain.slope(dem);
    const secant = slope.multiply(Math.PI / 180).cos().pow(-1).rename('secant').addBands(slope.rename('slope'));
    const rows = await evaluate<{ features: Array<{ properties: { id: string; secant?: number; slope?: number } }> }>(
        secant.reduceRegions({
            collection: ee.FeatureCollection(gardens.map((g) => ee.Feature(ee.Geometry(g.geometry), { id: g.id }))),
            reducer: ee.Reducer.mean(),
            scale: 30,
        }),
    );
    const slopeSecantByGarden = new Map<string, number>();
    const meanSlopeDegByGarden = new Map<string, number>();
    for (const { properties: r } of rows.features) {
        slopeSecantByGarden.set(r.id, r.secant ?? 1);
        meanSlopeDegByGarden.set(r.id, r.slope ?? 0);
    }

    const registry = buildLicensingRegistry({
        producers,
        gardens,
        parcels: parcels.features.map((f) => ({ key: f.properties.key, block: f.properties.block, parcel: f.properties.parcel, locality: f.properties.locality, geometry: f.geometry })),
        teaPatches: teaPatches.features.map((f) => f.geometry),
        teaAreaByGarden,
        slopeSecantByGarden,
        meanSlopeDegByGarden,
    });

    const outDir = join(store.dir, 'licensing');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'registry.json'), JSON.stringify(registry));
    const count = <T extends object>(items: T[], key: keyof T) =>
        items.reduce<Record<string, number>>((h, x) => ((h[String(x[key])] = (h[String(x[key])] ?? 0) + 1), h), {});
    const slopes = registry.gardens.map((g) => g.meanSlopeDeg);
    console.log(`Ruhsat: ${registry.licenses.length} · eşleşme ${JSON.stringify(count(registry.licenses, 'matchLevel'))}`);
    console.log(`Bahçe: ${registry.gardens.length} · onay durumu ${JSON.stringify(count(registry.gardens, 'approvalStatus'))}`);
    console.log(`Ortalama eğim ${(slopes.reduce((a, b) => a + b, 0) / slopes.length).toFixed(1)}°, yüzey/izdüşüm oranı ${(registry.gardens.reduce((s, g) => s + g.surfaceAreaM2, 0) / registry.gardens.reduce((s, g) => s + g.planimetricAreaM2, 0)).toFixed(3)}`);
    console.log(`Soyağacı ${registry.lineage.length} · çakışma ${registry.conflicts.length} · başvuru ${registry.applications.length} ${JSON.stringify(count(registry.applications, 'status'))}`);
    console.log(`Çıktı: ${join(outDir, 'registry.json')}`);
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
