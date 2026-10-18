/**
 * Sentinel-2 series per garden for the multi-sensor pruning model: NDVI and NBR (NIR–SWIR) on
 * the clear, snow-free tea pixels of each garden, one value per acquisition date, plus how much
 * of the garden's tea was actually seen (clear share). Deep pruning (ÇAYKUR: bushes cut back to
 * 30–45 cm) removes the leafy canopy: NIR collapses, SWIR rises — NDVI and NBR both drop and stay
 * down for months, unlike cloud shadow, frost or thin snow which recover within days.
 */
import type { MultiPolygon, Polygon } from 'geojson';
import { evaluate } from '../ee/session.ts';

/* `ee` objects are untyped (see src/types/earthengine.d.ts). */
type EE = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const CLEAR_THRESHOLD = 0.6;
const SNOW_NDSI = 0.4;
const SCALE_M = 10;
/** Dates per request, so the band stack stays small enough for one reduceRegions evaluation. */
const DATES_PER_CHUNK = 20;

export interface OpticalSeries {
    dates: string[];
    /** Per garden id: NDVI, NBR (null when < minClearShare of the tea was clear) and the clear share. */
    gardens: Record<string, { ndvi: Array<number | null>; nbr: Array<number | null>; clear: number[] }>;
}

export async function opticalSeries(
    ee: EE,
    region: EE,
    teaMask: EE,
    gardens: Array<{ id: string; geometry: Polygon | MultiPolygon }>,
    window: [string, string],
    minClearShare = 0.5,
): Promise<OpticalSeries> {
    const cloudScore = ee.ImageCollection('GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED');
    const collection = ee
        .ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
        .filterBounds(region)
        .filterDate(window[0], window[1])
        .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 95))
        .linkCollection(cloudScore, ['cs_cdf'])
        .map((image: EE) => {
            const scaled = image.select(['B3', 'B4', 'B8', 'B12']).divide(10_000);
            const clear = image
                .select('cs_cdf')
                .gte(CLEAR_THRESHOLD)
                .and(scaled.normalizedDifference(['B3', 'B12']).lt(SNOW_NDSI))
                .and(image.select('SCL').neq(11))
                .updateMask(teaMask)
                .rename('CLEAR');
            const ndvi = scaled.normalizedDifference(['B8', 'B4']).rename('NDVI');
            const nbr = scaled.normalizedDifference(['B8', 'B12']).rename('NBR');
            return ndvi.addBands(nbr).updateMask(clear).addBands(clear.unmask(0).updateMask(teaMask)).set('date', image.date().format('YYYY-MM-dd'));
        });
    const dates = (await evaluate<string[]>(collection.aggregate_array('date').distinct().sort())) as string[];
    const fc = ee.FeatureCollection(gardens.map((g) => ee.Feature(ee.Geometry(g.geometry), { id: g.id })));
    const out: OpticalSeries['gardens'] = {};
    for (const g of gardens) out[g.id] = { ndvi: [], nbr: [], clear: [] };

    for (let i = 0; i < dates.length; i += DATES_PER_CHUNK) {
        const chunk = dates.slice(i, i + DATES_PER_CHUNK);
        const stack = ee.ImageCollection(
            ee.List(chunk).map((d: EE) =>
                collection.filter(ee.Filter.eq('date', d)).mosaic().rename([ee.String('NDVI_').cat(d), ee.String('NBR_').cat(d), ee.String('CLEAR_').cat(d)]),
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
                const ndvi = pick('NDVI', d);
                const nbr = pick('NBR', d);
                out[id]!.clear.push(Math.round(clear * 100) / 100);
                out[id]!.ndvi.push(ok && ndvi !== null ? Math.round(ndvi * 1000) / 1000 : null);
                out[id]!.nbr.push(ok && nbr !== null ? Math.round(nbr * 1000) / 1000 : null);
            }
        }
    }
    return { dates, gardens: out };
}
