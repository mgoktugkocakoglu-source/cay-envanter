import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { NeighborhoodStore } from '../library/store.ts';
import { FUSION_RULES, type FusionClass } from '../fusion/model.ts';
import type { FusionSeasonFile } from './fuse-pruning.ts';

const USAGE = `Saha etiketleriyle çok-sensör eşik kalibrasyonu (sitedeki Kalibrasyon sekmesiyle aynı ölçütler).

  npm run calibrate-fusion -- --province Trabzon --district Of --neighborhood Çataldere --season 2025 --labels etiketler.csv [--apply]

  --labels  siteden indirilen CSV (areas/:id/calibration/labels.csv): garden;label;... sütunları
  --apply   pruning-fusion/calibration.json içine önerilen eşikleri "uygulanacak" olarak yazar;
            bir sonraki fuse-pruning koşusu zPruned / zLikely'yi buradan alır ve çıktıyı "kalibre edildi" işaretler.
`;

type LabelValue = 'pruned' | 'partial' | 'not_pruned' | 'unsure';
const MIN_POSITIVES = 15;
const MIN_NEGATIVES = 15;

export interface FusionCalibration {
    season: string;
    labelsFile: string;
    computedAt: string;
    labels: number;
    positives: number;
    negatives: number;
    recall: number | null;
    falseAlarmRate: number | null;
    recallStrict: number | null;
    falseAlarmRateStrict: number | null;
    confusion: Record<string, Record<LabelValue, number>>;
    sweep: Array<{ z: number; recall: number; falseAlarmRate: number; f1: number }>;
    suggested: { zPruned: number; zLikely: number; f1: number } | null;
    previousRules: { zPruned: number; zLikely: number };
    /** When true, fuse-pruning applies `suggested` on its next run and marks the season calibrated. */
    applied: boolean;
}

