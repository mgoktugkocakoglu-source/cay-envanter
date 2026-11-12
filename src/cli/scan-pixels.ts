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
    zCore: 2.5,
    zGrow: 2.0,
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
    /**
     * Within-garden reference: a pixel is also read against the median of its own garden's other pixels (same
     * variety, aspect and management, so phenology cancels far better than against the neighbours). This is what
     * makes a partial cut — the usual 1/7 — visible; a whole-garden cut is still caught against the neighbours.
     */
    intraMinPixels: 5,
    intraFloor: 0.015,
    /**
     * Cluster statistic: Stouffer z = Σ z / √n over the cluster's pixels. Several adjacent pixels each a little below the
     * single-pixel bar add up to a clear event; the bar is set from the mirrored-series false-alarm test.
     */
    clusterZ: 5,
    /**
     * Seasonal baseline (the BFAST / CCDC idea with the data we have): on steep terrain every pixel has its own yearly
     * pattern (sun angle, shadow, its own phenology). The same pixel's earlier seasons at the same time of year give
     * that pattern; the scan runs on the deviation from it. 1 = on when earlier seasons are cached.
     */
    seasonalBaseline: 1,
    /** The SWIR cross-check stays on the plain relative NBR: measured on mirrored series, baselining it let more false clusters through without finding more cuts. */
    baselineNbr: 0,
    baselineDays: 20,
    baselineWideDays: 40,
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
    /** Measured without ground truth by scripts/pixel-validate.mjs (mirrored-series false alarms, simulated-cut detection rate); null until it has run. */
    validation: Record<string, unknown> | null;
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
    /** True when the within-garden reference gave the stronger test. */
    intra?: boolean;
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
        options: { province: { type: 'string' }, district: { type: 'string' }, neighborhood: { type: 'string' }, season: { type: 'string', default: '2025' }, force: { type: 'boolean', default: false },
            // Validation modes (never write the season file): mirrored series = false-alarm estimate; simulated cuts = detection rate.
            mirror: { type: 'boolean', default: false }, simulate: { type: 'string' }, seed: { type: 'string', default: '1' }, set: { type: 'string' }, tag: { type: 'string', default: 'run' }, 'fetch-only': { type: 'boolean', default: false } },
    });
    if (!values.province || !values.district || !values.neighborhood) {
        console.log(USAGE);
        process.exit(1);
    }
    const R = { ...PIXEL_RULES };
    for (const pair of (values.set ?? '').split(',').filter(Boolean)) {
        const [k, v] = pair.split('=') as [string, string];
        if (!(k in R)) throw new Error(`bilinmeyen kural: ${k}`);
        (R as Record<string, unknown>)[k] = Number(v);
    }
    const validating = values.mirror || values.simulate !== undefined;
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
    const latticePath = join(store.dir, 'pruning-pixels', 'lattice.json');
    const latticeKey = `${gardens.length}|${gardens.map((g) => g.id).join(',').length}|${R.minInsideShare}`;
    const savedLattice = !values.force && existsSync(latticePath) ? (JSON.parse(readFileSync(latticePath, 'utf8')) as { key: string; pixels: Array<[number, number]>; cells: Record<string, Cell[]>; teaShare: number[] }) : null;
    const lattice = savedLattice?.key === latticeKey ? savedLattice : null;
    const pixelIndex = new Map<string, number>();
    const pixels: Array<[number, number]> = [];
    const gardenCells = new Map<string, Cell[]>();
    for (const g of lattice ? [] : gardens) {
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
    if (lattice) {
        pixels.push(...lattice.pixels);
        teaShare.push(...lattice.teaShare);
        for (const [id, list] of Object.entries(lattice.cells)) gardenCells.set(id, list);
    } else {
        mkdirSync(join(store.dir, 'pruning-pixels'), { recursive: true });
        writeFileSync(latticePath, JSON.stringify({ key: latticeKey, pixels, cells: Object.fromEntries(gardenCells), teaShare }));
    }
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
    if (values['fetch-only']) return;
    const dates = raw.dates;

    // Date screening on the tea pixels' raw NDVI.
    const teaPix = pixels.map((_, i) => i).filter((i) => (teaShare[i] as number) >= R.teaShareMin);
    const dateOk = dates.map((_, t) => {
        const vals = teaPix.map((i) => (raw.ndvi[i] as Array<number | null>)[t]).filter((v): v is number => v !== null && v !== undefined);
        const med = median(vals);
        return med !== null && vals.length / Math.max(1, teaPix.length) >= R.minDateCoverage && med >= R.collapseNdvi;
    });
    const excludedDates = dates.filter((_, t) => !dateOk[t]);
    // ── Validation modes: the raw series are altered in memory only ──
    interface Injection { garden: string; pixels: number[]; cells: Array<[number, number]>; depth: number; kind: 'deep' | 'light'; at: string; cutM2: number }
    const injections: Injection[] = [];
    if (values.mirror) {
        // Mirror every pixel around its own season median: rises become drops. Nothing that greens up is a pruning,
        // so whatever the detector still finds estimates its false alarms (regrowth after last year's cuts makes it an upper bound).
        for (const arr of [raw.ndvi, raw.nbr]) {
            for (const row of arr) {
                const m = median(row.filter((v, t): v is number => v !== null && (dateOk[t] as boolean)));
                if (m === null) continue;
                for (let t = 0; t < row.length; t++) if (row[t] !== null) row[t] = r3(2 * m - (row[t] as number));
            }
        }
    }
    if (values.simulate !== undefined) {
        // Simulated cuts with known place, date, depth and recovery, injected into gardens where the real run found nothing.
        let a = Number(values.seed) * 7919 + 13;
        const random = () => {
            a |= 0;
            a = (a + 0x6d2b79f5) | 0;
            let x = Math.imul(a ^ (a >>> 15), 1 | a);
            x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
            return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
        };
        const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)] as T;
        const realPath = join(outDir, `season-${season}.json`);
        const quiet = existsSync(realPath) ? new Set((JSON.parse(readFileSync(realPath, 'utf8')) as PixelSeasonFile).gardens.filter((g) => g.verdict === 'none').map((g) => g.id)) : null;
        const pool = gardens.filter((g) => (gardenCells.get(g.id)?.length ?? 0) >= 1 && (!quiet || quiet.has(g.id)));
        const taken = new Set<number>();
        const span = daysBetween(`${year}-10-01`, `${year + 1}-04-10`);
        for (let n = 0; n < Number(values.simulate) && pool.length; n++) {
            const g = pool.splice(Math.floor(random() * pool.length), 1)[0] as (typeof gardens)[number];
            const list = (gardenCells.get(g.id) as Cell[]).filter((c) => !taken.has(c.pix));
            if (list.length === 0) continue;
            const size = Math.min(pick([1, 2, 3, 5, 8]), list.length);
            const chosen = [pick(list)];
            while (chosen.length < size) {
                const frontier = list.filter((c) => !chosen.includes(c) && chosen.some((k) => Math.abs(k.e - c.e) <= 10 && Math.abs(k.n - c.n) <= 10));
                if (frontier.length === 0) break;
                chosen.push(pick(frontier));
            }
            const depth = pick([0.06, 0.1, 0.15, 0.25]);
            const kind = pick(['deep', 'light'] as const);
            const at = addDays(`${year}-10-01`, Math.floor(random() * span));
            // Shape: half the drop on the first days (green debris), full by day 10; deep cuts hold into summer, light ones are back in ~90 days.
            const shape = (days: number) => Math.min(1, 0.5 + days / 20) * (kind === 'deep' ? (days <= 150 ? 1 : Math.max(0.6, 1 - (days - 150) / 250)) : Math.max(0, 1 - days / 90));
            for (const c of chosen) {
                taken.add(c.pix);
                dates.forEach((d, t) => {
                    if (d <= at) return;
                    const f = shape(daysBetween(at, d));
                    const nv = (raw.ndvi[c.pix] as Array<number | null>)[t];
                    const bv = (raw.nbr[c.pix] as Array<number | null>)[t];
                    if (nv !== null && nv !== undefined) (raw.ndvi[c.pix] as Array<number | null>)[t] = r3(nv - depth * f);
                    if (bv !== null && bv !== undefined) (raw.nbr[c.pix] as Array<number | null>)[t] = r3(bv - 0.8 * depth * f);
                });
            }
            injections.push({ garden: g.id, pixels: chosen.map((c) => c.pix), cells: chosen.map((c) => [c.e, c.n]), depth, kind, at, cutM2: Math.round(chosen.reduce((s, c) => s + c.insideM2, 0)) });
        }
    }
    const ndRaw = (i: number, t: number) => (dateOk[t] ? ((raw.ndvi[i] as Array<number | null>)[t] ?? null) : null);
    // Seasonal baseline per pixel from the earlier seasons' caches: its anomaly against the neighbourhood median at the same time of year.
    const baseline = pixels.map(() => dates.map(() => 0));
    const baselineB = pixels.map(() => dates.map(() => 0));
    let baselineSeasons = 0;
    let baselineCovered = 0;
    if (R.seasonalBaseline) {
        const dayOfSeason = (d: string, y: number) => daysBetween(`${y}-07-01`, d);
        const history: Array<Array<{ dos: number; a: number }>> = pixels.map(() => []);
        const historyB: Array<Array<{ dos: number; a: number }>> = pixels.map(() => []);
        for (const back of [1, 2, 3]) {
            const py = year - back;
            const path = join(outDir, `cache-${py}-${String(py + 1).slice(2)}.json`);
            if (!existsSync(path)) continue;
            const prev = JSON.parse(readFileSync(path, 'utf8')) as RawSeries;
            const at = new Map(prev.pixels.map(([pe, pn], i) => [`${pe}_${pn}`, i]));
            const idx = pixels.map(([pe, pn]) => at.get(`${pe}_${pn}`));
            const teaIdx = teaPix.map((i) => idx[i]).filter((v): v is number => v !== undefined);
            prev.dates.forEach((d, t) => {
                const vals = teaIdx.map((j) => (prev.ndvi[j] as Array<number | null>)[t]).filter((v): v is number => v !== null && v !== undefined);
                const med = median(vals);
                if (med === null || vals.length / Math.max(1, teaIdx.length) < R.minDateCoverage || med < R.collapseNdvi) return;
                const dos = dayOfSeason(d, py);
                const medB = median(teaIdx.map((j) => (prev.nbr[j] as Array<number | null>)[t]).filter((v): v is number => v !== null && v !== undefined));
                idx.forEach((j, i) => {
                    const v = j === undefined ? null : (prev.ndvi[j] as Array<number | null>)[t];
                    if (v !== null && v !== undefined) (history[i] as Array<{ dos: number; a: number }>).push({ dos, a: v - med });
                    const b = j === undefined ? null : (prev.nbr[j] as Array<number | null>)[t];
                    if (b !== null && b !== undefined && medB !== null) (historyB[i] as Array<{ dos: number; a: number }>).push({ dos, a: b - medB });
                });
            });
            baselineSeasons++;
        }
        if (baselineSeasons > 0) {
            dates.forEach((d, t) => {
                const dos = dayOfSeason(d, year);
                pixels.forEach((_, i) => {
                    const h = history[i] as Array<{ dos: number; a: number }>;
                    let near = h.filter((x) => Math.abs(x.dos - dos) <= R.baselineDays).map((x) => x.a);
                    if (near.length < 2) near = h.filter((x) => Math.abs(x.dos - dos) <= R.baselineWideDays).map((x) => x.a);
                    if (near.length < 2) near = h.map((x) => x.a);
                    const e = near.length >= 2 ? (median(near) as number) : 0;
                    if (near.length >= 2) baselineCovered++;
                    // In the mirrored (false-alarm) run the expectation is mirrored with the data.
                    (baseline[i] as number[])[t] = values.mirror ? -e : e;
                    const hb = historyB[i] as Array<{ dos: number; a: number }>;
                    let nearB = hb.filter((x) => Math.abs(x.dos - dos) <= R.baselineDays).map((x) => x.a);
                    if (nearB.length < 2) nearB = hb.filter((x) => Math.abs(x.dos - dos) <= R.baselineWideDays).map((x) => x.a);
                    if (nearB.length < 2) nearB = hb.map((x) => x.a);
                    const eb = nearB.length >= 2 ? (median(nearB) as number) : 0;
                    (baselineB[i] as number[])[t] = values.mirror ? -eb : eb;
                });
            });
        }
        console.log(`  mevsimsel taban: ${baselineSeasons} önceki sezon, kapsama %${Math.round((baselineCovered / Math.max(1, pixels.length * dates.length)) * 100)}`);
    }
    const nd = (i: number, t: number) => {
        const v = ndRaw(i, t);
        return v === null ? null : v - ((baseline[i] as number[])[t] as number);
    };
    const nb = (i: number, t: number) => {
        const v = dateOk[t] ? ((raw.nbr[i] as Array<number | null>)[t] ?? null) : null;
        return v === null ? null : v - (R.baselineNbr ? ((baselineB[i] as number[])[t] as number) : 0);
    };
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
    const intraOf = (list: Cell[]): Array<Array<number | null> | null> =>
        list.map((c) => {
            const others = list.filter((o) => !o.edge && (Math.abs(o.e - c.e) > 10 || Math.abs(o.n - c.n) > 10));
            if (others.length < R.intraMinPixels) return null;
            return dates.map((_, t) => {
                const v = nd(c.pix, t);
                if (v === null) return null;
                const m = median(others.map((o) => nd(o.pix, t)).filter((x): x is number => x !== null));
                return m === null ? null : v - m;
            });
        });
    const allIntra = gardens.flatMap((g) => intraOf(gardenCells.get(g.id) ?? [])).filter((x): x is Array<number | null> => x !== null);
    const populationIntra = new Map<string, { median: number; sigma: number }>();
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
        const intraDeltas: number[] = [];
        for (const series of allIntra) {
            const t = stepTest(dates, series, before, after, R.intraFloor);
            if (t.nBefore >= R.minBefore && t.nAfter >= R.minAfter && t.delta !== null) intraDeltas.push(t.delta);
        }
        const medIn = median(intraDeltas) ?? 0;
        populationIntra.set(d, { median: medIn, sigma: Math.max(R.intraFloor, 1.4826 * (median(intraDeltas.map((x) => Math.abs(x - medIn))) ?? 0)) });
    }
    console.log(`  toplum dağılımı: ${candidateDates.length} aday tarih, σ komşu ${[...population.values()].map((x) => x.sigma.toFixed(3)).join(' ')}`);
    console.log(`  bahçe içi σ ${[...populationIntra.values()].map((x) => x.sigma.toFixed(3)).join(' ')} (${allIntra.length} piksel)`);

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
        const relIn = intraOf(list);
        const seriesOf = (k: number, intra: boolean | undefined) => (intra && relIn[k] ? (relIn[k] as Array<number | null>) : (relN[k] as Array<number | null>));

        const clustersAt = (d: string) => {
            const before: [string, string] = [addDays(d, -R.beforeDays), d];
            const after: [string, string] = [d, addDays(d, R.afterDays)];
            // Effective z of a test: the weaker of the pixel's own-noise z and its distance from the population's distribution at this date.
            const popAt = population.get(d);
            const popInAt = populationIntra.get(d);
            const usable = (t: Step) => t.nBefore >= R.minBefore && t.nAfter >= R.minAfter && t.z !== null && t.delta !== null;
            const tests = list.map((_, k): Step => {
                const inter = stepTest(dates, relN[k] as Array<number | null>, before, after, R.noiseFloor);
                if (popAt && inter.z !== null && inter.delta !== null) inter.z = Math.min(inter.z, -(inter.delta - popAt.median) / popAt.sigma);
                if (!relIn[k]) return inter;
                const intra = stepTest(dates, relIn[k] as Array<number | null>, before, after, R.intraFloor);
                if (popInAt && intra.z !== null && intra.delta !== null) intra.z = Math.min(intra.z, -(intra.delta - popInAt.median) / popInAt.sigma);
                // The stronger of the two references decides: within-garden for a partial cut, neighbours for a whole-garden one.
                return usable(intra) && (!usable(inter) || (intra.z as number) > (inter.z as number)) ? { ...intra, intra: true } : inter;
            });
            const nbrDelta = list.map((_, k) => stepTest(dates, relB[k] as Array<number | null>, before, after, R.noiseFloor).delta);
            const rawDelta = list.map((c) => stepTest(dates, dates.map((_, t) => ndRaw(c.pix, t)), before, after, R.noiseFloor).delta);
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
            const score = (grp: number[]) => grp.reduce((sum, k) => sum + ((tests[k] as Step).z ?? 0), 0) / Math.sqrt(grp.length);
            for (let i = groups.length - 1; i >= 0; i--) if (score(groups[i] as number[]) < R.clusterZ) groups.splice(i, 1);
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
        const absBefore = list.map((c) => mean(dates.map((d, t) => (d >= at.before[0] && d < at.before[1] ? ndRaw(c.pix, t) : null)).filter((v): v is number => v !== null)));
        const fractionAt = (k: number, endMember: number) => {
            const span = absBefore[k] !== null ? Math.max(0.15, (absBefore[k] as number) - endMember) : null;
            return span === null ? 0 : Math.min(1, Math.max(0, -((at.tests[k] as Step).delta as number) / span));
        };
        const meanSeries = (ks: number[]) => dates.map((_, t) => {
            const vals = ks.map((k) => seriesOf(k, (at.tests[k] as Step).intra)[t]).filter((v): v is number => v !== null && v !== undefined);
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
        method: 'Piksel taraması: her bahçenin üzerine Sentinel-2’nin 10 m ağı serilir; pikseller hem 300 m çevredeki diğer bahçe piksellerine hem de kendi bahçesinin diğer piksellerine göreli okunur (kısmi kesim bahçe içinde, bütün bahçe kesimi komşulara göre ayrışır), sezonun her temiz sahnesi aday değişim tarihi olarak denenir, çekirdek (z ≥ 3) pikseller komşularıyla (z ≥ 2,5) kümelenir. Her aday tarihte mahalledeki tüm bahçe piksellerinin değişim dağılımı çıkarılır; piksel hem kendi gürültüsünden hem bu dağılımdan ayrışmalıdır (toplum kalibrasyonu). Her pikselin kendi mevsimsel örüntüsü önceki sezonlarından çıkarılır (güneş açısı, gölge, kendi fenolojisi) ve tarama bu örüntüden sapma üzerinde yapılır. Pikselin kendi (ham) NDVI’si de düşmüş olmalıdır (komşuların bahar yeşillenmesi budama değildir). Sınır pikselleri çekirdek olamaz; kümeler toparlanma hızına göre derin budama / hafif budama / geçici düşüş olarak ayrılır. Kalibre edilmedi; çok-sensör kararını değiştirmez.',
        rules: R,
        epsg,
        window: [from, to],
        scan: { from: scanFrom, to: scanTo, candidates: candidateDates.length },
        dates: dates.length,
        excludedDates,
        validation: existsSync(join(outDir, `validation-${season}.json`)) ? (JSON.parse(readFileSync(join(outDir, `validation-${season}.json`), 'utf8')) as Record<string, unknown>) : null,
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
    if (validating) {
        const counted = (g: PixelGarden) => g.verdict === 'deep' || g.verdict === 'light' || g.verdict === 'pending';
        const byId = new Map(results.map((g) => [g.id, g]));
        const trials = injections.map((inj) => {
            const g = byId.get(inj.garden) as PixelGarden;
            const detected = counted(g);
            const dateHit = detected && g.best !== null && (g.best.lastBefore ?? '') <= inj.at && inj.at < g.best.date;
            const flagged = new Set(g.px.filter((x) => x[5] > 0).map((x) => `${x[0]}_${x[1]}`));
            const pixelRecall = inj.cells.filter(([e, n]) => flagged.has(`${e}_${n}`)).length / inj.cells.length;
            const main = g.mainCluster !== null ? g.clusters[g.mainCluster] : null;
            return { ...inj, pixels: inj.cells.length, cells: undefined, verdict: g.verdict, detected, dateHit, pixelRecall: r3(pixelRecall), located: detected && pixelRecall >= 0.5, kindHit: detected && main?.kind === inj.kind, areaM2: g.prunedM2 };
        });
        const injected = new Set(injections.map((x) => x.garden));
        const others = results.filter((g) => !injected.has(g.id));
        const validation = {
            season,
            mode: values.mirror ? 'mirror' : 'simulate',
            tag: values.tag,
            overrides: values.set ?? '',
            gardens: results.length,
            countedOutsideInjections: others.filter(counted).length,
            byVerdict,
            trials,
        };
        writeFileSync(join(outDir, `validation-${season}-${values.tag}.json`), JSON.stringify(validation));
        const hit = trials.filter((x) => x.detected && x.dateHit && x.located).length;
        console.log(`VALIDATION ${JSON.stringify({ mode: validation.mode, tag: values.tag, set: validation.overrides, counted: results.filter(counted).length, countedOutside: validation.countedOutsideInjections, trials: trials.length, detected: trials.filter((x) => x.detected).length, full: hit })}`);
        return;
    }
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
