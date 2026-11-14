/**
 * Drone-supported land verification (separate module under licensing).
 *
 * The record (deed title, licence register) says what a parcel should be; drone imagery says what is on it.
 * This module binds the two per parcel and keeps the evidence: which source, which frames, which time range,
 * how the outline was obtained, what the automatic analysis and a human reading each say, and how far either
 * can be trusted. Nothing here is an administrative decision: a mismatch only asks for a field check.
 *
 * Sources are typed so that the same record carries today's ordinary video and tomorrow's survey flights:
 *   video        — frames only; no coordinates, no scale → outlines are drawings on a frame
 *   orthophoto   — photogrammetry; with RTK/PPK the cadastre can be laid over it to a few centimetres
 *   point_cloud  — LiDAR; ground model and canopy height (shape, not species)
 *   multispectral— reflectance bands; the layer a validated tea classifier would use
 * RTK improves WHERE a pixel is, LiDAR gives 3D shape; neither says WHAT grows there. That needs imagery
 * with enough detail and a classifier checked against field truth.
 */
export type DroneSourceKind = 'video' | 'orthophoto' | 'point_cloud' | 'multispectral' | 'surface_model';
/** How the source is tied to the ground: none → approximate (hand-fitted) → gnss (metres) → rtk_ppk (centimetres). */
export type Georeference = 'none' | 'approximate' | 'gnss' | 'rtk_ppk';
/** Where a parcel outline on the imagery comes from. Only `cadastre` outlines can carry areas. */
export type OutlineKind = 'hand_drawn' | 'cadastre';
export type DroneClass = 'tea_present' | 'tea_not_found' | 'partial' | 'uncertain';
export type DroneStatus = 'consistent' | 'needs_review' | 'not_analysed';
export type DroneConfidence = 'high' | 'medium' | 'low';

export const DRONE_RULES = {
    /** The automatic classifier colours the map only when its cross-frame test reaches both of these. */
    usableTeaRecall: 0.85,
    usableTeaPrecision: 0.85,
};

export interface DroneSource {
    id: string;
    title: string;
    kind: DroneSourceKind;
    georeference: Georeference;
    capturedAt: string;
    capturedAtNote: string;
    origin: string;
    /** Filled by survey flights; null for an ordinary video. */
    platform: string | null;
    sensor: string | null;
    groundSampleCm: number | null;
    horizontalAccuracyCm: number | null;
}

export interface DroneFrame {
    t: number;
    isReference: boolean;
    pixels: number;
    inliers: number | null;
    sharpness: number;
    shares: Record<string, number>;
    frame: string;
    classes: string;
}

export interface DroneAnalysisParcel {
    parcel: string;
    hypothesis: string | null;
    class: DroneClass;
    confidence: DroneConfidence;
    teaShareMedian: number;
    teaShareSpread: number;
    otherShares: Record<string, number>;
    match: { t: number; inliers: number; keypoints: number };
    visible: [number, number];
    trackedFrames: number;
    frames: DroneFrame[];
    /** Outline per tracked instant (video seconds), for drawing it over the playing clip. */
    track: Array<{ t: number; polygon: Array<[number, number]> }>;
    outline: { t: number; frame: [number, number]; polygon: Array<[number, number]>; reference: string; kind: OutlineKind };
}
/** The part of the video the parcels are on, re-encoded for the site; `start` is its offset in the source video. */
export type DroneClip = { file: string; start: number; end: number; width: number; height: number; bytes: number };
export interface DroneCapture {
    width: number;
    height: number;
    fps: number;
    durationS: number;
    bitrateMbps: number;
    shot: [number, number];
    sharpnessMedian: number;
    shiftPerSecondShare: number | null;
    overlapAtOneSecond: number | null;
    hasFlightLog: boolean;
    hasCameraCalibration: boolean;
    georeference: Georeference;
}
export interface DroneValidation {
    method: string;
    classes: string[];
    frames: number[];
    pixels: number;
    accuracy: number;
    teaRecall: number;
    teaPrecision: number;
    confusion: number[][];
    trainingRectangles: Record<string, number>;
    referenceAreas: Array<{ t: number; label: string; rect: number[]; teaShare: number }>;
    referenceTeaRange: [number, number, number] | null;
    referenceOtherRange: [number, number, number] | null;
    transfer: { frames: number[]; pixels: number; accuracy: number; teaRecall: number; teaPrecision: number; confusion: number[][]; note: string } | null;
    topFeatures: Array<{ feature: string; importance: number }>;
}
/** Output of py/drone_verify.py. */
export interface DroneAnalysisFile {
    project: { id: string; title: string; province: string; district: string; neighborhood: string; capturedAt: string; capturedAtNote: string; source: { kind: DroneSourceKind; file: string; origin: string; georeference: Georeference }; trainingNote: string };
    rules: Record<string, number>;
    capture: DroneCapture;
    clip: DroneClip | null;
    validation: DroneValidation;
    parcels: DroneAnalysisParcel[];
}
/**
 * Approximate tie of a video to the map: camera poses solved from the video itself (structure from motion), the model
 * placed on the map by matching marked buildings to mapped footprints. Metres, not centimetres; no areas.
 */
