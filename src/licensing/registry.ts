/**
 * DEMO digital licence register — producer-centred, as the BİLFERA licensing design describes:
 * producer → licence → licensed tea-garden sub-polygon → TKGM parcel. Built deterministically on
 * top of real TKGM parcels, real satellite tea detection and the demo producer/garden register,
 * with every record problem from the brief mixed in on purpose (old pafta references, lineage,
 * boundary proposals that overlap, area mismatches, missing licences, deceased holders, versioned
 * geometry, applications in every workflow state). Replace with ÇAYKUR's real records when they
 * arrive; nothing here is an official decision.
 */
import { area, buffer, centroid, feature, featureCollection, intersect, union } from '@turf/turf';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import type { DemoGarden, DemoProducer } from '../producers/demo-producers.ts';

type Poly = Polygon | MultiPolygon;

export type MatchLevel = 'exact' | 'historical' | 'probable' | 'unmatched';
export type LicenseStatus = 'active' | 'transfer_pending' | 'inactive';
export type GardenApprovalStatus = 'approved' | 'proposed' | 'boundary_conflict' | 'field_check_required' | 'unresolved';
export type Discrepancy = 'area_over' | 'area_under' | 'no_tea' | 'no_license' | 'lineage_unresolved' | 'overlap' | 'outside_parcel';
export type ApplicationType = 'new_license' | 'area_correction' | 'transfer' | 'boundary_determination' | 'parcel_update';
export type ApplicationStatus =
    | 'DRAFT'
    | 'DOCUMENTS_PENDING'
    | 'MATCHING_REQUIRED'
    | 'GEOMETRY_PROPOSED'
    | 'BOUNDARY_CONFLICT'
    | 'UNDER_REVIEW'
    | 'FIELD_CHECK_REQUIRED'
    | 'DEMO_APPROVED'
    | 'RETURNED_FOR_CORRECTION'
    | 'REJECTED'
    | 'SUPERSEDED';

export interface ParcelLineage {
    code: string;
    /** As written on old records: "Pafta 4 / Parsel 112". */
    oldRef: string;
    newParcelKey: string;
    changeType: '22-a yenileme' | 'ifraz' | 'tevhit' | 'kamulaştırma';
    source: string;
    changedAt: string;
}

export interface License {
    code: string;
    producerCode: string;
    walletNo: string;
    status: LicenseStatus;
    issuedYear: number;
    recordedAreaM2: number;
    /** Parcel reference(s) as written on the licence. */
    recordedParcelRefs: string[];
    matchLevel: MatchLevel;
    matchedParcelKeys: string[];
    /** Lineage records that resolved an old reference (historical matches). */
    lineageCodes: string[];
    /** Candidate parcels when only locality / area context is available (probable matches). */
    candidateParcelKeys: string[];
    holderDeceased: boolean;
    validFrom: string;
    validTo: string | null;
    gardenCodes: string[];
}

export interface GeometryVersion {
    version: number;
    geometry: Poly;
    planimetricAreaM2: number;
    reason: string;
    source: string;
    validFrom: string;
    validTo: string | null;
}

export interface BoundaryProposal {
    geometry: Poly;
    planimetricAreaM2: number;
    proposedBy: 'producer' | 'staff';
    proposedAt: string;
    overlapM2: number;
    overlapsGardenCode: string | null;
}

export interface LicensedGarden {
    code: string;
    producerCode: string;
    parcelKey: string;
    licenseCode: string | null;
    approvalStatus: GardenApprovalStatus;
    /** Licence area allocated to this garden (null: no licence or unresolved match). */
    licensedAreaM2: number | null;
    planimetricAreaM2: number;
    /** DEM-derived slope-corrected area; a technical estimate, never a legal area. */
    surfaceAreaM2: number;
    meanSlopeDeg: number;
    measuredTeaAreaM2: number;
    discrepancies: Discrepancy[];
    versions: GeometryVersion[];
    proposal: BoundaryProposal | null;
}

export interface BoundaryConflict {
    code: string;
    parcelKey: string;
    gardenCodes: [string, string];
    overlapM2: number;
    geometry: Poly;
    status: 'open' | 'resolved';
    openedAt: string;
}

export interface ApplicationDocument {
    type: string;
    name: string;
    status: 'provided' | 'missing';
}

export interface ApplicationHistoryEntry {
    at: string;
    from: ApplicationStatus | null;
    to: ApplicationStatus;
    by: string;
    note: string;
}

export interface Application {
    code: string;
    producerCode: string;
    licenseCode: string | null;
    gardenCode: string | null;
    type: ApplicationType;
    status: ApplicationStatus;
    submittedAt: string;
    summary: string;
    documents: ApplicationDocument[];
    history: ApplicationHistoryEntry[];
}

