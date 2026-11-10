/**
 * Optical series per unit (garden / change patch / free tea patch) for the multi-sensor pruning
 * model: one value per acquisition date on the clear, snow-free tea pixels of the unit.
 *
 * Deep pruning (ÇAYKUR: bushes cut back to 20 cm) removes the leafy canopy: NIR collapses, red
 * and SWIR rise. Four indices are kept because they fail differently under the confounders:
 *   NDVI  (B8, B4)   — the canopy signal; also drops under snow, frost browning and shadow.
 *   NBR   (B8, B12)  — drops under pruning, RISES under snow (snow is dark in SWIR): the pair
 *                      NDVI↓ + NBR↓ is pruning, NDVI↓ + NBR↑ is snow.
 *   NDRE  (B8A, B5)  — red-edge chlorophyll; less saturated than NDVI on dense tea (S2 only).
 *   NDII  (B8A, B11) — canopy water content; bare stems and soil are dry.
 *
 * Sentinel-2 L2A (10/20 m, Cloud Score+) is densified with Landsat 8/9 Collection 2 Level-2
 * (30 m, QA_PIXEL): the eastern Black Sea winter leaves few clear Sentinel-2 passes, and MODCiX
 * (Schwieder et al. 2026) shows event detection stabilises only above ~16 clear observations per
 * season. Landsat values are kept only for units large enough to hold more than one 30 m pixel,
 * and every date carries its sensor so the model can weigh them. Cross-sensor offsets vanish in
 * the neighbourhood-relative step (each date has one sensor; the date median is subtracted).
 */
import type { MultiPolygon, Polygon } from 'geojson';
import { area as turfArea, feature } from '@turf/turf';
import { evaluate, reduceDatesInChunks } from '../ee/session.ts';

/* `ee` objects are untyped (see src/types/earthengine.d.ts). */
type EE = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const CLEAR_THRESHOLD = 0.6;
const SNOW_NDSI = 0.4;
const SCALE_M = 10;
/** Dates per request, so the band stack stays small enough for one reduceRegions evaluation. */
const DATES_PER_CHUNK = 16;
/** Landsat (30 m) observations are used only for units at least this large (≈ 1.3 pixels). */
export const LANDSAT_MIN_AREA_M2 = 1200;

export type OpticalSensor = 'S2' | 'L8' | 'L9';
export type OpticalIndex = 'ndvi' | 'nbr' | 'ndre' | 'ndii';
export const OPTICAL_INDICES: OpticalIndex[] = ['ndvi', 'nbr', 'ndre', 'ndii'];

export interface OpticalSeries {
    version: 2;
    dates: string[];
    /** Sensor of each date (same order as `dates`). */
    sensors: OpticalSensor[];
    /** Per unit id: index values (null when < minClearShare of the tea was clear, or Landsat on a small unit) and the clear share. */
    gardens: Record<string, { ndvi: Array<number | null>; nbr: Array<number | null>; ndre: Array<number | null>; ndii: Array<number | null>; clear: number[] }>;
}

type Unit = { id: string; geometry: Polygon | MultiPolygon };

/** Sentinel-2 L2A: indices + clear mask on the tea pixels. */
function s2Collection(ee: EE, region: EE, teaMask: EE, window: [string, string]): EE {
    const cloudScore = ee.ImageCollection('GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED');
    return ee
        .ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
        .filterBounds(region)
        .filterDate(window[0], window[1])
        .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 95))
        .linkCollection(cloudScore, ['cs_cdf'])
        .map((image: EE) => {
            const s = image.select(['B3', 'B4', 'B5', 'B8', 'B8A', 'B11', 'B12']).divide(10_000);
            const clear = image
                .select('cs_cdf')
                .gte(CLEAR_THRESHOLD)
                .and(s.normalizedDifference(['B3', 'B11']).lt(SNOW_NDSI))
                .and(image.select('SCL').neq(11))
                .updateMask(teaMask)
                .rename('CLEAR');
            const ndvi = s.normalizedDifference(['B8', 'B4']).rename('NDVI');
            const nbr = s.normalizedDifference(['B8', 'B12']).rename('NBR');
            const ndre = s.normalizedDifference(['B8A', 'B5']).rename('NDRE');
            const ndii = s.normalizedDifference(['B8A', 'B11']).rename('NDII');
            return ndvi.addBands(nbr).addBands(ndre).addBands(ndii).updateMask(clear).addBands(clear.unmask(0).updateMask(teaMask)).set('date', image.date().format('YYYY-MM-dd')).set('sensor', 'S2');
        });
}

