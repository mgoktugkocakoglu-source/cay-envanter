import type { AuditFile, AuditParcel } from '../cli/audit-licensing.ts';
import type { DroneVerificationFile, DroneVerificationParcel } from '../drone/model.ts';

/**
 * Rule-based licence compliance report (separate module under licensing; reads the licence audit and the drone
 * verification, writes nothing back to them).
 *
 * The idea is the one automated building-permit checking uses (rules written down as data, every rule answered per
 * object with the evidence it was answered from): here the object is a cadastral parcel and the rules are what a tea
 * licence implies about it. The licence audit gives one decision per parcel; this report shows which rule passed,
 * which did not, and on what evidence, with satellite, drone and field observation kept as separate rules.
 *
 * A rule fails only on evidence that can carry a finding: two records that contradict each other, a clear satellite
 * reading, or an observation a person has verified. Anything weaker (an unverified image reading, a small parcel on a
 * 10 m grid, a demo register) is `review`. The output is a preliminary assessment; it never decides.
 */
export const COMPLIANCE_RULES_CONFIG = {
    /** Accepted relative gap between the licensed area and the tea area the satellite detects. */
    areaTolerance: 0.25,
    /** Below this many whole 10 m pixels an area comparison says nothing. */
    areaMinPixels: 6,
    /** Accepted gap between the deed area and the area of the cadastral geometry. */
    deedAreaTolerance: 0.1,
    deedAreaMinGapM2: 20,
};

export type CheckStatus = 'pass' | 'fail' | 'review' | 'unknown' | 'na';
export type ComplianceOverall = 'conforming' | 'finding' | 'review' | 'no_evidence' | 'out_of_scope';
export type ComplianceCertainty = 'agreed' | 'single_source' | 'conflict' | 'undecidable';

/**
 * When does a parcel count as decided. Evidence thresholds, not accuracy estimates and not administrative criteria.
 * The class answers one question: do the independent sources at hand say the same thing about tea on this parcel.
 */
export const CERTAINTY_RULES = {
    /**
     * Whole 10 m pixels a satellite reading needs. Three is the audit's own floor (below it the grid cannot resolve the
     * parcel). The audit's caution threshold of six is not used here: agreement always needs a second source, and
     * asking for six alone left most parcels of this region (median 426 m²) without a reading.
     */
    satelliteMinPixels: 3,
    /** A majority tea cover and a clear model probability are both needed, as in the audit's strong reading. */
    satellitePresentShare: 0.6,
    satelliteMinProbability: 0.6,
    /** Absence needs almost no detected tea; intermediate readings cannot exclude sparse tea. */
    satelliteAbsentShare: 0.05,
    /** Sources are satellite, drone and field observation; any two that agree decide the parcel. */
    independentSourcesForAgreement: 2,
};
export type RuleSource = 'record' | 'satellite' | 'drone' | 'field' | 'buildings';

export interface ComplianceRule {
    id: string;
    title: string;
    /** What the rule expects, as one sentence. */
    expects: string;
    appliesTo: string;
    sources: RuleSource[];
    /** Whether a failed rule can stand as a finding, and on what evidence. */
    findingNeeds: string;
}

