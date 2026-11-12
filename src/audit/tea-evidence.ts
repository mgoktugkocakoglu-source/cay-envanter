import { createHash } from 'node:crypto';
import { buffer } from '@turf/turf';
import type { MultiPolygon, Polygon } from 'geojson';
import { evaluate } from '../ee/session.ts';
import type { Parcel } from '../tkgm/types.ts';

/* `ee` objects are untyped (see src/types/earthengine.d.ts). */
type EE = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Poly = Polygon | MultiPolygon;

/**
 * Title-independent tea evidence for the licence audit.
 *
 * The inventory detector (detect-tea) cannot be the witness of an audit of the deed title: it learns from the title
 * ("Çayır" = not tea) and it uses elevation and slope, so it repeats where titled tea already is. Here:
 *   - no location feature (elevation, slope) enters the classifier;
 *   - snow is masked before any statistic (above ~800 m winter snow makes evergreen tea look leafless);
 *   - the titles under audit (çayır, tarla, mera, mixed titles) are never trained on: positives are "Çay Bahçesi",
 *     negatives are forest and hazelnut titles plus pixels a global land-cover map calls grass / crop / built / bare / water.
 * The labels are still weak (titles); the held-out numbers measure agreement with titles of the clean classes, not field truth.
 */
export const EVIDENCE_RULES = {
    start: '2024-01-01',
    end: '2026-07-01',
    scaleM: 10,
    clearThreshold: 0.6,
    /** Normalised difference snow index above this = snow, masked. */
    snowNdsi: 0.2,
    /** Leaf-off window (month-day): hazelnut, alder and broadleaf forest are bare, tea is green. */
    leafOff: [11, 3] as [number, number],
    teaThreshold: 0.5,
    maxPixelsPerClass: 900,
    landCoverNegatives: 900,
    testShare: 0.25,
    innerBufferM: 3,
    trees: 200,
};

const S2_BANDS = ['B2', 'B3', 'B4', 'B5', 'B8', 'B11', 'B12'];
const POSITIVE = /^çay bahçesi\.?$/;
const NEGATIVE = /^(orman|fındık bahçesi|fındıklık)\.?$/;

export type EvidenceLabel = 0 | 1;
export function evidenceLabel(nature: string): EvidenceLabel | null {
    const t = nature.trim().toLocaleLowerCase('tr');
    return POSITIVE.test(t) ? 1 : NEGATIVE.test(t) ? 0 : null;
}

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
            const snow = scaled.normalizedDifference(['B3', 'B11']).gt(EVIDENCE_RULES.snowNdsi);
            return scaled
                .addBands([ndvi, ndre, ndmi])
                .updateMask(image.select('cs_cdf').gte(EVIDENCE_RULES.clearThreshold))
                .updateMask(snow.not())
                .copyProperties(image, ['system:time_start']);
        });
}

/** Feature stack: summer / autumn / leaf-off composites, snow-free NDVI percentiles, summer and autumn radar. No terrain. */
export function buildEvidenceFeatures(ee: EE, region: EE): { features: EE; extras: EE } {
    const R = EVIDENCE_RULES;
    const s2 = sentinel2(ee, region, R.start, R.end);
    const all = s2.median();
    const season = (name: string, from: number, to: number) => s2.filter(ee.Filter.calendarRange(from, to, 'month')).median().unmask(all).regexpRename('^(.*)$', `$1_${name}`);
    const leafOffCollection = s2.filter(ee.Filter.calendarRange(R.leafOff[0], R.leafOff[1], 'month'));
    const ndviStats = s2.select('NDVI').reduce(ee.Reducer.percentile([10, 50, 90])).rename(['NDVI_p10', 'NDVI_p50', 'NDVI_p90']);
    const amplitude = ndviStats.select('NDVI_p90').subtract(ndviStats.select('NDVI_p10')).rename('NDVI_amp');
    // Evergreen ratio: leaf-off greenness relative to summer greenness (tea ≈ 0.85–1, deciduous well below).
    const evergreen = leafOffCollection.select('NDVI').median().unmask(all.select('NDVI')).divide(s2.filter(ee.Filter.calendarRange(6, 8, 'month')).select('NDVI').median().unmask(all.select('NDVI'))).rename('evergreen');
    const s1 = ee.ImageCollection('COPERNICUS/S1_GRD').filterBounds(region).filterDate(R.start, R.end).filter(ee.Filter.eq('instrumentMode', 'IW')).filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH')).select(['VV', 'VH']);
    const radar = ([['sum', 6, 8], ['aut', 9, 11]] as Array<[string, number, number]>).map(([name, from, to]) => {
        const median = s1.filter(ee.Filter.calendarRange(from, to, 'month')).median();
        return median.addBands(median.select('VH').subtract(median.select('VV')).rename('VHminusVV')).regexpRename('^(.*)$', `$1_${name}`);
    });
    const features = ee.Image.cat([season('sum', 6, 8), season('aut', 9, 10), season('off', R.leafOff[0], R.leafOff[1]), ndviStats, amplitude, evergreen, ...radar]).toFloat();
    // Not classifier inputs: reported as evidence and used to band the evaluation.
    const dem = ee.ImageCollection('COPERNICUS/DEM/GLO30').filterBounds(region).select('DEM').mosaic().setDefaultProjection('EPSG:4326', null, 30);
    const extras = ee.Image.cat([dem.rename('elevation'), leafOffCollection.select('NDVI').count().unmask(0).rename('leafOffObs'), s2.select('NDVI').count().unmask(0).rename('clearObs')]).toFloat();
    return { features, extras };
}

