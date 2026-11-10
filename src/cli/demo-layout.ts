import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { NeighborhoodStore } from '../library/store.ts';
import { DECISION_POLICY } from '../fusion/policy.ts';
import type { FusionSeasonFile } from './fuse-pruning.ts';
import type { DemoLayout } from '../producers/demo-producers.ts';

const USAGE = `
Kullanım:
  npm run demo-layout -- --province Trabzon --district Of --neighborhood Çataldere --season 2025 [--ratio 7] [--dry-run]

DEMO müstahsil düzenini (producers/demo-layout.json) uydunun GERÇEKTEN budanmış gördüğü bahçelere göre kurar:
her kesin/olası budama birimi kendi müstahsilini alır ve ona, toplam ruhsatlı alanı 1/<oran> hedefini karşılayacak
ama "aşırı budama" (hedefin 3 katı) sınırını aşmayacak kadar budanmamış komşu bahçe eklenir. Bahçe sınırları,
uydu serileri ve kararlar değişmez; yalnız demo müstahsil ↔ bahçe eşleşmesi ve ruhsat alanı değişir.
Sonra: npm run build-licensing → npm run fuse-pruning (önbellekten) → export-site.
`;

type Poly = Polygon | MultiPolygon;

function main(): void {
    const { values } = parseArgs({
        options: {
            province: { type: 'string' },
            district: { type: 'string' },
            neighborhood: { type: 'string' },
            season: { type: 'string', default: '2025' },
            ratio: { type: 'string', default: String(DECISION_POLICY.cycleSeasons) },
            'dry-run': { type: 'boolean', default: false },
            help: { type: 'boolean', default: false },
        },
    });
    if (values.help || !values.province || !values.district || !values.neighborhood) {
        console.log(USAGE);
        process.exit(values.help ? 0 : 1);
    }
    const store = new NeighborhoodStore(values.province, values.district, values.neighborhood);
    const year = Number(values.season);
    const season = `${year}-${String(year + 1).slice(2)}`;
    const ratio = Math.max(2, Number(values.ratio) || 7);
    const seasonPath = join(store.dir, 'pruning-fusion', `season-${season}.json`);
    if (!existsSync(seasonPath)) throw new Error(`${seasonPath} yok; önce fuse-pruning çalıştırın.`);
    const fusion = JSON.parse(readFileSync(seasonPath, 'utf8')) as FusionSeasonFile;
    const parcels = JSON.parse(readFileSync(join(store.dir, 'parcels-tea.geojson'), 'utf8')) as FeatureCollection<Poly, { key: string; locality?: string }>;
    const localityOf = new Map(parcels.features.map((f) => [f.properties.key, f.properties.locality ?? '']));

    // Anchors: units the model itself called pruned or likely (never anything weaker).
    const anchors = fusion.gardens.filter((g) => g.verdict.class === 'pruned' || (DECISION_POLICY.likelyCounts && g.verdict.class === 'likely'));
    // Companions: well-observed gardens with no pruning signal this season.
    const used = new Set<string>(anchors.map((g) => g.id));
    const candidates = fusion.gardens.filter((g) => g.verdict.class === 'not_pruned' && !used.has(g.id));
    const overMax = DECISION_POLICY.overPrunedRatio; // pruned area must stay below this multiple of the target

    const groups: DemoLayout['groups'] = [];
    for (const a of anchors.sort((x, y) => (y.verdict.z ?? 0) - (x.verdict.z ?? 0))) {
        // Counted area (after the cycle's repeat deduction) must reach the 1/ratio target; the FULL unit area
        // must stay under the over-pruning bar (overMax × target). Licences under ~1 000 m² are rounded up by
        // the register for multi-garden holders, so the group is kept above that where the window allows.
        const full = a.unitAreaM2;
        const cut = full - (a.repeat?.reusedM2 ?? 0);
        const licenceFloor = cut * ratio * 0.85 >= 1050 ? 1050 : 0;
        const minTotal = Math.max((full * ratio) / overMax / 0.85, licenceFloor);
        const maxTotal = cut > 0 ? Math.max(cut * ratio * 0.85, minTotal) : full * ratio * 0.85;
        if (maxTotal < a.areaM2) {
            groups.push({ gardenIds: [a.id], anchor: a.id, reason: `tek bahçe (birim ${Math.round(full)} m², sayılan ${Math.round(cut)} m², bahçe ${Math.round(a.areaM2)} m²)` });
            continue;
        }
        const own = [a.id];
        const parcelsUsed = new Set([a.parcelKey]);
        let total = a.areaM2;
        const target = (minTotal + maxTotal) / 2;
        const loc = localityOf.get(a.parcelKey) ?? '';
        // Prefer same-locality companions, then anything; never two gardens of one parcel; at most 5 companions.
        const ordered = [...candidates].sort((x, y) => Number((localityOf.get(y.parcelKey) ?? '') === loc) - Number((localityOf.get(x.parcelKey) ?? '') === loc) || x.areaM2 - y.areaM2);
        for (const c of ordered) {
            if (total >= minTotal && Math.abs(total - target) <= Math.abs(total + c.areaM2 - target)) break;
            if (own.length >= 6 || used.has(c.id) || parcelsUsed.has(c.parcelKey) || total + c.areaM2 > maxTotal) continue;
            own.push(c.id);
            used.add(c.id);
            parcelsUsed.add(c.parcelKey);
            total += c.areaM2;
            if (total >= target) break;
        }
        const status = cut < total / ratio ? 'tekrar budama düşümü: hedef dolmaz (beklemede)' : total >= minTotal && total <= maxTotal ? 'hedef aralığında' : total < minTotal ? 'aşırı budama sınırında (yeterli komşu yok)' : 'hedef üstünde';
        groups.push({ gardenIds: own, anchor: a.id, reason: `${a.verdict.class}, birim ${Math.round(cut)} m², toplam ${Math.round(total)} m² (hedef ${Math.round(total / ratio)} m²) · ${status}` });
    }

    const layout: DemoLayout = {
        generatedAt: new Date().toISOString(),
        season,
        note: `DEMO düzen: ${season} sezonunda uydunun budanmış/olası gördüğü ${anchors.length} birim, 1/${ratio} hedefini karşılayan müstahsillere dağıtıldı. Kararlar değişmedi.`,
        groups,
    };
    for (const g of groups) console.log(`${g.anchor}: ${g.gardenIds.length} bahçe · ${g.reason}`);
    const outPath = join(store.dir, 'producers', 'demo-layout.json');
    if (values['dry-run']) {
        console.log(`(deneme) yazılmadı: ${outPath}`);
        return;
    }
    writeFileSync(outPath, JSON.stringify(layout, null, 2));
    console.log(`Çıktı: ${outPath} (${groups.length} vitrin müstahsili)`);
}

main();
