/*
 * Pruning detection from free Sentinel imagery: compare cloud- and snow-free composites of
 * three windows inside ONE pruning season (same winter), on tea pixels only.
 * `ee` is the untyped Earth Engine client (see src/types).
 */
type EE = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Season `Y` = pruning that starts in November of year Y.
 *  - reference: after the last (autumn) harvest, before pruning — full canopy
 *  - winter:    after the main November–December pruning
 *  - spring:    after the late (March) pruning, before the first flush greens the bushes again
 */
export interface PruningWindows {
    season: string;
    reference: [string, string];
    winter: [string, string];
    spring: [string, string];
}

export function pruningWindows(year: number): PruningWindows {
    const next = year + 1;
    return {
        season: `${year}-${String(next).slice(2)}`,
        reference: [`${year}-10-05`, `${year}-11-10`],
        winter: [`${year}-12-10`, `${next}-02-01`],
        spring: [`${next}-03-25`, `${next}-04-26`],
    };
}

/** Cloud Score+ threshold (0 = cloud, 1 = clear). */
const CLEAR_THRESHOLD = 0.6;
/** NDSI above this = snow. Snow drops NDVI like pruning does, so it must never reach the comparison. */
const SNOW_NDSI = 0.4;

/** Median NDVI / NIR / SWIR of clear, snow-free Sentinel-2 pixels in a window, plus the clear-observation count. */
function opticalComposite(ee: EE, region: EE, [start, end]: [string, string]): EE {
    const cloudScore = ee.ImageCollection('GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED');
    const clear = ee
        .ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
        .filterBounds(region)
        .filterDate(start, end)
        .linkCollection(cloudScore, ['cs_cdf'])
        .map((image: EE) => {
            const scaled = image.select(['B3', 'B4', 'B8', 'B11']).divide(10_000);
            const ndsi = scaled.normalizedDifference(['B3', 'B11']);
            const notSnow = ndsi.lt(SNOW_NDSI).and(image.select('SCL').neq(11));
            return scaled
                .normalizedDifference(['B8', 'B4'])
                .rename('NDVI')
                .addBands(scaled.select(['B8', 'B11'], ['NIR', 'SWIR']))
                .updateMask(image.select('cs_cdf').gte(CLEAR_THRESHOLD).and(notSnow));
        });
    return clear.median().addBands(clear.select('NDVI').count().rename('obs'));
}

/** Median Sentinel-1 VH (dB) of one orbit direction, so geometry stays comparable between windows. */
function radarComposite(ee: EE, region: EE, [start, end]: [string, string]): EE {
    return ee
        .ImageCollection('COPERNICUS/S1_GRD')
        .filterBounds(region)
        .filterDate(start, end)
        .filter(ee.Filter.eq('instrumentMode', 'IW'))
        .filter(ee.Filter.eq('orbitProperties_pass', 'DESCENDING'))
        .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH'))
        .select('VH')
        .median()
        .rename('VH');
}

export interface PruningImages {
    /** Per pixel: pruned share of the pixel (0–1) in the winter step, the spring step, and their sum. */
    pruned: EE;
    /** 1 where the pixel was clear in the windows its step compares (an observed tea pixel). */
    observed: EE;
    /** Season-wide numbers for the report: thresholds, medians, observation counts. */
    stats: EE;
}

/**
 * Relative NDVI drop between two windows on tea pixels:
 *   rel = (NDVI_after − NDVI_before) − median over all tea pixels of the same difference.
 * Subtracting the median removes the drop every bush shows in winter, leaving what is specific
 * to a pixel. A pixel counts as pruned when rel falls below a threshold set from the data
 * itself (2.5 robust sigmas, never less than 0.10). Its pruned share is the size of its drop
 * relative to a fully pruned pixel (the 95th percentile drop), so a pixel that is a quarter
 * pruned counts as 25 m² — the sub-pixel estimate the 1/7 rule needs on small parcels.
 */
