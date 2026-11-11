import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { area as turfArea, bearing, centroid, circle, difference, distance, feature, featureCollection, intersect, union } from '@turf/turf';
import { evaluate, initEarthEngine } from '../ee/session.ts';
import { NeighborhoodStore } from '../library/store.ts';
import { TkgmClient } from '../tkgm/client.ts';
import { parseTurkishNumber } from '../tkgm/normalize.ts';
import { backscatterSeries, type OrbitPass } from '../radar/series.ts';
import { fromUtm, toUtm, utmZone } from '../geo/utm.ts';

type Poly = Polygon | MultiPolygon;
type EE = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const USAGE = `
Kullanım:
  npm run field-test -- --province Trabzon --district Of --neighborhood Çataldere [--to 2026-11-12] [--case 136-12-2026-10-22]

Kör saha testi: field-tests/cases.json içindeki her vaka için uyduya yalnız ada/parsel ve bilinen budama tarihi
verilir. Parsel TKGM'den bir kez alınır; parselin üzerine Sentinel-2'nin kendi 10 m piksel ağı serilir, her
pikselin komşu çay örtüsüne göreli NDVI/NBR ve Sentinel-1 VH/VV serileri çekilir ve tarihten önce/sonra basamağı
aranır. Değişen pikseller kümelenir, budanan alan tahmin edilir, değişim tarihi uydunun kendi sahnelerinden
doğrulanır; saha işareti (groundTruth) tespite verilmez, yalnız sonunda kıyaslanır.
Budama tespit zincirine (scan-producers / radar / fuse) dokunmaz; çıktı: field-tests/results.json
`;

// ── Inputs ──
/** `measuredAreaM2`: the cut area measured or estimated in the field — calibrates the pruned-pixel NDVI end member (never the detection itself). */
interface GroundTruthPolygon { kind: 'polygon'; geometry: Poly; approximate?: boolean; note?: string; measuredAreaM2?: number }
interface GroundTruthTip { kind: 'tip'; side: 'west' | 'east' | 'north' | 'south'; radiusM: number; approximate?: boolean; note?: string; measuredAreaM2?: number }

interface FieldCase {
    id: string;
    block: string;
    parcel: string;
    /** The day the field says the cut happened: the only hint the detector gets. */
    prunedAt: string;
    reportedAt?: string;
    source: string;
    note?: string;
    /** Where the field says it was cut — compared with the detection afterwards, never used by it. */
    groundTruth?: GroundTruthPolygon | GroundTruthTip | null;
    parcelGeometry?: Poly;
    deedAreaM2?: number;
    parcelFetchedAt?: string;
}

// ── Outputs ──
export interface StepTest {
    nBefore: number;
    nAfter: number;
    meanBefore: number | null;
    meanAfter: number | null;
    sdBefore: number | null;
    delta: number | null;
    z: number | null;
}

export type Confidence = 'high' | 'medium' | 'low';

export interface PixelResult {
    id: string;
    e: number;
    n: number;
    geometry: Polygon;
    insideM2: number;
    insideShare: number;
    /** Boundary pixel whose outside part is not tea (forest, road): shadow / mixed-cover risk. */
    edgeNonTea: boolean;
    optical: { ndvi: StepTest; nbr: StepTest; ndviBeforeAbs: number | null; clearShare: number };
    radar: Partial<Record<OrbitPass, { vh: StepTest; ratio: StepTest }>>;
    flagged: boolean;
    strong: boolean;
    /** Pruned share of the pixel from the NDVI drop (null when not flagged). */
    fraction: number | null;
    prunedM2: number | null;
    cluster: number | null;
}

export interface ClusterResult {
    index: number;
    pixelIds: string[];
    areaM2: number;
    areaRange: [number, number];
    areaUpperM2: number;
    shareOfParcel: number;
    centroid: [number, number];
    position: string;
    edgeShare: number;
    meanDelta: number;
    maxZ: number;
    dateBracket: { lastBefore: string | null; firstAfter: string | null; bestSplit: string | null; bestDelta: number | null; containsPrunedAt: boolean | null };
    radar: Partial<Record<OrbitPass, { vh: StepTest; ratio: StepTest }>>;
    radarChange: boolean;
    confidence: Confidence;
    note: string;
}

export interface GroundTruthComparison {
    detectedM2: number;
    overlapM2: number;
    detectedInsideShare: number;
    groundTruthCoveredShare: number;
    centroidDistanceM: number | null;
    mainClusterInside: boolean;
    verdict: 'match' | 'partial' | 'miss' | 'no_detection';
    text: string;
}

export interface FieldTestResult {
    id: string;
    block: string;
    parcel: string;
    prunedAt: string;
    reportedAt: string | null;
    source: string;
    note: string | null;
    parcelGeometry: Poly;
    deedAreaM2: number | null;
    parcelAreaM2: number;
    parcelCentroid: [number, number];
    epsg: string;
    window: [string, string];
    windows: { before: [string, string]; after: [string, string] };
    reference: { pixels: number; areaM2: number };
    /** Optical dates dropped because the reference itself collapsed (snow, frost, terrain shadow). */
    excludedDates: string[];
    pixels: PixelResult[];
    clusters: ClusterResult[];
    detection: {
        verdict: 'detected' | 'not_detected' | 'pending';
        prunedM2: number;
        prunedRange: [number, number];
        shareOfParcel: number;
        mainCluster: number | null;
        dateBracket: ClusterResult['dateBracket'] | null;
        summary: string[];
    };
    series: {
        optical: { dates: string[]; clusters: Record<number, Array<number | null>>; rest: Array<number | null>; parcel: Array<number | null>; neighbours: Array<number | null> };
        radar: Array<{ pass: OrbitPass; relativeOrbit: number; dates: string[]; clusters: Record<number, Array<number | null>>; rest: Array<number | null> }>;
    };
    groundTruth: { geometry: Poly; areaM2: number; approximate: boolean; note: string | null; measuredAreaM2: number | null; comparison: GroundTruthComparison } | null;
    /** The pruned-pixel NDVI end member used for the area estimate: the default, or solved from a field-measured area. */
    calibration: { ndviPruned: number; range: [number, number]; source: 'default' | 'field'; measuredAreaM2: number | null; note: string };
}

export interface FieldTestsFile {
    generatedAt: string;
    method: string;
    rules: typeof RULES;
    cases: FieldTestResult[];
}

