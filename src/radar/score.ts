/**
 * Radar confirmation of optical pruning events — the mowing-detection recipe adapted to tea.
 *
 * For each garden and orbit pass the VH (and VH/VV) series is first made RELATIVE to the
 * neighbourhood: the median over all gardens on the same date is subtracted, which removes
 * rain, snow and seasonal moisture that move every garden together. An event is then judged
 * on the relative series: mean of the observations before the change window minus the mean
 * after it (dB; positive = canopy removed), and how many of the after observations stay down
 * (persistence — tea does not grow back in weeks, so a true pruning stays down).
 *
 * Thresholds are pre-calibration (no field labels yet) and deliberately conservative: radar is
 * a CONFIRMATION layer on the optical record, never the decision on its own.
 */
import type { PassSeries } from './series.ts';

export const RADAR_RULES = {
    /** Observations this many days before / after the change window are compared. */
    beforeDays: 48,
    afterDays: 60,
    /** Each side needs at least this many observations to say anything. */
    minObs: 3,
    /** Smallest relative VH drop (dB) worth calling canopy removal, whatever the z-score. */
    vhDropDb: 0.8,
    /**
     * Speckle on a 0.1 ha garden is ±1.4 dB per observation, so a drop is judged against the
     * garden's OWN noise: z = drop / (noise · √(1/n_before + 1/n_after)).
     */
    zConfirm: 2.5,
    zWeak: 1.5,
    zContradict: -2.5,
    /** Share of after-observations that must stay below the before-mean. */
    persistence: 0.6,
    /** Radar-only candidate (no optical event): the best date of ~45 must clear a much higher bar. */
    radarOnlyZ: 4.0,
    radarOnlyMinObs: 5,
    radarOnlyPersistence: 0.75,
} as const;

export type RadarClass = 'confirmed' | 'weak' | 'neutral' | 'contradicted' | 'no_data';

export interface PassResult {
    pass: PassSeries['pass'];
    beforeObs: number;
    afterObs: number;
    vhDropDb: number | null;
    ratioDropDb: number | null;
    persistence: number | null;
    /** Garden's own speckle level (robust σ of its relative VH series, dB). */
    noiseDb: number | null;
    /** Drop in units of its standard error. */
    z: number | null;
}

export interface RadarResult {
    class: RadarClass;
    /** 0–1: strength of the radar evidence (0 when there is none). */
    score: number;
    vhDropDb: number | null;
    ratioDropDb: number | null;
    persistence: number | null;
    z: number | null;
    passes: PassResult[];
}

export interface RelativeSeries {
    pass: PassSeries['pass'];
    dates: string[];
    /** VH and VH/VV relative to the date's neighbourhood median (dB). */
    vhRel: Array<number | null>;
    ratioRel: Array<number | null>;
}

const dayMs = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / dayMs);
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const median = (xs: number[]) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const r2 = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);
/** Robust σ (1.4826 · MAD) of a series: speckle level unaffected by the pruning step itself. */
const robustSigma = (xs: number[]): number | null => {
    const m = median(xs);
    if (m === null || xs.length < 4) return null;
    const mad = median(xs.map((x) => Math.abs(x - m)));
    return mad === null ? null : Math.max(0.3, 1.4826 * mad);
};

/** Neighbourhood-relative VH and VH/VV series for every garden of a pass. */
export function relativeSeries(series: PassSeries): Record<string, RelativeSeries> {
    const ids = Object.keys(series.gardens);
    const n = series.dates.length;
    const vhMed: Array<number | null> = [];
    const ratioMed: Array<number | null> = [];
    for (let i = 0; i < n; i++) {
        const vh: number[] = [];
        const ratio: number[] = [];
        for (const id of ids) {
            const g = series.gardens[id]!;
            const a = g.vh[i];
            const b = g.vv[i];
            if (a !== null && a !== undefined) vh.push(a);
            if (a !== null && a !== undefined && b !== null && b !== undefined) ratio.push(a - b);
        }
        vhMed.push(median(vh));
        ratioMed.push(median(ratio));
    }
    const out: Record<string, RelativeSeries> = {};
    for (const id of ids) {
        const g = series.gardens[id]!;
        out[id] = {
            pass: series.pass,
            dates: series.dates,
            vhRel: g.vh.map((v, i) => (v === null || vhMed[i] === null ? null : r2(v - (vhMed[i] as number)))),
            ratioRel: g.vh.map((v, i) => {
                const b = g.vv[i];
                return v === null || b === null || b === undefined || ratioMed[i] === null ? null : r2(v - b - (ratioMed[i] as number));
            }),
        };
    }
    return out;
}

