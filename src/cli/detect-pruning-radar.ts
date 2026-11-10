import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { initEarthEngine } from '../ee/session.ts';
import { pruningWindows } from '../ee/pruning.ts';
import { NeighborhoodStore } from '../library/store.ts';
import { buildDemoProducers, loadDemoLayout } from '../producers/demo-producers.ts';
import { currentGeometry, type LicensingRegistry } from '../licensing/registry.ts';
import { backscatterSeries, type OrbitPass, type PassSeries } from '../radar/series.ts';
import { RADAR_RULES, radarOnlyCandidate, relativeCoherence, relativeSeries, scoreEvent, type RadarResult, type RelativeSeries } from '../radar/score.ts';

/** Output of py/coherence/run.py (SNAP, `cohWin`) or py/hyp3_coherence.py (HyP3, `looks`): per-pass pair coherence averaged per garden. */
interface CoherenceFile {
    season: string;
    source?: string;
    cohWin?: [number, number];
    looks?: string;
    passes: Array<{ pass: OrbitPass; relativeOrbit: number; relativeOrbits?: number[]; burstId: string; pairs: Array<[string, string]> }>;
    gardens: Record<string, Record<string, Array<number | null>>>;
}

type Poly = Polygon | MultiPolygon;

const USAGE = `
Kullanım:
  npm run detect-pruning-radar -- --province Trabzon --district Of --neighborhood Çataldere --season 2025

Ayrı modül: mevcut optik tarama (scan-producers) çıktısına dokunmaz. Sezonun Sentinel-1 GRD
(VV/VH) serilerini bahçe bazında, yörünge yönüne göre ayrı çeker; çayır biçme tespiti yöntemiyle
(komşuluğa göreli VH ve VH/VV düşüşü + kalıcılık) her optik budama kaydına radar teyidi yazar ve
optik kaydı olmayan bahçelerde yalnız-radar adayları listeler. Çıktı: pruning-radar/season-<yyyy-yy>.json
`;

interface SeasonScanFile {
    season: string;
    events: Array<{ gardenId: string; areaM2: number; lastNoChangeAt: string | null; firstChangeAt: string | null; detectedAt: string | null }>;
    gardens: Array<{ id: string; teaAreaM2: number }>;
}

