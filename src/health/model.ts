/**
 * Garden-health model (separate from pruning): on the growing season (Apr–Oct) it looks for
 * sudden canopy loss that is NOT pruning — an optical drop (NDVI / NDRE) the radar does not see
 * as a structural change points to herbicide scorch or chemical damage; a drop both sensors see
 * outside the pruning window points to defoliation (pest, hail, unauthorised cutting). It also
 * scores each garden's vigour against its neighbourhood and turns that into a yield estimate
 * against the licence quota. Uncalibrated: a pointer for leaf sampling, not a verdict.
 */
import { robustNoise } from '../fusion/model.ts';

export const HEALTH_RULES = {
    /** Observations this many days before / after a candidate date are compared. */
    beforeDays: 30,
    afterDays: 20,
    /** Recovery is judged on observations this many days after the candidate date. */
    recoveryFrom: 45,
    recoveryTo: 95,
    minBefore: 2,
    minAfter: 2,
    /** Step thresholds on the neighbourhood-relative optical series. */
    zSuspect: 3.5,
    zStress: 2.5,
    minDropNdvi: 0.1,
    minDropStress: 0.06,
    /** A VH step (dB) at least this large means the canopy structure changed (pruning-like). */
    radarStructuralDb: 0.8,
    /** Noise floors (units of the index / dB). */
    noiseFloorOptical: 0.02,
    noiseFloorRadar: 0.4,
    /** Candidate change dates (inclusive); spring pruning is legal until late April, so start in May. */
    candidateFrom: '05-01',
    candidateTo: '10-10',
    /** Vigour is the Jun–Sep mean NDVI of the garden over the neighbourhood's. */
    vigourFrom: '06-01',
    vigourTo: '09-30',
    /** Demo yield norm (kg fresh leaf per dekar per season) and the licence quota norm. */
    baseYieldKgPerDa: 1000,
    quotaKgPerDa: 1000,
    /** The part of a garden deep-pruned in the previous winter yields this fraction in the season after. */
    prunedYieldFactor: 0.35,
    /** Yield / quota ratios that are worth a look. */
    lowRatio: 0.5,
    highRatio: 1.4,
};

export type AnomalyClass = 'chemical_suspect' | 'defoliation' | 'stress' | 'none' | 'no_data';

export interface AnomalyVerdict {
    class: AnomalyClass;
    date: string | null;
    /** Relative NDVI / NDRE drop (positive = loss) and their pooled z. */
    dropNdvi: number | null;
    dropNdre: number | null;
    z: number | null;
    /** Radar VH step at the date (dB, positive = backscatter loss), best of the two orbits. */
    radarDb: number | null;
    radarStructural: boolean | null;
    /** Share of the drop recovered 45–95 days later (null when the season ended first). */
    recovery: number | null;
    nBefore: number;
    nAfter: number;
    reason: string;
}

export interface GardenHealth {
    id: string;
    producerId: string;
    teaAreaM2: number;
    licensedAreaM2: number | null;
    /** Jun–Sep mean NDVI of the garden and of the neighbourhood median, and their ratio. */
    ndviMean: number | null;
    ndreMean: number | null;
    nbhdNdviMean: number | null;
    vigour: number | null;
    /** Share of the garden deep-pruned in the previous winter (fusion verdict), 0..1. */
    prunedShare: number;
    anomaly: AnomalyVerdict;
    /** Season yield estimate (kg fresh leaf) and the factors behind it. */
    yieldKg: number;
    yieldFactors: { vigour: number; pruning: number; anomaly: number };
    observations: number;
}

export interface Series {
    dates: string[];
    values: Array<number | null>;
}

const dayOf = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / 86400000;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Neighbourhood median per date over all gardens with data (the common weather / season signal). */
export function medianSeries(byGarden: Record<string, Array<number | null>>, n: number): Array<number | null> {
    const out: Array<number | null> = [];
    const all = Object.values(byGarden);
    for (let i = 0; i < n; i++) {
        const vals = all.map((s) => s[i]).filter((v): v is number => v != null).sort((a, b) => a - b);
        if (vals.length < 3) { out.push(null); continue; }
        const mid = Math.floor(vals.length / 2);
        out.push(vals.length % 2 ? vals[mid]! : (vals[mid - 1]! + vals[mid]!) / 2);
    }
    return out;
}