export interface DroneGeoreferenceSummary {
    method: string;
    model: { frames: number; points: number; reprojectionErrorPx: number; shot: [number, number]; meanRollDeg: number };
    controls: Array<{ building: string; target: string; residualM: number }>;
    markedBuildings: number;
    rmsM: number;
    maxResidualM: number;
    scaleMPerUnit: number;
    referenceT: number;
    referenceImage: string;
    /** Parcels whose projected outline lies fully inside the reference frame. */
    parcelsInView: string[];
}
/** Output of py/drone_georef.py. */
export interface DroneGeorefFile extends DroneGeoreferenceSummary {
    parcels: Record<string, { handOverlap: { iou: number; handInsideCadastre: number; cadastreInsideHand: number }; track: Array<{ t: number; polygon: Array<[number, number]> }> }>;
}

/** A person's (or an assistant's) reading of the frames. `verified` is true only after an expert or a field visit. */
export interface DroneReview {
    parcel: string;
    class: DroneClass;
    observer: string;
    verified: boolean;
    date: string;
    frames: number[];
    note: string;
}

/** What the record and the satellite say about the parcel, taken from the licence audit. */
export interface DroneParcelRecord {
    key: string;
    block: string;
    parcel: string;
    nature: string;
    locality: string;
    areaM2: number;
    deedAreaM2: number | null;
    titleTea: boolean;
    licence: { licensed: boolean; areaM2: number | null; codes: string[]; source: 'demo' | 'caykur' | 'none' };
    satellite: { tea: string; teaShare: number | null; fullPixels: number } | null;
}

export interface DroneVerificationParcel extends DroneParcelRecord {
    sourceId: string;
    analysedAt: string;
    /** The class shown on the map, and where it comes from. */
    class: DroneClass;
    classSource: 'review' | 'automatic';
    confidence: DroneConfidence;
    automatic: { class: DroneClass; confidence: DroneConfidence; usable: boolean; teaShareMedian: number; teaShareSpread: number; otherShares: Record<string, number> };
    review: DroneReview | null;
    hypothesis: string | null;
    status: DroneStatus;
    discrepancy: string | null;
    action: string;
    video: { visible: [number, number]; trackedFrames: number; match: { t: number; inliers: number; keypoints: number } };
    outline: DroneAnalysisParcel['outline'];
    frames: DroneFrame[];
    track: DroneAnalysisParcel['track'];
    /** TKGM outline projected into the video through the approximate georeference; empty without one. */
    cadastreTrack: Array<{ t: number; polygon: Array<[number, number]> }>;
    /** Overlap of the hand-drawn outline with the projected cadastre on the reference frame (shares of pixel area). */
    handOverlap: { iou: number; handInsideCadastre: number; cadastreInsideHand: number } | null;
    notes: string[];
}

