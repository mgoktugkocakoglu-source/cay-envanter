import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { area as turfArea, bbox as turfBbox, buffer, feature, featureCollection, intersect } from '@turf/turf';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { AUDIT_RULES, decide, readTitle, teaStateOf, type AuditDecision, type AuditFlag, type BuildingState, type Confidence, type DecisionResult, type TeaState, type TitleReading } from '../audit/decision.ts';
import { buildDemoLicences, DEMO_LICENCE_RULES, type DemoLicence } from '../audit/demo-licences.ts';
import { parseFieldNotes } from '../audit/field-notes.ts';
import { parcelKml } from '../audit/kml.ts';
import { detectTeaEvidence, EVIDENCE_RULES, type EvidenceModel, type ParcelTeaEvidence } from '../audit/tea-evidence.ts';
import { evaluate, initEarthEngine } from '../ee/session.ts';
import { LIBRARY_ROOT, NeighborhoodStore, slugify } from '../library/store.ts';
import { TkgmClient, TkgmQuotaExceededError } from '../tkgm/client.ts';
import { normalizeParcel } from '../tkgm/normalize.ts';
import type { Parcel } from '../tkgm/types.ts';

type Poly = Polygon | MultiPolygon;

const USAGE = `
Kullanım:
  npm run audit-licensing -- --province Trabzon --district Of --neighborhood Çataldere [--parcels "227/5,112/4"] [--refresh]

Arazi tespit kararı (ruhsatlandırma altında ayrı modül; envanter, ruhsat kaydı ve arazi değerlendirme çıktılarına dokunmaz):
her parsel için üç kaynak yan yana konur ve tek karara bağlanır.
  1. TKGM      : parsel geometrisi ve tapu niteliği (kütüphanede yoksa --parcels ile ada/parsel üzerinden TEK sorgu)
  2. Tespit    : nitelikten bağımsız çay tespiti (konum özniteliği yok, kar maskeli) + yapı izleri (Microsoft bina izleri)
  3. ÇAYKUR    : ruhsat kaydı (licence-audit/caykur-licences.csv varsa o, yoksa DEMO ruhsat kaydı: demo müstahsil kaydının
                 ruhsatları + kaydın ulaşmadığı parsellere genişletme; çayın çoğu ruhsatlı, kaçak/hatalı/çaysız ruhsat istisna)
Arazi notları: licence-audit/field-notes.csv (ada;parsel;nitelik;alan_m2;arazi_notu) — "çay var", "ev var", "kaçak" notları saha gözlemi sayılır;
               listedeki eksik parseller TKGM'den alınır. Elle sabitleme: licence-audit/demo-pins.json  { "227/5": false }
Karar: ÇAY ARAZİSİ · ÇAYKUR RUHSATLANDIRMA HATASI · RUHSATSIZ ÇAY ARAZİSİ (+ diğer beş birleşim ve "inceleme gerekli").
Eksper teyidi: licence-audit/confirmations.json  [{ "block": "227", "parcel": "5", "tea": true, "source": "...", "note": "...", "date": "2026-11-12" }]
Çıktı: licence-audit/audit.json, licence-audit/kml/*.kml (Google Earth)
`;

export interface AuditParcel {
    key: string;
    block: string;
    parcel: string;
    nature: string;
    locality: string;
    areaM2: number;
    deedAreaM2: number | null;
    title: TitleReading;
    detection: {
        tea: TeaState;
        teaShare: number | null;
        teaAreaM2: number | null;
        teaProbability: number | null;
        /** The inventory detector's share (learns from titles and elevation), for comparison only. */
        inventoryShare: number | null;
        fullPixels: number;
        beyondTraining: boolean;
        ndviSummer: number | null;
        ndviLeafOff: number | null;
        evergreen: number | null;
        vhSummer: number | null;
        elevationM: number | null;
        leafOffObs: number | null;
    };
    building: { state: BuildingState; count: number; insideM2: number; source: string };
    licence: { licensed: boolean; areaM2: number | null; codes: string[]; source: 'demo' | 'caykur' | 'none' };
    /** Ground observation by a person (expert confirmation or field note); a null side was not observed. */
    confirmation: { tea: boolean | null; building: boolean | null; sparse: boolean; source: string; note: string; date: string } | null;
    decision: AuditDecision;
    leaning: DecisionResult['leaning'];
    confidence: Confidence;
    flags: AuditFlag[];
    consistency: DecisionResult['consistency'];
    reason: string;
    geometry: Poly;
}
export interface AuditFile {
    generatedAt: string;
    method: string;
    rules: typeof AUDIT_RULES;
    evidenceRules: typeof EVIDENCE_RULES;
    /** The title-trained detector's own test; null when the audit never ran it. Kept for the record, not the reading in use. */
    model: EvidenceModel | null;
    /**
     * Where the tea reading of the parcels comes from. `land_cover`: the land-cover module's parcel reading, with its
     * score on parcels a person looked at. `title_model`: the audit's own detector, trained on deed titles.
     */
    teaSource: {
        kind: 'land_cover' | 'title_model';
        generatedAt: string | null;
        reference: { parcels: number; teaFound: number; teaTotal: number; noTeaRight: number; noTeaTotal: number; balanced: number } | null;
        byElevation: Array<{ band: string; teaParcels: number; teaFound: number }>;
        highElevationM: number | null;
        note: string;
    };
    licenceSource: 'demo' | 'caykur';
    /** How the demo register was put together (absent with the real list). */
    demoLicences: { rules: typeof DEMO_LICENCE_RULES; byOrigin: Record<string, number>; byScenario: Record<string, number>; note: string } | null;
    /** Field notes against the satellite reading: the only ground check there is so far. */
    fieldCheck: { notes: number; teaNoted: number; teaNotedDetected: number; teaNotedInconclusive: number; teaNotedMissed: number; titleMismatch: number } | null;
    buildingSource: string;
    summary: {
        parcels: number;
        byDecision: Record<AuditDecision, number>;
        byConfidence: Record<Confidence, number>;
        byLeaning: Record<string, number>;
        flags: Partial<Record<AuditFlag, number>>;
        /** Title says tea (rows) × tea detected (columns), assessable parcels only. */
        titleVsGround: { titleTeaGroundTea: number; titleTeaGroundNone: number; titleOtherGroundTea: number; titleOtherGroundNone: number; unknown: number };
        areaM2: { unlicensedTea: number; licensedNoTea: number };
    };
    parcels: AuditParcel[];
    buildings: FeatureCollection<Poly, { areaM2: number }>;
}

