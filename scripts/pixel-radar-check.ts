/*
 * Does Sentinel-1 see the cuts the pixel scan found? For every counted cluster of a season the γ0 VH / VV
 * series of exactly those pixels is pulled per orbit and stepped across the optical date bracket; the same
 * statistic on random pseudo-clusters in gardens where nothing was found (with brackets borrowed from the
 * real clusters) gives the null distribution. Radar earns a place in the verdict only if the real clusters
 * exceed that null clearly more often than chance.
 *
 *   node scripts/pixel-radar-check.ts --province Trabzon --district Of --neighborhood Çataldere --season 2025
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { MultiPolygon } from 'geojson';
import { initEarthEngine } from '../src/ee/session.ts';
import { NeighborhoodStore } from '../src/library/store.ts';
import { backscatterSeries, type OrbitPass } from '../src/radar/series.ts';
import { fromUtm } from '../src/geo/utm.ts';
import type { PixelSeasonFile } from '../src/cli/scan-pixels.ts';

const DAY = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * DAY).toISOString().slice(0, 10);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs: number[]) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};
const quantile = (xs: number[], q: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))] as number;
};
function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

interface Unit {
    id: string;
    real: boolean;
    pixels: number;
    lastBefore: string;
    date: string;
    geometry: MultiPolygon;
}

async function main(): Promise<void> {
    const { values } = parseArgs({ options: { province: { type: 'string' }, district: { type: 'string' }, neighborhood: { type: 'string' }, season: { type: 'string', default: '2025' }, force: { type: 'boolean', default: false } } });
    const store = new NeighborhoodStore(values.province as string, values.district as string, values.neighborhood as string);
    const year = Number(values.season);
    const season = `${year}-${String(year + 1).slice(2)}`;
    const dir = join(store.dir, 'pruning-pixels');
    const file = JSON.parse(readFileSync(join(dir, `season-${season}.json`), 'utf8')) as PixelSeasonFile;
    const zone = Number(file.epsg.slice(-2));
    const square = (e: number, n: number) => [[fromUtm(e, n, zone), fromUtm(e + 10, n, zone), fromUtm(e + 10, n + 10, zone), fromUtm(e, n + 10, zone), fromUtm(e, n, zone)]];
    const random = mulberry32(20261112);

    const units: Unit[] = [];
    for (const g of file.gardens) {
        if (!g.best || !['deep', 'light', 'pending'].includes(g.verdict)) continue;
        for (const k of g.clusters) {
            if (k.confidence === 'low' || k.kind === 'transient') continue;
            const px = g.px.filter((p) => p[6] === k.index);
            units.push({ id: `${g.id}#${k.index}`, real: true, pixels: px.length, lastBefore: g.best.lastBefore ?? addDays(g.best.date, -12), date: g.best.date, geometry: { type: 'MultiPolygon', coordinates: px.map((p) => square(p[0], p[1])) } });
        }
    }
    const real = units.filter((u) => u.real);
    // Pseudo-clusters: a random connected set of the same size distribution in gardens where the scan found nothing.
    for (const g of file.gardens.filter((x) => x.verdict === 'none' && x.px.length >= 2)) {
        for (let rep = 0; rep < 2; rep++) {
            const model = real[Math.floor(random() * real.length)] as Unit;
            const size = Math.min(model.pixels, g.px.length);
            const start = g.px[Math.floor(random() * g.px.length)] as (typeof g.px)[number];
            const chosen = [start];
            const key = (p: (typeof g.px)[number]) => `${p[0]}_${p[1]}`;
            const seen = new Set([key(start)]);
            while (chosen.length < size) {
                const frontier = g.px.filter((p) => !seen.has(key(p)) && chosen.some((c) => Math.abs(c[0] - p[0]) <= 10 && Math.abs(c[1] - p[1]) <= 10));
                if (frontier.length === 0) break;
                const next = frontier[Math.floor(random() * frontier.length)] as (typeof g.px)[number];
                seen.add(key(next));
                chosen.push(next);
            }
            units.push({ id: `${g.id}~${rep}`, real: false, pixels: chosen.length, lastBefore: model.lastBefore, date: model.date, geometry: { type: 'MultiPolygon', coordinates: chosen.map((p) => square(p[0], p[1])) } });
        }
    }
    console.log(`${real.length} gerçek küme, ${units.length - real.length} sahte küme (kontrol)`);

    const cachePath = join(dir, `radar-check-${season}.json`);
    type Pass = { pass: OrbitPass; relativeOrbit: number; dates: string[]; vh: Record<string, Array<number | null>>; vv: Record<string, Array<number | null>> };
    let passes: Pass[];
    if (!values.force && existsSync(cachePath)) passes = (JSON.parse(readFileSync(cachePath, 'utf8')) as { passes: Pass[] }).passes;
    else {
        const ee = await initEarthEngine();
        const meta = store.readMeta();
        if (!meta) throw new Error('meta.json yok');
        const region = ee.Geometry(meta.boundary);
        passes = [];
        for (const pass of ['ASCENDING', 'DESCENDING'] as OrbitPass[]) {
            console.log(`Sentinel-1 ${pass} çekiliyor (${units.length} birim)…`);
            const s = await backscatterSeries(ee, region, units.map((u) => ({ id: u.id, geometry: u.geometry })), [`${year}-08-15`, `${year + 1}-06-01`], pass);
            if (!s) continue;
            passes.push({ pass, relativeOrbit: s.relativeOrbit, dates: s.dates, vh: Object.fromEntries(units.map((u) => [u.id, s.gardens[u.id]?.vh ?? []])), vv: Object.fromEntries(units.map((u) => [u.id, s.gardens[u.id]?.vv ?? []])) });
            console.log(`  yörünge ${s.relativeOrbit}: ${s.dates.length} geçiş`);
        }
        writeFileSync(cachePath, JSON.stringify({ units: units.map(({ geometry: _g, ...rest }) => rest), passes }));
    }

    // Relative to the per-date median of the controls; step across the optical bracket.
    const WINDOW = 36;
    const stat = (u: Unit) => {
        const out: Record<string, number | null> = {};
        for (const p of passes) {
            const ref = (which: 'vh' | 'vv') => p.dates.map((_, t) => median(units.filter((x) => !x.real).map((x) => p[which][x.id]?.[t]).filter((v): v is number => v !== null && v !== undefined)));
            const refVh = ref('vh');
            const refVv = ref('vv');
            const rel = p.dates.map((_, t) => {
                const vh = p.vh[u.id]?.[t];
                const vv = p.vv[u.id]?.[t];
                if (vh === null || vh === undefined || vv === null || vv === undefined || refVh[t] === null || refVv[t] === null) return null;
                return { vh: vh - (refVh[t] as number), ratio: vh - vv - ((refVh[t] as number) - (refVv[t] as number)) };
            });
            const pick = (from: string, to: string) => p.dates.map((d, t) => (d >= from && d <= to ? rel[t] : null)).filter((v): v is { vh: number; ratio: number } => v !== null);
            const b = pick(addDays(u.lastBefore, -WINDOW), u.lastBefore);
            const a = pick(u.date, addDays(u.date, WINDOW));
            const key = p.pass === 'ASCENDING' ? 'asc' : 'desc';
            out[`vh_${key}`] = b.length >= 3 && a.length >= 3 ? (mean(a.map((x) => x.vh)) as number) - (mean(b.map((x) => x.vh)) as number) : null;
            out[`ratio_${key}`] = b.length >= 3 && a.length >= 3 ? (mean(a.map((x) => x.ratio)) as number) - (mean(b.map((x) => x.ratio)) as number) : null;
        }
        return out;
    };
    const stats = units.map((u) => ({ u, s: stat(u) }));
    const report = (label: string, f: (s: Record<string, number | null>) => number | null) => {
        const nullVals = stats.filter((x) => !x.u.real).map((x) => f(x.s)).filter((v): v is number => v !== null);
        const realVals = stats.filter((x) => x.u.real).map((x) => f(x.s)).filter((v): v is number => v !== null);
        if (nullVals.length < 20 || realVals.length < 5) return console.log(`${label}: yetersiz veri`);
        const q90 = quantile(nullVals, 0.9);
        const q95 = quantile(nullVals, 0.95);
        const over = (q: number) => realVals.filter((v) => v > q).length / realVals.length;
        console.log(`${label}: kontrol ortanca ${(median(nullVals) as number).toFixed(2)} · %90 ${q90.toFixed(2)} · %95 ${q95.toFixed(2)} | gerçek ortanca ${(median(realVals) as number).toFixed(2)} · %90 eşiğini aşan ${(over(q90) * 100).toFixed(0)}% (şans %10) · %95 eşiğini aşan ${(over(q95) * 100).toFixed(0)}% (şans %5) · n ${realVals.length}/${nullVals.length}`);
    };
    const both = (a: number | null, b: number | null, f: (x: number) => number) => (a === null && b === null ? null : Math.max(...[a, b].filter((v): v is number => v !== null).map(f)));
    report('VH düşüşü (dB, en büyük yörünge)', (s) => both(s.vh_asc ?? null, s.vh_desc ?? null, (x) => -x));
    report('VH artışı (dB)', (s) => both(s.vh_asc ?? null, s.vh_desc ?? null, (x) => x));
    report('|VH| değişimi (dB)', (s) => both(s.vh_asc ?? null, s.vh_desc ?? null, Math.abs));
    report('VH/VV düşüşü (dB)', (s) => both(s.ratio_asc ?? null, s.ratio_desc ?? null, (x) => -x));
    report('|VH/VV| değişimi (dB)', (s) => both(s.ratio_asc ?? null, s.ratio_desc ?? null, Math.abs));
    const big = (min: number) => {
        const sub = stats.filter((x) => x.u.pixels >= min);
        const nullVals = sub.filter((x) => !x.u.real).map((x) => both(x.s.vh_asc ?? null, x.s.vh_desc ?? null, Math.abs)).filter((v): v is number => v !== null);
        const realVals = sub.filter((x) => x.u.real).map((x) => both(x.s.vh_asc ?? null, x.s.vh_desc ?? null, Math.abs)).filter((v): v is number => v !== null);
        if (nullVals.length < 10 || realVals.length < 5) return;
        const q90 = quantile(nullVals, 0.9);
        console.log(`  ≥ ${min} piksellik kümelerde |VH|: %90 eşiğini aşan ${((realVals.filter((v) => v > q90).length / realVals.length) * 100).toFixed(0)}% (n ${realVals.length}/${nullVals.length})`);
    };
    big(4);
    big(8);
}

main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});