/** Minimal CSV reader for the site's export (";"-separated, quoted, UTF-8 BOM). */
function readLabelsCsv(path: string): Array<{ garden: string; label: LabelValue; season: string }> {
    const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const parse = (line: string) => line.split(';').map((c) => c.trim().replace(/^"|"$/g, '').replace(/""/g, '"'));
    const header = parse(lines[0]!);
    const idx = (name: string) => header.indexOf(name);
    const gi = idx('garden'), li = idx('label'), si = idx('season');
    if (gi < 0 || li < 0) throw new Error('CSV başlığında garden ve label sütunları gerekli');
    return lines.slice(1).map(parse).map((c) => ({ garden: c[gi]!, label: c[li] as LabelValue, season: si >= 0 ? c[si]! : '' }));
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            province: { type: 'string' },
            district: { type: 'string' },
            neighborhood: { type: 'string' },
            season: { type: 'string', default: '2025' },
            labels: { type: 'string' },
            apply: { type: 'boolean', default: false },
        },
    });
    if (!values.province || !values.district || !values.neighborhood || !values.labels) {
        console.log(USAGE);
        process.exit(1);
    }
    const store = new NeighborhoodStore(values.province, values.district, values.neighborhood);
    const year = Number(values.season);
    const season = `${year}-${String(year + 1).slice(2)}`;
    const seasonPath = join(store.dir, 'pruning-fusion', `season-${season}.json`);
    if (!existsSync(seasonPath)) throw new Error(`${seasonPath} yok; önce fuse-pruning çalıştırın.`);
    const file = JSON.parse(readFileSync(seasonPath, 'utf8')) as FusionSeasonFile;
    const labels = readLabelsCsv(values.labels).filter((l) => !l.season || l.season === season);
    const byGarden = new Map(file.gardens.map((g) => [g.id, g]));

    const classes: FusionClass[] = ['pruned', 'likely', 'unclear', 'not_pruned', 'no_data'];
    const values4: LabelValue[] = ['pruned', 'partial', 'not_pruned', 'unsure'];
    const confusion = Object.fromEntries(classes.map((c) => [c, Object.fromEntries(values4.map((v) => [v, 0])) as Record<LabelValue, number>]));
    const scored: Array<{ truth: boolean; cls: FusionClass; z: number }> = [];
    let missing = 0;
    for (const l of labels) {
        const g = byGarden.get(l.garden);
        if (!g) { missing++; continue; }
        const cls = g.verdict.class;
        confusion[cls]![l.label] = (confusion[cls]![l.label] ?? 0) + 1;
        if (l.label === 'unsure' || cls === 'no_data') continue;
        scored.push({ truth: l.label !== 'not_pruned', cls, z: g.verdict.z ?? 0 });
    }
    const positives = scored.filter((s) => s.truth).length;
    const negatives = scored.length - positives;
    const rate = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : null);
    const policy = (c: FusionClass) => c === 'pruned' || c === 'likely';
    const recall = rate(scored.filter((s) => s.truth && policy(s.cls)).length, positives);
    const far = rate(scored.filter((s) => !s.truth && policy(s.cls)).length, negatives);
    const recallStrict = rate(scored.filter((s) => s.truth && s.cls === 'pruned').length, positives);
    const farStrict = rate(scored.filter((s) => !s.truth && s.cls === 'pruned').length, negatives);
    const sweep: FusionCalibration['sweep'] = [];
    for (let z = 1; z <= 8.0001; z += 0.25) {
        const det = scored.filter((s) => s.z >= z);
        const tp = det.filter((s) => s.truth).length;
        const r = positives ? tp / positives : 0;
        const f = negatives ? (det.length - tp) / negatives : 0;
        const p = det.length ? tp / det.length : 0;
        const f1 = r + p ? (2 * r * p) / (r + p) : 0;
        sweep.push({ z: Math.round(z * 100) / 100, recall: Math.round(r * 1000) / 1000, falseAlarmRate: Math.round(f * 1000) / 1000, f1: Math.round(f1 * 1000) / 1000 });
    }
    const enough = positives >= MIN_POSITIVES && negatives >= MIN_NEGATIVES;
    let suggested: FusionCalibration['suggested'] = null;
    if (enough) {
        const best = sweep.reduce((b, s) => (s.f1 > b.f1 || (s.f1 === b.f1 && s.z > b.z) ? s : b), sweep[0]!);
        const likely = [...sweep].reverse().find((s) => s.recall >= 0.85 && s.z < best.z)?.z ?? Math.max(1.5, best.z - 0.7);
        suggested = { zPruned: best.z, zLikely: Math.round(Math.min(likely, best.z) * 100) / 100, f1: best.f1 };
    }
    const calibration: FusionCalibration = {
        season,
        labelsFile: values.labels,
        computedAt: new Date().toISOString(),
        labels: labels.length,
        positives,
        negatives,
        recall,
        falseAlarmRate: far,
        recallStrict,
        falseAlarmRateStrict: farStrict,
        confusion,
        sweep,
        suggested,
        previousRules: { zPruned: file.rules.zPruned ?? FUSION_RULES.zPruned, zLikely: file.rules.zLikely ?? FUSION_RULES.zLikely },
        applied: values.apply && !!suggested,
    };
    console.log(`Etiket: ${labels.length} (${missing} bahçe dosyada yok) · pozitif ${positives} · negatif ${negatives}`);
    console.log(`Yakalama (politika) ${recall ?? '—'} · yanlış alarm ${far ?? '—'} · yalnız kesin: ${recallStrict ?? '—'} / ${farStrict ?? '—'}`);
    console.table(classes.map((c) => ({ uydu: c, ...confusion[c] })));
    if (suggested) {
        console.log(`Öneri: budandı z ≥ ${suggested.zPruned}, olası z ≥ ${suggested.zLikely} (F1 ${suggested.f1}); mevcut ${calibration.previousRules.zPruned} / ${calibration.previousRules.zLikely}`);
    } else {
        console.log(`Öneri yok: en az ${MIN_POSITIVES} pozitif ve ${MIN_NEGATIVES} negatif etiket gerekli.`);
    }
    const outPath = join(store.dir, 'pruning-fusion', 'calibration.json');
    writeFileSync(outPath, JSON.stringify(calibration, null, 2));
    console.log(`${calibration.applied ? 'UYGULANACAK' : 'yalnız rapor'} → ${outPath}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
