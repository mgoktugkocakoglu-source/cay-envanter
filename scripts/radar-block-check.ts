/*
 * Block-scale radar test (offline, from the fusion caches): can Sentinel-1 see pruning once the speckle is averaged
 * over more ground than one small garden?
 *
 *   1. Noise floor: the spread of the before/after step of quiet tea, for single gardens and for contiguous blocks of
 *      growing area. It says how large a radar change has to be to stand out at each scale.
 *   2. Single gardens: the radar step of every garden the optical modules call pruned, against quiet gardens of similar
 *      size over the same dates.
 *   3. Blocks: neighbouring gardens pruned in the same period, averaged as one unit, against contiguous quiet blocks of
 *      the same area over the same dates.
 *   4. Stack: all pruned gardens together (Stouffer), by pruning class.
 *
 * Channels: VH (dB), VH/VV (dB), and the 6/12-day coherence (HyP3) where present. "Expected" direction: VH and VH/VV
 * fall, coherence rises.
 *
 *   node scripts/radar-block-check.ts --province Trabzon --district Of --neighborhood Çataldere --season 2025
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { NeighborhoodStore } from '../src/library/store.ts';

const { values } = parseArgs({ options: { province: { type: 'string' }, district: { type: 'string' }, neighborhood: { type: 'string' }, season: { type: 'string', default: '2025' }, draws: { type: 'string', default: '400' } } });
if (!values.province || !values.district || !values.neighborhood) throw new Error('--province --district --neighborhood gerekli');
const store = new NeighborhoodStore(values.province, values.district, values.neighborhood);
const year = Number(values.season);
const season = `${year}-${String(year + 1).slice(2)}`;
const read = <T>(...p: string[]): T => JSON.parse(readFileSync(join(store.dir, ...p), 'utf8')) as T;

type Row = Array<number | null>;
interface FusionFile { gardens: Array<{ id: string; areaM2: number; verdict: { class: string; kind?: string; changeDate: string | null; lastBeforeAt: string | null; firstAfterAt: string | null } }> }
interface PixelFile { gardens: Array<{ id: string; verdict: string; best: { date: string; lastBefore: string | null } | null; prunedM2: number; px: Array<[number, number, number, ...unknown[]]> }> }
interface SeriesFile { backscatter: Array<{ pass: string; dates: string[]; vh: Record<string, Row>; vv: Record<string, Row> }> }
interface CoherenceFile { passes: Array<{ pass: string; pairs: Array<[string, string]> }>; gardens: Record<string, Record<string, Row>> }

const fusion = read<FusionFile>('pruning-fusion', `season-${season}.json`);
const pixel = read<PixelFile>('pruning-pixels', `season-${season}.json`);
const series = read<SeriesFile>('pruning-fusion', `series-${season}.json`);
const cohPath = join(store.dir, 'pruning-radar', `coherence-hyp3-${season}.json`);
const coherence = existsSync(cohPath) ? (JSON.parse(readFileSync(cohPath, 'utf8')) as CoherenceFile) : null;

const median = (xs: number[]) => {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const quantile = (xs: number[], q: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]!;
};
const sigma = (xs: number[]) => {
    const m = median(xs);
    if (m === null) return null;
    const mad = median(xs.map((x) => Math.abs(x - m)));
    return mad === null ? null : 1.4826 * mad;
};
const r2 = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
let seed = 20261112;
const random = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};

// ── Gardens: area, lattice cells (adjacency and centroid), verdicts ──
const ids = fusion.gardens.map((g) => g.id);
const area = new Map(fusion.gardens.map((g) => [g.id, g.areaM2]));
const fusionOf = new Map(fusion.gardens.map((g) => [g.id, g.verdict]));
const pixelOf = new Map(pixel.gardens.map((g) => [g.id, g]));
const cellsOf = new Map(pixel.gardens.map((g) => [g.id, g.px.map((p) => [p[0], p[1]] as [number, number])]));
const centroid = new Map<string, [number, number]>();
const cellOwners = new Map<string, string[]>();
for (const [id, cells] of cellsOf) {
    if (cells.length === 0) continue;
    centroid.set(id, [cells.reduce((s, c) => s + c[0], 0) / cells.length, cells.reduce((s, c) => s + c[1], 0) / cells.length]);
    for (const [e, n] of cells) cellOwners.set(`${e}_${n}`, [...(cellOwners.get(`${e}_${n}`) ?? []), id]);
}
const neighbours = new Map<string, Set<string>>();
for (const [id, cells] of cellsOf) {
    const set = new Set<string>();
    for (const [e, n] of cells) for (const de of [-10, 0, 10]) for (const dn of [-10, 0, 10]) for (const o of cellOwners.get(`${e + de}_${n + dn}`) ?? []) if (o !== id) set.add(o);
    neighbours.set(id, set);
}

// ── Channels, neighbourhood-relative per date ──
interface Channel { key: string; label: string; unit: string; sign: 1 | -1; dates: string[]; rel: Map<string, Row> }
const relative = (byId: Record<string, Row>, n: number): Map<string, Row> => {
    const out = new Map<string, Row>(ids.map((id) => [id, []]));
    for (let t = 0; t < n; t++) {
        const med = median(ids.map((id) => byId[id]?.[t]).filter((v): v is number => v !== null && v !== undefined));
        for (const id of ids) {
            const v = byId[id]?.[t];
            out.get(id)!.push(v === null || v === undefined || med === null ? null : v - med);
        }
    }
    return out;
};
const channels: Channel[] = [];
for (const b of series.backscatter) {
    const tag = b.pass === 'ASCENDING' ? 'asc' : 'desc';
    channels.push({ key: `vh_${tag}`, label: 'VH', unit: 'dB', sign: -1, dates: b.dates, rel: relative(b.vh, b.dates.length) });
    const ratio = Object.fromEntries(ids.map((id) => [id, (b.vh[id] ?? []).map((v, t) => (v === null || v === undefined || b.vv[id]?.[t] === null || b.vv[id]?.[t] === undefined ? null : v - (b.vv[id]![t] as number)))]));
    channels.push({ key: `ratio_${tag}`, label: 'VH/VV', unit: 'dB', sign: -1, dates: b.dates, rel: relative(ratio, b.dates.length) });
}
for (const p of coherence?.passes ?? []) {
    const tag = p.pass === 'ASCENDING' ? 'asc' : 'desc';
    const byId = Object.fromEntries(ids.map((id) => [id, coherence!.gardens[id]?.[p.pass] ?? []]));
    // A pair is dated by its second acquisition: coherence after a cut needs both images after it.
    channels.push({ key: `coh_${tag}`, label: 'Koherans', unit: '', sign: 1, dates: p.pairs.map(([, d2]) => d2), rel: relative(byId, p.pairs.length) });
}
const families = [...new Set(channels.map((c) => c.label))];

// ── The before/after step of a set of gardens (area-weighted mean series) across a bracket ──
const WINDOW_DAYS = 60;
const MIN_OBS = 3;
function step(ch: Channel, members: string[], b0: string, b1: string): number | null {
    const from = addDays(b0, -WINDOW_DAYS);
    const to = addDays(b1, WINDOW_DAYS);
    const before: number[] = [];
    const after: number[] = [];
    ch.dates.forEach((d, t) => {
        const side = d >= from && d <= b0 ? before : d > b1 && d <= to ? after : null;
        if (!side) return;
        let sw = 0;
        let sv = 0;
        for (const id of members) {
            const v = ch.rel.get(id)?.[t];
            if (v === null || v === undefined) continue;
            const w = area.get(id) ?? 1;
            sw += w;
            sv += w * v;
        }
        if (sw > 0) side.push(sv / sw);
    });
    if (before.length < MIN_OBS || after.length < MIN_OBS) return null;
    return after.reduce((s, v) => s + v, 0) / after.length - before.reduce((s, v) => s + v, 0) / before.length;
}
/** Step per family: the mean over the orbits that have enough observations. */
function familyStep(label: string, members: string[], b0: string, b1: string): number | null {
    const xs = channels.filter((c) => c.label === label).map((c) => step(c, members, b0, b1)).filter((v): v is number => v !== null);
    return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
}

