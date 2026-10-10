import { readFileSync } from 'node:fs';
import { initEarthEngine, evaluate } from '../ee/session.ts';
import { NeighborhoodStore } from '../library/store.ts';

/** Smoke test: authenticate and count Sentinel-2 / Sentinel-1 scenes over the pilot neighborhood. */
async function main(): Promise<void> {
    const ee = await initEarthEngine();
    const meta = new NeighborhoodStore('Trabzon', 'Of', 'Çataldere').readMeta();
    if (!meta) {
        throw new Error('Çataldere meta.json yok; önce harvest çalıştırın.');
    }
    const region = ee.Geometry(meta.boundary);
    const s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED').filterBounds(region).filterDate('2024-01-01', '2026-01-01');
    const s1 = ee.ImageCollection('COPERNICUS/S1_GRD').filterBounds(region).filterDate('2024-01-01', '2026-01-01');
    const clearS2 = s2.filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 30));
    const [s2Count, clearCount, s1Count] = await Promise.all([
        evaluate<number>(s2.size()),
        evaluate<number>(clearS2.size()),
        evaluate<number>(s1.size()),
    ]);
    console.log(`Earth Engine OK (${JSON.parse(readFileSync('secrets/ee-key.json', 'utf8')).project_id})`);
    console.log(`Çataldere 2024–2025: Sentinel-2 ${s2Count} sahne (bulut <%30: ${clearCount}), Sentinel-1 ${s1Count} sahne`);
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
