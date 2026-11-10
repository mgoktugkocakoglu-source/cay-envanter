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
    /** Backscatter drop in units of its standard error. */
    zVh: number | null;
    /** Interferometric coherence (6/12-day pairs) relative to the neighbourhood: canopy removal RAISES it. */
    cohBeforeObs: number;
    cohAfterObs: number;
    cohRise: number | null;
    zCoh: number | null;
    /** Pooled evidence of the pass (backscatter and coherence are independent looks). */
    z: number | null;
}

export interface RadarResult {
    class: RadarClass;
    /** 0–1: strength of the radar evidence (0 when there is none). */
    score: number;
    vhDropDb: number | null;
    ratioDropDb: number | null;
    cohRise: number | null;
    persistence: number | null;
    z: number | null;
    /** Coherence channel on its own (pooled over passes). */
    zCoh?: number | null;
    cohClass?: RadarClass;
    passes: PassResult[];
    /** Why the class is no_data: the optical record never got a change date, or too few passes bracket it. */
    reason?: 'no_change_date' | 'few_observations';
    /** Which change window the passes were compared around: the scan record's own or the fusion verdict's. */
    windowSource?: 'scan' | 'fusion';
}

export interface RelativeSeries {
    pass: PassSeries['pass'];
    dates: string[];
    /** VH and VH/VV relative to the date's neighbourhood median (dB). */
    vhRel: Array<number | null>;
    ratioRel: Array<number | null>;
    /** Optional coherence series (SNAP burst pairs): dated by the pair's second scene, neighbourhood-relative. */
    cohDates?: string[];
    cohRel?: Array<number | null>;
}

/** Coherence rise (unitless, 0–1 scale) worth calling canopy removal, whatever the z-score. */
const COH_RISE_MIN = 0.06;

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
    const zVh = drop === null || noise === null || before.length === 0 || after.length === 0 ? null : drop / (noise * Math.sqrt(1 / before.length + 1 / after.length));

    // Coherence: same windows on the pair series; a rise after the change is the mowing signature.
    const cohBefore: number[] = [];
    const cohAfter: number[] = [];
    (s.cohDates ?? []).forEach((d, i) => {
        const c = s.cohRel?.[i];
        if (c === null || c === undefined) return;
        const toStart = daysBetween(d, windowStart);
        const fromChange = daysBetween(firstChangeAt, d);
        if (toStart > 0 && toStart <= RADAR_RULES.beforeDays) cohBefore.push(c);
        else if (fromChange >= 0 && fromChange <= RADAR_RULES.afterDays) cohAfter.push(c);
    });
    const cmb = mean(cohBefore);
    const cma = mean(cohAfter);
    const cohNoise = robustSigma((s.cohRel ?? []).filter((v): v is number => v !== null && v !== undefined));
    const cohRise = cmb === null || cma === null ? null : cma - cmb;
    const zCoh = cohRise === null || cohNoise === null || cohBefore.length < RADAR_RULES.minObs || cohAfter.length < RADAR_RULES.minObs ? null : cohRise / (cohNoise * Math.sqrt(1 / cohBefore.length + 1 / cohAfter.length));
    // The pass verdict rests on backscatter; coherence is kept as its own channel (see combine):
    // pooling an uninformative channel would only dilute the informative one.
    const z = zVh;
    return {
        pass: s.pass,
        beforeObs: before.length,
        afterObs: after.length,
        vhDropDb: r2(drop),
        ratioDropDb: mbr === null || mar === null ? null : r2(mbr - mar),
        persistence: persistence === null ? null : Math.round(persistence * 100) / 100,
        noiseDb: r2(noise),
        zVh: r2(zVh),
        cohBeforeObs: cohBefore.length,
        cohAfterObs: cohAfter.length,
        cohRise: cohRise === null ? null : Math.round(cohRise * 1000) / 1000,
        zCoh: r2(zCoh),
        z: r2(z),
    };
}

/** Combines the passes (weighted by observation count) and classifies the radar evidence. */
export function scoreEvent(passes: RelativeSeries[], lastNoChangeAt: string | null, firstChangeAt: string | null): RadarResult {
    const empty = (passes: PassResult[], reason: RadarResult['reason']): RadarResult => ({ class: 'no_data', score: 0, vhDropDb: null, ratioDropDb: null, cohRise: null, persistence: null, z: null, passes, reason });
    if (!firstChangeAt) return empty([], 'no_change_date');
    const results = passes.map((s) => judgePass(s, lastNoChangeAt, firstChangeAt));
    return combine(results, RADAR_RULES.minObs, RADAR_RULES.zConfirm, RADAR_RULES.persistence) ?? empty(results, 'few_observations');
}

