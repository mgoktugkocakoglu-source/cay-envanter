import { buildEvidenceFeatures, EVIDENCE_RULES } from '../audit/tea-evidence.ts';

/* `ee` objects are untyped (see src/types/earthengine.d.ts). */
type EE = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Feature stack of the land-cover module: everything a per-pixel classifier could use to tell tea from the other
 * covers of the region, so that the sources can be compared on the same labelled pixels (py/cover_experiments.py):
 *   - the audit detector's stack (seasonal Sentinel-2 composites, NDVI percentiles, evergreen ratio, summer and autumn radar);
 *   - an NDVI climatology, one band per calendar month (the yearly rhythm of the cover);
 *   - radar for the other two seasons and its variability in time (a cut or ploughed field changes, forest does not).
 * No terrain and no position enters: the classifier must read the cover, not where tea usually is.
 * Band names carry their family: `NDVI_*` / `evergreen` (index), `B*_`, `NDRE_`, `NDMI_` (optical), `VV*` / `VH*` (radar).
 */
export const COVER_RULES = {
    start: EVIDENCE_RULES.start,
    end: EVIDENCE_RULES.end,
    scaleM: 10,
    /** Pixels are taken this far inside a titled parcel, away from the neighbour's cover. */
    innerBufferM: 3,
    /** Labelled pixels kept per class (tea gets twice this: it is the class the module exists for). */
    maxPixelsPerClass: 1500,
    /** Pixels per land-cover class of the global map, for covers deed titles do not give. */
    mapPixelsPerClass: 700,
};

export function buildCoverFeatures(ee: EE, region: EE): { features: EE; extras: EE } {
    const R = COVER_RULES;
    const { features: base, extras } = buildEvidenceFeatures(ee, region);
    const cloudScore = ee.ImageCollection('GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED');
    const ndvi = ee
        .ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
        .filterBounds(region)
        .filterDate(R.start, R.end)
        .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 70))
        .linkCollection(cloudScore, ['cs_cdf'])
        .map((image: EE) => {
            const scaled = image.select(['B3', 'B4', 'B8', 'B11']).divide(10_000);
            const snow = scaled.normalizedDifference(['B3', 'B11']).gt(EVIDENCE_RULES.snowNdsi);
            return scaled.normalizedDifference(['B8', 'B4']).rename('NDVI').updateMask(image.select('cs_cdf').gte(EVIDENCE_RULES.clearThreshold)).updateMask(snow.not()).copyProperties(image, ['system:time_start']);
        });
    const yearly = ndvi.median();
    const monthly = Array.from({ length: 12 }, (_, i) => ndvi.filter(ee.Filter.calendarRange(i + 1, i + 1, 'month')).median().unmask(yearly).rename(`NDVI_m${String(i + 1).padStart(2, '0')}`));
    const s1 = ee.ImageCollection('COPERNICUS/S1_GRD').filterBounds(region).filterDate(R.start, R.end).filter(ee.Filter.eq('instrumentMode', 'IW')).filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH')).select(['VV', 'VH']);
    const seasons = ([['win', 12, 2], ['spr', 3, 5]] as Array<[string, number, number]>).map(([name, from, to]) => {
        const median = s1.filter(ee.Filter.calendarRange(from, to, 'month')).median();
        return median.addBands(median.select('VH').subtract(median.select('VV')).rename('VHminusVV')).regexpRename('^(.*)$', `$1_${name}`);
    });
    const spread = s1.reduce(ee.Reducer.stdDev()).rename(['VV_std', 'VH_std']);
    const range = s1.select('VH').reduce(ee.Reducer.percentile([10, 90])).rename(['VH_p10', 'VH_p90']);
    const position = ee.Image.pixelLonLat().rename(['lon', 'lat']);
    return { features: ee.Image.cat([base, ...monthly, ...seasons, spread, range]).toFloat(), extras: ee.Image.cat([extras, position]).toFloat() };
}
