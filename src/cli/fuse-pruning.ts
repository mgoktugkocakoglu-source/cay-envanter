import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { area as turfArea, difference, feature, featureCollection, intersect, union } from '@turf/turf';
import { initEarthEngine, isCapacityError } from '../ee/session.ts';
import { pruningWindows } from '../ee/pruning.ts';
import { NeighborhoodStore } from '../library/store.ts';
import { buildDemoProducers } from '../producers/demo-producers.ts';
import { currentGeometry, type LicensingRegistry } from '../licensing/registry.ts';
import { backscatterSeries, type OrbitPass } from '../radar/series.ts';
import { opticalSeries, type OpticalSeries } from '../fusion/optical-series.ts';
import {
    applyDateQuality,
    CHANNEL_DEFAULTS,
    dateQuality,
    FUSION_RULES,
    judge,
    priorContext,
    relativeToNeighbourhood,
    scanTimeline,
    type ChannelKey,
    type ChannelSeries,
    type DateQuality,
    type FusionClass,
    type FusionVerdict,
    type UnitContext,
} from '../fusion/model.ts';

type Poly = Polygon | MultiPolygon;
/* `ee` objects are untyped (see src/types/earthengine.d.ts). */
type EE = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const USAGE = `
Kullanım:
  npm run fuse-pruning -- --province Trabzon --district Of --neighborhood Çataldere --season 2025 [--every 2] [--ratio 7] [--no-baseline] [--refetch]

Çok-sensörlü budama kararı (ayrı modül): her bahçe için Sentinel-2 + Landsat 8/9 NDVI/NBR/NDRE/NDII,
Sentinel-1 arazi-düzleştirilmiş VH ve VH/VV (iki yörünge) ve varsa koherans (HyP3 ya da SNAP) serileri
komşuluğa göreli hale getirilir; aday değişim tarihlerinde kalıcı basamak değişimi aranır, sensörler
birleştirilir. Önceki sezonun optik serisi bahçenin alışkanlık gürültüsünü ve geçici kış düşüşlerini
(gölge/kar) verir. Taramalar --every günde bir taklit edilir. --ratio budama oranı (7 = 1/7, 10 = 1/10).
Çıktı: pruning-fusion/season-<yyyy-yy>.json
`;

interface CoherenceFile {
    source?: string;
    passes: Array<{ pass: OrbitPass; pairs: Array<[string, string]> }>;
    gardens: Record<string, Record<string, Array<number | null>>>;
}

export interface FusionGarden {
    id: string;
    producerId: string;
    parcelKey: string;
    areaM2: number;
    licensedAreaM2: number | null;
    /** Which unit carried the verdict: the whole garden or the optical change patch inside it. */
    unit: 'garden' | 'patch';
    unitAreaM2: number;
    unitGeometry: Poly;
    /**
     * The 7-season rule: ground already pruned in an earlier season of the cycle does not count
     * again. Overlap of this unit with earlier seasons' pruned units, with the evidence.
     */
    repeat: {
        reusedM2: number;
        reusedShare: number;
        countedM2: number;
        evidence: Array<{ season: string; overlapM2: number; class: FusionClass }>;
    } | null;
    verdict: FusionVerdict;
    detectedAt: string | null;
    likelyAt: string | null;
    scans: Array<{ date: string; z: number | null; class: FusionClass }>;
    /** Channel series (neighbourhood-relative) for the screen. */
    series: Array<{ key: ChannelKey; dates: string[]; values: Array<number | null> }>;
    /** Prior-season context used for this unit (shade-prone flag, prior noise). */
    context: UnitContext;
}

export type ProducerFusionStatus = 'pruned_full' | 'pruned_partial' | 'none' | 'unclear' | 'no_license' | 'no_data';

/**
 * Purchase decision policy: the satellite decides on its own wherever the evidence is clean;
 * an expert only sees anomalies (contradicting sensors, repeat pruning, boundary conflicts,
 * licence problems, suspicious over-pruning).
 */
export type FusionDecision = 'auto_open' | 'auto_pending' | 'auto_short' | 'auto_none' | 'expert_anomaly' | 'no_license' | 'no_data';
export type FusionAnomaly = 'sensors_contradict' | 'repeat_pruning' | 'boundary_conflict' | 'boundary_unresolved' | 'license_mismatch' | 'over_pruned' | 'unlicensed_pruning';

export interface FusionProducer {
    id: string;
    licensedAreaM2: number;
    requiredM2: number;
    prunedAreaM2: number;
    likelyAreaM2: number;
    /** Area counted toward the 1/7: confirmed + likely units, minus ground reused from the cycle. */
    countedM2: number;
    reusedM2: number;
    /** What is still missing against the 1/7 (0 when met). */
    shortfallM2: number;
    gardens: number;
    prunedGardens: string[];
    likelyGardens: string[];
    status: ProducerFusionStatus;
    firstDetectedAt: string | null;
    decision: FusionDecision;
    anomalies: FusionAnomaly[];
    decisionReason: string;
}

/** Tea the satellite sees outside every harvested parcel: judged too, matched to an owner later. */
export interface FusionUnassigned {
    id: string;
    areaM2: number;
    geometry: Poly;
    verdict: FusionVerdict;
    detectedAt: string | null;
    likelyAt: string | null;
}

export interface FusionSummary {
    byClass: Record<FusionClass, number>;
    review: number;
    shadeProne: number;
    underObserved: number;
    /** Histogram of clear optical observations per garden in the season window. */
    opticalObsHistogram: Record<string, number>;
    medianOpticalObs: number | null;
    medianOpticalGapDays: number | null;
    /** How the "pruned" verdicts were reached. */
    prunedBy: { opticalOnly: number; opticalWithRadar: number; joint: number };
    radarRequiredShare: number;
    sensorsUsed: string[];
    /** Optical dates dropped by the screening (snow / shadow collapse of the neighbourhood median, sparse coverage). */
    excludedDates: number;
    /** Robust centre / scale of the garden-unit optical z over the neighbourhood (population calibration). */
    populationNull: { centre: number; scale: number; n: number } | null;
    /** Verdicts the population calibration moved down (pruned → likely, likely → unclear). */
    populationDowngraded: number;
    /** Weak "unclear" verdicts inside the neighbourhood bulk that the calibration settled as "not pruned". */
    populationResolved: number;
    /** Gardens whose optical z clears the "likely" bar; the guard counts below are over these. */
    strongSignals: number;
    /** Garden count per verdict kind (why the class is what it is). */
    kinds: Record<string, number>;
    /** Physical guards: gradual-loss units, raw-level failures, summer-recovery outcomes, change dates outside the calendar. */
    gradual: number;
    levelFailed: number;
    recoveryConfirmed: number;
    recoveryFailed: number;
    recoveryUntested: number;
    outsideCalendar: number;
}