const DECISION_LABEL: Record<AuditDecision, string> = {
    tea_land: 'ÇAY ARAZİSİ',
    licensing_error: 'ÇAYKUR RUHSATLANDIRMA HATASI',
    unlicensed_tea: 'RUHSATSIZ ÇAY ARAZİSİ',
    unlicensed_tea_titled: 'RUHSATSIZ ÇAY ARAZİSİ (tapuda çay)',
    licence_no_tea: 'RUHSAT VAR, ÇAY YOK',
    title_outdated: 'RUHSATLI ÇAY, TAPU NİTELİĞİ GÜNCEL DEĞİL',
    title_only: 'YALNIZ TAPUDA ÇAY',
    out_of_scope: 'KAPSAM DIŞI',
    needs_review: 'İNCELEME GEREKLİ',
};

/** The part of land-cover/cover.json the audit reads. */
interface CoverFile {
    version: number;
    generatedAt: string;
    rules: { highElevationM?: number };
    model: {
        used: { teaFound: number; teaTotal: number; noTeaRight: number; noTeaTotal: number; balanced: number } | null;
        reference: { parcels: number };
        byElevation?: Array<{ band: string; teaParcels: number; teaFound: number }>;
    };
    parcels: Array<{ key: string; tea: 'present' | 'partial' | 'absent' | 'context' | 'not_assessable'; teaShare: number | null; teaProbability: number | null; elevationM?: number; evidence: { winterRatio: number } | null }>;
}

function reasonOf(p: Omit<AuditParcel, 'reason' | 'geometry'>): string {
    const d = p.detection;
    const pct = (v: number | null) => (v === null ? '—' : `%${Math.round(v * 100)}`);
    const title = `Tapu niteliği “${p.nature}” (${p.title.tea ? 'çay var' : 'çay yok'})`;
    const licence = p.licence.licensed ? `ÇAYKUR kaydında ruhsatlı (${p.licence.codes.join(', ')}${p.licence.areaM2 ? `, ${Math.round(p.licence.areaM2)} m²` : ''}${p.licence.source === 'demo' ? ', DEMO kayıt' : ''})` : `ÇAYKUR kaydında ruhsat yok${p.licence.source === 'demo' ? ' (DEMO kayıt)' : ''}`;
    const ground =
        p.confirmation !== null && p.confirmation.tea !== null
            ? `saha gözlemi: ${p.confirmation.tea ? (p.confirmation.sparse ? 'çay var, seyrek' : 'çay var') : 'çay yok'} (${p.confirmation.source}); uydu tespiti parselin ${pct(d.teaShare)} kadarında çay görüyor`
            : d.tea === 'not_assessable'
              ? `parsel 10 m piksel ağı için çok küçük (${d.fullPixels} tam piksel), uydu ile değerlendirilemiyor`
              : d.tea === 'inconclusive'
                ? `uydu tespiti kararsız (parselin ${pct(d.teaShare)} kadarı çay görünüyor)`
                : `uydu tespiti: ${d.tea === 'present' ? `çay var, parselin ${pct(d.teaShare)} kadarı (≈ ${d.teaAreaM2} m²)` : `çay yok (${pct(d.teaShare)})`}`;
    const notes: string[] = [];
    if (p.flags.includes('beyond_training')) notes.push(`parsel ${d.elevationM} m'de: bu yükseklikte uydu okuması zayıftır, tek başına yeterli sayılmaz`);
    if (p.flags.includes('small_parcel') && d.tea !== 'not_assessable') notes.push(`yalnız ${d.fullPixels} tam piksel`);
    if (p.flags.includes('detectors_disagree')) notes.push(`envanter tespiti farklı söylüyor (${pct(d.inventoryShare)})`);
    if (p.flags.includes('public_land')) notes.push('tapu kamu arazisi');
    if (p.flags.includes('large_parcel')) notes.push('parsel çok büyük: içindeki çay cebi parsel payıyla ölçülemez, bahçe sınırıyla bakılmalı');
    if (p.confirmation?.building) notes.push('saha gözlemi: parselde ev var');
    if (p.flags.includes('licence_unverified')) notes.push('DEMO ruhsat kaydı bu parseli kapsamıyor: “ruhsat yok” bilgisi gerçek ÇAYKUR listesiyle doğrulanmalı');
    const tail = p.decision === 'needs_review' ? ` Eğilim: ${DECISION_LABEL[p.leaning]}.` : '';
    return `${title}; ${licence}; ${ground}.${notes.length ? ` Not: ${notes.join('; ')}.` : ''}${tail}`;
}

