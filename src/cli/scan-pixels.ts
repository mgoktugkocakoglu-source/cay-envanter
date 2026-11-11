import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { area as turfArea, bbox as turfBbox, booleanPointInPolygon, centroid, feature, featureCollection, intersect } from '@turf/turf';
import { evaluate, initEarthEngine, isCapacityError } from '../ee/session.ts';
import { NeighborhoodStore } from '../library/store.ts';
import { buildDemoProducers, loadDemoLayout } from '../producers/demo-producers.ts';
import { currentGeometry, type LicensingRegistry } from '../licensing/registry.ts';
import { fromUtm, toUtm, utmZone } from '../geo/utm.ts';

type Poly = Polygon | MultiPolygon;
type EE = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const USAGE = `
Kullanım:
  npm run scan-pixels -- --province Trabzon --district Of --neighborhood Çataldere --season 2025 [--force]

Piksel taraması (ayrı modül; tarama / radar / çok-sensör kararlarına dokunmaz): mahalledeki her bahçenin üzerine
Sentinel-2'nin kendi 10 m piksel ağı serilir, her pikselin sezon boyu NDVI/NBR serisi çevresindeki bahçe
piksellerine göre okunur ve tarih verilmeden basamak aranır (çekirdek z ≥ 3, komşu büyütme z ≥ 2,5).
Sınır pikselleri (dışı çay değil) çekirdek olamaz; kümeler toparlanma hızına göre derin budama / hafif budama /
geçici düşüş olarak sınıflanır. Çıktı: pruning-pixels/season-<yyyy-yy>.json (ham seri önbelleği yanında).
`;

export const PIXEL_RULES = {
    beforeDays: 75,
    afterDays: 60,
    minBefore: 3,
    minAfter: 2,
    /** Relative NDVI step that marks a changed pixel; "strong" is a pruning-sized step. */
    drop: 0.05,
    dropStrong: 0.1,
    /** Two-tier threshold: a cluster is seeded at zCore and grown through neighbours at zGrow. */
    zCore: 3.0,
    zGrow: 2.5,
    /** Boundary pixels whose own cover is not tea never seed a cluster and join one only at this bar, with the SWIR index dropping too. */
    zEdge: 3.5,
    minClusterPixels: 2,
    lonePixelZ: 4.0,
    noiseFloor: 0.03,
    /** Date screening (fusion v2.1 rule): the neighbourhood median collapsing is snow / frost / terrain shadow. */
    collapseNdvi: 0.65,
    minDateCoverage: 0.3,
    /** A pixel with less than this share inside the garden mostly shows the neighbour: not judged for this garden. */
    minInsideShare: 0.3,
    edgeInsideShare: 0.9,
    teaShareMin: 0.75,
    referenceRadiusM: 300,
    referenceMinPixels: 30,
    /** Candidate change dates of a season (month-day). */
    scanFrom: '09-20',
    scanTo: '04-30',
    /** The pixel's own (raw) NDVI must fall too: neighbours greening up in spring lower the relative value without any cut. */
    rawDrop: 0.04,
    /** Pruned-pixel NDVI end member: field-calibrated on one case (136/12, Oct 2026) and the literature default as the low bound. */
    ndviPruned: 0.69,
    ndviPrunedDefault: 0.35,
    /** Recovery classes: back to 70 % within `transientDays` = weather/shadow artefact; still below in early summer = deep pruning. */
    recoveredShare: 0.7,
    transientDays: 25,
    lightDays: 120,
    persistDays: 60,
    summer: ['05-20', '07-15'] as [string, string],
    deepSummerRecovery: 0.6,
};

export type PixelKind = 'deep' | 'light' | 'transient' | 'pending';
export type PixelConfidence = 'high' | 'medium' | 'low';
export type PixelVerdict = 'deep' | 'light' | 'pending' | 'transient' | 'weak' | 'none' | 'no_data';

export interface PixelCluster {
    index: number;
    pixels: number;
    corePixels: number;
    edgePixels: number;
    areaM2: number;
    areaLowM2: number;
    areaUpperM2: number;
    centroid: [number, number];
    meanDelta: number;
    maxZ: number;
    nbrDelta: number | null;
    crossIndexOk: boolean;
    kind: PixelKind;
    depth: number | null;
    recoveryDays: number | null;
    summerRecovery: number | null;
    lastObsDays: number;
    confidence: PixelConfidence;
    note: string;
}

export interface PixelGarden {
    id: string;
    pixels: number;
    evaluatedPixels: number;
    verdict: PixelVerdict;
    fusionClass: string | null;
    fusionKind: string | null;
    best: { date: string; lastBefore: string | null; score: number } | null;
    candidates: Array<{ date: string; lastBefore: string | null; pixels: number; score: number }>;
    prunedM2: number;
    prunedLowM2: number;
    prunedUpperM2: number;
    mainCluster: number | null;
    clusters: PixelCluster[];
    /** [e, n, insideM2, delta, z, flag (0 none · 1 grown · 2 core), cluster (−1 none), edge (0/1)] per evaluated pixel. */
    px: Array<[number, number, number, number | null, number | null, number, number, number]>;
    /** Relative NDVI of the main cluster and of the garden's other pixels (present when a cluster exists). */
    series: { dates: string[]; cluster: Array<number | null>; rest: Array<number | null> } | null;
}

