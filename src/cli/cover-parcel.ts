import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { buildCoverExtras, buildCoverFeatures, COVER_RULES } from '../cover/features.ts';
import { evaluate, initEarthEngine } from '../ee/session.ts';
import { NeighborhoodStore } from '../library/store.ts';
import { TkgmClient, TkgmQuotaExceededError } from '../tkgm/client.ts';
import { normalizeParcel } from '../tkgm/normalize.ts';
import type { Parcel } from '../tkgm/types.ts';

/* `ee` objects are untyped (see src/types/earthengine.d.ts). */
type EE = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const USAGE = `
Kullanım:
  npm run cover-parcel -- --province Trabzon --district Of --neighborhood Çataldere --parcels "252/30,117/3"

Arazi örtüsü modülüne tek tek parsel ekler:
  1. Kütüphanede olmayan parsel TKGM'den ada/parsel ile alınır (parsel başına TEK sorgu; günlük kota dolarsa durur).
  2. Parselin pikselleri Earth Engine'de örneklenir ve land-cover/pixels.csv ile pixels-extra.csv dosyalarına eklenir.
Sonra: .venv/Scripts/python.exe py/cover_classify.py <mahalle klasörü>  (parsel okuması cover.json içinde çıkar)
`;

async function main(): Promise<void> {
    const { values } = parseArgs({ options: { province: { type: 'string' }, district: { type: 'string' }, neighborhood: { type: 'string' }, parcels: { type: 'string' } } });
    if (!values.province || !values.district || !values.neighborhood || !values.parcels) {
        console.log(USAGE);
        process.exit(1);
    }
    const store = new NeighborhoodStore(values.province, values.district, values.neighborhood);
    const meta = store.readMeta();
    if (!meta) throw new Error('Mahalle kütüphanede yok; önce harvest çalıştırın.');
    const wanted = values.parcels.split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.split('/') as [string, string]);
    let library = store.loadParcels();
    const find = (block: string, number: string) => library.find((p) => p.properties.block === block && p.properties.parcel === number);

    // 1. TKGM, one query per parcel the library lacks
    const missing = wanted.filter(([b, n]) => !find(b, n));
    if (missing.length) {
        const neighborhoodId = library.find((p) => p.properties.inTargetNeighborhood)?.properties.neighborhoodId;
        if (!neighborhoodId) throw new Error('Mahalle numarası bilinmiyor: kütüphanede hiç parsel yok.');
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
                console.log(`TKGM: ${block}/${number} alındı · ${parcel.properties.nature} · tapu ${parcel.properties.deedAreaM2} m² · geometri ${Math.round(parcel.properties.geometryAreaM2)} m²`);
            } catch (error) {
                if (error instanceof TkgmQuotaExceededError) {
                    console.log('TKGM günlük sorgu kotası doldu; kalan parseller yarın aynı komutla alınır.');
                    break;
                }
                throw error;
            }
        }
        library = store.loadParcels();
    }

    // 2. Earth Engine: the parcel's pixels, appended to the two aligned files
    const coverDir = join(store.dir, 'land-cover');
    const pixelsPath = join(coverDir, 'pixels.csv');
    const extraPath = join(coverDir, 'pixels-extra.csv');
    if (!existsSync(pixelsPath) || !existsSync(extraPath)) throw new Error('land-cover/pixels.csv yok; önce "npm run sample-cover" çalıştırın.');
    const header = (readFileSync(pixelsPath, 'utf8').split('\n', 1)[0] as string).split(',');
    const extraHeader = (readFileSync(extraPath, 'utf8').split('\n', 1)[0] as string).split(',');
    const have = new Set(readFileSync(pixelsPath, 'utf8').split('\n').slice(1).map((l) => l.slice(0, l.indexOf(','))));
    const targets = wanted.map(([b, n]) => find(b, n)).filter((p): p is Parcel => !!p && !have.has(p.properties.key));
    if (!targets.length) {
        console.log('Örneklenecek yeni parsel yok (istenen parseller zaten pixels.csv içinde ya da TKGM\'de bulunamadı).');
        return;
    }
    const ee: EE = await initEarthEngine();
    const region = ee.FeatureCollection(targets.map((t) => ee.Feature(ee.Geometry(t.geometry)))).geometry(1).bounds(1).buffer(200);
    const { features, extras } = buildCoverFeatures(ee, region);
    // Two requests, as in sample-cover: the Sentinel stack over the parcel, then the external layers at those pixel centres.
    const stack = features.addBands(extras.select(['elevation', 'lon', 'lat']));
    const columns = header.slice(1);
    const sampled = stack.sampleRegions({ collection: ee.FeatureCollection(targets.map((p, n) => ee.Feature(ee.Geometry(p.geometry), { pid: n }))), properties: ['pid'], scale: COVER_RULES.scaleM, tileScale: 8 });
    const rows = (await evaluate<{ list: number[][] }>(sampled.reduceColumns({ reducer: ee.Reducer.toList(columns.length + 1), selectors: ['pid', ...columns] }))).list;
    const lonAt = columns.indexOf('lon') + 1;
    const latAt = columns.indexOf('lat') + 1;
    const points = ee.FeatureCollection(rows.map((r, n) => ee.Feature(ee.Geometry.Point([r[lonAt] as number, r[latAt] as number]), { idx: n })));
    const outer = buildCoverExtras(ee, region).reduceRegions({ collection: points, reducer: ee.Reducer.first(), scale: COVER_RULES.scaleM, tileScale: 4 });
    const extraRows = (await evaluate<{ list: number[][] }>(outer.reduceColumns({ reducer: ee.Reducer.toList(extraHeader.length + 1), selectors: ['idx', ...extraHeader] }))).list;
    const extraOf = new Map(extraRows.map(([idx, ...rest]) => [idx as number, rest.join(',')]));
    let main_ = '';
    let extra_ = '';
    for (const [n, [pid, ...rest]] of rows.entries()) {
        main_ += [(targets[pid as number] as Parcel).properties.key, ...rest].join(',') + '\n';
        extra_ += (extraOf.get(n) ?? extraHeader.map(() => '').join(',')) + '\n';
    }
    appendFileSync(pixelsPath, main_);
    appendFileSync(extraPath, extra_);
    for (const [n, p] of targets.entries()) console.log(`${p.properties.block}/${p.properties.parcel}: ${rows.filter((r) => r[0] === n).length} piksel eklendi (${Math.round(p.properties.geometryAreaM2)} m²)`);
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
