import type { MultiPolygon, Polygon } from 'geojson';
import { evaluate } from '../ee/session.ts';
import { collection, landsatNdvi, num, type ParcelInput } from '../land/ee-layers.ts';

/* `ee` objects are untyped (see src/types/earthengine.d.ts). */
type EE = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Poly = Polygon | MultiPolygon;

const LANDSAT_SCALE_M = 30;
const S2_SCALE_M = 10;
const YEARS_PER_CALL = 6;
const CLEAR_THRESHOLD = 0.6;
const SNOW_NDSI = 0.4;
/** April … October: the tea growing season in the eastern Black Sea. */
export const S2_MONTHS = [4, 5, 6, 7, 8, 9, 10];

/** Yearly summer (Jun–Sep) Landsat NDVI per parcel since 1984, plus the mean number of clear observations per pixel. */
export interface LandsatYearlyRaw {
    years: number[];
    parcels: Record<string, { ndvi: Array<number | null>; obs: Array<number | null> }>;
}

export async function landsatYearly(ee: EE, boundary: Poly, parcels: ParcelInput[], fromYear: number, toYear: number, log: (s: string) => void): Promise<LandsatYearlyRaw> {
    const region = ee.Geometry(boundary);
    const fc = collection(ee, parcels);
    const out: LandsatYearlyRaw = { years: [], parcels: {} };
    for (const p of parcels) out.parcels[p.key] = { ndvi: [], obs: [] };
    for (let y = fromYear; y <= toYear; y++) out.years.push(y);
    if (parcels.length === 0) return out;
    for (let start = fromYear; start <= toYear; start += YEARS_PER_CALL) {
        const years = out.years.filter((y) => y >= start && y < start + YEARS_PER_CALL);
        let stack: EE = null;
        for (const y of years) {
            const col = landsatNdvi(ee, region, y, y);
            const ndvi = ee.Image(ee.Algorithms.If(col.size().gt(0), col.median().select('ndvi'), ee.Image.constant(0).updateMask(0))).rename(`ndvi_${y}`);
            const obs = ee.Image(ee.Algorithms.If(col.size().gt(0), col.count().select('ndvi'), ee.Image.constant(0).updateMask(0))).rename(`obs_${y}`);
            stack = stack ? stack.addBands(ndvi).addBands(obs) : ndvi.addBands(obs);
        }
        const rows = await evaluate<{ features: Array<{ properties: Record<string, unknown> }> }>(
            stack.reduceRegions({ collection: fc, reducer: ee.Reducer.mean(), scale: LANDSAT_SCALE_M, tileScale: 4 }),
        );
        for (const f of rows.features) {
            const key = String(f.properties.key);
            const target = out.parcels[key];
            if (!target) continue;
            for (const y of years) {
                const v = num(f.properties[`ndvi_${y}`]);
                target.ndvi.push(v === null ? null : Math.round(v * 1000) / 1000);
                const o = num(f.properties[`obs_${y}`]);
                target.obs.push(o === null ? null : Math.round(o * 10) / 10);
            }
        }
        log(`  Landsat ${years[0]}–${years.at(-1)}`);
    }
    return out;
}

/** Monthly (Apr–Oct) Sentinel-2 NDVI medians per parcel on clear pixels, per year. */
export interface S2MonthlyRaw {
    years: number[];
    months: number[];
    /** parcel key → year → NDVI per month (null when no clear observation). */
    parcels: Record<string, Record<number, Array<number | null>>>;
}

export async function s2Monthly(ee: EE, boundary: Poly, parcels: ParcelInput[], fromYear: number, toYear: number, log: (s: string) => void): Promise<S2MonthlyRaw> {
    const region = ee.Geometry(boundary);
    const fc = collection(ee, parcels);
    const out: S2MonthlyRaw = { years: [], months: S2_MONTHS, parcels: {} };
    for (const p of parcels) out.parcels[p.key] = {};
    if (parcels.length === 0) return out;
    const cloudScore = ee.ImageCollection('GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED');
    for (let y = fromYear; y <= toYear; y++) {
        const col = ee
            .ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
            .filterBounds(region)
            .filterDate(`${y}-04-01`, `${y}-11-01`)
            .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 95))
            .linkCollection(cloudScore, ['cs_cdf'])
            .map((image: EE) => {
                const scaled = image.select(['B3', 'B4', 'B8', 'B12']).divide(10_000);
                const clear = image.select('cs_cdf').gte(CLEAR_THRESHOLD).and(scaled.normalizedDifference(['B3', 'B12']).lt(SNOW_NDSI)).and(image.select('SCL').neq(11));
                return scaled.normalizedDifference(['B8', 'B4']).rename('ndvi').updateMask(clear).copyProperties(image, ['system:time_start']);
            });
        const size: number = await evaluate(col.size());
        if (size === 0) {
            log(`  Sentinel-2 ${y}: görüntü yok`);
            continue;
        }
        let stack: EE = null;
        for (const m of S2_MONTHS) {
            const monthly = col.filter(ee.Filter.calendarRange(m, m, 'month'));
            const img = ee.Image(ee.Algorithms.If(monthly.size().gt(0), monthly.median().select('ndvi'), ee.Image.constant(0).updateMask(0))).rename(`m_${m}`);
            stack = stack ? stack.addBands(img) : img;
        }
        const rows = await evaluate<{ features: Array<{ properties: Record<string, unknown> }> }>(
            stack.reduceRegions({ collection: fc, reducer: ee.Reducer.mean(), scale: S2_SCALE_M, tileScale: 4 }),
        );
        out.years.push(y);
        for (const f of rows.features) {
            const key = String(f.properties.key);
            const target = out.parcels[key];
            if (!target) continue;
            target[y] = S2_MONTHS.map((m) => {
                const v = num(f.properties[`m_${m}`]);
                return v === null ? null : Math.round(v * 1000) / 1000;
            });
        }
        log(`  Sentinel-2 ${y}: ${size} sahne`);
    }
    return out;
}