export interface FusionSeasonFile {
    season: string;
    rules: typeof FUSION_RULES & { pruningRatio: number };
    channels: typeof CHANNEL_DEFAULTS;
    everyDays: number;
    scanFrom: string;
    scanTo: string;
    sensors: {
        optical: { dates: string[]; sensors?: string[]; counts?: Record<string, number>; excluded?: DateQuality[] };
        backscatter: Array<{ pass: OrbitPass; relativeOrbit: number; dates: string[]; processing?: string }>;
        coherence: Array<{ pass: OrbitPass; dates: string[]; source?: string }>;
    };
    gardens: FusionGarden[];
    producers: FusionProducer[];
    unassigned: FusionUnassigned[];
    /** Share of the neighbourhood covered by harvested TKGM parcels (the rest is "unassigned"). */
    parcelCoverage: number;
    policy: typeof DECISION_POLICY;
    summary: FusionSummary;
    /** Prior season used for the per-unit context (null when none was available). */
    baselineSeason: string | null;
    /** Present when calibrate-fusion ran with --apply: the field-label scores behind the thresholds in `rules`. */
    calibration?: { labels: number; positives: number; negatives: number; recall: number | null; falseAlarmRate: number | null; zPruned: number; zLikely: number; computedAt: string } | null;
}