const RULES = {
    /** Days before the cut that form each pixel's own baseline; "after" runs to the last scene. */
    beforeDays: 75,
    minBefore: 5,
    minAfter: 2,
    /** Relative NDVI step (pixel − surrounding tea) that marks a changed pixel; "strong" is a pruning-sized step. */
    pixelDrop: 0.05,
    pixelDropStrong: 0.1,
    pixelZ: 2.5,
    noiseFloor: 0.03,
    /** NDVI of a tea hedge cut to the frame (stems, soil, debris) — the end member of the pruned-fraction estimate, with its range. */
    ndviPruned: 0.35,
    ndviPrunedRange: [0.25, 0.45] as [number, number],
    /** Radar: a VH change (either sign) of this size and significance at the cluster corroborates the timing. */
    radarChangeDb: 1.0,
    radarZ: 2.0,
    radarFloorDb: 0.8,
    /** A pixel with less than this share inside the parcel is a boundary pixel. */
    edgeInsideShare: 0.9,
    /** The change date is searched this many days either side of the field date. */
    dateSearchDays: 45,
    referenceBufferM: 300,
    windowBeforeDays: 120,
    /** Same screening as fusion v2.1: a date whose reference NDVI falls below this is a neighbourhood-wide collapse (snow, frost, terrain shadow), dropped for every unit. */
    collapseNdvi: 0.65,
};

