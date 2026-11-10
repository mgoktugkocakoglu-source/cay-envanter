/**
 * Multi-sensor step-change model for deep pruning ("the equation"), v2.1.
 *
 * ÇAYKUR's rejuvenation pruning cuts the bush back to 20 cm: the leafy canopy is gone for months.
 * On every sensor that is a STEP that PERSISTS, in a known direction:
 *   NDVI ↓, NBR ↓, NDRE ↓, NDII ↓ (optical), VH and VH/VV backscatter ↓ (volume scattering gone),
 *   coherence ↑ (bare stems and soil stay coherent). Cloud shadow, frost or thin snow move the
 *   same indices but recover within days; a real pruning does not. Snow also separates by sign:
 *   it lowers NDVI but RAISES NBR (snow is dark in SWIR), pruning lowers both.
 *
 * For a unit and a candidate change date t0 every channel is reduced to a signed z-score of the
 * step (mean after − mean before, in units of the unit's own noise), a persistence check (do the
 * late observations stay down?) and a magnitude gate (is the step physically large enough to be
 * canopy removal?). Channels of one sensor are averaged (they are correlated); independent sensors
 * are pooled with Stouffer's method. The best t0 gives the verdict.
 *
 * v2 decision (after MODCiX 2026 and Lobert 2021: optical carries the event, SAR backscatter on a
 * 0.1 ha garden rarely does): a dense, cross-index-consistent, persisting optical step can be
 * "pruned" on its own when the optical record has no gap longer than FUSION_RULES.maxOpticalGapDays
 * around the change; across a longer gap radar (backscatter or coherence) must agree. Radar never
 * vetoes unless it contradicts (significant rise). Units with a habitual winter dip in earlier
 * seasons (shade, snow pocket) get stricter persistence and z requirements.
 *
 * v2.1 adds four physical guards learnt from the Çataldere 2025-26 run:
 *   - date screening: an optical date whose neighbourhood-median NDVI collapses (snow, frost, low
 *     winter sun) or that covers few gardens is dropped for everyone (`dateQuality`);
 *   - absolute level: the unit's RAW NDVI must fall too — a neighbourhood-relative step alone can
 *     be the neighbours greening up while this garden stands still (`levels`);
 *   - step vs ramp: a slow, season-long decline (abandonment, uprooting, disease, building) fits a
 *     line as well as a step and is not a cut (`shape.gradual`);
 *   - summer recovery: a bush cut to 20 cm is still far below its neighbours in May–July; a winter
 *     step whose canopy is back by early summer was a light trim, not the paid deep pruning
 *     (`recovery`). The season verdict is taken with the summer in view; the real-time scan
 *     timeline still shows when the step could first be called.
 *
 * Every number here is a pre-calibration estimate: the posterior is a placeholder logistic on
 * the pooled z until field labels exist. The CLI adds a population calibration on top (the
 * unit's optical z against the robust bulk of its neighbourhood, `populationZ`).
 */

export type ChannelKey = 'ndvi' | 'nbr' | 'ndre' | 'ndii' | 'vh_asc' | 'vh_desc' | 'ratio_asc' | 'ratio_desc' | 'coh_asc' | 'coh_desc';
export type SensorGroup = 'optical' | 'backscatter' | 'coherence';

export interface ChannelSeries {
    key: ChannelKey;
    /** +1 when pruning raises the value (coherence), −1 when it lowers it (indices, VH, VH/VV). */
    sign: 1 | -1;
    dates: string[];
    /** Neighbourhood-relative values (date median over all gardens subtracted). */
    values: Array<number | null>;
    /** Smallest step (in the channel's unit) that can mean canopy removal. */
    minEffect: number;
    /** Noise floor (the unit's own robust σ is never taken below this). */
    noiseFloor: number;
    /** Absolute values on the same dates (NDVI only): enables the level and summer-recovery checks. */
    raw?: Array<number | null>;
}

export const FUSION_RULES = {
    /** Observations this many days before / after the candidate change date are compared. */
    beforeDays: 75,
    afterDays: 75,
    /** An observation this long after t0 counts as "late": the change must still be there. */
    lateAfterDays: 25,
    /** The "early" step is measured on observations within this many days of t0. */
    earlyDays: 15,
    minBefore: 2,
    minAfter: 2,
    /** A "pruned" verdict needs this much evidence on each side of t0 and this many late observations. */
    minBeforePruned: 3,
    minAfterPruned: 3,
    minLatePruned: 2,
    /** Pooled z for the verdict classes. */
    /** The best of ~50 candidate dates inflates noise to |z| ≈ 2.3; "likely" sits above that. */
    zPruned: 3.5,
    zLikely: 2.8,
    zUnclear: 1.5,
    /** Radar-only "likely" (optical blind under cloud): pooled backscatter z over all dates must clear this. */
    zRadarOnly: 4.0,
    /** Late step must keep at least this share of the early step, else it was transient. */
    persistenceMin: 0.5,
    /**
     * Optical alone may confirm when the clear-observation gap bracketing t0 is at most this long;
     * across a longer gap a radar sensor must agree (the cut could hide a transient inside the gap).
     */
    maxOpticalGapDays: 20,
    /** Units whose earlier winters showed a recovering dip ≥ this (shade / snow pocket) are shade-prone. */
    shadeProneDip: 0.12,
    shadeProne: { persistenceMin: 0.7, zExtra: 0.5 },
    /** Sensor-group weights in the pooled z. */
    weights: { optical: 1.0, backscatter: 0.9, coherence: 0.5 } as Record<SensorGroup, number>,
    primary: ['optical', 'backscatter'] as SensorGroup[],
    /** Candidate change dates are searched in this continuous month-day window (early October to the spring flush). */
    candidateWindow: ['10-01', '04-20'] as [string, string],
    /** ÇAYKUR pruning calendar (autumn/winter, then the spring catch-up): a step outside it is reported as `inCalendar: false`. */
    windows: [
        ['10-15', '01-31'],
        ['02-15', '04-10'],
    ] as Array<[string, string]>,
    /** Posterior placeholder: logistic on the pooled z, centred on zLikely+0.5. */
    posteriorCentre: 3.0,
    posteriorSlope: 1.3,
    /** Observability: a unit with fewer clear optical observations than this in the season is "under-observed". */
    minSeasonOpticalObs: 16,
    /**
     * Date screening. A date whose garden-median raw NDVI is below `snowDateMedianNdvi` is a
     * neighbourhood-wide collapse (snow, frost, terrain shadow of the low winter sun) — only a
     * seventh of the tea is ever pruned, so the median cannot fall that far from pruning. A date
     * observed on fewer than `minDateCoverage` of the gardens its sensor can see has no reliable median.
     */
    snowDateMedianNdvi: 0.65,
    minDateCoverage: 0.25,
    /** Raw NDVI must fall by at least this between the before and after windows for a "pruned" verdict. */
    minAbsoluteDrop: 0.08,
    /** An optical-driven "likely" needs an NDVI step of at least this (the pruned gate is CHANNEL_DEFAULTS.ndvi.minEffect). */
    minEffectLikely: 0.08,
    /** Step vs ramp: a line fitting within this factor of the step model's residuals, with a season-long decline ≥ minEffect, is gradual loss. */
    gradualRssRatio: 1.15,
    /** Summer recovery test: neighbourhood-relative NDVI in early summer against the previous autumn (month-day windows). */
    recovery: { autumn: ['09-01', '10-14'] as [string, string], summer: ['05-20', '07-15'] as [string, string], minObs: 3, minDelta: 0.06, zMin: 2.0 },
    /** Population calibration (applied by the CLI): a "pruned" / "likely" optical z must stand this many robust σ above the neighbourhood bulk; a weak signal below the "likely" bar inside the bulk is "not pruned". */
    populationZPruned: 1.5,
    populationZLikely: 0.5,
} as const;

