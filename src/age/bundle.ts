import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgeEvaluationFile } from '../cli/scan-garden-age.ts';

/**
 * The optional `age` block of the site bundle: garden age (Landsat establishment year), renewal events,
 * vigour trend, harvest activity, abandonment and renewal priority per tea parcel, with the area summary.
 */
export function loadAgeForBundle(neighborhoodDir: string) {
    const path = join(neighborhoodDir, 'age', 'evaluation.json');
    if (!existsSync(path)) return null;
    const file = JSON.parse(readFileSync(path, 'utf8')) as AgeEvaluationFile;
    return {
        calibrated: false,
        method: file.method,
        generatedAt: file.generatedAt,
        rules: file.rules,
        sources: file.sources,
        summary: file.summary,
        parcels: file.parcels,
    };
}
