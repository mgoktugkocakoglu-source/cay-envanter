import { parseArgs } from 'node:util';
import { TkgmClient } from '../tkgm/client.ts';
import type { AdminUnit } from '../tkgm/types.ts';
import { harvestNeighborhood } from '../harvest/harvest-neighborhood.ts';
import { NeighborhoodStore, slugify } from '../library/store.ts';
import { buildSummary } from '../library/summary.ts';
import { area } from '@turf/turf';

const USAGE = `
Kullanım:
  npm run harvest -- --province Trabzon --district Of [--neighborhood Çataldere]
                     [--min-interval-ms 1000] [--max-requests 500]

--neighborhood verilmezse ilçedeki tüm mahalleler sırayla çekilir (ilçe kütüphanesi).
Yarıda kesilen iş aynı komutla kaldığı yerden devam eder.
`;

function findUnit(units: AdminUnit[], name: string, kind: string): AdminUnit {
    const unit = units.find((u) => slugify(u.name) === slugify(name));
    if (!unit) {
        throw new Error(`${kind} bulunamadı: "${name}". Seçenekler: ${units.map((u) => u.name).join(', ')}`);
    }
    return unit;
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            province: { type: 'string' },
            district: { type: 'string' },
            neighborhood: { type: 'string' },
            'min-interval-ms': { type: 'string', default: '1000' },
            'max-requests': { type: 'string' },
        },
    });
    if (!values.province || !values.district) {
        console.log(USAGE);
        process.exit(1);
    }
    const minIntervalMs = Math.max(Number(values['min-interval-ms']), 500);
    const maxRequests = values['max-requests'] ? Number(values['max-requests']) : Number.POSITIVE_INFINITY;
    const client = new TkgmClient({ minIntervalMs, maxRetries: 5 });

    const province = findUnit(await client.listProvinces(), values.province, 'İl');
    const district = findUnit(await client.listDistricts(province.id), values.district, 'İlçe');
    const allNeighborhoods = await client.listNeighborhoods(district.id);
    const neighborhoods = values.neighborhood
        ? [findUnit(allNeighborhoods, values.neighborhood, 'Mahalle')]
        : allNeighborhoods;

    console.log(`${province.name} / ${district.name}: ${neighborhoods.length} mahalle, istek aralığı ${minIntervalMs} ms`);
    let remainingRequests = maxRequests;
    for (const [index, neighborhood] of neighborhoods.entries()) {
        const store = new NeighborhoodStore(province.name, district.name, neighborhood.name);
        const meta = {
            province: province.name,
            district: district.name,
            neighborhood: neighborhood.name,
            neighborhoodGuid: neighborhood.id,
            boundary: neighborhood.geometry,
        };
        store.writeMeta(meta);
        console.log(`[${index + 1}/${neighborhoods.length}] ${neighborhood.name} → ${store.dir}`);

        const before = client.requestCount;
        const result = await harvestNeighborhood(client, meta, store, { maxRequests: remainingRequests });
        remainingRequests -= client.requestCount - before;

        const boundaryAreaM2 = area(meta.boundary);
        const summary = buildSummary(meta, result, boundaryAreaM2);
        store.writeSummary(summary);
        store.writeGeoJson('parcels.geojson', result.parcels.filter((p) => p.properties.inTargetNeighborhood));
        store.writeGeoJson('neighbor-parcels.geojson', result.parcels.filter((p) => !p.properties.inTargetNeighborhood));
        console.log(
            `  ${result.outcome}: ${summary.parcels.inNeighborhood} parsel, ` +
                `çay nitelikli ${summary.teaTitled.count}, kapsama %${(result.coveredRatio * 100).toFixed(1)}`,
        );
        if (result.outcome === 'request_limit') {
            console.log('İstek limitine ulaşıldı. Aynı komutla devam edebilirsiniz.');
            break;
        }
        if (result.outcome === 'daily_quota') {
            console.log('TKGM günlük sorgu kotası doldu. Yarın aynı komutla kaldığı yerden devam edin.');
            break;
        }
    }
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