/** Pools the passes (independent looks at the same ground) and classifies the evidence. */
function combine(results: PassResult[], minObs: number, zConfirm: number, persistenceMin: number): RadarResult | null {
    const usable = results.filter((r) => r.beforeObs >= minObs && r.afterObs >= minObs && r.vhDropDb !== null && r.z !== null);
    const cohUsable = results.filter((r) => r.zCoh !== null && r.cohRise !== null);
    if (usable.length === 0 && cohUsable.length === 0) return null;
    const wavgOf = (list: PassResult[], weight: (r: PassResult) => number, pick: (r: PassResult) => number | null) => {
        const pairs = list.map((r) => [pick(r), weight(r)] as const).filter((p): p is readonly [number, number] => p[0] !== null);
        return pairs.length ? pairs.reduce((s, [v, ww]) => s + v * ww, 0) / pairs.reduce((s, [, ww]) => s + ww, 0) : null;
    };
    const wBack = (r: PassResult) => Math.min(r.beforeObs, r.afterObs);
    const wCoh = (r: PassResult) => Math.min(r.cohBeforeObs, r.cohAfterObs);
    const vhDrop = wavgOf(usable, wBack, (r) => r.vhDropDb);
    const ratioDrop = wavgOf(usable, wBack, (r) => r.ratioDropDb);
    const persistence = wavgOf(usable, wBack, (r) => r.persistence) ?? 0;
    const cohRise = wavgOf(cohUsable, wCoh, (r) => r.cohRise);
    // Stouffer per channel: independent passes add in quadrature. Channels are NOT pooled with
    // each other — an uninformative channel must not dilute an informative one.
    const zBack = usable.length ? usable.reduce((s, r) => s + (r.z as number), 0) / Math.sqrt(usable.length) : null;
    const zCoh = cohUsable.length ? cohUsable.reduce((s, r) => s + (r.zCoh as number), 0) / Math.sqrt(cohUsable.length) : null;
    const verdict = (z: number | null, magnitudeOk: boolean, positive: boolean, persistenceOk: boolean): RadarClass => {
        if (z === null) return 'no_data';
        if (z >= zConfirm && magnitudeOk && persistenceOk) return 'confirmed';
        if (z >= RADAR_RULES.zWeak && positive) return 'weak';
        if (z <= RADAR_RULES.zContradict) return 'contradicted';
        return 'neutral';
    };
    const backClass = verdict(zBack, (vhDrop ?? 0) >= RADAR_RULES.vhDropDb, (vhDrop ?? 0) > 0, persistence >= persistenceMin);
    const cohClass = verdict(zCoh, (cohRise ?? 0) >= COH_RISE_MIN, (cohRise ?? 0) > 0, true);
    // Either channel may confirm on its own; a contradiction stands only when nothing confirms.
    const rank: Record<RadarClass, number> = { confirmed: 4, weak: 3, neutral: 2, no_data: 1, contradicted: 0 };
    let cls: RadarClass;
    if (backClass === 'confirmed' || cohClass === 'confirmed') cls = 'confirmed';
    else if (backClass === 'contradicted' || cohClass === 'contradicted') cls = 'contradicted';
    else cls = rank[backClass] >= rank[cohClass] ? backClass : cohClass;
    const z = cls === cohClass && cls !== backClass ? zCoh : (zBack ?? zCoh);
    const score = cls === 'confirmed' ? Math.min(1, (z ?? 0) / (zConfirm * 2)) + 0.5 : cls === 'weak' ? Math.min(0.5, (z ?? 0) / (2 * zConfirm)) : 0;
    return {
        class: cls,
        score: Math.round(Math.min(1, score) * 100) / 100,
        vhDropDb: r2(vhDrop),
        ratioDropDb: r2(ratioDrop),
        cohRise: cohRise === null ? null : Math.round(cohRise * 1000) / 1000,
        persistence: r2(persistence),
        z: r2(z),
        zCoh: r2(zCoh),
        cohClass,
        passes: results,
    };
}

/** Neighbourhood-relative coherence per garden for one pass (pair series from py/coherence/run.py). */
export function relativeCoherence(pairs: Array<[string, string]>, byGarden: Record<string, Array<number | null>>): Record<string, { cohDates: string[]; cohRel: Array<number | null> }> {
    const ids = Object.keys(byGarden);
    const n = pairs.length;
    const med: Array<number | null> = [];
    for (let i = 0; i < n; i++) {
        med.push(median(ids.map((id) => byGarden[id]?.[i]).filter((v): v is number => v !== null && v !== undefined)));
    }
    const out: Record<string, { cohDates: string[]; cohRel: Array<number | null> }> = {};
    for (const id of ids) {
        out[id] = {
            cohDates: pairs.map(([, d2]) => d2),
            cohRel: (byGarden[id] ?? []).map((v, i) => (v === null || v === undefined || med[i] === null ? null : Math.round((v - (med[i] as number)) * 1000) / 1000)),
        };
    }
    return out;
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
        if (!pooled || pooled.class !== 'confirmed' || pooled.z === null) continue;
        if (!best || pooled.z > best.z) best = { gardenId: '', date: d, vhDropDb: pooled.vhDropDb ?? 0, persistence: pooled.persistence ?? 0, z: pooled.z };
    }
    return best;
}
