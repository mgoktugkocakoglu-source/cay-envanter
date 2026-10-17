/**
 * Sentinel-1 GRD backscatter series per garden, one series per orbit direction.
 *
 * Borrowed from grassland mowing detection (Sen4CAP mowing marker, Copernicus HR-VPP): a cut
 * removes the leafy canopy, so cross-polarised backscatter (VH) and the VH/VV ratio drop and
 * stay down. Tea pruning removes the canopy the same way — and unlike grass it does not grow
 * back within weeks, so the drop must persist. Ascending and descending passes see the slopes
 * from different sides and are never mixed: each gets its own series.
 */
import type { MultiPolygon, Polygon } from 'geojson';
import { evaluate } from '../ee/session.ts';

/* `ee` objects are untyped (see src/types/earthengine.d.ts). */
type EE = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export type OrbitPass = 'ASCENDING' | 'DESCENDING';

export interface PassSeries {
    pass: OrbitPass;
    relativeOrbit: number;
    dates: string[];
    /** Per garden id: VV and VH in dB per date (null where the garden had no valid pixels). */
    gardens: Record<string, { vv: Array<number | null>; vh: Array<number | null> }>;
}

const SCALE_M = 10;

/** Dominant relative orbit of a pass over the region in the window (the one with most scenes). */
async function dominantOrbit(ee: EE, collection: EE): Promise<number | null> {
    const hist = await evaluate<Record<string, number>>(collection.aggregate_histogram('relativeOrbitNumber_start'));
    const best = Object.entries(hist).sort((a, b) => b[1] - a[1])[0];
    return best ? Number(best[0]) : null;
}

export async function backscatterSeries(
    ee: EE,
    region: EE,
    gardens: Array<{ id: string; geometry: Polygon | MultiPolygon }>,
    window: [string, string],
    pass: OrbitPass,
): Promise<PassSeries | null> {
    const base = ee
        .ImageCollection('COPERNICUS/S1_GRD')
        .filterBounds(region)
        .filterDate(window[0], window[1])
        .filter(ee.Filter.eq('instrumentMode', 'IW'))
        .filter(ee.Filter.eq('orbitProperties_pass', pass))
        .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH'))
        .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV'));
    const orbit = await dominantOrbit(ee, base);
    if (orbit === null) return null;
    // One image per acquisition date (frames of the same pass are mosaicked), sorted in time.
    const perDate = base
        .filter(ee.Filter.eq('relativeOrbitNumber_start', orbit))
        .map((img: EE) => img.set('date', img.date().format('YYYY-MM-dd')));
    const dates = (await evaluate<string[]>(perDate.aggregate_array('date').distinct().sort())) as string[];
    if (dates.length === 0) return null;
    const stack = ee.ImageCollection(
        ee.List(dates).map((d: EE) =>
            perDate.filter(ee.Filter.eq('date', d)).select(['VV', 'VH']).mosaic().rename([ee.String('VV_').cat(d), ee.String('VH_').cat(d)]),
        ),
    ).toBands();
    // toBands prefixes "<index>_"; strip it back to "VV_<date>" when reading.
    const fc = ee.FeatureCollection(gardens.map((g) => ee.Feature(ee.Geometry(g.geometry), { id: g.id })));
    const rows = await evaluate<{ features: Array<{ properties: Record<string, number | string | null> }> }>(
        stack.reduceRegions({ collection: fc, reducer: ee.Reducer.mean(), scale: SCALE_M }),
    );
    const out: PassSeries['gardens'] = {};
    for (const { properties } of rows.features) {
        const id = String(properties.id);
        const pick = (pol: 'VV' | 'VH') =>
            dates.map((d) => {
                const key = Object.keys(properties).find((k) => k.endsWith(`${pol}_${d}`));
                const v = key ? properties[key] : null;
                return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
            });
        out[id] = { vv: pick('VV'), vh: pick('VH') };
    }
    return { pass, relativeOrbit: orbit, dates, gardens: out };
}
