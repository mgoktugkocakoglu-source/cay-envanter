/*
 * Measures the combined verdict (combine-pruning) from the two modules' validation runs, without re-running them:
 *   - false alarms: the combined classes on the mirrored runs of both modules (fuse-pruning --mirror --tag fv-mirror,
 *     scan-pixels --mirror --tag cv-mirror);
 *   - detection: the combined classes on the shared simulated cuts stored by scripts/fusion-validate.mjs.
 * Writes pruning-combined/validation-<season>.json (embedded in the season file by the next combine-pruning run).
 *
 *   node scripts/combined-validate.mjs --province Trabzon --district Of --neighborhood Çataldere --season 2025
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { addDays, PixelTimeline } from '../src/pruning/pixel-timeline.ts';

const { values } = parseArgs({ options: { province: { type: 'string' }, district: { type: 'string' }, neighborhood: { type: 'string' }, season: { type: 'string', default: '2025' } } });
const slug = (s) => s.toLocaleLowerCase('tr-TR').replaceAll('ç', 'c').replaceAll('ğ', 'g').replaceAll('ı', 'i').replaceAll('ö', 'o').replaceAll('ş', 's').replaceAll('ü', 'u').replace(/[^a-z0-9]+/g, '-');
const year = Number(values.season);
const season = `${year}-${String(year + 1).slice(2)}`;
const root = join('data', 'library', slug(values.province), slug(values.district), slug(values.neighborhood));
const read = (...p) => JSON.parse(readFileSync(join(root, ...p), 'utf8'));
const SAME_EVENT_DAYS = 45;
const gap = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;

/** The combine-pruning rule on the bare facts: fusion positive + change date, pixel verdict + bracket. */
function classify(fusionPositive, fusionDate, pixelVerdict, pixelDate, pixelLastBefore) {
    const pPos = (pixelVerdict === 'deep' || pixelVerdict === 'light' || pixelVerdict === 'pending') && !!pixelDate;
    if (fusionPositive && pPos) {
        const same = !!fusionDate && Math.min(gap(pixelDate, fusionDate), gap(pixelLastBefore ?? pixelDate, fusionDate)) <= SAME_EVENT_DAYS;
        return same ? 'confirmed' : 'probable';
    }
    if (fusionPositive) return 'probable';
    if (pPos) return pixelVerdict === 'light' ? 'light' : 'probable';
    return 'none';
}

// Seasonal pattern (combine-pruning): a would-be "probable" whose step repeats a year earlier on the same pixels.
const timeline = new PixelTimeline(join(root, 'pruning-pixels'), { repeatShare: 0.6 });
const repeats = (id, cells, before, date, opts) => {
    if (!date) return false;
    const pix = cells?.length ? timeline.indexes(cells) : timeline.gardenPix(id);
    if (!pix.length) return false;
    return timeline.repeatsPrev(pix, cells?.length ? timeline.refFor(id, pix) : null, before ?? addDays(date, -15), date, opts).repeat === true;
};
const pixelCounted = (v) => v === 'deep' || v === 'light' || v === 'pending';

// ── False alarms on the mirrored runs ──
const fusionMirror = read('pruning-fusion', `validation-${season}-fv-mirror.json`);
const pixelMirror = read('pruning-pixels', `validation-${season}-cv-mirror.json`);
const fById = new Map(fusionMirror.positives.map((p) => [p.id, p]));
const pById = new Map(pixelMirror.positives.map((p) => [p.id, p]));
const mirrored = { confirmed: 0, probable: 0, light: 0, seasonal: 0 };
for (const id of new Set([...fById.keys(), ...pById.keys()])) {
    const f = fById.get(id);
    const p = pById.get(id);
    let c = classify(!!f, f?.changeDate ?? null, p?.verdict ?? 'none', p?.date ?? null, p?.lastBefore ?? null);
    if (c === 'probable') {
        const cluster = p && pixelCounted(p.verdict) && p.date && p.cells?.length ? p.cells : null;
        const hit = cluster ? repeats(id, cluster, p.lastBefore, p.date, { sign: -1 }) : repeats(id, null, null, f?.changeDate ?? null, { sign: -1 });
        if (hit) c = 'seasonal';
    }
    if (c !== 'none') mirrored[c]++;
}