// ── Events and the quiet pool ──
interface Event { id: string; b0: string; b1: string; kind: 'deep' | 'light' | 'fusion'; source: string }
const events: Event[] = [];
for (const id of ids) {
    const p = pixelOf.get(id);
    const f = fusionOf.get(id)!;
    if (p && (p.verdict === 'deep' || p.verdict === 'light') && p.best) events.push({ id, b0: p.best.lastBefore ?? addDays(p.best.date, -10), b1: p.best.date, kind: p.verdict, source: f.class === 'pruned' || f.class === 'likely' ? 'ikisi' : 'piksel' });
    else if ((f.class === 'pruned' || f.class === 'likely') && f.lastBeforeAt && f.firstAfterAt) events.push({ id, b0: f.lastBeforeAt, b1: f.firstAfterAt, kind: 'fusion', source: 'çok-sensör' });
}
const eventIds = new Set(events.map((e) => e.id));
const quiet = ids.filter((id) => !eventIds.has(id) && pixelOf.get(id)?.verdict === 'none' && fusionOf.get(id)!.class === 'not_pruned' && centroid.has(id));
const quietSet = new Set(quiet);
const dist = (a: string, b: string) => {
    const ca = centroid.get(a)!;
    const cb = centroid.get(b)!;
    return Math.hypot(ca[0] - cb[0], ca[1] - cb[1]);
};
/** A contiguous quiet block: a random quiet garden and its nearest quiet gardens until the target area is reached. */
const nearestQuiet = new Map<string, string[]>();
function quietBlock(targetM2: number): string[] {
    const start = quiet[Math.floor(random() * quiet.length)]!;
    if (!nearestQuiet.has(start)) nearestQuiet.set(start, quiet.filter((q) => q !== start).sort((a, b) => dist(start, a) - dist(start, b)));
    const out = [start];
    let total = area.get(start) ?? 0;
    for (const q of nearestQuiet.get(start)!) {
        if (total >= targetM2) break;
        out.push(q);
        total += area.get(q) ?? 0;
    }
    return out;
}
const areaOf = (members: string[]) => members.reduce((s, id) => s + (area.get(id) ?? 0), 0);
const DRAWS = Number(values.draws);
/** Null z of a unit's step: against contiguous quiet blocks of the same area over the same bracket. */
function nullZ(label: string, members: string[], b0: string, b1: string): { step: number; z: number; nullSigma: number } | null {
    const s = familyStep(label, members, b0, b1);
    if (s === null) return null;
    const target = areaOf(members);
    const nulls: number[] = [];
    for (let i = 0; i < DRAWS; i++) {
        const v = familyStep(label, quietBlock(target), b0, b1);
        if (v !== null) nulls.push(v);
    }
    const m = median(nulls);
    const sd = sigma(nulls);
    if (nulls.length < 30 || m === null || sd === null || sd === 0) return null;
    return { step: s, z: (s - m) / sd, nullSigma: sd };
}