export interface PixelSeasonFile {
    season: string;
    generatedAt: string;
    method: string;
    rules: typeof PIXEL_RULES;
    epsg: string;
    window: [string, string];
    scan: { from: string; to: string; candidates: number };
    dates: number;
    excludedDates: string[];
    summary: {
        gardens: number;
        pixels: number;
        flaggedPixels: number;
        byVerdict: Record<PixelVerdict, number>;
        areaM2: { deep: number; light: number; pending: number };
        /** fusion class → pixel verdict → gardens. */
        vsFusion: Record<string, Partial<Record<PixelVerdict, number>>>;
        /** Gardens the garden-level verdict left at unclear / not pruned where the pixels show a counted cut. */
        newFinds: number;
    };
    gardens: PixelGarden[];
}

const DAY = 86_400_000;
const addDays = (date: string, days: number) => new Date(Date.parse(date) + days * DAY).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

function mean(xs: number[]): number | null {
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
function sd(xs: number[]): number | null {
    if (xs.length < 2) return null;
    const m = mean(xs) as number;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
function median(xs: number[]): number | null {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

interface Step {
    nBefore: number;
    nAfter: number;
    meanBefore: number | null;
    delta: number | null;
    z: number | null;
}

/** Before-mean vs after-mean step in units of the before-window noise (positive z = a drop). */
function stepTest(dates: string[], values: Array<number | null>, before: [string, string], after: [string, string], floor: number): Step {
    const b: number[] = [];
    const a: number[] = [];
    for (let i = 0; i < dates.length; i++) {
        const v = values[i];
        if (v === null || v === undefined) continue;
        const d = dates[i] as string;
        if (d >= before[0] && d < before[1]) b.push(v);
        else if (d >= after[0] && d < after[1]) a.push(v);
    }
    const mb = mean(b);
    const ma = mean(a);
    const noise = Math.max(floor, sd(b) ?? floor);
    const delta = mb !== null && ma !== null ? ma - mb : null;
    const z = delta !== null ? -delta / (noise * Math.sqrt(1 / b.length + 1 / a.length)) : null;
    return { nBefore: b.length, nAfter: a.length, meanBefore: mb, delta, z };
}

interface Cell {
    pix: number;
    e: number;
    n: number;
    insideM2: number;
    insideShare: number;
    edge: boolean;
}

// ── Sentinel-2: every unique pixel's season series, read on the sensor's own grid ──
function s2Clean(ee: EE, region: EE, from: string, to: string): EE {
    const cloudScore = ee.ImageCollection('GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED');
    return ee
        .ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
        .filterBounds(region)
        .filterDate(from, to)
        .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 80))
        .linkCollection(cloudScore, ['cs_cdf'])
        .map((image: EE) => {
            const scaled = image.select(['B3', 'B4', 'B8', 'B11', 'B12']).divide(10_000);
            const clear = image.select('cs_cdf').gte(0.6).and(scaled.normalizedDifference(['B3', 'B11']).lt(0.4)).and(image.select('SCL').neq(11));
            const img = scaled.normalizedDifference(['B8', 'B4']).rename('ndvi').addBands(scaled.normalizedDifference(['B8', 'B12']).rename('nbr')).updateMask(clear);
            return ee.Image(img.copyProperties(image, ['system:time_start']));
        });
}

interface RawSeries {
    epsg: string;
    window: [string, string];
    dates: string[];
    pixels: Array<[number, number]>;
    ndvi: Array<Array<number | null>>;
    nbr: Array<Array<number | null>>;
}

async function fetchSeries(ee: EE, region: EE, epsg: string, zone: number, pixels: Array<[number, number]>, from: string, to: string): Promise<RawSeries> {
    const col = s2Clean(ee, region, from, to);
    const stamps = await evaluate<number[]>(col.aggregate_array('system:time_start'));
    const dates = [...new Set(stamps.map((t) => new Date(t).toISOString().slice(0, 10)))].sort();
    console.log(`  ${dates.length} Sentinel-2 tarihi (${dates[0]} → ${dates.at(-1)}), ${pixels.length} piksel`);
    const ndvi = pixels.map(() => dates.map(() => null as number | null));
    const nbr = pixels.map(() => dates.map(() => null as number | null));
    const band = (d: string) => d.replaceAll('-', '');
    const FEATURES_PER_CHUNK = 2000;
    const run = async (first: number, chunk: string[]): Promise<void> => {
        const slice = pixels.slice(first, first + FEATURES_PER_CHUNK);
        const fc = ee.FeatureCollection(slice.map(([e, n], i) => ee.Feature(ee.Geometry.Point(fromUtm(e + 5, n + 5, zone)), { id: first + i })));
        const stack = ee.Image.cat(chunk.map((d) => col.filterDate(d, addDays(d, 1)).mosaic().select(['ndvi', 'nbr']).rename([`n_${band(d)}`, `b_${band(d)}`])));
        let rows: { features: Array<{ properties: Record<string, number | null> }> };
        try {
            rows = await evaluate(stack.reduceRegions({ collection: fc, reducer: ee.Reducer.first(), crs: epsg, crsTransform: [10, 0, 0, 0, -10, 0] }).map((f: EE) => f.setGeometry(null)));
        } catch (error) {
            if (!isCapacityError(error) || chunk.length === 1) throw error;
            const mid = Math.ceil(chunk.length / 2);
            await run(first, chunk.slice(0, mid));
            await run(first, chunk.slice(mid));
            return;
        }
        for (const { properties: p } of rows.features) {
            const idx = p.id as number;
            for (const d of chunk) {
                const t = dates.indexOf(d);
                const nv = p[`n_${band(d)}`];
                const bv = p[`b_${band(d)}`];
                (ndvi[idx] as Array<number | null>)[t] = typeof nv === 'number' ? r3(nv) : null;
                (nbr[idx] as Array<number | null>)[t] = typeof bv === 'number' ? r3(bv) : null;
            }
        }
    };
    const DATES_PER_CHUNK = 8;
    for (let first = 0; first < pixels.length; first += FEATURES_PER_CHUNK) {
        for (let i = 0; i < dates.length; i += DATES_PER_CHUNK) await run(first, dates.slice(i, i + DATES_PER_CHUNK));
        console.log(`  piksel ${Math.min(pixels.length, first + FEATURES_PER_CHUNK)} / ${pixels.length}`);
    }
    return { epsg, window: [from, to], dates, pixels, ndvi, nbr };
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: { province: { type: 'string' }, district: { type: 'string' }, neighborhood: { type: 'string' }, season: { type: 'string', default: '2025' }, force: { type: 'boolean', default: false } },
    });
    if (!values.province || !values.district || !values.neighborhood) {
        console.log(USAGE);
        process.exit(1);
    }
    const R = PIXEL_RULES;
    const store = new NeighborhoodStore(values.province, values.district, values.neighborhood);
    const meta = store.readMeta();
    if (!meta) throw new Error('meta.json yok; önce harvest çalıştırın.');
    const year = Number(values.season);
    const season = `${year}-${String(year + 1).slice(2)}`;
    const today = new Date().toISOString().slice(0, 10);
    const from = `${year}-07-01`;
    const to = [`${year + 1}-07-16`, addDays(today, 1)].sort()[0] as string;

    // Gardens exactly as the other pruning modules see them: the licensed tea sub-polygon, else the demo slice.
    const parcels = JSON.parse(readFileSync(join(store.dir, 'parcels-tea.geojson'), 'utf8')) as FeatureCollection<Poly, { key: string; block: string; parcel: string; teaAreaM2: number | null }>;
    const { gardens: slices } = buildDemoProducers(parcels.features.map((f) => ({ ...f.properties, geometry: f.geometry })), 2026, loadDemoLayout(store.dir));
    const registryPath = join(store.dir, 'licensing', 'registry.json');
    const registry = existsSync(registryPath) ? (JSON.parse(readFileSync(registryPath, 'utf8')) as LicensingRegistry) : null;
    const byCode = new Map(registry?.gardens.map((g) => [g.code, g]) ?? []);
    const gardens = slices.map((g) => ({ id: g.id, geometry: (byCode.get(g.id) ? currentGeometry(byCode.get(g.id)!) : g.geometry) as Poly }));
    const patches = (JSON.parse(readFileSync(join(store.dir, 'tea-patches.geojson'), 'utf8')) as FeatureCollection<Poly, { areaM2: number }>).features;
    const patchBoxes = patches.map((p) => turfBbox(p));

    // The sensor's lattice over every garden; a pixel shared by two gardens is fetched once.
    const centre = centroid(feature(meta.boundary as Poly)).geometry.coordinates as [number, number];
    const zone = utmZone(centre[0]);
    const epsg = `EPSG:326${zone}`;
    const pixelIndex = new Map<string, number>();
    const pixels: Array<[number, number]> = [];
    const gardenCells = new Map<string, Cell[]>();
    for (const g of gardens) {
        const gF = feature(g.geometry);
        const [w, s, e, n] = turfBbox(gF);
        const corners = [toUtm(s, w, zone), toUtm(s, e, zone), toUtm(n, w, zone), toUtm(n, e, zone)];
        const e0 = Math.floor(Math.min(...corners.map((c) => c.e)) / 10) * 10;
        const e1 = Math.ceil(Math.max(...corners.map((c) => c.e)) / 10) * 10;
        const n0 = Math.floor(Math.min(...corners.map((c) => c.n)) / 10) * 10;
        const n1 = Math.ceil(Math.max(...corners.map((c) => c.n)) / 10) * 10;
        const list: Cell[] = [];
        for (let ce = e0; ce < e1; ce += 10) {
            for (let cn = n0; cn < n1; cn += 10) {
                const square = feature({ type: 'Polygon', coordinates: [[fromUtm(ce, cn, zone), fromUtm(ce + 10, cn, zone), fromUtm(ce + 10, cn + 10, zone), fromUtm(ce, cn + 10, zone), fromUtm(ce, cn, zone)]] } as Polygon);
                const inside = intersect(featureCollection([square, gF]));
                if (!inside) continue;
                const insideM2 = turfArea(inside);
                const insideShare = Math.min(1, insideM2 / turfArea(square));
                if (insideShare < R.minInsideShare) continue;
                const key = `${ce}_${cn}`;
                let pix = pixelIndex.get(key);
                if (pix === undefined) {
                    pix = pixels.length;
                    pixelIndex.set(key, pix);
                    pixels.push([ce, cn]);
                }
                list.push({ pix, e: ce, n: cn, insideM2: Math.round(insideM2), insideShare: r3(insideShare), edge: false });
            }
        }
        gardenCells.set(g.id, list);
    }
    // Tea share of each unique pixel (detect-tea's cover): a boundary pixel that is not tea itself is shadow / mixed-cover prone.
    // detect-tea's cover is itself a 10 m classification, so the pixel centre decides (0 or 1); four inner points soften the edge.
    console.log(`  ${pixels.length} tekil piksel; çay örtüsü payı hesaplanıyor…`);
    const teaShare = pixels.map(([pe, pn]) => {
        const pts = [[2.5, 2.5], [7.5, 2.5], [2.5, 7.5], [7.5, 7.5]].map(([dx, dy]) => fromUtm(pe + (dx as number), pn + (dy as number), zone));
        let hits = 0;
        for (const pt of pts) {
            for (let i = 0; i < patches.length; i++) {
                const bb = patchBoxes[i] as number[];
                if (pt[0] < (bb[0] as number) || pt[0] > (bb[2] as number) || pt[1] < (bb[1] as number) || pt[1] > (bb[3] as number)) continue;
                if (booleanPointInPolygon(pt, (patches[i] as Feature<Poly>).geometry)) {
                    hits++;
                    break;
                }
            }
        }
        return hits / pts.length;
    });
    for (const list of gardenCells.values()) for (const c of list) c.edge = c.insideShare < R.edgeInsideShare && (teaShare[c.pix] as number) < R.teaShareMin;
    console.log(`Sezon ${season}: ${gardens.length} bahçe, ${pixels.length} tekil piksel (${[...gardenCells.values()].flat().filter((c) => c.edge).length} sınır / çay dışı)`);

    // Raw series: cached, so rule changes re-run without Earth Engine.
    const outDir = join(store.dir, 'pruning-pixels');
    mkdirSync(outDir, { recursive: true });
    const cachePath = join(outDir, `cache-${season}.json`);
    let raw: RawSeries | null = null;
    if (!values.force && existsSync(cachePath)) {
        const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as RawSeries;
        const same = cached.pixels.length === pixels.length && cached.pixels.every((p, i) => p[0] === (pixels[i] as [number, number])[0] && p[1] === (pixels[i] as [number, number])[1]) && cached.window[1] === to;
        if (same) raw = cached;
    }
    if (!raw) {
        const ee = await initEarthEngine();
        raw = await fetchSeries(ee, ee.Geometry(meta.boundary), epsg, zone, pixels, from, to);
        writeFileSync(cachePath, JSON.stringify(raw));
    } else console.log(`  önbellek kullanıldı: ${raw.dates.length} tarih`);
    const dates = raw.dates;

    // Date screening on the tea pixels' raw NDVI.
    const teaPix = pixels.map((_, i) => i).filter((i) => (teaShare[i] as number) >= R.teaShareMin);
    const dateOk = dates.map((_, t) => {
        const vals = teaPix.map((i) => (raw.ndvi[i] as Array<number | null>)[t]).filter((v): v is number => v !== null && v !== undefined);
        const med = median(vals);
        return med !== null && vals.length / Math.max(1, teaPix.length) >= R.minDateCoverage && med >= R.collapseNdvi;
    });
    const excludedDates = dates.filter((_, t) => !dateOk[t]);
    const nd = (i: number, t: number) => (dateOk[t] ? ((raw.ndvi[i] as Array<number | null>)[t] ?? null) : null);
    const nb = (i: number, t: number) => (dateOk[t] ? ((raw.nbr[i] as Array<number | null>)[t] ?? null) : null);
    console.log(`  ${excludedDates.length} tarih dışlandı (çöküş / seyrek kapsama)`);
    const globalRef = { n: dates.map((_, t) => median(teaPix.map((i) => nd(i, t)).filter((v): v is number => v !== null))), b: dates.map((_, t) => median(teaPix.map((i) => nb(i, t)).filter((v): v is number => v !== null))) };

    // Fusion verdicts, only for the comparison table.
    const fusionPath = join(store.dir, 'pruning-fusion', `season-${season}.json`);
    const fusion = existsSync(fusionPath) ? (JSON.parse(readFileSync(fusionPath, 'utf8')) as { gardens: Array<{ id: string; verdict: { class: string; kind?: string | null } }> }) : null;
    const fusionOf = new Map(fusion?.gardens.map((g) => [g.id, g.verdict]) ?? []);

    const scanFrom = `${year}-${R.scanFrom}`;
    const scanTo = `${year + 1}-${R.scanTo}`;
    const summer: [string, string] = [`${year + 1}-${R.summer[0]}`, `${year + 1}-${R.summer[1]}`];
    const candidateDates = dates.filter((d, t) => dateOk[t] && d >= scanFrom && d <= scanTo);
    const results: PixelGarden[] = [];

    // Population calibration (the fusion module's idea, per pixel): at every candidate date the step of ALL garden
    // pixels of the neighbourhood forms the null distribution — pruning is rare, phenology and weather move everyone.
    // A pixel counts only when it stands clear of that distribution, not merely of its own short baseline.
    const relOf = (id: string): Array<Array<number | null>> => {
        const list = gardenCells.get(id) ?? [];
        if (list.length === 0) return [];
        const own = new Set(list.map((c) => c.pix));
        const ce = mean(list.map((c) => c.e)) as number;
        const cn = mean(list.map((c) => c.n)) as number;
        const near = teaPix.filter((i) => !own.has(i) && Math.hypot((pixels[i] as [number, number])[0] - ce, (pixels[i] as [number, number])[1] - cn) <= R.referenceRadiusM);
        const refN = near.length >= R.referenceMinPixels ? dates.map((_, t) => median(near.map((i) => nd(i, t)).filter((v): v is number => v !== null))) : globalRef.n;
        return list.map((c) => dates.map((_, t) => (nd(c.pix, t) === null || refN[t] === null ? null : (nd(c.pix, t) as number) - (refN[t] as number))));
    };
    const allRel = gardens.flatMap((g) => relOf(g.id));
    const population = new Map<string, { median: number; sigma: number; n: number }>();
    for (const d of candidateDates) {
        const before: [string, string] = [addDays(d, -R.beforeDays), d];
        const after: [string, string] = [d, addDays(d, R.afterDays)];
        const deltas: number[] = [];
        for (const series of allRel) {
            const t = stepTest(dates, series, before, after, R.noiseFloor);
            if (t.nBefore >= R.minBefore && t.nAfter >= R.minAfter && t.delta !== null) deltas.push(t.delta);
        }
        const med = median(deltas) ?? 0;
        const mad = median(deltas.map((x) => Math.abs(x - med))) ?? 0;
        population.set(d, { median: med, sigma: Math.max(R.noiseFloor, 1.4826 * mad), n: deltas.length });
    }
    console.log(`  toplum dağılımı: ${candidateDates.length} aday tarih, σ ${[...population.values()].map((x) => x.sigma.toFixed(3)).join(' ')}`);

    for (const g of gardens) {
        const list = gardenCells.get(g.id) ?? [];
        const fv = fusionOf.get(g.id) ?? null;
        const base: PixelGarden = { id: g.id, pixels: list.length, evaluatedPixels: 0, verdict: 'no_data', fusionClass: fv?.class ?? null, fusionKind: fv?.kind ?? null, best: null, candidates: [], prunedM2: 0, prunedLowM2: 0, prunedUpperM2: 0, mainCluster: null, clusters: [], px: [], series: null };
        if (list.length === 0) {
            results.push(base);
            continue;
        }
        // Local reference: the other gardens' tea pixels within the radius.
        const own = new Set(list.map((c) => c.pix));
        const ce = mean(list.map((c) => c.e)) as number;
        const cn = mean(list.map((c) => c.n)) as number;
        const near = teaPix.filter((i) => !own.has(i) && Math.hypot((pixels[i] as [number, number])[0] - ce, (pixels[i] as [number, number])[1] - cn) <= R.referenceRadiusM);
        const ref = near.length >= R.referenceMinPixels
            ? { n: dates.map((_, t) => median(near.map((i) => nd(i, t)).filter((v): v is number => v !== null))), b: dates.map((_, t) => median(near.map((i) => nb(i, t)).filter((v): v is number => v !== null))) }
            : globalRef;
        const relN = list.map((c) => dates.map((_, t) => (nd(c.pix, t) === null || ref.n[t] === null ? null : (nd(c.pix, t) as number) - (ref.n[t] as number))));
        const relB = list.map((c) => dates.map((_, t) => (nb(c.pix, t) === null || ref.b[t] === null ? null : (nb(c.pix, t) as number) - (ref.b[t] as number))));
        const validDates = dates.filter((_, t) => dateOk[t] && ref.n[t] !== null);
        const pos = new Map(list.map((c, k) => [`${c.e}_${c.n}`, k]));

        const clustersAt = (d: string) => {
            const before: [string, string] = [addDays(d, -R.beforeDays), d];
            const after: [string, string] = [d, addDays(d, R.afterDays)];
            const tests = list.map((_, k) => stepTest(dates, relN[k] as Array<number | null>, before, after, R.noiseFloor));
            // Effective z: the weaker of the pixel's own-noise z and its distance from the neighbourhood's distribution at this date.
            const popAt = population.get(d);
            if (popAt) for (const t of tests) if (t.z !== null && t.delta !== null) t.z = Math.min(t.z, -(t.delta - popAt.median) / popAt.sigma);
            const nbrDelta = list.map((_, k) => stepTest(dates, relB[k] as Array<number | null>, before, after, R.noiseFloor).delta);
            const rawDelta = list.map((c) => stepTest(dates, dates.map((_, t) => nd(c.pix, t)), before, after, R.noiseFloor).delta);
            const enoughAt = (k: number) => { const t = tests[k] as Step; return t.nBefore >= R.minBefore && t.nAfter >= R.minAfter && t.delta !== null && t.delta <= -R.drop && rawDelta[k] !== null && (rawDelta[k] as number) <= -R.rawDrop; };
            const isCore = (k: number) => enoughAt(k) && ((tests[k] as Step).z ?? 0) >= R.zCore && !(list[k] as Cell).edge && (nbrDelta[k] === null || (nbrDelta[k] as number) <= 0);
            const canGrow = (k: number) => enoughAt(k) && ((tests[k] as Step).z ?? 0) >= ((list[k] as Cell).edge ? R.zEdge : R.zGrow) && (!(list[k] as Cell).edge || (nbrDelta[k] !== null && (nbrDelta[k] as number) < 0));
            const seen = new Set<number>();
            const groups: number[][] = [];
            for (let k = 0; k < list.length; k++) {
                if (seen.has(k) || !isCore(k)) continue;
                const group: number[] = [];
                const stack = [k];
                seen.add(k);
                while (stack.length) {
                    const cur = stack.pop() as number;
                    group.push(cur);
                    const c = list[cur] as Cell;
                    for (const de of [-10, 0, 10]) {
                        for (const dn of [-10, 0, 10]) {
                            const nbK = pos.get(`${c.e + de}_${c.n + dn}`);
                            if (nbK === undefined || seen.has(nbK) || !(isCore(nbK) || canGrow(nbK))) continue;
                            seen.add(nbK);
                            stack.push(nbK);
                        }
                    }
                }
                const lone = group.length === 1 && ((tests[group[0] as number] as Step).delta as number) <= -R.dropStrong && ((tests[group[0] as number] as Step).z ?? 0) >= R.lonePixelZ;
                if (group.length >= R.minClusterPixels || lone) groups.push(group);
            }
            const score = (grp: number[]) => grp.reduce((sum, k) => sum + ((tests[k] as Step).z ?? 0), 0);
            groups.sort((a, b) => score(b) - score(a));
            return { tests, nbrDelta, groups, isCore, score: groups[0] ? score(groups[0]) : 0, before, after };
        };

        const scored = candidateDates.map((d) => {
            const c = clustersAt(d);
            return { date: d, lastBefore: validDates.filter((x) => x < d).at(-1) ?? null, pixels: c.groups[0]?.length ?? 0, score: r3(c.score) };
        });
        const ranked = scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
        base.evaluatedPixels = list.length;
        base.candidates = ranked.slice(0, 3);
        const best = ranked[0] ?? null;
        if (!best) {
            // No event: still publish the lattice so the site can show "nothing moved".
            base.verdict = candidateDates.length ? 'none' : 'no_data';
            base.px = list.map((c) => [c.e, c.n, c.insideM2, null, null, 0, -1, c.edge ? 1 : 0]);
            results.push(base);
            continue;
        }
        const at = clustersAt(best.date);
        const clusterOf = new Map<number, number>();
        at.groups.forEach((grp, i) => grp.forEach((k) => clusterOf.set(k, i)));
        const absBefore = list.map((c) => mean(dates.map((d, t) => (d >= at.before[0] && d < at.before[1] ? nd(c.pix, t) : null)).filter((v): v is number => v !== null)));
        const fractionAt = (k: number, endMember: number) => {
            const span = absBefore[k] !== null ? Math.max(0.15, (absBefore[k] as number) - endMember) : null;
            return span === null ? 0 : Math.min(1, Math.max(0, -((at.tests[k] as Step).delta as number) / span));
        };
        const meanSeries = (ks: number[]) => dates.map((_, t) => {
            const vals = ks.map((k) => (relN[k] as Array<number | null>)[t]).filter((v): v is number => v !== null && v !== undefined);
            return vals.length >= Math.max(1, ks.length / 2) ? (mean(vals) as number) : null;
        });
        base.best = { date: best.date, lastBefore: best.lastBefore, score: best.score };
        base.clusters = at.groups.map((grp, index): PixelCluster => {
            const cellsOf = grp.map((k) => list[k] as Cell);
            const deltas = grp.map((k) => (at.tests[k] as Step).delta as number);
            const zs = grp.map((k) => (at.tests[k] as Step).z ?? 0);
            const area = grp.reduce((sum, k) => sum + fractionAt(k, R.ndviPruned) * (list[k] as Cell).insideM2, 0);
            const areaLow = grp.reduce((sum, k) => sum + fractionAt(k, R.ndviPrunedDefault) * (list[k] as Cell).insideM2, 0);
            const nbrVals = grp.map((k) => at.nbrDelta[k]).filter((v): v is number => v !== null);
            const nbrMean = mean(nbrVals);
            const crossIndexOk = nbrMean !== null && nbrMean < -0.02;
            // Recovery of the cluster's mean relative NDVI after the step.
            const s = meanSeries(grp);
            const pre = mean(dates.map((d, t) => (d >= at.before[0] && d < at.before[1] ? s[t] : null)).filter((v): v is number => v !== null && v !== undefined)) as number;
            const post = dates.map((d, t) => ({ d, v: s[t] })).filter((x): x is { d: string; v: number } => x.d >= best.date && x.v !== null && x.v !== undefined);
            const early = post.filter((x) => daysBetween(best.date, x.d) <= R.beforeDays).map((x) => x.v).sort((a, b) => a - b);
            const trough = early.length >= 2 ? ((early[0] as number) + (early[1] as number)) / 2 : (early[0] ?? null);
            const depth = trough !== null ? pre - trough : null;
            const recovered = (v: number) => (depth && depth > 0 ? (v - (pre - depth)) / depth : 0);
            let recoveryDays: number | null = null;
            const troughIdx = post.findIndex((x) => trough !== null && x.v <= trough + 1e-9);
            for (let i = Math.max(0, troughIdx) + 1; i < post.length; i++) {
                const x = post[i] as { d: string; v: number };
                const next = post[i + 1];
                if (recovered(x.v) >= R.recoveredShare && (!next || recovered(next.v) >= 0.5)) {
                    recoveryDays = daysBetween(best.date, x.d);
                    break;
                }
            }
            const summerVals = post.filter((x) => x.d >= summer[0] && x.d <= summer[1]).map((x) => recovered(x.v));
            const summerRecovery = summerVals.length ? (mean(summerVals) as number) : null;
            const lastObsDays = post.length ? daysBetween(best.date, (post.at(-1) as { d: string }).d) : 0;
            let kind: PixelKind;
            if (recoveryDays !== null && recoveryDays <= R.transientDays) kind = 'transient';
            else if (lastObsDays < R.transientDays) kind = 'pending';
            else if (summerRecovery !== null) kind = summerRecovery < R.deepSummerRecovery ? 'deep' : 'light';
            else if (recoveryDays !== null && recoveryDays <= R.lightDays) kind = 'light';
            else kind = lastObsDays >= R.persistDays ? 'deep' : 'pending';
            const edgePixels = cellsOf.filter((c) => c.edge).length;
            const strong = deltas.filter((d) => d <= -R.dropStrong).length;
            const maxZ = Math.max(...zs);
            const confidence: PixelConfidence =
                kind === 'transient' || !crossIndexOk || edgePixels / grp.length >= 0.5 ? 'low' : strong >= 2 || (strong >= 1 && maxZ >= 4) ? 'high' : 'medium';
            const notes: string[] = [];
            if (kind === 'transient') notes.push(`${recoveryDays} günde toparlandı: gölge / kar / don olasılığı, budama sayılmadı`);
            if (!crossIndexOk) notes.push('NDVI düştü ama SWIR indeksi (NBR) birlikte düşmedi: kar / gölge olasılığı');
            if (edgePixels > 0) notes.push(`${edgePixels} piksel bahçe sınırında ve çay örtüsü dışında`);
            const w = grp.map((k) => fractionAt(k, R.ndviPruned) * (list[k] as Cell).insideM2 || 1);
            const wsum = w.reduce((a, b) => a + b, 0);
            const cE = cellsOf.reduce((sum, c, i) => sum + (c.e + 5) * (w[i] as number), 0) / wsum;
            const cN = cellsOf.reduce((sum, c, i) => sum + (c.n + 5) * (w[i] as number), 0) / wsum;
            const ll = fromUtm(cE, cN, zone);
            return {
                index,
                pixels: grp.length,
                corePixels: grp.filter((k) => at.isCore(k)).length,
                edgePixels,
                areaM2: Math.round(area),
                areaLowM2: Math.round(areaLow),
                areaUpperM2: cellsOf.reduce((sum, c) => sum + c.insideM2, 0),
                centroid: [r6(ll[0]), r6(ll[1])],
                meanDelta: r3(mean(deltas) as number),
                maxZ: r3(maxZ),
                nbrDelta: nbrMean === null ? null : r3(nbrMean),
                crossIndexOk,
                kind,
                depth: depth === null ? null : r3(depth),
                recoveryDays,
                summerRecovery: summerRecovery === null ? null : r3(summerRecovery),
                lastObsDays,
                confidence,
                note: notes.join('; '),
            };
        });
        const rank: Record<PixelConfidence, number> = { high: 0, medium: 1, low: 2 };
        const main = [...base.clusters].sort((a, b) => rank[a.confidence] - rank[b.confidence] || b.areaM2 - a.areaM2)[0] as PixelCluster;
        const counted = base.clusters.filter((k) => k.confidence !== 'low' && k.kind !== 'transient');
        base.mainCluster = main.index;
        base.prunedM2 = counted.reduce((sum, k) => sum + k.areaM2, 0);
        base.prunedLowM2 = counted.reduce((sum, k) => sum + k.areaLowM2, 0);
        base.prunedUpperM2 = counted.reduce((sum, k) => sum + k.areaUpperM2, 0);
        base.verdict = main.kind === 'transient' ? 'transient' : main.confidence === 'low' ? 'weak' : main.kind;
        base.px = list.map((c, k) => {
            const t = at.tests[k] as Step;
            const cl = clusterOf.get(k);
            return [c.e, c.n, c.insideM2, t.delta === null ? null : r3(t.delta), t.z === null ? null : Math.round(t.z * 10) / 10, cl === undefined ? 0 : at.isCore(k) ? 2 : 1, cl ?? -1, c.edge ? 1 : 0];
        });
        const mainKs = at.groups[main.index] as number[];
        const restKs = list.map((_, k) => k).filter((k) => !clusterOf.has(k));
        const keep = dates.map((_, t) => dateOk[t] && ref.n[t] !== null);
        const round = (arr: Array<number | null>) => arr.filter((_, t) => keep[t]).map((v) => (v === null ? null : r3(v)));
        base.series = { dates: dates.filter((_, t) => keep[t]), cluster: round(meanSeries(mainKs)), rest: restKs.length ? round(meanSeries(restKs)) : [] };
        results.push(base);
    }

    const verdicts: PixelVerdict[] = ['deep', 'light', 'pending', 'transient', 'weak', 'none', 'no_data'];
    const byVerdict = Object.fromEntries(verdicts.map((v) => [v, results.filter((g) => g.verdict === v).length])) as Record<PixelVerdict, number>;
    const vsFusion: PixelSeasonFile['summary']['vsFusion'] = {};
    for (const g of results) {
        const k = g.fusionClass ?? 'none';
        vsFusion[k] ??= {};
        (vsFusion[k] as Partial<Record<PixelVerdict, number>>)[g.verdict] = ((vsFusion[k] as Partial<Record<PixelVerdict, number>>)[g.verdict] ?? 0) + 1;
    }
    const areaOf = (v: PixelVerdict) => results.filter((g) => g.verdict === v).reduce((sum, g) => sum + g.prunedM2, 0);
    const counted = (g: PixelGarden) => g.verdict === 'deep' || g.verdict === 'light' || g.verdict === 'pending';
    const out: PixelSeasonFile = {
        season,
        generatedAt: new Date().toISOString(),
        method: 'Piksel taraması: her bahçenin üzerine Sentinel-2’nin 10 m ağı serilir; pikseller 300 m çevredeki diğer bahçe piksellerine göreli okunur, sezonun her temiz sahnesi aday değişim tarihi olarak denenir, çekirdek (z ≥ 3) pikseller komşularıyla (z ≥ 2,5) kümelenir. Her aday tarihte mahalledeki tüm bahçe piksellerinin değişim dağılımı çıkarılır; piksel hem kendi gürültüsünden hem bu dağılımdan ayrışmalıdır (toplum kalibrasyonu). Pikselin kendi (ham) NDVI’si de düşmüş olmalıdır (komşuların bahar yeşillenmesi budama değildir). Sınır pikselleri çekirdek olamaz; kümeler toparlanma hızına göre derin budama / hafif budama / geçici düşüş olarak ayrılır. Kalibre edilmedi; çok-sensör kararını değiştirmez.',
        rules: R,
        epsg,
        window: [from, to],
        scan: { from: scanFrom, to: scanTo, candidates: candidateDates.length },
        dates: dates.length,
        excludedDates,
        summary: {
            gardens: results.length,
            pixels: pixels.length,
            flaggedPixels: results.reduce((sum, g) => sum + g.px.filter((p) => p[5] > 0).length, 0),
            byVerdict,
            areaM2: { deep: areaOf('deep'), light: areaOf('light'), pending: areaOf('pending') },
            vsFusion,
            newFinds: results.filter((g) => counted(g) && (g.fusionClass === 'unclear' || g.fusionClass === 'not_pruned')).length,
        },
        gardens: results,
    };
    writeFileSync(join(outDir, `season-${season}.json`), JSON.stringify(out));
    console.log(`Karar: ${verdicts.map((v) => `${v} ${byVerdict[v]}`).join(' · ')}`);
    console.log(`Alan: derin ${out.summary.areaM2.deep} m² · hafif ${out.summary.areaM2.light} m² · bekleyen ${out.summary.areaM2.pending} m² · çok-sensörün görmediği yeni bulgu ${out.summary.newFinds} bahçe`);
    console.log(`Çok-sensör × piksel: ${JSON.stringify(vsFusion)}`);
    console.log(`Yazıldı: ${join(outDir, `season-${season}.json`)}`);
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
