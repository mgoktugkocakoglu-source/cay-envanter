/*
 * Measures the pixel scan without ground truth, with the rules as they stand:
 *   - false alarms: the scan on mirrored series (rises turned into drops; nothing that greens up is a pruning);
 *   - detection rate: simulated cuts of known place, date, depth and recovery injected into quiet gardens.
 * Writes pruning-pixels/validation-<season>.json, which the next scan-pixels run embeds in the season file.
 *
 *   node scripts/pixel-validate.mjs --province Trabzon --district Of --neighborhood Çataldere --season 2025 [--rounds 5]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { province: { type: 'string' }, district: { type: 'string' }, neighborhood: { type: 'string' }, season: { type: 'string', default: '2025' }, rounds: { type: 'string', default: '5' }, set: { type: 'string' } } });
const slug = (s) => s.toLocaleLowerCase('tr-TR').replaceAll('ç', 'c').replaceAll('ğ', 'g').replaceAll('ı', 'i').replaceAll('ö', 'o').replaceAll('ş', 's').replaceAll('ü', 'u').replace(/[^a-z0-9]+/g, '-');
const year = Number(values.season);
const season = `${year}-${String(year + 1).slice(2)}`;
const dir = join('data', 'library', slug(values.province), slug(values.district), slug(values.neighborhood), 'pruning-pixels');
const base = ['src/cli/scan-pixels.ts', '--province', values.province, '--district', values.district, '--neighborhood', values.neighborhood, '--season', values.season, ...(values.set ? ['--set', values.set] : [])];
const run = (extra) => execFileSync('node', [...base, ...extra], { encoding: 'utf8', maxBuffer: 1 << 26 });
const read = (tag) => JSON.parse(readFileSync(join(dir, `validation-${season}-${tag}.json`), 'utf8'));

run(['--mirror', '--tag', 'v-mirror']);
const mirror = read('v-mirror');
const falseAlarms = mirror.byVerdict.deep + mirror.byVerdict.light + mirror.byVerdict.pending;
const trials = [];
for (let seed = 1; seed <= Number(values.rounds); seed++) {
    run(['--simulate', '40', '--seed', String(seed), '--tag', 'v-sim']);
    trials.push(...read('v-sim').trials);
}
const ok = (t) => t.detected && t.dateHit && t.located;
const rate = (f) => {
    const x = trials.filter(f);
    return { hit: x.filter(ok).length, n: x.length, rate: x.length ? Math.round((x.filter(ok).length / x.length) * 100) / 100 : null };
};
const sizes = [1, 2, 3, 5, 8];
const depths = [0.06, 0.1, 0.15, 0.25];
const out = {
    season,
    generatedAt: new Date().toISOString(),
    overrides: values.set ?? '',
    gardens: mirror.gardens,
    falseAlarms: { gardens: falseAlarms, share: Math.round((falseAlarms / mirror.gardens) * 1000) / 1000, note: 'Ayna testi: seriler pikselin kendi ortancası etrafında çevrilir (yükselişler düşüşe döner); bulunan her “kesim” yanlış alarmdır. Geçen yıl budanıp bu yıl toparlanan bahçeler de sayıldığı için üst sınırdır.' },
    detection: {
        trials: trials.length,
        note: 'Sentetik test: sessiz bahçelere bilinen yer, tarih, derinlik ve toparlanma biçimiyle kesim eklenir; “yakalandı” = bahçe budama sayıldı, tarih aralığı kesim tarihini içeriyor ve eklenen piksellerin en az yarısı kümede.',
        overall: rate(() => true),
        realistic: rate((t) => t.pixels >= 2 && t.depth >= 0.1),
        clear: rate((t) => t.pixels >= 3 && t.depth >= 0.15),
        deep: rate((t) => t.kind === 'deep'),
        light: rate((t) => t.kind === 'light'),
        bySize: Object.fromEntries(sizes.map((k) => [k, rate((t) => t.pixels === k)])),
        byDepth: Object.fromEntries(depths.map((d) => [d, rate((t) => t.depth === d)])),
        table: sizes.map((k) => ({ pixels: k, cells: depths.map((d) => rate((t) => t.pixels === k && t.depth === d)) })),
        detectedAnyDate: trials.filter((t) => t.detected).length,
        kindCorrect: { hit: trials.filter((t) => ok(t) && t.kindHit).length, n: trials.filter(ok).length },
    },
};
writeFileSync(join(dir, `validation-${season}.json`), JSON.stringify(out));
console.log(`Yanlış alarm (ayna): ${falseAlarms} / ${mirror.gardens} bahçe`);
console.log(`Yakalama: genel ${out.detection.overall.hit}/${out.detection.overall.n} · ≥2 piksel & ≥0,10 ${out.detection.realistic.hit}/${out.detection.realistic.n} · ≥3 piksel & ≥0,15 ${out.detection.clear.hit}/${out.detection.clear.n} · derin ${out.detection.deep.hit}/${out.detection.deep.n} · hafif ${out.detection.light.hit}/${out.detection.light.n}`);
console.log(`Derinliğe göre: ${depths.map((d) => `${d}: ${out.detection.byDepth[d].hit}/${out.detection.byDepth[d].n}`).join(' · ')}`);
console.log(`Piksel sayısına göre: ${sizes.map((k) => `${k}: ${out.detection.bySize[k].hit}/${out.detection.bySize[k].n}`).join(' · ')}`);
