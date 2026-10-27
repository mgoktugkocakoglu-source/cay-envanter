import type { MultiPolygon, Polygon } from 'geojson';
import { evaluate } from '../ee/session.ts';

/* `ee` objects are untyped (see src/types/earthengine.d.ts). */
type EE = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Poly = Polygon | MultiPolygon;

export interface ParcelInput {
    key: string;
    geometry: Poly;
}

/** Terrain and hydrology statistics of one parcel (radar-derived DEM, MERIT Hydro, JRC surface water). */
export interface TerrainRaw {
    elevationM: number | null;
    slopePct: number | null;
    slopeMaxPct: number | null;
    /** Mean aspect in degrees from north (0–360), from the circular mean of the pixels. */
    aspectDeg: number | null;
    /** Topographic position: elevation minus the 300 m focal mean (negative = valley, positive = ridge). */
    tpiM: number | null;
    /** Height above the nearest drainage line (m), MERIT Hydro. */
    handM: number | null;
    /** Largest upstream catchment (km²) inside the parcel: a stream runs through it when large. */
    upstreamKm2: number | null;
    /** Distance to the nearest stream with ≥ 5 km² catchment (m). */
    streamDistM: number | null;
    /** JRC surface-water occurrence (0–100 %) maximum inside the parcel. */
    waterOccurrence: number | null;
}

/** Topsoil (0–30 cm) properties from OpenLandMap 250 m (SoilGrids in Mollweide returned no values per parcel). */
export interface SoilRaw {
    clayPct: number | null;
    sandPct: number | null;
    siltPct: number | null;
    ph: number | null;
    /** Organic carbon, % of fine earth. */
    socPct: number | null;
    /** Cation exchange capacity, cmol(c)/kg (not available from OpenLandMap; reserved for a field survey). */
    cec: number | null;
    /** Bulk density, g/cm³. */
    bulkDensity: number | null;
    /** OpenLandMap USDA texture class code (1 clay … 12 sand), topsoil. */
    textureCode: number | null;
}

export const DW_CLASSES = ['water', 'trees', 'grass', 'flooded_vegetation', 'crops', 'shrub_and_scrub', 'built', 'bare', 'snow_and_ice'] as const;
export type DwClass = (typeof DW_CLASSES)[number];
export type ClassFractions = Partial<Record<DwClass, number>>;

/** ESA WorldCover 2021 codes → readable keys. */
export const WORLDCOVER: Record<number, string> = { 10: 'trees', 20: 'shrub', 30: 'grass', 40: 'crops', 50: 'built', 60: 'bare', 70: 'snow', 80: 'water', 90: 'wetland', 95: 'mangrove', 100: 'moss' };

export interface LandUseRaw {
    years: number[];
    /** parcel key → year → Dynamic World class fractions (growing-season mode label). */
    parcels: Record<string, Record<number, ClassFractions>>;
    /** Whole neighbourhood boundary → year → fractions. */
    boundary: Record<number, ClassFractions>;
    /** parcel key → WorldCover 2021 class fractions. */
    worldcover: Record<string, Record<string, number>>;
    boundaryWorldcover: Record<string, number>;
}

const DEM_SCALE_M = 30;
const SOIL_SCALE_M = 100;
const STREAM_MIN_KM2 = 5;

function collection(ee: EE, parcels: ParcelInput[]): EE {
    return ee.FeatureCollection(parcels.map((p) => ee.Feature(ee.Geometry(p.geometry), { key: p.key })));
}

