import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { NeighborhoodStore } from '../library/store.ts';

const USAGE = `
Kullanım:
  npm run pipeline -- --province Trabzon --district Of --neighborhoods "Gürpınar,Bölümlü,Uğurlu"
                      [--seasons 2023,2024,2025] [--health-year 2026] [--harvest-requests 80]
                      [--skip harvest,radar] [--only detect-tea,export-site] [--force]

Bir ya da daha çok mahalle için zincirin tamamını sırayla koşturur:
  harvest → detect-tea → detect-pruning → imagery → scan-producers (sezon sezon) → build-licensing
  → detect-pruning-radar → fuse-pruning → scan-health → export-site
Çıktısı girdisinden yeni olan adımlar atlanır (--force ile yeniden koşar); harvest kaldığı yerden devam eder ve
TKGM günlük kotası dolunca zincir eldeki parsellerle sürer. Her gün aynı komut: kütüphane büyüdükçe yeniden tarar.
Adım adları: harvest, detect-tea, detect-pruning, imagery, scan-producers, build-licensing, radar, fuse, health, export-site
`;

const RETRY_DELAY_S = 60;
/** No stage legitimately runs this long (worst observed: 17 min); a hung Earth Engine socket is killed and retried. */
const STAGE_TIMEOUT_MS = 60 * 60 * 1000;

type StageName = 'harvest' | 'detect-tea' | 'detect-pruning' | 'imagery' | 'scan-producers' | 'build-licensing' | 'radar' | 'fuse' | 'health' | 'export-site';
const STAGE_ORDER: StageName[] = ['harvest', 'detect-tea', 'detect-pruning', 'imagery', 'scan-producers', 'build-licensing', 'radar', 'fuse', 'health', 'export-site'];

interface Step {
    stage: StageName;
    label: string;
    /** Output that must be newer than every input for the step to be skipped. */
    output: string | null;
    inputs: string[];
    run: () => number;
}

const seasonLabel = (year: number) => `${year}-${String(year + 1).slice(2)}`;
const mtime = (path: string) => (existsSync(path) ? statSync(path).mtimeMs : null);

function isFresh(step: Step): boolean {
    if (!step.output) return false;
    const out = mtime(step.output);
    if (out === null) return false;
    const inputs = step.inputs.map(mtime).filter((t): t is number => t !== null);
    return inputs.every((t) => t <= out);
}

function runNode(script: string, args: string[]): number {
    const result = spawnSync(process.execPath, [join('src', 'cli', `${script}.ts`), ...args], { stdio: 'inherit', cwd: process.cwd(), timeout: STAGE_TIMEOUT_MS, killSignal: 'SIGKILL' });
    if (result.error) console.error(`   ! ${result.error.message}`);
    return result.status ?? 1;
}

function runPython(script: string, args: string[]): number {
    const python = process.platform === 'win32' ? join('.venv', 'Scripts', 'python.exe') : join('.venv', 'bin', 'python');
    const result = spawnSync(python, [join('py', script), ...args], { stdio: 'inherit', cwd: process.cwd(), timeout: STAGE_TIMEOUT_MS, killSignal: 'SIGKILL' });
    if (result.error) console.error(`   ! ${result.error.message}`);
    return result.status ?? 1;
}

function buildSteps(store: NeighborhoodStore, base: string[], opts: { seasons: number[]; healthYear: number; harvestRequests: number | null }): Step[] {
    const d = (...parts: string[]) => join(store.dir, ...parts);
    const parcels = d('parcels.ndjson');
    const teaParcels = d('parcels-tea.geojson');
    const teaPatches = d('tea-patches.geojson');
    const registry = d('licensing', 'registry.json');
    const seasonArgs = ['--seasons', opts.seasons.join(',')];
    const steps: Step[] = [];

    steps.push({
        stage: 'harvest',
        label: 'TKGM parsel kütüphanesi',
        output: null,
        inputs: [],
        run: () => {
            const summary = d('summary.json');
            if (existsSync(summary) && (JSON.parse(readFileSync(summary, 'utf8')) as { outcome?: string }).outcome === 'complete') {
                console.log('  kapsama tam, atlandı');
                return 0;
            }
            return runNode('harvest', [...base, ...(opts.harvestRequests ? ['--max-requests', String(opts.harvestRequests)] : [])]);
        },
    });
    steps.push({ stage: 'detect-tea', label: 'Uydudan çay tespiti', output: d('tea-report.json'), inputs: [parcels], run: () => runNode('detect-tea', base) });
    steps.push({
        stage: 'detect-pruning',
        label: 'Parsel bazlı sezon karşılaştırması',
        output: d('pruning', 'summary.json'),
        inputs: [teaPatches],
        run: () => {
            // The parcel-level comparison needs parcels; a boundary-only library (harvest not started) skips it.
            if (!store.loadParcels().some((p) => p.properties.inTargetNeighborhood)) {
                console.log('  kütüphanede parsel yok, atlandı');
                return 0;
            }
            return runNode('detect-pruning', [...base, ...seasonArgs]);
        },
    });
    steps.push({
        stage: 'imagery',
        label: 'Sezon görüntüleri',
        output: d('pruning', 'imagery', 'index.json'),
        inputs: [teaPatches],
        run: () => runPython('season_imagery.py', ['--dir', store.dir, ...seasonArgs]),
    });
    steps.push({
        stage: 'imagery',
        label: 'Sahne zaman çizelgesi',
        output: d('pruning', 'imagery', 'scenes', 'index.json'),
        inputs: [teaPatches],
        run: () => runPython('season_imagery.py', ['--dir', store.dir, ...seasonArgs, '--all-scenes']),
    });
    for (const year of opts.seasons) {
        steps.push({
            stage: 'scan-producers',
            label: `Optik tarama ${seasonLabel(year)}`,
            output: d('producers', `season-${seasonLabel(year)}.json`),
            inputs: [teaParcels, teaPatches],
            run: () => runNode('scan-producers', [...base, '--season', String(year), '--every', '5']),
        });
    }
    const lastSeason = opts.seasons.at(-1) as number;
    steps.push({
        stage: 'build-licensing',
        label: 'Demo ruhsat kaydı',
        output: registry,
        inputs: [teaParcels, d('producers', `season-${seasonLabel(lastSeason)}.json`)],
        run: () => runNode('build-licensing', base),
    });
    for (const year of opts.seasons) {
        steps.push({
            stage: 'radar',
            label: `Radar teyidi ${seasonLabel(year)}`,
            output: d('pruning-radar', `season-${seasonLabel(year)}.json`),
            inputs: [d('producers', `season-${seasonLabel(year)}.json`), registry],
            run: () => runNode('detect-pruning-radar', [...base, '--season', String(year)]),
        });
    }
    for (const year of opts.seasons) {
        steps.push({
            stage: 'fuse',
            label: `Çok-sensör karar ${seasonLabel(year)}`,
            output: d('pruning-fusion', `season-${seasonLabel(year)}.json`),
            inputs: [registry, teaPatches, d('pruning-radar', `season-${seasonLabel(year)}.json`)],
            run: () => runNode('fuse-pruning', [...base, '--season', String(year), '--every', '2']),
        });
    }
    steps.push({
        stage: 'health',
        label: `Bahçe sağlığı ${opts.healthYear}`,
        output: d('health', `season-${opts.healthYear}.json`),
        inputs: [registry, teaPatches],
        run: () => runNode('scan-health', [...base, '--year', String(opts.healthYear)]),
    });
    steps.push({ stage: 'export-site', label: 'Site paketi', output: null, inputs: [], run: () => runNode('export-site', base) });
    return steps;
}

