/**
 * Garden age, renewal and abandonment model (Bahçe yaşı ve yenileme modülü).
 *
 * Age: a tea garden cannot be dated directly from space, but its establishment leaves a signature in the
 * Landsat record (1984→): a bare / low-NDVI phase while the slope is prepared and the young plants fill
 * in, followed by a closed canopy (summer NDVI ≥ 0.55 sustained). The first year of a sustained closed
 * canopy preceded by a low phase is the establishment year; a canopy already closed at the start of the
 * record means "planted before 1986" (most Turkish tea gardens: planted 1940s–1980s, 60–100 years old
 * according to ÇAYKUR, with a productive life taken as 50 years).
 * Renewal: a rejuvenation pruning (kök / gençleştirme budaması) or replanting shows as a sharp NDVI drop
 * (≥ 0.15) that recovers within four summers.
 * Activity: a harvested garden shows within-season NDVI dips (May, July, September flushes) in the
 * Sentinel-2 monthly series; an abandoned one grows into a flat, overgrown canopy.
 * Priority: age, time since the last renewal, vigour trend and recent vigour → renewal priority score.
 */
export const AGE_RULES = {
    recordStart: 1984,
    /** Closed canopy / low phase thresholds on the yearly summer Landsat NDVI (30 m mixed pixels). */
    canopyNdvi: 0.55,
    lowNdvi: 0.4,
    establishConfirmYears: 3,
    lookbackYears: 4,
    /** Whole-parcel rejuvenation shows as ≥ 0.08 on the smoothed 30 m series (ÇAYKUR prunes a seventh of a garden a year, so partial prunings stay below it). */
    renewalDrop: 0.08,
    renewalRecoverYears: 4,
    trendWindowYears: 12,
    /** Sentinel-2 harvest dip: fall from the previous month and rebound the month after. */
    dipFall: 0.05,
    dipRebound: 0.03,
    activity: { harvestedDips: 1.0, harvestedAmplitude: 0.12, lowDips: 0.5 },
    productiveLifeYears: 50,
    renewalCycleYears: 7,
    /** Vigour below the neighbourhood median by this much marks a weak garden among its peers. */
    belowPeersNdvi: 0.04,
    priority: { oldGarden: 30, middleAged: 15, noRenewal: 15, decliningVigour: 20, lowVigour: 20, belowPeers: 15, active: 10 },
    priorityClasses: { high: 65, medium: 40 },
    sources: ['caykur-genclestirme', 'caykur-budama-cevrimi', 'landsat', 'sentinel-2'],
} as const;

export const AGE_SOURCES = [
    { id: 'caykur-genclestirme', title: 'ÇAYKUR Genel Müdürü: çay bahçeleri 60–100 yaşında, verim süresi 50 yıl; gençleştirme budaması 20 cm altından', org: 'ÇAYKUR (basın)', year: 2024, url: 'https://www.cnbce.com/haberler/cay-bahcelerine-tesvik-caykur-genel-muduru-alim-duyurdu-h39265', used: 'Yaş sınıfları ve 50 yıllık verim ömrü eşiği; gençleştirme ihtiyacı.' },
    { id: 'caykur-budama-cevrimi', title: 'ÇAYKUR budama programı: her yıl bahçelerin yedide biri budanır, budama maliyetinin %70’i tazminat olarak ödenir', org: 'ÇAYKUR (basın)', year: 2022, url: 'https://www.haberturk.com/caykur-dan-rekor-yas-cay-alimi-3224219-ekonomi', used: '7 yıllık budama çevrimi; yenileme desteği bağlamı.' },
    { id: 'landsat', title: 'Landsat 5/7/8/9 Collection 2 Level-2', org: 'USGS', year: '1984→', url: 'https://developers.google.com/earth-engine/datasets/catalog/landsat', used: 'Yıllık yaz NDVI serisi: kuruluş yılı, yenileme olayları, canlılık eğilimi.' },
    { id: 'sentinel-2', title: 'Sentinel-2 L2A (harmonized) + Cloud Score+', org: 'ESA / Google', year: '2017→', url: 'https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_S2_SR_HARMONIZED', used: 'Aylık NDVI: hasat etkinliği ve terk belirtisi.' },
];

export type AgeClass = 'under_10' | 'y10_25' | 'y25_40' | 'over_40' | 'not_tea' | 'unknown';
export type ActivityClass = 'harvested' | 'low' | 'none' | 'no_data';
export type AbandonClass = 'active' | 'weak' | 'likely_abandoned' | 'not_tea';
export type PriorityClass = 'high' | 'medium' | 'low' | 'not_applicable';

