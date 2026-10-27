import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { initEarthEngine } from '../ee/session.ts';
import { NeighborhoodStore } from '../library/store.ts';
import { loadDailyClimate, meanElevation, parcelClimate, summariseClimate, type ClimateSummary, type DailyClimate } from '../land/climate.ts';
import { landUseHistory, ndviHistory, terrainAndSoil, type LandUseRaw, type NdviHistoryRaw, type SoilRaw, type TerrainRaw } from '../land/ee-layers.ts';
import {
    CROPS,
    LAND_RULES,
    LAW5403_LABEL,
    aspectLabel,
    capabilityOf,
    declaredUseOf,
    dominantClass,
    erosionOf,
    mismatchesOf,
    observedUseOf,
    phLabel,
    recommendationsOf,
    slopeClassOf,
    suitabilityOf,
    textureLabel,
    type AkkClass,
    type CropKey,
    type ErosionClass,
    type Law5403Class,
    type MismatchFlag,
    type ObservedUse,
    type ParcelLandEvaluation,
} from '../land/model.ts';
import { CROP_RULES } from '../land/rules.ts';
import { SOURCES, STATIONS, SUPPORT_PRODUCT_TO_CROP, districtFactsOf, type DistrictFacts, type SourceRef, type StationNormals } from '../land/sources.ts';

type Poly = Polygon | MultiPolygon;

const USAGE = `Toprak Koruma ve Arazi Değerlendirme (ayrı modül): her parsel için topografya (radar DEM), toprak, akarsu/taşkın,
mevcut kullanım (tapu niteliği ↔ uydu, 1986'dan bugüne örtü tarihi), erozyon, arazi kabiliyet sınıfı (AKK), 5403 sınıf önerisi
ve kaynaklı ürün uygunluğu; mahalle için MGM normallerine bağlanmış 1991'den bugüne günlük iklim kaydı, indisler ve anomaliler.

  npm run evaluate-land -- --province Trabzon --district Of --neighborhood Çataldere [--from 1991] [--refetch]

Çıktı: land/evaluation.json (ham katmanlar land/raw-*.json ve land/climate/climate-<yıl>.json önbelleğinde)
`;

interface ParcelProps {
    key: string;
    block: string;
    parcel: string;
    nature: string;
    geometryAreaM2: number;
    teaShare: number | null;
}