function num(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Terrain, hydrology and soil per parcel in two reduceRegions jobs. */
export async function terrainAndSoil(ee: EE, parcels: ParcelInput[]): Promise<{ terrain: Record<string, TerrainRaw>; soil: Record<string, SoilRaw> }> {
    if (parcels.length === 0) return { terrain: {}, soil: {} };
    const fc = collection(ee, parcels);

    // The mosaic must keep the native 30 m projection, otherwise slope is computed on a degraded grid.
    const demCollection = ee.ImageCollection('COPERNICUS/DEM/GLO30').select('DEM');
    const dem = demCollection.mosaic().setDefaultProjection(demCollection.first().projection());
    const products = ee.Terrain.products(dem);
    const slopePct = products.select('slope').multiply(Math.PI / 180).tan().multiply(100).rename('slopePct');
    const aspectRad = products.select('aspect').multiply(Math.PI / 180);
    const tpi = dem.subtract(dem.focalMean(300, 'circle', 'meters')).rename('tpi');
    const merit = ee.Image('MERIT/Hydro/v1_0_1');
    const streams = merit.select('upa').gte(STREAM_MIN_KM2);
    // Distance in MERIT pixels (≈ 92 m at this latitude) to the nearest stream cell.
    const streamDist = streams.fastDistanceTransform(256).sqrt().multiply(92).rename('streamDist');
    const water = ee.Image('JRC/GSW1_4/GlobalSurfaceWater').select('occurrence').unmask(0).rename('waterOcc');
    const stack = ee.Image.cat([
        dem.rename('elev'),
        slopePct,
        aspectRad.cos().rename('aspCos'),
        aspectRad.sin().rename('aspSin'),
        tpi,
        merit.select('hnd').rename('hand'),
        merit.select('upa').rename('upa'),
        streamDist,
        water,
    ]);
    const reducer = ee.Reducer.mean().combine({ reducer2: ee.Reducer.max(), sharedInputs: true }).combine({ reducer2: ee.Reducer.min(), sharedInputs: true });
    const terrainFc = stack.reduceRegions({ collection: fc, reducer, scale: DEM_SCALE_M, tileScale: 4 });

    // OpenLandMap 250 m (EPSG:4326): topsoil = mean of the 0, 10 and 30 cm layers (b0, b10, b30).
    const topsoil = (asset: string, name: string) => {
        const img = ee.Image(asset);
        return img.select('b0').add(img.select('b10')).add(img.select('b30')).divide(3).rename(name);
    };
    const clay = topsoil('OpenLandMap/SOL/SOL_CLAY-WFRACTION_USDA-3A1A1A_M/v02', 'clay');
    const sand = topsoil('OpenLandMap/SOL/SOL_SAND-WFRACTION_USDA-3A1A1A_M/v02', 'sand');
    const soilStack = ee.Image.cat([
        clay,
        sand,
        ee.Image(100).subtract(clay).subtract(sand).rename('silt'),
        topsoil('OpenLandMap/SOL/SOL_PH-H2O_USDA-4C1A2A_M/v02', 'phh2o').divide(10),
        // Organic carbon is stored in 5 g/kg units → % of fine earth.
        topsoil('OpenLandMap/SOL/SOL_ORGANIC-CARBON_USDA-6A1C_M/v02', 'soc').multiply(5).divide(10),
        // Bulk density is stored in 10 kg/m³ units → g/cm³.
        topsoil('OpenLandMap/SOL/SOL_BULKDENS-FINEEARTH_USDA-4A1H_M/v02', 'bdod').divide(100),
        ee.Image('OpenLandMap/SOL/SOL_TEXTURE-CLASS_USDA-TT_M/v02').select('b0').rename('texture'),
    ]);
    const soilFc = soilStack.reduceRegions({ collection: fc, reducer: ee.Reducer.mean(), scale: SOIL_SCALE_M, tileScale: 4 });

    const [t, s] = await Promise.all([
        evaluate<{ features: Array<{ properties: Record<string, unknown> }> }>(terrainFc),
        evaluate<{ features: Array<{ properties: Record<string, unknown> }> }>(soilFc),
    ]);
    const terrain: Record<string, TerrainRaw> = {};
    for (const f of t.features) {
        const p = f.properties;
        const cos = num(p.aspCos_mean);
        const sin = num(p.aspSin_mean);
        const aspect = cos === null || sin === null ? null : ((Math.atan2(sin, cos) * 180) / Math.PI + 360) % 360;
        terrain[String(p.key)] = {
            elevationM: num(p.elev_mean),
            slopePct: num(p.slopePct_mean),
            slopeMaxPct: num(p.slopePct_max),
            aspectDeg: aspect === null ? null : Math.round(aspect),
            tpiM: num(p.tpi_mean),
            handM: num(p.hand_mean),
            upstreamKm2: num(p.upa_max),
            streamDistM: num(p.streamDist_min),
            waterOccurrence: num(p.waterOcc_max),
        };
    }
    const soil: Record<string, SoilRaw> = {};
    for (const f of s.features) {
        const p = f.properties;
        soil[String(p.key)] = {
            clayPct: num(p.clay),
            sandPct: num(p.sand),
            siltPct: num(p.silt),
            ph: num(p.phh2o),
            socPct: num(p.soc),
            cec: null,
            bulkDensity: num(p.bdod),
            textureCode: num(p.texture) === null ? null : Math.round(num(p.texture) as number),
        };
    }
    return { terrain, soil };
}

function fractionsOf(hist: Record<string, number> | undefined, labels: readonly string[] | Record<number, string>): Record<string, number> {
    const out: Record<string, number> = {};
    if (!hist) return out;
    const total = Object.values(hist).reduce((a, b) => a + b, 0);
    if (total === 0) return out;
    for (const [k, v] of Object.entries(hist)) {
        const name = Array.isArray(labels) ? labels[Number(k)] : (labels as Record<number, string>)[Number(k)];
        if (name) out[name] = Math.round((v / total) * 1000) / 1000;
    }
    return out;
}

/**
 * Land use per parcel and for the whole boundary: Dynamic World growing-season mode label for every
 * year since `fromYear` (10 m, Sentinel-2) and ESA WorldCover 2021.
 */
export async function landUseHistory(ee: EE, boundary: Poly, parcels: ParcelInput[], fromYear: number, toYear: number): Promise<LandUseRaw> {
    const region = ee.Geometry(boundary);
    const fc = collection(ee, parcels);
    const out: LandUseRaw = { years: [], parcels: {}, boundary: {}, worldcover: {}, boundaryWorldcover: {} };
    for (const p of parcels) out.parcels[p.key] = {};
    const dw = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1').select('label');
    for (let year = fromYear; year <= toYear; year++) {
        const season = dw.filterDate(`${year}-05-01`, `${year}-10-01`).filterBounds(region);
        const count: number = await evaluate(season.size());
        if (count === 0) continue;
        const label = season.reduce(ee.Reducer.mode()).rename('label');
        const [parcelHist, boundaryHist] = await Promise.all([
            parcels.length === 0
                ? Promise.resolve({ features: [] as Array<{ properties: Record<string, unknown> }> })
                : evaluate<{ features: Array<{ properties: Record<string, unknown> }> }>(label.reduceRegions({ collection: fc, reducer: ee.Reducer.frequencyHistogram(), scale: 10, tileScale: 4 })),
            evaluate<Record<string, Record<string, number>>>(label.reduceRegion({ reducer: ee.Reducer.frequencyHistogram(), geometry: region, scale: 10, maxPixels: 1e9, tileScale: 4 })),
        ]);
        out.years.push(year);
        for (const f of parcelHist.features) {
            out.parcels[String(f.properties.key)]![year] = fractionsOf(f.properties.histogram as Record<string, number>, DW_CLASSES) as ClassFractions;
        }
        out.boundary[year] = fractionsOf(boundaryHist.label, DW_CLASSES) as ClassFractions;
    }
    const wc = ee.ImageCollection('ESA/WorldCover/v200').first().select('Map');
    const [wcParcels, wcBoundary] = await Promise.all([
        parcels.length === 0
            ? Promise.resolve({ features: [] as Array<{ properties: Record<string, unknown> }> })
            : evaluate<{ features: Array<{ properties: Record<string, unknown> }> }>(wc.reduceRegions({ collection: fc, reducer: ee.Reducer.frequencyHistogram(), scale: 10, tileScale: 4 })),
        evaluate<Record<string, Record<string, number>>>(wc.reduceRegion({ reducer: ee.Reducer.frequencyHistogram(), geometry: region, scale: 10, maxPixels: 1e9, tileScale: 4 })),
    ]);
    for (const f of wcParcels.features) out.worldcover[String(f.properties.key)] = fractionsOf(f.properties.histogram as Record<string, number>, WORLDCOVER);
    out.boundaryWorldcover = fractionsOf(wcBoundary.Map, WORLDCOVER);
    return out;
}
