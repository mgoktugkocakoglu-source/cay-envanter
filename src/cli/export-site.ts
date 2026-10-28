import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { area, difference, feature, featureCollection, union } from '@turf/turf';
import type { Feature, FeatureCollection, Geometry, MultiPolygon, Polygon } from 'geojson';
import { NeighborhoodStore, slugify } from '../library/store.ts';
import { classify, type InventoryClass } from '../licensing/decision-matrix.ts';
import { currentGeometry, parcelLicenseView, type LicensingRegistry, type MatchLevel } from '../licensing/registry.ts';
import type { ParcelProperties } from '../tkgm/types.ts';
import { loadPruningForBundle, loadSeasonImagery } from '../pruning/bundle.ts';
import { loadProducersForBundle } from '../producers/bundle.ts';
import { loadRadarForBundle } from '../radar/bundle.ts';
import { loadFusionForBundle } from '../fusion/bundle.ts';
import { loadHealthForBundle } from '../health/bundle.ts';
import { loadLandForBundle } from '../land/bundle.ts';
import { loadAgeForBundle } from '../age/bundle.ts';

/**
 * Packs one neighborhood's inventory into a single JSON bundle for the cayhesabim site
 * (seeded by its tea-inventory module). Bundle format version 5 (v2 pruning, v3 producers, v4 multi-season
 * producers with event polygons, boundary status and the scene timeline, v5 the producer-centred
 * digital licence register: licences, licensed garden sub-polygons with three area measures,
 * lineage, boundary proposals/conflicts, geometry versions, applications, unlicensed tea).
 */

type Poly = Polygon | MultiPolygon;

interface TeaParcelProperties extends ParcelProperties {
    teaProbability: number | null;
    teaShare: number | null;
    teaAreaM2: number | null;
}

const USAGE = `
Kullanım:
  npm run export-site -- --province Trabzon --district Of --neighborhood Çataldere [--out <klasör>]
`;

const MATCH_RANK: Record<MatchLevel, number> = { exact: 0, historical: 1, probable: 2, unmatched: 3 };

const roundCoords = (geometry: Geometry): Geometry =>
    JSON.parse(JSON.stringify(geometry, (_key, value) => (typeof value === 'number' ? Math.round(value * 1e6) / 1e6 : value)));

/** Tea seen by the satellite that no licensed, resolved garden covers (spatial difference). */
function unlicensedTea(patches: Array<Feature<Poly, { areaM2: number }>>, registry: LicensingRegistry): Array<{ areaM2: number; geometry: Geometry }> {
    const licensed = registry.gardens.filter((g) => g.licensedAreaM2 !== null).map((g) => feature(currentGeometry(g)));
    const covered = licensed.length === 0 ? null : licensed.length === 1 ? licensed[0]! : union(featureCollection(licensed));
    const out: Array<{ areaM2: number; geometry: Geometry }> = [];
    for (const patch of patches) {
        const rest = covered ? difference(featureCollection([feature(patch.geometry), covered as Feature<Poly>])) : feature(patch.geometry);
        if (!rest) continue;
        const m2 = area(rest);
        if (m2 >= 100) out.push({ areaM2: Math.round(m2), geometry: roundCoords(rest.geometry) });
    }
    return out;
}