export interface LandEvaluationFile {
    generatedAt: string;
    method: string;
    rules: typeof LAND_RULES;
    crops: typeof CROPS;
    cropRules: typeof CROP_RULES;
    sources: SourceRef[];
    stations: StationNormals[];
    district: DistrictFacts | null;
    neighbourhood: {
        boundaryAreaM2: number;
        climate: ClimateSummary;
        landUse: { years: number[]; boundary: LandUseRaw['boundary']; worldcover: LandUseRaw['boundaryWorldcover'] };
        ndviHistory: NdviHistoryRaw['boundary'];
        ndviPeriods: NdviHistoryRaw['periods'];
    };
    summary: {
        parcels: number;
        evaluatedAreaM2: number;
        byAkk: Record<AkkClass, number>;
        byLaw5403: Record<Law5403Class, number>;
        byObserved: Record<ObservedUse, number>;
        byErosion: Record<ErosionClass | 'no_data', number>;
        mismatches: Record<MismatchFlag, number>;
        suitabilityMean: Record<CropKey, number>;
        conversionCandidates: number;
    };
    parcels: ParcelLandEvaluation[];
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            province: { type: 'string' },
            district: { type: 'string' },
            neighborhood: { type: 'string' },
            from: { type: 'string', default: '1991' },
            refetch: { type: 'boolean', default: false },
        },
    });
    if (!values.province || !values.district || !values.neighborhood) {
        console.log(USAGE);
        process.exit(1);
    }
    const store = new NeighborhoodStore(values.province, values.district, values.neighborhood);
    const meta = store.readMeta();
    if (!meta) throw new Error('meta.json yok; önce harvest çalıştırın.');
    const parcelsPath = join(store.dir, 'parcels-tea.geojson');
    const parcels = existsSync(parcelsPath) ? (JSON.parse(readFileSync(parcelsPath, 'utf8')) as FeatureCollection<Poly, ParcelProps>).features : [];
    const summaryFile = join(store.dir, 'summary.json');
    const boundaryAreaM2 = existsSync(summaryFile) ? ((JSON.parse(readFileSync(summaryFile, 'utf8')) as { boundaryAreaM2?: number }).boundaryAreaM2 ?? 0) : 0;
    const fromYear = Number(values.from);
    const today = new Date().toISOString().slice(0, 10);
    const thisYear = Number(today.slice(0, 4));
    const outDir = join(store.dir, 'land');
    mkdirSync(outDir, { recursive: true });
    const district = districtFactsOf(meta.province, meta.district);
    const supportedCrops = new Set<CropKey>((district?.supportedProducts?.products ?? []).map((p) => SUPPORT_PRODUCT_TO_CROP[p]).filter((c): c is string => !!c) as CropKey[]);
    console.log(`${meta.neighborhood}: ${parcels.length} parsel · iklim ${fromYear} → ${today} · ilçe destek listesi: ${district?.supportedProducts?.products.join(', ') ?? 'yok'}`);

    const cached = <T>(name: string, build: () => Promise<T>): Promise<T> => {
        const path = join(outDir, name);
        if (existsSync(path) && !values.refetch) {
            console.log(`  ${name}: önbellekten`);
            return Promise.resolve(JSON.parse(readFileSync(path, 'utf8')) as T);
        }
        return build().then((v) => {
            writeFileSync(path, JSON.stringify(v));
            return v;
        });
    };
    const ee = await initEarthEngine();
    const inputs = parcels.map((f) => ({ key: f.properties.key, geometry: f.geometry }));
    console.log('Topografya (Copernicus DEM), hidroloji (MERIT, JRC) ve toprak (OpenLandMap)…');
    const layers = await cached<{ terrain: Record<string, TerrainRaw>; soil: Record<string, SoilRaw> }>('raw-layers.json', () => terrainAndSoil(ee, inputs));
    console.log(`  ${Object.keys(layers.terrain).length} parselde topografya, ${Object.keys(layers.soil).length} parselde toprak`);
    console.log('Arazi kullanımı (Dynamic World yıllık, WorldCover 2021)…');
    const landUse = await cached<LandUseRaw>('raw-landuse.json', () => landUseHistory(ee, meta.boundary, inputs, 2017, thisYear));
    console.log(`  yıllar: ${landUse.years.join(', ')}`);
    console.log('Bitki örtüsü tarihi (Landsat NDVI 1986 →)…');
    const ndvi = await cached<NdviHistoryRaw>('raw-ndvi.json', () => ndviHistory(ee, meta.boundary, inputs));
    console.log(`  ${ndvi.periods.map((p) => `${p.period} (${p.scenes} sahne)`).join(', ')}`);

    // Climate reference height: where people farm (tea parcels, else all parcels, else the tea patches), not the ridges.
    const parcelElevs = parcels.map((f) => ({ tea: (f.properties.teaShare ?? 0) >= 0.3, e: layers.terrain[f.properties.key]?.elevationM ?? null })).filter((x): x is { tea: boolean; e: number } => x.e !== null);
    const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : null);
    const teaPatchesPath = join(store.dir, 'tea-patches.geojson');
    const patchGeoms = existsSync(teaPatchesPath) ? (JSON.parse(readFileSync(teaPatchesPath, 'utf8')) as FeatureCollection<Poly>).features.map((f) => f.geometry) : [];
    const refElev = median(parcelElevs.filter((x) => x.tea).map((x) => x.e)) ?? median(parcelElevs.map((x) => x.e)) ?? (await meanElevation(ee, patchGeoms.slice(0, 400)));
    console.log(`İklim (ERA5-Land + CHIRPS günlük, MGM normallerine bağlı), referans yükselti ${refElev === null ? 'sınır ortalaması' : `${Math.round(refElev)} m`}…`);
    const daily: DailyClimate = await loadDailyClimate(ee, meta.boundary, fromYear, today, refElev, join(outDir, 'climate'), values.refetch, (s) => console.log(s));
    console.log(`  ${daily.dates.length} gün (${daily.dates[0]} → ${daily.dates.at(-1)}); istasyonlar ${daily.anchor.stations.map((s) => `${s.name} ${Math.round(s.weight * 100)}% (${s.distanceKm} km)`).join(', ')}; normal yağış ${daily.anchor.normal.annualPrecipMm} mm, ortalama ${daily.anchor.normal.annualTmean} °C`);
    const climate = summariseClimate(daily);
    const recentPrecip = climate.yearly.filter((y) => climate.recentYears.includes(Number(y.period)));
    const annualPrecip = recentPrecip.length ? recentPrecip.reduce((s, y) => s + y.precipMm, 0) / recentPrecip.length : null;

    const evaluated: ParcelLandEvaluation[] = [];
    for (const f of parcels) {
        const p = f.properties;
        const terrain = layers.terrain[p.key] ?? { elevationM: null, slopePct: null, slopeMaxPct: null, aspectDeg: null, tpiM: null, handM: null, upstreamKm2: null, streamDistM: null, waterOccurrence: null };
        const soil = layers.soil[p.key] ?? { clayPct: null, sandPct: null, siltPct: null, ph: null, socPct: null, cec: null, bulkDensity: null, textureCode: null };
        const years = landUse.years.filter((y) => landUse.parcels[p.key]?.[y]);
        const history = years.map((y) => ({ year: y, dominant: dominantClass(landUse.parcels[p.key]![y]!), fractions: landUse.parcels[p.key]![y]! }));
        const latestYear = years.at(-1) ?? null;
        const latest = latestYear ? landUse.parcels[p.key]![latestYear]! : {};
        const declared = declaredUseOf(p.nature);
        const observed = observedUseOf(latest, p.teaShare);
        const mismatches = mismatchesOf(declared, observed, latest, p.teaShare, p.nature);
        const first = history.find((h) => h.dominant);
        const last = [...history].reverse().find((h) => h.dominant);
        const change = first && last && first.year !== last.year && first.dominant !== last.dominant ? { from: first.dominant!, to: last.dominant!, fromYear: first.year, toYear: last.year } : null;
        const erosion = erosionOf(terrain, soil, observed, annualPrecip);
        const floodProne = (terrain.handM ?? 99) <= LAND_RULES.floodProne.maxHandM && (terrain.streamDistM ?? 9999) <= LAND_RULES.floodProne.maxStreamDistM;
        const pc = parcelClimate(daily, climate.recentYears, terrain.elevationM);
        const suitability = suitabilityOf({ terrain, soil, climate: pc, erosion: erosion.class, floodProne, supportedCrops });
        const perennialSuitable = (suitability.find((s) => s.crop === 'tea')?.score ?? 0) >= 60 || (suitability.find((s) => s.crop === 'hazelnut')?.score ?? 0) >= 60;
        const capability = capabilityOf(terrain, soil, erosion.class, observed, declared, perennialSuitable);
        const slope = slopeClassOf(terrain.slopePct);
        const base: Omit<ParcelLandEvaluation, 'recommendations'> = {
            key: p.key,
            block: p.block,
            parcel: p.parcel,
            nature: p.nature,
            areaM2: Math.round(p.geometryAreaM2),
            terrain: { ...terrain, slopeClass: slope.code, slopeLabel: slope.label, aspectLabel: aspectLabel(terrain.aspectDeg) },
            soil: { ...soil, textureLabel: textureLabel(soil.textureCode), phLabel: phLabel(soil.ph) },
            landUse: { declared, observed, teaShare: p.teaShare, latestYear, latest, history, worldcover: landUse.worldcover[p.key] ?? {}, mismatches, change, ndviHistory: ndvi.parcels[p.key] ?? [] },
            erosion,
            capability,
            climate: pc,
            suitability,
        };
        evaluated.push({ ...base, recommendations: recommendationsOf(base) });
    }

    const count = <K extends string>(keys: readonly K[], pick: (e: ParcelLandEvaluation) => K | null) =>
        Object.fromEntries(keys.map((k) => [k, evaluated.filter((e) => pick(e) === k).length])) as Record<K, number>;
    const mismatchKeys: MismatchFlag[] = ['tea_title_no_tea', 'abandoned_to_trees', 'agri_to_built', 'forest_cleared', 'pasture_to_crops', 'wet_or_water'];
    const summary: LandEvaluationFile['summary'] = {
        parcels: evaluated.length,
        evaluatedAreaM2: evaluated.reduce((s, e) => s + e.areaM2, 0),
        byAkk: count(['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'] as AkkClass[], (e) => e.capability.akk),
        byLaw5403: count(Object.keys(LAW5403_LABEL) as Law5403Class[], (e) => e.capability.law5403),
        byObserved: count(['tea', 'trees', 'pasture', 'field', 'shrub', 'built', 'bare', 'water', 'wet', 'unknown'] as ObservedUse[], (e) => e.landUse.observed),
        byErosion: count(['very_low', 'low', 'moderate', 'high', 'very_high', 'no_data'] as Array<ErosionClass | 'no_data'>, (e) => e.erosion.class),
        mismatches: Object.fromEntries(mismatchKeys.map((k) => [k, evaluated.filter((e) => e.landUse.mismatches.includes(k)).length])) as Record<MismatchFlag, number>,
        suitabilityMean: Object.fromEntries(
            CROPS.map((c) => [c.key, evaluated.length ? Math.round(evaluated.reduce((s, e) => s + (e.suitability.find((x) => x.crop === c.key)?.score ?? 0), 0) / evaluated.length) : 0]),
        ) as Record<CropKey, number>,
        // A conversion candidate: the present use scores poorly here while another crop scores well.
        conversionCandidates: evaluated.filter((e) => {
            const best = e.suitability.find((s) => s.crop !== 'forestry');
            const current: Record<ObservedUse, CropKey[]> = { tea: ['tea'], trees: ['chestnut', 'forestry'], pasture: ['pasture'], field: ['vegetable'], shrub: [], built: [], bare: [], water: [], wet: [], unknown: [] };
            const currentScore = Math.max(0, ...current[e.landUse.observed].map((k) => e.suitability.find((s) => s.crop === k)?.score ?? 0));
            return !!best && best.score >= 80 && currentScore < 50 && e.landUse.observed !== 'built' && e.landUse.observed !== 'water';
        }).length,
    };
    const file: LandEvaluationFile = {
        generatedAt: new Date().toISOString(),
        method: 'Masa başı ön değerlendirme: Copernicus DEM (radar) eğim/bakı/HAND, OpenLandMap toprak, Dynamic World yıllık arazi örtüsü + Landsat NDVI 1986→, Trabzon ölçekli RUSLE indeksi, AKK sınıf yaklaşımı (USDA/Teknik Talimat), 5403 ve 2026 Yönetmeliği sınıf önerisi, kaynaklı ürün uygunluk puanları (TAGEM/KTAE/üniversite/coğrafi işaret eşikleri), ERA5-Land/CHIRPS iklim kaydı MGM istasyon normallerine bağlı, Erinç/De Martonne indisleri',
        rules: LAND_RULES,
        crops: CROPS,
        cropRules: CROP_RULES,
        sources: SOURCES,
        stations: STATIONS,
        district,
        neighbourhood: { boundaryAreaM2, climate, landUse: { years: landUse.years, boundary: landUse.boundary, worldcover: landUse.boundaryWorldcover }, ndviHistory: ndvi.boundary, ndviPeriods: ndvi.periods },
        summary,
        parcels: evaluated,
    };
    writeFileSync(join(outDir, 'evaluation.json'), JSON.stringify(file));
    console.log(`AKK: ${JSON.stringify(summary.byAkk)}`);
    console.log(`5403: ${JSON.stringify(summary.byLaw5403)} · kullanım ${JSON.stringify(summary.byObserved)}`);
    console.log(`Uyumsuzluk: ${JSON.stringify(summary.mismatches)} · erozyon ${JSON.stringify(summary.byErosion)}`);
    console.log(`Uygunluk ortalamaları: ${JSON.stringify(summary.suitabilityMean)} · dönüşüm adayı ${summary.conversionCandidates}`);
    console.log(`İklim: ${climate.yearly.length} tam yıl, ${climate.baselineYears[0]}–${climate.baselineYears.at(-1)} → ${climate.recentYears[0]}–${climate.recentYears.at(-1)}: sıcaklık ${climate.anomaly.tmean > 0 ? '+' : ''}${climate.anomaly.tmean} °C, yağış ${climate.anomaly.precipMm > 0 ? '+' : ''}${climate.anomaly.precipMm} mm; Erinç ${climate.indices.erinc.value} (${climate.indices.erinc.class}), De Martonne ${climate.indices.deMartonne.value} (${climate.indices.deMartonne.class}), ${climate.indices.koppen.code}`);
    console.log(`Çıktı: ${join(outDir, 'evaluation.json')}`);
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
