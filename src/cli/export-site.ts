import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { FeatureCollection, Geometry, MultiPolygon, Polygon } from 'geojson';
import { NeighborhoodStore, slugify } from '../library/store.ts';
import { buildDemoLicenses, type DemoLicense } from '../licensing/demo-licenses.ts';
import { classify, type InventoryClass } from '../licensing/decision-matrix.ts';
import type { ParcelProperties } from '../tkgm/types.ts';

/**
 * Packs one neighborhood's inventory into a single JSON bundle for the cayhesabim site
 * (seeded by its tea-inventory module). Bundle format version 1.
 */

interface TeaParcelProperties extends ParcelProperties {
    teaProbability: number | null;
    teaShare: number | null;
    teaAreaM2: number | null;
}

const USAGE = `
Kullanım:
  npm run export-site -- --province Trabzon --district Of --neighborhood Çataldere [--out <klasör>]
`;

const roundCoords = (geometry: Geometry): Geometry =>
    JSON.parse(JSON.stringify(geometry, (_key, value) => (typeof value === 'number' ? Math.round(value * 1e6) / 1e6 : value)));

const licenseView = (license: DemoLicense) => ({
    licenseNo: license.licenseNo,
    walletNo: license.walletNo,
    holderName: license.holderName,
    holderDeceased: license.holderDeceased,
    licensedAreaM2: license.licensedAreaM2,
    issuedYear: license.issuedYear,
    recordedParcelRef: license.recordedParcelRef,
});

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
    const parcels = read<FeatureCollection<Polygon | MultiPolygon, TeaParcelProperties>>('parcels-tea.geojson').features;
    const patches = read<FeatureCollection<Polygon | MultiPolygon, { areaM2: number }>>('tea-patches.geojson').features;
    const report = read<{ period: object; model: Record<string, unknown> }>('tea-report.json');
    const summary = read<{ neighborhoodId: number; coveredRatio: number; boundaryAreaM2: number }>('summary.json');

    const licenses = buildDemoLicenses(parcels.map((p) => p.properties));
    const licenseByParcel = new Map(licenses.filter((l) => l.parcelKey).map((l) => [l.parcelKey as string, l]));

    const classCounts: Partial<Record<InventoryClass, number>> = {};
    const bundleParcels = parcels.map(({ geometry, properties: p }) => {
        const license = licenseByParcel.get(p.key) ?? null;
        const inventoryClass = classify({
            nature: p.nature,
            geometryAreaM2: p.geometryAreaM2,
            teaShare: p.teaShare,
            teaAreaM2: p.teaAreaM2,
            licensedAreaM2: license?.licensedAreaM2 ?? null,
        });
        classCounts[inventoryClass] = (classCounts[inventoryClass] ?? 0) + 1;
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
            license: license ? licenseView(license) : null,
            geometry: roundCoords(geometry),
        };
    });

    const bundle = {
        version: 1,
        generatedAt: new Date().toISOString(),
        demoLicenses: true,
        area: {
            code: [meta.province, meta.district, meta.neighborhood].map(slugify).join('-'),
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
        unmatchedLicenses: licenses.filter((l) => !l.parcelKey).map(licenseView),
    };

    mkdirSync(values.out, { recursive: true });
    const outPath = join(values.out, `${bundle.area.code}.json`);
    writeFileSync(outPath, JSON.stringify(bundle));
    console.log(`Sınıflar: ${JSON.stringify(classCounts)}`);
    console.log(`Demo ruhsat: ${licenses.length} (eşleşmeyen ${bundle.unmatchedLicenses.length})`);
    console.log(`Paket: ${outPath}`);
}

main();
