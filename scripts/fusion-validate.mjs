/*
 * Measures the multi-sensor (fusion) module the way scripts/pixel-validate.mjs measures the pixel scan, on the very
 * same simulated cuts, so the two modules can be read side by side:
 *   - false alarms: fuse-pruning on mirrored series (every channel mirrored around its own median);
 *   - detection: each scan-pixels --simulate round is replayed into fuse-pruning (--inject), twice: with the garden
 *     mean alone (no change patch drawn: lower bound) and with an ideal change patch over the cut (upper bound).
 * Writes pruning-fusion/validation-<season>.json (embedded in the season file by the next fuse-pruning run).
 *
 *   node scripts/fusion-validate.mjs --province Trabzon --district Of --neighborhood Çataldere --season 2025 [--rounds 6]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { province: { type: 'string' }, district: { type: 'string' }, neighborhood: { type: 'string' }, season: { type: 'string', default: '2025' }, rounds: { type: 'string', default: '6' } } });
const slug = (s) => s.toLocaleLowerCase('tr-TR').replaceAll('ç', 'c').replaceAll('ğ', 'g').replaceAll('ı', 'i').replaceAll('ö', 'o').replaceAll('ş', 's').replaceAll('ü', 'u').replace(/[^a-z0-9]+/g, '-');
const year = Number(values.season);
const season = `${year}-${String(year + 1).slice(2)}`;
const root = join('data', 'library', slug(values.province), slug(values.district), slug(values.neighborhood));
const where = ['--province', values.province, '--district', values.district, '--neighborhood', values.neighborhood, '--season', values.season];
const run = (script, extra) => execFileSync('node', [script, ...where, ...extra], { encoding: 'utf8', maxBuffer: 1 << 26 });
const readPixel = (tag) => JSON.parse(readFileSync(join(root, 'pruning-pixels', `validation-${season}-${tag}.json`), 'utf8'));
const readFusion = (tag) => JSON.parse(readFileSync(join(root, 'pruning-fusion', `validation-${season}-${tag}.json`), 'utf8'));

run('src/cli/fuse-pruning.ts', ['--mirror', '--tag', 'fv-mirror']);
const mirror = readFusion('fv-mirror');
const real = JSON.parse(readFileSync(join(root, 'pruning-fusion', `season-${season}.json`), 'utf8'));

const trials = [];
for (let seed = 1; seed <= Number(values.rounds); seed++) {
    run('src/cli/scan-pixels.ts', ['--simulate', '40', '--seed', String(seed), '--tag', 'fv-sim']);
    const pixel = readPixel('fv-sim');
    const file = join(root, 'pruning-pixels', `validation-${season}-fv-sim.json`);
    run('src/cli/fuse-pruning.ts', ['--inject', file, '--tag', 'fv-garden']);
    run('src/cli/fuse-pruning.ts', ['--inject', file, '--patch-oracle', '--tag', 'fv-patch']);
    const garden = new Map(readFusion('fv-garden').trials.map((t) => [t.garden, t]));
    const patch = new Map(readFusion('fv-patch').trials.map((t) => [t.garden, t]));
    for (const p of pixel.trials) {
        const g = garden.get(p.garden);
        const o = patch.get(p.garden);
        // A garden the real fusion run already calls pruned / likely cannot show what the simulated cut adds.
        if (!g || !o || g.realClass === 'pruned' || g.realClass === 'likely') continue;
        trials.push({
            seed, garden: p.garden, pixels: p.pixels, depth: p.depth, kind: p.kind, at: p.at, cutM2: p.cutM2, gardenM2: g.gardenM2, share: g.share,
            pixel: { counted: p.detected, full: p.detected && p.dateHit && p.located, areaM2: p.areaM2, verdict: p.verdict, date: p.date ?? null, lastBefore: p.lastBefore ?? null },
            mean: { class: g.class, counted: g.counted, confirmed: g.confirmed, dateHit: g.dateHit, dateErrorDays: g.dateErrorDays, changeDate: g.changeDate },
            patch: { class: o.class, counted: o.counted, confirmed: o.confirmed, dateHit: o.dateHit, dateErrorDays: o.dateErrorDays, unit: o.unit, changeDate: o.changeDate },
        });
    }
    console.log(`tur ${seed}: ${trials.length} kesim`);
}
const sizes = [1, 2, 3, 5, 8];
const depths = [0.06, 0.1, 0.15, 0.25];
const r2 = (x) => Math.round(x * 100) / 100;
const rate = (filter, hit) => {
    const x = trials.filter(filter);
    const h = x.filter(hit).length;
    return { hit: h, n: x.length, rate: x.length ? r2(h / x.length) : null };
};
// "Caught" = the garden is counted as pruned (class pruned / likely for fusion; deep / light for the pixel scan).
const scorers = {
    pixel: (t) => t.pixel.counted,
    pixelFull: (t) => t.pixel.full,
    fusionGarden: (t) => t.mean.counted,
    fusionPatch: (t) => t.patch.counted,
    fusionPatchConfirmed: (t) => t.patch.confirmed,
    fusionPatchDated: (t) => t.patch.counted && t.patch.dateHit,
    either: (t) => t.pixel.counted || t.patch.counted,
};
const shares = { low: (t) => t.share < 0.25, mid: (t) => t.share >= 0.25 && t.share < 0.5, high: (t) => t.share >= 0.5 };
const block = (hit) => ({
    overall: rate(() => true, hit),
    realistic: rate((t) => t.pixels >= 2 && t.depth >= 0.1, hit),
    clear: rate((t) => t.pixels >= 3 && t.depth >= 0.15, hit),
    deep: rate((t) => t.kind === 'deep', hit),
    light: rate((t) => t.kind === 'light', hit),
    bySize: Object.fromEntries(sizes.map((k) => [k, rate((t) => t.pixels === k, hit)])),
    byDepth: Object.fromEntries(depths.map((d) => [d, rate((t) => t.depth === d, hit)])),
    byShare: Object.fromEntries(Object.entries(shares).map(([k, f]) => [k, rate(f, hit)])),
    table: sizes.map((k) => ({ pixels: k, cells: depths.map((d) => rate((t) => t.pixels === k && t.depth === d, hit)) })),
});
const falsePruned = mirror.byClass.pruned ?? 0;
const falseLikely = mirror.byClass.likely ?? 0;
const out = {
    season,
    generatedAt: new Date().toISOString(),
    gardens: mirror.gardens,
    real: { pruned: real.summary.byClass.pruned, likely: real.summary.byClass.likely, unclear: real.summary.byClass.unclear },
    falseAlarms: {
        gardens: falsePruned + falseLikely,
        pruned: falsePruned,
        likely: falseLikely,
        share: Math.round(((falsePruned + falseLikely) / mirror.gardens) * 1000) / 1000,
        unclear: mirror.byClass.unclear ?? 0,
        positives: mirror.positives,
        note: 'Ayna testi: her bahçenin bütün kanalları (optik indeksler, VH, VV, koherans) kendi ortancası etrafında çevrilir; yükselişler düşüşe döner. Bulunan her “budandı / muhtemel” yanlış alarmdır. Geçen yıl budanıp bu yıl toparlanan bahçeler de sayıldığı için üst sınırdır.',
    },
    detection: {
        trials: trials.length,
        note: 'Piksel taramasına verilen sentetik kesimlerin aynısı. “Yalnız bahçe ortalaması”: optik yama taraması kesimi çizmemiş sayılır (alt sınır). “İdeal yama”: 100 m² ve üzeri kesimi yama taraması tam çizmiş sayılır (üst sınır). Radar ve koheransa sinyal eklenmedi; gerçek bir derin kesimde radar desteği gelirse oran biraz yükselir. “Yakalandı” = bahçe budandı ya da muhtemel sınıfına girdi.',
        fusionGarden: block(scorers.fusionGarden),
        fusionPatch: block(scorers.fusionPatch),
        fusionPatchConfirmed: block(scorers.fusionPatchConfirmed),
        fusionPatchDated: block(scorers.fusionPatchDated),
        pixel: block(scorers.pixel),
        pixelFull: block(scorers.pixelFull),
        either: block(scorers.either),
    },
    trials,
};
writeFileSync(join(root, 'pruning-fusion', `validation-${season}.json`), JSON.stringify(out));
const line = (name, b) => `${name}: genel ${b.overall.hit}/${b.overall.n} · ≥2 px & ≥0,10 ${b.realistic.hit}/${b.realistic.n} · ≥3 px & ≥0,15 ${b.clear.hit}/${b.clear.n} · derin ${b.deep.hit}/${b.deep.n} · hafif ${b.light.hit}/${b.light.n} | derinlik ${depths.map((d) => `${d}: ${b.byDepth[d].hit}/${b.byDepth[d].n}`).join(' ')} | pay ${Object.entries(b.byShare).map(([k, v]) => `${k}: ${v.hit}/${v.n}`).join(' ')}`;
console.log(`Yanlış alarm (ayna): budandı ${falsePruned} + muhtemel ${falseLikely} / ${mirror.gardens} bahçe (gerçek çalışmada ${out.real.pruned} + ${out.real.likely})`);
const labels = { fusionGarden: 'Çok-sensör, yalnız bahçe', fusionPatch: 'Çok-sensör, ideal yama', fusionPatchConfirmed: 'Çok-sensör, ideal yama, yalnız kesin', fusionPatchDated: 'Çok-sensör, ideal yama, tarih tutuyor', pixel: 'Piksel taraması', pixelFull: 'Piksel taraması, tarih ve yer tutuyor', either: 'İkisinden biri' };
for (const [k, label] of Object.entries(labels)) console.log(line(label, out.detection[k]));