function main(): void {
    const { values } = parseArgs({
        options: {
            province: { type: 'string' },
            district: { type: 'string' },
            neighborhoods: { type: 'string' },
            seasons: { type: 'string', default: '2023,2024,2025' },
            'health-year': { type: 'string', default: String(new Date().getFullYear()) },
            'harvest-requests': { type: 'string' },
            skip: { type: 'string', default: '' },
            only: { type: 'string', default: '' },
            force: { type: 'boolean', default: false },
        },
    });
    if (!values.province || !values.district || !values.neighborhoods) {
        console.log(USAGE);
        process.exit(1);
    }
    const parseStages = (s: string): Set<StageName> => {
        const names = s.split(',').map((n) => n.trim()).filter(Boolean);
        for (const n of names) if (!STAGE_ORDER.includes(n as StageName)) throw new Error(`Bilinmeyen adım: ${n}`);
        return new Set(names as StageName[]);
    };
    const skip = parseStages(values.skip);
    const only = parseStages(values.only);
    const opts = {
        seasons: values.seasons.split(',').map((y) => Number(y.trim())).filter((y) => Number.isFinite(y)),
        healthYear: Number(values['health-year']),
        harvestRequests: values['harvest-requests'] ? Number(values['harvest-requests']) : null,
    };
    const neighborhoods = values.neighborhoods.split(',').map((n) => n.trim()).filter(Boolean);
    const report: Array<{ neighborhood: string; ran: number; skipped: number; failed: string | null; seconds: number }> = [];

    for (const neighborhood of neighborhoods) {
        const startedAt = Date.now();
        const base = ['--province', values.province, '--district', values.district, '--neighborhood', neighborhood];
        const store = new NeighborhoodStore(values.province, values.district, neighborhood);
        console.log(`\n████ ${values.province} / ${values.district} / ${neighborhood} → ${store.dir}`);
        let ran = 0;
        let skipped = 0;
        let failed: string | null = null;
        for (const step of buildSteps(store, base, opts)) {
            if (skip.has(step.stage) || (only.size > 0 && !only.has(step.stage))) {
                skipped++;
                continue;
            }
            if (!values.force && isFresh(step)) {
                console.log(`── ${step.label}: güncel, atlandı`);
                skipped++;
                continue;
            }
            console.log(`\n── ${step.label} (${new Date().toLocaleTimeString('tr-TR')})`);
            const t0 = Date.now();
            let status = step.run();
            if (status !== 0) {
                // Earth Engine / network hiccups (ETIMEDOUT, 5xx) are common on long runs: one retry after a pause.
                console.log(`   ↻ ${step.label} başarısız oldu; ${RETRY_DELAY_S} sn sonra bir kez daha deneniyor`);
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_DELAY_S * 1000);
                status = step.run();
            }
            const seconds = Math.round((Date.now() - t0) / 1000);
            if (status !== 0) {
                console.error(`   ✗ ${step.label} başarısız (çıkış ${status}, ${seconds} sn); bu mahallede zincir durdu.`);
                failed = step.label;
                break;
            }
            console.log(`   ✓ ${step.label} (${seconds} sn)`);
            ran++;
        }
        report.push({ neighborhood, ran, skipped, failed, seconds: Math.round((Date.now() - startedAt) / 1000) });
    }

    console.log('\n════ Özet');
    for (const r of report) {
        console.log(`${r.failed ? '✗' : '✓'} ${r.neighborhood.padEnd(16)} koşan ${r.ran}, atlanan ${r.skipped}, ${Math.round(r.seconds / 60)} dk${r.failed ? ` — ${r.failed} başarısız` : ''}`);
    }
    if (report.some((r) => r.failed)) process.exit(1);
}

main();