export interface DroneVerificationFile {
    generatedAt: string;
    method: string;
    rules: typeof DRONE_RULES & Record<string, number>;
    sources: DroneSource[];
    capture: DroneCapture;
    clip: DroneClip | null;
    georeference: DroneGeoreferenceSummary | null;
    /** What this source can and cannot support, in plain statements. */
    suitability: Array<{ topic: string; verdict: 'ok' | 'limited' | 'no'; text: string }>;
    validation: DroneValidation & { usable: boolean };
    licenceSource: 'demo' | 'caykur';
    /** Base path of the evidence images on the site. */
    imageryBaseUrl: string;
    parcels: DroneVerificationParcel[];
}

const CLASS_LABEL: Record<DroneClass, string> = { tea_present: 'çay mevcut', tea_not_found: 'çay bulunamadı', partial: 'kısmen çay mevcut', uncertain: 'belirsiz' };
const pct = (v: number) => `%${Math.round(v * 100)}`;

export function suitabilityOf(c: DroneCapture, v: DroneValidation, usable: boolean, g: DroneGeoreferenceSummary | null = null): DroneVerificationFile['suitability'] {
    return [
        { topic: 'Parselin videoda bulunması', verdict: 'ok', text: 'İşaretli görseller videodaki kareyle yüzlerce ortak noktadan eşleşiyor; parsel çekim boyunca kareden kareye izlenebiliyor.' },
        { topic: 'Bitki örtüsünün gözle okunması', verdict: 'limited', text: `${c.width}×${c.height} piksel ve ${c.bitrateMbps} Mb/sn sıkıştırma ile çay sıraları ve ağaç/çalı ayrımı seçiliyor; yaprak dokusu seçilmiyor. Ağaç altındaki seyrek çay dışlanamaz.` },
        {
            topic: 'Otomatik çay sınıflandırması',
            verdict: usable ? 'ok' : 'limited',
            text: `Aynı çekimin kareleri arasında sınamada doğruluk ${pct(v.accuracy)}, çay yakalama ${pct(v.teaRecall)}, çay kesinliği ${pct(v.teaPrecision)}${v.transfer ? `; başka çekimlere aktarımda doğruluk ${pct(v.transfer.accuracy)}, çay yakalama ${pct(v.transfer.teaRecall)}` : ''}. ${usable ? 'Eşik karşılanıyor.' : `Eşik (${pct(DRONE_RULES.usableTeaRecall)} / ${pct(DRONE_RULES.usableTeaPrecision)}) karşılanmıyor: otomatik sonuç deneysel gösterilir, haritayı renklendirmez.`} Etiketler gözle konuldu; saha doğrulaması yok.`,
        },
        g
            ? {
                  topic: 'Koordinat ve kadastro sınırı',
                  verdict: 'limited' as const,
                  text: `Uçuş kaydı yok; kamera konumları videonun kendisinden çözüldü (${g.model.frames} kare, ${g.model.points.toLocaleString('tr-TR')} 3B nokta, ${g.model.reprojectionErrorPx} piksel hata) ve model ${g.controls.length} binanın harita üzerindeki iziyle haritaya bağlandı. Kontrol binalarında ortalama hata ${g.rmsM} m, en büyük ${g.maxResidualM} m. TKGM sınırı bu doğrulukla videoya bindirilir: hangi parselin nerede göründüğünü gösterir, sınır tespiti ya da ölçüm için yeterli değildir.`,
              }
            : { topic: 'Koordinat ve kadastro sınırı', verdict: 'no' as const, text: 'Uçuş kaydı, kamera konumu ve kalibrasyon yok: kareye koordinat verilemez, kadastro sınırı kareye oturtulamaz. Karedeki çizgi işaretleyenin çizimidir, parsel sınırı değildir.' },
        { topic: 'Alan ölçümü', verdict: 'no', text: 'Eğik bakışlı, ölçeksiz kareden m² üretilemez. Alan için tapu alanı ve TKGM geometrisi geçerlidir.' },
        {
            topic: 'Fotogrametri (ortofoto / 3B model)',
            verdict: 'no',
            text: `Ardışık kareler arası örtüşme yüksek (${c.overlapAtOneSecond === null ? '—' : pct(c.overlapAtOneSecond)} / sn), ama çekim tek geçişli gezinti: yan bindirme yok, bakış açısı sürekli değişiyor, çözünürlük ve sıkıştırma düşük, konum verisi yok. Bu videodan görsel bir 3B model denenebilir; ölçülebilir ortofoto ya da güvenilir 3B ölçüm çıkmaz. Ölçülü ürün için ızgara planlı, %75–80 bindirmeli, RTK/PPK konumlu ham fotoğraf gerekir.`,
        },
    ];
}

