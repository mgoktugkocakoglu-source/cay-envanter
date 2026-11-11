import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Geometry } from 'geojson';
import type { FieldTestsFile } from '../cli/field-test.ts';

/**
 * The optional `fieldTests` block of the site bundle: inspector-recorded ground truth (ada/parsel, the
 * marked spot, dated claims) with the independent satellite step test of each claim. Produced by
 * `field-test`, separate from the pruning detection chain.
 */
export function loadFieldTestsForBundle(neighborhoodDir: string, roundCoords: (g: Geometry) => Geometry) {
    const path = join(neighborhoodDir, 'field-tests', 'results.json');
    if (!existsSync(path)) return null;
    const file = JSON.parse(readFileSync(path, 'utf8')) as FieldTestsFile;
    return {
        generatedAt: file.generatedAt,
        method: file.method,
        rules: file.rules,
        cases: file.cases.map((c) => ({ ...c, parcelGeometry: roundCoords(c.parcelGeometry), spot: { ...c.spot, geometry: roundCoords(c.spot.geometry) } })),
    };
}
