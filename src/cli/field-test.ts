import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { evaluate, initEarthEngine } from '../ee/session.ts';
import { NeighborhoodStore } from '../library/store.ts';
import { TkgmClient } from '../tkgm/client.ts';
import { parseTurkishNumber } from '../tkgm/normalize.ts';
import { backscatterSeries, type OrbitPass } from '../radar/series.ts';

type Poly = Polygon | MultiPolygon;
type EE = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const USAGE = `
Kullanım:
  npm run field-test -- --province Trabzon --district Of --neighborhood Çataldere [--from 2025-09-01] [--to 2026-11-12] [--case 136-12-2026-11]

Bağımsız saha testi: field-tests/cases.json içindeki her saha gözlemi (ada/parsel, işaretli yer, iddialar)
için parseli TKGM'den tek sorguyla alır (bir kez), işaretli noktanın, parselin kalanının ve komşu çaylıkların
Sentinel-2 NDVI/NBR ve Sentinel-1 VH serilerini çeker ve her iddiayı basamak testiyle sınar.
Budama tespit zincirine (scan-producers / radar / fuse) dokunmaz; çıktı: field-tests/results.json
`;

/** Ground truth as the inspector recorded it. */
interface FieldCase {
    id: string;
    block: string;
    parcel: string;
    observedAt: string;
    observer: string;
    note?: string;
    spot: { kind: 'polygon'; geometry: Poly; approximate?: boolean } | { kind: 'tip'; side: 'west' | 'east' | 'north' | 'south'; radiusM: number; approximate?: boolean };
    claims: Array<{ kind: 'pruned'; between: [string, string]; label: string } | { kind: 'not_pruned'; at: string; label: string }>;
    parcelGeometry?: Poly;
    deedAreaM2?: number;
    parcelFetchedAt?: string;
}

type UnitId = 'spot' | 'rest' | 'parcel' | 'neighbours';
const UNIT_IDS: UnitId[] = ['spot', 'rest', 'parcel', 'neighbours'];

interface OpticalRow {
    id: UnitId;
    date: string;
    ndvi: number | null;
    nbr: number | null;
    count: number;
}

export interface StepTest {
    nBefore: number;
    nAfter: number;
    meanBefore: number | null;
    meanAfter: number | null;
    sdBefore: number | null;
    delta: number | null;
    z: number | null;
}

export type ClaimVerdict = 'supports' | 'contradicts' | 'unclear' | 'pending';

export interface FieldTestResult {
    id: string;
    block: string;
    parcel: string;
    observedAt: string;
    observer: string;
    note: string | null;
    parcelGeometry: Poly;
    deedAreaM2: number | null;
    spot: { geometry: Poly; areaM2: number; approximate: boolean; description: string };
    pixels: Record<UnitId, number>;
    window: [string, string];
    series: {
        optical: { dates: string[]; units: Record<UnitId, { ndvi: Array<number | null>; nbr: Array<number | null>; clearShare: Array<number | null> }> };
        radar: Array<{ pass: OrbitPass; relativeOrbit: number; dates: string[]; units: Record<UnitId, { vh: Array<number | null>; vv: Array<number | null> }> }>;
    };
    claims: Array<{
        kind: 'pruned' | 'not_pruned';
        label: string;
        dates: string[];
        windows: { before: [string, string]; after: [string, string] } | null;
        tests: Record<string, StepTest>;
        verdict: ClaimVerdict;
        reason: string;
    }>;
}

export interface FieldTestsFile {
    generatedAt: string;
    method: string;
    rules: typeof RULES;
    cases: FieldTestResult[];
}

const RULES = {
    beforeDays: 75,
    afterDays: 75,
    minObs: 2,
    minObsFirm: 3,
    /** Relative NDVI drop (unit − neighbours) that counts as a pruning-sized step; small units get the lenient figure. */
    ndviDrop: 0.12,
    ndviDropSmall: 0.1,
    zStep: 2.0,
    zFirm: 2.8,
    /** VH drop (dB, relative to neighbours) that corroborates a cut. */
    vhDropDb: 1.0,
    clearShareMin: 0.5,
    /** Units up to this area (six 10 m pixels) use the lenient thresholds: a few pixels carry the whole signal. */
    smallUnitAreaM2: 600,
};

