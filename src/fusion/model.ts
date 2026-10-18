/**
 * Multi-sensor step-change model for deep pruning ("the equation").
 *
 * ÇAYKUR's deep pruning cuts the bush back to 30–45 cm: the leafy canopy is gone for months. On
 * every sensor that is a STEP that PERSISTS, in a known direction:
 *   NDVI ↓, NBR ↓ (optical), VH backscatter ↓ (volume scattering gone), coherence ↑ (bare stems
 *   and soil stay coherent). Cloud shadow, frost or thin snow move the same indices but recover
 *   within days; a real pruning does not.
 *
 * For a garden and a candidate change date t0 every channel is reduced to a signed z-score of
 * the step (mean after − mean before, in units of the garden's own noise), a persistence check
 * (do the late observations stay down?) and a magnitude gate (is the step physically large
 * enough to be canopy removal?). Channels of one sensor are averaged (they are correlated);
 * independent sensors are pooled with Stouffer's method. The best t0 gives the verdict. Scans
 * are emulated every N days by re-evaluating with only the observations available by then, so
 * the earliest confident date is also known.
 *
 * Every number here is a pre-calibration estimate: the posterior is a placeholder logistic on
 * the pooled z until field labels exist.
 */

export type ChannelKey = 'ndvi' | 'nbr' | 'vh_asc' | 'vh_desc' | 'coh_asc' | 'coh_desc';
export type SensorGroup = 'optical' | 'backscatter' | 'coherence';

export interface ChannelSeries {
    key: ChannelKey;
    /** +1 when pruning raises the value (coherence), −1 when it lowers it (NDVI, NBR, VH). */
    sign: 1 | -1;
    dates: string[];
    /** Neighbourhood-relative values (date median over all gardens subtracted). */
    values: Array<number | null>;
    /** Smallest step (in the channel's unit) that can mean canopy removal. */
    minEffect: number;
    /** Noise floor (the garden's own robust σ is never taken below this). */
    noiseFloor: number;
}

export const FUSION_RULES = {
    /** Observations this many days before / after the candidate change date are compared. */
    beforeDays: 60,
    afterDays: 75,
    /** An observation this long after t0 counts as "late": the change must still be there. */
    lateAfterDays: 25,
    /** The "early" step is measured on observations within this many days of t0. */
    earlyDays: 15,
    minBefore: 2,
    minAfter: 2,
    /** Pooled z for the verdict classes. */
    /** The best of ~50 candidate dates inflates noise to |z| ≈ 2.3; "likely" sits above that. */
    zPruned: 3.5,
    zLikely: 2.8,
    zUnclear: 1.5,
    /** Late step must keep at least this share of the early step, else it was transient. */
    persistenceMin: 0.5,
    /**
     * Sensor-group weights in the pooled z. Optical and backscatter are the two PRIMARY sensors:
     * a "pruned" verdict needs both. Coherence only supports (no signal at garden scale so far).
     */
    weights: { optical: 1.0, backscatter: 0.9, coherence: 0.2 } as Record<SensorGroup, number>,
    primary: ['optical', 'backscatter'] as SensorGroup[],
    /** Candidate change dates: the pruning calendar (autumn/winter, then the spring catch-up). */
    windows: [
        ['10-15', '01-31'],
        ['02-15', '04-10'],
    ] as Array<[string, string]>,
    /** Posterior placeholder: logistic on the pooled z, centred on zLikely+0.5. */
    posteriorCentre: 3.0,
    posteriorSlope: 1.3,
} as const;

export const CHANNEL_DEFAULTS: Record<ChannelKey, Pick<ChannelSeries, 'sign' | 'minEffect' | 'noiseFloor'>> = {
    ndvi: { sign: -1, minEffect: 0.12, noiseFloor: 0.025 },
    nbr: { sign: -1, minEffect: 0.12, noiseFloor: 0.025 },
    vh_asc: { sign: -1, minEffect: 1.0, noiseFloor: 0.4 },
    vh_desc: { sign: -1, minEffect: 1.0, noiseFloor: 0.4 },
    coh_asc: { sign: 1, minEffect: 0.06, noiseFloor: 0.05 },
    coh_desc: { sign: 1, minEffect: 0.06, noiseFloor: 0.05 },
};