export const AGE_CLASS_LABEL: Record<AgeClass, string> = {
    under_10: '10 yaş altı',
    y10_25: '10–25 yaş',
    y25_40: '25–40 yaş',
    over_40: '40 yaş üstü (1986 öncesi)',
    not_tea: 'Çay örtüsü yok',
    unknown: 'Belirlenemedi',
};

export interface ParcelAgeInput {
    key: string;
    block: string;
    parcel: string;
    nature: string;
    areaM2: number;
    teaShare: number | null;
    years: number[];
    ndvi: Array<number | null>;
    obs: Array<number | null>;
    s2Years: number[];
    s2Months: number[];
    s2: Record<number, Array<number | null>>;
    thisYear: number;
    /** Median recent NDVI of the neighbourhood's tea parcels (second pass), for the peer comparison. */
    nbhdRecentMedian?: number | null;
}

export interface ParcelAge {
    key: string;
    block: string;
    parcel: string;
    nature: string;
    areaM2: number;
    teaShare: number | null;
    series: { years: number[]; ndvi: Array<number | null>; smooth: Array<number | null>; obs: Array<number | null> };
    s2: { years: number[]; months: number[]; ndvi: Record<number, Array<number | null>>; dips: Record<number, number>; amplitude: Record<number, number | null> };
    establishment: { year: number | null; preRecord: boolean; confidence: 'high' | 'medium' | 'low'; note: string };
    ageYears: number | null;
    ageClass: AgeClass;
    renewals: Array<{ year: number; drop: number; recoveredIn: number }>;
    lastRenewalYear: number | null;
    vigour: { trendPerDecade: number | null; recentMean: number | null; peakMean: number | null; peakYears: string | null; declinePct: number | null };
    activity: { dipsPerYear: number | null; amplitude: number | null; class: ActivityClass };
    abandonment: { score: number; class: AbandonClass; reasons: string[] };
    priority: { score: number; class: PriorityClass; reasons: string[] };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Rolling median over the valid values of y−1, y, y+1. */
export function smoothSeries(v: Array<number | null>): Array<number | null> {
    return v.map((_, i) => {
        const w = [v[i - 1], v[i], v[i + 1]].filter((x): x is number => typeof x === 'number').sort((a, b) => a - b);
        if (w.length === 0) return null;
        return w.length === 3 ? w[1]! : w.length === 2 ? (w[0]! + w[1]!) / 2 : w[0]!;
    });
}

function slopePerDecade(years: number[], values: Array<number | null>): number | null {
    const pts = years.map((y, i) => [y, values[i]] as const).filter((p): p is readonly [number, number] => typeof p[1] === 'number');
    if (pts.length < 5) return null;
    const mx = mean(pts.map((p) => p[0]))!;
    const my = mean(pts.map((p) => p[1]))!;
    const den = pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
    if (den === 0) return null;
    return r3((pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / den) * 10);
}

export function evaluateParcelAge(inp: ParcelAgeInput): ParcelAge {
    const R = AGE_RULES;
    const smooth = smoothSeries(inp.ndvi);
    const years = inp.years;
    const at = (y: number) => smooth[years.indexOf(y)] ?? null;
    const firstValid = years.find((y) => at(y) !== null) ?? null;
    const hasCanopy = smooth.some((v) => v !== null && v >= R.canopyNdvi);

    // Establishment: first sustained closed canopy preceded by a low phase.
    let establishmentYear: number | null = null;
    let preRecord = false;
    let confidence: ParcelAge['establishment']['confidence'] = 'low';
    let note = '';
    if (!hasCanopy) {
        note = 'Kayıt boyunca kapalı çay örtüsü (NDVI ≥ 0,55) görülmedi.';
    } else {
        for (const y of years) {
            const run = Array.from({ length: R.establishConfirmYears }, (_, k) => at(y + k));
            if (!run.every((v) => v !== null && v >= R.canopyNdvi)) continue;
            const before = Array.from({ length: R.lookbackYears }, (_, k) => at(y - 1 - k)).filter((v): v is number => v !== null);
            const lowBefore = before.some((v) => v < R.lowNdvi);
            if (lowBefore) {
                establishmentYear = y;
                confidence = before.length >= 2 ? 'high' : 'medium';
                note = `Kapalı örtü ${y}’dan itibaren sürekli; önceki ${before.length} yılda düşük NDVI (${Math.min(...before).toFixed(2)}).`;
                break;
            }
            if (before.length === 0 && firstValid !== null && y <= firstValid + 1) {
                preRecord = true;
                confidence = 'medium';
                note = `Kayıt başında (${firstValid}) örtü zaten kapalı: 1986 öncesi tesis.`;
                break;
            }
            // Canopy sustained without a low phase before it (e.g. shrub → tea): take the first sustained year as a lower bound.
            if (!lowBefore && establishmentYear === null && before.length > 0) {
                preRecord = y <= (firstValid ?? y) + 2;
                establishmentYear = preRecord ? null : y;
                confidence = 'low';
                note = preRecord ? `Kayıt başında örtü kapalı: 1986 öncesi tesis.` : `Kapalı örtü ${y}’dan itibaren; öncesinde düşük faz görülmedi (alt sınır).`;
                break;
            }
        }
    }
    const ageYears = establishmentYear !== null ? inp.thisYear - establishmentYear : preRecord ? inp.thisYear - 1986 : null;
    const ageClass: AgeClass = !hasCanopy ? 'not_tea' : preRecord ? 'over_40' : ageYears === null ? 'unknown' : ageYears < 10 ? 'under_10' : ageYears < 25 ? 'y10_25' : ageYears < 40 ? 'y25_40' : 'over_40';

    // Renewal events: sharp drop that recovers.
    const renewals: ParcelAge['renewals'] = [];
    for (let i = 1; i < years.length; i++) {
        const prev = smooth[i - 1];
        const cur = smooth[i];
        if (prev === null || cur === null || prev < R.canopyNdvi) continue;
        const drop = prev - cur;
        if (drop < R.renewalDrop) continue;
        let recoveredIn = 0;
        for (let k = 1; k <= R.renewalRecoverYears; k++) {
            const v = smooth[i + k];
            if (v !== null && v !== undefined && v >= prev - 0.05) {
                recoveredIn = k;
                break;
            }
        }
        if (recoveredIn > 0 && (years[i]! !== establishmentYear)) {
            renewals.push({ year: years[i]!, drop: r3(drop), recoveredIn });
            i += recoveredIn;
        }
    }
    const lastRenewalYear = renewals.at(-1)?.year ?? null;

    // Vigour: trend over the last window, recent mean vs the best 5-year mean.
    const windowYears = years.filter((y) => y > inp.thisYear - R.trendWindowYears);
    const trend = slopePerDecade(windowYears, windowYears.map((y) => at(y)));
    const recentVals = years.filter((y) => y > inp.thisYear - 5).map((y) => at(y)).filter((v): v is number => v !== null);
    const recentMean = recentVals.length ? r3(mean(recentVals)!) : null;
    let peakMean: number | null = null;
    let peakYears: string | null = null;
    for (let i = 0; i + 5 <= years.length; i++) {
        const w = smooth.slice(i, i + 5).filter((v): v is number => v !== null);
        if (w.length < 3) continue;
        const m = mean(w)!;
        if (peakMean === null || m > peakMean) {
            peakMean = r3(m);
            peakYears = `${years[i]}–${years[i + 4]}`;
        }
    }
    const declinePct = recentMean !== null && peakMean ? Math.round(((peakMean - recentMean) / peakMean) * 100) : null;

    // Activity from Sentinel-2 monthly dips.
    const dips: Record<number, number> = {};
    const amplitude: Record<number, number | null> = {};
    for (const y of inp.s2Years) {
        const m = inp.s2[y];
        if (!m) continue;
        let n = 0;
        for (let i = 1; i < m.length - 1; i++) {
            const a = m[i - 1];
            const b = m[i];
            const c = m[i + 1];
            if (a !== null && b !== null && c !== null && a - b >= R.dipFall && c - b >= R.dipRebound) n++;
        }
        dips[y] = n;
        const vals = m.filter((v): v is number => v !== null);
        amplitude[y] = vals.length >= 3 ? r3(Math.max(...vals) - Math.min(...vals)) : null;
    }
    const recentS2 = inp.s2Years.filter((y) => y > inp.thisYear - 6 && inp.s2[y]);
    const dipsPerYear = recentS2.length ? r3(mean(recentS2.map((y) => dips[y]!))!) : null;
    const ampVals = recentS2.map((y) => amplitude[y]).filter((v): v is number => v !== null);
    const amp = ampVals.length ? r3(mean(ampVals)!) : null;
    const activityClass: ActivityClass =
        dipsPerYear === null ? 'no_data' : dipsPerYear >= R.activity.harvestedDips || (amp !== null && amp >= R.activity.harvestedAmplitude) ? 'harvested' : dipsPerYear >= R.activity.lowDips ? 'low' : 'none';

    // Abandonment.
    const aReasons: string[] = [];
    let aScore = 0;
    if (!hasCanopy) aReasons.push('Çay örtüsü yok');
    else {
        if (activityClass === 'none') {
            aScore += 45;
            aReasons.push('Sezon içinde hasat/budama düşüşü görülmüyor');
        } else if (activityClass === 'low') {
            aScore += 20;
            aReasons.push('Hasat düşüşleri seyrek');
        }
        if ((inp.teaShare ?? 1) < 0.4) {
            aScore += 25;
            aReasons.push(`Uydu çay payı düşük (${Math.round((inp.teaShare ?? 0) * 100)} %)`);
        }
        if (amp !== null && amp < 0.08) {
            aScore += 15;
            aReasons.push('Sezon genliği çok düşük (düz, aşırı büyümüş örtü)');
        }
        if (recentMean !== null && recentMean >= 0.85 && activityClass !== 'harvested') {
            aScore += 10;
            aReasons.push('NDVI çok yüksek ve sabit: ağaçlaşma belirtisi');
        }
    }
    const abandonClass: AbandonClass = !hasCanopy ? 'not_tea' : aScore >= 60 ? 'likely_abandoned' : aScore >= 30 ? 'weak' : 'active';

    // Renewal priority.
    const pReasons: string[] = [];
    let pScore = 0;
    if (hasCanopy && abandonClass !== 'likely_abandoned') {
        if (ageClass === 'over_40') {
            pScore += R.priority.oldGarden;
            pReasons.push('40 yaş üstü (ÇAYKUR: verim ömrü 50 yıl)');
        } else if (ageClass === 'y25_40') {
            pScore += R.priority.middleAged;
            pReasons.push('25–40 yaş');
        }
        const sinceRenewal = lastRenewalYear === null ? null : inp.thisYear - lastRenewalYear;
        if (sinceRenewal === null || sinceRenewal > 2 * R.renewalCycleYears) {
            pScore += R.priority.noRenewal;
            pReasons.push(sinceRenewal === null ? 'Kayıtta gençleştirme izi yok' : `Son gençleştirme ${lastRenewalYear} (${sinceRenewal} yıl önce)`);
        }
        if (trend !== null && trend <= -0.02) {
            pScore += R.priority.decliningVigour;
            pReasons.push(`Canlılık düşüyor (${trend} NDVI / 10 yıl)`);
        }
        if (declinePct !== null && declinePct >= 8) {
            pScore += R.priority.lowVigour;
            pReasons.push(`Zirve dönemine göre %${declinePct} düşük`);
        }
        const peer = inp.nbhdRecentMedian ?? null;
        if (peer !== null && recentMean !== null && recentMean <= peer - R.belowPeersNdvi) {
            pScore += R.priority.belowPeers;
            pReasons.push(`Mahalle ortancasının altında canlılık (${recentMean.toFixed(2)} / ${peer.toFixed(2)})`);
        }
        if (activityClass === 'harvested') {
            pScore += R.priority.active;
            pReasons.push('Aktif hasat ediliyor: yenileme getirisi yüksek');
        }
    }
    const priorityClass: PriorityClass = !hasCanopy || abandonClass === 'likely_abandoned' ? 'not_applicable' : pScore >= R.priorityClasses.high ? 'high' : pScore >= R.priorityClasses.medium ? 'medium' : 'low';

    return {
        key: inp.key,
        block: inp.block,
        parcel: inp.parcel,
        nature: inp.nature,
        areaM2: inp.areaM2,
        teaShare: inp.teaShare,
        series: { years, ndvi: inp.ndvi, smooth: smooth.map((v) => (v === null ? null : r3(v))), obs: inp.obs },
        s2: { years: inp.s2Years, months: inp.s2Months, ndvi: inp.s2, dips, amplitude },
        establishment: { year: establishmentYear, preRecord, confidence, note },
        ageYears,
        ageClass,
        renewals,
        lastRenewalYear,
        vigour: { trendPerDecade: trend, recentMean, peakMean, peakYears, declinePct },
        activity: { dipsPerYear, amplitude: amp, class: activityClass },
        abandonment: { score: Math.min(100, aScore), class: abandonClass, reasons: aReasons },
        priority: { score: Math.min(100, pScore), class: priorityClass, reasons: pReasons },
    };
}
