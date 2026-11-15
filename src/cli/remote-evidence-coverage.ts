import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { NeighborhoodStore } from '../library/store.ts';
import type { AuditFile } from './audit-licensing.ts';
import type { DroneVerificationFile } from '../drone/model.ts';

/** Offline inventory only: no detections, no new geometry, no remote calls or confidence upgrades. */
const { values } = parseArgs({ options: { province: { type: 'string' }, district: { type: 'string' }, neighborhood: { type: 'string' } } });
if (!values.province || !values.district || !values.neighborhood) throw new Error('province, district and neighborhood are required');
const store = new NeighborhoodStore(values.province, values.district, values.neighborhood);
const read = <T>(file: string): T | null => existsSync(join(store.dir, file)) ? JSON.parse(readFileSync(join(store.dir, file), 'utf8')) as T : null;
const audit = read<AuditFile>('licence-audit/audit.json');
if (!audit) throw new Error('Existing licence-audit/audit.json is required; no download attempted');
const drone = read<DroneVerificationFile>('drone/verification.json');
const monthly = read<{ years: number[]; months: number[]; parcels: Record<string, Record<string, Array<number | null>>> }>('age/raw-s2.json');
const scenes = read<{ seasons: Record<string, Array<{ date: string; file: string }>> }>('pruning/imagery/scenes/index.json');
const images = [...new Map(Object.values(scenes?.seasons ?? {}).flat().map((s) => [s.date, s])).values()].sort((a, b) => a.date.localeCompare(b.date));
const droneKeys = new Set(drone?.parcels.map((p) => p.key) ?? []);
const parcels = audit.parcels.map((p) => {
    const series = monthly?.parcels[p.key];
    const observations = series ? Object.values(series).flat().filter((v) => v !== null && Number.isFinite(v)).length : 0;
    return { key: p.key, block: p.block, parcel: p.parcel, monthlyObservations: observations, droneReading: droneKeys.has(p.key) };
});
const report = {
    generatedAt: new Date().toISOString(),
    notice: 'Yalnız yerel arşiv kapsamıdır; çay tespiti veya doğruluk oranı değildir. Ön değerlendirme; idari karar değildir. Ruhsat kaydı: ' + audit.licenceSource,
    summary: {
        parcels: parcels.length, monthlyParcels: parcels.filter((p) => p.monthlyObservations > 0).length,
        droneParcels: parcels.filter((p) => p.droneReading).length,
        both: parcels.filter((p) => p.droneReading && p.monthlyObservations > 0).length,
        scenes: images.length, missingSceneFiles: images.filter((s) => !existsSync(join(store.dir, 'pruning', 'imagery', 'scenes', s.file))).map((s) => s.file),
        monthlyYears: monthly?.years ?? [], sceneDates: images.map((s) => s.date),
    },
    droneSources: drone?.sources ?? [],
    analysedVideoSeconds: drone?.capture.shot ?? null,
    parcels,
};
const output = join(store.dir, 'remote-evidence');
mkdirSync(output, { recursive: true });
writeFileSync(join(output, 'coverage.json'), JSON.stringify(report));
console.log(JSON.stringify(report.summary, null, 2));
