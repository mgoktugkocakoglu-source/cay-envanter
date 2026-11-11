import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Geometry } from 'geojson';
import type { FieldTestsFile } from '../cli/field-test.ts';

/**
 * The optional `fieldTests` block of the site bundle: blind field tests — a parcel and a known pruning
 * date go in, the satellite delineates the pruned area on its own, and the result is compared with the
 * inspector's ground truth. Produced by `field-test`, separate from the pruning detection chain.
 */
export function loadFieldTestsForBundle(neighborhoodDir: string, roundCoords: (g: Geometry) => Geometry) {
    const path = join(neighborhoodDir, 'field-tests', 'results.json');
    if (!existsSync(path)) return null;
    const file = JSON.parse(readFileSync(path, 'utf8')) as FieldTestsFile;
    return {
        generatedAt: file.generatedAt,
        method: file.method,
        rules: file.rules,
        cases: file.cases.map((c) => ({
            ...c,
            parcelGeometry: roundCoords(c.parcelGeometry),
            pixels: c.pixels.map((p) => ({ ...p, geometry: roundCoords(p.geometry) })),
            groundTruth: c.groundTruth ? { ...c.groundTruth, geometry: roundCoords(c.groundTruth.geometry) } : null,
        })),
    };
}
