import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RadarSeasonFile } from '../cli/detect-pruning-radar.ts';

/**
 * The optional radar block of the site bundle: one entry per season that the radar module
 * (detect-pruning-radar) has run for. Absent when the module has not run — the site then
 * behaves exactly as before.
 */
export function loadRadarForBundle(neighborhoodDir: string) {
    const dir = join(neighborhoodDir, 'pruning-radar');
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir).filter((n) => /^season-\d{4}-\d{2}\.json$/.test(n)).sort();
    if (files.length === 0) return null;
    const seasons = files.map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')) as RadarSeasonFile);
    return {
        demo: false,
        calibrated: false,
        method: 'grassland-mowing-adapted',
        rules: seasons[0]!.rules,
        seasons: seasons.map((s) => ({
            season: s.season,
            window: s.window,
            passes: s.passes,
            series: s.series,
            records: s.records.map((r) => ({ recordId: r.recordId, gardenCode: r.gardenId, radar: r.radar })),
            radarOnly: s.radarOnly.map((r) => ({ gardenCode: r.gardenId, date: r.date, vhDropDb: r.vhDropDb, persistence: r.persistence, z: r.z })),
        })),
    };
}
