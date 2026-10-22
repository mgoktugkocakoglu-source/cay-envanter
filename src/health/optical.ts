/**
 * Sentinel-2 growing-season series per garden for the garden-health module: NDVI (vigour),
 * NDRE (red-edge chlorophyll / nitrogen status) and NBR, on the clear tea pixels of each garden,
 * one value per acquisition date. Separate from the pruning optical series so the pruning
 * model is not touched; the two share the cloud / snow masking recipe.
 */
import type { MultiPolygon, Polygon } from 'geojson';
import { evaluate } from '../ee/session.ts';

/* `ee` objects are untyped (see src/types/earthengine.d.ts). */
type EE = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const CLEAR_THRESHOLD = 0.6;
const SNOW_NDSI = 0.4;
const SCALE_M = 10;
const DATES_PER_CHUNK = 16;

export interface GrowingSeries {
    dates: string[];
    /** Per garden id: NDVI, NDRE, NBR (null when < minClearShare of the tea was clear) and the clear share. */
    gardens: Record<string, { ndvi: Array<number | null>; ndre: Array<number | null>; nbr: Array<number | null>; clear: number[] }>;
}

export async function growingSeries(
    ee: EE,
    region: EE,
    teaMask: EE,
    gardens: Array<{ id: string; geometry: Polygon | MultiPolygon }>,
    window: [string, string],
    minClearShare = 0.5,
): Promise<GrowingSeries> {
    const cloudScore = ee.ImageCollection('GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED');
    const collection = ee
        .ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
        .filterBounds(region)
        .filterDate(window[0], window[1])
        .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 95))
        .linkCollection(cloudScore, ['cs_cdf'])
        .map((image: EE) => {
            const scaled = image.select(['B3', 'B4', 'B5', 'B8', 'B8A', 'B12']).divide(10_000);
            const clear = image
                .select('cs_cdf')
                .gte(CLEAR_THRESHOLD)
                .and(scaled.normalizedDifference(['B3', 'B12']).lt(SNOW_NDSI))
                .and(image.select('SCL').neq(11))
                .updateMask(teaMask)
                .rename('CLEAR');
            const ndvi = scaled.normalizedDifference(['B8', 'B4']).rename('NDVI');
            const ndre = scaled.normalizedDifference(['B8A', 'B5']).rename('NDRE');
            const nbr = scaled.normalizedDifference(['B8', 'B12']).rename('NBR');
            return ndvi.addBands(ndre).addBands(nbr).updateMask(clear).addBands(clear.unmask(0).updateMask(teaMask)).set('date', image.date().format('YYYY-MM-dd'));
        });
    const dates = (await evaluate<string[]>(collection.aggregate_array('date').distinct().sort())) as string[];
    const fc = ee.FeatureCollection(gardens.map((g) => ee.Feature(ee.Geometry(g.geometry), { id: g.id })));
    const out: GrowingSeries['gardens'] = {};
    for (const g of gardens) out[g.id] = { ndvi: [], ndre: [], nbr: [], clear: [] };

    for (let i = 0; i < dates.length; i += DATES_PER_CHUNK) {
        const chunk = dates.slice(i, i + DATES_PER_CHUNK);
        const stack = ee.ImageCollection(
            ee.List(chunk).map((d: EE) =>
                collection
                    .filter(ee.Filter.eq('date', d))
                    .mosaic()
                    .rename([ee.String('NDVI_').cat(d), ee.String('NDRE_').cat(d), ee.String('NBR_').cat(d), ee.String('CLEAR_').cat(d)]),
            ),
        ).toBands();
        const rows = await evaluate<{ features: Array<{ properties: Record<string, number | string | null> }> }>(
            stack.reduceRegions({ collection: fc, reducer: ee.Reducer.mean(), scale: SCALE_M }),
        );
        for (const { properties } of rows.features) {
            const id = String(properties.id);
            const pick = (prefix: string, d: string): number | null => {
                const key = Object.keys(properties).find((k) => k.endsWith(`${prefix}_${d}`));
                const v = key ? properties[key] : null;
                return typeof v === 'number' && Number.isFinite(v) ? v : null;
            };
            for (const d of chunk) {
                const clear = pick('CLEAR', d) ?? 0;
                const ok = clear >= minClearShare;
                const r3 = (v: number | null) => (ok && v !== null ? Math.round(v * 1000) / 1000 : null);
                out[id]!.clear.push(Math.round(clear * 100) / 100);
                out[id]!.ndvi.push(r3(pick('NDVI', d)));
                out[id]!.ndre.push(r3(pick('NDRE', d)));
                out[id]!.nbr.push(r3(pick('NBR', d)));
            }
        }
    }
    return { dates, gardens: out };
}