/** Draft rule set: the wording is ours; the articles of the tea legislation each rule rests on are to be matched with ÇAYKUR. */
export const COMPLIANCE_RULES: ComplianceRule[] = [
    { id: 'K1', title: 'Ruhsatlı parselin tapu niteliği çay içerir', expects: 'Ruhsat kaydı olan parselin tapu niteliğinde çay geçer.', appliesTo: 'Ruhsatlı parseller', sources: ['record'], findingNeeds: 'İki kayıt arasındaki uyuşmazlık doğrudan bulgudur (kayıt düzeltmesi önerilir).' },
    { id: 'K2', title: 'Ruhsatlı parselde çay vardır (uydu)', expects: 'Ruhsatlı parselde uydu tespiti çay gösterir.', appliesTo: 'Ruhsatlı parseller', sources: ['satellite'], findingNeeds: 'Yalnız net uydu okuması (orta ya da yüksek güven) bulgu olur; küçük parsel ve kararsız okuma incelemeye gider.' },
    { id: 'K3', title: 'Ruhsatlı parselde çay vardır (drone)', expects: 'Ruhsatlı parselde drone görüntüsü çay gösterir.', appliesTo: 'Drone görüntüsü olan ruhsatlı parseller', sources: ['drone'], findingNeeds: 'Yalnız uzman ya da saha tarafından doğrulanmış okuma bulgu olur; doğrulanmamış kare okuması incelemeye gider.' },
    { id: 'K4', title: 'Ruhsatsız parselde çay yetiştirilmez', expects: 'Ruhsat kaydı olmayan parselde çay tespit edilmez.', appliesTo: 'Ruhsatsız parseller', sources: ['record', 'satellite', 'drone'], findingNeeds: 'Gerçek ÇAYKUR ruhsat listesi ve net tespit gerekir; DEMO kayıtla bulgu üretilmez.' },
    { id: 'K5', title: 'Kamu arazisinde çay yoktur', expects: 'Niteliği orman, hazine ya da mera olan parselde çay tespit edilmez.', appliesTo: 'Kamu arazisi nitelikli parseller', sources: ['record', 'satellite', 'drone'], findingNeeds: 'Büyük parsellerde parsel geneli oran yanıltır; tespit her durumda incelemeye gider.' },
    { id: 'K6', title: 'Ruhsat alanı çay alanıyla uyumludur', expects: `Ruhsat alanı ile uyduda tespit edilen çay alanı arasındaki fark %${Math.round(COMPLIANCE_RULES_CONFIG.areaTolerance * 100)} içindedir.`, appliesTo: 'Çay tespit edilen ruhsatlı parseller', sources: ['record', 'satellite'], findingNeeds: '10 m piksel alan ölçmez: fark yalnız inceleme önerir, bulgu olmaz.' },
    { id: 'K7', title: 'Parseldeki yapı tapu niteliğinde yer alır', expects: 'Bina izi parselin içindeyse tapu niteliğinde yapı geçer.', appliesTo: 'Üzerinde bina izi olan parseller', sources: ['record', 'buildings'], findingNeeds: 'Açık bina verisi eksik ve kayık olabilir; yalnız inceleme önerir.' },
    { id: 'K8', title: 'Uydu ve drone okumaları aynı yöndedir', expects: 'İki bağımsız görüntü kaynağı parselde çay konusunda aynı sonucu verir.', appliesTo: 'Hem uydu hem drone okuması olan parseller', sources: ['satellite', 'drone'], findingNeeds: 'Kaynak çelişkisi bulgu değildir; hangisinin doğru olduğu yerinde belirlenir.' },
    { id: 'K9', title: 'Tapu alanı kadastro geometrisiyle uyumludur', expects: `Tapu alanı ile TKGM geometrisinin alanı arasındaki fark %${Math.round(COMPLIANCE_RULES_CONFIG.deedAreaTolerance * 100)} içindedir.`, appliesTo: 'Tapu alanı bilinen parseller', sources: ['record'], findingNeeds: 'Fark kayıt kontrolü önerir; bulgu olmaz.' },
    { id: 'K10', title: 'Saha gözlemi kayıtla uyumludur', expects: 'Yerinde yapılan gözlem, ruhsat kaydının söylediğini doğrular.', appliesTo: 'Saha gözlemi olan parseller', sources: ['field', 'record'], findingNeeds: 'Saha gözlemi en güçlü kanıttır; uyuşmazlık bulgudur.' },
];

export interface ComplianceCheck {
    rule: string;
    status: CheckStatus;
    /** The values the rule was answered from, in words. */
    evidence: string;
}
export interface ComplianceParcel {
    key: string;
    block: string;
    parcel: string;
    nature: string;
    locality: string;
    areaM2: number;
    licensed: boolean;
    overall: ComplianceOverall;
    certainty: ComplianceCertainty;
    certaintyReason: string;
    /** Rules that failed or went to review, worst first. */
    open: string[];
    checks: ComplianceCheck[];
    action: string;
}
export interface ComplianceFile {
    generatedAt: string;
    method: string;
    ruleset: { id: string; version: string; status: 'draft'; note: string; config: typeof COMPLIANCE_RULES_CONFIG; rules: ComplianceRule[] };
    licenceSource: 'demo' | 'caykur';
    certaintyConfig: typeof CERTAINTY_RULES;
    sources: { auditGeneratedAt: string; droneGeneratedAt: string | null; droneParcels: number };
    summary: { parcels: number; byOverall: Record<ComplianceOverall, number>; byCertainty: Record<ComplianceCertainty, { parcels: number; areaM2: number }>; byRule: Record<string, Record<CheckStatus, number>> };
    parcels: ComplianceParcel[];
}