export const CHANNEL_DEFAULTS: Record<ChannelKey, Pick<ChannelSeries, 'sign' | 'minEffect' | 'noiseFloor'>> = {
    ndvi: { sign: -1, minEffect: 0.12, noiseFloor: 0.025 },
    nbr: { sign: -1, minEffect: 0.12, noiseFloor: 0.025 },
    ndre: { sign: -1, minEffect: 0.08, noiseFloor: 0.02 },
    ndii: { sign: -1, minEffect: 0.1, noiseFloor: 0.025 },
    vh_asc: { sign: -1, minEffect: 1.0, noiseFloor: 0.4 },
    vh_desc: { sign: -1, minEffect: 1.0, noiseFloor: 0.4 },
    ratio_asc: { sign: -1, minEffect: 0.8, noiseFloor: 0.35 },
    ratio_desc: { sign: -1, minEffect: 0.8, noiseFloor: 0.35 },
    coh_asc: { sign: 1, minEffect: 0.06, noiseFloor: 0.05 },
    coh_desc: { sign: 1, minEffect: 0.06, noiseFloor: 0.05 },
};

export const GROUP_OF: Record<ChannelKey, SensorGroup> = {
    ndvi: 'optical',
    nbr: 'optical',
    ndre: 'optical',
    ndii: 'optical',
    vh_asc: 'backscatter',
    vh_desc: 'backscatter',
    ratio_asc: 'backscatter',
    ratio_desc: 'backscatter',
    coh_asc: 'coherence',
    coh_desc: 'coherence',
};

export type FusionClass = 'pruned' | 'likely' | 'unclear' | 'not_pruned' | 'no_data';

/** Machine-readable tag for why the class is what it is (the Turkish `reason` says it in words). */
export type FusionKind =
    | 'deep_pruning'
    | 'light_or_transient'
    | 'gradual_loss'
    | 'level'
    | 'contradiction'
    | 'gap'
    | 'small_ndvi'
    | 'likely_optical'
    | 'radar_only'
    | 'second_sensor'
    | 'transient'
    | 'weak'
    | 'population'
    | 'bulk'
    | 'none';

export interface ChannelEvidence {
    key: ChannelKey;
    before: number;
    after: number;
    late: number;
    /** Signed step in the channel's unit (positive = pruning-like). */
    delta: number | null;
    noise: number;
    z: number | null;
    /** Share of the early step still present in the late observations (null until late data exists). */
    persistence: number | null;
    magnitudeOk: boolean;
}

export interface GroupEvidence {
    group: SensorGroup;
    z: number | null;
    channels: ChannelEvidence[];
}

/** Per-unit priors from earlier seasons and the unit's size (optional). */
export interface UnitContext {
    /** The unit showed a recovering winter dip in an earlier season (shade / snow pocket): stricter rules. */
    shadeProne?: boolean;
    /** Robust noise of the unit's own earlier winters per channel; raises the floor when larger. */
    priorNoise?: Partial<Record<ChannelKey, number>>;
}

export interface Observability {
    /** Clear optical observations in the whole series (all sensors) and inside the candidate window. */
    opticalObs: number;
    opticalObsInWindows: number;
    /** Optical observations before / after / late relative to the chosen t0 (NDVI channel). */
    before: number;
    after: number;
    late: number;
    /** Days between the last clear optical observation before t0 and the first at/after it. */
    opticalGapDays: number | null;
    radarObs: number;
    coherenceObs: number;
    underObserved: boolean;
}

/** Raw (absolute) NDVI around the change date: a cut must lower the garden itself, not just its rank among neighbours. */
export interface Levels {
    ndviBefore: number | null;
    ndviAfter: number | null;
    /** before − after (positive = canopy lost). */
    drop: number | null;
    ndviMinAfter: number | null;
    ok: boolean | null;
}

/** Step against ramp on the relative NDVI of the season. */
export interface Shape {
    stepRss: number | null;
    trendRss: number | null;
    /** trendRss / stepRss: ≤ 1 means a line explains the season as well as a step. */
    ratio: number | null;
    /** Season-long change implied by the line (pruning-positive). */
    trendChange: number | null;
    /** Pruning-positive slope of the before period per 30 days (null with fewer than 5 observations). */
    preSlopePerMonth: number | null;
    gradual: boolean;
}

/** Early-summer canopy against the previous autumn, neighbourhood-relative (pruning-positive delta). */
export interface Recovery {
    autumnRel: number | null;
    summerRel: number | null;
    autumnRaw: number | null;
    summerRaw: number | null;
    delta: number | null;
    z: number | null;
    obs: [number, number];
    /** null = not testable yet (summer not observed). */
    ok: boolean | null;
}

