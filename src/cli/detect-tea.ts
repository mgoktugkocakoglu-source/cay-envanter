import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { initEarthEngine, evaluate } from '../ee/session.ts';
import { buildTeaFeatures } from '../ee/tea-features.ts';
import { labelParcels } from '../ee/weak-labels.ts';
import { NeighborhoodStore } from '../library/store.ts';

/* `ee` objects are untyped (see src/types/earthengine.d.ts). */
type EE = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const SCALE_M = 10;
/** Tea probability at or above this counts as a tea pixel. */
const TEA_THRESHOLD = 0.5;
/** Per deed-title cap on training pixels, so a few huge forest parcels cannot dominate. */
const MAX_PIXELS_PER_TITLE = 800;
/** Detected tea patches smaller than this are dropped as noise (3 Sentinel-2 pixels). */
const MIN_PATCH_M2 = 300;

const USAGE = `
Kullanım:
  npm run detect-tea -- --province Trabzon --district Of --neighborhood Çataldere [--start 2024-01-01 --end 2026-01-01]
`;

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            province: { type: 'string' },
            district: { type: 'string' },
            neighborhood: { type: 'string' },
            start: { type: 'string', default: '2024-01-01' },
            end: { type: 'string', default: '2026-01-01' },
        },
    });
    if (!values.province || !values.district || !values.neighborhood) {
        console.log(USAGE);
        process.exit(1);
    }
    const store = new NeighborhoodStore(values.province, values.district, values.neighborhood);
    const meta = store.readMeta();
    const parcels = store.loadParcels().filter((p) => p.properties.inTargetNeighborhood);
    if (!meta || parcels.length === 0) {
        throw new Error('Mahalle kütüphanesi boş; önce harvest çalıştırın.');
    }

    const ee = await initEarthEngine();
    const region = ee.Geometry(meta.boundary);
    const features = buildTeaFeatures(ee, region, values.start, values.end);
    const bandNames: string[] = await evaluate(features.bandNames());
    console.log(`Öznitelik sayısı: ${bandNames.length} (${values.start} → ${values.end})`);

    // ── Training samples from weakly labelled parcels ──
    const labelled = labelParcels(parcels);
    const trainingParcels = labelled.filter((l) => l.label !== null);
    const parcelCollection = ee.FeatureCollection(
        trainingParcels.map((l) =>
            ee.Feature(ee.Geometry(l.trainingGeometry), {
                label: l.label,
                split: l.split,
                nature: l.parcel.properties.nature.toLocaleLowerCase('tr'),
                key: l.parcel.properties.key,
            }),
        ),
    );
    const allSamples = features.sampleRegions({
        collection: parcelCollection,
        properties: ['label', 'split', 'nature', 'key'],
        scale: SCALE_M,
        tileScale: 4,
    });
    const natures = [...new Set(trainingParcels.map((l) => l.parcel.properties.nature.toLocaleLowerCase('tr')))];
    const capped = (split: string) =>
        ee.FeatureCollection(
            natures.map((nature) =>
                allSamples
                    .filter(ee.Filter.and(ee.Filter.eq('split', split), ee.Filter.eq('nature', nature)))
                    .randomColumn('rnd', 42)
                    .limit(MAX_PIXELS_PER_TITLE, 'rnd'),
            ),
        ).flatten();
    const train = capped('train');
    const test = capped('test');

    const classifier = ee.Classifier.smileRandomForest({ numberOfTrees: 150, minLeafPopulation: 2, seed: 42 })
        .setOutputMode('PROBABILITY')
        .train({ features: train, classProperty: 'label', inputProperties: bandNames });

    // ── Held-out evaluation (whole parcels never seen in training) ──
    const scored = test.classify(classifier, 'tea_p').map((f: EE) => f.set('pred', ee.Number(f.get('tea_p')).gte(TEA_THRESHOLD)));
    const matrix = scored.errorMatrix('label', 'pred', [0, 1]);
    const [trainCounts, testCounts, confusion, accuracy, kappa, recall, precision, importance] = await Promise.all([
        evaluate<Record<string, number>>(train.aggregate_histogram('label')),
        evaluate<Record<string, number>>(test.aggregate_histogram('label')),
        evaluate<number[][]>(matrix.array()),
        evaluate<number>(matrix.accuracy()),
        evaluate<number>(matrix.kappa()),
        evaluate<number[][]>(matrix.producersAccuracy()),
        evaluate<number[][]>(matrix.consumersAccuracy()),
        evaluate<{ importance: Record<string, number> }>(classifier.explain()),
    ]);
    // producersAccuracy is a column [[non-tea], [tea]]; consumersAccuracy a row [[non-tea, tea]].
    const teaRecall = recall[1]?.[0] ?? 0;
    const teaPrecision = precision[0]?.[1] ?? 0;
    console.log(`Eğitim pikselleri: ${JSON.stringify(trainCounts)} | Test pikselleri: ${JSON.stringify(testCounts)}`);
    console.log(
        `Test (dengeli): doğruluk %${(accuracy * 100).toFixed(1)} | kappa ${kappa.toFixed(2)} | ` +
            `çay yakalama %${(teaRecall * 100).toFixed(1)} | çay kesinlik %${(teaPrecision * 100).toFixed(1)}`,
    );

    // ── Wall-to-wall probability, per-parcel tea share, detected tea patches ──
    const probability = features.classify(classifier).rename('tea_p').clip(region);
    const teaMask = probability.gte(TEA_THRESHOLD).rename('tea');
    const perParcel = probability.addBands(teaMask).reduceRegions({
        collection: ee.FeatureCollection(parcels.map((p) => ee.Feature(ee.Geometry(p.geometry), { key: p.properties.key }))),
        reducer: ee.Reducer.mean(),
        scale: SCALE_M,
        tileScale: 4,
    });
    const patches = teaMask
        .selfMask()
        .reduceToVectors({ geometry: region, scale: SCALE_M, geometryType: 'polygon', eightConnected: true, maxPixels: 1e8 })
        .map((f: EE) => f.set('areaM2', f.geometry().area(1)))
        .filter(ee.Filter.gte('areaM2', MIN_PATCH_M2));

    const [parcelStats, patchCollection] = await Promise.all([
        evaluate<{ features: Array<{ properties: { key: string; tea_p?: number; tea?: number } }> }>(perParcel),
        evaluate<object>(patches),
    ]);

    const statsByKey = new Map(parcelStats.features.map((f) => [f.properties.key, f.properties]));
    const labelByKey = new Map(labelled.map((l) => [l.parcel.properties.key, l]));
    const enriched = parcels.map((parcel) => {
        const stats = statsByKey.get(parcel.properties.key);
        const teaShare = stats?.tea ?? null;
        const label = labelByKey.get(parcel.properties.key);
        return {
            ...parcel,
            properties: {
                ...parcel.properties,
                teaProbability: stats?.tea_p === undefined ? null : Math.round(stats.tea_p * 1000) / 1000,
                teaShare: teaShare === null ? null : Math.round(teaShare * 1000) / 1000,
                teaAreaM2: teaShare === null ? null : Math.round(teaShare * parcel.properties.geometryAreaM2),
                weakLabel: label?.label ?? null,
                split: label?.split ?? null,
            },
        };
    });

    writeFileSync(join(store.dir, 'tea-patches.geojson'), JSON.stringify(patchCollection));
    store.writeGeoJson('parcels-tea.geojson', enriched);

    const titledTea = enriched.filter((p) => /çay/i.test(p.properties.nature));
    const otherTitles = enriched.filter((p) => !/çay/i.test(p.properties.nature));
    const share = (p: (typeof enriched)[number]) => p.properties.teaShare ?? 0;
    const report = {
        neighborhood: meta.neighborhood,
        period: { start: values.start, end: values.end },
        model: {
            type: 'RandomForest(150), weak labels from TKGM deed title',
            features: bandNames.length,
            threshold: TEA_THRESHOLD,
            trainPixels: trainCounts,
            testPixels: testCounts,
            heldOutAccuracy: Math.round(accuracy * 1000) / 1000,
            kappa: Math.round(kappa * 1000) / 1000,
            teaRecall: Math.round(teaRecall * 1000) / 1000,
            teaPrecision: Math.round(teaPrecision * 1000) / 1000,
            confusion: { rows: 'actual [non-tea, tea]', cols: 'predicted [non-tea, tea]', matrix: confusion },
            topFeatures: Object.entries(importance.importance)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([band, value]) => ({ band, importance: Math.round(value * 10) / 10 })),
        },
        parcels: {
            total: enriched.length,
            teaTitled: titledTea.length,
            teaTitledWithTeaDetected: titledTea.filter((p) => share(p) >= 0.3).length,
            teaTitledWithoutTea: titledTea.filter((p) => share(p) < 0.1).length,
            otherTitledWithTeaDetected: otherTitles.filter((p) => share(p) >= 0.3).length,
            detectedTeaAreaM2: enriched.reduce((sum, p) => sum + (p.properties.teaAreaM2 ?? 0), 0),
        },
    };
    writeFileSync(join(store.dir, 'tea-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report.parcels, null, 2));
    console.log(`Çıktılar: ${store.dir}`);
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