const pct = (v: number | null) => (v === null ? '—' : `%${Math.round(v * 100)}`);
const DRONE_LABEL: Record<string, string> = { tea_present: 'çay mevcut', tea_not_found: 'çay bulunamadı', partial: 'kısmen çay mevcut', uncertain: 'belirsiz' };
const SAT_LABEL: Record<string, string> = { present: 'çay var', absent: 'çay yok', inconclusive: 'kararsız', not_assessable: 'değerlendirilemiyor' };

function checkParcel(p: AuditParcel, d: DroneVerificationParcel | null, licenceVerified: boolean): ComplianceCheck[] {
    const C = COMPLIANCE_RULES_CONFIG;
    const det = p.detection;
    const licensed = p.licence.licensed;
    const demo = p.licence.source === 'demo' ? ' (DEMO kayıt)' : '';
    const sat = `uydu: ${SAT_LABEL[det.tea] ?? det.tea}, parselin ${pct(det.teaShare)} kadarı, ${det.fullPixels} tam piksel, güven ${p.confidence === 'high' ? 'yüksek' : p.confidence === 'medium' ? 'orta' : 'düşük'}`;
    const clear = p.confidence !== 'low';
    const droneText = d ? `drone: ${DRONE_LABEL[d.class]} (${d.review ? (d.review.verified ? 'doğrulanmış inceleme' : 'doğrulanmamış kare okuması') : 'otomatik, deneysel'}, ${d.analysedAt})` : 'drone görüntüsü yok';
    const verified = d?.review?.verified === true;
    const out: ComplianceCheck[] = [];
    const add = (rule: string, status: CheckStatus, evidence: string) => out.push({ rule, status, evidence });

    // K1 record × record
    if (!licensed) add('K1', 'na', 'Ruhsat kaydı yok.');
    else add('K1', p.title.tea ? 'pass' : 'fail', `Tapu niteliği “${p.nature}”; ruhsat ${p.licence.codes.join(', ') || '—'}${demo}.`);

    // K2 licence × satellite
    if (!licensed) add('K2', 'na', 'Ruhsat kaydı yok.');
    else if (det.tea === 'present') add('K2', 'pass', sat);
    else if (det.tea === 'absent') add('K2', clear ? 'fail' : 'review', sat);
    else if (det.tea === 'inconclusive') add('K2', 'review', sat);
    else add('K2', 'unknown', `${sat}; parsel 10 m ızgara için küçük.`);

    // K3 licence × drone
    if (!licensed) add('K3', 'na', 'Ruhsat kaydı yok.');
    else if (!d) add('K3', 'unknown', 'Bu parseli kapsayan drone görüntüsü analiz edilmedi.');
    else if (d.class === 'tea_present') add('K3', 'pass', droneText);
    else if (d.class === 'tea_not_found') add('K3', verified ? 'fail' : 'review', droneText);
    else if (d.class === 'partial') add('K3', 'review', `${droneText}; parselin yalnız bir bölümünde çay görülüyor.`);
    else add('K3', 'unknown', droneText);

    // K4 no licence × ground
    const satTea = det.tea === 'present';
    const droneTea = d?.class === 'tea_present' || d?.class === 'partial';
    const noTea = det.tea === 'absent' && (!d || d.class === 'tea_not_found');
    if (licensed) add('K4', 'na', 'Parsel ruhsatlı.');
    else if (p.title.publicLand) add('K4', 'na', 'Kamu arazisi: K5 ile değerlendirilir.');
    else if (satTea || droneTea) {
        const strong = (satTea && clear) || (droneTea && verified);
        add('K4', licenceVerified && strong ? 'fail' : 'review', `${sat}; ${droneText}.${licenceVerified ? '' : ' Ruhsat kaydı DEMO: “ruhsatsız” bilgisi gerçek liste ile doğrulanmalı.'}`);
    } else if (noTea) add('K4', 'pass', `${sat}; ${droneText}.`);
    else add('K4', 'unknown', `${sat}; ${droneText}.`);

    // K5 public land
    if (!p.title.publicLand) add('K5', 'na', 'Tapu niteliği kamu arazisi değil.');
    else if (satTea || droneTea) add('K5', 'review', `Tapu niteliği “${p.nature}”; ${sat}; ${droneText}.`);
    else if (det.tea === 'absent') add('K5', 'pass', `Tapu niteliği “${p.nature}”; ${sat}.`);
    else add('K5', 'unknown', `Tapu niteliği “${p.nature}”; ${sat}.`);

    // K6 licensed area × detected area
    if (!licensed || !p.licence.areaM2) add('K6', 'na', 'Ruhsat alanı yok.');
    else if (det.tea !== 'present' || det.teaAreaM2 === null) add('K6', 'na', 'Uyduda çay alanı tespit edilmedi; K2 ile değerlendirilir.');
    else if (det.fullPixels < C.areaMinPixels) add('K6', 'unknown', `Parsel ${det.fullPixels} tam piksel: alan karşılaştırması için küçük.`);
    else {
        const gap = (det.teaAreaM2 - p.licence.areaM2) / p.licence.areaM2;
        add('K6', Math.abs(gap) <= C.areaTolerance ? 'pass' : 'review', `Ruhsat alanı ${Math.round(p.licence.areaM2)} m²${demo}; uyduda çay ≈ ${Math.round(det.teaAreaM2)} m² (fark ${gap > 0 ? '+' : ''}${Math.round(gap * 100)} %).`);
    }

    // K7 building × title
    if (p.building.state === 'unknown') add('K7', 'unknown', 'Bu alan için bina verisi yok.');
    else if (p.building.state !== 'inside') add('K7', 'na', 'Parselin içinde bina izi yok.');
    else add('K7', p.title.building ? 'pass' : 'review', `Parselin içinde ${p.building.count} bina izi (${Math.round(p.building.insideM2)} m², ${p.building.source}); tapu niteliği “${p.nature}”.`);

    // K8 satellite × drone
    if (!d || d.class === 'uncertain' || det.tea === 'inconclusive' || det.tea === 'not_assessable') add('K8', !d ? 'na' : 'unknown', !d ? 'Drone görüntüsü yok.' : `${sat}; ${droneText}.`);
    else {
        const agree = (det.tea === 'present' && d.class === 'tea_present') || (det.tea === 'absent' && d.class === 'tea_not_found');
        add('K8', agree ? 'pass' : 'review', `${sat}; ${droneText}.`);
    }

    // K9 deed area × geometry
    if (p.deedAreaM2 === null) add('K9', 'unknown', 'Tapu alanı bilinmiyor.');
    else {
        const gap = p.areaM2 - p.deedAreaM2;
        const ok = Math.abs(gap) <= Math.max(p.deedAreaM2 * C.deedAreaTolerance, C.deedAreaMinGapM2);
        add('K9', ok ? 'pass' : 'review', `Tapu alanı ${Math.round(p.deedAreaM2)} m²; geometri alanı ${Math.round(p.areaM2)} m².`);
    }

    // K10 field observation × record
    const f = p.confirmation;
    if (!f || f.tea === null) add('K10', 'na', 'Saha gözlemi yok.');
    else add('K10', f.tea === licensed ? 'pass' : 'fail', `Saha gözlemi: ${f.tea ? (f.sparse ? 'çay var, seyrek' : 'çay var') : 'çay yok'} (${f.source}, ${f.date}); kayıt: ${licensed ? `ruhsatlı${demo}` : 'ruhsatsız'}.`);
    return out;
}