export interface FusionVerdict {
    class: FusionClass;
    kind: FusionKind | null;
    /** Pooled z over sensor groups at the best change date. */
    z: number | null;
    /** Placeholder posterior (uncalibrated). */
    p: number;
    /** Best candidate change date and the observation interval bracketing it. */
    changeDate: string | null;
    lastBeforeAt: string | null;
    firstAfterAt: string | null;
    /** Primary sensors (optical, backscatter) that see a real, persisting step at the best date. */
    agreeing: number;
    /** Per primary sensor: does it see the step (z, magnitude, persistence, no orbit contradicting)? */
    opticalOk: boolean;
    backscatterOk: boolean;
    coherenceOk: boolean;
    /** NDVI and a SWIR-based index (NBR / NDII) both show the step: rules out snow and shadow. */
    crossIndexOk: boolean;
    /** The optical gap around t0 exceeded maxOpticalGapDays, so radar agreement was required. */
    radarRequired: boolean;
    /** Flag for the expert queue: "likely", or "unclear" with a strong but unconfirmed signal. */
    review: boolean;
    shadeProne: boolean;
    /** The change date falls inside ÇAYKUR's pruning calendar (null without a change date). */
    inCalendar: boolean | null;
    observability: Observability;
    levels: Levels | null;
    shape: Shape | null;
    recovery: Recovery | null;
    /** Optical z against the neighbourhood bulk in robust σ (set by the CLI; null in isolation). */
    populationZ: number | null;
    groups: GroupEvidence[];
    /** Why the class is what it is (Turkish, for the screen). */
    reason: string;
}

const dayMs = 86_400_000;
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / dayMs);
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * dayMs).toISOString().slice(0, 10);
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const median = (xs: number[]) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const sd = (xs: number[]) => {
    if (xs.length < 2) return null;
    const m = mean(xs) as number;
    return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};
const r3 = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 1000);
const r4 = (v: number | null) => (v === null ? null : Math.round(v * 10000) / 10000);

/** Robust noise of a series from first differences: a single step barely moves the median. */
export function robustNoise(values: Array<number | null>, floor: number): number {
    const diffs: number[] = [];
    let prev: number | null = null;
    for (const v of values) {
        if (v === null) continue;
        if (prev !== null) diffs.push(Math.abs(v - prev));
        prev = v;
    }
    const mad = median(diffs);
    return Math.max(floor, mad === null ? floor : (1.4826 * mad) / Math.SQRT2);
}

/** Subtracts, per date, the median over all gardens: weather, season and snow move everyone. */
export function relativeToNeighbourhood(byGarden: Record<string, Array<number | null>>, decimals = 3): Record<string, Array<number | null>> {
    const ids = Object.keys(byGarden);
    const n = Math.max(0, ...ids.map((id) => byGarden[id]!.length));
    const med: Array<number | null> = [];
    for (let i = 0; i < n; i++) med.push(median(ids.map((id) => byGarden[id]![i]).filter((v): v is number => v !== null && v !== undefined)));
    const f = 10 ** decimals;
    const out: Record<string, Array<number | null>> = {};
    for (const id of ids) out[id] = byGarden[id]!.map((v, i) => (v === null || v === undefined || med[i] === null ? null : Math.round((v - (med[i] as number)) * f) / f));
    return out;
}

/** Screening result of one optical date. */
export interface DateQuality {
    date: string;
    sensor: string | null;
    /** Share of the gardens that this date's sensor observes at all which have a clear value on the date. */
    coverage: number;
    medianNdvi: number | null;
    ok: boolean;
    reason: 'snow_or_shadow' | 'sparse' | null;
}

/**
 * Screens optical dates on the gardens' RAW NDVI: a neighbourhood-wide collapse of the median is
 * snow / frost / terrain shadow (no pruning programme cuts most of a mahalle at once), and a date
 * seen on few gardens has no usable median. Coverage is judged against the gardens the date's
 * sensor can see at all (Landsat skips gardens under its pixel size).
 */
export function dateQuality(dates: string[], ndviByGarden: Record<string, Array<number | null>>, sensors?: string[]): DateQuality[] {
    const ids = Object.keys(ndviByGarden);
    const sensorOf = (i: number) => sensors?.[i] ?? 'all';
    const eligible = new Map<string, number>();
    const seen = new Map<string, Set<string>>();
    dates.forEach((_, i) => {
        const s = sensorOf(i);
        if (!seen.has(s)) seen.set(s, new Set());
        for (const id of ids) {
            const v = ndviByGarden[id]![i];
            if (v !== null && v !== undefined) seen.get(s)!.add(id);
        }
    });
    for (const [s, set] of seen) eligible.set(s, set.size);
    return dates.map((date, i) => {
        const valid = ids.map((id) => ndviByGarden[id]![i]).filter((v): v is number => v !== null && v !== undefined);
        const s = sensorOf(i);
        const coverage = valid.length / Math.max(1, eligible.get(s) ?? 0);
        const med = median(valid);
        let reason: DateQuality['reason'] = null;
        if (!valid.length || coverage < FUSION_RULES.minDateCoverage) reason = 'sparse';
        else if (med !== null && med < FUSION_RULES.snowDateMedianNdvi) reason = 'snow_or_shadow';
        return { date, sensor: sensors ? sensors[i] ?? null : null, coverage: r3(coverage) as number, medianNdvi: r3(med), ok: reason === null, reason };
    });
}

/** Nulls the values of every unit on the dates the screening rejected. */
export function applyDateQuality(byUnit: Record<string, Array<number | null>>, quality: DateQuality[]): Record<string, Array<number | null>> {
    const out: Record<string, Array<number | null>> = {};
    for (const [id, values] of Object.entries(byUnit)) out[id] = values.map((v, i) => (quality[i] && !quality[i]!.ok ? null : v));
    return out;
}

/** Ordinary least squares of y on x. */
export function linearFit(xs: number[], ys: number[]): { slope: number; intercept: number; rss: number } {
    const n = xs.length;
    const mx = mean(xs) as number;
    const my = mean(ys) as number;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < n; i++) {
        sxx += (xs[i]! - mx) ** 2;
        sxy += (xs[i]! - mx) * (ys[i]! - my);
    }
    const slope = sxx > 0 ? sxy / sxx : 0;
    const intercept = my - slope * mx;
    let rss = 0;
    for (let i = 0; i < n; i++) rss += (ys[i]! - (intercept + slope * xs[i]!)) ** 2;
    return { slope, intercept, rss };
}