/** Garden minus neighbourhood median, per date. */
export function relative(values: Array<number | null>, median: Array<number | null>): Array<number | null> {
    return values.map((v, i) => (v != null && median[i] != null ? Math.round((v - (median[i] as number)) * 1000) / 1000 : null));
}

function windowValues(s: Series, from: number, to: number): number[] {
    const out: number[] = [];
    s.dates.forEach((d, i) => {
        const t = dayOf(d);
        const v = s.values[i];
        if (v != null && t >= from && t <= to) out.push(v);
    });
    return out;
}

interface Step {
    drop: number;
    z: number;
    nBefore: number;
    nAfter: number;
}

/** Drop (before − after) of a relative series at t0, in units of its own noise. */
function step(s: Series, t0: string, noise: number): Step | null {
    const t = dayOf(t0);
    const before = windowValues(s, t - HEALTH_RULES.beforeDays, t - 1);
    const after = windowValues(s, t, t + HEALTH_RULES.afterDays);
    if (before.length < HEALTH_RULES.minBefore || after.length < HEALTH_RULES.minAfter) return null;
    const drop = (mean(before) as number) - (mean(after) as number);
    const z = drop / (noise * Math.sqrt(1 / before.length + 1 / after.length));
    return { drop, z, nBefore: before.length, nAfter: after.length };
}

/** Classifies the growing season of one garden. All optical inputs are neighbourhood-relative. */
export function detectAnomaly(year: number, ndvi: Series, ndre: Series, radar: Series[]): AnomalyVerdict {
    const obs = ndvi.values.filter((v) => v != null).length;
    const none = (reason: string, cls: AnomalyClass = 'none'): AnomalyVerdict => ({ class: cls, date: null, dropNdvi: null, dropNdre: null, z: null, radarDb: null, radarStructural: null, recovery: null, nBefore: 0, nAfter: 0, reason });
    if (obs < 6) return none('Büyüme sezonunda yeterli bulutsuz gözlem yok', 'no_data');
    const noiseNdvi = robustNoise(ndvi.values, HEALTH_RULES.noiseFloorOptical);
    const noiseNdre = robustNoise(ndre.values, HEALTH_RULES.noiseFloorOptical);
    const from = dayOf(`${year}-${HEALTH_RULES.candidateFrom}`);
    const to = dayOf(`${year}-${HEALTH_RULES.candidateTo}`);
    let best: { t0: string; ndvi: Step; ndre: Step | null; z: number } | null = null;
    for (const d of ndvi.dates) {
        const t = dayOf(d);
        if (t < from || t > to) continue;
        const sN = step(ndvi, d, noiseNdvi);
        if (!sN) continue;
        const sR = step(ndre, d, noiseNdre);
        const z = sR ? (sN.z + sR.z) / 2 : sN.z;
        if (!best || z > best.z) best = { t0: d, ndvi: sN, ndre: sR, z };
    }
    if (!best) return none('Aday tarihlerde öncesi/sonrası yeterli gözlem yok');
    const { t0 } = best;
    // Radar: the biggest VH loss across orbits at t0.
    let radarDb: number | null = null;
    for (const r of radar) {
        const s = step(r, t0, robustNoise(r.values, HEALTH_RULES.noiseFloorRadar));
        if (s && (radarDb === null || s.drop > radarDb)) radarDb = s.drop;
    }
    const t = dayOf(t0);
    const late = windowValues(ndvi, t + HEALTH_RULES.recoveryFrom, t + HEALTH_RULES.recoveryTo);
    const beforeMean = mean(windowValues(ndvi, t - HEALTH_RULES.beforeDays, t - 1));
    const afterMean = mean(windowValues(ndvi, t, t + HEALTH_RULES.afterDays));
    let recovery: number | null = null;
    if (late.length >= 2 && beforeMean != null && afterMean != null && beforeMean - afterMean > 0.02) {
        recovery = Math.max(0, Math.min(1, 1 - (beforeMean - (mean(late) as number)) / (beforeMean - afterMean)));
    }
    const r3 = (v: number | null) => (v == null ? null : Math.round(v * 1000) / 1000);
    const base = { date: t0, dropNdvi: r3(best.ndvi.drop), dropNdre: best.ndre ? r3(best.ndre.drop) : null, z: r3(best.z), radarDb: r3(radarDb), radarStructural: radarDb == null ? null : radarDb >= HEALTH_RULES.radarStructuralDb, recovery: r3(recovery), nBefore: best.ndvi.nBefore, nAfter: best.ndvi.nAfter };
    const strong = best.z >= HEALTH_RULES.zSuspect && best.ndvi.drop >= HEALTH_RULES.minDropNdvi;
    const mild = best.z >= HEALTH_RULES.zStress && best.ndvi.drop >= HEALTH_RULES.minDropStress;
    if (strong && base.radarStructural === true) {
        return { class: 'defoliation', ...base, reason: `${t0}: NDVI ${base.dropNdvi} düştü (z ${base.z}) ve radar ${base.radarDb} dB yapısal kayıp gördü — budama penceresi dışında yaprak/dal kaybı (zararlı, dolu, izinsiz kesim)` };
    }
    if (strong) {
        const rec = recovery == null ? 'toparlanma henüz görülmedi' : `${Math.round(recovery * 100)}% toparlandı`;
        return { class: 'chemical_suspect', ...base, reason: `${t0}: NDVI ${base.dropNdvi} / NDRE ${base.dropNdre ?? '—'} düştü (z ${base.z}), radar yapısal değişim görmedi (${base.radarDb ?? '—'} dB); ${rec} — herbisit yanığı / kimyasal hasar şüphesi, yaprak numunesi önerilir` };
    }
    if (mild) {
        return { class: 'stress', ...base, reason: `${t0}: komşulara göre hafif canlılık kaybı (NDVI ${base.dropNdvi}, z ${base.z}) — kuraklık / besin stresi olabilir` };
    }
    return { class: 'none', ...base, reason: 'Büyüme sezonunda komşulardan ayrışan ani kayıp yok' };
}