const DAY = 86_400_000;
const addDays = (date: string, days: number) => new Date(Date.parse(date) + days * DAY).toISOString().slice(0, 10);
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const MONTHS_TR = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const fmtTr = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS_TR[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;

function mean(xs: number[]): number | null {
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
function sd(xs: number[]): number | null {
    if (xs.length < 2) return null;
    const m = mean(xs) as number;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/** Before-mean vs after-mean step in units of the before-window noise (positive z = a drop). */
function stepTest(dates: string[], values: Array<number | null>, before: [string, string], after: [string, string], floor: number): StepTest {
    const pick = (w: [string, string]) => dates.map((d, i) => (d >= w[0] && d < w[1] ? values[i] : null)).filter((v): v is number => v !== null && v !== undefined);
    const b = pick(before);
    const a = pick(after);
    const mb = mean(b);
    const ma = mean(a);
    const s = sd(b);
    const noise = Math.max(floor, s ?? floor);
    const delta = mb !== null && ma !== null ? ma - mb : null;
    const z = delta !== null && b.length > 0 && a.length > 0 ? -delta / (noise * Math.sqrt(1 / b.length + 1 / a.length)) : null;
    return { nBefore: b.length, nAfter: a.length, meanBefore: mb === null ? null : r3(mb), meanAfter: ma === null ? null : r3(ma), sdBefore: s === null ? null : r3(s), delta: delta === null ? null : r3(delta), z: z === null ? null : r3(z) };
}

function relative(unit: Array<number | null>, ref: Array<number | null>): Array<number | null> {
    return unit.map((v, i) => (v === null || v === undefined || ref[i] === null || ref[i] === undefined ? null : r3(v - (ref[i] as number))));
}

/** Mean of several series per date (null where fewer than half the members have a value). */
function meanSeries(rows: Array<Array<number | null>>): Array<number | null> {
    const n = rows[0]?.length ?? 0;
    return Array.from({ length: n }, (_, i) => {
        const vals = rows.map((r) => r[i]).filter((v): v is number => v !== null && v !== undefined);
        return vals.length >= Math.max(1, rows.length / 2) ? r3(mean(vals) as number) : null;
    });
}

function outerRings(geometry: Poly): Array<Array<[number, number]>> {
    const rings = geometry.type === 'Polygon' ? [geometry.coordinates[0]] : geometry.coordinates.map((p) => p[0]);
    return rings.map((r) => (r ?? []).map((p) => [p[0] as number, p[1] as number] as [number, number]));
}

function tipVertex(geometry: Poly, side: 'west' | 'east' | 'north' | 'south'): [number, number] {
    const pts = outerRings(geometry).flat();
    const key = side === 'west' || side === 'east' ? 0 : 1;
    const better = side === 'west' || side === 'south' ? (a: number, b: number) => a < b : (a: number, b: number) => a > b;
    return pts.reduce((best, p) => (better(p[key], best[key]) ? p : best), pts[0] as [number, number]);
}

async function fetchParcel(client: TkgmClient, neighborhoodId: number, c: FieldCase): Promise<{ geometry: Poly; deedAreaM2: number | null }> {
    console.log(`TKGM: ${c.block}/${c.parcel} tek sorgu`);
    const raw = await client.getParcelByNumber(neighborhoodId, Number(c.block), Number(c.parcel));
    if (!raw) throw new Error(`TKGM ${c.block}/${c.parcel} bulunamadı`);
    const area = parseTurkishNumber(raw.properties.alan);
    return { geometry: raw.geometry, deedAreaM2: area !== null && Number.isFinite(area) ? area : null };
}

/** Detected tea cover (detect-tea's patches, whole neighbourhood) within `bufferM` of the parcel, minus the parcel: the seasonal reference. */
function neighbourTea(ee: EE, patches: Array<Feature<Poly, { areaM2: number }>>, parcelEe: EE, bufferM: number): EE {
    const fc = ee.FeatureCollection(patches.map((f) => ee.Feature(ee.Geometry(f.geometry), { areaM2: f.properties.areaM2 })));
    return fc.filterBounds(parcelEe.buffer(bufferM)).geometry().intersection(parcelEe.buffer(bufferM), 1).difference(parcelEe.buffer(5), 1);
}

// ── The sensor's own lattice over the parcel ──
interface Cell {
    id: string;
    e: number;
    n: number;
    geometry: Polygon;
    inside: Feature<Poly>;
    insideM2: number;
    insideShare: number;
    edgeNonTea: boolean;
}

function cells(parcel: Poly, patches: Array<Feature<Poly, { areaM2: number }>>, zone: number): Cell[] {
    const pts = outerRings(parcel).flat().map(([lon, lat]) => toUtm(lat, lon, zone));
    const e0 = Math.floor(Math.min(...pts.map((p) => p.e)) / 10) * 10;
    const e1 = Math.ceil(Math.max(...pts.map((p) => p.e)) / 10) * 10;
    const n0 = Math.floor(Math.min(...pts.map((p) => p.n)) / 10) * 10;
    const n1 = Math.ceil(Math.max(...pts.map((p) => p.n)) / 10) * 10;
    const parcelF = feature(parcel);
    const out: Cell[] = [];
    for (let e = e0; e < e1; e += 10) {
        for (let n = n0; n < n1; n += 10) {
            const ring = [fromUtm(e, n, zone), fromUtm(e + 10, n, zone), fromUtm(e + 10, n + 10, zone), fromUtm(e, n + 10, zone), fromUtm(e, n, zone)];
            const square: Polygon = { type: 'Polygon', coordinates: [ring] };
            const squareF = feature(square);
            const inside = intersect(featureCollection([squareF, parcelF]));
            if (!inside) continue;
            const insideM2 = turfArea(inside);
            if (insideM2 < 5) continue;
            const insideShare = Math.min(1, insideM2 / turfArea(squareF));
            let edgeNonTea = false;
            if (insideShare < RULES.edgeInsideShare) {
                const outside = difference(featureCollection([squareF, parcelF]));
                const outsideM2 = outside ? turfArea(outside) : 0;
                let teaOutside = 0;
                if (outside) {
                    for (const p of patches) {
                        const x = intersect(featureCollection([outside, feature(p.geometry)]));
                        if (x) teaOutside += turfArea(x);
                    }
                }
                edgeNonTea = outsideM2 > 0 && teaOutside / outsideM2 < 0.5;
            }
            out.push({ id: `px_${e}_${n}`, e, n, geometry: square, inside: inside as Feature<Poly>, insideM2: Math.round(insideM2), insideShare: r3(insideShare), edgeNonTea });
        }
    }
    return out;
}

// ── Sentinel-2 ──
interface OpticalRow {
    id: string;
    date: string;
    ndvi: number | null;
    nbr: number | null;
    count: number;
}

/** Clear, snow-free Sentinel-2 scenes as NDVI + NBR images (Cloud Score+ ≥ 0.6, NDSI < 0.4, SCL ≠ snow). */
function s2Clean(ee: EE, region: EE, from: string, to: string): EE {
    const cloudScore = ee.ImageCollection('GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED');
    return ee
        .ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
        .filterBounds(region)
        .filterDate(from, to)
        .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 80))
        .linkCollection(cloudScore, ['cs_cdf'])
        .sort('system:time_start')
        .map((image: EE) => {
            const scaled = image.select(['B3', 'B4', 'B8', 'B11', 'B12']).divide(10_000);
            const clear = image.select('cs_cdf').gte(0.6).and(scaled.normalizedDifference(['B3', 'B11']).lt(0.4)).and(image.select('SCL').neq(11));
            const img = scaled.normalizedDifference(['B8', 'B4']).rename('ndvi').addBands(scaled.normalizedDifference(['B8', 'B12']).rename('nbr')).updateMask(clear);
            return ee.Image(img.copyProperties(image, ['system:time_start', 'system:index']));
        });
}

async function opticalRows(ee: EE, fc: EE, from: string, to: string): Promise<OpticalRow[]> {
    const perImage = s2Clean(ee, fc.geometry().bounds(), from, to)
        .map((img: EE) => {
            const date = ee.Date(img.get('system:time_start')).format('YYYY-MM-dd');
            return img
                .reduceRegions({ collection: fc, reducer: ee.Reducer.mean().combine(ee.Reducer.count(), '', true), scale: 10, tileScale: 4 })
                .map((f: EE) => f.set('date', date));
        })
        .flatten()
        .select(['id', 'date', 'ndvi_mean', 'ndvi_count', 'nbr_mean'], null, false);
    const out = await evaluate<{ features: Array<{ properties: { id: string; date: string; ndvi_mean: number | null; ndvi_count: number | null; nbr_mean: number | null } }> }>(perImage);
    return out.features.map(({ properties: p }) => ({ id: p.id, date: p.date, ndvi: p.ndvi_mean ?? null, nbr: p.nbr_mean ?? null, count: p.ndvi_count ?? 0 }));
}

/** Rows in date chunks so one request stays under Earth Engine's element cap. */
async function opticalRowsChunked(ee: EE, fc: EE, from: string, to: string, stepDays = 40): Promise<OpticalRow[]> {
    const out: OpticalRow[] = [];
    for (let a = from; a < to; a = addDays(a, stepDays)) {
        const b = addDays(a, stepDays) < to ? addDays(a, stepDays) : to;
        out.push(...(await opticalRows(ee, fc, a, b)));
    }
    return out;
}

interface UnitSeries {
    ndvi: Array<number | null>;
    nbr: Array<number | null>;
    count: number[];
}

function assemble(rows: OpticalRow[], ids: string[], minShare: Record<string, number>): { dates: string[]; units: Record<string, UnitSeries> } {
    const byKey = new Map<string, OpticalRow>();
    for (const r of rows) {
        const k = `${r.id}|${r.date}`;
        const prev = byKey.get(k);
        if (!prev || r.count > prev.count) byKey.set(k, r);
    }
    const dates = [...new Set(rows.map((r) => r.date))].sort();
    const units: Record<string, UnitSeries> = {};
    for (const id of ids) {
        const total = Math.max(1, ...rows.filter((r) => r.id === id).map((r) => r.count));
        const need = minShare[id] ?? 1;
        const get = (d: string) => byKey.get(`${id}|${d}`);
        const ok = (r: OpticalRow | undefined) => !!r && r.ndvi !== null && r.count / total >= need;
        units[id] = {
            ndvi: dates.map((d) => (ok(get(d)) ? r3((get(d) as OpticalRow).ndvi as number) : null)),
            nbr: dates.map((d) => (ok(get(d)) ? r3((get(d) as OpticalRow).nbr as number) : null)),
            count: dates.map((d) => get(d)?.count ?? 0),
        };
    }
    return { dates, units };
}

// ── Clustering and description ──
function clusterCells(flagged: Cell[]): Cell[][] {
    const key = (c: Cell) => `${c.e / 10},${c.n / 10}`;
    const byKey = new Map(flagged.map((c) => [key(c), c]));
    const seen = new Set<string>();
    const groups: Cell[][] = [];
    for (const c of flagged) {
        if (seen.has(key(c))) continue;
        const group: Cell[] = [];
        const stack = [c];
        seen.add(key(c));
        while (stack.length) {
            const cur = stack.pop() as Cell;
            group.push(cur);
            for (const de of [-10, 0, 10]) {
                for (const dn of [-10, 0, 10]) {
                    const k = `${(cur.e + de) / 10},${(cur.n + dn) / 10}`;
                    const nb = byKey.get(k);
                    if (nb && !seen.has(k)) {
                        seen.add(k);
                        stack.push(nb);
                    }
                }
            }
        }
        groups.push(group);
    }
    return groups.sort((a, b) => b.length - a.length);
}

const COMPASS = ['kuzey', 'kuzeydoğu', 'doğu', 'güneydoğu', 'güney', 'güneybatı', 'batı', 'kuzeybatı'];
function describePosition(parcelCentre: [number, number], parcelAreaM2: number, at: [number, number], edge: boolean): string {
    const dist = distance(parcelCentre, at, { units: 'meters' });
    const radius = Math.sqrt(parcelAreaM2 / Math.PI);
    if (dist < 0.35 * radius) return 'orta kısmı';
    const b = (bearing(parcelCentre, at) + 360) % 360;
    const dir = COMPASS[Math.round(b / 45) % 8] as string;
    return `${dir} ${edge ? 'kenarı' : dist > 0.8 * radius ? 'ucu' : 'tarafı'}`;
}

/** Best step date of a series inside ±dateSearchDays of the field date (last clear scene before / first after the step). */
function dateBracket(dates: string[], values: Array<number | null>, prunedAt: string): ClusterResult['dateBracket'] {
    const lo = addDays(prunedAt, -RULES.dateSearchDays);
    const hi = addDays(prunedAt, RULES.dateSearchDays);
    let best: { d: string; delta: number } | null = null;
    for (const [i, d] of dates.entries()) {
        if (d < lo || d > hi || values[i] === null || values[i] === undefined) continue;
        const t = stepTest(dates, values, [addDays(d, -RULES.beforeDays), d], [d, addDays(d, RULES.beforeDays)], RULES.noiseFloor);
        if (t.nBefore < 3 || t.nAfter < RULES.minAfter || t.delta === null) continue;
        if (!best || t.delta < best.delta) best = { d, delta: t.delta };
    }
    if (!best) return { lastBefore: null, firstAfter: null, bestSplit: null, bestDelta: null, containsPrunedAt: null };
    const split = best.d;
    const valid = dates.filter((d, i) => values[i] !== null && values[i] !== undefined);
    const lastBefore = valid.filter((d) => d < split).at(-1) ?? null;
    return { lastBefore, firstAfter: split, bestSplit: split, bestDelta: best.delta, containsPrunedAt: lastBefore !== null ? lastBefore < prunedAt && prunedAt <= split : null };
}

function confidenceOf(strong: number, maxZ: number, edgeShare: number, radarChange: boolean): Confidence {
    if (edgeShare >= 1 && !radarChange) return 'low';
    if (strong >= 2 || (strong >= 1 && maxZ >= 4) || (strong >= 1 && radarChange)) return 'high';
    return 'medium';
}

const centreOf = (p: PixelResult): [number, number] => {
    const ring = p.geometry.coordinates[0] as Array<[number, number]>;
    const a = ring[0] as [number, number];
    const b = ring[2] as [number, number];
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
};

// ── The case ──
async function runCase(ee: EE, store: NeighborhoodStore, c: FieldCase, to: string): Promise<FieldTestResult> {
    const parcel = c.parcelGeometry as Poly;
    const parcelF = feature(parcel);
    const parcelAreaM2 = Math.round(turfArea(parcelF));
    const parcelCentre = centroid(parcelF).geometry.coordinates as [number, number];
    const zone = utmZone(parcelCentre[0]);
    const epsg = `EPSG:326${zone}`;
    const patches = (JSON.parse(readFileSync(join(store.dir, 'tea-patches.geojson'), 'utf8')) as FeatureCollection<Poly, { areaM2: number }>).features;
    const grid = cells(parcel, patches, zone);
    console.log(`  parsel ${parcelAreaM2} m², ${grid.length} piksel (${grid.filter((g) => g.insideShare < RULES.edgeInsideShare).length} sınır, ${grid.filter((g) => g.edgeNonTea).length} çay dışı komşulu)`);

    const parcelEe = ee.Geometry(parcel);
    const neighboursEe = neighbourTea(ee, patches, parcelEe, RULES.referenceBufferM);
    const [neighboursGeom, neighboursArea] = await Promise.all([evaluate<Poly>(neighboursEe), evaluate<number>(neighboursEe.area(1))]);
    if (neighboursArea < 2000) throw new Error(`Parselin ${RULES.referenceBufferM} m çevresinde yeterli çay örtüsü yok (${Math.round(neighboursArea)} m²); referans kurulamadı.`);

    const from = addDays(c.prunedAt, -RULES.windowBeforeDays);
    const before: [string, string] = [addDays(c.prunedAt, -RULES.beforeDays), c.prunedAt];
    const after: [string, string] = [addDays(c.prunedAt, 1), addDays(to, 1)];

    // Every pixel is its own unit (squares shrunk by 1 m so the reducer takes exactly one pixel), plus the parcel and its reference.
    const units = [
        ...grid.map((g) => ({ id: g.id, ee: ee.Geometry(g.geometry).buffer(-1), geometry: g.geometry as Poly })),
        { id: 'parcel', ee: parcelEe, geometry: parcel },
        { id: 'neighbours', ee: neighboursEe, geometry: neighboursGeom },
    ];
    const fc = ee.FeatureCollection(units.map((u) => ee.Feature(u.ee, { id: u.id })));
    console.log(`  Sentinel-2 piksel serileri çekiliyor (${from} → ${to})…`);
    const rows = await opticalRowsChunked(ee, fc, from, addDays(to, 1));
    const minShare: Record<string, number> = { parcel: 0.5, neighbours: 0.5 };
    const { dates, units: series } = assemble(rows, units.map((u) => u.id), minShare);
    const refPixels = Math.max(0, ...rows.filter((r) => r.id === 'neighbours').map((r) => r.count));
    const nb = series.neighbours as UnitSeries;
    // Date screening (the fusion module's rule): a collapse of the reference itself is weather or shadow, not a cut.
    const excludedDates = dates.filter((d, i) => nb.ndvi[i] !== null && (nb.ndvi[i] as number) < RULES.collapseNdvi);
    for (const s of Object.values(series)) {
        dates.forEach((d, i) => {
            if (!excludedDates.includes(d)) return;
            s.ndvi[i] = null;
            s.nbr[i] = null;
        });
    }
    console.log(`  ${dates.length} sahne; referans ${refPixels} piksel; ${excludedDates.length} tarih referans çöküşü nedeniyle dışlandı${excludedDates.length ? ` (${excludedDates.join(', ')})` : ''}`);

    // Per-pixel step tests against the reference.
    const rel = new Map<string, { ndvi: Array<number | null>; nbr: Array<number | null> }>();
    const pixelTests = new Map<string, PixelResult['optical']>();
    for (const g of grid) {
        const s = series[g.id] as UnitSeries;
        const rn = relative(s.ndvi, nb.ndvi);
        const rb = relative(s.nbr, nb.nbr);
        rel.set(g.id, { ndvi: rn, nbr: rb });
        const absBefore = mean(dates.map((d, i) => (d >= before[0] && d < before[1] ? s.ndvi[i] : null)).filter((v): v is number => v !== null && v !== undefined));
        pixelTests.set(g.id, {
            ndvi: stepTest(dates, rn, before, after, RULES.noiseFloor),
            nbr: stepTest(dates, rb, before, after, RULES.noiseFloor),
            ndviBeforeAbs: absBefore === null ? null : r3(absBefore),
            clearShare: r3(s.ndvi.filter((v) => v !== null).length / Math.max(1, dates.length)),
        });
    }

    // Sentinel-1: γ0 VH/VV per pixel per pass, relative to the reference.
    const radarPasses: Array<{ pass: OrbitPass; relativeOrbit: number; dates: string[]; vh: Record<string, Array<number | null>>; ratio: Record<string, Array<number | null>> }> = [];
    const region = parcelEe.buffer(1500);
    for (const pass of ['ASCENDING', 'DESCENDING'] as OrbitPass[]) {
        console.log(`  Sentinel-1 ${pass} piksel serileri çekiliyor…`);
        const s = await backscatterSeries(ee, region, units.map((u) => ({ id: u.id, geometry: u.geometry })), [from, addDays(to, 1)], pass);
        if (!s) continue;
        const refVh = s.gardens.neighbours?.vh ?? [];
        const refVv = s.gardens.neighbours?.vv ?? [];
        const refRatio = refVh.map((v, i) => (v === null || refVv[i] === null || refVv[i] === undefined ? null : v - (refVv[i] as number)));
        const vh: Record<string, Array<number | null>> = {};
        const ratio: Record<string, Array<number | null>> = {};
        for (const u of units) {
            const g = s.gardens[u.id];
            if (!g) continue;
            vh[u.id] = relative(g.vh, refVh);
            ratio[u.id] = relative(g.vh.map((v, i) => (v === null || g.vv[i] === null || g.vv[i] === undefined ? null : v - (g.vv[i] as number))), refRatio);
        }
        radarPasses.push({ pass, relativeOrbit: s.relativeOrbit, dates: s.dates, vh, ratio });
        console.log(`    yörünge ${s.relativeOrbit}: ${s.dates.length} geçiş (${s.dates.filter((d) => d > c.prunedAt).length} tanesi kesimden sonra)`);
    }

    // Flag, size and cluster.
    const pixels: PixelResult[] = grid.map((g) => {
        const o = pixelTests.get(g.id) as PixelResult['optical'];
        const t = o.ndvi;
        const enough = t.nBefore >= RULES.minBefore && t.nAfter >= RULES.minAfter;
        const flagged = enough && t.delta !== null && t.delta <= -RULES.pixelDrop && (t.z ?? 0) >= RULES.pixelZ;
        const strong = flagged && (t.delta as number) <= -RULES.pixelDropStrong;
        const span = o.ndviBeforeAbs !== null ? Math.max(0.15, o.ndviBeforeAbs - RULES.ndviPruned) : null;
        const fraction = flagged && span !== null ? r3(Math.min(1, Math.max(0, -(t.delta as number) / span))) : null;
        const radar: PixelResult['radar'] = {};
        for (const p of radarPasses) {
            radar[p.pass] = {
                vh: stepTest(p.dates, p.vh[g.id] ?? [], before, after, RULES.radarFloorDb),
                ratio: stepTest(p.dates, p.ratio[g.id] ?? [], before, after, RULES.radarFloorDb),
            };
        }
        const ring = (g.geometry.coordinates[0] as Array<[number, number]>).map(([lon, lat]) => [r6(lon), r6(lat)] as [number, number]);
        return {
            id: g.id,
            e: g.e,
            n: g.n,
            geometry: { type: 'Polygon', coordinates: [ring] },
            insideM2: g.insideM2,
            insideShare: g.insideShare,
            edgeNonTea: g.edgeNonTea,
            optical: o,
            radar,
            flagged,
            strong,
            fraction,
            prunedM2: fraction === null ? null : Math.round(fraction * g.insideM2),
            cluster: null,
        };
    });
    // Calibration: the field's measured area pins the pruned-pixel NDVI end member (flagging does not depend on it).
    const measured = c.groundTruth?.measuredAreaM2 ?? null;
    const sizeAt = (ndviPruned: number) =>
        pixels.filter((p) => p.flagged).reduce((sum, p) => {
            const span = p.optical.ndviBeforeAbs !== null ? Math.max(0.15, p.optical.ndviBeforeAbs - ndviPruned) : null;
            return sum + (span === null ? 0 : Math.min(1, Math.max(0, -(p.optical.ndvi.delta as number) / span)) * p.insideM2);
        }, 0);
    let calibration: FieldTestResult['calibration'] = { ndviPruned: RULES.ndviPruned, range: RULES.ndviPrunedRange, source: 'default', measuredAreaM2: null, note: `Varsayılan uç değer (budanmış çay örtüsü NDVI ${RULES.ndviPruned}); saha ölçümü yok.` };
    if (measured !== null && pixels.some((p) => p.flagged)) {
        // sizeAt() rises with the end member; bisect it between bare soil and the pixels' own pre-cut level.
        let lo = 0;
        let hi = Math.min(...pixels.filter((p) => p.flagged).map((p) => p.optical.ndviBeforeAbs ?? 0.9)) - 0.15;
        if (sizeAt(hi) < measured) calibration = { ndviPruned: r3(hi), range: [r3(hi - 0.1), r3(hi)], source: 'field', measuredAreaM2: measured, note: `Saha ölçümü (${measured} m²) tespit edilen piksellerin tamamından (${Math.round(sizeAt(hi))} m²) büyük: uç değer üst sınırda; kesim bayraklanan piksellerin dışına taşıyor olabilir.` };
        else {
            for (let i = 0; i < 40; i++) {
                const mid = (lo + hi) / 2;
                if (sizeAt(mid) < measured) lo = mid;
                else hi = mid;
            }
            const solved = r3((lo + hi) / 2);
            calibration = { ndviPruned: solved, range: [r3(solved - 0.1), r3(solved + 0.1)], source: 'field', measuredAreaM2: measured, note: `Uç değer saha ölçümünden çözüldü (n=1 vaka, ${measured} m²): tam budanmış piksel NDVI'si ${solved}. Bu vakada alan kıyası bağımsız değildir; konum ve tarih kıyası bağımsızdır.` };
        }
        for (const p of pixels) {
            if (!p.flagged) continue;
            const span = p.optical.ndviBeforeAbs !== null ? Math.max(0.15, p.optical.ndviBeforeAbs - calibration.ndviPruned) : null;
            p.fraction = span === null ? null : r3(Math.min(1, Math.max(0, -(p.optical.ndvi.delta as number) / span)));
            p.prunedM2 = p.fraction === null ? null : Math.round(p.fraction * p.insideM2);
        }
    }
    console.log(`  kalibrasyon: ${calibration.note}`);
    const byId = new Map(pixels.map((p) => [p.id, p]));
    const groups = clusterCells(grid.filter((g) => (byId.get(g.id) as PixelResult).flagged));
    const pendingShare = pixels.filter((p) => p.optical.ndvi.nAfter < RULES.minAfter).length / Math.max(1, pixels.length);

    const clusterSeries: Record<number, Array<number | null>> = {};
    const clusterRadar: Record<number, Partial<Record<OrbitPass, Array<number | null>>>> = {};
    const clusters: ClusterResult[] = groups.map((members, index) => {
        const ids = members.map((m) => m.id);
        for (const id of ids) (byId.get(id) as PixelResult).cluster = index;
        const px = ids.map((id) => byId.get(id) as PixelResult);
        const relSeries = meanSeries(ids.map((id) => (rel.get(id) as { ndvi: Array<number | null> }).ndvi));
        clusterSeries[index] = relSeries;
        const areaM2 = px.reduce((s, p) => s + (p.prunedM2 ?? 0), 0);
        const areaAt = (ndviPruned: number) =>
            px.reduce((s, p) => {
                const span = p.optical.ndviBeforeAbs !== null ? Math.max(0.15, p.optical.ndviBeforeAbs - ndviPruned) : null;
                return s + (span === null ? 0 : Math.min(1, Math.max(0, -(p.optical.ndvi.delta as number) / span)) * p.insideM2);
            }, 0);
        const areaUpperM2 = px.reduce((s, p) => s + p.insideM2, 0);
        const w = px.map((p) => p.prunedM2 ?? 1);
        const wsum = w.reduce((a, b) => a + b, 0) || 1;
        const cx = px.reduce((s, p, i) => s + centreOf(p)[0] * (w[i] as number), 0) / wsum;
        const cy = px.reduce((s, p, i) => s + centreOf(p)[1] * (w[i] as number), 0) / wsum;
        const edgeShare = r3(px.filter((p) => p.insideShare < RULES.edgeInsideShare).length / px.length);
        const nonTeaEdge = px.filter((p) => p.edgeNonTea).length;
        const radar: ClusterResult['radar'] = {};
        clusterRadar[index] = {};
        let radarChange = false;
        for (const p of radarPasses) {
            const cs = meanSeries(ids.map((id) => p.vh[id] ?? []));
            (clusterRadar[index] as Partial<Record<OrbitPass, Array<number | null>>>)[p.pass] = cs;
            const vh = stepTest(p.dates, cs, before, after, RULES.radarFloorDb);
            const ratio = stepTest(p.dates, meanSeries(ids.map((id) => p.ratio[id] ?? [])), before, after, RULES.radarFloorDb);
            radar[p.pass] = { vh, ratio };
            for (const t of [vh, ratio]) if (t.delta !== null && Math.abs(t.delta) >= RULES.radarChangeDb && Math.abs(t.z ?? 0) >= RULES.radarZ) radarChange = true;
        }
        const strong = px.filter((p) => p.strong).length;
        const maxZ = Math.max(...px.map((p) => p.optical.ndvi.z ?? 0));
        const meanDelta = r3(mean(px.map((p) => p.optical.ndvi.delta as number)) as number);
        const bracket = dateBracket(dates, relSeries, c.prunedAt);
        const confidence = confidenceOf(strong, maxZ, edgeShare, radarChange);
        const position = describePosition(parcelCentre, parcelAreaM2, [cx, cy], edgeShare > 0);
        const notes: string[] = [];
        if (nonTeaEdge > 0) notes.push(`${nonTeaEdge} piksel parsel sınırında ve dışı çay değil (ağaç gölgesi / karışık örtü olasılığı)`);
        if (bracket.containsPrunedAt === false) notes.push('uydunun gördüğü değişim aralığı saha tarihini içermiyor');
        if (!radarChange) notes.push('radar bu kümede anlamlı değişim görmedi');
        return {
            index,
            pixelIds: ids,
            areaM2: Math.round(areaM2),
            areaRange: [Math.round(Math.min(areaAt(calibration.range[0]), areaAt(calibration.range[1]))), Math.round(Math.max(areaAt(calibration.range[0]), areaAt(calibration.range[1])))],
            areaUpperM2,
            shareOfParcel: r3(areaM2 / parcelAreaM2),
            centroid: [r6(cx), r6(cy)],
            position,
            edgeShare,
            meanDelta,
            maxZ: r3(maxZ),
            dateBracket: bracket,
            radar,
            radarChange,
            confidence,
            note: notes.join('; '),
        };
    });

    // Rank: confidence first, then area.
    const rank: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };
    const ordered = [...clusters].sort((a, b) => rank[a.confidence] - rank[b.confidence] || b.areaM2 - a.areaM2);
    const main = ordered[0] ?? null;
    const counted = clusters.filter((k) => k.confidence !== 'low');
    const prunedM2 = counted.reduce((s, k) => s + k.areaM2, 0);
    const prunedRange: [number, number] = [counted.reduce((s, k) => s + k.areaRange[0], 0), counted.reduce((s, k) => s + k.areaRange[1], 0)];
    const verdict: FieldTestResult['detection']['verdict'] = clusters.length ? 'detected' : pendingShare > 0.5 ? 'pending' : 'not_detected';

    // Plain sentences for the inspector.
    const summary: string[] = [];
    const confLabel: Record<Confidence, string> = { high: 'yüksek', medium: 'orta', low: 'düşük' };
    if (main && verdict === 'detected') {
        const br = main.dateBracket;
        const when = br.lastBefore && br.firstAfter ? `uydunun gördüğü değişim aralığı ${fmtTr(br.lastBefore)} – ${fmtTr(br.firstAfter)}${br.containsPrunedAt ? ', saha tarihi bu aralıkta' : ', saha tarihi bu aralığın dışında'}` : 'uydu değişim tarihini daraltamadı';
        summary.push(`Bu parselde ${fmtTr(c.prunedAt)} tarihinde yaklaşık ${prunedM2} m² alan budanmıştır (parselin %${Math.round((prunedM2 / parcelAreaM2) * 100)}'i; olası aralık ${prunedRange[0]}–${prunedRange[1]} m²). Konum: parselin ${main.position}. Güven: ${confLabel[main.confidence]}; ${when}.`);
        const radarBits = (Object.entries(main.radar) as Array<[OrbitPass, { vh: StepTest; ratio: StepTest }]>)
            .filter(([, t]) => t.vh.delta !== null)
            .map(([pass, t]) => `${pass === 'ASCENDING' ? 'çıkış' : 'iniş'} yörüngesi VH ${(t.vh.delta as number) > 0 ? '+' : ''}${t.vh.delta} dB (z ${t.vh.z}), VH/VV ${(t.ratio.delta ?? 0) > 0 ? '+' : ''}${t.ratio.delta ?? '—'} dB`);
        summary.push(`Dayanak: ${main.pixelIds.length} Sentinel-2 pikselinde komşu çay örtüsüne göreli NDVI ortalama ${main.meanDelta} düştü (en güçlü z ${main.maxZ}); radar ${main.radarChange ? 'kesim tarihiyle örtüşen değişim görüyor' : 'anlamlı değişim görmedi'}${radarBits.length ? ` — ${radarBits.join(', ')}` : ''}.`);
        for (const k of ordered.slice(1)) summary.push(`Ayrıca parselin ${k.position}: ${k.pixelIds.length} pikselde değişim, tahmini ${k.areaM2} m² (güven ${confLabel[k.confidence]}${k.note ? `; ${k.note}` : ''}).`);
        summary.push(calibration.source === 'field'
            ? `Alan tahmini, her pikseldeki göreli NDVI düşüşünün tam budanmış piksel NDVI'si (${calibration.ndviPruned}, saha ölçümüyle kalibre, n=1) ile oranlanmasına dayanır; tam piksel üst sınırı ${counted.reduce((s, k) => s + k.areaUpperM2, 0)} m². Kalibrasyon bu vakanın saha ölçümünden geldiği için alan kıyası bağımsız değildir; konum ve tarih uydunun kendi bulgusudur.`
            : `Alan tahmini, her pikseldeki göreli NDVI düşüşünün budanmış çay örtüsü için varsayılan NDVI (${calibration.ndviPruned}) ile oranlanmasına dayanır; tam piksel üst sınırı ${counted.reduce((s, k) => s + k.areaUpperM2, 0)} m². Saha ölçümü ile kalibre edildikçe aralık daralır.`);
    } else if (verdict === 'pending') {
        summary.push(`${fmtTr(c.prunedAt)} sonrası henüz yeterli temiz Sentinel-2 sahnesi yok (piksellerin %${Math.round(pendingShare * 100)}'inde ${RULES.minAfter}'den az gözlem); test yeni sahnelerle kendiliğinden güncellenir.`);
    } else {
        summary.push(`${fmtTr(c.prunedAt)} çevresinde bu parselde komşu çay örtüsüne göre anlamlı bir NDVI basamağı bulunamadı; uydu bu tarihte bir kesim görmedi (10 m piksel; ${RULES.pixelDrop} göreli düşüş ve z ${RULES.pixelZ} eşiği).`);
    }
    for (const line of summary) console.log(`  » ${line}`);

    // Series for the charts: cluster means, the unflagged rest of the parcel, the parcel and its reference.
    const restIds = pixels.filter((p) => !p.flagged).map((p) => p.id);
    const restSeries = meanSeries(restIds.map((id) => (rel.get(id) as { ndvi: Array<number | null> }).ndvi));
    const parcelRel = relative((series.parcel as UnitSeries).ndvi, nb.ndvi);
    const radarOut = radarPasses.map((p) => ({
        pass: p.pass,
        relativeOrbit: p.relativeOrbit,
        dates: p.dates,
        clusters: Object.fromEntries(Object.entries(clusterRadar).map(([k, v]) => [k, v[p.pass] ?? []])) as Record<number, Array<number | null>>,
        rest: meanSeries(restIds.map((id) => p.vh[id] ?? [])),
    }));

    // Ground truth: compared only now.
    let groundTruth: FieldTestResult['groundTruth'] = null;
    if (c.groundTruth) {
        let gtF: Feature<Poly> | null;
        if (c.groundTruth.kind === 'polygon') gtF = intersect(featureCollection([feature(c.groundTruth.geometry), parcelF])) as Feature<Poly> | null;
        else {
            const v = tipVertex(parcel, c.groundTruth.side);
            gtF = intersect(featureCollection([circle(v, c.groundTruth.radiusM / 1000, { steps: 64, units: 'kilometers' }), parcelF])) as Feature<Poly> | null;
        }
        if (gtF) {
            const gtArea = turfArea(gtF);
            const detectedParts = pixels
                .filter((p) => p.flagged && p.cluster !== null && (clusters[p.cluster] as ClusterResult).confidence !== 'low')
                .map((p) => (grid.find((g) => g.id === p.id) as Cell).inside);
            let detectedF: Feature<Poly> | null = null;
            if (detectedParts.length === 1) detectedF = detectedParts[0] as Feature<Poly>;
            else if (detectedParts.length > 1) detectedF = union(featureCollection(detectedParts)) as Feature<Poly> | null;
            const detectedM2 = detectedF ? turfArea(detectedF) : 0;
            const overlapF = detectedF ? intersect(featureCollection([detectedF, gtF])) : null;
            const overlapM2 = overlapF ? turfArea(overlapF) : 0;
            const gtCentre = centroid(gtF).geometry.coordinates as [number, number];
            const centroidDistanceM = main ? Math.round(distance(gtCentre, main.centroid, { units: 'meters' })) : null;
            const mainInside = main !== null && centroidDistanceM !== null && overlapM2 > 0 && centroidDistanceM <= Math.sqrt(gtArea / Math.PI) + 7;
            const detectedInsideShare = detectedM2 > 0 ? r3(overlapM2 / detectedM2) : 0;
            const groundTruthCoveredShare = r3(overlapM2 / gtArea);
            const cv: GroundTruthComparison = {
                detectedM2: Math.round(detectedM2),
                overlapM2: Math.round(overlapM2),
                detectedInsideShare,
                groundTruthCoveredShare,
                centroidDistanceM,
                mainClusterInside: mainInside,
                verdict: !detectedF ? 'no_detection' : mainInside || detectedInsideShare >= 0.5 ? 'match' : overlapM2 > 0 ? 'partial' : 'miss',
                text: '',
            };
            cv.text =
                cv.verdict === 'no_detection'
                    ? 'Uydu bu parselde kesim görmediği için saha işaretiyle kıyaslanacak bir tespit yok.'
                    : cv.verdict === 'match'
                      ? `Tespit saha işaretiyle örtüşüyor: ana kümenin merkezi işaretli alanın ${mainInside ? 'içinde' : 'yakınında'} (${centroidDistanceM} m), tespit edilen alanın %${Math.round(detectedInsideShare * 100)}'i işaretli alan içinde, işaretli alanın %${Math.round(groundTruthCoveredShare * 100)}'i tespitle örtüşüyor.`
                      : cv.verdict === 'partial'
                        ? `Kısmi örtüşme: tespit edilen alanın %${Math.round(detectedInsideShare * 100)}'i işaretli alan içinde; ana küme ile işaret arasında ${centroidDistanceM} m.`
                        : `Tespit saha işaretiyle örtüşmüyor: ana küme işaretten ${centroidDistanceM} m uzakta.`;
            groundTruth = { geometry: gtF.geometry, areaM2: Math.round(gtArea), approximate: c.groundTruth.approximate ?? c.groundTruth.kind === 'tip', note: c.groundTruth.note ?? null, measuredAreaM2: measured, comparison: cv };
            console.log(`  saha kıyası: ${cv.verdict} — ${cv.text}`);
        }
    }

    return {
        id: c.id,
        block: c.block,
        parcel: c.parcel,
        prunedAt: c.prunedAt,
        reportedAt: c.reportedAt ?? null,
        source: c.source,
        note: c.note ?? null,
        parcelGeometry: parcel,
        deedAreaM2: c.deedAreaM2 ?? null,
        parcelAreaM2,
        parcelCentroid: [r6(parcelCentre[0]), r6(parcelCentre[1])],
        epsg,
        window: [from, to],
        windows: { before, after },
        reference: { pixels: refPixels, areaM2: Math.round(neighboursArea) },
        excludedDates,
        pixels,
        clusters,
        detection: { verdict, prunedM2, prunedRange, shareOfParcel: r3(prunedM2 / parcelAreaM2), mainCluster: main?.index ?? null, dateBracket: main?.dateBracket ?? null, summary },
        series: { optical: { dates, clusters: clusterSeries, rest: restSeries, parcel: parcelRel, neighbours: nb.ndvi }, radar: radarOut },
        groundTruth,
        calibration,
    };
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: { province: { type: 'string' }, district: { type: 'string' }, neighborhood: { type: 'string' }, to: { type: 'string' }, case: { type: 'string' } },
    });
    if (!values.province || !values.district || !values.neighborhood) {
        console.log(USAGE);
        process.exit(1);
    }
    const store = new NeighborhoodStore(values.province, values.district, values.neighborhood);
    const dir = join(store.dir, 'field-tests');
    const casesPath = join(dir, 'cases.json');
    if (!existsSync(casesPath)) throw new Error(`${casesPath} yok; önce saha vakalarını yazın.`);
    const file = JSON.parse(readFileSync(casesPath, 'utf8')) as { cases: FieldCase[] };
    const to = values.to ?? new Date().toISOString().slice(0, 10);
    const parcels = JSON.parse(readFileSync(join(store.dir, 'parcels-tea.geojson'), 'utf8')) as FeatureCollection<Poly, { neighborhoodId: number }>;
    const neighborhoodId = parcels.features[0]?.properties.neighborhoodId;
    if (!neighborhoodId) throw new Error('parcels-tea.geojson içinde neighborhoodId yok.');

    // Parcel geometry comes from TKGM once per case and is kept in cases.json (one request, never repeated).
    const client = new TkgmClient({ minIntervalMs: 1500, maxRetries: 3 });
    for (const c of file.cases) {
        if (c.parcelGeometry) continue;
        const p = await fetchParcel(client, neighborhoodId, c);
        c.parcelGeometry = p.geometry;
        c.deedAreaM2 = p.deedAreaM2 ?? undefined;
        c.parcelFetchedAt = new Date().toISOString();
        writeFileSync(casesPath, JSON.stringify(file, null, 2));
    }

    const ee = await initEarthEngine();
    const selected = file.cases.filter((c) => !values.case || c.id === values.case);
    const resultsPath = join(dir, 'results.json');
    const previous = existsSync(resultsPath) ? (JSON.parse(readFileSync(resultsPath, 'utf8')) as FieldTestsFile) : null;
    const results: FieldTestResult[] = [];
    for (const c of selected) {
        console.log(`Kör saha testi ${c.id} (${c.block}/${c.parcel}), saha tarihi ${c.prunedAt}, veri ${to} tarihine kadar`);
        results.push(await runCase(ee, store, c, to));
    }
    for (const r of previous?.cases ?? []) if (!results.some((x) => x.id === r.id) && file.cases.some((c) => c.id === r.id) && 'detection' in r) results.push(r);
    mkdirSync(dir, { recursive: true });
    const out: FieldTestsFile = {
        generatedAt: new Date().toISOString(),
        method: 'Kör saha testi: parsel ve bilinen kesim tarihi verilir; Sentinel-2 10 m piksellerinde komşu çay örtüsüne göreli NDVI/NBR basamağı ve Sentinel-1 VH/VV değişimiyle budanan alan uydu tarafından çizilir, alanı tahmin edilir, tarihi uydunun kendi sahnelerinden doğrulanır ve ancak sonra saha işaretiyle kıyaslanır. Budama tespit zincirinden ayrı hesaplanır.',
        rules: RULES,
        cases: results,
    };
    writeFileSync(resultsPath, JSON.stringify(out));
    console.log(`Yazıldı: ${resultsPath}`);
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