function main(): void {
    const { values } = parseArgs({
        options: {
            province: { type: 'string' },
            district: { type: 'string' },
            neighborhood: { type: 'string' },
            out: { type: 'string', default: join(process.cwd(), 'data', 'site') },
        },
    });
    if (!values.province || !values.district || !values.neighborhood) {
        console.log(USAGE);
        process.exit(1);
    }
    const store = new NeighborhoodStore(values.province, values.district, values.neighborhood);
    const meta = store.readMeta();
    if (!meta) {
        throw new Error('meta.json yok; önce harvest çalıştırın.');
    }
    const read = <T>(name: string): T => JSON.parse(readFileSync(join(store.dir, name), 'utf8')) as T;
    const parcels = read<FeatureCollection<Poly, TeaParcelProperties>>('parcels-tea.geojson').features;
    const patches = read<FeatureCollection<Poly, { areaM2: number }>>('tea-patches.geojson').features;
    const report = read<{ period: object; model: Record<string, unknown> }>('tea-report.json');
    const summary = read<{ neighborhoodId: number; coveredRatio: number; boundaryAreaM2: number }>('summary.json');
    const registryPath = join(store.dir, 'licensing', 'registry.json');
    if (!existsSync(registryPath)) {
        throw new Error('licensing/registry.json yok; önce build-licensing çalıştırın.');
    }
    const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as LicensingRegistry;

    const code = [meta.province, meta.district, meta.neighborhood].map(slugify).join('-');
    // The site serves season imagery as static files (apps/web/public/inventory-imagery/<code>/).
    const imageryBaseUrl = `/inventory-imagery/${code}/`;
    const pruning = loadPruningForBundle(store.dir, roundCoords, imageryBaseUrl);
    const producerName = new Map<string, string>();
    for (const p of loadProducersForBundle(store.dir, parcels.map((f) => ({ ...f.properties, geometry: f.geometry })), roundCoords, imageryBaseUrl, null)?.producers ?? []) {
        producerName.set(p.code, p.name);
    }

    const classCounts: Partial<Record<InventoryClass, number>> = {};
    const bundleParcels = parcels.map(({ geometry, properties: p }) => {
        const view = parcelLicenseView(registry, p.key);
        const onParcel = registry.gardens.filter((g) => g.parcelKey === p.key);
        const licenses = registry.licenses.filter((l) => onParcel.some((g) => g.licenseCode === l.code));
        const worstMatch = licenses.map((l) => l.matchLevel).sort((a, b) => MATCH_RANK[b] - MATCH_RANK[a])[0] ?? null;
        const inventoryClass = classify({
            nature: p.nature,
            geometryAreaM2: p.geometryAreaM2,
            teaShare: p.teaShare,
            teaAreaM2: p.teaAreaM2,
            licensedAreaM2: view.licensedAreaM2,
        });
        classCounts[inventoryClass] = (classCounts[inventoryClass] ?? 0) + 1;
        const primary = view.primary;
        return {
            key: p.key,
            block: p.block,
            parcel: p.parcel,
            nature: p.nature,
            locality: p.locality,
            deedAreaM2: p.deedAreaM2,
            geometryAreaM2: p.geometryAreaM2,
            teaProbability: p.teaProbability,
            teaShare: p.teaShare,
            teaAreaM2: p.teaAreaM2,
            inventoryClass,
            // Parcel-level licence view, derived from the producer-centred register.
            license: licenses.length === 0
                ? null
                : {
                    licenseNo: primary?.code ?? licenses[0]!.code,
                    walletNo: primary?.walletNo ?? licenses[0]!.walletNo,
                    holderName: producerName.get(primary?.producerCode ?? licenses[0]!.producerCode) ?? '',
                    holderDeceased: (primary ?? licenses[0]!).holderDeceased,
                    licensedAreaM2: view.licensedAreaM2,
                    issuedYear: (primary ?? licenses[0]!).issuedYear,
                    recordedParcelRef: (primary ?? licenses[0]!).recordedParcelRefs.join('; '),
                    licenseCount: licenses.length,
                    producerCount: new Set(onParcel.map((g) => g.producerCode)).size,
                    matchLevel: worstMatch,
                    pendingMatch: view.licensedAreaM2 === null,
                },
            pruning: pruning.parcels.get(p.key) ?? null,
            geometry: roundCoords(geometry),
        };
    });

    const unlicensed = unlicensedTea(patches, registry);
    const bundle = {
        version: 5,
        generatedAt: new Date().toISOString(),
        demoLicenses: true,
        area: {
            code,
            province: meta.province,
            district: meta.district,
            neighborhood: meta.neighborhood.replace(/\s+mah\.?$/i, ''),
            neighborhoodId: summary.neighborhoodId,
            boundary: roundCoords(meta.boundary),
            boundaryAreaM2: summary.boundaryAreaM2,
            coveredRatio: summary.coveredRatio,
            period: report.period,
            model: report.model,
        },
        parcels: bundleParcels,
        teaPatches: patches.map((f) => ({ areaM2: Math.round(f.properties.areaM2), geometry: roundCoords(f.geometry) })),
        unmatchedLicenses: registry.licenses
            .filter((l) => l.matchLevel === 'unmatched')
            .map((l) => ({
                licenseNo: l.code,
                walletNo: l.walletNo,
                holderName: producerName.get(l.producerCode) ?? '',
                holderDeceased: l.holderDeceased,
                licensedAreaM2: l.recordedAreaM2,
                issuedYear: l.issuedYear,
                recordedParcelRef: l.recordedParcelRefs.join('; '),
            })),
        pruning: pruning.area,
        producers: loadProducersForBundle(
            store.dir,
            parcels.map((f) => ({ ...f.properties, geometry: f.geometry })),
            roundCoords,
            imageryBaseUrl,
            registry,
        ),
        // Optional: Sentinel-1 confirmation of the optical pruning records (separate radar module).
        radar: loadRadarForBundle(store.dir),
        // Optional: multi-sensor step-change verdicts per garden / producer (fusion module).
        fusion: loadFusionForBundle(store.dir),
        // Optional: growing-season health, anomaly and yield estimates (garden-health module).
        health: loadHealthForBundle(store.dir),
        // Optional: land evaluation (Toprak Koruma ve Arazi Değerlendirme module).
        land: loadLandForBundle(store.dir),
        // Optional: garden age, renewal and abandonment (Landsat 1984→ + Sentinel-2 activity).
        age: loadAgeForBundle(store.dir),
        licensing: {
            demo: true,
            generatedAt: registry.generatedAt,
            rules: registry.rules,
            lineage: registry.lineage,
            licenses: registry.licenses,
            gardens: registry.gardens.map((g) => ({
                ...g,
                versions: g.versions.map((v) => ({ ...v, geometry: roundCoords(v.geometry) })),
                proposal: g.proposal ? { ...g.proposal, geometry: roundCoords(g.proposal.geometry) } : null,
            })),
            conflicts: registry.conflicts.map((c) => ({ ...c, geometry: roundCoords(c.geometry) })),
            applications: registry.applications,
            unlicensedTea: unlicensed,
        },
    };

    mkdirSync(values.out, { recursive: true });
    const outPath = join(values.out, `${bundle.area.code}.json`);
    writeFileSync(outPath, JSON.stringify(bundle));
    console.log(`Sınıflar: ${JSON.stringify(classCounts)}`);
    console.log(`Ruhsat kaydı: ${registry.licenses.length} ruhsat, ${registry.gardens.length} bahçe, ${registry.applications.length} başvuru; ruhsatsız çay ${Math.round(unlicensed.reduce((s, u) => s + u.areaM2, 0) / 1000)} da (${unlicensed.length} alan)`);
    console.log(`Radar teyidi: ${bundle.radar ? bundle.radar.seasons.map((s) => `${s.season} (${s.records.length} kayıt)`).join(', ') : 'yok'}`);
    console.log(`Çok-sensör karar: ${bundle.fusion ? bundle.fusion.seasons.map((s) => `${s.season} (${s.gardens.length} bahçe)`).join(', ') : 'yok'}`);
    console.log(`Bahçe sağlığı: ${bundle.health ? bundle.health.seasons.map((s) => `${s.season} (${s.gardens.length} bahçe)`).join(', ') : 'yok'}`);
    console.log(`Arazi değerlendirme: ${bundle.land ? `${bundle.land.parcels.length} parsel` : 'yok'} · bahçe yaşı: ${bundle.age ? `${bundle.age.parcels.length} parsel` : 'yok'}`);
    console.log(`Paket: ${outPath}`);

    const imagery = loadSeasonImagery(store.dir);
    if (imagery) {
        const imageryOut = join(values.out, 'imagery', code);
        mkdirSync(imageryOut, { recursive: true });
        const files = Object.values(imagery.seasons).flatMap((layers) => Object.values(layers).map((l) => l.file));
        for (const file of files) {
            copyFileSync(join(store.dir, 'pruning', 'imagery', file), join(imageryOut, file));
        }
        console.log(`Sezon görüntüleri (${files.length}): ${imageryOut} → sitede apps/web/public${imageryBaseUrl}`);
        const scenesIndex = join(store.dir, 'pruning', 'imagery', 'scenes', 'index.json');
        if (existsSync(scenesIndex)) {
            const scenes = JSON.parse(readFileSync(scenesIndex, 'utf8')) as { seasons: Record<string, Array<{ file: string }>> };
            let count = 0;
            for (const entries of Object.values(scenes.seasons)) {
                for (const { file } of entries) {
                    mkdirSync(join(imageryOut, 'scenes', file.split('/')[0] as string), { recursive: true });
                    copyFileSync(join(store.dir, 'pruning', 'imagery', 'scenes', file), join(imageryOut, 'scenes', file));
                    count++;
                }
            }
            console.log(`Sahne zaman çizelgesi: ${count} görüntü`);
        }
    }
}

main();