const ACTIONS: Record<string, string> = {
    K1: 'Tapu niteliği ile ruhsat kaydı karşılaştırılmalı (kayıt düzeltmesi).',
    K2: 'Ruhsatlı parselde çay görülmüyor: yerinde kontrol önerilir.',
    K3: 'Drone görüntüsünde çay görülmüyor ya da kısmen görülüyor: yerinde kontrol önerilir.',
    K4: 'Ruhsat kaydı olmayan parselde çay görülüyor: ruhsat listesi ve yerinde kontrol ile doğrulanmalı.',
    K5: 'Kamu arazisinde çay görülüyor: yerinde kontrol önerilir.',
    K6: 'Ruhsat alanı ile çay alanı farklı: alan yerinde ya da ölçülü ortofoto ile belirlenmeli.',
    K7: 'Parselde tapu niteliğinde olmayan yapı izi var: kayıt kontrolü önerilir.',
    K8: 'Uydu ve drone okumaları çelişiyor: yerinde kontrol önerilir.',
    K9: 'Tapu alanı ile kadastro geometrisi farklı: kayıt kontrolü önerilir.',
    K10: 'Saha gözlemi kayıtla uyuşmuyor: kayıt güncellenmeli.',
};

/** Read raw imagery only: audit confidence may have been raised by a field observation. */
function clearSatellite(p: AuditParcel): boolean | null {
    const d = p.detection;
    const r = CERTAINTY_RULES;
    if (d.fullPixels < r.satelliteMinPixels || d.beyondTraining || d.teaShare === null) return null;
    if (d.tea === 'present' && d.teaShare >= r.satellitePresentShare && (d.teaProbability ?? 0) >= r.satelliteMinProbability) return true;
    if (d.tea === 'absent' && d.teaShare < r.satelliteAbsentShare) return false;
    return null;
}

