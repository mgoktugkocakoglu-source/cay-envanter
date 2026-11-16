import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The optional `landCover` block of the site bundle: per parcel the tea reading and the share of each cover class,
 * with the model card (py/cover_classify.py). Absent until the module has run. The band list is not shipped.
 */
export function loadCoverForBundle(neighborhoodDir: string): Record<string, unknown> | null {
    const path = join(neighborhoodDir, 'land-cover', 'cover.json');
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : null;
}
