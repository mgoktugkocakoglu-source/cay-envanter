import { CHANNEL_DEFAULTS, judge, scanTimeline, type ChannelSeries, type UnitContext } from '../src/fusion/model.ts';
let seed = 11;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());
const dates = (from: string, step: number, n: number) => Array.from({ length: n }, (_, i) => new Date(Date.parse(from) + i * step * 864e5).toISOString().slice(0, 10));
const dayDiff = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 864e5;
/**
 * A channel with Gaussian noise, an optional step at `stepAt` (in the pruning direction unless
 * `against`), optional recovery after `recoverAfterDays`, random gaps, and — for NDVI — a raw
 * series riding on a 0.82 canopy level so the level and summer-recovery guards are exercised.
 */
function series(key: keyof typeof CHANNEL_DEFAULTS, ds: string[], noise: number, stepAt: string | null, stepSize: number, recoverAfterDays = 0, gaps = 0.3, against = false, ramp = false): ChannelSeries {
    const sign = CHANNEL_DEFAULTS[key].sign * (against ? -1 : 1);
    const values = ds.map((d) => {
        if (rnd() < gaps) return null;
        let v = gauss() * noise;
        if (ramp) {
            // Season-long slide of `stepSize` from the first to the last date (abandonment, uprooting).
            v += sign * stepSize * (dayDiff(ds[0]!, d) / dayDiff(ds[0]!, ds[ds.length - 1]!));
        } else if (stepAt && d >= stepAt) {
            const dt = dayDiff(stepAt, d);
            if (!recoverAfterDays || dt < recoverAfterDays) v += sign * stepSize;
            // A light trim grows back: half the step is gone after the recovery span, all of it after twice.
            else if (recoverAfterDays >= 60) v += sign * stepSize * Math.max(0, 1 - (dt - recoverAfterDays) / recoverAfterDays);
        }
        return v;
    });
    const out: ChannelSeries = { key, dates: ds, values, ...CHANNEL_DEFAULTS[key] };
    if (key === 'ndvi') out.raw = values.map((v) => (v === null ? null : Math.round((0.82 + v) * 1000) / 1000));
    return out;
}
/** Optical series with a blind gap (no observations) between two dates. */
function blind(s: ChannelSeries, from: string, to: string): ChannelSeries {
    const values = s.values.map((v, i) => (s.dates[i]! >= from && s.dates[i]! <= to ? null : v));
    return { ...s, values, raw: s.raw?.map((v, i) => (values[i] === null ? null : v)) };
}
/** Raw NDVI that stands still while the relative series drops (neighbours greening up, this garden not). */
function flatRaw(s: ChannelSeries): ChannelSeries {
    return { ...s, raw: s.values.map((v) => (v === null ? null : Math.round((0.72 + gauss() * 0.02) * 1000) / 1000)) };
}
// Dense optical (S2 every 4 days, September to mid-July), two S1 orbits every 6 days.
const S2 = dates('2025-09-02', 4, 80), ASC = dates('2025-09-04', 6, 53), DES = dates('2025-09-10', 6, 52);
const optical = (t0: string | null, ndvi: number, nbr: number, recover = 0, gaps = 0.3, snow = false, ramp = false) => [
    series('ndvi', S2, 0.04, t0, ndvi, recover, gaps, false, ramp),
    series('nbr', S2, 0.04, t0, nbr, recover, gaps, snow, ramp),
    series('ndre', S2, 0.03, t0, ndvi * 0.6, recover, gaps, false, ramp),
    series('ndii', S2, 0.04, t0, nbr * 0.9, recover, gaps, snow, ramp),
];
const radar = (t0: string | null, vh: number) => [
    series('vh_asc', ASC, 1.4, t0, vh), series('ratio_asc', ASC, 1.2, t0, vh * 0.7),
    series('vh_desc', DES, 1.4, t0, vh), series('ratio_desc', DES, 1.2, t0, vh * 0.7),
];
const quiet = () => radar(null, 0);
const cases: Array<[string, string, ChannelSeries[], UnitContext?]> = [
    ['derin budama 25 Kas (NDVI −0.35, VH −2.5 dB)', 'pruned', [...optical('2025-11-25', 0.35, 0.3), ...radar('2025-11-25', 2.5)]],
    ['hafif budama (NDVI −0.15, VH −1.2 dB), yaz başında toparlanır', 'unclear', [...optical('2025-12-10', 0.15, 0.12, 90), ...radar('2025-12-10', 1.2)]],
    ['geçici (kar/gölge 10 gün)', 'not_pruned|unclear', [...optical('2025-12-10', 0.35, 0.3, 10), ...quiet()]],
    ['kar: NDVI düşer, NBR/NDII yükselir, kalıcı 40 gün', 'not_pruned|unclear', [...optical('2025-12-20', 0.3, 0.25, 40, 0.3, true), ...quiet()]],
    ['yalnız optik, yoğun gözlem, radar sessiz (v2: optik tek başına yeter)', 'pruned', [...optical('2025-12-10', 0.3, 0.25), ...quiet()]],
    ['yalnız optik, 35 günlük bulut boşluğu, radar sessiz, yaz teyit eder (→ kesin)', 'pruned', [...optical('2025-12-10', 0.3, 0.25).map((s) => blind(s, '2025-11-20', '2025-12-25')), ...quiet()]],
    ['yalnız optik, 35 günlük boşluk, radar teyit eder (→ kesin)', 'pruned', [...optical('2025-12-10', 0.3, 0.25).map((s) => blind(s, '2025-11-20', '2025-12-25')), ...radar('2025-12-10', 2.0)]],
    ['optik düşüş, radar YÜKSELİŞ (çelişki → belirsiz)', 'unclear', [...optical('2025-12-10', 0.3, 0.25), ...radar('2025-12-10', 2.5).map((s) => ({ ...s, values: s.values.map((v) => (v === null ? null : -v)) }))]],
    ['değişim yok', 'not_pruned', [...optical(null, 0, 0), ...quiet()]],
    ['bulutlu kış: optik %70 boşluk, radar görüyor', 'pruned|likely', [...optical('2025-11-25', 0.35, 0.3, 0, 0.7), ...radar('2025-11-25', 2.5)]],
    ['gölgeye yatkın bahçe (önceki kış geçici düşüş), bu kış kalıcı düşüş', 'pruned', [...optical('2025-12-10', 0.3, 0.25), ...quiet()], { shadeProne: true, priorNoise: { ndvi: 0.05 } }],
    ['kademeli kayıp: sezon boyu −0.35 kayma (terk/sökme), basamak yok', 'unclear|not_pruned', [...optical(null, 0.35, 0.3, 0, 0.3, false, true), ...quiet()]],
    ['göreli düşüş var ama bahçenin ham NDVI\'si yerinde (komşular yeşillendi)', 'likely', [...optical('2026-02-20', 0.3, 0.25).map((s) => (s.key === 'ndvi' ? flatRaw(s) : s)), ...quiet()]],
    ['kış adımı güçlü, yaz başında tamamen toparlanmış (üst alma)', 'unclear', [...optical('2025-12-10', 0.3, 0.25, 75), ...quiet()]],
    ['Nisan başı budama (10 Nis), yaz gözlemiyle teyit', 'pruned', [...optical('2026-04-10', 0.35, 0.3), ...quiet()]],
];
let failed = 0;
for (const [name, expected, s, ctx] of cases) {
    const v = judge(s, '2026-07-15', ctx);
    const t = scanTimeline(s, '2025-10-15', '2026-07-15', 2, ctx);
    const o = v.observability;
    const ok = expected.split('|').includes(v.class);
    if (!ok) failed++;
    console.log(`${ok ? '✓' : '✗'} ${name} [beklenen ${expected}]\n   → ${v.class} z=${v.z} t0=${v.changeDate} optik=${v.opticalOk} radar=${v.backscatterOk} çapraz=${v.crossIndexOk} boşluk=${o.opticalGapDays} radarGerekli=${v.radarRequired} incele=${v.review} takvim=${v.inCalendar} tespit=${t.detectedAt} olası=${t.likelyAt}\n     seviye=${v.levels ? `${v.levels.ndviBefore}→${v.levels.ndviAfter} (${v.levels.ok})` : '—'} şekil=${v.shape ? `oran ${v.shape.ratio} eğim ${v.shape.trendChange} kademeli=${v.shape.gradual}` : '—'} toparlanma=${v.recovery ? `Δ${v.recovery.delta} z${v.recovery.z} ok=${v.recovery.ok}` : '—'}\n     ${v.groups.map((g) => `${g.group} z${g.z}`).join(', ')} | ${v.reason}`);
}
console.log(failed ? `\n${failed} senaryo beklenen sınıfın dışında` : '\nTüm senaryolar beklenen sınıfta');
process.exit(failed ? 1 : 0);