export interface EvidenceBand { band: string; pixels: { nonTea: number; tea: number }; accuracy: number | null; teaRecall: number | null; teaPrecision: number | null }
export interface EvidenceModel {
    type: string;
    period: { start: string; end: string };
    features: number;
    threshold: number;
    trainingParcels: { tea: number; nonTea: number; neighborhoods: string[] };
    trainPixels: Record<string, number>;
    testPixels: Record<string, number>;
    heldOut: { accuracy: number; kappa: number; teaRecall: number; teaPrecision: number; confusion: number[][] };
    /** Held-out agreement by elevation band; an empty band means the model was never checked there. */
    byElevation: EvidenceBand[];
    /** Share of each held-out group called tea at probability thresholds 0.5 / 0.6 / 0.7 (false-alarm rate for the non-tea groups). */
    byGroup: Array<{ group: string; pixels: number; calledTea: Record<string, number | null> }>;
    maxTrainingTeaElevationM: number | null;
    topFeatures: Array<{ band: string; importance: number }>;
}
export interface ParcelTeaEvidence {
    key: string;
    teaProbability: number | null;
    teaShare: number | null;
    teaAreaM2: number | null;
    /** Mean values over the parcel, shown to the expert beside the verdict. */
    ndviSummer: number | null;
    ndviLeafOff: number | null;
    evergreen: number | null;
    vhSummer: number | null;
    elevationM: number | null;
    leafOffObs: number | null;
    /** The parcel lies above every tea parcel the model was trained on. */
    beyondTraining: boolean;
}

const splitOf = (key: string) => (createHash('sha1').update(key).digest().readUInt16BE(0) / 0xffff < EVIDENCE_RULES.testShare ? 'test' : 'train');
const ELEVATION_BANDS: Array<[string, number, number]> = [['0–300 m', 0, 300], ['300–500 m', 300, 500], ['500–700 m', 500, 700], ['700–900 m', 700, 900], ['900 m +', 900, 9999]];