async function fetchBuildings(ee: unknown, boundary: Poly): Promise<Array<Feature<Poly, { areaM2: number }>>> {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const E = ee as any;
    const fc = E.FeatureCollection('projects/sat-io/open-datasets/MSBuildings/Turkey').filterBounds(E.Geometry(boundary).buffer(30));
    const size = await evaluate<number>(fc.size());
    const out: Array<Feature<Poly, { areaM2: number }>> = [];
    for (let i = 0; i < size; i += 2000) {
        const page = await evaluate<{ features: Array<Feature<Poly>> }>(E.FeatureCollection(fc.toList(2000, i)));
        for (const f of page.features) if (f.geometry) out.push(feature(f.geometry, { areaM2: Math.round(turfArea(f)) }) as Feature<Poly, { areaM2: number }>);
    }
    return out;
    /* eslint-enable @typescript-eslint/no-explicit-any */
}

async function main(): Promise<void> {
    const { values } = parseArgs({ options: { province: { type: 'string' }, district: { type: 'string' }, neighborhood: { type: 'string' }, parcels: { type: 'string' }, refresh: { type: 'boolean', default: false }, 'tea-source': { type: 'string' } } });
    if (!values.province || !values.district || !values.neighborhood) {
        console.log(USAGE);
        process.exit(1);
    }
    const store = new NeighborhoodStore(values.province, values.district, values.neighborhood);
    const meta = store.readMeta();
    if (!meta) throw new Error('meta.json yok; önce harvest çalıştırın.');
    const outDir = join(store.dir, 'licence-audit');
    mkdirSync(join(outDir, 'kml'), { recursive: true });
    const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

    // ── 1. TKGM: the library, plus the parcels asked for by number that it does not hold yet (one query each) ──
    let parcels = store.loadParcels().filter((p) => p.properties.inTargetNeighborhood);
    const requested = (values.parcels ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.split('/') as [string, string]);
    // Field notes: every parcel on the list belongs in the audit, so the ones the library lacks are fetched too.
    const notesPath = join(outDir, 'field-notes.csv');
    const fieldNotes = existsSync(notesPath) ? parseFieldNotes(readFileSync(notesPath, 'utf8')) : [];
    const notesDate = existsSync(notesPath) ? statSync(notesPath).mtime.toISOString().slice(0, 10) : '';
    for (const n of fieldNotes) if (!requested.some(([b, p]) => b === n.block && p === n.parcel)) requested.push([n.block, n.parcel]);
    const missing = requested.filter(([b, n]) => !parcels.some((p) => p.properties.block === b && p.properties.parcel === n));
    if (missing.length) {
        const neighborhoodId = parcels[0]?.properties.neighborhoodId;
        if (!neighborhoodId) throw new Error('Mahalle numarası (mahalleId) bilinmiyor: kütüphanede hiç parsel yok, önce harvest çalıştırın.');
        const client = new TkgmClient({ minIntervalMs: 1500, maxRetries: 2 });
        for (const [block, number] of missing) {
            try {
                const raw = await client.getParcelByNumber(neighborhoodId, Number(block), Number(number));
                if (!raw) {
                    console.log(`TKGM: ${block}/${number} bulunamadı.`);
                    continue;
                }
                const parcel = normalizeParcel(raw, meta.neighborhood);
                store.appendParcel(parcel);
                store.appendNumberProbe(parcel.properties.key, 'parcel');
                console.log(`TKGM: ${block}/${number} alındı · ${parcel.properties.nature} · ${parcel.properties.deedAreaM2} m²`);
            } catch (error) {
                if (error instanceof TkgmQuotaExceededError) {
                    console.log('TKGM günlük sorgu kotası doldu; kalan parseller yarın aynı komutla alınır.');
                    break;
                }
                throw error;
            }
        }
        parcels = store.loadParcels().filter((p) => p.properties.inTargetNeighborhood);
    }
    // Requested parcels stay in the audit on later runs.
    const requestedPath = join(outDir, 'requested.json');
    const kept = new Set<string>(existsSync(requestedPath) ? readJson<string[]>(requestedPath) : []);
    for (const [b, n] of requested) kept.add(`${b}/${n}`);
    writeFileSync(requestedPath, JSON.stringify([...kept].sort()));
    console.log(`Parsel: ${parcels.length}`);

    // ── 2. Detection: title-independent tea evidence (cached) and building footprints (cached) ──
    const evidencePath = join(outDir, 'tea-evidence.json');
    const buildingsPath = join(outDir, 'buildings.geojson');
    // The land-cover reading (py/cover_classify.py) is the tea reading in use where it exists: it was scored on parcels a
    // person looked at, the audit's own title-trained detector was not. `--tea-source title` forces the old detector.
    const coverPath = join(store.dir, 'land-cover', 'cover.json');
    const coverFile = values['tea-source'] !== 'title' && existsSync(coverPath) ? readJson<CoverFile>(coverPath) : null;
    const cover = coverFile && coverFile.version === 2 ? coverFile : null;
    const coverByKey = new Map((cover?.parcels ?? []).map((c) => [c.key, c]));
    let evidence = existsSync(evidencePath) && !values.refresh ? readJson<{ model: EvidenceModel; parcels: ParcelTeaEvidence[] }>(evidencePath) : null;
    // With the land-cover reading the cached detector output only fills display fields, so gaps in it do not matter.
    if (!cover && evidence && !parcels.every((p) => evidence!.parcels.some((e) => e.key === p.properties.key))) evidence = null;
    let buildings = existsSync(buildingsPath) && !values.refresh ? readJson<FeatureCollection<Poly, { areaM2: number }>>(buildingsPath).features : null;
    if ((!evidence && !cover) || !buildings) {
        const ee = await initEarthEngine();
        if (!buildings) {
            buildings = await fetchBuildings(ee, meta.boundary as Poly);
            writeFileSync(buildingsPath, JSON.stringify(featureCollection(buildings)));
            console.log(`Yapı izleri: ${buildings.length} (Microsoft bina izleri)`);
        }
        if (!evidence && !cover) {
            const districtDir = join(LIBRARY_ROOT, slugify(values.province), slugify(values.district));
            const pool = readdirSync(districtDir)
                .filter((n) => existsSync(join(districtDir, n, 'parcels.ndjson')))
                .map((n) => ({ neighborhood: n, parcels: new NeighborhoodStore(values.province as string, values.district as string, n).loadParcels() }));
            console.log(`Nitelikten bağımsız çay tespiti: eğitim havuzu ${pool.reduce((s, p) => s + p.parcels.length, 0)} parsel, ${pool.length} mahalle…`);
            evidence = await detectTeaEvidence(ee, { pool, targetBoundary: meta.boundary as Poly, targets: parcels });
            writeFileSync(evidencePath, JSON.stringify(evidence));
        }
    } else console.log('Tespit ve yapı izleri önbellekten.');
    const evidenceByKey = new Map((evidence?.parcels ?? []).map((e) => [e.key, e]));
    const m = evidence?.model ?? null;
    const used = cover?.model.used ?? null;
    if (cover) console.log(`Çay okuması: arazi tespiti modülü (${cover.generatedAt.slice(0, 10)})${used ? ` · sınama: çay ${used.teaFound}/${used.teaTotal}, çaysız ${used.noTeaRight}/${used.noTeaTotal}` : ''}`);
    /** The tea reading of one parcel from the source in use. */
    const readingOf = (props: Parcel['properties']): { share: number | null; areaM2: number | null; probability: number | null; beyondTraining: boolean; state: TeaState; elevationM: number | null; evergreen: number | null } => {
        const fullPixels = Math.floor(props.geometryAreaM2 / 100);
        const e = evidenceByKey.get(props.key) ?? null;
        if (!cover) {
            return { share: e?.teaShare ?? null, areaM2: e?.teaAreaM2 ?? null, probability: e?.teaProbability ?? null, beyondTraining: e?.beyondTraining ?? false, state: teaStateOf(e?.teaShare ?? null, e?.teaAreaM2 ?? null, fullPixels, props.geometryAreaM2), elevationM: e?.elevationM ?? null, evergreen: e?.evergreen ?? null };
        }
        const c = coverByKey.get(props.key) ?? null;
        // The audit's own thresholds (AUDIT_RULES) are applied to the land-cover share; a parcel the module could not read,
        // or read only from its surroundings (`context`), has no share and stays not assessable.
        const share = c?.teaShare ?? null;
        const areaM2 = share === null ? null : Math.round(share * props.geometryAreaM2);
        // Above this elevation the land-cover reading is weaker (snow in winter, no "no tea" reference parcel): a reading
        // there does not carry a finding on its own, as with the old detector above its training range.
        const beyondTraining = c?.elevationM != null && c.elevationM >= (cover.rules.highElevationM ?? Infinity);
        return { share, areaM2, probability: c?.teaProbability ?? null, beyondTraining, state: teaStateOf(share, areaM2, fullPixels, props.geometryAreaM2), elevationM: c?.elevationM ?? e?.elevationM ?? null, evergreen: c?.evidence?.winterRatio ?? e?.evergreen ?? null };
    };
    if (m) console.log(`Model (ayrılmış test): doğruluk %${Math.round(m.heldOut.accuracy * 100)} · çay yakalama %${Math.round(m.heldOut.teaRecall * 100)} · çay kesinlik %${Math.round(m.heldOut.teaPrecision * 100)} · eğitimdeki en yüksek çay ${m.maxTrainingTeaElevationM} m`);
    for (const g of m?.byGroup ?? []) console.log(`  ${g.group.padEnd(10)} ${String(g.pixels).padStart(5)} piksel · çay denen pay 0,5: ${g.calledTea['0.5']} · 0,6: ${g.calledTea['0.6']} · 0,7: ${g.calledTea['0.7']}`);

    // ── 3. ÇAYKUR licence register: the real list when supplied, else the demo registry ──
    const licenceByParcel = new Map<string, { areaM2: number; codes: string[] }>();
    const csvPath = join(outDir, 'caykur-licences.csv');
    let licenceSource: 'demo' | 'caykur' = 'demo';
    if (existsSync(csvPath)) {
        licenceSource = 'caykur';
        // ada;parsel;ruhsat_no;ruhsat_alani_m2 (header line, semicolon or comma separated)
        for (const line of readFileSync(csvPath, 'utf8').split(/\r?\n/).slice(1)) {
            const [block, number, code, areaText] = line.split(/[;,]/).map((s) => s.trim());
            if (!block || !number) continue;
            const key = `${block}/${number}`;
            const row = licenceByParcel.get(key) ?? { areaM2: 0, codes: [] };
            row.areaM2 += Number(areaText ?? 0) || 0;
            if (code) row.codes.push(code);
            licenceByParcel.set(key, row);
        }
    } else {
        const registryPath = join(store.dir, 'licensing', 'registry.json');
        if (existsSync(registryPath)) {
            const registry = readJson<{ gardens: Array<{ parcelKey: string; licenseCode: string | null; licensedAreaM2: number | null }> }>(registryPath);
            for (const g of registry.gardens) {
                if (!g.licenseCode) continue;
                const key = g.parcelKey.split('/').slice(1).join('/');
                const row = licenceByParcel.get(key) ?? { areaM2: 0, codes: [] };
                row.areaM2 += g.licensedAreaM2 ?? 0;
                if (!row.codes.includes(g.licenseCode)) row.codes.push(g.licenseCode);
                licenceByParcel.set(key, row);
            }
        }
    }
    const confirmationsPath = join(outDir, 'confirmations.json');
    type Confirmation = { block: string; parcel: string; tea: boolean | null; building?: boolean | null; sparse?: boolean; source: string; note?: string; date: string };
    const confirmations = existsSync(confirmationsPath) ? readJson<Confirmation[]>(confirmationsPath) : [];
    // A field note that speaks of tea or of a house is an observation; an expert confirmation for the same parcel stands above it.
    for (const n of fieldNotes) {
        if (n.tea === null && n.building === null) continue;
        const own = confirmations.find((c) => String(c.block) === n.block && String(c.parcel) === n.parcel);
        if (own) {
            own.building ??= n.building;
            own.sparse ??= n.sparse;
            continue;
        }
        confirmations.push({ block: n.block, parcel: n.parcel, tea: n.tea, building: n.building, sparse: n.sparse, source: 'arazi notu', note: n.note, date: notesDate });
    }
    const inventoryPath = join(store.dir, 'parcels-tea.geojson');
    const inventoryShare = new Map<string, number | null>(existsSync(inventoryPath) ? readJson<FeatureCollection<Poly, { key: string; teaShare: number | null }>>(inventoryPath).features.map((f) => [f.properties.key, f.properties.teaShare]) : []);

    // Scope: with the demo register only the parcels it was built on can be called licensed or not; the rest of the
    // library is left out, except parcels asked for by number (their "no licence" is marked unverified).
    const confirmationOf = (block: string, parcel: string) => confirmations.find((c) => String(c.block) === block && String(c.parcel) === parcel) ?? null;
    // DEMO register: the producer register's licences, extended to every parcel of the library (see demo-licences.ts).
    let demoLicences: DemoLicence[] | null = null;
    if (licenceSource === 'demo') {
        const pinsPath = join(outDir, 'demo-pins.json');
        const pins = existsSync(pinsPath) ? readJson<Record<string, boolean>>(pinsPath) : {};
        demoLicences = buildDemoLicences(
            parcels.map((p) => {
                const props = p.properties;
                const id = `${props.block}/${props.parcel}`;
                const e = readingOf(props);
                const conf = confirmationOf(props.block, props.parcel);
                const titleTea = readTitle(props.nature).tea;
                // Same reading as the decision takes when the detection is not conclusive: the side the share is nearer to.
                const readable = e.share !== null;
                const groundTea = conf && conf.tea !== null ? conf.tea : readable ? (e.share as number) >= (AUDIT_RULES.teaPresentShare + AUDIT_RULES.teaAbsentShare) / 2 : titleTea;
                return { key: props.key, block: props.block, parcel: props.parcel, parcelAreaM2: props.geometryAreaM2, titleTea, groundTea, teaAreaM2: e.areaM2, registry: licenceByParcel.get(id) ?? null, notedUnlicensed: fieldNotes.some((n) => n.block === props.block && n.parcel === props.parcel && n.unlicensed), pinned: pins[id] ?? null };
            }),
        );
        licenceByParcel.clear();
        for (const l of demoLicences) if (l.licensed) licenceByParcel.set(`${l.block}/${l.parcel}`, { areaM2: l.areaM2 ?? 0, codes: l.codes });
        writeFileSync(join(outDir, 'demo-licences.json'), JSON.stringify(demoLicences));
    }
    const tally = (items: string[]) => items.reduce<Record<string, number>>((h, x) => ((h[x] = (h[x] ?? 0) + 1), h), {});
    const scope = parcels;
    console.log(`Denetim kapsamı: ${scope.length} parsel${demoLicences ? ` · DEMO ruhsat kaydı: ${JSON.stringify(tally(demoLicences.map((l) => l.scenario)))} · kaynak ${JSON.stringify(tally(demoLicences.map((l) => l.origin)))}` : ''}`);

    // ── 4–6. Per parcel: read the title, compare, decide ──
    const R = AUDIT_RULES;
    const buildingBoxes = buildings.map((b) => turfBbox(b));
    const rows: AuditParcel[] = scope.map((p: Parcel) => {
        const props = p.properties;
        const e = evidenceByKey.get(props.key) ?? null;
        const fullPixels = Math.floor(props.geometryAreaM2 / 100);
        // Buildings: footprint area inside the parcel, and footprints within a few metres of it.
        const near = buffer(p, R.buildingNearM, { units: 'meters' }) as Feature<Poly>;
        const [w, s, east, n] = turfBbox(near);
        let insideM2 = 0;
        let count = 0;
        let touching = 0;
        buildings!.forEach((b, i) => {
            const box = buildingBoxes[i] as number[];
            if ((box[2] as number) < w || (box[0] as number) > east || (box[3] as number) < s || (box[1] as number) > n) return;
            const inside = intersect(featureCollection([p as Feature<Poly>, b as Feature<Poly>]));
            const insideArea = inside ? turfArea(inside) : 0;
            if (insideArea >= R.buildingInsideM2) {
                insideM2 += insideArea;
                count++;
            } else if (intersect(featureCollection([near, b as Feature<Poly>]))) touching++;
        });
        const conf = confirmationOf(props.block, props.parcel);
        // A person who saw the house stands above a footprint dataset that misses small houses under trees.
        const buildingState: BuildingState = conf?.building === true ? 'inside' : count > 0 ? 'inside' : touching > 0 ? 'boundary' : 'none';
        const lic = licenceByParcel.get(`${props.block}/${props.parcel}`) ?? null;
        const title = readTitle(props.nature);
        const reading = readingOf(props);
        const state = reading.state;
        const result = decide({
            title,
            licensed: !!lic,
            licensedAreaM2: lic?.areaM2 ?? null,
            parcelAreaM2: props.geometryAreaM2,
            licenceVerified: true,
            tea: { state, share: reading.share, areaM2: reading.areaM2, probability: reading.probability, fullPixels, beyondTraining: reading.beyondTraining, inventoryShare: inventoryShare.get(props.key) ?? null, confirmed: conf ? conf.tea : null, sparse: conf?.sparse ?? false },
            building: buildingState,
        });
        const base: Omit<AuditParcel, 'reason' | 'geometry'> = {
            key: props.key,
            block: props.block,
            parcel: props.parcel,
            nature: props.nature,
            locality: props.locality,
            areaM2: Math.round(props.geometryAreaM2),
            deedAreaM2: props.deedAreaM2,
            title,
            detection: {
                tea: state,
                teaShare: reading.share,
                teaAreaM2: reading.areaM2,
                teaProbability: reading.probability,
                inventoryShare: inventoryShare.get(props.key) ?? null,
                fullPixels,
                beyondTraining: reading.beyondTraining,
                ndviSummer: e?.ndviSummer ?? null,
                ndviLeafOff: e?.ndviLeafOff ?? null,
                evergreen: reading.evergreen,
                vhSummer: e?.vhSummer ?? null,
                elevationM: reading.elevationM,
                leafOffObs: e?.leafOffObs === null || e?.leafOffObs === undefined ? null : Math.round(e.leafOffObs),
            },
            building: { state: buildingState, count: count + touching, insideM2: Math.round(insideM2), source: 'Microsoft Global ML Building Footprints' },
            licence: { licensed: !!lic, areaM2: lic ? Math.round(lic.areaM2) : null, codes: lic?.codes ?? [], source: lic ? licenceSource : licenceSource },
            confirmation: conf ? { tea: conf.tea, building: conf.building ?? null, sparse: conf.sparse ?? false, source: conf.source, note: conf.note ?? '', date: conf.date } : null,
            ...result,
        };
        return { ...base, reason: reasonOf(base), geometry: p.geometry as Poly };
    });

    const decisions: AuditDecision[] = ['tea_land', 'licensing_error', 'unlicensed_tea', 'unlicensed_tea_titled', 'licence_no_tea', 'title_outdated', 'title_only', 'out_of_scope', 'needs_review'];
    const flags: AuditFile['summary']['flags'] = {};
    const byLeaning: Record<string, number> = {};
    for (const r of rows) {
        for (const f of r.flags) flags[f] = (flags[f] ?? 0) + 1;
        if (r.decision === 'needs_review') byLeaning[r.leaning] = (byLeaning[r.leaning] ?? 0) + 1;
    }
    const known = rows.filter((r) => r.consistency.tea !== 'unknown');
    const groundTea = (r: AuditParcel) => (r.confirmation && r.confirmation.tea !== null ? r.confirmation.tea : r.detection.tea === 'present');
    // Field notes that say "tea" against what the satellite reads on its own, and list titles against TKGM titles.
    const noted = fieldNotes.map((n) => ({ n, r: rows.find((x) => x.block === n.block && x.parcel === n.parcel) })).filter((x): x is { n: (typeof fieldNotes)[number]; r: AuditParcel } => !!x.r);
    const teaNoted = noted.filter((x) => x.n.tea === true);
    const fieldCheck: AuditFile['fieldCheck'] = fieldNotes.length
        ? {
              notes: noted.length,
              teaNoted: teaNoted.length,
              teaNotedDetected: teaNoted.filter((x) => x.r.detection.tea === 'present').length,
              teaNotedInconclusive: teaNoted.filter((x) => x.r.detection.tea === 'inconclusive' || x.r.detection.tea === 'not_assessable').length,
              teaNotedMissed: teaNoted.filter((x) => x.r.detection.tea === 'absent').length,
              titleMismatch: noted.filter((x) => readTitle(x.n.nature).tea !== x.r.title.tea).length,
          }
        : null;
    // Only the buildings near an audited parcel that matters go to the site (the rest stay in the cache file).
    const out: AuditFile = {
        generatedAt: new Date().toISOString(),
        method: 'Parsel başına üç bağımsız kaynak: TKGM tapu niteliği × ÇAYKUR ruhsat kaydı × uydudan çay okuması ve bina izleri (yapı). Sonuç eksper için işarettir; hukuki karar değildir.',
        rules: R,
        evidenceRules: EVIDENCE_RULES,
        model: m,
        teaSource: cover
            ? {
                  kind: 'land_cover',
                  generatedAt: cover.generatedAt,
                  reference: used ? { parcels: cover.model.reference.parcels, teaFound: used.teaFound, teaTotal: used.teaTotal, noTeaRight: used.noTeaRight, noTeaTotal: used.noTeaTotal, balanced: used.balanced } : null,
                  byElevation: cover.model.byElevation ?? [],
                  highElevationM: cover.rules.highElevationM ?? null,
                  note: 'Çay okuması arazi tespiti modülünden gelir: eğitim etiketleri tapudan değil, ağaç yüksekliği ile kış yeşilliğinin uzlaştığı piksellerden; sınama, bir kişinin baktığı parsellerle yapılmıştır (drone okumaları ve saha gözlemleri). Sınama seti küçüktür ve tek mahalledendir.',
              }
            : { kind: 'title_model', generatedAt: null, reference: null, byElevation: [], highElevationM: null, note: 'Çay okuması, tapu niteliğiyle eğitilmiş eski tespitten gelir; sayıları tapuyla uyumu ölçer, sahayı değil.' },
        licenceSource,
        demoLicences: demoLicences
            ? {
                  rules: DEMO_LICENCE_RULES,
                  byOrigin: tally(demoLicences.map((l) => l.origin)),
                  byScenario: tally(demoLicences.map((l) => l.scenario)),
                  note: 'DEMO ruhsat kaydı: demo müstahsil kaydındaki ruhsatlar korunur, kaydın ulaşmadığı parsellere genişletilir. Sahada çay olan parsellerin çoğu ruhsatlıdır; ruhsatsız çay, çaysız ruhsat ve hatalı ruhsat istisnadır. Kayıt, denetimin kullandığı tespitten üretildiği için sayılar mekanizmayı gösterir, gerçek durumu değil.',
              }
            : null,
        fieldCheck,
        buildingSource: 'Microsoft Global ML Building Footprints (Earth Engine topluluk kataloğu)',
        summary: {
            parcels: rows.length,
            byDecision: Object.fromEntries(decisions.map((d) => [d, rows.filter((r) => r.decision === d).length])) as Record<AuditDecision, number>,
            byConfidence: { high: rows.filter((r) => r.confidence === 'high').length, medium: rows.filter((r) => r.confidence === 'medium').length, low: rows.filter((r) => r.confidence === 'low').length },
            byLeaning,
            flags,
            titleVsGround: {
                titleTeaGroundTea: known.filter((r) => r.title.tea && groundTea(r)).length,
                titleTeaGroundNone: known.filter((r) => r.title.tea && !groundTea(r)).length,
                titleOtherGroundTea: known.filter((r) => !r.title.tea && groundTea(r)).length,
                titleOtherGroundNone: known.filter((r) => !r.title.tea && !groundTea(r)).length,
                unknown: rows.length - known.length,
            },
            areaM2: {
                unlicensedTea: rows.filter((r) => r.decision === 'unlicensed_tea' || r.decision === 'unlicensed_tea_titled').reduce((s, r) => s + (r.detection.teaAreaM2 ?? 0), 0),
                licensedNoTea: rows.filter((r) => r.decision === 'licensing_error' || r.decision === 'licence_no_tea').reduce((s, r) => s + (r.licence.areaM2 ?? 0), 0),
            },
        },
        parcels: rows,
        buildings: featureCollection(buildings) as FeatureCollection<Poly, { areaM2: number }>,
    };
    writeFileSync(join(outDir, 'audit.json'), JSON.stringify(out));

    // Google Earth: one KML per requested parcel (TKGM coordinates are WGS84 longitude/latitude, as KML expects).
    for (const [block, number] of requested) {
        const row = rows.find((r) => r.block === block && r.parcel === number);
        if (!row) continue;
        const path = join(outDir, 'kml', `${block}-${number}.kml`);
        writeFileSync(path, parcelKml([{ name: `${meta.neighborhood} ${block}/${number}`, description: `${DECISION_LABEL[row.decision]} · ${row.reason}`, geometry: row.geometry }], buildings.filter((b) => intersect(featureCollection([buffer(feature(row.geometry), 30, { units: 'meters' }) as Feature<Poly>, b as Feature<Poly>]))).map((b) => b.geometry)));
        console.log(`KML: ${path}`);
        console.log(`  ${block}/${number} → ${DECISION_LABEL[row.decision]} (güven: ${row.confidence})`);
        console.log(`  ${row.reason}`);
    }
    console.log(`Karar: ${decisions.map((d) => `${DECISION_LABEL[d]} ${out.summary.byDecision[d]}`).join(' · ')}`);
    console.log(`İncelemedekilerin eğilimi: ${JSON.stringify(byLeaning)}`);
    console.log(`Tapu × saha: çay/çay ${out.summary.titleVsGround.titleTeaGroundTea} · tapuda çay, sahada yok ${out.summary.titleVsGround.titleTeaGroundNone} · tapuda yok, sahada çay ${out.summary.titleVsGround.titleOtherGroundTea} · ikisinde de yok ${out.summary.titleVsGround.titleOtherGroundNone} · bilinmiyor ${out.summary.titleVsGround.unknown}`);
    if (fieldCheck) console.log(`Arazi notları: ${fieldCheck.notes} parsel · "çay var" denen ${fieldCheck.teaNoted}: uydu da çay görüyor ${fieldCheck.teaNotedDetected}, kararsız ${fieldCheck.teaNotedInconclusive}, görmüyor ${fieldCheck.teaNotedMissed} · liste niteliği TKGM ile uyuşmayan ${fieldCheck.titleMismatch}`);
    for (const x of noted) console.log(`  ${`${x.r.block}/${x.r.parcel}`.padEnd(7)} ${x.r.nature.padEnd(26)} not: ${(x.n.note || '—').padEnd(32)} uydu ${x.r.detection.teaShare === null ? '—' : `%${Math.round(x.r.detection.teaShare * 100)}`} (${x.r.detection.tea}) · ${x.r.licence.licensed ? 'ruhsatlı' : 'ruhsatsız'} → ${DECISION_LABEL[x.r.decision]} (${x.r.confidence})`);
    console.log(`Ruhsat kaynağı: ${licenceSource === 'demo' ? 'DEMO ruhsat kaydı (gerçek ÇAYKUR listesi verilmedi)' : 'ÇAYKUR listesi'} · işaretler ${JSON.stringify(flags)}`);
    console.log(`Çıktı: ${join(outDir, 'audit.json')}`);
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