/**
 * Prior-season context of a unit from its neighbourhood-relative NDVI of an earlier winter:
 * robust noise, and whether it showed a recovering dip (shade / snow pocket) deeper than the
 * pruning magnitude gate — such a unit must clear stricter persistence and z bars this season.
 */
export function priorContext(dates: string[], relNdvi: Array<number | null>, relNbr?: Array<number | null>): UnitContext {
    const noise = robustNoise(relNdvi, CHANNEL_DEFAULTS.ndvi.noiseFloor);
    const valid = relNdvi.map((v, i) => [dates[i]!, v] as const).filter((p): p is readonly [string, number] => p[1] !== null);
    let shadeProne = false;
    if (valid.length >= 8) {
        const base = median(valid.map((p) => p[1])) as number;
        // A dip: a run of observations ≥ dip below the base that ends with a return to within noise of the base.
        for (let i = 0; i < valid.length; i++) {
            if (base - valid[i]![1] < FUSION_RULES.shadeProneDip) continue;
            const recovered = valid.slice(i + 1).find((p) => days(valid[i]![0], p[0]) <= 45 && base - p[1] <= 2 * noise);
            if (recovered) {
                shadeProne = true;
                break;
            }
        }
    }
    const ctx: UnitContext = { shadeProne, priorNoise: { ndvi: Math.round(noise * 1000) / 1000 } };
    if (relNbr) ctx.priorNoise!.nbr = Math.round(robustNoise(relNbr, CHANNEL_DEFAULTS.nbr.noiseFloor) * 1000) / 1000;
    return ctx;
}

/** One channel's step evidence at t0, using only observations on or before `asOf` (scan emulation). */
export function channelStep(s: ChannelSeries, t0: string, asOf: string, noise: number): ChannelEvidence | null {
    const before: number[] = [];
    const after: number[] = [];
    const early: number[] = [];
    const late: number[] = [];
    for (let i = 0; i < s.dates.length; i++) {
        const d = s.dates[i]!;
        const v = s.values[i];
        if (v === null || v === undefined || d > asOf) continue;
        const dt = days(t0, d);
        if (dt < 0 && -dt <= FUSION_RULES.beforeDays) before.push(v);
        else if (dt >= 0 && dt <= FUSION_RULES.afterDays) {
            after.push(v);
            if (dt <= FUSION_RULES.earlyDays) early.push(v);
            if (dt >= FUSION_RULES.lateAfterDays) late.push(v);
        }
    }
    if (before.length < FUSION_RULES.minBefore || after.length < FUSION_RULES.minAfter) return null;
    const mb = mean(before) as number;
    const ma = mean(after) as number;
    const delta = s.sign * (ma - mb);
    const z = delta / (noise * Math.sqrt(1 / before.length + 1 / after.length));
    // Persistence: the step must be there right after t0 (else t0 is too early) and still be
    // there ≥ lateAfterDays later, including in the very last observations. A pulse (shadow,
    // frost, snow) scores high early and collapses late; a pruning does not.
    let persistence: number | null = null;
    if (late.length >= 2 && delta > 0) {
        const dEarly = early.length ? s.sign * ((mean(early) as number) - mb) : delta;
        const dLate = s.sign * ((mean(late) as number) - mb);
        const dTail = s.sign * ((mean(after.slice(-2)) as number) - mb);
        persistence = dEarly >= 0.5 * delta ? Math.max(0, Math.min(1, Math.min(dLate, dTail) / dEarly)) : 0;
    }
    return {
        key: s.key,
        before: before.length,
        after: after.length,
        late: late.length,
        delta: r3(delta),
        noise: r3(noise) as number,
        z: r3(persistence === null ? z : z * persistence),
        persistence: r3(persistence),
        magnitudeOk: delta >= s.minEffect,
    };
}

/** Raw NDVI means around t0 (same windows as the step), for the absolute-level guard. */
export function rawLevels(s: ChannelSeries, t0: string, asOf: string): Levels | null {
    if (!s.raw) return null;
    const before: number[] = [];
    const after: number[] = [];
    for (let i = 0; i < s.dates.length; i++) {
        const d = s.dates[i]!;
        const v = s.raw[i];
        if (v === null || v === undefined || s.values[i] === null || d > asOf) continue;
        const dt = days(t0, d);
        if (dt < 0 && -dt <= FUSION_RULES.beforeDays) before.push(v);
        else if (dt >= 0 && dt <= FUSION_RULES.afterDays) after.push(v);
    }
    if (before.length < FUSION_RULES.minBefore || after.length < FUSION_RULES.minAfter) return { ndviBefore: r3(mean(before)), ndviAfter: r3(mean(after)), drop: null, ndviMinAfter: after.length ? r3(Math.min(...after)) : null, ok: null };
    const drop = (mean(before) as number) - (mean(after) as number);
    return { ndviBefore: r3(mean(before)), ndviAfter: r3(mean(after)), drop: r3(drop), ndviMinAfter: r3(Math.min(...after)), ok: drop >= FUSION_RULES.minAbsoluteDrop };
}

/**
 * Step against ramp on the season's relative series (from 45 days before the first candidate
 * date to `asOf`): a line that explains the season as well as the step, with a season-long
 * decline of pruning size, or a before period that was already sliding, is gradual loss.
 */
