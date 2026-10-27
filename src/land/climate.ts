import type { MultiPolygon, Polygon } from 'geojson';
import { evaluate } from '../ee/session.ts';

/* `ee` objects are untyped (see src/types/earthengine.d.ts). */
type EE = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Daily series for the neighbourhood (ERA5-Land 11 km reanalysis; CHIRPS 5 km rainfall when available). */
export interface DailyClimate {
    dates: string[];
    /** Temperatures already corrected to the neighbourhood's mean elevation (see `lapse`). */
    tmean: number[];
    tmax: number[];
    tmin: number[];
    dewpoint: number[];
    precipEra: number[];
    precipChirps: Array<number | null>;
    /** Elevation correction applied to the 11 km cell: mean elevation of the cell vs the neighbourhood, 6.5 °C/km. */
    lapse: { neighbourhoodElevationM: number; cellElevationM: number; correctionC: number };
}

const ERA5_SCALE_M = 11132;
const CHIRPS_SCALE_M = 5566;
const LAPSE_C_PER_M = 0.0065;

/** Mean elevation (m) of the given geometries from the radar DEM; used as the climate reference height. */
export async function meanElevation(ee: EE, geometries: Array<Polygon | MultiPolygon>, scale = 90): Promise<number | null> {
    if (geometries.length === 0) return null;
    const demCollection = ee.ImageCollection('COPERNICUS/DEM/GLO30').select('DEM');
    const dem = demCollection.mosaic().setDefaultProjection(demCollection.first().projection());
    const geometry = ee.FeatureCollection(geometries.map((g) => ee.Feature(ee.Geometry(g)))).geometry(1);
    const r = await evaluate<{ DEM: number | null }>(dem.reduceRegion({ reducer: ee.Reducer.mean(), geometry, scale, bestEffort: true }));
    return typeof r.DEM === 'number' ? r.DEM : null;
}

/**
 * @param referenceElevationM height the temperatures are corrected to: the settled / cultivated part of
 * the neighbourhood (median parcel elevation), not the whole boundary, which may climb to the ridges.
 */
export async function fetchDailyClimate(ee: EE, boundary: Polygon | MultiPolygon, start: string, end: string, referenceElevationM: number | null): Promise<DailyClimate> {
    const region = ee.Geometry(boundary);
    // ERA5-Land values describe an 11 km cell whose mean elevation can sit far above a valley village;
    // the standard lapse rate moves the temperatures down (or up) to the reference elevation.
    const demCollection = ee.ImageCollection('COPERNICUS/DEM/GLO30').select('DEM');
    const dem = demCollection.mosaic().setDefaultProjection(demCollection.first().projection());
    const boundaryElev = await evaluate<{ DEM: number }>(dem.reduceRegion({ reducer: ee.Reducer.mean(), geometry: region, scale: 90, bestEffort: true }));
    const cellElev = await evaluate<{ DEM: number }>(dem.reduceRegion({ reducer: ee.Reducer.mean(), geometry: region.buffer(ERA5_SCALE_M / 2), scale: 250, bestEffort: true }));
    const elev = { DEM: referenceElevationM ?? boundaryElev.DEM };
    const correctionC = Math.round((cellElev.DEM - elev.DEM) * LAPSE_C_PER_M * 100) / 100;
    const era = ee
        .ImageCollection('ECMWF/ERA5_LAND/DAILY_AGGR')
        .filterDate(start, end)
        .select(['temperature_2m', 'temperature_2m_max', 'temperature_2m_min', 'dewpoint_temperature_2m', 'total_precipitation_sum']);
    const eraRows = era.map((img: EE) => {
        const d = img.reduceRegion({ reducer: ee.Reducer.mean(), geometry: region, scale: ERA5_SCALE_M, bestEffort: true });
        return ee.Feature(null, d).set('date', img.date().format('YYYY-MM-dd'));
    });
    const eraList = await evaluate<Array<Array<number | string | null>>>(
        eraRows.reduceColumns(ee.Reducer.toList(6), ['date', 'temperature_2m', 'temperature_2m_max', 'temperature_2m_min', 'dewpoint_temperature_2m', 'total_precipitation_sum']).get('list'),
    );
    const chirps = ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY').filterDate(start, end).select('precipitation');
    const chirpsRows = chirps.map((img: EE) => ee.Feature(null, img.reduceRegion({ reducer: ee.Reducer.mean(), geometry: region, scale: CHIRPS_SCALE_M, bestEffort: true })).set('date', img.date().format('YYYY-MM-dd')));
    const chirpsList = await evaluate<Array<Array<number | string | null>>>(chirpsRows.reduceColumns(ee.Reducer.toList(2), ['date', 'precipitation']).get('list'));
    const chirpsByDate = new Map(chirpsList.map((r) => [String(r[0]), typeof r[1] === 'number' ? r[1] : null]));

    const out: DailyClimate = {
        dates: [], tmean: [], tmax: [], tmin: [], dewpoint: [], precipEra: [], precipChirps: [],
        lapse: { neighbourhoodElevationM: Math.round(elev.DEM), cellElevationM: Math.round(cellElev.DEM), correctionC },
    };
    for (const r of eraList.sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
        const [date, t, tx, tn, td, p] = r;
        if (typeof t !== 'number') continue;
        out.dates.push(String(date));
        out.tmean.push(t - 273.15 + correctionC);
        out.tmax.push((tx as number) - 273.15 + correctionC);
        out.tmin.push((tn as number) - 273.15 + correctionC);
        out.dewpoint.push((td as number) - 273.15 + correctionC);
        out.precipEra.push(Math.max(0, ((p as number) ?? 0) * 1000));
        out.precipChirps.push(chirpsByDate.get(String(date)) ?? null);
    }
    return out;
}