export async function detectTeaEvidence(ee: EE, input: { pool: Array<{ neighborhood: string; parcels: Parcel[] }>; targetBoundary: Poly; targets: Parcel[] }): Promise<{ model: EvidenceModel; parcels: ParcelTeaEvidence[] }> {
    const R = EVIDENCE_RULES;
    const poolParcels = input.pool.flatMap((p) => p.parcels);
    const training = poolParcels
        .map((p) => ({ p, label: evidenceLabel(p.properties.nature) }))
        .filter((x): x is { p: Parcel; label: EvidenceLabel } => x.label !== null)
        .map(({ p, label }) => ({ p, label, geometry: (buffer(p, -R.innerBufferM, { units: 'meters' })?.geometry ?? null) as Poly | null }))
        .filter((x) => x.geometry !== null);
    const region = ee.FeatureCollection([...training.map((t) => ee.Feature(ee.Geometry(t.geometry))), ee.Feature(ee.Geometry(input.targetBoundary))]).geometry(1).bounds(1);
    const { features, extras } = buildEvidenceFeatures(ee, region);
    const bandNames: string[] = await evaluate(features.bandNames());
    const stack = features.addBands(extras.select('elevation'));

    const parcelSamples = stack.sampleRegions({
        collection: ee.FeatureCollection(training.map((t) => ee.Feature(ee.Geometry(t.geometry), { label: t.label, split: splitOf(t.p.properties.key), group: t.label === 1 ? 'tea' : t.p.properties.nature.trim().toLocaleLowerCase('tr').startsWith('orman') ? 'forest' : 'hazelnut' }))),
        properties: ['label', 'split', 'group'],
        scale: R.scaleM,
        tileScale: 8,
    });
    // Negatives the titles cannot give (real meadow, crops, buildings, bare ground, water) from ESA WorldCover, inside the target boundary.
    const worldCover = ee.ImageCollection('ESA/WorldCover/v200').first().select('Map');
    const landCover = stack
        .updateMask(worldCover.remap([30, 40, 50, 60, 80], [1, 1, 1, 1, 1], 0))
        .sample({ region: ee.Geometry(input.targetBoundary), scale: R.scaleM, numPixels: R.landCoverNegatives * 4, seed: 42, tileScale: 8, dropNulls: true })
        .limit(R.landCoverNegatives)
        .randomColumn('r', 7)
        .map((f: EE) => f.set({ label: 0, group: 'landcover', split: ee.Algorithms.If(ee.Number(f.get('r')).lt(R.testShare), 'test', 'train') }));
    const capped = (split: string) =>
        ee.FeatureCollection([
            ...['tea', 'forest', 'hazelnut'].map((g) => parcelSamples.filter(ee.Filter.and(ee.Filter.eq('split', split), ee.Filter.eq('group', g))).randomColumn('rnd', 42).limit(g === 'tea' ? R.maxPixelsPerClass * 2 : R.maxPixelsPerClass, 'rnd')),
            landCover.filter(ee.Filter.eq('split', split)),
        ]).flatten();
    const train = capped('train');
    const test = capped('test');
    const classifier = ee.Classifier.smileRandomForest({ numberOfTrees: R.trees, minLeafPopulation: 2, seed: 42 }).setOutputMode('PROBABILITY').train({ features: train, classProperty: 'label', inputProperties: bandNames });
    // The held-out pixels come back as plain rows, so every table below is counted here, not in Earth Engine.
    const scored = test.classify(classifier, 'tea_p');
    const column = (name: string) => scored.aggregate_array(name);
    const [trainCounts, testCounts, importance, maxTeaElevation, labels, groups, probabilities, elevations] = await Promise.all([
        evaluate<Record<string, number>>(train.aggregate_histogram('group')),
        evaluate<Record<string, number>>(test.aggregate_histogram('group')),
        evaluate<{ importance: Record<string, number> }>(classifier.explain()),
        evaluate<number | null>(train.filter(ee.Filter.eq('label', 1)).aggregate_max('elevation')),
        evaluate<number[]>(column('label')),
        evaluate<string[]>(column('group')),
        evaluate<number[]>(column('tea_p')),
        evaluate<number[]>(column('elevation')),
    ]);
    const held = labels.map((label, i) => ({ label, group: groups[i] as string, p: probabilities[i] as number, elevation: elevations[i] as number }));
    const matrixOf = (rows: typeof held, threshold = R.teaThreshold) => {
        const m = [[0, 0], [0, 0]];
        for (const r of rows) (m[r.label] as number[])[r.p >= threshold ? 1 : 0]!++;
        return m;
    };
    const rates = (m: number[][]) => {
        const tn = m[0]?.[0] ?? 0;
        const fp = m[0]?.[1] ?? 0;
        const fn = m[1]?.[0] ?? 0;
        const tp = m[1]?.[1] ?? 0;
        const n = tn + fp + fn + tp;
        return { nonTea: tn + fp, tea: fn + tp, accuracy: n ? (tn + tp) / n : null, teaRecall: fn + tp ? tp / (fn + tp) : null, teaPrecision: fp + tp ? tp / (fp + tp) : null };
    };
    const confusion = matrixOf(held);
    const overall = rates(confusion);
    const accuracy = overall.accuracy ?? 0;
    // Cohen's kappa from the 2×2 table.
    const total = held.length || 1;
    const expected = (((confusion[0]![0]! + confusion[0]![1]!) * (confusion[0]![0]! + confusion[1]![0]!)) + ((confusion[1]![0]! + confusion[1]![1]!) * (confusion[0]![1]! + confusion[1]![1]!))) / (total * total);
    const kappa = expected < 1 ? (accuracy - expected) / (1 - expected) : 0;
    const bands = ELEVATION_BANDS.map(([, from, to]) => matrixOf(held.filter((r) => r.elevation >= from && r.elevation < to)));
    const r3 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000);
    // Share of each held-out group called tea at three thresholds: for the non-tea groups this is the false-alarm rate.
    const byGroup = [...new Set(held.map((r) => r.group))].sort().map((group) => {
        const rows = held.filter((r) => r.group === group);
        return { group, pixels: rows.length, calledTea: Object.fromEntries([0.5, 0.6, 0.7].map((t) => [String(t), r3(rows.filter((r) => r.p >= t).length / Math.max(1, rows.length))])) as Record<string, number | null> };
    });
    const model: EvidenceModel = {
        type: `RandomForest(${R.trees}), tapu niteliğinden bağımsız: konum özniteliği yok, kar maskeli, denetlenen nitelikler eğitimde yok`,
        period: { start: R.start, end: R.end },
        features: bandNames.length,
        threshold: R.teaThreshold,
        trainingParcels: { tea: training.filter((t) => t.label === 1).length, nonTea: training.filter((t) => t.label === 0).length, neighborhoods: input.pool.filter((p) => p.parcels.some((x) => evidenceLabel(x.properties.nature) !== null)).map((p) => p.neighborhood) },
        trainPixels: trainCounts,
        testPixels: testCounts,
        heldOut: { accuracy: r3(accuracy) ?? 0, kappa: r3(kappa) ?? 0, teaRecall: r3(overall.teaRecall) ?? 0, teaPrecision: r3(overall.teaPrecision) ?? 0, confusion },
        byElevation: ELEVATION_BANDS.map(([band], i) => {
            const x = rates(bands[i] ?? []);
            return { band, pixels: { nonTea: x.nonTea, tea: x.tea }, accuracy: r3(x.accuracy), teaRecall: r3(x.teaRecall), teaPrecision: r3(x.teaPrecision) };
        }),
        byGroup,
        maxTrainingTeaElevationM: maxTeaElevation === null ? null : Math.round(maxTeaElevation),
        topFeatures: Object.entries(importance.importance).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([band, v]) => ({ band, importance: Math.round(v * 10) / 10 })),
    };

    // Per-parcel evidence for the audited parcels.
    const probability = features.classify(classifier).rename('tea_p');
    const evidence = probability
        .addBands(probability.gte(R.teaThreshold).rename('tea'))
        .addBands(features.select(['NDVI_sum', 'NDVI_off', 'evergreen', 'VH_sum']))
        .addBands(extras.select(['elevation', 'leafOffObs']));
    const out: ParcelTeaEvidence[] = [];
    for (let i = 0; i < input.targets.length; i += 250) {
        const chunk = input.targets.slice(i, i + 250);
        const rows = await evaluate<{ features: Array<{ properties: Record<string, number | string | undefined> }> }>(
            evidence.reduceRegions({ collection: ee.FeatureCollection(chunk.map((p) => ee.Feature(ee.Geometry(p.geometry), { key: p.properties.key }))), reducer: ee.Reducer.mean(), scale: R.scaleM, tileScale: 4 }),
        );
        const byKey = new Map(rows.features.map((f) => [f.properties.key as string, f.properties]));
        for (const p of chunk) {
            const s = byKey.get(p.properties.key);
            const num = (k: string) => (typeof s?.[k] === 'number' ? (s[k] as number) : null);
            const share = num('tea');
            const elevation = num('elevation');
            out.push({
                key: p.properties.key,
                teaProbability: r3(num('tea_p')),
                teaShare: r3(share),
                teaAreaM2: share === null ? null : Math.round(share * p.properties.geometryAreaM2),
                ndviSummer: r3(num('NDVI_sum')),
                ndviLeafOff: r3(num('NDVI_off')),
                evergreen: r3(num('evergreen')),
                vhSummer: r3(num('VH_sum')),
                elevationM: elevation === null ? null : Math.round(elevation),
                leafOffObs: r3(num('leafOffObs')),
                beyondTraining: elevation !== null && maxTeaElevation !== null && elevation > maxTeaElevation + 50,
            });
        }
    }
    return { model, parcels: out };
}