/** Landsat 8/9 Collection 2 Level-2: same indices (no red edge → NDRE masked), QA_PIXEL cloud/shadow/snow mask. */
function landsatCollection(ee: EE, region: EE, teaMask: EE, window: [string, string], id: 'LANDSAT/LC08/C02/T1_L2' | 'LANDSAT/LC09/C02/T1_L2', sensor: OpticalSensor): EE {
    return ee
        .ImageCollection(id)
        .filterBounds(region)
        .filterDate(window[0], window[1])
        .filter(ee.Filter.lt('CLOUD_COVER', 95))
        .map((image: EE) => {
            const qa = image.select('QA_PIXEL');
            // Bits 1 (dilated cloud), 2 (cirrus), 3 (cloud), 4 (shadow), 5 (snow) all clear.
            const qaClear = qa.bitwiseAnd(1 << 1).eq(0).and(qa.bitwiseAnd(1 << 2).eq(0)).and(qa.bitwiseAnd(1 << 3).eq(0)).and(qa.bitwiseAnd(1 << 4).eq(0)).and(qa.bitwiseAnd(1 << 5).eq(0));
            const s = image.select(['SR_B3', 'SR_B4', 'SR_B5', 'SR_B6', 'SR_B7']).multiply(0.0000275).add(-0.2);
            const clear = qaClear.and(s.normalizedDifference(['SR_B3', 'SR_B6']).lt(SNOW_NDSI)).updateMask(teaMask).rename('CLEAR');
            const ndvi = s.normalizedDifference(['SR_B5', 'SR_B4']).rename('NDVI');
            const nbr = s.normalizedDifference(['SR_B5', 'SR_B7']).rename('NBR');
            const ndre = ee.Image.constant(0).updateMask(0).rename('NDRE');
            const ndii = s.normalizedDifference(['SR_B5', 'SR_B6']).rename('NDII');
            return ndvi.addBands(nbr).addBands(ndre).addBands(ndii).updateMask(clear).addBands(clear.unmask(0).updateMask(teaMask)).set('date', image.date().format('YYYY-MM-dd')).set('sensor', sensor);
        });
}