export interface RadarSeasonFile {
    season: string;
    rules: typeof RADAR_RULES;
    window: [string, string];
    passes: Array<{ pass: OrbitPass; relativeOrbit: number; dates: string[]; cohDates?: string[] }>;
    /** Coherence (SNAP burst pairs) when py/coherence/run.py has run for the season. */
    coherence: { cohWin: [number, number]; source?: string; pairs: Record<OrbitPass, number> } | null;
    /** Per garden: relative VH / ratio (and coherence) series per pass (for the site's sparkline). */
    series: Record<string, Array<{ pass: OrbitPass; vhRel: Array<number | null>; ratioRel: Array<number | null>; cohRel?: Array<number | null> }>>;
    records: Array<{ recordId: string; gardenId: string; radar: RadarResult }>;
    radarOnly: Array<{ gardenId: string; date: string; vhDropDb: number; persistence: number; z: number }>;
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: { province: { type: 'string' }, district: { type: 'string' }, neighborhood: { type: 'string' }, season: { type: 'string', default: '2025' } },
    });
    if (!values.province || !values.district || !values.neighborhood) {
        console.log(USAGE);
        process.exit(1);
    }
    const store = new NeighborhoodStore(values.province, values.district, values.neighborhood);
    const meta = store.readMeta();
    if (!meta) throw new Error('meta.json yok; önce harvest çalıştırın.');
    const windows = pruningWindows(Number(values.season));
    const scanPath = join(store.dir, 'producers', `season-${windows.season}.json`);
    if (!existsSync(scanPath)) throw new Error(`${scanPath} yok; önce scan-producers çalıştırın.`);
    const scan = JSON.parse(readFileSync(scanPath, 'utf8')) as SeasonScanFile;

    // Garden geometries: the licensed tea sub-polygon when the register exists, else the demo slice.
    const parcels = JSON.parse(readFileSync(join(store.dir, 'parcels-tea.geojson'), 'utf8')) as FeatureCollection<Poly, { key: string; block: string; parcel: string; teaAreaM2: number | null }>;
    const { gardens: slices } = buildDemoProducers(parcels.features.map((f) => ({ ...f.properties, geometry: f.geometry })), 2026, loadDemoLayout(store.dir));
    const registryPath = join(store.dir, 'licensing', 'registry.json');
    const registry = existsSync(registryPath) ? (JSON.parse(readFileSync(registryPath, 'utf8')) as LicensingRegistry) : null;
    const byCode = new Map(registry?.gardens.map((g) => [g.code, g]) ?? []);
    const gardens = slices.map((g) => ({ id: g.id, geometry: (byCode.get(g.id) ? currentGeometry(byCode.get(g.id)!) : g.geometry) as Poly }));
    console.log(`Sezon ${windows.season}: ${gardens.length} bahçe, ${scan.events.length} optik budama kaydı`);

    // Radar window: before-window ahead of the reference, after-window past the spring step.
    const window: [string, string] = [`${values.season}-09-01`, `${Number(values.season) + 1}-05-15`];
    const ee = await initEarthEngine();
    const region = ee.Geometry(meta.boundary);
    const passes: PassSeries[] = [];
    for (const pass of ['ASCENDING', 'DESCENDING'] as OrbitPass[]) {
        console.log(`Sentinel-1 ${pass} serisi çekiliyor…`);
        const s = await backscatterSeries(ee, region, gardens, window, pass);
        if (s) {
            passes.push(s);
            console.log(`  yörünge ${s.relativeOrbit}: ${s.dates.length} tarih (${s.dates[0]} → ${s.dates.at(-1)})`);
        } else {
            console.log('  sahne yok');
        }
    }
    if (passes.length === 0) throw new Error('Sentinel-1 sahnesi bulunamadı.');

    const relative = passes.map((p) => relativeSeries(p));

    // Coherence channel (optional): neighbourhood-relative pair coherence joins the pass series.
    const cohPath = [join(store.dir, 'pruning-radar', `coherence-hyp3-${windows.season}.json`), join(store.dir, 'pruning-radar', `coherence-${windows.season}.json`)].find((p) => existsSync(p)) ?? join(store.dir, 'pruning-radar', `coherence-${windows.season}.json`);
    const coherence = existsSync(cohPath) ? (JSON.parse(readFileSync(cohPath, 'utf8')) as CoherenceFile) : null;
    const cohDatesByPass = new Map<OrbitPass, string[]>();
    if (coherence) {
        for (const cp of coherence.passes) {
            const byGarden: Record<string, Array<number | null>> = {};
            for (const [id, perPass] of Object.entries(coherence.gardens)) byGarden[id] = perPass[cp.pass] ?? [];
            const rel = relativeCoherence(cp.pairs, byGarden);
            const target = relative[passes.findIndex((p) => p.pass === cp.pass)];
            if (!target) continue;
            for (const [id, r] of Object.entries(rel)) {
                if (target[id]) Object.assign(target[id], r);
            }
            cohDatesByPass.set(cp.pass, cp.pairs.map(([, d2]) => d2));
            console.log(`Koherans ${cp.pass}: ${cp.pairs.length} çift (yörünge ${(cp.relativeOrbits ?? [cp.relativeOrbit]).join('+')}, ${coherence.cohWin ? `pencere ${coherence.cohWin.join('×')}` : `${coherence.source ?? 'hyp3'} ${coherence.looks ?? ''} bakış`})`);
        }
    } else {
        console.log('Koherans dosyası yok (py/coherence/run.py); yalnız geri saçılım kullanılıyor.');
    }
    const seriesOf = (id: string): RelativeSeries[] => relative.map((r) => r[id]).filter((s): s is RelativeSeries => !!s);

    // Scan records the feed never dated (change seen only in the season-end comparison) borrow the
    // change window of the multi-sensor verdict when one exists from an earlier fuse-pruning run;
    // the fusion stage is re-run after this one anyway, so the window is never stale by more than a run.
    const fusionPath = join(store.dir, 'pruning-fusion', `season-${windows.season}.json`);
    const fusionWindow = new Map<string, { lastBeforeAt: string | null; firstAfterAt: string | null }>();
    if (existsSync(fusionPath)) {
        const fusion = JSON.parse(readFileSync(fusionPath, 'utf8')) as { gardens: Array<{ id: string; verdict: { class: string; lastBeforeAt: string | null; firstAfterAt: string | null } }> };
        for (const g of fusion.gardens) if (g.verdict.firstAfterAt && g.verdict.class !== 'no_data') fusionWindow.set(g.id, { lastBeforeAt: g.verdict.lastBeforeAt, firstAfterAt: g.verdict.firstAfterAt });
    }
    const records: RadarSeasonFile['records'] = [];
    const counts: Record<string, number> = {};
    let borrowed = 0;
    for (const e of scan.events) {
        const fw = !e.firstChangeAt ? fusionWindow.get(e.gardenId) : undefined;
        const radar = fw
            ? { ...scoreEvent(seriesOf(e.gardenId), fw.lastBeforeAt, fw.firstAfterAt), windowSource: 'fusion' as const }
            : { ...scoreEvent(seriesOf(e.gardenId), e.lastNoChangeAt, e.firstChangeAt), windowSource: 'scan' as const };
        if (fw) borrowed++;
        counts[radar.class] = (counts[radar.class] ?? 0) + 1;
        // Record ids follow the site: one event per garden per season.
        records.push({ recordId: `${e.gardenId}:${windows.season}:1`, gardenId: e.gardenId, radar });
    }
    if (borrowed > 0) console.log(`${borrowed} tarihsiz kayıt füzyon değişim penceresiyle puanlandı`);
    const withEvent = new Set(scan.events.map((e) => e.gardenId));
    const radarOnly: RadarSeasonFile['radarOnly'] = [];
    for (const g of gardens) {
        if (withEvent.has(g.id)) continue;
        const c = radarOnlyCandidate(seriesOf(g.id));
        if (c) radarOnly.push({ ...c, gardenId: g.id });
    }

    const out: RadarSeasonFile = {
        season: windows.season,
        rules: RADAR_RULES,
        window,
        passes: passes.map((p) => ({ pass: p.pass, relativeOrbit: p.relativeOrbit, dates: p.dates, cohDates: cohDatesByPass.get(p.pass) })),
        coherence: coherence
            ? { cohWin: coherence.cohWin ?? [5, 1], source: coherence.source ?? 'snap', pairs: Object.fromEntries(coherence.passes.map((cp) => [cp.pass, cp.pairs.length])) as Record<OrbitPass, number> }
            : null,
        series: Object.fromEntries(gardens.map((g) => [g.id, seriesOf(g.id).map((s) => ({ pass: s.pass, vhRel: s.vhRel, ratioRel: s.ratioRel, cohRel: s.cohRel }))])),
        records,
        radarOnly,
    };
    const outDir = join(store.dir, 'pruning-radar');
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, `season-${windows.season}.json`);
    writeFileSync(outPath, JSON.stringify(out));
    console.log(`Radar teyidi: ${JSON.stringify(counts)} · yalnız-radar aday ${radarOnly.length}`);
    console.log(`Çıktı: ${outPath}`);
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