export const DECISION_POLICY = {
    /** "Likely" units count toward the 1/7 like confirmed ones (they keep their own label on screen). */
    likelyCounts: true,
    /** Pruned area above this multiple of the 1/7 target is suspicious (clearing, not pruning). */
    overPrunedRatio: 3.0,
    /** Seasons in the pruning rotation: ground pruned within this many earlier seasons does not count again. */
    cycleSeasons: 7,
    /** Reused share of a unit that is flagged as repeat pruning (always subtracted, flagged above this). */
    repeatShare: 0.2,
    /**
     * Anomalies that send the file to an expert; the others (repeat pruning, licence-area mismatch,
     * unresolved share boundary) are notes: repeat pruning is subtracted automatically and the
     * shortfall is written, no expert needed.
     */
    blocking: ['sensors_contradict', 'boundary_conflict', 'unlicensed_pruning', 'over_pruned'] as FusionAnomaly[],
    /** Smallest free tea patch judged on its own (m²). */
    minUnassignedM2: 300,
} as const;

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            province: { type: 'string' },
            district: { type: 'string' },
            neighborhood: { type: 'string' },
            season: { type: 'string', default: '2025' },
            every: { type: 'string', default: '2' },
            ratio: { type: 'string', default: process.env.PRUNING_RATIO ?? '7' },
            'no-baseline': { type: 'boolean', default: false },
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
    const year = Number(values.season);
    const windows = pruningWindows(year);
    const every = Math.max(1, Number(values.every));
    // ÇAYKUR's rotation: 1/5 (1994–2003), 1/7, 1/10 by the 2012 decree, "1/7" again in 2022 statements — a parameter until confirmed.
    const pruningRatio = Math.max(2, Math.round(Number(values.ratio) || 7));
    Object.assign(DECISION_POLICY, { cycleSeasons: pruningRatio });
    const read = <T>(name: string): T => JSON.parse(readFileSync(join(store.dir, name), 'utf8')) as T;
    const parcels = read<FeatureCollection<Poly, { key: string; block: string; parcel: string; teaAreaM2: number | null }>>('parcels-tea.geojson');
    const teaPatches = read<FeatureCollection<Poly>>('tea-patches.geojson');
    const registryPath = join(store.dir, 'licensing', 'registry.json');
    const registry = existsSync(registryPath) ? (JSON.parse(readFileSync(registryPath, 'utf8')) as LicensingRegistry) : null;
    const { producers, gardens: slices } = buildDemoProducers(parcels.features.map((f) => ({ ...f.properties, geometry: f.geometry })));
    const byCode = new Map(registry?.gardens.map((g) => [g.code, g]) ?? []);
    const gardens = slices.map((g) => {
        const reg = byCode.get(g.id);
        return { id: g.id, producerId: g.producerId, parcelKey: g.parcelKey, geometry: (reg ? currentGeometry(reg) : g.geometry) as Poly, areaM2: reg?.planimetricAreaM2 ?? g.geometryAreaM2, licensedAreaM2: reg?.licensedAreaM2 ?? null };
    });
    // Only a seventh of a producer's tea is pruned, often a strip inside a garden: judging the
    // whole garden dilutes the step. Where the optical scan drew a change patch, that patch is
    // judged as its own unit and the garden takes the stronger of the two verdicts.
    const scanPath = join(store.dir, 'producers', `season-${windows.season}.json`);
    const patches = new Map<string, { geometry: Poly; areaM2: number }>();
    const reusedShare = new Map<string, number>();
    if (existsSync(scanPath)) {
        const scan = JSON.parse(readFileSync(scanPath, 'utf8')) as { events: Array<{ gardenId: string; areaM2: number; reusedM2: number; geometry: Poly }> };
        for (const e of scan.events) {
            if (e.areaM2 >= 100) patches.set(e.gardenId, { geometry: e.geometry, areaM2: e.areaM2 });
            if (e.areaM2 > 0) reusedShare.set(e.gardenId, e.reusedM2 / e.areaM2);
        }
    }
    // Tea outside every harvested parcel (the TKGM harvest is quota-bound and still growing):
    // judged as free units so pruning is seen everywhere, owner matched once the parcel arrives.
    const gardenFeatures = gardens.map((g) => feature(g.geometry));
    const gardensUnion = gardenFeatures.length === 0 ? null : gardenFeatures.length === 1 ? gardenFeatures[0]! : (union(featureCollection(gardenFeatures)) as Feature<Poly> | null);
    const freePatches: Array<{ id: string; geometry: Poly; areaM2: number }> = [];
    for (const tp of teaPatches.features) {
        const rest = gardensUnion ? difference(featureCollection([feature(tp.geometry), gardensUnion])) : feature(tp.geometry);
        if (!rest) continue;
        const parts: Polygon[] = rest.geometry.type === 'Polygon' ? [rest.geometry] : rest.geometry.coordinates.map((c) => ({ type: 'Polygon', coordinates: c }));
        for (const part of parts) {
            const m2 = turfArea(feature(part));
            if (m2 >= DECISION_POLICY.minUnassignedM2) freePatches.push({ id: `free-${String(freePatches.length + 1).padStart(3, '0')}`, geometry: part, areaM2: Math.round(m2) });
        }
    }
    const summaryFile = join(store.dir, 'summary.json');
    const parcelCoverage = existsSync(summaryFile) ? ((JSON.parse(readFileSync(summaryFile, 'utf8')) as { coveredRatio?: number }).coveredRatio ?? 0) : 0;
    const units = [
        ...gardens.map((g) => ({ id: g.id, geometry: g.geometry })),
        ...[...patches.entries()].map(([id, p]) => ({ id: `${id}#patch`, geometry: p.geometry })),
        ...freePatches.map((p) => ({ id: p.id, geometry: p.geometry })),
    ];
    console.log(`Sezon ${windows.season}: ${gardens.length} bahçe (+${patches.size} optik değişim yaması, +${freePatches.length} parselsiz çaylık ${Math.round(freePatches.reduce((s, p) => s + p.areaM2, 0) / 1000)} da), ${producers.length} müstahsil, tarama her ${every} gün; parsel kapsaması %${Math.round(parcelCoverage * 100)}`);

    // September (full canopy after the last harvest) to mid-July: the early-summer observations
    // settle whether a winter step was a deep pruning (canopy still missing) or a light trim.
    const window: [string, string] = [`${year}-09-01`, `${year + 1}-07-15`];
    const outDir = join(store.dir, 'pruning-fusion');
    // Field calibration (calibrate-fusion --apply): the labelled thresholds replace the synthetic ones.
    const calibrationPath = join(outDir, 'calibration.json');
    let calibration: FusionSeasonFile['calibration'] = null;
    if (existsSync(calibrationPath)) {
        const cal = JSON.parse(readFileSync(calibrationPath, 'utf8')) as { applied?: boolean; season: string; labels: number; positives: number; negatives: number; recall: number | null; falseAlarmRate: number | null; suggested: { zPruned: number; zLikely: number } | null; computedAt: string };
        if (cal.applied && cal.suggested && cal.season === windows.season) {
            Object.assign(FUSION_RULES, { zPruned: cal.suggested.zPruned, zLikely: cal.suggested.zLikely });
            calibration = { labels: cal.labels, positives: cal.positives, negatives: cal.negatives, recall: cal.recall, falseAlarmRate: cal.falseAlarmRate, zPruned: cal.suggested.zPruned, zLikely: cal.suggested.zLikely, computedAt: cal.computedAt };
            console.log(`Kalibrasyon uygulandı: budandı z ≥ ${cal.suggested.zPruned}, olası z ≥ ${cal.suggested.zLikely} (${cal.labels} saha etiketi)`);
        }
    }
    mkdirSync(outDir, { recursive: true });

    // Raw sensor series are cached: the model is re-run often, the satellite fetch is not.
    interface RawSeries {
        version: 2;
        window?: [string, string];
        /** Orbit passes already fetched for this window (a pass can legitimately be absent from `backscatter`). */
        fetchedPasses?: OrbitPass[];
        optical: OpticalSeries;
        backscatter: Array<{ pass: OrbitPass; relativeOrbit: number; dates: string[]; processing: string; vh: Record<string, Array<number | null>>; vv: Record<string, Array<number | null>> }>;
    }
    const cachePath = join(outDir, `series-${windows.season}.json`);
    const allPasses: OrbitPass[] = ['ASCENDING', 'DESCENDING'];
    let raw: RawSeries | null = null;
    let partial: RawSeries | null = null;
    if (existsSync(cachePath) && !values.refetch) {
        const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as Partial<RawSeries>;
        const sameWindow = cached.window?.[0] === window[0] && cached.window?.[1] === window[1];
        if (cached.version === 2 && cached.optical?.version === 2 && sameWindow) {
            // Caches written before the per-pass bookkeeping existed are complete.
            const fetched = cached.fetchedPasses ?? allPasses;
            if (allPasses.every((p) => fetched.includes(p))) {
                raw = cached as RawSeries;
                console.log(`Sensör serileri önbellekten: ${cachePath}`);
            } else {
                partial = cached as RawSeries;
                console.log(`Önbellek kısmi (optik${fetched.length ? ' + ' + fetched.join(', ') : ''}): eksik Sentinel-1 yörüngeleri çekiliyor`);
            }
        } else if (cached.version === 2 && cached.optical?.version === 2) console.log(`Önbellek penceresi farklı (${cached.window?.join(' → ') ?? 'yok'} ≠ ${window.join(' → ')}): sensör serileri yeniden çekiliyor`);
        else console.log('Önbellek eski biçimde (v1): sensör serileri yeniden çekiliyor');
    }
    let eeSession: EE | null = null;
    const ensureEe = async () => (eeSession ??= await initEarthEngine());
    const teaMaskOf = (ee: EE) => ee.Image(0).byte().paint(ee.FeatureCollection(teaPatches.features.map((f) => ee.Feature(ee.Geometry(f.geometry)))), 1).eq(1);
    /** Earth Engine capacity errors are often transient: a fetch is retried after a pause before giving up. */
    const withRetries = async <T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> => {
        for (let attempt = 1; ; attempt++) {
            try {
                return await fn();
            } catch (error) {
                if (!isCapacityError(error) || attempt >= attempts) throw error;
                console.log(`  ${label}: Earth Engine kapasite sınırı (${attempt}/${attempts}), 30 s sonra yeniden`);
                await new Promise((resolve) => setTimeout(resolve, 30_000));
            }
        }
    };
    if (!raw) {
        const ee = await ensureEe();
        const region = ee.Geometry(meta.boundary);
        const teaMask = teaMaskOf(ee);
        let optical: OpticalSeries;
        let backscatter: RawSeries['backscatter'];
        const fetchedPasses = new Set<OrbitPass>(partial?.fetchedPasses ?? []);
        // Every fetched piece is cached at once: a capacity error on a later pass must not cost the optical series.
        const persist = () => {
            const snapshot: RawSeries = { version: 2, window, fetchedPasses: [...fetchedPasses], optical, backscatter };
            writeFileSync(cachePath, JSON.stringify(snapshot));
        };
        if (partial) {
            optical = partial.optical;
            backscatter = partial.backscatter;
        } else {
            console.log('Sentinel-2 + Landsat 8/9 NDVI/NBR/NDRE/NDII serileri…');
            optical = await withRetries('optik', () => opticalSeries(ee, region, teaMask, units, window));
            const counts = optical.sensors.reduce<Record<string, number>>((h, s) => ((h[s] = (h[s] ?? 0) + 1), h), {});
            console.log(`  ${optical.dates.length} tarih (${optical.dates[0]} → ${optical.dates.at(-1)}): ${JSON.stringify(counts)}`);
            backscatter = [];
            persist();
        }
        for (const pass of allPasses) {
            if (fetchedPasses.has(pass)) continue;
            console.log(`Sentinel-1 ${pass} (γ0 arazi düzleştirme)…`);
            const s = await withRetries(pass, () => backscatterSeries(ee, region, units, window, pass));
            if (s) {
                backscatter.push({
                    pass,
                    relativeOrbit: s.relativeOrbit,
                    dates: s.dates,
                    processing: s.processing,
                    vh: Object.fromEntries(Object.entries(s.gardens).map(([id, g]) => [id, g.vh])),
                    vv: Object.fromEntries(Object.entries(s.gardens).map(([id, g]) => [id, g.vv])),
                });
                console.log(`  yörünge ${s.relativeOrbit}: ${s.dates.length} tarih`);
            } else console.log(`  ${pass}: pencerede uygun yörünge yok`);
            fetchedPasses.add(pass);
            persist();
        }
        raw = { version: 2, window, fetchedPasses: [...fetchedPasses], optical, backscatter };
    }
    const { optical, backscatter } = raw;
    // Date screening on the gardens' RAW NDVI: a date whose neighbourhood median collapses (snow,
    // frost, terrain shadow) or that covers few gardens is dropped for every unit and channel.
    const quality = dateQuality(optical.dates, Object.fromEntries(gardens.map((g) => [g.id, optical.gardens[g.id]?.ndvi ?? []])), optical.sensors);
    const excludedDates = quality.filter((q) => !q.ok);
    console.log(`Optik tarih eleme: ${excludedDates.length}/${quality.length} tarih dışlandı (${excludedDates.filter((q) => q.reason === 'snow_or_shadow').length} kar/gölge çöküşü, ${excludedDates.filter((q) => q.reason === 'sparse').length} seyrek kapsama)${excludedDates.length ? ': ' + excludedDates.map((q) => `${q.date} ${q.sensor ?? ''} (ortanca ${q.medianNdvi ?? '—'}, kapsama %${Math.round(q.coverage * 100)})`).join(', ') : ''}`);
    // Coherence: the HyP3 burst product when present, else the local SNAP product.
    const cohCandidates = [join(store.dir, 'pruning-radar', `coherence-hyp3-${windows.season}.json`), join(store.dir, 'pruning-radar', `coherence-${windows.season}.json`)];
    const cohPath = cohCandidates.find((p) => existsSync(p));
    const coherence = cohPath ? (JSON.parse(readFileSync(cohPath, 'utf8')) as CoherenceFile) : null;
    console.log(coherence ? `Koherans (${coherence.source ?? 'snap'}): ${coherence.passes.map((p) => `${p.pass} ${p.pairs.length} çift`).join(', ')}` : 'Koherans dosyası yok');

    // Prior-season context: the unit's own earlier winter tells its habitual noise and whether it
    // dips transiently (shade / snow pocket). Cached per season; fetched once when missing.
    const prevWindows = pruningWindows(year - 1);
    const baselinePath = join(outDir, `baseline-${prevWindows.season}.json`);
    let baseline: OpticalSeries | null = null;
    if (!values['no-baseline']) {
        if (existsSync(baselinePath)) baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as OpticalSeries;
        else {
            const prevCache = join(outDir, `series-${prevWindows.season}.json`);
            const prev = existsSync(prevCache) ? (JSON.parse(readFileSync(prevCache, 'utf8')) as Partial<RawSeries>) : null;
            if (prev?.optical?.version === 2) baseline = prev.optical;
            else {
                const ee = await ensureEe();
                console.log(`Önceki sezon (${prevWindows.season}) optik serisi (baz çizgisi)…`);
                baseline = await opticalSeries(ee, ee.Geometry(meta.boundary), teaMaskOf(ee), units, [`${year - 1}-09-01`, `${year}-05-15`], 0.5, false);
                writeFileSync(baselinePath, JSON.stringify(baseline));
            }
        }
        if (baseline) console.log(`Baz çizgisi ${prevWindows.season}: ${baseline.dates.length} optik tarih`);
    }

    // Neighbourhood-relative channels. The date medians come from the gardens alone (patches are
    // subsets of them); patch units are then expressed against the same medians.
    const gardenIds = new Set(gardens.map((g) => g.id));
    const relativeAll = (byUnit: Record<string, Array<number | null>>, decimals: number) => {
        const gardensOnly = Object.fromEntries(Object.entries(byUnit).filter(([id]) => gardenIds.has(id)));
        const rel = relativeToNeighbourhood(gardensOnly, decimals);
        // Recover the medians from one garden's raw − relative, then apply to the patch units.
        const n = Math.max(0, ...Object.values(byUnit).map((v) => v.length));
        const med: Array<number | null> = [];
        for (let i = 0; i < n; i++) {
            const id = Object.keys(gardensOnly).find((k) => gardensOnly[k]![i] !== null && gardensOnly[k]![i] !== undefined && rel[k]![i] !== null);
            med.push(id ? (gardensOnly[id]![i] as number) - (rel[id]![i] as number) : null);
        }
        const f = 10 ** decimals;
        for (const [id, values] of Object.entries(byUnit)) {
            if (gardenIds.has(id)) continue;
            rel[id] = values.map((v, i) => (v === null || v === undefined || med[i] === null ? null : Math.round((v - (med[i] as number)) * f) / f));
        }
        return rel;
    };
    const unitIds = units.map((u) => u.id);
    const relIndex = (key: 'ndvi' | 'nbr' | 'ndre' | 'ndii', src: OpticalSeries, q: DateQuality[]) => relativeAll(applyDateQuality(Object.fromEntries(unitIds.map((id) => [id, src.gardens[id]?.[key] ?? []])), q), 3);
    const relNdvi = relIndex('ndvi', optical, quality);
    const relNbr = relIndex('nbr', optical, quality);
    const relNdre = relIndex('ndre', optical, quality);
    const relNdii = relIndex('ndii', optical, quality);
    // Raw NDVI (screened) rides along on the NDVI channel for the absolute-level and recovery guards.
    const rawNdvi = applyDateQuality(Object.fromEntries(unitIds.map((id) => [id, optical.gardens[id]?.ndvi ?? []])), quality);
    // VH and the VH/VV ratio (dB difference), both neighbourhood-relative per orbit.
    const relVh = backscatter.map((b) => ({
        ...b,
        rel: relativeAll(b.vh, 2),
        relRatio: relativeAll(Object.fromEntries(Object.entries(b.vh).map(([id, vh]) => [id, vh.map((v, i) => (v === null || b.vv[id]?.[i] === null || b.vv[id]?.[i] === undefined ? null : Math.round((v - (b.vv[id]![i] as number)) * 100) / 100))])), 2),
    }));
    const relCoh = (coherence?.passes ?? []).map((p) => ({
        pass: p.pass,
        dates: p.pairs.map(([, d2]) => d2),
        rel: relativeToNeighbourhood(Object.fromEntries(gardens.map((g) => [g.id, coherence!.gardens[g.id]?.[p.pass] ?? []]))),
    }));
    const channel = (key: ChannelKey, dates: string[], valuesOf: Array<number | null>, raw?: Array<number | null>): ChannelSeries => ({ key, dates, values: valuesOf, ...CHANNEL_DEFAULTS[key], ...(raw ? { raw } : {}) });
    const seriesOf = (id: string): ChannelSeries[] => {
        const out: ChannelSeries[] = [
            channel('ndvi', optical.dates, relNdvi[id] ?? [], rawNdvi[id]),
            channel('nbr', optical.dates, relNbr[id] ?? []),
            channel('ndre', optical.dates, relNdre[id] ?? []),
            channel('ndii', optical.dates, relNdii[id] ?? []),
        ];
        for (const b of relVh) {
            out.push(channel(b.pass === 'ASCENDING' ? 'vh_asc' : 'vh_desc', b.dates, b.rel[id] ?? []));
            out.push(channel(b.pass === 'ASCENDING' ? 'ratio_asc' : 'ratio_desc', b.dates, b.relRatio[id] ?? []));
        }
        for (const c of relCoh) out.push(channel(c.pass === 'ASCENDING' ? 'coh_asc' : 'coh_desc', c.dates, c.rel[id] ?? []));
        return out.filter((s) => s.values.some((v) => v !== null));
    };
    // Prior-season context per unit (gardens and their patches share the garden's context).
    const contexts = new Map<string, UnitContext>();
    if (baseline) {
        const baselineQuality = dateQuality(baseline.dates, Object.fromEntries(gardens.map((g) => [g.id, baseline!.gardens[g.id]?.ndvi ?? []])), baseline.sensors);
        const prevNdvi = relIndex('ndvi', baseline, baselineQuality);
        const prevNbr = relIndex('nbr', baseline, baselineQuality);
        for (const id of unitIds) contexts.set(id, priorContext(baseline.dates, prevNdvi[id] ?? [], prevNbr[id] ?? []));
    }
    const contextOf = (id: string): UnitContext => contexts.get(id) ?? contexts.get(id.replace(/#patch$/, '')) ?? {};

    // Emulated scans run from the first possible call to the end of the fetched series: the summer
    // observations settle the recovery test, so the season verdict is taken with them in view.
    const scanFrom = `${year}-10-15`;
    const scanTo = window[1];
    // Earlier seasons of the cycle: their pruned / likely units are the ground that must not be
    // credited again (ÇAYKUR's 1/7 rotates over seven seasons).
    const previousUnits = new Map<string, Array<{ season: string; geometry: Poly; class: FusionClass }>>();
    for (let y = year - DECISION_POLICY.cycleSeasons + 1; y < year; y++) {
        const prevSeason = pruningWindows(y).season;
        const prevPath = join(outDir, `season-${prevSeason}.json`);
        if (!existsSync(prevPath)) continue;
        const prev = JSON.parse(readFileSync(prevPath, 'utf8')) as { gardens: Array<{ id: string; unitGeometry?: Poly; verdict: { class: FusionClass } }> };
        let n = 0;
        for (const pg of prev.gardens) {
            if (!pg.unitGeometry || (pg.verdict.class !== 'pruned' && pg.verdict.class !== 'likely')) continue;
            previousUnits.set(pg.id, [...(previousUnits.get(pg.id) ?? []), { season: prevSeason, geometry: pg.unitGeometry, class: pg.verdict.class }]);
            n++;
        }
        console.log(`Önceki sezon ${prevSeason}: ${n} budanmış/olası birim (tekrar budama kontrolü)`);
    }
    const overlapM2 = (a: Poly, b: Poly): number => {
        const hit = intersect(featureCollection([feature(a), feature(b)]));
        return hit ? turfArea(hit) : 0;
    };

    console.log('Bahçeler değerlendiriliyor…');
    const rank: Record<FusionClass, number> = { pruned: 4, likely: 3, unclear: 2, not_pruned: 1, no_data: 0 };
    type Candidate = { unit: 'garden' | 'patch'; series: ChannelSeries[]; areaM2: number; geometry: Poly; verdict: FusionVerdict };
    const judgedGardens = gardens.map((g) => {
        // Garden as a whole, and — when the optical scan drew a change patch — that patch alone.
        const unitsOf: Array<Omit<Candidate, 'verdict'>> = [{ unit: 'garden', series: seriesOf(g.id), areaM2: g.areaM2, geometry: g.geometry }];
        const patch = patches.get(g.id);
        if (patch) unitsOf.push({ unit: 'patch', series: seriesOf(`${g.id}#patch`), areaM2: patch.areaM2, geometry: patch.geometry });
        const ctx = contextOf(g.id);
        const judged: Candidate[] = unitsOf.map((c) => ({ ...c, verdict: judge(c.series, scanTo, ctx) }));
        return { g, ctx, judged };
    });
    // Population calibration. Never more than a seventh of the tea is cut in a season, so the
    // garden-unit optical z of the whole neighbourhood is dominated by unpruned gardens: its robust
    // centre and spread are the empirical null of the max-over-dates statistic (autocorrelation,
    // mixed sensors and the date search inflate it beyond N(0,1)). A "pruned" verdict must also
    // stand FUSION_RULES.populationZPruned robust σ above that bulk; the scale never drops below
    // the nominal 1 so a very quiet neighbourhood does not manufacture outliers.
    const bulk = judgedGardens.map((j) => j.judged.find((c) => c.unit === 'garden')?.verdict.groups.find((x) => x.group === 'optical')?.z).filter((v): v is number => v !== null && v !== undefined).sort((a, b) => a - b);
    const quantile = (xs: number[], q: number) => xs[Math.min(xs.length - 1, Math.max(0, Math.round(q * (xs.length - 1))))]!;
    const populationNull = bulk.length >= 20 ? { centre: Math.round(quantile(bulk, 0.5) * 1000) / 1000, scale: Math.round(Math.max(1, (quantile(bulk, 0.75) - quantile(bulk, 0.25)) / 1.349) * 1000) / 1000, n: bulk.length } : null;
    const downgraded = new WeakSet<FusionVerdict>();
    const resolved = new WeakSet<FusionVerdict>();
    const calibrate = (v: FusionVerdict): FusionVerdict => {
        const optZ = v.groups.find((x) => x.group === 'optical')?.z ?? null;
        if (!populationNull || optZ === null) return v;
        const populationZ = Math.round(((optZ - populationNull.centre) / populationNull.scale) * 1000) / 1000;
        const out: FusionVerdict = { ...v, populationZ };
        const weak = out.z !== null && out.z < FUSION_RULES.zLikely && out.shape?.gradual !== true;
        if (out.class === 'pruned' && populationZ < FUSION_RULES.populationZPruned) {
            out.class = 'likely';
            out.kind = 'population';
            out.review = true;
            out.reason += ` · mahalle geneline göre yeterince ayrışmıyor (toplum z ${populationZ.toFixed(1)} < ${FUSION_RULES.populationZPruned}), eksper incelemeli`;
            downgraded.add(out);
        } else if (out.class === 'likely' && populationZ < FUSION_RULES.populationZLikely) {
            out.class = 'unclear';
            out.kind = 'population';
            out.reason += ` · mahalle geneline göre ayrışmıyor (toplum z ${populationZ.toFixed(1)} < ${FUSION_RULES.populationZLikely})`;
            downgraded.add(out);
        } else if (out.class === 'unclear' && weak && (populationZ < FUSION_RULES.populationZLikely || out.recovery?.ok === false)) {
            // The bulk of the neighbourhood IS the null: a weak signal inside it is no signal; and a
            // weak signal whose summer canopy is level with the neighbours has nothing to show either.
            out.class = 'not_pruned';
            out.kind = 'bulk';
            out.review = false;
            out.reason = populationZ < FUSION_RULES.populationZLikely
                ? `Mahalle geneliyle aynı davranış (toplum z ${populationZ.toFixed(1)}; zayıf sinyal z ${(out.z ?? 0).toFixed(1)}): kalıcı örtü kaybı yok`
                : `Zayıf sinyal (z ${(out.z ?? 0).toFixed(1)}) ve yaz başında örtü komşularıyla aynı düzeyde: kalıcı örtü kaybı yok`;
            resolved.add(out);
        }
        return out;
    };
    if (populationNull) console.log(`Toplum kalibrasyonu: bahçe birimi optik z ortancası ${populationNull.centre}, sağlam ölçek ${populationNull.scale} (${populationNull.n} bahçe)`);
    let populationDowngraded = 0;
    let populationResolved = 0;
    const outGardens: FusionGarden[] = judgedGardens.map(({ g, ctx, judged }) => {
        const best = judged.map((c) => ({ ...c, verdict: calibrate(c.verdict) })).sort((a, b) => rank[b.verdict.class] - rank[a.verdict.class] || (b.verdict.z ?? 0) - (a.verdict.z ?? 0))[0]!;
        if (downgraded.has(best.verdict)) populationDowngraded++;
        if (resolved.has(best.verdict)) populationResolved++;
        const timeline = scanTimeline(best.series, scanFrom, scanTo, every, ctx);
        // A scan may call a garden "pruned" and later data may withdraw it: the dates reported
        // are the first scans that reached the verdict the full season finally supports.
        const finalPruned = best.verdict.class === 'pruned';
        const finalLikely = finalPruned || best.verdict.class === 'likely';
        // Repeat check against the cycle's earlier pruned ground in this garden.
        let repeat: FusionGarden['repeat'] = null;
        if (finalLikely) {
            const earlier = previousUnits.get(g.id) ?? [];
            const evidence = earlier.map((e) => ({ season: e.season, overlapM2: Math.round(overlapM2(best.geometry, e.geometry)), class: e.class })).filter((e) => e.overlapM2 >= 20);
            const reusedM2 = Math.min(best.areaM2, evidence.reduce((s, e) => s + e.overlapM2, 0));
            repeat = { reusedM2: Math.round(reusedM2), reusedShare: best.areaM2 > 0 ? Math.round((reusedM2 / best.areaM2) * 1000) / 1000 : 0, countedM2: Math.round(best.areaM2 - reusedM2), evidence };
        }
        return {
            id: g.id,
            producerId: g.producerId,
            parcelKey: g.parcelKey,
            areaM2: g.areaM2,
            licensedAreaM2: g.licensedAreaM2,
            unit: best.unit,
            unitAreaM2: Math.round(best.areaM2),
            unitGeometry: best.geometry,
            repeat,
            verdict: best.verdict,
            detectedAt: finalPruned ? timeline.detectedAt : null,
            likelyAt: finalLikely ? timeline.likelyAt : null,
            scans: timeline.scans,
            series: best.series.map((s) => ({ key: s.key, dates: s.dates, values: s.values })),
            context: ctx,
        };
    });
    const counts = outGardens.reduce<Record<string, number>>((h, g) => ((h[g.verdict.class] = (h[g.verdict.class] ?? 0) + 1), h), {});
    console.log(`Bahçe kararları: ${JSON.stringify(counts)}`);
    const medianOf = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : null);
    const obsHist: Record<string, number> = {};
    for (const g of outGardens) {
        const n = g.verdict.observability.opticalObs;
        const bin = n < 8 ? '<8' : n < 16 ? '8–15' : n < 24 ? '16–23' : '≥24';
        obsHist[bin] = (obsHist[bin] ?? 0) + 1;
    }
    const prunedGardens = outGardens.filter((g) => g.verdict.class === 'pruned');
    // Gardens whose optical group alone clears the "likely" bar: the physical guards are reported over these.
    const strong = outGardens.filter((g) => (g.verdict.groups.find((x) => x.group === 'optical')?.z ?? 0) >= FUSION_RULES.zLikely);
    const summary: FusionSummary = {
        byClass: { pruned: counts.pruned ?? 0, likely: counts.likely ?? 0, unclear: counts.unclear ?? 0, not_pruned: counts.not_pruned ?? 0, no_data: counts.no_data ?? 0 },
        review: outGardens.filter((g) => g.verdict.review).length,
        shadeProne: outGardens.filter((g) => g.verdict.shadeProne).length,
        underObserved: outGardens.filter((g) => g.verdict.observability.underObserved).length,
        opticalObsHistogram: obsHist,
        medianOpticalObs: medianOf(outGardens.map((g) => g.verdict.observability.opticalObs)),
        medianOpticalGapDays: medianOf(outGardens.map((g) => g.verdict.observability.opticalGapDays).filter((v): v is number => v !== null)),
        prunedBy: {
            opticalOnly: prunedGardens.filter((g) => !g.verdict.backscatterOk && !g.verdict.coherenceOk).length,
            opticalWithRadar: prunedGardens.filter((g) => g.verdict.opticalOk && (g.verdict.backscatterOk || g.verdict.coherenceOk) && !(g.verdict.z !== null && g.verdict.z >= FUSION_RULES.zPruned && g.verdict.backscatterOk)).length,
            joint: prunedGardens.filter((g) => g.verdict.opticalOk && g.verdict.backscatterOk && g.verdict.z !== null && g.verdict.z >= FUSION_RULES.zPruned).length,
        },
        radarRequiredShare: outGardens.length ? Math.round((outGardens.filter((g) => g.verdict.radarRequired).length / outGardens.length) * 1000) / 1000 : 0,
        sensorsUsed: [...new Set([...(optical.sensors ?? []), ...backscatter.map(() => 'S1'), ...(coherence ? [`coh-${coherence.source ?? 'snap'}`] : [])])],
        excludedDates: excludedDates.length,
        populationNull,
        populationDowngraded,
        populationResolved,
        strongSignals: strong.length,
        kinds: outGardens.reduce<Record<string, number>>((h, g) => ((h[g.verdict.kind ?? 'none'] = (h[g.verdict.kind ?? 'none'] ?? 0) + 1), h), {}),
        gradual: strong.filter((g) => g.verdict.shape?.gradual).length,
        levelFailed: strong.filter((g) => g.verdict.levels?.ok === false).length,
        recoveryConfirmed: strong.filter((g) => g.verdict.recovery?.ok === true).length,
        recoveryFailed: strong.filter((g) => g.verdict.recovery?.ok === false).length,
        recoveryUntested: strong.filter((g) => !g.verdict.recovery || g.verdict.recovery.ok === null).length,
        outsideCalendar: outGardens.filter((g) => g.verdict.inCalendar === false && (g.verdict.class === 'pruned' || g.verdict.class === 'likely')).length,
    };
    console.log(`Karar türleri: ${JSON.stringify(summary.kinds)}`);
    console.log(`Fiziksel kontroller (güçlü optik sinyalli ${summary.strongSignals} bahçede): kademeli kayıp ${summary.gradual}, ham NDVI düşmeyen ${summary.levelFailed}, yaz toparlanma testi ✓ ${summary.recoveryConfirmed} / ✗ ${summary.recoveryFailed} / test edilemedi ${summary.recoveryUntested}; takvim dışı ${summary.outsideCalendar}; toplum kalibrasyonu: ${summary.populationDowngraded} karar indirildi, ${summary.populationResolved} zayıf sinyal "budama yok" oldu`);
    console.log(`Gözlenebilirlik: optik gözlem ortancası ${summary.medianOpticalObs}, boşluk ortancası ${summary.medianOpticalGapDays} gün, az gözlenen ${summary.underObserved}, gölgeye yatkın ${summary.shadeProne}; incelensin ${summary.review}; kesin kararlar ${JSON.stringify(summary.prunedBy)}`);

    // Free tea patches outside the harvested parcels.
    const outUnassigned: FusionUnassigned[] = freePatches.map((p) => {
        const series = seriesOf(p.id);
        const ctx = contextOf(p.id);
        const verdict = calibrate(judge(series, scanTo, ctx));
        const timeline = scanTimeline(series, scanFrom, scanTo, every, ctx);
        return { id: p.id, areaM2: p.areaM2, geometry: p.geometry, verdict, detectedAt: verdict.class === 'pruned' ? timeline.detectedAt : null, likelyAt: verdict.class === 'pruned' || verdict.class === 'likely' ? timeline.likelyAt : null };
    });
    const uCounts = outUnassigned.reduce<Record<string, number>>((h, u) => ((h[u.verdict.class] = (h[u.verdict.class] ?? 0) + 1), h), {});
    console.log(`Parselsiz çaylık kararları: ${JSON.stringify(uCounts)}`);

    // Producer: pruned area against the 1/7 of the licensed area, then the purchase decision.
    const gardenById = new Map(outGardens.map((g) => [g.id, g]));
    const outProducers: FusionProducer[] = producers.map((p) => {
        const own = p.gardenIds.map((id) => gardenById.get(id)).filter((g): g is FusionGarden => !!g);
        const licensed = own.reduce((s, g) => s + (g.licensedAreaM2 ?? 0), 0);
        const required = licensed / pruningRatio;
        const pruned = own.filter((g) => g.verdict.class === 'pruned');
        const likely = own.filter((g) => g.verdict.class === 'likely');
        // The pruned area is the unit that carried the verdict (the patch when only part was cut);
        // what counts toward the 1/7 is that area minus the ground already credited in the cycle.
        const prunedArea = pruned.reduce((s, g) => s + g.unitAreaM2, 0);
        const likelyArea = likely.reduce((s, g) => s + g.unitAreaM2, 0);
        const credited = DECISION_POLICY.likelyCounts ? [...pruned, ...likely] : pruned;
        const reused = credited.reduce((s, g) => s + (g.repeat?.reusedM2 ?? 0), 0);
        const counted = credited.reduce((s, g) => s + (g.repeat?.countedM2 ?? g.unitAreaM2), 0);
        const shortfall = Math.max(0, required - counted);
        let status: ProducerFusionStatus;
        if (licensed <= 0) status = 'no_license';
        else if (credited.length && counted >= required) status = 'pruned_full';
        else if (pruned.length || likely.length) status = 'pruned_partial';
        else if (own.every((g) => g.verdict.class === 'no_data')) status = 'no_data';
        // Only an 'unclear' the model itself flags for review keeps the file open; a recovered winter dip or a
        // weak signal is settled ground (no deep pruning), not an open question.
        else if (own.some((g) => g.verdict.class === 'unclear' && g.verdict.review)) status = 'unclear';
        else status = 'none';
        const detected = pruned.map((g) => g.detectedAt).filter((d): d is string => !!d).sort();

        // Anomalies: blocking ones go to an expert; the rest are notes next to the automatic decision.
        const anomalies = new Set<FusionAnomaly>();
        for (const g of [...pruned, ...likely]) {
            const reg = byCode.get(g.id);
            const opt = g.verdict.groups.find((x) => x.group === 'optical');
            const rad = g.verdict.groups.find((x) => x.group === 'backscatter');
            if (opt?.z !== null && opt?.z !== undefined && rad?.z !== null && rad?.z !== undefined && ((opt.z >= 2.8 && rad.z <= -1.5) || (rad.z >= 2.8 && opt.z <= -1.5))) anomalies.add('sensors_contradict');
            if ((g.repeat?.reusedShare ?? 0) >= DECISION_POLICY.repeatShare) anomalies.add('repeat_pruning');
            if (reg?.approvalStatus === 'boundary_conflict') anomalies.add('boundary_conflict');
            if (reg?.approvalStatus === 'unresolved') anomalies.add('boundary_unresolved');
            if (reg?.discrepancies.some((d) => d === 'no_tea' || d === 'area_over')) anomalies.add('license_mismatch');
            if (licensed <= 0 || reg?.discrepancies.includes('no_license') || reg?.discrepancies.includes('lineage_unresolved')) anomalies.add('unlicensed_pruning');
        }
        // Only CONFIRMED area can raise the over-pruning flag: a whole-garden "likely" unit overstates the cut.
        if (required > 0 && prunedArea >= DECISION_POLICY.overPrunedRatio * required) anomalies.add('over_pruned');

        const blocking = [...anomalies].filter((a) => DECISION_POLICY.blocking.includes(a));
        let decision: FusionDecision;
        let decisionReason: string;
        if (licensed <= 0) {
            decision = pruned.length || likely.length ? 'expert_anomaly' : 'no_license';
            decisionReason = pruned.length || likely.length ? 'Ruhsatsız/eşleşmemiş alanda budama görüldü' : 'Ruhsatlı alan yok; 1/7 hesaplanamaz';
        } else if (blocking.length > 0) {
            decision = 'expert_anomaly';
            decisionReason = `Anomali: ${blocking.join(', ')}`;
        } else if (credited.length && counted >= required) {
            decision = 'auto_open';
            decisionReason = reused > 0
                ? `Yeni alan ${Math.round(counted)} m² (tekrar budanan ${Math.round(reused)} m² sayılmadı) 1/7 hedefini karşılıyor`
                : `${pruned.length ? 'Teyitli' : 'Olası'} budama ${Math.round(counted)} m² 1/7 hedefini (${Math.round(required)} m²) karşılıyor`;
        } else if (status === 'no_data') {
            decision = 'no_data';
            decisionReason = 'Bahçelerde yeterli gözlem yok';
        } else if (pruned.length || likely.length || own.some((g) => g.verdict.class === 'unclear' && g.verdict.review)) {
            decision = 'auto_pending';
            decisionReason = reused > 0
                ? `Tekrar budanan ${Math.round(reused)} m² sayılmadı; ${Math.round(shortfall)} m² daha budanmalı`
                : `Budama izi var, hedef henüz dolmadı; ${Math.round(shortfall)} m² daha budanmalı`;
        } else {
            decision = 'auto_none';
            decisionReason = own.some((g) => g.verdict.class === 'unclear') ? 'Bahçelerde derin budama görülmedi (hafif budama/kar hasarı ya da zayıf sinyal kalabilir)' : 'Bütün bahçeler iyi gözlendi, budama görülmedi';
        }
        return {
            id: p.id,
            licensedAreaM2: Math.round(licensed),
            requiredM2: Math.round(required),
            prunedAreaM2: Math.round(prunedArea),
            likelyAreaM2: Math.round(likelyArea),
            countedM2: Math.round(counted),
            reusedM2: Math.round(reused),
            shortfallM2: Math.round(shortfall),
            gardens: own.length,
            prunedGardens: pruned.map((g) => g.id),
            likelyGardens: likely.map((g) => g.id),
            status,
            firstDetectedAt: detected[0] ?? null,
            decision,
            anomalies: [...anomalies],
            decisionReason,
        };
    });
    const pCounts = outProducers.reduce<Record<string, number>>((h, p) => ((h[p.status] = (h[p.status] ?? 0) + 1), h), {});
    const dCounts = outProducers.reduce<Record<string, number>>((h, p) => ((h[p.decision] = (h[p.decision] ?? 0) + 1), h), {});
    console.log(`Müstahsil durumları: ${JSON.stringify(pCounts)}`);
    console.log(`Alım kararları: ${JSON.stringify(dCounts)}`);

    const out: FusionSeasonFile = {
        season: windows.season,
        rules: { ...FUSION_RULES, pruningRatio },
        channels: CHANNEL_DEFAULTS,
        everyDays: every,
        scanFrom,
        scanTo,
        sensors: {
            optical: { dates: optical.dates, sensors: optical.sensors, counts: optical.sensors.reduce<Record<string, number>>((h, s) => ((h[s] = (h[s] ?? 0) + 1), h), {}), excluded: excludedDates },
            backscatter: backscatter.map((b) => ({ pass: b.pass, relativeOrbit: b.relativeOrbit, dates: b.dates, processing: b.processing })),
            coherence: relCoh.map((c) => ({ pass: c.pass, dates: c.dates, source: coherence?.source ?? 'snap' })),
        },
        gardens: outGardens,
        producers: outProducers,
        unassigned: outUnassigned,
        parcelCoverage,
        policy: DECISION_POLICY,
        summary,
        baselineSeason: baseline ? prevWindows.season : null,
        calibration,
    };
    const outPath = join(outDir, `season-${windows.season}.json`);
    writeFileSync(outPath, JSON.stringify(out));
    console.log(`Çıktı: ${outPath}`);
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