const DAY = 86_400_000;
const addDays = (date: string, days: number) => new Date(Date.parse(date) + days * DAY).toISOString().slice(0, 10);
const r3 = (v: number) => Math.round(v * 1000) / 1000;

function mean(xs: number[]): number | null {
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
function sd(xs: number[]): number | null {
    if (xs.length < 2) return null;
    const m = mean(xs) as number;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/** Before-mean vs after-mean step, in units of the before-window noise. */
function stepTest(dates: string[], values: Array<number | null>, before: [string, string], after: [string, string], floor: number): StepTest {
    const pick = (w: [string, string]) => dates.map((d, i) => (d >= w[0] && d < w[1] ? values[i] : null)).filter((v): v is number => v !== null);
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
    return unit.map((v, i) => (v === null || ref[i] === null || ref[i] === undefined ? null : r3(v - (ref[i] as number))));
}

/** Westernmost (etc.) vertex of the outer ring(s). */
function tipVertex(geometry: Poly, side: 'west' | 'east' | 'north' | 'south'): [number, number] {
    const rings = geometry.type === 'Polygon' ? [geometry.coordinates[0]] : geometry.coordinates.map((p) => p[0]);
    const pts = rings.flat().map((p) => [p[0] as number, p[1] as number] as [number, number]);
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
function neighbourTea(ee: EE, storeDir: string, parcelEe: EE, bufferM: number): EE {
    const fc = JSON.parse(readFileSync(join(storeDir, 'tea-patches.geojson'), 'utf8')) as FeatureCollection<Poly, { areaM2: number }>;
    const patches = ee.FeatureCollection(fc.features.map((f) => ee.Feature(ee.Geometry(f.geometry), { areaM2: f.properties.areaM2 })));
    return patches.filterBounds(parcelEe.buffer(bufferM)).geometry().intersection(parcelEe.buffer(bufferM), 1).difference(parcelEe.buffer(5), 1);
}

async function opticalRows(ee: EE, fc: EE, from: string, to: string): Promise<OpticalRow[]> {
    const cloudScore = ee.ImageCollection('GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED');
    const col = ee
        .ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
        .filterBounds(fc.geometry().bounds())
        .filterDate(from, to)
        .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 80))
        .linkCollection(cloudScore, ['cs_cdf'])
        .sort('system:time_start');
    const perImage = col
        .map((image: EE) => {
            const scaled = image.select(['B3', 'B4', 'B8', 'B11', 'B12']).divide(10_000);
            const clear = image.select('cs_cdf').gte(0.6).and(scaled.normalizedDifference(['B3', 'B11']).lt(0.4)).and(image.select('SCL').neq(11));
            const img = scaled.normalizedDifference(['B8', 'B4']).rename('ndvi').addBands(scaled.normalizedDifference(['B8', 'B12']).rename('nbr')).updateMask(clear);
            const date = ee.Date(image.get('system:time_start')).format('YYYY-MM-dd');
            return img
                .reduceRegions({ collection: fc, reducer: ee.Reducer.mean().combine(ee.Reducer.count(), '', true), scale: 10, tileScale: 4 })
                .map((f: EE) => f.set('date', date));
        })
        .flatten()
        .select(['id', 'date', 'ndvi_mean', 'ndvi_count', 'nbr_mean'], null, false);
    const out = await evaluate<{ features: Array<{ properties: { id: UnitId; date: string; ndvi_mean: number | null; ndvi_count: number | null; nbr_mean: number | null } }> }>(perImage);
    return out.features.map(({ properties: p }) => ({ id: p.id, date: p.date, ndvi: p.ndvi_mean ?? null, nbr: p.nbr_mean ?? null, count: p.ndvi_count ?? 0 }));
}

function judgePruned(c: FieldCase['claims'][number] & { kind: 'pruned' }, dates: string[], rel: Record<string, Array<number | null>>, radar: FieldTestResult['series']['radar'], small: boolean, to: string): FieldTestResult['claims'][number] {
    const before: [string, string] = [addDays(c.between[0], -RULES.beforeDays), c.between[0]];
    const after: [string, string] = [c.between[1], addDays(to, 1)];
    const tests: Record<string, StepTest> = {
        spotNdvi: stepTest(dates, rel.spotNdvi as Array<number | null>, before, after, 0.03),
        spotNbr: stepTest(dates, rel.spotNbr as Array<number | null>, before, after, 0.03),
        restNdvi: stepTest(dates, rel.restNdvi as Array<number | null>, before, after, 0.03),
    };
    for (const p of radar) tests[`spotVh_${p.pass}`] = stepTest(p.dates, relative(p.units.spot.vh, p.units.neighbours.vh), before, after, 0.6);
    const t = tests.spotNdvi as StepTest;
    const drop = small ? RULES.ndviDropSmall : RULES.ndviDrop;
    const vhAfter = radar.map((p) => tests[`spotVh_${p.pass}`] as StepTest).filter((x) => x.nAfter >= 1);
    const vhSupports = vhAfter.some((x) => x.delta !== null && x.delta <= -RULES.vhDropDb && (x.z ?? 0) >= RULES.zStep);
    const early = vhAfter.filter((x) => x.delta !== null && x.delta <= -RULES.vhDropDb);
    let verdict: ClaimVerdict;
    let reason: string;
    if (t.nAfter < RULES.minObs && vhAfter.every((x) => x.nAfter < RULES.minObs)) {
        verdict = 'pending';
        reason = `Budama sonrası henüz ${t.nAfter} temiz optik gözlem${vhAfter.length ? ` ve en çok ${Math.max(...vhAfter.map((x) => x.nAfter))} radar geçişi` : ''} var; en az ${RULES.minObs} gerekir.${early.length ? ` İlk radar geçişi düşüş gösteriyor (VH ${early.map((x) => x.delta).join(' / ')} dB), ikinci geçişle teyit beklenir.` : ''} Yeni sahneler geldikçe test kendiliğinden güncellenir.`;
    } else if (t.delta !== null && t.delta <= -drop && (t.z ?? 0) >= RULES.zStep) {
        verdict = 'supports';
        reason = `İşaretli alanın komşulara göreli NDVI'si ${t.delta} düştü (z ${t.z}, ${t.nBefore} önce / ${t.nAfter} sonra gözlem)${vhSupports ? '; radar VH düşüşü de uyumlu' : ''}.`;
    } else if (t.nAfter >= RULES.minObsFirm && t.delta !== null && t.delta > -drop / 3) {
        verdict = 'contradicts';
        reason = `${t.nAfter} sonra gözleme rağmen göreli NDVI düşmedi (fark ${t.delta}); uydu bu büyüklükte bir alanda kesimi görmedi.`;
    } else if (vhSupports) {
        verdict = 'supports';
        reason = `Optik basamak eşiğin altında (fark ${t.delta ?? '—'}, z ${t.z ?? '—'}) ama radar VH düşüşü kesimi gösteriyor.`;
    } else {
        verdict = 'unclear';
        reason = `Göreli NDVI farkı ${t.delta ?? '—'} (z ${t.z ?? '—'}, ${t.nBefore} önce / ${t.nAfter} sonra): eşik ${-drop} / z ${RULES.zStep} henüz karşılanmadı.`;
    }
    return { kind: 'pruned', label: c.label, dates: [...c.between], windows: { before, after }, tests, verdict, reason };
}

function judgeNotPruned(c: FieldCase['claims'][number] & { kind: 'not_pruned' }, dates: string[], rel: Array<number | null>, small: boolean): FieldTestResult['claims'][number] {
    // Largest pruning-shaped step with its change date in ±60 days of the claim; none → nothing was cut.
    const lo = addDays(c.at, -60);
    const hi = addDays(c.at, 60);
    const drop = small ? RULES.ndviDropSmall : RULES.ndviDrop;
    let best: { t: StepTest; at: string } | null = null;
    for (const d of dates) {
        if (d < lo || d > hi) continue;
        const t = stepTest(dates, rel, [addDays(d, -RULES.beforeDays), d], [d, addDays(d, RULES.afterDays)], 0.03);
        if (t.nBefore < RULES.minObsFirm || t.nAfter < RULES.minObsFirm || t.delta === null) continue;
        if (!best || t.delta < (best.t.delta as number)) best = { t, at: d };
    }
    if (!best) return { kind: 'not_pruned', label: c.label, dates: [c.at], windows: null, tests: {}, verdict: 'pending', reason: 'Tarih çevresinde yeterli temiz gözlem yok (her iki yanda en az 3 gerekir).' };
    const t = best.t;
    const stepped = t.delta !== null && t.delta <= -drop && (t.z ?? 0) >= RULES.zFirm;
    return {
        kind: 'not_pruned',
        label: c.label,
        dates: [c.at],
        windows: { before: [addDays(best.at, -RULES.beforeDays), best.at], after: [best.at, addDays(best.at, RULES.afterDays)] },
        tests: { spotNdvi: t },
        verdict: stepped ? 'contradicts' : 'supports',
        reason: stepped
            ? `${best.at} tarihinde göreli NDVI ${t.delta} düştü (z ${t.z}): uydu bu dönemde bir kesim görüyor.`
            : `Tarih çevresindeki en büyük düşüş ${t.delta} (z ${t.z}, ${best.at}); budama boyutunda bir basamak yok.`,
    };
}

async function runCase(ee: EE, store: NeighborhoodStore, c: FieldCase, from: string, to: string): Promise<FieldTestResult> {
    const parcel = c.parcelGeometry as Poly;
    const parcelEe = ee.Geometry(parcel);
    // The marked spot: an explicit polygon, or a disc around the parcel's tip clipped to the parcel.
    let spotEe: EE;
    let description: string;
    if (c.spot.kind === 'polygon') {
        spotEe = ee.Geometry(c.spot.geometry);
        description = 'Gözlemcinin çizdiği alan';
    } else {
        const v = tipVertex(parcel, c.spot.side);
        spotEe = ee.Geometry.Point(v).buffer(c.spot.radiusM).intersection(parcelEe, 1);
        description = `Parselin ${c.spot.side === 'west' ? 'batı' : c.spot.side === 'east' ? 'doğu' : c.spot.side === 'north' ? 'kuzey' : 'güney'} ucu, ${c.spot.radiusM} m yarıçap`;
    }
    const restEe = parcelEe.difference(spotEe, 1);
    const neighboursEe = neighbourTea(ee, store.dir, parcelEe, 300);
    const [spotGeom, spotArea, restGeom, neighboursGeom, neighboursArea] = await Promise.all([
        evaluate<Poly>(spotEe),
        evaluate<number>(spotEe.area(1)),
        evaluate<Poly>(restEe),
        evaluate<Poly>(neighboursEe),
        evaluate<number>(neighboursEe.area(1)),
    ]);
    if (neighboursArea < 2000) throw new Error(`Parselin 300 m çevresinde yeterli çay örtüsü yok (${Math.round(neighboursArea)} m²); referans kurulamadı.`);
    const units: Array<{ id: UnitId; geometry: Poly; ee: EE }> = [
        { id: 'spot', geometry: spotGeom, ee: spotEe },
        { id: 'rest', geometry: restGeom, ee: restEe },
        { id: 'parcel', geometry: parcel, ee: parcelEe },
        { id: 'neighbours', geometry: neighboursGeom, ee: neighboursEe },
    ];
    const fc = ee.FeatureCollection(units.map((u) => ee.Feature(u.ee, { id: u.id })));
    console.log(`  işaretli alan ${Math.round(spotArea)} m² · komşu çay örtüsü ${Math.round(neighboursArea)} m²`);

    console.log('  Sentinel-2 serisi çekiliyor…');
    const rows = await opticalRows(ee, fc, from, addDays(to, 1));
    // Pixel totals on Sentinel-2's own grid: the most pixels any scene saw clear in the unit (edge pixels included).
    const pixels = Object.fromEntries(UNIT_IDS.map((id) => [id, Math.max(0, ...rows.filter((r) => r.id === id).map((r) => r.count))])) as Record<UnitId, number>;
    console.log(`  piksel (10 m): işaretli alan ${pixels.spot} · parsel ${pixels.parcel} · komşu çaylık ${pixels.neighbours}`);
    // One row per date and unit (same-day granules → the one that saw more); a unit counts only when half its pixels were clear.
    const byKey = new Map<string, OpticalRow>();
    for (const r of rows) {
        const k = `${r.id}|${r.date}`;
        const prev = byKey.get(k);
        if (!prev || r.count > prev.count) byKey.set(k, r);
    }
    const dates = [...new Set(rows.map((r) => r.date))].sort();
    const optical = { dates, units: {} as FieldTestResult['series']['optical']['units'] };
    for (const id of UNIT_IDS) {
        const get = (d: string) => byKey.get(`${id}|${d}`);
        const ok = (r: OpticalRow | undefined) => !!r && pixels[id] > 0 && r.count / pixels[id] >= RULES.clearShareMin && r.ndvi !== null;
        optical.units[id] = {
            ndvi: dates.map((d) => (ok(get(d)) ? r3((get(d) as OpticalRow).ndvi as number) : null)),
            nbr: dates.map((d) => (ok(get(d)) ? r3((get(d) as OpticalRow).nbr as number) : null)),
            clearShare: dates.map((d) => (get(d) && pixels[id] > 0 ? r3((get(d) as OpticalRow).count / pixels[id]) : null)),
        };
    }
    console.log(`  ${dates.length} sahne; işaretli alanda temiz gözlem ${optical.units.spot.ndvi.filter((v) => v !== null).length}`);

    const radar: FieldTestResult['series']['radar'] = [];
    const region = parcelEe.buffer(1500);
    for (const pass of ['ASCENDING', 'DESCENDING'] as OrbitPass[]) {
        console.log(`  Sentinel-1 ${pass} serisi çekiliyor…`);
        const s = await backscatterSeries(ee, region, units.map((u) => ({ id: u.id, geometry: u.geometry })), [from, addDays(to, 1)], pass);
        if (!s) continue;
        radar.push({ pass, relativeOrbit: s.relativeOrbit, dates: s.dates, units: Object.fromEntries(UNIT_IDS.map((id) => [id, { vh: s.gardens[id]?.vh ?? [], vv: s.gardens[id]?.vv ?? [] }])) as Record<UnitId, { vh: Array<number | null>; vv: Array<number | null> }> });
        console.log(`    yörünge ${s.relativeOrbit}: ${s.dates.length} geçiş`);
    }

    const rel = {
        spotNdvi: relative(optical.units.spot.ndvi, optical.units.neighbours.ndvi),
        spotNbr: relative(optical.units.spot.nbr, optical.units.neighbours.nbr),
        restNdvi: relative(optical.units.rest.ndvi, optical.units.neighbours.ndvi),
    };
    const small = spotArea <= RULES.smallUnitAreaM2;
    const claims = c.claims.map((cl) => (cl.kind === 'pruned' ? judgePruned(cl, dates, rel, radar, small, to) : judgeNotPruned(cl, dates, rel.spotNdvi, small)));
    for (const cl of claims) console.log(`  ${cl.label}: ${cl.verdict} — ${cl.reason}`);
    return {
        id: c.id,
        block: c.block,
        parcel: c.parcel,
        observedAt: c.observedAt,
        observer: c.observer,
        note: c.note ?? null,
        parcelGeometry: parcel,
        deedAreaM2: c.deedAreaM2 ?? null,
        spot: { geometry: spotGeom, areaM2: Math.round(spotArea), approximate: c.spot.approximate ?? c.spot.kind === 'tip', description },
        pixels,
        window: [from, to],
        series: { optical, radar },
        claims,
    };
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: { province: { type: 'string' }, district: { type: 'string' }, neighborhood: { type: 'string' }, from: { type: 'string', default: '2025-09-01' }, to: { type: 'string' }, case: { type: 'string' } },
    });
    if (!values.province || !values.district || !values.neighborhood) {
        console.log(USAGE);
        process.exit(1);
    }
    const store = new NeighborhoodStore(values.province, values.district, values.neighborhood);
    const dir = join(store.dir, 'field-tests');
    const casesPath = join(dir, 'cases.json');
    if (!existsSync(casesPath)) throw new Error(`${casesPath} yok; önce saha gözlemlerini yazın.`);
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
        console.log(`Saha testi ${c.id} (${c.block}/${c.parcel}), ${values.from} → ${to}`);
        results.push(await runCase(ee, store, { ...c, neighborhoodId } as FieldCase, values.from as string, to));
    }
    // Cases not selected this run keep their previous result.
    for (const r of previous?.cases ?? []) if (!results.some((x) => x.id === r.id) && file.cases.some((c) => c.id === r.id)) results.push(r);
    mkdirSync(dir, { recursive: true });
    const out: FieldTestsFile = {
        generatedAt: new Date().toISOString(),
        method: 'Bağımsız saha testi: işaretli alanın komşu çaylıklara göreli Sentinel-2 NDVI/NBR ve Sentinel-1 VH basamağı; budama tespit zincirinden ayrı hesaplanır.',
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