export interface LicensingRegistry {
    demo: true;
    generatedAt: string;
    rules: { areaTolerance: number; minLicenseM2: number; overlapToleranceM2: number };
    lineage: ParcelLineage[];
    licenses: License[];
    gardens: LicensedGarden[];
    conflicts: BoundaryConflict[];
    applications: Application[];
}

export interface RegistryInputs {
    producers: DemoProducer[];
    gardens: DemoGarden[];
    parcels: Array<{ key: string; block: string; parcel: string; locality: string; geometry: Poly }>;
    /** Satellite tea patches (fiili çaylık); the licensed sub-polygon is the holder's slice ∩ tea. */
    teaPatches: Poly[];
    /** Satellite tea area inside each garden (m²), from the producer scans. */
    teaAreaByGarden: Map<string, number>;
    /** Mean of 1/cos(slope) over each garden, from the DEM. */
    slopeSecantByGarden: Map<string, number>;
    meanSlopeDegByGarden: Map<string, number>;
}

/** Licensed vs measured/planimetric area outside ±15 % is a discrepancy to review. */
const AREA_TOLERANCE = 0.15;
const MIN_LICENSE_M2 = 1000;
const OVERLAP_TOLERANCE_M2 = 25;
const SOURCE_LINEAGE = 'TKGM eski–yeni parsel tablosu (demo)';
const STAFF = ['Davut Şahin', 'Naci Hocaoğlu', 'Ayla Demir'];

function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const round = (v: number) => Math.round(v);
const polyArea = (g: Poly) => area(feature(g));
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

function intersection(a: Poly, b: Poly): Feature<Poly> | null {
    const hit = intersect(featureCollection([feature(a), feature(b)]));
    return hit ? (hit as Feature<Poly>) : null;
}

/** A proposal that reaches `meters` into the neighbour: the garden grown, clipped to its parcel. */
function grownInsideParcel(garden: Poly, parcel: Poly, meters: number): Poly {
    const grown = buffer(feature(garden), meters, { units: 'meters' });
    const clipped = grown ? intersection(grown.geometry as Poly, parcel) : null;
    return (clipped?.geometry as Poly) ?? garden;
}

/** The geometry shrunk by `meters` (an older, rougher version of the boundary). */
function shrunk(garden: Poly, meters: number): Poly | null {
    const result = buffer(feature(garden), -meters, { units: 'meters' });
    return result?.geometry && area(result) > 50 ? (result.geometry as Poly) : null;
}

/** Minimum tea inside a slice for the tea outline to become the licensed sub-polygon. */
const MIN_TEA_POLYGON_M2 = 100;
/** A slice larger than this with no tea is not a garden: the demo keeps a plausible patch of it. */
const MAX_FALLBACK_SLICE_M2 = 20_000;
const FALLBACK_RADIUS_M = 60;

/**
 * The "koordinatlı çaylık alt-poligonu": the actual tea cover inside the holder's slice,
 * smoothed by a few metres (10 m pixels) and clipped back to the slice. When the satellite sees
 * (almost) no tea there the slice itself stands in — trimmed to a plausible garden around its
 * centre when the parcel is a large forest or meadow.
 */
function teaSubPolygon(slice: Poly, tea: Feature<Poly> | null): Poly {
    const hit = tea ? intersection(slice, tea.geometry) : null;
    if (hit && area(hit) >= MIN_TEA_POLYGON_M2) {
        const smoothed = buffer(hit, 4, { units: 'meters' });
        const clipped = smoothed ? intersection(smoothed.geometry as Poly, slice) : null;
        return (clipped?.geometry as Poly) ?? (hit.geometry as Poly);
    }
    if (polyArea(slice) <= MAX_FALLBACK_SLICE_M2) return slice;
    const around = buffer(centroid(feature(slice)), FALLBACK_RADIUS_M, { units: 'meters' });
    const trimmed = around ? intersection(around.geometry as Poly, slice) : null;
    return (trimmed?.geometry as Poly) ?? slice;
}

