/*
 * Per-parcel NDVI time series on tea pixels (the "pruning curve"), one point per usable
 * Sentinel-2 scene. `ee` is the untyped Earth Engine client (see src/types).
 */
import { evaluate } from './session.ts';

type EE = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const CLEAR_THRESHOLD = 0.6;
const SNOW_NDSI = 0.4;
/** A scene is kept only when at least this share of the tea pixels is clear and snow-free. */
const MIN_VALID_TEA_SHARE = 0.3;
/** Scenes per request: ~330 parcel rows each, under Earth Engine's 5,000-element getInfo cap. */
const SCENES_PER_CHUNK = 12;

export interface NdviSeries {
    dates: string[];
    neighborhoodMedian: number[];
    validTeaShare: number[];
    /** Parcel key → NDVI per date (null where the parcel's tea was clouded, snowed or missing). */
    parcels: Record<string, Array<number | null>>;
}

function cleanNdvi(ee: EE, image: EE, teaMask: EE): EE {
    const scaled = image.select(['B3', 'B4', 'B8', 'B11']).divide(10_000);
    const clear = image.select('cs_cdf').gte(CLEAR_THRESHOLD)
        .and(scaled.normalizedDifference(['B3', 'B11']).lt(SNOW_NDSI))
        .and(image.select('SCL').neq(11));
    return scaled.normalizedDifference(['B8', 'B4']).rename('NDVI').updateMask(clear.and(teaMask));
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

export async function parcelNdviSeries(ee: EE, region: EE, teaMask: EE, parcels: EE, start: string, end: string, log: (line: string) => void): Promise<NdviSeries> {
    const cloudScore = ee.ImageCollection('GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED');
    const collection = ee
        .ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
        .filterBounds(region)
        .filterDate(start, end)
        .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 80))
        .linkCollection(cloudScore, ['cs_cdf'])
        .sort('system:time_start');
    const teaPixels = ee.Number(teaMask.selfMask().reduceRegion({ reducer: ee.Reducer.count(), geometry: region, scale: 10, maxPixels: 1e9 }).values().get(0));

    // Scene-level screening: date, neighbourhood median and how much of the tea was visible.
    const screened = collection.map((image: EE) => {
        const ndvi = cleanNdvi(ee, image, teaMask);
        const stats = ndvi.reduceRegion({ reducer: ee.Reducer.median().combine(ee.Reducer.count(), null, true), geometry: region, scale: 10, maxPixels: 1e9 });
        return ee.Feature(null, {
            id: image.get('system:index'),
            date: ee.Date(image.get('system:time_start')).format('YYYY-MM-dd'),
            median: stats.get('NDVI_median'),
            valid: ee.Number(stats.get('NDVI_count')).divide(teaPixels),
        });
    });
    const scenes = (await evaluate<{ features: Array<{ properties: { id: string; date: string; median: number | null; valid: number } }> }>(ee.FeatureCollection(screened)))
        .features.map((f) => f.properties)
        .filter((s) => s.median !== null && s.valid >= MIN_VALID_TEA_SHARE);
    // Same-day tiles (two granules) → keep the one that saw more tea.
    const byDate = new Map<string, (typeof scenes)[number]>();
    for (const scene of scenes) {
        const kept = byDate.get(scene.date);
        if (!kept || scene.valid > kept.valid) byDate.set(scene.date, scene);
    }
    const usable = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    log(`  ${usable.length} kullanılabilir sahne (${scenes.length} aday)`);

    const series: NdviSeries = {
        dates: usable.map((s) => s.date),
        neighborhoodMedian: usable.map((s) => round3(s.median as number)),
        validTeaShare: usable.map((s) => round3(s.valid)),
        parcels: {},
    };
    for (let i = 0; i < usable.length; i += SCENES_PER_CHUNK) {
        const chunk = usable.slice(i, i + SCENES_PER_CHUNK);
        const perScene = chunk.map((scene) => {
            const ndvi = cleanNdvi(ee, collection.filter(ee.Filter.eq('system:index', scene.id)).first(), teaMask);
            return ndvi
                .reduceRegions({ collection: parcels, reducer: ee.Reducer.mean(), scale: 10, tileScale: 4 })
                .filter(ee.Filter.notNull(['mean']))
                .map((f: EE) => ee.Feature(null, { key: f.get('key'), date: scene.date, ndvi: f.get('mean') }));
        });
        const rows = await evaluate<{ features: Array<{ properties: { key: string; date: string; ndvi: number } }> }>(ee.FeatureCollection(perScene).flatten());
        for (const { properties: row } of rows.features) {
            const values = (series.parcels[row.key] ??= series.dates.map(() => null));
            values[series.dates.indexOf(row.date)] = round3(row.ndvi);
        }
        log(`  ${Math.min(i + SCENES_PER_CHUNK, usable.length)}/${usable.length} sahne işlendi`);
    }
    return series;
}
