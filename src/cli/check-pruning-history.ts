import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { NeighborhoodStore } from '../library/store.ts';
import type { CombinedClass, CombinedSeasonFile } from './combine-pruning.ts';
import { addDays, PixelTimeline } from '../pruning/pixel-timeline.ts';

const USAGE = `
Kullanım:
  npm run pruning-history -- --province Trabzon --district Of --neighborhood Çataldere

Geriye dönük doğrulama (birleşik kararın eki; hiçbir kararı değiştirmez): her sezonun tespitleri, o sezonun kararında
kullanılmamış olan komşu sezonların piksel serileriyle sınanır.
  budama deseni : düşüş bir yıl sonra kapanmış, komşu sezonlarda aynı dönemde tekrarlamıyor
  yavaş         : bir yıl sonra kısmen kapanmış
  kalıcı        : bir yıl sonra hâlâ kapanmamış (söküm / yapılaşma / örtü değişimi olabilir; budama gibi davranmıyor)
  tekrarlayan   : aynı piksellerde, aynı dönemde komşu sezonda da benzer düşüş (mevsimsel yapay etki ya da yıllık bakım)
Aynı sınama ayna testinin sahte tespitlerine de uygulanır: sahte tespitlerin ne kadarının "budama deseni" verdiği
bilinmeden gerçek tespitlerin geçme oranı bir şey söylemez. Ayrıca sezonlar arası aynı zeminin yeniden sayılması ve
müstahsil başına birikimli alan çıkarılır. Çıktı: pruning-combined/history.json
`;

export const HISTORY_RULES = {
    preDays: 75,
    dipDays: 60,
    minObs: 2,
    /** The cut must be visible in the plain relative series (no seasonal baseline) by at least this much to be followed. */
    minDrop: 0.02,
    /** "A year later": the window after the cut in which the canopy is read again. */
    yearFrom: 300,
    yearTo: 420,
    minYearObs: 3,
    /** Share of the drop closed a year later: at or above = pruning pattern, below `permanent` = not behaving like a pruning. */
    recovered: 0.6,
    permanent: 0.3,
    /** A step of at least this share of the drop, same pixels and same time of year in the neighbouring season = repeating. */
    repeatShare: 0.6,
    /** Two seasons credit the same ground when the smaller detection shares at least this much of its pixels with the other. */
    groundOverlap: 0.5,
    intraMinPixels: 5,
    collapseNdvi: 0.65,
    minDateCoverage: 0.3,
    teaShareMin: 0.75,
};

export type FollowUpStatus = 'pattern' | 'slow' | 'permanent' | 'repeating' | 'no_followup' | 'not_seen';
export interface FollowUp {
    status: FollowUpStatus;
    /** Which evidence the check ran on: the pixel cluster (against the rest of the garden) or the whole garden (against the neighbourhood). */
    unit: 'cluster' | 'garden';
    pixels: number;
    drop: number | null;
    recoveredShare: number | null;
    repeatPrev: boolean | null;
    repeatNext: boolean | null;
}
type Counts = Record<FollowUpStatus, number>;
export interface HistoryPrecision { evaluated: number; pattern: number; share: number | null }
export interface HistorySeason {
    season: string;
    /** Whether the following season exists, i.e. whether "a year later" can be read at all. */
    hasFollowUp: boolean;
    inProgress?: boolean;
    /** "seasonal" = detections the combined verdict already set aside by the previous-season repeat test. */
    byClass: Record<'confirmed' | 'probable' | 'light' | 'seasonal', Counts>;
    /** The same check on the mirrored runs' false detections of both modules. */
    mirror: { pixel: Counts; fusion: Counts } | null;
    real: Record<'confirmed' | 'probable' | 'light' | 'counted', HistoryPrecision>;
    falsePassRate: HistoryPrecision | null;
    /** Lower bound of the true share among counted detections: (p − b) / (1 − b), p = real pass share, b = false pass share. */
    precisionFloor: number | null;
}
export interface HistoryGarden {
    id: string;
    producerId: string;
    seasons: Record<string, { class: CombinedClass; countedM2: number; followUp: FollowUp | null }>;
    /** Pairs of seasons that credit (mostly) the same pixels: under the 1/7 rule the same ground is not cut deep twice. */
    repeatedGround: Array<{ a: string; b: string; share: number; m2: number }>;
}
export interface HistoryProducer {
    id: string;
    licensedAreaM2: number;
    bySeason: Record<string, { countedM2: number; requiredM2: number; status: string }>;
    cumulativeM2: number;
    repeatedM2: number;
    netM2: number;
    requiredM2: number;
    seasonsMet: number;
    status: 'on_track' | 'behind' | 'none' | 'no_license';
}
export interface HistoryFile {
    generatedAt: string;
    method: string;
    rules: typeof HISTORY_RULES;
    seasons: HistorySeason[];
    multiYear: { seasons: string[]; gardensRepeated: number; repeatedM2: number; producers: Record<HistoryProducer['status'], number> };
    gardens: HistoryGarden[];
    producers: HistoryProducer[];
}