export function buildLicensingRegistry(input: RegistryInputs, seed = 2027): LicensingRegistry {
    const random = mulberry32(seed);
    const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)] as T;
    const date2026 = () => iso(2026, 1 + Math.floor(random() * 9), 1 + Math.floor(random() * 28));
    const parcelByKey = new Map(input.parcels.map((p) => [p.key, p]));
    const gardensByParcel = new Map<string, DemoGarden[]>();
    for (const g of input.gardens) gardensByParcel.set(g.parcelKey, [...(gardensByParcel.get(g.parcelKey) ?? []), g]);

    // ── Parcel lineage: a subset of parcels carry a documented old pafta/parsel reference ──
    const lineage: ParcelLineage[] = [];
    const lineageByParcel = new Map<string, ParcelLineage>();
    for (const p of input.parcels) {
        if (random() >= 0.14) continue;
        const rec: ParcelLineage = {
            code: `DEMO-L-${String(lineage.length + 1).padStart(4, '0')}`,
            oldRef: `Pafta ${1 + Math.floor(random() * 12)} / Parsel ${10 + Math.floor(random() * 400)}`,
            newParcelKey: p.key,
            changeType: pick(['22-a yenileme', '22-a yenileme', '22-a yenileme', 'ifraz', 'tevhit', 'kamulaştırma']),
            source: SOURCE_LINEAGE,
            changedAt: iso(2006 + Math.floor(random() * 14), 1 + Math.floor(random() * 12), 1 + Math.floor(random() * 28)),
        };
        lineage.push(rec);
        lineageByParcel.set(p.key, rec);
    }

    // ── Gardens: the tea sub-polygon inside each slice, three areas, boundary status, versions ──
    const teaFeatures = input.teaPatches.map((p) => feature(p));
    const teaUnion = teaFeatures.length === 0 ? null : teaFeatures.length === 1 ? teaFeatures[0]! : (union(featureCollection(teaFeatures)) as Feature<Poly> | null);
    const gardens: LicensedGarden[] = input.gardens.map((g) => {
        const current = teaSubPolygon(g.geometry, teaUnion);
        const planimetric = round(polyArea(current));
        const secant = input.slopeSecantByGarden.get(g.id) ?? 1;
        const versions: GeometryVersion[] = [];
        // The real register is mostly clean: nearly every garden has an approved boundary; the
        // odd shared-parcel proposal or field check is the exception that exercises the workflow.
        let approvalStatus: GardenApprovalStatus;
        if (!g.boundaryResolved) {
            approvalStatus = random() < 0.6 ? 'proposed' : 'unresolved';
        } else {
            const roll = random();
            approvalStatus = roll < 0.96 ? 'approved' : roll < 0.985 ? 'field_check_required' : 'proposed';
        }
        if (approvalStatus === 'approved' && random() < 0.12) {
            const older = shrunk(current, 3);
            if (older) {
                versions.push({
                    version: 1,
                    geometry: older,
                    planimetricAreaM2: round(polyArea(older)),
                    reason: pick(['İlk beyan çizimi (ortofoto üzerinden)', 'Eski şerit metre ölçümü']),
                    source: 'müstahsil beyanı',
                    validFrom: iso(2019 + Math.floor(random() * 5), 1 + Math.floor(random() * 12), 1 + Math.floor(random() * 28)),
                    validTo: iso(2025, 1 + Math.floor(random() * 12), 1 + Math.floor(random() * 28)),
                });
            }
        }
        versions.push({
            version: versions.length + 1,
            geometry: current,
            planimetricAreaM2: planimetric,
            reason: versions.length ? pick(['Saha RTK-GNSS ölçümü ile düzeltme', 'Komşu hissedar onayı sonrası düzeltme']) : 'İlk kayıt',
            source: versions.length ? 'ÇAYKUR eksper ölçümü' : g.boundaryResolved ? 'ÇAYKUR kaydı (demo)' : 'parsel bölümü (demo)',
            validFrom: versions.length ? (versions[0]?.validTo ?? '2025-01-01') : '2020-01-01',
            validTo: null,
        });
        return {
            code: g.id,
            producerCode: g.producerId,
            parcelKey: g.parcelKey,
            licenseCode: null,
            approvalStatus,
            licensedAreaM2: null,
            planimetricAreaM2: planimetric,
            surfaceAreaM2: round(planimetric * secant),
            meanSlopeDeg: Math.round((input.meanSlopeDegByGarden.get(g.id) ?? 0) * 10) / 10,
            measuredTeaAreaM2: round(input.teaAreaByGarden.get(g.id) ?? 0),
            discrepancies: [],
            versions,
            proposal: null,
        };
    });
    const gardenByCode = new Map(gardens.map((g) => [g.code, g]));

    // ── Boundary proposals and conflicts on shared parcels ──
    const conflicts: BoundaryConflict[] = [];
    for (const [parcelKey, list] of gardensByParcel) {
        const parcel = parcelByKey.get(parcelKey);
        if (!parcel || list.length < 2) continue;
        for (let i = 0; i < list.length; i++) {
            const g = gardenByCode.get(list[i]!.id)!;
            if (g.approvalStatus !== 'proposed') continue;
            const neighbour = list[i + 1] ?? list[i - 1];
            const intrudes = !!neighbour && random() < 0.5 && conflicts.length < 8;
            const geometry = intrudes ? grownInsideParcel(g.versions.at(-1)!.geometry, parcel.geometry, 5) : g.versions.at(-1)!.geometry;
            let overlapM2 = 0;
            let overlapsGardenCode: string | null = null;
            if (intrudes && neighbour) {
                const other = gardenByCode.get(neighbour.id)!;
                const hit = intersection(geometry, other.versions.at(-1)!.geometry);
                if (hit && area(hit) >= OVERLAP_TOLERANCE_M2) {
                    overlapM2 = round(area(hit));
                    overlapsGardenCode = other.code;
                    g.approvalStatus = 'boundary_conflict';
                    g.discrepancies.push('overlap');
                    if (other.approvalStatus !== 'approved') other.approvalStatus = 'boundary_conflict';
                    if (!other.discrepancies.includes('overlap')) other.discrepancies.push('overlap');
                    conflicts.push({
                        code: `DEMO-K-${String(conflicts.length + 1).padStart(3, '0')}`,
                        parcelKey,
                        gardenCodes: [g.code, other.code],
                        overlapM2,
                        geometry: hit.geometry as Poly,
                        status: 'open',
                        openedAt: date2026(),
                    });
                }
            }
            g.proposal = {
                geometry,
                planimetricAreaM2: round(polyArea(geometry)),
                proposedBy: random() < 0.7 ? 'producer' : 'staff',
                proposedAt: date2026(),
                overlapM2,
                overlapsGardenCode,
            };
        }
    }

    // ── Licences: per producer, covering their gardens ──
    const licenses: License[] = [];
    const applications: Application[] = [];
    const producerByCode = new Map(input.producers.map((p) => [p.id, p]));
    const refOf = (parcelKey: string) => {
        const p = parcelByKey.get(parcelKey);
        return p ? `Ada ${p.block} / Parsel ${p.parcel}` : parcelKey;
    };
    // Random dates are sorted so the file reads chronologically; submission is the first entry.
    const addApplication = (a: Omit<Application, 'code'>) => {
        const history = [...a.history].sort((x, y) => x.at.localeCompare(y.at));
        applications.push({
            code: `DEMO-B-${String(applications.length + 1).padStart(4, '0')}`,
            ...a,
            history,
            submittedAt: history[0]?.at ?? a.submittedAt,
        });
    };

    for (const producer of input.producers) {
        const own = producer.gardenIds.map((id) => gardenByCode.get(id)).filter((g): g is LicensedGarden => !!g);
        if (own.length === 0) continue;
        // One licence per producer; a second one for some producers with several gardens (two wallets happen).
        const split = !producer.showcase && own.length >= 3 && random() < 0.25;
        const groups: LicensedGarden[][] = split ? [own.slice(0, Math.ceil(own.length / 2)), own.slice(Math.ceil(own.length / 2))] : [own];
        for (const group of groups) {
            // Faulty licences are rare in the field: ~94 % match, a few percent off, almost no ghosts.
            const roll = random();
            // Showcase producers (demo layout) always carry a clean, matching licence: the demo must
            // show the pruning workflow, not the licence-fault workflow, on those files.
            const scenario = producer.showcase ? 'matching' : roll < 0.94 ? 'matching' : roll < 0.96 ? 'inflated' : roll < 0.98 ? 'understated' : roll < 0.99 ? 'ghost' : 'unlicensed';
            if (scenario === 'unlicensed') {
                // Tea on the ground, no licence anywhere: a new-licence application may or may not exist.
                for (const g of group) g.discrepancies.push('no_license');
                if (random() < 0.6) {
                    const g = group[0]!;
                    addApplication({
                        producerCode: producer.id,
                        licenseCode: null,
                        gardenCode: g.code,
                        type: 'new_license',
                        status: random() < 0.5 ? 'DOCUMENTS_PENDING' : 'DRAFT',
                        submittedAt: date2026(),
                        summary: `${refOf(g.parcelKey)} için yeni çay bahçesi ruhsatı başvurusu`,
                        documents: [
                            { type: 'tapu', name: 'Tapu senedi / zilyetlik belgesi', status: 'provided' },
                            { type: 'toprak', name: 'Toprak analiz raporu (pH 4,5–6,0)', status: 'missing' },
                            { type: 'kroki', name: 'Bahçe krokisi / koordinatlı sınır', status: g.approvalStatus === 'approved' ? 'provided' : 'missing' },
                        ],
                        history: [{ at: date2026(), from: null, to: 'DRAFT', by: 'müstahsil', note: 'Başvuru taslağı oluşturuldu' }],
                    });
                }
                continue;
            }

            const serial = licenses.length + 1;
            const code = `DEMO-R-${String(9000 + serial)}`;
            const issuedYear = 1972 + Math.floor(random() * 50);
            const holderDeceased = !producer.showcase && issuedYear < 1992 && random() < 0.08;
            // Match level of the parcel reference(s) written on the licence: almost all resolve.
            const mroll = random();
            const matchLevel: MatchLevel = producer.showcase ? 'exact' : mroll < 0.9 ? 'exact' : mroll < 0.97 ? 'historical' : mroll < 0.99 ? 'probable' : 'unmatched';
            const refs: string[] = [];
            const matched: string[] = [];
            const lineageCodes: string[] = [];
            const candidates: string[] = [];
            const parcelKeys = [...new Set(group.map((g) => g.parcelKey))];
            for (const key of parcelKeys) {
                if (matchLevel === 'exact') {
                    refs.push(refOf(key));
                    matched.push(key);
                } else if (matchLevel === 'historical') {
                    const rec = lineageByParcel.get(key) ?? (() => {
                        const made: ParcelLineage = {
                            code: `DEMO-L-${String(lineage.length + 1).padStart(4, '0')}`,
                            oldRef: `Pafta ${1 + Math.floor(random() * 12)} / Parsel ${10 + Math.floor(random() * 400)}`,
                            newParcelKey: key,
                            changeType: '22-a yenileme',
                            source: SOURCE_LINEAGE,
                            changedAt: iso(2008 + Math.floor(random() * 10), 1 + Math.floor(random() * 12), 1 + Math.floor(random() * 28)),
                        };
                        lineage.push(made);
                        lineageByParcel.set(key, made);
                        return made;
                    })();
                    refs.push(rec.oldRef);
                    matched.push(key);
                    lineageCodes.push(rec.code);
                } else if (matchLevel === 'probable') {
                    const p = parcelByKey.get(key);
                    refs.push(`${p?.locality || 'Köy içi'} mevkii, ${pick(['doğusu yol', 'batısı dere', 'kuzeyi orman', 'güneyi patika'])} (zilyetlik)`);
                    const neighbours = input.parcels.filter((q) => q.key !== key && q.block === p?.block).slice(0, 2).map((q) => q.key);
                    candidates.push(key, ...neighbours);
                } else {
                    refs.push(`Pafta ${1 + Math.floor(random() * 12)} / Parsel ${10 + Math.floor(random() * 400)}`);
                }
            }

            // Recorded area: the scenario applied to the measured tea of the licence's gardens.
            const measured = group.reduce((s, g) => s + g.measuredTeaAreaM2, 0);
            const planimetric = group.reduce((s, g) => s + g.planimetricAreaM2, 0);
            const factor = producer.showcase ? 0.97 + random() * 0.06 : scenario === 'matching' ? 0.9 + random() * 0.2 : scenario === 'inflated' ? 1.6 + random() * 1.2 : scenario === 'understated' ? 0.45 + random() * 0.2 : 1;
            // A ghost licence cites a plausible garden size, never the whole (sometimes huge) parcel.
            const base = scenario === 'ghost' ? Math.min(planimetric, 3000) * (0.6 + random() * 0.4) : Math.max(measured, 120) * factor;
            const recordedAreaM2 = Math.max(MIN_LICENSE_M2 * (group.length > 1 || base > 700 ? 1 : 0.1), Math.round(base / 10) * 10);

            const license: License = {
                code,
                producerCode: producer.id,
                walletNo: producer.walletNo,
                status: holderDeceased ? 'transfer_pending' : 'active',
                issuedYear,
                recordedAreaM2,
                recordedParcelRefs: refs,
                matchLevel,
                matchedParcelKeys: matched,
                lineageCodes,
                candidateParcelKeys: candidates,
                holderDeceased,
                validFrom: iso(issuedYear, 1, 1),
                validTo: null,
                gardenCodes: group.map((g) => g.code),
            };
            licenses.push(license);

            // Allocate the recorded area to gardens pro rata to their planimetric size (matched only).
            const resolved = matchLevel === 'exact' || matchLevel === 'historical';
            for (const g of group) {
                g.licenseCode = code;
                if (!resolved) {
                    // The licence exists but its parcel reference is not tied to this garden yet:
                    // no licensed area can be allocated until matching is confirmed.
                    g.discrepancies.push('lineage_unresolved');
                    continue;
                }
                g.licensedAreaM2 = round((recordedAreaM2 * g.planimetricAreaM2) / Math.max(planimetric, 1));
                if (g.measuredTeaAreaM2 < 50 && g.licensedAreaM2 > 100) g.discrepancies.push('no_tea');
                else if (g.licensedAreaM2 > g.planimetricAreaM2 * (1 + AREA_TOLERANCE) || (g.measuredTeaAreaM2 > 0 && g.licensedAreaM2 > g.measuredTeaAreaM2 * (1 + AREA_TOLERANCE) * 1.5)) g.discrepancies.push('area_over');
                else if (g.measuredTeaAreaM2 > 0 && g.licensedAreaM2 < g.measuredTeaAreaM2 * (1 - AREA_TOLERANCE)) g.discrepancies.push('area_under');
            }

            // Applications that the scenario implies.
            const g0 = group[0]!;
            if (matchLevel === 'unmatched') {
                addApplication({
                    producerCode: producer.id,
                    licenseCode: code,
                    gardenCode: null,
                    type: 'parcel_update',
                    status: 'MATCHING_REQUIRED',
                    submittedAt: date2026(),
                    summary: `Ruhsattaki "${refs[0]}" kaydının güncel ada/parsele bağlanması`,
                    documents: [
                        { type: 'ruhsat', name: 'Ruhsatname fotokopisi', status: 'provided' },
                        { type: 'tapu', name: 'Güncel tapu kaydı', status: random() < 0.5 ? 'provided' : 'missing' },
                    ],
                    history: [
                        { at: date2026(), from: null, to: 'DRAFT', by: 'müstahsil', note: 'Eski pafta/parsel kaydı güncel kadastroda bulunamadı' },
                        { at: date2026(), from: 'DRAFT', to: 'MATCHING_REQUIRED', by: 'sistem', note: 'Otomatik eşleştirme aday bulamadı; eski–yeni parsel tablosunda kayıt yok' },
                    ],
                });
            } else if (matchLevel === 'probable') {
                addApplication({
                    producerCode: producer.id,
                    licenseCode: code,
                    gardenCode: g0.code,
                    type: 'parcel_update',
                    status: 'UNDER_REVIEW',
                    submittedAt: date2026(),
                    summary: `Zilyetlik tarifli ruhsat için ${candidates.length} aday parselden birinin teyidi`,
                    documents: [{ type: 'ruhsat', name: 'Ruhsatname fotokopisi', status: 'provided' }, { type: 'muhtar', name: 'Muhtarlık ilmühaberi', status: 'provided' }],
                    history: [
                        { at: date2026(), from: null, to: 'MATCHING_REQUIRED', by: 'sistem', note: 'Mevki ve alan bağlamından aday parseller üretildi' },
                        { at: date2026(), from: 'MATCHING_REQUIRED', to: 'UNDER_REVIEW', by: pick(STAFF), note: 'Aday parseller ortofoto üzerinde inceleniyor' },
                    ],
                });
            }
            if (scenario === 'inflated' && resolved) {
                const returned = random() < 0.5;
                addApplication({
                    producerCode: producer.id,
                    licenseCode: code,
                    gardenCode: g0.code,
                    type: 'area_correction',
                    status: returned ? 'RETURNED_FOR_CORRECTION' : 'UNDER_REVIEW',
                    submittedAt: date2026(),
                    summary: `Ruhsat alanı (${recordedAreaM2} m²) ile ölçülen çaylık (${measured} m²) arasındaki fark`,
                    documents: [{ type: 'olcum', name: 'Koordinatlı ölçüm krokisi', status: returned ? 'missing' : 'provided' }],
                    history: returned
                        ? [
                            { at: date2026(), from: null, to: 'UNDER_REVIEW', by: 'sistem', note: 'Alan uyuşmazlığı otomatik işaretlendi' },
                            { at: date2026(), from: 'UNDER_REVIEW', to: 'RETURNED_FOR_CORRECTION', by: pick(STAFF), note: 'Ölçüm krokisi eksik; müstahsilden sınırını çizmesi istendi' },
                        ]
                        : [{ at: date2026(), from: null, to: 'UNDER_REVIEW', by: 'sistem', note: 'Alan uyuşmazlığı otomatik işaretlendi' }],
                });
            }
            if (holderDeceased) {
                addApplication({
                    producerCode: producer.id,
                    licenseCode: code,
                    gardenCode: null,
                    type: 'transfer',
                    status: 'DOCUMENTS_PENDING',
                    submittedAt: date2026(),
                    summary: 'Vefat eden ruhsat sahibinden mirasçılara intikal',
                    documents: [
                        { type: 'veraset', name: 'Veraset ilamı', status: 'provided' },
                        { type: 'muvafakat', name: 'Diğer mirasçıların muvafakati', status: 'missing' },
                    ],
                    history: [{ at: date2026(), from: null, to: 'DOCUMENTS_PENDING', by: 'müstahsil', note: 'İntikal başvurusu açıldı' }],
                });
            }
        }
    }

    // ── Boundary applications for proposals and conflicts ──
    for (const g of gardens) {
        if (!g.proposal) continue;
        const conflict = conflicts.find((c) => c.gardenCodes.includes(g.code));
        if (conflict && conflict.gardenCodes[0] !== g.code) continue; // one application per conflict pair
        addApplication({
            producerCode: g.producerCode,
            licenseCode: g.licenseCode,
            gardenCode: g.code,
            type: 'boundary_determination',
            status: conflict ? 'BOUNDARY_CONFLICT' : random() < 0.5 ? 'GEOMETRY_PROPOSED' : 'UNDER_REVIEW',
            submittedAt: g.proposal.proposedAt,
            summary: conflict
                ? `${refOf(g.parcelKey)} hisseli parselinde sınır önerisi komşu hissedarla ${conflict.overlapM2} m² çakışıyor`
                : `${refOf(g.parcelKey)} hisseli parselinde bahçe sınırı önerisi (${g.proposal.planimetricAreaM2} m²)`,
            documents: [{ type: 'kroki', name: g.proposal.proposedBy === 'producer' ? 'Müstahsil çizimi (ortofoto)' : 'Eksper RTK ölçümü', status: 'provided' }],
            history: conflict
                ? [
                    { at: g.proposal.proposedAt, from: null, to: 'GEOMETRY_PROPOSED', by: g.proposal.proposedBy === 'producer' ? 'müstahsil' : pick(STAFF), note: 'Sınır önerisi kaydedildi' },
                    { at: conflict.openedAt, from: 'GEOMETRY_PROPOSED', to: 'BOUNDARY_CONFLICT', by: 'sistem', note: `Komşu hissedarın alanıyla ${conflict.overlapM2} m² çakışma` },
                ]
                : [{ at: g.proposal.proposedAt, from: null, to: 'GEOMETRY_PROPOSED', by: g.proposal.proposedBy === 'producer' ? 'müstahsil' : pick(STAFF), note: 'Sınır önerisi kaydedildi' }],
        });
    }
    // Field checks and a few finished files (the full flow, a rejection, a superseded version).
    for (const g of gardens.filter((x) => x.approvalStatus === 'field_check_required').slice(0, 4)) {
        addApplication({
            producerCode: g.producerCode,
            licenseCode: g.licenseCode,
            gardenCode: g.code,
            type: g.discrepancies.includes('lineage_unresolved') ? 'parcel_update' : 'area_correction',
            status: 'FIELD_CHECK_REQUIRED',
            submittedAt: date2026(),
            summary: `${refOf(g.parcelKey)} için saha doğrulaması gerekli`,
            documents: [{ type: 'ruhsat', name: 'Ruhsatname fotokopisi', status: 'provided' }],
            history: [
                { at: date2026(), from: null, to: 'UNDER_REVIEW', by: 'sistem', note: 'Uyuşmazlık işaretlendi' },
                { at: date2026(), from: 'UNDER_REVIEW', to: 'FIELD_CHECK_REQUIRED', by: pick(STAFF), note: 'Ortofoto yeterli değil; sahada GNSS ölçümü istendi' },
            ],
        });
    }
    const showcase = gardens.filter((x) => x.approvalStatus === 'approved' && x.versions.length > 1).slice(0, 3);
    const [done, rejected, superseded] = showcase;
    if (done) {
        addApplication({
            producerCode: done.producerCode,
            licenseCode: done.licenseCode,
            gardenCode: done.code,
            type: 'boundary_determination',
            status: 'DEMO_APPROVED',
            submittedAt: '2026-02-03',
            summary: `${refOf(done.parcelKey)} bahçe sınırının koordinatlı olarak kayda alınması`,
            documents: [{ type: 'kroki', name: 'Müstahsil çizimi (ortofoto)', status: 'provided' }, { type: 'olcum', name: 'Eksper RTK ölçümü', status: 'provided' }],
            history: [
                { at: '2026-02-03', from: null, to: 'DRAFT', by: 'müstahsil', note: 'Başvuru oluşturuldu' },
                { at: '2026-02-05', from: 'DRAFT', to: 'GEOMETRY_PROPOSED', by: 'müstahsil', note: 'Ortofoto üzerinde sınır çizildi' },
                { at: '2026-02-09', from: 'GEOMETRY_PROPOSED', to: 'UNDER_REVIEW', by: 'sistem', note: 'Parsel içi ve çakışma kontrolleri geçti' },
                { at: '2026-02-14', from: 'UNDER_REVIEW', to: 'RETURNED_FOR_CORRECTION', by: 'Davut Şahin', note: 'Kuzey sınır dere yatağına taşıyor; düzeltme istendi' },
                { at: '2026-02-20', from: 'RETURNED_FOR_CORRECTION', to: 'GEOMETRY_PROPOSED', by: 'müstahsil', note: 'Sınır düzeltildi (sürüm 2)' },
                { at: '2026-02-24', from: 'GEOMETRY_PROPOSED', to: 'UNDER_REVIEW', by: 'sistem', note: 'Yeniden kontrol edildi' },
                { at: '2026-03-02', from: 'UNDER_REVIEW', to: 'DEMO_APPROVED', by: 'Naci Hocaoğlu', note: 'Demo onayı — resmî ÇAYKUR onayı değildir' },
            ],
        });
    }
    if (rejected) {
        addApplication({
            producerCode: rejected.producerCode,
            licenseCode: rejected.licenseCode,
            gardenCode: rejected.code,
            type: 'area_correction',
            status: 'REJECTED',
            submittedAt: '2026-03-10',
            summary: 'Ruhsat alanının ölçülen alanın üzerine çıkarılması talebi',
            documents: [{ type: 'olcum', name: 'Şerit metre ölçüm beyanı', status: 'provided' }],
            history: [
                { at: '2026-03-10', from: null, to: 'UNDER_REVIEW', by: 'müstahsil', note: 'Alan artışı talebi' },
                { at: '2026-03-18', from: 'UNDER_REVIEW', to: 'REJECTED', by: 'Ayla Demir', note: 'Talep edilen alan parsel sınırını aşıyor; itiraz yolu açık' },
            ],
        });
    }
    if (superseded) {
        addApplication({
            producerCode: superseded.producerCode,
            licenseCode: superseded.licenseCode,
            gardenCode: superseded.code,
            type: 'boundary_determination',
            status: 'SUPERSEDED',
            submittedAt: '2025-11-04',
            summary: 'Önceki sınır çizimi (sürüm 1) — yeni sürümle değiştirildi',
            documents: [{ type: 'kroki', name: 'Eski kroki', status: 'provided' }],
            history: [
                { at: '2025-11-04', from: null, to: 'GEOMETRY_PROPOSED', by: 'müstahsil', note: 'Sürüm 1 çizildi' },
                { at: '2026-01-15', from: 'GEOMETRY_PROPOSED', to: 'SUPERSEDED', by: 'sistem', note: 'RTK ölçümü ile sürüm 2 kaydedildi' },
            ],
        });
    }

    // Keep producers that exist; drop gardens whose producer vanished (none expected).
    void producerByCode;
    return {
        demo: true,
        generatedAt: new Date().toISOString(),
        rules: { areaTolerance: AREA_TOLERANCE, minLicenseM2: MIN_LICENSE_M2, overlapToleranceM2: OVERLAP_TOLERANCE_M2 },
        lineage,
        licenses,
        gardens,
        conflicts,
        applications,
    };
}

