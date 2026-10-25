import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { MultiPolygon, Polygon } from 'geojson';
import { area, centroid, distance, feature } from '@turf/turf';
import { initEarthEngine, evaluate } from '../ee/session.ts';
import { buildTeaFeatures } from '../ee/tea-features.ts';
import { labelParcels } from '../ee/weak-labels.ts';
import { LIBRARY_ROOT, NeighborhoodStore, slugify, type NeighborhoodMeta } from '../library/store.ts';
import { isTeaTitle } from '../tkgm/titles.ts';
import type { Parcel } from '../tkgm/types.ts';

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
  npm run detect-tea -- --province Trabzon --district Of --neighborhood Çataldere [--start 2024-01-01 --end 2026-01-01] [--own-training]

Eğitim örnekleri varsayılan olarak ilçe kütüphanesindeki BÜTÜN mahallelerin parsellerinden havuzlanır:
parsel kütüphanesi henüz küçük olan yeni bir mahalle de komşularının tapu nitelikleriyle eğitilmiş sınıflandırıcıyla
taranır. --own-training yalnız hedef mahallenin parsellerini kullanır (pilot davranışı).
`;

interface TrainingPool {
    parcels: Parcel[];
    boundaries: Array<Polygon | MultiPolygon>;
    neighborhoods: string[];
}

/** Enough labelled parcels for the classifier; beyond this the pool stops growing. */
const POOL_TARGET_PARCELS = 700;
/** Upper bound on the pooled boundary area: Earth Engine samples all of it in one job (memory). */
const POOL_MAX_HA = 6500;

/**
 * Harvested parcels of the target plus its nearest neighbourhoods in the district library, closest first,
 * until the pool has POOL_TARGET_PARCELS parcels or POOL_MAX_NEIGHBORHOODS members.
 */
function loadDistrictTrainingPool(province: string, district: string, target: NeighborhoodStore, targetMeta: NeighborhoodMeta): TrainingPool {
    const districtDir = join(LIBRARY_ROOT, slugify(province), slugify(district));
    const pool: TrainingPool = { parcels: [], boundaries: [], neighborhoods: [] };
    const slugs = existsSync(districtDir) ? readdirSync(districtDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
    const targetSlug = target.dir.split(/[\\/]/).at(-1) as string;
    const targetCentre = centroid(feature(targetMeta.boundary));
    const candidates = slugs
        .filter((s) => s !== targetSlug)
        .map((slug) => {
            const store = new NeighborhoodStore(province, district, slug);
            const meta = store.readMeta();
            return meta ? { store, meta, km: distance(targetCentre, centroid(feature(meta.boundary))) } : null;
        })
        .filter((c): c is { store: NeighborhoodStore; meta: NeighborhoodMeta; km: number } => c !== null)
        .sort((a, b) => a.km - b.km);
    let pooledHa = 0;
    for (const { store, meta } of [{ store: target, meta: targetMeta }, ...candidates]) {
        if (store !== target && pool.parcels.length >= POOL_TARGET_PARCELS) break;
        const parcels = store.loadParcels().filter((p) => p.properties.inTargetNeighborhood);
        if (parcels.length === 0) continue;
        const ha = area(feature(meta.boundary)) / 1e4;
        // A neighbourhood that would push the sampled region past the memory budget is skipped, not the whole search.
        if (store !== target && pooledHa + ha > POOL_MAX_HA) continue;
        pooledHa += ha;
        pool.parcels.push(...parcels);
        pool.boundaries.push(meta.boundary);
        pool.neighborhoods.push(meta.neighborhood);
    }
    return pool;
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            province: { type: 'string' },
            district: { type: 'string' },
            neighborhood: { type: 'string' },
            start: { type: 'string', default: '2024-01-01' },
            end: { type: 'string', default: '2026-01-01' },
            'own-training': { type: 'boolean', default: false },
        },
    });
    if (!values.province || !values.district || !values.neighborhood) {
        console.log(USAGE);
        process.exit(1);
    }
    const store = new NeighborhoodStore(values.province, values.district, values.neighborhood);
    const meta = store.readMeta();
    if (!meta) {
        throw new Error('meta.json yok; önce harvest çalıştırın.');
    }
    const parcels = store.loadParcels().filter((p) => p.properties.inTargetNeighborhood);
    const pool = values['own-training']
        ? { parcels, boundaries: [meta.boundary], neighborhoods: [meta.neighborhood] }
        : loadDistrictTrainingPool(values.province, values.district, store, meta);
    if (pool.parcels.length === 0) {
        throw new Error('İlçe kütüphanesinde parsel yok; önce harvest çalıştırın.');
    }
    console.log(`Hedef mahalle: ${parcels.length} parsel · eğitim havuzu: ${pool.parcels.length} parsel, ${pool.neighborhoods.length} mahalle (${pool.neighborhoods.join(', ')})`);

    const ee = await initEarthEngine();
    const region = ee.Geometry(meta.boundary);
    // Features are computed over every neighbourhood that contributes training parcels; classification is clipped to the target.
    const featureRegion = pool.boundaries.length === 1 ? region : ee.FeatureCollection(pool.boundaries.map((b) => ee.Feature(ee.Geometry(b)))).geometry(1);
    const features = buildTeaFeatures(ee, featureRegion, values.start, values.end);
    const bandNames: string[] = await evaluate(features.bandNames());
    console.log(`Öznitelik sayısı: ${bandNames.length} (${values.start} → ${values.end})`);

    // ── Training samples from weakly labelled parcels (district pool) ──
    const labelled = labelParcels(pool.parcels);
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
        tileScale: 8,
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
        parcels.length === 0
            ? Promise.resolve({ features: [] as Array<{ properties: { key: string; tea_p?: number; tea?: number } }> })
            : evaluate<{ features: Array<{ properties: { key: string; tea_p?: number; tea?: number } }> }>(perParcel),
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

    const titledTea = enriched.filter((p) => isTeaTitle(p.properties.nature));
    const otherTitles = enriched.filter((p) => !isTeaTitle(p.properties.nature));
    const share = (p: (typeof enriched)[number]) => p.properties.teaShare ?? 0;
    const report = {
        neighborhood: meta.neighborhood,
        period: { start: values.start, end: values.end },
        model: {
            type: 'RandomForest(150), weak labels from TKGM deed title',
            trainingNeighborhoods: pool.neighborhoods,
            trainingParcels: trainingParcels.length,
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
