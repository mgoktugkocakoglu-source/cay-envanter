import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MultiPolygon, Polygon } from 'geojson';
import { evaluate } from '../ee/session.ts';
import { STATIONS, type StationNormals } from './sources.ts';

/* `ee` objects are untyped (see src/types/earthengine.d.ts). */
type EE = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Poly = Polygon | MultiPolygon;

const ERA5_SCALE_M = 11132;
const CHIRPS_SCALE_M = 5566;
const LAPSE_C_PER_M = 0.0065;
const STATION_MAX_KM = 160;
/** Years fetched per Earth Engine round trip when filling the cache. */
const CHUNK_YEARS = 6;

/** One calendar year of daily model values (cached per year). */
interface YearChunk {
    year: number;
    dates: string[];
    tmean: number[];
    tmax: number[];
    tmin: number[];
    dewpoint: number[];
    precipEra: number[];
    precipChirps: Array<number | null>;
}

/** Daily series for the neighbourhood: ERA5-Land (11 km) + CHIRPS (5 km), lapse-corrected and station-anchored. */
export interface DailyClimate {
    dates: string[];
    /** Temperatures at the reference elevation, anchored to MGM station normals (°C). */
    tmean: number[];
    tmax: number[];
    tmin: number[];
    dewpoint: number[];
    /** Daily precipitation anchored to MGM normals (mm); model series kept for transparency. */
    precip: number[];
    precipEra: number[];
    precipChirps: Array<number | null>;
    lapse: { neighbourhoodElevationM: number; cellElevationM: number; correctionC: number };
    anchor: StationAnchor;
}

export interface StationAnchor {
    stations: Array<{ id: string; name: string; distanceKm: number; weight: number; elevationM: number; period: string }>;
    /** Interpolated station normals at the neighbourhood (temperatures shifted to the reference elevation). */
    normal: { tmean: number[]; tmax: number[]; tmin: number[]; precipMm: number[]; rainDays: number[]; annualPrecipMm: number; annualTmean: number };
    /** Model climatology before anchoring (same months), for the comparison table. */
    model: { tmean: number[]; precipEra: number[]; precipChirps: number[]; years: number[] };
    monthlyOffsetC: number[];
    monthlyPrecipRatio: number[];
}

export async function meanElevation(ee: EE, geometries: Poly[], scale = 90): Promise<number | null> {
    if (geometries.length === 0) return null;
    const demCollection = ee.ImageCollection('COPERNICUS/DEM/GLO30').select('DEM');
    const dem = demCollection.mosaic().setDefaultProjection(demCollection.first().projection());
    const geometry = ee.FeatureCollection(geometries.map((g) => ee.Feature(ee.Geometry(g)))).geometry(1);
    const r = await evaluate<{ DEM: number | null }>(dem.reduceRegion({ reducer: ee.Reducer.mean(), geometry, scale, bestEffort: true }));
    return typeof r.DEM === 'number' ? r.DEM : null;
}

const emptyChunk = (year: number): YearChunk => ({ year, dates: [], tmean: [], tmax: [], tmin: [], dewpoint: [], precipEra: [], precipChirps: [] });