export function stepShape(s: ChannelSeries, t0: string, asOf: string, from: string): Shape | null {
    const pts: Array<{ x: number; v: number; d: string }> = [];
    for (let i = 0; i < s.dates.length; i++) {
        const d = s.dates[i]!;
        const v = s.values[i];
        if (v === null || v === undefined || d > asOf || d < from) continue;
        pts.push({ x: days(from, d), v, d });
    }
    if (pts.length < 8) return null;
    const before = pts.filter((p) => p.d < t0);
    const after = pts.filter((p) => p.d >= t0);
    if (before.length < 2 || after.length < 2) return null;
    const mb = mean(before.map((p) => p.v)) as number;
    const ma = mean(after.map((p) => p.v)) as number;
    const stepRss = pts.reduce((acc, p) => acc + (p.v - (p.d < t0 ? mb : ma)) ** 2, 0);
    const fit = linearFit(pts.map((p) => p.x), pts.map((p) => p.v));
    const span = pts[pts.length - 1]!.x - pts[0]!.x;
    const trendChange = s.sign * fit.slope * span;
    const ratio = stepRss > 0 ? fit.rss / stepRss : null;
    let preSlopePerMonth: number | null = null;
    let preChange = 0;
    if (before.length >= 5) {
        const f = linearFit(before.map((p) => p.x), before.map((p) => p.v));
        preSlopePerMonth = s.sign * f.slope * 30;
        preChange = s.sign * f.slope * (before[before.length - 1]!.x - before[0]!.x);
    }
    const gradual = (ratio !== null && ratio <= FUSION_RULES.gradualRssRatio && trendChange >= s.minEffect) || preChange >= s.minEffect;
    return { stepRss: r4(stepRss), trendRss: r4(fit.rss), ratio: r3(ratio), trendChange: r3(trendChange), preSlopePerMonth: r3(preSlopePerMonth), gradual };
}

/**
 * Early summer against the previous autumn, neighbourhood-relative: a bush cut to 20 cm in
 * winter is still well below its neighbours in May–July; one that is back is not a deep pruning.
 * The season year is read from the series' first observation (a series starts in September).
 */
export function recoveryTest(s: ChannelSeries, asOf: string): Recovery | null {
    const firstIdx = s.values.findIndex((v) => v !== null && v !== undefined);
    if (firstIdx < 0) return null;
    const first = s.dates[firstIdx]!;
    const y = Number(first.slice(0, 4)) - (Number(first.slice(5, 7)) < 7 ? 1 : 0);
    const R = FUSION_RULES.recovery;
    const [a0, a1] = [`${y}-${R.autumn[0]}`, `${y}-${R.autumn[1]}`];
    const [s0, s1] = [`${y + 1}-${R.summer[0]}`, `${y + 1}-${R.summer[1]}`];
    const autumn: number[] = [];
    const summer: number[] = [];
    const autumnRaw: number[] = [];
    const summerRaw: number[] = [];
    for (let i = 0; i < s.dates.length; i++) {
        const d = s.dates[i]!;
        const v = s.values[i];
        if (v === null || v === undefined || d > asOf) continue;
        const raw = s.raw?.[i];
        if (d >= a0 && d <= a1) {
            autumn.push(v);
            if (raw !== null && raw !== undefined) autumnRaw.push(raw);
        } else if (d >= s0 && d <= s1) {
            summer.push(v);
            if (raw !== null && raw !== undefined) summerRaw.push(raw);
        }
    }
    const obs: [number, number] = [autumn.length, summer.length];
    if (autumn.length < R.minObs || summer.length < R.minObs) return { autumnRel: r3(mean(autumn)), summerRel: r3(mean(summer)), autumnRaw: r3(mean(autumnRaw)), summerRaw: r3(mean(summerRaw)), delta: null, z: null, obs, ok: null };
    const delta = s.sign * ((mean(summer) as number) - (mean(autumn) as number));
    const sa = Math.max(sd(autumn) ?? s.noiseFloor, s.noiseFloor);
    const ss = Math.max(sd(summer) ?? s.noiseFloor, s.noiseFloor);
    const z = delta / Math.sqrt((sa * sa) / autumn.length + (ss * ss) / summer.length);
    return { autumnRel: r3(mean(autumn)), summerRel: r3(mean(summer)), autumnRaw: r3(mean(autumnRaw)), summerRaw: r3(mean(summerRaw)), delta: r3(delta), z: r3(z), obs, ok: delta >= R.minDelta && z >= R.zMin };
}

function pooledZ(groups: GroupEvidence[]): number | null {
    const usable = groups.filter((g) => g.z !== null);
    if (!usable.length) return null;
    const num = usable.reduce((s, g) => s + FUSION_RULES.weights[g.group] * (g.z as number), 0);
    const den = Math.sqrt(usable.reduce((s, g) => s + FUSION_RULES.weights[g.group] ** 2, 0));
    return num / den;
}

/** Evidence of all channels at one candidate date; correlated channels of a sensor are averaged, sensors pooled. */
export function evidenceAt(series: ChannelSeries[], noises: Map<ChannelKey, number>, t0: string, asOf: string): { z: number | null; groups: GroupEvidence[] } {
    const byGroup = new Map<SensorGroup, ChannelEvidence[]>();
    for (const s of series) {
        const e = channelStep(s, t0, asOf, noises.get(s.key) ?? s.noiseFloor);
        if (!e) continue;
        byGroup.set(GROUP_OF[s.key], [...(byGroup.get(GROUP_OF[s.key]) ?? []), e]);
    }
    const groups: GroupEvidence[] = [];
    for (const [group, channels] of byGroup) {
        const zs = channels.map((c) => c.z).filter((v): v is number => v !== null);
        // Optical indices and the VH / VH/VV pair of one orbit come from the same pixels: average.
        // Orbits are independent looks: Stouffer over the per-orbit means.
        let z: number | null;
        if (!zs.length) z = null;
        else if (group === 'optical') z = mean(zs);
        else {
            const perOrbit = new Map<string, number[]>();
            for (const c of channels) {
                if (c.z === null) continue;
                const orbit = c.key.endsWith('_asc') ? 'asc' : 'desc';
                perOrbit.set(orbit, [...(perOrbit.get(orbit) ?? []), c.z]);
            }
            const orbitZ = [...perOrbit.values()].map((v) => mean(v) as number);
            z = orbitZ.reduce((a, b) => a + b, 0) / Math.sqrt(orbitZ.length);
        }
        groups.push({ group, z: r3(z), channels });
    }
    return { z: r3(pooledZ(groups)), groups };
}

const inMonthDayWindow = (date: string, [a, b]: [string, string]): boolean => {
    const md = date.slice(5);
    return a <= b ? md >= a && md <= b : md >= a || md <= b;
};

/** Candidate change dates: the continuous search window. */
function inCandidateWindow(date: string): boolean {
    return inMonthDayWindow(date, FUSION_RULES.candidateWindow);
}

/** ÇAYKUR's pruning calendar. */
export function inPruningCalendar(date: string): boolean {
    return FUSION_RULES.windows.some((w) => inMonthDayWindow(date, w));
}

