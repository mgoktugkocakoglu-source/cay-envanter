import { isTeaTitle } from '../tkgm/titles.ts';

/**
 * Licence audit decision: three independent sources per cadastral parcel —
 *   T  the deed title (TKGM "nitelik") says tea,
 *   L  the parcel is in ÇAYKUR's register of licensed tea gardens,
 *   D  tea is detected on the ground (title-independent satellite evidence, or an expert's confirmation) —
 * give one of eight combinations. Three of them are the decisions the audit exists for (tea land, licensing error,
 * unlicensed tea); the other five are named too, so that no parcel falls through.
 *
 * The rule is asymmetric, as in the EU "checks by monitoring" traffic light: a finding against someone (licensing
 * error, unlicensed tea, licence without tea) needs conclusive evidence; when the detection is inconclusive, the
 * parcel too small for the 10 m grid, or the evidence weak, the parcel goes to review with the decision it leans to.
 * The output is a flag for an expert, never a legal verdict.
 */
export const AUDIT_RULES = {
    /** Tea is present when at least this share of the parcel is tea. */
    teaPresentShare: 0.3,
    /**
     * Above this parcel area a tea garden is a pocket in the parcel (forest and treasury parcels of hundreds of
     * hectares): the parcel-wide share cannot say "no tea", and at the detector's false-alarm rate on forest an
     * absolute area cannot say "tea" either. Such parcels are inconclusive unless tea covers them.
     */
    largeParcelM2: 20_000,
    /** Tea is absent below this share (and below `teaAbsentMaxM2`). Between the two the detection is inconclusive. */
    teaAbsentShare: 0.1,
    teaAbsentMaxM2: 300,
    /** Strong evidence: most of the parcel and a clear mean probability. */
    strongShare: 0.6,
    strongProbability: 0.6,
    /**
     * Parcel size in Sentinel-2 pixels (area / 100 m²). The EU rule (8 whole pixels after a 5 m inner buffer) would
     * leave almost no parcel here (median 426 m²), so every parcel is read, as Slovenia does, and size sets the
     * confidence: below `minPixels` the grid cannot resolve the parcel, below `fewPixels` edges dominate it.
     */
    minPixels: 3,
    fewPixels: 6,
    /** Tea is clearly absent below this share (needed for a finding of absence; the detector misses ~12 % of tea pixels). */
    clearlyAbsentShare: 0.05,
    /** Accepted relative gap between detected tea and licensed area before an area flag is raised. */
    areaTolerance: 0.25,
    /** A building footprint counts as on the parcel with at least this much of it inside, as on the boundary within this distance. */
    buildingInsideM2: 15,
    buildingNearM: 5,
};

export type TeaState = 'present' | 'absent' | 'inconclusive' | 'not_assessable';
export type BuildingState = 'inside' | 'boundary' | 'none' | 'unknown';
export type Confidence = 'high' | 'medium' | 'low';
export type AuditDecision =
    | 'tea_land' // T L D   — tea land (title, licence and ground agree)
    | 'licensing_error' // ¬T L ¬D — licensed, but neither the title nor the ground shows tea
    | 'unlicensed_tea' // ¬T ¬L D — tea on the ground, no licence, title says something else
    | 'unlicensed_tea_titled' // T ¬L D  — tea in the title and on the ground, no licence
    | 'licence_no_tea' // T L ¬D  — title and licence say tea, none on the ground
    | 'title_outdated' // ¬T L D  — licensed tea on the ground, the title was never updated
    | 'title_only' // T ¬L ¬D — only the title says tea
    | 'out_of_scope' // ¬T ¬L ¬D — nothing to do with tea
    | 'needs_review'; // detection inconclusive / not assessable / too weak for a finding
export type AuditFlag = 'area_over' | 'area_under' | 'building_not_in_title' | 'title_building_not_seen' | 'public_land' | 'beyond_training' | 'small_parcel' | 'detectors_disagree' | 'expert_confirmed' | 'licence_unverified' | 'large_parcel';

/** What the free-text deed title says, component by component ("Ahşap Ev Ve Çayır" = building + meadow). */
export interface TitleReading {
    tea: boolean;
    building: boolean;
    publicLand: boolean;
    uses: Array<'tea' | 'meadow' | 'hazelnut' | 'field' | 'forest' | 'orchard' | 'building' | 'yard' | 'cemetery' | 'other'>;
}
export function readTitle(nature: string): TitleReading {
    const t = nature.trim().toLocaleLowerCase('tr');
    const uses: TitleReading['uses'] = [];
    const tea = isTeaTitle(t);
    const building = /\b(ev|evi|bina|binası|kargir|ahşap|yığma|okul|okulu|cami|camii|dükkan|fabrika|depo|ahır|samanlık|mesken)\b/.test(t);
    if (tea) uses.push('tea');
    if (/çayır|mera|otlak|yayla/.test(t)) uses.push('meadow');
    if (/fındık/.test(t)) uses.push('hazelnut');
    if (/tarla|sebze/.test(t)) uses.push('field');
    if (/orman|koru|ağaçlık|fundalık/.test(t)) uses.push('forest');
    if (/bağ|meyve|kivi|kestane|narenciye/.test(t)) uses.push('orchard');
    if (building) uses.push('building');
    if (/avlu|arsa|bahçesi/.test(t) && !tea && !/fındık/.test(t)) uses.push('yard');
    if (/mezar/.test(t)) uses.push('cemetery');
    if (uses.length === 0) uses.push('other');
    return { tea, building, publicLand: /^(orman|hazine|mera|2b)/.test(t), uses };
}

