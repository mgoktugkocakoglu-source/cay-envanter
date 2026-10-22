import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { HealthSeasonFile } from '../cli/scan-health.ts';

/**
 * The optional `health` block of the site bundle: growing-season vigour, anomaly verdicts
 * (herbicide / chemical suspicion, defoliation, stress) and yield estimates per garden and
 * producer, for every year the scan-health CLI has run. Absent when it has not run.
 */
export function loadHealthForBundle(neighborhoodDir: string) {
    const dir = join(neighborhoodDir, 'health');
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir).filter((n) => /^season-\d{4}\.json$/.test(n)).sort();
    if (files.length === 0) return null;
    const seasons = files.map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')) as HealthSeasonFile);
    return {
        calibrated: false,
        method: 'growing-season-step-and-vigour',
        rules: seasons[0]!.rules,
        seasons: seasons.map((s) => ({
            season: s.season,
            window: s.window,
            sensors: s.sensors,
            neighbourhood: s.neighbourhood,
            gardens: s.gardens.map((g) => ({
                code: g.id,
                producerCode: g.producerId,
                teaAreaM2: g.teaAreaM2,
                licensedAreaM2: g.licensedAreaM2,
                ndviMean: g.ndviMean,
                ndreMean: g.ndreMean,
                nbhdNdviMean: g.nbhdNdviMean,
                vigour: g.vigour,
                prunedShare: g.prunedShare,
                anomaly: g.anomaly,
                yieldKg: g.yieldKg,
                yieldFactors: g.yieldFactors,
                observations: g.observations,
                series: s.series[g.id] ?? null,
            })),
            producers: s.producers.map(({ id, ...rest }) => ({ code: id, ...rest })),
        })),
    };
}