async function reduceCollection(
    ee: EE,
    collection: EE,
    sensor: OpticalSensor,
    units: Unit[],
    minClearShare: number,
): Promise<{ dates: string[]; gardens: Record<string, { ndvi: Array<number | null>; nbr: Array<number | null>; ndre: Array<number | null>; ndii: Array<number | null>; clear: number[] }> }> {
    const dates = (await evaluate<string[]>(collection.aggregate_array('date').distinct().sort())) as string[];
    const fc = ee.FeatureCollection(units.map((g) => ee.Feature(ee.Geometry(g.geometry), { id: g.id })));
    const gardens: Record<string, { ndvi: Array<number | null>; nbr: Array<number | null>; ndre: Array<number | null>; ndii: Array<number | null>; clear: number[] }> = {};
    for (const g of units) gardens[g.id] = { ndvi: [], nbr: [], ndre: [], ndii: [], clear: [] };
    const props = await reduceDatesInChunks(
        ee,
        dates,
        (d: EE) =>
            collection
                .filter(ee.Filter.eq('date', d))
                .mosaic()
                .rename([ee.String('NDVI_').cat(d), ee.String('NBR_').cat(d), ee.String('NDRE_').cat(d), ee.String('NDII_').cat(d), ee.String('CLEAR_').cat(d)]),
        fc,
        SCALE_M,
        DATES_PER_CHUNK,
    );
    for (const g of units) {
        const row = props.get(g.id) ?? {};
        const pick = (prefix: string, d: string): number | null => row[`${prefix}_${d}`] ?? null;
        for (const d of dates) {
            const clear = pick('CLEAR', d) ?? 0;
            const ok = clear >= minClearShare;
            const r3 = (v: number | null) => (ok && v !== null ? Math.round(v * 1000) / 1000 : null);
            gardens[g.id]!.clear.push(Math.round(clear * 100) / 100);
            gardens[g.id]!.ndvi.push(r3(pick('NDVI', d)));
            gardens[g.id]!.nbr.push(r3(pick('NBR', d)));
            gardens[g.id]!.ndre.push(sensor === 'S2' ? r3(pick('NDRE', d)) : null);
            gardens[g.id]!.ndii.push(r3(pick('NDII', d)));
        }
    }
    return { dates, gardens };
}

/**
 * Sentinel-2 + Landsat 8/9 optical series for the units, merged by date (one sensor per entry).
 * Landsat entries are nulled for units smaller than LANDSAT_MIN_AREA_M2.
 */
export async function opticalSeries(ee: EE, region: EE, teaMask: EE, units: Unit[], window: [string, string], minClearShare = 0.5, withLandsat = true): Promise<OpticalSeries> {
    const parts: Array<{ sensor: OpticalSensor; result: Awaited<ReturnType<typeof reduceCollection>> }> = [];
    parts.push({ sensor: 'S2', result: await reduceCollection(ee, s2Collection(ee, region, teaMask, window), 'S2', units, minClearShare) });
    if (withLandsat) {
        const large = units.filter((u) => turfArea(feature(u.geometry)) >= LANDSAT_MIN_AREA_M2);
        if (large.length > 0) {
            for (const [id, sensor] of [['LANDSAT/LC08/C02/T1_L2', 'L8'], ['LANDSAT/LC09/C02/T1_L2', 'L9']] as Array<['LANDSAT/LC08/C02/T1_L2' | 'LANDSAT/LC09/C02/T1_L2', OpticalSensor]>) {
                const result = await reduceCollection(ee, landsatCollection(ee, region, teaMask, window, id, sensor), sensor, large, minClearShare);
                parts.push({ sensor, result });
            }
        }
    }
    // Merge: every (date, sensor) becomes one entry, sorted by date; units missing from a part get nulls.
    const entries: Array<{ date: string; sensor: OpticalSensor; part: number; index: number }> = [];
    parts.forEach((p, pi) => p.result.dates.forEach((d, i) => entries.push({ date: d, sensor: p.sensor, part: pi, index: i })));
    entries.sort((a, b) => a.date.localeCompare(b.date) || a.sensor.localeCompare(b.sensor));
    const out: OpticalSeries = { version: 2, dates: entries.map((e) => e.date), sensors: entries.map((e) => e.sensor), gardens: {} };
    for (const u of units) {
        const g = { ndvi: [] as Array<number | null>, nbr: [] as Array<number | null>, ndre: [] as Array<number | null>, ndii: [] as Array<number | null>, clear: [] as number[] };
        for (const e of entries) {
            const src = parts[e.part]!.result.gardens[u.id];
            g.ndvi.push(src?.ndvi[e.index] ?? null);
            g.nbr.push(src?.nbr[e.index] ?? null);
            g.ndre.push(src?.ndre[e.index] ?? null);
            g.ndii.push(src?.ndii[e.index] ?? null);
            g.clear.push(src?.clear[e.index] ?? 0);
        }
        out.gardens[u.id] = g;
    }
    return out;
}
