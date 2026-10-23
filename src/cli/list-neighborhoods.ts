import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { area, booleanIntersects, centroid, distance, feature } from '@turf/turf';
import { TkgmClient } from '../tkgm/client.ts';
import { LIBRARY_ROOT, slugify } from '../library/store.ts';

const USAGE = `
Kullanım:
  npm run neighborhoods -- --province Trabzon --district Of [--near Çataldere] [--limit 30]

İlçenin mahallelerini (TKGM idari sınır listesi, önbellekten) alan, kütüphane durumu ve --near verilen
mahalleye uzaklık/komşuluk ile listeler; genişleme sırasını seçmek için.
`;

interface SummaryFile {
    outcome?: string;
    coveredRatio?: number;
    parcels?: { inNeighborhood?: number };
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: { province: { type: 'string' }, district: { type: 'string' }, near: { type: 'string' }, limit: { type: 'string', default: '30' } },
    });
    if (!values.province || !values.district) {
        console.log(USAGE);
        process.exit(1);
    }
    const client = new TkgmClient({ minIntervalMs: 1000, maxRetries: 3 });
    const find = <T extends { name: string }>(units: T[], name: string, kind: string): T => {
        const unit = units.find((u) => slugify(u.name) === slugify(name));
        if (!unit) throw new Error(`${kind} bulunamadı: ${name}`);
        return unit;
    };
    const province = find(await client.listProvinces(), values.province, 'İl');
    const district = find(await client.listDistricts(province.id), values.district, 'İlçe');
    const units = await client.listNeighborhoods(district.id);
    const near = values.near ? find(units, values.near, 'Mahalle') : null;
    const nearFeature = near ? feature(near.geometry) : null;
    const nearCentroid = nearFeature ? centroid(nearFeature) : null;

    const rows = units.map((u) => {
        const f = feature(u.geometry);
        const dir = join(LIBRARY_ROOT, slugify(province.name), slugify(district.name), slugify(u.name));
        const summaryPath = join(dir, 'summary.json');
        const summary = existsSync(summaryPath) ? (JSON.parse(readFileSync(summaryPath, 'utf8')) as SummaryFile) : null;
        const bundle = join(process.cwd(), 'data', 'site', `${slugify(province.name)}-${slugify(district.name)}-${slugify(u.name)}.json`);
        return {
            name: u.name,
            ha: Math.round(area(f) / 1e4),
            distKm: nearCentroid ? distance(nearCentroid, centroid(f)) : null,
            adjacent: nearFeature && u !== near ? booleanIntersects(f, nearFeature) : false,
            parcels: summary?.parcels?.inNeighborhood ?? null,
            covered: summary?.coveredRatio ?? null,
            complete: summary?.outcome === 'complete',
            exported: existsSync(bundle),
        };
    });
    rows.sort((a, b) => (a.distKm ?? 0) - (b.distKm ?? 0) || a.name.localeCompare(b.name, 'tr'));

    console.log(`${province.name} / ${district.name}: ${units.length} mahalle${near ? `, ${near.name} merkezli` : ''}`);
    console.log('durum  uzaklık  komşu  alan(ha)  parsel  kapsama  mahalle');
    for (const r of rows.slice(0, Number(values.limit))) {
        const status = r.exported ? 'SİTE ' : r.parcels !== null ? 'KÜTÜP' : '     ';
        const cov = r.covered === null ? '    —' : `%${(r.covered * 100).toFixed(0).padStart(3)}${r.complete ? '✓' : ' '}`;
        console.log(
            `${status}  ${r.distKm === null ? '   —  ' : `${r.distKm.toFixed(1).padStart(5)} km`}  ${r.adjacent ? ' evet' : '     '}  ${String(r.ha).padStart(8)}  ${String(r.parcels ?? '—').padStart(6)}  ${cov}  ${r.name}`,
        );
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