function relativeDrop(ee: EE, before: EE, after: EE, teaMask: EE, region: EE, fixedThreshold?: number) {
    const valid = before.select('obs').gt(0).and(after.select('obs').gt(0)).and(teaMask);
    const delta = after.select('NDVI').subtract(before.select('NDVI')).updateMask(valid).rename('d');
    const dist = delta.reduceRegion({
        reducer: ee.Reducer.median().combine(ee.Reducer.percentile([5, 25, 75]), null, true),
        geometry: region,
        scale: 10,
        maxPixels: 1e9,
        tileScale: 4,
    });
    const median = ee.Number(dist.get('d_median'));
    const sigma = ee.Number(dist.get('d_p75')).subtract(ee.Number(dist.get('d_p25'))).divide(1.349);
    const threshold = fixedThreshold === undefined ? sigma.multiply(2.5).max(0.1) : ee.Number(fixedThreshold);
    const fullDrop = median.subtract(ee.Number(dist.get('d_p5'))).max(threshold.multiply(1.5));
    const rel = delta.subtract(median);
    const share = rel.multiply(-1).divide(fullDrop).clamp(0, 1).updateMask(rel.lt(threshold.multiply(-1)));
    return { rel, share: share.unmask(0).updateMask(valid), valid, median, threshold, fullDrop };
}

/** `fixedThreshold` overrides the data-driven threshold (sensitivity runs). */
export function buildPruningImages(ee: EE, region: EE, teaMask: EE, windows: PruningWindows, fixedThreshold?: number): PruningImages {
    const reference = opticalComposite(ee, region, windows.reference);
    const winter = opticalComposite(ee, region, windows.winter);
    const spring = opticalComposite(ee, region, windows.spring);

    const winterStep = relativeDrop(ee, reference, winter, teaMask, region, fixedThreshold);
    const springStep = relativeDrop(ee, winter, spring, teaMask, region, fixedThreshold);
    // Fallback when the cloudy winter window saw nothing: compare reference with spring directly.
    const seasonStep = relativeDrop(ee, reference, spring, teaMask, region, fixedThreshold);
    // A pixel pruned in winter cannot be pruned again in March: the spring step only adds what is left.
    const springShare = springStep.share.multiply(ee.Image(1).subtract(winterStep.share.unmask(0)));
    const bothSteps = winterStep.valid.and(springStep.valid);
    const total = winterStep.share.unmask(0).add(springShare.unmask(0)).clamp(0, 1)
        .where(bothSteps.unmask(0).not(), seasonStep.share.unmask(0))
        .updateMask(bothSteps.unmask(0).or(seasonStep.valid.unmask(0)));

    const vhDrop = radarComposite(ee, region, windows.winter).subtract(radarComposite(ee, region, windows.reference)).rename('vh_change_db');

    const pruned = winterStep.share.rename('winter')
        .addBands(springShare.rename('spring'))
        .addBands(total.rename('season'))
        .addBands(vhDrop.updateMask(teaMask))
        .updateMask(teaMask);
    const observed = winterStep.valid.unmask(0).rename('obs_winter')
        .addBands(springStep.valid.unmask(0).rename('obs_spring'))
        .addBands(bothSteps.unmask(0).or(seasonStep.valid.unmask(0)).rename('obs_season'));

    const counts = (img: EE) =>
        img.select('obs').updateMask(teaMask).reduceRegion({ reducer: ee.Reducer.median(), geometry: region, scale: 10, maxPixels: 1e9 }).get('obs');
    const stats = ee.Dictionary({
        winterMedianDelta: winterStep.median,
        winterThreshold: winterStep.threshold,
        winterFullDrop: winterStep.fullDrop,
        springMedianDelta: springStep.median,
        springThreshold: springStep.threshold,
        springFullDrop: springStep.fullDrop,
        referenceClearObs: counts(reference),
        winterClearObs: counts(winter),
        springClearObs: counts(spring),
    });
    return { pruned, observed, stats };
}
