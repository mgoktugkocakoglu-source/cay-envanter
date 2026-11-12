import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One NDVI timeline per lattice pixel over every cached season of the pixel scan, and the step tests that read it:
 * a pixel set (a detected cluster, or a whole garden) against its reference (the garden's other pixels, else the
 * neighbourhood's tea) around a cut bracket, in the cut's own season and shifted by whole years.
 *
 * Used by the combined verdict (does the same step repeat a year earlier? → seasonal pattern, not a pruning) and by
 * the retrospective check. Reads the caches only; plain relative series, no seasonal baseline.
 */
export const TIMELINE_RULES = {
    preDays: 75,
    dipDays: 60,
    minObs: 2,
    /** The cut must be visible in the plain relative series by at least this much to be tested at all. */
    minDrop: 0.02,
    /** A step of at least this share of the drop, same pixels and same time of year in the neighbouring season = repeating. */
    repeatShare: 0.6,
    intraMinPixels: 5,
    collapseNdvi: 0.65,
    minDateCoverage: 0.3,
    teaShareMin: 0.75,
};

/** Simulated cut (scan-pixels --simulate): half the drop on the first days, full by day 10; deep cuts hold into summer, light ones are back in ~90 days. */
export function cutShape(kind: 'deep' | 'light', days: number): number {
    return Math.min(1, 0.5 + days / 20) * (kind === 'deep' ? (days <= 150 ? 1 : Math.max(0.6, 1 - (days - 150) / 250)) : Math.max(0, 1 - days / 90));
}

export interface SeriesOptions {
    /** −1 reads the mirrored series (validation: rises become drops). */
    sign?: 1 | -1;
    /** A simulated cut replayed onto the real series (validation), exactly as scan-pixels injects it. */
    injection?: { pix: Set<number>; depth: number; kind: 'deep' | 'light'; at: string; until: string };
}
export interface RepeatCheck {
    drop: number | null;
    prevStep: number | null;
    /** true = the same step is there a year earlier; null = not testable (no drop in the plain series, or no earlier season). */
    repeat: boolean | null;
}

interface Raw { dates: string[]; pixels: Array<[number, number]>; ndvi: Array<Array<number | null>> }
interface Cell { pix: number; e: number; n: number; insideM2: number; insideShare: number }

const DAY = 86_400_000;
export const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const median = (xs: number[]): number | null => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

export class PixelTimeline {
    readonly dates: string[];
    readonly cells: Record<string, Cell[]>;
    private readonly rows: Array<Array<number | null>>;
    private readonly nbh: Array<number | null>;
    private readonly pixIndex: Map<string, number>;
    private readonly R: typeof TIMELINE_RULES;

    constructor(pixDir: string, rules: Partial<typeof TIMELINE_RULES> = {}) {
        this.R = { ...TIMELINE_RULES, ...rules };
        const lattice = JSON.parse(readFileSync(join(pixDir, 'lattice.json'), 'utf8')) as { pixels: Array<[number, number]>; cells: Record<string, Cell[]>; teaShare: number[] };
        this.cells = lattice.cells;
        this.pixIndex = new Map(lattice.pixels.map(([e, n], i) => [`${e}_${n}`, i]));
        // The two-week overlap between consecutive seasons is taken once.
        const at = new Map<string, Array<number | null>>();
        for (const name of readdirSync(pixDir).filter((n) => /^cache-\d{4}-\d{2}\.json$/.test(n)).sort()) {
            const raw = JSON.parse(readFileSync(join(pixDir, name), 'utf8')) as Raw;
            const where = new Map(raw.pixels.map(([e, n], i) => [`${e}_${n}`, i]));
            const idx = lattice.pixels.map(([e, n]) => where.get(`${e}_${n}`));
            raw.dates.forEach((d, t) => {
                if (at.has(d)) return;
                at.set(d, idx.map((j) => (j === undefined ? null : ((raw.ndvi[j] as Array<number | null>)[t] ?? null))));
            });
        }
        this.dates = [...at.keys()].sort();
        this.rows = this.dates.map((d) => at.get(d) as Array<number | null>);
        const teaPix = lattice.pixels.map((_, i) => i).filter((i) => (lattice.teaShare[i] as number) >= this.R.teaShareMin);
        // Neighbourhood reference per date; collapsed (snow / frost / shadow) and thinly covered dates are dropped, as in the scan.
        this.nbh = this.rows.map((row) => {
            const vals = teaPix.map((i) => row[i]).filter((v): v is number => v !== null && v !== undefined);
            const med = median(vals);
            return med !== null && vals.length / Math.max(1, teaPix.length) >= this.R.minDateCoverage && med >= this.R.collapseNdvi ? med : null;
        });
    }

    get lastDate(): string {
        return this.dates[this.dates.length - 1] as string;
    }
    /** Lattice indexes of [e, n] cells (cells outside the lattice are dropped). */
    indexes(cells: Array<[number, number] | number[]>): number[] {
        return cells.map((c) => this.pixIndex.get(`${c[0]}_${c[1]}`)).filter((i): i is number => i !== undefined);
    }
    gardenPix(id: string): number[] {
        return (this.cells[id] ?? []).map((c) => c.pix);
    }
    /** The garden's pixels outside the cluster, when there are enough of them to be a reference. */
    refFor(id: string, cluster: number[]): number[] | null {
        const inCluster = new Set(cluster);
        const rest = this.gardenPix(id).filter((i) => !inCluster.has(i));
        return rest.length >= this.R.intraMinPixels ? rest : null;
    }

    /** Relative NDVI of a pixel set against its reference (the given pixels, else the neighbourhood). */
    series(pix: number[], ref: number[] | null, opts: SeriesOptions = {}): Array<number | null> {
        const inj = opts.injection;
        const value = (i: number, t: number): number | null => {
            const v = (this.rows[t] as Array<number | null>)[i];
            if (v === null || v === undefined) return null;
            const d = this.dates[t] as string;
            return inj && inj.pix.has(i) && d > inj.at && d <= inj.until ? v - inj.depth * cutShape(inj.kind, daysBetween(inj.at, d)) : v;
        };
        return this.dates.map((_, t) => {
            if (this.nbh[t] === null) return null;
            const own = pix.map((i) => value(i, t)).filter((v): v is number => v !== null);
            if (own.length < Math.max(1, Math.ceil(pix.length / 2))) return null;
            const refVals = ref ? ref.map((i) => value(i, t)).filter((v): v is number => v !== null) : [];
            const base = ref && refVals.length >= Math.max(1, Math.ceil(ref.length / 2)) ? (median(refVals) as number) : (this.nbh[t] as number);
            return (opts.sign ?? 1) * ((median(own) as number) - base);
        });
    }
    window(c: Array<number | null>, from: string, to: string, min: number): number | null {
        const vals = this.dates.map((d, t) => (d >= from && d <= to ? c[t] : null)).filter((v): v is number => v !== null && v !== undefined);
        return vals.length >= min ? median(vals) : null;
    }
    /** Level before the bracket minus level after it, with both windows shifted by `shift` days. */
    step(c: Array<number | null>, lastBefore: string, date: string, shift = 0): { pre: number | null; dip: number | null; step: number | null } {
        const pre = this.window(c, addDays(lastBefore, shift - this.R.preDays), addDays(lastBefore, shift), this.R.minObs);
        const dip = this.window(c, addDays(date, shift), addDays(date, shift + this.R.dipDays), this.R.minObs);
        return { pre, dip, step: pre !== null && dip !== null ? pre - dip : null };
    }
    /** Does the step of this bracket also stand a year earlier, on the same pixels? Uses nothing later than the cut's own season. */
    repeatsPrev(pix: number[], ref: number[] | null, lastBefore: string, date: string, opts: SeriesOptions = {}): RepeatCheck {
        const c = this.series(pix, ref, opts);
        const now = this.step(c, lastBefore, date).step;
        const out: RepeatCheck = { drop: now === null ? null : Math.round(now * 1000) / 1000, prevStep: null, repeat: null };
        if (now === null || now < this.R.minDrop) return out;
        const prev = this.step(c, lastBefore, date, -365).step;
        if (prev === null) return out;
        out.prevStep = Math.round(prev * 1000) / 1000;
        out.repeat = prev >= this.R.repeatShare * now;
        return out;
    }
}