/** Fetches the daily series for the years `fromYear..toYear` (inclusive, capped at `end`) in one ERA5 and one CHIRPS call. */
async function fetchYears(ee: EE, region: EE, fromYear: number, toYear: number, end: string): Promise<YearChunk[]> {
    const start = `${fromYear}-01-01`;
    const next = `${toYear + 1}-01-01`;
    const stop = next < end ? next : end;
    const era = ee
        .ImageCollection('ECMWF/ERA5_LAND/DAILY_AGGR')
        .filterDate(start, stop)
        .select(['temperature_2m', 'temperature_2m_max', 'temperature_2m_min', 'dewpoint_temperature_2m', 'total_precipitation_sum']);
    const eraRows = era.map((img: EE) => ee.Feature(null, img.reduceRegion({ reducer: ee.Reducer.mean(), geometry: region, scale: ERA5_SCALE_M, bestEffort: true })).set('date', img.date().format('YYYY-MM-dd')));
    const eraList = await evaluate<Array<Array<number | string | null>>>(
        eraRows.reduceColumns(ee.Reducer.toList(6), ['date', 'temperature_2m', 'temperature_2m_max', 'temperature_2m_min', 'dewpoint_temperature_2m', 'total_precipitation_sum']).get('list'),
    );
    const chirps = ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY').filterDate(start, stop).select('precipitation');
    const chirpsRows = chirps.map((img: EE) => ee.Feature(null, img.reduceRegion({ reducer: ee.Reducer.mean(), geometry: region, scale: CHIRPS_SCALE_M, bestEffort: true })).set('date', img.date().format('YYYY-MM-dd')));
    const chirpsList = await evaluate<Array<Array<number | string | null>>>(chirpsRows.reduceColumns(ee.Reducer.toList(2), ['date', 'precipitation']).get('list'));
    const chirpsByDate = new Map(chirpsList.map((r) => [String(r[0]), typeof r[1] === 'number' ? r[1] : null]));
    const byYear = new Map<number, YearChunk>();
    for (const r of eraList.sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
        const [date, t, tx, tn, td, p] = r;
        if (typeof t !== 'number') continue;
        const year = Number(String(date).slice(0, 4));
        let c = byYear.get(year);
        if (!c) {
            c = emptyChunk(year);
            byYear.set(year, c);
        }
        c.dates.push(String(date));
        c.tmean.push(t - 273.15);
        c.tmax.push((tx as number) - 273.15);
        c.tmin.push((tn as number) - 273.15);
        c.dewpoint.push((td as number) - 273.15);
        c.precipEra.push(Math.max(0, ((p as number) ?? 0) * 1000));
        c.precipChirps.push(chirpsByDate.get(String(date)) ?? null);
    }
    return Array.from({ length: toYear - fromYear + 1 }, (_, i) => byYear.get(fromYear + i) ?? emptyChunk(fromYear + i));
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const r = (x: number) => (x * Math.PI) / 180;
    const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Inverse-distance-weighted MGM normals at the neighbourhood, with station temperatures moved to the
 * reference elevation by the lapse rate. Then monthly offsets (temperature) and ratios (precipitation)
 * between those normals and the model climatology are applied to every day of the series.
 */
function anchorToStations(chunks: YearChunk[], lat: number, lng: number, refElev: number, correctionC: number): { anchor: StationAnchor; apply: (c: YearChunk) => { tmean: number[]; tmax: number[]; tmin: number[]; dewpoint: number[]; precip: number[] } } {
    const candidates = STATIONS.filter((s) => s.anchor !== false).map((s) => ({ s, km: haversineKm(lat, lng, s.lat, s.lng) })).sort((a, b) => a.km - b.km);
    const near = candidates.filter((x) => x.km <= STATION_MAX_KM);
    const used = near.length ? near : candidates.slice(0, 1);
    const wsum = used.reduce((acc, x) => acc + 1 / Math.max(1, x.km) ** 2, 0);
    const weights = used.map((x) => 1 / Math.max(1, x.km) ** 2 / wsum);
    const interp = (pick: (s: StationNormals) => number[], shift: boolean) =>
        Array.from({ length: 12 }, (_, m) => used.reduce((acc, x, i) => acc + weights[i]! * (pick(x.s)[m]! - (shift ? (refElev - x.s.elevationM) * LAPSE_C_PER_M : 0)), 0));
    const normal = {
        tmean: interp((s) => s.tmean, true).map(round1),
        tmax: interp((s) => s.tmax, true).map(round1),
        tmin: interp((s) => s.tmin, true).map(round1),
        precipMm: interp((s) => s.precipMm, false).map((v) => Math.round(v)),
        rainDays: interp((s) => s.rainDays, false).map(round1),
        annualPrecipMm: 0,
        annualTmean: 0,
    };
    normal.annualPrecipMm = normal.precipMm.reduce((a, b) => a + b, 0);
    normal.annualTmean = round1(mean(normal.tmean));

    // Model climatology over the complete years (lapse-corrected temperatures).
    const full = chunks.filter((c) => c.dates.length >= 360);
    const monthT: number[][] = Array.from({ length: 12 }, () => []);
    const monthPEra: number[][] = Array.from({ length: 12 }, () => []);
    const monthPCh: number[][] = Array.from({ length: 12 }, () => []);
    for (const c of full) {
        const pe = new Array(12).fill(0);
        const pc = new Array(12).fill(0);
        const tsum = new Array(12).fill(0);
        const tn = new Array(12).fill(0);
        c.dates.forEach((d, i) => {
            const m = Number(d.slice(5, 7)) - 1;
            pe[m] += c.precipEra[i]!;
            pc[m] += c.precipChirps[i] ?? c.precipEra[i]!;
            tsum[m] += c.tmean[i]! + correctionC;
            tn[m]++;
        });
        for (let m = 0; m < 12; m++) {
            if (tn[m] > 20) {
                monthT[m]!.push(tsum[m] / tn[m]);
                monthPEra[m]!.push(pe[m]);
                monthPCh[m]!.push(pc[m]);
            }
        }
    }
    const modelT = monthT.map((xs) => round1(mean(xs)));
    const modelPEra = monthPEra.map((xs) => Math.round(mean(xs)));
    const modelPCh = monthPCh.map((xs) => Math.round(mean(xs)));
    const offset = modelT.map((t, m) => (Number.isFinite(t) ? round2(normal.tmean[m]! - t) : 0));
    const ratio = modelPEra.map((p, m) => (p > 0 ? Math.max(0.4, Math.min(3, round2(normal.precipMm[m]! / p))) : 1));
    const anchor: StationAnchor = {
        stations: used.map((x, i) => ({ id: x.s.id, name: x.s.name, distanceKm: Math.round(x.km), weight: round2(weights[i]!), elevationM: x.s.elevationM, period: x.s.period })),
        normal,
        model: { tmean: modelT, precipEra: modelPEra, precipChirps: modelPCh, years: full.map((c) => c.year) },
        monthlyOffsetC: offset,
        monthlyPrecipRatio: ratio,
    };
    const apply = (c: YearChunk) => {
        const idx = c.dates.map((d) => Number(d.slice(5, 7)) - 1);
        return {
            tmean: c.tmean.map((v, i) => v + correctionC + offset[idx[i]!]!),
            tmax: c.tmax.map((v, i) => v + correctionC + offset[idx[i]!]!),
            tmin: c.tmin.map((v, i) => v + correctionC + offset[idx[i]!]!),
            dewpoint: c.dewpoint.map((v, i) => v + correctionC + offset[idx[i]!]!),
            precip: c.precipEra.map((v, i) => v * ratio[idx[i]!]!),
        };
    };
    return { anchor, apply };
}

/**
 * Loads the daily series from `fromYear` to today (cached per year under `cacheDir/climate-<year>.json`,
 * missing years fetched in runs of CHUNK_YEARS), lapse-corrects to `referenceElevationM` and anchors the
 * result to the nearest MGM stations.
 */
export async function loadDailyClimate(
    ee: EE,
    boundary: Poly,
    fromYear: number,
    today: string,
    referenceElevationM: number | null,
    cacheDir: string,
    refetch: boolean,
    log: (s: string) => void,
): Promise<DailyClimate> {
    mkdirSync(cacheDir, { recursive: true });
    const region = ee.Geometry(boundary);
    const demCollection = ee.ImageCollection('COPERNICUS/DEM/GLO30').select('DEM');
    const dem = demCollection.mosaic().setDefaultProjection(demCollection.first().projection());
    const boundaryElev = await evaluate<{ DEM: number }>(dem.reduceRegion({ reducer: ee.Reducer.mean(), geometry: region, scale: 90, bestEffort: true }));
    const cellElev = await evaluate<{ DEM: number }>(dem.reduceRegion({ reducer: ee.Reducer.mean(), geometry: region.buffer(ERA5_SCALE_M / 2), scale: 250, bestEffort: true }));
    const refElev = referenceElevationM ?? boundaryElev.DEM;
    const correctionC = round2((cellElev.DEM - refElev) * LAPSE_C_PER_M);
    const centroid = await evaluate<{ coordinates: [number, number] }>(region.centroid(1));
    const [lng, lat] = centroid.coordinates;

    const thisYear = Number(today.slice(0, 4));
    const staleBefore = new Date(Date.parse(today) - 7 * 86400000).toISOString().slice(0, 10);
    const loaded = new Map<number, YearChunk>();
    const missing: number[] = [];
    for (let year = fromYear; year <= thisYear; year++) {
        const path = join(cacheDir, `climate-${year}.json`);
        if (existsSync(path) && !refetch) {
            const chunk = JSON.parse(readFileSync(path, 'utf8')) as YearChunk;
            // The running year is refreshed when its cache is more than a week behind.
            const stale = year === thisYear && (chunk.dates.at(-1) ?? '') < staleBefore;
            if (!stale) {
                loaded.set(year, chunk);
                continue;
            }
        }
        missing.push(year);
    }
    let i = 0;
    while (i < missing.length) {
        const from = missing[i]!;
        let to = from;
        while (i + 1 < missing.length && missing[i + 1] === to + 1 && to - from + 1 < CHUNK_YEARS) {
            i++;
            to++;
        }
        i++;
        const fetched = await fetchYears(ee, region, from, to, today);
        for (const c of fetched) {
            writeFileSync(join(cacheDir, `climate-${c.year}.json`), JSON.stringify(c));
            loaded.set(c.year, c);
        }
        log(`  ${from}–${to}: ${fetched.reduce((s, c) => s + c.dates.length, 0)} gün çekildi`);
    }
    const chunks: YearChunk[] = [];
    for (let year = fromYear; year <= thisYear; year++) {
        const c = loaded.get(year);
        if (c && c.dates.length) chunks.push(c);
    }
    const { anchor, apply } = anchorToStations(chunks, lat, lng, refElev, correctionC);
    const out: DailyClimate = {
        dates: [], tmean: [], tmax: [], tmin: [], dewpoint: [], precip: [], precipEra: [], precipChirps: [],
        lapse: { neighbourhoodElevationM: Math.round(refElev), cellElevationM: Math.round(cellElev.DEM), correctionC },
        anchor,
    };
    for (const c of chunks) {
        const a = apply(c);
        out.dates.push(...c.dates);
        out.tmean.push(...a.tmean);
        out.tmax.push(...a.tmax);
        out.tmin.push(...a.tmin);
        out.dewpoint.push(...a.dewpoint);
        out.precip.push(...a.precip);
        out.precipEra.push(...c.precipEra);
        out.precipChirps.push(...c.precipChirps);
    }
    return out;
}

// ───────────────────────── summaries ─────────────────────────

/** Year / month / month-day of every date, computed once per series. */
interface DateIndex { y: Int16Array; m: Int8Array; md: string[] }
const DATE_INDEX = new WeakMap<DailyClimate, DateIndex>();
function dateIndex(d: DailyClimate): DateIndex {
    let idx = DATE_INDEX.get(d);
    if (!idx) {
        const built: DateIndex = { y: new Int16Array(d.dates.length), m: new Int8Array(d.dates.length), md: new Array<string>(d.dates.length) };
        d.dates.forEach((date, i) => {
            built.y[i] = Number(date.slice(0, 4));
            built.m[i] = Number(date.slice(5, 7));
            built.md[i] = date.slice(5);
        });
        DATE_INDEX.set(d, built);
        idx = built;
    }
    return idx;
}

export interface ClimatePeriod {
    period: string;
    days: number;
    tmean: number;
    tmaxMean: number;
    tminMean: number;
    tminAbs: number;
    tmaxAbs: number;
    rhMean: number;
    precipMm: number;
    rainDays: number;
    frostDays: number;
    hotDays: number;
    gdd10: number;
    drySpellMax: number;
}

export interface ClimateWindowRule {
    key: string;
    label: string;
    from: string;
    to: string;
    why: string;
    sources: string[];
}

export const CLIMATE_WINDOWS: ClimateWindowRule[] = [
    { key: 'chestnut_bloom', label: 'Kestane çiçeklenmesi (bal)', from: '06-01', to: '07-15', why: 'Çiçek yağmura hassastır; yağışlı/soğuk çiçeklenme nektarı ve arı uçuşunu keser, kuru pencere bal verimini artırır.', sources: ['duzce-kestane-bali-ci', 'ayder-bali-ci'] },
    { key: 'tea_flush', label: 'Çay sürgün dönemi', from: '05-01', to: '09-30', why: 'Yaz kuraklığı ve 30 °C üstü günler sürgünü yavaşlatır; yağış dağılımı hasat sayısını belirler.', sources: ['au-cay-ders'] },
    { key: 'hazelnut_bloom', label: 'Fındık çiçeklenmesi', from: '12-15', to: '02-28', why: 'Çiçeklenmede sert don ve yoğun yağış tozlaşmayı düşürür; −8/−10 °C altı zararlıdır.', sources: ['au-findik-ders', 'akcakoca-findik-ci'] },
    { key: 'spring_frost', label: 'İlkbahar geç donu', from: '03-15', to: '04-30', why: 'Kivi sürgünleri −0,5 °C’de, fındık sürgünleri −2/−3 °C’de zarar görür.', sources: ['tagem-kivi-2022', 'akcakoca-findik-ci'] },
    { key: 'hazelnut_fill', label: 'Fındık meyve dolumu (nem)', from: '06-01', to: '07-31', why: 'Haziran–Temmuz oransal nemi %60’ın altına düşerse ürün olumsuz etkilenir.', sources: ['akcakoca-findik-ci'] },
];

export function relativeHumidity(t: number, td: number): number {
    const e = (x: number) => Math.exp((17.625 * x) / (243.04 + x));
    return Math.max(0, Math.min(100, (100 * e(td)) / e(t)));
}

function summarise(period: string, idx: number[], d: DailyClimate): ClimatePeriod {
    const precip = idx.map((i) => d.precip[i]!);
    let dry = 0;
    let dryMax = 0;
    for (const p of precip) {
        dry = p < 1 ? dry + 1 : 0;
        dryMax = Math.max(dryMax, dry);
    }
    return {
        period,
        days: idx.length,
        tmean: round1(mean(idx.map((i) => d.tmean[i]!))),
        tmaxMean: round1(mean(idx.map((i) => d.tmax[i]!))),
        tminMean: round1(mean(idx.map((i) => d.tmin[i]!))),
        tminAbs: round1(Math.min(...idx.map((i) => d.tmin[i]!))),
        tmaxAbs: round1(Math.max(...idx.map((i) => d.tmax[i]!))),
        rhMean: round1(mean(idx.map((i) => relativeHumidity(d.tmean[i]!, d.dewpoint[i]!)))),
        precipMm: Math.round(precip.reduce((a, b) => a + b, 0)),
        rainDays: precip.filter((p) => p >= 1).length,
        frostDays: idx.filter((i) => d.tmin[i]! < 0).length,
        hotDays: idx.filter((i) => d.tmax[i]! >= 30).length,
        gdd10: Math.round(idx.reduce((s, i) => s + Math.max(0, d.tmean[i]! - 10), 0)),
        drySpellMax: dryMax,
    };
}

/** Hours below 7.2 °C in a day, from the daily extremes (linear day approximation). */
function chillHoursOfDay(tmin: number, tmax: number, threshold = 7.2): number {
    if (tmax <= threshold) return 24;
    if (tmin >= threshold) return 0;
    const frac = (threshold - tmin) / Math.max(0.1, tmax - tmin);
    return 24 * Math.max(0, Math.min(1, frac));
}

export interface ClimateIndices {
    erinc: { value: number; class: string };
    deMartonne: { value: number; class: string };
    koppen: { code: string; label: string };
    /** Same indices from the MGM station values for comparison. */
    reference: Array<{ station: string; erinc: number | null; deMartonne: number | null; thornthwaite: string | null }>;
}

export function erincClass(im: number): string {
    return im < 8 ? 'Tam kurak' : im < 15 ? 'Kurak' : im < 23 ? 'Yarı kurak' : im < 40 ? 'Yarı nemli' : im < 55 ? 'Nemli' : 'Çok nemli';
}
export function deMartonneClass(i: number): string {
    return i < 10 ? 'Kurak' : i < 20 ? 'Yarı kurak' : i < 24 ? 'Yarı nemli' : i < 28 ? 'Nemli' : i < 35 ? 'Çok nemli' : 'Islak';
}

type WindowAgg = Pick<ClimatePeriod, 'tmean' | 'precipMm' | 'rainDays' | 'frostDays' | 'hotDays' | 'rhMean'>;

export interface ClimateSummary {
    source: string;
    from: string;
    to: string;
    lapse: DailyClimate['lapse'];
    anchor: StationAnchor;
    monthly: ClimatePeriod[];
    yearly: ClimatePeriod[];
    decades: Array<{ label: string; years: number[] } & Omit<ClimatePeriod, 'period' | 'days'>>;
    /** Monthly normals over the baseline years. */
    climatology: Array<{ month: number; tmean: number; tmin: number; tmax: number; precipMm: number; rainDays: number; rhMean: number }>;
    baselineYears: number[];
    recentYears: number[];
    anomaly: { tmean: number; precipMm: number; frostDays: number; hotDays: number; rainDays: number; drySpellMax: number; rhMean: number };
    trend: { tmeanPerDecade: number; precipPerDecade: number; hotDaysPerDecade: number; frostDaysPerDecade: number };
    indices: ClimateIndices;
    /** Yearly phenology helpers at the reference elevation. */
    seasons: Array<{ year: number; lastSpringFrost: string | null; firstAutumnFrost: string | null; frostFreeDays: number; chillHours: number }>;
    windows: Array<ClimateWindowRule & { years: Array<{ year: number } & Omit<ClimatePeriod, 'period'>>; baseline: WindowAgg; recent: WindowAgg }>;
}

function slope(xs: number[], ys: number[]): number {
    const n = xs.length;
    if (n < 3) return 0;
    const mx = mean(xs);
    const my = mean(ys);
    const num = xs.reduce((s, x, i) => s + (x - mx) * (ys[i]! - my), 0);
    const den = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
    return den === 0 ? 0 : num / den;
}

export function seasonStats(d: DailyClimate, year: number): { lastSpringFrost: string | null; firstAutumnFrost: string | null; frostFreeDays: number; chillHours: number } {
    const idx = dateIndex(d);
    let last: string | null = null;
    let first: string | null = null;
    let chill = 0;
    for (let i = 0; i < d.dates.length; i++) {
        const y = idx.y[i]!;
        const m = idx.m[i]!;
        if (y === year) {
            if (m <= 6 && d.tmin[i]! < 0) last = d.dates[i]!;
            if (m >= 7 && d.tmin[i]! < 0 && first === null) first = d.dates[i]!;
        }
        // Chilling accumulates over the dormant season ending in this year (Nov of the previous year → Mar).
        if ((y === year - 1 && m >= 11) || (y === year && m <= 3)) chill += chillHoursOfDay(d.tmin[i]!, d.tmax[i]!);
    }
    const frostFreeDays = last && first ? Math.round((Date.parse(first) - Date.parse(last)) / 86400000) : last ? Math.round((Date.parse(`${year}-12-31`) - Date.parse(last)) / 86400000) : 365;
    return { lastSpringFrost: last, firstAutumnFrost: first, frostFreeDays, chillHours: Math.round(chill) };
}

export function summariseClimate(d: DailyClimate): ClimateSummary {
    const byMonth = new Map<string, number[]>();
    const byYear = new Map<number, number[]>();
    d.dates.forEach((date, i) => {
        const ym = date.slice(0, 7);
        const mArr = byMonth.get(ym);
        if (mArr) mArr.push(i);
        else byMonth.set(ym, [i]);
        const y = Number(date.slice(0, 4));
        const yArr = byYear.get(y);
        if (yArr) yArr.push(i);
        else byYear.set(y, [i]);
    });
    const monthly = [...byMonth.entries()].map(([k, idx]) => summarise(k, idx, d));
    const fullYears = [...byYear.entries()].filter(([, idx]) => idx.length >= 360);
    const yearly = fullYears.map(([y, idx]) => summarise(String(y), idx, d));
    const years = yearly.map((r) => Number(r.period));
    // Official normal period 1991–2020 when the record covers it; otherwise the first half of the record.
    const normalYears = years.filter((y) => y >= 1991 && y <= 2020);
    const baselineYears = normalYears.length >= 20 ? normalYears : years.slice(0, Math.max(1, Math.floor(years.length / 2)));
    const recentYears = normalYears.length >= 20 ? years.filter((y) => y > 2020) : years.slice(-Math.max(1, Math.min(5, Math.floor(years.length / 2))));
    const climatology = Array.from({ length: 12 }, (_, m) => {
        const rows = monthly.filter((r) => Number(r.period.slice(5, 7)) === m + 1 && r.days >= 25 && baselineYears.includes(Number(r.period.slice(0, 4))));
        return {
            month: m + 1,
            tmean: round1(mean(rows.map((r) => r.tmean))),
            tmin: round1(mean(rows.map((r) => r.tminMean))),
            tmax: round1(mean(rows.map((r) => r.tmaxMean))),
            precipMm: Math.round(mean(rows.map((r) => r.precipMm))),
            rainDays: round1(mean(rows.map((r) => r.rainDays))),
            rhMean: round1(mean(rows.map((r) => r.rhMean))),
        };
    });
    const pick = (ys: number[]) => yearly.filter((r) => ys.includes(Number(r.period)));
    const agg = (rows: ClimatePeriod[]) => ({
        tmean: round1(mean(rows.map((r) => r.tmean))),
        tmaxMean: round1(mean(rows.map((r) => r.tmaxMean))),
        tminMean: round1(mean(rows.map((r) => r.tminMean))),
        tminAbs: round1(Math.min(...rows.map((r) => r.tminAbs))),
        tmaxAbs: round1(Math.max(...rows.map((r) => r.tmaxAbs))),
        rhMean: round1(mean(rows.map((r) => r.rhMean))),
        precipMm: Math.round(mean(rows.map((r) => r.precipMm))),
        rainDays: Math.round(mean(rows.map((r) => r.rainDays))),
        frostDays: Math.round(mean(rows.map((r) => r.frostDays))),
        hotDays: Math.round(mean(rows.map((r) => r.hotDays))),
        gdd10: Math.round(mean(rows.map((r) => r.gdd10))),
        drySpellMax: Math.round(mean(rows.map((r) => r.drySpellMax))),
    });
    const diff = (k: keyof ClimatePeriod) => round1(mean(pick(recentYears).map((r) => r[k] as number)) - mean(pick(baselineYears).map((r) => r[k] as number)));
    const trendOf = (k: keyof ClimatePeriod) => round1(slope(years, yearly.map((r) => r[k] as number)) * 10);
    const decadeOf = (y: number) => `${Math.floor(y / 10) * 10}–${Math.floor(y / 10) * 10 + 9}`;
    const decades = [...new Set(years.map(decadeOf))].map((label) => {
        const ys = years.filter((y) => decadeOf(y) === label);
        return { label, years: ys, ...agg(pick(ys)) };
    });
    const annualP = mean(pick(baselineYears.length ? baselineYears : years).map((r) => r.precipMm));
    const tomAnnual = mean(climatology.map((c) => c.tmax));
    const tAnnual = mean(climatology.map((c) => c.tmean));
    const warmest = Math.max(...climatology.map((c) => c.tmean));
    const coldest = Math.min(...climatology.map((c) => c.tmean));
    const indices: ClimateIndices = {
        erinc: { value: round1(annualP / tomAnnual), class: erincClass(annualP / tomAnnual) },
        deMartonne: { value: round1(annualP / (tAnnual + 10)), class: deMartonneClass(annualP / (tAnnual + 10)) },
        koppen: coldest > -3 && coldest < 18 ? (warmest >= 22 ? { code: 'Cfa', label: 'Ilıman, yıl boyu yağışlı, sıcak yaz' } : { code: 'Cfb', label: 'Ilıman, yıl boyu yağışlı, ılık yaz' }) : { code: 'Dfb', label: 'Soğuk kışlı, yıl boyu yağışlı' },
        reference: STATIONS.filter((s) => s.classes).map((s) => ({ station: s.name, erinc: s.classes?.erinc ?? null, deMartonne: s.classes?.deMartonne ?? null, thornthwaite: s.classes?.thornthwaite ?? null })),
    };
    const seasons = years.map((y) => ({ year: y, ...seasonStats(d, y) }));
    const windows = CLIMATE_WINDOWS.map((w) => {
        const rows = [...byYear.keys()]
            .sort()
            .map((y) => {
                const from = w.from > w.to ? `${y - 1}-${w.from}` : `${y}-${w.from}`;
                const to = `${y}-${w.to}`;
                const idx = d.dates.map((date, i) => (date >= from && date <= to ? i : -1)).filter((i) => i >= 0);
                if (idx.length < 10) return null;
                const { period: _p, ...rest } = summarise(String(y), idx, d);
                return { year: y, ...rest };
            })
            .filter((r): r is NonNullable<typeof r> => r !== null);
        const aggW = (ys: number[]): WindowAgg => {
            const sel = rows.filter((r) => ys.includes(r.year));
            return { tmean: round1(mean(sel.map((r) => r.tmean))), precipMm: Math.round(mean(sel.map((r) => r.precipMm))), rainDays: round1(mean(sel.map((r) => r.rainDays))), frostDays: round1(mean(sel.map((r) => r.frostDays))), hotDays: round1(mean(sel.map((r) => r.hotDays))), rhMean: round1(mean(sel.map((r) => r.rhMean))) };
        };
        return { ...w, years: rows, baseline: aggW(baselineYears), recent: aggW(recentYears) };
    });
    return {
        source: 'ERA5-Land günlük (11 km; sıcaklık/nem/yağış) + CHIRPS (5 km); mahalle yükseltisine lapse düzeltmesi; MGM il istasyonu normallerine aylık bağlama',
        from: d.dates[0] ?? '',
        to: d.dates.at(-1) ?? '',
        lapse: d.lapse,
        anchor: d.anchor,
        monthly,
        yearly,
        decades,
        climatology,
        baselineYears,
        recentYears,
        anomaly: { tmean: diff('tmean'), precipMm: diff('precipMm'), frostDays: diff('frostDays'), hotDays: diff('hotDays'), rainDays: diff('rainDays'), drySpellMax: diff('drySpellMax'), rhMean: diff('rhMean') },
        trend: { tmeanPerDecade: trendOf('tmean'), precipPerDecade: trendOf('precipMm'), hotDaysPerDecade: trendOf('hotDays'), frostDaysPerDecade: trendOf('frostDays') },
        indices,
        seasons,
        windows,
    };
}

/** Climate indicators at one parcel's elevation (lapse-shifted daily series, recent full years). */
export interface ParcelClimate {
    offsetC: number;
    years: number[];
    tmean: number;
    tminAbs: number;
    tmaxAbs: number;
    frostDays: number;
    hotDays: number;
    precipMm: number;
    julyMean: number;
    rhSummer: number;
    chillHours: number;
    frostFreeDays: number;
    springFrostDays: number;
    bloomRainDays: number;
}

export function parcelClimate(d: DailyClimate, recentYears: number[], parcelElevationM: number | null): ParcelClimate | null {
    if (d.dates.length === 0) return null;
    const idx = dateIndex(d);
    const offsetC = parcelElevationM === null ? 0 : round2((d.lapse.neighbourhoodElevationM - parcelElevationM) * LAPSE_C_PER_M);
    const years = recentYears.length ? recentYears : [Number(d.dates.at(-1)!.slice(0, 4))];
    const yearsSet = new Set(years);
    let frost = 0, hot = 0, tSum = 0, n = 0, tminAbs = Infinity, tmaxAbs = -Infinity, precip = 0, julySum = 0, julyN = 0, rhSum = 0, rhN = 0, springFrost = 0, bloomRain = 0;
    let chill = 0;
    const lastFrost = new Map<number, string>();
    const firstFrost = new Map<number, string>();
    for (let i = 0; i < d.dates.length; i++) {
        const y = idx.y[i]!;
        const m = idx.m[i]!;
        const tmin = d.tmin[i]! + offsetC;
        const tmax = d.tmax[i]! + offsetC;
        if (yearsSet.has(y + 1) && m >= 11) chill += chillHoursOfDay(tmin, tmax);
        if (!yearsSet.has(y)) continue;
        const t = d.tmean[i]! + offsetC;
        const md = idx.md[i]!;
        if (m <= 3) chill += chillHoursOfDay(tmin, tmax);
        n++;
        tSum += t;
        tminAbs = Math.min(tminAbs, tmin);
        tmaxAbs = Math.max(tmaxAbs, tmax);
        if (tmin < 0) {
            frost++;
            if (m <= 6) lastFrost.set(y, d.dates[i]!);
            else if (!firstFrost.has(y)) firstFrost.set(y, d.dates[i]!);
            if (md >= '03-15' && md <= '04-30') springFrost++;
        }
        if (tmax >= 30) hot++;
        precip += d.precip[i]!;
        if (m === 7) {
            julySum += t;
            julyN++;
        }
        if (m === 6 || m === 7) {
            rhSum += relativeHumidity(t, d.dewpoint[i]! + offsetC);
            rhN++;
        }
        if (md >= '06-01' && md <= '07-15' && d.precip[i]! >= 1) bloomRain++;
    }
    if (n === 0) return null;
    const per = years.length;
    const frostFree = years.map((y) => {
        const l = lastFrost.get(y);
        const f = firstFrost.get(y);
        return l && f ? (Date.parse(f) - Date.parse(l)) / 86400000 : l ? (Date.parse(`${y}-12-31`) - Date.parse(l)) / 86400000 : 365;
    });
    return {
        offsetC,
        years,
        tmean: round1(tSum / n),
        tminAbs: round1(tminAbs),
        tmaxAbs: round1(tmaxAbs),
        frostDays: Math.round(frost / per),
        hotDays: Math.round(hot / per),
        precipMm: Math.round(precip / per),
        julyMean: julyN ? round1(julySum / julyN) : NaN,
        rhSummer: rhN ? round1(rhSum / rhN) : NaN,
        chillHours: Math.round(chill / per),
        frostFreeDays: Math.round(mean(frostFree)),
        springFrostDays: Math.round(springFrost / per),
        bloomRainDays: Math.round(bloomRain / per),
    };
}