export const GROUP_OF: Record<ChannelKey, SensorGroup> = {
    ndvi: 'optical',
    nbr: 'optical',
    vh_asc: 'backscatter',
    vh_desc: 'backscatter',
    coh_asc: 'coherence',
    coh_desc: 'coherence',
};

export type FusionClass = 'pruned' | 'likely' | 'unclear' | 'not_pruned' | 'no_data';

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

export interface FusionVerdict {
    class: FusionClass;
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
    groups: GroupEvidence[];
    /** Why the class is what it is (Turkish, for the screen). */
    reason: string;
}

const dayMs = 86_400_000;
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / dayMs);
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const median = (xs: number[]) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const r3 = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 1000);

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
        // Optical channels come from the same pixels: average. Orbits are independent looks: Stouffer.
        const z = !zs.length ? null : group === 'optical' ? mean(zs) : zs.reduce((a, b) => a + b, 0) / Math.sqrt(zs.length);
        groups.push({ group, z: r3(z), channels });
    }
    return { z: r3(pooledZ(groups)), groups };
}

function inWindows(date: string): boolean {
    const md = date.slice(5);
    return FUSION_RULES.windows.some(([a, b]) => (a <= b ? md >= a && md <= b : md >= a || md <= b));
}

export function posterior(z: number | null): number {
    if (z === null) return 0;
    return Math.round((1 / (1 + Math.exp(-FUSION_RULES.posteriorSlope * (z - FUSION_RULES.posteriorCentre)))) * 1000) / 1000;
}