/** Before/after comparison of one pass around an optical change window. */
function judgePass(s: RelativeSeries, lastNoChangeAt: string | null, firstChangeAt: string): PassResult {
    const before: number[] = [];
    const beforeRatio: number[] = [];
    const after: number[] = [];
    const afterRatio: number[] = [];
    const windowStart = lastNoChangeAt ?? firstChangeAt;
    s.dates.forEach((d, i) => {
        const vh = s.vhRel[i];
        const ratio = s.ratioRel[i];
        if (vh === null || vh === undefined) return;
        const toStart = daysBetween(d, windowStart);
        const fromChange = daysBetween(firstChangeAt, d);
        if (toStart > 0 && toStart <= RADAR_RULES.beforeDays) {
            before.push(vh);
            if (ratio !== null && ratio !== undefined) beforeRatio.push(ratio);
        } else if (fromChange >= 0 && fromChange <= RADAR_RULES.afterDays) {
            after.push(vh);
            if (ratio !== null && ratio !== undefined) afterRatio.push(ratio);
        }
    });
    const mb = mean(before);
    const ma = mean(after);
    const mbr = mean(beforeRatio);
    const mar = mean(afterRatio);
    const persistence = mb === null || after.length === 0 ? null : after.filter((v) => v < mb - RADAR_RULES.vhDropDb / 2).length / after.length;
    const noise = robustSigma(s.vhRel.filter((v): v is number => v !== null));
    const drop = mb === null || ma === null ? null : mb - ma;
    const z = drop === null || noise === null || before.length === 0 || after.length === 0 ? null : drop / (noise * Math.sqrt(1 / before.length + 1 / after.length));
    return {
        pass: s.pass,
        beforeObs: before.length,
        afterObs: after.length,
        vhDropDb: r2(drop),
        ratioDropDb: mbr === null || mar === null ? null : r2(mbr - mar),
        persistence: persistence === null ? null : Math.round(persistence * 100) / 100,
        noiseDb: r2(noise),
        z: r2(z),
    };
}

/** Combines the passes (weighted by observation count) and classifies the radar evidence. */
export function scoreEvent(passes: RelativeSeries[], lastNoChangeAt: string | null, firstChangeAt: string | null): RadarResult {
    const empty = (passes: PassResult[]): RadarResult => ({ class: 'no_data', score: 0, vhDropDb: null, ratioDropDb: null, persistence: null, z: null, passes });
    if (!firstChangeAt) return empty([]);
    const results = passes.map((s) => judgePass(s, lastNoChangeAt, firstChangeAt));
    return combine(results, RADAR_RULES.minObs, RADAR_RULES.zConfirm, RADAR_RULES.persistence) ?? empty(results);
}

/** Pools the passes (independent looks at the same ground) and classifies the evidence. */
function combine(results: PassResult[], minObs: number, zConfirm: number, persistenceMin: number): RadarResult | null {
    const usable = results.filter((r) => r.beforeObs >= minObs && r.afterObs >= minObs && r.vhDropDb !== null && r.z !== null);
    if (usable.length === 0) return null;
    const w = usable.map((r) => Math.min(r.beforeObs, r.afterObs));
    const wavg = (pick: (r: PassResult) => number | null) => {
        const pairs = usable.map((r, i) => [pick(r), w[i]!] as const).filter((p): p is readonly [number, number] => p[0] !== null);
        return pairs.length ? pairs.reduce((s, [v, ww]) => s + v * ww, 0) / pairs.reduce((s, [, ww]) => s + ww, 0) : null;
    };
    const vhDrop = wavg((r) => r.vhDropDb) as number;
    const ratioDrop = wavg((r) => r.ratioDropDb);
    const persistence = wavg((r) => r.persistence) ?? 0;
    // Stouffer: independent z-scores add in quadrature.
    const z = usable.reduce((s, r) => s + (r.z as number), 0) / Math.sqrt(usable.length);
    let cls: RadarClass;
    if (z >= zConfirm && vhDrop >= RADAR_RULES.vhDropDb && persistence >= persistenceMin) cls = 'confirmed';
    else if (z >= RADAR_RULES.zWeak && vhDrop > 0) cls = 'weak';
    else if (z <= RADAR_RULES.zContradict) cls = 'contradicted';
    else cls = 'neutral';
    const score = cls === 'confirmed' ? Math.min(1, z / (zConfirm * 2)) + 0.5 : cls === 'weak' ? Math.min(0.5, z / (2 * zConfirm)) : 0;
    return { class: cls, score: Math.round(Math.min(1, score) * 100) / 100, vhDropDb: r2(vhDrop), ratioDropDb: r2(ratioDrop), persistence: r2(persistence), z: r2(z), passes: results };
}

export interface RadarOnlyCandidate {
    gardenId: string;
    date: string;
    vhDropDb: number;
    persistence: number;
    z: number;
}

/**
 * Gardens with no optical event where the relative VH shows a sustained drop: a candidate the
 * optical side may have missed under cloud. Every date is tried as the change date and ALL
 * passes are pooled at that date, so the bar is the pooled z over ~45 trials (hence radarOnlyZ).
 */
export function radarOnlyCandidate(passes: RelativeSeries[]): RadarOnlyCandidate | null {
    const dates = [...new Set(passes.flatMap((s) => s.dates))].sort();
    let best: RadarOnlyCandidate | null = null;
    for (const d of dates) {
        const pooled = combine(passes.map((s) => judgePass(s, null, d)), RADAR_RULES.radarOnlyMinObs, RADAR_RULES.radarOnlyZ, RADAR_RULES.radarOnlyPersistence);
        if (!pooled || pooled.class !== 'confirmed' || pooled.z === null || pooled.vhDropDb === null || pooled.persistence === null) continue;
        if (!best || pooled.z > best.z) best = { gardenId: '', date: d, vhDropDb: pooled.vhDropDb, persistence: pooled.persistence, z: pooled.z };
    }
    return best;
}