/** Binds the analysis, the reviews and the parcel records into the verification file. */
export function buildDroneVerification(input: { analysis: DroneAnalysisFile; georef: DroneGeorefFile | null; reviews: DroneReview[]; records: DroneParcelRecord[]; licenceSource: 'demo' | 'caykur'; imageryBaseUrl: string; analysedAt: string }): DroneVerificationFile {
    const { analysis, reviews, records, georef } = input;
    const georeference: DroneGeoreferenceSummary | null = georef ? (({ parcels: _parcels, ...rest }) => rest)(georef) : null;
    const v = analysis.validation;
    const usable = v.teaRecall >= DRONE_RULES.usableTeaRecall && v.teaPrecision >= DRONE_RULES.usableTeaPrecision;
    const source: DroneSource = {
        id: analysis.project.id,
        title: analysis.project.title,
        kind: analysis.project.source.kind,
        georeference: analysis.project.source.georeference,
        capturedAt: analysis.project.capturedAt,
        capturedAtNote: analysis.project.capturedAtNote,
        origin: analysis.project.source.origin,
        platform: null,
        sensor: null,
        groundSampleCm: null,
        horizontalAccuracyCm: null,
    };
    const parcels: DroneVerificationParcel[] = [];
    for (const a of analysis.parcels) {
        const record = records.find((r) => `${r.block}/${r.parcel}` === a.parcel);
        if (!record) continue;
        const review = reviews.find((r) => r.parcel === a.parcel) ?? null;
        // The map shows the automatic class only when the classifier passed its test; otherwise a reading by eye, else "uncertain".
        const cls: DroneClass = usable ? a.class : (review?.class ?? 'uncertain');
        const classSource: 'review' | 'automatic' = usable ? 'automatic' : review ? 'review' : 'automatic';
        const agree = !review || !usable || review.class === a.class;
        // A reading that nobody verified on the ground never rises above "medium"; disagreement or an unusable classifier keeps it low.
        const confidence: DroneConfidence = review?.verified ? 'high' : usable && agree && a.confidence !== 'low' ? 'medium' : 'low';
        const recordTea = record.titleTea || record.licence.licensed;
        const notes: string[] = [];
        if (!usable) notes.push(`Otomatik sınıflandırma deneysel: bu parselde “${CLASS_LABEL[a.class]}” diyor (çay payı ortanca ${pct(a.teaShareMedian)}, kareler arası fark ${pct(a.teaShareSpread)}).`);
        if (review && !review.verified) notes.push('Görsel inceleme saha ya da eksper tarafından doğrulanmadı.');
        if (usable && review && !agree) notes.push(`Otomatik sınıflandırma (“${CLASS_LABEL[a.class]}”) ile görsel inceleme (“${CLASS_LABEL[review.class]}”) ayrışıyor.`);
        if (a.outline.kind === 'hand_drawn') notes.push('Karedeki düz çizgi elle çizilmiş yaklaşık eşleştirmedir; kadastro sınırı değildir.');
        const cadastre = georef?.parcels[a.parcel] ?? null;
        if (cadastre && georef) notes.push(`Kesikli çizgi, videoya yaklaşık olarak bindirilen TKGM sınırıdır (kontrol binalarında ortalama hata ${georef.rmsM} m). Elle çizimin ${pct(cadastre.handOverlap.handInsideCadastre)} kadarı bu sınırın içinde kalıyor.`);
        if (record.satellite && record.satellite.fullPixels < 6) notes.push(`Uydu için parsel küçük (${record.satellite.fullPixels} tam piksel): uydu okuması komşu bahçelerden etkilenir.`);
        let status: DroneStatus = 'consistent';
        let discrepancy: string | null = null;
        let action = 'İşlem gerekmiyor; kayıt ile görüntü uyumlu.';
        const satelliteTea = record.satellite?.tea === 'present';
        if (cls === 'uncertain') {
            status = 'needs_review';
            action = 'Görüntü güvenilir sonuç için yeterli değil: daha yakın/dik çekim ya da yerinde kontrol.';
        } else if (cls === 'partial') {
            status = 'needs_review';
            discrepancy = recordTea ? 'Kayıtta çay bahçesi; görüntüde parselin yalnız bir bölümünde çay görülüyor.' : null;
            action = 'Çaylık bölümün sınırı yerinde ya da ölçülü ortofoto ile belirlenmeli.';
        } else if (recordTea !== (cls === 'tea_present')) {
            status = 'needs_review';
            discrepancy = recordTea
                ? `Kayıt: ${record.titleTea ? `tapu niteliği “${record.nature}”` : 'tapuda çay yok'}${record.licence.licensed ? `, ruhsatlı (${record.licence.codes.join(', ')}${record.licence.source === 'demo' ? ', DEMO kayıt' : ''})` : ', ruhsat yok'}. Drone görüntüsü: çay bitkisi görülmüyor.${satelliteTea ? ` Uydu tespiti ise çay diyor (parselin ${pct(record.satellite?.teaShare ?? 0)} kadarı).` : ''}`
                : `Kayıtta çay yok (tapu niteliği “${record.nature}”, ruhsat yok). Drone görüntüsü: çay görülüyor.`;
            action = 'Yerinde kontrol önerilir. Bu bulgu tek başına ruhsat iptali ya da idari işlem gerekçesi değildir.';
        } else if (!review?.verified && confidence === 'low') {
            action = 'Kayıt ile görüntü uyumlu görünüyor; güven düşük olduğu için eksper onayı önerilir.';
        }
        parcels.push({
            ...record,
            sourceId: source.id,
            analysedAt: input.analysedAt,
            class: cls,
            classSource,
            confidence,
            automatic: { class: a.class, confidence: a.confidence, usable, teaShareMedian: a.teaShareMedian, teaShareSpread: a.teaShareSpread, otherShares: a.otherShares },
            review,
            hypothesis: a.hypothesis,
            status,
            discrepancy,
            action,
            video: { visible: a.visible, trackedFrames: a.trackedFrames, match: a.match },
            outline: a.outline,
            frames: a.frames,
            track: a.track ?? [],
            cadastreTrack: cadastre?.track ?? [],
            handOverlap: cadastre?.handOverlap ?? null,
            notes,
        });
    }
    return {
        generatedAt: new Date().toISOString(),
        method: 'Kayıt (tapu niteliği, ruhsat) ile drone görüntüsünün parsel bazında karşılaştırılması. Drone görüntüsü birincil kaynak, uydu destekleyici. Sonuç ön değerlendirmedir: uyuşmazlık yalnız yerinde kontrol önerir, idari karar üretmez.',
        rules: { ...DRONE_RULES, ...analysis.rules },
        sources: [source],
        capture: analysis.capture,
        clip: analysis.clip ?? null,
        georeference,
        suitability: suitabilityOf(analysis.capture, v, usable, georeference),
        validation: { ...v, usable },
        licenceSource: input.licenceSource,
        imageryBaseUrl: input.imageryBaseUrl,
        parcels,
    };
}