interface PixelSeason { gardens: Array<{ id: string; verdict: string; mainCluster: number | null; best: { date: string; lastBefore: string | null } | null; px: Array<[number, number, number, number | null, number | null, number, number, number]> }> }

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const emptyCounts = (): Counts => ({ pattern: 0, slow: 0, permanent: 0, repeating: 0, no_followup: 0, not_seen: 0 });

function main(): void {
    const { values } = parseArgs({ options: { province: { type: 'string' }, district: { type: 'string' }, neighborhood: { type: 'string' } } });
    if (!values.province || !values.district || !values.neighborhood) {
        console.log(USAGE);
        process.exit(1);
    }
    const R = HISTORY_RULES;
    const store = new NeighborhoodStore(values.province, values.district, values.neighborhood);
    const pixDir = join(store.dir, 'pruning-pixels');
    const combDir = join(store.dir, 'pruning-combined');
    const read = <T>(path: string) => JSON.parse(readFileSync(path, 'utf8')) as T;
    const timeline = new PixelTimeline(pixDir, R);
    const check = (pix: number[], ref: number[] | null, lastBefore: string, date: string, sign: 1 | -1, unit: 'cluster' | 'garden'): FollowUp => {
        const c = timeline.series(pix, ref, { sign });
        const now = timeline.step(c, lastBefore, date);
        const out: FollowUp = { status: 'not_seen', unit, pixels: pix.length, drop: now.step === null ? null : r3(now.step), recoveredShare: null, repeatPrev: null, repeatNext: null };
        if (now.step === null || now.step < R.minDrop) return out;
        const prev = timeline.step(c, lastBefore, date, -365).step;
        const next = timeline.step(c, lastBefore, date, 365).step;
        out.repeatPrev = prev === null ? null : prev >= R.repeatShare * now.step;
        out.repeatNext = next === null ? null : next >= R.repeatShare * now.step;
        const after = timeline.window(c, addDays(date, R.yearFrom), addDays(date, R.yearTo), R.minYearObs);
        if (after !== null) out.recoveredShare = r3((after - (now.dip as number)) / now.step);
        if (out.repeatPrev || out.repeatNext) out.status = 'repeating';
        else if (out.recoveredShare === null) out.status = 'no_followup';
        else out.status = out.recoveredShare >= R.recovered ? 'pattern' : out.recoveredShare >= R.permanent ? 'slow' : 'permanent';
        return out;
    };
    const gardenPix = (id: string) => timeline.gardenPix(id);
    const refFor = (id: string, cluster: Set<number>) => timeline.refFor(id, [...cluster]);
    const pixIndex = { get: (key: string) => timeline.indexes([key.split('_').map(Number)])[0] };
    const keyOf = (e: number, n: number) => `${e}_${n}`;
    const lattice = { cells: timeline.cells };

    const seasonNames = readdirSync(combDir).filter((n) => /^season-\d{4}-\d{2}\.json$/.test(n)).sort().map((n) => n.slice(7, 14));
    const gardens = new Map<string, HistoryGarden>();
    const ground = new Map<string, Map<string, Set<number>>>(); // garden → season → credited pixels
    const combinedBySeason = new Map<string, CombinedSeasonFile>();
    const seasons: HistorySeason[] = [];
    const lastDate = timeline.lastDate;

    for (const season of seasonNames) {
        const combined = read<CombinedSeasonFile>(join(combDir, `season-${season}.json`));
        combinedBySeason.set(season, combined);
        const pixelPath = join(pixDir, `season-${season}.json`);
        const pixel = new Map((existsSync(pixelPath) ? read<PixelSeason>(pixelPath).gardens : []).map((g) => [g.id, g]));
        const byClass = { confirmed: emptyCounts(), probable: emptyCounts(), light: emptyCounts(), seasonal: emptyCounts() };
        for (const g of combined.gardens) {
            if (g.class !== 'confirmed' && g.class !== 'probable' && g.class !== 'light' && g.class !== 'seasonal') continue;
            const px = pixel.get(g.id);
            let followUp: FollowUp | null = null;
            let credited: number[] = [];
            if (g.agreement !== 'fusion_only' && px && px.mainCluster !== null && px.best) {
                const cluster = px.px.filter((x) => x[5] > 0 && x[6] === px.mainCluster).map((x) => pixIndex.get(keyOf(x[0], x[1]))).filter((i): i is number => i !== undefined);
                if (cluster.length) {
                    followUp = check(cluster, refFor(g.id, new Set(cluster)), px.best.lastBefore ?? addDays(px.best.date, -15), px.best.date, 1, 'cluster');
                    credited = cluster;
                }
            } else {
                const all = gardenPix(g.id);
                const date = g.fusion.firstAfterAt ?? g.fusion.changeDate;
                if (all.length && date) {
                    followUp = check(all, null, g.fusion.lastBeforeAt ?? addDays(date, -15), date, 1, 'garden');
                    credited = all;
                }
            }
            if (followUp) byClass[g.class][followUp.status]++;
            const entry = gardens.get(g.id) ?? { id: g.id, producerId: g.producerId, seasons: {}, repeatedGround: [] };
            entry.seasons[season] = { class: g.class, countedM2: g.countedM2, followUp };
            gardens.set(g.id, entry);
            if (g.countedM2 > 0 && credited.length) {
                const m = ground.get(g.id) ?? new Map<string, Set<number>>();
                m.set(season, new Set(credited));
                ground.set(g.id, m);
            }
        }

        // The same check on the mirrored runs: how often does a false detection look like a pruning a year later?
        const mirrorPixelPath = join(pixDir, `validation-${season}-cv-mirror.json`);
        const mirrorFusionPath = join(store.dir, 'pruning-fusion', `validation-${season}-fv-mirror.json`);
        let mirror: HistorySeason['mirror'] = null;
        if (existsSync(mirrorPixelPath) && existsSync(mirrorFusionPath)) {
            mirror = { pixel: emptyCounts(), fusion: emptyCounts() };
            const mp = read<{ positives: Array<{ id: string; date: string | null; lastBefore: string | null; cells?: Array<[number, number]> }> }>(mirrorPixelPath);
            for (const p of mp.positives) {
                const cluster = (p.cells ?? []).map(([e, n]) => pixIndex.get(keyOf(e, n))).filter((i): i is number => i !== undefined);
                if (!cluster.length || !p.date) continue;
                mirror.pixel[check(cluster, refFor(p.id, new Set(cluster)), p.lastBefore ?? addDays(p.date, -15), p.date, -1, 'cluster').status]++;
            }
            const mf = read<{ positives: Array<{ id: string; changeDate: string | null }> }>(mirrorFusionPath);
            for (const p of mf.positives) {
                const all = gardenPix(p.id);
                if (!all.length || !p.changeDate) continue;
                mirror.fusion[check(all, null, addDays(p.changeDate, -15), p.changeDate, -1, 'garden').status]++;
            }
        }
        const precision = (c: Counts): HistoryPrecision => {
            const evaluated = c.pattern + c.slow + c.permanent + c.repeating + c.not_seen;
            return { evaluated, pattern: c.pattern, share: evaluated ? r3(c.pattern / evaluated) : null };
        };
        const sum = (...cs: Counts[]): Counts => {
            const o = emptyCounts();
            for (const c of cs) for (const k of Object.keys(o) as FollowUpStatus[]) o[k] += c[k];
            return o;
        };
        const hasFollowUp = addDays(`${season.slice(0, 4)}-10-01`, R.yearTo) <= lastDate;
        const real = { confirmed: precision(byClass.confirmed), probable: precision(byClass.probable), light: precision(byClass.light), counted: precision(sum(byClass.confirmed, byClass.probable)) };
        const falsePass = mirror ? precision(sum(mirror.pixel, mirror.fusion)) : null;
        const p = real.counted.share;
        const b = falsePass?.share ?? null;
        const precisionFloor = hasFollowUp && falsePass && p !== null && b !== null && real.counted.evaluated >= 5 && falsePass.evaluated >= 5 && b < 1 ? r3(Math.max(0, (p - b) / (1 - b))) : null;
        seasons.push({ season, inProgress: !!combined.inProgress, hasFollowUp, byClass, mirror, real, falsePassRate: falsePass, precisionFloor });
    }

    // Multi-year consistency: the same pixels credited in two seasons.
    const insideM2 = new Map<string, Map<number, number>>(Object.entries(lattice.cells).map(([id, cells]) => [id, new Map(cells.map((c) => [c.pix, c.insideM2]))]));
    const repeatedByProducer = new Map<string, number>();
    let gardensRepeated = 0;
    let repeatedM2 = 0;
    for (const [id, bySeason] of ground) {
        const list = [...bySeason.entries()].sort((x, y) => x[0].localeCompare(y[0]));
        const entry = gardens.get(id) as HistoryGarden;
        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
                const [a, A] = list[i] as [string, Set<number>];
                const [b, B] = list[j] as [string, Set<number>];
                const common = [...A].filter((x) => B.has(x));
                const share = common.length / Math.min(A.size, B.size);
                if (share < R.groundOverlap) continue;
                const m2 = Math.min(Math.round(common.reduce((s, x) => s + (insideM2.get(id)?.get(x) ?? 0), 0)), (entry.seasons[a] as { countedM2: number }).countedM2, (entry.seasons[b] as { countedM2: number }).countedM2);
                entry.repeatedGround.push({ a, b, share: r3(share), m2 });
                repeatedByProducer.set(entry.producerId, (repeatedByProducer.get(entry.producerId) ?? 0) + m2);
                repeatedM2 += m2;
            }
        }
        if (entry.repeatedGround.length) gardensRepeated++;
    }

    // Producers: what the seasons add up to against n/7 of the licensed area.
    const producerIds = new Set<string>();
    for (const c of combinedBySeason.values()) for (const p of c.producers) producerIds.add(p.id);
    const producers: HistoryProducer[] = [...producerIds].sort().map((id) => {
        const bySeason: HistoryProducer['bySeason'] = {};
        let licensed = 0;
        let cumulative = 0;
        let met = 0;
        let required = 0;
        for (const [season, c] of combinedBySeason) {
            // A running season has no full-year target yet: it stays out of the cumulative account.
            if (c.inProgress) continue;
            const p = c.producers.find((x) => x.id === id);
            if (!p) continue;
            licensed = Math.max(licensed, p.licensedAreaM2);
            bySeason[season] = { countedM2: p.countedM2, requiredM2: p.requiredM2, status: p.status };
            cumulative += p.countedM2;
            required += p.requiredM2;
            if (p.status === 'met' || p.status === 'met_with_probable') met++;
        }
        const repeated = Math.min(cumulative, repeatedByProducer.get(id) ?? 0);
        const net = cumulative - repeated;
        const status: HistoryProducer['status'] = licensed <= 0 ? 'no_license' : net <= 0 ? 'none' : net >= required ? 'on_track' : 'behind';
        return { id, licensedAreaM2: licensed, bySeason, cumulativeM2: cumulative, repeatedM2: repeated, netM2: net, requiredM2: required, seasonsMet: met, status };
    });
    const producerCounts: Record<HistoryProducer['status'], number> = { on_track: 0, behind: 0, none: 0, no_license: 0 };
    for (const p of producers) producerCounts[p.status]++;

    const out: HistoryFile = {
        generatedAt: new Date().toISOString(),
        method: 'Tespit edilen piksellerin (yoksa bahçenin) göreli NDVI serisi, kararda kullanılmamış komşu sezonlarda izlenir: bir yıl sonra kapanma, aynı dönemde tekrarlama. Aynı sınama ayna testinin sahte tespitlerine uygulanır. Saha doğrulaması değildir.',
        rules: R,
        seasons,
        multiYear: { seasons: seasonNames.filter((s) => !combinedBySeason.get(s)?.inProgress), gardensRepeated, repeatedM2, producers: producerCounts },
        gardens: [...gardens.values()].sort((a, b) => a.id.localeCompare(b.id)),
        producers,
    };
    writeFileSync(join(combDir, 'history.json'), JSON.stringify(out));
    for (const s of seasons) {
        console.log(`${s.season}${s.hasFollowUp ? '' : ' (sonraki sezon henüz yok)'}`);
        for (const k of ['confirmed', 'probable', 'light', 'seasonal'] as const) console.log(`  ${k.padEnd(9)} ${JSON.stringify(s.byClass[k])}`);
        if (s.mirror) console.log(`  ayna      piksel ${JSON.stringify(s.mirror.pixel)} · çok-sensör ${JSON.stringify(s.mirror.fusion)}`);
        console.log(`  desen payı: sayılan ${s.real.counted.pattern}/${s.real.counted.evaluated} · sahte ${s.falsePassRate ? `${s.falsePassRate.pattern}/${s.falsePassRate.evaluated}` : '—'} · doğruluk alt sınırı ${s.precisionFloor ?? '—'}`);
    }
    console.log(`Çok yıllı: ${gardensRepeated} bahçede aynı zemin iki sezonda sayıldı (${repeatedM2} m²) · müstahsil ${JSON.stringify(producerCounts)}`);
    console.log(`Yazıldı: ${join(combDir, 'history.json')}`);
}

main();