/** Verdict from the best candidate change date, with observations up to `asOf`. */
export function judge(series: ChannelSeries[], asOf: string): FusionVerdict {
    const noises = new Map<ChannelKey, number>(series.map((s) => [s.key, robustNoise(s.values, s.noiseFloor)]));
    const candidates = [...new Set(series.flatMap((s) => s.dates))].filter((d) => d <= asOf && inWindows(d)).sort();
    let best: { t0: string; z: number; groups: GroupEvidence[] } | null = null;
    for (const t0 of candidates) {
        const e = evidenceAt(series, noises, t0, asOf);
        if (e.z !== null && (!best || e.z > best.z)) best = { t0, z: e.z, groups: e.groups };
    }
    const totalObs = series.reduce((s, c) => s + c.values.filter((v, i) => v !== null && c.dates[i]! <= asOf).length, 0);
    if (!best) {
        return { class: 'no_data', z: null, p: 0, changeDate: null, lastBeforeAt: null, firstAfterAt: null, agreeing: 0, opticalOk: false, backscatterOk: false, groups: [], reason: totalObs < 6 ? 'Yeterli gözlem yok' : 'Değişim penceresinde iki yanlı gözlem yok' };
    }
    // A primary sensor "sees" the pruning when its pooled z clears the bar, at least one of its
    // channels shows a physically large enough step, no channel contradicts (an orbit moving the
    // other way) and — once late observations exist — the step persisted.
    const sensorOk = (group: SensorGroup): { ok: boolean; persistence: boolean | null } => {
        const g = best!.groups.find((x) => x.group === group);
        if (!g || g.z === null) return { ok: false, persistence: null };
        const magnitude = g.channels.some((c) => c.magnitudeOk && (c.z ?? 0) >= FUSION_RULES.zUnclear);
        const contradicted = g.channels.some((c) => (c.z ?? 0) <= -FUSION_RULES.zUnclear);
        const withLate = g.channels.filter((c) => c.persistence !== null);
        const persistence = withLate.length === 0 ? null : withLate.some((c) => (c.persistence as number) >= FUSION_RULES.persistenceMin);
        return { ok: g.z >= FUSION_RULES.zUnclear && magnitude && !contradicted && persistence !== false, persistence };
    };
    const optical = sensorOk('optical');
    const backscatter = sensorOk('backscatter');
    const agreeing = [optical, backscatter].filter((s) => s.ok).length;
    const primaryChannels = best.groups.filter((g) => FUSION_RULES.primary.includes(g.group)).flatMap((g) => g.channels);
    const magnitudeOk = primaryChannels.some((c) => c.magnitudeOk && (c.z ?? 0) >= FUSION_RULES.zUnclear);
    const persist = primaryChannels.filter((c) => c.persistence !== null);
    const persistenceOk = persist.length === 0 ? null : persist.some((c) => (c.persistence as number) >= FUSION_RULES.persistenceMin);
    const lateObs = primaryChannels.reduce((s, c) => s + c.late, 0);

    // Observation interval around t0: last observation before it and the first at/after it (any channel).
    let lastBeforeAt: string | null = null;
    let firstAfterAt: string | null = null;
    for (const s of series) {
        s.dates.forEach((d, i) => {
            if (s.values[i] === null || s.values[i] === undefined || d > asOf) return;
            if (d < best!.t0 && (!lastBeforeAt || d > lastBeforeAt)) lastBeforeAt = d;
            if (d >= best!.t0 && (!firstAfterAt || d < firstAfterAt)) firstAfterAt = d;
        });
    }

    let cls: FusionClass;
    let reason: string;
    // "pruned" needs the change to have been SEEN to persist (≥ lateAfterDays): until then a
    // strong joint signal is "likely", which is what a scan 2–3 days after the cut can honestly say.
    if (best.z >= FUSION_RULES.zPruned && optical.ok && backscatter.ok && persistenceOk === true) {
        cls = 'pruned';
        reason = `Optik ve radar aynı tarihte kalıcı örtü kaybı görüyor (z ${best.z.toFixed(1)})`;
    } else if (best.z >= FUSION_RULES.zLikely && magnitudeOk && persistenceOk !== false && agreeing >= 1) {
        cls = 'likely';
        reason = agreeing >= 2
            ? `Optik ve radar görüyor (z ${best.z.toFixed(1)}); ${lateObs === 0 ? 'kalıcılık için geç gözlem bekleniyor' : 'kalıcılık eşiği henüz aşılmadı'}`
            : `${optical.ok ? 'Yalnız optik' : 'Yalnız radar'} görüyor (z ${best.z.toFixed(1)}); ikinci sensör bekleniyor`;
    } else if (persistenceOk === false && best.z >= FUSION_RULES.zLikely) {
        cls = 'unclear';
        reason = 'Düşüş vardı ama geri döndü: geçici (gölge/kar/don) olabilir';
    } else if (best.z >= FUSION_RULES.zUnclear) {
        cls = 'unclear';
        reason = `Zayıf sinyal (z ${best.z.toFixed(1)})`;
    } else if (totalObs >= 12) {
        cls = 'not_pruned';
        reason = 'İyi gözlenmiş; hiçbir sensörde kalıcı örtü kaybı yok';
    } else {
        cls = 'no_data';
        reason = 'Yeterli gözlem yok';
    }
    return { class: cls, z: r3(best.z), p: posterior(best.z), changeDate: best.t0, lastBeforeAt, firstAfterAt, agreeing, opticalOk: optical.ok, backscatterOk: backscatter.ok, groups: best.groups, reason };
}

/** Emulated scans every `everyDays` from `from` to `to`: the first dates reaching each confidence. */
export function scanTimeline(series: ChannelSeries[], from: string, to: string, everyDays: number): { detectedAt: string | null; likelyAt: string | null; scans: Array<{ date: string; z: number | null; class: FusionClass }> } {
    const scans: Array<{ date: string; z: number | null; class: FusionClass }> = [];
    let detectedAt: string | null = null;
    let likelyAt: string | null = null;
    for (let t = Date.parse(from); t <= Date.parse(to); t += everyDays * dayMs) {
        const d = new Date(t).toISOString().slice(0, 10);
        const v = judge(series, d);
        scans.push({ date: d, z: v.z, class: v.class });
        if (!likelyAt && (v.class === 'likely' || v.class === 'pruned')) likelyAt = d;
        if (!detectedAt && v.class === 'pruned') detectedAt = d;
    }
    return { detectedAt, likelyAt, scans };
}