export interface DecisionInput {
    title: TitleReading;
    licensed: boolean;
    licensedAreaM2: number | null;
    /** False when the register at hand does not cover this parcel (demo register): "no licence" is then unverified. */
    licenceVerified: boolean;
    parcelAreaM2: number;
    tea: { state: TeaState; share: number | null; areaM2: number | null; probability: number | null; fullPixels: number; beyondTraining: boolean; inventoryShare: number | null; confirmed: boolean | null; sparse?: boolean };
    building: BuildingState;
}
export interface DecisionResult {
    decision: AuditDecision;
    /** What the parcel would be if the detection were taken at face value (equals `decision` unless it is in review). */
    leaning: Exclude<AuditDecision, 'needs_review'>;
    confidence: Confidence;
    flags: AuditFlag[];
    consistency: { tea: 'match' | 'title_only' | 'ground_only' | 'unknown'; building: 'match' | 'title_only' | 'ground_only' | 'unknown' };
}

export function teaStateOf(share: number | null, areaM2: number | null, fullPixels: number, parcelAreaM2: number): TeaState {
    const R = AUDIT_RULES;
    if (share === null || fullPixels < R.minPixels) return 'not_assessable';
    const area = areaM2 ?? 0;
    if (share >= R.teaPresentShare) return 'present';
    if (parcelAreaM2 >= R.largeParcelM2) return 'inconclusive';
    if (share < R.teaAbsentShare && area < R.teaAbsentMaxM2) return 'absent';
    return 'inconclusive';
}

const TABLE: Record<string, Exclude<AuditDecision, 'needs_review'>> = {
    '111': 'tea_land',
    '010': 'licensing_error',
    '001': 'unlicensed_tea',
    '101': 'unlicensed_tea_titled',
    '110': 'licence_no_tea',
    '011': 'title_outdated',
    '100': 'title_only',
    '000': 'out_of_scope',
};
/** Findings against someone: they need conclusive evidence. */
const FINDINGS: AuditDecision[] = ['licensing_error', 'unlicensed_tea', 'unlicensed_tea_titled', 'licence_no_tea'];

export function decide(input: DecisionInput): DecisionResult {
    const R = AUDIT_RULES;
    const { title, tea } = input;
    const flags: AuditFlag[] = [];
    // An expert's confirmation of the ground stands above the satellite reading.
    const state: TeaState = tea.confirmed === true ? 'present' : tea.confirmed === false ? 'absent' : tea.state;
    if (tea.confirmed !== null) flags.push('expert_confirmed');
    // Inconclusive readings lean to the side the numbers are nearer to.
    // A parcel with no reading at all (too small for the grid) leans to its title: nothing was seen against it, and
    // "no reading" must not turn into "no tea". The demo register is built with the same rule.
    const detected = state === 'present' || ((state === 'inconclusive' || state === 'not_assessable') && (tea.share === null ? title.tea : tea.share >= (R.teaPresentShare + R.teaAbsentShare) / 2));
    const leaning = TABLE[`${title.tea ? 1 : 0}${input.licensed ? 1 : 0}${detected ? 1 : 0}`] as Exclude<AuditDecision, 'needs_review'>;

    // Clear evidence: most of the parcel with a clear probability (presence), or next to nothing (absence).
    const clear = state === 'present' ? (tea.share ?? 0) >= R.strongShare && (tea.probability ?? 0) >= R.strongProbability : state === 'absent' && (tea.share ?? 1) < R.clearlyAbsentShare;
    const disagree = tea.inventoryShare !== null && tea.share !== null && (tea.inventoryShare >= R.teaPresentShare) !== (tea.share >= R.teaPresentShare);
    const small = tea.fullPixels < R.fewPixels;
    if (disagree) flags.push('detectors_disagree');
    if (tea.beyondTraining) flags.push('beyond_training');
    if (small) flags.push('small_parcel');
    if (input.parcelAreaM2 >= R.largeParcelM2 && tea.confirmed === null && state !== 'present') flags.push('large_parcel');
    if (!input.licensed && !input.licenceVerified) flags.push('licence_unverified');
    // High = clear evidence and nothing against it; medium = clear evidence with one caveat; low = everything else.
    const caveats = (small ? 1 : 0) + (tea.beyondTraining ? 1 : 0) + (disagree ? 1 : 0);
    let confidence: Confidence;
    if (tea.confirmed !== null) confidence = 'high';
    else if (!clear) confidence = 'low';
    else confidence = caveats === 0 ? 'high' : caveats === 1 ? 'medium' : 'low';

    // A finding against someone needs at least medium confidence; anything else stands with the benefit of the doubt.
    const decision: AuditDecision = FINDINGS.includes(leaning) && confidence === 'low' ? 'needs_review' : leaning;

    if (title.publicLand && detected && !input.licensed) flags.push('public_land');
    if (input.licensed && input.licensedAreaM2 && tea.areaM2 !== null && state === 'present') {
        const gap = (tea.areaM2 - input.licensedAreaM2) / input.licensedAreaM2;
        if (gap < -R.areaTolerance) flags.push('area_over');
        if (gap > R.areaTolerance) flags.push('area_under');
    }
    const seen = input.building === 'inside' || input.building === 'boundary';
    if (input.building !== 'unknown') {
        if (input.building === 'inside' && !title.building) flags.push('building_not_in_title');
        // A missing footprint is weak evidence: small houses under trees are often not in the free datasets.
        if (title.building && !seen) flags.push('title_building_not_seen');
    }
    return {
        decision,
        leaning,
        confidence,
        flags,
        consistency: {
            tea: state === 'inconclusive' || state === 'not_assessable' ? 'unknown' : title.tea === (state === 'present') ? 'match' : title.tea ? 'title_only' : 'ground_only',
            building: input.building === 'unknown' ? 'unknown' : title.building === seen ? 'match' : title.building ? 'title_only' : 'ground_only',
        },
    };
}
