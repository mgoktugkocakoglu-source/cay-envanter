// Copies every site bundle (data/site/*.json) and its season imagery into the cayhesabim checkout:
//   bundles  → apps/api/src/tea-inventory/seed-data/<code>.json   (imported on API start when generatedAt changed)
//   imagery  → apps/web/public/inventory-imagery/<code>/           (served as static files)
// Usage: node scripts/sync-site.mjs [--site ../cayhesabim] [--only trabzon-of-tekoba,...]
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { site: { type: 'string', default: join('..', 'cayhesabim') }, only: { type: 'string' } } });
const site = resolve(values.site);
const seedDir = join(site, 'apps', 'api', 'src', 'tea-inventory', 'seed-data');
const imageryDir = join(site, 'apps', 'web', 'public', 'inventory-imagery');
if (!existsSync(seedDir)) throw new Error(`Site seed klasörü yok: ${seedDir}`);
const only = values.only ? new Set(values.only.split(',').map((s) => s.trim())) : null;

const siteData = join(process.cwd(), 'data', 'site');
const bundles = readdirSync(siteData).filter((f) => f.endsWith('.json') && (!only || only.has(f.slice(0, -5))));
for (const file of bundles) {
    const code = file.slice(0, -5);
    const src = join(siteData, file);
    const dst = join(seedDir, file);
    const bundle = JSON.parse(readFileSync(src, 'utf8'));
    const same = existsSync(dst) && JSON.parse(readFileSync(dst, 'utf8')).generatedAt === bundle.generatedAt;
    if (!same) copyFileSync(src, dst);
    const imagerySrc = join(siteData, 'imagery', code);
    let images = 0;
    if (existsSync(imagerySrc)) {
        mkdirSync(imageryDir, { recursive: true });
        cpSync(imagerySrc, join(imageryDir, code), { recursive: true });
        images = readdirSync(imagerySrc, { recursive: true }).filter((f) => /\.(jpe?g|png)$/i.test(String(f))).length;
    }
    console.log(`${same ? '=' : '+'} ${code.padEnd(28)} ${(statSync(src).size / 1e6).toFixed(1)} MB · ${bundle.area.neighborhood} · ${images} görüntü${same ? ' (paket değişmedi)' : ''}`);
}
console.log(`${bundles.length} paket → ${seedDir}`);