/** A partial/uncertain or unusable automatic reading does not describe the whole parcel clearly. */
function clearDrone(d: DroneVerificationParcel | null): boolean | null {
    if (!d || d.confidence === 'low' || (d.classSource === 'automatic' && !d.automatic.usable)) return null;
    return d.class === 'tea_present' ? true : d.class === 'tea_not_found' ? false : null;
}

/**
 * Agreement class of a parcel.
 *
 * What counts as a conflict is kept narrow on purpose, so the class shows real contradictions and nothing else:
 *   - two sources that read the ground differently (satellite, drone, field observation);
 *   - a clear ground reading against the deed title;
 *   - against the licence register, only when the register is the real one. A DEMO register is generated data: it
 *     cannot contradict anything, and comparing it made 155 of 542 parcels "conflict" in the pilot;
 *   - tea seen on public land (K5).
 * Area gaps from 10 m pixels (K6), open building footprints (K7) and deed-area gaps (K9) are review notes of their own
 * rules; they say nothing about whether the sources agree on tea, so they neither make a conflict nor block agreement.
 */
export function classifyCertainty(p: AuditParcel, d: DroneVerificationParcel | null, checks: ComplianceCheck[], licenceVerified: boolean): Pick<ComplianceParcel, 'certainty' | 'certaintyReason'> {
    const named: Array<[string, boolean | null]> = [['uydu', clearSatellite(p)], ['drone', clearDrone(d)], ['saha gözlemi', p.confirmation?.tea ?? null]];
    const sources = named.filter((x): x is [string, boolean] => x[1] !== null);
    const names = sources.map((x) => x[0]).join(' + ');
    const demoNote = licenceVerified ? '' : ' Ruhsat kaydı DEMO olduğu için karşılaştırmaya girmedi.';
    const open = (rules: string[]) => checks.filter((c) => rules.includes(c.rule) && (c.status === 'fail' || c.status === 'review')).map((c) => c.rule);

    const groundSplit = sources.some((x) => x[1] !== sources[0]?.[1]);
    const ground = sources.length && !groundSplit ? (sources[0] as [string, boolean])[1] : null;
    const againstTitle = ground !== null && ground !== p.title.tea;
    const againstLicence = licenceVerified && ((ground !== null && ground !== p.licence.licensed) || p.title.tea !== p.licence.licensed);
    const publicLand = open(['K5']);
    if (groundSplit || againstTitle || againstLicence || publicLand.length) {
        const why = groundSplit
            ? `${sources.map((x) => `${x[0]}: ${x[1] ? 'çay var' : 'çay yok'}`).join(', ')}`
            : againstTitle
              ? `${names} ${ground ? 'çay gösteriyor' : 'çay göstermiyor'}, tapu niteliği “${p.nature}”`
              : againstLicence
                ? `ruhsat kaydı ${p.licence.licensed ? 'var' : 'yok'}, ${ground === null ? `tapu niteliği “${p.nature}”` : `${names} ${ground ? 'çay gösteriyor' : 'çay göstermiyor'}`}`
                : 'kamu arazisinde çay görülüyor (K5)';
        return { certainty: 'conflict', certaintyReason: `Kaynaklar çelişiyor: ${why}.${demoNote}` };
    }
    if (sources.length === 0) return { certainty: 'undecidable', certaintyReason: `Net okuma veren kaynak yok (küçük parsel, kararsız uydu, eksik ya da belirsiz drone); karar verilemedi.${demoNote}` };
    if (sources.length < CERTAINTY_RULES.independentSourcesForAgreement) return { certainty: 'single_source', certaintyReason: `Yalnız ${names} net okunuyor ve tapu niteliğiyle çelişmiyor; ikinci bağımsız kaynak yok.${demoNote}` };
    return { certainty: 'agreed', certaintyReason: `${names} aynı yönde (${ground ? 'çay var' : 'çay yok'}) ve tapu niteliğiyle${licenceVerified ? ', ruhsat kaydıyla' : ''} tutarlı. Kaynaklar uyumlu; ön değerlendirmedir, idari karar değildir.${demoNote}` };
}

