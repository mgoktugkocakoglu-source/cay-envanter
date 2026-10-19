import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FusionSeasonFile } from '../cli/fuse-pruning.ts';

/**
 * The optional `fusion` block of the site bundle: the multi-sensor step-change verdicts per
 * garden and producer for every season the fusion CLI has run. Absent when it has not run.
 */
export function loadFusionForBundle(neighborhoodDir: string) {
    const dir = join(neighborhoodDir, 'pruning-fusion');
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir).filter((n) => /^season-\d{4}-\d{2}\.json$/.test(n)).sort();
    if (files.length === 0) return null;
    const seasons = files.map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')) as FusionSeasonFile);
    return {
        calibrated: false,
        method: 'multi-sensor-step-change',
        rules: seasons[0]!.rules,
        channels: seasons[0]!.channels,
        policy: seasons[0]!.policy,
        seasons: seasons.map((s) => ({
            season: s.season,
            everyDays: s.everyDays,
            scanFrom: s.scanFrom,
            scanTo: s.scanTo,
            sensors: s.sensors,
            parcelCoverage: s.parcelCoverage,
            // Series of free patches are not shipped (no owner to show them to yet); verdicts are.
            unassigned: s.unassigned.map((u) => ({ id: u.id, areaM2: u.areaM2, geometry: u.geometry, verdict: { ...u.verdict, groups: undefined }, detectedAt: u.detectedAt, likelyAt: u.likelyAt })),
            gardens: s.gardens.map((g) => ({
                code: g.id,
                producerCode: g.producerId,
                verdict: g.verdict,
                detectedAt: g.detectedAt,
                likelyAt: g.likelyAt,
                scans: g.scans,
                series: g.series,
            })),
            producers: s.producers.map(({ id, ...rest }) => ({ code: id, ...rest })),
        })),
    };
}
