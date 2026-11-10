/**
 * Sentinel-1 backscatter series per unit, one series per orbit direction, as analysis-ready data.
 *
 * Borrowed from grassland mowing detection (Sen4CAP mowing marker, Copernicus HR-VPP): a cut
 * removes the leafy canopy, so cross-polarised backscatter (VH) and the VH/VV ratio drop and
 * stay down. Tea pruning removes the canopy the same way — and unlike grass it does not grow
 * back within weeks, so the drop must persist. Ascending and descending passes see the slopes
 * from different sides and are never mixed: each gets its own series.
 *
 * ARD steps (after Vollrath et al. 2020 / Mullissa et al. 2021, the GEE S1 ARD framework):
 *   σ0 (S1_GRD_FLOAT, linear) → γ0 = σ0 / cos θi → radiometric terrain flattening with the
 *   volume-scattering model on the Copernicus GLO-30 DEM → layover / shadow mask → dB.
 * On the steep Black Sea slopes the uncorrected γ0 of a garden changes with the look geometry
 * alone; flattening removes most of that, and the per-date neighbourhood median removes the rest
 * (moisture, rain, snow). Speckle is averaged over the unit's pixels instead of a temporal filter,
 * which would smear the very step we look for.
 */
import type { MultiPolygon, Polygon } from 'geojson';
import { evaluate, reduceDatesInChunks } from '../ee/session.ts';

/* `ee` objects are untyped (see src/types/earthengine.d.ts). */
type EE = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export type OrbitPass = 'ASCENDING' | 'DESCENDING';

export interface PassSeries {
    pass: OrbitPass;
    relativeOrbit: number;
    dates: string[];
    /** Per unit id: terrain-flattened γ0 VV and VH in dB per date (null where the unit had no valid pixels). */
    gardens: Record<string, { vv: Array<number | null>; vh: Array<number | null> }>;
    /** Processing applied, for the record. */
    processing: 'gamma0_flat_volume_model';
}

const SCALE_M = 10;
/**
 * Platform heading (degrees from north) of the Sentinel-1 ground track at ~41° N: ascending ≈ 349°,
 * descending ≈ 191° (sun-synchronous orbit, inclination 98.18°). A few degrees of error move the
 * range-slope term by < 1 %, far below the per-date neighbourhood normalisation.
 */
const HEADING_DEG: Record<OrbitPass, number> = { ASCENDING: 349, DESCENDING: 191 };

/** Dominant relative orbit of a pass over the region in the window (the one with most scenes). */
async function dominantOrbit(ee: EE, collection: EE): Promise<number | null> {
    const hist = await evaluate<Record<string, number>>(collection.aggregate_histogram('relativeOrbitNumber_start'));
    const best = Object.entries(hist).sort((a, b) => b[1] - a[1])[0];
    return best ? Number(best[0]) : null;
}

/** Terrain-flattened γ0 (dB) with layover/shadow masked, from a linear σ0 GRD image with its 'angle' band. */
function flattenedGamma0Db(ee: EE, image: EE, dem: EE, pass: OrbitPass): EE {
    const toRad = Math.PI / 180;
    const theta = image.select('angle').multiply(toRad);
    const ninety = ee.Image.constant(Math.PI / 2);
    const slope = ee.Terrain.slope(dem).multiply(toRad);
    const aspect = ee.Terrain.aspect(dem).multiply(toRad);
    const heading = ee.Image.constant(HEADING_DEG[pass] * toRad);
    // Slope components in the range and azimuth directions of the sensor.
    const phiR = heading.subtract(aspect);
    const alphaR = slope.tan().multiply(phiR.cos()).atan();
    // Volume-scattering model: the ratio of the flat-terrain to the local projected area.
    const volModel = ninety.subtract(theta).add(alphaR).tan().divide(ninety.subtract(theta).tan()).abs();
    const gamma0 = image.select(['VV', 'VH']).divide(theta.cos());
    const flat = gamma0.divide(volModel);
    const noLayover = alphaR.lt(theta);
    const noShadow = alphaR.gt(ninety.subtract(theta).multiply(-1));
    return flat.updateMask(noLayover.and(noShadow)).max(1e-6).log10().multiply(10).rename(['VV', 'VH']);
}

export async function backscatterSeries(
    ee: EE,
    region: EE,
    gardens: Array<{ id: string; geometry: Polygon | MultiPolygon }>,
    window: [string, string],
    pass: OrbitPass,
): Promise<PassSeries | null> {
    const base = ee
        .ImageCollection('COPERNICUS/S1_GRD_FLOAT')
        .filterBounds(region)
        .filterDate(window[0], window[1])
        .filter(ee.Filter.eq('instrumentMode', 'IW'))
        .filter(ee.Filter.eq('orbitProperties_pass', pass))
        .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH'))
        .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV'));
    const orbit = await dominantOrbit(ee, base);
    if (orbit === null) return null;
    const demCollection = ee.ImageCollection('COPERNICUS/DEM/GLO30').select('DEM');
    const dem = demCollection.mosaic().setDefaultProjection(demCollection.first().projection());
    // One image per acquisition date (frames of the same pass are mosaicked), sorted in time.
    const perDate = base
        .filter(ee.Filter.eq('relativeOrbitNumber_start', orbit))
        .map((img: EE) => flattenedGamma0Db(ee, img, dem, pass).copyProperties(img, ['system:time_start']).set('date', img.date().format('YYYY-MM-dd')));
    // Acquisition dates come from the raw collection's timestamps (cheap metadata), never from the mapped images.
    const stamps = (await evaluate<number[]>(base.filter(ee.Filter.eq('relativeOrbitNumber_start', orbit)).aggregate_array('system:time_start'))) as number[];
    const dates = [...new Set(stamps.map((t) => new Date(t).toISOString().slice(0, 10)))].sort();
    if (dates.length === 0) return null;
    const fc = ee.FeatureCollection(gardens.map((g) => ee.Feature(ee.Geometry(g.geometry), { id: g.id })));
    // One VV/VH pair per date, reduced in chunks (a season of two polarisations exceeds one request).
    const props = await reduceDatesInChunks(ee, dates, (d: EE) => perDate.filter(ee.Filter.eq('date', d)).mosaic().rename([ee.String('VV_').cat(d), ee.String('VH_').cat(d)]), fc, SCALE_M, 12);
    const out: PassSeries['gardens'] = {};
    for (const g of gardens) {
        const row = props.get(g.id) ?? {};
        const pick = (pol: 'VV' | 'VH') =>
            dates.map((d) => {
                const v = row[`${pol}_${d}`];
                return typeof v === 'number' ? Math.round(v * 100) / 100 : null;
            });
        out[g.id] = { vv: pick('VV'), vh: pick('VH') };
    }
    return { pass, relativeOrbit: orbit, dates, gardens: out, processing: 'gamma0_flat_volume_model' };
}