// ── 1. Noise floor by block area ──
const brackets = events.map((e) => [e.b0, e.b1] as [string, string]);
const scales = [0, 1000, 2000, 4000, 8000, 16000, 32000];
const noiseFloor = scales.map((target) => {
    const row: Record<string, unknown> = { targetM2: target };
    const areas: number[] = [];
    for (const label of families) {
        const xs: number[] = [];
        for (let i = 0; i < 1500; i++) {
            const [b0, b1] = brackets[Math.floor(random() * brackets.length)]!;
            const block = quietBlock(target);
            const v = familyStep(label, block, b0, b1);
            if (v !== null) {
                xs.push(v);
                areas.push(areaOf(block));
            }
        }
        const sd = sigma(xs);
        // The change that stands 2σ out of the quiet tea: the smallest step this scale can show.
        row[label] = { sigma: sd === null ? null : Math.round(sd * 1000) / 1000, detectable: sd === null ? null : Math.round(2 * sd * 1000) / 1000, n: xs.length };
    }
    row.medianAreaM2 = Math.round(median(areas) ?? 0);
    return row;
});

// ── 2. Single gardens ──
const single = events.map((e) => ({ ...e, areaM2: area.get(e.id) ?? 0, cutM2: pixelOf.get(e.id)?.prunedM2 ?? null, ...Object.fromEntries(families.map((label) => [label, nullZ(label, [e.id], e.b0, e.b1)])) }));

