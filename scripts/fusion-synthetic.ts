import { CHANNEL_DEFAULTS, judge, scanTimeline, type ChannelSeries } from '../src/fusion/model.ts';
let seed = 11;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());
const dates = (from: string, step: number, n: number) => Array.from({ length: n }, (_, i) => new Date(Date.parse(from) + i * step * 864e5).toISOString().slice(0, 10));
function series(key: keyof typeof CHANNEL_DEFAULTS, ds: string[], noise: number, stepAt: string | null, stepSize: number, recoverAfterDays = 0, gaps = 0.3): ChannelSeries {
    const sign = CHANNEL_DEFAULTS[key].sign;
    const values = ds.map((d) => {
        if (rnd() < gaps) return null;
        let v = gauss() * noise;
        if (stepAt && d >= stepAt) {
            const dt = (Date.parse(d) - Date.parse(stepAt)) / 864e5;
            if (!recoverAfterDays || dt < recoverAfterDays) v += sign * stepSize;
        }
        return v;
    });
    return { key, dates: ds, values, ...CHANNEL_DEFAULTS[key] };
}
const S2 = dates('2025-09-02', 4, 60), ASC = dates('2025-09-04', 6, 43), DES = dates('2025-09-10', 6, 40);
const cases: Array<[string, ChannelSeries[]]> = [
    ['derin budama 25 Kas (NDVI −0.35, VH −2.5 dB)', [series('ndvi', S2, 0.04, '2025-11-25', 0.35), series('nbr', S2, 0.04, '2025-11-25', 0.3), series('vh_asc', ASC, 1.4, '2025-11-25', 2.5), series('vh_desc', DES, 1.4, '2025-11-25', 2.5)]],
    ['hafif budama (NDVI −0.15, VH −1.2 dB)', [series('ndvi', S2, 0.04, '2025-12-10', 0.15), series('nbr', S2, 0.04, '2025-12-10', 0.12), series('vh_asc', ASC, 1.4, '2025-12-10', 1.2), series('vh_desc', DES, 1.4, '2025-12-10', 1.2)]],
    ['geçici (kar/gölge 10 gün)', [series('ndvi', S2, 0.04, '2025-12-10', 0.35, 10), series('nbr', S2, 0.04, '2025-12-10', 0.3, 10), series('vh_asc', ASC, 1.4, null, 0), series('vh_desc', DES, 1.4, null, 0)]],
    ['yalnız optik düşüş (radar sessiz)', [series('ndvi', S2, 0.04, '2025-12-10', 0.3), series('nbr', S2, 0.04, '2025-12-10', 0.25), series('vh_asc', ASC, 1.4, null, 0), series('vh_desc', DES, 1.4, null, 0)]],
    ['değişim yok', [series('ndvi', S2, 0.04, null, 0), series('nbr', S2, 0.04, null, 0), series('vh_asc', ASC, 1.4, null, 0), series('vh_desc', DES, 1.4, null, 0)]],
    ['bulutlu kış: optik %70 boşluk', [series('ndvi', S2, 0.04, '2025-11-25', 0.35, 0, 0.7), series('nbr', S2, 0.04, '2025-11-25', 0.3, 0, 0.7), series('vh_asc', ASC, 1.4, '2025-11-25', 2.5), series('vh_desc', DES, 1.4, '2025-11-25', 2.5)]],
];
for (const [name, s] of cases) {
    const v = judge(s, '2026-04-30');
    const t = scanTimeline(s, '2025-11-01', '2026-04-30', 2);
    console.log(`${name}\n   → ${v.class} z=${v.z} p=${v.p} t0=${v.changeDate} agree=${v.agreeing} tespit=${t.detectedAt} olası=${t.likelyAt} | ${v.groups.map((g) => `${g.group} z${g.z}`).join(', ')} | ${v.reason}`);
}