/** Climate indicators at one parcel's elevation (lapse-shifted daily series, recent full years). */
export interface ParcelClimate {
    /** Temperature offset applied relative to the neighbourhood reference elevation (°C). */
    offsetC: number;
    tmean: number;
    tminAbs: number;
    frostDays: number;
    hotDays: number;
    precipMm: number;
    julyMean: number;
}

export function parcelClimate(d: DailyClimate, recentYears: number[], parcelElevationM: number | null): ParcelClimate | null {
    if (d.dates.length === 0) return null;
    const offsetC = parcelElevationM === null ? 0 : Math.round((d.lapse.neighbourhoodElevationM - parcelElevationM) * LAPSE_C_PER_M * 100) / 100;
    const years = recentYears.length ? recentYears : [Number(d.dates.at(-1)!.slice(0, 4))];
    let frost = 0;
    let hot = 0;
    let tSum = 0;
    let n = 0;
    let tminAbs = Infinity;
    let precip = 0;
    let julySum = 0;
    let julyN = 0;
    d.dates.forEach((date, i) => {
        if (!years.includes(Number(date.slice(0, 4)))) return;
        const tmin = d.tmin[i]! + offsetC;
        const tmax = d.tmax[i]! + offsetC;
        const t = d.tmean[i]! + offsetC;
        n++;
        tSum += t;
        tminAbs = Math.min(tminAbs, tmin);
        if (tmin < 0) frost++;
        if (tmax >= 30) hot++;
        precip += d.precipChirps[i] ?? d.precipEra[i]!;
        if (date.slice(5, 7) === '07') {
            julySum += t;
            julyN++;
        }
    });
    if (n === 0) return null;
    const perYear = years.length;
    return {
        offsetC,
        tmean: round1(tSum / n),
        tminAbs: round1(tminAbs),
        frostDays: Math.round(frost / perYear),
        hotDays: Math.round(hot / perYear),
        precipMm: Math.round(precip / perYear),
        julyMean: julyN ? round1(julySum / julyN) : NaN,
    };
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
    /** Longest run of days with < 1 mm rain. */
    drySpellMax: number;
}

/** A crop-calendar window judged every year (e.g. chestnut flowering for honey). */
export interface ClimateWindowRule {
    key: string;
    label: string;
    /** MM-DD inclusive start and end inside one calendar year. */
    from: string;
    to: string;
    why: string;
}

export const CLIMATE_WINDOWS: ClimateWindowRule[] = [
    { key: 'chestnut_bloom', label: 'Kestane çiçeklenmesi (bal)', from: '06-01', to: '07-15', why: 'Yağışlı/soğuk çiçeklenme nektarı ve arı uçuşunu keser; sıcak ve kuru pencere bal verimini artırır.' },
    { key: 'tea_flush', label: 'Çay sürgün dönemi', from: '05-01', to: '09-30', why: 'Yaz kuraklığı ve >30 °C günler sürgünü yavaşlatır; yağış dağılımı hasat sayısını belirler.' },
    { key: 'hazelnut_bloom', label: 'Fındık çiçeklenmesi', from: '12-15', to: '02-28', why: 'Çiçeklenmede sert don ve yoğun yağış tozlaşmayı düşürür.' },
    { key: 'spring_frost', label: 'İlkbahar geç donu', from: '03-15', to: '04-30', why: 'Sürgün ve çiçek dönemindeki don meyve/çay ilk sürgününü vurur.' },
];

function rh(t: number, td: number): number {
    const e = (x: number) => Math.exp((17.625 * x) / (243.04 + x));
    return Math.max(0, Math.min(100, (100 * e(td)) / e(t)));
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const round1 = (x: number) => Math.round(x * 10) / 10;

function summarise(period: string, idx: number[], d: DailyClimate): ClimatePeriod {
    const precip = idx.map((i) => d.precipChirps[i] ?? d.precipEra[i]!);
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
        rhMean: round1(mean(idx.map((i) => rh(d.tmean[i]!, d.dewpoint[i]!)))),
        precipMm: Math.round(precip.reduce((a, b) => a + b, 0)),
        rainDays: precip.filter((p) => p >= 1).length,
        frostDays: idx.filter((i) => d.tmin[i]! < 0).length,
        hotDays: idx.filter((i) => d.tmax[i]! >= 30).length,
        gdd10: Math.round(idx.reduce((s, i) => s + Math.max(0, d.tmean[i]! - 10), 0)),
        drySpellMax: dryMax,
    };
}