// ── 3. Blocks: neighbouring pruned gardens whose brackets overlap or lie within 30 days ──
const compatible = (a: Event, b: Event) => a.b0 <= addDays(b.b1, 30) && b.b0 <= addDays(a.b1, 30);
const byId = new Map(events.map((e) => [e.id, e]));
const seen = new Set<string>();
const blocks: Event[][] = [];
for (const e of events) {
    if (seen.has(e.id)) continue;
    const comp: Event[] = [];
    const queue = [e];
    seen.add(e.id);
    while (queue.length) {
        const cur = queue.pop()!;
        comp.push(cur);
        for (const n of neighbours.get(cur.id) ?? []) {
            const other = byId.get(n);
            if (other && !seen.has(n) && compatible(cur, other)) {
                seen.add(n);
                queue.push(other);
            }
        }
    }
    blocks.push(comp);
}
const multi = blocks.filter((b) => b.length >= 2).map((b) => {
    const members = b.map((e) => e.id);
    const b0 = b.map((e) => e.b0).sort()[0]!;
    const b1 = b.map((e) => e.b1).sort().at(-1)!;
    return { members, gardens: members.length, areaM2: Math.round(areaOf(members)), b0, b1, kinds: b.map((e) => e.kind), ...Object.fromEntries(families.map((label) => [label, nullZ(label, members, b0, b1)])) };
});
// Date groups: every garden pruned in the same optical bracket, averaged as one unit whether adjacent or not.
const groups = new Map<string, Event[]>();
for (const e of events) groups.set(`${e.b0}_${e.b1}`, [...(groups.get(`${e.b0}_${e.b1}`) ?? []), e]);
const dateGroups = [...groups.values()].filter((g) => g.length >= 3).map((g) => {
    const members = g.map((e) => e.id);
    return { b0: g[0]!.b0, b1: g[0]!.b1, gardens: members.length, areaM2: Math.round(areaOf(members)), ...Object.fromEntries(families.map((label) => [label, nullZ(label, members, g[0]!.b0, g[0]!.b1)])) };
});

// ── 4. Stack ──
type Scored = Record<string, { step: number; z: number; nullSigma: number } | null>;
const stack = (rows: Scored[], label: string, sign: number) => {
    const zs = rows.map((r) => r[label]).filter((v): v is { step: number; z: number; nullSigma: number } => v !== null && v !== undefined);
    if (zs.length === 0) return null;
    const expected = zs.map((v) => sign * v.z);
    return {
        n: zs.length,
        medianStep: r2(median(zs.map((v) => v.step))),
        meanZExpected: r2(expected.reduce((s, v) => s + v, 0) / zs.length),
        stoufferZ: r2(expected.reduce((s, v) => s + v, 0) / Math.sqrt(zs.length)),
        beyond90: zs.length ? r2(expected.filter((v) => v >= 1.2816).length / zs.length) : null,
        beyond95: zs.length ? r2(expected.filter((v) => v >= 1.6449).length / zs.length) : null,
    };
};
const signOf = (label: string) => channels.find((c) => c.label === label)!.sign;
const subsets: Array<[string, (e: (typeof single)[number]) => boolean]> = [
    ['tümü', () => true],
    ['derin', (e) => e.kind === 'deep'],
    ['hafif', (e) => e.kind === 'light'],
    ['iki modülün de bulduğu', (e) => e.source === 'ikisi'],
    ['bahçe ≥ 1000 m²', (e) => e.areaM2 >= 1000],
    ['kesim bahçenin ≥ %50’si', (e) => e.cutM2 !== null && e.areaM2 > 0 && e.cutM2 / e.areaM2 >= 0.5],
];
const singleStack = Object.fromEntries(subsets.map(([name, f]) => [name, Object.fromEntries(families.map((label) => [label, stack(single.filter(f) as unknown as Scored[], label, signOf(label))]))]));
// Placebo: quiet gardens given the real events' brackets. The procedure is sound when this stack shows nothing (z ≈ 0, 0.10 beyond the 90 % bar).
const placeboRows = Array.from({ length: 150 }, () => {
    const id = quiet[Math.floor(random() * quiet.length)]!;
    const [b0, b1] = brackets[Math.floor(random() * brackets.length)]!;
    return Object.fromEntries(families.map((label) => [label, nullZ(label, [id], b0, b1)]));
});
const placebo = Object.fromEntries(families.map((label) => [label, stack(placeboRows as Scored[], label, signOf(label))]));
const blockStack = Object.fromEntries(families.map((label) => [label, stack(multi as unknown as Scored[], label, signOf(label))]));
const groupStack = Object.fromEntries(families.map((label) => [label, stack(dateGroups as unknown as Scored[], label, signOf(label))]));