export function posterior(z: number | null): number {
    if (z === null) return 0;
    return Math.round((1 / (1 + Math.exp(-FUSION_RULES.posteriorSlope * (z - FUSION_RULES.posteriorCentre)))) * 1000) / 1000;
}

function noDataVerdict(reason: string, observability: Observability, shadeProne: boolean): FusionVerdict {
    return { class: 'no_data', kind: null, z: null, p: 0, changeDate: null, lastBeforeAt: null, firstAfterAt: null, agreeing: 0, opticalOk: false, backscatterOk: false, coherenceOk: false, crossIndexOk: false, radarRequired: false, review: false, shadeProne, inCalendar: null, observability, levels: null, shape: null, recovery: null, populationZ: null, groups: [], reason };
}

/** Verdict from the best candidate change date, with observations up to `asOf`. */
export function judge(series: ChannelSeries[], asOf: string, ctx: UnitContext = {}): FusionVerdict {
    const shadeProne = ctx.shadeProne === true;
    const noises = new Map<ChannelKey, number>(series.map((s) => [s.key, Math.max(robustNoise(s.values, s.noiseFloor), ctx.priorNoise?.[s.key] ?? 0)]));
    const candidates = [...new Set(series.flatMap((s) => s.dates))].filter((d) => d <= asOf && inCandidateWindow(d)).sort();
    let best: { t0: string; z: number; groups: GroupEvidence[] } | null = null;
    for (const t0 of candidates) {
        const e = evidenceAt(series, noises, t0, asOf);
        if (e.z !== null && (!best || e.z > best.z)) best = { t0, z: e.z, groups: e.groups };
    }
    const optical = series.filter((s) => GROUP_OF[s.key] === 'optical');
    const obsOf = (list: ChannelSeries[]) => list.reduce((s, c) => s + c.values.filter((v, i) => v !== null && c.dates[i]! <= asOf).length, 0);
    const ndviSeries = optical.find((s) => s.key === 'ndvi') ?? optical[0];
    const opticalDates = ndviSeries ? ndviSeries.dates.filter((d, i) => ndviSeries.values[i] !== null && d <= asOf) : [];
    const observability: Observability = {
        opticalObs: opticalDates.length,
        opticalObsInWindows: opticalDates.filter(inCandidateWindow).length,
        before: 0,
        after: 0,
        late: 0,
        opticalGapDays: null,
        radarObs: obsOf(series.filter((s) => GROUP_OF[s.key] === 'backscatter')),
        coherenceObs: obsOf(series.filter((s) => GROUP_OF[s.key] === 'coherence')),
        underObserved: opticalDates.length < FUSION_RULES.minSeasonOpticalObs,
    };
    const totalObs = obsOf(series);
    if (!best) return noDataVerdict(totalObs < 6 ? 'Yeterli gözlem yok' : 'Değişim penceresinde iki yanlı gözlem yok', observability, shadeProne);

    const persistenceMin = shadeProne ? FUSION_RULES.shadeProne.persistenceMin : FUSION_RULES.persistenceMin;
    const zPruned = FUSION_RULES.zPruned + (shadeProne ? FUSION_RULES.shadeProne.zExtra : 0);
    const zLikely = FUSION_RULES.zLikely + (shadeProne ? FUSION_RULES.shadeProne.zExtra : 0);

    // A sensor "sees" the pruning when its pooled z clears the bar, at least one of its channels
    // shows a physically large enough step, no channel contradicts (an orbit moving the other
    // way) and — once late observations exist — the step persisted.
    const sensorOk = (group: SensorGroup): { ok: boolean; persistence: boolean | null; contradicted: boolean; z: number | null } => {
        const g = best!.groups.find((x) => x.group === group);
        if (!g || g.z === null) return { ok: false, persistence: null, contradicted: false, z: null };
        const magnitude = g.channels.some((c) => c.magnitudeOk && (c.z ?? 0) >= FUSION_RULES.zUnclear);
        // A contradiction is a significant, physically large move the WRONG way at the group level
        // (one noisy channel of four crossing −1.5 by chance must not veto the others).
        const contradicted = g.z <= -2.0 && g.channels.some((c) => (c.z ?? 0) <= -2.0 && (c.delta ?? 0) <= -CHANNEL_DEFAULTS[c.key].minEffect);
        const withLate = g.channels.filter((c) => c.persistence !== null);
        const persistence = withLate.length === 0 ? null : withLate.some((c) => (c.persistence as number) >= persistenceMin);
        return { ok: g.z >= FUSION_RULES.zUnclear && magnitude && !contradicted && persistence !== false, persistence, contradicted, z: g.z };
    };
    const opt = sensorOk('optical');
    const back = sensorOk('backscatter');
    const coh = sensorOk('coherence');
    const agreeing = [opt, back].filter((s) => s.ok).length;
    const optGroup = best.groups.find((g) => g.group === 'optical');
    const chan = (k: ChannelKey) => optGroup?.channels.find((c) => c.key === k);
    const ndviE = chan('ndvi');
    const swirOk = ['nbr', 'ndii'].some((k) => {
        const c = chan(k as ChannelKey);
        return !!c && c.magnitudeOk && (c.z ?? 0) >= FUSION_RULES.zUnclear;
    });
    const ndviStrong = !!ndviE && ndviE.magnitudeOk && (ndviE.z ?? 0) >= FUSION_RULES.zUnclear;
    const crossIndexOk = ndviStrong && swirOk;
    const ndviMagLikely = (ndviE?.delta ?? 0) >= FUSION_RULES.minEffectLikely;
    observability.before = ndviE?.before ?? 0;
    observability.after = ndviE?.after ?? 0;
    observability.late = ndviE?.late ?? 0;

    // Optical observation interval around t0 and the gap it spans.
    let lastBeforeAt: string | null = null;
    let firstAfterAt: string | null = null;
    for (const d of opticalDates) {
        if (d < best.t0 && (!lastBeforeAt || d > lastBeforeAt)) lastBeforeAt = d;
        if (d >= best.t0 && (!firstAfterAt || d < firstAfterAt)) firstAfterAt = d;
    }
    observability.opticalGapDays = lastBeforeAt && firstAfterAt ? days(lastBeforeAt, firstAfterAt) : null;
    if (!lastBeforeAt || !firstAfterAt) {
        // Fall back to any channel for the bracket (radar-only cases).
        for (const s of series) {
            s.dates.forEach((d, i) => {
                if (s.values[i] === null || s.values[i] === undefined || d > asOf) return;
                if (d < best!.t0 && (!lastBeforeAt || d > lastBeforeAt)) lastBeforeAt = d;
                if (d >= best!.t0 && (!firstAfterAt || d < firstAfterAt)) firstAfterAt = d;
            });
        }
    }
    const gapDays = observability.opticalGapDays;
    const radarRequired = gapDays === null || gapDays > FUSION_RULES.maxOpticalGapDays;
    const radarAgrees = back.ok || coh.ok;
    const radarContradicts = back.contradicted;

    // Physical guards on the NDVI series: absolute level, step-vs-ramp shape, summer recovery.
    const levels = ndviSeries ? rawLevels(ndviSeries, best.t0, asOf) : null;
    const shape = ndviSeries ? stepShape(ndviSeries, best.t0, asOf, addDays(candidates[0]!, -45)) : null;
    const recovery = ndviSeries?.raw ? recoveryTest(ndviSeries, asOf) : null;
    const gradual = shape?.gradual === true;
    const levelOk = levels?.ok !== false;
    const recoveryOk = recovery?.ok !== false;
    const inCalendar = inPruningCalendar(best.t0);

    const primaryChannels = best.groups.filter((g) => FUSION_RULES.primary.includes(g.group)).flatMap((g) => g.channels);
    const magnitudeOk = primaryChannels.some((c) => c.magnitudeOk && (c.z ?? 0) >= FUSION_RULES.zUnclear);
    const persist = primaryChannels.filter((c) => c.persistence !== null);
    const persistenceOk = persist.length === 0 ? null : persist.some((c) => (c.persistence as number) >= persistenceMin);
    const lateObs = primaryChannels.reduce((s, c) => s + c.late, 0);

    // Strong optical: dense on both sides, late observations exist and kept the step, NDVI and a
    // SWIR index agree (no snow), group z over the (shade-adjusted) pruned bar.
    const denseEnough = observability.before >= FUSION_RULES.minBeforePruned && observability.after >= FUSION_RULES.minAfterPruned && observability.late >= FUSION_RULES.minLatePruned;
    // The summer test outranks the snow and gap heuristics: a canopy still missing in June cannot be
    // snow (so the SWIR cross-check may be skipped) and cannot be a transient hidden in a cloud gap.
    const summerConfirms = recovery?.ok === true;
    const summerDenies = recovery?.ok === false;
    const opticalStrong = opt.ok && (opt.z ?? 0) >= zPruned && (crossIndexOk || summerConfirms) && denseEnough && opt.persistence === true;
    const jointStrong = best.z >= zPruned && opt.ok && back.ok && persistenceOk === true;
    const gapOk = !radarRequired || radarAgrees || summerConfirms;
    const prunedCandidate = (opticalStrong && !radarContradicts && gapOk) || jointStrong;
    const opticalLikely = (opt.z ?? 0) >= zLikely && magnitudeOk && persistenceOk !== false && opt.ok;
    const levelText = levels && levels.ndviBefore !== null && levels.ndviAfter !== null ? `NDVI ${levels.ndviBefore.toFixed(2)}→${levels.ndviAfter.toFixed(2)}` : null;
    const fmtZ = (v: number | null | undefined) => (v ?? 0).toFixed(1);

    let cls: FusionClass;
    let kind: FusionKind | null = null;
    let reason: string;
    if (prunedCandidate && gradual) {
        cls = 'unclear';
        kind = 'gradual_loss';
        reason = `Kademeli örtü kaybı: sezon boyu süren düşüş bir budama basamağı değil (eğim/basamak oranı ${shape?.ratio ?? '—'}); terk, sökme, hastalık ya da yapılaşma olabilir — bahçe sağlığı ve bahçe yaşı modüllerine bakın`;
    } else if ((prunedCandidate || opticalLikely) && summerDenies) {
        // Winter step, but by early summer the canopy is level with the neighbours: whatever was cut
        // was not the 20 cm rejuvenation pruning that costs a season's yield.
        cls = 'unclear';
        kind = 'light_or_transient';
        reason = `Kış adımı var (optik z ${fmtZ(opt.z)}) ama yaz başında örtü komşularıyla aynı düzeyde (fark ${(recovery?.delta ?? 0).toFixed(2)}): derin budama değil — hafif budama/üst alma, kar hasarı ya da fenoloji farkı olabilir`;
        if (levelText) reason += `; ${levelText}`;
    } else if (prunedCandidate && !levelOk) {
        cls = 'likely';
        kind = 'level';
        reason = `Komşulara göre güçlü düşüş var ama bahçenin kendi NDVI'si yeterince düşmedi (${levelText ?? 'düşüş ' + (levels?.drop ?? 0).toFixed(2)}): komşuların yeşillenmesi ya da fenoloji farkı olabilir, eksper incelemeli`;
    } else if (prunedCandidate) {
        cls = 'pruned';
        kind = 'deep_pruning';
        reason = jointStrong && !opticalStrong
            ? `Optik ve radar aynı tarihte kalıcı örtü kaybı görüyor (z ${best.z.toFixed(1)})`
            : radarAgrees
                ? `Optik kalıcı örtü kaybı (NDVI ve SWIR birlikte, z ${fmtZ(opt.z)}), radar teyit ediyor`
                : `Optik kalıcı örtü kaybı (NDVI ve SWIR birlikte, ${observability.before}+${observability.after} gözlem, boşluk ${gapDays} gün, z ${fmtZ(opt.z)})`;
        if (levelText) reason += `; ${levelText}`;
        if (recovery?.ok === true) reason += `; yaz toparlanma testi ✓ (komşulara göre −${(recovery.delta ?? 0).toFixed(2)})`;
    } else if (opticalStrong && radarContradicts) {
        cls = 'unclear';
        kind = 'contradiction';
        reason = 'Optik kalıcı düşüş görüyor ama radar geri saçılım artıyor: sensörler çelişiyor, eksper incelemeli';
    } else if (opticalStrong && radarRequired && !radarAgrees) {
        cls = 'likely';
        kind = 'gap';
        reason = `Optik kalıcı düşüş görüyor; değişim ${gapDays === null ? 'belirsiz' : `${gapDays} günlük`} bulutlu/karlı boşluğa düşüyor ve radar teyit etmiyor`;
    } else if (gradual && best.z >= zLikely) {
        cls = 'unclear';
        kind = 'gradual_loss';
        reason = `Kademeli örtü kaybı: sezon boyu süren düşüş bir budama basamağı değil (eğim/basamak oranı ${shape?.ratio ?? '—'}); terk, sökme ya da hastalık olabilir`;
    } else if (opticalLikely && !ndviMagLikely) {
        cls = 'unclear';
        kind = 'small_ndvi';
        reason = `NDVI düşüşü küçük (${(ndviE?.delta ?? 0).toFixed(2)} < ${FUSION_RULES.minEffectLikely}); SWIR/kırmızı kenar değişimi tek başına nem, kar ya da gölge kaynaklı olabilir`;
    } else if (opticalLikely) {
        cls = 'likely';
        kind = 'likely_optical';
        let why: string;
        if (agreeing >= 2) why = lateObs === 0 ? 'kalıcılık için geç gözlem bekleniyor' : 'kalıcılık ya da gözlem sayısı kesin karar için yetersiz';
        else if (!ndviE?.magnitudeOk) why = `NDVI adımı (${(ndviE?.delta ?? 0).toFixed(2)}) derin budama eşiğinin (${CHANNEL_DEFAULTS.ndvi.minEffect}) altında: hafif budama ya da kısmi kesim olabilir`;
        else if (!swirOk) why = summerConfirms ? 'SWIR indeksleri eşlik etmiyor ama yaz başı örtü eksikliği sürüyor' : 'SWIR indeksleri eşlik etmiyor (kar/gölge olabilir)';
        else if (!denseEnough) why = `gözlem sayısı yetersiz (${observability.before} önce / ${observability.after} sonra / ${observability.late} geç)`;
        else if (opt.persistence !== true) why = 'kalıcılık henüz doğrulanmadı';
        else if ((opt.z ?? 0) < zPruned) why = `optik z (${fmtZ(opt.z)}) kesin karar eşiğinin (${zPruned.toFixed(1)}) altında`;
        else why = 'ikinci sensör bekleniyor';
        reason = agreeing >= 2 ? `Optik ve radar görüyor (z ${best.z.toFixed(1)}); ${why}` : `Optik görüyor (z ${fmtZ(opt.z)}); ${why}`;
        if (levelText) reason += ` · ${levelText}`;
    } else if (back.ok && (back.z ?? 0) >= FUSION_RULES.zRadarOnly && back.persistence === true) {
        cls = 'likely';
        kind = 'radar_only';
        reason = `Yalnız radar görüyor (z ${fmtZ(back.z)}); optik bulut altında — saha doğrulaması`;
    } else if (best.z >= zLikely && magnitudeOk && persistenceOk !== false && agreeing >= 1) {
        cls = 'likely';
        kind = 'second_sensor';
        reason = `${opt.ok ? 'Optik' : 'Radar'} görüyor (z ${best.z.toFixed(1)}); ikinci sensör bekleniyor`;
    } else if (persistenceOk === false && best.z >= zLikely) {
        cls = 'unclear';
        kind = 'transient';
        reason = 'Düşüş vardı ama geri döndü: geçici (gölge/kar/don) olabilir';
    } else if (best.z >= FUSION_RULES.zUnclear) {
        cls = 'unclear';
        kind = 'weak';
        reason = `Zayıf sinyal (z ${best.z.toFixed(1)})`;
    } else if (totalObs >= 12 && !observability.underObserved) {
        cls = 'not_pruned';
        kind = 'none';
        reason = `İyi gözlenmiş (${observability.opticalObs} optik gözlem); hiçbir sensörde kalıcı örtü kaybı yok`;
    } else if (totalObs >= 12) {
        cls = 'not_pruned';
        kind = 'none';
        reason = `Budama izi yok; optik gözlem az (${observability.opticalObs}), karar radarla destekli`;
    } else {
        cls = 'no_data';
        reason = 'Yeterli gözlem yok';
    }
    if (shadeProne && (cls === 'pruned' || cls === 'likely')) reason += ' · önceki kışlarda geçici düşüş görülen bahçe, eşikler sıkılaştırıldı';
    if (!inCalendar && (cls === 'pruned' || cls === 'likely')) reason += ' · değişim tarihi budama takviminin dışında';
    // Expert queue: every "likely", and the "unclear" ones with a strong signal — except dips the summer closed.
    const review = cls === 'likely' || (cls === 'unclear' && (gradual || (best.z >= zLikely && !summerDenies)));
    return {
        class: cls,
        kind,
        z: r3(best.z),
        p: posterior(best.z),
        changeDate: best.t0,
        lastBeforeAt,
        firstAfterAt,
        agreeing,
        opticalOk: opt.ok,
        backscatterOk: back.ok,
        coherenceOk: coh.ok,
        crossIndexOk,
        radarRequired,
        review,
        shadeProne,
        inCalendar,
        observability,
        levels,
        shape,
        recovery,
        populationZ: null,
        groups: best.groups,
        reason,
    };
}

/** Emulated scans every `everyDays` from `from` to `to`: the first dates reaching each confidence. */
export function scanTimeline(series: ChannelSeries[], from: string, to: string, everyDays: number, ctx: UnitContext = {}): { detectedAt: string | null; likelyAt: string | null; scans: Array<{ date: string; z: number | null; class: FusionClass }> } {
    const scans: Array<{ date: string; z: number | null; class: FusionClass }> = [];
    let detectedAt: string | null = null;
    let likelyAt: string | null = null;
    for (let t = Date.parse(from); t <= Date.parse(to); t += everyDays * dayMs) {
        const d = new Date(t).toISOString().slice(0, 10);
        const v = judge(series, d, ctx);
        scans.push({ date: d, z: v.z, class: v.class });
        if (!likelyAt && (v.class === 'likely' || v.class === 'pruned')) likelyAt = d;
        if (!detectedAt && v.class === 'pruned') detectedAt = d;
    }
    return { detectedAt, likelyAt, scans };
}