export interface ClimateSummary {
    source: string;
    from: string;
    to: string;
    lapse: DailyClimate['lapse'];
    monthly: ClimatePeriod[];
    yearly: ClimatePeriod[];
    /** Mean of each calendar month over the whole record (climatology). */
    climatology: Array<{ month: number; tmean: number; tmin: number; tmax: number; precipMm: number; rainDays: number; rhMean: number }>;
    baselineYears: number[];
    recentYears: number[];
    /** Recent minus baseline for the headline indicators. */
    anomaly: { tmean: number; precipMm: number; frostDays: number; hotDays: number; rainDays: number; drySpellMax: number; rhMean: number };
    /** Linear trend per decade over the full years. */
    trend: { tmeanPerDecade: number; precipPerDecade: number; hotDaysPerDecade: number; frostDaysPerDecade: number };
    windows: Array<ClimateWindowRule & { years: Array<{ year: number } & Omit<ClimatePeriod, 'period'>>; baseline: Pick<ClimatePeriod, 'tmean' | 'precipMm' | 'rainDays' | 'frostDays' | 'hotDays'>; recent: Pick<ClimatePeriod, 'tmean' | 'precipMm' | 'rainDays' | 'frostDays' | 'hotDays'> }>;
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

export function summariseClimate(d: DailyClimate): ClimateSummary {
    const byMonth = new Map<string, number[]>();
    const byYear = new Map<number, number[]>();
    d.dates.forEach((date, i) => {
        const ym = date.slice(0, 7);
        byMonth.set(ym, [...(byMonth.get(ym) ?? []), i]);
        const y = Number(date.slice(0, 4));
        byYear.set(y, [...(byYear.get(y) ?? []), i]);
    });
    const monthly = [...byMonth.entries()].map(([k, idx]) => summarise(k, idx, d));
    const fullYears = [...byYear.entries()].filter(([, idx]) => idx.length >= 360);
    const yearly = fullYears.map(([y, idx]) => summarise(String(y), idx, d));
    const climatology = Array.from({ length: 12 }, (_, m) => {
        const rows = monthly.filter((r) => Number(r.period.slice(5, 7)) === m + 1);
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
    const years = yearly.map((r) => Number(r.period));
    const half = Math.max(1, Math.min(5, Math.floor(years.length / 2)));
    const baselineYears = years.slice(0, half);
    const recentYears = years.slice(-half);
    const pick = (ys: number[]) => yearly.filter((r) => ys.includes(Number(r.period)));
    const diff = (k: keyof ClimatePeriod) => round1(mean(pick(recentYears).map((r) => r[k] as number)) - mean(pick(baselineYears).map((r) => r[k] as number)));
    const trendOf = (k: keyof ClimatePeriod) => round1(slope(years, yearly.map((r) => r[k] as number)) * 10);
    const windows = CLIMATE_WINDOWS.map((w) => {
        const rows = [...byYear.keys()]
            .sort()
            .map((y) => {
                // A window that crosses New Year (hazelnut bloom Dec–Feb) belongs to the year it ends in.
                const from = w.from > w.to ? `${y - 1}-${w.from}` : `${y}-${w.from}`;
                const to = `${y}-${w.to}`;
                const idx = d.dates.map((date, i) => (date >= from && date <= to ? i : -1)).filter((i) => i >= 0);
                if (idx.length < 10) return null;
                const { period: _p, ...rest } = summarise(String(y), idx, d);
                return { year: y, ...rest };
            })
            .filter((r): r is NonNullable<typeof r> => r !== null);
        const agg = (ys: number[]) => {
            const sel = rows.filter((r) => ys.includes(r.year));
            return {
                tmean: round1(mean(sel.map((r) => r.tmean))),
                precipMm: Math.round(mean(sel.map((r) => r.precipMm))),
                rainDays: round1(mean(sel.map((r) => r.rainDays))),
                frostDays: round1(mean(sel.map((r) => r.frostDays))),
                hotDays: round1(mean(sel.map((r) => r.hotDays))),
            };
        };
        return { ...w, years: rows, baseline: agg(baselineYears), recent: agg(recentYears) };
    });
    return {
        source: 'ERA5-Land günlük (11 km, sıcaklık/nem; mahalle yükseltisine lapse düzeltmesi) + CHIRPS (5 km, yağış); mahalle sınırı ortalaması',
        from: d.dates[0] ?? '',
        to: d.dates.at(-1) ?? '',
        lapse: d.lapse,
        monthly,
        yearly,
        climatology,
        baselineYears,
        recentYears,
        anomaly: { tmean: diff('tmean'), precipMm: diff('precipMm'), frostDays: diff('frostDays'), hotDays: diff('hotDays'), rainDays: diff('rainDays'), drySpellMax: diff('drySpellMax'), rhMean: diff('rhMean') },
        trend: { tmeanPerDecade: trendOf('tmean'), precipPerDecade: trendOf('precipMm'), hotDaysPerDecade: trendOf('hotDays'), frostDaysPerDecade: trendOf('frostDays') },
        windows,
    };
}