/** Sum of licence area allocated to resolved gardens of a producer (the 1/7 base). */
export function producerLicensedAreaM2(registry: LicensingRegistry, producerCode: string): number {
    return registry.gardens.filter((g) => g.producerCode === producerCode && g.licensedAreaM2 !== null).reduce((s, g) => s + (g.licensedAreaM2 ?? 0), 0);
}

/** Parcel-level licence view for the inventory tab: allocated licence area and the primary licence. */
export function parcelLicenseView(registry: LicensingRegistry, parcelKey: string): { licensedAreaM2: number | null; primary: License | null; licenseCount: number } {
    const gardens = registry.gardens.filter((g) => g.parcelKey === parcelKey && g.licenseCode && g.licensedAreaM2 !== null);
    if (gardens.length === 0) return { licensedAreaM2: null, primary: null, licenseCount: 0 };
    const total = gardens.reduce((s, g) => s + (g.licensedAreaM2 ?? 0), 0);
    const codes = [...new Set(gardens.map((g) => g.licenseCode as string))];
    const primaryCode = gardens.sort((a, b) => (b.licensedAreaM2 ?? 0) - (a.licensedAreaM2 ?? 0))[0]?.licenseCode ?? null;
    return { licensedAreaM2: total, primary: registry.licenses.find((l) => l.code === primaryCode) ?? null, licenseCount: codes.length };
}

/** Current (latest version) geometry of a garden in the register. */
export function currentGeometry(garden: LicensedGarden): Poly {
    return garden.versions[garden.versions.length - 1]!.geometry;
}