/** Jun–Sep vigour and the season yield estimate of a garden. */
export function vigourAndYield(year: number, ndviAbs: Series, ndreAbs: Series, nbhd: Series, teaAreaM2: number, prunedShare: number, anomaly: AnomalyClass): Pick<GardenHealth, 'ndviMean' | 'ndreMean' | 'nbhdNdviMean' | 'vigour' | 'yieldKg' | 'yieldFactors' | 'observations'> {
    const from = dayOf(`${year}-${HEALTH_RULES.vigourFrom}`);
    const to = dayOf(`${year}-${HEALTH_RULES.vigourTo}`);
    const g = windowValues(ndviAbs, from, to);
    const n = windowValues(nbhd, from, to);
    const ndviMean = mean(g);
    const nbhdMean = mean(n);
    const ndreMean = mean(windowValues(ndreAbs, from, to));
    const vigour = ndviMean != null && nbhdMean != null && nbhdMean > 0.05 ? ndviMean / nbhdMean : null;
    const vigourFactor = vigour == null ? 1 : Math.max(0.6, Math.min(1.3, vigour));
    const pruningFactor = 1 - (1 - HEALTH_RULES.prunedYieldFactor) * Math.max(0, Math.min(1, prunedShare));
    const anomalyFactor = anomaly === 'chemical_suspect' || anomaly === 'defoliation' ? 0.85 : anomaly === 'stress' ? 0.95 : 1;
    const yieldKg = Math.round((teaAreaM2 / 1000) * HEALTH_RULES.baseYieldKgPerDa * vigourFactor * pruningFactor * anomalyFactor);
    const r3 = (v: number | null) => (v == null ? null : Math.round(v * 1000) / 1000);
    return {
        ndviMean: r3(ndviMean), ndreMean: r3(ndreMean), nbhdNdviMean: r3(nbhdMean), vigour: r3(vigour), yieldKg,
        yieldFactors: { vigour: Math.round(vigourFactor * 100) / 100, pruning: Math.round(pruningFactor * 100) / 100, anomaly: anomalyFactor },
        observations: ndviAbs.values.filter((v) => v != null).length,
    };
}