export function buildCompliance(audit: AuditFile, drone: DroneVerificationFile | null): ComplianceFile {
    const byKey = new Map((drone?.parcels ?? []).map((d) => [d.key, d]));
    const licenceVerified = audit.licenceSource === 'caykur';
    const order: CheckStatus[] = ['fail', 'review'];
    const parcels: ComplianceParcel[] = audit.parcels.map((p) => {
        const checks = checkParcel(p, byKey.get(p.key) ?? null, licenceVerified);
        const has = (s: CheckStatus) => checks.some((c) => c.status === s);
        // Nothing to do with tea: no licence, no tea title, no tea seen anywhere.
        const teaRelated = p.licence.licensed || p.title.tea || checks.some((c) => ['K4', 'K5'].includes(c.rule) && c.status === 'review');
        const overall: ComplianceOverall = has('fail') ? 'finding' : !teaRelated && !has('review') ? 'out_of_scope' : has('review') ? 'review' : ['K2', 'K3', 'K4', 'K10'].some((r) => checks.find((c) => c.rule === r)?.status === 'pass') ? 'conforming' : 'no_evidence';
        const open = checks.filter((c) => order.includes(c.status)).sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status)).map((c) => c.rule);
        const action = open.length ? ACTIONS[open[0] as string] ?? '' : overall === 'no_evidence' ? 'Çay varlığı için yeterli kanıt yok: drone görüntüsü ya da yerinde kontrol ile tamamlanmalı.' : 'İşlem gerekmiyor.';
        return { key: p.key, block: p.block, parcel: p.parcel, nature: p.nature, locality: p.locality, areaM2: p.areaM2, licensed: p.licence.licensed, overall, ...classifyCertainty(p, byKey.get(p.key) ?? null, checks, licenceVerified), open, checks, action };
    });
    const byOverall: Record<ComplianceOverall, number> = { conforming: 0, finding: 0, review: 0, no_evidence: 0, out_of_scope: 0 };
    const byCertainty: ComplianceFile['summary']['byCertainty'] = { agreed: { parcels: 0, areaM2: 0 }, single_source: { parcels: 0, areaM2: 0 }, conflict: { parcels: 0, areaM2: 0 }, undecidable: { parcels: 0, areaM2: 0 } };
    const byRule: Record<string, Record<CheckStatus, number>> = Object.fromEntries(COMPLIANCE_RULES.map((r) => [r.id, { pass: 0, fail: 0, review: 0, unknown: 0, na: 0 }]));
    for (const p of parcels) {
        byOverall[p.overall]++;
        byCertainty[p.certainty].parcels++;
        byCertainty[p.certainty].areaM2 += p.areaM2;
        for (const c of p.checks) (byRule[c.rule] as Record<CheckStatus, number>)[c.status]++;
    }
    return {
        generatedAt: new Date().toISOString(),
        method: 'Her parsel, yazılı kurallara karşı tek tek sınanır; her kuralın sonucu dayandığı kanıtla birlikte verilir. Kural yalnız bulgu taşıyabilecek kanıtla “aykırı” olur (çelişen iki kayıt, net uydu okuması, doğrulanmış gözlem); daha zayıf kanıt incelemeye gider. Sonuç ön değerlendirmedir, idari karar üretmez.',
        ruleset: { id: 'cay-ruhsat-uygunluk', version: '0.1', status: 'draft', note: 'Taslak kural seti: kural metinleri denetim mantığını yazar; dayandıkları mevzuat maddeleri ÇAYKUR ile eşleştirilmelidir.', config: COMPLIANCE_RULES_CONFIG, rules: COMPLIANCE_RULES },
        licenceSource: audit.licenceSource,
        certaintyConfig: CERTAINTY_RULES,
        sources: { auditGeneratedAt: audit.generatedAt, droneGeneratedAt: drone?.generatedAt ?? null, droneParcels: drone?.parcels.length ?? 0 },
        summary: { parcels: parcels.length, byOverall, byCertainty, byRule },
        parcels,
    };
}
