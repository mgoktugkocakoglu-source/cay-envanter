/* Earth Engine feature stack for tea detection. `ee` is the untyped Earth Engine client (see src/types). */
type EE = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const S2_BANDS = ['B2', 'B3', 'B4', 'B5', 'B8', 'B11', 'B12'];
/** Cloud Score+ threshold: keep pixels at least this clear (0 = cloud, 1 = clear). */
const CLEAR_THRESHOLD = 0.6;

/** Seasons as month ranges; winter wraps the year end (calendarRange supports start > end). */
const SEASONS: Array<[name: string, startMonth: number, endMonth: number]> = [
    ['win', 12, 2],
    ['spr', 3, 5],
    ['sum', 6, 8],
    ['aut', 9, 11],
];

function sentinel2(ee: EE, region: EE, start: string, end: string): EE {
    const cloudScore = ee.ImageCollection('GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED');
    return ee
        .ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
        .filterBounds(region)
        .filterDate(start, end)
        .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 70))
        .linkCollection(cloudScore, ['cs_cdf'])
        .map((image: EE) => {
            const scaled = image.select(S2_BANDS).divide(10_000);
            const ndvi = scaled.normalizedDifference(['B8', 'B4']).rename('NDVI');
            const ndre = scaled.normalizedDifference(['B8', 'B5']).rename('NDRE');
            const ndmi = scaled.normalizedDifference(['B8', 'B11']).rename('NDMI');
            return scaled
                .addBands([ndvi, ndre, ndmi])
                .updateMask(image.select('cs_cdf').gte(CLEAR_THRESHOLD))
                .copyProperties(image, ['system:time_start']);
        });
}

function sentinel1(ee: EE, region: EE, start: string, end: string): EE {
    return ee
        .ImageCollection('COPERNICUS/S1_GRD')
        .filterBounds(region)
        .filterDate(start, end)
        .filter(ee.Filter.eq('instrumentMode', 'IW'))
        .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH'))
        .select(['VV', 'VH']);
}

/**
 * Per-pixel features (10 m):
 *  - seasonal S2 medians (bands + NDVI/NDRE/NDMI), gap-filled with the all-period median;
 *  - NDVI p10/p50/p90 and amplitude: tea is evergreen with harvest dips, hazelnut and
 *    broadleaf forest drop leaves in winter — the strongest single separator;
 *  - winter/summer S1 VV, VH and VH−VV (canopy structure, cloud-independent);
 *  - elevation and slope (tea sits below ~1000 m on managed slopes).
 */
export function buildTeaFeatures(ee: EE, region: EE, start: string, end: string): EE {
    const s2 = sentinel2(ee, region, start, end);
    const allPeriod = s2.median();
    const seasonal = SEASONS.map(([name, from, to]) =>
        s2
            .filter(ee.Filter.calendarRange(from, to, 'month'))
            .median()
            .unmask(allPeriod)
            .regexpRename('^(.*)$', `$1_${name}`),
    );
    const ndviStats = s2
        .select('NDVI')
        .reduce(ee.Reducer.percentile([10, 50, 90]))
        .rename(['NDVI_p10', 'NDVI_p50', 'NDVI_p90']);
    const ndviAmplitude = ndviStats.select('NDVI_p90').subtract(ndviStats.select('NDVI_p10')).rename('NDVI_amp');

    const s1 = sentinel1(ee, region, start, end);
    const radar = [
        ['win', 12, 2],
        ['sum', 6, 8],
    ].map(([name, from, to]) => {
        const median = s1.filter(ee.Filter.calendarRange(from, to, 'month')).median();
        return median
            .addBands(median.select('VH').subtract(median.select('VV')).rename('VHminusVV'))
            .regexpRename('^(.*)$', `$1_${name}`);
    });

    const dem = ee
        .ImageCollection('COPERNICUS/DEM/GLO30')
        .filterBounds(region)
        .select('DEM')
        .mosaic()
        .setDefaultProjection('EPSG:4326', null, 30);
    const terrain = dem.rename('elevation').addBands(ee.Terrain.slope(dem).rename('slope'));

    return ee.Image.cat([...seasonal, ndviStats, ndviAmplitude, ...radar, terrain]).toFloat();
}