// ── Detection on the shared simulated cuts ──
const shared = read('pruning-fusion', `validation-${season}.json`);
// The simulated cut is replayed onto the real series, so the repeat test sees what the detector saw.
const withSeasonal = (t, c, fusionDate) => {
    if (c !== 'probable') return c;
    const injection = { pix: new Set(timeline.indexes(t.cutCells ?? [])), depth: t.depth, kind: t.kind, at: t.at, until: `${year + 1}-07-16` };
    const cluster = pixelCounted(t.pixel.verdict) && t.pixel.date && t.clusterCells?.length ? t.clusterCells : null;
    const hit = cluster ? repeats(t.garden, cluster, t.pixel.lastBefore, t.pixel.date, { injection }) : repeats(t.garden, null, null, fusionDate, { injection });
    return hit ? 'seasonal' : c;
};
const trials = shared.trials.map((t) => ({
    ...t,
    // Fusion bounds: the garden mean alone (no change patch drawn) and the ideal change patch.
    low: withSeasonal(t, classify(t.mean.counted, t.mean.changeDate, t.pixel.verdict, t.pixel.date, t.pixel.lastBefore), t.mean.changeDate),
    high: withSeasonal(t, classify(t.patch.counted, t.patch.changeDate, t.pixel.verdict, t.pixel.date, t.pixel.lastBefore), t.patch.changeDate),
}));
const rate = (filter, hit) => {
    const x = trials.filter(filter);
    const h = x.filter(hit).length;
    return { hit: h, n: x.length, rate: x.length ? Math.round((h / x.length) * 100) / 100 : null };
};
const row = (key, hit) => ({ key, overall: rate(() => true, hit), deep: rate((t) => t.kind === 'deep', hit), light: rate((t) => t.kind === 'light', hit), clear: rate((t) => t.pixels >= 3 && t.depth >= 0.15, hit) });
const counted = (c) => c === 'confirmed' || c === 'probable';
const out = {
    season,
    generatedAt: new Date().toISOString(),
    gardens: fusionMirror.gardens,
    falseAlarms: {
        ...mirrored,
        note: 'Ayna testi: iki modül de çevrilmiş serilerde çalıştırıldı ve birleşik kural çıktılarına uygulandı; bulunan her sınıf yanlış alarmdır (üst sınır).',
    },
    detection: {
        trials: trials.length,
        note: 'İki modüle verilen sentetik kesimlerin aynısı. Alt sınır: çok-sensör yalnız bahçe ortalamasını gördü; üst sınır: kesim yaması tam çizildi. “Sayılan” = kesin ya da muhtemel (1/7 hesabına giren); hafif sınıf ayrıca verilir.',
        rows: [
            row('confirmed_low', (t) => t.low === 'confirmed'),
            row('confirmed_high', (t) => t.high === 'confirmed'),
            row('counted_low', (t) => counted(t.low)),
            row('counted_high', (t) => counted(t.high)),
            row('light', (t) => t.high === 'light'),
            row('seasonal', (t) => t.high === 'seasonal'),
            row('any', (t) => t.high !== 'none'),
        ],
    },
};
mkdirSync(join(root, 'pruning-combined'), { recursive: true });
writeFileSync(join(root, 'pruning-combined', `validation-${season}.json`), JSON.stringify(out));
console.log(`Yanlış alarm (ayna): kesin ${mirrored.confirmed} · muhtemel ${mirrored.probable} · hafif ${mirrored.light} · mevsimsel desene ayrılan ${mirrored.seasonal} / ${out.gardens} bahçe`);
for (const r of out.detection.rows) console.log(`${r.key}: tümü ${r.overall.hit}/${r.overall.n} · derin ${r.deep.hit}/${r.deep.n} · hafif ${r.light.hit}/${r.light.n} · belirgin ${r.clear.hit}/${r.clear.n}`);