const round = <T>(x: T): T => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v))) as T;
const out = round({
    season,
    generatedAt: new Date().toISOString(),
    channels: channels.map((c) => ({ key: c.key, dates: c.dates.length })),
    windowDays: WINDOW_DAYS,
    events: events.length,
    quietGardens: quiet.length,
    note: 'Beklenen yön: VH ve VH/VV düşer, koherans yükselir. z, aynı tarih aralığında aynı büyüklükteki sessiz çay bloklarının dağılımına göredir; “beyond90” beklenen yönde %90 eşiğini aşanların payıdır (şans 0,10).',
    noiseFloor,
    single,
    singleStack,
    placebo,
    blocks: multi,
    blockStack,
    dateGroups,
    groupStack,
});
writeFileSync(join(store.dir, 'pruning-radar', `block-check-${season}.json`), JSON.stringify(out));

const fmt = (v: unknown) => (v === null || v === undefined ? '—' : String(v));
console.log(`${events.length} budanmış bahçe (olay), ${quiet.length} sessiz bahçe (kontrol havuzu), ${quietSet.size ? '' : ''}kanallar: ${channels.map((c) => `${c.key} ${c.dates.length}`).join(', ')}`);
console.log('\n1) Gürültü tabanı (sessiz çayda önce/sonra farkının yayılımı; 2σ = görülebilecek en küçük değişim):');
for (const r of out.noiseFloor as Array<Record<string, { sigma: number; detectable: number } | number>>) console.log(`  hedef ${fmt(r.targetM2)} m² (ortanca ${fmt(r.medianAreaM2)} m²): ${families.map((l) => `${l} σ ${fmt((r[l] as { sigma: number }).sigma)} · 2σ ${fmt((r[l] as { detectable: number }).detectable)}`).join(' | ')}`);
console.log('\n2) Tek bahçe (yığın):');
for (const [name, byLabel] of Object.entries(out.singleStack)) console.log(`  ${name}: ${families.map((l) => { const s = (byLabel as Record<string, ReturnType<typeof stack>>)[l]; return s ? `${l} n ${s.n} · ortanca adım ${s.medianStep} · Stouffer z ${s.stoufferZ} · %90 üstü ${s.beyond90}` : `${l} —`; }).join(' | ')}`);
console.log(`  plasebo (sessiz bahçeler, aynı tarihler): ${families.map((l) => { const s = (out.placebo as Record<string, ReturnType<typeof stack>>)[l]; return s ? `${l} n ${s.n} · ortalama z ${s.meanZExpected} · %90 üstü ${s.beyond90} · %95 üstü ${s.beyond95}` : `${l} —`; }).join(' | ')}`);
console.log(`\n3) Komşu bloklar (≥ 2 bahçe): ${multi.length}`);
for (const b of out.blocks as Array<Record<string, unknown>>) console.log(`  ${(b.members as string[]).join('+')} · ${fmt(b.areaM2)} m² · ${fmt(b.b0)} → ${fmt(b.b1)} · ${families.map((l) => { const s = b[l] as { step: number; z: number } | null; return s ? `${l} adım ${s.step} z ${s.z}` : `${l} —`; }).join(' | ')}`);
console.log(`  blok yığını: ${families.map((l) => { const s = (out.blockStack as Record<string, ReturnType<typeof stack>>)[l]; return s ? `${l} n ${s.n} · Stouffer z ${s.stoufferZ} · %90 üstü ${s.beyond90}` : `${l} —`; }).join(' | ')}`);
console.log(`\n4) Aynı tarih aralığında budananlar tek birim (≥ 3 bahçe): ${dateGroups.length}`);
for (const g of out.dateGroups as Array<Record<string, unknown>>) console.log(`  ${fmt(g.b0)} → ${fmt(g.b1)} · ${fmt(g.gardens)} bahçe · ${fmt(g.areaM2)} m² · ${families.map((l) => { const s = g[l] as { step: number; z: number } | null; return s ? `${l} adım ${s.step} z ${s.z}` : `${l} —`; }).join(' | ')}`);
console.log(`  grup yığını: ${families.map((l) => { const s = (out.groupStack as Record<string, ReturnType<typeof stack>>)[l]; return s ? `${l} n ${s.n} · Stouffer z ${s.stoufferZ}` : `${l} —`; }).join(' | ')}`);
